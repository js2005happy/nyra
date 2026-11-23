// src/automationCli.ts — 自动化 bundle 的 CLI：`nyra automation`。
// 一次装好整条自动化（OpenHands preset 借鉴，G-P1-37）：event 触发器
// （启用）+ 建议触发器（装好但默认关，机主看过再开）+ 一个线程
// （状态与历史落点）+ 可选的线程 cron。
import {
  AutomationError, BUILTIN_AUTOMATIONS, installAutomation,
  removeAutomation, listAutomations, getAutomation, listInstalledSuggested,
} from "./automations.ts";

const USAGE = [
  "用法：",
  "  nyra automation list                                   列内置自动化与已安装的自动化",
  "  nyra automation show <id>                              看某个自动化的定义（内置）或安装记录（已安装）",
  "  nyra automation install <id|bundle.json>               一次装好整条自动化（触发器 + 建议触发器 + 线程 + 线程 cron）",
  "  nyra automation remove <id> --yes                      移除已安装的自动化（清掉它建的触发器与线程）",
  "  nyra automation suggested                              列已装的建议触发器（默认关闭，机主看过再开：nyra events enable <名>）",
  "说明：建议触发器装好默认关，不经机主显式开启不跑；引用的工作流不存在或不是 active 时，对应的线程 cron 跳过、不建悬空绑定。",
].join("\n");

export async function handleAutomation(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  try {
    if (cmd === undefined || cmd === "list") {
      process.stdout.write("内置自动化：\n");
      for (const b of BUILTIN_AUTOMATIONS) {
        process.stdout.write(`  ${b.id}  ${b.name}（触发器 ${b.triggers.length} 个，建议触发器 ${b.suggested_triggers.length} 个）\n`);
      }
      const installed = listAutomations(home);
      process.stdout.write("已安装：\n");
      if (!installed.length) { process.stdout.write("  （无）\n"); return 0; }
      for (const b of installed) {
        process.stdout.write(`  ${b.id}  ${b.name}（装于 ${b.installed_at}，触发器 ${b.trigger_names.length} 个，建议触发器 ${b.suggested_names.length} 个${b.thread_id ? `，线程 ${b.thread_id.slice(0, 8)}` : ""}${b.skipped_crons.length ? `，跳过的 cron ${b.skipped_crons.length} 条` : ""}）\n`);
      }
      return 0;
    }
    if (cmd === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：show 后面须跟自动化 id\n"); return 2; }
      const builtin = BUILTIN_AUTOMATIONS.find((b) => b.id === id);
      if (builtin) {
        process.stdout.write(JSON.stringify(builtin, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(JSON.stringify(getAutomation(home, id), null, 2) + "\n");
      return 0;
    }
    if (cmd === "install") {
      const target = argv[1];
      if (!target) { process.stderr.write("错误：install 后面须跟内置自动化 id 或 bundle.json 路径\n"); return 2; }
      const { bundle, warnings } = await installAutomation(home, target);
      process.stdout.write(`已安装自动化：${bundle.id}（${bundle.name}）\n`);
      process.stdout.write(`  触发器 ${bundle.trigger_names.length} 个已启用：${bundle.trigger_names.join("、") || "（无）"}\n`);
      if (bundle.suggested_names.length) {
        process.stdout.write(`  建议触发器 ${bundle.suggested_names.length} 个已装好、默认关闭：${bundle.suggested_names.join("、")}（看过再开：nyra events enable <名>，或 nyra automation suggested 查看）\n`);
      }
      if (bundle.thread_id) process.stdout.write(`  线程已建：${bundle.thread_id}\n`);
      for (const w of warnings) process.stdout.write(`  注意：${w}\n`);
      return 0;
    }
    if (cmd === "remove") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：remove 后面须跟自动化 id\n"); return 2; }
      if (!argv.includes("--yes")) { process.stderr.write("错误：移除自动化须加 --yes\n"); return 2; }
      const r = await removeAutomation(home, id);
      process.stdout.write(`已移除自动化 ${id}：清掉触发器 ${r.removedTriggers} 个${r.removedThread ? "，线程已删" : ""}。\n`);
      return 0;
    }
    if (cmd === "suggested") {
      const list = await listInstalledSuggested(home);
      if (!list.length) { process.stdout.write("没有已装的建议触发器。\n"); return 0; }
      for (const t of list) {
        process.stdout.write(`  ${t.name}  ${t.source} / ${t.event}  ${t.mode}  ${t.enabled ? "已启用" : "关闭（建议，机主看过再开）"}\n`);
      }
      return 0;
    }
  } catch (err) {
    if (err instanceof AutomationError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}
