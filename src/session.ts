// src/session.ts — 缺口 39：跨 agent 联合会话（扩展缺口 12 + 34 + 27）。
//
// 多人多 agent 视频会的第一批：会话生命周期 + 会内 A2A 任务委派 +
// 共享任务产物（allowlist）+ 画面默认不留存 + 录制全体同意门。
//
// 媒体面（诚实边界）：本批没有真 SFU 服务器、没有原生 WebRTC 栈（见
// 缺口 37 的诚实边界）、不拨真实电话、不声称端到端加密。“SFU 转发”
// 做成本地确定性扇出模型：一方的帧按会话成员表扇出，扇出记录进会话
// 账本与 peer-audit（只记帧指纹与收件人，不记帧内容），文档里写清
// 这是本地模型不是真 SFU。真实多方媒体协商是后续批次的事。
//
// 安全边界（照 Teamly 报告 §4.2 的四道防线）：
// - 准入：只有已批准好友且在信任圈里（缺口 34 的 isAdmitted）才能进
//   会；本机内部 agent（self）与机主（owner）不经过网关准入，照缺口
//   34 的团队规则走参谋长分派；圈外好友加入直接拒绝；
// - 对方 agent 默认只读：对方发来的任何内容（命令、链接、文件）都按
//   不可信输入处理（缺口 12 的 wrapUntrusted），写操作须对方主人显式
//   接受；会内委派的交付走缺口 12 的交接 + 独立审查门；
// - 记忆是每 agent 私有的：共享只限任务产物 + 显式打包的上下文片段
//   （allowlist），整段记忆、会话历史、密钥、任意本地文件一律不共享；
// - 画面默认不留存：共享画面只在会中可见，会后默认不留存（会话结束
//   时清空帧记录）；任何留存/录制须全体在会成员显式同意，缺一不可；
// - 账本 ~/.nyra/sessions.json 原子写 0600，损坏先备份再抛错；
// - 会话事件进证据链（session_*，只记会话 id、成员名与结论，不记
//   任务正文、帧内容与绝对路径）；帧扇出只记指纹与收件人。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { appendPeerAudit, buildHandoffPackage, handoffPeer, peerConfig, renderHandoffPackage, resolvePeer, type HandoffField, type PeerCallDeps } from "./peer.ts";
import { isAdmitted, OWNER_IDENTITY } from "./circles.ts";
import { findFriend, isFriend, loadFriendBook } from "./peerCard.ts";
import { activateContract, createContract, formatContractReport, getContract, markContractItem, scoreContract, verifyContract, type ContractAttempt, type DeliveryContract } from "./contract.ts";
import { loadConfig } from "./config.ts";

export const SESSIONS_FILE = "sessions.json";
export const SESSION_ID_RE = /^ses-[0-9a-f]{8}$/;
export const SESSION_FRAME_HASH_RE = /^[0-9a-f]{12}$/;
export const SESSION_MAX_FRAMES = 100;
export const SESSION_MAX_TITLE_CHARS = 120;
export const SESSION_MAX_TASK_CHARS = 2000;
export const SESSION_MAX_ACCEPTANCE_CHARS = 200;
export const SESSION_MAX_LABEL_CHARS = 200;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export type SessionMemberKind = "owner" | "self" | "friend";
export type SessionStatus = "active" | "ended";
export type DelegationStatus = "delegated" | "accepted" | "completed" | "rejected";
export type DeliveryStatus = "sent" | "pending" | "blocked" | "failed";
export type ShareKind = "product" | "context" | "evidence" | "note";

/** 共享 allowlist：只认这四种；memory / history / secret / file / key
* 一律拒绝（记忆私有是红线，任意本地文件不共享）。 */
export const SESSION_SHARE_KINDS: readonly ShareKind[] = ["product", "context", "evidence", "note"];
export const SESSION_SHARE_DENIED_KINDS: readonly string[] = ["memory", "history", "secret", "file", "key", "path", "password", "token"];

export interface SessionMember {
  identity: string;
  kind: SessionMemberKind;
  joined_at: string;
  left_at: string | null;
}

export interface SessionDelegation {
  id: string;
  from: string;
  to: string;
  task: string;
  acceptance: string[];
  contract_id: string | null;
  status: DelegationStatus;
  delivery: DeliveryStatus;
  delivery_reason: string;
  peer_run_id: string | null;
  created_at: string;
  updated_at: string;
  note: string;
}

export interface SessionShareItem {
  kind: ShareKind;
  label: string;
  /** 共享包来源运行（只记 run_id；包内容存在会话目录的 shared/ 下）。 */
  run_id: string | null;
  /** 共享包文件（相对路径 sessions/<id>/shared/<share>.md），无包时为空。 */
  file: string;
}

export interface SessionShare {
  id: string;
  from: string;
  to: string[];
  items: SessionShareItem[];
  created_at: string;
}

export interface SessionFrame {
  id: string;
  from: string;
  /** 帧指纹（SHA-256 前 12 位）：只记指纹，不记帧内容。 */
  hash: string;
  recipients: string[];
  at: string;
}

export interface SessionJoinRequest {
  id: string;
  identity: string;
  requested_at: string;
  requested_by: string;
  status: "pending" | "approved" | "declined";
  decided_at: string | null;
  decided_by: string | null;
}

export interface JointSession {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
  ended_at: string | null;
  status: SessionStatus;
  members: SessionMember[];
  delegations: SessionDelegation[];
  shares: SessionShare[];
  /** 会中帧扇出记录（只记指纹与收件人）：会话结束时清空，默认不留存。 */
  frames: SessionFrame[];
  /** 录制同意：每位在会成员的显式同意（身份 + 时间）。 */
  recording_consented_by: { identity: string; at: string }[];
  /**
   * 第 2 批 G-P1-5：待批入会请求——好友进群要批：先 request（准入闸预检
   * 不过直接拒绝，连请求都不记），再由机主 approve/decline；批准时重查
   * 准入闸（请求后被拉黑/移出圈的，批准时拦下）。默认只读：进会不等于
   * 能写东西，写操作仍走提议门。
   */
  pending_joins: SessionJoinRequest[];
}

export interface SessionBook {
  version: 1;
  sessions: JointSession[];
}

function sessionsPath(home: string): string {
  return join(resolveNyraHome(home), SESSIONS_FILE);
}

function sessionDir(home: string, id: string): string {
  return join(resolveNyraHome(home), "sessions", id);
}

function ensureHomeDir(home: string): string {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  return dir;
}

function writeJsonAtomic(home: string, filename: string, data: string): void {
  const dir = ensureHomeDir(home);
  const path = join(dir, filename);
  const tmp = join(dir, `.${filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newSessionId(): string {
  return `ses-${randomBytes(4).toString("hex")}`;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** 读会话账本：没有返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadSessionBook(home: string): SessionBook {
  const path = sessionsPath(home);
  if (!existsSync(path)) return { version: 1, sessions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new SessionError(`${SESSIONS_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.sessions)) {
    throw new SessionError(`${SESSIONS_FILE} 结构不对（须含 sessions 列表）`);
  }
  // 第 2 批 G-P1-5：老会话没有 pending_joins 字段，读时补空数组（不改写账本）。
  return { version: 1, sessions: (parsed.sessions as JointSession[]).map((s) => ({ ...s, pending_joins: s.pending_joins ?? [] })) };
}

export function saveSessionBook(home: string, book: SessionBook): void {
  writeJsonAtomic(home, SESSIONS_FILE, JSON.stringify(book, null, 2) + "\n");
}

export function findSession(book: SessionBook, id: string): JointSession | null {
  return book.sessions.find((s) => s.id === id) ?? null;
}

export function listSessions(home: string): JointSession[] {
  return loadSessionBook(home).sessions;
}

/** 会话操作单独建一条只记 session_* 事件的运行（与信任圈同款做法）。 */
function recordSessionEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`联合会话：${type}`, "session", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

function activeMembers(session: JointSession): SessionMember[] {
  return session.members.filter((m) => m.left_at === null);
}

function isActiveMember(session: JointSession, identity: string): boolean {
  return activeMembers(session).some((m) => m.identity === identity);
}

function memberKind(identity: string): SessionMemberKind {
  if (identity === OWNER_IDENTITY) return "owner";
  if (identity === "self") return "self";
  return "friend";
}

/** 录制是否已获全体在会成员同意（新加入的成员须另行同意才算数）。 */
export function recordingAllowed(session: JointSession): boolean {
  const active = activeMembers(session);
  if (!active.length) return false;
  return active.every((m) => session.recording_consented_by.some((c) => c.identity === m.identity));
}

// ---------------------------------------------------------------------------
// 会话生命周期：创建 / 加入 / 离开 / 结束
// ---------------------------------------------------------------------------

/** 建联合会话（机主创建；初始成员只有机主与己方 agent）。 */
export function createSession(home: string, title: string, by?: string): JointSession {
  const who = by ?? OWNER_IDENTITY;
  const clean = title.trim();
  if (!clean) throw new SessionError("会话标题不能为空");
  if (clean.length > SESSION_MAX_TITLE_CHARS) throw new SessionError(`会话标题最多 ${SESSION_MAX_TITLE_CHARS} 字（现在 ${clean.length} 字）`);
  const book = loadSessionBook(home);
  const at = nowIso();
  const session: JointSession = {
    id: newSessionId(),
    title: clean,
    created_by: who,
    created_at: at,
    ended_at: null,
    status: "active",
    members: [
      { identity: OWNER_IDENTITY, kind: "owner", joined_at: at, left_at: null },
      { identity: "self", kind: "self", joined_at: at, left_at: null },
    ],
    delegations: [],
    shares: [],
    frames: [],
    recording_consented_by: [],
    pending_joins: [],
  };
  book.sessions.push(session);
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_created", session: session.id, title: clean, by: who });
  recordSessionEvent(home, "session_created", { session: session.id, title: clean, by: who });
  return session;
}

/** 好友进会的前提（与缺口 34 的准入闸同一口径）：已批准、未拉黑且在
* 信任圈里；账本读失败一律按“不准入”处理（fail-closed）。 */
export function checkSessionAdmission(home: string, identity: string): { admitted: boolean; reason: string } {
  if (identity === OWNER_IDENTITY) return { admitted: true, reason: "机主本人" };
  if (identity === "self") return { admitted: true, reason: "己方 agent" };
  try {
    const friendBook = loadFriendBook(home);
    const entry = findFriend(friendBook, identity);
    if (!entry) return { admitted: false, reason: `好友账本里没有 ${identity}：先加好友再进会` };
    if (entry.blocked) return { admitted: false, reason: `${identity} 已拉黑` };
    if (!isFriend(entry)) return { admitted: false, reason: `${identity} 还不是好友（须先批准对方的请求）` };
  } catch {
    return { admitted: false, reason: "好友账本读失败，按不准入处理" };
  }
  try {
    if (!isAdmitted(home, identity)) {
      return { admitted: false, reason: `${identity} 不在任何信任圈里：先跑 nyra circle invite <圈名> ${identity} 把它引进圈` };
    }
  } catch {
    return { admitted: false, reason: "信任圈账本读失败，按不准入处理" };
  }
  return { admitted: true, reason: "已批准好友且在信任圈里" };
}

/** 加入联合会话（机主邀好友进会；好友须过准入闸；已在会里直接报错）。 */
export function joinSession(home: string, sessionId: string, identity: string, by?: string): SessionMember {
  const who = by ?? OWNER_IDENTITY;
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束，不能再加入`);
  if (isActiveMember(session, identity)) throw new SessionError(`${identity} 已在会话 ${sessionId} 里`);
  const admission = checkSessionAdmission(home, identity);
  if (!admission.admitted) throw new SessionError(`${identity} 进不了会：${admission.reason}`);
  const member: SessionMember = { identity, kind: memberKind(identity), joined_at: nowIso(), left_at: null };
  session.members.push(member);
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_joined", session: sessionId, peer: identity, by: who });
  recordSessionEvent(home, "session_joined", { session: sessionId, peer: identity });
  return member;
}

/**
 * 第 2 批 G-P1-5：好友请求进会——先记一条待批请求。准入闸预检不过直接
 * 拒绝（连请求都不记）；已在会里、已有待批请求时直接报错。
 */
export function requestJoinSession(home: string, sessionId: string, identity: string, by?: string): SessionJoinRequest {
  const who = by ?? identity;
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束，不能再加入`);
  if (isActiveMember(session, identity)) throw new SessionError(`${identity} 已在会话 ${sessionId} 里`);
  if (session.pending_joins.some((r) => r.identity === identity && r.status === "pending")) {
    throw new SessionError(`${identity} 已有一条待批的进会请求，先处理它`);
  }
  const admission = checkSessionAdmission(home, identity);
  if (!admission.admitted) throw new SessionError(`${identity} 进不了会：${admission.reason}`);
  const req: SessionJoinRequest = {
    id: newId("join"),
    identity,
    requested_at: nowIso(),
    requested_by: who,
    status: "pending",
    decided_at: null,
    decided_by: null,
  };
  session.pending_joins.push(req);
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_join_requested", session: sessionId, peer: identity, by: who });
  recordSessionEvent(home, "session_join_requested", { session: sessionId, peer: identity });
  return req;
}

/** 第 2 批 G-P1-5：批准进会请求——只有机主能批；批准时重查准入闸
 * （请求后被拉黑/移出圈的，批准时拦下，请求保持 pending 等机主处理）。 */
export function approveJoinSession(home: string, sessionId: string, requestId: string, by?: string): SessionMember {
  const who = by ?? OWNER_IDENTITY;
  if (who !== OWNER_IDENTITY) throw new SessionError("只有机主能批准进会请求");
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束，不能再加入`);
  const req = session.pending_joins.find((r) => r.id === requestId);
  if (!req) throw new SessionError(`没有这个进会请求：${requestId}`);
  if (req.status !== "pending") throw new SessionError(`进会请求 ${requestId} 已是 ${req.status} 状态，不能再批`);
  const admission = checkSessionAdmission(home, req.identity);
  if (!admission.admitted) throw new SessionError(`${req.identity} 现在进不了会：${admission.reason}（请求保持待批）`);
  if (isActiveMember(session, req.identity)) {
    // 请求后已通过别的方式进会（直接 join）：请求直接标 approved，不重复加人。
    req.status = "approved";
    req.decided_at = nowIso();
    req.decided_by = who;
    saveSessionBook(home, book);
    return session.members.find((m) => m.identity === req.identity && m.left_at === null)!;
  }
  const member: SessionMember = { identity: req.identity, kind: memberKind(req.identity), joined_at: nowIso(), left_at: null };
  session.members.push(member);
  req.status = "approved";
  req.decided_at = nowIso();
  req.decided_by = who;
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_join_approved", session: sessionId, peer: req.identity, by: who });
  recordSessionEvent(home, "session_join_approved", { session: sessionId, peer: req.identity });
  return member;
}

/** 第 2 批 G-P1-5：拒绝进会请求——只有机主能拒；拒绝是终态。 */
export function declineJoinSession(home: string, sessionId: string, requestId: string, by?: string): SessionJoinRequest {
  const who = by ?? OWNER_IDENTITY;
  if (who !== OWNER_IDENTITY) throw new SessionError("只有机主能拒绝进会请求");
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  const req = session.pending_joins.find((r) => r.id === requestId);
  if (!req) throw new SessionError(`没有这个进会请求：${requestId}`);
  if (req.status !== "pending") throw new SessionError(`进会请求 ${requestId} 已是 ${req.status} 状态，不能再拒`);
  req.status = "declined";
  req.decided_at = nowIso();
  req.decided_by = who;
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_join_declined", session: sessionId, peer: req.identity, by: who });
  recordSessionEvent(home, "session_join_declined", { session: sessionId, peer: req.identity });
  return req;
}

/** 第 2 批 G-P1-5：列出待批的进会请求（不给会话时列全部会话的待批请求）。 */
export function listPendingJoins(home: string, sessionId?: string): { session: string; request: SessionJoinRequest }[] {
  const out: { session: string; request: SessionJoinRequest }[] = [];
  for (const s of loadSessionBook(home).sessions) {
    if (sessionId && s.id !== sessionId) continue;
    for (const r of s.pending_joins) {
      if (r.status === "pending") out.push({ session: s.id, request: r });
    }
  }
  return out;
}

/** 离开联合会话（任何一方可随时单方退出；人都走光了会话自动结束，
* 帧记录随之清空，默认不留存）。 */
export function leaveSession(home: string, sessionId: string, identity: string): JointSession {
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束`);
  const member = session.members.find((m) => m.identity === identity && m.left_at === null);
  if (!member) throw new SessionError(`${identity} 不在会话 ${sessionId} 里（或已离开）`);
  member.left_at = nowIso();
  if (!activeMembers(session).length) {
    session.status = "ended";
    session.ended_at = nowIso();
    session.frames = [];
  }
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_left", session: sessionId, peer: identity });
  recordSessionEvent(home, "session_left", { session: sessionId, peer: identity });
  if (session.status === "ended") {
    appendPeerAudit(home, { action: "session_ended", session: sessionId, by: "auto-empty" });
    recordSessionEvent(home, "session_ended", { session: sessionId, by: "auto-empty" });
  }
  return session;
}

/** 结束联合会话（只有机主能结束，须 --yes；帧记录清空，默认不留存；
* 委派与共享的清单、证据与审计不删）。 */
export function endSession(home: string, sessionId: string, by?: string): JointSession {
  const who = by ?? OWNER_IDENTITY;
  if (who !== OWNER_IDENTITY) throw new SessionError("只有机主能结束联合会话");
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束`);
  session.status = "ended";
  session.ended_at = nowIso();
  session.frames = [];
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_ended", session: sessionId, by: who });
  recordSessionEvent(home, "session_ended", { session: sessionId, by: who });
  return session;
}

// ---------------------------------------------------------------------------
// 会内 A2A 任务委派：走缺口 12 的交接 + 缺口 29 的交付契约
// ---------------------------------------------------------------------------

export interface SessionDelegateInput {
  /** 测试注入：假客户端工厂 / 假审查 runner / 假 token（与 peer.ts 同款）。 */
  deps?: PeerCallDeps;
}

/** 会内委派：会上交代的事当场变任务、进各方证据链。
*
* 流程：委派方与被委派方都须是在会成员；被委派的好友须过准入闸
* （圈外好友接不到任务）；验收标准是非空清单，落成一条缺口 29 的
* 交付契约（manual 检查项，委派即确认、直接激活，之后可按契约验
* 收）；委派本身只记在本地会话账本里（本地记账不是对外发送）；
* 交付给对端才走缺口 12 的 handoffPeer（自带对端协作开关、独立审
* 查门与信任圈闸）：对端未配、协作未开、审查拦截时，委派仍留在账
* 本里待对方来取，delivery 记 pending/blocked/failed 与原因，不
* 静默丢任务。 */
export async function delegateInSession(home: string, opts: {
  sessionId: string;
  from: string;
  to: string;
  task: string;
  acceptance: string[];
  deps?: PeerCallDeps;
}): Promise<SessionDelegation> {
  const task = opts.task.trim();
  if (!task) throw new SessionError("委派任务不能为空");
  if (task.length > SESSION_MAX_TASK_CHARS) throw new SessionError(`委派任务最多 ${SESSION_MAX_TASK_CHARS} 字（现在 ${task.length} 字）`);
  const acceptance = opts.acceptance.map((a) => a.trim()).filter(Boolean);
  if (!acceptance.length) throw new SessionError("委派要有验收标准（至少一项 --accept）");
  for (const a of acceptance) {
    if (a.length > SESSION_MAX_ACCEPTANCE_CHARS) throw new SessionError(`验收标准每项最多 ${SESSION_MAX_ACCEPTANCE_CHARS} 字：${a.slice(0, 40)}……`);
  }
  const book = loadSessionBook(home);
  const session = findSession(book, opts.sessionId);
  if (!session) throw new SessionError(`没有这个会话：${opts.sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${opts.sessionId} 已结束，不能再委派`);
  if (!isActiveMember(session, opts.from)) throw new SessionError(`${opts.from} 不在会话 ${opts.sessionId} 里，不能委派`);
  if (!isActiveMember(session, opts.to)) throw new SessionError(`${opts.to} 不在会话 ${opts.sessionId} 里，接不到委派`);
  if (opts.to !== OWNER_IDENTITY && opts.to !== "self") {
    const admission = checkSessionAdmission(home, opts.to);
    if (!admission.admitted) throw new SessionError(`${opts.to} 接不到委派：${admission.reason}`);
  }
  // 验收标准落成缺口 29 的交付契约（manual 检查项；委派即确认，直接激活）。
  const contract = createContract(home, {
    task,
    deliverables: [{ id: "d1", description: task.slice(0, 200), attributes: [] }],
    checks: acceptance.map((label, i) => ({ id: `a${i + 1}`, label, kind: "manual" as const, checker: null })),
  });
  activateContract(home, contract.id);
  const at = nowIso();
  const delegation: SessionDelegation = {
    id: newId("del"),
    from: opts.from,
    to: opts.to,
    task,
    acceptance,
    contract_id: contract.id,
    status: "delegated",
    delivery: "pending",
    delivery_reason: "",
    peer_run_id: null,
    created_at: at,
    updated_at: at,
    note: "",
  };
  // 交付：只向配在 peers.list 里的对端发（走缺口 12 的 handoffPeer，
  // 自带协作开关、审查门与信任圈闸）；发不出去时任务仍留在账本里。
  const config = loadConfig(home);
  const peer = opts.to === OWNER_IDENTITY || opts.to === "self" ? null : resolvePeer(config, opts.to);
  if (peer === null) {
    delegation.delivery = "pending";
    delegation.delivery_reason = opts.to === OWNER_IDENTITY || opts.to === "self"
      ? "本机会内任务，不用对外发送"
      : `对端 ${opts.to} 未配在 config.json 的 peers.list 里：任务留在会话账本里，对方来取`;
  } else if (!peerConfig(config).enabled) {
    delegation.delivery = "pending";
    delegation.delivery_reason = "对端协作未开启：先运行 nyra peer enable（任务留在会话账本里）";
  } else {
    try {
      const store = new RunStore(join(resolveNyraHome(home), "runs"));
      const evidenceRun = store.create(`联合会话委派：${opts.sessionId} ${opts.from} -> ${opts.to}`, "session", process.cwd(), "readonly", 1, "running");
      const out = await handoffPeer({ config, home, peer, runId: evidenceRun.run_id, mode: "readonly", deps: opts.deps });
      if (out.status === "accepted") {
        delegation.delivery = "sent";
        delegation.peer_run_id = out.peerRunId;
        delegation.delivery_reason = "";
      } else if (out.status === "rejected") {
        delegation.delivery = "blocked";
        delegation.delivery_reason = "对端拒绝或独立审查拦截（详见 peer-audit）";
      } else {
        delegation.delivery = "failed";
        delegation.delivery_reason = "交接发送失败（详见 peer-audit）";
      }
      try { store.setStatus(evidenceRun.run_id, out.status === "accepted" ? "completed_unverified" : "failed"); } catch { /* ignore */ }
    } catch (err) {
      delegation.delivery = "failed";
      delegation.delivery_reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }
  session.delegations.push(delegation);
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_delegated", session: opts.sessionId, from: opts.from, to: opts.to, delegation: delegation.id, contract: contract.id, delivery: delegation.delivery });
  recordSessionEvent(home, "session_delegated", { session: opts.sessionId, from: opts.from, to: opts.to, delegation: delegation.id, contract: contract.id, delivery: delegation.delivery });
  return delegation;
}

/** 被委派方接下任务（只有被委派方本人或机主能接）。 */
export function acceptDelegation(home: string, sessionId: string, delegationId: string, by: string): SessionDelegation {
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束`);
  const delegation = session.delegations.find((d) => d.id === delegationId);
  if (!delegation) throw new SessionError(`没有这条委派：${delegationId}`);
  if (delegation.status !== "delegated") throw new SessionError(`委派 ${delegationId} 已是 ${delegation.status}，不用再接`);
  if (by !== delegation.to && by !== OWNER_IDENTITY) throw new SessionError(`只有被委派方 ${delegation.to} 或机主能接下这条委派`);
  delegation.status = "accepted";
  delegation.updated_at = nowIso();
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_delegation_accepted", session: sessionId, delegation: delegationId, by });
  recordSessionEvent(home, "session_delegation_accepted", { session: sessionId, delegation: delegationId, by });
  return delegation;
}

/** 被委派方交活（只有被委派方本人或机主能交；产物摘要只记一句话，
* 不记产物全文）。
*
* 交活即验收（缺口 39 第二批）：按委派时落成的契约逐项跑验收。
* 验收标准是 manual 检查项（a1、a2……，编号见 nyra session verify），
* 交活的人须逐项确认：--confirm <编号> 算通过，--fail <编号> 算不
* 通过；全部检查项都要有结论才跑验收，缺一项就拒绝交活、什么都不
* 改。结论 accepted 时委派标 completed，rejected 时标 rejected（可
* 以重新委派再做，不静默吞掉失败）；验收经过与结论记进证据链
* （session_delegation_verified 事件）与 peer-audit。 */
export interface DelegationVerificationMarks {
  /** 通过的检查 id（a1、a2……）。 */
  confirm?: string[];
  /** 不通过的检查 id。 */
  fail?: string[];
  /** 产物摘要，同时作人工确认的证据。 */
  note?: string;
}

export async function completeDelegation(
  home: string,
  sessionId: string,
  delegationId: string,
  by: string,
  marks: DelegationVerificationMarks = {},
): Promise<SessionDelegation> {
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束`);
  const delegation = session.delegations.find((d) => d.id === delegationId);
  if (!delegation) throw new SessionError(`没有这条委派：${delegationId}`);
  if (delegation.status !== "accepted" && delegation.status !== "delegated") {
    throw new SessionError(`委派 ${delegationId} 已是 ${delegation.status}，不能再交活`);
  }
  if (by !== delegation.to && by !== OWNER_IDENTITY) throw new SessionError(`只有被委派方 ${delegation.to} 或机主能交活`);
  if (!delegation.contract_id) throw new SessionError(`委派 ${delegationId} 没有契约，交不了活（先检查契约账本）`);
  const contract = getContract(home, delegation.contract_id);
  if (!contract) throw new SessionError(`委派 ${delegationId} 的契约 ${delegation.contract_id} 找不到了，交不了活（先检查契约账本）`);
  const confirm = [...new Set((marks.confirm ?? []).map((s) => s.trim()).filter(Boolean))];
  const fail = [...new Set((marks.fail ?? []).map((s) => s.trim()).filter(Boolean))];
  const known = new Set(contract.checks.map((c) => c.id));
  const unknown = [...confirm, ...fail].filter((id) => !known.has(id));
  if (unknown.length) {
    throw new SessionError(`验收标准里没有：${unknown.join("、")}（查编号：nyra session verify ${sessionId} ${delegationId}）`);
  }
  const overlap = confirm.filter((id) => fail.includes(id));
  if (overlap.length) throw new SessionError(`检查 ${overlap.join("、")} 不能既通过又不通过`);
  const undecided = contract.checks.map((c) => c.id).filter((id) => !confirm.includes(id) && !fail.includes(id));
  if (undecided.length) {
    throw new SessionError(`验收标准还没确认完：${undecided.join("、")}（通过用 --confirm <编号>，不通过用 --fail <编号>；查编号：nyra session verify ${sessionId} ${delegationId}）`);
  }
  const note = (marks.note ?? "").trim().slice(0, 500);
  const evidence = note || "（未附证据）";
  for (const id of confirm) markContractItem(home, contract.id, id, true, evidence);
  for (const id of fail) markContractItem(home, contract.id, id, false, evidence);
  const { attempt } = await verifyContract(home, contract.id, {
    workdir: null,
    changedFiles: [],
    diffStat: null,
    title: delegation.task,
    outputText: note,
    summary: note,
    trajectory: [],
    spentUsd: null,
  }, {});
  if (attempt.verdict === "pending") {
    throw new SessionError(`委派 ${delegationId} 的验收结论还是待定（不应该发生：检查项已全部确认过）`);
  }
  delegation.status = attempt.verdict === "accepted" ? "completed" : "rejected";
  delegation.note = note;
  delegation.updated_at = nowIso();
  saveSessionBook(home, book);
  appendPeerAudit(home, {
    action: attempt.verdict === "accepted" ? "session_delegation_completed" : "session_delegation_rejected",
    session: sessionId, delegation: delegationId, by, verdict: attempt.verdict, passed: attempt.passed, total: attempt.total,
  });
  recordSessionEvent(home, "session_delegation_verified", {
    session: sessionId, delegation: delegationId, verdict: attempt.verdict, passed: attempt.passed, total: attempt.total, by,
  });
  if (attempt.verdict === "accepted") {
    recordSessionEvent(home, "session_delegation_completed", { session: sessionId, delegation: delegationId, by });
  }
  return delegation;
}

/** 只读看一条委派的验收状态（不写账本、不改状态）：按契约现场打分，
* 返回委派、契约与本次打分结果；CLI 的 nyra session verify 用它。 */
export async function verifyDelegation(
  home: string,
  sessionId: string,
  delegationId: string,
): Promise<{ delegation: SessionDelegation; contract: DeliveryContract; attempt: ContractAttempt }> {
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  const delegation = session.delegations.find((d) => d.id === delegationId);
  if (!delegation) throw new SessionError(`没有这条委派：${delegationId}`);
  if (!delegation.contract_id) throw new SessionError(`委派 ${delegationId} 没有契约`);
  const contract = getContract(home, delegation.contract_id);
  if (!contract) throw new SessionError(`委派 ${delegationId} 的契约 ${delegation.contract_id} 找不到了`);
  const attempt = await scoreContract(contract, {
    workdir: null,
    changedFiles: [],
    diffStat: null,
    title: delegation.task,
    outputText: delegation.note,
    summary: delegation.note,
    trajectory: [],
    spentUsd: null,
  }, {});
  return { delegation, contract, attempt };
}

/** 读一条委派的验收报告文本（verify 子命令与 show 共用）。 */
export async function formatDelegationVerification(home: string, sessionId: string, delegationId: string): Promise<string> {
  const { delegation, contract, attempt } = await verifyDelegation(home, sessionId, delegationId);
  const lines = [
    `委派 ${delegation.id}（${delegation.from} -> ${delegation.to}）[${delegation.status}]`,
    formatContractReport(contract, attempt),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 共享任务产物（allowlist）+ 本地扇出模型 + 录制同意门
// ---------------------------------------------------------------------------

/** 会话内共享：只认 allowlist 里的四种（任务产物 / 显式打包的上下文
* 片段 / 证据摘要 / 便签）。memory / history / secret / file / key
* 等一律拒绝——记忆私有是红线，任意本地文件不共享。
*
* 带 --run 时，从该运行拼缺口 12 的交接包（默认字段 task / 结论 /
* 步骤 / 待办；kind 为 evidence 时才加 evidence 字段），渲染后存
* 在会话目录的 shared/ 下（0600），账本里只记清单与相对路径；不带
* --run 时只记一条便签清单，不存包内容。 */
export function shareInSession(home: string, opts: {
  sessionId: string;
  from: string;
  to?: string[];
  items: { kind: string; label: string }[];
  runId?: string;
}): SessionShare {
  if (!opts.items.length) throw new SessionError("共享要有至少一项（--kind + --label）");
  for (const item of opts.items) {
    if (SESSION_SHARE_DENIED_KINDS.includes(item.kind)) {
      throw new SessionError(`不共享 ${item.kind}：记忆、会话历史、密钥与任意本地文件不在共享 allowlist 里（只认：${SESSION_SHARE_KINDS.join("、")}）`);
    }
    if (!(SESSION_SHARE_KINDS as readonly string[]).includes(item.kind)) {
      throw new SessionError(`共享种类只认 ${SESSION_SHARE_KINDS.join("、")}，当前是 ${item.kind}`);
    }
    if (!item.label.trim()) throw new SessionError("共享项要有标签（--label）");
    if (item.label.length > SESSION_MAX_LABEL_CHARS) throw new SessionError(`共享标签最多 ${SESSION_MAX_LABEL_CHARS} 字`);
  }
  const book = loadSessionBook(home);
  const session = findSession(book, opts.sessionId);
  if (!session) throw new SessionError(`没有这个会话：${opts.sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${opts.sessionId} 已结束，不能再共享`);
  if (!isActiveMember(session, opts.from)) throw new SessionError(`${opts.from} 不在会话 ${opts.sessionId} 里，不能共享`);
  const recipients = opts.to && opts.to.length ? opts.to : activeMembers(session).filter((m) => m.identity !== opts.from).map((m) => m.identity);
  for (const to of recipients) {
    if (!isActiveMember(session, to)) throw new SessionError(`${to} 不在会话 ${opts.sessionId} 里，共享不到它`);
  }
  const shareId = newId("shr");
  const shareItems: SessionShareItem[] = [];
  for (const item of opts.items) {
    let file = "";
    if (opts.runId) {
      const fields: HandoffField[] = item.kind === "evidence"
        ? ["task", "conclusions", "steps", "todos", "evidence"]
        : ["task", "conclusions", "steps", "todos"];
      const pkg = buildHandoffPackage(home, opts.runId, fields);
      const dir = join(sessionDir(home, session.id), "shared");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        try { chmodSync(dir, 0o700); } catch { /* ignore */ }
      }
      const rel = `sessions/${session.id}/shared/${shareId}.md`;
      const fd = openSync(join(dir, `${shareId}.md`), "w", 0o600);
      try {
        writeSync(fd, renderHandoffPackage(pkg), null, "utf-8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      file = rel;
    }
    shareItems.push({ kind: item.kind as ShareKind, label: item.label.trim(), run_id: opts.runId ?? null, file });
  }
  const share: SessionShare = {
    id: shareId,
    from: opts.from,
    to: recipients,
    items: shareItems,
    created_at: nowIso(),
  };
  session.shares.push(share);
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_shared", session: opts.sessionId, from: opts.from, to: recipients.join(","), kinds: shareItems.map((i) => i.kind).join(",") });
  recordSessionEvent(home, "session_shared", { session: opts.sessionId, from: opts.from, kind: shareItems.map((i) => i.kind).join(","), items: String(shareItems.length) });
  return share;
}

/** 本地扇出模型（不是真 SFU）：一方的帧按会话成员表扇出。
*
* 只记帧指纹（SHA-256 前 12 位）与收件人，不记帧内容；扇出记录进
* 会话账本（最多 100 条，超了丢最旧的）与 peer-audit；会话结束时
* 帧记录清空——画面默认不留存。 */
export function fanoutFrame(home: string, sessionId: string, from: string, frameHash: string): { recipients: string[]; frame: SessionFrame } {
  if (!SESSION_FRAME_HASH_RE.test(frameHash)) {
    throw new SessionError(`帧指纹只认 12 位小写 hex（SHA-256 前 12 位），当前是 ${JSON.stringify(frameHash)}`);
  }
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束，不再扇出帧`);
  if (!isActiveMember(session, from)) throw new SessionError(`${from} 不在会话 ${sessionId} 里，不能发帧`);
  const recipients = activeMembers(session).filter((m) => m.identity !== from).map((m) => m.identity);
  const frame: SessionFrame = { id: newId("frm"), from, hash: frameHash, recipients, at: nowIso() };
  session.frames.push(frame);
  if (session.frames.length > SESSION_MAX_FRAMES) {
    session.frames.splice(0, session.frames.length - SESSION_MAX_FRAMES);
  }
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_frame_fanned", session: sessionId, from, hash: frameHash, recipients: recipients.join(",") });
  return { recipients, frame };
}

/** 录制同意：每位在会成员显式同意（--consent）或撤回（--revoke）。
* 录制只在全体在会成员都同意时才允许；新加入的成员须另行同意才算
* 数。同意状态变更进证据链；录制本身的仪表与成本账是缺口 40 的事。 */
export function consentRecording(home: string, sessionId: string, identity: string, consent: boolean): { allowed: boolean; consented: string[] } {
  const book = loadSessionBook(home);
  const session = findSession(book, sessionId);
  if (!session) throw new SessionError(`没有这个会话：${sessionId}`);
  if (session.status !== "active") throw new SessionError(`会话 ${sessionId} 已结束`);
  if (!isActiveMember(session, identity)) throw new SessionError(`${identity} 不在会话 ${sessionId} 里，不能表态`);
  if (consent) {
    if (!session.recording_consented_by.some((c) => c.identity === identity)) {
      session.recording_consented_by.push({ identity, at: nowIso() });
    }
  } else {
    session.recording_consented_by = session.recording_consented_by.filter((c) => c.identity !== identity);
  }
  saveSessionBook(home, book);
  appendPeerAudit(home, { action: "session_recording_consented", session: sessionId, by: identity, consented: consent });
  recordSessionEvent(home, "session_recording_consented", { session: sessionId, by: identity, consented: consent });
  return { allowed: recordingAllowed(session), consented: session.recording_consented_by.map((c) => c.identity) };
}

// ---------------------------------------------------------------------------
// CLI：nyra session <create|join|leave|list|show|delegate|accept|
//   verify|complete|share|frame|record|end>
// ---------------------------------------------------------------------------

const SESSION_USAGE = "用法：\n"
  + " nyra session create <标题>                  建联合会话（初始成员：机主 + 己方 agent）\n"
  + " nyra session list                           列出联合会话（状态、成员数、委派数）\n"
  + " nyra session show <会话>                    看一个会话：成员、委派、共享、录制同意状态\n"
  + " nyra session join <会话> <好友名>           邀好友进会（好友须已批准且在信任圈里，圈外直接拒绝）\n"
  + " nyra session join-request <会话> <好友名>    好友请求进会（先记一条待批请求；准入闸预检不过直接拒绝）\n"
  + " nyra session join-approve <会话> <请求 id> --yes   批准进会请求（批准时重查准入闸）\n"
  + " nyra session join-decline <会话> <请求 id> --yes   拒绝进会请求\n"
  + " nyra session join-list [<会话>]              列出待批的进会请求\n"
  + " nyra session leave <会话> [--who <身份>]    离开会话（任何一方可随时单方退出；人都走光了会话自动结束）\n"
  + " nyra session delegate <会话> --to <成员> --task <任务> --accept <标准> [--accept <标准> ...] [--from <成员>]   会内委派（验收标准落成缺口 29 的交付契约；交付走缺口 12 的交接，发不出去时任务留在账本里）\n"
  + " nyra session accept <会话> <委派id> [--by <身份>]    被委派方接下任务\n"
  + " nyra session verify <会话> <委派id>    看一条委派的验收状态（只读：契约 + 逐项结论，不改状态）\n"
  + " nyra session complete <会话> <委派id> [--by <身份>] [--note <产物摘要>] [--confirm <检查编号> ...] [--fail <检查编号> ...]   被委派方交活（交活即按契约跑验收：验收标准须逐项确认，通过用 --confirm、不通过用 --fail，编号见 verify；全通过才标 completed，有一项不通过就标 rejected）\n"
  + " nyra session share <会话> --kind <种> --label <标签> [--kind <种> --label <标签> ...] [--to <成员>] [--run <运行ID>] [--from <成员>]   会话内共享（只认 product / context / evidence / note；记忆、会话历史、密钥与任意本地文件一律不共享）\n"
  + " nyra session frame <会话> --hash <12位指纹> [--from <成员>]   扇出一帧（本地扇出模型：按成员表扇出，只记指纹与收件人，不记帧内容）\n"
  + " nyra session record <会话> --consent|--revoke|--status [--who <身份>]   录制同意（全体在会成员同意才允许录制；新加入的成员须另行同意）\n"
  + " nyra session end <会话> --yes               结束会话（只有机主能结束；帧记录清空，画面默认不留存）\n"
  + "联合会话是多人多 agent 的视频会（本地扇出模型，不是真 SFU 服务器）；对方发来的内容一律按不可信输入处理，写操作须对方主人显式接受。详见 docs/sessions.md";

export async function handleSession(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const flagValues = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
  };
  const has = (name: string): boolean => argv.includes(name);
  const err = (msg: string): number => {
    process.stderr.write(`错误：${msg}\n`);
    return 1;
  };
  try {
    if (!cmd || cmd === "list") {
      const sessions = listSessions(home);
      if (!sessions.length) {
        process.stdout.write("还没有联合会话：先跑 nyra session create <标题> 建一个。\n");
        return 0;
      }
      for (const s of sessions) {
        process.stdout.write(`${s.id}\t${s.status === "active" ? "进行中" : "已结束"}\t${s.title}\t${activeMembers(s).length} 位成员\t${s.delegations.length} 条委派\n`);
      }
      return 0;
    }
    if (cmd === "create") {
      const title = argv.slice(1).join(" ").trim();
      if (!title) {
        process.stderr.write("用法：nyra session create <标题>\n");
        return 2;
      }
      const session = createSession(home, title);
      process.stdout.write(`联合会话已建：${session.id}（${session.title}）\n`);
      process.stdout.write(`邀好友进会：nyra session join ${session.id} <好友名>（好友须已批准且在信任圈里）\n`);
      return 0;
    }
    if (cmd === "show") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra session show <会话>\n");
        return 2;
      }
      const book = loadSessionBook(home);
      const session = findSession(book, id);
      if (!session) return err(`没有这个会话：${id}`);
      process.stdout.write(`${session.id} ${session.status === "active" ? "进行中" : "已结束"} — ${session.title}\n`);
      process.stdout.write(`建于：${session.created_at}（${session.created_by}）${session.ended_at ? `\n结束于：${session.ended_at}` : ""}\n`);
      process.stdout.write("成员：\n");
      for (const m of session.members) {
        process.stdout.write(` ${m.identity}（${m.kind}）${m.left_at ? ` 已离开 ${m.left_at}` : " 在会"}\n`);
      }
      process.stdout.write(`委派：${session.delegations.length} 条\n`);
      for (const d of session.delegations) {
        process.stdout.write(` ${d.id} ${d.from} -> ${d.to} [${d.status}] 交付 ${d.delivery}${d.delivery_reason ? `（${d.delivery_reason}）` : ""} 契约 ${d.contract_id ?? "无"}\n`);
        process.stdout.write(`   任务：${d.task.slice(0, 120)}\n`);
        if (d.contract_id) {
          const contract = getContract(home, d.contract_id);
          const latest = contract?.attempts.at(-1);
          process.stdout.write(`   验收：${contract ? `${contract.status}，最近一次 ${latest ? `${latest.passed}/${latest.total} 通过（${latest.verdict === "accepted" ? "已接受" : latest.verdict === "rejected" ? "未接受" : "待定"}）` : "还没跑过验收"}` : "契约找不到了"}\n`);
        }
      }
      process.stdout.write(`共享：${session.shares.length} 条\n`);
      for (const s of session.shares) {
        process.stdout.write(` ${s.id} ${s.from} -> ${s.to.join("、") || "（无收件人）"}：${s.items.map((i) => `${i.kind}：${i.label}`).join("；")}\n`);
      }
      process.stdout.write(`帧扇出记录：${session.frames.length} 条（只记指纹，会话结束时清空，默认不留存）\n`);
      process.stdout.write(`录制同意：${session.recording_consented_by.map((c) => c.identity).join("、") || "无人同意"}（${recordingAllowed(session) ? "全体已同意，可以录制" : "未获全体同意，不能录制"}）\n`);
      const pendingJoins = session.pending_joins.filter((r) => r.status === "pending");
      process.stdout.write(`待批进会：${pendingJoins.length} 条\n`);
      for (const r of pendingJoins) {
        process.stdout.write(` ${r.id} ${r.identity}（${r.requested_at} 申请）\n`);
      }
      return 0;
    }
    if (cmd === "join") {
      const id = argv[1];
      const identity = argv[2];
      if (!id || !identity) {
        process.stderr.write("用法：nyra session join <会话> <好友名>\n");
        return 2;
      }
      joinSession(home, id, identity);
      process.stdout.write(`${identity} 已进会 ${id}（准入闸已过：已批准好友且在信任圈里）\n`);
      return 0;
    }
    if (cmd === "join-request") {
      const id = argv[1];
      const identity = argv[2];
      if (!id || !identity) {
        process.stderr.write("用法：nyra session join-request <会话> <好友名>\n");
        return 2;
      }
      const req = requestJoinSession(home, id, identity);
      process.stdout.write(`进会请求已记：${req.id}（${identity} 想进 ${id}；批准：nyra session join-approve ${id} ${req.id} --yes）\n`);
      return 0;
    }
    if (cmd === "join-approve" || cmd === "join-decline") {
      const id = argv[1];
      const requestId = argv[2];
      if (!id || !requestId) {
        process.stderr.write(`用法：nyra session ${cmd} <会话> <请求 id> --yes\n`);
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write(`${cmd === "join-approve" ? "批准" : "拒绝"}进会请求须加 --yes 确认\n`);
        return 2;
      }
      if (cmd === "join-approve") {
        const member = approveJoinSession(home, id, requestId);
        process.stdout.write(`${member.identity} 已进会 ${id}（批准时重查了准入闸）\n`);
      } else {
        declineJoinSession(home, id, requestId);
        process.stdout.write(`进会请求 ${requestId} 已拒绝\n`);
      }
      return 0;
    }
    if (cmd === "join-list") {
      const id = argv[1] ?? undefined;
      const pending = listPendingJoins(home, id);
      if (!pending.length) {
        process.stdout.write("没有待批的进会请求。\n");
        return 0;
      }
      for (const p of pending) {
        process.stdout.write(`${p.request.id}\t${p.request.identity}\t会话 ${p.session}\t${p.request.requested_at}\n`);
      }
      return 0;
    }
    if (cmd === "leave") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra session leave <会话> [--who <身份>]\n");
        return 2;
      }
      const session = leaveSession(home, id, flagValue("--who") ?? OWNER_IDENTITY);
      process.stdout.write(`${flagValue("--who") ?? OWNER_IDENTITY} 已离开 ${id}${session.status === "ended" ? "（人都走光了，会话自动结束，帧记录已清空）" : ""}\n`);
      return 0;
    }
    if (cmd === "delegate") {
      const id = argv[1];
      const to = flagValue("--to");
      const task = flagValue("--task");
      const acceptance = flagValues("--accept");
      if (!id || !to || !task || !acceptance.length) {
        process.stderr.write("用法：nyra session delegate <会话> --to <成员> --task <任务> --accept <标准> [--accept <标准> ...] [--from <成员>]\n");
        return 2;
      }
      const delegation = await delegateInSession(home, {
        sessionId: id,
        from: flagValue("--from") ?? OWNER_IDENTITY,
        to,
        task,
        acceptance,
      });
      process.stdout.write(`委派已记进会话：${delegation.id}（${delegation.from} -> ${delegation.to}，契约 ${delegation.contract_id}）\n`);
      if (delegation.delivery === "sent") {
        process.stdout.write(`已发给对端（对端运行：${delegation.peer_run_id}）\n`);
      } else {
        process.stdout.write(`交付状态：${delegation.delivery}（${delegation.delivery_reason}）\n`);
      }
      return 0;
    }
    if (cmd === "accept" || cmd === "complete" || cmd === "verify") {
      const id = argv[1];
      const delegationId = argv[2];
      if (!id || !delegationId) {
        process.stderr.write(`用法：nyra session ${cmd} <会话> <委派id>${cmd === "complete" ? " [--by <身份>] [--note <产物摘要>] [--confirm <检查编号> ...] [--fail <检查编号> ...]" : cmd === "accept" ? " [--by <身份>]" : ""}\n`);
        return 2;
      }
      const by = flagValue("--by") ?? OWNER_IDENTITY;
      if (cmd === "accept") {
        acceptDelegation(home, id, delegationId, by);
        process.stdout.write(`委派 ${delegationId} 已接下（${by}）\n`);
      } else if (cmd === "verify") {
        const report = await formatDelegationVerification(home, id, delegationId);
        process.stdout.write(`${report}\n`);
      } else {
        const done = await completeDelegation(home, id, delegationId, by, {
          note: flagValue("--note"),
          confirm: flagValues("--confirm"),
          fail: flagValues("--fail"),
        });
        const contract = done.contract_id ? getContract(home, done.contract_id) : null;
        const latest = contract?.attempts.at(-1);
        if (done.status === "completed") {
          process.stdout.write(`委派 ${delegationId} 已交活（${by}；验收通过 ${latest ? `${latest.passed}/${latest.total}` : "—"}，契约已接受）\n`);
        } else {
          process.stdout.write(`委派 ${delegationId} 验收未通过（${latest ? `${latest.passed}/${latest.total}` : "—"}），已标为 rejected（可重新委派再做）\n`);
          return 1;
        }
      }
      return 0;
    }
    if (cmd === "share") {
      const id = argv[1];
      const kinds = flagValues("--kind");
      const labels = flagValues("--label");
      if (!id || !kinds.length || kinds.length !== labels.length) {
        process.stderr.write("用法：nyra session share <会话> --kind <种> --label <标签> [--kind <种> --label <标签> ...] [--to <成员>] [--run <运行ID>] [--from <成员>]\n");
        return 2;
      }
      const share = shareInSession(home, {
        sessionId: id,
        from: flagValue("--from") ?? OWNER_IDENTITY,
        to: flagValues("--to"),
        items: kinds.map((kind, i) => ({ kind, label: labels[i] })),
        runId: flagValue("--run"),
      });
      process.stdout.write(`共享已记进会话：${share.id}（${share.from} -> ${share.to.join("、") || "全体在会成员"}，${share.items.length} 项）\n`);
      for (const item of share.items) {
        if (item.file) process.stdout.write(` 包文件：${item.file}\n`);
      }
      return 0;
    }
    if (cmd === "frame") {
      const id = argv[1];
      const hash = flagValue("--hash");
      if (!id || !hash) {
        process.stderr.write("用法：nyra session frame <会话> --hash <12位指纹> [--from <成员>]\n");
        return 2;
      }
      const { recipients } = fanoutFrame(home, id, flagValue("--from") ?? OWNER_IDENTITY, hash);
      process.stdout.write(`帧已扇出给：${recipients.join("、") || "（会里没有其他成员）"}（只记指纹 ${hash}，不记帧内容）\n`);
      return 0;
    }
    if (cmd === "record") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra session record <会话> --consent|--revoke|--status [--who <身份>]\n");
        return 2;
      }
      const who = flagValue("--who") ?? OWNER_IDENTITY;
      if (has("--status")) {
        const book = loadSessionBook(home);
        const session = findSession(book, id);
        if (!session) return err(`没有这个会话：${id}`);
        process.stdout.write(`录制同意：${session.recording_consented_by.map((c) => c.identity).join("、") || "无人同意"}（${recordingAllowed(session) ? "全体已同意，可以录制" : "未获全体同意，不能录制"}）\n`);
        return 0;
      }
      if (has("--consent") || has("--revoke")) {
        const { allowed, consented } = consentRecording(home, id, who, has("--consent"));
        process.stdout.write(`${who}已${has("--consent") ? "同意" : "撤回同意"}录制（已同意：${consented.join("、") || "无"}；${allowed ? "全体已同意，可以录制" : "未获全体同意，不能录制"}）\n`);
        return 0;
      }
      process.stderr.write("用法：nyra session record <会话> --consent|--revoke|--status [--who <身份>]\n");
      return 2;
    }
    if (cmd === "end") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra session end <会话> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("结束会话须加 --yes 确认（帧记录会清空，画面默认不留存）\n");
        return 2;
      }
      endSession(home, id);
      process.stdout.write(`会话 ${id} 已结束（帧记录已清空；委派与共享的清单、证据与审计不删）\n`);
      return 0;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  process.stderr.write(SESSION_USAGE + "\n");
  return 2;
}
