// tests/node/test-dashboard.test.ts — P2-3：实时看板（TUI + --json 事件）。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDashboardSnapshot, buildDashboardSnapshotFor, formatDashboardLine, dashboardCostSegment,
  type DashboardSnapshot,
} from "../../src/dashboard.ts";
import type { UsageSnapshot } from "../../src/usage.ts";
import { estimateCost } from "../../src/cost.ts";
import { JsonLines } from "../../src/jsonMode.ts";
import { ToolPrinter, formatReplStatus } from "../../src/consoleUi.ts";
import { renderStatusBar } from "../../src/banner.ts";
import { Agent } from "../../src/agent.ts";

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    calls: 2, reported_calls: 2, missing_calls: 0,
    prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000,
    prompt_samples: 2, completion_samples: 2, total_samples: 2,
    last_prompt_tokens: 6000, context_window_tokens: 100000, context_remaining_tokens: 94000,
    context_window_source: "builtin", context_window_model: "deepseek-flash",
    ...over,
  };
}

const PRICING = { inputPer1M: 1, outputPer1M: 4 };

test("Dashboard.build_priced", () => {
  const { snapshot, estimate } = buildDashboardSnapshotFor(3, 10, snap(), PRICING, 1);
  expect(snapshot.turn).toBe(3);
  expect(snapshot.max_turns).toBe(10);
  expect(snapshot.status).toBe("priced");
  // 10000/1e6*1 + 2000/1e6*4 = 0.01 + 0.008 = 0.018；剩余 1 - 0.018 = 0.982。
  expect(snapshot.spent_usd).toBeCloseTo(0.018, 9);
  expect(snapshot.remaining_usd).toBeCloseTo(0.982, 9);
  expect(snapshot.limit_usd).toBe(1);
  expect(snapshot.reason).toBeUndefined();
  expect(estimate.status).toBe("priced");
});

test("Dashboard.build_unpriced_without_pricing", () => {
  const { snapshot } = buildDashboardSnapshotFor(1, 10, snap(), null, 1);
  expect(snapshot.status).toBe("unpriced");
  expect(snapshot.spent_usd).toBeNull();
  expect(snapshot.remaining_usd).toBeNull();
  expect(snapshot.limit_usd).toBe(1);
  expect(snapshot.reason).toContain("单价");
});

test("Dashboard.build_missing_without_usage", () => {
  const missing = snap({ calls: 1, reported_calls: 0, missing_calls: 1, prompt_tokens: null, completion_tokens: null, total_tokens: null, prompt_samples: 0, completion_samples: 0, total_samples: 0, last_prompt_tokens: null, context_remaining_tokens: null });
  const { snapshot } = buildDashboardSnapshotFor(1, 10, missing, PRICING, null);
  expect(snapshot.status).toBe("missing");
  expect(snapshot.spent_usd).toBeNull();
  expect(snapshot.reason).toContain("未上报");
});

test("Dashboard.build_from_estimate", () => {
  const e = estimateCost(snap(), PRICING, 0.5);
  const s = buildDashboardSnapshot({ turn: 2, maxTurns: 5, snapshot: snap(), estimate: e });
  expect(s.status).toBe("priced");
  expect(s.spent_usd).toBeCloseTo(0.018, 9);
  expect(s.remaining_usd).toBeCloseTo(0.482, 9);
});

test("Dashboard.line_priced", () => {
  const { snapshot } = buildDashboardSnapshotFor(3, 10, snap(), PRICING, 1);
  const line = formatDashboardLine(snapshot);
  expect(line).toContain("轮次 3/10");
  expect(line).toContain("$0.0180");
  expect(line).toContain("剩余 $0.9820");
  expect(line).toContain("Token 10,000/2,000");
  expect(line).toContain("上下文剩余 94,000");
});

test("Dashboard.line_unknown_never_fabricates", () => {
  const { snapshot } = buildDashboardSnapshotFor(1, 10, snap(), null, null);
  const line = formatDashboardLine(snapshot);
  expect(line).toContain("成本：未知");
  expect(line).not.toContain("$");
  expect(line).toContain("Token 10,000/2,000");
});

test("Dashboard.line_missing_no_context", () => {
  const missing = snap({ context_window_tokens: null, context_remaining_tokens: null, last_prompt_tokens: null });
  const { snapshot } = buildDashboardSnapshotFor(1, 10, missing, PRICING, null);
  const line = formatDashboardLine(snapshot);
  expect(line).toContain("上下文剩余未知");
});

test("Dashboard.cost_segment", () => {
  expect(dashboardCostSegment(null)).toBeNull();
  const priced = estimateCost(snap(), PRICING, 1);
  expect(dashboardCostSegment(priced)).toBe("成本 $0.0180/$1.00");
  const noLimit = estimateCost(snap(), PRICING, null);
  expect(dashboardCostSegment(noLimit)).toBe("成本 $0.0180");
  const unpriced = estimateCost(snap(), null, 1);
  expect(dashboardCostSegment(unpriced)).toBe("成本未知");
});

test("Dashboard.framed_status_bar_with_cost", () => {
  const bar = renderStatusBar(
    { model: "deepseek", mode: "auto", contextUsage: 0.25, cost: "成本 $0.0180/$1.00" },
    { width: 80, color: false, unicode: true },
  );
  expect(bar).toContain("上下文 25%");
  expect(bar).toContain("成本 $0.0180/$1.00");
  const plain = renderStatusBar(
    { model: "deepseek", mode: "auto", contextUsage: null },
    { width: 80, color: false, unicode: true },
  );
  expect(plain).toContain("上下文 --");
  expect(plain).not.toContain("成本");
});

test("Dashboard.repl_status_with_cost", () => {
  const withCost = formatReplStatus("deepseek", "/tmp/wd", 0.25, "auto", "成本 $0.0180/$1.00");
  expect(withCost).toContain("上下文 25%");
  expect(withCost).toContain("成本 $0.0180/$1.00");
  const without = formatReplStatus("deepseek", "/tmp/wd", null, "readonly");
  expect(without).toBe("[deepseek] | /tmp/wd · 上下文 -- · readonly");
});

test("Dashboard.json_event_cost_update", () => {
  const lines: string[] = [];
  const jl = new JsonLines({ write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream);
  const { snapshot } = buildDashboardSnapshotFor(2, 8, snap(), PRICING, 1);
  jl.agentEvent("cost_update", snapshot as unknown as Record<string, unknown>);
  expect(lines.length).toBe(1);
  const ev = JSON.parse(lines[0]) as Record<string, unknown>;
  expect(ev.type).toBe("cost_update");
  expect(ev.turn).toBe(2);
  expect(ev.status).toBe("priced");
  expect(ev.spent_usd).toBeCloseTo(0.018, 9);
  expect(ev.remaining_usd).toBeCloseTo(0.982, 9);
  expect(ev.prompt_tokens).toBe(10000);
});

test("Dashboard.printer_cost_update_line", () => {
  const lines: string[] = [];
  const printer = new ToolPrinter({ write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream, false);
  const { snapshot } = buildDashboardSnapshotFor(1, 10, snap(), PRICING, 1);
  printer.call("cost_update", snapshot as unknown as Record<string, unknown>);
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("看板 [轮次 1/10]");
  expect(lines[0]).toContain("$0.0180");
});

// ---- Agent 级：每轮发一次 cost_update，金额与 usage 对得上 ----

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(_messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function textReply(text: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }], ...(usage ? { usage } : {}) };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-dash-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-dash-wd-"));
  return { home, workdir };
}

test("Dashboard.agent_emits_cost_update_per_turn", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    textReply("done", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    pricing: { inputPer1M: 1, outputPer1M: 2 }, maxCostUsd: 1,
  });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  agent.onEvent = (kind, data) => events.push({ kind, data });
  const out = await agent.run("hi");
  expect(out).toBe("done");
  const updates = events.filter((e) => e.kind === "cost_update");
  expect(updates.length).toBe(1);
  const d = updates[0].data as unknown as DashboardSnapshot;
  expect(d.turn).toBe(1);
  expect(d.status).toBe("priced");
  // 100/1e6*1 + 50/1e6*2 = 0.0002；剩余 1 - 0.0002 = 0.9998。
  expect(d.spent_usd).toBeCloseTo(0.0002, 9);
  expect(d.remaining_usd).toBeCloseTo(0.9998, 9);
  expect(d.prompt_tokens).toBe(100);
  expect(d.completion_tokens).toBe(50);
});

test("Dashboard.agent_cost_update_unknown_when_no_usage", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([textReply("done")]);
  // 严格模式默认开时，缺用量的调用会在 checkCost 暂停（见可靠性打磨第 2 项），
  // 看板“未知不编造”的渲染走非严格路径验——严格暂停本身由
  // test-budget-reservation.test.ts 覆盖。
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    pricing: { inputPer1M: 1, outputPer1M: 2 }, maxCostUsd: 1,
    strictUnknownAmount: false,
  });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  agent.onEvent = (kind, data) => events.push({ kind, data });
  await agent.run("hi");
  const updates = events.filter((e) => e.kind === "cost_update");
  expect(updates.length).toBe(1);
  const d = updates[0].data as unknown as DashboardSnapshot;
  expect(d.status).toBe("missing");
  expect(d.spent_usd).toBeNull();
  expect(d.remaining_usd).toBeNull();
});
