// tests/node/test-connector-slack.test.ts — 缺口 44 第二批：Slack 深连接器（读 + 发消息须批 + 审批卡）。
// 全部用假 API / 假 vault，不连真实 workspace、不碰真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONNECTOR_AUDIT_FILE,
  ConnectorAuthStore,
  getDeclaration,
  markConnectorAuthorized,
  markConnectorRevoked,
  peekConnectorState,
  reauthHint,
} from "../../src/connectors/registry.ts";
import {
  SLACK_MAX_PAGE_LIMIT,
  SLACK_READ_SCOPES,
  SLACK_VAULT_CREDENTIALS_ENTRY,
  SLACK_WRITE_COMMANDS,
  SLACK_WRITE_SCOPES,
  SlackApiClient,
  SlackAuthError,
  SlackError,
  buildApprovalCard,
  createSlackClient,
  formatApprovalCardText,
  formatSlackChannels,
  formatSlackMessages,
  getSlackStatus,
  hasSlackCredentialsEntry,
  handleApprovalCallback,
  isSlackBotToken,
  isSlackChannelId,
  loadSlackCredentials,
  parseApprovalCallback,
  refuseSlackWrite,
  slackWriteRefusal,
} from "../../src/connectors/slack.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { Vault } from "../../src/vault.ts";
import { handleConnector, handleSlack } from "../../src/cli.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const FAKE_TOKEN = "xoxb-fake-token-123456";
const TEAM = "hollow-scale";
const CHANNEL_ID = "C0123456789";

function initVault(home: string, password: string): Vault {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  return vault;
}

function seedSlackVault(home: string, password: string, token = FAKE_TOKEN, team = TEAM): void {
  const vault = initVault(home, password);
  vault.add(SLACK_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ token, team }), true);
}

function enableSlack(home: string): void {
  saveConfig(home, { connectors: { slack: { enabled: true } } });
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

async function withVaultPasswordAsync<T>(password: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NYRA_VAULT_PASSWORD;
  try {
    process.env.NYRA_VAULT_PASSWORD = password;
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prev;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CHANNELS_BODY = {
  ok: true,
  channels: [
    { id: "C0123456789", name: "general", is_private: false, num_members: 12 },
    { id: "C0987654321", name: "ops-private", is_private: true, num_members: 3 },
  ],
  response_metadata: { next_cursor: "dGVhbTpDMDk4" },
};

const HISTORY_BODY = {
  ok: true,
  messages: [
    { ts: "1730000000.000100", user: "U111", text: "hello-secret-text", thread_ts: "1730000000.000050" },
    { ts: "1730000000.000200", user: "U222", text: "第二条" },
  ],
  response_metadata: { next_cursor: "" },
};

function readAuditFile(home: string): string {
  return readFileSync(join(home, CONNECTOR_AUDIT_FILE), "utf-8");
}

function seedPendingApproval(home: string, id: string, overrides?: Record<string, unknown>): void {
  const approval = {
    id,
    sessionKey: "slack:C0123456789",
    chatId: "C0123456789",
    threadId: null,
    tool: "write_file",
    summary: "写文件 /tmp/demo.txt（测试用审批）",
    argsHash: "a1b2c3d4e5f6",
    requestedBy: "U111",
    requestedByRole: "member",
    promptMessageId: null,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    status: "pending",
    ...(overrides ?? {}),
  };
  writeFileSync(join(home, "bot-approvals.json"), JSON.stringify({ version: 1, approvals: { [id]: approval } }));
}

test("SlackTest.test_declaration", () => {
  const slack = getDeclaration("slack");
  expect(slack?.status).toBe("available");
  expect(slack?.scopes.read).toContain("channels:read");
  expect(slack?.scopes.read).toContain("channels:history");
  expect(slack?.scopes.write).toContain("chat:write");
  expect(slack?.toolGroups.map((g) => g.name)).toContain("审批卡");
  expect(slack?.toolGroups.find((g) => g.name === "审批卡")?.access).toBe("write");
  expect(slack?.alwaysRequireApproval).toContain("发消息");
  expect(slack?.alwaysRequireApproval).toContain("发审批卡");
  expect(slack?.alwaysForbidden).toContain("删消息");
  expect(slack?.alwaysForbidden).toContain("管理成员");
  expect(slack?.dataAccessed.length).toBeGreaterThan(0);
  expect(reauthHint("slack")).toBe("nyra slack auth");
});

test("SlackTest.test_token_validation", () => {
  expect(isSlackBotToken("xoxb-123456")).toBe(true);
  expect(isSlackBotToken("shpat_abc")).toBe(false);
  expect(isSlackBotToken("xoxp-123")).toBe(false);
  expect(isSlackBotToken("")).toBe(false);
  expect(isSlackChannelId("C0123456789")).toBe(true);
  expect(isSlackChannelId("c0123")).toBe(false);
  expect(isSlackChannelId("C0123/../x")).toBe(false);
  expect(isSlackChannelId("")).toBe(false);
});

test("SlackTest.test_load_credentials", () => {
  const home = tmpHome("nyra-slack-creds-");
  expect(loadSlackCredentials(home)).toBeNull();
  seedSlackVault(home, "pw123456");
  withVaultPassword("pw123456", () => {
    const creds = loadSlackCredentials(home);
    expect(creds?.token).toBe(FAKE_TOKEN);
    expect(creds?.team).toBe(TEAM);
  });
  // 损坏的 token（不是 xoxb- 开头）当作没凭证。
  const home2 = tmpHome("nyra-slack-creds2-");
  seedSlackVault(home2, "pw123456", "not-a-slack-token");
  withVaultPassword("pw123456", () => {
    expect(loadSlackCredentials(home2)).toBeNull();
  });
});

test("SlackTest.test_create_client_gate", () => {
  const home = tmpHome("nyra-slack-gate-");
  // 未启用 → 直接拒绝。
  expect(() => createSlackClient(home, loadConfig(home))).toThrow("未启用");
  enableSlack(home);
  // 启用了但没凭证 → 未授权。
  expect(() => createSlackClient(home, loadConfig(home))).toThrow(SlackAuthError);
  // 有凭证 → 沿用已有授权迁移为已授权，不打断用户。
  seedSlackVault(home, "pw123456");
  withVaultPassword("pw123456", () => {
    const client = createSlackClient(home, loadConfig(home));
    expect(client.team()).toBe(TEAM);
    const record = new ConnectorAuthStore(home).get("slack", "local");
    expect(record?.state).toBe("authorized");
    expect(record?.migratedFrom).toBe("existing-credentials");
  });
  // 已撤销 → 直接拒绝。
  markConnectorRevoked(home, "slack", "local");
  withVaultPassword("pw123456", () => {
    expect(() => createSlackClient(home, loadConfig(home))).toThrow("已被撤销");
  });
});

test("SlackTest.test_list_channels_and_pagination", async () => {
  const home = tmpHome("nyra-slack-list-");
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const stubFetch: FetchFn = async (url, init) => {
    seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    expect(url).toContain("conversations.list");
    expect(url).not.toContain(FAKE_TOKEN);
    return jsonResponse(CHANNELS_BODY);
  };
  const client = await withVaultPasswordAsync("pw123456", async () => {
    const c = createSlackClient(home, loadConfig(home), { fetchFn: stubFetch });
    return c;
  });
  const { channels, nextCursor } = await client.listChannels();
  expect(channels).toHaveLength(2);
  expect(channels[0]?.name).toBe("general");
  expect(channels[1]?.isPrivate).toBe(true);
  expect(nextCursor).toBe("dGVhbTpDMDk4");
  expect(formatSlackChannels(channels, nextCursor)).toContain("#general");
  // limit 超过上限 → 夹到 250（POST 的 JSON body 里）。
  await client.listChannels({ limit: 300 });
  expect(seen[seen.length - 1]?.body.limit).toBe(250);
  // cursor 原样带过去。
  await client.listChannels({ cursor: "abc123" });
  expect(seen[seen.length - 1]?.body.cursor).toBe("abc123");
  expect(SLACK_MAX_PAGE_LIMIT).toBe(250);
});

test("SlackTest.test_get_history", async () => {
  const home = tmpHome("nyra-slack-hist-");
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  const stubFetch: FetchFn = async (url, init) => {
    expect(url).toContain("conversations.history");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body.channel).toBe(CHANNEL_ID);
    return jsonResponse(HISTORY_BODY);
  };
  const client = await withVaultPasswordAsync("pw123456", async () => {
    return createSlackClient(home, loadConfig(home), { fetchFn: stubFetch });
  });
  const { messages } = await client.getHistory(CHANNEL_ID);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.text).toBe("hello-secret-text");
  expect(messages[0]?.threadTs).toBe("1730000000.000050");
  expect(formatSlackMessages(messages)).toContain("hello-secret-text");
  // 频道 id 不合法 → 不调 API，直接拒绝。
  await expect(client.getHistory("bad/../id")).rejects.toThrow("频道 id 不合法");
});

test("SlackTest.test_invalid_auth_marks_expired", async () => {
  const home = tmpHome("nyra-slack-exp-");
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  markConnectorAuthorized(home, "slack", "local", { tokenFingerprint: "deadbeefcafe" });
  const stubFetch: FetchFn = async () => jsonResponse({ ok: false, error: "invalid_auth" });
  const client = await withVaultPasswordAsync("pw123456", async () => {
    return createSlackClient(home, loadConfig(home), { fetchFn: stubFetch });
  });
  await expect(client.listChannels()).rejects.toThrow(SlackAuthError);
  expect(new ConnectorAuthStore(home).get("slack", "local")?.state).toBe("expired");
  // 标过期后，建客户端直接报“请重新授权”，不再拿死 token 反复试。
  await withVaultPasswordAsync("pw123456", async () => {
    expect(() => createSlackClient(home, loadConfig(home), { fetchFn: stubFetch })).toThrow("已过期");
  });
});

test("SlackTest.test_ratelimited_and_unknown_error", async () => {
  const home = tmpHome("nyra-slack-rate-");
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  const limited: FetchFn = async () => jsonResponse({ ok: false, error: "ratelimited" });
  const other: FetchFn = async () => jsonResponse({ ok: false, error: "channel_not_found" });
  const http500: FetchFn = async () => new Response("boom", { status: 500 });
  await withVaultPasswordAsync("pw123456", async () => {
    await expect(createSlackClient(home, loadConfig(home), { fetchFn: limited }).listChannels()).rejects.toThrow("限流");
    await expect(createSlackClient(home, loadConfig(home), { fetchFn: other }).getHistory(CHANNEL_ID)).rejects.toThrow("channel_not_found");
    await expect(createSlackClient(home, loadConfig(home), { fetchFn: http500 }).listChannels()).rejects.toThrow("HTTP 500");
  });
});

test("SlackTest.test_post_message_and_audit_metadata_only", async () => {
  const home = tmpHome("nyra-slack-post-");
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  const seen: { url: string; init?: RequestInit }[] = [];
  const stubFetch: FetchFn = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse({ ok: true, ts: "1730000000.000300", channel: CHANNEL_ID });
  };
  const client = await withVaultPasswordAsync("pw123456", async () => {
    return createSlackClient(home, loadConfig(home), { fetchFn: stubFetch });
  });
  const { ts } = await client.postMessage(CHANNEL_ID, "hello-secret-text");
  expect(ts).toBe("1730000000.000300");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toContain("chat.postMessage");
  const auth = (seen[0]?.init?.headers as Record<string, string>).Authorization;
  expect(auth).toBe(`Bearer ${FAKE_TOKEN}`);
  const body = JSON.parse(String(seen[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  expect(body.channel).toBe(CHANNEL_ID);
  expect(body.text).toBe("hello-secret-text");
  // 审计只记元数据：没有 token、没有消息内容。
  const audit = readAuditFile(home);
  expect(audit).toContain("post_message");
  expect(audit).toContain("explicit-approval");
  expect(audit).not.toContain(FAKE_TOKEN);
  expect(audit).not.toContain("hello-secret-text");
  // 空内容拒绝。
  await expect(client.postMessage(CHANNEL_ID, "   ")).rejects.toThrow("不能为空");
});

test("SlackTest.test_write_refusal", () => {
  for (const op of ["删消息", "改频道", "管理成员", "删 workspace 数据"]) {
    expect(() => refuseSlackWrite(op)).toThrow(SlackError);
    expect(slackWriteRefusal(op)).toContain(op);
    expect(slackWriteRefusal(op)).toContain("拒绝");
  }
  for (const cmd of SLACK_WRITE_COMMANDS) {
    expect(typeof cmd).toBe("string");
  }
  expect([...SLACK_WRITE_COMMANDS]).toContain("delete-message");
  expect([...SLACK_READ_SCOPES]).toContain("channels:read");
  expect([...SLACK_WRITE_SCOPES]).toContain("chat:write");
});

test("SlackTest.test_approval_card_build_and_parse", () => {
  const approval = {
    id: "a1b2c3d4",
    tool: "write_file",
    summary: "写文件 /tmp/demo.txt（测试用审批）",
    argsHash: "a1b2c3d4e5f6",
    requestedBy: "U111",
    expiresAt: Date.now() + 60_000,
  };
  const { text, blocks } = buildApprovalCard(approval);
  expect(text).toContain("write_file");
  expect(text).toContain("a1b2c3d4e5f6");
  expect(formatApprovalCardText(approval)).toContain("U111");
  const actions = (blocks[1] as { elements: { value: string; text: { text: string } }[] }).elements;
  expect(actions).toHaveLength(2);
  expect(actions[0]?.value).toBe("slack:approve:a1b2c3d4");
  expect(actions[1]?.value).toBe("slack:reject:a1b2c3d4");
  expect(actions[0]?.text.text).toBe("批准");
  expect(actions[1]?.text.text).toBe("拒绝");
  // 卡里没有 token。
  expect(JSON.stringify(blocks)).not.toContain("xoxb-");
  // 已过期的卡文案写明已过期。
  expect(formatApprovalCardText({ ...approval, expiresAt: Date.now() - 1000 })).toContain("已过期");
  // 回调解析：对象与 JSON 字符串都认。
  expect(parseApprovalCallback({ type: "block_actions", actions: [{ value: "slack:approve:a1b2c3d4" }] })).toEqual({ decision: "approved", approvalId: "a1b2c3d4" });
  expect(parseApprovalCallback(JSON.stringify({ type: "block_actions", actions: [{ value: "slack:reject:a1b2c3d4" }] }))).toEqual({ decision: "rejected", approvalId: "a1b2c3d4" });
  expect(parseApprovalCallback({ type: "block_actions", actions: [{ value: "bot:approve:a1b2c3d4" }] })).toBeNull();
  expect(parseApprovalCallback({ type: "view_submission", actions: [] })).toBeNull();
  expect(parseApprovalCallback("{不是 json")).toBeNull();
  expect(parseApprovalCallback({ type: "block_actions", actions: [{ value: "slack:approve:" }] })).toBeNull();
  expect(parseApprovalCallback(null)).toBeNull();
});

test("SlackTest.test_approval_callback_audit_only", () => {
  const home = tmpHome("nyra-slack-cb-");
  const parsed = handleApprovalCallback(home, { type: "block_actions", actions: [{ value: "slack:reject:a1b2c3d4" }] });
  expect(parsed).toEqual({ decision: "rejected", approvalId: "a1b2c3d4" });
  const audit = readAuditFile(home);
  expect(audit).toContain("approval_callback");
  expect(audit).toContain("rejected:a1b2c3d4");
  // 不是审批回调：返回 null、什么都不记。
  expect(handleApprovalCallback(home, { type: "view_submission" })).toBeNull();
  expect(readAuditFile(home).split("\n").filter(Boolean)).toHaveLength(1);
  // 回调不回写审批桥：bot-approvals.json 仍不存在（本批只记审计）。
  expect(existsSync(join(home, "bot-approvals.json"))).toBe(false);
});

test("SlackTest.test_cli_slack_read_paths", async () => {
  const home = tmpHome("nyra-slack-cli-");
  expect(await handleSlack(["status"], home)).toBe(0);
  expect(await handleSlack(["--help"], home)).toBe(0);
  expect(await handleSlack(["bogus"], home)).toBe(2);
  expect(await handleSlack(["history"], home)).toBe(2);
  expect(await handleSlack(["send"], home)).toBe(2);
  expect(await handleSlack(["card"], home)).toBe(2);
  // 写词直接拒绝，不进 API。
  expect(await handleSlack(["delete-message"], home)).toBe(1);
  expect(await handleSlack(["update-channel"], home)).toBe(1);
  // 读路径：假 API 走通。
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  const stubFetch: FetchFn = async (url) => {
    if (url.includes("conversations.list")) return jsonResponse(CHANNELS_BODY);
    if (url.includes("conversations.history")) return jsonResponse(HISTORY_BODY);
    return jsonResponse({ ok: false, error: "unknown_method" });
  };
  let calls = 0;
  const countingFetch: FetchFn = async () => {
    calls += 1;
    return jsonResponse({ ok: true, ts: "1.0", channel: CHANNEL_ID });
  };
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleSlack(["channels"], home, { fetchFn: stubFetch })).toBe(0);
    expect(await handleSlack(["history", "--channel", CHANNEL_ID], home, { fetchFn: stubFetch })).toBe(0);
    expect(await handleSlack(["history", "--channel", "bad/../id"], home, { fetchFn: stubFetch })).toBe(1);
    // 发消息：没批准（答 n）→ 拒绝，且没调 API。
    expect(await handleSlack(["send", "--channel", CHANNEL_ID, "--text", "hi"], home, { secrets: ["n"], fetchFn: countingFetch })).toBe(1);
    expect(calls).toBe(0);
    // --yes → 发出。
    expect(await handleSlack(["send", "--channel", CHANNEL_ID, "--text", "hi", "--yes"], home, { fetchFn: countingFetch })).toBe(0);
    expect(calls).toBe(1);
    // 交互确认答 y → 发出。
    expect(await handleSlack(["send", "--channel", CHANNEL_ID, "--text", "hi"], home, { secrets: ["y"], fetchFn: countingFetch })).toBe(0);
    expect(calls).toBe(2);
  });
});

test("SlackTest.test_cli_slack_auth", async () => {
  const home = tmpHome("nyra-slack-auth-");
  // 密码箱不存在 → 1（连主密码都不问）。
  const noVault = await handleSlack(["auth"], home, { secrets: ["pw123456", "", "not-a-token"] });
  expect(noVault).toBe(1);
  expect(existsSync(join(home, "vault.json"))).toBe(false);
  initVault(home, "pw123456");
  // token 不合法 → 1，不存。
  const bad = await handleSlack(["auth"], home, { secrets: ["pw123456", "", "not-a-token"] });
  expect(bad).toBe(1);
  expect(hasSlackCredentialsEntry(home)).toBe(false);
  // 探 token 返回 invalid_auth → 1，不存。
  const invalidFetch: FetchFn = async () => jsonResponse({ ok: false, error: "invalid_auth" });
  const invalid = await handleSlack(["auth"], home, { secrets: ["pw123456", TEAM, FAKE_TOKEN], fetchFn: invalidFetch });
  expect(invalid).toBe(1);
  expect(hasSlackCredentialsEntry(home)).toBe(false);
  // 探通 → 0，凭证进密码箱、连接器启用、状态机记已授权。
  const okFetch: FetchFn = async (url) => {
    expect(url).toContain("auth.test");
    return jsonResponse({ ok: true, team: TEAM, user: "nyra-bot" });
  };
  const code = await handleSlack(["auth"], home, { secrets: ["pw123456", TEAM, FAKE_TOKEN], fetchFn: okFetch });
  expect(code).toBe(0);
  withVaultPassword("pw123456", () => {
    const credentials = loadSlackCredentials(home);
    expect(credentials?.token).toBe(FAKE_TOKEN);
    expect(credentials?.team).toBe(TEAM);
  });
  expect(loadConfig(home).connectors).toMatchObject({ slack: { enabled: true } });
  expect(new ConnectorAuthStore(home).get("slack", "local")?.state).toBe("authorized");
  // 网络不通只警告，token 先存下。
  const home2 = tmpHome("nyra-slack-auth2-");
  initVault(home2, "pw123456");
  const downFetch: FetchFn = async () => {
    throw new Error("network down");
  };
  const code2 = await handleSlack(["auth"], home2, { secrets: ["pw123456", "", FAKE_TOKEN], fetchFn: downFetch });
  expect(code2).toBe(0);
  withVaultPassword("pw123456", () => {
    expect(loadSlackCredentials(home2)?.token).toBe(FAKE_TOKEN);
  });
});

test("SlackTest.test_cli_slack_card", async () => {
  const home = tmpHome("nyra-slack-card-");
  seedSlackVault(home, "pw123456");
  enableSlack(home);
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const stubFetch: FetchFn = async (url, init) => {
    posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return jsonResponse({ ok: true, ts: "1730000000.000400", channel: CHANNEL_ID });
  };
  // 账本没有 → 1。
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleSlack(["card", "--channel", CHANNEL_ID, "--approval", "a1b2c3d4"], home, { fetchFn: stubFetch })).toBe(1);
  });
  // 挂起的审批 → 0，卡发出去了（两个按钮都在，value 只带 id 与结论）。
  seedPendingApproval(home, "a1b2c3d4");
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleSlack(["card", "--channel", CHANNEL_ID, "--approval", "a1b2c3d4"], home, { fetchFn: stubFetch })).toBe(0);
  });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.url).toContain("chat.postMessage");
  const blocks = posted[0]?.body.blocks as { elements: { value: string }[] }[];
  expect(blocks[1]?.elements.map((e) => e.value)).toEqual(["slack:approve:a1b2c3d4", "slack:reject:a1b2c3d4"]);
  expect(JSON.stringify(posted[0]?.body)).not.toContain(FAKE_TOKEN);
  // 找不到的审批 → 1。
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleSlack(["card", "--channel", CHANNEL_ID, "--approval", "nope1234"], home, { fetchFn: stubFetch })).toBe(1);
  });
  // 已过期的审批 → 1，不发卡。
  seedPendingApproval(home, "deadbeef", { expiresAt: Date.now() - 1000 });
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleSlack(["card", "--channel", CHANNEL_ID, "--approval", "deadbeef"], home, { fetchFn: stubFetch })).toBe(1);
  });
  // 已处理的审批 → 1，不发卡。
  seedPendingApproval(home, "decided1", { status: "approved" });
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleSlack(["card", "--channel", CHANNEL_ID, "--approval", "decided1"], home, { fetchFn: stubFetch })).toBe(1);
  });
  expect(posted).toHaveLength(1);
});

test("SlackTest.test_cli_connector_slack_via_handle", async () => {
  const home = tmpHome("nyra-slack-conn-");
  // 没凭证时批准被拒（先跑 nyra slack auth）。
  expect(await handleConnector(["approve", "slack"], home)).toBe(1);
  // 有凭证时批准成功（有凭证就算“已授权”的候选：正式记录靠首次调用迁移记一笔，与 Gmail 同款语义）。
  seedSlackVault(home, "pw123456");
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleConnector(["approve", "slack"], home)).toBe(0);
  });
  expect(peekConnectorState(home, "slack", "local", { hasTokens: true })).toBe("authorized");
  // 撤销：状态立即失效、凭证删了、连接器关了。
  await withVaultPasswordAsync("pw123456", async () => {
    expect(await handleConnector(["revoke", "slack", "--yes"], home)).toBe(0);
  });
  expect(new ConnectorAuthStore(home).get("slack", "local")?.state).toBe("revoked");
  withVaultPassword("pw123456", () => {
    expect(loadSlackCredentials(home)).toBeNull();
  });
  expect(loadConfig(home).connectors).toMatchObject({ slack: { enabled: false } });
});

test("SlackTest.test_cli_slack_subprocess", () => {
  const home = tmpHome("nyra-slack-cli2-");
  const run = (args: string[]) => spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" },
    encoding: "utf-8",
    timeout: 60000,
  });
  const status = run(["slack", "status"]);
  expect(status.status).toBe(0);
  expect(status.stdout ?? "").toContain("Slack");
  expect(status.stdout ?? "").toContain("未启用");
  const list = run(["connector", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout ?? "").toContain("Slack");
  expect(list.stdout ?? "").toContain("未授权");
  const help = run(["slack", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout ?? "").toContain("nyra slack send");
});
