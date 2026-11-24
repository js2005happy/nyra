// tests/node/test-runs.test.ts — 对应 tests/test_runs.py（7 个唯一测试）+ test_resume_run.py（12）。
// 运行记录：state.json 原子写 0600、事件只记小型字段、验证命令冻结。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, RunRecorder, prepareResume, RunNotResumable, formatRunReport, redact } from "../../src/runs.ts";
import { Agent } from "../../src/agent.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-runs-test-"));
}

class FakeProvider {
  name = "fake"; model = "fake-1"; calls = 0;
  hasCredentials() { return true; }
  async chat(): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (this.calls === 1) {
      return { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "hi\n" }) } }] } }] };
    }
    return { choices: [{ message: { content: "done", tool_calls: [] } }] };
  }
}

function makeAgent(workdir: string, home: string): Agent {
  return new Agent(new FakeProvider() as never, {
    workdir, mode: "full", maxTurns: 5, sessionId: "20261118-000000-test1",
    skillsDirs: [], home,
  });
}

test("RunTests.test_status_and_ids", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  expect(state.run_id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
  expect(state.status).toBe("running");
  expect(state.schema_version).toBe(1);
  expect(store.load(state.run_id).run_id).toBe(state.run_id);
  const listed = store.list();
  expect(listed.map((s) => s.run_id)).toContain(state.run_id);
});

test("RunTests.test_atomic_permissions_and_events", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务", "sess-1", home, "auto", 10);
  if (process.platform !== "win32") {
    expectPerms(join(home, "runs", state.run_id, "state.json"), 0o600);
    expectPerms(join(home, "runs"), 0o700);
  }
  store.appendEvent(state.run_id, "turn", { turn: 1 });
  const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  // 只认语义不认字节：事件行是合法 JSON、带 type=turn（序列化已改用 JSON.stringify）。
  const parsed = events.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(parsed.some((e) => e.type === "turn")).toBe(true);
  expect(() => store.appendEvent(state.run_id, "bogus_event")).toThrow();
});

test("RunTests.test_symlinks", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务", "sess-1", home, "auto", 10);
  // state.json 被换成符号链接后拒绝读写。
  const { symlinkSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
  const target = join(home, "outside.json");
  writeFileSync(target, "{}");
  const statePath = join(home, "runs", state.run_id, "state.json");
  unlinkSync(statePath);
  symlinkSync(target, statePath);
  expect(() => store.load(state.run_id)).toThrow();
});

test("RunTests.test_redaction_and_stale", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务 sk-abcdefgh12345678", "sess-1", home, "auto", 10);
  const loaded = store.load(state.run_id);
  expect(loaded.task).not.toContain("sk-abcdefgh12345678");
  expect(loaded.task).toContain("[已隐藏]");
  expect(redact("Bearer abcdefghijklmnop")).toContain("[已隐藏]");
  // 已死的 pid 标记为 interrupted。
  const dead = store.create("任务2", "sess-2", home, "auto", 10);
  store.update(dead.run_id, { pid: 999999 });
  expect(store.markStale(dead.run_id).status).toBe("interrupted");
});

test("RunTests.test_real_event_statuses", async () => {
  const home = tmpHome();
  const workdir = join(home, "wd");
  mkdirSync(workdir, { recursive: true });
  const store = new RunStore(join(home, "runs"));
  const agent = makeAgent(workdir, home);
  const rec = new RunRecorder(store, agent, "写 a.txt", { verifyCmd: "exit 0", verifyTimeout: 30, verifyRetries: 0 });
  const out = await rec.run("写 a.txt");
  expect(out).toContain("done");
  const final = store.load(rec.runId);
  expect(final.status).toBe("verified");
  expect(final.changed_files).toContain("a.txt");
  expect(existsSync(join(workdir, "a.txt"))).toBe(true);
});

test("RunTests.test_callback_chain_and_event_filter", async () => {
  const home = tmpHome();
  const workdir = join(home, "wd");
  mkdirSync(workdir, { recursive: true });
  const store = new RunStore(join(home, "runs"));
  const agent = makeAgent(workdir, home);
  const seen: string[] = [];
  agent.onEvent = (kind) => { seen.push(kind); };
  const rec = new RunRecorder(store, agent, "写 a.txt", { verifyCmd: null });
  await rec.run("写 a.txt");
  // on_event 只收到 Agent 事件；recorder 的 run 事件不混入。
  expect(seen).toContain("tool_start");
  expect(seen).toContain("tool_result");
  expect(seen).toContain("final");
  const events = readFileSync(join(home, "runs", rec.runId, "events.jsonl"), "utf-8");
  expect(events).toContain("tool_start");
  expect(events).not.toContain("secret");
});

test("RunTests.test_checkpoint_and_approval", async () => {
  const home = tmpHome();
  const workdir = join(home, "wd");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "a.txt"), "old\n");
  const store = new RunStore(join(home, "runs"));
  const agent = makeAgent(workdir, home);
  const rec = new RunRecorder(store, agent, "写 a.txt", { verifyCmd: null });
  await rec.run("写 a.txt");
  const final = store.load(rec.runId);
  expect(final.changed_files).toContain("a.txt");
  // 断点续跑：completed_unverified 不可续跑。
  expect(() => prepareResume(store, rec.runId, { home })).toThrow(RunNotResumable);
});

test("ResumeRun.test_interrupted_tool_call_gets_unknown_marker", async () => {
  const home = tmpHome();
  const workdir = join(home, "wd");
  mkdirSync(workdir, { recursive: true });
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务", "sess-resume", workdir, "auto", 5);
  store.setStatus(state.run_id, "interrupted");
  const { saveSession } = await import("../../src/memory.ts");
  saveSession("sess-resume", [
    { role: "user", content: "做点事" },
    { role: "assistant", content: "", tool_calls: [{ id: "call-x", type: "function", function: { name: "write_file", arguments: "{}" } }] },
  ], home);
  const [, repaired, count] = prepareResume(store, state.run_id, { home });
  expect(count).toBe(1);
  expect(repaired[repaired.length - 1].content).toContain("结果未知");
});

test("ResumeRun.test_completed_run_not_resumable", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务", "sess-1", home, "auto", 5);
  store.setStatus(state.run_id, "verified");
  expect(() => prepareResume(store, state.run_id, { home })).toThrow(RunNotResumable);
});

test("ResumeRun.test_resume_rejects_workdir_change", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务", "sess-1", home, "auto", 5);
  store.setStatus(state.run_id, "failed");
  expect(() => prepareResume(store, state.run_id, { workdir: "/tmp/elsewhere", home })).toThrow();
});

test("RunReport.test_never_says_verified_unless_verified", () => {
  const report = formatRunReport({
    status: "completed_unverified", changed_files: ["a.txt"], verify_cmd: null, verify_result: null,
  } as never);
  expect(report).not.toContain("已验证");
  expect(report).toContain("未验证");
  const ok = formatRunReport({
    status: "verified", changed_files: [], verify_cmd: "true",
    verify_result: { exit_code: 0, passed: true },
  } as never);
  expect(ok).toContain("已验证");
});
