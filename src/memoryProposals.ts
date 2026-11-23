// src/memoryProposals.ts — 对话里自动提炼记忆，进库前人确认（G-P1-34）。
//
// 借 Pi memory-extraction 的想法（只借想法不照抄，见相似 agent 缺口报告
// G-P1-34）：模型一次最多提 5 条候选（add/update、scope、category、
// 正文最多 300 字）；组织结果只以“用户确认的提议”落盘。
//
// Nyra 的做法是确定性规则抽取，不调模型、不花 token：只认用户消息里的
// 显式表态（“记住……”“我是……”“我喜欢……”“以后……”这类），其余一律
// 不提。候选先进待确认队列（memory-proposals.json），绝不直接写进
// MEMORY.md 或结构化记忆库；用户在 `nyra memory review` 里逐条确认 /
// 拒绝 / 修改后才进库，进库时过记忆证据门（逐字依据 + 秘密拦截）。
//
// 口径：
//   - 只提主对话：子 agent 与无人值守巡查的会话不提炼（与证据门规则 ②
//     同口径——那两处不能写全局记忆；想记的东西交回主对话）。
//   - scope 只认 user；category 分 about_you / work / how_to（Pi 同款
//     三类，work 由“工作/项目/客户/公司/老板/同事/会议”这些词判定）。
//   - 一次提炼最多 5 条新候选（Pi 同款上限）；单条正文最多 300 字。
//   - 去重：同一规范化正文在队列里已有（无论 pending / confirmed /
//     rejected）或已进结构化记忆库的，不再重复提。
//   - 账本损坏先备份再回空账本，不拦运行；写失败不抛错、调用方自理。
//
// 本模块不 import tools.ts / agent.ts（agent.ts 的 runLoopInner 在对话
// 结束时动态 import 它调 extractMemoryProposals，CLI 动态 import 它调
// review；它调 memoryGate 写库）。

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { loadSession } from "./memory.ts";
import {
  listMemoryGateEntries, MemoryGateError, recordGateRejection, rememberMemoryEntry,
} from "./memoryGate.ts";

/** 待确认候选记忆账本文件名（~/.nyra 下）。 */
export const MEMORY_PROPOSALS_FILE = "memory-proposals.json";

/** 一次提炼最多新增几条候选（Pi memory-extraction 同款上限 5 条）。 */
export const MEMORY_PROPOSAL_MAX_PER_SESSION = 5;
/** 单条候选正文上限（Pi 同款 300 字）。 */
export const MEMORY_PROPOSAL_CONTENT_MAX_CHARS = 300;
/** 候选句子太短不算（“记住。”这种没内容的不提）。 */
export const MEMORY_PROPOSAL_MIN_CHARS = 6;

export type MemoryProposalCategory = "about_you" | "work" | "how_to";
export type MemoryProposalStatus = "pending" | "confirmed" | "rejected";

/** 一条待确认的候选记忆（只以用户确认的提议落盘，之前一律是候选）。 */
export interface MemoryProposal {
  /** `memp_` + 12 位十六进制。 */
  id: string;
  scope: "user";
  category: MemoryProposalCategory;
  subject: string;
  /** 候选正文：用户原话里的一个句子（逐字），最多 300 字。 */
  content: string;
  /** 依据：候选正文所在的那个用户句子的逐字原话（1 条）。 */
  evidenceQuotes: string[];
  /** 进库时逐字校验用的对照原文：完整用户回合（超长时退化为引用句本身）。 */
  evidenceSource: string;
  /** 提炼自哪个会话。 */
  sourceSession: string;
  status: MemoryProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  /** 决定原因：用户拒绝的理由，或进库时证据门拦下的原因码。 */
  decisionReason: string | null;
  /** 确认进库后对应的结构化记忆条目 id（memg_…）；未进库为 null。 */
  entryId: string | null;
}

/** 提炼出的候选草稿（还没进账本，纯函数 extractCandidates 的返回值）。 */
export interface MemoryProposalDraft {
  category: MemoryProposalCategory;
  subject: string;
  content: string;
  evidenceQuotes: string[];
  evidenceSource: string;
}

function proposalsPath(home: string): string {
  return join(resolveHome(home), MEMORY_PROPOSALS_FILE);
}

/** 0600 原子写：写临时文件 + fsync + rename（与 modelHealth.ts 同款）。 */
function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function isValidProposal(raw: unknown): raw is MemoryProposal {
  if (!raw || typeof raw !== "object") return false;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !/^memp_[0-9a-f]{12}$/.test(p.id)) return false;
  if (p.scope !== "user") return false;
  if (p.category !== "about_you" && p.category !== "work" && p.category !== "how_to") return false;
  if (typeof p.subject !== "string" || typeof p.content !== "string") return false;
  if (!Array.isArray(p.evidenceQuotes) || typeof p.evidenceSource !== "string") return false;
  if (typeof p.sourceSession !== "string") return false;
  if (p.status !== "pending" && p.status !== "confirmed" && p.status !== "rejected") return false;
  return true;
}

/** 读待确认队列；账本损坏先备份再回空账本（不拦运行）。 */
export function readMemoryProposals(home?: string): MemoryProposal[] {
  const path = proposalsPath(home ?? "");
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) throw new Error("not an array");
    return data.filter(isValidProposal);
  } catch {
    try {
      const bak = `${path}.bak-${Date.now()}`;
      writeFileSync(bak, raw!, "utf-8");
    } catch { /* 备份失败也不拦读取 */ }
    return [];
  }
}

function writeMemoryProposals(home: string | undefined, list: MemoryProposal[]): void {
  atomicWriteJson(proposalsPath(home ?? ""), list);
}

/** 去重用的规范化正文：去空白与句末标点。 */
export function normalizeProposalContent(content: string): string {
  return content.replace(/\s+/g, "").replace(/[。！？!?,，；;、.]+$/u, "");
}

const WORK_WORDS = /工作|项目|客户|公司|老板|同事|会议|团队/u;

function categorize(sentence: string, base: MemoryProposalCategory): MemoryProposalCategory {
  if (base === "how_to" && WORK_WORDS.test(sentence)) return "work";
  if (base === "about_you" && WORK_WORDS.test(sentence) && /^(我是|我叫|我的)/u.test(sentence)) return "work";
  return base;
}

function makeSubject(content: string): string {
  const stripped = content.replace(/^(请)?记住[，,：:\s]?/u, "").trim();
  const head = (stripped || content).slice(0, 30).replace(/[。！？!?,，；;]+$/u, "");
  return head || content.slice(0, 30);
}

/**
 * 纯函数：从对话记录里抽候选草稿（只看 role=user 的回合，不读盘、不调模型）。
 * 只认显式表态——“记住……”（显式让记）、“我是/我叫/我喜欢/我不喜欢/
 * 我的……是”（身份与偏好）、“以后/今后/下次/每次……”开头的长期指令；
 * 其余一律不提（任务里的临时要求、闲聊、转述都不算记忆）。
 */
export function extractCandidates(messages: readonly Record<string, unknown>[]): MemoryProposalDraft[] {
  const out: MemoryProposalDraft[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const turn = m.content;
    // 按句切（中文句末标点与换行；英文句号不切，免得把 3.5 这类数字切碎）。
    const sentences = turn.split(/(?<=[。！？!?\n；])\s*/u).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length < MEMORY_PROPOSAL_MIN_CHARS) continue;
      let base: MemoryProposalCategory | null = null;
      if (/记住/u.test(sentence)) {
        // “记住”后面没内容的不提（“记住。”“请记住。”这种空指令）。
        const after = sentence.replace(/^.*记住[，,：:\s]?/u, "").trim();
        if (!after) continue;
        base = /我|我的/u.test(sentence) ? "about_you" : "how_to";
      } else if (/^(我是|我叫|我姓|我今年|我来自)/u.test(sentence)) {
        base = "about_you";
      } else if (/我(喜欢|不喜欢|讨厌|偏爱|习惯|爱吃|爱看|爱用)/u.test(sentence)) {
        base = "about_you";
      } else if (/^我的(?!意思是)/u.test(sentence) && /我的.+?(是|叫|在|有)/u.test(sentence)) {
        base = "about_you";
      } else if (/^(以后|今后|下次|每次|一律)/u.test(sentence)) {
        base = "how_to";
      } else if (/(以后|今后|下次)/u.test(sentence) && /(要|请|别|不要|都|就)/u.test(sentence)) {
        base = "how_to";
      }
      if (!base) continue;
      const content = sentence.length > MEMORY_PROPOSAL_CONTENT_MAX_CHARS
        ? sentence.slice(0, MEMORY_PROPOSAL_CONTENT_MAX_CHARS) + "…"
        : sentence;
      const norm = normalizeProposalContent(content);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const evidenceSource = turn.length > 2000 ? sentence : turn;
      out.push({
        category: categorize(sentence, base),
        subject: makeSubject(content),
        content,
        evidenceQuotes: [sentence],
        evidenceSource,
      });
      if (out.length >= MEMORY_PROPOSAL_MAX_PER_SESSION) return out;
    }
  }
  return out;
}

export interface ExtractResult {
  added: number;
  skipped: number;
  total: number;
}

/**
 * 从一个会话的对话记录里提炼候选记忆进待确认队列。messages 不给时读
 * 会话文件；会话不存在返回 0 条。写账本失败不抛错（返回 added 0，
 * 调用方照常跑——提炼失败绝不能破坏对话本身）。
 */
export function extractMemoryProposals(
  home: string | undefined,
  sessionId: string,
  messages?: readonly Record<string, unknown>[],
  opts: { now?: Date } = {},
): ExtractResult {
  let turns = messages;
  if (!turns) {
    try {
      turns = loadSession(sessionId, home) ?? [];
    } catch {
      turns = [];
    }
  }
  const drafts = extractCandidates(turns);
  if (!drafts.length) return { added: 0, skipped: 0, total: readMemoryProposals(home).length };
  const existing = readMemoryProposals(home);
  const known = new Set(existing.map((p) => normalizeProposalContent(p.content)));
  // 已进结构化记忆库的同样不再重复提。
  try {
    for (const e of listMemoryGateEntries(home, { status: "confirmed" })) {
      known.add(normalizeProposalContent(e.content));
    }
  } catch { /* 读库失败只影响去重，不拦提炼 */ }
  const now = (opts.now ?? new Date()).toISOString();
  let added = 0;
  let skipped = 0;
  const next = [...existing];
  for (const d of drafts) {
    if (added >= MEMORY_PROPOSAL_MAX_PER_SESSION) { skipped++; continue; }
    const norm = normalizeProposalContent(d.content);
    if (known.has(norm)) { skipped++; continue; }
    known.add(norm);
    next.push({
      id: `memp_${randomBytes(6).toString("hex")}`,
      scope: "user",
      category: d.category,
      subject: d.subject,
      content: d.content,
      evidenceQuotes: d.evidenceQuotes,
      evidenceSource: d.evidenceSource,
      sourceSession: sessionId,
      status: "pending",
      createdAt: now,
      decidedAt: null,
      decisionReason: null,
      entryId: null,
    });
    added++;
  }
  if (added > 0) {
    try {
      writeMemoryProposals(home, next);
    } catch {
      return { added: 0, skipped: drafts.length, total: existing.length };
    }
  }
  return { added, skipped, total: next.length };
}

/** 列出候选（默认只看待确认的；新的在前）。 */
export function listMemoryProposals(
  home?: string,
  opts: { status?: MemoryProposalStatus; limit?: number } = {},
): MemoryProposal[] {
  let out = readMemoryProposals(home);
  if (opts.status) out = out.filter((p) => p.status === opts.status);
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  if (opts.limit !== undefined) out = out.slice(0, Math.max(0, Math.floor(opts.limit)));
  return out;
}

/** 查一条候选（找不到返回 null）。 */
export function getMemoryProposal(home: string | undefined, id: string): MemoryProposal | null {
  return readMemoryProposals(home).find((p) => p.id === id) ?? null;
}

export interface ApproveResult {
  ok: boolean;
  proposal: MemoryProposal | null;
  /** 进库后的结构化记忆条目 id；被拒时为 null。 */
  entryId: string | null;
  /** 被拒时的原因码（证据门的原因码，如 secret:sk-key）。 */
  reason?: string;
  message?: string;
}

/**
 * 确认一条候选进库：过记忆证据门（逐字依据对照提炼时的用户原话 +
 * 秘密拦截），过了才写结构化记忆库、候选标 confirmed；没过留在队列里
 * （status 仍是 pending，decisionReason 记原因码），拒绝记进拒绝账本。
 * content 可改——改后的正文同样过门（依据仍是原用户原话，改得离谱、
 * 对不上依据的会被逐字校验拦下）。
 */
export function approveMemoryProposal(
  home: string | undefined,
  id: string,
  opts: { content?: string; actor?: string; now?: Date } = {},
): ApproveResult {
  const list = readMemoryProposals(home);
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, entryId: null, reason: "not-found", message: `找不到候选记忆 ${id}` };
  const proposal = list[idx];
  if (proposal.status !== "pending") {
    return { ok: false, proposal, entryId: proposal.entryId, reason: "already-decided", message: `候选记忆 ${id} 已决定过（${proposal.status}），不能再确认` };
  }
  const content = (opts.content ?? proposal.content).trim();
  if (!content) {
    return { ok: false, proposal, entryId: null, reason: "empty-content", message: "确认进库的正文不能为空" };
  }
  const now = (opts.now ?? new Date()).toISOString();
  try {
    const entry = rememberMemoryEntry(home, {
      scope: "user",
      subject: proposal.subject,
      content,
      sourceRefs: [`会话 ${proposal.sourceSession}`],
      status: "confirmed",
      evidenceQuotes: proposal.evidenceQuotes,
    }, proposal.evidenceSource, { actor: opts.actor ?? "cli", checkVerbatim: true });
    proposal.status = "confirmed";
    proposal.content = content;
    proposal.entryId = entry.id;
    proposal.decidedAt = now;
    proposal.decisionReason = null;
    list[idx] = proposal;
    writeMemoryProposals(home, list);
    return { ok: true, proposal, entryId: entry.id };
  } catch (err) {
    if (err instanceof MemoryGateError) {
      proposal.decisionReason = err.reason;
      list[idx] = proposal;
      try { writeMemoryProposals(home, list); } catch { /* ignore */ }
      recordGateRejection(home, {
        action: "proposal_approve",
        reason: err.reason,
        detail: err.message,
        subject: proposal.subject,
        scope: "user",
      });
      return { ok: false, proposal, entryId: null, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

/**
 * 拒绝一条候选：不进库，状态标 rejected + 理由，拒绝记进拒绝账本留痕
 * （用户亲手拒绝的决定也要留痕，不是只记门拦下的）。
 */
export function rejectMemoryProposal(
  home: string | undefined,
  id: string,
  reason?: string,
  opts: { now?: Date } = {},
): { ok: boolean; proposal: MemoryProposal | null; message?: string } {
  const list = readMemoryProposals(home);
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, message: `找不到候选记忆 ${id}` };
  const proposal = list[idx];
  if (proposal.status !== "pending") {
    return { ok: false, proposal, message: `候选记忆 ${id} 已决定过（${proposal.status}），不能再拒绝` };
  }
  proposal.status = "rejected";
  proposal.decidedAt = (opts.now ?? new Date()).toISOString();
  proposal.decisionReason = (reason ?? "").trim() || "user-rejected";
  list[idx] = proposal;
  writeMemoryProposals(home, list);
  recordGateRejection(home, {
    action: "proposal_reject",
    reason: "user-rejected",
    detail: `用户拒绝了候选记忆“${proposal.subject}”${reason ? `（${reason}）` : "（未说明原因）"}`,
    subject: proposal.subject,
    scope: "user",
  });
  return { ok: true, proposal };
}
