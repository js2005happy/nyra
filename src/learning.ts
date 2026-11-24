// src/learning.ts — O5：记忆/学习的产品化。
//
// 把三条已有的学习来源（对话提炼的候选记忆、运行沉淀的技能草稿、
// agent 声明）收进一个用户可见的学习队列：每人一个空间
// `~/.nyra/learning/<owner>.json`（owner 默认 "default"，登录后按账号 id），
// 提案 → 人工审核（记忆过证据门）→ 发布（记忆进库 / 技能安装 / 声明落盘）
// → 分享给组织。学习永远要人批：没有自动批准；队列里只记标题与来源，
// 不把用户原话全文写进审计与运行事件。
//
// 依赖：memoryProposals（候选记忆队列）、skillDrafts（技能草稿）、
// agentDecl（声明校验与落盘）、memoryGate（证据门）、orgs（分享目标组织）。
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import {
  approveMemoryProposal,
  readMemoryProposals,
} from "./memoryProposals.ts";
import {
  approveDraft,
  findDraft,
  listDrafts,
} from "./skillDrafts.ts";
import {
  parseAgentDeclText,
  saveAgentDecl,
} from "./agentDecl.ts";
import { validateOpts } from "./agentDeclCli.ts";
import { verifyEvidenceQuotes } from "./memoryGate.ts";
import { loadOrgBook } from "./orgs.ts";

export class LearningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningError";
  }
}

export const LEARNING_DIR = "learning";
export const LEARNING_AUDIT_FILE = "learning-audit.jsonl";

export type LearningKind = "memory" | "skill" | "agent";
export type LearningStatus = "pending" | "approved" | "rejected" | "published";

export const LEARNING_KINDS: readonly LearningKind[] = ["memory", "skill", "agent"];
export const LEARNING_STATUSES: readonly LearningStatus[] = ["pending", "approved", "rejected", "published"];

export interface LearningProposal {
  /** `lrn_` + 12 位十六进制。 */
  id: string;
  kind: LearningKind;
  owner: string;
  title: string;
  summary: string;
  /** 来源：会话 id / 运行 id / 文件名。 */
  source: string;
  /** 依据：用户原话引用（记忆）或证据行， publish 前过证据门。 */
  evidence: string[];
  /** 底层引用：记忆候选 id（memp_…）/ 技能草稿名 / agent 声明名。 */
  ref: string;
  /** 按种类放的发布用料：记忆 {content, evidenceSource}；agent {text}；技能为空。 */
  payload: Record<string, unknown>;
  status: LearningStatus;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  /** 发布后的落点：记忆条目 id / 技能安装路径 / 声明文件路径。 */
  published_ref: string | null;
  /** 分享给的组织 id 列表（状态不动，分享只记账）。 */
  shared_to: string[];
  shared_at: string | null;
}

export interface LearningBook {
  version: 1;
  owner: string;
  proposals: LearningProposal[];
}

export function learningDir(home: string): string {
  return join(resolveNyraHome(home), LEARNING_DIR);
}

/** owner 只认账号 id 形（字母数字 _ -，最长 64 字），其余一律回 default。 */
export function normalizeOwner(owner: unknown): string {
  if (typeof owner === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(owner)) return owner;
  return "default";
}

export function learningPath(home: string, owner: string): string {
  return join(learningDir(home), `${normalizeOwner(owner)}.json`);
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

function newLearningId(): string {
  return "lrn_" + randomBytes(6).toString("hex");
}

function isLearningProposal(raw: unknown): raw is LearningProposal {
  if (!raw || typeof raw !== "object") return false;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !/^lrn_[0-9a-f]{12}$/.test(p.id)) return false;
  if (p.kind !== "memory" && p.kind !== "skill" && p.kind !== "agent") return false;
  if (typeof p.title !== "string" || typeof p.summary !== "string") return false;
  if (typeof p.source !== "string" || typeof p.ref !== "string") return false;
  if (!Array.isArray(p.evidence) || typeof p.payload !== "object" || p.payload === null) return false;
  if (p.status !== "pending" && p.status !== "approved" && p.status !== "rejected" && p.status !== "published") return false;
  return true;
}

export function loadLearningBook(home: string, owner: string): LearningBook {
  const who = normalizeOwner(owner);
  const path = learningPath(home, who);
  if (!existsSync(path)) return { version: 1, owner: who, proposals: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new LearningError(`学习队列已损坏，已备份到 ${backup}，请检查后再试`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as LearningBook).proposals)) {
    throw new LearningError("学习队列结构不对（须含 proposals 列表）");
  }
  return { version: 1, owner: who, proposals: (parsed as LearningBook).proposals.filter(isLearningProposal) };
}

function saveLearningBook(home: string, book: LearningBook): void {
  atomicWriteJson(learningPath(home, book.owner), book);
}

export function listLearning(
  home: string,
  owner: string,
  opts?: { status?: LearningStatus; kind?: LearningKind; shared?: boolean },
): LearningProposal[] {
  let items = loadLearningBook(home, owner).proposals;
  if (opts?.status) items = items.filter((p) => p.status === opts.status);
  if (opts?.kind) items = items.filter((p) => p.kind === opts.kind);
  if (opts?.shared) items = items.filter((p) => p.shared_to.length > 0);
  return items;
}

export function getLearning(home: string, owner: string, id: string): LearningProposal | null {
  return loadLearningBook(home, owner).proposals.find((p) => p.id === id) ?? null;
}

// ---- 审计与运行事件（只记 id 与种类，不记标题/正文）-----------------------

export function appendLearningAudit(home: string, entry: Record<string, unknown>): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, LEARNING_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

/** 学习变更单独建一条只记 learning_* 事件的运行（与组织同款做法）。 */
export function recordLearningEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`学习：${type}`, "learning", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

function auditAndEvent(home: string, action: string, proposal: LearningProposal, extra?: Record<string, unknown>): void {
  appendLearningAudit(home, { action, learning_id: proposal.id, kind: proposal.kind, owner: proposal.owner, ...(extra ?? {}) });
  recordLearningEvent(home, action, { learning_id: proposal.id, kind: proposal.kind, ...(extra ?? {}) });
}

// ---- 提案 -----------------------------------------------------------------

export interface ProposeLearningInput {
  kind: LearningKind;
  title: string;
  summary: string;
  source: string;
  evidence?: string[];
  ref: string;
  payload?: Record<string, unknown>;
}

function cleanText(text: string, max: number, label: string): string {
  const t = text.trim();
  if (!t) throw new LearningError(`${label}不能为空`);
  if (t.length > max) throw new LearningError(`${label}太长（最多 ${max} 字）`);
  return t;
}

export function proposeLearning(home: string, owner: string, input: ProposeLearningInput): LearningProposal {
  if (!LEARNING_KINDS.includes(input.kind)) throw new LearningError(`学习种类只认 memory / skill / agent，当前是 ${input.kind}`);
  const title = cleanText(input.title, 100, "标题");
  const summary = cleanText(input.summary, 500, "摘要");
  const source = cleanText(input.source, 200, "来源");
  const ref = cleanText(input.ref, 100, "引用");
  const evidence = (input.evidence ?? []).map((e) => e.trim()).filter(Boolean).slice(0, 10);
  for (const e of evidence) {
    if (e.length > 300) throw new LearningError("依据每条最多 300 字");
  }
  const payload = input.payload ?? {};
  if (input.kind === "memory") {
    if (typeof payload.content !== "string" || payload.content.trim().length < 6) {
      throw new LearningError("记忆提案须带 content（至少 6 字）");
    }
  }
  if (input.kind === "agent") {
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      throw new LearningError("agent 提案须带声明正文 text");
    }
  }
  const book = loadLearningBook(home, owner);
  const proposal: LearningProposal = {
    id: newLearningId(),
    kind: input.kind,
    owner: normalizeOwner(owner),
    title,
    summary,
    source,
    evidence,
    ref,
    payload,
    status: "pending",
    created_at: new Date().toISOString(),
    decided_at: null,
    decision_reason: null,
    published_ref: null,
    shared_to: [],
    shared_at: null,
  };
  book.proposals.push(proposal);
  saveLearningBook(home, book);
  auditAndEvent(home, "learning_proposed", proposal);
  return proposal;
}

// ---- 扫描：把已有的两个队列收进学习队列（不重复收）------------------------

export function scanLearning(home: string, owner: string): { created: LearningProposal[]; skipped: number } {
  const book = loadLearningBook(home, owner);
  const queued = new Set(book.proposals.map((p) => `${p.kind}:${p.ref}`));
  const created: LearningProposal[] = [];
  let skipped = 0;
  for (const cand of readMemoryProposals(home)) {
    if (cand.status !== "pending") { skipped += 1; continue; }
    if (queued.has(`memory:${cand.id}`)) { skipped += 1; continue; }
    created.push(proposeLearning(home, owner, {
      kind: "memory",
      title: cand.subject,
      summary: cand.content.slice(0, 500),
      source: `会话 ${cand.sourceSession}`,
      evidence: cand.evidenceQuotes,
      ref: cand.id,
      payload: { content: cand.content, evidenceSource: cand.evidenceSource },
    }));
    queued.add(`memory:${cand.id}`);
  }
  for (const draft of listDrafts(home)) {
    if (draft.status !== "pending") { skipped += 1; continue; }
    if (queued.has(`skill:${draft.name}`)) { skipped += 1; continue; }
    created.push(proposeLearning(home, owner, {
      kind: "skill",
      title: draft.name,
      summary: `源运行 ${draft.source_run_id} 沉淀的技能草稿（${draft.tool_calls} 次工具调用，质量分 ${draft.quality.score}）`,
      source: `运行 ${draft.source_run_id}`,
      evidence: [],
      ref: draft.name,
      payload: {},
    }));
    queued.add(`skill:${draft.name}`);
  }
  return { created, skipped };
}

// ---- 审核与发布 ------------------------------------------------------------

/** 审核时按种类过门：记忆走证据门逐字对照；技能看草稿还在不在；agent 先解析校验。 */
export function approveLearning(
  home: string,
  owner: string,
  id: string,
): { ok: boolean; proposal: LearningProposal | null; reason?: string; message?: string } {
  const book = loadLearningBook(home, owner);
  const idx = book.proposals.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, reason: "not-found", message: `找不到学习提案 ${id}` };
  const proposal = book.proposals[idx]!;
  if (proposal.status !== "pending") {
    return { ok: false, proposal, reason: "already-decided", message: `学习提案 ${id} 已是 ${proposal.status}，不能再批准` };
  }
  const fail = (reason: string, message: string) => {
    proposal.decision_reason = reason;
    book.proposals[idx] = proposal;
    saveLearningBook(home, book);
    return { ok: false, proposal, reason, message };
  };
  if (proposal.kind === "memory") {
    const source = typeof proposal.payload.evidenceSource === "string" ? proposal.payload.evidenceSource : "";
    const gate = verifyEvidenceQuotes(source, proposal.evidence);
    if (!gate.ok) return fail(gate.reason, `证据门拦下：${gate.reason}（依据须是用户原话逐字引用）`);
  }
  if (proposal.kind === "skill") {
    const draft = findDraft(home, proposal.ref);
    if (!draft) return fail("draft-missing", `技能草稿 ${proposal.ref} 不见了（先 nyra skills drafts 看看）`);
    if (draft.status !== "pending") return fail("draft-decided", `技能草稿 ${proposal.ref} 已是 ${draft.status}，不能再批准`);
  }
  if (proposal.kind === "agent") {
    try {
      parseAgentDeclText(String(proposal.payload.text ?? ""), `${proposal.ref}.yaml`, validateOpts(home));
    } catch (err) {
      return fail("decl-invalid", `声明校验失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  proposal.status = "approved";
  proposal.decided_at = new Date().toISOString();
  proposal.decision_reason = null;
  book.proposals[idx] = proposal;
  saveLearningBook(home, book);
  auditAndEvent(home, "learning_approved", proposal);
  return { ok: true, proposal };
}

export function rejectLearning(
  home: string,
  owner: string,
  id: string,
  reason?: string,
): { ok: boolean; proposal: LearningProposal | null; message?: string } {
  const book = loadLearningBook(home, owner);
  const idx = book.proposals.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, message: `找不到学习提案 ${id}` };
  const proposal = book.proposals[idx]!;
  if (proposal.status !== "pending" && proposal.status !== "approved") {
    return { ok: false, proposal, message: `学习提案 ${id} 已是 ${proposal.status}，不能再拒绝` };
  }
  proposal.status = "rejected";
  proposal.decided_at = new Date().toISOString();
  proposal.decision_reason = (reason ?? "").trim() || "user-rejected";
  book.proposals[idx] = proposal;
  saveLearningBook(home, book);
  auditAndEvent(home, "learning_rejected", proposal);
  return { ok: true, proposal };
}

/** 发布：只有 approved 能发布；记忆进库 / 技能安装 / 声明落盘，底层失败时状态不动。 */
export function publishLearning(
  home: string,
  owner: string,
  id: string,
): { ok: boolean; proposal: LearningProposal | null; reason?: string; message?: string } {
  const book = loadLearningBook(home, owner);
  const idx = book.proposals.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, reason: "not-found", message: `找不到学习提案 ${id}` };
  const proposal = book.proposals[idx]!;
  if (proposal.status !== "approved") {
    return { ok: false, proposal, reason: "not-approved", message: `学习提案 ${id} 还没批准（当前 ${proposal.status}），先 approve 再发布` };
  }
  try {
    let publishedRef: string;
    if (proposal.kind === "memory") {
      const result = approveMemoryProposal(home, proposal.ref, {
        content: typeof proposal.payload.content === "string" ? proposal.payload.content : undefined,
      });
      if (!result.ok || !result.entryId) {
        return { ok: false, proposal, reason: result.reason ?? "memory-publish-failed", message: result.message ?? "记忆进库失败" };
      }
      publishedRef = result.entryId;
    } else if (proposal.kind === "skill") {
      const store = new RunStore(join(resolveNyraHome(home), "runs"));
      const { installedPath } = approveDraft(home, proposal.ref, store);
      publishedRef = installedPath;
    } else {
      const text = String(proposal.payload.text ?? "");
      const decl = parseAgentDeclText(text, `${proposal.ref}.yaml`, validateOpts(home));
      publishedRef = saveAgentDecl(home, decl, text, `${proposal.ref}.yaml`, false);
    }
    proposal.status = "published";
    proposal.published_ref = publishedRef;
    book.proposals[idx] = proposal;
    saveLearningBook(home, book);
    auditAndEvent(home, "learning_published", proposal);
    return { ok: true, proposal };
  } catch (err) {
    return { ok: false, proposal, reason: "publish-failed", message: err instanceof Error ? err.message : String(err) };
  }
}

/** 分享给组织：状态不动，只记 shared_to + shared_at + 审计/事件（组织须存在）。 */
export function shareLearning(
  home: string,
  owner: string,
  id: string,
  orgRef: string,
): { ok: boolean; proposal: LearningProposal | null; message?: string } {
  const book = loadLearningBook(home, owner);
  const idx = book.proposals.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, message: `找不到学习提案 ${id}` };
  const proposal = book.proposals[idx]!;
  if (proposal.status !== "approved" && proposal.status !== "published") {
    return { ok: false, proposal, message: `学习提案 ${id} 还没批准（当前 ${proposal.status}），先 approve 再分享` };
  }
  const orgBook = loadOrgBook(home);
  const org = orgBook.orgs.find((o) => o.id === orgRef) ?? orgBook.orgs.find((o) => o.name === orgRef);
  if (!org) return { ok: false, proposal, message: `没有这个组织：${orgRef}` };
  if (!proposal.shared_to.includes(org.id)) proposal.shared_to.push(org.id);
  proposal.shared_at = new Date().toISOString();
  book.proposals[idx] = proposal;
  saveLearningBook(home, book);
  auditAndEvent(home, "learning_shared", proposal, { org_id: org.id });
  return { ok: true, proposal };
}

/** 从队列里删：只删 pending / rejected 的提案（已批准/已发布的走 reject 或留痕，不静默删）。 */
export function removeLearning(
  home: string,
  owner: string,
  id: string,
): { ok: boolean; proposal: LearningProposal | null; message?: string } {
  const book = loadLearningBook(home, owner);
  const idx = book.proposals.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, proposal: null, message: `找不到学习提案 ${id}` };
  const proposal = book.proposals[idx]!;
  if (proposal.status !== "pending" && proposal.status !== "rejected") {
    return { ok: false, proposal, message: `学习提案 ${id} 已是 ${proposal.status}，不能从队列里删（先 reject 再删，或留着备查）` };
  }
  book.proposals.splice(idx, 1);
  saveLearningBook(home, book);
  appendLearningAudit(home, { action: "learning_removed", learning_id: proposal.id, kind: proposal.kind, owner: proposal.owner });
  return { ok: true, proposal };
}
