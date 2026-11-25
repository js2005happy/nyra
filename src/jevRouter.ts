// src/jevRouter.ts — M2（OpenMausBot 的 Jev 式快速决策路由借鉴）。
//
// Jev 是 OMB 群聊里的“参谋长”：收到一条没 @ 谁的消息，先用便宜模型
// 快速判该谁接（只看一句话、不跑全量 agent），再把消息只交给那一个
// Bot；判不出来就回落全员回答。
//
// 只借这个“先分流、再执行”的想法，不借 OMB 的宽松语义：
// - 路由默认关闭（jev_router_enabled，opt-in），开了才分流；
// - 路由只决定“谁回答”，不决定“能不能做”——选中的 Bot 照样走审批、
//   预算、证据链；路由失败/不确定一律回落全员回答，不静默丢消息；
// - 路由 decider 只用便宜模型（默认 deepseek-flash），不用 fallback
//   链、不自动换模型；队列与定时任务里不自动路由（只在交互 send 里用）；
// - 路由结论进证据链（jev_routed 事件，见 runs.ts 的 EVENT_FIELDS）。
import { loadConfig, resolveProvider } from "./config.ts";
import { Provider } from "./providers.ts";

/** 默认置信度阈值：低于它回落全员回答。 */
export const JEV_DEFAULT_THRESHOLD = 0.6;
/** 默认路由模型：便宜模型，只做一句话的分流判断。 */
export const JEV_DEFAULT_MODEL = "deepseek-flash";

export interface JevMember {
  id: string;
  name: string;
  role: string;
  instructions?: string;
}

export interface JevRawDecision {
  member: string;
  confidence: number;
}

export type JevDecider = (
  message: string,
  members: JevMember[],
) => Promise<JevRawDecision | null>;

export interface JevDecision {
  /** 选中的成员 id；null = 回落全员回答（原有行为）。 */
  member: string | null;
  /** decider 报的置信度；回落时为 null（没判出来就别编数）。 */
  confidence: number | null;
  reason: string;
  fallback: boolean;
}

export interface JevRouterConfig {
  enabled: boolean;
  model: string;
  threshold: number;
}

/** 读路由配置：只认 config.json 里的三个键，其他一律取默认。 */
export function jevRouterConfig(home: string): JevRouterConfig {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = loadConfig(home) as Record<string, unknown>;
  } catch {
    cfg = {};
  }
  const thresholdRaw = cfg.jev_confidence_threshold;
  const threshold = typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1
    ? thresholdRaw
    : JEV_DEFAULT_THRESHOLD;
  const modelRaw = cfg.jev_model;
  return {
    enabled: cfg.jev_router_enabled === true,
    model: typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : JEV_DEFAULT_MODEL,
    threshold,
  };
}

/** 分流提示词：只让模型回一个 JSON，不写解释、不编成员。 */
export function jevPrompt(message: string, members: JevMember[]): string {
  const list = members
    .map((m) => `- ${m.id}（${m.name}）：${m.role}${m.instructions ? `——${m.instructions.slice(0, 200)}` : ""}`)
    .join("\n");
  return [
    "你是群聊的参谋长。收到一条没指定收件人的群消息，判断最该由哪个机器人回答。",
    "只回一个 JSON，不要写解释：{\"member\": \"<机器人 id>\", \"confidence\": 0.0-1.0}。",
    "confidence 是你对这个选择的把握：把握不大就写低一点（低于 0.6 会回落全员回答，别硬猜）。",
    "成员：",
    list,
    `消息：${message}`,
  ].join("\n");
}

/** 解析 decider 回复：只认 {"member": string, "confidence": number}，其他一律 null。 */
export function parseJevReply(text: string): JevRawDecision | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const member = (parsed as Record<string, unknown>).member;
  const confidence = (parsed as Record<string, unknown>).confidence;
  if (typeof member !== "string" || !member.trim()) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return { member: member.trim(), confidence };
}

/**
 * 纯编排：decider 只管判，阈值/越界/回落全在这里定。
 * - decider 返回 null 或抛错 → 回落；
 * - 选了不存在的成员 → 回落（不静默换一个）；
 * - 置信度越界（不在 0–1）→ 回落；
 * - 置信度低于阈值 → 回落。
 */
export async function routeMessage(
  message: string,
  members: JevMember[],
  decider: JevDecider,
  opts: { threshold?: number } = {},
): Promise<JevDecision> {
  const threshold = opts.threshold ?? JEV_DEFAULT_THRESHOLD;
  if (members.length === 0) {
    return { member: null, confidence: null, reason: "房间里没有机器人", fallback: true };
  }
  if (members.length === 1) {
    return { member: members[0]!.id, confidence: null, reason: "房间里只有一个机器人，不用分流", fallback: false };
  }
  let raw: JevRawDecision | null;
  try {
    raw = await decider(message, members);
  } catch (err: unknown) {
    return { member: null, confidence: null, reason: `路由失败（${err instanceof Error ? err.message : String(err)}），回落全员回答`, fallback: true };
  }
  if (!raw) {
    return { member: null, confidence: null, reason: "路由没判出来，回落全员回答", fallback: true };
  }
  if (!members.some((m) => m.id === raw.member)) {
    return { member: null, confidence: raw.confidence, reason: `路由选了不存在的成员 ${raw.member}，回落全员回答`, fallback: true };
  }
  if (raw.confidence < 0 || raw.confidence > 1) {
    return { member: null, confidence: raw.confidence, reason: `路由置信度越界（${raw.confidence}），回落全员回答`, fallback: true };
  }
  if (raw.confidence < threshold) {
    return { member: null, confidence: raw.confidence, reason: `路由置信度 ${raw.confidence} 低于阈值 ${threshold}，回落全员回答`, fallback: true };
  }
  return { member: raw.member, confidence: raw.confidence, reason: "Jev 路由", fallback: false };
}

/**
 * 链式 decider：先跑 first（本地小路由，零 token），它返回 null
 * （判不出、置信度不够、权重坏了）时再跑 second（便宜模型）。
 * first 抛错也一样落到 second；两个都判不出才返回 null，
 * 外层 routeMessage 再回落全员回答。调用后 lastSource 说明
 * 这次是谁判的（first / second / none），调用方据此写审计。
 */
export type ChainedDecider = JevDecider & {
  lastSource: "first" | "second" | "none";
};

export function chainDeciders(first: JevDecider, second: JevDecider): ChainedDecider {
  const chained = (async (message: string, members: JevMember[]) => {
    let d: JevRawDecision | null = null;
    try {
      d = await first(message, members);
    } catch {
      d = null;
    }
    if (d) {
      chained.lastSource = "first";
      return d;
    }
    let d2: JevRawDecision | null = null;
    try {
      d2 = await second(message, members);
    } catch {
      d2 = null;
    }
    chained.lastSource = d2 ? "second" : "none";
    return d2;
  }) as ChainedDecider;
  chained.lastSource = "none";
  return chained;
}

/**
 * 生产 decider：便宜模型一句话分流。只用 resolveProvider 直连，
 * 不走 fallback 链（路由不值得换模型）；任何失败都返回 null
 * （routeMessage 会回落），不在这里抛错打断群聊。
 */
export function createJevDecider(home: string, opts: { model?: string } = {}): JevDecider {
  return async (message, members) => {
    const config = loadConfig(home) as Record<string, unknown>;
    const model = opts.model ?? (typeof config.jev_model === "string" && config.jev_model ? config.jev_model : JEV_DEFAULT_MODEL);
    const resolved = resolveProvider({ home, config, model });
    const provider = new Provider(resolved);
    if (!provider.hasCredentials()) return null;
    const resp = await provider.chat([{ role: "user", content: jevPrompt(message, members) }], null, 30);
    const choices = (resp.choices as Record<string, unknown>[]) ?? [];
    const content = ((choices[0]?.message ?? {}) as Record<string, unknown>).content;
    if (typeof content !== "string" || !content.trim()) return null;
    return parseJevReply(content);
  };
}
