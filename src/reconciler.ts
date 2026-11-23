// src/reconciler.ts — Pi Bot 借鉴第 3 条：群组自推进的 reconciler 模式。
//
// Pi Bot 的 reconciler 是双通道：每秒扫一遍运行中的步骤 + 步骤结束事件触发
// 的 settled()；运行记录全落盘，崩溃后 recover() 续跑。Nyra 的任务板 +
// 崩溃自续 + Heartbeat 已有类似的东西，但缺中间那层：步骤 running 超过阈
// 值没动静就标出来、问人或自动重试，而不是等 Heartbeat 推断。本批补的就
// 是这层——卡住步骤看门狗。
//
// 看门狗只盯任务板上 working 的任务，不碰别的：
//   - 进展信号 = 任务 updatedAt、绑的运行 updated_at、子 agent 心跳
//     lastHeartbeatAt 三者里最新的一处（任一处动了都算有进展，不误判长任务）；
//   - 卡住（静默超过 stuck_after_seconds）时按阶梯处理：先标出来（提醒，
//     收件箱留一条 + 事件进证据链），下次扫到仍卡着就自动重排（回队列等下
//     一轮 tick，最多 max_retries 次），重排用完了还卡着就进 blocked 只等人；
//   - 绑的运行已进终态失败时走 fail 路径（与 sweepStaleWorking 同款）；
//     运行已结束但任务仍在 working 时只记一条 run_done 事件（等验证证据
//     才能标 done，看门狗不替人标完成）。
//
// 刹车（一条不丢）：
//   - 自动巡查默认关（reconciler.enabled 默认 false，须显式开；手动
//     `nyra reconciler scan` 是人当场点的动作，不受开关限制）；
//   - 重排只是把任务放回队列（fail 路径，attempts+1，满 maxAttempts 照
//     样熔断进 blocked），真正再跑走下一轮 tick 的正常派发，各道门照旧；
//   - 看门狗不调模型、不写任务板账本以外的文件、不对外发；无人值守续跑
//     照样强制只读（resume.ts 既有口径，本批不动）；
//   - 超限进 blocked 后只能由人 reset，不自动放行。
//
// 账本 ~/.nyra/reconciler.json（只记上次扫描时间与已提醒过的 run_done，
// 原子写 0600，损坏先备份再抛错）；看门狗自己的动作另有两处审计：任务板
// history（每一步都记）与运行事件（有 runId 时镜像进证据链）。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, resolveHome, saveConfig } from "./config.ts";
import { RunStore } from "./runs.ts";
import { blockKanbanTask, failKanbanTask, listKanbanTasks, loadKanbanStore, saveKanbanStore, type KanbanTask } from "./kanban.ts";
import { findRunStore, loadSubagentRegistry } from "./resume.ts";
import { appendInbox } from "./tasks.ts";

export class ReconcilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcilerError";
  }
}

/** 默认 30 分钟无进展算卡住（整数 60–86400 秒，非法回默认）。 */
export const DEFAULT_STUCK_AFTER_SECONDS = 1800;
/** 每任务默认最多自动重排 2 次（整数 0–5，非法回默认）。 */
export const DEFAULT_MAX_RETRIES = 2;
/** 守护进程默认每 5 分钟扫一遍（整数 60–3600 秒，非法回默认）。 */
export const DEFAULT_SCAN_INTERVAL_SECONDS = 300;
/** 运行已结束的提醒去重表最多留几条（防账本无限长）。 */
export const MAX_NOTED_RUN_DONE = 50;

export interface ReconcilerSettings {
  enabled: boolean;
  stuckAfterSeconds: number;
  maxRetries: number;
  scanIntervalSeconds: number;
}

/** 与 resolveTrustLadderSettings 同款口径：逐字段校验，非法回默认。 */
export function resolveReconcilerSettings(config: Record<string, unknown>): ReconcilerSettings {
  const raw = (config.reconciler ?? {}) as Record<string, unknown>;
  const stuck = raw.stuck_after_seconds;
  const stuckAfterSeconds = typeof stuck === "number" && Number.isInteger(stuck) && stuck >= 60 && stuck <= 86400
    ? stuck : DEFAULT_STUCK_AFTER_SECONDS;
  const retries = raw.max_retries;
  const maxRetries = typeof retries === "number" && Number.isInteger(retries) && retries >= 0 && retries <= 5
    ? retries : DEFAULT_MAX_RETRIES;
  const interval = raw.scan_interval_seconds;
  const scanIntervalSeconds = typeof interval === "number" && Number.isInteger(interval) && interval >= 60 && interval <= 3600
    ? interval : DEFAULT_SCAN_INTERVAL_SECONDS;
  return { enabled: raw.enabled === true, stuckAfterSeconds, maxRetries, scanIntervalSeconds };
}

export interface ReconcilerLedger {
  version: 1;
  /** 上次扫描时间（守护进程按 scan_interval_seconds 节流用）。 */
  lastScanAt: string | null;
  /** 已记过 run_done 事件的运行 id（同一运行只提醒一次，不重复刷事件）。 */
  notedRunDone: string[];
}

export function reconcilerPath(home: string): string {
  return join(home, "reconciler.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadReconcilerLedger(home: string): ReconcilerLedger {
  const path = reconcilerPath(home);
  if (!existsSync(path)) return { version: 1, lastScanAt: null, notedRunDone: [] };
  if (lstatSync(path).isSymbolicLink()) throw new ReconcilerError("看门狗账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new ReconcilerError("看门狗账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as ReconcilerLedger).version !== 1 ||
    !Array.isArray((raw as ReconcilerLedger).notedRunDone)) {
    backupCorrupt(path);
    throw new ReconcilerError("看门狗账本格式无效，已备份");
  }
  return raw as ReconcilerLedger;
}

export function saveReconcilerLedger(home: string, ledger: ReconcilerLedger): void {
  const path = reconcilerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ReconcilerError("看门狗账本不能是符号链接");
  const tmp = join(dirname(path), `.reconciler-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(ledger, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

/** 绑的运行已进终态失败的状态（与 sweepStaleWorking 同款口径）。 */
export const TERMINAL_FAILED_RUN_STATUSES = ["failed", "interrupted", "verify_failed"];
/** 运行已结束（任务却仍在 working）的状态。注意 RUN_STATUSES 里没有
 * "completed"——完成是 verified / completed_unverified；incomplete 是轮数
 * 到顶停下（timeline 的 TERMINAL_STATUSES 也含它），resume 还能续跑，所
 * 以算“已结束”不算“失败”。 */
export const TERMINAL_DONE_RUN_STATUSES = ["verified", "completed_unverified", "incomplete"];

/** 进展信号的来源：调用方注入（测试传假函数只验状态机，不碰运行记录）。 */
export interface ReconcilerProviders {
  now?: Date;
  runStatus?: (runId: string) => string | null;
  /** 绑的运行上次有动静的时间（ISO）；默认读运行记录的 updated_at。 */
  runProgressAt?: (runId: string) => string | null;
  /** 子 agent 心跳上次有动静的时间（ISO）；默认读注册表的 lastHeartbeatAt。 */
  subagentHeartbeatAt?: (runId: string) => string | null;
}

export function defaultRunStatus(home: string): (runId: string) => string | null {
  return (runId) => findRunStore(home, runId)?.state.status ?? null;
}

export function defaultRunProgressAt(home: string): (runId: string) => string | null {
  return (runId) => findRunStore(home, runId)?.state.updated_at ?? null;
}

export function defaultSubagentHeartbeatAt(home: string): (runId: string) => string | null {
  return (runId) => {
    try {
      return loadSubagentRegistry(home).runs.find((r) => r.runId === runId)?.lastHeartbeatAt ?? null;
    } catch { return null; }
  };
}

/** 有运行上下文时把看门狗动作镜像进运行事件（证据链）；没上下文时任务板
 *  history 就是审计，不静默丢——mirror 失败一律吞掉，只写账本。 */
function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

function parseMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/** 三处进展信号里最新的一处（任务 updatedAt、运行 updated_at、子 agent
 * 心跳）；任一处动了都算有进展，长任务不会被误判卡住。 */
export function lastProgressMs(
  task: KanbanTask,
  providers: Pick<ReconcilerProviders, "runProgressAt" | "subagentHeartbeatAt">,
): number {
  const candidates = [parseMs(task.updatedAt)];
  if (task.runId) {
    candidates.push(parseMs(providers.runProgressAt?.(task.runId) ?? null));
    candidates.push(parseMs(providers.subagentHeartbeatAt?.(task.runId) ?? null));
  }
  const valid = candidates.filter((ms) => Number.isFinite(ms));
  return valid.length ? Math.max(...valid) : NaN;
}

function setStuckFlag(home: string, task: KanbanTask, now: Date): void {
  const store = loadKanbanStore(home);
  const row = store.tasks.find((t) => t.id === task.id);
  if (!row) return;
  row.stuckAt = now.toISOString();
  row.stuckFlags += 1;
  // 注意：这里不碰 updatedAt——标记本身不是进展，碰了会把静默时钟归零，
  // 下一轮扫描就量不出“还卡着”，重排会被无限推迟。
  store.history.push({ at: now.toISOString(), action: "reconciler_flagged", taskId: task.id, note: `看门狗标卡住（第 ${row.stuckFlags} 次）` });
  if (store.history.length > 500) store.history.splice(0, store.history.length - 500);
  saveKanbanStore(home, store);
}

function clearStuckFlag(home: string, task: KanbanTask, now: Date, note: string): void {
  const store = loadKanbanStore(home);
  const row = store.tasks.find((t) => t.id === task.id);
  if (!row || !row.stuckAt) return;
  row.stuckAt = null;
  // 同 setStuckFlag：清标记不是进展，不碰 updatedAt。
  store.history.push({ at: now.toISOString(), action: "reconciler_recovered", taskId: task.id, note });
  if (store.history.length > 500) store.history.splice(0, store.history.length - 500);
  saveKanbanStore(home, store);
}

function bumpWatchdogRetries(home: string, taskId: string): number {
  const store = loadKanbanStore(home);
  const row = store.tasks.find((t) => t.id === taskId);
  if (!row) return 0;
  row.watchdogRetries += 1;
  saveKanbanStore(home, store);
  return row.watchdogRetries;
}

export type ReconcilerAction = "flagged" | "retried" | "blocked" | "recovered" | "run_done" | "failed" | "ok";

export interface ReconcileOneResult {
  taskId: string;
  action: ReconcilerAction;
  idleSeconds: number;
  detail: string;
}

/**
 * 单个 working 任务的一次调和（扫描与 settled 共用的核心；Pi Bot 的
 * reconcile() 同款形状——先看运行终态，再看静默时长，最后按阶梯处理）。
 * 只对 working 任务调；别的狀態直接返回 ok，不动。
 */
export function reconcileOne(
  home: string,
  task: KanbanTask,
  settings: ReconcilerSettings,
  providers: ReconcilerProviders = {},
  ledger?: ReconcilerLedger,
): ReconcileOneResult {
  const now = providers.now ?? new Date();
  const nowMs = now.getTime();
  if (task.status !== "working") return { taskId: task.id, action: "ok", idleSeconds: 0, detail: "不是 working 状态，看门狗不管" };
  const runStatus = task.runId ? (providers.runStatus?.(task.runId) ?? defaultRunStatus(home)(task.runId)) : null;
  // 绑的运行已进终态失败：走 fail 路径（attempts+1，满 3 次熔断进 blocked，
  // 与 sweepStaleWorking 同款），看门狗不另造一套失败语义。
  if (runStatus && TERMINAL_FAILED_RUN_STATUSES.includes(runStatus)) {
    const after = failKanbanTask(home, task.id, `运行 ${task.runId} 状态 ${runStatus}`);
    return { taskId: task.id, action: "failed", idleSeconds: 0, detail: `绑的运行已失败（${runStatus}），走 fail 路径，现为 ${after.status}` };
  }
  // 运行已结束但任务仍在 working：只提醒一次（账本去重），不替人标完成——
  // 完成须附验证证据，人说了算；任务也不算卡住（等验证不是没进展）。
  if (runStatus && TERMINAL_DONE_RUN_STATUSES.includes(runStatus)) {
    const ownLedger = ledger ?? loadReconcilerLedger(home);
    if (!ownLedger.notedRunDone.includes(task.runId!)) {
      ownLedger.notedRunDone.push(task.runId!);
      if (ownLedger.notedRunDone.length > MAX_NOTED_RUN_DONE) ownLedger.notedRunDone.splice(0, ownLedger.notedRunDone.length - MAX_NOTED_RUN_DONE);
      if (!ledger) saveReconcilerLedger(home, ownLedger);
      mirrorEvent(home, task.runId, "reconciler_run_done", { task_id: task.id, run_id: task.runId, status: runStatus });
      return { taskId: task.id, action: "run_done", idleSeconds: 0, detail: `运行已结束（${runStatus}），任务仍在 working，等验证证据才能标完成` };
    }
    return { taskId: task.id, action: "ok", idleSeconds: 0, detail: `运行已结束（${runStatus}），已提醒过，等验证证据` };
  }
  // Pi Bot 的 reconciler 也跳过“执行体 waiting 或有待回答的问题”：运行在等
  // 人工批准或人工回环时不是卡住，别标、别重排，等批本身就是下一步。
  if (runStatus === "awaiting_approval" || runStatus === "awaiting_interrupt") {
    return { taskId: task.id, action: "ok", idleSeconds: 0, detail: runStatus === "awaiting_interrupt" ? "运行在等人工回环，不算卡住" : "运行在等人工批准，不算卡住" };
  }
  const progressMs = lastProgressMs(task, {
    runProgressAt: providers.runProgressAt ?? defaultRunProgressAt(home),
    subagentHeartbeatAt: providers.subagentHeartbeatAt ?? defaultSubagentHeartbeatAt(home),
  });
  const idleSeconds = Number.isFinite(progressMs) ? Math.max(0, Math.floor((nowMs - progressMs) / 1000)) : 0;
  // 有进展且之前标过卡住：本轮 episode 结束，清标记（stuckFlags 累计留着）。
  if (idleSeconds <= settings.stuckAfterSeconds) {
    if (task.stuckAt) {
      clearStuckFlag(home, task, now, `恢复进展（静默 ${idleSeconds} 秒，未超 ${settings.stuckAfterSeconds} 秒阈值）`);
      mirrorEvent(home, task.runId, "reconciler_recovered", { task_id: task.id, idle_seconds: idleSeconds });
      return { taskId: task.id, action: "recovered", idleSeconds, detail: `恢复进展（静默 ${idleSeconds} 秒），卡住标记已清` };
    }
    return { taskId: task.id, action: "ok", idleSeconds, detail: `有进展（静默 ${idleSeconds} 秒，未超阈值）` };
  }
  // 卡住了，按阶梯处理：先标出来 → 再自动重排（轮次上限内）→ 超限进 blocked。
  if (!task.stuckAt) {
    setStuckFlag(home, task, now);
    mirrorEvent(home, task.runId, "reconciler_stuck", { task_id: task.id, idle_seconds: idleSeconds, retries: task.watchdogRetries });
    try {
      appendInbox(`reconciler-${task.id}`, "reconciler_stuck", `任务板任务 ${task.title.slice(0, 60)} 已 ${idleSeconds} 秒无进展（超过 ${settings.stuckAfterSeconds} 秒），看门狗已标记；再无进展将自动重排，最多 ${settings.maxRetries} 次`, home);
    } catch { /* 收件箱写不上不破坏标记 */ }
    return { taskId: task.id, action: "flagged", idleSeconds, detail: `卡住 ${idleSeconds} 秒，已标记（第 ${task.stuckFlags + 1} 次）；再无进展将自动重排` };
  }
  if (task.watchdogRetries < settings.maxRetries) {
    const after = failKanbanTask(home, task.id, `看门狗：卡住 ${idleSeconds} 秒无进展，第 ${task.watchdogRetries + 1}/${settings.maxRetries} 次自动重排`);
    if (after.status === "blocked") {
      mirrorEvent(home, task.runId, "reconciler_blocked", { task_id: task.id, idle_seconds: idleSeconds, retries: task.watchdogRetries });
      return { taskId: task.id, action: "blocked", idleSeconds, detail: `重排时熔断（失败 ${after.attempts}/${after.maxAttempts} 次），已进 blocked，只等人 reset` };
    }
    const retries = bumpWatchdogRetries(home, task.id);
    mirrorEvent(home, task.runId, "reconciler_retried", { task_id: task.id, idle_seconds: idleSeconds, retries, attempts: after.attempts });
    return { taskId: task.id, action: "retried", idleSeconds, detail: `卡住 ${idleSeconds} 秒，第 ${retries}/${settings.maxRetries} 次自动重排回队列（失败 ${after.attempts}/${after.maxAttempts} 次）` };
  }
  const blocked = blockKanbanTask(home, task.id, `看门狗：卡住 ${idleSeconds} 秒无进展，自动重排已用完 ${settings.maxRetries} 次，停下等人`);
  void blocked;
  mirrorEvent(home, task.runId, "reconciler_blocked", { task_id: task.id, idle_seconds: idleSeconds, retries: task.watchdogRetries });
  return { taskId: task.id, action: "blocked", idleSeconds, detail: `卡住 ${idleSeconds} 秒，自动重排已用完 ${settings.maxRetries} 次，已进 blocked，只等人 reset` };
}

export interface ReconcilerScanReport {
  scanned: number;
  stuck: number;
  flagged: string[];
  retried: string[];
  blocked: string[];
  recovered: string[];
  runDone: string[];
  failed: string[];
  skipped: string | null;
}

function emptyReport(): ReconcilerScanReport {
  return { scanned: 0, stuck: 0, flagged: [], retried: [], blocked: [], recovered: [], runDone: [], failed: [], skipped: null };
}

/** 扫一遍在跑的任务板任务（Pi Bot reconciler 的定时扫描通道）。 */
export function scanReconciler(
  home: string,
  opts?: { settings?: ReconcilerSettings; providers?: ReconcilerProviders },
): ReconcilerScanReport {
  const settings = opts?.settings ?? resolveReconcilerSettings(loadConfig(home));
  const report = emptyReport();
  const ledger = loadReconcilerLedger(home);
  ledger.lastScanAt = (opts?.providers?.now ?? new Date()).toISOString();
  saveReconcilerLedger(home, ledger);
  const working = listKanbanTasks(home, { status: "working" });
  report.scanned = working.length;
  for (const task of working) {
    const r = reconcileOne(home, task, settings, opts?.providers ?? {}, ledger);
    if (r.action === "flagged") { report.stuck += 1; report.flagged.push(task.id); }
    else if (r.action === "retried") { report.stuck += 1; report.retried.push(task.id); }
    else if (r.action === "blocked") { report.stuck += 1; report.blocked.push(task.id); }
    else if (r.action === "recovered") report.recovered.push(task.id);
    else if (r.action === "run_done") report.runDone.push(task.id);
    else if (r.action === "failed") report.failed.push(task.id);
  }
  // run_done 的去重表可能在扫描里改了（reconcileOne 直接改了传入的 ledger
  // 对象），收尾时写回一次。
  saveReconcilerLedger(home, ledger);
  return report;
}

/** 守护进程每轮调：未启用或未到扫描间隔时跳过（只记 skipped，不扫）。 */
export function runDueReconciliations(
  home: string,
  opts?: { force?: boolean; providers?: ReconcilerProviders },
): ReconcilerScanReport {
  const settings = resolveReconcilerSettings(loadConfig(home));
  if (!settings.enabled && !opts?.force) {
    return { ...emptyReport(), skipped: "看门狗未启用（nyra reconciler enable 开启自动巡查）" };
  }
  const now = opts?.providers?.now ?? new Date();
  if (!opts?.force) {
    const ledger = loadReconcilerLedger(home);
    if (ledger.lastScanAt) {
      const last = Date.parse(ledger.lastScanAt);
      if (Number.isFinite(last) && now.getTime() - last < settings.scanIntervalSeconds * 1000) {
        return { ...emptyReport(), skipped: "未到扫描间隔" };
      }
    }
  }
  return scanReconciler(home, { settings, providers: opts?.providers });
}

/**
 * 步骤结束事件通道（Pi Bot reconciler 的 settled() 同款）：一个运行结束
 * 时立刻调和它绑的任务板任务，不用等下一轮扫描。没绑任务板任务时返回
 * found: false，不报错。
 */
export function settleReconcilerRun(
  home: string,
  runId: string,
  opts?: { settings?: ReconcilerSettings; providers?: ReconcilerProviders },
): { found: boolean; result: ReconcileOneResult | null } {
  const settings = opts?.settings ?? resolveReconcilerSettings(loadConfig(home));
  const task = listKanbanTasks(home, { status: "working" }).find((t) => t.runId === runId);
  if (!task) return { found: false, result: null };
  const result = reconcileOne(home, task, settings, opts?.providers ?? {});
  return { found: true, result };
}

const USAGE =
  "用法：nyra reconciler <scan|status|enable|disable|config|settle> [选项]\n" +
  "  scan              立刻扫一遍在跑的任务板任务（人当场点的动作，不受 enabled 开关限制）\n" +
  "  status [--json]   看门狗配置、上次扫描时间与在跑/卡住任务数\n" +
  "  enable            开启自动巡查（守护进程按扫描间隔扫；只重排/标记/停下，不调模型、不对外发）\n" +
  "  disable           关闭自动巡查（手动 scan 照常能用）\n" +
  "  config [--stuck-after-seconds N（60–86400，默认 1800）] [--max-retries N（0–5，默认 2）] [--scan-interval-seconds N（60–3600，默认 300）]\n" +
  "  settle <运行 id>  一个运行结束时立刻调和它绑的任务板任务（不用等下一轮扫描）\n";

function writeSettings(home: string, patch: Partial<ReconcilerSettings>): ReconcilerSettings {
  const current = resolveReconcilerSettings(loadConfig(home));
  const next: ReconcilerSettings = { ...current, ...patch };
  saveConfig(home, {
    reconciler: {
      enabled: next.enabled,
      stuck_after_seconds: next.stuckAfterSeconds,
      max_retries: next.maxRetries,
      scan_interval_seconds: next.scanIntervalSeconds,
    },
  });
  return next;
}

export function handleReconciler(argv: string[], home: string): number {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const getInt = (flag: string): number | undefined => {
    const v = get(flag);
    if (v === undefined) return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  try {
    if (action === "scan") {
      const report = scanReconciler(resolvedHome);
      const parts = [`扫完 ${report.scanned} 个在跑任务`];
      if (report.flagged.length) parts.push(`标卡住 ${report.flagged.length} 个（${report.flagged.join("、")}）`);
      if (report.retried.length) parts.push(`自动重排 ${report.retried.length} 个（${report.retried.join("、")}）`);
      if (report.blocked.length) parts.push(`停下等人 ${report.blocked.length} 个（${report.blocked.join("、")}）`);
      if (report.recovered.length) parts.push(`恢复进展 ${report.recovered.length} 个`);
      if (report.runDone.length) parts.push(`运行已结束、等验证 ${report.runDone.length} 个`);
      if (report.failed.length) parts.push(`运行已失败、走 fail 路径 ${report.failed.length} 个`);
      process.stdout.write(parts.join("；") + "。\n");
      return 0;
    }
    if (action === "status") {
      const settings = resolveReconcilerSettings(loadConfig(resolvedHome));
      const ledger = loadReconcilerLedger(resolvedHome);
      const working = listKanbanTasks(resolvedHome, { status: "working" });
      const stuck = working.filter((t) => t.stuckAt !== null);
      const blocked = listKanbanTasks(resolvedHome, { status: "blocked" });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify({ settings, lastScanAt: ledger.lastScanAt, working: working.length, stuck: stuck.map((t) => t.id), blocked: blocked.length }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(
        `看门狗：${settings.enabled ? "自动巡查已开启" : "自动巡查未开启（只手动扫描）"}；` +
        `${settings.stuckAfterSeconds} 秒无进展算卡住，每任务最多自动重排 ${settings.maxRetries} 次，守护进程每 ${settings.scanIntervalSeconds} 秒扫一遍。\n` +
        `上次扫描：${ledger.lastScanAt ?? "未扫过"}；在跑 ${working.length} 个，其中已标卡住 ${stuck.length} 个；blocked ${blocked.length} 个（只等人 reset）。\n`,
      );
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const next = writeSettings(resolvedHome, { enabled: action === "enable" });
      process.stdout.write(next.enabled
        ? "看门狗自动巡查已开启：守护进程按扫描间隔扫在跑任务，卡住先标记、再按轮次上限自动重排、超限进 blocked 只等人；重排只是回队列，不调模型、不对外发。\n"
        : "看门狗自动巡查已关闭（手动 nyra reconciler scan 照常能用）。\n");
      return 0;
    }
    if (action === "config") {
      const stuck = getInt("--stuck-after-seconds");
      const retries = getInt("--max-retries");
      const interval = getInt("--scan-interval-seconds");
      if (stuck === undefined && retries === undefined && interval === undefined) {
        process.stderr.write("错误：用法：nyra reconciler config [--stuck-after-seconds N] [--max-retries N] [--scan-interval-seconds N]\n");
        return 2;
      }
      if (stuck !== undefined && (stuck < 60 || stuck > 86400)) {
        process.stderr.write("错误：--stuck-after-seconds 必须是 60 到 86400 的整数\n");
        return 2;
      }
      if (retries !== undefined && (retries < 0 || retries > 5)) {
        process.stderr.write("错误：--max-retries 必须是 0 到 5 的整数\n");
        return 2;
      }
      if (interval !== undefined && (interval < 60 || interval > 3600)) {
        process.stderr.write("错误：--scan-interval-seconds 必须是 60 到 3600 的整数\n");
        return 2;
      }
      const patch: Partial<ReconcilerSettings> = {};
      if (stuck !== undefined) patch.stuckAfterSeconds = stuck;
      if (retries !== undefined) patch.maxRetries = retries;
      if (interval !== undefined) patch.scanIntervalSeconds = interval;
      const next = writeSettings(resolvedHome, patch);
      process.stdout.write(`看门狗配置已更新：${next.stuckAfterSeconds} 秒无进展算卡住，每任务最多自动重排 ${next.maxRetries} 次，守护进程每 ${next.scanIntervalSeconds} 秒扫一遍（自动巡查${next.enabled ? "已开启" : "未开启"}）。\n`);
      return 0;
    }
    if (action === "settle") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra reconciler settle <运行 id>\n");
        return 2;
      }
      const { found, result } = settleReconcilerRun(resolvedHome, runId);
      if (!found) {
        process.stdout.write(`运行 ${runId} 没绑在跑的任务板任务，无事可做。\n`);
        return 0;
      }
      process.stdout.write(`任务 ${result!.taskId}：${result!.detail}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 reconciler ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
