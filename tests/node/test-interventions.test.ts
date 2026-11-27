// tests/node/test-interventions.test.ts — G-P2-1 运行时消息拦截（bus 层）。
//
// 钉住的事：
// - 规则校验正反例（动作、match、regex、rewrite、judge 门槛）；
// - 配置往返/0600/损坏备份；规则上限 100；
// - 机主消息永远放行（不记审计）；总开关关了直接放行；
// - log/rewrite/drop 结论与多规则最严、过滤器（总线/发送者/拦截点）、
// contains 大小写不敏感、regex；
// - drop/rewrite 建出来默认关（须 enable 才生效）；
// - judge 门槛：达线触发、未达线不触发、没接 judge 不触发、judge 抛错不触发；
// - 审计只记指纹不记原文、上限截断；事件只发改写与丢弃；
// - 群聊 send 入口丢弃/改写、bot 回复丢弃/改写、swarm 丢弃轮次不计数；
// - A2A 入口丢弃与改写、AG-UI 入口丢弃；
// - CLI 全程与 test 干跑。
// 全部在临时 home / 假 bot runner / 假 A2A 与 AG-UI 客户端上跑，不调真模型。
import { test, expect} from "bun:test";
import {
appendFileSync,
existsSync,
mkdtempSync,
readFileSync,
readdirSync,
rmSync,
writeFileSync,
} from "node:fs";
import { tmpdir} from "node:os";
import { join} from "node:path";
import { expectPerms} from "./fsPerms.ts";
import {
addInterventionRule,
applyInterventions,
appendInterventionAudit,
fingerprintText,
loadInterventions,
newBusMessageId,
readInterventionAudit,
removeInterventionRule,
ruleMatches,
saveInterventions,
setInterventionRuleEnabled,
setInterventionsEnabled,
validateInterventionRule,
type BusMessage,
} from "../../src/interventions.ts";
import { handleIntervention} from "../../src/interventionCli.ts";
import { GroupStore} from "../../src/groups.ts";
import { runGroupChat} from "../../src/groupChat.ts";
import {
a2aBaseUrl,
createA2aServerToken,
dispatchA2aRpc,
type A2aServerDeps,
type A2aServerToken,
} from "../../src/a2a.ts";
import {
createAguiServerToken,
serveAguiServerRun,
type AguiServerToken,
} from "../../src/aguiServer.ts";

function tmpHome(prefix: string): string {
return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
rmSync(home, { recursive: true, force: true});
}

function peerMsg(text: string, extra: Partial<BusMessage> = {}): BusMessage {
return {
id: newBusMessageId(),
bus: "group",
sender: "bot-a",
senderKind: "peer",
kind: "send",
text,
...extra,
};
}

function readAllRunEvents(home: string): Record<string, unknown>[] {
const out: Record<string, unknown>[] = [];
const base = join(home, "runs");
if (!existsSync(base)) return out;
for (const runId of readdirSync(base)) {
const p = join(base, runId, "events.jsonl");
if (!existsSync(p)) continue;
for (const line of readFileSync(p, "utf-8").split("\n")) {
if (!line.trim()) continue;
try {
out.push(JSON.parse(line) as Record<string, unknown>);
} catch { /* ignore */}
}
}
return out;
}

function seedRule(home: string, raw: Record<string, unknown>): string {
const { rule} = addInterventionRule(home, raw);
return rule.id;
}

function enableRule(home: string, id: string): void {
const rule = setInterventionRuleEnabled(home, id, true);
expect(rule?.enabled).toBe(true);
}

// ---- 规则校验 -----------------------------------------------------------

test("规则校验：有效规则通过，非法规则逐项拒绝", () => {
const ok = validateInterventionRule({
name: "拦链接", action: "drop", match: { contains: ["http://"]},
});
expect(ok.action).toBe("drop");
expect(ok.id).toMatch(/^ivr-[0-9a-f]+$/);
expect(ok.enabled).toBe(false); // drop 建出来默认关
expect(validateInterventionRule({ name: "记日志", action: "log", match: { regex: "秘密"}}).enabled).toBe(true);
expect(() => validateInterventionRule({ name: "x", action: "block", match: { contains: ["a"]}})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "log", match: {}})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "log", match: { regex: "("}})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "log", match: { contains: []}})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "rewrite", match: { contains: ["a"]}})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "log", match: { contains: ["a"]}, judgeThreshold: 101})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "log", match: { contains: ["a"]}, bus: "nope"})).toThrow();
expect(() => validateInterventionRule({ name: "x", action: "log", match: { contains: ["a"]}, kind: "both"})).toThrow();
expect(validateInterventionRule({
name: "改写", action: "rewrite", match: { contains: ["旧"]},
rewrite: { replace: ["旧", "新"]},
}).rewrite?.replace).toEqual(["旧", "新"]);
});

// ---- 配置往返 -----------------------------------------------------------

test("配置往返：默认开零规则，保存 0600，损坏先备份再回默认", () => {
const home = tmpHome("nyra-ivr-");
try {
const def = loadInterventions(home);
expect(def.enabled).toBe(true);
expect(def.rules).toEqual([]);
const { rule} = addInterventionRule(home, { name: "记", action: "log", match: { contains: ["x"]}});
expectPerms(join(home, "interventions.json"), 0o600);
expect(loadInterventions(home).rules.map((r) => r.id)).toEqual([rule.id]);
// 损坏：备份 + 回默认
writeFileSync(join(home, "interventions.json"), "{坏掉");
expect(loadInterventions(home).rules).toEqual([]);
expect(readdirSync(home).some((f) => f.startsWith("interventions.json.corrupt-"))).toBe(true);
// 坏规则跳过，不挡整份配置
saveInterventions(home, {
version: 1, enabled: true,
rules: [
{ id: "ivr-aaaaaa", name: "好的", enabled: true, action: "log", match: { contains: ["a"]}},
{ id: "bad", name: "坏的", enabled: true, action: "nope", match: {}},
] as never,
});
expect(loadInterventions(home).rules.map((r) => r.id)).toEqual(["ivr-aaaaaa"]);
} finally {
cleanup(home);
}
});

test("规则上限 100 条，删了才能再加", () => {
const home = tmpHome("nyra-ivr-");
try {
for (let i = 0; i < 100; i++) {
addInterventionRule(home, { name: `规则${i}`, action: "log", match: { contains: [`词${i}`]}});
}
expect(() => addInterventionRule(home, { name: "超了", action: "log", match: { contains: ["超"]}})).toThrow();
const first = loadInterventions(home).rules[0]!;
expect(removeInterventionRule(home, first.id)).toBe(true);
expect(removeInterventionRule(home, first.id)).toBe(false);
addInterventionRule(home, { name: "补位", action: "log", match: { contains: ["补"]}});
expect(loadInterventions(home).rules).toHaveLength(100);
} finally {
cleanup(home);
}
});

// ---- 核心裁决 -----------------------------------------------------------

test("机主消息永远放行，不记审计；总开关关了直接放行", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, { name: "拦链接", action: "drop", match: { contains: ["http://"]}});
enableRule(home, id);
const owner = await applyInterventions(home, peerMsg("http://x", { senderKind: "owner", sender: "owner"}));
expect(owner.verdict).toBe("pass");
expect(readInterventionAudit(home)).toEqual([]);
const off = await applyInterventions(home, peerMsg("http://x"));
expect(off.verdict).toBe("drop");
setInterventionsEnabled(home, false);
const disabled = await applyInterventions(home, peerMsg("http://x"));
expect(disabled.verdict).toBe("pass");
} finally {
cleanup(home);
}
});

test("log 只记审计不改文本不发事件；rewrite 改写并发事件；drop 丢弃并发事件", async () => {
const home = tmpHome("nyra-ivr-");
try {
const events: { type: string; fields: Record<string, unknown>}[] = [];
const emit = (type: string, fields: Record<string, unknown>) => { events.push({ type, fields});};
seedRule(home, { name: "记链接", action: "log", match: { contains: ["http://"]}});
const logged = await applyInterventions(home, peerMsg("看这个 http://x"), { emit});
expect(logged.verdict).toBe("log");
expect(logged.text).toBe("看这个 http://x");
expect(events).toEqual([]);
const rewriteId = seedRule(home, {
name: "改秘密", action: "rewrite", match: { contains: ["秘密"]},
rewrite: { replace: ["秘密", "公开"], prefix: ""},
});
enableRule(home, rewriteId);
const rewritten = await applyInterventions(home, peerMsg("这是秘密内容"), { emit});
expect(rewritten.verdict).toBe("rewrite");
expect(rewritten.text).toBe("这是公开内容");
expect(events.map((e) => e.type)).toEqual(["bus_message_rewritten"]);
expect(String(events[0]!.fields.rules)).toContain(rewriteId);
expect(String(events[0]!.fields.text_fingerprint)).toBe(fingerprintText("这是秘密内容"));
const dropId = seedRule(home, { name: "丢密码", action: "drop", match: { regex: "密码"}});
enableRule(home, dropId);
const dropped = await applyInterventions(home, peerMsg("密码是 123456"), { emit});
expect(dropped.verdict).toBe("drop");
expect(events.map((e) => e.type)).toEqual(["bus_message_rewritten", "bus_message_dropped"]);
const audit = readInterventionAudit(home);
expect(audit.map((a) => a.action)).toEqual(["drop", "rewrite", "log"]);
expect(audit.every((a) => a.text_fingerprint.length === 16)).toBe(true);
// 审计里没有原文
const rawAudit = readFileSync(join(home, "intervention-audit.jsonl"), "utf-8");
expect(rawAudit).not.toContain("密码是 123456");
expect(rawAudit).not.toContain("这是秘密内容");
} finally {
cleanup(home);
}
});

test("多规则命中取最严：drop 压过 rewrite，rewrite 压过 log", async () => {
const home = tmpHome("nyra-ivr-");
try {
seedRule(home, { name: "记", action: "log", match: { contains: ["触发"]}});
const rw = seedRule(home, {
name: "改", action: "rewrite", match: { contains: ["触发"]},
rewrite: { suffix: "（已改）"},
});
enableRule(home, rw);
const r1 = await applyInterventions(home, peerMsg("触发"));
expect(r1.verdict).toBe("rewrite");
expect(r1.text).toBe("触发（已改）");
expect(r1.matched).toHaveLength(2);
const dr = seedRule(home, { name: "丢", action: "drop", match: { contains: ["触发"]}});
enableRule(home, dr);
const r2 = await applyInterventions(home, peerMsg("触发"));
expect(r2.verdict).toBe("drop");
expect(r2.matched).toHaveLength(3);
} finally {
cleanup(home);
}
});

test("过滤器：总线/发送者/拦截点不匹配不触发；contains 大小写不敏感；regex 命中", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, {
name: "只拦 A2A 的 bot", action: "log", bus: "a2a", sender: "bot-x", kind: "publish",
match: { contains: ["SECRET"]},
});
const base = peerMsg("含 SECRET 的消息");
expect(ruleMatches(loadInterventions(home).rules[0]!, base)).toBe(false); // bus 不对
expect(ruleMatches(loadInterventions(home).rules[0]!, {...base, bus: "a2a"})).toBe(false); // sender 不对
expect(ruleMatches(loadInterventions(home).rules[0]!, {...base, bus: "a2a", sender: "bot-x"})).toBe(false); // kind 不对
expect(ruleMatches(loadInterventions(home).rules[0]!, {...base, bus: "a2a", sender: "bot-x", kind: "publish"})).toBe(true);
expect(ruleMatches(loadInterventions(home).rules[0]!, {...base, bus: "a2a", sender: "bot-x", kind: "publish", text: "含 secret 的消息"})).toBe(true); // 大小写不敏感
const r = await applyInterventions(home, {...base, bus: "a2a", sender: "bot-x", kind: "publish"});
expect(r.verdict).toBe("log");
expect(r.matched).toEqual([id]);
const rx = seedRule(home, { name: "正则", action: "log", match: { regex: "\\d{4}-\\d{4}"}});
const r2 = await applyInterventions(home, peerMsg("卡号 1234-5678"));
expect(r2.matched).toContain(rx);
} finally {
cleanup(home);
}
});

test("drop/rewrite 建出来默认关，enable 后才生效", async () => {
const home = tmpHome("nyra-ivr-");
try {
const { rule, needsEnable} = addInterventionRule(home, {
name: "丢", action: "drop", match: { contains: ["丢"]},
});
expect(needsEnable).toBe(true);
expect(rule.enabled).toBe(false);
const before = await applyInterventions(home, peerMsg("丢我"));
expect(before.verdict).toBe("pass");
enableRule(home, rule.id);
const after = await applyInterventions(home, peerMsg("丢我"));
expect(after.verdict).toBe("drop");
const logAdd = addInterventionRule(home, { name: "记", action: "log", match: { contains: ["记"]}});
expect(logAdd.needsEnable).toBe(false);
} finally {
cleanup(home);
}
});

test("judge 门槛：达线触发、未达线不触发、没接 judge 不触发、judge 抛错不触发", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, {
name: "高危才丢", action: "drop", match: { contains: ["可疑"]}, judgeThreshold: 70,
});
enableRule(home, id);
const noJudge = await applyInterventions(home, peerMsg("可疑内容"));
expect(noJudge.verdict).toBe("pass");
expect(readInterventionAudit(home).map((a) => a.action)).toEqual(["judge_missing"]);
const low = await applyInterventions(home, peerMsg("可疑内容"), { judge: async () => 40});
expect(low.verdict).toBe("pass");
expect(readInterventionAudit(home).map((a) => a.action)).toEqual(["skipped_judge", "judge_missing"]);
const high = await applyInterventions(home, peerMsg("可疑内容"), { judge: async () => 90});
expect(high.verdict).toBe("drop");
expect(readInterventionAudit(home)[0]?.judge_score).toBe(90);
const boom = await applyInterventions(home, peerMsg("可疑内容"), {
judge: async () => { throw new Error("judge 挂了");},
});
expect(boom.verdict).toBe("pass");
expect(readInterventionAudit(home)[0]?.action).toBe("judge_error");
} finally {
cleanup(home);
}
});

test("审计上限：超 2000 行只留最近 1000 行，坏行读时跳过", () => {
const home = tmpHome("nyra-ivr-");
try {
const lines: string[] = [];
for (let i = 0; i < 2005; i++) {
lines.push(JSON.stringify({
at: "2026-01-01T00:00:00.000Z", message_id: `m${i}`, bus: "group",
sender: "bot-a", sender_kind: "peer", kind: "send",
rule_id: "ivr-aaaaaa", rule_name: "记", action: "log",
text_fingerprint: "0123456789abcdef", text_length: 1,
}));
}
appendFileSync(join(home, "intervention-audit.jsonl"), lines.join("\n") + "\n", { mode: 0o600});
appendInterventionAudit(home, {
at: "2026-01-02T00:00:00.000Z", message_id: "m-new", bus: "group",
sender: "bot-a", sender_kind: "peer", kind: "send",
rule_id: "ivr-aaaaaa", rule_name: "记", action: "log",
text_fingerprint: "fedcba9876543210", text_length: 2,
});
const kept = readFileSync(join(home, "intervention-audit.jsonl"), "utf-8").split("\n").filter(Boolean);
expect(kept).toHaveLength(1000);
expect(kept.at(-1)).toContain("m-new");
// 坏行跳过
appendFileSync(join(home, "intervention-audit.jsonl"), "{坏行\n");
expect(readInterventionAudit(home, 1).map((a) => a.message_id)).toEqual(["m-new"]);
} finally {
cleanup(home);
}
});

// ---- 群聊接线 -----------------------------------------------------------

function groupStore(home: string, script: Record<string, string>): GroupStore {
const store = new GroupStore(join(home, "groups"), {
home,
botRunner: async (bot) => ({ text: script[bot.id]?? "默认发言"}),
});
store.create("room-1", "测试群", [
{ id: "bot-a", name: "A", role: "成员", instructions: "你是 A"},
{ id: "bot-b", name: "B", role: "成员", instructions: "你是 B"},
]);
return store;
}

test("群聊 send：peer 入口消息命中 drop 规则直接报错，不进群记录", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, { name: "拦链接", action: "drop", bus: "group", kind: "send", match: { contains: ["http://"]}});
enableRule(home, id);
const store = groupStore(home, { "bot-a": "A 回复", "bot-b": "B 回复"});
await expect(store.send("room-1", "看这个 http://x", 1, { senderKind: "peer", sender: "peer-x"})).rejects.toThrow("拦截器丢弃");
expect(store.get("room-1").messages).toEqual([]);
expect(readInterventionAudit(home).map((a) => a.action)).toEqual(["drop"]);
} finally {
cleanup(home);
}
});

test("群聊 send：peer 入口消息命中 rewrite 规则用改写后的文本跑；owner 入口不受影响", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, {
name: "改秘密", action: "rewrite", bus: "group", kind: "send", match: { contains: ["秘密"]},
rewrite: { replace: ["秘密", "公开"]},
});
enableRule(home, id);
const store = groupStore(home, { "bot-a": "A 回复", "bot-b": "B 回复"});
const res = await store.send("room-1", "这是秘密任务", 1, { senderKind: "peer", sender: "peer-x"});
expect(res.messages[0]!.content).toBe("这是公开任务");
// owner 入口：同样文本不受影响
const res2 = await store.send("room-1", "这是秘密任务", 1);
expect(res2.messages[0]!.content).toBe("这是秘密任务");
} finally {
cleanup(home);
}
});

test("群聊 send：bot 回复命中 drop 规则不进群记录，命中 rewrite 规则改写后进群记录", async () => {
const home = tmpHome("nyra-ivr-");
try {
const dropId = seedRule(home, {
name: "丢链接", action: "drop", bus: "group", kind: "publish", match: { contains: ["http://"]},
});
enableRule(home, dropId);
const store = groupStore(home, { "bot-a": "看 http://x", "bot-b": "B 回复"});
const res = await store.send("room-1", "大家好", 1);
expect(res.messages.map((m) => m.sender)).toEqual(["user", "bot-b"]);
expect(store.get("room-1").messages.map((m) => m.sender)).toEqual(["user", "bot-b"]);
const events = readAllRunEvents(home).map((e) => String(e.type));
expect(events).toContain("bus_message_dropped");
// rewrite：bot 回复改写后进群记录（另一家临时 home，避免同名群冲突）
const home2 = tmpHome("nyra-ivr-");
const rwId2 = seedRule(home2, {
name: "改秘密", action: "rewrite", bus: "group", kind: "publish", match: { contains: ["秘密"]},
rewrite: { replace: ["秘密", "公开"]},
});
enableRule(home2, rwId2);
const store2 = groupStore(home2, { "bot-a": "这是秘密", "bot-b": "B 回复"});
const res2 = await store2.send("room-1", "第二轮", 1);
const aReply = res2.messages.find((m) => m.sender === "bot-a");
expect(aReply?.content).toBe("这是公开");
expect(readAllRunEvents(home2).map((e) => String(e.type))).toContain("bus_message_rewritten");
cleanup(home2);
} finally {
cleanup(home);
}
});

test("swarm：被丢弃的轮次不进 turns、不计消息数，计入硬顶", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, {
name: "丢链接", action: "drop", bus: "group", kind: "publish", match: { contains: ["http://"]},
});
enableRule(home, id);
const store = groupStore(home, { "bot-a": "看 http://x", "bot-b": "还是 http://x"});
let stops = 0;
const result = await runGroupChat(store, "room-1", {
mode: "round-robin",
termination: { kind: "external" },
shouldStop: () => { stops += 1; return stops >= 3;},
});
expect(result.turns).toEqual([]);
expect(result.droppedTurns).toBe(2);
expect(result.messages).toBe(0);
expect(store.get("room-1").messages).toEqual([]);
} finally {
cleanup(home);
}
});

test("runOneBot：被丢弃的回复返回空 error 条目，不进群记录", async () => {
const home = tmpHome("nyra-ivr-");
try {
const id = seedRule(home, {
name: "丢链接", action: "drop", bus: "group", kind: "publish", match: { contains: ["http://"]},
});
enableRule(home, id);
const store = groupStore(home, { "bot-a": "看 http://x", "bot-b": "B 回复"});
const entry = await store.runOneBot("room-1", "bot-a");
expect(entry.content).toBe("");
expect(entry.error).toBe(true);
expect(store.get("room-1").messages).toEqual([]);
} finally {
cleanup(home);
}
});

// ---- A2A 与 AG-UI 接线 ---------------------------------------------------

function a2aToken(home: string): { record: A2aServerToken; plaintext: string} {
return createA2aServerToken(home, "client-a");
}

async function a2aSend(
home: string,
token: A2aServerToken,
text: string,
deps?: A2aServerDeps,
): Promise<Record<string, unknown>> {
const res = await dispatchA2aRpc(home, {
jsonrpc: "2.0",
id: 1,
method: "message/send",
params: { message: { role: "user", messageId: "msg-1", parts: [{ kind: "text", text}]}},
}, { token, baseUrl: a2aBaseUrl(home), deps});
return res as Record<string, unknown>;
}

test("A2A 入口：命中 drop 规则回 JSON-RPC 错误，runner 不跑；命中 rewrite 规则 runner 收到改写后的任务", async () => {
const home = tmpHome("nyra-ivr-");
try {
const { record} = a2aToken(home);
let ran = 0;
let seenTask = "";
const deps: A2aServerDeps = {
agentRunner: async (_h, task, opts) => {
ran += 1;
seenTask = task;
return {
taskId: opts.taskId, contextId: opts.contextId, text: "done", textChars: 4,
toolCalls: [], proposals: [], spentUsd: null, error: "",
};
},
};
const dropId = seedRule(home, { name: "丢链接", action: "drop", bus: "a2a", kind: "send", match: { contains: ["http://"]}});
enableRule(home, dropId);
const dropped = await a2aSend(home, record, "看这个 http://x", deps);
expect((dropped.error as Record<string, unknown>).code).toBe(-32000);
expect(String((dropped.error as Record<string, unknown>).message)).toContain("拦截器丢弃");
expect(ran).toBe(0);
const rwId = seedRule(home, {
name: "改秘密", action: "rewrite", bus: "a2a", kind: "send", match: { contains: ["秘密"]},
rewrite: { replace: ["秘密", "公开"]},
});
enableRule(home, rwId);
const ok = await a2aSend(home, record, "这是秘密任务", deps);
expect(ok.error).toBeUndefined();
expect(ran).toBe(1);
// 改写先生效（“秘密”→“公开”），再打不可信标记才进 runner：runner
// 收到的是框好的文本，原文在框里。
expect(seenTask).toContain("这是公开任务");
expect(seenTask).toContain('[untrusted-content kind="peer"');
expect(readAllRunEvents(home).map((e) => String(e.type))).toContain("bus_message_dropped");
} finally {
cleanup(home);
}
});

test("AG-UI 入口：命中 drop 规则 runner 不跑，status blocked", async () => {
const home = tmpHome("nyra-ivr-");
try {
const { record} = createAguiServerToken(home, "client-a") as { record: AguiServerToken; plaintext: string};
const id = seedRule(home, { name: "丢链接", action: "drop", bus: "agui", kind: "send", match: { contains: ["http://"]}});
enableRule(home, id);
let ran = false;
const seen: string[] = [];
const result = await serveAguiServerRun(
home,
{ threadId: "thread-1", runId: "run-1", task: "看这个 http://x", messageCount: 1},
record,
(e) => { seen.push(String(e.type));},
{
agentRunner: async () => {
ran = true;
throw new Error("不该跑到这里");
},
},
);
expect(result.status).toBe("blocked");
expect(ran).toBe(false);
expect(seen).toEqual(["RUN_STARTED", "RUN_ERROR"]);
expect(String(result.error)).toContain("拦截器丢弃");
} finally {
cleanup(home);
}
});

// ---- CLI ----------------------------------------------------------------

test("CLI 全程：add/list/enable/test/log/remove/on/off", async () => {
const home = tmpHome("nyra-ivr-");
try {
expect(await handleIntervention(["add", "--name", "记链接", "--action", "log", "--contains", "http://"], home)).toBe(0);
expect(await handleIntervention(["add", "--name", "丢链接", "--action", "drop", "--contains", "http://"], home)).toBe(0);
const rules = loadInterventions(home).rules;
expect(rules).toHaveLength(2);
const drop = rules.find((r) => r.action === "drop")!;
expect(drop.enabled).toBe(false);
expect(await handleIntervention(["list"], home)).toBe(0);
expect(await handleIntervention(["test", "--bus", "group", "--sender", "bot-a", "--sender-kind", "peer", "--kind", "send", "--text", "看 http://x"], home)).toBe(0);
// drop 规则还没 enable：test 结论是 log（只命中 log 规则）
expect(await handleIntervention(["enable", drop.id], home)).toBe(0);
expect(await handleIntervention(["test", "--bus", "group", "--sender", "bot-a", "--sender-kind", "peer", "--kind", "send", "--text", "看 http://x"], home)).toBe(0);
// 机主消息永远放行
expect(await handleIntervention(["test", "--bus", "group", "--sender", "owner", "--sender-kind", "owner", "--kind", "send", "--text", "看 http://x"], home)).toBe(0);
// 干跑不写审计
expect(readInterventionAudit(home)).toEqual([]);
expect(await handleIntervention(["log"], home)).toBe(0);
expect(await handleIntervention(["remove", drop.id], home)).toBe(0);
expect(await handleIntervention(["remove", drop.id], home)).toBe(1);
expect(await handleIntervention(["off"], home)).toBe(0);
expect(loadInterventions(home).enabled).toBe(false);
expect(await handleIntervention(["on"], home)).toBe(0);
expect(loadInterventions(home).enabled).toBe(true);
expect(await handleIntervention(["bogus"], home)).toBe(2);
expect(await handleIntervention(["test", "--bus", "group"], home)).toBe(2);
expect(await handleIntervention(["add", "--name", "坏", "--action", "drop"], home)).toBe(1);
} finally {
cleanup(home);
}
});

test("事件注册：bus_message_dropped / bus_message_rewritten 在 RunStore 事件链里", async () => {
const home = tmpHome("nyra-ivr-");
try {
const dropId = seedRule(home, { name: "丢", action: "drop", bus: "group", kind: "publish", match: { contains: ["http://"]}});
enableRule(home, dropId);
const store = groupStore(home, { "bot-a": "看 http://x", "bot-b": "B 回复"});
await store.send("room-1", "大家好", 1);
const events = readAllRunEvents(home);
const dropped = events.find((e) => e.type === "bus_message_dropped") as Record<string, unknown> | undefined;
expect(dropped).toBeDefined();
expect(String(dropped!.rule)).toContain(dropId);
expect(String(dropped!.text_fingerprint)).toBe(fingerprintText("看 http://x"));
// 事件里没有原文
expect(JSON.stringify(events)).not.toContain("看 http://x");
} finally {
cleanup(home);
}
});
