// src/sessionSearch.ts — G-P1-14 会话全文搜索 + 会话搜索做成模型工具。
// 借 Goose（SQLite FTS，全会话搜、按会话分组回摘要与命中消息）与
// OpenCode（search + read、scope 分 project/all、模型自己能搜）的想法，
// TypeScript 重写，不抄两家代码。
//
// 索引就是 src/conversations.ts 的 ConversationStore：SQLite FTS5
//（trigram 分词，缺失或短词时 LIKE 兜底），消息一记入就经触发器进索引，
// 不用全量重建；索引文件 ~/.nyra/conversations.db，损坏可删了重建
// （只丢搜索索引，不丢会话本身——会话原文另在 saveSession 的 JSON 里）。
// 本文件只做搜索、分组、导出与证据记录，不直接写索引。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ConversationStore, type MessageRow } from "./conversations.ts";
import { resolveNyraHome } from "./memory.ts";
import { EvidenceStore } from "./evidence.ts";

const SNIPPET_MAX_CHARS = 300;
const CONTEXT_MAX_CHARS = 200;

/** 命中消息（含一条上文、一条下文）。 */
export interface SessionHit {
  message_id: number;
  role: string;
  snippet: string;
  created_at: number;
  context_before: string | null;
  context_after: string | null;
}

/** 一个会话的搜索结果（Goose 的 ChatRecallResult 同款形状）。 */
export interface SessionSearchResult {
  session_id: string;
  title: string | null;
  working_dir: string | null;
  message_count: number;
  last_at: number;
  hits: SessionHit[];
}

export interface SessionSearchOutput {
  results: SessionSearchResult[];
  total_matches: number;
  total_sessions: number;
}

export interface SearchSessionsOptions {
  query?: string | null;
  scope?: "project" | "all";
  projectDir?: string | null;
  sessionId?: string | null;
  after?: number | null;
  before?: number | null;
  limit?: number;
  snippetsPerSession?: number;
}

function oneLine(text: string, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * 进模型上下文前的脱敏，与 src/runs.ts 的 redact() 同款口径：
 * ≥32 字连续词串当疑似密钥掩掉，另加 sk-/xai- 与 Bearer 与 key= 形态。
 * 写时 scrubSecrets 已扫过一遍，这里是读时第二道（旧会话里可能有
 * scrub 规则没覆盖的长串）。只用在工具返回里，CLI 直接打印用户自己
 * 的会话原文不过这道。
 */
export function sanitizeForModel(text: string): string {
  let s = text;
  const patterns = [
    /\b(?:sk|xai)-[\w-]+/g,
    /\bBearer\s+\S+/gi,
    /\b(?:api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi,
    /(?<![\w])[A-Za-z0-9+/=_-]{32,}(?![\w])/g,
  ];
  for (const p of patterns) s = s.replace(p, "[已隐藏]");
  return s;
}

/**
 * 外来会话准入闸（缺口 34）：conversations.db 里只记本机 REPL 记入的
 * 机主会话，联合会话（缺口 39）的共享内容不在库里，本来就搜不到；
 * 但有人显式拿一个联合会话 id 当 --session 过滤时，先查 sessions.json，
 * 是联合会话且里面有未准入的外来成员就拒绝——搜别人的会话须对方先
 * 过准入闸。sessions.json 读不到（没有联合会话）时当作本机会话放行。
 * circles.ts 只在函数内动态 import：它静态 import runs.ts，静态引会
 * 形成 tools→sessionSearch→circles→runs→tools 的循环导入。
 */
export async function assertSessionAdmitted(home: string, sessionId: string): Promise<void> {
  const ledgerPath = join(resolveNyraHome(home), "sessions.json");
  if (!existsSync(ledgerPath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, "utf-8"));
  } catch {
    return;
  }
  const list = (parsed as { sessions?: unknown })?.sessions;
  if (!Array.isArray(list)) return;
  const hit = list.find((s) => (s as { id?: unknown })?.id === sessionId) as
    | { members?: { identity?: unknown; kind?: unknown; left_at?: unknown }[] }
    | undefined;
  if (!hit || !Array.isArray(hit.members)) return;
  const strangers = hit.members.filter(
    (m) => m.kind === "friend" && m.left_at === null && typeof m.identity === "string",
  );
  if (!strangers.length) return;
  const { isAdmitted } = await import("./circles.ts");
  for (const m of strangers) {
    if (!isAdmitted(home, m.identity as string)) {
      throw new Error(`会话 ${sessionId} 是与 ${m.identity} 的联合会话，对方未通过准入闸，不能搜它的内容`);
    }
  }
}

/** 按会话分组：命中按会话归拢，每会话最多留 snippetsPerSession 条。 */
function groupHits(
  store: ConversationStore,
  rows: MessageRow[],
  limit: number,
  snippetsPerSession: number,
): SessionSearchResult[] {
  const meta = new Map(store.sessions().map((s) => [s.session_id, s]));
  const groups = new Map<string, SessionSearchResult>();
  for (const row of rows) {
    const g = groups.get(row.session_id);
    if (g) {
      if (g.hits.length >= snippetsPerSession) continue;
    }
    const m = meta.get(row.session_id);
    const nb = store.neighbors(row.session_id, row.id);
    const hit: SessionHit = {
      message_id: row.id,
      role: row.role,
      snippet: oneLine(row.text, SNIPPET_MAX_CHARS),
      created_at: row.created_at,
      context_before: nb.before ? oneLine(nb.before.text, CONTEXT_MAX_CHARS) : null,
      context_after: nb.after ? oneLine(nb.after.text, CONTEXT_MAX_CHARS) : null,
    };
    if (!g) {
      groups.set(row.session_id, {
        session_id: row.session_id,
        title: m?.title ?? null,
        working_dir: m?.working_dir ?? null,
        message_count: m?.count ?? 0,
        last_at: m?.last_at ?? row.created_at,
        hits: [hit],
      });
    } else {
      g.hits.push(hit);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.last_at - a.last_at)
    .slice(0, limit);
}

/**
 * 搜会话。query 为空时不搜、改列会话（OpenCode 无 query 即列会话同款）。
 * scope 默认 project：只搜当前工作目录下记的会话；all 搜全部。
 * 本批之前记的消息没有 working_dir，只进 scope=all，文档里写明了。
 */
export async function searchSessions(home: string | null | undefined, opts: SearchSessionsOptions = {}): Promise<SessionSearchOutput> {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  const limit = opts.limit === undefined ? 5 : Math.floor(opts.limit);
  if (limit <= 0) throw new Error("limit must be positive");
  const snippetsPerSession = opts.snippetsPerSession === undefined ? 3 : Math.floor(opts.snippetsPerSession);
  if (snippetsPerSession <= 0) throw new Error("snippetsPerSession must be positive");
  const scope = opts.scope === "all" ? "all" : "project";
  const projectDir = scope === "project" ? resolve(opts.projectDir ?? process.cwd()) : null;
  const store = new ConversationStore(h);
  try {
    if (opts.sessionId) await assertSessionAdmitted(h, opts.sessionId);
    const query = typeof opts.query === "string" ? opts.query.trim() : "";
    if (!query) {
      const listed = store.sessions()
        .filter((s) => projectDir === null || s.working_dir === projectDir)
        .slice(0, limit)
        .map((s) => ({
          session_id: s.session_id,
          title: s.title,
          working_dir: s.working_dir,
          message_count: s.count,
          last_at: s.last_at,
          hits: [] as SessionHit[],
        }));
      return { results: listed, total_matches: 0, total_sessions: listed.length };
    }
    const rows = store.searchWithFilters(
      query,
      {
        sessionId: opts.sessionId ?? null,
        after: opts.after ?? null,
        before: opts.before ?? null,
        workingDir: projectDir,
      },
      Math.min(200, Math.max(50, limit * snippetsPerSession * 4)),
    );
    const results = groupHits(store, rows, limit, snippetsPerSession);
    return {
      results,
      total_matches: results.reduce((n, r) => n + r.hits.length, 0),
      total_sessions: results.length,
    };
  } finally {
    store.close();
  }
}

/** 最近会话列表（CLI 无关键词时用）。 */
export async function listSessions(home: string | null | undefined, opts: { limit?: number; projectDir?: string | null } = {}): Promise<SessionSearchResult[]> {
  return (await searchSessions(home, { scope: opts.projectDir === undefined ? "all" : "project", projectDir: opts.projectDir ?? null, limit: opts.limit ?? 10 })).results;
}

/** 人读的搜索结果文本；forModel=true 时每条摘录先过脱敏再拼。 */
export function formatSessionSearchResults(output: SessionSearchOutput, opts: { forModel?: boolean } = {}): string {
  const clean = (s: string): string => (opts.forModel ? sanitizeForModel(s) : s);
  if (!output.results.length) return "没有找到相关会话。";
  const lines: string[] = [`找到 ${output.total_matches} 条命中，分属 ${output.total_sessions} 个会话：`];
  output.results.forEach((r, i) => {
    const title = r.title ? `｜${clean(r.title)}` : "";
    lines.push(`[${i + 1}] 会话 ${r.session_id}${title}（${r.message_count} 条消息，最近 ${iso(r.last_at)}）`);
    for (const h of r.hits) {
      lines.push(`    - [${h.role} ${iso(h.created_at)}] ${clean(h.snippet)}`);
      if (h.context_before) lines.push(`      上文：${clean(h.context_before)}`);
      if (h.context_after) lines.push(`      下文：${clean(h.context_after)}`);
    }
  });
  return lines.join("\n");
}

/**
 * 会话导出 Markdown（Goose export_markdown 同款，只做 Markdown、不做 HTML）。
 * 整段会话按时间顺序全文导出，写进 outPath（相对当前工作目录解析）。
 */
export async function exportSessionMarkdown(home: string | null | undefined, sessionId: string, outPath: string): Promise<{ path: string; messages: number }> {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  await assertSessionAdmitted(h, sessionId);
  const store = new ConversationStore(h);
  try {
    const meta = store.getSessionMeta(sessionId);
    const rows = store.history(sessionId, 100000);
    if (!rows.length) throw new Error(`会话 ${sessionId} 没有消息可导出`);
    const path = resolve(outPath);
    const lines: string[] = [
      `# 会话 ${sessionId}`,
      "",
      `- 标题：${meta?.title ?? "（无）"}`,
      `- 工作目录：${meta?.working_dir ?? "（未记录）"}`,
      `- 消息数：${rows.length}`,
      `- 时间范围：${iso(rows[0].created_at)} — ${iso(rows[rows.length - 1].created_at)}`,
      `- 导出时间：${new Date().toISOString()}`,
      "",
      "## 消息",
      "",
    ];
    for (const row of rows) {
      lines.push(`### [${row.role}] ${iso(row.created_at)}`, "", row.text, "");
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join("\n"), "utf-8");
    return { path, messages: rows.length };
  } finally {
    store.close();
  }
}

/** 导出进证据链的双通道记录（与 recordSessionSearch 同款口径：有运行
 * 上下文写 events.jsonl，否则写 evidence/session-search/ 证据文件；
 * 记不上不破坏导出结果本身）。 */
export async function recordSessionExport(
  home: string | undefined,
  runId: string | null,
  fields: { session_id: string; messages: number },
  citationText: string,
): Promise<{ channel: "events" | "evidence" | "none"; path?: string }> {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  if (runId) {
    for (const sub of ["runs", "tasks"]) {
      const baseDir = join(h, sub);
      if (!existsSync(join(baseDir, runId))) continue;
      try {
        const { RunStore } = await import("./runs.ts");
        new RunStore(baseDir).appendEvent(runId, "session_exported", fields);
        return { channel: "events" };
      } catch { /* 该 store 写失败就试下一个；都失败再走证据文件 */ }
    }
  }
  try {
    const path = new EvidenceStore(join(h, "evidence"), "session-search").save(
      "session_export", `session://${fields.session_id}`, citationText, null,
    );
    return { channel: "evidence", path };
  } catch {
    return { channel: "none" };
  }
}
/** 检索进证据链的双通道记录（与 knowledge.ts 的 recordKnowledgeSearch 同款口径：
 * RunStore 只在函数内动态 import，避免 tools→sessionSearch→runs→tools 循环导入）。 */
export async function recordSessionSearch(
  home: string | undefined,
  runId: string | null,
  fields: { scope: string; query: string; hits: number; sessions: number },
  citationText: string,
): Promise<{ channel: "events" | "evidence" | "none"; path?: string }> {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  if (runId) {
    for (const sub of ["runs", "tasks"]) {
      const baseDir = join(h, sub);
      if (!existsSync(join(baseDir, runId))) continue;
      try {
        const { RunStore } = await import("./runs.ts");
        new RunStore(baseDir).appendEvent(runId, "session_searched", fields);
        return { channel: "events" };
      } catch { /* 该 store 写失败就试下一个；都失败再走证据文件 */ }
    }
  }
  try {
    const path = new EvidenceStore(join(h, "evidence"), "session-search").save(
      "session_search", `session://${fields.scope}`, citationText, fields.query,
    );
    return { channel: "evidence", path };
  } catch {
    return { channel: "none" };
  }
}
