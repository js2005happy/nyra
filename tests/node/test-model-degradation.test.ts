// tests/node/test-model-degradation.test.ts — G-P1-33：模型降级做成产品功能
// （best / fast 预设 + 故障自动降级 + 计时恢复）。
//
// 覆盖：预设排序 best/fast 的确定性顺序、预设链解析（主模型不动、
// 显式链优先、开关关着只剩主模型）、故障账本往返/过期恢复/清除/
// 修剪/损坏备份/0600、健康过滤保链首、FallbackProvider 真切换标
// degraded（恢复时间挂记录上、审计与通知带 degraded_until）、
// 认证错不标 degraded、不接 health 时不标、CLI preset/health 全程、
// fallback 输出带预设行与故障账本行、model_switch 事件字段注册。
// 全用临时 home 与假 provider，不调模型；时间断言一律用相对时间。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FallbackProvider, ProviderError, buildProviderChain, type ProviderLike,
} from "../../src/providers.ts";
import {
  DEGRADED_RECOVERY_MINUTES, MODEL_HEALTH_FILE, clearDegraded, filterHealthyChain,
  getDegraded, isDegraded, listDegraded, markDegraded, pruneDegraded, readModelHealth,
} from "../../src/modelHealth.ts";
import {
  getModelPreset, resolvePresetFallbackChain, scorePresetModels,
} from "../../src/modelPresets.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { handleModels } from "../../src/modelsCli.ts";
import { formatModelSwitchNotice, readModelSwitchAudit, recordModelSwitch } from "../../src/modelSwitch.ts";
import { RunStore } from "../../src/runs.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpRoot(prefix: string): string {
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

/** 指定 kind 失败若干次的假 provider（成功时回固定文本）。 */
function failProvider(
  name: string,
  failTimes: number,
  err: ProviderError,
  opts?: { model?: string },
): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name,
    model: opts?.model ?? `${name}-model`,
    baseUrl: `https://${name}.example.com/v1`,
    calls: 0,
    hasCredentials: () => true,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      provider.calls = calls;
      if (calls <= failTimes) throw err;
      return { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    async listModels(): Promise<string[]> { return [provider.model]; },
    redact: (t: string) => t,
  };
  return provider;
}

/** buildProviderChain 用的假 provider 类（按名决定是否失败）。 */
class ChainFake {
  name: string;
  model: string;
  baseUrl: string;
  static failing = new Set<string>();
  constructor(cfg: { name: string; model: string; baseUrl: string }) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
  }
  hasCredentials(): boolean { return true; }
  async chat(): Promise<Record<string, unknown>> {
    if (ChainFake.failing.has(this.name)) {
      throw new ProviderError("服务端错误 (HTTP 500)", { status: 500, kind: "server" });
    }
    return { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  }
  async listModels(): Promise<string[]> { return [this.model]; }
  redact(t: string): string { return t; }
}

const SERVER_ERR = new ProviderError("服务端错误 (HTTP 500)", { status: 500, kind: "server" });
const QUOTA_ERR = new ProviderError("用量上限 (HTTP 429)：配额用完", { status: 429, kind: "quota" });
const AUTH_ERR = new ProviderError("认证失败 (HTTP 401)", { status: 401, kind: "auth" });

// ---- 故障账本 ----

test("markDegraded：默认 5 分钟恢复，字段齐全，failures 从 1 起", () => {
  const home = tmpRoot("nyra-health-mark-");
  try {
    const before = Date.now();
    const entry = markDegraded(home, "deepseek", "server：服务端错误");
    const after = Date.now();
    expect(entry.provider).toBe("deepseek");
    expect(entry.failures).toBe(1);
    expect(entry.reason).toBe("server：服务端错误");
    const untilMs = new Date(entry.until).getTime();
    expect(untilMs - before).toBeGreaterThanOrEqual(DEGRADED_RECOVERY_MINUTES * 60_000 - 1000);
    expect(untilMs - after).toBeLessThanOrEqual(DEGRADED_RECOVERY_MINUTES * 60_000 + 1000);
    expect(isDegraded(home, "deepseek")).toBe(true);
    expect(getDegraded(home, "deepseek")?.provider).toBe("deepseek");
    expect(listDegraded(home).map((e) => e.provider)).toEqual(["deepseek"]);
    expectPerms(join(home, MODEL_HEALTH_FILE), 0o600);
  } finally {
    cleanup(home);
  }
});

test("markDegraded：同一 provider 再标，failures +1 且 until 刷新", () => {
  const home = tmpRoot("nyra-health-remark-");
  try {
    const first = markDegraded(home, "xai", "server：第一次");
    const second = markDegraded(home, "xai", "server：第二次");
    expect(second.failures).toBe(2);
    expect(new Date(second.until).getTime()).toBeGreaterThanOrEqual(new Date(first.until).getTime());
    expect(readModelHealth(home).filter((e) => e.provider === "xai")).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("过期即恢复：minutes 0 的记录立刻不算 degraded", () => {
  const home = tmpRoot("nyra-health-expire-");
  try {
    markDegraded(home, "deepseek", "server：已过期", { minutes: 0 });
    expect(isDegraded(home, "deepseek")).toBe(false);
    expect(getDegraded(home, "deepseek")).toBeNull();
    expect(listDegraded(home)).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("clearDegraded：有返回 true，再清返回 false；pruneDegraded 删过期条", () => {
  const home = tmpRoot("nyra-health-clear-");
  try {
    markDegraded(home, "deepseek", "server：活的");
    markDegraded(home, "xai", "server：死的", { minutes: 0 });
    expect(clearDegraded(home, "deepseek")).toBe(true);
    expect(clearDegraded(home, "deepseek")).toBe(false);
    expect(isDegraded(home, "deepseek")).toBe(false);
    expect(pruneDegraded(home)).toBe(1);
    expect(readModelHealth(home)).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("损坏的账本先备份再回空账本，不抛错", () => {
  const home = tmpRoot("nyra-health-corrupt-");
  try {
    writeFileSync(join(home, MODEL_HEALTH_FILE), "{ 不是 json", "utf-8");
    expect(readModelHealth(home)).toEqual([]);
    const backups = readdirSync(home).filter((f) => f.startsWith(`${MODEL_HEALTH_FILE}.bak-`));
    expect(backups).toHaveLength(1);
    expect(markDegraded(home, "deepseek", "server：备份后还能写").failures).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("filterHealthyChain：保链首、过滤尾巴 degraded、永不返回空链", () => {
  const home = tmpRoot("nyra-health-filter-");
  try {
    markDegraded(home, "xai", "server：坏的");
    markDegraded(home, "ollama", "server：也坏的");
    expect(filterHealthyChain(home, ["deepseek", "xai", "ollama"])).toEqual(["deepseek"]);
    // 链首即使 degraded 也保留：主模型下一轮照样先试。
    markDegraded(home, "deepseek", "server：主模型也坏过");
    expect(filterHealthyChain(home, ["deepseek", "xai", "ollama"])).toEqual(["deepseek"]);
    expect(filterHealthyChain(home, ["deepseek"])).toEqual(["deepseek"]);
    expect(filterHealthyChain(home, [])).toEqual([]);
  } finally {
    cleanup(home);
  }
});

// ---- 预设排序 ----

test("fast 排序：免费与最便宜在前，没核实价格的排最后", () => {
  const fast = scorePresetModels("fast");
  expect(fast.slice(0, 3).map((r) => r.model)).toEqual(["glm-4.7-flash", "glm-4.5-flash", "qwen-turbo"]);
  expect(fast[0].rank).toBe(1);
  expect(fast[0].inputPricePer1M).toBe(0);
  // 没核实价格的在最后一段，且仍按窗口排。
  const unknownPrice = fast.filter((r) => r.inputPricePer1M === null);
  expect(unknownPrice.length).toBeGreaterThan(0);
  expect(fast.slice(-unknownPrice.length)).toEqual(unknownPrice);
});

test("best 排序：窗口最大在前，同窗口视觉优先、再按价格", () => {
  const best = scorePresetModels("best");
  expect(best.slice(0, 5).map((r) => r.model)).toEqual([
    "gemini-2.5-flash", "gemini-2.5-pro", "kimi-k3", "glm-5.3", "grok-4.3",
  ]);
  expect(best[0].contextWindow).toBe(1_048_576);
  expect(best[0].supportsVision).toBe(true);
});

test("getModelPreset：只有 best/fast 算数，其余当没设", () => {
  expect(getModelPreset({})).toBeNull();
  expect(getModelPreset({ model_preset: "best" })).toBe("best");
  expect(getModelPreset({ model_preset: "fast" })).toBe("fast");
  expect(getModelPreset({ model_preset: "cheapest" })).toBeNull();
  expect(getModelPreset({ model_preset: null })).toBeNull();
});

test("resolvePresetFallbackChain：没预设原样；有预设只排尾巴；显式链优先；开关关着只剩主模型", () => {
  const base = {
    provider: "deepseek", model: "deepseek-flash",
    fallback_enabled: true, fallback_providers: ["deepseek", "xai", "ollama", "qwen"],
  };
  expect(resolvePresetFallbackChain(base, "deepseek", true)).toEqual(["deepseek", "xai", "ollama", "qwen"]);
  // fast 预设：qwen（qwen-turbo 输入 0.05）排到 xai（grok 最便宜 1.25）前面。
  const fast = resolvePresetFallbackChain({ ...base, model_preset: "fast" }, "deepseek", true);
  expect(fast[0]).toBe("deepseek");
  expect(fast.indexOf("qwen")).toBeLessThan(fast.indexOf("xai"));
  // best 预设：xai（grok-4.3 窗口 1M）排到 qwen 前面。
  const best = resolvePresetFallbackChain({ ...base, model_preset: "best" }, "deepseek", true);
  expect(best[0]).toBe("deepseek");
  expect(best.indexOf("xai")).toBeLessThan(best.indexOf("qwen"));
  // 显式 chainOverride 优先于预设。
  expect(resolvePresetFallbackChain({ ...base, model_preset: "fast" }, "deepseek", true, ["ollama", "xai"])).toEqual(["deepseek", "ollama", "xai"]);
  // 开关关着：只剩主模型，预设不把它撑开。
  expect(resolvePresetFallbackChain({ ...base, model_preset: "fast" }, "deepseek", false)).toEqual(["deepseek"]);
});

// ---- FallbackProvider 接线 ----

test("真切换标 degraded：恢复时间挂记录上，账本里有它", async () => {
  const home = tmpRoot("nyra-health-switch-");
  try {
    // 配额错不重试同一家、直接换——真切换走之前标 degraded。
    const bad = failProvider("deepseek", 1, QUOTA_ERR);
    const good = failProvider("xai", 0, SERVER_ERR);
    const chain = new FallbackProvider([bad, good], null, {
      retryDelaysMs: [0, 0], sleep: () => Promise.resolve(), health: { home },
    });
    const result = await chain.chat([{ role: "user", content: "hi" }]);
    expect((result as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe("ok");
    expect(chain.switches).toHaveLength(1);
    const record = chain.switches[0];
    expect(record.from).toBe("deepseek");
    expect(record.to).toBe("xai");
    expect(typeof record.degradedUntil).toBe("string");
    const untilMs = new Date(record.degradedUntil as string).getTime();
    expect(untilMs).toBeGreaterThan(Date.now());
    expect(untilMs - Date.now()).toBeLessThanOrEqual(DEGRADED_RECOVERY_MINUTES * 60_000 + 5000);
    expect(isDegraded(home, "deepseek")).toBe(true);
    expect(getDegraded(home, "deepseek")?.failures).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("认证错不标 degraded：不可恢复的失败直接抛，不进切换", async () => {
  const home = tmpRoot("nyra-health-auth-");
  try {
    const bad = failProvider("deepseek", 1, AUTH_ERR);
    const good = failProvider("xai", 0, SERVER_ERR);
    const chain = new FallbackProvider([bad, good], null, {
      retryDelaysMs: [0, 0], sleep: () => Promise.resolve(), health: { home },
    });
    await expect(chain.chat([{ role: "user", content: "hi" }])).rejects.toThrow("认证失败");
    expect(chain.switches).toEqual([]);
    expect(isDegraded(home, "deepseek")).toBe(false);
    expect(existsSync(join(home, MODEL_HEALTH_FILE))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("不接 health 时不标 degraded：老行为一字不改", async () => {
  const home = tmpRoot("nyra-health-noopt-");
  try {
    const bad = failProvider("deepseek", 1, QUOTA_ERR);
    const good = failProvider("xai", 0, SERVER_ERR);
    const chain = new FallbackProvider([bad, good], null, {
      retryDelaysMs: [0, 0], sleep: () => Promise.resolve(),
    });
    await chain.chat([{ role: "user", content: "hi" }]);
    expect(chain.switches).toHaveLength(1);
    expect(chain.switches[0].degradedUntil).toBeUndefined();
    expect(existsSync(join(home, MODEL_HEALTH_FILE))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("buildProviderChain：建链过滤未恢复的尾巴，过期后重新选用", () => {
  const home = tmpRoot("nyra-health-build-");
  try {
    ChainFake.failing = new Set();
    const primary = { name: "deepseek", model: "deepseek-flash", baseUrl: "https://deepseek.example.com/v1", auth: "env" } as Parameters<typeof buildProviderChain>[0];
    const resolver = (name: string) => ({ name, model: `${name}-model`, baseUrl: `https://${name}.example.com/v1`, auth: "env" }) as Parameters<typeof buildProviderChain>[0];
    markDegraded(home, "xai", "server：坏的");
    const built = buildProviderChain(primary, ["deepseek", "xai", "ollama"], null, {
      providerCls: ChainFake as unknown as Parameters<typeof buildProviderChain>[3]["providerCls"],
      resolver, health: { home },
    });
    const names = (built as FallbackProvider).providers.map((p) => p.name);
    expect(names).toEqual(["deepseek", "ollama"]);
    // 过期后重新选用：minutes 0 的记录不算 degraded。
    markDegraded(home, "ollama", "server：已过期", { minutes: 0 });
    const rebuilt = buildProviderChain(primary, ["deepseek", "xai", "ollama"], null, {
      providerCls: ChainFake as unknown as Parameters<typeof buildProviderChain>[3]["providerCls"],
      resolver, health: { home },
    });
    expect((rebuilt as FallbackProvider).providers.map((p) => p.name)).toEqual(["deepseek", "ollama"]);
    // 链首 degraded 也保留。
    markDegraded(home, "deepseek", "server：主模型也坏过");
    const withPrimary = buildProviderChain(primary, ["deepseek", "xai", "ollama"], null, {
      providerCls: ChainFake as unknown as Parameters<typeof buildProviderChain>[3]["providerCls"],
      resolver, health: { home },
    });
    expect((withPrimary as FallbackProvider).providers.map((p) => p.name)).toEqual(["deepseek", "ollama"]);
  } finally {
    ChainFake.failing = new Set();
    cleanup(home);
  }
});

// ---- 审计与通知带 degraded_until ----

test("切换审计与通知带 degraded_until：审计行有恢复时间，通知写明几分钟内不再选用", () => {
  const home = tmpRoot("nyra-health-audit-");
  try {
    const record = {
      from: "deepseek", to: "xai", error: "服务端错误 (HTTP 500)", kind: "server" as const,
      status: 500, trigger: "server" as const, degradedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const entry = recordModelSwitch(home, record, { runId: "run-1" });
    expect(entry?.degraded_until).toBe(record.degradedUntil);
    expect(readModelSwitchAudit(home)[0]?.degraded_until).toBe(record.degradedUntil);
    const notice = formatModelSwitchNotice(record);
    expect(notice).toContain("已标故障");
    expect(notice).toContain("前不再选用");
    // 没 degradedUntil 的记录通知原样不动。
    const plain = formatModelSwitchNotice({ ...record, degradedUntil: undefined });
    expect(plain).not.toContain("已标故障");
  } finally {
    cleanup(home);
  }
});

test("model_switch 事件字段已注册：degraded_until 能进事件链", () => {
  const home = tmpRoot("nyra-health-event-");
  try {
    const store = new RunStore(join(home, "runs"));
    const runId = store.create("降级事件测试", "sess-1", home, "normal", 10).run_id;
    expect(() => store.appendEvent(runId, "model_switch", {
      from: "deepseek", to: "xai", reason: "服务端错误", trigger: "server",
      kind: "server", status: 500, spent_usd: null, degraded_until: "2026-11-24T01:30:00.000Z",
    })).not.toThrow();
    const events = store.readEvents(runId) as { type: string; degraded_until?: string }[];
    expect(events.map((e) => e.type)).toContain("model_switch");
    expect(events.find((e) => e.type === "model_switch")?.degraded_until).toBe("2026-11-24T01:30:00.000Z");
  } finally {
    cleanup(home);
  }
});

// ---- CLI 全程 ----

test("nyra models preset 全程：看、设 best/fast、清掉，配置只改这一键", async () => {
  const home = tmpRoot("nyra-health-preset-cli-");
  try {
    saveConfig(home, { provider: "deepseek", model: "deepseek-flash", fallback_enabled: true, fallback_providers: ["deepseek", "xai", "ollama"] });
    const cap = captureOutput();
    try {
      expect(await handleModels(["preset"], home)).toBe(0);
      expect(cap.out).toContain("当前降级预设：未设置");
      expect(cap.out).toContain("deepseek → xai → ollama");
      expect(await handleModels(["preset", "fast"], home)).toBe(0);
      expect(cap.out).toContain("降级预设已设为 fast");
      expect(loadConfig(home).model_preset).toBe("fast");
      expect(await handleModels(["preset"], home)).toBe(0);
      expect(cap.out).toContain("当前降级预设：fast");
      expect(await handleModels(["preset", "best"], home)).toBe(0);
      expect(loadConfig(home).model_preset).toBe("best");
      expect(await handleModels(["preset", "off"], home)).toBe(0);
      expect(cap.out).toContain("降级预设已清除");
      expect(getModelPreset(loadConfig(home))).toBeNull();
      expect(await handleModels(["preset", "cheapest"], home)).toBe(2);
      expect(cap.err).toContain("用法：nyra models preset");
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("nyra models health 全程：空态、列出、提前清除", async () => {
  const home = tmpRoot("nyra-health-cli-");
  try {
    const cap = captureOutput();
    try {
      expect(await handleModels(["health"], home)).toBe(0);
      expect(cap.out).toContain("当前没有被标故障的模型");
      markDegraded(home, "xai", "server：服务端错误");
      expect(await handleModels(["health"], home)).toBe(0);
      expect(cap.out).toContain("xai");
      expect(cap.out).toContain("前不再选用");
      expect(cap.out).toContain("累计标了 1 次");
      expect(await handleModels(["health", "clear", "xai"], home)).toBe(0);
      expect(cap.out).toContain("已提前恢复");
      expect(await handleModels(["health", "clear", "xai"], home)).toBe(0);
      expect(cap.out).toContain("当前没有被标故障");
      expect(await handleModels(["health", "clear"], home)).toBe(2);
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("nyra models fallback 输出带预设行与故障账本行", async () => {
  const home = tmpRoot("nyra-health-fallback-cli-");
  try {
    saveConfig(home, {
      provider: "deepseek", model: "deepseek-flash",
      fallback_enabled: true, fallback_providers: ["deepseek", "xai"], model_preset: "fast",
    });
    markDegraded(home, "xai", "server：服务端错误");
    const cap = captureOutput();
    try {
      expect(await handleModels(["fallback"], home)).toBe(0);
      expect(cap.out).toContain("降级预设：fast");
      expect(cap.out).toContain("故障账本：xai 已标故障");
      expect(cap.out).toContain("前不再选用");
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});
