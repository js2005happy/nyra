// src/seatbelt.ts — P0-6：macOS Seatbelt 沙箱（学 Claude Code 用 sandbox-exec）。
//
// 与 Linux 的 bwrap 是同一层东西：内核级拦截，不是"工具级规则"。差别在于
// macOS 用 SBPL（Sandbox Profile Language，一个 Scheme 方言）描述策略，通过
// `sandbox-exec -p '<profile>' <cmd>` 执行。
//
// 本模块只做两件事，且都是纯函数/只读探测，便于在非 macOS 机器上单测：
//   1. buildSeatbeltProfile()：把 Nyra 的 mode + workdir + allowNet 翻译成 SBPL
//   2. seatbeltBinary()：定位 sandbox-exec（macOS 上固定 /usr/bin/sandbox-exec）
//
// 真正的执行在 tools.ts 的 shell 分支里（与 bwrap 同款），本模块不 spawn。
//
// 已知边界（写清楚，别让人以为它能替代容器）：
//   - SBPL 只能约束文件/网络/进程等系统调用面，不能防"工作目录内的逻辑破坏"
//   - macOS 上 subprocess 继承沙箱，逃逸需要沙箱漏洞；但 fork 出的 daemon 只要
//     在 profile 允许范围内仍可运行
//   - Apple 未把 SBPL 当稳定 API，语法可能随系统版本变化；profile 走最小集
import { existsSync } from "node:fs";
/**
 * 统一取消信号（可靠性打磨第 1 项第一批）。cancel.ts 是叶子模块，
 * 不 import 任何 src 内模块，这里静态导入不会形成循环导入。
 */
import { cancelErrorFromSignal } from "./cancel.ts";

export type SeatbeltMode = "read-only" | "workspace-write" | "danger-full-access";

export interface SeatbeltOptions {
  mode: SeatbeltMode;
  /** 工作目录（绝对路径）。写权限只给这里 + 系统临时目录。 */
  workdir: string;
  /** 是否放开网络。默认 false（与 bwrap 后端一致：默认断网）。 */
  allowNet: boolean;
  /** 额外的可写路径（例如 ~/.nyra 需要写会话/记忆时由调用方显式传入）。 */
  extraWritable?: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** sandbox-exec 是否可用（仅 macOS 才有；其他平台恒为 false）。 */
export function seatbeltBinary(): string | null {
  if (process.platform !== "darwin") return null;
  return existsSync(SANDBOX_EXEC) ? SANDBOX_EXEC : null;
}

export function seatbeltAvailable(): boolean {
  return seatbeltBinary() !== null;
}

/** SBPL 字符串字面量转义：双引号与反斜杠。 */
function quote(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 生成 SBPL profile。
 *
 * 原则：默认拒绝（deny default），再逐项放行——这比"默认允许再禁止"安全得多，
 * 也是 Apple 自己给出的推荐写法。三档 mode 的差异：
 *
 * | mode | 文件写 | 网络 |
 * |---|---|---|
 * | read-only | 不给写（除 /dev/null 等） | 按 allowNet |
 * | workspace-write | workdir + 临时目录 | 按 allowNet |
 * | danger-full-access | 全放开 | 全放开 |
 */
export function buildSeatbeltProfile(opts: SeatbeltOptions): string {
  const { mode, workdir, allowNet, extraWritable = [] } = opts;
  if (mode === "danger-full-access") {
    // 与 bwrap 后端语义保持一致：该模式要求无限制执行，profile 只保留最小声明。
    return "(version 1)\n(allow default)\n";
  }

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "",
    ";; 进程与基本系统调用：不放开就没法起 shell",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target same-sandbox))",
    "",
    ";; 读：系统库、/usr、/System、/private 等只读区域全放开，否则命令跑不起来",
    "(allow file-read*)",
    "",
  ];

  // 写：只有工作目录（workspace-write）与临时目录
  if (mode === "workspace-write") {
    lines.push(";; 写：仅工作目录 + 临时目录");
    lines.push(`(allow file-write* (subpath ${quote(workdir)}))`);
    lines.push('(allow file-write* (subpath "/private/tmp"))');
    lines.push('(allow file-write* (subpath "/private/var/folders"))');
    for (const p of extraWritable) lines.push(`(allow file-write* (subpath ${quote(p)}))`);
    lines.push("");
  } else {
    lines.push(";; 只读模式：不给任何 file-write，只留必须的设备节点");
    lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))');
    lines.push("");
  }

  // 网络
  lines.push(allowNet ? ";; 网络：已显式放开" : ";; 网络：默认断开");
  if (allowNet) {
    lines.push("(allow network*)");
  } else {
    lines.push("(allow network-bind (local ip))");
    lines.push("(allow network-inbound (local ip \"localhost:*\"))");
    lines.push("(allow network-outbound (remote ip \"localhost:*\"))");
  }
  lines.push("");
  return lines.join("\n");
}

/** 给 doctor 用的一行摘要。 */
export function describeSeatbelt(opts: SeatbeltOptions): string {
  return `Seatbelt（sandbox-exec），模式 ${opts.mode}，工作目录可写=${opts.mode === "workspace-write"}，网络=${opts.allowNet ? "放开" : "本地回环"}`;
}

// ---- 执行：sandbox-exec -p '<profile>' /bin/sh -c <command> ----
// 返回值形状与 sandbox.ts 的 RunSandboxedResult 一致，便于 tools.ts 复用同一个
// formatSandboxResult。失败（sandbox-exec 不在、spawn 失败）必须抛错——绝不静默裸奔。
export interface SeatbeltRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SeatbeltUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatbeltUnavailableError";
  }
}

export async function runSeatbelt(
  command: string,
  opts: { workdir: string; mode: SeatbeltMode; allowNet: boolean; timeout?: number; profileExtra?: string[]; signal?: AbortSignal },
): Promise<SeatbeltRunResult> {
  const bin = seatbeltBinary();
  if (!bin) throw new SeatbeltUnavailableError("sandbox-exec 不可用（仅 macOS 提供）");
  const profile = buildSeatbeltProfile({
    mode: opts.mode,
    workdir: opts.workdir,
    allowNet: opts.allowNet,
    extraWritable: opts.profileExtra ?? [],
  });
  const timeoutMs = (opts.timeout ?? 60) * 1000;
  // 可靠性打磨第 1 项第一批：信号已 abort 时不启动，直接以 CancelError
  // 拒绝（调用方认得出“这是取消”，不记成沙箱失败）。
  if (opts.signal?.aborted) throw cancelErrorFromSignal(opts.signal, "stop");
  const { spawn } = await import("node:child_process");
  return new Promise<SeatbeltRunResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(bin, ["-p", profile, "/bin/sh", "-c", command], {
      cwd: opts.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // 取消：信号 abort 时杀掉子进程，以 CancelError 拒绝（不是超时错）。
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
      rejectPromise(cancelErrorFromSignal(opts.signal!, "stop"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
      rejectPromise(new SeatbeltUnavailableError(`Seatbelt 执行超时（>${opts.timeout ?? 60} 秒），已终止`));
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rejectPromise(new SeatbeltUnavailableError(`sandbox-exec 启动失败：${err.message}`));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}
