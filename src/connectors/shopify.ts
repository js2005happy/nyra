// src/connectors/shopify.ts — 原生业务连接器：Shopify（缺口 44 第一批，只读起步）。
//
// 设计（见 docs/connectors.md 的 Shopify 一节）：
// - 只读：查商品 / 查订单 / 查库存水平。任何写操作（改价、改库存、下单、
//   退款、发折扣码、删单）都在调 Shopify API 之前就拒绝，不留后门——本批
//   连写操作的调用入口都不提供，CLI 上写意图的词也直接回一句明确拒绝。
// - G-P0-6 做深：订单履约核查（checkOrderFulfillment）——订单详情 + 行项目
//   + 库存水平逐项核对“可售 ≥ 要发”，仍是只读判断，不改订单、不动库存。
// - 凭证：Shopify 自定义应用的 Admin API access token（shpat_…）+ 店铺域名，
//   用户在 Shopify 后台建 custom app、把 token 粘贴进密码箱（nyra shopify
//   auth 交互输入，只存密码箱）。localhost 没有公网回调，做不了 Shopify
//   OAuth 回环，所以本批不走 OAuth 授权码流程——这点写进文档，不假装是 OAuth。
// - 域名校验：只接受 *.myshopify.com，用户输入永远成不了 URL 的 host；
//   路径全部由固定模板 + 数字 id 拼成，用户输入永远拼不成越界路径。
// - 每次调用走授权状态机（registry 的 ensureConnectorUsable）：未授权 /
//   过期 / 已撤销一律拦在门外；401 说明 token 死了（被删/被轮换），标过期。
// - 审计：每次调用记一行 connector-audit.jsonl，只记操作名、记录数、耗时，
//   不记 token、不记商品内容、不记客户信息（订单输出本身就不含客户邮箱与地址）。
// - 不引新依赖：只用全局 fetch 调 Shopify Admin REST API。
import { getCredential, Vault, vaultPath } from "../vault.ts";
import {
  appendConnectorAudit,
  ensureConnectorUsable,
  markConnectorExpired,
  peekConnectorState,
  resolveConnectorUserId,
  tokenFingerprint,
  type ConnectorAuthState,
} from "./registry.ts";
import { recordConnectorCall } from "./directory.ts";

/** Shopify Admin REST API 版本（已发布的稳定版；升版时连同测试里的断言一起改）。 */
export const SHOPIFY_API_VERSION = "2025-10";
/** 密码箱条目名：店铺域名 + access token 一条（名字明文、值加密，见 vault.ts）。 */
export const SHOPIFY_VAULT_CREDENTIALS_ENTRY = "shopify-credentials";
/** 只读工具真正要的 scope：自定义应用建好后只勾这三个读权限，多了不要。 */
export const SHOPIFY_READ_SCOPES = ["read_products", "read_orders", "read_inventory"];
/** 单页默认条数 / 硬顶（Shopify 单页上限就是 250，防一次拉全库）。 */
export const SHOPIFY_DEFAULT_PAGE_LIMIT = 50;
export const SHOPIFY_MAX_PAGE_LIMIT = 250;
/** 单次 API 请求超时（毫秒）。 */
export const SHOPIFY_REQUEST_TIMEOUT_MS = 30_000;

export class ShopifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyError";
  }
}

/** 授权失效（token 被删/被轮换/权限被收回）：唯一的出路是重新跑 nyra shopify auth。 */
export class ShopifyAuthError extends ShopifyError {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyAuthError";
  }
}

export interface ShopifyCredentials {
  shop: string;
  accessToken: string;
}

export interface ShopifyProductSummary {
  id: number;
  title: string;
  vendor: string;
  productType: string;
  status: string;
  variantCount: number;
  /** 全部 variant 的库存数之和（只作概览，精确到地点见库存接口）。 */
  totalInventory: number;
}

export interface ShopifyOrderSummary {
  id: number;
  /** 订单号（如 #1001）：只取编号，不取客户信息。 */
  name: string;
  totalPrice: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  /** 取消时间（缺失 = 未取消；履约核查靠它判“已取消”，fulfillment_status 里没有取消这一档）。 */
  cancelledAt?: string;
  createdAt: string;
  lineItemsCount: number;
}

export interface ShopifyInventoryLevel {
  inventoryItemId: number;
  locationId: number;
  available: number | null;
  updatedAt: string;
}

/** 本批一律拒绝的写操作（CLI 上撞见这些词也直接回拒绝，不进 API）。 */
export const SHOPIFY_WRITE_COMMANDS = [
  "set-price", "update-price", "update-inventory", "create-order",
  "refund", "create-discount", "discount", "delete-order",
] as const;
export const SHOPIFY_FORBIDDEN_OPERATIONS = ["改价", "改库存", "下单", "退款", "发折扣码", "删单", "改客户支付信息"];

export function shopifyWriteRefusal(operation: string): string {
  return `Shopify 连接器本批只读：「${operation}」是写操作，已拒绝——改价、改库存、下单、退款、发折扣码、删单一律不做。`;
}

export function refuseShopifyWrite(operation: string): never {
  throw new ShopifyError(shopifyWriteRefusal(operation));
}

/** 店铺域名归一化：接受 "xxx" 或 "xxx.myshopify.com"（可带 https:// 前缀），
 * 其余一律拒绝——host 只能是 *.myshopify.com，用户输入成不了别的 host。 */
export function normalizeShopifyShop(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!s) return null;
  if (!s.endsWith(".myshopify.com")) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}

/** 密码箱里静默读凭证：无箱、无密码、密码错、条目缺失、内容损坏、域名不合法
 * 一律返回 null，不抛错。token 原文只在内存里，调用方绝不能把它写进日志。 */
export function loadShopifyCredentials(home: string): ShopifyCredentials | null {
  const raw = getCredential(SHOPIFY_VAULT_CREDENTIALS_ENTRY, home);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.shop !== "string" || typeof data.access_token !== "string") return null;
    const shop = normalizeShopifyShop(data.shop);
    if (!shop) return null;
    const accessToken = data.access_token.trim();
    if (!accessToken) return null;
    return { shop, accessToken };
  } catch {
    return null;
  }
}

/** 密码箱里有没有 shopify-credentials 条目（只看条目名，不用解锁——status 能直接报）。 */
export function hasShopifyCredentialsEntry(home: string): boolean {
  try {
    return new Vault(vaultPath(home)).listNames().includes(SHOPIFY_VAULT_CREDENTIALS_ENTRY);
  } catch {
    return false;
  }
}

export function resolveShopifyEnabled(config: Record<string, unknown>): boolean {
  const section = (config as { connectors?: unknown }).connectors;
  if (!section || typeof section !== "object") return false;
  const shopify = (section as { shopify?: unknown }).shopify;
  if (!shopify || typeof shopify !== "object") return false;
  return (shopify as { enabled?: unknown }).enabled === true;
}

export interface ShopifyConnectorStatus {
  /** config.connectors.shopify.enabled：默认关，显式开才可用。 */
  enabled: boolean;
  /** 密码箱里有凭证条目（只看条目名、不解密；内容损坏时工具调用仍会报错）。 */
  configured: boolean;
  shop?: string;
  /** 缺口 44 第 0 批：授权状态机的当前状态（只读看一眼，不写账本、不迁移）。 */
  authState: ConnectorAuthState;
}

export function getShopifyStatus(home: string, config: Record<string, unknown>): ShopifyConnectorStatus {
  const enabled = resolveShopifyEnabled(config);
  const creds = loadShopifyCredentials(home);
  const hasEntry = hasShopifyCredentialsEntry(home);
  return {
    enabled,
    configured: hasEntry,
    ...(creds ? { shop: creds.shop } : {}),
    // 密码箱里有条目就算“已授权”的候选：首次调用 createShopifyClient 时
    // 会沿用已有授权正式记一笔；这里只读，不写账本。
    authState: peekConnectorState(home, "shopify", resolveConnectorUserId(home), { hasTokens: hasEntry }),
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function clampLimit(limit?: number): number {
  const n = Math.floor(limit ?? SHOPIFY_DEFAULT_PAGE_LIMIT);
  if (!Number.isFinite(n) || n < 1) return SHOPIFY_DEFAULT_PAGE_LIMIT;
  return Math.min(n, SHOPIFY_MAX_PAGE_LIMIT);
}

/** Shopify REST 的翻页：Link 头里 rel="next" 的 URL 带 page_info 参数。 */
export function parseNextPageInfo(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  const m = /<[^>]*[?&]page_info=([^>&]+)[^>]*>\s*;\s*rel="next"/.exec(linkHeader);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 商品只取展示字段：客户信息不在商品响应里，库存只取总数（精确到地点见库存接口）。 */
export function parseProductSummary(data: unknown): ShopifyProductSummary | null {
  const d = asRecord(data);
  if (!d || typeof d.id !== "number") return null;
  const variants = asArray(d.variants).map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
  return {
    id: d.id,
    title: asString(d.title),
    vendor: asString(d.vendor),
    productType: asString(d.product_type),
    status: asString(d.status),
    variantCount: variants.length,
    totalInventory: variants.reduce((sum, v) => sum + asNumber(v.inventory_quantity), 0),
  };
}

/** 订单只取展示字段：customer 对象整个不解析——订单输出不含客户邮箱与地址。 */
export function parseOrderSummary(data: unknown): ShopifyOrderSummary | null {
  const d = asRecord(data);
  if (!d || typeof d.id !== "number") return null;
  const cancelledAt = asString(d.cancelled_at);
  return {
    id: d.id,
    name: asString(d.name),
    totalPrice: asString(d.total_price),
    currency: asString(d.currency),
    financialStatus: asString(d.financial_status),
    fulfillmentStatus: asString(d.fulfillment_status),
    ...(cancelledAt ? { cancelledAt } : {}),
    createdAt: asString(d.created_at),
    lineItemsCount: asArray(d.line_items).length,
  };
}

/** 订单行项目（G-P0-6 履约核查用）：只取发货要核的字段——商品名、数量、
 * 库存项 id（没有它就没法按库存核对，核查时如实记“无法核查”）。 */
export interface ShopifyOrderLineItem {
  id: number;
  title: string;
  variantId?: number;
  inventoryItemId?: number;
  quantity: number;
}

export function parseOrderLineItems(data: unknown): ShopifyOrderLineItem[] {
  const items = asArray(asRecord(data)?.line_items);
  const out: ShopifyOrderLineItem[] = [];
  for (const raw of items) {
    const d = asRecord(raw);
    if (!d || typeof d.id !== "number") continue;
    out.push({
      id: d.id,
      title: asString(d.title),
      ...(typeof d.variant_id === "number" ? { variantId: d.variant_id } : {}),
      ...(typeof d.inventory_item_id === "number" ? { inventoryItemId: d.inventory_item_id } : {}),
      quantity: asNumber(d.quantity),
    });
  }
  return out;
}

export interface ShopifyOrderDetail {
  order: ShopifyOrderSummary;
  lineItems: ShopifyOrderLineItem[];
}

export function parseInventoryLevel(data: unknown): ShopifyInventoryLevel | null {
  const d = asRecord(data);
  if (!d || typeof d.inventory_item_id !== "number" || typeof d.location_id !== "number") return null;
  return {
    inventoryItemId: d.inventory_item_id,
    locationId: d.location_id,
    available: typeof d.available === "number" ? d.available : null,
    updatedAt: asString(d.updated_at),
  };
}

/**
 * Shopify Admin REST API 传输层（只读）：只调固定 host（<shop>.myshopify.com，
 * shop 已由 normalizeShopifyShop 锁死后缀），不接受调用方传入任意 URL；
 * 401 说明 token 死了（被删/被轮换/权限被收回），标过期并报重新授权。
 * 每次调用记一行审计：只记操作名、记录数、耗时，不记 token、不记响应内容。
 */
export class ShopifyApiClient {
  private readonly credentials: ShopifyCredentials;
  private readonly home: string;
  private readonly userId: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: { credentials: ShopifyCredentials; home: string; userId: string; fetchFn?: FetchFn }) {
    this.credentials = opts.credentials;
    this.home = opts.home;
    this.userId = opts.userId;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** 当前店铺域名（状态展示用；token 绝不能从这里出去）。 */
  shop(): string {
    return this.credentials.shop;
  }

  private audit(operation: string, records: number, startedAt: number): void {
    appendConnectorAudit(this.home, {
      action: "call",
      connector: "shopify",
      userId: this.userId,
      operation,
      records,
      durationMs: Date.now() - startedAt,
    });
    // 缺口 44 第一批：调用计数进用量账本与运行记录（最佳努力，记不上不拦调用）。
    recordConnectorCall(this.home, { connector: "shopify", operation, records, durationMs: Date.now() - startedAt });
  }

  private async get(path: string, query: Record<string, string>): Promise<{ data: unknown; link: string | null; ms: number }> {
    const startedAt = Date.now();
    const url = `https://${this.credentials.shop}/admin/api/${SHOPIFY_API_VERSION}/${path}?${new URLSearchParams(query).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHOPIFY_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "GET",
        headers: { "X-Shopify-Access-Token": this.credentials.accessToken },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new ShopifyError(`Shopify 请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - startedAt;
    if (res.status === 401) {
      // token 死了：标过期，下次调用直接报“请重新授权”，不再拿死 token 反复试。
      try { markConnectorExpired(this.home, "shopify", this.userId, "access token 失效（被删/被轮换/权限被收回）"); } catch { /* 标过期失败不改变调用失败本身 */ }
      throw new ShopifyAuthError("Shopify 授权已过期：access token 失效，请重新运行 nyra shopify auth（并确认自定义应用的读权限还在）");
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text) as { errors?: unknown };
        if (typeof data?.errors === "string" && data.errors) detail = data.errors;
        else if (data?.errors && typeof data.errors === "object") detail = JSON.stringify(data.errors);
      } catch { /* 非 JSON 错误体直接用状态码 */ }
      throw new ShopifyError(`Shopify 请求失败：${detail}`);
    }
    let data: unknown;
    try { data = JSON.parse(text) as unknown; } catch { throw new ShopifyError("Shopify 返回了无法识别的内容"); }
    return { data, link: res.headers.get("Link"), ms };
  }

  async listProducts(opts?: { limit?: number; pageInfo?: string }): Promise<{ products: ShopifyProductSummary[]; nextPageInfo?: string }> {
    const query: Record<string, string> = { limit: String(clampLimit(opts?.limit)) };
    if (opts?.pageInfo) query.page_info = opts.pageInfo;
    const startedAt = Date.now();
    const { data, link } = await this.get("products.json", query);
    const products = asArray(asRecord(data)?.products).map(parseProductSummary).filter((p): p is ShopifyProductSummary => p !== null);
    this.audit("list_products", products.length, startedAt);
    const next = parseNextPageInfo(link);
    return { products, ...(next ? { nextPageInfo: next } : {}) };
  }

  async getProduct(id: string): Promise<ShopifyProductSummary> {
    if (!/^\d+$/.test(id)) throw new ShopifyError(`商品 id 不合法：${id}（只接受数字 id）`);
    const startedAt = Date.now();
    const { data } = await this.get(`products/${id}.json`, {});
    const product = parseProductSummary(asRecord(data)?.product);
    if (!product) throw new ShopifyError(`Shopify 没有返回 id 为 ${id} 的商品`);
    this.audit("get_product", 1, startedAt);
    return product;
  }

  async listOrders(opts?: { limit?: number; status?: string; pageInfo?: string }): Promise<{ orders: ShopifyOrderSummary[]; nextPageInfo?: string }> {
    const status = opts?.status ?? "any";
    if (!["any", "open", "closed", "cancelled", "archived"].includes(status)) {
      throw new ShopifyError(`订单状态不合法：${status}（只接受 any/open/closed/cancelled/archived）`);
    }
    const query: Record<string, string> = { limit: String(clampLimit(opts?.limit)), status };
    if (opts?.pageInfo) query.page_info = opts.pageInfo;
    const startedAt = Date.now();
    const { data, link } = await this.get("orders.json", query);
    const orders = asArray(asRecord(data)?.orders).map(parseOrderSummary).filter((o): o is ShopifyOrderSummary => o !== null);
    this.audit("list_orders", orders.length, startedAt);
    const next = parseNextPageInfo(link);
    return { orders, ...(next ? { nextPageInfo: next } : {}) };
  }

  async getOrder(id: string): Promise<ShopifyOrderSummary> {
    if (!/^\d+$/.test(id)) throw new ShopifyError(`订单 id 不合法：${id}（只接受数字 id）`);
    const startedAt = Date.now();
    const { data } = await this.get(`orders/${id}.json`, {});
    const order = parseOrderSummary(asRecord(data)?.order);
    if (!order) throw new ShopifyError(`Shopify 没有返回 id 为 ${id} 的订单`);
    this.audit("get_order", 1, startedAt);
    return order;
  }

  /** 查一个订单的详情（订单 + 行项目，G-P0-6 履约核查用）：行项目里没有
   * inventory_item_id 的项照常返回，核查时记“无法核查”，不静默跳过。 */
  async getOrderDetail(id: string): Promise<ShopifyOrderDetail> {
    if (!/^\d+$/.test(id)) throw new ShopifyError(`订单 id 不合法：${id}（只接受数字 id）`);
    const startedAt = Date.now();
    const { data } = await this.get(`orders/${id}.json`, {});
    const order = parseOrderSummary(asRecord(data)?.order);
    if (!order) throw new ShopifyError(`Shopify 没有返回 id 为 ${id} 的订单`);
    const lineItems = parseOrderLineItems(asRecord(data)?.order);
    this.audit("get_order_detail", lineItems.length, startedAt);
    return { order, lineItems };
  }

  async listInventoryLevels(opts?: { locationIds?: number[]; inventoryItemIds?: number[]; limit?: number; pageInfo?: string }): Promise<{ levels: ShopifyInventoryLevel[]; nextPageInfo?: string }> {
    const query: Record<string, string> = { limit: String(clampLimit(opts?.limit)) };
    if (opts?.locationIds?.length) query.location_ids = opts.locationIds.join(",");
    if (opts?.inventoryItemIds?.length) query.inventory_item_ids = opts.inventoryItemIds.join(",");
    if (opts?.pageInfo) query.page_info = opts.pageInfo;
    const startedAt = Date.now();
    const { data, link } = await this.get("inventory_levels.json", query);
    const levels = asArray(asRecord(data)?.inventory_levels).map(parseInventoryLevel).filter((l): l is ShopifyInventoryLevel => l !== null);
    this.audit("list_inventory_levels", levels.length, startedAt);
    const next = parseNextPageInfo(link);
    return { levels, ...(next ? { nextPageInfo: next } : {}) };
  }
}

/**
 * 建一个能用的 Shopify 客户端：未启用、没配凭证、没批准时直接抛错，
 * 调用方把错误原样告诉用户（里面已经写清下一步该跑什么命令）。
 * 缺口 44 第 0 批的门禁：建之前先过授权状态机——已过期/已撤销/未批准的
 * 一律拦在门外（fail-closed）；密码箱里已有凭证但状态账本还没记录的，
 * 沿用已有授权迁移为已授权（不打断已跑过 nyra shopify auth 的用户）。
 * fetchFn 只供测试注入；生产永远用全局 fetch。
 */
export function createShopifyClient(home: string, config: Record<string, unknown>, opts?: { fetchFn?: FetchFn }): ShopifyApiClient {
  if (!resolveShopifyEnabled(config)) {
    throw new ShopifyError("Shopify 连接器未启用：先运行 nyra shopify auth 完成授权（授权成功会自动启用）");
  }
  const creds = loadShopifyCredentials(home);
  if (!creds) throw new ShopifyAuthError("Shopify 未授权：密码箱里没有凭证，请运行 nyra shopify auth");
  const userId = resolveConnectorUserId(home);
  const usable = ensureConnectorUsable(home, "shopify", userId, {
    hasTokens: true,
    tokenFingerprint: tokenFingerprint(creds.accessToken),
    scopes: SHOPIFY_READ_SCOPES.join(","),
  });
  if (!usable.ok) throw new ShopifyAuthError(usable.message);
  return new ShopifyApiClient({ credentials: creds, home, userId, fetchFn: opts?.fetchFn });
}

/** 履约核查结论（G-P0-6）：只读判断，不改订单、不改库存。 */
export type FulfillmentVerdict = "fulfillable" | "short" | "already-fulfilled" | "cancelled";

export interface FulfillmentItemCheck {
  lineItem: ShopifyOrderLineItem;
  required: number;
  /** 库存接口返回的可售数；没返回（没该项 / 没库存项 id）记 null，不猜 0。 */
  available: number | null;
  ok: boolean;
  note?: string;
}

export interface FulfillmentCheck {
  order: ShopifyOrderSummary;
  items: FulfillmentItemCheck[];
  verdict: FulfillmentVerdict;
  summary: string;
}

/**
 * 订单履约核查（G-P0-6，Shopify 的真实业务流程）：订单详情 → 行项目 →
 * 按库存项 id 查库存水平 → 逐项核对“可售 ≥ 要发”。
 * - 订单已取消：verdict cancelled，逐项不核（发了也是错）。
 * - 发货状态已是 fulfilled：verdict already-fulfilled，逐项不核（不用再发）。
 * - 行项目没有 inventory_item_id、或库存接口没返回该项：available 记 null、
 *   该项 ok=false（无法核查按缺货算，fail-closed），不静默跳过。
 * 只读：不改订单状态、不动库存。
 */
export async function checkOrderFulfillment(client: ShopifyApiClient, orderId: string): Promise<FulfillmentCheck> {
  const { order, lineItems } = await client.getOrderDetail(orderId);
  if (order.cancelledAt) {
    return { order, items: [], verdict: "cancelled", summary: `订单 ${order.name || order.id} 已取消（${order.cancelledAt}），不发货。` };
  }
  if (order.fulfillmentStatus === "fulfilled") {
    return { order, items: [], verdict: "already-fulfilled", summary: `订单 ${order.name || order.id} 已发货，无需再核。` };
  }
  const itemIds = lineItems.filter((i) => i.inventoryItemId !== undefined).map((i) => i.inventoryItemId as number);
  const levels = itemIds.length
    ? (await client.listInventoryLevels({ inventoryItemIds: itemIds, limit: SHOPIFY_MAX_PAGE_LIMIT })).levels
    : [];
  const availableByItem = new Map<number, number>();
  for (const l of levels) {
    if (l.available !== null && !availableByItem.has(l.inventoryItemId)) availableByItem.set(l.inventoryItemId, l.available);
  }
  const items: FulfillmentItemCheck[] = lineItems.map((lineItem) => {
    const required = lineItem.quantity;
    if (lineItem.inventoryItemId === undefined) {
      return { lineItem, required, available: null, ok: false, note: "没有库存项 id，无法核查库存" };
    }
    const available = availableByItem.get(lineItem.inventoryItemId) ?? null;
    if (available === null) {
      return { lineItem, required, available: null, ok: false, note: "库存接口没返回该项" };
    }
    if (available < required) {
      return { lineItem, required, available, ok: false, note: `缺 ${required - available} 件` };
    }
    return { lineItem, required, available, ok: true };
  });
  const short = items.filter((i) => !i.ok);
  if (!short.length) {
    return { order, items, verdict: "fulfillable", summary: `订单 ${order.name || order.id} 可以发货：${items.length} 项商品库存都够。` };
  }
  return {
    order,
    items,
    verdict: "short",
    summary: `订单 ${order.name || order.id} 现在发不了：${short.map((i) => `${i.lineItem.title || `商品 ${i.lineItem.id}`}（${i.note ?? `要 ${i.required}、有 ${i.available ?? "未知"}`}）`).join("；")}。`,
  };
}

/** 履约核查格式化（纯文本：逐项一行 + 结论一行）。 */
export function formatFulfillmentCheck(check: FulfillmentCheck): string {
  const lines = [
    `订单：${check.order.name || check.order.id}（${check.order.totalPrice || "?"} ${check.order.currency || ""}，付款：${check.order.financialStatus || "未知"}，发货：${check.order.fulfillmentStatus || "未知"}）`,
  ];
  for (const item of check.items) {
    lines.push(`- ${item.lineItem.title || `商品 ${item.lineItem.id}`}：要 ${item.required} 件，可售 ${item.available ?? "未知"}${item.ok ? "（够）" : `（${item.note ?? "不够"}）`}`);
  }
  const verdictLabel = { fulfillable: "可以发货", short: "缺货、现在发不了", "already-fulfilled": "已发货", cancelled: "已取消" }[check.verdict];
  lines.push(`结论：${verdictLabel}——${check.summary}`);
  return lines.join("\n");
}

/** 商品列表格式化（纯文本，一行一个商品）。 */
export function formatShopifyProducts(products: ShopifyProductSummary[], nextPageInfo?: string): string {
  if (!products.length) return "没有找到商品。";
  const lines = products.map((p) => `[${p.id}] ${p.title || "（无标题）"}（${p.vendor || "未知品牌"}，${p.status || "未知状态"}，${p.variantCount} 个规格，库存 ${p.totalInventory}）`);
  if (nextPageInfo) lines.push(`（还有更多商品，翻页见 page_info=${nextPageInfo}）`);
  return lines.join("\n");
}

/** 订单列表格式化（纯文本，一行一个订单；不含任何客户信息）。 */
export function formatShopifyOrders(orders: ShopifyOrderSummary[], nextPageInfo?: string): string {
  if (!orders.length) return "没有找到订单。";
  const lines = orders.map((o) => `[${o.id}] ${o.name || "（无编号）"} ${o.totalPrice || "?"} ${o.currency || ""}（付款：${o.financialStatus || "未知"}，发货：${o.fulfillmentStatus || "未知"}，${o.lineItemsCount} 项商品，${o.createdAt || "未知时间"}）`);
  if (nextPageInfo) lines.push(`（还有更多订单，翻页见 page_info=${nextPageInfo}）`);
  return lines.join("\n");
}

/** 库存水平格式化（纯文本，一行一个地点-商品）。 */
export function formatShopifyInventoryLevels(levels: ShopifyInventoryLevel[], nextPageInfo?: string): string {
  if (!levels.length) return "没有找到库存记录。";
  const lines = levels.map((l) => `商品 ${l.inventoryItemId} @ 地点 ${l.locationId}：可售 ${l.available ?? "未知"}（${l.updatedAt || "未知时间"}）`);
  if (nextPageInfo) lines.push(`（还有更多记录，翻页见 page_info=${nextPageInfo}）`);
  return lines.join("\n");
}
