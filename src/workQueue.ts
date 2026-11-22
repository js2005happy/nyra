// src/workQueue.ts — 第 3 批 G-P1-13：队列驱动底座（借 Turnstone
// 的“队列驱动 agent”形态：任务先进队列、节点认领、租约保护，
// 认领后崩了能重派，但绝不重复执行）。
//
// - 任务账本 `work-queue.json`：任务 id + 路由 key + 载荷摘要
//   （只记载荷的 SHA-256 前 12 位，不记原文——队列里不留敏感内容）
//   + 状态（queued/claimed/completed/failed）+ 认领节点 + 租约
//   到期 + 纪元 + 幂等键；
// - 幂等键：同一幂等键只进一条任务，重复提交直接回已有的那条
//   （不重复派）；
// - 认领：按 HRW 路由到节点（rendezvous.ts），认领即上租约
//   （默认 60 秒）；租约内别人抢不走；租约过期未完成才可重派；
// - 完成：只有认领的节点能完成（节点 id + 租约令牌都对得上），
//   完成即终态，不可改；
// - 纪元：派发时记当时 Rendezvous 纪元；节点账本变更（节点增减、
//   状态变）后纪元变了，旧纪元的认领作废——重连/改派后旧指令
//   不重复执行；
// - 失败重试：failed 的任务可重回 queued（重试次数 +1，封顶 3 次），
//   超了就留在 failed，不无限重试。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { rendezvousEpoch, routeKey } from "./rendezvous.ts";

export const WORK_QUEUE_FILE = "work-queue.json";
export const WORK_QUEUE_DEFAULT_LEASE_MS = 60_000;
export const WORK_QUEUE_MAX_RETRIES = 3;

export type WorkTaskStatus = "queued" | "claimed" | "completed" | "failed";

export class WorkQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkQueueError";
  }
}

export interface WorkTask {
  id: string;
  key: string;
  /** 载荷摘要（SHA-256 前 12 位），队列里不留敏感原文。 */
  payload_hash: string;
  /** 幂等键：同一键只进一条任务。 */
  idempotency_key: string;
  status: WorkTaskStatus;
  node: string | null;
  lease_token: string | null;
  lease_until: string | null;
  /** 派发时记的 Rendezvous 纪元；纪元变了认领作废。 */
  epoch: number;
  retries: number;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface WorkQueueStore {
  version: 1;
  tasks: WorkTask[];
}

export function workQueuePath(home: string): string {
  return join(resolveNyraHome(home), WORK_QUEUE_FILE);
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadWorkQueue(home: string): WorkQueueStore {
  const path = workQueuePath(home);
  if (!existsSync(path)) return { version: 1, tasks: [] };
  if (lstatSync(path).isSymbolicLink()) throw new WorkQueueError("任务队列账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new WorkQueueError("任务队列账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as WorkQueueStore).version !== 1 ||
    !Array.isArray((raw as WorkQueueStore).tasks)) {
    backupCorrupt(path);
    throw new WorkQueueError("任务队列账本格式无效，已备份");
  }
  return raw as WorkQueueStore;
}

export function saveWorkQueue(home: string, store: WorkQueueStore): void {
  const path = workQueuePath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new WorkQueueError("任务队列账本不能是符号链接");
  const tmp = join(dirname(path), `.work-queue-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordQueueEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`任务队列：${type}`, "work-queue", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏队列本身 */ }
}

function newTaskId(): string {
  return `wq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newLeaseToken(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16);
}

/**
 * 入队：同一幂等键只进一条，重复提交直接回已有的那条（不重复派）。
 * 路由 key 为空时不入队（没 key 没法路由）。
 */
export function enqueueTask(home: string, key: string, payload: string, idempotencyKey?: string): WorkTask {
  if (!key.trim()) throw new WorkQueueError("入队须给路由 key（没 key 没法路由到节点）");
  const store = loadWorkQueue(home);
  const idem = idempotencyKey ?? `idem-${createHash("sha256").update(`${key}\0${payload}`, "utf-8").digest("hex").slice(0, 12)}`;
  const existing = store.tasks.find((t) => t.idempotency_key === idem && t.status !== "failed");
  if (existing) return existing;
  const task: WorkTask = {
    id: newTaskId(),
    key,
    payload_hash: createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 12),
    idempotency_key: idem,
    status: "queued",
    node: null,
    lease_token: null,
    lease_until: null,
    epoch: rendezvousEpoch(home),
    retries: 0,
    created_at: new Date().toISOString(),
    claimed_at: null,
    completed_at: null,
  };
  store.tasks.push(task);
  saveWorkQueue(home, store);
  recordQueueEvent(home, "work_task_enqueued", { task: task.id, key });
  return task;
}

export function getTask(home: string, id: string): WorkTask | null {
  return loadWorkQueue(home).tasks.find((t) => t.id === id) ?? null;
}

export function listTasks(home: string, status?: WorkTaskStatus): WorkTask[] {
  const tasks = loadWorkQueue(home).tasks;
  return status ? tasks.filter((t) => t.status === status) : tasks;
}

/**
 * 认领：HRW 路由到节点，认领即上租约（默认 60 秒）；已认领且租约
 * 未过期的任务别人抢不走；租约过期未完成的才可重派（重派换新
 * 租约令牌，旧令牌作废）；纪元变了（节点账本动过）的旧任务先
 * 重算路由，不按旧节点派。
 */
export function claimTask(
  home: string,
  id: string,
  opts: { leaseMs?: number; now?: () => number } = {},
): WorkTask {
  const leaseMs = opts.leaseMs ?? WORK_QUEUE_DEFAULT_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > 3_600_000) {
    throw new WorkQueueError("租约时长只能是 1ms–1 小时");
  }
  const now = opts.now ?? Date.now;
  const store = loadWorkQueue(home);
  const task = store.tasks.find((t) => t.id === id);
  if (!task) throw new WorkQueueError(`没有这个任务：${id}`);
  if (task.status === "completed") throw new WorkQueueError(`任务 ${id} 已完成，不可再认领`);
  if (task.status === "failed") throw new WorkQueueError(`任务 ${id} 已失败（重试已用完），不可再认领`);
  if (task.status === "claimed" && task.lease_until && new Date(task.lease_until).getTime() > now()) {
    throw new WorkQueueError(`任务 ${id} 已被 ${task.node ?? "某节点"} 认领，租约未过期（别人抢不走）`);
  }
  // 纪元变了：节点账本动过，旧路由作废，按当前账本重算。
  const epoch = rendezvousEpoch(home);
  const node = routeKey(home, task.key);
  if (task.epoch !== epoch) task.epoch = epoch;
  task.status = "claimed";
  task.node = node.id;
  task.lease_token = newLeaseToken();
  task.lease_until = new Date(now() + leaseMs).toISOString();
  task.claimed_at = new Date(now()).toISOString();
  saveWorkQueue(home, store);
  recordQueueEvent(home, "work_task_claimed", { task: id, node: node.id, epoch });
  return task;
}

/** 完成：只有认领的节点、凭当次租约令牌能完成；完成即终态。 */
export function completeTask(home: string, id: string, node: string, leaseToken: string): WorkTask {
  const store = loadWorkQueue(home);
  const task = store.tasks.find((t) => t.id === id);
  if (!task) throw new WorkQueueError(`没有这个任务：${id}`);
  if (task.status !== "claimed") throw new WorkQueueError(`任务 ${id} 现在是 ${task.status}，没被认领就不能完成`);
  if (task.node !== node || task.lease_token !== leaseToken) {
    throw new WorkQueueError(`任务 ${id} 不是你认领的（节点/租约令牌对不上），完成不了——重连后旧令牌作废`);
  }
  task.status = "completed";
  task.completed_at = new Date().toISOString();
  task.lease_token = null;
  task.lease_until = null;
  saveWorkQueue(home, store);
  recordQueueEvent(home, "work_task_completed", { task: id, node });
  return task;
}

/** 失败：认领节点凭租约令牌标失败；重试次数内可重回 queued，超了留在 failed。 */
export function failTask(home: string, id: string, node: string, leaseToken: string): WorkTask {
  const store = loadWorkQueue(home);
  const task = store.tasks.find((t) => t.id === id);
  if (!task) throw new WorkQueueError(`没有这个任务：${id}`);
  if (task.status !== "claimed") throw new WorkQueueError(`任务 ${id} 现在是 ${task.status}，没被认领就不能标失败`);
  if (task.node !== node || task.lease_token !== leaseToken) {
    throw new WorkQueueError(`任务 ${id} 不是你认领的（节点/租约令牌对不上），标不了失败`);
  }
  task.retries += 1;
  if (task.retries > WORK_QUEUE_MAX_RETRIES) {
    task.status = "failed";
  } else {
    task.status = "queued";
  }
  task.node = null;
  task.lease_token = null;
  task.lease_until = null;
  saveWorkQueue(home, store);
  recordQueueEvent(home, "work_task_failed", { task: id, node, retries: task.retries });
  return task;
}
