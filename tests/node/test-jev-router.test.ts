// tests/node/test-jev-router.test.ts — M2（OpenMausBot 的 Jev 式快速决策路由借鉴）：
// 没 @ 谁时便宜模型先判该谁接；判不出来回落全员回答。
// 只借“先分流、再执行”，硬顶语义不变：路由只决定谁回答，
// 选中的 Bot 照样走审批、预算、证据链。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupStore } from "../../src/groups.ts";
import {
  jevPrompt,
  jevRouterConfig,
  parseJevReply,
  routeMessage,
  type JevDecider,
  type JevMember,
} from "../../src/jevRouter.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "nyra-jev-"));
}

const MEMBERS: JevMember[] = [
  { id: "bot-a", name: "甲", role: "查资料" },
  { id: "bot-b", name: "乙", role: "写代码" },
];

test("JevRouterTest.test_route_picks_confident_member", async () => {
  const decider: JevDecider = async () => ({ member: "bot-b", confidence: 0.9 });
  const d = await routeMessage("帮我写个函数", MEMBERS, decider);
  expect(d.member).toBe("bot-b");
  expect(d.confidence).toBe(0.9);
  expect(d.fallback).toBe(false);
});

test("JevRouterTest.test_route_falls_back_below_threshold", async () => {
  const decider: JevDecider = async () => ({ member: "bot-b", confidence: 0.5 });
  const d = await routeMessage("帮我写个函数", MEMBERS, decider);
  expect(d.member).toBeNull();
  expect(d.fallback).toBe(true);
  expect(d.reason).toContain("低于阈值");
  // 阈值可调：0.4 时 0.5 就够了。
  const ok = await routeMessage("帮我写个函数", MEMBERS, decider, { threshold: 0.4 });
  expect(ok.member).toBe("bot-b");
});

test("JevRouterTest.test_route_falls_back_on_unknown_member_bad_confidence_and_errors", async () => {
  const unknown: JevDecider = async () => ({ member: "bot-z", confidence: 0.9 });
  expect((await routeMessage("hi", MEMBERS, unknown)).fallback).toBe(true);
  const outOfRange: JevDecider = async () => ({ member: "bot-a", confidence: 1.5 });
  const d2 = await routeMessage("hi", MEMBERS, outOfRange);
  expect(d2.member).toBeNull();
  expect(d2.reason).toContain("越界");
  const none: JevDecider = async () => null;
  expect((await routeMessage("hi", MEMBERS, none)).fallback).toBe(true);
  const boom: JevDecider = async () => { throw new Error("模型挂了"); };
  const d4 = await routeMessage("hi", MEMBERS, boom);
  expect(d4.member).toBeNull();
  expect(d4.reason).toContain("模型挂了");
});

test("JevRouterTest.test_route_single_member_needs_no_decider_call", async () => {
  let called = 0;
  const decider: JevDecider = async () => { called += 1; return { member: "bot-a", confidence: 0.9 }; };
  const d = await routeMessage("hi", MEMBERS.slice(0, 1), decider);
  expect(d.member).toBe("bot-a");
  expect(called).toBe(0);
});

test("JevRouterTest.test_parse_reply_json_and_fence", () => {
  expect(parseJevReply('{"member": "bot-b", "confidence": 0.8}')).toEqual({ member: "bot-b", confidence: 0.8 });
  expect(parseJevReply('```json\n{"member": "bot-a", "confidence": 0.7}\n```')).toEqual({ member: "bot-a", confidence: 0.7 });
  expect(parseJevReply("这事该乙做")).toBeNull();
  expect(parseJevReply('{"member": "bot-a"}')).toBeNull();
  expect(parseJevReply('{"member": 1, "confidence": 0.9}')).toBeNull();
});

test("JevRouterTest.test_prompt_lists_members_and_message", () => {
  const p = jevPrompt("查一下报错", MEMBERS);
  expect(p).toContain("bot-a");
  expect(p).toContain("bot-b");
  expect(p).toContain("查资料");
  expect(p).toContain("查一下报错");
  expect(p).toContain("confidence");
});

test("JevRouterTest.test_config_defaults_off", () => {
  const home = tmpRoot();
  try {
    const cfg = jevRouterConfig(home);
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toBe("deepseek-flash");
    expect(cfg.threshold).toBe(0.6);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeStore(root: string, jevDecider: JevDecider | null | undefined, seen: string[]): GroupStore {
  const store = new GroupStore(join(root, "groups"), {
    home: root,
    jevDecider,
    botRunner: async (bot) => {
      seen.push(bot.id);
      return { text: `${bot.id} 回复` };
    },
  });
  store.create("dev", "开发群", [
    { id: "bot-a", name: "甲", role: "查资料", instructions: "查资料" },
    { id: "bot-b", name: "乙", role: "写代码", instructions: "写代码" },
  ]);
  return store;
}

test("JevRouterTest.test_send_routes_to_one_bot_when_confident", async () => {
  const root = tmpRoot();
  try {
    const seen: string[] = [];
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    const store = makeStore(root, async () => ({ member: "bot-b", confidence: 0.9 }), seen);
    const res = await store.send("dev", "帮我写个函数", 1, {
      emit: (type, fields) => { events.push({ type, fields }); },
    });
    expect(seen).toEqual(["bot-b"]);
    expect(res.messages.map((m) => m.sender)).toEqual(["user", "bot-b"]);
    const routed = events.find((e) => e.type === "jev_routed");
    expect(routed).toBeDefined();
    expect(routed!.fields.member).toBe("bot-b");
    expect(routed!.fields.fallback).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JevRouterTest.test_send_falls_back_to_all_when_uncertain", async () => {
  const root = tmpRoot();
  try {
    const seen: string[] = [];
    const store = makeStore(root, async () => ({ member: "bot-b", confidence: 0.3 }), seen);
    const res = await store.send("dev", "随便聊聊", 1, { emit: () => {} });
    expect(seen).toEqual(["bot-a", "bot-b"]);
    expect(res.messages.map((m) => m.sender)).toEqual(["user", "bot-a", "bot-b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JevRouterTest.test_send_mention_skips_routing_and_disabled_stays_all", async () => {
  // @ 点名时不路由：只叫到的回答。
  const root = tmpRoot();
  try {
    const seen: string[] = [];
    let deciderCalled = 0;
    const store = makeStore(root, async () => { deciderCalled += 1; return { member: "bot-b", confidence: 0.9 }; }, seen);
    const res = await store.send("dev", "@bot-a 你说", 1, { emit: () => {} });
    expect(deciderCalled).toBe(0);
    expect(seen).toEqual(["bot-a"]);
    expect(res.messages.map((m) => m.sender)).toEqual(["user", "bot-a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // decider 显式 null = 强制关：没 @ 时全员回答。
  const root2 = tmpRoot();
  try {
    const seen2: string[] = [];
    const store2 = makeStore(root2, null, seen2);
    await store2.send("dev", "随便聊聊", 1, { emit: () => {} });
    expect(seen2).toEqual(["bot-a", "bot-b"]);
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
  // 不传 decider 且配置默认关闭：同样全员回答。
  const root3 = tmpRoot();
  try {
    const seen3: string[] = [];
    const store3 = makeStore(root3, undefined, seen3);
    await store3.send("dev", "随便聊聊", 1, { emit: () => {} });
    expect(seen3).toEqual(["bot-a", "bot-b"]);
  } finally {
    rmSync(root3, { recursive: true, force: true });
  }
});
