// H3：夜间“做梦代谢”（Hermes/TalosBrain 借鉴）。
//
// 每夜一次（默认关），做三件确定性的事，不调模型：
//   1. 提炼——扫最近有更新的主会话，用 G-P1-34 的规则抽取（memoryProposals.ts）
//      找用户显式表态的记忆候选；候选只进待审队列，绝不静默写 MEMORY.md。
//   2. 剪枝——重复的已确认记忆只留最新一条（旧的标 deleted，修订历史保留，
//      可审计）；超过 N 天未决的旧候选清掉（记进拒绝账本，原因码 dream-pruned-stale）。
//      同主题不同说法（矛盾）不自动处理，只进小结请用户定。
//   3. 小结——把结果写进晨间简报（“昨夜做梦小结”一节），不发新消息。
//
// “写小结”可以额外调一次模型润色（summarize_with_model），默认关，须用户
// 显式开；开了也先过月度成本上限，超支就只用确定性小结，不花钱。
// 守护进程里跑：cli.ts 的 schedule daemon 加一个 dream poller（自己判断
// 到没到点、开关开没开，不到就静默跳过），不走跑模型提示词的 schedule 任务。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProvider } from "./config.ts";
import { listSessions, resolveNyraHome } from "./memory.ts";
import {
  extractMemoryProposals,
  listMemoryProposals,
  normalizeProposalContent,
  rejectMemoryProposal,
} from "./memoryProposals.ts";
import {
  listMemoryGateEntries,
  updateMemoryEntry,
} from "./memoryGate.ts";
import { EvidenceStore } from "./evidence.ts";
import { Provider } from "./providers.ts";
import { estimateCost, resolveMonthlyLimit, resolvePricing } from "./cost.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { UsageTracker } from "./usage.ts";

export const DREAM_STATE_FILE = "dream-state.json";
export const DREAM_RUNS_FILE = "dream-runs.jsonl";
export const DREAM_RUNS_MAX = 100;
export const DREAM_DEFAULT_AT = "03:00";
export const DREAM_DEFAULT_PRUNE_STALE_DAYS = 90;
/** 上次运行之后最多往回扫几天（避免一次跑太久）。 */
export const DREAM_SCAN_BACK_DAYS = 7;

export interface DreamConfig {
  enabled: boolean;
  /** 每夜运行时间 HH:MM（本地时间）。 */
  at: string;
  /** 写小结是否额外调一次模型润色，默认关。 */
  summarizeWithModel: boolean;
  /** 待确认候选超过多少天未决定，算过期清掉。 */
  pruneStaleDays: number;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: false,
  at: DREAM_DEFAULT_AT,
  summarizeWithModel: false,
  pruneStaleDays: DREAM_DEFAULT_PRUNE_STALE_DAYS,
};

function isValidAt(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 从整份 config 里读 dream 一节：形状不对就回默认值，不抛错。 */
export function dreamConfig(config: Record<string, unknown>): DreamConfig {
  const raw = (config as Record<string, unknown>).dream;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DREAM_CONFIG };
  const d = raw as Record<string, unknown>;
  const prune = typeof d.prune_stale_days === "number" && Number.isFinite(d.prune_stale_days) && d.prune_stale_days >= 0
    ? Math.floor(d.prune_stale_days)
    : DREAM_DEFAULT_PRUNE_STALE_DAYS;
  return {
    enabled: d.enabled === true,
    at: isValidAt(d.at) ? d.at : DREAM_DEFAULT_AT,
    summarizeWithModel: d.summarize_with_model === true,
    pruneStaleDays: prune,
  };
}

export interface DreamState {
  last_run_at: string | null;
  last_run_ok: boolean;
  last_summary: string[];
  last_counts: DreamCounts;
}

export interface DreamCounts {
  sessions_scanned: number;
  proposals_added: number;
  duplicates_pruned: number;
  stale_rejected: number;
  contradictions: number;
  pending_total: number;
}

export function emptyDreamCounts(): DreamCounts {
  return { sessions_scanned: 0, proposals_added: 0, duplicates_pruned: 0, stale_rejected: 0, contradictions: 0, pending_total: 0 };
}

export function dreamStatePath(home: string): string {
  return join(resolveNyraHome(home), DREAM_STATE_FILE);
}

export function dreamRunsPath(home: string): string {
  return join(resolveNyraHome(home), DREAM_RUNS_FILE);
}

function writeJson0600Atomic(path: string, value: unknown): boolean {
  try {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(`${path}.tmp-${process.pid}`, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** 读上次做梦的状态；没有或损坏回空状态（损坏不抛错，等下次运行覆盖）。 */
export function readDreamState(home: string): DreamState | null {
  const path = dreamStatePath(home);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const counts = (parsed.last_counts ?? {}) as Record<string, unknown>;
    const num = (k: string): number => (typeof counts[k] === "number" && Number.isFinite(counts[k] as number) ? counts[k] as number : 0);
    return {
      last_run_at: typeof parsed.last_run_at === "string" ? parsed.last_run_at : null,
      last_run_ok: parsed.last_run_ok === true,
      last_summary: Array.isArray(parsed.last_summary) ? (parsed.last_summary as unknown[]).filter((x): x is string => typeof x === "string") : [],
      last_counts: {
        sessions_scanned: num("sessions_scanned"),
        proposals_added: num("proposals_added"),
        duplicates_pruned: num("duplicates_pruned"),
        stale_rejected: num("stale_rejected"),
        contradictions: num("contradictions"),
        pending_total: num("pending_total"),
      },
    };
  } catch {
    return null;
  }
}

function writeDreamState(home: string, state: DreamState): void {
  writeJson0600Atomic(dreamStatePath(home), state);
}

function appendDreamRun(home: string, record: Record<string, unknown>): void {
  try {
    const path = dreamRunsPath(home);
    let lines: string[] = [];
    if (existsSync(path)) {
      lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
    }
    lines.push(JSON.stringify(record));
    const kept = lines.slice(-DREAM_RUNS_MAX);
    // JSONL 文本直接落盘（不是 JSON 对象，不走 writeJson0600Atomic）。
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.join("\n") + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch { /* 账本写失败不破坏做梦本身 */ }
}

/**
 * 到没到今夜该跑的点：开关开着、现在过了今夜的 at、且今天还没跑过。
 * 纯函数，可测；守护进程 poller 每轮调它，不到点静默跳过。
 */
export function isDreamDue(cfg: DreamConfig, state: DreamState | null, now = new Date()): boolean {
  if (!cfg.enabled) return false;
  const [hh, mm] = cfg.at.split(":").map((x) => parseInt(x, 10));
  const due = new Date(now);
  due.setHours(hh, mm, 0, 0);
  if (now < due) return false;
  if (!state?.last_run_at) return true;
  const last = new Date(state.last_run_at);
  if (Number.isNaN(last.getTime())) return true;
  return last.toDateString() !== now.toDateString();
}

/** 记一条 dream 运行事件：没有运行上下文时走证据文件（与责任事件同款口径）。 */
function recordDreamEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const lines = [`事件：${type}`, `时间：${new Date().toISOString()}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) lines.push(`${k}：${String(v).slice(0, 200)}`);
    }
    new EvidenceStore(join(resolveNyraHome(home), "evidence"), "dream").save(
      "dream",
      `dream://${new Date().toISOString().slice(0, 10)}`,
      lines.join("\n"),
    );
  } catch { /* 审计写盘失败不拦操作 */ }
}

export interface DreamRunResult {
  ran: boolean;
  skipped?: string;
  counts: DreamCounts;
  /** 确定性小结（每行一句话）。 */
  summary: string[];
  /** 模型润色后的小结（没开或失败时为 null，用确定性小结）。 */
  modelSummary: string | null;
  modelSummarySkipped?: string;
  /** 被剪掉的重复条目 id（旧版，已标 deleted）。 */
  prunedIds: string[];
  /** 被清掉的过期候选 id。 */
  staleIds: string[];
  /** 同主题不同说法的主题（只上报，不自动处理）。 */
  contradictions: string[];
  /** 本次运行里被模型润色花掉的钱（没调模型时为 null）。 */
  spentUsd: number | null;
}

/** 模型润色注入点：测试传假 runner，真跑走默认的 Provider.chat。 */
export type DreamModelRunner = (prompt: string) => Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null }>;

/** 默认的模型润色：一次 Provider.chat（60 秒超时，不带工具），失败抛错由调用方兜底。 */
function defaultDreamModelRunner(provider: Provider): DreamModelRunner {
  return async (prompt: string) => {
    const result = await provider.chat([{ role: "user", content: prompt }], null, 60);
    const choices = (result as Record<string, unknown>).choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === "string" ? (message.content as string) : "";
    const usage = (result as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    return {
      text,
      usage: usage ? {
        prompt_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
        completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
      } : null,
    };
  };
}

function buildDeterministicSummary(counts: DreamCounts, contradictions: string[], pruneStaleDays: number): string[] {
  const lines: string[] = [];
  if (counts.proposals_added > 0) {
    lines.push(`扫了 ${counts.sessions_scanned} 个会话，提炼出 ${counts.proposals_added} 条新候选（待你确认，未直接写入记忆）。`);
  }
  if (counts.duplicates_pruned > 0) {
    lines.push(`剪掉 ${counts.duplicates_pruned} 条重复记忆（旧版已标删除，修订历史可查）。`);
  }
  if (counts.stale_rejected > 0) {
    lines.push(`清掉 ${counts.stale_rejected} 条超过 ${pruneStaleDays} 天未决的旧候选。`);
  }
  if (contradictions.length > 0) {
    lines.push(`发现 ${contradictions.length} 组同主题不同说法，等你定：${contradictions.slice(0, 5).join("、")}。`);
  }
  if (lines.length === 0) {
    lines.push(`昨夜没什么新东西：扫了 ${counts.sessions_scanned} 个会话，无新候选、无重复、无过期。`);
  }
  lines.push(`现在待确认的候选共 ${counts.pending_total} 条（nyra review 看）。`);
  return lines;
}

/**
 * 跑一次做梦代谢。默认不调模型；withModel 为 true（或配置开了
 * summarize_with_model）时才调一次模型润色小结，且先过月度成本上限。
 */
export async function runDreamMetabolism(
  home: string,
  opts: { now?: Date; withModel?: boolean; modelRunner?: DreamModelRunner } = {},
): Promise<DreamRunResult> {
  const now = opts.now ?? new Date();
  const config = loadConfig(home);
  const cfg = dreamConfig(config);
  const state = readDreamState(home);
  const counts = emptyDreamCounts();
  const prunedIds: string[] = [];
  const staleIds: string[] = [];
  const contradictionSubjects: string[] = [];

  // 1. 提炼：扫上次运行以来（最多往回 7 天）有更新的主会话。
  //    a2a- 开头的是对端 Bot 的会话，不提炼；子 agent 与无人值守会话在文件
  //    名上无法可靠区分——抽取只认用户显式表态（“记住……”等），候选仍须
  //    人确认才进库，见 docs/dream.md 的局限。
  const sinceMs = state?.last_run_at
    ? Math.max(new Date(state.last_run_at).getTime(), now.getTime() - DREAM_SCAN_BACK_DAYS * 24 * 60 * 60 * 1000)
    : now.getTime() - 24 * 60 * 60 * 1000;
  let sessions: ReturnType<typeof listSessions> = [];
  try {
    sessions = listSessions(home);
  } catch {
    sessions = [];
  }
  for (const meta of sessions) {
    if (meta.id.startsWith("a2a-")) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(resolveNyraHome(home), "sessions", `${meta.id}.jsonl`)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < sinceMs) continue;
    counts.sessions_scanned += 1;
    try {
      const extracted = extractMemoryProposals(home, meta.id);
      counts.proposals_added += extracted.added;
    } catch {
      // 单个会话提炼失败不破坏整夜做梦。
    }
  }

  // 2a. 剪枝重复：同一规范化正文的已确认条目只留最新一条。
  try {
    const entries = listMemoryGateEntries(home, { includeDeleted: false })
      .filter((e) => e.status === "confirmed");
    const byContent = new Map<string, typeof entries>();
    for (const e of entries) {
      const key = normalizeProposalContent(e.content);
      const group = byContent.get(key) ?? [];
      group.push(e);
      byContent.set(key, group);
    }
    for (const group of byContent.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      for (const old of sorted.slice(1)) {
        try {
          updateMemoryEntry(home, old.id, { status: "deleted", evidenceQuotes: old.evidenceQuotes }, null, { actor: "dream", checkVerbatim: false });
          prunedIds.push(old.id);
          counts.duplicates_pruned += 1;
        } catch {
          // 单条剪不掉不破坏整夜做梦（下次再试）。
        }
      }
    }
  } catch {
    // 记忆账本读失败：提炼结果已进队列，剪枝下次再做。
  }

  // 2b. 剪枝过期：超过 pruneStaleDays 未决的候选清掉（记拒绝账本，原因码 dream-pruned-stale）。
  try {
    const proposals = listMemoryProposals(home);
    const staleBefore = now.getTime() - cfg.pruneStaleDays * 24 * 60 * 60 * 1000;
    for (const p of proposals) {
      if (p.status !== "pending") continue;
      if (new Date(p.createdAt).getTime() >= staleBefore) continue;
      const res = rejectMemoryProposal(home, p.id, "dream-pruned-stale", { now, ledgerReason: "dream-pruned-stale" });
      if (res.ok) {
        staleIds.push(p.id);
        counts.stale_rejected += 1;
      }
    }
  } catch {
    // 候选队列读失败：剪枝下次再做。
  }

  // 2c. 矛盾只上报：同主题不同正文的已确认条目，列主题请用户定，不自动删。
  try {
    const entries = listMemoryGateEntries(home, { includeDeleted: false })
      .filter((e) => e.status === "confirmed");
    const bySubject = new Map<string, Set<string>>();
    for (const e of entries) {
      const key = e.subject.trim();
      const set = bySubject.get(key) ?? new Set<string>();
      set.add(normalizeProposalContent(e.content));
      bySubject.set(key, set);
    }
    for (const [subject, contents] of bySubject) {
      if (contents.size > 1) contradictionSubjects.push(subject);
    }
    counts.contradictions = contradictionSubjects.length;
  } catch {
    counts.contradictions = 0;
  }

  // 待确认总数（写进小结，方便用户一眼看到队列深度）。
  try {
    counts.pending_total = listMemoryProposals(home).filter((p) => p.status === "pending").length;
  } catch {
    counts.pending_total = 0;
  }

  const summary = buildDeterministicSummary(counts, contradictionSubjects, cfg.pruneStaleDays);

  // 3. 可选的模型润色：默认不开；开了也先过月度成本上限，超支就跳过。
  let modelSummary: string | null = null;
  let modelSummarySkipped: string | undefined;
  let spentUsd: number | null = null;
  const wantModel = opts.withModel === true || (opts.withModel !== false && cfg.summarizeWithModel);
  if (wantModel) {
    try {
      const provider = new Provider(resolveProvider({ home, config }));
      let monthlyLimit: number | null = null;
      if (!provider.hasCredentials()) {
        modelSummarySkipped = "no-credentials";
      } else {
        monthlyLimit = resolveMonthlyLimit(config, null);
        if (monthlyLimit !== null) {
          const llm = new UsageLedger(home).monthTotal(monthKeyString(now));
          const mcp = new McpCostTracker(home).monthTotalUsd(monthKeyString(now));
          if (llm.spentUsd + mcp >= monthlyLimit) modelSummarySkipped = "monthly-cap-reached";
        }
      }
      if (!modelSummarySkipped) {
        const runner = opts.modelRunner ?? defaultDreamModelRunner(provider);
        const prompt = `把以下夜间记忆整理结果改写成一段不超过 200 字的中文小结，只基于所给事实，不添加新事实，不编造数字：\n${summary.join("\n")}`;
        const out = await runner(prompt);
        const text = out.text.trim();
        if (text) {
          modelSummary = text;
          // 记账：用量进当月账本，花了多少如实记（没上报 usage 就只记 1 次调用）。
          try {
            const tracker = new UsageTracker();
            tracker.record({ usage: out.usage ?? null });
            const snap = tracker.snapshot();
            const pricing = resolvePricing(config.pricing, provider.model ?? null);
            const est = estimateCost(snap, pricing, monthlyLimit);
            if (est.status === "priced" && est.spentUsd !== null) {
              spentUsd = est.spentUsd;
              new UsageLedger(home).recordDelta(snap, null, est.spentUsd, null, provider.model ?? null, now);
            }
          } catch { /* 记账失败不破坏小结 */ }
        } else {
          modelSummarySkipped = "empty-response";
        }
      }
    } catch {
      // 模型润色任何失败都回落到确定性小结，不抛错。
      modelSummary = null;
      modelSummarySkipped = "model-failed";
    }
  }

  const result: DreamRunResult = {
    ran: true,
    counts,
    summary: modelSummary ? [modelSummary] : summary,
    modelSummary,
    modelSummarySkipped,
    prunedIds,
    staleIds,
    contradictions: contradictionSubjects,
    spentUsd,
  };

  // 落盘：状态 + 运行账本 + 证据 + 运行事件。
  const newState: DreamState = {
    last_run_at: now.toISOString(),
    last_run_ok: true,
    last_summary: result.summary,
    last_counts: counts,
  };
  writeDreamState(home, newState);
  appendDreamRun(home, {
    at: now.toISOString(),
    sessions_scanned: counts.sessions_scanned,
    proposals_added: counts.proposals_added,
    duplicates_pruned: counts.duplicates_pruned,
    stale_rejected: counts.stale_rejected,
    contradictions: counts.contradictions,
    pending_total: counts.pending_total,
    model_summary: modelSummary !== null,
    model_summary_skipped: modelSummarySkipped ?? null,
    spent_usd: spentUsd,
  });
  recordDreamEvent(home, "dream_run", {
    sessions_scanned: counts.sessions_scanned,
    proposals_added: counts.proposals_added,
    duplicates_pruned: counts.duplicates_pruned,
    stale_rejected: counts.stale_rejected,
    contradictions: counts.contradictions,
    model_summary: modelSummary !== null,
  });
  return result;
}

/**
 * 晨间简报用的“昨夜做梦小结”：上次做梦在简报窗口内时返回小结行，
 * 否则返回空数组（简报不写这一节）。
 */
export function dreamBriefLines(state: DreamState | null, sinceMs: number): string[] {
  if (!state?.last_run_at || state.last_summary.length === 0) return [];
  const last = new Date(state.last_run_at).getTime();
  if (Number.isNaN(last) || last < sinceMs) return [];
  return [...state.last_summary];
}
