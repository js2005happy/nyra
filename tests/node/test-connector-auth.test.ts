// tests/node/test-connector-auth.test.ts — 缺口 44 第 0 批：连接器授权状态机 + 权限声明格式。
// 全部用假数据 / 本地夹具 / stub fetch，不连真实应用、不碰真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONNECTOR_AUTH_FILE,
  CONNECTOR_AUDIT_FILE,
  ConnectorAuthStore,
  effectivePermissions,
  ensureConnectorUsable,
  getDeclaration,
  listDeclarations,
  markConnectorAuthorized,
  markConnectorExpired,
  markConnectorRevoked,
  peekConnectorState,
  recordConnectorEvent,
  resolveConnectorUserId,
  tokenFingerprint,
  type ConnectorAuthState,
} from "../../src/connectors/registry.ts";
import {
  GmailApiTransport,
  GmailAuthError,
  createGmailTransport,
  getGmailStatus,
  GMAIL_SCOPES,
  GMAIL_VAULT_TOKENS_ENTRY,
  GMAIL_VAULT_CLIENT_ENTRY,
  type GmailTokens,
} from "../../src/connectors/gmail.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { Vault } from "../../src/vault.ts";
import { handleConnector } from "../../src/cli.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const FAKE_REFRESH = "refresh-token-SECRET-abc123";
const CLIENT = { client_id: "cid-123.apps.googleusercontent.com", client_secret: "sec-456" };

function seedVault(home: string, password: string, tokens: GmailTokens): void {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify(tokens), true);
  vault.add(GMAIL_VAULT_CLIENT_ENTRY, JSON.stringify(CLIENT), true);
}

function fakeTokens(overrides: Partial<GmailTokens> = {}): GmailTokens {
  return {
    access_token: "access-fake",
    refresh_token: FAKE_REFRESH,
    expires_at: Date.now() + 3_600_000,
    scope: GMAIL_SCOPES.join(" "),
    email: "user@example.com",
    ...overrides,
  };
}

function withVaultPassword(password: string, fn: () => void): void {
  const prev = process.env.NYRA_VAULT_PASSWORD;
  try {
    process.env.NYRA_VAULT_PASSWORD = password;
    fn();
  } finally {
    if (prev === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prev;
  }
}

function readStateFile(home: string): string {
  return readFileSync(join(home, CONNECTOR_AUTH_FILE), "utf-8");
}

function readAuditFile(home: string): string {
  return readFileSync(join(home, CONNECTOR_AUDIT_FILE), "utf-8");
}

test("ConnectorAuthTest.test_declarations", () => {
  const gmail = getDeclaration("gmail");
  expect(gmail?.status).toBe("available");
  expect(gmail?.scopes.read).toContain("https://www.googleapis.com/auth/gmail.readonly");
  expect(gmail?.scopes.write).toContain("https://www.googleapis.com/auth/gmail.send");
  expect(gmail?.toolGroups.map((g) => g.name)).toContain("发邮件");
  expect(gmail?.alwaysRequireApproval).toContain("gmail_send");
  expect(gmail?.alwaysForbidden.length).toBeGreaterThan(0);
  expect(gmail?.dataAccessed.length).toBeGreaterThan(0);

  // 试点连接器在目录里看得见、用不了；Shopify 在缺口 44 第一批改为已接入（只读），Slack 在缺口 44 第二批改为已接入（读 + 发消息须批 + 审批卡）。
  expect(getDeclaration("shopify")?.status).toBe("available");
  expect(getDeclaration("slack")?.status).toBe("available");
  expect(listDeclarations().map((d) => d.id).sort()).toEqual(["gmail", "shopify", "slack"]);

  // 声明缺失的连接器默认只读、每次使用重新确认（fail-closed）。
  expect(getDeclaration("does-not-exist")).toBeUndefined();
  const fallback = effectivePermissions("does-not-exist");
  expect(fallback.readOnly).toBe(true);
  expect(fallback.requireConfirmEveryUse).toBe(true);
  expect(effectivePermissions("gmail").readOnly).toBe(false);
});

test("ConnectorAuthTest.test_first_use_requires_approval", () => {
  const home = tmpHome("nyra-conn-first-");
  // 新家目录、没凭证：首次使用直接拒绝，并给批准入口。
  const r = ensureConnectorUsable(home, "gmail", "local", { hasTokens: false });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.state).toBe("unauthorized");
    expect(r.message).toContain("nyra connector approve gmail");
  }
  // 账本里不该凭空多出记录：拒绝不等于授权。
  expect(new ConnectorAuthStore(home).get("gmail", "local")).toBeNull();
});

test("ConnectorAuthTest.test_approve_then_use_no_repeat_prompt", () => {
  const home = tmpHome("nyra-conn-approve-");
  const rec = markConnectorAuthorized(home, "gmail", "local", { tokenFingerprint: tokenFingerprint(FAKE_REFRESH), scopes: GMAIL_SCOPES.join(" ") });
  expect(rec.state).toBe("authorized");
  expect(rec.tokenFingerprint).toBe(tokenFingerprint(FAKE_REFRESH));
  expect(rec.tokenFingerprint).not.toContain(FAKE_REFRESH);

  const ok = ensureConnectorUsable(home, "gmail", "local", { hasTokens: false });
  expect(ok.ok).toBe(true);

  // 重复批准是幂等的：还是已授权，不报错、不变态。
  markConnectorAuthorized(home, "gmail", "local", { tokenFingerprint: tokenFingerprint(FAKE_REFRESH) });
  expect(ensureConnectorUsable(home, "gmail", "local", { hasTokens: false }).ok).toBe(true);
  expect(new ConnectorAuthStore(home).get("gmail", "local")?.state).toBe("authorized");
});

test("ConnectorAuthTest.test_expired_and_reauth_hint", () => {
  const home = tmpHome("nyra-conn-expired-");
  markConnectorAuthorized(home, "gmail", "local");
  const expired = markConnectorExpired(home, "gmail", "local", "refresh token 失效");
  expect(expired?.state).toBe("expired");
  const r = ensureConnectorUsable(home, "gmail", "local", { hasTokens: true });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.state).toBe("expired");
    expect(r.message).toContain("已过期");
    expect(r.message).toContain("nyra gmail auth");
  }
  // 重新授权后恢复可用。
  markConnectorAuthorized(home, "gmail", "local");
  expect(ensureConnectorUsable(home, "gmail", "local", { hasTokens: false }).ok).toBe(true);
});

test("ConnectorAuthTest.test_revoke_immediate_and_reauth", () => {
  const home = tmpHome("nyra-conn-revoke-");
  markConnectorAuthorized(home, "gmail", "local");
  expect(ensureConnectorUsable(home, "gmail", "local", { hasTokens: false }).ok).toBe(true);
  markConnectorRevoked(home, "gmail", "local");
  // 撤销立即失效：下一次检查直接拒绝。
  const r = ensureConnectorUsable(home, "gmail", "local", { hasTokens: true });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.state).toBe("revoked");
    expect(r.message).toContain("已被撤销");
  }
  // 已撤销的不被“过期”覆盖（撤销是终态，过期标记只从已授权转）。
  expect(markConnectorExpired(home, "gmail", "local", "refresh token 失效")).toBeNull();
  expect(new ConnectorAuthStore(home).get("gmail", "local")?.state).toBe("revoked");
  // 重新授权可恢复。
  markConnectorAuthorized(home, "gmail", "local");
  expect(ensureConnectorUsable(home, "gmail", "local", { hasTokens: false }).ok).toBe(true);
});

test("ConnectorAuthTest.test_revoke_without_record_blocks_migration", () => {
  const home = tmpHome("nyra-conn-revoke2-");
  // 没记录时撤销也建一条 revoked 记录，堵住“没记录 + 密码箱有凭证 → 迁移沿用”那条路。
  markConnectorRevoked(home, "gmail", "local");
  const r = ensureConnectorUsable(home, "gmail", "local", { hasTokens: true });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.state).toBe("revoked");
});

test("ConnectorAuthTest.test_migration_from_existing_credentials", () => {
  const home = tmpHome("nyra-conn-migrate-");
  const r = ensureConnectorUsable(home, "gmail", "local", {
    hasTokens: true,
    tokenFingerprint: tokenFingerprint(FAKE_REFRESH),
    scopes: GMAIL_SCOPES.join(" "),
  });
  expect(r.ok).toBe(true);
  const rec = new ConnectorAuthStore(home).get("gmail", "local");
  expect(rec?.state).toBe("authorized");
  expect(rec?.migratedFrom).toBe("existing-credentials");
  expect(rec?.tokenFingerprint).toBe(tokenFingerprint(FAKE_REFRESH));
});

test("ConnectorAuthTest.test_per_user_isolation", () => {
  const home = tmpHome("nyra-conn-user-");
  markConnectorAuthorized(home, "gmail", "user-a");
  markConnectorRevoked(home, "gmail", "user-b");
  expect(ensureConnectorUsable(home, "gmail", "user-a", { hasTokens: false }).ok).toBe(true);
  const rb = ensureConnectorUsable(home, "gmail", "user-b", { hasTokens: true });
  expect(rb.ok).toBe(false);
  if (!rb.ok) expect(rb.state).toBe("revoked");
  // 另一个连接器也不受影响。
  expect(ensureConnectorUsable(home, "slack", "user-a", { hasTokens: false }).ok).toBe(false);
});

test("ConnectorAuthTest.test_token_never_in_state_audit_or_evidence", () => {
  const home = tmpHome("nyra-conn-secret-");
  markConnectorAuthorized(home, "gmail", "local", { tokenFingerprint: tokenFingerprint(FAKE_REFRESH), scopes: GMAIL_SCOPES.join(" ") });
  markConnectorExpired(home, "gmail", "local", "refresh token 失效");
  markConnectorAuthorized(home, "gmail", "local", { tokenFingerprint: tokenFingerprint(FAKE_REFRESH) });
  markConnectorRevoked(home, "gmail", "local");
  recordConnectorEvent(home, null, "connector_revoked", { connector: "gmail", user_id: "local" });

  const state = readStateFile(home);
  const audit = readAuditFile(home);
  expect(state).not.toContain(FAKE_REFRESH);
  expect(audit).not.toContain(FAKE_REFRESH);
  // 指纹在，原文不在。
  expect(state).toContain(tokenFingerprint(FAKE_REFRESH));
  expect(audit).toContain("revoked");

  // 证据回落文件里也没有原文。
  const evidenceDir = join(home, "evidence", "connector");
  if (existsSync(evidenceDir)) {
    for (const f of readdirSync(evidenceDir)) {
      expect(readFileSync(join(evidenceDir, f), "utf-8")).not.toContain(FAKE_REFRESH);
    }
  }
});

test("ConnectorAuthTest.test_record_event_fallback_to_evidence", () => {
  const home = tmpHome("nyra-conn-event-");
  // 没有运行目录时走 evidence/connector/ 回落，不静默丢审计。
  const channel = recordConnectorEvent(home, null, "connector_authorized", {
    connector: "gmail",
    user_id: "local",
    scopes_hash: "abcdef123456",
  });
  expect(channel).toBe("evidence");
  const evidenceDir = join(home, "evidence", "connector");
  expect(existsSync(evidenceDir)).toBe(true);
  const files = readdirSync(evidenceDir);
  expect(files.length).toBeGreaterThan(0);
  const body = files.map((f) => readFileSync(join(evidenceDir, f), "utf-8")).join("\n");
  expect(body).toContain("connector_authorized");
  expect(body).toContain("gmail");
});

test("ConnectorAuthTest.test_resolve_user_id", () => {
  const home = tmpHome("nyra-conn-uid-");
  // 没登录时记 local。
  expect(resolveConnectorUserId(home)).toBe("local");
  // 有本机当前会话时用 account_id。
  writeFileSync(join(home, "account-session.json"), JSON.stringify({ token: "x", account_id: "acc-123", issued_at: "2026-11-20T00:00:00Z" }), "utf-8");
  expect(resolveConnectorUserId(home)).toBe("acc-123");
  // 会话文件损坏时回落 local，不抛错。
  writeFileSync(join(home, "account-session.json"), "{not json", "utf-8");
  expect(resolveConnectorUserId(home)).toBe("local");
});

test("ConnectorAuthTest.test_peek_does_not_write", () => {
  const home = tmpHome("nyra-conn-peek-");
  expect(peekConnectorState(home, "gmail", "local", { hasTokens: false })).toBe("unauthorized");
  expect(peekConnectorState(home, "gmail", "local", { hasTokens: true })).toBe("authorized");
  // 只读看一眼：不写账本。
  expect(existsSync(join(home, CONNECTOR_AUTH_FILE))).toBe(false);
  markConnectorAuthorized(home, "gmail", "local");
  expect(peekConnectorState(home, "gmail", "local", { hasTokens: false })).toBe("authorized");
});

test("ConnectorAuthTest.test_gmail_status_reports_auth_state", () => {
  const home = tmpHome("nyra-conn-gstatus-");
  const fresh = getGmailStatus(home, { connectors: { gmail: { enabled: true } } });
  expect(fresh.authState).toBe("unauthorized");
  expect(fresh.configured).toBe(false);

  seedVault(home, "pw-12345", fakeTokens());
  // 密码箱未解锁时条目名看得到：status 能报“已授权”候选。
  const locked = getGmailStatus(home, { connectors: { gmail: { enabled: true } } });
  expect(locked.configured).toBe(true);
  expect(locked.authState).toBe("authorized");

  // 撤销后 status 跟着变。
  markConnectorRevoked(home, "gmail", "local");
  expect(getGmailStatus(home, { connectors: { gmail: { enabled: true } } }).authState).toBe("revoked");
});

test("ConnectorAuthTest.test_create_transport_gate_with_state_machine", () => {
  const home = tmpHome("nyra-conn-gate-");
  seedVault(home, "pw-12345", fakeTokens());
  saveConfig(home, { connectors: { gmail: { enabled: true } } });
  withVaultPassword("pw-12345", () => {
    // 首次调用：密码箱已有凭证，沿用已有授权迁移，不打断。
    const t = createGmailTransport(home, loadConfig(home));
    expect(t).toBeTruthy();
    expect(new ConnectorAuthStore(home).get("gmail", "local")?.migratedFrom).toBe("existing-credentials");

    // 撤销后：建传输层直接报未授权（GmailAuthError），不再放行。
    markConnectorRevoked(home, "gmail", "local");
    let revokedError: unknown;
    try { createGmailTransport(home, loadConfig(home)); } catch (err) { revokedError = err; }
    expect(revokedError).toBeInstanceOf(GmailAuthError);
    expect((revokedError as Error).message).toMatch(/已被撤销/);

    // 过期后：同样拦住，并给重新授权入口。
    markConnectorAuthorized(home, "gmail", "local");
    markConnectorExpired(home, "gmail", "local", "refresh token 失效");
    let expiredError: unknown;
    try { createGmailTransport(home, loadConfig(home)); } catch (err) { expiredError = err; }
    expect(expiredError).toBeInstanceOf(GmailAuthError);
    expect((expiredError as Error).message).toMatch(/已过期/);

    // 重新批准后恢复。
    markConnectorAuthorized(home, "gmail", "local");
    expect(createGmailTransport(home, loadConfig(home))).toBeTruthy();
  });
});

test("ConnectorAuthTest.test_refresh_failure_marks_expired", async () => {
  const home = tmpHome("nyra-conn-refresh-");
  seedVault(home, "pw-12345", fakeTokens({ expires_at: Date.now() - 1000 }));
  saveConfig(home, { connectors: { gmail: { enabled: true } } });
  // token 端点 stub：refresh 直接报 invalid_grant。
  const stubFetch = async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 });
  };
  let transport: GmailApiTransport | null = null;
  withVaultPassword("pw-12345", () => {
    transport = createGmailTransport(home, loadConfig(home), { fetchFn: stubFetch as never }) as GmailApiTransport;
  });
  // access token 已过期，第一次 search 触发 refresh，失败即报授权错误。
  await expect(transport!.search("test")).rejects.toThrow(GmailAuthError);
  // 状态已被标过期：下一次建传输层直接拒绝，不再拿死掉的 refresh token 反复试。
  withVaultPassword("pw-12345", () => {
    expect(new ConnectorAuthStore(home).get("gmail", "local")?.state).toBe("expired");
    expect(() => createGmailTransport(home, loadConfig(home))).toThrow(/已过期/);
  });
});

test("ConnectorAuthTest.test_cli_connector_via_handle", async () => {
  const home = tmpHome("nyra-conn-cli-");
  expect(await handleConnector(["status"], home)).toBe(0);
  expect(await handleConnector(["list"], home)).toBe(0);
  expect(await handleConnector(["bogus"], home)).toBe(2);
  expect(await handleConnector(["approve"], home)).toBe(2);
  expect(await handleConnector(["approve", "nope"], home)).toBe(2);
  expect(await handleConnector(["revoke"], home)).toBe(2);
  // 没凭证的 Slack 拒绝批准（先跑 nyra slack auth）。
  expect(await handleConnector(["approve", "slack"], home)).toBe(1);
  // 没凭证的 Gmail 拒绝批准（先跑 nyra gmail auth）。
  expect(await handleConnector(["approve", "gmail"], home)).toBe(1);
  // 撤销 Slack 连接器：只记状态，不报错。
  expect(await handleConnector(["revoke", "slack", "--yes"], home)).toBe(0);
  expect(new ConnectorAuthStore(home).get("slack", "local")?.state).toBe("revoked");
});

test("ConnectorAuthTest.test_cli_connector_subprocess", () => {
  const home = tmpHome("nyra-conn-cli2-");
  const run = (args: string[]) => spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" },
    encoding: "utf-8",
    timeout: 60000,
  });
  const list = run(["connector", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout ?? "").toContain("Gmail");
  expect(list.stdout ?? "").toContain("Shopify");
  expect(list.stdout ?? "").toContain("Slack");
  expect(list.stdout ?? "").toContain("未授权");
  const status = run(["connector", "status", "gmail"]);
  expect(status.status).toBe(0);
  expect(status.stdout ?? "").toContain("Gmail");
  expect(status.stdout ?? "").toContain("读：");
  expect(status.stdout ?? "").toContain("永远禁做");
  const bad = run(["connector", "bogus-cmd"]);
  expect(bad.status).toBe(2);
});

test("ConnectorAuthTest.test_cli_gmail_auth_records_authorized", async () => {
  // nyra gmail auth 的状态记录走 markConnectorAuthorized：这里只验记录函数
  // 本身（真 auth 要走浏览器回环，见 test-gmail-connector.test.ts 的回环测试）。
  const home = tmpHome("nyra-conn-gauth-");
  const rec = markConnectorAuthorized(home, "gmail", "local", { tokenFingerprint: tokenFingerprint(FAKE_REFRESH), scopes: GMAIL_SCOPES.join(" ") });
  expect(rec.state).toBe("authorized");
  expect(getGmailStatus(home, { connectors: { gmail: { enabled: true } } }).authState).toBe("authorized");
});

test("ConnectorAuthTest.test_state_labels_cover_all_states", () => {
  const states: ConnectorAuthState[] = ["unauthorized", "authorized", "expired", "revoked"];
  for (const s of states) {
    const home = tmpHome(`nyra-conn-label-${s}-`);
    if (s === "authorized") markConnectorAuthorized(home, "gmail", "local");
    if (s === "expired") { markConnectorAuthorized(home, "gmail", "local"); markConnectorExpired(home, "gmail", "local", "x"); }
    if (s === "revoked") markConnectorRevoked(home, "gmail", "local");
    expect(peekConnectorState(home, "gmail", "local", { hasTokens: false })).toBe(s);
  }
});
