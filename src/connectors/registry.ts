// src/connectors/registry.ts — 缺口 44 第 0 批：连接器授权状态机 + 权限声明格式。
//
// 为什么要这个模块（学 AgentKit 的连接器目录模式，但按 Nyra 的规矩做）：
// - 每个连接器先声明它要什么权限、提供什么工具、会碰什么数据——批准时用户
//   看得到，不是点了同意才知道。声明缺失的连接器默认只读、每次使用都要重新
//   确认（fail-closed）。
// - 授权是状态机，不是布尔开关：未授权 / 已授权 / 已过期 / 已撤销四态；每
//   应用一次批准（首次使用须用户显式批准一次，之后同应用同用户不再重复问）；
//   每用户一次授权（按缺口 41 的账号隔离，owner 概念复用本机当前会话）；过
//   期自动标记并提示重新授权，不静默失败；撤销立即失效并记审计。
// - 令牌存放：只走本地密码箱（nyra vault / ~/.nyra/keys.json，0600），绝不建
//   任何第三方托管 vault、不把令牌发到任何外部服务——这是 AgentKit 调研里明
//   确不学的点，是硬边界。本模块只存 token 指纹（SHA-256 前 12 位），token
//   本身绝不进状态文件、审计与事件。
//
// 注意一个容易踩的坑：Gmail 的 expires_at 是 access_token 的过期时刻（约 1
// 小时），不是授权的过期——access token 过期靠 refresh token 自动换，不代
// 表授权失效。所以状态机不用 expires_at 驱动“已过期”：只有 refresh 失败
// （refresh token 坏了/被撤销）才标过期。expiresAt 只作展示。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "../memory.ts";
import { atomicWriteJson } from "../bot/dedupAndQuota.ts";
import { RunStore } from "../runs.ts";
import { EvidenceStore } from "../evidence.ts";

/** 授权四态：未授权 / 已授权 / 已过期 / 已撤销。 */
export type ConnectorAuthState = "unauthorized" | "authorized" | "expired" | "revoked";

export const CONNECTOR_AUTH_STATE_LABELS: Record<ConnectorAuthState, string> = {
  unauthorized: "未授权",
  authorized: "已授权",
  expired: "已过期",
  revoked: "已撤销",
};

/** 授权状态账本与审计文件（~/.nyra/ 下，0600、原子写，与其他账本同款写法）。 */
export const CONNECTOR_AUTH_FILE = "connector-auth.json";
export const CONNECTOR_AUDIT_FILE = "connector-audit.jsonl";

/** 未登录时的默认用户 id：本机单用户场景，授权记在 local 名下。 */
export const CONNECTOR_LOCAL_USER = "local";

/** 权限声明：每个连接器上架时必须声明的四件套（缺口 44 定义）。 */
export interface ConnectorPermissionDeclaration {
  id: string;
  displayName: string;
  description: string;
  /** available = 已接入可用；pilot = 目录里可见、尚未接入（下一批做深连接器时开放）。 */
  status: "available" | "pilot";
  /** 读/写范围列表（OAuth scope 或能力描述）。 */
  scopes: { read: string[]; write: string[] };
  /** 它提供的工具组（工具名 + 读写属性）。 */
  toolGroups: { name: string; tools: string[]; access: "read" | "write" }[];
  /** 它会访问的数据范围（给用户看的 plain 描述）。 */
  dataAccessed: string[];
  /** 永远须人批的写操作（工具名或动作名）。 */
  alwaysRequireApproval: string[];
  /** 永远禁做的操作（引用缺口 51 红线表；本批先写连接器自己的禁做清单）。 */
  alwaysForbidden: string[];
  /** 缺口 51：本连接器的默认红线表 id（见 src/businessRedlines.ts 的
   * DEFAULT_CONNECTOR_REDLINES；声明与执行共用同一张表，不各写一份）。 */
  redlineTable: string;
}

/** 连接器目录：先接 3 个做深（缺口 44 定义）。Gmail（缺口 6）与 Shopify
 * 只读（缺口 44 第一批）已接入；Slack 在缺口 44 第二批改为已接入（读 +
 * 发消息须批 + 审批卡）。试点连接器在目录里看得见、用不了，不假装已接通。 */
export const CONNECTOR_DECLARATIONS: ConnectorPermissionDeclaration[] = [
  {
    id: "gmail",
    displayName: "Gmail",
    description: "Google 邮箱：读信、按 thread 回复、代发草稿（缺口 6 已落地）；附件下载、标签、标已读、进回收站（缺口 44 第三批）；列草稿与发送草稿（G-P0-6 做深）。",
    status: "available",
    scopes: {
      read: ["https://www.googleapis.com/auth/gmail.readonly"],
      write: [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.compose",
        // 改标签、标已读、进回收站要 gmail.modify（缺口 44 第三批）。
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    },
    toolGroups: [
      { name: "读邮件", tools: ["gmail_search", "gmail_read"], access: "read" },
      { name: "发邮件", tools: ["gmail_send"], access: "write" },
      { name: "附件", tools: ["gmail_attachment"], access: "read" },
      { name: "标签", tools: ["gmail_labels", "gmail_label", "gmail_unlabel"], access: "write" },
      { name: "已读", tools: ["gmail_mark_read", "gmail_mark_unread"], access: "write" },
      { name: "回收站", tools: ["gmail_trash"], access: "write" },
    ],
    dataAccessed: ["邮件元数据（发件人、主题、时间、摘要）", "邮件正文（仅按 id 读取时）", "账号邮箱地址", "附件（文件名、大小；内容仅按 id 下载时）", "标签列表"],
    alwaysRequireApproval: ["gmail_send", "gmail_label", "gmail_unlabel", "gmail_mark_read", "gmail_mark_unread", "gmail_trash"],
    alwaysForbidden: ["批量群发（一次只发一封）", "永久删除邮件（只支持进回收站）", "转发给外部", "改他人标签", "越权访问他人邮箱"],
    redlineTable: "gmail",
  },
  {
    id: "shopify",
    displayName: "Shopify",
    description: "用户自己的 Hollow & Scale 店铺：查商品、订单、库存（只读起步，缺口 44 第一批；不做任何写操作）；订单履约核查（订单详情 + 行项目 + 库存逐项核对，G-P0-6 做深，只读）。",
    status: "available",
    scopes: {
      read: ["read_products", "read_orders", "read_inventory"],
      // 本批只读：写 scope 故意留空——任何写操作在调 API 之前就拒绝，
      // 不存在“已声明写权限但没用上”的灰色地带。
      write: [],
    },
    toolGroups: [
      { name: "商品", tools: ["shopify_products"], access: "read" },
      { name: "订单", tools: ["shopify_orders"], access: "read" },
      { name: "库存", tools: ["shopify_inventory"], access: "read" },
    ],
    dataAccessed: ["店铺商品（标题、价格、库存数）", "订单（编号、金额、状态，不含客户邮箱与地址）", "库存水平（按地点与商品）"],
    alwaysRequireApproval: ["改价", "改库存", "下单", "退款", "发折扣码"],
    alwaysForbidden: ["改价", "改库存", "退款", "下单", "删单", "改客户支付信息"],
    redlineTable: "shopify",
  },
  {
    id: "slack",
    displayName: "Slack",
    description: "团队消息与审批卡的落点：读频道/消息、发消息（须显式批准）、发审批卡（缺口 44 第二批）；审批卡按钮回调回写审批桥（G-P0-6 做深）。",
    status: "available",
    scopes: {
      read: ["channels:read", "channels:history"],
      write: ["chat:write"],
    },
    toolGroups: [
      { name: "频道", tools: ["slack_channels", "slack_history"], access: "read" },
      { name: "发消息", tools: ["slack_send"], access: "write" },
      { name: "审批卡", tools: ["slack_approval_card"], access: "write" },
    ],
    dataAccessed: ["频道列表（频道名、成员数）", "频道消息（消息文本、发送者 id、时间）", "workspace 名称"],
    alwaysRequireApproval: ["发消息", "发审批卡"],
    alwaysForbidden: ["删消息", "改频道", "管理成员", "删 workspace 数据"],
    redlineTable: "slack",
  },
];

export function getDeclaration(connectorId: string): ConnectorPermissionDeclaration | undefined {
  return CONNECTOR_DECLARATIONS.find((d) => d.id === connectorId);
}

export function listDeclarations(): ConnectorPermissionDeclaration[] {
  return [...CONNECTOR_DECLARATIONS];
}

/** 生效权限：声明缺失的连接器默认只读、且每次使用都要重新确认（fail-closed）。 */
export interface EffectivePermissions {
  readOnly: boolean;
  requireConfirmEveryUse: boolean;
  declaration?: ConnectorPermissionDeclaration;
}

export function effectivePermissions(connectorId: string): EffectivePermissions {
  const declaration = getDeclaration(connectorId);
  if (!declaration) return { readOnly: true, requireConfirmEveryUse: true };
  return { readOnly: false, requireConfirmEveryUse: false, declaration };
}

/** 单向指纹：SHA-256 前 12 位——审计与事件里只记它，原文不可还原；12 位也
 * 免得被 appendEvent 的 redact 当 ≥32 字长词串掩掉（与 approvalArgsHash 同款）。 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex").slice(0, 12);
}

export function scopesFingerprint(scopes: string): string {
  return createHash("sha256").update(scopes, "utf-8").digest("hex").slice(0, 12);
}

export interface ConnectorAuthRecord {
  connectorId: string;
  userId: string;
  state: ConnectorAuthState;
  /** 批准时刻（ISO）；迁移沿用的记迁移时刻。 */
  approvedAt?: string;
  approvedBy?: string;
  /** refresh token 的指纹（12 位），不是 token 本身。 */
  tokenFingerprint?: string;
  /** 授权时拿到的 scope 串（只作展示）。 */
  scopes?: string;
  /** 沿用已有授权迁移而来（首次跑本批代码时，已跑过 nyra gmail auth 的用户不打断）。 */
  migratedFrom?: string;
  /** expired/revoked 的原因（短句，不含敏感信息）。 */
  reason?: string;
  updatedAt: string;
}

interface ConnectorAuthFile {
  version: 1;
  records: Record<string, ConnectorAuthRecord>;
}

function recordKey(userId: string, connectorId: string): string {
  return `${userId}:${connectorId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 本机当前用户 id：缺口 41 的本机当前会话（account-session.json）里的
 * account_id；没登录时记 local。只读会话文件、不验 token——状态账本本身就
 * 在本机，验 token 是登录层的事，这里不越权。 */
export function resolveConnectorUserId(home: string): string {
  try {
    const raw = readFileSync(join(resolveNyraHome(home), "account-session.json"), "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.account_id === "string" && data.account_id) return data.account_id;
  } catch {
    /* 没有会话文件或损坏都按未登录处理 */
  }
  return CONNECTOR_LOCAL_USER;
}

/** 重新授权的入口提示（按连接器给不同的命令）。 */
export function reauthHint(connectorId: string): string {
  if (connectorId === "gmail") return "nyra gmail auth";
  if (connectorId === "slack") return "nyra slack auth";
  return `nyra connector approve ${connectorId}`;
}

export class ConnectorAuthStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  load(): ConnectorAuthFile {
    try {
      const raw = readFileSync(join(resolveNyraHome(this.home), CONNECTOR_AUTH_FILE), "utf-8");
      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== "object") return { version: 1, records: {} };
      const records = (data as ConnectorAuthFile).records;
      if (!records || typeof records !== "object") return { version: 1, records: {} };
      return { version: 1, records };
    } catch {
      return { version: 1, records: {} };
    }
  }

  save(file: ConnectorAuthFile): void {
    atomicWriteJson(this.home, CONNECTOR_AUTH_FILE, file);
  }

  get(connectorId: string, userId: string): ConnectorAuthRecord | null {
    return this.load().records[recordKey(userId, connectorId)] ?? null;
  }

  set(record: ConnectorAuthRecord): void {
    const file = this.load();
    file.records[recordKey(record.userId, record.connectorId)] = record;
    this.save(file);
  }

  allForUser(userId: string): ConnectorAuthRecord[] {
    return Object.values(this.load().records).filter((r) => r.userId === userId);
  }
}

export type ConnectorAuditAction = "authorized" | "expired" | "revoked" | "approved" | "denied" | "call" | "installed" | "uninstalled";

/** 审计：只记动作、连接器、用户、指纹与原因，不记邮箱、不记 token、不记 scope 原文。
 * "call" 是连接器的调用日志（缺口 44 第一批）：只记操作名、记录数、耗时，
 * 不记响应内容、不记客户信息。 */
export function appendConnectorAudit(
  home: string,
  entry: {
    action: ConnectorAuditAction;
    connector: string;
    userId: string;
    tokenFingerprint?: string;
    reason?: string;
    migrated?: boolean;
    operation?: string;
    records?: number;
    durationMs?: number;
  },
): void {
  const line = JSON.stringify({
    ts: nowIso(),
    action: entry.action,
    connector: entry.connector,
    user_id: entry.userId,
    ...(entry.tokenFingerprint ? { token_fingerprint: entry.tokenFingerprint } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.migrated ? { migrated: true } : {}),
    ...(entry.operation ? { operation: entry.operation } : {}),
    ...(entry.records !== undefined ? { records: entry.records } : {}),
    ...(entry.durationMs !== undefined ? { duration_ms: entry.durationMs } : {}),
  });
  const path = join(resolveNyraHome(home), CONNECTOR_AUDIT_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* 审计写不进去不拦授权本身（与 accounts-audit 同款） */
  }
}

/**
 * 授权事件落点（与 recordBotEvent 同款回落）：有对应运行目录 → 该运行的
 * events.jsonl；没有 → evidence/connector/ 下的证据文件；两路都失败 → "none"。
 */
export function recordConnectorEvent(
  home: string,
  runId: string | null,
  type: "connector_authorized" | "connector_expired" | "connector_revoked" | "connector_installed" | "connector_uninstalled" | "connector_call",
  fields: Record<string, unknown>,
): "events" | "evidence" | "none" {
  const nyraHome = resolveNyraHome(home);
  if (runId) {
    for (const sub of ["runs", "tasks"]) {
      const base = join(nyraHome, sub);
      if (!existsSync(join(base, runId))) continue;
      try {
        new RunStore(base).appendEvent(runId, type, fields);
        return "events";
      } catch {
        /* 该 store 写失败就试下一个；都失败再走证据文件 */
      }
    }
  }
  try {
    const id = String(fields.connector ?? "unknown");
    new EvidenceStore(join(nyraHome, "evidence"), "connector").save(
      type,
      `connector://${id}`,
      `${type} ${id} ${JSON.stringify(fields)}`,
    );
    return "evidence";
  } catch {
    return "none";
  }
}

export interface ConnectorUsableEvidence {
  /** 密码箱里已有该连接器的凭证（迁移沿用的依据）。 */
  hasTokens: boolean;
  tokenFingerprint?: string;
  scopes?: string;
}

export type ConnectorUsableResult =
  | { ok: true; record: ConnectorAuthRecord }
  | { ok: false; state: ConnectorAuthState; message: string };

function displayName(connectorId: string): string {
  return getDeclaration(connectorId)?.displayName ?? connectorId;
}

/**
 * 使用前检查（每次真实调用连接器前过一遍）：
 * - 有记录：authorized 放行；expired/revoked/unauthorized 拒绝并给重授权入口。
 * - 没记录：密码箱里已有凭证 → 沿用已有授权迁移为 authorized（不打断已授权
 *   的用户，迁移记进审计）；没凭证 → 未授权，须显式批准一次。
 * 只返回结论、不抛错，调用方按结论决定是放行还是报“请重新授权”。
 */
export function ensureConnectorUsable(
  home: string,
  connectorId: string,
  userId: string,
  evidence?: ConnectorUsableEvidence,
): ConnectorUsableResult {
  const store = new ConnectorAuthStore(home);
  const existing = store.get(connectorId, userId);
  if (existing) {
    if (existing.state === "authorized") return { ok: true, record: existing };
    if (existing.state === "expired") {
      return { ok: false, state: "expired", message: `连接器 ${displayName(connectorId)} 的授权已过期，请重新授权（${reauthHint(connectorId)}）` };
    }
    if (existing.state === "revoked") {
      return { ok: false, state: "revoked", message: `连接器 ${displayName(connectorId)} 的授权已被撤销，请重新授权（${reauthHint(connectorId)}）` };
    }
    return { ok: false, state: "unauthorized", message: `尚未批准使用 ${displayName(connectorId)}：请先运行 nyra connector approve ${connectorId}` };
  }
  if (evidence?.hasTokens) {
    const record: ConnectorAuthRecord = {
      connectorId,
      userId,
      state: "authorized",
      approvedAt: nowIso(),
      approvedBy: userId,
      ...(evidence.tokenFingerprint ? { tokenFingerprint: evidence.tokenFingerprint } : {}),
      ...(evidence.scopes ? { scopes: evidence.scopes } : {}),
      migratedFrom: "existing-credentials",
      updatedAt: nowIso(),
    };
    store.set(record);
    appendConnectorAudit(home, { action: "authorized", connector: connectorId, userId, tokenFingerprint: evidence.tokenFingerprint, migrated: true });
    recordConnectorEvent(home, null, "connector_authorized", {
      connector: connectorId,
      user_id: userId,
      ...(evidence.scopes ? { scopes_hash: scopesFingerprint(evidence.scopes) } : {}),
    });
    return { ok: true, record };
  }
  return { ok: false, state: "unauthorized", message: `尚未批准使用 ${displayName(connectorId)}：请先运行 nyra connector approve ${connectorId}` };
}

/** 只读看一眼当前状态（不写账本、不迁移）：status 命令与 getGmailStatus 用。 */
export function peekConnectorState(
  home: string,
  connectorId: string,
  userId: string,
  evidence?: { hasTokens: boolean },
): ConnectorAuthState {
  const existing = new ConnectorAuthStore(home).get(connectorId, userId);
  if (existing) return existing.state;
  return evidence?.hasTokens ? "authorized" : "unauthorized";
}

/** 显式批准一次（CLI approve / 授权成功后调用）：同应用同用户只记一次，
 * 重复批准是幂等的（只刷新时间戳，不改状态语义）。 */
export function markConnectorAuthorized(
  home: string,
  connectorId: string,
  userId: string,
  opts?: { tokenFingerprint?: string; scopes?: string; runId?: string | null },
): ConnectorAuthRecord {
  const store = new ConnectorAuthStore(home);
  const record: ConnectorAuthRecord = {
    connectorId,
    userId,
    state: "authorized",
    approvedAt: nowIso(),
    approvedBy: userId,
    ...(opts?.tokenFingerprint ? { tokenFingerprint: opts.tokenFingerprint } : {}),
    ...(opts?.scopes ? { scopes: opts.scopes } : {}),
    updatedAt: nowIso(),
  };
  store.set(record);
  appendConnectorAudit(home, { action: "approved", connector: connectorId, userId, tokenFingerprint: opts?.tokenFingerprint });
  recordConnectorEvent(home, opts?.runId ?? null, "connector_authorized", {
    connector: connectorId,
    user_id: userId,
    ...(opts?.scopes ? { scopes_hash: scopesFingerprint(opts.scopes) } : {}),
  });
  return record;
}

/** 标过期：只从 authorized 转 expired（已撤销的不覆盖；没记录的不新建——
 * 没记录时调用方本来就该走“未授权”那条路）。refresh 失败时由调用方尽力调。 */
export function markConnectorExpired(
  home: string,
  connectorId: string,
  userId: string,
  reason: string,
  runId?: string | null,
): ConnectorAuthRecord | null {
  const store = new ConnectorAuthStore(home);
  const existing = store.get(connectorId, userId);
  if (!existing || existing.state !== "authorized") return null;
  const record: ConnectorAuthRecord = { ...existing, state: "expired", reason, updatedAt: nowIso() };
  store.set(record);
  appendConnectorAudit(home, { action: "expired", connector: connectorId, userId, tokenFingerprint: existing.tokenFingerprint, reason });
  recordConnectorEvent(home, runId ?? null, "connector_expired", { connector: connectorId, user_id: userId, reason });
  return record;
}

/** 撤销：立即失效（状态一写，之后每次 ensure 都拒绝）；没记录时也建一条
 * revoked 记录，堵住“没记录 + 密码箱有凭证 → 迁移沿用”那条路。 */
export function markConnectorRevoked(
  home: string,
  connectorId: string,
  userId: string,
  runId?: string | null,
): ConnectorAuthRecord {
  const store = new ConnectorAuthStore(home);
  const existing = store.get(connectorId, userId);
  const record: ConnectorAuthRecord = {
    connectorId,
    userId,
    state: "revoked",
    ...(existing?.approvedAt ? { approvedAt: existing.approvedAt } : {}),
    ...(existing?.approvedBy ? { approvedBy: existing.approvedBy } : {}),
    ...(existing?.tokenFingerprint ? { tokenFingerprint: existing.tokenFingerprint } : {}),
    ...(existing?.scopes ? { scopes: existing.scopes } : {}),
    updatedAt: nowIso(),
  };
  store.set(record);
  appendConnectorAudit(home, { action: "revoked", connector: connectorId, userId, tokenFingerprint: existing?.tokenFingerprint });
  recordConnectorEvent(home, runId ?? null, "connector_revoked", { connector: connectorId, user_id: userId });
  return record;
}
