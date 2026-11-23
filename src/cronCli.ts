// src/cronCli.ts — G-P1-38 cron 成熟语义的 CLI：`nyra cron`。
//
//   incidents [--kind missed|caught_up|quota_held|quota_released|failed]
//             [--workflow <名>] [--limit <条数>]   查事故账（新的在前）
//   policy [set --catch-up once|skip]
//          [--window-minutes <分钟>] [--hold-minutes <分钟>]
//                                                  看 / 改补跑策略与窗口
//   hold [status|clear --yes]                      看 / 强制清掉 hold 戳
//
// 只读为主；policy set 与 hold clear 是机主在本机上改自己的配置，不调模型。
import { clearQuotaHold, describeQuotaHold, getCronPolicy, setCronPolicy } from "./workflowTriggers.ts";
import { listCronIncidents, type CronIncidentKind } from "./cronMaturity.ts";

const USAGE = [
  "用法：",
  "  nyra cron incidents [--kind missed|caught_up|quota_held|quota_released|failed] [--workflow <工作流名>] [--limit <条数>]   查事故账（新的在前，默认 20 条）",
  "  nyra cron policy [set --catch-up once|skip] [--window-minutes <分钟>] [--hold-minutes <分钟>]   看 / 改补跑策略与窗口（窗口 0–1440 分钟，hold 有效期 5–1440 分钟）",
  "  nyra cron hold [status|clear --yes]   看配额 hold 状态 / 强制清掉 hold 戳（只清戳，不动成本暂停；暂停还在时下一轮会重新打戳）",
  "说明：漏跑补跑默认 once（只补跑一次，其余记 missed ×N），统计窗口默认 120 分钟；配额 hold 戳默认 60 分钟。详见 docs/cron-maturity.md。",
].join("\n");

const KINDS: CronIncidentKind[] = ["missed", "caught_up", "quota_held", "quota_released", "failed"];

const KIND_CN: Record<CronIncidentKind, string> = {
  missed: "漏跑",
  caught_up: "补跑",
  quota_held: "配额 hold",
  quota_released: "hold 释放",
  failed: "失败",
};

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function printPolicy(home: string): void {
  const p = getCronPolicy(home);
  process.stdout.write(
    `补跑策略：${p.catchUp === "once" ? "once（漏掉的只补跑一次，其余记 missed）" : "skip（直接跳到下一档，漏掉的全记 missed）"}\n` +
    `漏跑统计窗口：${p.catchUpWindowMinutes} 分钟\n` +
    `配额 hold 戳有效期：${p.quotaHoldMinutes} 分钟\n`,
  );
}

function printHold(home: string): void {
  const h = describeQuotaHold(home);
  if (!h.held) {
    process.stdout.write("配额 hold：没有（本月没有未决的成本暂停）。\n");
    return;
  }
  process.stdout.write(
    `配额 hold：挂起中，至 ${h.holdUntil ?? "未知"}（暂停 ${h.pauseId ?? "未知"}，层 ${h.scope ?? "未知"}）。\n` +
    "期间定时触发与事件触发全部挂起；暂停解除（caps resume）且戳过期后自动放行。\n",
  );
}

export async function handleCron(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (!cmd) {
    process.stdout.write(`${USAGE}\n`);
    printPolicy(home);
    printHold(home);
    return 0;
  }
  if (cmd === "incidents") {
    const kindRaw = flagValue(argv, "--kind");
    if (kindRaw && !(KINDS as string[]).includes(kindRaw)) {
      process.stderr.write(`错误：--kind 只认 ${KINDS.join("|")}\n${USAGE}\n`);
      return 2;
    }
    const limitRaw = flagValue(argv, "--limit");
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 100) {
      process.stderr.write("错误：--limit 须在 1–100 之间\n");
      return 2;
    }
    const rows = listCronIncidents(home, {
      ...(kindRaw ? { kind: kindRaw as CronIncidentKind } : {}),
      ...(flagValue(argv, "--workflow") ? { workflow: flagValue(argv, "--workflow") as string } : {}),
      limit,
    });
    if (!rows.length) {
      process.stdout.write("事故账是空的（没有漏跑、补跑、hold 或失败记录）。\n");
      return 0;
    }
    for (const r of rows) {
      const who = r.source === "thread"
        ? `线程 ${String(r.thread_id ?? "").slice(0, 8)} 的 ${r.workflow}`
        : (r.workflow || "（全局）");
      const extra: string[] = [];
      if (r.count !== undefined) extra.push(`×${r.count}`);
      if (r.scheduled_minute) extra.push(`漏掉 ${r.scheduled_minute}`);
      if (r.policy) extra.push(`策略 ${r.policy}`);
      if (r.pause_id) extra.push(`暂停 ${r.pause_id.slice(0, 12)}（${r.scope ?? ""}）`);
      if (r.hold_until) extra.push(`至 ${r.hold_until}`);
      if (r.run_id) extra.push(`运行 ${r.run_id}`);
      if (r.error) extra.push(`错：${r.error.slice(0, 100)}`);
      if (r.note) extra.push(r.note);
      process.stdout.write(`${r.at}  ${KIND_CN[r.kind] ?? r.kind}  ${who}${extra.length ? `（${extra.join("；")}）` : ""}\n`);
    }
    return 0;
  }
  if (cmd === "policy") {
    if (argv[1] !== "set") {
      printPolicy(home);
      return 0;
    }
    const catchUp = flagValue(argv, "--catch-up");
    const windowRaw = flagValue(argv, "--window-minutes");
    const holdRaw = flagValue(argv, "--hold-minutes");
    if (catchUp === null && windowRaw === null && holdRaw === null) {
      process.stderr.write("错误：policy set 至少给一个：--catch-up once|skip、--window-minutes <分钟>、--hold-minutes <分钟>\n");
      return 2;
    }
    try {
      const p = setCronPolicy(home, {
        ...(catchUp !== null ? { catchUp } : {}),
        ...(windowRaw !== null ? { catchUpWindowMinutes: Number(windowRaw) } : {}),
        ...(holdRaw !== null ? { quotaHoldMinutes: Number(holdRaw) } : {}),
      });
      process.stdout.write("补跑策略已更新。\n");
      process.stdout.write(
        `补跑策略：${p.catchUp}；漏跑统计窗口：${p.catchUpWindowMinutes} 分钟；配额 hold 戳有效期：${p.quotaHoldMinutes} 分钟。\n`,
      );
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  if (cmd === "hold") {
    const sub = argv[1] ?? "status";
    if (sub === "status") {
      printHold(home);
      return 0;
    }
    if (sub === "clear") {
      if (!argv.includes("--yes")) {
        process.stderr.write("错误：清掉 hold 戳须加 --yes（只清戳，不动成本暂停；暂停还在时下一轮会重新打戳）。\n");
        return 2;
      }
      clearQuotaHold(home);
      process.stdout.write("hold 戳已清掉。暂停还在的话，下一轮触发前会重新打戳、重新挂起；先用 caps resume 处理暂停。\n");
      return 0;
    }
    process.stderr.write(`错误：未知动作 hold ${sub}（应为 status|clear）\n${USAGE}\n`);
    return 2;
  }
  process.stderr.write(`错误：未知子命令 cron ${cmd}\n${USAGE}\n`);
  return 2;
}
