// tests/node/test-model-catalog.test.ts — 模型上下文窗口自动识别。
// 内置表数值、解析优先级、刷新缓存、用量汇总显示，全部 mock-only，不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_CATALOG, MODEL_CATALOG_UPDATED, lookupBuiltin, lookupCache, manualWindowFromConfig,
  parseModelCache, loadModelCache, refreshModelCache, resolveContextWindow,
  type ModelCache,
} from "../../src/modelCatalog.ts";
import { UsageTracker, formatUsage } from "../../src/usage.ts";
import { handleModels } from "../../src/modelsCli.ts";
import { PROVIDERS } from "../../src/config.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-modelctx-"));
}

test("ModelCatalog.test_builtin_values_match_official_docs", () => {
  expect(MODEL_CATALOG_UPDATED).toBe("2026-11-24");
  const byId = new Map(MODEL_CATALOG.map((e) => [e.model, e]));
  // DeepSeek：两模型均为 1M 窗口、384K 输出（api-docs.deepseek.com）。
  expect(byId.get("deepseek-flash")?.contextWindow).toBe(1_000_000);
  expect(byId.get("deepseek-flash")?.maxOutputTokens).toBe(393_216);
  expect(byId.get("deepseek-v4-pro")?.contextWindow).toBe(1_000_000);
  // xAI：grok-4.3 为 1M，grok-4.5 为 500K（docs.x.ai）。
  expect(byId.get("grok-4.3")?.contextWindow).toBe(1_000_000);
  expect(byId.get("grok-4.5")?.contextWindow).toBe(500_000);
  // OpenAI / Gemini：128K 与 1,048,576。
  expect(byId.get("gpt-4o-mini")?.contextWindow).toBe(128_000);
  expect(byId.get("gpt-4o-mini")?.maxOutputTokens).toBe(16_384);
  expect(byId.get("gemini-2.5-flash")?.contextWindow).toBe(1_048_576);
  expect(byId.get("gemini-2.5-pro")?.contextWindow).toBe(1_048_576);
  // Hermes / Qwen / Kimi / GLM / Mistral / Groq / Together / Ollama 各取一例。
  expect(byId.get("nousresearch/hermes-4-70b")?.contextWindow).toBe(131_072);
  expect(byId.get("qwen-turbo")?.contextWindow).toBe(1_000_000);
  expect(byId.get("qwen-plus")?.contextWindow).toBe(131_072);
  expect(byId.get("kimi-k3")?.contextWindow).toBe(1_048_576);
  expect(byId.get("kimi-k2.6")?.contextWindow).toBe(262_144);
  expect(byId.get("glm-5.3")?.contextWindow).toBe(1_048_576);
  expect(byId.get("glm-4.5-flash")?.contextWindow).toBe(131_072);
  expect(byId.get("mistral-small-latest")?.contextWindow).toBe(131_072);
  expect(byId.get("codestral-latest")?.contextWindow).toBe(262_144);
  expect(byId.get("llama-3.3-70b-versatile")?.contextWindow).toBe(131_072);
  expect(byId.get("meta-llama/Llama-3.3-70B-Instruct-Turbo")?.contextWindow).toBe(131_072);
  expect(byId.get("Qwen/Qwen2.5-72B-Instruct-Turbo")?.contextWindow).toBe(32_768);
  // OpenLux：窗口数来自各家官方文档（2026-11-24 核实），计价一律留空（分组系数计价）。
  expect(byId.get("deepseek-v4.1-flash")?.contextWindow).toBe(1_000_000);
  expect(byId.get("deepseek-v4.1-flash")?.maxOutputTokens).toBe(393_216);
  expect(byId.get("deepseek-v4.1-flash")?.supportsVision).toBe(true);
  expect(byId.get("claude-sonnet-5-5")?.contextWindow).toBe(1_000_000);
  expect(byId.get("claude-sonnet-5-5")?.maxOutputTokens).toBe(128_000);
  expect(byId.get("claude-opus-5-5")?.contextWindow).toBe(1_000_000);
  expect(byId.get("claude-sonnet-5")?.contextWindow).toBe(1_000_000);
  expect(byId.get("claude-fable-5-2")?.contextWindow).toBe(1_000_000);
  expect(byId.get("gemini-3.8-flash")?.contextWindow).toBe(1_000_000);
  expect(byId.get("gemini-3.7-flash")?.contextWindow).toBe(1_000_000);
  for (const id of ["deepseek-v4.1-flash", "claude-sonnet-5-5", "claude-opus-5-5", "gemini-3.8-flash"]) {
    expect(byId.get(id)?.inputPricePer1M).toBe(null);
    expect(byId.get(id)?.outputPricePer1M).toBe(null);
    expect(byId.get(id)?.provider).toBe("openlux");
  }
  // Ollama 本地模型记原生窗口，并注明实际受 num_ctx 影响。
  expect(byId.get("qwen2.5:7b")?.contextWindow).toBe(32_768);
  expect(byId.get("qwen2.5:7b")?.note).toContain("num_ctx");
  // 每条都有来源 URL 与核实日期，计价没把握的留空不编数。
  for (const e of MODEL_CATALOG) {
    expect(e.source.startsWith("https://")).toBe(true);
    expect(["2026-11-20", "2026-11-24"]).toContain(e.updated);
    expect(Number.isInteger(e.contextWindow) && e.contextWindow > 0).toBe(true);
  }
  // 覆盖 config.ts 里 PROVIDERS 的全部模型（codex-default 除外：窗口由本机 Codex 决定）。
  const missing: string[] = [];
  for (const preset of Object.values(PROVIDERS)) {
    for (const m of preset.models) {
      if (m === "codex-default") continue;
      if (!lookupBuiltin(m)) missing.push(m);
    }
  }
  expect(missing).toEqual([]);
});

test("ModelCatalog.test_lookup_normalization_and_family_prefix", () => {
  // 厂商前缀剥离：openai/gpt-4o-mini 就是 gpt-4o-mini。
  expect(lookupBuiltin("openai/gpt-4o-mini")?.entry.contextWindow).toBe(128_000);
  expect(lookupBuiltin("openai/gpt-4o-mini")?.match).toBe("exact");
  // 大小写不敏感。
  expect(lookupBuiltin("GPT-4O-MINI")?.entry.contextWindow).toBe(128_000);
  // 带日期后缀的变体走同系列推断，并注明是推断。
  const dated = lookupBuiltin("gpt-4o-mini-2024-07-18");
  expect(dated?.match).toBe("family");
  expect(dated?.entry.contextWindow).toBe(128_000);
  // 完全未知的模型返回 null，不猜。
  expect(lookupBuiltin("some-future-model-xyz")).toBeNull();
});

test("ModelCatalog.test_resolver_priority_cli_manual_cache_builtin", () => {
  const cache: ModelCache = {
    version: 1, fetchedAt: "2026-11-19T00:00:00.000Z", source: "https://openrouter.ai/api/v1/models",
    models: {
      "deepseek-flash": { contextWindow: 999 },
      "brand-new-model": { contextWindow: 777_000, maxOutputTokens: 8_000, inputPricePer1M: 1, outputPricePer1M: 2 },
    },
  };
  // CLI 最高。
  expect(resolveContextWindow({ model: "deepseek-flash", cli: 55_000, manual: 66_000, cache }).window).toBe(55_000);
  expect(resolveContextWindow({ model: "deepseek-flash", cli: 55_000, manual: 66_000, cache }).source).toBe("cli");
  // 其次手动配置。
  const manual = resolveContextWindow({ model: "deepseek-flash", manual: 66_000, manualKey: "context_window_tokens", cache });
  expect(manual.window).toBe(66_000);
  expect(manual.source).toBe("manual");
  expect(manual.detail).toContain("context_window_tokens");
  // 缓存只补内置表没有的模型：内置表有的仍以人工核实值为准。
  const builtinWins = resolveContextWindow({ model: "deepseek-flash", cache });
  expect(builtinWins.window).toBe(1_000_000);
  expect(builtinWins.source).toBe("builtin");
  const cacheOnly = resolveContextWindow({ model: "brand-new-model", cache });
  expect(cacheOnly.window).toBe(777_000);
  expect(cacheOnly.source).toBe("cache");
  // 内置表精确命中。
  const grok = resolveContextWindow({ model: "grok-4.5" });
  expect(grok.window).toBe(500_000);
  expect(grok.source).toBe("builtin");
});

test("ModelCatalog.test_resolver_unknown_models_explain_next_step", () => {
  const unknown = resolveContextWindow({ model: "some-future-model-xyz" });
  expect(unknown.window).toBeNull();
  expect(unknown.source).toBe("unknown");
  expect(unknown.detail).toContain("nyra models refresh");
  // Codex CLI：窗口由本机 Codex 决定，原因要写清。
  const codex = resolveContextWindow({ model: "codex-default", provider: "codex" });
  expect(codex.window).toBeNull();
  expect(codex.detail).toContain("Codex");
  // Ollama 未知本地模型：原因 + num_ctx 提醒。
  const ollama = resolveContextWindow({ model: "llama3.2:3b", provider: "ollama" });
  expect(ollama.window).toBeNull();
  expect(ollama.detail).toContain("num_ctx");
  // 没给模型也不猜。
  expect(resolveContextWindow({}).window).toBeNull();
});

test("ModelCatalog.test_manual_window_from_config_prefers_documented_key", () => {
  expect(manualWindowFromConfig({ context_window_tokens: 200_000, context_window: 100_000 })).toEqual({ value: 200_000, key: "context_window_tokens" });
  // 旧键作兼容回退。
  expect(manualWindowFromConfig({ context_window: 100_000 })).toEqual({ value: 100_000, key: "context_window" });
  // 非法值不采纳。
  expect(manualWindowFromConfig({ context_window_tokens: 0 })).toEqual({ value: null, key: null });
  expect(manualWindowFromConfig({ context_window_tokens: "128000" })).toEqual({ value: null, key: null });
  expect(manualWindowFromConfig({})).toEqual({ value: null, key: null });
});

test("ModelCatalog.test_parse_cache_valid_corrupt_and_old_version", () => {
  const good = parseModelCache({
    version: 1, fetchedAt: "2026-11-19T00:00:00.000Z", source: "https://openrouter.ai/api/v1/models",
    models: { "a-model": { contextWindow: 100_000 }, "bad-model": { contextWindow: -5 }, "no-window": {} },
  });
  expect(good?.models["a-model"].contextWindow).toBe(100_000);
  expect(good?.models["bad-model"]).toBeUndefined();
  expect(good?.models["no-window"]).toBeUndefined();
  expect(parseModelCache(null)).toBeNull();
  expect(parseModelCache({ version: 2, fetchedAt: "x", source: "y", models: {} })).toBeNull();
  expect(parseModelCache({ version: 1, fetchedAt: "x", source: "y" })).toBeNull();
  expect(parseModelCache("not json")).toBeNull();
  // loadModelCache：文件不存在或损坏返回 null，不抛错。
  const home = tmpHome();
  try {
    expect(loadModelCache(home)).toBeNull();
    writeFileSync(join(home, "models.json"), "{bad json", "utf-8");
    expect(loadModelCache(home)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ModelCatalog.test_refresh_parses_openrouter_payload_and_merges", async () => {
  const home = tmpHome();
  try {
    // 先放一份旧缓存：refresh 应保留新列表里没有的旧模型。
    writeFileSync(join(home, "models.json"), JSON.stringify({
      version: 1, fetchedAt: "2026-11-01T00:00:00.000Z", source: "https://openrouter.ai/api/v1/models",
      models: { "old-model-x": { contextWindow: 12_345 } },
    }), "utf-8");
    const fakeFetch = (async (_url: string, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "fresh-model", context_length: 200_000, pricing: { prompt: "0.000001", completion: "0.000003" }, top_provider: { max_completion_tokens: 8192 } },
          { id: "no-window-model", pricing: {} },
          { id: "deepseek-flash", context_length: 1_000_000, pricing: { prompt: "0.0000003", completion: "0.0000012" } },
        ],
      }),
    })) as unknown as typeof fetch;
    const r = await refreshModelCache({ home, fetchFn: fakeFetch, now: new Date("2026-11-20T00:00:00.000Z") });
    expect(r.fetched).toBe(2);
    expect(r.kept).toBe(3);
    const cache = loadModelCache(home)!;
    expect(cache.models["fresh-model"].contextWindow).toBe(200_000);
    expect(cache.models["fresh-model"].inputPricePer1M).toBeCloseTo(1);
    expect(cache.models["fresh-model"].outputPricePer1M).toBeCloseTo(3);
    expect(cache.models["fresh-model"].maxOutputTokens).toBe(8192);
    expect(cache.models["old-model-x"].contextWindow).toBe(12_345);
    expect(cache.fetchedAt).toBe("2026-11-20T00:00:00.000Z");
    expect(existsSync(join(home, "models.json"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ModelCatalog.test_refresh_failure_keeps_old_cache", async () => {
  const home = tmpHome();
  try {
    const oldText = JSON.stringify({
      version: 1, fetchedAt: "2026-11-01T00:00:00.000Z", source: "https://openrouter.ai/api/v1/models",
      models: { "old-model-x": { contextWindow: 12_345 } },
    });
    writeFileSync(join(home, "models.json"), oldText, "utf-8");
    const failingFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    await expect(refreshModelCache({ home, fetchFn: failingFetch })).rejects.toThrow("network down");
    expect(readFileSync(join(home, "models.json"), "utf-8")).toBe(oldText);
    const badShapeFetch = (async () => ({ ok: true, json: async () => ({ nope: [] }) })) as unknown as typeof fetch;
    await expect(refreshModelCache({ home, fetchFn: badShapeFetch })).rejects.toThrow("data");
    expect(readFileSync(join(home, "models.json"), "utf-8")).toBe(oldText);
    const httpFailFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(refreshModelCache({ home, fetchFn: httpFailFetch })).rejects.toThrow("HTTP 500");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ModelCatalog.test_usage_summary_shows_window_source_and_remaining", () => {
  const t = new UsageTracker(1_000_000, "builtin", "deepseek-flash");
  t.record({ usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } });
  const snap = t.snapshot();
  expect(snap.context_window_tokens).toBe(1_000_000);
  expect(snap.context_remaining_tokens).toBe(999_000);
  expect(snap.context_window_source).toBe("builtin");
  expect(snap.context_window_model).toBe("deepseek-flash");
  const out = formatUsage(snap);
  expect(out).toContain("1,000,000");
  expect(out).toContain("内置模型表");
  expect(out).toContain("999,000");
  // 未知模型：不再只写“未知”，要给模型名与下一步。
  const unknown = new UsageTracker(null, "unknown", "some-future-model-xyz");
  const outUnknown = formatUsage(unknown.snapshot());
  expect(outUnknown).toContain("some-future-model-xyz");
  expect(outUnknown).toContain("nyra models refresh");
  // 手动配置仍优先显示为手动配置。
  const manual = new UsageTracker(200_000, "manual", "deepseek-flash");
  manual.record({ usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  expect(formatUsage(manual.snapshot())).toContain("手动配置");
});

function captureOutput(): { out: string; err: string; restore: () => void } {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  return { get out() { return out; }, get err() { return err; }, restore: () => { (process.stdout as unknown as { write: unknown }).write = origOut; (process.stderr as unknown as { write: unknown }).write = origErr; } };
}

test("ModelCatalog.test_models_cli_list_show_refresh_failure", async () => {
  const home = tmpHome();
  try {
    const cap = captureOutput();
    try {
      expect(await handleModels(["list"], home)).toBe(0);
      expect(cap.out).toContain("deepseek-flash");
      expect(cap.out).toContain("1,000,000");
      expect(cap.out).toContain("未刷新过");
      expect(await handleModels(["show", "grok-4.5"], home)).toBe(0);
      expect(cap.out).toContain("500,000");
      expect(cap.out).toContain("docs.x.ai");
      expect(await handleModels(["show", "no-such-model"], home)).toBe(0);
      expect(cap.out).toContain("未收录");
      expect(await handleModels(["list", "--provider", "deepseek"], home)).toBe(0);
      expect(cap.out).toContain("deepseek-flash");
    } finally {
      cap.restore();
    }
    // refresh 失败：返回 1，stderr 说清原因与兜底，不写坏缓存。
    const origFetch = globalThis.fetch;
    const cap2 = captureOutput();
    try {
      (globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error("network down"); };
      expect(await handleModels(["refresh"], home)).toBe(1);
      expect(cap2.err).toContain("刷新失败");
      expect(cap2.err).toContain("内置模型表");
      expect(existsSync(join(home, "models.json"))).toBe(false);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
      cap2.restore();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
