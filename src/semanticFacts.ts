// src/semanticFacts.ts — 记忆语义层：事实抽取 + 矛盾处理（十年 AI 知识库调研前 10 清单第 2 项）。
//
// Mem0 的思路、自己实现，不引 Mem0 服务端：
//   - 抽取：小模型（默认 provider，默认就是 flash 级）在后台把会话提炼成原子事实，
//     进待审队列（memory-proposals.json，复用 G-P1-34 的队列与去重），由用户或
//     证据门确认后才入库；绝不静默写 MEMORY.md。
//   - 事实：确认进库的记忆同时记一条语义事实（semantic-facts.jsonl，append-only，
//     0600），带时间戳与有效期；矛盾事实新旧并存——新事实确认时，同一主题、
//     不同正文的旧事实标 superseded（被取代），两边都留着可查，不直接覆盖。
//   - 过期：事实带 validUntil（只有来源明确说了结束时间才有），到期自动失效
//     （Graphiti 的时态失效思路，轻量版：读时惰性过期 + 做梦代谢里定期扫）。
//   - 默认关：config.json 的 semantic_facts 一节，enabled false；抽取先过月度
//     成本上限，超支就跳过，花了多少进当月账本。
// 本模块不 import memoryProposals.ts / dream.ts（memoryProposals.ts 调它建事实；
// dream.ts 调它跑抽取与过期扫——反向 import 会成环）。队列插入由调用方
// （dream / memory extract）走 memoryProposals.ts 的 addProposalDrafts。

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { loadConfig, resolveHome, resolveProvider } from "./config.ts";
import { loadSession } from "./memory.ts";
import { tokenize, scoreBm25 } from "./knowledge.ts";
import { estimateCost, resolveMonthlyLimit, resolvePricing } from "./cost.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { UsageTracker } from "./usage.ts";
import { Provider } from "./providers.ts";

/** 语义事实账本（append-only 0600，写失败不抛错、调用方自理）。 */
export const SEMANTIC_FACTS_FILE = "semantic-facts.jsonl";
/** 一次提炼最多新增几条事实候选（与规则抽取同款上限 5 条）。 */
export const SEMANTIC_FACT_MAX_PER_SESSION = 5;
/** 单条事实正文上限（与候选记忆同款 300 字）。 */
export const SEMANTIC_FACT_CONTENT_MAX_CHARS = 300;
/** 模型抽取的输入上限：用户回合拼起来最多这么多字（控成本）。 */
export const SEMANTIC_FACT_INPUT_MAX_CHARS = 6000;

export type SemanticFactCategory = "about_you" | "work" | "how_to";
export type SemanticFactStatus = "active" | "superseded" | "expired";

/** 一条语义事实：确认进库的记忆的原子化视图，带时间戳与有效期。 */
export interface SemanticFact {
  /** `fact_` + 12 位十六进制。 */
  id: string;
  subject: string;
  /** 原子事实正文（一句话，≤300 字）。 */
  content: string;
  category: SemanticFactCategory;
  /** 提炼自哪个会话。 */
  sourceSession: string;
  /** 关联的结构化记忆条目 id（memg_…）；没有时为 null。 */
  entryId: string | null;
  /** 依据：用户原话逐字摘抄（1–8 条）。 */
  evidenceQuotes: string[];
  status: SemanticFactStatus;
  revision: number;
  /** 生效时间（创建时间）；updatedAt 是最近一次状态变化的时间。 */
  createdAt: string;
  updatedAt: string;
  /** 有效期至（ISO 时间）；null = 不过期。被取代时记取代时间。 */
  validUntil: string | null;
  /** 本条取代的旧事实 id；没有时为 null。 */
  supersedes: string | null;
  /** 被哪条新事实取代；没有时为 null。 */
  supersededBy: string | null;
}

/** 事实的一版 = 事实本身 + 修订元数据（与记忆门 MemoryGateRevision 同款写法）。 */
export interface SemanticFactRevision extends SemanticFact {
  /** 写这版的是谁：dream（做梦代谢）/ cli（终端确认）/ agent（模型工具路径，暂不走这条）。 */
  actor: string;
}

/** 模型抽出的事实草稿（还没进待审队列，纯函数 parseFactDrafts 的返回值）。 */
export interface SemanticFactDraft {
  subject: string;
  content: string;
  category: SemanticFactCategory;
  evidenceQuotes: string[];
  /** 证据来源：包含第一条依据的整条用户消息（证据门确认时用来逐字校验）。 */
  evidenceSource: string;
  /** 只有来源明确说了结束时间才有；否则 null。 */
  validUntil: string | null;
}

export interface SemanticFactsConfig {
  enabled: boolean;
  /** 一次提炼最多新增几条候选（默认 5，上限 20）。 */
  maxPerSession: number;
}

export const DEFAULT_SEMANTIC_FACTS_CONFIG: SemanticFactsConfig = {
  enabled: false,
  maxPerSession: SEMANTIC_FACT_MAX_PER_SESSION,
};

/** 从整份 config 里读 semantic_facts 一节：形状不对就回默认值，不抛错。 */
export function semanticFactsConfig(config: Record<string, unknown>): SemanticFactsConfig {
  const raw = (config as Record<string, unknown>).semantic_facts;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SEMANTIC_FACTS_CONFIG };
  const d = raw as Record<string, unknown>;
  const max = typeof d.max_per_session === "number" && Number.isFinite(d.max_per_session)
    ? Math.min(20, Math.max(1, Math.floor(d.max_per_session)))
    : SEMANTIC_FACT_MAX_PER_SESSION;
  return { enabled: d.enabled === true, maxPerSession: max };
}

/** 去重用的规范化正文：去空白与句末标点（与 memoryProposals.ts 同款算法，各自一份，不成环）。 */
export function normalizeFactContent(content: string): string {
  return content.replace(/\s+/g, "").replace(/[。！？!?,，；;、.]+$/u, "");
}

function factsPath(home?: string): string {
  return join(resolveHome(home), SEMANTIC_FACTS_FILE);
}

function isValidRevision(raw: unknown): raw is SemanticFactRevision {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^fact_[0-9a-f]{12}$/.test(r.id)) return false;
  if (typeof r.subject !== "string" || typeof r.content !== "string") return false;
  if (r.category !== "about_you" && r.category !== "work" && r.category !== "how_to") return false;
  if (typeof r.sourceSession !== "string") return false;
  if (!Array.isArray(r.evidenceQuotes)) return false;
  if (r.status !== "active" && r.status !== "superseded" && r.status !== "expired") return false;
  if (typeof r.revision !== "number" || r.revision < 1) return false;
  return true;
}

function readRevisions(home?: string): SemanticFactRevision[] {
  const path = factsPath(home);
  if (!existsSync(path)) return [];
  const out: SemanticFactRevision[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as unknown;
      if (isValidRevision(raw)) out.push(raw);
    } catch { /* 坏行跳过，不拖垮读取 */ }
  }
  return out;
}

function appendRevision(home: string | undefined, rev: SemanticFactRevision): SemanticFactRevision | null {
  try {
    const resolved = resolveHome(home);
    const path = join(resolved, SEMANTIC_FACTS_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return null;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as Partial<SemanticFactRevision>;
          if (raw.id === rev.id && raw.revision === rev.revision) return rev;
        } catch { continue; }
      }
    }
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(rev) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return rev;
  } catch {
    return null;
  }
}

function toFact(rev: SemanticFactRevision): SemanticFact {
  return {
    id: rev.id,
    subject: rev.subject,
    content: rev.content,
    category: rev.category,
    sourceSession: rev.sourceSession,
    entryId: rev.entryId ?? null,
    evidenceQuotes: rev.evidenceQuotes,
    status: rev.status,
    revision: rev.revision,
    createdAt: rev.createdAt,
    updatedAt: rev.updatedAt,
    validUntil: rev.validUntil ?? null,
    supersedes: rev.supersedes ?? null,
    supersededBy: rev.supersededBy ?? null,
  };
}

/** 事实是否已过期：validUntil 到了就算过期（读时惰性判断，不依赖定期扫）。 */
export function isFactExpired(fact: SemanticFact, now = new Date()): boolean {
  if (!fact.validUntil) return false;
  const t = new Date(fact.validUntil).getTime();
  return !Number.isNaN(t) && t < now.getTime();
}

/**
 * 列出事实（默认只看生效中的；最新 revision 为准）。
 * includeSuperseded / includeExpired 为 true 时才分别带上被取代的与已过期的。
 */
export function listSemanticFacts(
  home?: string,
  opts: { status?: SemanticFactStatus; includeSuperseded?: boolean; includeExpired?: boolean; limit?: number; now?: Date } = {},
): SemanticFact[] {
  const now = opts.now ?? new Date();
  const latest = new Map<string, SemanticFactRevision>();
  for (const rev of readRevisions(home)) {
    const prev = latest.get(rev.id);
    if (!prev || rev.revision > prev.revision) latest.set(rev.id, rev);
  }
  let out = [...latest.values()].map(toFact);
  if (opts.status) {
    out = out.filter((f) => f.status === opts.status);
  } else {
    if (!opts.includeSuperseded) out = out.filter((f) => f.status !== "superseded");
    // 惰性过期只挡生效中的事实：被取代的事实的 validUntil 是取代时间，
    // 它本身不是“到期”，含被取代时照常列出（不删记录才能审计）。
    if (!opts.includeExpired) {
      out = out.filter((f) => f.status !== "expired" && !(f.status === "active" && isFactExpired(f, now)));
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  if (opts.limit !== undefined) out = out.slice(0, Math.max(0, Math.floor(opts.limit)));
  return out;
}

/** 查一条事实 + 它的全部修订历史（按 revision 升序；找不到返回 null）。 */
export function getSemanticFact(
  home: string | undefined,
  id: string,
): { fact: SemanticFact; history: SemanticFactRevision[] } | null {
  const history = readRevisions(home)
    .filter((r) => r.id === id)
    .sort((a, b) => a.revision - b.revision);
  if (!history.length) return null;
  return { fact: toFact(history[history.length - 1]), history };
}

export interface CreateSemanticFactInput {
  subject: string;
  content: string;
  category: SemanticFactCategory;
  sourceSession: string;
  entryId: string | null;
  evidenceQuotes: string[];
  validUntil?: string | null;
}

/**
 * 确认进库的记忆同时记一条语义事实（首版 revision=1）。
 * 矛盾处理：同一主题、不同正文的生效中旧事实会被取代——旧事实追加一版
 * （status superseded、supersededBy 指新事实、validUntil 记取代时间），
 * 新旧两边都留着可查，不直接覆盖。同一正文已有一条生效事实时直接返回
 * 它（幂等，不重复建）。账本写失败返回 null（事实是记忆库的派生视图，
 * 写不进去不破坏确认进库本身，调用方不得因此抛错）。
 */
export function createSemanticFact(
  home: string | undefined,
  input: CreateSemanticFactInput,
  opts: { actor?: string; now?: Date } = {},
): SemanticFact | null {
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!subject || subject.length > 120) return null;
  if (!content || content.length > SEMANTIC_FACT_CONTENT_MAX_CHARS) return null;
  if (input.category !== "about_you" && input.category !== "work" && input.category !== "how_to") return null;
  const quotes = Array.isArray(input.evidenceQuotes) ? input.evidenceQuotes.filter((q) => typeof q === "string" && q.trim()) : [];
  if (!quotes.length || quotes.length > 8) return null;
  const now = (opts.now ?? new Date()).toISOString();
  const norm = normalizeFactContent(content);
  // 同一正文已有效：幂等返回，不重复建。
  const existing = listSemanticFacts(home, { includeExpired: true });
  const dup = existing.find((f) => f.status === "active" && normalizeFactContent(f.content) === norm);
  if (dup) return dup;
  const id = `fact_${randomBytes(6).toString("hex")}`;
  // 同一主题、不同正文的生效中旧事实：全部标被取代（新旧并存，只改状态）。
  const contradicted = existing.filter(
    (f) => f.status === "active" && f.subject.trim() === subject && normalizeFactContent(f.content) !== norm,
  );
  const rev: SemanticFactRevision = {
    id,
    subject,
    content,
    category: input.category,
    sourceSession: input.sourceSession,
    entryId: input.entryId ?? null,
    evidenceQuotes: quotes.map((q) => q.trim()),
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    validUntil: input.validUntil ?? null,
    supersedes: contradicted.length ? contradicted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0].id : null,
    supersededBy: null,
    actor: opts.actor ?? "cli",
  };
  const saved = appendRevision(home, rev);
  if (!saved) return null;
  for (const old of contradicted) {
    const oldHistory = getSemanticFact(home, old.id);
    const oldRev = oldHistory?.history[oldHistory.history.length - 1];
    if (!oldRev) continue;
    appendRevision(home, {
      ...oldRev,
      status: "superseded",
      revision: oldRev.revision + 1,
      updatedAt: now,
      validUntil: now,
      supersededBy: id,
      actor: opts.actor ?? "cli",
    });
  }
  return toFact(rev);
}

/**
 * 到期扫：validUntil 已过的生效中事实标 expired（只标过期，不删除；
 * 修订历史保留，可审计）。返回被标过期的事实 id。
 */
export function expireStaleFacts(home: string | undefined, now = new Date()): { expired: string[] } {
  const expired: string[] = [];
  const at = now.toISOString();
  for (const fact of listSemanticFacts(home, { includeExpired: true })) {
    if (fact.status !== "active" || !isFactExpired(fact, now)) continue;
    const history = getSemanticFact(home, fact.id);
    const last = history?.history[history.history.length - 1];
    if (!last) continue;
    const saved = appendRevision(home, {
      ...last,
      status: "expired",
      revision: last.revision + 1,
      updatedAt: at,
      actor: "dream",
    });
    if (saved) expired.push(fact.id);
  }
  return { expired };
}

/** 矛盾分组：同一主题下正文不同的生效中事实（纯函数）。 */
export function findFactContradictions(
  facts: readonly SemanticFact[],
): { subject: string; factIds: string[] }[] {
  const bySubject = new Map<string, Map<string, string[]>>();
  for (const f of facts) {
    if (f.status !== "active") continue;
    const key = f.subject.trim();
    const group = bySubject.get(key) ?? new Map<string, string[]>();
    const norm = normalizeFactContent(f.content);
    const ids = group.get(norm) ?? [];
    ids.push(f.id);
    group.set(norm, ids);
    bySubject.set(key, group);
  }
  const out: { subject: string; factIds: string[] }[] = [];
  for (const [subject, byContent] of bySubject) {
    if (byContent.size < 2) continue;
    out.push({ subject, factIds: [...byContent.values()].flat() });
  }
  return out;
}

export interface SemanticFactSearchHit {
  score: number;
  fact: SemanticFact;
}

/** BM25 检索语义事实（复用 knowledge.ts 的 tokenize + scoreBm25，与记忆检索同一套公式）。 */
export function searchSemanticFacts(
  home: string | undefined,
  query: string,
  opts: { limit?: number; includeSuperseded?: boolean; includeExpired?: boolean } = {},
): SemanticFactSearchHit[] {
  const facts = listSemanticFacts(home, {
    includeSuperseded: opts.includeSuperseded,
    includeExpired: opts.includeExpired,
  });
  const limit = Math.max(1, Math.floor(opts.limit ?? 5));
  const queryTokens = tokenize(query || "");
  if (!facts.length || !queryTokens.length) return [];
  const docTokens = facts.map((f) => tokenize(`${f.subject} ${f.content}`));
  return scoreBm25(queryTokens, docTokens, limit).map(([score, i]) => ({ score, fact: facts[i] }));
}

/** 每条检索结果附来源（事实 id、关联记忆条目、来源会话、生效与有效期），与记忆检索同口径。 */
export function formatSemanticFactResults(results: readonly SemanticFactSearchHit[]): string {
  const lines = results.map(({ score, fact }) => {
    const text = fact.content.length > 200 ? fact.content.slice(0, 200) + "…" : fact.content;
    const until = fact.validUntil ? `有效期至 ${fact.validUntil.slice(0, 10)}` : "无有效期";
    const entry = fact.entryId ? `记忆 ${fact.entryId}` : "未关联记忆条目";
    return `- [${fact.id}] ${text}\n  来源：${entry}；会话 ${fact.sourceSession}；${fact.createdAt.slice(0, 10)} 起生效，${until}；相关度 ${score.toFixed(2)}`;
  });
  return lines.join("\n");
}

const SEMANTIC_FACTS_SECTION_MAX_CHARS = 1000;

/**
 * 主循环提示词里的语义事实段——按需检索生效中的事实（附来源与有效期），
 * 没有事实时返回 ""（零影响）。与 buildMemorySection 的 MEMORY.md 检索
 * 互补：这里是去重后的原子事实，不是全文。
 */
export function buildSemanticFactsSection(home: string | undefined, task: string): string {
  let hits: SemanticFactSearchHit[] = [];
  try {
    hits = searchSemanticFacts(home, task, { limit: 5 });
  } catch {
    hits = [];
  }
  if (!hits.length) return "";
  const body = formatSemanticFactResults(hits);
  const text = "## 语义事实（已确认的原子事实，带时间戳与有效期；过期或被取代的不在此列，需复核是否仍然成立）\n" + body;
  return text.length > SEMANTIC_FACTS_SECTION_MAX_CHARS ? text.slice(0, SEMANTIC_FACTS_SECTION_MAX_CHARS) + "\n…（已截断）" : text;
}

/** 模型抽出的事实草稿校验：subject/content/category/依据/有效期，逐条过。 */
export function parseFactDrafts(text: string, userTurns: readonly string[]): SemanticFactDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).facts)
      ? ((parsed as Record<string, unknown>).facts as unknown[])
      : []);
  const out: SemanticFactDraft[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const subject = typeof r.subject === "string" ? r.subject.trim() : "";
    const content = typeof r.content === "string" ? r.content.trim() : "";
    const category = r.category;
    if (!subject || subject.length > 120) continue;
    if (!content || content.length > SEMANTIC_FACT_CONTENT_MAX_CHARS) continue;
    if (category !== "about_you" && category !== "work" && category !== "how_to") continue;
    const quotesRaw = r.evidenceQuote !== undefined ? [r.evidenceQuote] : r.evidenceQuotes;
    const quotes = (Array.isArray(quotesRaw) ? quotesRaw : [])
      .filter((q): q is string => typeof q === "string" && q.trim().length >= 2 && q.trim().length <= 500)
      .map((q) => q.trim());
    if (!quotes.length || quotes.length > 8) continue;
    // 依据须是某条用户消息里的逐字原话——模型编造的引用进不了队列。
    const verbatim = quotes.every((q) => userTurns.some((t) => t.includes(q)));
    if (!verbatim) continue;
    let validUntil: string | null = null;
    if (typeof r.validUntil === "string" && r.validUntil.trim()) {
      const t = new Date(r.validUntil.trim()).getTime();
      if (!Number.isNaN(t)) validUntil = r.validUntil.trim();
    }
    const norm = normalizeFactContent(content);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const evidenceSource = userTurns.find((t) => t.includes(quotes[0])) ?? quotes[0];
    out.push({ subject, content, category, evidenceQuotes: quotes, evidenceSource, validUntil });
    if (out.length >= SEMANTIC_FACT_MAX_PER_SESSION) break;
  }
  return out;
}

/** 事实抽取的提示词：只提用户消息里明确说出来的长期信息，不推测、不补全。 */
export function buildFactExtractionPrompt(userTurns: readonly string[]): string {
  return [
    "你是记忆提炼器。只根据下面【用户消息】提炼原子事实：每条事实是关于用户的一条独立、可验证的长期信息（身份、偏好、决定、计划、习惯、关系、拥有的东西、正在用的工具或套餐等）。",
    "规则：",
    "- 只提用户消息里明确说出来的事，不推测、不补全、不把问题当事实。",
    "- 每条事实一句话，不超过 100 字；subject 是主题，不超过 30 字；evidenceQuote 必须是某条用户消息里的逐字原话。",
    "- validUntil 只有当用户消息明确说了结束时间才给（YYYY-MM-DD），否则 null。",
    "- 最多 5 条；没有可提炼的事实时回 []。",
    "只回 JSON，不要其他文字。格式：{\"facts\":[{\"subject\":\"…\",\"content\":\"…\",\"category\":\"about_you|work|how_to\",\"evidenceQuote\":\"…\",\"validUntil\":null}]}",
    "",
    "【用户消息】",
    ...userTurns,
  ].join("\n");
}

/** 模型抽取注入点：测试传假 runner，真跑走默认的 Provider.chat。 */
export type SemanticModelRunner = (prompt: string) => Promise<{
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}>;

/** 默认的模型抽取：一次 Provider.chat（60 秒超时，不带工具），失败抛错由调用方兜底。 */
function defaultFactModelRunner(provider: Provider): SemanticModelRunner {
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

export interface ModelExtractionResult {
  /** 提炼出的事实草稿（还没进待审队列，调用方走 addProposalDrafts 入队）。 */
  drafts: SemanticFactDraft[];
  /** 本次抽取花掉的钱（没上报 usage 或没调模型时为 null）。 */
  spentUsd: number | null;
  /** 没跑的原因：no-credentials / monthly-cap-reached / model-failed / no-user-turns。 */
  skippedReason?: string;
}

/** 抽取花了多少如实记进当月账本（与 dream.ts 的模型润色记账同款写法）。 */
function recordFactSpend(
  home: string,
  config: Record<string, unknown>,
  provider: Provider,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined,
  monthlyLimit: number | null,
  now: Date,
): number | null {
  try {
    const tracker = new UsageTracker();
    tracker.record({ usage: usage ?? null });
    const snap = tracker.snapshot();
    const pricing = resolvePricing(config.pricing, provider.model ?? null);
    const est = estimateCost(snap, pricing, monthlyLimit);
    if (est.status === "priced" && est.spentUsd !== null) {
      new UsageLedger(home).recordDelta(snap, null, est.spentUsd, null, provider.model ?? null, now);
      return est.spentUsd;
    }
  } catch { /* 记账失败不破坏抽取 */ }
  return null;
}

/**
 * 用小模型跑一次事实抽取（不进待审队列、不写记忆，只返回草稿与花费）。
 * - 没凭证 / 月度上限已到 / 模型调用失败时返回空草稿 + skippedReason，不抛错。
 * - 开关（semantic_facts.enabled）由调用方判断（做梦代谢里判断；终端手动
 *   提炼是用户亲手点的，不拦），本函数只负责跑一次抽取。
 */
export async function runModelExtraction(
  home: string,
  sessionId: string,
  opts: { now?: Date; messages?: readonly Record<string, unknown>[]; modelRunner?: SemanticModelRunner } = {},
): Promise<ModelExtractionResult> {
  const now = opts.now ?? new Date();
  const config = loadConfig(home);
  let turns = opts.messages;
  if (!turns) {
    try {
      turns = loadSession(sessionId, home) ?? [];
    } catch {
      turns = [];
    }
  }
  const userTurns: string[] = [];
  for (const m of turns) {
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) userTurns.push(m.content);
  }
  if (!userTurns.length) return { drafts: [], spentUsd: null, skippedReason: "no-user-turns" };
  // 输入截断：只留最近、拼起来不超过上限的用户回合（控成本）。
  const kept: string[] = [];
  let chars = 0;
  for (let i = userTurns.length - 1; i >= 0; i--) {
    const t = userTurns[i];
    if (chars + t.length > SEMANTIC_FACT_INPUT_MAX_CHARS && kept.length > 0) break;
    kept.unshift(t);
    chars += t.length;
    if (chars >= SEMANTIC_FACT_INPUT_MAX_CHARS) break;
  }
  const monthlyLimit = resolveMonthlyLimit(config, null);
  // 先解析 provider（只为拿到模型名与价目做记账；解析失败不拦抽取，
  // 注入的假 runner 照样能跑，只是没法记账）。
  let provider: Provider | null = null;
  try {
    provider = new Provider(resolveProvider({ home, config }));
  } catch {
    provider = null;
  }
  let runner = opts.modelRunner;
  if (!runner) {
    if (!provider || !provider.hasCredentials()) {
      return { drafts: [], spentUsd: null, skippedReason: "no-credentials" };
    }
    runner = defaultFactModelRunner(provider);
  }
  if (monthlyLimit !== null) {
    try {
      const llm = new UsageLedger(home).monthTotal(monthKeyString(now));
      const mcp = new McpCostTracker(home).monthTotalUsd(monthKeyString(now));
      if (llm.spentUsd + mcp >= monthlyLimit) {
        return { drafts: [], spentUsd: null, skippedReason: "monthly-cap-reached" };
      }
    } catch { /* 账本读失败不拦抽取 */ }
  }
  let out: { text: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null };
  try {
    out = await runner(buildFactExtractionPrompt(kept));
  } catch {
    return { drafts: [], spentUsd: null, skippedReason: "model-failed" };
  }
  const drafts = parseFactDrafts(out.text, kept);
  let spentUsd: number | null = null;
  if (provider) {
    spentUsd = recordFactSpend(home, config, provider, out.usage, monthlyLimit, now);
  }
  return { drafts, spentUsd };
}
