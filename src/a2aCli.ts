// src/a2aCli.ts — `nyra a2a`：serve（enable/disable/status/start/token/
// grant/revoke-grant）+ card。serve 是 HTTP 服务端：前台跑着时才监听，
// 停了端点就不存在。grant 开的是“写工具可见性”，不是写执行权：开了
// 之后写调用也只记 peer 提议，执行仍须机主逐条批。
import {
  A2A_SERVER_DEFAULT_HOST,
  a2aBaseUrl,
  buildA2aAgentCard,
  createA2aServerToken,
  grantA2aServerWrite,
  listA2aServerTokens,
  loadA2aServerConfig,
  revokeA2aServerToken,
  revokeA2aServerWrite,
  setA2aServerEnabled,
  startA2aServer,
  A2aError,
} from "./a2a.ts";
import { loadConfig } from "./config.ts";

const A2A_USAGE = [
  "用法：nyra a2a <serve|card> [参数]",
  "  serve enable | disable                     启用 / 禁用 A2A 服务端（默认关闭）",
  "  serve status                               看服务端配置（是否启用、地址、token 数）",
  "  serve start [--port <端口>] [--host <地址>]  前台启动服务端（默认 127.0.0.1:8767；Ctrl-C 停）",
  "  serve token new [--name <名字>]             建一条调用 token（明文只显示一次，请保存好）",
  "  serve token list                           列出 token（只显示 id 与名字，不显示明文）",
  "  serve token revoke <token-id>              吊销一条 token（立即失效）",
  "  serve grant <token-id> --yes                给某 token 写提议权（模型才能提议写操作）",
  "  serve revoke-grant <token-id>              撤销某 token 的写提议权",
  "  card                                       打印本机的 A2A 名片（JSON，协议 v0.3）",
  "写提议不等于执行：模型提议的写操作进 peer 提议门，机主须逐条批",
  "（nyra peer proposal accept <提议 id> --yes）才执行。详见 docs/a2a.md。",
].join("\n");

export async function handleA2a(args: string[], home: string): Promise<number> {
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(A2A_USAGE + "\n");
    return 0;
  }
  if (cmd === "card") {
    try {
      const config = loadConfig(home);
      const card = buildA2aAgentCard(home, config as Record<string, unknown>, a2aBaseUrl(home));
      process.stdout.write(JSON.stringify(card, null, 2) + "\n");
      return 0;
    } catch (e) {
      process.stderr.write(`错误：${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  if (cmd !== "serve") {
    process.stderr.write(`未知子命令 ${cmd}\n${A2A_USAGE}\n`);
    return 2;
  }
  const sub = args[1];
  const rest = args.slice(2);
  const flagValue = (name: string): string | undefined => {
    const idx = rest.indexOf(name);
    return idx >= 0 && rest[idx + 1] !== undefined ? rest[idx + 1] : undefined;
  };
  const has = (name: string): boolean => args.includes(name);
  const err = (msg: string): number => {
    process.stderr.write(`错误：${msg}\n`);
    return 1;
  };
  try {
    if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
      process.stdout.write(A2A_USAGE + "\n");
      return 0;
    }
    if (sub === "enable" || sub === "disable") {
      const config = setA2aServerEnabled(home, sub === "enable");
      process.stdout.write(`A2A 服务端已${config.enabled ? "启用" : "禁用"}。\n`);
      if (config.enabled) {
        process.stdout.write(`启动：nyra a2a serve start（默认 http://${config.host}:${config.port}，前台运行，Ctrl-C 停）。\n`);
        if (!config.tokens.length) process.stdout.write("还没有调用 token：先跑 nyra a2a serve token new 建一个（明文只显示一次）。\n");
      }
      return 0;
    }
    if (sub === "status") {
      const config = loadA2aServerConfig(home);
      process.stdout.write(`A2A 服务端：${config.enabled ? "已启用" : "未启用（默认关闭）"}\n地址：http://${config.host}:${config.port}\n`);
      process.stdout.write(`token：${config.tokens.length} 条\n`);
      for (const t of config.tokens) {
        process.stdout.write(`  ${t.id}\t${t.name}\t写提议${t.write_granted ? "已授权" : "未授权"}\t${t.created_at}\n`);
      }
      if (!config.enabled) process.stdout.write("启用：nyra a2a serve enable；启动：nyra a2a serve start。\n");
      return 0;
    }
    if (sub === "start") {
      const portRaw = flagValue("--port");
      const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : undefined;
      if (portRaw !== undefined && (!Number.isInteger(port) || (port as number) <= 0 || (port as number) >= 65536)) {
        process.stderr.write("用法：nyra a2a serve start [--port <1–65535 的整数>] [--host <地址>]\n");
        return 2;
      }
      const host = flagValue("--host");
      const handle = await startA2aServer(home, { host, port });
      process.stdout.write(`A2A 服务端已启动：http://${handle.host}:${handle.port}（A2A JSON-RPC endpoint）\n`);
      process.stdout.write(`名片：GET http://${handle.host}:${handle.port}/.well-known/agent.json（公开）；调用：POST / 带 Authorization: Bearer <token>。\n`);
      if (handle.host !== A2A_SERVER_DEFAULT_HOST) {
        process.stdout.write("警告：你绑的不是回环地址，局域网里的人都能连上这个端点（token 是唯一一道门）。\n");
      }
      process.stdout.write("按 Ctrl-C 停下（停了端点就不存在）。\n");
      await handle.closed;
      return 0;
    }
    if (sub === "token") {
      const tsub = rest[0];
      if (tsub === "new") {
        const name = flagValue("--name") ?? `client-${Date.now().toString(36)}`;
        const { record, plaintext } = createA2aServerToken(home, name);
        process.stdout.write(`token 已建：${record.id}（${record.name}）\n`);
        process.stdout.write(`明文（只显示这一次，请保存好，盘上只存指纹）：${plaintext}\n`);
        process.stdout.write("调用：curl -H \"Authorization: Bearer <上面这串>\" http://127.0.0.1:8767/ 。\n");
        return 0;
      }
      if (tsub === "list") {
        const tokens = listA2aServerTokens(home);
        if (!tokens.length) {
          process.stdout.write("还没有 token：跑 nyra a2a serve token new 建一个。\n");
          return 0;
        }
        for (const t of tokens) {
          process.stdout.write(`${t.id}\t${t.name}\t写提议${t.write_granted ? "已授权" : "未授权"}\t${t.created_at}\n`);
        }
        return 0;
      }
      if (tsub === "revoke") {
        const id = rest[1];
        if (!id) {
          process.stderr.write("用法：nyra a2a serve token revoke <token-id>\n");
          return 2;
        }
        const removed = revokeA2aServerToken(home, id);
        process.stdout.write(`token 已吊销：${removed.id}（${removed.name}，立即失效）。\n`);
        return 0;
      }
      process.stderr.write("用法：nyra a2a serve token <new|list|revoke> [参数]\n");
      return 2;
    }
    if (sub === "grant") {
      const id = rest[0];
      if (!id) {
        process.stderr.write("用法：nyra a2a serve grant <token-id> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("写提议权是显式授权，须加 --yes：nyra a2a serve grant <token-id> --yes\n");
        return 2;
      }
      grantA2aServerWrite(home, id);
      process.stdout.write(`token ${id} 已有写提议权（模型才能提议写操作；执行仍须机主逐条批提议）。\n`);
      return 0;
    }
    if (sub === "revoke-grant") {
      const id = rest[0];
      if (!id) {
        process.stderr.write("用法：nyra a2a serve revoke-grant <token-id>\n");
        return 2;
      }
      revokeA2aServerWrite(home, id);
      process.stdout.write(`token ${id} 的写提议权已撤销（之后模型连写工具都看不到）。\n`);
      return 0;
    }
    process.stderr.write(`未知子命令 ${sub}\n${A2A_USAGE}\n`);
    return 2;
  } catch (e) {
    if (e instanceof A2aError) return err(e.message);
    throw e;
  }
}
