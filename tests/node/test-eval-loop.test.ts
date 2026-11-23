// tests/node/test-eval-loop.test.ts — G-P1-29 评测驱动的优化闭环。
// 钉住的事：
//   - 失败聚类：只看每题第一次尝试；passed/blocked 不进簇；同类 + 同验收项
//     合一簇，不同验收项分簇，无验收项记 no-checks；
//   - 报告校验：缺文件、坏 JSON、错 suite、未跑完、目录外任务 id 都拒绝；
//   - loop 一轮：没有未结提议的簇自动起草（来源 eval-report、带 armKey），
//     已有未结提议的簇复用不重起；第二轮同一份报告不再新起草；
//   - UCB：没拉过的臂优先；放行记 1、失败记 0；分数相等按 key 升序；
//   - verify 结果回填臂账本：放行 pulls+1/rewards+1，失败 pulls+1/rewards+0；
//   - 臂账本损坏先备份再抛错；loop 只起草、不改文件（apply 仍须人批）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { EVAL_TASKS, DEFAULT_EVAL_CONDITIONS } from "../../src/eval/catalog.ts";
import type { EvalReport, EvalResult } from "../../src/eval/runner.ts";
import {
  clusterEvalFailures, draftFromEvalCluster, loadEvalReportForLoop, runEvalLoop,
  handleOptimizeLoop, listRankedArms, EvalLoopError,
} from "../../src/evalLoop.ts";
import {
  loadArmsLedger, ensureArm, recordArmReward, ucbScore, rankArms, OptimizerArmsError,
} from "../../src/optimizerArms.ts";
import {
  proposeOptimization, decideProposal, applyProposal, verifyProposal, listProposals,
} from "../../src/optimizer.ts";

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

function fakeResult(
  taskId: string,
  category: string,
  status: "passed" | "failed" | "blocked",
  checks: { id: string; passed: boolean; evidence: string }[] = [],
  reason: string | null = null,
): EvalResult {
  return {
    taskId,
    category,
    attempts: [{ status, reason, checks, spentUsd: 0, interventions: 0, modelCalls: 0, taskId, attempt: 1, durationMs: 10, conditionsHash: "0123456789ab" }],
  };
}

function fakeReport(id: string, results: EvalResult[], finishedAt: string | null = new Date().toISOString()): EvalReport {
  return {
    schemaVersion: 1, suite: "nyra-real-tasks-v1", id, createdAt: new Date().toISOString(),
    sourceRevision: "test", sourceHash: "test", harnessHash: "test", catalogHash: "test",
    conditions: { ...DEFAULT_EVAL_CONDITIONS }, conditionsHash: "0123456789ab",
    environment: {}, wallDurationMs: 100, finishedAt, parentReport: null, results,
    summary: {
      total: results.length, passed: 0, failed: 0, blocked: 0, executed: 0,
      successRateAll: null, successRateExecuted: null, executionCoverage: null,
      recoveredOnRetry: 0, attempts: results.length, modelCalls: 0, unknownModelCallAttempts: 0,
      knownSpentUsd: 0, spentUsd: 0, unknownCostAttempts: 0, durationMs: 100,
      interventions: 0, unknownInterventionAttempts: 0,
    },
  };
}

function writeReport(dir: string, name: string, report: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf-8");
  return path;
}

const codeTasks = EVAL_TASKS.filter((t) => t.category === "code");
const browserTask = EVAL_TASKS.find((t) => t.category === "browser")!;
const researchTask = EVAL_TASKS.find((t) => t.category === "research")!;

test("EvalLoopTest.test_cluster_same_check_merges", () => {
  const report = fakeReport("ev-cluster1", [
    fakeResult(codeTasks[0].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "x" }], "验收没过"),
    fakeResult(codeTasks[1].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "y" }], "验收没过"),
    fakeResult(browserTask.id, "browser", "failed", [{ id: "browser-dom-readback", passed: false, evidence: "z" }], "页面读不到"),
  ]);
  const clusters = clusterEvalFailures(report);
  expect(clusters.length).toBe(2);
  const code = clusters.find((c) => c.key === "code:artifact-json")!;
  expect(code.taskIds).toEqual([codeTasks[0].id, codeTasks[1].id]);
  expect(code.reasons).toEqual(["验收没过"]);
  const browser = clusters.find((c) => c.key === "browser:browser-dom-readback")!;
  expect(browser.taskIds).toEqual([browserTask.id]);
});

test("EvalLoopTest.test_cluster_skips_passed_blocked_and_no_checks", () => {
  const report = fakeReport("ev-cluster2", [
    fakeResult(codeTasks[0].id, "code", "passed"),
    fakeResult(codeTasks[1].id, "code", "blocked", [], "模型没配好"),
    fakeResult(researchTask.id, "research", "failed", [], "评测执行异常，指标未知"),
  ]);
  const clusters = clusterEvalFailures(report);
  expect(clusters.length).toBe(1);
  expect(clusters[0].key).toBe("research:no-checks");
  expect(clusters[0].taskIds).toEqual([researchTask.id]);
});

test("EvalLoopTest.test_cluster_uses_first_failed_check", () => {
  const report = fakeReport("ev-cluster3", [
    fakeResult(codeTasks[0].id, "code", "failed", [
      { id: "fixture:guard.txt", passed: true, evidence: "ok" },
      { id: "artifact-json", passed: false, evidence: "bad" },
    ]),
  ]);
  const clusters = clusterEvalFailures(report);
  expect(clusters.length).toBe(1);
  expect(clusters[0].checkId).toBe("artifact-json");
});

test("EvalLoopTest.test_draft_from_eval_cluster_mentions_report_and_tasks", () => {
  const text = draftFromEvalCluster(
    { key: "code:artifact-json", category: "code", checkId: "artifact-json", taskIds: ["code-01", "code-02"], reasons: ["验收没过"] },
    "ev-draft1",
  );
  expect(text).toContain("ev-draft1");
  expect(text).toContain("code-01");
  expect(text).toContain("artifact-json");
  expect(text).toContain("不要为了过评测放宽验收");
});

test("EvalLoopTest.test_load_report_rejects_bad_inputs", () => {
  const dir = tmpHome("evloop-bad-");
  expect(() => loadEvalReportForLoop(join(dir, "nope.json"))).toThrow(EvalLoopError);
  const badJson = join(dir, "bad.json");
  writeFileSync(badJson, "{not json", "utf-8");
  expect(() => loadEvalReportForLoop(badJson)).toThrow(EvalLoopError);
  const wrongSuite = writeReport(dir, "wrong.json", { ...fakeReport("ev-wrong", []), suite: "other-suite" });
  expect(() => loadEvalReportForLoop(wrongSuite)).toThrow(EvalLoopError);
  const unfinished = writeReport(dir, "unfinished.json", fakeReport("ev-unfinished", [], null));
  expect(() => loadEvalReportForLoop(unfinished)).toThrow(/还没跑完/);
  const unknownTask = writeReport(dir, "unknown.json", fakeReport("ev-unknown", [
    fakeResult("not-a-task", "code", "failed"),
  ]));
  expect(() => loadEvalReportForLoop(unknownTask)).toThrow(/目录外/);
});

test("EvalLoopTest.test_ucb_unpulled_first_then_by_mean", () => {
  const a = { key: "code:a", category: "code", checkId: "a", pulls: 0, rewards: 0, createdAt: "2026-01-01T00:00:00.000Z", lastTriedAt: null };
  const b = { key: "code:b", category: "code", checkId: "b", pulls: 2, rewards: 2, createdAt: "2026-01-01T00:00:00.000Z", lastTriedAt: null };
  expect(ucbScore(a, 2)).toBe(Number.POSITIVE_INFINITY);
  expect(ucbScore(b, 2)).toBeGreaterThan(1);
  expect(rankArms([b, a]).map((x) => x.key)).toEqual(["code:a", "code:b"]);
  const c = { ...b, key: "code:c", pulls: 10, rewards: 0 };
  // 拉得多、奖励 0 的臂排在拉得少、奖励满的臂后面。
  expect(rankArms([c, b]).map((x) => x.key)).toEqual(["code:b", "code:c"]);
  // 分数相等时按 key 升序。
  const d = { ...b, key: "code:aa" };
  expect(rankArms([b, d]).map((x) => x.key)).toEqual(["code:aa", "code:b"]);
});

test("EvalLoopTest.test_arms_ledger_roundtrip_and_corrupt_backup", () => {
  const home = tmpHome("evloop-arms-");
  const arm = ensureArm(home, "code:artifact-json", { category: "code", checkId: "artifact-json" });
  expect(arm.pulls).toBe(0);
  recordArmReward(home, "code:artifact-json", 1);
  const loaded = loadArmsLedger(home);
  expect(loaded.arms[0].pulls).toBe(1);
  expect(loaded.arms[0].rewards).toBe(1);
  expectPerms(join(home, "optimizer-arms.json"), 0o600);
  writeFileSync(join(home, "optimizer-arms.json"), "{broken", "utf-8");
  expect(() => loadArmsLedger(home)).toThrow(OptimizerArmsError);
  const backups = readdirSync(home).filter((f) => f.startsWith("optimizer-arms.json.corrupt-"));
  expect(backups.length).toBe(1);
});

test("EvalLoopTest.test_loop_drafts_and_reuses", () => {
  const home = tmpHome("evloop-run-");
  const workdir = tmpWorkdir("evloop-run-wd-");
  const reportPath = writeReport(tmpdir(), "ev-loop1.json", fakeReport("ev-loop1", [
    fakeResult(codeTasks[0].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "x" }], "验收没过"),
    fakeResult(codeTasks[1].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "y" }], "验收没过"),
    fakeResult(browserTask.id, "browser", "failed", [{ id: "browser-dom-readback", passed: false, evidence: "z" }], "页面读不到"),
  ]));
  const first = runEvalLoop(home, workdir, { reportPath, target: "docs/notes.md" });
  expect(first.reportId).toBe("ev-loop1");
  expect(first.clusters.length).toBe(2);
  expect(first.drafted.length).toBe(2);
  expect(first.reused.length).toBe(0);
  expect(first.rankedArms).toEqual(["browser:browser-dom-readback", "code:artifact-json"]);
  const browserProposal = first.drafted.find((id) => listProposals(home).find((x) => x.id === id)?.armKey === "browser:browser-dom-readback");
  expect(first.recommendedProposalId).toBe(browserProposal);
  const drafted = listProposals(home);
  expect(drafted.length).toBe(2);
  for (const p of drafted) {
    expect(p.source.kind).toBe("eval-report");
    expect(p.source.ref).toContain("ev-loop1:");
    expect(p.status).toBe("draft");
    expect(p.target).toBe("docs/notes.md");
  }
  const arms = loadArmsLedger(home);
  expect(arms.arms.length).toBe(2);
  expect(arms.runs.length).toBe(1);
  expect(arms.runs[0].drafted).toEqual(first.drafted);
  // 同一份报告再跑一轮：不再新起草，全部复用。
  const second = runEvalLoop(home, workdir, { reportPath, target: "docs/notes.md" });
  expect(second.drafted.length).toBe(0);
  expect(second.reused.length).toBe(2);
  expect(listProposals(home).length).toBe(2);
  expect(loadArmsLedger(home).runs.length).toBe(2);
});

test("EvalLoopTest.test_loop_rejects_bad_target", () => {
  const home = tmpHome("evloop-target-");
  const workdir = tmpWorkdir("evloop-target-wd-");
  const reportPath = writeReport(tmpdir(), "ev-loop-target.json", fakeReport("ev-loop-target", [
    fakeResult(codeTasks[0].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "x" }]),
  ]));
  expect(() => runEvalLoop(home, workdir, { reportPath, target: "MEMORY.md" })).toThrow(/MEMORY\.md/);
  expect(() => runEvalLoop(home, workdir, { reportPath, target: "/abs/path.md" })).toThrow(/相对路径/);
  expect(() => runEvalLoop(home, workdir, { reportPath, target: "docs/notes.txt" })).toThrow(/\.md/);
});

test("EvalLoopTest.test_verify_outcome_feeds_back_into_arms", () => {
  const home = tmpHome("evloop-reward-");
  const workdir = tmpWorkdir("evloop-reward-wd-");
  writeFileSync(join(workdir, "docs", "notes.md"), "# 笔记\n", "utf-8");
  const fakePass = () => ({ ok: true, output: "1 pass" });
  const fakeFail = () => ({ ok: false, output: "1 fail" });
  const p1 = proposeOptimization(home, {
    target: "docs/notes.md", newText: "教训一", rationale: "评测提议",
    sourceKind: "eval-report", sourceRef: "ev-r1:code:artifact-json", armKey: "code:artifact-json",
  });
  decideProposal(home, p1.id, "approved", "cli");
  applyProposal(home, p1.id, workdir);
  const out1 = verifyProposal(home, p1.id, workdir, { runner: fakePass });
  expect(out1.proposal.status).toBe("released");
  let arms = loadArmsLedger(home).arms;
  expect(arms.length).toBe(1);
  expect(arms[0].pulls).toBe(1);
  expect(arms[0].rewards).toBe(1);
  const p2 = proposeOptimization(home, {
    target: "docs/notes.md", newText: "教训二", rationale: "评测提议",
    sourceKind: "eval-report", sourceRef: "ev-r2:code:artifact-json", armKey: "code:artifact-json",
    validationTests: ["tests/node/test-optimizer.test.ts"],
  });
  decideProposal(home, p2.id, "approved", "cli");
  applyProposal(home, p2.id, workdir);
  const out2 = verifyProposal(home, p2.id, workdir, { runner: fakeFail });
  expect(out2.proposal.status).toBe("failed");
  expect(out2.reverted).toBe(true);
  arms = loadArmsLedger(home).arms;
  expect(arms[0].pulls).toBe(2);
  expect(arms[0].rewards).toBe(1);
  // 奖励回填后，臂的 UCB 分数 = 均值 0.5 + √2·√(ln3/2) ≈ 1.548。
  expect(ucbScore(arms[0], 2)).toBeGreaterThan(0.5);
  expect(ucbScore(arms[0], 2)).toBeLessThan(2);
});

test("EvalLoopTest.test_cli_loop_and_arms_end_to_end", () => {
  const home = tmpHome("evloop-cli-");
  const workdir = tmpWorkdir("evloop-cli-wd-");
  const empty = runCli(home, workdir, ["optimize", "arms"]);
  expect(empty.status).toBe(0);
  expect(empty.stdout).toContain("暂无 UCB 臂");
  const reportPath = writeReport(tmpdir(), "ev-loop-cli.json", fakeReport("ev-loop-cli", [
    fakeResult(codeTasks[0].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "x" }], "验收没过"),
    fakeResult(browserTask.id, "browser", "failed", [{ id: "browser-dom-readback", passed: false, evidence: "z" }], "页面读不到"),
  ]));
  const res = runCli(home, workdir, ["optimize", "loop", "--eval-report", reportPath, "--target", "docs/notes.md"]);
  expect(res.status).toBe(0);
  expect(res.stdout).toContain("评测报告 ev-loop-cli：2 个失败簇");
  expect(res.stdout).toContain("新起草提议 2 条");
  expect(res.stdout).toContain("下一步最值得批");
  expect(res.stdout).toContain("只起草、不改文件");
  const arms = runCli(home, workdir, ["optimize", "arms"]);
  expect(arms.status).toBe(0);
  expect(arms.stdout).toContain("code:artifact-json");
  expect(arms.stdout).toContain("browser:browser-dom-readback");
  expect(arms.stdout).toContain("∞（未试过）");
  // 缺参数时用法报错，不静默成功。
  const bad = runCli(home, workdir, ["optimize", "loop", "--target", "docs/notes.md"]);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr + bad.stdout).toContain("--eval-report");
  // loop 不改目标文件。
  expect(existsSync(join(workdir, "docs", "notes.md"))).toBe(false);
});

test("EvalLoopTest.test_handle_loop_json_output", () => {
  const home = tmpHome("evloop-json-");
  const workdir = tmpWorkdir("evloop-json-wd-");
  const reportPath = writeReport(tmpdir(), "ev-loop-json.json", fakeReport("ev-loop-json", [
    fakeResult(codeTasks[0].id, "code", "failed", [{ id: "artifact-json", passed: false, evidence: "x" }]),
  ]));
  const code = handleOptimizeLoop(["loop", "--eval-report", reportPath, "--target", "docs/notes.md", "--json"], home, workdir);
  expect(code).toBe(0);
});
