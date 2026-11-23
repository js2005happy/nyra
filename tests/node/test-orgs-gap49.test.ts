// tests/node/test-orgs-gap49.test.ts — 缺口 49 第一批：组织/成员/角色。
// 全部用临时 home 与本地文件账号目录，不连真实 IdP、不花真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { AccountStore, type Account } from "../../src/accounts.ts";
import {
  ORGS_FILE,
  ORG_AUDIT_FILE,
  OrgError,
  addMember,
  canOrg,
  createOrg,
  deleteOrg,
  getOrg,
  getOrgRole,
  isSuperAdmin,
  listOrgs,
  loadOrgBook,
  removeMember,
  requireOrgAccess,
  setMemberRole,
  saveOrgBook,
} from "../../src/orgs.ts";
import { handleOrg } from "../../src/orgCli.ts";
import { RunStore } from "../../src/runs.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** 在临时 home 里建账号（第一个是 owner，其余是 user；与 AccountStore.create 同款规则）。 */
async function seedAccount(home: string, email: string): Promise<Account> {
  return new AccountStore(home).create({ email });
}

function readOrgAudit(home: string): Record<string, unknown>[] {
  const path = join(home, ORG_AUDIT_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readOrgEvents(home: string): Record<string, unknown>[] {
  const store = new RunStore(join(home, "runs"));
  return store.list().flatMap((s) => store.readEvents(s.run_id)) as Record<string, unknown>[];
}

test("OrgsGap49Test.test_create_org_creator_is_admin", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const org = createOrg(home, "研发组", { description: "做 Nyra 的组", by: boss.id });
    expect(org.id.startsWith("org_")).toBe(true);
    expect(org.name).toBe("研发组");
    expect(org.members).toHaveLength(1);
    expect(org.members[0].account_id).toBe(boss.id);
    expect(org.members[0].role).toBe("admin");
    expect(listOrgs(home)).toHaveLength(1);
    expect(getOrg(home, "研发组").id).toBe(org.id);
    expect(getOrg(home, org.id).name).toBe("研发组");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_create_org_by_machine_owner_has_no_members", () => {
  const home = tmpHome("nyra-org-");
  try {
    const org = createOrg(home, "空组织");
    expect(org.members).toHaveLength(0);
    expect(org.created_by).toBe("owner");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_create_org_rejects_duplicate_and_bad_names", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    createOrg(home, "TeamA", { by: boss.id });
    expect(() => createOrg(home, "TeamA", { by: boss.id })).toThrow(OrgError);
    expect(() => createOrg(home, "teama", { by: boss.id })).toThrow(OrgError);
    expect(() => createOrg(home, "  ", { by: boss.id })).toThrow(OrgError);
    expect(() => createOrg(home, "x".repeat(65), { by: boss.id })).toThrow(OrgError);
    expect(() => createOrg(home, "a/b", { by: boss.id })).toThrow(OrgError);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_add_member_by_email_and_id", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const bob = await seedAccount(home, "bob@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    const m1 = await addMember(home, org.id, "alice@example.com", "member", { by: boss.id });
    expect(m1.role).toBe("member");
    expect(m1.account_id).toBe(alice.id);
    const m2 = await addMember(home, org.id, bob.id, "admin", { by: boss.id });
    expect(m2.role).toBe("admin");
    expect(getOrg(home, org.id).members).toHaveLength(3);
    await expect(addMember(home, org.id, "alice@example.com", "member", { by: boss.id })).rejects.toThrow(OrgError);
    await expect(addMember(home, org.id, "ghost@example.com", "member", { by: boss.id })).rejects.toThrow(OrgError);
    await expect(addMember(home, org.id, bob.id, "super", { by: boss.id })).rejects.toThrow(OrgError);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_add_member_rejects_suspended_account", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await new AccountStore(home).suspend(alice.id);
    await expect(addMember(home, org.id, alice.id, "member", { by: boss.id })).rejects.toThrow("已停用");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_add_member_requires_manager", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const carol = await seedAccount(home, "carol@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "member", { by: boss.id });
    // 普通成员不能开通别人。
    await expect(addMember(home, org.id, carol.id, "member", { by: alice.id })).rejects.toThrow(OrgError);
    // 机主（字面 owner）可以。
    const added = await addMember(home, org.id, carol.id, "viewer", { by: "owner" });
    expect(added.role).toBe("viewer");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_remove_member_and_last_admin_guard", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const bob = await seedAccount(home, "bob@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "member", { by: boss.id });
    await addMember(home, org.id, bob.id, "member", { by: boss.id });
    // 组织里还有别人时，不能撤掉最后一名 admin。
    await expect(removeMember(home, org.id, boss.id, { by: boss.id })).rejects.toThrow("最后一名管理员");
    await removeMember(home, org.id, alice.id, { by: boss.id });
    expect(getOrg(home, org.id).members).toHaveLength(2);
    // 撤掉最后一名成员时允许（组织变空，仍归机主管理）。
    await removeMember(home, org.id, bob.id, { by: boss.id });
    await removeMember(home, org.id, boss.id, { by: boss.id });
    expect(getOrg(home, org.id).members).toHaveLength(0);
    await expect(removeMember(home, org.id, boss.id, { by: boss.id })).rejects.toThrow(OrgError);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_set_role_and_last_admin_guard", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const bob = await seedAccount(home, "bob@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "member", { by: boss.id });
    await addMember(home, org.id, bob.id, "member", { by: boss.id });
    const promoted = await setMemberRole(home, org.id, alice.id, "admin", { by: boss.id });
    expect(promoted.role).toBe("admin");
    // 现在有两名 admin，降级其中一名可以。
    const demoted = await setMemberRole(home, org.id, boss.id, "viewer", { by: boss.id });
    expect(demoted.role).toBe("viewer");
    // 只剩 alice 一名 admin 时，再降级直接拒绝。
    await expect(setMemberRole(home, org.id, alice.id, "member", { by: boss.id })).rejects.toThrow("最后一名管理员");
    // 改成同一角色是 no-op，直接返回。
    const same = await setMemberRole(home, org.id, alice.id, "admin", { by: boss.id });
    expect(same.role).toBe("admin");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_get_org_role_fail_closed", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const ghost = await seedAccount(home, "ghost@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "member", { by: boss.id });
    expect(await getOrgRole(home, org.id, alice.id)).toBe("member");
    expect(await getOrgRole(home, org.id, ghost.id)).toBeNull();
    expect(await getOrgRole(home, "no-such-org", alice.id)).toBeNull();
    expect(await getOrgRole(home, org.id, "no-such-account")).toBeNull();
    // 停用后角色立即失效（现查账号状态，不用等同步）。
    await new AccountStore(home).suspend(alice.id);
    expect(await getOrgRole(home, org.id, alice.id)).toBeNull();
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_can_org_matrix", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const bob = await seedAccount(home, "bob@example.com");
    const carol = await seedAccount(home, "carol@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "viewer", { by: boss.id });
    await addMember(home, org.id, bob.id, "member", { by: boss.id });
    await addMember(home, org.id, carol.id, "admin", { by: boss.id });
    // viewer 只读。
    expect(await canOrg(home, org.id, alice.id, "read")).toBe(true);
    expect(await canOrg(home, org.id, alice.id, "write")).toBe(false);
    expect(await canOrg(home, org.id, alice.id, "manage")).toBe(false);
    // member 读写、不管成员。
    expect(await canOrg(home, org.id, bob.id, "read")).toBe(true);
    expect(await canOrg(home, org.id, bob.id, "write")).toBe(true);
    expect(await canOrg(home, org.id, bob.id, "manage")).toBe(false);
    // admin 全有。
    expect(await canOrg(home, org.id, carol.id, "manage")).toBe(true);
    // 机主全放行；不在组织里的账号全拒绝；非法动作拒绝。
    expect(await canOrg(home, org.id, "owner", "manage")).toBe(true);
    const outsider = await seedAccount(home, "outsider@example.com");
    expect(await canOrg(home, org.id, outsider.id, "read")).toBe(false);
    expect(await canOrg(home, org.id, bob.id, "delete")).toBe(false);
    // 停用后全拒绝。
    await new AccountStore(home).suspend(bob.id);
    expect(await canOrg(home, org.id, bob.id, "read")).toBe(false);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_global_owner_is_super_admin", async () => {
  const home = tmpHome("nyra-org-");
  try {
    // 第一个账号自动是全局 owner。
    const boss = await seedAccount(home, "boss@example.com");
    expect(boss.role).toBe("owner");
    const alice = await seedAccount(home, "alice@example.com");
    expect(alice.role).toBe("user");
    expect(await isSuperAdmin(home, boss.id)).toBe(true);
    expect(await isSuperAdmin(home, alice.id)).toBe(false);
    expect(await isSuperAdmin(home, "owner")).toBe(true);
    expect(await isSuperAdmin(home, "no-such-account")).toBe(false);
    // 全局 owner 不是成员，也能在组织里做 manage（超级管理员）。
    const org = createOrg(home, "研发组");
    expect(await canOrg(home, org.id, boss.id, "manage")).toBe(true);
    expect(await canOrg(home, org.id, alice.id, "manage")).toBe(false);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_delete_org_permissions", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "member", { by: boss.id });
    await expect(deleteOrg(home, org.id, { by: alice.id })).rejects.toThrow(OrgError);
    expect(listOrgs(home)).toHaveLength(1);
    await deleteOrg(home, org.id, { by: boss.id });
    expect(listOrgs(home)).toHaveLength(0);
    expect(() => getOrg(home, org.id)).toThrow(OrgError);
    // 机主能删自己没建的组织。
    const org2 = createOrg(home, "二组", { by: alice.id });
    await deleteOrg(home, org2.id, { by: "owner" });
    expect(listOrgs(home)).toHaveLength(0);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_org_audit_and_events", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "member", { by: boss.id });
    await setMemberRole(home, org.id, alice.id, "viewer", { by: boss.id });
    await removeMember(home, org.id, alice.id, { by: boss.id });
    await deleteOrg(home, org.id, { by: boss.id });
    const audit = readOrgAudit(home);
    expect(audit.map((r) => r.action)).toEqual([
      "org_created", "org_member_added", "org_role_changed", "org_member_removed", "org_deleted",
    ]);
    expect(audit[1].account_id).toBe(alice.id);
    expect(audit[1].role).toBe("member");
    expect(audit[2].role).toBe("viewer");
    // 变更进了证据链：运行事件里找得到。
    const events = readOrgEvents(home);
    const kinds = events.map((e) => e.type);
    for (const kind of ["org_created", "org_member_added", "org_role_changed", "org_member_removed", "org_deleted"]) {
      expect(kinds).toContain(kind);
    }
    const added = events.find((e) => e.type === "org_member_added") as Record<string, unknown>;
    expect(added.org_id).toBe(org.id);
    expect(added.account_id).toBe(alice.id);
    expect(added.role).toBe("member");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_org_ledger_perms_0600", () => {
  const home = tmpHome("nyra-org-");
  try {
    createOrg(home, "研发组");
    expectPerms(join(home, ORGS_FILE), 0o600);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_org_ledger_corrupt_backup", () => {
  const home = tmpHome("nyra-org-");
  try {
    createOrg(home, "研发组");
    writeFileSync(join(home, ORGS_FILE), "{ not json", "utf-8");
    expect(() => loadOrgBook(home)).toThrow(OrgError);
    const backups = readdirSync(home).filter((f) => f.startsWith(ORGS_FILE + ".corrupt-"));
    expect(backups).toHaveLength(1);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_org_extension_slots_roundtrip", () => {
  const home = tmpHome("nyra-org-");
  try {
    const org = createOrg(home, "研发组");
    const book = loadOrgBook(home);
    const target = book.orgs.find((o) => o.id === org.id)!;
    target.shared_bots = ["bot_abc"];
    target.isolation = { data: true, settings: true, usage: false };
    target.private_catalog = true;
    saveOrgBook(home, book);
    const reloaded = getOrg(home, org.id);
    expect(reloaded.shared_bots).toEqual(["bot_abc"]);
    expect(reloaded.isolation).toEqual({ data: true, settings: true, usage: false });
    expect(reloaded.private_catalog).toBe(true);
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_require_org_access_throws", async () => {
  const home = tmpHome("nyra-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, alice.id, "viewer", { by: boss.id });
    await expect(requireOrgAccess(home, org.id, alice.id, "manage")).rejects.toThrow(OrgError);
    await requireOrgAccess(home, org.id, alice.id, "read");
    await requireOrgAccess(home, org.id, boss.id, "manage");
  } finally { cleanup(home); }
});

test("OrgsGap49Test.test_org_cli_smoke", async () => {
  const home = tmpHome("nyra-org-");
  try {
    await seedAccount(home, "boss@example.com");
    const alice = await seedAccount(home, "alice@example.com");
    expect(await handleOrg(["create", "研发组"], home)).toBe(0);
    expect(await handleOrg(["list"], home)).toBe(0);
    expect(await handleOrg(["show", "研发组"], home)).toBe(0);
    expect(await handleOrg(["show", "没有这个组"], home)).toBe(1);
    expect(await handleOrg(["add", "研发组", alice.email], home)).toBe(0);
    expect(await handleOrg(["check", "研发组", alice.email, "read"], home)).toBe(0);
    expect(await handleOrg(["check", "研发组", alice.email, "manage"], home)).toBe(1);
    expect(await handleOrg(["check", "研发组", "owner", "manage"], home)).toBe(0);
    // 破坏性操作不带 --yes 直接拒绝（用法错误 2）。
    expect(await handleOrg(["remove", "研发组", alice.email], home)).toBe(2);
    expect(await handleOrg(["role", "研发组", alice.email, "viewer"], home)).toBe(2);
    expect(await handleOrg(["delete", "研发组"], home)).toBe(2);
    expect(await handleOrg(["role", "研发组", alice.email, "viewer", "--yes"], home)).toBe(0);
    expect(await handleOrg(["remove", "研发组", alice.email, "--yes"], home)).toBe(0);
    expect(await handleOrg(["delete", "研发组", "--yes"], home)).toBe(0);
    expect(await handleOrg(["bogus"], home)).toBe(2);
    expect(await handleOrg(["create"], home)).toBe(2);
  } finally { cleanup(home); }
});
