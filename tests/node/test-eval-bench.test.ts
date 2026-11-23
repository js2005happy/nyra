// tests/node/test-eval-bench.test.ts — G-P1-30 评测当一等公民。
// 钉住的事：
//   - 场景：4 个内置场景，各 5 题；成熟度阈值边界（0.95/0.8/0.6/0.4）与未评测；
//   - 成绩单：分场景首轮通过率、重试挽回、blocked 不计分母；报告校验 4 种拒绝；
//   - 可复现清单：同一份报告哈希相同，改一题结果哈希就变；
//   - 基准集：校验正反例（未知键、重名、缺验收、类别不对、fixture 越界）；
//   - 存储：导入/列出/删除往返，0600 权限，重名拒绝；
//   - 仓内探针：两个探针文件都能通过校验；
//   - 运行：假 adapter 跑基准集任务与场景子集，suite 与 catalogHash 按实际任务算；
//   - scripts/eval.ts 新标志与 CLI 全程。
// 全用临时 home / 假 adapter / 假报告，不调模型、不联网。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expectPerms } from "./fsPerms.ts";
import { EVAL_TASKS } from "../../src/eval/catalog.ts";
import {
  evalHash,
  runEvalSuite,
  summarizeEval,
  type EvalAdapter,
  type EvalOutcome,
  type EvalReport,
  type EvalResult,
} from "../../src/eval/runner.ts";
import {
  buildEvalManifest,
  EVAL_SCENARIOS,
  loadEvalReportForBench,
  maturityForRate,
  scenarioScorecard,
} from "../../src/eval/scenarios.ts";
import {
  benchmarkTaskToEvalTask,
  importBenchmark,
  listBenchmarks,
  listRepoProbes,
  loadBenchmark,
  loadRepoProbe,
  removeBenchmark,
  validateBenchmarkSet,
  type BenchmarkSet,
} from "../../src/eval/benchmarks.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tmpWorkdir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "tests", "node"), { recursive: true });
  return dir;
}

function runCli(home: string, workdir: string, args: string[]) {
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

function runEvalScript(home: string, args: string[]) {
  return spawnSync("bun", ["run", join(process.cwd(), "scripts/eval.ts"), ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home },
  });
}

type Status = "passed" | "failed" | "blocked";

function res(taskId: string, category: string, statuses: Status[]): EvalResult {
  return {
    taskId,
    category,
    attempts: statuses.map((status, i) => ({
      status,
      reason: status === "passed" ? null : "acceptance-failed",
      checks: [{ id: "x", passed: status === "passed", evidence: "h" }],
      spentUsd: 0,
      interventions: 0,
      modelCalls: 0,
      taskId,
      attempt: i + 1,
      durationMs: 10,
      conditionsHash: "0123456789ab",
    })),
  };
}

function fakeReport(results: EvalResult[], suite = "nyra-real-tasks-v1"): EvalReport {
  return {
    schemaVersion: 1,
    suite,
    id: "ev-test",
    createdAt: new Date().toISOString(),
    sourceRevision: "test",
    sourceHash: "test",
    harnessHash: "test",
    catalogHash: "test",
    conditions: { provider: "ollama", model: "qwen2.5:7b", maxCostUsd: 0, maxTurns: 12, timeoutMs: 120000, inputPer1M: 0, outputPer1M: 0 },
    conditionsHash: "0123456789ab",
    environment: {},
    wallDurationMs: 100,
    finishedAt: new Date().toISOString(),
    parentReport: null,
    results,
    summary: summarizeEval(results),
  };
}

function writeReport(dir: string, report: EvalReport): string {
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

test("场景台有 4 个内置场景，各 5 题", () => {
  expect(EVAL_SCENARIOS.map((s) => s.id)).toEqual(["code", "browser", "research", "connector"]);
  for (const s of EVAL_SCENARIOS) {
    expect(s.taskIds).toHaveLength(5);
    expect(s.name.length).toBeGreaterThan(0);
    expect(EVAL_TASKS.filter((t) => t.category === s.id).map((t) => t.id).sort()).toEqual([...s.taskIds].sort());
  }
});

test("成熟度阈值边界与未评测", () => {
  expect(maturityForRate(0, 0)).toEqual({ level: null, label: "未评测" });
  expect(maturityForRate(20, 19).level).toBe(4);
  expect(maturityForRate(20, 18).level).toBe(3);
  expect(maturityForRate(10, 8).level).toBe(3);
  expect(maturityForRate(10, 6).level).toBe(2);
  expect(maturityForRate(10, 4).level).toBe(1);
  expect(maturityForRate(10, 3).level).toBe(0);
  expect(maturityForRate(10, 0).label).toBe("未达标");
  expect(maturityForRate(20, 19).label).toBe("成熟");
});

test("成绩单分场景算首轮通过率、重试挽回与成熟度", () => {
  const report = fakeReport([
    res("code-01", "code", ["passed"]),
    res("code-02", "code", ["passed"]),
    res("code-03", "code", ["passed"]),
    res("code-04", "code", ["failed", "passed"]),
    res("code-05", "code", ["failed"]),
    res("browser-01", "browser", ["passed"]),
    res("browser-02", "browser", ["passed"]),
    res("browser-03", "browser", ["passed"]),
    res("browser-04", "browser", ["passed"]),
    res("browser-05", "browser", ["passed"]),
    res("research-01", "research", ["blocked"]),
    res("research-02", "research", ["blocked"]),
    res("research-03", "research", ["blocked"]),
    res("research-04", "research", ["blocked"]),
    res("research-05", "research", ["blocked"]),
  ]);
  const card = scenarioScorecard(report);
  const code = card.scenarios.find((s) => s.scenario === "code")!;
  expect(code.total).toBe(5);
  expect(code.passed).toBe(3);
  expect(code.failed).toBe(2);
  expect(code.executed).toBe(5);
  expect(code.firstAttemptPassRate).toBeCloseTo(0.6);
  expect(code.retryRecovery).toBe(1);
  expect(code.maturity.level).toBe(2);
  const browser = card.scenarios.find((s) => s.scenario === "browser")!;
  expect(browser.firstAttemptPassRate).toBe(1);
  expect(browser.maturity.level).toBe(4);
  const research = card.scenarios.find((s) => s.scenario === "research")!;
  expect(research.executed).toBe(0);
  expect(research.firstAttemptPassRate).toBeNull();
  expect(research.maturity).toEqual({ level: null, label: "未评测" });
  const connector = card.scenarios.find((s) => s.scenario === "connector")!;
  expect(connector.total).toBe(0);
  expect(connector.maturity.level).toBeNull();
  expect(card.overall.total).toBe(15);
  expect(card.overall.passed).toBe(8);
  expect(card.overall.firstAttemptPassRate).toBeCloseTo(0.8);
  expect(card.overall.retryRecovery).toBe(1);
  expect(card.overall.maturity.level).toBe(3);
});

test("成绩单报告校验拒绝未跑完、错 suite、坏结果行与坏 JSON", () => {
  const dir = tmpHome("eval-bench-score-");
  const unfinished = fakeReport([res("code-01", "code", ["passed"])]);
  unfinished.finishedAt = null;
  expect(() => loadEvalReportForBench(writeReport(dir, unfinished))).toThrow("还没跑完");
  const wrongSuite = fakeReport([res("code-01", "code", ["passed"])], "something-else");
  expect(() => loadEvalReportForBench(writeReport(dir, wrongSuite))).toThrow("suite 不认");
  const badRows = fakeReport([res("code-01", "code", ["passed"])]);
  badRows.results[0].attempts = [];
  expect(() => loadEvalReportForBench(writeReport(dir, badRows))).toThrow("无效的结果行");
  const badJson = join(dir, "bad.json");
  writeFileSync(badJson, "{not json");
  expect(() => loadEvalReportForBench(badJson)).toThrow("不是有效 JSON");
  expect(() => loadEvalReportForBench(join(dir, "missing.json"))).toThrow("不存在");
  // 基准集与探针报告也认。
  const bench = fakeReport([res("probe-x-01", "research", ["passed"])], "nyra-benchmark:demo");
  expect(loadEvalReportForBench(writeReport(dir, bench)).suite).toBe("nyra-benchmark:demo");
  const probe = fakeReport([res("probe-x-01", "research", ["passed"])], "nyra-probe:demo");
  expect(loadEvalReportForBench(writeReport(dir, probe)).suite).toBe("nyra-probe:demo");
});

test("可复现清单同一份报告哈希相同，改一题结果哈希就变", () => {
  const report = fakeReport([
    res("code-01", "code", ["passed"]),
    res("code-02", "code", ["failed"]),
  ]);
  const a = buildEvalManifest(report);
  const b = buildEvalManifest(report);
  expect(a.resultsHash).toBe(b.resultsHash);
  expect(a.manifestVersion).toBe(1);
  expect(a.suite).toBe("nyra-real-tasks-v1");
  expect(a.summary.total).toBe(2);
  const changed = fakeReport([
    res("code-01", "code", ["passed"]),
    res("code-02", "code", ["failed", "passed"]),
  ]);
  expect(buildEvalManifest(changed).resultsHash).not.toBe(a.resultsHash);
  // 顺序不影响哈希（按 taskId 排序后算）。
  const reordered = fakeReport([
    res("code-02", "code", ["failed"]),
    res("code-01", "code", ["passed"]),
  ]);
  expect(buildEvalManifest(reordered).resultsHash).toBe(a.resultsHash);
});

function goodSet(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "benchmark",
    name: "demo-set",
    version: "1.0.0",
    source: "https://example.test/demo",
    description: "测试集",
    tasks: [
      {
        id: "demo-r-01",
        category: "research",
        prompt: "只用冻结资料作答。",
        checks: [{ id: "answer", description: "答案一致" }],
        fixture: { "sources/a.md": "事实。" },
        expected: { answer: 1, sources: ["a.md"] },
      },
      {
        id: "demo-c-01",
        category: "code",
        prompt: "修好 total。",
        checks: [{ id: "frozen-tests", description: "冻结断言通过" }],
        fixture: { "module.mjs": "export const total = (a, b) => a * b;" },
        testBody: "assert.equal(m.total(2, 3), 6);",
      },
    ],
  };
}

test("基准集校验接受合法集，映射与内置任务一一对应", () => {
  const set = validateBenchmarkSet(goodSet());
  expect(set.name).toBe("demo-set");
  expect(set.tasks).toHaveLength(2);
  const mapped = set.tasks.map(benchmarkTaskToEvalTask);
  expect(mapped[0].description).toBe("只用冻结资料作答。");
  expect(mapped[0].acceptance).toContain("answer: 答案一致");
  expect(mapped[0].expected).toEqual({ answer: 1, sources: ["a.md"] });
  expect(mapped[1].testBody).toContain("total(2, 3)");
  expect(mapped[1].fixture["module.mjs"]).toContain("total");
});

test("基准集校验拒绝坏名字、重名、未知键与缺验收", () => {
  const badName = goodSet();
  badName.name = "Bad_Name";
  expect(() => validateBenchmarkSet(badName)).toThrow("name 须是");
  const dup = goodSet();
  (dup.tasks as Record<string, unknown>[])[1].id = "demo-r-01";
  expect(() => validateBenchmarkSet(dup)).toThrow("任务 id 重复");
  const extraTop = goodSet();
  extraTop.extra = 1;
  expect(() => validateBenchmarkSet(extraTop)).toThrow("多余的键");
  const extraTask = goodSet();
  (extraTask.tasks as Record<string, unknown>[])[0].surprise = true;
  expect(() => validateBenchmarkSet(extraTask)).toThrow("多余的键");
  const noChecks = goodSet();
  (noChecks.tasks as Record<string, unknown>[])[0].checks = [];
  expect(() => validateBenchmarkSet(noChecks)).toThrow("checks 须是");
  const badCategory = goodSet();
  (badCategory.tasks as Record<string, unknown>[])[0].category = "chat";
  expect(() => validateBenchmarkSet(badCategory)).toThrow("category 须是");
  const empty = goodSet();
  empty.tasks = [];
  expect(() => validateBenchmarkSet(empty)).toThrow("tasks 须是");
  const wrongVersion = goodSet();
  wrongVersion.schemaVersion = 2;
  expect(() => validateBenchmarkSet(wrongVersion)).toThrow("schemaVersion");
});

test("基准集校验按类别补齐验收必需字段，fixture 路径越界拒绝", () => {
  const noTestBody = goodSet();
  delete (noTestBody.tasks as Record<string, unknown>[])[1].testBody;
  expect(() => validateBenchmarkSet(noTestBody)).toThrow("须带 testBody");
  const noModule = goodSet();
  delete ((noModule.tasks as Record<string, unknown>[])[1].fixture as Record<string, string>)["module.mjs"];
  expect(() => validateBenchmarkSet(noModule)).toThrow("须带 module.mjs");
  const noExpected = goodSet();
  delete (noExpected.tasks as Record<string, unknown>[])[0].expected;
  expect(() => validateBenchmarkSet(noExpected)).toThrow("须带 expected");
  const browserTask = {
    id: "demo-b-01",
    category: "browser",
    prompt: "点一下。",
    checks: [{ id: "state", description: "状态一致" }],
    fixture: { "page.html": "<button></button>" },
  };
  const noAction = goodSet();
  (noAction.tasks as Record<string, unknown>[]).push({ ...browserTask });
  expect(() => validateBenchmarkSet(noAction)).toThrow("须带 browserAction");
  const escape = goodSet();
  ((escape.tasks as Record<string, unknown>[])[0].fixture as Record<string, string>)["../escape.txt"] = "x";
  expect(() => validateBenchmarkSet(escape)).toThrow("fixture 路径无效");
});

test("基准集导入列出删除往返，文件 0600，重名拒绝", () => {
  const home = tmpHome("eval-bench-store-");
  const dir = tmpHome("eval-bench-file-");
  const file = join(dir, "demo-set.json");
  writeFileSync(file, JSON.stringify(goodSet(), null, 2));
  expect(listBenchmarks(home)).toEqual([]);
  const imported = importBenchmark(home, file);
  expect(imported.name).toBe("demo-set");
  const stored = join(home, "eval-benchmarks", "demo-set.json");
  expect(existsSync(stored)).toBe(true);
  expectPerms(stored, 0o600);
  expect(() => importBenchmark(home, file)).toThrow("已存在");
  const listed = listBenchmarks(home);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ name: "demo-set", version: "1.0.0", tasks: 2, valid: true });
  expect(loadBenchmark(home, "demo-set").tasks).toHaveLength(2);
  expect(() => loadBenchmark(home, "missing")).toThrow("没有这个基准集");
  expect(() => loadBenchmark(home, "Bad_Name")).toThrow("须是 slug");
  // --name 改名导入。
  const renamed = importBenchmark(home, file, "renamed-set");
  expect(renamed.name).toBe("renamed-set");
  expect(existsSync(join(home, "eval-benchmarks", "renamed-set.json"))).toBe(true);
  removeBenchmark(home, "renamed-set");
  expect(listBenchmarks(home)).toHaveLength(1);
  removeBenchmark(home, "demo-set");
  expect(listBenchmarks(home)).toEqual([]);
  expect(() => removeBenchmark(home, "demo-set")).toThrow("没有这个基准集");
});

test("仓内两个探针文件都能通过校验", () => {
  const { available, probes } = listRepoProbes();
  expect(available).toBe(true);
  expect(probes.map((p) => p.name).sort()).toEqual(["injection-resistance", "no-side-effect"]);
  for (const p of probes) {
    expect(p.valid).toBe(true);
    expect(p.tasks).toBe(2);
  }
  const inj = loadRepoProbe("injection-resistance");
  expect(inj.tasks.map((t) => t.id)).toEqual(["probe-inj-01", "probe-inj-02"]);
  expect(inj.tasks.every((t) => t.category === "research")).toBe(true);
  const nse = loadRepoProbe("no-side-effect");
  expect(nse.tasks.map((t) => t.id)).toEqual(["probe-nse-01", "probe-nse-02"]);
  expect(nse.tasks.every((t) => t.category === "connector")).toBe(true);
  expect(() => loadRepoProbe("nope")).toThrow("没有这个仓内探针");
  expect(() => loadRepoProbe("Bad_Name")).toThrow("须是 slug");
});

const passOutcome = (): EvalOutcome => ({
  status: "passed",
  reason: null,
  checks: [{ id: "x", passed: true, evidence: "h" }],
  spentUsd: 0,
  interventions: 0,
  modelCalls: 1,
});

function stubAdapter(): EvalAdapter {
  return {
    preflight: async () => null,
    execute: async () => passOutcome(),
  };
}

test("假 adapter 跑基准集任务：suite 与 catalogHash 按实际任务算", async () => {
  const set = validateBenchmarkSet(goodSet());
  const tasks = set.tasks.map(benchmarkTaskToEvalTask);
  const report = await runEvalSuite({
    root: tmpHome("eval-bench-run-"),
    sourceRevision: "test",
    harnessHash: "h",
    adapter: stubAdapter(),
    tasks,
    suite: "nyra-benchmark:demo-set",
  });
  expect(report.suite).toBe("nyra-benchmark:demo-set");
  expect(report.catalogHash).toBe(evalHash(tasks));
  expect(report.results).toHaveLength(2);
  expect(report.results.map((r) => r.taskId)).toEqual(["demo-r-01", "demo-c-01"]);
  expect(report.summary.passed).toBe(2);
});

test("假 adapter 跑场景子集只跑该场景的题", async () => {
  const report = await runEvalSuite({
    root: tmpHome("eval-bench-scenario-"),
    sourceRevision: "test",
    harnessHash: "h",
    adapter: stubAdapter(),
    taskIds: EVAL_TASKS.filter((t) => t.category === "code").map((t) => t.id),
  });
  expect(report.suite).toBe("nyra-real-tasks-v1");
  expect(report.results).toHaveLength(5);
  expect(report.results.every((r) => r.category === "code")).toBe(true);
});

test("scripts/eval.ts list 认场景与基准集，互斥标志报错", () => {
  const home = tmpHome("eval-bench-script-");
  const dir = tmpHome("eval-bench-script-file-");
  const file = join(dir, "demo-set.json");
  writeFileSync(file, JSON.stringify(goodSet(), null, 2));
  const scenario = runEvalScript(home, ["list", "--scenario", "code"]);
  expect(scenario.status).toBe(0);
  const parsedScenario = JSON.parse(scenario.stdout);
  expect(parsedScenario.scenario).toBe("code");
  expect(parsedScenario.tasks).toHaveLength(5);
  const badScenario = runEvalScript(home, ["list", "--scenario", "chat"]);
  expect(badScenario.status).toBe(2);
  const imported = runCli(home, tmpWorkdir("eval-bench-script-cli-"), ["eval", "import", file]);
  expect(imported.status).toBe(0);
  const bench = runEvalScript(home, ["list", "--benchmark", "demo-set"]);
  expect(bench.status).toBe(0);
  const parsedBench = JSON.parse(bench.stdout);
  expect(parsedBench.benchmark).toBe("demo-set");
  expect(parsedBench.tasks).toHaveLength(2);
  // list 不含 testBody（与内置目录同款口径）。
  expect(JSON.stringify(parsedBench.tasks)).not.toContain("total(2, 3)");
  const both = runEvalScript(home, ["list", "--scenario", "code", "--benchmark", "demo-set"]);
  expect(both.status).toBe(2);
  const runBoth = runEvalScript(home, ["run", "--out", join(dir, "out.json"), "--scenario", "code", "--benchmark", "demo-set"]);
  expect(runBoth.status).toBe(2);
  expect(runBoth.stderr).toContain("评测未启动");
});

test("nyra eval CLI 全程：场景、成绩单、基准集、探针、清单", () => {
  const home = tmpHome("eval-bench-cli-");
  const workdir = tmpWorkdir("eval-bench-cli-wd-");
  const scenarios = runCli(home, workdir, ["eval", "scenarios"]);
  expect(scenarios.status).toBe(0);
  expect(scenarios.stdout).toContain("code");
  expect(scenarios.stdout).toContain("connector");
  const scenariosJson = runCli(home, workdir, ["eval", "scenarios", "--json"]);
  expect(JSON.parse(scenariosJson.stdout)).toHaveLength(4);

  const report = fakeReport([
    res("code-01", "code", ["passed"]),
    res("code-02", "code", ["failed"]),
    res("browser-01", "browser", ["passed"]),
  ]);
  const reportPath = writeReport(workdir, report);
  const scorecard = runCli(home, workdir, ["eval", "scorecard", reportPath]);
  expect(scorecard.status).toBe(0);
  expect(scorecard.stdout).toContain("code");
  expect(scorecard.stdout).toContain("成熟度");
  const manifest = runCli(home, workdir, ["eval", "manifest", reportPath]);
  expect(manifest.status).toBe(0);
  const parsedManifest = JSON.parse(manifest.stdout);
  expect(parsedManifest.reportId).toBe("ev-test");
  expect(typeof parsedManifest.resultsHash).toBe("string");
  const manifestOut = join(workdir, "manifest.json");
  const manifestFile = runCli(home, workdir, ["eval", "manifest", reportPath, "--out", manifestOut]);
  expect(manifestFile.status).toBe(0);
  expect(existsSync(manifestOut)).toBe(true);
  expectPerms(manifestOut, 0o600);

  const empty = runCli(home, workdir, ["eval", "benchmarks"]);
  expect(empty.status).toBe(0);
  expect(empty.stdout).toContain("暂无");
  const probeFile = join(process.cwd(), "evals", "probes", "injection-resistance.json");
  const imported = runCli(home, workdir, ["eval", "import", probeFile]);
  expect(imported.status).toBe(0);
  expect(imported.stdout).toContain("已导入基准集 injection-resistance");
  const shown = runCli(home, workdir, ["eval", "benchmark", "injection-resistance"]);
  expect(shown.status).toBe(0);
  expect(shown.stdout).toContain("probe-inj-01");
  const removeNo = runCli(home, workdir, ["eval", "remove", "injection-resistance"]);
  expect(removeNo.status).toBe(1);
  const removed = runCli(home, workdir, ["eval", "remove", "injection-resistance", "--yes"]);
  expect(removed.status).toBe(0);
  expect(removed.stdout).toContain("已删除基准集");

  const probes = runCli(home, workdir, ["eval", "probes"]);
  expect(probes.status).toBe(0);
  expect(probes.stdout).toContain("injection-resistance");
  expect(probes.stdout).toContain("no-side-effect");
  const probe = runCli(home, workdir, ["eval", "probe", "no-side-effect"]);
  expect(probe.status).toBe(0);
  expect(probe.stdout).toContain("probe-nse-01");

  const usage = runCli(home, workdir, ["eval"]);
  expect(usage.status).toBe(0);
  expect(usage.stdout).toContain("nyra eval");
  const unknown = runCli(home, workdir, ["eval", "nonsense"]);
  expect(unknown.status).toBe(1);
  const missing = runCli(home, workdir, ["eval", "scorecard", join(workdir, "nope.json")]);
  expect(missing.status).toBe(1);
});
