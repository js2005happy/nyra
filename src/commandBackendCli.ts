// src/commandBackendCli.ts — G-P1-39 命令后端可换的 CLI：`nyra backend`。
//
//   list                            列出全部后端 + 当前后端 + 可用性
//   use <id> [--yes]                切换当前后端（选未配置/不可用的后端须 --yes）
//   status [id]                     各后端可用性（docker 真探 daemon，ssh/e2b 只认配置）
//   docker [--image <镜像>] [--extra-args <a,b>]   看 / 改 docker 配置
//   ssh [--host <user@host>] [--port <n>] [--key-file <路径>]
//       [--remote-workdir <目录>] [--clear-host]    看 / 改 ssh 配置
//   e2b <list|create [--template T] [--timeout N]|get <id>|kill <id>>
//                                   E2B 控制面（须 E2B_API_KEY）
//
// 只读为主；use / docker / ssh 改的是机主本机的配置，不调模型、不花钱。
// e2b create 会在云端建一个沙箱（按 E2B 账单计费），须机主显式敲命令。
import {
  e2bCreateSandbox, e2bGetSandbox, e2bKillSandbox, e2bListSandboxes,
  getCommandBackend, isKnownCommandBackend, listCommandBackends,
  loadCommandBackendConfig, probeAllBackends, probeBackend,
  resolveActiveBackend, saveCommandBackendConfig, setActiveBackend,
  type FetchFn,
} from "./commandBackends.ts";

const USAGE = [
  "用法：",
  "  nyra backend [list]   列出全部命令后端 + 当前后端 + 可用性",
  "  nyra backend use <local|docker|modal|daytona|vercel_sandbox|ssh|e2b> [--yes]   切换当前后端（选未配置/不可用的后端须 --yes）",
  "  nyra backend status [id]   各后端可用性（docker 真探 daemon，ssh/e2b 只认配置）",
  "  nyra backend docker [--image <镜像>] [--extra-args <a,b>]   看 / 改 docker 配置",
  "  nyra backend ssh [--host <user@host>] [--port <端口>] [--key-file <路径>] [--remote-workdir <目录>] [--clear-host]   看 / 改 ssh 配置",
  "  nyra backend e2b <list|create [--template <模板>] [--timeout <秒>]|get <沙箱 id>|kill <沙箱 id>>   E2B 控制面（须 E2B_API_KEY；create 会在云端建沙箱、按账单计费）",
  "说明：默认后端是本机（local）；modal / daytona / vercel_sandbox 未接线，等云端商业决策；e2b 沙箱内跑命令须 SDK，未接线。详见 docs/command-backends.md。",
].join("\n");

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

async function printList(home: string): Promise<void> {
  const { id: active } = resolveActiveBackend(home);
  const probes = await probeAllBackends(home);
  const byId = new Map(probes.map((p) => [p.id, p]));
  for (const b of listCommandBackends()) {
    const p = byId.get(b.id);
    const mark = b.id === active ? "*" : " ";
    process.stdout.write(`${mark} ${b.id}（${b.label}，${b.kind}）：${p?.detail ?? b.description}\n`);
  }
  process.stdout.write(`当前后端：${active}（* 标记）。换后端：nyra backend use <id>；单次换：--backend <id>。\n`);
}

export async function handleBackend(
  argv: string[],
  home: string,
  deps?: { fetchFn?: FetchFn },
): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "list") {
    await printList(home);
    return 0;
  }
  if (cmd === "use") {
    const id = argv[1];
    if (!id || !isKnownCommandBackend(id)) {
      process.stderr.write(`错误：use 须给一个已知的后端 id：${listCommandBackends().map((b) => b.id).join(", ")}\n${USAGE}\n`);
      return 2;
    }
    const probe = await probeBackend(id, home);
    if ((probe.status === "not_configured" || probe.status === "unavailable") && !argv.includes("--yes")) {
      process.stderr.write(
        `后端 ${id} 现在不可用：${probe.detail}\n` +
        "坚持要用它请加 --yes（之后跑命令会在执行时直接报错，不静默回落本机）。\n",
      );
      return 2;
    }
    if (probe.status === "not_configured" || probe.status === "unavailable") {
      process.stdout.write(`注意：后端 ${id} 现在不可用（${probe.detail}），已按你的要求切过去，跑命令时会直接报错。\n`);
    }
    setActiveBackend(home, id);
    process.stdout.write(`当前命令后端已切到 ${id}（${getCommandBackend(id)?.label ?? id}）。\n`);
    return 0;
  }
  if (cmd === "status") {
    const id = argv[1];
    if (id) {
      if (!isKnownCommandBackend(id)) {
        process.stderr.write(`错误：未知的后端 id：${id}\n`);
        return 2;
      }
      const p = await probeBackend(id, home);
      const b = getCommandBackend(id)!;
      process.stdout.write(`${b.id}（${b.label}，${b.kind}）：${p.status}——${p.detail}\n`);
      if (b.requires.length) process.stdout.write(`需要：${b.requires.join("；")}。\n`);
      return 0;
    }
    await printList(home);
    return 0;
  }
  if (cmd === "docker") {
    const cfg = loadCommandBackendConfig(home);
    const image = flagValue(argv, "--image");
    const extraRaw = flagValue(argv, "--extra-args");
    if (image === null && extraRaw === null) {
      process.stdout.write(`docker 镜像：${cfg.docker.image}\n`);
      process.stdout.write(`docker 额外参数：${cfg.docker.extra_args.length ? cfg.docker.extra_args.join(" ") : "（无）"}\n`);
      return 0;
    }
    if (image !== null) cfg.docker.image = image;
    if (extraRaw !== null) cfg.docker.extra_args = extraRaw.split(",").map((s) => s.trim()).filter(Boolean);
    saveCommandBackendConfig(home, cfg);
    process.stdout.write(`docker 配置已更新：镜像 ${cfg.docker.image}；额外参数 ${cfg.docker.extra_args.length ? cfg.docker.extra_args.join(" ") : "（无）"}。\n`);
    return 0;
  }
  if (cmd === "ssh") {
    const cfg = loadCommandBackendConfig(home);
    const host = flagValue(argv, "--host");
    const portRaw = flagValue(argv, "--port");
    const keyFile = flagValue(argv, "--key-file");
    const remoteWorkdir = flagValue(argv, "--remote-workdir");
    const clearHost = argv.includes("--clear-host");
    if (host === null && portRaw === null && keyFile === null && remoteWorkdir === null && !clearHost) {
      process.stdout.write(`ssh 目标：${cfg.ssh.host ?? "（未配）"}\n`);
      process.stdout.write(`ssh 端口：${cfg.ssh.port}\n`);
      process.stdout.write(`ssh 密钥文件：${cfg.ssh.key_file ?? "（默认 ssh agent / ~/.ssh）"}\n`);
      process.stdout.write(`ssh 远端工作目录：${cfg.ssh.remote_workdir ?? "（远端家目录）"}\n`);
      return 0;
    }
    if (clearHost) cfg.ssh.host = null;
    if (host !== null) {
      if (!host.trim() || /\s/.test(host) || host.startsWith("-")) {
        process.stderr.write(`错误：ssh 目标不合法：${host}（应为 user@host，不含空格）\n`);
        return 2;
      }
      cfg.ssh.host = host;
    }
    if (portRaw !== null) {
      const port = Number(portRaw);
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        process.stderr.write(`错误：--port 须在 1–65535 之间：${portRaw}\n`);
        return 2;
      }
      cfg.ssh.port = port;
    }
    if (keyFile !== null) cfg.ssh.key_file = keyFile;
    if (remoteWorkdir !== null) cfg.ssh.remote_workdir = remoteWorkdir;
    saveCommandBackendConfig(home, cfg);
    process.stdout.write(`ssh 配置已更新：目标 ${cfg.ssh.host ?? "（未配）"}，端口 ${cfg.ssh.port}。\n`);
    return 0;
  }
  if (cmd === "e2b") {
    const sub = argv[1];
    if (!sub) {
      process.stdout.write("用法：nyra backend e2b <list|create [--template <模板>] [--timeout <秒>]|get <沙箱 id>|kill <沙箱 id>>\n");
      return 0;
    }
    const fetchFn = deps?.fetchFn;
    try {
      if (sub === "list") {
        const rows = await e2bListSandboxes(fetchFn);
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (sub === "create") {
        const template = flagValue(argv, "--template") ?? undefined;
        const timeoutRaw = flagValue(argv, "--timeout");
        const timeout = timeoutRaw === null ? undefined : Number(timeoutRaw);
        if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
          process.stderr.write(`错误：--timeout 须为正整数秒：${timeoutRaw}\n`);
          return 2;
        }
        const created = await e2bCreateSandbox({ ...(template ? { template } : {}), ...(timeout !== undefined ? { timeout } : {}) }, fetchFn);
        process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
        return 0;
      }
      if (sub === "get" || sub === "kill") {
        const id = argv[2];
        if (!id) {
          process.stderr.write(`错误：${sub} 须给沙箱 id\n`);
          return 2;
        }
        const out = sub === "get" ? await e2bGetSandbox(id, fetchFn) : await e2bKillSandbox(id, fetchFn);
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return 0;
      }
      process.stderr.write(`错误：e2b 只认 list|create|get|kill：${sub}\n`);
      return 2;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  process.stderr.write(`错误：未知的 backend 子命令：${cmd}\n${USAGE}\n`);
  return 2;
}
