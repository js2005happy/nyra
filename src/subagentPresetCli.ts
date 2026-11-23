// src/subagentPresetCli.ts — G-P2-3 子 agent 具名预设的 CLI：
// `nyra subagent preset <list|show|add|remove|default>`。
//
//   list [--workdir <目录>] [--json]   列出全部预设（内置 + 用户层 +
//                                     项目层；同名高优先级覆盖）
//   show <名> [--workdir <目录>] [--json]
//                                     看一条预设的定义与来源
//   add <名> --tools a,b,c [--shell-readonly] [--model <模型>]
//       [--max-turns N] [--description <描述>] [--yes]
//                                     新增或覆盖一条用户层预设
//   remove <名> [--yes]                删除一条用户层预设（内置删不掉）
//   default [<名>|--clear]             设 / 清用户层默认预设
//
// 只动用户层文件（~/.nyra/subagent-presets.json，0600 原子写）；项目层
// 文件（<workdir>/.nyra/subagent-presets.json）是版本控制的项目文件，
// 这里只读不写，改它直接改文件。--yes 是防手滑：add 覆盖已有预设、
// remove、default 改动时须显式确认（list/show 不用）。
import { resolveHome } from "./config.ts";
import { TOOL_SCHEMAS } from "./tools.ts";
import {
  BUILTIN_PRESETS,
  PresetError,
  addUserPreset,
  listAllPresets,
  loadPresetLayers,
  removeUserPreset,
  resolveSubagentPreset,
  setUserDefaultPreset,
  type PresetSource,
  type SubagentPreset,
} from "./subagentPresets.ts";

const USAGE = [
  "用法：",
  "  nyra subagent preset list [--workdir <目录>] [--json]   列出全部预设（内置 + 用户层 + 项目层；同名高优先级覆盖）",
  "  nyra subagent preset show <名> [--workdir <目录>] [--json]   看一条预设的定义与来源",
  "  nyra subagent preset add <名> --tools <工具名,逗号分隔> [--shell-readonly] [--model <模型>] [--max-turns <1-12>] [--description <描述>] --yes   新增或覆盖一条用户层预设",
  "  nyra subagent preset remove <名> --yes   删除一条用户层预设（内置预设删不掉）",
  "  nyra subagent preset default [<名>|--clear]   设 / 清用户层默认预设（不给名时显示当前默认）",
  "说明：预设解析优先级 session（本次委派参数）> project（<workdir>/.nyra/subagent-presets.json）> user（~/.nyra/subagent-presets.json）> builtin；内置只有 general-purpose（默认不限）与 review（只读）。详见 docs/subagent-presets.md。",
].join("\n");

export function knownToolNames(): string[] {
  return TOOL_SCHEMAS
    .map((s) => (s as { function?: { name?: string } }).function?.name)
    .filter((n): n is string => Boolean(n));
}

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function sourceLabel(source: PresetSource): string {
  switch (source) {
    case "session": return "本次委派";
    case "project": return "项目";
    case "user": return "用户";
    case "builtin": return "内置";
  }
}

function printPreset(p: SubagentPreset, source: PresetSource): void {
  const parts = [`${p.name}（${sourceLabel(source)}）`];
  if (p.description) parts.push(p.description);
  parts.push(p.tools?.length ? `工具：${p.tools.join("、")}` : "工具：不限（沿用父级）");
  if (p.shellReadOnly === true) parts.push("shell：只读");
  if (p.model) parts.push(`模型：${p.model}`);
  if (typeof p.maxTurns === "number") parts.push(`最大轮数：${p.maxTurns}`);
  process.stdout.write(parts.join("；") + "\n");
}

export async function handleSubagentPreset(argv: string[], home: string): Promise<number> {
  const resolvedHome = home || resolveHome();
  const action = argv[0];
  const knownTools = knownToolNames();
  const workdir = flagValue(argv, "--workdir") ?? process.cwd();
  if (!action) {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  try {
    if (action === "list") {
      const layers = loadPresetLayers(resolvedHome, workdir, knownTools);
      for (const e of [...layers.user.errors, ...layers.project.errors]) {
        process.stderr.write(`提示：${e}\n`);
      }
      const all = listAllPresets({ project: layers.project.presets, user: layers.user.presets });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(all.map(({ preset, source }) => ({ ...preset, source })), null, 2) + "\n");
        return 0;
      }
      if (!all.length) {
        process.stdout.write("没有预设（内置 general-purpose、review 应始终存在）。\n");
        return 0;
      }
      for (const { preset, source } of all) printPreset(preset, source);
      const def = layers.project.defaultPreset ?? layers.user.defaultPreset;
      process.stdout.write(def ? `默认预设：${def}（${layers.project.defaultPreset ? "项目" : "用户"}层）\n` : "默认预设：未设（用 general-purpose）\n");
      return 0;
    }
    if (action === "show") {
      const name = argv[1] ?? "";
      if (!name) {
        process.stderr.write("错误：用法：nyra subagent preset show <名> [--workdir <目录>] [--json]\n");
        return 2;
      }
      const layers = loadPresetLayers(resolvedHome, workdir, knownTools);
      const r = resolveSubagentPreset(name, { project: layers.project.presets, user: layers.user.presets });
      if (!r.ok) {
        process.stderr.write(`错误：${r.error}\n`);
        return 1;
      }
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify({ ...r.preset, source: r.source }, null, 2) + "\n");
        return 0;
      }
      printPreset(r.preset, r.source);
      return 0;
    }
    if (action === "add") {
      const name = argv[1] ?? "";
      if (!name) {
        process.stderr.write("错误：用法：nyra subagent preset add <名> --tools <工具名,逗号分隔> [--shell-readonly] [--model <模型>] [--max-turns <1-12>] [--description <描述>] --yes\n");
        return 2;
      }
      const toolsRaw = flagValue(argv, "--tools");
      if (!toolsRaw) {
        process.stderr.write("错误：add 须给 --tools <工具名,逗号分隔>（想不限工具就别建预设，直接用 general-purpose）\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        process.stderr.write("错误：add 会写用户层预设文件，须加 --yes 确认\n");
        return 2;
      }
      const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      const raw: Record<string, unknown> = { tools };
      const description = flagValue(argv, "--description");
      if (description) raw.description = description;
      if (argv.includes("--shell-readonly")) raw.shellReadOnly = true;
      const model = flagValue(argv, "--model");
      if (model) raw.model = model;
      const maxTurnsRaw = flagValue(argv, "--max-turns");
      if (maxTurnsRaw !== null) {
        const n = Number(maxTurnsRaw);
        if (!Number.isInteger(n)) throw new PresetError("--max-turns 须是整数");
        raw.maxTurns = n;
      }
      const layers = loadPresetLayers(resolvedHome, workdir, knownTools);
      const existingFrom = layers.user.presets[name]
        ? "用户层" : layers.project.presets[name] ? "项目层" : BUILTIN_PRESETS[name] ? "内置" : null;
      const preset = addUserPreset(resolvedHome, name, raw, knownTools);
      process.stdout.write(existingFrom
        ? `已覆盖用户层预设 ${name}（原先${existingFrom}的定义被用户层覆盖）。\n`
        : `已新增用户层预设 ${name}。\n`);
      printPreset(preset, "user");
      return 0;
    }
    if (action === "remove") {
      const name = argv[1] ?? "";
      if (!name) {
        process.stderr.write("错误：用法：nyra subagent preset remove <名> --yes\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        process.stderr.write("错误：remove 会删用户层预设，须加 --yes 确认\n");
        return 2;
      }
      removeUserPreset(resolvedHome, name, knownTools);
      process.stdout.write(`已删除用户层预设 ${name}。\n`);
      return 0;
    }
    if (action === "default") {
      const name = argv[1] ?? null;
      if (argv.includes("--clear")) {
        setUserDefaultPreset(resolvedHome, null, knownTools);
        process.stdout.write("已清除用户层默认预设（委派默认用 general-purpose，除非项目层设了默认）。\n");
        return 0;
      }
      if (name === null) {
        const layers = loadPresetLayers(resolvedHome, workdir, knownTools);
        const def = layers.project.defaultPreset ?? layers.user.defaultPreset;
        process.stdout.write(def ? `默认预设：${def}（${layers.project.defaultPreset ? "项目" : "用户"}层）\n` : "默认预设：未设（用 general-purpose）\n");
        return 0;
      }
      setUserDefaultPreset(resolvedHome, name, knownTools);
      process.stdout.write(`已设用户层默认预设：${name}（项目层默认优先于它）。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 subagent preset ${action}\n${USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
