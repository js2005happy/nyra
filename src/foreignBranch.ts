// src/foreignBranch.ts — G-P1-8：外来 agent 先在隔离分支干活（借 Cline
// 的“先在隔离分支改、合入须人批”做法）。
//
// 外来 agent（好友机器人、外部 agent 派来的子任务）一律走隔离分支：
// - 委派时 foreign: true → 强制 worktree 隔离（isolation 哪怕传了 none
//   也会被改成 worktree），且 worktree 建在具名分支 nyra/foreign/<task>
//   上（不是 detached——具名分支才能按名合并、按名删除）；
// - 分支登记进 ~/.nyra/foreign-branches.json（原子写 0600）：谁派的、
//   哪个任务、什么状态（open/merged/dropped）、改了哪些文件；
// - 合入必须机主显式批（nyra peer branch merge <task> --yes）：
//   git merge --no-ff <分支>，成了才删 worktree + 删分支 + 标 merged；
//   冲突时合并失败、分支保持 open，机主自己手动解决，不自动强行合入；
// - 不要了就 drop（删 worktree + 删分支 + 标 dropped）；
// - 没改动文件的任务：worktree 清理时分支一并删掉、标 dropped（无改动）。
// 本机 agent 的委派不受影响：foreign 不传时行为与以前完全一致。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";

export const FOREIGN_BRANCHES_FILE = "foreign-branches.json";
export type ForeignBranchStatus = "open" | "merged" | "dropped";

export interface ForeignBranch {
  task_id: string;
  peer: string;
  branch: string;
  worktree: string;
  workdir: string;
  status: ForeignBranchStatus;
  changed_files: string[];
  diff_stat: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

export interface ForeignBranchStore {
  version: 1;
  branches: ForeignBranch[];
}

export class ForeignBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForeignBranchError";
  }
}

export function foreignBranchesPath(home: string): string {
  return join(resolveNyraHome(home), FOREIGN_BRANCHES_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadForeignBranches(home: string): ForeignBranchStore {
  const path = foreignBranchesPath(home);
  if (!existsSync(path)) return { version: 1, branches: [] };
  if (lstatSync(path).isSymbolicLink()) throw new ForeignBranchError("外来分支账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new ForeignBranchError("外来分支账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as ForeignBranchStore).version !== 1 ||
    !Array.isArray((raw as ForeignBranchStore).branches)) {
    backupCorrupt(path);
    throw new ForeignBranchError("外来分支账本格式无效，已备份");
  }
  return raw as ForeignBranchStore;
}

export function saveForeignBranches(home: string, store: ForeignBranchStore): void {
  const path = foreignBranchesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ForeignBranchError("外来分支账本不能是符号链接");
  const tmp = join(dirname(path), `.foreign-branches-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordBranchEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`外来分支：${type}`, "foreign-branch", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏分支本身 */ }
}

/** 外来任务的分支名（具名分支，按名合并、按名删除）。 */
export function foreignBranchName(taskId: string): string {
  return `nyra/foreign/${taskId}`;
}

/**
 * 给外来任务建隔离 worktree（具名分支）：工作目录不是 git 仓库时直接
 * 抛错（外来任务不许退化成“直接在主工作区干活”——隔离是硬的）。
 */
export function createForeignWorktree(workdir: string, taskId: string): { worktree: string; branch: string } {
  const probe = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: workdir, encoding: "utf-8", windowsHide: true });
  if (probe.status !== 0) {
    throw new ForeignBranchError(`外来任务要求隔离分支，但工作目录不是 git 仓库（${workdir} 不是，或本机没有 git）：外来任务不许直接在主工作区干活`);
  }
  const branch = foreignBranchName(taskId);
  const dir = mkdtempSync(join(tmpdir(), "nyra-foreign-"));
  const add = spawnSync("git", ["worktree", "add", "-b", branch, dir, "HEAD"], {
    cwd: workdir, encoding: "utf-8", windowsHide: true,
  });
  if (add.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new ForeignBranchError(`外来任务隔离分支创建失败：${`${add.stdout ?? ""}${add.stderr ?? ""}`.trim().slice(0, 300)}`);
  }
  return { worktree: dir, branch };
}

/** 登记一条外来分支（委派启动时记，状态 open）。 */
export function recordForeignBranch(home: string, opts: {
  taskId: string;
  peer: string;
  branch: string;
  worktree: string;
  workdir: string;
}): ForeignBranch {
  const store = loadForeignBranches(home);
  const rec: ForeignBranch = {
    task_id: opts.taskId,
    peer: opts.peer,
    branch: opts.branch,
    worktree: opts.worktree,
    workdir: opts.workdir,
    status: "open",
    changed_files: [],
    diff_stat: null,
    created_at: nowIso(),
    decided_at: null,
    decided_by: null,
    note: null,
  };
  store.branches.push(rec);
  saveForeignBranches(home, store);
  recordBranchEvent(home, "foreign_branch_created", { task_id: opts.taskId, peer: opts.peer, branch: opts.branch });
  return rec;
}

export function getForeignBranch(home: string, taskId: string): ForeignBranch | null {
  return loadForeignBranches(home).branches.find((b) => b.task_id === taskId) ?? null;
}

export function listForeignBranches(home: string, status?: ForeignBranchStatus): ForeignBranch[] {
  const all = loadForeignBranches(home).branches;
  return status ? all.filter((b) => b.status === status) : all;
}

/** 外来任务跑完、改动落盘后，把改动清单记进分支记录（合入时人看得见改了什么）。 */
export function updateForeignBranchResult(home: string, taskId: string, result: { changedFiles: string[]; diffStat: string | null }): ForeignBranch | null {
  const store = loadForeignBranches(home);
  const rec = store.branches.find((b) => b.task_id === taskId);
  if (!rec) return null;
  rec.changed_files = result.changedFiles;
  rec.diff_stat = result.diffStat;
  saveForeignBranches(home, store);
  return rec;
}

function removeWorktreeAndBranch(workdir: string, worktree: string, branch: string): void {
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: workdir, windowsHide: true });
  spawnSync("git", ["branch", "-D", branch], { cwd: workdir, windowsHide: true });
}

export interface MergeResult {
  ok: boolean;
  output: string;
}

/**
 * 合入外来分支（机主操作，须 --yes，CLI 层拦）：git merge --no-ff。
 * 成功：删 worktree + 删分支 + 标 merged；冲突/失败：分支保持 open，
 * 返回失败输出，机主手动解决，不自动强行合入。
 */
export function mergeForeignBranch(home: string, taskId: string, by = "owner"): MergeResult {
  const store = loadForeignBranches(home);
  const rec = store.branches.find((b) => b.task_id === taskId);
  if (!rec) throw new ForeignBranchError(`没有这个外来分支任务：${taskId}`);
  if (rec.status !== "open") throw new ForeignBranchError(`外来分支 ${taskId} 已是 ${rec.status} 状态，不能再合入`);
  const merged = spawnSync("git", ["merge", "--no-ff", rec.branch, "-m", `合入外来任务 ${taskId}（${rec.peer}）`], {
    cwd: rec.workdir, encoding: "utf-8", windowsHide: true,
  });
  const output = `${merged.stdout ?? ""}${merged.stderr ?? ""}`.trim().slice(0, 1000);
  if (merged.status !== 0) {
    // 冲突时 git 可能已进入合并中状态：中止它，保持工作区干净，分支保持 open。
    spawnSync("git", ["merge", "--abort"], { cwd: rec.workdir, windowsHide: true });
    return { ok: false, output: output || "合并失败（未知原因）" };
  }
  removeWorktreeAndBranch(rec.workdir, rec.worktree, rec.branch);
  rec.status = "merged";
  rec.decided_at = nowIso();
  rec.decided_by = by;
  saveForeignBranches(home, store);
  recordBranchEvent(home, "foreign_branch_merged", { task_id: taskId, peer: rec.peer, branch: rec.branch });
  return { ok: true, output: output || "已合入" };
}

/**
 * 丢弃外来分支（机主操作，须 --yes，CLI 层拦）：删 worktree + 删分支 +
 * 标 dropped。改动直接丢掉，不进主工作区。
 */
export function dropForeignBranch(home: string, taskId: string, by = "owner", note?: string): ForeignBranch {
  const store = loadForeignBranches(home);
  const rec = store.branches.find((b) => b.task_id === taskId);
  if (!rec) throw new ForeignBranchError(`没有这个外来分支任务：${taskId}`);
  if (rec.status !== "open") throw new ForeignBranchError(`外来分支 ${taskId} 已是 ${rec.status} 状态，不能再丢弃`);
  removeWorktreeAndBranch(rec.workdir, rec.worktree, rec.branch);
  rec.status = "dropped";
  rec.decided_at = nowIso();
  rec.decided_by = by;
  rec.note = note ?? null;
  saveForeignBranches(home, store);
  recordBranchEvent(home, "foreign_branch_dropped", { task_id: taskId, peer: rec.peer, branch: rec.branch });
  return rec;
}
