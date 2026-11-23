// src/hitl.ts — 对话转人工坐席（G-P1-32，Botpress plugins/hitl 借鉴）。
//
// Botpress 的做法：对话能转给真人、真人接手、再接回 bot。Nyra 的确定性版本：
//   - 转人工账本 `~/.nyra/hitl.json`（0600 原子写，损坏先备份再回空账本）：
//     每条记录一场会话的转人工单——谁发起、转给谁、状态、时间戳与审计。
//   - 状态机：pending（待接手）→ active（真人接手中）→ handed_back（已接回
//     bot）；pending 也能 cancel。状态只能按这个方向走，非法流转直接报错。
//   - 静默门：pending 或 active 的会话，bot 不再自动回复（接线在 Gateway.send
//     里，见 gateway.ts）；账本损坏、状态不明时也不回（fail-closed）。
//   - 真人接手只认机主或信任圈成员（判定在 hitlCli.ts 里做，这里只认传进来
//     的身份串与 isOwner 标志）；转人工本身不自动判定，只由机主或 bot 显式触发。
//   - 不接真实时通讯渠道：真人只通过本地 CLI / 收件箱看到转人工单。
//   - 只借想法不照抄：本模块是 Nyra 自己的账本 + 状态机实现。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";

export class HitlError extends Error {}

/** 转人工单状态：待接手 → 真人接手中 → 已接回 bot；待接手也能取消。 */
export type HitlStatus = "pending" | "active" | "handed_back" | "cancelled";

export interface HitlHandoff {
  /** 转人工单 id（`hitl_` + 12 位十六进制）。 */
  id: string;
  /** 会话 id（网关会话）。 */
  sessionId: string;
  status: HitlStatus;
  /** 发起人身份（账号邮箱，未登录时为 `local`）。 */
  requestedBy: string;
  requestedAt: string;
  /** 转人工原因（可选，最多 500 字）。 */
  reason?: string;
  /** 指定接手的真人身份（可选；指定了只认该身份或机主接手）。 */
  assignee?: string;
  /** 接手人身份。 */
  takenBy?: string;
  takenAt?: string;
  /** 接回 bot 的人身份。 */
  handedBackBy?: string;
  handedBackAt?: string;
  /** 取消人身份。 */
  cancelledBy?: string;
  cancelledAt?: string;
}

export const HITL_LEDGER_NAME = "hitl.json";
/** 账本最多留多少条；超了丢最旧的已终态单（终态 = handed_back / cancelled），进行中的单永远保留。 */
export const HITL_LEDGER_MAX = 200;

function ledgerPath(home: string): string {
  return join(resolveNyraHome(home), HITL_LEDGER_NAME);
}

function atomicWrite0600(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function newHandoffId(): string {
  return `hitl_${randomBytes(6).toString("hex")}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validStatus(v: unknown): v is HitlStatus {
  return v === "pending" || v === "active" || v === "handed_back" || v === "cancelled";
}

function validHandoff(v: unknown): v is HitlHandoff {
  if (!isRecord(v)) return false;
  return typeof v.id === "string" && v.id.startsWith("hitl_")
    && typeof v.sessionId === "string" && v.sessionId.length > 0
    && validStatus(v.status)
    && typeof v.requestedBy === "string" && v.requestedBy.length > 0
    && typeof v.requestedAt === "string";
}

/**
 * 读账本的原始结果：文件不存在回空账本；损坏先备份（同名 .bak-<时间戳>）
 * 再回空账本，并把 corrupt 置 true——调用方据此 fail-closed。
 */
export function readHitlLedger(home: string): { handoffs: HitlHandoff[]; corrupt: boolean } {
  const path = ledgerPath(home);
  if (!existsSync(path)) return { handoffs: [], corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const list = isRecord(parsed) && Array.isArray(parsed.handoffs) ? parsed.handoffs : [];
    return { handoffs: list.filter(validHandoff), corrupt: false };
  } catch {
    try {
      renameSync(path, `${path}.bak-${Date.now()}`);
    } catch { /* 备份失败也不拦运行 */ }
    return { handoffs: [], corrupt: true };
  }
}

/** 读账本：损坏回空账本（备份已在 readHitlLedger 里做）。 */
export function loadHitlLedger(home: string): HitlHandoff[] {
  return readHitlLedger(home).handoffs;
}

export function saveHitlLedger(home: string, handoffs: HitlHandoff[]): void {
  const kept = [...handoffs];
  while (kept.length > HITL_LEDGER_MAX) {
    const idx = kept.findIndex((h) => h.status === "handed_back" || h.status === "cancelled");
    if (idx < 0) break;
    kept.splice(idx, 1);
  }
  atomicWrite0600(ledgerPath(home), JSON.stringify({ handoffs: kept }, null, 2) + "\n");
}

function saveOne(home: string, handoffs: HitlHandoff[], next: HitlHandoff): HitlHandoff {
  const idx = handoffs.findIndex((h) => h.id === next.id);
  if (idx >= 0) handoffs[idx] = next;
  else handoffs.push(next);
  saveHitlLedger(home, handoffs);
  return next;
}

/** 该会话进行中的转人工单（pending 或 active），没有回 null。 */
export function activeHandoffForSession(home: string, sessionId: string): HitlHandoff | null {
  if (!sessionId) return null;
  return loadHitlLedger(home).find((h) => h.sessionId === sessionId && (h.status === "pending" || h.status === "active")) ?? null;
}

/**
 * 静默门：会话转人工期间 bot 不自动回。账本损坏、状态不明时也不回
 * （fail-closed）；账本文件不存在时不静默。
 */
export function isBotMutedForSession(home: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const { handoffs, corrupt } = readHitlLedger(home);
  if (corrupt) return true;
  return handoffs.some((h) => h.sessionId === sessionId && (h.status === "pending" || h.status === "active"));
}

export function getHandoff(home: string, id: string): HitlHandoff {
  const found = loadHitlLedger(home).find((h) => h.id === id);
  if (!found) throw new HitlError(`转人工单不存在：${id}`);
  return found;
}

export function listHandoffs(home: string, status?: HitlStatus): HitlHandoff[] {
  const all = loadHitlLedger(home);
  const filtered = status ? all.filter((h) => h.status === status) : all;
  return [...filtered].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}

/**
 * 发起转人工：同一会话已有进行中的单时拒绝（先处理旧单）。
 * start 本身不自动判定——只由机主或 bot 显式触发。
 */
export function startHandoff(home: string, opts: { sessionId: string; by: string; reason?: string; assignee?: string }): HitlHandoff {
  const sessionId = opts.sessionId.trim();
  if (!sessionId) throw new HitlError("转人工需要一个会话 id");
  if (!opts.by.trim()) throw new HitlError("转人工需要一个发起人身份");
  if (opts.reason !== undefined && opts.reason.length > 500) throw new HitlError("转人工原因最多 500 字");
  if (opts.assignee !== undefined && opts.assignee.length > 200) throw new HitlError("指定接手人最多 200 字");
  const handoffs = loadHitlLedger(home);
  if (handoffs.some((h) => h.sessionId === sessionId && (h.status === "pending" || h.status === "active"))) {
    throw new HitlError(`会话 ${sessionId} 已有进行中的转人工单，先处理旧单`);
  }
  const now = new Date().toISOString();
  return saveOne(home, handoffs, {
    id: newHandoffId(),
    sessionId,
    status: "pending",
    requestedBy: opts.by,
    requestedAt: now,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.assignee ? { assignee: opts.assignee } : {}),
  });
}

/**
 * 真人接手：只认 pending 的单；指定了接手人时只认该身份或机主。
 * 接手人身份是否机主 / 信任圈成员由调用方（hitlCli）先验过。
 */
export function takeoverHandoff(home: string, id: string, by: string, isOwner = false): HitlHandoff {
  const handoffs = loadHitlLedger(home);
  const h = handoffs.find((x) => x.id === id);
  if (!h) throw new HitlError(`转人工单不存在：${id}`);
  if (h.status !== "pending") throw new HitlError(`转人工单 ${id} 不是待接手状态（现在是 ${h.status}），不能接手`);
  if (h.assignee && by !== h.assignee && !isOwner) throw new HitlError(`转人工单 ${id} 指定了接手人 ${h.assignee}，其他人不能接手`);
  const now = new Date().toISOString();
  return saveOne(home, handoffs, { ...h, status: "active", takenBy: by, takenAt: now });
}

/** 接回 bot：只认 active 的单；只认接手人本人或机主。 */
export function handbackHandoff(home: string, id: string, by: string, isOwner = false): HitlHandoff {
  const handoffs = loadHitlLedger(home);
  const h = handoffs.find((x) => x.id === id);
  if (!h) throw new HitlError(`转人工单不存在：${id}`);
  if (h.status !== "active") throw new HitlError(`转人工单 ${id} 不是真人接手中（现在是 ${h.status}），不能接回 bot`);
  if (by !== h.takenBy && !isOwner) throw new HitlError(`转人工单 ${id} 只能由接手人 ${h.takenBy ?? "未知"} 或机主接回 bot`);
  const now = new Date().toISOString();
  return saveOne(home, handoffs, { ...h, status: "handed_back", handedBackBy: by, handedBackAt: now });
}

/** 取消：只认 pending 的单；只认发起人或机主。 */
export function cancelHandoff(home: string, id: string, by: string, isOwner = false): HitlHandoff {
  const handoffs = loadHitlLedger(home);
  const h = handoffs.find((x) => x.id === id);
  if (!h) throw new HitlError(`转人工单不存在：${id}`);
  if (h.status !== "pending") throw new HitlError(`转人工单 ${id} 不是待接手状态（现在是 ${h.status}），不能取消`);
  if (by !== h.requestedBy && !isOwner) throw new HitlError(`转人工单 ${id} 只能由发起人 ${h.requestedBy} 或机主取消`);
  const now = new Date().toISOString();
  return saveOne(home, handoffs, { ...h, status: "cancelled", cancelledBy: by, cancelledAt: now });
}
