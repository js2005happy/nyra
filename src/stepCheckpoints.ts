// src/stepCheckpoints.ts — G-P1-40 步级持久化 + 时间旅行（LangGraph
// checkpoint / MAF WorkflowCheckpoint 借鉴，只借想法不抄代码）。
//
// 旧检查点（src/checkpoints.ts）是“写文件前的快照”：改文件前存一份原内容，
// /undo、/rewind 靠它回滚文件。本模块是另一层——“跑步骤时的状态快照”：
// 工作流每跑完一个步骤，记一条检查点（步骤 id、序号、当时 scope 的状态、
// 输入指纹、输出摘要、花费），不记文件原文、不记密钥。两层不混用、
// 不互相覆盖：文件快照管文件，步级检查点管状态。
//
// 三件事：
//   1. get_state / get_state_history：最新状态 / 全部历史；
//   2. update_state：回到某一步改个值（只改步骤输出），后续检查点标记作废；
//   3. time-travel：从任意检查点重放后续步骤（只 fixed 形态；调模型 /
//      花钱的步骤重放前须机主确认，或先 --dry-run 看计划）。
//
// Store 可插拔三档（内存 / 文件 / 远端 HTTP），默认文件。远端只有接口 +
// 本地回环验证，没有真云端部署。叶模块，只引 node 内置；
// workflow.ts 静态 import 本模块（recordNode 里每节点记一条），
// 本模块绝不反向 import workflow.ts / runs.ts（循环导入是红线）。
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { loadConfig } from "./config.ts";

export class StepCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepCheckpointError";
  }
}

/** 状态是扁平记录：键是 `steps.<步骤 id>.output` / `steps.<步骤 id>.ok`，值只认标量。 */
export type StepCheckpointState = Record<string, string | number | boolean | null>;

/** 一条步级检查点：某一步跑完那一刻的状态快照。 */
export interface StepCheckpoint {
  version: 1;
  runId: string;
  workflow: string;
  /** 节点 id：普通步骤就是步骤 id，for_each 轮次是 `步骤 id[i]`。 */
  stepId: string;
  /** 该步骤在定义里的序号（for_each 轮次记所属步骤的序号）。 */
  stepIndex: number;
  status: "ok" | "skipped" | "failed";
  state: StepCheckpointState;
  /** 渲染后节点输入的 SHA-256（只认指纹，不存输入原文）。 */
  inputFingerprint: string;
  /** 节点输出摘要（前 500 字），不是全文。 */
  outputSummary: string;
  spentUsd: number | null;
  createdAt: string;
  /** 被 update_state 作废：后续检查点的状态是按旧值算出来的，不能再信。 */
  invalidated: boolean;
  invalidatedReason: string | null;
}

export type StepCheckpointBackend = "memory" | "file" | "remote";

/** 检查点 store：内存 / 文件是同步读写；远端只走异步 load/save。 */
export interface StepCheckpointStore {
  readonly kind: StepCheckpointBackend;
  /** 同步读（memory/file 有；remote 没有——远端读写必须 await）。 */
  loadSync?(runId: string): StepCheckpoint[];
  /** 同步写（memory/file 有；remote 没有）。 */
  saveSync?(runId: string, checkpoints: StepCheckpoint[]): void;
  load(runId: string): Promise<StepCheckpoint[]>;
  save(runId: string, checkpoints: StepCheckpoint[]): Promise<void>;
}

export const STEP_CHECKPOINT_DIR = "step-checkpoints";
/** 状态最多记 32 个步骤（每步 output + ok 两键，上限 64 键）。 */
export const MAX_STATE_STEPS = 32;
export const MAX_STATE_KEYS = 64;
export const MAX_STATE_VALUE_CHARS = 1000;
export const MAX_OUTPUT_SUMMARY_CHARS = 500;
export const MAX_CHECKPOINTS_PER_RUN = 500;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,31}(\[\d+\])?$/;
const STATE_KEY_RE = /^steps\.[a-z][a-z0-9_-]{0,31}(\[\d+\])?\.(output|ok)$/;

export function stepCheckpointDir(home: string): string {
  return join(home, STEP_CHECKPOINT_DIR);
}

export function stepCheckpointFilePath(home: string, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new StepCheckpointError(`运行 id 不合法：${runId}`);
  return join(stepCheckpointDir(home), `${runId}.json`);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const dest = `${path}.corrupt-${stamp}`;
    const data = readFileSync(path);
    writeFileSync(dest, data);
    try { chmodSync(dest, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
  } catch { /* 备份失败不破坏原报错 */ }
}

function assertNotSymlink(path: string, what: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new StepCheckpointError(`${what}不能是符号链接：${path}`);
  }
}

function atomicWrite0600(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  assertNotSymlink(path, "检查点文件");
  const tmp = join(dirname(path), `.step-checkpoints-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, payload, "utf-8");
  try { chmodSync(tmp, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* 已改名 */ }
}

function parseCheckpoints(raw: string, path: string): StepCheckpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupCorrupt(path);
    throw new StepCheckpointError("步级检查点文件损坏，已备份，请检查后恢复");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { checkpoints?: unknown }).checkpoints)) {
    backupCorrupt(path);
    throw new StepCheckpointError("步级检查点文件格式无效，已备份");
  }
  const list = (parsed as { checkpoints: StepCheckpoint[] }).checkpoints;
  for (const cp of list) {
    if (!cp || typeof cp !== "object" || cp.version !== 1 || typeof cp.stepId !== "string" ||
      typeof cp.stepIndex !== "number" || !cp.state || typeof cp.state !== "object") {
      backupCorrupt(path);
      throw new StepCheckpointError("步级检查点文件里有坏记录，已备份");
    }
  }
  return list;
}

/** 内存 store：进程内 Map，只在同进程内有效（测试与临时跑用；跨进程请用文件）。
 *  同一 home 在同一进程内共享一个实例（见 memoryStoresByHome）。 */
const memoryStoresByHome = new Map<string, StepCheckpointStore>();

export function createMemoryStepCheckpointStore(): StepCheckpointStore {
  const data = new Map<string, StepCheckpoint[]>();
  return {
    kind: "memory",
    loadSync(runId: string): StepCheckpoint[] {
      return structuredClone(data.get(runId) ?? []);
    },
    saveSync(runId: string, checkpoints: StepCheckpoint[]): void {
      data.set(runId, structuredClone(checkpoints));
    },
    async load(runId: string): Promise<StepCheckpoint[]> {
      return structuredClone(data.get(runId) ?? []);
    },
    async save(runId: string, checkpoints: StepCheckpoint[]): Promise<void> {
      data.set(runId, structuredClone(checkpoints));
    },
  };
}

/** 文件 store：每个运行一个文件 `~/.nyra/step-checkpoints/<运行 id>.json`（0600 原子写）。 */
export function createFileStepCheckpointStore(home: string): StepCheckpointStore {
  return {
    kind: "file",
    loadSync(runId: string): StepCheckpoint[] {
      const path = stepCheckpointFilePath(home, runId);
      if (!existsSync(path)) return [];
      assertNotSymlink(path, "检查点文件");
      return parseCheckpoints(readFileSync(path, "utf-8"), path);
    },
    saveSync(runId: string, checkpoints: StepCheckpoint[]): void {
      const path = stepCheckpointFilePath(home, runId);
      atomicWrite0600(path, JSON.stringify({ version: 1, runId, checkpoints }, null, 2));
    },
    async load(runId: string): Promise<StepCheckpoint[]> {
      const path = stepCheckpointFilePath(home, runId);
      if (!existsSync(path)) return [];
      assertNotSymlink(path, "检查点文件");
      return parseCheckpoints(readFileSync(path, "utf-8"), path);
    },
    async save(runId: string, checkpoints: StepCheckpoint[]): Promise<void> {
      const path = stepCheckpointFilePath(home, runId);
      atomicWrite0600(path, JSON.stringify({ version: 1, runId, checkpoints }, null, 2));
    },
  };
}

export type StepCheckpointFetch = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** 远端 store：HTTP 接口，没有真云端部署——baseUrl 只认配置/环境变量。
 *  协议：GET {base}/runs/{runId}/checkpoints → `{ checkpoints: [...] }`（也认裸数组）；
 *  PUT 同路径 body `{ checkpoints }`，2xx 才算成功。凭据只读环境变量
 *  NYRA_STEP_CHECKPOINT_TOKEN（Authorization: Bearer，绝不落盘、不进日志）。 */
export function createRemoteStepCheckpointStore(
  baseUrl: string,
  opts?: { token?: string; fetchFn?: StepCheckpointFetch },
): StepCheckpointStore {
  const base = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new StepCheckpointError(`远端检查点地址须是 http(s):// 开头：${baseUrl}`);
  const token = opts?.token ?? process.env.NYRA_STEP_CHECKPOINT_TOKEN ?? "";
  const doFetch: StepCheckpointFetch = opts?.fetchFn ?? (async (url, init) => {
    const res = await fetch(url, init as RequestInit);
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.json() as Promise<unknown>,
      text: async () => res.text(),
    };
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const urlFor = (runId: string): string => {
    if (!RUN_ID_RE.test(runId)) throw new StepCheckpointError(`运行 id 不合法：${runId}`);
    return `${base}/runs/${encodeURIComponent(runId)}/checkpoints`;
  };
  return {
    kind: "remote",
    async load(runId: string): Promise<StepCheckpoint[]> {
      let res;
      try {
        res = await doFetch(urlFor(runId), { method: "GET", headers });
      } catch (err: unknown) {
        throw new StepCheckpointError(`远端检查点读失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new StepCheckpointError(`远端检查点读失败：HTTP ${res.status}`);
      const body = await res.json() as unknown;
      const list = Array.isArray(body) ? body : (body as { checkpoints?: unknown }).checkpoints;
      if (!Array.isArray(list)) throw new StepCheckpointError("远端检查点返回格式不对（要 { checkpoints: [...] } 或裸数组）");
      return list as StepCheckpoint[];
    },
    async save(runId: string, checkpoints: StepCheckpoint[]): Promise<void> {
      let res;
      try {
        res = await doFetch(urlFor(runId), {
          method: "PUT",
          headers,
          body: JSON.stringify({ checkpoints }),
        });
      } catch (err: unknown) {
        throw new StepCheckpointError(`远端检查点写失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new StepCheckpointError(`远端检查点写失败：HTTP ${res.status}`);
    },
  };
}

/** 后端解析：显式 opts > 环境变量 > config.json > 默认 file。 */
export function resolveStepCheckpointStore(
  home: string,
  opts?: {
    backend?: StepCheckpointBackend;
    remoteUrl?: string;
    config?: Record<string, unknown>;
    fetchFn?: StepCheckpointFetch;
  },
): StepCheckpointStore {
  const cfg = opts?.config ?? loadConfig(home);
  const envBackend = (process.env.NYRA_STEP_CHECKPOINT_STORE ?? "").trim().toLowerCase();
  const cfgBackend = typeof cfg.step_checkpoint_store === "string" ? cfg.step_checkpoint_store.trim().toLowerCase() : "";
  const backend = (opts?.backend ?? (envBackend || cfgBackend || "file")) as string;
  if (backend !== "memory" && backend !== "file" && backend !== "remote") {
    throw new StepCheckpointError(`检查点后端不认 ${backend}（只认 memory / file / remote）`);
  }
  if (backend === "memory") {
    // 同一进程内按 home 共享一个内存 store：`nyra workflow run` 与
    // `nyra checkpoint list` 是两次 CLI 调用、同一进程内先后发生时
    // （测试、脚本）须看到同一份检查点；跨进程本来就不共享。
    let shared = memoryStoresByHome.get(home);
    if (!shared) {
      shared = createMemoryStepCheckpointStore();
      memoryStoresByHome.set(home, shared);
    }
    return shared;
  }
  if (backend === "file") return createFileStepCheckpointStore(home);
  const remoteUrl = opts?.remoteUrl
    ?? (process.env.NYRA_STEP_CHECKPOINT_REMOTE_URL ?? "").trim()
    ?? (typeof cfg.step_checkpoint_remote_url === "string" ? cfg.step_checkpoint_remote_url.trim() : "");
  if (!remoteUrl) {
    throw new StepCheckpointError("远端检查点后端须配地址：config.json 的 step_checkpoint_remote_url，或环境变量 NYRA_STEP_CHECKPOINT_REMOTE_URL");
  }
  return createRemoteStepCheckpointStore(remoteUrl, { fetchFn: opts?.fetchFn });
}

export function describeStepCheckpointStore(home: string, config?: Record<string, unknown>): {
  backend: StepCheckpointBackend;
  remoteUrl: string | null;
  tokenConfigured: boolean;
} {
  const cfg = config ?? loadConfig(home);
  const envBackend = (process.env.NYRA_STEP_CHECKPOINT_STORE ?? "").trim().toLowerCase();
  const cfgBackend = typeof cfg.step_checkpoint_store === "string" ? cfg.step_checkpoint_store.trim().toLowerCase() : "";
  const backend = ((envBackend || cfgBackend || "file") as StepCheckpointBackend);
  const remoteUrl = (process.env.NYRA_STEP_CHECKPOINT_REMOTE_URL ?? "").trim()
    || (typeof cfg.step_checkpoint_remote_url === "string" ? cfg.step_checkpoint_remote_url.trim() : "")
    || null;
  return { backend, remoteUrl, tokenConfigured: Boolean(process.env.NYRA_STEP_CHECKPOINT_TOKEN) };
}

/** 从 scope.steps 快照状态：每步记 output（前 500 字）与 ok，只留最近 32 步。 */
export function snapshotStepsState(
  scopeSteps: Record<string, { output?: unknown; ok?: unknown }>,
): StepCheckpointState {
  const ids = Object.keys(scopeSteps).slice(-MAX_STATE_STEPS);
  const state: StepCheckpointState = {};
  for (const id of ids) {
    const entry = scopeSteps[id];
    const out = typeof entry.output === "string" ? entry.output : "";
    state[`steps.${id}.output`] = out.slice(0, MAX_OUTPUT_SUMMARY_CHARS);
    state[`steps.${id}.ok`] = entry.ok === true;
  }
  return state;
}

export interface StepNodeSnapshot {
  id: string;
  type: string;
  status: "ok" | "skipped" | "failed";
  input: string | null;
  output: string | null;
  spentUsd: number | null;
}

/** 由一条节点结果建检查点（纯函数；recordNode 里每节点调一次）。 */
export function buildStepCheckpoint(args: {
  runId: string;
  workflow: string;
  node: StepNodeSnapshot;
  stepIndex: number;
  stepsState: StepCheckpointState;
}): StepCheckpoint {
  const { runId, workflow, node, stepIndex, stepsState } = args;
  if (!NODE_ID_RE.test(node.id)) throw new StepCheckpointError(`节点 id 不合法：${node.id}`);
  return {
    version: 1,
    runId,
    workflow,
    stepId: node.id,
    stepIndex,
    status: node.status,
    state: { ...stepsState },
    inputFingerprint: sha256Hex(node.input ?? ""),
    outputSummary: (node.output ?? "").slice(0, MAX_OUTPUT_SUMMARY_CHARS),
    spentUsd: node.spentUsd,
    createdAt: nowIso(),
    invalidated: false,
    invalidatedReason: null,
  };
}

/** 同一步的检查点只留最新一条（重跑同一节点会再记一条，旧的让位）；超过上限丢最旧的。 */
export function upsertCheckpoint(list: StepCheckpoint[], cp: StepCheckpoint): StepCheckpoint[] {
  const next = list.filter((c) => c.stepId !== cp.stepId);
  next.push(cp);
  next.sort((a, b) => (a.stepIndex - b.stepIndex) || a.createdAt.localeCompare(b.createdAt));
  return next.slice(-MAX_CHECKPOINTS_PER_RUN);
}

/** 找一步的检查点：先精确匹配节点 id（`步骤[i]`），再按步骤 id 取最后一轮。 */
export function resolveCheckpointStep(list: StepCheckpoint[], stepId: string): StepCheckpoint | null {
  const exact = list.find((c) => c.stepId === stepId);
  if (exact) return exact;
  const prefixed = list.filter((c) => c.stepId === stepId || c.stepId.startsWith(`${stepId}[`));
  if (!prefixed.length) return null;
  return prefixed[prefixed.length - 1];
}

/** get_state：最新一条未作废检查点的状态。 */
export async function getStepState(
  store: StepCheckpointStore,
  runId: string,
): Promise<{ stepId: string; stepIndex: number; state: StepCheckpointState }> {
  const list = await store.load(runId);
  const live = list.filter((c) => !c.invalidated);
  if (!live.length) throw new StepCheckpointError(`运行 ${runId} 没有可用的步级检查点（还没跑过步骤，或全被作废了）`);
  const latest = live[live.length - 1];
  return { stepId: latest.stepId, stepIndex: latest.stepIndex, state: { ...latest.state } };
}

/** get_state_history：全部检查点（新的在后，作废的也列出来、标明）。 */
export async function getStepStateHistory(store: StepCheckpointStore, runId: string): Promise<StepCheckpoint[]> {
  return store.load(runId);
}

function validateStatePatch(patch: Record<string, unknown>): StepCheckpointState {
  const keys = Object.keys(patch);
  if (!keys.length) throw new StepCheckpointError("update_state 至少要改一个值（--set 键=值）");
  if (keys.length > MAX_STATE_KEYS) throw new StepCheckpointError(`一次最多改 ${MAX_STATE_KEYS} 个值，给了 ${keys.length} 个`);
  const out: StepCheckpointState = {};
  for (const key of keys) {
    if (!STATE_KEY_RE.test(key)) {
      throw new StepCheckpointError(`状态键不认 ${key}（只认 steps.<步骤 id>.output / steps.<步骤 id>.ok，改的是某一步的输出）`);
    }
    const value = patch[key];
    if (key.endsWith(".output")) {
      if (typeof value !== "string") throw new StepCheckpointError(`状态键 ${key} 只认字符串值`);
      if (value.length > MAX_STATE_VALUE_CHARS) {
        throw new StepCheckpointError(`状态值太长（${value.length} 字，上限 ${MAX_STATE_VALUE_CHARS} 字）`);
      }
      out[key] = value;
    } else {
      if (typeof value !== "boolean") throw new StepCheckpointError(`状态键 ${key} 只认 true/false`);
      out[key] = value;
    }
  }
  return out;
}

/** update_state：回到某一步改值；改完那一步之后的所有检查点标记作废。 */
export async function updateStepState(
  store: StepCheckpointStore,
  runId: string,
  stepId: string,
  patch: Record<string, unknown>,
  unsetKeys?: string[],
): Promise<{ checkpoint: StepCheckpoint; invalidatedCount: number }> {
  const clean = Object.keys(patch).length ? validateStatePatch(patch) : {};
  const unsets = unsetKeys ?? [];
  for (const key of unsets) {
    if (!STATE_KEY_RE.test(key)) throw new StepCheckpointError(`状态键不认 ${key}（只认 steps.<步骤 id>.output / steps.<步骤 id>.ok）`);
  }
  const list = await store.load(runId);
  const target = resolveCheckpointStep(list, stepId);
  if (!target) throw new StepCheckpointError(`运行 ${runId} 里没有步骤 ${stepId} 的检查点`);
  if (target.invalidated) {
    throw new StepCheckpointError(`步骤 ${stepId} 的检查点已被作废（之前有人改过更早一步的状态），请从最新的检查点重放`);
  }
  const merged: StepCheckpointState = { ...target.state, ...clean };
  for (const key of unsets) delete merged[key];
  if (Object.keys(merged).length > MAX_STATE_KEYS) {
    throw new StepCheckpointError(`改完状态共 ${Object.keys(merged).length} 个键，超过上限 ${MAX_STATE_KEYS} 个`);
  }
  target.state = merged;
  let invalidatedCount = 0;
  for (const cp of list) {
    if (cp === target) continue;
    if (cp.stepIndex > target.stepIndex && !cp.invalidated) {
      cp.invalidated = true;
      cp.invalidatedReason = `状态在 ${target.stepId} 被改，后续检查点已作废`;
      invalidatedCount++;
    }
  }
  await store.save(runId, list);
  return { checkpoint: target, invalidatedCount };
}

export type ReplayStepKind = "deterministic" | "costed" | "approval";

export interface ReplayStepPlan {
  id: string;
  type: string;
  kind: ReplayStepKind;
  index: number;
}

export interface ReplayPlan {
  supported: boolean;
  reason: string | null;
  fromStepId: string;
  fromNodeId: string;
  nextIndex: number;
  steps: ReplayStepPlan[];
  needsConfirmation: boolean;
}

export function classifyStepKind(type: string): ReplayStepKind {
  if (type === "tool" || type === "knowledge") return "deterministic";
  if (type === "approve") return "approval";
  return "costed";
}

function flattenStepKinds(
  steps: Array<{ id: string; type: string; branches?: Array<Array<{ id: string; type: string }>> }>,
): ReplayStepKind {
  let kind: ReplayStepKind = "deterministic";
  for (const s of steps) {
    if (s.type === "parallel" && s.branches) {
      for (const branch of s.branches) {
        const leaf = flattenStepKinds(branch as Array<{ id: string; type: string; branches?: Array<Array<{ id: string; type: string }>> }>);
        if (leaf === "approval") return "approval";
        if (leaf === "costed") kind = "costed";
      }
      continue;
    }
    const k = classifyStepKind(s.type);
    if (k === "approval") return "approval";
    if (k === "costed") kind = "costed";
  }
  return kind;
}

export interface ReplayDefinition {
  mode: string;
  steps: Array<{
    id: string;
    type: string;
    branches?: Array<Array<{ id: string; type: string; branches?: Array<Array<{ id: string; type: string }>> }>>;
  }>;
}

/** 重放计划（纯函数）：从哪一步重放、后面还有哪几步、哪几步要花钱/要人批。 */
export function planReplay(
  def: ReplayDefinition,
  checkpoints: StepCheckpoint[],
  stepId: string,
): ReplayPlan {
  if (def.mode !== "fixed") {
    return {
      supported: false,
      reason: `只有 fixed 形态支持时间旅行重放，${def.mode} 形态的步骤由协调者每轮现定，没有固定的后续步骤可重放`,
      fromStepId: stepId,
      fromNodeId: stepId,
      nextIndex: -1,
      steps: [],
      needsConfirmation: false,
    };
  }
  const cp = resolveCheckpointStep(checkpoints, stepId);
  if (!cp) {
    throw new StepCheckpointError(`没有步骤 ${stepId} 的检查点（这个运行里没跑过这一步，或检查点已被清理）`);
  }
  if (cp.invalidated) {
    throw new StepCheckpointError(`步骤 ${stepId} 的检查点已被作废（之前有人改过更早一步的状态），请从最新的检查点重放`);
  }
  const baseStepId = cp.stepId.replace(/\[\d+\]$/, "");
  const idx = def.steps.findIndex((s) => s.id === baseStepId);
  if (idx < 0) throw new StepCheckpointError(`步骤 ${baseStepId} 不在当前工作流定义里（定义改过，重放对不上）`);
  const steps: ReplayStepPlan[] = [];
  for (let i = idx + 1; i < def.steps.length; i++) {
    const s = def.steps[i];
    const kind = s.type === "parallel"
      ? flattenStepKinds(s.branches?.flat() ?? [])
      : classifyStepKind(s.type);
    steps.push({ id: s.id, type: s.type, kind, index: i });
  }
  return {
    supported: true,
    reason: null,
    fromStepId: baseStepId,
    fromNodeId: cp.stepId,
    nextIndex: idx + 1,
    steps,
    needsConfirmation: steps.some((s) => s.kind !== "deterministic"),
  };
}
