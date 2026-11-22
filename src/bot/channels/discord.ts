// src/bot/channels/discord.ts — Bot 方向：Discord 渠道适配器。
//
// Discord 与 Telegram 的关键不同：收消息靠 Gateway WebSocket 事件推送
//（MESSAGE_CREATE），不是 REST 轮询。发消息 / 编辑消息走 REST API
//（https://discord.com/api/v10）。本适配器把 Gateway 收到的消息压进内部
// 队列，`pollOnce` 出队——对主链路来说仍然是"拉一批"的同一形状，只是
// 底层从"主动轮询"换成"事件推送 + 缓冲"。
//
// 安全（与 Telegram 同口径）：
//   - bot token 只出现在 Authorization 头里，绝不写进日志、错误文案与审计；
//     报错只说方法名与 HTTP 状态；
//   - 需要 Message Content 这个 privileged intent 才能读到消息正文（Discord
//     开发者门户要开，代码里也要声明）；不开的话 MESSAGE_CREATE 的 content
//     是空串，纯内容型响应会失效——本适配器照常归一化，正文为空就走空。
//   - 群聊 @ 判定用消息自带的 mentions 数组（比 Telegram 的实体解析更直接）；
//   - 测试不依赖真实 token / 真实 WebSocket：fetch 与 WebSocket 工厂都可注入。
import type { BotChatType, ChannelAdapter, InboundMessage, OutgoingMessage } from "../types.ts";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** 心跳间隔（毫秒）；Discord 服务器会在 HELLO 里给 heartbeat_interval，这里只是兜底。 */
export const DISCORD_HEARTBEAT_FALLBACK_MS = 41250;

// Discord 的 Gateway intents 位掩码（只在 IDENTIFY 里声明要收哪些事件）。
// 我们需要：GUILDS(1<<0) + GUILD_MESSAGES(1<<9) + MESSAGE_CONTENT(1<<15)。
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  mentions?: { id: string; username?: string }[];
  attachments?: { id: string; filename?: string; size?: number; content_type?: string; width?: number; height?: number }[];
  guild_id?: string;
  timestamp?: string;
}

interface DiscordGatewayEvent {
  op: number;
  d?: unknown;
  t?: string;
  s?: number | null;
}

/** 审批按钮回调（INTERACTION_CREATE 的 message component）结构。 */
interface DiscordInteractionPayload {
  id: string;
  token: string;
  type: number; // 2 = MESSAGE_COMPONENT（按钮点击）
  data?: { custom_id?: string; component_type?: number };
  member?: { user?: { id: string; username?: string } };
  user?: { id: string; username?: string };
  message?: { id: string; channel_id: string };
  channel_id?: string;
  guild_id?: string;
}

/** 审批按钮回调的 custom_id 前缀（与 approvalBridge 的 APPROVAL_CALLBACK_PREFIX 一致）。 */
export const DISCORD_APPROVE_BUTTON_PREFIX = "bot:";

/** 可注入的 WebSocket 工厂（测试用 mock；不传用全局 WebSocket）。 */
export interface DiscordWebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => DiscordWebSocketLike;

export interface DiscordAdapterOptions {
  token: string;
  /** 注入的 fetch（测试用假 API；不传用全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 注入的 WebSocket 工厂（测试用假网关；不传用全局 WebSocket）。 */
  webSocketFactory?: WebSocketFactory;
  apiBase?: string;
  /** 单次 HTTP 超时（毫秒）。 */
  timeoutMs?: number;
  /** 是否禁用断线自动重连（测试用；默认启用）。 */
  autoReconnect?: boolean;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly channel = "discord" as const;
  botUsername: string | null = null;
  /** 本 Bot 的 Discord 用户 id（@ 判定与忽略自己发的消息用）。 */
  botId: string | null = null;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly autoReconnect: boolean;
  /** Gateway 收到的消息缓冲（pollOnce 从这里出队）。 */
  private inbox: InboundMessage[] = [];
  private ws: DiscordWebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval = DISCORD_HEARTBEAT_FALLBACK_MS;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: DiscordAdapterOptions) {
    if (!opts.token || typeof opts.token !== "string") throw new Error("Discord Bot token 为空");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? DISCORD_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.webSocketFactory = opts.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as DiscordWebSocketLike);
    this.autoReconnect = opts.autoReconnect !== false;
  }

  // ---- REST（发消息 / 编辑消息 / 拿自己信息）----

  private async callApi<T>(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          "authorization": `Bot ${this.token}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        // 只报方法名与状态码：Authorization 头里含 token，绝不能进错误文案。
        throw new Error(`Discord API 调用失败：${method} ${path}（HTTP ${res.status}）`);
      }
      if (res.status === 204) return undefined as unknown as T;
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`Discord API 调用超时：${method} ${path}`);
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    // 这里先建一个占位：真正拿自己信息要在 Gateway READY 里拿到（见 onReady）。
    // REST 也能拿（/users/@me），但 Gateway READY 已经带了，这里 REST 兜底。
    const me = await this.callApi<{ id: string; username: string }>("GET", "/users/@me");
    this.botId = me.id;
    this.botUsername = me.username;
    return { id: Number(me.id), username: me.username };
  }

  // ---- Gateway（收消息）----

  /** 建立 Gateway 连接（IDENTIFY 握手 + heartbeat + 断线重连）。 */
  connect(): void {
    if (this.closed) return;
    if (this.ws) return; // 已连接中
    const ws = this.webSocketFactory(DISCORD_GATEWAY_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.sendGateway({ op: 2, d: this.identifyPayload() });
    };
    ws.onmessage = (ev) => this.onGatewayMessage(ev);
    ws.onclose = (ev) => {
      this.teardownHeartbeat();
      this.ws = null;
      this.connected = false;
      if (!this.closed && this.autoReconnect) this.scheduleReconnect();
    };
    ws.onerror = () => { /* 出错交给 onclose 处理重连 */ };
  }

  private identifyPayload(): Record<string, unknown> {
    return {
      token: this.token,
      intents: DISCORD_INTENTS,
      properties: { os: "linux", browser: "nyra", device: "nyra" },
      ...(this.sessionId && this.seq !== null ? { session_id: this.sessionId, seq: this.seq } : {}),
    };
  }

  private sendGateway(payload: Record<string, unknown>): void {
    try { this.ws?.send(JSON.stringify(payload)); } catch { /* 发送失败交给 onclose */ }
  }

  private onGatewayMessage(ev: { data: unknown }): void {
    let msg: DiscordGatewayEvent;
    try {
      msg = JSON.parse(String(ev.data)) as DiscordGatewayEvent;
    } catch {
      return; // 非 JSON 帧丢弃
    }
    if (msg.s !== null && msg.s !== undefined) this.seq = msg.s;
    switch (msg.op) {
      case 10: { // HELLO：拿到心跳间隔，开始心跳。
        const d = (msg.d ?? {}) as { heartbeat_interval?: number };
        if (typeof d.heartbeat_interval === "number" && d.heartbeat_interval > 0) {
          this.heartbeatInterval = d.heartbeat_interval;
        }
        this.startHeartbeat();
        break;
      }
      case 11: // HEARTBEAT_ACK：心跳被确认，无需动作。
        break;
      case 0: { // DISPATCH：事件。
        this.onDispatch(msg.t, msg.d);
        break;
      }
      case 7: // RECONNECT：服务器要求重连。
        this.scheduleReconnect();
        break;
      case 9: // INVALID_SESSION：会话失效，清掉 session 重新 IDENTIFY。
        this.sessionId = null;
        this.seq = null;
        this.sendGateway({ op: 2, d: this.identifyPayload() });
        break;
      default:
        break;
    }
  }

  private onDispatch(type: string | undefined, data: unknown): void {
    if (type === "READY") {
      const d = (data ?? {}) as { user?: { id: string; username: string }; session_id?: string };
      if (d.user) {
        this.botId = d.user.id;
        this.botUsername = d.user.username;
      }
      if (d.session_id) this.sessionId = d.session_id;
      this.connected = true;
      return;
    }
    if (type === "MESSAGE_CREATE") {
      const inbound = this.toInbound(data as DiscordMessage | undefined);
      if (inbound) this.inbox.push(inbound);
    }
    if (type === "INTERACTION_CREATE") {
      // 审批按钮回调：把 message component 交互归一化成 viaCallback 的
      // InboundMessage，走与 Telegram 按钮同一条 decide() 链路。
      const inbound = this.toCallback(data as DiscordInteractionPayload | undefined);
      if (inbound) this.inbox.push(inbound);
    }
  }

  private startHeartbeat(): void {
    this.teardownHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendGateway({ op: 1, d: this.seq });
    }, this.heartbeatInterval);
  }

  private teardownHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.autoReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  /** 拉一批积压的入站消息（Gateway 收到的消息都堆在 inbox 里）。 */
  async pollOnce(signal?: AbortSignal): Promise<InboundMessage[]> {
    // 首次 pollOnce 才建连接（懒连接：主链路开始轮询才连 Gateway）。
    if (!this.ws && !this.closed) this.connect();
    const out = this.inbox.splice(0, this.inbox.length);
    return out;
  }

  // ---- 归一化 ----

  /**
   * 审批按钮回调 → InboundMessage：custom_id 只认新版四种回调
   *（`bot:approve-once:<id>` / `bot:approve-session:<id>` /
   * `bot:approve-always:<id>` / `bot:reject:<id>`）与旧版
   * `bot:approve:<id>`（升级前已发出的提示，兼容为批准一次），其余一律
   * 忽略（伪造的回调到不了审批层）。正文转成对应的 /approve / /reject
   * 指令，走同一条确定性指令链路；viaCallback 标记供主链路回
   * answerCallback 消转圈，callbackId 用 interaction 的 `id:token`
   *（Discord 交互响应端点的路径）。
   */
  toCallback(payload: DiscordInteractionPayload | undefined): InboundMessage | null {
    if (!payload || payload.type !== 2) return null; // 只认按钮点击（MESSAGE_COMPONENT）
    const customId = payload.data?.custom_id;
    if (typeof customId !== "string") return null;
    const m = /^bot:(approve-once|approve-session|approve-always|approve|reject):([0-9a-f]{8})$/.exec(customId);
    if (!m) return null;
    const scopeText = m[1] === "approve-session" ? " session" : m[1] === "approve-always" ? " always" : "";
    const command = m[1] === "reject" ? "reject" : "approve";
    const user = payload.member?.user ?? payload.user;
    const channelId = payload.channel_id ?? payload.message?.channel_id ?? "";
    const messageId = payload.message?.id ?? "";
    return {
      channel: "discord",
      chatId: channelId,
      threadId: null,
      senderId: user?.id ?? "",
      senderRole: "member",
      isMentioned: true,
      messageId: messageId || `cb-${payload.id}`,
      text: `/${command} ${m[2]}${scopeText}`,
      attachments: [],
      chatType: payload.guild_id ? "group" : "private",
      timestamp: Date.now(),
      viaCallback: true,
      callbackId: payload.token ? `${payload.id}:${payload.token}` : payload.id,
    };
  }

  private toInbound(message: DiscordMessage | undefined): InboundMessage | null {
    if (!message || !message.author || message.author.bot) return null; // 忽略机器人（含自己）
    const isMentioned = (message.mentions ?? []).some((m) => m.id === this.botId) || false;
    const attachments: InboundMessage["attachments"] = (message.attachments ?? []).map((a) => ({
      kind: "attachment",
      fileId: a.id,
      name: a.filename,
      sizeBytes: typeof a.size === "number" ? a.size : undefined,
      mimeType: a.content_type,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
    }));
    const chatType: BotChatType = message.guild_id ? "group" : "private";
    return {
      channel: "discord",
      chatId: message.channel_id,
      threadId: null,
      senderId: message.author.id,
      senderRole: "member",
      isMentioned,
      messageId: message.id,
      text: message.content ?? "",
      attachments,
      chatType,
      timestamp: message.timestamp ? Date.parse(message.timestamp) : Date.now(),
    };
  }

  // ---- 发消息 / 编辑 ----

  async sendText(msg: OutgoingMessage): Promise<string> {
    const body: Record<string, unknown> = { content: msg.text };
    if (msg.replyToMessageId) {
      body.message_reference = { message_id: msg.replyToMessageId };
    }
    // 审批按钮：把 inlineKeyboard 转成 components（action row + button）。
    // custom_id 沿用 callbackData（即 approvalBridge 的 bot:approve:<id> /
    // bot:reject:<id>），点击后经 INTERACTION_CREATE 推回，走 decide() 链路。
    if (msg.inlineKeyboard?.length) {
      const components = msg.inlineKeyboard.map((row) => ({
        type: 1, // action row
        components: row.map((b) => ({
          type: 2, // button
          style: b.callbackData.startsWith("bot:reject:") ? 4 : 1, // 拒绝=红(4)、批准=蓝(1)
          label: b.text,
          custom_id: b.callbackData,
        })),
      }));
      body.components = components;
    }
    const sent = await this.callApi<{ id: string }>("POST", `/channels/${msg.chatId}/messages`, body);
    return sent.id;
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    await this.callApi("PATCH", `/channels/${chatId}/messages/${messageId}`, { content: text });
  }

  /**
   * 回应按钮点击（消掉客户端的等待转圈）。callbackId 是 `id:token`（见
   * toCallback），走 Discord 交互响应端点；type 6 是 deferred ack（先确认
   * 收到，后续可编辑）。只报方法名与状态码，token 不进错误文案。
   */
  async answerCallback(callbackId: string, text: string): Promise<void> {
    const idx = callbackId.indexOf(":");
    const interactionId = idx > 0 ? callbackId.slice(0, idx) : callbackId;
    const token = idx > 0 ? callbackId.slice(idx + 1) : "";
    await this.callApi("POST", `/interactions/${interactionId}/${token}/callback`, { type: 6, data: { content: text } });
  }

  /** 关闭连接（停止心跳、断开 Gateway）。 */
  close(): void {
    this.closed = true;
    this.teardownHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(1000, "shutdown"); } catch { /* ignore */ }
    this.ws = null;
    this.connected = false;
  }
}
