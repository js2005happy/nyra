// src/gatewayClient.ts — CLI/定时任务/群聊接 gateway 用的 HTTP 客户端。
// 与 gateway 共用同一份会话：所有写操作都走 gateway 的 API，不在本进程
// 另起 agent，所以双客户端看到的会话、队列、历史完全一致。
export interface GatewayClientOptions {
  url?: string;
  token?: string;
}

/** 现有 session SSE 的 JSON data envelope；普通事件含 seq，run_finished 不含 seq。 */
export interface GatewaySessionEvent extends Record<string, unknown> {
  type: string;
  seq?: number;
}

export interface GatewaySessionEventOptions {
  /** 与 /api/sessions/:id/events?since= 一致：下一条期望的事件序号。 */
  since?: number;
  /** 取消订阅；也可通过结束 AsyncIterable 消费来关闭当前连接。 */
  signal?: AbortSignal;
  /** 服务端连接意外断开或网络错误后的等待时间，默认 250ms。 */
  reconnectDelayMs?: number;
}

class GatewayEventStreamError extends Error {}

function parseSseFrame(frame: string): GatewaySessionEvent | null {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (!data.length) return null;
  let value: unknown;
  try { value = JSON.parse(data.join("\n")); }
  catch { throw new GatewayEventStreamError("Gateway 返回了无效的 SSE JSON 事件"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).type !== "string") {
    throw new GatewayEventStreamError("Gateway SSE 事件格式无效");
  }
  return value as GatewaySessionEvent;
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<GatewaySessionEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      else if (done) buffer += decoder.decode();
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSseFrame(frame);
        if (event) yield event;
      }
      if (done) {
        if (buffer.trim()) {
          const event = parseSseFrame(buffer);
          if (event) yield event;
        }
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try { await reader.cancel(); } catch { /* 已关闭或已取消 */ }
    try { reader.releaseLock(); } catch { /* reader 已释放 */ }
  }
}

function waitToReconnect(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (keepGoing: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(keepGoing);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class GatewayClient {
  baseUrl: string;
  token: string;

  constructor(opts: GatewayClientOptions = {}) {
    const raw = opts.url ?? process.env.NYRA_GATEWAY_URL ?? "http://127.0.0.1:8765";
    this.baseUrl = raw.replace(/\/$/, "").replace(/\?token=.*$/, "");
    this.token = opts.token ?? process.env.NYRA_GATEWAY_TOKEN ?? "";
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "X-Nyra-Token": this.token, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  health(): Promise<unknown> { return this.call("/api/health"); }
  sessions(): Promise<unknown> { return this.call("/api/sessions"); }
  createSession(): Promise<{ id: string }> { return this.call("/api/sessions", { method: "POST", body: "{}" }) as Promise<{ id: string }>; }
  sessionView(id: string, since = 0): Promise<unknown> { return this.call(`/api/sessions/${encodeURIComponent(id)}?since=${since}`); }
  history(id: string): Promise<{ messages: { id: number; role: string; text: string }[] }> {
    return this.call(`/api/sessions/${encodeURIComponent(id)}/history`) as Promise<{ messages: { id: number; role: string; text: string }[] }>;
  }
  send(id: string, text: string): Promise<unknown> {
    return this.call(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  }
  approvals(): Promise<unknown> { return this.call("/api/approvals"); }
  /**
   * 消费现有会话 SSE，并在连接意外结束时从最后收到的 seq + 1 续接。
   * 仅用当前协议里的 event.seq 去重；SSE id 和服务端 API 均不作假设。
   * run_finished 是现有协议中的终止事件，不含 seq。
   */
  async *sessionEvents(id: string, options: GatewaySessionEventOptions = {}): AsyncGenerator<GatewaySessionEvent> {
    const signal = options.signal;
    const initialSince = options.since ?? 0;
    let cursor = Number.isSafeInteger(initialSince) && initialSince >= 0 ? initialSince : 0;
    const requestedDelay = options.reconnectDelayMs ?? 250;
    const reconnectDelayMs = Number.isFinite(requestedDelay) ? Math.max(0, Math.min(30_000, requestedDelay)) : 250;
    const url = () => `${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/events?since=${cursor}`;

    while (!signal?.aborted) {
      let response: Response;
      try {
        response = await fetch(url(), {
          headers: { "X-Nyra-Token": this.token, "Content-Type": "application/json" },
          signal,
        });
      } catch {
        if (signal?.aborted || !(await waitToReconnect(reconnectDelayMs, signal))) return;
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        let message = `HTTP ${response.status}`;
        try {
          const body = JSON.parse(text) as { error?: unknown };
          if (typeof body.error === "string") message = body.error;
        } catch { /* 非 JSON 响应 */ }
        throw new Error(message);
      }
      if (!response.body) {
        if (!(await waitToReconnect(reconnectDelayMs, signal))) return;
        continue;
      }

      try {
        for await (const event of readSseEvents(response.body, signal)) {
          if (signal?.aborted) return;
          const seq = event.seq;
          if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
            // since 是“下一条期望事件”的索引；seq 是当前 session event envelope 的真实字段。
            if (seq < cursor) continue;
            cursor = seq + 1;
          }
          yield event;
          if (event.type === "run_finished") return;
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof GatewayEventStreamError) throw err;
        // 传输中断时，cursor 保留在最后接受的 seq + 1，下一次 GET 会补齐后续事件。
      }
      if (!(await waitToReconnect(reconnectDelayMs, signal))) return;
    }
  }
  decide(id: string, approve: boolean, always = false): Promise<unknown> {
    return this.call(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ approve, always }) });
  }
  /** 手机开完全模式的待确认请求（机主在电脑上看）。 */
  modeRequests(): Promise<{ requests: { id: string; device: string; created_at: string; expires_at: string }[] }> {
    return this.call("/api/mode/requests") as Promise<{ requests: { id: string; device: string; created_at: string; expires_at: string }[] }>;
  }
  /** 机主在电脑上确认/拒绝一笔完全模式请求。 */
  modeConfirm(id: string, approve: boolean): Promise<unknown> {
    return this.call("/api/mode/confirm", { method: "POST", body: JSON.stringify({ request_id: id, approve }) });
  }
  rewind(id: string, messageId: number, action: "truncate" | "edit" | "fork", text?: string | null): Promise<unknown> {
    return this.call(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
      method: "POST", body: JSON.stringify({ message_id: messageId, action, text: text ?? null }),
    });
  }
  info(): Promise<unknown> { return this.call("/api/info"); }
  /** H1：最近用过哪些客户端（机主在电脑上查；半夜多一个陌生客户端立刻能看见）。 */
  clients(): Promise<{ clients: { client: string; kind: string; first_seen: string; last_seen: string; rounds: number }[] }> {
    return this.call("/api/clients") as Promise<{ clients: { client: string; kind: string; first_seen: string; last_seen: string; rounds: number }[] }>;
  }
  /** H2：网关 presence——桌面是否活跃、要不要推手机、当前活跃的客户端。 */
  presence(): Promise<{ desktop_active: boolean; should_notify_mobile: boolean; window_ms: number; active: { client: string; kind: string; surface: string; last_active: string }[]; clients: { client: string; kind: string; surface: string; first_seen: string; last_active: string; heartbeats: number }[] }> {
    return this.call("/api/presence") as Promise<{ desktop_active: boolean; should_notify_mobile: boolean; window_ms: number; active: { client: string; kind: string; surface: string; last_active: string }[]; clients: { client: string; kind: string; surface: string; first_seen: string; last_active: string; heartbeats: number }[] }>;
  }
  /** H2：报一次心跳（surface 不传时网关按 token 类型推断）。 */
  presenceHeartbeat(surface?: string): Promise<{ ok: boolean; throttled: boolean; desktop_active: boolean; should_notify_mobile: boolean }> {
    return this.call("/api/presence/heartbeat", { method: "POST", body: JSON.stringify(surface === undefined ? {} : { surface }) }) as Promise<{ ok: boolean; throttled: boolean; desktop_active: boolean; should_notify_mobile: boolean }>;
  }
  schedule(): Promise<unknown> { return this.call("/api/schedule"); }
}
