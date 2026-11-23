// src/activeMemoryCli.ts — 主动记忆的 CLI：`nyra memory recall`。
// 只管开关与试跑；写记忆仍走记忆证据门（memoryGateCli），这里不碰。
import { join } from "node:path";
import {
  loadActiveMemoryConfig,
  setActiveMemoryEnabled,
  setActiveMemoryCrossSession,
  recallBeforeReply,
} from "./activeMemory.ts";

const USAGE = [
  "用法：",
  "  nyra memory recall status              看主动记忆开关状态",
  "  nyra memory recall on [会话 id]        开主动记忆（不给会话 id 改全局，给了只改该会话）",
  "  nyra memory recall off [会话 id]       关主动记忆（同上）",
  "  nyra memory recall cross-on            允许深挖时搜别的会话（跨会话，默认关）",
  "  nyra memory recall cross-off           只搜本会话（默认）",
  "  nyra memory recall test <问题> [--session <会话 id>]   试跑一次召回（只读，不进模型）",
].join("\n");

function printStatus(home: string): void {
  const cfg = loadActiveMemoryConfig(home);
  process.stdout.write(`主动记忆：${cfg.enabled ? "全局开" : "全局关"}（默认关）\n`);
  process.stdout.write(`跨会话：${cfg.crossSession ? "开（深挖可搜别的会话）" : "关（深挖只搜本会话）"}\n`);
  const overrides = Object.entries(cfg.sessions);
  if (!overrides.length) {
    process.stdout.write("按会话开关：无\n");
  } else {
    for (const [id, on] of overrides) process.stdout.write(`按会话开关：${id} ${on ? "开" : "关"}\n`);
  }
  process.stdout.write("说明：开了才在回复前召回；只读注入提示词，不改记忆、不发消息。\n");
}

export async function handleActiveMemory(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "status") {
    printStatus(home);
    return 0;
  }
  if (cmd === "on" || cmd === "off") {
    const sessionId = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
    setActiveMemoryEnabled(home, cmd === "on", sessionId);
    process.stdout.write(sessionId
      ? `主动记忆已${cmd === "on" ? "开" : "关"}（会话 ${sessionId}，优先于全局）\n`
      : `主动记忆已${cmd === "on" ? "开" : "关"}（全局）\n`);
    return 0;
  }
  if (cmd === "cross-on" || cmd === "cross-off") {
    setActiveMemoryCrossSession(home, cmd === "cross-on");
    process.stdout.write(`跨会话已${cmd === "cross-on" ? "开（深挖可搜别的会话）" : "关（深挖只搜本会话）"}\n`);
    return 0;
  }
  if (cmd === "test") {
    const rest = argv.slice(1);
    const sessIdx = rest.indexOf("--session");
    const sessionId = sessIdx >= 0 ? rest[sessIdx + 1] : undefined;
    const query = rest.filter((a, i) => a !== "--session" && !(sessIdx >= 0 && i === sessIdx + 1)).join(" ");
    if (!query.trim()) {
      process.stderr.write("用法：nyra memory recall test <问题> [--session <会话 id>]\n");
      return 2;
    }
    const recall = await recallBeforeReply(home, query, {
      sessionId,
      memoryPath: join(home, "MEMORY.md"),
    });
    process.stdout.write(`档位：${recall.tier === "deep" ? "deep（已升级深挖）" : "quick（快速召回）"}，命中 ${recall.hits.length} 条\n`);
    if (!recall.hits.length) {
      process.stdout.write("没有召回任何记忆。\n");
      return 0;
    }
    process.stdout.write(recall.text + "\n");
    return 0;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}
