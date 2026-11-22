// tests/node/test-group-plan-batch2.test.ts — 第 2 批 G-P1-1：群组计划引擎。
// 全部用临时 home 与临时工作目录，不调模型。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPlanStep,
  completePlanStep,
  createGroupPlan,
  failPlanStep,
  getGroupPlan,
  listGroupPlans,
  runGroupPlan,
  startPlanStep,
} from "../../src/groupPlan.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makePlan(home: string, workdir: string) {
  return createGroupPlan(home, {
    roomId: "room-1",
    title: "分工任务",
    workdir,
    steps: [
      { title: "第一步", assignee: "bot-a", acceptance: ["产出文件 a.txt", "内容含 hello"] },
      { title: "第二步", assignee: "bot-b", acceptance: ["产出文件 b.txt"] },
    ],
  });
}

test("GroupPlanBatch2.test_create_requires_steps_and_acceptance", () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    expect(() => createGroupPlan(home, { roomId: "r", title: "空", workdir, steps: [] })).toThrow("至少要有一条步骤");
    expect(() => createGroupPlan(home, {
      roomId: "r", title: "没验收", workdir,
      steps: [{ title: "s", assignee: "bot-a", acceptance: [] }],
    })).toThrow("至少要有一项验收");
    const plan = makePlan(home, workdir);
    expect(plan.status).toBe("draft");
    expect(plan.steps.length).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_start_step_degrades_to_empty_dir_without_git", () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    const plan = makePlan(home, workdir);
    const step = startPlanStep(home, plan.id, plan.steps[0].id);
    expect(step.status).toBe("running");
    expect(step.worktree_kind).toBe("none");
    expect(step.note).toContain("不是 git 仓库");
    expect(step.contract_id).not.toBeNull();
    expect(existsSync(step.worktree!)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_complete_step_deterministic_gate_blocks", () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    const plan = makePlan(home, workdir);
    const step = startPlanStep(home, plan.id, plan.steps[0].id);
    // 改动文件不存在 → 确定性检查不过，步骤保持 running。
    const blocked = completePlanStep(home, plan.id, step.id, {
      summary: "做完了",
      changedFiles: ["missing.txt"],
      diffStat: "1 file changed",
      checks: [
        { checkId: "acc-1", pass: true, evidence: "a.txt 已写" },
        { checkId: "acc-2", pass: true, evidence: "内容有 hello" },
      ],
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.failedDeterministic.length).toBeGreaterThan(0);
    expect(getGroupPlan(home, plan.id)!.steps[0].status).toBe("running");
    // 文件写进 worktree 后再交：确定性检查过，验收逐项核。
    writeFileSync(join(step.worktree!, "a.txt"), "hello world\n");
    const done = completePlanStep(home, plan.id, step.id, {
      summary: "做完了",
      changedFiles: ["a.txt"],
      diffStat: "1 file changed, 1 insertion(+)",
      checks: [
        { checkId: "acc-1", pass: true, evidence: "a.txt 已写" },
        { checkId: "acc-2", pass: true, evidence: "内容含 hello" },
      ],
    });
    expect(done.ok).toBe(true);
    expect(done.step.status).toBe("done");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_complete_step_unreported_acceptance_counts_as_failed", () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    const plan = makePlan(home, workdir);
    const step = startPlanStep(home, plan.id, plan.steps[0].id);
    writeFileSync(join(step.worktree!, "a.txt"), "hello\n");
    // 只报 acc-1，没报 acc-2 → 没报的按没过算，步骤 failed。
    const res = completePlanStep(home, plan.id, step.id, {
      summary: "做完了",
      changedFiles: ["a.txt"],
      diffStat: "1 file changed",
      checks: [{ checkId: "acc-1", pass: true, evidence: "a.txt 已写" }],
    });
    expect(res.ok).toBe(false);
    expect(res.failedAcceptance).toContain("acc-2");
    expect(res.step.status).toBe("failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_run_plan_all_steps_pass", async () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    const plan = makePlan(home, workdir);
    const result = await runGroupPlan(home, plan.id, {
      runStep: async (step, worktree) => {
        const file = step.title === "第一步" ? "a.txt" : "b.txt";
        writeFileSync(join(worktree!, file), "hello\n");
        return {
          summary: `${step.title}做完了`,
          changedFiles: [file],
          diffStat: "1 file changed, 1 insertion(+)",
          checks: step.acceptance.map((_, i) => ({ checkId: `acc-${i + 1}`, pass: true, evidence: `${file} 已写` })),
        };
      },
    });
    expect(result.failedStepId).toBeNull();
    expect(result.stepsRun).toBe(2);
    expect(result.plan.status).toBe("done");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_run_plan_stops_at_first_failed_step", async () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    const plan = makePlan(home, workdir);
    let runs = 0;
    const result = await runGroupPlan(home, plan.id, {
      runStep: async (step, worktree) => {
        runs += 1;
        writeFileSync(join(worktree!, "a.txt"), "hello\n");
        return {
          summary: "交了",
          changedFiles: ["a.txt"],
          diffStat: "1 file changed",
          checks: step.acceptance.map((_, i) => ({ checkId: `acc-${i + 1}`, pass: false, evidence: "没做出来" })),
        };
      },
    });
    expect(result.failedStepId).toBe(plan.steps[0].id);
    expect(result.failedReason).toContain("验收没过");
    expect(runs).toBe(1);
    // 第一步 failed、第二步还是 pending：计划按派生规则是 active（不是 failed），
    // failed 只有在全部步骤都 done/failed 时才派生。
    expect(result.plan.status).toBe("active");
    expect(listGroupPlans(home, "room-1").length).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_add_step_and_fail_step", () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    const plan = makePlan(home, workdir);
    const added = addPlanStep(home, plan.id, { title: "第三步", assignee: "bot-c", acceptance: ["产出 c.txt"] });
    expect(getGroupPlan(home, plan.id)!.steps.length).toBe(3);
    const failed = failPlanStep(home, plan.id, added.id, "做不下去");
    expect(failed.status).toBe("failed");
    expect(failed.note).toBe("做不下去");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("GroupPlanBatch2.test_start_step_in_git_repo_uses_worktree", () => {
  const home = tmpHome("nyra-gplan-");
  const workdir = tmpHome("nyra-gplan-wd-");
  try {
    spawnSync("git", ["init", "-q"], { cwd: workdir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: workdir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: workdir });
    writeFileSync(join(workdir, "README.md"), "hi\n");
    spawnSync("git", ["add", "."], { cwd: workdir });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: workdir });
    mkdirSync(join(home), { recursive: true });
    const plan = makePlan(home, workdir);
    const step = startPlanStep(home, plan.id, plan.steps[0].id);
    expect(step.worktree_kind).toBe("git");
    expect(step.worktree_branch).toBe(`nyra/plan/${plan.id}/${step.id}`);
    expect(existsSync(join(step.worktree!, "README.md"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
