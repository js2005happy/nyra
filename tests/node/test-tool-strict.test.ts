// tests/node/test-tool-strict.test.ts — 十年清单第 4 项：严格模式结构化输出。
//
// 覆盖：支持表默认值与覆盖、schema 归一化形态、二次校验、Provider.chat
// 发送形态、agent 主循环校验失败重试一次与重试仍失败报错。
// 一律用假 provider / 假 transport，不调真模型、不花钱。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STRICT_TOOLS_BY_PROVIDER, resolveStrictTools, normalizeToolForStrict,
  applyStrictToTools, validateToolCallArgs, validateToolCalls,
  buildToolArgRepairMessage,
} from "../../src/toolStrict.ts";
import { validateJsonValue } from "../../src/outputSchema.ts";
import { Provider, type ResolvedProvider } from "../../src/providers.ts";
import { getProviderPresets } from "../../src/config.ts";
import { Agent } from "../../src/agent.ts";

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.NYRA_STRICT_TOOLS;
  try {
    if (value === undefined) delete process.env.NYRA_STRICT_TOOLS;
    else process.env.NYRA_STRICT_TOOLS = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.NYRA_STRICT_TOOLS;
    else process.env.NYRA_STRICT_TOOLS = prev;
  }
}

test("支持表：开 strict 的四家与不开的十一家", () => {
  expect(STRICT_TOOLS_BY_PROVIDER.openai).toBe(true);
  expect(STRICT_TOOLS_BY_PROVIDER.xai).toBe(true);
  expect(STRICT_TOOLS_BY_PROVIDER.qwen).toBe(true);
  expect(STRICT_TOOLS_BY_PROVIDER.together).toBe(true);
  for (const name of ["deepseek", "openlux", "openrouter", "ollama", "kimi", "glm", "gemini", "mistral", "groq", "codex", "custom"]) {
    expect(STRICT_TOOLS_BY_PROVIDER[name]).toBe(false);
  }
  expect(resolveStrictTools("no-such-provider")).toBe(false);
  withEnv(undefined, () => {
    expect(resolveStrictTools("openai")).toBe(true);
    expect(resolveStrictTools("deepseek")).toBe(false);
  });
});

test("环境变量：0 全关，名字强制开，no 名字强制关", () => {
  withEnv("0", () => {
    expect(resolveStrictTools("openai")).toBe(false);
    expect(resolveStrictTools("qwen")).toBe(false);
  });
  withEnv("openlux", () => {
    expect(resolveStrictTools("openlux")).toBe(true);
    expect(resolveStrictTools("deepseek")).toBe(false);
  });
  withEnv("no:qwen", () => {
    expect(resolveStrictTools("qwen")).toBe(false);
    expect(resolveStrictTools("openai")).toBe(true);
  });
  withEnv("openlux,no:qwen", () => {
    expect(resolveStrictTools("openlux")).toBe(true);
    expect(resolveStrictTools("qwen")).toBe(false);
  });
});

test("预置覆盖优先于支持表，但低于环境变量", () => {
  withEnv(undefined, () => {
    expect(resolveStrictTools("deepseek", true)).toBe(true);
    expect(resolveStrictTools("openai", false)).toBe(false);
  });
  withEnv("0", () => {
    expect(resolveStrictTools("deepseek", true)).toBe(false);
  });
  withEnv("openlux", () => {
    expect(resolveStrictTools("openlux", false)).toBe(true);
  });
});

test("自定义 provider 的 strict_tools 写进预置", () => {
  const presets = getProviderPresets({
    custom_providers: {
      myprov: { base_url: "https://api.example.invalid/v1", default_model: "m1", strict_tools: true },
      plain: { base_url: "https://api.example.invalid/v1", default_model: "m1" },
    },
  });
  expect(presets.myprov.strictTools).toBe(true);
  expect(presets.plain.strictTools).toBe(undefined);
  expect(presets.deepseek.strictTools).toBe(undefined);
});

function readFileTool(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "read_file",
      description: "读文件",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "路径" },
          offset: { type: "integer", description: "起始行" },
          mode: { type: "string", enum: ["text", "raw"], description: "模式", default: "text" },
        },
        required: ["path"],
      },
    },
  };
}

test("归一化：全部对象 additionalProperties false，全部属性进 required，可选属性可空", () => {
  const tool = readFileTool();
  const { tool: out, strict } = normalizeToolForStrict(tool);
  expect(strict).toBe(true);
  const fn = out.function as Record<string, unknown>;
  expect(fn.strict).toBe(true);
  const params = fn.parameters as Record<string, unknown>;
  expect(params.additionalProperties).toBe(false);
  expect(params.required).toEqual(["path", "offset", "mode"]);
  const props = params.properties as Record<string, Record<string, unknown>>;
  expect(props.path.type).toBe("string");
  expect(props.offset.type).toEqual(["integer", "null"]);
  expect(props.mode.type).toEqual(["string", "null"]);
  expect(props.mode.enum).toEqual(["text", "raw", null]);
  // default 是纯提示，归一化时剥掉；原对象不动。
  expect(props.mode.default).toBe(undefined);
  const origParams = (tool.function as Record<string, unknown>).parameters as Record<string, unknown>;
  expect(origParams.additionalProperties).toBe(undefined);
  expect(origParams.required).toEqual(["path"]);
  expect((tool.function as Record<string, unknown>).strict).toBe(undefined);
});

test("归一化：嵌套对象递归落地，数组 items 也归一化", () => {
  const tool = {
    type: "function",
    function: {
      name: "nested",
      description: "嵌套",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              tag: { type: "string" },
              level: { type: "integer" },
            },
            required: ["tag"],
          },
          tags: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
        },
        required: ["filter"],
      },
    },
  };
  const { tool: out, strict } = normalizeToolForStrict(tool);
  expect(strict).toBe(true);
  const params = (out.function as Record<string, unknown>).parameters as Record<string, unknown>;
  const props = params.properties as Record<string, Record<string, unknown>>;
  const filter = props.filter;
  expect(filter.additionalProperties).toBe(false);
  expect(filter.required).toEqual(["tag", "level"]);
  expect((filter.properties as Record<string, Record<string, unknown>>).level.type).toEqual(["integer", "null"]);
  const tags = props.tags;
  // tags 是可选属性，归一化后放宽为可空。
  expect(tags.type).toEqual(["array", "null"]);
  expect((tags.items as Record<string, unknown>).additionalProperties).toBe(false);
  expect((tags.items as Record<string, unknown>).required).toEqual(["name"]);
});

test("归一化：自由格式对象工具判不 strict，原样返回", () => {
  const tool = {
    type: "function",
    function: {
      name: "delegate",
      description: "委派",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
          output_schema: { type: "object", description: "自由格式契约" },
        },
        required: ["task"],
      },
    },
  };
  const { tool: out, strict, reason } = normalizeToolForStrict(tool);
  expect(strict).toBe(false);
  expect(reason).toContain("自由格式对象");
  expect((out.function as Record<string, unknown>).strict).toBe(undefined);
});

test("归一化：properties 为空是未说明、不是无参工具，判不 strict；已显式 additionalProperties false 的除外", () => {
  const emptyProps = {
    type: "function",
    function: {
      name: "placeholder",
      description: "占位",
      parameters: { type: "object", properties: {} },
    },
  };
  const r1 = normalizeToolForStrict(emptyProps);
  expect(r1.strict).toBe(false);
  expect(r1.reason).toContain("properties 为空");
  const explicitNoArgs = {
    type: "function",
    function: {
      name: "noargs",
      description: "无参",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
  const r2 = normalizeToolForStrict(explicitNoArgs);
  expect(r2.strict).toBe(true);
  expect(((r2.tool.function as Record<string, unknown>).parameters as Record<string, unknown>).required).toEqual([]);
  // 校验：空 properties 的 schema 不约束键，任意对象参数都放行。
  expect(validateToolCallArgs({ url: "https://example.com" }, { type: "object", properties: {} })).toEqual([]);
});

test("归一化：含 oneOf 的 schema 判不 strict", () => {
  const tool = {
    type: "function",
    function: {
      name: "weird",
      description: "含 oneOf",
      parameters: {
        type: "object",
        properties: { v: { oneOf: [{ type: "string" }, { type: "integer" }] } },
        required: ["v"],
      },
    },
  };
  const { strict, reason } = normalizeToolForStrict(tool);
  expect(strict).toBe(false);
  expect(reason).toContain("oneOf");
});

test("applyStrictToTools：strict 的 provider 转换，非 strict 的原样返回同一数组", () => {
  const tools = [readFileTool()];
  const converted = withEnvRet(undefined, () => applyStrictToTools("openai", undefined, tools));
  expect(converted).not.toBe(tools);
  expect(((converted as Record<string, unknown>[])[0].function as Record<string, unknown>).strict).toBe(true);
  const same = withEnvRet(undefined, () => applyStrictToTools("deepseek", undefined, tools));
  expect(same).toBe(tools);
  expect(applyStrictToTools("openai", undefined, null)).toBe(null);
  expect(applyStrictToTools("openai", undefined, undefined)).toBe(undefined);
});

function withEnvRet<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.NYRA_STRICT_TOOLS;
  try {
    if (value === undefined) delete process.env.NYRA_STRICT_TOOLS;
    else process.env.NYRA_STRICT_TOOLS = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NYRA_STRICT_TOOLS;
    else process.env.NYRA_STRICT_TOOLS = prev;
  }
}

test("校验：合法参数通过，缺必填、多余键、类型错、enum 错都报", () => {
  const params = (readFileTool().function as Record<string, unknown>).parameters as Record<string, unknown>;
  expect(validateToolCallArgs({ path: "a.txt" }, params)).toEqual([]);
  expect(validateToolCallArgs({ path: "a.txt", offset: 3 }, params)).toEqual([]);
  expect(validateToolCallArgs({ path: "a.txt", offset: null }, params)).toEqual([]);
  expect(validateToolCallArgs({ path: "a.txt", mode: null }, params)).toEqual([]);
  expect(validateToolCallArgs({}, params).join("")).toContain("缺少必填字段 path");
  expect(validateToolCallArgs({ path: "a.txt", bogus: 1 }, params).join("")).toContain("多余字段 bogus");
  expect(validateToolCallArgs({ path: 5 }, params).join("")).toContain("应为 string");
  expect(validateToolCallArgs({ path: null }, params).join("")).toContain("应为 string");
  expect(validateToolCallArgs({ path: "a.txt", mode: "xml" }, params).join("")).toContain("不在 enum 允许值里");
});

test("校验：自由格式工具按原 schema 验，多余键不拦（原 schema 没写 additionalProperties）", () => {
  const params = {
    type: "object",
    properties: {
      task: { type: "string" },
      output_schema: { type: "object" },
    },
    required: ["task"],
  };
  expect(validateToolCallArgs({ task: "x", output_schema: { a: 1 }, extra: 2 }, params)).toEqual([]);
  expect(validateToolCallArgs({}, params).join("")).toContain("缺少必填字段 task");
});

test("校验：联合类型可空（outputSchema 的数组 type 支持）", () => {
  expect(validateJsonValue(null, { type: ["string", "null"] })).toEqual([]);
  expect(validateJsonValue("x", { type: ["string", "null"] })).toEqual([]);
  expect(validateJsonValue(5, { type: ["string", "null"] }).length).toBe(1);
});

test("validateToolCalls：坏 JSON、非对象、未知工具名", () => {
  const schemas = [readFileTool()];
  const badJson = { id: "1", type: "function", function: { name: "read_file", arguments: "{not json" } };
  const notObject = { id: "2", type: "function", function: { name: "read_file", arguments: "[1,2]" } };
  const unknown = { id: "3", type: "function", function: { name: "no_such_tool", arguments: "{}" } };
  const good = { id: "4", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } };
  const out = validateToolCalls([badJson, notObject, unknown, good], schemas);
  expect(out.size).toBe(2);
  expect(out.get(badJson)?.join("")).toContain("不是合法的 JSON");
  expect(out.get(notObject)?.join("")).toContain("必须是 JSON 对象");
  expect(out.has(unknown)).toBe(false);
  expect(out.has(good)).toBe(false);
});

test("修复消息：列出工具名与错误，超长截断", () => {
  const tc = { id: "1", type: "function", function: { name: "read_file", arguments: "{}" } };
  const msg = buildToolArgRepairMessage(new Map([[tc, ["根 缺少必填字段 path", "根 有多余字段 x"]]]));
  expect(msg).toContain("read_file");
  expect(msg).toContain("缺少必填字段 path");
  expect(msg).toContain("重新发一次工具调用");
  const long = buildToolArgRepairMessage(new Map([[tc, ["x".repeat(2000)]]]));
  expect(long.length).toBeLessThanOrEqual(1000);
});

function providerCfg(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash",
    apiKey: "sk-test", auth: "env", connectorName: null, allowedHosts: [],
    keySource: "env", hasKey: true, envKey: "DEEPSEEK_API_KEY",
    preset: { baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-flash", envKey: "DEEPSEEK_API_KEY", connector: null, allowedHosts: [], models: ["deepseek-flash"] },
    ...overrides,
  } as ResolvedProvider;
}

async function captureChat(provider: Provider, tools: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const origFetch = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  (globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await provider.chat([{ role: "user", content: "hi" }], tools);
    return JSON.parse(String((calls[0].init as Record<string, unknown>).body)) as Record<string, unknown>;
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
}

test("Provider.chat：strict 的 provider 发 strict 工具且 schema 已归一化", async () => {
  const tool = readFileTool();
  const p = new Provider(providerCfg({
    name: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-test",
    preset: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-test", envKey: "OPENAI_API_KEY", connector: null, allowedHosts: [], models: ["gpt-test"] },
  }));
  expect(p.strictTools).toBe(true);
  const body = await withEnvRet(undefined, () => captureChat(p, [tool]));
  const sent = (body.tools as Record<string, unknown>[])[0];
  const fn = sent.function as Record<string, unknown>;
  expect(fn.strict).toBe(true);
  const params = fn.parameters as Record<string, unknown>;
  expect(params.additionalProperties).toBe(false);
  expect(params.required).toEqual(["path", "offset", "mode"]);
  // 入参原对象不动。
  expect((tool.function as Record<string, unknown>).strict).toBe(undefined);
});

test("Provider.chat：非 strict 的 provider 原样发送，不带 strict", async () => {
  const tool = readFileTool();
  const p = new Provider(providerCfg());
  expect(p.strictTools).toBe(false);
  const body = await withEnvRet(undefined, () => captureChat(p, [tool]));
  const sent = (body.tools as Record<string, unknown>[])[0];
  const fn = sent.function as Record<string, unknown>;
  expect(fn.strict).toBe(undefined);
  const params = fn.parameters as Record<string, unknown>;
  expect(params.additionalProperties).toBe(undefined);
  expect(params.required).toEqual(["path"]);
});

test("Provider.chat：环境变量 0 能把 strict 的 provider 也关掉", async () => {
  const p = new Provider(providerCfg({
    name: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-test",
    preset: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-test", envKey: "OPENAI_API_KEY", connector: null, allowedHosts: [], models: ["gpt-test"] },
  }));
  const body = await withEnvRet("0", () => captureChat(p, [readFileTool()]));
  const fn = ((body.tools as Record<string, unknown>[])[0].function as Record<string, unknown>);
  expect(fn.strict).toBe(undefined);
});

// ---- agent 主循环：二次校验＋一次重试 ----

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

function fakeMcpEcho() {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const tools = [{
    type: "function",
    function: {
      name: "mcp__test__echo",
      description: "回显",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  }];
  return {
    manager: {
      hasTools: () => tools.length > 0,
      toolSchemas: tools,
      execute: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, args });
        return `回显成功：${args.text}`;
      },
    },
    executed,
  };
}

function setupAgent() {
  const home = mkdtempSync(join(tmpdir(), "nyra-strict-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-strict-wd-"));
  return { home, workdir };
}

test("agent 循环：参数坏一次 → 恰好多调一次 chat → 好参数执行且只执行一次", async () => {
  const { home, workdir } = setupAgent();
  const { manager, executed } = fakeMcpEcho();
  const provider = new FakeProvider([
    toolReply("c1", "mcp__test__echo", { text: "hi", extra: 1 }),
    toolReply("c2", "mcp__test__echo", { text: "hi" }),
    textReply("搞定"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const final = await agent.run("回显 hi");
  expect(final).toBe("搞定");
  expect(provider.calls.length).toBe(3);
  // 第二次调用里带了修复消息，推的是坏的 assistant 消息 + 修复说明。
  const retryMsgs = provider.calls[1].messages;
  expect(retryMsgs.some((m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("校验失败"))).toBe(true);
  expect(retryMsgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(true);
  // 工具只执行了一次，用的是好参数；工具结果是执行成功。
  expect(executed.length).toBe(1);
  expect(executed[0].args).toEqual({ text: "hi" });
  const toolResults = provider.calls[2].messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(toolResults.some((c) => c.includes("回显成功"))).toBe(true);
});

test("agent 循环：重试仍失败 → 工具不执行，结果是 schema 错误文案", async () => {
  const { home, workdir } = setupAgent();
  const { manager, executed } = fakeMcpEcho();
  const provider = new FakeProvider([
    toolReply("c1", "mcp__test__echo", { text: "hi", extra: 1 }),
    toolReply("c2", "mcp__test__echo", { text: "hi", extra: 2 }),
    textReply("搞定"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const final = await agent.run("回显 hi");
  expect(final).toBe("搞定");
  // 恰好调两次 chat 拿工具调用（首轮 + 一次重试），第三次是收尾文本轮。
  expect(provider.calls.length).toBe(3);
  expect(executed.length).toBe(0);
  const toolResults = provider.calls[2].messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(toolResults.some((c) => c.includes("参数不符合 schema"))).toBe(true);
  expect(toolResults.some((c) => c.includes("多余字段"))).toBe(true);
});

test("agent 循环：参数一开始就合法 → 不多余重试，只调两次 chat", async () => {
  const { home, workdir } = setupAgent();
  const { manager, executed } = fakeMcpEcho();
  const provider = new FakeProvider([
    toolReply("c1", "mcp__test__echo", { text: "hi" }),
    textReply("搞定"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [], mcpManager: manager as never });
  const final = await agent.run("回显 hi");
  expect(final).toBe("搞定");
  expect(provider.calls.length).toBe(2);
  expect(executed.length).toBe(1);
  expect(provider.calls[1].messages.some((m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("校验失败"))).toBe(false);
});
