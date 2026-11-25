// tests/node/test-hermes-h3h4h7.test.ts — Hermes/TalosBrain 借鉴 H3/H4/H7。
// H3 夜间做梦代谢（默认关，确定性提炼 + 剪枝 + 简报小结）、H4 免疫体检
// （nyra doctor --deep，7 项自检，不合格隔离不删除）、H7 最小稳定契约
// nyra-contract-v1（10 条命令，走 MCP 与 A2A 复用同一契约）。
// 只在临时 home 上跑，不碰真记忆、不调真模型（模型润色用注入的假 runner）。
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { newSessionId, saveSession } from "../../src/memory.ts";
import {
  dreamConfig, isDreamDue, readDreamState, runDreamMetabolism, dreamBriefLines,
  DREAM_STATE_FILE, DREAM_RUNS_FILE,
} from "../../src/dream.ts";
import { handleDream } from "../../src/dreamCli.ts";
import { runImmuneChecks, IMMUNE_REPORT_FILE, QUARANTINE_DIR } from "../../src/immune.ts";
import { runDoctor } from "../../src/doctor.ts";
import { collectMorningBrief, renderBriefingText } from "../../src/briefing.ts";
import {
  AGENT_CONTRACT_COMMANDS, NYRA_CONTRACT_ID, NYRA_CONTRACT_VERSION,
  agentContract, validateAgentContract,
} from "../../src/agentContract.ts";
import { MCP_SERVER_TOOLS, handleMcpServer } from "../../src/mcp.ts";
import { buildA2aAgentCard } from "../../src/a2a.ts";
import { SUBCOMMANDS } from "../../src/subcommands.ts";
import {
  rememberMemoryEntry, updateMemoryEntry, listMemoryGateEntries,
  listGateRejections, MEMORY_GATE_ENTRIES_FILE,
} from "../../src/memoryGate.ts";
import { MEMORY_PROPOSALS_FILE } from "../../src/memoryProposals.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import { findUnknownFlag, SUBCOMMAND_FLAGS } from "../../src/cliTypos.ts";

const USER_TEXT = "请记住，我是铜陵职业技术学院工业机器人技术专业的学生，指导老师是梅小龙";

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

/** 临时给一个假 Key（只改 env，不落盘），用完原样恢复。 */
function withFakeKey(fn: () => void | Promise<void>): void | Promise<void> {
  const orig = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-test-fake-key-for-dream-test-only";
  const done = fn();
  const restore = () => {
    if (orig === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = orig;
  };
  if (done instanceof Promise) return done.finally(restore);
  restore();
}

function writeSessionWithRemember(home: string, text: string): string {
  const id = newSessionId();
  saveSession(id, [
    { role: "user", content: text },
    { role: "assistant", content: "记下了。" },
  ], home);
  return id;
}

function confirmedEntry(home: string, subject: string, content: string, quote: string, now?: Date) {
  return rememberMemoryEntry(home, {
    scope: "user", subject, content, sourceRefs: ["MEMORY.md"],
    status: "confirmed", evidenceQuotes: [quote],
  }, `${quote}。${content}`, { actor: "cli", now });
}

// ---- H3：配置与到点判断 ----------------------------------------------

test("H3 做梦配置：默认全关，脏配置回默认值", () => {
  const d0 = dreamConfig({});
  expect(d0.enabled).toBe(false);
  expect(d0.at).toBe("03:00");
  expect(d0.summarizeWithModel).toBe(false);
  expect(d0.pruneStaleDays).toBe(90);
  const d1 = dreamConfig({ dream: { enabled: "yes", at: "25:99", summarize_with_model: 1, prune_stale_days: -5 } });
  expect(d1.enabled).toBe(false);
  expect(d1.at).toBe("03:00");
  expect(d1.summarizeWithModel).toBe(false);
  expect(d1.pruneStaleDays).toBe(90);
  const d2 = dreamConfig({ dream: { enabled: true, at: "02:30", summarize_with_model: true, prune_stale_days: 30 } });
  expect(d2.enabled).toBe(true);
  expect(d2.at).toBe("02:30");
  expect(d2.summarizeWithModel).toBe(true);
  expect(d2.pruneStaleDays).toBe(30);
});

test("H3 到点判断：关着不跑、没到点不跑、到了跑过今天不再跑", () => {
  const off = { enabled: false, at: "03:00", summarizeWithModel: false, pruneStaleDays: 90 };
  const on = { ...off, enabled: true };
  const before = new Date("2026-11-25T02:00:00");
  const after = new Date("2026-11-25T04:00:00");
  expect(isDreamDue(off, null, after)).toBe(false);
  expect(isDreamDue(on, null, before)).toBe(false);
  expect(isDreamDue(on, null, after)).toBe(true);
  const ranToday = { last_run_at: "2026-11-25T03:05:00.000Z", last_run_ok: true, last_summary: [], last_counts: { sessions_scanned: 0, proposals_added: 0, duplicates_pruned: 0, stale_rejected: 0, contradictions: 0, pending_total: 0 } };
  expect(isDreamDue(on, ranToday, after)).toBe(false);
  const ranYesterday = { ...ranToday, last_run_at: "2026-11-24T03:05:00.000Z" };
  expect(isDreamDue(on, ranYesterday, after)).toBe(true);
});

// ---- H3：提炼、剪枝、矛盾 --------------------------------------------

test("H3 做梦提炼：会话里的记住进待审队列，不写记忆", async () => {
  const home = tmpHome("nyra-dream-extract-");
  try {
    writeSessionWithRemember(home, "请记住，我喜欢用深色主题。");
    const result = await runDreamMetabolism(home);
    expect(result.ran).toBe(true);
    expect(result.counts.sessions_scanned).toBe(1);
    expect(result.counts.proposals_added).toBeGreaterThanOrEqual(1);
    expect(result.modelSummary).toBeNull();
    const proposals = JSON.parse(readFileSync(join(home, MEMORY_PROPOSALS_FILE), "utf-8")) as Array<Record<string, unknown>>;
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals.every((p) => p.status === "pending")).toBe(true);
    expect(existsSync(join(home, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(home, DREAM_STATE_FILE))).toBe(true);
    expect(existsSync(join(home, DREAM_RUNS_FILE))).toBe(true);
    expectPerms(join(home, DREAM_STATE_FILE), 0o600);
  } finally {
    cleanup(home);
  }
});

test("H3 做梦剪枝重复：同正文只留最新一条，旧的标删除", async () => {
  const home = tmpHome("nyra-dream-dedupe-");
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const oldEntry = confirmedEntry(home, "偏好", "我喜欢用深色主题", "我喜欢用深色主题", twoHoursAgo);
    const newEntry = confirmedEntry(home, "偏好", "我喜欢用深色主题", "我喜欢用深色主题");
    const result = await runDreamMetabolism(home);
    expect(result.counts.duplicates_pruned).toBe(1);
    expect(result.prunedIds).toContain(oldEntry.id);
    const live = listMemoryGateEntries(home);
    expect(live.length).toBe(1);
    expect(live[0].id).toBe(newEntry.id);
    const all = listMemoryGateEntries(home, { includeDeleted: true });
    expect(all.find((e) => e.id === oldEntry.id)?.status).toBe("deleted");
  } finally {
    cleanup(home);
  }
});

test("H3 做梦清过期：100 天未决的候选清掉，拒绝账本记做梦原因码", async () => {
  const home = tmpHome("nyra-dream-stale-");
  try {
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    const proposals = [{
      id: "memp_abcdef123456", scope: "user", category: "about_you", subject: "偏好",
      content: "我喜欢用深色主题", evidenceQuotes: ["我喜欢用深色主题"],
      evidenceSource: "我喜欢用深色主题。", sourceSession: "20261101-000000-0000",
      status: "pending", createdAt: old, decidedAt: null, decisionReason: null, entryId: null,
    }];
    writeFileSync(join(home, MEMORY_PROPOSALS_FILE), JSON.stringify(proposals), { mode: 0o600 });
    const result = await runDreamMetabolism(home);
    expect(result.counts.stale_rejected).toBe(1);
    expect(result.staleIds).toContain("memp_abcdef123456");
    const after = JSON.parse(readFileSync(join(home, MEMORY_PROPOSALS_FILE), "utf-8")) as Array<Record<string, unknown>>;
    expect(after[0].status).toBe("rejected");
    expect(after[0].decisionReason).toBe("dream-pruned-stale");
    const rejections = listGateRejections(home, 5);
    expect(rejections.some((r) => r.reason === "dream-pruned-stale")).toBe(true);
    expect(rejections.some((r) => typeof r.detail === "string" && r.detail.includes("用户拒绝了"))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("H3 矛盾只上报：同主题不同说法不自动删", async () => {
  const home = tmpHome("nyra-dream-conflict-");
  try {
    confirmedEntry(home, "偏好", "我喜欢用深色主题", "我喜欢用深色主题");
    confirmedEntry(home, "偏好", "我喜欢用浅色主题", "我喜欢用浅色主题");
    const result = await runDreamMetabolism(home);
    expect(result.counts.contradictions).toBe(1);
    expect(result.contradictions).toContain("偏好");
    expect(listMemoryGateEntries(home).length).toBe(2);
    expect(result.summary.join("\n")).toContain("等你定");
  } finally {
    cleanup(home);
  }
});

// ---- H3：简报与模型润色 ----------------------------------------------

test("H3 简报小结：做梦后简报多一节，没做梦不写这一节", async () => {
  const home = tmpHome("nyra-dream-brief-");
  try {
    writeSessionWithRemember(home, "请记住，我喜欢用深色主题。");
    await runDreamMetabolism(home);
    const brief = collectMorningBrief(home);
    expect(brief.dream?.length).toBeGreaterThan(0);
    expect(brief.quiet).toBe(false);
    const text = renderBriefingText({ ...brief, text: "", savedPath: null });
    expect(text).toContain("昨夜做梦小结");
    // 没做梦的 home：简报没有这一节。
    const home2 = tmpHome("nyra-dream-brief2-");
    try {
      const brief2 = collectMorningBrief(home2);
      expect(brief2.dream ?? []).toEqual([]);
      const text2 = renderBriefingText({ ...brief2, text: "", savedPath: null });
      expect(text2).not.toContain("昨夜做梦小结");
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

test("H3 模型润色：默认不开；假 runner 跑通；假 runner 抛错回落确定性小结", async () => {
  const home = tmpHome("nyra-dream-model-");
  try {
    writeSessionWithRemember(home, "请记住，我喜欢用深色主题。");
    // 默认不开。
    const plain = await runDreamMetabolism(home);
    expect(plain.modelSummary).toBeNull();
    expect(plain.modelSummarySkipped).toBeUndefined();
    // 没凭据时 --with-model 也跑不成模型。
    const noCred = await runDreamMetabolism(home, { withModel: true });
    expect(noCred.modelSummary).toBeNull();
    expect(noCred.modelSummarySkipped).toBe("no-credentials");
    // 有假凭据 + 假 runner：跑通。
    await withFakeKey(async () => {
      const polished = await runDreamMetabolism(home, {
        withModel: true,
        modelRunner: async () => ({ text: "昨夜提炼出一条新候选，等你确认。", usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
      });
      expect(polished.modelSummary).toBe("昨夜提炼出一条新候选，等你确认。");
      expect(polished.summary).toEqual(["昨夜提炼出一条新候选，等你确认。"]);
      // 假 runner 抛错：回落确定性小结。
      const failed = await runDreamMetabolism(home, {
        withModel: true,
        modelRunner: async () => { throw new Error("fake model down"); },
      });
      expect(failed.modelSummary).toBeNull();
      expect(failed.modelSummarySkipped).toBe("model-failed");
      expect(failed.summary.length).toBeGreaterThan(0);
    });
  } finally {
    cleanup(home);
  }
});

test("H3 模型润色记账：配了价目就如实记进当月账本", async () => {
  const home = tmpHome("nyra-dream-spend-");
  try {
    writeSessionWithRemember(home, "请记住，我喜欢用深色主题。");
    saveConfig(home, { pricing: { "deepseek-flash": { input_per_1m: 0.3, output_per_1m: 1.2 } } });
    await withFakeKey(async () => {
      const result = await runDreamMetabolism(home, {
        withModel: true,
        modelRunner: async () => ({ text: "小结。", usage: { prompt_tokens: 100000, completion_tokens: 10000, total_tokens: 110000 } }),
      });
      expect(result.modelSummary).toBe("小结。");
      expect(result.spentUsd).not.toBeNull();
      expect(result.spentUsd!).toBeCloseTo(0.042, 9);
      const month = new UsageLedger(home).monthTotal(monthKeyString());
      expect(month.calls).toBeGreaterThanOrEqual(1);
      expect(month.spentUsd).toBeCloseTo(0.042, 9);
    });
  } finally {
    cleanup(home);
  }
});

// ---- H3：CLI -----------------------------------------------------------

test("H3 dream 命令：status/enable/disable/set/run", async () => {
  const home = tmpHome("nyra-dream-cli-");
  try {
    const cap = captureOutput();
    try {
      expect(await handleDream(["status"], home)).toBe(0);
      expect(cap.out).toContain("关（默认）");
      expect(await handleDream(["enable"], home)).toBe(0);
      expect(dreamConfig(loadConfig(home)).enabled).toBe(true);
      expect(await handleDream(["set", "--at", "25:99"], home)).toBe(2);
      expect(await handleDream(["set", "--at", "02:30", "--prune-stale-days", "30"], home)).toBe(0);
      const cfg = dreamConfig(loadConfig(home));
      expect(cfg.at).toBe("02:30");
      expect(cfg.pruneStaleDays).toBe(30);
      writeSessionWithRemember(home, "请记住，我喜欢用深色主题。");
      expect(await handleDream(["run"], home)).toBe(0);
      expect(cap.out).toContain("提炼出");
      expect(await handleDream(["disable"], home)).toBe(0);
      expect(dreamConfig(loadConfig(home)).enabled).toBe(false);
      expect(await handleDream(["bogus"], home)).toBe(2);
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("H3 dream 在子命令清单里", () => {
  expect(SUBCOMMANDS).toContain("dream");
});

test("H4/H3 打错字拦截：doctor --deep 与 dream 的选项都放行", () => {
  expect(findUnknownFlag(["--deep"], SUBCOMMAND_FLAGS.doctor.value, SUBCOMMAND_FLAGS.doctor.bool)).toBeNull();
  expect(findUnknownFlag(["--provider", "deepseek", "--deep"], SUBCOMMAND_FLAGS.doctor.value, SUBCOMMAND_FLAGS.doctor.bool)).toBeNull();
  expect(findUnknownFlag(["run", "--with-model"], SUBCOMMAND_FLAGS.dream.value, SUBCOMMAND_FLAGS.dream.bool)).toBeNull();
  expect(findUnknownFlag(["set", "--at", "02:30", "--summarize-with-model", "true"], SUBCOMMAND_FLAGS.dream.value, SUBCOMMAND_FLAGS.dream.bool)).toBeNull();
  expect(findUnknownFlag(["--deeep"], SUBCOMMAND_FLAGS.doctor.value, SUBCOMMAND_FLAGS.doctor.bool)).not.toBeNull();
});

// ---- H4：免疫体检 -------------------------------------------------------

test("H4 干净 home：7 项全过，报告 0600", () => {
  const home = tmpHome("nyra-immune-clean-");
  try {
    const report = runImmuneChecks(home);
    expect(report.checks.length).toBe(7);
    expect(report.checks.map((c) => c.id)).toEqual([
      "memory-evidence", "skills-parseable", "config-valid",
      "secrets-plaintext", "ledgers-parseable", "cost-moat", "permission-moat",
    ]);
    expect(report.allOk).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(existsSync(join(home, IMMUNE_REPORT_FILE))).toBe(true);
    expectPerms(join(home, IMMUNE_REPORT_FILE), 0o600);
    expect(report.checks.map((c) => c.moat).sort()).toEqual(
      ["cost", "evidence", "evidence", "evidence", "permission", "permission", "permission"].sort(),
    );
  } finally {
    cleanup(home);
  }
});

test("H4 坏技能文件：解析失败进隔离区，不删除", () => {
  const home = tmpHome("nyra-immune-skill-");
  try {
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "broken.md"), "没有 frontmatter 也没有名字行，随便写点\n", "utf-8");
    writeFileSync(join(home, "skills", "good.md"), "---\nname: good\n---\n# 好技能\n", "utf-8");
    const report = runImmuneChecks(home);
    const check = report.checks.find((c) => c.id === "skills-parseable")!;
    expect(check.ok).toBe(false);
    expect(report.allOk).toBe(false);
    expect(existsSync(join(home, "skills", "broken.md"))).toBe(false);
    expect(existsSync(join(home, "skills", "good.md"))).toBe(true);
    const q = readdirSync(join(home, QUARANTINE_DIR));
    expect(q.some((f) => f.includes("broken.md"))).toBe(true);
    expect(report.quarantined.some((i) => i.kind === "file" && i.name.includes("broken.md"))).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("H4 证据坏的记忆条目：隔离（快照 + 标删除），不直接删文件", () => {
  const home = tmpHome("nyra-immune-evidence-");
  try {
    const row = {
      id: "memg_abcdef123456", scope: "user", projectId: null, orgId: null,
      subject: "坏证据", content: "这条的证据是空的", sourceRefs: [],
      status: "confirmed", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      evidenceQuotes: [], prevContent: null, actor: "cli",
    };
    writeFileSync(join(home, MEMORY_GATE_ENTRIES_FILE), JSON.stringify(row) + "\n", { mode: 0o600 });
    const report = runImmuneChecks(home);
    const check = report.checks.find((c) => c.id === "memory-evidence")!;
    expect(check.ok).toBe(false);
    const after = listMemoryGateEntries(home, { includeDeleted: true });
    expect(after.find((e) => e.id === "memg_abcdef123456")?.status).toBe("deleted");
    const q = readdirSync(join(home, QUARANTINE_DIR));
    expect(q.some((f) => f.includes("memg_abcdef123456"))).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("H4 坏账本与坏配置：解析失败进隔离区", () => {
  const home = tmpHome("nyra-immune-ledger-");
  try {
    writeFileSync(join(home, "schedule.json"), "{ broken json", "utf-8");
    writeFileSync(join(home, "config.json"), "{ broken json", "utf-8");
    const report = runImmuneChecks(home);
    expect(report.checks.find((c) => c.id === "ledgers-parseable")!.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "config-valid")!.ok).toBe(false);
    expect(existsSync(join(home, "schedule.json"))).toBe(false);
    // 坏 config.json 已进隔离区；但后面的成本检查调 loadConfig 时会重建一份
    // 默认 config.json——这是 loadConfig 的既有行为，隔离区里的原件才是证据。
    const q = readdirSync(join(home, QUARANTINE_DIR));
    expect(q.some((f) => f.includes("schedule.json"))).toBe(true);
    expect(q.some((f) => f.includes("config.json"))).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("H4 密钥明文：只报种类名与文件，绝不回显密钥原文", () => {
  const home = tmpHome("nyra-immune-secret-");
  try {
    const fakeKey = "sk-abcdefgh12345678";
    saveConfig(home, { note: `测试密钥 ${fakeKey}` });
    const report = runImmuneChecks(home);
    const check = report.checks.find((c) => c.id === "secrets-plaintext")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("config.json");
    expect(JSON.stringify(report)).not.toContain(fakeKey);
    // 记忆条目含密钥：条目隔离。
    const home2 = tmpHome("nyra-immune-secret2-");
    try {
      const row = {
        id: "memg_abcdef123457", scope: "user", projectId: null, orgId: null,
        subject: "脏条目", content: `密钥是 ${fakeKey} 别用`, sourceRefs: [],
        status: "confirmed", revision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        evidenceQuotes: ["密钥是"], prevContent: null, actor: "cli",
      };
      writeFileSync(join(home2, MEMORY_GATE_ENTRIES_FILE), JSON.stringify(row) + "\n", { mode: 0o600 });
      const report2 = runImmuneChecks(home2);
      expect(report2.checks.find((c) => c.id === "secrets-plaintext")!.ok).toBe(false);
      expect(listMemoryGateEntries(home2, { includeDeleted: true }).find((e) => e.id === "memg_abcdef123457")?.status).toBe("deleted");
      expect(JSON.stringify(report2)).not.toContain(fakeKey);
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

test("H4 权限位与成本配置：太松报失败，坏上限报失败", () => {
  const home = tmpHome("nyra-immune-perm-");
  try {
    const entry = confirmedEntry(home, "学籍", "铜陵职业技术学院", "铜陵职业技术学院");
    void entry;
    if (process.platform !== "win32") {
      chmodSync(join(home, MEMORY_GATE_ENTRIES_FILE), 0o644);
      const report = runImmuneChecks(home);
      expect(report.checks.find((c) => c.id === "permission-moat")!.ok).toBe(false);
      expect(report.checks.find((c) => c.id === "permission-moat")!.detail).toContain("644");
    }
    saveConfig(home, { max_cost_usd: "not-a-number" });
    const report2 = runImmuneChecks(home);
    expect(report2.checks.find((c) => c.id === "cost-moat")!.ok).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("H4 doctor --deep 追加 7 项免疫检查，不加 --deep 没有", async () => {
  const home = tmpHome("nyra-immune-doctor-");
  try {
    const fetchFn = (async () => ({ status: 200 })) as unknown as typeof fetch;
    const deep = await runDoctor({ home, deep: true, fetchFn });
    const immune = deep.checks.filter((c) => c.name.startsWith("免疫体检："));
    expect(immune.length).toBe(7);
    expect(immune.every((c) => c.ok)).toBe(true);
    const plain = await runDoctor({ home, fetchFn });
    expect(plain.checks.some((c) => c.name.startsWith("免疫体检"))).toBe(false);
    expect(plain.checks.length).toBe(deep.checks.length - 7);
  } finally {
    cleanup(home);
  }
});

// ---- H7：最小稳定契约 ---------------------------------------------------

test("H7 契约自检 0 问题：10 条命令，id 里带版本号", () => {
  expect(NYRA_CONTRACT_ID).toBe("nyra-contract-v1");
  expect(NYRA_CONTRACT_VERSION).toBe("1");
  expect(AGENT_CONTRACT_COMMANDS.length).toBe(10);
  expect(validateAgentContract()).toEqual([]);
  const names = AGENT_CONTRACT_COMMANDS.map((c) => c.name);
  expect(names).toEqual(["ping", "ask", "recall", "remember", "forget", "tasks", "skills", "status", "delegate", "handoff"]);
  expect(agentContract().id).toBe("nyra-contract-v1");
  expect(agentContract().commands.length).toBe(10);
});

test("H7 契约映射真实存在：MCP 工具名与 A2A 方法名都不是编的", () => {
  const mcpNames = new Set(MCP_SERVER_TOOLS.map((t) => t.name));
  const a2aMethods = new Set(["agent/card", "message/send", "message/stream", "tasks/get", "tasks/cancel", "tasks/list", "tasks/resubscribe"]);
  for (const cmd of AGENT_CONTRACT_COMMANDS) {
    if (cmd.mcpTool) expect(mcpNames.has(cmd.mcpTool)).toBe(true);
    if (cmd.a2aMethod) expect(a2aMethods.has(cmd.a2aMethod)).toBe(true);
  }
  // 6 个 MCP 工具全在契约里（ask/recall/remember/forget/tasks/delegate）。
  const mapped = new Set(AGENT_CONTRACT_COMMANDS.map((c) => c.mcpTool).filter(Boolean));
  expect(mapped.size).toBe(6);
  expect([...mapped].sort()).toEqual([...mcpNames].sort());
});

test("H7 工具总数不变：MCP 对外工具仍是 6 个", () => {
  expect(MCP_SERVER_TOOLS.length).toBe(6);
});

test("H7 nyra mcp contract 输出含 id 与 10 个命令名", async () => {
  const home = tmpHome("nyra-contract-cli-");
  try {
    const cap = captureOutput();
    try {
      expect(await handleMcpServer(["contract"], home)).toBe(0);
      expect(cap.out).toContain("nyra-contract-v1");
      for (const cmd of AGENT_CONTRACT_COMMANDS) {
        expect(cap.out).toContain(cmd.name);
      }
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});

test("H7 A2A agent 卡片带 contract 字段，10 条命令", () => {
  const home = tmpHome("nyra-contract-card-");
  try {
    const config = loadConfig(home);
    const card = buildA2aAgentCard(home, config, "http://127.0.0.1:8767");
    const contract = card.contract as Record<string, unknown>;
    expect(contract.id).toBe("nyra-contract-v1");
    expect(contract.version).toBe("1");
    expect((contract.commands as unknown[]).length).toBe(10);
  } finally {
    cleanup(home);
  }
});

// ---- 记忆门回归：只删不改 ----------------------------------------------

test("记忆门回归：只删不改不需新依据，改正文仍需依据、改入密钥仍拒绝", () => {
  const home = tmpHome("nyra-memgate-delete-");
  try {
    const entry = confirmedEntry(home, "学籍", "铜陵职业技术学院", "铜陵职业技术学院");
    // 只删不改：不传 evidenceQuotes 也能删。
    const deleted = updateMemoryEntry(home, entry.id, { status: "deleted" }, null, { actor: "immune", checkVerbatim: false });
    expect(deleted.status).toBe("deleted");
    // 改正文：不附依据仍拒绝。
    const entry2 = confirmedEntry(home, "学籍", "铜陵职业技术学院", "铜陵职业技术学院");
    expect(() => updateMemoryEntry(home, entry2.id, { content: "改后的正文" }, USER_TEXT, { actor: "cli" })).toThrow();
    // 改入密钥：仍拒绝。
    expect(() => updateMemoryEntry(home, entry2.id, {
      content: "密钥是 sk-abcdefgh12345678", evidenceQuotes: ["铜陵职业技术学院"],
    }, USER_TEXT, { actor: "cli" })).toThrow("疑似密钥");
    // 只删不改但条目含密钥：也能删（删不掉脏条目就死锁了）。
    const home2 = tmpHome("nyra-memgate-delete2-");
    try {
      const row = {
        id: "memg_abcdef123458", scope: "user", projectId: null, orgId: null,
        subject: "脏条目", content: "密钥是 sk-abcdefgh12345678", sourceRefs: [],
        status: "confirmed", revision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        evidenceQuotes: ["密钥是"], prevContent: null, actor: "cli",
      };
      writeFileSync(join(home2, MEMORY_GATE_ENTRIES_FILE), JSON.stringify(row) + "\n", { mode: 0o600 });
      const d2 = updateMemoryEntry(home2, "memg_abcdef123458", { status: "deleted" }, null, { actor: "immune", checkVerbatim: false });
      expect(d2.status).toBe("deleted");
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

test("H3 dream state 落盘：状态与运行账本可读", async () => {
  const home = tmpHome("nyra-dream-state-");
  try {
    writeSessionWithRemember(home, "请记住，我喜欢用深色主题。");
    await runDreamMetabolism(home);
    const state = readDreamState(home);
    expect(state).not.toBeNull();
    expect(state!.last_run_ok).toBe(true);
    expect(state!.last_summary.length).toBeGreaterThan(0);
    expect(state!.last_counts.proposals_added).toBeGreaterThanOrEqual(1);
    const runs = readFileSync(join(home, DREAM_RUNS_FILE), "utf-8").trim().split("\n");
    expect(runs.length).toBe(1);
    const run = JSON.parse(runs[0]) as Record<string, unknown>;
    expect(run.proposals_added).toBeGreaterThanOrEqual(1);
    const lines = dreamBriefLines(state, Date.now() - 24 * 3600 * 1000);
    expect(lines.length).toBeGreaterThan(0);
    expect(dreamBriefLines(state, Date.now() + 24 * 3600 * 1000)).toEqual([]);
    expect(dreamBriefLines(null, 0)).toEqual([]);
  } finally {
    cleanup(home);
  }
});
