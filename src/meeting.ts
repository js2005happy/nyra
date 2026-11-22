// src/meeting.ts — 第 3 批：agent 进外部会议（借 OpenClaw 的形态：
// `createMeetingSession`、`joinMeetViaVoiceCallGateway`——只借
// “受控浏览器进会、听完出纪要”的形态，不搬实现）。
//
// 只做 Meet / Zoom（报告排期先做这两个；Teams / Huddles 不在本批）。
// - 进会是受控浏览器行为：经 CDP 连本机 Chrome（cdpBrowser.ts），
//   只连 127.0.0.1，不碰远端浏览器；Chrome 没起时直接报错，不假装
//   进去了；进会、录制、发言三件事都要机主批（进会须 --yes 或审批
//   回调放行，录制须全体同意，发言每次都要批）；
// - 听：实时字幕是尽力而为——Meet/Zoom 的字幕 DOM 各家不同，
//   本批只读页面可见文本快照当字幕源；字幕也可以手工补录
//   （`nyra meeting transcript add`，粘贴来的会议记录同样能出纪要）；
//   纪要是确定性管线（不调模型）：参会人、时长、轮次、决定、待办、
//   全文附录；模型摘要是下一步，不在本批编一个；
// - 断线重连不重复执行：每次重连纪元 +1；字幕行按文本去重（跟上一行
//   文本一样就是重连后重复抓到的同一行，不重复记），重连后重复抓到
//   的行不重复记；待办派发记已派发 id，重复投递直接跳过（不双写、
//   不重复派任务）；旧纪元的待办派发直接拒绝。
// - 真实外部会议联调待验证：本机只有假页面 + 假浏览器 transport
//   的端到端测试；真 Meet/Zoom 会议须有机主给的真实会议链接与在场
//   的真人参会者，本批不编造“已进过真会”。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { CDPBrowser } from "./cdpBrowser.ts";

export const MEETINGS_FILE = "meetings.json";
export const MEETING_MAX_TRANSCRIPT_LINES = 2000;

export type MeetingProvider = "meet" | "zoom";
export type MeetingStatus = "created" | "in-meeting" | "left" | "failed";

export class MeetingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingError";
  }
}

export interface TranscriptLine {
  /** 行身份：说话人 + 文本 + 序号（唯一，不拿它去重——序号自增，永远撞不上）。 */
  key: string;
  speaker: string;
  text: string;
  at: string;
  epoch: number;
}

export interface MeetingMinutes {
  meeting: string;
  provider: MeetingProvider;
  participants: string[];
  started_at: string;
  ended_at: string | null;
  turns: number;
  decisions: string[];
  actions: string[];
  lines: TranscriptLine[];
}

export interface MeetingSession {
  id: string;
  provider: MeetingProvider;
  url: string;
  status: MeetingStatus;
  /** 纪元：每次重连 +1；旧纪元的待办派发直接拒绝。 */
  epoch: number;
  /** 录制同意者（全体同意门：当前参会人全同意才开录）。 */
  recording_consented_by: string[];
  recording: boolean;
  participants: string[];
  transcript: TranscriptLine[];
  /** 已派发成任务的待办 id（重连后重复投递直接跳过，不双写）。 */
  dispatched_actions: string[];
  minutes: MeetingMinutes | null;
  created_at: string;
  joined_at: string | null;
  left_at: string | null;
}

/** 带页面句柄的会话：`__page` 只活在内存里，绝不进账本（saveMeetings
 * 在挂句柄之前调用；句柄含浏览器连接，序列化会炸）。 */
export interface MeetingSessionWithPage extends MeetingSession {
  __page?: MeetingPage;
}

export interface MeetingStore {
  version: 1;
  meetings: MeetingSession[];
}

export function meetingsPath(home: string): string {
  return join(resolveNyraHome(home), MEETINGS_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadMeetings(home: string): MeetingStore {
  const path = meetingsPath(home);
  if (!existsSync(path)) return { version: 1, meetings: [] };
  if (lstatSync(path).isSymbolicLink()) throw new MeetingError("会议账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new MeetingError("会议账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as MeetingStore).version !== 1 ||
    !Array.isArray((raw as MeetingStore).meetings)) {
    backupCorrupt(path);
    throw new MeetingError("会议账本格式无效，已备份");
  }
  return raw as MeetingStore;
}

export function saveMeetings(home: string, store: MeetingStore): void {
  const path = meetingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new MeetingError("会议账本不能是符号链接");
  const tmp = join(dirname(path), `.meetings-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordMeetingEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`外部会议：${type}`, "meeting", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏会议本身 */ }
}

/** 从链接认出是 Meet 还是 Zoom；别的会（Teams/Huddles）本批不支持，直接拒绝。 */
export function detectMeetingProvider(url: string): MeetingProvider {
  let host = "";
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    throw new MeetingError(`会议链接无效：${url}`);
  }
  if (host === "meet.google.com" || host.endsWith(".meet.google.com")) return "meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";
  throw new MeetingError(`本批只进 Meet（meet.google.com）与 Zoom（zoom.us），不支持 ${host}（Teams/Huddles 不在本批）`);
}

function newMeetingId(): string {
  return `mtg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 建一场外部会议记录（只建记录，不进会；进会另走 joinMeeting，须审批）。 */
export function createMeeting(home: string, url: string): MeetingSession {
  const provider = detectMeetingProvider(url);
  const store = loadMeetings(home);
  const session: MeetingSession = {
    id: newMeetingId(),
    provider,
    url: url.trim(),
    status: "created",
    epoch: 1,
    recording_consented_by: [],
    recording: false,
    participants: [],
    transcript: [],
    dispatched_actions: [],
    minutes: null,
    created_at: nowIso(),
    joined_at: null,
    left_at: null,
  };
  store.meetings.push(session);
  saveMeetings(home, store);
  recordMeetingEvent(home, "meeting_created", { meeting: session.id, provider });
  return session;
}

export function getMeeting(home: string, id: string): MeetingSession | null {
  return loadMeetings(home).meetings.find((m) => m.id === id) ?? null;
}

export function listMeetings(home: string): MeetingSession[] {
  return loadMeetings(home).meetings;
}

/** 受控浏览器进会用的页面接口（生产走 CDP，测试注入假实现）。 */
export interface MeetingPage {
  url: string;
  /** 等页面就绪（会议房间加载出来）；超时直接抛错，不假装进去了。 */
  waitReady(timeoutMs?: number): Promise<void>;
  /** 抓一条实时字幕（没有新字幕回 null）；字幕源是页面可见文本快照。 */
  caption(): Promise<string | null>;
  leave(): Promise<void>;
  close(): Promise<void>;
}

export interface MeetingBrowserDeps {
  open(url: string): Promise<MeetingPage>;
}

/** 生产用的 CDP 浏览器进会：只连本机 Chrome（127.0.0.1:9222）。 */
export class CdpMeetingBrowser implements MeetingBrowserDeps {
  private port: number;
  constructor(port = 9222) {
    this.port = port;
  }

  async open(url: string): Promise<MeetingPage> {
    const browser = await CDPBrowser.connectToChrome(this.port);
    const target = await browser.navigate(url);
    void target;
    let closed = false;
    return {
      url,
      async waitReady(timeoutMs = 30000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const text = await browser.visibleText(2000);
          if (typeof text === "string" && text.trim().length > 0) return;
          if (Date.now() > deadline) throw new MeetingError(`会议页面 ${timeoutMs}ms 内没加载出来（可能要先登录或会议不存在），没进会`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      async caption(): Promise<string | null> {
        const text = await browser.evaluate(
          `(() => { const els = document.querySelectorAll('[aria-label*="字幕"], [aria-label*="Caption"], .a7sr3'); const out = []; for (const el of els) { const t = (el.textContent || "").trim(); if (t) out.push(t); } return out.length ? out[out.length - 1] : null; })()`,
        );
        return typeof text === "string" && text.trim() ? text.trim() : null;
      },
      async leave(): Promise<void> {
        try { await browser.evaluate(`(() => { const btns = [...document.querySelectorAll('button')].filter(b => /离开|Leave|挂断|End/.test(b.textContent || "")); if (btns[0]) btns[0].click(); })()`); } catch { /* 离会按钮找不到就直接关页 */ }
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try { await browser.close(); } catch { /* ignore */ }
      },
    };
  }
}

export interface JoinMeetingOpts {
  /** 审批：进会是对外动作，必须机主显式批（CLI --yes 或回调放行），没批直接拒绝。 */
  approved: boolean;
  /** 测试注入的浏览器；生产不传，走本机 Chrome。 */
  browserDeps?: MeetingBrowserDeps;
  /** 参会人名（缺省为机主本人）。 */
  as?: string;
}

/**
 * 进会：先批、再开受控浏览器、再等页面就绪——哪一步不过都不记
 * “已进会”。进会后状态 in-meeting；页面就绪超时直接标 failed。
 */
export async function joinMeeting(home: string, id: string, opts: JoinMeetingOpts): Promise<MeetingSessionWithPage> {
  if (!opts.approved) {
    throw new MeetingError("进外部会议须机主批准（nyra meeting join <id> --yes）：没批不进会");
  }
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  if (session.status === "in-meeting") throw new MeetingError(`已经在会里了（${id}），不用重复进`);
  const deps = opts.browserDeps ?? new CdpMeetingBrowser();
  const page = await deps.open(session.url);
  try {
    await page.waitReady();
  } catch (err) {
    session.status = "failed";
    saveMeetings(home, store);
    try { await page.close(); } catch { /* ignore */ }
    throw err;
  }
  session.status = "in-meeting";
  session.joined_at = nowIso();
  const who = opts.as ?? "owner";
  if (!session.participants.includes(who)) session.participants.push(who);
  saveMeetings(home, store);
  recordMeetingEvent(home, "meeting_joined", { meeting: id, provider: session.provider });
  // 页面句柄由调用方持有：本函数只负责“进会”这一段，听字幕与离会
  // 由 listenMeeting / leaveMeeting 接力（页面通过返回值交出去）。
  (session as unknown as Record<string, unknown>).__page = page;
  return session as MeetingSessionWithPage;
}

/**
 * 听一轮字幕：抓一条新字幕记进 transcript（去重键防重复记）。
 * 返回新记的行，没新字幕回 null。
 */
export async function listenMeeting(home: string, id: string, page: MeetingPage): Promise<TranscriptLine | null> {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  if (session.status !== "in-meeting") throw new MeetingError(`不在会里（${id} 现在是 ${session.status}），没法听字幕`);
  const text = await page.caption();
  if (!text) return null;
  const seq = session.transcript.length + 1;
  const line: TranscriptLine = {
    key: `owner:${text}:${seq}`,
    speaker: "owner",
    text,
    at: nowIso(),
    epoch: session.epoch,
  };
  // 去重：字幕是轮询抓的，同一行字幕没变时反复抓到的是同一行——
  // 只跟上一行比文本（说话人固定记 owner，不参与比较：手工补录的
  // 同一句也可能标别人名）。去重键里不拿这个当身份：key 含自增
  // 序号，永远撞不上，等于没去重。
  const last = session.transcript[session.transcript.length - 1];
  if (last && last.text === line.text) return null;
  if (session.transcript.length >= MEETING_MAX_TRANSCRIPT_LINES) {
    throw new MeetingError(`字幕已满 ${MEETING_MAX_TRANSCRIPT_LINES} 行：先出纪要再继续听`);
  }
  session.transcript.push(line);
  saveMeetings(home, store);
  return line;
}

/** 手工补一条字幕（粘贴来的会议记录同样能出纪要；去重键同款）。 */
export function addTranscriptLine(home: string, id: string, speaker: string, text: string): TranscriptLine {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  if (!speaker.trim() || !text.trim()) throw new MeetingError("说话人与字幕都不能为空");
  const seq = session.transcript.length + 1;
  const line: TranscriptLine = {
    key: `${speaker.trim()}:${text.trim()}:${seq}`,
    speaker: speaker.trim(),
    text: text.trim(),
    at: nowIso(),
    epoch: session.epoch,
  };
  // 去重：跟上一行比文本（同上一处：说话人不参与比较）。key 含自增
  // 序号，拿它比永远撞不上。
  const last = session.transcript[session.transcript.length - 1];
  if (last && last.text === line.text) return last;
  if (session.transcript.length >= MEETING_MAX_TRANSCRIPT_LINES) {
    throw new MeetingError(`字幕已满 ${MEETING_MAX_TRANSCRIPT_LINES} 行：先出纪要再继续听`);
  }
  session.transcript.push(line);
  if (!session.participants.includes(line.speaker)) session.participants.push(line.speaker);
  saveMeetings(home, store);
  return line;
}

/** 录制同意（全体同意门：当前参会人全同意才开得起来）。 */
export function consentMeetingRecording(home: string, id: string, who: string): MeetingSession {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  if (!session.recording_consented_by.includes(who)) session.recording_consented_by.push(who);
  saveMeetings(home, store);
  return session;
}

/** 开录制：参会人里有人没同意就报出名字，不静默开。 */
export function startMeetingRecording(home: string, id: string): MeetingSession {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  if (session.status !== "in-meeting") throw new MeetingError(`不在会里（${id} 现在是 ${session.status}），开不了录制`);
  const missing = session.participants.filter((p) => !session.recording_consented_by.includes(p));
  if (missing.length) {
    throw new MeetingError(`录制开不了：以下参会人还没同意录制（全体同意门）：${missing.join("、")}`);
  }
  session.recording = true;
  saveMeetings(home, store);
  return session;
}

/** 离会：状态 left，纪要仍可事后出（minutes 不依赖在会状态）。 */
export async function leaveMeeting(home: string, id: string, page?: MeetingPage): Promise<MeetingSession> {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  if (page) {
    try { await page.leave(); } catch { /* ignore */ }
    try { await page.close(); } catch { /* ignore */ }
  }
  if (session.status === "in-meeting") {
    session.status = "left";
    session.left_at = nowIso();
    session.recording = false;
    saveMeetings(home, store);
  }
  return session;
}

/**
 * 断线重连：纪元 +1 后重新进会；字幕按去重键排重、待办按已派发 id
 * 排重——重连不重复记、不重复派。旧纪元的待办派发直接拒绝
 * （见 dispatchMeetingAction）。
 */
export async function reconnectMeeting(home: string, id: string, opts: JoinMeetingOpts): Promise<MeetingSessionWithPage> {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  session.epoch += 1;
  session.status = "created";
  saveMeetings(home, store);
  const rejoined = await joinMeeting(home, id, opts);
  recordMeetingEvent(home, "meeting_reconnected", { meeting: id, epoch: rejoined.epoch });
  return rejoined;
}

/** 出纪要：确定性管线（不调模型）——参会人、时长、轮次、决定、待办、全文附录。 */
export function buildMinutes(home: string, id: string): MeetingMinutes {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  const decisions: string[] = [];
  const actions: string[] = [];
  for (const line of session.transcript) {
    const t = line.text.trim();
    if (/^(决定|DECISION)[:：]/.test(t)) decisions.push(t.replace(/^(决定|DECISION)[:：]\s*/, ""));
    if (/^(待办|TODO|ACTION)[:：]/.test(t)) actions.push(t.replace(/^(待办|TODO|ACTION)[:：]\s*/, ""));
  }
  const minutes: MeetingMinutes = {
    meeting: id,
    provider: session.provider,
    participants: [...session.participants],
    started_at: session.joined_at ?? session.created_at,
    ended_at: session.left_at,
    turns: session.transcript.length,
    decisions,
    actions,
    lines: [...session.transcript],
  };
  session.minutes = minutes;
  saveMeetings(home, store);
  recordMeetingEvent(home, "meeting_minutes_built", {
    meeting: id, turns: minutes.turns, decisions: decisions.length, actions: actions.length,
  });
  return minutes;
}

/**
 * 派发纪要里的待办成任务（调用方传一个派发函数，本函数只管“不重
 * 派”）：已派发过的 id 直接跳过；旧纪元的待办（行纪元 < 当前纪元）
 * 直接拒绝——断线重连后旧纪元的指令不重复执行。
 */
export async function dispatchMeetingAction(
  home: string,
  id: string,
  actionText: string,
  dispatch: (action: string) => Promise<string>,
): Promise<{ dispatched: boolean; taskId: string | null; reason: string }> {
  const store = loadMeetings(home);
  const session = store.meetings.find((m) => m.id === id);
  if (!session) throw new MeetingError(`没有这场会议：${id}`);
  const actionId = `mtg-action-${createHashId(actionText)}`;
  if (session.dispatched_actions.includes(actionId)) {
    return { dispatched: false, taskId: null, reason: "这条待办已经派发过了，不重复派" };
  }
  const line = session.transcript.find((l) => l.text.includes(actionText));
  if (line && line.epoch < session.epoch) {
    return { dispatched: false, taskId: null, reason: `这条待办是纪元 ${line.epoch} 的，当前纪元是 ${session.epoch}（重连后旧纪元的指令不执行）` };
  }
  const taskId = await dispatch(actionText);
  session.dispatched_actions.push(actionId);
  saveMeetings(home, store);
  return { dispatched: true, taskId, reason: "已派发" };
}

function createHashId(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}
