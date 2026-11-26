// tests/node/test-usage-caps.test.ts — M1（OpenMausBot 用量上限借鉴）：
// 每 Bot 每日上限 + 80% 告警 + usage 工具 + nyra usage 仪表。
// 只借 OMB“按 Bot 分 + 界面可见”，硬顶语义不变：调用前预留、
// 未知单价暂停、日/月上限触顶就停。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLedger, localDateString, monthKeyString } from "../../src/usageLedger.ts";
import {
  setCap, evaluateTieredCaps, CostCapsError,
} from "../../src/costCaps.ts";
import { usageBar, buildUsageReport, formatUsageReport } from "../../src/usageMeter.ts";
import { usageMain } from "../../src/usageCli.ts";
import { executeTool, newToolContext, READONLY_TOOLS } from "../../src/tools.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 往账本记一笔：total_tokens 个 token、spentUsd 美元、归属 agent、记在 now 那天。 */
function recordUsage(home: string, agent: string | null, tokens: number, spentUsd: number | null, now = new Date()): void {
  const ledger = new UsageLedger(home);
  const snap = { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens, calls: 1 };
  ledger.recordDelta(snap as never, null, spentUsd, null, "fake-1", now, agent);
}

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

test("UsageCapsTest.test_day_spend_groups_by_local_date", () => {
  const home = tmpHome("nyra-usage-");
  recordUsage(home, "bot-a", 30, 0.03);
  recordUsage(home, "bot-a", 100, 0.1, yesterday());
  recordUsage(home, "bot-b", 10, 0.01);
  const day = localDateString();
  const byDay = new UsageLedger(home).daySpendByAgent(day);
  expect(byDay.byAgent.get("bot-a")?.spentUsd).toBeCloseTo(0.03);
  expect(byDay.byAgent.get("bot-a")?.totalTokens).toBe(30);
  expect(byDay.byAgent.get("bot-b")?.spentUsd).toBeCloseTo(0.01);
  // 昨天的 $0.10 不进今天。
  expect(new UsageLedger(home).dayAgentTotal(day, "bot-a").spentUsd).toBeCloseTo(0.03);
  // 但本月口径里两天都在。
  expect(new UsageLedger(home).monthAgentTotal(monthKeyString(), "bot-a").spentUsd).toBeCloseTo(0.13);
});

test("UsageCapsTest.test_day_cap_exceeded_and_month_cap_untouched", () => {
  const home = tmpHome("nyra-usage-");
  setCap(home, "agent:bot-a", { dayUsd: 0.02, reason: "测试" });
  recordUsage(home, "bot-a", 30, 0.03);
  const ev = evaluateTieredCaps(home, { agent: "bot-a" });
  expect(ev.allowed).toBe(false);
  expect(ev.bindingScope).toBe("agent:bot-a:day");
  expect(ev.bindingReason).toContain("当日");
  expect(ev.bindingReason).toContain("层美元上限已超");
  // 月上限没配：只看日层，超日层就停，不用等月层。
  expect(ev.layers.some((l) => l.scope === "agent:bot-a:day" && l.period === "day")).toBe(true);
});

test("UsageCapsTest.test_day_cap_80pct_warning_not_blocking", () => {
  const home = tmpHome("nyra-usage-");
  // 90% 美元 + 80% token：两个窗口都告警但不拦（0.08/0.1 是 0.7999… 的
  // 浮点边界，告警测试不用这个数）。
  setCap(home, "agent:bot-a", { dayUsd: 1, dayTokens: 100, reason: "测试" });
  recordUsage(home, "bot-a", 80, 0.9);
  const ev = evaluateTieredCaps(home, { agent: "bot-a" });
  expect(ev.allowed).toBe(true);
  const warns = ev.warnings.filter((w) => w.scope === "agent:bot-a:day" && w.period === "day");
  expect(warns.map((w) => w.kind).sort()).toEqual(["tokens", "usd"]);
  expect(warns.find((w) => w.kind === "usd")!.pct).toBeCloseTo(0.9);
  expect(warns.find((w) => w.kind === "tokens")!.pct).toBeCloseTo(0.8);
  // 没到 80% 时不告警。
  const home2 = tmpHome("nyra-usage-");
  setCap(home2, "agent:bot-a", { dayUsd: 1, reason: "测试" });
  recordUsage(home2, "bot-a", 10, 0.01);
  expect(evaluateTieredCaps(home2, { agent: "bot-a" }).warnings.length).toBe(0);
});

test("UsageCapsTest.test_day_cap_rejected_for_non_agent_scope", () => {
  const home = tmpHome("nyra-usage-");
  expect(() => setCap(home, "org", { dayUsd: 1, reason: "测试" })).toThrow(CostCapsError);
  expect(() => setCap(home, "team:t1", { dayTokens: 100, reason: "测试" })).toThrow(CostCapsError);
});

test("UsageCapsTest.test_usage_bar_format", () => {
  expect(usageBar(null)).toBe("未知");
  expect(usageBar(0)).toBe("░".repeat(20));
  expect(usageBar(1)).toBe("█".repeat(20));
  const half = usageBar(0.5);
  expect(half.length).toBe(20);
  expect(half).toContain("█");
  expect(half).toContain("░");
});

test("UsageCapsTest.test_usage_tool_reads_own_agent", async () => {
  const home = tmpHome("nyra-usage-");
  const workdir = tmpHome("nyra-usage-wd-");
  setCap(home, "agent:bot-a", { dayUsd: 0.1, monthUsd: 1, reason: "测试" });
  recordUsage(home, "bot-a", 80, 0.09);
  const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, soulAgent: "bot-a" });
  const out = await executeTool("usage", {}, ctx);
  expect(out).toContain("bot-a");
  expect(out).toContain("今日");
  expect(out).toContain("本月");
  expect(out).toContain("90%");
  expect(out).toContain("到 80% 了");
  // 只读工具：不需审批，不在 MUTATING 之列。
  expect(READONLY_TOOLS.has("usage")).toBe(true);
  // 显式 agent 参数优先于当前 agent。
  const other = await executeTool("usage", { agent: "bot-b" }, ctx);
  expect(other).toContain("bot-b");
});

test("UsageCapsTest.test_usage_report_json_and_text", () => {
  const home = tmpHome("nyra-usage-");
  setCap(home, "agent:bot-a", { dayUsd: 1, monthUsd: 1, reason: "测试" });
  recordUsage(home, "bot-a", 80, 0.9);
  recordUsage(home, "bot-b", 10, 0.01);
  const all = buildUsageReport(home);
  expect(all.agents.map((a) => a.agent)).toEqual(["bot-a", "bot-b"]);
  const one = buildUsageReport(home, "bot-a");
  expect(one.agents.map((a) => a.agent)).toEqual(["bot-a"]);
  expect(one.agents[0]!.day.warning).toBe(true);
  const lines = formatUsageReport(all);
  expect(lines.some((l) => l.includes("bot-a"))).toBe(true);
  expect(lines.some((l) => l.includes("到 80% 了"))).toBe(true);
  // 没上限、没花费的 agent 不出现在全部列表里。
  const empty = buildUsageReport(tmpHome("nyra-usage-"));
  expect(empty.agents.length).toBe(0);
  expect(formatUsageReport(empty).some((l) => l.includes("还没有任何 Bot 的用量"))).toBe(true);
});

test("UsageCapsTest.test_usage_cli_json", () => {
  const home = tmpHome("nyra-usage-");
  setCap(home, "agent:bot-a", { dayUsd: 0.1, reason: "测试" });
  recordUsage(home, "bot-a", 10, 0.01);
  const seen: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    expect(usageMain(["--agent", "bot-a", "--json"], home)).toBe(0);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(seen.join("\n")) as { agents: { agent: string }[] };
  expect(parsed.agents.map((a) => a.agent)).toEqual(["bot-a"]);
});
