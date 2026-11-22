// src/timeline.ts — 缺口 21：多 agent 执行时间线 + 会话回放（只读）。
// 时间线从已有证据拼出来，不另起一套日志：state.json（任务/状态/用量摘要）
// + events.jsonl（turn/工具/委派/验收/审批/模型切换……）。回放与导出都是
// 纯函数：只读事件，不重新执行任何工具调用、不花 token、不改文件。
// 事件里只记元数据（不记 prompt 全文、不记令牌、不记绝对路径）；渲染时
// 自由文本再过一次 redact，防旧事件里漏网的敏感串。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RunStore, computeRunStats, redact } from "./runs.ts";

export type TimelineStepKind =
  | "run" | "turn" | "llm" | "tool" | "delegate" | "verdict" | "approval" | "model" | "verify" | "event";

export interface TimelineStep {
  index: number;
  at: string;
  offsetMs: number | null;
  turn: number;
  kind: TimelineStepKind;
  title: string;
  detail: string | null;
  ok: boolean | null;
  durationMs: number | null;
}

export interface Timeline {
  runId: string;
  task: string;
  status: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  turns: number;
  llmCalls: number | null;
  toolCalls: number;
  toolErrors: number;
  runErrors: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  spentUsd: number | null;
  delegateSpentUsd: number | null;
  steps: TimelineStep[];
  eventsTotal: number;
  /** 当前阶段（DSH-5 工单阶段表）：等谁、等什么，只记元数据。 */
  stage: RunStageInfo;
}

export type RunStage = "working" | "waiting-answer" | "waiting-review" | "blocked" | "idle";

/** 工单当前阶段：等谁、等什么（只记元数据，不记 prompt/回答/绝对路径）。 */
export interface RunStageInfo {
  stage: RunStage;
  label: string;
  waitingOn: string | null;
  waitingFor: string | null;
}

/** 失败步骤摘要：时间线阶段表与回归测例库共用的失败口径（只记元数据）。 */
export interface FailedStepSummary {
  kind: "tool" | "delegate" | "verdict" | "llm" | "run";
  label: string;
  detail: string | null;
}

export function failedStepSummaries(tl: Timeline): FailedStepSummary[] {
  const out: FailedStepSummary[] = [];
  for (const s of tl.steps) {
    if (s.ok !== false) continue;
    const kind: FailedStepSummary["kind"] =
      s.kind === "tool" ? "tool"
      : s.kind === "delegate" ? "delegate"
      : s.kind === "verdict" ? "verdict"
      : s.kind === "llm" ? "llm"
      : "run";
    out.push({ kind, label: s.title, detail: s.detail });
  }
  return out;
}

export interface StageInputs {
  status: string;
  approvalsPending: string[];
  delegatesPending: string[];
  toolsPending: string[];
  lastFailureTitle: string | null;
}

const TERMINAL_STATUSES = new Set(["verified", "completed_unverified", "failed", "interrupted", "incomplete", "verify_failed"]);

/** 阶段判定（纯函数）：等审批 > 卡住 > 等人工审阅 > 进行中 > 空闲。
 * 注意状态词用 runs.ts 的真值：完成态只有 verified（已验证）与
 * completed_unverified（跑完了但没证据），没有裸的 "completed"
 *（setStatus("completed") 会抛“运行状态无效”）。等审阅就是
 * completed_unverified 本身——状态已编码“跑完未验证”，不必再看末次
 * 验收结论（verifier_verdict 也会由委派子任务发出，对运行级阶段是误导信号）。 */
export function deriveRunStage(input: StageInputs): RunStageInfo {
  if (input.approvalsPending.length > 0) {
    return { stage: "waiting-answer", label: "等回答", waitingOn: "审批人", waitingFor: `审批 ${input.approvalsPending.join("、")}` };
  }
  if (input.status === "failed" || input.status === "interrupted" || input.status === "verify_failed" || input.status === "incomplete") {
    return { stage: "blocked", label: "已卡住", waitingOn: null, waitingFor: input.lastFailureTitle ?? `运行状态 ${input.status}` };
  }
  if (input.status === "completed_unverified") {
    return { stage: "waiting-review", label: "等审阅", waitingOn: "审阅者", waitingFor: "跑完了但没有验证证据，需人工逐项批" };
  }
  if (input.delegatesPending.length > 0) {
    return { stage: "working", label: "进行中", waitingOn: `子任务 ${input.delegatesPending.join("、")}`, waitingFor: "未结束" };
  }
  if (input.toolsPending.length > 0) {
    return { stage: "working", label: "进行中", waitingOn: null, waitingFor: `工具 ${input.toolsPending.join("、")} 无结果` };
  }
  if (input.status === "awaiting_approval") {
    return { stage: "waiting-answer", label: "等回答", waitingOn: "审批人", waitingFor: "等待审批" };
  }
  if (input.status === "verified") {
    return { stage: "idle", label: "空闲（无待办）", waitingOn: null, waitingFor: null };
  }
  return { stage: "working", label: "进行中", waitingOn: null, waitingFor: null };
}

/** 阶段一行：标签 +（等谁：等什么），没在等谁时只写标签。 */
export function stageDisplay(stage: RunStageInfo): string {
  if (stage.waitingOn && stage.waitingFor) return `${stage.label}（等${stage.waitingOn}：${stage.waitingFor}）`;
  if (stage.waitingOn) return `${stage.label}（等${stage.waitingOn}）`;
  if (stage.waitingFor) return `${stage.label}（${stage.waitingFor}）`;
  return stage.label;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "未知";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "??:??:??";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatOffset(ms: number | null): string {
  if (ms === null) return "";
  return ` +${formatDurationMs(ms)}`;
}

function formatUsd(v: number | null): string {
  return v === null ? "未知" : `$${v.toFixed(4)}`;
}

function formatTokens(v: number | null): string {
  return v === null ? "未知" : String(v);
}

function safeText(v: unknown): string {
  return redact(v) ?? "";
}

/** 事件里挑几个关键字段拼成一行（跳过 args_hash：指纹不进正文）。 */
function kvLine(ev: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (k === "at" || k === "type" || k === "args_hash") continue;
    if (typeof v === "string") parts.push(`${k}=${safeText(v)}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
  }
  return parts.length ? parts.join("、") : null;
}

export function buildTimeline(store: RunStore, runId: string): Timeline {
  const state = store.load(runId);
  const stats = computeRunStats(store, runId, state);
  const rawEvents = store.readEvents(runId);
  // 按时间稳定排序（同时间戳保文件顺序）；缺 at 的事件按创建时间算。
  const indexed = rawEvents.map((ev, i) => ({ ev, i }));
  indexed.sort((a, b) => {
    const ta = str(a.ev.at) ?? state.created_at;
    const tb = str(b.ev.at) ?? state.created_at;
    return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
  });
  const createdMs = Date.parse(state.created_at);
  const offsetOf = (at: string): number | null => {
    const t = Date.parse(at);
    return Number.isFinite(t) && Number.isFinite(createdMs) ? Math.max(0, t - createdMs) : null;
  };

  const steps: TimelineStep[] = [];
  const pendingTools = new Map<string, TimelineStep>();
  const pendingDelegates = new Map<string, TimelineStep>();
  // 阶段表要的原始信号（与步骤配对无关，只看事件本身有没有闭合）。
  const pendingApprovals = new Map<string, string>();
  const pendingToolNames = new Map<string, string>();
  let turn = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let runErrors = 0;

  const push = (at: string, kind: TimelineStepKind, title: string, detail: string | null, ok: boolean | null, durationMs: number | null): TimelineStep => {
    const step: TimelineStep = { index: 0, at, offsetMs: offsetOf(at), turn, kind, title, detail, ok, durationMs };
    steps.push(step);
    return step;
  };

  for (const { ev } of indexed) {
    const at = str(ev.at) ?? state.created_at;
    const type = str(ev.type) ?? "event";
    switch (type) {
      case "run_started":
        push(at, "run", "运行开始", null, null, null);
        break;
      case "resumed":
        push(at, "run", `续跑（第 ${num(ev.turn) ?? "?"} 轮，中断前 ${num(ev.interrupted_tool_calls) ?? 0} 次工具调用未完成）`, null, null, null);
        break;
      case "turn": {
        const n = num(ev.turn) ?? turn + 1;
        turn = n;
        push(at, "turn", `第 ${n} 轮开始`, null, null, null);
        break;
      }
      case "llm_span": {
        const model = str(ev.model) ?? "未知模型";
        const ok = bool(ev.ok);
        const pt = num(ev.prompt_tokens);
        const ct = num(ev.completion_tokens);
        const tt = num(ev.total_tokens);
        const detail = `耗时 ${formatDurationMs(num(ev.duration_ms))} · prompt ${formatTokens(pt)} / completion ${formatTokens(ct)} / 合计 ${formatTokens(tt)}`;
        push(at, "llm", `模型调用 ${model}${ok === false ? "（失败）" : ""}`, detail, ok, num(ev.duration_ms));
        break;
      }
      case "vision_input": {
        const count = num(ev.count) ?? 0;
        const kinds = str(ev.kinds) ?? "";
        const model = str(ev.model) ?? "未知模型";
        push(at, "event", `看了 ${count} 张图（${model}）`, kinds ? `来源：${kinds}` : null, null, null);
        break;
      }
      case "voice_input": {
        const seconds = num(ev.seconds);
        const chars = num(ev.chars) ?? 0;
        const engine = str(ev.engine) ?? "未知引擎";
        const cost = num(ev.cost_usd);
        push(at, "event", `语音转写（${engine}）`, `${seconds !== null ? `${seconds} 秒 · ` : ""}${chars} 字${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "voice_speak": {
        const chars = num(ev.chars) ?? 0;
        const engine = str(ev.engine) ?? "未知引擎";
        const cost = num(ev.cost_usd);
        push(at, "event", `语音回读（${engine}）`, `${chars} 字${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "voice_call_started": {
        const peer = str(ev.peer) ?? "本机回环";
        push(at, "event", `语音通话建立（呼叫 ${peer}）`, null, null, null);
        break;
      }
      case "voice_call_answered": {
        push(at, "event", "语音通话已接听", null, null, null);
        break;
      }
      case "voice_call_declined": {
        push(at, "event", "语音通话被拒绝", null, null, null);
        break;
      }
      case "voice_call_ended": {
        const seconds = num(ev.duration_seconds);
        const segments = num(ev.segments) ?? 0;
        const cost = num(ev.cost_usd);
        const held = num(ev.held) ?? 0;
        push(at, "event", "语音通话结束", `${seconds !== null ? `${seconds} 秒 · ` : ""}${segments} 段${held > 0 ? ` · ${held} 段待确认` : ""}${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "voice_call_transcribed": {
        const vad = str(ev.vad) ?? "";
        const seconds = num(ev.seconds);
        const chars = num(ev.chars) ?? 0;
        const engine = str(ev.engine) ?? "";
        if (vad === "silence") {
          push(at, "event", "通话段落：静音，已跳过", null, null, null);
        } else {
          const cost = num(ev.cost_usd);
          push(at, "event", `通话转写（${engine || "未知引擎"}）`, `${seconds !== null ? `${seconds} 秒 · ` : ""}${chars} 字${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        }
        break;
      }
      case "voice_call_spoken": {
        const chars = num(ev.chars) ?? 0;
        const engine = str(ev.engine) ?? "未知引擎";
        const cost = num(ev.cost_usd);
        push(at, "event", `通话回读（${engine}）`, `${chars} 字${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "voice_call_blocked": {
        const reason = str(ev.reason) ?? "";
        push(at, "event", `通话段落被扣下（${reason === "payment" ? "支付类" : reason === "external_send" ? "对外发送类" : "敏感意图"}，须文字确认）`, null, false, null);
        break;
      }
      case "voice_call_confirmed": {
        const reason = str(ev.reason) ?? "";
        push(at, "event", `通话段落已确认（${reason === "payment" ? "支付类" : reason === "external_send" ? "对外发送类" : "敏感意图"}，含义已确认，未执行）`, null, null, null);
        break;
      }
      case "video_call_started": {
        const peer = str(ev.peer);
        push(at, "event", `视频通话开始${peer ? `（对方 ${peer}）` : "（本机回环）"}，传输 ${str(ev.transport) ?? "webrtc"}`, null, false, null);
        break;
      }
      case "video_call_answered": {
        push(at, "event", "视频通话已接听", null, false, null);
        break;
      }
      case "video_call_declined": {
        push(at, "event", "视频通话被拒绝", null, false, null);
        break;
      }
      case "video_call_ended": {
        const frames = num(ev.frames) ?? 0;
        const cost = typeof ev.cost_usd === "number" ? `，看花费 $${ev.cost_usd.toFixed(4)}` : "";
        push(at, "event", `视频通话结束（时长 ${num(ev.duration_seconds) ?? 0} 秒，看了 ${frames} 帧${cost}）`, null, false, null);
        break;
      }
      case "video_call_transport_connected": {
        push(at, "event", `视频传输已连通（${str(ev.ice_pair) ?? ""}${ev.relayed === true ? "，经 TURN 中转" : ""}，往返 ${num(ev.rtt_ms) ?? 0}ms）`, null, false, null);
        break;
      }
      case "video_call_transport_failed": {
        push(at, "event", `视频传输失败（${str(ev.reason) ?? ""}）`, null, false, null);
        break;
      }
      case "video_frame_sampled": {
        const cost = typeof ev.cost_usd === "number" ? `，$${ev.cost_usd.toFixed(4)}` : "";
        push(at, "event", `视频帧已看（${str(ev.mode) ?? "on-demand"} 档，${str(ev.engine) ?? "本地"}${cost}）`, null, false, null);
        break;
      }
      case "video_frame_blocked": {
        const reason = str(ev.reason) ?? "";
        push(at, "event", `视频帧被扣下（${reason === "payment" ? "支付类" : reason === "external_send" ? "对外发送类" : "敏感意图"}，须文字确认）`, null, false, null);
        break;
      }
      case "video_frame_confirmed": {
        const reason = str(ev.reason) ?? "";
        push(at, "event", `视频帧已确认（${reason === "payment" ? "支付类" : reason === "external_send" ? "对外发送类" : "敏感意图"}，含义已确认，未执行）`, null, null, null);
        break;
      }
      case "video_frame_skipped": {
        push(at, "event", `视频帧已跳过（${str(ev.mode) ?? ""} 档，${str(ev.reason) ?? "未到采样条件"}，没看、没花钱）`, null, false, null);
        break;
      }
      case "video_frame_sent": {
        push(at, "event", `视频帧已发（${num(ev.bytes) ?? 0} 字节）`, null, false, null);
        break;
      }
      case "video_frame_received": {
        push(at, "event", `收到对方一帧（${num(ev.bytes) ?? 0} 字节，已存 inbox）`, null, false, null);
        break;
      }
      case "video_call_degraded": {
        push(at, "event", "网络较弱，已自动切到仅语音（协作与 agent 不受影响）", null, false, null);
        break;
      }
      case "video_call_restored": {
        push(at, "event", "网络恢复，视频已回来", null, false, null);
        break;
      }
      case "office_exported": {
        const format = str(ev.format) ?? "未知格式";
        const bytes = num(ev.bytes) ?? 0;
        const verified = num(ev.verified) ?? 0;
        const unverified = num(ev.unverified) ?? 0;
        push(at, "event", `导出办公成品（${format}）`, `${bytes} 字节 · 事实核查：${verified} 项已核实，${unverified} 项未核实`, null, null);
        break;
      }
      case "media_ingested": {
        const host = str(ev.host) ?? "未知来源";
        const source = str(ev.source) ?? "未知来源";
        const seconds = num(ev.duration_seconds);
        const bytes = num(ev.bytes) ?? 0;
        const cost = num(ev.cost_usd);
        push(at, "event", `抓取媒体转写（${host} · ${source}）`, `${seconds !== null ? `${seconds} 秒 · ` : ""}${bytes} 字节 · 转写来源：${source}${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "peer_asked": {
        const peer = str(ev.peer) ?? "未知对端";
        const ok = bool(ev.ok);
        const hash = str(ev.question_hash);
        push(at, "event", `问对端 ${peer}${ok === false ? "（失败）" : "（已答复）"}`, hash ? `问题指纹 ${hash.slice(0, 12)}…` : null, ok, null);
        break;
      }
      case "peer_handoff": {
        const peer = str(ev.peer) ?? "未知对端";
        const status = str(ev.status) ?? "?";
        const peerRun = str(ev.peer_run_id) ?? "";
        push(at, "event", `交接给对端 ${peer}（${status}）`, peerRun ? `对端运行 ${peerRun}` : null, status === "accepted", null);
        break;
      }
      case "friend_requested": {
        const peer = str(ev.peer) ?? "未知对端";
        push(at, "event", `发好友请求给 ${peer}`, null, null, null);
        break;
      }
      case "friend_request_received": {
        const peer = str(ev.peer) ?? "未知对端";
        push(at, "event", `收到 ${peer} 的好友请求`, null, null, null);
        break;
      }
      case "friend_accepted": {
        const peer = str(ev.peer) ?? "未知对端";
        const circle = str(ev.circle) ?? "default";
        const tier = str(ev.tier) ?? "readonly";
        push(at, "event", `批准 ${peer} 为好友（${circle} 圈 · ${tier === "readonly" ? "只读" : "可提议修改"}）`, null, null, null);
        break;
      }
      case "friend_declined": {
        const peer = str(ev.peer) ?? "未知对端";
        push(at, "event", `拒绝 ${peer} 的好友请求`, null, null, null);
        break;
      }
      case "friend_blocked": {
        const peer = str(ev.peer) ?? "未知对端";
        push(at, "event", `拉黑好友 ${peer}`, null, null, null);
        break;
      }
      case "friend_unblocked": {
        const peer = str(ev.peer) ?? "未知对端";
        push(at, "event", `取消拉黑 ${peer}`, null, null, null);
        break;
      }
      case "friend_removed": {
        const peer = str(ev.peer) ?? "未知对端";
        push(at, "event", `删除好友 ${peer}`, null, null, null);
        break;
      }
      case "friend_code_regenerated": {
        push(at, "event", "好友码已重生成", null, null, null);
        break;
      }
      case "circle_created": {
        push(at, "event", `信任圈 ${str(ev.circle) ?? "?"} 已建（由 ${str(ev.by) ?? "机主"}）`, null, null, null);
        break;
      }
      case "circle_deleted": {
        push(at, "event", `信任圈 ${str(ev.circle) ?? "?"} 已删`, null, null, null);
        break;
      }
      case "circle_invited": {
        push(at, "event", `${str(ev.peer) ?? "?"} 已引进 ${str(ev.circle) ?? "?"} 圈（由 ${str(ev.by) ?? "机主"} 经 ${str(ev.channel) ?? "cli"} 引进）`, null, null, null);
        break;
      }
      case "circle_revoked": {
        push(at, "event", `${str(ev.peer) ?? "?"} 已从 ${str(ev.circle) ?? "?"} 圈撤销`, null, null, null);
        break;
      }
      case "circle_binding_set": {
        push(at, "event", `渠道发件人已绑定：${str(ev.channel) ?? "?"} / ${str(ev.sender) ?? "?"} → ${str(ev.identity) ?? "?"}`, null, null, null);
        break;
      }
      case "onboarding_completed": {
        push(at, "event", `入职完成：${str(ev.agent) ?? "?"}（角色 ${str(ev.role) ?? "?"}${str(ev.template) ? `，模板 ${str(ev.template)}` : ""}）`, null, null, null);
        break;
      }
      case "onboarding_template_applied": {
        push(at, "event", `角色模板已应用：${str(ev.agent) ?? "?"} 用了 ${str(ev.template) ?? "?"}`, null, null, null);
        break;
      }
      case "onboarding_ready_briefing": {
        push(at, "event", `就绪简报已发：${str(ev.agent) ?? "?"}（${str(ev.channel) ?? "?"}）`, null, null, null);
        break;
      }
      case "session_created": {
        push(at, "event", `联合会话已建：${str(ev.session) ?? "?"}（${str(ev.title) ?? "?"}，由 ${str(ev.by) ?? "机主"}创建）`, null, null, null);
        break;
      }
      case "session_joined": {
        push(at, "event", `${str(ev.peer) ?? "?"} 已进联合会话 ${str(ev.session) ?? "?"}`, null, null, null);
        break;
      }
      case "session_left": {
        push(at, "event", `${str(ev.peer) ?? "?"} 已离开联合会话 ${str(ev.session) ?? "?"}`, null, null, null);
        break;
      }
      case "session_ended": {
        push(at, "event", `联合会话 ${str(ev.session) ?? "?"} 已结束（由 ${str(ev.by) ?? "机主"}结束，帧记录已清空）`, null, null, null);
        break;
      }
      case "session_delegated": {
        push(at, "event", `会内委派：${str(ev.from) ?? "?"} 委派给 ${str(ev.to) ?? "?"}（委派 ${str(ev.delegation) ?? "?"}，契约 ${str(ev.contract) ?? "?"}，交付 ${str(ev.delivery) ?? "?" }）`, null, null, null);
        break;
      }
      case "session_delegation_accepted": {
        push(at, "event", `委派 ${str(ev.delegation) ?? "?"} 已接下（${str(ev.by) ?? "?"}）`, null, null, null);
        break;
      }
      case "session_delegation_completed": {
        push(at, "event", `委派 ${str(ev.delegation) ?? "?"} 已交活（${str(ev.by) ?? "?"}）`, null, null, null);
        break;
      }
      case "session_shared": {
        push(at, "event", `会内共享：${str(ev.from) ?? "?"} 共享了 ${str(ev.items) ?? "?"} 项（${str(ev.kind) ?? "?"}）`, null, null, null);
        break;
      }
      case "session_recording_consented": {
        push(at, "event", `${str(ev.by) ?? "?"} ${ev.consented === true ? "同意" : "撤回同意"}录制（会话 ${str(ev.session) ?? "?"}）`, null, null, null);
        break;
      }
      case "call_summary": {
        push(at, "event", `通话纪要：${str(ev.call) ?? "?"}（${str(ev.kind) ?? "?"}）· ${str(ev.duration_seconds) ?? "?"} 秒 · 理解 ${str(ev.understanding_tokens) ?? "?"} token · 录制 ${str(ev.recording_seconds) ?? "?"} 秒`, null, null, null);
        break;
      }
      case "call_recording_started": {
        push(at, "event", `通话 ${str(ev.call) ?? "?"} 开始录制（${str(ev.started_at) ?? "?"}）`, null, null, null);
        break;
      }
      case "call_recording_stopped": {
        push(at, "event", `通话 ${str(ev.call) ?? "?"} 停止录制（${str(ev.stopped_at) ?? "?"}，共 ${str(ev.seconds) ?? "?"} 秒）`, null, null, null);
        break;
      }
      case "subagent_stop_requested": {
        const by = str(ev.by) ?? "未记发起人";
        const step = str(ev.step) ?? "";
        push(at, "event", `子 agent ${str(ev.run_id) ?? "?"} 已请求停止（${by} 发起）`, step ? `停在：${step.slice(0, 60)}` : null, null, null);
        break;
      }
      case "subagent_stopped": {
        const by = str(ev.by) ?? "未记发起人";
        const step = str(ev.step) ?? "";
        push(at, "event", `子 agent ${str(ev.run_id) ?? "?"} 已确认停下（${by} 确认）`, step ? `停在：${step.slice(0, 60)}` : null, null, null);
        break;
      }
      case "subagent_stop_cancelled": {
        const by = str(ev.by) ?? "未记发起人";
        push(at, "event", `子 agent ${str(ev.run_id) ?? "?"} 的停止请求已取消（${by}）`, null, null, null);
        break;
      }
      case "subagent_steer_queued": {
        const by = str(ev.by) ?? "未记发起人";
        const text = str(ev.text) ?? "";
        push(at, "event", `子 agent ${str(ev.run_id) ?? "?"} 收到引导（${by} 排队）`, text ? `引导：${text.slice(0, 60)}` : null, null, null);
        break;
      }
      case "subagent_steer_consumed": {
        const by = str(ev.by) ?? "未记发起人";
        push(at, "event", `子 agent ${str(ev.run_id) ?? "?"} 已消费引导（${by}）`, null, null, null);
        break;
      }
      case "merge_started":
        push(at, "delegate", `合并步开始：${num(ev.threads) ?? "?"} 个线程 → 一份${str(ev.format) === "plan" ? "计划" : str(ev.format) === "file" ? "文件" : "报告"}`, null, null, null);
        break;
      case "merge_finished": {
        const verified = bool(ev.verified);
        const checks = `检查 ${num(ev.checks_passed) ?? "?"} 通过 / ${num(ev.checks_failed) ?? "?"} 未通过`;
        push(at, "verdict", `合并完成：${verified === true ? "确定性检查全过" : verified === false ? "确定性检查未通过" : "未知"}`, `${checks}${str(ev.review_item_id) ? ` · 审阅 ${str(ev.review_item_id)}` : ""}`, verified, null);
        break;
      }
      case "fanout_started":
        push(at, "delegate", `后台扇出开始：${str(ev.fanout_id) ?? "?"}（${num(ev.tasks) ?? "?"} 个子任务，后台跑，等回填）`, null, null, null);
        break;
      case "fanout_finished": {
        const status = str(ev.status) ?? "?";
        const label = status === "done" ? "已完成" : status === "partial" ? "部分完成" : status === "failed" ? "失败" : status;
        push(at, "delegate", `后台扇出 ${str(ev.fanout_id) ?? "?"}${label}：成功 ${num(ev.succeeded) ?? "?"} / 失败 ${num(ev.failed) ?? "?"}`, null, status === "done" ? true : status === "failed" ? false : null, null);
        break;
      }
      case "fanout_backfilled":
        push(at, "event", `后台扇出 ${str(ev.fanout_id) ?? "?"} 已回填（${str(ev.kind) === "per-group" ? "逐个回 + 汇总" : "单条回填"}）`, null, null, null);
        break;
      case "fanout_interrupted":
        push(at, "event", `后台扇出 ${str(ev.fanout_id) ?? "?"} 已中断`, safeText(ev.reason) || null, false, null);
        break;
      case "goal_created":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 已建`, null, null, null);
        break;
      case "goal_item_added":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 加了一项清单`, str(ev.item_id) ? `清单项 ${str(ev.item_id)}` : null, null, null);
        break;
      case "goal_item_started":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 的清单项已开工`, str(ev.item_id) ? `清单项 ${str(ev.item_id)}` : null, null, null);
        break;
      case "goal_item_verified": {
        const passed = bool(ev.passed);
        push(at, "verdict", `目标 ${str(ev.goal_id) ?? "?"} 的清单项验证${passed === true ? "通过" : passed === false ? "未通过" : "未知"}`, str(ev.method) ? `方法：${str(ev.method)}` : null, passed, null);
        break;
      }
      case "goal_completed":
        push(at, "verdict", `目标 ${str(ev.goal_id) ?? "?"} 已完成（清单 ${num(ev.items) ?? "?"} 项全过）`, null, true, null);
        break;
      case "goal_paused":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 已暂停`, null, null, null);
        break;
      case "goal_resumed": {
        const reset = num(ev.reset_items);
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 已恢复`, reset !== null && reset > 0 ? `${reset} 项证据失效退回待做` : "已验证项重核全过", null, null);
        break;
      }
      case "goal_cancelled":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 已取消`, null, false, null);
        break;
      case "goal_instruction_added":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 追加了一条指令`, null, null, null);
        break;
      case "goal_item_linked":
        push(at, "event", `目标 ${str(ev.goal_id) ?? "?"} 的清单项已关联任务板任务`, str(ev.task_id) ? `任务 ${str(ev.task_id)}` : null, null, null);
        break;
      case "trust_registered":
        push(at, "event", `${str(ev.kind) ?? "?"} ${str(ev.subject_id) ?? "?"} 已登记进信任阶梯`, `起步 ${str(ev.level) ?? "?"}级`, null, null);
        break;
      case "trust_evidence_recorded":
        push(at, "event", `${str(ev.kind) ?? "?"} ${str(ev.subject_id) ?? "?"} 记了一条验证证据`, str(ev.outcome) === "success" ? "成功" : str(ev.outcome) === "violation" ? "违规" : null, str(ev.outcome) === "success" ? true : str(ev.outcome) === "violation" ? false : null, null);
        break;
      case "trust_spot_check_flagged":
        push(at, "event", `${str(ev.kind) ?? "?"} ${str(ev.subject_id) ?? "?"} 的一条证据被随机抽查选中`, "待复核才计入升级", null, null);
        break;
      case "trust_spot_check_reviewed":
        push(at, "event", `抽查证据已复核：${str(ev.decision) === "approve" ? "通过，计入升级" : "驳回，按违规算"}`, null, str(ev.decision) === "approve" ? true : str(ev.decision) === "reject" ? false : null, null);
        break;
      case "trust_promoted":
        push(at, "event", `${str(ev.kind) ?? "?"} ${str(ev.subject_id) ?? "?"} 已升级`, `升到 ${str(ev.level) ?? "?"}级`, true, null);
        break;
      case "trust_demoted":
        push(at, "event", `${str(ev.kind) ?? "?"} ${str(ev.subject_id) ?? "?"} 已降级`, `降到 ${str(ev.level) ?? "?"}级`, false, null);
        break;
      case "trust_blocked":
        push(at, "event", `信任阶梯拦截了 ${str(ev.tool) ?? "?"}`, `agent ${str(ev.agent) ?? "?"} 当前 ${str(ev.level) ?? "?"}级，要求 ${str(ev.required_level) ?? "?"}级`, false, null);
        break;
      case "workflow_started":
        push(at, "event", `工作流 ${str(ev.workflow) ?? "?"} 开始${bool(ev.dry_run) === true ? "（dry-run）" : bool(ev.trial) === true ? "（试跑）" : ""}`, str(ev.workflow_run_id) ? `运行 ${str(ev.workflow_run_id)}` : null, null, null);
        break;
      case "workflow_node": {
        const status = str(ev.status);
        push(at, "event", `工作流节点 ${str(ev.node_id) ?? "?"}（${str(ev.node_type) ?? "?"}）${status === "ok" ? "完成" : status === "skipped" ? "跳过" : status === "failed" ? "失败" : status ?? ""}`, `耗时 ${num(ev.ms) ?? "?"}ms${typeof ev.spent_usd === "number" ? `，已花 $${(ev.spent_usd as number).toFixed(4)}` : ""}`, status === "ok" ? true : status === "failed" ? false : null, null);
        break;
      }
      case "workflow_awaiting_approval":
        push(at, "event", `工作流节点 ${str(ev.node_id) ?? "?"} 等人工批复`, str(ev.review_item_id) ? `审阅项 ${str(ev.review_item_id)}` : null, null, null);
        break;
      case "workflow_completed":
        push(at, "verdict", `工作流 ${str(ev.workflow) ?? "?"} 完成（${num(ev.nodes) ?? "?"} 个节点）`, typeof ev.spent_usd === "number" ? `已花 $${(ev.spent_usd as number).toFixed(4)}` : null, true, null);
        break;
      case "workflow_failed":
        push(at, "event", `工作流 ${str(ev.workflow) ?? "?"} 失败`, str(ev.error) ? str(ev.error)!.slice(0, 200) : null, false, null);
        break;
      case "workflow_coordinator_decision": {
        const action = str(ev.action);
        const actionText = action === "run" ? "跑步骤" : action === "new_step" ? "生成新步骤" : action === "finish" ? "结束" : action === "ask" ? "停下来问人" : action === "invalid" ? "决定无效" : action ?? "?";
        push(at, "event", `协调者第 ${num(ev.round) ?? "?"} 轮决定：${actionText}${str(ev.step) ? ` ${str(ev.step)}` : ""}`, typeof ev.spent_usd === "number" ? `这次决定已花 $${(ev.spent_usd as number).toFixed(4)}` : null, null, null);
        break;
      }
      case "workflow_dynamic_step":
        push(at, "event", `协调者新增步骤 ${str(ev.step_id) ?? "?"}（${str(ev.step_type) ?? "?"}）`, null, null, null);
        break;
      case "workflow_coordinator_ask":
        push(at, "event", `协调者第 ${num(ev.round) ?? "?"} 轮停下来问人`, str(ev.review_item_id) ? `审阅项 ${str(ev.review_item_id)}` : null, null, null);
        break;
      // Pi Bot 借鉴第 1 条：脚本纯度判定（哪门语言、纯还是不纯、为什么）
      // 与预授权快路径（哪一步、哪个摘要）。摘要只显前 12 位，完整摘要在账本里。
      case "script_pure": {
        const digest = str(ev.digest);
        push(at, "event", `脚本纯度判定（${str(ev.language) ?? "?"}）：${bool(ev.pure) === true ? "纯" : "不纯"}`, `${digest ? `摘要 ${digest.slice(0, 12)}…` : ""}${str(ev.reason) ? `，${str(ev.reason)}` : ""}` || null, null, null);
        break;
      }
      case "script_preauth_used": {
        const digest = str(ev.digest);
        push(at, "event", `脚本预授权快路径（${str(ev.language) ?? "?"}）`, `步骤 ${str(ev.step) ?? "?"}${digest ? `，摘要 ${digest.slice(0, 12)}…` : ""}`, true, null);
        break;
      }
      // Pi Bot 借鉴第 2 条：交接契约程序验收的结论（哪个契约、谁交给谁、
      // 第几轮、几项通过/共几项）与人工定夺/放弃（谁定的）。
      case "handover_contract_accepted": {
        push(at, "event", `交接契约已接受（${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}）`, `第 ${num(ev.round) ?? "?"} 轮，${num(ev.passed) ?? "?"} / ${num(ev.total) ?? "?"} 项通过`, true, null);
        break;
      }
      case "handover_contract_sent_back": {
        push(at, "event", `交接契约已打回（${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}）`, `第 ${num(ev.round) ?? "?"} 轮，${num(ev.passed) ?? "?"} / ${num(ev.total) ?? "?"} 项通过`, null, null);
        break;
      }
      case "handover_contract_stopped": {
        push(at, "event", `交接契约已停下等人（${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}）`, `第 ${num(ev.round) ?? "?"} 轮，${num(ev.passed) ?? "?"} / ${num(ev.total) ?? "?"} 项通过`, null, null);
        break;
      }
      case "handover_contract_resolved": {
        push(at, "event", `交接契约人工已定夺（${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}）`, str(ev.by) ? `由 ${str(ev.by)} 定夺` : null, true, null);
        break;
      }
      case "handover_contract_closed": {
        push(at, "event", `交接契约已放弃（${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}）`, str(ev.by) ? `由 ${str(ev.by)} 放弃` : null, null, null);
        break;
      }
      // Pi Bot 借鉴第 3 条：卡住步骤看门狗（哪个任务、静默几秒、第几次重排）。
      case "reconciler_stuck": {
        push(at, "event", `看门狗：任务 ${str(ev.task_id) ?? "?"} 卡住了`, `${num(ev.idle_seconds) ?? "?"} 秒无进展，已重排 ${num(ev.retries) ?? 0} 次`, null, null);
        break;
      }
      case "reconciler_retried": {
        push(at, "event", `看门狗：任务 ${str(ev.task_id) ?? "?"} 自动重排`, `卡住 ${num(ev.idle_seconds) ?? "?"} 秒，第 ${num(ev.retries) ?? "?"} 次重排，失败 ${num(ev.attempts) ?? "?"} 次`, null, null);
        break;
      }
      case "reconciler_blocked": {
        push(at, "event", `看门狗：任务 ${str(ev.task_id) ?? "?"} 已停下等人`, `卡住 ${num(ev.idle_seconds) ?? "?"} 秒，重排已用完 ${num(ev.retries) ?? "?"} 次`, false, null);
        break;
      }
      case "reconciler_recovered": {
        push(at, "event", `看门狗：任务 ${str(ev.task_id) ?? "?"} 恢复进展`, `卡住 ${num(ev.idle_seconds) ?? "?"} 秒后又有动静了`, true, null);
        break;
      }
      case "reconciler_run_done": {
        push(at, "event", `看门狗：任务 ${str(ev.task_id) ?? "?"} 的运行已结束`, `运行 ${str(ev.run_id) ?? "?"} 状态 ${str(ev.status) ?? "?"}，任务仍在 working，等验证证据才能标完成`, null, null);
        break;
      }
      // 缺口 32：变化监测例程（哪个监测、变了多少行、触发了什么动作）。
      case "watch_changed": {
        push(at, "event", `监测「${str(ev.label) ?? "?"}」变了`, `新增 ${num(ev.added_lines) ?? 0} 行、删除 ${num(ev.removed_lines) ?? 0} 行（${str(ev.from_hash) ?? "?"} → ${str(ev.to_hash) ?? "?"}）`, null, null);
        break;
      }
      case "watch_missing": {
        push(at, "event", `监测「${str(ev.label) ?? "?"}」的目标取不到了`, str(ev.reason) ?? "?", null, null);
        break;
      }
      case "watch_action_triggered": {
        push(at, "event", `监测「${str(ev.label) ?? "?"}」触发了动作`, `动作 ${str(ev.action) ?? "?"}，条件 ${str(ev.condition) ?? "?"}${str(ev.run_id) ? `，入队任务 ${str(ev.run_id)}` : ""}`, null, null);
        break;
      }
      case "watch_action_pending": {
        push(at, "event", `监测「${str(ev.label) ?? "?"}」的动作等批准`, `动作 ${str(ev.action) ?? "?"}：${str(ev.reason) ?? "?"}`, null, null);
        break;
      }
      case "watch_action_done": {
        push(at, "event", `监测「${str(ev.label) ?? "?"}」的动作${ev.ok ? "完成了" : "失败了"}`, `动作 ${str(ev.action) ?? "?"}：${str(ev.detail) ?? "?"}`, ev.ok ? true : false, null);
        break;
      }
      // 缺口 45：持续责任语义（生命周期、升级、晨间简报）。
      case "responsibility_paused": {
        push(at, "event", `责任「${str(ev.responsibility_name) ?? "?"}」已暂停`, "巡查暂停，恢复前不跑", null, null);
        break;
      }
      case "responsibility_resumed": {
        push(at, "event", `责任「${str(ev.responsibility_name) ?? "?"}」已恢复`, "按原节奏继续巡查", null, null);
        break;
      }
      case "responsibility_completed": {
        push(at, "event", `责任「${str(ev.responsibility_name) ?? "?"}」已完成`, `验收通过 ${num(ev.checks_passed) ?? 0} 项、未通过 ${num(ev.checks_failed) ?? 0} 项`, true, null);
        break;
      }
      case "responsibility_cancelled": {
        push(at, "event", `责任「${str(ev.responsibility_name) ?? "?"}」已取消`, "取消是终态，不再巡查", null, null);
        break;
      }
      case "responsibility_expired": {
        push(at, "event", `责任「${str(ev.responsibility_name) ?? "?"}」已过期失效`, "到期自动失效，不永久驻留", null, null);
        break;
      }
      case "responsibility_escalated": {
        push(at, "event", `责任「${str(ev.responsibility_name) ?? "?"}」命中升级条件`, `条件「${str(ev.condition) ?? "?"}」，已进审阅队列 ${str(ev.item_id) ?? "?"} 等人批`, false, null);
        break;
      }
      case "briefing_generated": {
        push(at, "event", `晨间简报已生成（${str(ev.date) ?? "?"}）`, ev.quiet ? "无事安静，未打扰" : `进展 ${num(ev.progress_items) ?? 0} 条、待决策 ${num(ev.decision_items) ?? 0} 项、异常 ${num(ev.anomaly_items) ?? 0} 条`, null, null);
        break;
      }
      // 缺口 33：外部文档知识库检索进证据链（哪个库、问了什么、命中几条、最高分）。
      case "knowledge_search": {
        const q = (str(ev.query) ?? "?").slice(0, 40);
        push(at, "event", `知识库「${str(ev.base) ?? "?"}」检索命中 ${num(ev.hits) ?? 0} 条`, `问题「${q}」，最高分 ${num(ev.top_score) ?? 0}`, null, null);
        break;
      }
      case "redline_changed": {
        const connector = str(ev.connector) ?? "未知连接器";
        const action = str(ev.action) ?? "未知动作";
        const from = str(ev.from) ?? "?";
        const to = str(ev.to) ?? "?";
        push(at, "event", `红线表改动：${connector} 的 ${action}（${from} → ${to}）`, null, null, null);
        break;
      }
      case "redline_blocked": {
        const connector = str(ev.connector) ?? "未知连接器";
        const action = str(ev.action) ?? "未知动作";
        const tier = str(ev.tier) ?? "?";
        const tool = str(ev.tool);
        push(at, "event", `红线拦截：${connector} 的 ${action}（${tier}）`, tool ? `工具 ${tool}` : null, false, null);
        break;
      }
      case "soul_tenet_added": {
        const agent = str(ev.agent) ?? "未知 Soul";
        const kind = str(ev.kind) ?? "?";
        push(at, "event", `Soul ${agent} 加了一条${kind === "invariant" ? "不变量" : "偏好"}`, str(ev.tenet_id) ? `Tenet ${str(ev.tenet_id)}` : null, null, null);
        break;
      }
      case "soul_tenet_removed": {
        const agent = str(ev.agent) ?? "未知 Soul";
        const remaining = num(ev.remaining);
        push(at, "event", `Soul ${agent} 删了一条 Tenet`, remaining !== null ? `删后剩 ${remaining} 条` : null, null, null);
        break;
      }
      case "soul_tenet_changed": {
        const agent = str(ev.agent) ?? "未知 Soul";
        const change = str(ev.change) ?? "?";
        const changeLabel = change === "enabled" ? "开启" : change === "disabled" ? "关闭" : change === "edited" ? "修改" : change;
        push(at, "event", `Soul ${agent} 的 Tenet ${changeLabel}`, str(ev.tenet_id) ? `Tenet ${str(ev.tenet_id)}` : null, null, null);
        break;
      }
      case "soul_invariant_blocked": {
        const agent = str(ev.agent) ?? "未知 Soul";
        const tool = str(ev.tool);
        const rule = str(ev.rule);
        // 规则放标题里：默认摘要模式不展开 detail，拦住的原因必须一眼看到。
        push(at, "event", `Soul invariant 拦截：${agent} 的不变量拦住了${tool ? `工具 ${tool}` : "一次调用"}${rule ? `（规则 ${rule}）` : ""}`, null, false, null);
        break;
      }
      // GROK 批：Charter 与团队模式进时间线——只记元数据，不记任务原文。
      case "soul_charter_set":
        push(at, "event", `Soul ${str(ev.agent) ?? "未知 Soul"} 写了角色契约（Charter）`, null, null, null);
        break;
      case "soul_charter_cleared":
        push(at, "event", `Soul ${str(ev.agent) ?? "未知 Soul"} 清掉了角色契约（该 agent 不能再接团队单）`, null, null, null);
        break;
      case "team_created":
        push(at, "event", `团队已建：${str(ev.team_id) ?? "?"}（参谋长 ${str(ev.chief) ?? "?"}，${num(ev.members) ?? "?"} 个成员）`, null, null, null);
        break;
      case "team_member_added":
        push(at, "event", `团队 ${str(ev.team_id) ?? "?"} 加了成员 ${str(ev.agent) ?? "?"}`, null, null, null);
        break;
      case "team_member_removed":
        push(at, "event", `团队 ${str(ev.team_id) ?? "?"} 移除了成员 ${str(ev.agent) ?? "?"}`, null, null, null);
        break;
      case "team_dissolved":
        push(at, "event", `团队 ${str(ev.team_id) ?? "?"} 已解散`, null, null, null);
        break;
      case "team_dispatched":
        push(at, "event", `团队 ${str(ev.team_id) ?? "?"} 已分派（参谋长 ${str(ev.chief) ?? "?"}，${num(ev.members) ?? "?"} 个成员）`, null, null, null);
        break;
      case "team_handover_sent":
        push(at, "event", `交接已发出：${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}`, str(ev.handover_id) ? `交接包 ${str(ev.handover_id)}` : null, null, null);
        break;
      case "team_handover_received":
        push(at, "event", `交接已到 inbox：${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}`, str(ev.handover_id) ? `交接包 ${str(ev.handover_id)}` : null, null, null);
        break;
      case "team_handover_accepted":
        push(at, "event", `交接已接下：${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}`, str(ev.handover_id) ? `交接包 ${str(ev.handover_id)}` : null, null, null);
        break;
      case "team_approval_requested":
        push(at, "event", `团队审批：${str(ev.agent) ?? "?"} 替团队 ${str(ev.team_id) ?? "?"} 申请 ${str(ev.tool) ?? "?"}（回参谋长 ${str(ev.chief) ?? "?"} / 人批）`, null, null, null);
        break;
      case "team_approval_decided": {
        const approved = bool(ev.approved);
        push(at, "event", `团队审批${approved === true ? "通过" : approved === false ? "被拒" : "已定夺"}：${str(ev.agent) ?? "?"} 申请 ${str(ev.tool) ?? "?"}`, null, approved, null);
        break;
      }
      case "team_charter_verified": {
        const passed = bool(ev.passed);
        push(at, "event", `Charter 抽查${passed === true ? "通过" : passed === false ? "未通过" : "已定夺"}：成员 ${str(ev.agent) ?? "?"}`, str(ev.run_id) ? `运行 ${str(ev.run_id)}` : null, passed, null);
        break;
      }
      case "tool_start": {
        const id = str(ev.id) ?? "";
        const name = str(ev.name) ?? "未知工具";
        toolCalls += 1;
        const step = push(at, "tool", `工具 ${name}`, null, null, null);
        if (id) pendingTools.set(id, step);
        if (id) pendingToolNames.set(id, name);
        break;
      }
      case "tool_result": {
        const id = str(ev.id) ?? "";
        const name = str(ev.name) ?? "未知工具";
        const ok = bool(ev.ok);
        if (ok === false) toolErrors += 1;
        const hash = str(ev.args_hash);
        const detail = hash ? `参数指纹 ${hash.slice(0, 12)}…` : null;
        if (id) pendingToolNames.delete(id);
        const pending = id ? pendingTools.get(id) : undefined;
        if (pending) {
          pendingTools.delete(id);
          pending.ok = ok;
          pending.durationMs = offsetOf(at) !== null && pending.offsetMs !== null ? (offsetOf(at) as number) - (pending.offsetMs as number) : null;
          pending.title = `工具 ${name}${ok === false ? "（失败）" : ""}`;
          pending.detail = detail;
        } else {
          push(at, "tool", `工具 ${name}（结果，无开始记录）${ok === false ? "（失败）" : ""}`, detail, ok, null);
        }
        break;
      }
      case "delegate_start": {
        const taskId = str(ev.task_id) ?? "?";
        const depth = num(ev.depth);
        const layerRemaining = num(ev.layer_remaining);
        const depthNote = depth !== null ? `第 ${depth} 层` : "";
        const budgetNote = layerRemaining !== null ? `，本层预算剩 ${layerRemaining}` : "";
        const step = push(at, "delegate", `子任务 ${taskId} 启动（${depthNote ? depthNote + "，" : ""}模型 ${str(ev.model) ?? "未知"}，最多 ${num(ev.max_turns) ?? "?"} 轮${budgetNote}）`, null, null, null);
        pendingDelegates.set(taskId, step);
        break;
      }
      case "delegate_rejected": {
        const taskId = str(ev.task_id) ?? "?";
        const depth = num(ev.depth);
        push(at, "delegate", `委派被拒：子任务 ${taskId}${depth !== null ? `（第 ${depth} 层）` : ""}——${str(ev.reason) ?? "原因未记"}`, null, false, null);
        break;
      }
      case "delegate_end": {
        const taskId = str(ev.task_id) ?? "?";
        const ok = bool(ev.ok);
        const spent = num(ev.spent_usd);
        const detail = `轮数 ${num(ev.turns) ?? "未知"} · 花费 ${formatUsd(spent)} · 验收：${str(ev.verification) ?? "未验收"}`;
        const pending = pendingDelegates.get(taskId);
        if (pending) {
          pendingDelegates.delete(taskId);
          pending.ok = ok;
          pending.durationMs = offsetOf(at) !== null && pending.offsetMs !== null ? (offsetOf(at) as number) - (pending.offsetMs as number) : null;
          pending.title = `子任务 ${taskId}${ok === false ? "（失败）" : "（完成）"}`;
          pending.detail = detail;
        } else {
          push(at, "delegate", `子任务 ${taskId}${ok === false ? "（失败）" : "（完成）"}`, detail, ok, null);
        }
        break;
      }
      case "parallel_delegate":
        push(at, "delegate", `并行委派：成功 ${num(ev.succeeded) ?? "?"} / 失败 ${num(ev.failed) ?? "?"}（花费 ${formatUsd(num(ev.total_spent_usd))}）`, null, null, null);
        break;
      case "verifier_verdict": {
        const verdict = str(ev.verdict) ?? "not-verified";
        const label = verdict === "verified" ? "通过" : verdict === "failed" ? "未通过" : "未验证";
        const checks = `检查 ${num(ev.checks_passed) ?? "?"} 通过 / ${num(ev.checks_failed) ?? "?"} 未通过`;
        const reason = safeText(ev.reason);
        push(at, "verdict", `验收 ${str(ev.target) ?? "?"}：${label}（${str(ev.source) ?? "?"}）`, `${checks}${reason ? ` · ${reason}` : ""}`, verdict === "verified" ? true : verdict === "failed" ? false : null, null);
        break;
      }
      case "verifier_rework":
        push(at, "verdict", `验收打回重做（第 ${num(ev.attempt) ?? "?"} 次）：${str(ev.target) ?? "?"}`, safeText(ev.reason) || null, false, null);
        break;
      case "reviewer_verdict":
        push(at, "verdict", `审查 ${str(ev.tool) ?? "?"}：${str(ev.decision) ?? "?"}`, safeText(ev.reason) || null, str(ev.decision) === "allow" ? true : str(ev.decision) === "deny" ? false : null, null);
        break;
      case "review_decision":
        push(at, "verdict", `审阅批复 ${str(ev.item_id) ?? "?"}：${str(ev.decision) ?? "?"}`, null, str(ev.decision) === "approve" ? true : str(ev.decision) === "reject" ? false : null, null);
        break;
      case "approval_wait": {
        const tool = str(ev.tool) ?? "?";
        pendingApprovals.set(tool, tool);
        push(at, "approval", `等待审批：${tool}`, null, null, null);
        break;
      }
      case "approval_done": {
        const tool = str(ev.tool) ?? "?";
        pendingApprovals.delete(tool);
        push(at, "approval", `审批 ${tool}：${bool(ev.approved) === true ? "批准" : bool(ev.approved) === false ? "拒绝" : "未知"}`, null, bool(ev.approved), null);
        break;
      }
      case "bot_computer_created":
        push(at, "event", `Bot 电脑已创建：${str(ev.agent) ?? "?"}（${str(ev.isolation) === "shared" ? "共享" : "独占"}）`, null, null, null);
        break;
      case "bot_computer_action": {
        const ok = bool(ev.ok);
        push(at, "tool", `电脑 ${str(ev.computer_id) ?? "?"}：${str(ev.action) ?? "?"} ${safeText(ev.target) ?? ""}`, null, ok, null);
        break;
      }
      case "bot_computer_lifecycle":
        push(at, "event", `电脑 ${str(ev.computer_id) ?? "?"}：${str(ev.action) ?? "?"}${str(ev.reason) ? `（${safeText(ev.reason)}）` : ""}`, null, null, null);
        break;
      case "bot_computer_credential":
        push(at, "event", `电脑 ${str(ev.computer_id) ?? "?"}：凭证 ${str(ev.account) ?? "?"} ${str(ev.op) ?? "?"}`, null, null, null);
        break;
      case "model_switch":
        push(at, "model", `换模型 ${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}` + (str(ev.reason) ? `（${safeText(ev.reason)}）` : ""), null, null, null);
        break;
      case "verify_started":
        push(at, "verify", `开始验证：${safeText(ev.command)}`, null, null, null);
        break;
      case "verify_result":
        push(at, "verify", `验证结果：${bool(ev.passed) === true ? "通过" : bool(ev.passed) === false ? "未通过" : "未知"}（退出码 ${num(ev.exit_code) ?? "未知"}，第 ${num(ev.attempt) ?? "?"} 次）`, null, bool(ev.passed), null);
        break;
      case "error":
        runErrors += 1;
        push(at, "event", `运行错误：${str(ev.error_type) ?? "Error"}`, null, false, null);
        break;
      case "max_turns":
        push(at, "event", "达到最大轮数（未完成）", null, false, null);
        break;
      case "interrupted":
        push(at, "event", "运行中断", null, false, null);
        break;
      case "final":
        push(at, "run", "运行结束（模型给出最终回答）", null, null, null);
        break;
      case "status":
        push(at, "event", `状态：${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}`, null, null, null);
        break;
      default:
        push(at, "event", type, kvLine(ev), null, null);
        break;
    }
  }
  // 无结果的调用：中断截断的尾巴，标出来而不是假装完成了。
  for (const step of pendingTools.values()) {
    step.title += "（无结果，可能中断）";
    step.ok = null;
  }
  for (const step of pendingDelegates.values()) {
    step.title += "（未结束）";
    step.ok = null;
  }
  steps.forEach((s, i) => { s.index = i + 1; });

  // 阶段表：从事件闭合情况推当前阶段（等谁、等什么），不是从步骤标题里抠字。
  const lastFailure = [...steps].reverse().find((s) => s.ok === false);
  const stage = deriveRunStage({
    status: state.status,
    approvalsPending: [...pendingApprovals.keys()],
    delegatesPending: [...pendingDelegates.keys()],
    toolsPending: [...pendingToolNames.values()],
    lastFailureTitle: lastFailure ? lastFailure.title : null,
  });

  const summary = (state.usage_summary ?? {}) as Record<string, unknown>;
  return {
    runId: state.run_id,
    task: state.task,
    status: state.status,
    mode: state.mode,
    createdAt: state.created_at,
    updatedAt: state.updated_at,
    durationMs: stats.durationMs,
    turns: stats.turns,
    llmCalls: stats.llmCalls,
    toolCalls,
    toolErrors,
    runErrors,
    promptTokens: num(summary.prompt_tokens),
    completionTokens: num(summary.completion_tokens),
    totalTokens: num(summary.total_tokens),
    spentUsd: num(summary.spent_usd) !== null || num(summary.delegate_spent_usd) !== null || num(summary.voice_spent_usd) !== null
      ? (num(summary.spent_usd) ?? 0) + (num(summary.delegate_spent_usd) ?? 0) + (num(summary.voice_spent_usd) ?? 0)
      : null,
    delegateSpentUsd: num(summary.delegate_spent_usd),
    steps,
    eventsTotal: rawEvents.length,
    stage,
  };
}

function headlineLines(tl: Timeline): string[] {
  return [
    `运行 ${tl.runId}（${tl.status}）`,
    `当前阶段：${stageDisplay(tl.stage)}`,
    `任务：${safeText(tl.task)}`,
    `总耗时：${formatDurationMs(tl.durationMs)} · 轮次：${tl.turns} · 模型调用：${tl.llmCalls === null ? "未知" : tl.llmCalls} · 工具调用：${tl.toolCalls} · 错误：${tl.toolErrors + tl.runErrors}（工具 ${tl.toolErrors} / 运行 ${tl.runErrors}）`,
    `Token：prompt ${formatTokens(tl.promptTokens)} / completion ${formatTokens(tl.completionTokens)} / 合计 ${formatTokens(tl.totalTokens)} · 花费：${formatUsd(tl.spentUsd)}${tl.delegateSpentUsd !== null ? `（其中子任务 ${formatUsd(tl.delegateSpentUsd)}）` : ""}`,
  ];
}

function stepLine(s: TimelineStep, verbose: boolean): string {
  const mark = s.ok === true ? "✓" : s.ok === false ? "✗" : "·";
  const head = `${s.index}. [${formatClock(s.at)}${formatOffset(s.offsetMs)}] [第 ${s.turn} 轮] ${mark} ${s.title}`;
  if (!verbose) return head;
  const parts: string[] = [head];
  if (s.detail) parts.push(`   ${s.detail}`);
  if (s.durationMs !== null && s.kind !== "llm") parts.push(`   耗时 ${formatDurationMs(s.durationMs)}`);
  return parts.join("\n");
}

/** 文本时间线：统计头 + 按时间编号的步骤（默认摘要，--verbose 展开细节）。 */
export function formatTimelineText(tl: Timeline, opts?: { verbose?: boolean }): string {
  const verbose = opts?.verbose ?? false;
  const lines = [...headlineLines(tl), ""];
  if (!tl.steps.length) lines.push("（本次运行没有事件记录）");
  for (const s of tl.steps) lines.push(stepLine(s, verbose));
  return lines.join("\n");
}

/** 会话回放：按轮次分组的逐步 walkthrough。只读展示，不重新执行任何调用。 */
export function formatReplayText(tl: Timeline, opts?: { verbose?: boolean }): string {
  const verbose = opts?.verbose ?? false;
  const lines = [
    `回放 ${tl.runId}（只读：按原始时序重现，未重新执行任何工具调用、不花 token）`,
    ...headlineLines(tl).slice(1),
    "",
  ];
  if (!tl.steps.length) {
    lines.push("（本次运行没有事件记录，无可回放的步骤）");
    return lines.join("\n");
  }
  let currentTurn = -1;
  for (const s of tl.steps) {
    if (s.turn !== currentTurn) {
      currentTurn = s.turn;
      lines.push(`== 第 ${currentTurn} 轮 ==`);
    }
    lines.push(stepLine(s, verbose));
  }
  lines.push("");
  lines.push(`回放结束：运行状态 ${tl.status}`);
  return lines.join("\n");
}

/** 导出用 Markdown：统计头表格 + 步骤表（与 nyra evidence verify 同口径、可审计）。 */
export function formatTimelineMarkdown(tl: Timeline): string {
  const lines = [
    `# 运行时间线 ${tl.runId}`,
    "",
    `任务：${safeText(tl.task)}`,
    "",
    "| 项目 | 数值 |",
    "| --- | --- |",
    `| 状态 | ${tl.status} |`,
    `| 当前阶段 | ${stageDisplay(tl.stage)} |`,
    `| 模式 | ${tl.mode} |`,
    `| 开始 | ${tl.createdAt} |`,
    `| 结束 | ${tl.updatedAt} |`,
    `| 总耗时 | ${formatDurationMs(tl.durationMs)} |`,
    `| 轮次 | ${tl.turns} |`,
    `| 模型调用 | ${tl.llmCalls === null ? "未知" : tl.llmCalls} |`,
    `| 工具调用 | ${tl.toolCalls} |`,
    `| 错误（工具/运行） | ${tl.toolErrors} / ${tl.runErrors} |`,
    `| Token（prompt/completion/合计） | ${formatTokens(tl.promptTokens)} / ${formatTokens(tl.completionTokens)} / ${formatTokens(tl.totalTokens)} |`,
    `| 花费 | ${formatUsd(tl.spentUsd)} |`,
    "",
    "## 步骤",
    "",
    "| # | 时间 | 轮次 | 步骤 | 结论 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of tl.steps) {
    const verdict = s.ok === true ? "通过" : s.ok === false ? "失败" : "—";
    const title = s.title.replace(/\|/g, "\\|");
    const detail = s.detail ? `（${s.detail.replace(/\|/g, "\\|")}）` : "";
    lines.push(`| ${s.index} | ${formatClock(s.at)}${formatOffset(s.offsetMs)} | ${s.turn} | ${title}${detail} | ${verdict} |`);
  }
  lines.push("");
  lines.push("注：本报告由运行事件重建，只读回放，未重新执行任何工具调用。");
  return lines.join("\n");
}

/** 导出时间线 Markdown（落盘 0600；父目录不存在时创建 0700）。 */
export function exportTimelineMarkdown(store: RunStore, runId: string, outPath: string): string {
  const tl = buildTimeline(store, runId);
  const md = formatTimelineMarkdown(tl);
  const dir = dirname(outPath);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(outPath, md, { mode: 0o600 });
  try { chmodSync(outPath, 0o600); } catch { /* Windows 不认 POSIX mode，忽略 */ }
  return outPath;
}
