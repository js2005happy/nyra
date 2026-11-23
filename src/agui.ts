// src/agui.ts — 缺口 47 第一批：协议中立接入层——AG-UI 客户端兼容
// （扩展缺口 38 + 17 + 12；Bot 方向报告 §6）。
//
// 做兼容者，不另起协议：Nyra 实现 AG-UI 客户端，能接任意 AG-UI
// endpoint（用对方的模型、工具与运行时），Nyra 提供 workspace、
// 治理、记忆与体验。A2A 与 AG-UI 的分工沿用 CopilotKit 的划分：
// MCP 管工具、A2A 管 agent 间通信、AG-UI 管 agent—人交互。
//
// 安全口径（照报告原文的三条）：
// - “协议中立”不等于“信任中立”：对方 agent 发来的任何内容都按不
//   可信输入处理——先过缺口 10 的确定性注入扫描（untrusted.ts 的
//   isSuspiciousSegment，与审查层同一套规则形状），可疑内容直接拦
//   截进证据链，不执行、不进模型上下文；
// - 接入先做读，再做写：外部 agent 先以只读 Bot 接入（能看任务产
//   物、不能写），写操作须对方主人显式接受（accept-write，须 --yes，
//   接受记录进证据链），接受前写操作一律拒绝；
// - 准入复用缺口 34 的 isAdmitted：连接的 endpoint 须绑定一个已批
//   准好友且在信任圈里（名片是协议中立的发现层，缺口 38），圈外直
//   接拒绝，connect 时验。
//
// 本批只做 AG-UI 客户端兼容（登记 / 握手 / 只读接入 / 事件流 / 写
// 操作显式接受门 / A2A 复用缺口 38 + 12）。不做：Nyra 的 Bot 对外
// 暴露为 AG-UI/A2A endpoint（第二批）；缺口 17 的补齐。
//
// 缺口 17 核实结论（本批动手前在代码里核实，见 docs/agui.md）：
// MCP 客户端 stdio + Streamable HTTP（MCPHttpClient）已落地；对外
// MCP 服务（NyraMcpServer + 网关 POST /mcp，nyra mcp server 开关，
// 默认关闭、默认只读、写操作过独立审查层）也已落地——报告里写的
// “待做”是报告成文时的状态，代码已先于本批落地。所以缺口 47 的
// 先决条件 38 与 17 在本批动手时均已满足，本批不补缺口 17。
//
// 诚实边界：只在假 endpoint（本机 HTTP）上验过；真 AG-UI 服务未
// 接通过；发现握手是 Nyra 的一小段 JSON 交换（见 handshakeAgui），
// 事件流本身走 AG-UI 的事件名；媒体面未加密，别当端到端加密用。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { isSuspiciousSegment, suspiciousLabels, wrapUntrusted } from "./untrusted.ts";
import { loadConfig } from "./config.ts";
import { findFriend, loadFriendBook } from "./peerCard.ts";
import { askPeer, resolvePeer } from "./peer.ts";
import { OWNER_IDENTITY } from "./circles.ts";

export const AGUI_FILE = "agui-endpoints.json";
export const AGUI_PROTOCOL = "ag-ui";
export const AGUI_CLIENT_VERSION = "1";
export const AGUI_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const AGUI_MAX_URL_CHARS = 500;
export const AGUI_MAX_MESSAGE_CHARS = 4000;
export const AGUI_MAX_TOOL_ARGS_CHARS = 4000;
export const AGUI_FETCH_TIMEOUT_MS = 20000;

/** AG-UI 事件名（CopilotKit AG-UI 协议的事件面；未知类型记 unknown，不致命）。 */
export const AGUI_EVENT_TYPES: readonly string[] = [
  "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR",
  "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
  "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END",
  "STATE_SNAPSHOT", "STATE_DELTA", "STEP_STARTED", "STEP_FINISHED",
];

export class AguiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AguiError";
  }
}

export type AguiEndpointStatus = "registered" | "connected" | "disconnected";

export interface AguiCapabilities {
  events: string[];
  tools: string[];
}

export interface AguiEndpoint {
  name: string;
  url: string;
  protocol_version: string;
  status: AguiEndpointStatus;
  capabilities: AguiCapabilities;
  /** 本批恒为 readonly：只读 Bot 接入，写操作另走显式接受门。 */
  mode: "readonly";
  /** 显式接受写操作的人（机主身份），未接受时为 null。 */
  write_accepted_by: string | null;
  write_accepted_at: string | null;
  /** 绑定的名片好友名（缺口 38 的发现层）；未绑定时为 null，connect 会拒绝。 */
  peer_name: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  last_run_id: string | null;
}

export interface AguiBook {
  version: 1;
  endpoints: AguiEndpoint[];
}

export interface AguiRunResult {
  endpoint: string;
  run_id: string;
  status: "finished" | "blocked" | "error";
  /** 对方发来的文本（已过 wrapUntrusted，不可信输入的框还在上面）。 */
  text: string;
  text_chars: number;
  events_seen: number;
  tool_calls: { name: string; args: string }[];
  error: string;
}

export interface AguiFetchDeps {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

function aguiPath(home: string): string {
  return join(resolveNyraHome(home), AGUI_FILE);
}

function ensureHomeDir(home: string): string {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  return dir;
}

function writeJsonAtomic(home: string, filename: string, data: string): void {
  const dir = ensureHomeDir(home);
  const path = join(dir, filename);
  const tmp = join(dir, `.${filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  return `agui-${randomBytes(4).toString("hex")}`;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(bad-url)";
  }
}

/** 读 endpoint 账本：没有返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadAguiBook(home: string): AguiBook {
  const path = aguiPath(home);
  if (!existsSync(path)) return { version: 1, endpoints: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new AguiError(`${AGUI_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.endpoints)) {
    throw new AguiError(`${AGUI_FILE} 结构不对（须含 endpoints 列表）`);
  }
  return { version: 1, endpoints: parsed.endpoints as AguiEndpoint[] };
}

export function saveAguiBook(home: string, book: AguiBook): void {
  writeJsonAtomic(home, AGUI_FILE, JSON.stringify(book, null, 2) + "\n");
}

export function findEndpoint(book: AguiBook, name: string): AguiEndpoint | null {
  return book.endpoints.find((e) => e.name === name) ?? null;
}

export function listEndpoints(home: string): AguiEndpoint[] {
  return loadAguiBook(home).endpoints;
}

/** AG-UI 操作单独建一条只记 agui_* 事件的运行（与联合会话同款做法）。 */
function recordAguiEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`协议中立接入：${type}`, "agui", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 登记与发现（名片是协议中立的发现层，缺口 38）
// ---------------------------------------------------------------------------

function checkName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new AguiError("endpoint 名字不能为空");
  if (!AGUI_NAME_RE.test(clean)) throw new AguiError("endpoint 名字只认小写字母、数字、- 与 _，且须以字母或数字开头（最多 64 字）");
  return clean;
}

function checkUrl(url: string): string {
  const clean = url.trim();
  if (!clean) throw new AguiError("endpoint 地址不能为空");
  if (clean.length > AGUI_MAX_URL_CHARS) throw new AguiError(`endpoint 地址最多 ${AGUI_MAX_URL_CHARS} 字`);
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new AguiError("endpoint 地址必须是 http:// 或 https:// 开头的地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AguiError("endpoint 地址只接受 http:// 或 https://");
  }
  return clean;
}

/** 名片好友须存在（不验准入，准入在 connect 时验）。 */
function checkPeerExists(home: string, peerName: string): void {
  const book = loadFriendBook(home);
  const entry = findFriend(book, peerName);
  if (!entry) throw new AguiError(`好友账本里没有 ${peerName}：先跑 nyra peer add 加好友`);
}

/** 登记一个外部 AG-UI endpoint（只登记，不连接、不调对方）。 */
export function registerEndpoint(home: string, name: string, url: string, peerName?: string | null): AguiEndpoint {
  const cleanName = checkName(name);
  const cleanUrl = checkUrl(url);
  const peer = peerName?.trim() ? peerName.trim() : null;
  if (peer) checkPeerExists(home, peer);
  const book = loadAguiBook(home);
  if (findEndpoint(book, cleanName)) throw new AguiError(`endpoint ${cleanName} 已登记（先跑 nyra agui show ${cleanName} 看它）`);
  const now = nowIso();
  const endpoint: AguiEndpoint = {
    name: cleanName,
    url: cleanUrl,
    protocol_version: "",
    status: "registered",
    capabilities: { events: [], tools: [] },
    mode: "readonly",
    write_accepted_by: null,
    write_accepted_at: null,
    peer_name: peer,
    created_at: now,
    updated_at: now,
    last_seen_at: null,
    last_run_id: null,
  };
  book.endpoints.push(endpoint);
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_registered", { endpoint: cleanName, url_host: urlHost(cleanUrl) });
  return endpoint;
}

/** 给已登记的 endpoint 绑定名片好友（发现层）；换绑直接覆盖。 */
export function linkEndpoint(home: string, name: string, peerName: string): AguiEndpoint {
  const cleanName = checkName(name);
  const peer = peerName.trim();
  if (!peer) throw new AguiError("好友名不能为空");
  checkPeerExists(home, peer);
  const book = loadAguiBook(home);
  const endpoint = findEndpoint(book, cleanName);
  if (!endpoint) throw new AguiError(`没有登记过 endpoint ${cleanName}：先跑 nyra agui register ${cleanName} <地址>`);
  endpoint.peer_name = peer;
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  return endpoint;
}

// ---------------------------------------------------------------------------
// 握手与连接（准入闸 + 发现握手）
// ---------------------------------------------------------------------------

export interface AguiHandshake {
  protocol_version: string;
  capabilities: AguiCapabilities;
}

function parseHandshake(body: string): AguiHandshake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AguiError("握手失败：对方没有返回合法的 JSON（不是 AG-UI endpoint，或地址不对）");
  }
  if (!isPlainObject(parsed) || parsed.ok !== true || parsed.protocol !== AGUI_PROTOCOL) {
    throw new AguiError("握手失败：对方没有认领 AG-UI 协议（须返回 ok 为 true、protocol 为 ag-ui）");
  }
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new AguiError("握手失败：对方没有报协议版本");
  }
  const caps = isPlainObject(parsed.capabilities) ? parsed.capabilities : {};
  const events = Array.isArray(caps.events) ? caps.events.filter((e): e is string => typeof e === "string").slice(0, 64) : [];
  const tools = Array.isArray(caps.tools) ? caps.tools.filter((t): t is string => typeof t === "string").slice(0, 64) : [];
  return { protocol_version: parsed.version.trim(), capabilities: { events, tools } };
}

/**
 * 发现握手：Nyra 的一小段 JSON 交换（不是 AG-UI 事件流本身）。
 * 发 POST { type: "handshake", protocol: "ag-ui", client: "nyra",
 * version }，对方回 { ok, protocol: "ag-ui", version, capabilities }。
 * 事件流本身走 AG-UI 的事件名（见 parseAguiSse）。对方不认握手时
 * connect 直接失败，不静默当成已连接。
 */
export async function handshakeAgui(endpoint: AguiEndpoint, deps?: AguiFetchDeps): Promise<AguiHandshake> {
  const fetchFn = deps?.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "handshake", protocol: AGUI_PROTOCOL, client: "nyra", version: AGUI_CLIENT_VERSION }),
      signal: AbortSignal.timeout(AGUI_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AguiError(`握手失败：连不上 ${urlHost(endpoint.url)}（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (!res.ok) throw new AguiError(`握手失败：对方返回 HTTP ${res.status}`);
  return parseHandshake(await res.text());
}

/**
 * 连接 endpoint：先过准入闸（绑定的名片好友须已批准且在信任圈里，
 * 缺口 34 的 isAdmitted；未绑定名片直接拒绝），再握手。
 * 动态 import circles.ts：circles 经 peerCard 依赖 peer.ts，静态引
 * 入会形成循环导入（与 peer.ts 里动态引 circles 同款原因）。
 */
export async function connectEndpoint(home: string, name: string, deps?: AguiFetchDeps): Promise<AguiEndpoint> {
  const cleanName = checkName(name);
  const book = loadAguiBook(home);
  const endpoint = findEndpoint(book, cleanName);
  if (!endpoint) throw new AguiError(`没有登记过 endpoint ${cleanName}：先跑 nyra agui register ${cleanName} <地址>`);
  if (!endpoint.peer_name) {
    throw new AguiError(`endpoint ${cleanName} 没绑名片好友：先跑 nyra agui link ${cleanName} <好友名>（对方须是已批准好友且在信任圈里）`);
  }
  const { isAdmitted } = await import("./circles.ts");
  if (!isAdmitted(home, endpoint.peer_name)) {
    throw new AguiError(`对方 ${endpoint.peer_name} 不在信任圈里：先跑 nyra circle invite <圈名> ${endpoint.peer_name} 把它引进圈（对方须先是已批准、未拉黑的好友）`);
  }
  const handshake = await handshakeAgui(endpoint, deps);
  endpoint.protocol_version = handshake.protocol_version;
  endpoint.capabilities = handshake.capabilities;
  endpoint.status = "connected";
  endpoint.last_seen_at = nowIso();
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_connected", { endpoint: cleanName, protocol_version: handshake.protocol_version });
  return endpoint;
}

/** 断开 endpoint（只改本地状态，不调对方；写接受随断开一并撤销）。 */
export function disconnectEndpoint(home: string, name: string): AguiEndpoint {
  const cleanName = checkName(name);
  const book = loadAguiBook(home);
  const endpoint = findEndpoint(book, cleanName);
  if (!endpoint) throw new AguiError(`没有登记过 endpoint ${cleanName}`);
  endpoint.status = "disconnected";
  endpoint.write_accepted_by = null;
  endpoint.write_accepted_at = null;
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_disconnected", { endpoint: cleanName });
  return endpoint;
}

// ---------------------------------------------------------------------------
// 写操作显式接受门（接受前写操作一律拒绝；接受记录进证据链）
// ---------------------------------------------------------------------------

/** 机主显式接受某 endpoint 的写操作（须 CLI 加 --yes，见 aguiMain）。 */
export function acceptWrite(home: string, name: string, by?: string): AguiEndpoint {
  const cleanName = checkName(name);
  const who = by ?? OWNER_IDENTITY;
  const book = loadAguiBook(home);
  const endpoint = findEndpoint(book, cleanName);
  if (!endpoint) throw new AguiError(`没有登记过 endpoint ${cleanName}`);
  if (endpoint.status !== "connected") throw new AguiError(`endpoint ${cleanName} 没连上（先跑 nyra agui connect ${cleanName}），写接受只对已连接的 endpoint 有效`);
  endpoint.write_accepted_by = who;
  endpoint.write_accepted_at = nowIso();
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_write_accepted", { endpoint: cleanName, accepted_by: who });
  return endpoint;
}

/** 撤销写接受（不断开连接；之后写操作重新变拒绝）。 */
export function revokeWrite(home: string, name: string): AguiEndpoint {
  const cleanName = checkName(name);
  const book = loadAguiBook(home);
  const endpoint = findEndpoint(book, cleanName);
  if (!endpoint) throw new AguiError(`没有登记过 endpoint ${cleanName}`);
  endpoint.write_accepted_by = null;
  endpoint.write_accepted_at = null;
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_write_revoked", { endpoint: cleanName });
  return endpoint;
}

function requireConnected(book: AguiBook, name: string): AguiEndpoint {
  const endpoint = findEndpoint(book, name);
  if (!endpoint) throw new AguiError(`没有登记过 endpoint ${name}`);
  if (endpoint.status !== "connected") throw new AguiError(`endpoint ${name} 没连上（先跑 nyra agui connect ${name}）`);
  return endpoint;
}

// ---------------------------------------------------------------------------
// AG-UI 事件流（run）
// ---------------------------------------------------------------------------

export interface AguiSseEvent {
  type: string;
  text: string;
  tool: string;
  args: string;
}

/**
 * 解析 AG-UI 的 SSE 事件流：data: {json} 行，type 在 JSON 的 type
 * 字段里；也认 event: <类型> 行（下一次 data 行没写 type 时补上）。
 * 只认本批的事件名，未知类型照收（events_seen 照计），不致命。
 */
export function parseAguiSse(body: string): AguiSseEvent[] {
  const out: AguiSseEvent[] = [];
  let pendingType = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      pendingType = line.slice("event:".length).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const type = typeof parsed.type === "string" && parsed.type ? parsed.type : pendingType;
    pendingType = "";
    // 缺口 47 第二批：AG-UI 规范的增量字段是 delta（TEXT_MESSAGE_CONTENT
    // 与 TOOL_CALL_ARGS 都用它）；服务端按规范发 delta，客户端三者都认。
    const text = typeof parsed.text === "string" ? parsed.text
      : (typeof parsed.content === "string" ? parsed.content
      : (typeof parsed.delta === "string" ? parsed.delta : ""));
    const tool = typeof parsed.tool === "string" ? parsed.tool : (typeof parsed.toolName === "string" ? parsed.toolName : "");
    const args = typeof parsed.args === "string" ? parsed.args
      : (isPlainObject(parsed.args) ? JSON.stringify(parsed.args)
      : (typeof parsed.delta === "string" ? parsed.delta : ""));
    out.push({ type: type || "unknown", text, tool, args });
  }
  return out;
}

async function postAguiRun(endpoint: AguiEndpoint, payload: Record<string, unknown>, deps?: AguiFetchDeps): Promise<AguiSseEvent[]> {
  const fetchFn = deps?.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AGUI_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AguiError(`发给 ${endpoint.name} 失败：连不上 ${urlHost(endpoint.url)}（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (!res.ok) throw new AguiError(`发给 ${endpoint.name} 失败：对方返回 HTTP ${res.status}`);
  return parseAguiSse(await res.text());
}

/**
 * 给外部 agent 发一条消息并走 AG-UI 事件流：只读（不调对方的工具，
 * 对方回的 TOOL_CALL 只当提议记下来，不执行）。
 * 对方发来的每段文本先过确定性注入扫描（isSuspiciousSegment，与
 * 审查层同一套规则形状）：可疑就地拦截——整轮记 blocked，不把可疑
 * 文本交出去，只把拦截结论与规则名进证据链。
 */
export async function runAgui(home: string, name: string, message: string, deps?: AguiFetchDeps): Promise<AguiRunResult> {
  const cleanName = checkName(name);
  const text = message.trim();
  if (!text) throw new AguiError("消息不能为空");
  if (text.length > AGUI_MAX_MESSAGE_CHARS) throw new AguiError(`消息最多 ${AGUI_MAX_MESSAGE_CHARS} 字`);
  const book = loadAguiBook(home);
  const endpoint = requireConnected(book, cleanName);
  const runId = newRunId();
  recordAguiEvent(home, "agui_run_started", { endpoint: cleanName, run: runId });
  let events: AguiSseEvent[];
  try {
    events = await postAguiRun(endpoint, {
      type: "run",
      protocol: AGUI_PROTOCOL,
      threadId: `nyra-${cleanName}`,
      runId,
      messages: [{ role: "user", content: text }],
      state: {},
      tools: [],
    }, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordAguiEvent(home, "agui_run_finished", { endpoint: cleanName, run: runId, events: 0, text_chars: 0 });
    return { endpoint: cleanName, run_id: runId, status: "error", text: "", text_chars: 0, events_seen: 0, tool_calls: [], error: msg };
  }
  const chunks: string[] = [];
  const toolCalls: { name: string; args: string }[] = [];
  for (const ev of events) {
    if (ev.type === "TEXT_MESSAGE_CONTENT" && ev.text) {
      if (isSuspiciousSegment(ev.text)) {
        const labels = suspiciousLabels(ev.text).join("、") || "可疑指令";
        recordAguiEvent(home, "agui_content_blocked", { endpoint: cleanName, run: runId, labels });
        recordAguiEvent(home, "agui_run_finished", { endpoint: cleanName, run: runId, events: events.length, text_chars: 0 });
        return { endpoint: cleanName, run_id: runId, status: "blocked", text: "", text_chars: 0, events_seen: events.length, tool_calls: [], error: `对方发来的文本被注入扫描拦截（${labels}），整轮已停下` };
      }
      chunks.push(ev.text);
    }
    if ((ev.type === "TOOL_CALL_START" || ev.type === "TOOL_CALL_ARGS") && ev.tool) {
      toolCalls.push({ name: ev.tool, args: ev.args });
      recordAguiEvent(home, "agui_tool_proposed", { endpoint: cleanName, run: runId, tool: ev.tool });
    }
  }
  const joined = chunks.join("");
  const wrapped = wrapUntrusted(joined, `AG-UI ${cleanName}`);
  endpoint.last_run_id = runId;
  endpoint.last_seen_at = nowIso();
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_run_finished", { endpoint: cleanName, run: runId, events: events.length, text_chars: joined.length });
  return { endpoint: cleanName, run_id: runId, status: "finished", text: wrapped, text_chars: joined.length, events_seen: events.length, tool_calls: toolCalls, error: "" };
}

/**
 * 请外部 agent 执行它的一只工具（写操作）：须已连接且机主已显式接受
 * 写操作，否则直接拒绝（记 agui_write_blocked，不连对方）。
 * 对方回的文本同样过 wrapUntrusted + 注入扫描，可疑就地拦截。
 */
export async function execAguiTool(home: string, name: string, tool: string, args: string, deps?: AguiFetchDeps): Promise<AguiRunResult> {
  const cleanName = checkName(name);
  const cleanTool = tool.trim();
  if (!cleanTool) throw new AguiError("工具名不能为空");
  if (args.length > AGUI_MAX_TOOL_ARGS_CHARS) throw new AguiError(`工具参数最多 ${AGUI_MAX_TOOL_ARGS_CHARS} 字`);
  const book = loadAguiBook(home);
  const endpoint = requireConnected(book, cleanName);
  if (!endpoint.write_accepted_by) {
    recordAguiEvent(home, "agui_write_blocked", { endpoint: cleanName, tool: cleanTool, reason: "no-write-acceptance" });
    throw new AguiError(`写操作被拒：endpoint ${cleanName} 的写操作还没被机主显式接受（先跑 nyra agui accept-write ${cleanName} --yes）`);
  }
  const runId = newRunId();
  recordAguiEvent(home, "agui_run_started", { endpoint: cleanName, run: runId });
  const events = await postAguiRun(endpoint, {
    type: "run",
    protocol: AGUI_PROTOCOL,
    threadId: `nyra-${cleanName}`,
    runId,
    messages: [],
    state: {},
    tools: [{ name: cleanTool, args }],
  }, deps);
  const chunks: string[] = [];
  for (const ev of events) {
    if (ev.type === "TEXT_MESSAGE_CONTENT" && ev.text) {
      if (isSuspiciousSegment(ev.text)) {
        const labels = suspiciousLabels(ev.text).join("、") || "可疑指令";
        recordAguiEvent(home, "agui_content_blocked", { endpoint: cleanName, run: runId, labels });
        recordAguiEvent(home, "agui_run_finished", { endpoint: cleanName, run: runId, events: events.length, text_chars: 0 });
        return { endpoint: cleanName, run_id: runId, status: "blocked", text: "", text_chars: 0, events_seen: events.length, tool_calls: [], error: `对方发来的文本被注入扫描拦截（${labels}），整轮已停下` };
      }
      chunks.push(ev.text);
    }
  }
  const joined = chunks.join("");
  const wrapped = wrapUntrusted(joined, `AG-UI ${cleanName}`);
  endpoint.last_run_id = runId;
  endpoint.last_seen_at = nowIso();
  endpoint.updated_at = nowIso();
  saveAguiBook(home, book);
  recordAguiEvent(home, "agui_run_finished", { endpoint: cleanName, run: runId, events: events.length, text_chars: joined.length });
  return { endpoint: cleanName, run_id: runId, status: "finished", text: wrapped, text_chars: joined.length, events_seen: events.length, tool_calls: [{ name: cleanTool, args }], error: "" };
}

// ---------------------------------------------------------------------------
// A2A 侧：复用缺口 38 的名片 + 缺口 12 的交接（askPeer）
// ---------------------------------------------------------------------------

export interface AguiA2aDeps {
  peerDeps?: Parameters<typeof askPeer>[0]["deps"];
}

/**
 * 给 A2A 对端发一条消息：走缺口 12 的 askPeer（自带对端协作开关、
 * 信任圈闸与独立审查门），答复过 wrapUntrusted 后返回。
 * 发之前与收到之后各记一条 agui_a2a_* 事件（只记对方名与结论，
 * 不记消息原文与答复原文）。
 */
export async function sendA2a(home: string, peerName: string, message: string, deps?: AguiA2aDeps): Promise<{ answer: string; runId: string }> {
  const peer = peerName.trim();
  const text = message.trim();
  if (!peer) throw new AguiError("对方好友名不能为空");
  if (!text) throw new AguiError("消息不能为空");
  if (text.length > AGUI_MAX_MESSAGE_CHARS) throw new AguiError(`消息最多 ${AGUI_MAX_MESSAGE_CHARS} 字`);
  const config = loadConfig(home);
  const entry = resolvePeer(config, peer);
  if (!entry) throw new AguiError(`没有对端 ${peer}：先跑 nyra peer add 加好友`);
  recordAguiEvent(home, "agui_a2a_sent", { peer, run: "" });
  const { answer, runId } = await askPeer({ config, home, peer: entry, question: text, deps: deps?.peerDeps });
  recordAguiEvent(home, "agui_a2a_received", { peer, run: runId, ok: true });
  return { answer, runId };
}

// ---------------------------------------------------------------------------
// CLI：nyra agui <register|list|show|link|connect|disconnect|send|exec|accept-write|revoke-write|a2a>
// ---------------------------------------------------------------------------

const AGUI_USAGE = [
  "用法：nyra agui <子命令> [参数]",
  "  register <名字> <地址> [--peer <好友名>]   登记一个外部 AG-UI endpoint（只登记，不连接）",
  "  list [--json]                              列出已登记的 endpoint",
  "  show <名字> [--json]                       看一个 endpoint 的详情",
  "  link <名字> <好友名>                       绑定名片好友（发现层，connect 前须绑定）",
  "  connect <名字>                             准入闸 + 握手后连接（只读接入）",
  "  disconnect <名字>                          断开（写接受随断开一并撤销）",
  "  send <名字> <消息>                         给外部 agent 发消息，走 AG-UI 事件流（只读）",
  "  exec <名字> <工具> [参数 JSON]              请外部 agent 执行它的一只工具（写操作，须先显式接受）",
  "  accept-write <名字> --yes                  机主显式接受该 endpoint 的写操作",
  "  revoke-write <名字>                        撤销写接受",
  "  a2a <好友名> <消息>                         给 A2A 对端发消息（复用缺口 38 名片 + 缺口 12 交接）",
  "  serve <enable|disable|status|start|token|grant|revoke-grant>  AG-UI 服务端：把 Nyra 对外暴露成 AG-UI endpoint（第二批，默认关闭）",
  "外部 agent 发来的任何内容都按不可信输入处理（先过注入扫描再决定做不做）；",
  "写操作须对方主人显式接受，接受前一律拒绝。详见 docs/agui.md。",
].join("\n");

export async function aguiMain(argv: string[], home: string, deps?: AguiFetchDeps & AguiA2aDeps): Promise<number> {
  const cmd = argv[0];
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const err = (msg: string): number => {
    process.stderr.write(`错误：${msg}\n`);
    return 1;
  };
  const usage = (): number => {
    process.stdout.write(AGUI_USAGE + "\n");
    return 0;
  };
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return usage();
    if (cmd === "register") {
      const name = argv[1];
      const url = argv[2];
      if (!name || !url) {
        process.stderr.write("用法：nyra agui register <名字> <地址> [--peer <好友名>]\n");
        return 2;
      }
      const endpoint = registerEndpoint(home, name, url, flagValue("--peer"));
      process.stdout.write(`AG-UI endpoint 已登记：${endpoint.name}（${endpoint.url}）\n`);
      process.stdout.write(endpoint.peer_name
        ? `已绑名片好友 ${endpoint.peer_name}：跑 nyra agui connect ${endpoint.name} 连接。\n`
        : `还没绑名片好友：先跑 nyra agui link ${endpoint.name} <好友名>（对方须是已批准好友且在信任圈里）。\n`);
      return 0;
    }
    if (cmd === "list") {
      const endpoints = listEndpoints(home);
      if (has("--json")) {
        process.stdout.write(JSON.stringify(endpoints, null, 2) + "\n");
        return 0;
      }
      if (!endpoints.length) {
        process.stdout.write("还没有登记 AG-UI endpoint：先跑 nyra agui register <名字> <地址>。\n");
        return 0;
      }
      for (const e of endpoints) {
        process.stdout.write(`${e.name}\t${e.status === "connected" ? "已连接" : e.status === "disconnected" ? "已断开" : "已登记"}\t${e.url}\t${e.peer_name ?? "未绑名片"}\t写操作${e.write_accepted_by ? "已接受" : "未接受"}\n`);
      }
      return 0;
    }
    if (cmd === "show") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra agui show <名字> [--json]\n");
        return 2;
      }
      const endpoint = findEndpoint(loadAguiBook(home), checkName(name));
      if (!endpoint) return err(`没有登记过 endpoint ${name}`);
      if (has("--json")) {
        process.stdout.write(JSON.stringify(endpoint, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(`名字：${endpoint.name}\n地址：${endpoint.url}\n状态：${endpoint.status === "connected" ? "已连接" : endpoint.status === "disconnected" ? "已断开" : "已登记"}\n协议版本：${endpoint.protocol_version || "未握手"}\n名片好友：${endpoint.peer_name ?? "未绑定"}\n模式：只读\n写操作：${endpoint.write_accepted_by ? `已接受（${endpoint.write_accepted_by}，${endpoint.write_accepted_at ?? ""}）` : "未接受"}\n能力事件：${endpoint.capabilities.events.join("、") || "未声明"}\n能力工具：${endpoint.capabilities.tools.join("、") || "未声明"}\n最近一次运行：${endpoint.last_run_id ?? "无"}\n`);
      return 0;
    }
    if (cmd === "link") {
      const name = argv[1];
      const peer = argv[2];
      if (!name || !peer) {
        process.stderr.write("用法：nyra agui link <名字> <好友名>\n");
        return 2;
      }
      const endpoint = linkEndpoint(home, name, peer);
      process.stdout.write(`endpoint ${endpoint.name} 已绑名片好友 ${endpoint.peer_name}。\n`);
      return 0;
    }
    if (cmd === "connect") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra agui connect <名字>\n");
        return 2;
      }
      const endpoint = await connectEndpoint(home, name, deps);
      process.stdout.write(`AG-UI endpoint 已连接：${endpoint.name}（协议 ${endpoint.protocol_version}，只读接入）\n`);
      process.stdout.write(`对方声明的事件：${endpoint.capabilities.events.join("、") || "无"}；工具：${endpoint.capabilities.tools.join("、") || "无"}。\n`);
      return 0;
    }
    if (cmd === "disconnect") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra agui disconnect <名字>\n");
        return 2;
      }
      disconnectEndpoint(home, name);
      process.stdout.write(`AG-UI endpoint 已断开：${name}（写接受已随断开撤销）。\n`);
      return 0;
    }
    if (cmd === "send") {
      const name = argv[1];
      const message = argv.slice(2).join(" ").trim();
      if (!name || !message) {
        process.stderr.write("用法：nyra agui send <名字> <消息>\n");
        return 2;
      }
      const result = await runAgui(home, name, message, deps);
      if (result.status === "blocked" || result.status === "error") {
        process.stderr.write(`AG-UI 运行${result.status === "blocked" ? "被拦截" : "失败"}：${result.error}\n`);
        return 1;
      }
      process.stdout.write(`${result.text}\n`);
      if (result.tool_calls.length) {
        process.stdout.write(`对方提议了 ${result.tool_calls.length} 只工具调用（只当提议记下，不执行）：${result.tool_calls.map((t) => t.name).join("、")}\n`);
      }
      return 0;
    }
    if (cmd === "exec") {
      const name = argv[1];
      const tool = argv[2];
      const args = argv[3] ?? "";
      if (!name || !tool) {
        process.stderr.write("用法：nyra agui exec <名字> <工具> [参数 JSON]\n");
        return 2;
      }
      const result = await execAguiTool(home, name, tool, args, deps);
      if (result.status === "blocked" || result.status === "error") {
        process.stderr.write(`AG-UI 写操作${result.status === "blocked" ? "被拦截" : "失败"}：${result.error}\n`);
        return 1;
      }
      process.stdout.write(`${result.text}\n`);
      return 0;
    }
    if (cmd === "accept-write") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra agui accept-write <名字> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("写接受是显式授权，须加 --yes：nyra agui accept-write <名字> --yes\n");
        return 2;
      }
      acceptWrite(home, name);
      process.stdout.write(`endpoint ${name} 的写操作已由机主显式接受（接受记录已进证据链）。\n`);
      return 0;
    }
    if (cmd === "revoke-write") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra agui revoke-write <名字>\n");
        return 2;
      }
      revokeWrite(home, name);
      process.stdout.write(`endpoint ${name} 的写接受已撤销（之后写操作重新变拒绝）。\n`);
      return 0;
    }
    if (cmd === "a2a") {
      const peer = argv[1];
      const message = argv.slice(2).join(" ").trim();
      if (!peer || !message) {
        process.stderr.write("用法：nyra agui a2a <好友名> <消息>\n");
        return 2;
      }
      const { answer } = await sendA2a(home, peer, message, deps);
      process.stdout.write(`${answer}\n`);
      return 0;
    }
    if (cmd === "serve") {
      // 缺口 47 第二批：serve 的实现在 aguiServer.ts；aguiServer 静态引
      // agui.ts（复用事件名与握手口径），这里只能动态 import，否则循环导入。
      const { aguiServeMain } = await import("./aguiServer.ts");
      return aguiServeMain(argv.slice(1), home);
    }
    process.stderr.write(`未知子命令 ${cmd}\n${AGUI_USAGE}\n`);
    return 2;
  } catch (e) {
    if (e instanceof AguiError) return err(e.message);
    throw e;
  }
}
