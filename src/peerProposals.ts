// src/peerProposals.ts — G-P1-10：对方写操作默认进提议（A2A/peer 全覆盖）。
//
// 覆盖面（入站三条路）：
// - 对外 MCP 服务 dispatch_task 派来的任务（origin peer）：写操作到
//   executeTool 的提议门时直接记成提议，不执行；
// - AG-UI 客户端收到的对方工具调用：本来就是提议（agui_tool_proposed，
//   见 src/agui.ts），本模块不重做，只复用同一张提议账本的形态；
// - Bot 网关渠道消息：角色白名单（guest/member 只读）+ 审批桥已是控制，
//   不再叠加提议门（见 PUSH-PLAN 的覆盖说明）。
//
// 提议账本 ~/.nyra/peer-proposals.json（原子写 0600）：每条提议记
// peer、工具名、参数、来源标签与状态（pending/accepted/declined/
// executed）。参数原文进账本——账本只在机主本机、可信；但事件与审计
// 里只记工具名与提议 id，不记参数原文（参数可能含文件内容）。
// 接受 = 机主显式批（nyra peer proposal accept <id> --yes）：接受后
// 由机主上下文执行一次（origin 改回 local，走全部的门：审查、judge、
// 单写者门一个不少）；拒绝 = 直接标 declined，不执行。提议本身不过期，
// 机主不批就一直挂着，不静默执行、不自动过期执行。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { appendPeerAudit } from "./peer.ts";
import type { ContentLabel } from "./contentLabels.ts";

export const PEER_PROPOSALS_FILE = "peer-proposals.json";
export type ProposalStatus = "pending" | "accepted" | "declined" | "executed";

export interface PeerProposal {
  id: string;
  peer: string;
  tool: string;
  args: Record<string, unknown>;
  label: ContentLabel;
  reason: string;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  run_id: string | null;
}

export interface PeerProposalStore {
  version: 1;
  proposals: PeerProposal[];
}

export class PeerProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerProposalError";
  }
}

export function peerProposalsPath(home: string): string {
  return join(resolveNyraHome(home), PEER_PROPOSALS_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newProposalId(): string {
  return `prop_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadPeerProposals(home: string): PeerProposalStore {
  const path = peerProposalsPath(home);
  if (!existsSync(path)) return { version: 1, proposals: [] };
  if (lstatSync(path).isSymbolicLink()) throw new PeerProposalError("提议账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new PeerProposalError("提议账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as PeerProposalStore).version !== 1 ||
    !Array.isArray((raw as PeerProposalStore).proposals)) {
    backupCorrupt(path);
    throw new PeerProposalError("提议账本格式无效，已备份");
  }
  return raw as PeerProposalStore;
}

export function savePeerProposals(home: string, store: PeerProposalStore): void {
  const path = peerProposalsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new PeerProposalError("提议账本不能是符号链接");
  const tmp = join(dirname(path), `.peer-proposals-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordProposalEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`对方提议：${type}`, "peer-proposal", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏提议本身 */ }
}

/**
 * 记一条提议：对方的写操作不执行，只记下来等机主批。返回提议记录
 * （调用方把 id 与工具名回给对方，原文不回——对方不需要知道参数细节）。
 */
export function recordPeerProposal(home: string, opts: {
  peer: string;
  tool: string;
  args: Record<string, unknown>;
  label: ContentLabel;
  reason: string;
}): PeerProposal {
  const store = loadPeerProposals(home);
  const proposal: PeerProposal = {
    id: newProposalId(),
    peer: opts.peer,
    tool: opts.tool,
    args: opts.args,
    label: opts.label,
    reason: opts.reason,
    status: "pending",
    created_at: nowIso(),
    decided_at: null,
    decided_by: null,
    run_id: null,
  };
  store.proposals.push(proposal);
  savePeerProposals(home, store);
  appendPeerAudit(home, { action: "peer_proposal_recorded", proposal: proposal.id, peer: opts.peer, tool: opts.tool });
  recordProposalEvent(home, "peer_proposal_recorded", { proposal_id: proposal.id, peer: opts.peer, tool: opts.tool });
  return proposal;
}

export function getPeerProposal(home: string, id: string): PeerProposal | null {
  return loadPeerProposals(home).proposals.find((p) => p.id === id) ?? null;
}

export function listPeerProposals(home: string, status?: ProposalStatus): PeerProposal[] {
  const all = loadPeerProposals(home).proposals;
  return status ? all.filter((p) => p.status === status) : all;
}

/**
 * 接受提议（机主操作，须 --yes，CLI 层拦）：只把状态标 accepted 并返回
 * 记录本身，执行由调用方在机主上下文里另跑（executeTool，origin local，
 * 全部的门照常走）。接受不等于已执行：执行成功后调用方再调
 * markProposalExecuted 标 executed。
 */
export function acceptPeerProposal(home: string, id: string, by = "owner"): PeerProposal {
  const store = loadPeerProposals(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new PeerProposalError(`没有这个提议：${id}`);
  if (proposal.status !== "pending") throw new PeerProposalError(`提议 ${id} 已是 ${proposal.status} 状态，不能再接受`);
  proposal.status = "accepted";
  proposal.decided_at = nowIso();
  proposal.decided_by = by;
  savePeerProposals(home, store);
  appendPeerAudit(home, { action: "peer_proposal_accepted", proposal: id, peer: proposal.peer, tool: proposal.tool });
  recordProposalEvent(home, "peer_proposal_decided", { proposal_id: id, peer: proposal.peer, decision: "accepted" });
  return proposal;
}

/** 拒绝提议（机主操作）：标 declined，不执行。 */
export function declinePeerProposal(home: string, id: string, by = "owner"): PeerProposal {
  const store = loadPeerProposals(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new PeerProposalError(`没有这个提议：${id}`);
  if (proposal.status !== "pending") throw new PeerProposalError(`提议 ${id} 已是 ${proposal.status} 状态，不能再拒绝`);
  proposal.status = "declined";
  proposal.decided_at = nowIso();
  proposal.decided_by = by;
  savePeerProposals(home, store);
  appendPeerAudit(home, { action: "peer_proposal_declined", proposal: id, peer: proposal.peer, tool: proposal.tool });
  recordProposalEvent(home, "peer_proposal_decided", { proposal_id: id, peer: proposal.peer, decision: "declined" });
  return proposal;
}

/** 接受过的提议已由机主上下文执行成功：标 executed，记执行过的 run_id。 */
export function markProposalExecuted(home: string, id: string, runId: string): PeerProposal {
  const store = loadPeerProposals(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new PeerProposalError(`没有这个提议：${id}`);
  if (proposal.status !== "accepted") throw new PeerProposalError(`提议 ${id} 还没接受（当前 ${proposal.status}），不能标已执行`);
  proposal.status = "executed";
  proposal.run_id = runId;
  savePeerProposals(home, store);
  return proposal;
}
