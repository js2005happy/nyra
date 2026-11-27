// tests/node/test-tool-search.test.ts — 工具检索选择器（延迟加载第一步）。
// 关键契约：无命中时**全量回退**，绝不让模型手里没有工具。
import { test, expect } from "bun:test";
import {
  tokenizeName, tokenizeQuery, selectTools, describeDeferred, explainSelection,
} from "../../src/toolSearch.ts";

function tool(name: string, desc = "") {
  return { type: "function", function: { name, description: desc, parameters: { type: "object" } } };
}

const TOOLS = [
  tool("read_file", "读取文件内容"),
  tool("write_file", "写入文件"),
  tool("shell", "执行 shell 命令"),
  tool("web_fetch", "抓取网页"),
  tool("computer_use", "控制浏览器与桌面软件点击"),
  tool("mcp__memory__search", "在记忆库里检索"),
  tool("poppy_identity", "身份校验"),
];

test("tokenizeName：snake/kebab/camel 都能拆", () => {
  expect(tokenizeName("read_file")).toContain("read");
  expect(tokenizeName("web-fetch")).toContain("fetch");
  expect(tokenizeName("computerUse")).toContain("computer");
  expect(tokenizeName("mcp__memory__search")).toContain("memory");
});

test("tokenizeQuery：英文词 + 中文 2-gram", () => {
  const t = tokenizeQuery("用 read_file 读一下配置");
  // 下划线保留为整串（read_file），名字侧同样保留整串 → 靠整串命中
  expect(t).toContain("read_file");
  expect(t.some((x) => x.length === 2 && /[\u4e00-\u9fff]/.test(x))).toBe(true);
});

test("清楚的任务：选中相关工具，丢掉无关的", () => {
  const s = selectTools(TOOLS, "用 read_file 看一下 src/app.ts 的实现", { topK: 3, always: ["shell"] });
  expect(s.kept).toContain("read_file");
  expect(s.kept).toContain("shell"); // always 无条件保留
  expect(s.dropped).toContain("computer_use");
});

test("always 列表被无条件保留（即使分数为 0）", () => {
  const s = selectTools(TOOLS, "完全无关的一句话", { topK: 1, always: ["shell", "read_file"] });
  expect(s.kept).toContain("shell");
  expect(s.kept).toContain("read_file");
});

test("无命中 → 全量回退（绝不让模型没工具用）", () => {
  const s = selectTools(TOOLS, "zzz", { topK: 2 });
  expect(s.kept.length).toBe(TOOLS.length);
  expect(s.dropped).toEqual([]);
  expect(explainSelection(s)).toContain("全量发送");
});

test("空任务同样全量回退", () => {
  expect(selectTools(TOOLS, "", { topK: 3 }).kept.length).toBe(TOOLS.length);
});

test("topK 生效，且落选的会给 suggestions", () => {
  const s = selectTools(TOOLS, "file fetch memory", { topK: 2, minScore: 1 });
  expect(s.kept.length).toBeLessThanOrEqual(2);
  expect(s.dropped.length).toBeGreaterThan(0);
  expect(s.suggestions.length).toBeGreaterThan(0);
});

test("名字命中权重高于描述命中", () => {
  const s = selectTools(TOOLS, "shell", { topK: 3 });
  const shellScore = s.scores.find((x) => x.name === "shell")?.score ?? 0;
  const otherScore = s.scores.find((x) => x.name === "poppy_identity")?.score ?? 0;
  expect(shellScore).toBeGreaterThan(otherScore);
});

test("describeDeferred：说清没发多少、怎么拿回来；全发了就返回空串", () => {
  const s = selectTools(TOOLS, "read_file", { topK: 2 });
  expect(describeDeferred(s, TOOLS.length)).toContain("search_tools");
  const full = selectTools(TOOLS, "zzz", { topK: 2 });
  expect(describeDeferred(full, TOOLS.length)).toBe("");
});

test("explainSelection：给出可解释的入选理由", () => {
  const s = selectTools(TOOLS, "用 read_file 读配置", { topK: 3 });
  const text = explainSelection(s);
  expect(text).toContain("read_file");
  expect(text).toMatch(/\d+/);
});

test("fallbackAll: false 时无命中返回空列表（只检索时用，不全量回退）", () => {
  const s = selectTools(TOOLS, "zzz", { topK: 2, fallbackAll: false });
  expect(s.kept).toEqual([]);
  expect(s.dropped.length).toBe(TOOLS.length);
});

test("fallbackAll: true 时无命中仍全量回退（与默认一致）", () => {
  const s = selectTools(TOOLS, "zzz", { topK: 2, fallbackAll: true });
  expect(s.kept.length).toBe(TOOLS.length);
  expect(s.dropped).toEqual([]);
});

test("fallbackAll: false 时有命中照常按 topK 选（不影响正常选择）", () => {
  const s = selectTools(TOOLS, "用 read_file 看一下 src/app.ts 的实现", { topK: 3, always: ["shell"], fallbackAll: false });
  expect(s.kept).toContain("read_file");
  expect(s.kept).toContain("shell");
  expect(s.kept.length).toBeLessThanOrEqual(3);
});

test("结果稳定：同样的输入两次排序一致（便于测试与排障）", () => {
  const a = selectTools(TOOLS, "file read", { topK: 3 });
  const b = selectTools(TOOLS, "file read", { topK: 3 });
  expect(a.kept).toEqual(b.kept);
});

// ---- 工具检索批：内置懒加载 + 依赖暂缓（Agent 层） ----

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { TOOL_SCHEMAS, TOOL_DEPENDENCIES } from "../../src/tools.ts";
import { CORE_BUILTIN_TOOLS, BUILTIN_LAZY_LOAD_THRESHOLD } from "../../src/toolSearch.ts";

class FakeProvider2 {
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

function textReply2(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}
function toolReply2(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}
function toolReplyMulti(calls: [string, string, Record<string, unknown>][]): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })),
      },
    }],
  };
}

function setup2() {
  const home = mkdtempSync(join(tmpdir(), "nyra-toolsearch-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-toolsearch-wd-"));
  return { home, workdir };
}

function schemaNames2(schemas: Record<string, unknown>[]): string[] {
  return schemas.map((s) => (s.function as Record<string, unknown>).name as string);
}

test("核心集：10 个，都是真实工具；上限 18（含核心集）", () => {
  expect(CORE_BUILTIN_TOOLS.length).toBe(10);
  expect(BUILTIN_LAZY_LOAD_THRESHOLD).toBe(18);
  const real = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));
  for (const n of CORE_BUILTIN_TOOLS) expect(real.has(n)).toBe(true);
});

test("描述补齐：每个内置工具的描述都有“何时用／何时不用／典型误用”三段", () => {
  for (const s of TOOL_SCHEMAS) {
    const fn = s.function as Record<string, unknown>;
    const desc = (fn.description as string) ?? "";
    expect(desc).toContain("何时用");
    expect(desc).toContain("何时不用");
    expect(desc).toContain("典型误用");
  }
});

test("合并重复：memory_delete 不再发给模型，只留 memory_forget；分派别名仍在（见 test-memory-search-delete）", () => {
  const names = TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string);
  expect(names).toContain("memory_forget");
  expect(names).not.toContain("memory_delete");
  expect(TOOL_SCHEMAS.length).toBe(53);
});

test("依赖元数据：键与值都是真实工具名，不自依赖", () => {
  const real = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));
  for (const [tool, deps] of Object.entries(TOOL_DEPENDENCIES)) {
    expect(real.has(tool)).toBe(true);
    for (const d of deps as string[]) {
      expect(real.has(d)).toBe(true);
      expect(d).not.toBe(tool);
    }
  }
  expect(TOOL_DEPENDENCIES["edit_file"]).toContain("read_file");
  expect(TOOL_DEPENDENCIES["group_session_send"]).toContain("group_session_create");
});

test("内置懒加载：任务非空时只发核心集 + 召回，其余进 deferred 并挂 search_tools", () => {
  const { home, workdir } = setup2();
  const agent = new Agent(new FakeProvider2([]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  const names = schemaNames2(agent.toolSchemas("控制浏览器截图"));
  // 核心集 10 个 + 召回 4 个（browser_navigate/browser_click/browser_screenshot/computer_screenshot）+ search_tools。
  expect(names.length).toBe(14 + 1);
  for (const core of CORE_BUILTIN_TOOLS) expect(names).toContain(core);
  expect(names).toContain("browser_screenshot");
  expect(names).toContain("search_tools");
  expect(names).not.toContain("apply_patch");
  const deferred = schemaNames2((agent as unknown as { deferredTools: Record<string, unknown>[] }).deferredTools);
  expect(deferred.length).toBe(53 - 14);
  expect(deferred).toContain("apply_patch");
});

test("内置懒加载：任务为空时全量发送（不猜）", () => {
  const { home, workdir } = setup2();
  const agent = new Agent(new FakeProvider2([]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  const names = schemaNames2(agent.toolSchemas(""));
  expect(names.length).toBe(53);
  expect(names).not.toContain("search_tools");
});

test("内置懒加载：NYRA_LAZY_TOOLS=0 全量发送（逃生口）", () => {
  const prev = process.env.NYRA_LAZY_TOOLS;
  process.env.NYRA_LAZY_TOOLS = "0";
  try {
    const { home, workdir } = setup2();
    const agent = new Agent(new FakeProvider2([]) as never, { workdir, home, mode: "full", skillsDirs: [] });
    const names = schemaNames2(agent.toolSchemas("控制浏览器截图"));
    expect(names.length).toBe(53);
    expect(names).not.toContain("search_tools");
  } finally {
    if (prev === undefined) delete process.env.NYRA_LAZY_TOOLS; else process.env.NYRA_LAZY_TOOLS = prev;
  }
});

test("内置懒加载：无命中时只剩核心集 + search_tools", () => {
  const { home, workdir } = setup2();
  const agent = new Agent(new FakeProvider2([]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  const names = schemaNames2(agent.toolSchemas("zzz"));
  expect(names.length).toBe(10 + 1);
  expect(names).toContain("search_tools");
  for (const core of CORE_BUILTIN_TOOLS) expect(names).toContain(core);
});

test("端到端：search_tools 拉回被延迟的内置工具，下一轮 schema 里出现并真执行", async () => {
  const { home, workdir } = setup2();
  const provider = new FakeProvider2([
    toolReply2("c1", "search_tools", { query: "RSS 订阅" }),
    toolReply2("c2", "feed_read", { action: "list" }),
    textReply2("搞定"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    approveFn: async () => true,
  });
  const final = await agent.run("帮我读一下 README");
  expect(final).toBe("搞定");
  const round1 = schemaNames2(provider.calls[0].schemas);
  expect(round1).toContain("search_tools");
  expect(round1).not.toContain("feed_read"); // 第一轮被延迟了
  const searchResult = provider.calls[1].messages.find((m) => m.role === "tool")?.content as string;
  expect(searchResult).toContain("feed_read");
  expect(schemaNames2(provider.calls[1].schemas)).toContain("feed_read");
  // 第二轮真执行了 feed_read：返回里有内置订阅源
  const feedResult = provider.calls[2].messages.filter((m) => m.role === "tool").map((m) => m.content as string).join("\n");
  expect(feedResult).toContain("GitHub Blog");
});

test("依赖暂缓：同轮里 read_file + edit_file，edit_file 本轮不执行、下一轮再调", async () => {
  const { home, workdir } = setup2();
  writeFileSync(join(workdir, "a.txt"), "line1\nline2\nline3\n");
  const provider = new FakeProvider2([
    toolReplyMulti([
      ["c1", "read_file", { path: "a.txt" }],
      ["c2", "edit_file", { path: "a.txt", old_text: "line2", new_text: "line2-patched" }],
    ]),
    toolReply2("c3", "edit_file", { path: "a.txt", old_text: "line2", new_text: "line2-patched" }),
    textReply2("搞定"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    approveFn: async () => true,
  });
  const final = await agent.run("把 a.txt 里的 line2 改成 line2-patched");
  expect(final).toBe("搞定");
  // 第一轮的两条工具结果在同一轮一次返回给模型（合并交付）：read_file 的
  // 真结果 + edit_file 的暂缓纸条，都在第二轮 chat 之前的消息里。
  const round2msgs = provider.calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(round2msgs.length).toBe(2);
  expect(round2msgs[0]).toContain("line2");
  expect(round2msgs[1]).toContain("已暂缓执行");
  expect(round2msgs[1]).toContain("read_file");
  // 第二轮 edit_file 真执行了：文件被改掉
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toContain("line2-patched");
});

test("依赖暂缓：同轮里 browser_navigate + browser_click，click 被暂缓（不执行）", async () => {
  const { home, workdir } = setup2();
  const provider = new FakeProvider2([
    toolReplyMulti([
      ["c1", "browser_navigate", { url: "https://example.com" }],
      ["c2", "browser_click", { selector: "#submit" }],
    ]),
    textReply2("查完了"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", skillsDirs: [],
    approveFn: async () => true,
  });
  const final = await agent.run("打开 example.com 点提交");
  expect(final).toBe("查完了");
  const results = provider.calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(results.length).toBe(2);
  expect(results[1]).toContain("已暂缓执行");
  expect(results[1]).toContain("browser_navigate");
  expect(results[1]).not.toContain("错误：");
});
