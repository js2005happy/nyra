// src/mcp.ts — MCP 客户端（stdio JSON-RPC），与 Python 版 nyra/mcp.py 同语义。
// 协议 2026-07-28：先 server/discover 探测（-32022 时按 supported 列表
// 挑版本），失败回退旧版 initialize（2025-11-25）+ notifications/initialized；
// tools/list 分页；tools/call 遇多轮往返（input_required）直接报错，不假装完成。
// 无状态：HTTP 客户端不存、不发 Mcp-Session-Id，每请求自带 _meta 版本 +
// MCP-Protocol-Version 头；服务器主动发来的请求一律回 -32601（不支持）。
// 超时放弃的旧响应按 id 丢弃。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { loadConfig, resolveHome, saveConfig, VERSION } from "./config.ts";
import { appendMemory, deleteMemoryEntries, formatMemorySearchResults, listMemoryEntries, resolveNyraHome, searchMemoryEntries } from "./memory.ts";
import { DEFAULT_MCP_PRESETS, resolvePreset } from "./mcpPresets.ts";
import { buildReviewerRunner, reviewToolCall, reviewerEnabled, resolveReviewerModel, type ReviewerLike, type ReviewVerdict } from "./reviewer.ts";
import { RunStore } from "./runs.ts";
import { buildBwrapArgv, resolveSandboxBackend, type SandboxMode } from "./sandbox.ts";
// 子进程环境白名单（第四份审计 P0）：childEnv.ts 是叶模块，只引 node 内置。
// 代理变量的凭据段剥离也从这里共用（mcp.ts 此前自带一份同款实现）。
import { buildChildEnv } from "./childEnv.ts";
import { buildSeatbeltProfile } from "./seatbelt.ts";
import { addTask, buildProvider, runOne } from "./tasks.ts";

export const LATEST_PROTOCOL_VERSION = "2026-07-28";
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
export const LEGACY_HANDSHAKE_VERSION = "2025-11-25";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2024-11-05"];
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const PROBE_TIMEOUT = 60.0;
const CLIENT_VERSION = "0.3.0";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class MCPError extends Error {
  constructor(message: string) { super(message); this.name = "MCPError"; }
}

export class MCPRequestError extends MCPError {
  code: number | null;
  data: unknown;
  constructor(message: string, code: number | null = null, data: unknown = null) {
    super(message);
    this.name = "MCPRequestError";
    this.code = code;
    this.data = data;
  }
}

export interface MCPServerConfigLike {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  inherit_env: string[];
}

/** 缺口 17：MCP 服务器传输。stdio = 启子进程（原有）；http = Streamable HTTP
 *（POST JSON-RPC 到 url，响应 JSON 或 SSE；不启子进程、不走沙箱）。 */
export type MCPTransportKind = "stdio" | "http";

export class MCPServerConfig implements MCPServerConfigLike {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  inherit_env: string[];
  /** 缺口 17：传输，默认 stdio；http 时 command 可为空（不启子进程）。 */
  transport: MCPTransportKind;
  /** 缺口 17：http 传输的端点（只接受 http:// 或 https://）。 */
  url: string | null;
  /** 缺口 17：http 传输的请求头（可放 Authorization 等；绝不写进日志与事件）。 */
  headers: Record<string, string>;
  constructor(name: string, command: string, args: string[] = [], env: Record<string, string> = {}, inheritEnv: string[] = [], transport: MCPTransportKind = "stdio", url: string | null = null, headers: Record<string, string> = {}) {
    this.name = name; this.command = command; this.args = args; this.env = env; this.inherit_env = inheritEnv;
    this.transport = transport; this.url = url; this.headers = headers;
  }

  static fromDict(name: string, raw: unknown): MCPServerConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MCPError("服务器配置必须是字典");
    const r = raw as Record<string, unknown>;
    const transport = r.transport ?? "stdio";
    if (transport !== "stdio" && transport !== "http") throw new MCPError("transport 必须是 stdio 或 http");
    let url: string | null = null;
    if (transport === "http") {
      if (typeof r.url !== "string" || !r.url.trim()) throw new MCPError("http 传输须配 url");
      try {
        const u = new URL(r.url.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http/https");
      } catch { throw new MCPError("url 必须是 http:// 或 https:// 开头的地址"); }
      url = r.url.trim();
    }
    const headers = r.headers ?? {};
    if (!headers || typeof headers !== "object" || Array.isArray(headers) ||
      Object.entries(headers as Record<string, unknown>).some(([k, v]) => typeof k !== "string" || typeof v !== "string" || !k.trim())) {
      throw new MCPError("headers 必须是字符串字典");
    }
    const command = r.command ?? "";
    if (transport === "stdio") {
      if (typeof command !== "string" || !command.trim()) throw new MCPError("command 必须是非空字符串");
    } else if (typeof command !== "string") {
      throw new MCPError("command 必须是字符串");
    }
    const args = r.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new MCPError("args 必须是列表，且每一项必须是字符串");
    const env = r.env ?? {};
    if (!env || typeof env !== "object" || Array.isArray(env) ||
      Object.entries(env as Record<string, unknown>).some(([k, v]) => typeof k !== "string" || typeof v !== "string" || !ENV_NAME_RE.test(k))) {
      throw new MCPError("env 的键和值必须是字符串，且键是合法环境变量名");
    }
    const inheritEnv = r.inherit_env ?? [];
    if (!Array.isArray(inheritEnv) || inheritEnv.some((k) => typeof k !== "string" || !ENV_NAME_RE.test(k))) {
      throw new MCPError("inherit_env 必须是合法环境变量名称列表");
    }
    return new MCPServerConfig(name, command, [...(args as string[])], { ...(env as Record<string, string>) }, [...(inheritEnv as string[])], transport, url, { ...(headers as Record<string, string>) });
  }
}

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; }

/**
 * MCP 沙箱配置（与 Agent/CLI/群聊同款形状，见 sandbox.ts）：MCPToolManager
 * 在 startAll 里用 resolveSandboxBackend 解析一次，解析失败整批拒绝启动。
 * workdir 是服务器进程的工作目录（bwrap/Seatbelt 绑定的工作区）。
 */
export interface McpSandboxOptions {
  backend?: string | null;
  mode?: SandboxMode;
  allowNet?: boolean;
  workdir?: string;
}

/** 已解析的 MCP 沙箱配置（MCPClient 持有，start() 时直接用，不再二次解析）。 */
export interface ResolvedMcpSandbox {
  backend: string;
  mode: SandboxMode;
  allowNet: boolean;
  workdir: string;
}

/** 在 PATH 里找可执行文件（供 MCP 沙箱找服务器命令的真实位置；找不到返回 null）。 */
export function findOnPath(command: string, pathEnv?: string, platform: string = process.platform): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  if (command.includes("/") || (platform === "win32" && command.includes("\\"))) return null;
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates = platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch { /* 不存在或不可读就继续找 */ }
    }
  }
  return null;
}

/**
 * bwrap 追加只读绑定目录：服务器命令本身（绝对路径或 PATH 解析后）与绝对
 * 路径参数所在目录。工作区内或已在系统挂载面里的目录不重复加。
 */
export function mcpServerRoBinds(config: MCPServerConfig, workdir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addDir = (dir: string): void => {
    const abs = resolve(dir);
    if (seen.has(abs)) return;
    seen.add(abs);
    const wd = resolve(workdir);
    if (abs === wd || abs.startsWith(wd + "/")) return;
    if (["/usr", "/lib", "/lib64", "/bin", "/etc"].some((base) => abs === base || abs.startsWith(base + "/"))) return;
    out.push(abs);
  };
  const cmdPath = findOnPath(config.command);
  if (cmdPath) addDir(dirname(cmdPath));
  for (const arg of config.args) {
    if (!isAbsolute(arg)) continue;
    try {
      if (!existsSync(arg)) continue;
      addDir(statSync(arg).isDirectory() ? arg : dirname(arg));
    } catch { /* 读不到就跳过，不拦启动 */ }
  }
  return out;
}

/**
 * 按沙箱配置算出 MCP 服务器进程的 spawn 参数（纯函数，可单测）。
 * 返回 [spawn 命令, spawn 参数]。沙箱不可用时抛 MCPError——调用方不启动
 * 该服务器，绝不静默裸奔。
 * - local：原样 spawn（工具级隔离，与 0.5.1 前行为一致）。
 * - bwrap：复用 buildBwrapArgv；服务器命令与绝对路径参数所在目录追加只读
 *   绑定（服务器可执行文件本身常在工作区外，不绑就读不到）。
 * - seatbelt：sandbox-exec -p <profile> <command> <args>，profile 与
 *   toolShell 同款（工作区可写、默认断网）。
 * - jobobject：Job Object 是一锤子脚本执行器（runWindowsSandboxed），装不下
 *   长驻 stdio 进程，显式指定时直接拒绝。
 * - e2b：命令后端（控制面已接，见 src/commandBackends.ts），但 MCP 服务器是
 *   长驻 stdio 进程，e2b 沙箱内跑命令须 SDK、未接线，显式指定时直接拒绝。
 */
export function sandboxedMcpSpawnArgs(
  config: MCPServerConfig,
  resolved: { backend: string; mode: SandboxMode; allowNet: boolean },
  workdir: string,
  env?: Record<string, string>,
): [string, string[]] {
  if (resolved.backend === "local") return [config.command, [...config.args]];
  if (resolved.backend === "bwrap") {
    const argv = buildBwrapArgv(config.command, config.args, {
      workdir,
      allowNet: resolved.allowNet,
      mode: resolved.mode,
      extraRoBinds: mcpServerRoBinds(config, workdir),
      env,
    });
    return [argv[0], argv.slice(1)];
  }
  if (resolved.backend === "seatbelt") {
    const profile = buildSeatbeltProfile({ mode: resolved.mode, workdir, allowNet: resolved.allowNet });
    return ["sandbox-exec", ["-p", profile, config.command, ...config.args]];
  }
  if (resolved.backend === "jobobject") {
    throw new MCPError(
      `MCP 服务器 ${config.name} 无法进 Job Object 沙箱：Job Object 是一锤子脚本执行器，装不下长驻 stdio 进程；` +
      "请改用 --sandbox local（工具级）或 bwrap/seatbelt",
    );
  }
  if (resolved.backend === "e2b") {
    throw new MCPError(`MCP 服务器 ${config.name} 无法进 e2b 沙箱：e2b 沙箱内跑命令须 E2B SDK（未接线，见 docs/sandbox.md）；请改用 --sandbox local 或 bwrap`);
  }
  throw new MCPError(`MCP 服务器 ${config.name} 的沙箱后端 ${resolved.backend} 未知，拒绝启动`);
}

/**
 * 缺口 17：MCP 传输公共面——stdio 客户端（MCPClient）与 HTTP 客户端
 *（MCPHttpClient）都实现它，MCPToolManager 按配置的 transport 选客户端，
 * 其余逻辑（工具名、成本、沙箱、路由）不变。
 */
export interface MCPTransportLike {
  config: MCPServerConfig;
  tools: McpTool[];
  era: "modern" | "legacy" | null;
  negotiatedVersion: string | null;
  serverInfo: Record<string, unknown> | null;
  start(): void;
  ensureNegotiated(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  stop(): void;
}

/**
 * 把 tools/call 的 result 拼成文本（stdio 与 HTTP 客户端共用）。
 * input_required 仍抛错（Nyra 不做多轮往返）；isError 前缀保持与 stdio
 * 客户端原有行为一致。
 */
export function extractToolText(result: Record<string, unknown>): string {
  if (result.resultType === "input_required") {
    const requests = result.inputRequests;
    let detail = "";
    if (requests && typeof requests === "object" && !Array.isArray(requests) && Object.keys(requests).length) {
      detail = "（需要：" + Object.keys(requests).sort().join("、") + "）";
    } else if (Array.isArray(requests) && requests.length) {
      detail = `（需要 ${requests.length} 项输入）`;
    }
    throw new MCPError(`MCP 服务器要求补充输入后重试（多轮往返），Nyra 暂不支持${detail}`);
  }
  const content = result.content ?? [];
  if (!Array.isArray(content)) throw new MCPError("MCP 工具响应格式无效：content 必须是列表");
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") throw new MCPError("MCP 工具响应格式无效：内容项必须是字典");
    const it = item as Record<string, unknown>;
    if (it.type === "text") {
      if (typeof it.text !== "string") throw new MCPError("MCP 工具响应格式无效：text 必须是字符串");
      texts.push(it.text);
    }
  }
  let output = texts.length ? texts.join("\n") : JSON.stringify(result);
  if (result.isError) output = "MCP 工具返回错误：\n" + output;
  return output;
}

export class MCPClient implements MCPTransportLike {
  config: MCPServerConfig;
  timeout: number;
  /** 已解析的沙箱配置；为 null 时原样 spawn（0.5.1 前行为）。 */
  sandbox: ResolvedMcpSandbox | null;
  process: ChildProcessWithoutNullStreams | null = null;
  nextId = 1;
  tools: McpTool[] = [];
  era: "modern" | "legacy" | null = null;
  negotiatedVersion: string | null = null;
  serverInfo: Record<string, unknown> | null = null;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private staleIds = new Set<number>();
  private exitPromise: Promise<number | null> | null = null;
  // stdout 按字节攒行：StringDecoder 会缓存被 chunk 边界切断的多字节字符，
  // 避免逐 chunk 转字符串时出现 U+FFFD 导致整行 JSON 解析失败被静默丢弃。
  private stdoutDecoder = new StringDecoder("utf-8");
  // 传输层诊断计数：行解析失败时不再静默丢弃，而是记下来；请求超时
  // 时据此判断是“服务器没回”还是“回了但解析失败”（后者曾在 Windows
  // 上造成 10 秒超时却无任何线索）。
  private bytesReceived = 0;
  private linesParsed = 0;
  private badLineCount = 0;
  private lastBadLine: string | null = null;

  constructor(config: MCPServerConfig, timeout = 30.0, sandbox: ResolvedMcpSandbox | null = null) {
    this.config = config;
    this.timeout = timeout;
    this.sandbox = sandbox;
  }

  private subprocessEnv(): Record<string, string> {
    // 白名单环境（第四份审计 P0）：只传 PATH/HOME/语言/代理等白名单变量，
    // 密钥类一律不传。inherit_env 与 config.env 是配置里显式声明的变量，
    // 原样放行——写配置的人自己对它负责。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(buildChildEnv())) {
      if (v !== undefined) env[k] = v;
    }
    for (const k of this.config.inherit_env) {
      if (process.env[k] !== undefined) env[k] = process.env[k]!;
    }
    Object.assign(env, this.config.env);
    return env;
  }

  start(): void {
    if (this.process) return;
    // 子进程环境只算一次：spawn 与 bwrap --setenv 用同一份（白名单）。
    const env = this.subprocessEnv();
    // 沙箱：按已解析配置算 spawn 参数；算不出来（后端不可用/不支持长驻进程）
    // 直接抛 MCPError，服务器不启动——绝不静默裸奔。
    let command = this.config.command;
    let args = [...this.config.args];
    if (this.sandbox) {
      try {
        [command, args] = sandboxedMcpSpawnArgs(this.config, this.sandbox, this.sandbox.workdir, env);
      } catch (err) {
        throw new MCPError(`MCP 服务器 ${this.config.name} 无法进沙箱，拒绝启动：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"], env,
    });
    this.process = child;
    this.exitPromise = new Promise((resolve) => { child.on("exit", (code) => resolve(code)); });
    this.stdoutDecoder = new StringDecoder("utf-8");
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", () => { /* MCP 服务端日志不进协议流，丢弃 */ });
    child.stdin.on("error", (err: Error) => {
      // stdin 管道断裂时挂起的请求会等满超时才报；直接失败，给出原因。
      this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 写入失败：${err.message}`));
    });
    child.on("error", (err: Error) => {
      // spawn 失败（如命令不存在）时只触发 error，不一定有 exit；
      // 不挂监听会变成未处理异常，挂起的请求也要立即失败而不是等超时。
      this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 启动失败：${err.message}`));
    });
    child.on("exit", () => {
      this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 已退出`));
    });
    this.negotiate();
  }

  /** 传输层已死（stdin 断裂 / 写入失败 / 进程退出）时让挂起的请求
   * 立即失败，而不是等满超时。重复调用无害：已清空的 pending 不再
   * 有待拒绝的项，已落定的 promise 再次 reject 也是空操作。 */
  private failPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private onStdout(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.bytesReceived += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.length;
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.badLineCount++;
        this.lastBadLine = line.length > 200 ? line.slice(0, 200) + "……" : line;
        continue;
      }
      this.linesParsed++;
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.method === "string") {
      // 服务器主动请求：最小客户端不支持，一律回 -32601。
      if (msg.id !== undefined && this.process?.stdin.writable) {
        this.writeMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Nyra 不支持服务器主动请求的方法" } });
      }
      return;
    }
    if (msg.id === undefined) return;
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) {
      if (this.staleIds.has(id)) this.staleIds.delete(id);
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) {
      const e = msg.error as Record<string, unknown>;
      p.reject(new MCPRequestError(
        `MCP 错误：${typeof e.message === "string" ? e.message : "服务器未提供错误说明"}`,
        typeof e.code === "number" ? e.code : null, e.data ?? null,
      ));
      return;
    }
    if (msg.result === undefined || msg.result === null || typeof msg.result !== "object") {
      p.reject(new MCPError("MCP 响应格式无效：缺少 result"));
      return;
    }
    p.resolve(msg.result as Record<string, unknown>);
  }

  private writeMessage(msg: Record<string, unknown>): void {
    if (!this.process) throw new MCPError("MCP 服务器未启动");
    if (this.process.exitCode !== null) throw new MCPError(`MCP 服务器 ${this.config.name} 已退出`);
    if (!this.process.stdin.writable) throw new MCPError("MCP 服务器未启动");
    this.process.stdin.write(JSON.stringify(msg) + "\n", (err) => {
      // 写入回调报错且管道已死（如 EPIPE）时，挂起的请求不再等满
      // 超时，直接失败；管道仍可用时忽略（数据已入队）。
      if (err && this.process?.stdin && !this.process.stdin.writable) {
        this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 写入失败：${err.message}`));
      }
    });
    // 交互式 stdio 协议：写完即刷。Bun 原生 FileSink 有 flush()，
    // 这里若存在就调一次；node:child_process 的 WriteStream 上
    // flush 不是函数，此步为空操作，不影响任何行为。
    const sink = this.process.stdin as unknown as { flush?: unknown };
    if (typeof sink.flush === "function") (sink.flush as () => void).call(this.process.stdin);
  }

  private modernMeta(version: string): Record<string, unknown> {
    return {
      [META_PROTOCOL_VERSION]: version,
      [META_CLIENT_CAPABILITIES]: {},
      [META_CLIENT_INFO]: { name: "Nyra", version: CLIENT_VERSION },
    };
  }

  private async sendRequest(method: string, params: Record<string, unknown> = {}, meta?: Record<string, unknown> | null, timeout?: number): Promise<Record<string, unknown>> {
    // Windows 上偶发（CI 三轮里同一测试必现其一）：请求发出后整个
    // 超时窗口内收到 0 字节、服务器仍活着——请求或回复在传输层
    // 丢了，本地复现不了（Linux 上 10/10 次 1ms 内回包；MITM
    // 1 字节切片亦通过；请求 JSON 全是 ASCII，排除多字节切断）。
    // 只对这种可确认的“零字节丢失”重试一次（新 id），其余失败
    // （服务器已退出、有坏行、已收到部分回复）一律不重试。重试
    // 有极小重复执行风险：若服务器其实已执行但回复丢了，重发会
    // 再执行一次；零字节意味着它大概率根本没收到请求，且原地
    // 10 秒超时后由上层重试的风险与体验都更差，因此接受折中。
    let lastErr: unknown = null;
    let retried = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.sendRequestOnce(method, params, meta, timeout);
      } catch (err) {
        lastErr = err;
        const zeroByte = err instanceof MCPError
          && (err as MCPError & { zeroByteTimeout?: boolean }).zeroByteTimeout === true;
        if (attempt === 0 && zeroByte && this.process !== null && this.process.exitCode === null) {
          retried = true;
          process.stderr.write(`MCP 请求无响应后重试（第 1 次）：${method}（发出后 0 字节，服务器仍在运行）\n`);
          continue;
        }
        if (retried && err instanceof MCPError) err.message += "（已重试 1 次）";
        throw err;
      }
    }
    throw lastErr;
  }

  private async sendRequestOnce(method: string, params: Record<string, unknown> = {}, meta?: Record<string, unknown> | null, timeout?: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { ...params };
    if (meta !== undefined && meta !== null) body._meta = meta;
    else if (this.era === "modern") body._meta = this.modernMeta(this.negotiatedVersion ?? LATEST_PROTOCOL_VERSION);
    const deadline = (timeout ?? this.timeout) * 1000;
    // 发送时快照传输计数：超时后据此判断这段时间内服务器到底回了
    // 什么（没回 / 回了但解析失败 / 回了但 id 对不上），而不是只报
    // 一句“超时”。
    const sentBytes = this.bytesReceived;
    const sentLines = this.linesParsed;
    const sentBad = this.badLineCount;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.staleIds.add(id);
        const serverAlive = this.process !== null && this.process.exitCode === null;
        const serverState = this.process === null ? "客户端已停止"
          : serverAlive ? "服务器仍在运行" : "服务器已退出";
        const recvBytes = this.bytesReceived - sentBytes;
        const recvLines = this.linesParsed - sentLines;
        const recvBad = this.badLineCount - sentBad;
        const detail = `请求发出后已收字节 +${recvBytes}`
          + `，已解析行 +${recvLines}`
          + `，无法解析行 +${recvBad}`
          + (this.lastBadLine !== null ? `，最后无法解析行：${this.lastBadLine}` : "")
          + `，${serverState}`;
        const err = new MCPError(`MCP 请求超时：${method}（${detail}）`);
        // 零字节且服务器活着 = 请求或回复在传输层丢了（见 sendRequest），
        // 可重试；其余超时原因不重试。
        (err as MCPError & { zeroByteTimeout?: boolean }).zeroByteTimeout
          = recvBytes === 0 && recvLines === 0 && recvBad === 0 && serverAlive;
        reject(err);
      }, deadline);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.writeMessage({ jsonrpc: "2.0", id, method, params: body });
    } catch (err) {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); clearTimeout(p.timer); }
      throw err;
    }
    try {
      return await promise;
    } catch (err) {
      this.staleIds.add(id);
      throw err;
    }
  }

  private sendNotification(method: string, params: Record<string, unknown> = {}): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private async discover(version: string): Promise<Record<string, unknown>> {
    return this.sendRequest("server/discover", {}, this.modernMeta(version), Math.min(this.timeout, PROBE_TIMEOUT));
  }

  private pickModernVersion(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const supported = (data as Record<string, unknown>).supported;
    if (!Array.isArray(supported)) return null;
    for (const v of MODERN_PROTOCOL_VERSIONS) if (supported.includes(v)) return v;
    return null;
  }

  private useModern(result: Record<string, unknown>, requested: string): void {
    const supported = result.supportedVersions;
    if (!Array.isArray(supported) || !supported.length) throw new MCPError("MCP 发现结果格式无效：supportedVersions 必须是列表");
    let version: string | null = null;
    if (supported.includes(requested)) version = requested;
    else version = MODERN_PROTOCOL_VERSIONS.find((v) => supported.includes(v)) ?? null;
    if (!version) throw new MCPError("MCP 服务器不支持任何 Nyra 能用的现代协议版本：" + supported.map(String).join("、"));
    this.negotiatedVersion = version;
    this.era = "modern";
    const meta = result._meta;
    if (meta && typeof meta === "object") {
      const info = (meta as Record<string, unknown>)[META_SERVER_INFO];
      if (info && typeof info === "object") this.serverInfo = info as Record<string, unknown>;
    }
  }

  private async initializeLegacy(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: LEGACY_HANDSHAKE_VERSION,
      capabilities: {},
      clientInfo: { name: "Nyra", version: CLIENT_VERSION },
    });
    const serverVersion = result.protocolVersion;
    if (typeof serverVersion === "string" && !LEGACY_PROTOCOL_VERSIONS.includes(serverVersion)) {
      // 旧版握手回的版本不在支持列表里：仍按旧版走，但记下协商版本。
      this.negotiatedVersion = serverVersion;
    } else {
      this.negotiatedVersion = typeof serverVersion === "string" ? serverVersion : LEGACY_HANDSHAKE_VERSION;
    }
    this.era = "legacy";
    const info = result.serverInfo;
    if (info && typeof info === "object") this.serverInfo = info as Record<string, unknown>;
    this.sendNotification("notifications/initialized");
  }

  /** 同步协商：discover 失败（-32022 挑版本 / 其他错误）时回退旧版 initialize。 */
  private negotiate(): void {
    // start() 是同步入口：协商在首次请求时以异步方式完成。
    // 为保持与 Python 的 start() 同步语义一致，这里只做标记，真正
    // 的握手在 ensureNegotiated() 里完成（list_tools/call_tool 前调）。
    this.negotiatePromise ??= this.doNegotiate();
  }
  private negotiatePromise: Promise<void> | null = null;

  private async doNegotiate(): Promise<void> {
    try {
      const result = await this.discover(LATEST_PROTOCOL_VERSION);
      this.useModern(result, LATEST_PROTOCOL_VERSION);
      return;
    } catch (err) {
      if (err instanceof MCPRequestError && err.code === UNSUPPORTED_PROTOCOL_VERSION_CODE) {
        const picked = this.pickModernVersion(err.data);
        if (picked) {
          try {
            const result = await this.discover(picked);
            this.useModern(result, picked);
            return;
          } catch { /* 挑版本重试失败，落到旧版握手 */ }
        }
      }
      // 其他 discover 失败（方法不存在、超时等）→ 旧版握手。
      try {
        await this.initializeLegacy();
      } catch (legacyErr) {
        // 协商彻底失败：子进程已无用，按 Python 口径清理（否则静默子进程泄漏）。
        this.stop();
        throw legacyErr;
      }
    }
  }

  async ensureNegotiated(): Promise<void> {
    if (this.negotiatePromise) await this.negotiatePromise;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureNegotiated();
    const tools: McpTool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: Record<string, unknown> = {};
      if (cursor !== null) params.cursor = cursor;
      const result = await this.sendRequest("tools/list", params);
      const rawTools = result.tools;
      if (!Array.isArray(rawTools)) throw new MCPError("MCP 工具列表格式无效：tools 必须是列表");
      for (const tool of rawTools) {
        if (!tool || typeof tool !== "object") throw new MCPError("MCP 工具格式无效：工具必须是字典");
        const t = tool as Record<string, unknown>;
        if (typeof t.name !== "string" || !t.name) throw new MCPError("MCP 工具格式无效：name 必须是非空字符串");
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: (t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema : { type: "object", properties: {} }) as Record<string, unknown>,
        });
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureNegotiated();
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return extractToolText(result);
  }

  stop(): void {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    this.tools = [];
    this.negotiatePromise = null;
    try {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        const deadline = Date.now() + 2000;
        const iv = setInterval(() => {
          if (proc.exitCode !== null || Date.now() > deadline) {
            clearInterval(iv);
            if (proc.exitCode === null) { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }
            try { proc.stdin.end(); } catch { /* ignore */ }
          }
        }, 50);
      }
    } catch { /* ignore */ }
  }
}

/** 缺口 17：现代握手用的 _meta（与 MCPClient.modernMeta 同形，HTTP 客户端用）。 */
function buildModernMeta(version: string): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_CAPABILITIES]: {},
    [META_CLIENT_INFO]: { name: "Nyra", version: CLIENT_VERSION },
  };
}

/**
 * 缺口 17：MCP Streamable HTTP 客户端（与 MCPClient 同公共面）。
 * - 每个请求都是独立的 HTTP POST（JSON-RPC 2.0），响应是 JSON 或 SSE；
 *   无状态：不存、不发 Mcp-Session-Id（老式有状态服务器回了也忽略），
 *   每请求自带协议版本（_meta + MCP-Protocol-Version 请求头）。
 * - 协商与 stdio 客户端同款：先 server/discover 探现代版，失败回退旧版
 *   initialize；tools/list 分页、tools/call 结果拼文本都与 stdio 一致。
 * - 不启子进程、不走沙箱（沙箱只约束本地子进程）；url 只接受 http/https；
 *   请求头（含 Authorization）绝不写进日志与事件。
 * - 超时用 AbortController 掐断；HTTP 非 2xx 按状态码报 MCPRequestError。
 */
export class MCPHttpClient implements MCPTransportLike {
  config: MCPServerConfig;
  timeout: number;
  tools: McpTool[] = [];
  era: "modern" | "legacy" | null = null;
  negotiatedVersion: string | null = null;
  serverInfo: Record<string, unknown> | null = null;
  private nextId = 1;
  private negotiatePromise: Promise<void> | null = null;

  constructor(config: MCPServerConfig, timeout = 30.0) {
    if (!config.url) throw new MCPError(`MCP 服务器 ${config.name} 用 http 传输却未配 url`);
    this.config = config;
    this.timeout = timeout;
  }

  /** 无状态传输：start 是空操作，协商在首次请求时懒完成（与 MCPClient 同款）。 */
  start(): void {}

  private async postJsonRpc(payload: Record<string, unknown>, timeout?: number, protocolVersion?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (timeout ?? this.timeout) * 1000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.config.headers,
    };
    // 2026-07-28：版本声明随每请求走（与 _meta 里同款值一致，供服务端在
    // 解析 body 前路由/拒绝；旧服务器不认这个头，直接忽略）。
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    let res: Response;
    try {
      res = await fetch(this.config.url!, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new MCPError(`MCP HTTP 请求超时：${this.config.name}（${timeout ?? this.timeout} 秒未回）`);
      }
      throw new MCPError(`MCP HTTP 请求失败：${this.config.name}（${err instanceof Error ? err.message : String(err)}）`);
    } finally {
      clearTimeout(timer);
    }
    // 2026-07-28：没有会话——服务端回的 Mcp-Session-Id 一律忽略，不存、不发。
    const text = await res.text();
    if (!res.ok) {
      throw new MCPRequestError(`MCP HTTP 服务器返回 ${res.status}：${text.slice(0, 200)}`, res.status);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return this.parseSse(text);
    try {
      return JSON.parse(text);
    } catch {
      throw new MCPError(`MCP HTTP 响应不是合法 JSON：${this.config.name}`);
    }
  }

  /** 解析 SSE 响应：取 data: 行拼成的 JSON-RPC 消息（可能多条）。 */
  private parseSse(text: string): unknown[] {
    const messages: unknown[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { messages.push(JSON.parse(data)); } catch { /* 非 JSON 的 data 行忽略 */ }
      }
    }
    return messages;
  }

  private async sendRequest(method: string, params: Record<string, unknown> = {}, meta?: Record<string, unknown> | null, timeout?: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { ...params };
    // 头里的版本与 _meta 里的版本取同一值（discover 挑版本重试时是挑中的版本，
    // 平时是协商好的版本）；旧版握手期没 _meta，也不发这个头。
    let protocolVersion: string | undefined;
    if (meta !== undefined && meta !== null) {
      body._meta = meta;
      const v = meta[META_PROTOCOL_VERSION];
      if (typeof v === "string") protocolVersion = v;
    } else if (this.era === "modern") {
      body._meta = buildModernMeta(this.negotiatedVersion ?? LATEST_PROTOCOL_VERSION);
      protocolVersion = this.negotiatedVersion ?? LATEST_PROTOCOL_VERSION;
    }
    const raw = await this.postJsonRpc({ jsonrpc: "2.0", id, method, params: body }, timeout, protocolVersion);
    const msg = this.pickResponse(raw, id);
    if (msg === null) throw new MCPError(`MCP HTTP 服务器未回应该请求：${method}（id ${id}）`);
    if (msg.error && typeof msg.error === "object") {
      const e = msg.error as Record<string, unknown>;
      const code = typeof e.code === "number" ? e.code : -32603;
      throw new MCPRequestError(typeof e.message === "string" ? e.message : "MCP 服务器返回错误", code, e.data);
    }
    const result = msg.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new MCPError(`MCP HTTP 响应格式无效：${method} 的 result 必须是字典`);
    }
    return result as Record<string, unknown>;
  }

  /** 从 JSON 直回或 SSE 消息列表里挑出与本次 id 对应的那条。 */
  private pickResponse(raw: unknown, id: number): { error?: unknown; result?: unknown } | null {
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (m && typeof m === "object" && (m as Record<string, unknown>).id === id) {
          return m as { error?: unknown; result?: unknown };
        }
      }
      return null;
    }
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).id === id) {
      return raw as { error?: unknown; result?: unknown };
    }
    return null;
  }

  private async sendNotification(method: string, params: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.postJsonRpc({ jsonrpc: "2.0", method, params }, Math.min(this.timeout, 10));
    } catch { /* 通知发不发得出去不影响后续请求 */ }
  }

  private pickModernVersion(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const supported = (data as Record<string, unknown>).supported;
    if (!Array.isArray(supported)) return null;
    for (const v of MODERN_PROTOCOL_VERSIONS) if (supported.includes(v)) return v;
    return null;
  }

  private useModern(result: Record<string, unknown>, requested: string): void {
    const supported = result.supportedVersions;
    if (!Array.isArray(supported) || !supported.length) throw new MCPError("MCP 发现结果格式无效：supportedVersions 必须是列表");
    let version: string | null = null;
    if (supported.includes(requested)) version = requested;
    else version = MODERN_PROTOCOL_VERSIONS.find((v) => supported.includes(v)) ?? null;
    if (!version) throw new MCPError("MCP 服务器不支持任何 Nyra 能用的现代协议版本：" + supported.map(String).join("、"));
    this.negotiatedVersion = version;
    this.era = "modern";
    const meta = result._meta;
    if (meta && typeof meta === "object") {
      const info = (meta as Record<string, unknown>)[META_SERVER_INFO];
      if (info && typeof info === "object") this.serverInfo = info as Record<string, unknown>;
    }
  }

  private async initializeLegacy(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: LEGACY_HANDSHAKE_VERSION,
      capabilities: {},
      clientInfo: { name: "Nyra", version: CLIENT_VERSION },
    });
    const serverVersion = result.protocolVersion;
    if (typeof serverVersion === "string" && !LEGACY_PROTOCOL_VERSIONS.includes(serverVersion)) {
      this.negotiatedVersion = serverVersion;
    } else {
      this.negotiatedVersion = typeof serverVersion === "string" ? serverVersion : LEGACY_HANDSHAKE_VERSION;
    }
    this.era = "legacy";
    const info = result.serverInfo;
    if (info && typeof info === "object") this.serverInfo = info as Record<string, unknown>;
    await this.sendNotification("notifications/initialized");
  }

  private async doNegotiate(): Promise<void> {
    try {
      const result = await this.sendRequest("server/discover", {}, buildModernMeta(LATEST_PROTOCOL_VERSION), Math.min(this.timeout, PROBE_TIMEOUT));
      this.useModern(result, LATEST_PROTOCOL_VERSION);
      return;
    } catch (err) {
      if (err instanceof MCPRequestError && err.code === UNSUPPORTED_PROTOCOL_VERSION_CODE) {
        const picked = this.pickModernVersion(err.data);
        if (picked) {
          try {
            const result = await this.sendRequest("server/discover", {}, buildModernMeta(picked), Math.min(this.timeout, PROBE_TIMEOUT));
            this.useModern(result, picked);
            return;
          } catch { /* 挑版本重试失败，落到旧版握手 */ }
        }
      }
      // 其他 discover 失败（方法不存在、超时等）→ 旧版握手。
      await this.initializeLegacy();
    }
  }

  async ensureNegotiated(): Promise<void> {
    if (!this.negotiatePromise) this.negotiatePromise = this.doNegotiate();
    await this.negotiatePromise;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureNegotiated();
    const tools: McpTool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: Record<string, unknown> = {};
      if (cursor !== null) params.cursor = cursor;
      const result = await this.sendRequest("tools/list", params);
      const rawTools = result.tools;
      if (!Array.isArray(rawTools)) throw new MCPError("MCP 工具列表格式无效：tools 必须是列表");
      for (const tool of rawTools) {
        if (!tool || typeof tool !== "object") throw new MCPError("MCP 工具格式无效：工具必须是字典");
        const t = tool as Record<string, unknown>;
        if (typeof t.name !== "string" || !t.name) throw new MCPError("MCP 工具格式无效：name 必须是非空字符串");
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: (t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema : { type: "object", properties: {} }) as Record<string, unknown>,
        });
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureNegotiated();
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return extractToolText(result);
  }

  /** 无状态传输：无子进程可停，只清协商状态。 */
  stop(): void {
    this.tools = [];
    this.negotiatePromise = null;
  }
}

export function loadMcpServers(config: Record<string, unknown>): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  let presetNames = (config as Record<string, unknown>).mcp_presets;
  if (!Array.isArray(presetNames) || !presetNames.every((n) => typeof n === "string")) {
    if (presetNames !== undefined) process.stderr.write("mcp_presets 应为预置名列表，已忽略并使用默认预置\n");
    presetNames = [...DEFAULT_MCP_PRESETS];
  }
  const presetArgs = ((config as Record<string, unknown>).mcp_preset_args ?? {}) as Record<string, unknown>;
  for (const name of presetNames as string[]) {
    const [raw, reason] = resolvePreset(name, presetArgs);
    if (raw === null) { process.stderr.write(reason + "\n"); continue; }
    try { servers[name] = MCPServerConfig.fromDict(name, raw); }
    catch (err) { process.stderr.write(`跳过无效 MCP 预置 ${name}: ${err instanceof Error ? err.message : String(err)}\n`); }
  }
  const rawServers = (config as Record<string, unknown>).mcp_servers;
  if (rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)) {
    for (const [name, raw] of Object.entries(rawServers as Record<string, unknown>)) {
      try { servers[name] = MCPServerConfig.fromDict(name, raw); }
      catch (err) { process.stderr.write(`跳过无效 MCP 服务器配置 ${name}: ${err instanceof Error ? err.message : String(err)}\n`); }
    }
  }
  return servers;
}

export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

export interface McpToolSchema { type: string; function: { name: string; description: string; parameters: Record<string, unknown> }; [key: string]: unknown }

export class MCPToolManager {
  servers: Record<string, MCPServerConfig>;
  timeout: number;
  clients: Record<string, MCPTransportLike> = {};
  toolSchemas: McpToolSchema[] = [];
  private toolRoutes: Record<string, [string, string]> = {};
  /** 未解析的沙箱配置（startAll 里解析一次）；为 null 时不进沙箱。 */
  sandbox: McpSandboxOptions | null;
  workdir: string;

  constructor(
    servers: Record<string, MCPServerConfig>,
    timeout = 30.0,
    opts: { sandbox?: McpSandboxOptions | null; workdir?: string } = {},
  ) {
    this.servers = { ...servers };
    this.timeout = timeout;
    this.sandbox = opts.sandbox ?? null;
    this.workdir = opts.workdir ?? process.cwd();
  }

  async startAll(): Promise<void> {
    // 沙箱配置只解析一次：显式后端不可用时整批拒绝启动（不逐个服务器重复
    // 报错，也不让任何服务器裸奔）；解析失败直接抛 MCPError。
    // 缺口 17：沙箱只约束 stdio 子进程——全是 http 服务器时不解析沙箱，
    // 免得一个与 HTTP 无关的沙箱配置拦住整批启动。
    const hasStdio = Object.values(this.servers).some((c) => c.transport !== "http");
    let resolved: ResolvedMcpSandbox | null = null;
    if (this.sandbox && hasStdio) {
      try {
        const r = resolveSandboxBackend({
          sandbox: this.sandbox.backend ?? null,
          sandbox_mode: this.sandbox.mode,
          sandbox_allow_net: this.sandbox.allowNet,
        });
        resolved = { backend: r.backend, mode: r.mode, allowNet: r.allowNet, workdir: this.workdir };
      } catch (err) {
        throw new MCPError(`MCP 沙箱配置无法解析，拒绝启动全部服务器：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const [serverName, config] of Object.entries(this.servers)) {
      if (this.clients[serverName]) continue;
      // 缺口 17：按配置的 transport 选客户端——http 走 Streamable HTTP，
      // stdio 走子进程；两者的 listTools/callTool 公共面一致。
      const client: MCPTransportLike = config.transport === "http"
        ? new MCPHttpClient(config, this.timeout)
        : new MCPClient(config, this.timeout, resolved);
      try {
        client.start();
        const tools = await client.listTools();
        const schemas: McpToolSchema[] = [];
        const routes: Record<string, [string, string]> = {};
        for (const tool of tools) {
          const toolName = `mcp_${sanitizeMcpName(serverName)}_${sanitizeMcpName(tool.name)}`;
          if (this.toolRoutes[toolName] || routes[toolName]) throw new MCPError(`工具名称规范化后发生冲突：${toolName}`);
          const parameters = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
          schemas.push({
            type: "function",
            function: { name: toolName, description: `[${serverName}] ${tool.description}`, parameters },
          });
          routes[toolName] = [serverName, tool.name];
        }
        this.clients[serverName] = client;
        this.toolSchemas.push(...schemas);
        Object.assign(this.toolRoutes, routes);
      } catch (err) {
        try { client.stop(); } catch (stopErr) { process.stderr.write(`MCP 服务器 ${serverName} 清理失败：${stopErr instanceof Error ? stopErr.message : String(stopErr)}\n`); }
        process.stderr.write(`MCP 服务器 ${serverName} 启动失败：${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
    }
  }

  /** 把规范化工具名还原成 [服务器, 原始工具名]；找不到返回 null。 */
  routeFor(toolName: string): [string, string] | null {
    const route = this.toolRoutes[toolName];
    if (!route) return null;
    return route;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    const route = this.toolRoutes[toolName];
    if (!route) return `错误：未知 MCP 工具 ${toolName}`;
    const [serverName, rawName] = route;
    const client = this.clients[serverName];
    if (!client) return `错误：未知 MCP 工具 ${toolName}`;
    try { return await client.callTool(rawName, args); }
    catch (err) { return `MCP 调用失败：${err instanceof Error ? err.message : String(err)}`; }
  }

  hasTools(): boolean { return this.toolSchemas.length > 0; }

  stopAll(): void {
    const errors: string[] = [];
    for (const [name, client] of Object.entries(this.clients)) {
      try { client.stop(); } catch (err) { errors.push(`${name}：${err instanceof Error ? err.message : String(err)}`); }
    }
    this.clients = {};
    this.toolSchemas = [];
    this.toolRoutes = {};
    if (errors.length) throw new MCPError("停止 MCP 服务器失败：" + errors.join("；"));
  }
}

/**
 * 按执行权限决定是否启动 MCP 服务（Python agent.build_mcp_manager 同语义）：
 * readonly 或非交互 auto 一律不启动；交互 auto 逐服务器确认；full 直接启动。
 * 未启用（mcp_enabled 非真）或无服务器时返回 null。
 */
export async function buildMcpManager(
  opts: {
    mode?: string; interactive?: boolean; config?: Record<string, unknown>;
    askApproval?: (prompt: string) => Promise<boolean>;
    /** 沙箱配置（与 Agent/CLI 同款形状）；未传时服务器原样启动。 */
    sandbox?: McpSandboxOptions | null;
    /** 服务器进程的工作目录（bwrap/Seatbelt 绑定的工作区）；默认 process.cwd()。 */
    workdir?: string;
  },
): Promise<MCPToolManager | null> {
  const mode = opts.mode ?? "auto";
  const interactive = opts.interactive ?? false;
  if (mode !== "auto" && mode !== "full") return null;
  if (mode === "auto" && !interactive) return null;
  const config = opts.config ?? {};
  if (!config.mcp_enabled) return null;
  const servers = loadMcpServers(config);
  if (!Object.keys(servers).length) return null;
  let approved = servers;
  if (mode === "auto") {
    approved = {};
    for (const [name, server] of Object.entries(servers)) {
      process.stdout.write(`外部 MCP 服务 ${name} 将以当前系统用户启动，可能访问本机文件和网络。\n`);
      const ok = opts.askApproval ? await opts.askApproval(`允许启动该 MCP 服务吗？`) : false;
      if (ok) approved[name] = server;
    }
    if (!Object.keys(approved).length) return null;
  }
  const manager = new MCPToolManager(approved, 30.0, { sandbox: opts.sandbox ?? null, workdir: opts.workdir });
  await manager.startAll();
  if (!manager.hasTools()) { manager.stopAll(); return null; }
  return manager;
}

// ============================================================================
// 缺口 17：对外 MCP 服务——Nyra 当 MCP 服务器（Streamable HTTP，JSON-RPC）
// ============================================================================
// 动机（总报告 §3 缺口 17）：Nyra 只有 MCP 客户端（stdio），别的 agent 接
// 不进 Nyra 的记忆；Devin 双向 MCP、EverOS everos-mcp（7 个工具，含
// forget_session）、Turnstone MCP 服务器都已对外提供服务。
// Nyra 怎么做得更好：
// - 工具：记忆读写（search_memory / add_memory / forget_session，与缺口 2
//   的删除 API 同口径——进行中会话拒绝删除、revision 冲突拒绝）+ 任务派发
//   （dispatch_task）+ 证据查询（query_evidence），共 5 个；
// - 鉴权：走网关已有的 token（owner 或设备 token），不学 EverOS 本地无鉴权；
// - 审批：写操作须显式开 allow_writes，且每次都要过独立审查层（缺口 10）；
//   审查层未开启时写操作直接拒绝（fail-closed），不像市场那道门那样放行；
// - 证据：带 id 的每次调用都记一条 mcp_server_call 事件进运行记录（网关
//   每次对外服务调用复用一个“对外服务”运行，见 servingRunId），写操作的
//   审查结论另记一条 reviewer_verdict；每次调用另写一行审计
//   ~/.nyra/mcp-server-audit.jsonl；ping 与 notifications/* 是协议噪声，
//   只进审计、不进运行记录；
// - 默认：服务关闭、写操作关闭；端点关闭时当不存在（404），不泄露端点。
// 协议：无状态 Streamable HTTP（2026-07-28）——只回 JSON（暂不支持 SSE
// 流式回包），没有会话、不要求也不理会 Mcp-Session-Id；主路是 server/discover
// （回支持的版本列表 + capabilities + _meta 里的 serverInfo + 缓存提示），
// 请求带了不支持的协议版本时回 -32022 并列出支持的版本；initialize 只留给
// 不会 discover 的老客户端作兼容。批量请求（数组）不支持；通知（无 id）
// 不执行、不回包。

/** 对外 MCP 服务的审计文件（~/.nyra/mcp-server-audit.jsonl，一行一次调用）。 */
export const MCP_SERVER_AUDIT_FILE = "mcp-server-audit.jsonl";

/** 对外 MCP 服务配置（config.json 的 mcp_server 一节，默认全关）。 */
export interface McpServerConfig {
  enabled: boolean;
  allow_writes: boolean;
}

export function mcpServerConfig(config: Record<string, unknown>): McpServerConfig {
  const raw = (config.mcp_server ?? {}) as Record<string, unknown>;
  return { enabled: raw.enabled === true, allow_writes: raw.allow_writes === true };
}

/** 对外 MCP 服务的写操作对应的虚拟敏感动作（与 DEFAULT_REVIEWED_TOOLS 同名）。 */
export type McpServerWriteAction = "mcp_server_add_memory" | "mcp_server_forget_session" | "mcp_server_dispatch_task";

/** 对外 MCP 服务的工具定义（write=true 的只在 allow_writes 开启时出现）。 */
export interface McpServerToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 写操作（须 allow_writes + 审查层放行）。 */
  write: boolean;
  /** 审查层用的虚拟动作名（写操作才有）。 */
  action: McpServerWriteAction | null;
}

export const MCP_SERVER_TOOLS: McpServerToolDef[] = [
  {
    name: "search_memory",
    description: "BM25 检索 Nyra 的长期记忆（只读）。参数：query（必填），limit（默认 5，最多 20）。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    write: false, action: null,
  },
  {
    name: "query_evidence",
    description: "读某次运行的事件记录（证据链，只读）。参数：run_id（必填，格式如 20261120-120000-abcdef），limit（默认 20，最多 100）。",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, limit: { type: "number" } }, required: ["run_id"] },
    write: false, action: null,
  },
  {
    name: "answer_question",
    description: "问 Nyra 一个问题并等回答（只读：只读模式跑一小段 agent，最多 4 轮；回答截到 4000 字）。参数：question（必填，最多 2000 字）。",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    write: false, action: null,
  },
  {
    name: "add_memory",
    description: "往 Nyra 的长期记忆追加一条（写操作：须开启 allow_writes 且过独立审查）。参数：text（必填，最多 2000 字）。",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    write: true, action: "mcp_server_add_memory",
  },
  {
    name: "forget_session",
    description: "删除某个会话在长期记忆里的全部条目（写操作：须开启 allow_writes 且过独立审查；进行中的会话拒绝删除）。参数：session_id（必填）。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
    write: true, action: "mcp_server_forget_session",
  },
  {
    name: "dispatch_task",
    description: "给 Nyra 派一个任务（写操作：须开启 allow_writes 且过独立审查；任务进队列后按 readonly/auto 模式跑）。参数：task（必填，最多 8000 字），mode（readonly 或 auto，默认 readonly）。",
    inputSchema: { type: "object", properties: { task: { type: "string" }, mode: { type: "string", enum: ["readonly", "auto"] } }, required: ["task"] },
    write: true, action: "mcp_server_dispatch_task",
  },
];

/**
 * 对外 MCP 服务的写操作审查门（与 reviewMarketplaceAction 同款：把虚拟动作
 * 名合并进 reviewer.tools 再调 reviewToolCall，用户收窄 tools 也不影响这道门）。
 * 唯一不同：审查层未开启时直接 BLOCK（fail-closed）——对外服务面对的是外
 * 部客户端，默认不信任；市场那道门未开启时是放行（skipped）。
 */
export async function reviewMcpServerAction(opts: {
  config: Record<string, unknown>;
  home: string;
  action: McpServerWriteAction;
  args: Record<string, unknown>;
  task?: string;
  runner?: ReviewerLike | null;
}): Promise<ReviewVerdict> {
  if (reviewerEnabled(opts.config) !== true) {
    return {
      decision: "BLOCK",
      reason: "对外 MCP 服务的写操作须开启独立审查层（reviewer.enabled）：审查层未开启时写操作直接拒绝；请先用 nyra reviewer enable 开启审查层",
      reviewerModel: null,
      source: "unavailable",
    };
  }
  const reviewer = (opts.config.reviewer ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...opts.config,
    reviewer: {
      ...reviewer,
      tools: [...new Set([...(Array.isArray(reviewer.tools) ? (reviewer.tools as string[]) : []), opts.action])],
    },
  };
  const runner = opts.runner !== undefined ? opts.runner : buildReviewerRunner(opts.config, opts.home);
  return reviewToolCall({
    config: merged,
    tool: opts.action,
    args: opts.args,
    task: opts.task ?? "",
    runner,
  });
}

/** 对外 MCP 服务审计行：每次调用（包括鉴权失败）都写一行（时间戳自动加）。 */
export function appendMcpServerAudit(home: string, entry: Record<string, unknown>): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, MCP_SERVER_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

/** 参数指纹：键排序后 JSON 的 SHA-256（单向，不可还原原文；事件里记它）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function mcpArgsHash(args: unknown): string {
  return createHash("sha256").update(stableStringify(args ?? {}), "utf-8").digest("hex");
}

/** 协议层错误（JSON-RPC 错误码直回客户端；执行层失败走 isError 结果）。 */
class McpProtocolError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface McpServerContext {
  home: string;
  config: Record<string, unknown>;
  workdir?: string;
  /** 审查模型 runner 的解析器；不传时 reviewMcpServerAction 现场建一个。 */
  reviewerRunner?: () => ReviewerLike | null;
  /** 进行中会话 id 集合（forget_session 的 session_running 保护用）。 */
  activeSessionIds?: () => Iterable<string>;
  /** 缺口 12：answer_question 的回答器（测试注入假回答；不传时走默认
   * 的只读 agent 短跑：buildProvider + runOne，最多 4 轮，不记收件箱）。 */
  answerRunner?: (question: string, opts: { home: string; config: Record<string, unknown>; workdir: string }) => Promise<{ text: string; runId: string }>;
}

/**
 * 对外 MCP 服务器（无状态 JSON-RPC over HTTP，由网关 POST /mcp 接线）。
 * 一个实例对应一个网关进程：所有调用记进同一个“对外服务”运行（懒创建），
 * 这样每次调用都有运行记录可查，又不会每次调用都新建一个运行目录。
 */
/** 缺口 12：answer_question 的默认回答器——只读 agent 短跑（最多 4 轮，
 * 不记收件箱、不回邮件）。没有可用模型凭证时 buildProvider 直接抛错，
 * 调用方按工具执行失败（isError）回给对端。 */
export async function defaultAnswerRunner(question: string, opts: { home: string; config: Record<string, unknown>; workdir: string }): Promise<{ text: string; runId: string }> {
  const store = new RunStore(join(resolveNyraHome(opts.home), "runs"));
  const state = store.create(`对端提问：${question.slice(0, 200)}`, "peer-ask", opts.workdir, "readonly", 4, "running");
  const [provider] = buildProvider(opts.config, opts.home);
  const [, output] = await runOne(state, { store, provider, config: opts.config, home: opts.home, quietInbox: true });
  return { text: output, runId: state.run_id };
}

export class NyraMcpServer {
  private ctx: McpServerContext;
  private runId: string | null = null;

  constructor(ctx: McpServerContext) {
    this.ctx = ctx;
  }

  tools(): McpServerToolDef[] {
    const cfg = mcpServerConfig(this.ctx.config);
    return MCP_SERVER_TOOLS.filter((t) => !t.write || cfg.allow_writes);
  }

  private memoryPath(): string {
    return join(resolveNyraHome(this.ctx.home), "MEMORY.md");
  }

  private servingRunId(): string {
    if (this.runId) return this.runId;
    const store = new RunStore(join(resolveNyraHome(this.ctx.home), "runs"));
    const state = store.create("MCP server（对外服务）", "mcp-server", this.ctx.workdir ?? process.cwd(), "readonly", 1, "running");
    this.runId = state.run_id;
    return this.runId;
  }

  private appendRunEvent(type: string, fields: Record<string, unknown>): void {
    const store = new RunStore(join(resolveNyraHome(this.ctx.home), "runs"));
    store.appendEvent(this.servingRunId(), type, fields);
  }

  /** 每次带 id 的调用都记一条 mcp_server_call 事件 + 一行审计（失败也记）。 */
  private recordCall(fields: {
    tool: string;
    caller: string;
    args: unknown;
    ok: boolean;
    reviewer_decision?: string;
    run_id?: string;
    error?: string;
  }): void {
    const eventFields: Record<string, unknown> = {
      tool: fields.tool,
      caller: fields.caller,
      args_hash: mcpArgsHash(fields.args),
      ok: fields.ok,
    };
    if (fields.reviewer_decision) eventFields.reviewer_decision = fields.reviewer_decision;
    if (fields.run_id) eventFields.run_id = fields.run_id;
    if (fields.error) eventFields.error = fields.error.slice(0, 300);
    try { this.appendRunEvent("mcp_server_call", eventFields); } catch { /* 证据写失败不破坏调用 */ }
    try { appendMcpServerAudit(this.ctx.home, eventFields); } catch { /* 审计写失败不破坏调用 */ }
  }

  private errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  /**
   * 2026-07-28：server/discover——无状态发现（客户端探版本与能力的主路）。
   * 回 supportedVersions（只列无状态版）+ capabilities + _meta 里的 serverInfo
   * + 缓存提示 ttlMs/cacheScope（规范要求字段；工具列表随 allow_writes 开关变，
   * ttlMs 取 0 = 立即过期，客户端每次现取）。
   */
  private doDiscover(): Record<string, unknown> {
    return {
      supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      _meta: { [META_SERVER_INFO]: { name: "Nyra", version: VERSION } },
      ttlMs: 0,
      cacheScope: "public",
    };
  }

  /**
   * 旧版握手（2025-11-25 及更早）：只作兼容——老客户端（包括旧版 Nyra）
   * 不会调 server/discover，直接发 initialize；新客户端走 discover，
   * 不再经过这里。
   */
  private doInitialize(params: unknown): Record<string, unknown> {
    let version = LATEST_PROTOCOL_VERSION;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const asked = (params as Record<string, unknown>).protocolVersion;
      if (typeof asked === "string" && (MODERN_PROTOCOL_VERSIONS.includes(asked) || LEGACY_PROTOCOL_VERSIONS.includes(asked))) {
        version = asked;
      }
    }
    return {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: "Nyra", version: VERSION },
    };
  }

  /** 写操作审查门：结论（放行与拦截都）另记一条 reviewer_verdict 事件。 */
  private async reviewWrite(action: McpServerWriteAction, args: Record<string, unknown>, task: string): Promise<ReviewVerdict> {
    const verdict = await reviewMcpServerAction({
      config: this.ctx.config,
      home: this.ctx.home,
      action,
      args,
      task,
      runner: this.ctx.reviewerRunner ? this.ctx.reviewerRunner() : undefined,
    });
    try {
      this.appendRunEvent("reviewer_verdict", {
        tool: action,
        decision: verdict.decision,
        reason: verdict.reason,
        reviewer_model: verdict.reviewerModel ?? "",
        rule: verdict.rule ?? "",
      });
    } catch { /* 证据写失败不破坏调用 */ }
    return verdict;
  }

  private doSearchMemory(args: Record<string, unknown>): string {
    const query = args.query;
    if (typeof query !== "string" || !query.trim()) throw new McpProtocolError(-32602, "search_memory 须给 query（非空字符串）");
    const limitRaw = args.limit;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.min(20, Math.max(1, Math.floor(limitRaw))) : 5;
    const hits = searchMemoryEntries(this.memoryPath(), query.trim(), { limit, home: this.ctx.home });
    if (!hits.length) return "未找到相关记忆。";
    return formatMemorySearchResults(hits);
  }

  private doQueryEvidence(args: Record<string, unknown>): string {
    const runId = args.run_id;
    if (typeof runId !== "string" || !/^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(runId)) {
      throw new McpProtocolError(-32602, "query_evidence 须给 run_id（格式如 20261120-120000-abcdef）");
    }
    const limitRaw = args.limit;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 20;
    let events: Record<string, unknown>[] = [];
    for (const dir of ["runs", "tasks"]) {
      try {
        events = new RunStore(join(resolveNyraHome(this.ctx.home), dir)).readEvents(runId);
        if (events.length) break;
      } catch { /* 目录不存在时换下一个目录试 */ }
    }
    if (!events.length) return `未找到运行 ${runId} 的事件（可能不存在或尚未记录）。`;
    const tail = events.slice(-limit);
    const lines = tail.map((ev) => {
      const at = typeof ev.at === "string" ? ev.at : "";
      const type = typeof ev.type === "string" ? ev.type : "event";
      const rest = Object.entries(ev).filter(([k]) => k !== "at" && k !== "type")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
      return `${at} ${type}${rest ? " " + rest : ""}`;
    });
    return `运行 ${runId} 最近 ${tail.length} 条事件（共 ${events.length} 条）：\n` + lines.join("\n");
  }

  private async doAddMemory(args: Record<string, unknown>): Promise<{ text: string; reviewerDecision: string }> {
    const text = args.text;
    if (typeof text !== "string" || !text.trim()) throw new McpProtocolError(-32602, "add_memory 须给 text（非空字符串）");
    if (text.length > 2000) throw new McpProtocolError(-32602, "add_memory 的 text 最多 2000 字");
    const verdict = await this.reviewWrite("mcp_server_add_memory", args, text.trim().slice(0, 200));
    if (verdict.decision === "BLOCK") {
      return { text: `独立审查拦截了本次写入：${verdict.reason}`, reviewerDecision: "BLOCK" };
    }
    const before = new Set(listMemoryEntries(this.memoryPath(), this.ctx.home).map((e) => e.id));
    appendMemory(text.trim(), undefined, this.ctx.home, undefined, "mcp-server");
    const after = listMemoryEntries(this.memoryPath(), this.ctx.home);
    const created = after.find((e) => !before.has(e.id));
    return { text: `已记入长期记忆${created ? ` [${created.id}]` : ""}：${text.trim().slice(0, 200)}`, reviewerDecision: "ALLOW" };
  }

  private async doForgetSession(args: Record<string, unknown>): Promise<{ text: string; reviewerDecision: string }> {
    const sessionId = args.session_id;
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new McpProtocolError(-32602, "forget_session 须给 session_id（非空字符串）");
    const verdict = await this.reviewWrite("mcp_server_forget_session", args, `删除会话 ${sessionId.trim()} 的记忆`);
    if (verdict.decision === "BLOCK") {
      return { text: `独立审查拦截了本次删除：${verdict.reason}`, reviewerDecision: "BLOCK" };
    }
    const result = deleteMemoryEntries(this.memoryPath(), {
      session_id: sessionId.trim(),
      home: this.ctx.home,
      activeSessionIds: this.ctx.activeSessionIds ? this.ctx.activeSessionIds() : [],
    });
    return { text: `已删除会话 ${sessionId.trim()} 的 ${result.deleted.length} 条记忆，还剩 ${result.remaining} 条。`, reviewerDecision: "ALLOW" };
  }

  private async doDispatchTask(args: Record<string, unknown>): Promise<{ text: string; reviewerDecision: string; runId: string }> {
    const task = args.task;
    if (typeof task !== "string" || !task.trim()) throw new McpProtocolError(-32602, "dispatch_task 须给 task（非空字符串）");
    const modeRaw = args.mode ?? "readonly";
    if (modeRaw !== "readonly" && modeRaw !== "auto") throw new McpProtocolError(-32602, "dispatch_task 的 mode 只能是 readonly 或 auto");
    const verdict = await this.reviewWrite("mcp_server_dispatch_task", args, task.trim().slice(0, 200));
    if (verdict.decision === "BLOCK") {
      return { text: `独立审查拦截了本次派发：${verdict.reason}`, reviewerDecision: "BLOCK", runId: "" };
    }
    // 第 2 批 G-P1-10：MCP 派发的任务来源记 peer（对外服务接进来的任务
    // 一律按对端任务处理，写操作进提议门，不直接执行）。来源记失败时
    // addTask 直接抛错——这条任务不该悄悄按 local 跑。
    const created = await addTask(task.trim(), { mode: modeRaw, home: this.ctx.home, config: this.ctx.config, origin: "peer" });
    return { text: `任务已入队：run_id ${created.run_id}（模式 ${modeRaw}，状态 queued）`, reviewerDecision: "ALLOW", runId: created.run_id };
  }

  /**
   * 缺口 12：answer_question——问本机 Nyra 一个问题并等回答（只读）。
   * 只读 agent 短跑（最多 4 轮），回答截到 4000 字；本次回答另建一条运行
   * 记录（run_id 回给调用方，调用方可再用 query_evidence 查它的事件）。
   * 注意：回答花的是本机的 token（对端问、本机付），网关只在服务开启时
   * 才接这类调用；没有可用模型凭证时回 isError，不走 JSON-RPC 错误。
   */
  private async doAnswerQuestion(args: Record<string, unknown>): Promise<{ text: string; runId: string }> {
    const question = args.question;
    if (typeof question !== "string" || !question.trim()) throw new McpProtocolError(-32602, "answer_question 须给 question（非空字符串）");
    if (question.length > 2000) throw new McpProtocolError(-32602, "answer_question 的 question 最多 2000 字");
    const workdir = this.ctx.workdir ?? process.cwd();
    const runner = this.ctx.answerRunner ?? defaultAnswerRunner;
    const { text, runId } = await runner(question.trim(), { home: this.ctx.home, config: this.ctx.config, workdir });
    return { text: text.slice(0, 4000), runId };
  }

  /**
   * 处理一次 JSON-RPC 请求。返回 HTTP 状态与响应体（body 为 null 时回 202 空体，
   * 用于通知）。协议层错误（未知方法、参数无效）回 JSON-RPC 错误码；工具执
   * 行层失败（审查拦截、删除冲突等）回 isError 结果，不走 JSON-RPC 错误。
   */
  async handle(body: unknown, caller: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
    if (!mcpServerConfig(this.ctx.config).enabled) {
      return { status: 200, body: this.errorResponse(null, -32603, "对外 MCP 服务未开启") };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: 200, body: this.errorResponse(null, -32600, "Invalid Request：请求体必须是 JSON-RPC 对象") };
    }
    const msg = body as Record<string, unknown>;
    const id = (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    const method = msg.method;
    if (typeof method !== "string" || !method) {
      return { status: 200, body: this.errorResponse(id, -32600, "Invalid Request：缺少 method") };
    }
    // 通知（无 id）不执行、不回包：notifications/* 是协议握手噪声，连审计都不记。
    if (id === null) {
      if (!method.startsWith("notifications/")) {
        try { appendMcpServerAudit(this.ctx.home, { tool: method, caller, ok: false, error: "无 id 的通知不执行" }); } catch { /* ignore */ }
      }
      return { status: 202, body: null };
    }
    const params = msg.params ?? {};
    // 2026-07-28：请求自带协议版本（params._meta）；带了不支持的版本时回
    // -32022 并列出支持的版本（客户端据此挑版本重试）；没带 _meta 的当旧
    // 客户端兼容（initialize 路径本就无 _meta）；discover/initialize/ping
    // 不做版本检查（discover 本就是探版本的口子）。
    if (method !== "server/discover" && method !== "initialize" && method !== "ping") {
      const meta = params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)._meta : undefined;
      const asked = meta && typeof meta === "object"
        ? (meta as Record<string, unknown>)[META_PROTOCOL_VERSION] : undefined;
      if (typeof asked === "string" && !MODERN_PROTOCOL_VERSIONS.includes(asked)) {
        return { status: 200, body: { jsonrpc: "2.0", id, error: { code: UNSUPPORTED_PROTOCOL_VERSION_CODE, message: `不支持的协议版本：${asked}`, data: { supported: [...MODERN_PROTOCOL_VERSIONS] } } } };
      }
    }
    try {
      let result: Record<string, unknown>;
      let toolName = method;
      let reviewerDecision: string | undefined;
      let runId: string | undefined;
      let ok = true;
      let errorText: string | undefined;
      if (method === "server/discover") {
        result = this.doDiscover();
      } else if (method === "initialize") {
        result = this.doInitialize(params);
      } else if (method === "ping") {
        result = {};
      } else if (method === "tools/list") {
        result = { tools: this.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      } else if (method === "tools/call") {
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          throw new McpProtocolError(-32602, "tools/call 的 params 必须是字典（含 name 与 arguments）");
        }
        const name = (params as Record<string, unknown>).name;
        if (typeof name !== "string" || !name) throw new McpProtocolError(-32602, "tools/call 须给 name（字符串）");
        const def = this.tools().find((t) => t.name === name);
        if (!def) throw new McpProtocolError(-32602, `未知工具：${name}`);
        const args = (params as Record<string, unknown>).arguments;
        const argsObj: Record<string, unknown> = args && typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown> : {};
        toolName = name;
        let text: string;
        let isError = false;
        try {
          if (name === "search_memory") {
            text = this.doSearchMemory(argsObj);
          } else if (name === "query_evidence") {
            text = this.doQueryEvidence(argsObj);
          } else if (name === "answer_question") {
            const out = await this.doAnswerQuestion(argsObj);
            text = out.text;
            if (out.runId) runId = out.runId;
          } else if (name === "add_memory") {
            const out = await this.doAddMemory(argsObj);
            text = out.text; isError = out.reviewerDecision === "BLOCK"; reviewerDecision = out.reviewerDecision;
          } else if (name === "forget_session") {
            const out = await this.doForgetSession(argsObj);
            text = out.text; isError = out.reviewerDecision === "BLOCK"; reviewerDecision = out.reviewerDecision;
          } else {
            const out = await this.doDispatchTask(argsObj);
            text = out.text; isError = out.reviewerDecision === "BLOCK"; reviewerDecision = out.reviewerDecision;
            if (out.runId) runId = out.runId;
          }
        } catch (err) {
          // 执行层失败（审查拦截已在上面回 isError；这里是删除冲突、入队失败
          // 等）——按 MCP 口径回 isError 结果，不走 JSON-RPC 错误；参数无效
          //（McpProtocolError）继续向上抛，走 -32602。
          if (err instanceof McpProtocolError) throw err;
          text = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
          isError = true;
          errorText = err instanceof Error ? err.message : String(err);
        }
        if (isError) { ok = false; errorText = errorText ?? text; }
        result = { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
      } else {
        return { status: 200, body: this.errorResponse(id, -32601, `Method not found：${method}`) };
      }
      this.recordCall({ tool: toolName, caller, args: params, ok, reviewer_decision: reviewerDecision, run_id: runId, error: errorText });
      return { status: 200, body: { jsonrpc: "2.0", id, result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordCall({ tool: method, caller, args: params, ok: false, error: message });
      if (err instanceof McpProtocolError) {
        return { status: 200, body: this.errorResponse(id, err.code, message) };
      }
      return { status: 200, body: this.errorResponse(id, -32603, message) };
    }
  }
}

/**
 * CLI：nyra mcp server <status|enable|disable|allow-writes-on|allow-writes-off>。
 * 与 nyra reviewer/verifier 同款退出码：0 成功、2 用法错误。
 */
export async function handleMcpServer(argv: string[], home: string): Promise<number> {
  const resolvedHome = home || resolveHome();
  // H7：nyra mcp contract —— 打印最小稳定契约 nyra-contract-v1（只读，
  // 服务关着也能看）。动态 import：agentContract.ts 读 MCP_SERVER_TOOLS，
  // 静态互引会成环。
  if (argv[0] === "contract") {
    const { agentContract, validateAgentContract } = await import("./agentContract.ts");
    const contract = agentContract();
    const problems = validateAgentContract();
    process.stdout.write(`最小稳定契约 ${contract.id}（版本 ${contract.version}）\n`);
    process.stdout.write("Bot 之间互操作、市场里的 Bot 调别的 Bot，都只走这 10 条命令；\n");
    process.stdout.write("每条都对应一个已有的 MCP 工具或 A2A 方法，不另起协议。详见 docs/agent-contract.md。\n");
    for (const cmd of contract.commands) {
      const via = cmd.surface === "mcp"
        ? `MCP ${cmd.mcpTool}`
        : cmd.surface === "a2a"
          ? `A2A ${cmd.a2aMethod}`
          : `MCP ${cmd.mcpTool} / A2A ${cmd.a2aMethod}`;
      process.stdout.write(`  ${cmd.name}（${cmd.title}）${cmd.write ? " [写]" : " [只读]"}：${cmd.description} 走 ${via}。\n`);
    }
    if (problems.length) {
      process.stderr.write(`契约自检发现 ${problems.length} 个问题：${problems.join("；")}\n`);
      return 1;
    }
    return 0;
  }
  if (argv[0] !== "server") {
    process.stdout.write("用法：nyra mcp <server <status|enable|disable|allow-writes-on|allow-writes-off>|contract>\n");
    return 2;
  }
  const action = argv[1];
  if (!action) {
    process.stdout.write("用法：nyra mcp server <status|enable|disable|allow-writes-on|allow-writes-off>\n");
    return 2;
  }
  const config = loadConfig(resolvedHome);
  const cfg = mcpServerConfig(config);
  if (action === "status") {
    const reviewer = reviewerEnabled(config);
    const model = resolveReviewerModel(config);
    process.stdout.write(`对外 MCP 服务：${cfg.enabled ? "启用" : "禁用（默认关闭）"}\n`);
    process.stdout.write(`写操作：${cfg.allow_writes ? "允许（每次写操作仍须过独立审查层）" : "不允许（默认只读）"}\n`);
    process.stdout.write(`独立审查层：${reviewer ? `已开启（${model.provider}:${model.model}）` : "未开启（写操作将直接拒绝）"}\n`);
    process.stdout.write(`工具：${cfg.enabled ? (cfg.allow_writes ? "search_memory、query_evidence、add_memory、forget_session、dispatch_task" : "search_memory、query_evidence（只读）") : "（服务未开启）"}\n`);
    process.stdout.write("端点：POST /mcp（网关 token 鉴权，见 docs/mcp.md）\n");
    return 0;
  }
  if (action === "enable" || action === "disable") {
    saveConfig(resolvedHome, { mcp_server: { ...cfg, enabled: action === "enable" } });
    process.stdout.write(`对外 MCP 服务已${action === "enable" ? "启用（POST /mcp，网关 token 鉴权；默认只读）" : "禁用"}\n`);
    return 0;
  }
  if (action === "allow-writes-on" || action === "allow-writes-off") {
    saveConfig(resolvedHome, { mcp_server: { ...cfg, allow_writes: action === "allow-writes-on" } });
    process.stdout.write(`对外 MCP 服务写操作已${action === "allow-writes-on" ? "允许（每次写操作仍须过独立审查层；审查层未开启时写操作直接拒绝）" : "关闭（只读）"}\n`);
    return 0;
  }
  process.stderr.write(`错误：未知动作 ${action}，用法：nyra mcp server <status|enable|disable|allow-writes-on|allow-writes-off>\n`);
  return 2;
}
