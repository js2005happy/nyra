// src/componentsCli.ts — `nyra components` 命令行（O7：生成式 UI 的屏蔽表管理）。
//
// 白名单本身在 src/components.ts 里写死（改白名单要改代码 + 审）；这里只管
// 每 Bot 的屏蔽表（~/.nyra/components.json）：list 看白名单与屏蔽情况，
// block/unblock 开关某一台 Bot 的某个组件。退出码：0 成功、1 业务错误、2 用法错误。
import {
  BUILTIN_COMPONENTS,
  ComponentError,
  blockComponent,
  isComponentBlocked,
  listComponentNames,
  loadComponentConfig,
  unblockComponent,
} from "./components.ts";

const COMPONENTS_USAGE = "用法：\n"
  + " nyra components list [--bot <bot id>]   看白名单组件（已发布/屏蔽情况）\n"
  + " nyra components block <bot id> <组件名>   屏蔽某台 Bot 的某个组件（之后该 Bot 调 render_component 会被拒）\n"
  + " nyra components unblock <bot id> <组件名>   恢复某台 Bot 的某个组件\n"
  + "白名单只有 table / card / list / code / chart-bar（只读展示，写操作仍过审批）。详见 docs/components.md";

export function handleComponents(argv: string[], home: string): number {
  const cmd = argv[0];
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const err = (msg: string): number => {
    process.stderr.write(`错误：${msg}\n`);
    return 1;
  };
  try {
    if (!cmd || cmd === "help" || cmd === "--help") {
      process.stdout.write(COMPONENTS_USAGE + "\n");
      return 0;
    }
    if (cmd === "list") {
      const bot = flagValue("--bot");
      const config = loadComponentConfig(home);
      for (const spec of BUILTIN_COMPONENTS) {
        const blocked = bot ? isComponentBlocked(home, bot, spec.name) : false;
        const blockedBy = bot
          ? ""
          : Object.entries(config.blocked).filter(([, names]) => names.includes(spec.name)).map(([b]) => b).join("、");
        process.stdout.write(`${spec.name}\t${spec.published ? "已发布" : "未发布"}\t${spec.description}${bot ? (blocked ? "\t已屏蔽" : "\t可用") : (blockedBy ? `\t被屏蔽：${blockedBy}` : "")}\n`);
      }
      return 0;
    }
    if (cmd === "block" || cmd === "unblock") {
      const bot = argv[1];
      const name = argv[2];
      if (!bot || !name) {
        process.stderr.write(`用法：nyra components ${cmd} <bot id> <组件名>\n`);
        return 2;
      }
      if (!listComponentNames().includes(name)) {
        return err(`没有这个组件：${name}（白名单只有 ${listComponentNames().join(" / ")}）`);
      }
      if (cmd === "block") {
        if (!blockComponent(home, bot, name)) {
          process.stdout.write(`Bot ${bot} 本来就屏蔽了 ${name}。\n`);
          return 0;
        }
        process.stdout.write(`已屏蔽：Bot ${bot} 之后调 render_component 渲染 ${name} 会被拒。\n`);
        return 0;
      }
      if (!unblockComponent(home, bot, name)) {
        process.stdout.write(`Bot ${bot} 本来就没屏蔽 ${name}。\n`);
        return 0;
      }
      process.stdout.write(`已恢复：Bot ${bot} 又能用 ${name} 了。\n`);
      return 0;
    }
  } catch (e) {
    if (e instanceof ComponentError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
  process.stderr.write(COMPONENTS_USAGE + "\n");
  return 2;
}
