// src/agentDecl.ts — G-P2-5 声明式 agent：一个 YAML 文件声明一个 agent
// （instructions + tools + workflow 打包成 `nyra-agent-v1`）。
//
// 做法借 MAF declarative 的想法（YAML 里声明 agent 本身：loader + models，
// 另有声明式工作流），不抄它的代码与字段形状。
//
// 叶模块：只引 node 内置 + workflow.ts（YAML 子集解析器与工作流校验，
// 复用同一套解析器）+ untrusted.ts（注入扫描）+ middleware.ts（审批模式
// 校验）+ subagentPresets.ts（名字正则同款）。工具名、只读工具表、已知
// 模型表都由调用方注入（opts），不 import tools.ts / modelCatalog.ts，
// 避免循环导入（与 middleware.ts / subagentPresets.ts 同款规矩）。
//
// fail-closed：解析失败、未知字段、非法值、未知工具名、未知模型、
// 注入扫描命中、workflow 引用不存在，一律拒绝并报中文错，不静默丢字段。
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  MAX_PROMPT_CHARS,
  WORKFLOW_NAME_RE,
  loadWorkflowRegistry,
  parseWorkflowText,
  validateWorkflowDefinition,
} from "./workflow.ts";
import type { WorkflowDefinition } from "./workflow.ts";
import { suspiciousLabels } from "./untrusted.ts";
import { validateApprovalModes } from "./middleware.ts";
import type { ApprovalMode } from "./middleware.ts";
import { PRESET_NAME_RE } from "./subagentPresets.ts";
import type { SubagentPreset } from "./subagentPresets.ts";

export class AgentDeclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDeclError";
  }
}

/** 声明格式版本：目前只认 1。 */
export const AGENT_DECL_VERSION = 1;
/** agent 声明的存放目录名（~/.nyra/agents/）。 */
export const AGENT_DECLS_DIR = "agents";
/** instructions 长度上限：与工作流 prompt 上限同款（8000 字）。 */
export const MAX_INSTRUCTIONS_CHARS = MAX_PROMPT_CHARS;
/** description 长度上限：与工作流 description 上限同款（500 字）。 */
export const MAX_DESCRIPTION_CHARS = 500;
/** 声明里 limits.max_cost_usd 的上限：与工作流 max_cost_usd 上限同款。 */
export const MAX_DECL_COST_USD = 1000;

/** workflow 字段：引用已导入的工作流（注册表里须存在），或内联 fixed 定义。 */
export type AgentDeclWorkflow =
  | { ref: string }
  | { inline: WorkflowDefinition };

export interface AgentDeclLimits {
  max_turns?: number;
  max_cost_usd?: number;
}

export interface AgentDecl {
  version: 1;
  name: string;
  description?: string;
  instructions: string;
  tools?: string[];
  model?: string;
  workflow?: AgentDeclWorkflow;
  approval?: Record<string, ApprovalMode>;
  limits?: AgentDeclLimits;
}

export interface AgentDeclValidateOpts {
  /** 已注册工具名表（调用方从 TOOL_SCHEMAS / KNOWN_TOOLS 取）。必填。 */
  knownTools: readonly string[];
  /** 只读工具表（调用方从 tools.ts 的 READONLY_TOOLS 取）。必填。 */
  readOnlyTools: ReadonlySet<string>;
  /**
   * 已知模型表（调用方从内置模型目录 + 模型缓存 + config 里的模型拼；
   * 含 `provider:model` 与裸模型名两种写法）。model 字段出现时必填，
   * 传 null 表示调用方给不出模型表——此时带 model 的声明直接拒绝
   *（fail-closed：没法核就别认）。
   */
  knownModels: readonly string[] | null;
  /**
   * 传 home 时校验 workflow.ref 在注册表里存在；不传时只校验名字格式，
   * 引用存在性留到 run 时再查。
   */
  home?: string | null;
}

const TOP_KEYS = new Set([
  "version", "name", "description", "instructions", "tools",
  "model", "workflow", "approval", "limits",
]);
const LIMIT_KEYS = new Set(["max_turns", "max_cost_usd"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function needStr(v: unknown, where: string, min: number, max: number): string {
  if (typeof v !== "string" || v.trim().length < min || v.length > max) {
    throw new AgentDeclError(`${where} 须是 ${min}–${max} 字的字符串`);
  }
  return v;
}

/**
 * 校验一个已解析的声明值（fail-closed：第一处非法就抛中文错）。
 * 名字正则与子 agent 预设同款（小写字母开头，只含小写字母/数字/_/-，
 * 最长 32 字），这样声明名能直接当会话层预设名用（见 agentDeclToPreset）。
 */
export function validateAgentDecl(value: unknown, opts: AgentDeclValidateOpts): AgentDecl {
  if (!isObj(value)) throw new AgentDeclError("agent 声明无效：顶层须是映射");
  for (const k of Object.keys(value)) {
    if (!TOP_KEYS.has(k)) throw new AgentDeclError(`agent 声明无效：顶层不认字段 ${k}`);
  }
  if (value.version !== AGENT_DECL_VERSION) {
    throw new AgentDeclError(`agent 声明无效：version 目前只认 ${AGENT_DECL_VERSION}`);
  }
  const name = value.name;
  if (typeof name !== "string" || !PRESET_NAME_RE.test(name)) {
    throw new AgentDeclError("agent 声明无效：name 须是小写字母开头、只含小写字母/数字/_/-、最长 32 字");
  }
  const decl = { version: 1, name } as AgentDecl;
  if (value.description !== undefined) {
    decl.description = needStr(value.description, "description", 1, MAX_DESCRIPTION_CHARS).trim();
  }
  if (value.instructions === undefined) {
    throw new AgentDeclError("agent 声明无效：instructions 必填（这个 agent 是谁、干什么、怎么做）");
  }
  const instructions = needStr(value.instructions, "instructions", 1, MAX_INSTRUCTIONS_CHARS);
  // 注入扫描：声明文件可能是从别处抄来的，instructions 里藏“忽略之前指令”
  // 这类话必须在加载时就拦住，不等跑起来才炸。只用 all 档——context 档会
  // 把“你是代码审查员”这类正常身份写法也当身份改写拦掉，误伤太大；
  // all 档只认高置信模式（忽略/覆盖指令、执行命令/删文件、泄露机密等）。
  // 误伤时报错里列出命中的模式名，用户改写一句就能过。
  const labels = suspiciousLabels(instructions, "all");
  if (labels.length) {
    throw new AgentDeclError(
      `agent 声明无效：instructions 命中注入扫描（${labels.join("、")}），请改写后再加载——声明里的指令性文字只应描述这个 agent 该干什么，不要写“忽略/覆盖指令、执行命令、泄露密钥”这类话`,
    );
  }
  decl.instructions = instructions;
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.some((t) => typeof t !== "string")) {
      throw new AgentDeclError("agent 声明无效：tools 须是字符串数组");
    }
    if (value.tools.length === 0) {
      throw new AgentDeclError("agent 声明无效：tools 为空数组：想不限工具就别写 tools");
    }
    const tools = [...new Set(value.tools as string[])];
    const unknown = tools.filter((t) => !opts.knownTools.includes(t));
    if (unknown.length) throw new AgentDeclError(`agent 声明无效：tools 含未知工具名：${unknown.join("、")}`);
    decl.tools = tools;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 128) {
      throw new AgentDeclError("agent 声明无效：model 须是非空字符串（最长 128 字）");
    }
    if (opts.knownModels === null) {
      throw new AgentDeclError("agent 声明无效：无法校验 model（调用方没给已知模型表），不认这个模型");
    }
    if (!opts.knownModels.includes(value.model.trim())) {
      throw new AgentDeclError(`agent 声明无效：model ${value.model.trim()} 不是已配置的模型（内置模型目录、模型缓存、config 里的模型都不认它）`);
    }
    decl.model = value.model.trim();
  }
  if (value.workflow !== undefined) {
    decl.workflow = validateDeclWorkflow(value.workflow, name, opts);
  }
  if (value.approval !== undefined) {
    if (!isObj(value.approval)) throw new AgentDeclError("agent 声明无效：approval 须是映射（工具名 → require / never_require）");
    const modes: Record<string, ApprovalMode> = {};
    for (const [tool, mode] of Object.entries(value.approval)) {
      if (mode !== "require" && mode !== "never_require") {
        throw new AgentDeclError(`agent 声明无效：approval.${tool} 只认 require / never_require`);
      }
      modes[tool] = mode;
    }
    // never_require 只对只读工具生效（与 G-P2-4 中间件同款口径；写工具
    // 配了直接拒绝，不静默改成 require）。
    const { rejected } = validateApprovalModes(modes, opts.readOnlyTools);
    if (rejected.length) {
      throw new AgentDeclError(`agent 声明无效：${rejected.map((r) => r.reason).join("；")}`);
    }
    decl.approval = modes;
  }
  if (value.limits !== undefined) {
    if (!isObj(value.limits)) throw new AgentDeclError("agent 声明无效：limits 须是映射");
    for (const k of Object.keys(value.limits)) {
      if (!LIMIT_KEYS.has(k)) throw new AgentDeclError(`agent 声明无效：limits 不认字段 ${k}`);
    }
    const limits: AgentDeclLimits = {};
    if (value.limits.max_turns !== undefined) {
      const n = value.limits.max_turns;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 12) {
        throw new AgentDeclError("agent 声明无效：limits.max_turns 须是 1–12 的整数");
      }
      limits.max_turns = n;
    }
    if (value.limits.max_cost_usd !== undefined) {
      const n = value.limits.max_cost_usd;
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > MAX_DECL_COST_USD) {
        throw new AgentDeclError(`agent 声明无效：limits.max_cost_usd 须是 0–${MAX_DECL_COST_USD} 的数字`);
      }
      limits.max_cost_usd = n;
    }
    decl.limits = limits;
  }
  return decl;
}

/**
 * 校验 workflow 字段：{ ref } 与 { inline } 二选一，多给少给都拒绝；
 * ref 只认工作流名字格式（传了 home 时还须在注册表里存在）；
 * inline 只认 fixed 形态（coordinator / dynamic 有自己的 goal 与协调者，
 * 不适合包进一个 agent 声明里），name 缺省时用声明名，version 缺省按 1 算。
 */
function validateDeclWorkflow(
  raw: unknown,
  declName: string,
  opts: AgentDeclValidateOpts,
): AgentDeclWorkflow {
  if (!isObj(raw)) throw new AgentDeclError("agent 声明无效：workflow 须是映射");
  const hasRef = raw.ref !== undefined;
  const hasInline = raw.inline !== undefined;
  for (const k of Object.keys(raw)) {
    if (k !== "ref" && k !== "inline") throw new AgentDeclError(`agent 声明无效：workflow 不认字段 ${k}`);
  }
  if (hasRef === hasInline) {
    throw new AgentDeclError("agent 声明无效：workflow 须在 ref（引用已导入的工作流）与 inline（内联 fixed 定义）里二选一");
  }
  if (hasRef) {
    if (typeof raw.ref !== "string" || !WORKFLOW_NAME_RE.test(raw.ref) || raw.ref.length > 100) {
      throw new AgentDeclError("agent 声明无效：workflow.ref 须是合法的工作流名字");
    }
    if (opts.home) {
      let exists = false;
      try {
        exists = loadWorkflowRegistry(opts.home).workflows.some((w) => w.name === raw.ref);
      } catch {
        exists = false;
      }
      if (!exists) {
        throw new AgentDeclError(`agent 声明无效：workflow.ref 引用的工作流 ${raw.ref} 还没导入（先 nyra workflow import <文件> 导入，再加载这个声明）`);
      }
    }
    return { ref: raw.ref as string };
  }
  const inline = raw.inline;
  if (!isObj(inline)) throw new AgentDeclError("agent 声明无效：workflow.inline 须是映射（一个 fixed 工作流定义）");
  if (inline.mode !== undefined && inline.mode !== "fixed") {
    throw new AgentDeclError("agent 声明无效：workflow.inline 只认 fixed 形态（coordinator / dynamic 不适合包进 agent 声明里）");
  }
  // name 缺省用声明名；version 缺省按 1 算；其余字段原样交给工作流校验
  //（工具名、步骤、触发器、成本上限都在那一层校验，不在这里另起一套）。
  // 工作流校验的错包一层 AgentDeclError：声明加载的调用方只认这一种错。
  let def: WorkflowDefinition;
  try {
    def = validateWorkflowDefinition(
      { ...inline, name: typeof inline.name === "string" ? inline.name : declName, version: 1 },
      new Set(opts.knownTools),
    );
  } catch (err: unknown) {
    throw new AgentDeclError(`agent 声明无效：内联工作流无效：${err instanceof Error ? err.message : String(err)}`);
  }
  if (def.mode !== "fixed") throw new AgentDeclError("agent 声明无效：workflow.inline 只认 fixed 形态");
  return { inline: def };
}

/** 解析声明文本（YAML/JSON，与工作流定义同一套解析器）再校验。 */
export function parseAgentDeclText(text: string, sourceName: string, opts: AgentDeclValidateOpts): AgentDecl {
  let parsed: unknown;
  try {
    parsed = parseWorkflowText(text, sourceName);
  } catch (err: unknown) {
    throw new AgentDeclError(err instanceof Error ? err.message : String(err));
  }
  try {
    return validateAgentDecl(parsed, opts);
  } catch (err: unknown) {
    if (err instanceof AgentDeclError) throw err;
    throw new AgentDeclError(err instanceof Error ? err.message : String(err));
  }
}

/** 从文件加载并校验一个声明（符号链接拒绝读）。 */
export function loadAgentDecl(filePath: string, opts: AgentDeclValidateOpts): AgentDecl {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) {
    throw new AgentDeclError(`加载失败：文件不存在或不安全：${filePath}`);
  }
  const text = readFileSync(filePath, "utf-8");
  return parseAgentDeclText(text, basename(filePath), opts);
}

// ---- 声明仓库：~/.nyra/agents/<名字>.yaml|json（文件本身就是记录）----

export function agentDeclsDir(home: string): string {
  return join(home, ".nyra", AGENT_DECLS_DIR);
}

function storedCandidates(home: string, name: string): string[] {
  const dir = agentDeclsDir(home);
  return [join(dir, `${name}.yaml`), join(dir, `${name}.yml`), join(dir, `${name}.json`)];
}

export function storedAgentDeclPath(home: string, name: string): string | null {
  for (const p of storedCandidates(home, name)) {
    if (existsSync(p) && !lstatSync(p).isSymbolicLink()) return p;
  }
  return null;
}

function writeFileAtomic0600(path: string, text: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new AgentDeclError(`声明文件 ${path} 是符号链接，已拒绝写入`);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.agent-decl-${process.pid}-${Date.now()}`);
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

/**
 * 把一个已校验的声明原文存进仓库（0600 原子写）。同名已存在时须
 * overwrite=true 才覆盖，否则拒绝（防手滑盖掉别人的声明）。
 * 返回存盘路径。
 */
export function saveAgentDecl(
  home: string,
  decl: AgentDecl,
  text: string,
  sourceName: string,
  overwrite: boolean,
): string {
  const ext = /\.json$/i.test(sourceName) ? ".json" : ".yaml";
  const path = join(agentDeclsDir(home), `${decl.name}${ext}`);
  if (!overwrite && storedAgentDeclPath(home, decl.name)) {
    throw new AgentDeclError(`声明 ${decl.name} 已存在（先 nyra agent remove ${decl.name} --yes 删掉，或加载时加 --yes 覆盖）`);
  }
  writeFileAtomic0600(path, text.endsWith("\n") ? text : text + "\n");
  return path;
}

/** 从仓库读一个声明（重新解析 + 重新校验：仓库里的文件也可能被手改坏）。 */
export function loadStoredAgentDecl(home: string, name: string, opts: AgentDeclValidateOpts): AgentDecl {
  if (!PRESET_NAME_RE.test(name)) throw new AgentDeclError(`没有这个声明：${name}`);
  const path = storedAgentDeclPath(home, name);
  if (!path) throw new AgentDeclError(`没有这个声明：${name}（先 nyra agent load <文件.yaml> 导入）`);
  return loadAgentDecl(path, { ...opts, home });
}

/** 列出仓库里的声明（坏文件逐个跳过，错误记进 errors，不破坏整表）。 */
export function listStoredAgentDecls(
  home: string,
  opts: AgentDeclValidateOpts,
): { decls: AgentDecl[]; errors: string[] } {
  const dir = agentDeclsDir(home);
  const decls: AgentDecl[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { decls, errors };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { decls, errors };
  }
  for (const f of names.sort()) {
    if (!/\.(yaml|yml|json)$/i.test(f)) continue;
    const p = join(dir, f);
    if (lstatSync(p).isSymbolicLink()) {
      errors.push(`${f} 是符号链接，已跳过`);
      continue;
    }
    try {
      decls.push(loadAgentDecl(p, { ...opts, home }));
    } catch (err: unknown) {
      errors.push(`${f}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  decls.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { decls, errors };
}

/** 从仓库删一个声明（返回是否删掉了什么）。 */
export function removeStoredAgentDecl(home: string, name: string): boolean {
  if (!PRESET_NAME_RE.test(name)) throw new AgentDeclError(`没有这个声明：${name}`);
  const path = storedAgentDeclPath(home, name);
  if (!path) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * 把声明转成会话层预设定（给 delegateDetailed 的 presetDef 用）：
 * 名字就是声明名，tools/model/max_turns 原样带过去；shell 不额外限制
 *（声明里没有 shellReadOnly 字段；要只读 shell 就用 review 预设交集）。
 */
export function agentDeclToPreset(decl: AgentDecl): SubagentPreset {
  const p: SubagentPreset = { name: decl.name };
  if (decl.description) p.description = decl.description;
  if (decl.tools?.length) p.tools = [...decl.tools];
  if (decl.model) p.model = decl.model;
  if (decl.limits?.max_turns !== undefined) p.maxTurns = decl.limits.max_turns;
  return p;
}
