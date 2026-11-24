// src/usageCli.ts — M1（OpenMausBot 用量上限借鉴）：nyra usage。
//
//   nyra usage [--agent <id>] [--json]
//
// 只读命令：按 Bot 列当日/当月用量条（已花/上限、百分比、80% 告警、
// 触顶暂停状态）。数字与 usage 模型工具同一份（usageMeter），
// 不调模型、不花 token、不改任何账本。
import { buildUsageReport, formatUsageReport } from "./usageMeter.ts";

const USAGE =
  "用法：nyra usage [--agent <id>] [--json]（按 Bot 列当日/当月用量；设上限见 nyra governance caps set --scope agent:<id> --usd <美元> --day-usd <美元> --reason <原因>）";

function getFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

export function usageMain(args: string[], home: string): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const json = args.includes("--json");
  const agent = getFlag(args, "--agent") ?? undefined;
  const report = buildUsageReport(home, agent);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const line of formatUsageReport(report)) console.log(line);
  return 0;
}
