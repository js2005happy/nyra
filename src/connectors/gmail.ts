// src/connectors/gmail.ts — 原生应用连接器：Gmail（缺口 6，第一批）。
//
// 设计（见 docs/connectors-gmail.md）：
// - 连接器只读用户授权的范围；token 只存密码箱（vault.json 的 gmail-oauth
//   条目），绝不进配置文件与日志；client_id / client_secret 同样只存密码箱
//   （gmail-oauth-client 条目），配置文件里只有 enabled 开关。
// - OAuth 走标准授权码流程 + 本机回环回调（Desktop app 类型客户端）；
//   不用任何 Google SDK，只用全局 fetch 调 Gmail REST API，不引新依赖。
// - 收（search/read）是只读工具，不走审批；发（send/draft）走与 write_file
//   同级的显式审批（见 tools.ts），且每次代发都写一条证据记录。
// - 邮件正文是不可信外部数据：工具层用 wrapUntrusted 框起来再交给模型，
//   这里只负责原样取回，不做清洗、不执行其中任何指令性文字。
// - 本模块不做网络上的任何“聪明事”：URL 全部由固定 host + 校验过的
//   message id 拼成，用户输入永远成不了 URL 的 host；token 刷新失败即
//   报“授权失效、请重新授权”，不静默降级、不重试三次以上。
// - 缺口 44 第三批：OAuth 的 form POST 与回环服务器不再留第二份，统一走
//   src/oauth.ts 的通用流程（postForm / startLoopbackCallbackServer /
//   newAuthState / buildAuthUrl）；对外行为与合并前一字不差（错误仍报
//   GmailError、文案仍是 Gmail 口径），见下面的 postForm 与
//   startLoopbackCallbackServer 两个薄 wrapper。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, Vault, vaultPath } from "../vault.ts";
import { appendConnectorAudit } from "./registry.ts";
import { recordConnectorCall } from "./directory.ts";
import { formatBytes, sniffImageKind, TEXT_EXTENSIONS } from "../bot/attachments.ts";
import {
  buildAuthUrl as buildOAuthAuthUrl,
  newAuthState as oauthNewAuthState,
  postForm as oauthPostForm,
  startLoopbackCallbackServer as oauthStartLoopback,
  OAuthError,
} from "../oauth.ts";
import {
  CONNECTOR_AUTH_STATE_LABELS,
  ensureConnectorUsable,
  markConnectorExpired,
  peekConnectorState,
  resolveConnectorUserId,
  tokenFingerprint,
  type ConnectorAuthState,
} from "./registry.ts";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const GMAIL_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** 申请的 scope：读邮件 + 发邮件 + 建草稿（缺口 6 第一批的全部能力）；
 * 缺口 44 第三批加 gmail.modify——改标签、标已读、进回收站都要它。 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];
/** 附件下载的硬顶（与 Bot Phase 3 的 attachment_max_bytes 默认值同口径）：
 * 单个附件超 10MB 直接拒绝；文本文档提取进 CLI 输出最多 8000 字，超了截断并注明。 */
export const GMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const GMAIL_ATTACHMENT_TEXT_CHARS = 8000;
/** 密码箱条目名：token 与 OAuth 客户端各一条，名字明文、值加密（见 vault.ts）。 */
export const GMAIL_VAULT_TOKENS_ENTRY = "gmail-oauth";
export const GMAIL_VAULT_CLIENT_ENTRY = "gmail-oauth-client";
/** 单次 search 最多返回的条数（硬顶：既是 Gmail API 的合理页大小， */
/** 也是防模型一次吞太多邮件正文的上限；多翻页用 pageToken 接着取）。 */
export const GMAIL_MAX_SEARCH_RESULTS = 25;
export const GMAIL_DEFAULT_SEARCH_RESULTS = 10;
/** 单次 API 请求超时（毫秒）；token 刷新、收发都走同一口径。 */
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;

export class GmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailError";
  }
}

/** 授权失效（refresh token 坏了/被撤销/过期）：唯一的出路是重新跑 nyra gmail auth。 */
export class GmailAuthError extends GmailError {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

export interface GmailTokens {
  access_token: string;
  refresh_token: string;
  /** access_token 过期时刻（毫秒 epoch，由 expires_in 算出）。 */
  expires_at: number;
  scope?: string;
  /** 授权时从 profile 取回的邮箱地址（只作展示，不作身份判定）。 */
  email?: string;
}

export interface GmailClient {
  client_id: string;
  client_secret: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels?: string[];
}

export interface GmailMessage extends GmailMessageSummary {
  /** 正文纯文本（有 text/plain 优先用它；只有 HTML 时由 HTML 去标签得到）。 */
  bodyText: string;
  /** 原始 HTML 正文（有才给；模型不直接读它，读 bodyText）。 */
  bodyHtml?: string;
}

export interface GmailSendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** 回复时传原邮件的 threadId，Gmail 会把这封归进同一串。 */
  threadId?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

/** 草稿摘要（drafts.list 只给 id 与邮件 id；主题与收件人要 getDraft 再取）。 */
export interface GmailDraftSummary {
  id: string;
  messageId?: string;
  threadId?: string;
}

/** 一封草稿的详情（收件人、主题从草稿里的邮件头取）。 */
export interface GmailDraft extends GmailDraftSummary {
  to: string;
  subject: string;
  snippet: string;
}

export interface GmailAttachment {
  /** 附件原始字节（base64url 解码后）。 */
  bytes: Buffer;
  filename?: string;
  mimeType?: string;
  /** 字节数（与 bytes.length 一致，单独列出来方便审计与展示）。 */
  size: number;
}

export interface GmailTransport {
  search(query: string, maxResults?: number, pageToken?: string): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }>;
  get(id: string): Promise<GmailMessage>;
  send(opts: GmailSendOptions): Promise<{ id: string; threadId: string }>;
  createDraft(opts: GmailSendOptions): Promise<{ id: string }>;
  /** G-P0-6 做深：草稿闭环——列草稿、读一封草稿、发一封草稿。发草稿是写操作，
   * 在 CLI 层须用户显式确认并过红线（与 send 同款门），transport 本身只负责调 API。 */
  listDrafts(): Promise<GmailDraftSummary[]>;
  getDraft(draftId: string): Promise<GmailDraft>;
  sendDraft(draftId: string): Promise<{ id: string; threadId: string }>;  /** 缺口 44 第三批：标签（只读列出）与写操作（改标签、标已读、进回收站）。
   * 写操作在 CLI 层须用户显式确认，transport 本身只负责调 API。 */
  listLabels(): Promise<GmailLabel[]>;
  modifyLabels(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<{ id: string; labelIds: string[] }>;
  markRead(id: string): Promise<{ id: string; labelIds: string[] }>;
  markUnread(id: string): Promise<{ id: string; labelIds: string[] }>;
  trash(id: string): Promise<{ id: string }>;
  /** 附件下载：先读邮件全文找到附件所在的 part（文件名与 mime 类型都在
   * part 上），再调 attachments.get 取原始字节。 */
  getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachment>;
}

/** 永久删除是硬红线（缺口 51）：Gmail 侧只提供进回收站，永久删除本批不提供。 */
export function gmailWriteRefusal(operation: string): string {
  return `Gmail 永久删除本批不提供（${operation}）：只支持进回收站（nyra gmail trash），想彻底删除请去 Gmail 网页端操作。`;
}

export function refuseGmailPermanentDelete(operation: string): never {
  throw new GmailError(gmailWriteRefusal(operation));
}

/** CLI 上撞见写词直接拒绝的命令名（与 Slack 的 SLACK_WRITE_COMMANDS 同款）。 */
export const GMAIL_WRITE_COMMANDS = ["delete", "purge"] as const;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function b64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** Gmail message id 只允许 URL 安全字符：用户输入永远拼不成越界路径。 */
export function isValidGmailMessageId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function assertMessageId(id: string): void {
  if (!isValidGmailMessageId(id)) throw new GmailError(`邮件 id 不合法：${id}`);
}

/** Gmail 标签 id 只允许 URL 安全字符（系统标签如 INBOX/UNREAD、用户标签
 * 如 Label_123 都是这个字符集；用户输入永远拼不成越界路径）。 */
export function isValidGmailLabelId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function assertLabelId(id: string): void {
  if (!isValidGmailLabelId(id)) throw new GmailError(`标签 id 不合法：${id}`);
}

function assertAttachmentId(id: string): void {
  if (!isValidGmailMessageId(id)) throw new GmailError(`附件 id 不合法：${id}`);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Subject 含非 ASCII 时按 RFC 2047 编成 =?UTF-8?B?...?=，否则 Gmail 会乱码。 */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

/** 发件/草稿的 RFC 822 原文（纯文本 UTF-8），再整体 base64url 编码给 Gmail API。 */
export function buildRawMessage(opts: GmailSendOptions): string {
  const lines: string[] = [];
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc?.length) lines.push(`Cc: ${opts.cc.join(", ")}`);
  if (opts.bcc?.length) lines.push(`Bcc: ${opts.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeSubject(opts.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(opts.body);
  return b64urlEncode(lines.join("\r\n"));
}

/** 拼授权 URL：参数与合并前一字不差（client_id、redirect_uri、
 * response_type=code、scope、access_type=offline、prompt=consent、state），
 * 拼接本身走 oauth.ts 的通用 buildAuthUrl。 */
export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  return buildOAuthAuthUrl(GMAIL_AUTH_URL, {
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: (opts.scopes ?? GMAIL_SCOPES).join(" "),
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  });
}

/** 授权流程用的随机 state（防 CSRF）：与 oauth.ts 同一个实现，不再留第二份。 */
export const newAuthState = oauthNewAuthState;

/** token 端点返回的 JSON 转 GmailTokens：缺字段即报错，不猜、不补默认值。 */
export function parseTokens(data: unknown): GmailTokens {
  if (!data || typeof data !== "object") throw new GmailError("token 端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || !d.access_token) throw new GmailError("token 端点没有返回 access_token");
  if (typeof d.refresh_token !== "string" || !d.refresh_token) throw new GmailError("token 端点没有返回 refresh_token（请确认授权时选了 offline 访问）");
  if (typeof d.expires_in !== "number" || d.expires_in <= 0) throw new GmailError("token 端点没有返回有效的 expires_in");
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + d.expires_in * 1000,
    ...(typeof d.scope === "string" && d.scope ? { scope: d.scope } : {}),
  };
}

/** form POST 走 oauth.ts 的通用 postForm（缺口 44 第三批合并）；错误仍按
 * Gmail 模块的口径报（token 端点失败 → GmailError“token 端点请求失败：…”），
 * 调用方（exchangeCodeForTokens / refreshAccessToken / revokeRefreshToken）
 * 的行为与合并前一字不差。 */
async function postForm(url: string, params: Record<string, string>, fetchFn: FetchFn): Promise<unknown> {
  try {
    return await oauthPostForm(
      url,
      params,
      (u, init) => fetchFn(u, init as unknown as RequestInit),
      GMAIL_REQUEST_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    if (err instanceof OAuthError) {
      throw new GmailError(`token 端点请求失败：${err.message.replace(/^OAuth 请求失败：/, "")}`);
    }
    throw err;
  }
}

export async function exchangeCodeForTokens(opts: {
  client: GmailClient; code: string; redirectUri: string; fetchFn?: FetchFn;
}): Promise<GmailTokens> {
  const data = await postForm(GMAIL_OAUTH_TOKEN_URL, {
    code: opts.code,
    client_id: opts.client.client_id,
    client_secret: opts.client.client_secret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  }, opts.fetchFn ?? fetch);
  return parseTokens(data);
}

export async function refreshAccessToken(opts: {
  client: GmailClient; refreshToken: string; fetchFn?: FetchFn;
}): Promise<GmailTokens> {
  let data: unknown;
  try {
    data = await postForm(GMAIL_OAUTH_TOKEN_URL, {
      refresh_token: opts.refreshToken,
      client_id: opts.client.client_id,
      client_secret: opts.client.client_secret,
      grant_type: "refresh_token",
    }, opts.fetchFn ?? fetch);
  } catch (err: unknown) {
    // 刷新失败就是授权失效（refresh token 坏了/被撤销/过期），直接报 auth 错误。
    throw new GmailAuthError(`刷新 token 失败：${err instanceof Error ? err.message : String(err)}（请重新运行 nyra gmail auth）`);
  }
  if (!data || typeof data !== "object") throw new GmailAuthError("刷新 token 失败：token 端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || !d.access_token) {
    throw new GmailAuthError("刷新 token 失败：没有返回新的 access_token（refresh token 可能已被撤销，请重新运行 nyra gmail auth）");
  }
  if (typeof d.expires_in !== "number" || d.expires_in <= 0) throw new GmailAuthError("刷新 token 失败：没有返回有效的 expires_in");
  return {
    access_token: d.access_token,
    // 刷新时 Google 通常不返回新的 refresh_token：旧的继续用。
    refresh_token: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : opts.refreshToken,
    expires_at: Date.now() + d.expires_in * 1000,
    ...(typeof d.scope === "string" && d.scope ? { scope: d.scope } : {}),
  };
}

/** 吊销 refresh token（尽力而为：Google  unreachable 时只报错，不拦本地清理）。 */
export async function revokeRefreshToken(opts: { token: string; fetchFn?: FetchFn }): Promise<void> {
  await postForm(GMAIL_OAUTH_REVOKE_URL, { token: opts.token }, opts.fetchFn ?? fetch);
}

function headerValue(headers: Array<{ name?: string; value?: string }>, name: string): string {
  const found = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

function collectBodies(part: GmailPart, out: { text?: string; html?: string }): void {
  if (part.mimeType === "text/plain" && part.body?.data && out.text === undefined) {
    out.text = b64urlDecode(part.body.data).toString("utf-8");
  } else if (part.mimeType === "text/html" && part.body?.data && out.html === undefined) {
    out.html = b64urlDecode(part.body.data).toString("utf-8");
  }
  for (const sub of part.parts ?? []) collectBodies(sub, out);
}

function parseMessage(data: unknown): GmailMessage {
  if (!data || typeof data !== "object") throw new GmailError("Gmail 返回了无法识别的邮件内容");
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) throw new GmailError("Gmail 返回的邮件没有 id");
  const payload = (d.payload ?? {}) as { headers?: Array<{ name?: string; value?: string }>; body?: { data?: string }; parts?: GmailPart[] };
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const bodies: { text?: string; html?: string } = {};
  collectBodies(payload as GmailPart, bodies);
  if (bodies.text === undefined && bodies.html !== undefined) bodies.text = stripTags(bodies.html);
  return {
    id: d.id,
    threadId: typeof d.threadId === "string" ? d.threadId : "",
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    snippet: typeof d.snippet === "string" ? d.snippet : "",
    labels: Array.isArray(d.labelIds) ? (d.labelIds as unknown[]).filter((x): x is string => typeof x === "string") : [],
    bodyText: bodies.text ?? "",
    ...(bodies.html !== undefined ? { bodyHtml: bodies.html } : {}),
  };
}

function parseMessageList(data: unknown): { messages: Array<{ id: string; threadId: string }>; nextPageToken?: string } {
  if (!data || typeof data !== "object") throw new GmailError("Gmail 返回了无法识别的邮件列表");
  const d = data as Record<string, unknown>;
  const list = Array.isArray(d.messages) ? d.messages : [];
  const messages = list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
    .map((m) => ({ id: m.id as string, threadId: typeof m.threadId === "string" ? m.threadId : "" }));
  return {
    messages,
    ...(typeof d.nextPageToken === "string" && d.nextPageToken ? { nextPageToken: d.nextPageToken } : {}),
  };
}

/**
 * Gmail REST API 传输层：只调固定 host（gmail.googleapis.com /
 * oauth2.googleapis.com），不接受调用方传入任意 URL；401 时用 refresh token
 * 换一次并重试一次，刷新失败即报 GmailAuthError。
 */
export class GmailApiTransport implements GmailTransport {
  private tokens: GmailTokens;
  private readonly client: GmailClient;
  private readonly fetchFn: FetchFn;
  private readonly onTokensRefreshed?: (tokens: GmailTokens) => void;
  /** 缺口 44 第 0 批：refresh 失败（refresh token 坏了/被撤销）时回调，调用方
   * 把授权状态标过期——access token 过期不走这里（正常刷新能换回来）。 */
  private readonly onAuthFailure?: () => void;
  /** 缺口 44 第三批：调用审计用的 home 与 userId（只记操作名、记录数、
   * 耗时，不记 token、不记邮件内容；测试里直接 new 时不传，审计静默跳过）。 */
  private readonly home?: string;
  private readonly userId?: string;

  constructor(opts: {
    tokens: GmailTokens;
    client: GmailClient;
    fetchFn?: FetchFn;
    onTokensRefreshed?: (tokens: GmailTokens) => void;
    onAuthFailure?: () => void;
    home?: string;
    userId?: string;
  }) {
    this.tokens = opts.tokens;
    this.client = opts.client;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onTokensRefreshed = opts.onTokensRefreshed;
    this.onAuthFailure = opts.onAuthFailure;
    this.home = opts.home;
    this.userId = opts.userId;
  }

  /** 当前 token（测试与 CLI 状态展示用；调用方绝不能把它写进日志）。 */
  currentTokens(): GmailTokens {
    return this.tokens;
  }

  /** 每次调用记一行审计（与 Shopify/Slack 的 audit 同款）：只记操作名、
   * 记录数、耗时，不记 token、不记邮件内容、不记附件内容。 */
  private audit(operation: string, records: number, startedAt: number, reason?: string): void {
    if (!this.home || !this.userId) return;
    appendConnectorAudit(this.home, {
      action: "call",
      connector: "gmail",
      userId: this.userId,
      operation,
      records,
      durationMs: Date.now() - startedAt,
      ...(reason ? { reason } : {}),
    });
    // 缺口 44 第一批：调用计数进用量账本与运行记录（最佳努力，记不上不拦调用）。
    recordConnectorCall(this.home, { connector: "gmail", operation, records, durationMs: Date.now() - startedAt, userId: this.userId });
  }

  private async refresh(): Promise<void> {
    let next: GmailTokens;
    try {
      next = await refreshAccessToken({
        client: this.client,
        refreshToken: this.tokens.refresh_token,
        fetchFn: this.fetchFn,
      });
    } catch (err: unknown) {
      // refresh 失败 = 授权本身死了（不是 access token 正常过期）：标过期，
      // 下次调用直接报“请重新授权”，不再拿死掉的 refresh token 反复试。
      try { this.onAuthFailure?.(); } catch { /* 标过期失败不改变刷新失败本身 */ }
      throw err;
    }
    this.tokens = { ...next, ...(this.tokens.email ? { email: this.tokens.email } : {}) };
    try { this.onTokensRefreshed?.(this.tokens); } catch { /* 回调失败不破坏刷新本身 */ }
  }

  private async request(path: string, init: RequestInit, retryOnAuth = true): Promise<unknown> {
    if (this.tokens.expires_at - Date.now() < 60_000) {
      try { await this.refresh(); } catch (err: unknown) {
        if (err instanceof GmailAuthError) throw err;
        throw new GmailAuthError(`刷新 token 失败：${err instanceof Error ? err.message : String(err)}（请重新运行 nyra gmail auth）`);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GMAIL_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(`${GMAIL_API_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.tokens.access_token}`, ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new GmailError(`Gmail 请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && retryOnAuth) {
      try { await this.refresh(); } catch (err: unknown) {
        if (err instanceof GmailAuthError) throw err;
        throw new GmailAuthError(`刷新 token 失败：${err instanceof Error ? err.message : String(err)}（请重新运行 nyra gmail auth）`);
      }
      return this.request(path, init, false);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text) as { error?: { message?: string } };
        if (typeof data?.error?.message === "string" && data.error.message) detail = data.error.message;
      } catch { /* 非 JSON 错误体直接用状态码 */ }
      throw new GmailError(`Gmail 请求失败：${detail}`);
    }
    try { return JSON.parse(text) as unknown; } catch { throw new GmailError("Gmail 返回了无法识别的内容"); }
  }

  async search(query: string, maxResults: number = GMAIL_DEFAULT_SEARCH_RESULTS, pageToken?: string): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }> {
    const q = query.trim();
    if (!q) throw new GmailError("gmail_search 需要查询词（Gmail 搜索语法，如 from:xxx、subject:xxx、is:unread）");
    const n = Math.min(Math.max(Math.floor(maxResults) || GMAIL_DEFAULT_SEARCH_RESULTS, 1), GMAIL_MAX_SEARCH_RESULTS);
    const params = new URLSearchParams({ q, maxResults: String(n) });
    if (pageToken) params.set("pageToken", pageToken);
    const list = parseMessageList(await this.request(`/users/me/messages?${params.toString()}`, { method: "GET" }));
    const summaries: GmailMessageSummary[] = [];
    for (const m of list.messages) {
      const full = await this.request(
        `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { method: "GET" },
      );
      const parsed = parseMessage(full);
      summaries.push({
        id: parsed.id, threadId: parsed.threadId, from: parsed.from, to: parsed.to,
        subject: parsed.subject, date: parsed.date, snippet: parsed.snippet, labels: parsed.labels,
      });
    }
    return { messages: summaries, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
  }

  async get(id: string): Promise<GmailMessage> {
    assertMessageId(id);
    return parseMessage(await this.request(`/users/me/messages/${id}?format=full`, { method: "GET" }));
  }

  async send(opts: GmailSendOptions): Promise<{ id: string; threadId: string }> {
    const body: Record<string, unknown> = { raw: buildRawMessage(opts) };
    if (opts.threadId) body.threadId = opts.threadId;
    const data = await this.request("/users/me/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id) throw new GmailError("Gmail 发送后没有返回邮件 id");
    return { id: data.id, threadId: typeof data.threadId === "string" ? data.threadId : "" };
  }

  async createDraft(opts: GmailSendOptions): Promise<{ id: string }> {
    const data = await this.request("/users/me/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: buildRawMessage(opts), ...(opts.threadId ? { threadId: opts.threadId } : {}) } }),
    }) as Record<string, unknown>;
    const draft = (data.draft ?? data) as Record<string, unknown>;
    if (typeof draft.id !== "string" || !draft.id) throw new GmailError("Gmail 建草稿后没有返回草稿 id");
    return { id: draft.id };
  }

  /** 列出草稿（只读）：id + 邮件 id；主题与收件人要 getDraft 再取。 */
  async listDrafts(): Promise<GmailDraftSummary[]> {
    const startedAt = Date.now();
    const data = await this.request("/users/me/drafts", { method: "GET" }) as Record<string, unknown>;
    const list = Array.isArray(data.drafts) ? data.drafts : [];
    const drafts = list
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object" && typeof (d as Record<string, unknown>).id === "string")
      .map((d) => {
        const message = d.message && typeof d.message === "object" ? (d.message as Record<string, unknown>) : {};
        return {
          id: d.id as string,
          ...(typeof message.id === "string" && message.id ? { messageId: message.id } : {}),
          ...(typeof message.threadId === "string" && message.threadId ? { threadId: message.threadId } : {}),
        };
      });
    this.audit("list_drafts", drafts.length, startedAt);
    return drafts;
  }

  /** 读一封草稿的详情（收件人、主题、摘要；正文不取——发之前 CLI 只展示头信息）。 */
  async getDraft(draftId: string): Promise<GmailDraft> {
    assertMessageId(draftId);
    const data = await this.request(`/users/me/drafts/${draftId}`, { method: "GET" }) as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id) throw new GmailError(`Gmail 没有返回 id 为 ${draftId} 的草稿`);
    const message = data.message && typeof data.message === "object" ? data.message : {};
    const parsed = parseMessage(message);
    return {
      id: data.id,
      ...(parsed.id ? { messageId: parsed.id } : {}),
      ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
      to: parsed.to,
      subject: parsed.subject,
      snippet: parsed.snippet,
    };
  }

  /** 发一封草稿（写操作）：CLI 层须先显式确认并过红线；发完返回邮件 id。 */
  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    assertMessageId(draftId);
    const startedAt = Date.now();
    const data = await this.request("/users/me/drafts/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: draftId }),
    }) as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id) throw new GmailError("Gmail 发送草稿后没有返回邮件 id");
    this.audit("send_draft", 1, startedAt);
    return { id: data.id, threadId: typeof data.threadId === "string" ? data.threadId : "" };
  }

  /** 授权时取回的账号邮箱（GET /users/me/profile），只作状态展示。 */
  async profileEmail(): Promise<string> {
    const data = await this.request("/users/me/profile", { method: "GET" }) as Record<string, unknown>;
    if (typeof data.emailAddress !== "string" || !data.emailAddress) throw new GmailError("Gmail 没有返回账号邮箱");
    return data.emailAddress;
  }

  /** 列出标签（只读）：id、名字、类型（system/user）三列，只取展示字段。 */
  async listLabels(): Promise<GmailLabel[]> {
    const startedAt = Date.now();
    const data = await this.request("/users/me/labels", { method: "GET" }) as Record<string, unknown>;
    const list = Array.isArray(data.labels) ? data.labels : [];
    const labels = list
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object" && typeof (l as Record<string, unknown>).id === "string")
      .map((l) => ({
        id: l.id as string,
        name: typeof l.name === "string" ? l.name : (l.id as string),
        ...(typeof l.type === "string" ? { type: l.type } : {}),
      }));
    this.audit("labels", labels.length, startedAt);
    return labels;
  }

  /** 改标签：add 与 remove 至少给一个；空数组传了也无害，Gmail 直接忽略。 */
  private async modify(id: string, addLabelIds: string[], removeLabelIds: string[], operation: string): Promise<{ id: string; labelIds: string[] }> {
    assertMessageId(id);
    for (const labelId of [...addLabelIds, ...removeLabelIds]) assertLabelId(labelId);
    const startedAt = Date.now();
    const data = await this.request(`/users/me/messages/${id}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    }) as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id) throw new GmailError("Gmail 改标签后没有返回邮件 id");
    const labelIds = Array.isArray(data.labelIds)
      ? (data.labelIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    this.audit(operation, 1, startedAt);
    return { id: data.id, labelIds };
  }

  async modifyLabels(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<{ id: string; labelIds: string[] }> {
    return this.modify(id, addLabelIds, removeLabelIds, "modify_labels");
  }

  /** 标已读 = 去掉 UNREAD 标签；标未读 = 加上 UNREAD 标签。 */
  async markRead(id: string): Promise<{ id: string; labelIds: string[] }> {
    return this.modify(id, [], ["UNREAD"], "mark_read");
  }

  async markUnread(id: string): Promise<{ id: string; labelIds: string[] }> {
    return this.modify(id, ["UNREAD"], [], "mark_unread");
  }

  /** 进回收站（不是永久删除）：须 CLI 层显式确认；永久删除本批不提供。 */
  async trash(id: string): Promise<{ id: string }> {
    assertMessageId(id);
    const startedAt = Date.now();
    const data = await this.request(`/users/me/messages/${id}/trash`, { method: "POST" }) as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id) throw new GmailError("Gmail 移进回收站后没有返回邮件 id");
    this.audit("trash", 1, startedAt);
    return { id: data.id };
  }

  /** 在邮件全文里找附件所在的 part（文件名与 mime 类型都在 part 上）。 */
  private findAttachmentPart(data: unknown, attachmentId: string): { filename?: string; mimeType?: string } | null {
    const payload = ((data as Record<string, unknown> | null)?.payload ?? {}) as GmailPart;
    const walk = (part: GmailPart): { filename?: string; mimeType?: string } | null => {
      if (part.body?.attachmentId === attachmentId) {
        return {
          ...(part.filename ? { filename: part.filename } : {}),
          ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        };
      }
      for (const sub of part.parts ?? []) {
        const found = walk(sub);
        if (found) return found;
      }
      return null;
    };
    return walk(payload);
  }

  /** 附件下载：先读邮件全文找 part，再调 attachments.get 取原始字节。 */
  async getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachment> {
    assertMessageId(messageId);
    assertAttachmentId(attachmentId);
    const startedAt = Date.now();
    const raw = await this.request(`/users/me/messages/${messageId}?format=full`, { method: "GET" });
    const part = this.findAttachmentPart(raw, attachmentId);
    if (!part) throw new GmailError(`邮件 ${messageId} 里没有找到附件 ${attachmentId}`);
    const data = await this.request(`/users/me/messages/${messageId}/attachments/${attachmentId}`, { method: "GET" }) as Record<string, unknown>;
    if (typeof data.data !== "string") throw new GmailError("Gmail 没有返回附件内容");
    const bytes = b64urlDecode(data.data);
    this.audit("attachment", 1, startedAt);
    return {
      bytes,
      ...(part.filename ? { filename: part.filename } : {}),
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      size: bytes.length,
    };
  }
}

/** 密码箱里静默读 token：无箱、无密码、密码错、条目缺失、内容损坏一律返回 null，不抛错。 */
export function loadGmailTokens(home: string): GmailTokens | null {
  const raw = getCredential(GMAIL_VAULT_TOKENS_ENTRY, home);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_at !== "number") return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
      ...(typeof data.email === "string" ? { email: data.email } : {}),
    };
  } catch {
    return null;
  }
}

/** 密码箱里静默读 OAuth 客户端（client_id + client_secret），读不到返回 null。 */
export function loadGmailClient(home: string): GmailClient | null {
  const raw = getCredential(GMAIL_VAULT_CLIENT_ENTRY, home);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.client_id !== "string" || !data.client_id || typeof data.client_secret !== "string" || !data.client_secret) return null;
    return { client_id: data.client_id, client_secret: data.client_secret };
  } catch {
    return null;
  }
}

/**
 * 刷新后把新 token 写回密码箱（尽力而为）：只有 NYRA_VAULT_PASSWORD 在时
 * 才能解锁写回；写不进去也不破坏本次运行——内存里的新 token 照常用，
 * 下次运行再刷新一次即可（refresh token 本身不变）。
 */
export function persistGmailTokens(home: string, tokens: GmailTokens): boolean {
  const password = process.env.NYRA_VAULT_PASSWORD;
  if (!password) return false;
  try {
    const vault = new Vault(vaultPath(home));
    if (!vault.unlock(password)) return false;
    vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify(tokens), true);
    return true;
  } catch {
    return false;
  }
}

export interface GmailConnectorStatus {
  /** config.connectors.gmail.enabled：默认关，显式开才可用。 */
  enabled: boolean;
  /** 密码箱里有 token 条目（只看条目名、不解密；内容损坏时工具调用仍会报错）。 */
  configured: boolean;
  email?: string;
  scopes?: string;
  /** 缺口 44 第 0 批：授权状态机的当前状态（只读看一眼，不写账本、不迁移）。 */
  authState: ConnectorAuthState;
}

/** 密码箱里有没有 gmail-oauth 条目（只看条目名，不用解锁——status 能直接报）。 */
export function hasGmailTokensEntry(home: string): boolean {
  try {
    return new Vault(vaultPath(home)).listNames().includes(GMAIL_VAULT_TOKENS_ENTRY);
  } catch {
    return false;
  }
}

export function resolveGmailEnabled(config: Record<string, unknown>): boolean {
  const section = (config as { connectors?: unknown }).connectors;
  if (!section || typeof section !== "object") return false;
  const gmail = (section as { gmail?: unknown }).gmail;
  if (!gmail || typeof gmail !== "object") return false;
  return (gmail as { enabled?: unknown }).enabled === true;
}

export function getGmailStatus(home: string, config: Record<string, unknown>): GmailConnectorStatus {
  const enabled = resolveGmailEnabled(config);
  const tokens = loadGmailTokens(home);
  const hasEntry = hasGmailTokensEntry(home);
  return {
    enabled,
    configured: hasEntry,
    ...(tokens?.email ? { email: tokens.email } : {}),
    ...(tokens?.scope ? { scopes: tokens.scope } : {}),
    // 密码箱里有条目就算“已授权”的候选：首次调用 createGmailTransport 时
    // 会沿用已有授权正式记一笔；这里只读，不写账本。
    authState: peekConnectorState(home, "gmail", resolveConnectorUserId(home), { hasTokens: hasEntry }),
  };
}

/** 授权状态的中文标签（CLI status 行用，与 registry 的标签表同源）。 */
export function gmailAuthStateLabel(state: ConnectorAuthState): string {
  return CONNECTOR_AUTH_STATE_LABELS[state];
}

/** 代发证据正文（工具与 CLI 共用）：发了什么、按哪条规则发的、谁批准的。 */
export function buildGmailSendEvidence(opts: {
  to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string;
  threadId?: string; draft: boolean; resultId: string; approvalChannel: string; mode: string;
}): string {
  const lines = [
    `工具：gmail_send${opts.draft ? "（只存草稿，未发送）" : ""}`,
    `收件人：${opts.to.join(", ")}`,
    ...(opts.cc?.length ? [`抄送：${opts.cc.join(", ")}`] : []),
    ...(opts.bcc?.length ? [`密送：${opts.bcc.join(", ")}`] : []),
    `主题：${opts.subject}`,
    ...(opts.threadId ? [`回复原串 threadId：${opts.threadId}`] : []),
    `批准：用户经${opts.approvalChannel}批准（${opts.mode} 模式）`,
    opts.draft ? `草稿 id：${opts.resultId}` : `邮件 id：${opts.resultId}`,
    "正文：",
    opts.body,
  ];
  return lines.join("\n");
}

/**
 * 建一个能用的 Gmail 传输层：未启用、没配 token、没配客户端时直接抛错，
 * 调用方把错误原样告诉用户（里面已经写清下一步该跑什么命令）。
 * 缺口 44 第 0 批：建之前先过授权状态机——已过期/已撤销/未批准的一律拦在
 * 门外（fail-closed）；密码箱里已有凭证但状态账本还没记录的，沿用已有授权
 * 迁移为已授权（不打断已跑过 nyra gmail auth 的用户）。fetchFn 只供测试
 * 注入；生产永远用全局 fetch。
 */
export function createGmailTransport(home: string, config: Record<string, unknown>, opts?: { fetchFn?: FetchFn }): GmailTransport {
  if (!resolveGmailEnabled(config)) {
    throw new GmailError("Gmail 连接器未启用：先运行 nyra gmail auth 完成授权（授权成功会自动启用）");
  }
  const tokens = loadGmailTokens(home);
  if (!tokens) throw new GmailAuthError("Gmail 未授权：密码箱里没有 token，请运行 nyra gmail auth");
  const client = loadGmailClient(home);
  if (!client) throw new GmailAuthError("Gmail 未授权：密码箱里没有 OAuth 客户端，请重新运行 nyra gmail auth");
  const userId = resolveConnectorUserId(home);
  const usable = ensureConnectorUsable(home, "gmail", userId, {
    hasTokens: true,
    tokenFingerprint: tokenFingerprint(tokens.refresh_token),
    scopes: tokens.scope,
  });
  if (!usable.ok) throw new GmailAuthError(usable.message);
  return new GmailApiTransport({
    tokens,
    client,
    fetchFn: opts?.fetchFn,
    home,
    userId,
    onTokensRefreshed: (next) => { persistGmailTokens(home, next); },
    onAuthFailure: () => {
      try { markConnectorExpired(home, "gmail", userId, "refresh token 失效"); } catch { /* 标过期失败不改变调用失败本身 */ }
    },
  });
}

/**
 * 回环回调服务器（nyra gmail auth 用）：走 oauth.ts 的通用实现（缺口 44
 * 第三批合并），只在两处保留 Gmail 口径——浏览器里显示的成功/拒绝文案，
 * 以及超时报错里的“请重新运行 nyra gmail auth”。其余行为（state 校验、
 * 拒绝回调、超时关闭）与合并前一字不差。
 * 注意：函数返回时服务器已经 listen 好了，redirectUri 可以直接用。
 */
export async function startLoopbackCallbackServer(opts: { state: string; timeoutMs?: number }): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): void;
}> {
  const server = await oauthStartLoopback({
    state: opts.state,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    successText: "授权成功，可以关掉这个页面、回到终端了。",
    deniedText: "授权被拒绝或失败，可以关掉这个页面了。",
  });
  return {
    redirectUri: server.redirectUri,
    waitForCode: async () => {
      try {
        return await server.waitForCode();
      } catch (err: unknown) {
        if (err instanceof OAuthError) {
          if (err.message.includes("等待授权回调超时")) {
            throw new GmailError("等待授权回调超时（5 分钟）：请重新运行 nyra gmail auth，在浏览器里完成 Google 授权");
          }
          throw new GmailError(err.message);
        }
        throw err;
      }
    },
    close: () => server.close(),
  };
}

/** 附件下载与校验（与 Bot Phase 3 的 processAttachment 同款口径）：
 * 取字节 → 空文件跳过 → 超限拒绝 → 落临时目录（0600）校验 → 图片只记
 * 元信息、文本文档提取内容（超长截断并注明）、其他类型拒绝 → 删临时目录。
 * 返回的 bytes 供调用方 --out 落盘；不 --out 时调用方只拿 notice 与
 * extractedText，内容不进审计、不进日志。 */
export interface GmailAttachmentOutcome {
  kind: "image" | "text" | "unsupported";
  /** 给用户的说明（失败/不支持时回这句；成功时为元信息行）。 */
  notice: string;
  /** 文本文档提取的内容（超长时已截断）；图片与不支持的类型没有。 */
  extractedText?: string;
  /** 审计用的元信息（文件名、类型、大小，不含内容）。 */
  meta: { filename?: string; mimeType?: string; sizeBytes: number };
  /** 附件原始字节（调用方 --out 落盘用；不传 --out 时忽略）。 */
  bytes: Buffer;
}

export async function downloadGmailAttachment(
  transport: GmailTransport,
  messageId: string,
  attachmentId: string,
  opts?: { maxBytes?: number; textChars?: number },
): Promise<GmailAttachmentOutcome> {
  const maxBytes = opts?.maxBytes ?? GMAIL_ATTACHMENT_MAX_BYTES;
  const textChars = opts?.textChars ?? GMAIL_ATTACHMENT_TEXT_CHARS;
  const att = await transport.getAttachment(messageId, attachmentId);
  const meta: GmailAttachmentOutcome["meta"] = {
    ...(att.filename ? { filename: att.filename } : {}),
    ...(att.mimeType ? { mimeType: att.mimeType } : {}),
    sizeBytes: att.bytes.length,
  };
  if (att.bytes.length === 0) {
    return { kind: "unsupported", notice: "附件是空文件，已跳过。", meta, bytes: att.bytes };
  }
  if (att.bytes.length > maxBytes) {
    return { kind: "unsupported", notice: `附件太大（${formatBytes(att.bytes.length)}，超过 ${formatBytes(maxBytes)} 上限），已跳过。`, meta, bytes: att.bytes };
  }
  // 落临时目录再处理（文件名不用 Gmail 给的名字，防路径穿越）；无论成败都删。
  const dir = mkdtempSync(join(tmpdir(), "nyra-gmail-attachment-"));
  try {
    writeFileSync(join(dir, "file"), att.bytes, { mode: 0o600 });
    const data = readFileSync(join(dir, "file"));
    const imageKind = sniffImageKind(data);
    if (imageKind) {
      return {
        kind: "image",
        notice: `收到一张图片（${imageKind}，${formatBytes(data.length)}）：本批暂不支持看图，已记录元信息。`,
        meta,
        bytes: att.bytes,
      };
    }
    const base = (att.filename ?? "").split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    const mime = (att.mimeType ?? "").toLowerCase();
    const isText = TEXT_EXTENSIONS.includes(ext) || mime.startsWith("text/");
    if (!isText) {
      const shown = ext ? `.${ext}` : (mime || "未知类型");
      return { kind: "unsupported", notice: `暂不支持解析这类文件（${shown}），请转成 .txt/.md 再取，或用 --out 原样保存。`, meta, bytes: att.bytes };
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
    const truncated = decoded.length > textChars;
    return {
      kind: "text",
      notice: `已读取附件 ${att.filename ?? "未命名文档"}（${formatBytes(data.length)}${truncated ? `，内容过长只取前 ${textChars} 字` : ""}）。`,
      extractedText: truncated ? decoded.slice(0, textChars) : decoded,
      meta,
      bytes: att.bytes,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 搜索结果格式化（纯文本；调用方再按需包 wrapUntrusted——邮件元数据也是外部数据）。 */
export function formatGmailSearchResults(messages: GmailMessageSummary[], nextPageToken?: string): string {
  if (!messages.length) return "没有找到相关邮件。";
  const lines = messages.map((m, i) => {
    const head = `${i + 1}. [${m.id}] ${m.subject || "（无主题）"}`;
    const meta = `发件人：${m.from || "未知"}；时间：${m.date || "未知"}`;
    return m.snippet ? `${head}\n   ${meta}\n   摘要：${m.snippet}` : `${head}\n   ${meta}`;
  });
  if (nextPageToken) lines.push("（还有更多结果，翻页见 pageToken）");
  return lines.join("\n");
}

/** 单封邮件格式化：头信息 + 正文（调用方再包 wrapUntrusted）。 */
export function formatGmailMessage(msg: GmailMessage): string {
  const head = [
    `发件人：${msg.from || "未知"}`,
    `收件人：${msg.to || "未知"}`,
    `主题：${msg.subject || "（无主题）"}`,
    `时间：${msg.date || "未知"}`,
    `邮件 id：${msg.id}`,
    `threadId：${msg.threadId}`,
  ].join("\n");
  return `${head}\n\n${msg.bodyText || "（正文为空）"}`;
}

/** 标签列表格式化：一行一个“名字（id）[类型]”。 */
export function formatGmailLabels(labels: GmailLabel[]): string {
  if (!labels.length) return "没有标签。";
  return labels.map((l) => `- ${l.name}（${l.id}）${l.type ? ` [${l.type}]` : ""}`).join("\n");
}

/** 草稿列表格式化：一行一个“草稿 id（邮件 id）”。 */
export function formatGmailDrafts(drafts: GmailDraftSummary[]): string {
  if (!drafts.length) return "没有草稿。";
  return drafts.map((d) => `- 草稿 ${d.id}${d.messageId ? `（邮件 ${d.messageId}）` : ""}`).join("\n");
}

/** 附件下载结果格式化：说明行 + 文本文档提取的内容（有才附）。 */
export function formatGmailAttachmentOutcome(outcome: GmailAttachmentOutcome): string {
  const lines = [outcome.notice];
  if (outcome.extractedText !== undefined) lines.push("", outcome.extractedText);
  return lines.join("\n");
}

