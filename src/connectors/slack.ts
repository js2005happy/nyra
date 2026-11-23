// src/connectors/slack.ts — 原生业务连接器：Slack（缺口 44 第二批，读 + 发消息须批 + 审批卡）。
//
// 设计（见 docs/connectors.md 的 Slack 一节）：
// - 读：频道列表（conversations.list）/ 消息历史（conversations.history），
//   单页默认 50、上限 250，与 Shopify 同口径，防一次拉全库。
// - 写：本批唯一的写操作是发消息（chat.postMessage），必须显式批准——
//   连接器声明里标“永远须人批”，CLI 上 `nyra slack send` 没给 --yes 又没
//   在交互确认里答 y 就拒绝（默认不发）；删消息、改频道、管理成员一律在调
//   API 之前就拒绝，本批连写入口都不提供。
// - 审批卡落点：把 Bot Phase 2 的挂起审批（PendingApproval）拼成 Block Kit
//   消息发到指定频道，带 Approve / Reject 两个按钮；按钮回调由
//   resolveSlackApprovalCallback 回写进 ApprovalBridge（G-P0-6 做深，
//   缺口 44 第二批只解析不回写的那一步这批接上了）——回写只认 owner/admin
//   白名单，重复回调幂等（已处理过的审批不再解决）。
// - 凭证：Slack app 的 Bot token（xoxb-…）+ workspace 名，用户在 Slack
//   后台建 app、把 token 粘贴进密码箱（nyra slack auth 交互输入，只存密码
//   箱）。localhost 没有公网回调，做不了 Slack OAuth 回环，所以本批不走
//   OAuth 授权码流程——这点写进文档，不假装是 OAuth。
// - 每次调用走授权状态机（registry 的 ensureConnectorUsable）：未授权 /
//   过期 / 已撤销一律拦在门外；invalid_auth 说明 token 死了（被撤销/被轮
//   换），标过期。审计：每次调用记一行 connector-audit.jsonl，只记操作名、
//   记录数、耗时，不记 token、不记消息内容。
// - 不引新依赖：只用全局 fetch 调 Slack Web API。
import { getCredential, Vault, vaultPath } from "../vault.ts";
import type { ApprovalBridge } from "../bot/approvalBridge.ts";
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

/** Slack Web API 根地址（固定，不接受调用方传入任意 URL）。 */
export const SLACK_API_BASE = "https://slack.com/api";
/** 密码箱条目名：Bot token + workspace 名一条（名字明文、值加密，见 vault.ts）。 */
export const SLACK_VAULT_CREDENTIALS_ENTRY = "slack-credentials";
/** 读权限（Bot token 须勾的 scope；写权限只有 chat:write 一个）。 */
export const SLACK_READ_SCOPES = ["channels:read", "channels:history"];
export const SLACK_WRITE_SCOPES = ["chat:write"];
/** 单页默认条数 / 硬顶（与 Shopify 同口径，防一次拉全库）。 */
export const SLACK_DEFAULT_PAGE_LIMIT = 50;
export const SLACK_MAX_PAGE_LIMIT = 250;
/** 单次 API 请求超时（毫秒）。 */
export const SLACK_REQUEST_TIMEOUT_MS = 30_000;
/** 审批卡按钮回调的 value 前缀（Slack block_actions 的 value 上限 2000 字，够用）。 */
export const SLACK_APPROVAL_CALLBACK_PREFIX = "slack:";

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackError";
  }
}

/** 授权失效（token 被撤销/被轮换）：唯一的出路是重新跑 nyra slack auth。 */
export class SlackAuthError extends SlackError {
  constructor(message: string) {
    super(message);
    this.name = "SlackAuthError";
  }
}

export interface SlackCredentials {
  token: string;
  /** workspace 名（只作展示，如 "hollow-scale"；没有也不影响调用）。 */
  team?: string;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  memberCount: number;
}

export interface SlackMessageSummary {
  /** 消息时间戳（Slack 里的唯一 id，如 "1730000000.000100"）。 */
  ts: string;
  channelId: string;
  userId: string;
  text: string;
  /** 所属 thread 的根消息 ts（没有就是顶层消息）。 */
  threadTs?: string;
}

/** 本批一律拒绝的写操作（CLI 上撞见这些词也直接回拒绝，不进 API）。 */
export const SLACK_WRITE_COMMANDS = [
  "delete-message", "update-channel", "create-channel", "archive-channel",
  "invite", "kick", "remove-member", "delete-channel",
] as const;
export const SLACK_FORBIDDEN_OPERATIONS = ["删消息", "改频道", "管理成员", "删 workspace 数据"];

export function slackWriteRefusal(operation: string): string {
  return `Slack 连接器本批不做「${operation}」：删消息、改频道、管理成员、删 workspace 数据一律拒绝——本批唯一的写操作是发消息，且须显式批准。`;
}

export function refuseSlackWrite(operation: string): never {
  throw new SlackError(slackWriteRefusal(operation));
}

/** Bot token 校验：Slack app 的 Bot token 以 xoxb- 开头。 */
export function isSlackBotToken(token: string): boolean {
  return token.startsWith("xoxb-") && token.length > 5;
}

/** 密码箱里静默读凭证：无箱、无密码、密码错、条目缺失、内容损坏、token
 * 不合法一律返回 null，不抛错。token 原文只在内存里，调用方绝不能把它写进日志。 */
export function loadSlackCredentials(home: string): SlackCredentials | null {
  const raw = getCredential(SLACK_VAULT_CREDENTIALS_ENTRY, home);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.token !== "string") return null;
    const token = data.token.trim();
    if (!isSlackBotToken(token)) return null;
    const team = typeof data.team === "string" && data.team.trim() ? data.team.trim() : undefined;
    return { token, ...(team ? { team } : {}) };
  } catch {
    return null;
  }
}

/** 密码箱里有没有 slack-credentials 条目（只看条目名，不用解锁——status 能直接报）。 */
export function hasSlackCredentialsEntry(home: string): boolean {
  try {
    return new Vault(vaultPath(home)).listNames().includes(SLACK_VAULT_CREDENTIALS_ENTRY);
  } catch {
    return false;
  }
}

export function resolveSlackEnabled(config: Record<string, unknown>): boolean {
  const section = (config as { connectors?: unknown }).connectors;
  if (!section || typeof section !== "object") return false;
  const slack = (section as { slack?: unknown }).slack;
  if (!slack || typeof slack !== "object") return false;
  return (slack as { enabled?: unknown }).enabled === true;
}

export interface SlackConnectorStatus {
  /** config.connectors.slack.enabled：默认关，显式开才可用。 */
  enabled: boolean;
  /** 密码箱里有凭证条目（只看条目名、不解密；内容损坏时工具调用仍会报错）。 */
  configured: boolean;
  team?: string;
  /** 缺口 44 第 0 批：授权状态机的当前状态（只读看一眼，不写账本、不迁移）。 */
  authState: ConnectorAuthState;
}

export function getSlackStatus(home: string, config: Record<string, unknown>): SlackConnectorStatus {
  const enabled = resolveSlackEnabled(config);
  const creds = loadSlackCredentials(home);
  const hasEntry = hasSlackCredentialsEntry(home);
  return {
    enabled,
    configured: hasEntry,
    ...(creds?.team ? { team: creds.team } : {}),
    // 密码箱里有条目就算“已授权”的候选：首次调用 createSlackClient 时
    // 会沿用已有授权正式记一笔；这里只读，不写账本。
    authState: peekConnectorState(home, "slack", resolveConnectorUserId(home), { hasTokens: hasEntry }),
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function clampLimit(limit?: number): number {
  const n = Math.floor(limit ?? SLACK_DEFAULT_PAGE_LIMIT);
  if (!Number.isFinite(n) || n < 1) return SLACK_DEFAULT_PAGE_LIMIT;
  return Math.min(n, SLACK_MAX_PAGE_LIMIT);
}

/** 频道 id 只接受 Slack 的 id 格式（大写字母 + 数字，如 C0123456789），
 * 用户输入永远拼不成越界路径或别的参数。 */
export function isSlackChannelId(id: string): boolean {
  return /^[A-Z0-9]+$/.test(id);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 频道只取展示字段：id、名字、是否私密、成员数。 */
export function parseChannelSummary(data: unknown): SlackChannelSummary | null {
  const d = asRecord(data);
  if (!d || typeof d.id !== "string" || !d.id) return null;
  return {
    id: d.id,
    name: asString(d.name),
    isPrivate: d.is_private === true,
    memberCount: typeof d.num_members === "number" ? d.num_members : 0,
  };
}

/** 消息只取展示字段：ts、频道、发送者、文本、thread 根 ts。 */
export function parseMessageSummary(data: unknown, channelId: string): SlackMessageSummary | null {
  const d = asRecord(data);
  if (!d || typeof d.ts !== "string" || !d.ts) return null;
  return {
    ts: d.ts,
    channelId,
    userId: asString(d.user),
    text: asString(d.text),
    ...(typeof d.thread_ts === "string" && d.thread_ts ? { threadTs: d.thread_ts } : {}),
  };
}

/**
 * Slack Web API 传输层：只调固定 host（slack.com/api），不接受调用方传入
 * 任意 URL；token 只放 Authorization 头，绝不进 URL、日志与报错。
 * ok:false 时：invalid_auth 说明 token 死了（被撤销/被轮换），标过期；
 * ratelimited 报“限流、稍后再试”；其余按 error 字段原样报。
 * 每次调用记一行审计：只记操作名、记录数、耗时，不记 token、不记消息内容。
 */
export class SlackApiClient {
  private readonly credentials: SlackCredentials;
  private readonly home: string;
  private readonly userId: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: { credentials: SlackCredentials; home: string; userId: string; fetchFn?: FetchFn }) {
    this.credentials = opts.credentials;
    this.home = opts.home;
    this.userId = opts.userId;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** 当前 workspace 名（状态展示用；token 绝不能从这里出去）。 */
  team(): string | undefined {
    return this.credentials.team;
  }

  private audit(operation: string, records: number, startedAt: number, reason?: string): void {
    appendConnectorAudit(this.home, {
      action: "call",
      connector: "slack",
      userId: this.userId,
      operation,
      records,
      durationMs: Date.now() - startedAt,
      ...(reason ? { reason } : {}),
    });
    // 缺口 44 第一批：调用计数进用量账本与运行记录（最佳努力，记不上不拦调用）。
    recordConnectorCall(this.home, { connector: "slack", operation, records, durationMs: Date.now() - startedAt, userId: this.userId });
  }

  private async callApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(`${SLACK_API_BASE}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new SlackError(`Slack 请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new SlackError(`Slack 请求失败：HTTP ${res.status}`);
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new SlackError("Slack 返回了无法识别的内容");
    }
    if (data.ok !== true) {
      const code = typeof data.error === "string" ? data.error : "unknown_error";
      if (code === "invalid_auth") {
        // token 死了：标过期，下次调用直接报“请重新授权”，不再拿死 token 反复试。
        try { markConnectorExpired(this.home, "slack", this.userId, "Bot token 失效（被撤销/被轮换）"); } catch { /* 标过期失败不改变调用失败本身 */ }
        throw new SlackAuthError("Slack 授权已过期：Bot token 失效，请重新运行 nyra slack auth（并确认 Slack app 的 Bot token 还在）");
      }
      if (code === "ratelimited") throw new SlackError("Slack 限流：请求太频繁，请稍后再试");
      throw new SlackError(`Slack 返回错误：${code}`);
    }
    return data;
  }

  /** 频道列表（分页：response_metadata.next_cursor；默认 50、上限 250）。 */
  async listChannels(opts?: { limit?: number; cursor?: string }): Promise<{ channels: SlackChannelSummary[]; nextCursor?: string }> {
    const startedAt = Date.now();
    const data = await this.callApi("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: clampLimit(opts?.limit),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    });
    const channels = asArray(data.channels).map(parseChannelSummary).filter((c): c is SlackChannelSummary => c !== null);
    this.audit("list_channels", channels.length, startedAt);
    const next = asRecord(data.response_metadata)?.next_cursor;
    return { channels, ...(typeof next === "string" && next ? { nextCursor: next } : {}) };
  }

  /** 某频道的消息历史（分页同上；text 只作展示，调用方不得把它写进审计）。 */
  async getHistory(channelId: string, opts?: { limit?: number; cursor?: string }): Promise<{ messages: SlackMessageSummary[]; nextCursor?: string }> {
    if (!isSlackChannelId(channelId)) throw new SlackError(`频道 id 不合法：${channelId}（只接受 Slack 的频道 id，如 C0123456789）`);
    const startedAt = Date.now();
    const data = await this.callApi("conversations.history", {
      channel: channelId,
      limit: clampLimit(opts?.limit),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    });
    const messages = asArray(data.messages).map((m) => parseMessageSummary(m, channelId)).filter((m): m is SlackMessageSummary => m !== null);
    this.audit("get_history", messages.length, startedAt);
    const next = asRecord(data.response_metadata)?.next_cursor;
    return { messages, ...(typeof next === "string" && next ? { nextCursor: next } : {}) };
  }

  /**
   * 发消息到指定频道（本批唯一的写操作）：调用方（CLI）必须先拿到显式批准
   * 再调这里——本层只管发，不管批。返回消息 ts（审批卡与后续编辑靠它认消息）。
   */
  async postMessage(channelId: string, text: string, blocks?: unknown[]): Promise<{ ts: string; channel: string }> {
    if (!isSlackChannelId(channelId)) throw new SlackError(`频道 id 不合法：${channelId}（只接受 Slack 的频道 id，如 C0123456789）`);
    if (!text.trim()) throw new SlackError("消息内容不能为空");
    const startedAt = Date.now();
    const data = await this.callApi("chat.postMessage", {
      channel: channelId,
      text,
      ...(blocks ? { blocks } : {}),
    });
    const ts = asString(data.ts);
    if (!ts) throw new SlackError("Slack 没有返回消息时间戳");
    this.audit("post_message", 1, startedAt, "explicit-approval");
    return { ts, channel: channelId };
  }

  /** 发审批卡：把一条挂起审批拼成 Block Kit 消息发到指定频道。 */
  async postApprovalCard(channelId: string, approval: SlackApprovalInput): Promise<{ ts: string; channel: string }> {
    const { text, blocks } = buildApprovalCard(approval);
    return this.postMessage(channelId, text, blocks);
  }

  /** 探一下 token 是否有效（auth.test）：返回 workspace 名与用户名；401
   * 的 token 不存（调用方直接报错），网络不通抛错（调用方只警告）。 */
  async probeAuth(): Promise<{ team: string; user: string }> {
    const data = await this.callApi("auth.test", {});
    return { team: asString(data.team), user: asString(data.user) };
  }
}

/**
 * 建一个能用的 Slack 客户端：未启用、没配凭证、没批准时直接抛错，
 * 调用方把错误原样告诉用户（里面已经写清下一步该跑什么命令）。
 * 缺口 44 第 0 批的门禁：建之前先过授权状态机——已过期/已撤销/未批准的
 * 一律拦在门外（fail-closed）；密码箱里已有凭证但状态账本还没记录的，
 * 沿用已有授权迁移为已授权（不打断已跑过 nyra slack auth 的用户）。
 * fetchFn 只供测试注入；生产永远用全局 fetch。
 */
export function createSlackClient(home: string, config: Record<string, unknown>, opts?: { fetchFn?: FetchFn }): SlackApiClient {
  if (!resolveSlackEnabled(config)) {
    throw new SlackError("Slack 连接器未启用：先运行 nyra slack auth 完成授权（授权成功会自动启用）");
  }
  const creds = loadSlackCredentials(home);
  if (!creds) throw new SlackAuthError("Slack 未授权：密码箱里没有凭证，请运行 nyra slack auth");
  const userId = resolveConnectorUserId(home);
  const usable = ensureConnectorUsable(home, "slack", userId, {
    hasTokens: true,
    tokenFingerprint: tokenFingerprint(creds.token),
    scopes: [...SLACK_READ_SCOPES, ...SLACK_WRITE_SCOPES].join(","),
  });
  if (!usable.ok) throw new SlackAuthError(usable.message);
  return new SlackApiClient({ credentials: creds, home, userId, fetchFn: opts?.fetchFn });
}

/** 频道列表格式化（纯文本，一行一个频道）。 */
export function formatSlackChannels(channels: SlackChannelSummary[], nextCursor?: string): string {
  if (!channels.length) return "没有找到频道。";
  const lines = channels.map((c) => `[${c.id}] #${c.name || "（无名）"}${c.isPrivate ? "（私密）" : ""}（${c.memberCount} 人）`);
  if (nextCursor) lines.push(`（还有更多频道，翻页见 cursor=${nextCursor}）`);
  return lines.join("\n");
}

/** 消息历史格式化（纯文本，一行一条消息；text 原样展示，不进审计）。 */
export function formatSlackMessages(messages: SlackMessageSummary[], nextCursor?: string): string {
  if (!messages.length) return "没有找到消息。";
  const lines = messages.map((m) => `[${m.ts}] <${m.userId || "未知"}>${m.threadTs ? `（回复 ${m.threadTs}）` : ""} ${m.text}`);
  if (nextCursor) lines.push(`（还有更多消息，翻页见 cursor=${nextCursor}）`);
  return lines.join("\n");
}

/** 审批卡的输入：只取 Bot Phase 2 挂起审批（PendingApproval）的展示字段，
 * 不取 token、不取参数原文（argsHash 是单向指纹，不可还原）。 */
export interface SlackApprovalInput {
  id: string;
  tool: string;
  summary: string;
  argsHash: string;
  requestedBy: string;
  /** 过期时刻（毫秒时间戳；已过期时卡上写明，按钮仍可点、回调方再判）。 */
  expiresAt: number;
  /** 现在（毫秒时间戳；测试可注入，生产用 Date.now()）。 */
  now?: number;
}

/** 审批卡文案（纯文本版，发消息时当 text 用；blocks 里也有一份）。 */
export function formatApprovalCardText(approval: SlackApprovalInput): string {
  const now = approval.now ?? Date.now();
  const expired = approval.expiresAt <= now;
  const lines = [
    "待审批：",
    `工具：${approval.tool}`,
    `说明：${approval.summary}`,
    `参数指纹：${approval.argsHash}`,
    `申请人：${approval.requestedBy}`,
    expired ? "状态：已过期（点按钮也会被拒绝）" : `有效期至：${new Date(approval.expiresAt).toISOString()}`,
  ];
  return lines.join("\n");
}

/**
 * 审批卡 Block Kit（纯函数，可测）：section 写清待批事项 + actions 放两个
 * 按钮（批准 / 拒绝）。按钮 value 只带审批 id 与结论，不带 token、不带
 * 参数原文；回调方按 value 认出是哪条审批、什么结论。
 */
export function buildApprovalCard(approval: SlackApprovalInput): { text: string; blocks: unknown[] } {
  const text = formatApprovalCardText(approval);
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*待审批*\n工具：${approval.tool}\n说明：${approval.summary}\n参数指纹：\`${approval.argsHash}\`\n申请人：${approval.requestedBy}` },
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "批准" }, style: "primary", value: `${SLACK_APPROVAL_CALLBACK_PREFIX}approve:${approval.id}` },
        { type: "button", text: { type: "plain_text", text: "拒绝" }, style: "danger", value: `${SLACK_APPROVAL_CALLBACK_PREFIX}reject:${approval.id}` },
      ],
    },
  ];
  return { text, blocks };
}

export type SlackApprovalDecision = "approved" | "rejected";

export interface SlackApprovalCallback {
  decision: SlackApprovalDecision;
  approvalId: string;
}

/**
 * 审批卡按钮回调解析（纯函数，可测）：Slack 交互请求体是
 * { type: "block_actions", actions: [{ value: "slack:approve:<id>" }] }，
 * 也可以是它的 JSON 字符串；其余一律返回 null（不是审批回调，别误认）。
 * 本批只解析、不回写审批桥：回写是下一批。
 */
export function parseApprovalCallback(payload: unknown): SlackApprovalCallback | null {
  let data: unknown = payload;
  if (typeof payload === "string") {
    try {
      data = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  const rec = asRecord(data);
  if (!rec || rec.type !== "block_actions") return null;
  const actions = asArray(rec.actions);
  const first = asRecord(actions[0]);
  if (!first || typeof first.value !== "string") return null;
  const value: string = first.value;
  if (!value.startsWith(SLACK_APPROVAL_CALLBACK_PREFIX)) return null;
  const rest = value.slice(SLACK_APPROVAL_CALLBACK_PREFIX.length);
  if (rest.startsWith("approve:")) {
    const id = rest.slice("approve:".length);
    return id ? { decision: "approved", approvalId: id } : null;
  }
  if (rest.startsWith("reject:")) {
    const id = rest.slice("reject:".length);
    return id ? { decision: "rejected", approvalId: id } : null;
  }
  return null;
}

/**
 * 按钮回调的收件处：解析出结论就记一行审计（action "call"、
 * operation "approval_callback"，reason 只写结论与审批 id），返回解析结果；
 * 不是审批回调就返回 null、什么都不记。
 * 注意：这里只解析、不解决审批——真正解决走下面的
 * resolveSlackApprovalCallback（调审批桥 decide），两处审计各记各的，
 * 别把“收到回调”和“审批已解决”混成一行。
 */
export function handleApprovalCallback(home: string, payload: unknown): SlackApprovalCallback | null {
  const parsed = parseApprovalCallback(payload);
  if (!parsed) return null;
  appendConnectorAudit(home, {
    action: "call",
    connector: "slack",
    userId: resolveConnectorUserId(home),
    operation: "approval_callback",
    records: 1,
    durationMs: 0,
    reason: `${parsed.decision}:${parsed.approvalId}`,
  });
  return parsed;
}

export type SlackCallbackResolutionStatus = "resolved" | "not-found" | "not-pending" | "not-approver";

export interface SlackCallbackResolution {
  status: SlackCallbackResolutionStatus;
  approvalId?: string;
  decision?: SlackApprovalDecision;
  reason: string;
}

/**
 * 审批卡按钮回调回写（G-P0-6 做深；缺口 44 第二批只解析不回写的那一步）：
 * 解析回调 → 审批桥 decide（via "button"，档位 once）→ 记一行解决审计。
 * - 找不到审批：not-found；已处理过：not-pending（重放回调不报错、不重复
 *   解决，幂等）；决定人不在 owner/admin 白名单：not-approver（桥里记审计，
 *   不改状态）。
 * 桥由调用方建（CLI 按本机配置建，网关传运行中 BotRunner 里的桥）——本模块
 * 不自己建桥，免得两处各建一个桥、各读一份账本。
 */
export async function resolveSlackApprovalCallback(
  home: string,
  opts: { payload: unknown; decidedBy: string; bridge: ApprovalBridge },
): Promise<SlackCallbackResolution> {
  const parsed = parseApprovalCallback(opts.payload);
  if (!parsed) {
    return { status: "not-found", reason: "不是审批卡按钮回调（payload 里没有 slack:approve:/slack:reject: 按钮）。" };
  }
  const result = await opts.bridge.decide(parsed.approvalId, parsed.decision === "approved", opts.decidedBy, "button", "once");
  if (!result.ok) {
    if (result.reason === "not-found") {
      return { status: "not-found", approvalId: parsed.approvalId, reason: `找不到审批 ${parsed.approvalId}（可能已被清理）。` };
    }
    if (result.reason === "not-pending") {
      return { status: "not-pending", approvalId: parsed.approvalId, reason: `审批 ${parsed.approvalId} 已处理过，重复回调不再解决（幂等）。` };
    }
    return { status: "not-approver", approvalId: parsed.approvalId, reason: `决定人 ${opts.decidedBy} 不在 owner/admin 白名单里，回调无效。` };
  }
  appendConnectorAudit(home, {
    action: "call",
    connector: "slack",
    userId: resolveConnectorUserId(home),
    operation: "approval_callback_resolved",
    records: 1,
    durationMs: 0,
    reason: `${parsed.decision}:${parsed.approvalId}`,
  });
  return {
    status: "resolved",
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    reason: `审批 ${parsed.approvalId} 已${parsed.decision === "approved" ? "批准" : "拒绝"}（Slack 按钮，决定人 ${opts.decidedBy}）。`,
  };
}
