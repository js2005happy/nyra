// tests/node/test-routine-guardrails.test.ts — O6：Routines 硬护栏。
// 15 分钟下限、最多 20 个启用、连续失败 10 次自动关闭，均在临时 home 上验，
// 不联网、不调真模型。日期用固定本地日期（2026-01-05 是周一），不是写死
// 绝对时间窗口。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronMinIntervalMinutes, listCronIncidents, MAX_CONSECUTIVE_FAILURES,
} from "../../src/cronMaturity.ts";
import {
  countEnabledRoutineTriggers, describeRoutineGuardrails, loadWorkflowTriggerState,
  reEnableTrigger, runDueWorkflowTriggers, setWorkflowTriggersEnabled,
} from "../../src/workflowTriggers.ts";
import {
  activateWorkflow, importWorkflow, loadWorkflowRegistry, saveWorkflowRegistry,
} from "../../src/workflow.ts";
import {
  addThreadCron, createThread, fireDueThreadCrons, listThreadCrons,
  reEnableThreadCron,
} from "../../src/threads.ts";
import { setWorkflowTriggersEnabled as enableTriggers } from "../../src/workflowTriggers.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-routine-guard-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function toolDef(name: string, triggers: unknown[]): Record<string, unknown> {
  return {
    name, version: 1, mode: "fixed",
    inputs: { file: "/tmp/x.txt" },
    triggers,
    steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: "{{inputs.file}}" } }],
  };
}

async function importTrialPassed(home: string, def: Record<string, unknown>): Promise<void> {
  const file = join(home, `${String(def.name)}.json`);
  writeFileSync(file, JSON.stringify(def));
  await importWorkflow(home, file);
  const registry = loadWorkflowRegistry(home);
  const entry = registry.workflows.find((w) => w.name === def.name);
  if (!entry) throw new Error("导入后注册表里没有该工作流");
  entry.status = "trial_passed";
  saveWorkflowRegistry(home, registry);
}

async function importAndActivate(home: string, def: Record<string, unknown>): Promise<void> {
  await importTrialPassed(home, def);
  activateWorkflow(home, String(def.name), true);
}

const MON = new Date(2026, 0, 5, 10, 30); // 周一 10:30

// ---- 间隔计算 ----

test("RoutineGuardrailsTest.test_cron_min_interval", () => {
  expect(cronMinIntervalMinutes("* * * * *", MON)).toBe(1);
  expect(cronMinIntervalMinutes("*/5 * * * *", MON)).toBe(5);
  expect(cronMinIntervalMinutes("*/15 * * * *", MON)).toBe(15);
  expect(cronMinIntervalMinutes("0 * * * *", MON)).toBe(60);
  expect(cronMinIntervalMinutes("30 10 * * *", MON)).toBe(24 * 60);
  // 每周一次：8 天内不足两次匹配，算通过（null）。
  expect(cronMinIntervalMinutes("0 0 * * 0", MON)).toBe(null);
});

// ---- 激活时拦下限 ----

test("RoutineGuardrailsTest.test_activation_rejects_below_floor", async () => {
  const home = tempHome();
  try {
    await importTrialPassed(home, toolDef("太密", [{ type: "schedule", cron: "*/5 * * * *" }]));
    expect(() => activateWorkflow(home, "太密", true)).toThrow(/低于例行下限 15 分钟/);
    // 15 分钟正好通过。
    await importTrialPassed(home, toolDef("正好", [{ type: "schedule", cron: "*/15 * * * *" }]));
    const entry = activateWorkflow(home, "正好", true);
    expect(entry.status).toBe("active");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("RoutineGuardrailsTest.test_thread_cron_rejects_below_floor", () => {
  const home = tempHome();
  try {
    const t = createThread(home, "复盘");
    expect(() => addThreadCron(home, t.id, "*/5 * * * *", "正好")).toThrow(/低于例行下限 15 分钟/);
    const c = addThreadCron(home, t.id, "*/15 * * * *", "正好");
    expect(c.cron).toBe("*/15 * * * *");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 20 条上限 ----

test("RoutineGuardrailsTest.test_activation_rejects_over_20_enabled", async () => {
  const home = tempHome();
  try {
    const triggers10 = Array.from({ length: 10 }, () => ({ type: "schedule", cron: "0 * * * *" }));
    await importAndActivate(home, toolDef("十个一", triggers10));
    await importAndActivate(home, toolDef("十个二", triggers10));
    expect(countEnabledRoutineTriggers(home)).toBe(20);
    await importTrialPassed(home, toolDef("再来一个", [{ type: "schedule", cron: "0 * * * *" }]));
    expect(() => activateWorkflow(home, "再来一个", true)).toThrow(/超过上限 20/);
    // 事件触发器也计数：20 个已满，事件触发器同样拦。
    await importTrialPassed(home, toolDef("事件一个", [{ type: "event", event: "gmail.new" }]));
    expect(() => activateWorkflow(home, "事件一个", true)).toThrow(/超过上限 20/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 连续失败 10 次自动关闭 ----

test("RoutineGuardrailsTest.test_ten_consecutive_failures_auto_disable", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("总失败", [{ type: "schedule", cron: "30 10 * * *" }]));
    setWorkflowTriggersEnabled(home, true);
    const failing = async (): Promise<{ id: string }> => { throw new Error("boom"); };
    // 每天 10:30 各跑一次，连败 10 次。
    for (let d = 0; d < 10; d++) {
      const now = new Date(2026, 0, 5 + d, 10, 30);
      const r = await runDueWorkflowTriggers(home, { now, runFn: failing });
      expect(r.fired).toHaveLength(1);
      expect(r.fired[0]!.status).toBe("failed");
    }
    const state = loadWorkflowTriggerState(home);
    expect(state.disabled_triggers?.["总失败\n0"]).toBeDefined();
    expect(state.disabled_triggers?.["总失败\n0"]?.failures).toBe(10);
    // 事故账里有 auto_disabled，`nyra cron incidents` 可见。
    const disabled = listCronIncidents(home, { kind: "auto_disabled" });
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.workflow).toBe("总失败");
    expect(disabled[0]!.consecutive_failures).toBe(10);
    // 第 11 天：已停用，不再跑。
    const r11 = await runDueWorkflowTriggers(home, { now: new Date(2026, 0, 15, 10, 30), runFn: failing });
    expect(r11.fired).toHaveLength(0);
    // 恢复后下次到点会再跑。
    expect(reEnableTrigger(home, "总失败", 0)).toBe(true);
    expect(reEnableTrigger(home, "总失败", 0)).toBe(false);
    expect(listCronIncidents(home, { kind: "re_enabled" })).toHaveLength(1);
    const r12 = await runDueWorkflowTriggers(home, { now: new Date(2026, 0, 16, 10, 30), runFn: async () => ({ id: "ok-1" }) });
    expect(r12.fired).toHaveLength(1);
    expect(r12.fired[0]!.status).toBe("ok");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("RoutineGuardrailsTest.test_success_resets_consecutive_failures", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("时好时坏", [{ type: "schedule", cron: "30 10 * * *" }]));
    setWorkflowTriggersEnabled(home, true);
    const failing = async (): Promise<{ id: string }> => { throw new Error("boom"); };
    for (let d = 0; d < 9; d++) {
      await runDueWorkflowTriggers(home, { now: new Date(2026, 0, 5 + d, 10, 30), runFn: failing });
    }
    expect(loadWorkflowTriggerState(home).consecutive_failures?.["时好时坏\n0"]).toBe(9);
    // 第 10 天成功：清零，不停用。
    const ok = await runDueWorkflowTriggers(home, { now: new Date(2026, 0, 14, 10, 30), runFn: async () => ({ id: "ok" }) });
    expect(ok.fired[0]!.status).toBe("ok");
    expect(loadWorkflowTriggerState(home).consecutive_failures?.["时好时坏\n0"]).toBeUndefined();
    expect(loadWorkflowTriggerState(home).disabled_triggers?.["时好时坏\n0"]).toBeUndefined();
    expect(listCronIncidents(home, { kind: "auto_disabled" })).toHaveLength(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("RoutineGuardrailsTest.test_guardrails_describe", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("一个", [{ type: "schedule", cron: "30 10 * * *" }]));
    const g = describeRoutineGuardrails(home);
    expect(g.minIntervalMinutes).toBe(15);
    expect(g.maxEnabled).toBe(20);
    expect(g.maxConsecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(g.enabledCount).toBe(1);
    expect(g.disabledCount).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 线程 cron 连败自动关闭 ----

test("RoutineGuardrailsTest.test_thread_cron_ten_failures_auto_disable", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("线程目标", [{ type: "schedule", cron: "30 10 * * *" }]));
    const t = createThread(home, "复盘");
    const c = addThreadCron(home, t.id, "30 10 * * *", "线程目标");
    enableTriggers(home, true);
    const failing = async (): Promise<{ id: string }> => { throw new Error("boom"); };
    for (let d = 0; d < 10; d++) {
      const r = await fireDueThreadCrons(home, { now: new Date(2026, 0, 5 + d, 10, 30), runFn: failing });
      expect(r.fired.filter((f) => f.status === "failed")).toHaveLength(1);
    }
    const listed = listThreadCrons(home, t.id);
    expect(listed[0]!.disabled).toBe(true);
    const disabled = listCronIncidents(home, { kind: "auto_disabled" });
    expect(disabled.some((e) => e.source === "thread" && e.cron_id === c.id)).toBe(true);
    // 第 11 天不再跑。
    const r11 = await fireDueThreadCrons(home, { now: new Date(2026, 0, 15, 10, 30), runFn: failing });
    expect(r11.fired).toHaveLength(0);
    // 恢复。
    expect(reEnableThreadCron(home, t.id, c.id)).toBe(true);
    expect(listThreadCrons(home, t.id)[0]!.disabled).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
