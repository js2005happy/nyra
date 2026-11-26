// src/localRouterCli.ts — nyra router：本地小路由的开关查看与干跑。
//
//   nyra router status        看开关、阈值、权重（版本/标签/词表）
//   nyra router test <消息…>  干跑一次分类：标签、置信度、会不会走本地路由
//
// 开关没有 CLI 子命令：跟 Jev 路由一样，只认 config.json 里
// local_router 一节（enabled / threshold），默认关；开了才在
// 群聊里先走本地分类。权重坏了时 status 如实报损坏、test 直
// 接报错退出（fail-closed：不拿坏权重硬猜，也不静默回落）。

import { LOCAL_ROUTER_LABELS } from "./localRouterData.ts";
import { classifyLocal, loadLocalRouterWeights, localRouterConfig, type LocalRouterWeights } from "./localRouter.ts";

function printUsage(): void {
  process.stdout.write(
    "用法：nyra router <status|test> [选项]\n" +
      "  status   看开关、阈值与权重状态\n" +
      "  test <消息…> [--json]  干跑一次本地分类（不发消息、不调模型）\n" +
      "本地小路由只做意图分类、零 token；置信度不够就回落原有路由。\n" +
      "开启方法：config.json 里 local_router.enabled 设 true。详见 docs/local-router.md。\n",
  );
}

function describeWeights(w: LocalRouterWeights): string {
  return `已加载（版本 ${w.version}，${w.labels.length} 个标签，${w.vocab.length} 个词）`;
}

export async function handleRouter(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action || action === "help" || action === "--help") {
    printUsage();
    return action ? 0 : 2;
  }
  const cfg = localRouterConfig(home);

  if (action === "status") {
    let weightsLine: string;
    try {
      weightsLine = describeWeights(loadLocalRouterWeights());
    } catch (err: unknown) {
      weightsLine = `损坏（${err instanceof Error ? err.message : String(err)}），本地路由不可用`;
    }
    process.stdout.write("本地小路由（零 token 意图分类）\n");
    process.stdout.write(`  开关：${cfg.enabled ? "开" : "关（默认）"}\n`);
    process.stdout.write(`  阈值：${cfg.threshold}（低于它回落原有路由）\n`);
    process.stdout.write(`  权重：${weightsLine}\n`);
    process.stdout.write(`  标签：${LOCAL_ROUTER_LABELS.join(" / ")}\n`);
    process.stdout.write("  开启：config.json 里 local_router.enabled 设 true\n");
    return 0;
  }

  if (action === "test") {
    const json = argv.includes("--json");
    const message = argv.slice(1).filter((a) => a !== "--json").join(" ").trim();
    if (!message) {
      process.stderr.write("错误：用法：nyra router test <消息…> [--json]\n");
      return 2;
    }
    let weights: LocalRouterWeights;
    try {
      weights = loadLocalRouterWeights();
    } catch (err: unknown) {
      process.stderr.write(`错误：本地路由权重坏了（${err instanceof Error ? err.message : String(err)}），不做分类。\n`);
      return 2;
    }
    const result = classifyLocal(message, weights);
    const conf2 = Math.round(result.confidence * 100) / 100;
    let fallback = true;
    let note: string;
    if (result.label === "spam") {
      note = "垃圾消息，不派给任何 Bot，回落原有路由";
    } else if (result.confidence < cfg.threshold) {
      note = `置信度低于阈值 ${cfg.threshold}，回落原有路由`;
    } else {
      fallback = false;
      note = `高于阈值 ${cfg.threshold}，会走本地路由`;
    }
    if (json) {
      process.stdout.write(JSON.stringify({ label: result.label, confidence: result.confidence, threshold: cfg.threshold, fallback, reason: note }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(`本地小路由：${result.label}（置信度 ${conf2}）——${note}\n`);
    return 0;
  }

  process.stderr.write(`错误：未知子命令 ${action}。用法：nyra router <status|test>\n`);
  return 2;
}
