// tests/node/test-friend-grants-batch2.test.ts — 第 2 批 G-P1-6：好友 grant。
// 全部用临时 home，不调模型、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFriendBook, saveFriendBook } from "../../src/peerCard.ts";
import {
  GRANT_TOKEN_PREFIX,
  friendGrantsPath,
  isGrantLive,
  issueFriendGrant,
  listFriendGrants,
  revokeFriendGrant,
  verifyFriendGrant,
} from "../../src/friendGrants.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function now(): string {
  return new Date().toISOString();
}

function seedFriend(home: string, name: string, opts?: { blocked?: boolean; inbound?: "accepted" | "pending" }): void {
  let book;
  try { book = loadFriendBook(home); } catch { book = { version: 1, friends: [], circles: [{ name: "default", created_at: now() }] }; }
  const entry = {
    name,
    url: "http://127.0.0.1:9/mcp",
    card_hash: "seed",
    circle: "default",
    tier: "readonly" as const,
    outbound: "accepted" as const,
    inbound: opts?.inbound ?? "accepted",
    blocked: opts?.blocked ?? false,
    code_hash: null,
    created_at: now(),
    updated_at: now(),
  };
  const idx = book.friends.findIndex((f) => f.name === name);
  if (idx >= 0) book.friends[idx] = entry;
  else book.friends.push(entry);
  saveFriendBook(home, book);
}

test("FriendGrantsBatch2.test_issue_verify_revoke", () => {
  const home = tmpHome("nyra-grant-");
  try {
    seedFriend(home, "alice");
    const { grant, token } = issueFriendGrant(home, "alice", ["card:read"], 30);
    expect(token.startsWith(GRANT_TOKEN_PREFIX)).toBe(true);
    expect(grant.scope).toEqual(["card:read"]);
    expect(grant.revoked).toBe(false);
    // 账本里只记哈希，不记 token 原文。
    expect(readFileSync(friendGrantsPath(home), "utf-8")).not.toContain(token);
    const verified = verifyFriendGrant(home, token);
    expect(verified?.peer).toBe("alice");
    expect(verifyFriendGrant(home, token, "session:join")).toBeNull();
    expect(verifyFriendGrant(home, "nyra-grant-nope")).toBeNull();
    const revoked = revokeFriendGrant(home, grant.id);
    expect(revoked.revoked).toBe(true);
    expect(verifyFriendGrant(home, token)).toBeNull();
    expect(isGrantLive(revoked)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("FriendGrantsBatch2.test_revoke_one_does_not_affect_others", () => {
  const home = tmpHome("nyra-grant-");
  try {
    seedFriend(home, "alice");
    seedFriend(home, "bob");
    const a = issueFriendGrant(home, "alice", ["card:read"]);
    const b = issueFriendGrant(home, "bob", ["card:read"]);
    revokeFriendGrant(home, a.grant.id);
    expect(verifyFriendGrant(home, a.token)).toBeNull();
    expect(verifyFriendGrant(home, b.token)?.peer).toBe("bob");
    expect(listFriendGrants(home, "bob").length).toBe(1);
    expect(listFriendGrants(home).length).toBe(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("FriendGrantsBatch2.test_issue_rejects_stranger_blocked_and_bad_scope", () => {
  const home = tmpHome("nyra-grant-");
  try {
    expect(() => issueFriendGrant(home, "nobody", ["card:read"])).toThrow("好友账本里没有");
    seedFriend(home, "carol", { inbound: "pending" });
    expect(() => issueFriendGrant(home, "carol", ["card:read"])).toThrow("还不是好友");
    seedFriend(home, "dave", { blocked: true });
    expect(() => issueFriendGrant(home, "dave", ["card:read"])).toThrow("还不是好友");
    seedFriend(home, "erin");
    expect(() => issueFriendGrant(home, "erin", ["do:anything"])).toThrow("scope");
    expect(() => issueFriendGrant(home, "erin", ["card:read"], 0)).toThrow("1–90");
    expect(() => issueFriendGrant(home, "erin", ["card:read"], 91)).toThrow("1–90");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("FriendGrantsBatch2.test_multiple_scopes_and_default_ttl", () => {
  const home = tmpHome("nyra-grant-");
  try {
    seedFriend(home, "alice");
    const { grant } = issueFriendGrant(home, "alice", ["card:read", "session:join"]);
    expect(grant.scope).toEqual(["card:read", "session:join"]);
    const expires = Date.parse(grant.expires_at) - Date.parse(grant.created_at);
    expect(expires).toBe(30 * 24 * 3600 * 1000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
