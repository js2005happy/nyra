// src/bot/channels/telegram.ts — Bot 方向 Phase 1：Telegram 渠道适配器。
//
// 收消息用 getUpdates 长轮询（不要 webhook——Nyra 没有公开 URL，轮询
// 不需要公网入口，家里电脑上就能跑）。发消息 sendMessage，占位后编辑
// 用 editMessageText。
//
// 安全：
//   - token 只出现在 Authorization 之外的 URL path 里（Telegram Bot API
//     的规矩）；绝不写进日志、错误文案与审计——报错只说方法名与 HTTP 状态；
//   - 超时用 AbortController 掐断（长轮询 30 秒 + 10 秒余量）；
//   - 测试不依赖真实 token：fetch 可注入，见 tests/node/test-bot-telegram.test.ts。
import type { BotChatType, ChannelAdapter, InboundMessage, OutgoingMessage } from "../types.ts";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
/** getUpdates 长轮询秒数（Telegram 允许 0–50；30 秒是常用值）。 */
export const TELEGRAM_POLL_TIMEOUT_SEC = 30;

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  /** Phase 2：审批按钮回调（callback_data 形如 bot:approve:<id>）。 */
  callback_query?: TelegramCallbackQuery;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: { id: number; username?: string; is_bot?: boolean };
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string };
  message_thread_id?: number;
  from?: { id: number; username?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number; user?: { id: number } }[];
  caption_entities?: { type: string; offset: number; length: number; user?: { id: number } }[];
  photo?: { file_id: string; width?: number; height?: number; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  /** 语音消息（Opus 编码的 OGG；缺口 27：语音入口转文字当任务）。 */
  voice?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
}

export interface TelegramAdapterOptions {
  token: string;
  /** 注入的 fetch（测试用假 API；不传用全局 fetch）。 */
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** 单次 HTTP 超时（毫秒；默认长轮询 30 秒 + 10 秒余量）。 */
  timeoutMs?: number;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = null;
  /** 本 Bot 的 Telegram 用户 id（text_mention 实体靠它判定；getMe 后才有）。 */
  botId: number | null = null;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private offset: number | null = null;

  constructor(opts: TelegramAdapterOptions) {
    if (!opts.token || typeof opts.token !== "string") throw new Error("Telegram Bot token 为空");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? TELEGRAM_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? (TELEGRAM_POLL_TIMEOUT_SEC + 10) * 1000;
  }

  private url(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  private async callApi<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const res = await this.fetchImpl(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        // 只报方法名与状态码：URL 里含 token，绝不能进错误文案。
        throw new Error(`Telegram API 调用失败：${method}（HTTP ${res.status}）`);
      }
      const data = (await res.json()) as { ok?: boolean; result?: T; description?: string };
      if (!data.ok) throw new Error(`Telegram API 返回失败：${method}（${data.description ?? "未知原因"}）`);
      return data.result as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`Telegram API 调用超时：${method}`);
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** 拿一次 Bot 自己的信息（id 与 username，供群聊 @ 判定）。 */
  async getMe(): Promise<{ id: number; username: string | null }> {
    const me = await this.callApi<{ id: number; username?: string }>("getMe");
    this.botId = me.id;
    this.botUsername = me.username ?? null;
    return { id: me.id, username: me.username ?? null };
  }

  async pollOnce(signal?: AbortSignal): Promise<InboundMessage[]> {
    const params: Record<string, unknown> = { timeout: TELEGRAM_POLL_TIMEOUT_SEC };
    if (this.offset !== null) params.offset = this.offset;
    const updates = await this.callApi<TelegramUpdate[]>("getUpdates", params, signal);
    const out: InboundMessage[] = [];
    for (const u of updates ?? []) {
      this.offset = Math.max(this.offset ?? 0, u.update_id + 1);
      const msg = this.toInbound(u.message);
      if (msg) out.push(msg);
      const cb = this.toCallback(u.callback_query);
      if (cb) out.push(cb);
    }
    return out;
  }

  /**
   * 按钮回调 → InboundMessage：新版四种回调（`bot:approve-once:<id>` /
   * `bot:approve-session:<id>` / `bot:approve-always:<id>` /
   * `bot:reject:<id>`）+ 旧版 `bot:approve:<id>`（升级前已发出的提示，
   * 兼容为批准一次），其余一律忽略（伪造的回调数据到不了审批层）。
   * 正文转成对应的 /approve / /reject 指令，走同一条确定性指令链路；
   * viaCallback 标记供主链路回 answerCallbackQuery 消转圈。
   */
  toCallback(query: TelegramCallbackQuery | undefined): InboundMessage | null {
    if (!query || !query.data || query.from?.is_bot) return null;
    const m = /^bot:(approve-once|approve-session|approve-always|approve|reject):([0-9a-f]{8})$/.exec(query.data);
    if (!m) return null;
    const scopeText = m[1] === "approve-session" ? " session" : m[1] === "approve-always" ? " always" : "";
    const command = m[1] === "reject" ? "reject" : "approve";
    const chatId = query.message ? String(query.message.chat.id) : String(query.from.id);
    const threadId = query.message && typeof query.message.message_thread_id === "number"
      ? String(query.message.message_thread_id)
      : null;
    const chatType = (query.message?.chat.type === "private" || query.message?.chat.type === "group" || query.message?.chat.type === "supergroup")
      ? (query.message.chat.type as BotChatType)
      : "private";
    return {
      channel: "telegram",
      chatId,
      threadId,
      senderId: String(query.from.id),
      senderRole: "member",
      isMentioned: true,
      messageId: query.message ? String(query.message.message_id) : `cb-${query.id}`,
      text: `/${command} ${m[2]}${scopeText}`,
      attachments: [],
      chatType,
      timestamp: Date.now(),
      viaCallback: true,
      callbackId: query.id,
    };
  }

  /** 一条 Telegram 消息 → InboundMessage；edited_message 与机器人自己发的消息直接忽略。 */
  toInbound(message: TelegramMessage | undefined): InboundMessage | null {
    if (!message || !message.from || message.from.is_bot) return null;
    const text = message.text ?? message.caption ?? "";
    const entities = message.entities ?? message.caption_entities ?? [];
    const isMentioned = this.checkMentioned(text, entities);
    const attachments: InboundMessage["attachments"] = [];
    if (message.photo?.length) {
      const biggest = message.photo[message.photo.length - 1];
      attachments.push({
        kind: "photo",
        fileId: biggest.file_id,
        sizeBytes: typeof biggest.file_size === "number" ? biggest.file_size : undefined,
        width: typeof biggest.width === "number" ? biggest.width : undefined,
        height: typeof biggest.height === "number" ? biggest.height : undefined,
      });
    }
    if (message.document) {
      attachments.push({
        kind: "document",
        fileId: message.document.file_id,
        name: message.document.file_name,
        sizeBytes: typeof message.document.file_size === "number" ? message.document.file_size : undefined,
        mimeType: message.document.mime_type,
      });
    }
    if (message.voice) {
      attachments.push({
        kind: "voice",
        fileId: message.voice.file_id,
        sizeBytes: typeof message.voice.file_size === "number" ? message.voice.file_size : undefined,
        mimeType: message.voice.mime_type ?? "audio/ogg",
        durationSeconds: typeof message.voice.duration === "number" ? message.voice.duration : undefined,
      });
    }
    const chatType = (message.chat.type === "private" || message.chat.type === "group" || message.chat.type === "supergroup" || message.chat.type === "channel")
      ? (message.chat.type as BotChatType)
      : "group";
    return {
      channel: "telegram",
      chatId: String(message.chat.id),
      threadId: typeof message.message_thread_id === "number" ? String(message.message_thread_id) : null,
      senderId: String(message.from.id),
      senderRole: "member",
      isMentioned,
      messageId: String(message.message_id),
      text,
      attachments,
      chatType,
      timestamp: message.date * 1000,
    };
  }

  private checkMentioned(text: string, entities: { type: string; offset: number; length: number; user?: { id: number } }[]): boolean {
    for (const e of entities) {
      if (e.type === "text_mention") {
        // text_mention 带的是被 @ 的用户对象：只有 @ 到本 Bot 才算；没拿到
        // botId 时宁可漏判（mentionOnly 群里被忽略），也不误判别人的 @。
        if (this.botId !== null && e.user?.id === this.botId) return true;
        continue;
      }
      if (e.type !== "mention") continue;
      const mentioned = text.slice(e.offset, e.offset + e.length).replace(/^@/, "");
      if (this.botUsername && mentioned.toLowerCase() === this.botUsername.toLowerCase()) return true;
      if (!this.botUsername && mentioned) return true;
    }
    return false;
  }

  async sendText(msg: OutgoingMessage): Promise<string> {
    const body: Record<string, unknown> = { chat_id: Number(msg.chatId), text: msg.text };
    if (msg.threadId !== null) body.message_thread_id = Number(msg.threadId);
    if (msg.replyToMessageId) body.reply_to_message_id = Number(msg.replyToMessageId);
    if (msg.inlineKeyboard?.length) {
      body.reply_markup = {
        inline_keyboard: msg.inlineKeyboard.map((row) =>
          row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
        ),
      };
    }
    const sent = await this.callApi<{ message_id: number }>("sendMessage", body);
    return String(sent.message_id);
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    await this.callApi("editMessageText", { chat_id: Number(chatId), message_id: Number(messageId), text });
  }

  /** 回应按钮点击（消掉客户端的等待转圈；文案只写结论，不带敏感信息）。 */
  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.callApi("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  /**
   * 按 file_id 下载附件：先 getFile 拿 file_path，再从文件服务下载。
   * 只报方法名与状态码，不把含 token 的 URL 写进错误文案；下载本身不
   * 经过 callApi（文件服务返回的是二进制，不是 JSON 信封）。
   */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; fileName?: string; mimeType?: string }> {
    const info = await this.callApi<{ file_id: string; file_path?: string }>("getFile", { file_id: fileId });
    if (!info.file_path) throw new Error("Telegram 未返回附件下载地址");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/file/bot${this.token}/${info.file_path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Telegram 文件下载失败（HTTP ${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { bytes: buf };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("Telegram 文件下载超时");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
