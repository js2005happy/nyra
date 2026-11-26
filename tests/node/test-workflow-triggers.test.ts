// tests/node/test-workflow-triggers.test.ts — 缺口 25 的尾巴：触发器执行。
//
// 覆盖：cron 5 字段匹配（含日/周的 OR 规则、7=周日）、全局开关默认关、
// 定时触发（同一分钟不重复跑、失败记证据）、事件触发（同事件去重、
// 非 active 不跑、事件名须精确命中）、CLI triggers 子命令。
// cron 断言用固定本地日期（2026-01-05 是周一、2026-01-11 是周日，
// 日历日期的星期几与时区无关），不是“写死绝对时间窗口”。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronMatches, describeWorkflowTriggers, fireWorkflowEventTriggers,
  loadWorkflowTriggerState, runDueWorkflowTriggers, setWorkflowTriggersEnabled,
} from "../../src/workflowTriggers.ts";
import {
  importWorkflow, loadWorkflowRegistry, saveWorkflowRegistry, handleWorkflow,
  getWorkflowRun,
} from "../../src/workflow.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-wft-test-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function toolDef(name: string, triggers: unknown[]): Record<string, unknown> {
  return {
    name, version: 1, mode: "fixed",
    inputs: { file: "/tmp/x.txt" },
    triggers,
    steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: "{{inputs.file}}" } }],
  };
}

async function importAndActivate(home: string, def: Record<string, unknown>): Promise<void> {
  const file = join(home, `${String(def.name)}.json`);
  writeFileSync(file, JSON.stringify(def));
  await importWorkflow(home, file);
  const registry = loadWorkflowRegistry(home);
  const entry = registry.workflows.find((w) => w.name === def.name);
  if (!entry) throw new Error("导入后注册表里没有该工作流");
  entry.status = "active";
  saveWorkflowRegistry(home, registry);
}

const MON_1030 = new Date(2026, 0, 5, 10, 30); // 周一
const SUN_1030 = new Date(2026, 0, 11, 10, 30); // 周日
const MON_1031 = new Date(2026, 0, 5, 10, 31);

test("cron：每分钟/整点/每周一", () => {
  expect(cronMatches("* * * * *", MON_1030)).toBe(true);
  expect(cronMatches("30 10 * * *", MON_1030)).toBe(true);
  expect(cronMatches("30 10 * * *", MON_1031)).toBe(false);
  expect(cronMatches("30 10 * * 1", MON_1030)).toBe(true);
  expect(cronMatches("30 10 * * 0", MON_1030)).toBe(false);
  expect(cronMatches("30 10 * * 0", SUN_1030)).toBe(true);
  expect(cronMatches("30 10 * * 7", SUN_1030)).toBe(true); // 7 当周日
});

test("cron：步长/范围/列表/月日", () => {
  expect(cronMatches("*/15 * * * *", MON_1030)).toBe(true);
  expect(cronMatches("*/15 * * * *", MON_1031)).toBe(false);
  // “0 9-17 * * *”是 0 分触发：10:00 命中，10:30 不命中，18:00 不命中。
  expect(cronMatches("0 9-17 * * *", new Date(2026, 0, 5, 10, 0))).toBe(true);
  expect(cronMatches("0 9-17 * * *", MON_1030)).toBe(false);
  expect(cronMatches("0 9-17 * * *", new Date(2026, 0, 5, 18, 0))).toBe(false);
  expect(cronMatches("30 10,11 * * *", MON_1030)).toBe(true);
  expect(cronMatches("0 0 1 * *", new Date(2026, 0, 1, 0, 0))).toBe(true);
  expect(cronMatches("0 0 1 * *", new Date(2026, 0, 2, 0, 0))).toBe(false);
  expect(cronMatches("0 0 * 1 *", new Date(2026, 0, 15, 0, 0))).toBe(true);
  expect(cronMatches("0 0 * 2 *", new Date(2026, 0, 15, 0, 0))).toBe(false);
});

test("cron：日与周两边都限制时任一边命中即可", () => {
  expect(cronMatches("30 10 6 * 1", MON_1030)).toBe(true); // 周一命中（日是 5 号）
  expect(cronMatches("30 10 6 * 2", MON_1030)).toBe(false); // 日不是 6 号，周不是周二
  expect(cronMatches("30 10 5 * 2", MON_1030)).toBe(true); // 日是 5 号
});

test("cron：写坏了返回 false，不抛错", () => {
  for (const bad of ["not a cron", "61 * * * *", "* * * *", "30 10 * *", "*/0 * * * *", "5-1 * * * *"]) {
    expect(cronMatches(bad, MON_1030)).toBe(false);
  }
});

test("开关：默认关，关着不跑任何东西", async () => {
  const home = tempHome();
  try {
    expect(loadWorkflowTriggerState(home).enabled).toBe(false);
    await importAndActivate(home, toolDef("定时读", [{ type: "schedule", cron: "* * * * *" }]));
    const r = await runDueWorkflowTriggers(home, { now: MON_1030, runFn: async () => ({ id: "never" }) });
    expect(r.skipped).toContain("未开启");
    expect(r.fired).toEqual([]);
    const st = describeWorkflowTriggers(home);
    expect(st.enabled).toBe(false);
    expect(st.workflows).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("定时触发：到点跑一次，同一分钟不重复跑，下一分钟再跑", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("定时读", [{ type: "schedule", cron: "30 10 * * *" }]));
    setWorkflowTriggersEnabled(home, true);
    const runs: string[] = [];
    const runFn = async (_h: string, name: string) => { runs.push(name); return { id: `run-${runs.length}` }; };
    const r1 = await runDueWorkflowTriggers(home, { now: MON_1030, runFn });
    expect(r1.fired).toHaveLength(1);
    expect(r1.fired[0].status).toBe("ok");
    expect(r1.fired[0].runId).toBe("run-1");
    expect(runs).toEqual(["定时读"]);
    const r2 = await runDueWorkflowTriggers(home, { now: MON_1030, runFn });
    expect(r2.fired).toEqual([]);
    // 次日同一时刻（分钟键不同）再跑一次。
    const r3 = await runDueWorkflowTriggers(home, { now: new Date(2026, 0, 6, 10, 30), runFn });
    expect(r3.fired).toHaveLength(1);
    expect(runs).toEqual(["定时读", "定时读"]);
  } finally {
    cleanup(home);
  }
});

test("定时触发：未到点不跑；draft 不跑；执行失败记 failed 不炸整轮", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("定时读", [{ type: "schedule", cron: "30 10 * * *" }]));
    // 再导一个 draft（不激活），同名事件也不该跑。
    const draftFile = join(home, "草稿.json");
    writeFileSync(draftFile, JSON.stringify(toolDef("草稿", [{ type: "schedule", cron: "* * * * *" }])));
    await importWorkflow(home, draftFile);
    setWorkflowTriggersEnabled(home, true);
    const early = await runDueWorkflowTriggers(home, { now: new Date(2026, 0, 5, 9, 30), runFn: async () => ({ id: "x" }) });
    expect(early.fired).toEqual([]);
    const failing = await runDueWorkflowTriggers(home, {
      now: MON_1030,
      runFn: async () => { throw new Error("boom"); },
    });
    expect(failing.fired).toHaveLength(1);
    expect(failing.fired[0].status).toBe("failed");
    expect(failing.fired[0].error).toBe("boom");
    expect(failing.fired[0].workflow).toBe("定时读");
  } finally {
    cleanup(home);
  }
});

test("定时触发：真跑 tool 工作流（不调模型），运行记录与证据都留", async () => {
  const home = tempHome();
  try {
    const file = join(home, "hello.txt");
    writeFileSync(file, "hello trigger");
    const def = toolDef("真跑", [{ type: "schedule", cron: "30 10 * * *" }]); // O6：每分钟 cron 到点会被护栏停用（绕过激活的手改注册表也一样），改成每天 10:30（MON_1030 到点）。
    def.inputs = { file };
    await importAndActivate(home, def);
    setWorkflowTriggersEnabled(home, true);
    const r = await runDueWorkflowTriggers(home, { now: MON_1030, workdir: home });
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0].status).toBe("ok");
    const run = getWorkflowRun(home, r.fired[0].runId ?? "");
    expect(run?.status).toBe("completed");
    expect(run?.nodes[0].output).toContain("hello trigger");
    const evDir = join(home, "evidence", "workflow-triggers");
    expect(existsSync(evDir)).toBe(true);
    expect(readdirSync(evDir).length).toBe(1);
    const evText = readFileSync(join(evDir, readdirSync(evDir)[0]), "utf-8");
    expect(evText).toContain("真跑");
  } finally {
    cleanup(home);
  }
});

test("事件触发：精确命中事件名，同事件去重，不同事件再跑", async () => {
  const home = tempHome();
  try {
    await importAndActivate(home, toolDef("看推送", [{ type: "event", event: "github.push" }]));
    setWorkflowTriggersEnabled(home, true);
    const runs: string[] = [];
    const runFn = async (_h: string, name: string) => { runs.push(name); return { id: `run-${runs.length}` }; };
    const event = { source: "webhook" as const, eventType: "github.push", eventId: "evt-1", receivedAt: new Date().toISOString(), payload: {} };
    const r1 = await fireWorkflowEventTriggers(home, event, { runFn });
    expect(r1.fired).toHaveLength(1);
    const r2 = await fireWorkflowEventTriggers(home, event, { runFn });
    expect(r2.fired).toEqual([]);
    const other = await fireWorkflowEventTriggers(home, { ...event, eventId: "evt-2" }, { runFn });
    expect(other.fired).toHaveLength(1);
    const miss = await fireWorkflowEventTriggers(home, { ...event, eventType: "slack.message", eventId: "evt-3" }, { runFn });
    expect(miss.fired).toEqual([]);
    expect(runs).toEqual(["看推送", "看推送"]);
  } finally {
    cleanup(home);
  }
});

test("CLI：triggers status/enable/disable/run", async () => {
  const home = tempHome();
  try {
    const def = toolDef("每分钟读", [{ type: "schedule", cron: "* * * * *" }]);
    const file = join(home, "hello.txt");
    writeFileSync(file, "hello cli");
    def.inputs = { file };
    await importAndActivate(home, def);
    expect(await handleWorkflow(["triggers", "status"], home)).toBe(0);
    // enable 不加 --yes 拒绝。
    expect(await handleWorkflow(["triggers", "enable"], home)).toBe(2);
    expect(loadWorkflowTriggerState(home).enabled).toBe(false);
    expect(await handleWorkflow(["triggers", "enable", "--yes"], home)).toBe(0);
    expect(loadWorkflowTriggerState(home).enabled).toBe(true);
    // run 真跑一轮（cron 每分钟都到点）。
    expect(await handleWorkflow(["triggers", "run"], home)).toBe(0);
    expect(await handleWorkflow(["triggers", "disable"], home)).toBe(0);
    expect(loadWorkflowTriggerState(home).enabled).toBe(false);
    expect(await handleWorkflow(["triggers", "bogus"], home)).toBe(2);
  } finally {
    cleanup(home);
  }
});
