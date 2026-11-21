// src/knowledge.ts — 本地 AI 知识库，与 Python 版 nyra/knowledge.py 同语义。
// kb.json + notes.jsonl；分块 ≤1500 字；BM25（英文词 + 中文单字与二元组）；
// ask 只按库内笔记回答，库内没有就直说不知道，不编造。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync, fsyncSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { ToolPool, type Bm25Payload } from "./toolPool.ts";
import { EvidenceStore } from "./evidence.ts";

export const MAX_NOTE_CHARS = 1500;
export const MIN_NOTE_CHARS = 200;
/** 单个 PDF 超过该大小不收录（最小抽取不值得为超大文件扛内存）。 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** 笔记数达到该值时 searchAsync 把评分挪到 worker 池（低于则同步算）。 */
export const POOL_MIN_NOTES = 100;
export const ASK_SYSTEM_PROMPT =
  "你是 Nyra 的知识库问答助手。只根据下面提供的库内笔记回答问题；" +
  "回答末尾注明依据了哪几条笔记（写笔记标题）；如果库内笔记没有" +
  "相关内容，就直说不知道，不要编造；不要使用笔记之外的知识。";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0 Safari/537.36";

export class KnowledgeError extends Error {
  constructor(message: string) { super(message); this.name = "KnowledgeError"; }
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Note {
  id: string; title: string; source: string; date: string; text: string; created_at: string;
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function nowSeconds(): string {
  const d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

function checkName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new KnowledgeError("知识库名只允许字母、数字、下划线、点、横线");
  return name;
}

function checkDate(date: string | null | undefined): string {
  if (date === null || date === undefined) return today();
  if (typeof date !== "string" || !DATE_RE.test(date)) throw new KnowledgeError("日期须为 YYYY-MM-DD 格式");
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new KnowledgeError("日期不是真实的日历日期");
  return date;
}

export function tokenize(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const tokens: string[] = lower.match(/[a-z0-9]+/g) ?? [];
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const ch of run) tokens.push(ch);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function splitLong(text: string, limit: number = MAX_NOTE_CHARS): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  const ends = ".。!！?？；;\n";
  while (rest.length > limit) {
    let cut = -1;
    for (const ch of ends) {
      const idx = rest.lastIndexOf(ch, limit - 1);
      if (idx > cut) cut = idx;
    }
    if (cut < limit / 2) cut = limit;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function chunkText(text: string, fallbackTitle: string): [string, string][] {
  const sections: [string | null, string[]][] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => { sections.push([heading, body]); body = []; heading = null; };
  for (const line of text.split("\n")) {
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (m) { flush(); heading = m[2].trim(); continue; }
    body.push(line);
  }
  flush();
  const chunks: [string, string][] = [];
  for (const [sectionTitle, lines] of sections) {
    const title = sectionTitle || fallbackTitle;
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line.trim()) current.push(line.trim());
      else if (current.length) { paragraphs.push(current.join(" ")); current = []; }
    }
    if (current.length) paragraphs.push(current.join(" "));
    let buffer = "";
    for (const para of paragraphs) {
      for (const piece of splitLong(para)) {
        if (buffer && buffer.length + 1 + piece.length > MAX_NOTE_CHARS) {
          chunks.push([title, buffer]);
          buffer = piece;
        } else {
          buffer = buffer ? `${buffer} ${piece}` : piece;
        }
      }
    }
    if (buffer) chunks.push([title, buffer]);
    else if (!paragraphs.length && sectionTitle) chunks.push([title, title]);
  }
  const merged: [string, string][] = [];
  for (const [title, bodyText] of chunks) {
    if (merged.length && merged[merged.length - 1][0] === title &&
      bodyText.length < MIN_NOTE_CHARS &&
      merged[merged.length - 1][1].length + 1 + bodyText.length <= MAX_NOTE_CHARS) {
      merged[merged.length - 1] = [title, `${merged[merged.length - 1][1]} ${bodyText}`];
    } else merged.push([title, bodyText]);
  }
  const seen = new Map<string, number>();
  const numbered: [string, string][] = [];
  for (const [title, bodyText] of merged) {
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    numbered.push([n > 1 ? `${title}（${n}）` : title, bodyText]);
  }
  return numbered;
}

export function extractPageText(rawHtml: string): [string, string] {
  const titleMatch = /<title[^>]*>(.*?)<\/title>/is.exec(rawHtml);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()) : "";
  const descMatch = /<meta[^>]+name=["']description["'][^>]+content=["'](.*?)["']/is.exec(rawHtml);
  const description = descMatch ? decodeEntities(descMatch[1].trim()) : "";
  let body = rawHtml.replace(/<(script|style)[^>]*>.*?<\/\1>/gis, " ");
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  body = body.replace(/[ \t\r\f\v]+/g, " ");
  body = body.replace(/\n\s*\n+/g, "\n\n");
  let text = body.trim();
  if (description && !text.includes(description)) text = text ? `${description}\n\n${text}` : description;
  return [title, text];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** 缺口 33：最小可用的 PDF 文本抽取——只处理 FlateDecode 压缩与未压缩的
 * 内容流，取括号字面量字符串（Tj / TJ 运算符的参数）。不处理 ToUnicode
 * 映射、十六进制字符串、加密与扫描件：抽不出来的返回空串，调用方直接报错，
 * 不假装读到了。图片流（DCT/JPX/CCITT/JBIG2）直接跳过，不把二进制垃圾当正文。 */
export function extractPdfText(buf: Buffer): string {
  const latin1 = buf.toString("latin1");
  const texts: string[] = [];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin1)) !== null) {
    const start = m.index + m[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < 0) break;
    const dict = latin1.slice(Math.max(0, m.index - 300), m.index);
    if (/\/(Image|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|Crypt)\b/.test(dict)) {
      streamRe.lastIndex = end;
      continue;
    }
    const raw = Buffer.from(latin1.slice(start, end), "latin1");
    let content: string;
    if (dict.includes("/FlateDecode")) {
      try { content = inflateSync(raw).toString("latin1"); }
      catch { streamRe.lastIndex = end; continue; }
    } else {
      content = raw.toString("latin1");
    }
    for (const lit of content.match(/\((?:\\.|[^\\()])*\)/g) ?? []) {
      const inner = lit.slice(1, -1)
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\([0-7]{1,3})/g, (_x, oct) => String.fromCharCode(parseInt(oct, 8)));
      if (inner.trim()) texts.push(inner);
    }
    streamRe.lastIndex = end;
  }
  return texts.join("\n").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** 缺口 33：检索进证据链的双通道记录——有运行上下文时写该运行的
 * events.jsonl（knowledge_search 事件），否则写 evidence/knowledge/ 下
 * 的证据文件（与审阅队列的 recordReviewEvent 同款口径）。
 * RunStore 只在函数内动态 import：runs.ts 静态 import tools.ts，
 * knowledge.ts 若静态 import runs.ts 会形成 tools→knowledge→runs→tools
 * 的循环导入。 */
export async function recordKnowledgeSearch(
  home: string | undefined,
  runId: string | null,
  fields: { base: string; query: string; hits: number; topScore: number },
  citationText: string,
): Promise<{ channel: "events" | "evidence" | "none"; path?: string }> {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  if (runId) {
    for (const sub of ["runs", "tasks"]) {
      const baseDir = join(h, sub);
      if (!existsSync(join(baseDir, runId))) continue;
      try {
        const { RunStore } = await import("./runs.ts");
        new RunStore(baseDir).appendEvent(runId, "knowledge_search", fields);
        return { channel: "events" };
      } catch { /* 该 store 写失败就试下一个；都失败再走证据文件 */ }
    }
  }
  try {
    const path = new EvidenceStore(join(h, "evidence"), "knowledge").save(
      "knowledge_search", `knowledge://${fields.base}`, citationText, fields.query,
    );
    return { channel: "evidence", path };
  } catch {
    return { channel: "none" };
  }
}

function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = join(join(path, ".."), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    if (typeof data === "string") writeSync(fd, data, null, "utf-8");
    else writeSync(fd, data);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
}

/** 纯 BM25 评分（与 KnowledgeBase.search 同一套公式），供 worker 池调用。
 * 返回 [分数, 文档下标][]（分数 > 0，按分数降序，取前 topK）。 */
export function scoreBm25(queryTokens: string[], docTokens: string[][], topK: number): [number, number][] {
  if (!docTokens.length || !queryTokens.length) return [];
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((a, b) => a + b, 0) / docLen.length || 1.0;
  const docCount = docTokens.length;
  const docFreq = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const k1 = 1.5; const b = 0.75;
  const scored: [number, number][] = [];
  for (let i = 0; i < docTokens.length; i++) {
    const tokens = docTokens[i];
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let score = 0;
    for (const token of new Set(queryTokens)) {
      const df = docFreq.get(token) ?? 0;
      if (!df) continue;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const tf = counts.get(token) ?? 0;
      score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen[i] / avgLen));
    }
    if (score > 0) scored.push([score, i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, Math.max(topK, 0));
}

export interface KnowledgeSearchOptions {
  topK?: number;
  minScore?: number;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
}

export class KnowledgeBase {
  base: string;
  private pool: ToolPool | null = null;

  constructor(base?: string | null) {
    this.base = base ?? join(process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra"), "knowledge");
  }

  private kbDir(name: string): string { return join(this.base, checkName(name)); }
  private metaPath(name: string): string { return join(this.kbDir(name), "kb.json"); }
  private notesPath(name: string): string { return join(this.kbDir(name), "notes.jsonl"); }

  exists(name: string): boolean { return existsSync(this.metaPath(name)); }

  private require(name: string): string {
    const dir = this.kbDir(name);
    if (!existsSync(this.metaPath(name))) throw new KnowledgeError(`知识库不存在：${name}`);
    return dir;
  }

  private loadNotes(name: string): Note[] {
    this.require(name);
    const path = this.notesPath(name);
    if (!existsSync(path)) return [];
    const notes: Note[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { notes.push(JSON.parse(line) as Note); } catch {
        throw new KnowledgeError(`知识库笔记已损坏：${name}`);
      }
    }
    return notes;
  }

  private saveNotes(name: string, notes: Note[]): void {
    const data = notes.map((n) => JSON.stringify(n, null, 0) + "\n").join("");
    atomicWrite(this.notesPath(name), data);
  }

  create(name: string, description = ""): Record<string, unknown> {
    checkName(name);
    if (this.exists(name)) throw new KnowledgeError(`知识库已存在：${name}`);
    const meta = { name, description, created_at: nowSeconds() };
    atomicWrite(this.metaPath(name), JSON.stringify(meta, null, 2) + "\n");
    atomicWrite(this.notesPath(name), "");
    return meta;
  }

  listBases(): (Record<string, unknown> & { notes: number })[] {
    const out: (Record<string, unknown> & { notes: number })[] = [];
    if (!existsSync(this.base)) return out;
    for (const entry of readdirSync(this.base).sort()) {
      const metaPath = join(this.base, entry, "kb.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
        const name = (meta.name as string) || entry;
        let count = 0;
        try { count = this.loadNotes(name).length; } catch { count = 0; }
        out.push({ ...meta, notes: count });
      } catch { continue; }
    }
    return out;
  }

  remove(name: string): void {
    const dir = this.require(name);
    for (const p of [this.notesPath(name), this.metaPath(name)]) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
    try { rmSync(dir, { recursive: false }); } catch { /* ignore */ }
  }

  addText(name: string, text: string, title: string, source: string, date?: string | null): Note[] {
    this.require(name);
    if (typeof text !== "string" || !text.trim()) throw new KnowledgeError("内容为空，没有可收录的笔记");
    const noteDate = checkDate(date);
    const created = nowSeconds();
    const notes = this.loadNotes(name);
    const added: Note[] = [];
    for (const [chunkTitle, chunkBody] of chunkText(text, title)) {
      added.push({
        id: randomBytes(6).toString("hex"), title: chunkTitle, source,
        date: noteDate, text: chunkBody, created_at: created,
      });
    }
    notes.push(...added);
    this.saveNotes(name, notes);
    return added;
  }

  addFile(name: string, path: string): Note[] {
    this.require(name);
    if (!existsSync(path) || !statSync(path).isFile()) throw new KnowledgeError(`文件不存在：${path}`);
    if (extname(path).toLowerCase() === ".pdf") return this.addPdf(name, path);
    if (![".txt", ".md"].includes(extname(path).toLowerCase())) throw new KnowledgeError("只收录 .txt / .md / .pdf 文件");
    let text: string;
    try { text = readFileSync(path, "utf-8"); } catch { throw new KnowledgeError(`读文件失败：${path}`); }
    const date = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
    return this.addText(name, text, basename(path), path, date);
  }

  /** 缺口 33：PDF 收录——最小文本抽取（见 extractPdfText）。不是 PDF、
   * 超 20MB、抽不出文本（扫描件/加密）都直接报错，不静默跳过。 */
  addPdf(name: string, path: string): Note[] {
    this.require(name);
    if (!existsSync(path) || !statSync(path).isFile()) throw new KnowledgeError(`文件不存在：${path}`);
    let buf: Buffer;
    try { buf = readFileSync(path); } catch { throw new KnowledgeError(`读文件失败：${path}`); }
    if (buf.length > MAX_PDF_BYTES) throw new KnowledgeError(`PDF 超过 20MB，不收录：${path}`);
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new KnowledgeError(`不是 PDF 文件：${path}`);
    const text = extractPdfText(buf);
    if (!text.trim()) throw new KnowledgeError(`PDF 没有可提取的文本（可能是扫描件或加密 PDF）：${path}`);
    const date = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
    return this.addText(name, text, basename(path), path, date);
  }

  addDir(name: string, path: string): Note[] {
    this.require(name);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new KnowledgeError(`目录不存在：${path}`);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && [".txt", ".md", ".pdf"].includes(extname(e.name).toLowerCase())) files.push(p);
      }
    };
    walk(path);
    const added: Note[] = [];
    for (const f of files) {
      try { added.push(...this.addFile(name, f)); } catch { continue; }
    }
    return added;
  }

  async addUrl(name: string, url: string): Promise<Note[]> {
    this.require(name);
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(20000) });
    } catch { throw new KnowledgeError(`抓取失败：${url}`); }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType && !contentType.toLowerCase().includes("text/html")) throw new KnowledgeError(`不是网页，无法收录：${url}`);
    const buf = Buffer.from(await response.arrayBuffer());
    let charset = "utf-8";
    const m = /charset=([A-Za-z0-9_-]+)/i.exec(contentType);
    if (m) charset = m[1];
    let rawHtml: string;
    try { rawHtml = new TextDecoder(charset).decode(buf); } catch { rawHtml = buf.toString("utf-8"); }
    const [title, text] = extractPageText(rawHtml);
    if (!text.trim()) throw new KnowledgeError(`页面没有可收录的正文：${url}`);
    return this.addText(name, text, title || url, url);
  }

  /** 缺口 33：检索参数面（Dify 已验证的三样）——TopK、最低分阈值、
   * 元数据过滤（来源子串、日期范围）。非法参数直接抛错，不静默回默认。 */
  searchWithOptions(name: string, query: string, opts: KnowledgeSearchOptions = {}): [number, Note][] {
    const notes = this.loadNotes(name);
    const queryTokens = tokenize(query || "");
    if (!notes.length || !queryTokens.length) return [];
    if (opts.topK !== undefined && (!Number.isInteger(opts.topK) || opts.topK < 0)) throw new KnowledgeError("topK 须是不小于 0 的整数");
    const topK = opts.topK === undefined ? 5 : opts.topK;
    if (opts.minScore !== undefined && (typeof opts.minScore !== "number" || Number.isNaN(opts.minScore) || opts.minScore < 0)) throw new KnowledgeError("最低分须是不小于 0 的数字");
    const minScore = opts.minScore === undefined ? 0 : opts.minScore;
    const dateFrom = opts.dateFrom === undefined ? null : checkDate(opts.dateFrom);
    const dateTo = opts.dateTo === undefined ? null : checkDate(opts.dateTo);
    if (dateFrom && dateTo && dateFrom > dateTo) throw new KnowledgeError("开始日期不能晚于结束日期");
    const filtered = notes.filter((n) =>
      (opts.source === undefined || opts.source === "" || (n.source ?? "").includes(opts.source)) &&
      (dateFrom === null || (n.date ?? "") >= dateFrom) &&
      (dateTo === null || (n.date ?? "") <= dateTo));
    if (!filtered.length) return [];
    const docTokens = filtered.map((n) => tokenize(n.text ?? ""));
    return scoreBm25(queryTokens, docTokens, topK)
      .filter(([score]) => score >= minScore)
      .map(([score, i]) => [score, filtered[i]] as [number, Note]);
  }

  search(name: string, query: string, topK = 5): [number, Note][] {
    return this.searchWithOptions(name, query, { topK });
  }

  /** 笔记数达到阈值时把评分挪到 worker 池，主线程不被 BM25 拖住；
   * 小库直接走同步 search，不付 worker 启动开销。结果与 search() 一致。 */
  async searchAsync(name: string, query: string, topK = 5): Promise<[number, Note][]> {
    const notes = this.loadNotes(name);
    const queryTokens = tokenize(query || "");
    if (!notes.length || !queryTokens.length) return [];
    if (notes.length < POOL_MIN_NOTES) return this.search(name, query, topK);
    const pool = this.pool ?? (this.pool = new ToolPool());
    const docTokens = notes.map((n) => tokenize(n.text ?? ""));
    const result = (await pool.run("bm25", { queryTokens, docTokens, topK } satisfies Bm25Payload)) as [number, number][];
    return result.map(([score, i]) => [score, notes[i]] as [number, Note]);
  }

  /** 关闭本实例的 worker 池（CLI 进程退出时不需要调，worker 已 unref）。 */
  async closePool(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.close();
  }

  async ask(
    name: string,
    question: string,
    chatFn?: (messages: Record<string, unknown>[]) => Promise<string> | string,
  ): Promise<[string, Note[]]> {
    const results = await this.searchAsync(name, question, 5);
    const used = results.map(([, n]) => n);
    let userContent: string;
    if (used.length) {
      const context = used.map((n) => `【${n.title ?? ""}】（来源：${n.source ?? ""}，日期：${n.date ?? ""}）\n${n.text ?? ""}`).join("\n\n");
      userContent = `问题：${question}\n\n库内相关笔记：\n${context}`;
    } else {
      userContent = `问题：${question}\n\n库内没有与该问题相关的笔记。`;
    }
    const messages = [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
    const fn = chatFn ?? defaultChatFn;
    let answer = await fn(messages);
    if (typeof answer !== "string") answer = String(answer);
    return [answer, used];
  }
}

async function defaultChatFn(messages: Record<string, unknown>[]): Promise<string> {
  const { loadConfig, resolveProvider, resolveHome } = await import("./config.ts");
  const { Provider } = await import("./providers.ts");
  const config = loadConfig();
  const provider = new Provider(resolveProvider({ home: resolveHome(), config, providerName: config.provider as string, model: config.model as string }));
  const resp = await provider.chat(messages as never);
  const content = (resp as Record<string, unknown>).choices;
  if (!Array.isArray(content) || !content[0]) throw new KnowledgeError("模型返回了无法解析的回答");
  return ((content[0] as Record<string, unknown>).message as Record<string, unknown>)?.content as string ?? "";
}

/** 缺口 33：检索测试台的核心——对一批典型问题跑同一组检索参数，
 * 返回每题的命中与汇总（有命中的题数、命中题的平均最高分）。只读，
 * 不调模型、不花 token；调参对比就是换一组参数再跑一次（--json 出
 * 机器可读结果，方便 diff 两次跑法）。 */
export function runKnowledgeTest(
  store: KnowledgeBase,
  name: string,
  questions: string[],
  opts: KnowledgeSearchOptions = {},
): { results: { question: string; hits: [number, Note][] }[]; hitCount: number; avgTopScore: number | null } {
  const results = questions.map((q) => ({ question: q, hits: store.searchWithOptions(name, q, opts) }));
  const hitCount = results.filter((r) => r.hits.length).length;
  const topScores = results.filter((r) => r.hits.length).map((r) => r.hits[0][0]);
  const avgTopScore = topScores.length ? topScores.reduce((a, b) => a + b, 0) / topScores.length : null;
  return { results, hitCount, avgTopScore };
}

export async function knowledgeMain(argv: string[], base?: string | null, chatFn?: (m: Record<string, unknown>[]) => Promise<string> | string): Promise<number> {
  const store = new KnowledgeBase(base ?? undefined);
  const cmd = argv[0];
  try {
    if (cmd === "create") {
      const descIdx = argv.indexOf("--description");
      const meta = store.create(argv[1], descIdx >= 0 ? argv[descIdx + 1] : "");
      process.stdout.write(`已创建知识库：${meta.name}\n`);
    } else if (cmd === "list") {
      const bases = store.listBases();
      if (!bases.length) process.stdout.write("还没有知识库，用 `create <名>` 新建一个。\n");
      for (const item of bases) {
        process.stdout.write(`${item.name}\t${item.notes} 条笔记` + (item.description ? `\t${item.description}` : "") + "\n");
      }
    } else if (cmd === "add") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      let added: Note[] = [];
      const fileIdx = argv.indexOf("--file");
      const dirIdx = argv.indexOf("--dir");
      const textIdx = argv.indexOf("--text");
      const urlIdx = argv.indexOf("--url");
      const titleIdx = argv.indexOf("--title");
      if (fileIdx >= 0) added = store.addFile(name, argv[fileIdx + 1]);
      else if (dirIdx >= 0) added = store.addDir(name, argv[dirIdx + 1]);
      else if (textIdx >= 0) added = store.addText(name, argv[textIdx + 1], titleIdx >= 0 ? argv[titleIdx + 1] : "手动输入", "手动输入");
      else if (urlIdx >= 0) added = await store.addUrl(name, argv[urlIdx + 1]);
      else throw new KnowledgeError("add 须指定 --file / --dir / --text / --url 之一");
      process.stdout.write(`已收录 ${added.length} 条笔记进 ${name}\n`);
    } else if (cmd === "search") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      const topIdx = argv.indexOf("--top-k");
      const minIdx = argv.indexOf("--min-score");
      const srcIdx = argv.indexOf("--source");
      const fromIdx = argv.indexOf("--date-from");
      const toIdx = argv.indexOf("--date-to");
      const opts: KnowledgeSearchOptions = {
        topK: topIdx >= 0 ? parseInt(argv[topIdx + 1], 10) : 5,
        ...(minIdx >= 0 ? { minScore: parseFloat(argv[minIdx + 1]) } : {}),
        ...(srcIdx >= 0 ? { source: argv[srcIdx + 1] } : {}),
        ...(fromIdx >= 0 ? { dateFrom: argv[fromIdx + 1] } : {}),
        ...(toIdx >= 0 ? { dateTo: argv[toIdx + 1] } : {}),
      };
      const results = store.searchWithOptions(name, argv[2], opts);
      if (!results.length) process.stdout.write("没有找到相关笔记。\n");
      for (const [score, note] of results) {
        process.stdout.write(`${score.toFixed(2)}\t${note.title ?? ""}\t来源：${note.source ?? ""}\t日期：${note.date ?? ""}\n`);
      }
    } else if (cmd === "test") {
      // 缺口 33：检索测试台——输一批典型问题，看召回片段与分数，调参对比，
      // 调好再接入（Dify 知识库的调试体验，成本只是一个 CLI 命令 + 检索）。
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      const fileIdx = argv.indexOf("--file");
      if (fileIdx < 0 || !argv[fileIdx + 1]) throw new KnowledgeError("test 须指定 --file <问题文件>（每行一个问题，空行与 # 开头的行跳过）");
      const topIdx = argv.indexOf("--top-k");
      const minIdx = argv.indexOf("--min-score");
      const srcIdx = argv.indexOf("--source");
      const fromIdx = argv.indexOf("--date-from");
      const toIdx = argv.indexOf("--date-to");
      const opts: KnowledgeSearchOptions = {
        topK: topIdx >= 0 ? parseInt(argv[topIdx + 1], 10) : 5,
        ...(minIdx >= 0 ? { minScore: parseFloat(argv[minIdx + 1]) } : {}),
        ...(srcIdx >= 0 ? { source: argv[srcIdx + 1] } : {}),
        ...(fromIdx >= 0 ? { dateFrom: argv[fromIdx + 1] } : {}),
        ...(toIdx >= 0 ? { dateTo: argv[toIdx + 1] } : {}),
      };
      let questions: string[];
      try {
        questions = readFileSync(argv[fileIdx + 1], "utf-8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      } catch { throw new KnowledgeError(`读问题文件失败：${argv[fileIdx + 1]}`); }
      if (!questions.length) throw new KnowledgeError("问题文件里没有问题");
      const { results, hitCount, avgTopScore } = runKnowledgeTest(store, name, questions, opts);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify({
          base: name,
          params: { topK: opts.topK ?? 5, ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}), ...(opts.source ? { source: opts.source } : {}), ...(opts.dateFrom ? { dateFrom: opts.dateFrom } : {}), ...(opts.dateTo ? { dateTo: opts.dateTo } : {}) },
          questions: results.map((r) => ({
            question: r.question,
            hits: r.hits.map(([score, n]) => ({ score: Number(score.toFixed(2)), title: n.title, source: n.source, date: n.date, excerpt: (n.text ?? "").replace(/\s+/g, " ").slice(0, 200) })),
          })),
          summary: { total: questions.length, hit: hitCount, avgTopScore: avgTopScore === null ? null : Number(avgTopScore.toFixed(2)) },
        }, null, 2) + "\n");
      } else {
        for (const r of results) {
          process.stdout.write(`问题：${r.question}\n`);
          if (!r.hits.length) process.stdout.write("  （无命中）\n");
          for (const [score, n] of r.hits) {
            process.stdout.write(`  ${score.toFixed(2)}\t${n.title ?? ""}\t来源：${n.source ?? ""}\t日期：${n.date ?? ""}\n`);
          }
        }
        process.stdout.write(`汇总：共 ${questions.length} 个问题，${hitCount} 个有命中，命中问题的平均最高分 ${avgTopScore === null ? "—" : avgTopScore.toFixed(2)}（topK=${opts.topK ?? 5}${opts.minScore !== undefined ? `，最低分 ${opts.minScore}` : ""}）\n`);
      }
    } else if (cmd === "ask") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      const [answer, used] = await store.ask(name, argv[2], chatFn);
      process.stdout.write(answer + "\n");
      if (used.length) {
        process.stdout.write("\n依据笔记：\n");
        for (const n of used) process.stdout.write(`- ${n.title ?? ""}\n`);
      } else process.stdout.write("\n（库内没有相关笔记）\n");
    } else if (cmd === "remove") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      if (!argv.includes("--yes")) {
        process.stderr.write("删除须加 --yes 确认。\n");
        return 1;
      }
      store.remove(name);
      process.stdout.write(`已删除知识库：${name}\n`);
    } else {
      process.stderr.write("用法：nyra kb <create|list|add|search|ask|remove|test> …（nyra knowledge 与 kb 同义）\n");
      return 2;
    }
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}
