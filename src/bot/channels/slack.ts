// src/bot/channels/slack.ts — Bot 方向：Slack 渠道适配器。
//
// Slack 与 Telegram / Discord 的不同：收消息走 Socket Mode（官方为「无公网
// 回调」场景的方案）。Socket Mode 用 app-level token（xapp-…）调
// `apps.connections.open` 拿一个动态 WebSocket URL，事件以信封
// `{ envelope_id, type, payload }` 推来；本适配器按 envelope_id 在 3 秒内
// ack，事件压进内部队列，`pollOnce` 出队——对主链路来说仍是「拉一批」的
// 同一形状。
//
// 发消息 / 编辑消息走 Web API（chat.postMessage / chat.update），用 bot
// token（xoxb-…）。所以本适配器需要两个 token：
//   - appToken（xapp-…）：连 Socket Mode、收事件；
//   - botToken（xoxb-…）：发 / 编辑消息。
//
// 与 Discord 的 Gateway 不同，Slack Socket Mode：
//   - 不需要心跳定时器（WebSocket 协议层的 ping/pong 已兜底，Slack 不要求
//     应用层心跳）；
//   - 没有 sequence / RESUME：连接断了就拆掉，重新 `apps.connections.open`
//     拿新 URL 重连；
//   - 服务器会发 `disconnect` 事件（reason 常为 refresh_requested），要求
//     客户端拆掉重连拿新 URL。
//
// 收哪些事件：
//   - `app_mention`：群里有人 @ 本 Bot（天然是 @，isMentioned 恒 true）；
//   - `message.im`：私聊消息（isMentioned 恒 true，私聊本就免 @）；
//   - `message`（非 im 子类型）不接——群聊只有 app_mention 才响应，避免把
//     群里所有闲聊都吃进模型。
//
// 安全（与 Telegram / Discord 同口径）：
//   - 两个 token 只出现在 Authorization 头里（bot token）或 Web API 的 body
//     里（app token 调 apps.connections.open 用 Authorization 头），绝不写
//     进日志、错误文案与审计——报错只说方法名与 HTTP 状态；
//   - 忽略机器人（含自己）发的消息（subtype 含 bot_message / 自己 bot_id）；
//   - 测试不依赖真实 token / 真实 WebSocket：fetch 与 WebSocket 工厂都可注入。
import type { BotChatType, ChannelAdapter, InboundMessage, OutgoingMessage } from "../types.ts";

/** Slack Web API 根地址（固定，不接受调用方传任意 URL）。 */
export const SLACK_API_BASE = "https://slack.com/api";
/** 单次 HTTP 超时（毫秒）。 */
export const SLACK_REQUEST_TIMEOUT_MS = 30_000;
/** 单次 Socket Mode 连接静默超时（拿不到 URL / 连不上时多久重试；毫秒）。 */
export const SLACK_RECONNECT_DELAY_MS = 1_000;

/** 可注入的 WebSocket 工厂（测试用 mock；不传用全局 WebSocket）。 */
export interface SlackWebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SlackWebSocketFactory = (url: string) => SlackWebSocketLike;

export interface SlackAdapterOptions {
  /** app-level token（xapp-…）：连 Socket Mode 收事件用。 */
  appToken: string;
  /** bot token（xoxb-…）：发 / 编辑消息用。 */
  botToken: string;
  /** 注入的 fetch（测试用假 API；不传用全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 注入的 WebSocket 工厂（测试用假连接；不传用全局 WebSocket）。 */
  webSocketFactory?: SlackWebSocketFactory;
  apiBase?: string;
  timeoutMs?: number;
  /** 是否禁用断线自动重连（测试用；默认启用）。 */
  autoReconnect?: boolean;
}

/** 事件信封：Slack Socket Mode 的所有推送都包在这一层。 */
interface SlackEnvelope {
  envelope_id: string;
  type: string;
  payload?: unknown;
  accepts_response_payload?: boolean;
}

interface SlackAppMentionPayload {
  type: "app_mention";
  user?: string;
  channel?: string;
  ts?: string;
  text?: string;
  team?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFilePayload[];
}

interface SlackMessagePayload {
  type: "message";
  subtype?: string;
  user?: string;
  channel?: string;
  ts?: string;
  text?: string;
  team?: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFilePayload[];
}

/** 消息自带的附件元信息（Slack 在 message 里直接带 files 数组）。 */
interface SlackFilePayload {
  id?: string;
  name?: string;
  size?: number;
  mimetype?: string;
  filetype?: string;
  /** 下载地址（需要带 bot token 的 Authorization 头才能访问）。 */
  url_private?: string;
  width?: number;
  height?: number;
}

/** 审批按钮回调（block_actions 交互）的 payload 结构。 */
interface SlackBlockActionsPayload {
  type: "block_actions";
  actions?: { action_id?: string; block_id?: string; value?: string }[];
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; text?: string };
  trigger_id?: string;
  response_url?: string;
}

/** 审批按钮回调的 value 前缀（与 approvalBridge 的 APPROVAL_CALLBACK_PREFIX 一致）。 */
export const SLACK_APPROVE_BUTTON_PREFIX = "bot:";

export class SlackAdapter implements ChannelAdapter {
  readonly channel = "slack" as const;
  botUsername: string | null = null;
  /** 本 Bot 的 Slack 用户 id（忽略自己发的消息用；auth.test 后才有）。 */
  botId: string | null = null;
  private readonly appToken: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly autoReconnect: boolean;
  /** Socket Mode 收到的消息缓冲（pollOnce 从这里出队）。 */
  private inbox: InboundMessage[] = [];
  private ws: SlackWebSocketLike | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SlackAdapterOptions) {
    if (!opts.appToken || typeof opts.appToken !== "string") throw new Error("Slack app token 为空");
    if (!opts.botToken || typeof opts.botToken !== "string") throw new Error("Slack bot token 为空");
    this.appToken = opts.appToken;
    this.botToken = opts.botToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? SLACK_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? SLACK_REQUEST_TIMEOUT_MS;
    this.webSocketFactory = opts.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as SlackWebSocketLike);
    this.autoReconnect = opts.autoReconnect !== false;
  }

  // ---- Web API（发消息 / 编辑消息 / 拿自己信息）----

  private async callApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Slack API 调用失败：${method}（HTTP ${res.status}）`);
      const data = (await res.json()) as { ok?: boolean; error?: string } & T;
      if (data.ok !== true) {
        // 只报方法名与错误码：Authorization 头里含 token，绝不能进错误文案。
        throw new Error(`Slack API 返回错误：${method}（${data.error ?? "unknown_error"}）`);
      }
      return data;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`Slack API 调用超时：${method}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    const data = await this.callApi<{ user_id?: string; user?: string }>("auth.test", {});
    this.botId = data.user_id ?? null;
    this.botUsername = data.user ?? null;
    return { id: this.botId ? Number(this.botId.slice(1)) : 0, username: this.botUsername };
  }

  // ---- Socket Mode（收消息）----

  /** 调 apps.connections.open 拿动态 WebSocket URL（app token 走 Authorization 头）。 */
  private async openSocketUrl(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/apps.connections.open`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.appToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: "",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Slack Socket Mode 连接失败：apps.connections.open（HTTP ${res.status}）`);
      const data = (await res.json()) as { ok?: boolean; error?: string; url?: string };
      if (data.ok !== true || !data.url) {
        throw new Error(`Slack Socket Mode 连接失败：apps.connections.open（${data.error ?? "未返回 WebSocket URL"}）`);
      }
      return data.url;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("Slack Socket Mode 连接超时：apps.connections.open");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 建立 Socket Mode 连接（拿 URL → 建 WS → 收到事件即 ack）。 */
  async connect(): Promise<void> {
    if (this.closed) return;
    if (this.ws) return; // 已连接中
    const url = await this.openSocketUrl();
    if (this.closed) return; // 拿 URL 期间被 close 了
    const ws = this.webSocketFactory(url);
    this.ws = ws;
    ws.onopen = () => { /* Socket Mode 建连后无需 IDENTIFY，直接收事件 */ };
    ws.onmessage = (ev) => this.onSocketMessage(ev);
    ws.onclose = () => {
      this.ws = null;
      if (!this.closed && this.autoReconnect) this.scheduleReconnect();
    };
    ws.onerror = () => { /* 出错交给 onclose 处理重连 */ };
  }

  private onSocketMessage(ev: { data: unknown }): void {
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(String(ev.data)) as SlackEnvelope;
    } catch {
      return; // 非 JSON 帧丢弃
    }
    if (!envelope || typeof envelope.envelope_id !== "string") return;
    // 3 秒内 ack（envelope_id 回给服务器，别的都别提）。
    this.sendEnvelope({ envelope_id: envelope.envelope_id });
    if (envelope.type === "disconnect") {
      // 服务器要求拆掉重连拿新 URL（reason 常为 refresh_requested）。
      this.teardownSocket();
      if (!this.closed && this.autoReconnect) this.scheduleReconnect();
      return;
    }
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (p.type === "app_mention") {
      const inbound = this.toInbound(p as unknown as SlackAppMentionPayload, "mention");
      if (inbound) this.inbox.push(inbound);
    } else if (p.type === "message") {
      const msg = p as unknown as SlackMessagePayload;
      // 只接私聊（message.im）：channel 以 D 开头即私聊；群聊只有 app_mention
      // 才响应，避免把群里所有闲聊都吃进模型。
      const isIm = (msg.channel ?? "").startsWith("D");
      if (isIm) {
        const inbound = this.toInbound(msg, "im");
        if (inbound) this.inbox.push(inbound);
      }
    } else if (p.type === "block_actions") {
      // 审批按钮回调：把 block_actions 归一化成 viaCallback 的 InboundMessage，
      // 走与 Telegram 按钮同一条 decide() 链路。
      const inbound = this.toCallback(p as unknown as SlackBlockActionsPayload);
      if (inbound) this.inbox.push(inbound);
    }
  }

  private sendEnvelope(body: Record<string, unknown>): void {
    try { this.ws?.send(JSON.stringify(body)); } catch { /* 发送失败交给 onclose */ }
  }

  private teardownSocket(): void {
    try { this.ws?.close(1000, "reconnect"); } catch { /* ignore */ }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.autoReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // 重连失败（拿不到 URL / 连不上）：再排一次，别静默死掉。
        if (!this.closed) this.scheduleReconnect();
      });
    }, SLACK_RECONNECT_DELAY_MS);
  }

  /** 拉一批积压的入站消息（Socket Mode 收到的都堆在 inbox 里）。 */
  async pollOnce(signal?: AbortSignal): Promise<InboundMessage[]> {
    // 首次 pollOnce 才建连接（懒连接：主链路开始轮询才连 Socket Mode）。
    if (!this.ws && !this.closed) {
      try {
        await this.connect();
      } catch (err) {
        // 连接失败（token 死 / 网络不通）：抛给主链路按轮询失败处理（退避重试）。
        throw err;
      }
    }
    const out = this.inbox.splice(0, this.inbox.length);
    return out;
  }

  // ---- 归一化 ----

  /**
   * 审批按钮回调 → InboundMessage：value 只认新版四种回调
   *（`bot:approve-once:<id>` / `bot:approve-session:<id>` /
   * `bot:approve-always:<id>` / `bot:reject:<id>`）与旧版
   * `bot:approve:<id>`（升级前已发出的提示，兼容为批准一次），其余一律
   * 忽略（伪造的回调数据到不了审批层）。
   * 正文转成对应的 /approve / /reject 指令，走同一条确定性指令链路；
   * viaCallback 标记供主链路回 answerCallback 消转圈，callbackId 用
   * trigger_id（Slack 交互 ack 的唯一标识）。
   */
  toCallback(payload: SlackBlockActionsPayload | undefined): InboundMessage | null {
    if (!payload || !payload.actions?.length) return null;
    const action = payload.actions[0];
    if (!action || typeof action.value !== "string") return null;
    const m = /^bot:(approve-once|approve-session|approve-always|approve|reject):([0-9a-f]{8})$/.exec(action.value);
    if (!m) return null;
    const scopeText = m[1] === "approve-session" ? " session" : m[1] === "approve-always" ? " always" : "";
    const command = m[1] === "reject" ? "reject" : "approve";
    const channelId = payload.channel?.id ?? "";
    const userId = payload.user?.id ?? "";
    const threadTs = payload.message?.thread_ts;
    const messageTs = payload.message?.ts ?? "";
    return {
      channel: "slack",
      chatId: channelId,
      threadId: typeof threadTs === "string" && threadTs ? threadTs : null,
      senderId: userId,
      senderRole: "member",
      isMentioned: true,
      messageId: messageTs || `cb-${action.action_id ?? "action"}`,
      text: `/${command} ${m[2]}${scopeText}`,
      attachments: [],
      chatType: channelId.startsWith("D") ? "private" : "group",
      timestamp: Date.now(),
      viaCallback: true,
      callbackId: payload.trigger_id ?? undefined,
    };
  }

  private toInbound(message: SlackAppMentionPayload | SlackMessagePayload, kind: "mention" | "im"): InboundMessage | null {
    if (!message || !message.user || message.bot_id) return null; // 忽略机器人（含自己）
    if (this.botId && message.user === this.botId) return null; // 自己的消息
    const text = message.text ?? "";
    // app_mention 天然是 @；私聊（message.im）本就免 @，isMentioned 置 true 以
    // 免 mentionOnly 群聊门误杀（私聊 chatType 是 private，那道门本就不拦）。
    const isMentioned = kind === "mention" || kind === "im";
    const chatType: BotChatType = kind === "im" ? "private" : "group";
    const channel = message.channel ?? "";
    const attachments: InboundMessage["attachments"] = (message.files ?? []).map((f) => ({
      kind: "attachment",
      fileId: f.id ?? f.url_private ?? "",
      name: f.name,
      sizeBytes: typeof f.size === "number" ? f.size : undefined,
      mimeType: f.mimetype ?? f.filetype,
      width: typeof f.width === "number" ? f.width : undefined,
      height: typeof f.height === "number" ? f.height : undefined,
    })).filter((a) => a.fileId !== "");
    return {
      channel: "slack",
      chatId: channel,
      threadId: typeof message.thread_ts === "string" && message.thread_ts ? message.thread_ts : null,
      senderId: message.user ?? "",
      senderRole: "member",
      isMentioned,
      messageId: message.ts ?? "",
      text,
      attachments,
      chatType,
      timestamp: message.ts ? Math.floor(parseFloat(message.ts) * 1000) : Date.now(),
    };
  }

  // ---- 发消息 / 编辑 ----

  async sendText(msg: OutgoingMessage): Promise<string> {
    const body: Record<string, unknown> = { channel: msg.chatId, text: msg.text };
    if (msg.threadId !== null) body.thread_ts = msg.threadId;
    // 审批按钮：把 inlineKeyboard 转成 Block Kit 的 actions（value 直接沿用
    // callbackData，即 approvalBridge 的 bot:approve:<id> / bot:reject:<id>）。
    if (msg.inlineKeyboard?.length) {
      const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: msg.text } }];
      const elements = msg.inlineKeyboard.flat().map((b) => ({
        type: "button",
        text: { type: "plain_text", text: b.text, emoji: true },
        value: b.callbackData,
        action_id: b.callbackData.startsWith("bot:approve") ? "nyra_approve" : b.callbackData.startsWith("bot:reject:") ? "nyra_reject" : "nyra_action",
      }));
      blocks.push({ type: "actions", elements });
      body.blocks = blocks;
    }
    const sent = await this.callApi<{ ts?: string }>("chat.postMessage", body);
    if (!sent.ts) throw new Error("Slack 未返回消息时间戳");
    return sent.ts;
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    await this.callApi("chat.update", { channel: chatId, ts: messageId, text });
  }

  /**
   * 回应按钮点击（消掉客户端的等待转圈）。Socket Mode 下交互响应走
   * WebSocket 信封（type "interaction"，payload 里带 trigger_id）；文案
   * 只写结论，不带敏感信息。
   */
  async answerCallback(callbackId: string, text: string): Promise<void> {
    this.sendEnvelope({
      type: "interaction",
      payload: {
        type: "ack",
        trigger_id: callbackId,
        text,
      },
    });
  }

  /**
   * 按 file_id 下载附件：先 files.info 拿 url_private（需要 bot token 的
   * files:read scope），再从文件服务下载（带 bot token 的 Authorization 头）。
   * 只报方法名与状态码，不把含 token 的 URL 写进错误文案。
   */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; fileName?: string; mimeType?: string }> {
    const info = await this.callApi<{ file?: { url_private?: string; name?: string; mimetype?: string } }>("files.info", { file: fileId });
    const url = info.file?.url_private;
    if (!url) throw new Error("Slack 未返回附件下载地址");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.botToken}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Slack 附件下载失败（HTTP ${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        bytes: buf,
        fileName: info.file?.name,
        mimeType: info.file?.mimetype,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("Slack 附件下载超时");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 关闭连接（拆掉 Socket Mode、停止重连）。 */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.teardownSocket();
  }
}
