// tests/node/test-usage-heatmap-monthly.test.ts — 缺口 20 + 缺口 29。
//
// 覆盖：用量账本（delta 记账、日/月汇总）、热力图渲染、月度硬顶判定与
// Agent 接线（含子任务继承）、Retry-After 解析与重试等待、onRetry 透传、
// 运行级统计头（含 CLI 先挂 onEvent 再建 recorder 的接线修复）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UsageLedger, formatHeatmap, localDateString, monthKeyString, nextMonthlyResetDate,
  type DayTotal,
} from "../../src/usageLedger.ts";
import { resolveMonthlyLimit, checkMonthlyCap } from "../../src/cost.ts";
import { McpCostTracker } from "../../src/mcpCost.ts";
import {
  ProviderError, FallbackProvider, KeyRotatingProvider, buildProviderChain,
  parseRetryAfter, type RetryRecord,
} from "../../src/providers.ts";
import { Agent, AgentError } from "../../src/agent.ts";
import { RunStore, RunRecorder, formatRunReport, formatEvidenceReport, computeRunStats } from "../../src/runs.ts";
import { handleStats } from "../../src/statsCli.ts";
import { fakeProvider } from "./fake-provider.ts";
import type { UsageSnapshot } from "../../src/usage.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-020-29-test-"));
}

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    calls: 0, reported_calls: 0, missing_calls: 0,
    prompt_tokens: null, completion_tokens: null, total_tokens: null,
    prompt_samples: 0, completion_samples: 0, total_samples: 0,
    last_prompt_tokens: null, context_window_tokens: null, context_remaining_tokens: null,
    context_window_source: "unknown", context_window_model: null,
    ...over,
  };
}

// ---------- 日期 helper ----------

test("日期 helper：本地日/月/下月 1 日", () => {
  const d = new Date(2026, 10, 20, 15, 30); // 2026-11-20 本地
  expect(localDateString(d)).toBe("2026-11-20");
  expect(monthKeyString(d)).toBe("2026-11");
  expect(nextMonthlyResetDate(d)).toBe("2026-12-01");
  expect(nextMonthlyResetDate(new Date(2026, 11, 31))).toBe("2027-01-01");
});

// ---------- 用量账本 ----------

test("账本：delta 记账——第二次只记增量，不重复计", () => {
  const home = tmpHome();
  const ledger = new UsageLedger(home);
  const first = snap({ calls: 2, prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 });
  const r1 = ledger.recordDelta(first, null, 0.01, null, "fake-1", new Date(2026, 10, 20));
  expect(r1?.total_tokens).toBe(1100);
  expect(r1?.spent_usd).toBeCloseTo(0.01, 10);
  const second = snap({ calls: 3, prompt_tokens: 1500, completion_tokens: 120, total_tokens: 1620 });
  const r2 = ledger.recordDelta(second, first, 0.015, 0.01, "fake-1", new Date(2026, 10, 20));
  expect(r2?.total_tokens).toBe(520);
  expect(r2?.calls).toBe(1);
  expect(r2?.spent_usd).toBeCloseTo(0.005, 10);
  // 零增量不写行
  expect(ledger.recordDelta(second, second, 0.015, 0.015, "fake-1")).toBeNull();
  expect(ledger.readAll().length).toBe(2);
});

test("账本：未计价只记 token、不记金额；月汇总标 incomplete", () => {
  const home = tmpHome();
  const ledger = new UsageLedger(home);
  ledger.recordDelta(snap({ calls: 1, prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 }), null, null, null, "fake-1", new Date(2026, 10, 20));
  ledger.recordDelta(snap({ calls: 1, prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }), null, 0.002, null, "fake-1", new Date(2026, 10, 21));
  const m = ledger.monthTotal("2026-11");
  expect(m.spentUsd).toBeCloseTo(0.002, 10);
  expect(m.incomplete).toBe(true);
  expect(m.totalTokens).toBe(660);
  const days = ledger.dailyTotals(2, new Date(2026, 10, 21));
  expect(days.get("2026-11-20")?.total).toBe(550);
  expect(days.get("2026-11-20")?.spent).toBeNull();
  expect(days.get("2026-11-20")?.incomplete).toBe(true);
  expect(days.get("2026-11-21")?.spent).toBeCloseTo(0.002, 10);
});

test("账本：损坏行跳过，不拖垮读取；不存在的文件返回空", () => {
  const home = tmpHome();
  const ledger = new UsageLedger(home);
  expect(ledger.readAll()).toEqual([]);
  expect(ledger.monthTotal("2026-11").spentUsd).toBe(0);
  writeFileSync(join(home, "usage_daily.jsonl"), '{"bad json\n{"date":"2026-11-20","month":"2026-11","prompt_tokens":10,"completion_tokens":0,"total_tokens":10,"calls":1,"spent_usd":null,"model":null}\n');
  expect(ledger.readAll().length).toBe(1);
});

test("MCP 月度合计：只计 called、按本地月分桶", () => {
  const home = tmpHome();
  const tracker = new McpCostTracker(home);
  tracker.record("srv", "tool", 1.5, "called");
  tracker.record("srv", "tool", 9, "blocked_over_limit");
  expect(tracker.monthTotalUsd(monthKeyString())).toBeCloseTo(1.5, 10);
  expect(tracker.monthTotalUsd("1999-01")).toBe(0);
});

// ---------- 热力图 ----------

function day(total: number, spent: number | null = null): DayTotal {
  return { prompt: total, completion: 0, total, calls: total ? 1 : 0, spent, incomplete: spent === null && total > 0 };
}

test("热力图：最忙一天是 █，精确值逐日列出", () => {
  const daily = new Map<string, DayTotal>();
  const today = new Date(2026, 10, 20); // 周四
  daily.set("2026-11-20", day(10000, 0.05));
  daily.set("2026-11-19", day(100, 0.001));
  const out = formatHeatmap(daily, { weeks: 1, today });
  expect(out).toContain("用量热力图");
  expect(out).toContain("█");
  expect(out).toContain("2026-11-20：10,000 token · $0.0500");
  expect(out).toContain("2026-11-19：100 token");
});

test("热力图：全空时如实说没有记录，不编历史", () => {
  const out = formatHeatmap(new Map(), { weeks: 2, today: new Date(2026, 10, 20) });
  expect(out).toContain("暂无用量记录");
  expect(out).not.toContain("█");
});

// ---------- 月度硬顶判定 ----------

test("resolveMonthlyLimit：非法值按未设处理；0 是合法的锁死值；CLI 优先于配置", () => {
  expect(resolveMonthlyLimit({})).toBeNull();
  expect(resolveMonthlyLimit({ monthly_cost_limit_usd: -1 })).toBeNull();
  expect(resolveMonthlyLimit({ monthly_cost_limit_usd: NaN })).toBeNull();
  expect(resolveMonthlyLimit({ monthly_cost_limit_usd: "5" })).toBeNull();
  expect(resolveMonthlyLimit({ monthly_cost_limit_usd: 0 })).toBe(0);
  expect(resolveMonthlyLimit({ monthly_cost_limit_usd: 5 }, 10)).toBe(10);
  expect(resolveMonthlyLimit({ monthly_cost_limit_usd: 5 }, null)).toBe(5);
});

test("checkMonthlyCap：三数齐全才判定；任一算不出就不超限", () => {
  expect(checkMonthlyCap(9, 2, 10).exceeded).toBe(true);
  expect(checkMonthlyCap(9, 2, 10).monthSpentUsd).toBeCloseTo(11, 10);
  expect(checkMonthlyCap(9, 1, 10).exceeded).toBe(false);
  expect(checkMonthlyCap(null, 1, 10).exceeded).toBe(false);
  expect(checkMonthlyCap(9, null, 10).exceeded).toBe(false);
  expect(checkMonthlyCap(9, 1, null).exceeded).toBe(false);
});

// ---------- Agent 月度硬顶 ----------

const PRICING = { inputPer1M: 1, outputPer1M: 2 };

test("Agent 月度硬顶：超限抛错，报错说清已花/上限/重置日/怎么放宽", async () => {
  const home = tmpHome();
  const agent = new Agent(fakeProvider([{ content: "ok" }]) as never, {
    workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home,
    pricing: PRICING,
    monthlyCostLimitUsd: 0.0001,
    monthlySpentBeforeUsd: () => ({ spentUsd: 0, incomplete: false }),
  });
  // 一次调用预估约 0.0011（系统提示也算输入）> 上限 0.0001：请求前预留
  // 直接拒绝，调用不发出（可靠性打磨第 2 项；旧口径是调用发出后再由
  // checkCost 抛“月度支出上限已超”）。拒因里仍须说清月度上限、重置日与放宽办法。
  let err: unknown = null;
  try { await agent.run("hi"); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(AgentError);
  const msg = String((err as Error).message);
  expect(msg).toContain("预算预留不足");
  expect(msg).toContain("月度支出上限");
  expect(msg).toContain("0.0001");
  expect(msg).toContain(nextMonthlyResetDate());
  expect(msg).toContain("monthly_cost_limit_usd");
});

test("Agent 月度硬顶：未超限正常跑；未计价/before 未知时不假装封顶", async () => {
  const home = tmpHome();
  const ok = new Agent(fakeProvider([{ content: "ok" }]) as never, {
    workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home,
    pricing: PRICING, monthlyCostLimitUsd: 10,
    monthlySpentBeforeUsd: () => ({ spentUsd: 0, incomplete: false }),
  });
  expect(await ok.run("hi")).toContain("ok");

  const unpriced = new Agent(fakeProvider([{ content: "ok" }]) as never, {
    workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home,
    monthlyCostLimitUsd: 0.00001, // 即使上限极低，没单价也算不出
    monthlySpentBeforeUsd: () => ({ spentUsd: 0, incomplete: false }),
  });
  // 严格模式默认开时，没单价第一次调用前就暂停（可靠性打磨第 2 项；
  // 旧口径是“没单价也算不出，不抛错”）；严格关了才沿用旧行为。
  await expect(unpriced.run("hi")).rejects.toThrow("金额未知");
  const unpricedOff = new Agent(fakeProvider([{ content: "ok" }]) as never, {
    workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home,
    monthlyCostLimitUsd: 0.00001,
    monthlySpentBeforeUsd: () => ({ spentUsd: 0, incomplete: false }),
    strictUnknownAmount: false,
  });
  expect(await unpricedOff.run("hi")).toContain("ok");

  const unknownBefore = new Agent(fakeProvider([{ content: "ok" }]) as never, {
    workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home,
    pricing: PRICING, monthlyCostLimitUsd: 0.00001,
    monthlySpentBeforeUsd: () => null,
  });
  // before 未知（本月已花算不出）：严格模式下同样暂停（missing-monthly，
  // 不能把未知当 0 用）；严格关了才跳过月度层继续跑。
  await expect(unknownBefore.run("hi")).rejects.toThrow("金额未知");
  const unknownBeforeOff = new Agent(fakeProvider([{ content: "ok" }]) as never, {
    workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home,
    pricing: PRICING, monthlyCostLimitUsd: 0.00001,
    monthlySpentBeforeUsd: () => null,
    strictUnknownAmount: false,
  });
  expect(await unknownBeforeOff.run("hi")).toContain("ok");
});

test("Agent 月度硬顶：子任务继承上限与单价，父子共用同一本预留账", async () => {
  const home = tmpHome();
  // 父 2 次调用 + 子 1 次调用；上限放得够宽，重点是子任务走同一本账
  // （旧口径是“父+子合计超限即停”，靠事后 checkCost；预留门把检查点挪到
  // 调用之前后，合计超限的场景由“请求前预留不足”覆盖，见上一则测试）。
  const provider = fakeProvider([
    { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "delegate", arguments: JSON.stringify({ task: "子任务", max_turns: 2 }) } }] },
    { content: "父 done" },
    { content: "子 done" },
  ]) as never;
  const agent = new Agent(provider, {
    workdir: home, mode: "full", maxTurns: 5, skillsDirs: [], home,
    pricing: PRICING, monthlyCostLimitUsd: 10,
    monthlySpentBeforeUsd: () => ({ spentUsd: 0, incomplete: false }),
  });
  expect(await agent.run("做点事")).toContain("子 done");
  // 父 2 次调用 + 子 1 次调用，都从同一本预留账结算，owner 各不相同。
  const { BudgetLedger } = await import("../../src/budget.ts");
  const rows = new BudgetLedger(home).list();
  expect(rows.length).toBe(3);
  expect(rows.every((r) => r.status === "settled")).toBe(true);
  expect(new Set(rows.map((r) => r.owner)).size).toBeGreaterThan(1);
});

// ---------- Retry-After 与 onRetry ----------

test("parseRetryAfter：秒数/HTTP-date/无效值/封顶", () => {
  expect(parseRetryAfter("2")).toBe(2000);
  expect(parseRetryAfter("0")).toBe(0);
  expect(parseRetryAfter(null)).toBeNull();
  expect(parseRetryAfter("abc")).toBeNull();
  expect(parseRetryAfter("99999")).toBe(600_000);
  const now = Date.parse("2026-11-20T00:00:00Z");
  expect(parseRetryAfter("Fri, 20 Nov 2026 00:00:05 GMT", now)).toBe(5000);
});

test("重试等待取服务端与客户端的最大值，并触发 onRetry", async () => {
  const sleeps: number[] = [];
  const retries: RetryRecord[] = [];
  let calls = 0;
  const flaky = {
    name: "flaky", model: "flaky-1", baseUrl: "http://127.0.0.1:9",
    hasCredentials: () => true,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      if (calls === 1) throw new ProviderError("请求过于频繁 (HTTP 429)", { status: 429, kind: "rate_limit", retryAfterMs: 5000 });
      return { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
    async listModels(): Promise<string[]> { return ["flaky-1"]; },
    redact: (t: string) => t,
  };
  const chain = new FallbackProvider([flaky as never, flaky as never], null, {
    retryDelaysMs: [0, 0],
    sleep: async (ms: number) => { sleeps.push(ms); },
    onRetry: (r) => retries.push(r),
  });
  const res = await chain.chat([{ role: "user", content: "hi" }] as never);
  expect((res.choices as { message: { content: string } }[])[0].message.content).toBe("ok");
  expect(sleeps).toEqual([5000]);
  expect(retries.length).toBe(1);
  expect(retries[0].delayMs).toBe(5000);
  expect(retries[0].kind).toBe("rate_limit");
});

test("KeyRotatingProvider 同样走 onRetry（同一把 Key 先重试）", async () => {
  const retries: RetryRecord[] = [];
  let calls = 0;
  const flaky = {
    name: "k", model: "k-1", baseUrl: "http://127.0.0.1:9",
    hasCredentials: () => true,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      if (calls === 1) throw new ProviderError("x", { status: 429, kind: "rate_limit" });
      return { choices: [{ message: { content: "ok" } }] };
    },
    async listModels(): Promise<string[]> { return ["k-1"]; },
    redact: (t: string) => t,
  };
  const chain = new KeyRotatingProvider([flaky as never, flaky as never], null, {
    retryDelaysMs: [0, 0], sleep: async () => {}, onRetry: (r) => retries.push(r),
  });
  await chain.chat([{ role: "user", content: "hi" }] as never);
  expect(retries.length).toBe(1);
});

test("buildProviderChain 透传 onRetry", async () => {
  const seen: RetryRecord[] = [];
  let calls = 0;
  class Flaky {
    name = "flaky"; model = "flaky-1"; baseUrl = "http://127.0.0.1:9";
    constructor(_cfg: unknown) {}
    hasCredentials() { return true; }
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      if (calls === 1) throw new ProviderError("x", { status: 429, kind: "rate_limit" });
      return { choices: [{ message: { content: "ok" } }] };
    }
    async listModels(): Promise<string[]> { return ["flaky-1"]; }
    redact(t: string) { return t; }
  }
  const cfg = { name: "flaky", baseUrl: "http://127.0.0.1:9", model: "flaky-1", apiKey: "k", auth: "env", connectorName: null, allowedHosts: [], keySource: "env", hasKey: true, envKey: "X", preset: {} } as never;
  const chain = buildProviderChain(cfg, ["flaky", "flaky2"], null, {
    providerCls: Flaky as never,
    resolver: () => cfg,
    onRetry: (r) => seen.push(r),
  });
  // 真实跑一次：第一次 429 → 同 provider 重试（默认退避约 1s）→ 成功。
  const res = await chain.chat([{ role: "user", content: "hi" }] as never);
  expect((res.choices as { message: { content: string } }[])[0].message.content).toBe("ok");
  expect(seen.length).toBe(1);
  expect(seen[0].kind).toBe("rate_limit");
  expect(seen[0].delayMs).toBeGreaterThanOrEqual(700);
  expect(seen[0].delayMs).toBeLessThanOrEqual(1300);
});

// ---------- 运行级统计头 ----------

function captureStdout(fn: () => number): string {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => { buf += c; return true; };
  try { fn(); } finally { (process.stdout as unknown as { write: unknown }).write = orig; }
  return buf;
}

test("统计头：真实运行的事件数进 events.jsonl，报告顶行有实数", async () => {
  const home = tmpHome();
  const workdir = join(home, "wd");
  mkdirSync(workdir, { recursive: true });
  const store = new RunStore(join(home, "runs"));
  const agent = new Agent(fakeProvider([
    { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "hi\n" }) } }] },
    { content: "done" },
  ]) as never, { workdir, mode: "full", maxTurns: 5, skillsDirs: [], home });
  // CLI 顺序：先挂 onEvent（printer/JSON），再建 recorder——recorder 捕获并转发，
  // 事件既显示又落盘。反过来（先建 recorder 再覆盖 onEvent）会把 recorder 摘掉。
  const seen: string[] = [];
  agent.onEvent = (kind) => { seen.push(kind); };
  const rec = new RunRecorder(store, agent, "写 a.txt", { verifyCmd: null });
  const out = await rec.run("写 a.txt");
  expect(seen).toContain("tool_start");
  expect(seen).toContain("tool_result");
  const events = readFileSync(join(home, "runs", rec.runId, "events.jsonl"), "utf-8");
  // 只认语义不认字节（事件行用 JSON.stringify 写）。
  expect(events.trim().split("\n").some((l) => (JSON.parse(l) as { type?: string }).type === "turn")).toBe(true);
  expect(events.trim().split("\n").some((l) => (JSON.parse(l) as { type?: string }).type === "tool_start")).toBe(true);
  const state = store.load(rec.runId);
  expect(state.usage_summary?.calls).toBeGreaterThan(0);
  const stats = computeRunStats(store, rec.runId, state);
  expect(stats.llmCalls).toBe(2);
  expect(stats.toolCalls).toBe(1);
  expect(stats.toolErrors).toBe(0);
  expect(out).toContain("运行统计：");
  expect(out).toContain("LLM 调用 2");
  expect(out).toContain("工具调用 1");
  expect(out).toContain("花费 未知");
});

test("统计头：旧运行（无事件/无摘要）不编数字，写未知", () => {
  const report = formatRunReport({ status: "completed_unverified", changed_files: [], verify_cmd: null, verify_result: null } as never);
  expect(report).toContain("运行统计：");
  expect(report).toContain("LLM 调用 未知");
  expect(report).toContain("工具调用 未知");
  const ev = formatEvidenceReport(
    { run_id: "20261120-000000-abcdef", status: "completed_unverified", passed: false, checks: [] },
    null,
  );
  expect(ev).toContain("运行统计：");
});

test("统计头：子任务花费累计进用量摘要（delegate_usage 事件）", async () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const agent = new Agent(fakeProvider([{ content: "ok" }]) as never, { workdir: home, mode: "full", maxTurns: 3, skillsDirs: [], home });
  const rec = new RunRecorder(store, agent, "t", { verifyCmd: null });
  rec.call("delegate_usage", {
    snapshot: { calls: 2, prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    spent_usd: 0.5, model: "fake-1",
  });
  rec.recordUsageSummary();
  const state = store.load(rec.runId);
  expect(state.usage_summary?.delegate_spent_usd).toBeCloseTo(0.5, 10);
  expect(state.usage_summary?.delegate_calls).toBe(2);
});

// ---------- nyra stats ----------

test("nyra stats：月汇总与热力图都读账本", () => {
  const home = tmpHome();
  const ledger = new UsageLedger(home);
  const today = new Date();
  ledger.recordDelta(snap({ calls: 1, prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }), null, 0.01, null, "fake-1", today);
  const summary = captureStdout(() => handleStats([], home));
  expect(summary).toContain("本月用量");
  expect(summary).toContain("1,100");
  const heat = captureStdout(() => handleStats(["heatmap", "--weeks", "1"], home));
  expect(heat).toContain("用量热力图");
  expect(heat).toContain("1,100 token");
  expect(handleStats(["heatmap", "--weeks", "0"], home)).toBe(2);
  expect(handleStats(["bogus"], home)).toBe(2);
});
