// tests/node/test-group-chat-batch2.test.ts — 第 2 批 G-P1-2：swarm/handoff + 可组合终止条件。
// 全部用临时 home 与假 bot runner，不调模型。
import { test, expect} from "bun:test";
import { mkdtempSync, rmSync} from "node:fs";
import { tmpdir} from "node:os";
import { join} from "node:path";
import { GroupStore} from "../../src/groups.ts";
import {
evaluateTermination,
estimateTokens,
handoffTarget,
mentionedBot,
runGroupChat,
validateTermination,
} from "../../src/groupChat.ts";

function tmpHome(prefix: string): string {
return mkdtempSync(join(tmpdir(), prefix));
}

function makeStore(home: string, script: Record<string, string>) {
const store = new GroupStore(join(home, "groups"), {
home,
botRunner: async (bot) => ({ text: script[bot.id]?? `默认发言`}),
});
store.create("room-1", "测试群", [
{ id: "bot-a", name: "A", role: "成员", instructions: "你是 A"},
{ id: "bot-b", name: "B", role: "成员", instructions: "你是 B"},
{ id: "bot-c", name: "C", role: "成员", instructions: "你是 C"},
]);
return store;
}

test("GroupChatBatch2.test_estimate_and_mentions", () => {
expect(estimateTokens("abcd")).toBe(1);
expect(estimateTokens("")).toBe(0);
expect(mentionedBot("你好 @bot-b 帮我看看")).toBe("bot-b");
expect(mentionedBot("没有点名")).toBeNull();
expect(handoffTarget("HANDOFF: bot-c")).toBe("bot-c");
expect(handoffTarget("handoff: bot-c")).toBe("bot-c");
expect(handoffTarget("普通发言")).toBeNull();
});

test("GroupChatBatch2.test_validate_termination_rejects_bad_values", () => {
expect(() => validateTermination({ kind: "max-messages", max: 0})).toThrow();
expect(() => validateTermination({ kind: "max-messages", max: 1001})).toThrow();
expect(() => validateTermination({ kind: "token-budget", maxTokens: -1})).toThrow();
expect(() => validateTermination({ kind: "timeout", timeoutMs: 0})).toThrow();
expect(() => validateTermination({ kind: "mention-text", text: ""})).toThrow();
expect(() => validateTermination({ kind: "and", conditions: []})).toThrow();
validateTermination({ kind: "and", conditions: [{ kind: "max-messages", max: 5}, { kind: "mention-text", text: "完成"}]});
});

test("GroupChatBatch2.test_evaluate_termination_combinations", () => {
const base = { messages: 0, tokensEstimate: 0, startedAt: 0, handoffs: [], lastMentionHit: null};
const now = 1000;
expect(evaluateTermination({ kind: "max-messages", max: 3}, {...base, messages: 3}, { now}).terminated).toBe(true);
expect(evaluateTermination({ kind: "max-messages", max: 3}, {...base, messages: 2}, { now}).terminated).toBe(false);
expect(evaluateTermination({ kind: "mention-text", text: "完成"}, {...base, lastMentionHit: "完成"}, { now}).terminated).toBe(true);
expect(evaluateTermination({ kind: "token-budget", maxTokens: 10}, {...base, tokensEstimate: 40}, { now}).terminated).toBe(true);
expect(evaluateTermination({ kind: "timeout", timeoutMs: 100}, {...base, startedAt: 0}, { now: 101}).terminated).toBe(true);
const and = { kind: "and" as const, conditions: [{ kind: "max-messages" as const, max: 2}, { kind: "mention-text" as const, text: "完成"}]};
expect(evaluateTermination(and, {...base, messages: 5, lastMentionHit: null}, { now}).terminated).toBe(false);
expect(evaluateTermination(and, {...base, messages: 5, lastMentionHit: "完成"}, { now}).terminated).toBe(true);
const or = { kind: "or" as const, conditions: [{ kind: "max-messages" as const, max: 2}, { kind: "mention-text" as const, text: "完成"}]};
expect(evaluateTermination(or, {...base, messages: 5, lastMentionHit: null}, { now}).terminated).toBe(true);
});

test("GroupChatBatch2.test_round_robin_runs_in_order", async () => {
const home = tmpHome("nyra-gchat-");
try {
const store = makeStore(home, {
"bot-a": "A 说第一句",
"bot-b": "B 说第二句",
"bot-c": "C 说第三句",
});
const result = await runGroupChat(store, "room-1", {
mode: "round-robin",
kickoff: "开始讨论",
termination: { kind: "max-messages", max: 4},
});
expect(result.turns.map((t) => t.speaker)).toEqual(["bot-a", "bot-b", "bot-c"]);
expect(result.terminatedBy).toContain("max-messages");
expect(result.messages).toBe(4);
} finally { rmSync(home, { recursive: true, force: true});}
});

test("GroupChatBatch2.test_handoff_mode_follows_handoff_line", async () => {
const home = tmpHome("nyra-gchat-");
try {
const store = makeStore(home, {
"bot-a": "A 先说，接下来 HANDOFF: bot-c",
"bot-b": "B 不该被点到",
"bot-c": "C 接到了",
});
const result = await runGroupChat(store, "room-1", {
mode: "handoff",
kickoff: "开始",
termination: { kind: "max-messages", max: 3},
});
expect(result.turns[0].speaker).toBe("bot-a");
expect(result.turns[1].speaker).toBe("bot-c");
} finally { rmSync(home, { recursive: true, force: true});}
});

test("GroupChatBatch2.test_selector_mode_mentions_pick_speaker", async () => {
const home = tmpHome("nyra-gchat-");
try {
const store = makeStore(home, {
"bot-a": "A 说：@bot-b 你来",
"bot-b": "B 来了",
"bot-c": "C 默认",
});
const result = await runGroupChat(store, "room-1", {
mode: "selector",
kickoff: "开始",
termination: { kind: "max-messages", max: 3},
});
expect(result.turns[0].speaker).toBe("bot-a");
expect(result.turns[1].speaker).toBe("bot-b");
} finally { rmSync(home, { recursive: true, force: true});}
});

test("GroupChatBatch2.test_mention_text_termination", async () => {
const home = tmpHome("nyra-gchat-");
try {
const store = makeStore(home, {
"bot-a": "还在做",
"bot-b": "做完了，任务完成",
"bot-c": "不该轮到我",
});
const result = await runGroupChat(store, "room-1", {
mode: "round-robin",
kickoff: "开始",
termination: { kind: "mention-text", text: "完成"},
});
expect(result.turns.map((t) => t.speaker)).toEqual(["bot-a", "bot-b"]);
expect(result.terminatedBy).toContain("mention-text");
} finally { rmSync(home, { recursive: true, force: true});}
});
