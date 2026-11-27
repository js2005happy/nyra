// src/costCli.ts — P2-1：`nyra cost` 子命令。
//
//   nyra cost --estimate "<task>" [--turns N] [--system-chars N] [--model M]
//   nyra cost --show                    当前定价配置
//
// 输出原则：给区间 + 明写假设。不打印"精确预估"这种骗人的数字。
import { estimateRunCost, resolvePricing, formatCost, estimateCost, adjustEstimateForRecall, type Pricing } from "./cost.ts";
import { BudgetLedger, resolveStrictUnknownAmount } from "./budget.ts";
import { UsageLedger, monthKeyString, nextMonthlyResetDate } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { modelSwitchSummaryLine, summarizeModelSwitches } from "./modelSwitch.ts";
import type { UsageSnapshot } from "./usage.ts";
import { t } from "./i18n.ts";

function parseFlags(argv: string[]): { estimate?: string; show: boolean; json: boolean; turns: number; systemChars: number; model?: string } {
  const out = { estimate: undefined as string | undefined, show: false, json: false, turns: 20, systemChars: 2000, model: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
      if (a === "--show") out.show = true;
      else if (a === "--json") out.json = true;
    else if (a === "--estimate") out.estimate = next();
    else if (a === "--turns") out.turns = parseInt(next() ?? "20", 10);
    else if (a === "--system-chars") out.systemChars = parseInt(next() ?? "2000", 10);
    else if (a === "--model") out.model = next();
    else if (!a.startsWith("-") && out.estimate === undefined) out.estimate = a;
  }
  return out;
}

function printPricingTable(config: Record<string, unknown>, home?: string): void {
  const table = config.pricing;
  const entries = table && typeof table === "object" ? Object.entries(table as Record<string, unknown>) : [];
  if (entries.length === 0) {
    process.stdout.write(t("cost.pricingEmpty") + "\n");
    process.stdout.write(t("cost.pricingNoGuess") + "\n");
  } else {
    process.stdout.write(t("cost.pricingHead") + "\n");
    for (const [model, raw] of entries) {
      const p = resolvePricing({ [model]: raw }, model);
      if (!p) {
        process.stdout.write(`  ${model}：配置无效（已忽略）\n`);
        continue;
      }
      process.stdout.write(`  ${model}：输入 $${p.inputPer1M} / 输出 $${p.outputPer1M}\n`);
    }
  }
  const limit = typeof config.max_cost_usd === "number" ? config.max_cost_usd : null;
  process.stdout.write(t("cost.limitLine", { limit: limit === null ? t("cost.limitUnset") : "$" + limit.toFixed(2) }) + "\n");
  // 本月已花（记账展示，无月度上限；与 --max-cost 同口径的账本数）。
  if (home) {
    const month = monthKeyString();
    const llm = new UsageLedger(home).monthTotal(month);
    const mcp = new McpCostTracker(home).monthTotalUsd(month);
    const spent = llm.spentUsd + mcp;
    process.stdout.write(`本月已花：$${spent.toFixed(4)}（其中 MCP $${mcp.toFixed(4)}），${nextMonthlyResetDate()} 重置（仅记账，无月度上限）\n`);
    // 备用模型切换通知：本月切过模型时，定价汇总里同样加一行切换统计。
    const switchLine = modelSwitchSummaryLine(home);
    if (switchLine) process.stdout.write(switchLine + "\n");
    // 并发预算预留（可靠性打磨第 2 项第一批）：在途预留 + 严格模式。
    const budgetLedger = new BudgetLedger(home);
    budgetLedger.pruneExpired();
    const strict = resolveStrictUnknownAmount(config);
    process.stdout.write(`在途预留：$${budgetLedger.activeReservedUsd().toFixed(4)}；金额未知严格模式：${strict ? "开" : "关"}\n`);
  }
}

export function handleCost(argv: string[], config: Record<string, unknown>, model: string | null, opts?: { recalledCount?: number; home?: string }): number {
  const flags = parseFlags(argv);
  if (flags.show || (!flags.estimate && !flags.show)) {
    // --json：给 CI / 看板用（人看表格，机器拿结构）；契约同 savings/verdict。
    if (flags.json) {
      const monthly = opts?.home
        ? (() => {
          const month = monthKeyString();
          const llm = new UsageLedger(opts.home!).monthTotal(month);
          const mcp = new McpCostTracker(opts.home!).monthTotalUsd(month);
          return { spentUsd: llm.spentUsd + mcp, mcpUsd: mcp, month, resetAt: nextMonthlyResetDate(), modelSwitches: summarizeModelSwitches(opts.home!, month) };
        })()
        : null;
      process.stdout.write(JSON.stringify(buildCostJson({
        model: flags.model ?? model, config,
        // 并发预算预留（可靠性打磨第 2 项第一批）：在途预留 + 严格模式。
        budget: opts?.home
          ? (() => {
            const ledger = new BudgetLedger(opts.home!);
            ledger.pruneExpired();
            return { activeReservedUsd: ledger.activeReservedUsd(), strictUnknownAmount: resolveStrictUnknownAmount(config) };
          })()
          : null,
        monthly,
      })) + "\n");
      if (!flags.estimate) return 0;
    } else {
      printPricingTable(config, opts?.home);
      if (!flags.estimate) return 0;
    }
  }

  const task = flags.estimate ?? "";
  if (!task.trim()) {
    process.stderr.write("用法：nyra cost --estimate \"<任务>\"; nyra cost --show\n");
    return 2;
  }

  const useModel = flags.model ?? model;
  const pricing: Pricing | null = resolvePricing(config.pricing, useModel);
  if (!pricing) {
    process.stdout.write(t("cost.cannotEstimate", { model: useModel ?? "(未配置)" }) + "\n");
    process.stdout.write(t("cost.pricingExample") + "\n");
    return 0;
  }

  const est = estimateRunCost({
    taskChars: [...task].length,
    systemChars: flags.systemChars,
    turns: Number.isFinite(flags.turns) && flags.turns > 0 ? flags.turns : 20,
    pricing,
  });

  const money = (v: number) => `$${v.toFixed(4)}`;
  process.stdout.write(t("cost.title", { model: useModel ?? "", in: pricing.inputPer1M, out: pricing.outputPer1M }) + "\n");
  process.stdout.write(t("cost.taskLen", { chars: [...task].length, sys: flags.systemChars }) + "\n");
  process.stdout.write(t("cost.optimistic", { turns: Math.min(2, flags.turns), usd: money(est.optimisticUsd) }) + "\n");
  process.stdout.write(t("cost.typical", { turns: Math.max(1, Math.ceil(flags.turns / 2)), usd: money(est.typicalUsd) }) + "\n");
  process.stdout.write(t("cost.pessimistic", { turns: flags.turns, usd: money(est.pessimisticUsd) }) + "\n");
  process.stdout.write(t("cost.tokens", { prompt: est.tokens.prompt.toLocaleString(), completion: est.tokens.completion.toLocaleString() }) + "\n");
  process.stdout.write("\n" + t("cost.assumptions") + "\n");
  for (const a of est.assumptions) process.stdout.write(`  - ${a}\n`);
  // 回忆感知：有历史可复用时给出下调后的投影（假设写死在 adjustEstimateForRecall 里）
  if (typeof opts?.recalledCount === "number") {
    const adj = adjustEstimateForRecall(est, opts.recalledCount, { turns: flags.turns, pricing });
    process.stdout.write("\n" + adj.note + "\n");
    if (adj.savedTurns > 0) {
      process.stdout.write(t("cost.recallAdjusted", {
        before: est.pessimisticUsd.toFixed(4),
        after: adj.pessimisticUsd.toFixed(4),
      }) + "\n");
    }
  }
  process.stdout.write("\n" + t("cost.suggest", { usd: est.pessimisticUsd.toFixed(2) }) + "\n");
  return 0;
}

/** 供 doctor/自检复用：把一次已结束运行的成本摘要成一行。 */
export function summarizeRunCost(snapshot: UsageSnapshot, config: Record<string, unknown>, model: string | null, limit: number | null): string {
  return formatCost(estimateCost(snapshot, resolvePricing(config.pricing, model), limit));
}

// ---- 机器可读（nyra cost --show --json）----
// 与 `savings --json` / `verdict --json` 同一套契约纪律：只加字段、不改名、不删字段。
// 数字型字段用 null 表示"没配/算不出"，不用 0 冒充——CI 里 `cap === null` 才该报警，
// 写成 0 会变成"上限是 0 美元"，含义完全相反。

export const COST_JSON_SCHEMA = 1;

export interface CostJson {
  schema_version: number;
  /** 当前模型名（没配置时为 null）。 */
  model: string | null;
  pricing: { model: string; input_per_1m: number; output_per_1m: number }[];
  /** 配置里存在但解析失败的模型名（能被静默忽略才是真问题）。 */
  invalid_pricing: string[];
  max_cost_usd: number | null;
  monthly: {
    spent_usd: number;
    mcp_usd: number;
    month: string;
    reset_at: string | null;
    /** 本月模型切换统计（次数、触发原因分布、最近一次）；0 次时 count 为 0、last 为 null。 */
    model_switches: {
      count: number;
      by_trigger: Record<string, number>;
      last: { from: string; to: string; trigger: string; at: string } | null;
    };
  } | null;
  /** 并发预算预留（可靠性打磨第 2 项第一批）：在途预留 + 金额未知严格模式。 */
  budget: {
    active_reserved_usd: number;
    strict_unknown_amount: boolean;
  } | null;
}

/** 把 `--show` 要显示的东西整理成结构。纯函数之外的部分（账本）由调用方算好传入。 */
export function buildCostJson(input: {
  model: string | null;
  config: Record<string, unknown>;
  budget?: {
    activeReservedUsd: number; strictUnknownAmount: boolean;
  } | null;
  monthly: {
    spentUsd: number; mcpUsd: number; month: string; resetAt: string | null;
    modelSwitches?: { count: number; byTrigger: Record<string, number>; last: { from: string; to: string; trigger: string; at: string } | null };
  } | null;
}): CostJson {
  const table = input.config.pricing;
  const entries = table && typeof table === "object" ? Object.entries(table as Record<string, unknown>) : [];
  const pricing: CostJson["pricing"] = [];
  const invalid: string[] = [];
  for (const [name, raw] of entries) {
    const p = resolvePricing({ [name]: raw }, name);
    if (!p) { invalid.push(name); continue; }
    pricing.push({ model: name, input_per_1m: p.inputPer1M, output_per_1m: p.outputPer1M });
  }
  return {
    schema_version: COST_JSON_SCHEMA,
    model: input.model,
    pricing,
    invalid_pricing: invalid,
    max_cost_usd: typeof input.config.max_cost_usd === "number" ? input.config.max_cost_usd : null,
    monthly: input.monthly
      ? {
        spent_usd: input.monthly.spentUsd,
        mcp_usd: input.monthly.mcpUsd,
        month: input.monthly.month,
        reset_at: input.monthly.resetAt,
        model_switches: {
          count: input.monthly.modelSwitches?.count ?? 0,
          by_trigger: input.monthly.modelSwitches?.byTrigger ?? {},
          last: input.monthly.modelSwitches?.last
            ? { from: input.monthly.modelSwitches.last.from, to: input.monthly.modelSwitches.last.to, trigger: input.monthly.modelSwitches.last.trigger, at: input.monthly.modelSwitches.last.at }
            : null,
        },
      }
      : null,
    budget: input.budget
      ? { active_reserved_usd: input.budget.activeReservedUsd, strict_unknown_amount: input.budget.strictUnknownAmount }
      : null,
  };
}
