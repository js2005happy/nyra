// src/friendGrants.ts — G-P1-6：好友码升级为带 scope、可吊销的 grant
// （借 Hermes 的授权档位思路：授权只认“工具 + 参数指纹”精确匹配的
// 精神，这里认“peer + scope”精确匹配）。
//
// 好友码（NYR-XXXX-XXXX，24 小时）只解决“第一次握手时认出是你”；
// 握手之后的能力（拉名片、进群、收分享）走 grant：
// - 一条 grant 只属于一个 peer（每 peer 独立 token，吊销一家不影响别家）；
// - scope 是能力清单（card:read 拉名片、session:join 进联合会话、
//   share:receive 收分享、call:video 视频通话），调用时精确匹配；
// - token 只在签发时完整出现一次，账本里只记 SHA-256（不记原文）；
// - 默认 30 天过期（可配 1–90 天），过期失效；吊销立即失效。
// 好友码本身不动：新好友仍先走好友码握手，握手通过后再签发 grant。
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { appendPeerAudit } from "./peer.ts";
import { recordAdmission } from "./admission.ts";
import { findFriend, isFriend, loadFriendBook } from "./peerCard.ts";

export const FRIEND_GRANTS_FILE = "friend-grants.json";
export const GRANT_TOKEN_PREFIX = "nyra-grant-";
export const GRANT_DEFAULT_TTL_DAYS = 30;
export const GRANT_MAX_TTL_DAYS = 90;

/** grant 能开的能力（精确匹配，不含糊）。 */
export const GRANT_SCOPES = ["card:read", "session:join", "share:receive", "call:video"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export interface FriendGrant {
  id: string;
  peer: string;
  scope: GrantScope[];
  /** token 的 SHA-256（只记哈希，原文只在签发时给一次）。 */
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  revoked_at: string | null;
}

export interface FriendGrantStore {
  version: 1;
  grants: FriendGrant[];
}

export class FriendGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FriendGrantError";
  }
}

export function friendGrantsPath(home: string): string {
  return join(resolveNyraHome(home), FRIEND_GRANTS_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

export function loadFriendGrants(home: string): FriendGrantStore {
  const path = friendGrantsPath(home);
  if (!existsSync(path)) return { version: 1, grants: [] };
  if (lstatSync(path).isSymbolicLink()) throw new FriendGrantError("好友授权账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new FriendGrantError("好友授权账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as FriendGrantStore).version !== 1 ||
    !Array.isArray((raw as FriendGrantStore).grants)) {
    backupCorrupt(path);
    throw new FriendGrantError("好友授权账本格式无效，已备份");
  }
  return raw as FriendGrantStore;
}

export function saveFriendGrants(home: string, store: FriendGrantStore): void {
  const path = friendGrantsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new FriendGrantError("好友授权账本不能是符号链接");
  const tmp = join(dirname(path), `.friend-grants-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordGrantEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`好友授权：${type}`, "friend-grant", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏授权本身 */ }
}

function parseScopes(raw: unknown): GrantScope[] {
  if (!Array.isArray(raw)) throw new FriendGrantError(`scope 必须是列表（可选：${GRANT_SCOPES.join("、")}）`);
  const out: GrantScope[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || !(GRANT_SCOPES as readonly string[]).includes(s)) {
      throw new FriendGrantError(`scope 不认 ${JSON.stringify(s)}（可选：${GRANT_SCOPES.join("、")}）`);
    }
    if (!out.includes(s as GrantScope)) out.push(s as GrantScope);
  }
  if (!out.length) throw new FriendGrantError("scope 不能为空：至少给一个能力");
  return out;
}

/**
 * 给一名已批准、未拉黑的好友签发 grant（机主操作）。返回 { grant, token }：
 * token 只在这里出现一次，调用方须当场交给对方、不要再存第二份；
 * 账本里只有 token 的哈希。同一 peer 可以有多条 grant（不同 scope 各一
 * 条，吊销时按条吊销，互不影响）。
 */
export function issueFriendGrant(home: string, peer: string, scope: unknown, ttlDays = GRANT_DEFAULT_TTL_DAYS): { grant: FriendGrant; token: string } {
  const scopes = parseScopes(scope);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > GRANT_MAX_TTL_DAYS) {
    throw new FriendGrantError(`grant 有效期只能是 1–${GRANT_MAX_TTL_DAYS} 天（默认 ${GRANT_DEFAULT_TTL_DAYS} 天）`);
  }
  const book = loadFriendBook(home);
  const entry = findFriend(book, peer);
  if (!entry) throw new FriendGrantError(`好友账本里没有 ${peer}：先加好友再签发授权`);
  if (!isFriend(entry)) throw new FriendGrantError(`${peer} 还不是好友（须先批准对方的请求）：授权只发给已批准、未拉黑的好友`);
  const token = `${GRANT_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  const now = Date.now();
  const grant: FriendGrant = {
    id: `grant_${randomBytes(6).toString("hex")}`,
    peer,
    scope: scopes,
    token_hash: tokenHash(token),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlDays * 24 * 3600 * 1000).toISOString(),
    revoked: false,
    revoked_at: null,
  };
  const store = loadFriendGrants(home);
  store.grants.push(grant);
  saveFriendGrants(home, store);
  appendPeerAudit(home, { action: "friend_grant_issued", peer, grant: grant.id, scope: scopes.join(",") });
  recordGrantEvent(home, "friend_grant_issued", { peer, grant_id: grant.id, scope: scopes.join(",") });
  // G-P2-2：grant 发放记进统一准入账本（只记 token 指纹，不记原文）。
  recordAdmission(home, { kind: "token_issued", actor: "owner", subject: peer, scope: scopes, token_fingerprint: grant.token_hash.slice(0, 12), detail: `grant ${grant.id}` });
  return { grant, token };
}

export interface VerifiedGrant {
  grant: FriendGrant;
  peer: string;
  scope: GrantScope[];
}

/**
 * 验一个 grant token：对得上哈希、没吊销、没过期才认。验不过返回 null
 * （不抛错：网关 404 路径上验不过就是“没有”，不值得抛错打断请求）。
 * scope 参数给了时还要精确匹配（没这个能力同样返回 null）。
 */
export function verifyFriendGrant(home: string, token: string, scope?: GrantScope): VerifiedGrant | null {
  if (typeof token !== "string" || !token.startsWith(GRANT_TOKEN_PREFIX)) return null;
  let store: FriendGrantStore;
  try {
    store = loadFriendGrants(home);
  } catch {
    return null;
  }
  const hash = tokenHash(token);
  const grant = store.grants.find((g) => g.token_hash === hash);
  if (!grant || grant.revoked) return null;
  if (Date.parse(grant.expires_at) <= Date.now()) return null;
  if (scope && !grant.scope.includes(scope)) return null;
  return { grant, peer: grant.peer, scope: grant.scope };
}

/**
 * 吊销一条 grant（机主操作，须 --yes，CLI 层拦）：立即失效，只影响这一
 * 条——同一 peer 的其他 grant 与其他 peer 的 grant 都不受影响。
 */
export function revokeFriendGrant(home: string, grantId: string, by = "owner"): FriendGrant {
  const store = loadFriendGrants(home);
  const grant = store.grants.find((g) => g.id === grantId);
  if (!grant) throw new FriendGrantError(`没有这个授权：${grantId}`);
  if (grant.revoked) throw new FriendGrantError(`授权 ${grantId} 已经吊销过了`);
  grant.revoked = true;
  grant.revoked_at = nowIso();
  saveFriendGrants(home, store);
  appendPeerAudit(home, { action: "friend_grant_revoked", peer: grant.peer, grant: grant.id, by });
  recordGrantEvent(home, "friend_grant_revoked", { peer: grant.peer, grant_id: grant.id });
  // G-P2-2：grant 吊销记进统一准入账本（吊销本身照样立即生效）。
  recordAdmission(home, { kind: "token_revoked", actor: by, subject: grant.peer, token_fingerprint: grant.token_hash.slice(0, 12), detail: `grant ${grant.id}` });
  return grant;
}

export function listFriendGrants(home: string, peer?: string): FriendGrant[] {
  const all = loadFriendGrants(home).grants;
  return peer ? all.filter((g) => g.peer === peer) : all;
}

/** 一条 grant 现在还有效吗（没吊销、没过期）。 */
export function isGrantLive(grant: FriendGrant): boolean {
  return !grant.revoked && Date.parse(grant.expires_at) > Date.now();
}
