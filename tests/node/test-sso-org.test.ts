// tests/node/test-sso-org.test.ts — O3：组织强制 SSO 与邮箱域名路由。
// 全部用临时 home、本地文件账号目录与 stub fetch，不连真实 IdP、不花真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, loginWithGithub, requestMagicLink, type Account } from "../../src/accounts.ts";
import {
  GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL, GITHUB_USER_EMAILS_URL, GITHUB_USER_URL,
} from "../../src/accounts.ts";
import {
  ORG_AUDIT_FILE,
  OrgError,
  addMember,
  createOrg,
  emailDomain,
  findOrgForEmailDomain,
  loadOrgBook,
  normalizeSsoDomain,
  setOrgSso,
} from "../../src/orgs.ts";
import { addSsoProvider, handleSso, routeSsoForEmail } from "../../src/sso.ts";
import { handleOrg } from "../../src/orgCli.ts";
import { RunStore } from "../../src/runs.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function seedAccount(home: string, email: string): Promise<Account> {
  return new AccountStore(home).create({ email });
}

function readOrgAudit(home: string): Record<string, unknown>[] {
  const path = join(home, ORG_AUDIT_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** GitHub 设备流 stub：邮箱固定为 octo@example.com。 */
function githubFetch() {
  return async (url: string) => {
    if (url === GITHUB_DEVICE_CODE_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
    }
    if (url === GITHUB_ACCESS_TOKEN_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "gh-token-1", token_type: "bearer", scope: "read:user" }) };
    }
    if (url === GITHUB_USER_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 12345, login: "octocat", email: null, name: "Octo Cat" }) };
    }
    if (url === GITHUB_USER_EMAILS_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ email: "octo@example.com", primary: true, verified: true, visibility: "private" }]) };
    }
    throw new Error("stub fetch 未覆盖的 URL：" + url);
  };
}

// ---- 域名归一 ----

test("SsoOrgTest.test_email_domain", () => {
  expect(emailDomain("me@Example.COM")).toBe("example.com");
  expect(emailDomain("no-at-sign")).toBe(null);
  expect(emailDomain("a@")).toBe(null);
  expect(emailDomain("a@localhost")).toBe(null);
  expect(normalizeSsoDomain("Example.COM ")).toBe("example.com");
  expect(normalizeSsoDomain("not a domain")).toBe(null);
});

// ---- 组织 SSO 设置 ----

test("SsoOrgTest.test_set_org_sso_roundtrip", async () => {
  const home = tmpHome("nyra-sso-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const plain = await seedAccount(home, "plain@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, plain.email, "member", { by: boss.id });
    // 普通成员改不了 SSO 设置。
    await expect(setOrgSso(home, org.id, { require_sso: true, by: plain.id })).rejects.toThrow(OrgError);
    // 管理员可以：开强制 + 绑提供方 + 绑域名，大小写归一、去重。
    const updated = await setOrgSso(home, org.id, {
      require_sso: true, sso_provider: "corp", sso_domains: ["Example.COM", "example.com", "example.cn"], by: boss.id,
    });
    expect(updated.require_sso).toBe(true);
    expect(updated.sso_provider).toBe("corp");
    expect(updated.sso_domains).toEqual(["example.com", "example.cn"]);
    // 落盘再读回来还在。
    const reloaded = loadOrgBook(home).orgs.find((o) => o.id === org.id)!;
    expect(reloaded.require_sso).toBe(true);
    expect(reloaded.sso_domains).toEqual(["example.com", "example.cn"]);
    // 审计与运行事件都有 org_sso_changed。
    expect(readOrgAudit(home).some((e) => e.action === "org_sso_changed" && e.org_id === org.id)).toBe(true);
    const store = new RunStore(join(home, "runs"));
    const events = store.list().flatMap((s) => store.readEvents(s.run_id)) as Record<string, unknown>[];
    expect(events.some((e) => e.type === "org_sso_changed")).toBe(true);
    // 坏域名拒绝；关掉。
    await expect(setOrgSso(home, org.id, { sso_domains: ["not a domain"], by: boss.id })).rejects.toThrow(/邮箱域名不合法/);
    const off = await setOrgSso(home, org.id, { require_sso: false, by: boss.id });
    expect(off.require_sso).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 域名路由 ----

test("SsoOrgTest.test_route_sso_for_email", async () => {
  const home = tmpHome("nyra-sso-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    expect(routeSsoForEmail(home, "me@example.com")).toBe(null);
    await setOrgSso(home, org.id, { sso_domains: ["example.com"], by: boss.id });
    // 绑了域名、没绑提供方：路由到组织，provider 为 null。
    const routed = routeSsoForEmail(home, "me@EXAMPLE.com");
    expect(routed?.org.id).toBe(org.id);
    expect(routed?.provider).toBe(null);
    // 注册提供方并绑定：路由到提供方。
    addSsoProvider(home, { id: "corp", issuer: "https://login.example.com", client_id: "cid-1" });
    await setOrgSso(home, org.id, { sso_provider: "corp", by: boss.id });
    const routed2 = routeSsoForEmail(home, "me@example.com");
    expect(routed2?.provider?.id).toBe("corp");
    expect(routed2?.provider?.issuer).toBe("https://login.example.com");
    // 域名没命中：null；组织名查找不受影响。
    expect(routeSsoForEmail(home, "me@other.com")).toBe(null);
    expect(findOrgForEmailDomain(home, "me@example.com")?.id).toBe(org.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 非 SSO 登录拦截 ----

test("SsoOrgTest.test_non_sso_login_blocked_by_org", async () => {
  const home = tmpHome("nyra-sso-org-");
  try {
    const boss = await seedAccount(home, "boss@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await setOrgSso(home, org.id, { require_sso: true, sso_provider: "corp", sso_domains: ["example.com"], by: boss.id });
    // GitHub 登录（邮箱 octo@example.com 命中域名）被拦。
    await expect(loginWithGithub({ home, clientId: "gh-client-id", fetchFn: githubFetch(), sleepFn: async () => {} }))
      .rejects.toThrow(/要求 SSO 登录/);
    // magic link 请求在发信前就被拦：发信器一次没调。
    let sent = 0;
    const sender = { send: async () => { sent += 1; } };
    await expect(requestMagicLink({ home, email: "me@example.com", sender, gatewayUrl: "http://127.0.0.1:8765" }))
      .rejects.toThrow(/要求 SSO 登录/);
    expect(sent).toBe(0);
    // 关掉强制：同一条 GitHub 登录通过。
    await setOrgSso(home, org.id, { require_sso: false, by: boss.id });
    const { account } = await loginWithGithub({ home, clientId: "gh-client-id", fetchFn: githubFetch(), sleepFn: async () => {} });
    expect(account.email).toBe("octo@example.com");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("SsoOrgTest.test_member_blocked_even_without_domain", async () => {
  const home = tmpHome("nyra-sso-org-");
  try {
    const boss = await seedAccount(home, "boss@corp.com");
    // 成员邮箱与 GitHub stub 回来的邮箱一致：登录时会链到同一个账号。
    const member = await seedAccount(home, "octo@example.com");
    const org = createOrg(home, "研发组", { by: boss.id });
    await addMember(home, org.id, member.email, "member", { by: boss.id });
    // 组织没绑域名、只开了强制：成员走 GitHub 登录仍被拦（成员身份查到）。
    await setOrgSso(home, org.id, { require_sso: true, sso_provider: "corp", by: boss.id });
    await expect(loginWithGithub({ home, clientId: "gh-client-id", fetchFn: githubFetch(), sleepFn: async () => {} }))
      .rejects.toThrow(/要求 SSO 登录/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- CLI ----

test("SsoOrgTest.test_cli_org_sso_and_route", async () => {
  const home = tmpHome("nyra-sso-org-");
  try {
    expect(await handleOrg(["create", "研发组"], home)).toBe(0);
    expect(await handleOrg(["sso", "研发组", "on", "--provider", "corp", "--domains", "example.com"], home)).toBe(0);
    const org = loadOrgBook(home).orgs[0]!;
    expect(org.require_sso).toBe(true);
    expect(org.sso_provider).toBe("corp");
    expect(org.sso_domains).toEqual(["example.com"]);
    expect(await handleOrg(["show", "研发组"], home)).toBe(0);
    expect(await handleSso(["route", "me@example.com"], home)).toBe(0);
    expect(await handleSso(["route", "me@other.com"], home)).toBe(0);
    expect(await handleSso(["route", "not-an-email"], home)).toBe(2);
    expect(await handleOrg(["sso", "研发组", "off"], home)).toBe(0);
    expect(loadOrgBook(home).orgs[0]!.require_sso).toBe(false);
    expect(await handleOrg(["sso", "研发组", "maybe"], home)).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
