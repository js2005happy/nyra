// src/watch.ts — 缺口 32：变化监测例程 Watch / Watch-with-action
// （OpenRouter 调研报告 §6，扩展缺口 7、8）。
//
// 别家（Proto Routines）的做法：Watch 盯一个页面，变了才汇报，汇报回
// 到同一会话、开头先讲变了什么；Watch with an action 是变化触发动作
// （如“承运商门户出现 9 月发票就下载”）；缺东西时明确说缺什么，而不
// 是静默失败。Nyra 怎么做得更好：Watch 做成“只读巡查”的最小形态——
// 缺口 8 的“无人值守强制只读”天然适用，Watch 默认只能读不能写；变化
// 检测先做 URL 与本地文件两类（diff 摘要 + 变化证据），汇报格式固定
// 为“变了什么 → 详情 → 来源”；Watch-with-action 的触发条件与动作分
// 开声明，敏感动作须人批；每次触发都记进证据链。
//
// 口径：
//   - 盯什么：URL（http/https，抓文本）或本地文件（读文本）；二进制
//     内容只比哈希、不做行级对比，汇报里明说。
//   - 第一次见到只记基线，不汇报（与 Bot notifier 的 watches 同款口
//     径）；之后哈希变了才算变了。目标第一次就不在 / 抓不到时记基线
//     missing 并向收件箱报一次“缺东西”，之后持续缺失只记审计、不重
//     复刷收件箱；目标从有变没（或从没变有）是变化，要汇报。
//   - diff 摘要是行级新增/删除行数 + 各最多 8 行摘录（多集差分，不
//     是完整 unified diff）；超 64KB 的内容只比哈希、不做行级对比。
//   - 触发条件与动作分开声明：条件 any（任何变化）或 contains:<子串>
//     （新内容含该子串才触发）；动作 report（只汇报，默认）、
//     enqueue-task:<任务>（变化触发后把任务推进任务队列，执行时照
//     常走审批门）、download:<相对路径>（敏感写操作——触发时只记一
//     条待批准动作，不下载；人跑 `nyra watch run-action <id> --yes`
//     才真的下载）。
//   - 汇报固定格式“变了什么 → 详情 → 来源”，写收件箱（inbox.jsonl）。
//
// 刹车（一条不丢）：
//   - 自动巡查默认关（watch.enabled 默认 false，须显式开；手动
//     `nyra watch check` 是人当场点的动作，不受开关限制）；
//   - Watch 本身只读（抓 URL、读文件），不调模型、不写监测目标以外
//     的文件、不对外发；无人值守只做红线表允许的事，敏感动作照样人批；
//   - download 动作不自动执行，须人显式 `--yes`；入队任务的写操作
//     在 worker 执行时照常走审批（auto 模式逐项问），不绕审批。
//
// 账本 ~/.nyra/watches.json（原子写 0600，损坏先备份再抛错）；上次内
// 容快照存 ~/.nyra/watch-snapshots/<id>.txt（0600，前 64KB）；每次变
// 化 / 缺失 / 动作触发 / 动作待批 / 动作完成都记一行
// ~/.nyra/watch-audit.jsonl（append-only 0600）；动作入队了任务时，
// 触发与完成同时镜像进该任务的运行事件（watch_action_triggered /
// watch_action_done，注册进 EVENT_FIELDS）；变化与缺失没有运行上下
// 文时只记审计与收件箱，不编一个假运行出来。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { loadConfig, resolveHome, saveConfig } from "./config.ts";
import { RunStore } from "./runs.ts";
import { addTask, appendInbox } from "./tasks.ts";
import { pythonJsonDump } from "./pyjson.ts";

export class WatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchError";
  }
}

/** 监测 id：小写字母/数字开头，小写字母/数字/_/-，最长 32 字。 */
export const WATCH_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** 默认每几秒检查一次（整数 60–86400，非法回默认）。 */
export const DEFAULT_WATCH_INTERVAL_SECONDS = 3600;
/** 快照与行级对比只取前这么多字符（超了只比哈希）。 */
export const MAX_SNAPSHOT_CHARS = 65536;
/** diff 摘要每侧最多展示几行摘录。 */
export const MAX_DIFF_LINES = 8;
/** URL 抓取超时（毫秒）。 */
export const FETCH_TIMEOUT_MS = 20000;

export interface WatchCondition {
  kind: "any" | "contains";
  /** contains 的子串；any 时为空串。 */
  arg: string;
}

export interface WatchAction {
  kind: "report" | "enqueue-task" | "download";
  /** enqueue-task 的任务正文 / download 的相对路径；report 时为空串。 */
  arg: string;
}

export interface WatchPendingAction {
  action: WatchAction;
  at: string;
  fromHash: string;
  toHash: string;
}

export interface Watch {
  id: string;
  label: string;
  kind: "url" | "file";
  target: string;
  intervalSeconds: number;
  enabled: boolean;
  condition: WatchCondition;
  action: WatchAction;
  createdAt: string;
  lastCheckAt: string | null;
  /** 上次内容的短哈希（12 位）；"missing" 表示目标当时不存在/抓不到。 */
  lastHash: string | null;
  lastStatus: string | null;
  pendingAction: WatchPendingAction | null;
}

export interface WatchStore {
  version: 1;
  watches: Watch[];
}

export interface WatchSettings {
  enabled: boolean;
  defaultIntervalSeconds: number;
}

/** 与 resolveReconcilerSettings 同款口径：逐字段校验，非法回默认。 */
export function resolveWatchSettings(config: Record<string, unknown>): WatchSettings {
  const raw = (config.watch ?? {}) as Record<string, unknown>;
  const interval = raw.default_interval_seconds;
  const defaultIntervalSeconds = typeof interval === "number" && Number.isInteger(interval) && interval >= 60 && interval <= 86400
    ? interval : DEFAULT_WATCH_INTERVAL_SECONDS;
  return { enabled: raw.enabled === true, defaultIntervalSeconds };
}

export function watchesPath(home: string): string {
  return join(home, "watches.json");
}

export function watchAuditPath(home: string): string {
  return join(home, "watch-audit.jsonl");
}

export function watchSnapshotPath(home: string, id: string): string {
  return join(home, "watch-snapshots", `${id}.txt`);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadWatchStore(home: string): WatchStore {
  const path = watchesPath(home);
  if (!existsSync(path)) return { version: 1, watches: [] };
  if (lstatSync(path).isSymbolicLink()) throw new WatchError("监测账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new WatchError("监测账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as WatchStore).version !== 1 || !Array.isArray((raw as WatchStore).watches)) {
    backupCorrupt(path);
    throw new WatchError("监测账本格式无效，已备份");
  }
  const store = raw as WatchStore;
  for (const w of store.watches) {
    if (typeof w.intervalSeconds !== "number") w.intervalSeconds = DEFAULT_WATCH_INTERVAL_SECONDS;
    if (typeof w.enabled !== "boolean") w.enabled = true;
    if (!w.condition) w.condition = { kind: "any", arg: "" };
    if (!w.action) w.action = { kind: "report", arg: "" };
    if (w.pendingAction === undefined) w.pendingAction = null;
  }
  return store;
}

export function saveWatchStore(home: string, store: WatchStore): void {
  const path = watchesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new WatchError("监测账本不能是符号链接");
  const tmp = join(dirname(path), `.watches-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

/** 短哈希（12 位 hex）：事件里只记短哈希——appendEvent 会把 ≥32 字连续
 * 词串当疑似密钥掩掉（与 Bot notifier 的 fileHash 同款口径）。 */
export function shortHash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

/** 每次变化 / 缺失 / 动作都记一行审计（append-only 0600，写失败不拦监测）。 */
export function appendWatchAudit(home: string, event: string, fields: Record<string, unknown>): void {
  try {
    const path = watchAuditPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const entry = { at: nowIso(), event, ...fields };
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, pythonJsonDump(entry) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch { /* 审计写不上不破坏监测 */ }
}

/**
 * 有运行上下文时把动作镜像进运行事件（证据链）；没上下文时审计就是
 * 证据，不编假运行（与 reconciler 的 mirrorEvent 同款口径）。
 */
function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

/** 条件文本解析：any 或 contains:<子串>。 */
export function parseCondition(raw: string): WatchCondition {
  const text = (raw ?? "").trim();
  if (text === "" || text === "any") return { kind: "any", arg: "" };
  if (text.startsWith("contains:")) {
    const arg = text.slice("contains:".length);
    if (!arg.trim() || arg.length > 200) throw new WatchError("--condition contains: 后须跟 1–200 字的子串");
    return { kind: "contains", arg };
  }
  throw new WatchError("--condition 只认 any 或 contains:<子串>");
}

/** 动作文本解析：report、enqueue-task:<任务>、download:<相对路径>。 */
export function parseAction(raw: string): WatchAction {
  const text = (raw ?? "").trim();
  if (text === "" || text === "report") return { kind: "report", arg: "" };
  if (text.startsWith("enqueue-task:")) {
    const arg = text.slice("enqueue-task:".length);
    if (!arg.trim() || arg.length > 8000) throw new WatchError("--action enqueue-task: 后须跟 1–8000 字的任务");
    return { kind: "enqueue-task", arg };
  }
  if (text.startsWith("download:")) {
    const arg = text.slice("download:".length).trim();
    validateDownloadDest(arg);
    return { kind: "download", arg };
  }
  throw new WatchError("--action 只认 report、enqueue-task:<任务>、download:<相对路径>");
}

/** download 目的地只认 cwd 下的相对路径（不认绝对路径、不认 .. 逃逸）。 */
export function validateDownloadDest(dest: string): void {
  if (!dest || isAbsolute(dest) || /^[A-Za-z]:/.test(dest)) {
    throw new WatchError("download 目的地只认相对路径（不要写绝对路径）");
  }
  const parts = dest.split(/[\\/]/);
  if (parts.some((p) => p === "..")) throw new WatchError("download 目的地不能含 .. 逃逸出当前目录");
  if (parts.some((p) => p === "")) throw new WatchError("download 目的地不能含空路径段");
}

/** 立监测时的校验（id 不重复由调用方查账本）。 */
export function validateWatch(input: Record<string, unknown>): Watch {
const id = String(input.id?? "").trim();
if (!WATCH_ID_RE.test(id)) throw new WatchError("--id 只认小写字母/数字开头、小写字母/数字/_/-、最长 32 字");
const label = String(input.label?? "").trim();
if (!label || label.length > 100) throw new WatchError("--label 不能为空且不超过 100 字");
const kind = input.kind as string;
if (kind!== "url" && kind!== "file") throw new WatchError("监测类型只认 url 或 file");
const target = String(input.target?? "").trim();
if (!target) throw new WatchError("监测目标不能为空");
if (kind === "url" &&!target.startsWith("http://") &&!target.startsWith("https://")) {
throw new WatchError("url 监测只认 http:// 或 https:// 开头的地址");
}
const interval = input.intervalSeconds;
const intervalSeconds = typeof interval === "number" && Number.isInteger(interval) && interval >= 60 && interval <= 86400
? interval: DEFAULT_WATCH_INTERVAL_SECONDS;
const condition = input.condition as WatchCondition?? { kind: "any", arg: ""};
if (condition.kind!== "any" && condition.kind!== "contains") throw new WatchError("触发条件只认 any 或 contains");
if (condition.kind === "contains" && (!condition.arg.trim() || condition.arg.length > 200)) {
throw new WatchError("contains 条件须跟 1–200 字的子串");
}
const action = input.action as WatchAction?? { kind: "report", arg: ""};
if (!["report", "enqueue-task", "download"].includes(action.kind)) throw new WatchError("动作只认 report、enqueue-task、download");
if (action.kind === "enqueue-task" && (!action.arg.trim() || action.arg.length > 8000)) {
throw new WatchError("enqueue-task 动作须跟 1–8000 字的任务");
}
if (action.kind === "download") validateDownloadDest(action.arg);
return {
id, label, kind, target, intervalSeconds,
enabled: input.enabled!== false,
condition, action,
createdAt: nowIso(), lastCheckAt: null, lastHash: null, lastStatus: null,
pendingAction: null,
};
}

export function addWatch(home: string, input: Record<string, unknown>): Watch {
const store = loadWatchStore(home);
const watch = validateWatch(input);
if (store.watches.some((w) => w.id === watch.id)) throw new WatchError(`已有同名监测：${watch.id}`);
store.watches.push(watch);
saveWatchStore(home, store);
return watch;
}

export function removeWatch(home: string, id: string): boolean {
const store = loadWatchStore(home);
const idx = store.watches.findIndex((w) => w.id === id);
if (idx < 0) return false;
store.watches.splice(idx, 1);
saveWatchStore(home, store);
try { rmSync(watchSnapshotPath(home, id), { force: true});} catch { /* 快照删不掉不破坏移除 */}
return true;
}

export function listWatches(home: string): Watch[] {
return loadWatchStore(home).watches;
}

export function getWatch(home: string, id: string): Watch | null {
return loadWatchStore(home).watches.find((w) => w.id === id)?? null;
}

export function setWatchEnabled(home: string, id: string, enabled: boolean): Watch {
const store = loadWatchStore(home);
const watch = store.watches.find((w) => w.id === id);
if (!watch) throw new WatchError(`没有这个监测：${id}`);
watch.enabled = enabled;
saveWatchStore(home, store);
return watch;
}

/** 取回的内容：ok + 文本（非文本时 text 为 null，只比哈希）。 */
export interface WatchContent {
ok: boolean;
/** 文本内容；二进制内容为 null。 */
text: string | null;
/** 内容短哈希（12 位；missing 时为 "missing"）。 */
hash: string;
/** 取不到时为 true（文件不存在 / 404）。 */
missing: boolean;
/** 取不到或出错时的原因（人话）。 */
reason: string | null;
}

export interface WatchProviders {
now?: Date;
/** URL 抓取（测试注入假函数，不碰真网）。 */
fetchText?: (url: string) => Promise<WatchContent>;
/** 本地文件读取（测试注入假函数，不碰真文件）。 */
readFile?: (path: string) => WatchContent;
}

const UA = "Nyra/0.5.10 (watch)";

async function defaultFetchText(url: string): Promise<WatchContent> {
let res: Response;
try {
res = await fetch(url, { headers: { "User-Agent": UA}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
} catch (err: unknown) {
return { ok: false, text: null, hash: "missing", missing: false, reason: `抓取失败：${err instanceof Error? err.message: String(err)}`.slice(0, 120)};
}
if (!res.ok) {
return { ok: false, text: null, hash: "missing", missing: res.status === 404, reason: `HTTP ${res.status}`};
}
const buf = Buffer.from(await res.arrayBuffer());
const hash = shortHash(buf);
const contentType = (res.headers.get("Content-Type")?? "").toLowerCase();
const isText =!contentType || contentType.includes("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("javascript");
if (!isText) return { ok: true, text: null, hash, missing: false, reason: null};
try {
const text = new TextDecoder("utf-8", { fatal: true}).decode(buf);
return { ok: true, text, hash, missing: false, reason: null};
} catch {
return { ok: true, text: null, hash, missing: false, reason: null};
}
}

function defaultReadFile(path: string): WatchContent {
let data: Buffer;
try {
if (!existsSync(path)) return { ok: false, text: null, hash: "missing", missing: true, reason: "文件不存在"};
if (!statSync(path).isFile()) return { ok: false, text: null, hash: "missing", missing: false, reason: "不是普通文件"};
data = readFileSync(path);
} catch (err: unknown) {
return { ok: false, text: null, hash: "missing", missing: false, reason: `读取失败：${err instanceof Error? err.message: String(err)}`.slice(0, 120)};
}
const hash = shortHash(data);
if (data.includes(0)) return { ok: true, text: null, hash, missing: false, reason: null};
return { ok: true, text: data.toString("utf-8"), hash, missing: false, reason: null};
}

export function loadSnapshot(home: string, id: string): string | null {
const path = watchSnapshotPath(home, id);
if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
try {
return readFileSync(path, "utf-8");
} catch { return null;}
}

export function saveSnapshot(home: string, id: string, text: string | null): void {
const path = watchSnapshotPath(home, id);
if (text === null) {
try { rmSync(path, { force: true});} catch { /* ignore */}
return;
}
mkdirSync(dirname(path), { recursive: true});
writeFileSync(path, text.slice(0, MAX_SNAPSHOT_CHARS), { encoding: "utf-8", mode: 0o600});
}

export interface DiffSummary {
added: number;
removed: number;
addedLines: string[];
removedLines: string[];
/** 非文本或超长时写明为什么没做行级对比。 */
note: string | null;
}

/** 行级 diff 摘要（多集差分）：新增/删除行数 + 各最多 8 行摘录。 */
export function summarizeDiff(oldText: string | null, newText: string | null): DiffSummary {
if (oldText === null || newText === null) {
return { added: 0, removed: 0, addedLines: [], removedLines: [], note: "内容非文本，只比哈希、不做行级对比"};
}
if (oldText.length > MAX_SNAPSHOT_CHARS || newText.length > MAX_SNAPSHOT_CHARS) {
return { added: 0, removed: 0, addedLines: [], removedLines: [], note: "内容超 64KB，只比哈希、不做行级对比"};
}
const count = (lines: string[]): Map<string, number> => {
const m = new Map<string, number>();
for (const l of lines) m.set(l, (m.get(l)?? 0) + 1);
return m;
};
const oldLines = oldText.split("\n");
const newLines = newText.split("\n");
const oldCount = count(oldLines);
const newCount = count(newLines);
const addedLines: string[] = [];
const removedLines: string[] = [];
let added = 0;
let removed = 0;
for (const [line, n] of newCount) {
const d = n - (oldCount.get(line)?? 0);
if (d > 0) {
added += d;
for (let i = 0; i < d && addedLines.length < MAX_DIFF_LINES; i++) addedLines.push(line.slice(0, 120));
}
}
for (const [line, n] of oldCount) {
const d = n - (newCount.get(line)?? 0);
if (d > 0) {
removed += d;
for (let i = 0; i < d && removedLines.length < MAX_DIFF_LINES; i++) removedLines.push(line.slice(0, 120));
}
}
return { added, removed, addedLines, removedLines, note: null};
}

/**
* 汇报固定格式：变了什么 → 详情 → 来源（定义要求的格式，一字不改结构）。
* 报告只含变化摘要与来源，不含目标全文（全文在快照文件里，不进收件箱）。
*/
export function formatWatchReport(watch: Watch, diff: DiffSummary, fromHash: string, toHash: string, at: string): string {
const kindLabel = watch.kind === "url"? "页面": "文件";
const lines = [
`${watch.label}（${kindLabel}：${watch.target}）`,
`变了什么：新增 ${diff.added} 行、删除 ${diff.removed} 行（${fromHash} → ${toHash}）`,
"详情：",
];
if (diff.note) {
lines.push(diff.note);
} else if (diff.added === 0 && diff.removed === 0) {
lines.push("行级无差异（可能只是空白或不可见字符变了），哈希已变。");
} else {
for (const l of diff.addedLines) lines.push(`+ ${l}`);
if (diff.added > diff.addedLines.length) lines.push(`+ ……（还新增 ${diff.added - diff.addedLines.length} 行）`);
for (const l of diff.removedLines) lines.push(`- ${l}`);
if (diff.removed > diff.removedLines.length) lines.push(`- ……（还删除 ${diff.removed - diff.removedLines.length} 行）`);
}
lines.push(`来源：${watch.target}，${at}，内容哈希 ${toHash}`);
return lines.join("\n");
}

export type WatchCheckStatus = "baseline" | "unchanged" | "changed" | "missing" | "error" | "skipped";

export interface WatchCheckResult {
  watchId: string;
  status: WatchCheckStatus;
  detail: string;
  /** 变化触发的动作（report 为 null；enqueue-task 为入队的 run_id；download 为 pending）。 */
  actionTaken: string | null;
  runId: string | null;
}

/** 条件是否命中（any 恒真；contains 只看新内容含不含子串，非文本不命中）。 */
export function conditionMatches(condition: WatchCondition, newText: string | null): boolean {
  if (condition.kind === "any") return true;
  if (newText === null) return false;
  return newText.includes(condition.arg);
}

/**
 * 单个监测的一次检查（调用方负责事后 saveWatchStore）。
 * 只读：抓 URL / 读文件，不调模型、不写监测目标以外的文件、不对外发。
 */
export async function checkWatch(
  home: string,
  watch: Watch,
  providers: WatchProviders = {},
): Promise<WatchCheckResult> {
  const now = providers.now ?? new Date();
  const at = now.toISOString();
  const fetchText = providers.fetchText ?? defaultFetchText;
  const readFile = providers.readFile ?? defaultReadFile;
  let content: WatchContent;
  try {
    content = watch.kind === "url"
      ? await fetchText(watch.target)
      : readFile(resolve(process.cwd(), watch.target));
  } catch (err: unknown) {
    content = { ok: false, text: null, hash: "missing", missing: false, reason: `读取失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 120) };
  }
  watch.lastCheckAt = at;

  // 目标取不到：缺东西要明确说出来，不是静默失败。第一次就缺失时记基线
  // missing 并报一次；之后持续缺失只记审计、不重复刷收件箱。
  if (!content.ok) {
    const wasMissing = watch.lastStatus === "missing";
    watch.lastHash = "missing";
    watch.lastStatus = "missing";
    const reason = content.reason ?? (content.missing ? "目标不存在" : "目标取不到");
    appendWatchAudit(home, "watch_missing", { watch_id: watch.id, label: watch.label, kind: watch.kind, reason });
    if (!wasMissing) {
      try {
        appendInbox(`watch-${watch.id}`, "watch_missing", `监测「${watch.label}」的目标取不到了：${watch.target}（${reason}）。目标恢复后会再报变化。`, home);
      } catch { /* 收件箱写不上不破坏检查 */ }
      return { watchId: watch.id, status: "missing", detail: `目标取不到（${reason}），已报缺失`, actionTaken: null, runId: null };
    }
    return { watchId: watch.id, status: "missing", detail: `目标仍取不到（${reason}），只记审计、不重复报`, actionTaken: null, runId: null };
  }

  // 第一次见到：只记基线，不汇报。
  if (watch.lastHash === null) {
    watch.lastHash = content.hash;
    watch.lastStatus = "ok";
    saveSnapshot(home, watch.id, content.text);
    return { watchId: watch.id, status: "baseline", detail: "第一次检查，只记基线、不汇报", actionTaken: null, runId: null };
  }

  // 目标恢复了（上次是 missing）：按变化处理，基线是缺失、现在有了内容。
  if (watch.lastHash === "missing") {
    const fromHash = "missing";
    watch.lastHash = content.hash;
    watch.lastStatus = "changed";
    saveSnapshot(home, watch.id, content.text);
    const diff: DiffSummary = { added: 0, removed: 0, addedLines: [], removedLines: [], note: "目标恢复了（上次取不到），这是恢复后的首次内容。" };
    const report = formatWatchReport(watch, diff, fromHash, content.hash, at);
    appendWatchAudit(home, "watch_changed", { watch_id: watch.id, label: watch.label, kind: watch.kind, from_hash: fromHash, to_hash: content.hash, added_lines: 0, removed_lines: 0 });
    try {
      appendInbox(`watch-${watch.id}`, "watch_changed", report, home);
    } catch { /* 收件箱写不上不破坏检查 */ }
    return { watchId: watch.id, status: "changed", detail: "目标恢复了，已汇报", actionTaken: null, runId: null };
  }

  if (content.hash === watch.lastHash) {
    watch.lastStatus = "ok";
    return { watchId: watch.id, status: "unchanged", detail: "没变", actionTaken: null, runId: null };
  }

  // 变了：diff 摘要 + 固定格式汇报 + 审计，再看条件与动作。
  const fromHash = watch.lastHash;
  const oldText = loadSnapshot(home, watch.id);
  const diff = summarizeDiff(oldText, content.text);
  watch.lastHash = content.hash;
  watch.lastStatus = "changed";
  saveSnapshot(home, watch.id, content.text);
  const report = formatWatchReport(watch, diff, fromHash, content.hash, at);
  appendWatchAudit(home, "watch_changed", { watch_id: watch.id, label: watch.label, kind: watch.kind, from_hash: fromHash, to_hash: content.hash, added_lines: diff.added, removed_lines: diff.removed });
  try {
    appendInbox(`watch-${watch.id}`, "watch_changed", report, home);
  } catch { /* 收件箱写不上不破坏检查 */ }

  if (!conditionMatches(watch.condition, content.text)) {
    return { watchId: watch.id, status: "changed", detail: `变了（新增 ${diff.added} 行、删除 ${diff.removed} 行），条件未命中、动作不触发`, actionTaken: null, runId: null };
  }
  const conditionText = watch.condition.kind === "any" ? "any（任何变化）" : `contains:${watch.condition.arg}`;
  if (watch.action.kind === "report") {
    return { watchId: watch.id, status: "changed", detail: `变了（新增 ${diff.added} 行、删除 ${diff.removed} 行），条件命中、动作为汇报（已写收件箱）`, actionTaken: null, runId: null };
  }
  if (watch.action.kind === "enqueue-task") {
    let runId: string | null = null;
    let detail: string;
    try {
      const state = addTask(`${watch.action.arg}\n\n（Watch「${watch.label}」触发：${watch.target} 变了，${fromHash} → ${content.hash}，新增 ${diff.added} 行、删除 ${diff.removed} 行。）`, { workdir: process.cwd(), mode: "auto", home });
      runId = state.run_id;
      appendWatchAudit(home, "watch_action_triggered", { watch_id: watch.id, label: watch.label, action: "enqueue-task", condition: conditionText, run_id: runId });
      appendWatchAudit(home, "watch_action_done", { watch_id: watch.id, label: watch.label, action: "enqueue-task", ok: true, detail: `已入队任务 ${runId}` });
      mirrorEvent(home, runId, "watch_action_triggered", { watch_id: watch.id, label: watch.label, action: "enqueue-task", condition: conditionText });
      mirrorEvent(home, runId, "watch_action_done", { watch_id: watch.id, label: watch.label, action: "enqueue-task", ok: true, detail: `已入队任务 ${runId}` });
      mirrorEvent(home, runId, "watch_changed", { watch_id: watch.id, label: watch.label, kind: watch.kind, from_hash: fromHash, to_hash: content.hash, added_lines: diff.added, removed_lines: diff.removed });
      detail = `变了，条件命中，已入队任务 ${runId}（执行时照常走审批）`;
    } catch (err: unknown) {
      appendWatchAudit(home, "watch_action_done", { watch_id: watch.id, label: watch.label, action: "enqueue-task", ok: false, detail: `入队失败：${err instanceof Error ? err.message : String(err)}` });
      detail = `变了，条件命中，但入队失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return { watchId: watch.id, status: "changed", detail, actionTaken: runId ? `enqueue-task:${runId}` : "enqueue-task:failed", runId };
  }
  // download 是敏感写操作：触发时只记一条待批准动作，不下载；人显式
  // `nyra watch run-action <id> --yes` 才真的下载。
  watch.pendingAction = { action: watch.action, at, fromHash, toHash: content.hash };
  appendWatchAudit(home, "watch_action_triggered", { watch_id: watch.id, label: watch.label, action: "download", condition: conditionText });
  appendWatchAudit(home, "watch_action_pending", { watch_id: watch.id, label: watch.label, action: "download", reason: "下载是写操作，须人显式批准才执行" });
  try {
    appendInbox(`watch-${watch.id}`, "watch_action_pending", `监测「${watch.label}」变了，触发了下载动作（${watch.target} → ${watch.action.arg}），须你批准才下载：nyra watch run-action ${watch.id} --yes`, home);
  } catch { /* 收件箱写不上不破坏检查 */ }
  return { watchId: watch.id, status: "changed", detail: `变了，条件命中，下载动作已记待批准（须 nyra watch run-action ${watch.id} --yes）`, actionTaken: "download:pending", runId: null };
}

export interface WatchScanReport {
  checked: number;
  baselined: string[];
  changed: string[];
  missing: string[];
  actions: string[];
  skipped: string | null;
}

function emptyReport(): WatchScanReport {
  return { checked: 0, baselined: [], changed: [], missing: [], actions: [], skipped: null };
}

/**
 * 扫一遍到期的监测（启用中、且距上次检查超过 intervalSeconds）。
 * 单个监测出错不破坏整轮（记 error、继续扫下一个）。
 */
export async function checkWatches(
  home: string,
  opts?: { providers?: WatchProviders; onlyId?: string },
): Promise<WatchScanReport> {
  const store = loadWatchStore(home);
  const report = emptyReport();
  const now = opts?.providers?.now ?? new Date();
  for (const watch of store.watches) {
    if (opts?.onlyId && watch.id !== opts.onlyId) continue;
    if (!opts?.onlyId && !watch.enabled) continue;
    if (!opts?.onlyId && watch.lastCheckAt) {
      const last = Date.parse(watch.lastCheckAt);
      if (Number.isFinite(last) && now.getTime() - last < watch.intervalSeconds * 1000) continue;
    }
    report.checked += 1;
    try {
      const r = await checkWatch(home, watch, opts?.providers ?? {});
      if (r.status === "baseline") report.baselined.push(watch.id);
      else if (r.status === "changed") report.changed.push(watch.id);
      else if (r.status === "missing") report.missing.push(watch.id);
      if (r.actionTaken) report.actions.push(`${watch.id}:${r.actionTaken}`);
    } catch (err: unknown) {
      appendWatchAudit(home, "watch_missing", { watch_id: watch.id, label: watch.label, kind: watch.kind, reason: `检查失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 120) });
    }
  }
  saveWatchStore(home, store);
  return report;
}

/** 守护进程每轮调：全局开关未开时跳过（只记 skipped，不扫）。 */
export async function runDueWatches(
  home: string,
  opts?: { force?: boolean; providers?: WatchProviders },
): Promise<WatchScanReport> {
  const settings = resolveWatchSettings(loadConfig(home));
  if (!settings.enabled && !opts?.force) {
    return { ...emptyReport(), skipped: "变化监测未启用（nyra watch config --auto on 开启自动巡查）" };
  }
  return checkWatches(home, { providers: opts?.providers });
}

/**
 * download 目的地解析：相对路径按当前目录算；realpath 只用于越界比较，
 * 不改写返回值（缺口 25 修补第二轮的教训）。
 */
export function resolveDownloadDest(cwd: string, dest: string): string {
  validateDownloadDest(dest);
  const joined = resolve(cwd, dest);
  const base = resolve(cwd);
  if (joined !== base && !joined.startsWith(base + sep)) {
    throw new WatchError("download 目的地逃出了当前目录");
  }
  try {
    const realBase = realpathSync(base);
    const parent = dirname(joined);
    if (existsSync(parent)) {
      const realParent = realpathSync(parent);
      if (realParent !== realBase && !realParent.startsWith(realBase + sep)) {
        throw new WatchError("download 目的地经软链逃出了当前目录");
      }
    }
  } catch (err: unknown) {
    if (err instanceof WatchError) throw err;
    /* realpath 失败时按词法比较的结果走，不拦 */
  }
  return joined;
}

/**
 * 执行一条待批准的下载动作（人显式 --yes 才执行；重新抓当前内容下载，
 * 不用触发时的快照——目标可能又变了，下载以执行时为准）。
 */
export async function runPendingAction(
  home: string,
  id: string,
  opts?: { yes?: boolean; providers?: WatchProviders; cwd?: string },
): Promise<{ dest: string; hash: string }> {
  const store = loadWatchStore(home);
  const watch = store.watches.find((w) => w.id === id);
  if (!watch) throw new WatchError(`没有这个监测：${id}`);
  if (!watch.pendingAction) throw new WatchError(`监测 ${id} 没有待批准的下载动作`);
  if (!opts?.yes) throw new WatchError("下载是写操作，须显式批准：加 --yes 才执行");
  if (watch.kind !== "url") throw new WatchError("download 动作只对 url 监测有效");
  const pending = watch.pendingAction;
  if (pending.action.kind !== "download") throw new WatchError(`待批准的动作不是 download：${pending.action.kind}`);
  const fetchText = opts?.providers?.fetchText ?? defaultFetchText;
  const content = await fetchText(watch.target);
  if (!content.ok) throw new WatchError(`下载时目标又取不到了：${content.reason ?? "未知原因"}，动作仍挂着、等目标恢复再执行`);
  const cwd = opts?.cwd ?? process.cwd();
  const dest = resolveDownloadDest(cwd, pending.action.arg);
  mkdirSync(dirname(dest), { recursive: true });
  if (content.text !== null) {
    writeFileSync(dest, content.text, { encoding: "utf-8" });
  } else {
    // 非文本内容：重新抓原始字节写盘（fetchText 只给了哈希，须再抓一次）。
    const res = await fetch(watch.target, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new WatchError(`下载时目标又取不到了：HTTP ${res.status}，动作仍挂着`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  watch.pendingAction = null;
  saveWatchStore(home, store);
  appendWatchAudit(home, "watch_action_done", { watch_id: watch.id, label: watch.label, action: "download", ok: true, detail: `已下载到 ${pending.action.arg}` });
  return { dest, hash: content.hash };
}

const USAGE =
  "用法：nyra watch <add|list|show|remove|check|enable|disable|config|run-action> [选项]\n" +
  "  add --id <id> --label <名字> (--url <地址> | --file <路径>) [--every-seconds N（60–86400，默认 3600）] [--condition any|contains:<子串>] [--action report|enqueue-task:<任务>|download:<相对路径>] [--disabled]\n" +
  "  list [--json]   列出全部监测（id、目标、上次检查、上次状态、待批准动作）\n" +
  "  show <id> [--json]   看一个监测的详情\n" +
  "  remove <id> --yes   删一个监测（连快照一起删）\n" +
  "  check [id]   立刻检查到期的监测（不指定 id 扫全部到期的；人当场点的动作，不受全局开关限制）\n" +
  "  enable <id> / disable <id>   开 / 关单个监测\n" +
  "  config [--auto on|off] [--default-interval-seconds N（60–86400，默认 3600）]   全局自动巡查开关与默认间隔\n" +
  "  run-action <id> --yes   执行一条待批准的下载动作（重新抓当前内容下载）\n";

function writeWatchSettings(home: string, patch: { enabled?: boolean; defaultIntervalSeconds?: number }): WatchSettings {
  const current = resolveWatchSettings(loadConfig(home));
  const next: WatchSettings = { ...current, ...patch };
  saveConfig(home, {
    watch: {
      enabled: next.enabled,
      default_interval_seconds: next.defaultIntervalSeconds,
    },
  });
  return next;
}

export async function handleWatch(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const getInt = (flag: string): number | undefined => {
    const v = get(flag);
    if (v === undefined) return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  try {
    if (action === "add") {
      const id = get("--id") ?? "";
      const label = get("--label") ?? "";
      const url = get("--url");
      const file = get("--file");
      if (!id || !label || (!url && !file) || (url && file)) {
        process.stderr.write("错误：用法：nyra watch add --id <id> --label <名字> (--url <地址> | --file <路径>)\n");
        return 2;
      }
      const every = getInt("--every-seconds");
      if (every !== undefined && (every < 60 || every > 86400)) {
        process.stderr.write("错误：--every-seconds 必须是 60 到 86400 的整数\n");
        return 2;
      }
      const condition = parseCondition(get("--condition") ?? "any");
      const act = parseAction(get("--action") ?? "report");
      const watch = addWatch(resolvedHome, {
        id, label,
        kind: url ? "url" : "file",
        target: url ?? file,
        intervalSeconds: every,
        enabled: !argv.includes("--disabled"),
        condition, action: act,
      });
      process.stdout.write(`监测已加：${watch.id}（${watch.kind}：${watch.target}，每 ${watch.intervalSeconds} 秒检查一次，条件 ${condition.kind === "any" ? "any" : "contains:" + condition.arg}，动作 ${act.kind}${act.arg ? ":" + act.arg.slice(0, 40) : ""}）。第一次检查只记基线、不汇报。\n`);
      return 0;
    }
    if (action === "list") {
      const watches = listWatches(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(watches, null, 2) + "\n");
        return 0;
      }
      if (!watches.length) {
        process.stdout.write("还没有监测（nyra watch add 先加一个）。\n");
        return 0;
      }
      for (const w of watches) {
        const pending = w.pendingAction ? `，待批准下载：${w.pendingAction.action.arg}` : "";
        process.stdout.write(`${w.id}  ${w.enabled ? "开" : "关"}  ${w.kind}:${w.target}  每 ${w.intervalSeconds} 秒  上次：${w.lastCheckAt ?? "未检查过"}（${w.lastStatus ?? "—"}）${pending}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra watch show <id>\n");
        return 2;
      }
      const watch = getWatch(resolvedHome, id);
      if (!watch) {
        process.stderr.write(`错误：没有这个监测：${id}\n`);
        return 2;
      }
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(watch, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(
        `监测 ${watch.id}（${watch.label}）：${watch.kind} ${watch.target}\n` +
        `  状态：${watch.enabled ? "开" : "关"}，每 ${watch.intervalSeconds} 秒检查一次；上次检查 ${watch.lastCheckAt ?? "未检查过"}，状态 ${watch.lastStatus ?? "—"}，内容哈希 ${watch.lastHash ?? "—"}。\n` +
        `  条件：${watch.condition.kind === "any" ? "any（任何变化都触发）" : "contains:" + watch.condition.arg}；动作：${watch.action.kind}${watch.action.arg ? "（" + watch.action.arg.slice(0, 80) + "）" : "（只汇报）"}。\n` +
        `  待批准动作：${watch.pendingAction ? `download ${watch.pendingAction.action.arg}（${watch.pendingAction.at} 触发，nyra watch run-action ${watch.id} --yes 执行）` : "无"}。\n`,
      );
      return 0;
    }
    if (action === "remove") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra watch remove <id> --yes\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        process.stderr.write("错误：删监测须显式确认：加 --yes\n");
        return 2;
      }
      if (!removeWatch(resolvedHome, id)) {
        process.stderr.write(`错误：没有这个监测：${id}\n`);
        return 2;
      }
      process.stdout.write(`监测 ${id} 已删（快照一起删了）。\n`);
      return 0;
    }
    if (action === "check") {
      const id = argv[1];
      if (id) {
        const watch = getWatch(resolvedHome, id);
        if (!watch) {
          process.stderr.write(`错误：没有这个监测：${id}\n`);
          return 2;
        }
        const store = loadWatchStore(resolvedHome);
        const row = store.watches.find((w) => w.id === id)!;
        const r = await checkWatch(resolvedHome, row, {});
        saveWatchStore(resolvedHome, store);
        process.stdout.write(`监测 ${id}：${r.detail}\n`);
        return 0;
      }
      const report = await checkWatches(resolvedHome, {});
      const parts = [`检查了 ${report.checked} 个到期的监测`];
      if (report.baselined.length) parts.push(`记基线 ${report.baselined.length} 个`);
      if (report.changed.length) parts.push(`变了 ${report.changed.length} 个（${report.changed.join("、")}）`);
      if (report.missing.length) parts.push(`目标取不到 ${report.missing.length} 个（${report.missing.join("、")}）`);
      if (report.actions.length) parts.push(`触发动作 ${report.actions.length} 个`);
      process.stdout.write(parts.join("；") + "。\n");
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write(`错误：用法：nyra watch ${action} <id>\n`);
        return 2;
      }
      const watch = setWatchEnabled(resolvedHome, id, action === "enable");
      process.stdout.write(`监测 ${id} 已${watch.enabled ? "开启" : "关闭"}${watch.enabled ? "" : "（关闭后守护进程不再检查它，手动 check <id> 照常能用）"}。\n`);
      return 0;
    }
    if (action === "config") {
      const auto = get("--auto");
      const interval = getInt("--default-interval-seconds");
      if (auto === undefined && interval === undefined) {
        const settings = resolveWatchSettings(loadConfig(resolvedHome));
        process.stdout.write(`变化监测自动巡查：${settings.enabled ? "已开启" : "未开启"}；默认每 ${settings.defaultIntervalSeconds} 秒检查一次（单个监测的 --every-seconds 优先）。\n`);
        return 0;
      }
      if (auto !== undefined && auto !== "on" && auto !== "off") {
        process.stderr.write("错误：--auto 只认 on 或 off\n");
        return 2;
      }
      if (interval !== undefined && (interval < 60 || interval > 86400)) {
        process.stderr.write("错误：--default-interval-seconds 必须是 60 到 86400 的整数\n");
        return 2;
      }
      const patch: { enabled?: boolean; defaultIntervalSeconds?: number } = {};
      if (auto !== undefined) patch.enabled = auto === "on";
      if (interval !== undefined) patch.defaultIntervalSeconds = interval;
      const next = writeWatchSettings(resolvedHome, patch);
      process.stdout.write(`变化监测配置已更新：自动巡查${next.enabled ? "已开启" : "未开启"}，默认每 ${next.defaultIntervalSeconds} 秒检查一次。\n`);
      return 0;
    }
    if (action === "run-action") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra watch run-action <id> --yes\n");
        return 2;
      }
      const { dest, hash } = await runPendingAction(resolvedHome, id, { yes: argv.includes("--yes") });
      process.stdout.write(`已下载到 ${dest}（内容哈希 ${hash}）。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 watch ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
