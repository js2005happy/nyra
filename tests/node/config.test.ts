// tests/node/config.test.ts — src/config.ts 与 Python 版 nyra/config.py 的对等行为。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDERS, DEFAULT_CONFIG, envVar, resolveHome, loadConfig, saveConfig,
  resolveProvider, resolveFallbackChain, plaintextHttpError,
} from "../../src/config.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-cfg-test-"));
}

test("14 个 provider 预置齐全，默认 deepseek/deepseek-flash", () => {
  expect(Object.keys(PROVIDERS).sort()).toEqual(
    ["codex", "custom", "deepseek", "gemini", "glm", "groq", "kimi", "mistral",
     "ollama", "openai", "openrouter", "qwen", "together", "xai"].sort());
  expect(DEFAULT_CONFIG.provider).toBe("deepseek");
  expect(DEFAULT_CONFIG.model).toBe("deepseek-flash");
  expect(DEFAULT_CONFIG.fallback_enabled).toBe(false); // 兜底默认关闭（用户定的安全事项）
  expect(PROVIDERS.deepseek.envKey).toBe("DEEPSEEK_API_KEY");
  expect(PROVIDERS.qwen.envKey).toBe("DASHSCOPE_API_KEY");
  expect(PROVIDERS.codex.auth).toBe("cli");
});

test("NYRA_HOME 优先于 ~/.nyra；ANGEL_HOME 不再绕过旧目录", () => {
  const home = tmpHome();
  expect(resolveHome(home)).toBe(home);
  const savedNyra = process.env.NYRA_HOME;
  const savedAngel = process.env.ANGEL_HOME;
  try {
    delete process.env.NYRA_HOME;
    process.env.ANGEL_HOME = home;
    // envVar("HOME") 的 ANGEL_ 回退保留（用一次印一次废弃提示），
    // 但 resolveHome 不再用它决定数据目录：旧 ~/.angel 不再原地复用。
    expect(envVar("HOME")).toBe(home);
    expect(resolveHome()).not.toBe(home);
  } finally {
    if (savedNyra !== undefined) process.env.NYRA_HOME = savedNyra; else delete process.env.NYRA_HOME;
    if (savedAngel !== undefined) process.env.ANGEL_HOME = savedAngel; else delete process.env.ANGEL_HOME;
  }
});

test("loadConfig：不存在建默认文件；损坏返回默认值；saveConfig 只改设置", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  expect(cfg.provider).toBe("deepseek");
  expect(cfg.model).toBe("deepseek-flash");
  saveConfig(home, { provider: "qwen", model: "qwen-plus" });
  const cfg2 = loadConfig(home);
  expect(cfg2.provider).toBe("qwen");
  expect(cfg2.model).toBe("qwen-plus");
  writeFileSync(join(home, "config.json"), "{ broken json", "utf-8");
  expect(loadConfig(home).provider).toBe("deepseek");
});

test("resolveProvider：无 Key 时 hasKey=false；有环境变量 Key 时 hasKey=true", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  delete process.env.DEEPSEEK_API_KEY;
  const noKey = resolveProvider({ home, config: cfg });
  expect(noKey.name).toBe("deepseek");
  expect(noKey.hasKey).toBe(false);
  expect(noKey.keySource).toBe("none");
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const withKey = resolveProvider({ home, config: cfg });
    expect(withKey.hasKey).toBe(true);
    expect(withKey.keySource).toBe("env");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("resolveProvider：qwen 无 Key 时 envKey 是 DASHSCOPE（不是 DEEPSEEK）", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  delete process.env.DASHSCOPE_API_KEY;
  const p = resolveProvider({ home, config: cfg, providerName: "qwen" });
  expect(p.envKey).toBe("DASHSCOPE_API_KEY");
  expect(p.model).toBe("qwen-plus");
  expect(p.hasKey).toBe(false);
});

test("resolveProvider：ollama/codex 本地型不需要 Key", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  expect(resolveProvider({ home, config: cfg, providerName: "ollama" }).hasKey).toBe(true);
  expect(resolveProvider({ home, config: cfg, providerName: "codex" }).hasKey).toBe(true);
  expect(resolveProvider({ home, config: cfg, providerName: "codex" }).auth).toBe("cli");
});

test("resolveProvider：自定义 provider 的 snake_case 条目能解析（base_url/default_model/env_key）", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  cfg.custom_providers = {
    myllm: { base_url: "http://127.0.0.1:8080/v1", default_model: "my-model", env_key: "MYLLM_API_KEY", models: ["my-model"] },
  };
  delete process.env.MYLLM_API_KEY;
  const p = resolveProvider({ home, config: cfg, providerName: "myllm" });
  expect(p.name).toBe("myllm");
  expect(p.baseUrl).toBe("http://127.0.0.1:8080/v1");
  expect(p.model).toBe("my-model");
  expect(p.envKey).toBe("MYLLM_API_KEY");
  expect(p.hasKey).toBe(false);
});

test("resolveProvider：自定义 provider 缺 base_url 时报错点名该 provider", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  cfg.custom_providers = { broken: { default_model: "m", env_key: "X_KEY" } };
  expect(() => resolveProvider({ home, config: cfg, providerName: "broken" }))
    .toThrow("自定义 provider broken 的配置里缺少 base_url");
});

test("resolveProvider：未知 provider 报错并列出可用项", () => {
  const home = tmpHome();
  expect(() => resolveProvider({ home, config: loadConfig(home), providerName: "nope" }))
    .toThrow("Unknown provider: nope");
});

test("plaintextHttpError：本机 http 放行，外网 http 拒绝", () => {
  expect(plaintextHttpError("x", "http://localhost:11434/v1")).toBeNull();
  expect(plaintextHttpError("x", "http://127.0.0.1:8080/v1")).toBeNull();
  expect(plaintextHttpError("x", "https://api.deepseek.com/v1")).toBeNull();
  expect(plaintextHttpError("x", "http://evil.example.com/v1")).toMatch("明文 http");
});

test("resolveFallbackChain：默认关闭只返回 primary；显式开启才给链", () => {
  const home = tmpHome();
  const cfg = loadConfig(home);
  expect(resolveFallbackChain(cfg, "deepseek")).toEqual(["deepseek"]);
  expect(resolveFallbackChain({ ...cfg, fallback_enabled: true }, "qwen"))
    .toEqual(["qwen", "deepseek", "xai", "ollama"]);
});
