// src/workflowTriggers.ts — 缺口 25 的尾巴：触发器执行（G-P1-37）。
//
// 工作流 DSL 里的 triggers（schedule / event）此前只校验、不执行。本批把
// 执行接上，不另起调度器，复用现有零件：
//   - schedule（cron）：守护进程每轮扫一次（与 Heartbeat / Watch 同款 poller），
//     到点就跑；
//   - event：网关收到 webhook 与 Gmail 轮询派发事件时，顺带把同名事件的工作流
//     触发器也跑一遍；
//   - 执行走现有 runWorkflowByName（非交互、成本上限继承定义里的 max_cost_usd，
//     审批节点照常挂起进审阅队列，不自动放行）。
//
// 安全闸（默认全关）：
//   - 全局开关默认关，须 `nyra workflow triggers enable --yes` 显式开启；
//   - 只跑 status 为 active 的工作流（draft / trial_passed 不跑）；
//   - 每轮最多跑 5 个（防一次扇出烧光 token），cron 同一分钟只触发一次
//     （lastFired 按分钟记），同一事件只触发一次（firedEvents 按事件 id 记）；
//   - 事件 payload 是不可信外部数据：不注进工作流输入（输入只走定义里的
//     inputs 默认值），触发记录（工作流名、触发器、事件 id）写证据链
//     evidence/workflow-triggers/<日期>.jsonl，事件 id 过长只记指纹。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadWorkflowDefinitionFile, loadWorkflowRegistry, runWorkflowByName } from "./workflow.ts";
import type { IncomingEvent } from "./eventTriggers.ts";

export class WorkflowTriggerError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowTriggerError"; }
}

export const WORKFLOW_TRIGGERS_FILE = "workflow-triggers.json";
export const MAX_RUNS_PER_ROUND = 5;
const FIRED_EVENTS_KEEP = 500;

export interface WorkflowTriggerState {
  version: 1;
  /** 全局开关：默认关，须显式开启。 */
  enabled: boolean;
  /** `${工作流名}\n${触发器下标}` → 上次触发的分钟（ISO，截到分钟）。 */
  lastFired: Record<string, string>;
  /** `${工作流名}\n${触发器下标}\n${事件 id}` → 触发时间（去重用）。 */
  firedEvents: Record<string, string>;
}

export function workflowTriggersPath(home: string): string {
  return join(home, WORKFLOW_TRIGGERS_FILE);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadWorkflowTriggerState(home: string): WorkflowTriggerState {
  const p = workflowTriggersPath(home);
  const empty: WorkflowTriggerState = { version: 1, enabled: false, lastFired: {}, firedEvents: {} };
  if (!existsSync(p)) return empty;
  if (lstatSync(p).isSymbolicLink()) throw new WorkflowTriggerError("触发器状态文件不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new WorkflowTriggerError("触发器状态文件损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as { version?: number }).version !== 1) {
    backupCorrupt(p);
    throw new WorkflowTriggerError("触发器状态文件格式无效，已备份");
  }
  const r = raw as Partial<WorkflowTriggerState>;
  return {
    version: 1,
    enabled: r.enabled === true,
    lastFired: r.lastFired && typeof r.lastFired === "object" ? r.lastFired as Record<string, string> : {},
    firedEvents: r.firedEvents && typeof r.firedEvents === "object" ? r.firedEvents as Record<string, string> : {},
  };
}

export function saveWorkflowTriggerState(home: string, state: WorkflowTriggerState): void {
  const p = workflowTriggersPath(home);
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new WorkflowTriggerError("触发器状态文件不能是符号链接");
  // firedEvents 只留最近 500 条（对象按插入顺序，删最旧的）。
  const keys = Object.keys(state.firedEvents);
  if (keys.length > FIRED_EVENTS_KEEP) {
    for (const k of keys.slice(0, keys.length - FIRED_EVENTS_KEEP)) delete state.firedEvents[k];
  }
  const tmp = join(dirname(p), `.wft-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(state, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, p);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

export function setWorkflowTriggersEnabled(home: string, enabled: boolean): WorkflowTriggerState {
  const state = loadWorkflowTriggerState(home);
  state.enabled = enabled;
  saveWorkflowTriggerState(home, state);
  return state;
}

// ---- cron：5 字段（分 时 日 月 周），只认数字、*、,、-、/ ----

const CRON_FIELD_RE = /^[0-9*,/-]+$/;

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      const n = Number(part.slice(slash + 1));
      if (!Number.isInteger(n) || n < 1) return null;
      step = n;
    }
    let lo: number; let hi: number;
    if (range === "" || range === "*") { lo = min; hi = max; }
    else if (/^\d+$/.test(range)) { lo = Number(range); hi = lo; }
    else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) return null;
      lo = Number(m[1]); hi = Number(m[2]);
      if (lo > hi) return null;
    }
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/**
 * cron 是否匹配这一分钟。日（月）与周（日）按标准 cron 规则：只限制了
 * 一边就按那一边算，两边都限制了任一边命中即可，两边都不限制即命中。
 * 解析失败返回 false（守护进程里跳过、不炸轮询）。
 */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((p) => !CRON_FIELD_RE.test(p))) return false;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dowRaw = parseCronField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return false;
  // 周日 7 当 0。
  const dow = new Set([...dowRaw].map((v) => (v === 7 ? 0 : v)));
  if (!minute.has(date.getMinutes()) || !hour.has(date.getHours()) || !month.has(date.getMonth() + 1)) return false;
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";
  const domHit = dom.has(date.getDate());
  const dowHit = dow.has(date.getDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

function minuteKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function appendTriggerEvidence(home: string, entry: Record<string, unknown>): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dir = join(home, "evidence", "workflow-triggers");
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

export interface TriggerFireResult {
  workflow: string;
  triggerIndex: number;
  triggerType: "schedule" | "event";
  runId: string | null;
  status: "ok" | "failed";
  error?: string;
}

export interface TriggerRoundResult {
  skipped: string | null;
  fired: TriggerFireResult[];
}

export type WorkflowRunFn = (home: string, name: string) => Promise<{ id: string }>;

async function defaultRunFn(home: string, name: string, workdir: string): Promise<{ id: string }> {
  const { def } = loadWorkflowDefinitionFile(home, name);
  const run = await runWorkflowByName(home, name, {}, {
    workdir,
    mode: "normal",
    interactive: false,
    ...(def.max_cost_usd ? { maxCostUsd: def.max_cost_usd } : {}),
  });
  return { id: run.id };
}

function shortEventId(eventId: string): string {
  if (eventId.length <= 24) return eventId;
  return `sha256:${createHash("sha256").update(eventId).digest("hex").slice(0, 16)}`;
}

interface ActiveWorkflowTriggers {
  name: string;
  triggers: Array<{ type: "schedule" | "event"; cron?: string; event?: string }>;
}

function listActiveWorkflowTriggers(home: string): ActiveWorkflowTriggers[] {
  const out: ActiveWorkflowTriggers[] = [];
  let registry;
  try {
    registry = loadWorkflowRegistry(home);
  } catch {
    return out;
  }
  for (const entry of registry.workflows) {
    if (entry.status !== "active") continue;
    try {
      const { def } = loadWorkflowDefinitionFile(home, entry.name);
      if (!def.triggers?.length) continue;
      out.push({ name: entry.name, triggers: def.triggers });
    } catch {
      // 定义读不出来就跳过这个工作流，不破坏整轮。
      continue;
    }
  }
  return out;
}

async function fireOne(
  home: string, workflow: string, triggerIndex: number,
  triggerType: "schedule" | "event", workdir: string, runFn: WorkflowRunFn | undefined,
  evidenceExtra: Record<string, unknown>,
): Promise<TriggerFireResult> {
  let runId: string | null = null;
  let status: "ok" | "failed" = "ok";
  let error: string | undefined;
  try {
    const r = runFn
      ? await runFn(home, workflow)
      : await defaultRunFn(home, workflow, workdir);
    runId = r.id;
  } catch (err: unknown) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }
  appendTriggerEvidence(home, {
    workflow, trigger_index: triggerIndex, trigger_type: triggerType,
    run_id: runId, status, ...(error ? { error: error.slice(0, 200) } : {}), ...evidenceExtra,
  });
  return { workflow, triggerIndex, triggerType, runId, status, ...(error ? { error } : {}) };
}

/**
 * 守护进程每轮调：到点的 schedule 触发器各跑一次（同一分钟不重复跑）。
 * 全局开关关着直接返回 skipped（不读注册表、不跑任何东西）。
 */
export async function runDueWorkflowTriggers(
  home: string,
  opts?: { now?: Date; workdir?: string; runFn?: WorkflowRunFn },
): Promise<TriggerRoundResult> {
  const now = opts?.now ?? new Date();
  const state = loadWorkflowTriggerState(home);
  if (!state.enabled) return { skipped: "触发器执行未开启（nyra workflow triggers enable --yes 开启）", fired: [] };
  const workdir = opts?.workdir ?? process.cwd();
  const fired: TriggerFireResult[] = [];
  const minute = minuteKey(now);
  for (const wf of listActiveWorkflowTriggers(home)) {
    if (fired.length >= MAX_RUNS_PER_ROUND) break;
    for (let i = 0; i < wf.triggers.length; i++) {
      if (fired.length >= MAX_RUNS_PER_ROUND) break;
      const t = wf.triggers[i];
      if (t.type !== "schedule" || !t.cron) continue;
      if (!cronMatches(t.cron, now)) continue;
      const key = `${wf.name}\n${i}`;
      if (state.lastFired[key] === minute) continue;
      // 先记已触发（同一分钟不重复跑），再执行；执行失败也只记证据，不重跑这一分钟。
      state.lastFired[key] = minute;
      saveWorkflowTriggerState(home, state);
      fired.push(await fireOne(home, wf.name, i, "schedule", workdir, opts?.runFn, { cron: t.cron }));
    }
  }
  return { skipped: null, fired };
}

/**
 * 事件触发：网关收到 webhook / Gmail 轮询派发事件后调。同一事件只触发一次
 * （按事件 id 去重）；事件 payload 不注进工作流输入（不可信外部数据），
 * 触发记录进证据链。
 */
export async function fireWorkflowEventTriggers(
  home: string,
  event: IncomingEvent,
  opts?: { now?: Date; workdir?: string; runFn?: WorkflowRunFn },
): Promise<TriggerRoundResult> {
  const state = loadWorkflowTriggerState(home);
  if (!state.enabled) return { skipped: "触发器执行未开启（nyra workflow triggers enable --yes 开启）", fired: [] };
  const workdir = opts?.workdir ?? process.cwd();
  const fired: TriggerFireResult[] = [];
  let stateChanged = false;
  for (const wf of listActiveWorkflowTriggers(home)) {
    if (fired.length >= MAX_RUNS_PER_ROUND) break;
    for (let i = 0; i < wf.triggers.length; i++) {
      if (fired.length >= MAX_RUNS_PER_ROUND) break;
      const t = wf.triggers[i];
      if (t.type !== "event" || !t.event) continue;
      if (t.event !== event.eventType) continue;
      const key = `${wf.name}\n${i}\n${event.eventId}`;
      if (state.firedEvents[key]) continue;
      state.firedEvents[key] = new Date().toISOString();
      stateChanged = true;
      fired.push(await fireOne(home, wf.name, i, "event", workdir, opts?.runFn, {
        event_type: event.eventType, event_id: shortEventId(event.eventId),
      }));
    }
  }
  if (stateChanged) saveWorkflowTriggerState(home, state);
  return { skipped: null, fired };
}

/** CLI status 用：开关 + 各 active 工作流的触发器清单。 */
export function describeWorkflowTriggers(home: string): { enabled: boolean; workflows: ActiveWorkflowTriggers[] } {
  const state = loadWorkflowTriggerState(home);
  return { enabled: state.enabled, workflows: listActiveWorkflowTriggers(home) };
}
