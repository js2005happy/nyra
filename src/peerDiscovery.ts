// src/peerDiscovery.ts — G-P1-4：Agent Card 公开发现（借 OpenClaw
// A2A 的发现思路：well-known 端点 + 逐个信任的 peer，不搬实现）。
//
// 发现 ≠ 加好友：
// - 发现只是“在网上找到一张名片”——拉对方的 well-known 端点、验
//   格式、验签名（有签名时）、记进发现账本；发现本身不建好友关系、
//   不发任何请求、不耗对方的 grant；
// - 加好友仍走双向批准：发现后调 `nyra peer discover-add <地址>
//   <名字>`，内部复用 addFriendRequest（不带好友码——码是线下人工
//   比对的路子，发现走的是“名片本身就是公开信息”的路子）；发完请
//   求后对方仍须在自己那边 accept，另一边同样走一遍，不绕过批准；
// - 验签是“更可信”不是准入：名片没签名照样能发现（标 absent），
//   签名对不上标 invalid 并拒绝记入账本（伪造名片不进发现列表）；
//   TOFU 钉住的钥匙变了（mismatch）同样拒绝，并报出原因。
// - 种子地址是机主给的（CLI 参数或配置文件）：本批不做局域网 mDNS
//   扫描、不做公开爬取——发现范围由机主点名，不静默扫网。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { addFriendRequest, fetchAgentCard, parseAgentCard, type AgentCard, type CardFetchDeps, type FriendEntry } from "./peerCard.ts";
import { verifySignedCard, cardKeyStatus, type CardSignatureStatus } from "./cardSignature.ts";

export const PEER_DISCOVERY_FILE = "peer-discovery.json";

export class PeerDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerDiscoveryError";
  }
}

export interface DiscoveredPeer {
  url: string;
  name: string;
  card_hash: string;
  /** 名片签名的验证结论：verified（验过）/ absent（没签名）/ invalid（对不上，不进账本）。 */
  signature: CardSignatureStatus;
  /** 签名公钥指纹（没签名时为 null）。 */
  key_fp: string | null;
  discovered_at: string;
  last_seen_at: string;
}

export interface PeerDiscoveryStore {
  version: 1;
  peers: DiscoveredPeer[];
}

export function peerDiscoveryPath(home: string): string {
  return join(resolveNyraHome(home), PEER_DISCOVERY_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadPeerDiscovery(home: string): PeerDiscoveryStore {
  const path = peerDiscoveryPath(home);
  if (!existsSync(path)) return { version: 1, peers: [] };
  if (lstatSync(path).isSymbolicLink()) throw new PeerDiscoveryError("发现账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new PeerDiscoveryError("发现账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as PeerDiscoveryStore).version !== 1 ||
    !Array.isArray((raw as PeerDiscoveryStore).peers)) {
    backupCorrupt(path);
    throw new PeerDiscoveryError("发现账本格式无效，已备份");
  }
  return raw as PeerDiscoveryStore;
}

export function savePeerDiscovery(home: string, store: PeerDiscoveryStore): void {
  const path = peerDiscoveryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new PeerDiscoveryError("发现账本不能是符号链接");
  const tmp = join(dirname(path), `.peer-discovery-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordDiscoveryEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`好友发现：${type}`, "peer-discovery", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏发现本身 */ }
}

export interface DiscoverDeps {
  fetchDeps?: CardFetchDeps;
  /** 对方要求 grant 时带的 token（只用于这次拉取，不存）。 */
  authToken?: string;
}

/**
 * 发现一台别人的机器人：拉它的 well-known 名片、验格式、验签名，
 * 记进发现账本。签名对不上或 TOFU 钉住的钥匙变了时拒绝，不记账。
 * 名片没签名不拒绝（标 absent）。同一地址重复发现只更新 last_seen。
 */
export async function discoverPeer(home: string, url: string, deps?: DiscoverDeps): Promise<DiscoveredPeer> {
  const origin = (() => {
    try {
      return new URL(url.trim()).origin;
    } catch {
      throw new PeerDiscoveryError(`发现地址无效：${url}`);
    }
  })();
  const { card, hash } = await fetchAgentCard(origin, deps?.fetchDeps, deps?.authToken);
  // 验签用解析后的卡片对象重建原文哈希：JSON.parse 保留键顺序，
  // 服务端 buildAgentCard 的键顺序固定，删掉 signature/public_key
  // 后再 stringify，哈希与签发时算的能对上；中间有人重排过键就
  // 验不过（fail-closed，不认这张卡）。
  const rawCard = card as unknown as Record<string, unknown>;
  const verified = verifySignedCard(rawCard);
  if (verified.status === "invalid") {
    throw new PeerDiscoveryError(`对方名片签名验不过（${verified.reason}）：伪造嫌疑，不记入发现账本`);
  }
  const store = loadPeerDiscovery(home);
  const now = nowIso();
  const existing = store.peers.find((p) => p.url === origin);
  if (existing) {
    existing.name = card.name;
    existing.card_hash = hash;
    existing.signature = verified.status;
    existing.key_fp = verified.keyFp;
    existing.last_seen_at = now;
    savePeerDiscovery(home, store);
    recordDiscoveryEvent(home, "peer_discovered", { url: origin, name: card.name, signature: verified.status });
    return existing;
  }
  const peer: DiscoveredPeer = {
    url: origin,
    name: card.name,
    card_hash: hash,
    signature: verified.status,
    key_fp: verified.keyFp,
    discovered_at: now,
    last_seen_at: now,
  };
  store.peers.push(peer);
  savePeerDiscovery(home, store);
  recordDiscoveryEvent(home, "peer_discovered", { url: origin, name: card.name, signature: verified.status });
  return peer;
}

export function listDiscoveredPeers(home: string): DiscoveredPeer[] {
  return loadPeerDiscovery(home).peers;
}

export function findDiscoveredPeer(home: string, url: string): DiscoveredPeer | null {
  let origin: string;
  try {
    origin = new URL(url.trim()).origin;
  } catch {
    return null;
  }
  return loadPeerDiscovery(home).peers.find((p) => p.url === origin) ?? null;
}

/**
 * 从发现列表加好友：先发现（拉名片 + 验签名 + 记账），再复用
 * addFriendRequest 发好友请求——不带好友码（发现路径不靠线下传码），
 * 但对方仍须在自己那边 accept，双向批准一分不少。
 * TOFU：对方名片带签名且本机已钉过这把钥匙时，指纹变了直接拒绝。
 */
export async function addDiscoveredPeer(
  home: string,
  config: Record<string, unknown>,
  url: string,
  name: string,
  deps?: DiscoverDeps,
): Promise<{ entry: FriendEntry; card: AgentCard; discovered: DiscoveredPeer }> {
  const discovered = await discoverPeer(home, url, deps);
  if (discovered.signature === "verified" && discovered.key_fp) {
    const status = await cardKeyStatus(home, name, discovered.key_fp).catch(() => "unpinned" as const);
    if (status === "mismatch") {
      throw new PeerDiscoveryError(`${name} 的名片签名钥匙变了（与钉住的不一致）：可能是对方换了钥匙，也可能是冒充——先核对，确认换钥匙后再用 nyra peer card trust ${name} 重钉`);
    }
    if (status === "unpinned") {
      // 第一次见面：把钥匙指纹钉住（TOFU），以后变了就拒绝。
      const { pinCardKey } = await import("./cardSignature.ts");
      // 好友条目是下面 addFriendRequest 才建：先发请求，再钉钥匙。
      const { entry, card } = await addFriendRequest(home, config, { name, url: discovered.url, fetchDeps: deps?.fetchDeps });
      await pinCardKey(home, name, discovered.key_fp);
      return { entry, card, discovered };
    }
  }
  const { entry, card } = await addFriendRequest(home, config, { name, url: discovered.url, fetchDeps: deps?.fetchDeps });
  return { entry, card, discovered };
}

/** 严格校验一张原始名片 JSON（发现流程的第二道门：格式不对不进账本）。 */
export function parseDiscoveredCard(raw: unknown): AgentCard {
  return parseAgentCard(raw);
}
