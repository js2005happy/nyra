// H3：nyra dream —— 夜间“做梦代谢”的开关与手动跑。
//
//   nyra dream status              看开关、时间、上次运行与待确认候选数
//   nyra dream enable | disable    开 / 关（默认关）
//   nyra dream set --at 03:00 [--summarize-with-model true|false] [--prune-stale-days 90]
//     [--semantic-facts true|false] [--semantic-facts-max N]
//   nyra dream run [--with-model]  现在手动跑一次（开关关着也能跑，是用户亲手点的）
//
// 守护进程（nyra schedule daemon）里会自动跑，见 src/dream.ts 的 isDreamDue。

import { loadConfig, saveConfig } from "./config.ts";
import { dreamConfig, isDreamDue, readDreamState, runDreamMetabolism } from "./dream.ts";
import { listMemoryProposals } from "./memoryProposals.ts";
import { listSemanticFacts, semanticFactsConfig } from "./semanticFacts.ts";

function printUsage(): void {
  process.stdout.write(
    "用法：nyra dream <status|enable|disable|set|run> [选项]\n" +
      "  status   看开关、时间、上次运行与待确认候选数\n" +
      "  enable   打开夜间做梦代谢（默认关）\n" +
      "  disable  关闭夜间做梦代谢\n" +
      "  set --at HH:MM [--summarize-with-model true|false] [--prune-stale-days N]\n" +
      "      [--semantic-facts true|false] [--semantic-facts-max N]\n" +
      "  run [--with-model]  现在手动跑一次（默认不调模型；--with-model 调一次模型润色小结）\n" +
      "做梦只做确定性的事：提炼候选进待审队列、剪掉重复与过期、写小结进晨间简报。\n" +
      "候选绝不静默写进记忆，须你用 nyra review 批了才进。详见 docs/dream.md。\n",
  );
}

export async function handleDream(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action || action === "help" || action === "--help") {
    printUsage();
    return action ? 0 : 2;
  }
  const config = loadConfig(home);
  const cfg = dreamConfig(config);
  const sfc = semanticFactsConfig(config);

  if (action === "status") {
    const state = readDreamState(home);
    let pending = 0;
    try {
      pending = listMemoryProposals(home).filter((p) => p.status === "pending").length;
    } catch { /* 队列读失败就报 0，不拦 status */ }
    let factsActive = 0;
    try {
      factsActive = listSemanticFacts(home).length;
    } catch { /* 事实库读失败就报 0，不拦 status */ }
    const due = state ? isDreamDue(cfg, state) : cfg.enabled;
    process.stdout.write("夜间做梦代谢\n");
    process.stdout.write(`  开关：${cfg.enabled ? "开" : "关（默认）"}\n`);
    process.stdout.write(`  时间：每天 ${cfg.at}（本地时间，守护进程里跑）\n`);
    process.stdout.write(`  模型润色小结：${cfg.summarizeWithModel ? "开" : "关（默认）"}\n`);
    process.stdout.write(`  语义事实抽取：${sfc.enabled ? "开" : "关（默认）"}（每会话最多 ${sfc.maxPerSession} 条候选）\n`);
    process.stdout.write(`  生效中的语义事实：${factsActive} 条（nyra memory facts 看）\n`);
    process.stdout.write(`  过期未决候选：${cfg.pruneStaleDays} 天未决算过期清掉\n`);
    process.stdout.write(`  上次运行：${state?.last_run_at ?? "还没跑过"}${state ? (state.last_run_ok ? "（成功）" : "（上次失败）") : ""}\n`);
    if (state && state.last_summary.length) {
      process.stdout.write("  上次小结：\n");
      for (const line of state.last_summary) process.stdout.write(`    - ${line}\n`);
    }
    process.stdout.write(`  待确认候选：${pending} 条（nyra review 看）\n`);
    process.stdout.write(`  今夜到点：${due ? "是" : "否"}\n`);
    return 0;
  }

  if (action === "enable" || action === "disable") {
    const enabled = action === "enable";
    // 注意：配置文件里是 snake_case 键（dreamConfig 读的也是这套），
    // 这里必须整节重写 snake_case，不能只传 camelCase 的 cfg。
    saveConfig(home, {
      dream: {
        enabled,
        at: cfg.at,
        summarize_with_model: cfg.summarizeWithModel,
        prune_stale_days: cfg.pruneStaleDays,
      },
    });
    process.stdout.write(enabled ? "夜间做梦代谢已打开（每天 " + cfg.at + " 跑）。\n" : "夜间做梦代谢已关闭。\n");
    return 0;
  }

  if (action === "set") {
    const get = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const next = { ...cfg };
    const at = get("--at");
    if (at !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
        process.stderr.write("错误：--at 须是 HH:MM，如 03:00。\n");
        return 2;
      }
      next.at = at;
    }
    const withModel = get("--summarize-with-model");
    if (withModel !== undefined) {
      if (withModel !== "true" && withModel !== "false") {
        process.stderr.write("错误：--summarize-with-model 只认 true / false。\n");
        return 2;
      }
      next.summarizeWithModel = withModel === "true";
    }
    const stale = get("--prune-stale-days");
    if (stale !== undefined) {
      const n = parseInt(stale, 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write("错误：--prune-stale-days 须是非负整数。\n");
        return 2;
      }
      next.pruneStaleDays = n;
    }
    const nextSfc = { ...sfc };
    const facts = get("--semantic-facts");
    if (facts !== undefined) {
      if (facts !== "true" && facts !== "false") {
        process.stderr.write("错误：--semantic-facts 只认 true / false。\n");
        return 2;
      }
      nextSfc.enabled = facts === "true";
    }
    const factsMax = get("--semantic-facts-max");
    if (factsMax !== undefined) {
      const n = parseInt(factsMax, 10);
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        process.stderr.write("错误：--semantic-facts-max 须是 1–20 的整数。\n");
        return 2;
      }
      nextSfc.maxPerSession = n;
    }
    saveConfig(home, {
      dream: {
        enabled: next.enabled,
        at: next.at,
        summarize_with_model: next.summarizeWithModel,
        prune_stale_days: next.pruneStaleDays,
      },
      semantic_facts: {
        enabled: nextSfc.enabled,
        max_per_session: nextSfc.maxPerSession,
      },
    });
    process.stdout.write(`做梦配置已保存：每天 ${next.at}，模型润色小结${next.summarizeWithModel ? "开" : "关"}，过期 ${next.pruneStaleDays} 天，语义事实抽取${nextSfc.enabled ? "开" : "关"}（每会话最多 ${nextSfc.maxPerSession} 条候选）。\n`);
    return 0;
  }

  if (action === "run") {
    const withModel = argv.includes("--with-model");
    process.stdout.write("正在做梦代谢……\n");
    const result = await runDreamMetabolism(home, { withModel });
    for (const line of result.summary) process.stdout.write(`- ${line}\n`);
    if (result.modelSummarySkipped) {
      process.stdout.write(`（模型润色小结没跑：${result.modelSummarySkipped}，用的是确定性小结。）\n`);
    }
    if (result.spentUsd !== null) {
      process.stdout.write(`（模型润色花了 $${result.spentUsd.toFixed(6)}，已记进当月账本。）\n`);
    }
    if (result.factsSpentUsd !== null) {
      process.stdout.write(`（模型抽取事实花了 $${result.factsSpentUsd.toFixed(6)}，已记进当月账本。）\n`);
    }
    return 0;
  }

  process.stderr.write(`错误：未知子命令 dream ${action}\n`);
  printUsage();
  return 2;
}
