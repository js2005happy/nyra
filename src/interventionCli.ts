// src/interventionCli.ts — G-P2-1 运行时消息拦截的 CLI：`nyra intervention`。
//
//   list [--json]                              列规则（+ 总开关）
//   add --name <名> --action log|rewrite|drop [--bus group|peer|a2a|agui]
//       [--sender <名>] [--kind send|publish] [--contains <词> ...]
//       [--regex <表达式>] [--prefix <文字>] [--suffix <文字>]
//       [--replace <旧>=<新>] [--judge <0-100>] [--reason <文字>]
//                                              加一条规则（drop / rewrite 建出来
//                                              默认是关的，须 enable 才生效）
//   remove <id>                                删一条规则
//   enable <id> | disable <id>                 开 / 关一条规则
//   on | off                                   总开关开 / 关
//   log [--limit <条数>] [--json]              看拦截审计（新的在前，只记元数据）
//   test --bus <总线> --sender <名> --sender-kind owner|peer|bot|system
//        --kind send|publish --text <文字>     干跑一条消息（不写审计、不发事件）
//
// 只改本机配置与审计；test 是干跑，不写盘。
import { resolveHome } from "./config.ts";
import {
  addInterventionRule,
  applyInterventions,
  loadInterventions,
  newBusMessageId,
  readInterventionAudit,
  removeInterventionRule,
  setInterventionRuleEnabled,
  setInterventionsEnabled,
  type BusMessage,
  type InterventionBus,
  type InterventionPoint,
  type BusSenderKind,
} from "./interventions.ts";

const USAGE = [
  "用法：",
  "  nyra intervention list [--json]   列拦截规则（+ 总开关）",
  "  nyra intervention add --name <名> --action log|rewrite|drop [--bus group|peer|a2a|agui] [--sender <名>] [--kind send|publish] [--contains <词> ...] [--regex <表达式>] [--prefix <文字>] [--suffix <文字>] [--replace <旧>=<新>] [--judge <0-100>] [--reason <文字>]   加一条规则（drop / rewrite 建出来默认是关的，须 enable 才生效）",
  "  nyra intervention remove <id>   删一条规则",
  "  nyra intervention enable <id> | disable <id>   开 / 关一条规则",
  "  nyra intervention on | off   总开关开 / 关",
  "  nyra intervention log [--limit <条数>] [--json]   看拦截审计（新的在前，只记元数据与文本指纹，不记原文）",
  "  nyra intervention test --bus <总线> --sender <名> --sender-kind owner|peer|bot|system --kind send|publish --text <文字>   干跑一条消息（不写审计、不发事件）",
  "说明：总线拦截只对群聊 / A2A / AG-UI 入口对方 agent 发来的消息生效；机主自己的消息永远不拦截；默认动作只有 log，drop / rewrite 须机主显式 enable（详见 docs/interventions.md）。",
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

export async function handleIntervention(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  try {
    if (action === "list") {
      const config = loadInterventions(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(config, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(`总线拦截：${config.enabled ? "开" : "关"}（规则 ${config.rules.length} 条）\n`);
      if (!config.rules.length) {
        process.stdout.write("还没有规则（nyra intervention add 加一条；默认动作只有 log）。\n");
        return 0;
      }
      for (const r of config.rules) {
        const scope = [
          r.bus ?? "全部总线",
          r.sender ? `发送者 ${r.sender}` : "全部发送者",
          r.kind ?? "send/publish",
        ].join("、");
        const match = [
          ...(r.match.contains ?? []).map((c) => `含“${c}”`),
          ...(r.match.regex ? [`正则 ${r.match.regex}`] : []),
        ].join(" 或 ");
        process.stdout.write(
          `  ${r.id}  ${r.name}  [${r.action}]${r.enabled ? "" : "（关）"}  ${scope}  匹配：${match}` +
          `${r.judgeThreshold !== undefined ? `  judge ≥${r.judgeThreshold}` : ""}` +
          `${r.reason ? `  （${r.reason}）` : ""}\n`,
        );
      }
      return 0;
    }
    if (action === "add") {
      const name = flagValue(argv, "--name") ?? "";
      const act = flagValue(argv, "--action") ?? "";
      if (!name || !act) {
        process.stderr.write("错误：用法：nyra intervention add --name <名> --action log|rewrite|drop [--bus ...] [--contains <词> ...] [--regex <表达式>] ...\n");
        return 2;
      }
      const bus = flagValue(argv, "--bus");
      const sender = flagValue(argv, "--sender");
      const kind = flagValue(argv, "--kind");
      const contains = flagValues(argv, "--contains");
      const regex = flagValue(argv, "--regex");
      const prefix = flagValue(argv, "--prefix");
      const suffix = flagValue(argv, "--suffix");
      const replaceRaw = flagValue(argv, "--replace");
      const judgeRaw = flagValue(argv, "--judge");
      const reason = flagValue(argv, "--reason");
      let replace: [string, string] | undefined;
      if (replaceRaw !== null) {
        const eq = replaceRaw.indexOf("=");
        if (eq <= 0) {
          process.stderr.write("错误：--replace 须是 <旧>=<新> 的形式\n");
          return 2;
        }
        replace = [replaceRaw.slice(0, eq), replaceRaw.slice(eq + 1)];
      }
      const raw: Record<string, unknown> = {
        name,
        action: act,
        match: {
          ...(contains.length ? { contains } : {}),
          ...(regex !== null ? { regex } : {}),
        },
      };
      if (bus !== null) raw.bus = bus;
      if (sender !== null) raw.sender = sender;
      if (kind !== null) raw.kind = kind;
      if (prefix !== null || suffix !== null || replace !== undefined) {
        raw.rewrite = {
          ...(replace ? { replace } : {}),
          ...(prefix !== null ? { prefix } : {}),
          ...(suffix !== null ? { suffix } : {}),
        };
      }
      if (judgeRaw !== null) raw.judgeThreshold = Number(judgeRaw);
      if (reason !== null) raw.reason = reason;
      const { rule, needsEnable } = addInterventionRule(resolvedHome, raw);
      process.stdout.write(`已加规则 ${rule.id}（${rule.name}，${rule.action}）。\n`);
      if (needsEnable) {
        process.stdout.write(`注意：${rule.action} 规则建出来默认是关的，须机主显式跑 nyra intervention enable ${rule.id} 才生效。\n`);
      }
      if (rule.judgeThreshold !== undefined) {
        process.stdout.write("注意：这条规则配了 judge 门槛，但生产接线目前没接真模型 judge——没接 judge 时这条规则不触发（只记审计）。\n");
      }
      return 0;
    }
    if (action === "remove") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra intervention remove <id>\n");
        return 2;
      }
      if (!removeInterventionRule(resolvedHome, id)) {
        process.stderr.write(`错误：没有这条规则：${id}\n`);
        return 1;
      }
      process.stdout.write(`已删规则 ${id}。\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write(`错误：用法：nyra intervention ${action} <id>\n`);
        return 2;
      }
      const rule = setInterventionRuleEnabled(resolvedHome, id, action === "enable");
      if (!rule) {
        process.stderr.write(`错误：没有这条规则：${id}\n`);
        return 1;
      }
      process.stdout.write(`规则 ${id}（${rule.name}）已${action === "enable" ? "开" : "关"}。\n`);
      return 0;
    }
    if (action === "on" || action === "off") {
      const config = setInterventionsEnabled(resolvedHome, action === "on");
      process.stdout.write(`总线拦截总开关已${config.enabled ? "开" : "关"}。\n`);
      return 0;
    }
    if (action === "log") {
      const limitRaw = flagValue(argv, "--limit");
      const limit = limitRaw !== null ? Number(limitRaw) : 50;
      if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
        process.stderr.write("错误：--limit 须是 1–500 的整数\n");
        return 2;
      }
      const entries = readInterventionAudit(resolvedHome, Math.floor(limit));
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
        return 0;
      }
      if (!entries.length) {
        process.stdout.write("拦截审计还是空的（还没有命中的规则）。\n");
        return 0;
      }
      for (const e of entries) {
        process.stdout.write(
          `  ${e.at}  ${e.bus}/${e.kind}  ${e.sender}(${e.sender_kind})  ${e.action}  规则 ${e.rule_id}（${e.rule_name}）  指纹 ${e.text_fingerprint}  ${e.text_length} 字` +
          `${e.judge_score !== undefined ? `  judge ${e.judge_score}` : ""}` +
          `${e.reason ? `  （${e.reason}）` : ""}\n`,
        );
      }
      return 0;
    }
    if (action === "test") {
      const bus = flagValue(argv, "--bus") ?? "";
      const sender = flagValue(argv, "--sender") ?? "";
      const senderKind = flagValue(argv, "--sender-kind") ?? "";
      const kind = flagValue(argv, "--kind") ?? "";
      const text = flagValue(argv, "--text") ?? "";
      if (!bus || !sender || !senderKind || !kind || !text) {
        process.stderr.write("错误：用法：nyra intervention test --bus <总线> --sender <名> --sender-kind owner|peer|bot|system --kind send|publish --text <文字>\n");
        return 2;
      }
      if (!(["group", "peer", "a2a", "agui"] as const).includes(bus as InterventionBus)) {
        process.stderr.write("错误：--bus 只认 group / peer / a2a / agui\n");
        return 2;
      }
      if (!(["owner", "peer", "bot", "system"] as const).includes(senderKind as BusSenderKind)) {
        process.stderr.write("错误：--sender-kind 只认 owner / peer / bot / system\n");
        return 2;
      }
      if (kind !== "send" && kind !== "publish") {
        process.stderr.write("错误：--kind 只认 send / publish\n");
        return 2;
      }
      const msg: BusMessage = {
        id: newBusMessageId(),
        bus: bus as InterventionBus,
        sender,
        senderKind: senderKind as BusSenderKind,
        kind: kind as InterventionPoint,
        text,
      };
      const result = await applyInterventions(resolvedHome, msg, { audit: false });
      process.stdout.write(`结论：${result.verdict}${result.matched.length ? `（命中规则 ${result.matched.join("、")}）` : "（没有命中规则）"}\n`);
      if (result.verdict === "rewrite") {
        process.stdout.write(`改写后：${result.text}\n`);
      }
      if (result.verdict === "drop") {
        process.stdout.write("这条消息会被丢弃（不进总线）。\n");
      }
      return 0;
    }
    process.stderr.write(`错误：未知动作 intervention ${action}\n${USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
