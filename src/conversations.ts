// src/conversations.ts — SQLite 对话存档与检索，与 Python 版 nyra/conversations.py 同语义。
// NYRA_HOME/conversations.db（新建 0600）；FTS5 三元组分词，缺失时 LIKE 兜底；
// 存前过 scrubSecrets；批量写库必须显式包事务（见 batchRecord）。
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scrubSecrets } from "./memoryExchange.ts";

export const SCHEMA_VERSION = 1;
const DB_NAME = "conversations.db";
const TOKEN_RE = /[\p{L}\p{N}_]+/gu; // JS 的 \w 不含中文，Python 的 \w 是 Unicode 感知的，用属性类对齐
const FTS5_MIN_TOKEN_LEN = 3;
const SNIPPET_MAX_CHARS = 300;
const ROLES = new Set(["user", "assistant", "tool", "system"]);

export interface MessageRow {
  id: number; session_id: string; role: string; text: string;
  tool_name: string | null; created_at: number; score?: number;
}

/** G-P1-14：会话搜索的过滤条件（全是可选；workingDir 只认 session_meta
 * 里记下的工作目录，本批之前记的消息没有 working_dir，只进 scope=all）。 */
export interface SessionSearchFilters {
  sessionId?: string | null;
  after?: number | null;
  before?: number | null;
  workingDir?: string | null;
}

export function tokensOf(query: string): string[] {
  if (typeof query !== "string") return [];
  return query.match(TOKEN_RE) ?? [];
}

export function fts5Supported(): boolean {
  try {
    const probe = new DatabaseSync(":memory:");
    try { probe.exec("CREATE VIRTUAL TABLE _probe USING fts5(x, tokenize='trigram')"); } finally { probe.close(); }
    return true;
  } catch { return false; }
}

export class ConversationStore {
  home: string;
  dbPath: string;
  private conn: DatabaseSync;
  private fts5 = false;

  constructor(home?: string | null, opts?: { useFts5?: boolean | null }) {
    this.home = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
    try { mkdirSync(this.home, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    try { chmodSync(this.home, 0o700); } catch { /* ignore */ }
    this.dbPath = join(this.home, DB_NAME);
    const created = !existsSync(this.dbPath);
    this.conn = new DatabaseSync(this.dbPath);
    this.migrate(opts?.useFts5 ?? null);
    if (created) {
      try { chmodSync(this.dbPath, 0o600); } catch { /* ignore */ }
    }
  }

  private migrate(useFts5: boolean | null): void {
    this.conn.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    this.conn.exec(
      "CREATE TABLE IF NOT EXISTS messages(" +
      "id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, " +
      "text TEXT NOT NULL, tool_name TEXT, created_at REAL NOT NULL)",
    );
    this.conn.exec("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)");
    // G-P1-14 会话全文搜索：会话元数据（工作目录 + 标题），scope=project
    // 按 working_dir 过滤就靠这张表；老库没有这张表时本次 open 即建，不升 schema 版。
    this.conn.exec(
      "CREATE TABLE IF NOT EXISTS session_meta(" +
      "session_id TEXT PRIMARY KEY, working_dir TEXT, title TEXT, " +
      "first_at REAL NOT NULL, last_at REAL NOT NULL)",
    );
    const row = this.conn.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const version = row ? parseInt(row.value, 10) : 0;
    void version; // v1 为基线 schema，无需 ALTER。
    this.fts5 = this.enableFts5(useFts5);
    this.conn.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  private enableFts5(useFts5: boolean | null): boolean {
    if (useFts5 === false) return false;
    if (useFts5 === null && !fts5Supported()) return false;
    try {
      const existed = this.conn.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'",
      ).get();
      this.conn.exec("SAVEPOINT nyra_fts5");
      this.conn.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts " +
        "USING fts5(text, content='messages', content_rowid='id', tokenize='trigram')",
      );
      this.conn.exec(
        "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN " +
        "INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END",
      );
      this.conn.exec(
        "CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN " +
        "INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); END",
      );
      this.conn.exec(
        "CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN " +
        "INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); " +
        "INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END",
      );
      if (!existed) this.conn.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      this.conn.exec("RELEASE nyra_fts5");
    } catch {
      try { this.conn.exec("ROLLBACK TO nyra_fts5"); this.conn.exec("RELEASE nyra_fts5"); } catch { /* ignore */ }
      if (useFts5 === true) throw new Error("FTS5 was requested but this sqlite3 cannot build it");
      return false;
    }
    return true;
  }

  get fts5Available(): boolean { return this.fts5; }

  get schemaVersion(): number {
    const row = this.conn.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  close(): void { this.conn.close(); }

  record(sessionId: string, role: string, text: string, toolName: string | null = null, createdAt?: number | null, opts?: { workingDir?: string | null }): number | null {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("session_id must be a non-empty string");
    if (typeof role !== "string" || !role.trim()) throw new Error("role must be a non-empty string");
    if (!ROLES.has(role)) throw new Error(`role must be one of user, assistant, tool, system: ${role}`);
    if (typeof text !== "string" || !text.trim()) throw new Error("text must be a non-empty string");
    const [cleaned] = scrubSecrets(text);
    if (!cleaned.trim()) return null;
    const stamp = createdAt === null || createdAt === undefined ? Date.now() / 1000 : Number(createdAt);
    const stmt = this.conn.prepare(
      "INSERT INTO messages(session_id, role, text, tool_name, created_at) VALUES(?, ?, ?, ?, ?)",
    );
    const info = stmt.run(sessionId, role, cleaned, toolName, stamp);
    this.touchSessionMeta(sessionId, role, cleaned, stamp, opts?.workingDir ?? null);
    return Number(info.lastInsertRowid);
  }

  /** 记一笔会话元数据：工作目录只认调用方给的（不给不覆盖旧值），标题取
   * 首条用户消息前 120 字（已有标题不再改写）；first/last 取极值。 */
  private touchSessionMeta(sessionId: string, role: string, text: string, stamp: number, workingDir: string | null): void {
    const existing = this.conn.prepare(
      "SELECT working_dir, title FROM session_meta WHERE session_id = ?",
    ).get(sessionId) as { working_dir: string | null; title: string | null } | undefined;
    const title = existing?.title ?? (role === "user" ? text.replace(/\s+/g, " ").slice(0, 120) : null);
    const dir = workingDir ?? existing?.working_dir ?? null;
    this.conn.prepare(
      "INSERT INTO session_meta(session_id, working_dir, title, first_at, last_at) VALUES(?, ?, ?, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET " +
      "working_dir = COALESCE(excluded.working_dir, session_meta.working_dir), " +
      "title = COALESCE(session_meta.title, excluded.title), " +
      "first_at = MIN(session_meta.first_at, excluded.first_at), " +
      "last_at = MAX(session_meta.last_at, excluded.last_at)",
    ).run(sessionId, dir, title, stamp, stamp);
  }

  getSessionMeta(sessionId: string): { session_id: string; working_dir: string | null; title: string | null; first_at: number; last_at: number } | null {
    const row = this.conn.prepare(
      "SELECT session_id, working_dir, title, first_at, last_at FROM session_meta WHERE session_id = ?",
    ).get(sessionId) as { session_id: string; working_dir: string | null; title: string | null; first_at: number; last_at: number } | undefined;
    return row ?? null;
  }

  /** 取一条消息在同一会话里的前后邻居（搜命中消息的上下文用）。 */
  neighbors(sessionId: string, id: number): { before: MessageRow | null; after: MessageRow | null } {
    const before = this.conn.prepare(
      "SELECT id, session_id, role, text, tool_name, created_at FROM messages " +
      "WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT 1",
    ).get(sessionId, id) as MessageRow | undefined;
    const after = this.conn.prepare(
      "SELECT id, session_id, role, text, tool_name, created_at FROM messages " +
      "WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT 1",
    ).get(sessionId, id) as MessageRow | undefined;
    return { before: before ?? null, after: after ?? null };
  }

  /** 批量写库：显式包一个事务（第 0 阶段实测：不包事务 100 行 7130ms，包事务 49ms）。 */
  batchRecord(rows: { sessionId: string; role: string; text: string; toolName?: string | null; createdAt?: number | null; workingDir?: string | null }[]): (number | null)[] {
    const out: (number | null)[] = [];
    this.conn.exec("BEGIN");
    try {
      for (const r of rows) out.push(this.record(r.sessionId, r.role, r.text, r.toolName ?? null, r.createdAt ?? null, { workingDir: r.workingDir ?? null }));
      this.conn.exec("COMMIT");
    } catch (err) {
      try { this.conn.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
    return out;
  }

  history(sessionId: string, limit = 50): MessageRow[] {
    if (limit <= 0) throw new Error("limit must be positive");
    const rows = this.conn.prepare(
      "SELECT id, session_id, role, text, tool_name, created_at FROM messages " +
      "WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(sessionId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  sessions(): { session_id: string; count: number; last_at: number; working_dir: string | null; title: string | null }[] {
    const rows = this.conn.prepare(
      "SELECT m.session_id AS session_id, COUNT(*) AS n, MAX(m.created_at) AS last_at, " +
      "sm.working_dir AS working_dir, sm.title AS title FROM messages m " +
      "LEFT JOIN session_meta sm ON sm.session_id = m.session_id " +
      "GROUP BY m.session_id ORDER BY last_at DESC",
    ).all() as { session_id: string; n: number; last_at: number; working_dir: string | null; title: string | null }[];
    return rows.map((r) => ({ session_id: r.session_id, count: r.n, last_at: r.last_at, working_dir: r.working_dir, title: r.title }));
  }

  search(query: string, limit = 5): MessageRow[] {
    return this.searchWithFilters(query, {}, limit);
  }

  searchWithFilters(query: string, filters: SessionSearchFilters = {}, limit = 5): MessageRow[] {
    if (limit <= 0) throw new Error("limit must be positive");
    const tokens = tokensOf(query);
    if (!tokens.length) return [];
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (filters.sessionId) { conds.push("m.session_id = ?"); params.push(filters.sessionId); }
    if (typeof filters.after === "number") { conds.push("m.created_at >= ?"); params.push(filters.after); }
    if (typeof filters.before === "number") { conds.push("m.created_at <= ?"); params.push(filters.before); }
    if (filters.workingDir) { conds.push("m.session_id IN (SELECT session_id FROM session_meta WHERE working_dir = ?)"); params.push(filters.workingDir); }
    const extra = conds.length ? " AND " + conds.join(" AND ") : "";
    if (this.fts5 && tokens.every((t) => t.length >= FTS5_MIN_TOKEN_LEN)) return this.searchFts5(tokens, limit, extra, params);
    return this.searchLike(tokens, limit, extra, params);
  }

  private searchFts5(tokens: string[], limit: number, extra = "", extraParams: (string | number)[] = []): MessageRow[] {
    const matchExpr = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const rows = this.conn.prepare(
      "SELECT m.id, m.session_id, m.role, m.text, m.tool_name, m.created_at, messages_fts.rank AS rank " +
      "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid " +
      `WHERE messages_fts MATCH ?${extra} ORDER BY rank LIMIT ?`,
    ).all(matchExpr, ...extraParams, limit) as unknown as (MessageRow & { rank: number })[];
    return rows.map((r) => ({ ...r, score: -Number(r.rank) }));
  }

  private searchLike(tokens: string[], limit: number, extra = "", extraParams: (string | number)[] = []): MessageRow[] {
    const lowered = tokens.map((t) => t.toLowerCase());
    const where = lowered.map(() => "instr(lower(m.text), ?) > 0").join(" OR ");
    const rows = this.conn.prepare(
      `SELECT m.id, m.session_id, m.role, m.text, m.tool_name, m.created_at FROM messages m WHERE (${where})${extra} LIMIT 200`,
    ).all(...lowered, ...extraParams) as unknown as MessageRow[];
    const scored: MessageRow[] = [];
    for (const row of rows) {
      const textLower = row.text.toLowerCase();
      const overlap = lowered.filter((t) => textLower.includes(t)).length;
      if (overlap) scored.push({ ...row, score: overlap });
    }
    scored.sort((a, b) => (b.score! - a.score!) || (b.created_at - a.created_at));
    return scored.slice(0, limit);
  }

  retrieveContext(query: string, limit = 5, maxChars = 2000): string {
    if (limit <= 0) throw new Error("limit must be positive");
    if (maxChars <= 0) throw new Error("max_chars must be positive");
    const hits = this.search(query, limit);
    if (!hits.length) return "";
    const header = "以下是与当前问题相关的过往对话（仅供参考）：";
    if (header.length >= maxChars) return header.slice(0, maxChars);
    const lines = [header];
    let used = header.length + 1;
    for (const hit of hits) {
      let snippet = hit.text.split(/\s+/).join(" ");
      if (snippet.length > SNIPPET_MAX_CHARS) snippet = snippet.slice(0, SNIPPET_MAX_CHARS - 1) + "…";
      let line = `- [${hit.role}] ${snippet}`;
      if (used + line.length > maxChars) {
        const room = maxChars - used;
        if (room < 20) break;
        snippet = snippet.slice(0, Math.max(room - hit.role.length - 5, 0));
        line = `- [${hit.role}] ${snippet}…`;
        if (line.length > maxChars - used) break;
        lines.push(line);
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  prune(days = 90): number {
    if (days < 0) throw new Error("days must not be negative");
    const cutoff = Date.now() / 1000 - days * 86400;
    const info = this.conn.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
    return Number(info.changes);
  }

  // -- rewind（第 3 阶段，/rewind）：基于 SQLite 存储，任意消息可回退 /
  // 编辑重发 / fork。原会话的已删消息不恢复；操作只删本会话内该消息
  // 之后的行，绝不碰其他会话。
  getMessage(id: number): MessageRow | null {
    const row = this.conn.prepare(
      "SELECT id, session_id, role, text, tool_name, created_at FROM messages WHERE id = ?",
    ).get(id) as unknown as MessageRow | undefined;
    return row ?? null;
  }

  /** 删掉 sessionId 里 id 之后（含该消息之后）的全部消息，返回删掉的行数。 */
  deleteAfter(sessionId: string, id: number): number {
    const target = this.getMessage(id);
    if (!target) throw new Error(`消息不存在：${id}`);
    if (target.session_id !== sessionId) throw new Error(`消息 ${id} 不属于会话 ${sessionId}`);
    const info = this.conn.prepare(
      "DELETE FROM messages WHERE session_id = ? AND id > ?",
    ).run(sessionId, id);
    return Number(info.changes);
  }

  /** 删掉 sessionId 里指定时刻之后记入的消息（影子快照无持久化水位时用），返回删掉的行数。 */
  deleteAfterTime(sessionId: string, afterUnix: number): number {
    if (typeof afterUnix !== "number" || !Number.isFinite(afterUnix)) throw new Error("afterUnix must be a finite number");
    const info = this.conn.prepare(
      "DELETE FROM messages WHERE session_id = ? AND created_at > ?",
    ).run(sessionId, afterUnix);
    return Number(info.changes);
  }

  /** 改写一条消息的文本（编辑重发用；存前同样过 scrubSecrets）。 */
  updateMessageText(id: number, text: string): MessageRow {
    const target = this.getMessage(id);
    if (!target) throw new Error(`消息不存在：${id}`);
    if (typeof text !== "string" || !text.trim()) throw new Error("text must be a non-empty string");
    const [cleaned] = scrubSecrets(text);
    if (!cleaned.trim()) throw new Error("改写后的消息为空（可能只剩凭据内容）");
    this.conn.prepare("UPDATE messages SET text = ? WHERE id = ?").run(cleaned, id);
    const updated = this.getMessage(id);
    if (!updated) throw new Error(`消息不存在：${id}`);
    return updated;
  }

  /** 把 sessionId 里截至 id（含）的消息复制到新会话，返回复制的行数。 */
  copyUpTo(sessionId: string, id: number, newSessionId: string): number {
    const target = this.getMessage(id);
    if (!target) throw new Error(`消息不存在：${id}`);
    if (target.session_id !== sessionId) throw new Error(`消息 ${id} 不属于会话 ${sessionId}`);
    if (!newSessionId || typeof newSessionId !== "string") throw new Error("新会话 id 无效");
    const rows = this.conn.prepare(
      "SELECT role, text, tool_name, created_at FROM messages WHERE session_id = ? AND id <= ? ORDER BY id ASC",
    ).all(sessionId, id) as { role: string; text: string; tool_name: string | null; created_at: number }[];
    this.conn.exec("BEGIN");
    try {
      for (const r of rows) {
        this.conn.prepare(
          "INSERT INTO messages(session_id, role, text, tool_name, created_at) VALUES(?, ?, ?, ?, ?)",
        ).run(newSessionId, r.role, r.text, r.tool_name, r.created_at);
      }
      // G-P1-14：分叉的新会话继承原会话的元数据（工作目录 + 标题），否则
      // 新会话在 scope=project 里永远搜不到。
      this.conn.prepare(
        "INSERT OR REPLACE INTO session_meta(session_id, working_dir, title, first_at, last_at) " +
        "SELECT ?, working_dir, title, first_at, last_at FROM session_meta WHERE session_id = ?",
      ).run(newSessionId, sessionId);
      this.conn.exec("COMMIT");
    } catch (err) {
      try { this.conn.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
    return rows.length;
  }
}
