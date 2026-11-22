// tests/node/test-bot-discord.test.ts — Bot 方向：Discord 渠道适配器。
// 全部用注入的假 fetch（REST）与假 WebSocket（Gateway），不联网、不用真实 token。
import { test, expect } from "bun:test";
import { DiscordAdapter, type DiscordWebSocketLike, type WebSocketFactory } from "../../src/bot/channels/discord.ts";

/** 一个可控的假 WebSocket：记录 send 的帧，可手动触发 onmessage/onclose。 */
function fakeWebSocket() {
  const ws: DiscordWebSocketLike & { sent: string[] } = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    send(data: string) { this.sent.push(data); },
    close() { this.onclose?.({ code: 1000 }); },
  };
  return ws;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    seen.push({ url: u, init });
    const result = handler(u, init);
    return new Response(JSON.stringify(result ?? null), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function gatewayFrame(op: number, t?: string, d?: unknown, s?: number | null): string {
  return JSON.stringify({ op, t, d, s: s ?? null });
}

test("Discord：READY 拿到 botId 与 username，MESSAGE_CREATE 归一化", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl } = fakeFetch(() => ({ id: "bot-id", username: "NyraBot" }));
  const adapter = new DiscordAdapter({ token: "discord-token", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  await adapter.pollOnce(); // 触发懒连接
  // 模拟服务器：先 HELLO，再 READY，再 MESSAGE_CREATE
  ws.onopen?.(null);
  ws.onmessage?.({ data: gatewayFrame(10, undefined, { heartbeat_interval: 10000 }) });
  ws.onmessage?.({ data: gatewayFrame(0, "READY", { user: { id: "123456", username: "NyraBot" }, session_id: "sess-1" }) });

  expect(adapter.botId).toBe("123456");
  expect(adapter.botUsername).toBe("NyraBot");

  // 一条 @ 了 bot 的群消息 + 一条私聊消息 + 一条机器人自己发的（应忽略）
  ws.onmessage?.({ data: gatewayFrame(0, "MESSAGE_CREATE", {
    id: "m1", channel_id: "ch-1", guild_id: "g-1",
    author: { id: "u1", username: "user1" },
    content: "<@123456> 你好",
    mentions: [{ id: "123456" }],
    timestamp: "2026-01-01T00:00:00.000Z",
  }) });
  ws.onmessage?.({ data: gatewayFrame(0, "MESSAGE_CREATE", {
    id: "m2", channel_id: "ch-2",
    author: { id: "u2", username: "user2" },
    content: "私聊",
    timestamp: "2026-01-01T00:00:01.000Z",
  }) });
  ws.onmessage?.({ data: gatewayFrame(0, "MESSAGE_CREATE", {
    id: "m3", channel_id: "ch-3",
    author: { id: "123456", username: "NyraBot", bot: true },
    content: "自己发的",
  }) });

  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(2);
  expect(msgs[0].channel).toBe("discord");
  expect(msgs[0].chatId).toBe("ch-1");
  expect(msgs[0].chatType).toBe("group");
  expect(msgs[0].isMentioned).toBe(true);
  expect(msgs[0].text).toBe("<@123456> 你好");
  expect(msgs[1].chatType).toBe("private");
  expect(msgs[1].isMentioned).toBe(false);
  adapter.close();
});

test("Discord：发消息与编辑消息走 REST，token 只进 Authorization 头", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl, seen } = fakeFetch((url, init) => {
    if (url.includes("/messages") && init?.method === "POST") return { id: "sent-1" };
    return {};
  });
  const adapter = new DiscordAdapter({ token: "discord-secret-token", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  const sentId = await adapter.sendText({ chatId: "ch-1", threadId: null, text: "你好" });
  expect(sentId).toBe("sent-1");

  await adapter.editText("ch-1", "sent-1", "改过了");

  // 验证：Authorization 头有 token，但 URL 与错误文案里不含 token。
  const post = seen.find((c) => c.init?.method === "POST")!;
  expect(post.url).toBe("https://discord.com/api/v10/channels/ch-1/messages");
  const auth = (post.init?.headers as Record<string, string>).authorization;
  expect(auth).toBe("Bot discord-secret-token");
  expect(post.url).not.toContain("discord-secret-token");
  adapter.close();
});

test("Discord：REST 失败报错不含 token", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl } = fakeFetch(() => {
    throw new Error("HTTP 401");
  });
  // 用真实的 fetch 失败模拟：handler 抛错 → 换成返回 401 的 Response
  const fetch401 = (async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
  const adapter = new DiscordAdapter({ token: "discord-secret-token", fetchImpl: fetch401, webSocketFactory: factory, autoReconnect: false });
  await expect(adapter.sendText({ chatId: "ch-1", threadId: null, text: "hi" })).rejects.toThrow("HTTP 401");
  adapter.close();
});

test("Discord：空 token 拒绝构造", () => {
  expect(() => new DiscordAdapter({ token: "" })).toThrow("token 为空");
});

test("Discord：getMe 走 REST /users/@me", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl } = fakeFetch(() => ({ id: "me-id", username: "MeBot" }));
  const adapter = new DiscordAdapter({ token: "t", fetchImpl, webSocketFactory: factory, autoReconnect: false });
  const me = await adapter.getMe();
  expect(me.username).toBe("MeBot");
  expect(adapter.botId).toBe("me-id");
  adapter.close();
});

test("Discord：审批按钮 INTERACTION_CREATE 归一化为 /approve 指令", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl } = fakeFetch(() => ({ id: "bot-id", username: "NyraBot" }));
  const adapter = new DiscordAdapter({ token: "t", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  await adapter.pollOnce();
  ws.onopen?.(null);
  ws.onmessage?.({ data: gatewayFrame(10, undefined, { heartbeat_interval: 10000 }) });
  ws.onmessage?.({ data: gatewayFrame(0, "READY", { user: { id: "123456", username: "NyraBot" }, session_id: "sess-1" }) });

  // 批准按钮点击（custom_id = bot:approve:deadbeef）
  ws.onmessage?.({ data: gatewayFrame(0, "INTERACTION_CREATE", {
    id: "inter-1", token: "itok-1", type: 2,
    data: { custom_id: "bot:approve:deadbeef", component_type: 2 },
    member: { user: { id: "u1", username: "admin" } },
    channel_id: "ch-1", guild_id: "g-1",
  }) });
  // 拒绝按钮点击（custom_id = bot:reject:deadbeef）
  ws.onmessage?.({ data: gatewayFrame(0, "INTERACTION_CREATE", {
    id: "inter-2", token: "itok-2", type: 2,
    data: { custom_id: "bot:reject:deadbeef", component_type: 2 },
    user: { id: "u1", username: "admin" },
    channel_id: "ch-1",
  }) });
  // 非审批按钮（custom_id 不匹配）应忽略
  ws.onmessage?.({ data: gatewayFrame(0, "INTERACTION_CREATE", {
    id: "inter-3", token: "itok-3", type: 2,
    data: { custom_id: "other:thing", component_type: 2 },
    user: { id: "u1" }, channel_id: "ch-1",
  }) });

  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(2);
  expect(msgs[0].text).toBe("/approve deadbeef");
  expect(msgs[0].viaCallback).toBe(true);
  expect(msgs[0].callbackId).toBe("inter-1:itok-1");
  expect(msgs[0].senderId).toBe("u1");
  expect(msgs[0].chatType).toBe("group");
  expect(msgs[1].text).toBe("/reject deadbeef");
  expect(msgs[1].chatType).toBe("private");
  adapter.close();
});

test("Discord：sendText 把 inlineKeyboard 转成 components 按钮", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl, seen } = fakeFetch((url, init) => {
    if (url.includes("/messages") && init?.method === "POST") return { id: "sent-1" };
    return {};
  });
  const adapter = new DiscordAdapter({ token: "t", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  await adapter.sendText({
    chatId: "ch-1", threadId: null, text: "需要审批",
    inlineKeyboard: [[
      { text: "✅ 批准", callbackData: "bot:approve:deadbeef" },
      { text: "❌ 拒绝", callbackData: "bot:reject:deadbeef" },
    ]],
  });

  const post = seen.find((c) => c.init?.method === "POST")!;
  const body = JSON.parse(String(post.init?.body)) as { components?: { type: number; components: { custom_id: string; style: number; label: string }[] }[] };
  expect(body.components).toBeDefined();
  expect(body.components?.[0].components.length).toBe(2);
  expect(body.components?.[0].components[0].custom_id).toBe("bot:approve:deadbeef");
  expect(body.components?.[0].components[0].style).toBe(1);
  expect(body.components?.[0].components[1].custom_id).toBe("bot:reject:deadbeef");
  expect(body.components?.[0].components[1].style).toBe(4);
  adapter.close();
});

test("Discord：answerCallback 走交互响应端点", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl, seen } = fakeFetch(() => ({}));
  const adapter = new DiscordAdapter({ token: "t", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  await adapter.answerCallback("inter-1:itok-1", "已批准");
  const cb = seen.find((c) => c.url.includes("/interactions/"))!;
  expect(cb.url).toBe("https://discord.com/api/v10/interactions/inter-1/itok-1/callback");
  const body = JSON.parse(String(cb.init?.body)) as { type: number };
  expect(body.type).toBe(6);
  adapter.close();
});

test("审批按钮回调：新版四种回调转成带档位的 /approve 指令，旧版兼容为批准一次", async () => {
  const ws = fakeWebSocket();
  const factory: WebSocketFactory = () => ws;
  const { fetchImpl } = fakeFetch(() => ({ id: "bot-id", username: "NyraBot" }));
  const adapter = new DiscordAdapter({ token: "discord-token", fetchImpl, webSocketFactory: factory, autoReconnect: false });
  const payload = (customId: string) => ({
    type: 2, id: "inter-1", token: "itok-1",
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: "u1", username: "admin" } },
    channel_id: "ch-1", guild_id: "g-1",
  }) as never;
  expect(adapter.toCallback(payload("bot:approve-once:deadbeef"))?.text).toBe("/approve deadbeef");
  expect(adapter.toCallback(payload("bot:approve-session:deadbeef"))?.text).toBe("/approve deadbeef session");
  expect(adapter.toCallback(payload("bot:approve-always:deadbeef"))?.text).toBe("/approve deadbeef always");
  expect(adapter.toCallback(payload("bot:reject:deadbeef"))?.text).toBe("/reject deadbeef");
  expect(adapter.toCallback(payload("bot:approve:deadbeef"))?.text).toBe("/approve deadbeef");
  expect(adapter.toCallback(payload("other:thing"))).toBeNull();
  adapter.close();
});
