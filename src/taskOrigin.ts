// src/taskOrigin.ts — 任务来源账本（G-P1-10 的落点之一）。
//
// 对外 MCP 服务 dispatch_task 派来的任务先进队列、后由 worker 跑；
// 来源（peer/local）要熬过队列，不能只留在内存里。本账本按 run_id
// 记来源：~/.nyra/task-origins.json（原子写 0600，只记 run_id 与
// 来源两个字段，不记任务原文）。runOne 起 Agent 前读它，把 origin
// 交给 Agent，Agent 再交给 ToolContext——对方来源的任务在工具层
// 走提议门（写操作不直接执行，见 peerProposals.ts）。
//
// 为什么不用 RunState 加字段：RunState 的字段要在 validate allowed
// 集、create() 状态字面量、update() mutable 集三处同步加，改动面大；
// 来源只是执行时的路由标记，单列一本小账本更稳。账本丢了也不致命：
// 读不到时按 local 处理（本机发起的任务本来就是大多数），但 MCP
// 派发那一侧在 addTask 时一定会写，写失败直接让派发报错，不静默丢来源。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import type { TaskOrigin } from "./contentLabels.ts";

export const TASK_ORIGINS_FILE = "task-origins.json";
export const TASK_ORIGINS_MAX_ENTRIES = 500;

export interface TaskOriginStore {
  version: 1;
  origins: Record<string, TaskOrigin>;
}

export class TaskOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskOriginError";
  }
}

export function taskOriginsPath(home: string | null | undefined): string {
  return join(resolveNyraHome(home ?? undefined), TASK_ORIGINS_FILE);
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

function loadTaskOrigins(home: string | null | undefined): TaskOriginStore {
  const path = taskOriginsPath(home);
  if (!existsSync(path)) return { version: 1, origins: {} };
  if (lstatSync(path).isSymbolicLink()) throw new TaskOriginError("任务来源账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new TaskOriginError("任务来源账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as TaskOriginStore).version !== 1 ||
    !((raw as TaskOriginStore).origins) || typeof (raw as TaskOriginStore).origins !== "object") {
    backupCorrupt(path);
    throw new TaskOriginError("任务来源账本格式无效，已备份");
  }
  return raw as TaskOriginStore;
}

function saveTaskOrigins(home: string | null | undefined, store: TaskOriginStore): void {
  const path = taskOriginsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TaskOriginError("任务来源账本不能是符号链接");
  const tmp = join(dirname(path), `.task-origins-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

/** 记一次任务的来源（run_id → origin）。条目超过上限时删最旧的。 */
export function markTaskOrigin(home: string | null | undefined, runId: string, origin: TaskOrigin): void {
  const store = loadTaskOrigins(home);
  store.origins[runId] = origin;
  const keys = Object.keys(store.origins);
  if (keys.length > TASK_ORIGINS_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - TASK_ORIGINS_MAX_ENTRIES)) delete store.origins[k];
  }
  saveTaskOrigins(home, store);
}

/** 读一次任务的来源：没记过返回 null（调用方按 local 处理）。 */
export function readTaskOrigin(home: string | null | undefined, runId: string): TaskOrigin | null {
  try {
    const store = loadTaskOrigins(home);
    return store.origins[runId] ?? null;
  } catch {
    return null;
  }
}
