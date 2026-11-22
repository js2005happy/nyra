// src/sandbox.ts — OS 级分级沙箱（隔离执行）。
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI + Gemini CLI + OpenClaw）。
// 沙箱与审批拆成两轴：沙箱定“物理上能做什么”，审批定“何时问人”。
// 本文件只管沙箱这一轴：后端探测、后端解析、bwrap 命令行拼接、在 bwrap 内执行。
// 审批仍在 src/tools.ts 的 checkApproval 里，钩子（PreToolUse/PostToolUse）
// 仍在宿主机跑（src/hooks.ts），不在沙箱内——职责分工见 docs/sandbox.md。
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { seatbeltAvailable } from "./seatbelt.ts";
import { windowsSandboxAvailable } from "./windowsSandbox.ts";
import { delimiter, join } from "node:path";
/**
 * 统一取消信号（可靠性打磨第 1 项第一批）。cancel.ts 是叶子模块，
 * 不 import 任何 src 内模块，这里静态导入不会形成循环导入。
 */
import { cancelErrorFromSignal } from "./cancel.ts";

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——三档模式。
// read-only：只读，任何写/执行/联网都要审批；
// workspace-write：默认，工作区内可读写跑命令，出工作区写与联网被挡住；
// danger-full-access：无限制，不推荐，与沙箱互斥（见 buildBwrapArgs）。
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——后端选择。
// auto：Linux 且有 bwrap 时用 bwrap，否则工具级；local：显式只要工具级；
// bwrap：强制 bwrap，缺失即 fail-closed 报错；e2b：0.5.1 暂不支持。
// seatbelt：macOS sandbox-exec；jobobject：Windows Job Object（P0-6）。
export type SandboxBackend = "auto" | "local" | "bwrap" | "seatbelt" | "jobobject" | "e2b";

export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
export const SANDBOX_BACKENDS: readonly SandboxBackend[] = ["auto", "local", "bwrap", "seatbelt", "jobobject", "e2b"];

export type SandboxLevel = "bwrap" | "seatbelt" | "jobobject" | "tool-level" | "none";

export interface SandboxStatus {
  backend: string;
  mode: SandboxMode;
  bwrapAvailable: boolean;
  /** macOS 上 sandbox-exec 是否可用（其他平台恒 false）。 */
  seatbeltAvailable: boolean;
  /** Windows 上 PowerShell 是否可用（其他平台恒 false）。 */
  jobObjectAvailable: boolean;
  level: SandboxLevel;
  detail: string;
}

export interface ResolvedSandbox {
  /** 生效的后端（auto 已解析为 bwrap 或 local）。 */
  backend: "bwrap" | "seatbelt" | "jobobject" | "local";
  /** 用户原始选择（auto/local/bwrap/seatbelt/jobobject），用于提示文案。 */
  requested: SandboxBackend;
  mode: SandboxMode;
  level: SandboxLevel;
  allowNet: boolean;
  bwrapAvailable: boolean;
  /** macOS 上 sandbox-exec 是否可用（其他平台恒 false）。 */
  seatbeltAvailable?: boolean;
  /** Windows 上 PowerShell 是否可用（其他平台恒 false）。 */
  jobObjectAvailable?: boolean;
}

/** bwrap 不可用时抛出的错误：调用方据此降级或 fail-closed，绝不静默裸奔。 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** bwrap 安装指引（fail-closed 报错里复用，doctor 与文档也用同一句话）。 */
export const BWRAP_INSTALL_HINT =
  "安装 bwrap：Debian/Ubuntu 用 sudo apt install bubblewrap；Fedora 用 sudo dnf install bubblewrap；Arch 用 sudo pacman -S bubblewrap；或改回 --sandbox auto（无 bwrap 时自动用工具级隔离）或 --sandbox local（显式只要工具级隔离）。";

/** 读 NYRA_<name>，旧 ANGEL_<name> 作回退（与 src/config.ts 的 envVar 同语义）。 */
function sandboxEnv(name: string): string | undefined {
  return process.env["NYRA_" + name] || process.env["ANGEL_" + name] || undefined;
}

function envFlagOn(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——bwrap 探测。
// 只在 Linux 上找：遍历 PATH 查 bwrap 可执行文件（`which` 思路，查可执行位）；
// Windows/macOS 直接返回 false（本机 macOS/Windows 没有 bwrap，OS 级 Seatbelt 后续再接）。
export function detectBwrap(pathEnv?: string): boolean {
  if (process.platform !== "linux") return false;
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "bwrap");
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch { /* 不存在或不可读就继续找下一个 PATH 目录 */ }
  }
  return false;
}

/** 解析沙箱模式：显式值 > NYRA_SANDBOX_MODE 环境变量 > config.sandbox_mode > 默认 workspace-write。 */
export function resolveSandboxMode(config?: Record<string, unknown> | null): SandboxMode {
  const raw = sandboxEnv("SANDBOX_MODE") ?? (config?.sandbox_mode as string | undefined) ?? "workspace-write";
  if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
    throw new Error(`Invalid sandbox_mode: ${raw}. Valid modes: ${SANDBOX_MODES.join(", ")}`);
  }
  return raw as SandboxMode;
}

/** 解析是否放开网络：NYRA_SANDBOX_ALLOW_NET=1 > config.sandbox_allow_net > 默认 false（断网）。 */
export function resolveSandboxAllowNet(config?: Record<string, unknown> | null): boolean {
  const fromEnv = envFlagOn(sandboxEnv("SANDBOX_ALLOW_NET"));
  if (fromEnv !== undefined) return fromEnv;
  return (config?.sandbox_allow_net as boolean | undefined) === true;
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——后端解析（本项的核心决定）。
// 优先级：显式 flag 参数 > NYRA_SANDBOX / ANGEL_SANDBOX 环境变量 > config.sandbox > 默认 auto。
// auto：Linux 且 bwrap 可用 → bwrap；macOS 且 sandbox-exec 可用 → Seatbelt；
//   否则 → 工具级（现有 workspace containment + shell 黑名单）。
//   Windows auto 仍不选 Job Object：未经真机验证，且隔离面与 bwrap/Seatbelt
//   不同（不管文件，网络只靠工具级拦截），悄悄改变行为会误导用户。
// local：显式只要工具级，即使用户机器上有 bwrap 也不用——这是退出 OS 沙箱的开关。
// bwrap：强制要求 bwrap；找不到或非 Linux → 直接抛错（fail-closed），绝不静默降级。
// e2b：保持不支持报错（文案写目标版本 0.5.2；VERSION 常量本身不动，总协调最后统一升版）。
// danger-full-access 与沙箱互斥：显式 bwrap + danger 直接抛错；auto + danger 解析为工具级。
// probe：可选探测覆盖（仅测试用）：platform/bwrapAvailable/seatbeltAvailable/
//   jobObjectAvailable；生产调用不传，走真实探测。
export interface SandboxProbe {
  platform?: string;
  bwrapAvailable?: boolean;
  seatbeltAvailable?: boolean;
  jobObjectAvailable?: boolean;
}

export function resolveSandboxBackend(
  config?: Record<string, unknown> | null,
  flag?: string | null,
  probe?: SandboxProbe,
): ResolvedSandbox {
  const cfg = config ?? {};
  const raw = flag ?? sandboxEnv("SANDBOX") ?? (cfg.sandbox as string | undefined) ?? "auto";
  if (!(SANDBOX_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid sandbox backend: ${raw}. Valid backends: ${SANDBOX_BACKENDS.join(", ")}`);
  }
  const requested = raw as SandboxBackend;
  const mode = resolveSandboxMode(cfg);
  const allowNet = resolveSandboxAllowNet(cfg);
  const platform = probe?.platform ?? process.platform;
  const bwrapAvailable = probe?.bwrapAvailable ?? detectBwrap();
  const sbAvailable = probe?.seatbeltAvailable ?? seatbeltAvailable();
  const joAvailable = probe?.jobObjectAvailable ?? windowsSandboxAvailable();

  if (requested === "e2b") {
    throw new Error("--sandbox e2b 在 0.5.2 暂不支持（Python 已移除，Node 版 E2B 后端尚未移植）；当前只支持 auto、local、bwrap");
  }
  if (requested === "bwrap" && mode === "danger-full-access") {
    throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 bwrap；如需无限制请用 --sandbox local 并自行承担风险");
  }
  if (requested === "bwrap") {
    if (platform !== "linux") {
      throw new Error(`--sandbox bwrap 只支持 Linux（当前平台 ${platform} 没有 bwrap）；请改回 --sandbox auto 或 --sandbox local`);
    }
    if (!bwrapAvailable) {
      throw new Error(`--sandbox bwrap 要求本机安装 bubblewrap，但 PATH 里找不到 bwrap。${BWRAP_INSTALL_HINT}`);
    }
    return { backend: "bwrap", requested, mode, level: "bwrap", allowNet, bwrapAvailable };
  }
  // P0-6：macOS Seatbelt（sandbox-exec）。与 bwrap 同款语义，只是实现换 SBPL。
  if (requested === "seatbelt") {
    if (platform !== "darwin") {
      throw new Error(`--sandbox seatbelt 只支持 macOS（当前平台 ${platform}）；请改回 --sandbox auto 或 --sandbox local`);
    }
    if (!sbAvailable) {
      throw new Error("--sandbox seatbelt 要求 /usr/bin/sandbox-exec，但本机找不到它；请改回 --sandbox auto 或 --sandbox local");
    }
    if (mode === "danger-full-access") {
      throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 Seatbelt；如需无限制请用 --sandbox local 并自行承担风险");
    }
    return { backend: "seatbelt", requested, mode, level: "seatbelt", allowNet, bwrapAvailable, seatbeltAvailable: true };
  }
  // P0-6：Windows Job Object（PowerShell + kernel32）。与 bwrap/Seatbelt 同款语义，
  // 只是隔离面不同：Job Object 只管进程生命周期与资源（随作业死、进程数上限），
  // 不管文件——文件仍由工具级规则兜底（见 docs/sandbox.md，不夸大）；网络在
  // allowNet=false 时由 jobobject 分支的工具级拦截补（见 src/tools.ts）。
  if (requested === "jobobject") {
    if (platform !== "win32") {
      throw new Error(`--sandbox jobobject 只支持 Windows（当前平台 ${platform}）；请改回 --sandbox auto 或 --sandbox local`);
    }
    if (!joAvailable) {
      throw new Error("--sandbox jobobject 要求本机有 PowerShell（powershell.exe 或 pwsh.exe），但 PATH 里找不到它；请改回 --sandbox auto 或 --sandbox local");
    }
    if (mode === "danger-full-access") {
      throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 Job Object；如需无限制请用 --sandbox local 并自行承担风险");
    }
    return { backend: "jobobject", requested, mode, level: "jobobject", allowNet, bwrapAvailable, jobObjectAvailable: true };
  }
  if (requested === "local") {
    return { backend: "local", requested, mode, level: "tool-level", allowNet, bwrapAvailable };
  }
  // auto：danger-full-access 显式要无限制，不强制进沙箱，落到工具级。
  if (mode === "danger-full-access") {
    return { backend: "local", requested, mode, level: "tool-level", allowNet, bwrapAvailable };
  }
  if (platform === "linux" && bwrapAvailable) {
    return { backend: "bwrap", requested, mode, level: "bwrap", allowNet, bwrapAvailable };
  }
  // auto 在 macOS 上选 Seatbelt：sandbox-exec 是系统自带，SBPL 走最小集
  // profile（只放工作目录写 + 本地回环），与显式 --sandbox seatbelt 同款语义。
  if (platform === "darwin" && sbAvailable) {
    return { backend: "seatbelt", requested, mode, level: "seatbelt", allowNet, bwrapAvailable, seatbeltAvailable: true };
  }
  // 注意：auto 仍不自动选 Job Object：Windows 一侧未经真机验证，且 Job Object
  // 的隔离面与 bwrap/Seatbelt 不同（不管文件，网络只靠工具级拦截），悄悄改变
  // 行为会误导用户；需要 Windows 进程级沙箱请显式 --sandbox jobobject。
  return { backend: "local", requested, mode, level: "tool-level", allowNet, bwrapAvailable };
}

/** auto 回落到工具级时，在 doctor 与首次 shell 执行时给一次的提示文案。 */
export function toolLevelFallbackNotice(status: ResolvedSandbox | SandboxStatus): string {
  const osHint = process.platform === "win32"
    ? "想用进程级沙箱请用 --sandbox jobobject（需要 PowerShell；只管进程生命周期与资源，文件靠工具级规则、网络靠工具级拦截）"
    : process.platform === "darwin"
      ? "本机有 sandbox-exec 时 auto 会自动选 Seatbelt；也可显式 --sandbox seatbelt"
      : `想用 OS 级沙箱请安装 bwrap：${BWRAP_INSTALL_HINT}`;
  const missing = process.platform === "win32" ? "本机未启用 Job Object" : process.platform === "darwin" ? "本机无 sandbox-exec" : "本机无 bwrap";
  return `沙箱提示：当前是工具级隔离，不是 OS 沙箱（后端 ${status.backend}，模式 ${status.mode}；${missing}）。` +
    `工作目录内读写与审批、shell 黑名单仍生效，但命令在宿主机上跑，无内核级拦截；` +
    `出工作区写与联网仍由工具级规则拦。${osHint}`;
}

/** 各后端一句话状态（纯函数，供测试直接覆盖 macOS/Windows 才可达的分支）。 */
export function describeSandboxLevel(resolved: ResolvedSandbox): string {
  if (resolved.level === "bwrap") {
    return `后端 ${resolved.requested} → bwrap（OS 级沙箱，bubblewrap 可用），模式 ${resolved.mode}，网络 ${resolved.allowNet ? "已放开" : "默认断开"}；出工作区写与联网会被挡住`;
  }
  if (resolved.level === "seatbelt") {
    return `后端 ${resolved.requested} → Seatbelt（OS 级沙箱，sandbox-exec 可用），模式 ${resolved.mode}，网络 ${resolved.allowNet ? "已放开" : "默认断开（只放 localhost）"}；出工作区写与联网会被挡住`;
  }
  if (resolved.level === "jobobject") {
    return `后端 ${resolved.requested} → Job Object（进程级沙箱，PowerShell 可用），模式 ${resolved.mode}，网络 ${resolved.allowNet ? "已放开" : "默认断开（工具级拦截联网工具，见 src/tools.ts）"}；作业关柄即全杀、进程数有上限，文件隔离仍由工具级规则兜底`;
  }
  return toolLevelFallbackNotice(resolved);
}

/** doctor 的隔离级别文案（纯函数；jobobject 是进程级沙箱，文案写明）。 */
export function sandboxLevelText(level: SandboxLevel): string {
  if (level === "bwrap") return "OS 沙箱（bwrap）";
  if (level === "seatbelt") return "OS 沙箱（Seatbelt）";
  if (level === "jobobject") return "进程级沙箱（Job Object，文件靠工具级规则、网络靠工具级拦截）";
  if (level === "tool-level") return "工具级（非 OS 沙箱）";
  return "未生效";
}
export function getSandboxStatus(
  config?: Record<string, unknown> | null,
  flag?: string | null,
  probe?: SandboxProbe,
): SandboxStatus {
  const bwrapAvailable = probe?.bwrapAvailable ?? detectBwrap();
  const seatbeltAvailableFlag = probe?.seatbeltAvailable ?? seatbeltAvailable();
  const jobObjectAvailableFlag = probe?.jobObjectAvailable ?? windowsSandboxAvailable();
  let mode: SandboxMode = "workspace-write";
  try { mode = resolveSandboxMode(config); } catch { /* 模式非法时 doctor 仍要出状态，detail 里说明 */ }
  try {
    const resolved = resolveSandboxBackend(config, flag, probe);
    // 各后端一句话状态见 describeSandboxLevel（纯函数，可单测）。
    // 注意：之前这里只有 bwrap 一个分支，seatbelt 会误落进工具级提示——已一并修掉。
    const detail = describeSandboxLevel(resolved);
    return { backend: resolved.backend, mode: resolved.mode, bwrapAvailable, seatbeltAvailable: seatbeltAvailableFlag, jobObjectAvailable: jobObjectAvailableFlag, level: resolved.level, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      backend: (flag ?? (config?.sandbox as string | undefined) ?? "auto"),
      mode, bwrapAvailable, seatbeltAvailable: seatbeltAvailableFlag, jobObjectAvailable: jobObjectAvailableFlag, level: "none",
      detail: `沙箱配置未生效：${message}`,
    };
  }
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——bwrap 命令行拼接。
// 工作目录可写（--bind），系统目录只读（--ro-bind，只挂真实存在的目录，
// 不存在的跳过，不让 bwrap 因缺目录启动失败），默认断网（--unshare-net，
// allowNet 时不加；断网时先加 --unshare-user-try，否则无特权用户配不了
// loopback），--die-with-parent 保证父进程退出时沙箱一起死。
// read-only 模式工作目录也改 --ro-bind；danger-full-access 拒绝进 bwrap，直接抛错。
/**
 * bwrap 挂载面（buildBwrapArgs 与 buildBwrapArgv 共用）：断网、随父进程死、
 * 系统目录只读挂载、/proc /dev /tmp、工作目录按模式绑定。
 * extraRoBinds：工作区外的目录（只读追加，调用方保证是已存在的目录）。
 */
function bwrapBaseArgs(opts: { workdir: string; allowNet: boolean; mode: SandboxMode; extraRoBinds?: string[] }): string[] {
  if (opts.mode === "danger-full-access") {
    throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 bwrap；如需无限制请用 --sandbox local 并自行承担风险");
  }
  const args: string[] = ["bwrap"];
  if (!opts.allowNet) {
    // 无特权用户在 init user ns 拥有的 net ns 里配不了 loopback（bwrap 报
    // "loopback: Failed RTM_NEWADDR"）；先建 user ns 才能拿到 CAP_NET_ADMIN。
    // -try：在禁了无特权 userns 的机器上退回原行为，不硬失败。
    args.push("--unshare-user-try");
    args.push("--unshare-net");
  }
  args.push("--die-with-parent");
  // 只读挂载系统目录：只挂真实存在的，不存在的跳过。
  for (const dir of ["/usr", "/lib", "/lib64", "/bin", "/etc"]) {
    if (existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const dir of opts.extraRoBinds ?? []) {
    if (existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  if (opts.mode === "read-only") args.push("--ro-bind", opts.workdir, opts.workdir);
  else args.push("--bind", opts.workdir, opts.workdir);
  args.push("--chdir", opts.workdir);
  return args;
}

export function buildBwrapArgs(
  command: string,
  opts: { workdir: string; allowNet: boolean; mode: SandboxMode },
): string[] {
  return [...bwrapBaseArgs(opts), "--", "/bin/sh", "-c", command];
}

/**
 * argv 版（MCP 服务器进程用）：与 buildBwrapArgs 同款挂载面，但不经过
 * /bin/sh -c——长驻 stdio 进程直接当 bwrap 的子进程跑，stdio 管道原样透传。
 * extraRoBinds：服务器可执行文件与绝对路径参数所在目录（只读追加），
 * 否则工作区外的服务器文件在沙箱里读不到。
 */
export function buildBwrapArgv(
  command: string,
  args: string[],
  opts: { workdir: string; allowNet: boolean; mode: SandboxMode; extraRoBinds?: string[] },
): string[] {
  return [...bwrapBaseArgs(opts), "--", command, ...args];
}

export interface RunSandboxedOptions {
  workdir: string;
  allowNet: boolean;
  mode: SandboxMode;
  /** 超时秒数，默认 60（与 shell 工具默认一致）。 */
  timeout?: number;
  /** 流式回显：每收到一块输出就回调（stream 为 stdout/stderr）。 */
  onStream?: (stream: "stdout" | "stderr", text: string) => void;
  /**
   * 额外环境变量（缺口 42 第二批：电脑 Vault 代填凭证用）。只做浅合并覆盖
   * process.env——bwrap 默认透传环境变量（不加 --clearenv），所以填进去
   * 的变量能进沙箱里的 /bin/sh；不传时行为与原来完全一致。
   */
  env?: Record<string, string>;
  /**
   * 取消信号（可靠性打磨第 1 项第一批）：abort 时杀掉整个 bwrap 进程组，
   * 以 CancelError 拒绝（不是超时结果）。不传时行为与原来一致。
   */
  signal?: AbortSignal;
}

export interface RunSandboxedResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——在 bwrap 内实际执行命令。
// 无 bwrap 时抛 SandboxUnavailableError（调用方据此降级或 fail-closed，绝不静默裸奔）。
// spawn 写法复用 src/tools.ts 的 shell 执行：/bin/sh -c 跑命令、整进程组杀、超时处理。
export async function runSandboxed(
  command: string,
  opts: RunSandboxedOptions,
): Promise<RunSandboxedResult> {
  if (!detectBwrap()) {
    throw new SandboxUnavailableError(`bwrap 不可用，无法进入 OS 沙箱。${BWRAP_INSTALL_HINT}`);
  }
  const args = buildBwrapArgs(command, opts);
  const timeoutMs = (opts.timeout ?? 60) * 1000;
  // 可靠性打磨第 1 项第一批：信号已 abort 时不启动，直接以 CancelError
  // 拒绝（调用方认得出“这是取消”，不记成沙箱失败）。
  if (opts.signal?.aborted) throw cancelErrorFromSignal(opts.signal, "stop");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bwrap", args.slice(1), {
      cwd: opts.workdir,
      detached: process.platform !== "win32",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    let cancelled = false;
    const finish = (value: RunSandboxedResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };
    const finishCancelled = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rejectPromise(cancelErrorFromSignal(opts.signal!, "stop"));
    };
    const killTree = (): void => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* 回退到单进程 */ }
      }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    const onAbort = (): void => {
      cancelled = true;
      killTree();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      setTimeout(() => {
        finish({ code: -1, stdout, stderr: stderr + `\n错误：沙箱内命令超时（${opts.timeout ?? 60} 秒）` });
      }, 1000);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      stdout += text;
      try { opts.onStream?.("stdout", text); } catch { /* 回显失败不影响执行 */ }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      stderr += text;
      try { opts.onStream?.("stderr", text); } catch { /* 回显失败不影响执行 */ }
    });
    child.on("close", (code) => {
      if (cancelled) { finishCancelled(); return; }
      if (timedOut) { finish({ code: -1, stdout, stderr: stderr + `\n错误：沙箱内命令超时（${opts.timeout ?? 60} 秒）` }); return; }
      finish({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      opts.signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        rejectPromise(cancelErrorFromSignal(opts.signal!, "stop"));
        return;
      }
      rejectPromise(new SandboxUnavailableError(`bwrap 启动失败：${err.message}。${BWRAP_INSTALL_HINT}`));
    });
  });
}
