// src/callLedger.ts — 缺口 40：通话成本与隐私仪表。
//
// 每通电话的三本账（传输 / 媒体 / token）+ 录制仪表 + 通话纪要进证据链。
//
// 口径（Teamly 报告 §3 三段论）：
//   - 传输层：1:1 直连零 token；TURN/SFU 的带宽成本由中转/服务方出，仍是带宽账单。
//     本批只在回环/假媒体上量字节——语音通话是本机回环（无真实传输字节，
//     记 0 并注明），视频通话记 transportBytesIn/Out，联合会话不记字节（帧扇出
//     只记指纹，不记字节，记 null 并注明）。真 TURN/STUN 带宽计量本批不做。
//   - 理解层：看和听按需花、优先本地小模型。云端 token 只记视频帧的
//     prompt/completion token（engine 以 cloud: 开头）；语音 STT 按分钟计价，
//     没有 token 数，记秒数与花费；本地引擎（whisper.cpp / ollama:）记帧数与
//     秒数，token 与花费恒 0。
//   - 干活层：与文字任务同价，走现有硬顶（缺口 20 + 缺口 43 分层上限），本批
//     不另起一套上限；账本只记会内委派了几项任务（id 列表），干活 token 与花费
//     按关联运行记，账本里只留 runId，不重复记。
//
// 录制仪表：接缺口 39 的录制同意门。录制默认关；只有全体在会成员同意后才
//   开始计录制账；任一成员撤销同意或会话结束即停录。录制秒数从 peer-audit
//   的同意/撤销事件 + 成员加入/离开时间重建（确定性推导）；录制大小恒为
//   未知（null）——本批没有真实录制器，不编字节数。
//
// 隐私：账本只记用量数字与 id，不记通话内容原文、不记帧内容、不记共享包内容。
//   纪要（call_summary 事件）只含数字与 id。账本文件 0600，只有机主与会话
//   成员的本地 CLI 能读（CLI 本身只在机主本机跑）。
//
// 本模块是叶子模块：只读三家通话账本的 JSON 文件（voice-calls.json /
//   video-calls.json / sessions.json）与 peer-audit.jsonl，不 import
//   voiceCall / videoCall / session 模块，避免循环导入。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";

export const CALL_LEDGER_FILE = "call-ledger.json";

export type CallLedgerKind = "voice" | "video" | "session";

export const CALL_LEDGER_KINDS: readonly CallLedgerKind[] = ["voice", "video", "session"];

export function callKindLabel(kind: CallLedgerKind): string {
  if (kind === "voice") return "语音";
  if (kind === "video") return "视频";
  return "联合会话";
}

/** 传输账：带宽用了多少。null = 未计量（见 note）。 */
export interface CallTransportBook {
  bytesIn: number | null;
  bytesOut: number | null;
  /** 视频 ICE 是否走中继；语音/会话为 null。 */
  relayed: boolean | null;
  note: string;
}

/** 媒体账：看了几帧、STT 几分钟。 */
export interface CallMediaBook {
  framesSampled: number;
  framesDescribed: number;
  framesSent: number;
  framesReceived: number;
  /** 累计 STT 秒数（有时长的段才计）。 */
  sttSeconds: number;
  /** 累计 TTS 回读字数。 */
  ttsChars: number;
}

/** token 账：理解与干活各花多少。 */
export interface CallTokenBook {
  /** 云端理解 token（视频帧 prompt+completion 合计；语音 STT 无 token，记 null）。 */
  understandingPromptTokens: number | null;
  understandingCompletionTokens: number | null;
  /** 云端理解花费（美元；任一部分未计价时为 null，表示只是下界）。 */
  understandingCostUsd: number | null;
  understandingUnpriced: boolean;
  /** 本地理解量：本地引擎描述的帧数。 */
  localFrames: number;
  /** 本地理解量：本地 STT 秒数。 */
  localSttSeconds: number;
  /** 云端 STT 秒数（按分钟计价的云端转写）。 */
  cloudSttSeconds: number;
  /** 干活：会内委派任务数（语音/视频通话为 0）。 */
  delegatedTasks: number;
  delegationIds: string[];
  /** 干活 token 与花费按关联运行记，账本不重复记，恒为 null。 */
  workTokens: number | null;
  workCostUsd: number | null;
  workNote: string;
}

/** 录制账：录了多久、存了多大。 */
export interface CallRecordingBook {
  /** 当前是否全体同意（可录制）。 */
  allowed: boolean;
  consentedBy: string[];
  /** 累计录制秒数（从同意门状态变迁推导；视频通话无时间戳，记 null）。 */
  seconds: number | null;
  /** 录制文件大小（字节）：本批没有真实录制器，恒为 null（未知）。 */
  bytes: number | null;
  /** 当前这段录制的开始时间；未在录为 null。 */
  startedAt: string | null;
  note: string;
}

export interface CallLedgerEntry {
  id: string;
  kind: CallLedgerKind;
  agent: string;
  peer: string | null;
  participants: string[];
  startedAt: string;
  endedAt: string | null;
  status: string;
  durationSeconds: number | null;
  transport: CallTransportBook;
  media: CallMediaBook;
  tokens: CallTokenBook;
  recording: CallRecordingBook;
  runId: string | null;
  /** 纪要（call_summary 事件）是否已进证据链。 */
  summaryRecorded: boolean;
  /** 已记录的录制起止事件数（按时间顺序数，防重复记）。 */
  recordingTransitionsRecorded: number;
  /** 上次同步时的录制状态（起止事件用）。 */
  recordingEventState: "on" | "off";
}

export interface CallLedgerBook {
  version: 1;
  calls: CallLedgerEntry[];
}

export class CallLedgerError extends Error {}

function ledgerPath(home: string): string {
  return join(resolveNyraHome(home), CALL_LEDGER_FILE);
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
  renameSync(tmp, path);
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
  }
}

/** 读通话账本：没有返回空账本；损坏先备份再抛错。 */
export function loadCallLedgerBook(home: string): CallLedgerBook {
  const path = ledgerPath(home);
  if (!existsSync(path)) return { version: 1, calls: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new CallLedgerError(`通话账本读不出来：${CALL_LEDGER_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = `${CALL_LEDGER_FILE}.corrupt-${Date.now()}`;
    try { renameSync(path, join(resolveNyraHome(home), backup)); } catch { /* ignore */ }
    throw new CallLedgerError(`通话账本损坏，已备份为 ${backup}，请检查后再同步`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { calls?: unknown }).calls)) {
    const backup = `${CALL_LEDGER_FILE}.corrupt-${Date.now()}`;
    try { renameSync(path, join(resolveNyraHome(home), backup)); } catch { /* ignore */ }
    throw new CallLedgerError(`通话账本格式不对，已备份为 ${backup}，请检查后再同步`);
  }
  const book = parsed as CallLedgerBook;
  if (book.version !== 1) throw new CallLedgerError(`通话账本版本不支持：${String(book.version)}`);
  return book;
}

export function saveCallLedgerBook(home: string, book: CallLedgerBook): void {
  writeJsonAtomic(home, CALL_LEDGER_FILE, JSON.stringify(book, null, 2) + "\n");
}

// ---- 来源账本读取（只读 JSON，不 import voiceCall / videoCall / session）----

interface VoiceSegmentRow {
  durationSeconds?: number | null;
  engine?: string | null;
  costUsd?: number | null;
}

interface VoiceCallRow {
  id: string;
  agent: string;
  peer?: string | null;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  segments?: VoiceSegmentRow[];
  sttSeconds?: number;
  ttsChars?: number;
  costUsd?: number | null;
  costUnpriced?: boolean;
  runId?: string | null;
}

interface VideoFrameRow {
  sampled?: boolean;
  status?: string;
  engine?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
}

interface VideoCallRow {
  id: string;
  agent: string;
  peer?: string | null;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  frames?: VideoFrameRow[];
  transportBytesIn?: number;
  transportBytesOut?: number;
  framesSent?: number;
  framesReceived?: number;
  icePair?: { relayed?: boolean } | null;
  recordConsentLocal?: boolean;
  recordConsentRemote?: boolean;
  runId?: string | null;
}

interface SessionMemberRow {
  identity: string;
  joined_at: string;
  left_at: string | null;
}

interface SessionDelegationRow {
  id: string;
  to: string;
  status: string;
  contract_id?: string | null;
}

interface SessionRow {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
  ended_at?: string | null;
  status: string;
  members?: SessionMemberRow[];
  delegations?: SessionDelegationRow[];
}

function readJsonFile<T>(path: string, label: string): T | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new CallLedgerError(`${label}读不出来`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CallLedgerError(`${label}损坏，请先修好该账本再同步`);
  }
}

function readVoiceCalls(home: string): VoiceCallRow[] {
  const store = readJsonFile<{ calls?: VoiceCallRow[] }>(join(resolveNyraHome(home), "voice-calls.json"), "语音通话账本");
  return store?.calls ?? [];
}

function readVideoCalls(home: string): VideoCallRow[] {
  const store = readJsonFile<{ calls?: VideoCallRow[] }>(join(resolveNyraHome(home), "video-calls.json"), "视频通话账本");
  return store?.calls ?? [];
}

function readSessions(home: string): SessionRow[] {
  const store = readJsonFile<{ sessions?: SessionRow[] }>(join(resolveNyraHome(home), "sessions.json"), "联合会话账本");
  return store?.sessions ?? [];
}

interface ConsentEvent {
  at: string;
  by: string;
  consented: boolean;
}

/** 从 peer-audit.jsonl 读某会话的录制同意事件（按时间排序）。 */
function readConsentEvents(home: string, sessionId: string): ConsentEvent[] {
  const path = join(resolveNyraHome(home), "peer-audit.jsonl");
  if (!existsSync(path)) return [];
  const out: ConsentEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev["action"] !== "session_recording_consented") continue;
      if (ev["session"] !== sessionId) continue;
      if (typeof ev["at"] !== "string" || typeof ev["by"] !== "string" || typeof ev["consented"] !== "boolean") continue;
      out.push({ at: ev["at"] as string, by: ev["by"] as string, consented: ev["consented"] as boolean });
    } catch { /* 损坏行跳过 */ }
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

// ---- 录制时间重建（确定性推导）----

export interface RecordingTimeline {
  /** 累计录制秒数。 */
  seconds: number;
  /** 当前是否在录。 */
  allowed: boolean;
  /** 当前这段录制的开始时间；未在录为 null。 */
  startedAt: string | null;
  /** 起止变迁（按时间顺序）：on = 开始录，off = 停录。 */
  transitions: { at: string; on: boolean }[];
}

/**
 * 从成员加入/离开时间 + 同意/撤销事件重建录制时间线。
 * 规则：某时刻在录，当且仅当当时在会成员非空、且每位在会成员都已同意
 * （同意须在该成员本次加入之后；新加入的成员须另行同意才算数）。
 */
export function reconstructRecordingTimeline(session: SessionRow, consentEvents: ConsentEvent[], nowIso: string): RecordingTimeline {
  const members = session.members ?? [];
  const endMs = session.ended_at ? Date.parse(session.ended_at) : Date.parse(nowIso);
  const startMs = Date.parse(session.created_at);
  const breakpoints = new Set<number>([startMs, endMs]);
  for (const m of members) {
    breakpoints.add(Date.parse(m.joined_at));
    if (m.left_at) breakpoints.add(Date.parse(m.left_at));
  }
  for (const e of consentEvents) breakpoints.add(Date.parse(e.at));
  const points = [...breakpoints].filter((n) => Number.isFinite(n) && n >= startMs && n <= endMs).sort((a, b) => a - b);
  // 同意状态：每位成员最新一次（本次加入之后）的同意事件。
  const consentAt = (identity: string, joinedMs: number, atMs: number): boolean => {
    let consented = false;
    for (const e of consentEvents) {
      const eMs = Date.parse(e.at);
      if (e.by !== identity || eMs < joinedMs || eMs > atMs) continue;
      consented = e.consented;
    }
    return consented;
  };
  const activeAt = (atMs: number): SessionMemberRow[] =>
    members.filter((m) => Date.parse(m.joined_at) <= atMs && (m.left_at === null || Date.parse(m.left_at) > atMs));
  let seconds = 0;
  const transitions: { at: string; on: boolean }[] = [];
  let on = false;
  let startedAt: string | null = null;
  for (let i = 0; i < points.length; i++) {
    const atMs = points[i];
    const active = activeAt(atMs);
    const nowOn = active.length > 0 && active.every((m) => consentAt(m.identity, Date.parse(m.joined_at), atMs));
    if (nowOn !== on) {
      transitions.push({ at: new Date(atMs).toISOString(), on: nowOn });
      on = nowOn;
      if (nowOn) startedAt = new Date(atMs).toISOString();
      else startedAt = null;
    }
    if (i + 1 < points.length) {
      const nextMs = points[i + 1];
      if (on && nextMs > atMs) seconds += (nextMs - atMs) / 1000;
    }
  }
  // 当前是否在录：会话已结束则不在录；结束时若还在录，补一个停录变迁。
  const allowed = session.ended_at ? false : on;
  if (session.ended_at && transitions.length > 0 && transitions[transitions.length - 1].on) {
    transitions.push({ at: session.ended_at, on: false });
  }
  return { seconds: Math.round(seconds), allowed, startedAt: allowed ? startedAt : null, transitions };
}

// ---- 三本账汇总 ----

function durationSeconds(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

function isCloudEngine(engine: string | null | undefined): boolean {
  return typeof engine === "string" && engine.startsWith("cloud:");
}

function buildVoiceEntry(call: VoiceCallRow): CallLedgerEntry {
  let localStt = 0;
  let cloudStt = 0;
  let unpriced = false;
  for (const seg of call.segments ?? []) {
    const dur = typeof seg.durationSeconds === "number" ? seg.durationSeconds : 0;
    if (isCloudEngine(seg.engine)) {
      cloudStt += dur;
      if (seg.costUsd === null || seg.costUsd === undefined) unpriced = true;
    } else {
      localStt += dur;
    }
  }
  if (call.costUnpriced) unpriced = true;
  const totalCost = call.costUsd === null || call.costUsd === undefined ? null : call.costUsd;
  return {
    id: call.id, kind: "voice", agent: call.agent, peer: call.peer ?? null,
    participants: [call.agent, call.peer ?? "本机回环"].filter((p, i, a) => a.indexOf(p) === i),
    startedAt: call.startedAt, endedAt: call.endedAt ?? null, status: call.status,
    durationSeconds: durationSeconds(call.startedAt, call.endedAt ?? null),
    transport: { bytesIn: 0, bytesOut: 0, relayed: null, note: "本机回环，无真实传输字节" },
    media: {
      framesSampled: 0, framesDescribed: 0, framesSent: 0, framesReceived: 0,
      sttSeconds: call.sttSeconds ?? 0, ttsChars: call.ttsChars ?? 0,
    },
    tokens: {
      understandingPromptTokens: null, understandingCompletionTokens: null,
      understandingCostUsd: totalCost, understandingUnpriced: unpriced,
      localFrames: 0, localSttSeconds: Math.round(localStt), cloudSttSeconds: Math.round(cloudStt),
      delegatedTasks: 0, delegationIds: [],
      workTokens: null, workCostUsd: null, workNote: "干活 token 按关联运行记，见 runId",
    },
    recording: {
      allowed: false, consentedBy: [], seconds: 0, bytes: null, startedAt: null,
      note: "语音通话不录制",
    },
    runId: call.runId ?? null, summaryRecorded: false, recordingTransitionsRecorded: 0, recordingEventState: "off",
  };
}

function buildVideoEntry(call: VideoCallRow): CallLedgerEntry {
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cost: number | null = 0;
  let unpriced = false;
  let localFrames = 0;
  let framesSampled = 0;
  let framesDescribed = 0;
  for (const f of call.frames ?? []) {
    if (f.sampled) framesSampled += 1;
    if (f.status === "described" || f.status === "confirmed") framesDescribed += 1;
    if (!f.engine) continue;
    if (isCloudEngine(f.engine)) {
      if (f.promptTokens !== null && f.promptTokens !== undefined) promptTokens = (promptTokens ?? 0) + f.promptTokens;
      if (f.completionTokens !== null && f.completionTokens !== undefined) completionTokens = (completionTokens ?? 0) + f.completionTokens;
      if (f.costUsd === null || f.costUsd === undefined) unpriced = true;
      else cost = (cost ?? 0) + f.costUsd;
    } else {
      localFrames += 1;
    }
  }
  const allowed = (call.recordConsentLocal ?? false) && (call.recordConsentRemote ?? false);
  return {
    id: call.id, kind: "video", agent: call.agent, peer: call.peer ?? null,
    participants: [call.agent, call.peer ?? "本机回环"].filter((p, i, a) => a.indexOf(p) === i),
    startedAt: call.startedAt, endedAt: call.endedAt ?? null, status: call.status,
    durationSeconds: durationSeconds(call.startedAt, call.endedAt ?? null),
    transport: {
      bytesIn: call.transportBytesIn ?? 0, bytesOut: call.transportBytesOut ?? 0,
      relayed: call.icePair?.relayed ?? null, note: "回环/直连实测字节；中继时带宽由中转方出",
    },
    media: {
      framesSampled, framesDescribed,
      framesSent: call.framesSent ?? 0, framesReceived: call.framesReceived ?? 0,
      sttSeconds: 0, ttsChars: 0,
    },
    tokens: {
      understandingPromptTokens: promptTokens, understandingCompletionTokens: completionTokens,
      understandingCostUsd: cost, understandingUnpriced: unpriced,
      localFrames, localSttSeconds: 0, cloudSttSeconds: 0,
      delegatedTasks: 0, delegationIds: [],
      workTokens: null, workCostUsd: null, workNote: "干活 token 按关联运行记，见 runId",
    },
    recording: {
      allowed, consentedBy: [],
      seconds: null, bytes: null, startedAt: null,
      note: "视频通话只记同意状态（双方都同意才可录制），不记录制时长（无时间戳）",
    },
    runId: call.runId ?? null, summaryRecorded: false, recordingTransitionsRecorded: 0, recordingEventState: "off",
  };
}

function buildSessionEntry(session: SessionRow, home: string, nowIso: string): CallLedgerEntry {
  const members = session.members ?? [];
  const delegations = session.delegations ?? [];
  const consentEvents = readConsentEvents(home, session.id);
  const timeline = reconstructRecordingTimeline(session, consentEvents, nowIso);
  const active = members.filter((m) => m.left_at === null);
  const consentedBy = active.filter((m) => {
    // 该成员最新一次（本次加入之后）的同意事件。
    let consented = false;
    for (const e of consentEvents) {
      if (e.by !== m.identity) continue;
      if (Date.parse(e.at) < Date.parse(m.joined_at)) continue;
      consented = e.consented;
    }
    return consented;
  }).map((m) => m.identity);
  return {
    id: session.id, kind: "session", agent: "self",
    peer: null, participants: members.map((m) => m.identity),
    startedAt: session.created_at, endedAt: session.ended_at ?? null, status: session.status,
    durationSeconds: durationSeconds(session.created_at, session.ended_at ?? null),
    transport: {
      bytesIn: null, bytesOut: null, relayed: null,
      note: "联合会话帧扇出只记指纹，不记字节；传输字节未计量",
    },
    media: {
      framesSampled: 0, framesDescribed: 0, framesSent: 0, framesReceived: 0,
      sttSeconds: 0, ttsChars: 0,
    },
    tokens: {
      understandingPromptTokens: null, understandingCompletionTokens: null,
      understandingCostUsd: null, understandingUnpriced: false,
      localFrames: 0, localSttSeconds: 0, cloudSttSeconds: 0,
      delegatedTasks: delegations.length, delegationIds: delegations.map((d) => d.id),
      workTokens: null, workCostUsd: null, workNote: "干活 token 按委派契约的运行记，见 delegation",
    },
    recording: {
      allowed: timeline.allowed, consentedBy, seconds: timeline.seconds, bytes: null,
      startedAt: timeline.startedAt, note: "录制秒数从同意门状态变迁推导；大小未知（未接真实录制器）",
    },
    runId: null, summaryRecorded: false, recordingTransitionsRecorded: 0, recordingEventState: "off",
  };
}

// ---- 同步与证据链 ----

/** 通话操作单独建一条只记 call_* 事件的运行（与会话/信任圈同款做法）。 */
function recordCallLedgerEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`通话账本：${type}`, "call-ledger", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

/**
 * 从三家来源账本同步通话账本。
 * 已结束的通话第一次同步时记一条 call_summary 纪要事件（只含数字与 id）；
 * 联合会话的录制起止变迁按时间顺序补记 call_recording_started/stopped。
 * 返回新建与更新的条目数。
 */
export function syncCallLedger(home: string, nowIso?: string): { created: number; updated: number } {
  const now = nowIso ?? new Date().toISOString();
  const book = loadCallLedgerBook(home);
  const byId = new Map(book.calls.map((c) => [`${c.kind}:${c.id}`, c]));
  let created = 0;
  let updated = 0;
  const upsert = (fresh: CallLedgerEntry): CallLedgerEntry => {
    const key = `${fresh.kind}:${fresh.id}`;
    const prev = byId.get(key);
    if (!prev) {
      book.calls.push(fresh);
      byId.set(key, fresh);
      created += 1;
      return fresh;
    }
    // 保留证据链状态位，其余按来源重算。
    fresh.summaryRecorded = prev.summaryRecorded;
    fresh.recordingTransitionsRecorded = prev.recordingTransitionsRecorded;
    fresh.recordingEventState = prev.recordingEventState;
    const idx = book.calls.findIndex((c) => `${c.kind}:${c.id}` === key);
    book.calls[idx] = fresh;
    byId.set(key, fresh);
    updated += 1;
    return fresh;
  };
  for (const call of readVoiceCalls(home)) upsert(buildVoiceEntry(call));
  for (const call of readVideoCalls(home)) upsert(buildVideoEntry(call));
  for (const session of readSessions(home)) upsert(buildSessionEntry(session, home, now));
  // 纪要事件：已结束且未记过的通话，记一条。
  for (const entry of book.calls) {
    if (entry.endedAt && !entry.summaryRecorded) {
      const understandingTokens = (entry.tokens.understandingPromptTokens ?? 0) + (entry.tokens.understandingCompletionTokens ?? 0);
      recordCallLedgerEvent(home, "call_summary", {
        call: entry.id, kind: entry.kind,
        duration_seconds: entry.durationSeconds,
        bytes_in: entry.transport.bytesIn, bytes_out: entry.transport.bytesOut,
        frames_sampled: entry.media.framesSampled, stt_seconds: entry.media.sttSeconds,
        understanding_tokens: understandingTokens,
        understanding_cost_usd: entry.tokens.understandingCostUsd,
        recording_seconds: entry.recording.seconds,
      });
      entry.summaryRecorded = true;
    }
  }
  // 录制起止事件：只对联合会话，按时间顺序补记未记过的变迁。
  for (const entry of book.calls) {
    if (entry.kind !== "session") continue;
    const session = readSessions(home).find((s) => s.id === entry.id);
    if (!session) continue;
    const timeline = reconstructRecordingTimeline(session, readConsentEvents(home, session.id), now);
    for (let i = entry.recordingTransitionsRecorded; i < timeline.transitions.length; i++) {
      const tr = timeline.transitions[i];
      if (tr.on) {
        recordCallLedgerEvent(home, "call_recording_started", { call: entry.id, started_at: tr.at });
      } else {
        recordCallLedgerEvent(home, "call_recording_stopped", { call: entry.id, stopped_at: tr.at, seconds: timeline.seconds });
      }
      entry.recordingTransitionsRecorded = i + 1;
    }
    entry.recordingEventState = timeline.allowed ? "on" : "off";
  }
  saveCallLedgerBook(home, book);
  return { created, updated };
}

export function findCallLedgerEntry(home: string, id: string): CallLedgerEntry | null {
  const book = loadCallLedgerBook(home);
  return book.calls.find((c) => c.id === id) ?? null;
}

export interface CallLedgerTotals {
  calls: number;
  byKind: Record<CallLedgerKind, number>;
  durationSeconds: number;
  bytesIn: number | null;
  bytesOut: number | null;
  framesSampled: number;
  framesDescribed: number;
  sttSeconds: number;
  understandingPromptTokens: number | null;
  understandingCompletionTokens: number | null;
  understandingCostUsd: number | null;
  understandingUnpriced: boolean;
  localFrames: number;
  localSttSeconds: number;
  cloudSttSeconds: number;
  delegatedTasks: number;
  recordingSeconds: number | null;
}

export function summarizeCallLedger(home: string): CallLedgerTotals {
  const book = loadCallLedgerBook(home);
  const totals: CallLedgerTotals = {
    calls: book.calls.length,
    byKind: { voice: 0, video: 0, session: 0 },
    durationSeconds: 0, bytesIn: 0, bytesOut: 0,
    framesSampled: 0, framesDescribed: 0, sttSeconds: 0,
    understandingPromptTokens: null, understandingCompletionTokens: null,
    understandingCostUsd: 0, understandingUnpriced: false,
    localFrames: 0, localSttSeconds: 0, cloudSttSeconds: 0,
    delegatedTasks: 0, recordingSeconds: 0,
  };
  let bytesUnknown = false;
  let recordingUnknown = false;
  for (const c of book.calls) {
    totals.byKind[c.kind] += 1;
    totals.durationSeconds += c.durationSeconds ?? 0;
    if (c.transport.bytesIn === null || c.transport.bytesOut === null) bytesUnknown = true;
    else { totals.bytesIn = (totals.bytesIn ?? 0) + c.transport.bytesIn; totals.bytesOut = (totals.bytesOut ?? 0) + c.transport.bytesOut; }
    totals.framesSampled += c.media.framesSampled;
    totals.framesDescribed += c.media.framesDescribed;
    totals.sttSeconds += c.media.sttSeconds;
    if (c.tokens.understandingPromptTokens !== null) totals.understandingPromptTokens = (totals.understandingPromptTokens ?? 0) + c.tokens.understandingPromptTokens;
    if (c.tokens.understandingCompletionTokens !== null) totals.understandingCompletionTokens = (totals.understandingCompletionTokens ?? 0) + c.tokens.understandingCompletionTokens;
    if (c.tokens.understandingCostUsd !== null) totals.understandingCostUsd = (totals.understandingCostUsd ?? 0) + c.tokens.understandingCostUsd;
    if (c.tokens.understandingUnpriced) totals.understandingUnpriced = true;
    totals.localFrames += c.tokens.localFrames;
    totals.localSttSeconds += c.tokens.localSttSeconds;
    totals.cloudSttSeconds += c.tokens.cloudSttSeconds;
    totals.delegatedTasks += c.tokens.delegatedTasks;
    if (c.recording.seconds === null) recordingUnknown = true;
    else totals.recordingSeconds = (totals.recordingSeconds ?? 0) + c.recording.seconds;
  }
  if (bytesUnknown) { totals.bytesIn = null; totals.bytesOut = null; }
  if (recordingUnknown) totals.recordingSeconds = null;
  return totals;
}

// ---- 按人分摊（缺口 40 第二批）----

/** 一人分到的通话账。 */
export interface CallLedgerParticipantShare {
  participant: string;
  calls: number;
  byKind: Record<CallLedgerKind, number>;
  /** 该人实际在通话里的时间（秒）。 */
  durationSeconds: number;
  /** 均摊的理解花费（美元；任一通未计价时为 null）。 */
  understandingCostUsd: number | null;
  /** 均摊的理解 token 数（prompt + completion；语音与会话本来就没有 token，按 0 计）。 */
  understandingTokens: number;
  /** 均摊的云端 STT 秒数。 */
  cloudSttSeconds: number;
  /** 该人同意且在场期间的录制秒数。 */
  recordingSeconds: number | null;
}

function overlapSeconds(aStartMs: number, aEndMs: number, bStartMs: number, bEndMs: number): number {
  const start = Math.max(aStartMs, bStartMs);
  const end = Math.min(aEndMs, bEndMs);
  return end > start ? Math.round((end - start) / 1000) : 0;
}

/** 某成员在某时刻是否已同意录制（本次加入之后的最新一次同意事件说了算）。 */
function memberConsentedAt(events: ConsentEvent[], identity: string, joinedMs: number, atMs: number): boolean {
  let consented = false;
  for (const e of events) {
    const eMs = Date.parse(e.at);
    if (e.by !== identity || eMs < joinedMs || eMs > atMs) continue;
    consented = e.consented;
  }
  return consented;
}

/**
 * 某成员的录制秒数：录制开着的时间段（reconstructRecordingTimeline 的
 * on 区间）里，该成员在场、且该成员当时已同意的部分。
 */
function memberRecordingSeconds(session: SessionRow, consentEvents: ConsentEvent[], identity: string, nowIso: string): number {
  const timeline = reconstructRecordingTimeline(session, consentEvents, nowIso);
  const members = session.members ?? [];
  const member = members.find((m) => m.identity === identity);
  if (!member) return 0;
  const joinedMs = Date.parse(member.joined_at);
  const sessionEndMs = session.ended_at ? Date.parse(session.ended_at) : Date.parse(nowIso);
  const memberEndMs = member.left_at ? Date.parse(member.left_at) : sessionEndMs;
  let seconds = 0;
  let onStart: number | null = null;
  for (const tr of timeline.transitions) {
    const atMs = Date.parse(tr.at);
    if (tr.on) {
      onStart = atMs;
    } else if (onStart !== null) {
      if (memberConsentedAt(consentEvents, identity, joinedMs, onStart)) {
        seconds += overlapSeconds(joinedMs, memberEndMs, onStart, atMs);
      }
      onStart = null;
    }
  }
  // 会话进行中且录制还开着：从最后一次 on 算到现在。
  if (onStart !== null && !session.ended_at) {
    if (memberConsentedAt(consentEvents, identity, joinedMs, onStart)) {
      seconds += overlapSeconds(joinedMs, memberEndMs, onStart, Date.parse(nowIso));
    }
  }
  return seconds;
}

/**
 * 按人拆分的通话账（均摊口径，见 docs/call-ledger.md）：
 * - 费用与 token、云端 STT 秒：整通 ÷ 参与人数平分；费用只有在源头标了
 *   未计价（understandingUnpriced）时分到的才是 null——会话与语音
 *   本来就没有理解 token/费用，null 在这里是“结构上没有”不是“未知”，
 *   按 0 计，不毒化合计；
 * - 时长：各人实际在场的时间（语音/视频按整通；会话按 joined_at→
 *   left_at；进行中的通话按当前时间算）；
 * - 录制：语音 0；视频 null（时长未知）；会话按各人同意且在场的时间。
 */
export function summarizeCallLedgerByParticipant(home: string, nowIso?: string): CallLedgerParticipantShare[] {
  const now = nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const book = loadCallLedgerBook(home);
  const sessionRows = new Map(readSessions(home).map((s) => [s.id, s]));
  const byParticipant = new Map<string, CallLedgerParticipantShare>();
  const row = (participant: string): CallLedgerParticipantShare => {
    let share = byParticipant.get(participant);
    if (!share) {
      share = {
        participant, calls: 0, byKind: { voice: 0, video: 0, session: 0 },
        durationSeconds: 0, understandingCostUsd: 0, understandingTokens: 0,
        cloudSttSeconds: 0, recordingSeconds: 0,
      };
      byParticipant.set(participant, share);
    }
    return share;
  };
  for (const entry of book.calls) {
    const participants = entry.participants;
    if (!participants.length) continue;
    const n = participants.length;
    // 费用：只有源头标了未计价才分到 null；结构上的 null（会话本来就
    // 没有理解费用）按 0 计。
    const costShare = entry.tokens.understandingCostUsd === null && entry.tokens.understandingUnpriced
      ? null : (entry.tokens.understandingCostUsd ?? 0) / n;
    const tokenShare = ((entry.tokens.understandingPromptTokens ?? 0) + (entry.tokens.understandingCompletionTokens ?? 0)) / n;
    const cloudSttShare = entry.tokens.cloudSttSeconds / n;
    for (const participant of participants) {
      const share = row(participant);
      share.calls += 1;
      share.byKind[entry.kind] += 1;
      // 时长：各人实际在场的时间。
      if (entry.kind === "session") {
        const session = sessionRows.get(entry.id);
        const member = session?.members?.find((m) => m.identity === participant);
        if (member) {
          const startMs = Date.parse(session!.created_at);
          const endMs = session!.ended_at ? Date.parse(session!.ended_at) : nowMs;
          share.durationSeconds += overlapSeconds(Date.parse(member.joined_at), member.left_at ? Date.parse(member.left_at) : endMs, startMs, endMs);
        }
      } else {
        const startMs = Date.parse(entry.startedAt);
        const endMs = entry.endedAt ? Date.parse(entry.endedAt) : nowMs;
        share.durationSeconds += overlapSeconds(startMs, endMs, startMs, endMs);
      }
      // 费用与 token：均摊；任一通未计价，分到的费用就是 null。
      if (costShare === null) share.understandingCostUsd = null;
      else if (share.understandingCostUsd !== null) share.understandingCostUsd += costShare;
      share.understandingTokens += tokenShare;
      share.cloudSttSeconds += cloudSttShare;
      // 录制：语音 0；视频 null；会话按各人同意且在场的时间。
      if (entry.kind === "voice") {
        // 语音不录制，分到 0。
      } else if (entry.kind === "video") {
        share.recordingSeconds = null;
      } else {
        const session = sessionRows.get(entry.id);
        if (session && share.recordingSeconds !== null) {
          share.recordingSeconds += memberRecordingSeconds(session, readConsentEvents(home, session.id), participant, now);
        }
      }
    }
  }
  return [...byParticipant.values()].sort((a, b) => (a.participant < b.participant ? -1 : a.participant > b.participant ? 1 : 0));
}

export function formatLedgerSummaryByParticipant(shares: CallLedgerParticipantShare[]): string {
  const lines = [
    "按人分摊（均摊口径：费用与 token 按参与人数平分；时长按各人实际在场时间；录制按各人同意且在场的时间；任一通未计价，分到的就是未计价）",
  ];
  for (const s of shares) {
    const money = s.understandingCostUsd === null ? "未计价" : `$${s.understandingCostUsd.toFixed(4)}`;
    const tokens = `${Math.round(s.understandingTokens)} token`;
    const recording = s.recordingSeconds === null ? "录制时长未知" : `录制 ${formatDuration(s.recordingSeconds)}`;
    lines.push(`${s.participant}：${s.calls} 通（语音 ${s.byKind.voice} · 视频 ${s.byKind.video} · 联合会话 ${s.byKind.session}）· 在场 ${formatDuration(s.durationSeconds)} · 理解 ${tokens} / ${money} · 云端 STT ${formatDuration(Math.round(s.cloudSttSeconds))} · ${recording}`);
  }
  return lines.join("\n");
}

// ---- 展示 ----

export function formatBytes(n: number | null): string {
  if (n === null) return "未计量";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "进行中";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s} 秒`;
  return `${m} 分 ${s} 秒`;
}

function formatMoney(usd: number | null, unpriced: boolean): string {
  if (usd === null) return "未计价";
  return `$${usd.toFixed(4)}${unpriced ? "（有未计价部分，只是下界）" : ""}`;
}

export function formatLedgerLine(entry: CallLedgerEntry): string {
  const understandingTokens = (entry.tokens.understandingPromptTokens ?? 0) + (entry.tokens.understandingCompletionTokens ?? 0);
  const rec = entry.recording.seconds === null ? "录制时长未知" : `录制 ${formatDuration(entry.recording.seconds)}`;
  return `${entry.id} · ${callKindLabel(entry.kind)} · ${entry.kind === "session" ? entry.participants.join("、") : (entry.peer ?? "—")} · ${entry.status} · ${formatDuration(entry.durationSeconds)} · 传输 ${formatBytes(entry.transport.bytesIn)} / ${formatBytes(entry.transport.bytesOut)} · 理解 ${understandingTokens} token / ${formatMoney(entry.tokens.understandingCostUsd, entry.tokens.understandingUnpriced)} · ${rec}`;
}

export function formatLedgerDetail(entry: CallLedgerEntry): string {
  const lines: string[] = [];
  lines.push(`通话 ${entry.id}（${callKindLabel(entry.kind)}）`);
  lines.push(`参与人：${entry.participants.join("、") || "无"}`);
  lines.push(`开始：${entry.startedAt}；结束：${entry.endedAt ?? "进行中"}；时长：${formatDuration(entry.durationSeconds)}；状态：${entry.status}`);
  if (entry.runId) lines.push(`关联运行：${entry.runId}`);
  lines.push(`传输账：入 ${formatBytes(entry.transport.bytesIn)} · 出 ${formatBytes(entry.transport.bytesOut)}${entry.transport.relayed === null ? "" : entry.transport.relayed ? " · 已中继" : " · 直连"}（${entry.transport.note}）`);
  lines.push(`媒体账：采样 ${entry.media.framesSampled} 帧 · 已描述 ${entry.media.framesDescribed} 帧 · 发出 ${entry.media.framesSent} 帧 · 收到 ${entry.media.framesReceived} 帧 · STT ${formatDuration(entry.media.sttSeconds)} · 回读 ${entry.media.ttsChars} 字`);
  const understandingTokens = (entry.tokens.understandingPromptTokens ?? 0) + (entry.tokens.understandingCompletionTokens ?? 0);
  lines.push(`token 账：理解 ${understandingTokens} token（云端 prompt ${entry.tokens.understandingPromptTokens ?? "—"} + completion ${entry.tokens.understandingCompletionTokens ?? "—"}）· 花费 ${formatMoney(entry.tokens.understandingCostUsd, entry.tokens.understandingUnpriced)} · 本地 ${entry.tokens.localFrames} 帧 / STT ${formatDuration(entry.tokens.localSttSeconds)} · 云端 STT ${formatDuration(entry.tokens.cloudSttSeconds)}`);
  lines.push(`干活账：委派 ${entry.tokens.delegatedTasks} 项${entry.tokens.delegationIds.length ? `（${entry.tokens.delegationIds.join("、")}）` : ""} · ${entry.tokens.workNote}`);
  lines.push(`录制账：${entry.recording.allowed ? "全体已同意，可以录制" : "未获全体同意"} · 已同意：${entry.recording.consentedBy.join("、") || "无"} · 录了 ${entry.recording.seconds === null ? "时长未知" : formatDuration(entry.recording.seconds)} · 大小 ${entry.recording.bytes === null ? "未知" : formatBytes(entry.recording.bytes)}（${entry.recording.note}）`);
  lines.push(`纪要：${entry.summaryRecorded ? "已进证据链（call_summary 事件）" : entry.endedAt ? "待同步" : "通话进行中，结束后再记"}`);
  return lines.join("\n");
}

export function formatLedgerSummary(totals: CallLedgerTotals): string {
  const understandingTokens = (totals.understandingPromptTokens ?? 0) + (totals.understandingCompletionTokens ?? 0);
  const lines: string[] = [];
  lines.push(`通话账本汇总：共 ${totals.calls} 通（语音 ${totals.byKind.voice} · 视频 ${totals.byKind.video} · 联合会话 ${totals.byKind.session}）`);
  lines.push(`总时长：${formatDuration(totals.durationSeconds)}`);
  lines.push(`传输：入 ${formatBytes(totals.bytesIn)} · 出 ${formatBytes(totals.bytesOut)}（有未计量项时为未计量）`);
  lines.push(`媒体：采样 ${totals.framesSampled} 帧 · 已描述 ${totals.framesDescribed} 帧 · STT ${formatDuration(totals.sttSeconds)}`);
  lines.push(`理解：${understandingTokens} token（云端）· 花费 ${formatMoney(totals.understandingCostUsd, totals.understandingUnpriced)} · 本地 ${totals.localFrames} 帧 / STT ${formatDuration(totals.localSttSeconds)} · 云端 STT ${formatDuration(totals.cloudSttSeconds)}`);
  lines.push(`干活：会内委派 ${totals.delegatedTasks} 项（干活 token 按关联运行记）`);
  lines.push(`录制：${totals.recordingSeconds === null ? "时长未知（含未计时的视频通话）" : `累计 ${formatDuration(totals.recordingSeconds)}`}`);
  return lines.join("\n");
}

// ---- CLI ----

export const CALL_LEDGER_USAGE = "用法：nyra call <ledger|show <通话 id>|summary [--by-person]> [--json]";

export async function callLedgerMain(argv: string[], home: string): Promise<number> {
  const cmd = argv[0] ?? "ledger";
  const rest = argv.slice(1);
  const hasJson = rest.includes("--json");
  const byPerson = rest.includes("--by-person");
  try {
    if (cmd === "ledger") {
      syncCallLedger(home);
      const book = loadCallLedgerBook(home);
      if (book.calls.length === 0) {
        process.stdout.write("还没有通话记录。\n");
        return 0;
      }
      const sorted = [...book.calls].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 20);
      for (const c of sorted) process.stdout.write(`${formatLedgerLine(c)}\n`);
      return 0;
    }
    if (cmd === "show") {
      const id = rest.find((a) => !a.startsWith("--"));
      if (!id) {
        process.stderr.write("用法：nyra call show <通话 id> [--json]\n");
        return 2;
      }
      syncCallLedger(home);
      const entry = findCallLedgerEntry(home, id);
      if (!entry) {
        process.stderr.write(`找不到通话：${id}\n`);
        return 1;
      }
      if (hasJson) process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      else process.stdout.write(`${formatLedgerDetail(entry)}\n`);
      return 0;
    }
    if (cmd === "summary") {
      syncCallLedger(home);
      if (byPerson) {
        const shares = summarizeCallLedgerByParticipant(home);
        if (hasJson) process.stdout.write(`${JSON.stringify(shares, null, 2)}\n`);
        else process.stdout.write(`${formatLedgerSummaryByParticipant(shares)}\n`);
        return 0;
      }
      const totals = summarizeCallLedger(home);
      if (hasJson) process.stdout.write(`${JSON.stringify(totals, null, 2)}\n`);
      else process.stdout.write(`${formatLedgerSummary(totals)}\n`);
      return 0;
    }
    process.stderr.write(`${CALL_LEDGER_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`通话账本失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
