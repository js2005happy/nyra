// tests/node/test-lazy-tools.test.ts — MCP 延迟加载第二步（search_tools 元工具）。
//
// 契约：
//   - MCP 工具 ≤ 8 个时全量发送，不挂 search_tools（行为与原来完全一致）
//   - MCP 工具 > 8 个时按任务文本挑最相关的前 8 个，其余进 deferredTools，
//     search_tools 挂进 schemas，describeDeferred 说明拼进 system prompt
//   - NYRA_LAZY_TOOLS=0 关闭延迟加载（逃生口）
//   - search_tools 只读、无副作用、不走审批；命中工具的完整定义以 JSON 返回，
//     并追加进本轮 schemas（后续轮次直接发给模型），同时从 deferredTools 移除
//   - 检索无命中返回空列表（不全量回退）；首轮选择无命中时仍全量回退
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { searchDeferredTools, formatSearchResults } from "../../src/toolSearch.ts";

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls: { messages: Record<string, unknown>[]; schemas: Record<string, unknown>[] }[] = [];
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[], schemas: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push({ messages: [...messages], schemas: [...schemas] });
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

function mcpTool(name: string, description: string) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties: {} } } };
}

const MCP_TOOLS_10 = [
  mcpTool("mcp__memory__search", "在记忆库里检索相关内容"),
  mcpTool("mcp__memory__store", "把内容存进记忆库"),
  mcpTool("mcp__browser__screenshot", "控制浏览器截图"),
  mcpTool("mcp__browser__navigate", "控制浏览器打开网页"),
  mcpTool("mcp__fetch__get", "抓取网页内容"),
  mcpTool("mcp__time__now", "查询当前时间"),
  mcpTool("mcp__calc__add", "计算加法"),
  mcpTool("mcp__files__read", "读取远程文件"),
  mcpTool("mcp__mail__send", "发送邮件"),
  mcpTool("mcp__calendar__list", "列出日程"),
];

function fakeMcp(tools: Record<string, unknown>[]) {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  return {
    manager: {
      hasTools: () => tools.length > 0,
      toolSchemas: tools,
      execute: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, args });
        return `mcp ${name} 执行成功`;
      },
    },
    executed,
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-lazy-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-lazy-wd-"));
  return { home, workdir };
}

function schemaNames(schemas: Record<string, unknown>[]): string[] {
  return schemas.map((s) => (s.function as Record<string, unknown>).name as string);
}

test("MCP ≤ 8 个时全量发送，不挂 search_tools（行为不变）", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10.slice(0, 3));
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
  expect(names.length).toBe(49); // 46 个基础工具 + 3 个 MCP 工具。
  expect(names).not.toContain("search_tools");
  expect(names).toContain("mcp__browser__screenshot");
});

test("MCP > 8 个时只发最相关的前 8 个，其余进 deferredTools 并挂 search_tools", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
  expect(names).toContain("mcp__browser__screenshot");
  expect(names).toContain("mcp__browser__navigate");
  expect(names).toContain("search_tools");
  expect(names).not.toContain("mcp__memory__search");
  expect(names).not.toContain("mcp__mail__send");
  expect(names.length).toBe(46 + 2 + 1); // 46 个基础工具 + 2 个相关 MCP 工具 + search_tools。
  const deferred = schemaNames((agent as unknown as { deferredTools: Record<string, unknown>[] }).deferredTools);
  expect(deferred.length).toBe(8);
  expect(deferred).toContain("mcp__memory__search");
  expect(deferred).not.toContain("mcp__browser__screenshot");
});

test("NYRA_LAZY_TOOLS=0 关闭延迟加载（逃生口）", () => {
  const prev = process.env.NYRA_LAZY_TOOLS;
  process.env.NYRA_LAZY_TOOLS = "0";
  try {
    const { home, workdir } = setup();
    const { manager } = fakeMcp(MCP_TOOLS_10);
    const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
    const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
    expect(names.length).toBe(46 + 10); // 46 个基础工具 + 10 个 MCP 工具，无 search_tools。
    expect(names).not.toContain("search_tools");
  } finally {
    if (prev === undefined) delete process.env.NYRA_LAZY_TOOLS; else process.env.NYRA_LAZY_TOOLS = prev;
  }
});

test("首轮选择无命中时全量回退（绝不让模型没工具用）", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("zzz"));
  expect(names.length).toBe(46 + 10); // 46 个基础工具 + 10 个 MCP 工具，无 search_tools。
  expect(names).not.toContain("search_tools");
});

test("searchDeferredTools：命中返回完整定义 JSON，无命中返回空列表", () => {
  const deferred = MCP_TOOLS_10 as never;
  const hit = searchDeferredTools(deferred, "控制浏览器截图", 8);
  expect(hit.kept).toContain("mcp__browser__screenshot");
  const defs = JSON.parse(formatSearchResults(hit, deferred)) as Record<string, unknown>[];
  expect(defs.some((d) => (d.function as Record<string, unknown>).name === "mcp__browser__screenshot")).toBe(true);
  expect(defs[0]).toHaveProperty("function.parameters");
  const miss = searchDeferredTools(deferred, "zzz", 8);
  expect(miss.kept).toEqual([]);
  expect(formatSearchResults(miss, deferred)).toContain("没有匹配到工具");
});

test("端到端：检索 → 拉回 → 下一轮 schema 里出现该工具 → MCP 真执行", async () => {
  const { home, workdir } = setup();
  const { manager, executed } = fakeMcp(MCP_TOOLS_10);
  const provider = new FakeProvider([
    toolReply("c1", "search_tools", { query: "打开网页" }),
    toolReply("c2", "mcp__browser__navigate", { url: "https://example.com" }),
    textReply("搞定"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const final = await agent.run("帮我发一封邮件并截个图确认");
  expect(final).toBe("搞定");
  // 第一轮：search_tools 在，mcp__browser__navigate 不在（被延迟了）
  const round1 = schemaNames(provider.calls[0].schemas);
  expect(round1).toContain("search_tools");
  expect(round1).not.toContain("mcp__browser__navigate");
  // system prompt 告诉模型有工具没发、怎么拿回来
  const system = provider.calls[0].messages[0].content as string;
  expect(system).toContain("未发送");
  expect(system).toContain("search_tools");
  // 检索结果是命中工具的完整定义 JSON
  const searchResult = provider.calls[1].messages.find((m) => m.role === "tool")?.content as string;
  expect(searchResult).toContain("mcp__browser__navigate");
  const defs = JSON.parse(searchResult) as Record<string, unknown>[];
  expect(defs[0]).toHaveProperty("function.parameters");
  // 第二轮：拉回的工具出现在 schemas 里，MCP 真执行了
  expect(schemaNames(provider.calls[1].schemas)).toContain("mcp__browser__navigate");
  expect(executed.map((e) => e.name)).toContain("mcp__browser__navigate");
});

test("search_tools 只读：不走审批（approveFn 不被调用）", async () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const approvals: string[] = [];
  const provider = new FakeProvider([
    toolReply("c1", "search_tools", { query: "打开网页" }),
    textReply("查到了"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "auto", skillsDirs: [], mcpManager: manager as never,
    approveFn: async (tool: string) => { approvals.push(tool); return true; },
  });
  const final = await agent.run("帮我发一封邮件并截个图确认");
  expect(final).toBe("查到了");
  expect(approvals).toEqual([]);
});

test("拉回后工具从 deferredTools 移除：二次检索同一关键词无命中", async () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const provider = new FakeProvider([
    toolReply("c1", "search_tools", { query: "打开网页" }),
    toolReply("c2", "search_tools", { query: "打开网页" }),
    textReply("查完了"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const final = await agent.run("帮我发一封邮件并截个图确认");
  expect(final).toBe("查完了");
  const toolResults = provider.calls[2].messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(toolResults.length).toBe(2);
  expect(toolResults[1]).toContain("没有匹配到工具");
});

test("MCP 恰好 8 个时不延迟：全量发送（边界）", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10.slice(0, 8));
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
  expect(names.length).toBe(46 + 8); // 46 个基础工具 + 8 个 MCP 工具，无 search_tools。
  expect(names).not.toContain("search_tools");
});
