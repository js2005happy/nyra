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
//
// G-P1-38 cron 成熟语义：漏跑补跑（catch_up once/skip + 窗口）与配额 hold
// （quota_hold_until）与事故账（cron-incidents.jsonl）见 src/cronMaturity.ts；
// 本文件只负责把这三件接进触发器执行（状态字段、每轮判定、CLI 读数）。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadWorkflowDefinitionFile, loadWorkflowRegistry, runWorkflowByName } from "./workflow.ts";
import type { IncomingEvent } from "./eventTriggers.ts";
import {
  appendCronIncident, cronMatches, cronMinIntervalMinutes, findActiveCostPause, missedCronMinutes, minuteKey, parseMinuteKey,
  MAX_CONSECUTIVE_FAILURES, MAX_ENABLED_ROUTINES, MIN_CRON_INTERVAL_MINUTES,
} from "./cronMaturity.ts";

/** cron 匹配仍从这里导出（threads.ts 与旧测试的 import 不用改）。 */
export { cronMatches } from "./cronMaturity.ts";

export class WorkflowTriggerError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowTriggerError"; }
}

export const WORKFLOW_TRIGGERS_FILE = "workflow-triggers.json";
export const MAX_RUNS_PER_ROUND = 5;
const FIRED_EVENTS_KEEP = 500;
/** 漏跑补跑默认：只补跑一次。 */
export const DEFAULT_CATCH_UP: "once" | "skip" = "once";
/** 漏跑统计窗口默认 120 分钟（上限 1440）。 */
export const DEFAULT_CATCH_UP_WINDOW_MINUTES = 120;
export const MAX_CATCH_UP_WINDOW_MINUTES = 1440;
/** 配额 hold 戳默认 60 分钟（下限 5，上限 1440）。 */
export const DEFAULT_QUOTA_HOLD_MINUTES = 60;
export const MIN_QUOTA_HOLD_MINUTES = 5;
export const MAX_QUOTA_HOLD_MINUTES = 1440;

export type CatchUpPolicy = "once" | "skip";

export interface CronPolicy {
  catchUp: CatchUpPolicy;
  catchUpWindowMinutes: number;
  quotaHoldMinutes: number;
}

export function resolveCronPolicy(state: Partial<WorkflowTriggerState>): CronPolicy {
  const catchUp = state.catch_up === "skip" ? "skip" : DEFAULT_CATCH_UP;
  const windowRaw = typeof state.catch_up_window_minutes === "number" && Number.isFinite(state.catch_up_window_minutes)
    ? Math.floor(state.catch_up_window_minutes) : DEFAULT_CATCH_UP_WINDOW_MINUTES;
  const holdRaw = typeof state.quota_hold_minutes === "number" && Number.isFinite(state.quota_hold_minutes)
    ? Math.floor(state.quota_hold_minutes) : DEFAULT_QUOTA_HOLD_MINUTES;
  return {
    catchUp,
    catchUpWindowMinutes: Math.min(Math.max(windowRaw, 0), MAX_CATCH_UP_WINDOW_MINUTES),
    quotaHoldMinutes: Math.min(Math.max(holdRaw, MIN_QUOTA_HOLD_MINUTES), MAX_QUOTA_HOLD_MINUTES),
  };
}

export interface WorkflowTriggerState {
  version: 1;
  /** 全局开关：默认关，须显式开启。 */
  enabled: boolean;
  /** `${工作流名}\n${触发器下标}` → 上次触发的分钟（ISO，截到分钟）。 */
  lastFired: Record<string, string>;
  /** `${工作流名}\n${触发器下标}\n${事件 id}` → 触发时间（去重用）。 */
  firedEvents: Record<string, string>;
  /** G-P1-38 漏跑补跑策略：缺省 "once"（只补跑一次），"skip" 直接跳到下一档。 */
  catch_up?: CatchUpPolicy;
  /** G-P1-38 漏跑统计窗口（分钟），缺省 120，上限 1440；0 = 不统计漏跑。 */
  catch_up_window_minutes?: number;
  /** G-P1-38 配额 hold 戳有效期（分钟），缺省 60，下限 5，上限 1440。 */
  quota_hold_minutes?: number;
  /** G-P1-38 配额 hold 到期时间（ISO）；未到时间前触发全部挂起。 */
  quota_hold_until?: string | null;
  /**
   * O6：每个触发器的连续失败次数（键 `${工作流名}\n${触发器下标}`）。
   * 成功一次清零；满 10 次自动停用（见 disabled_triggers）。
   */
  consecutive_failures?: Record<string, number>;
  /**
   * O6：已自动停用的触发器（键同上）。停用原因在值里：failures 为连败次数
   * （满 10 次），error 为最后一次错误或低于下限的说明；at 为停用时间。
   * 停用的触发器不再触发（漏跑也不记），须 `nyra workflow triggers re-enable`
   * 显式恢复。
   */
  disabled_triggers?: Record<string, { at: string; failures: number; error: string }>;
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
  const out: WorkflowTriggerState = {
    version: 1,
    enabled: r.enabled === true,
    lastFired: r.lastFired && typeof r.lastFired === "object" ? r.lastFired as Record<string, string> : {},
    firedEvents: r.firedEvents && typeof r.firedEvents === "object" ? r.firedEvents as Record<string, string> : {},
  };
  if (r.catch_up === "once" || r.catch_up === "skip") out.catch_up = r.catch_up;
  if (typeof r.catch_up_window_minutes === "number" && Number.isFinite(r.catch_up_window_minutes)) {
    out.catch_up_window_minutes = Math.floor(r.catch_up_window_minutes);
  }
  if (typeof r.quota_hold_minutes === "number" && Number.isFinite(r.quota_hold_minutes)) {
    out.quota_hold_minutes = Math.floor(r.quota_hold_minutes);
  }
  if (typeof r.quota_hold_until === "string" && r.quota_hold_until) out.quota_hold_until = r.quota_hold_until;
  if (r.consecutive_failures && typeof r.consecutive_failures === "object") {
    const cf: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.consecutive_failures as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) cf[k] = Math.floor(v);
    }
    if (Object.keys(cf).length > 0) out.consecutive_failures = cf;
  }
  if (r.disabled_triggers && typeof r.disabled_triggers === "object") {
    const dt: Record<string, { at: string; failures: number; error: string }> = {};
    for (const [k, v] of Object.entries(r.disabled_triggers as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const row = v as Record<string, unknown>;
      dt[k] = {
        at: typeof row.at === "string" ? row.at : "",
        failures: typeof row.failures === "number" ? row.failures : 0,
        error: typeof row.error === "string" ? row.error : "",
      };
    }
    if (Object.keys(dt).length > 0) out.disabled_triggers = dt;
  }
  return out;
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

/** G-P1-38：改漏跑补跑策略与窗口（只改给到的键；非法值直接报错，不写盘）。 */
export function setCronPolicy(
  home: string,
  patch: { catchUp?: string; catchUpWindowMinutes?: number; quotaHoldMinutes?: number },
): CronPolicy {
  if (patch.catchUp !== undefined && patch.catchUp !== "once" && patch.catchUp !== "skip") {
    throw new WorkflowTriggerError("补跑策略只认 once（只补跑一次）或 skip（直接跳到下一档）");
  }
  if (patch.catchUpWindowMinutes !== undefined &&
    (!Number.isFinite(patch.catchUpWindowMinutes) || patch.catchUpWindowMinutes < 0 || patch.catchUpWindowMinutes > MAX_CATCH_UP_WINDOW_MINUTES)) {
    throw new WorkflowTriggerError(`漏跑统计窗口须在 0–${MAX_CATCH_UP_WINDOW_MINUTES} 分钟之间`);
  }
  if (patch.quotaHoldMinutes !== undefined &&
    (!Number.isFinite(patch.quotaHoldMinutes) || patch.quotaHoldMinutes < MIN_QUOTA_HOLD_MINUTES || patch.quotaHoldMinutes > MAX_QUOTA_HOLD_MINUTES)) {
    throw new WorkflowTriggerError(`配额 hold 有效期须在 ${MIN_QUOTA_HOLD_MINUTES}–${MAX_QUOTA_HOLD_MINUTES} 分钟之间`);
  }
  const state = loadWorkflowTriggerState(home);
  if (patch.catchUp !== undefined) state.catch_up = patch.catchUp;
  if (patch.catchUpWindowMinutes !== undefined) state.catch_up_window_minutes = Math.floor(patch.catchUpWindowMinutes);
  if (patch.quotaHoldMinutes !== undefined) state.quota_hold_minutes = Math.floor(patch.quotaHoldMinutes);
  saveWorkflowTriggerState(home, state);
  return resolveCronPolicy(state);
}

export function getCronPolicy(home: string): CronPolicy {
  try {
    return resolveCronPolicy(loadWorkflowTriggerState(home));
  } catch {
    // 状态文件损坏时回默认，不抛错（只读路径 fail-open）。
    return { catchUp: DEFAULT_CATCH_UP, catchUpWindowMinutes: DEFAULT_CATCH_UP_WINDOW_MINUTES, quotaHoldMinutes: DEFAULT_QUOTA_HOLD_MINUTES };
  }
}

export interface QuotaHoldInfo {
  held: boolean;
  /** 戳到期时间（held 时才有）。 */
  holdUntil: string | null;
  /** 触发 hold 的那条成本暂停（held 时才有）。 */
  pauseId: string | null;
  scope: string | null;
}

/** 只读看 hold 状态（不写盘、不打戳，status 命令用；状态文件损坏时当没有 hold）。 */
/** O6：触发器在状态文件里的键。 */
export function routineKey(workflow: string, triggerIndex: number): string {
  return `${workflow}\n${triggerIndex}`;
}

/** O6：这个触发器是否已被自动停用。 */
export function isTriggerDisabled(state: WorkflowTriggerState, workflow: string, triggerIndex: number): boolean {
  return Boolean(state.disabled_triggers?.[routineKey(workflow, triggerIndex)]);
}

/** O6：已启用的例行数（active 工作流的触发器数，自动停用的不算）。 */
export function countEnabledRoutineTriggers(home: string): number {
  const state = loadWorkflowTriggerState(home);
  let n = 0;
  for (const wf of listActiveWorkflowTriggers(home)) {
    for (let i = 0; i < wf.triggers.length; i++) {
      if (!isTriggerDisabled(state, wf.name, i)) n += 1;
    }
  }
  return n;
}

/** O6：护栏总览（CLI status 用）。 */
export function describeRoutineGuardrails(home: string): {
  minIntervalMinutes: number;
  maxEnabled: number;
  maxConsecutiveFailures: number;
  enabledCount: number;
  disabledCount: number;
} {
  const state = loadWorkflowTriggerState(home);
  return {
    minIntervalMinutes: MIN_CRON_INTERVAL_MINUTES,
    maxEnabled: MAX_ENABLED_ROUTINES,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    enabledCount: countEnabledRoutineTriggers(home),
    disabledCount: Object.keys(state.disabled_triggers ?? {}).length,
  };
}

/**
 * O6：把 routine_auto_disabled 事件镜像进那次工作流运行的事件链（有 runId
 * 才做；运行记录可能在 tasks/ 或 runs/ 目录下，两个都试；失败不破坏触发）。
 */
async function mirrorRoutineDisabledEvent(
  home: string, runId: string | null, workflow: string, triggerIndex: number, failures: number,
): Promise<void> {
  if (!runId) return;
  try {
    const { RunStore } = await import("./runs.ts");
    for (const dir of ["tasks", "runs"]) {
      try {
        const store = new RunStore(join(home, dir));
        store.load(runId);
        store.appendEvent(runId, "routine_auto_disabled", { workflow, trigger_index: triggerIndex, failures });
        return;
      } catch { /* 不在这个目录，换下一个 */ }
    }
  } catch { /* 事件镜像失败不破坏触发 */ }
}

/**
 * O6：停用一个触发器（失败满 10 次，或间隔低于 15 分钟下限时调）。
 * 停用即通知：事故账记 auto_disabled（`nyra cron incidents` 可见）+
 * routine_auto_disabled 运行事件（有 runId 时镜像进那次运行）。
 * 返回 true 表示本次刚停用（之前没停用过），false 表示早已停用。
 */
export async function disableTrigger(
  home: string, workflow: string, triggerIndex: number,
  reason: { failures: number; error: string; runId?: string | null },
): Promise<boolean> {
  const state = loadWorkflowTriggerState(home);
  const key = routineKey(workflow, triggerIndex);
  if (state.disabled_triggers?.[key]) return false;
  if (!state.disabled_triggers) state.disabled_triggers = {};
  state.disabled_triggers[key] = {
    at: new Date().toISOString(),
    failures: reason.failures,
    error: reason.error.slice(0, 200),
  };
  delete (state.consecutive_failures ?? {})[key];
  saveWorkflowTriggerState(home, state);
  appendCronIncident(home, {
    kind: "auto_disabled", source: "workflow", workflow, trigger_index: triggerIndex,
    consecutive_failures: reason.failures, error: reason.error.slice(0, 200),
    note: reason.failures >= MAX_CONSECUTIVE_FAILURES
      ? `连续失败 ${reason.failures} 次，已自动关闭（nyra workflow triggers re-enable ${workflow} ${triggerIndex} 恢复）`
      : `间隔低于 ${MIN_CRON_INTERVAL_MINUTES} 分钟下限，已自动关闭（改 cron 后 nyra workflow triggers re-enable ${workflow} ${triggerIndex} 恢复）`,
    run_id: reason.runId ?? null,
  });
  await mirrorRoutineDisabledEvent(home, reason.runId ?? null, workflow, triggerIndex, reason.failures);
  return true;
}

/**
 * O6：记一次触发结果。成功清零连败；失败 +1，满 10 次自动停用（先记事故 +
 * 运行事件再停，不存在“悄悄关了”的情况）。返回本次是否刚停用。
 */
export async function recordTriggerResult(
  home: string, workflow: string, triggerIndex: number,
  ok: boolean, error?: string, runId?: string | null,
): Promise<boolean> {
  const state = loadWorkflowTriggerState(home);
  const key = routineKey(workflow, triggerIndex);
  if (ok) {
    if (state.consecutive_failures?.[key]) {
      delete state.consecutive_failures[key];
      saveWorkflowTriggerState(home, state);
    }
    return false;
  }
  const prev = state.consecutive_failures?.[key] ?? 0;
  const next = prev + 1;
  if (!state.consecutive_failures) state.consecutive_failures = {};
  state.consecutive_failures[key] = next;
  saveWorkflowTriggerState(home, state);
  if (next < MAX_CONSECUTIVE_FAILURES) return false;
  return disableTrigger(home, workflow, triggerIndex, {
    failures: next, error: error ?? "", runId: runId ?? null,
  });
}

/**
 * O6：重新启用一个已自动停用的触发器（事故账记 re_enabled，留审计痕迹）。
 * 返回 false 表示它本来就没停用。
 */
export function reEnableTrigger(home: string, workflow: string, triggerIndex: number): boolean {
  const state = loadWorkflowTriggerState(home);
  const key = routineKey(workflow, triggerIndex);
  if (!state.disabled_triggers?.[key]) return false;
  delete state.disabled_triggers[key];
  if (state.consecutive_failures) delete state.consecutive_failures[key];
  saveWorkflowTriggerState(home, state);
  appendCronIncident(home, {
    kind: "re_enabled", source: "workflow", workflow, trigger_index: triggerIndex,
    note: "机主手动恢复（nyra workflow triggers re-enable）",
  });
  return true;
}

/** O6：低于 15 分钟下限的定时触发器（执行路径的后备：激活时已拦，手改注册表绕过的在这里停用）。 */
export function isBelowFloorTrigger(t: { type: "schedule" | "event"; cron?: string }): boolean {
  if (t.type !== "schedule" || !t.cron) return false;
  const interval = cronMinIntervalMinutes(t.cron);
  return interval !== null && interval < MIN_CRON_INTERVAL_MINUTES;
}

export function describeQuotaHold(home: string, now = new Date()): QuotaHoldInfo {
  let state: WorkflowTriggerState;
  try {
    state = loadWorkflowTriggerState(home);
  } catch {
    return { held: false, holdUntil: null, pauseId: null, scope: null };
  }
  const stamp = state.quota_hold_until ? Date.parse(state.quota_hold_until) : Number.NaN;
  if (Number.isFinite(stamp) && now.getTime() < stamp) {
    const pause = findActiveCostPause(home, now);
    return { held: true, holdUntil: state.quota_hold_until ?? null, pauseId: pause?.id ?? null, scope: pause?.scope ?? null };
  }
  const pause = findActiveCostPause(home, now);
  if (!pause) return { held: false, holdUntil: null, pauseId: null, scope: null };
  return { held: true, holdUntil: state.quota_hold_until ?? null, pauseId: pause.id, scope: pause.scope };
}

/**
 * G-P1-38 配额 hold 判定（每轮触发前调；调用方须在返回 held=false 后继续跑）。
 * 规则：
 *   - hold 戳还在有效期内 → 继续挂起（戳本身说了算，不重复查暂停账本）；
 *   - 戳过期或没有戳、且本月有未决成本暂停 → 打新戳（now + hold 分钟），
 *     记一笔 quota_held 事故，挂起；
 *   - 戳过期且暂停已解除 → 清戳，记一笔 quota_released 事故，放行。
 * 返回 held 时调用方直接跳过本轮触发（不跑任何工作流、不推进 lastFired，
 * 漏掉的分钟等放行后由补跑逻辑一次性处理，窗口照算）。
 */
export function evaluateQuotaHold(home: string, state: WorkflowTriggerState, now = new Date()): QuotaHoldInfo {
  const stamp = state.quota_hold_until ? Date.parse(state.quota_hold_until) : Number.NaN;
  if (Number.isFinite(stamp) && now.getTime() < stamp) {
    const pause = findActiveCostPause(home, now);
    return { held: true, holdUntil: state.quota_hold_until ?? null, pauseId: pause?.id ?? null, scope: pause?.scope ?? null };
  }
  const hadStamp = Number.isFinite(stamp);
  const pause = findActiveCostPause(home, now);
  if (!pause) {
    if (hadStamp) {
      state.quota_hold_until = null;
      saveWorkflowTriggerState(home, state);
      appendCronIncident(home, { kind: "quota_released", source: "workflow", workflow: "" });
    }
    return { held: false, holdUntil: null, pauseId: null, scope: null };
  }
  const policy = resolveCronPolicy(state);
  const holdUntil = new Date(now.getTime() + policy.quotaHoldMinutes * 60_000).toISOString();
  const isNewStamp = !hadStamp;
  state.quota_hold_until = holdUntil;
  saveWorkflowTriggerState(home, state);
  appendCronIncident(home, {
    kind: "quota_held", source: "workflow", workflow: "",
    pause_id: pause.id, scope: pause.scope, hold_until: holdUntil,
    ...(isNewStamp ? {} : { note: "戳过期、暂停仍在，续戳" }),
  });
  return { held: true, holdUntil, pauseId: pause.id, scope: pause.scope };
}

/**
 * 强制清掉 hold 戳（`nyra cron hold clear --yes`）。只清戳、不动成本暂停：
 * 暂停还在的话，下一轮触发前会重新打戳、重新挂起。清戳本身记一笔
 * quota_released 事故（带原因，免得账本里出现无缘无故的释放）。
 */
export function clearQuotaHold(home: string): void {
  const state = loadWorkflowTriggerState(home);
  state.quota_hold_until = null;
  saveWorkflowTriggerState(home, state);
  appendCronIncident(home, { kind: "quota_released", source: "workflow", workflow: "", note: "机主手动清戳" });
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

/** G-P1-38：本轮漏跑汇总（只记触发器与条数，明细进事故账）。 */
export interface MissedTriggerSummary {
  workflow: string;
  triggerIndex: number;
  /** 漏掉的分钟数。 */
  count: number;
  /** 是否按 once 策略补跑了一次。 */
  caughtUp: boolean;
}

export interface TriggerRoundResult {
  skipped: string | null;
  fired: TriggerFireResult[];
  /** G-P1-38：本轮因配额 hold 挂起时才有（不跑任何触发器）。 */
  held?: QuotaHoldInfo;
  /** G-P1-38：本轮记到的漏跑（空数组 = 没漏跑）。 */
  missed?: MissedTriggerSummary[];
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
  if (status === "failed") {
    // G-P1-38：触发失败也是事故，事故账里留一笔（证据链已有全量记录，
    // 这里只记元数据 + 前 200 字错误，方便 `nyra cron incidents` 一眼看到）。
    appendCronIncident(home, {
      kind: "failed", source: "workflow", workflow, trigger_index: triggerIndex,
      run_id: runId, error: (error ?? "").slice(0, 200),
    });
  }
  // O6：记一次触发结果——成功清零连败，失败满 10 次自动停用（先记事故 +
  // 运行事件再停，不存在“悄悄关了”的情况）。
  await recordTriggerResult(home, workflow, triggerIndex, status === "ok", error, runId);
  return { workflow, triggerIndex, triggerType, runId, status, ...(error ? { error } : {}) };
}

/**
 * 守护进程每轮调：到点的 schedule 触发器各跑一次（同一分钟不重复跑）。
 * 全局开关关着直接返回 skipped（不读注册表、不跑任何东西）。
 *
 * G-P1-38：
 *   - 配额 hold：先判 hold，挂起时整轮跳过（不跑、不推进 lastFired，
 *     漏掉的分钟等放行后由补跑逻辑处理）；
 *   - 漏跑补跑：每触发器先算漏掉的分钟（上次 lastFired 之后、当前分钟
 *     之前、窗口内的 cron 匹配分钟；没记过 lastFired 的不算漏跑）。
 *     策略 once 且本分钟没到点时补跑一次（最近一次漏掉的），其余漏掉
 *     的记 missed ×N；策略 skip 或本分钟正好到点时只记 missed ×N，
 *     本分钟的正常触发照常跑。同一触发器一轮最多跑一次。
 */
export async function runDueWorkflowTriggers(
  home: string,
  opts?: { now?: Date; workdir?: string; runFn?: WorkflowRunFn },
): Promise<TriggerRoundResult> {
  const now = opts?.now ?? new Date();
  const state = loadWorkflowTriggerState(home);
  if (!state.enabled) return { skipped: "触发器执行未开启（nyra workflow triggers enable --yes 开启）", fired: [] };
  const hold = evaluateQuotaHold(home, state, now);
  if (hold.held) {
    return {
      skipped: `配额 hold 中：成本上限已触顶（${hold.scope ?? "未知层"}），触发挂起至 ${hold.holdUntil ?? "未知"}，期间不跑任何触发器`,
      fired: [], held: hold, missed: [],
    };
  }
  const policy = resolveCronPolicy(state);
  const workdir = opts?.workdir ?? process.cwd();
  const fired: TriggerFireResult[] = [];
  const missed: MissedTriggerSummary[] = [];
  const minute = minuteKey(now);
  const windowStart = new Date(now.getTime() - policy.catchUpWindowMinutes * 60_000);
  for (const wf of listActiveWorkflowTriggers(home)) {
    if (fired.length >= MAX_RUNS_PER_ROUND) break;
    for (let i = 0; i < wf.triggers.length; i++) {
      if (fired.length >= MAX_RUNS_PER_ROUND) break;
      const t = wf.triggers[i];
      if (t.type !== "schedule" || !t.cron) continue;
      // O6：已自动停用的不跑（漏跑也不记）；低于 15 分钟下限的（手改注册表
      // 绕过激活才可能出现）在这里停用一次并记事故，之后不再跑。
      if (isTriggerDisabled(state, wf.name, i)) continue;
      if (isBelowFloorTrigger(t)) {
        await disableTrigger(home, wf.name, i, {
          failures: state.consecutive_failures?.[`${wf.name}\n${i}`] ?? 0,
          error: `定时触发器间隔低于 ${MIN_CRON_INTERVAL_MINUTES} 分钟下限（cron：${t.cron}）`,
        });
        continue;
      }
      const key = `${wf.name}\n${i}`;
      const dueNow = cronMatches(t.cron, now);
      const prevLast = state.lastFired[key];
      // 漏跑：上次记过的分钟之后、当前分钟之前、窗口内的匹配分钟。
      // 没记过 lastFired 的触发器不算漏跑（新建的触发器不背旧账）。
      const anchor = prevLast ? parseMinuteKey(prevLast) : null;
      const anchorInWindow = anchor && anchor.getTime() >= windowStart.getTime() ? anchor : (anchor ? windowStart : null);
      const missedMinutes = policy.catchUpWindowMinutes > 0 ? missedCronMinutes(t.cron, anchorInWindow, now) : [];
      let caughtUpThisRound = false;
      if (missedMinutes.length > 0) {
        if (policy.catchUp === "once" && !dueNow && fired.length < MAX_RUNS_PER_ROUND) {
          // 补跑一次：最近一次漏掉的分钟。先记已触发再执行（与正常路径同款）。
          state.lastFired[key] = minute;
          saveWorkflowTriggerState(home, state);
          const latest = missedMinutes[missedMinutes.length - 1];
          const r = await fireOne(home, wf.name, i, "schedule", workdir, opts?.runFn, {
            cron: t.cron, catch_up: true, scheduled_minute: minuteKey(latest),
          });
          fired.push(r);
          caughtUpThisRound = true;
          appendCronIncident(home, {
            kind: "caught_up", source: "workflow", workflow: wf.name, trigger_index: i,
            scheduled_minute: minuteKey(latest), policy: "once", run_id: r.runId,
            ...(r.status === "failed" ? { error: (r.error ?? "").slice(0, 200) } : {}),
          });
          if (missedMinutes.length - 1 > 0) {
            appendCronIncident(home, {
              kind: "missed", source: "workflow", workflow: wf.name, trigger_index: i,
              count: missedMinutes.length - 1, policy: "once",
            });
          }
        } else {
          // skip 策略，或本分钟正好到点（正常触发照常跑，漏掉的只记账）。
          if (!dueNow) {
            state.lastFired[key] = minute;
            saveWorkflowTriggerState(home, state);
          }
          appendCronIncident(home, {
            kind: "missed", source: "workflow", workflow: wf.name, trigger_index: i,
            count: missedMinutes.length, policy: policy.catchUp,
          });
        }
        missed.push({ workflow: wf.name, triggerIndex: i, count: missedMinutes.length, caughtUp: caughtUpThisRound });
      }
      if (dueNow && !caughtUpThisRound && prevLast !== minute) {
        // 先记已触发（同一分钟不重复跑），再执行；执行失败也只记证据，不重跑这一分钟。
        state.lastFired[key] = minute;
        saveWorkflowTriggerState(home, state);
        fired.push(await fireOne(home, wf.name, i, "schedule", workdir, opts?.runFn, { cron: t.cron }));
      }
    }
  }
  return { skipped: null, fired, missed };
}

/**
 * 事件触发：网关收到 webhook / Gmail 轮询派发事件后调。同一事件只触发一次
 * （按事件 id 去重）；事件 payload 不注进工作流输入（不可信外部数据），
 * 触发记录进证据链。G-P1-38：配额 hold 时事件触发同样挂起（不跑、不记
 * firedEvents——事件本身没丢，网关侧仍有记录，放行后重派事件才会再触发）。
 */
export async function fireWorkflowEventTriggers(
  home: string,
  event: IncomingEvent,
  opts?: { now?: Date; workdir?: string; runFn?: WorkflowRunFn },
): Promise<TriggerRoundResult> {
  const now = opts?.now ?? new Date();
  const state = loadWorkflowTriggerState(home);
  if (!state.enabled) return { skipped: "触发器执行未开启（nyra workflow triggers enable --yes 开启）", fired: [] };
  const hold = evaluateQuotaHold(home, state, now);
  if (hold.held) {
    return {
      skipped: `配额 hold 中：成本上限已触顶（${hold.scope ?? "未知层"}），事件触发挂起至 ${hold.holdUntil ?? "未知"}`,
      fired: [], held: hold, missed: [],
    };
  }
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
      // O6：已自动停用的不跑。
      if (isTriggerDisabled(state, wf.name, i)) continue;
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
  return { skipped: null, fired, missed: [] };
}

/** CLI status 用：开关 + 各 active 工作流的触发器清单 + G-P1-38 策略与 hold + O6 护栏。 */
export function describeWorkflowTriggers(home: string): {
  enabled: boolean;
  workflows: ActiveWorkflowTriggers[];
  policy: CronPolicy;
  hold: QuotaHoldInfo;
  guardrails: ReturnType<typeof describeRoutineGuardrails>;
  disabled: Array<{ workflow: string; triggerIndex: number; failures: number; error: string; at: string }>;
} {
  const state = loadWorkflowTriggerState(home);
  const disabled = Object.entries(state.disabled_triggers ?? {}).map(([key, v]) => {
    const [workflow, idx] = key.split("\n");
    return { workflow: workflow ?? key, triggerIndex: Number(idx ?? 0), failures: v.failures, error: v.error, at: v.at };
  });
  return {
    enabled: state.enabled,
    workflows: listActiveWorkflowTriggers(home),
    policy: resolveCronPolicy(state),
    hold: describeQuotaHold(home),
    guardrails: describeRoutineGuardrails(home),
    disabled,
  };
}
