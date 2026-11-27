// tests/node/test-budget-reservation.test.ts — 可靠性打磨第 2 项第一批：并发预算预留。
// 测的是“请求前先预留、超了不发请求、金额未知就停下”，不是事后算账：
//   - 预留不足拒绝（调用根本没发出）；
//   - 并行多任务同时预留不超支（共享一本账）；
//   - 缺 usage 时暂停不继续跑（严格模式默认开）；
//   - 预留/结算/释放账本一致性；
//   - 账本损坏先备份再抛错。
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBudgetLock, BudgetLedger, estimateCallUsd, isPidAlive, resolveStrictUnknownAmount } from "../../src/budget.ts";
import { Agent } from "../../src/agent.ts";
import { echoProvider } from "./fake-provider.ts";
import { expectPerms } from "./fsPerms.ts";
import { runParallelDelegate, type ParallelTaskSpec, type ParallelThreadOutcome } from "../../src/parallelDelegate.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { budgetMain } from "../../src/budgetCli.ts";
import { explainOne } from "../../src/configExplain.ts";
import { buildCostJson } from "../../src/costCli.ts";
import type { ProviderLike } from "../../src/providers.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 不报 usage 的假 provider（模拟 provider 未报用量）。 */
function noUsageProvider(): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name: "fake",
    model: "fake-1",
    baseUrl: "http://127.0.0.1:9",
    calls: 0,
    hasCredentials: () => true,
    async chat(_messages: unknown[], _tools?: unknown, _timeout?: number): Promise<Record<string, unknown>> {
      calls += 1;
      provider.calls = calls;
      return { choices: [{ message: { role: "assistant", content: "完成。" } }] };
    },
    async listModels(): Promise<string[]> { return ["fake-1"]; },
    redact: (text: string) => text,
  };
  return provider;
}

const PRICING = { inputPer1M: 1, outputPer1M: 2 };

test("BudgetReservation.test_estimate_call_usd", () => {
  // 2500 字提示 ≈ 1000 输入 token（$0.001）+ 2000 补全 token（$0.004）。
  // 补全默认按 2000 算是保守值（典型回复约 400）：预留要拦超支，不是精确报价。
  expect(estimateCallUsd(2500, PRICING)).toBeCloseTo(0.005, 10);
  expect(estimateCallUsd(2500, PRICING, 400)).toBeCloseTo(0.0018, 10);
  expect(estimateCallUsd(100, null)).toBeNull();
});

test("BudgetReservation.test_strict_unknown_amount_defaults_fail_closed", () => {
  expect(resolveStrictUnknownAmount({})).toBe(true);
  expect(resolveStrictUnknownAmount({ budget: { strict_unknown_amount: false } })).toBe(false);
  expect(resolveStrictUnknownAmount({ budget: { strict_unknown_amount: true } })).toBe(true);
  // 非法值回 true（fail-closed，不静默放宽）。
  expect(resolveStrictUnknownAmount({ budget: { strict_unknown_amount: "yes" } })).toBe(true);
  expect(resolveStrictUnknownAmount({ budget: {} })).toBe(true);
});

test("BudgetReservation.test_ledger_reserve_settle_release", () => {
  const home = tmp("nyra-budget-ledger-");
  const ledger = new BudgetLedger(home);
  const path = join(home, "budget-ledger.json");
  const res = ledger.reserve("cli", 0.1, { reason: "manual" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("reserve should succeed");
  expect(ledger.activeReservedUsd()).toBeCloseTo(0.1, 10);
  expectPerms(path, 0o600);
  const settled = ledger.settle(res.reservation.id, 0.04);
  expect(settled.status).toBe("settled");
  expect(settled.settledUsd).toBeCloseTo(0.04, 10);
  expect(ledger.activeReservedUsd()).toBe(0);
  // 已结算再结算抛错；已结算再释放抛错。
  expect(() => ledger.settle(res.reservation.id, 0.01)).toThrow();
  expect(() => ledger.release(res.reservation.id)).toThrow();
  // 释放幂等：已释放再释放不抛错，返回同一行。
  const r2 = ledger.reserve("cli", 0.05, { reason: "manual" });
  if (!r2.ok) throw new Error("reserve should succeed");
  const rel1 = ledger.release(r2.reservation.id);
  expect(rel1.status).toBe("released");
  const rel2 = ledger.release(r2.reservation.id);
  expect(rel2.status).toBe("released");
  // 未知 id 结算/释放都抛错。
  expect(() => ledger.settle("rsv_nope", 0.01)).toThrow();
  expect(() => ledger.release("rsv_nope")).toThrow();
  expect(ledger.activeReservedUsd()).toBe(0);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_check_reserve_limits", () => {
  const home = tmp("nyra-budget-limits-");
  const ledger = new BudgetLedger(home);
  // 单次上限 $0.10，已花 $0.06：再预留 $0.05 超了，$0.04 能过。
  const over = ledger.reserve("cli", 0.05, {
    limits: [{ scope: "run", limitUsd: 0.1, spentUsd: 0.06 }],
    reason: "manual",
  });
  expect(over.ok).toBe(false);
  if (over.ok) throw new Error("should be rejected");
  expect(over.reason).toContain("剩余额度不足");
  const ok = ledger.reserve("cli", 0.04, {
    limits: [{ scope: "run", limitUsd: 0.1, spentUsd: 0.06 }],
    reason: "manual",
  });
  expect(ok.ok).toBe(true);
  // 第二层上限同理：已花 + 在途 + 本次 <= 上限才放行（这里用分层每日层举例）。
  const tierOver = ledger.reserve("cli", 0.01, {
    limits: [{ scope: "tiered:agent:bot-a:day", limitUsd: 0.1, spentUsd: 0.09 }],
    reason: "manual",
  });
  expect(tierOver.ok).toBe(false);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_shared_across_instances", () => {
  const home = tmp("nyra-budget-shared-");
  const a = new BudgetLedger(home);
  const b = new BudgetLedger(home);
  const r1 = a.reserve("session-a", 0.06, {
    limits: [{ scope: "run", limitUsd: 0.1, spentUsd: 0 }],
    reason: "manual",
  });
  expect(r1.ok).toBe(true);
  // 另一实例（另一会话）看得到第一笔在途预留：再预留 $0.05 超上限。
  const r2 = b.reserve("session-b", 0.05, {
    limits: [{ scope: "run", limitUsd: 0.1, spentUsd: 0 }],
    reason: "manual",
  });
  expect(r2.ok).toBe(false);
  expect(b.activeReservedUsd()).toBeCloseTo(0.06, 10);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_cross_process_reserve_is_atomic", async () => {
  const home = tmp("nyra-budget-race-");
  const child = join(import.meta.dir, "budget-race-child.ts");
  const runOnce = (): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
    const p = spawn(process.execPath, [child, home, "0.6", "1"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    p.on("error", rejectPromise);
    p.on("close", () => resolvePromise(out));
  });
  // 8 个进程同时抢：每笔 $0.60，上限 $1.00，只能有一笔成功；账本里也只剩一笔。
  // 没锁时两笔可能同时读到空账本、同时通过，事后互相覆盖丢记录。
  const results = await Promise.all(Array.from({ length: 8 }, () => runOnce()));
  expect(results.filter((r) => r === "ok").length).toBe(1);
  expect(results.filter((r) => r === "rejected").length).toBe(7);
  const ledger = new BudgetLedger(home);
  expect(ledger.activeReservedUsd()).toBeCloseTo(0.6, 10);
  expect(ledger.list().filter((r) => r.status === "reserved").length).toBe(1);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_stale_lock_is_recovered", () => {
  const home = tmp("nyra-budget-stale-lock-");
  const dir = join(home, ".budget-ledger.lock");
  mkdirSync(dir, { recursive: true });
  // 锁主已死（pid 不存在）：后来者应能抢走，不会永远卡住。
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: 999999, createdAt: Date.now() - 60_000 }), "utf-8");
  const ledger = new BudgetLedger(home);
  const res = ledger.reserve("cli", 0.05, { reason: "manual" });
  expect(res.ok).toBe(true);
  expect(existsSync(dir)).toBe(false);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_live_lock_times_out", () => {
  const home = tmp("nyra-budget-live-lock-");
  const release = acquireBudgetLock(home);
  // 锁被活进程占着：500ms 内拿不到就抛错，不无限等。
  expect(() => acquireBudgetLock(home, { timeoutMs: 500 })).toThrow("正被另一进程占用");
  release();
  // 释放后能正常拿到。
  const release2 = acquireBudgetLock(home);
  release2();
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_corrupt_backs_up_then_throws", () => {
  const home = tmp("nyra-budget-corrupt-");
  writeFileSync(join(home, "budget-ledger.json"), "{not json", "utf-8");
  const ledger = new BudgetLedger(home);
  expect(() => ledger.reserve("cli", 0.01, { reason: "manual" })).toThrow();
  const backups = readdirSync(home).filter((f) => f.startsWith("budget-ledger.json.corrupt-"));
  expect(backups.length).toBe(1);
  expect(readFileSync(join(home, backups[0]), "utf-8")).toBe("{not json");
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_ledger_prunes_expired_reservations", () => {
  const home = tmp("nyra-budget-expire-");
  const ledger = new BudgetLedger(home);
  const res = ledger.reserve("cli", 0.05, { reason: "manual", ttlMs: 1 });
  expect(res.ok).toBe(true);
  // TTL 只有 1 毫秒：等一会儿再读，在途应为 0；显式清掉后行标 released 留痕。
  const start = Date.now();
  while (Date.now() - start < 5) { /* busy wait */ }
  expect(ledger.activeReservedUsd()).toBe(0);
  if (!res.ok) throw new Error("reserve should succeed");
  expect(ledger.pruneExpired()).toBe(1);
  expect(ledger.get(res.reservation.id)?.status).toBe("released");
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_manual_reservation_survives_owner_pid_death", () => {
  const home = tmp("nyra-budget-manual-pid-");
  const deadPid = 999999;
  expect(isPidAlive(deadPid)).toBe(false);
  const now = new Date();
  const later = new Date(now.getTime() + 3_600_000).toISOString();
  const store = {
    version: 1,
    reservations: [
      { id: "rsv_manual_dead_pid", owner: "cli", amountUsd: 0.05, reason: "manual", bindingScope: null, createdAt: now.toISOString(), expiresAt: later, pid: deadPid, status: "reserved", settledUsd: null },
      { id: "rsv_call_dead_pid", owner: "sess-1", amountUsd: 0.05, reason: "next-call", bindingScope: null, createdAt: now.toISOString(), expiresAt: later, pid: deadPid, status: "reserved", settledUsd: null },
    ],
  };
  writeFileSync(join(home, "budget-ledger.json"), JSON.stringify(store), "utf-8");
  const ledger = new BudgetLedger(home);
  // 手动预留跨进程持有：预留命令跑完退出是正常的，TTL 还没到就仍算在途。
  expect(ledger.active().map((r) => r.id)).toContain("rsv_manual_dead_pid");
  // 调用预留的 owner 是正在跑的 agent：死了说明进程崩了，过期清掉。
  expect(ledger.active().map((r) => r.id)).not.toContain("rsv_call_dead_pid");
  expect(ledger.pruneExpired()).toBe(1);
  expect(ledger.get("rsv_manual_dead_pid")?.status).toBe("reserved");
  expect(ledger.get("rsv_call_dead_pid")?.status).toBe("released");
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_agent_reserves_before_call_and_settles", async () => {
  const home = tmp("nyra-budget-agent-");
  const workdir = tmp("nyra-budget-agent-work-");
  const provider = echoProvider("收到，已完成。", 100);
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    maxCostUsd: 10, pricing: PRICING,
    onEvent: (kind, data) => { events.push({ kind, data }); },
  });
  const text = await agent.run("打个招呼");
  expect(text).toContain("收到");
  expect(provider.calls).toBe(1);
  const ledger = new BudgetLedger(home);
  expect(ledger.activeReservedUsd()).toBe(0);
  const rows = ledger.list();
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("settled");
  // 假 provider 报 100 输入 + 10 补全 token：100/1M*1 + 10/1M*2 = 0.00012。
  expect(rows[0].settledUsd).toBeCloseTo(0.00012, 10);
  expect(rows[0].reason).toBe("next-call");
  expect(events.find((e) => e.kind === "budget_reserved")).toBeDefined();
  expect(events.find((e) => e.kind === "budget_settled")).toBeDefined();
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("BudgetReservation.test_agent_rejects_when_reservation_insufficient", async () => {
  const home = tmp("nyra-budget-reject-");
  const workdir = tmp("nyra-budget-reject-work-");
  const provider = echoProvider("收到，已完成。", 100);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    maxCostUsd: 0, pricing: PRICING,
  });
  await expect(agent.run("打个招呼")).rejects.toThrow("预算预留不足");
  // 调用根本没发出。
  expect(provider.calls).toBe(0);
  expect(new BudgetLedger(home).activeReservedUsd()).toBe(0);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("BudgetReservation.test_agent_pauses_when_no_pricing_strict", async () => {
  const home = tmp("nyra-budget-noprice-");
  const workdir = tmp("nyra-budget-noprice-work-");
  const provider = echoProvider("收到，已完成。", 100);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    maxCostUsd: 10, pricing: null,
  });
  await expect(agent.run("打个招呼")).rejects.toThrow("金额未知");
  // 严格模式下第一次调用前就停下：没花钱、没发请求。
  expect(provider.calls).toBe(0);
  const { listPauses } = await import("../../src/costCaps.ts");
  const pauses = listPauses(home, { status: "paused" }).filter((p) => p.scope === "unknown-amount");
  expect(pauses.length).toBe(1);
  expect(pauses[0].detail).toMatch(/^no-pricing:/);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("BudgetReservation.test_agent_pauses_when_usage_missing_strict", async () => {
  const home = tmp("nyra-budget-missing-");
  const workdir = tmp("nyra-budget-missing-work-");
  const provider = noUsageProvider();
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    maxCostUsd: 10, pricing: PRICING,
  });
  await expect(agent.run("打个招呼")).rejects.toThrow("金额未知");
  // 只调了一次就停下：不继续跑下一轮。
  expect(provider.calls).toBe(1);
  const { listPauses } = await import("../../src/costCaps.ts");
  const pauses = listPauses(home, { status: "paused" }).filter((p) => p.scope === "unknown-amount");
  expect(pauses.length).toBe(1);
  expect(pauses[0].detail).toMatch(/^missing-usage:/);
  // 预留已释放（算不出实际花费，不编结算数）。
  expect(new BudgetLedger(home).activeReservedUsd()).toBe(0);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("BudgetReservation.test_agent_no_pricing_continues_when_strict_off", async () => {
  const home = tmp("nyra-budget-off-");
  const workdir = tmp("nyra-budget-off-work-");
  const provider = echoProvider("收到，已完成。", 100);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    maxCostUsd: 10, pricing: null, strictUnknownAmount: false,
  });
  const text = await agent.run("打个招呼");
  expect(text).toContain("收到");
  expect(provider.calls).toBe(1);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("BudgetReservation.test_parallel_reservations_do_not_overspend", async () => {
  const home = tmp("nyra-budget-parallel-");
  const ledger = new BudgetLedger(home);
  const limit = 0.12;
  const perThread = 0.05;
  const specs: ParallelTaskSpec[] = [0, 1, 2, 3, 4].map((i) => ({ task: `线程 ${i}` }));
  const started: number[] = [];
  const result = await runParallelDelegate(
    async (spec, index): Promise<ParallelThreadOutcome> => {
      started.push(index);
      return { ok: true, summary: `线程 ${index} 完成`, spentUsd: 0.01, model: "fake-1" };
    },
    specs,
    {
      maxConcurrency: 5,
      reserveThread: (_spec, index) => {
        const res = ledger.reserve(`parallel:test:${index}`, perThread, {
          limits: [{ scope: "run", limitUsd: limit, spentUsd: 0 }],
          reason: "parallel-thread",
        });
        if (!res.ok) return { ok: false, reason: `预算预留不足：${res.reason}` };
        return { ok: true, reservationId: res.reservation.id };
      },
    },
  );
  // 上限 $0.12，每线程 $0.05：只放行 2 个，剩下 3 个直接 rejected、不启动。
  expect(result.succeeded).toBe(2);
  expect(result.rejected).toBe(3);
  expect(started.length).toBe(2);
  expect(result.results.filter((r) => r.status === "rejected").every((r) => (r.error ?? "").includes("预算预留不足"))).toBe(true);
  // 在途预留正好是放行的两笔，不超上限。
  expect(ledger.activeReservedUsd()).toBeCloseTo(0.1, 10);
  expect(ledger.activeReservedUsd()).toBeLessThanOrEqual(limit);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_budget_events_registered_and_rendered", () => {
  const home = tmp("nyra-budget-events-");
  const store = new RunStore(join(home, "runs"));
  const run = store.create("预算事件测试", "sess-1", home, "full", 6);
  store.appendEvent(run.run_id, "budget_reserved", { reservation_id: "rsv_abc", owner: "cli", amount_usd: 0.05 });
  store.appendEvent(run.run_id, "budget_settled", { reservation_id: "rsv_abc", reserved_usd: 0.05, actual_usd: 0.01 });
  store.appendEvent(run.run_id, "budget_released", { reservation_id: "rsv_def", amount_usd: 0.02, reason: "cancelled" });
  store.appendEvent(run.run_id, "budget_rejected", { owner: "cli", amount_usd: 0.5, reason: "单次上限" });
  store.appendEvent(run.run_id, "budget_paused", { pause_id: "pause-1", agent: "nyra", reason: "no-pricing:fake-1" });
  store.appendEvent(run.run_id, "budget_resumed", { pause_id: "pause-1", agent: "nyra" });
  const text = formatTimelineText(buildTimeline(store, run.run_id));
  expect(text).toContain("rsv_abc");
  expect(text).toContain("pause-1");
  // create 自带一条 run_started 事件，6 条预算事件都在。
  const types = store.readEvents(run.run_id).map((e) => e.type);
  for (const t of ["budget_reserved", "budget_settled", "budget_released", "budget_rejected", "budget_paused", "budget_resumed"]) {
    expect(types).toContain(t);
  }
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_budget_cli_roundtrip", () => {
  const home = tmp("nyra-budget-cli-");
  expect(budgetMain(["list"], home)).toBe(0);
  expect(budgetMain(["reserve", "0.5", "--reason", "manual"], home)).toBe(0);
  const ledger = new BudgetLedger(home);
  expect(ledger.activeReservedUsd()).toBeCloseTo(0.5, 10);
  const id = ledger.active()[0].id;
  expect(budgetMain(["settle", id, "0.2"], home)).toBe(0);
  expect(ledger.activeReservedUsd()).toBe(0);
  expect(ledger.get(id)?.status).toBe("settled");
  expect(ledger.get(id)?.settledUsd).toBeCloseTo(0.2, 10);
  // 未知 id 结算/释放都失败（exit 1）。
  expect(budgetMain(["settle", "rsv_nope", "0.1"], home)).toBe(1);
  expect(budgetMain(["release", "rsv_nope"], home)).toBe(1);
  // 非法金额拒绝。
  expect(budgetMain(["reserve", "abc"], home)).toBe(1);
  expect(budgetMain(["reserve", "-1"], home)).toBe(1);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_budget_cli_strict_switch", () => {
  const home = tmp("nyra-budget-strict-");
  // 默认开。
  expect(budgetMain(["strict"], home)).toBe(0);
  // 改开关须 --yes。
  expect(budgetMain(["strict", "--off"], home)).toBe(1);
  expect(budgetMain(["strict", "--off", "--yes"], home)).toBe(0);
  expect(resolveStrictUnknownAmount(JSON.parse(readFileSync(join(home, "config.json"), "utf-8")))).toBe(false);
  expect(budgetMain(["strict", "--on", "--yes"], home)).toBe(0);
  expect(resolveStrictUnknownAmount(JSON.parse(readFileSync(join(home, "config.json"), "utf-8")))).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_budget_cli_show_json", () => {
  const home = tmp("nyra-budget-show-");
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    expect(budgetMain(["show", "--json"], home)).toBe(0);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.strict_unknown_amount).toBe(true);
  expect(parsed.active_reserved_usd).toBe(0);
  // 月度上限已移除：show --json 不再输出 monthly_limit_usd。
  expect("monthly_limit_usd" in parsed).toBe(false);
  rmSync(home, { recursive: true, force: true });
});

test("BudgetReservation.test_config_explain_budget", () => {
  const on = explainOne({ config: {} }, "budget");
  expect(on).not.toBeNull();
  expect(on?.effective).toContain("开");
  const off = explainOne({ config: { budget: { strict_unknown_amount: false } } }, "budget");
  expect(off?.effective).toContain("关");
});

test("BudgetReservation.test_cost_json_budget_field", () => {
  const withBudget = buildCostJson({
    model: null, config: {},
    budget: { activeReservedUsd: 0.05, strictUnknownAmount: true },
    monthly: null,
  });
  expect(withBudget.budget?.active_reserved_usd).toBeCloseTo(0.05, 10);
  expect(withBudget.budget?.strict_unknown_amount).toBe(true);
  const withoutBudget = buildCostJson({ model: null, config: {}, monthly: null });
  expect(withoutBudget.budget).toBeNull();
});

test("BudgetReservation.test_tiered_token_cap_still_guards_without_pricing", async () => {
  // 回归：只配分层 token 上限、无单价时，分层回调仍拦停（token 层不需要
  // 单价），不能被“金额未知暂停”抢先。旧口径见 test-cost-caps 的
  // test_agent_callback_stops_run_and_pauses。
  const home = tmp("nyra-budget-tiered-");
  const workdir = tmp("nyra-budget-tiered-work-");
  const { makeTieredCapCheck, setCap, listPauses } = await import("../../src/costCaps.ts");
  const { UsageLedger } = await import("../../src/usageLedger.ts");
  const usageLedger = new UsageLedger(home);
  usageLedger.recordDelta({
    calls: 1, reported_calls: 1, missing_calls: 0,
    prompt_tokens: 150, completion_tokens: 0, total_tokens: 150,
    prompt_samples: 0, completion_samples: 0, total_samples: 0,
    last_prompt_tokens: 150, context_window_tokens: null, context_remaining_tokens: null,
  } as never, null, null, null, "fake-1", new Date(), "bot-a");
  setCap(home, "agent:bot-a", { dayTokens: 100, reason: "测试" });
  const ctx = { runId: "run-agent-1" };
  const provider = echoProvider("你好", 100);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    tieredCapCheck: makeTieredCapCheck(home, "bot-a", ctx),
  });
  await expect(agent.run("说你好")).rejects.toThrow("分层成本上限已超");
  const pauses = listPauses(home);
  expect(pauses.length).toBe(1);
  expect(pauses[0].scope).not.toBe("unknown-amount");
  expect(pauses[0].runId).toBe("run-agent-1");
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("BudgetReservation.test_tiered_only_does_not_reserve", async () => {
  // 只有分层回调、没有美元上限时：不预留（没上限可守），分层仍由回调自己判。
  const home = tmp("nyra-budget-tieredonly-");
  const workdir = tmp("nyra-budget-tieredonly-work-");
  const { makeTieredCapCheck } = await import("../../src/costCaps.ts");
  const provider = echoProvider("你好", 100);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    pricing: PRICING,
    tieredCapCheck: makeTieredCapCheck(home, "bot-a", {}),
  });
  const text = await agent.run("说你好");
  expect(text).toContain("你好");
  expect(provider.calls).toBe(1);
  expect(new BudgetLedger(home).list().length).toBe(0);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});
