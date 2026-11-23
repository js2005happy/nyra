// src/taskOrg.ts — 任务的组织归属账本（缺口 49 第二批：租户隔离）。
//
// 任务本身是 RunStore 里的运行（src/tasks.ts 的 addTask 建）；组织归属
// 只是执行时的隔离标记，按 run_id 记：~/.nyra/task-orgs.json（原子写
// 0600，只记 run_id 与 org_id 两个字段，不记任务原文）。
//
// 为什么不用 RunState 加字段：RunState 的字段要在 validate allowed 集、
// create() 状态字面量、update() mutable 集三处同步加，改动面大；组织归属
// 只是隔离时的路由标记，单列一本小账本更稳——与任务来源账本
// （taskOrigin.ts，G-P1-10）同款做法。账本丢了也不致命：读不到时按
// “无组织归属”（全局任务）处理；但 addTask 传了 orgId 时一定会写，写
// 失败直接让派发报错，不静默把组织任务当全局任务跑。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export const TASK_ORGS_FILE = "task-orgs.json";
export const TASK_ORGS_MAX_ENTRIES = 500;

export interface TaskOrgStore {
  version: 1;
  orgs: Record<string, string>;
}

export class TaskOrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskOrgError";
  }
}

export function taskOrgsPath(home: string | null | undefined): string {
  return join(resolveNyraHome(home ?? undefined), TASK_ORGS_FILE);
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

function loadTaskOrgs(home: string | null | undefined): TaskOrgStore {
  const path = taskOrgsPath(home);
  if (!existsSync(path)) return { version: 1, orgs: {} };
  if (lstatSync(path).isSymbolicLink()) throw new TaskOrgError("任务组织账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new TaskOrgError("任务组织账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as TaskOrgStore).version !== 1 ||
    !(raw as TaskOrgStore).orgs || typeof (raw as TaskOrgStore).orgs !== "object") {
    backupCorrupt(path);
    throw new TaskOrgError("任务组织账本格式无效，已备份");
  }
  return raw as TaskOrgStore;
}

function saveTaskOrgs(home: string | null | undefined, store: TaskOrgStore): void {
  const path = taskOrgsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TaskOrgError("任务组织账本不能是符号链接");
  const tmp = join(dirname(path), `.task-orgs-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

/** 记一次任务的组织归属（run_id → org_id）。条目超过上限时删最旧的。 */
export function markTaskOrg(home: string | null | undefined, runId: string, orgId: string): void {
  const store = loadTaskOrgs(home);
  store.orgs[runId] = orgId;
  const keys = Object.keys(store.orgs);
  if (keys.length > TASK_ORGS_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - TASK_ORGS_MAX_ENTRIES)) delete store.orgs[k];
  }
  saveTaskOrgs(home, store);
}

/** 读一次任务的组织归属：没记过返回 null（调用方按全局任务处理）。账本损坏时同样返回 null，不拦读取。 */
export function readTaskOrg(home: string | null | undefined, runId: string): string | null {
  try {
    const store = loadTaskOrgs(home);
    return store.orgs[runId] ?? null;
  } catch {
    return null;
  }
}

/** 列出某个组织全部有归属的任务 run_id（账本损坏时为空数组）。 */
export function listTaskIdsByOrg(home: string | null | undefined, orgId: string): string[] {
  try {
    const store = loadTaskOrgs(home);
    return Object.entries(store.orgs).filter(([, o]) => o === orgId).map(([runId]) => runId);
  } catch {
    return [];
  }
}
