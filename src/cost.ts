// src/cost.ts — P2-2：成本可预测（硬顶）。
//
// 别家 agent 普遍只报 token，不报钱；报钱的也多是"事后估算"。这里的目标是
// **运行中就能判定超支并中止**，且严格守住一条诚实原则：
//
//   没有拿到 provider 报告的 usage 时，绝不编造金额。
//
// 所以 CostGuard 的返回值区分三种状态：
//   - priced:    有单价 + 有 usage  → 能算出确定的金额
//   - unpriced:  有 usage 但没配单价 → 金额未知，只报 token
//   - missing:   连 usage 都没报     → 金额未知，且明确告诉调用方"数据不全"
//
// 超支判定只在 priced 状态下成立；unpriced/missing 一律返回"无法判定"，
// 由调用方决定是提示还是继续（默认继续，不假装封顶）。
import type { UsageSnapshot } from "./usage.ts";
import { t } from "./i18n.ts";

export interface Pricing {
  /** 每 100 万输入 token 的美元单价。 */
  inputPer1M: number;
  /** 每 100 万输出 token 的美元单价。 */
  outputPer1M: number;
}

export type CostStatus = "priced" | "unpriced" | "missing";

export interface CostEstimate {
  status: CostStatus;
  /** 已花费（美元）；status !== "priced" 时为 null——不编造。 */
  spentUsd: number | null;
  /** 上限（美元）；未设置时为 null。 */
  limitUsd: number | null;
  /** 剩余（美元）；无法计算时为 null。 */
  remainingUsd: number | null;
  /** 是否已超上限（只有 priced 状态才可能为 true）。 */
  exceeded: boolean;
  /** 为什么无法给出金额（unpriced / missing 时非空）。 */
  reason?: string;
}

/** 从 config 的 pricing 表里按模型名取单价；支持前缀匹配（deepseek-v4 覆盖 deepseek-v4-pro）。 */
export function resolvePricing(table: unknown, model: string | null | undefined): Pricing | null {
  if (!table || typeof table !== "object" || !model) return null;
  const entries = Object.entries(table as Record<string, unknown>);
  const normalize = (p: unknown): Pricing | null => {
    if (!p || typeof p !== "object") return null;
    const obj = p as Record<string, unknown>;
    const i = Number(obj.input_per_1m ?? obj.inputPer1M);
    const o = Number(obj.output_per_1m ?? obj.outputPer1M);
    if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return null;
    return { inputPer1M: i, outputPer1M: o };
  };
  // 精确匹配优先
  for (const [k, v] of entries) {
    if (k === model) {
      const p = normalize(v as Pricing);
      if (p) return p;
    }
  }
  // 其次最长前缀匹配（deepseek-v4 命中 deepseek-v4-pro）
  let best: { key: string; pricing: Pricing } | null = null;
  for (const [k, v] of entries) {
    if (!model.startsWith(k)) continue;
    const p = normalize(v as Pricing);
    if (!p) continue;
    if (!best || k.length > best.key.length) best = { key: k, pricing: p };
  }
  return best?.pricing ?? null;
}

/** 按单价与 token 数算钱；token 缺失返回 null。 */
export function computeCostUsd(
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  pricing: Pricing,
): number | null {
  const p = typeof promptTokens === "number" && Number.isFinite(promptTokens) ? promptTokens : null;
  const c = typeof completionTokens === "number" && Number.isFinite(completionTokens) ? completionTokens : null;
  if (p === null && c === null) return null;
  return ((p ?? 0) / 1_000_000) * pricing.inputPer1M + ((c ?? 0) / 1_000_000) * pricing.outputPer1M;
}

/**
 * 估一次运行的成本。严格区分"能算 / 算不出"：
 * 只要 provider 有没报 usage 的调用（missing_calls > 0），金额就不完整——此时返回
 * unpriced/missing 而不是把已知部分当成全部（那会低报，正是硬顶最不能犯的错）。
 */
export function estimateCost(snapshot: UsageSnapshot, pricing: Pricing | null, limitUsd: number | null): CostEstimate {
  const limit = typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd >= 0 ? limitUsd : null;
  if (!pricing) {
    return {
      status: "unpriced",
      spentUsd: null,
      limitUsd: limit,
      remainingUsd: null,
      exceeded: false,
      reason: "未配置该模型的单价（config.pricing），无法计算金额",
    };
  }
  if (snapshot.reported_calls === 0) {
    return {
      status: "missing",
      spentUsd: null,
      limitUsd: limit,
      remainingUsd: null,
      exceeded: false,
      reason: "provider 未上报 usage，无法计算金额",
    };
  }
  if (snapshot.missing_calls > 0) {
    return {
      status: "unpriced",
      spentUsd: null,
      limitUsd: limit,
      remainingUsd: null,
      exceeded: false,
      reason: `有 ${snapshot.missing_calls} 次调用未上报 usage，金额不完整，不做超支判定`,
    };
  }
  const spent = computeCostUsd(snapshot.prompt_tokens, snapshot.completion_tokens, pricing);
  if (spent === null) {
    return {
      status: "unpriced",
      spentUsd: null,
      limitUsd: limit,
      remainingUsd: null,
      exceeded: false,
      reason: "usage 里没有可用的 token 数",
    };
  }
  const remaining = limit === null ? null : Math.max(0, limit - spent);
  return {
    status: "priced",
    spentUsd: spent,
    limitUsd: limit,
    remainingUsd: remaining,
    exceeded: limit !== null && spent > limit,
  };
}

/** 人类可读的一行成本摘要（用于 stderr / 事件）。 */
export function formatCost(e: CostEstimate): string {
  if (e.status !== "priced" || e.spentUsd === null) {
    return `成本：未知（${e.reason ?? "数据不足"}）`;
  }
  const spent = `$${e.spentUsd.toFixed(4)}`;
  if (e.limitUsd === null) return `成本：${spent}（未设上限）`;
  return `成本：${spent} / 上限 $${e.limitUsd.toFixed(2)}（剩余 $${(e.remainingUsd ?? 0).toFixed(4)}）`;
}

// ---- 月度限额已移除（2026-11-27，用户令“月度限额全去”）----
// 月度上限（config.monthly_cost_limit_usd / --monthly-max-cost /
// resolveMonthlyLimit / checkMonthlyCap / monthlyCapDecided）整个拿掉：
// 不再按月拦花费。本月花费的记账与展示照常（UsageLedger.monthTotal +
// McpCostTracker，本月已花仍能在 nyra cost / nyra budget / nyra stats
// 里看见）；拦花费只剩两样：单次运行硬顶（--max-cost）与分层每日上限
// （agent 层 dayUsd/dayTokens）。

// ---- P2-1：运行前成本预估 ----
// 纪律：估算必须**明说假设**，且给区间而不是一个精确数字。任何"精确预估"都是骗人：
// 实际花多少取决于模型实际吐多少 token 与工具返回多长。
export interface EstimateRunInput {
  /** 任务文本字符数。 */
  taskChars: number;
  /** 系统提示词字符数（技能/记忆/规则都算在内）。 */
  systemChars?: number;
  /** 预计轮次（通常是 max_turns）。 */
  turns: number;
  pricing: Pricing;
  /** 每轮助手输出 token 的经验值（默认 400）。 */
  outputTokensPerTurn?: number;
  /** 每轮工具结果 token 的经验值（默认 800）。 */
  toolTokensPerTurn?: number;
}

export interface RunCostEstimate {
  optimisticUsd: number;
  typicalUsd: number;
  pessimisticUsd: number;
  /** 估算用到的假设，必须原样展示给用户。 */
  assumptions: string[];
  /** 估算用的 token 口径，便于用户自己复核。 */
  tokens: { prompt: number; completion: number };
}

/** 字符 → token 的粗略换算。中文按 ~1.6 字符/token，英文按 ~4 字符/token，混排取 2.5。 */
export const CHARS_PER_TOKEN = 2.5;

export function estimateRunCost(input: EstimateRunInput): RunCostEstimate {
  const outPerTurn = Math.max(1, input.outputTokensPerTurn ?? 400);
  const toolPerTurn = Math.max(0, input.toolTokensPerTurn ?? 800);
  const basePrompt = Math.ceil((Math.max(0, input.taskChars) + Math.max(0, input.systemChars ?? 0)) / CHARS_PER_TOKEN);
  const turns = Math.max(1, Math.floor(input.turns));

  // 上下文随轮次累积：第 n 轮的 prompt ≈ 基础 + 前 n-1 轮的新增内容
  const promptAt = (n: number) => basePrompt + (n - 1) * (outPerTurn + toolPerTurn);
  const sumPrompt = (n: number) => {
    let total = 0;
    for (let i = 1; i <= n; i++) total += promptAt(i);
    return total;
  };

  const scenario = (n: number) => {
    const prompt = sumPrompt(n);
    const completion = n * outPerTurn;
    return computeCostUsd(prompt, completion, input.pricing) ?? 0;
  };

  const optimistic = scenario(Math.min(2, turns));
  const typical = scenario(Math.max(1, Math.ceil(turns / 2)));
  const pessimistic = scenario(turns);

  return {
    optimisticUsd: optimistic,
    typicalUsd: typical,
    pessimisticUsd: pessimistic,
    tokens: { prompt: sumPrompt(turns), completion: turns * outPerTurn },
    assumptions: [
      t("cost.asm.chars", { c: CHARS_PER_TOKEN }),
      t("cost.asm.perTurn", { out: outPerTurn, tool: toolPerTurn }),
      t("cost.asm.turns", { opt: Math.min(2, turns), typ: Math.max(1, Math.ceil(turns / 2)), pes: turns }),
      t("cost.asm.context"),
      t("cost.asm.usage"),
    ],
  };
}

// ---- 回忆感知的成本估算（让"省了多少"变成数字）----
// 前面的省钱手段都有实测数字，只有跨会话回忆没有。这里给一个**保守且明说假设**的投影：
// 有可复用历史时，探索轮次会减少——但减少多少取决于历史有多贴合，无法精确预测。
//
// 假设（写死在下面，也写进 note）：
//   - 每条可复用历史平均省 2 轮探索
//   - 但最多只省总轮次的 40%（避免"有 10 条历史就说几乎不用跑"这种不实宣传）
export const TURNS_SAVED_PER_RECALL = 2;
export const MAX_RECALL_TURN_SAVING_RATIO = 0.4;

export interface RecallAdjustedEstimate {
  /** 预计省下的轮次。 */
  savedTurns: number;
  /** 调整后的三档（金额）。 */
  optimisticUsd: number;
  typicalUsd: number;
  pessimisticUsd: number;
  /** 省下的比例（相对原悲观档）。 */
  savingRatio: number;
  /** 明说假设的一句话。 */
  note: string;
}

/**
 * 把「有 N 条历史可复用」折算进成本估算。
 * 没有历史时原样返回（savedTurns = 0，note 说明没有可复用的历史）。
 */
export function adjustEstimateForRecall(
  base: RunCostEstimate,
  recalledCount: number,
  opts: { turns: number; pricing: Pricing },
): RecallAdjustedEstimate {
  const turns = Math.max(1, Math.floor(opts.turns));
  const perTurn = (n: number) => {
    // 复用 estimateRunCost 同一套口径：按调整后的轮次重算
    return estimateRunCost({
      taskChars: 0,
      systemChars: 0,
      turns: n,
      pricing: opts.pricing,
    });
  };
  // NaN / Infinity / 负数 都按"没有历史"处理——否则 Math.min 会传播 NaN，
  // 算出 savedTurns = NaN、金额 = NaN，比不估算更糟。
  const count = Number.isFinite(recalledCount) ? Math.max(0, Math.floor(recalledCount)) : 0;
  if (count <= 0) {
    return {
      savedTurns: 0,
      optimisticUsd: base.optimisticUsd,
      typicalUsd: base.typicalUsd,
      pessimisticUsd: base.pessimisticUsd,
      savingRatio: 0,
      note: "没有可复用的历史：估算按从零探索计算",
    };
  }
  const rawSaving = count * TURNS_SAVED_PER_RECALL;
  const cap = Math.floor(turns * MAX_RECALL_TURN_SAVING_RATIO);
  const savedTurns = Math.max(0, Math.min(rawSaving, cap, turns - 1));
  const adjustedTurns = Math.max(1, turns - savedTurns);
  const adj = perTurn(adjustedTurns);
  const savingRatio = base.pessimisticUsd > 0
    ? Math.max(0, (base.pessimisticUsd - adj.pessimisticUsd) / base.pessimisticUsd)
    : 0;
  return {
    savedTurns,
    optimisticUsd: adj.optimisticUsd,
    typicalUsd: adj.typicalUsd,
    pessimisticUsd: adj.pessimisticUsd,
    savingRatio,
    note: `有 ${count} 条历史可复用：按每条省 ${TURNS_SAVED_PER_RECALL} 轮、最多省 ${(MAX_RECALL_TURN_SAVING_RATIO * 100).toFixed(0)}% 轮次估算，预计省 ${savedTurns} 轮（${(savingRatio * 100).toFixed(1)}%）`,
  };
}
