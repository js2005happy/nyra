// tests/node/test-model-switch-notify.test.ts — 备用模型切换通知（用户 2026-11-21
// 拍板，Hermes v0.23.3 借鉴点）。
//
// 覆盖：真切换记审计且通知含三要素（从谁、到谁、真实报错）；没开备用时不切
// 换不通知不记审计；allowlist 外的模型不进链；队列/定时任务里不自动切；
// 报错脱敏（密钥样字符串不原样进审计）；用量汇总（stats/cost JSON）里能
// 看到切换统计；`nyra models fallback` 只读查看链与本月统计。
// 假 provider 上验证（真 API 未跑通，见 CHANGELOG 诚实边界）。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError, FallbackProvider, Provider, buildProviderChain,
  type ProviderLike, type ResolvedProvider,
} from "../../src/providers.ts";
import { resolveFallbackChain, resolveProvider, saveConfig } from "../../src/config.ts";
import {
  recordModelSwitch, readModelSwitchAudit, summarizeModelSwitches,
  modelSwitchSummaryLine, formatModelSwitchNotice, scrubSwitchError,
  type ModelSwitchRecord,
} from "../../src/modelSwitch.ts";
import { AUDIT_SOURCES, exportAudit, CostCapsError } from "../../src/costCaps.ts";
import { GroupStore, type ProviderFactory, type Bot } from "../../src/groups.ts";
import { buildStatsJson } from "../../src/statsCli.ts";
import { buildCostJson } from "../../src/costCli.ts";
import { handleModels } from "../../src/modelsCli.ts";
import { buildProvider } from "../../src/tasks.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

const QUOTA_ERR = new ProviderError("用量上限 (HTTP 429)：配额用完", { status: 429, kind: "quota" });

function switchRecord(over: Partial<ModelSwitchRecord> = {}): ModelSwitchRecord {
  return {
    from: "deepseek", to: "xai", error: "用量上限 (HTTP 429)：配额用完",
    kind: "quota", trigger: "quota", status: 429,
    ...over,
  };
}

/** 指定次数失败、之后回固定文本的假 provider（failTimes 很大 = 一直失败）。 */
function failProvider(
  name: string,
  failTimes: number,
  err: ProviderError,
): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name,
    model: `${name}-model`,
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

/** 回固定文本的假 provider。 */
function okProvider(name: string, text: string): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name,
    model: `${name}-model`,
    baseUrl: `https://${name}.example.com/v1`,
    calls: 0,
    hasCredentials: () => true,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      provider.calls = calls;
      return { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    async listModels(): Promise<string[]> { return [provider.model]; },
    redact: (t: string) => t,
  };
  return provider;
}

/** 按名字决定成败的假 provider 构造器（供 buildProviderChain 注入）。 */
class FakeCls implements ProviderLike {
  name: string;
  model: string;
  baseUrl: string;
  constructor(cfg: ResolvedProvider) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
  }
  hasCredentials(): boolean { return true; }
  async chat(): Promise<Record<string, unknown>> {
    if (this.name === "deepseek") throw QUOTA_ERR;
    return { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  }
  async listModels(): Promise<string[]> { return [this.model]; }
  redact(t: string): string { return t; }
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

// ---- 脱敏 ---------------------------------------------------------------

test("报错脱敏：home 目录与密钥样字符串不进审计原文", () => {
  const home = tmpRoot("nyra-switch-scrub-");
  try {
    const dirty = `open ${home}/config.json failed: key sk-abcdefghij1234567890 and token ${"x".repeat(40)}`;
    const clean = scrubSwitchError(dirty, home);
    expect(clean).not.toContain(home);
    expect(clean).toContain("[home]");
    expect(clean).not.toContain("sk-abcdefghij1234567890");
    expect(clean).not.toContain("x".repeat(40));
    expect(clean).toContain("<redacted>");
  } finally {
    cleanup(home);
  }
});

test("报错脱敏：超长报错截断到 500 字，短报错原样保留", () => {
  const home = tmpRoot("nyra-switch-scrub2-");
  try {
    expect(scrubSwitchError("用量上限 (HTTP 429)", home)).toBe("用量上限 (HTTP 429)");
    const long = "错".repeat(600);
    const cut = scrubSwitchError(long, home);
    expect(cut.length).toBeLessThanOrEqual(503);
    expect(cut.endsWith("…")).toBe(true);
  } finally {
    cleanup(home);
  }
});

// ---- 审计写盘与聚合 ------------------------------------------------------

test("审计写盘：每次真切换记一行，文件 0600，读回字段齐全", () => {
  const home = tmpRoot("nyra-switch-audit-");
  try {
    const ok = recordModelSwitch(home, switchRecord(), { runId: "run_9", agent: "lead" });
    expect(ok).not.toBeNull();
    expect(ok?.run_id).toBe("run_9");
    const file = join(home, "model-switch-audit.jsonl");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expectPerms(file, 0o600);
    const entries = readModelSwitchAudit(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      from: "deepseek", to: "xai", trigger: "quota", kind: "quota", status: 429,
      run_id: "run_9", agent: "lead", error: "用量上限 (HTTP 429)：配额用完",
    });
    // 第二次追加不覆盖第一次。
    recordModelSwitch(home, switchRecord({ from: "xai", to: "ollama", trigger: "timeout", kind: "timeout", status: null }), { runId: "run_10" });
    expect(readModelSwitchAudit(home)).toHaveLength(2);
  } finally {
    cleanup(home);
  }
});

test("审计写盘失败不抛错：home 是文件时返回 null", () => {
  const home = tmpRoot("nyra-switch-audit-fail-");
  try {
    const fileHome = join(home, "not-a-dir");
    writeFileSync(fileHome, "x");
    expect(recordModelSwitch(fileHome, switchRecord())).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("审计聚合：只计本月，按触发原因分组，最近一次可查", () => {
  const home = tmpRoot("nyra-switch-summary-");
  try {
    const now = new Date("2026-11-21T20:00:00+08:00");
    recordModelSwitch(home, switchRecord(), { at: new Date("2026-11-20T10:00:00+08:00") });
    recordModelSwitch(home, switchRecord({ from: "xai", to: "ollama", trigger: "timeout", kind: "timeout", status: null }), { at: new Date("2026-11-21T09:00:00+08:00") });
    recordModelSwitch(home, switchRecord(), { at: new Date("2026-10-05T10:00:00+08:00") });
    const s = summarizeModelSwitches(home, undefined, now);
    expect(s.month).toBe("2026-11");
    expect(s.count).toBe(2);
    expect(s.byTrigger).toEqual({ quota: 1, timeout: 1 });
    expect(s.last?.from).toBe("xai");
    expect(s.last?.to).toBe("ollama");
    // 指定月份只计那月。
    expect(summarizeModelSwitches(home, "2026-10", now).count).toBe(1);
    // 空账本：0 次、最近一次 null。
    const empty = summarizeModelSwitches(tmpRoot("nyra-switch-empty-"), undefined, now);
    expect(empty.count).toBe(0);
    expect(empty.last).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("用量汇总行：0 次不打印，有切换时含次数与最近一次从谁切到谁", () => {
  const home = tmpRoot("nyra-switch-line-");
  try {
    const now = new Date("2026-11-21T20:00:00+08:00");
    expect(modelSwitchSummaryLine(home, now)).toBe("");
    recordModelSwitch(home, switchRecord(), { at: new Date("2026-11-21T19:40:00+08:00") });
    const line = modelSwitchSummaryLine(home, now);
    expect(line).toContain("本月模型切换 1 次");
    expect(line).toContain("deepseek → xai");
    expect(line).toContain("用量触顶");
  } finally {
    cleanup(home);
  }
});

// ---- 通知文案 -------------------------------------------------------------

test("通知文案含三要素：从谁、到谁、真实报错原文与触发原因", () => {
  const notice = formatModelSwitchNotice(switchRecord());
  expect(notice).toContain("deepseek");
  expect(notice).toContain("xai");
  expect(notice).toContain("用量上限 (HTTP 429)：配额用完");
  expect(notice).toContain("用量触顶");
  expect(notice).toContain("模型切换");
});

test("通知文案：超长报错截到 120 字，不把整段报错贴出来", () => {
  const notice = formatModelSwitchNotice(switchRecord({ error: "错".repeat(200) }));
  expect(notice).toContain("…");
  expect(notice).not.toContain("错".repeat(200));
});

// ---- 真切换：记审计 -------------------------------------------------------

test("真切换记审计：FallbackProvider 切到备用时 onSwitch 写一行审计", async () => {
  const home = tmpRoot("nyra-switch-real-");
  try {
    const primary = failProvider("deepseek", 99, QUOTA_ERR);
    const secondary = failProvider("xai", 0, QUOTA_ERR);
    const chain = new FallbackProvider(
      [primary, secondary],
      (r) => { recordModelSwitch(home, r, { runId: "run_9" }); },
      { retryDelaysMs: [0, 0] },
    );
    const out = await chain.chat([{ role: "user", content: "hi" }]);
    expect((out.choices as unknown[]).length).toBe(1);
    expect(chain.switches).toHaveLength(1);
    expect(chain.switches[0]).toMatchObject({ from: "deepseek", to: "xai", kind: "quota" });
    const entries = readModelSwitchAudit(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ from: "deepseek", to: "xai", trigger: "quota", run_id: "run_9" });
  } finally {
    cleanup(home);
  }
});

// ---- 没开备用：不切换、不通知、不记审计 -----------------------------------

test("兜底关时主模型报错只抛错：不包 FallbackProvider，不切换不记审计", async () => {
  const home = tmpRoot("nyra-switch-off-");
  try {
    const config = { provider: "deepseek", model: "deepseek-flash", fallback_enabled: false };
    const primaryCfg = resolveProvider({ home, config, providerName: "deepseek" });
    let switched = 0;
    const chain = buildProviderChain(primaryCfg, ["deepseek"], () => { switched += 1; }, { providerCls: FakeCls });
    expect(chain).not.toBeInstanceOf(FallbackProvider);
    await expect(chain.chat([{ role: "user", content: "hi" }])).rejects.toThrow("用量上限");
    expect(switched).toBe(0);
    expect(existsSync(join(home, "model-switch-audit.jsonl"))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("allowlist 外的模型不进链：未知名字从兜底链里跳过", () => {
  const names = resolveFallbackChain(
    { fallback_enabled: true, fallback_providers: ["deepseek", "evil-provider", "xai"] },
    "deepseek", true, ["deepseek", "evil-provider", "xai"],
  );
  expect(names).toEqual(["deepseek", "xai"]);
  expect(names).not.toContain("evil-provider");
});

test("队列与定时任务里不自动切：buildProvider 只给单个 Provider", () => {
  const home = tmpRoot("nyra-switch-queue-");
  const prevKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "test-key-for-build-provider";
    const config = { ...DEFAULT_CONFIG, fallback_enabled: true, fallback_providers: ["xai", "ollama"] };
    const [provider] = buildProvider(config, home);
    expect(provider).toBeInstanceOf(Provider);
    expect(provider).not.toBeInstanceOf(FallbackProvider);
    expect(provider.name).toBe("deepseek");
  } finally {
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevKey;
    cleanup(home);
  }
});

// ---- 审计导出第 7 个来源 ---------------------------------------------------

test("审计导出含第 7 个来源 model_switch，且只导它时只有切换行", () => {
  const home = tmpRoot("nyra-switch-export-");
  try {
    expect(AUDIT_SOURCES.some((s) => s.file === "model-switch-audit.jsonl" && s.label === "model_switch")).toBe(true);
    recordModelSwitch(home, switchRecord());
    const exported = exportAudit(home, { sources: ["model_switch"] });
    expect(exported.lines).toBe(1);
    expect(exported.text).toContain("model_switch");
    expect(exported.text).toContain("deepseek");
    expect(exported.text).toContain("xai");
    expect(() => exportAudit(home, { sources: ["no-such-source"] })).toThrow("model_switch");
  } finally {
    cleanup(home);
  }
});

// ---- 群聊：回复前面附通知 -------------------------------------------------

test("群聊回复前面附上切换通知，消息里照旧记结构化切换记录", async () => {
  const root = tmpRoot("nyra-switch-groups-");
  try {
    const factory: ProviderFactory = (bot: Bot) => {
      const flaky = failProvider("deepseek", 99, QUOTA_ERR);
      const ok = okProvider("xai", "小结完成。");
      return new FallbackProvider(
        [flaky, ok],
        (r) => { recordModelSwitch(root, r, { agent: bot.id }); },
        { retryDelaysMs: [0, 0] },
      );
    };
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", [
      { id: "lead", name: "Lead", role: "R", instructions: "Own ideas" },
      { id: "builder", name: "Builder", role: "R", instructions: "Own ideas" },
    ]);
    const result = await store.send("dev", "做一个小结");
    expect(result.total).toBe(3);
    const reply = result.messages[1];
    expect(reply.content).toContain("模型切换");
    expect(reply.content).toContain("deepseek");
    expect(reply.content).toContain("xai");
    expect(reply.content).toContain("用量上限");
    expect(reply.content).toContain("小结完成。");
    expect(reply.model_switches).toHaveLength(1);
    expect(reply.model_switches[0]).toMatchObject({ from: "deepseek", to: "xai" });
    // 两个机器人各切一次，审计里两行（agent 各是机器人 id）。
    const entries = readModelSwitchAudit(root);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.agent).sort()).toEqual(["builder", "lead"]);
  } finally {
    cleanup(root);
  }
});

// ---- 用量汇总 JSON ---------------------------------------------------------

test("stats JSON 带 model_switches：没切换时全零，有切换时含最近一次", () => {
  const base = {
    month: "2026-11", monthTokens: 12000, monthSpentUsd: 1.5, incomplete: false,
    mcpSpentUsd: 0.2, resetAt: "2026-12-01",
    today: { date: "2026-11-20", tokens: 800, spent: 0.1, calls: 3 }, days: [],
  };
  const empty = buildStatsJson(base);
  expect(empty.model_switches).toEqual({ count: 0, by_trigger: {}, last: null });
  const withSwitch = buildStatsJson({
    ...base,
    modelSwitches: {
      count: 2, byTrigger: { quota: 2 },
      last: { from: "deepseek", to: "xai", trigger: "quota", at: "2026-11-21T19:40:00+08:00" },
    },
  });
  expect(withSwitch.model_switches.count).toBe(2);
  expect(withSwitch.model_switches.by_trigger).toEqual({ quota: 2 });
  expect(withSwitch.model_switches.last).toMatchObject({ from: "deepseek", to: "xai", trigger: "quota" });
});

test("cost JSON 月度里带 model_switches：没切换时全零", () => {
  const cfg = { pricing: { m1: { inputPer1M: 1, outputPer1M: 2 } } };
  const monthly = { spentUsd: 1.2, mcpUsd: 0.2, month: "2026-11", resetAt: "2026-12-01" };
  const empty = buildCostJson({ model: "m1", config: cfg, monthly });
  expect(empty.monthly?.model_switches).toEqual({ count: 0, by_trigger: {}, last: null });
  const withSwitch = buildCostJson({
    model: "m1", config: cfg,
    monthly: {
      ...monthly,
      modelSwitches: {
        count: 1, byTrigger: { quota: 1 },
        last: { from: "deepseek", to: "xai", trigger: "quota", at: "2026-11-21T19:40:00+08:00" },
      },
    },
  });
  expect(withSwitch.monthly?.model_switches.count).toBe(1);
  expect(withSwitch.monthly?.model_switches.last).toMatchObject({ from: "deepseek", to: "xai" });
});

// ---- nyra models fallback ---------------------------------------------------

test("models fallback：只读看清开关、链顺序与本月切换统计", async () => {
  const home = tmpRoot("nyra-switch-models-");
  try {
    saveConfig(home, {
      provider: "deepseek", model: "deepseek-flash",
      fallback_enabled: true, fallback_providers: ["deepseek", "xai"],
    });
    recordModelSwitch(home, switchRecord({ at: "2026-11-21T19:40:00+08:00" }));
    const cap = captureOutput();
    try {
      expect(await handleModels(["fallback"], home)).toBe(0);
      expect(cap.out).toContain("备用模型：已开启");
      expect(cap.out).toContain("deepseek → xai");
      expect(cap.out).toContain("本月模型切换 1 次");
      expect(cap.out).toContain("最近一次报错：");
      expect(cap.out).toContain("用量上限 (HTTP 429)");
    } finally {
      cap.restore();
    }
    // 没配过备用时说清楚是关闭，不编造链。
    const home2 = tmpRoot("nyra-switch-models-off-");
    const cap2 = captureOutput();
    try {
      saveConfig(home2, { provider: "deepseek", model: "deepseek-flash", fallback_enabled: false });
      expect(await handleModels(["fallback"], home2)).toBe(0);
      expect(cap2.out).toContain("备用模型：未开启（默认关闭");
    } finally {
      cap2.restore();
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

// ---- 坏审计行跳过 -----------------------------------------------------------

test("读审计坏行跳过：损坏的一行不让整份审计读不出来", () => {
  const home = tmpRoot("nyra-switch-corrupt-");
  try {
    recordModelSwitch(home, switchRecord());
    const file = join(home, "model-switch-audit.jsonl");
    writeFileSync(file, readFileSync(file, "utf-8") + "这行不是 JSON\n", "utf-8");
    recordModelSwitch(home, switchRecord({ from: "xai", to: "ollama" }));
    expect(readModelSwitchAudit(home)).toHaveLength(2);
  } finally {
    cleanup(home);
  }
});
