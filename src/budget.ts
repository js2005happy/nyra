// src/budget.ts — 可靠性打磨第 2 项第一批：并发预算预留。
//
// 问题：以前成本只在调用返回后才检查——没配单价或 provider 没报用量时
// 继续跑（estimateCost 算不出就当没超），并行任务的在途花费互相看不见，
// 每个会话拿的都是创建时刻的本月已花快照。本模块补一本所有会话共享的
// 预留账本：模型调用发出前先按单价与预估量预留额度，预留失败直接拒绝、
// 不发请求；调用返回后按实际花费结算，多退少补。
//
// 口径：
//   - 账本只记用量数字（预留多少、结算多少），不记任务文本、不记 prompt。
//   - 预留是对“上限”的预留，不是对“账单”的承诺：结算以 provider 实报
//     usage × 单价为准；算不出实际花费时释放预留、不编数字（结算为
//     null 的行就是“花了但没法计价”，与用量账本同款诚实边界）。
//   - 同一笔钱在每一层上限里都占着：一条预留同时扣单次上限
//     与分层上限的剩余额度——保守，只会早拒、不会超支。
//   - 过期预留不拦路：TTL 到了、或 owner 进程已死，读时就不计入；
//     写盘时把过期行标 released 留痕，不静默删记录。
//   - 本模块是叶子：只 import cost.ts 与 config.ts，不 import agent、
//     costCaps、parallelDelegate，任何模块都能 import 它。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { computeCostUsd, CHARS_PER_TOKEN, type Pricing } from "./cost.ts";

export class BudgetError extends Error {}

export const BUDGET_LEDGER_FILE = "budget-ledger.json";
/** 单次调用预留的默认 TTL：1 小时。一次模型调用正常只要秒到分钟级；超过
 *  1 小时还没结算，调用本身大概率已经死了，不让它继续占着额度。 */
export const DEFAULT_RESERVATION_TTL_MS = 3_600_000;
const MAX_HISTORY = 200;

export type ReservationReason = "next-call" | "parallel-thread" | "manual" | "group-turn";
export type ReservationStatus = "reserved" | "settled" | "released";

export interface BudgetReservation {
  id: string;
  owner: string;
  amountUsd: number;
  reason: ReservationReason;
  /** 预留时最紧的那一层上限（run/tiered:<scope>），只用于展示。 */
  bindingScope: string | null;
  createdAt: string;
  expiresAt: string;
  /** 预留时进程 pid：读时 pid 已死算过期（崩溃的进程不留僵尸预留）。 */
  pid: number | null;
  status: ReservationStatus;
  /** 结算的实际花费（美元）；未结算、或算不出时为 null，不编 0。 */
  settledUsd: number | null;
}

export interface BudgetLedgerStore {
  version: 1;
  reservations: BudgetReservation[];
}

/** 一层上限的当前状态（调用方拼，账本只做纯判定）。 */
export interface ReserveLimit {
  scope: string;
  limitUsd: number | null;
  spentUsd: number;
}

export interface ReserveCheck {
  allowed: boolean;
  reason?: string;
  bindingScope?: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newReservationId(): string {
  return `rsv_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

/** 原子写 0600：先写同目录临时文件再 rename；旧文件是符号链接就拒绝。 */
function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new BudgetError(`${file} 不能是符号链接`);
  }
  const tmp = join(dirname(path), `.${file}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * 预算账本的跨进程互斥锁：目录即锁（mkdir 原子创建，EEXIST 即已被占）。
 * 锁目录里放 owner.json（pid + 建锁时间）。持有者崩溃时锁不会永远卡住：
 * owner 进程已死、或锁超过 BUDGET_LOCK_STALE_MS 未释放，都算 stale、可由
 * 后来者抢走（先整目录删掉再重建；两个抢锁者同时删，mkdir 的原子性再决
 * 胜负）。锁只护“读-改-写”这一段（毫秒级），不是长期持有；超过
 * BUDGET_LOCK_ACQUIRE_TIMEOUT_MS 拿不到就抛错，不静默等、不假装写成功。
 * 读侧（active/list/get）不加锁：写盘是 rename 原子写，读不到撕裂内容，
 * 读到稍旧的版本对展示无害。
 */
const BUDGET_LOCK_DIR = ".budget-ledger.lock";
const BUDGET_LOCK_STALE_MS = 30_000;
const BUDGET_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const BUDGET_LOCK_RETRY_MS = 10;

interface BudgetLockOwner { pid: number; createdAt: number; }

function budgetLockDir(home: string): string {
  return join(resolveHome(home), BUDGET_LOCK_DIR);
}

function readBudgetLockOwner(dir: string): BudgetLockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "owner.json"), "utf-8")) as Partial<BudgetLockOwner>;
    if (typeof raw.pid !== "number" || typeof raw.createdAt !== "number") return null;
    return { pid: raw.pid, createdAt: raw.createdAt };
  } catch {
    return null;
  }
}

function budgetLockAgeMs(dir: string, owner: BudgetLockOwner | null): number {
  if (owner) return Date.now() - owner.createdAt;
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** 拿锁（阻塞重试到超时）；返回释放函数（只删自己的锁，幂等）。 */
export function acquireBudgetLock(home: string, opts: { timeoutMs?: number } = {}): () => void {
  const dir = budgetLockDir(home);
  mkdirSync(resolveHome(home), { recursive: true });
  const me: BudgetLockOwner = { pid: process.pid, createdAt: Date.now() };
  const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : BUDGET_LOCK_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      try {
        writeFileSync(join(dir, "owner.json"), JSON.stringify(me), "utf-8");
      } catch { /* owner 写不上不影响锁本身，stale 判断回落到目录 mtime */ }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // 只删自己的锁：锁被别人抢走后（stale 回收），不能替别人解锁。
        const cur = readBudgetLockOwner(dir);
        if (cur && cur.pid === me.pid && cur.createdAt === me.createdAt) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      const owner = readBudgetLockOwner(dir);
      const stale = (owner !== null && (!isPidAlive(owner.pid) || Date.now() - owner.createdAt > BUDGET_LOCK_STALE_MS)) ||
        (owner === null && budgetLockAgeMs(dir, null) > BUDGET_LOCK_STALE_MS);
      if (stale) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new BudgetError(`预算账本正被另一进程占用（${BUDGET_LOCK_DIR}），${timeoutMs / 1000} 秒内没拿到锁；稍后重试，不要手动删锁目录（stale 锁会自动回收）。`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUDGET_LOCK_RETRY_MS);
    }
  }
}

/** 在锁内跑一段账本写操作（读-改-写原子化）。 */
function withBudgetLock<T>(home: string, fn: () => T): T {
  const release = acquireBudgetLock(home);
  try {
    return fn();
  } finally {
    release();
  }
}

function isLedgerStore(raw: unknown): raw is BudgetLedgerStore {
  return !!raw && typeof raw === "object" && (raw as BudgetLedgerStore).version === 1 &&
    Array.isArray((raw as BudgetLedgerStore).reservations);
}

export function budgetLedgerPath(home: string): string {
  return join(resolveHome(home), BUDGET_LEDGER_FILE);
}

export function loadBudgetLedger(home: string): BudgetLedgerStore {
  const path = budgetLedgerPath(home);
  if (!existsSync(path)) return { version: 1, reservations: [] };
  if (lstatSync(path).isSymbolicLink()) throw new BudgetError(`${BUDGET_LEDGER_FILE} 不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new BudgetError(`${BUDGET_LEDGER_FILE} 损坏，已备份，请检查后恢复`);
  }
  if (!isLedgerStore(raw)) {
    backupCorrupt(path);
    throw new BudgetError(`${BUDGET_LEDGER_FILE} 格式无效，已备份`);
  }
  return raw;
}

function saveBudgetLedger(home: string, store: BudgetLedgerStore): void {
  saveJsonAtomic(home, BUDGET_LEDGER_FILE, store);
}

/** pid 还活着吗：ESRCH = 死了；EPERM = 活着但没权限发信号；其他错误按活着算（保守：不轻易放掉额度）。 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: unknown })?.code;
    if (code === "ESRCH") return false;
    return true;
  }
}

/** 一条 reserved 行是否已过期：TTL 到了，或 owner 进程已死。非 reserved 行永不过期。 */
export function reservationExpired(r: BudgetReservation, nowMs = Date.now()): boolean {
  if (r.status !== "reserved") return false;
  const exp = Date.parse(r.expiresAt);
  if (Number.isFinite(exp) && nowMs > exp) return true;
  // 手动预留（nyra budget reserve）是跨进程持有的：预留命令跑完退出是
  // 正常的，只按 TTL 过期。调用/线程预留的 owner 是正在跑的 agent 进程，
  // 死了说明进程崩了、预留没人结算，才按 pid 清掉。
  if (r.reason === "manual") return false;
  if (!isPidAlive(r.pid)) return true;
  return false;
}

/**
 * “金额未知则暂停”严格模式（默认开 = fail-closed）。
 * config.budget.strict_unknown_amount 只有显式 false 才关；缺键、非法值
 * 一律回 true——不配就是最严，不让一个手滑把刹车关了。
 * 注意：enforced 白名单只有顶层键，这项是嵌套键、不进 enforced（见 DESIGN.md）。
 */
export function resolveStrictUnknownAmount(config: Record<string, unknown> | null | undefined): boolean {
  if (!config || typeof config !== "object") return true;
  const b = (config as Record<string, unknown>).budget;
  if (!b || typeof b !== "object" || Array.isArray(b)) return true;
  return (b as Record<string, unknown>).strict_unknown_amount !== false;
}

/**
 * 估一次模型调用的费用（预留用）：prompt 按字符数换算 token（与 cost.ts
 * 同一套 CHARS_PER_TOKEN），completion 默认 2000 token。2000 不是典型值、
 * 是保守值：400 才是典型回复长度，但预留的职责是“事前拦超支”不是“精
 * 确报价”——按 400 预留时一次长回复的结算会顶穿预留额（结算按实报 usage
 * 补记），上限就不再是硬上限。按 2000 算只会早拒、不会超支；调用方知道
 * 本次输出上限时显式传 completionTokens。
 * pricing 为 null 时返回 null——不编单价。
 * 注意：这只是预留的“押金”，结算以实报 usage 为准；估少了结算时补记，
 * 估多了结算时释放，checkCost 事后硬停仍在。
 */
export function estimateCallUsd(
  promptChars: number,
  pricing: Pricing | null,
  completionTokens = 2000,
): number | null {
  if (!pricing) return null;
  const promptTokens = Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN);
  const completion = Math.max(0, Math.floor(completionTokens));
  return computeCostUsd(promptTokens, completion, pricing);
}

/**
 * 纯判定：这笔预留会不会顶穿任一层上限。limitUsd 为 null 的层不限。
 * spentUsd 是该层“已花”（调用方拼好传进来），reservedUsd 是账本里在途
 * 预留合计。逐层算 spent + reserved + amount <= limit，任一层不够就拒绝，
 * 并报是哪一层、差多少——不笼统说“额度不足”。
 */
export function checkReserve(
  limits: ReserveLimit[],
  reservedUsd: number,
  amountUsd: number,
): ReserveCheck {
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 0) {
    return { allowed: false, reason: `预留金额无效：${JSON.stringify(amountUsd)}（必须是 ≥ 0 的数字）` };
  }
  const reserved = typeof reservedUsd === "number" && Number.isFinite(reservedUsd) ? Math.max(0, reservedUsd) : 0;
  for (const l of limits) {
    if (l.limitUsd === null) continue;
    const spent = typeof l.spentUsd === "number" && Number.isFinite(l.spentUsd) ? Math.max(0, l.spentUsd) : 0;
    if (spent + reserved + amountUsd > l.limitUsd) {
      return {
        allowed: false,
        reason: `${l.scope} 层剩余额度不足：已花 $${spent.toFixed(4)} + 在途预留 $${reserved.toFixed(4)} + 本次 $${amountUsd.toFixed(4)} > 上限 $${l.limitUsd.toFixed(2)}`,
        bindingScope: l.scope,
      };
    }
  }
  return { allowed: true };
}

/** 最紧的那一层（剩余额度最小的有限上限），只用于展示 bindingScope。 */
function tightestScope(limits: ReserveLimit[], reservedUsd: number): string | null {
  let best: { scope: string; remaining: number } | null = null;
  for (const l of limits) {
    if (l.limitUsd === null) continue;
    const spent = typeof l.spentUsd === "number" && Number.isFinite(l.spentUsd) ? Math.max(0, l.spentUsd) : 0;
    const remaining = l.limitUsd - spent - reservedUsd;
    if (!best || remaining < best.remaining) best = { scope: l.scope, remaining };
  }
  return best?.scope ?? null;
}

/**
 * 共享预算账本：每次读写都重新读文件，不在内存里缓存——跨会话、跨进程、
 * 跨并行任务共享靠文件本身（与 costCaps 的账本同款做法；rename 原子写
 * 保证单次写入不撕裂，读-改-写一段由 acquireBudgetLock 串行化：跨进程
 * 同时预留时后到的那笔读到的是已含前一笔的账本，不会互相覆盖；事后仍
 * 由 checkCost 硬停兜底，见 docs/budget.md）。
 */
export class BudgetLedger {
  home: string;
  constructor(home?: string) {
    this.home = resolveHome(home);
  }

  /** 在途预留（只算活着的 reserved 行；过期行不拦路）。 */
  active(now = new Date()): BudgetReservation[] {
    const store = loadBudgetLedger(this.home);
    const nowMs = now.getTime();
    return store.reservations.filter((r) => r.status === "reserved" && !reservationExpired(r, nowMs));
  }

  /** 在途预留合计（美元）；没有在途预留时为 0（不是 null——“没预留”就是 0）。 */
  activeReservedUsd(now = new Date()): number {
    return this.active(now).reduce((s, r) => s + r.amountUsd, 0);
  }

  /** 全部记录（最新在前）；过期行仍在里面、status 已标 released 的除外——
   *  这里原样返回，调用方按 status 区分。 */
  list(): BudgetReservation[] {
    return loadBudgetLedger(this.home).reservations.slice();
  }

  /** 按 id 取一条记录；没有时返回 null（不抛错，调用方自己定夺）。 */
  get(id: string): BudgetReservation | null {
    return loadBudgetLedger(this.home).reservations.find((r) => r.id === id) ?? null;
  }

  /**
   * 预留一笔额度。limits 是调用方拼好的各层上限状态（spentUsd 是该层
   * “已花”）；任一层不够就拒绝、不写盘、不发调用。成功时返回 reservation。
   * 写盘时把过期行标 released 留痕、历史截断到最近 MAX_HISTORY 条。
   */
  reserve(
    owner: string,
    amountUsd: number,
    opts: { limits?: ReserveLimit[]; ttlMs?: number; reason?: ReservationReason; bindingScope?: string | null } = {},
  ): { ok: true; reservation: BudgetReservation } | { ok: false; reason: string; bindingScope: string | null } {
    return withBudgetLock(this.home, () => this.reserveLocked(owner, amountUsd, opts));
  }

  /** reserve 的锁内实现（不要直接调，跨进程原子性靠外层锁）。 */
  private reserveLocked(
    owner: string,
    amountUsd: number,
    opts: { limits?: ReserveLimit[]; ttlMs?: number; reason?: ReservationReason; bindingScope?: string | null } = {},
  ): { ok: true; reservation: BudgetReservation } | { ok: false; reason: string; bindingScope: string | null } {
    const who = (owner ?? "").trim();
    if (!who) throw new BudgetError("预留须给 owner（运行/线程 id）");
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new BudgetError(`预留金额必须是 ≥ 0 的数字（收到 ${JSON.stringify(amountUsd)}）`);
    }
    const limits = opts.limits ?? [];
    const store = loadBudgetLedger(this.home);
    const nowMs = Date.now();
    const live = store.reservations.filter((r) => r.status === "reserved" && !reservationExpired(r, nowMs));
    const reservedUsd = live.reduce((s, r) => s + r.amountUsd, 0);
    const check = checkReserve(limits, reservedUsd, amountUsd);
    if (!check.allowed) {
      return { ok: false, reason: check.reason ?? "剩余额度不足", bindingScope: check.bindingScope ?? null };
    }
    const ttl = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? Math.floor(opts.ttlMs)
      : DEFAULT_RESERVATION_TTL_MS;
    const reservation: BudgetReservation = {
      id: newReservationId(),
      owner: who,
      amountUsd,
      reason: opts.reason ?? "manual",
      bindingScope: opts.bindingScope ?? tightestScope(limits, reservedUsd),
      createdAt: nowIso(),
      expiresAt: new Date(nowMs + ttl).toISOString(),
      pid: process.pid,
      status: "reserved",
      settledUsd: null,
    };
    store.reservations.unshift(reservation);
    for (const r of store.reservations) {
      if (r.status === "reserved" && reservationExpired(r, nowMs)) r.status = "released";
    }
    if (store.reservations.length > MAX_HISTORY) store.reservations.length = MAX_HISTORY;
    saveBudgetLedger(this.home, store);
    return { ok: true, reservation };
  }

  /**
   * 结算一笔预留：按实际花费记 settledUsd。actualUsd 必须是 ≥ 0 的数字；
   * 算不出实际花费时不要调 settle、调 release（不编数字）。
   * 已结算/已释放的行再次结算抛错；id 不存在抛错；过期但仍是 reserved
   * 的行照常结算（钱已经花了，结算只是记账，不拦）。
   */
  settle(id: string, actualUsd: number): BudgetReservation {
    return withBudgetLock(this.home, () => this.settleLocked(id, actualUsd));
  }

  /** settle 的锁内实现（不要直接调）。 */
  private settleLocked(id: string, actualUsd: number): BudgetReservation {
    if (typeof actualUsd !== "number" || !Number.isFinite(actualUsd) || actualUsd < 0) {
      throw new BudgetError(`结算金额必须是 ≥ 0 的数字（收到 ${JSON.stringify(actualUsd)}）`);
    }
    const store = loadBudgetLedger(this.home);
    const row = store.reservations.find((r) => r.id === id);
    if (!row) throw new BudgetError(`找不到预留记录 ${id}`);
    if (row.status === "settled") throw new BudgetError(`预留 ${id} 已结算过，不能再结算`);
    if (row.status === "released") throw new BudgetError(`预留 ${id} 已释放，不能再结算`);
    row.status = "settled";
    row.settledUsd = actualUsd;
    saveBudgetLedger(this.home, store);
    return row;
  }

  /**
   * 释放一笔预留（调用没发出、或算不出实际花费时）。已释放的行再次释放
   * 直接返回原行（幂等）；已结算的行释放抛错（结算过的钱不能再“释放”）；
   * id 不存在抛错。
   */
  release(id: string): BudgetReservation {
    return withBudgetLock(this.home, () => this.releaseLocked(id));
  }

  /** release 的锁内实现（不要直接调）。 */
  private releaseLocked(id: string): BudgetReservation {
    const store = loadBudgetLedger(this.home);
    const row = store.reservations.find((r) => r.id === id);
    if (!row) throw new BudgetError(`找不到预留记录 ${id}`);
    if (row.status === "settled") throw new BudgetError(`预留 ${id} 已结算，不能再释放`);
    if (row.status === "released") return row;
    row.status = "released";
    saveBudgetLedger(this.home, store);
    return row;
  }

  /** 把过期行标 released 并写盘；返回清掉的条数（0 = 没有过期行）。 */
  pruneExpired(now = new Date()): number {
    return withBudgetLock(this.home, () => this.pruneExpiredLocked(now));
  }

  /** pruneExpired 的锁内实现（不要直接调）。 */
  private pruneExpiredLocked(now = new Date()): number {
    const store = loadBudgetLedger(this.home);
    const nowMs = now.getTime();
    let n = 0;
    for (const r of store.reservations) {
      if (r.status === "reserved" && reservationExpired(r, nowMs)) {
        r.status = "released";
        n += 1;
      }
    }
    if (n > 0) saveBudgetLedger(this.home, store);
    return n;
  }
}
