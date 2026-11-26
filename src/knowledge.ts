// src/knowledge.ts — 本地 AI 知识库，与 Python 版 nyra/knowledge.py 同语义。
// kb.json + notes.jsonl；父块 ≤1500 字、子块 ≤300 字（parent-child：子块
// 精确匹配、命中后返回父块）；BM25（英文词 + 中文单字与二元组）+ 确定性
// rerank（覆盖率 + 标题命中）；PDF 抽取支持 ToUnicode CMap 中文；
// ask 只按库内笔记回答，库内没有就直说不知道，不编造。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync, fsyncSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { ToolPool, type Bm25Payload } from "./toolPool.ts";
import { EvidenceStore } from "./evidence.ts";

export const MAX_NOTE_CHARS = 1500;
export const MIN_NOTE_CHARS = 200;
/** 缺口 33 第二批：parent-child 分块——父块仍 ≤1500 字，子块 ≤300 字
 *（子块精确匹配、命中后返回父块补上下文）。 */
export const MAX_CHILD_CHARS = 300;
/** rerank 候选数：先取 topK 的该倍数个 BM25 候选再重排。 */
export const RERANK_CANDIDATES_MULT = 3;
/** 确定性 rerank 权重（见 rerankCandidates）：覆盖率加成与标题命中加成。 */
export const COVERAGE_BOOST = 0.3;
export const TITLE_BOOST = 0.2;
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
  /** 缺口 33 第二批 parent-child：子块才有，指向父块 id。 */
  parentId?: string;
  /** 缺口 33 第二批：子块为 "child"，父块不填（老库笔记同样不填，视为父块）。 */
  kind?: "child";
  /** 检索时填：命中该父块的子块原文（只活在内存里，不落盘）。 */
  matchExcerpt?: string;
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

/** 缺口 33 第二批：把父块切成子块（≤300 字，句末优先断开）。
 * 子块只用于精确匹配，命中后返回父块；父块太短（≤300 字）时不另切，
 * 检索直接按父块走，行为与第一批一致。 */
export function chunkChildren(parentText: string): string[] {
  if (parentText.length <= MAX_CHILD_CHARS) return [];
  const sentences: string[] = [];
  let buf = "";
  for (const ch of parentText) {
    buf += ch;
    if ("。！？；\n.!?;".includes(ch)) { if (buf.trim()) sentences.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) sentences.push(buf.trim());
  if (!sentences.length) return [parentText];
  const children: string[] = [];
  let cur = "";
  for (const s of sentences) {
    for (const piece of splitLong(s, MAX_CHILD_CHARS)) {
      if (cur && cur.length + piece.length > MAX_CHILD_CHARS) { children.push(cur); cur = piece; }
      else cur = cur ? cur + piece : piece;
    }
  }
  if (cur) children.push(cur);
  return children.filter(Boolean);
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

/** 缺口 33 第二批：ToUnicode CMap 解析（bfchar / bfrange，含数组式
 * bfrange）。目标串按 UTF-16BE 解（代理对拼成一个码点）。返回映射与
 * 码长（由 codespacerange 推断：<00>-<FF> 为 1 字节，<0000>-<FFFF> 为 2 字节）。 */
export function parseToUnicodeCMap(cmapText: string): { map: Map<number, string>; codeSize: number } {
  const map = new Map<number, string>();
  let codeSize = 2;
  const spacer = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmapText);
  if (spacer) {
    const m = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(spacer[1]);
    if (m) codeSize = m[1].length / 2;
  }
  const decodeTarget = (hex: string): string => {
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const unit = (bytes[i] << 8) | bytes[i + 1];
      if (unit >= 0xd800 && unit <= 0xdbff && i + 3 < bytes.length) {
        const lo = (bytes[i + 2] << 8) | bytes[i + 3];
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (lo - 0xdc00));
          i += 2;
          continue;
        }
      }
      out += String.fromCodePoint(unit);
    }
    return out;
  };
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charRe.exec(cmapText)) !== null) {
    const lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let line: RegExpExecArray | null;
    while ((line = lineRe.exec(block[1])) !== null) map.set(parseInt(line[1], 16), decodeTarget(line[2]));
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeRe.exec(cmapText)) !== null) {
    const itemRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
    let item: RegExpExecArray | null;
    while ((item = itemRe.exec(block[1])) !== null) {
      const lo = parseInt(item[1], 16);
      const hi = parseInt(item[2], 16);
      if (item[3] !== undefined) {
        const baseCode = decodeTarget(item[3]).codePointAt(0) ?? 0;
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(baseCode + (c - lo)));
      } else if (item[4] !== undefined) {
        const parts = [...item[4].matchAll(/<([0-9A-Fa-f]+)>/g)];
        parts.forEach((p, i) => map.set(lo + i, decodeTarget(p[1])));
      }
    }
  }
  return { map, codeSize };
}

/** 按 CMap 把一串字形编号字节解成文字。先按 CMap 的码长试，不行再试
 * 另一码长；映射率低于一半返回 null（调用方直接跳过该串，不返回乱码）。 */
function decodeWithCmap(bytes: number[], cmap: { map: Map<number, string>; codeSize: number }): string | null {
  const steps = cmap.codeSize === 2 ? [2, 1] : [1, 2];
  for (const step of steps) {
    let out = "";
    let mapped = 0;
    let total = 0;
    for (let i = 0; i + step <= bytes.length; i += step) {
      total++;
      let code = 0;
      for (let j = 0; j < step; j++) code = (code << 8) | bytes[i + j];
      const ch = cmap.map.get(code);
      if (ch !== undefined) { out += ch; mapped++; }
    }
    if (total && mapped / total >= 0.5) return out;
  }
  return null;
}

function decodeUtf16Be(bytes: number[]): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = (bytes[i] << 8) | bytes[i + 1];
    if (unit >= 0xd800 && unit <= 0xdbff && i + 3 < bytes.length) {
      const lo = (bytes[i + 2] << 8) | bytes[i + 3];
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (lo - 0xdc00));
        i += 2;
        continue;
      }
    }
    out += String.fromCodePoint(unit);
  }
  return out;
}

/** 括号字面量里的转义还原成字节（\( \) \\ \n \r \t 与 \ddd 八进制）。 */
function unescapePdfBytes(inner: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === "n") { bytes.push(0x0a); i++; }
      else if (next === "r") { bytes.push(0x0d); i++; }
      else if (next === "t") { bytes.push(0x09); i++; }
      else if (next === "(" || next === ")" || next === "\\") { bytes.push(next.charCodeAt(0)); i++; }
      else if (next >= "0" && next <= "7") {
        let oct = next;
        let j = i + 2;
        while (j < inner.length && j < i + 4 && inner[j] >= "0" && inner[j] <= "7") { oct += inner[j]; j++; }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = j - 1;
      } else { bytes.push(next.charCodeAt(0)); i++; }
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return bytes;
}

function inflateStream(raw: Buffer, dict: string): string | null {
  if (dict.includes("/FlateDecode")) {
    try { return inflateSync(raw).toString("latin1"); }
    catch { return null; }
  }
  return raw.toString("latin1");
}

/** 缺口 33 第二批：PDF 文本抽取 v2——第一批只取括号字面量字符串，
 * 中文 PDF 通常进不了。本批加：十六进制字符串 + ToUnicode CMap
 *（bfchar / bfrange）+ 内容流里的当前字体跟踪（Tf）。
 * 仍不支持：无 ToUnicode 且非 ASCII 的十六进制串（那是字形编号，
 * 宁可不返回也不返回乱码）、/Differences 自定义编码、加密与扫描件。
 * 图片流（DCT/JPX/CCITT/JBIG2）直接跳过，不把二进制垃圾当正文。 */
export function extractPdfText(buf: Buffer): string {
  const latin1 = buf.toString("latin1");
  interface PdfObj { dict: string; stream: Buffer | null }
  const objects = new Map<number, PdfObj>();
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(latin1)) !== null) {
    const num = parseInt(om[1], 10);
    const bodyStart = om.index + om[0].length;
    const endObj = latin1.indexOf("endobj", bodyStart);
    const bodyEnd = endObj < 0 ? latin1.length : endObj;
    const streamIdx = latin1.indexOf("stream", bodyStart);
    let dict = "";
    let stream: Buffer | null = null;
    if (streamIdx >= 0 && streamIdx < bodyEnd) {
      dict = latin1.slice(bodyStart, streamIdx);
      let dataStart = streamIdx + 6;
      if (latin1[dataStart] === "\r" && latin1[dataStart + 1] === "\n") dataStart += 2;
      else if (latin1[dataStart] === "\n" || latin1[dataStart] === "\r") dataStart += 1;
      const dataEnd = latin1.indexOf("endstream", dataStart);
      if (dataEnd >= 0) stream = Buffer.from(latin1.slice(dataStart, dataEnd), "latin1");
    } else dict = latin1.slice(bodyStart, bodyEnd);
    objects.set(num, { dict, stream });
  }
  if (!objects.size) return extractPdfTextLegacy(latin1);
  // 字体 → ToUnicode CMap 对象号；CMap 对象号 → 解析后的映射。
  const fontCmapObj = new Map<number, number>();
  for (const [num, obj] of objects) {
    const m = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (m) fontCmapObj.set(num, parseInt(m[1], 10));
  }
  const cmapByObj = new Map<number, { map: Map<number, string>; codeSize: number }>();
  for (const cmapNum of new Set(fontCmapObj.values())) {
    const obj = objects.get(cmapNum);
    if (!obj || !obj.stream) continue;
    const text = inflateStream(obj.stream, obj.dict);
    if (text !== null) cmapByObj.set(cmapNum, parseToUnicodeCMap(text));
  }
  // 页面 Resources 里的字体名 → CMap。
  const fontNameToCmap = new Map<string, { map: Map<number, string>; codeSize: number }>();
  for (const obj of objects.values()) {
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict);
    if (!fontDict) continue;
    const entryRe = /\/([A-Za-z0-9_]+)\s+(\d+)\s+\d+\s+R/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(fontDict[1])) !== null) {
      const cmapNum = fontCmapObj.get(parseInt(e[2], 10));
      if (cmapNum !== undefined) {
        const cmap = cmapByObj.get(cmapNum);
        if (cmap) fontNameToCmap.set(e[1], cmap);
      }
    }
  }
  const texts: string[] = [];
  const IMAGE_RE = /\/(Image|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|Crypt)\b/;
  for (const [num, obj] of objects) {
    if (!obj.stream) continue;
    if (cmapByObj.has(num)) continue;
    if (IMAGE_RE.test(obj.dict)) continue;
    if (/\/Type\s*\/Metadata\b/.test(obj.dict)) continue;
    const content = inflateStream(obj.stream, obj.dict);
    if (content === null || content.includes("/CIDInit")) continue;
    let currentFont: string | null = null;
    const tokenRe = /\/([A-Za-z0-9_]+)\s+[+-]?[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>/g;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRe.exec(content)) !== null) {
      const m0 = tok[0];
      if (tok[1] !== undefined) { currentFont = tok[1]; continue; }
      const cmap = currentFont ? fontNameToCmap.get(currentFont) : undefined;
      if (m0.startsWith("(")) {
        const bytes = unescapePdfBytes(m0.slice(1, -1));
        let text: string | null = null;
        if (cmap) text = decodeWithCmap(bytes, cmap);
        // 有 CMap 却解不出来、且全是可打印 ASCII 时才回退 latin1（同一内容流
        // 里十六进制中文串与括号 ASCII 串混用的情况）；含非 ASCII 字节时直接
        // 跳过，不回退成乱码。无 CMap 时按老口径当 latin1 文本。
        if (text === null && bytes.every((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09)) text = Buffer.from(bytes).toString("latin1");
        if (text === null && !cmap) text = Buffer.from(bytes).toString("latin1");
        if (text !== null && text.trim()) texts.push(text);
      } else {
        const hex = (tok[2] ?? "").replace(/\s+/g, "");
        if (!hex) continue;
        const bytes: number[] = [];
        for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
        if (hex.length % 2 === 1) bytes.push(parseInt(hex.slice(-1) + "0", 16));
        let text: string | null = null;
        if (cmap) text = decodeWithCmap(bytes, cmap);
        else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = decodeUtf16Be(bytes.slice(2));
        else if (bytes.every((b) => b < 0x80)) text = Buffer.from(bytes).toString("latin1");
        if (text !== null && text.trim()) texts.push(text);
      }
    }
  }
  return texts.join("\n").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** 结构损坏到解析不出任何对象时的兜底：按第一批的老口径，只扫内容流
 * 里的括号字面量字符串（图片流跳过）。 */
function extractPdfTextLegacy(latin1: string): string {
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
    const content = inflateStream(raw, dict);
    if (content === null) { streamRe.lastIndex = end; continue; }
    for (const lit of content.match(/\((?:\\.|[^\\()])*\)/g) ?? []) {
      const text = Buffer.from(unescapePdfBytes(lit.slice(1, -1))).toString("latin1");
      if (text.trim()) texts.push(text);
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
  /** 缺口 33 第二批：默认开确定性 rerank；false 时只按 BM25 排序（测试台调参对比用）。 */
  rerank?: boolean;
}

/** 缺口 33 第二批：确定性 rerank——BM25 分数 ×（1 + 覆盖率加成 + 标题命中加成）。
 * 覆盖率 = 查询词在命中文本里的去重覆盖比例；标题命中 = 标题含任一查询词。
 * 只调顺序、不改 BM25 本身；权重见 COVERAGE_BOOST / TITLE_BOOST。 */
export function rerankCandidates(
  queryTokens: string[],
  candidates: { bm25: number; title: string; text: string }[],
): number[] {
  const distinct = [...new Set(queryTokens)];
  return candidates.map((c) => {
    const textTokens = new Set(tokenize(c.text));
    const covered = distinct.filter((t) => textTokens.has(t)).length;
    const coverage = distinct.length ? covered / distinct.length : 0;
    const titleTokens = new Set(tokenize(c.title));
    const titleHit = distinct.some((t) => titleTokens.has(t)) ? 1 : 0;
    return c.bm25 * (1 + COVERAGE_BOOST * coverage + TITLE_BOOST * titleHit);
  });
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
        // 缺口 33 第二批：只计父块，子块不占条数。
        try { count = this.loadNotes(name).filter((n) => n.kind !== "child").length; } catch { count = 0; }
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
      const parent: Note = {
        id: randomBytes(6).toString("hex"), title: chunkTitle, source,
        date: noteDate, text: chunkBody, created_at: created,
      };
      added.push(parent);
      notes.push(parent);
      // 缺口 33 第二批 parent-child：父块再切子块（≤300 字），子块只用于
      // 精确匹配，命中后返回父块全文；返回给调用方仍是父块。
      for (const childText of chunkChildren(chunkBody)) {
        notes.push({
          id: randomBytes(6).toString("hex"), title: chunkTitle, source,
          date: noteDate, text: childText, created_at: created,
          parentId: parent.id, kind: "child",
        });
      }
    }
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
   * 元数据过滤（来源子串、日期范围）。非法参数直接抛错，不静默回默认。
   * 缺口 33 第二批：评分单元是子块（有子块的库）或父块（老库/短块）；
   * 先取 topK×3 个 BM25 候选做确定性 rerank，再按父块归并（同一父块
   * 只留最高分的那块，返回父块全文 + matchExcerpt 命中子块）。 */
  searchWithOptions(name: string, query: string, opts: KnowledgeSearchOptions = {}): [number, Note][] {
    const notes = this.loadNotes(name);
    const queryTokens = tokenize(query || "");
    if (!notes.length || !queryTokens.length) return [];
    if (opts.topK !== undefined && (!Number.isInteger(opts.topK) || opts.topK < 0)) throw new KnowledgeError("topK 须是不小于 0 的整数");
    const topK = opts.topK === undefined ? 5 : opts.topK;
    if (opts.minScore !== undefined && (typeof opts.minScore !== "number" || Number.isNaN(opts.minScore) || opts.minScore < 0)) throw new KnowledgeError("最低分须是不小于 0 的数字");
    const minScore = opts.minScore === undefined ? 0 : opts.minScore;
    if (opts.rerank !== undefined && typeof opts.rerank !== "boolean") throw new KnowledgeError("rerank 须是 true 或 false");
    const dateFrom = opts.dateFrom === undefined ? null : checkDate(opts.dateFrom);
    const dateTo = opts.dateTo === undefined ? null : checkDate(opts.dateTo);
    if (dateFrom && dateTo && dateFrom > dateTo) throw new KnowledgeError("开始日期不能晚于结束日期");
    const filtered = notes.filter((n) =>
      (opts.source === undefined || opts.source === "" || (n.source ?? "").includes(opts.source)) &&
      (dateFrom === null || (n.date ?? "") >= dateFrom) &&
      (dateTo === null || (n.date ?? "") <= dateTo));
    if (!filtered.length) return [];
    const units = this.scoringUnits(filtered);
    const docTokens = units.map((n) => tokenize(n.text ?? ""));
    const scored = scoreBm25(queryTokens, docTokens, Math.max(topK * RERANK_CANDIDATES_MULT, topK));
    return this.rankNotes(filtered, queryTokens, scored, units, { topK, minScore, rerank: opts.rerank !== false });
  }

  /** 评分单元：子块 + 没有子块的父块（短父块本身就是评分单元，不丢内容）。 */
  private scoringUnits(filtered: Note[]): Note[] {
    const childParentIds = new Set(filtered.filter((n) => n.kind === "child").map((n) => n.parentId));
    return filtered.filter((n) => n.kind === "child" || !childParentIds.has(n.id));
  }

  /** 把 BM25 候选排成最终结果：rerank（默认开）→ 子块按父块归并
   *（同一父块只留最高分那块，父块上挂 matchExcerpt）→ 取前 topK → 过最低分。 */
  private rankNotes(
    filtered: Note[],
    queryTokens: string[],
    scored: [number, number][],
    units: Note[],
    opts: { topK: number; minScore: number; rerank: boolean },
  ): [number, Note][] {
    const finalScores = opts.rerank
      ? rerankCandidates(queryTokens, scored.map(([s, i]) => ({ bm25: s, title: units[i].title ?? "", text: units[i].text ?? "" })))
      : scored.map(([s]) => s);
    const parents = new Map(filtered.filter((n) => n.kind !== "child").map((n) => [n.id, n] as [string, Note]));
    const byParent = new Map<string, [number, Note]>();
    const singles: [number, Note][] = [];
    scored.forEach(([, i], k) => {
      const note = units[i];
      const score = finalScores[k];
      if (note.kind === "child" && note.parentId) {
        const parent = parents.get(note.parentId);
        if (parent) {
          const prev = byParent.get(note.parentId);
          if (!prev || score > prev[0]) {
            byParent.set(note.parentId, [score, { ...parent, matchExcerpt: (note.text ?? "").replace(/\s+/g, " ").slice(0, 300) }]);
          }
          return;
        }
      }
      singles.push([score, note]);
    });
    const merged = [...byParent.values(), ...singles].sort((a, b) => b[0] - a[0]);
    return merged.slice(0, opts.topK).filter(([score]) => score >= opts.minScore);
  }

  search(name: string, query: string, topK = 5): [number, Note][] {
    return this.searchWithOptions(name, query, { topK });
  }

  /** 笔记数达到阈值时把评分挪到 worker 池，主线程不被 BM25 拖住；
   * 小库直接走同步 search，不付 worker 启动开销。结果与 search() 一致
   *（同一套子块评分 + rerank + 父块归并，只是 BM25 在 worker 里算）。 */
  async searchAsync(name: string, query: string, topK = 5): Promise<[number, Note][]> {
    const notes = this.loadNotes(name);
    const queryTokens = tokenize(query || "");
    if (!notes.length || !queryTokens.length) return [];
    if (notes.length < POOL_MIN_NOTES) return this.search(name, query, topK);
    const units = this.scoringUnits(notes);
    const pool = this.pool ?? (this.pool = new ToolPool());
    const docTokens = units.map((n) => tokenize(n.text ?? ""));
    const scored = (await pool.run("bm25", { queryTokens, docTokens, topK: Math.max(topK * RERANK_CANDIDATES_MULT, topK) } satisfies Bm25Payload)) as [number, number][];
    return this.rankNotes(notes, queryTokens, scored, units, { topK, minScore: 0, rerank: true });
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
  const provider = new Provider(resolveProvider({ home: resolveHome(), config, providerName: config.provider as string }));
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
        ...(argv.includes("--no-rerank") ? { rerank: false } : {}),
      };
      const results = store.searchWithOptions(name, argv[2], opts);
      if (!results.length) process.stdout.write("没有找到相关笔记。\n");
      for (const [score, note] of results) {
        process.stdout.write(`${score.toFixed(2)}\t${note.title ?? ""}\t来源：${note.source ?? ""}\t日期：${note.date ?? ""}\n`);
        if (note.matchExcerpt) process.stdout.write(`  命中片段：${note.matchExcerpt}\n`);
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
        ...(argv.includes("--no-rerank") ? { rerank: false } : {}),
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
            hits: r.hits.map(([score, n]) => ({ score: Number(score.toFixed(2)), title: n.title, source: n.source, date: n.date, excerpt: ((n.matchExcerpt ?? n.text ?? "").replace(/\s+/g, " ").slice(0, 200)) })),
          })),
          summary: { total: questions.length, hit: hitCount, avgTopScore: avgTopScore === null ? null : Number(avgTopScore.toFixed(2)) },
        }, null, 2) + "\n");
      } else {
        for (const r of results) {
          process.stdout.write(`问题：${r.question}\n`);
          if (!r.hits.length) process.stdout.write("  （无命中）\n");
          for (const [score, n] of r.hits) {
            process.stdout.write(`  ${score.toFixed(2)}\t${n.title ?? ""}\t来源：${n.source ?? ""}\t日期：${n.date ?? ""}\n`);
            if (n.matchExcerpt) process.stdout.write(`    命中片段：${n.matchExcerpt}\n`);
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
