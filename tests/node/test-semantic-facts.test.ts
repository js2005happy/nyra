// tests/node/test-semantic-facts.test.ts — 记忆语义层（十年清单第 2 项）。
// 事实抽取 + 矛盾处理：模型提炼只进待审队列，确认进库才建事实；同一主题
// 新旧并存（旧事实标被取代，不覆盖）；事实带有效期，到期自动失效。
// 只在临时 home 上跑，不碰真记忆、不调真模型（模型抽取用注入的假 runner）。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { newSessionId, saveSession } from "../../src/memory.ts";
import {
  addProposalDrafts, approveMemoryProposal, extractMemoryProposals, listMemoryProposals,
  MEMORY_PROPOSALS_FILE,
} from "../../src/memoryProposals.ts";
import { listMemoryGateEntries } from "../../src/memoryGate.ts";
import {
  buildFactExtractionPrompt, buildSemanticFactsSection, createSemanticFact,
  expireStaleFacts, findFactContradictions, formatSemanticFactResults,
  getSemanticFact, isFactExpired, listSemanticFacts, parseFactDrafts,
  runModelExtraction, searchSemanticFacts, semanticFactsConfig,
  SEMANTIC_FACTS_FILE,
} from "../../src/semanticFacts.ts";
import { runDreamMetabolism } from "../../src/dream.ts";
import { handleDream } from "../../src/dreamCli.ts";
import { handleSemanticFacts } from "../../src/semanticFactsCli.ts";
import { handleMemoryProposals } from "../../src/memoryProposalCli.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import { UsageTracker } from "../../src/usage.ts";
import { estimateCost, resolvePricing } from "../../src/cost.ts";

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

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

/** 临时给一个假 Key（只改 env，不落盘），用完原样恢复。 */
function withFakeKey(fn: () => void | Promise<void>): void | Promise<void> {
  const orig = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-fake-test-key";
  const done = fn();
  const restore = () => {
    if (orig === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = orig;
  };
  if (done instanceof Promise) return done.finally(restore);
  restore();
}

/** 临时清掉默认 provider 的 Key（测没凭证路径），用完原样恢复。 */
function withoutKey(fn: () => void | Promise<void>): void | Promise<void> {
  const orig = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const done = fn();
  const restore = () => {
    if (orig === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = orig;
  };
  if (done instanceof Promise) return done.finally(restore);
  restore();
}

function writeSession(home: string, turns: Record<string, unknown>[]): string {
  const id = newSessionId();
  saveSession(id, turns, home);
  return id;
}

// ---- 配置 ---------------------------------------------------------------

test("语义事实配置：默认关，脏配置回默认值", () => {
  const c0 = semanticFactsConfig({});
  expect(c0.enabled).toBe(false);
  expect(c0.maxPerSession).toBe(5);
  const c1 = semanticFactsConfig({ semantic_facts: { enabled: "yes", max_per_session: 99 } });
  expect(c1.enabled).toBe(false);
  expect(c1.maxPerSession).toBe(20);
  const c2 = semanticFactsConfig({ semantic_facts: { enabled: true, max_per_session: 0 } });
  expect(c2.enabled).toBe(true);
  expect(c2.maxPerSession).toBe(1);
});

// ---- 解析 ----------------------------------------------------------------

test("解析事实草稿：数组与 facts 包装都认，单条依据与有效期都认", () => {
  const turns = ["我是铜陵职业技术学院工业机器人技术专业的学生，指导老师是梅小龙。"];
  const drafts = parseFactDrafts(JSON.stringify({
    facts: [
      { subject: "身份", content: "我是铜陵职业技术学院工业机器人技术专业的学生", category: "about_you", evidenceQuote: "我是铜陵职业技术学院工业机器人技术专业的学生", validUntil: null },
      { subject: "指导老师", content: "我的指导老师是梅小龙", category: "work", evidenceQuotes: ["指导老师是梅小龙"], validUntil: "2028-06-30" },
    ],
  }), turns);
  expect(drafts.length).toBe(2);
  expect(drafts[0].evidenceSource).toContain("铜陵职业技术学院");
  expect(drafts[1].validUntil).toBe("2028-06-30");
  const bare = parseFactDrafts(JSON.stringify([
    { subject: "身份", content: "我是铜陵职业技术学院工业机器人技术专业的学生", category: "about_you", evidenceQuote: "我是铜陵职业技术学院工业机器人技术专业的学生" },
  ]), turns);
  expect(bare.length).toBe(1);
  expect(bare[0].validUntil).toBeNull();
});

test("解析事实草稿：坏 JSON 与非 JSON 文本都返回空", () => {
  expect(parseFactDrafts("{不是 json", ["hello"])).toEqual([]);
  expect(parseFactDrafts("今天天气不错", ["今天天气不错"])).toEqual([]);
  expect(parseFactDrafts(JSON.stringify({ facts: "nope" }), ["hello"])).toEqual([]);
});

test("解析事实草稿：依据不是逐字原话就整条丢弃", () => {
  const drafts = parseFactDrafts(JSON.stringify({
    facts: [
      { subject: "身份", content: "我是机器人专业的学生", category: "about_you", evidenceQuote: "我是机器人专业的学生" },
      { subject: "偏好", content: "我喜欢用深色主题", category: "about_you", evidenceQuote: "我喜欢用深色主题" },
    ],
  }), ["我喜欢用深色主题。"]);
  expect(drafts.length).toBe(1);
  expect(drafts[0].subject).toBe("偏好");
});

test("解析事实草稿：超长、非法类别、无效有效期都按规矩处理", () => {
  const turns = ["我喜欢用深色主题。"];
  const drafts = parseFactDrafts(JSON.stringify({
    facts: [
      { subject: "x".repeat(200), content: "我喜欢用深色主题", category: "about_you", evidenceQuote: "我喜欢用深色主题" },
      { subject: "偏好", content: "我喜欢用深色主题", category: "nope", evidenceQuote: "我喜欢用深色主题" },
      { subject: "偏好", content: "我喜欢用深色主题", category: "about_you", evidenceQuote: "我喜欢用深色主题", validUntil: "下个月" },
      { subject: "偏好", content: "y".repeat(400), category: "about_you", evidenceQuote: "我喜欢用深色主题" },
    ],
  }), turns);
  expect(drafts.length).toBe(1);
  expect(drafts[0].validUntil).toBeNull();
});

test("解析事实草稿：批次内重复正文去重，最多 5 条", () => {
  const facts = Array.from({ length: 7 }, (_, i) => ({
    subject: `主题${i}`, content: i < 2 ? "我喜欢用深色主题" : `我喜欢用深色主题${i}`, category: "about_you", evidenceQuote: "我喜欢用深色主题",
  }));
  const drafts = parseFactDrafts(JSON.stringify({ facts }), ["我喜欢用深色主题。"]);
  expect(drafts.length).toBe(5);
  expect(new Set(drafts.map((d) => d.content)).size).toBe(5);
});

// ---- 提示词与抽取 ---------------------------------------------------------

test("抽取提示词：只提明确说出来的事，含规则与用户消息", () => {
  const prompt = buildFactExtractionPrompt(["我喜欢用深色主题。"]);
  expect(prompt).toContain("只提用户消息里明确说出来的事");
  expect(prompt).toContain("我喜欢用深色主题。");
  expect(prompt).toContain("只回 JSON");
});

test("模型抽取：假 runner 抽出的草稿只返回，不进队列不写记忆", async () => {
  const home = tmpHome("nyra-facts-extract-");
  try {
    const sessionId = writeSession(home, [
      user("我每周三下午没课，固定去图书馆自习。"),
      assistant("好的。"),
    ]);
    const res = await runModelExtraction(home, sessionId, {
      modelRunner: async () => ({
        text: JSON.stringify({ facts: [{ subject: "自习", content: "我每周三下午没课", category: "about_you", evidenceQuote: "我每周三下午没课", validUntil: null }] }),
        usage: null,
      }),
    });
    expect(res.drafts.length).toBe(1);
    expect(res.drafts[0].content).toBe("我每周三下午没课");
    expect(res.spentUsd).toBeNull();
    expect(existsSync(join(home, MEMORY_PROPOSALS_FILE))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("模型抽取：没用户回合、没凭证、模型抛错都如实报原因", async () => {
  const home = tmpHome("nyra-facts-skip-");
  try {
    const empty = writeSession(home, [assistant("你好。")]);
    const noTurns = await runModelExtraction(home, empty, { modelRunner: async () => ({ text: "[]", usage: null }) });
    expect(noTurns.skippedReason).toBe("no-user-turns");
    expect(noTurns.drafts).toEqual([]);
    const sessionId = writeSession(home, [user("我喜欢用深色主题。")]);
    await withoutKey(async () => {
      const noCred = await runModelExtraction(home, sessionId, {});
      expect(noCred.skippedReason).toBe("no-credentials");
    });
    const failed = await runModelExtraction(home, sessionId, {
      modelRunner: async () => { throw new Error("fake model down"); },
    });
    expect(failed.skippedReason).toBe("model-failed");
  } finally {
    cleanup(home);
  }
});

test("模型抽取：月度上限已移除，本月花再多也不跳过，照常调模型", async () => {
  const home = tmpHome("nyra-facts-cap-");
  try {
    saveConfig(home, {
      monthly_cost_limit_usd: 0.1,
      pricing: { "deepseek-flash": { input_per_1m: 0.3, output_per_1m: 1.2 } },
    });
    const tracker = new UsageTracker();
    tracker.record({ usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 } });
    const snap = tracker.snapshot();
    const est = estimateCost(snap, resolvePricing(loadConfig(home).pricing, "deepseek-flash"), null);
    expect(est.spentUsd).not.toBeNull();
    new UsageLedger(home).recordDelta(snap, null, est.spentUsd, null, "deepseek-flash", new Date());
    const sessionId = writeSession(home, [user("我喜欢用深色主题。")]);
    let called = 0;
    const res = await runModelExtraction(home, sessionId, {
      modelRunner: async () => { called += 1; return { text: "[]", usage: null }; },
    });
    expect(res.skippedReason ?? null).toBeNull();
    expect(called).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("模型抽取记账：配了价目就如实记进当月账本", async () => {
  const home = tmpHome("nyra-facts-spend-");
  try {
    saveConfig(home, { pricing: { "deepseek-flash": { input_per_1m: 0.3, output_per_1m: 1.2 } } });
    const sessionId = writeSession(home, [user("我喜欢用深色主题。")]);
    await withFakeKey(async () => {
      const res = await runModelExtraction(home, sessionId, {
        modelRunner: async () => ({
          text: JSON.stringify({ facts: [{ subject: "偏好", content: "我喜欢用深色主题", category: "about_you", evidenceQuote: "我喜欢用深色主题" }] }),
          usage: { prompt_tokens: 100000, completion_tokens: 10000, total_tokens: 110000 },
        }),
      });
      expect(res.drafts.length).toBe(1);
      expect(res.spentUsd).not.toBeNull();
      expect(res.spentUsd!).toBeCloseTo(0.042, 9);
      const month = new UsageLedger(home).monthTotal(monthKeyString());
      expect(month.calls).toBeGreaterThanOrEqual(1);
      expect(month.spentUsd).toBeCloseTo(0.042, 9);
    });
  } finally {
    cleanup(home);
  }
});

// ---- 事实库：建库、取代、过期 ---------------------------------------------

test("事实建库：确认进库的记忆能查到，账本 0600", () => {
  const home = tmpHome("nyra-facts-store-");
  try {
    const fact = createSemanticFact(home, {
      subject: "偏好", content: "我喜欢用深色主题", category: "about_you",
      sourceSession: "s1", entryId: "memg_0123456789ab",
      evidenceQuotes: ["我喜欢用深色主题"], validUntil: null,
    }, { actor: "cli" });
    expect(fact).not.toBeNull();
    expect(fact!.id).toMatch(/^fact_[0-9a-f]{12}$/);
    expect(fact!.status).toBe("active");
    expect(existsSync(join(home, SEMANTIC_FACTS_FILE))).toBe(true);
    expectPerms(join(home, SEMANTIC_FACTS_FILE), 0o600);
    expect(listSemanticFacts(home).length).toBe(1);
    expect(getSemanticFact(home, fact!.id)?.fact.content).toBe("我喜欢用深色主题");
    expect(getSemanticFact(home, fact!.id)?.history.length).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("事实幂等：同一正文再建返回同一条，不重复", () => {
  const home = tmpHome("nyra-facts-idem-");
  try {
    const input = {
      subject: "偏好", content: "我喜欢用深色主题", category: "about_you" as const,
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我喜欢用深色主题"],
    };
    const a = createSemanticFact(home, input);
    const b = createSemanticFact(home, input);
    expect(a).not.toBeNull();
    expect(b?.id).toBe(a?.id);
    expect(listSemanticFacts(home).length).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("矛盾处理：同一主题不同正文，旧事实标被取代、新旧都能查", () => {
  const home = tmpHome("nyra-facts-super-");
  try {
    const old = createSemanticFact(home, {
      subject: "套餐", content: "我用的是基础版套餐", category: "work",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我用的是基础版套餐"],
    });
    const activeBefore = listSemanticFacts(home);
    expect(findFactContradictions(activeBefore)).toEqual([]);
    const next = createSemanticFact(home, {
      subject: "套餐", content: "我用的是专业版套餐", category: "work",
      sourceSession: "s2", entryId: null, evidenceQuotes: ["我用的是专业版套餐"],
    });
    expect(next).not.toBeNull();
    expect(next!.supersedes).toBe(old!.id);
    const live = listSemanticFacts(home);
    expect(live.length).toBe(1);
    expect(live[0].id).toBe(next!.id);
    const all = listSemanticFacts(home, { includeSuperseded: true });
    expect(all.length).toBe(2);
    expect(all.find((f) => f.id === old!.id)?.status).toBe("superseded");
    expect(all.find((f) => f.id === old!.id)?.supersededBy).toBe(next!.id);
    expect(getSemanticFact(home, old!.id)?.history.length).toBe(2);
  } finally {
    cleanup(home);
  }
});

test("矛盾检测：同一主题多个不同正文的生效事实算一组矛盾", () => {
  const home = tmpHome("nyra-facts-contra-");
  try {
    createSemanticFact(home, {
      subject: "套餐", content: "我用的是基础版套餐", category: "work",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我用的是基础版套餐"],
    });
    // 直接建第二条不同正文但同一主题的事实（绕过取代，只为测检测函数）：
    // 用 createSemanticFact 会取代第一条，所以这里先测取代前的状态。
    const facts = listSemanticFacts(home);
    expect(findFactContradictions(facts)).toEqual([]);
    expect(findFactContradictions([
      { ...facts[0], id: "fact_000000000001" },
      { ...facts[0], id: "fact_000000000002", content: "我用的是专业版套餐" },
      { ...facts[0], id: "fact_000000000003", subject: "别的主题", content: "我用的是专业版套餐" },
    ]).length).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("过期清扫：到期事实标过期，不过期的不动", () => {
  const home = tmpHome("nyra-facts-expire-");
  try {
    const past = createSemanticFact(home, {
      subject: "套餐", content: "这个月在用试用套餐", category: "work",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["这个月在用试用套餐"], validUntil: "2020-01-01",
    });
    const live = createSemanticFact(home, {
      subject: "偏好", content: "我喜欢用深色主题", category: "about_you",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我喜欢用深色主题"], validUntil: "2099-01-01",
    });
    expect(isFactExpired(past!)).toBe(true);
    expect(isFactExpired(live!)).toBe(false);
    // 读时惰性过期：默认列表里看不到已到期的那条。
    expect(listSemanticFacts(home).map((f) => f.id)).toEqual([live!.id]);
    const { expired } = expireStaleFacts(home);
    expect(expired).toEqual([past!.id]);
    expect(getSemanticFact(home, past!.id)?.fact.status).toBe("expired");
    expect(expireStaleFacts(home).expired).toEqual([]);
  } finally {
    cleanup(home);
  }
});

// ---- 检索与提示词段 ---------------------------------------------------------

test("事实检索：BM25 命中相关事实，格式附来源与有效期", () => {
  const home = tmpHome("nyra-facts-search-");
  try {
    createSemanticFact(home, {
      subject: "套餐", content: "我用的是专业版套餐", category: "work",
      sourceSession: "s1", entryId: "memg_0123456789ab", evidenceQuotes: ["我用的是专业版套餐"], validUntil: "2026-12-31",
    });
    createSemanticFact(home, {
      subject: "偏好", content: "我喜欢用深色主题", category: "about_you",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我喜欢用深色主题"],
    });
    const hits = searchSemanticFacts(home, "套餐");
    expect(hits.length).toBe(1);
    expect(hits[0].fact.subject).toBe("套餐");
    const formatted = formatSemanticFactResults(hits);
    expect(formatted).toContain(hits[0].fact.id);
    expect(formatted).toContain("2026-12-31");
    expect(formatted).toContain("memg_0123456789ab");
    expect(searchSemanticFacts(home, "火星探测器着陆")).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("事实提示词段：没事实返回空，有事实附 id 与来源且截断", () => {
  const home = tmpHome("nyra-facts-section-");
  try {
    expect(buildSemanticFactsSection(home, "套餐")).toBe("");
    for (let i = 0; i < 6; i++) {
      createSemanticFact(home, {
        subject: `测试主题${i}`, content: `测试事实${i}：` + "我用的是专业版套餐，测试内容填充。".repeat(8), category: "work",
        sourceSession: "s1", entryId: null, evidenceQuotes: ["我用的是专业版套餐"],
      });
    }
    const section = buildSemanticFactsSection(home, "测试");
    expect(section).toContain("语义事实");
    expect(section).toContain("fact_");
    expect(section.length).toBeLessThanOrEqual(1000 + "…（已截断）".length + 1);
    expect(section).toContain("…（已截断）");
  } finally {
    cleanup(home);
  }
});

// ---- 确认链路：候选确认进库同时建事实 --------------------------------------

test("确认链路：候选确认进库同时建事实，同主题再确认旧事实被取代", () => {
  const home = tmpHome("nyra-facts-approve-");
  try {
    const sessionId = writeSession(home, [user("请记住，我的指导老师是梅小龙。"), assistant("记下了。")]);
    const res = extractMemoryProposals(home, sessionId);
    expect(res.added).toBeGreaterThanOrEqual(1);
    const proposal = listMemoryProposals(home, { status: "pending" })[0];
    const approved = approveMemoryProposal(home, proposal.id, {});
    expect(approved.entryId).not.toBeNull();
    const facts = listSemanticFacts(home);
    expect(facts.length).toBe(1);
    expect(facts[0].entryId).toBe(approved.entryId);
    expect(facts[0].content).toBe(proposal.content);
    const entries = listMemoryGateEntries(home, { status: "confirmed" });
    expect(entries.length).toBe(1);
    // 同一主题、不同正文再确认一条：旧事实被取代。
    const queued = addProposalDrafts(home, sessionId, [{
      category: proposal.category,
      subject: proposal.subject,
      content: "我的指导老师是王大明",
      evidenceQuotes: ["我的指导老师是王大明"],
      evidenceSource: "我的指导老师是王大明。",
    }]);
    expect(queued.added).toBe(1);
    const second = listMemoryProposals(home, { status: "pending" }).find((p) => p.content === "我的指导老师是王大明");
    expect(second).toBeDefined();
    approveMemoryProposal(home, second!.id, {});
    const live = listSemanticFacts(home);
    expect(live.length).toBe(1);
    expect(live[0].content).toBe("我的指导老师是王大明");
    const all = listSemanticFacts(home, { includeSuperseded: true });
    expect(all.length).toBe(2);
    expect(all.find((f) => f.content === proposal.content)?.status).toBe("superseded");
  } finally {
    cleanup(home);
  }
});

// ---- 做梦集成 ---------------------------------------------------------------

test("做梦集成：开关开时模型抽取进队列并计数，开关关时不跑", async () => {
  const factRunner = async () => ({
    text: JSON.stringify({ facts: [{ subject: "自习", content: "我每周三下午没课", category: "about_you", evidenceQuote: "我每周三下午没课", validUntil: null }] }),
    usage: null,
  });
  // 默认关：factRunner 一次也不调。
  const homeOff = tmpHome("nyra-facts-dream-off-");
  try {
    writeSession(homeOff, [
      user("请记住，我喜欢用深色主题。"),
      user("我每周三下午没课，固定去图书馆自习。"),
      assistant("好的。"),
    ]);
    let calls = 0;
    const counting = async () => { calls += 1; return factRunner(); };
    const off = await runDreamMetabolism(homeOff, { factRunner: counting });
    expect(off.counts.facts_added).toBe(0);
    expect(calls).toBe(0);
  } finally {
    cleanup(homeOff);
  }
  // 打开开关：抽取进队列，计数 +1，小结有事实行。
  // 注意：做梦只扫上次运行以来有更新的会话，所以开关开的那次跑在另一个
  // 新 home 上（会话是新写的），不能复用上面已扫过会话的 home。
  const homeOn = tmpHome("nyra-facts-dream-on-");
  try {
    writeSession(homeOn, [
      user("请记住，我喜欢用深色主题。"),
      user("我每周三下午没课，固定去图书馆自习。"),
      assistant("好的。"),
    ]);
    saveConfig(homeOn, { semantic_facts: { enabled: true, max_per_session: 5 } });
    let calls = 0;
    const counting = async () => { calls += 1; return factRunner(); };
    const on = await runDreamMetabolism(homeOn, { factRunner: counting });
    expect(on.counts.facts_added).toBe(1);
    expect(calls).toBe(1);
    expect(on.summary.some((l) => l.includes("语义事实候选 1 条"))).toBe(true);
    const pending = listMemoryProposals(homeOn, { status: "pending" });
    expect(pending.some((p) => p.content === "我每周三下午没课")).toBe(true);
    expect(existsSync(join(homeOn, "MEMORY.md"))).toBe(false);
  } finally {
    cleanup(homeOn);
  }
});

test("做梦集成：过期事实在做梦里被清扫并计数", async () => {
  const home = tmpHome("nyra-facts-dream-expire-");
  try {
    createSemanticFact(home, {
      subject: "套餐", content: "这个月在用试用套餐", category: "work",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["这个月在用试用套餐"], validUntil: "2020-01-01",
    });
    const result = await runDreamMetabolism(home);
    expect(result.counts.facts_expired).toBe(1);
    expect(result.summary.some((l) => l.includes("到期失效"))).toBe(true);
  } finally {
    cleanup(home);
  }
});

// ---- CLI --------------------------------------------------------------------

test("facts 命令：list/show/search/expire 全程", async () => {
  const home = tmpHome("nyra-facts-cli-");
  try {
    const old = createSemanticFact(home, {
      subject: "套餐", content: "我用的是基础版套餐", category: "work",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我用的是基础版套餐"],
    });
    const next = createSemanticFact(home, {
      subject: "套餐", content: "我用的是专业版套餐", category: "work",
      sourceSession: "s2", entryId: null, evidenceQuotes: ["我用的是专业版套餐"],
    });
    const cap = captureOutput();
    try {
      expect(await handleSemanticFacts(["list"], home)).toBe(0);
      expect(cap.out).toContain("我用的是专业版套餐");
      expect(cap.out).not.toContain("我用的是基础版套餐");
      expect(await handleSemanticFacts(["list", "--all"], home)).toBe(0);
      expect(cap.out).toContain("我用的是基础版套餐");
      expect(await handleSemanticFacts(["show", old!.id], home)).toBe(0);
      expect(cap.out).toContain("已被取代");
      expect(cap.out).toContain(next!.id);
      expect(await handleSemanticFacts(["search", "套餐"], home)).toBe(0);
      expect(cap.out).toContain("我用的是专业版套餐");
      expect(await handleSemanticFacts(["expire"], home)).toBe(0);
      expect(cap.out).toContain("没有到期的语义事实");
      expect(await handleSemanticFacts(["show", "fact_000000000000"], home)).toBe(2);
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("dream 命令：set 存语义事实开关，status 显示开关与事实数", async () => {
  const home = tmpHome("nyra-facts-dream-cli-");
  try {
    createSemanticFact(home, {
      subject: "偏好", content: "我喜欢用深色主题", category: "about_you",
      sourceSession: "s1", entryId: null, evidenceQuotes: ["我喜欢用深色主题"],
    });
    const cap = captureOutput();
    try {
      expect(await handleDream(["set", "--semantic-facts", "true", "--semantic-facts-max", "3"], home)).toBe(0);
      const cfg = semanticFactsConfig(loadConfig(home));
      expect(cfg.enabled).toBe(true);
      expect(cfg.maxPerSession).toBe(3);
      expect(await handleDream(["status"], home)).toBe(0);
      expect(cap.out).toContain("语义事实抽取：开");
      expect(cap.out).toContain("生效中的语义事实：1 条");
      expect(await handleDream(["set", "--semantic-facts-max", "99"], home)).toBe(2);
      expect(await handleDream(["set", "--semantic-facts", "maybe"], home)).toBe(2);
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("extract 命令：--model 没凭证时如实报原因，不崩", async () => {
  const home = tmpHome("nyra-facts-extract-cli-");
  try {
    const sessionId = writeSession(home, [user("请记住，我喜欢用深色主题。"), assistant("记下了。")]);
    const cap = captureOutput();
    try {
      await withoutKey(async () => {
        expect(await handleMemoryProposals(["extract", sessionId, "--model"], home)).toBe(0);
      });
      expect(cap.out).toContain("模型抽取没跑：no-credentials");
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});
