// tests/node/test-lazy-tools.test.ts — MCP 延迟加载第二步（search_tools 元工具）+
// 工具检索批：内置工具懒加载（核心集 10 个 + 召回最多 8 个）同一套机制。
//
// 契约：
//   - MCP 工具 ≤ 8 个时 MCP 全量发送；内置工具任务非空时总懒加载
//     （53 个远超上限 18 个），只发核心集 + 召回，search_tools 照常挂
//   - MCP 工具 > 8 个时按任务文本挑最相关的前 8 个，其余进 deferredTools，
//     search_tools 挂进 schemas，describeDeferred 说明拼进 system prompt
//   - NYRA_LAZY_TOOLS=0 关闭延迟加载（逃生口，内置 + MCP 都全量）
//   - search_tools 只读、无副作用、不走审批；命中工具的完整定义以 JSON 返回，
//     并追加进本轮 schemas（后续轮次直接发给模型），同时从 deferredTools 移除
//   - 检索无命中返回空列表（不全量回退）；首轮选择无命中时 MCP 全量回退、
//     内置只剩核心集（核心集就是安全底线，绝不让模型没工具用）
//   - 任务为空时全量发送（调用方没给任务时不猜）
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

test("MCP ≤ 8 个时 MCP 全量，但内置工具仍懒加载（核心集 + 召回 + search_tools）", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10.slice(0, 3));
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
  // 14 个内置（核心集 10 个 + 召回 4 个：browser_navigate/browser_click/
  // browser_screenshot/computer_screenshot）+ 3 个 MCP + search_tools。
  expect(names.length).toBe(14 + 3 + 1);
  expect(names).toContain("search_tools");
  expect(names).toContain("mcp__browser__screenshot");
  expect(names).not.toContain("apply_patch"); // 内置非核心、未召回，进 deferred
  const deferred = schemaNames((agent as unknown as { deferredTools: Record<string, unknown>[] }).deferredTools);
  expect(deferred.length).toBe(53 - 14);
  expect(deferred).toContain("apply_patch");
});

test("MCP > 8 个时只发最相关的前 8 个 MCP，内置只发核心集 + 召回，其余进 deferredTools 并挂 search_tools", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
  expect(names).toContain("mcp__browser__screenshot");
  expect(names).toContain("mcp__browser__navigate");
  expect(names).toContain("search_tools");
  expect(names).not.toContain("mcp__memory__search");
  expect(names).not.toContain("mcp__mail__send");
  expect(names.length).toBe(14 + 2 + 1); // 14 个内置 + 2 个相关 MCP 工具 + search_tools。
  const deferred = schemaNames((agent as unknown as { deferredTools: Record<string, unknown>[] }).deferredTools);
  expect(deferred.length).toBe((53 - 14) + 8); // 39 个内置 + 8 个 MCP。
  expect(deferred).toContain("mcp__memory__search");
  expect(deferred).toContain("apply_patch");
  expect(deferred).not.toContain("mcp__browser__screenshot");
});

test("NYRA_LAZY_TOOLS=0 关闭延迟加载（逃生口，内置 + MCP 都全量）", () => {
  const prev = process.env.NYRA_LAZY_TOOLS;
  process.env.NYRA_LAZY_TOOLS = "0";
  try {
    const { home, workdir } = setup();
    const { manager } = fakeMcp(MCP_TOOLS_10);
    const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
    const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
    expect(names.length).toBe(53 + 10); // 53 个基础工具 + 10 个 MCP 工具，无 search_tools。
    expect(names).not.toContain("search_tools");
  } finally {
    if (prev === undefined) delete process.env.NYRA_LAZY_TOOLS; else process.env.NYRA_LAZY_TOOLS = prev;
  }
});

test("首轮选择无命中时：MCP 全量回退，内置只剩核心集 + search_tools（绝不让模型没工具用）", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("zzz"));
  // 核心集 10 个 + MCP 全量 10 个 + search_tools（内置 43 个未召回，进 deferred）。
  expect(names.length).toBe(10 + 10 + 1);
  expect(names).toContain("search_tools");
  expect(names).toContain("read_file"); // 核心集在场
  expect(names).toContain("mcp__browser__screenshot"); // MCP 无命中全量回退
  const deferred = schemaNames((agent as unknown as { deferredTools: Record<string, unknown>[] }).deferredTools);
  expect(deferred.length).toBe(53 - 10);
  expect(deferred).toContain("apply_patch");
  expect(deferred).not.toContain("read_file");
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

test("拉回后工具从 deferredTools 移除：二次检索同一工具无命中", async () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10);
  const provider = new FakeProvider([
    toolReply("c1", "search_tools", { query: "打开网页" }),
    // 第二次按 MCP 工具全名检索：它已被第一轮拉回，deferred 里没有了；
    // 内置 browser_navigate 的名字与描述都不含 "mcp__browser__navigate"，
    // 所以也不会命中——如实返回没有匹配到。
    toolReply("c2", "search_tools", { query: "mcp__browser__navigate" }),
    textReply("查完了"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const final = await agent.run("帮我发一封邮件并截个图确认");
  expect(final).toBe("查完了");
  const toolResults = provider.calls[2].messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(toolResults.length).toBe(2);
  expect(toolResults[0]).toContain("mcp__browser__navigate");
  expect(toolResults[1]).toContain("没有匹配到工具");
});

test("MCP 恰好 8 个时 MCP 不延迟（全量发送），内置仍只发核心集 + 召回（边界）", () => {
  const { home, workdir } = setup();
  const { manager } = fakeMcp(MCP_TOOLS_10.slice(0, 8));
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const names = schemaNames(agent.toolSchemas("控制浏览器截图"));
  expect(names.length).toBe(14 + 8 + 1); // 14 个内置 + 8 个 MCP 工具 + search_tools（内置有延迟）。
  expect(names).toContain("search_tools");
});
