// tests/node/test-scripted-eval.test.ts — M5（脚本化行为评测）：
// 不调模型、不花钱的回放评测：record 录金标、replay 逐步比对。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EVAL_CONDITIONS } from "../../src/eval/catalog.ts";
import { runEvalSuite, validateEvalConditions } from "../../src/eval/runner.ts";
import {
  SCRIPTED_TASKS,
  ScriptedAdapter,
  hashFileTree,
  hashScriptedResult,
  loadGoldenTrace,
  normalizeScriptedResult,
} from "../../src/eval/scripted.ts";

const IS_WINDOWS = process.platform === "win32";

function tmpRoot(prefix: string): string {
  const dir = join(tmpdir(), prefix + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("ScriptedEvalTest.test_scripted_conditions_validated", () => {
  const base = { ...DEFAULT_EVAL_CONDITIONS, provider: "scripted", model: "scripted-v1", maxCostUsd: 0, inputPer1M: 0, outputPer1M: 0 };
  validateEvalConditions(base);
  expect(() => validateEvalConditions({ ...base, model: "other" })).toThrow("scripted-v1");
  expect(() => validateEvalConditions({ ...base, maxCostUsd: 1 })).toThrow("须为 0");
});

test("ScriptedEvalTest.test_normalize_and_hash_stable", () => {
  const a = normalizeScriptedResult("已写入 /tmp/aaa/workdir/out.txt（home /tmp/aaa/home）", "/tmp/aaa/workdir", "/tmp/aaa/home");
  expect(a).toBe("已写入 $WORKDIR/out.txt（home $HOME）");
  expect(hashScriptedResult("hello /tmp/x/w", "/tmp/x/w", "/tmp/x/h")).toBe(hashScriptedResult("hello $WORKDIR", "/tmp/y/w", "/tmp/y/h"));
  expect(hashScriptedResult("hello", "/tmp/x/w", "/tmp/x/h")).not.toBe(hashScriptedResult("hello!", "/tmp/x/w", "/tmp/x/h"));
});

test("ScriptedEvalTest.test_hash_file_tree_stable_and_sensitive", () => {
  const root = tmpRoot("nyra-scripted-tree-");
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "aaa");
    writeFileSync(join(root, "sub", "b.txt"), "bbb");
    const h1 = hashFileTree(root);
    expect(hashFileTree(root)).toBe(h1);
    writeFileSync(join(root, "sub", "b.txt"), "bbc");
    expect(hashFileTree(root)).not.toBe(h1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ScriptedEvalTest.test_preflight_rejects_bad_scripts", async () => {
  const adapter = new ScriptedAdapter({ goldenDir: tmpRoot("nyra-scripted-g-"), mode: "record" });
  const base = SCRIPTED_TASKS[0]!;
  expect(await adapter.preflight({ ...base, script: undefined }, DEFAULT_EVAL_CONDITIONS)).toContain("没有脚本步骤");
  expect(await adapter.preflight({ ...base, script: [{ tool: "gmail_send", args: {} }] }, DEFAULT_EVAL_CONDITIONS)).toContain("不在白名单");
  expect(await adapter.preflight({ ...base, script: [{ tool: "read_file", args: { path: "x" } }, { tool: "no_such_tool", args: {} }] }, DEFAULT_EVAL_CONDITIONS)).toContain("不在白名单");
  expect(await adapter.preflight(base, DEFAULT_EVAL_CONDITIONS)).toBeNull();
  const replay = new ScriptedAdapter({ goldenDir: tmpRoot("nyra-scripted-g-"), mode: "replay" });
  expect(await replay.preflight(base, DEFAULT_EVAL_CONDITIONS)).toContain("没有金标");
});

test("ScriptedEvalTest.test_record_then_replay_passes", async () => {
  const goldenDir = tmpRoot("nyra-scripted-golden-");
  const home = tmpRoot("nyra-scripted-home-");
  const workdir = tmpRoot("nyra-scripted-work-");
  const task = SCRIPTED_TASKS[0]!;
  try {
    writeFileSync(join(workdir, "notes.txt"), "alpha\nbeta\ngamma\n");
    const record = new ScriptedAdapter({ goldenDir, mode: "record" });
    const out = await record.execute(task, DEFAULT_EVAL_CONDITIONS, { workdir, home });
    expect(out.status).toBe("passed");
    expect(out.modelCalls).toBe(0);
    expect(out.spentUsd).toBe(0);
    expect(existsSync(join(goldenDir, "scripted-file-ops.json"))).toBe(true);
    const golden = loadGoldenTrace(goldenDir, "scripted-file-ops");
    expect(golden.steps.length).toBe(4);
    expect(golden.steps.every((s) => s.ok)).toBe(true);
    // 重放：同一任务、同一产物，通过。
    const workdir2 = tmpRoot("nyra-scripted-work-");
    writeFileSync(join(workdir2, "notes.txt"), "alpha\nbeta\ngamma\n");
    const replay = new ScriptedAdapter({ goldenDir, mode: "replay" });
    const out2 = await replay.execute(task, DEFAULT_EVAL_CONDITIONS, { workdir: workdir2, home });
    expect(out2.status).toBe("passed");
    expect(out2.checks.some((c) => c.id === "golden:steps" && c.passed)).toBe(true);
    expect(out2.checks.some((c) => c.id === "golden:tree" && c.passed)).toBe(true);
  } finally {
    for (const d of [goldenDir, home, workdir]) rmSync(d, { recursive: true, force: true });
  }
});

test("ScriptedEvalTest.test_replay_fails_on_drift", async () => {
  const goldenDir = tmpRoot("nyra-scripted-golden-");
  const home = tmpRoot("nyra-scripted-home-");
  const workdir = tmpRoot("nyra-scripted-work-");
  const task = SCRIPTED_TASKS[0]!;
  try {
    writeFileSync(join(workdir, "notes.txt"), "alpha\nbeta\ngamma\n");
    const record = new ScriptedAdapter({ goldenDir, mode: "record" });
    expect((await record.execute(task, DEFAULT_EVAL_CONDITIONS, { workdir, home })).status).toBe("passed");
    // 脚本改了（写的内容不同）：参数哈希与终态都对不上。
    const drifted = {
      ...task,
      script: task.script!.map((s) => (s.tool === "write_file" ? { ...s, args: { path: "summary.txt", content: "共 3 行：alpha, beta, delta\n" } } : s)),
      expected: { files: { "summary.txt": "共 3 行：alpha, beta, delta\n" } },
    };
    const workdir2 = tmpRoot("nyra-scripted-work-");
    writeFileSync(join(workdir2, "notes.txt"), "alpha\nbeta\ngamma\n");
    const replay = new ScriptedAdapter({ goldenDir, mode: "replay" });
    const out = await replay.execute(drifted, DEFAULT_EVAL_CONDITIONS, { workdir: workdir2, home });
    expect(out.status).toBe("failed");
    expect(out.checks.some((c) => c.id === "golden:steps" && !c.passed)).toBe(true);
    expect(out.checks.some((c) => c.id === "golden:tree" && !c.passed)).toBe(true);
  } finally {
    for (const d of [goldenDir, home, workdir]) rmSync(d, { recursive: true, force: true });
  }
});

test("ScriptedEvalTest.test_run_eval_suite_record_and_replay", async () => {
  // shell 那步用 cat/wc/tr，Windows 上没有：全量里只跑两个纯文件任务。
  const tasks = IS_WINDOWS ? SCRIPTED_TASKS.filter((t) => t.id !== "scripted-shell-count") : SCRIPTED_TASKS;
  const root = tmpRoot("nyra-scripted-suite-");
  const goldenDir = tmpRoot("nyra-scripted-golden-");
  try {
    const recordReport = await runEvalSuite({
      root,
      sourceRevision: "test",
      harnessHash: "test",
      adapter: new ScriptedAdapter({ goldenDir, mode: "record" }),
      tasks,
      suite: "nyra-scripted-v1",
      retries: 0,
    });
    expect(recordReport.summary.passed).toBe(tasks.length);
    expect(recordReport.summary.failed).toBe(0);
    expect(recordReport.summary.modelCalls).toBe(0);
    expect(recordReport.summary.spentUsd).toBe(0);
    expect(existsSync(join(root, recordReport.id, "report.json"))).toBe(true);
    for (const t of tasks) expect(existsSync(join(goldenDir, `${t.id}.json`))).toBe(true);
    const replayReport = await runEvalSuite({
      root,
      sourceRevision: "test",
      harnessHash: "test",
      adapter: new ScriptedAdapter({ goldenDir, mode: "replay" }),
      tasks,
      suite: "nyra-scripted-v1",
      retries: 0,
    });
    expect(replayReport.summary.passed).toBe(tasks.length);
    expect(replayReport.summary.failed).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(goldenDir, { recursive: true, force: true });
  }
});
