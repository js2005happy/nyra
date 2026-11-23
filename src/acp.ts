// src/acp.ts — G-P1-20 ACP 协议（Agent Client Protocol v1，另一半）：
// Nyra 对外暴露成 ACP agent（stdio 上讲 JSON-RPC 2.0），编辑器 / 别的
// 客户端能直接驱动 Nyra。AG-UI 服务端（缺口 47 第二批）走 HTTP+SSE，
// ACP 走 stdio NDJSON；两者共用同一套治理：对方消息先过注入扫描、
// 运行一律 origin "peer"、写操作进 peer 提议门、成本硬顶照常、不自动换模型。
//
// 协议依据：agentclientprotocol.com/protocol/v1（2026-11-23 核对，
// protocolVersion 1 稳定版；v2 是 Preview，不混进 v1 会话）。
//   - 握手：initialize（版本协商 + 能力 + authMethods）→ authenticate
//     （Nyra 不需要认证，authMethods 为空，调了就报 -32602）。
//   - 会话：session/new（回 sessionId + modes）/ session/load（回放
//     user/assistant 文本）/ session/close（幂等空结果）/ session/cancel
//     （通知）/ $/cancel_request（按请求 id 取消）/ session/set_mode。
//   - 一轮：session/prompt → 流 session/update（agent_message_chunk /
//     tool_call / tool_call_update / usage_update / current_mode_update）
//     → 回 stopReason（end_turn / cancelled / refusal）。
//   - 错误码：JSON-RPC 标准码 + -32002（未知会话，session/close 按规
//     范把它当成功处理）。
//
// 本批不做：A2A 服务端（另排）；session/resume、session/list、
// session/delete、session/set_model、session/set_config_option（调了报
// -32601 方法未实现）；出站请求 session/request_permission（写操作走
// peer 提议门，不向客户端实时要批）、fs/* 与 terminal/* 客户端方法
// （Nyra 内置文件工具直接走本地文件系统，不经过客户端）；
// available_commands_update 与 plan 更新（Nyra 没有 ACP 意义上的斜杠
// 命令与计划结构可发）；MCP 服务器由客户端指定（session/new 里非空
// mcpServers 直接 -32602 拒绝，Nyra 用自己的 MCP 配置）。
//
// 诚实边界：只在临时 home / 假 provider / 假客户端上验过；真编辑器
// （Zed / JetBrains 等）未接通过；stdio 流上 stdout 只走协议行，
// 日志一律写 stderr。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { loadSession, resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { isSuspiciousSegment, suspiciousLabels } from "./untrusted.ts";
import { loadConfig, resolveProvider, VERSION } from "./config.ts";
import { Provider } from "./providers.ts";
import { Agent } from "./agent.ts";
import { READONLY_TOOLS, TOOL_SCHEMAS } from "./tools.ts";
import { resolveMonthlyLimit, resolvePricing } from "./cost.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_AGENT_NAME = "nyra";
export const ACP_CONFIG_FILE = "acp-server.json";
export const ACP_MAX_PROMPT_CHARS = 200_000;
export const ACP_MAX_LINE_CHARS = 1_000_000;
export const ACP_TOOL_RESULT_CHARS = 4000;

export type AcpModeId = "default" | "readonly";
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export const ACP_MODES: { modeId: AcpModeId; name: string; description: string }[] = [
  { modeId: "default", name: "Default", description: "完整工具：只读直接执行，写操作记 peer 提议、须机主逐条批（写工具可见须先跑 nyra acp grant --yes）。" },
  { modeId: "readonly", name: "Read-only", description: "只读：写工具直接从工具表里拿掉，模型连提议都提不出来。" },
];

export class AcpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "AcpError";
    this.code = code;
  }
}

export type JsonRpcId = string | number;

export type AcpSink = (params: Record<string, unknown>) => void;

export interface AcpServerConfig {
  version: 1;
  /** 写工具可见开关（默认关）：关了 default 模式也看不到写工具；开了写调用只记提议、不执行。 */
  writeEnabled: boolean;
  defaultMode: AcpModeId;
}

export interface AcpSessionRecord {
  id: string;
  cwd: string;
  modeId: AcpModeId;
  createdAt: string;
  transcript: { role: "user" | "assistant"; content: string }[];
  running: boolean;
  cancel: AbortController | null;
  pendingPromptId: JsonRpcId | null;
}

export interface AcpRunResult {
  sessionId: string;
  stopReason: AcpStopReason;
  text: string;
  textChars: number;
  toolCalls: { id: string; name: string; args: string }[];
  proposals: { proposalId: string; tool: string }[];
  spentUsd: number | null;
  usage: { totalTokens: number; contextWindow: number; spentUsd: number | null } | null;
  error: string;
}

/** Agent 执行层注入点：测试用假 runner，不花真模型钱。 */
export interface AcpServerDeps {
  agentRunner?: (
    home: string,
    task: string,
    opts: { sessionId: string; cwd: string; modeId: AcpModeId; writeEnabled: boolean; signal: AbortSignal; sink: AcpSink },
  ) => Promise<AcpRunResult>;
}

function serverPath(home: string): string {
  return join(home, ACP_CONFIG_FILE);
}

function ensureHomeDir(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(home, 0o700); } catch { /* ignore */ }
  }
  return home;
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

function newSessionId(): string {
  return `acp-${randomBytes(6).toString("hex")}`;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…（已截断）" : text;
}

/** 读 ACP 服务端配置：没有返回默认（写开关关、默认 default 模式）。 */
export function loadAcpServerConfig(home: string): AcpServerConfig {
  const path = serverPath(home);
  if (!existsSync(path)) {
    return { version: 1, writeEnabled: false, defaultMode: "default" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new AcpError(-32603, `${ACP_CONFIG_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new AcpError(-32603, `${ACP_CONFIG_FILE} 结构不对（须是 JSON 对象）`);
  }
  const defaultMode = parsed.defaultMode === "readonly" ? "readonly" : "default";
  return { version: 1, writeEnabled: parsed.writeEnabled === true, defaultMode };
}

export function saveAcpServerConfig(home: string, config: AcpServerConfig): void {
  writeJsonAtomic(home, ACP_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/** 机主显式开写工具可见性（须 CLI 加 --yes；只放行“提议”，执行仍逐条批）。 */
export function setAcpWriteEnabled(home: string, enabled: boolean): AcpServerConfig {
  const config = loadAcpServerConfig(home);
  config.writeEnabled = enabled;
  saveAcpServerConfig(home, config);
  return config;
}

/** 写工具可见性：readonly 模式恒藏；default 模式看写开关。 */
export function acpDisabledTools(writeEnabled: boolean, modeId: AcpModeId): string[] {
  if (modeId === "readonly" || !writeEnabled) {
    const disabled: string[] = [];
    for (const s of TOOL_SCHEMAS) {
      const name = (s.function as Record<string, unknown>).name as string;
      if (!READONLY_TOOLS.has(name)) disabled.push(name);
    }
    return disabled;
  }
  return [];
}

/** 工具名 → ACP ToolCallKind（查不到的按 other，不编造语义）。 */
export function acpToolKind(name: string): string {
  if (name === "write_file" || name === "edit_file" || name === "apply_patch" || name === "delete_file" || name === "move_file" ||
    name === "memory_append" || name === "memory_delete" || name === "memory_forget" || name === "save_skill") return "edit";
  if (name === "shell" || name === "run_command") return "execute";
  if (name === "web_fetch" || name === "web_search") return "fetch";
  if (name.includes("search") || name.startsWith("lsp_")) return "search";
  if (name.includes("read") || name === "list_dir" || name === "read_skill" || name === "editor_context" ||
    name === "git_status" || name === "describe_image") return "read";
  if (name === "plan") return "think";
  return "other";
}

/** initialize 响应：版本协商（只支持 1）+ 能力 + 空 authMethods。 */
export function acpInitializeResponse(clientVersion: unknown): Record<string, unknown> {
  void clientVersion;
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { close: {} },
    },
    agentInfo: { name: ACP_AGENT_NAME, title: "Nyra", version: VERSION },
    authMethods: [],
  };
}

export function acpModesState(modeId: AcpModeId): Record<string, unknown> {
  return {
    currentModeId: modeId,
    availableModes: ACP_MODES.map((m) => ({ modeId: m.modeId, name: m.name, description: m.description })),
  };
}

/**
 * session/prompt 的 prompt 块抽文本：text 直接拼；resource_link 拼成
 * 一行链接；带 text 的 resource 用它的 text；image/audio 与不带 text
 * 的 resource 直接 -32602（能力里没广告，收了就是失信）。
 */
export function extractAcpPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) throw new AcpError(-32602, "prompt 须是内容块数组");
  const parts: string[] = [];
  for (const block of prompt) {
    if (!isPlainObject(block) || typeof block.type !== "string") {
      throw new AcpError(-32602, "prompt 里的内容块须是带 type 的对象");
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new AcpError(-32602, "text 内容块须带 text 字符串");
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      if (typeof block.uri !== "string" || !block.uri) throw new AcpError(-32602, "resource_link 内容块须带 uri");
      const name = typeof block.name === "string" && block.name ? block.name : block.uri;
      parts.push(`[链接：${name}](${block.uri})`);
    } else if (block.type === "resource") {
      const resource = isPlainObject(block.resource) ? block.resource : null;
      if (resource && typeof resource.text === "string" && resource.text) {
        parts.push(resource.text);
      } else {
        throw new AcpError(-32602, "resource 内容块须带 text（Nyra 只支持文本与链接块）");
      }
    } else {
      throw new AcpError(-32602, `不支持的内容块类型 ${block.type}（Nyra 只支持 text 与 resource_link）`);
    }
  }
  const text = parts.join("\n").trim();
  if (!text) throw new AcpError(-32602, "prompt 为空（至少须有一块非空文本）");
  if (text.length > ACP_MAX_PROMPT_CHARS) throw new AcpError(-32602, `prompt 最多 ${ACP_MAX_PROMPT_CHARS} 字`);
  return text;
}

/** cwd 校验：须是绝对路径、须存在、须是目录（fail-closed）。 */
export function checkAcpCwd(cwd: unknown): string {
  if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) {
    throw new AcpError(-32602, "cwd 须是绝对路径");
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(cwd);
  } catch {
    throw new AcpError(-32602, `cwd 不存在：${cwd}`);
  }
  if (!st.isDirectory()) throw new AcpError(-32602, `cwd 不是目录：${cwd}`);
  return cwd;
}

/** mcpServers：只接受空数组；非空直接拒绝（不假装接了）。 */
export function checkAcpMcpServers(mcpServers: unknown): void {
  if (mcpServers === undefined || mcpServers === null) return;
  if (Array.isArray(mcpServers) && mcpServers.length === 0) return;
  throw new AcpError(-32602, "Nyra ACP 本批不接客户端指定的 MCP 服务器（用 Nyra 自己的 MCP 配置）");
}

/** systemPrompt / additionalDirectories：没广告，收了直接拒绝。 */
export function checkAcpUnsupportedFields(params: Record<string, unknown>): void {
  if (params.systemPrompt !== undefined && params.systemPrompt !== null) {
    throw new AcpError(-32602, "Nyra ACP 本批不支持 systemPrompt");
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories !== null) {
    throw new AcpError(-32602, "Nyra ACP 本批不支持 additionalDirectories");
  }
}

/**
 * Agent 事件 → ACP session/update：assistant/final → agent_message_chunk；
 * tool_start → tool_call；tool_result → tool_call_update（completed/failed）；
 * peer_proposal_recorded → 该工具的调用改 cancelled（只记提议、不执行）；
 * usage → 记下最近一次快照（turn 结束统一发 usage_update）。
 * tool_span / llm_span / cost_update 走 telemetry，不重复发。
 */
export function createAcpEventMapper(opts: { sessionId: string; sink: AcpSink }): {
  onEvent: (kind: string, data: Record<string, unknown>) => void;
  toolCalls: { id: string; name: string; args: string }[];
  proposals: { proposalId: string; tool: string }[];
  textChars: number;
  lastUsage: { totalTokens: number | null; contextWindow: number | null } | null;
} {
  const openCalls = new Map<string, string>();
  const toolCalls: { id: string; name: string; args: string }[] = [];
  const proposals: { proposalId: string; tool: string }[] = [];
  let textChars = 0;
  let callSeq = 0;
  let lastUsage: { totalTokens: number | null; contextWindow: number | null } | null = null;

  function update(update: Record<string, unknown>): void {
    opts.sink({ sessionId: opts.sessionId, update });
  }

  function onEvent(kind: string, data: Record<string, unknown>): void {
    if ((kind === "assistant" || kind === "final") && typeof data.content === "string" && data.content) {
      textChars += data.content.length;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.content } });
    } else if (kind === "tool_start") {
      const name = typeof data.name === "string" ? data.name : "unknown";
      const id = typeof data.id === "string" && data.id ? data.id : `call-${++callSeq}`;
      const args = typeof data.arguments === "string"
        ? data.arguments
        : JSON.stringify(data.arguments ?? {});
      openCalls.set(id, name);
      toolCalls.push({ id, name, args });
      update({
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: name,
        kind: acpToolKind(name),
        status: "pending",
        rawInput: args,
      });
    } else if (kind === "tool_result") {
      const id = typeof data.id === "string" ? data.id : "";
      if (!id || !openCalls.has(id)) return;
      openCalls.delete(id);
      const result = typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? "");
      const ok = !result.startsWith("错误：");
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: ok ? "completed" : "failed",
        content: [{ type: "text", text: truncateText(result, ACP_TOOL_RESULT_CHARS) }],
      });
    } else if (kind === "peer_proposal_recorded") {
      const proposalId = typeof data.proposal_id === "string" ? data.proposal_id : "";
      const tool = typeof data.tool === "string" ? data.tool : "";
      if (proposalId) proposals.push({ proposalId, tool });
      // 写调用被提案门拦下：把那一笔调用改成 cancelled，告诉客户端没执行。
      let openId: string | null = null;
      for (const [id, name] of [...openCalls.entries()].reverse()) {
        if (name === tool) { openId = id; break; }
      }
      if (openId) {
        openCalls.delete(openId);
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: openId,
          status: "cancelled",
          content: [{ type: "text", text: `已记为提议 ${proposalId}：写操作须机主在终端跑 nyra peer proposal accept ${proposalId} --yes 批准后才执行，本轮未执行。` }],
        });
      }
    } else if (kind === "usage") {
      const total = typeof data.total_tokens === "number" ? data.total_tokens : null;
      const size = typeof data.context_window_tokens === "number" ? data.context_window_tokens : null;
      lastUsage = { totalTokens: total, contextWindow: size };
    }
  }

  return {
    onEvent,
    toolCalls,
    proposals,
    get textChars() { return textChars; },
    get lastUsage() { return lastUsage; },
  };
}

/** ACP 服务端事件进证据链（只记元数据：会话、stopReason、字数、花费）。 */
function recordAcpEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`ACP 服务端：${type}`, "acp-server", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据链写失败不炸协议会话 */ }
}

/**
 * 真的跑一轮 Agent（origin "peer"，治理与 AG-UI 服务端看齐：注入扫描
 * 在 prompt 入口做，写操作进 peer 提议门，成本硬顶照常，不自动换模型）。
 */
export async function runAcpAgent(
  home: string,
  task: string,
  opts: { sessionId: string; cwd: string; modeId: AcpModeId; writeEnabled: boolean; signal: AbortSignal; sink: AcpSink },
): Promise<AcpRunResult> {
  const config = loadConfig(home);
  const provider = new Provider(resolveProvider({ home, config }));
  if (!provider.hasCredentials()) {
    throw new AcpError(-32603, "ACP 服务端没配模型凭据：先在 Nyra 里配好模型再连编辑器");
  }
  const localSessionId = `acp-${opts.sessionId}`;
  const mapper = createAcpEventMapper({ sessionId: opts.sessionId, sink: opts.sink });
  const pricing = resolvePricing(config.pricing, provider.model ?? null);
  const monthlyLimit = resolveMonthlyLimit(config, null);
  const agent = new Agent(provider, {
    workdir: opts.cwd,
    mode: "auto",
    maxTurns: 20,
    sessionId: localSessionId,
    interactive: false,
    home,
    origin: "peer",
    peerName: "acp",
    messages: loadSession(localSessionId, home),
    disabledTools: acpDisabledTools(opts.writeEnabled, opts.modeId),
    onEvent: mapper.onEvent,
    cancelSignal: opts.signal,
    // 成本硬顶（AG-UI 服务端同款口径：单次上限 + 月度上限 + 已花）：超支停下，不编 0。
    maxCostUsd: typeof config.max_cost_usd === "number" ? (config.max_cost_usd as number) : null,
    pricing,
    monthlyCostLimitUsd: monthlyLimit,
    monthlySpentBeforeUsd: monthlyLimit === null ? null : (): { spentUsd: number; incomplete: boolean } | null => {
      try {
        const llm = new UsageLedger(home).monthTotal(monthKeyString());
        const mcp = new McpCostTracker(home).monthTotalUsd(monthKeyString());
        return { spentUsd: llm.spentUsd + mcp, incomplete: llm.incomplete };
      } catch {
        return null;
      }
    },
  });
  const text = await agent.run(task);
  const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
  const usage = mapper.lastUsage;
  const usageOut = usage && usage.totalTokens != null && usage.contextWindow != null
    ? { totalTokens: usage.totalTokens, contextWindow: usage.contextWindow, spentUsd: spent }
    : null;
  return {
    sessionId: opts.sessionId,
    stopReason: "end_turn",
    text,
    textChars: mapper.textChars,
    toolCalls: mapper.toolCalls,
    proposals: mapper.proposals,
    spentUsd: spent,
    usage: usageOut,
    error: "",
  };
}

/** ACP 会话管理器 + JSON-RPC 2.0 分发（stdio NDJSON：stdout 只走协议行）。 */
export class AcpServer {
  private home: string;
  private emit: (line: string) => void;
  private deps: AcpServerDeps;
  private initialized = false;
  private sessions = new Map<string, AcpSessionRecord>();
  private turns = new Set<Promise<void>>();

  constructor(home: string, opts: { emit: (line: string) => void; deps?: AcpServerDeps }) {
    this.home = home;
    this.emit = opts.emit;
    this.deps = opts.deps ?? {};
  }

  /** 等所有在跑的一轮结束（测试用；生产上 stdin 关了进程就退，不等）。 */
  async drain(): Promise<void> {
    await Promise.all([...this.turns]);
  }

  private emitLine(payload: Record<string, unknown>): void {
    this.emit(JSON.stringify(payload));
  }

  private emitResponse(id: JsonRpcId, result: Record<string, unknown>): void {
    this.emitLine({ jsonrpc: "2.0", id, result });
  }

  private emitError(id: JsonRpcId | null, code: number, message: string): void {
    this.emitLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private emitUpdate(params: Record<string, unknown>): void {
    this.emitLine({ jsonrpc: "2.0", method: "session/update", params });
  }

  private abortSession(record: AcpSessionRecord): void {
    record.cancel?.abort();
  }

  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (line.length > ACP_MAX_LINE_CHARS) {
      this.emitError(null, -32700, `单行超过 ${ACP_MAX_LINE_CHARS} 字`);
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emitError(null, -32700, "JSON 解析失败");
      return;
    }
    if (!isPlainObject(msg)) return;
    const rawId = (msg as Record<string, unknown>).id;
    const hasId = rawId !== undefined && (typeof rawId === "string" || typeof rawId === "number");
    const id = hasId ? rawId as JsonRpcId : null;
    const method = (msg as Record<string, unknown>).method;
    if (typeof method !== "string" || !method) {
      if (hasId) this.emitError(id, -32600, "请求须带 method");
      return;
    }
    if ((msg as Record<string, unknown>).jsonrpc !== "2.0") {
      if (hasId) this.emitError(id, -32600, "jsonrpc 须为 \"2.0\"");
      return;
    }
    const params = isPlainObject((msg as Record<string, unknown>).params)
      ? (msg as Record<string, unknown>).params as Record<string, unknown>
      : {};
    try {
      if (method === "initialize") {
        if (hasId) {
          this.initialized = true;
          this.emitResponse(id as JsonRpcId, acpInitializeResponse(params.protocolVersion));
        }
        return;
      }
      if (method === "authenticate") {
        if (hasId) this.emitError(id as JsonRpcId, -32602, "Nyra ACP 不需要认证（authMethods 为空）");
        return;
      }
      if (method === "session/cancel") {
        const sid = typeof params.sessionId === "string" ? params.sessionId : "";
        const record = this.sessions.get(sid);
        if (record) this.abortSession(record);
        return;
      }
      if (method === "$/cancel_request") {
        const target = params.id;
        for (const record of this.sessions.values()) {
          if (record.pendingPromptId !== null && record.pendingPromptId === target) {
            this.abortSession(record);
          }
        }
        return;
      }
      if (!this.initialized && method.startsWith("session/")) {
        if (hasId) this.emitError(id as JsonRpcId, -32600, "须先 initialize");
        return;
      }
      switch (method) {
        case "session/new": {
          if (!hasId) return;
          const cwd = checkAcpCwd(params.cwd);
          checkAcpMcpServers(params.mcpServers);
          checkAcpUnsupportedFields(params);
          const config = loadAcpServerConfig(this.home);
          const record: AcpSessionRecord = {
            id: newSessionId(),
            cwd,
            modeId: config.defaultMode,
            createdAt: nowIso(),
            transcript: [],
            running: false,
            cancel: null,
            pendingPromptId: null,
          };
          this.sessions.set(record.id, record);
          recordAcpEvent(this.home, "acp_session_created", { session: record.id });
          this.emitResponse(id as JsonRpcId, { sessionId: record.id, modes: acpModesState(record.modeId) });
          return;
        }
        case "session/load": {
          if (!hasId) return;
          const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
          if (!sessionId) throw new AcpError(-32602, "session/load 须带 sessionId");
          const cwd = checkAcpCwd(params.cwd);
          checkAcpMcpServers(params.mcpServers);
          checkAcpUnsupportedFields(params);
          let record = this.sessions.get(sessionId);
          if (record) {
            if (record.cwd !== cwd) throw new AcpError(-32602, "cwd 与建会话时不一致");
          } else {
            // 进程重启后：从落盘会话重建（Agent 每轮都会 saveSession）。
            const saved = loadSession(`acp-${sessionId}`, this.home);
            if (!saved) throw new AcpError(-32002, `未知会话 ${sessionId}`);
            const config = loadAcpServerConfig(this.home);
            record = {
              id: sessionId,
              cwd,
              modeId: config.defaultMode,
              createdAt: nowIso(),
              transcript: saved
                .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
                .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string })),
              running: false,
              cancel: null,
              pendingPromptId: null,
            };
            this.sessions.set(record.id, record);
          }
          recordAcpEvent(this.home, "acp_session_loaded", { session: record.id });
          for (const entry of record.transcript) {
            this.emitUpdate({
              sessionId: record.id,
              update: {
                sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                content: { type: "text", text: entry.content },
              },
            });
          }
          this.emitResponse(id as JsonRpcId, { sessionId: record.id, modes: acpModesState(record.modeId) });
          return;
        }
        case "session/prompt": {
          if (!hasId) return;
          const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
          const record = this.sessions.get(sessionId);
          if (!record) throw new AcpError(-32002, `未知会话 ${sessionId}`);
          if (record.running) throw new AcpError(-32600, "会话正忙（上一轮还没跑完）");
          const text = extractAcpPromptText(params.prompt);
          // 注入扫描：对方消息先审，命中直接 refusal，不进模型。
          if (isSuspiciousSegment(text)) {
            const labels = suspiciousLabels(text).join("、");
            const reason = `这段输入命中注入扫描（${labels}），Nyra 按 peer 来源 fail-closed 拒绝执行。`;
            record.transcript.push({ role: "user", content: text });
            record.transcript.push({ role: "assistant", content: reason });
            recordAcpEvent(this.home, "acp_blocked", { session: record.id, labels });
            this.emitUpdate({ sessionId: record.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reason } } });
            this.emitResponse(id as JsonRpcId, { stopReason: "refusal" });
            return;
          }
          record.running = true;
          record.pendingPromptId = id as JsonRpcId;
          record.cancel = new AbortController();
          this.startPromptTurn(id as JsonRpcId, record, text);
          return;
        }
        case "session/set_mode": {
          if (!hasId) return;
          const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
          const record = this.sessions.get(sessionId);
          if (!record) throw new AcpError(-32002, `未知会话 ${sessionId}`);
          const modeId = params.modeId;
          if (modeId !== "default" && modeId !== "readonly") {
            throw new AcpError(-32602, "modeId 只支持 default / readonly");
          }
          record.modeId = modeId;
          this.emitUpdate({ sessionId: record.id, update: { sessionUpdate: "current_mode_update", currentModeId: modeId } });
          this.emitResponse(id as JsonRpcId, {});
          return;
        }
        case "session/close": {
          if (!hasId) return;
          const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
          const record = this.sessions.get(sessionId);
          if (record) {
            if (record.running) this.abortSession(record);
            this.sessions.delete(sessionId);
          }
          // 规范：未知会话的 close 也算成功（-32002 当成功处理）。
          this.emitResponse(id as JsonRpcId, {});
          return;
        }
        case "session/resume":
        case "session/list":
        case "session/delete":
        case "session/set_model":
        case "session/set_config_option":
          if (hasId) this.emitError(id as JsonRpcId, -32601, `${method} 本批未实现`);
          return;
        default:
          if (hasId) this.emitError(id as JsonRpcId, -32601, `未知方法 ${method}`);
          return;
      }
    } catch (err) {
      if (!hasId) return;
      if (err instanceof AcpError) {
        this.emitError(id as JsonRpcId, err.code, err.message);
      } else {
        this.emitError(id as JsonRpcId, -32603, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private startPromptTurn(id: JsonRpcId, record: AcpSessionRecord, text: string): void {
    const controller = record.cancel ?? new AbortController();
    const turn = (async () => {
      try {
        const config = loadAcpServerConfig(this.home);
        const runner = this.deps.agentRunner ?? runAcpAgent;
        const result = await runner(this.home, text, {
          sessionId: record.id,
          cwd: record.cwd,
          modeId: record.modeId,
          writeEnabled: config.writeEnabled,
          signal: controller.signal,
          sink: (params) => this.emitUpdate(params),
        });
        record.transcript.push({ role: "user", content: text });
        if (result.text) record.transcript.push({ role: "assistant", content: result.text });
        // 假 runner / 非流式 runner 没发过文本块：补一块全文，避免客户端收不到回答。
        if (result.text && result.textChars === 0) {
          this.emitUpdate({ sessionId: record.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.text } } });
        }
        if (result.usage) {
          this.emitUpdate({
            sessionId: record.id,
            update: {
              sessionUpdate: "usage_update",
              used: result.usage.totalTokens,
              size: result.usage.contextWindow,
              ...(result.usage.spentUsd != null ? { cost: { amount: result.usage.spentUsd, currency: "USD" } } : {}),
            },
          });
        }
        const stopReason = controller.signal.aborted ? "cancelled" : result.stopReason;
        recordAcpEvent(this.home, "acp_prompt_finished", {
          session: record.id,
          stop_reason: stopReason,
          text_chars: result.textChars || result.text.length,
          spent_usd: result.spentUsd ?? 0,
        });
        this.emitResponse(id, { stopReason });
      } catch (err) {
        this.emitError(id, -32603, err instanceof Error ? err.message : String(err));
      } finally {
        record.running = false;
        record.pendingPromptId = null;
        record.cancel = null;
      }
    })();
    this.turns.add(turn);
    turn.finally(() => this.turns.delete(turn));
  }
}

/**
 * stdio 服务端主循环：stdin 读行 → handleLine → stdout 写协议行。
 * 日志一律走 stderr（stdout 混进一句日志都会把客户端的 JSON 解析炸掉）。
 * stdin 关闭即退出，未完成的一轮随进程结束（编辑器杀进程同理）。
 */
export async function serveAcpStdio(home: string, deps?: AcpServerDeps): Promise<number> {
  const { createInterface } = await import("node:readline");
  const server = new AcpServer(home, {
    emit: (line) => { process.stdout.write(line + "\n"); },
    deps,
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    await server.handleLine(line);
  }
  return 0;
}
