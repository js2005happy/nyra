// src/budgetCli.ts — 并发预算预留 CLI（可靠性打磨第 2 项第一批）。
//
//   nyra budget list [--json]              预留记录（在途 + 已结算/已释放历史）
//   nyra budget show [--json]              在途预留 + 本月已花 + 严格模式 + 待处理暂停
//   nyra budget reserve <金额> [--reason <原因>] [--ttl-ms <毫秒>]
//   nyra budget settle <预留 id> <实际花费>
//   nyra budget release <预留 id>
//   nyra budget strict [--on | --off] [--yes]
//
// 只读/只写预算账本与严格模式开关，不调模型、不改运行状态。金额单位都是美元。
// 手动预留不对照任何上限（月度限额已移除；单次运行上限没有运行上下文，查不了），只记账。
import { BudgetLedger, resolveStrictUnknownAmount } from "./budget.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { listPauses } from "./costCaps.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { UsageLedger, monthKeyString, nextMonthlyResetDate } from "./usageLedger.ts";

function budgetUsage(): string {
  return [
    "nyra budget — 并发预算预留（模型调用前先预留额度，超上限不发请求）",
    "",
    "  nyra budget list [--json]              预留记录（在途 + 已结算/已释放历史）",
    "  nyra budget show [--json]              在途预留 + 本月已花 + 严格模式 + 待处理暂停",
    "  nyra budget reserve <金额> [--reason <原因>] [--ttl-ms <毫秒>]",
    "  nyra budget settle <预留 id> <实际花费>",
    "  nyra budget release <预留 id>",
    "  nyra budget strict [--on | --off] [--yes]",
    "",
    "金额单位是美元。手动预留不对照任何上限（只记账）；strict 开着时（默认开），",
    "未配单价或调用缺用量会暂停运行等人工处理，恢复走 nyra governance caps resume。",
  ].join("\n");
}

/** 本月已花（账本数：LLM + MCP；未计价的部分不编进数字，见 UsageLedger）。 */
function monthSpentUsd(home: string): { spentUsd: number; incomplete: boolean; month: string } {
  const month = monthKeyString();
  const llm = new UsageLedger(home).monthTotal(month);
  const mcp = new McpCostTracker(home).monthTotalUsd(month);
  return { spentUsd: llm.spentUsd + mcp, incomplete: llm.incomplete, month };
}

export function budgetMain(args: string[], home: string): number {
  const cmd = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(budgetUsage());
    return 0;
  }
  const ledger = new BudgetLedger(home);
  if (cmd === "list") {
    ledger.pruneExpired();
    const reservations = ledger.list();
    if (json) {
      console.log(JSON.stringify({ reservations, active_reserved_usd: ledger.activeReservedUsd() }, null, 2));
      return 0;
    }
    if (reservations.length === 0) {
      console.log("没有预留记录。");
      return 0;
    }
    console.log(`预留记录（共 ${reservations.length} 条，在途 $${ledger.activeReservedUsd().toFixed(4)}）：`);
    for (const r of reservations) {
      const settled = r.status === "settled" && r.settledUsd !== null ? ` 实际=$${r.settledUsd.toFixed(4)}` : "";
      console.log(`- ${r.id} [${r.status}] owner=${r.owner} $${r.amountUsd.toFixed(4)} 原因=${r.reason}${settled} ${new Date(r.createdAt).toLocaleString()}`);
    }
    return 0;
  }
  if (cmd === "show") {
    ledger.pruneExpired();
    const active = ledger.active();
    const activeUsd = ledger.activeReservedUsd();
    const month = monthSpentUsd(home);
    const config = loadConfig(home);
    const strict = resolveStrictUnknownAmount(config);
    const pauses = listPauses(home, { status: "paused" }).filter((p) => p.scope === "unknown-amount");
    if (json) {
      console.log(JSON.stringify({
        active_reserved_usd: activeUsd,
        active_reservations: active,
        month_spent_usd: month.spentUsd,
        month_incomplete: month.incomplete,
        month: month.month,
        monthly_reset_at: nextMonthlyResetDate(),
        strict_unknown_amount: strict,
        unknown_amount_pauses: pauses.map((p) => ({ id: p.id, agent: p.agent, detail: p.detail })),
      }, null, 2));
      return 0;
    }
    console.log(`在途预留：$${activeUsd.toFixed(4)}（${active.length} 笔）`);
    console.log(`本月已花：$${month.spentUsd.toFixed(4)}${month.incomplete ? "（有未计价记录，实际只会更高）" : ""}，${nextMonthlyResetDate()} 重置（仅记账，无月度上限）`);
    console.log(`金额未知严格模式：${strict ? "开" : "关"}（默认开）`);
    if (pauses.length === 0) {
      console.log("待处理暂停：无");
    } else {
      console.log(`待处理暂停（金额未知，${pauses.length} 条）：`);
      for (const p of pauses) console.log(`- ${p.id} agent=${p.agent} ${p.detail ?? ""}`);
    }
    return 0;
  }
  if (cmd === "reserve") {
    const amountArg = rest.find((a) => !a.startsWith("--"));
    const amount = Number(amountArg);
    if (!amountArg || !Number.isFinite(amount) || amount <= 0) {
      console.log("用法：nyra budget reserve <金额> [--reason <原因>] [--ttl-ms <毫秒>]\n金额必须是大于 0 的美元数。");
      return 1;
    }
    const reasonIdx = rest.indexOf("--reason");
    const reasonRaw = reasonIdx >= 0 ? (rest[reasonIdx + 1] ?? "manual") : "manual";
    const reason: "next-call" | "parallel-thread" | "manual" =
      reasonRaw === "next-call" || reasonRaw === "parallel-thread" ? reasonRaw : "manual";
    const ttlIdx = rest.indexOf("--ttl-ms");
    const ttlRaw = ttlIdx >= 0 ? Number(rest[ttlIdx + 1]) : NaN;
    const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
    // 手动预留不对照任何上限（月度限额已移除），只记账。
    const res = ledger.reserve("cli", amount, { limits: [], reason, ...(ttlMs !== undefined ? { ttlMs } : {}) });
    if (!res.ok) {
      console.log(`预留失败：${res.reason}`);
      return 1;
    }
    if (json) {
      console.log(JSON.stringify(res.reservation, null, 2));
      return 0;
    }
    console.log(`已预留 $${amount.toFixed(4)}，id=${res.reservation.id}（1 小时内有效，结算或释放用 nyra budget settle/release <id>）。`);
    return 0;
  }
  if (cmd === "settle") {
    const id = rest.find((a) => !a.startsWith("--"));
    const actualArg = rest.filter((a) => !a.startsWith("--"))[1];
    const actual = Number(actualArg);
    if (!id || !actualArg || !Number.isFinite(actual) || actual < 0) {
      console.log("用法：nyra budget settle <预留 id> <实际花费>\n实际花费必须是不小于 0 的美元数。");
      return 1;
    }
    try {
      const settled = ledger.settle(id, actual);
      if (json) {
        console.log(JSON.stringify(settled, null, 2));
        return 0;
      }
      console.log(`已结算 ${id}：预留 $${settled.amountUsd.toFixed(4)}，实际 $${actual.toFixed(4)}。`);
      return 0;
    } catch (err: unknown) {
      console.log(`结算失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === "release") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) {
      console.log("用法：nyra budget release <预留 id>");
      return 1;
    }
    try {
      const released = ledger.release(id);
      if (json) {
        console.log(JSON.stringify(released, null, 2));
        return 0;
      }
      console.log(`已释放 ${id}（$${released.amountUsd.toFixed(4)}）。`);
      return 0;
    } catch (err: unknown) {
      console.log(`释放失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === "strict") {
    const off = rest.includes("--off");
    const on = rest.includes("--on");
    if (!off && !on) {
      const strict = resolveStrictUnknownAmount(loadConfig(home));
      console.log(`金额未知严格模式：${strict ? "开" : "关"}（默认开）。`);
      console.log(strict
        ? "未配单价或调用缺用量时，运行暂停等人工处理（不继续跑、不编数字）。"
        : "关了之后金额未知时继续跑、不假装封顶（旧行为）。");
      return 0;
    }
    if (off && on) {
      console.log("用法：nyra budget strict --on 或 nyra budget strict --off（二选一）。");
      return 1;
    }
    if (!rest.includes("--yes")) {
      console.log(`把金额未知严格模式改成${on ? "开" : "关"}：确认请加 --yes。`);
      return 1;
    }
    saveConfig(home, { budget: { strict_unknown_amount: on } });
    console.log(`金额未知严格模式已${on ? "打开" : "关闭"}。`);
    return 0;
  }
  console.log(`未知子命令：${cmd}\n${budgetUsage()}`);
  return 1;
}
