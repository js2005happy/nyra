// src/acpCli.ts — `nyra acp`：serve / status / grant / revoke-grant。
// serve 是 stdio 服务端：stdin 读 JSON-RPC 行，stdout 只写协议行，
// 日志一律走 stderr。grant 开的是“写工具可见性”，不是写执行权：
// 开了之后写调用也只记 peer 提议，执行仍须机主逐条批。
import { ACP_CONFIG_FILE, loadAcpServerConfig, serveAcpStdio, setAcpWriteEnabled } from "./acp.ts";

const ACP_USAGE = `用法：nyra acp <serve|status|grant|revoke-grant>
  serve          启动 ACP 服务端（stdio JSON-RPC，等编辑器连进来）
  status         看写开关与默认模式
  grant --yes    机主显式开写工具可见性（只放行“提议”，执行仍逐条批）
  revoke-grant   关写工具可见性`;

export async function handleAcp(args: string[], home: string): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(ACP_USAGE);
    return 0;
  }
  if (sub === "serve") {
    if (args.length > 1) {
      console.error("用法：nyra acp serve（不带多余参数）");
      return 1;
    }
    return serveAcpStdio(home);
  }
  if (sub === "status") {
    const config = loadAcpServerConfig(home);
    console.log(`ACP 服务端配置（${home}/${ACP_CONFIG_FILE}）`);
    console.log(`  写工具可见：${config.writeEnabled ? "开" : "关（默认）"}`);
    console.log(`  默认模式：${config.defaultMode}`);
    console.log("  协议：ACP v1（stdio JSON-RPC 2.0），只读先行，写操作进 peer 提议门");
    return 0;
  }
  if (sub === "grant") {
    if (args[1] !== "--yes") {
      console.error("开写工具可见性须加 --yes（机主显式确认）");
      return 1;
    }
    const config = setAcpWriteEnabled(home, true);
    console.log(`写工具可见性已开（${config.defaultMode} 模式）。写调用只记提议、不执行，执行须机主在终端逐条批。`);
    return 0;
  }
  if (sub === "revoke-grant") {
    setAcpWriteEnabled(home, false);
    console.log("写工具可见性已关。");
    return 0;
  }
  console.error(`未知子命令 ${sub}\n${ACP_USAGE}`);
  return 1;
}
