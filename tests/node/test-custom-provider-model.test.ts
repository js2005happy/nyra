// 自定义 provider 用它自己配置的 default_model：不必在顶层再写 model，
// 首次启动写进 config.json 的默认 deepseek-flash 也不能盖掉它（实机截图发现的问题）。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, configModelFor, effectiveModelFor, resolveProfile, resolveProvider } from "../../src/config.ts";

const home = mkdtempSync(join(tmpdir(), "nyra-custom-model-"));
const custom = { local: { base_url: "http://127.0.0.1:9911/v1", default_model: "demo-model" } };

function resolveLikeCli(cfg: Record<string, unknown>): string {
  const p = resolveProfile(null, cfg);
  return resolveProvider({ home, config: cfg, providerName: p.provider, model: p.model ?? undefined }).model;
}

describe("custom provider model", () => {
  test("default top-level deepseek-flash does not override custom provider's default_model", () => {
    const cfg = { ...DEFAULT_CONFIG, provider: "local", custom_providers: custom };
    expect(cfg.model).toBe("deepseek-flash");
    expect(resolveLikeCli(cfg)).toBe("demo-model");
    expect(effectiveModelFor(cfg, "local")).toBe("demo-model");
    expect(configModelFor(cfg, "local")).toBeNull();
  });

  test("an explicit model for the custom provider still wins", () => {
    const cfg = { ...DEFAULT_CONFIG, provider: "local", model: "my-own-model", custom_providers: custom };
    expect(resolveLikeCli(cfg)).toBe("my-own-model");
    expect(effectiveModelFor(cfg, "local")).toBe("my-own-model");
  });

  test("built-in providers keep honouring top-level model", () => {
    const cfg = { ...DEFAULT_CONFIG, model: "deepseek-v4-pro" };
    expect(resolveLikeCli(cfg)).toBe("deepseek-v4-pro");
    expect(resolveLikeCli({ ...DEFAULT_CONFIG })).toBe("deepseek-flash");
  });

  test("a model listed by the custom provider is honoured even if another provider also lists it", () => {
    const cfg = { ...DEFAULT_CONFIG, provider: "local", custom_providers: { local: { ...custom.local, models: ["demo-model", "deepseek-flash"] } } };
    expect(resolveLikeCli(cfg)).toBe("deepseek-flash");
  });

  test("gateway info and settings show the provider's own model", async () => {
    const { Gateway } = await import("../../src/gateway.ts");
    const cfg = { ...DEFAULT_CONFIG, provider: "local", custom_providers: custom };
    const gw = new Gateway({ home, config: cfg, workdir: home, port: 0 });
    const info = gw.info();
    expect(info.model).toBe("demo-model");
    expect(String(info.provider_desc)).toBe("local / demo-model");
    const view = gw.settingsView() as { model: { default_model: string | null } };
    expect(view.model.default_model).toBe("demo-model");
  });
});
