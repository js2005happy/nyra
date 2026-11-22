// tests/node/test-accounts.test.ts — 用户账号登录（缺口 41 第一批）：
// 账号账本、会话、magic link、审计、Google OAuth、GitHub 设备流、CLI。
// 全部 mock-only：OAuth 端点用 stub fetch，不碰真 Google/GitHub；
// 回环回调服务器是真的（127.0.0.1），用 fetch 直接回调它。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountError, AccountStore, AccountSessionStore, MagicLinkStore,
  normalizeEmail, appendAccountAudit, readCurrentSession, writeCurrentSession,
  clearCurrentSession, getCurrentAccount, upsertAccount,
  buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleUserinfo, loginWithGoogle,
  requestGithubDeviceCode, pollGithubAccessToken, fetchGithubUser, loginWithGithub,
  requestMagicLink, loginWithMagicLink, buildMagicLinkUrl, gmailMailSender,
  GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL,
  GITHUB_DEVICE_CODE_URL, GITHUB_ACCESS_TOKEN_URL, GITHUB_USER_URL, GITHUB_USER_EMAILS_URL,
  ACCOUNT_SESSION_TTL_SECONDS,
} from "../../src/accounts.ts";
import {
  buildAuthUrl, codeChallengeS256, newCodeVerifier, postForm,
  startLoopbackCallbackServer,
} from "../../src/oauth.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[], input?: string) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    input,
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

/** stub fetch：按 URL 精确匹配返回 JSON；没命中的 URL 直接报错（不静默放过）。 */
function stubFetch(routes: Record<string, unknown>) {
  return async (url: string, _init?: Record<string, unknown>) => {
    const data = routes[url];
    if (data === undefined) throw new Error("stub fetch 未覆盖的 URL：" + url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data),
    };
  };
}

// ---- 邮箱归一 ----

test("AccountsTest.test_normalize_email", () => {
  expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  expect(normalizeEmail("no-at-sign")).toBe(null);
  expect(normalizeEmail("a@b")).toBe(null);
  expect(normalizeEmail("@example.com")).toBe(null);
  expect(normalizeEmail(123)).toBe(null);
});

// ---- 账号账本 ----

test("AccountsTest.test_account_store_owner_first", async () => {
  const home = tmpHome("nyra-acct-home-");
  const store = new AccountStore(home);
  expect(await store.listAccounts()).toEqual([]);
  const first = await store.create({ email: "Owner@Example.com", name: "机主" });
  expect(first.role).toBe("owner");
  expect(first.email).toBe("owner@example.com");
  const second = await store.create({ email: "user2@example.com" });
  expect(second.role).toBe("user");
  expect(second.name).toBe("user2");
  await expect(store.create({ email: "OWNER@example.com" })).rejects.toThrow("已有账号");
  expect(await store.findByEmail("owner@example.com")).not.toBeNull();
  expect(await store.findByEmail("nobody@example.com")).toBeNull();
});

test("AccountsTest.test_account_store_link_identity", async () => {
  const home = tmpHome("nyra-acct-home-");
  const store = new AccountStore(home);
  const a = await store.create({ email: "a@example.com" });
  const b = await store.create({ email: "b@example.com" });
  const linked = await store.linkIdentity(a.id, { provider: "google", sub: "g-1", email: "a@example.com", name: "A" });
  expect(linked.providers.length).toBe(1);
  expect(linked.providers[0].sub).toBe("g-1");
  // 同一个 provider + sub 绑到另一个账号 → 拒绝。
  await expect(store.linkIdentity(b.id, { provider: "google", sub: "g-1", email: "b@example.com" })).rejects.toThrow("另一个账号");
  // 同一个账号绑另一个 Google 身份 → 拒绝。
  await expect(store.linkIdentity(a.id, { provider: "google", sub: "g-2", email: "a@example.com" })).rejects.toThrow("另一个 google 身份");
  // 同一个身份再链一次 → 幂等，不重复。
  const again = await store.linkIdentity(a.id, { provider: "google", sub: "g-1", email: "a@example.com" });
  expect(again.providers.length).toBe(1);
});

test("AccountsTest.test_account_store_corrupt_file_backs_up_and_throws", async () => {
  const home = tmpHome("nyra-acct-home-");
  writeFileSync(join(home, "accounts.json"), "{ not json", "utf-8");
  const store = new AccountStore(home);
  await expect(store.listAccounts()).rejects.toThrow("账号文件损坏");
  // 备份文件留下了，原文没丢。
  const files = readdirSync(home);
  expect(files.some((f: string) => f.startsWith("accounts.json.corrupt-"))).toBe(true);
});

test("AccountsTest.test_upsert_account_links_by_email", async () => {
  const home = tmpHome("nyra-acct-home-");
  const first = await upsertAccount(home, "google", { sub: "g-1", email: "same@example.com", name: "Same" });
  expect(first.role).toBe("owner");
  const second = await upsertAccount(home, "github", { sub: "gh-9", email: "SAME@example.com", name: "Same" });
  expect(second.id).toBe(first.id);
  expect(second.providers.map((p) => p.provider).sort()).toEqual(["github", "google"]);
  // 同一个 Google sub 再来 → 还是同一个账号。
  const third = await upsertAccount(home, "google", { sub: "g-1", email: "same@example.com" });
  expect(third.id).toBe(first.id);
  expect(third.providers.length).toBe(2);
});

// ---- 会话 ----

test("AccountsTest.test_account_sessions_issue_verify_revoke", async () => {
  const home = tmpHome("nyra-acct-home-");
  const store = new AccountSessionStore(home);
  const issued = await store.issue("acct-1");
  expect(issued.token.length).toBeGreaterThan(30);
  const verified = await store.verify(issued.token);
  expect(verified).toEqual({ account_id: "acct-1", session_id: issued.id });
  expect(await store.verify("wrong-token")).toBeNull();
  const listed = await store.listSessions("acct-1");
  expect(listed.length).toBe(1);
  expect("token_sha256" in listed[0]).toBe(false);
  expect(await store.revoke(issued.id)).toBe(true);
  expect(await store.revoke(issued.id)).toBe(false);
  expect(await store.verify(issued.token)).toBeNull();
});

test("AccountsTest.test_account_sessions_expiry_and_inactivity", async () => {
  const home = tmpHome("nyra-acct-home-");
  let now = 1_700_000_000;
  const clock = () => now;
  const store = new AccountSessionStore(home, { clock });
  const short = await store.issue("acct-1", 60);
  expect(await store.verify(short.token)).not.toBeNull();
  now += 61;
  expect(await store.verify(short.token)).toBeNull();
  // 长期不用（31 天）即使没到过期时间也失效。
  const long = await store.issue("acct-1", ACCOUNT_SESSION_TTL_SECONDS);
  now += 31 * 24 * 3600;
  expect(await store.verify(long.token)).toBeNull();
  // revokeAll 计数。
  const s2 = new AccountSessionStore(home, { clock: () => 1_700_000_000 });
  await s2.issue("acct-1");
  await s2.issue("acct-1");
  await s2.issue("acct-2");
  expect(await s2.revokeAllForAccount("acct-1")).toBe(2);
  expect(await s2.listSessions("acct-1")).toEqual([]);
  expect((await s2.listSessions("acct-2")).length).toBe(1);
});

test("AccountsTest.test_current_session_helpers", async () => {
  const home = tmpHome("nyra-acct-home-");
  expect(readCurrentSession(home)).toBeNull();
  expect(await getCurrentAccount(home)).toBeNull();
  const store = new AccountStore(home);
  const account = await store.create({ email: "me@example.com" });
  const sessions = new AccountSessionStore(home);
  const issued = await sessions.issue(account.id);
  writeCurrentSession(home, { token: issued.token, account_id: account.id, issued_at: new Date().toISOString() });
  const current = await getCurrentAccount(home);
  expect(current?.email).toBe("me@example.com");
  clearCurrentSession(home);
  expect(readCurrentSession(home)).toBeNull();
  expect(await getCurrentAccount(home)).toBeNull();
  expect(existsSync(join(home, "account-session.json"))).toBe(false);
});

test("AccountsTest.test_account_audit_writes_no_email_no_token", () => {
  const home = tmpHome("nyra-acct-home-");
  appendAccountAudit(home, { action: "login", provider: "google", account_id: "abc123" });
  const text = readFileSync(join(home, "accounts-audit.jsonl"), "utf-8");
  expect(text).toContain('"action":"login"');
  expect(text).toContain('"provider":"google"');
  expect(text).toContain('"account_id":"abc123"');
  expect(text).not.toContain("example.com");
});

// ---- magic link ----

test("AccountsTest.test_magic_link_issue_redeem_once", async () => {
  const home = tmpHome("nyra-acct-home-");
  const store = new MagicLinkStore(home);
  const issued = await store.issue("user@example.com");
  expect(await store.redeem(issued.token)).toBe("user@example.com");
  // 第二次重放必失败。
  expect(await store.redeem(issued.token)).toBeNull();
  expect(await store.redeem("wrong-token")).toBeNull();
  await expect(store.issue("not-an-email")).rejects.toThrow("邮箱格式无效");
});

test("AccountsTest.test_magic_link_expiry", async () => {
  const home = tmpHome("nyra-acct-home-");
  let now = 1_700_000_000;
  const store = new MagicLinkStore(home, { clock: () => now });
  const issued = await store.issue("user@example.com", 60);
  now += 61;
  expect(await store.redeem(issued.token)).toBeNull();
});

test("AccountsTest.test_magic_link_url_and_sender", async () => {
  expect(buildMagicLinkUrl("https://example.com/", "tok123")).toBe("https://example.com/api/account/magic-link?token=tok123");
  expect(() => buildMagicLinkUrl("ftp://example.com", "tok123")).toThrow("http:// 或 https://");
  const sent: { to: string; subject: string; body: string }[] = [];
  const sender = gmailMailSender(async (opts) => {
    sent.push({ to: opts.to, subject: opts.subject, body: opts.body });
  });
  const home = tmpHome("nyra-acct-home-");
  const issued = await requestMagicLink({ home, email: "user@example.com", sender, gatewayUrl: "http://127.0.0.1:8765" });
  expect(issued.id.length).toBeGreaterThan(0);
  expect(sent.length).toBe(1);
  expect(sent[0].to).toBe("user@example.com");
  expect(sent[0].body).toContain("/api/account/magic-link?token=");
  // 令牌原文只进邮件，不返回给调用方。
  expect("token" in issued).toBe(false);
  // 用邮件里的 token 兑换 → 建账号（邮箱方式的 sub 就是邮箱本身）。
  const token = sent[0].body.split("token=")[1].split("\n")[0].trim();
  const { account } = await loginWithMagicLink({ home, token: decodeURIComponent(token) });
  expect(account.email).toBe("user@example.com");
  expect(account.providers[0].provider).toBe("email");
  expect(account.providers[0].sub).toBe("user@example.com");
});

// ---- OAuth 通用助手 ----

test("AccountsTest.test_oauth_pkce_known_vector", async () => {
  // RFC 7636 附录 B 的已知向量：verifier → S256 challenge。
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  expect(codeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  expect(newCodeVerifier().length).toBeGreaterThanOrEqual(43);
  const url = buildGoogleAuthUrl({ clientId: "cid123", redirectUri: "http://127.0.0.1:9/callback", state: "s1", codeChallenge: "ch1" });
  expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
  expect(url).toContain("client_id=cid123");
  expect(url).toContain("code_challenge_method=S256");
  expect(url).toContain("scope=openid+email+profile");
  expect(() => buildAuthUrl("http://example.com/auth", {})).toThrow("https://");
  await expect(postForm("http://example.com/token", {}, stubFetch({}))).rejects.toThrow("https://");
});

test("AccountsTest.test_oauth_post_form_error_detail", async () => {
  const failing = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error_description: "bad code" }),
  });
  await expect(postForm("https://example.com/token", { a: "b" }, failing)).rejects.toThrow("bad code");
  const nonJson = async () => ({ ok: true, status: 200, text: async () => "not json" });
  const data = await postForm("https://example.com/token", {}, nonJson);
  expect(data).toBeNull();
});

test("AccountsTest.test_oauth_post_form_sends_accept_json", async () => {
  // 回归：GitHub 设备码端点不带 Accept: application/json 时回表单格式，
  // postForm 解析不到 JSON，登录报“无法识别的内容”。postForm 必须带上该头。
  let seenHeaders: Record<string, string> | undefined;
  const capturing = async (_url: string, init?: Record<string, unknown>) => {
    seenHeaders = init?.headers as Record<string, string> | undefined;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  const data = await postForm("https://example.com/token", { a: "b" }, capturing);
  expect((data as Record<string, unknown>).ok).toBe(true);
  expect(seenHeaders?.Accept).toBe("application/json");
  expect(seenHeaders?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
});

test("AccountsTest.test_github_device_code_json_response", async () => {
  // GitHub 带 Accept: application/json 时回 JSON 设备码（真实端点已核实）。
  const fetchFn = stubFetch({
    [GITHUB_DEVICE_CODE_URL]: {
      device_code: "dc-1",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
      expires_in: 900,
      interval: 5,
    },
  });
  const code = await requestGithubDeviceCode({ clientId: "cid", fetchFn });
  expect(code.device_code).toBe("dc-1");
  expect(code.user_code).toBe("ABCD-1234");
  expect(code.verification_uri).toBe("https://github.com/login/device");
  expect(code.expires_in).toBe(900);
  expect(code.interval).toBe(5);
});

test("AccountsTest.test_oauth_loopback_server_real", async () => {
  const server = await startLoopbackCallbackServer({ state: "state-1", timeoutMs: 5000 });
  expect(server.redirectUri).toContain("http://127.0.0.1:");
  const pending = server.waitForCode();
  // state 对不上 → 400，code 不兑现。
  const bad = await fetch(server.redirectUri + "?code=abc&state=nope");
  expect(bad.status).toBe(400);
  const good = await fetch(server.redirectUri + "?code=code-9&state=state-1");
  expect(good.status).toBe(200);
  expect(await pending).toBe("code-9");
  server.close();
});

test("AccountsTest.test_oauth_loopback_server_error_param", async () => {
  const server = await startLoopbackCallbackServer({ state: "state-2", timeoutMs: 5000 });
  // 先挂一个空 catch：promise 在 fetch 回来前就拒绝，没人接会算未处理拒绝。
  const pending = server.waitForCode();
  pending.catch(() => {});
  try {
    await fetch(server.redirectUri + "?error=access_denied&state=state-2");
    await expect(pending).rejects.toThrow("access_denied");
  } finally {
    server.close();
  }
});

// ---- Google OAuth ----

test("AccountsTest.test_google_exchange_and_userinfo", async () => {
  const fetchFn = stubFetch({
    [GOOGLE_TOKEN_URL]: { access_token: "at-1", expires_in: 3600 },
    [GOOGLE_USERINFO_URL]: { sub: "g-1", email: "user@example.com", email_verified: true, name: "User" },
  });
  const tokens = await exchangeGoogleCode({
    client: { client_id: "cid", client_secret: "sec" },
    code: "code-1",
    redirectUri: "http://127.0.0.1:9/callback",
    codeVerifier: "verifier-1",
    fetchFn,
  });
  expect(tokens.access_token).toBe("at-1");
  const info = await fetchGoogleUserinfo({ accessToken: "at-1", fetchFn });
  expect(info).toEqual({ sub: "g-1", email: "user@example.com", name: "User" });
  await expect(exchangeGoogleCode({
    client: { client_id: "cid" },
    code: "code-1",
    redirectUri: "http://127.0.0.1:9/callback",
    codeVerifier: "v",
    fetchFn,
  })).rejects.toThrow("client_secret");
  const unverified = stubFetch({
    [GOOGLE_USERINFO_URL]: { sub: "g-2", email: "x@example.com", email_verified: false },
  });
  await expect(fetchGoogleUserinfo({ accessToken: "at-1", fetchFn: unverified })).rejects.toThrow("尚未验证");
  const noEmail = stubFetch({
    [GOOGLE_USERINFO_URL]: { sub: "g-3", email_verified: true },
  });
  await expect(fetchGoogleUserinfo({ accessToken: "at-1", fetchFn: noEmail })).rejects.toThrow("有效邮箱");
});

test("AccountsTest.test_google_login_end_to_end", async () => {
  const home = tmpHome("nyra-acct-home-");
  const fetchFn = stubFetch({
    [GOOGLE_TOKEN_URL]: { access_token: "at-1", expires_in: 3600 },
    [GOOGLE_USERINFO_URL]: { sub: "google-sub-1", email: "user@example.com", email_verified: true, name: "User" },
  });
  // openUrl 桩：解析授权链接里的回环地址与 state，直接回调它（真服务器、真换码流程）。
  const openUrl = async (authUrl: string) => {
    const parsed = new URL(authUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri") as string;
    const state = parsed.searchParams.get("state") as string;
    const res = await fetch(redirectUri + "?code=fake-auth-code&state=" + state);
    expect(res.status).toBe(200);
  };
  const { account, session } = await loginWithGoogle({ home, client: { client_id: "cid", client_secret: "sec" }, fetchFn, openUrl });
  expect(account.email).toBe("user@example.com");
  expect(account.role).toBe("owner");
  expect(account.providers[0]).toMatchObject({ provider: "google", sub: "google-sub-1" });
  expect(session.token.length).toBeGreaterThan(30);
  // 会话 token 能验过，本机当前会话也落盘了。
  const sessions = new AccountSessionStore(home);
  expect(await sessions.verify(session.token)).toEqual({ account_id: account.id, session_id: session.id });
  expect(readCurrentSession(home)?.account_id).toBe(account.id);
  // 审计行里有 login，无邮箱、无 token。
  const audit = readFileSync(join(home, "accounts-audit.jsonl"), "utf-8");
  expect(audit).toContain('"action":"login"');
  expect(audit).not.toContain("user@example.com");
  expect(audit).not.toContain(session.token);
});

// ---- GitHub 设备流 ----

test("AccountsTest.test_github_device_flow_end_to_end", async () => {
  const home = tmpHome("nyra-acct-home-");
  let polls = 0;
  const fetchFn = async (url: string, _init?: Record<string, unknown>) => {
    if (url === GITHUB_DEVICE_CODE_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
    }
    if (url === GITHUB_ACCESS_TOKEN_URL) {
      polls += 1;
      if (polls < 3) return { ok: true, status: 200, text: async () => JSON.stringify({ error: "authorization_pending" }) };
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
  const codes: { user_code: string; verification_uri: string }[] = [];
  const { account } = await loginWithGithub({
    home,
    clientId: "gh-client-id",
    fetchFn,
    sleepFn: async () => {},
    onUserCode: (code) => {
      codes.push({ user_code: code.user_code, verification_uri: code.verification_uri });
    },
  });
  expect(codes).toEqual([{ user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" }]);
  expect(polls).toBe(3);
  expect(account.email).toBe("octo@example.com");
  expect(account.providers[0]).toMatchObject({ provider: "github", sub: "12345" });
  // 同一个 GitHub 身份再登录 → 同一个账号，不重复建。
  const again = await loginWithGithub({
    home,
    clientId: "gh-client-id",
    fetchFn: async (url: string) => {
      if (url === GITHUB_DEVICE_CODE_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ device_code: "dc-2", user_code: "WXYZ-9999", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
      if (url === GITHUB_ACCESS_TOKEN_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "gh-token-2" }) };
      if (url === GITHUB_USER_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 12345, login: "octocat", email: "octo@example.com" }) };
      throw new Error("stub fetch 未覆盖的 URL：" + url);
    },
    sleepFn: async () => {},
    onUserCode: () => {},
  });
  expect(again.account.id).toBe(account.id);
});

test("AccountsTest.test_github_device_flow_denied_and_timeout", async () => {
  const denied = stubFetch({
    [GITHUB_DEVICE_CODE_URL]: { device_code: "dc-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
    [GITHUB_ACCESS_TOKEN_URL]: { error: "access_denied" },
  });
  await expect(pollGithubAccessToken({
    clientId: "cid",
    deviceCode: "dc-1",
    intervalSeconds: 5,
    expiresInSeconds: 900,
    fetchFn: denied,
    sleepFn: async () => {},
  })).rejects.toThrow("被拒绝");
  let now = 1_700_000_000;
  const pending = stubFetch({
    [GITHUB_ACCESS_TOKEN_URL]: { error: "authorization_pending" },
  });
  // sleep 推进时钟，轮询到 deadline 就报过期（时钟不走会死循环）。
  await expect(pollGithubAccessToken({
    clientId: "cid",
    deviceCode: "dc-1",
    intervalSeconds: 5,
    expiresInSeconds: 10,
    fetchFn: pending,
    sleepFn: async (ms: number) => {
      now += ms / 1000;
    },
    clock: () => now,
  })).rejects.toThrow("过期");
  // 注意：deadline = 调用时时钟 + expiresInSeconds，第三次调用若 sleep 不推进
  // 时钟会死循环——超时路径上面一次调用已经覆盖，不再加“已过期才调用”的情形。
});

test("AccountsTest.test_github_user_no_verified_email", async () => {
  const fetchFn = stubFetch({
    [GITHUB_USER_URL]: { id: 777, login: "nobody", email: null },
    [GITHUB_USER_EMAILS_URL]: [{ email: "x@example.com", primary: true, verified: false }],
  });
  await expect(fetchGithubUser({ accessToken: "t", fetchFn })).rejects.toThrow("已验证");
  const bad = stubFetch({
    [GITHUB_DEVICE_CODE_URL]: { device_code: "dc-1" },
  });
  await expect(requestGithubDeviceCode({ clientId: "cid", fetchFn: bad })).rejects.toThrow("user_code");
});

// ---- CLI ----

test("AccountsTest.test_cli_status_list_logout_no_account", () => {
  const home = tmpHome("nyra-acct-home-");
  const status = runCli(home, ["account", "status"]);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("未登录");
  const list = runCli(home, ["account", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("还没有账号");
  const logout = runCli(home, ["account", "logout"]);
  expect(logout.status).toBe(0);
  expect(logout.stdout).toContain("没有登录的账号");
  const help = runCli(home, ["account", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("nyra account login google");
  const badLogin = runCli(home, ["account", "login", "email"]);
  expect(badLogin.status).toBe(2);
  expect(badLogin.stderr).toContain("login email");
  const badCmd = runCli(home, ["account", "nonsense"]);
  expect(badCmd.status).toBe(2);
});

test("AccountsTest.test_cli_status_list_revoke_with_account", async () => {
  const home = tmpHome("nyra-acct-home-");
  const account = await upsertAccount(home, "github", { sub: "gh-1", email: "cli@example.com", name: "CLI" });
  const sessions = new AccountSessionStore(home);
  const issued = await sessions.issue(account.id);
  writeCurrentSession(home, { token: issued.token, account_id: account.id, issued_at: new Date().toISOString() });
  const status = runCli(home, ["account", "status"]);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("cli@example.com");
  expect(status.stdout).toContain("机主");
  expect(status.stdout).toContain("github");
  const list = runCli(home, ["account", "list"]);
  expect(list.stdout).toContain("cli@example.com");
  const revokeMissing = runCli(home, ["account", "revoke", "no-such-id"]);
  expect(revokeMissing.status).toBe(1);
  expect(revokeMissing.stderr).toContain("会话不存在");
  const revoke = runCli(home, ["account", "revoke", issued.id]);
  expect(revoke.status).toBe(0);
  expect(revoke.stdout).toContain("已撤销会话");
  const after = runCli(home, ["account", "status"]);
  expect(after.stdout).toContain("未登录");
});
