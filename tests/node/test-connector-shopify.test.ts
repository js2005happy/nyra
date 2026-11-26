// tests/node/test-connector-shopify.test.ts — 缺口 44 第一批：Shopify 深连接器（只读起步）。
// 全部用假 API / 假 vault，不连真实店铺、不碰真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONNECTOR_AUTH_FILE,
  CONNECTOR_AUDIT_FILE,
  ConnectorAuthStore,
  getDeclaration,
  markConnectorAuthorized,
  markConnectorExpired,
  markConnectorRevoked,
} from "../../src/connectors/registry.ts";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_DEFAULT_PAGE_LIMIT,
  SHOPIFY_FORBIDDEN_OPERATIONS,
  SHOPIFY_MAX_PAGE_LIMIT,
  SHOPIFY_READ_SCOPES,
  SHOPIFY_VAULT_CREDENTIALS_ENTRY,
  SHOPIFY_WRITE_COMMANDS,
  ShopifyApiClient,
  ShopifyAuthError,
  ShopifyError,
  createShopifyClient,
  formatShopifyOrders,
  formatShopifyProducts,
  getShopifyStatus,
  loadShopifyCredentials,
  normalizeShopifyShop,
  parseNextPageInfo,
  refuseShopifyWrite,
  shopifyWriteRefusal,
} from "../../src/connectors/shopify.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { Vault } from "../../src/vault.ts";
import { handleConnector, handleShopify } from "../../src/cli.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const FAKE_TOKEN = "shpat_SECRET_abc123";
const SHOP = "hollowandscale.myshopify.com";

function initVault(home: string, password: string): Vault {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  return vault;
}

function seedShopifyVault(home: string, password: string, shop = SHOP, token = FAKE_TOKEN): void {
  const vault = initVault(home, password);
  vault.add(SHOPIFY_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ shop, access_token: token }), true);
}

function enableShopify(home: string): void {
  saveConfig(home, { connectors: { shopify: { enabled: true } } });
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

async function withVaultPasswordAsync(password: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.NYRA_VAULT_PASSWORD;
  try {
    process.env.NYRA_VAULT_PASSWORD = password;
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prev;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200, link?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(link ? { Link: link } : {}) },
  });
}

const PRODUCTS_BODY = {
  products: [
    { id: 111, title: "猫咪护理手册", vendor: "Hollow & Scale", product_type: "Guide", status: "active", variants: [{ id: 1, title: "Default", price: "0.00", inventory_quantity: 5 }, { id: 2, title: "Pro", price: "9.99", inventory_quantity: 3 }] },
    { id: 222, title: "爬宠加热灯", vendor: "Hollow & Scale", product_type: "Lamp", status: "draft", variants: [{ id: 3, title: "Default", price: "19.99", inventory_quantity: 0 }] },
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
    { inventory_item_id: 2, location_id: 10, available: null, updated_at: "2026-11-20T00:00:00Z" },
  ],
};

function readAuditFile(home: string): string {
  return readFileSync(join(home, CONNECTOR_AUDIT_FILE), "utf-8");
}

test("ConnectorShopifyTest.test_declaration_is_read_only", () => {
  const shopify = getDeclaration("shopify");
  // 第 0 批是试点，本批改为已接入（只读）。
  expect(shopify?.status).toBe("available");
  expect(shopify?.scopes.read).toEqual(["read_products", "read_orders", "read_inventory"]);
  expect(shopify?.scopes.read).toEqual(SHOPIFY_READ_SCOPES);
  // 写 scope 故意留空：本批只读，不存在“已声明写权限但没用上”的灰色地带。
  expect(shopify?.scopes.write).toEqual([]);
  expect(shopify?.toolGroups.length).toBeGreaterThan(0);
  for (const g of shopify?.toolGroups ?? []) expect(g.access).toBe("read");
  expect(shopify?.toolGroups.map((g) => g.name)).toContain("商品");
  expect(shopify?.toolGroups.map((g) => g.name)).toContain("订单");
  expect(shopify?.toolGroups.map((g) => g.name)).toContain("库存");
  for (const op of ["改价", "改库存", "退款", "删单"]) expect(shopify?.alwaysForbidden).toContain(op);
  expect(shopify?.dataAccessed.length).toBeGreaterThan(0);
  // Slack 在缺口 44 第二批改为已接入（读 + 发消息须批 + 审批卡）。
  expect(getDeclaration("slack")?.status).toBe("available");
});

test("ConnectorShopifyTest.test_normalize_shop", () => {
  expect(normalizeShopifyShop("hollowandscale")).toBe("hollowandscale.myshopify.com");
  expect(normalizeShopifyShop("hollowandscale.myshopify.com")).toBe("hollowandscale.myshopify.com");
  expect(normalizeShopifyShop("https://HollowAndScale.myshopify.com/")).toBe("hollowandscale.myshopify.com");
  expect(normalizeShopifyShop("evil.com")).toBeNull();
  expect(normalizeShopifyShop("evil.myshopify.com.evil.com")).toBeNull();
  expect(normalizeShopifyShop("")).toBeNull();
  expect(normalizeShopifyShop("a b.myshopify.com")).toBeNull();
});

test("ConnectorShopifyTest.test_write_refusal", () => {
  for (const op of SHOPIFY_FORBIDDEN_OPERATIONS) {
    expect(() => refuseShopifyWrite(op)).toThrow(ShopifyError);
    expect(() => refuseShopifyWrite(op)).toThrow(/只读/);
    expect(shopifyWriteRefusal(op)).toContain(op);
  }
  // CLI 上写意图的词也在拒绝表里。
  for (const cmd of ["set-price", "update-inventory", "refund", "create-order", "create-discount"]) {
    expect((SHOPIFY_WRITE_COMMANDS as readonly string[])).toContain(cmd);
  }
});

test("ConnectorShopifyTest.test_no_credentials_refuses", () => {
  const home = tmpHome("nyra-shop-nocreds-");
  enableShopify(home);
  withVaultPassword("pw-12345", () => {
    expect(() => createShopifyClient(home, loadConfig(home))).toThrow(ShopifyAuthError);
    expect(() => createShopifyClient(home, loadConfig(home))).toThrow(/nyra shopify auth/);
  });
});

test("ConnectorShopifyTest.test_not_enabled_refuses", () => {
  const home = tmpHome("nyra-shop-disabled-");
  seedShopifyVault(home, "pw-12345");
  // 配置里没开：凭证在也不放行。
  withVaultPassword("pw-12345", () => {
    expect(() => createShopifyClient(home, loadConfig(home))).toThrow(/未启用/);
  });
});

test("ConnectorShopifyTest.test_load_credentials_validates_shop", () => {
  const home = tmpHome("nyra-shop-badshop-");
  seedShopifyVault(home, "pw-12345", "evil.com");
  withVaultPassword("pw-12345", () => {
    expect(loadShopifyCredentials(home)).toBeNull();
  });
  const home2 = tmpHome("nyra-shop-goodshop-");
  seedShopifyVault(home2, "pw-12345", "hollowandscale");
  withVaultPassword("pw-12345", () => {
    const credentials = loadShopifyCredentials(home2);
    expect(credentials?.shop).toBe(SHOP);
    expect(credentials?.accessToken).toBe(FAKE_TOKEN);
  });
});

test("ConnectorShopifyTest.test_list_products_parses_and_defaults_limit_50", async () => {
  const home = tmpHome("nyra-shop-products-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const seenUrls: string[] = [];
  const stubFetch: FetchFn = async (url) => {
    seenUrls.push(url);
    return jsonResponse(PRODUCTS_BODY);
  };
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    const { products, nextPageInfo } = await client.listProducts();
    expect(products.length).toBe(2);
    expect(products[0]).toEqual({ id: 111, title: "猫咪护理手册", vendor: "Hollow & Scale", productType: "Guide", status: "active", variantCount: 2, totalInventory: 8 });
    expect(products[1]?.totalInventory).toBe(0);
    expect(nextPageInfo).toBeUndefined();
    // 默认 50 条一页；URL 固定 host + 版本，不含 token。
    expect(seenUrls[0]).toContain(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/products.json`);
    expect(seenUrls[0]).toContain("limit=50");
    expect(seenUrls[0]).not.toContain(FAKE_TOKEN);
    expect(SHOPIFY_DEFAULT_PAGE_LIMIT).toBe(50);
    // 格式化输出里有商品标题。
    expect(formatShopifyProducts(products)).toContain("猫咪护理手册");
  });
});

test("ConnectorShopifyTest.test_limit_capped_at_250", async () => {
  const home = tmpHome("nyra-shop-limit-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const seenUrls: string[] = [];
  const stubFetch: FetchFn = async (url) => {
    seenUrls.push(url);
    return jsonResponse(PRODUCTS_BODY);
  };
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    await client.listProducts({ limit: 999 });
    expect(seenUrls[0]).toContain("limit=250");
    expect(SHOPIFY_MAX_PAGE_LIMIT).toBe(250);
  });
});

test("ConnectorShopifyTest.test_pagination_next_page_info", async () => {
  const home = tmpHome("nyra-shop-page-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const nextLink = `<https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/products.json?page_info=abc123&limit=50>; rel="next"`;
  const stubFetch: FetchFn = async () => jsonResponse(PRODUCTS_BODY, 200, nextLink);
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    const { nextPageInfo } = await client.listProducts();
    expect(nextPageInfo).toBe("abc123");
    expect(parseNextPageInfo(null)).toBeUndefined();
    expect(parseNextPageInfo(`<https://x/admin/api/2025-10/products.json?page_info=q&limit=50>; rel="previous"`)).toBeUndefined();
  });
});

test("ConnectorShopifyTest.test_get_product_validates_id", async () => {
  const home = tmpHome("nyra-shop-getp-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const stubFetch: FetchFn = async () => jsonResponse({ product: PRODUCTS_BODY.products[0] });
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    await expect(client.getProduct("1;DROP")).rejects.toThrow(/不合法/);
    const p = await client.getProduct("111");
    expect(p.id).toBe(111);
    expect(p.title).toBe("猫咪护理手册");
  });
});

test("ConnectorShopifyTest.test_list_orders_drops_customer_info", async () => {
  const home = tmpHome("nyra-shop-orders-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const seenUrls: string[] = [];
  const stubFetch: FetchFn = async (url) => {
    seenUrls.push(url);
    return jsonResponse(ORDERS_BODY);
  };
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    const { orders } = await client.listOrders({ status: "any" });
    expect(orders.length).toBe(1);
    expect(orders[0]).toEqual({ id: 1001, name: "#1001", totalPrice: "29.98", currency: "USD", financialStatus: "paid", fulfillmentStatus: "fulfilled", createdAt: "2026-11-19T10:00:00Z", lineItemsCount: 2 });
    // 客户邮箱只存在于原始响应里，解析结果与格式化输出里都没有。
    expect(JSON.stringify(orders)).not.toContain("customer-secret@example.com");
    expect(formatShopifyOrders(orders)).not.toContain("customer-secret@example.com");
    expect(formatShopifyOrders(orders)).toContain("#1001");
    expect(seenUrls[0]).toContain("status=any");
    await expect(client.listOrders({ status: "bogus" })).rejects.toThrow(/不合法/);
  });
});

test("ConnectorShopifyTest.test_list_inventory_levels", async () => {
  const home = tmpHome("nyra-shop-inv-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const seenUrls: string[] = [];
  const stubFetch: FetchFn = async (url) => {
    seenUrls.push(url);
    return jsonResponse(INVENTORY_BODY);
  };
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    const { levels } = await client.listInventoryLevels({ locationIds: [10] });
    expect(levels.length).toBe(2);
    expect(levels[0]).toEqual({ inventoryItemId: 1, locationId: 10, available: 5, updatedAt: "2026-11-20T00:00:00Z" });
    expect(levels[1]?.available).toBeNull();
    expect(seenUrls[0]).toContain("location_ids=10");
  });
});

test("ConnectorShopifyTest.test_401_marks_expired", async () => {
  const home = tmpHome("nyra-shop-401-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  markConnectorAuthorized(home, "shopify", "local");
  const stubFetch: FetchFn = async () => new Response(JSON.stringify({ errors: "Unauthorized" }), { status: 401 });
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    await expect(client.listProducts()).rejects.toThrow(ShopifyAuthError);
    // 状态已被标过期：下一次建客户端直接拒绝，不再拿死 token 反复试。
    expect(new ConnectorAuthStore(home).get("shopify", "local")?.state).toBe("expired");
    expect(() => createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch })).toThrow(/已过期/);
  });
});

test("ConnectorShopifyTest.test_revoked_refuses_immediately", () => {
  const home = tmpHome("nyra-shop-revoked-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  markConnectorRevoked(home, "shopify", "local");
  withVaultPassword("pw-12345", () => {
    expect(() => createShopifyClient(home, loadConfig(home))).toThrow(/已被撤销/);
  });
});

test("ConnectorShopifyTest.test_migration_from_existing_credentials", () => {
  const home = tmpHome("nyra-shop-migrate-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  withVaultPassword("pw-12345", () => {
    const client = createShopifyClient(home, loadConfig(home));
    expect(client.shop()).toBe(SHOP);
    const rec = new ConnectorAuthStore(home).get("shopify", "local");
    expect(rec?.state).toBe("authorized");
    expect(rec?.migratedFrom).toBe("existing-credentials");
  });
});

test("ConnectorShopifyTest.test_call_audit_metadata_only", async () => {
  const home = tmpHome("nyra-shop-audit-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const stubFetch: FetchFn = async (url) => {
    if (url.includes("products.json")) return jsonResponse(PRODUCTS_BODY);
    return jsonResponse(ORDERS_BODY);
  };
  await withVaultPasswordAsync("pw-12345", async () => {
    const client = createShopifyClient(home, loadConfig(home), { fetchFn: stubFetch });
    await client.listProducts();
    await client.listOrders();
    const audit = readAuditFile(home);
    const lines = audit.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const calls = lines.filter((l) => l.action === "call");
    expect(calls.length).toBe(2);
    expect(calls[0]?.connector).toBe("shopify");
    expect(calls[0]?.operation).toBe("list_products");
    expect(calls[0]?.records).toBe(2);
    expect(typeof calls[0]?.duration_ms).toBe("number");
    expect(calls[1]?.operation).toBe("list_orders");
    expect(calls[1]?.records).toBe(1);
    // 审计里只有元数据：token 原文与客户邮箱都不在。
    expect(audit).not.toContain(FAKE_TOKEN);
    expect(audit).not.toContain("customer-secret@example.com");
    const state = readFileSync(join(home, CONNECTOR_AUTH_FILE), "utf-8");
    expect(state).not.toContain(FAKE_TOKEN);
  });
});

test("ConnectorShopifyTest.test_status_reports_shop_and_state", () => {
  const home = tmpHome("nyra-shop-status-");
  const fresh = getShopifyStatus(home, { connectors: { shopify: { enabled: true } } });
  expect(fresh.authState).toBe("unauthorized");
  expect(fresh.configured).toBe(false);
  expect(fresh.shop).toBeUndefined();

  seedShopifyVault(home, "pw-12345");
  // 店铺域名要解密凭证才看得到：包在密码环境里断言。
  withVaultPassword("pw-12345", () => {
    const locked = getShopifyStatus(home, { connectors: { shopify: { enabled: true } } });
    expect(locked.configured).toBe(true);
    expect(locked.shop).toBe(SHOP);
    expect(locked.authState).toBe("authorized");
  });

  markConnectorRevoked(home, "shopify", "local");
  expect(getShopifyStatus(home, { connectors: { shopify: { enabled: true } } }).authState).toBe("revoked");
});

test("ConnectorShopifyTest.test_cli_products_and_write_refusal", async () => {
  const home = tmpHome("nyra-shop-cli-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  const stubFetch: FetchFn = async (url) => {
    if (url.includes("products.json")) return jsonResponse(PRODUCTS_BODY);
    return jsonResponse(ORDERS_BODY);
  };
  await withVaultPasswordAsync("pw-12345", async () => {
    expect(await handleShopify(["status"], home)).toBe(0);
    expect(await handleShopify(["products"], home, { fetchFn: stubFetch })).toBe(0);
    expect(await handleShopify(["orders", "--status", "any"], home, { fetchFn: stubFetch })).toBe(0);
    expect(await handleShopify(["inventory", "--location-id", "10"], home, { fetchFn: stubFetch })).toBe(0);
    expect(await handleShopify(["product"], home)).toBe(2);
    // 写意图直接拒绝，不碰网络、不碰 vault。
    expect(await handleShopify(["refund"], home)).toBe(1);
    expect(await handleShopify(["set-price"], home)).toBe(1);
    expect(await handleShopify(["bogus"], home)).toBe(2);
    expect(await handleShopify(["--help"], home)).toBe(0);
  });
});

test("ConnectorShopifyTest.test_cli_auth_stores_credentials", async () => {
  const home = tmpHome("nyra-shop-cliauth-");
  initVault(home, "pw-12345");
  const probeOk: FetchFn = async (url) => {
    if (url.includes("shop.json")) return jsonResponse({ shop: { id: 1, name: "Hollow & Scale" } });
    return jsonResponse({});
  };
  const code = await handleShopify(["auth"], home, {
    secrets: ["pw-12345", "hollowandscale", FAKE_TOKEN],
    fetchFn: probeOk,
  });
  expect(code).toBe(0);
  withVaultPassword("pw-12345", () => {
    const creds = loadShopifyCredentials(home);
    expect(creds?.shop).toBe(SHOP);
    expect(creds?.accessToken).toBe(FAKE_TOKEN);
    expect(loadConfig(home).connectors).toMatchObject({ shopify: { enabled: true } });
    expect(new ConnectorAuthStore(home).get("shopify", "local")?.state).toBe("authorized");
  });
});

test("ConnectorShopifyTest.test_cli_auth_rejects_bad_token_probe", async () => {
  const home = tmpHome("nyra-shop-cliauth401-");
  initVault(home, "pw-12345");
  const probe401: FetchFn = async () => new Response(JSON.stringify({ errors: "Unauthorized" }), { status: 401 });
  const code = await handleShopify(["auth"], home, {
    secrets: ["pw-12345", SHOP, "shpat-wrong"],
    fetchFn: probe401,
  });
  expect(code).toBe(1);
  // 401 的 token 不存。
  expect(existsSync(join(home, "vault.json"))).toBe(true);
  withVaultPassword("pw-12345", () => {
    expect(loadShopifyCredentials(home)).toBeNull();
  });
});

test("ConnectorShopifyTest.test_cli_connector_approve_and_revoke_shopify", async () => {
  const home = tmpHome("nyra-shop-conn-");
  seedShopifyVault(home, "pw-12345");
  enableShopify(home);
  // 批准要读凭证原文做指纹：整段包在密码环境里。
  await withVaultPasswordAsync("pw-12345", async () => {
    // 密码箱有凭证但账本没记录时，approve 视为“已经是已授权候选”直接返回 0，
    // 正式记录在首次调用时沿用迁移（与 Gmail 的 approve 同款语义）。
    expect(await handleConnector(["approve", "shopify"], home)).toBe(0);
    expect(new ConnectorAuthStore(home).get("shopify", "local")).toBeNull();
    // 先撤销一条记录（账本级，不动 vault），再批准才真正走 markConnectorAuthorized。
    markConnectorRevoked(home, "shopify", "local");
    expect(await handleConnector(["approve", "shopify"], home)).toBe(0);
    expect(new ConnectorAuthStore(home).get("shopify", "local")?.state).toBe("authorized");
    expect(await handleConnector(["approve", "shopify"], home)).toBe(0);
    // 撤销：状态立即失效，本地凭证删除，连接器关闭。
    expect(await handleConnector(["revoke", "shopify", "--yes"], home)).toBe(0);
  });
  expect(new ConnectorAuthStore(home).get("shopify", "local")?.state).toBe("revoked");
  withVaultPassword("pw-12345", () => {
    expect(loadShopifyCredentials(home)).toBeNull();
    expect(loadConfig(home).connectors).toMatchObject({ shopify: { enabled: false } });
  });
});

test("ConnectorShopifyTest.test_cli_shopify_subprocess", () => {
  const home = tmpHome("nyra-shop-cli2-");
  const run = (args: string[]) => spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" },
    encoding: "utf-8",
    timeout: 60000,
  });
  const help = run(["shopify", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout ?? "").toContain("products");
  expect(help.stdout ?? "").toContain("只读");
  const status = run(["shopify", "status"]);
  expect(status.status).toBe(0);
  expect(status.stdout ?? "").toContain("Shopify 连接器");
  expect(status.stdout ?? "").toContain("未授权");
  const bad = run(["shopify", "bogus-cmd"]);
  expect(bad.status).toBe(2);
});
