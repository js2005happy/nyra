// tests/node/test-openlux.test.ts — OpenLux 当模型源（OpenAI 兼容中转，
// https://api.openlux.ai/v1）。只在假 home / 假 fetch 上验，不调真实 API、
// 不需要真实 Key、不需要网络。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, resolveProvider, getProviderPresets, knownProviderNames } from "../../src/config.ts";
import { Provider, ProviderError, describeProvider } from "../../src/providers.ts";
import { noKeyMessage } from "../../src/noKey.ts";
import { providerOrder } from "../../src/wizard.ts";
import { lookupBuiltin } from "../../src/modelCatalog.ts";

const FAKE_KEY = "ol-test-key-do-not-use";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-openlux-"));
}

function withKey<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const saved = process.env.OPENLUX_API_KEY;
  process.env.OPENLUX_API_KEY = FAKE_KEY;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OPENLUX_API_KEY;
    else process.env.OPENLUX_API_KEY = saved;
  }
}

function withFetch<T>(handler: (url: unknown, init?: Record<string, unknown>) => Promise<Response>, fn: () => T | Promise<T>): T | Promise<T> {
  const origFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = handler;
  try {
    return fn();
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
}

function okChat(body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: "ok", tool_calls: [] } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    ...body,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("OpenLuxTest.test_preset_is_openai_compatible", () => {
  const preset = PROVIDERS.openlux;
  expect(preset.baseUrl).toBe("https://api.openlux.ai/v1");
  expect(preset.envKey).toBe("OPENLUX_API_KEY");
  expect(preset.defaultModel).toBe("deepseek-v4.1-flash");
  expect(preset.connector).toBe(null);
  expect(preset.allowedHosts).toEqual(["api.openlux.ai"]);
  expect(preset.models).toContain("claude-sonnet-5-5");
  expect(preset.models).toContain("gemini-3.8-flash");
  expect(knownProviderNames({}).has("openlux")).toBe(true);
  expect(Object.keys(getProviderPresets({}))).toContain("openlux");
});

test("OpenLuxTest.test_resolve_with_key", () => {
  const home = tmpHome();
  const resolved = withKey(() => resolveProvider({ home, config: {}, providerName: "openlux" }));
  expect(resolved.name).toBe("openlux");
  expect(resolved.baseUrl).toBe("https://api.openlux.ai/v1");
  expect(resolved.model).toBe("deepseek-v4.1-flash");
  expect(resolved.apiKey).toBe(FAKE_KEY);
  expect(resolved.envKey).toBe("OPENLUX_API_KEY");
  expect(resolved.auth).toBe("env");
  expect(resolved.keySource).toBe("env");
  expect(resolved.hasKey).toBe(true);
});

test("OpenLuxTest.test_resolve_without_key_has_no_credentials", () => {
  const home = tmpHome();
  const saved = process.env.OPENLUX_API_KEY;
  delete process.env.OPENLUX_API_KEY;
  try {
    const resolved = resolveProvider({ home, config: {}, providerName: "openlux" });
    expect(resolved.hasKey).toBe(false);
    expect(resolved.apiKey).toBe(null);
  } finally {
    if (saved !== undefined) process.env.OPENLUX_API_KEY = saved;
  }
});

test("OpenLuxTest.test_chat_posts_to_openlux_chat_completions", async () => {
  const home = tmpHome();
  const calls: Record<string, unknown>[] = [];
  await withKey(() => withFetch(async (url, init) => {
    calls.push({ url, init });
    return okChat();
  }, async () => {
    const p = new Provider(resolveProvider({ home, config: {}, providerName: "openlux" }));
    const out = await p.chat([{ role: "user", content: "hi" }]);
    expect((out.choices as Record<string, unknown>[])[0].message).toBeDefined();
  }));
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.openlux.ai/v1/chat/completions");
  const headers = (calls[0].init as Record<string, unknown>).headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  const body = JSON.parse(String((calls[0].init as Record<string, unknown>).body));
  expect(body.model).toBe("deepseek-v4.1-flash");
  expect(body.messages[0].content).toBe("hi");
});

test("OpenLuxTest.test_model_passthrough_for_unlisted_models", async () => {
  const home = tmpHome();
  const calls: Record<string, unknown>[] = [];
  await withKey(() => withFetch(async (url, init) => {
    calls.push({ url, init });
    return okChat();
  }, async () => {
    // GPT-6 系不在预置 models 列表里（窗口未核实），但 --model 照样透传。
    const p = new Provider(resolveProvider({ home, config: {}, providerName: "openlux", model: "gpt-6.1-sol" }));
    await p.chat([{ role: "user", content: "hi" }]);
  }));
  const body = JSON.parse(String((calls[0].init as Record<string, unknown>).body));
  expect(body.model).toBe("gpt-6.1-sol");
});

test("OpenLuxTest.test_list_models_hits_v1_models", async () => {
  const home = tmpHome();
  await withKey(() => withFetch(async (url) => {
    expect(String(url)).toBe("https://api.openlux.ai/v1/models");
    return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }, { id: "deepseek-v4.1-flash" }] }), { status: 200 });
  }, async () => {
    const p = new Provider(resolveProvider({ home, config: {}, providerName: "openlux" }));
    expect(await p.listModels()).toEqual(["claude-sonnet-5-5", "deepseek-v4.1-flash"]);
  }));
});

test("OpenLuxTest.test_401_is_auth_error", async () => {
  const home = tmpHome();
  await withKey(() => withFetch(async () =>
    new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 }), async () => {
    const p = new Provider(resolveProvider({ home, config: {}, providerName: "openlux" }));
    let caught: unknown = null;
    try { await p.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("auth");
    expect((caught as ProviderError).status).toBe(401);
  }));
});

test("OpenLuxTest.test_402_is_quota_error", async () => {
  const home = tmpHome();
  await withKey(() => withFetch(async () =>
    new Response(JSON.stringify({ error: { message: "insufficient balance" } }), { status: 402 }), async () => {
    const p = new Provider(resolveProvider({ home, config: {}, providerName: "openlux" }));
    let caught: unknown = null;
    try { await p.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("quota");
    expect((caught as ProviderError).status).toBe(402);
  }));
});

test("OpenLuxTest.test_chat_without_key_fails_before_any_request", async () => {
  const home = tmpHome();
  const saved = process.env.OPENLUX_API_KEY;
  delete process.env.OPENLUX_API_KEY;
  let calls = 0;
  try {
    await withFetch(async () => {
      calls += 1;
      return okChat();
    }, async () => {
      const p = new Provider(resolveProvider({ home, config: {}, providerName: "openlux" }));
      let caught: unknown = null;
      try { await p.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(ProviderError);
      expect((caught as ProviderError).kind).toBe("config");
    });
  } finally {
    if (saved !== undefined) process.env.OPENLUX_API_KEY = saved;
  }
  expect(calls).toBe(0);
});

test("OpenLuxTest.test_redact_hides_key", () => {
  const home = tmpHome();
  const p = withKey(() => new Provider(resolveProvider({ home, config: {}, providerName: "openlux" })));
  expect(p.redact(`key is ${FAKE_KEY} here`)).not.toContain(FAKE_KEY);
  expect(describeProvider(p)).toContain("openlux");
  expect(describeProvider(p)).not.toContain(FAKE_KEY);
});

test("OpenLuxTest.test_no_key_message_names_openlux_env_var", () => {
  const home = tmpHome();
  const resolved = resolveProvider({ home, config: {}, providerName: "openlux" });
  const msg = noKeyMessage(resolved);
  expect(msg).toContain("OPENLUX_API_KEY");
  expect(msg).toContain("openlux");
});

test("OpenLuxTest.test_wizard_and_models_list_include_openlux", () => {
  expect(providerOrder({})).toContain("openlux");
  // 预置模型都有窗口记录（精确或同系列推断），用量汇总不会写“未知”。
  for (const m of PROVIDERS.openlux.models) {
    expect(lookupBuiltin(m)).not.toBe(null);
  }
});
