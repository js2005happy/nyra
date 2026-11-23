// src/editorBridge.ts — 编辑器桥（G-P0-3 编辑器插件，相似 agent 调研报告 §2）。
//
// 为什么需要这一层：Nyra 原来只有一个 LSP 客户端（src/lsp.ts），是模型按需
// 调的工具，没有编辑器里的常驻入口——用户在编辑器里改代码时，Nyra 看不见
// 光标、选区、打开的文件和报错，上下文全靠人贴。本批按 Continue 的做法补
// 一层“IDE 接口抽象 + 各编辑器共用同一 core”：
//   - 协议：编辑器 host 与 Nyra 之间走 JSON-lines（每行一条消息），与 LSP
//     同款“不引重依赖、纯函数优先”的纪律；host 只负责采集与展示，core
//     （本文件）负责校验、快照、diff 预览与任务派发。
//   - host 目前三家：VS Code（editors/vscode，完整实现）、JetBrains
//     （editors/jetbrains，Kotlin 骨架）、Zed（editors/zed，Rust 协议核）。
//   - diff 预览学 Cline 的虚拟文档：只算 diff、不动磁盘，落盘须显式批准。
//
// 安全口径：
//   - 协议消息全部校验后才认：类型未知、字段缺失、路径越界一律拒绝并回 error，
//     服务循环不崩（fail-closed，不静默吞掉坏消息）。
//   - 路径只认工作区相对路径，绝对路径与 `..` 越界一律拒绝；事件里只记相对
//     路径与计数，不记文件原文；进模型上下文的文本先过脱敏（与 runs.redact
//     同款口径，见 sanitizeEditorText）。
//   - 写操作（apply）只走两条路：CLI `nyra editor apply --preview <id> --yes`
//    （显式 --yes），或 agent 自己的 apply_patch（走正常审批链）。协议层
//     的 apply 消息必须带 approved: true——扩展侧须先弹过用户确认才发，
//     服务端只认这一位，不替扩展做决定；serve 模式下跑起来的 agent 是
//     非交互子进程，写操作按既有规则 fail-closed（auto 模式非交互不执行写）。
//   - 快照与预览账本只存在机主自己的 ~/.nyra 下（0600），不经过网络。
//
// 循环导入：本文件静态 import 只限 node 内置 + lsp.ts（纯类型 + severityLabel，
// lsp.ts 本身只引 node 内置，不成环）。RunStore / EvidenceStore 一律在
// recordEditorEvent 里函数内动态 import（与 sessionSearch.ts 同款做法，
// tools → editorBridge → runs → tools 的环不能出现）。

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { severityLabel, type LspDiagnostic } from "./lsp.ts";

/** 协议版本：host 的 hello 必须报这个版本，不对直接拒绝。 */
export const EDITOR_PROTOCOL_VERSION = 1;
/** 进模型上下文的快照文本上限（字符）。 */
export const EDITOR_MAX_SNAPSHOT_CHARS = 4000;
/** ask 拼提示词时选区文本的上限（字符）；超了截断，不让 argv 炸掉。 */
export const EDITOR_MAX_SELECTION_CHARS = 2000;
/** 快照里最多记几个打开的文件 / 几条诊断（再多只记数，不贴全文）。 */
export const EDITOR_MAX_FILES = 10;
export const EDITOR_MAX_DIAGNOSTICS = 10;
/** 协议单行上限（字节）；超了直接拒绝，不解析。 */
export const EDITOR_MAX_LINE_BYTES = 1024 * 1024;
/** 待应用的预览最多留几个（先进先出 evict）。 */
export const EDITOR_MAX_PREVIEWS = 20;
/** diff 两边超过这么多行就不算逐行 diff，只给行数统计。 */
export const EDITOR_MAX_DIFF_LINES = 2000;

export class EditorBridgeError extends Error {
  constructor(message: string) { super(message); this.name = "EditorBridgeError"; }
}

export interface EditorPosition { line: number; column: number } // 0 基
export interface EditorSelection { start: EditorPosition; end: EditorPosition; text?: string }
export interface EditorOpenFile { path: string; language?: string; dirty?: boolean }
export type EditorDiagnostic = LspDiagnostic;

export interface EditorSnapshot {
  /** 工作区绝对路径（账本里存绝对路径；事件与模型文本里只出现相对路径）。 */
  workspace: string;
  /** 当前文件（工作区相对路径），无则 null。 */
  activeFile: string | null;
  cursor: EditorPosition | null;
  selection: EditorSelection | null;
  openFiles: EditorOpenFile[];
  diagnostics: EditorDiagnostic[];
  receivedAt: string; // ISO
  host: string; // "vscode" | "jetbrains" | "zed" | "cli"
}

export interface EditorPreview {
  id: string; // prv_<12hex>
  file: string; // 工作区相对路径
  oldText: string;
  newText: string;
  diff: string;
  additions: number;
  deletions: number;
  createdAt: string; // ISO
}

export type EditorMessage =
  | { type: "hello"; host: string; version: number }
  | { type: "snapshot"; snapshot: EditorSnapshot }
  | { type: "diagnostics"; file: string; diagnostics: EditorDiagnostic[] }
  | { type: "ask"; id: string; question: string }
  | { type: "preview"; id: string; file: string; newText: string }
  | { type: "apply"; id: string; previewId: string; approved: boolean }
  | { type: "ping"; id?: string };

export type EditorReply =
  | { type: "hello"; version: number; capabilities: string[] }
  | { type: "ack"; id?: string }
  | { type: "pong"; id?: string }
  | { type: "diff"; id: string; file: string; diff: string; additions: number; deletions: number; previewId: string }
  | { type: "applied"; id: string; file: string; additions: number; deletions: number }
  | { type: "answer_chunk"; id: string; text: string }
  | { type: "answer_done"; id: string; exitCode: number }
  | { type: "error"; id?: string; error: string };

/** 工作区相对路径是否合法：不为空、非绝对、没有 `..` 越界段。 */
export function isWorkspaceRelPath(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  const parts = p.replace(/\\/g, "/").split("/");
  return !parts.some((seg) => seg === "..");
}

function isPos(v: unknown): v is EditorPosition {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Number.isInteger(r.line) && (r.line as number) >= 0
    && Number.isInteger(r.column) && (r.column as number) >= 0;
}

function isDiag(v: unknown): v is EditorDiagnostic {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return isWorkspaceRelPath(r.file) && Number.isInteger(r.line) && Number.isInteger(r.column)
    && Number.isInteger(r.severity) && typeof r.message === "string";
}

/**
 * 校验一条协议消息（JSON 行已 parse 后的值）。非法直接抛 EditorBridgeError，
 * 调用方回 error、服务循环继续——坏消息不能拖垮 serve。
 */
export function parseEditorMessage(value: unknown): EditorMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EditorBridgeError("协议消息必须是 JSON 对象");
  }
  const m = value as Record<string, unknown>;
  const type = m.type;
  if (type === "hello") {
    if (typeof m.host !== "string" || !m.host) throw new EditorBridgeError("hello 缺 host");
    if (m.version !== EDITOR_PROTOCOL_VERSION) {
      throw new EditorBridgeError(`协议版本不对：要 ${EDITOR_PROTOCOL_VERSION}，收到 ${String(m.version)}`);
    }
    return { type: "hello", host: m.host, version: m.version };
  }
  if (type === "snapshot") {
    const s = m.snapshot as Record<string, unknown> | null | undefined;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new EditorBridgeError("snapshot 缺 snapshot 对象");
    if (typeof s.workspace !== "string" || !s.workspace) throw new EditorBridgeError("snapshot 缺 workspace");
    if (s.activeFile !== null && s.activeFile !== undefined && !isWorkspaceRelPath(s.activeFile)) {
      throw new EditorBridgeError("snapshot.activeFile 必须是工作区相对路径");
    }
    if (s.cursor !== null && s.cursor !== undefined && !isPos(s.cursor)) throw new EditorBridgeError("snapshot.cursor 不合法");
    if (s.selection !== null && s.selection !== undefined) {
      const sel = s.selection as Record<string, unknown>;
      if (!isPos(sel.start) || !isPos(sel.end)) throw new EditorBridgeError("snapshot.selection 不合法");
      if (sel.text !== undefined && typeof sel.text !== "string") throw new EditorBridgeError("snapshot.selection.text 必须是字符串");
    }
    if (s.openFiles !== undefined && (!Array.isArray(s.openFiles) || s.openFiles.some((f) => !f || typeof f !== "object" || !isWorkspaceRelPath((f as Record<string, unknown>).path)))) {
      throw new EditorBridgeError("snapshot.openFiles 里的 path 必须是工作区相对路径");
    }
    if (s.diagnostics !== undefined && (!Array.isArray(s.diagnostics) || s.diagnostics.some((d) => !isDiag(d)))) {
      throw new EditorBridgeError("snapshot.diagnostics 不合法");
    }
    if (typeof s.host !== "string" || !s.host) throw new EditorBridgeError("snapshot 缺 host");
    return {
      type: "snapshot",
      snapshot: {
        workspace: s.workspace,
        activeFile: (s.activeFile as string | null) ?? null,
        cursor: (s.cursor as EditorPosition | null) ?? null,
        selection: (s.selection as EditorSelection | null) ?? null,
        openFiles: (s.openFiles as EditorOpenFile[] | undefined) ?? [],
        diagnostics: (s.diagnostics as EditorDiagnostic[] | undefined) ?? [],
        receivedAt: typeof s.receivedAt === "string" ? s.receivedAt : new Date().toISOString(),
        host: s.host,
      },
    };
  }
  if (type === "diagnostics") {
    if (!isWorkspaceRelPath(m.file)) throw new EditorBridgeError("diagnostics.file 必须是工作区相对路径");
    if (!Array.isArray(m.diagnostics) || m.diagnostics.some((d) => !isDiag(d))) {
      throw new EditorBridgeError("diagnostics.diagnostics 不合法");
    }
    return { type: "diagnostics", file: m.file as string, diagnostics: m.diagnostics as EditorDiagnostic[] };
  }
  if (type === "ask") {
    if (typeof m.id !== "string" || !m.id) throw new EditorBridgeError("ask 缺 id");
    if (typeof m.question !== "string" || !m.question.trim()) throw new EditorBridgeError("ask 缺 question");
    return { type: "ask", id: m.id, question: m.question };
  }
  if (type === "preview") {
    if (typeof m.id !== "string" || !m.id) throw new EditorBridgeError("preview 缺 id");
    if (!isWorkspaceRelPath(m.file)) throw new EditorBridgeError("preview.file 必须是工作区相对路径");
    if (typeof m.newText !== "string") throw new EditorBridgeError("preview.newText 必须是字符串");
    return { type: "preview", id: m.id, file: m.file as string, newText: m.newText };
  }
  if (type === "apply") {
    if (typeof m.id !== "string" || !m.id) throw new EditorBridgeError("apply 缺 id");
    if (typeof m.previewId !== "string" || !m.previewId) throw new EditorBridgeError("apply 缺 previewId");
    if (m.approved !== true) throw new EditorBridgeError("apply 须带 approved: true（扩展侧须先经用户确认）");
    return { type: "apply", id: m.id, previewId: m.previewId, approved: true };
  }
  if (type === "ping") {
    return { type: "ping", id: typeof m.id === "string" ? m.id : undefined };
  }
  throw new EditorBridgeError(`未知的协议消息类型：${String(type)}`);
}

/**
 * 脱敏：与 src/runs.ts 的 redact() 同款口径（≥32 字连续词串、sk-/xai-、
 * Bearer、key=/token= 当疑似密钥掩掉）。本文件不静态 import runs.ts
 *（避开 tools → editorBridge → runs → tools 的环），规则抄一份、注释写明出处。
 */
export function sanitizeEditorText(text: string, maxChars = EDITOR_MAX_SNAPSHOT_CHARS): string {
  let s = (text || "").slice(0, maxChars);
  const patterns = [
    /\b(?:sk|xai)-[\w-]+/g,
    /\bBearer\s+\S+/gi,
    /\b(?:api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi,
    /(?<![\w])[A-Za-z0-9+/=_-]{32,}(?![\w])/g,
  ];
  for (const p of patterns) s = s.replace(p, "[已隐藏]");
  return s;
}

/** 把快照格式化成给模型 / 用户看的文本（已脱敏、已截断）。 */
export function formatEditorSnapshot(snapshot: EditorSnapshot | null, maxChars = EDITOR_MAX_SNAPSHOT_CHARS): string {
  if (!snapshot) return "编辑器未连接：没有收到过编辑器快照（先在编辑器里装 Nyra 插件，或跑 nyra editor serve）。";
  const lines: string[] = [];
  lines.push(`编辑器快照（${snapshot.host}，${snapshot.receivedAt}）`);
  lines.push(`工作区：${snapshot.workspace}`);
  lines.push(`当前文件：${snapshot.activeFile ?? "（无）"}` + (snapshot.cursor ? `（光标 ${snapshot.cursor.line + 1}:${snapshot.cursor.column + 1}）` : ""));
  if (snapshot.selection?.text) {
    const sel = snapshot.selection;
    lines.push(`选区：${sel.start.line + 1}:${sel.start.column + 1}–${sel.end.line + 1}:${sel.end.column + 1}`);
    lines.push(sanitizeEditorText(sel.text ?? "", EDITOR_MAX_SELECTION_CHARS));
  }
  if (snapshot.openFiles.length) {
    lines.push(`打开的文件（${snapshot.openFiles.length}）：`);
    for (const f of snapshot.openFiles.slice(0, EDITOR_MAX_FILES)) {
      lines.push(`- ${f.path}${f.dirty ? "（未保存）" : ""}`);
    }
    if (snapshot.openFiles.length > EDITOR_MAX_FILES) lines.push(`- ……还有 ${snapshot.openFiles.length - EDITOR_MAX_FILES} 个`);
  }
  if (snapshot.diagnostics.length) {
    const errors = snapshot.diagnostics.filter((d) => d.severity === 1).length;
    const warnings = snapshot.diagnostics.filter((d) => d.severity === 2).length;
    lines.push(`诊断（${snapshot.diagnostics.length} 条，错误 ${errors} / 警告 ${warnings}）：`);
    for (const d of snapshot.diagnostics.slice(0, EDITOR_MAX_DIAGNOSTICS)) {
      lines.push(`- ${d.file}:${d.line + 1}:${d.column + 1} [${severityLabel(d.severity)}] ${sanitizeEditorText(d.message, 200)}`);
    }
    if (snapshot.diagnostics.length > EDITOR_MAX_DIAGNOSTICS) lines.push(`- ……还有 ${snapshot.diagnostics.length - EDITOR_MAX_DIAGNOSTICS} 条`);
  }
  return sanitizeEditorText(lines.join("\n"), maxChars);
}

/** diff 一行：op " " 上下文、"-" 删、"+" 增。 */
export interface DiffLine { op: " " | "-" | "+"; text: string }

/**
 * LCS 行级 diff（纯函数）。两边各超过 EDITOR_MAX_DIFF_LINES 行时不算逐行
 * diff、调用方只报行数统计——大文件 diff 的 DP 表会把内存吃光。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length > EDITOR_MAX_DIFF_LINES || b.length > EDITOR_MAX_DIFF_LINES) {
    throw new EditorBridgeError(`文件太大不逐行比对（旧 ${a.length} 行 / 新 ${b.length} 行，上限 ${EDITOR_MAX_DIFF_LINES} 行）`);
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度；倒着填，行数不大时够用。
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ op: "-", text: a[i]! }); i++; }
    else { out.push({ op: "+", text: b[j]! }); j++; }
  }
  while (i < n) { out.push({ op: "-", text: a[i]! }); i++; }
  while (j < m) { out.push({ op: "+", text: b[j]! }); j++; }
  return out;
}

export interface UnifiedDiff { text: string; additions: number; deletions: number }

/** 行级 diff → unified 格式（3 行上下文，hunk 重叠时合并）。 */
export function buildUnifiedDiff(oldText: string, newText: string, fileLabel: string): UnifiedDiff {
  const lines = diffLines(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.op === "+") additions++;
    if (l.op === "-") deletions++;
  }
  if (additions === 0 && deletions === 0) {
    return { text: `--- a/${fileLabel}\n+++ b/${fileLabel}\n（无改动）\n`, additions, deletions };
  }
  const CONTEXT = 3;
  // 先标出所有改动行的下标，再按上下文窗口切 hunk、重叠的合并。
  const changed: number[] = [];
  lines.forEach((l, idx) => { if (l.op !== " ") changed.push(idx); });
  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(lines.length, idx + CONTEXT + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const out: string[] = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  for (const [start, end] of hunks) {
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (let k = 0; k < start; k++) {
      if (lines[k]!.op !== "+") oldStart++;
      if (lines[k]!.op !== "-") newStart++;
    }
    for (let k = start; k < end; k++) {
      if (lines[k]!.op !== "+") oldCount++;
      if (lines[k]!.op !== "-") newCount++;
    }
    out.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
    for (let k = start; k < end; k++) out.push(`${lines[k]!.op}${lines[k]!.text}`);
  }
  return { text: out.join("\n") + "\n", additions, deletions };
}

/** diff 一句话摘要（进事件与 CLI 输出）。 */
export function summarizeDiff(d: UnifiedDiff): string {
  return `+${d.additions} −${d.deletions}`;
}

// ---- 账本（~/.nyra 下，0600；原子写：写临时文件再 rename）----

export function editorStatePath(home: string): string {
  return join(home, "editor-state.json");
}

export function editorPreviewsPath(home: string): string {
  return join(home, "editor-previews.json");
}

function atomicWriteJson0600(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadEditorState(home: string): EditorSnapshot | null {
  const path = editorStatePath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const s = raw.snapshot as Record<string, unknown> | null | undefined;
    if (!s || typeof s !== "object") return null;
    return {
      workspace: typeof s.workspace === "string" ? s.workspace : "",
      activeFile: typeof s.activeFile === "string" ? s.activeFile : null,
      cursor: (s.cursor as EditorPosition | null) ?? null,
      selection: (s.selection as EditorSelection | null) ?? null,
      openFiles: Array.isArray(s.openFiles) ? (s.openFiles as EditorOpenFile[]) : [],
      diagnostics: Array.isArray(s.diagnostics) ? (s.diagnostics as EditorDiagnostic[]) : [],
      receivedAt: typeof s.receivedAt === "string" ? s.receivedAt : new Date().toISOString(),
      host: typeof s.host === "string" ? s.host : "unknown",
    };
  } catch {
    return null;
  }
}

export function saveEditorState(home: string, snapshot: EditorSnapshot): void {
  atomicWriteJson0600(editorStatePath(home), { snapshot, updatedAt: new Date().toISOString() });
}

export function loadEditorPreviews(home: string): EditorPreview[] {
  const path = editorPreviewsPath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is EditorPreview =>
      !!p && typeof p === "object" && typeof (p as EditorPreview).id === "string"
      && typeof (p as EditorPreview).file === "string");
  } catch {
    return [];
  }
}

export function saveEditorPreviews(home: string, previews: EditorPreview[]): void {
  atomicWriteJson0600(editorPreviewsPath(home), previews.slice(0, EDITOR_MAX_PREVIEWS));
}

export function previewId(): string {
  const hex = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
  return `prv_${hex}`;
}

/**
 * 编辑器事件记进证据链：本批的 editor 事件没有运行上下文（serve/CLI 命令
 * 都不在某次 agent 运行里），统一走 evidence/editor/ 证据文件；RunStore
 * 的 appendEvent 也认这些类型（EVENT_FIELDS 已注册），后续网关/运行内
 * 需要时可直接 append。函数内动态 import，避开循环导入。
 */
export async function recordEditorEvent(
  home: string,
  type: string,
  fields: Record<string, unknown>,
  citationText: string,
): Promise<{ channel: "evidence" | "none"; path?: string }> {
  try {
    const { EvidenceStore } = await import("./evidence.ts");
    const path = new EvidenceStore(join(home, "evidence"), "editor").save(
      type, `editor://${type}`, citationText, null,
    );
    return { channel: "evidence", path };
  } catch {
    return { channel: "none" };
  }
}

/** 解析 CLI 入口（ask 派生子进程用）：NYRA_CLI_PATH > bun + 仓库内 cli.ts > 当前可执行文件自身（编译后的 nyra 二进制）。 */
export function resolveNyraCliCommand(): { cmd: string; args: string[] } {
  const env = process.env.NYRA_CLI_PATH?.trim();
  if (env) {
    if (env.endsWith(".ts")) return { cmd: process.execPath, args: [env] };
    return { cmd: env, args: [] };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const cliTs = join(here, "cli.ts");
  if (process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe")) {
    return { cmd: process.execPath, args: [cliTs] };
  }
  return { cmd: process.execPath, args: [] };
}

export interface RunTaskResult { text: string; exitCode: number }

/**
 * 默认 ask 执行器：派生一个子进程跑一次完整 CLI 任务（`nyra "<提示词>"`），
 * 提示词 = 编辑器快照格式化文本 + 用户问题。子进程就是正常的 CLI 运行：
 * provider、成本硬顶、审批链全在；serve 模式下子进程 stdin 为 null（非交互），
 * 写操作按既有规则 fail-closed，只读问答照常跑。stdout 按行流回给调用方。
 */
export function defaultRunTask(
  prompt: string,
  opts: { workdir: string; onChunk?: (text: string) => void },
): Promise<RunTaskResult> {
  const { cmd, args } = resolveNyraCliCommand();
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(cmd, [...args, prompt], { cwd: opts.workdir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let out = "";
    let errText = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => { out += d; opts.onChunk?.(d); });
    child.stderr.on("data", (d: string) => { errText += d; });
    child.on("error", (err) => rejectPromise(new Error(`启动 Nyra 子进程失败（${cmd}）：${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ text: out, exitCode: 0 });
      else resolvePromise({ text: out || errText, exitCode: code ?? 1 });
    });
  });
}

export interface EditorBridgeOptions {
  home: string;
  workdir: string;
  onEvent?: (type: string, fields: Record<string, unknown>) => void;
  /** ask 的流式回答回调（serve 循环用它把 chunk 直接写回扩展）。 */
  onAnswerChunk?: (id: string, text: string) => void;
  runTask?: (prompt: string, onChunk: (text: string) => void) => Promise<RunTaskResult>;
}

/**
 * 编辑器桥核心：协议处理 + 快照/预览状态。读工作区文件（preview 的旧内容）
 * 与 apply 的写盘都在这里做（它持有工作区）；写盘只发生在 handle({apply})
 * 校验通过之后（预览存在、文件自预览后未变），写盘失败抛错、预览保留可重试。
 */
export class EditorBridge {
  readonly home: string;
  readonly workdir: string;
  snapshot: EditorSnapshot | null = null;
  previews = new Map<string, EditorPreview>();
  private onEvent?: EditorBridgeOptions["onEvent"];
  private onAnswerChunk?: EditorBridgeOptions["onAnswerChunk"];
  // runTask 在构造函数里一定有值（没传就用 defaultRunTask）：字段类型不写
  // 可选，否则每次调用都要先判空。onAnswerChunk / onEvent 可以没有，保持可选。
  private runTask: (prompt: string, onChunk: (text: string) => void) => Promise<RunTaskResult>;

  constructor(opts: EditorBridgeOptions) {
    this.home = opts.home;
    this.workdir = resolve(opts.workdir);
    this.onEvent = opts.onEvent;
    this.onAnswerChunk = opts.onAnswerChunk;
    this.runTask = opts.runTask ?? ((prompt, onChunk) => defaultRunTask(prompt, { workdir: this.workdir, onChunk }));
    this.snapshot = loadEditorState(opts.home);
    for (const p of loadEditorPreviews(opts.home)) this.previews.set(p.id, p);
  }

  private emit(type: string, fields: Record<string, unknown>): void {
    try { this.onEvent?.(type, fields); } catch { /* 事件回调故障不破坏协议处理 */ }
  }

  private persistSnapshot(): void {
    if (this.snapshot) {
      try { saveEditorState(this.home, this.snapshot); } catch { /* 账本写失败不破坏协议处理 */ }
    }
  }

  private persistPreviews(): void {
    try { saveEditorPreviews(this.home, [...this.previews.values()]); } catch { /* 同上 */ }
  }

  /** 工作区校验：snapshot.workspace 须等于 serve 的工作区（归一化后比对）。 */
  private checkWorkspace(workspace: string): void {
    if (resolve(workspace) !== this.workdir) {
      throw new EditorBridgeError(`快照的工作区与 serve 的工作区不一致：${workspace}（serve 在 ${this.workdir}）`);
    }
  }

  /** 处理一条已校验的协议消息，返回要发回的回复（ask 会产生多条）。 */
  async handle(msg: EditorMessage): Promise<EditorReply[]> {
    switch (msg.type) {
      case "hello": {
        this.emit("editor_connected", { host: msg.host, workspace: this.workdir });
        return [{ type: "hello", version: EDITOR_PROTOCOL_VERSION, capabilities: ["snapshot", "diagnostics", "ask", "preview", "apply"] }];
      }
      case "ping":
        return [{ type: "pong", id: msg.id }];
      case "snapshot": {
        this.checkWorkspace(msg.snapshot.workspace);
        const snap: EditorSnapshot = { ...msg.snapshot, receivedAt: new Date().toISOString() };
        this.snapshot = snap;
        this.persistSnapshot();
        this.emit("editor_snapshot", {
          workspace: this.workdir, files: snap.openFiles.length, diagnostics: snap.diagnostics.length,
        });
        return [{ type: "ack" }];
      }
      case "diagnostics": {
        const file = msg.file;
        const prev = this.snapshot;
        const kept = (prev?.diagnostics ?? []).filter((d) => d.file !== file);
        const snap: EditorSnapshot = prev ?? {
          workspace: this.workdir, activeFile: file, cursor: null, selection: null,
          openFiles: [], diagnostics: [], receivedAt: new Date().toISOString(), host: "unknown",
        };
        snap.diagnostics = [...kept, ...msg.diagnostics].slice(0, EDITOR_MAX_DIAGNOSTICS * 4);
        snap.receivedAt = new Date().toISOString();
        this.snapshot = snap;
        this.persistSnapshot();
        const errors = msg.diagnostics.filter((d) => d.severity === 1).length;
        this.emit("editor_diagnostics", { workspace: this.workdir, file, errors, warnings: msg.diagnostics.length - errors });
        return [{ type: "ack" }];
      }
      case "ask": {
        const prompt = [
          "以下是用户当前编辑器里的上下文（只读快照，文件内容以磁盘为准）：",
          formatEditorSnapshot(this.snapshot),
          "",
          `用户的问题：${msg.question}`,
        ].join("\n");
        this.emit("editor_asked", { workspace: this.workdir, chars: prompt.length });
        const replies: EditorReply[] = [];
        try {
          const result = await this.runTask(prompt, (chunk) => {
            try { this.onAnswerChunk?.(msg.id, chunk); } catch { /* 流式回调故障不破坏本次回答 */ }
          });
          replies.push({ type: "answer_done", id: msg.id, exitCode: result.exitCode });
        } catch (err) {
          replies.push({ type: "error", id: msg.id, error: err instanceof Error ? err.message : String(err) });
        }
        return replies;
      }
      case "preview": {
        const current = this.readWorkspaceFile(msg.file);
        const diff = buildUnifiedDiff(current, msg.newText, msg.file);
        const id = previewId();
        const preview: EditorPreview = {
          id, file: msg.file, oldText: current, newText: msg.newText,
          diff: diff.text, additions: diff.additions, deletions: diff.deletions,
          createdAt: new Date().toISOString(),
        };
        this.previews.set(id, preview);
        while (this.previews.size > EDITOR_MAX_PREVIEWS) {
          const first = this.previews.keys().next().value;
          if (first === undefined) break;
          this.previews.delete(first);
        }
        this.persistPreviews();
        this.emit("editor_preview", { file: msg.file, additions: diff.additions, deletions: diff.deletions });
        return [{ type: "diff", id: msg.id, file: msg.file, diff: diff.text, additions: diff.additions, deletions: diff.deletions, previewId: id }];
      }
      case "apply": {
        const preview = this.previews.get(msg.previewId);
        if (!preview) throw new EditorBridgeError(`预览不存在或已过期：${msg.previewId}（serve 重启会丢预览，重新 preview 一次）`);
        const current = this.readWorkspaceFile(preview.file);
        if (current !== preview.oldText) {
          throw new EditorBridgeError(`文件已变（${preview.file} 自预览后被改过），拒绝应用——重新 preview 一次再确认`);
        }
        // 校验通过后才写盘：写盘本身就在 bridge 里（它持有工作区），写完再删
        // 预览、记事件——写盘失败抛错，预览保留、可重试。
        this.applyPreviewToDisk(preview);
        this.previews.delete(msg.previewId);
        this.persistPreviews();
        this.emit("editor_applied", { file: preview.file, additions: preview.additions, deletions: preview.deletions });
        return [{ type: "applied", id: msg.id, file: preview.file, additions: preview.additions, deletions: preview.deletions }];
      }
    }
  }

  /** 读工作区文件（preview/apply 的旧内容来源）；不存在报明确错误，不编内容。 */
  readWorkspaceFile(relPath: string): string {
    if (!isWorkspaceRelPath(relPath)) throw new EditorBridgeError(`不是工作区相对路径：${relPath}`);
    const abs = join(this.workdir, relPath);
    if (!existsSync(abs)) throw new EditorBridgeError(`文件不存在：${relPath}`);
    return readFileSync(abs, "utf-8");
  }

  /** 把已校验的预览写盘（apply 的最后一步；调用方须先调 handle({apply}) 校验过）。 */
  applyPreviewToDisk(preview: EditorPreview): void {
    const abs = join(this.workdir, preview.file);
    writeFileSync(abs, preview.newText, "utf-8");
  }
}

/**
 * serve 循环：stdin 读 JSON 行、stdout 写 JSON 行。坏行回 error、不崩循环；
 * stdin 关了就退出（扩展关掉 serve 就停，不留僵尸进程）。
 * ask 的 answer_chunk 由 bridge 的 onAnswerChunk 直接写出（流式回给扩展，
 * 不等整轮跑完）；handle 返回的数组里只有 answer_done / error。
 */
export async function serveEditorBridge(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts: EditorBridgeOptions,
): Promise<number> {
  const write = (reply: EditorReply): void => {
    output.write(JSON.stringify(reply) + "\n");
  };
  const bridge = new EditorBridge({
    ...opts,
    onAnswerChunk: (id, text) => write({ type: "answer_chunk", id, text }),
  });
  // rl 漏定义过一次（serve 一跑就报 rl is not defined）：readline 接口须在这里建。
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (Buffer.byteLength(line, "utf-8") > EDITOR_MAX_LINE_BYTES) {
      write({ type: "error", error: "协议行超过 1MB，直接拒绝" });
      continue;
    }
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      write({ type: "error", error: "不是合法 JSON" });
      continue;
    }
    let msg: EditorMessage;
    try {
      msg = parseEditorMessage(value);
    } catch (err) {
      write({ type: "error", error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const replies = await bridge.handle(msg);
      for (const r of replies) write(r);
    } catch (err) {
      write({ type: "error", id: "id" in msg ? (msg as { id?: string }).id : undefined, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return 0;
}
