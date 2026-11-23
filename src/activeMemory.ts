// src/activeMemory.ts — 主动记忆（G-P1-31，OpenClaw active-memory 借鉴）。
//
// OpenClaw 的做法：回复前先搜记忆，简单召回不够时升级用 recall agent
// 深挖；每会话可开关，跨会话记忆要显式开“Remember across conversations”。
// Nyra 的确定性版本：
//   - 两档召回：quick（MEMORY.md BM25 + 知识库 BM25）不够时升级 deep
//     （放宽上限 + 会话全文搜索 FTS5）；deep 是更宽的确定性搜索，不是
//     模型 agent，不调模型、不花 token。
//   - 开关：全局默认关；每个会话可单独开/关（会话开关优先于全局）；
//     跨会话（搜别的会话）默认关，须显式开 crossSession 才搜。
//   - 只读起步：只把召回结果注入提示词，不改记忆、不发消息、不花钱。
//   - 作用域口径：MEMORY.md 与知识库是本机的长期记忆，quick 档就搜；
//     会话历史是跨会话的部分，deep 档里 crossSession 关时只搜本会话，
//     开了才搜全部会话。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome, searchMemoryEntries } from "./memory.ts";
import { KnowledgeBase } from "./knowledge.ts";
import { searchSessions, sanitizeForModel } from "./sessionSearch.ts";

/** 主动记忆配置（`~/.nyra/active-memory.json`，0600 原子写）。 */
export interface ActiveMemoryConfig {
  /** 全局开关，默认关。 */
  enabled: boolean;
  /** 跨会话开关，默认关；开了 deep 档才搜别的会话。 */
  crossSession: boolean;
  /** 每会话开关，会话 id → 开/关；优先于全局。 */
  sessions: Record<string, boolean>;
}

export const ACTIVE_MEMORY_CONFIG_NAME = "active-memory.json";

export function defaultActiveMemoryConfig(): ActiveMemoryConfig {
  return { enabled: false, crossSession: false, sessions: {} };
}

function configPath(home: string): string {
  return join(resolveNyraHome(home), ACTIVE_MEMORY_CONFIG_NAME);
}

function atomicWrite0600(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 读配置：文件不存在回默认值；损坏先备份（同名 .bak-<时间戳>）再回
 * 默认值，不拦运行。
 */
export function loadActiveMemoryConfig(home: string): ActiveMemoryConfig {
  const path = configPath(home);
  if (!existsSync(path)) return defaultActiveMemoryConfig();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ActiveMemoryConfig>;
    return {
      enabled: parsed.enabled === true,
      crossSession: parsed.crossSession === true,
      sessions: parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
        ? Object.fromEntries(Object.entries(parsed.sessions).filter(([, v]) => typeof v === "boolean"))
        : {},
    };
  } catch {
    try {
      renameSync(path, `${path}.bak-${Date.now()}`);
    } catch { /* 备份失败也不拦运行 */ }
    return defaultActiveMemoryConfig();
  }
}

export function saveActiveMemoryConfig(home: string, cfg: ActiveMemoryConfig): void {
  atomicWrite0600(configPath(home), JSON.stringify(cfg, null, 2) + "\n");
}

/** 会话开关优先于全局；都没有时默认关。 */
export function isActiveMemoryEnabled(home: string, sessionId?: string | null): boolean {
  const cfg = loadActiveMemoryConfig(home);
  if (sessionId && typeof cfg.sessions[sessionId] === "boolean") return cfg.sessions[sessionId];
  return cfg.enabled;
}

/** 开/关：有会话 id 只改该会话的开关，否则改全局。 */
export function setActiveMemoryEnabled(home: string, on: boolean, sessionId?: string | null): ActiveMemoryConfig {
  const cfg = loadActiveMemoryConfig(home);
  if (sessionId) cfg.sessions[sessionId] = on;
  else cfg.enabled = on;
  saveActiveMemoryConfig(home, cfg);
  return cfg;
}

/** 跨会话开关：显式开才搜别的会话。 */
export function setActiveMemoryCrossSession(home: string, on: boolean): ActiveMemoryConfig {
  const cfg = loadActiveMemoryConfig(home);
  cfg.crossSession = on;
  saveActiveMemoryConfig(home, cfg);
  return cfg;
}

export type ActiveMemoryHitSource = "memory" | "knowledge" | "session";

export interface ActiveMemoryHit {
  source: ActiveMemoryHitSource;
  /** 来源定位：记忆 id / 知识库名:笔记标题 / 会话 id。 */
  ref: string;
  text: string;
  score: number;
}

export interface ActiveMemoryRecall {
  tier: "quick" | "deep";
  escalated: boolean;
  hits: ActiveMemoryHit[];
  /** 注入提示词的段落；无命中时为空字符串。 */
  text: string;
}

/** 升级门槛：quick 档命中少于这么多条就升级 deep。 */
export const ACTIVE_MEMORY_ESCALATE_MIN_HITS = 2;
/** 单条命中最多字数；整段最多字数。 */
export const ACTIVE_MEMORY_HIT_MAX_CHARS = 300;
export const ACTIVE_MEMORY_MAX_CHARS = 2000;

function clip(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function dedupeHits(hits: ActiveMemoryHit[]): ActiveMemoryHit[] {
  const seen = new Set<string>();
  const out: ActiveMemoryHit[] = [];
  for (const h of hits) {
    const key = `${h.source}:${clip(h.text, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** quick 档：MEMORY.md BM25（5 条）+ 各知识库 BM25（每库 3 条）。 */
function quickRecall(home: string, query: string, memoryPath: string): ActiveMemoryHit[] {
  const hits: ActiveMemoryHit[] = [];
  try {
    for (const { score, entry } of searchMemoryEntries(memoryPath, query, { limit: 5, home })) {
      hits.push({ source: "memory", ref: entry.id, text: clip(entry.text, ACTIVE_MEMORY_HIT_MAX_CHARS), score });
    }
  } catch { /* 记忆读失败不拦召回 */ }
  try {
    const kb = new KnowledgeBase(join(resolveNyraHome(home), "knowledge"));
    for (const base of kb.listBases()) {
      const name = String((base as { name?: unknown }).name ?? "");
      if (!name) continue;
      try {
        for (const [score, note] of kb.search(name, query, 3)) {
          hits.push({ source: "knowledge", ref: `${name}:${note.title ?? ""}`, text: clip(note.text ?? "", ACTIVE_MEMORY_HIT_MAX_CHARS), score });
        }
      } catch { /* 单个库坏了跳过，不拦别的库 */ }
    }
  } catch { /* 知识库不存在不拦召回 */ }
  return dedupeHits(hits.sort((a, b) => b.score - a.score));
}

/**
 * deep 档：放宽上限再扫一遍 + 会话全文搜索。crossSession 关时只搜本
 * 会话，开了才搜全部会话。会话片段进模型前过 sanitizeForModel 脱敏。
 */
async function deepRecall(
  home: string,
  query: string,
  memoryPath: string,
  opts: { sessionId?: string | null; crossSession: boolean },
): Promise<ActiveMemoryHit[]> {
  const hits: ActiveMemoryHit[] = [];
  try {
    for (const { score, entry } of searchMemoryEntries(memoryPath, query, { limit: 10, home })) {
      hits.push({ source: "memory", ref: entry.id, text: clip(entry.text, ACTIVE_MEMORY_HIT_MAX_CHARS), score });
    }
  } catch { /* ignore */ }
  try {
    const kb = new KnowledgeBase(join(resolveNyraHome(home), "knowledge"));
    for (const base of kb.listBases()) {
      const name = String((base as { name?: unknown }).name ?? "");
      if (!name) continue;
      try {
        for (const [score, note] of kb.searchWithOptions(name, query, { topK: 10, rerank: false })) {
          hits.push({ source: "knowledge", ref: `${name}:${note.title ?? ""}`, text: clip(note.text ?? "", ACTIVE_MEMORY_HIT_MAX_CHARS), score });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // 跨会话关且没有本会话 id 时不搜会话历史（没有作用域可守，宁可不搜）。
  if (opts.crossSession || opts.sessionId) {
    try {
      const out = await searchSessions(home, {
        query,
        limit: 5,
        snippetsPerSession: 2,
        // 跨会话关时只传本会话 id（sessionId 本身就是作用域，不过 project
        // 的 cwd 过滤——会话的工作目录未必等于当前 cwd）；开了才不传 id 搜全部。
        sessionId: opts.crossSession ? undefined : (opts.sessionId ?? null),
        scope: "all",
      });
      for (const group of out.results) {
        for (const hit of group.hits) {
          hits.push({
            source: "session",
            ref: group.session_id,
            text: clip(sanitizeForModel(hit.snippet ?? ""), ACTIVE_MEMORY_HIT_MAX_CHARS),
            score: 1,
          });
        }
      }
    } catch { /* 会话库不存在或搜失败不拦召回 */ }
  }
  return dedupeHits(hits.sort((a, b) => b.score - a.score));
}

/** 召回段落：附来源与“历史，需复核”标注；无命中返回空字符串。 */
export function formatActiveMemorySection(recall: ActiveMemoryRecall): string {
  if (!recall.hits.length) return "";
  const tierName = recall.tier === "deep" ? "深挖" : "快速召回";
  const lines = recall.hits.map((h) => {
    const label = h.source === "memory" ? "长期记忆" : h.source === "knowledge" ? "知识库" : "历史会话";
    return `- [${label} ${h.ref}] ${h.text}`;
  });
  const body = `## 主动记忆（${tierName}：回复前按当前任务召回，每条附来源；历史内容，需复核是否仍然成立，引用前先核实原文）\n${lines.join("\n")}`;
  return body.length > ACTIVE_MEMORY_MAX_CHARS ? body.slice(0, ACTIVE_MEMORY_MAX_CHARS) + "\n…（已截断）" : body;
}

/**
 * 回复前召回：先 quick，不够（少于 2 条）再升级 deep。纯只读：不改
 * 记忆、不发消息、不调模型。调用方先用 isActiveMemoryEnabled 判断
 * 开关；这里本身不查开关，CLI `test` 不开也能试跑。
 */
export async function recallBeforeReply(
  home: string,
  query: string,
  opts: { sessionId?: string | null; memoryPath?: string } = {},
): Promise<ActiveMemoryRecall> {
  const memoryPath = opts.memoryPath ?? join(resolveNyraHome(home), "MEMORY.md");
  const cfg = loadActiveMemoryConfig(home);
  const quick = quickRecall(home, query, memoryPath);
  if (quick.length >= ACTIVE_MEMORY_ESCALATE_MIN_HITS) {
    const recall: ActiveMemoryRecall = { tier: "quick", escalated: false, hits: quick, text: "" };
    recall.text = formatActiveMemorySection(recall);
    return recall;
  }
  const deep = await deepRecall(home, query, memoryPath, { sessionId: opts.sessionId, crossSession: cfg.crossSession });
  // deep 档包含 quick 的结果：按分数合并去重，quick 命中不丢。
  const merged = dedupeHits([...deep, ...quick].sort((a, b) => b.score - a.score));
  const recall: ActiveMemoryRecall = { tier: "deep", escalated: true, hits: merged, text: "" };
  recall.text = formatActiveMemorySection(recall);
  return recall;
}
