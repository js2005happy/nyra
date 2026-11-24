// tests/node/test-threads.test.ts — G-P1-37：远端线程操作 API。
// 覆盖：账本往返/0600/损坏备份、建搜复制剪历史、状态合并写与删键、
// 运行记录、cron 绑定与上限、到点触发（注入 runFn、同一分钟去重、
// 每轮 5 个上限、开关关着跳过、非 active 工作流跳过、失败记账）、
// 证据与事件镜像、CLI 全程。
// cron 断言用固定本地日期（2026-01-05 是周一），不是“写死绝对时间窗口”。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  ThreadError, createThread, getThread, listThreads, searchThreads,
  copyThread, pruneThread, getThreadState, updateThreadState,
  appendThreadHistory, getThreadHistory, recordThreadRun, listThreadRuns,
  setThreadStatus, removeThread, addThreadCron, removeThreadCron,
  listThreadCrons, fireDueThreadCrons, threadsPath,
} from "../../src/threads.ts";
import { setWorkflowTriggersEnabled } from "../../src/workflowTriggers.ts";
import {
  importWorkflow, loadWorkflowRegistry, saveWorkflowRegistry,
} from "../../src/workflow.ts";
import { RunStore } from "../../src/runs.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, workdir: string, args: string[]) {
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

function toolDef(name: string): Record<string, unknown> {
  return {
    name, version: 1, mode: "fixed",
    inputs: { file: "/tmp/x.txt" },
    steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: "{{inputs.file}}" } }],
  };
}

async function importAndActivate(home: string, name: string): Promise<void> {
  const file = join(home, `${name}.json`);
  writeFileSync(file, JSON.stringify(toolDef(name)));
  await importWorkflow(home, file);
  const registry = loadWorkflowRegistry(home);
  const entry = registry.workflows.find((w) => w.name === name);
  if (!entry) throw new Error("导入后注册表里没有该工作流");
  entry.status = "active";
  saveWorkflowRegistry(home, registry);
}

const MON_1030 = new Date(2026, 0, 5, 10, 30); // 周一
// O6：触发测试用的 cron 须合规（间隔 ≥15 分钟）——"30 10 * * 1" 在 MON_1030
// 到点（每周一 10:30），不要用 "* * * * *"（1 分钟，addThreadCron 会拦）。

test("ThreadsTest.test_create_list_0600", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "每周店铺复盘", { state: { week: 12 } });
  expect(t.id).toMatch(/^[0-9a-f]{16}$/);
  expect(t.status).toBe("active");
  expect(t.state).toEqual({ week: 12 });
  expect(listThreads(home).length).toBe(1);
  expectPerms(threadsPath(home), 0o600);
});

test("ThreadsTest.test_create_validation", () => {
  const home = tmpHome("nyra-threads-");
  expect(() => createThread(home, "   ")).toThrow(ThreadError);
  expect(() => createThread(home, "x".repeat(101))).toThrow(ThreadError);
  expect(() => createThread(home, "ok", { state: { a: "x".repeat(1001) } })).toThrow(ThreadError);
});

test("ThreadsTest.test_search_by_title_id_status", () => {
  const home = tmpHome("nyra-threads-");
  const a = createThread(home, "每周店铺复盘");
  createThread(home, "发票跟进");
  setThreadStatus(home, a.id, "archived");
  expect(searchThreads(home, "复盘").length).toBe(1);
  expect(searchThreads(home, a.id.slice(0, 8)).length).toBe(1);
  expect(searchThreads(home, "", "archived").length).toBe(1);
  expect(searchThreads(home, "", "active").length).toBe(1);
  expect(searchThreads(home, "不存在").length).toBe(0);
});

test("ThreadsTest.test_copy_copies_state_and_history_not_runs_or_crons", () => {
  const home = tmpHome("nyra-threads-");
  const src = createThread(home, "原线程", { state: { k: "v" } });
  appendThreadHistory(home, src.id, "note", "一条历史");
  recordThreadRun(home, src.id, "run_1", "ok", "wf");
  addThreadCron(home, src.id, "0 9 * * 1", "wf");
  const copy = copyThread(home, src.id);
  expect(copy.id).not.toBe(src.id);
  expect(copy.title).toContain("（副本）");
  expect(copy.state).toEqual({ k: "v" });
  expect(copy.history.some((h) => h.summary === "一条历史")).toBe(true);
  expect(copy.runs).toEqual([]);
  expect(copy.crons).toEqual([]);
  expect(getThread(home, src.id).crons.length).toBe(1);
});

test("ThreadsTest.test_prune_keeps_last_n", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "剪历史");
  for (let i = 0; i < 5; i++) appendThreadHistory(home, t.id, "note", `第 ${i} 条`);
  const r = pruneThread(home, t.id, 2);
  expect(r).toEqual({ kept: 2, dropped: 3 });
  expect(getThreadHistory(home, t.id).map((h) => h.summary)).toEqual(["第 3 条", "第 4 条"]);
  expect(() => pruneThread(home, t.id, 201)).toThrow(ThreadError);
});

test("ThreadsTest.test_state_merge_and_delete_and_caps", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "状态", { state: { a: 1, b: "x" } });
  const s = updateThreadState(home, t.id, { b: null, c: true, d: 2.5 });
  expect(s).toEqual({ a: 1, c: true, d: 2.5 });
  expect(getThreadState(home, t.id)).toEqual({ a: 1, c: true, d: 2.5 });
  expect(() => updateThreadState(home, t.id, { nested: { x: 1 } })).toThrow(ThreadError);
  const many: Record<string, number> = {};
  for (let i = 0; i < 33; i++) many[`k${i}`] = i;
  expect(() => updateThreadState(home, t.id, many)).toThrow(ThreadError);
  expect(() => updateThreadState(home, t.id, { n: Number.NaN })).toThrow(ThreadError);
});

test("ThreadsTest.test_history_append_and_limit", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "历史");
  appendThreadHistory(home, t.id, "note", "第一条");
  appendThreadHistory(home, t.id, "cron", "第二条");
  expect(getThreadHistory(home, t.id, 1).map((h) => h.summary)).toEqual(["第二条"]);
  expect(() => appendThreadHistory(home, t.id, "bad kind!", "x")).toThrow(ThreadError);
  expect(() => appendThreadHistory(home, t.id, "note", "x".repeat(501))).toThrow(ThreadError);
});

test("ThreadsTest.test_runs_record_and_list", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "运行");
  recordThreadRun(home, t.id, "run_1", "ok", "wf-a");
  recordThreadRun(home, t.id, "run_2", "failed", "wf-b");
  const runs = listThreadRuns(home, t.id);
  expect(runs[0].run_id).toBe("run_2");
  expect(runs[1].status).toBe("ok");
  expect(() => recordThreadRun(home, "0000000000000000", "run_3", "ok")).toThrow(ThreadError);
});

test("ThreadsTest.test_archive_unarchive_remove", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "归档");
  expect(setThreadStatus(home, t.id, "archived").status).toBe("archived");
  expect(setThreadStatus(home, t.id, "active").status).toBe("active");
  expect(removeThread(home, t.id)).toBe(true);
  expect(removeThread(home, t.id)).toBe(false);
  expect(() => getThread(home, t.id)).toThrow(ThreadError);
});

test("ThreadsTest.test_cron_add_remove_list_caps", () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "cron");
  expect(() => addThreadCron(home, t.id, "not a cron", "wf")).toThrow(ThreadError);
  expect(() => addThreadCron(home, t.id, "0 9 * *", "wf")).toThrow(ThreadError);
  const c = addThreadCron(home, t.id, "0 9 * * 1", "wf");
  expect(c.workflow).toBe("wf");
  expect(listThreadCrons(home, t.id).length).toBe(1);
  expect(removeThreadCron(home, t.id, c.id)).toBe(true);
  expect(removeThreadCron(home, t.id, c.id)).toBe(false);
  for (let i = 0; i < 10; i++) addThreadCron(home, t.id, `${i} 9 * * *`, "wf");
  expect(() => addThreadCron(home, t.id, "0 9 * * *", "wf")).toThrow(ThreadError);
});

test("ThreadsTest.test_corrupt_ledger_backed_up_and_throws", () => {
  const home = tmpHome("nyra-threads-");
  createThread(home, "先建一个");
  writeFileSync(threadsPath(home), "{ broken json");
  expect(() => listThreads(home)).toThrow(ThreadError);
  const backups = readdirSync(home).filter((f) => f.startsWith("threads.json.corrupt-"));
  expect(backups.length).toBe(1);
  // 文件不存在时回空账本，不抛错。
  rmSync(threadsPath(home), { force: true });
  expect(listThreads(home)).toEqual([]);
});

test("ThreadsTest.test_fire_gate_off_skips", async () => {
  const home = tmpHome("nyra-threads-");
  const t = createThread(home, "门关着");
  addThreadCron(home, t.id, "30 10 * * 1", "wf");
  const report = await fireDueThreadCrons(home, { now: MON_1030, runFn: async () => ({ id: "run_x" }) });
  expect(report.skipped).toBeTruthy();
  expect(report.fired).toEqual([]);
});

test("ThreadsTest.test_fire_due_records_run_history_evidence_and_dedups", async () => {
  const home = tmpHome("nyra-threads-");
  const workdir = tmpHome("nyra-threads-wd-");
  await importAndActivate(home, "weekly-review");
  setWorkflowTriggersEnabled(home, true);
  const t = createThread(home, "到点跑");
  addThreadCron(home, t.id, "30 10 * * 1", "weekly-review");
  let calls = 0;
  const runFn = async () => { calls++; return { id: "run_abc" }; };
  const report = await fireDueThreadCrons(home, { now: MON_1030, workdir, runFn });
  expect(report.skipped).toBeNull();
  expect(report.fired.length).toBe(1);
  expect(report.fired[0].status).toBe("ok");
  expect(report.fired[0].runId).toBe("run_abc");
  expect(calls).toBe(1);
  expect(listThreadRuns(home, t.id)[0].run_id).toBe("run_abc");
  expect(getThreadHistory(home, t.id).some((h) => h.kind === "cron")).toBe(true);
  const evidenceDir = join(home, "evidence", "thread-crons");
  expect(existsSync(evidenceDir)).toBe(true);
  const files = readdirSync(evidenceDir);
  expect(files.length).toBe(1);
  expect(readFileSync(join(evidenceDir, files[0]), "utf-8")).toContain("weekly-review");
  // 同一分钟再跑一次：去重，不重复跑。
  const report2 = await fireDueThreadCrons(home, { now: MON_1030, workdir, runFn });
  expect(report2.fired).toEqual([]);
  expect(calls).toBe(1);
});

test("ThreadsTest.test_fire_skips_inactive_workflow", async () => {
  const home = tmpHome("nyra-threads-");
  const workdir = tmpHome("nyra-threads-wd-");
  await importAndActivate(home, "wf-draft");
  // 把工作流改回 draft（不是 active）。
  const registry = loadWorkflowRegistry(home);
  registry.workflows.find((w) => w.name === "wf-draft")!.status = "draft";
  saveWorkflowRegistry(home, registry);
  setWorkflowTriggersEnabled(home, true);
  const t = createThread(home, "草稿工作流");
  addThreadCron(home, t.id, "30 10 * * 1", "wf-draft");
  let calls = 0;
  const report = await fireDueThreadCrons(home, {
    now: MON_1030, workdir,
    runFn: async () => { calls++; return { id: "run_x" }; },
  });
  expect(calls).toBe(0);
  expect(report.fired[0].status).toBe("skipped");
});

test("ThreadsTest.test_fire_caps_at_five_per_round", async () => {
  const home = tmpHome("nyra-threads-");
  const workdir = tmpHome("nyra-threads-wd-");
  await importAndActivate(home, "wf-cap");
  setWorkflowTriggersEnabled(home, true);
  for (let i = 0; i < 6; i++) {
    const t = createThread(home, `线程 ${i}`);
    addThreadCron(home, t.id, "30 10 * * 1", "wf-cap");
  }
  let calls = 0;
  const report = await fireDueThreadCrons(home, {
    now: MON_1030, workdir,
    runFn: async () => { calls++; return { id: `run_${calls}` }; },
  });
  expect(report.fired.length).toBe(5);
  expect(calls).toBe(5);
});

test("ThreadsTest.test_fire_failure_recorded_not_retried_this_minute", async () => {
  const home = tmpHome("nyra-threads-");
  const workdir = tmpHome("nyra-threads-wd-");
  await importAndActivate(home, "wf-fail");
  setWorkflowTriggersEnabled(home, true);
  const t = createThread(home, "会失败");
  addThreadCron(home, t.id, "30 10 * * 1", "wf-fail");
  let calls = 0;
  const report = await fireDueThreadCrons(home, {
    now: MON_1030, workdir,
    runFn: async () => { calls++; throw new Error("模型挂了"); },
  });
  expect(report.fired[0].status).toBe("failed");
  expect(report.fired[0].error).toContain("模型挂了");
  // 失败也不重跑这一分钟（last_fired 已记），且没编造运行 id。
  expect(listThreadRuns(home, t.id)).toEqual([]);
  expect(getThreadHistory(home, t.id).some((h) => h.summary.includes("失败"))).toBe(true);
  const report2 = await fireDueThreadCrons(home, {
    now: MON_1030, workdir,
    runFn: async () => { calls++; return { id: "run_y" }; },
  });
  expect(report2.fired).toEqual([]);
  expect(calls).toBe(1);
});

test("ThreadsTest.test_fire_mirrors_event_into_run", async () => {
  const home = tmpHome("nyra-threads-");
  const workdir = tmpHome("nyra-threads-wd-");
  await importAndActivate(home, "wf-ev");
  setWorkflowTriggersEnabled(home, true);
  const store = new RunStore(join(home, "runs"));
  const state = store.create("线程 cron 任务", "sess-1", home, "auto", 10);
  const t = createThread(home, "事件镜像");
  addThreadCron(home, t.id, "30 10 * * 1", "wf-ev");
  const report = await fireDueThreadCrons(home, {
    now: MON_1030, workdir,
    runFn: async () => ({ id: state.run_id }),
  });
  expect(report.fired[0].status).toBe("ok");
  const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  expect(events).toContain("thread_cron_fired");
  // 未知事件会被拒绝（EVENT_FIELDS 白名单）：能记上说明 thread_cron_fired 已注册。
  store.appendEvent(state.run_id, "thread_cron_fired", { thread_id: t.id, workflow: "wf-ev", status: "ok" });
});

test("ThreadsTest.test_cli_full_flow", () => {
  const home = tmpHome("nyra-threads-");
  const workdir = tmpHome("nyra-threads-wd-");
  const created = runCli(home, workdir, ["thread", "create", "CLI 线程"]);
  expect(created.status).toBe(0);
  const idMatch = /已建线程：([0-9a-f]{16})/.exec(created.stdout);
  expect(idMatch).toBeTruthy();
  const id = idMatch![1];
  expect(runCli(home, workdir, ["thread", "list"]).status).toBe(0);
  expect(runCli(home, workdir, ["thread", "search", "CLI"]).status).toBe(0);
  expect(runCli(home, workdir, ["thread", "state", id, "--set", "week=3", "--set", "done=true"]).status).toBe(0);
  expect(getThreadState(home, id)).toEqual({ week: 3, done: true });
  expect(runCli(home, workdir, ["thread", "state", id, "--unset", "done"]).status).toBe(0);
  expect(getThreadState(home, id)).toEqual({ week: 3 });
  expect(runCli(home, workdir, ["thread", "cron-add", id, "0 9 * * 1", "wf-x"]).status).toBe(0);
  expect(listThreadCrons(home, id).length).toBe(1);
  expect(runCli(home, workdir, ["thread", "cron-add", id, "bad cron", "wf-x"]).status).toBe(1);
  expect(runCli(home, workdir, ["thread", "show", id]).status).toBe(0);
  expect(runCli(home, workdir, ["thread", "history", id]).status).toBe(0);
  expect(runCli(home, workdir, ["thread", "runs", id]).status).toBe(0);
  expect(runCli(home, workdir, ["thread", "archive", id]).status).toBe(0);
  expect(getThread(home, id).status).toBe("archived");
  expect(runCli(home, workdir, ["thread", "remove", id]).status).toBe(2);
  expect(runCli(home, workdir, ["thread", "remove", id, "--yes"]).status).toBe(0);
  expect(runCli(home, workdir, ["thread", "show", id]).status).toBe(1);
});
