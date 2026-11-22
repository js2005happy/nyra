// tests/node/test-foreign-branch-batch2.test.ts — 第 2 批 G-P1-8：外来 agent 隔离分支。
// 全部用临时 home 与临时 git 仓库，不调模型。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createForeignWorktree,
  dropForeignBranch,
  getForeignBranch,
  listForeignBranches,
  mergeForeignBranch,
  recordForeignBranch,
  updateForeignBranchResult,
} from "../../src/foreignBranch.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
}

function makeRepo(): string {
  const dir = tmpHome("nyra-foreign-repo-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  // Windows 上 git 默认 autocrlf 会把 merge --abort 恢复的文件写成 CRLF，
  // 断言按 LF 写的原文就会误报；仓库级关掉，三个平台行为一致。
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function startForeign(home: string, repo: string, taskId: string, peer: string) {
  const wt = createForeignWorktree(repo, taskId);
  expect(wt.branch).toBe(`nyra/foreign/${taskId}`);
  const rec = recordForeignBranch(home, { taskId, peer, branch: wt.branch, worktree: wt.worktree, workdir: repo });
  expect(rec.status).toBe("open");
  return wt;
}

test("ForeignBranchBatch2.test_create_merge_flow", () => {
  const home = tmpHome("nyra-foreign-");
  const repo = makeRepo();
  try {
    const wt = startForeign(home, repo, "task-1", "alice");
    expect(existsSync(join(wt.worktree, "README.md"))).toBe(true);
    writeFileSync(join(wt.worktree, "feature.txt"), "外来机器人做的\n");
    git(wt.worktree, "add", ".");
    git(wt.worktree, "commit", "-qm", "feature");
    const rec = updateForeignBranchResult(home, "task-1", { changedFiles: ["feature.txt"], diffStat: "1 file changed" });
    expect(rec?.changed_files).toEqual(["feature.txt"]);
    const merged = mergeForeignBranch(home, "task-1");
    expect(merged.ok).toBe(true);
    expect(getForeignBranch(home, "task-1")?.status).toBe("merged");
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(existsSync(wt.worktree)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ForeignBranchBatch2.test_conflict_keeps_branch_open", () => {
  const home = tmpHome("nyra-foreign-");
  const repo = makeRepo();
  try {
    const wt = startForeign(home, repo, "task-2", "bob");
    writeFileSync(join(wt.worktree, "README.md"), "外来改动\n");
    git(wt.worktree, "add", ".");
    git(wt.worktree, "commit", "-qm", "foreign change");
    writeFileSync(join(repo, "README.md"), "机主改动\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "owner change");
    const merged = mergeForeignBranch(home, "task-2");
    expect(merged.ok).toBe(false);
    expect(getForeignBranch(home, "task-2")?.status).toBe("open");
    expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe("机主改动\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ForeignBranchBatch2.test_drop_branch_and_worktree", () => {
  const home = tmpHome("nyra-foreign-");
  const repo = makeRepo();
  try {
    const wt = startForeign(home, repo, "task-3", "carol");
    const dropped = dropForeignBranch(home, "task-3");
    expect(dropped.status).toBe("dropped");
    expect(getForeignBranch(home, "task-3")?.status).toBe("dropped");
    expect(existsSync(wt.worktree)).toBe(false);
    expect(listForeignBranches(home).length).toBe(1);
    expect(listForeignBranches(home, "dropped").length).toBe(1);
    expect(listForeignBranches(home, "open").length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ForeignBranchBatch2.test_non_git_repo_throws_no_fallback", () => {
  const home = tmpHome("nyra-foreign-");
  const plain = tmpHome("nyra-foreign-plain-");
  try {
    expect(() => createForeignWorktree(plain, "task-4")).toThrow("不是 git 仓库");
    expect(getForeignBranch(home, "task-4")).toBeNull();
    expect(() => mergeForeignBranch(home, "no-such-task")).toThrow("没有这个外来分支任务");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});
