// src/rendezvous.ts — 第 3 批 G-P1-13：Rendezvous + 队列驱动底座
// （借 Turnstone 的形态：“Rendezvous 多节点路由、队列驱动 agent”——
// 只借“按一致性哈希把任务路由到节点、节点下线后任务自动改派”
// 的形态，不搬实现）。
//
// - 节点账本 `rendezvous.json`：节点 id + 端点 + 权重 + 状态
//   （active/drained/offline）；节点只认本机/局域网端点
//   （http://localhost / 127.0.0.1 / 10/172.16/192.168 段），
//   公网端点拒绝登记——本批不做跨公网路由；
// - 路由是纯函数 HRW（Highest Random Weight）：对（任务 key，节点）
//   算 SHA-256 权重，取最大者；权重 × 节点权重；节点增减时只有
//   该节点负责的 key 会改派（一致性哈希的最小扰动）；无节点时
//   拒绝路由，不静默本地执行；
// - 队列底座在 workQueue.ts：本文件只负责“去哪台节点”，
//   “怎么派、怎么不重复派”归队列。
// - 纪元：节点账本每次变更 epoch +1；队列派发时校验纪元，
//   旧纪元路由作废（见 workQueue.ts）。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";

export const RENDEZVOUS_FILE = "rendezvous.json";

export type RendezvousNodeStatus = "active" | "drained" | "offline";

export class RendezvousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendezvousError";
  }
}

export interface RendezvousNode {
  id: string;
  endpoint: string;
  weight: number;
  status: RendezvousNodeStatus;
  added_at: string;
}

export interface RendezvousStore {
  version: 1;
  epoch: number;
  nodes: RendezvousNode[];
}

export function rendezvousPath(home: string): string {
  return join(resolveNyraHome(home), RENDEZVOUS_FILE);
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadRendezvous(home: string): RendezvousStore {
  const path = rendezvousPath(home);
  if (!existsSync(path)) return { version: 1, epoch: 1, nodes: [] };
  if (lstatSync(path).isSymbolicLink()) throw new RendezvousError("Rendezvous 账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new RendezvousError("Rendezvous 账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as RendezvousStore).version !== 1 ||
    !Array.isArray((raw as RendezvousStore).nodes) ||
    typeof (raw as RendezvousStore).epoch !== "number") {
    backupCorrupt(path);
    throw new RendezvousError("Rendezvous 账本格式无效，已备份");
  }
  return raw as RendezvousStore;
}

export function saveRendezvous(home: string, store: RendezvousStore): void {
  const path = rendezvousPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new RendezvousError("Rendezvous 账本不能是符号链接");
  const tmp = join(dirname(path), `.rendezvous-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordRendezvousEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`Rendezvous：${type}`, "rendezvous", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏路由本身 */ }
}

/**
 * HRW 权重（纯函数，可单测）：SHA-256(key + "\0" + 节点 id) 取前
 * 8 字节当无符号整数，再 × 节点权重。取最大者即负责节点。
 */
export function hrwWeight(key: string, nodeId: string, nodeWeight: number): number {
  const digest = createHash("sha256").update(`${key}\0${nodeId}`, "utf-8").digest();
  const raw = digest.readBigUInt64BE(0);
  return Number(raw % 1_000_000_000n) * nodeWeight;
}

/** 只认本机/局域网端点：公网端点拒绝登记（本批不做跨公网路由）。 */
export function isLocalEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function registerNode(home: string, id: string, endpoint: string, weight = 1): RendezvousNode {
  if (!id.trim()) throw new RendezvousError("节点 id 不能为空");
  if (!isLocalEndpoint(endpoint)) {
    throw new RendezvousError(`只登记本机/局域网节点端点（localhost / 127.0.0.1 / 10/172.16/192.168），不接公网端点：${endpoint}`);
  }
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
    throw new RendezvousError("节点权重只能是 0–100 之间的数");
  }
  const store = loadRendezvous(home);
  const existing = store.nodes.find((n) => n.id === id);
  if (existing) {
    existing.endpoint = endpoint;
    existing.weight = weight;
    existing.status = "active";
    store.epoch += 1;
    saveRendezvous(home, store);
    return existing;
  }
  const node: RendezvousNode = {
    id, endpoint, weight, status: "active", added_at: new Date().toISOString(),
  };
  store.nodes.push(node);
  store.epoch += 1;
  saveRendezvous(home, store);
  recordRendezvousEvent(home, "rendezvous_node_registered", { node: id, endpoint });
  return node;
}

export function setNodeStatus(home: string, id: string, status: RendezvousNodeStatus): RendezvousNode {
  const store = loadRendezvous(home);
  const node = store.nodes.find((n) => n.id === id);
  if (!node) throw new RendezvousError(`没有这个节点：${id}`);
  node.status = status;
  store.epoch += 1;
  saveRendezvous(home, store);
  return node;
}

export function removeNode(home: string, id: string): boolean {
  const store = loadRendezvous(home);
  const idx = store.nodes.findIndex((n) => n.id === id);
  if (idx < 0) return false;
  store.nodes.splice(idx, 1);
  store.epoch += 1;
  saveRendezvous(home, store);
  return true;
}

export function listNodes(home: string): RendezvousNode[] {
  return loadRendezvous(home).nodes;
}

/**
 * 路由：HRW 取最大权重者；只在 active 节点里选；drained/offline
 * 的不接新任务。无 active 节点时拒绝路由（不静默本地执行）。
 */
export function routeKey(home: string, key: string): RendezvousNode {
  if (!key.trim()) throw new RendezvousError("路由 key 不能为空");
  const store = loadRendezvous(home);
  const active = store.nodes.filter((n) => n.status === "active");
  if (!active.length) {
    throw new RendezvousError("没有 active 节点，路由不了（不静默本地执行，先登记节点：nyra rendezvous register <id> <endpoint>）");
  }
  let best = active[0];
  let bestWeight = hrwWeight(key, best.id, best.weight);
  for (const node of active.slice(1)) {
    const w = hrwWeight(key, node.id, node.weight);
    if (w > bestWeight) { best = node; bestWeight = w; }
  }
  return best;
}

/** 当前纪元（队列派发时校验，旧纪元路由作废）。 */
export function rendezvousEpoch(home: string): number {
  return loadRendezvous(home).epoch;
}
