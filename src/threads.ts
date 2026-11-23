// src/threads.ts — G-P1-37：远端线程操作 API（LangGraph threads.py 借鉴，
// 相似 agent 缺口报告 §2）。LangGraph 的线程是一段可接着跑的会话：
// create / search / copy / prune / get_state / update_state / get_history，
// 外加 runs（线程上跑过的工作流）与 cron（create_for_thread：给线程绑
// 定时触发器，到点跑工作流、结果记回线程）。
//
// 本模块是叶模块，只引 node 内置：
//   - 线程账本 ~/.nyra/threads.json（0600 原子写，损坏先备份再抛错）；
//   - cron 匹配与触发总开关走 workflowTriggers（动态 import，不静态引，
//     免得把 workflow.ts 的求值链拉进来）；
//   - 执行走 runWorkflowByName（动态 import，runFn 可注入替身）；
//   - 触发记录进证据链 evidence/thread-crons/<日期>.jsonl，成功那次再把
//     thread_cron_fired 事件镜像进那次工作流运行的事件链（动态 import
//     runs.ts，tasks 目录优先、runs 次之，与 voiceCall 的 mirrorEvent 同款）。
//
// 安全闸：
//   - 线程 cron 只在触发器执行总开关开了时才跑（与 workflow triggers 同
//     一个开关，默认关），只跑 active 的工作流；
//   - 每轮最多跑 5 个（与 MAX_RUNS_PER_ROUND 同数）；同一分钟不重复跑；
//   - 复制线程只复制状态与历史，不复制运行记录与 cron（复制的 cron 会
//     让同一工作流一分钟跑两次）；
//   - state 只认标量值（string ≤ 1000 字、number、boolean、null），
//     history 摘要只记文字摘要、不记对话原文与绝对路径。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export class ThreadError extends Error {
  constructor(message: string) { super(message); this.name = "ThreadError"; }
}

export const THREADS_FILE = "threads.json";
export const MAX_THREADS = 500;
export const MAX_STATE_KEYS = 32;
export const MAX_STATE_STRING = 1000;
export const MAX_HISTORY = 200;
export const MAX_HISTORY_SUMMARY = 500;
export const MAX_RUNS = 100;
export const MAX_CRONS_PER_THREAD = 10;
export const MAX_TITLE = 100;
export const MAX_CRONS_PER_ROUND = 5;

export const THREAD_ID_RE = /^[0-9a-f]{16}$/;
const HISTORY_KIND_RE = /^[A-Za-z0-9._-]{1,40}$/;
const CRON_SHAPE_RE = /^[0-9*,/-]+$/;

export interface ThreadHistoryEntry {
  at: string;
  kind: string;
  summary: string;
}

export interface ThreadRunRecord {
  run_id: string;
  workflow?: string;
  status: "ok" | "failed" | "running";
  at: string;
}

export interface ThreadCron {
  id: string;
  cron: string;
  workflow: string;
  /** 上次触发的分钟（ISO，截到分钟），去重用。 */
  last_fired?: string;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "archived";
  state: Record<string, string | number | boolean | null>;
  history: ThreadHistoryEntry[];
  runs: ThreadRunRecord[];
  crons: ThreadCron[];
  created_at: string;
  updated_at: string;
}

export interface ThreadStoreData {
  version: 1;
  threads: Thread[];
}

export function threadsPath(home: string): string {
  return join(home, THREADS_FILE);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.threads-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
}

function emptyStore(): ThreadStoreData {
  return { version: 1, threads: [] };
}

export function loadThreads(home: string): ThreadStoreData {
  const p = threadsPath(home);
  if (!existsSync(p)) return emptyStore();
  if (lstatSync(p).isSymbolicLink()) throw new ThreadError("线程账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new ThreadError("线程账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as { version?: number }).version !== 1 || !Array.isArray((raw as { threads?: unknown }).threads)) {
    backupCorrupt(p);
    throw new ThreadError("线程账本格式无效，已备份");
  }
  const threads = (raw as ThreadStoreData).threads;
  for (const t of threads) {
    if (!t || typeof t !== "object" || !THREAD_ID_RE.test(t.id ?? "") || typeof t.title !== "string") {
      backupCorrupt(p);
      throw new ThreadError("线程账本格式无效，已备份");
    }
    t.status = t.status === "archived" ? "archived" : "active";
    t.state = t.state && typeof t.state === "object" && !Array.isArray(t.state) ? t.state : {};
    t.history = Array.isArray(t.history) ? t.history : [];
    t.runs = Array.isArray(t.runs) ? t.runs : [];
    t.crons = Array.isArray(t.crons) ? t.crons : [];
  }
  return { version: 1, threads };
}

export function saveThreads(home: string, data: ThreadStoreData): void {
  const p = threadsPath(home);
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new ThreadError("线程账本不能是符号链接");
  if (data.threads.length > MAX_THREADS) data.threads = data.threads.slice(0, MAX_THREADS);
  atomicWriteJson(p, data);
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function touch(t: Thread): void {
  t.updated_at = nowIso();
}

/** 对外清单：只给元数据，不给 state 与历史正文。 */
export function threadPublic(t: Thread): Record<string, unknown> {
  return {
    id: t.id, title: t.title, status: t.status,
    created_at: t.created_at, updated_at: t.updated_at,
    history_count: t.history.length, run_count: t.runs.length, cron_count: t.crons.length,
  };
}

export function createThread(home: string, title: string, opts?: { state?: Record<string, unknown>; sessionId?: string }): Thread {
  const cleanTitle = title.trim();
  if (!cleanTitle || cleanTitle.length > MAX_TITLE) throw new ThreadError("线程标题不能为空且不超过 100 字符");
  const data = loadThreads(home);
  if (data.threads.length >= MAX_THREADS) throw new ThreadError("线程已达上限（500），先删旧线程再建");
  const state = validateStatePatch(opts?.state ?? {}, {});
  const t: Thread = {
    id: newId(), title: cleanTitle, status: "active", state,
    history: [], runs: [], crons: [],
    created_at: nowIso(), updated_at: nowIso(),
  };
  if (opts?.sessionId) {
    t.history.push({ at: nowIso(), kind: "created", summary: `从会话建线程（会话 id ${opts.sessionId.slice(0, 12)}）` });
  }
  data.threads.unshift(t);
  saveThreads(home, data);
  return t;
}

export function getThread(home: string, id: string): Thread {
  if (!THREAD_ID_RE.test(id)) throw new ThreadError("线程 id 无效");
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  return t;
}

export function listThreads(home: string): Thread[] {
  return loadThreads(home).threads;
}

export function searchThreads(home: string, query: string, status?: "active" | "archived"): Thread[] {
  const q = query.trim().toLowerCase();
  return loadThreads(home).threads.filter((t) => {
    if (status && t.status !== status) return false;
    if (!q) return true;
    return t.title.toLowerCase().includes(q) || t.id.includes(q);
  });
}

/**
 * 复制一个线程接着跑：只复制状态与历史，不复制运行记录与 cron——
 * 复制的 cron 会让同一工作流一分钟跑两次，运行记录是原线程的执行账，
 * 复制过去会把账算乱。
 */
export function copyThread(home: string, id: string): Thread {
  const src = getThread(home, id);
  const data = loadThreads(home);
  if (data.threads.length >= MAX_THREADS) throw new ThreadError("线程已达上限（500），先删旧线程再建");
  const t: Thread = {
    id: newId(), title: `${src.title}（副本）`.slice(0, MAX_TITLE), status: "active",
    state: JSON.parse(JSON.stringify(src.state)) as Thread["state"],
    history: src.history.map((h) => ({ ...h })),
    runs: [], crons: [],
    created_at: nowIso(), updated_at: nowIso(),
  };
  t.history.push({ at: nowIso(), kind: "copied", summary: `从线程 ${src.id.slice(0, 8)} 复制` });
  if (t.history.length > MAX_HISTORY) t.history = t.history.slice(-MAX_HISTORY);
  data.threads.unshift(t);
  saveThreads(home, data);
  return t;
}

/** 剪掉旧历史：只留最近 keep 条，返回留下的条数与剪掉的条数。 */
export function pruneThread(home: string, id: string, keep = 50): { kept: number; dropped: number } {
  if (!Number.isInteger(keep) || keep < 0 || keep > MAX_HISTORY) throw new ThreadError("保留条数须是 0–200 的整数");
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  const dropped = Math.max(0, t.history.length - keep);
  t.history = t.history.slice(-keep);
  if (keep === 0) t.history = [];
  touch(t);
  saveThreads(home, data);
  return { kept: t.history.length, dropped };
}

export function getThreadState(home: string, id: string): Record<string, string | number | boolean | null> {
  return { ...getThread(home, id).state };
}

function validateStatePatch(patch: Record<string, unknown>, base: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new ThreadError(`状态值只允许字符串、数字、布尔值或 null（键 ${k}）`);
    }
    if (typeof v === "string" && v.length > MAX_STATE_STRING) throw new ThreadError(`状态字符串不能超过 1000 字符（键 ${k}）`);
    if (typeof v === "number" && !Number.isFinite(v)) throw new ThreadError(`状态数字须是有限数（键 ${k}）`);
    out[k] = v;
  }
  if (Object.keys(out).length > MAX_STATE_KEYS) throw new ThreadError("状态键不能超过 32 个");
  return out;
}

/** 合并写状态：patch 里的 null 表示删这个键。 */
export function updateThreadState(home: string, id: string, patch: Record<string, unknown>): Record<string, string | number | boolean | null> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ThreadError("状态补丁须是对象");
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  t.state = validateStatePatch(patch, t.state);
  touch(t);
  saveThreads(home, data);
  return { ...t.state };
}

export function appendThreadHistory(home: string, id: string, kind: string, summary: string): ThreadHistoryEntry {
  if (!HISTORY_KIND_RE.test(kind)) throw new ThreadError("历史种类只允许字母、数字、点、下划线、连字符（1–40 字符）");
  const clean = summary.trim();
  if (!clean || clean.length > MAX_HISTORY_SUMMARY) throw new ThreadError("历史摘要不能为空且不超过 500 字符");
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  const entry: ThreadHistoryEntry = { at: nowIso(), kind, summary: clean };
  t.history.push(entry);
  if (t.history.length > MAX_HISTORY) t.history = t.history.slice(-MAX_HISTORY);
  touch(t);
  saveThreads(home, data);
  return entry;
}

export function getThreadHistory(home: string, id: string, limit = 50): ThreadHistoryEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) throw new ThreadError("历史条数须是 1–200 的整数");
  return getThread(home, id).history.slice(-limit);
}

export function recordThreadRun(home: string, id: string, runId: string, status: ThreadRunRecord["status"], workflow?: string): ThreadRunRecord {
  if (!runId || runId.length > 100) throw new ThreadError("运行 id 无效");
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  const rec: ThreadRunRecord = { run_id: runId, status, at: nowIso(), ...(workflow ? { workflow } : {}) };
  t.runs.unshift(rec);
  if (t.runs.length > MAX_RUNS) t.runs = t.runs.slice(0, MAX_RUNS);
  touch(t);
  saveThreads(home, data);
  return rec;
}

export function listThreadRuns(home: string, id: string): ThreadRunRecord[] {
  return [...getThread(home, id).runs];
}

export function setThreadStatus(home: string, id: string, status: "active" | "archived"): Thread {
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  t.status = status;
  touch(t);
  saveThreads(home, data);
  return t;
}

export function removeThread(home: string, id: string): boolean {
  const data = loadThreads(home);
  const before = data.threads.length;
  data.threads = data.threads.filter((x) => x.id !== id);
  if (data.threads.length === before) return false;
  saveThreads(home, data);
  return true;
}

// ---- 线程 cron（LangGraph cron.py 的 create_for_thread） ----

function validateCronShape(cron: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((p) => !CRON_SHAPE_RE.test(p))) {
    throw new ThreadError("cron 须是 5 字段（分 时 日 月 周），只允许数字、*、,、-、/");
  }
}

export function addThreadCron(home: string, id: string, cron: string, workflow: string): ThreadCron {
  validateCronShape(cron);
  const wf = workflow.trim();
  if (!wf || wf.length > 100) throw new ThreadError("工作流名不能为空且不超过 100 字符");
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  if (t.crons.length >= MAX_CRONS_PER_THREAD) throw new ThreadError("一个线程最多绑 10 条 cron");
  const binding: ThreadCron = { id: newId(), cron: cron.trim(), workflow: wf };
  t.crons.push(binding);
  touch(t);
  saveThreads(home, data);
  return binding;
}

export function removeThreadCron(home: string, id: string, cronId: string): boolean {
  const data = loadThreads(home);
  const t = data.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError("线程不存在");
  const before = t.crons.length;
  t.crons = t.crons.filter((c) => c.id !== cronId);
  if (t.crons.length === before) return false;
  touch(t);
  saveThreads(home, data);
  return true;
}

export function listThreadCrons(home: string, id: string): ThreadCron[] {
  return [...getThread(home, id).crons];
}

// ---- 到点触发 ----

function minuteKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function appendCronEvidence(home: string, entry: Record<string, unknown>): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dir = join(home, "evidence", "thread-crons");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch { /* 证据落盘失败不破坏触发 */ }
}

/** 有运行上下文时把事件镜像进运行事件链（tasks 目录优先，runs 次之）。 */
async function mirrorRunEvent(home: string, runId: string, type: string, fields: Record<string, unknown>): Promise<void> {
  try {
    const { RunStore } = await import("./runs.ts");
    for (const dir of ["tasks", "runs"]) {
      try {
        const store = new RunStore(join(home, dir));
        store.load(runId);
        store.appendEvent(runId, type, fields);
        return;
      } catch { /* 不在这个目录，换下一个 */ }
    }
  } catch { /* 事件镜像失败不破坏触发 */ }
}

export interface ThreadCronFireResult {
  threadId: string;
  cronId: string;
  workflow: string;
  runId: string | null;
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface ThreadCronRoundResult {
  skipped: string | null;
  fired: ThreadCronFireResult[];
  /** G-P1-38：本轮因配额 hold 挂起时才有。 */
  held?: { held: boolean; holdUntil: string | null; pauseId: string | null; scope: string | null };
  /** G-P1-38：本轮记到的漏跑（空数组 = 没漏跑）。 */
  missed?: Array<{ threadId: string; cronId: string; workflow: string; count: number; caughtUp: boolean }>;
}

export type ThreadCronRunFn = (home: string, workflow: string, threadId: string) => Promise<{ id: string }>;

async function defaultThreadCronRunFn(home: string, workflow: string, threadId: string): Promise<{ id: string }> {
  const { loadWorkflowDefinitionFile, runWorkflowByName } = await import("./workflow.ts");
  const { def } = loadWorkflowDefinitionFile(home, workflow);
  const run = await runWorkflowByName(home, workflow, {}, {
    workdir: process.cwd(),
    mode: "normal",
    interactive: false,
    ...(def.max_cost_usd ? { maxCostUsd: def.max_cost_usd } : {}),
  });
  return { id: run.id };
}

/**
 * 守护进程每轮调：到点的线程 cron 各跑一次（同一分钟不重复跑）。
 * 与 workflow triggers 共用总开关：开关关着直接返回 skipped，不跑任何东西；
 * 只跑 active 的工作流（draft / trial_passed / 不存在的工作流跳过，记 skipped）。
 * 每轮最多跑 5 个；失败只记证据与线程运行记录，不重跑这一分钟。
 *
 * G-P1-38：配额 hold 时整轮挂起（与工作流触发器共用同一份 hold 戳）；
 * 漏跑补跑与工作流触发器同款策略（once 只补跑一次、skip 只记 missed ×N，
 * 窗口同款），锚点是各 cron 自己的 last_fired——没记过的 cron 不算漏跑。
 */
export async function fireDueThreadCrons(
  home: string,
  opts?: { now?: Date; workdir?: string; runFn?: ThreadCronRunFn },
): Promise<ThreadCronRoundResult> {
  const now = opts?.now ?? new Date();
  const { loadWorkflowTriggerState, cronMatches, evaluateQuotaHold, resolveCronPolicy } = await import("./workflowTriggers.ts");
  const { appendCronIncident, missedCronMinutes, minuteKey, parseMinuteKey } = await import("./cronMaturity.ts");
  const state = loadWorkflowTriggerState(home);
  if (!state.enabled) return { skipped: "触发器执行未开启（nyra workflow triggers enable --yes 开启）", fired: [] };
  const hold = evaluateQuotaHold(home, state, now);
  if (hold.held) {
    return {
      skipped: `配额 hold 中：成本上限已触顶（${hold.scope ?? "未知层"}），线程 cron 挂起至 ${hold.holdUntil ?? "未知"}`,
      fired: [], held: hold, missed: [],
    };
  }
  const policy = resolveCronPolicy(state);
  const { loadWorkflowRegistry } = await import("./workflow.ts");
  let registry;
  try {
    registry = loadWorkflowRegistry(home);
  } catch {
    registry = { workflows: [] };
  }
  const activeNames = new Set(
    (registry.workflows as Array<{ name: string; status: string }>)
      .filter((w) => w.status === "active").map((w) => w.name),
  );
  const fired: ThreadCronFireResult[] = [];
  const missed: NonNullable<ThreadCronRoundResult["missed"]> = [];
  const minute = minuteKey(now);
  const windowStart = new Date(now.getTime() - policy.catchUpWindowMinutes * 60_000);
  const threads = listThreads(home).filter((t) => t.status === "active");
  for (const t of threads) {
    if (fired.length >= MAX_CRONS_PER_ROUND) break;
    for (const c of t.crons) {
      if (fired.length >= MAX_CRONS_PER_ROUND) break;
      const dueNow = cronMatches(c.cron, now);
      const prevLast = c.last_fired;
      // 漏跑：上次记过的分钟之后、当前分钟之前、窗口内的匹配分钟。
      const anchor = prevLast ? parseMinuteKey(prevLast) : null;
      const anchorInWindow = anchor && anchor.getTime() >= windowStart.getTime() ? anchor : (anchor ? windowStart : null);
      const missedMinutes = policy.catchUpWindowMinutes > 0 ? missedCronMinutes(c.cron, anchorInWindow, now) : [];
      let caughtUpThisRound = false;
      if (missedMinutes.length > 0) {
        if (policy.catchUp === "once" && !dueNow && fired.length < MAX_CRONS_PER_ROUND && activeNames.has(c.workflow)) {
          // 补跑一次：最近一次漏掉的分钟（只在工作流是 active 时补跑）。
          const data = loadThreads(home);
          const live = data.threads.find((x) => x.id === t.id);
          const liveCron = live?.crons.find((x) => x.id === c.id);
          if (liveCron) { liveCron.last_fired = minute; saveThreads(home, data); }
          const latest = missedMinutes[missedMinutes.length - 1];
          const r = await fireOneThreadCron(home, t, c, now, opts, minute, { catch_up: true, scheduled_minute: minuteKey(latest) });
          fired.push(r);
          caughtUpThisRound = true;
          appendCronIncident(home, {
            kind: "caught_up", source: "thread", workflow: c.workflow, thread_id: t.id, cron_id: c.id,
            scheduled_minute: minuteKey(latest), policy: "once", run_id: r.runId,
            ...(r.status === "failed" ? { error: (r.error ?? "").slice(0, 200) } : {}),
          });
          if (missedMinutes.length - 1 > 0) {
            appendCronIncident(home, {
              kind: "missed", source: "thread", workflow: c.workflow, thread_id: t.id, cron_id: c.id,
              count: missedMinutes.length - 1, policy: "once",
            });
          }
        } else {
          if (!dueNow) {
            const data = loadThreads(home);
            const live = data.threads.find((x) => x.id === t.id);
            const liveCron = live?.crons.find((x) => x.id === c.id);
            if (liveCron) { liveCron.last_fired = minute; saveThreads(home, data); }
          }
          appendCronIncident(home, {
            kind: "missed", source: "thread", workflow: c.workflow, thread_id: t.id, cron_id: c.id,
            count: missedMinutes.length, policy: policy.catchUp,
          });
        }
        missed.push({ threadId: t.id, cronId: c.id, workflow: c.workflow, count: missedMinutes.length, caughtUp: caughtUpThisRound });
      }
      if (!dueNow || caughtUpThisRound) continue;
      if (prevLast === minute) continue;
      if (!activeNames.has(c.workflow)) {
        fired.push({ threadId: t.id, cronId: c.id, workflow: c.workflow, runId: null, status: "skipped", error: "工作流不是 active，不跑" });
        appendCronEvidence(home, { thread_id: t.id, cron_id: c.id, workflow: c.workflow, status: "skipped", reason: "workflow-not-active" });
        continue;
      }
      // 先记已触发（同一分钟不重复跑），再执行。
      const data = loadThreads(home);
      const live = data.threads.find((x) => x.id === t.id);
      const liveCron = live?.crons.find((x) => x.id === c.id);
      if (liveCron) { liveCron.last_fired = minute; saveThreads(home, data); }
      fired.push(await fireOneThreadCron(home, t, c, now, opts, minute, {}));
    }
  }
  return { skipped: null, fired, missed };
}

/**
 * 一条线程 cron 跑一次（正常触发与补跑共用）：执行、记运行记录与历史、
 * 写证据、成功时镜像 thread_cron_fired 事件、失败时记一笔 failed 事故。
 */
async function fireOneThreadCron(
  home: string, t: { id: string }, c: { id: string; workflow: string; cron: string },
  now: Date, opts: { workdir?: string; runFn?: ThreadCronRunFn } | undefined, minute: string,
  evidenceExtra: Record<string, unknown>,
): Promise<ThreadCronFireResult> {
  const { appendCronIncident } = await import("./cronMaturity.ts");
  let runId: string | null = null;
  let status: "ok" | "failed" = "ok";
  let error: string | undefined;
  try {
    const r = opts?.runFn
      ? await opts.runFn(home, c.workflow, t.id)
      : await defaultThreadCronRunFn(home, c.workflow, t.id);
    runId = r.id;
  } catch (err: unknown) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    if (runId) recordThreadRun(home, t.id, runId, status, c.workflow);
    appendThreadHistory(home, t.id, "cron", status === "ok"
      ? `定时触发：工作流 ${c.workflow} 已跑（运行 ${runId}）`
      : `定时触发：工作流 ${c.workflow} 失败：${(error ?? "").slice(0, 200)}`);
  } catch { /* 线程记账失败不破坏触发结果 */ }
  appendCronEvidence(home, {
    thread_id: t.id, cron_id: c.id, workflow: c.workflow, cron: c.cron,
    run_id: runId, status, ...(error ? { error: error.slice(0, 200) } : {}), ...evidenceExtra,
  });
  if (runId) {
    await mirrorRunEvent(home, runId, "thread_cron_fired", { thread_id: t.id, workflow: c.workflow, status });
  }
  if (status === "failed") {
    appendCronIncident(home, {
      kind: "failed", source: "thread", workflow: c.workflow, thread_id: t.id, cron_id: c.id,
      run_id: runId, error: (error ?? "").slice(0, 200),
    });
  }
  return { threadId: t.id, cronId: c.id, workflow: c.workflow, runId, status, ...(error ? { error } : {}) };
}
