// src/groupChat.ts — G-P1-2：swarm/handoff + 可组合终止条件（借 AutoGen
// 的终止条件思路：MaxMessages / Mention / TokenBudget / Timeout /
// Handoff / External，只抄机制、不搬实现）。
//
// 群聊有两种跑法，别混淆：
// - groups.ts 的 send：并行轮——一轮里所有被点名的 bot 同时发言；
// - 本模块的 swarm：顺序发言——一次一个 bot 说，说完按规则决定下一个
//   是谁（轮询 / 点名 / 交接），直到终止条件命中。
//
// 发言人选择（mode）：
// - round-robin：按房间里的 bot 顺序轮着说；
// - selector：上一条消息里 @ 了谁就谁说（没 @ 到就轮询）；
// - handoff：说话者在消息里写 HANDOFF: <bot-id> 就把话筒交给那个人
//   （没写就轮询；@ 与 HANDOFF 都认，HANDOFF 优先）。
//
// 终止条件（可 AND/OR 组合，条件本身是纯数据、可序列化进计划）：
// - max-messages：消息到 N 条就停（含开场白）；
// - mention-text：某条消息里出现指定文字就停（如 “DONE”）；
// - token-budget：累计估算 token 到上限就停（估算口径：字符数 / 4，
//   是估算不是实测用量，超了就停、不精确到个位数）；
// - timeout：从开场起超过 N 毫秒就停；
// - handoff：交接给指定 bot 时停（AutoGen 的 HandoffTermination 同款）；
// - external：外部停表（shouldStop 回调，如机主点了停止）；
// - and/or：组合（and 全满足才停，or 任一满足就停）。
// 没给终止条件时默认 max-messages 20（没上限的群聊不能跑，会一直说下去）。
import { GroupStore, type Bot, type RoomMessage } from "./groups.ts";
import { RunStore } from "./runs.ts";
import { resolveNyraHome } from "./memory.ts";
import { join } from "node:path";

export type SpeakerMode = "round-robin" | "selector" | "handoff";

export type TerminationCondition =
  | { kind: "max-messages"; max: number }
  | { kind: "mention-text"; text: string }
  | { kind: "token-budget"; maxTokens: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "handoff"; to: string }
  | { kind: "external" }
  | { kind: "and"; conditions: TerminationCondition[] }
  | { kind: "or"; conditions: TerminationCondition[] };

export interface SwarmState {
  messages: number;
  tokensEstimate: number;
  startedAt: number;
  handoffs: { from: string; to: string }[];
  lastMentionHit: string | null;
}

export interface SwarmTurn {
  speaker: string;
  message: RoomMessage;
}

export interface SwarmResult {
  room: string;
  mode: SpeakerMode;
  turns: SwarmTurn[];
  messages: number;
  tokensEstimate: number;
  terminatedBy: string;
  reason: string;
  /** G-P2-1：被拦截器丢弃的轮次（没进群记录，不计入 messages）。 */
  droppedTurns?: number;
}

export class GroupChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupChatError";
  }
}

/** 估算 token：字符数 / 4（估算口径，不是实测用量；超了就停）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MENTION_RE = /(?<![A-Za-z0-9_])@([a-z][a-z0-9_-]{0,31})/g;
const HANDOFF_RE = /HANDOFF:\s*([a-z][a-z0-9_-]{0,31})/i;

/** 从一条消息里找 @点名（返回第一个被 @ 的 bot id，没有返回 null）。 */
export function mentionedBot(text: string): string | null {
  const m = MENTION_RE.exec(text);
  MENTION_RE.lastIndex = 0;
  return m ? m[1] : null;
}

/** 从一条消息里找交接（HANDOFF: <bot-id>，没有返回 null）。 */
export function handoffTarget(text: string): string | null {
  const m = HANDOFF_RE.exec(text);
  return m ? m[1] : null;
}

function validateCondition(cond: TerminationCondition): void {
  switch (cond.kind) {
    case "max-messages":
      if (!Number.isInteger(cond.max) || cond.max < 1 || cond.max > 1000) {
        throw new GroupChatError("max-messages 须是 1–1000 的整数");
      }
      return;
    case "mention-text":
      if (!cond.text?.trim()) throw new GroupChatError("mention-text 须给非空文字");
      return;
    case "token-budget":
      if (!Number.isInteger(cond.maxTokens) || cond.maxTokens < 1) {
        throw new GroupChatError("token-budget 须是正整数");
      }
      return;
    case "timeout":
      if (!Number.isInteger(cond.timeoutMs) || cond.timeoutMs < 1000) {
        throw new GroupChatError("timeout 须是不小于 1000 的毫秒数");
      }
      return;
    case "handoff":
      if (!cond.to?.trim()) throw new GroupChatError("handoff 终止条件须给目标 bot");
      return;
    case "external":
      return;
    case "and":
    case "or":
      if (!Array.isArray(cond.conditions) || !cond.conditions.length) {
        throw new GroupChatError(`${cond.kind} 组合至少要含一个条件`);
      }
      for (const c of cond.conditions) validateCondition(c);
      return;
    default:
      throw new GroupChatError(`不认的终止条件：${(cond as { kind: string }).kind}`);
  }
}

export function validateTermination(cond: TerminationCondition): void {
  validateCondition(cond);
}

/**
 * 评一个终止条件（纯函数，测试直接验）：返回 { terminated, reason }。
 * external 条件由运行时的 shouldStop 回调判定，这里只认 state 里的标记。
 */
export function evaluateTermination(
  cond: TerminationCondition,
  state: SwarmState,
  opts: { now?: number; externalStop?: boolean } = {},
): { terminated: boolean; reason: string | null } {
  const now = opts.now ?? Date.now();
  switch (cond.kind) {
    case "max-messages":
      return state.messages >= cond.max
        ? { terminated: true, reason: `消息到 ${cond.max} 条（max-messages）` }
        : { terminated: false, reason: null };
    case "mention-text":
      return state.lastMentionHit === cond.text
        ? { terminated: true, reason: `消息里出现“${cond.text}”（mention-text）` }
        : { terminated: false, reason: null };
    case "token-budget":
      return state.tokensEstimate >= cond.maxTokens
        ? { terminated: true, reason: `估算 token 到 ${cond.maxTokens}（token-budget）` }
        : { terminated: false, reason: null };
    case "timeout":
      return now - state.startedAt >= cond.timeoutMs
        ? { terminated: true, reason: `超时 ${cond.timeoutMs} 毫秒（timeout）` }
        : { terminated: false, reason: null };
    case "handoff":
      return state.handoffs.some((h) => h.to === cond.to)
        ? { terminated: true, reason: `已交接给 ${cond.to}（handoff）` }
        : { terminated: false, reason: null };
    case "external":
      return opts.externalStop === true
        ? { terminated: true, reason: "外部叫停（external）" }
        : { terminated: false, reason: null };
    case "and": {
      const results = cond.conditions.map((c) => evaluateTermination(c, state, opts));
      const hit = results.filter((r) => r.terminated);
      return hit.length === cond.conditions.length
        ? { terminated: true, reason: `全部条件满足（and）：${hit.map((r) => r.reason).join("；")}` }
        : { terminated: false, reason: null };
    }
    case "or": {
      for (const c of cond.conditions) {
        const r = evaluateTermination(c, state, opts);
        if (r.terminated) return { terminated: true, reason: `任一条件满足（or）：${r.reason}` };
      }
      return { terminated: false, reason: null };
    }
  }
}

/** 默认终止条件：没给就按 20 条消息停（没上限的群聊不能跑）。 */
export const DEFAULT_TERMINATION: TerminationCondition = { kind: "max-messages", max: 20 };

function recordChatEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`群聊：${type}`, "group-chat", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏群聊本身 */ }
}

export interface RunGroupChatOptions {
  mode?: SpeakerMode;
  termination?: TerminationCondition;
  /** 开场白（机主发的第一句话；不给就直接让第一个 bot 先说）。 */
  kickoff?: string;
  /** 外部停表（机主点了停止就返回 true；每轮发言前查一次）。 */
  shouldStop?: () => boolean;
  /** 测试注入的时钟。 */
  now?: () => number;
  /** 事件回调（不传时写 RunStore）。 */
  emit?: (type: string, fields: Record<string, unknown>) => void;
}

/**
 * 跑一轮 swarm 群聊：顺序发言，一次一个 bot，直到终止条件命中。
 * 每轮发言都落群记录（GroupStore 的房间文件），中途失败的 bot 记一条
 * error 消息、不拖垮整轮（runOneBot 本来就这么处理：失败记 error 消息）。
 */
export async function runGroupChat(
  store: GroupStore,
  roomId: string,
  opts: RunGroupChatOptions = {},
): Promise<SwarmResult> {
  const mode = opts.mode ?? "round-robin";
  if (mode !== "round-robin" && mode !== "selector" && mode !== "handoff") {
    throw new GroupChatError(`发言模式只认 round-robin / selector / handoff，当前是 ${mode}`);
  }
  const termination = opts.termination ?? DEFAULT_TERMINATION;
  validateTermination(termination);
  const nowFn = opts.now ?? Date.now;
  const emit = (type: string, fields: Record<string, unknown>): void => {
    if (opts.emit) {
      try { opts.emit(type, fields); } catch { /* ignore */ }
    } else {
      recordChatEvent(store.home, type, fields);
    }
  };
  const room = store.get(roomId);
  const bots: Bot[] = (room as unknown as { bots: Bot[] }).bots;
  if (bots.length < 2) throw new GroupChatError(`群 ${roomId} 里机器人不到 2 个，swarm 跑不起来`);
  const botIds = bots.map((b) => b.id);
  const state: SwarmState = {
    messages: room.messages.length,
    tokensEstimate: room.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    startedAt: nowFn(),
    handoffs: [],
    lastMentionHit: null,
  };
  emit("group_chat_started", { room: roomId, mode, speakers: botIds.join(",") });
  if (opts.kickoff?.trim()) {
    const kickoff: RoomMessage = { sender: "user", content: opts.kickoff.trim(), time: new Date(nowFn()).toISOString().slice(0, 19) + "+00:00" };
    await store.appendTranscript(roomId, [kickoff]);
    state.messages += 1;
    state.tokensEstimate += estimateTokens(kickoff.content);
  }
  const turns: SwarmTurn[] = [];
  let droppedTurns = 0;
  let nextIndex = 0;
  let lastMessage = room.messages.length ? room.messages[room.messages.length - 1].content : "";
  // 开场就命中终止条件时一轮都不跑（比如 max-messages 比已有消息还小）。
  let end = evaluateTermination(termination, state, { now: nowFn(), externalStop: opts.shouldStop?.() === true });
  while (!end.terminated) {
    // 选下一个发言者：HANDOFF 优先，其次 @点名（selector 模式），最后轮询。
    let speaker: string | null = null;
    if (mode === "handoff" || mode === "selector") {
      const handoff = mode === "handoff" ? handoffTarget(lastMessage) : null;
      if (handoff && botIds.includes(handoff)) {
        speaker = handoff;
        const from = turns.length ? turns[turns.length - 1].speaker : "user";
        state.handoffs.push({ from, to: handoff });
        emit("group_chat_handoff", { room: roomId, from, to: handoff });
      } else if (mode === "selector") {
        const mentioned = mentionedBot(lastMessage);
        if (mentioned && botIds.includes(mentioned)) speaker = mentioned;
      }
    }
    if (!speaker) {
      speaker = botIds[nextIndex % botIds.length];
      nextIndex += 1;
    } else {
      // 被点名/被交接的人说完后，轮询从他后面继续（不重复点同一个人）。
      nextIndex = botIds.indexOf(speaker) + 1;
    }
    // G-P2-1：runOneBot 里 bot 的回复已过拦截器（publish）；被丢弃时返回
    // 空 error 条目（runBot 的失败条目总有正文，空 error 只可能是被丢弃）。
    // 丢弃的轮次不进 turns、不计 messages、不参与点名/交接，但计入硬顶。
    const message = await store.runOneBot(roomId, speaker, {
      emit: (type, fields) => emit(type, fields),
    });
    const dropped = message.error === true && !String(message.content ?? "").trim();
    if (dropped) {
      droppedTurns += 1;
      emit("group_chat_turn_dropped", { room: roomId, speaker });
      lastMessage = "";
    } else {
      turns.push({ speaker, message });
      state.messages += 1;
      state.tokensEstimate += estimateTokens(message.content);
      if (typeof termination === "object" && termination.kind === "mention-text") {
        if (message.content.includes(termination.text)) state.lastMentionHit = termination.text;
      } else if (termination.kind === "or" || termination.kind === "and") {
        // 组合条件里含 mention-text 时同样要盯着每条新消息。
        const checkMention = (c: TerminationCondition): void => {
          if (c.kind === "mention-text" && message.content.includes(c.text)) state.lastMentionHit = c.text;
          if (c.kind === "and" || c.kind === "or") c.conditions.forEach(checkMention);
        };
        checkMention(termination);
      }
      emit("group_chat_turn", { room: roomId, speaker, turn: turns.length });
      lastMessage = message.content;
    }
    end = evaluateTermination(termination, state, { now: nowFn(), externalStop: opts.shouldStop?.() === true });
    // 硬顶：不管条件怎么写，最多 1000 轮（防条件配错导致无限跑；丢弃的轮次也计入）。
    if (turns.length + droppedTurns >= 1000) {
      end = { terminated: true, reason: "硬顶：已到 1000 轮" };
      break;
    }
  }
  const result: SwarmResult = {
    room: roomId,
    mode,
    turns,
    messages: state.messages,
    tokensEstimate: state.tokensEstimate,
    terminatedBy: end.reason ?? "未知",
    reason: end.reason ?? "未知",
    ...(droppedTurns ? { droppedTurns } : {}),
  };
  emit("group_chat_terminated", { room: roomId, reason: result.reason, turns: turns.length });
  return result;
}
