// src/memory.ts — 长期记忆与会话历史，与 Python 版 nyra/memory.py 同语义。
// 会话文件原子写（tmp + replace，0600）；spec 07 第 1 条原子迁移与第 7 条权限
// （~/.nyra 0700、会话/日志 0600）在此落地。
import { randomBytes, createHash } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeSync, appendFileSync, writeFileSync,
} from "node:fs";
import { join, relative, sep, dirname, basename } from "node:path";
import { pythonJsonDump } from "./pyjson.ts";
import { tokenize, scoreBm25 } from "./knowledge.ts";
import { listSoulAgents, loadSoul, type SoulTenet, type TenetKind } from "./soul.ts";

export function resolveNyraHome(homeOverride?: string): string {
  if (homeOverride) return homeOverride;
  return process.env.NYRA_HOME ?? process.env.ANGEL_HOME ?? join(process.env.HOME ?? "", ".nyra");
}

export function loadMemorySummary(maxLines = 40, path?: string, home?: string): string {
  const target = path ?? join(resolveNyraHome(home), "MEMORY.md");
  if (!existsSync(target) || maxLines <= 0) return "";
  const raw = readFileSync(target, "utf-8").split("\n");
  // 与 Python str.splitlines() 同语义：末尾换行不产生空行。
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  const lines = raw.slice(-maxLines);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

export function appendMemory(text: string, path?: string, home?: string, now?: Date, sourceSession?: string | null): void {
  const single = text.split("\n").join(" ").trim();
  if (!single) return;
  const target = path ?? join(resolveNyraHome(home), "MEMORY.md");
  mkdirSync(join(target, ".."), { recursive: true });
  const d = now ?? new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  appendFileSync(target, `- [${stamp}] ${single}\n`, "utf-8");
  // 新行进 sidecar 索引时记下来源会话（缺口 2 的删除按会话查就靠它）；
  // 索引写失败绝不能破坏追加本身。
  try {
    syncMemoryIndex(target, memoryOwnerForPath(target, home), { sessionIdForNew: sourceSession ?? undefined });
  } catch { /* ignore */ }
}

export function loadAgentsMd(workdir: string, home?: string): string {
  const globalPath = join(resolveNyraHome(home), "AGENTS.md");
  const sections: string[] = [];
  const sources: [string, string][] = [
    [join(workdir, "AGENTS.md"), "# 项目说明（AGENTS.md）\n"],
    [globalPath, "# 全局说明（~/.nyra/AGENTS.md）\n"],
  ];
  for (const [path, heading] of sources) {
    if (existsSync(path)) sections.push(heading + readFileSync(path, "utf-8"));
  }
  return sections.join("\n\n");
}

export function newSessionId(now?: Date): string {
  const d = now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

export function sessionPath(sessionId: string, home?: string): string {
  if (
    !sessionId || typeof sessionId !== "string" || sessionId.includes("..") ||
    [...sessionId].some((c) => "/\\:\x00".includes(c))
  ) {
    throw new Error("会话 ID 无效");
  }
  return join(resolveNyraHome(home), "sessions", `${sessionId}.jsonl`);
}

export function sessionsDir(home?: string): string {
  return join(resolveNyraHome(home), "sessions");
}

/** 原子写会话：同目录 tmp（0600）+ fsync + replace；失败不损坏旧会话。 */
export function saveSession(sessionId: string, messages: Record<string, unknown>[], home?: string): string {
  const path = sessionPath(sessionId, home);
  const dir = sessionsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  const tmp = join(dir, `.nyra-session-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      const data = messages.map((m) => pythonJsonDump(m)).join("\n") + (messages.length ? "\n" : "");
      writeSync(fd, data, null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== "win32") {
      try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
    }
    renameSync(tmp, path);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  return path;
}

export function loadSession(sessionId: string, home?: string): Record<string, unknown>[] | null {
  let path: string;
  try {
    path = sessionPath(sessionId, home);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  const messages: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as unknown;
      if (msg && typeof msg === "object") messages.push(msg as Record<string, unknown>);
    } catch { /* 跳过损坏行 */ }
  }
  return messages;
}

export interface SessionMeta {
  id: string;
  preview: string;
  count: number;
  mtime: string;
}

// ---- 缺口 1 + 缺口 2（2026-11-20）：结构化记忆条目 + sidecar 索引 ----
//
// MEMORY.md 本身不动（仍是纯文本、一行一条，手工能改）；结构化信息
// （id + 来源会话 + 时间戳）存在同目录的 sidecar 索引文件
// `<记忆文件>.index.json` 里。索引是派生的：行内容没变则 id 不变，
// 新行分配新 id，删掉的行从索引里消失；索引丢了或损坏就按当前文件
// 重建，不丢记忆正文。向量检索另算，本批只做 BM25。
//
// owner（作用域）：记忆文件本身定——全局 MEMORY.md 是 "global"，
// 群机器人 `<home>/groups/<room>/bots/<bot>/MEMORY.md` 是
// `bot:<room>/<bot>`。删除与检索都先核 owner，跨 owner 不读不删。

export class MemoryError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryError"; }
}

/** 删除被拦下的原因（整批拒绝、不删任何东西）。 */
export class MemoryDeleteError extends MemoryError {
  reason: "session_running" | "revision_conflict";
  blockedIds: string[];
  sessionId?: string;
  constructor(reason: "session_running" | "revision_conflict", message: string, blockedIds: string[] = [], sessionId?: string) {
    super(message);
    this.name = "MemoryDeleteError";
    this.reason = reason;
    this.blockedIds = blockedIds;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

export interface MemoryEntry {
  /** 稳定 id：`mem_` + 12 位十六进制，索引丢失重建后会变，删除时以当次查到的 id 为准。 */
  id: string;
  /** 正文（去掉行首 `- [时间戳] ` 前缀后的内容；非标准行则为整行去空白）。 */
  text: string;
  /** 原始行（含前缀），删除时按行号定位用它比对。 */
  raw: string;
  /** 在文件中的行号（1 起）。 */
  line: number;
  /** 时间戳：行内 `[YYYY-MM-DD HH:MM]` 或索引里记的创建时间；未知为空。 */
  created_at: string;
  /** 写入这条记忆的会话 id；手工写 / 旧行 / 未知为 null。 */
  source_session: string | null;
  owner: string;
  source_file: string;
}

export interface MemoryIndexEntry {
  id: string;
  hash: string;
  line: number;
  created_at: string;
  source_session: string | null;
}

const MEMORY_LINE_RE = /^-\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)$/;
const MEMORY_ID_RE = /^mem_[0-9a-f]{12}$/;

/** 记忆文件对应的 owner：群机器人文件是 bot:<room>/<bot>，其余一律 global。 */
export function memoryOwnerForPath(memoryPath: string, home?: string): string {
  const root = resolveNyraHome(home);
  const rel = relative(root, memoryPath).split(sep).join("/");
  const m = /^groups\/([a-z][a-z0-9_-]{0,31})\/bots\/([A-Za-z0-9_.-]+)\/MEMORY\.md$/.exec(rel);
  return m ? `bot:${m[1]}/${m[2]}` : "global";
}

export function memoryIndexPath(memoryPath: string): string {
  return `${memoryPath}.index.json`;
}

function memoryLineHash(raw: string): string {
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

function parseMemoryLine(raw: string): { text: string; created_at: string } {
  const m = MEMORY_LINE_RE.exec(raw);
  if (m) return { text: m[2].trim(), created_at: m[1] };
  return { text: raw.trim(), created_at: "" };
}

/** 原子写用的同目录 tmp 路径：文件名只取 basename，绝不把目标路径本身拼进去。
 *  Windows 路径用反斜杠，`targetPath.split("/").pop()` 切不开整串绝对路径，
 *  会把 `C:\...` 嵌进 tmp 文件名（组件里带冒号），`openSync` 报 ENOENT——
 *  Node CI #156（6de24e7）只有 Windows 任务失败的根因；`basename` 两种
 *  分隔符都能处理，POSIX 上行为不变。`pathMod` 参数只为测试注入
 *  `node:path/win32`，生产调用一律用默认的本机 path。 */
export function atomicTmpPath(
  targetPath: string,
  pathMod: Pick<typeof import("node:path"), "join" | "dirname" | "basename"> = { join, dirname, basename },
): string {
  return pathMod.join(
    pathMod.dirname(targetPath),
    `.${pathMod.basename(targetPath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
}

/** 原子写 sidecar 索引（同目录 tmp 0600 + rename；失败不损坏旧索引）。 */
function saveMemoryIndex(memoryPath: string, owner: string, entries: MemoryIndexEntry[]): void {
  const indexPath = memoryIndexPath(memoryPath);
  mkdirSync(join(indexPath, ".."), { recursive: true });
  const data = JSON.stringify({ version: 1, owner, entries }, null, 2) + "\n";
  const tmp = atomicTmpPath(indexPath);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, indexPath);
}

function loadMemoryIndex(memoryPath: string, owner: string): MemoryIndexEntry[] {
  const indexPath = memoryIndexPath(memoryPath);
  if (!existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(readFileSync(indexPath, "utf-8")) as Record<string, unknown>;
    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) return [];
    if (typeof data.owner === "string" && data.owner !== owner) return [];
    const out: MemoryIndexEntry[] = [];
    for (const e of data.entries as unknown[]) {
      if (!e || typeof e !== "object") continue;
      const rec = e as Record<string, unknown>;
      if (typeof rec.id !== "string" || !MEMORY_ID_RE.test(rec.id)) continue;
      if (typeof rec.hash !== "string" || !/^[0-9a-f]{64}$/.test(rec.hash)) continue;
      out.push({
        id: rec.id,
        hash: rec.hash,
        line: typeof rec.line === "number" ? rec.line : 0,
        created_at: typeof rec.created_at === "string" ? rec.created_at : "",
        source_session: typeof rec.source_session === "string" ? rec.source_session : null,
      });
    }
    return out;
  } catch {
    return []; // 索引损坏就重建，不丢记忆正文。
  }
}

function readMemoryLines(memoryPath: string): string[] {
  if (!existsSync(memoryPath)) return [];
  const raw = readFileSync(memoryPath, "utf-8").split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  return raw;
}

/**
 * 按当前文件内容同步 sidecar 索引并返回结构化条目。
 * 内容没变（hash 命中）的行保留旧 id / 时间戳 / 来源会话；新行分配
 * 新 id（`sessionIdForNew` 有值时记为其来源会话）；已删的行出索引。
 */
export function syncMemoryIndex(
  memoryPath: string,
  owner: string,
  opts: { sessionIdForNew?: string } = {},
): MemoryEntry[] {
  const lines = readMemoryLines(memoryPath);
  const sourceFile = memoryPath;
  if (!existsSync(memoryPath)) return [];
  const old = loadMemoryIndex(memoryPath, owner);
  const byHash = new Map<string, MemoryIndexEntry[]>();
  for (const e of old) {
    const list = byHash.get(e.hash) ?? [];
    list.push(e);
    byHash.set(e.hash, list);
  }
  const indexEntries: MemoryIndexEntry[] = [];
  const entries: MemoryEntry[] = [];
  const nowIso = new Date().toISOString().slice(0, 19);
  lines.forEach((raw, i) => {
    if (!raw.trim()) return; // 空行不是记忆条目。
    const hash = memoryLineHash(raw);
    const { text, created_at } = parseMemoryLine(raw);
    const reused = byHash.get(hash)?.shift();
    const id = reused?.id ?? `mem_${randomBytes(6).toString("hex")}`;
    const entryCreated = reused?.created_at || created_at || nowIso;
    // 已有条目保留原来的来源（包括“未记录”的 null）；只有新行才记本次会话。以前用 ?? 会把 null 来源
    // 顶成下一次追加的会话 id，记忆卡上就会把手工写的条目错标成“来自某对话”。
    const sourceSession = reused ? reused.source_session : (opts.sessionIdForNew ?? null);
    const line = i + 1;
    indexEntries.push({ id, hash, line, created_at: entryCreated, source_session: sourceSession });
    entries.push({ id, text, raw, line, created_at: entryCreated, source_session: sourceSession, owner, source_file: sourceFile });
  });
  saveMemoryIndex(memoryPath, owner, indexEntries);
  return entries;
}

/** 列出当前记忆文件里的全部结构化条目（读不到文件时为空数组）。 */
export function listMemoryEntries(memoryPath: string, home?: string): MemoryEntry[] {
  return syncMemoryIndex(memoryPath, memoryOwnerForPath(memoryPath, home));
}

export interface MemorySearchHit {
  score: number;
  entry: MemoryEntry;
}

/**
 * 缺口 1：BM25 检索记忆（复用 knowledge.ts 已有的 tokenize + scoreBm25，
 * 与知识库同一套公式）。作用域过滤：owner 不符直接拒绝（不跨 owner 读），
 * session_id 有值时只看该会话写的记忆。向量检索另算。
 */
export function searchMemoryEntries(
  memoryPath: string,
  query: string,
  opts: { limit?: number; session_id?: string; owner?: string; home?: string } = {},
): MemorySearchHit[] {
  const owner = memoryOwnerForPath(memoryPath, opts.home);
  if (opts.owner !== undefined && opts.owner !== owner) {
    throw new MemoryError(`记忆 owner 不符：当前记忆文件属于 ${owner}，不能按 ${opts.owner} 检索`);
  }
  const limit = Math.max(1, Math.floor(opts.limit ?? 5));
  let entries = listMemoryEntries(memoryPath, opts.home);
  if (opts.session_id !== undefined) entries = entries.filter((e) => e.source_session === opts.session_id);
  const queryTokens = tokenize(query || "");
  if (!entries.length || !queryTokens.length) return [];
  const docTokens = entries.map((e) => tokenize(e.text));
  return scoreBm25(queryTokens, docTokens, limit).map(([score, i]) => ({ score, entry: entries[i] }));
}

/** 每条检索结果附来源（记忆 id、来源会话、时间戳、文件行号），与证据链同口径。 */
export function formatMemorySearchResults(results: readonly MemorySearchHit[]): string {
  const lines = results.map(({ score, entry }) => {
    const text = entry.text.length > 200 ? entry.text.slice(0, 200) + "…" : entry.text;
    const when = entry.created_at || "时间未记录";
    const session = entry.source_session ?? "未记录";
    return `- [${entry.id}] ${text}\n  来源：${entry.source_file} 第 ${entry.line} 行；会话 ${session}；${when}；相关度 ${score.toFixed(2)}`;
  });
  return lines.join("\n");
}

const MEMORY_SECTION_MAX_CHARS = 2000;

/**
 * 缺口 1：主循环提示词里的记忆段——按需检索替代无条件读最后 40 行。
 * 有命中时只注入命中的条目（附来源）；无命中时回落到最后 40 行，
 * 记忆为空时返回 ""（零影响）。
 */
export function buildMemorySection(memoryPath: string, home: string | undefined, task: string): string {
  let hits: MemorySearchHit[] = [];
  try {
    hits = searchMemoryEntries(memoryPath, task, { limit: 5, home });
  } catch {
    hits = [];
  }
  if (hits.length) {
    const body = formatMemorySearchResults(hits);
    const text = "## 长期记忆（按需检索：与当前任务相关，每条附来源；历史记忆，需复核是否仍然成立）\n" + body;
    return text.length > MEMORY_SECTION_MAX_CHARS ? text.slice(0, MEMORY_SECTION_MAX_CHARS) + "\n…（已截断）" : text;
  }
  const tail = loadMemorySummary(40, memoryPath, home);
  return tail ? "## 长期记忆\n" + tail : "";
}

export interface MemoryDeleteTarget {
  targets: MemoryEntry[];
  notFound: string[];
  skipped: { id: string; reason: string }[];
  total: number;
  /** 删完这些目标后剩下的条数（预览用，删除前算）。 */
  remaining: number;
}

/** 解析删除目标（不改文件）：按 id 或按来源会话圈定，owner 不符的只跳过不删。 */
export function previewMemoryDelete(
  memoryPath: string,
  opts: { ids?: string[]; session_id?: string; owner?: string; home?: string } = {},
): MemoryDeleteTarget {
  const entries = listMemoryEntries(memoryPath, opts.home);
  const owner = memoryOwnerForPath(memoryPath, opts.home);
  const targets: MemoryEntry[] = [];
  const notFound: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  if (opts.ids !== undefined && opts.ids.length > 0) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const id of opts.ids) {
      const entry = byId.get(id);
      if (!entry) { notFound.push(id); continue; }
      if (opts.owner !== undefined && opts.owner !== owner) {
        skipped.push({ id, reason: `owner 不符：该记忆属于 ${owner}，不是 ${opts.owner}` });
        continue;
      }
      targets.push(entry);
    }
  } else if (opts.session_id !== undefined) {
    if (opts.owner !== undefined && opts.owner !== owner) {
      for (const e of entries.filter((x) => x.source_session === opts.session_id)) {
        skipped.push({ id: e.id, reason: `owner 不符：该记忆属于 ${owner}，不是 ${opts.owner}` });
      }
    } else {
      targets.push(...entries.filter((e) => e.source_session === opts.session_id));
    }
  } else {
    throw new MemoryError("删除记忆须指定 ids（记忆 id 列表）或 session_id（来源会话）之一");
  }
  return { targets, notFound, skipped, total: entries.length, remaining: entries.length - targets.length };
}

export interface MemoryDeleteResult {
  deleted: MemoryEntry[];
  skipped: { id: string; reason: string }[];
  notFound: string[];
  remaining: number;
  total: number;
}

/**
 * 缺口 2：删除记忆。只删圈定的目标行，其余行原样保留；文件原子重写
 * （同目录 tmp + fsync + rename，保留原文件权限），索引随之同步。
 * - 目标里有进行中会话（activeSessionIds）写的记忆：整批拒绝，一条都不删。
 * - expectedRevision 有值时先核对文件 SHA-256（memoryBrowser.ts 的 CAS
 *   思路），对不上抛 revision_conflict，一条都不删。
 * - owner 不符的目标只跳过不删（见 previewMemoryDelete），不抛错。
 */
export function deleteMemoryEntries(
  memoryPath: string,
  opts: {
    ids?: string[];
    session_id?: string;
    owner?: string;
    activeSessionIds?: Iterable<string>;
    expectedRevision?: string;
    home?: string;
  } = {},
): MemoryDeleteResult {
  const preview = previewMemoryDelete(memoryPath, opts);
  const active = new Set(opts.activeSessionIds ?? []);
  const running = preview.targets.filter((e) => e.source_session !== null && active.has(e.source_session));
  if (running.length) {
    const sessionId = running[0].source_session as string;
    throw new MemoryDeleteError(
      "session_running",
      `会话 ${sessionId} 正在执行任务，其记忆现在不能删除，请等它完成再删`,
      running.map((e) => e.id),
      sessionId,
    );
  }
  if (opts.expectedRevision !== undefined) {
    const revision = existsSync(memoryPath)
      ? createHash("sha256").update(readFileSync(memoryPath)).digest("hex")
      : "missing";
    if (revision !== opts.expectedRevision) {
      throw new MemoryDeleteError("revision_conflict", "记忆已被其他进程修改，请重新读取后再删除", preview.targets.map((e) => e.id));
    }
  }
  if (!preview.targets.length) {
    return { deleted: [], skipped: preview.skipped, notFound: preview.notFound, remaining: preview.total, total: preview.total };
  }
  const deleteLines = new Set(preview.targets.map((e) => e.line));
  const lines = readMemoryLines(memoryPath);
  const kept = lines.filter((_line, i) => !deleteLines.has(i + 1));
  const originalEndsNewline = existsSync(memoryPath) && readFileSync(memoryPath, "utf-8").endsWith("\n");
  const content = kept.length ? kept.join("\n") + (originalEndsNewline ? "\n" : "") : "";
  const mode = existsSync(memoryPath) ? statSync(memoryPath).mode & 0o777 : 0o600;
  const dir = join(memoryPath, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = atomicTmpPath(memoryPath);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, content, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, memoryPath);
  // 索引随文件同步：删掉的行出索引，行号重算。
  const owner = memoryOwnerForPath(memoryPath, opts.home);
  syncMemoryIndex(memoryPath, owner);
  return {
    deleted: preview.targets,
    skipped: preview.skipped,
    notFound: preview.notFound,
    remaining: preview.remaining,
    total: preview.total,
  };
}


export interface TenetIndexEntry {
  agent: string;
  id: string;
  kind: TenetKind;
  enabled: boolean;
  text: string;
}

/**
 * 缺口 28：Tenet 索引——Tenet 按 id 全局可查（soul show / 审计要回答
 * “这条 Tenet 属于哪个 Soul”）。索引是派生的：读 Soul 文件现算，不另存
 * 文件、不与 Soul 文件抢写；某个 Soul 文件损坏时跳过它（损坏本身由
 * `nyra soul status` 报错，不在这里拦住整张索引）。
 */
export function buildTenetIndex(home: string): TenetIndexEntry[] {
  const out: TenetIndexEntry[] = [];
  for (const agent of listSoulAgents(home)) {
    let soul;
    try {
      soul = loadSoul(home, agent);
    } catch {
      continue;
    }
    for (const tenet of soul.tenets) {
      out.push({ agent, id: tenet.id, kind: tenet.kind, enabled: tenet.enabled, text: tenet.text });
    }
  }
  return out;
}

/** 按 Tenet id 找它属于哪个 Soul（找不到返回 null，不抛错）。 */
export function findTenetById(home: string, tenetId: string): { agent: string; tenet: SoulTenet } | null {
  for (const agent of listSoulAgents(home)) {
    let soul;
    try {
      soul = loadSoul(home, agent);
    } catch {
      continue;
    }
    const tenet = soul.tenets.find((t) => t.id === tenetId);
    if (tenet) return { agent, tenet };
  }
  return null;
}

export function listSessions(home?: string): SessionMeta[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  const out: { mtimeMs: number; meta: SessionMeta }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(dir, file);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      const lines = readFileSync(path, "utf-8").split("\n");
      let count = 0;
      let preview = "";
      let foundUser = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        count += 1;
        if (foundUser) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg && typeof msg === "object" && msg.role === "user") {
            preview = typeof msg.content === "string" ? msg.content.slice(0, 60) : "";
            foundUser = true;
          }
        } catch { /* ignore */ }
      }
      out.push({
        mtimeMs,
        meta: {
          id: file.replace(/\.jsonl$/, ""),
          preview,
          count,
          mtime: new Date(mtimeMs).toISOString().slice(0, 19),
        },
      });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map((e) => e.meta);
}
