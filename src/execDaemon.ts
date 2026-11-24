// src/execDaemon.ts — 本地执行守护进程（权限分离的最小可用形态）。
//
// 由来：拆解一个 Electron agent（Cursor 换皮版 "Grok Bot"）时看到它的
// `local-exec-daemon`：**shell 不在 agent 进程里跑，而在独立进程里跑**，两者只经一个
// 本地 socket 上的行协议通信。这样做的价值不是"更快"，而是可划边界：
//
//   · agent 进程被提示注入攻陷 → 攻击者拿到的是"能发 exec 请求的客户端"，不是"能直接
//     spawn 的进程"；daemon 端可以独立限权（改用户、加 seccomp/Job Object、只挂载工作目录）
//   · daemon 可以独立重启/审计/记日志，agent 崩了不影响正在跑的命令
//
// 本文件只做**机制**，不改现有工具链：
//   1. 行协议（JSON Lines）+ 一次性 token 鉴权
//   2. daemon 端：每条 exec 一个子进程，流式回传 stdout/stderr，最后回 exit
//   3. 客户端：`run()` 聚合成 Nyra 现有工具层需要的形状
//
// 零运行时依赖（只用 node 内置）——这样它能在没有 bun 的机器上单文件编译自证。

import { createServer, connect, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

/** 协议版本：客户端与服务端各带一份，不匹配就拒绝（避免半升级错配）。 */
export const EXEC_PROTOCOL_VERSION = 1;

export interface ExecRequest {
  id: string;
  type: "exec";
  v: number;
  token: string;
  command: string;
  cwd?: string;
  /** 毫秒。 */
  timeoutMs?: number;
}

export type ExecEvent =
  | { id: string; type: "stdout"; text: string }
  | { id: string; type: "stderr"; text: string }
  | { id: string; type: "exit"; code: number | null; timedOut: boolean; error?: string }
  | { id: string; type: "denied"; reason: string };

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** 单行 JSON 编解码（协议只允许一行一个消息，避免粘包歧义）。 */
export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

/** 从缓冲区里切出完整行；返回 [消息数组, 剩余缓冲]。坏行直接丢弃并计数。 */
export function decodeLines(buffer: string): { messages: Record<string, unknown>[]; rest: string; dropped: number } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const messages: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const line of parts) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === "object") messages.push(v as Record<string, unknown>);
      else dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  return { messages, rest, dropped };
}

export interface ExecDaemonOptions {
  /** 绑定的地址，默认只回环（**不要**绑 0.0.0.0：那等于把 shell 暴露到局域网）。 */
  host?: string;
  /** 端口，0 = 由系统分配。 */
  port?: number;
  /** 一次性 token；不给则自动生成。 */
  token?: string;
  /** 允许执行的最长时间，超过即杀（防止客户端不传超时把 daemon 拖死）。 */
  maxTimeoutMs?: number;
  /** 允许的工作目录白名单（前缀匹配）；空 = 不限制（仅测试用）。 */
  allowedRoots?: string[];
}

export interface ExecDaemon {
  port: number;
  token: string;
  close: () => Promise<void>;
}

const DEFAULT_MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 起一个执行守护进程（仍在**当前进程**里，但边界已经存在：
 * 它只认带 token 的 exec 请求，且可以把限权做在子进程 spawn 上）。
 *
 * 真要把边界做实，就把它作为独立 node 进程启动（`node src/execDaemon.ts`），
 * 用 `allowedRoots` 收窄目录、用系统账号/沙箱收窄权限。
 */
export async function startExecDaemon(opts: ExecDaemonOptions = {}): Promise<ExecDaemon> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(16).toString("hex");
  const maxTimeout = opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const roots = (opts.allowedRoots ?? []).map((r) => r.replace(/[\\/]+$/, ""));

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const { messages, rest } = decodeLines(buffer);
      buffer = rest;
      for (const msg of messages) handle(msg as unknown as ExecRequest, socket);
    });
    socket.on("error", () => { /* 客户端断开是常态，不记错误 */ });
  });

  function deny(socket: Socket, id: string, reason: string): void {
    const ev: ExecEvent = { id, type: "denied", reason };
    socket.write(encodeMessage(ev));
  }

  function handle(req: ExecRequest, socket: Socket): void {
    if (!req || req.type !== "exec") return;
    const id = String(req.id ?? "");
    if (req.v !== EXEC_PROTOCOL_VERSION) {
      deny(socket, id, `协议版本不匹配（客户端 ${String(req.v)}，服务端 ${EXEC_PROTOCOL_VERSION}）`);
      return;
    }
    if (req.token !== token) {
      deny(socket, id, "token 无效");
      return;
    }
    const command = String(req.command ?? "");
    if (!command.trim()) {
      deny(socket, id, "命令为空");
      return;
    }
    if (roots.length) {
      const cwd = String(req.cwd ?? "");
      const ok = isWithinRoots(cwd, roots);
      if (!ok) {
        deny(socket, id, `工作目录不在白名单内：${cwd || "(未指定)"}`);
        return;
      }
    }

    const timeoutMs = Math.min(Math.max(1, Number(req.timeoutMs ?? 30_000)), maxTimeout);
    // POSIX 上用独立进程组：这样超时能杀掉整棵树（shell + 它起的子进程），
    // 而不是只杀 shell 让 ping/npm 之类的孙进程继续持有 stdout 管道。
    const child = spawn(command, {
      shell: true,
      cwd: req.cwd || undefined,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let timedOut = false;
    let finished = false;
    const finishOnce = (code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      emit({ id, type: "exit", code, timedOut, error });
    };
    const killTree = () => {
      const pid = child.pid;
      if (!pid) return;
      if (process.platform === "win32") {
        // Windows：taskkill /T 才会连带子孙进程；child.kill() 只杀 cmd.exe。
        try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* ignore */ }
      } else {
        try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // 不等 close：管道可能被孙进程继续持有，等下去会把客户端吊死。
      finishOnce(null, "超时被杀");
    }, timeoutMs);

    const emit = (ev: ExecEvent) => { try { socket.write(encodeMessage(ev)); } catch { /* 客户端已断 */ } };

    child.stdout?.on("data", (b: Buffer) => emit({ id, type: "stdout", text: b.toString("utf8") }));
    child.stderr?.on("data", (b: Buffer) => emit({ id, type: "stderr", text: b.toString("utf8") }));
    child.on("error", (err) => {
      clearTimeout(timer);
      emit({ id, type: "exit", code: null, timedOut, error: err instanceof Error ? err.message : String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      emit({ id, type: "exit", code, timedOut });
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface ExecDaemonClientOptions {
  port: number;
  token: string;
  host?: string;
  /** 默认 30s；daemon 端还会再夹一次上限。 */
  timeoutMs?: number;
}

/**
 * 客户端：发一条 exec，聚合流式事件成 ExecResult。
 *
 * 与 Nyra 工具层对齐的三点：超时一定会返回（不吊死调用方）、stderr 单独保留、
 * exitCode 为 null 表示"没拿到退出码"（被拒绝/启动失败/被杀），不要当成 0。
 */
export class ExecDaemonClient {
  private readonly opts: ExecDaemonClientOptions;
  private counter = 0;

  constructor(opts: ExecDaemonClientOptions) {
    this.opts = opts;
  }

  run(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    const host = this.opts.host ?? "127.0.0.1";
    const id = `c${++this.counter}`;
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? 30_000;

    return new Promise<ExecResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const socket = connect({ host, port: this.opts.port });
      const finish = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(r);
      };
      // 客户端侧兜底：daemon 无响应也要返回，别把 agent 卡死。
      const guard = setTimeout(() => {
        finish({ exitCode: null, stdout, stderr, timedOut: true, error: "客户端等待超时" });
      }, timeoutMs + 5_000);

      let buffer = "";
      socket.on("connect", () => {
        socket.write(encodeMessage({
          id, type: "exec", v: EXEC_PROTOCOL_VERSION, token: this.opts.token,
          command, cwd: opts.cwd, timeoutMs,
        } satisfies ExecRequest));
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const { messages, rest } = decodeLines(buffer);
        buffer = rest;
        for (const m of messages) {
          const ev = m as unknown as ExecEvent;
          if (ev.id !== id) continue;
          if (ev.type === "stdout") stdout += ev.text;
          else if (ev.type === "stderr") stderr += ev.text;
          else if (ev.type === "denied") finish({ exitCode: null, stdout, stderr, timedOut: false, error: ev.reason });
          else if (ev.type === "exit") finish({ exitCode: ev.code, stdout, stderr, timedOut: ev.timedOut, error: ev.error });
        }
      });
      socket.on("error", (err) => {
        finish({ exitCode: null, stdout, stderr, timedOut: false, error: err instanceof Error ? err.message : String(err) });
      });
      socket.on("close", () => {
        finish({ exitCode: null, stdout, stderr, timedOut: false, error: "daemon 连接关闭（未收到 exit）" });
      });
    });
  }
}

/**
 * 路径是否落在允许的白名单根之内。
 *
 * 为什么单独抽出来：白名单判定是**安全边界**，必须能单独测、能跨平台测。
 *
 * 三条踩过的坑：
 *   1. **分隔符混用**：root 写成 `C:/work`、cwd 是 `C:\work\x` —— 直接 `startsWith`
 *      会判"不在根内"（误拒，好一点是拒绝；坏一点是让你怀疑 daemon 坏了）
 *   2. **前缀当包含**：root `/repo` 与 cwd `/repo2` —— 只比字符串会把 `/repo2` 放进来。
 *      所以必须要求根后面紧跟分隔符（或完全相等）
 *   3. **Windows 大小写**：`C:\Work` 与 `c:\work\x` 是同一个目录，比较要忽略大小写
 */
export function isWithinRoots(
  cwd: string,
  roots: readonly string[],
  opts: { caseInsensitive?: boolean } = {},
): boolean {
  if (roots.length === 0) return true; // 空 = 不限制（仅在明确不需要边界时使用）
  const ci = opts.caseInsensitive ?? process.platform === "win32";
  const norm = (p: string): string => {
    // **先 resolve 再比**：客户端可以送 `/work/../etc`，纯字符串前缀会把它当成在 `/work` 里
    // ——那是一条真实的越权路径（cwd 由请求方提供）。resolve 之后再比就没有这个口子。
    const resolved = resolve(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
    return ci ? resolved.toLowerCase() : resolved;
  };
  const target = norm(cwd);
  return roots.some((r) => {
    const root = norm(r);
    return target === root || target.startsWith(root + "/");
  });
}