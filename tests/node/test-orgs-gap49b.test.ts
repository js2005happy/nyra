// tests/node/test-orgs-gap49b.test.ts — 缺口 49 第二批：共享 Bot、租户隔离、组织内私有目录。
// 全部用临时 home 与本地文件账号目录，不连真实 IdP、不花真实 token、不碰真网关。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { AccountStore, type Account } from "../../src/accounts.ts";
import {
  ORG_OWNER_IDENTITY,
  addMember,
  createOrg,
  type Org,
} from "../../src/orgs.ts";
import {
  ORG_CATALOG_FILE,
  ORG_SHARING_FILE,
  ORG_VIOLATIONS_FILE,
  OrgSharingError,
  canAccessMemoryEntry,
  canAccessTask,
  canReadSharedBot,
  canSharedBotWrite,
  checkOrgFileAccess,
  effectiveOrgIsolation,
  findSharedBot,
  grantCrossAccess,
  grantSharedBotWrite,
  installOrgCatalogTemplate,
  listCrossAccess,
  listLearnings,
  listOrgCatalog,
  listOrgMemoryEntries,
  listOrgTasks,
  listSharedBots,
  listViolations,
  listWriteGrants,
  loadSharingBook,
  publishOrgCatalogTemplate,
  publishSharedBot,
  readOrgFile,
  readViolations,
  removeOrgCatalogTemplate,
  reviewLearning,
  revokeCrossAccess,
  revokeSharedBotWrite,
  setOrgWorkspace,
  submitLearning,
  unshareBot,
} from "../../src/orgSharing.ts";
import { listTaskIdsByOrg, markTaskOrg, readTaskOrg } from "../../src/taskOrg.ts";
import { listMemoryGateEntries, rememberMemoryEntry } from "../../src/memoryGate.ts";
import { addTask } from "../../src/tasks.ts";
import { handleOrg } from "../../src/orgCli.ts";
import { handleMemoryGate } from "../../src/memoryGateCli.ts";
import { RunStore } from "../../src/runs.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

async function seedAccount(home: string, email: string): Promise<Account> {
  return new AccountStore(home).create({ email });
}

/** 研发组：boss 是创建者（admin），alice 是 member，carol 是 viewer，dave 在组织外。 */
async function seedOrg(home: string): Promise<{ boss: Account; alice: Account; carol: Account; dave: Account; org: Org }> {
  const boss = await seedAccount(home, "boss@example.com");
  const alice = await seedAccount(home, "alice@example.com");
  const carol = await seedAccount(home, "carol@example.com");
  const dave = await seedAccount(home, "dave@example.com");
  const org = createOrg(home, "研发组", { by: boss.id });
  await addMember(home, org.id, alice.email, "member", { by: boss.id });
  await addMember(home, org.id, carol.email, "viewer", { by: boss.id });
  return { boss, alice, carol, dave, org };
}

function readOrgEvents(home: string): Record<string, unknown>[] {
  const store = new RunStore(join(home, "runs"));
  return store.list().flatMap((s) => store.readEvents(s.run_id)) as Record<string, unknown>[];
}

const TOOL_ONLY_TEMPLATE = `name: tool_only_test
version: 1.0.0
license: MIT
description: "测试用纯工具模板"
acceptance:
  - "has-changes"
  - "file-exists:out.txt"
trial:
  inputs:
    in_path: "input.txt"
    out_path: "out.txt"
trial_files:
  - path: "input.txt"
    content: "测试输入：三行数据。"
workflow:
  name: tool_only_test
  version: 1
  mode: fixed
  inputs:
    in_path: "input.txt"
    out_path: "out.txt"
  steps:
    - id: read_input
      type: tool
      tool: read_file
      args:
        path: "{in_path}"
    - id: write_output
      type: tool
      tool: write_file
      args:
        path: "{out_path}"
        content: "已处理"
`;

test("OrgsGap49bTest.test_share_bot_default_read_only", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, carol, org } = await seedOrg(home);
    const bot = await publishSharedBot(home, org.id, "team-bot", { botName: "Team Bot", by: boss.id });
    expect(bot.shared_with).toBe("org");
    expect(bot.status).toBe("active");
    expect((await findSharedBot(loadSharingBook(home), org.id, "team-bot"))?.bot_id).toBe("team-bot");
    // 默认只读：没写授权时 member 连 viewer 的写都拒绝。
    expect(await canReadSharedBot(home, org.id, "team-bot", alice.id)).toBe(true);
    expect(await canReadSharedBot(home, org.id, "team-bot", carol.id)).toBe(true);
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_memory")).toBe(false);
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_file")).toBe(false);
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "send_message")).toBe(false);
    // 共享事件进证据链。
    expect(readOrgEvents(home).some((e) => e.type === "org_bot_shared" && e.bot_id === "team-bot")).toBe(true);
    expectPerms(join(home, ORG_SHARING_FILE), 0o600);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_share_to_specific_people", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, carol, org } = await seedOrg(home);
    await publishSharedBot(home, org.id, "team-bot", { by: boss.id, sharedWith: [alice.id] });
    expect(await canReadSharedBot(home, org.id, "team-bot", alice.id)).toBe(true);
    expect(await canReadSharedBot(home, org.id, "team-bot", carol.id)).toBe(false);
    expect(await listSharedBots(home, org.id, carol.id)).toHaveLength(0);
    expect(await listSharedBots(home, org.id, alice.id)).toHaveLength(1);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_share_by_outsider_rejected", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { dave, org } = await seedOrg(home);
    await expect(publishSharedBot(home, org.id, "team-bot", { by: dave.id })).rejects.toThrow(OrgSharingError);
    expect(await listSharedBots(home, org.id, ORG_OWNER_IDENTITY)).toHaveLength(0);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_grant_write_owner_only_and_expiry", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, carol, org } = await seedOrg(home);
    await publishSharedBot(home, org.id, "team-bot", { by: boss.id });
    // member 自己给自己批写授权不行（须 Bot 主人显式接受）。
    await expect(grantSharedBotWrite(home, org.id, "team-bot", alice.email, ["write_memory"], { by: alice.id })).rejects.toThrow(OrgSharingError);
    const grant = await grantSharedBotWrite(home, org.id, "team-bot", alice.email, ["write_memory", "write_file"], { by: boss.id });
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_memory")).toBe(true);
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_file")).toBe(true);
    // 没批的动作还是拒绝；读是写的前提之外的事（写授权不等于读授权，这里只验写）。
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "send_message")).toBe(false);
    expect((await listWriteGrants(home, org.id, "team-bot", boss.id))).toHaveLength(1);
    expect(grant.actions).toEqual(["write_memory", "write_file"]);
    // 过期的授权当场失效（用另一位成员测：同一账号已有有效授权时须先回收再重新给）。
    const expired = await grantSharedBotWrite(home, org.id, "team-bot", carol.email, ["send_message"], { by: boss.id, expiresAt: "2020-01-01T00:00:00Z" });
    expect(expired.expires_at).toBe("2020-01-01T00:00:00.000Z");
    expect(await canSharedBotWrite(home, org.id, "team-bot", carol.id, "send_message")).toBe(false);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_revoke_write_and_unshare_invalidate", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, org } = await seedOrg(home);
    await publishSharedBot(home, org.id, "team-bot", { by: boss.id });
    await grantSharedBotWrite(home, org.id, "team-bot", alice.email, ["write_memory"], { by: boss.id });
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_memory")).toBe(true);
    await revokeSharedBotWrite(home, org.id, "team-bot", alice.email, { by: boss.id });
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_memory")).toBe(false);
    expect((await listWriteGrants(home, org.id, "team-bot", boss.id))).toHaveLength(0);
    // 重新授权后取消共享，写授权随共享一起失效。
    await grantSharedBotWrite(home, org.id, "team-bot", alice.email, ["write_memory"], { by: boss.id });
    await unshareBot(home, org.id, "team-bot", { by: boss.id });
    expect(await findSharedBot(loadSharingBook(home), org.id, "team-bot")).toBeNull();
    expect(await canReadSharedBot(home, org.id, "team-bot", alice.id)).toBe(false);
    expect(await canSharedBotWrite(home, org.id, "team-bot", alice.id, "write_memory")).toBe(false);
    expect(readOrgEvents(home).some((e) => e.type === "org_bot_unshared")).toBe(true);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_learning_approval_creates_org_memory", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, org } = await seedOrg(home);
    await publishSharedBot(home, org.id, "team-bot", { by: boss.id });
    const learning = await submitLearning(home, org.id, "team-bot", "周五下午四点发版，别在周一早上动生产", { by: alice.id });
    expect(learning.status).toBe("pending");
    expect((await listLearnings(home, org.id, "team-bot", alice.id, "pending"))).toHaveLength(1);
    // member 自己批不了（须 Bot 主人或组织 admin）。
    await expect(reviewLearning(home, learning.id, "approve", { by: alice.id })).rejects.toThrow(OrgSharingError);
    const approved = await reviewLearning(home, learning.id, "approve", { by: boss.id });
    expect(approved.status).toBe("approved");
    expect(approved.memory_entry_id).toBeTruthy();
    const entries = listMemoryGateEntries(home, { scope: "org", orgId: org.id });
    expect(entries.some((e) => e.id === approved.memory_entry_id && e.content.includes("周五下午四点发版"))).toBe(true);
    expect(readOrgEvents(home).some((e) => e.type === "org_learning_approved")).toBe(true);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_learning_reject_leaves_no_memory", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, org } = await seedOrg(home);
    await publishSharedBot(home, org.id, "team-bot", { by: boss.id });
    const learning = await submitLearning(home, org.id, "team-bot", "这句不对，别记", { by: alice.id });
    const rejected = await reviewLearning(home, learning.id, "reject", { by: boss.id });
    expect(rejected.status).toBe("rejected");
    expect(rejected.memory_entry_id).toBeNull();
    expect(listMemoryGateEntries(home, { scope: "org", orgId: org.id })).toHaveLength(0);
    expect(readOrgEvents(home).some((e) => e.type === "org_learning_rejected")).toBe(true);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_learning_by_outsider_rejected", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { dave, org } = await seedOrg(home);
    await expect(submitLearning(home, org.id, "team-bot", "外人教一句", { by: dave.id })).rejects.toThrow(OrgSharingError);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_task_org_attribution_and_gate", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, dave, org } = await seedOrg(home);
    const state = addTask("给组织写一份周报", { orgId: org.id, mode: "readonly", home });
    expect(readTaskOrg(home, state.run_id)).toBe(org.id);
    expect(listTaskIdsByOrg(home, org.id)).toContain(state.run_id);
    expect((await canAccessTask(home, state.run_id, alice.id)).allowed).toBe(true);
    expect((await canAccessTask(home, state.run_id, dave.id)).allowed).toBe(false);
    expect((await canAccessTask(home, state.run_id, ORG_OWNER_IDENTITY)).allowed).toBe(true);
    expect((await listOrgTasks(home, org.id, alice.id))).toHaveLength(1);
    await expect(listOrgTasks(home, org.id, dave.id)).rejects.toThrow(OrgSharingError);
    // 没归属的任务不进组织列表。
    const plain = addTask("全局任务", { mode: "readonly", home });
    expect(readTaskOrg(home, plain.run_id)).toBeNull();
    expect((await canAccessTask(home, plain.run_id, dave.id)).allowed).toBe(true);
    expect(listTaskIdsByOrg(home, org.id)).not.toContain(plain.run_id);
    // sidecar 直接记也能读出来。
    markTaskOrg(home, plain.run_id, org.id);
    expect(readTaskOrg(home, plain.run_id)).toBe(org.id);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_org_memory_attribution_and_gate", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, dave, org } = await seedOrg(home);
    const entry = rememberMemoryEntry(home, {
      scope: "org", projectId: null, orgId: org.id, subject: "发版节奏", content: "周五下午四点发版",
      sourceRefs: [], status: "confirmed", evidenceQuotes: ["周五下午四点发版"],
    }, null, { actor: boss.id, checkVerbatim: false });
    expect(entry.orgId).toBe(org.id);
    expect(await canAccessMemoryEntry(home, entry, alice.id)).toBe(true);
    expect(await canAccessMemoryEntry(home, entry, dave.id)).toBe(false);
    expect(await canAccessMemoryEntry(home, entry, ORG_OWNER_IDENTITY)).toBe(true);
    expect((await listOrgMemoryEntries(home, org.id, alice.id))).toHaveLength(1);
    await expect(listOrgMemoryEntries(home, org.id, dave.id)).rejects.toThrow(OrgSharingError);
    // scope=user 的条目不能带 orgId；scope=org 没 orgId 也写不进去。
    expect(() => rememberMemoryEntry(home, {
      scope: "user", projectId: null, orgId: org.id, subject: "错", content: "错",
      sourceRefs: [], status: "confirmed", evidenceQuotes: ["错"],
    }, null, { actor: boss.id, checkVerbatim: false })).toThrow();
    expect(() => rememberMemoryEntry(home, {
      scope: "org", projectId: null, orgId: null, subject: "错", content: "错",
      sourceRefs: [], status: "confirmed", evidenceQuotes: ["错"],
    }, null, { actor: boss.id, checkVerbatim: false })).toThrow();
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_workspace_file_read_and_traversal_blocked", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, dave, org } = await seedOrg(home);
    const ws = join(home, "ws");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "notes.txt"), "组织内部笔记\n第二行");
    writeFileSync(join(home, "outside.txt"), "组织外的文件");
    // 没绑工作区时读文件直接拒绝（不猜目录）。
    await expect(readOrgFile(home, org.id, alice.id, "notes.txt")).rejects.toThrow(OrgSharingError);
    await setOrgWorkspace(home, org.id, ws, { by: boss.id });
    const got = await readOrgFile(home, org.id, alice.id, "notes.txt");
    expect(got.content).toBe("组织内部笔记\n第二行");
    expect(got.path).toBe("notes.txt");
    // 组织外的人读不到，违反记进账本与证据链。
    await expect(readOrgFile(home, org.id, dave.id, "notes.txt")).rejects.toThrow(OrgSharingError);
    expect(readViolations(home).some((v) => v.org_id === org.id && v.what === "file" && v.account_id === dave.id)).toBe(true);
    expect(readOrgEvents(home).some((e) => e.type === "org_isolation_violation" && e.what === "file")).toBe(true);
    // ../ 逃出工作区直接拦下，同样记违反。
    await expect(readOrgFile(home, org.id, alice.id, "../outside.txt")).rejects.toThrow(OrgSharingError);
    expect(readViolations(home).some((v) => v.what === "file" && v.detail.includes("逃出"))).toBe(true);
    // 绝对路径不在工作区内也拦下。
    await expect(readOrgFile(home, org.id, alice.id, join(home, "outside.txt"))).rejects.toThrow(OrgSharingError);
    expectPerms(join(home, ORG_VIOLATIONS_FILE), 0o600);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_workspace_set_requires_admin", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { alice, org } = await seedOrg(home);
    await expect(setOrgWorkspace(home, org.id, join(home, "ws"), { by: alice.id })).rejects.toThrow(OrgSharingError);
    await expect(setOrgWorkspace(home, org.id, join(home, "不存在的目录"), { by: ORG_OWNER_IDENTITY })).rejects.toThrow(OrgSharingError);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_cross_access_grant_and_revoke", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, dave, org } = await seedOrg(home);
    const ws = join(home, "ws");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "shared.txt"), "跨组织可读");
    await setOrgWorkspace(home, org.id, ws, { by: boss.id });
    // 没授权前组织外的人读不到。
    expect((await checkOrgFileAccess(home, org.id, dave.id, "shared.txt")).allowed).toBe(false);
    const grant = await grantCrossAccess(home, org.id, "", dave.email, { by: boss.id });
    expect(grant.granted_to_kind).toBe("account");
    expect((await checkOrgFileAccess(home, org.id, dave.id, "shared.txt")).allowed).toBe(true);
    expect((await readOrgFile(home, org.id, dave.id, "shared.txt")).content).toBe("跨组织可读");
    expect((await listCrossAccess(home, org.id, boss.id))).toHaveLength(1);
    await revokeCrossAccess(home, grant.id, { by: boss.id });
    expect((await checkOrgFileAccess(home, org.id, dave.id, "shared.txt")).allowed).toBe(false);
    await expect(readOrgFile(home, org.id, dave.id, "shared.txt")).rejects.toThrow(OrgSharingError);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_cross_access_org_to_org", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, dave, org } = await seedOrg(home);
    const other = createOrg(home, "友商组", { by: boss.id });
    await addMember(home, other.id, dave.email, "member", { by: boss.id });
    const ws = join(home, "ws");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "shared.txt"), "给友商组看");
    await setOrgWorkspace(home, org.id, ws, { by: boss.id });
    await grantCrossAccess(home, org.id, "", `org:${other.id}`, { by: boss.id });
    expect((await checkOrgFileAccess(home, org.id, dave.id, "shared.txt")).allowed).toBe(true);
    expect((await checkOrgFileAccess(home, org.id, alice.id, "shared.txt")).allowed).toBe(true);
    // 友商组外的账号还是读不到。
    const eve = await seedAccount(home, "eve@example.com");
    expect((await checkOrgFileAccess(home, org.id, eve.id, "shared.txt")).allowed).toBe(false);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_isolation_data_always_on", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { org } = await seedOrg(home);
    expect(effectiveOrgIsolation(org).data).toBe(true);
    // 老组织（缺 isolation 字段）同样按开处理。
    expect(effectiveOrgIsolation({ ...org, isolation: undefined }).data).toBe(true);
    // 即使账本里写了 data:false，硬边界也不关。
    expect(effectiveOrgIsolation({ ...org, isolation: { data: false, settings: false, usage: false } }).data).toBe(true);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_org_catalog_publish_install_remove", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, org } = await seedOrg(home);
    const file = join(home, "tool_only_test.yaml");
    writeFileSync(file, TOOL_ONLY_TEMPLATE);
    const entry = await publishOrgCatalogTemplate(home, org.id, file, { by: boss.id });
    expect(entry.name).toBe("tool_only_test");
    expect(entry.version).toBe("1.0.0");
    expect((await listOrgCatalog(home, org.id, alice.id))).toHaveLength(1);
    expect(existsSync(join(home, ORG_CATALOG_FILE))).toBe(true);
    // 安装走公开市场同一条路：装成 draft，账本里有记录。
    const installed = await installOrgCatalogTemplate(home, org.id, "tool_only_test", { by: alice.id });
    expect(installed.name).toBe("tool_only_test");
    expect(installed.status).toBe("draft");
    // 坏模板发布不进去（与公开市场同一套校验）。
    const badFile = join(home, "bad.yaml");
    writeFileSync(badFile, "name: 坏模板\nversion: 1.0.0\n");
    await expect(publishOrgCatalogTemplate(home, org.id, badFile, { by: boss.id })).rejects.toThrow();
    await removeOrgCatalogTemplate(home, org.id, "tool_only_test", { by: boss.id });
    expect((await listOrgCatalog(home, org.id, alice.id))).toHaveLength(0);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_org_catalog_publish_requires_manage", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { alice, org } = await seedOrg(home);
    const file = join(home, "tool_only_test.yaml");
    writeFileSync(file, TOOL_ONLY_TEMPLATE);
    await expect(publishOrgCatalogTemplate(home, org.id, file, { by: alice.id })).rejects.toThrow(OrgSharingError);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_cli_share_and_tasks", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { org } = await seedOrg(home);
    expect(await handleOrg(["share", "研发组", "team-bot", "--name", "Team Bot"], home)).toBe(0);
    expect(await handleOrg(["shared", "研发组"], home)).toBe(0);
    expect(await handleOrg(["grants", "研发组", "team-bot"], home)).toBe(0);
    expect(await handleOrg(["learnings", "研发组", "team-bot", "submit", "周五下午四点发版"], home)).toBe(0);
    expect(await handleOrg(["learnings", "研发组", "team-bot", "list"], home)).toBe(0);
    expect(await handleOrg(["task-add", "研发组", "给组织写一份周报"], home)).toBe(0);
    expect(await handleOrg(["tasks", "研发组"], home)).toBe(0);
    expect(await handleOrg(["violations", "研发组"], home)).toBe(0);
    expect(await handleOrg(["isolation", "研发组"], home)).toBe(0);
    expect(await handleOrg(["memory", "研发组"], home)).toBe(0);
    // 用法错回 2。
    expect(await handleOrg(["share"], home)).toBe(2);
    expect(await handleOrg(["learnings", "研发组", "team-bot", "bogus"], home)).toBe(2);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_cli_memory_org", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { org } = await seedOrg(home);
    expect(await handleMemoryGate(["remember", "周五下午四点发版", "--quote", "周五下午四点发版", "--org", org.id], home)).toBe(0);
    expect(await handleMemoryGate(["entries", "--org", org.id], home)).toBe(0);
    const entries = listMemoryGateEntries(home, { scope: "org", orgId: org.id });
    expect(entries).toHaveLength(1);
    expect(await handleMemoryGate(["entry", entries[0].id], home)).toBe(0);
    // --org 和 --scope user 一起用是用法错。
    expect(await handleMemoryGate(["remember", "错", "--quote", "错", "--org", org.id, "--scope", "user"], home)).toBe(2);
    // 不存在的组织写不进去。
    expect(await handleMemoryGate(["remember", "错", "--quote", "错", "--org", "org_不存在"], home)).toBe(1);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_cli_cross_access_and_catalog", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { boss, alice, org } = await seedOrg(home);
    const ws = join(home, "ws");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "notes.txt"), "内部笔记");
    expect(await handleOrg(["workspace", "研发组", ws, "--yes"], home)).toBe(0);
    expect(await handleOrg(["file-read", "研发组", "notes.txt"], home)).toBe(0);
    expect(await handleOrg(["cross-access", "研发组", "grant", "", alice.email], home)).toBe(0);
    expect(await handleOrg(["cross-access", "研发组", "list"], home)).toBe(0);
    const file = join(home, "tool_only_test.yaml");
    writeFileSync(file, TOOL_ONLY_TEMPLATE);
    expect(await handleOrg(["catalog", "研发组", "publish", file, "--yes"], home)).toBe(0);
    expect(await handleOrg(["catalog", "研发组", "list"], home)).toBe(0);
    expect(await handleOrg(["catalog", "研发组", "install", "tool_only_test", "--yes"], home)).toBe(0);
    expect(await handleOrg(["catalog", "研发组", "remove", "tool_only_test", "--yes"], home)).toBe(0);
    // 破坏性操作没 --yes 回 2。
    expect(await handleOrg(["unshare", "研发组", "team-bot"], home)).toBe(2);
  } finally { cleanup(home); }
});

test("OrgsGap49bTest.test_violations_list_requires_admin", async () => {
  const home = tmpHome("nyra-org49b-");
  try {
    const { alice, dave, org } = await seedOrg(home);
    await expect(listViolations(home, org.id, dave.id)).rejects.toThrow(OrgSharingError);
    // viewer 也看不了违反记录（只认 admin 或机主）。
    await expect(listViolations(home, org.id, alice.id)).rejects.toThrow(OrgSharingError);
    expect(await listViolations(home, org.id, ORG_OWNER_IDENTITY)).toHaveLength(0);
  } finally { cleanup(home); }
});
