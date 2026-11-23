// src/searchCli.ts — `nyra search` 的 CLI 入口（G-P1-14）。
// 只做参数解析与输出排版，搜索本身在 src/sessionSearch.ts。
import { resolve } from "node:path";
import { exportSessionMarkdown, formatSessionSearchResults, recordSessionExport, searchSessions } from "./sessionSearch.ts";

const USAGE =
  "用法：nyra search <关键词> [--scope project|all] [--session <会话 id>] [--after <日期>] [--before <日期>] [--limit <n>] [--export <路径>] [--json]\n" +
  "  不给关键词时列出最近会话；--export 把命中的第一个会话（或 --session 指定的会话）全文导出为 Markdown。\n" +
  "  日期接受 YYYY-MM-DD 或 ISO 时间；scope 默认 project（只搜当前工作目录下记的会话）。";

function parseDate(value: string, flag: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`${flag} 的日期解析不出来：${value}（接受 YYYY-MM-DD 或 ISO 时间）`);
  return t / 1000;
}

export async function handleSearch(argv: string[], home: string): Promise<number> {
  const queryWords: string[] = [];
  let scope: "project" | "all" = "project";
  let projectDir = resolve(process.cwd());
  let sessionId: string | undefined;
  let after: number | undefined;
  let before: number | undefined;
  let limit = 5;
  let exportPath: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE + "\n");
      return 0;
    }
    if (a === "--json") { json = true; continue; }
    if (a === "--workdir") {
      // 全局 flag 也可能跟在子命令后面（`nyra search 关键词 --workdir <目录>`）；
      // scope=project 的基准目录就按它算，否则默认进程工作目录。
      const v = argv[++i];
      if (v !== undefined) projectDir = resolve(v);
      continue;
    }
    if (a === "--scope") {
      const v = argv[++i];
      if (v !== "project" && v !== "all") {
        process.stderr.write("错误：--scope 只认 project 或 all\n" + USAGE + "\n");
        return 1;
      }
      scope = v;
      continue;
    }
    if (a === "--session") { sessionId = argv[++i]; continue; }
    if (a === "--after") {
      const v = argv[++i];
      if (v === undefined) { process.stderr.write("错误：--after 后面要跟日期\n" + USAGE + "\n"); return 1; }
      try { after = parseDate(v, "--after"); } catch (err: unknown) { process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`); return 1; }
      continue;
    }
    if (a === "--before") {
      const v = argv[++i];
      if (v === undefined) { process.stderr.write("错误：--before 后面要跟日期\n" + USAGE + "\n"); return 1; }
      // 日期只给到天时，before 含当天整天。
      try { before = parseDate(v, "--before") + (/^\d{4}-\d{2}-\d{2}$/.test(v) ? 86399 : 0); } catch (err: unknown) { process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`); return 1; }
      continue;
    }
    if (a === "--limit") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) { process.stderr.write("错误：--limit 要给正整数\n" + USAGE + "\n"); return 1; }
      limit = v;
      continue;
    }
    if (a === "--export") {
      const v = argv[++i];
      if (v === undefined) { process.stderr.write("错误：--export 后面要跟路径\n" + USAGE + "\n"); return 1; }
      exportPath = v;
      continue;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`错误：不认的选项 ${a}\n` + USAGE + "\n");
      return 1;
    }
    queryWords.push(a);
  }
  const query = queryWords.join(" ").trim();
  let output;
  try {
    output = await searchSessions(home, {
      query: query || null,
      scope,
      projectDir,
      sessionId: sessionId ?? null,
      after: after ?? null,
      before: before ?? null,
      limit,
    });
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (exportPath !== undefined) {
    const target = sessionId ?? output.results[0]?.session_id;
    if (!target) {
      process.stderr.write("错误：没有可导出的会话（搜不到，或没给 --session）\n");
      return 1;
    }
    try {
      const done = await exportSessionMarkdown(home, target, exportPath);
      // 导出也进证据链（同款双通道；记不上不破坏导出结果本身）。
      try { await recordSessionExport(home, null, { session_id: target, messages: done.messages }, `会话 ${target} 已导出（${done.messages} 条消息）`); } catch { /* ignore */ }
      process.stdout.write(`已导出会话 ${target}（${done.messages} 条消息）到 ${done.path}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (json) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    process.stdout.write(formatSessionSearchResults(output) + "\n");
  }
  return 0;
}
