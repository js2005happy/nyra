// src/commandBackends.ts — G-P1-39：命令后端可换（Hermes terminal_env_registry
// 借鉴：local / docker / modal / daytona / vercel_sandbox / ssh，插件可注册更多）。
//
// 两件事：
//   1. 后端注册表 + 配置（`~/.nyra/command-backends.json`，0600 原子写）：
//      当前后端、Docker 镜像、SSH 目标、E2B 模板/超时。默认后端永远是本机
//     （local），换后端须机主显式操作（`nyra backend use` 或 `--backend`）。
//   2. 远端执行器：Docker（本机 docker CLI 真跑）、SSH（真 ssh 远端执行）、
//      E2B 控制面（list/create/kill 走 api.e2b.dev REST，凭据只读环境变量
//      E2B_API_KEY，绝不落盘）。
//
// 不做的事（诚实口径）：
//   - modal / daytona / vercel_sandbox 只注册 + 报未配置，不接真 API——
//     云计算器商业决策未定（报告原文约束），接线等决策后再做。
//   - E2B 命令执行未接线：控制面 REST 只有 list/create/get/kill，沙箱内跑
//     命令要走沙箱里的 envd agent（gRPC，SDK 负责），不是控制面 REST 能做
//     的事；`--sandbox e2b` / backend e2b 跑命令时 fail-closed 报错，
//     不静默回落本机。详见 docs/sandbox.md 的 e2b 一节。
//   - 所有后端执行都先过审批与 shell 黑名单（在 src/tools.ts 的 toolShell
//     里，后端分发在审批之后、执行之前，与沙箱同款两轴分工）。
//
// 本模块是叶子：只引 node 内置。执行器用可注入的 runner/fetch，测试 mock-only。
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { delimiter, join } from "node:path";

export class CommandBackendError extends Error {
  constructor(message: string) { super(message); this.name = "CommandBackendError"; }
}

/** E2B 没配 key 时抛这个：调用方据此报“未配置”，绝不静默回落本机。 */
export class E2bNotConfiguredError extends Error {
  constructor(message: string) { super(message); this.name = "E2bNotConfiguredError"; }
}

/** E2B 命令执行未接线时抛这个（控制面 REST 没有跑命令的接口，须 SDK）。 */
export class E2bExecutionUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "E2bExecutionUnsupportedError"; }
}

// ---- 注册表 -------------------------------------------------------------

export type CommandBackendKind = "local" | "remote" | "cloud";

export interface CommandBackendDescriptor {
  id: string;
  label: string;
  kind: CommandBackendKind;
  /** 一句话说明（`nyra backend list` 直接印）。 */
  description: string;
  /** 配好它需要什么（`nyra backend status` 里逐项报）。 */
  requires: string[];
}

export const BUILTIN_COMMAND_BACKENDS: readonly CommandBackendDescriptor[] = [
  { id: "local", label: "本机", kind: "local", description: "宿主机直接跑（工具级隔离 + 沙箱，默认）", requires: [] },
  { id: "docker", label: "Docker", kind: "local", description: "本机 docker run 起容器跑命令", requires: ["本机装 docker 且 daemon 在跑"] },
  { id: "modal", label: "Modal", kind: "cloud", description: "Modal 云端执行（未接线，等云端商业决策）", requires: ["云端商业决策", "Modal API 凭据"] },
  { id: "daytona", label: "Daytona", kind: "cloud", description: "Daytona 云端执行（未接线，等云端商业决策）", requires: ["云端商业决策", "Daytona API 凭据"] },
  { id: "vercel_sandbox", label: "Vercel Sandbox", kind: "cloud", description: "Vercel 云端沙箱（未接线，等云端商业决策）", requires: ["云端商业决策", "Vercel API 凭据"] },
  { id: "ssh", label: "SSH", kind: "remote", description: "ssh 到指定主机上跑命令", requires: ["ssh 目标 host（user@host）"] },
  { id: "e2b", label: "E2B", kind: "cloud", description: "E2B 云沙箱控制面（list/create/kill 已接；沙箱内跑命令须 SDK，未接线）", requires: ["E2B_API_KEY 环境变量"] },
];

const BUILTIN_IDS = new Set(BUILTIN_COMMAND_BACKENDS.map((b) => b.id));
const registry = new Map<string, CommandBackendDescriptor>(
  BUILTIN_COMMAND_BACKENDS.map((b) => [b.id, b]),
);

/** 注册表快照（内置 7 个在前，按注册顺序排插件后端）。 */
export function listCommandBackends(): CommandBackendDescriptor[] {
  return [...registry.values()];
}

export function getCommandBackend(id: string): CommandBackendDescriptor | null {
  return registry.get(id) ?? null;
}

export function isKnownCommandBackend(id: string): boolean {
  return registry.has(id);
}

/** 插件注册更多后端：重名直接报错，不静默覆盖（与 voiceHooks 同款）。 */
export function registerCommandBackend(desc: CommandBackendDescriptor): void {
  if (!/^[a-z0-9_]+$/.test(desc.id)) {
    throw new CommandBackendError(`后端 id 只认小写字母、数字与下划线：${desc.id}`);
  }
  if (registry.has(desc.id)) {
    throw new CommandBackendError(`命令后端 ${desc.id} 已注册，不静默覆盖；先 unregister 再注册`);
  }
  registry.set(desc.id, desc);
}

/** 只允许注销插件注册的后端：内置后端与不存在的 id 都报错。 */
export function unregisterCommandBackend(id: string): void {
  if (BUILTIN_IDS.has(id)) throw new CommandBackendError(`内置后端 ${id} 不能注销`);
  if (!registry.delete(id)) throw new CommandBackendError(`命令后端 ${id} 未注册，无可注销`);
}

// ---- 配置文件 ~/.nyra/command-backends.json -------------------------------

export interface CommandBackendConfig {
  active: string;
  docker: { image: string; extra_args: string[] };
  ssh: { host: string | null; port: number; key_file: string | null; remote_workdir: string | null };
  e2b: { template: string; timeout: number; sandbox_id: string | null };
}

export function defaultCommandBackendConfig(): CommandBackendConfig {
  return {
    active: "local",
    docker: { image: "debian:bookworm-slim", extra_args: [] },
    ssh: { host: null, port: 22, key_file: null, remote_workdir: null },
    e2b: { template: "base", timeout: 1800, sandbox_id: null },
  };
}

function backendsPath(home: string): string {
  return join(home, "command-backends.json");
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { renameSync(tmp, path); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
}

function sanitizeConfig(raw: unknown): CommandBackendConfig {
  const d = defaultCommandBackendConfig();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const active = typeof o.active === "string" && isKnownCommandBackend(o.active) ? o.active : "local";
  const docker = (o.docker ?? {}) as Record<string, unknown>;
  const ssh = (o.ssh ?? {}) as Record<string, unknown>;
  const e2b = (o.e2b ?? {}) as Record<string, unknown>;
  const port = typeof ssh.port === "number" && Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port < 65536 ? ssh.port : 22;
  const timeout = typeof e2b.timeout === "number" && Number.isInteger(e2b.timeout) && e2b.timeout > 0 ? e2b.timeout : 1800;
  return {
    active,
    docker: {
      image: typeof docker.image === "string" && docker.image.trim() ? docker.image : d.docker.image,
      extra_args: Array.isArray(docker.extra_args) ? docker.extra_args.filter((x): x is string => typeof x === "string") : [],
    },
    ssh: {
      host: typeof ssh.host === "string" && ssh.host.trim() ? ssh.host : null,
      port,
      key_file: typeof ssh.key_file === "string" && ssh.key_file.trim() ? ssh.key_file : null,
      remote_workdir: typeof ssh.remote_workdir === "string" && ssh.remote_workdir.trim() ? ssh.remote_workdir : null,
    },
    e2b: {
      template: typeof e2b.template === "string" && e2b.template.trim() ? e2b.template : "base",
      timeout,
      sandbox_id: typeof e2b.sandbox_id === "string" && e2b.sandbox_id.trim() ? e2b.sandbox_id : null,
    },
  };
}

/** 读配置：文件不存在回默认；损坏先备份再回默认（fail-open，默认 local 最安全）。 */
export function loadCommandBackendConfig(home: string): CommandBackendConfig {
  const p = backendsPath(home);
  if (!existsSync(p)) return defaultCommandBackendConfig();
  if (lstatSync(p).isSymbolicLink()) {
    throw new CommandBackendError("命令后端配置文件不能是符号链接");
  }
  try {
    return sanitizeConfig(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    try { copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch { /* 备份失败也不破坏运行 */ }
    return defaultCommandBackendConfig();
  }
}

export function saveCommandBackendConfig(home: string, cfg: CommandBackendConfig): void {
  const p = backendsPath(home);
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
    throw new CommandBackendError("命令后端配置文件不能是符号链接");
  }
  atomicWriteJson(p, sanitizeConfig(cfg));
}

/** 生效的后端：显式 flag > NYRA_COMMAND_BACKEND 环境变量 > 配置文件 active。 */
export function resolveActiveBackend(
  home: string,
  flag?: string | null,
): { id: string; config: CommandBackendConfig } {
  const config = loadCommandBackendConfig(home);
  const raw = flag ?? process.env.NYRA_COMMAND_BACKEND ?? process.env.ANGEL_COMMAND_BACKEND ?? config.active;
  if (!isKnownCommandBackend(raw)) {
    throw new CommandBackendError(`未知的命令后端：${raw}。可选：${listCommandBackends().map((b) => b.id).join(", ")}`);
  }
  return { id: raw, config };
}

/** 机主显式切换当前后端：未知 id 直接拒绝，不写文件。 */
export function setActiveBackend(home: string, id: string): CommandBackendConfig {
  if (!isKnownCommandBackend(id)) {
    throw new CommandBackendError(`未知的命令后端：${id}。可选：${listCommandBackends().map((b) => b.id).join(", ")}`);
  }
  const cfg = loadCommandBackendConfig(home);
  cfg.active = id;
  saveCommandBackendConfig(home, cfg);
  return cfg;
}

// ---- 可用性探测 -----------------------------------------------------------

export interface BackendProbe {
  id: string;
  /** available=true 才能真的跑命令；configured 只是“配好了”（ssh/e2b 不拨号探测）。 */
  status: "available" | "configured" | "not_configured" | "unavailable";
  detail: string;
}

export interface ProbeDeps {
  /** docker 二进制是否在 PATH 里（默认真探测）。 */
  dockerInstalled?: boolean;
  /** `docker info` 的跑法（默认真跑，5 秒超时）；返回退出码。 */
  dockerInfo?: () => Promise<number>;
  /** E2B_API_KEY 是否已设（默认读环境变量）。 */
  e2bApiKeyPresent?: boolean;
}

/** docker 是否装了：遍历 PATH 查可执行位（与 sandbox.ts 的 detectBwrap 同款）。 */
export function detectDockerBinary(pathEnv?: string): boolean {
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "docker");
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch { /* 不存在或不可读就继续找下一个 PATH 目录 */ }
  }
  return false;
}

export async function probeBackend(id: string, home: string, deps?: ProbeDeps): Promise<BackendProbe> {
  const desc = getCommandBackend(id);
  if (!desc) return { id, status: "unavailable", detail: `未知的命令后端：${id}` };
  if (id === "local") return { id, status: "available", detail: "本机直接跑（工具级隔离 + 沙箱）" };
  if (id === "docker") {
    const installed = deps?.dockerInstalled ?? detectDockerBinary();
    if (!installed) return { id, status: "unavailable", detail: "本机没装 docker（PATH 里找不到 docker）；装好并启动 daemon 后再用" };
    const info = deps?.dockerInfo ?? (async () => {
      try {
        const r = await runProcess(["docker", "info"], { timeout: 5 });
        return r.code;
      } catch { return -1; }
    });
    const code = await info();
    if (code !== 0) return { id, status: "unavailable", detail: "docker 已装但 daemon 未响应（docker info 非 0）；先启动 Docker daemon" };
    return { id, status: "available", detail: "docker 可用（daemon 在跑）" };
  }
  if (id === "ssh") {
    const cfg = loadCommandBackendConfig(home);
    if (!cfg.ssh.host) return { id, status: "not_configured", detail: "没配 ssh 目标：先 `nyra backend ssh --host user@host` 配好" };
    if (cfg.ssh.key_file && !existsSync(cfg.ssh.key_file)) {
      return { id, status: "not_configured", detail: `ssh 密钥文件不存在：${cfg.ssh.key_file}` };
    }
    return { id, status: "configured", detail: `目标 ${cfg.ssh.host}${cfg.ssh.port !== 22 ? `:${cfg.ssh.port}` : ""}（只认配置，不拨号探测）` };
  }
  if (id === "e2b") {
    const present = deps?.e2bApiKeyPresent ?? Boolean(process.env.E2B_API_KEY);
    if (!present) return { id, status: "not_configured", detail: "没配 E2B_API_KEY 环境变量；配好后控制面（list/create/kill）可用，沙箱内跑命令仍须 SDK" };
    return { id, status: "configured", detail: "E2B_API_KEY 已设：控制面可用；沙箱内跑命令须 SDK，未接线" };
  }
  // modal / daytona / vercel_sandbox：云端商业决策未定，只注册不接线。
  return { id, status: "not_configured", detail: `${desc.label} 未接线：等云端商业决策后再接（不花钱、不自动开通）` };
}

/** 全部后端一句话状态（`nyra backend list/status` 用）。 */
export async function probeAllBackends(home: string, deps?: ProbeDeps): Promise<BackendProbe[]> {
  const out: BackendProbe[] = [];
  for (const b of listCommandBackends()) out.push(await probeBackend(b.id, home, deps));
  return out;
}

// ---- 进程执行（docker / ssh 共用） ----------------------------------------

export interface RunProcessOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  onStream?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface RunProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (argv: string[], opts: RunProcessOptions) => Promise<RunProcessResult>;

/** 默认 runner：spawn + 整进程组杀 + 超时（与 sandbox.ts 的 runSandboxed 同款语义）。 */
export function defaultProcessRunner(argv: string[], opts: RunProcessOptions): Promise<RunProcessResult> {
  const [cmd, ...args] = argv;
  const timeoutMs = (opts.timeout ?? 60) * 1000;
  if (opts.signal?.aborted) return Promise.reject(new Error("已取消"));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const killTree = (): void => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* 回退到单进程 */ }
      }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    const finish = (value: RunProcessResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };
    const onAbort = (): void => { killTree(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      setTimeout(() => finish({ code: -1, stdout, stderr: stderr + `\n错误：命令超时（${opts.timeout ?? 60} 秒）` }), 1000);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      stdout += text;
      try { opts.onStream?.("stdout", text); } catch { /* ignore */ }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      stderr += text;
      try { opts.onStream?.("stderr", text); } catch { /* ignore */ }
    });
    child.on("close", (code) => {
      if (timedOut) { finish({ code: -1, stdout, stderr: stderr + `\n错误：命令超时（${opts.timeout ?? 60} 秒）` }); return; }
      finish({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      opts.signal?.removeEventListener("abort", onAbort);
      rejectPromise(err);
    });
  });
}

/** 真跑一个 argv：测试用注入 runner 替掉（见 ProcessRunner）。 */
export async function runProcess(argv: string[], opts: RunProcessOptions, runner?: ProcessRunner): Promise<RunProcessResult> {
  return (runner ?? defaultProcessRunner)(argv, opts);
}

// ---- shell 单引号转义（ssh 远端命令拼接用） -------------------------------

/** 用单引号包起来，里面的单引号写成 '\''（POSIX 标准写法，可单测）。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- Docker 后端 -----------------------------------------------------------

export interface DockerRunOptions {
  workdir: string;
  image?: string;
  extraArgs?: string[];
  allowNet?: boolean;
  mode?: "read-only" | "workspace-write";
  timeout?: number;
  signal?: AbortSignal;
  onStream?: (stream: "stdout" | "stderr", text: string) => void;
  runner?: ProcessRunner;
}

/** docker run 的 argv（纯函数，可单测；真跑用 runDockerCommand）。 */
export function buildDockerArgv(command: string, opts: DockerRunOptions): string[] {
  const image = opts.image?.trim() ? opts.image : "debian:bookworm-slim";
  const bind = opts.mode === "read-only" ? `${opts.workdir}:${opts.workdir}:ro` : `${opts.workdir}:${opts.workdir}`;
  return [
    "docker", "run", "--rm", "-i",
    ...(opts.allowNet ? [] : ["--network", "none"]),
    "-v", bind, "-w", opts.workdir,
    ...(opts.extraArgs ?? []),
    image, "/bin/sh", "-c", command,
  ];
}

export async function runDockerCommand(command: string, opts: DockerRunOptions): Promise<RunProcessResult> {
  const argv = buildDockerArgv(command, opts);
  const runner = opts.runner ?? defaultProcessRunner;
  return runner(argv, { timeout: opts.timeout ?? 60, signal: opts.signal, onStream: opts.onStream });
}

// ---- SSH 后端 --------------------------------------------------------------

export interface SshRunOptions {
  host: string;
  port?: number;
  keyFile?: string | null;
  remoteWorkdir?: string | null;
  timeout?: number;
  signal?: AbortSignal;
  onStream?: (stream: "stdout" | "stderr", text: string) => void;
  runner?: ProcessRunner;
}

export function validateSshHost(host: string): void {
  if (!host.trim() || /\s/.test(host) || host.startsWith("-")) {
    throw new CommandBackendError(`ssh 目标不合法：${host}（应为 user@host，不含空格）`);
  }
}

/** ssh 的 argv（纯函数，可单测）：远端命令整段当一个参数传，BatchMode 防挂起。 */
export function buildSshArgv(command: string, opts: SshRunOptions): string[] {
  validateSshHost(opts.host);
  const remote = opts.remoteWorkdir
    ? `cd ${shellQuote(opts.remoteWorkdir)} && sh -c ${shellQuote(command)}`
    : `sh -c ${shellQuote(command)}`;
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    ...(opts.port && opts.port !== 22 ? ["-p", String(opts.port)] : []),
    ...(opts.keyFile ? ["-i", opts.keyFile] : []),
    opts.host, remote,
  ];
}

export async function runSshCommand(command: string, opts: SshRunOptions): Promise<RunProcessResult> {
  const argv = buildSshArgv(command, opts);
  const runner = opts.runner ?? defaultProcessRunner;
  return runner(argv, { timeout: opts.timeout ?? 60, signal: opts.signal, onStream: opts.onStream });
}

// ---- E2B 控制面（REST，凭据只读环境变量） ----------------------------------

const E2B_API_BASE = "https://api.e2b.dev";

export type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

function defaultFetch(url: string, init: Record<string, unknown>): Promise<{ status: number; text: () => Promise<string> }> {
  return fetch(url, { ...init, redirect: "manual" }) as unknown as Promise<{ status: number; text: () => Promise<string> }>;
}

export function e2bApiKey(): string | null {
  const k = process.env.E2B_API_KEY;
  return k && k.trim() ? k : null;
}

async function e2bCall(
  method: string,
  path: string,
  body: unknown | undefined,
  fetchFn: FetchFn,
): Promise<unknown> {
  const key = e2bApiKey();
  if (!key) {
    throw new E2bNotConfiguredError("E2B 未配置：请设置 E2B_API_KEY 环境变量（Key 只走环境变量，不写进配置文件）");
  }
  const res = await fetchFn(`${E2B_API_BASE}${path}`, {
    method,
    headers: { "X-API-Key": key, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status >= 300 && res.status < 400) {
    throw new CommandBackendError(`E2B 请求被重定向（${res.status}），已拒绝：请检查 E2B 地址是否正确`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CommandBackendError(`E2B 请求失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!text.trim()) return { status: res.status };
  try { return JSON.parse(text); } catch {
    throw new CommandBackendError(`E2B 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

/** 列出正在跑的 E2B 沙箱（控制面，GET /sandboxes）。 */
export async function e2bListSandboxes(fetchFn: FetchFn = defaultFetch): Promise<unknown> {
  return e2bCall("GET", "/sandboxes", undefined, fetchFn);
}

/** 新建一个 E2B 沙箱（控制面，POST /sandboxes；只建不跑命令）。 */
export async function e2bCreateSandbox(
  opts: { template?: string; timeout?: number },
  fetchFn: FetchFn = defaultFetch,
): Promise<unknown> {
  return e2bCall("POST", "/sandboxes", {
    templateID: opts.template ?? "base",
    timeout: opts.timeout ?? 1800,
  }, fetchFn);
}

/** 查一个 E2B 沙箱（控制面，GET /sandboxes/:id）。 */
export async function e2bGetSandbox(sandboxId: string, fetchFn: FetchFn = defaultFetch): Promise<unknown> {
  if (!sandboxId.trim()) throw new CommandBackendError("sandbox id 不能为空");
  return e2bCall("GET", `/sandboxes/${encodeURIComponent(sandboxId)}`, undefined, fetchFn);
}

/** 杀掉一个 E2B 沙箱（控制面，DELETE /sandboxes/:id）。 */
export async function e2bKillSandbox(sandboxId: string, fetchFn: FetchFn = defaultFetch): Promise<unknown> {
  if (!sandboxId.trim()) throw new CommandBackendError("sandbox id 不能为空");
  return e2bCall("DELETE", `/sandboxes/${encodeURIComponent(sandboxId)}`, undefined, fetchFn);
}

/** E2B 模板/超时/沙箱 id：以后端配置文件为准；沙箱 id 为空时 config.json 的
 * e2b_sandbox_id 作回退（模板与超时在后端配置里恒有默认值，不再回退）。 */
export function resolveE2bSettings(
  home: string,
  configJson?: Record<string, unknown> | null,
): { template: string; timeout: number; sandboxId: string | null } {
  const cfg = loadCommandBackendConfig(home).e2b;
  return {
    template: cfg.template,
    timeout: cfg.timeout,
    sandboxId: cfg.sandbox_id || (configJson?.e2b_sandbox_id as string | undefined) || null,
  };
}

// ---- 后端分发（tools.ts 的 toolShell 用） -----------------------------------

export interface CommandBackendDeps {
  dockerRunner?: ProcessRunner;
  sshRunner?: ProcessRunner;
  fetchFn?: FetchFn;
}

export interface BackendRunOptions {
  home: string;
  workdir: string;
  allowNet?: boolean;
  mode?: "read-only" | "workspace-write";
  timeout?: number;
  signal?: AbortSignal;
  onStream?: (stream: "stdout" | "stderr", text: string) => void;
  deps?: CommandBackendDeps;
}

/**
 * 按后端 id 跑一条命令。local 不进这里（走原有本机路径）；e2b / modal /
 * daytona / vercel_sandbox / 未知 id 直接抛错，绝不静默回落本机。
 */
export async function runBackendCommand(
  id: string,
  command: string,
  opts: BackendRunOptions,
): Promise<RunProcessResult> {
  const config = loadCommandBackendConfig(opts.home);
  if (id === "docker") {
    return runDockerCommand(command, {
      workdir: opts.workdir,
      image: config.docker.image,
      extraArgs: config.docker.extra_args,
      allowNet: opts.allowNet ?? false,
      mode: opts.mode ?? "workspace-write",
      timeout: opts.timeout,
      signal: opts.signal,
      onStream: opts.onStream,
      runner: opts.deps?.dockerRunner,
    });
  }
  if (id === "ssh") {
    if (!config.ssh.host) {
      throw new CommandBackendError("ssh 后端没配目标：先 `nyra backend ssh --host user@host` 配好");
    }
    if (config.ssh.key_file && !existsSync(config.ssh.key_file)) {
      throw new CommandBackendError(`ssh 密钥文件不存在：${config.ssh.key_file}`);
    }
    return runSshCommand(command, {
      host: config.ssh.host,
      port: config.ssh.port,
      keyFile: config.ssh.key_file,
      remoteWorkdir: config.ssh.remote_workdir,
      timeout: opts.timeout,
      signal: opts.signal,
      onStream: opts.onStream,
      runner: opts.deps?.sshRunner,
    });
  }
  if (id === "e2b") {
    throw new E2bExecutionUnsupportedError(
      "e2b 沙箱内跑命令未接线：控制面 REST 只有 list/create/kill，跑命令要走沙箱里的 envd agent（须 E2B SDK）；" +
      "控制面可用 `nyra backend e2b list|create|kill`，执行请先改回 --backend local 或 docker",
    );
  }
  if (id === "modal" || id === "daytona" || id === "vercel_sandbox") {
    throw new CommandBackendError(`${id} 未接线：等云端商业决策后再接；执行请先改回 --backend local 或 docker`);
  }
  throw new CommandBackendError(`未知的命令后端：${id}`);
}
