// src/a2a.ts — G-P1-20 A2A 服务端（Agent2Agent Protocol v1.0）：
// Nyra 对外暴露成 A2A agent（HTTP 上讲 JSON-RPC 2.0），别的 agent 能
// 直接调用 Nyra。AG-UI 服务端（缺口 47 第二批）走 AG-UI 事件，ACP
// （上一批）走 stdio，A2A 走 HTTP + JSON-RPC；三者共用同一套治理：
// 对方消息先过注入扫描、再打不可信标记才进模型上下文，运行一律
// origin "peer"、写操作进 peer 提议门、成本硬顶照常、不自动换模型。
//
// 协议依据：A2A v1.0（2026-03-12 生产稳定版，a2a-protocol.org/v1.0.1
// 的 whats-new-v1 核对过；相对 v0.3 的 breaking 变化都按它来）。
//   - 发现：GET /.well-known/agent-card.json（v1.0 标准路径）与
//     /.well-known/agent.json（老路径，同内容），不鉴权——名片
//     是公开契约（只含名字、技能、鉴权方式，不含任何数据）；服务端只
//     在显式启用 + 前台 start 跑着时才存在。
//   - 调用：POST / 是 JSON-RPC 2.0 端点（名片里的
//     supportedInterfaces[0].url 就指它）。message/send（同步跑一轮，
//     回 Task）、message/stream（SSE 流 taskStatusUpdate /
//     taskArtifactUpdate，最后回 Task）、tasks/get、tasks/cancel、
//     tasks/list（游标分页）、tasks/resubscribe、agent/card。
//   - 任务状态（线上）：TASK_STATE_SUBMITTED / TASK_STATE_WORKING /
//     TASK_STATE_COMPLETED / TASK_STATE_FAILED / TASK_STATE_CANCELED /
//     TASK_STATE_REJECTED / TASK_STATE_INPUT_REQUIRED；账本里仍存小
//     写状态（submitted/working/...），边界处翻译。input-required 本
//     批不发（Nyra 不向调用方反问，缺信息直接在回答里说明）。
//   - 消息角色线上是 ROLE_USER / ROLE_AGENT；part 是统一结构（靠
//     成员区分：text / url / raw / data），不带 kind；Task 带
//     createdAt / lastModified（ISO 8601 UTC，毫秒精度）。
//   - 错误：JSON-RPC 标准码 + A2A 码（-32001 任务不存在、-32002
//     任务不可取消、-32003 推送通知不支持、-32005 内容类型不支持，
//     只认 text part，file/data/url/raw 直接拒），错误 data 是
//     google.rpc.ErrorInfo 数组（reason + domain a2a-protocol.org）。
//   - 推送通知（pushNotificationConfig）本批不支持，带了报 -32003，
//     不假装接了；客户端指定的 MCP 服务器本批不接（Nyra 用自己的
//     MCP 配置），带了直接忽略不应用——不，不静默忽略：A2A 没有
//     mcpServers 字段，message 里带 data part 已按 -32005 拒掉。
//   - 只做 HTTP 传输：gRPC 与多租户（tenant）不做，见 docs/a2a.md
//     的已知限制。extendedAgentCard 不实现：agent/card 能力里
//     extendedAgentCard: false，调 agent/getAuthenticatedExtendedCard
//     回 -32601 未知方法。
//
// 本批不做：A2A 客户端走 JSON-RPC（已有 `nyra agui a2a`，走名片 +
// 交接的老口子，本批不动它）；input-required 反问流；推送通知；
// 服务端运行分配 Bot 电脑（用主 agent 的工作目录）；MCP 工具暴露
// 给服务端运行（mcpManager 为 null）；真 A2A 客户端联调。
//
// 诚实边界：只在临时 home / 本机回环 + 假客户端上验过；真 A2A 客户
// 端（ADK / LangGraph 等）未接通过；媒体面未加密，别当端到端加密用。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadSession, resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { isSuspiciousSegment, suspiciousLabels, frameUntrusted } from "./untrusted.ts";
import { loadConfig, resolveProvider } from "./config.ts";
import { Provider } from "./providers.ts";
import { Agent } from "./agent.ts";
import { READONLY_TOOLS, TOOL_SCHEMAS } from "./tools.ts";
import { resolvePricing } from "./cost.ts";
import { buildAgentCard } from "./peerCard.ts";
import { loadSigningKey, signAgentCard, signAgentCardV1 } from "./cardSignature.ts";
import { agentContract } from "./agentContract.ts";
import { applyInterventions, newBusMessageId } from "./interventions.ts";

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_AGENT_NAME = "nyra";
export const A2A_CONFIG_FILE = "a2a-server.json";
export const A2A_TASKS_FILE = "a2a-tasks.json";
export const A2A_SERVER_DEFAULT_HOST = "127.0.0.1";
export const A2A_SERVER_DEFAULT_PORT = 8767;
export const A2A_SERVER_MAX_BODY_CHARS = 200_000;
export const A2A_MAX_TEXT_CHARS = 200_000;
export const A2A_MAX_TASKS = 200;
export const A2A_SERVER_TOKEN_PREFIX = "nyra-a2a-";
export const A2A_SERVER_TOKEN_ID_RE = /^tok_[0-9a-f]{8}$/;

export type A2aTaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected";

export const A2A_TERMINAL_STATES: readonly A2aTaskState[] = ["completed", "failed", "canceled", "rejected"];

// ---------------------------------------------------------------------------
// v1.0 线上格式：账本里仍存小写状态 / user-agent 角色 / 带 kind 的
// part（内部格式不动，落盘与旧任务兼容），发到线上的那一刻再翻成
// v1.0 的样子（TASK_STATE_* / ROLE_* / 不带 kind 的统一 part）。
// ---------------------------------------------------------------------------

/** A2A v1.0 线上状态：submitted → TASK_STATE_SUBMITTED，以此类推。 */
export const V1_TASK_STATE: Record<A2aTaskState, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
};

/** A2A v1.0 线上角色：user/agent → ROLE_USER/ROLE_AGENT。 */
export function v1Role(role: "user" | "agent"): string {
  return role === "user" ? "ROLE_USER" : "ROLE_AGENT";
}

/** 账本里的 part（带 kind 的 text）翻成 v1.0 的统一 part（{text, mediaType}，不带 kind）。 */
export function wirePart(part: A2aMessagePart): Record<string, unknown> {
  return { text: part.text, mediaType: "text/plain" };
}

export function wireMessage(message: A2aMessage, taskId: string, contextId: string): Record<string, unknown> {
  return {
    role: v1Role(message.role),
    messageId: message.messageId,
    taskId,
    contextId,
    parts: message.parts.map(wirePart),
  };
}

export function wireStatus(status: A2aTask["status"], taskId: string, contextId: string): Record<string, unknown> {
  return {
    state: V1_TASK_STATE[status.state],
    ...(status.message ? { message: wireMessage(status.message, taskId, contextId) } : {}),
    timestamp: status.timestamp,
  };
}

export function wireArtifact(artifact: A2aArtifact): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name ? { name: artifact.name } : {}),
    parts: artifact.parts.map(wirePart),
  };
}

export class A2aError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "A2aError";
    this.code = code;
  }
}

export interface A2aServerToken {
  id: string;
  name: string;
  /** 只存 SHA-256 指纹，明文永不落盘。 */
  token_hash: string;
  /** 写授权：有它模型才能提议写操作；执行仍须机主逐条批提议。 */
  write_granted: boolean;
  write_granted_by: string | null;
  write_granted_at: string | null;
  created_at: string;
}

export interface A2aServerConfig {
  version: 1;
  enabled: boolean;
  host: string;
  port: number;
  tokens: A2aServerToken[];
}

export interface A2aMessagePart {
  kind: "text";
  text: string;
}

export interface A2aMessage {
  role: "user" | "agent";
  messageId: string;
  parts: A2aMessagePart[];
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  parts: A2aMessagePart[];
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: { state: A2aTaskState; message?: A2aMessage; timestamp: string };
  statusHistory: { state: A2aTaskState; timestamp: string }[];
  history: A2aMessage[];
  artifacts: A2aArtifact[];
  createdAt: string;
  updatedAt: string;
}

export interface A2aRunResult {
  taskId: string;
  contextId: string;
  text: string;
  textChars: number;
  toolCalls: { name: string; args: string }[];
  proposals: { proposalId: string; tool: string }[];
  spentUsd: number | null;
  error: string;
}

/** Agent 执行层注入点：测试用假 runner，不花真模型钱。 */
export interface A2aServerDeps {
  agentRunner?: (
    home: string,
    task: string,
    opts: { taskId: string; contextId: string; tokenName: string; writeGranted: boolean; signal: AbortSignal },
  ) => Promise<A2aRunResult>;
  /** 覆盖名片里的 url（startA2aServer 用真实绑定端口填；不填时读配置）。 */
  baseUrl?: string;
}

function serverPath(home: string): string {
  return join(resolveNyraHome(home), A2A_CONFIG_FILE);
}

function tasksPath(home: string): string {
  return join(resolveNyraHome(home), A2A_TASKS_FILE);
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

function newTokenId(): string {
  return `tok_${randomBytes(4).toString("hex")}`;
}

function newTaskId(): string {
  return `a2a-${randomBytes(6).toString("hex")}`;
}

function newContextId(): string {
  return `ctx-${randomBytes(6).toString("hex")}`;
}

function newMessageId(): string {
  return `msg-${randomBytes(4).toString("hex")}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…（已截断）" : text;
}

/** 读服务端配置：没有返回默认配置（关闭、回环、8767、零 token）。 */
export function loadA2aServerConfig(home: string): A2aServerConfig {
  const path = serverPath(home);
  if (!existsSync(path)) {
    return { version: 1, enabled: false, host: A2A_SERVER_DEFAULT_HOST, port: A2A_SERVER_DEFAULT_PORT, tokens: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new A2aError(-32603, `${A2A_CONFIG_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.tokens)) {
    throw new A2aError(-32603, `${A2A_CONFIG_FILE} 结构不对（须含 tokens 列表）`);
  }
  const host = typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : A2A_SERVER_DEFAULT_HOST;
  const port = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536
    ? parsed.port
    : A2A_SERVER_DEFAULT_PORT;
  return {
    version: 1,
    enabled: parsed.enabled === true,
    host,
    port,
    tokens: parsed.tokens as A2aServerToken[],
  };
}

export function saveA2aServerConfig(home: string, config: A2aServerConfig): void {
  writeJsonAtomic(home, A2A_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function setA2aServerEnabled(home: string, enabled: boolean): A2aServerConfig {
  const config = loadA2aServerConfig(home);
  config.enabled = enabled;
  saveA2aServerConfig(home, config);
  return config;
}

export function a2aBaseUrl(home: string): string {
  const config = loadA2aServerConfig(home);
  return `http://${config.host}:${config.port}`;
}

/** 发一条服务端运行事件（只记任务 / 上下文 / 结论，不记原文）。 */
function recordA2aEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`A2A 服务端：${type}`, "a2a-server", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token：明文只在创建时返回一次，盘上只留 SHA-256 指纹
// ---------------------------------------------------------------------------

export function createA2aServerToken(home: string, name: string): { record: A2aServerToken; plaintext: string } {
  const cleanName = name.trim();
  if (!cleanName) throw new A2aError(-32602, "token 名字不能为空");
  if (cleanName.length > 64) throw new A2aError(-32602, "token 名字最多 64 字");
  const config = loadA2aServerConfig(home);
  if (config.tokens.some((t) => t.name === cleanName)) {
    throw new A2aError(-32602, `已有同名 token ${cleanName}（先跑 nyra a2a serve token list 看它）`);
  }
  const plaintext = A2A_SERVER_TOKEN_PREFIX + randomBytes(24).toString("hex");
  const record: A2aServerToken = {
    id: newTokenId(),
    name: cleanName,
    token_hash: sha256Hex(plaintext),
    write_granted: false,
    write_granted_by: null,
    write_granted_at: null,
    created_at: nowIso(),
  };
  config.tokens.push(record);
  saveA2aServerConfig(home, config);
  recordA2aEvent(home, "a2a_token_created", { token: record.id });
  return { record, plaintext };
}

export function listA2aServerTokens(home: string): A2aServerToken[] {
  return loadA2aServerConfig(home).tokens;
}

export function revokeA2aServerToken(home: string, id: string): A2aServerToken {
  const config = loadA2aServerConfig(home);
  const idx = config.tokens.findIndex((t) => t.id === id);
  if (idx < 0) throw new A2aError(-32602, `没有 token ${id}：先跑 nyra a2a serve token list 看已有的 token`);
  const [removed] = config.tokens.splice(idx, 1);
  saveA2aServerConfig(home, config);
  recordA2aEvent(home, "a2a_token_revoked", { token: id });
  return removed;
}

/** 验 Bearer token：比 SHA-256 指纹（timingSafeEqual），错了直接 null。 */
export function verifyA2aServerToken(home: string, presented: string): A2aServerToken | null {
  const clean = presented.trim();
  if (!clean) return null;
  const digest = sha256Hex(clean);
  for (const token of loadA2aServerConfig(home).tokens) {
    try {
      if (timingSafeEqual(Buffer.from(digest, "utf-8"), Buffer.from(token.token_hash, "utf-8"))) return token;
    } catch {
      continue;
    }
  }
  return null;
}

export function findA2aServerToken(home: string, id: string): A2aServerToken | null {
  return loadA2aServerConfig(home).tokens.find((t) => t.id === id) ?? null;
}

/** 机主显式给某 token 写提议权（须 CLI 加 --yes；只放行“提议”，执行仍逐条批）。 */
export function grantA2aServerWrite(home: string, id: string, by?: string): A2aServerToken {
  const config = loadA2aServerConfig(home);
  const token = config.tokens.find((t) => t.id === id);
  if (!token) throw new A2aError(-32602, `没有 token ${id}：先跑 nyra a2a serve token list 看已有的 token`);
  token.write_granted = true;
  token.write_granted_by = by ?? "owner";
  token.write_granted_at = nowIso();
  saveA2aServerConfig(home, config);
  recordA2aEvent(home, "a2a_write_granted", { token: id, granted_by: token.write_granted_by });
  return token;
}

/** 撤销某 token 的写提议权（之后模型连写工具都看不到）。 */
export function revokeA2aServerWrite(home: string, id: string): A2aServerToken {
  const config = loadA2aServerConfig(home);
  const token = config.tokens.find((t) => t.id === id);
  if (!token) throw new A2aError(-32602, `没有 token ${id}：先跑 nyra a2a serve token list 看已有的 token`);
  token.write_granted = false;
  token.write_granted_by = null;
  token.write_granted_at = null;
  saveA2aServerConfig(home, config);
  recordA2aEvent(home, "a2a_write_revoked", { token: id });
  return token;
}

/** 写提议权之外的 token：写工具直接从工具表里拿掉，模型连提议都提不出来。 */
export function a2aDisabledTools(writeGranted: boolean): string[] {
  if (writeGranted) return [];
  const disabled: string[] = [];
  for (const s of TOOL_SCHEMAS) {
    const name = (s.function as Record<string, unknown>).name as string;
    if (!READONLY_TOOLS.has(name)) disabled.push(name);
  }
  return disabled;
}

// ---------------------------------------------------------------------------
// 名片：复用缺口 38 的 buildAgentCard（名字 / 描述 / 技能如实生成），
// 再按 A2A v1.0 的形状重排：supportedInterfaces（地址 + JSONRPC +
// 协议 1.0）+ capabilities（streaming 本批真做了，
// pushNotifications 没做，stateTransitionHistory 有——resubscribe
// 能重放历史，extendedAgentCard 不实现）+ securitySchemes。
// ---------------------------------------------------------------------------

export function buildA2aAgentCard(home: string, config: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
  const base = buildAgentCard(home, config);
  const card: Record<string, unknown> = {
    name: base.name,
    description: base.description,
    version: base.version,
    agentId: base.agentId,
    supportedInterfaces: [{ url: baseUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extendedAgentCard: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: base.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, examples: s.examples, inputModes: s.inputModes, outputModes: s.outputModes })),
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    // H7：最小稳定契约 nyra-contract-v1——卡片里写清认哪 10 条命令，
    // 对方照着调就行；签名在后面算，契约字段在签名之前，不破坏签名。
    contract: agentContract(),
  };
  // A2A v1.0：开了签名且密码箱里有钥匙时，名片同时带 v1.0 的
  // signatures[]（JWS 分离式，签规范化名片）与老版紧凑 JWS
  // signature + public_key（老对方还能认）；没钥匙发素名片，
  // 不报错、不假装签过。
  const raw = config.peer_card as Record<string, unknown> | undefined;
  if (raw && raw.signing === true) {
    const keypair = loadSigningKey(home);
    if (keypair) {
      const v1 = signAgentCardV1(card, keypair);
      card.signatures = [{ protected: v1.protected, signature: v1.signature, header: v1.header }];
      const sig = signAgentCard(card, keypair);
      card.signature = sig.jws;
      card.public_key = sig.publicKey;
    }
  }
  return card;
}

// ---------------------------------------------------------------------------
// 任务账本：~/.nyra/a2a-tasks.json（0600 原子写，最多留 200 条，
// 旧的已结束任务先淘汰；只存文本 part，不存文件与二进制）。
// ---------------------------------------------------------------------------

export function loadA2aTasks(home: string): A2aTask[] {
  const path = tasksPath(home);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tasks: A2aTask[] = [];
  for (const t of parsed) {
    if (!isPlainObject(t) || typeof t.id !== "string" || typeof t.contextId !== "string") continue;
    if (!isPlainObject(t.status) || typeof t.status.state !== "string") continue;
    tasks.push(t as unknown as A2aTask);
  }
  return tasks;
}

export function saveA2aTasks(home: string, tasks: A2aTask[]): void {
  const trimmed = tasks.slice(-A2A_MAX_TASKS);
  writeJsonAtomic(home, A2A_TASKS_FILE, JSON.stringify(trimmed, null, 2) + "\n");
}

export function getA2aTask(home: string, id: string): A2aTask | null {
  return loadA2aTasks(home).find((t) => t.id === id) ?? null;
}

function upsertA2aTask(home: string, task: A2aTask): void {
  const tasks = loadA2aTasks(home);
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
  saveA2aTasks(home, tasks);
}

function setTaskState(task: A2aTask, state: A2aTaskState, message?: A2aMessage): void {
  task.status = { state, ...(message ? { message } : {}), timestamp: nowIso() };
  task.statusHistory.push({ state, timestamp: task.status.timestamp });
  task.updatedAt = task.status.timestamp;
}

function newA2aTask(contextId: string): A2aTask {
  const now = nowIso();
  return {
    id: newTaskId(),
    contextId,
    status: { state: "submitted", timestamp: now },
    statusHistory: [{ state: "submitted", timestamp: now }],
    history: [],
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 任务的公开形状（A2A v1.0 线上格式）：状态与角色翻成 v1.0 枚举，
 * part 去掉 kind，带 createdAt / lastModified；historyLength 为 0
 * 时不带 history（默认全带）。 */
export function publicA2aTask(task: A2aTask, historyLength?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: task.id,
    contextId: task.contextId,
    status: wireStatus(task.status, task.id, task.contextId),
    artifacts: task.artifacts.map(wireArtifact),
    createdAt: task.createdAt,
    lastModified: task.updatedAt,
    kind: "task",
  };
  if (historyLength === undefined || historyLength === null) {
    out.history = task.history.map((m) => wireMessage(m, task.id, task.contextId));
  } else if (historyLength > 0) {
    out.history = task.history.slice(-historyLength).map((m) => wireMessage(m, task.id, task.contextId));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 消息解析：只认 text part；file/data/url/raw 直接 -32005（内容类型
// 不支持，不假装能读）；pushNotificationConfig 带了报 -32003（本批
// 不支持推送）。role 与 part 两种写法都认：v1.0 的 ROLE_USER /
// 不带 kind 的 {text}，与老版 v0.3 的 user / {kind: "text"}。
// ---------------------------------------------------------------------------

export function extractA2aMessageText(message: unknown): string {
  if (!isPlainObject(message)) throw new A2aError(-32602, "message 须是对象");
  if (message.role !== "user" && message.role !== "ROLE_USER") throw new A2aError(-32602, "message 的 role 须是 user 或 ROLE_USER（调用方只能发用户消息）");
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new A2aError(-32602, "message.parts 须是非空列表");
  }
  const parts: string[] = [];
  for (const part of message.parts) {
    if (!isPlainObject(part)) {
      throw new A2aError(-32602, "message.parts 里的每块须是对象");
    }
    if (part.kind !== undefined && part.kind !== "text" && part.kind !== "file" && part.kind !== "data") {
      throw new A2aError(-32602, `message.parts 的 kind 不认：${String(part.kind)}`);
    }
    if (typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.kind === "file" || part.kind === "data" || "url" in part || "raw" in part || "data" in part) {
      const kind = typeof part.kind === "string" ? part.kind : "url" in part ? "url" : "raw" in part ? "raw" : "data";
      throw new A2aError(-32005, `不支持的内容块类型 ${kind}（Nyra A2A 本批只支持 text part）`);
    }
    throw new A2aError(-32602, "text part 须带 text 字符串");
  }
  const text = parts.join("\n").trim();
  if (!text) throw new A2aError(-32602, "message 为空（至少须有一块非空文本）");
  if (text.length > A2A_MAX_TEXT_CHARS) throw new A2aError(-32602, `message 最多 ${A2A_MAX_TEXT_CHARS} 字`);
  return text;
}

function checkA2aConfiguration(params: Record<string, unknown>): void {
  const configuration = params.configuration;
  if (configuration === undefined || configuration === null) return;
  if (!isPlainObject(configuration)) throw new A2aError(-32602, "configuration 须是对象");
  if (configuration.pushNotificationConfig !== undefined && configuration.pushNotificationConfig !== null) {
    throw new A2aError(-32003, "Nyra A2A 本批不支持推送通知（pushNotificationConfig）");
  }
  const modes = configuration.acceptedOutputModes;
  if (modes !== undefined && modes !== null) {
    if (!Array.isArray(modes)) throw new A2aError(-32602, "acceptedOutputModes 须是字符串列表");
    for (const m of modes) {
      if (m !== "text") throw new A2aError(-32005, `不支持的输出模式 ${String(m)}（Nyra A2A 本批只出 text）`);
    }
  }
}

function historyLengthParam(params: Record<string, unknown>): number | undefined {
  const v = params.historyLength;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new A2aError(-32602, "historyLength 须是非负整数");
  }
  return v;
}

// ---------------------------------------------------------------------------
// 服务端运行：Agent 以 origin "peer" 跑，写操作进提议门
// ---------------------------------------------------------------------------

/** 在跑的任务：tasks/cancel 靠它中断正在跑的一轮（key 是 home + 任务 id）。 */
const runningTasks = new Map<string, AbortController>();

export function runA2aAgent(
  home: string,
  task: string,
  opts: { taskId: string; contextId: string; tokenName: string; writeGranted: boolean; signal: AbortSignal },
): Promise<A2aRunResult> {
  return (async (): Promise<A2aRunResult> => {
    const config = loadConfig(home);
    const provider = new Provider(resolveProvider({ home, config }));
    if (!provider.hasCredentials()) {
      throw new A2aError(-32603, "A2A 服务端没配模型凭据：先在 Nyra 里配好模型再连");
    }
    const sessionId = `a2a-${opts.contextId}`;
    const toolCalls: { name: string; args: string }[] = [];
    const proposals: { proposalId: string; tool: string }[] = [];
    let text = "";
    const pricing = resolvePricing(config.pricing, provider.model ?? null);
    const agent = new Agent(provider, {
      workdir: process.cwd(),
      mode: "auto",
      maxTurns: 20,
      sessionId,
      interactive: false,
      home,
      // 治理与 AG-UI / ACP 服务端看齐：origin "peer"——写操作进 peer
      // 提议门（只记提议不执行），peer 名记 token 名，提议里能认出是谁提的。
      origin: "peer",
      peerName: `a2a:${opts.tokenName}`,
      messages: loadSession(sessionId, home),
      disabledTools: a2aDisabledTools(opts.writeGranted),
      onEvent: (kind, data) => {
        try {
          if ((kind === "assistant" || kind === "final") && typeof data.content === "string" && data.content) {
            text += data.content;
          } else if (kind === "tool_start") {
            const name = typeof data.name === "string" ? data.name : "";
            const args = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {});
            toolCalls.push({ name, args });
          } else if (kind === "peer_proposal_recorded") {
            const proposalId = typeof data.proposal_id === "string" ? data.proposal_id : "";
            const tool = typeof data.tool === "string" ? data.tool : "";
            if (proposalId && tool) proposals.push({ proposalId, tool });
          }
        } catch { /* 观察器故障绝不破坏主循环 */ }
      },
      cancelSignal: opts.signal,
      // 成本硬顶（网关同款口径：单次上限）：超支停下，不编 0。
      maxCostUsd: typeof config.max_cost_usd === "number" ? (config.max_cost_usd as number) : null,
      pricing,
    });
    const finalText = await agent.run(task);
    const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    return {
      taskId: opts.taskId,
      contextId: opts.contextId,
      text: finalText || text,
      textChars: (finalText || text).length,
      toolCalls,
      proposals,
      spentUsd: spent,
      error: "",
    };
  })();
}

function agentMessage(text: string): A2aMessage {
  return { role: "agent", messageId: newMessageId(), parts: [{ kind: "text", text }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 分发：message/send、message/stream、tasks/*、agent/card。
// message/stream 把事件写进 sink（每行一条 SSE data:），回 null 表示
// 已流式发完、HTTP 层直接收尾；其余方法回 JSON-RPC 响应对象。
// ---------------------------------------------------------------------------

export type A2aRpcSink = (line: string) => void;

export interface A2aRpcContext {
  token: A2aServerToken | null;
  baseUrl: string;
  deps?: A2aServerDeps;
  sink?: A2aRpcSink;
}

function rpcResult(id: string | number | null, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** A2A v1.0 的错误 data：google.rpc.ErrorInfo 数组（reason + domain）。 */
const A2A_ERROR_REASONS: Record<number, string> = {
  [-32000]: "AUTHENTICATION_REQUIRED",
  [-32001]: "TASK_NOT_FOUND",
  [-32002]: "TASK_NOT_CANCELABLE",
  [-32003]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [-32004]: "UNSUPPORTED_OPERATION",
  [-32005]: "UNSUPPORTED_CONTENT_TYPE",
  [-32600]: "INVALID_REQUEST",
  [-32601]: "METHOD_NOT_FOUND",
  [-32602]: "INVALID_PARAMS",
  [-32603]: "INTERNAL_ERROR",
  [-32700]: "PARSE_ERROR",
};

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data: [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: A2A_ERROR_REASONS[code] ?? "INTERNAL_ERROR",
        domain: "a2a-protocol.org",
      }],
    },
  };
}

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** v1.0 的状态更新事件：包在 taskStatusUpdate 里（kind 与 final 都没了，流关了即结束）。 */
function statusUpdateEvent(task: A2aTask): Record<string, unknown> {
  return {
    taskStatusUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      status: wireStatus(task.status, task.id, task.contextId),
    },
  };
}

/** v1.0 的 artifact 更新事件：包在 taskArtifactUpdate 里，带 index（该 artifact 在任务 artifacts 里的位置）。 */
function artifactUpdateEvent(task: A2aTask, artifact: A2aArtifact, index: number, lastChunk: boolean): Record<string, unknown> {
  return {
    taskArtifactUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      artifact: wireArtifact(artifact),
      index,
      append: false,
      lastChunk,
    },
  };
}

function parseRpcId(raw: unknown): string | number | null {
  if (typeof raw === "string" || typeof raw === "number") return raw;
  return null;
}

/**
 * 跑一轮 A2A 任务：先过注入扫描（可疑直接 rejected，不进模型），再跑
 * agent，结束按状态落盘。stream 时每步事件也写进 sink。
 */
async function runA2aTask(
  home: string,
  task: A2aTask,
  text: string,
  token: A2aServerToken,
  ctx: A2aRpcContext,
): Promise<A2aTask> {
  recordA2aEvent(home, "a2a_task_created", { task: task.id, context: task.contextId });
  if (isSuspiciousSegment(text)) {
    const labels = suspiciousLabels(text).join("、") || "可疑指令";
    const reason = `对方发来的消息被注入扫描拦截（${labels}），本轮已停下`;
    setTaskState(task, "rejected", agentMessage(reason));
    upsertA2aTask(home, task);
    recordA2aEvent(home, "a2a_blocked", { task: task.id, labels });
    return task;
  }
  const controller = new AbortController();
  runningTasks.set(`${home}:${task.id}`, controller);
  setTaskState(task, "working");
  upsertA2aTask(home, task);
  if (ctx.sink) {
    ctx.sink(sseLine({ jsonrpc: "2.0", result: statusUpdateEvent(task) }));
  }
  // 致命三元组批的规矩：对端内容进模型上下文前先打不可信标记——
  // 注入扫描只拦可疑指令，标记是让模型知道这段话来自对端、按不可
  // 信输入处理（kind 是 peer，来源是 token 名）。账本 history 里
  // 仍存对方发来的原文，标记只加在送进 runner 的那份上。
  const framedText = frameUntrusted(text, `peer:a2a:${token.name}`);
  const runner = ctx.deps?.agentRunner ?? runA2aAgent;
  let result: A2aRunResult;
  try {
    result = await runner(home, framedText, {
      taskId: task.id,
      contextId: task.contextId,
      tokenName: token.name,
      writeGranted: token.write_granted,
      signal: controller.signal,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    setTaskState(task, controller.signal.aborted ? "canceled" : "failed", agentMessage(error));
    upsertA2aTask(home, task);
    runningTasks.delete(`${home}:${task.id}`);
    recordA2aEvent(home, "a2a_task_finished", { task: task.id, state: task.status.state, text_chars: 0, spent_usd: null });
    return task;
  } finally {
    runningTasks.delete(`${home}:${task.id}`);
  }
  const finalText = result.text || "";
  task.history.push(agentMessage(finalText));
  const artifact: A2aArtifact = {
    artifactId: `artifact-${randomBytes(4).toString("hex")}`,
    name: "result",
    parts: [{ kind: "text", text: truncateText(finalText, A2A_MAX_TEXT_CHARS) }],
  };
  task.artifacts.push(artifact);
  setTaskState(task, controller.signal.aborted ? "canceled" : "completed");
  upsertA2aTask(home, task);
  if (ctx.sink) {
    ctx.sink(sseLine({ jsonrpc: "2.0", result: artifactUpdateEvent(task, artifact, task.artifacts.length - 1, true) }));
    ctx.sink(sseLine({ jsonrpc: "2.0", result: statusUpdateEvent(task) }));
  }
  recordA2aEvent(home, "a2a_task_finished", {
    task: task.id,
    state: task.status.state,
    text_chars: result.textChars,
    spent_usd: result.spentUsd,
  });
  return task;
}

export async function dispatchA2aRpc(
  home: string,
  request: unknown,
  ctx: A2aRpcContext,
): Promise<Record<string, unknown> | null> {
  if (!isPlainObject(request)) return rpcError(null, -32600, "请求须是 JSON 对象");
  const id = parseRpcId(request.id);
  const method = request.method;
  if (typeof method !== "string" || !method) return rpcError(id, -32600, "请求须带 method");
  if (request.jsonrpc !== "2.0") return rpcError(id, -32600, "jsonrpc 须为 \"2.0\"");
  const params = isPlainObject(request.params) ? request.params : {};
  try {
    switch (method) {
      case "agent/card": {
        const config = loadConfig(home);
        return rpcResult(id, buildA2aAgentCard(home, config as Record<string, unknown>, ctx.baseUrl));
      }
      case "message/send":
      case "message/stream": {
        if (!ctx.token) return rpcError(id, -32000, "缺少有效的 Bearer token（先跑 nyra a2a serve token new 建一个）");
        const message = params.message;
        let text = extractA2aMessageText(message);
        checkA2aConfiguration(params);
        const historyLength = historyLengthParam(params);
        // v1.0 的 taskId/contextId 在 message 对象上；老版 v0.3 的
        // 放在 params 里，两种都认，message 优先。
        const msgObj = isPlainObject(message) ? message : {};
        const rawTaskId = typeof msgObj.taskId === "string" && msgObj.taskId
          ? msgObj.taskId
          : typeof params.taskId === "string" && params.taskId ? params.taskId : null;
        const rawContextId = typeof msgObj.contextId === "string" ? msgObj.contextId : null;
        // G-P2-1：对端发来的消息是总线上的 send 消息，先过拦截器再建任务。
        // 丢弃直接回 JSON-RPC 错误（不建任务、不跑模型）；改写用改写后的文本继续。
        const intercepted = await applyInterventions(home, {
          id: newBusMessageId(), bus: "a2a",
          ...(rawContextId && rawContextId.trim() ? { room: rawContextId.trim() } : {}),
          sender: `a2a:${ctx.token.name}`, senderKind: "peer", kind: "send", text,
        }, {
          emit: (type, fields) => { recordA2aEvent(home, type, fields); },
        });
        if (intercepted.verdict === "drop") {
          return rpcError(id, -32000, `消息被拦截器丢弃（规则 ${intercepted.matched.join("、")}）`);
        }
        if (intercepted.verdict === "rewrite") text = intercepted.text;
        let task: A2aTask;
        if (rawTaskId) {
          const existing = getA2aTask(home, rawTaskId);
          if (!existing) throw new A2aError(-32001, `任务不存在：${rawTaskId}`);
          if (runningTasks.has(`${home}:${rawTaskId}`)) {
            throw new A2aError(-32600, `任务 ${rawTaskId} 正在跑（上一轮还没结束）`);
          }
          task = existing;
        } else {
          task = newA2aTask(rawContextId && rawContextId.trim() ? rawContextId.trim() : newContextId());
          upsertA2aTask(home, task);
        }
        const userMessage: A2aMessage = {
          role: "user",
          messageId: typeof message === "object" && message !== null && typeof (message as Record<string, unknown>).messageId === "string"
            ? (message as Record<string, unknown>).messageId as string
            : newMessageId(),
          parts: [{ kind: "text", text }],
        };
        task.history.push(userMessage);
        upsertA2aTask(home, task);
        if (method === "message/stream") {
          if (!ctx.sink) throw new A2aError(-32602, "message/stream 须走 SSE（HTTP 流式端点）");
          ctx.sink(sseLine({ jsonrpc: "2.0", result: statusUpdateEvent(task) }));
          const finished = await runA2aTask(home, task, text, ctx.token, ctx);
          ctx.sink(sseLine({ jsonrpc: "2.0", id, result: publicA2aTask(finished, historyLength) }));
          return null;
        }
        const finished = await runA2aTask(home, task, text, ctx.token, ctx);
        return rpcResult(id, publicA2aTask(finished, historyLength));
      }
      case "tasks/get": {
        if (!ctx.token) return rpcError(id, -32000, "缺少有效的 Bearer token（先跑 nyra a2a serve token new 建一个）");
        const taskId = params.id;
        if (typeof taskId !== "string" || !taskId) throw new A2aError(-32602, "tasks/get 须带 id");
        const task = getA2aTask(home, taskId);
        if (!task) throw new A2aError(-32001, `任务不存在：${taskId}`);
        return rpcResult(id, publicA2aTask(task, historyLengthParam(params)));
      }
      case "tasks/cancel": {
        if (!ctx.token) return rpcError(id, -32000, "缺少有效的 Bearer token（先跑 nyra a2a serve token new 建一个）");
        const taskId = params.id;
        if (typeof taskId !== "string" || !taskId) throw new A2aError(-32602, "tasks/cancel 须带 id");
        const task = getA2aTask(home, taskId);
        if (!task) throw new A2aError(-32001, `任务不存在：${taskId}`);
        if (A2A_TERMINAL_STATES.includes(task.status.state)) {
          throw new A2aError(-32002, `任务 ${taskId} 已是终态 ${task.status.state}，不可取消`);
        }
        const controller = runningTasks.get(`${home}:${taskId}`);
        if (controller) controller.abort();
        setTaskState(task, "canceled");
        upsertA2aTask(home, task);
        recordA2aEvent(home, "a2a_task_cancelled", { task: task.id });
        return rpcResult(id, publicA2aTask(task));
      }
      case "tasks/list": {
        if (!ctx.token) return rpcError(id, -32000, "缺少有效的 Bearer token（先跑 nyra a2a serve token new 建一个）");
        const contextId = typeof params.contextId === "string" && params.contextId ? params.contextId : null;
        let pageSize = 20;
        if (params.pageSize !== undefined && params.pageSize !== null) {
          if (typeof params.pageSize !== "number" || !Number.isInteger(params.pageSize) || params.pageSize < 1) {
            throw new A2aError(-32602, "pageSize 须是正整数");
          }
          pageSize = Math.min(params.pageSize, 100);
        }
        // v1.0 游标分页：cursor 是 base64url 的偏移量（在“最新在前”
        // 的列表里的位置），不带 cursor 从头开始；还有下一页时回
        // nextCursor，没了不带。老版只传 pageSize 的调法照样能用。
        let offset = 0;
        if (typeof params.cursor === "string" && params.cursor) {
          try {
            const decoded = Buffer.from(params.cursor, "base64url").toString("utf-8");
            offset = Number.parseInt(decoded, 10);
          } catch {
            throw new A2aError(-32602, "cursor 不是合法的游标");
          }
          if (!Number.isInteger(offset) || offset < 0) throw new A2aError(-32602, "cursor 不是合法的游标");
        }
        let tasks = loadA2aTasks(home);
        if (contextId) tasks = tasks.filter((t) => t.contextId === contextId);
        const ordered = tasks.slice().reverse();
        const page = ordered.slice(offset, offset + pageSize);
        const historyLength = historyLengthParam(params);
        const out: Record<string, unknown> = { tasks: page.map((t) => publicA2aTask(t, historyLength)) };
        if (offset + pageSize < ordered.length) {
          out.nextCursor = Buffer.from(String(offset + pageSize), "utf-8").toString("base64url");
        }
        return rpcResult(id, out);
      }
      case "tasks/resubscribe": {
        if (!ctx.token) return rpcError(id, -32000, "缺少有效的 Bearer token（先跑 nyra a2a serve token new 建一个）");
        const taskId = params.id;
        if (typeof taskId !== "string" || !taskId) throw new A2aError(-32602, "tasks/resubscribe 须带 id");
        const task = getA2aTask(home, taskId);
        if (!task) throw new A2aError(-32001, `任务不存在：${taskId}`);
        if (!ctx.sink) throw new A2aError(-32602, "tasks/resubscribe 须走 SSE（HTTP 流式端点）");
        const sink = ctx.sink;
        for (const entry of task.statusHistory) {
          sink(sseLine({
            jsonrpc: "2.0",
            result: {
              taskStatusUpdate: {
                taskId: task.id,
                contextId: task.contextId,
                status: { state: V1_TASK_STATE[entry.state], timestamp: entry.timestamp },
              },
            },
          }));
        }
        task.artifacts.forEach((artifact, idx) => {
          sink(sseLine({ jsonrpc: "2.0", result: artifactUpdateEvent(task, artifact, idx, true) }));
        });
        sink(sseLine({ jsonrpc: "2.0", id, result: publicA2aTask(task) }));
        return null;
      }
      default:
        return rpcError(id, -32601, `未知方法 ${method}`);
    }
  } catch (err) {
    if (err instanceof A2aError) return rpcError(id, err.code, err.message);
    return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// HTTP 层：node:http（与 AG-UI 服务端同款），只在 serve start 跑着时存在
// ---------------------------------------------------------------------------

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice("bearer ".length).trim();
  return "";
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > A2A_SERVER_MAX_BODY_CHARS) {
        reject(new A2aError(-32602, `请求体超过 ${A2A_SERVER_MAX_BODY_CHARS} 字`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", (err) => reject(err));
  });
}

/**
 * 处理一次 A2A 服务端 HTTP 请求（供 startA2aServer 与测试共用）：
 * - GET /.well-known/agent-card.json（v1.0 标准路径）与
 *   /.well-known/agent.json（老路径，同内容）：名片（不鉴权，公开契约；
 *   服务端只在显式启用 + 前台跑着时才存在）；
 * - POST /：JSON-RPC 2.0；agent/card 不鉴权，其余方法须 Bearer token
 *   （无 token 401、错 token 403，包在 JSON-RPC 错误信封里）；
 * - message/stream 与 tasks/resubscribe 走 SSE；
 * - 其他：一律 404（不泄露端点细节）。
 */
export async function handleA2aRequest(
  home: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps?: A2aServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const baseUrl = deps?.baseUrl ?? a2aBaseUrl(home);
  if (req.method === "GET" && (url.pathname === "/.well-known/agent.json" || url.pathname === "/.well-known/agent-card.json")) {
    try {
      const config = loadConfig(home);
      sendJson(res, 200, buildA2aAgentCard(home, config as Record<string, unknown>, baseUrl));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (url.pathname !== "/") {
    sendJson(res, 404, { ok: false, error: "未找到" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "A2A 服务端只接受 GET（名片）与 POST（JSON-RPC）" });
    return;
  }
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    sendJson(res, 400, rpcError(null, -32602, err instanceof Error ? err.message : String(err)));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "请求体不是合法 JSON"));
    return;
  }
  const presented = bearerToken(req);
  const method = isPlainObject(body) ? body.method : undefined;
  // agent/card 是公开发现，不鉴权；其余方法须 token。
  const token = method === "agent/card" ? null : verifyA2aServerToken(home, presented);
  const bodyId = isPlainObject(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
  if (method !== "agent/card" && !token) {
    sendJson(res, presented ? 403 : 401, rpcError(bodyId, -32000, presented ? "token 无效" : "缺少 Bearer token（先跑 nyra a2a serve token new 建一个）"));
    return;
  }
  const isStream = method === "message/stream" || method === "tasks/resubscribe";
  if (isStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const sink: A2aRpcSink = (line) => {
      try {
        res.write(line);
      } catch { /* 客户端断了就停写，任务照跑完记账 */ }
    };
    try {
      await dispatchA2aRpc(home, body, { token, baseUrl, deps, sink });
    } catch (err) {
      try {
        res.write(sseLine(rpcError(null, -32603, err instanceof Error ? err.message : String(err))));
      } catch { /* ignore */ }
    } finally {
      try { res.end(); } catch { /* ignore */ }
    }
    return;
  }
  try {
    const response = await dispatchA2aRpc(home, body, { token, baseUrl, deps });
    sendJson(res, 200, response ?? rpcError(null, -32603, "空响应"));
  } catch (err) {
    sendJson(res, 500, rpcError(bodyId, -32603, err instanceof Error ? err.message : String(err)));
  }
}

export interface A2aServerHandle {
  server: Server;
  host: string;
  port: number;
  closed: Promise<void>;
}

/**
 * 启动 A2A 服务端（前台：调用方 await closed 直到进程被停）。
 * 默认关闭时拒绝启动（先跑 nyra a2a serve enable）。
 */
export async function startA2aServer(
  home: string,
  opts?: { host?: string; port?: number; deps?: A2aServerDeps },
): Promise<A2aServerHandle> {
  const config = loadA2aServerConfig(home);
  if (!config.enabled) {
    throw new A2aError(-32603, "A2A 服务端没启用：先跑 nyra a2a serve enable（默认关闭，只在你显式启用后才监听）");
  }
  const host = opts?.host ?? config.host;
  const port = opts?.port ?? config.port;
  if (!Number.isInteger(port) || port < 0 || port >= 65536) throw new A2aError(-32603, `端口不对：${port}（须是 0–65535 的整数，0 表示系统分配临时端口）`);
  // 真实绑定端口在 listen 之后才知道：请求处理时现算 baseUrl，名片里
  // 的 url 才是调用方真正能连上的地址（port 0 时配置里的 8767 是错的）。
  let boundPort = port;
  const server = createServer((req, res) => {
    const baseUrl = `http://${host}:${boundPort}`;
    void handleA2aRequest(home, req, res, { ...opts?.deps, baseUrl }).catch((err) => {
      try {
        if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, err instanceof Error ? err.message : String(err)));
        else res.end();
      } catch { /* ignore */ }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  // port 传 0 时系统分配临时端口：返回真实绑定的端口，别返回 0。
  const addr = server.address();
  boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
  recordA2aEvent(home, "a2a_server_started", { host, port: boundPort });
  return { server, host, port: boundPort, closed };
}
