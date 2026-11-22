// src/peerTokens.ts — G-P1-4 的后一半：per-peer token（出站方向，
// 借 OpenClaw A2A `channels.a2a.peers` 每信任 peer 单独配一个
// bearer token 的做法）。
//
// 方向别搞反：
// - 入站（别人调我）：对方拿的是我签发的 grant（friendGrants.ts，
//   每 peer 独立、按条吊销）；
// - 出站（我调别人）：我拿的是对方签发给我的 token，每 peer 一条，
//   存在我自己的密码箱里（vault 条目 `peer-token-<好友名>`），
//   调对方网关时当 Bearer token 带上。
// - 吊销一家不影响别家：token 按 peer 分条存，删一条只影响那一家；
//   对方吊销我那条时，我这边再调就 401/404，fetch 时当“没拿到
//   名片”处理，不静默换别的 token 顶上。
// - token 原文只进密码箱：账本、审计、事件里只记“有没有、给谁”，
//   绝不记原文；CLI 设 token 时从交互输入读，不走 argv（argv 会进
//   shell 历史与进程列表）。
import { Vault, getCredential, vaultPath } from "./vault.ts";
import { fetchAgentCard, type AgentCard, type CardFetchDeps } from "./peerCard.ts";
import { RunStore } from "./runs.ts";
import { join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export const PEER_TOKEN_VAULT_PREFIX = "peer-token-";

export class PeerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerTokenError";
  }
}

function entryName(peer: string): string {
  return `${PEER_TOKEN_VAULT_PREFIX}${peer}`;
}

function validatePeerName(peer: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(peer)) {
    throw new PeerTokenError(`好友名只认字母数字、下划线或连字符（最多 32 字），当前是 ${JSON.stringify(peer)}`);
  }
}

function recordTokenEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`好友 token：${type}`, "peer-token", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏 token 操作本身 */ }
}

function openVault(home: string, password: string): Vault {
  const vault = new Vault(vaultPath(home));
  if (!vault.exists()) throw new PeerTokenError("密码箱不存在，先运行：nyra vault init");
  if (!vault.unlock(password)) throw new PeerTokenError("密码箱主密码不对");
  return vault;
}

/**
 * 给一名好友存一条出站 token（对方签发给我的 grant token，调对方
 * 网关时当 Bearer 带上）。token 只进密码箱，不落别处。
 */
export function setPeerToken(home: string, peer: string, token: string, password: string): void {
  validatePeerName(peer);
  const t = token.trim();
  if (!t) throw new PeerTokenError("token 不能为空");
  if (t.length > 512) throw new PeerTokenError("token 太长（最多 512 字）");
  const vault = openVault(home, password);
  vault.add(entryName(peer), t, true);
  recordTokenEvent(home, "peer_token_set", { peer });
}

/** 静默读一条出站 token：没密码箱、没密码、密码错、没条目时一律返回 null。 */
export function getPeerToken(home: string, peer: string): string | null {
  validatePeerName(peer);
  return getCredential(entryName(peer), home);
}

/** 吊销一条出站 token（删密码箱里的那一条，别家的 token 不动）。 */
export function revokePeerToken(home: string, peer: string, password: string): boolean {
  validatePeerName(peer);
  const vault = openVault(home, password);
  const had = vault.get(entryName(peer)) !== null;
  if (had) vault.remove(entryName(peer));
  if (had) recordTokenEvent(home, "peer_token_revoked", { peer });
  return had;
}

/** 列出已存出站 token 的好友名（只列名字，不读 token 原文）。 */
export function listPeerTokenNames(home: string, password: string): string[] {
  const vault = openVault(home, password);
  return vault
    .listNames()
    .filter((n) => n.startsWith(PEER_TOKEN_VAULT_PREFIX))
    .map((n) => n.slice(PEER_TOKEN_VAULT_PREFIX.length))
    .sort();
}

/**
 * 带 per-peer token 拉对方名片：有 token 就带 Bearer 调，没 token
 * 就素调（对方没开按圈放行时素调也能拿到；对方要求 grant 时素调
 * 拿不到就直接报错，不静默换 token）。
 */
export async function fetchAgentCardAuthed(
  url: string,
  peer: string,
  home: string,
  deps?: CardFetchDeps,
): Promise<{ card: AgentCard; hash: string; authed: boolean }> {
  const token = getPeerToken(home, peer);
  const { card, hash } = await fetchAgentCard(url, deps, token ?? undefined);
  return { card, hash, authed: token !== null };
}
