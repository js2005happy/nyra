// tests/node/test-optimizer.test.ts — G-4 带人批的自优化环（缺口 43 第一批）。
// 钉住的事：
//   - 提议只起草、不自动改代码：从回归用例套模板起草（按失败种类分模板），
//     人工提议须写 newText；坏的测试路径/用例 id 拒绝；
//   - 人批是硬门：draft 不能 apply，批过才能改；批过不能再改；
//   - apply：追加与替换两种改法，oldText 须恰好出现一次；循环有硬上限；
//   - verify：validation 与 holdout 都过才放行；任一不过自动回滚、标 failed；
//     无测试时两项都跳过、直接放行；
//   - revert：人工回滚后回到 draft，可修订再批；目标文件被改动时回滚失败；
//   - 目标文件边界：只限工作目录下 .md，不碰 MEMORY.md、不越界、不进 .nyra/；
//   - CLI 端到端：propose → approve → apply → verify 全程用真 bun test 跑。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  proposeOptimization, getProposal, listProposals, editProposal, decideProposal,
  applyProposal, verifyProposal, revertProposal, resolveTargetPath,
  draftFromRegressionCase, OptimizerError,
} from "../../src/optimizer.ts";
import { addRegressionCases, loadRegressionStore } from "../../src/regression.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tmpWorkdir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "tests", "node"), { recursive: true });
  return dir;
}

function seedCase(home: string, kind: "tool-failed" | "delegate-failed" | "verdict-failed" | "llm-failed" | "run-error", title: string): string {
  const id = `rg_${kind.slice(0, 4)}test01`;
  addRegressionCases(home, [{
    id, sourceRunId: "run-1", kind, title, detail: null, status: "open", createdAt: new Date().toISOString(),
  }]);
  return id;
}

function runCli(home: string, workdir: string, args: string[]) {
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

const fakePass = () => ({ ok: true, output: "1 pass" });
const fakeFail = () => ({ ok: false, output: "1 fail" });

test("OptimizerTest.test_draft_templates_by_kind", () => {
  expect(draftFromRegressionCase("tool-failed", "shell 超时")).toContain("shell 超时");
  expect(draftFromRegressionCase("tool-failed", "shell 超时")).toContain("重试上限 3 次");
  expect(draftFromRegressionCase("delegate-failed", "委派挂了")).toContain("委派前先确认");
  expect(draftFromRegressionCase("verdict-failed", "验收没过")).toContain("自查验收清单");
  expect(draftFromRegressionCase("llm-failed", "模型 429")).toContain("单次硬顶");
  expect(draftFromRegressionCase("run-error", "运行崩了")).toContain("失败记录");
});

test("OptimizerTest.test_propose_from_regression_case", () => {
  const home = tmpHome("nyra-opt-");
  const caseId = seedCase(home, "tool-failed", "shell 超时");
  const p = proposeOptimization(home, { target: "docs/notes.md", fromRegression: caseId });
  expect(p.id).toMatch(/^op_[0-9a-f]{12}$/);
  expect(p.status).toBe("draft");
  expect(p.source).toEqual({ kind: "regression-case", ref: caseId });
  expect(p.newText).toContain("shell 超时");
  expect(p.oldText).toBe("");
  expect(p.datasets.train).toEqual([caseId]);
  expect(p.caps.maxIterations).toBe(3);
  expect(p.caps.maxMinutes).toBe(60);
  expect(p.caps.maxCostUsd).toBeNull();
  expect(p.costUsd).toBe(0);
  // 人工提议须写 newText；坏的测试路径/用例 id 拒绝。
  expect(() => proposeOptimization(home, { target: "docs/notes.md" })).toThrow(OptimizerError);
  expect(() => proposeOptimization(home, { target: "docs/notes.md", fromRegression: "rg_nope000000" })).toThrow(/回归用例不存在/);
  expect(() => proposeOptimization(home, { target: "docs/notes.md", newText: "x", validationTests: ["tests/other/x.test.ts"] })).toThrow(/只限 tests\/node\//);
  expect(() => proposeOptimization(home, { target: "docs/notes.md", newText: "x", maxIterations: 0 })).toThrow(/1 到 10/);
  expect(listProposals(home)).toHaveLength(1);
  expect(loadRegressionStore(home).cases).toHaveLength(1);
});

test("OptimizerTest.test_approve_gate_and_edit", () => {
  const home = tmpHome("nyra-opt-");
  const p = proposeOptimization(home, { target: "docs/notes.md", newText: "第一版", rationale: "测试" });
  // draft 不能 apply。
  expect(() => applyProposal(home, p.id, tmpWorkdir("nyra-opt-wd-"))).toThrow(/须先人批/);
  const edited = editProposal(home, p.id, { newText: "第二版" });
  expect(edited.newText).toBe("第二版");
  const approved = decideProposal(home, p.id, "approved", "owner");
  expect(approved.status).toBe("approved");
  // 批过不能再改、不能再定。
  expect(() => editProposal(home, p.id, { newText: "第三版" })).toThrow(/不能再改/);
  expect(() => decideProposal(home, p.id, "rejected", "owner")).toThrow(/不能再定/);
  const p2 = proposeOptimization(home, { target: "docs/notes.md", newText: "另一条", rationale: "测试" });
  expect(decideProposal(home, p2.id, "rejected", "owner").status).toBe("rejected");
});

test("OptimizerTest.test_apply_append_and_replace", () => {
  const home = tmpHome("nyra-opt-");
  const wd = tmpWorkdir("nyra-opt-wd-");
  writeFileSync(join(wd, "docs", "notes.md"), "# 笔记\n\n旧的一行。\n", "utf-8");
  // 追加式：oldText 为空。
  const p = proposeOptimization(home, { target: "docs/notes.md", newText: "追加的一行。", rationale: "测试" });
  decideProposal(home, p.id, "approved", "owner");
  const applied = applyProposal(home, p.id, wd);
  expect(applied.status).toBe("applied");
  expect(applied.iterations).toBe(1);
  const content = readFileSync(join(wd, "docs", "notes.md"), "utf-8");
  expect(content).toBe("# 笔记\n\n旧的一行。\n追加的一行。\n");
  // 替换式：oldText 恰好出现一次。
  const p2 = proposeOptimization(home, { target: "docs/notes.md", oldText: "旧的一行。", newText: "新的一行。", rationale: "测试" });
  decideProposal(home, p2.id, "approved", "owner");
  applyProposal(home, p2.id, wd);
  expect(readFileSync(join(wd, "docs", "notes.md"), "utf-8")).toContain("新的一行。");
  expect(readFileSync(join(wd, "docs", "notes.md"), "utf-8")).not.toContain("旧的一行。");
  // oldText 出现两次拒绝改文件。
  writeFileSync(join(wd, "docs", "dup.md"), "重复\n重复\n", "utf-8");
  const p3 = proposeOptimization(home, { target: "docs/dup.md", oldText: "重复", newText: "唯一", rationale: "测试" });
  decideProposal(home, p3.id, "approved", "owner");
  expect(() => applyProposal(home, p3.id, wd)).toThrow(/恰好 1 次/);
  // 目标文件不存在拒绝。
  const p4 = proposeOptimization(home, { target: "docs/missing.md", newText: "x", rationale: "测试" });
  decideProposal(home, p4.id, "approved", "owner");
  expect(() => applyProposal(home, p4.id, wd)).toThrow(/目标文件不存在/);
});

test("OptimizerTest.test_verify_release_and_auto_revert", () => {
  const home = tmpHome("nyra-opt-");
  const wd = tmpWorkdir("nyra-opt-wd-");
  const file = join(wd, "docs", "notes.md");
  writeFileSync(file, "# 笔记\n", "utf-8");
  // 无测试：两项跳过，直接放行。
  const p1 = proposeOptimization(home, { target: "docs/notes.md", newText: "追加 A。", rationale: "测试" });
  decideProposal(home, p1.id, "approved", "owner");
  applyProposal(home, p1.id, wd);
  const v1 = verifyProposal(home, p1.id, wd, { runner: fakePass });
  expect(v1.proposal.status).toBe("released");
  expect(v1.validation.ran).toBe(false);
  expect(v1.holdout.ran).toBe(false);
  // validation 通过、holdout 通过 → 放行。
  const p2 = proposeOptimization(home, {
    target: "docs/notes.md", newText: "追加 B。", rationale: "测试",
    validationTests: ["tests/node/test-a.test.ts"], holdoutTests: ["tests/node/test-b.test.ts"],
  });
  decideProposal(home, p2.id, "approved", "owner");
  applyProposal(home, p2.id, wd);
  const v2 = verifyProposal(home, p2.id, wd, { runner: fakePass });
  expect(v2.proposal.status).toBe("released");
  expect(v2.validation.ok).toBe(true);
  expect(v2.holdout.ok).toBe(true);
  // validation 不过 → 自动回滚、标 failed，文件回到追加 B 之前。
  const beforeFail = readFileSync(file, "utf-8");
  const p3 = proposeOptimization(home, {
    target: "docs/notes.md", newText: "追加 C。", rationale: "测试",
    validationTests: ["tests/node/test-a.test.ts"],
  });
  decideProposal(home, p3.id, "approved", "owner");
  applyProposal(home, p3.id, wd);
  const v3 = verifyProposal(home, p3.id, wd, { runner: fakeFail });
  expect(v3.proposal.status).toBe("failed");
  expect(v3.reverted).toBe(true);
  expect(readFileSync(file, "utf-8")).toBe(beforeFail);
  // failed 的提议可修订回 draft，再批再改（循环上限内）。
  const revised = editProposal(home, p3.id, { newText: "追加 C 改。" });
  expect(revised.status).toBe("draft");
  expect(revised.newText).toBe("追加 C 改。");
  // validation 过、holdout 不过 → 同样自动回滚。
  const p4 = proposeOptimization(home, {
    target: "docs/notes.md", newText: "追加 D。", rationale: "测试",
    validationTests: ["tests/node/test-a.test.ts"], holdoutTests: ["tests/node/test-b.test.ts"],
  });
  decideProposal(home, p4.id, "approved", "owner");
  applyProposal(home, p4.id, wd);
  const v4 = verifyProposal(home, p4.id, wd, {
    runner: (files) => (files[0].includes("test-a") ? fakePass() : fakeFail()),
  });
  expect(v4.proposal.status).toBe("failed");
  expect(v4.reverted).toBe(true);
  expect(readFileSync(file, "utf-8")).toBe(beforeFail);
  expect(v4.validation.ok).toBe(true);
  expect(v4.holdout.ok).toBe(false);
});

test("OptimizerTest.test_verify_revert_failure_keeps_failed", () => {
  const home = tmpHome("nyra-opt-");
  const wd = tmpWorkdir("nyra-opt-wd-");
  const file = join(wd, "docs", "notes.md");
  writeFileSync(file, "# 笔记\n", "utf-8");
  const p = proposeOptimization(home, {
    target: "docs/notes.md", newText: "追加。", rationale: "测试",
    validationTests: ["tests/node/test-a.test.ts"],
  });
  decideProposal(home, p.id, "approved", "owner");
  applyProposal(home, p.id, wd);
  // 验证之前有人改了文件：回滚对不上，标 failed 但回滚失败，等人工处理。
  writeFileSync(file, "# 笔记\n被人改了。\n", "utf-8");
  const v = verifyProposal(home, p.id, wd, { runner: fakeFail });
  expect(v.proposal.status).toBe("failed");
  expect(v.reverted).toBe(false);
  expect(v.revertError).toContain("拒绝回滚");
  expect(readFileSync(file, "utf-8")).toBe("# 笔记\n被人改了。\n");
});

test("OptimizerTest.test_iteration_cap", () => {
  const home = tmpHome("nyra-opt-");
  const wd = tmpWorkdir("nyra-opt-wd-");
  writeFileSync(join(wd, "docs", "notes.md"), "# 笔记\n", "utf-8");
  const p = proposeOptimization(home, {
    target: "docs/notes.md", newText: "追加。", rationale: "测试", maxIterations: 1,
    validationTests: ["tests/node/test-a.test.ts"],
  });
  decideProposal(home, p.id, "approved", "owner");
  applyProposal(home, p.id, wd);
  verifyProposal(home, p.id, wd, { runner: fakeFail });
  expect(getProposal(home, p.id).status).toBe("failed");
  editProposal(home, p.id, { newText: "追加改。" });
  decideProposal(home, p.id, "approved", "owner");
  expect(() => applyProposal(home, p.id, wd)).toThrow(/循环上限/);
});

test("OptimizerTest.test_manual_revert_back_to_draft", () => {
  const home = tmpHome("nyra-opt-");
  const wd = tmpWorkdir("nyra-opt-wd-");
  const file = join(wd, "docs", "notes.md");
  writeFileSync(file, "# 笔记\n", "utf-8");
  const p = proposeOptimization(home, { target: "docs/notes.md", newText: "追加。", rationale: "测试" });
  decideProposal(home, p.id, "approved", "owner");
  applyProposal(home, p.id, wd);
  expect(readFileSync(file, "utf-8")).toContain("追加。");
  const reverted = revertProposal(home, p.id, wd);
  expect(reverted.status).toBe("draft");
  expect(readFileSync(file, "utf-8")).toBe("# 笔记\n");
  expect(() => revertProposal(home, p.id, wd)).toThrow(/只有 applied 或 failed/);
});

test("OptimizerTest.test_target_path_boundaries", () => {
  const wd = tmpWorkdir("nyra-opt-wd-");
  expect(() => resolveTargetPath(wd, "/etc/passwd")).toThrow(/相对路径/);
  expect(() => resolveTargetPath(wd, "../outside.md")).toThrow(/越出工作目录/);
  expect(() => resolveTargetPath(wd, "docs/notes.txt")).toThrow(/只限 \.md/);
  expect(() => resolveTargetPath(wd, "MEMORY.md")).toThrow(/MEMORY\.md/);
  expect(() => resolveTargetPath(wd, ".nyra/notes.md")).toThrow(/\.nyra/);
  expect(() => resolveTargetPath(wd, "")).toThrow(/须写目标文件/);
  expect(resolveTargetPath(wd, "docs/notes.md")).toBe(join(wd, "docs", "notes.md"));
});

test("OptimizerTest.test_cli_end_to_end_real_bun_test", () => {
  const home = tmpHome("nyra-opt-");
  const wd = tmpWorkdir("nyra-opt-wd-");
  writeFileSync(join(wd, "docs", "notes.md"), "# 笔记\n", "utf-8");
  writeFileSync(
    join(wd, "tests", "node", "test-tmp-verify.test.ts"),
    "import { test, expect } from \"bun:test\";\ntest(\"tmp\", () => { expect(1).toBe(1); });\n",
    "utf-8",
  );
  const propose = runCli(home, wd, ["optimize", "propose", "--target", "docs/notes.md", "--new-text", "CLI 追加的一行。", "--rationale", "CLI 测试", "--validation-tests", "tests/node/test-tmp-verify.test.ts"]);
  expect(propose.status).toBe(0);
  expect(propose.stdout).toContain("提议已起草");
  const id = propose.stdout.match(/op_[0-9a-f]{12}/)?.[0];
  expect(id).toBeTruthy();
  // approve 没 --yes 拒绝。
  const noYes = runCli(home, wd, ["optimize", "approve", id!]);
  expect(noYes.status).toBe(2);
  expect(getProposal(home, id!).status).toBe("draft");
  expect(runCli(home, wd, ["optimize", "approve", id!, "--yes"]).status).toBe(0);
  expect(runCli(home, wd, ["optimize", "apply", id!, "--yes"]).status).toBe(0);
  expect(readFileSync(join(wd, "docs", "notes.md"), "utf-8")).toContain("CLI 追加的一行。");
  // verify 跑真 bun test：通过 → released。
  const verify = runCli(home, wd, ["optimize", "verify", id!]);
  expect(verify.status).toBe(0);
  expect(verify.stdout).toContain("validation：通过");
  expect(verify.stdout).toContain("已放行");
  expect(getProposal(home, id!).status).toBe("released");
  // 再来一个失败的：真 bun test 不过 → 自动回滚、标 failed。
  writeFileSync(
    join(wd, "tests", "node", "test-tmp-fail.test.ts"),
    "import { test, expect } from \"bun:test\";\ntest(\"tmp-fail\", () => { expect(1).toBe(2); });\n",
    "utf-8",
  );
  const propose2 = runCli(home, wd, ["optimize", "propose", "--target", "docs/notes.md", "--new-text", "会失败的一行。", "--rationale", "CLI 测试", "--validation-tests", "tests/node/test-tmp-fail.test.ts"]);
  const id2 = propose2.stdout.match(/op_[0-9a-f]{12}/)?.[0];
  expect(id2).toBeTruthy();
  expect(runCli(home, wd, ["optimize", "approve", id2!, "--yes"]).status).toBe(0);
  expect(runCli(home, wd, ["optimize", "apply", id2!, "--yes"]).status).toBe(0);
  const verify2 = runCli(home, wd, ["optimize", "verify", id2!]);
  expect(verify2.status).toBe(0);
  expect(verify2.stdout).toContain("validation：未通过");
  expect(verify2.stdout).toContain("已自动回滚");
  expect(getProposal(home, id2!).status).toBe("failed");
  expect(readFileSync(join(wd, "docs", "notes.md"), "utf-8")).not.toContain("会失败的一行。");
  expect(existsSync(join(home, "optimization-proposals.json"))).toBe(true);
  expectPerms(join(home, "optimization-proposals.json"), 0o600);
});
