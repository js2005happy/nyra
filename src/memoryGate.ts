// src/memoryGate.ts — Kooyu 记忆证据门（防记忆污染）。
//
// 借 Kooyu 两件（只借想法不照抄，见
// ~/workspace/research_notes/nyra-kooyu-20261123.md §4）：
//   ① 证据门——写记忆必须附用户原话出处，代码逐条校验，否则拒绝；
//   ② 结构化记忆条目 + 修订历史（scope/status/revision/sourceRefs）。
// MEMORY.md 双向同步可后做（Kooyu 报告结论同款），本批只做门 + 条目表：
// 模型工具 memory_append 写 MEMORY.md 时过门；结构化条目另存账本，供
// `nyra memory remember/entries/entry/update` 查改。
//
// 门的四条规则（按 Kooyu 原文 + Nyra 现状）：
//   ① 证据逐字——引用须是当前用户消息的逐字原话（`userText.includes(quote)`），
//      转述、编造、拼凑的都拒绝；1–8 条，缺依据直接拒绝。
//   ② 只认主对话 + 当前用户回合——无人值守巡查（automation）与子 agent
//      不能写全局记忆；想记的东西交回主对话。
//   ③ 秘密拦截——sk-…、私钥、Bearer token 一律拒绝写入记忆，拒绝记录里
//      只记命中的种类名，不记匹配到的原文。
//   ④ 拒绝留痕——每次拒绝都记进拒绝账本，不静默跳过。
//
// 本模块不 import tools.ts / agent.ts（工具层调它，不是它调工具层）；
// 脱敏复用 quotaHandoff.ts 的 scrubHandoffText（它只 import config 与
// providers 的类型，不成环）。

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";
import { scrubHandoffText } from "./quotaHandoff.ts";

/** 结构化记忆条目账本（append-only 0600，写失败不抛错、调用方自理）。 */
export const MEMORY_GATE_ENTRIES_FILE = "memory-entries.jsonl";
/** 证据门拒绝记录账本（append-only 0600）。 */
export const MEMORY_GATE_REJECTIONS_FILE = "memory-gate-rejections.jsonl";

/** 引用依据：1–8 条，每条 2–500 字（1 个字的引用太容易误命中，不算依据）。 */
export const EVIDENCE_QUOTES_MIN = 1;
export const EVIDENCE_QUOTES_MAX = 8;
export const EVIDENCE_QUOTE_MIN_CHARS = 2;
export const EVIDENCE_QUOTE_MAX_CHARS = 500;
/** 条目字段上限：主题 120 字、正文 2000 字、单条出处 200 字、最多 20 条出处。 */
export const MEMORY_ENTRY_SUBJECT_MAX_CHARS = 120;
export const MEMORY_ENTRY_CONTENT_MAX_CHARS = 2000;
export const MEMORY_ENTRY_SOURCEREF_MAX_CHARS = 200;
export const MEMORY_ENTRY_SOURCEREFS_MAX = 20;

export type MemoryGateScope = "user" | "project" | "org";
export type MemoryGateStatus = "confirmed" | "proposed" | "deleted";
export type MemoryGateSecretKind = "sk-key" | "private-key" | "bearer-token";

/** 结构化记忆条目（Kooyu 的 memory_entries 表在 Nyra 的对位）。 */
export interface MemoryGateEntry {
  /** `memg_` + 12 位十六进制（与 sidecar 索引的 `mem_` 区分开，别处不要混用）。 */
  id: string;
  scope: MemoryGateScope;
  /** scope=project 时必填（项目 id 或工作目录名）；user 时为 null。 */
  projectId: string | null;
  /** 缺口 49 第二批：scope=org 时必填（组织 id）；其余 scope 为 null。 */
  orgId: string | null;
  subject: string;
  content: string;
  sourceRefs: string[];
  status: MemoryGateStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** 本版依据：当时用户消息的逐字原话（1–8 条）。 */
  evidenceQuotes: string[];
}

/** 一条修订记录 = 条目某一版的完整快照 + 上一版正文（修订历史就靠它查）。 */
export interface MemoryGateRevision extends MemoryGateEntry {
  /** 上一版正文；首版为 null。 */
  prevContent: string | null;
  /** 写这版的是谁：cli（用户终端）或 agent（模型工具路径，暂不走这条）。 */
  actor: string;
}

export interface MemoryGateRejection {
  at: string;
  /** 哪一步被拦：remember / update / memory_append。 */
  action: string;
  /** 机器可读的原因码（如 no-evidence / quote-not-verbatim / secret:sk-key）。 */
  reason: string;
  /** 人读的说明（不含任何密钥原文）。 */
  detail: string;
  subject: string | null;
  scope: string | null;
}

export class MemoryGateError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "MemoryGateError";
    this.reason = reason;
  }
}

const SECRET_PATTERNS: { kind: MemoryGateSecretKind; re: RegExp }[] = [
  { kind: "sk-key", re: /\bsk-[A-Za-z0-9_-]{8,}\b/ },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/ },
];

/** 文本里是否含密钥类内容；返回命中的种类名（不回显匹配到的原文）。 */
export function detectSecretKind(text: string): MemoryGateSecretKind | null {
  if (typeof text !== "string") return null;
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(text)) return kind;
  }
  return null;
}

/**
 * 证据校验（Kooyu 的逐条 `userText.includes(quote)`）：引用须是当前用户
 * 消息的逐字原话。userText 为空（没有当前用户回合）时直接拒绝——没有
 * 对照原文就没法验逐字。
 */
export function verifyEvidenceQuotes(
  userText: string | null | undefined,
  quotes: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof userText !== "string" || !userText.trim()) {
    return { ok: false, reason: "no-user-turn" };
  }
  if (!Array.isArray(quotes) || quotes.length < EVIDENCE_QUOTES_MIN) {
    return { ok: false, reason: "no-evidence" };
  }
  if (quotes.length > EVIDENCE_QUOTES_MAX) {
    return { ok: false, reason: "too-many-quotes" };
  }
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    if (typeof q !== "string" || q.trim().length < EVIDENCE_QUOTE_MIN_CHARS) {
      return { ok: false, reason: `quote-too-short:${i + 1}` };
    }
    if (q.trim().length > EVIDENCE_QUOTE_MAX_CHARS) {
      return { ok: false, reason: `quote-too-long:${i + 1}` };
    }
    if (!userText.includes(q.trim())) {
      return { ok: false, reason: `quote-not-verbatim:${i + 1}` };
    }
  }
  return { ok: true };
}

/** CLI 路径用的引用格式校验：没有当前用户消息可对照，只验条数与长度（用户本人直接提供，不算模型推断）。 */
export function verifyEvidenceQuotesFormat(
  quotes: unknown,
): { ok: true; quotes: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(quotes) || quotes.length < EVIDENCE_QUOTES_MIN) {
    return { ok: false, reason: "no-evidence" };
  }
  if (quotes.length > EVIDENCE_QUOTES_MAX) {
    return { ok: false, reason: "too-many-quotes" };
  }
  const out: string[] = [];
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    if (typeof q !== "string" || q.trim().length < EVIDENCE_QUOTE_MIN_CHARS) {
      return { ok: false, reason: `quote-too-short:${i + 1}` };
    }
    if (q.trim().length > EVIDENCE_QUOTE_MAX_CHARS) {
      return { ok: false, reason: `quote-too-long:${i + 1}` };
    }
    out.push(q.trim());
  }
  return { ok: true, quotes: out };
}

export interface MemoryGateEntryInput {
  scope?: MemoryGateScope;
  projectId?: string | null;
  /** scope=org 时必填（组织 id）。 */
  orgId?: string | null;
  subject: string;
  content: string;
  sourceRefs?: string[];
  status?: MemoryGateStatus;
  evidenceQuotes: unknown;
}

interface NormalizedEntryInput {
  scope: MemoryGateScope;
  projectId: string | null;
  orgId: string | null;
  subject: string;
  content: string;
  sourceRefs: string[];
  status: MemoryGateStatus;
  evidenceQuotes: string[];
}

function normalizeEntryInput(
  input: MemoryGateEntryInput,
  opts: { checkVerbatim: boolean; userText?: string | null },
): NormalizedEntryInput {
  const scope = input.scope ?? "user";
  if (scope !== "user" && scope !== "project" && scope !== "org") {
    throw new MemoryGateError("invalid-scope", `scope 只认 user / project / org，当前是 ${JSON.stringify(scope)}`);
  }
  const projectId = scope === "project" ? (typeof input.projectId === "string" ? input.projectId.trim() : "") : null;
  if (scope === "project" && !projectId) {
    throw new MemoryGateError("invalid-project", "scope=project 时须给 projectId");
  }
  const orgId = scope === "org" ? (typeof input.orgId === "string" ? input.orgId.trim() : "") : null;
  if (scope === "org" && !orgId) {
    throw new MemoryGateError("invalid-org", "scope=org 时须给 orgId");
  }
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject) throw new MemoryGateError("empty-subject", "记忆条目须给 subject（主题）");
  if (subject.length > MEMORY_ENTRY_SUBJECT_MAX_CHARS) {
    throw new MemoryGateError("subject-too-long", `subject 最多 ${MEMORY_ENTRY_SUBJECT_MAX_CHARS} 字`);
  }
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) throw new MemoryGateError("empty-content", "记忆条目须给 content（正文）");
  if (content.length > MEMORY_ENTRY_CONTENT_MAX_CHARS) {
    throw new MemoryGateError("content-too-long", `content 最多 ${MEMORY_ENTRY_CONTENT_MAX_CHARS} 字`);
  }
  const rawRefs = input.sourceRefs ?? [];
  if (!Array.isArray(rawRefs)) throw new MemoryGateError("invalid-sourcerefs", "sourceRefs 须是字符串数组");
  if (rawRefs.length > MEMORY_ENTRY_SOURCEREFS_MAX) {
    throw new MemoryGateError("too-many-sourcerefs", `sourceRefs 最多 ${MEMORY_ENTRY_SOURCEREFS_MAX} 条`);
  }
  const sourceRefs: string[] = [];
  for (const r of rawRefs) {
    if (typeof r !== "string" || !r.trim()) throw new MemoryGateError("invalid-sourceref", "sourceRefs 里每条都须是非空字符串");
    if (r.trim().length > MEMORY_ENTRY_SOURCEREF_MAX_CHARS) {
      throw new MemoryGateError("sourceref-too-long", `sourceRefs 单条最多 ${MEMORY_ENTRY_SOURCEREF_MAX_CHARS} 字`);
    }
    sourceRefs.push(r.trim());
  }
  const status = input.status ?? "confirmed";
  if (status !== "confirmed" && status !== "proposed") {
    throw new MemoryGateError("invalid-status", `新建条目 status 只认 confirmed / proposed，当前是 ${JSON.stringify(status)}（deleted 是更新时才能到的状态）`);
  }
  // 证据：模型路径逐字对照当前用户消息；CLI 路径只验格式（用户本人直接提供）。
  let evidenceQuotes: string[];
  if (opts.checkVerbatim) {
    const v = verifyEvidenceQuotes(opts.userText, input.evidenceQuotes);
    if (!v.ok) throw new MemoryGateError(v.reason, evidenceReasonText(v.reason));
    evidenceQuotes = (input.evidenceQuotes as string[]).map((q) => q.trim());
  } else {
    const v = verifyEvidenceQuotesFormat(input.evidenceQuotes);
    if (!v.ok) throw new MemoryGateError(v.reason, evidenceReasonText(v.reason));
    evidenceQuotes = v.quotes;
  }
  // 秘密拦截：正文、主题、引用、出处里任何一处含密钥都拒绝整条（记录里只记种类名）。
  for (const [where, text] of [["content", content], ["subject", subject], ...evidenceQuotes.map((q, i): [string, string] => [`quote:${i + 1}`, q]), ...sourceRefs.map((r, i): [string, string] => [`sourceRef:${i + 1}`, r])] as [string, string][]) {
    const kind = detectSecretKind(text);
    if (kind) throw new MemoryGateError(`secret:${kind}`, `${where} 里含疑似密钥（${secretKindText(kind)}），不能写入记忆`);
  }
  return { scope, projectId, orgId, subject, content, sourceRefs, status, evidenceQuotes };
}

export function evidenceReasonText(reason: string): string {
  if (reason === "no-user-turn") return "没有当前用户回合，无法校验引用依据，不能写记忆";
  if (reason === "no-evidence") return "写记忆须附引用依据（evidenceQuotes，1–8 条当前用户消息的逐字原话），缺依据不能写";
  if (reason === "too-many-quotes") return `引用依据最多 ${EVIDENCE_QUOTES_MAX} 条`;
  if (reason.startsWith("quote-too-short:")) return `第 ${reason.split(":")[1]} 条引用太短（至少 ${EVIDENCE_QUOTE_MIN_CHARS} 字，1 个字的引用太容易误命中）`;
  if (reason.startsWith("quote-too-long:")) return `第 ${reason.split(":")[1]} 条引用太长（最多 ${EVIDENCE_QUOTE_MAX_CHARS} 字）`;
  if (reason.startsWith("quote-not-verbatim:")) return `第 ${reason.split(":")[1]} 条引用不是当前用户消息的逐字原话（转述、编造、拼凑的都不算依据，请逐字摘抄用户原话）`;
  return `引用依据校验未通过（${reason}）`;
}

function secretKindText(kind: MemoryGateSecretKind): string {
  if (kind === "sk-key") return "sk- 开头的密钥";
  if (kind === "private-key") return "私钥";
  return "Bearer token";
}

// ---- 账本读写（append-only jsonl，0600 + fsync；坏行跳过；同 id+revision 不重复追加） ----

function entriesPath(home?: string): string {
  return join(resolveHome(home), MEMORY_GATE_ENTRIES_FILE);
}

function rejectionsPath(home?: string): string {
  return join(resolveHome(home), MEMORY_GATE_REJECTIONS_FILE);
}

function isValidRevision(raw: unknown): raw is MemoryGateRevision {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^memg_[0-9a-f]{12}$/.test(r.id)) return false;
  if (r.scope !== "user" && r.scope !== "project" && r.scope !== "org") return false;
  // 老账本行没有 orgId（undefined 当 null）；有的话须是字符串。
  if (r.orgId !== undefined && r.orgId !== null && typeof r.orgId !== "string") return false;
  if (typeof r.subject !== "string" || typeof r.content !== "string") return false;
  if (!Array.isArray(r.sourceRefs) || !Array.isArray(r.evidenceQuotes)) return false;
  if (r.status !== "confirmed" && r.status !== "proposed" && r.status !== "deleted") return false;
  if (typeof r.revision !== "number" || r.revision < 1) return false;
  return true;
}

function readRevisions(home?: string): MemoryGateRevision[] {
  const path = entriesPath(home);
  if (!existsSync(path)) return [];
  const out: MemoryGateRevision[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as unknown;
      if (isValidRevision(raw)) out.push(raw);
    } catch { /* 坏行跳过，不拖垮读取 */ }
  }
  return out;
}

function appendRevision(home: string | undefined, rev: MemoryGateRevision): MemoryGateRevision | null {
  try {
    const resolved = resolveHome(home);
    const path = join(resolved, MEMORY_GATE_ENTRIES_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return null;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as Partial<MemoryGateRevision>;
          if (raw.id === rev.id && raw.revision === rev.revision) return rev;
        } catch { continue; }
      }
    }
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(rev) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return rev;
  } catch {
    return null;
  }
}

function scrubForStore(text: string, home: string | undefined): string {
  // 落盘前再脱敏一次：home 路径替换 + ≥32 字连续词串掩掉（已脱敏过的文本再跑一次是幂等的）。
  return scrubHandoffText(text, resolveHome(home), text.length);
}

/** 新记一条结构化记忆（首版 revision=1）。userText 是当前用户消息原文，引用逐字对照它校验。 */
export function rememberMemoryEntry(
  home: string | undefined,
  input: MemoryGateEntryInput,
  userText: string | null | undefined,
  opts: { actor?: string; now?: Date; checkVerbatim?: boolean } = {},
): MemoryGateEntry {
  const n = normalizeEntryInput(input, { checkVerbatim: opts.checkVerbatim !== false, userText });
  const now = (opts.now ?? new Date()).toISOString();
  const rev: MemoryGateRevision = {
    id: `memg_${randomBytes(6).toString("hex")}`,
    scope: n.scope,
    projectId: n.projectId,
    orgId: n.orgId,
    subject: scrubForStore(n.subject, home),
    content: scrubForStore(n.content, home),
    sourceRefs: n.sourceRefs.map((r) => scrubForStore(r, home)),
    status: n.status,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    evidenceQuotes: n.evidenceQuotes.map((q) => scrubForStore(q, home)),
    prevContent: null,
    actor: opts.actor ?? "agent",
  };
  const saved = appendRevision(home, rev);
  if (!saved) throw new MemoryGateError("store-failed", "记忆条目落盘失败（账本写不进去），未写入");
  return toEntry(rev);
}

export interface MemoryGateUpdatePatch {
  content?: string;
  subject?: string;
  status?: MemoryGateStatus;
  sourceRefs?: string[];
  /** 改记忆的新依据：模型路径逐字对照当前用户消息；CLI 路径只验格式。 */
  evidenceQuotes?: unknown;
}

/** 改一条记忆（revision+1，上一版正文记进修订行；deleted 是终态，删了的不能再改）。 */
export function updateMemoryEntry(
  home: string | undefined,
  id: string,
  patch: MemoryGateUpdatePatch,
  userText: string | null | undefined,
  opts: { actor?: string; now?: Date; checkVerbatim?: boolean } = {},
): MemoryGateEntry {
  const found = getMemoryGateEntry(home, id);
  if (!found) throw new MemoryGateError("not-found", `找不到记忆条目 ${id}`);
  const cur = found.entry;
  if (cur.status === "deleted") {
    throw new MemoryGateError("already-deleted", `记忆条目 ${id} 已删除（终态），不能再改`);
  }
  const nextContent = patch.content !== undefined ? patch.content.trim() : cur.content;
  const nextSubject = patch.subject !== undefined ? patch.subject.trim() : cur.subject;
  const nextStatus = patch.status ?? cur.status;
  const nextRefs = patch.sourceRefs ?? cur.sourceRefs;
  if (!nextContent) throw new MemoryGateError("empty-content", "改后正文不能为空");
  if (nextContent.length > MEMORY_ENTRY_CONTENT_MAX_CHARS) {
    throw new MemoryGateError("content-too-long", `content 最多 ${MEMORY_ENTRY_CONTENT_MAX_CHARS} 字`);
  }
  if (!nextSubject) throw new MemoryGateError("empty-subject", "改后主题不能为空");
  if (nextSubject.length > MEMORY_ENTRY_SUBJECT_MAX_CHARS) {
    throw new MemoryGateError("subject-too-long", `subject 最多 ${MEMORY_ENTRY_SUBJECT_MAX_CHARS} 字`);
  }
  if (nextStatus !== "confirmed" && nextStatus !== "proposed" && nextStatus !== "deleted") {
    throw new MemoryGateError("invalid-status", `status 只认 confirmed / proposed / deleted，当前是 ${JSON.stringify(nextStatus)}`);
  }
  if (!Array.isArray(nextRefs) || nextRefs.length > MEMORY_ENTRY_SOURCEREFS_MAX) {
    throw new MemoryGateError("invalid-sourcerefs", "sourceRefs 须是字符串数组，最多 20 条");
  }
  for (const r of nextRefs) {
    if (typeof r !== "string" || !r.trim()) throw new MemoryGateError("invalid-sourceref", "sourceRefs 里每条都须是非空字符串");
  }
  // 改记忆同样要附新依据：模型路径逐字对照当前用户消息；CLI 路径只验格式
  // （用户本人直接提供，不算模型推断）。
  // 例外：只删不改（patch 里只有 status: "deleted"）——删除是撤回断言，
  // 不是新断言，不需要新依据，沿用原条目的依据；这样证据本身已坏
  // （如引用为空）的条目也能被免疫体检隔离掉，否则会死锁在“删不掉”。
  const statusOnlyDelete = nextStatus === "deleted"
    && patch.content === undefined && patch.subject === undefined && patch.sourceRefs === undefined;
  let evidenceQuotes: string[];
  if (statusOnlyDelete) {
    evidenceQuotes = cur.evidenceQuotes;
  } else if (opts.checkVerbatim === false) {
    const vf = verifyEvidenceQuotesFormat(patch.evidenceQuotes);
    if (!vf.ok) throw new MemoryGateError(vf.reason, evidenceReasonText(vf.reason));
    evidenceQuotes = vf.quotes;
  } else {
    const v = verifyEvidenceQuotes(userText, patch.evidenceQuotes);
    if (!v.ok) throw new MemoryGateError(v.reason, evidenceReasonText(v.reason));
    evidenceQuotes = (patch.evidenceQuotes as string[]).map((q) => q.trim());
  }
  // 秘密拦截：改后正文、主题、引用、出处里任何一处含密钥都拒绝整版。
  // 只删不改时不拦截——删除不写新断言，旧内容已在账本里，拦删除只会
  // 让含密钥的条目删不掉；隔离路径（immune/dream）靠它清掉脏条目。
  if (!statusOnlyDelete) {
    for (const [where, text] of [["content", nextContent], ["subject", nextSubject], ...evidenceQuotes.map((q, i): [string, string] => [`quote:${i + 1}`, q]), ...nextRefs.map((r, i): [string, string] => [`sourceRef:${i + 1}`, r])] as [string, string][]) {
      const kind = detectSecretKind(text);
      if (kind) throw new MemoryGateError(`secret:${kind}`, `${where} 里含疑似密钥（${secretKindText(kind)}），不能写入记忆`);
    }
  }
  const now = (opts.now ?? new Date()).toISOString();
  const rev: MemoryGateRevision = {
    id: cur.id,
    scope: cur.scope,
    projectId: cur.projectId,
    orgId: cur.orgId ?? null,
    subject: scrubForStore(nextSubject, home),
    content: scrubForStore(nextContent, home),
    sourceRefs: nextRefs.map((r) => scrubForStore(r, home)),
    status: nextStatus,
    revision: cur.revision + 1,
    createdAt: cur.createdAt,
    updatedAt: now,
    evidenceQuotes: evidenceQuotes.map((q) => scrubForStore(q, home)),
    prevContent: cur.content,
    actor: opts.actor ?? "agent",
  };
  const saved = appendRevision(home, rev);
  if (!saved) throw new MemoryGateError("store-failed", "记忆条目落盘失败（账本写不进去），未写入");
  return toEntry(rev);
}

function toEntry(rev: MemoryGateRevision): MemoryGateEntry {
  return {
    id: rev.id,
    scope: rev.scope,
    projectId: rev.projectId,
    orgId: rev.orgId ?? null,
    subject: rev.subject,
    content: rev.content,
    sourceRefs: rev.sourceRefs,
    status: rev.status,
    revision: rev.revision,
    createdAt: rev.createdAt,
    updatedAt: rev.updatedAt,
    evidenceQuotes: rev.evidenceQuotes,
  };
}

/** 列出当前有效的条目（默认不含已删除的；最新 revision 为准）。 */
export function listMemoryGateEntries(
  home?: string,
  opts: { scope?: MemoryGateScope; orgId?: string; status?: MemoryGateStatus; includeDeleted?: boolean; limit?: number } = {},
): MemoryGateEntry[] {
  const latest = new Map<string, MemoryGateRevision>();
  for (const rev of readRevisions(home)) {
    const prev = latest.get(rev.id);
    if (!prev || rev.revision > prev.revision) latest.set(rev.id, rev);
  }
  let out = [...latest.values()].map(toEntry);
  if (!opts.includeDeleted) out = out.filter((e) => e.status !== "deleted");
  if (opts.scope) out = out.filter((e) => e.scope === opts.scope);
  if (opts.orgId !== undefined) out = out.filter((e) => e.orgId === opts.orgId);
  if (opts.status) out = out.filter((e) => e.status === opts.status);
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  if (opts.limit !== undefined) out = out.slice(0, Math.max(0, Math.floor(opts.limit)));
  return out;
}

/** 查一条记忆 + 它的全部修订历史（按 revision 升序；找不到返回 null）。 */
export function getMemoryGateEntry(
  home: string | undefined,
  id: string,
): { entry: MemoryGateEntry; history: MemoryGateRevision[] } | null {
  const history = readRevisions(home)
    .filter((r) => r.id === id)
    .sort((a, b) => a.revision - b.revision);
  if (!history.length) return null;
  return { entry: toEntry(history[history.length - 1]), history };
}

/** 记一条拒绝（写失败不抛错；拒绝记录里不放任何密钥原文与完整待写内容）。 */
export function recordGateRejection(
  home: string | undefined,
  rec: Omit<MemoryGateRejection, "at"> & { at?: string },
): boolean {
  try {
    const resolved = resolveHome(home);
    const path = join(resolved, MEMORY_GATE_REJECTIONS_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const row: MemoryGateRejection = {
      at: rec.at ?? new Date().toISOString(),
      action: rec.action,
      reason: rec.reason,
      detail: rec.detail,
      subject: rec.subject ?? null,
      scope: rec.scope ?? null,
    };
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(row) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 列出最近的拒绝记录（新的在前；同毫秒的按写入顺序倒序；账本不存在或损坏时为空数组）。 */
export function listGateRejections(home?: string, limit = 10): MemoryGateRejection[] {
  const path = rejectionsPath(home);
  if (!existsSync(path)) return [];
  const out: { row: MemoryGateRejection; index: number }[] = [];
  let index = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as unknown;
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.at !== "string" || typeof r.action !== "string" || typeof r.reason !== "string") continue;
      out.push({
        index,
        row: {
          at: r.at,
          action: r.action,
          reason: r.reason,
          detail: typeof r.detail === "string" ? r.detail : "",
          subject: typeof r.subject === "string" ? r.subject : null,
          scope: typeof r.scope === "string" ? r.scope : null,
        },
      });
    } catch { /* 坏行跳过 */ }
    index++;
  }
  // 时间倒序；同毫秒的按写入顺序倒序（后写的在前）。
  out.sort((a, b) => (a.row.at < b.row.at ? 1 : a.row.at > b.row.at ? -1 : b.index - a.index));
  return out.slice(0, Math.max(0, Math.floor(limit))).map((e) => e.row);
}
