// tests/node/test-active-memory.test.ts — G-P1-31 主动记忆。
// 钉住的事：
//   - 配置默认关；损坏先备份再回默认值；保存 0600；
//   - 会话开关优先于全局；跨会话默认关；
//   - quick 档：MEMORY.md + 知识库 BM25，够 2 条不升级；
//   - 不够 2 条升级 deep：放宽上限 + 会话 FTS；
//   - 跨会话关时 deep 只搜本会话，开了才搜别的会话；没会话 id 且跨会话
//     关时不搜会话历史；
//   - 去重 + 单条 300 字截断 + 整段 2000 字截断；
//   - Agent 接线：开了才注入、关了不注入、召回失败不拦运行；
//   - 新运行事件已注册；CLI status/on/off/cross-on/cross-off/test 全程。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  loadActiveMemoryConfig, saveActiveMemoryConfig, isActiveMemoryEnabled,
  setActiveMemoryEnabled, setActiveMemoryCrossSession,
  recallBeforeReply, formatActiveMemorySection,
  ACTIVE_MEMORY_ESCALATE_MIN_HITS,
} from "../../src/activeMemory.ts";
import { KnowledgeBase } from "../../src/knowledge.ts";
import { ConversationStore } from "../../src/conversations.ts";
import { RunStore } from "../../src/runs.ts";
import { Agent } from "../../src/agent.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedMemory(home: string, lines: string[]): void {
  writeFileSync(join(home, "MEMORY.md"), lines.join("\n") + "\n", "utf-8");
}

function seedKb(home: string, name: string, title: string, text: string): void {
  const kb = new KnowledgeBase(join(home, "knowledge"));
  kb.create(name, "");
  kb.addText(name, text, title, "test");
}

function seedSession(home: string, sessionId: string, text: string, ts = 1780000000): void {
  const store = new ConversationStore(home);
  try {
    store.record(sessionId, "user", text, null, ts, { workingDir: tmpdir() });
  } finally {
    store.close();
  }
}

function runCli(home: string, workdir: string, args: string[]) {
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls: Record<string, unknown>[][] = [];
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

test("ActiveMemoryTest.test_config_defaults", () => {
  const home = tmpHome("nyra-am-home-");
  const cfg = loadActiveMemoryConfig(home);
  expect(cfg.enabled).toBe(false);
  expect(cfg.crossSession).toBe(false);
  expect(cfg.sessions).toEqual({});
});

test("ActiveMemoryTest.test_config_roundtrip_and_perms", () => {
  const home = tmpHome("nyra-am-home-");
  saveActiveMemoryConfig(home, { enabled: true, crossSession: true, sessions: { "sess-1": false } });
  expectPerms(join(home, "active-memory.json"), 0o600);
  const cfg = loadActiveMemoryConfig(home);
  expect(cfg.enabled).toBe(true);
  expect(cfg.crossSession).toBe(true);
  expect(cfg.sessions["sess-1"]).toBe(false);
});

test("ActiveMemoryTest.test_config_corrupt_backs_up_and_defaults", () => {
  const home = tmpHome("nyra-am-home-");
  writeFileSync(join(home, "active-memory.json"), "{not json", "utf-8");
  const cfg = loadActiveMemoryConfig(home);
  expect(cfg.enabled).toBe(false);
  expect(cfg.crossSession).toBe(false);
  expect(readdirSync(home).some((f) => f.startsWith("active-memory.json.bak-"))).toBe(true);
});

test("ActiveMemoryTest.test_session_override_beats_global", () => {
  const home = tmpHome("nyra-am-home-");
  expect(isActiveMemoryEnabled(home, "s1")).toBe(false);
  setActiveMemoryEnabled(home, true);
  expect(isActiveMemoryEnabled(home, "s1")).toBe(true);
  setActiveMemoryEnabled(home, false, "s1");
  expect(isActiveMemoryEnabled(home, "s1")).toBe(false);
  expect(isActiveMemoryEnabled(home, "s2")).toBe(true);
  setActiveMemoryEnabled(home, true, "s2");
  setActiveMemoryEnabled(home, false);
  expect(isActiveMemoryEnabled(home, "s2")).toBe(true);
  expect(isActiveMemoryEnabled(home, "s1")).toBe(false);
  expect(isActiveMemoryEnabled(home)).toBe(false);
});

test("ActiveMemoryTest.test_cross_session_toggle", () => {
  const home = tmpHome("nyra-am-home-");
  expect(loadActiveMemoryConfig(home).crossSession).toBe(false);
  setActiveMemoryCrossSession(home, true);
  expect(loadActiveMemoryConfig(home).crossSession).toBe(true);
  setActiveMemoryCrossSession(home, false);
  expect(loadActiveMemoryConfig(home).crossSession).toBe(false);
});

test("ActiveMemoryTest.test_quick_recall_memory_and_kb", async () => {
  const home = tmpHome("nyra-am-home-");
  seedMemory(home, [
    "用户喜欢用工业机器人调试做例子。",
    "用户的店叫 Hollow & Scale，卖宠物用品。",
    "今天天气晴。",
  ]);
  seedKb(home, "notes", "调试手册", "工业机器人调试先检查伺服驱动器参数再校准零点。");
  const recall = await recallBeforeReply(home, "工业机器人调试", { memoryPath: join(home, "MEMORY.md") });
  expect(recall.tier).toBe("quick");
  expect(recall.escalated).toBe(false);
  expect(recall.hits.length).toBeGreaterThanOrEqual(ACTIVE_MEMORY_ESCALATE_MIN_HITS);
  expect(recall.hits.some((h) => h.source === "memory")).toBe(true);
  expect(recall.hits.some((h) => h.source === "knowledge")).toBe(true);
  expect(recall.text).toContain("主动记忆");
  expect(recall.text).toContain("快速召回");
});

test("ActiveMemoryTest.test_escalate_to_deep_on_thin_quick", async () => {
  const home = tmpHome("nyra-am-home-");
  seedMemory(home, ["今天天气晴。"]);
  seedSession(home, "sess-a", "工业机器人调试遇到转速不稳的问题");
  const recall = await recallBeforeReply(home, "工业机器人调试", {
    sessionId: "sess-a",
    memoryPath: join(home, "MEMORY.md"),
  });
  expect(recall.tier).toBe("deep");
  expect(recall.escalated).toBe(true);
  expect(recall.hits.some((h) => h.source === "session" && h.ref === "sess-a")).toBe(true);
  expect(recall.text).toContain("深挖");
});

test("ActiveMemoryTest.test_cross_session_off_blocks_other_sessions", async () => {
  const home = tmpHome("nyra-am-home-");
  seedMemory(home, ["今天天气晴。"]);
  seedSession(home, "sess-b", "工业机器人调试遇到转速不稳的问题");
  const recall = await recallBeforeReply(home, "工业机器人调试", {
    sessionId: "sess-a",
    memoryPath: join(home, "MEMORY.md"),
  });
  expect(recall.tier).toBe("deep");
  expect(recall.hits.some((h) => h.source === "session")).toBe(false);
});

test("ActiveMemoryTest.test_cross_session_on_sees_other_sessions", async () => {
  const home = tmpHome("nyra-am-home-");
  seedMemory(home, ["今天天气晴。"]);
  seedSession(home, "sess-b", "工业机器人调试遇到转速不稳的问题");
  setActiveMemoryCrossSession(home, true);
  const recall = await recallBeforeReply(home, "工业机器人调试", {
    sessionId: "sess-a",
    memoryPath: join(home, "MEMORY.md"),
  });
  expect(recall.hits.some((h) => h.source === "session" && h.ref === "sess-b")).toBe(true);
});

test("ActiveMemoryTest.test_no_session_id_and_cross_off_skips_sessions", async () => {
  const home = tmpHome("nyra-am-home-");
  seedMemory(home, ["今天天气晴。"]);
  seedSession(home, "sess-b", "工业机器人调试遇到转速不稳的问题");
  const recall = await recallBeforeReply(home, "工业机器人调试", {
    memoryPath: join(home, "MEMORY.md"),
  });
  expect(recall.hits.some((h) => h.source === "session")).toBe(false);
});

test("ActiveMemoryTest.test_dedupe_and_clip", async () => {
  const home = tmpHome("nyra-am-home-");
  const long = `工业机器人调试${"要点".repeat(200)}`;
  seedMemory(home, [long, long, "工业机器人调试第二条。"]);
  const recall = await recallBeforeReply(home, "工业机器人调试", { memoryPath: join(home, "MEMORY.md") });
  const texts = recall.hits.map((h) => h.text);
  expect(new Set(texts).size).toBe(texts.length);
  for (const h of recall.hits) expect(h.text.length).toBeLessThanOrEqual(300);
  expect(recall.text.length).toBeLessThanOrEqual(2000 + "…（已截断）".length + 100);
});

test("ActiveMemoryTest.test_format_empty_is_empty", () => {
  expect(formatActiveMemorySection({ tier: "quick", escalated: false, hits: [], text: "" })).toBe("");
});

test("ActiveMemoryTest.test_agent_injects_when_enabled", async () => {
  const home = tmpHome("nyra-am-home-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-am-wd-"));
  seedMemory(home, ["用户喜欢用工业机器人调试做例子。", "工业机器人调试先检查伺服驱动器。"]);
  setActiveMemoryEnabled(home, true);
  const provider = new FakeProvider([textReply("ok")]);
  const agent = new Agent(provider as never, { home, workdir, mode: "full", skillsDirs: [] });
  await agent.run("工业机器人调试遇到问题");
  const system = String((provider.calls[0]?.[0] as { content?: unknown })?.content ?? "");
  expect(system).toContain("主动记忆");
  expect(system).toContain("工业机器人调试");
});

test("ActiveMemoryTest.test_agent_skips_when_disabled", async () => {
  const home = tmpHome("nyra-am-home-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-am-wd-"));
  seedMemory(home, ["用户喜欢用工业机器人调试做例子。", "工业机器人调试先检查伺服驱动器。"]);
  const provider = new FakeProvider([textReply("ok")]);
  const agent = new Agent(provider as never, { home, workdir, mode: "full", skillsDirs: [] });
  await agent.run("工业机器人调试遇到问题");
  const system = String((provider.calls[0]?.[0] as { content?: unknown })?.content ?? "");
  expect(system).not.toContain("主动记忆");
});

test("ActiveMemoryTest.test_events_registered", () => {
  const home = tmpHome("nyra-am-home-");
  const store = new RunStore(join(home, "runs"));
  const run = store.create("t", "sess-1", tmpdir(), "full", 5);
  store.appendEvent(run.run_id, "active_memory_recalled", { tier: "quick", hits: 2, escalated: false });
  store.appendEvent(run.run_id, "active_memory_escalated", { tier: "deep", hits: 1 });
  expect(() => store.appendEvent(run.run_id, "no_such_event_xyz", {})).toThrow("运行事件无效");
});

test("ActiveMemoryTest.test_cli_full_flow", () => {
  const home = tmpHome("nyra-am-home-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-am-wd-"));
  seedMemory(home, ["用户喜欢用工业机器人调试做例子。", "工业机器人调试先检查伺服驱动器。"]);
  let r = runCli(home, workdir, ["memory", "recall", "status"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("全局关");
  r = runCli(home, workdir, ["memory", "recall", "on"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("全局");
  r = runCli(home, workdir, ["memory", "recall", "test", "工业机器人调试"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("快速召回");
  expect(r.stdout).toContain("主动记忆");
  r = runCli(home, workdir, ["memory", "recall", "cross-on"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("跨会话已开");
  r = runCli(home, workdir, ["memory", "recall", "off", "sess-9"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("sess-9");
  r = runCli(home, workdir, ["memory", "recall", "bogus"]);
  expect(r.status).toBe(2);
  r = runCli(home, workdir, ["memory", "recall", "test"]);
  expect(r.status).toBe(2);
});
