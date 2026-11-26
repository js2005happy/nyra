// src/usageMeter.ts — M1（OpenMausBot 用量上限借鉴）：每 Bot 用量仪表。
//
// 借的只是“按 Bot 分 + 界面可见”这两点，不借 OMB 的宽松语义：
// Nyra 的硬顶不变——调用前预留、未知单价暂停、日/月上限触顶就停
// （只停该 Bot 的新工作，已跑起来的回合由 checkCost 硬停兜底）。
//
// 本模块是纯展示层：数字全部来自用量账本（usageLedger）与分层判定
// （costCaps.evaluateTieredCaps），不另算一遍花费、不编“未归属”
// 的归属。80% 告警线与判定层同一条（见 costCaps.tierWarnings）。
import { evaluateTieredCaps, listCaps, listPauses } from "./costCaps.ts";
import { UsageLedger, localDateString, monthKeyString, nextMonthlyResetDate } from "./usageLedger.ts";
import { SOUL_AGENT_ID_RE } from "./soul.ts";

/** 80% 告警线：用到八成就变琥珀条（与判定层 tierWarnings 同一条线）。 */
export const USAGE_WARN_PCT = 0.8;

export interface UsageWindow {
  period: "day" | "month";
  /** 今日 / 本月。 */
  label: string;
  /** 重置日：每日是明天 0 点（本地日期），每月是下月 1 日。 */
  reset: string;
  spentUsd: number;
  spentTokens: number;
  calls: number;
  capUsd: number | null;
  capTokens: number | null;
  pctUsd: number | null;
  pctTokens: number | null;
  exceeded: boolean;
  /** 任一口径用到 80% 以上（未超）。 */
  warning: boolean;
  /** 美元数是否可判定（有未计价的调用时为 false，数字只是下界）。 */
  usdKnown: boolean;
}

export interface AgentUsage {
  agent: string;
  day: UsageWindow;
  month: UsageWindow;
  /** 该 agent 现在有没有未决的上限暂停。 */
  paused: boolean;
}

export interface UsageReport {
  month: string;
  day: string;
  agents: AgentUsage[];
  /** 当月未归属到任何 agent 的花费（分层数是下界，见 costCaps）。 */
  unattributedUsd: number;
  unattributedTokens: number;
}

/** 用量条（纯函数）：满格 20 格，pct 为 null（算不出）时写“未知”。 */
export function usageBar(pct: number | null, width = 20): string {
  if (pct === null || !Number.isFinite(pct)) return "未知";
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function pctOf(spent: number, cap: number | null): number | null {
  if (cap === null || cap <= 0) return null;
  return spent / cap;
}

function nextDayString(d = new Date()): string {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return localDateString(next);
}

function windowFromEvaluation(
  period: "day" | "month",
  label: string,
  reset: string,
  ev: { layers: { scope: string; period?: "month" | "day"; capUsd: number | null; spentUsd: number; usdKnown: boolean; capTokens: number | null; spentTokens: number; exceeded: boolean }[]; warnings: { scope: string; period: "month" | "day" }[] },
  agent: string,
  ledger: UsageLedger,
): UsageWindow {
  const scope = period === "day" ? `agent:${agent}:day` : `agent:${agent}`;
  const layer = ev.layers.find((l) => l.scope === scope);
  const spent = period === "day"
    ? ledger.dayAgentTotal(localDateString(), agent)
    : ledger.monthAgentTotal(monthKeyString(), agent);
  const capUsd = layer?.capUsd ?? null;
  const capTokens = layer?.capTokens ?? null;
  const spentUsd = layer?.spentUsd ?? spent.spentUsd;
  const spentTokens = layer?.spentTokens ?? spent.totalTokens;
  const pctUsd = pctOf(spentUsd, capUsd);
  const pctTokens = pctOf(spentTokens, capTokens);
  return {
    period,
    label,
    reset,
    spentUsd,
    spentTokens,
    calls: spent.calls,
    capUsd,
    capTokens,
    pctUsd,
    pctTokens,
    exceeded: layer?.exceeded ?? false,
    warning: ev.warnings.some((w) => w.scope === scope && w.period === period),
    usdKnown: layer?.usdKnown ?? spent.spentUsd > 0,
  };
}

/**
 * 拼一份用量报告。agent 不给时列出所有“有上限或本月/当日有花费”的
 * agent；给了时只报那一个（id 非法直接抛错，不静默报全部）。
 * 数字只来自账本与分层判定；没设上限的窗口 cap 为 null（“不限”，不编数）。
 */
export function buildUsageReport(home: string, agent?: string): UsageReport {
  const month = monthKeyString();
  const day = localDateString();
  const ledger = new UsageLedger(home);
  const names = new Set<string>();
  if (agent !== undefined) {
    const id = agent.trim();
    if (!SOUL_AGENT_ID_RE.test(id)) throw new Error(`agent id 无效：${JSON.stringify(agent)}（小写字母开头，字母数字/_/-，最长 32 字）`);
    names.add(id);
  } else {
    for (const c of listCaps(home)) {
      if (c.kind === "agent") names.add(c.scope.slice("agent:".length));
    }
    for (const a of ledger.monthSpendByAgent(month).byAgent.keys()) names.add(a);
    for (const a of ledger.daySpendByAgent(day).byAgent.keys()) names.add(a);
  }
  const byAgent = ledger.monthSpendByAgent(month);
  const agents: AgentUsage[] = [];
  for (const id of [...names].sort()) {
    let ev;
    try {
      ev = evaluateTieredCaps(home, { agent: id });
    } catch {
      continue;
    }
    const paused = listPauses(home, { status: "paused", agent: id }).length > 0;
    agents.push({
      agent: id,
      day: windowFromEvaluation("day", "今日", nextDayString(), ev, id, ledger),
      month: windowFromEvaluation("month", "本月", nextMonthlyResetDate(), ev, id, ledger),
      paused,
    });
  }
  return {
    month,
    day,
    agents,
    unattributedUsd: byAgent.unattributed.spentUsd,
    unattributedTokens: byAgent.unattributed.totalTokens,
  };
}

function fmtMoney(v: number): string {
  return `$${v.toFixed(4)}`;
}

function fmtWindow(w: UsageWindow): string[] {
  const lines: string[] = [];
  const usd = w.capUsd === null
    ? `美元 ${fmtMoney(w.spentUsd)}（不限）`
    : `美元 ${fmtMoney(w.spentUsd)} / $${w.capUsd.toFixed(2)} ${usageBar(w.pctUsd)}${w.pctUsd === null ? "" : ` ${(w.pctUsd * 100).toFixed(0)}%`}`;
  const tok = w.capTokens === null
    ? `token ${w.spentTokens.toLocaleString("en-US")}（不限）`
    : `token ${w.spentTokens.toLocaleString("en-US")} / ${w.capTokens.toLocaleString("en-US")} ${usageBar(w.pctTokens)}${w.pctTokens === null ? "" : ` ${(w.pctTokens * 100).toFixed(0)}%`}`;
  const state = w.exceeded ? " ← 已超限，停了" : w.warning ? " ← 到 80% 了" : "";
  lines.push(`  ${w.label}（${w.reset}重置）：${usd}；${tok}${state}`);
  // 只有“有调用、但美元没计价”时才提醒下界；零调用时没调用可言，不写这句。
  if (w.calls > 0 && !w.usdKnown) lines.push("    注意：当日/当月有未计价的调用，美元数只是下界");
  return lines;
}

/** 报告转终端文本（纯函数）：每个 agent 两行用量条 + 状态。 */
export function formatUsageReport(report: UsageReport): string[] {
  const lines: string[] = [];
  lines.push(`用量（${report.day}，按 Bot 分；美元数是下界，未归属/未计价的部分不摊到任何 Bot）`);
  if (report.agents.length === 0) {
    lines.push("还没有任何 Bot 的用量（没设上限、也没产生过归属花费）。");
    lines.push("设上限：nyra governance caps set --scope agent:<id> --usd <美元> --day-usd <美元> --reason <原因>");
    return lines;
  }
  for (const a of report.agents) {
    lines.push(`${a.agent}${a.paused ? "（已暂停：上限触顶，等处理）" : ""}：`);
    lines.push(...fmtWindow(a.day));
    lines.push(...fmtWindow(a.month));
  }
  if (report.unattributedUsd > 0 || report.unattributedTokens > 0) {
    lines.push(`未归属：$${report.unattributedUsd.toFixed(4)} / ${report.unattributedTokens.toLocaleString("en-US")} token（CLI 交互运行与网关会话的花费，分不下去，只算组织级总数）`);
  }
  return lines;
}
