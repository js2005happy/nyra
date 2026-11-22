// src/takeoverLedger.ts — 缺口 50 第二批：接管（take the wheel）的账本。
//
// 叶子模块：只依赖 node:fs / node:path / node:crypto，不 import 任何 src
// 模块——src/kanban.ts 的启动守卫（接管期间禁启动任务）也要读它，叶子
// 才能避免 kanban → botTakeover → kanban 的循环导入。业务逻辑与 CLI
// 在 src/botTakeover.ts 里。
//
// 账本 ~/.nyra/takeovers.json 原子写 0600，损坏先备份再抛错（不静默重建）。
// 一条记录就是一次接管：谁、何时、为什么、暂停了哪几个任务、交还时做了
// 什么、Bot 从哪一步继续。审计字段里不记密码/验证码/支付信息原文——
// 交还时填的 did / resumeFrom 先过第一批的确定性打码（botTakeover 里做）。
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const TAKEOVERS_FILE = "takeovers.json";

/** 接管状态：active（Bot 已暂停，人正在操作）/ handed_back（已交还给 Bot）。 */
export type TakeoverStatus = "active" | "handed_back";

export interface TakeoverRecord {
  id: string;
  computerId: string;
  /** 电脑挂在哪台 Soul 身份下（与 BotComputer.agent 同一命名空间）。 */
  agent: string;
  /** 谁接管的（机主是 owner，别人须是信任圈成员）。 */
  takenBy: string;
  /** 为什么接管（--reason；没给时记“未说明原因”）。 */
  reason: string;
  at: string;
  status: TakeoverStatus;
  /** 接管时暂停的任务板任务 id（交还时只恢复这些，恢复后回 queued）。 */
  pausedTaskIds: string[];
  handedBackAt: string | null;
  handedBackBy: string | null;
  /** 接管期间做了什么（已打码，原文不留存；没填时为 null）。 */
  did: string | null;
  /** Bot 从哪一步继续（已打码；没填时为 null）。 */
  resumeFrom: string | null;
  /** 交还时恢复的任务 id（暂停时记的任务里，交还那一刻仍是 paused 的才恢复）。 */
  resumedTaskIds: string[];
}

export interface TakeoverLedger {
  version: 1;
  takeovers: TakeoverRecord[];
}

export function takeoverLedgerPath(home: string): string {
  return join(home, TAKEOVERS_FILE);
}

export function newTakeoverId(): string {
  return `tk_${randomBytes(6).toString("hex")}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function writeJsonAtomic(home: string, filename: string, data: string): void {
  const path = join(home, filename);
  const dir = home;
  const tmp = join(dir, `.${filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 读接管账本：没有返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadTakeoverLedger(home: string): TakeoverLedger {
  const path = takeoverLedgerPath(home);
  if (!existsSync(path)) return { version: 1, takeovers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new Error(`${TAKEOVERS_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.takeovers)) {
    throw new Error(`${TAKEOVERS_FILE} 结构不对（须含 takeovers 列表）`);
  }
  return { version: 1, takeovers: parsed.takeovers as TakeoverRecord[] };
}

export function saveTakeoverLedger(home: string, ledger: TakeoverLedger): void {
  writeJsonAtomic(home, TAKEOVERS_FILE, JSON.stringify(ledger, null, 2) + "\n");
}

/** 这台电脑当前有没有正在进行的接管（有则返回记录，没有返回 null）。 */
export function getActiveTakeover(home: string, computerId: string): TakeoverRecord | null {
  const ledger = loadTakeoverLedger(home);
  return ledger.takeovers.find((t) => t.computerId === computerId && t.status === "active") ?? null;
}

/** 这个 agent 的电脑当前有没有正在进行的接管（启动守卫用）。 */
export function getActiveTakeoverForAgent(home: string, agent: string): TakeoverRecord | null {
  const ledger = loadTakeoverLedger(home);
  return ledger.takeovers.find((t) => t.agent === agent && t.status === "active") ?? null;
}

/** 列出接管记录（最新在后；给电脑 id 时只列那台的）。 */
export function listTakeovers(home: string, computerId?: string): TakeoverRecord[] {
  const ledger = loadTakeoverLedger(home);
  return computerId
    ? ledger.takeovers.filter((t) => t.computerId === computerId)
    : ledger.takeovers;
}
