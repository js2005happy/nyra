// tests/node/test-local-router.test.ts — 本地小神经网络意图路由：
// 三层 MLP（纯 TypeScript 手写，不引依赖），零 token、不调模型。
// 只做路由建议：置信度不够、判为垃圾消息、权重坏了，一律回落
// 原有路由（便宜模型 Jev 或全员回答），不静默猜、不自动放行。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupStore } from "../../src/groups.ts";
import { RunStore } from "../../src/runs.ts";
import { saveConfig } from "../../src/config.ts";
import { SUBCOMMANDS } from "../../src/subcommands.ts";
import {
  LOCAL_ROUTER_DEFAULT_THRESHOLD,
  buildLocalRouterVocabulary,
  classifyLocal,
  createLocalRouterDecider,
  featurizeLocalRouter,
  loadLocalRouterWeights,
  localRouterConfig,
  matchLabelToMember,
  parseLocalRouterWeights,
  tokenizeLocalRouter,
  type LocalRouterWeights,
} from "../../src/localRouter.ts";
import { HELD_OUT_EXAMPLES, LABEL_KEYWORDS, LOCAL_ROUTER_LABELS, TRAIN_EXAMPLES } from "../../src/localRouterData.ts";
import { chainDeciders, type JevDecider, type JevMember } from "../../src/jevRouter.ts";
import { handleRouter } from "../../src/localRouterCli.ts";

function tmpRoot(prefix = "nyra-router-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const MEMBERS: JevMember[] = [
  { id: "bot-a", name: "甲", role: "查资料", instructions: "查资料" },
  { id: "bot-b", name: "乙", role: "写代码", instructions: "写代码" },
];

test("LocalRouterTest.test_tokenizer_ascii_cjk_bigrams", () => {
  const toks = tokenizeLocalRouter("帮我写一个 Sort 函数");
  expect(toks).toContain("sort");
  expect(toks).toContain("帮");
  // 汉字二元组：”写代码”里有“代码”这个二元组。
  expect(tokenizeLocalRouter("帮我写代码")).toContain("代码");
  expect(tokenizeLocalRouter("Hello World")).toEqual(["hello", "world"]);
  // 纯标点没有词。
  expect(tokenizeLocalRouter("！！！")).toEqual([]);
});

test("LocalRouterTest.test_vocabulary_deterministic_and_train_only", () => {
  const v1 = buildLocalRouterVocabulary(TRAIN_EXAMPLES);
  const v2 = buildLocalRouterVocabulary(TRAIN_EXAMPLES);
  expect(v1).toEqual(v2);
  expect(v1.length).toBeGreaterThan(0);
  expect(v1.length).toBeLessThanOrEqual(768);
  // “去重”只在留出集出现，不该进词表（留出集不参与训练）。
  expect(v1).not.toContain("去重");
  expect(v1).toContain("代码");
});

test("LocalRouterTest.test_bundled_weights_load", () => {
  const w = loadLocalRouterWeights();
  expect(w.version).toBe(1);
  expect(w.labels).toEqual([...LOCAL_ROUTER_LABELS]);
  expect(w.vocab.length).toBeGreaterThan(0);
  expect(w.vocab.length).toBeLessThanOrEqual(768);
  expect(w.hidden).toBeGreaterThan(0);
});

test("LocalRouterTest.test_weights_validation_fails_closed", () => {
  expect(() => parseLocalRouterWeights("not json")).toThrow();
  expect(() => parseLocalRouterWeights("{}")).toThrow();
  const good = loadLocalRouterWeights();
  const badVersion = { ...good, version: 99 };
  expect(() => parseLocalRouterWeights(JSON.stringify(badVersion))).toThrow("版本不对");
  const badLabels = { ...good, labels: ["code", "x", "y", "z", "w", "v"] };
  expect(() => parseLocalRouterWeights(JSON.stringify(badLabels))).toThrow("标签");
  const badW1 = { ...good, W1: [[1, 2]] };
  expect(() => parseLocalRouterWeights(JSON.stringify(badW1))).toThrow("W1");
  const badNumber = { ...good, b2: [0, 0, 0, 0, 0, Number.NaN] };
  expect(() => parseLocalRouterWeights(JSON.stringify(badNumber))).toThrow("b2");
});

test("LocalRouterTest.test_accuracy_on_held_out_and_train", () => {
  const w = loadLocalRouterWeights();
  const heldOutOk = HELD_OUT_EXAMPLES.filter((ex) => classifyLocal(ex.text, w).label === ex.label).length;
  // 训练脚本的门是 0.8；当前权重实测 24/24，这里只钉下限，防数据一改就崩。
  expect(heldOutOk / HELD_OUT_EXAMPLES.length).toBeGreaterThanOrEqual(0.8);
  const trainOk = TRAIN_EXAMPLES.filter((ex) => classifyLocal(ex.text, w).label === ex.label).length;
  expect(trainOk / TRAIN_EXAMPLES.length).toBeGreaterThanOrEqual(0.95);
});

test("LocalRouterTest.test_classify_known_messages", () => {
  const w = loadLocalRouterWeights();
  expect(classifyLocal("写个函数把列表去重", w).label).toBe("code");
  expect(classifyLocal("帮我搜一下这款耳机的评测", w).label).toBe("research");
  expect(classifyLocal("帮我写一封感谢信", w).label).toBe("write");
  expect(classifyLocal("服务挂了，重启一下", w).label).toBe("ops");
  expect(classifyLocal("你好，在吗", w).label).toBe("chat");
  expect(classifyLocal("点链接免费领会员，先到先得", w).label).toBe("spam");
  const r = classifyLocal("帮我写一个快速排序函数", w);
  expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  expect(r.confidence).toBeLessThanOrEqual(1);
  expect(r.scores.length).toBe(LOCAL_ROUTER_LABELS.length);
});

test("LocalRouterTest.test_decider_routes_confident_code_message", async () => {
  const home = tmpRoot();
  try {
    const seen: { label: string; confidence: number; fallback: boolean; reason: string }[] = [];
    const decider = createLocalRouterDecider(home, {
      onDecision: (f) => { seen.push(f); },
    });
    const d = await decider("帮我写一个快速排序函数", MEMBERS);
    expect(d?.member).toBe("bot-b");
    expect(d!.confidence).toBeGreaterThanOrEqual(LOCAL_ROUTER_DEFAULT_THRESHOLD);
    expect(seen.length).toBe(1);
    expect(seen[0]!.label).toBe("code");
    expect(seen[0]!.fallback).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_decider_falls_back_below_threshold", async () => {
  const home = tmpRoot();
  try {
    const seen: { fallback: boolean }[] = [];
    // 阈值拉到 1.0：softmax 最大值恒小于 1，再确定的消息也回落（等链上下一棒）。
    const strict = createLocalRouterDecider(home, {
      threshold: 1.0,
      onDecision: (f) => { seen.push(f); },
    });
    expect(await strict("帮我写一个快速排序函数", MEMBERS)).toBeNull();
    expect(seen[0]!.fallback).toBe(true);
    // 阈值 0：同一条消息就路由。
    const loose = createLocalRouterDecider(home, { threshold: 0.01 });
    expect((await loose("帮我写一个快速排序函数", MEMBERS))?.member).toBe("bot-b");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_decider_spam_never_routes", async () => {
  const home = tmpRoot();
  try {
    const seen: { label: string; fallback: boolean }[] = [];
    const decider = createLocalRouterDecider(home, { onDecision: (f) => { seen.push(f); } });
    expect(await decider("加微信免费领红包，点击链接领取", MEMBERS)).toBeNull();
    expect(seen[0]!.label).toBe("spam");
    expect(seen[0]!.fallback).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_decider_fails_closed_on_broken_weights", async () => {
  const home = tmpRoot();
  try {
    const decider = createLocalRouterDecider(home, { weightsJson: "{}" });
    // 权重坏了不抛错、不猜：返回 null，等链上下一棒。
    expect(await decider("帮我写个函数", MEMBERS)).toBeNull();
    const badJson = createLocalRouterDecider(home, { weightsJson: "not json" });
    expect(await badJson("帮我写个函数", MEMBERS)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_match_label_to_member", () => {
  expect(matchLabelToMember("code", MEMBERS)).toBe("bot-b");
  expect(matchLabelToMember("research", MEMBERS)).toBe("bot-a");
  // 房间里没有对应的 Bot：返回 null，不硬派。
  expect(matchLabelToMember("ops", MEMBERS)).toBeNull();
  expect(matchLabelToMember("chat", MEMBERS)).toBeNull();
  // spam 永远不派给任何 Bot。
  expect(matchLabelToMember("spam", MEMBERS)).toBeNull();
  // 平局取排在前面的。
  const tied: JevMember[] = [
    { id: "m1", name: "一", role: "写代码" },
    { id: "m2", name: "二", role: "写代码" },
  ];
  expect(matchLabelToMember("code", tied)).toBe("m1");
  // 映射词表里 spam 是空的（设计如此，不是漏写）。
  expect(LABEL_KEYWORDS.spam).toEqual([]);
});

test("LocalRouterTest.test_chain_deciders_local_first_then_model", async () => {
  let secondCalled = 0;
  const second: JevDecider = async () => { secondCalled += 1; return { member: "bot-a", confidence: 0.9 }; };
  const home = tmpRoot();
  try {
    // 本地判中：第二棒不跑。
    const chained = chainDeciders(createLocalRouterDecider(home), second);
    const d1 = await chained("帮我写一个快速排序函数", MEMBERS);
    expect(d1?.member).toBe("bot-b");
    expect(secondCalled).toBe(0);
    expect(chained.lastSource).toBe("first");
    // 本地判不出（垃圾消息）：落到第二棒。
    const d2 = await chained("加微信免费领红包，点击链接领取", MEMBERS);
    expect(d2?.member).toBe("bot-a");
    expect(secondCalled).toBe(1);
    expect(chained.lastSource).toBe("second");
    // 两棒都判不出：返回 null。
    const never: JevDecider = async () => null;
    const chained2 = chainDeciders(createLocalRouterDecider(home, { threshold: 1.0 }), never);
    expect(await chained2("帮我写个函数", MEMBERS)).toBeNull();
    expect(chained2.lastSource).toBe("none");
    // 第一棒抛错：一样落到第二棒，不炸链。
    const boom: JevDecider = async () => { throw new Error("本地挂了"); };
    const chained3 = chainDeciders(boom, second);
    expect((await chained3("hi", MEMBERS))?.member).toBe("bot-a");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_config_defaults_off_and_reads_section", () => {
  const home = tmpRoot();
  try {
    const def = localRouterConfig(home);
    expect(def.enabled).toBe(false);
    expect(def.threshold).toBe(0.6);
    saveConfig(home, { local_router: { enabled: true, threshold: 0.8 } });
    const on = localRouterConfig(home);
    expect(on.enabled).toBe(true);
    expect(on.threshold).toBe(0.8);
    // 阈值越界回默认，不静默用坏数。
    saveConfig(home, { local_router: { enabled: true, threshold: 5 } });
    expect(localRouterConfig(home).threshold).toBe(0.6);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_event_registered", () => {
  const home = tmpRoot();
  try {
    const store = new RunStore(join(home, "runs"));
    const run = store.create("t", "sess-1", tmpdir(), "full", 5);
    store.appendEvent(run.run_id, "local_router_decision", { label: "code", confidence: 0.93, fallback: false, reason: "本地小路由（零 token）" });
    expect(() => store.appendEvent(run.run_id, "no_such_event_xyz", {})).toThrow("运行事件无效");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_cli_status_test_and_errors", async () => {
  const home = tmpRoot();
  try {
    expect(await handleRouter(["status"], home)).toBe(0);
    expect(await handleRouter(["test", "帮我写一个快速排序函数"], home)).toBe(0);
    expect(await handleRouter(["test", "帮我写一个快速排序函数", "--json"], home)).toBe(0);
    expect(await handleRouter(["test"], home)).toBe(2);
    expect(await handleRouter(["bogus"], home)).toBe(2);
    expect(await handleRouter([], home)).toBe(2);
    expect(await handleRouter(["help"], home)).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_subcommand_registered", () => {
  expect(SUBCOMMANDS).toContain("router");
});

test("LocalRouterTest.test_send_uses_local_router_first", async () => {
  const root = tmpRoot();
  try {
    saveConfig(root, { jev_router_enabled: true, local_router: { enabled: true, threshold: 0.6 } });
    const seen: string[] = [];
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    const store = new GroupStore(join(root, "groups"), {
      home: root,
      jevDecider: undefined,
      botRunner: async (bot) => {
        seen.push(bot.id);
        return { text: `${bot.id} 回复` };
      },
    });
    store.create("dev", "开发群", [
      { id: "bot-a", name: "甲", role: "查资料", instructions: "查资料" },
      { id: "bot-b", name: "乙", role: "写代码", instructions: "写代码" },
    ]);
    const res = await store.send("dev", "帮我写一个快速排序函数", 1, {
      emit: (type, fields) => { events.push({ type, fields }); },
    });
    // 本地判中 code → 只有写代码的 Bot 回答，没调模型。
    expect(seen).toEqual(["bot-b"]);
    expect(res.messages.map((m) => m.sender)).toEqual(["user", "bot-b"]);
    const local = events.find((e) => e.type === "local_router_decision");
    expect(local).toBeDefined();
    expect(local!.fields.label).toBe("code");
    expect(local!.fields.fallback).toBe(false);
    const routed = events.find((e) => e.type === "jev_routed");
    expect(routed).toBeDefined();
    expect(routed!.fields.member).toBe("bot-b");
    expect(routed!.fields.reason).toContain("本地小路由");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_send_falls_back_when_no_member_matches", async () => {
  const root = tmpRoot();
  try {
    saveConfig(root, { jev_router_enabled: true, local_router: { enabled: true, threshold: 0.6 } });
    const seen: string[] = [];
    const events: { type: string; fields: Record<string, unknown> }[] = [];
    const store = new GroupStore(join(root, "groups"), {
      home: root,
      jevDecider: undefined,
      botRunner: async (bot) => {
        seen.push(bot.id);
        return { text: `${bot.id} 回复` };
      },
    });
    store.create("dev", "开发群", [
      { id: "bot-a", name: "甲", role: "查资料", instructions: "查资料" },
      { id: "bot-b", name: "乙", role: "写代码", instructions: "写代码" },
    ]);
    // “嗯”判为 chat，但房间里没有闲聊 Bot → 本地回落；模型没 Key 也判不出 → 全员回答。
    await store.send("dev", "嗯", 1, {
      emit: (type, fields) => { events.push({ type, fields }); },
    });
    expect(seen).toEqual(["bot-a", "bot-b"]);
    const local = events.find((e) => e.type === "local_router_decision");
    expect(local).toBeDefined();
    expect(local!.fields.label).toBe("chat");
    expect(local!.fields.fallback).toBe(true);
    const routed = events.find((e) => e.type === "jev_routed");
    expect(routed!.fields.fallback).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalRouterTest.test_featurize_is_binary_bag_of_words", () => {
  const w = loadLocalRouterWeights();
  const x = featurizeLocalRouter("帮我写一个快速排序函数", w.vocab);
  expect(x.length).toBe(w.vocab.length);
  expect(x.every((v) => v === 0 || v === 1)).toBe(true);
  expect(x.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
});

test("随仓权重只解析一次并复用；传 weightsJson 仍每次现解析", () => {
  expect(loadLocalRouterWeights()).toBe(loadLocalRouterWeights());
  const json = JSON.stringify(loadLocalRouterWeights());
  expect(loadLocalRouterWeights(json)).not.toBe(loadLocalRouterWeights(json));
  expect(() => loadLocalRouterWeights("{坏")).toThrow();
  // 坏的覆盖不污染缓存
  expect(loadLocalRouterWeights().vocab.length).toBeGreaterThan(0);
});
