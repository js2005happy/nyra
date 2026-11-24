// src/agentDeclCli.ts — G-P2-5 声明式 agent 的 CLI：`nyra agent`。
//
//   load <文件.yaml|json> [--yes]   校验声明并注册进 ~/.nyra/agents/
//                                    （同名已存在时须 --yes 才覆盖）
//   show <名字> [--json]            看一条已注册声明的定义
//   list [--json]                   列出全部已注册声明
//   remove <名字> --yes             删除一条已注册声明
//   run <名字> ["<任务>"] [--preset <预设>] [--json]
//                                   用声明跑一轮（实现在 cli.ts 的
//                                   handleAgentRun 里——它要建 Agent，
//                                   不能从这里反向 import cli.ts）
//
// 只动仓库文件（~/.nyra/agents/<名字>.yaml|json，0600 原子写）；
// run 不在这里实现，cli.ts 分发时 run 走 handleAgentRun，其余走这里。
// 加载是 fail-closed：解析失败、未知字段、非法值、未知工具名、未知模型、
// 注入扫描命中、workflow 引用不存在，一律拒绝并报中文错。
import { resolveHome, loadConfig } from "./config.ts";
import { readFileSync } from "node:fs";
import { READONLY_TOOLS, TOOL_SCHEMAS } from "./tools.ts";
import { MODEL_CATALOG, loadModelCache } from "./modelCatalog.ts";
import {
  listStoredAgentDecls,
  loadAgentDecl,
  loadStoredAgentDecl,
  removeStoredAgentDecl,
  saveAgentDecl,
  type AgentDecl,
  type AgentDeclValidateOpts,
} from "./agentDecl.ts";

const USAGE = [
  "用法：",
  "  nyra agent load <文件.yaml|json> [--yes]   校验声明并注册（同名已存在时须 --yes 才覆盖）",
  "  nyra agent show <名字> [--json]   看一条已注册声明的定义",
  "  nyra agent list [--json]   列出全部已注册声明",
  "  nyra agent remove <名字> --yes   删除一条已注册声明",
  "  nyra agent run <名字> [\"<任务>\"] [--preset <预设>] [--json]   用声明跑一轮（有 workflow 的声明走工作流，没 workflow 的走 agent 主循环）",
  "说明：声明式 agent（G-P2-5）：一个 YAML 文件声明一个 agent（instructions + tools + workflow），格式 nyra-agent-v1；tools 是白名单上限、与预设交集只能收窄；model 须是已配置的模型；instructions 过注入扫描才认；workflow 可引用已导入的工作流或内联 fixed 定义。详见 docs/agent-decl.md。",
].join("\n");

export function knownToolNames(): string[] {
  return TOOL_SCHEMAS
    .map((s) => (s as { function?: { name?: string } }).function?.name)
    .filter((n): n is string => Boolean(n));
}

/**
 * 已知模型表：内置模型目录（裸名 + provider:model 两种写法）+ 模型缓存
 * + config 里的模型（model / delegate_model / plan_model / act_model）。
 * 声明的 model 须在这个表里，否则加载时直接拒绝。
 */
export function knownModelNames(home: string): string[] {
  const out = new Set<string>();
  for (const e of MODEL_CATALOG) {
    out.add(e.model);
    out.add(`${e.provider}:${e.model}`);
  }
  const cache = loadModelCache(home);
  if (cache) {
    // 缓存的键就是模型 id（ModelCacheEntry 本身没有 model 字段）。
    for (const id of Object.keys(cache.models ?? {})) {
      if (id) out.add(id);
    }
  }
  try {
    const config = loadConfig(home) as Record<string, unknown>;
    for (const k of ["model", "delegate_model", "plan_model", "act_model"]) {
      const v = config[k];
      if (typeof v === "string" && v.trim()) out.add(v.trim());
    }
  } catch { /* 配置读坏时不挡模型表：内置表与缓存仍可用 */ }
  return [...out];
}

export function validateOpts(home: string): AgentDeclValidateOpts {
  return {
    knownTools: knownToolNames(),
    readOnlyTools: READONLY_TOOLS,
    knownModels: knownModelNames(home),
    home,
  };
}

function describeWorkflow(decl: AgentDecl): string {
  if (!decl.workflow) return "无";
  if ("ref" in decl.workflow) return `引用工作流 ${decl.workflow.ref}`;
  return `内联 fixed 工作流 ${decl.workflow.inline.name}（${decl.workflow.inline.steps.length} 步）`;
}

function printDecl(decl: AgentDecl, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(decl, null, 2) + "\n");
    return;
  }
  process.stdout.write(`名字：${decl.name}\n`);
  if (decl.description) process.stdout.write(`描述：${decl.description}\n`);
  process.stdout.write(`工具：${decl.tools?.length ? decl.tools.join("、") : "不限（沿用父级工具集）"}\n`);
  process.stdout.write(`模型：${decl.model ?? "默认（配置模型）"}\n`);
  process.stdout.write(`工作流：${describeWorkflow(decl)}\n`);
  if (decl.approval && Object.keys(decl.approval).length) {
    process.stdout.write(`审批模式：${Object.entries(decl.approval).map(([t, m]) => `${t}=${m}`).join("、")}\n`);
  }
  if (decl.limits) {
    const parts: string[] = [];
    if (decl.limits.max_turns !== undefined) parts.push(`最多 ${decl.limits.max_turns} 轮`);
    if (decl.limits.max_cost_usd !== undefined) parts.push(`成本上限 $${decl.limits.max_cost_usd}`);
    if (parts.length) process.stdout.write(`限制：${parts.join("、")}\n`);
  }
  process.stdout.write(`说明（instructions）：\n${decl.instructions}\n`);
}

export async function handleAgentDecl(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  const resolvedHome = home || resolveHome();
  const asJson = argv.includes("--json");
  const yes = argv.includes("--yes");
  try {
    if (action === "load") {
      const file = argv[1];
      if (!file) {
        process.stderr.write("错误：用法：nyra agent load <文件.yaml|json> [--yes]\n");
        return 2;
      }
      const decl = loadAgentDecl(file, validateOpts(resolvedHome));
      // loadAgentDecl 里已做注入扫描与全量校验；这里再确认一次同名覆盖
      // 须 --yes（saveAgentDecl 里同样会拦，双保险）。
      const text = readFileSync(file, "utf-8");
      const path = saveAgentDecl(resolvedHome, decl, text, file, yes);
      process.stdout.write(`声明 ${decl.name} 已注册：${path}\n`);
      return 0;
    }
    if (action === "show") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("错误：用法：nyra agent show <名字> [--json]\n");
        return 2;
      }
      const decl = loadStoredAgentDecl(resolvedHome, name, validateOpts(resolvedHome));
      printDecl(decl, asJson);
      return 0;
    }
    if (action === "list") {
      const { decls, errors } = listStoredAgentDecls(resolvedHome, validateOpts(resolvedHome));
      if (asJson) {
        process.stdout.write(JSON.stringify(decls.map((d) => ({
          name: d.name,
          description: d.description ?? null,
          tools: d.tools ?? null,
          model: d.model ?? null,
          workflow: d.workflow ? ("ref" in d.workflow ? { ref: d.workflow.ref } : { inline: d.workflow.inline.name }) : null,
        })), null, 2) + "\n");
      } else if (!decls.length) {
        process.stdout.write("还没有注册的声明，先 nyra agent load <文件.yaml> 导入。\n");
      } else {
        for (const d of decls) {
          process.stdout.write(`  ${d.name}${d.description ? ` — ${d.description}` : ""}${d.model ? `（模型 ${d.model}）` : ""}${d.workflow ? `（${describeWorkflow(d)}）` : ""}\n`);
        }
      }
      for (const e of errors) process.stderr.write(`提示：${e}\n`);
      return 0;
    }
    if (action === "remove") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("错误：用法：nyra agent remove <名字> --yes\n");
        return 2;
      }
      if (!yes) {
        process.stderr.write(`删除声明 ${name} 须加 --yes 确认：nyra agent remove ${name} --yes\n`);
        return 2;
      }
      if (!removeStoredAgentDecl(resolvedHome, name)) {
        process.stderr.write(`错误：没有这个声明：${name}\n`);
        return 1;
      }
      process.stdout.write(`声明 ${name} 已删除。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 agent ${action}\n${USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
