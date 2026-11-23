// tests/node/test-admission.test.ts — G-P2-2 企业级准入账本。
//
// 钉住的事：
//   - 账本追加/读取往返、0600、符号链接拒绝、坏行跳过、校验正反例；
//   - 过滤（种/人/圈/时间）与 newest-first、who-approved、policy-history；
//   - 导出（stdout 与 --out 文件 0600，账本里没有 token 原文）；
//   - 三处接线：好友批准/拒绝（peerCard）、进圈/离圈（circles）、
//     grant 发放/吊销（friendGrants）、出站 token 存/删（peerTokens）、
//     策略发布（governance）；默认策略初始化不写账；
//   - 写账本失败不破坏原操作（best-effort）；
//   - CLI 全程（handleAdmission，不经过浏览器）。
// 全部在临时 home 上跑，不调真模型、不碰真文件系统外的东西。
import { test, expect } from "bun:test";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  AdmissionError,
  admissionFingerprint,
  admissionLedgerPath,
  appendAdmission,
  exportAdmissions,
  exportAdmissionsToFile,
  getAdmission,
  listAdmissions,
  policyHistory,
  readAdmissions,
  recordAdmission,
  whoApproved,
  type AdmissionEntry,
} from "../../src/admission.ts";
import { handleAdmission } from "../../src/admissionCli.ts";
import { acceptFriend, declineFriend, loadFriendBook, saveFriendBook } from "../../src/peerCard.ts";
import { createCircle, inviteToCircle, revokeFromCircle } from "../../src/circles.ts";
import { issueFriendGrant, revokeFriendGrant } from "../../src/friendGrants.ts";
import { revokePeerToken, setPeerToken } from "../../src/peerTokens.ts";
import { Vault } from "../../src/vault.ts";
import { getCurrentPolicy, publishPolicy } from "../../src/governance.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-adm-test-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 在好友账本里放一个待批准的请求（绕开网络拉名片）。 */
function seedPendingFriend(home: string, name: string): void {
  const book = loadFriendBook(home);
  book.friends.push({
    name, url: `https://${name}.example.com`, card_hash: "aabbcc",
    circle: "default", tier: "readonly", outbound: "none", inbound: "pending",
    blocked: false, code_hash: null, created_at: nowIso(), updated_at: nowIso(),
  });
  saveFriendBook(home, book);
}

function initVault(home: string, password: string): void {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
}

// ---------------------------------------------------------------------------
// 账本本身
// ---------------------------------------------------------------------------

test("AdmissionTest.test_append_read_roundtrip", () => {
  const home = tempHome();
  try {
    expect(readAdmissions(home)).toEqual({ entries: [], skipped: 0 });
    const a = appendAdmission(home, { kind: "friend_approved", actor: "owner", subject: "alice", circle: "default", role: "readonly" });
    expect(a.id.startsWith("adm-")).toBe(true);
    expect(a.at).toBeTruthy();
    const b = appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "alice", circle: "team", role: "friend" });
    expect(b.id).not.toBe(a.id);
    const { entries, skipped } = readAdmissions(home);
    expect(entries).toHaveLength(2);
    expect(skipped).toBe(0);
    expect(entries[0].kind).toBe("friend_approved");
    expect(getAdmission(home, a.id)?.subject).toBe("alice");
    expect(getAdmission(home, "adm-nope")).toBeNull();
    expectPerms(admissionLedgerPath(home), 0o600);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_validation", () => {
  const home = tempHome();
  try {
    expect(() => appendAdmission(home, { kind: "nope" as never, actor: "owner", subject: "x" })).toThrow("种不对");
    expect(() => appendAdmission(home, { kind: "member_joined", actor: "", subject: "x" })).toThrow("不能为空");
    expect(() => appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "x".repeat(129) })).toThrow("过长");
    expect(() => appendAdmission(home, { kind: "token_issued", actor: "owner", subject: "x", token_fingerprint: "zz" })).toThrow("12 位十六进制");
    expect(() => appendAdmission(home, { kind: "policy_changed", actor: "owner", subject: "global", policy_version: -1 })).toThrow("非负整数");
    expect(() => appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "x", detail: "y".repeat(201) })).toThrow("过长");
    expect(readAdmissions(home).entries).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_fingerprint", () => {
  expect(admissionFingerprint("token-abc")).toBe(admissionFingerprint("token-abc"));
  expect(admissionFingerprint("token-abc")).toMatch(/^[0-9a-f]{12}$/);
  expect(admissionFingerprint("token-abd")).not.toBe(admissionFingerprint("token-abc"));
  expect(admissionFingerprint("token-abc")).not.toContain("token-abc");
});

test("AdmissionTest.test_bad_lines_skipped", () => {
  const home = tempHome();
  try {
    appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "alice", circle: "team" });
    appendFileSync(admissionLedgerPath(home), "这行不是 JSON\n", "utf-8");
    appendFileSync(admissionLedgerPath(home), JSON.stringify({ kind: "member_joined" }) + "\n", "utf-8");
    appendAdmission(home, { kind: "member_left", actor: "owner", subject: "alice", circle: "team" });
    const { entries, skipped } = readAdmissions(home);
    expect(entries).toHaveLength(2);
    expect(skipped).toBe(2);
    expect(listAdmissions(home)).toHaveLength(2);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_symlink_refused", () => {
  const home = tempHome();
  try {
    const target = join(home, "elsewhere.jsonl");
    writeFileSync(target, "", "utf-8");
    symlinkSync(target, admissionLedgerPath(home));
    expect(() => appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "x" })).toThrow("符号链接");
    expect(() => readAdmissions(home)).toThrow("符号链接");
    expect(recordAdmission(home, { kind: "member_joined", actor: "owner", subject: "x" })).toBeNull();
    expect(readFileSync(target, "utf-8")).toBe("");
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_append_only_no_rewrite", () => {
  const home = tempHome();
  try {
    const a = appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "alice", circle: "team" });
    const before = readFileSync(admissionLedgerPath(home), "utf-8");
    appendAdmission(home, { kind: "member_left", actor: "owner", subject: "alice", circle: "team" });
    const after = readFileSync(admissionLedgerPath(home), "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(a.id);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function seedLedger(home: string): AdmissionEntry[] {
  const out: AdmissionEntry[] = [];
  out.push(appendAdmission(home, { kind: "friend_approved", actor: "owner", subject: "alice", circle: "default", role: "readonly" }));
  out.push(appendAdmission(home, { kind: "member_joined", actor: "owner", subject: "alice", circle: "team", role: "friend" }));
  out.push(appendAdmission(home, { kind: "token_issued", actor: "owner", subject: "alice", scope: ["card:read"], token_fingerprint: "0123456789ab" }));
  out.push(appendAdmission(home, { kind: "policy_changed", actor: "cli", subject: "global", policy_version: 2, old_policy_version: 1, policy_hash: "abcdef012345" }));
  out.push(appendAdmission(home, { kind: "member_joined", actor: "bob", subject: "carol", circle: "team", role: "friend" }));
  return out;
}

test("AdmissionTest.test_list_filters_newest_first", () => {
  const home = tempHome();
  try {
    const seeded = seedLedger(home);
    const all = listAdmissions(home);
    expect(all).toHaveLength(5);
    // 新的在前：最后一条是最后追加的。
    expect(all[0].id).toBe(seeded[4].id);
    expect(listAdmissions(home, { kind: "member_joined" })).toHaveLength(2);
    expect(listAdmissions(home, { actor: "owner" })).toHaveLength(3);
    expect(listAdmissions(home, { subject: "alice" })).toHaveLength(3);
    expect(listAdmissions(home, { circle: "team" })).toHaveLength(2);
    expect(listAdmissions(home, { limit: 2 })).toHaveLength(2);
    expect(() => listAdmissions(home, { limit: 0 })).toThrow("1–1000");
    expect(() => listAdmissions(home, { since: "不是时间" })).toThrow("有效时间");
    // 时间过滤：用第一条的时间做下限，至少它自己在内。
    const since = listAdmissions(home)[4].at;
    expect(listAdmissions(home, { since }).length).toBeGreaterThanOrEqual(1);
    expect(listAdmissions(home, { until: "2000-01-01T00:00:00.000Z" })).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_who_approved_and_policy_history", () => {
  const home = tempHome();
  try {
    seedLedger(home);
    const who = whoApproved(home, "alice");
    expect(who).toHaveLength(3);
    expect(who.every((e) => e.subject === "alice")).toBe(true);
    expect(who.map((e) => e.kind).sort()).toEqual(["friend_approved", "member_joined", "token_issued"]);
    expect(whoApproved(home, "nobody")).toHaveLength(0);
    const hist = policyHistory(home);
    expect(hist).toHaveLength(1);
    expect(hist[0].policy_version).toBe(2);
    expect(hist[0].old_policy_version).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_export", () => {
  const home = tempHome();
  try {
    expect(exportAdmissions(home)).toBe("");
    seedLedger(home);
    const text = exportAdmissions(home);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(JSON.parse(line).id.startsWith("adm-")).toBe(true);
    const dest = join(home, "export.jsonl");
    expect(exportAdmissionsToFile(home, dest)).toBe(dest);
    expect(readFileSync(dest, "utf-8")).toBe(text);
    expectPerms(dest, 0o600);
    // 导出目标是符号链接时拒绝。
    const link = join(home, "link.jsonl");
    symlinkSync(dest, link);
    expect(() => exportAdmissionsToFile(home, link)).toThrow("符号链接");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 三处接线
// ---------------------------------------------------------------------------

test("AdmissionTest.test_wiring_friend_and_circle", () => {
  const home = tempHome();
  try {
    seedPendingFriend(home, "alice");
    acceptFriend(home, { name: "alice" });
    let entries = listAdmissions(home);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("friend_approved");
    expect(entries[0].subject).toBe("alice");
    expect(entries[0].role).toBe("readonly");
    createCircle(home, "team");
    inviteToCircle(home, { circle: "team", identity: "alice" });
    entries = listAdmissions(home);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("member_joined");
    expect(entries[0].circle).toBe("team");
    expect(entries[0].role).toBe("friend");
    revokeFromCircle(home, "team", "alice");
    entries = listAdmissions(home);
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe("member_left");
    // 拒绝也记账。
    seedPendingFriend(home, "bob");
    declineFriend(home, "bob");
    entries = listAdmissions(home);
    expect(entries).toHaveLength(4);
    expect(entries[0].kind).toBe("friend_declined");
    expect(entries[0].subject).toBe("bob");
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_wiring_grants_no_token_plaintext", () => {
  const home = tempHome();
  try {
    seedPendingFriend(home, "alice");
    acceptFriend(home, { name: "alice" });
    const { grant, token } = issueFriendGrant(home, "alice", ["card:read", "session:join"]);
    let entries = listAdmissions(home);
    const issued = entries.find((e) => e.kind === "token_issued");
    expect(issued).toBeTruthy();
    expect(issued?.subject).toBe("alice");
    expect(issued?.scope).toEqual(["card:read", "session:join"]);
    expect(issued?.token_fingerprint).toBe(grant.token_hash.slice(0, 12));
    // 账本全文里没有 token 原文。
    expect(readFileSync(admissionLedgerPath(home), "utf-8")).not.toContain(token);
    revokeFriendGrant(home, grant.id, "owner");
    entries = listAdmissions(home);
    const revoked = entries.find((e) => e.kind === "token_revoked");
    expect(revoked).toBeTruthy();
    expect(revoked?.token_fingerprint).toBe(grant.token_hash.slice(0, 12));
    expect(readFileSync(admissionLedgerPath(home), "utf-8")).not.toContain(token);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_wiring_peer_tokens", () => {
  const home = tempHome();
  try {
    initVault(home, "pw123456");
    setPeerToken(home, "alice", "secret-token-xyz", "pw123456");
    let entries = listAdmissions(home);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("token_issued");
    expect(entries[0].token_fingerprint).toBe(admissionFingerprint("secret-token-xyz"));
    expect(readFileSync(admissionLedgerPath(home), "utf-8")).not.toContain("secret-token-xyz");
    expect(revokePeerToken(home, "alice", "pw123456")).toBe(true);
    entries = listAdmissions(home);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("token_revoked");
    // 没删掉时不记账。
    expect(revokePeerToken(home, "alice", "pw123456")).toBe(false);
    expect(listAdmissions(home)).toHaveLength(2);
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_wiring_policy_publish", () => {
  const home = tempHome();
  try {
    // 默认策略初始化不写账。
    expect(getCurrentPolicy(home).version).toBe(1);
    expect(listAdmissions(home)).toHaveLength(0);
    const r = publishPolicy(home, { reason: "测试发布", rules: { allow: [], ask: [], deny: [] } });
    expect(r.policy.version).toBe(2);
    const entries = listAdmissions(home);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("policy_changed");
    expect(entries[0].policy_version).toBe(2);
    expect(entries[0].old_policy_version).toBe(1);
    expect(entries[0].policy_hash).toBe(r.policy.hash.slice(0, 12));
    expect(entries[0].subject).toBe("global");
    expect(readFileSync(admissionLedgerPath(home), "utf-8")).not.toContain("测试发布");
  } finally {
    cleanup(home);
  }
});

test("AdmissionTest.test_wiring_best_effort", () => {
  const home = tempHome();
  try {
    // 账本路径被目录占住：写账本失败，但入圈本身照样成功。
    mkdirSync(admissionLedgerPath(home), { recursive: true });
    seedPendingFriend(home, "alice");
    acceptFriend(home, { name: "alice" });
    createCircle(home, "team");
    const m = inviteToCircle(home, { circle: "team", identity: "alice" });
    expect(m.identity).toBe("alice");
    expect(existsSync(admissionLedgerPath(home))).toBe(true);
    expect(lstatSync(admissionLedgerPath(home)).isDirectory()).toBe(true);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("AdmissionTest.test_cli", async () => {
  const home = tempHome();
  try {
    expect(await handleAdmission(["log"], home)).toBe(0);
    expect(await handleAdmission(["--help"], home)).toBe(2);
    expect(await handleAdmission(["bogus"], home)).toBe(2);
    expect(await handleAdmission(["show"], home)).toBe(2);
    expect(await handleAdmission(["who-approved"], home)).toBe(2);
    expect(await handleAdmission(["log", "--kind", "nope"], home)).toBe(1);
    expect(await handleAdmission(["log", "--limit", "x"], home)).toBe(1);
    seedLedger(home);
    expect(await handleAdmission(["log"], home)).toBe(0);
    expect(await handleAdmission(["log", "--json"], home)).toBe(0);
    expect(await handleAdmission(["log", "--kind", "policy_changed"], home)).toBe(0);
    expect(await handleAdmission(["log", "--actor", "owner", "--subject", "alice"], home)).toBe(0);
    const first = listAdmissions(home)[0];
    expect(await handleAdmission(["show", first.id], home)).toBe(0);
    expect(await handleAdmission(["show", first.id, "--json"], home)).toBe(0);
    expect(await handleAdmission(["show", "adm-nope"], home)).toBe(1);
    expect(await handleAdmission(["who-approved", "alice"], home)).toBe(0);
    expect(await handleAdmission(["who-approved", "alice", "--json"], home)).toBe(0);
    expect(await handleAdmission(["who-approved", "nobody"], home)).toBe(0);
    expect(await handleAdmission(["policy-history"], home)).toBe(0);
    expect(await handleAdmission(["export"], home)).toBe(0);
    const dest = join(home, "out.jsonl");
    expect(await handleAdmission(["export", "--out", dest], home)).toBe(0);
    expect(readFileSync(dest, "utf-8")).toBe(exportAdmissions(home));
    expectPerms(dest, 0o600);
  } finally {
    cleanup(home);
  }
});
