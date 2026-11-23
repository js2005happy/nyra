// tests/node/test-agent.test.ts — 对应 tests/test_agent.py 行为 + test_delegation_budget.py（5 唯一）+
// test_auto_compact.py（11 唯一）的核心项 + 方案 2.6 第 5/7/8 条专项。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent, DelegationBudget, SYSTEM_PROMPT_BASE, MODE_NOTES,
  MAX_DELEGATE_DEPTH, MAX_DELEGATE_CALLS, MAX_DELEGATE_TURNS, AgentError,
} from "../../src/agent.ts";
import { Gateway } from "../../src/gateway.ts";

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
function toolReply(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-agent-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-agent-wd-"));
  return { home, workdir };
}

test("AgentTest.test_delegation_constants", () => {
  expect(MAX_DELEGATE_DEPTH).toBe(2);
  expect(MAX_DELEGATE_CALLS).toBe(8);
  expect(MAX_DELEGATE_TURNS).toBe(12);
  expect(SYSTEM_PROMPT_BASE).toContain("最多 8 个子 agent");
  expect(SYSTEM_PROMPT_BASE).toContain("最多嵌套 2 层");
  expect(MODE_NOTES.readonly).toContain("只读");
  expect(MODE_NOTES.auto).toContain("自动确认");
  expect(MODE_NOTES.full).toContain("全权");
});

test("AgentTest.test_delegation_budget", () => {
  const budget = new DelegationBudget();
  expect(budget.remaining()).toBe(8);
  for (let i = 0; i < 8; i++) expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(false);
  budget.reset();
  expect(budget.remaining()).toBe(8);
});

test("AgentTest.test_tool_schemas_count_and_disabled", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  expect(agent.toolSchemas().length).toBe(40); // 缺口 1 + 缺口 2：新增 memory_search / memory_forget / memory_delete；缺口 3a：新增 delegate_parallel；缺口 6：新增 gmail_search / gmail_read / gmail_send；缺口 24：新增 lsp_diagnostics / lsp_symbols；缺口 16：新增 describe_image；缺口 23：新增 export_office；候选提案 4：新增 media_ingest；缺口 33：新增 knowledge_search；G-P1-14：新增 session_search；G-P0-3：新增 editor_context。
  const noShell = new Agent(new FakeProvider([]) as never, {
    workdir, home, mode: "full", skillsDirs: [], disabledTools: ["shell", "write_file"],
  });
  const names = noShell.toolSchemas().map((s) => (s.function as Record<string, unknown>).name);
  expect(names).not.toContain("shell");
  expect(names).not.toContain("write_file");
  expect(names.length).toBe(38); // 40 个基础工具 − 禁掉的 shell / write_file。
  const poppy = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], poppyEnabled: true });
  expect(poppy.toolSchemas().length).toBe(43); // 40 个基础工具 + 3 个 Poppy 工具。
});

test("AgentTest.test_tool_schemas_no_apply_patch_with_backend", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
    backend: { name: "e2b", readFile: () => "", writeFile: () => "", listDir: () => "", runCommand: () => "" },
  });
  const names = agent.toolSchemas().map((s) => (s.function as Record<string, unknown>).name);
  expect(names).not.toContain("apply_patch");
});

test("AgentTest.test_build_system_prompt_deterministic", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "auto", skillsDirs: [] });
  const a = agent.buildSystemPrompt("读文件");
  const b = agent.buildSystemPrompt("读文件");
  expect(a).toBe(b);
  expect(a).toContain(SYSTEM_PROMPT_BASE);
  expect(a).toContain("自动确认");
});

test("AgentTest.test_run_local_task_end_to_end", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "write_file", { path: "a.txt", content: "hi\n" }),
    textReply("写好了"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261118-000000-agent1",
  });
  const out = await agent.run("写 a.txt");
  expect(out).toBe("写好了");
  expect(existsSync(join(workdir, "a.txt"))).toBe(true);
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("hi\n");
  expect(agent.usage.calls).toBe(2);
  expect(agent.turn).toBe(2);
});

test("AgentTest.test_reasoning_content_preserved_across_turns", async () => {
  // DeepSeek 思考模式：模型返回的 reasoning_content 下轮必须原样带回，
  // 否则 API 报 400。第一轮带 reasoning_content + 工具调用，第二轮的
  // 请求里同一条 assistant 消息必须仍带该字段。
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    {
      choices: [{
        message: {
          content: "",
          reasoning_content: "先写文件再汇报",
          tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "hi\n" }) } }],
        },
      }],
    },
    textReply("写好了"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261118-000000-agent-reasoning",
  });
  const out = await agent.run("写 a.txt");
  expect(out).toBe("写好了");
  expect(provider.calls.length).toBe(2);
  const second = provider.calls[1] as Record<string, unknown>[];
  const assistant = second.find((m) => (m as Record<string, unknown>).role === "assistant") as Record<string, unknown>;
  expect(assistant).toBeDefined();
  expect(assistant.reasoning_content).toBe("先写文件再汇报");
  expect((assistant.tool_calls as unknown[]).length).toBe(1);
});

test("AgentTest.test_empty_reasoning_content_preserved_across_turns", async () => {
  // DeepSeek 有时返回 reasoning_content: ""（空字符串）；缺字段和空字段
  // 在服务端是两种待遇，缺了下轮就报 400，所以空字符串也要原样带回。
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    {
      choices: [{
        message: {
          content: "",
          reasoning_content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "hi\n" }) } }],
        },
      }],
    },
    textReply("写好了"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261118-000000-agent-reasoning-empty",
  });
  const out = await agent.run("写 a.txt");
  expect(out).toBe("写好了");
  expect(provider.calls.length).toBe(2);
  const second = provider.calls[1] as Record<string, unknown>[];
  const assistant = second.find((m) => (m as Record<string, unknown>).role === "assistant") as Record<string, unknown>;
  expect(assistant).toBeDefined();
  expect("reasoning_content" in assistant).toBe(true);
  expect(assistant.reasoning_content).toBe("");
});

test("AgentTest.test_run_records_usage_events", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([{
    choices: [{ message: { content: "done", tool_calls: [] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }]);
  const seen: string[] = [];
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    sessionId: "20261118-000000-agent2",
    onEvent: (kind) => { seen.push(kind); },
  });
  await agent.run("hi");
  expect(seen).toContain("final");
  expect(seen).toContain("usage");
  expect(agent.usage.reported_calls).toBe(1);
  expect(agent.usage.total_tokens).toBe(15);
});

test("AgentTest.test_prompt_cache_invariant_same_system_and_schemas", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "read_file", { path: "a.txt" }),
    toolReply("c2", "read_file", { path: "a.txt" }),
    textReply("done"),
  ]);
  writeFileSync(join(workdir, "a.txt"), "content\n");
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261118-000000-agent3",
  });
  await agent.run("读两次 a.txt");
  expect(provider.calls.length).toBe(3);
  const systems = provider.calls.map((msgs) => JSON.stringify((msgs[0] as Record<string, unknown>).content));
  expect(new Set(systems).size).toBe(1);
  // 工具 schema 逐轮不变：每次调用的 tools 参数应相同。
  const toolSets = provider.calls.map((msgs) => JSON.stringify((msgs as unknown as Record<string, unknown>).tools ?? null));
  expect(new Set(toolSets).size).toBe(1);
});

test("AgentTest.test_max_turns_returns_chinese_notice", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "read_file", { path: "a.txt" }),
  ]);
  writeFileSync(join(workdir, "a.txt"), "x\n");
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 2, skillsDirs: [],
    sessionId: "20261118-000000-agent4",
  });
  const out = await agent.run("一直读");
  expect(out).toContain("轮");
  expect(provider.calls.length).toBe(2);
});

test("AgentTest.test_delegate_child_fresh_session_and_summary_only", async () => {
  const { home, workdir } = setup();
  // 父级第 1 轮调 delegate；子级（同一 FakeProvider 的后续调用）直接给最终文本；
  // 父级第 2 轮收尾。
  const provider = new FakeProvider([
    toolReply("c1", "delegate", { task: "数一数", max_turns: 3 }),
    textReply("子任务结果：42"),
    textReply("父级收尾：42"),
  ]);
  const parentEvents: { kind: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261118-000000-parent",
    onEvent: (kind, data) => { parentEvents.push({ kind, data }); },
  });
  const out = await agent.run("派个子任务数一数");
  expect(out).toContain("父级收尾");
  // 父级只看到 delegate 的一次调用与最终摘要：子级内部没有 tool_start 事件
  // 以子级身份混入父级观察器。
  const delegateStarts = parentEvents.filter((e) => e.kind === "tool_start" && (e.data.name as string) === "delegate");
  expect(delegateStarts.length).toBe(1);
  const delegateResults = parentEvents.filter((e) => e.kind === "tool_result" && (e.data.name as string) === "delegate");
  expect(delegateResults.length).toBe(1);
  expect(String(delegateResults[0].data.result ?? "")).toContain("[子任务 task-");
  expect(String(delegateResults[0].data.result ?? "")).toContain("子任务结果：42");
  // 子级用了全新会话：sessions 目录下应出现父级之外的会话文件。
  const sessionsDir = join(home, "sessions");
  const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  expect(files.some((f) => f.includes("20261118-000000-parent"))).toBe(true);
  expect(files.length).toBeGreaterThanOrEqual(2);
});

test("AgentTest.test_delegate_depth_limit", async () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, {
    workdir, home, mode: "full", skillsDirs: [], delegateDepth: 2,
  });
  const out = await agent.delegate("做点事");
  expect(out).toContain("最大委派深度");
  expect(out).toContain("2");
});

test("AgentTest.test_delegate_budget_exhausted", async () => {
  const { home, workdir } = setup();
  const budget = new DelegationBudget();
  for (let i = 0; i < 8; i++) budget.consume();
  const agent = new Agent(new FakeProvider([]) as never, {
    workdir, home, mode: "full", skillsDirs: [], delegateBudget: budget,
  });
  const out = await agent.delegate("做点事");
  expect(out).toContain("第 0 层子 agent 预算已用完");
  expect(out).toContain("每层最多 8 个");
});

test("AgentTest.test_delegate_max_turns_validation", async () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  expect(await agent.delegate("做点事", 0)).toContain("max_turns 必须在 1 到 12 之间");
  expect(await agent.delegate("做点事", 13)).toContain("max_turns 必须在 1 到 12 之间");
});

test("AgentTest.test_delegate_child_failure_reported_not_thrown", async () => {
  const { home, workdir } = setup();
  const failing = new FakeProvider([textReply("ok")]);
  (failing as unknown as Record<string, unknown>).chat = async () => { throw new AgentError("子级炸了"); };
  const parent = new Agent(failing as never, { workdir, home, mode: "full", skillsDirs: [] });
  const out = await parent.delegate("做点事", 2);
  expect(out).toContain("子任务失败");
  expect(out).toContain("子级炸了");
});

test("AgentTest.test_compact_local_fallback_keeps_head_and_tail", async () => {
  const { home, workdir } = setup();
  // 摘要失败时走本地回退：agent.messages 本就不含 system（system 只在运行
  // 时临时拼在消息首），回退保留首条 user 消息 + 尾部，绝不编造内容。
  const failing = new FakeProvider([]);
  (failing as unknown as Record<string, unknown>).chat = async () => { throw new Error("模型挂了"); };
  const agent = new Agent(failing as never, {
    workdir, home, mode: "full", skillsDirs: [],
    sessionId: "20261118-000000-agent5",
  });
  agent.messages = [
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "答一" },
    { role: "user", content: "第二轮" },
    { role: "assistant", content: "答二" },
    { role: "user", content: "第三轮" },
    { role: "assistant", content: "答三" },
  ];
  const info = await agent.compact(2);
  expect(info.before).toBe(6);
  expect(info.method).toBe("fallback");
  expect(info.after).toBe(4);
  expect(agent.messages[0].content).toContain("压缩失败");
  expect(JSON.stringify(agent.messages)).toContain("第一轮");
  expect(JSON.stringify(agent.messages)).toContain("第三轮");
});

test("AgentTest.test_readonly_mode_blocks_write_via_agent", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "write_file", { path: "a.txt", content: "hi\n" }),
    textReply("done"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "readonly", maxTurns: 3, skillsDirs: [],
    sessionId: "20261118-000000-agent6",
  });
  const out = await agent.run("写 a.txt");
  expect(existsSync(join(workdir, "a.txt"))).toBe(false);
  expect(out.length).toBeGreaterThan(0);
});

test("AgentTest.test_creator_mode_loads_creator_skill", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "creator", skillsDirs: [] });
  expect(agent.skills.map((s) => s.name)).toContain("creator-mode");
  expect(MODE_NOTES.creator).toContain("创造模式");
  expect(agent.buildSystemPrompt("做个番茄钟")).toContain("创造模式");
  agent.setMode("auto");
  expect(agent.mode).toBe("auto");
  expect(agent.ctx.mode).toBe("auto");
  expect(agent.skills.map((s) => s.name)).not.toContain("creator-mode");
  agent.setMode("creator");
  expect(agent.skills.map((s) => s.name)).toContain("creator-mode");
});

test("AgentTest.test_creator_mode_skill_matches_builtin_text", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "creator", skillsDirs: [] });
  const skill = agent.skills.find((s) => s.name === "creator-mode");
  expect(skill).toBeDefined();
  expect(skill?.description).toContain("一句话需求");
});

// ---- 调研报告第 3 项：上下文补齐（学 Claude Code）----

test("ContextUsageTest.test_four_parts_sum_to_total_and_estimated", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "auto", skillsDirs: [] });
  agent.messages = [
    { role: "user", content: "你好世界" },
    { role: "assistant", content: "你好呀" },
    { role: "tool", content: "工具结果", tool_call_id: "c1" },
  ];
  const u = agent.contextUsage();
  expect(u.skills).toBe(0);
  expect(u.history).toBe(7);
  expect(u.toolResults).toBe(4);
  expect(u.system).toBe(agent.buildSystemPrompt().length);
  expect(u.totalChars).toBe(u.system + u.skills + u.history + u.toolResults);
  // 模型没报告用量：窗口未知、usedTokens 是估算并明确标记。
  expect(u.windowTokens).toBeNull();
  expect(u.estimated).toBe(true);
  expect(u.usedTokens).toBe(Math.ceil(u.totalChars / 4));
});

test("ContextUsageTest.test_reported_usage_is_not_estimate", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, {
    workdir, home, mode: "auto", skillsDirs: [], contextWindowTokens: 1000,
  });
  agent.messages = [{ role: "user", content: "你好" }];
  agent.usage.record({ usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
  const u = agent.contextUsage();
  expect(u.windowTokens).toBe(1000);
  expect(u.usedTokens).toBe(100);
  expect(u.estimated).toBe(false);
});

test("ContextUsageTest.test_re_read_note_counts_as_system_not_history", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "auto", skillsDirs: [] });
  const reRead = "[压缩后重读：记忆与规则]\n## 长期记忆\n- 用户是学生";
  agent.messages = [
    { role: "user", content: reRead },
    { role: "user", content: "普通问题" },
  ];
  const u = agent.contextUsage();
  expect(u.system).toBe(agent.buildSystemPrompt().length + reRead.length);
  expect(u.history).toBe("普通问题".length);
  expect(u.totalChars).toBe(u.system + u.skills + u.history + u.toolResults);
});

function setupReReadFiles(home: string, workdir: string): void {
  writeFileSync(join(home, "MEMORY.md"), "- [2026-11-19] 记忆锚点-XYZ\n- 喜欢中文\n");
  writeFileSync(join(workdir, "AGENTS.md"), "# 项目说明\n\n第一段规则。\n\n第二段规则-锚点。\n\n第三段规则-锚点二。\n");
}

test("ContextUsageTest.test_compact_focus_keeps_keyword_and_re_reads_real_files", async () => {
  const { home, workdir } = setup();
  setupReReadFiles(home, workdir);
  const agent = new Agent(new FakeProvider([textReply("摘要文本")]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
    sessionId: "20261119-000000-ctx1",
  });
  agent.messages = [
    { role: "user", content: "聊聊部署流程" },
    { role: "assistant", content: "部署分三步" },
    { role: "user", content: "今天天气不错" },
    { role: "assistant", content: "是啊很晴朗" },
    { role: "user", content: "最新问题" },
    { role: "assistant", content: "最新回答" },
  ];
  const info = await agent.compact(2, "部署");
  expect(info.method).toBe("model");
  const text = JSON.stringify(agent.messages);
  expect((agent.messages[0] as Record<string, unknown>).content).toContain("摘要文本");
  // 重读备注在摘要之后（第 3 条），内容来自真实文件（记忆 + AGENTS.md 末尾段落）。
  expect((agent.messages[2] as Record<string, unknown>).content).toContain("[压缩后重读：记忆与规则]");
  expect(text).toContain("记忆锚点-XYZ");
  expect(text).toContain("第二段规则-锚点");
  expect(text).toContain("第三段规则-锚点二");
  expect(text).not.toContain("第一段规则");
  // focus：含关键词的旧消息保留，不含的不保留；尾部照常保留。
  expect(text).toContain("聊聊部署流程");
  expect(text).not.toContain("今天天气不错");
  expect(text).toContain("最新问题");
});

test("ContextUsageTest.test_compact_without_focus_behaves_as_before_but_still_re_reads", async () => {
  const { home, workdir } = setup();
  setupReReadFiles(home, workdir);
  const agent = new Agent(new FakeProvider([textReply("摘要文本")]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
    sessionId: "20261119-000000-ctx2",
  });
  agent.messages = [
    { role: "user", content: "聊聊部署流程" },
    { role: "assistant", content: "部署分三步" },
    { role: "user", content: "今天天气不错" },
    { role: "assistant", content: "是啊很晴朗" },
    { role: "user", content: "最新问题" },
    { role: "assistant", content: "最新回答" },
  ];
  const info = await agent.compact(2);
  expect(info.method).toBe("model");
  const text = JSON.stringify(agent.messages);
  // 不带 focus：旧消息只剩尾部 2 条；重读仍在（压缩成功）。
  expect(text).not.toContain("聊聊部署流程");
  expect(text).not.toContain("今天天气不错");
  expect(text).toContain("最新问题");
  expect(text).toContain("[压缩后重读：记忆与规则]");
  expect(text).toContain("记忆锚点-XYZ");
});

test("ContextUsageTest.test_auto_compact_also_re_reads_memory", async () => {
  const { home, workdir } = setup();
  setupReReadFiles(home, workdir);
  writeFileSync(join(workdir, "a.txt"), "content\n");
  const provider = new FakeProvider([
    {
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }],
        },
      }],
      usage: { prompt_tokens: 90, completion_tokens: 5, total_tokens: 95 },
    },
    textReply("摘要文本"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261119-000000-ctx3",
    contextWindowTokens: 100, autoCompactEnabled: true, autoCompactThreshold: 0.5,
  });
  agent.messages = [
    { role: "user", content: "第一轮问部署：" + "背景描述。".repeat(12) },
    { role: "assistant", content: "答一：" + "很长的解释。".repeat(12) },
    { role: "user", content: "第二轮问部署：" + "背景描述。".repeat(12) },
    { role: "assistant", content: "答二：" + "很长的解释。".repeat(12) },
    { role: "user", content: "第三轮：" + "背景描述。".repeat(12) },
    { role: "assistant", content: "答三：" + "很长的解释。".repeat(12) },
  ];
  const out = await agent.run("读 a.txt");
  expect(out).toBe("摘要文本");
  expect(agent.autoCompactCount).toBe(1);
  const text = JSON.stringify(agent.messages);
  expect(text).toContain("[压缩后重读：记忆与规则]");
  expect(text).toContain("记忆锚点-XYZ");
});

test("ContextUsageTest.test_gateway_session_view_exposes_context", () => {
  const { home, workdir } = setup();
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, config: {} });
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "auto", skillsDirs: [] });
  agent.messages = [
    { role: "user", content: "你好世界" },
    { role: "tool", content: "工具结果", tool_call_id: "c1" },
  ];
  const run = gw.getRun("s-ctx");
  run.agent = agent;
  const view = gw.sessionView("s-ctx") as unknown as { context: Record<string, unknown> };
  expect(view.context).not.toBeNull();
  expect(view.context.totalChars).toBe(agent.contextUsage().totalChars);
  expect((view.context.system as number) + (view.context.skills as number) +
    (view.context.history as number) + (view.context.toolResults as number)).toBe(view.context.totalChars);
  // 没有 live agent 的会话不编造 context。
  const empty = gw.sessionView("no-such-session") as unknown as { context: unknown };
  expect(empty.context).toBeNull();
});
