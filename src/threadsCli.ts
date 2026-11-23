// src/threadsCli.ts — 远端线程操作 API 的 CLI：`nyra thread`。
// 线程是一段可接着跑的会话（LangGraph threads.py 借鉴，G-P1-37）：
// 建线程、搜线程、复制接着跑、剪历史、读写状态、给线程绑 cron。
// 本 CLI 只管账本操作；执行走守护进程每轮的 fireDueThreadCrons，
// 或 `nyra workflow triggers run` 顺带跑。
import {
  ThreadError, createThread, getThread, listThreads, searchThreads,
  copyThread, pruneThread, getThreadState, updateThreadState,
  getThreadHistory, listThreadRuns, setThreadStatus, removeThread,
  addThreadCron, removeThreadCron, listThreadCrons, threadPublic,
} from "./threads.ts";

const USAGE = [
  "用法：",
  "  nyra thread create <标题> [--session <会话 id>]            建一个线程",
  "  nyra thread list [--status active|archived]                列线程（新的在前，只给元数据）",
  "  nyra thread search <关键词> [--status active|archived]    按标题或 id 搜线程",
  "  nyra thread show <线程 id>                                 看线程详情（含状态、历史、运行、cron）",
  "  nyra thread copy <线程 id>                                 复制一个线程接着跑（只复制状态与历史，不复制运行记录与 cron）",
  "  nyra thread prune <线程 id> [--keep <条数>]                剪掉旧历史，只留最近 keep 条（默认 50）",
  "  nyra thread state <线程 id> [--set <键=值> ...] [--unset <键> ...]   看状态，或合并写状态（--set 里写 null 表示删键；值 true/false/数字自动识别，其余当字符串）",
  "  nyra thread history <线程 id> [--limit <条数>]             看线程历史（新的在后，默认 50 条）",
  "  nyra thread runs <线程 id>                                 看线程上跑过的工作流",
  "  nyra thread cron-add <线程 id> \"<cron>\" <工作流>           给线程绑一条定时触发器（create_for_thread，到点跑工作流）",
  "  nyra thread cron-remove <线程 id> <cron id>                解绑一条线程 cron",
  "  nyra thread crons <线程 id>                                列线程绑的 cron",
  "  nyra thread archive <线程 id>                              归档线程（归档后 cron 不再跑）",
  "  nyra thread unarchive <线程 id>                            取消归档",
  "  nyra thread remove <线程 id> --yes                         删线程",
  "说明：线程 cron 只在触发器执行总开关开了时才跑（nyra workflow triggers enable --yes），只跑 active 的工作流；每轮最多跑 5 条。",
].join("\n");

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === flag) out.push(argv[i + 1]);
  }
  return out;
}

function parseSetValue(raw: string): string | number | boolean | null {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function printThreadLine(t: { id: string; title: string; status: string; updated_at: string; history_count: number; run_count: number; cron_count: number }): void {
  process.stdout.write(`  ${t.id}  ${t.title}  ${t.status === "active" ? "进行中" : "已归档"}（历史 ${t.history_count} 条，运行 ${t.run_count} 次，cron ${t.cron_count} 条，更新 ${t.updated_at}）\n`);
}

export async function handleThread(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  try {
    if (cmd === undefined || cmd === "list") {
      const status = flagValue(argv, "--status");
      if (status !== null && status !== "active" && status !== "archived") {
        process.stderr.write("错误：--status 只允许 active 或 archived\n");
        return 2;
      }
      const list = listThreads(home).filter((t) => !status || t.status === status);
      if (!list.length) { process.stdout.write("还没有线程。\n"); return 0; }
      for (const t of list) printThreadLine(threadPublic(t) as never);
      return 0;
    }
    if (cmd === "create") {
      const title = argv[1];
      if (!title) { process.stderr.write("错误：create 后面须跟标题\n"); return 2; }
      const sessionId = flagValue(argv, "--session");
      const t = createThread(home, title, sessionId ? { sessionId } : undefined);
      process.stdout.write(`已建线程：${t.id}（${t.title}）\n`);
      return 0;
    }
    if (cmd === "search") {
      const q = argv[1];
      if (q === undefined) { process.stderr.write("错误：search 后面须跟关键词\n"); return 2; }
      const status = flagValue(argv, "--status");
      if (status !== null && status !== "active" && status !== "archived") {
        process.stderr.write("错误：--status 只允许 active 或 archived\n");
        return 2;
      }
      const list = searchThreads(home, q, status ?? undefined);
      if (!list.length) { process.stdout.write("没搜到线程。\n"); return 0; }
      for (const t of list) printThreadLine(threadPublic(t) as never);
      return 0;
    }
    if (cmd === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：show 后面须跟线程 id\n"); return 2; }
      process.stdout.write(JSON.stringify(getThread(home, id), null, 2) + "\n");
      return 0;
    }
    if (cmd === "copy") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：copy 后面须跟线程 id\n"); return 2; }
      const t = copyThread(home, id);
      process.stdout.write(`已复制：${t.id}（${t.title}，状态与历史已复制，运行记录与 cron 未复制）\n`);
      return 0;
    }
    if (cmd === "prune") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：prune 后面须跟线程 id\n"); return 2; }
      const keepRaw = flagValue(argv, "--keep");
      const keep = keepRaw === null ? 50 : Number(keepRaw);
      if (!Number.isInteger(keep)) { process.stderr.write("错误：--keep 须是整数\n"); return 2; }
      const r = pruneThread(home, id, keep);
      process.stdout.write(`已剪历史：留 ${r.kept} 条，剪掉 ${r.dropped} 条。\n`);
      return 0;
    }
    if (cmd === "state") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：state 后面须跟线程 id\n"); return 2; }
      const sets = flagValues(argv, "--set");
      const unsets = flagValues(argv, "--unset");
      if (!sets.length && !unsets.length) {
        process.stdout.write(JSON.stringify(getThreadState(home, id), null, 2) + "\n");
        return 0;
      }
      const patch: Record<string, unknown> = {};
      for (const s of sets) {
        const eq = s.indexOf("=");
        if (eq <= 0) { process.stderr.write(`错误：--set 须是 键=值（${s}）\n`); return 2; }
        patch[s.slice(0, eq)] = parseSetValue(s.slice(eq + 1));
      }
      for (const k of unsets) patch[k] = null;
      const state = updateThreadState(home, id, patch);
      process.stdout.write(JSON.stringify(state, null, 2) + "\n");
      return 0;
    }
    if (cmd === "history") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：history 后面须跟线程 id\n"); return 2; }
      const limitRaw = flagValue(argv, "--limit");
      const limit = limitRaw === null ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit)) { process.stderr.write("错误：--limit 须是整数\n"); return 2; }
      const list = getThreadHistory(home, id, limit);
      if (!list.length) { process.stdout.write("这条线程还没有历史。\n"); return 0; }
      for (const h of list) process.stdout.write(`  ${h.at}  [${h.kind}] ${h.summary}\n`);
      return 0;
    }
    if (cmd === "runs") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：runs 后面须跟线程 id\n"); return 2; }
      const list = listThreadRuns(home, id);
      if (!list.length) { process.stdout.write("这条线程上还没跑过工作流。\n"); return 0; }
      for (const r of list) process.stdout.write(`  ${r.at}  运行 ${r.run_id}  ${r.workflow ?? ""}  ${r.status}\n`);
      return 0;
    }
    if (cmd === "cron-add") {
      const [id, cron, workflow] = [argv[1], argv[2], argv[3]];
      if (!id || !cron || !workflow) { process.stderr.write("错误：cron-add 后面须跟 线程 id、cron、 工作流名\n"); return 2; }
      const c = addThreadCron(home, id, cron, workflow);
      process.stdout.write(`已绑 cron：${c.id}（${c.cron} → 工作流 ${c.workflow}，到点自动跑，须先开触发器执行总开关）\n`);
      return 0;
    }
    if (cmd === "cron-remove") {
      const [id, cronId] = [argv[1], argv[2]];
      if (!id || !cronId) { process.stderr.write("错误：cron-remove 后面须跟 线程 id、cron id\n"); return 2; }
      if (!removeThreadCron(home, id, cronId)) { process.stderr.write("错误：找不到这条 cron\n"); return 1; }
      process.stdout.write("已解绑这条 cron。\n");
      return 0;
    }
    if (cmd === "crons") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：crons 后面须跟线程 id\n"); return 2; }
      const list = listThreadCrons(home, id);
      if (!list.length) { process.stdout.write("这条线程没绑 cron。\n"); return 0; }
      for (const c of list) process.stdout.write(`  ${c.id}  ${c.cron} → ${c.workflow}${c.last_fired ? `（上次触发 ${c.last_fired}）` : ""}\n`);
      return 0;
    }
    if (cmd === "archive" || cmd === "unarchive") {
      const id = argv[1];
      if (!id) { process.stderr.write(`错误：${cmd} 后面须跟线程 id\n`); return 2; }
      const t = setThreadStatus(home, id, cmd === "archive" ? "archived" : "active");
      process.stdout.write(cmd === "archive" ? `已归档：${t.id}（cron 不再跑）。\n` : `已取消归档：${t.id}。\n`);
      return 0;
    }
    if (cmd === "remove") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：remove 后面须跟线程 id\n"); return 2; }
      if (!argv.includes("--yes")) { process.stderr.write("错误：删线程须加 --yes\n"); return 2; }
      if (!removeThread(home, id)) { process.stderr.write("错误：找不到这条线程\n"); return 1; }
      process.stdout.write("已删线程。\n");
      return 0;
    }
  } catch (err) {
    if (err instanceof ThreadError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}
