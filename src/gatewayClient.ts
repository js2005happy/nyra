// src/gatewayClient.ts — CLI/定时任务/群聊接 gateway 用的 HTTP 客户端。
// 与 gateway 共用同一份会话：所有写操作都走 gateway 的 API，不在本进程
// 另起 agent，所以双客户端看到的会话、队列、历史完全一致。
export interface GatewayClientOptions {
  url?: string;
  token?: string;
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
