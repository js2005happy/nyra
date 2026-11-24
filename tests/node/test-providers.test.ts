// tests/node/test-providers.test.ts — 对应 tests/test_generic_providers.py /
// test_cli_providers.py / test_fallback.py / test_plaintext_http.py 的核心行为
// （Node 版已实现部分；连接器注入与 webui 相关行为见桥契约）。
import { test, expect } from "bun:test";
import {
  ProviderError, isRecoverableProviderError, kindForStatus, httpError,
  normalizeMessages, Provider, describeProvider, resolveChatTimeout, DEFAULT_CHAT_TIMEOUT,
  CODEX_PROMPT_PREFIX, CODEX_MIN_VERSION, CODEX_DEFAULT_MODEL, CODEX_FORBIDDEN_ARGS,
  findCodexBinary, resetCodexCache, parseCodexVersion, serializeCodexPrompt, classifyCodexError,
  eventMessageText, lastMessageFromJsonl, usageFromJsonl, codexChildEnv,
  buildCodexArgv, FallbackProvider, KeyRotatingProvider, buildProviderChain,
  type ProviderLike, type ResolvedProvider,
} from "../../src/providers.ts";

function cfg(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash",
    apiKey: "sk-test", auth: "env", connectorName: null, allowedHosts: [],
    keySource: "env", hasKey: true, envKey: "sk-test",
    preset: { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-flash", envKey: "DEEPSEEK_API_KEY" },
    ...overrides,
  } as ResolvedProvider;
}

function fakeProvider(name: string, chat: (msgs: unknown[]) => Promise<Record<string, unknown>>): ProviderLike {
  return {
    name, model: "m-" + name, baseUrl: "https://example.invalid",
    hasCredentials: () => true,
    chat: chat as ProviderLike["chat"],
    listModels: async () => [],
    redact: (t: string) => t,
  };
}

test("ProvidersTest.test_error_kinds_by_status", () => {
  expect(kindForStatus(400)).toBe("client");
  expect(kindForStatus(401)).toBe("auth");
  expect(kindForStatus(402)).toBe("quota");
  expect(kindForStatus(403)).toBe("auth");
  expect(kindForStatus(404)).toBe("client");
  expect(kindForStatus(429)).toBe("rate_limit");
  expect(kindForStatus(500)).toBe("server");
  expect(kindForStatus(503)).toBe("server");
});

test("ProvidersTest.test_auth_is_not_recoverable", () => {
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "auth" }))).toBe(false);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "quota" }))).toBe(true);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "rate_limit" }))).toBe(true);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "server" }))).toBe(true);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "timeout" }))).toBe(true);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "network" }))).toBe(true);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "client" }))).toBe(false);
  expect(isRecoverableProviderError(new ProviderError("x", { kind: "config" }))).toBe(false);
  expect(isRecoverableProviderError(new Error("plain"))).toBe(false);
  expect(new ProviderError("x", { kind: "quota" }).recoverable).toBe(true);
});

test("ProvidersTest.test_http_error_kinds", () => {
  expect(httpError(429, "slow down").kind).toBe("rate_limit");
  expect(httpError(429, "slow down").status).toBe(429);
  expect(httpError(401, "bad key").kind).toBe("auth");
  expect(httpError(402, "no balance").kind).toBe("quota");
  expect(httpError(500, "boom").kind).toBe("server");
  expect(httpError(400, "bad").kind).toBe("client");
});

test("ProvidersTest.test_normalize_messages_keeps_tool_calls", () => {
  const msgs = normalizeMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: "data" },
  ]);
  expect(msgs.length).toBe(3);
  expect((msgs[1].tool_calls as unknown[]).length).toBe(1);
  expect(normalizeMessages([{ role: "user", content: ["not", "a", "part"] } as never])[0].content).toEqual([]);
});

test("ProvidersTest.test_provider_without_key_has_no_credentials", () => {
  const p = new Provider(cfg({ apiKey: null, hasKey: false }));
  expect(p.hasCredentials()).toBe(false);
});

test("ProvidersTest.test_cli_provider_cannot_be_constructed_directly", () => {
  expect(() => new Provider(cfg({ name: "codex", auth: "cli", model: "codex-default" }))).toThrow(ProviderError);
});

test("ProvidersTest.test_provider_chat_uses_recorded_response", async () => {
  const origFetch = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  (globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const p = new Provider(cfg());
    const out = await p.chat([{ role: "user", content: "hi" }]);
    expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(String((calls[0].init as Record<string, unknown>).body));
    expect(body.model).toBe("deepseek-flash");
    expect(body.messages[0].content).toBe("hi");
    expect(describeProvider(p)).toContain("deepseek");
    expect(describeProvider(p)).toContain("deepseek-flash");
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
});

test("ProvidersTest.test_provider_http_error_surfaces_kind", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 429 });
  try {
    const p = new Provider(cfg());
    let caught: unknown = null;
    try { await p.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderError);
    // Kooyu 429 接力：`insufficient_quota` 现在认作 quota（用量耗尽、终结），
    // 不再是笼统的 rate_limit——重试同一家没有意义，应直接换下一家。
    // 以前是 rate_limit，只因为配额表里只有带空格的 "insufficient quota"，
    // 下划线变体没被认出来。
    expect((caught as ProviderError).kind).toBe("quota");
    expect((caught as ProviderError).status).toBe(429);
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
});

test("ProvidersTest.test_provider_timeout_aborts", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async (_url: unknown, init?: Record<string, unknown>) => {
    const signal = (init as Record<string, unknown>).signal as AbortSignal;
    await new Promise<void>((resolvePromise) => {
      if (signal.aborted) return resolvePromise();
      signal.addEventListener("abort", () => resolvePromise());
    });
    throw new DOMException("aborted", "AbortError");
  };
  try {
    const p = new Provider(cfg());
    let caught: unknown = null;
    try { await p.chat([{ role: "user", content: "hi" }], undefined, 1); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("timeout");
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
});

test("ProvidersTest.test_provider_list_models", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }), { status: 200 });
  try {
    const p = new Provider(cfg());
    expect(await p.listModels()).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
});

test("ProvidersTest.test_provider_redact_hides_key", () => {
  const p = new Provider(cfg());
  expect(p.redact("key is sk-test here")).not.toContain("sk-test");
  expect(p.redact("nothing secret")).toBe("nothing secret");
});

test("ProvidersTest.test_codex_prefix_and_version", () => {
  expect(CODEX_PROMPT_PREFIX).toContain("Nyra");
  expect(CODEX_PROMPT_PREFIX).toContain("text-only");
  expect(CODEX_MIN_VERSION).toEqual([0, 164, 0]);
  expect(CODEX_DEFAULT_MODEL).toBe("codex-default");
  expect(CODEX_FORBIDDEN_ARGS.has("--dangerously-bypass-approvals-and-sandbox")).toBe(true);
  expect(CODEX_FORBIDDEN_ARGS.has("-y")).toBe(true);
  expect(CODEX_FORBIDDEN_ARGS.has("--full-auto")).toBe(true);
  expect(CODEX_FORBIDDEN_ARGS.has("--yolo")).toBe(false);
  expect(parseCodexVersion("codex-cli 0.165.0")).toEqual([0, 165, 0]);
  expect(parseCodexVersion("codex 0.100.0")).toEqual([0, 100, 0]);
  expect(parseCodexVersion("no version here")).toBeNull();
});

// 运行器上是否有 Codex：有则跑真实查找断言，无则跳过——GitHub 运行器
// 不装 Codex CLI，直接断言必失败（36f08e6 的 Node binaries #28 真失败）。
// 探针只调 findCodexBinary（不调 codexAvailable，后者还会跑 --version 与
// login status，又慢又依赖登录态）。
const codexOnMachine = ((): boolean => {
  try {
    resetCodexCache();
    return findCodexBinary().endsWith("codex");
  } catch {
    return false;
  } finally {
    resetCodexCache();
  }
})();

test.skipIf(!codexOnMachine)("ProvidersTest.test_codex_binary_search", () => {
  resetCodexCache();
  // 本机装有 Codex（/opt/hatch-image/bin/codex，0.164.0-alpha.9）。
  const found = findCodexBinary();
  expect(found.endsWith("codex")).toBe(true);
  resetCodexCache();
  // 不存在的 override 不再走 PATH 兜底（第四份审计 P0）：显式路径
  // 不存在就报错，哪怕 PATH 里有 codex 也不去找。
  expect(() => findCodexBinary("/definitely/not/here/codex")).toThrow(ProviderError);
  resetCodexCache();
});

test("ProvidersTest.test_codex_binary_search_throws_when_absent", () => {
  // PATH 里也没有 codex 时才抛错；与机器上有无 Codex 无关，任何环境都可跑。
  resetCodexCache();
  const savedPath = process.env.PATH;
  process.env.PATH = "/tmp/no-codex-here";
  try {
    expect(() => findCodexBinary("/definitely/not/here/codex")).toThrow(ProviderError);
  } finally {
    process.env.PATH = savedPath;
    resetCodexCache();
  }
});

test("ProvidersTest.test_serialize_codex_prompt", () => {
  const out = serializeCodexPrompt([
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
  ]);
  expect(out).toContain(CODEX_PROMPT_PREFIX);
  expect(out).toContain("[user]");
  expect(out).toContain("do it");
});

test("ProvidersTest.test_classify_codex_error", () => {
  expect(classifyCodexError("authentication failed")).toBe("auth");
  expect(classifyCodexError("rate limit exceeded")).toBe("rate_limit");
  expect(classifyCodexError("quota exceeded")).toBe("quota");
  expect(classifyCodexError("connection refused")).toBe("network");
  expect(classifyCodexError("timed out")).toBe("timeout");
  expect(classifyCodexError("model_not_found")).toBe("config");
  expect(classifyCodexError("something totally new")).toBe("unknown");
});

test("ProvidersTest.test_codex_jsonl_helpers", () => {
  const jsonl = [
    JSON.stringify({ type: "agent_message", message: "first" }),
    JSON.stringify({ type: "agent_message", message: "second" }),
    JSON.stringify({ type: "usage", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
  ].join("\n");
  expect(lastMessageFromJsonl(jsonl)).toBe("second");
  expect(usageFromJsonl(jsonl)).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  expect(lastMessageFromJsonl("")).toBeNull();
  expect(usageFromJsonl("")).toBeNull();
  expect(eventMessageText({ type: "agent_message", message: "hi" })).toBe("hi");
  expect(eventMessageText({ type: "other" })).toBeNull();
});

test("ProvidersTest.test_codex_child_env_strips_api_keys", () => {
  const env = codexChildEnv();
  for (const key of Object.keys(env)) {
    expect(key.endsWith("_API_KEY")).toBe(false);
  }
});

test("ProvidersTest.test_build_codex_argv_fixed_shape", () => {
  const argv = buildCodexArgv("codex", "codex-default", "/tmp/out.jsonl", "/tmp/wd");
  expect(argv[0]).toBe("codex");
  expect(argv).toContain("exec");
  expect(argv).toContain("--json");
  expect(argv).toContain("--ephemeral");
  expect(argv).toContain("--skip-git-repo-check");
  expect(argv).not.toContain("-m");
  const withModel = buildCodexArgv("codex", "gpt-5", "/tmp/out.jsonl", "/tmp/wd");
  expect(withModel).toContain("-m");
  expect(withModel).toContain("gpt-5");
  expect(() => buildCodexArgv("codex", "-y", "/tmp/out.jsonl", "/tmp/wd")).toThrow(ProviderError);
});

test("ProvidersTest.test_fallback_switches_only_on_recoverable", async () => {
  const primary = fakeProvider("p1", async () => { throw new ProviderError("quota exceeded", { kind: "quota" }); });
  const secondary = fakeProvider("p2", async () => ({ choices: [{ message: { content: "from-p2", tool_calls: [] } }] }));
  const fb = new FallbackProvider([primary, secondary]);
  const out = await fb.chat([{ role: "user", content: "hi" }]);
  expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
  expect(fb.switches.length).toBe(1);
  expect(fb.switches[0].from).toBe("p1");
  expect(fb.switches[0].to).toBe("p2");
  expect(fb.switches[0].kind).toBe("quota");
});

test("ProvidersTest.test_fallback_does_not_switch_on_auth_error", async () => {
  const primary = fakeProvider("p1", async () => { throw new ProviderError("bad key", { kind: "auth" }); });
  const secondary = fakeProvider("p2", async () => ({ choices: [{ message: { content: "from-p2", tool_calls: [] } }] }));
  const fb = new FallbackProvider([primary, secondary]);
  let caught: unknown = null;
  try { await fb.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
  expect((caught as ProviderError).kind).toBe("auth");
  expect(fb.switches.length).toBe(0);
});

test("ProvidersTest.test_fallback_all_fail_reports_all", async () => {
  const p1 = fakeProvider("p1", async () => { throw new ProviderError("boom1", { kind: "server" }); });
  const p2 = fakeProvider("p2", async () => { throw new ProviderError("boom2", { kind: "server" }); });
  const fb = new FallbackProvider([p1, p2], null, { retryDelaysMs: [0, 0] }); // 0.5.1：FallbackProvider 同一 provider 先重试（退避 1s/3s），本用例只验切换上报，退避注 0 免得超时
  let caught: unknown = null;
  try { await fb.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
  expect(String((caught as Error).message)).toContain("boom1");
  expect(String((caught as Error).message)).toContain("boom2");
});

test("ProvidersTest.test_key_rotation_on_401_and_never_leaks_key", async () => {
  const keys = ["sk-key-one", "sk-key-two", "sk-key-three"];
  const providers = keys.map((key) => {
    const p = fakeProvider("rot-" + key, async () => { throw new ProviderError(`401 Unauthorized for ${key}`, { kind: "auth" }); });
    p.redact = (t: string) => t.split(key).join("[已隐藏]");
    return p;
  });
  const rot = new KeyRotatingProvider(providers);
  let caught: unknown = null;
  try { await rot.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
  expect(rot.switches.length).toBe(2);
  for (const key of keys) {
    expect(String((caught as Error).message)).not.toContain(key);
  }
  expect(String((caught as Error).message)).toContain("[已隐藏]");
});

test("ProvidersTest.test_key_rotation_success_on_second_key", async () => {
  const bad = fakeProvider("rot", async () => { throw new ProviderError("401", { kind: "auth" }); });
  const good = fakeProvider("rot", async () => ({ choices: [{ message: { content: "ok", tool_calls: [] } }] }));
  const rot = new KeyRotatingProvider([bad, good]);
  const out = await rot.chat([{ role: "user", content: "hi" }]);
  expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
  expect(rot.switches.length).toBe(1);
});

test("ProvidersTest.test_key_rotation_same_key_retry_on_transient_then_success", async () => {
  let calls = 0;
  const flaky = fakeProvider("rot", async () => {
    calls += 1;
    if (calls <= 2) throw new ProviderError("server boom", { kind: "server" });
    return { choices: [{ message: { content: "ok", tool_calls: [] } }] };
  });
  const rot = new KeyRotatingProvider([flaky], null, { retryDelaysMs: [0, 0] });
  const out = await rot.chat([{ role: "user", content: "hi" }]);
  expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
  expect(calls).toBe(3);
  expect(rot.switches.length).toBe(0);
  expect(rot.retries.length).toBe(2);
  expect(rot.retries[0].provider).toContain("key 1");
});

test("ProvidersTest.test_key_rotation_auth_does_not_retry_same_key", async () => {
  let calls1 = 0;
  const bad = fakeProvider("rot", async () => {
    calls1 += 1;
    throw new ProviderError("401 Unauthorized", { kind: "auth" });
  });
  const good = fakeProvider("rot", async () => ({ choices: [{ message: { content: "ok", tool_calls: [] } }] }));
  const rot = new KeyRotatingProvider([bad, good], null, { retryDelaysMs: [0, 0] });
  const out = await rot.chat([{ role: "user", content: "hi" }]);
  expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
  expect(calls1).toBe(1);
  expect(rot.switches.length).toBe(1);
  expect(rot.retries.length).toBe(0);
});

test("ProvidersTest.test_key_rotation_quota_does_not_retry_same_key", async () => {
  let calls1 = 0;
  const bad = fakeProvider("rot", async () => {
    calls1 += 1;
    throw new ProviderError("API quota exceeded for this key", { kind: "quota" });
  });
  const good = fakeProvider("rot", async () => ({ choices: [{ message: { content: "ok", tool_calls: [] } }] }));
  const rot = new KeyRotatingProvider([bad, good], null, { retryDelaysMs: [0, 0] });
  const out = await rot.chat([{ role: "user", content: "hi" }]);
  expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
  expect(calls1).toBe(1);
  expect(rot.switches.length).toBe(1);
  expect(rot.retries.length).toBe(0);
});

test("ProvidersTest.test_key_rotation_all_keys_fail_after_same_key_retries", async () => {
  const calls = [0, 0];
  const fail = (i: number): ProviderLike => fakeProvider("rot", async () => {
    calls[i] += 1;
    throw new ProviderError(`server boom key ${i + 1}`, { kind: "server" });
  });
  const rot = new KeyRotatingProvider([fail(0), fail(1)], null, { retryDelaysMs: [0, 0] });
  let caught: unknown = null;
  try { await rot.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
  expect(String((caught as Error).message)).toContain("key 1");
  expect(String((caught as Error).message)).toContain("key 2");
  expect(calls).toEqual([3, 3]);
  expect(rot.switches.length).toBe(1);
  expect(rot.retries.length).toBe(4);
});

test("ProvidersTest.test_build_provider_chain_skips_keyless", () => {
  const resolver = (name: string) => {
    if (name === "xai") return cfg({ name: "xai", baseUrl: "https://api.x.ai/v1", model: "grok-4.3", apiKey: "xai-test" });
    if (name === "qwen") return cfg({ name: "qwen", baseUrl: "https://example.invalid", model: "qwen", apiKey: null, hasKey: false });
    throw new Error("unknown " + name);
  };
  const chain = buildProviderChain(cfg(), ["deepseek", "xai", "qwen"], null, { resolver });
  expect(chain).not.toBeNull();
  expect(chain).toBeInstanceOf(FallbackProvider);
  expect(describeProvider(chain)).toContain("deepseek");
});

test("ProvidersTest.test_build_provider_chain_single_returns_provider", () => {
  const chain = buildProviderChain(cfg(), ["deepseek"], null, {});
  expect(chain).toBeInstanceOf(Provider);
});

test("ProvidersTest.test_describe_provider", () => {
  const p = new Provider(cfg({ name: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: "sk-ollama-local" }));
  expect(describeProvider(p)).toContain("ollama");
  expect(describeProvider(p)).toContain("qwen2.5:7b");
});

test("ProvidersTest.test_default_chat_timeout_is_60_and_env_overridable", () => {
  expect(DEFAULT_CHAT_TIMEOUT).toBe(60);
  const prev = process.env.NYRA_PROVIDER_TIMEOUT;
  try {
    delete process.env.NYRA_PROVIDER_TIMEOUT;
    expect(resolveChatTimeout()).toBe(60);
    process.env.NYRA_PROVIDER_TIMEOUT = "90";
    expect(resolveChatTimeout()).toBe(90);
    process.env.NYRA_PROVIDER_TIMEOUT = "5";
    expect(resolveChatTimeout()).toBe(10);
    process.env.NYRA_PROVIDER_TIMEOUT = "999";
    expect(resolveChatTimeout()).toBe(600);
    process.env.NYRA_PROVIDER_TIMEOUT = "abc";
    expect(resolveChatTimeout()).toBe(60);
  } finally {
    if (prev === undefined) delete process.env.NYRA_PROVIDER_TIMEOUT;
    else process.env.NYRA_PROVIDER_TIMEOUT = prev;
  }
});

function hangingProvider(name: string): ProviderLike {
  return {
    name, model: "m-" + name, baseUrl: "https://example.invalid",
    hasCredentials: () => true,
    chat: (async (_msgs: unknown, _tools?: unknown, timeout = 60) => {
      await new Promise((r) => setTimeout(r, timeout * 1000));
      throw new ProviderError("API 请求超时，请稍后重试", { kind: "timeout" });
    }) as ProviderLike["chat"],
    listModels: async () => [],
    redact: (t: string) => t,
  };
}

test("ProvidersTest.test_fallback_chain_total_budget_caps_slow_providers", async () => {
  const chain = new FallbackProvider([
    hangingProvider("p1"), hangingProvider("p2"), hangingProvider("p3"),
  ]);
  const started = Date.now();
  let err: unknown = null;
  try {
    await chain.chat([{ role: "user", content: "hi" }], null, 1);
  } catch (e: unknown) { err = e; }
  const elapsed = (Date.now() - started) / 1000;
  expect(err).toBeInstanceOf(ProviderError);
  const msg = String((err as Error).message);
  expect(msg).toContain("p1");
  expect(msg).toContain("p2");
  expect(msg).not.toContain("p3");
  // 旧行为 3×1s=3s；总预算 2×1s，第三个不应再等。
  expect(elapsed).toBeLessThan(2.8);
});

test("ProvidersTest.test_key_rotation_total_budget_caps_slow_keys", async () => {
  const rot = new KeyRotatingProvider([
    hangingProvider("k1"), hangingProvider("k2"), hangingProvider("k3"),
  ]);
  const started = Date.now();
  let err: unknown = null;
  try {
    await rot.chat([{ role: "user", content: "hi" }], null, 1);
  } catch (e: unknown) { err = e; }
  const elapsed = (Date.now() - started) / 1000;
  expect(err).toBeInstanceOf(ProviderError);
  const msg = String((err as Error).message);
  expect(msg).toContain("key 1");
  expect(msg).toContain("key 2");
  expect(msg).not.toContain("key 3");
  expect(elapsed).toBeLessThan(2.8);
});

test("ProvidersTest.test_fast_failures_still_try_every_provider", async () => {
  const fail = (name: string): ProviderLike => fakeProvider(name, async () => {
    throw new ProviderError("server boom", { kind: "server" });
  });
  const chain = new FallbackProvider([fail("f1"), fail("f2"), fail("f3")], null, { retryDelaysMs: [0, 0] }); // 0.5.1：同上，退避注 0，只验每个 provider 都被试到
  let err: unknown = null;
  try {
    await chain.chat([{ role: "user", content: "hi" }], null, 5);
  } catch (e: unknown) { err = e; }
  const msg = String((err as Error).message);
  expect(msg).toContain("f1");
  expect(msg).toContain("f2");
  expect(msg).toContain("f3");
});
