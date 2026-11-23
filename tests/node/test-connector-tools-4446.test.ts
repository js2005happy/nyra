// tests/node/test-connector-tools-4446.test.ts — 缺口 44 深化：Shopify / Slack 模型工具。
// 全部用假 API / 假 vault，不连真实店铺 / workspace、不碰真实 token。
// 工具层现建客户端（不用注入的 fetchFn）：全局 fetch 换成桩，测“模型工具真能调通”。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, newToolContext, TOOL_SCHEMAS, type ToolContext } from "../../src/tools.ts";
import { saveConfig } from "../../src/config.ts";
import { Vault } from "../../src/vault.ts";
import { CONNECTOR_LOCAL_USER, markConnectorRevoked, resolveConnectorUserId } from "../../src/connectors/registry.ts";
import { SHOPIFY_VAULT_CREDENTIALS_ENTRY } from "../../src/connectors/shopify.ts";
import { SLACK_VAULT_CREDENTIALS_ENTRY } from "../../src/connectors/slack.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const PASSWORD = "pw-12345";
const SHOP = "hollowandscale.myshopify.com";
const FAKE_SHOP_TOKEN = "shpat_SECRET_abc123";
const FAKE_SLACK_TOKEN = "xoxb-fake-token-123456";
const CHANNEL_ID = "C0123456789";

function seedVaults(home: string): void {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(PASSWORD);
  vault.unlock(PASSWORD);
  vault.add(SHOPIFY_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ shop: SHOP, access_token: FAKE_SHOP_TOKEN }), true);
  vault.add(SLACK_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ token: FAKE_SLACK_TOKEN, team: "hollow-scale" }), true);
  saveConfig(home, { connectors: { shopify: { enabled: true }, slack: { enabled: true } } });
}

async function withVaultPasswordAsync<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NYRA_VAULT_PASSWORD;
  try {
    process.env.NYRA_VAULT_PASSWORD = PASSWORD;
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prev;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PRODUCTS_BODY = {
  products: [
    { id: 111, title: "猫咪护理手册", vendor: "Hollow & Scale", product_type: "Guide", status: "active", variants: [{ id: 1, title: "Default", price: "0.00", inventory_quantity: 5 }] },
  ],
};

const ORDERS_BODY = {
  orders: [
    { id: 1001, name: "#1001", total_price: "29.98", currency: "USD", financial_status: "paid", fulfillment_status: "fulfilled", created_at: "2026-11-19T10:00:00Z", line_items: [{}, {}], customer: { email: "customer-secret@example.com", first_name: "Vivek" } },
  ],
};

const INVENTORY_BODY = {
  inventory_levels: [
    { inventory_item_id: 1, location_id: 10, available: 5, updated_at: "2026-11-20T00:00:00Z" },
  ],
};

const CHANNELS_BODY = {
  ok: true,
  channels: [
    { id: CHANNEL_ID, name: "general", is_private: false, num_members: 12 },
  ],
  response_metadata: { next_cursor: "" },
};

const HISTORY_BODY = {
  ok: true,
  messages: [
    { ts: "1730000000.000100", user: "U111", text: "hello-secret-text" },
  ],
  response_metadata: { next_cursor: "" },
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function stubFetch(url: string): Promise<Response> {
  if (url.includes("products.json")) return Promise.resolve(jsonResponse(PRODUCTS_BODY));
  if (url.includes("orders/1001.json")) return Promise.resolve(jsonResponse({ order: ORDERS_BODY.orders[0] }));
  if (url.includes("orders.json")) return Promise.resolve(jsonResponse(ORDERS_BODY));
  if (url.includes("inventory_levels.json")) return Promise.resolve(jsonResponse(INVENTORY_BODY));
  if (url.includes("conversations.list")) return Promise.resolve(jsonResponse(CHANNELS_BODY));
  if (url.includes("conversations.history")) return Promise.resolve(jsonResponse(HISTORY_BODY));
  if (url.includes("chat.postMessage")) return Promise.resolve(jsonResponse({ ok: true, ts: "1730000000.000300", channel: CHANNEL_ID }));
  return Promise.resolve(jsonResponse({ ok: false, error: "unknown_method" }, 404));
}

function ctxFor(home: string, workdir: string): ToolContext {
  return newToolContext({ workdir, mode: "full", interactive: false, home });
}

async function withStubFetch<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  try {
    globalThis.fetch = stubFetch as typeof fetch;
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("ConnectorTools4446Test.test_shopify_products_tool", async () => {
  const home = tmpHome("nyra-tools4446-shop-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    const out = await withStubFetch(() => executeTool("shopify_products", { limit: 10 }, ctxFor(home, workdir)));
    expect(out).toContain("猫咪护理手册");
  });
});

test("ConnectorTools4446Test.test_shopify_orders_tool_by_id_and_list", async () => {
  const home = tmpHome("nyra-tools4446-orders-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    const byId = await withStubFetch(() => executeTool("shopify_orders", { order_id: "1001" }, ctxFor(home, workdir)));
    expect(byId).toContain("#1001");
    const listed = await withStubFetch(() => executeTool("shopify_orders", { limit: 5 }, ctxFor(home, workdir)));
    expect(listed).toContain("#1001");
  });
});

test("ConnectorTools4446Test.test_shopify_inventory_tool", async () => {
  const home = tmpHome("nyra-tools4446-inv-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    const out = await withStubFetch(() => executeTool("shopify_inventory", { limit: 10 }, ctxFor(home, workdir)));
    expect(out).toContain("1");
  });
});

test("ConnectorTools4446Test.test_slack_channels_and_history_tools", async () => {
  const home = tmpHome("nyra-tools4446-slack-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    const channels = await withStubFetch(() => executeTool("slack_channels", {}, ctxFor(home, workdir)));
    expect(channels).toContain("general");
    const history = await withStubFetch(() => executeTool("slack_history", { channel_id: CHANNEL_ID }, ctxFor(home, workdir)));
    expect(history).toContain("hello-secret-text");
    // 频道消息是外部数据：包在不可信标记里返回。
    expect(history).toContain("【不可信外部数据结束】");
  });
});

test("ConnectorTools4446Test.test_slack_send_tool_full_mode", async () => {
  const home = tmpHome("nyra-tools4446-send-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    const out = await withStubFetch(() => executeTool("slack_send", { channel_id: CHANNEL_ID, text: "你好" }, ctxFor(home, workdir)));
    expect(out).toContain("已发送到频道");
    expect(out).toContain("1730000000.000300");
  });
});

test("ConnectorTools4446Test.test_revoked_connector_tool_refuses_immediately", async () => {
  // 撤销后立即失效：不用重启、不等下次启动——工具层每次现建客户端，现查账本。
  const home = tmpHome("nyra-tools4446-revoke-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    const before = await withStubFetch(() => executeTool("shopify_products", {}, ctxFor(home, workdir)));
    expect(before).toContain("猫咪护理手册");
    const userId = resolveConnectorUserId(home);
    expect(userId).toBe(CONNECTOR_LOCAL_USER);
    markConnectorRevoked(home, "shopify", userId);
    const after = await withStubFetch(() => executeTool("shopify_products", {}, ctxFor(home, workdir)));
    expect(after).toMatch(/错误/);
    expect(after).not.toContain("猫咪护理手册");
    const slackAfter = await withStubFetch(() => executeTool("slack_channels", {}, ctxFor(home, workdir)));
    expect(slackAfter).toContain("general");
    markConnectorRevoked(home, "slack", userId);
    const slackRevoked = await withStubFetch(() => executeTool("slack_channels", {}, ctxFor(home, workdir)));
    expect(slackRevoked).toMatch(/错误/);
    expect(slackRevoked).not.toContain("general");
  });
});

test("ConnectorTools4446Test.test_connector_call_event_records_user_id", async () => {
  // 每次调用记进运行记录：connector_call 事件带 user_id（没 runId 时走证据文件）。
  const home = tmpHome("nyra-tools4446-audit-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tools4446-wd-"));
  seedVaults(home);
  await withVaultPasswordAsync(async () => {
    await withStubFetch(() => executeTool("shopify_products", {}, ctxFor(home, workdir)));
  });
  const evidenceDir = join(home, "evidence", "connector");
  expect(existsSync(evidenceDir)).toBe(true);
  const files = readdirSync(evidenceDir).filter((f) => f.includes("connector_call"));
  expect(files.length).toBeGreaterThan(0);
  const text = files.map((f) => readFileSync(join(evidenceDir, f), "utf-8")).join("\n");
  expect(text).toContain("connector_call");
  expect(text).toContain(`"user_id":"${CONNECTOR_LOCAL_USER}"`);
  expect(text).toContain("list_products");
});

test("ConnectorTools4446Test.test_shopify_write_tool_does_not_exist", () => {
  // Shopify 写工具一个不加：模型工具表里没有 shopify 写操作。
  const names = TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string);
  for (const n of names) {
    expect(n.startsWith("shopify_")).toBe(n === "shopify_products" || n === "shopify_orders" || n === "shopify_inventory");
  }
  expect(names).toContain("slack_send");
});
