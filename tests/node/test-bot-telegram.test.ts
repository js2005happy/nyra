// tests/node/test-bot-telegram.test.ts — Bot 方向 Phase 1：Telegram 渠道适配器。
// 全部用注入的假 fetch，不联网、不用真实 token。
import { test, expect } from "bun:test";
import { TelegramAdapter } from "../../src/bot/channels/telegram.ts";

interface SeenCall {
  url: string;
  body: Record<string, unknown> | null;
}

function fakeFetchFactory(handler: (url: string, body: Record<string, unknown> | null) => unknown) {
  const seen: SeenCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    let body: Record<string, unknown> | null = null;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)) as Record<string, unknown>; } catch { body = null; }
    }
    seen.push({ url: u, body });
    const result = handler(u, body);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function update(updateId: number, message: Record<string, unknown>): Record<string, unknown> {
  return { update_id: updateId, message };
}

test("getUpdates 归一化：私聊与群聊、@ 判定、机器人自己的消息忽略", async () => {
  const { fetchImpl, seen } = fakeFetchFactory((url, body) => {
    if (url.includes("/getMe")) return { id: 999, username: "NyraTestBot" };
    if (url.includes("/getUpdates")) {
      if (typeof body?.offset === "number") return [];
      return [
        update(10, {
          message_id: 1, date: 1700000000,
          chat: { id: 7, type: "private" },
          from: { id: 7, username: "user" }, text: "你好",
        }),
        update(11, {
          message_id: 2, date: 1700000001,
          chat: { id: -100, type: "supergroup", title: "群" },
          from: { id: 8 }, text: "@NyraTestBot 在吗",
          entities: [{ type: "mention", offset: 0, length: 12 }],
        }),
        update(12, {
          message_id: 3, date: 1700000002,
          chat: { id: -100, type: "supergroup" },
          from: { id: 8 }, text: "没 @ 的群消息",
        }),
        update(13, {
          message_id: 4, date: 1700000003,
          chat: { id: 7, type: "private" },
          from: { id: 999, is_bot: true }, text: "机器人自己发的",
        }),
      ];
    }
    return null;
  });
  const adapter = new TelegramAdapter({ token: "123:TESTTOKEN", fetchImpl });
  await adapter.getMe();
  expect(adapter.botUsername).toBe("NyraTestBot");
  expect(adapter.botId).toBe(999);
  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(3);
  expect(msgs[0].chatId).toBe("7");
  expect(msgs[0].chatType).toBe("private");
  expect(msgs[0].isMentioned).toBe(false);
  expect(msgs[1].chatId).toBe("-100");
  expect(msgs[1].isMentioned).toBe(true);
  expect(msgs[2].isMentioned).toBe(false);
  // offset 前进：第二轮不再重复拉到同一批
  const second = await adapter.pollOnce();
  expect(second).toEqual([]);
  const updatesCalls = seen.filter((c) => c.url.includes("/getUpdates"));
  expect(updatesCalls[updatesCalls.length - 1]?.body?.offset).toBe(14);
});

test("getUpdates：话题 id、附件、caption 都归一化", async () => {
  const { fetchImpl } = fakeFetchFactory((url) => {
    if (url.includes("/getUpdates")) {
      return [
        update(20, {
          message_id: 5, date: 1700000100,
          chat: { id: -100, type: "supergroup" },
          message_thread_id: 3,
          from: { id: 8 }, caption: "看这张图",
          photo: [{ file_id: "small" }, { file_id: "big" }],
          caption_entities: [],
        }),
        update(21, {
          message_id: 6, date: 1700000101,
          chat: { id: 9, type: "private" },
          from: { id: 9 }, text: "",
          document: { file_id: "doc1", file_name: "a.pdf" },
        }),
      ];
    }
    return null;
  });
  const adapter = new TelegramAdapter({ token: "123:TESTTOKEN", fetchImpl });
  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(2);
  expect(msgs[0].threadId).toBe("3");
  expect(msgs[0].text).toBe("看这张图");
  expect(msgs[0].attachments).toEqual([{ kind: "photo", fileId: "big" }]);
  expect(msgs[1].attachments).toEqual([{ kind: "document", fileId: "doc1", name: "a.pdf" }]);
});

test("sendText 与 editText：发到正确的 chat，返回平台消息 id", async () => {
  const { fetchImpl, seen } = fakeFetchFactory((url) => {
    if (url.includes("/sendMessage")) return { message_id: 77 };
    if (url.includes("/editMessageText")) return true;
    return null;
  });
  const adapter = new TelegramAdapter({ token: "123:TESTTOKEN", fetchImpl });
  const id = await adapter.sendText({ chatId: "-100", threadId: "3", text: "处理中…" });
  expect(id).toBe("77");
  const sendCall = seen.find((c) => c.url.includes("/sendMessage"));
  expect(sendCall?.body?.chat_id).toBe(-100);
  expect(sendCall?.body?.message_thread_id).toBe(3);
  expect(sendCall?.body?.text).toBe("处理中…");
  await adapter.editText("-100", "77", "好了");
  const editCall = seen.find((c) => c.url.includes("/editMessageText"));
  expect(editCall?.body?.message_id).toBe(77);
  expect(editCall?.body?.text).toBe("好了");
});

test("API 失败时报错不含 token", async () => {
  const fetchImpl = (async (): Promise<Response> => {
    return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked" }), { status: 403 });
  }) as unknown as typeof fetch;
  const adapter = new TelegramAdapter({ token: "123:SECRETTOKEN", fetchImpl });
  let message = "";
  try {
    await adapter.sendText({ chatId: "7", threadId: null, text: "hi" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("HTTP 403");
  expect(message).not.toContain("SECRETTOKEN");
  expect(message).not.toContain("123:");
});

test("空 token 拒绝构造", () => {
  expect(() => new TelegramAdapter({ token: "" })).toThrow("token 为空");
});

test("@ 判定：没拿到用户名时看文本里的 @，text_mention 只认本 Bot", async () => {
  const { fetchImpl } = fakeFetchFactory((url) => {
    if (url.includes("/getUpdates")) {
      return [
        update(30, {
          message_id: 9, date: 1700000200,
          chat: { id: -100, type: "supergroup" },
          from: { id: 8 }, text: "@Someone 你好",
          entities: [{ type: "mention", offset: 0, length: 9 }],
        }),
        update(31, {
          message_id: 10, date: 1700000201,
          chat: { id: -100, type: "supergroup" },
          from: { id: 8 }, text: "点名",
          entities: [{ type: "text_mention", offset: 0, length: 2, user: { id: 555 } }],
        }),
      ];
    }
    return null;
  });
  const adapter = new TelegramAdapter({ token: "123:TESTTOKEN", fetchImpl });
  const msgs = await adapter.pollOnce();
  // 没调 getMe：mention 看文本里有 @ 就算；text_mention 没 botId 时宁可漏判
  expect(msgs[0].isMentioned).toBe(true);
  expect(msgs[1].isMentioned).toBe(false);
});

test("审批按钮回调：新版四种回调转成带档位的 /approve 指令，旧版兼容为批准一次", async () => {
  const adapter = new TelegramAdapter({ token: "t" });
  const query = (data: string) => ({
    id: "q1", data, from: { id: 7 },
    message: { message_id: 5, chat: { id: 7, type: "private" } },
  }) as never;
  expect(adapter.toCallback(query("bot:approve-once:deadbeef"))?.text).toBe("/approve deadbeef");
  expect(adapter.toCallback(query("bot:approve-session:deadbeef"))?.text).toBe("/approve deadbeef session");
  expect(adapter.toCallback(query("bot:approve-always:deadbeef"))?.text).toBe("/approve deadbeef always");
  expect(adapter.toCallback(query("bot:reject:deadbeef"))?.text).toBe("/reject deadbeef");
  // 旧版 bot:approve:<id>（升级前已发出的提示）兼容为批准一次。
  expect(adapter.toCallback(query("bot:approve:deadbeef"))?.text).toBe("/approve deadbeef");
  // 别的回调一律忽略。
  expect(adapter.toCallback(query("bot:approve-session:xyz"))).toBeNull();
  expect(adapter.toCallback(query("other:thing"))).toBeNull();
});
