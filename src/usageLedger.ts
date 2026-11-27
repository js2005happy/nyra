// src/usageLedger.ts — 每日用量账本：热力图与本月花费记账的同一份事实源。
//
// 为什么要这个文件：用量统计（UsageTracker）以前只活在一次运行的内存里，
// 进程一退就没了。热力图要“每日”口径、本月花费展示要“自然月累计”口径，
// 两者都得落盘——但都不另起一套数字：账本只记 provider 实报的 token 与
// CostGuard 已算出的金额（estimateCost 同口径），没报 usage / 没配单价
// 的部分记 token、不记金额，并如实标“未计价”，绝不估算补齐。
//
// 记账口径（delta 制，不重复计）：
//   - 每次 flush 传本次运行的累计快照 + 上次 flush 时的快照，只把增量写一行；
//   - 子任务（delegate）的用量是独立累计，由父级在 delegate_usage 事件里
//     以“全量当增量”（prev=null）记一笔，不与父级快照混算；
//   - 进程中途崩溃会丢掉最后一次 flush 之后的那点增量——账本是尽力而为，
//     热力图与月度累计都按“已落盘的记录”算，不宣称精确到每一分钱。
//   - 损坏行直接跳过（读时不抛错），不让账本拖垮运行。
//
// 日期一律按本地时区（用户的日子，不是 UTC）：热力图按本地日分格，
// 月度累计按本地自然月。MCP 花费另见 src/mcpCost.ts 的 monthTotalUsd，
// 同样按本地月汇总，两边相加才是“本月全部花费”。
import { appendFileSync, existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import type { UsageSnapshot } from "./usage.ts";
import { t } from "./i18n.ts";

export const USAGE_LEDGER_FILE = "usage_daily.jsonl";

/** 本地日期 YYYY-MM-DD（按本地时区，不是 UTC）。 */
export function localDateString(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地自然月 YYYY-MM。 */
export function monthKeyString(d = new Date()): string {
  return localDateString(d).slice(0, 7);
}

/** 下月 1 日（本地日期）：本月花费展示的重置日（月度上限已移除，只用于记账展示）。 */
export function nextMonthlyResetDate(d = new Date()): string {
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return localDateString(next);
}

export interface LedgerRecord {
  date: string;
  month: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
  /** 本笔增量的已花费（美元）；未计价（没配单价/没报 usage）时为 null。 */
  spent_usd: number | null;
  model: string | null;
  /**
   * 缺口 43 第三批：分层成本上限的归属——这笔增量是哪个 agent 花的。
   * 只有调用方知道 agent id 时才记（Bot 运行、带 --agent 的定时任务）；
   * 不知道时不记（CLI 交互运行、网关会话），这类行算“未归属”，组织级
   * 月度口径照样计入，分层口径里只能当下界（见 monthSpendByAgent）。
   * 旧行没有这个字段，读时按未归属处理，不改写历史。
   */
  agent?: string | null;
}

export interface DayTotal {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
  /** 当日已计价花费合计；一天里没有任何一笔计价时为 null。 */
  spent: number | null;
  /** 当日是否有未计价的用量（有则花费只是下界）。 */
  incomplete: boolean;
}

/** 缺口 43 第三批：某 agent 某自然月的花费（分层上限用）。 */
export interface AgentMonthSpend {
  spentUsd: number;
  totalTokens: number;
  calls: number;
}

function zeroDay(): DayTotal {
  return { prompt: 0, completion: 0, total: 0, calls: 0, spent: null, incomplete: false };
}

export class UsageLedger {
  home: string;
  file: string;
  constructor(home?: string) {
    this.home = resolveNyraHome(home);
    this.file = join(this.home, USAGE_LEDGER_FILE);
  }

  /**
   * 记一笔增量。snapshot 是本次累计，prev 是上次 flush 时的累计（null =
   * 该累计第一次记，全量当增量，例如子任务的独立快照）。
   * spentUsd / prevSpentUsd 与 token 数一一对应（同一次 estimateCost 的结果）。
   * 增量全为 0 时不写行（返回 null）；写盘失败返回 null，绝不抛错。
   * agentId（缺口 43 第三批）：调用方知道 agent id 时传，分层上限按它
   * 归属；不知道时传 null/不传，记为未归属——账本写失败与否都不抛错，
   * 归属字段更不会破坏运行。
   */
  recordDelta(
    snapshot: UsageSnapshot,
    prev: UsageSnapshot | null,
    spentUsd: number | null,
    prevSpentUsd: number | null,
    model: string | null,
    now = new Date(),
    agentId?: string | null,
  ): LedgerRecord | null {
    const delta = (cur: number | null, old: number | null): number => {
      const c = typeof cur === "number" && Number.isFinite(cur) ? cur : 0;
      const o = old === null ? 0 : (typeof old === "number" && Number.isFinite(old) ? old : 0);
      return Math.max(0, c - o);
    };
    const prompt = delta(snapshot.prompt_tokens, prev?.prompt_tokens ?? null);
    const completion = delta(snapshot.completion_tokens, prev?.completion_tokens ?? null);
    const total = delta(snapshot.total_tokens, prev?.total_tokens ?? null);
    const calls = Math.max(0, snapshot.calls - (prev?.calls ?? 0));
    const spentDelta =
      typeof spentUsd === "number" && Number.isFinite(spentUsd)
        ? Math.max(0, spentUsd - (typeof prevSpentUsd === "number" && Number.isFinite(prevSpentUsd) ? prevSpentUsd : 0))
        : null;
    // 零增量（token 与金额都没变）不写行：$0 的空行只是噪音。
    if (prompt === 0 && completion === 0 && total === 0 && calls === 0 && (spentDelta === null || spentDelta === 0)) return null;
    const rec: LedgerRecord = {
      date: localDateString(now),
      month: monthKeyString(now),
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      calls,
      spent_usd: spentDelta,
      model: model ?? null,
      // agent 归属：只认合法的 agent id 格式，其他值按未归属处理（不抛错）。
      agent: typeof agentId === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(agentId) ? agentId : null,
    };
    try {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf-8");
      try { chmodSync(this.file, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
    } catch {
      return null;
    }
    return rec;
  }

  /** 读全部记录；损坏行跳过。 */
  readAll(): LedgerRecord[] {
    if (!existsSync(this.file)) return [];
    const out: LedgerRecord[] = [];
    for (const line of readFileSync(this.file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LedgerRecord;
        if (rec && typeof rec === "object" && typeof rec.date === "string" && typeof rec.month === "string") out.push(rec);
      } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  /** 最近 days 天（到今天为止）的每日合计；没有记录的日子返回全 0。 */
  dailyTotals(days: number, now = new Date()): Map<string, DayTotal> {
    const n = Math.max(1, Math.floor(days));
    const days_ = new Map<string, DayTotal>();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      days_.set(localDateString(d), zeroDay());
    }
    for (const rec of this.readAll()) {
      const day = days_.get(rec.date);
      if (!day) continue;
      day.prompt += rec.prompt_tokens || 0;
      day.completion += rec.completion_tokens || 0;
      day.total += rec.total_tokens || 0;
      day.calls += rec.calls || 0;
      if (typeof rec.spent_usd === "number") day.spent = (day.spent ?? 0) + rec.spent_usd;
      else day.incomplete = true;
    }
    return days_;
  }

  /**
   * 某自然月的 LLM 花费合计（已落盘部分）。
   * spentUsd 是下界：当月有未计价记录时 incomplete=true，实际花费只会更高。
   * （月度上限已移除：这个下界现在只用于记账展示与分层每日上限的参考，
   * 不再触发任何月度判定。）
   */
  monthTotal(month: string): { spentUsd: number; incomplete: boolean; totalTokens: number; calls: number } {
    let spent = 0;
    let incomplete = false;
    let totalTokens = 0;
    let calls = 0;
    for (const rec of this.readAll()) {
      if (rec.month !== month) continue;
      totalTokens += rec.total_tokens || 0;
      calls += rec.calls || 0;
      if (typeof rec.spent_usd === "number") spent += rec.spent_usd;
      else incomplete = true;
    }
    return { spentUsd: spent, incomplete, totalTokens, calls };
  }

  // ---- 缺口 43 第三批：分层成本上限的按 agent 花费 ----
  // 一次读全月记录，按 agent 归属分组；没有 agent 字段的行（旧行与调用方
  // 不知道 agent 的行）进 unattributed。分层口径的诚实边界：某 agent 的
  // 花费只是下界（未归属的部分分不下去），只会晚触发、不会误触发。

  /** 某自然月按 agent 分组的花费 + 未归属部分（一次读盘）。 */
  monthSpendByAgent(month: string): { byAgent: Map<string, AgentMonthSpend>; unattributed: AgentMonthSpend } {
    const byAgent = new Map<string, AgentMonthSpend>();
    const unattributed: AgentMonthSpend = { spentUsd: 0, totalTokens: 0, calls: 0 };
    for (const rec of this.readAll()) {
      if (rec.month !== month) continue;
      const target = typeof rec.agent === "string" && rec.agent
        ? (byAgent.get(rec.agent) ?? { spentUsd: 0, totalTokens: 0, calls: 0 })
        : unattributed;
      if (typeof rec.agent === "string" && rec.agent) byAgent.set(rec.agent, target);
      target.totalTokens += rec.total_tokens || 0;
      target.calls += rec.calls || 0;
      if (typeof rec.spent_usd === "number") target.spentUsd += rec.spent_usd;
    }
    return { byAgent, unattributed };
  }

  /** 某 agent 某自然月的花费；incomplete=true 表示当月有未归属/未计价的
   * 花费，该 agent 的数字只是下界（与 monthTotal 的 incomplete 同口径）。 */
  monthAgentTotal(month: string, agent: string): { spentUsd: number; incomplete: boolean; totalTokens: number; calls: number } {
    const { byAgent, unattributed } = this.monthSpendByAgent(month);
    const mine = byAgent.get(agent) ?? { spentUsd: 0, totalTokens: 0, calls: 0 };
    let incomplete = unattributed.spentUsd > 0 || unattributed.totalTokens > 0;
    if (!incomplete) {
      for (const rec of this.readAll()) {
        if (rec.month !== month) continue;
        if (rec.agent === agent && typeof rec.spent_usd !== "number" && (rec.total_tokens || 0) > 0) { incomplete = true; break; }
      }
    }
    return { spentUsd: mine.spentUsd, incomplete, totalTokens: mine.totalTokens, calls: mine.calls };
  }

  // ---- M1（OpenMausBot 用量上限借鉴）：按日按 agent 分组 ----
  // 与 monthSpendByAgent 同款口径，只是窗口换成自然日（本地日期
  // YYYY-MM-DD）。日上限的判定与月上限同一份数、同一诚实边界。

  /** 某自然日按 agent 分组的花费 + 未归属部分（一次读盘）。 */
  daySpendByAgent(date: string): { byAgent: Map<string, AgentMonthSpend>; unattributed: AgentMonthSpend } {
    const byAgent = new Map<string, AgentMonthSpend>();
    const unattributed: AgentMonthSpend = { spentUsd: 0, totalTokens: 0, calls: 0 };
    for (const rec of this.readAll()) {
      if (rec.date !== date) continue;
      const target = typeof rec.agent === "string" && rec.agent
        ? (byAgent.get(rec.agent) ?? { spentUsd: 0, totalTokens: 0, calls: 0 })
        : unattributed;
      if (typeof rec.agent === "string" && rec.agent) byAgent.set(rec.agent, target);
      target.totalTokens += rec.total_tokens || 0;
      target.calls += rec.calls || 0;
      if (typeof rec.spent_usd === "number") target.spentUsd += rec.spent_usd;
    }
    return { byAgent, unattributed };
  }

  /** 某 agent 某自然日的花费；incomplete 的口径与 monthAgentTotal 同款。 */
  dayAgentTotal(date: string, agent: string): { spentUsd: number; incomplete: boolean; totalTokens: number; calls: number } {
    const { byAgent, unattributed } = this.daySpendByAgent(date);
    const mine = byAgent.get(agent) ?? { spentUsd: 0, totalTokens: 0, calls: 0 };
    let incomplete = unattributed.spentUsd > 0 || unattributed.totalTokens > 0;
    if (!incomplete) {
      for (const rec of this.readAll()) {
        if (rec.date !== date) continue;
        if (rec.agent === agent && typeof rec.spent_usd !== "number" && (rec.total_tokens || 0) > 0) { incomplete = true; break; }
      }
    }
    return { spentUsd: mine.spentUsd, incomplete, totalTokens: mine.totalTokens, calls: mine.calls };
  }
}

const HEAT_BLOCKS = ["·", "░", "▒", "▓", "█"];

function money(v: number | null): string {
  return typeof v === "number" ? `$${v.toFixed(4)}` : t("stats.spentUnknown");
}

/**
 * 终端热力图（纯函数）：行 = 周（最旧在上、最近在下），列 = 周一…周日；
 * 格子深浅按单日 token 量相对当期最高值分档（不抄别家配色与文案，
 * 只借“每日一格”这个形态）。每天的精确数字另在下方逐日列出——
 * 格子只管“一眼看趋势”，精确值不靠深浅猜。
 */
export function formatHeatmap(daily: Map<string, DayTotal>, opts: { weeks: number; today?: Date }): string {
  const weeks = Math.max(1, Math.min(52, Math.floor(opts.weeks)));
  const today = opts.today ?? new Date();
  const dates: string[] = [];
  const totalDays = weeks * 7;
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dates.push(localDateString(d));
  }
  let max = 0;
  let total = 0;
  let spent: number | null = null;
  let incomplete = false;
  for (const date of dates) {
    const day = daily.get(date) ?? zeroDay();
    max = Math.max(max, day.total);
    total += day.total;
    if (day.spent !== null) spent = (spent ?? 0) + day.spent;
    if (day.incomplete) incomplete = true;
  }
  const lines = [t("stats.heatmapTitle", { weeks, total: total.toLocaleString("en-US"), spent: money(spent) + (incomplete ? " " + t("run.statsPartial") : "") })];
  if (max === 0) {
    lines.push(t("stats.empty"));
    return lines.join("\n");
  }
  // 第一周可能从周一之前开始：按“周一为列首”对齐，周期外的格子留空。
  const first = new Date(dates[0] + "T00:00:00");
  const leadBlanks = (first.getDay() + 6) % 7; // 周一=0 … 周日=6
  const cells: string[] = Array.from({ length: leadBlanks }, () => " ");
  for (const date of dates) {
    const day = daily.get(date) ?? zeroDay();
    const level = day.total === 0 ? 0 : day.total <= max / 4 ? 1 : day.total <= max / 2 ? 2 : day.total <= (max * 3) / 4 ? 3 : 4;
    cells.push(HEAT_BLOCKS[level]);
  }
  while (cells.length % 7 !== 0) cells.push(" ");
  lines.push(t("stats.heatmapWeekdays"));
  for (let w = 0; w < cells.length / 7; w++) {
    lines.push(cells.slice(w * 7, w * 7 + 7).join(" "));
  }
  lines.push(t("stats.heatmapLegend", { max: max.toLocaleString("en-US") }));
  // 精确值：最近 14 天逐日列出（有记录的日子才列，没用量不凑数）。
  const recent = dates.slice(-14);
  for (const date of recent) {
    const day = daily.get(date);
    if (!day || (day.total === 0 && day.calls === 0)) continue;
    lines.push(t("stats.heatmapDay", { date, tokens: day.total.toLocaleString("en-US"), spent: money(day.spent) }));
  }
  return lines.join("\n");
}
