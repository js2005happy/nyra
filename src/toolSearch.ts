// src/toolSearch.ts — 工具检索（延迟加载的选择器部分，对齐 Codex 的 tool_search）。
//
// 现状：所有工具 schema 每轮全量发送。MCP 接进来以后工具数会到几十个，光 schema 就
// 吃掉可观上下文，而且模型在这一轮里根本用不到其中绝大多数。
//
// 做法（分两步）：
//   1. **选择器**：给定当前任务文本，挑出最相关的 K 个工具 + 常驻核心工具（本文件）
//   2. **检索工具**：`search_tools` 元工具（SEARCH_TOOLS_SCHEMA + searchDeferredTools +
//      formatSearchResults，本文件）+ Agent 里的延迟加载接线（src/agent.ts）：MCP 工具
//      超过 8 个时只发最相关的前 8 个，内置工具超过 18 个（含核心集 10 个）时只发
//      核心集 + 按关键词召回的最多 8 个，其余进 deferredTools，模型调 search_tools
//      拉回来；命中工具的完整定义以 JSON 返回并追加进本轮 schemas。
//
// 本文件是纯函数：不读文件、不 spawn、不改状态。排序必须可解释——每个入选/落选都要
// 说得出理由，否则出问题时没法排查"为什么这个工具没发给模型"。
import type { ToolSchemaLike } from "./toolBudget.ts";

export interface ToolSearchOptions {
  /** 最多保留多少个（含 always 列表的总数——实现是 kept = always + 前 K，见 selectTools）。默认 12。 */
  topK?: number;
  /** 永远保留的工具名（核心工具：读文件、shell、搜索等）。 */
  always?: readonly string[];
  /** 低于该分数直接丢弃（0 = 只要命中一点就留）。默认 1。 */
  minScore?: number;
  /**
   * 无命中时是否全量回退。默认 true：宁可多发也不让模型手里没有工具。
   * 只检索时关掉（searchDeferredTools 传 false）：无命中返回空列表，
   * 如实告诉模型"没匹配到"，不把全量工具都塞回去。
   */
  fallbackAll?: boolean;
}

export interface ToolScore {
  name: string;
  score: number;
  /** 命中的关键词，便于解释为什么选它。 */
  matched: string[];
}

export interface ToolSelection {
  kept: string[];
  dropped: string[];
  scores: ToolScore[];
  /** 落选但接近阈值的工具（提示模型可以用 search_tools 拉回来）。 */
  suggestions: string[];
}

/** 把名字切成可比较的词：snake_case / kebab-case / camelCase 都拆开，并保留原串。 */
export function tokenizeName(name: string): string[] {
  const raw = name ?? "";
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const whole = raw.toLowerCase();
  return [...new Set([whole, ...parts])];
}

/** 任务文本的小写词集合（含中文按 2-gram 处理，避免整句不匹配）。 */
export function tokenizeQuery(query: string): string[] {
  const q = (query ?? "").toLowerCase();
  const latin = q.split(/[^a-z0-9_]+/).filter((s) => s.length >= 2);
  const cjk = [...q].filter((c) => /[\u4e00-\u9fff]/.test(c));
  const grams: string[] = [];
  for (let i = 0; i + 1 < cjk.length; i++) grams.push(cjk[i] + cjk[i + 1]);
  return [...new Set([...latin, ...grams])];
}

function scoreOne(schema: ToolSchemaLike, queryTokens: string[], queryLower: string): ToolScore {
  const name = schema?.function?.name ?? "";
  const desc = schema?.function?.description ?? "";
  const nameTokens = tokenizeName(name);
  const descLower = desc.toLowerCase();
  const matched: string[] = [];
  let score = 0;

  for (const t of nameTokens) {
    if (t.length >= 2 && queryTokens.includes(t)) {
      score += 5; // 名字命中权重最高：说明任务就是在说这个工具
      matched.push(`name:${t}`);
    }
  }
  for (const t of queryTokens) {
    // 中文按 2-gram 切，长度天然是 2——门槛按字符类型区分，否则中文查询永远命不中描述。
    const minLen = /[\u4e00-\u9fff]/.test(t) ? 2 : 3;
    if (t.length >= minLen && descLower.includes(t)) {
      score += 1;
      matched.push(`desc:${t}`);
    }
  }
  // 名字整体出现在任务文本里（如 "用 read_file 看"）给一次性加分
  if (name && queryLower.includes(name.toLowerCase())) {
    score += 8;
    matched.push(`literal:${name}`);
  }
  return { name, score, matched };
}

/**
 * 选出本轮要发送的工具。
 *
 * 规则：
 *   - always 列表无条件保留（核心工具，缺了会直接卡死流程）
 *   - 其余按分数排序取前 K；分数 < minScore 的丢弃
 *   - 一个都没命中时（例如刚开会话、任务还没描述清楚）**回退为全量发送**——
 *     宁可多花 token，也不能让模型手里没有工具
 *   - fallbackAll: false 时无命中返回空列表（只检索时用，见 searchDeferredTools）
 */
export function selectTools(
  schemas: readonly ToolSchemaLike[],
  query: string,
  opts: ToolSearchOptions = {},
): ToolSelection {
  const topK = Math.max(1, Math.floor(opts.topK ?? 12));
  const always = new Set(opts.always ?? []);
  const minScore = opts.minScore ?? 1;
  const queryTokens = tokenizeQuery(query);
  const queryLower = (query ?? "").toLowerCase();

  const scored = schemas.map((s) => scoreOne(s, queryTokens, queryLower));
  const byName = new Map<string, ToolScore>();
  for (const s of scored) byName.set(s.name, s);

  const alwaysNames = schemas.map((s) => s?.function?.name ?? "").filter((n) => always.has(n));
  const candidates = scored
    .filter((s) => !always.has(s.name))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const picked = candidates.slice(0, Math.max(0, topK - alwaysNames.length));
  const kept = [...alwaysNames, ...picked.map((s) => s.name)];

  if (kept.length === 0) {
    if (opts.fallbackAll === false) {
      // 检索路径：无命中就是无命中，返回空列表，不全量回退。
      const all = schemas.map((s) => s?.function?.name ?? "").filter(Boolean);
      return { kept: [], dropped: all, scores: scored, suggestions: [] };
    }
    // 无命中：全量回退，绝不让模型手里没有工具
    const all = schemas.map((s) => s?.function?.name ?? "").filter(Boolean);
    return { kept: all, dropped: [], scores: scored, suggestions: [] };
  }

  const keptSet = new Set(kept);
  const dropped = schemas.map((s) => s?.function?.name ?? "").filter((n) => n && !keptSet.has(n));
  const suggestions = candidates.slice(picked.length, picked.length + 5).map((s) => s.name);

  return { kept, dropped, scores: scored.sort((a, b) => b.score - a.score), suggestions };
}

/**
 * 内置工具的常驻核心集（工具检索批：把 MCP 懒加载扩展到内置工具）。
 *
 * 定法（有依据，不是拍脑袋）：46 题评测集（~/workspace/nyra-eval-set，
 * cases/*.jsonl 的 expect.calls）里期望调用的分布——read_file 10 次、
 * list_dir / edit_file 各 5 次、shell 4 次、grep_search / web_search /
 * memory_search / write_file 各 3 次、git_status 2 次；其余 38 个内置
 * 工具在评测任务里一次都没被期望调用。核心集 = 高频 9 个 + plan：
 * plan 是“先写计划再执行”的 house 做法，多步任务动手前要它在场。
 * 核心集之外的内置工具按任务关键词召回（selectTools），无命中时只剩
 * 核心集 + search_tools（不全量回退——核心集就是安全底线；空任务时
 * agent.ts 另行全量发送，见 toolSchemas）。
 */
export const CORE_BUILTIN_TOOLS: readonly string[] = [
  "read_file",
  "list_dir",
  "grep_search",
  "shell",
  "write_file",
  "edit_file",
  "web_search",
  "memory_search",
  "git_status",
  "plan",
];

/**
 * 内置工具懒加载的上限（含核心集）：每轮最多发这么多个内置工具
 * schema（核心集 10 个 + 按关键词召回最多 8 个）。内置工具 53 个，
 * 远超上限，所以任务非空时内置懒加载总是开着；NYRA_LAZY_TOOLS=0
 * 或任务为空时全量发送（逃生口与兼容）。
 */
export const BUILTIN_LAZY_LOAD_THRESHOLD = 18;

/** 给 `search_tools` 元工具用的一句话说明（告诉模型有哪些工具没发出去、怎么拿回来）。 */
export function describeDeferred(selection: ToolSelection, total: number, label = "个工具"): string {
  if (!selection.dropped.length) return "";
  const sample = selection.dropped.slice(0, 10).join("、");
  return `本轮未发送 ${selection.dropped.length}/${total} ${label}（${sample}${selection.dropped.length > 10 ? "…" : ""}）。需要时调用 search_tools 检索后使用。`;
}

/** 人类可读的排序解释（doctor / 排障用）。 */
export function explainSelection(selection: ToolSelection): string {
  const top = selection.scores.filter((s) => s.score > 0).slice(0, 8);
  if (!top.length) return "本轮无关键词命中，已全量发送（避免模型手里没有工具）";
  return top.map((s) => `${s.name}(${s.score}${s.matched.length ? `: ${s.matched.join(",")}` : ""})`).join("；");
}

// ---- 延迟加载第二步：search_tools 元工具 ----
//
// 只返回命中工具的完整定义（JSON），不返回全部 schema——检索本身不能
// 又把上下文撑大。schema 与检索/格式化是纯函数（本文件）；接线（把命中
// 工具追加进本轮 schemas）由 Agent 在分派循环里做（src/agent.ts）。

/** search_tools 的 schema：只发名字 + 描述，完整定义由检索命中后返回。 */
export const SEARCH_TOOLS_SCHEMA: Record<string, unknown> = {
  type: "function",
  function: {
    name: "search_tools",
    description: "检索工具。当前只发送了核心工具；需要其他能力（更多内置工具、MCP、生图、浏览器等）时先用它按关键词检索，命中的工具会在下一轮可用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要做什么，例如「读取.env」「调用浏览器截图」「检索记忆库」" },
        limit: { type: "number", description: "最多返回几个，默认 8" },
      },
      required: ["query"],
    },
  },
};

/**
 * 在延迟加载剩下的工具里检索。无命中返回空列表（fallbackAll: false），
 * 不全量回退——检索的回答是"没匹配到"，不是"把所有工具都放开"。
 */
export function searchDeferredTools(
  deferred: readonly ToolSchemaLike[],
  query: string,
  limit = 8,
): ToolSelection {
  return selectTools(deferred, query, {
    topK: Math.max(1, Math.min(20, Math.floor(limit) || 8)),
    fallbackAll: false,
  });
}

/**
 * 检索结果格式化：命中工具的完整定义以 JSON 返回（模型下一轮直接按
 * 定义调用）。无命中时如实说没匹配到，不编造工具名。
 */
export function formatSearchResults(
  selection: ToolSelection,
  deferred: readonly ToolSchemaLike[],
): string {
  if (!selection.kept.length) return "没有匹配到工具：换个关键词再试，或直接描述要做的事。";
  const byName = new Map(deferred.map((s) => [s?.function?.name ?? "", s]));
  const defs = selection.kept.map((n) => byName.get(n)).filter((d): d is ToolSchemaLike => d !== undefined);
  return JSON.stringify(defs, null, 2);
}
