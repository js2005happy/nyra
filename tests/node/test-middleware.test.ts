// tests/node/test-middleware.test.ts — 类型化中间件链（G-P2-4）。
// 链组合、重试、缓存、校验、token 计数、配置、审批模式、Agent 接线、
// CLI 全程、checkApproval 纵深防御。全用临时 home 与假 provider /
// 注入 sleep/random/now，不调真模型、不花钱。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  buildMiddlewareSet,
  createApprovalModeMiddleware,
  createCacheMiddleware,
  createRetryMiddleware,
  createTokenCounterMiddleware,
  createTokenSummaryMiddleware,
  createValidationMiddleware,
  defaultIsRetryable,
  defaultMiddlewareConfig,
  functionCacheKey,
  FunctionResultCache,
  loadMiddlewareConfig,
  middlewareCachePath,
  MiddlewareError,
  normalizeMiddlewareConfig,
  resolveApprovalMode,
  retryDelayMs,
  runMiddlewareChain,
  saveMiddlewareConfig,
  TokenCounter,
  validateApprovalModes,
  validateToolArgs,
  type FunctionMiddlewareContext,
  type MiddlewareConfig,
  type MiddlewareFn,
  type ToolArgSchema,
} from "../../src/middleware.ts";
import { handleMiddleware } from "../../src/middlewareCli.ts";
import { checkApproval, newToolContext, READONLY_TOOLS, type ToolContext } from "../../src/tools.ts";
import { Agent } from "../../src/agent.ts";

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

function textReply(text: string, usage?: Record<string, number>): Record<string, unknown> {
  const reply: Record<string, unknown> = { choices: [{ message: { content: text, tool_calls: [] } }] };
  if (usage) reply.usage = usage;
  return reply;
}

function toolCallReply(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function captureOutput(): { out: string; err: string; restore: () => void } {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  return { get out() { return out; }, get err() { return err; }, restore: () => { (process.stdout as unknown as { write: unknown }).write = origOut; (process.stderr as unknown as { write: unknown }).write = origErr; } };
}

function fullCtx(workdir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return newToolContext({ workdir, mode: "full", interactive: false, ...extra });
}

type Events = { kind: string; data: Record<string, unknown> }[];
function eventCollector(): { events: Events; emit: (kind: string, data: Record<string, unknown>) => void } {
  const events: Events = [];
  return { events, emit: (kind, data) => { events.push({ kind, data }); } };
}

// ---- 链组合 ---------------------------------------------------------------

test("链：按注册顺序执行，terminal 最后", async () => {
  const order: string[] = [];
  const a: MiddlewareFn<string, string> = async (_c, next) => { order.push("a"); const r = await next(); order.push("a-after"); return r; };
  const b: MiddlewareFn<string, string> = async (_c, next) => { order.push("b"); return next(); };
  const r = await runMiddlewareChain([a, b], "x", async () => { order.push("terminal"); return "ok"; });
  expect(r).toBe("ok");
  expect(order).toEqual(["a", "b", "terminal", "a-after"]);
});

test("链：中间件不调 next 即短路，terminal 不执行", async () => {
  let terminalRan = false;
  const short: MiddlewareFn<string, string> = async () => "short";
  const r = await runMiddlewareChain([short], "x", async () => { terminalRan = true; return "ok"; });
  expect(r).toBe("short");
  expect(terminalRan).toBe(false);
});

test("链：terminal 与中间件的错误原样透传", async () => {
  await expect(runMiddlewareChain([], "x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  const bad: MiddlewareFn<string, string> = async () => { throw new Error("mid-boom"); };
  await expect(runMiddlewareChain([bad], "x", async () => "ok")).rejects.toThrow("mid-boom");
});

test("链：同一层 next() 并发重入抛错，顺序重试不拦", async () => {
  const twice: MiddlewareFn<string, string> = async (_c, next) => {
    await Promise.all([next(), next()]);
    return "x";
  };
  await expect(runMiddlewareChain([twice], "x", async () => "ok")).rejects.toThrow(MiddlewareError);
  // 顺序再调一次是合法的（重试中间件就靠这个）。
  const retryOnce: MiddlewareFn<string, string> = async (_c, next) => {
    try {
      return await next();
    } catch {
      return await next();
    }
  };
  let calls = 0;
  const r = await runMiddlewareChain([retryOnce], "x", async () => {
    calls += 1;
    if (calls === 1) throw new Error("first fails");
    return "second ok";
  });
  expect(r).toBe("second ok");
  expect(calls).toBe(2);
});

test("链：空链直接调 terminal", async () => {
  const r = await runMiddlewareChain([], "x", async () => "direct");
  expect(r).toBe("direct");
});

// ---- 重试 -----------------------------------------------------------------

test("重试：可重试错误重试到成功，退避按指数走、事件记轮次", async () => {
  const { events, emit } = eventCollector();
  const delays: number[] = [];
  let calls = 0;
  const retry = createRetryMiddleware<string, string>({
    layer: "function", tool: "web_fetch", maxRetries: 2, initialIntervalMs: 500, backoffFactor: 2, maxIntervalMs: 8000,
    sleep: async (ms) => { delays.push(ms); }, random: () => 0.5, emit,
  });
  const r = await runMiddlewareChain([retry], "x", async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("server"), { kind: "server" });
    return "ok";
  });
  expect(r).toBe("ok");
  expect(calls).toBe(3);
  expect(delays).toEqual([500, 1000]);
  expect(events).toHaveLength(2);
  expect(events[0]).toEqual({ kind: "middleware_retry", data: { layer: "function", tool: "web_fetch", attempt: 1, delay_ms: 500, kind: "server" } });
  expect(events[1].data.attempt).toBe(2);
});

test("重试：超上限后原错上抛，不再重试", async () => {
  let calls = 0;
  const retry = createRetryMiddleware<string, string>({
    layer: "function", maxRetries: 1, initialIntervalMs: 100, backoffFactor: 2, maxIntervalMs: 1000,
    sleep: async () => {}, random: () => 0.5,
  });
  await expect(runMiddlewareChain([retry], "x", async () => {
    calls += 1;
    throw Object.assign(new Error("timeout"), { kind: "timeout" });
  })).rejects.toThrow("timeout");
  expect(calls).toBe(2);
});

test("重试：退避抖动上下界与封顶", () => {
  const cfg = { initialIntervalMs: 500, backoffFactor: 2, maxIntervalMs: 8000 };
  expect(retryDelayMs(0, cfg, () => 0)).toBe(375);
  expect(retryDelayMs(0, cfg, () => 1)).toBe(625);
  expect(retryDelayMs(1, cfg, () => 0.5)).toBe(1000);
  expect(retryDelayMs(10, cfg, () => 0)).toBe(6000);
  expect(retryDelayMs(10, cfg, () => 1)).toBe(10000);
});

test("重试：不可重试与取消一律不重试", async () => {
  const cases: unknown[] = [
    new Error("plain"),
    Object.assign(new Error("no"), { retryable: false, kind: "server" }),
    Object.assign(new Error("auth"), { kind: "auth" }),
    Object.assign(new Error("cancelled"), { name: "CancelError" }),
  ];
  for (const err of cases) {
    let calls = 0;
    const retry = createRetryMiddleware<string, string>({
      layer: "function", maxRetries: 3, initialIntervalMs: 10, backoffFactor: 2, maxIntervalMs: 100,
      sleep: async () => {}, random: () => 0.5,
    });
    await expect(runMiddlewareChain([retry], "x", async () => { calls += 1; throw err; })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  expect(defaultIsRetryable(Object.assign(new Error("x"), { retryable: true }))).toBe(true);
  expect(defaultIsRetryable(Object.assign(new Error("x"), { kind: "rate_limit" }))).toBe(true);
  expect(defaultIsRetryable(null)).toBe(false);
});

// ---- 缓存 -----------------------------------------------------------------

test("缓存：命中不调 terminal，未命中存，下次命中；键与参数顺序无关", async () => {
  const cache = new FunctionResultCache({ ttlMs: 60000, maxEntries: 10, store: "memory" });
  const { events, emit } = eventCollector();
  const mw = createCacheMiddleware({ cache, cacheableTools: new Set(["read_file"]), emit });
  let calls = 0;
  const run = () => runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "read_file", args: { path: "a.txt" } }, async () => { calls += 1; return "content"; });
  expect(await run()).toBe("content");
  expect(calls).toBe(1);
  expect(await run()).toBe("content");
  expect(calls).toBe(1);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("middleware_cache_hit");
  expect(events[0].data.tool).toBe("read_file");
  expect(typeof events[0].data.args_hash).toBe("string");
  expect(functionCacheKey("t", { b: 1, a: 2 })).toBe(functionCacheKey("t", { a: 2, b: 1 }));
});

test("缓存：TTL 过期后重新执行", async () => {
  let now = 1000;
  const cache = new FunctionResultCache({ ttlMs: 1000, maxEntries: 10, store: "memory", now: () => now });
  const mw = createCacheMiddleware({ cache, cacheableTools: new Set(["read_file"]) });
  let calls = 0;
  const run = () => runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "read_file", args: { path: "a.txt" } }, async () => { calls += 1; return `v${calls}`; });
  expect(await run()).toBe("v1");
  now += 999;
  expect(await run()).toBe("v1");
  now += 2;
  expect(await run()).toBe("v2");
});

test("缓存：超量逐最旧的；变异工具、密钥参数、失败结果一律不缓存", async () => {
  const cache = new FunctionResultCache({ ttlMs: 60000, maxEntries: 2, store: "memory" });
  const mw = createCacheMiddleware({ cache, cacheableTools: new Set(["read_file", "grep_search"]) });
  const run = (tool: string, args: Record<string, unknown>, result: string) =>
    runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool, args }, async () => result);
  await run("read_file", { path: "a" }, "A");
  await run("read_file", { path: "b" }, "B");
  expect(cache.size()).toBe(2);
  await run("read_file", { path: "c" }, "C");
  expect(cache.size()).toBe(2);
  expect(cache.get("read_file", { path: "a" })).toBeNull();
  expect(cache.get("read_file", { path: "b" })).toBe("B");
  // 写工具不在白名单里，不缓存。
  let calls = 0;
  const runWrite = () => runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "write_file", args: { path: "a" } }, async () => { calls += 1; return "w"; });
  await runWrite();
  await runWrite();
  expect(calls).toBe(2);
  // 参数带密钥字样，不缓存。
  calls = 0;
  const runSecret = () => runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "read_file", args: { path: "a", api_key: "x" } }, async () => { calls += 1; return "s"; });
  await runSecret();
  await runSecret();
  expect(calls).toBe(2);
  // 失败结果不缓存。
  calls = 0;
  const runFail = () => runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "grep_search", args: { pattern: "x" } }, async () => { calls += 1; return "错误：没找到"; });
  await runFail();
  await runFail();
  expect(calls).toBe(2);
});

test("缓存：文件 store 往返、0600、损坏直接丢弃", () => {
  const home = tmpHome("nyra-mw-cache-");
  try {
    const cache = new FunctionResultCache({ ttlMs: 60000, maxEntries: 10, store: "file", home });
    cache.set("read_file", { path: "a.txt" }, "hello");
    expectPerms(middlewareCachePath(home), 0o600);
    const cache2 = new FunctionResultCache({ ttlMs: 60000, maxEntries: 10, store: "file", home });
    expect(cache2.get("read_file", { path: "a.txt" })).toBe("hello");
    expect(cache2.size()).toBe(1);
    cache2.clear();
    expect(cache2.size()).toBe(0);
    const cache3 = new FunctionResultCache({ ttlMs: 60000, maxEntries: 10, store: "file", home });
    expect(cache3.size()).toBe(0);
    writeFileSync(middlewareCachePath(home), "{ broken json", "utf-8");
    const cache4 = new FunctionResultCache({ ttlMs: 60000, maxEntries: 10, store: "file", home });
    expect(cache4.size()).toBe(0);
  } finally {
    cleanup(home);
  }
});

// ---- 校验 -----------------------------------------------------------------

const READ_SCHEMA: ToolArgSchema = {
  required: ["path"],
  properties: { path: { type: "string" }, count: { type: "number" } },
};

test("校验：缺必填与类型错短路回错误串、不进工具、只记字段名", async () => {
  const { events, emit } = eventCollector();
  const mw = createValidationMiddleware({ getSchema: (tool) => (tool === "read_file" ? READ_SCHEMA : null), emit });
  let calls = 0;
  const run = (args: Record<string, unknown>) =>
    runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "read_file", args }, async () => { calls += 1; return "ok"; });
  const bad = await run({ count: "3" });
  expect(bad).toContain("参数校验失败");
  expect(bad).toContain("path");
  expect(bad).toContain("count");
  expect(calls).toBe(0);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("middleware_validation_failed");
  expect(events[0].data).toEqual({ tool: "read_file", fields: "path,count" });
  expect(await run({ path: "a.txt", count: 2 })).toBe("ok");
  expect(calls).toBe(1);
  // 未知工具（无 schema）直接放行。
  const unknown = await runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool: "mcp_foo", args: {} }, async () => "mcp-ok");
  expect(unknown).toBe("mcp-ok");
});

test("校验：validateToolArgs 纯函数正反例", () => {
  expect(validateToolArgs("t", { path: "a" }, READ_SCHEMA)).toEqual({ ok: true });
  expect(validateToolArgs("t", {}, null)).toEqual({ ok: true });
  const r = validateToolArgs("t", { count: 1.5 }, { required: ["path"], properties: { count: { type: "integer" } } });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.fields).toEqual(["path", "count"]);
});

// ---- token 计数 -------------------------------------------------------------

test("token 计数：累计只认实报用量，缺了记 missing、三数全缺为 null", () => {
  const counter = new TokenCounter();
  expect(counter.recordChat({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    .toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  expect(counter.recordChat({})).toEqual({ prompt_tokens: null, completion_tokens: null, total_tokens: null });
  expect(counter.recordChat({ usage: { prompt_tokens: 3 } }))
    .toEqual({ prompt_tokens: 3, completion_tokens: null, total_tokens: null });
  expect(counter.snapshot()).toEqual({ prompt_tokens: 13, completion_tokens: 5, total_tokens: 15, calls: 3, missing_calls: 1 });
  const fresh = new TokenCounter();
  fresh.recordChat({});
  expect(fresh.snapshot()).toEqual({ prompt_tokens: null, completion_tokens: null, total_tokens: null, calls: 1, missing_calls: 1 });
});

test("token 计数：chat 中间件每轮发事件，agent 汇总只在 calls>0 时发", async () => {
  const counter = new TokenCounter();
  const { events, emit } = eventCollector();
  const chatMw = createTokenCounterMiddleware({ counter, emit });
  const summaryMw = createTokenSummaryMiddleware({ counter, emit });
  const chatResult = await runMiddlewareChain([chatMw], { model: "fake-1", turn: 1 }, async () => ({ usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
  expect(chatResult.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("middleware_tokens");
  expect(events[0].data).toEqual({ model: "fake-1", prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, missing_calls: 0 });
  const out = await runMiddlewareChain([summaryMw], { task: "t", resume: false }, async () => "done");
  expect(out).toBe("done");
  expect(events).toHaveLength(2);
  expect(events[1].kind).toBe("middleware_tokens_total");
  expect(events[1].data).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, missing_calls: 0, calls: 1 });
  // 一次调用都没跑过时汇总不发事件。
  const counter2 = new TokenCounter();
  const { events: events2, emit: emit2 } = eventCollector();
  await runMiddlewareChain([createTokenSummaryMiddleware({ counter: counter2, emit: emit2 })], { task: "t", resume: false }, async () => "done");
  expect(events2).toHaveLength(0);
});

// ---- 配置与审批模式 ---------------------------------------------------------

test("配置：往返、默认、损坏备份回默认值、符号链接拒绝、数值夹到范围内", () => {
  const home = tmpHome("nyra-mw-cfg-");
  try {
    const { config } = loadMiddlewareConfig(home);
    expect(config).toEqual(defaultMiddlewareConfig());
    const custom: MiddlewareConfig = defaultMiddlewareConfig();
    custom.retry.enabled = true;
    custom.retry.maxRetries = 3;
    custom.cache.store = "file";
    const { errors } = saveMiddlewareConfig(home, custom);
    expect(errors).toHaveLength(0);
    expectPerms(join(home, "middleware.json"), 0o600);
    const loaded = loadMiddlewareConfig(home);
    expect(loaded.config.retry.enabled).toBe(true);
    expect(loaded.config.retry.maxRetries).toBe(3);
    expect(loaded.config.cache.store).toBe("file");
    // 越界数值夹到范围内。
    const { config: clamped } = normalizeMiddlewareConfig({ version: 1, retry: { maxRetries: 99, initialIntervalMs: -5, backoffFactor: 99, maxIntervalMs: 1 }, cache: { ttlSeconds: 1, maxEntries: 0 } });
    expect(clamped.retry.maxRetries).toBe(4);
    expect(clamped.retry.initialIntervalMs).toBe(0);
    expect(clamped.retry.backoffFactor).toBe(4);
    expect(clamped.retry.maxIntervalMs).toBe(100);
    expect(clamped.cache.ttlSeconds).toBe(10);
    expect(clamped.cache.maxEntries).toBe(1);
    // 损坏先备份再回默认值。
    writeFileSync(join(home, "middleware.json"), "{ broken", "utf-8");
    const broken = loadMiddlewareConfig(home);
    expect(broken.config).toEqual(defaultMiddlewareConfig());
    expect(broken.errors.length).toBeGreaterThan(0);
    expect(readdirHasBak(home)).toBe(true);
    // 符号链接拒绝读，写直接抛错。
    const target = join(home, "real.json");
    writeFileSync(target, JSON.stringify(defaultMiddlewareConfig()), "utf-8");
    rmSync(join(home, "middleware.json"), { force: true });
    symlinkSync(target, join(home, "middleware.json"));
    const linked = loadMiddlewareConfig(home);
    expect(linked.config).toEqual(defaultMiddlewareConfig());
    expect(linked.errors.length).toBeGreaterThan(0);
    expect(() => saveMiddlewareConfig(home, defaultMiddlewareConfig())).toThrow(MiddlewareError);
  } finally {
    cleanup(home);
  }
});

function readdirHasBak(home: string): boolean {
  return readdirSync(home).some((f) => f.startsWith("middleware.json.bak-"));
}

test("审批模式：never_require 只对只读工具生效，写工具按 require", () => {
  const cfg = defaultMiddlewareConfig();
  cfg.approvalModes = { read_file: "never_require", write_file: "never_require" };
  expect(resolveApprovalMode(cfg, "read_file", READONLY_TOOLS)).toBe("never_require");
  expect(resolveApprovalMode(cfg, "write_file", READONLY_TOOLS)).toBe("require");
  expect(resolveApprovalMode(cfg, "grep_search", READONLY_TOOLS)).toBe("require");
  const { accepted, rejected } = validateApprovalModes({ read_file: "never_require", write_file: "never_require" }, READONLY_TOOLS);
  expect(accepted).toEqual(["read_file"]);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].tool).toBe("write_file");
});

test("审批模式中间件：非默认模式才发事件，默认不发", async () => {
  const { events, emit } = eventCollector();
  const mw = createApprovalModeMiddleware({ resolve: (tool) => (tool === "read_file" ? "never_require" : "require"), emit });
  const run = (tool: string) => runMiddlewareChain<FunctionMiddlewareContext, string>([mw], { tool, args: {} }, async () => "ok");
  expect(await run("read_file")).toBe("ok");
  expect(await run("grep_search")).toBe("ok");
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({ kind: "middleware_approval_mode", data: { tool: "read_file", mode: "never_require" } });
});

test("链装配：默认两件内置，开关关了整层跳过", () => {
  const home = tmpHome("nyra-mw-set-");
  try {
    const set = buildMiddlewareSet(home, {});
    expect(set.chat).toHaveLength(1);
    expect(set.function).toHaveLength(2);
    expect(set.agent).toHaveLength(1);
    const custom = defaultMiddlewareConfig();
    custom.layers.function = false;
    custom.retry.enabled = true;
    custom.cache.enabled = true;
    saveMiddlewareConfig(home, custom);
    const set2 = buildMiddlewareSet(home, {});
    expect(set2.function).toHaveLength(0);
    expect(set2.chat).toHaveLength(1);
    const custom2 = defaultMiddlewareConfig();
    custom2.retry.enabled = true;
    custom2.cache.enabled = true;
    saveMiddlewareConfig(home, custom2);
    const set3 = buildMiddlewareSet(home, {});
    expect(set3.function).toHaveLength(4);
    const nullHome = buildMiddlewareSet(null, {});
    expect(nullHome.config).toEqual(defaultMiddlewareConfig());
  } finally {
    cleanup(home);
  }
});

// ---- checkApproval 纵深防御 --------------------------------------------------

test("checkApproval 纵深防御：写工具配 never_require 直接抛错，只读工具不受影响", async () => {
  const workdir = tmpHome("nyra-mw-appr-");
  try {
    const ctx = fullCtx(workdir, { approvalMode: () => "never_require" });
    await expect(checkApproval(ctx, "write_file", "写文件")).rejects.toThrow("never_require");
    await checkApproval(ctx, "read_file", "读文件");
  } finally {
    cleanup(workdir);
  }
});

// ---- Agent 级接线 ------------------------------------------------------------

test("Agent 级：FakeProvider 一轮发 middleware_tokens 与汇总事件", async () => {
  const home = tmpHome("nyra-mw-agent-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-mw-agent-wd-"));
  try {
    const events: Events = [];
    const provider = new FakeProvider([textReply("你好呀", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })]);
    const agent = new Agent(provider as never, {
      home, workdir, mode: "full", skillsDirs: [],
      onEvent: (kind: string, data: Record<string, unknown>) => { events.push({ kind, data }); },
    });
    const final = await agent.run("你好");
    expect(final).toContain("你好呀");
    const tokenEvents = events.filter((e) => e.kind === "middleware_tokens");
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0].data.prompt_tokens).toBe(10);
    expect(tokenEvents[0].data.total_tokens).toBe(15);
    const totalEvents = events.filter((e) => e.kind === "middleware_tokens_total");
    expect(totalEvents).toHaveLength(1);
    expect(totalEvents[0].data.calls).toBe(1);
    expect(totalEvents[0].data.missing_calls).toBe(0);
  } finally {
    cleanup(home);
    cleanup(workdir);
  }
});

test("Agent 级：缓存命中跳过执行（文件删了仍能回旧结果），校验失败回错误串", async () => {
  const home = tmpHome("nyra-mw-agent2-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-mw-agent2-wd-"));
  try {
    writeFileSync(join(workdir, "note.txt"), "hello\n", "utf-8");
    const cfg = defaultMiddlewareConfig();
    cfg.cache.enabled = true;
    saveMiddlewareConfig(home, cfg);
    const events: Events = [];
    const agent = new Agent(new FakeProvider([
      toolCallReply("read_file", { path: "note.txt" }),
      textReply("done"),
      toolCallReply("read_file", { path: "note.txt" }),
      textReply("done"),
    ]) as never, {
      home, workdir, mode: "full", skillsDirs: [],
      onEvent: (kind: string, data: Record<string, unknown>) => { events.push({ kind, data }); },
    });
    const first = await agent.run("读 note.txt");
    expect(first).toContain("done");
    expect(events.filter((e) => e.kind === "middleware_cache_hit")).toHaveLength(0);
    rmSync(join(workdir, "note.txt"), { force: true });
    const second = await agent.run("再读 note.txt");
    expect(second).toContain("done");
    expect(events.filter((e) => e.kind === "middleware_cache_hit")).toHaveLength(1);
    // 校验失败：缺必填 path，模型拿到错误串。
    const events2: Events = [];
    const agent2 = new Agent(new FakeProvider([
      toolCallReply("read_file", {}),
      textReply("done"),
    ]) as never, {
      home, workdir, mode: "full", skillsDirs: [],
      onEvent: (kind: string, data: Record<string, unknown>) => { events2.push({ kind, data }); },
    });
    await agent2.run("读文件但不给路径");
    expect(events2.filter((e) => e.kind === "middleware_validation_failed")).toHaveLength(1);
  } finally {
    cleanup(home);
    cleanup(workdir);
  }
});

// ---- CLI 全程 -----------------------------------------------------------------

test("CLI 全程：status / enable / set / approval / cache-clear", async () => {
  const home = tmpHome("nyra-mw-cli-");
  const cap = captureOutput();
  try {
    expect(await handleMiddleware(["status"], home)).toBe(0);
    expect(cap.out).toContain("校验：开");
    expect(cap.out).toContain("重试：关");
    expect(await handleMiddleware(["status", "--json"], home)).toBe(0);
    const parsed = JSON.parse(cap.out.slice(cap.out.indexOf("{"))) as Record<string, unknown>;
    expect((parsed.layers as Record<string, unknown>).chat).toBe(true);
    expect(await handleMiddleware(["enable", "retry"], home)).toBe(2);
    expect(await handleMiddleware(["enable", "retry", "--yes"], home)).toBe(0);
    expect(loadMiddlewareConfig(home).config.retry.enabled).toBe(true);
    expect(await handleMiddleware(["set", "--retry-max-retries", "1", "--yes"], home)).toBe(0);
    expect(loadMiddlewareConfig(home).config.retry.maxRetries).toBe(1);
    expect(await handleMiddleware(["set", "--retry-max-retries", "99", "--yes"], home)).toBe(0);
    expect(loadMiddlewareConfig(home).config.retry.maxRetries).toBe(4);
    expect(await handleMiddleware(["set", "--cache-store", "disk", "--yes"], home)).toBe(2);
    expect(await handleMiddleware(["approval"], home)).toBe(0);
    expect(await handleMiddleware(["approval", "read_file", "--mode", "never_require", "--yes"], home)).toBe(0);
    expect(loadMiddlewareConfig(home).config.approvalModes.read_file).toBe("never_require");
    expect(await handleMiddleware(["approval", "write_file", "--mode", "never_require", "--yes"], home)).toBe(2);
    expect(loadMiddlewareConfig(home).config.approvalModes.write_file).toBeUndefined();
    expect(await handleMiddleware(["approval", "read_file", "--mode", "require", "--yes"], home)).toBe(0);
    expect(loadMiddlewareConfig(home).config.approvalModes.read_file).toBeUndefined();
    expect(await handleMiddleware(["cache-clear", "--yes"], home)).toBe(0);
    expect(await handleMiddleware(["enable", "bogus", "--yes"], home)).toBe(2);
    expect(await handleMiddleware(["bogus"], home)).toBe(2);
  } finally {
    cap.restore();
    cleanup(home);
  }
});
