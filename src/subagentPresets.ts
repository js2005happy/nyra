// src/subagentPresets.ts — G-P2-3 子 agent 具名预设 + 工具限制（借 Qwen Code
// builtin-agents.ts 的想法，Node 实现，不抄代码）。
//
// Qwen Code 的做法是内置具名子 agent 预设（general-purpose 与 review-agent，
// review 的工具被限在读文件/搜索/列文件/Shell/写文件/编辑几项），解析优先级
// session > project > user > extension > builtin。Nyra 原来只有委派时的
// tools 白名单与模型指定，没有具名、可分层覆盖的预设。本批补这一层：
//   - 内置两档：general-purpose（默认，沿用父级工具集，不额外限制）与
//     review（只读：只读工具 + 只读 shell，禁一切写操作）；
//   - 预设定名解析优先级 session（本次委派参数）> project
//     （<workdir>/.nyra/subagent-presets.json）> user
//     （~/.nyra/subagent-presets.json，0600）> builtin；
//   - 预设定名解析同样分层：本次委派显式给的 preset 优先，其次项目
//     文件的 defaultPreset，再次用户文件的 defaultPreset，最后
//     general-purpose；defaultPreset 指到不存在的预设时委派直接拒绝
//     （fail-closed：用户明明要了限制，静默跑 unrestricted 等于
//     违反意图）；
//   - review 预设的 shell 只接受只读命令（见 isReadOnlyShellCommand，
//     启发式判定 + 审批门兜底）；想放开写命令须在预设定义里显式把
//     shellReadOnly 设 false，不能靠单次调用绕过。
//
// 叶模块：只引 node 内置。工具名校验用的已知工具表由调用方传入（避免
// 引 tools.ts 造成循环导入）；review 的工具表是 tools.ts READONLY_TOOLS
// 的字面镜像，测试里断言它始终是 READONLY_TOOLS ∪ {shell} 的子集，
// 漂移了测试会红。
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export class PresetError extends Error {}

/** 预设名：小写字母开头，只含小写字母/数字/_/-，最长 32 字。 */
export const PRESET_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 子 agent 预设定义。tools 不给 = 沿用父级工具集，不额外限制。 */
export interface SubagentPreset {
  name: string;
  description?: string;
  /** 工具白名单（只认 tools.ts 里的工具名）；不给 = 不限制。 */
  tools?: string[];
  /** 为 true 时 shell 只接受只读命令（写命令直接拒绝，不进审批）。 */
  shellReadOnly?: boolean;
  /** 子任务改用的模型（不给时沿用委派默认模型）。 */
  model?: string;
  /** 子任务最大轮数上限（不给时不设上限，只受 delegate 本身的 12 轮硬顶约束）。 */
  maxTurns?: number;
}

/** 预设定义来自哪一层（解析优先级 session > project > user > builtin）。 */
export type PresetSource = "session" | "project" | "user" | "builtin";

/** review 预设的工具表：tools.ts READONLY_TOOLS 的字面镜像 + shell。 */
export const REVIEW_PRESET_TOOLS: readonly string[] = [
  "read_file", "list_dir", "grep_search", "git_status",
  "web_fetch", "web_search", "read_skill", "memory_search", "knowledge_search",
  "session_search", "editor_context",
  "poppy_discover", "poppy_identity_check", "poppy_permission_check",
  "lsp_diagnostics", "lsp_symbols", "describe_image",
  "shell",
];

/** 内置预设。general-purpose 不限工具；review 只读。 */
export const BUILTIN_PRESETS: Record<string, SubagentPreset> = {
  "general-purpose": {
    name: "general-purpose",
    description: "默认：沿用父级工具集，不额外限制",
  },
  review: {
    name: "review",
    description: "只读评审：只读工具 + 只读 shell，禁一切写操作",
    tools: [...REVIEW_PRESET_TOOLS],
    shellReadOnly: true,
  },
};

/** 预设配置文件名（用户层在家目录，项目层在工作目录的 .nyra 下）。 */
export const USER_PRESETS_FILE = "subagent-presets.json";
export const PROJECT_PRESETS_FILE = "subagent-presets.json";

export function userPresetsPath(home: string): string {
  return join(home, USER_PRESETS_FILE);
}

export function projectPresetsPath(workdir: string): string {
  return join(workdir, ".nyra", PROJECT_PRESETS_FILE);
}

/** 预设文件内容（version 1）。defaultPreset 不给或为 null = 不设默认。 */
export interface PresetFileData {
  presets: Record<string, SubagentPreset>;
  defaultPreset: string | null;
  /** 加载时发现的问题（损坏已备份、非法条目已丢弃等），不抛错、只记录。 */
  errors: string[];
}

function emptyFileData(): PresetFileData {
  return { presets: {}, defaultPreset: null, errors: [] };
}

/**
 * 校验一条预设定义（raw 是文件/调用方给的任意 JSON）。返回错误列表，
 * 为空 = 合法。knownTools 是调用方传的 tools.ts 工具名表。
 */
export function validatePresetDefinition(
  name: string,
  raw: unknown,
  knownTools: readonly string[],
): string[] {
  const errors: string[] = [];
  if (!PRESET_NAME_RE.test(name)) {
    errors.push(`预设名 ${name} 非法：须小写字母开头，只含小写字母/数字/_/-，最长 32 字`);
    return errors;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`预设 ${name} 不是对象`);
    return errors;
  }
  const o = raw as Record<string, unknown>;
  if (o.description !== undefined && typeof o.description !== "string") {
    errors.push(`预设 ${name} 的 description 须是字符串`);
  }
  if (o.tools !== undefined) {
    if (!Array.isArray(o.tools) || o.tools.some((t) => typeof t !== "string")) {
      errors.push(`预设 ${name} 的 tools 须是字符串数组`);
    } else {
      const unknown = (o.tools as string[]).filter((t) => !knownTools.includes(t));
      if (unknown.length) errors.push(`预设 ${name} 的 tools 含未知工具名：${unknown.join("、")}`);
      if ((o.tools as string[]).length === 0) errors.push(`预设 ${name} 的 tools 为空数组：想不限工具就别写 tools，想只读就用 review 预设`);
    }
  }
  if (o.shellReadOnly !== undefined && typeof o.shellReadOnly !== "boolean") {
    errors.push(`预设 ${name} 的 shellReadOnly 须是布尔值`);
  }
  if (o.model !== undefined && (typeof o.model !== "string" || !o.model.trim())) {
    errors.push(`预设 ${name} 的 model 须是非空字符串`);
  }
  if (o.maxTurns !== undefined) {
    if (typeof o.maxTurns !== "number" || !Number.isInteger(o.maxTurns) || o.maxTurns < 1 || o.maxTurns > 12) {
      errors.push(`预设 ${name} 的 maxTurns 须是 1–12 的整数`);
    }
  }
  return errors;
}

/** 把 raw 归一化成 SubagentPreset（调用方须先调 validatePresetDefinition）。 */
export function normalizePreset(name: string, raw: Record<string, unknown>): SubagentPreset {
  const p: SubagentPreset = { name };
  if (typeof raw.description === "string" && raw.description.trim()) p.description = raw.description.trim();
  if (Array.isArray(raw.tools)) p.tools = (raw.tools as unknown[]).map((t) => String(t)).filter(Boolean);
  if (typeof raw.shellReadOnly === "boolean") p.shellReadOnly = raw.shellReadOnly;
  if (typeof raw.model === "string" && raw.model.trim()) p.model = raw.model.trim();
  if (typeof raw.maxTurns === "number" && Number.isInteger(raw.maxTurns)) p.maxTurns = raw.maxTurns;
  return p;
}

/**
 * 读一个预设文件（用户层或项目层共用）。文件不存在 = 空；损坏先备份
 * 再回空（不抛错，错误记进 errors）；非法条目逐条丢弃并记 errors。
 * 符号链接拒绝读（fail-closed：链接目标不可信）。
 */
export function loadPresetFile(path: string, knownTools: readonly string[]): PresetFileData {
  const data = emptyFileData();
  if (!existsSync(path)) return data;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      data.errors.push(`预设文件 ${path} 是符号链接，已拒绝读取`);
      return data;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层不是对象");
    }
    const o = parsed as Record<string, unknown>;
    if (o.defaultPreset !== undefined && o.defaultPreset !== null) {
      if (typeof o.defaultPreset === "string" && PRESET_NAME_RE.test(o.defaultPreset)) {
        data.defaultPreset = o.defaultPreset;
      } else {
        data.errors.push(`预设文件的 defaultPreset 非法，已忽略：${String(o.defaultPreset)}`);
      }
    }
    const presets = o.presets;
    if (presets !== undefined) {
      if (!presets || typeof presets !== "object" || Array.isArray(presets)) {
        data.errors.push("预设文件的 presets 不是对象，已忽略整节");
      } else {
        for (const [name, raw] of Object.entries(presets as Record<string, unknown>)) {
          const errs = validatePresetDefinition(name, raw, knownTools);
          if (errs.length) {
            data.errors.push(...errs.map((e) => `${e}（已丢弃该预设）`));
            continue;
          }
          data.presets[name] = normalizePreset(name, raw as Record<string, unknown>);
        }
      }
    }
    return data;
  } catch (err: unknown) {
    // 损坏：先备份再回空（备份失败也不破坏读取）。
    try {
      const backup = `${path}.corrupt-${Date.now()}`;
      renameSync(path, backup);
      data.errors.push(`预设文件 ${path} 已损坏，已备份到 ${backup}，按空处理`);
    } catch {
      data.errors.push(`预设文件 ${path} 已损坏（${err instanceof Error ? err.message : String(err)}），按空处理`);
    }
    return data;
  }
}

/** 用户层 + 项目层一起读（委派解析用；加载失败只记 errors，不抛错）。 */
export function loadPresetLayers(
  home: string,
  workdir: string,
  knownTools: readonly string[],
): { user: PresetFileData; project: PresetFileData } {
  return {
    user: loadPresetFile(userPresetsPath(home), knownTools),
    project: loadPresetFile(projectPresetsPath(workdir), knownTools),
  };
}

/** 预设名解析：本次委派显式给的 > 项目默认 > 用户默认 > general-purpose。 */
export function resolvePresetName(
  explicit: string | undefined,
  layers: { user: PresetFileData; project: PresetFileData },
): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (layers.project.defaultPreset) return layers.project.defaultPreset;
  if (layers.user.defaultPreset) return layers.user.defaultPreset;
  return "general-purpose";
}

export interface PresetLayers {
  session?: Record<string, SubagentPreset>;
  project?: Record<string, SubagentPreset>;
  user?: Record<string, SubagentPreset>;
}

export type PresetResolution =
  | { ok: true; preset: SubagentPreset; source: PresetSource }
  | { ok: false; error: string };

/**
 * 按名解析预设定（定义来源优先级 session > project > user > builtin）。
 * 名字非法或哪层都没有 → fail-closed 报错（调用方拒绝这次委派）。
 */
export function resolveSubagentPreset(
  name: string,
  layers: PresetLayers,
): PresetResolution {
  if (!PRESET_NAME_RE.test(name)) {
    return { ok: false, error: `未知子 agent 预设：${name}（预设名须小写字母开头，只含小写字母/数字/_/-，最长 32 字）` };
  }
  const session = layers.session?.[name];
  if (session) return { ok: true, preset: session, source: "session" };
  const project = layers.project?.[name];
  if (project) return { ok: true, preset: project, source: "project" };
  const user = layers.user?.[name];
  if (user) return { ok: true, preset: user, source: "user" };
  const builtin = BUILTIN_PRESETS[name];
  if (builtin) return { ok: true, preset: builtin, source: "builtin" };
  return { ok: false, error: `未知子 agent 预设：${name}（内置只有 general-purpose、review；自定义预设见 nyra subagent preset add）` };
}

/** 合并四层预设定（同名高优先级覆盖），供 list 展示用。 */
export function listAllPresets(layers: PresetLayers): Array<{ preset: SubagentPreset; source: PresetSource }> {
  const out = new Map<string, { preset: SubagentPreset; source: PresetSource }>();
  for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
    out.set(name, { preset, source: "builtin" });
  }
  for (const [name, preset] of Object.entries(layers.user ?? {})) {
    out.set(name, { preset, source: "user" });
  }
  for (const [name, preset] of Object.entries(layers.project ?? {})) {
    out.set(name, { preset, source: "project" });
  }
  for (const [name, preset] of Object.entries(layers.session ?? {})) {
    out.set(name, { preset, source: "session" });
  }
  return [...out.values()].sort((a, b) => (a.preset.name < b.preset.name ? -1 : 1));
}

// ---- 用户层写操作（0600 原子写；符号链接拒绝）----

function writePresetFileAtomic(path: string, data: { presets: Record<string, SubagentPreset>; defaultPreset: string | null }): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new PresetError(`预设文件 ${path} 是符号链接，已拒绝写入`);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = JSON.stringify({ version: 1, presets: data.presets, defaultPreset: data.defaultPreset }, null, 2) + "\n";
  const tmp = join(dir, `.subagent-presets-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 新增或覆盖一条用户层预设（校验失败抛错，不写文件）。 */
export function addUserPreset(
  home: string,
  name: string,
  raw: Record<string, unknown>,
  knownTools: readonly string[],
): SubagentPreset {
  const errors = validatePresetDefinition(name, raw, knownTools);
  if (errors.length) throw new PresetError(errors.join("；"));
  const data = loadPresetFile(userPresetsPath(home), knownTools);
  const preset = normalizePreset(name, raw);
  data.presets[name] = preset;
  writePresetFileAtomic(userPresetsPath(home), data);
  return preset;
}

/** 删除一条用户层预设（内置预设删不掉；不存在抛错）。 */
export function removeUserPreset(home: string, name: string, knownTools: readonly string[]): void {
  if (BUILTIN_PRESETS[name]) {
    throw new PresetError(`内置预设 ${name} 不能删除（想改它的行为，在用户层同名覆盖）`);
  }
  const data = loadPresetFile(userPresetsPath(home), knownTools);
  if (!data.presets[name]) throw new PresetError(`用户层没有预设 ${name}`);
  delete data.presets[name];
  if (data.defaultPreset === name) data.defaultPreset = null;
  writePresetFileAtomic(userPresetsPath(home), data);
}

/** 设 / 清用户层默认预设（名字须已存在或为 null；内置名也可以当默认）。 */
export function setUserDefaultPreset(
  home: string,
  name: string | null,
  knownTools: readonly string[],
): void {
  const data = loadPresetFile(userPresetsPath(home), knownTools);
  if (name !== null) {
    const exists = Boolean(data.presets[name]) || Boolean(BUILTIN_PRESETS[name]);
    if (!exists) throw new PresetError(`没有预设 ${name}，先 nyra subagent preset add ${name} 再设默认`);
    data.defaultPreset = name;
  } else {
    data.defaultPreset = null;
  }
  writePresetFileAtomic(userPresetsPath(home), data);
}

// ---- 只读 shell 命令判定 ----

/** 只读命令（第一词）白名单：读、查、算，不产生副作用。 */
const READONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "wc", "sort", "uniq", "diff",
  "pwd", "echo", "printf", "file", "stat", "du", "df", "uname", "whoami", "date",
  "git",
]);

/** git 只读子命令白名单（其余一律按写命令处理）。 */
const READONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "ls-files", "rev-parse",
  "blame", "grep", "ls-tree", "cat-file", "describe", "tag", "remote",
  "config", "stash", // config 无参读配置、stash list 只读；带写参数时仍被第一词后的写动词拦住
]);

/** 写类动词：出现在 git 子命令位置时一律拒绝。 */
const WRITE_VERBS = new Set([
  "add", "commit", "push", "pull", "fetch", "merge", "rebase", "checkout",
  "reset", "clean", "rm", "mv", "restore", "apply", "cherry-pick",
  "init", "clone", "worktree", "update-index",
  // 注意：stash 不在这里——git stash list 是只读，由下面的特判放行，其余拒绝。
]);

/**
 * 只读 shell 命令判定（启发式第一道防线，审批门仍在上面兜底）：
 *  - 按 ; && || | 拆段，每段都要只读；
 *  - 拒绝重定向（> <）、命令替换（$( )、反引号）、后台 &、环境变量赋值（首词含 =）、sudo、cd；
 *  - 首词须在只读白名单里；git 时第二词须在只读子命令白名单里（且不在写动词表里）。
 * 认不出的命令一律按写命令处理（fail-closed），不是放行。
 */
export function isReadOnlyShellCommand(command: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  // 重定向、命令替换、后台执行：整条直接判写。
  if (/[><]/.test(command) || command.includes("$(") || command.includes("`")) return false;
  // 按 shell 连接符拆段（&& || ; |），每段分别判定；空段（行首/行尾的连接符）判写。
  const segments = command.split(/&&|\|\||;|\|/);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) return false;
    if (s.endsWith("&")) return false;
    const words = s.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const first = words[0];
    if (first.includes("=") || first.startsWith("-") || first === "sudo" || first === "cd") return false;
    if (!READONLY_COMMANDS.has(first)) return false;
    if (first === "git") {
      const sub = words[1];
      if (!sub || sub.startsWith("-")) return false;
      if (WRITE_VERBS.has(sub) || !READONLY_GIT_SUBCOMMANDS.has(sub)) return false;
      // git stash 只放行 list；git remote 只放行无参 / -v（add/remove/set-url 是写）；
      // git config 只放行读：0 或 1 个非标志词（--list / 单个 key），key + 值是写。
      if (sub === "stash" && words[2] !== "list") return false;
      if (sub === "remote" && words[2] !== undefined && words[2] !== "-v" && words[2] !== "--verbose") return false;
      if (sub === "config") {
        const operands = words.slice(2).filter((w) => !w.startsWith("-"));
        if (operands.length >= 2) return false;
      }
    }
  }
  return true;
}
