// tests/node/test-cron-maturity.test.ts — G-P1-38 cron 成熟语义。
//
// 覆盖：cronMatches 重导出、漏跑分钟计算、策略默认与改写、配额 hold
// （打戳/续戳/释放/同月限定/fail-open）、事故账往返与上限、工作流触发器
// 漏跑补跑（once/skip/到点正常跑/新建不背旧账/窗口 0）与 hold 挂起、
// 线程 cron 补跑与 hold、失败记事故、CLI 全程与 triggers status 输出。
// cron 断言用固定本地日期（2026-01-05 是周一），hold 的月份在固定日期
// 的测试里用 2026-01，在真实时间的测试里用相对当前时间算。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  appendCronIncident, cronMatches, findActiveCostPause, listCronIncidents,
  missedCronMinutes, minuteKey, parseMinuteKey,
} from "../../src/cronMaturity.ts";
import {
  clearQuotaHold, describeQuotaHold, describeWorkflowTriggers, evaluateQuotaHold,
  fireWorkflowEventTriggers, getCronPolicy, loadWorkflowTriggerState, runDueWorkflowTriggers,
  saveWorkflowTriggerState, setCronPolicy, setWorkflowTriggersEnabled,
} from "../../src/workflowTriggers.ts";
import {
  handleWorkflow, importWorkflow, loadWorkflowRegistry, saveWorkflowRegistry,
} from "../../src/workflow.ts";
import {
  addThreadCron, createThread, fireDueThreadCrons, loadThreads, saveThreads,
} from "../../src/threads.ts";
import { handleCron } from "../../src/cronCli.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-cronmat-test-"));
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

/** 把一条成本暂停写进 cost-pauses.json（直接写账本，测 hold 判定）。 */
function writePauses(home: string, pauses: Array<Record<string, unknown>>): void {
  writeFileSync(join(home, "cost-pauses.json"), JSON.stringify({ version: 1, pauses }));
}

function makePause(id: string, at: string, status = "paused"): Record<string, unknown> {
  return {
    id, at, agent: "nyra", scope: "agent:nyra", capUsd: 10, spentUsd: 10,
    capTokens: null, spentTokens: 0, taskId: null, runId: null, checkpointRef: null,
    status, decidedBy: null, decidedAt: null, note: null,
  };
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return {
    logs,
    restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; },
  };
}

const MON_1000 = new Date(2026, 0, 5, 10, 0); // 周一 10:00
const MON_1230 = new Date(2026, 0, 5, 12, 30); // 周一 12:30

test("cronMatches 从 cronMaturity 重导出：基本匹配与坏表达式", () => {
  expect(cronMatches("* * * * *", MON_1000)).toBe(true);
  expect(cronMatches("0 10 * * *", MON_1000)).toBe(true);
  expect(cronMatches("0 10 * * *", MON_1230)).toBe(false);
  expect(cronMatches("not a cron", MON_1000)).toBe(false);
  expect(cronMatches("61 * * * *", MON_1000)).toBe(false);
});

test("minuteKey / parseMinuteKey 往返", () => {
  const k = minuteKey(MON_1230);
  expect(k).toBe("2026-01-05T12:30");
  expect(parseMinuteKey(k)?.getTime()).toBe(new Date(2026, 0, 5, 12, 30).getTime());
  expect(parseMinuteKey("not-a-key")).toBe(null);
  expect(parseMinuteKey("2026-13-40T99:99")).toBe(null);
});

test("missedCronMinutes：整点触发漏两小时、逐分钟不含当前分钟、anchor 为空不算", () => {
  const hours = missedCronMinutes("0 * * * *", MON_1000, MON_1230);
  expect(hours.map((d) => minuteKey(d))).toEqual(["2026-01-05T11:00", "2026-01-05T12:00"]);
  const every = missedCronMinutes("* * * * *", new Date(2026, 0, 5, 10, 0), new Date(2026, 0, 5, 10, 3));
  expect(every.map((d) => minuteKey(d))).toEqual(["2026-01-05T10:01", "2026-01-05T10:02"]);
  expect(missedCronMinutes("0 * * * *", null, MON_1230)).toEqual([]);
  expect(missedCronMinutes("0 * * * *", MON_1230, MON_1000)).toEqual([]);
  // 跨天：每天 0 点；missedCronMinutes 硬上限 1440 分钟，只留最近 24 小时内的。
  const daily = missedCronMinutes("0 0 * * *", new Date(2026, 0, 1, 0, 0), new Date(2026, 0, 5, 10, 30));
  expect(daily.map((d) => minuteKey(d))).toEqual(["2026-01-05T00:00"]);
});

test("策略：默认 once/120/60；改写、钳制、非法值抛错；损坏状态文件回默认", () => {
  const home = tempHome();
  try {
    const def = getCronPolicy(home);
    expect(def).toEqual({ catchUp: "once", catchUpWindowMinutes: 120, quotaHoldMinutes: 60 });
    const p = setCronPolicy(home, { catchUp: "skip", catchUpWindowMinutes: 600, quotaHoldMinutes: 30 });
    expect(p).toEqual({ catchUp: "skip", catchUpWindowMinutes: 600, quotaHoldMinutes: 30 });
    expect(getCronPolicy(home).catchUp).toBe("skip");
    expect(() => setCronPolicy(home, { catchUp: "bogus" })).toThrow();
    expect(() => setCronPolicy(home, { catchUpWindowMinutes: Number.NaN })).toThrow();
    expect(() => setCronPolicy(home, { catchUpWindowMinutes: 2000 })).toThrow(); // 越界拒绝，不静默改数
    expect(() => setCronPolicy(home, { quotaHoldMinutes: 1 })).toThrow();
    expect(() => setCronPolicy(home, { quotaHoldMinutes: -3 })).toThrow();
    // 读路径钳制：手写越界值进状态文件，读出来钳到 1440/5。
    const raw = JSON.parse(readFileSync(join(home, "workflow-triggers.json"), "utf-8")) as Record<string, unknown>;
    raw.catch_up_window_minutes = 2000;
    raw.quota_hold_minutes = 1;
    writeFileSync(join(home, "workflow-triggers.json"), JSON.stringify(raw));
    expect(getCronPolicy(home)).toEqual({ catchUp: "skip", catchUpWindowMinutes: 1440, quotaHoldMinutes: 5 });
    // 状态文件损坏：只读回默认（load 侧备份损坏文件并抛错，getCronPolicy 接住）。
    writeFileSync(join(home, "workflow-triggers.json"), "{bad json");
    expect(getCronPolicy(home)).toEqual({ catchUp: "once", catchUpWindowMinutes: 120, quotaHoldMinutes: 60 });
    expect(describeQuotaHold(home).held).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("findActiveCostPause：没有文件/已解除/上个月/损坏都返回 null，本月未决才返回", () => {
  const home = tempHome();
  try {
    expect(findActiveCostPause(home, MON_1230)).toBe(null);
    writePauses(home, [makePause("p1", "2026-01-05T10:00:00.000Z", "resumed")]);
    expect(findActiveCostPause(home, MON_1230)).toBe(null);
    writePauses(home, [makePause("p2", "2025-12-20T10:00:00.000Z")]);
    expect(findActiveCostPause(home, MON_1230)).toBe(null);
    writeFileSync(join(home, "cost-pauses.json"), "{bad json");
    expect(findActiveCostPause(home, MON_1230)).toBe(null);
    writePauses(home, [makePause("p3", "2026-01-05T10:00:00.000Z")]);
    const found = findActiveCostPause(home, MON_1230);
    expect(found?.id).toBe("p3");
    expect(found?.scope).toBe("agent:nyra");
  } finally {
    cleanup(home);
  }
});

test("事故账：往返、新的在前、按 kind/workflow 过滤、limit、0600、坏行跳过", () => {
  const home = tempHome();
  try {
    appendCronIncident(home, { kind: "missed", source: "workflow", workflow: "a", count: 2, policy: "once" });
    appendCronIncident(home, { kind: "failed", source: "workflow", workflow: "b", error: "boom" });
    appendCronIncident(home, { kind: "missed", source: "thread", workflow: "a", count: 1, policy: "skip" });
    const all = listCronIncidents(home);
    expect(all).toHaveLength(3);
    expect(all[0].kind).toBe("missed"); // 新的在前
    expect(all[2].kind).toBe("missed");
    expect(listCronIncidents(home, { kind: "failed" })).toHaveLength(1);
    expect(listCronIncidents(home, { workflow: "a" })).toHaveLength(2);
    expect(listCronIncidents(home, { limit: 1 })).toHaveLength(1);
    expectPerms(join(home, "cron-incidents.jsonl"), 0o600);
    // 坏行跳过，不破坏整本账。
    appendFileSync(join(home, "cron-incidents.jsonl"), "this is not json\n");
    expect(listCronIncidents(home)).toHaveLength(3);
  } finally {
    cleanup(home);
  }
});

test("事故账：超过 500 条截到最近 500 条", () => {
  const home = tempHome();
  try {
    for (let i = 0; i < 505; i++) {
      appendCronIncident(home, { kind: "missed", source: "workflow", workflow: `w${i}`, count: 1 });
    }
    const rows = listCronIncidents(home, { limit: 100 });
    expect(rows).toHaveLength(100);
    const raw = readFileSync(join(home, "cron-incidents.jsonl"), "utf-8").split("\n").filter(Boolean);
    expect(raw.length).toBe(500);
    expect(JSON.parse(raw[0]).workflow).toBe("w5"); // 最旧的 5 条被截掉
    expect(JSON.parse(raw[raw.length - 1]).workflow).toBe("w504");
  } finally {
    cleanup(home);
  }
});

test("配额 hold：没暂停不拦；有暂停打戳 60 分钟，戳内不重复记账", () => {
  const home = tempHome();
  try {
    const now = new Date();
    const state = loadWorkflowTriggerState(home);
    expect(evaluateQuotaHold(home, state, now).held).toBe(false);
    writePauses(home, [makePause("p1", new Date(now.getTime() - 10 * 60_000).toISOString())]);
    const h1 = evaluateQuotaHold(home, loadWorkflowTriggerState(home), now);
    expect(h1.held).toBe(true);
    expect(h1.pauseId).toBe("p1");
    const stampMs = Date.parse(h1.holdUntil ?? "");
    expect(stampMs - now.getTime()).toBeGreaterThanOrEqual(59 * 60_000);
    expect(stampMs - now.getTime()).toBeLessThanOrEqual(61 * 60_000);
    expect(loadWorkflowTriggerState(home).quota_hold_until).toBe(h1.holdUntil);
    expect(listCronIncidents(home, { kind: "quota_held" })).toHaveLength(1);
    // 戳还在有效期内：同一戳，不新增事故。
    const h2 = evaluateQuotaHold(home, loadWorkflowTriggerState(home), new Date(now.getTime() + 5 * 60_000));
    expect(h2.holdUntil).toBe(h1.holdUntil);
    expect(listCronIncidents(home, { kind: "quota_held" })).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("配额 hold：戳过期且暂停仍在 → 续戳；暂停解除 → 清戳并记释放", () => {
  const home = tempHome();
  try {
    const now = new Date();
    writePauses(home, [makePause("p1", new Date(now.getTime() - 10 * 60_000).toISOString())]);
    const h1 = evaluateQuotaHold(home, loadWorkflowTriggerState(home), now);
    expect(h1.held).toBe(true);
    // 61 分钟后：戳过期，暂停仍在 → 续一个新戳。
    const later = new Date(now.getTime() + 61 * 60_000);
    const h2 = evaluateQuotaHold(home, loadWorkflowTriggerState(home), later);
    expect(h2.held).toBe(true);
    expect(Date.parse(h2.holdUntil ?? "")).toBeGreaterThan(Date.parse(h1.holdUntil ?? ""));
    expect(listCronIncidents(home, { kind: "quota_held" })).toHaveLength(2);
    expect(listCronIncidents(home, { kind: "quota_held" })[0].note).toContain("续戳");
    // 暂停解除后再过一轮：清戳、放行、记释放。
    writePauses(home, [makePause("p1", new Date(now.getTime() - 10 * 60_000).toISOString(), "resumed")]);
    const h3 = evaluateQuotaHold(home, loadWorkflowTriggerState(home), new Date(later.getTime() + 61 * 60_000));
    expect(h3.held).toBe(false);
    expect(loadWorkflowTriggerState(home).quota_hold_until ?? null).toBe(null);
    expect(listCronIncidents(home, { kind: "quota_released" })).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("配额 hold：hold 分钟走配置；clearQuotaHold 只清戳", () => {
  const home = tempHome();
  try {
    const now = new Date();
    setCronPolicy(home, { quotaHoldMinutes: 30 });
    writePauses(home, [makePause("p1", new Date(now.getTime() - 10 * 60_000).toISOString())]);
    const h = evaluateQuotaHold(home, loadWorkflowTriggerState(home), now);
    expect(Date.parse(h.holdUntil ?? "") - now.getTime()).toBeGreaterThanOrEqual(29 * 60_000);
    expect(Date.parse(h.holdUntil ?? "") - now.getTime()).toBeLessThanOrEqual(31 * 60_000);
    clearQuotaHold(home);
    expect(loadWorkflowTriggerState(home).quota_hold_until ?? null).toBe(null);
    expect(listCronIncidents(home, { kind: "quota_released" })).toHaveLength(1);
    // 暂停还在：describe 只读看仍是 held（下一轮会重新打戳）。
    expect(describeQuotaHold(home, now).held).toBe(true);
  } finally {
    cleanup(home);
  }
});

async function seedHourly(home: string, lastFired: Date | null): Promise<void> {
  await importAndActivate(home, toolDef("hourly-job", [{ type: "schedule", cron: "0 * * * *" }]));
  setWorkflowTriggersEnabled(home, true);
  if (lastFired) {
    const state = loadWorkflowTriggerState(home);
    state.lastFired["hourly-job\n0"] = minuteKey(lastFired);
    saveWorkflowTriggerState(home, state);
  }
}

test("触发器漏跑：once 只补跑一次（最近一次），其余记 missed ×N", async () => {
  const home = tempHome();
  try {
    await seedHourly(home, MON_1000); // 上次 10:00，12:30 跑：漏 11:00、12:00
    let runs = 0;
    const r = await runDueWorkflowTriggers(home, {
      now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(1);
    expect(r.fired).toHaveLength(1);
    expect(r.missed).toEqual([{ workflow: "hourly-job", triggerIndex: 0, count: 2, caughtUp: true }]);
    const caught = listCronIncidents(home, { kind: "caught_up" });
    expect(caught).toHaveLength(1);
    expect(caught[0].scheduled_minute).toBe("2026-01-05T12:00");
    const missed = listCronIncidents(home, { kind: "missed" });
    expect(missed).toHaveLength(1);
    expect(missed[0].count).toBe(1);
    // 同一分钟再跑一轮：不再补跑（lastFired 已推进到 12:30）。
    const r2 = await runDueWorkflowTriggers(home, {
      now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(1);
    expect(r2.fired).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

test("触发器漏跑：skip 一次都不补跑，只记 missed ×N", async () => {
  const home = tempHome();
  try {
    await seedHourly(home, MON_1000);
    setCronPolicy(home, { catchUp: "skip" });
    let runs = 0;
    const r = await runDueWorkflowTriggers(home, {
      now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(0);
    expect(r.fired).toHaveLength(0);
    expect(r.missed).toEqual([{ workflow: "hourly-job", triggerIndex: 0, count: 2, caughtUp: false }]);
    expect(listCronIncidents(home, { kind: "caught_up" })).toHaveLength(0);
    const missed = listCronIncidents(home, { kind: "missed" });
    expect(missed).toHaveLength(1);
    expect(missed[0].count).toBe(2);
    expect(missed[0].policy).toBe("skip");
  } finally {
    cleanup(home);
  }
});

test("触发器漏跑：本分钟正好到点时正常触发照常跑，漏掉的只记账", async () => {
  const home = tempHome();
  try {
    await seedHourly(home, new Date(2026, 0, 5, 9, 0)); // 上次 9:00，11:00 跑：漏 10:00，本分钟到点
    let runs = 0;
    const r = await runDueWorkflowTriggers(home, {
      now: new Date(2026, 0, 5, 11, 0), workdir: home,
      runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(1);
    expect(r.missed).toEqual([{ workflow: "hourly-job", triggerIndex: 0, count: 1, caughtUp: false }]);
    expect(listCronIncidents(home, { kind: "caught_up" })).toHaveLength(0);
    expect(listCronIncidents(home, { kind: "missed" })[0].count).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("触发器漏跑：新建触发器没记过 lastFired，不背旧账；窗口 0 不统计", async () => {
  const home = tempHome();
  try {
    await seedHourly(home, null);
    let runs = 0;
    const r = await runDueWorkflowTriggers(home, {
      now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(0);
    expect(r.missed).toEqual([]);
    expect(listCronIncidents(home)).toHaveLength(0);
    // 窗口 0：就算有 lastFired 也不统计漏跑。
    const state = loadWorkflowTriggerState(home);
    state.lastFired["hourly-job\n0"] = minuteKey(MON_1000);
    saveWorkflowTriggerState(home, state);
    setCronPolicy(home, { catchUpWindowMinutes: 0 });
    const r2 = await runDueWorkflowTriggers(home, {
      now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(0);
    expect(listCronIncidents(home)).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

test("触发器 hold：成本暂停在时定时与事件触发全部挂起，lastFired 不推进", async () => {
  const home = tempHome();
  try {
    await seedHourly(home, MON_1000);
    writePauses(home, [makePause("p1", "2026-01-05T10:00:00.000Z")]);
    let runs = 0;
    const r = await runDueWorkflowTriggers(home, {
      now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(0);
    expect(r.skipped).toContain("hold");
    expect(r.held?.held).toBe(true);
    expect(loadWorkflowTriggerState(home).lastFired["hourly-job\n0"]).toBe(minuteKey(MON_1000));
    // 事件触发同样挂起：不跑、不记 firedEvents。
    const ev = await fireWorkflowEventTriggers(home, {
      source: "webhook", eventType: "github_issue_opened", eventId: "ev-1",
      receivedAt: new Date().toISOString(), payload: {},
    }, { now: MON_1230, workdir: home, runFn: async () => { runs++; return { id: `run-${runs}` }; } });
    expect(runs).toBe(0);
    expect(ev.skipped).toContain("hold");
    expect(loadWorkflowTriggerState(home).firedEvents).toEqual({});
    expect(listCronIncidents(home, { kind: "quota_held" })).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("触发失败记一笔 failed 事故（证据链照常写）", async () => {
  const home = tempHome();
  try {
    await seedHourly(home, MON_1000);
    const r = await runDueWorkflowTriggers(home, {
      now: new Date(2026, 0, 5, 11, 0), workdir: home,
      runFn: async () => { throw new Error("模型挂了"); },
    });
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0].status).toBe("failed");
    const failed = listCronIncidents(home, { kind: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("模型挂了");
  } finally {
    cleanup(home);
  }
});

test("describeWorkflowTriggers 露出策略与 hold 状态", () => {
  const home = tempHome();
  try {
    setCronPolicy(home, { catchUp: "skip", catchUpWindowMinutes: 60 });
    const st = describeWorkflowTriggers(home);
    expect(st.policy.catchUp).toBe("skip");
    expect(st.policy.catchUpWindowMinutes).toBe(60);
    expect(st.hold.held).toBe(false);
    writePauses(home, [makePause("p1", new Date().toISOString())]);
    expect(describeWorkflowTriggers(home).hold.held).toBe(true);
  } finally {
    cleanup(home);
  }
});

async function seedThreadCron(home: string, lastFired: Date | null): Promise<string> {
  const registry = loadWorkflowRegistry(home);
  if (!registry.workflows.some((w) => w.name === "hourly-job")) {
    await importAndActivate(home, toolDef("hourly-job", [{ type: "schedule", cron: "0 * * * *" }]));
  }
  setWorkflowTriggersEnabled(home, true);
  const t = createThread(home, "值守线程");
  const c = addThreadCron(home, t.id, "0 * * * *", "hourly-job");
  if (lastFired) {
    const data = loadThreads(home);
    const live = data.threads.find((x) => x.id === t.id);
    const cron = live?.crons.find((x) => x.id === c.id);
    if (cron) cron.last_fired = minuteKey(lastFired);
    saveThreads(home, data);
  }
  return t.id;
}

test("线程 cron 漏跑：once 补跑一次，skip 只记账；hold 挂起整轮", async () => {
  const home = tempHome();
  try {
    const tid = await seedThreadCron(home, MON_1000);
    let runs = 0;
    const r = await fireDueThreadCrons(home, {
      now: MON_1230, workdir: home,
      runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(1);
    expect(r.fired).toHaveLength(1);
    expect(r.missed).toEqual([{ threadId: tid, cronId: expect.any(String), workflow: "hourly-job", count: 2, caughtUp: true }]);
    expect(listCronIncidents(home, { kind: "caught_up", workflow: "hourly-job" })).toHaveLength(1);
    // skip：换一条新线程，同样漏两小时，一次都不跑。
    setCronPolicy(home, { catchUp: "skip" });
    const tid2 = await seedThreadCron(home, MON_1000);
    runs = 0;
    const r2 = await fireDueThreadCrons(home, {
      now: MON_1230, workdir: home,
      runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(0);
    expect(r2.missed?.find((m) => m.threadId === tid2)?.count).toBe(2);
    expect(r2.missed?.find((m) => m.threadId === tid2)?.caughtUp).toBe(false);
    // hold：暂停在时整轮挂起。
    writePauses(home, [makePause("p1", "2026-01-05T10:00:00.000Z")]);
    runs = 0;
    const r3 = await fireDueThreadCrons(home, {
      now: MON_1230, workdir: home,
      runFn: async () => { runs++; return { id: `run-${runs}` }; },
    });
    expect(runs).toBe(0);
    expect(r3.skipped).toContain("hold");
    expect(r3.held?.held).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("CLI：incidents 空账、按 kind 过滤、policy 改、hold 看与清", async () => {
  const home = tempHome();
  try {
    const cap = captureStdout();
    try {
      expect(await handleCron(["incidents"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("事故账是空的");
      cap.logs.length = 0;
      appendCronIncident(home, { kind: "missed", source: "workflow", workflow: "a", count: 3, policy: "once" });
      appendCronIncident(home, { kind: "failed", source: "workflow", workflow: "b", error: "boom" });
      expect(await handleCron(["incidents", "--kind", "missed"], home)).toBe(0);
      const out1 = cap.logs.join("");
      expect(out1).toContain("漏跑");
      expect(out1).toContain("×3");
      expect(out1).not.toContain("失败");
      cap.logs.length = 0;
      expect(await handleCron(["incidents", "--kind", "bogus"], home)).toBe(2);
      expect(await handleCron(["incidents", "--limit", "0"], home)).toBe(2);
      cap.logs.length = 0;
      expect(await handleCron(["policy"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("once");
      cap.logs.length = 0;
      expect(await handleCron(["policy", "set", "--catch-up", "skip"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("skip");
      expect(getCronPolicy(home).catchUp).toBe("skip");
      expect(await handleCron(["policy", "set", "--catch-up", "bogus"], home)).toBe(2);
      expect(await handleCron(["policy", "set"], home)).toBe(2);
      cap.logs.length = 0;
      expect(await handleCron(["hold", "status"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("没有");
      writePauses(home, [makePause("p1", new Date().toISOString())]);
      cap.logs.length = 0;
      expect(await handleCron(["hold", "status"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("挂起中");
      expect(await handleCron(["hold", "clear"], home)).toBe(2); // 须 --yes
      expect(await handleCron(["hold", "clear", "--yes"], home)).toBe(0);
      expect(await handleCron(["bogus"], home)).toBe(2);
      expect(await handleCron(["hold", "bogus"], home)).toBe(2);
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("CLI：triggers status 输出策略与 hold 行", async () => {
  const home = tempHome();
  try {
    setCronPolicy(home, { catchUp: "skip" });
    const cap = captureStdout();
    try {
      expect(await handleWorkflow(["triggers", "status"], home)).toBe(0);
      const out = cap.logs.join("");
      expect(out).toContain("补跑策略：skip");
      expect(out).toContain("配额 hold：没有");
      cap.logs.length = 0;
      writePauses(home, [makePause("p1", new Date().toISOString())]);
      expect(await handleWorkflow(["triggers", "status"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("配额 hold：挂起中");
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});
