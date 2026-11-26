// tests/node/test-peer-discovery-batch3.test.ts — 第 3 批 G-P1-4：
// Agent Card 公开发现（well-known + 验签 + TOFU）与 per-peer token。
// 全部用临时 home + 假 fetch，不起真服务器、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../../src/vault.ts";
import { discoverPeer, addDiscoveredPeer, listDiscoveredPeers } from "../../src/peerDiscovery.ts";
import { generateSigningKeypair, signAgentCard, jwkThumbprint, pinCardKey, cardKeyStatus } from "../../src/cardSignature.ts";
import { PEER_TOKEN_VAULT_PREFIX, setPeerToken, getPeerToken, revokePeerToken, listPeerTokenNames, fetchAgentCardAuthed } from "../../src/peerTokens.ts";
import { loadFriendBook } from "../../src/peerCard.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 假 peer 的名片（字段顺序与 buildAgentCard 一致，验签才对得上）。 */
function fakeCard(name: string): Record<string, unknown> {
  return {
    name,
    description: "fake peer agent",
    url: "https://other.example.com",
    version: "0.5.6",
    skills: [],
    authentication: { schemes: ["bearer"] },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    endpoints: { mcp: "https://other.example.com/mcp" },
  };
}

function signedCard(name: string): { text: string; kid: string; fp: string } {
  const kp = generateSigningKeypair();
  const card = fakeCard(name);
  const sig = signAgentCard(card, kp);
  return { text: JSON.stringify({ ...card, signature: sig.jws, public_key: sig.publicKey }), kid: kp.kid, fp: jwkThumbprint(sig.publicKey as Record<string, unknown>) };
}

function fetchDepsFor(text: string, status = 200) {
  return {
    fetchFn: async (_url: string, _init?: Record<string, unknown>) => ({
      ok: status === 200,
      status,
      text: async () => text,
    }),
  };
}

/** 建一个已解锁的密码箱（token/签名钥匙测试用）。 */
function initVault(home: string, password: string): Vault {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  return vault;
}

test("PeerDiscoveryBatch3.test_discover_unsigned_card_absent", async () => {
  const home = tmpHome("nyra-discover-");
  try {
    const d = await discoverPeer(home, "https://other.example.com", {
      fetchDeps: fetchDepsFor(JSON.stringify(fakeCard("OtherBot"))),
    });
    expect(d.name).toBe("OtherBot");
    expect(d.url).toBe("https://other.example.com");
    expect(d.signature).toBe("absent");
    expect(d.key_fp).toBeNull();
    expect(listDiscoveredPeers(home)).toHaveLength(1);
    // 再发现一次：更新 last_seen，不重复记
    const d2 = await discoverPeer(home, "https://other.example.com/", {
      fetchDeps: fetchDepsFor(JSON.stringify(fakeCard("OtherBot"))),
    });
    expect(d2.url).toBe("https://other.example.com");
    expect(listDiscoveredPeers(home)).toHaveLength(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PeerDiscoveryBatch3.test_discover_signed_card_verified", async () => {
  const home = tmpHome("nyra-discover-");
  try {
    const { text, fp } = signedCard("SignedBot");
    const d = await discoverPeer(home, "https://signed.example.com", { fetchDeps: fetchDepsFor(text) });
    expect(d.signature).toBe("verified");
    expect(d.key_fp).toBe(fp);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PeerDiscoveryBatch3.test_discover_tampered_card_rejected", async () => {
  const home = tmpHome("nyra-discover-");
  try {
    const { text } = signedCard("SignedBot");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    parsed.description = "tampered";
    await expect(discoverPeer(home, "https://signed.example.com", {
      fetchDeps: fetchDepsFor(JSON.stringify(parsed)),
    })).rejects.toThrow("签名验不过");
    expect(listDiscoveredPeers(home)).toHaveLength(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PeerDiscoveryBatch3.test_discover_unreachable_rejected", async () => {
  const home = tmpHome("nyra-discover-");
  try {
    await expect(discoverPeer(home, "https://down.example.com", {
      fetchDeps: fetchDepsFor("not found", 404),
    })).rejects.toThrow("拉不到");
    await expect(discoverPeer(home, "not-a-url")).rejects.toThrow("发现地址无效");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PeerDiscoveryBatch3.test_add_discovered_peer_tofu_pin_and_mismatch", async () => {
  const home = tmpHome("nyra-discover-");
  try {
    const config: Record<string, unknown> = { peers: { enabled: true } };
    const { text, fp } = signedCard("SignedBot");
    const deps = { fetchDeps: fetchDepsFor(text) };
    const res = await addDiscoveredPeer(home, config, "https://signed.example.com", "pilot", deps);
    expect(res.entry.name).toBe("pilot");
    expect(res.discovered.signature).toBe("verified");
    // 第一次见面钉住钥匙（完整指纹）
    expect(await cardKeyStatus(home, "pilot", fp)).toBe("pinned");
    expect(loadFriendBook(home).friends[0].card_key_fp).toBe(fp);
    // 对方换了钥匙再发现并加好友：mismatch，直接拒绝
    const other = signedCard("SignedBot");
    expect(other.fp).not.toBe(fp);
    await expect(addDiscoveredPeer(home, config, "https://signed.example.com", "pilot", {
      fetchDeps: fetchDepsFor(other.text),
    })).rejects.toThrow("钥匙变了");
    // 机主显式重钉后，再加就放行（这里只验重钉本身）
    await pinCardKey(home, "pilot", other.fp);
    expect(await cardKeyStatus(home, "pilot", other.fp)).toBe("pinned");
    expect(await cardKeyStatus(home, "pilot", fp)).toBe("mismatch");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PeerDiscoveryBatch3.test_peer_token_per_peer_revoke_isolated", async () => {
  const home = tmpHome("nyra-discover-");
  const prevPw = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "pw123456";
  try {
    const vault = initVault(home, "pw123456");
    setPeerToken(home, "alice", "token-alice-1", "pw123456");
    vault.add(`${PEER_TOKEN_VAULT_PREFIX}bob`, "token-bob-1");
    expect(getPeerToken(home, "alice")).toBe("token-alice-1");
    expect(listPeerTokenNames(home, "pw123456").sort()).toEqual(["alice", "bob"]);
    // 吊销一家，别家不动
    expect(revokePeerToken(home, "alice", "pw123456")).toBe(true);
    expect(getPeerToken(home, "alice")).toBeNull();
    expect(getPeerToken(home, "bob")).toBe("token-bob-1");
    expect(revokePeerToken(home, "alice", "pw123456")).toBe(false);
    // 没密码箱打不开
    expect(() => setPeerToken(home, "carol", "x", "wrong-password")).toThrow();
  } finally {
    if (prevPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prevPw;
    rmSync(home, { recursive: true, force: true });
  }
});

test("PeerDiscoveryBatch3.test_fetch_agent_card_authed_uses_stored_token", async () => {
  const home = tmpHome("nyra-discover-");
  const prevPw = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "pw123456";
  try {
    initVault(home, "pw123456");
    setPeerToken(home, "alice", "secret-token-xyz", "pw123456");
    let seenAuth: unknown = null;
    const deps = {
      fetchFn: async (_url: string, init?: Record<string, unknown>) => {
        seenAuth = (init as Record<string, unknown> | undefined)?.headers;
        return { ok: true, status: 200, text: async () => JSON.stringify(fakeCard("AliceBot")) };
      },
    };
    const res = await fetchAgentCardAuthed("https://alice.example.com", "alice", home, deps);
    expect(res.authed).toBe(true);
    expect(res.card.name).toBe("AliceBot");
    expect(seenAuth).toEqual({ Authorization: "Bearer secret-token-xyz" });
    // 没存 token 的 peer：不带 Bearer，但照样拉（authed=false）
    seenAuth = null;
    const res2 = await fetchAgentCardAuthed("https://bob.example.com", "bob", home, deps);
    expect(res2.authed).toBe(false);
    expect(seenAuth).toBeUndefined();
  } finally {
    if (prevPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prevPw;
    rmSync(home, { recursive: true, force: true });
  }
});
