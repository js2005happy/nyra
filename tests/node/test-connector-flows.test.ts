// tests/node/test-connector-flows.test.ts — G-P0-6：连接器业务流程做深。
// 三条流程各带验收标准：Slack 审批卡闭环、Shopify 订单履约核查、Gmail 草稿闭环，
// 外加统一运行器（nyra connector flow）。全部用假 API / 假密码箱 / 假审批桥，
// 不连真实 Slack / Shopify / Gmail、不碰真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBridge, approvalArgsHash, type PendingApproval } from "../../src/bot/approvalBridge.ts";
import { botPolicyFromConfig } from "../../src/bot/types.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { Vault } from "../../src/vault.ts";
import { handleConnector, handleGmail, handleShopify, handleSlack } from "../../src/cli.ts";
import { getDeclaration } from "../../src/connectors/registry.ts";
import {
  GMAIL_SCOPES,
  GMAIL_VAULT_CLIENT_ENTRY,
  GMAIL_VAULT_TOKENS_ENTRY,
  formatGmailDrafts,
  type GmailTokens,
} from "../../src/connectors/gmail.ts";
import {
  SHOPIFY_VAULT_CREDENTIALS_ENTRY,
  checkOrderFulfillment,
  createShopifyClient,
  formatFulfillmentCheck,
  parseOrderLineItems,
  type ShopifyApiClient,
} from "../../src/connectors/shopify.ts";
import {
  SLACK_VAULT_CREDENTIALS_ENTRY,
  resolveSlackApprovalCallback,
} from "../../src/connectors/slack.ts";
import {
  formatFlowResult,
  getConnectorFlow,
  listConnectorFlows,
  runConnectorFlow,
} from "../../src/connectors/flows.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => handler(url, init);
}

function initVault(home: string, password: string): Vault {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  vault.unlock(password);
  return vault;
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

// ---- 审批桥（假发送器，owner "1"、admin "2"） ----

function makeBridge(home: string): ApprovalBridge {
  const policy = botPolicyFromConfig({ bot: { owner: "1", admins: ["2"], approval_timeout_ms: 60000 } });
  return new ApprovalBridge({
    home,
    policy,
    send: async () => "1",
    edit: async () => {},
    audit: () => {},
  });
}

async function requestApproval(bridge: ApprovalBridge): Promise<PendingApproval> {
  return bridge.requestApproval({
    sessionKey: "telegram:7",
    chatId: "7",
    threadId: null,
    tool: "write_file",
    summary: "写文件 a.txt",
    argsHash: approvalArgsHash({ tool: "write_file", fileTarget: "a.txt" }),
    requestedBy: "1",
    requestedByRole: "owner",
  });
}

function callbackPayload(approvalId: string, decision: "approve" | "reject"): Record<string, unknown> {
  return { type: "block_actions", actions: [{ value: `slack:${decision}:${approvalId}` }] };
}

function findEvidence(home: string, needle: string): string[] {
  const root = join(home, "evidence");
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (readFileSync(p, "utf-8").includes(needle)) found.push(p);
    }
  };
  walk(root);
  return found;
}

// ---- Slack 审批卡闭环 ----

test("Slack 回调：点批准真的解决审批（resolved，桥里已批准）", async () => {
  const home = tmpHome("nyra-flow-slack-");
  try {
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const res = await resolveSlackApprovalCallback(home, { payload: callbackPayload(pending.id, "approve"), decidedBy: "1", bridge });
    expect(res.status).toBe("resolved");
    expect(res.decision).toBe("approved");
    expect(res.approvalId).toBe(pending.id);
    expect(bridge.pendingCount()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Slack 回调：点拒绝真的解决审批（resolved，桥里已拒绝）", async () => {
  const home = tmpHome("nyra-flow-slack-");
  try {
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const res = await resolveSlackApprovalCallback(home, { payload: callbackPayload(pending.id, "reject"), decidedBy: "2", bridge });
    expect(res.status).toBe("resolved");
    expect(res.decision).toBe("rejected");
    expect(bridge.pendingCount()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Slack 回调：找不到审批 id 报 not-found", async () => {
  const home = tmpHome("nyra-flow-slack-");
  try {
    const bridge = makeBridge(home);
    const res = await resolveSlackApprovalCallback(home, { payload: callbackPayload("no-such-id", "approve"), decidedBy: "1", bridge });
    expect(res.status).toBe("not-found");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Slack 回调：重放已处理过的回调报 not-pending，不重复解决", async () => {
  const home = tmpHome("nyra-flow-slack-");
  try {
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const payload = callbackPayload(pending.id, "approve");
    expect((await resolveSlackApprovalCallback(home, { payload, decidedBy: "1", bridge })).status).toBe("resolved");
    const replay = await resolveSlackApprovalCallback(home, { payload, decidedBy: "1", bridge });
    expect(replay.status).toBe("not-pending");
    expect(bridge.pendingCount()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Slack 回调：不在白名单的决定人报 not-approver，审批仍挂起", async () => {
  const home = tmpHome("nyra-flow-slack-");
  try {
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const res = await resolveSlackApprovalCallback(home, { payload: callbackPayload(pending.id, "approve"), decidedBy: "stranger", bridge });
    expect(res.status).toBe("not-approver");
    expect(bridge.pendingCount()).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Slack 回调：不是审批回调的 payload 报 not-found", async () => {
  const home = tmpHome("nyra-flow-slack-");
  try {
    const bridge = makeBridge(home);
    const res = await resolveSlackApprovalCallback(home, { payload: { type: "block_actions", actions: [{ value: "other:button" }] }, decidedBy: "1", bridge });
    expect(res.status).toBe("not-found");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra slack callback 批准一条挂起审批（exit 0）", async () => {
  const home = tmpHome("nyra-flow-slack-cli-");
  try {
    saveConfig(home, { bot: { owner: "1", admins: ["2"] } });
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const code = await handleSlack(["callback", "--payload", JSON.stringify(callbackPayload(pending.id, "approve")), "--by", "1"], home);
    expect(code).toBe(0);
    expect(makeBridge(home).pendingCount()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra slack callback 非白名单决定人拒绝（exit 1，审批仍挂起）", async () => {
  const home = tmpHome("nyra-flow-slack-cli-");
  try {
    saveConfig(home, { bot: { owner: "1", admins: ["2"] } });
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const code = await handleSlack(["callback", "--payload", JSON.stringify(callbackPayload(pending.id, "approve")), "--by", "stranger"], home);
    expect(code).toBe(1);
    expect(makeBridge(home).pendingCount()).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra slack callback 没给 payload 报用法错（exit 2）", async () => {
  const home = tmpHome("nyra-flow-slack-cli-");
  try {
    expect(await handleSlack(["callback"], home)).toBe(2);
    expect(await handleSlack(["callback", "--payload", "not-json"], home)).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Shopify 订单履约核查 ----

const SHOP = "hollowandscale.myshopify.com";
const SHOPIFY_TOKEN = "shpat_fake_token_for_tests_only";

function seedShopify(home: string): void {
  const vault = initVault(home, "pw-12345");
  vault.add(SHOPIFY_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ shop: SHOP, access_token: SHOPIFY_TOKEN }), true);
  saveConfig(home, { connectors: { shopify: { enabled: true } } });
}

function shopifyOrder(orderId: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: orderId,
    name: `#100${orderId}`,
    total_price: "29.99",
    currency: "USD",
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    cancelled_at: null,
    created_at: "2026-11-20T10:00:00Z",
    line_items: [
      { id: 11, title: "猫抓板", variant_id: 101, inventory_item_id: 1001, quantity: 2 },
      { id: 12, title: "猫薄荷球", variant_id: 102, inventory_item_id: 1002, quantity: 1 },
    ],
    ...over,
  };
}

function shopifyFetch(order: Record<string, unknown>, levels: Record<number, number>, calls: string[]): (url: string, init?: RequestInit) => Promise<Response> {
  return stubFetch((url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.includes("/orders/")) return jsonResponse({ order });
    if (u.pathname.includes("/inventory_levels.json")) {
      const ids = (u.searchParams.get("inventory_item_ids") ?? "").split(",").filter(Boolean).map(Number);
      const out = ids.filter((id) => levels[id] !== undefined).map((id) => ({ inventory_item_id: id, location_id: 1, available: levels[id] }));
      return jsonResponse({ inventory_levels: out });
    }
    return jsonResponse({ error: "unknown path" }, 404);
  });
}

function shopifyClient(home: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response>): ShopifyApiClient {
  return createShopifyClient(home, loadConfig(home), { fetchFn });
}

test("Shopify：parseOrderLineItems 解析行项目（数量与库存项 id 齐全）", () => {
  const items = parseOrderLineItems(shopifyOrder(1));
  expect(items.length).toBe(2);
  expect(items[0]).toEqual({ id: 11, title: "猫抓板", variantId: 101, inventoryItemId: 1001, quantity: 2 });
  expect(items[1].inventoryItemId).toBe(1002);
});

test("Shopify：parseOrderLineItems 丢掉没有 id 的行，缺库存项 id 的行照常保留", () => {
  const items = parseOrderLineItems({
    line_items: [
      { title: "无 id 商品", quantity: 1 },
      { id: 21, title: "定制商品", quantity: 3 },
    ],
  });
  expect(items.length).toBe(1);
  expect(items[0].inventoryItemId).toBeUndefined();
  expect(items[0].quantity).toBe(3);
});

test("Shopify 履约核查：库存都够判 fulfillable", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(shopifyOrder(1), { 1001: 5, 1002: 1 }, calls)), "1"),
    );
    expect(result.verdict).toBe("fulfillable");
    expect(result.items.length).toBe(2);
    expect(result.items.every((i) => i.ok)).toBe(true);
    expect(result.summary).toContain("可以发货");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify 履约核查：库存不够判 short，缺几件写清楚", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(shopifyOrder(1), { 1001: 1, 1002: 1 }, calls)), "1"),
    );
    expect(result.verdict).toBe("short");
    expect(result.items[0].ok).toBe(false);
    expect(result.items[0].note).toContain("缺 1 件");
    expect(result.items[1].ok).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify 履约核查：已取消订单判 cancelled，不查库存", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(shopifyOrder(1, { cancelled_at: "2026-11-21T09:00:00Z" }), { 1001: 5, 1002: 1 }, calls)), "1"),
    );
    expect(result.verdict).toBe("cancelled");
    expect(result.items.length).toBe(0);
    expect(calls.some((u) => u.includes("inventory_levels"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify 履约核查：已发货订单判 already-fulfilled，不查库存", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(shopifyOrder(1, { fulfillment_status: "fulfilled" }), { 1001: 5, 1002: 1 }, calls)), "1"),
    );
    expect(result.verdict).toBe("already-fulfilled");
    expect(calls.some((u) => u.includes("inventory_levels"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify 履约核查：行项目没有库存项 id 记无法核查，判 short（不静默跳过）", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const order = shopifyOrder(1, {
      line_items: [{ id: 21, title: "定制商品", variant_id: 201, quantity: 1 }],
    });
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(order, {}, calls)), "1"),
    );
    expect(result.verdict).toBe("short");
    expect(result.items[0].available).toBeNull();
    expect(result.items[0].note).toContain("没有库存项 id");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify 履约核查：库存接口没返回该项记无法核查，判 short", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(shopifyOrder(1), { 1001: 5 }, calls)), "1"),
    );
    expect(result.verdict).toBe("short");
    expect(result.items[1].available).toBeNull();
    expect(result.items[1].note).toContain("库存接口没返回该项");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify 履约核查：查不到订单抛错（不编结论）", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    await expect(withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, stubFetch(() => jsonResponse({ errors: "Not Found" }, 404))), "999"),
    )).rejects.toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Shopify：formatFulfillmentCheck 逐项一行 + 结论一行", async () => {
  const home = tmpHome("nyra-flow-shopify-");
  try {
    seedShopify(home);
    const calls: string[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      checkOrderFulfillment(shopifyClient(home, shopifyFetch(shopifyOrder(1), { 1001: 5, 1002: 1 }, calls)), "1"),
    );
    const text = formatFulfillmentCheck(result);
    expect(text).toContain("猫抓板");
    expect(text).toContain("结论：可以发货");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra shopify fulfill 库存够 exit 0、缺货 exit 1", async () => {
  const home = tmpHome("nyra-flow-shopify-cli-");
  try {
    seedShopify(home);
    const okCalls: string[] = [];
    const ok = await withVaultPasswordAsync("pw-12345", () =>
      handleShopify(["fulfill", "1"], home, { fetchFn: shopifyFetch(shopifyOrder(1), { 1001: 5, 1002: 1 }, okCalls) }),
    );
    expect(ok).toBe(0);
    const shortCalls: string[] = [];
    const short = await withVaultPasswordAsync("pw-12345", () =>
      handleShopify(["fulfill", "1"], home, { fetchFn: shopifyFetch(shopifyOrder(1), { 1001: 0, 1002: 1 }, shortCalls) }),
    );
    expect(short).toBe(1);
    expect(await handleShopify(["fulfill"], home)).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Gmail 草稿闭环 ----

const GMAIL_CLIENT = { client_id: "cid-123.apps.googleusercontent.com", client_secret: "sec-456" };
const GMAIL_TOKENS: GmailTokens = {
  access_token: "fake-access-token",
  refresh_token: "fake-refresh-token",
  expires_at: Date.now() + 3_600_000,
  scope: GMAIL_SCOPES.join(" "),
  email: "user@example.com",
};

function seedGmail(home: string): void {
  const vault = initVault(home, "pw-12345");
  vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify(GMAIL_TOKENS), true);
  vault.add(GMAIL_VAULT_CLIENT_ENTRY, JSON.stringify(GMAIL_CLIENT), true);
  saveConfig(home, { connectors: { gmail: { enabled: true } } });
}

function gmailDraftMessage(messageId: string, to: string, subject: string): Record<string, unknown> {
  return {
    id: messageId,
    threadId: `thread-${messageId}`,
    snippet: `${subject}的摘要`,
    payload: {
      headers: [
        { name: "From", value: "user@example.com" },
        { name: "To", value: to },
        { name: "Subject", value: subject },
      ],
    },
  };
}

function gmailFetch(drafts: Array<{ id: string; message: Record<string, unknown> }>, sent: { id: string }[]): (url: string, init?: RequestInit) => Promise<Response> {
  return stubFetch((url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/users/me/drafts") && init?.method === "GET") {
      return jsonResponse({ drafts: drafts.map((d) => ({ id: d.id, message: { id: d.message.id as string, threadId: d.message.threadId as string } })) });
    }
    if (u.pathname.endsWith("/users/me/drafts/send") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { id?: string };
      const found = drafts.find((d) => d.id === body.id);
      if (!found) return jsonResponse({ error: "not found" }, 404);
      sent.push({ id: "msg-sent-1" });
      return jsonResponse({ id: "msg-sent-1", threadId: "thread-msg-1" });
    }
    const m = u.pathname.match(/\/users\/me\/drafts\/([^/]+)$/);
    if (m && init?.method === "GET") {
      const found = drafts.find((d) => d.id === m[1]);
      if (!found) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ id: found.id, message: found.message });
    }
    return jsonResponse({ error: "unknown path" }, 404);
  });
}

function gmailDraftsFixture(): Array<{ id: string; message: Record<string, unknown> }> {
  return [
    { id: "draft-1", message: gmailDraftMessage("msg-1", "alice@example.com", "合作邀请") },
    { id: "draft-2", message: gmailDraftMessage("msg-2", "bob@example.com", "订单跟进") },
  ];
}

test("Gmail：listDrafts 列出草稿（id 与邮件 id）", async () => {
  const home = tmpHome("nyra-flow-gmail-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const { createGmailTransport } = await import("../../src/connectors/gmail.ts");
    const drafts = await withVaultPasswordAsync("pw-12345", () => {
      const transport = createGmailTransport(home, loadConfig(home), { fetchFn: gmailFetch(gmailDraftsFixture(), sent) });
      return transport.listDrafts();
    });
    expect(drafts.map((d) => d.id)).toEqual(["draft-1", "draft-2"]);
    expect(drafts[0].messageId).toBe("msg-1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gmail：getDraft 读到收件人与主题", async () => {
  const home = tmpHome("nyra-flow-gmail-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const { createGmailTransport } = await import("../../src/connectors/gmail.ts");
    const draft = await withVaultPasswordAsync("pw-12345", () => {
      const transport = createGmailTransport(home, loadConfig(home), { fetchFn: gmailFetch(gmailDraftsFixture(), sent) });
      return transport.getDraft("draft-1");
    });
    expect(draft.to).toBe("alice@example.com");
    expect(draft.subject).toBe("合作邀请");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gmail：sendDraft 发出草稿返回邮件 id", async () => {
  const home = tmpHome("nyra-flow-gmail-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const { createGmailTransport } = await import("../../src/connectors/gmail.ts");
    const result = await withVaultPasswordAsync("pw-12345", () => {
      const transport = createGmailTransport(home, loadConfig(home), { fetchFn: gmailFetch(gmailDraftsFixture(), sent) });
      return transport.sendDraft("draft-1");
    });
    expect(result.id).toBe("msg-sent-1");
    expect(sent.length).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gmail：formatGmailDrafts 空列表与有列表", () => {
  expect(formatGmailDrafts([])).toBe("没有草稿。");
  expect(formatGmailDrafts([{ id: "draft-1", messageId: "msg-1" }])).toContain("草稿 draft-1");
  expect(formatGmailDrafts([{ id: "draft-1", messageId: "msg-1" }])).toContain("msg-1");
});

test("CLI：nyra gmail drafts 列出草稿", async () => {
  const home = tmpHome("nyra-flow-gmail-cli-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const code = await withVaultPasswordAsync("pw-12345", () =>
      handleGmail(["drafts"], home, { fetchFn: gmailFetch(gmailDraftsFixture(), sent) }),
    );
    expect(code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra gmail send-draft --yes 发出草稿并写证据", async () => {
  const home = tmpHome("nyra-flow-gmail-cli-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const code = await withVaultPasswordAsync("pw-12345", () =>
      handleGmail(["send-draft", "draft-1", "--yes"], home, { fetchFn: gmailFetch(gmailDraftsFixture(), sent) }),
    );
    expect(code).toBe(0);
    expect(sent.length).toBe(1);
    expect(findEvidence(home, "草稿发送").length).toBeGreaterThan(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra gmail send-draft 草稿不完整不发（exit 1）", async () => {
  const home = tmpHome("nyra-flow-gmail-cli-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const incomplete = [{ id: "draft-9", message: gmailDraftMessage("msg-9", "", "") }];
    const code = await withVaultPasswordAsync("pw-12345", () =>
      handleGmail(["send-draft", "draft-9", "--yes"], home, { fetchFn: gmailFetch(incomplete, sent) }),
    );
    expect(code).toBe(1);
    expect(sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra gmail send-draft 没确认不发（答 n，exit 1）", async () => {
  const home = tmpHome("nyra-flow-gmail-cli-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const code = await withVaultPasswordAsync("pw-12345", () =>
      handleGmail(["send-draft", "draft-1"], home, { passwords: ["n"], fetchFn: gmailFetch(gmailDraftsFixture(), sent) }),
    );
    expect(code).toBe(1);
    expect(sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 统一运行器 ----

test("运行器：列出 3 条业务流程，id 与验收齐全", () => {
  const flows = listConnectorFlows();
  expect(flows.map((f) => f.id).sort()).toEqual(["gmail-draft-send", "shopify-order-fulfillment", "slack-approval-roundtrip"]);
  for (const f of flows) {
    expect(f.acceptance.length).toBe(3);
    expect(f.steps.length).toBeGreaterThan(0);
  }
  expect(getConnectorFlow("no-such-flow")).toBeUndefined();
});

test("运行器：slack-approval-roundtrip 通过，三项验收全过并写证据", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    saveConfig(home, { bot: { owner: "1", admins: ["2"] } });
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const result = await runConnectorFlow(home, loadConfig(home), "slack-approval-roundtrip", {
      payload: JSON.stringify(callbackPayload(pending.id, "approve")),
      decidedBy: "1",
    }, { bridge });
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["callback-parsed", "approver-allowed", "approval-resolved"]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(findEvidence(home, "slack-approval-roundtrip").length).toBeGreaterThan(0);
    expect(formatFlowResult(result)).toContain("结论：通过");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("运行器：slack-approval-roundtrip 非白名单决定人不通过", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const result = await runConnectorFlow(home, loadConfig(home), "slack-approval-roundtrip", {
      payload: JSON.stringify(callbackPayload(pending.id, "approve")),
      decidedBy: "stranger",
    }, { bridge });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === "approver-allowed")?.passed).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("运行器：shopify-order-fulfillment 库存够通过、缺货不通过", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    seedShopify(home);
    const okCalls: string[] = [];
    const ok = await withVaultPasswordAsync("pw-12345", () =>
      runConnectorFlow(home, loadConfig(home), "shopify-order-fulfillment", { orderId: "1" }, {
        fetchFn: shopifyFetch(shopifyOrder(1), { 1001: 5, 1002: 1 }, okCalls),
      }),
    );
    expect(ok.passed).toBe(true);
    expect(ok.checks.find((c) => c.name === "items-covered")?.passed).toBe(true);
    const shortCalls: string[] = [];
    const short = await withVaultPasswordAsync("pw-12345", () =>
      runConnectorFlow(home, loadConfig(home), "shopify-order-fulfillment", { orderId: "1" }, {
        fetchFn: shopifyFetch(shopifyOrder(1), { 1001: 0, 1002: 1 }, shortCalls),
      }),
    );
    expect(short.passed).toBe(false);
    expect(short.checks.find((c) => c.name === "items-covered")?.passed).toBe(false);
    expect(formatFlowResult(short)).toContain("结论：不通过");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("运行器：gmail-draft-send 通过，三项验收全过并写发送证据", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      runConnectorFlow(home, loadConfig(home), "gmail-draft-send", { draftId: "draft-1", approved: true }, {
        fetchFn: gmailFetch(gmailDraftsFixture(), sent),
      }),
    );
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["draft-found", "draft-complete", "draft-sent"]);
    expect(sent.length).toBe(1);
    expect(findEvidence(home, "draft-1").length).toBeGreaterThan(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("运行器：gmail-draft-send 没批准不通过（flow-error，不发）", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      runConnectorFlow(home, loadConfig(home), "gmail-draft-send", { draftId: "draft-1" }, {
        fetchFn: gmailFetch(gmailDraftsFixture(), sent),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0].name).toBe("flow-error");
    expect(sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("运行器：gmail-draft-send 找不到草稿不通过", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    seedGmail(home);
    const sent: { id: string }[] = [];
    const result = await withVaultPasswordAsync("pw-12345", () =>
      runConnectorFlow(home, loadConfig(home), "gmail-draft-send", { draftId: "draft-404", approved: true }, {
        fetchFn: gmailFetch(gmailDraftsFixture(), sent),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === "draft-found")?.passed).toBe(false);
    expect(sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("运行器：未知流程 id 抛错", async () => {
  const home = tmpHome("nyra-flow-runner-");
  try {
    await expect(runConnectorFlow(home, loadConfig(home), "no-such-flow", {})).rejects.toThrow(/未知业务流程/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- CLI 统一入口与声明文案 ----

test("CLI：nyra connector flows 列出 3 条流程", async () => {
  const home = tmpHome("nyra-flow-conn-cli-");
  try {
    expect(await handleConnector(["flows"], home)).toBe(0);
    expect(await handleConnector(["flow", "bogus"], home)).toBe(2);
    expect(await handleConnector(["flow"], home)).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI：nyra connector flow slack-approval-roundtrip 批准一条挂起审批", async () => {
  const home = tmpHome("nyra-flow-conn-cli-");
  try {
    saveConfig(home, { bot: { owner: "1", admins: ["2"] } });
    const bridge = makeBridge(home);
    const pending = await requestApproval(bridge);
    const code = await handleConnector(
      ["flow", "slack-approval-roundtrip", "--payload", JSON.stringify(callbackPayload(pending.id, "approve")), "--by", "1"],
      home,
    );
    expect(code).toBe(0);
    expect(makeBridge(home).pendingCount()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("声明文案：三家连接器的 description 写明本批做深的能力", () => {
  expect(getDeclaration("gmail")?.description).toContain("列草稿与发送草稿");
  expect(getDeclaration("shopify")?.description).toContain("订单履约核查");
  expect(getDeclaration("slack")?.description).toContain("按钮回调回写审批桥");
});
