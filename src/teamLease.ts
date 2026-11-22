// src/teamLease.ts — G-P1-3：租约 + 纪元 + lead 路由（借 Hermes 的
// lease/epoch 机制，只抄机制、不搬实现；隔离仍用每 Bot 一台电脑，
// 不学 Hermes 的共享运行时）。
//
// 一个团队同一时间只有一个 lead（参谋长）持有租约：
// - 租约：{ teamId, lead, epoch, holder, expiresAt }，TTL 默认 10 分钟，
//   账本 ~/.nyra/team-leases.json（原子写 0600）；
// - 纪元：每次换 lead 纪元 +1；带旧纪元的消息一律按过期拒绝
//   （stale epoch）——防“旧参谋长下线后、它的晚到指令又被执行”；
// - lead 路由：消息先问“现在谁是 lead、租约还活着吗”，没活租约时
//   fail-closed（拒绝路由，不猜一个 lead 出来）。
//
// 与单写者门（writeGate.ts）的区别：写者门管“谁能写某个文件”，
// 租约管“谁是这个团队当前的 lead、它的指令是第几纪元的”。两本账
// 分开，不共用 TTL（写者门 1 小时，lead 租约 10 分钟——lead 失联
// 要能快速换人，文件写一半换人则不行）。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { getTeam } from "./team.ts";
import { RunStore } from "./runs.ts";

export const TEAM_LEASES_FILE = "team-leases.json";
/** lead 租约 TTL：10 分钟。失联的 lead 要能快速被换掉，过期即失效。 */
export const TEAM_LEASE_TTL_MS = 10 * 60 * 1000;

export interface TeamLease {
  teamId: string;
  /** 当前 lead（Soul agent 名，即参谋长）。 */
  lead: string;
  /** 纪元：每次换 lead +1；旧纪元的消息按过期拒绝。 */
  epoch: number;
  holder: string;
  grantedAt: string;
  expiresAt: string;
}

export interface TeamLeaseStore {
  version: 1;
  leases: TeamLease[];
}

export class TeamLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamLeaseError";
  }
}

export function teamLeasesPath(home: string): string {
  return join(resolveNyraHome(home), TEAM_LEASES_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadTeamLeases(home: string): TeamLeaseStore {
  const path = teamLeasesPath(home);
  if (!existsSync(path)) return { version: 1, leases: [] };
  if (lstatSync(path).isSymbolicLink()) throw new TeamLeaseError("团队租约账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new TeamLeaseError("团队租约账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as TeamLeaseStore).version !== 1 ||
    !Array.isArray((raw as TeamLeaseStore).leases)) {
    backupCorrupt(path);
    throw new TeamLeaseError("团队租约账本格式无效，已备份");
  }
  return raw as TeamLeaseStore;
}

export function saveTeamLeases(home: string, store: TeamLeaseStore): void {
  const path = teamLeasesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TeamLeaseError("团队租约账本不能是符号链接");
  const tmp = join(dirname(path), `.team-leases-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordLeaseEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`团队租约：${type}`, "team-lease", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏租约本身 */ }
}

function findLease(store: TeamLeaseStore, teamId: string): TeamLease | undefined {
  return store.leases.find((l) => l.teamId === teamId);
}

function isLive(lease: TeamLease): boolean {
  return Date.parse(lease.expiresAt) > Date.now();
}

/** 读一个团队当前的 lead 租约（过期租约返回 null，不自动续）。 */
export function getTeamLease(home: string, teamId: string): TeamLease | null {
  const store = loadTeamLeases(home);
  const lease = findLease(store, teamId);
  if (!lease || !isLive(lease)) return null;
  return lease;
}

export type LeaseResult =
  | { granted: true; lease: TeamLease }
  | { granted: false; holder: string | null; reason: string };

/**
 * 申请 lead 租约：没人持有（或已过期）就给，纪元从 1 起；自己已持有
 * 就续期（纪元不变）；别人持有就拒绝并报出持有者与纪元。
 * 只有团队参谋长能拿 lead 租约（团队账本里认 chief）。
 */
export function acquireTeamLease(home: string, teamId: string, holder: string): LeaseResult {
  const team = getTeam(home, teamId);
  if (!team) throw new TeamLeaseError(`找不到团队 ${teamId}`);
  if (team.status !== "active") throw new TeamLeaseError(`团队 ${team.name} 已解散，不能拿 lead 租约`);
  if (team.chief !== holder) {
    return { granted: false, holder: team.chief, reason: `lead 租约只给参谋长 ${team.chief}，${holder} 不是参谋长` };
  }
  const store = loadTeamLeases(home);
  const existing = findLease(store, teamId);
  if (existing && isLive(existing)) {
    if (existing.holder === holder) {
      existing.expiresAt = new Date(Date.now() + TEAM_LEASE_TTL_MS).toISOString();
      saveTeamLeases(home, store);
      return { granted: true, lease: existing };
    }
    return { granted: false, holder: existing.holder, reason: `团队 ${teamId} 的 lead 租约在 ${existing.holder} 手里（纪元 ${existing.epoch}）` };
  }
  const lease: TeamLease = {
    teamId,
    lead: holder,
    epoch: existing ? existing.epoch + 1 : 1,
    holder,
    grantedAt: nowIso(),
    expiresAt: new Date(Date.now() + TEAM_LEASE_TTL_MS).toISOString(),
  };
  if (existing) store.leases = store.leases.filter((l) => l !== existing);
  store.leases.push(lease);
  saveTeamLeases(home, store);
  recordLeaseEvent(home, "team_lease_acquired", { team_id: teamId, lead: holder, epoch: lease.epoch });
  return { granted: true, lease };
}

/** 归还 lead 租约：只有持有者本人或参谋长能还；没活租约返回 false。 */
export function releaseTeamLease(home: string, teamId: string, holder: string): boolean {
  const store = loadTeamLeases(home);
  const existing = findLease(store, teamId);
  if (!existing || !isLive(existing)) return false;
  if (existing.holder !== holder) return false;
  store.leases = store.leases.filter((l) => l !== existing);
  saveTeamLeases(home, store);
  recordLeaseEvent(home, "team_lease_released", { team_id: teamId, lead: holder, epoch: existing.epoch });
  return true;
}

/**
 * 移交 lead（换人）：只有现任 lead 能移交；纪元 +1（旧纪元的消息从此
 * 按过期拒绝）。新 lead 必须是团队成员（不要求是参谋长——换 lead
 * 本身就是换参谋长，团队账本的 chief 字段由调用方另行改，这里只管租约）。
 */
export function transferTeamLead(home: string, teamId: string, from: string, to: string): LeaseResult {
  const team = getTeam(home, teamId);
  if (!team) throw new TeamLeaseError(`找不到团队 ${teamId}`);
  if (!team.members.includes(to) && team.chief !== to) {
    return { granted: false, holder: from, reason: `${to} 不是团队 ${team.name} 的成员，接不了 lead` };
  }
  const store = loadTeamLeases(home);
  const existing = findLease(store, teamId);
  if (!existing || !isLive(existing)) {
    return { granted: false, holder: null, reason: `团队 ${teamId} 现在没有活的 lead 租约，先拿租约再移交` };
  }
  if (existing.holder !== from) {
    return { granted: false, holder: existing.holder, reason: `lead 现在在 ${existing.holder} 手里，${from} 移交不了` };
  }
  const lease: TeamLease = {
    teamId,
    lead: to,
    epoch: existing.epoch + 1,
    holder: to,
    grantedAt: nowIso(),
    expiresAt: new Date(Date.now() + TEAM_LEASE_TTL_MS).toISOString(),
  };
  store.leases = store.leases.filter((l) => l !== existing);
  store.leases.push(lease);
  saveTeamLeases(home, store);
  recordLeaseEvent(home, "team_lease_transferred", { team_id: teamId, from, to, epoch: lease.epoch });
  return { granted: true, lease };
}

export type EpochCheck =
  | { ok: true; lease: TeamLease }
  | { ok: false; reason: string };

/**
 * 纪元校验：委派/路由带过来的纪元必须等于当前活租约的纪元；对不上
 * 一律按过期拒绝（旧参谋长下线后、它的晚到指令不能再被执行）。
 * 没活租约时也拒绝（fail-closed：没 lead 就不路由，不猜一个出来）。
 * 传了 holder 时还要核对调用方就是当前 lead（旧 lead 拿着新纪元号
 * 也不能冒充现任 lead 派活）。
 */
export function checkTeamEpoch(home: string, teamId: string, epoch: number, holder?: string): EpochCheck {
  const lease = getTeamLease(home, teamId);
  if (!lease) {
    recordLeaseEvent(home, "team_stale_epoch_rejected", { team_id: teamId, epoch, expected_epoch: 0 });
    return { ok: false, reason: `团队 ${teamId} 现在没有活的 lead 租约，纪元 ${epoch} 的指令不路由` };
  }
  if (holder && lease.lead !== holder) {
    recordLeaseEvent(home, "team_stale_epoch_rejected", { team_id: teamId, epoch, expected_epoch: lease.epoch });
    return { ok: false, reason: `你不是团队 ${teamId} 的当前 lead（现在是 ${lease.lead}），纪元 ${epoch} 的指令不路由` };
  }
  if (lease.epoch !== epoch) {
    recordLeaseEvent(home, "team_stale_epoch_rejected", { team_id: teamId, epoch, expected_epoch: lease.epoch });
    return { ok: false, reason: `纪元过期：这条指令是纪元 ${epoch} 的，当前 lead 纪元是 ${lease.epoch}（lead 已换人）` };
  }
  return { ok: true, lease };
}

/**
 * lead 路由：把一条消息路由给当前 lead。没活租约时拒绝（不猜 lead）；
 * 租约过期时同样拒绝。返回 lead 的 Soul 名，调用方按它投递。
 */
export function routeToLead(home: string, teamId: string): { lead: string; epoch: number } {
  const lease = getTeamLease(home, teamId);
  if (!lease) throw new TeamLeaseError(`团队 ${teamId} 现在没有活的 lead 租约，消息不路由（先拿租约：nyra team lead acquire）`);
  return { lead: lease.lead, epoch: lease.epoch };
}
