// src/aguiServer.ts — 缺口 47 第二批：协议中立接入层——Nyra 对外暴露为
// AG-UI endpoint（服务端）。第一批（src/agui.ts）只做了客户端：Nyra 去调
// 别人的 AG-UI endpoint；本批做另一半：别的 agent / 编辑器调 Nyra。
//
// 做兼容者，不另起协议：服务端发 AG-UI 协议的事件（RUN_STARTED、
// TEXT_MESSAGE_*、TOOL_CALL_*、RUN_FINISHED、RUN_ERROR），任何会讲 AG-UI
// 的客户端都能接；发现握手与第一批客户端的 handshakeAgui 同款 JSON，
// Nyra 自己的客户端也能连上另一台 Nyra。
//
// 安全口径（与第一批镜像，fail-closed）：
// - 默认关闭：`nyra agui serve enable` 之前 `serve start` 直接拒绝；
//   服务端只在前台命令跑着的时候才监听，停了就不存在，不留后台口子。
// - 默认只绑 127.0.0.1（回环）；--host 0.0.0.0 是操作者显式选择，
//   启动时打一句警告；默认端口 8766（网关是 8765，不抢）。
// - 鉴权：每条 token 只存 SHA-256 指纹（timingSafeEqual 比对），明文只
//   在 `serve token new` 时显示一次；run 请求须带 Authorization: Bearer，
//   无 token 401、错 token 403；发现握手（GET / 与 POST handshake）不鉴
//   权——它只报协议版本与能力名，不含任何数据。
// - 对方发来的任何内容都按不可信输入处理：先过缺口 10 的确定性注入扫描
//   （isSuspiciousSegment，与审查层同一套规则形状），可疑直接以 RUN_ERROR
//   拒掉进证据链，不执行、不进模型上下文。
// - 服务端运行一律以 origin "peer" 跑 Agent：只读工具正常执行，写工具
//   进第 2 批 G-P1-10 的 peer 提议门——只记提议（nyra peer proposal
//   accept <id> --yes 才能执行），本次不执行。token 的写授权（serve grant，
//   须 --yes）只决定模型看不看得到写工具：没授权时写工具直接从工具表里
//   拿掉（disabledTools），模型连提议都提不出来；有授权时才能提议，
//   执行仍须机主逐条批。——“写操作须机主显式接受”分两层：提议权与执行权，
//   本批只做到提议权，执行权走现成的 peer proposal 流程。
// - 成本硬顶照常：单次 max_cost_usd 走网关同款口径（resolvePricing），
//   超支时运行停下、不编 0。服务端不自动换模型（只用主
//   provider，不接 fallback 链；队列/定时任务里不自动换模型的规矩同样适用）。
// - 多轮：threadId 对应本地会话（agui-server-<thread>），同 thread 的后续
//   请求接着上轮上下文跑；state 字段本批只接受、不应用（回 STATE_SNAPSHOT
//   时只含 threadId 与 runId，不编造状态）。
//
// 本批不做：ACP 协议（G-P1-20 的另一半，另排）；A2A 服务端；MCP 工具
// 暴露给服务端运行（mcpManager 为 null，外部调用者调不到 MCP 工具）；
// 真 AG-UI 客户端联调（只在 Nyra 自己的客户端 + 假客户端上验过）；
// 服务端运行的独立审查模型（reviewerModel 不接——peer 提议门已在写操作
//   前面拦住，读操作不需要审查）。
//
// 诚实边界：只在临时 home / 本机回环 + 假客户端上验过；真 AG-UI 客户端
// （CopilotKit 等）未接通过；媒体面未加密，别当端到端加密用。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolveNyraHome, loadSession } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { isSuspiciousSegment, suspiciousLabels } from "./untrusted.ts";
import { AGUI_CLIENT_VERSION, AGUI_EVENT_TYPES, AGUI_MAX_MESSAGE_CHARS, AGUI_PROTOCOL, AguiError } from "./agui.ts";
import { loadConfig, resolveProvider } from "./config.ts";
import { Provider } from "./providers.ts";
import { Agent } from "./agent.ts";
import { READONLY_TOOLS, TOOL_SCHEMAS } from "./tools.ts";
import { resolvePricing } from "./cost.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { applyInterventions, newBusMessageId } from "./interventions.ts";

export const AGUI_SERVER_FILE = "agui-server.json";
export const AGUI_SERVER_DEFAULT_HOST = "127.0.0.1";
export const AGUI_SERVER_DEFAULT_PORT = 8766;
export const AGUI_SERVER_MAX_BODY_CHARS = 200_000;
export const AGUI_SERVER_TOKEN_PREFIX = "nyra-agui-";
export const AGUI_SERVER_TOKEN_ID_RE = /^tok_[0-9a-f]{8}$/;

export class AguiServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AguiServerError";
  }
}

export interface AguiServerToken {
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

export interface AguiServerConfig {
  version: 1;
  enabled: boolean;
  host: string;
  port: number;
  tokens: AguiServerToken[];
}

export interface AguiServerRunInput {
  threadId: string;
  runId: string;
  /** 本次任务：messages 里最后一条 user 消息的原文。 */
  task: string;
  messageCount: number;
}

export interface AguiServerProposal {
  proposalId: string;
  tool: string;
}

export interface AguiServerRunResult {
  threadId: string;
  runId: string;
  status: "finished" | "blocked" | "error";
  text: string;
  textChars: number;
  toolCalls: { name: string; args: string }[];
  proposals: AguiServerProposal[];
  spentUsd: number | null;
  error: string;
}

/** SSE 接收端：服务端运行时每产生一个 AG-UI 事件就调一次。 */
export type AguiServerSink = (event: Record<string, unknown>) => void;

/** Agent 执行层注入点：测试用假 runner，不花真模型钱。 */
export interface AguiServerDeps {
  agentRunner?: (
    home: string,
    task: string,
    opts: { threadId: string; runId: string; tokenName: string; writeGranted: boolean; sink: AguiServerSink },
  ) => Promise<AguiServerRunResult>;
}

function serverPath(home: string): string {
  return join(resolveNyraHome(home), AGUI_SERVER_FILE);
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

function newRunId(): string {
  return `agui-srv-${randomBytes(4).toString("hex")}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** 读服务端配置：没有返回默认配置（关闭、回环、8766、零 token）。 */
export function loadAguiServerConfig(home: string): AguiServerConfig {
  const path = serverPath(home);
  if (!existsSync(path)) {
    return { version: 1, enabled: false, host: AGUI_SERVER_DEFAULT_HOST, port: AGUI_SERVER_DEFAULT_PORT, tokens: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new AguiServerError(`${AGUI_SERVER_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.tokens)) {
    throw new AguiServerError(`${AGUI_SERVER_FILE} 结构不对（须含 tokens 列表）`);
  }
  const host = typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : AGUI_SERVER_DEFAULT_HOST;
  const port = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536
    ? parsed.port
    : AGUI_SERVER_DEFAULT_PORT;
  return {
    version: 1,
    enabled: parsed.enabled === true,
    host,
    port,
    tokens: parsed.tokens as AguiServerToken[],
  };
}

export function saveAguiServerConfig(home: string, config: AguiServerConfig): void {
  writeJsonAtomic(home, AGUI_SERVER_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function setAguiServerEnabled(home: string, enabled: boolean): AguiServerConfig {
  const config = loadAguiServerConfig(home);
  config.enabled = enabled;
  saveAguiServerConfig(home, config);
  return config;
}

/** 发一条服务端运行事件（只记 thread/run/token 名与结论，不记原文）。 */
function recordServerEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`AG-UI 服务端：${type}`, "agui-server", process.cwd(), "readonly", 1, "running");
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

export function createAguiServerToken(home: string, name: string): { record: AguiServerToken; plaintext: string } {
  const cleanName = name.trim();
  if (!cleanName) throw new AguiServerError("token 名字不能为空");
  if (cleanName.length > 64) throw new AguiServerError("token 名字最多 64 字");
  const config = loadAguiServerConfig(home);
  if (config.tokens.some((t) => t.name === cleanName)) {
    throw new AguiServerError(`已有同名 token ${cleanName}（先跑 nyra agui serve token list 看它）`);
  }
  const plaintext = AGUI_SERVER_TOKEN_PREFIX + randomBytes(24).toString("hex");
  const record: AguiServerToken = {
    id: newTokenId(),
    name: cleanName,
    token_hash: sha256Hex(plaintext),
    write_granted: false,
    write_granted_by: null,
    write_granted_at: null,
    created_at: nowIso(),
  };
  config.tokens.push(record);
  saveAguiServerConfig(home, config);
  recordServerEvent(home, "agui_server_token_created", { token: record.id });
  return { record, plaintext };
}

export function listAguiServerTokens(home: string): AguiServerToken[] {
  return loadAguiServerConfig(home).tokens;
}

export function revokeAguiServerToken(home: string, id: string): AguiServerToken {
  const config = loadAguiServerConfig(home);
  const idx = config.tokens.findIndex((t) => t.id === id);
  if (idx < 0) throw new AguiServerError(`没有 token ${id}：先跑 nyra agui serve token list 看已有的 token`);
  const [removed] = config.tokens.splice(idx, 1);
  saveAguiServerConfig(home, config);
  recordServerEvent(home, "agui_server_token_revoked", { token: id });
  return removed;
}

/** 验 Bearer token：比 SHA-256 指纹（timingSafeEqual），错了直接 null。 */
export function verifyAguiServerToken(home: string, presented: string): AguiServerToken | null {
  const clean = presented.trim();
  if (!clean) return null;
  const digest = sha256Hex(clean);
  for (const token of loadAguiServerConfig(home).tokens) {
    try {
      if (timingSafeEqual(Buffer.from(digest, "utf-8"), Buffer.from(token.token_hash, "utf-8"))) return token;
    } catch {
      continue;
    }
  }
  return null;
}

export function findAguiServerToken(home: string, id: string): AguiServerToken | null {
  return loadAguiServerConfig(home).tokens.find((t) => t.id === id) ?? null;
}

/** 机主显式给某 token 写提议权（须 CLI 加 --yes；只放行“提议”，执行仍逐条批）。 */
export function grantAguiServerWrite(home: string, id: string, by?: string): AguiServerToken {
  const config = loadAguiServerConfig(home);
  const token = config.tokens.find((t) => t.id === id);
  if (!token) throw new AguiServerError(`没有 token ${id}：先跑 nyra agui serve token list 看已有的 token`);
  token.write_granted = true;
  token.write_granted_by = by ?? "owner";
  token.write_granted_at = nowIso();
  saveAguiServerConfig(home, config);
  recordServerEvent(home, "agui_server_write_granted", { token: id, granted_by: token.write_granted_by });
  return token;
}

/** 撤销某 token 的写提议权（之后模型连写工具都看不到）。 */
export function revokeAguiServerWrite(home: string, id: string): AguiServerToken {
  const config = loadAguiServerConfig(home);
  const token = config.tokens.find((t) => t.id === id);
  if (!token) throw new AguiServerError(`没有 token ${id}：先跑 nyra agui serve token list 看已有的 token`);
  token.write_granted = false;
  token.write_granted_by = null;
  token.write_granted_at = null;
  saveAguiServerConfig(home, config);
  recordServerEvent(home, "agui_server_write_revoked", { token: id });
  return token;
}

// ---------------------------------------------------------------------------
// AG-UI run 请求解析 + SSE 事件
// ---------------------------------------------------------------------------

function cleanThreadId(raw: unknown): string {
  if (typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.trim())) return raw.trim();
  return `thread-${randomBytes(4).toString("hex")}`;
}

function cleanRunId(raw: unknown): string {
  if (typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.trim())) return raw.trim();
  return newRunId();
}

/**
 * 解析 AG-UI run 请求：任务取 messages 里最后一条 user 消息的原文；
 * 之前的消息只计数（本批不重放多轮上下文——上下文走本地会话，见
 * runAguiServerAgent 里按 threadId 读 loadSession）。
 * tools/state 字段本批只接受、不应用（工具表由 token 授权定，state 不编造）。
 */
export function parseAguiServerRun(body: unknown): AguiServerRunInput {
  if (!isPlainObject(body)) throw new AguiServerError("run 请求必须是 JSON 对象");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let task = "";
  for (const m of messages) {
    if (isPlainObject(m) && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      task = m.content.trim();
    }
  }
  if (!task) throw new AguiServerError("run 请求里没有 user 消息（messages 须含一条 role 为 user、content 非空的消息）");
  if (task.length > AGUI_MAX_MESSAGE_CHARS) throw new AguiServerError(`消息最多 ${AGUI_MAX_MESSAGE_CHARS} 字`);
  return {
    threadId: cleanThreadId(body.threadId),
    runId: cleanRunId(body.runId),
    task,
    messageCount: messages.length,
  };
}

/** 发现握手：与第一批客户端 handshakeAgui 期望的 JSON 同款。 */
export function aguiServerDiscovery(): Record<string, unknown> {
  return {
    ok: true,
    protocol: AGUI_PROTOCOL,
    version: AGUI_CLIENT_VERSION,
    server: "nyra",
    capabilities: {
      events: [...AGUI_EVENT_TYPES],
      tools: ["read-only-first"],
    },
  };
}

export function aguiServerSse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// 服务端运行：Agent 以 origin "peer" 跑，写操作进提议门
// ---------------------------------------------------------------------------

/** 写提议权之外的 token：写工具直接从工具表里拿掉，模型连提议都提不出来。 */
export function aguiServerDisabledTools(writeGranted: boolean): string[] {
  if (writeGranted) return [];
  const disabled: string[] = [];
  for (const s of TOOL_SCHEMAS) {
    const name = (s.function as Record<string, unknown>).name as string;
    if (!READONLY_TOOLS.has(name)) disabled.push(name);
  }
  return disabled;
}

/**
 * Agent 事件 → AG-UI 事件的映射（抽出来单独测；runAguiServerAgent 直接用它）。
 * - "assistant"（带工具调用那轮的正文）与 "final"（收尾正文）各发一段
 *   TEXT_MESSAGE_CONTENT，两者不重复（final 只在无工具调用那轮发）；
 * - "tool_start"/"tool_result" 发 TOOL_CALL_START/ARGS/END；
 * - "peer_proposal_recorded" 记一条写提议（执行仍须机主逐条批）。
 */
export interface AguiServerEventMapper {
  onEvent: (kind: string, data: Record<string, unknown>) => void;
  toolCalls: { name: string; args: string }[];
  proposals: AguiServerProposal[];
  textChars: number;
}

export function createAguiServerEventMapper(
  home: string,
  opts: { threadId: string; runId: string; sink: AguiServerSink },
): AguiServerEventMapper {
  const messageId = `msg-${opts.runId}`;
  const toolCalls: { name: string; args: string }[] = [];
  const proposals: AguiServerProposal[] = [];
  let textChars = 0;
  let messageStarted = false;
  const startMessage = (): void => {
    if (messageStarted) return;
    messageStarted = true;
    opts.sink({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
  };
  const mapper: AguiServerEventMapper = {
    toolCalls,
    proposals,
    get textChars() {
      return textChars;
    },
    onEvent: (kind, data) => {
      try {
        if (kind === "assistant" && typeof data.content === "string" && data.content) {
          startMessage();
          opts.sink({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: data.content });
          textChars += data.content.length;
        } else if (kind === "final" && typeof data.content === "string" && data.content) {
          startMessage();
          opts.sink({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: data.content });
          textChars += data.content.length;
        } else if (kind === "tool_start") {
          const id = typeof data.id === "string" && data.id ? data.id : `call-${toolCalls.length}`;
          const name = typeof data.name === "string" ? data.name : "";
          const args = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {});
          toolCalls.push({ name, args });
          opts.sink({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name });
          opts.sink({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: args });
        } else if (kind === "tool_result") {
          const id = typeof data.id === "string" && data.id ? data.id : "";
          if (id) opts.sink({ type: "TOOL_CALL_END", toolCallId: id });
        } else if (kind === "peer_proposal_recorded") {
          const proposalId = typeof data.proposal_id === "string" ? data.proposal_id : "";
          const tool = typeof data.tool === "string" ? data.tool : "";
          if (proposalId && tool) {
            proposals.push({ proposalId, tool });
            recordServerEvent(home, "agui_server_tool_proposed", { thread: opts.threadId, run: opts.runId, tool, proposal: proposalId });
          }
        } else if (kind === "component_rendered") {
          // O7：模型调 render_component 渲染了白名单组件——按 AG-UI 自定义事件
          // 推给网页端（网页端按组件名渲染；桌面端渲染是桌面端的界面工作）。
          const component = typeof data.component === "string" ? data.component : "";
          if (component) {
            opts.sink({ type: "CUSTOM", name: "component_rendered", value: { component, props: data.props ?? {} } });
          }
        }
      } catch { /* 观察器故障绝不破坏主循环 */ }
    },
  };
  return mapper;
}

/**
 * 生产 runner：建 Agent 跑一轮，onEvent 映射成 AG-UI 事件流进 sink。
 */
export async function runAguiServerAgent(
  home: string,
  task: string,
  opts: { threadId: string; runId: string; tokenName: string; writeGranted: boolean; sink: AguiServerSink },
): Promise<AguiServerRunResult> {
  const config = loadConfig(home);
  const provider = new Provider(resolveProvider({ home, config }));
  if (!provider.hasCredentials()) {
    throw new AguiServerError("服务端没配模型凭据：先在配置里配好 provider（nyra config 看当前 provider）再启动服务端");
  }
  const sessionId = `agui-server-${opts.threadId}`;
  const mapper = createAguiServerEventMapper(home, { threadId: opts.threadId, runId: opts.runId, sink: opts.sink });
  const agent = new Agent(provider, {
    workdir: process.cwd(),
    mode: "auto",
    maxTurns: 20,
    sessionId,
    interactive: false,
    home,
    // 缺口 47 第二批核心：origin "peer"——写操作进 peer 提议门（只记提议
    // 不执行），与第 2 批 G-P1-10 的对端任务同一口径；peer 名记 token 名，
    // 提议里能认出是谁提的。
    origin: "peer",
    peerName: `agui:${opts.tokenName}`,
    messages: loadSession(sessionId, home),
    disabledTools: aguiServerDisabledTools(opts.writeGranted),
    onEvent: mapper.onEvent,
    // 成本硬顶（网关同款口径：单次上限）：超支停下，不编 0。
    maxCostUsd: typeof config.max_cost_usd === "number" ? (config.max_cost_usd as number) : null,
    pricing: resolvePricing(config.pricing, provider.model ?? null),
  });
  const text = await agent.run(task);
  const spentUsd = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
  return {
    threadId: opts.threadId,
    runId: opts.runId,
    status: "finished",
    text,
    textChars: mapper.textChars,
    toolCalls: mapper.toolCalls,
    proposals: mapper.proposals,
    spentUsd,
    error: "",
  };
}

/**
 * 跑一轮 AG-UI 服务端 run：先过注入扫描（可疑直接 RUN_ERROR），再跑 agent，
 * 全程事件进 sink。返回 run 结果（供 HTTP 层记账与测试断言）。
 */
export async function serveAguiServerRun(
  home: string,
  input: AguiServerRunInput,
  token: AguiServerToken,
  sink: AguiServerSink,
  deps?: AguiServerDeps,
): Promise<AguiServerRunResult> {
  const { threadId, runId } = input;
  let task = input.task;
  sink({ type: "RUN_STARTED", threadId, runId });
  recordServerEvent(home, "agui_server_run_started", { thread: threadId, run: runId, token: token.name });
  if (isSuspiciousSegment(task)) {
    const labels = suspiciousLabels(task).join("、") || "可疑指令";
    const error = `对方发来的消息被注入扫描拦截（${labels}），本轮已停下`;
    recordServerEvent(home, "agui_server_blocked", { thread: threadId, run: runId, labels });
    sink({ type: "RUN_ERROR", message: error });
    return { threadId, runId, status: "blocked", text: "", textChars: 0, toolCalls: [], proposals: [], spentUsd: null, error };
  }
  const runner = deps?.agentRunner ?? runAguiServerAgent;
  // G-P2-1：对端发来的消息是总线上的 send 消息，先过拦截器再跑 agent。
  // 丢弃与注入扫描同款处理（RUN_ERROR + status blocked）；改写用改写后的任务继续。
  const intercepted = await applyInterventions(home, {
    id: newBusMessageId(), bus: "agui", room: threadId,
    sender: `agui:${token.name}`, senderKind: "peer", kind: "send", text: task,
  }, {
    emit: (type, fields) => { recordServerEvent(home, type, fields); },
  });
  if (intercepted.verdict === "drop") {
    const error = `对方发来的消息被拦截器丢弃（规则 ${intercepted.matched.join("、")}），本轮已停下`;
    recordServerEvent(home, "agui_server_blocked", { thread: threadId, run: runId, labels: `拦截器丢弃：${intercepted.matched.join("、")}` });
    sink({ type: "RUN_ERROR", message: error });
    return { threadId, runId, status: "blocked", text: "", textChars: 0, toolCalls: [], proposals: [], spentUsd: null, error };
  }
  if (intercepted.verdict === "rewrite") task = intercepted.text;
  let result: AguiServerRunResult;
  try {
    result = await runner(home, task, { threadId, runId, tokenName: token.name, writeGranted: token.write_granted, sink });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordServerEvent(home, "agui_server_run_finished", { thread: threadId, run: runId, text_chars: 0, spent_usd: null });
    sink({ type: "RUN_ERROR", message: error });
    return { threadId, runId, status: "error", text: "", textChars: 0, toolCalls: [], proposals: [], spentUsd: null, error };
  }
  if (result.status === "finished") {
    // 没发过正文就不发 TEXT_MESSAGE_END（START 都没发过，END 是错的）。
    if (result.textChars > 0) sink({ type: "TEXT_MESSAGE_END", messageId: `msg-${runId}` });
    sink({ type: "STATE_SNAPSHOT", threadId, runId });
    sink({ type: "RUN_FINISHED", threadId, runId });
  }
  recordServerEvent(home, "agui_server_run_finished", { thread: threadId, run: runId, text_chars: result.textChars, spent_usd: result.spentUsd });
  return result;
}

// ---------------------------------------------------------------------------
// HTTP 层：node:http（与网关同款），只在 serve start 跑着时存在
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
      if (size > AGUI_SERVER_MAX_BODY_CHARS) {
        reject(new AguiServerError(`请求体超过 ${AGUI_SERVER_MAX_BODY_CHARS} 字`));
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
 * 处理一次 AG-UI 服务端 HTTP 请求（供 startAguiServer 与测试共用）：
 * - GET /：发现握手（不鉴权，只报协议版本与能力名）；
 * - POST / + { type: "handshake" }：发现握手（与第一批客户端同款）；
 * - POST / + run 请求：须 Bearer token，跑一轮并以 SSE 流回事件；
 * - 其他：一律 404（不泄露端点细节）。
 */
export async function handleAguiServerRequest(
  home: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps?: AguiServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/") {
    sendJson(res, 404, { ok: false, error: "未找到" });
    return;
  }
  if (req.method === "GET") {
    sendJson(res, 200, aguiServerDiscovery());
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "AG-UI 服务端只接受 GET（发现）与 POST（握手/运行）" });
    return;
  }
  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }
  // 发现握手：POST { type: "handshake", ... }，不鉴权（只报协议与能力）。
  if (isPlainObject(body) && body.type === "handshake") {
    sendJson(res, 200, aguiServerDiscovery());
    return;
  }
  const token = verifyAguiServerToken(home, bearerToken(req));
  if (!token) {
    sendJson(res, bearerToken(req) ? 403 : 401, { ok: false, error: bearerToken(req) ? "token 无效" : "缺少 Bearer token（先跑 nyra agui serve token new 建一个）" });
    return;
  }
  let input: AguiServerRunInput;
  try {
    input = parseAguiServerRun(body);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const sink: AguiServerSink = (event) => {
    try {
      res.write(aguiServerSse(event));
    } catch { /* 客户端断了就停写，run 照跑完记账 */ }
  };
  try {
    await serveAguiServerRun(home, input, token, sink, deps);
  } catch (err) {
    try {
      res.write(aguiServerSse({ type: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) }));
    } catch { /* ignore */ }
  } finally {
    try { res.end(); } catch { /* ignore */ }
  }
}

export interface AguiServerHandle {
  server: Server;
  host: string;
  port: number;
  closed: Promise<void>;
}

/**
 * 启动 AG-UI 服务端（前台：调用方 await closed 直到进程被停）。
 * 默认关闭时拒绝启动（先跑 nyra agui serve enable）。
 */
export async function startAguiServer(
  home: string,
  opts?: { host?: string; port?: number; deps?: AguiServerDeps },
): Promise<AguiServerHandle> {
  const config = loadAguiServerConfig(home);
  if (!config.enabled) {
    throw new AguiServerError("AG-UI 服务端没启用：先跑 nyra agui serve enable（默认关闭，只在你显式启用后才监听）");
  }
  const host = opts?.host ?? config.host;
  const port = opts?.port ?? config.port;
  if (!Number.isInteger(port) || port < 0 || port >= 65536) throw new AguiServerError(`端口不对：${port}（须是 0–65535 的整数，0 表示系统分配临时端口）`);
  const server = createServer((req, res) => {
    void handleAguiServerRequest(home, req, res, opts?.deps).catch((err) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
  recordServerEvent(home, "agui_server_started", { host, port: boundPort });
  return { server, host, port: boundPort, closed };
}

// ---------------------------------------------------------------------------
// CLI：nyra agui serve <enable|disable|status|start|token|grant|revoke-grant>
// ---------------------------------------------------------------------------

const AGUI_SERVE_USAGE = [
  "用法：nyra agui serve <子命令> [参数]",
  "  enable | disable                      启用 / 禁用 AG-UI 服务端（默认关闭）",
  "  status                                看服务端配置（是否启用、地址、token 数）",
  "  start [--port <端口>] [--host <地址>]   前台启动服务端（默认 127.0.0.1:8766；Ctrl-C 停）",
  "  token new [--name <名字>]              建一条调用 token（明文只显示一次，请保存好）",
  "  token list                            列出 token（只显示 id 与名字，不显示明文）",
  "  token revoke <token-id>               吊销一条 token（立即失效）",
  "  grant <token-id> --yes                 给某 token 写提议权（模型才能提议写操作）",
  "  revoke-grant <token-id>               撤销某 token 的写提议权",
  "写提议不等于执行：模型提议的写操作进 peer 提议门，机主须逐条批",
  "（nyra peer proposal accept <提议 id> --yes）才执行。详见 docs/agui.md。",
].join("\n");

export async function aguiServeMain(argv: string[], home: string): Promise<number> {
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
    process.stdout.write(AGUI_SERVE_USAGE + "\n");
    return 0;
  };
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return usage();
    if (cmd === "enable" || cmd === "disable") {
      const config = setAguiServerEnabled(home, cmd === "enable");
      process.stdout.write(`AG-UI 服务端已${config.enabled ? "启用" : "禁用"}。\n`);
      if (config.enabled) {
        process.stdout.write(`启动：nyra agui serve start（默认 http://${config.host}:${config.port}，前台运行，Ctrl-C 停）。\n`);
        if (!config.tokens.length) process.stdout.write("还没有调用 token：先跑 nyra agui serve token new 建一个（明文只显示一次）。\n");
      }
      return 0;
    }
    if (cmd === "status") {
      const config = loadAguiServerConfig(home);
      process.stdout.write(`AG-UI 服务端：${config.enabled ? "已启用" : "未启用（默认关闭）"}\n地址：http://${config.host}:${config.port}\n`);
      process.stdout.write(`token：${config.tokens.length} 条\n`);
      for (const t of config.tokens) {
        process.stdout.write(`  ${t.id}\t${t.name}\t写提议${t.write_granted ? "已授权" : "未授权"}\t${t.created_at}\n`);
      }
      if (!config.enabled) process.stdout.write("启用：nyra agui serve enable；启动：nyra agui serve start。\n");
      return 0;
    }
    if (cmd === "start") {
      const portRaw = flagValue("--port");
      const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : undefined;
      if (portRaw !== undefined && (!Number.isInteger(port) || (port as number) <= 0 || (port as number) >= 65536)) {
        process.stderr.write("用法：nyra agui serve start [--port <1–65535 的整数>] [--host <地址>]\n");
        return 2;
      }
      const host = flagValue("--host");
      const handle = await startAguiServer(home, { host, port });
      process.stdout.write(`AG-UI 服务端已启动：http://${handle.host}:${handle.port}（AG-UI endpoint）\n`);
      process.stdout.write("发现：GET / 或 POST { type: \"handshake\" }；运行：POST / 带 Authorization: Bearer <token>。\n");
      if (handle.host !== AGUI_SERVER_DEFAULT_HOST) {
        process.stdout.write("警告：你绑的不是回环地址，局域网里的人都能连上这个端点（token 是唯一一道门）。\n");
      }
      process.stdout.write("按 Ctrl-C 停下（停了端点就不存在）。\n");
      await handle.closed;
      return 0;
    }
    if (cmd === "token") {
      const sub = argv[1];
      if (sub === "new") {
        const name = flagValue("--name") ?? `client-${newTokenId()}`;
        const { record, plaintext } = createAguiServerToken(home, name);
        process.stdout.write(`token 已建：${record.id}（${record.name}）\n`);
        process.stdout.write(`明文（只显示这一次，请保存好，盘上只存指纹）：${plaintext}\n`);
        process.stdout.write("调用：curl -H \"Authorization: Bearer <上面这串>\" http://127.0.0.1:8766/ 。\n");
        return 0;
      }
      if (sub === "list") {
        const tokens = listAguiServerTokens(home);
        if (!tokens.length) {
          process.stdout.write("还没有 token：跑 nyra agui serve token new 建一个。\n");
          return 0;
        }
        for (const t of tokens) {
          process.stdout.write(`${t.id}\t${t.name}\t写提议${t.write_granted ? "已授权" : "未授权"}\t${t.created_at}\n`);
        }
        return 0;
      }
      if (sub === "revoke") {
        const id = argv[2];
        if (!id) {
          process.stderr.write("用法：nyra agui serve token revoke <token-id>\n");
          return 2;
        }
        const removed = revokeAguiServerToken(home, id);
        process.stdout.write(`token 已吊销：${removed.id}（${removed.name}，立即失效）。\n`);
        return 0;
      }
      process.stderr.write("用法：nyra agui serve token <new|list|revoke> [参数]\n");
      return 2;
    }
    if (cmd === "grant") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra agui serve grant <token-id> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("写提议权是显式授权，须加 --yes：nyra agui serve grant <token-id> --yes\n");
        return 2;
      }
      grantAguiServerWrite(home, id);
      process.stdout.write(`token ${id} 已有写提议权（模型才能提议写操作；执行仍须机主逐条批提议）。\n`);
      return 0;
    }
    if (cmd === "revoke-grant") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra agui serve revoke-grant <token-id>\n");
        return 2;
      }
      revokeAguiServerWrite(home, id);
      process.stdout.write(`token ${id} 的写提议权已撤销（之后模型连写工具都看不到）。\n`);
      return 0;
    }
    process.stderr.write(`未知子命令 ${cmd}\n${AGUI_SERVE_USAGE}\n`);
    return 2;
  } catch (e) {
    if (e instanceof AguiServerError || e instanceof AguiError) return err(e.message);
    throw e;
  }
}
