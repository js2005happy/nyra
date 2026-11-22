// src/writeGate.ts — 第 1 批 G-P0-4：单写者门（学 Qwen Code Agent Teams 的
// single worktree writer）。
//
// 规则：团队模式下，同一时间、同一个团队、同一个文件只允许一个 agent 写。
// 写者名额由参谋长持有、显式移交；没名额的写操作被拦下并记审计与事件。
// 不在团队里（teamId 为空）时门是关的，单人行为完全不变。
//
// 租约键 =（团队，工作区相对路径）；TTL 1 小时，僵尸租约过期后可被接管。
// 账本 ~/.nyra/write-gate.json 原子写 0600、损坏先备份再抛错；审计进
// write-gate-audit.jsonl（只记团队 id、相对路径、持有者，不记绝对路径、
// 不记文件内容）。
//
// 导入方向红线：本文件 import team.ts（要认参谋长是谁），team.ts 又
// import 本文件（writer 子命令）——这个自循环没事（顶层代码不用对方
// 的绑定）。但 tools.ts 绝不能静态 import 本文件：team → governance →
// marketplace → creator → tools.ts 的链会让 creator 的顶层代码在
// TOOL_SCHEMAS 还没初始化完时就跑，直接炸掉；tools.ts 的门检查须在
// executeTool 里动态 import（见 tools.ts 里的注释）。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTeam } from "./team.ts";
import { resolveNyraHome } from "./memory.ts";

export class WriteGateError extends Error {}

export const WRITE_GATE_FILE = "write-gate.json";
export const WRITE_GATE_AUDIT_FILE = "write-gate-audit.jsonl";
/** 租约 TTL：1 小时。过期租约在下一次查门时被清掉并记一笔审计。 */
export const WRITE_LEASE_TTL_MS = 60 * 60 * 1000;

export interface WriteLease {
  teamId: string;
  /** 工作区相对路径（posix 风格）；只记相对路径，不记绝对路径。 */
  file: string;
  holder: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
}

export interface WriteGateStore {
  version: 1;
  leases: WriteLease[];
}

export function writeGatePath(home: string): string {
  return join(resolveNyraHome(home), WRITE_GATE_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 门内用的文件键：工作区相对路径（posix 风格）。
 * 绝对路径与跳出工作区的 `..` 不归门管——workspaceWritePath 会在后面
 * 拦住它们，门不对它们放行也不拒绝，只返回 null 让调用方按“门外”处理。
 */
export function normalizeGateFile(path: string): string | null {
  const trimmed = String(path ?? "").trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/")) return null;
  const parts = trimmed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (parts.length === 0) return null;
  return parts.join("/");
}

function backupCorrupt(path: string): void {
  try {
    copyFileSync(path, `${path}.corrupt-${Date.now()}`);
  } catch { /* ignore */ }
}

export function loadWriteGateStore(home: string): WriteGateStore {
  const path = writeGatePath(home);
  if (!existsSync(path)) return { version: 1, leases: [] };
  if (lstatSync(path).isSymbolicLink()) throw new WriteGateError("单写者门账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new WriteGateError("单写者门账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as WriteGateStore).version !== 1 ||
    !Array.isArray((raw as WriteGateStore).leases)) {
    backupCorrupt(path);
    throw new WriteGateError("单写者门账本格式无效，已备份");
  }
  return raw as WriteGateStore;
}

export function saveWriteGateStore(home: string, store: WriteGateStore): void {
  const path = writeGatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new WriteGateError("单写者门账本不能是符号链接");
  const tmp = join(dirname(path), `.write-gate-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

export function appendWriteGateAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(resolveNyraHome(home), WRITE_GATE_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: nowIso(), ...entry }) + "\n", null, "utf-8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 清掉过期租约（返回清掉的数量）；清掉的每条记一笔审计。 */
function pruneExpired(home: string, store: WriteGateStore): number {
  const now = Date.now();
  const kept: WriteLease[] = [];
  let pruned = 0;
  for (const l of store.leases) {
    if (Date.parse(l.expiresAt) <= now) {
      pruned++;
      appendWriteGateAudit(home, { op: "expired", team_id: l.teamId, file: l.file, holder: l.holder });
    } else {
      kept.push(l);
    }
  }
  store.leases = kept;
  return pruned;
}

function findLease(store: WriteGateStore, teamId: string, file: string): WriteLease | undefined {
  return store.leases.find((l) => l.teamId === teamId && l.file === file);
}

export type LeaseResult =
  | { granted: true; holder: string }
  | { granted: false; holder: string | null; reason: string };

/**
 * 申请租约：没人持有就给；自己已持有就续期；别人持有就拒绝并报出持有者。
 * grantedBy 只记“谁批的”（参谋长或持有者本人续期）。
 */
export function acquireWriteLease(home: string, teamId: string, file: string, holder: string, grantedBy: string): LeaseResult {
  const store = loadWriteGateStore(home);
  pruneExpired(home, store);
  const existing = findLease(store, teamId, file);
  if (existing) {
    if (existing.holder === holder) {
      existing.expiresAt = new Date(Date.now() + WRITE_LEASE_TTL_MS).toISOString();
      saveWriteGateStore(home, store);
      return { granted: true, holder };
    }
    return { granted: false, holder: existing.holder, reason: `文件 ${file} 的写者名额在 ${existing.holder} 手里` };
  }
  const lease: WriteLease = {
    teamId, file, holder, grantedBy,
    grantedAt: nowIso(),
    expiresAt: new Date(Date.now() + WRITE_LEASE_TTL_MS).toISOString(),
  };
  store.leases.push(lease);
  saveWriteGateStore(home, store);
  appendWriteGateAudit(home, { op: "granted", team_id: teamId, file, holder, granted_by: grantedBy });
  return { granted: true, holder };
}

/** 归还租约：只有持有者本人或参谋长能还；没租约返回 false。 */
export function releaseWriteLease(home: string, teamId: string, file: string, holder: string, byChief = false): boolean {
  const store = loadWriteGateStore(home);
  pruneExpired(home, store);
  const existing = findLease(store, teamId, file);
  if (!existing) return false;
  const team = getTeam(home, teamId);
  const isChief = team !== null && team.chief === holder;
  if (existing.holder !== holder && !byChief && !isChief) return false;
  store.leases = store.leases.filter((l) => l !== existing);
  saveWriteGateStore(home, store);
  appendWriteGateAudit(home, { op: "released", team_id: teamId, file, holder: existing.holder, released_by: holder });
  return true;
}

/**
 * 显式移交：只有参谋长或当前持有者能移。参谋长可以直接把没人持有的文件
 * 批给某人（新建租约）；持有者只能把自己手里的交出去。别人持有时拒绝。
 */
export function transferWriteLease(home: string, teamId: string, file: string, from: string, to: string, by: string): LeaseResult {
  const team = getTeam(home, teamId);
  if (!team) throw new WriteGateError(`找不到团队 ${teamId}`);
  const isChief = team.chief === by;
  if (!isChief && by !== from) {
    return { granted: false, holder: from, reason: `只有参谋长 ${team.chief} 或当前持有者 ${from} 能移交 ${file} 的写者名额` };
  }
  const store = loadWriteGateStore(home);
  pruneExpired(home, store);
  const existing = findLease(store, teamId, file);
  if (existing && existing.holder !== from) {
    return { granted: false, holder: existing.holder, reason: `文件 ${file} 的写者名额现在在 ${existing.holder} 手里，不在 ${from} 手里，移交不了` };
  }
  if (existing) {
    existing.holder = to;
    existing.grantedBy = by;
    existing.grantedAt = nowIso();
    existing.expiresAt = new Date(Date.now() + WRITE_LEASE_TTL_MS).toISOString();
  } else {
    store.leases.push({
      teamId, file, holder: to, grantedBy: by,
      grantedAt: nowIso(),
      expiresAt: new Date(Date.now() + WRITE_LEASE_TTL_MS).toISOString(),
    });
  }
  saveWriteGateStore(home, store);
  appendWriteGateAudit(home, { op: "transferred", team_id: teamId, file, from, to, by });
  return { granted: true, holder: to };
}

export type GateCheck =
  // grantOnWrite: true = “这次写放行、但租约还没记”——参谋长首次写某文件
  // 时置：租约只在写操作真落地后才由调用方记（见 tools.ts），写被模式/
  // 审批/审查拦下时不占名额，否则被拒的写白白占租约一小时。
  | { decision: "allow"; holder: string; grantOnWrite?: boolean }
  | { decision: "deny"; holder: string | null; reason: string };

/**
 * 写操作前的查门（tools.ts 的写工具执行前调）：
 * - 门外路径（绝对路径 / `..`）不管，交给 workspaceWritePath 拦；
 * - 没租约：参谋长写 = 放行（grantOnWrite，租约在写成功后才记，不是在
 *   查门时就占）；成员写 = 拒绝；
 * - 有租约：持有者本人放行，别人拒绝并报出持有者。
 */
export function checkWriteGate(home: string, teamId: string, file: string, agent: string): GateCheck {
  const key = normalizeGateFile(file);
  if (key === null) return { decision: "allow", holder: agent };
  const team = getTeam(home, teamId);
  if (!team) throw new WriteGateError(`找不到团队 ${teamId}`);
  const store = loadWriteGateStore(home);
  pruneExpired(home, store);
  const existing = findLease(store, teamId, key);
  if (!existing) {
    if (agent === team.chief) {
      // 只放行、不占名额：租约由调用方在写操作真落地后记（grantOnWrite）。
      // 查门时就占名额会让一次被模式/审批拦下的写白白占租约一小时。
      return { decision: "allow", holder: agent, grantOnWrite: true };
    }
    return {
      decision: "deny",
      holder: team.chief,
      reason: `文件 ${key} 的写者名额在参谋长 ${team.chief} 手里，请参谋长先移交（delegate 时把文件列进 write_files，或跑 nyra team writer transfer）`,
    };
  }
  if (existing.holder === agent) return { decision: "allow", holder: agent };
  return {
    decision: "deny",
    holder: existing.holder,
    reason: `文件 ${key} 的写者名额在 ${existing.holder} 手里，同一时间只允许一个 agent 写这个文件`,
  };
}

/** 列出一个团队当前持有的租约（新的在后）；过期租约先清掉。 */
export function listWriteLeases(home: string, teamId: string): WriteLease[] {
  const store = loadWriteGateStore(home);
  if (pruneExpired(home, store) > 0) saveWriteGateStore(home, store);
  return store.leases.filter((l) => l.teamId === teamId);
}

/** 释放某人在某团队名下持有的全部租约（委派结束时调用，名额回参谋长）；返回释放条数。 */
export function releaseAllWriterLeases(home: string, teamId: string, holder: string, by?: string): number {
  const store = loadWriteGateStore(home);
  const held = store.leases.filter((l) => l.teamId === teamId && l.holder === holder);
  if (held.length === 0) return 0;
  store.leases = store.leases.filter((l) => !(l.teamId === teamId && l.holder === holder));
  saveWriteGateStore(home, store);
  for (const l of held) {
    appendWriteGateAudit(home, { op: "released", team_id: teamId, file: l.file, holder, released_by: by ?? holder });
  }
  return held.length;
}
