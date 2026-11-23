// src/templates.ts — 缺口 46：业务流程模板库。
//
// 模板是声明式纯文本文件（YAML/JSON，Git 友好、可 diff、可审），不是黑盒。
// 每个模板含四件套：流程 DSL（缺口 25 的工作流定义）+ 所需连接器（缺口 44
// 的目录声明）+ 验收标准（缺口 29 的 checker 口径）+ 试跑数据与 dry-run。
// 模板里须写明哪些业务动作永远须人批（approve_actions）、哪些永远禁做
// （never_actions），直接引用缺口 51 的红线表，不另起一套。
//
// 两道门（复用缺口 25 的 trial/activate，不另起一套）：
// - 试跑：拿真实数据真执行一遍（写/发动作都会真发生，须 --yes），跑通才记
//   trial_passed；试跑报告进证据链（跑了哪几步、读了什么数据、会写什么、
//   会发什么），验收标准逐项打分，不过不让激活。
// - 激活：人工确认（--yes）后才 active；激活后每次执行仍走审批（起草可自由
//   做，发出须人批——审批节点在流程里，红线表禁做的步骤在导入时就拒绝）。
//
// 审批覆盖是静态可验的：凡是业务动作落在 approve_actions 里的工具步骤，
// 它前面（同一层步骤表里）必须有一个审批节点，否则导入时直接拒绝。
// 模型节点（llm/delegate/skill）的动作 dry-run 无法枚举，审批覆盖只核工具
// 步骤——这是诚实边界，不是漏洞：模型节点的动作在运行中仍走审批链。
//
// 模板包随机器人市场分发：市场 kind 加 "template"，复用市场的验证信封
// （清单校验 → 确定性规则 → 独立审查）与安装策略（见 marketplace.ts 的
// template 分支）。本模块不 import marketplace.ts（市场反过来 import 本
// 模块做校验，单向依赖，不成环）；CLI 的 publish/install 在 handleTemplate
// 里动态 import marketplace.ts（与 workflow.ts 动态 import tools.ts 同款）。
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { EvidenceStore } from "./evidence.ts";
import { atomicWriteJson } from "./bot/dedupAndQuota.ts";
import { nyraHome } from "./tasks.ts";
import { loadConfig, resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { getDeclaration } from "./connectors/registry.ts";
import { isKnownChecker, runChecker } from "./checkers.ts";
import type { CheckerInput, CheckerResult } from "./checkers.ts";
import {
  BUSINESS_ACTION_IDS, businessActionForTool, redlineNeverBlock,
} from "./businessRedlines.ts";
import type { BusinessAction } from "./businessRedlines.ts";
import {
  WORKFLOW_NAME_RE, parseWorkflowText, validateWorkflowDefinition,
  loadWorkflowRegistry, saveWorkflowRegistry, workflowDir,
  trialWorkflow, activateWorkflow, runWorkflowByName, dryRunWorkflowByName,
  removeWorkflow, dryRunPlan, getWorkflowRun,
} from "./workflow.ts";
import type {
  WorkflowDefinition, WorkflowRun, WorkflowRunRequest, WorkflowStep,
} from "./workflow.ts";

export class TemplateError extends Error {
  constructor(message: string) { super(message); this.name = "TemplateError"; }
}

export const TEMPLATES_FILE = "templates.json";
export const TEMPLATES_DIR = "templates";
export const TEMPLATE_MAX_CHARS = 65536;

export type TemplateStatus = "draft" | "trial_passed" | "active";

export interface TemplateDefinition {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license: string;
  connectors: string[];
  acceptance: string[];
  approve_actions: BusinessAction[];
  never_actions: BusinessAction[];
  trial?: { inputs?: Record<string, unknown> };
  trial_files?: { path: string; content: string }[];
  workflow: WorkflowDefinition;
}

export interface TemplateLedgerEntry {
  id: string;
  name: string;
  version: string;
  file: string;
  status: TemplateStatus;
  /** 安装来源：local（本地导入/内置）或市场条目 id。 */
  source: string;
  trialRunId: string | null;
  trialAt: string | null;
  trialAcceptance: { passed: boolean; failed: string[] } | null;
  activatedAt: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface TemplateLedger {
  version: 1;
  templates: TemplateLedgerEntry[];
}

export function templatesDir(home: string): string {
  return join(nyraHome(home), TEMPLATES_DIR);
}

export function templatesLedgerPath(home: string): string {
  return join(nyraHome(home), TEMPLATES_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try {
    copyFileSync(path, `${path}.corrupt-${Date.now()}`);
  } catch { /* 备份失败也不拦后面的抛错 */ }
}

export function loadTemplateLedger(home: string): TemplateLedger {
  const path = templatesLedgerPath(home);
  if (!existsSync(path)) return { version: 1, templates: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new TemplateError("模板账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as TemplateLedger).version !== 1 ||
    !Array.isArray((raw as TemplateLedger).templates)) {
    backupCorrupt(path);
    throw new TemplateError("模板账本格式无效，已备份");
  }
  return raw as TemplateLedger;
}

export function saveTemplateLedger(home: string, ledger: TemplateLedger): void {
  atomicWriteJson(home, TEMPLATES_FILE, ledger);
}

export function templateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "template";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function needStr(v: unknown, where: string, min = 1, max = 500): string {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    throw new TemplateError(`模板无效（${where}）：须是 ${min}–${max} 字的字符串`);
  }
  return v;
}

function needStrArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new TemplateError(`模板无效（${where}）：须是字符串数组`);
  }
  return v as string[];
}

/** 递归收集流程里的工具步骤（并行分支一起走；for_each 不影响步骤归属）。 */
export interface TemplateToolStep {
  id: string;
  tool: string;
  list: string;
}

export function collectWorkflowTools(def: WorkflowDefinition): TemplateToolStep[] {
  const out: TemplateToolStep[] = [];
  const walk = (steps: WorkflowStep[], list: string): void => {
    for (const s of steps) {
      if (s.type === "tool" && s.tool) out.push({ id: s.id, tool: s.tool, list });
      if (s.type === "parallel") {
        (s.branches ?? []).forEach((b, i) => walk(b, `${list}/分支${i + 1}`));
      }
    }
  };
  walk(def.steps, "顶层");
  return out;
}

/**
 * 审批覆盖：业务动作落在 approve_actions 里的工具步骤，前面（同一层步骤表
 * 里）必须有一个审批节点，否则导入时直接拒绝。审批节点一旦通过，后面的
 * 步骤都在同一轮已批复的执行里——与运行器“审批节点暂停整轮、批了才续跑”
 * 的语义一致。
 */
function checkApproveCoverage(steps: WorkflowStep[], approveActions: BusinessAction[], where: string): void {
  let armed = false;
  for (const s of steps) {
    if (s.type === "approve") { armed = true; continue; }
    if (s.type === "tool" && s.tool) {
      const mapped = businessActionForTool(s.tool);
      if (mapped && approveActions.includes(mapped.action) && !armed) {
        throw new TemplateError(
          `模板无效（${where} 步骤 ${s.id}）：工具 ${s.tool} 会做「${mapped.action}」（须人批），但它前面没有审批节点——在它前面放一个审批节点，或把 ${mapped.action} 从 approve_actions 里拿掉`,
        );
      }
    }
    if (s.type === "parallel") {
      for (const b of s.branches ?? []) checkApproveCoverage(b, approveActions, where);
    }
  }
}

/**
 * 禁做检查：流程里任何工具步骤的业务动作落在 never_actions 里，或落在用户
 * 红线表 never 档里，导入时直接拒绝（fail-closed，不等到跑起来才拦）。
 */
function checkNeverActions(def: TemplateDefinition, home: string | null): void {
  for (const t of collectWorkflowTools(def.workflow)) {
    const mapped = businessActionForTool(t.tool);
    if (mapped && def.never_actions.includes(mapped.action)) {
      throw new TemplateError(
        `模板无效（${t.list} 步骤 ${t.id}）：工具 ${t.tool} 会做「${mapped.action}」，但 never_actions 禁了它`,
      );
    }
    if (home) {
      const blocked = redlineNeverBlock(home, t.tool);
      if (blocked) {
        throw new TemplateError(
          `模板无效（${t.list} 步骤 ${t.id}）：工具 ${t.tool} 会做「${blocked.action}」，已被你的红线表列为永远禁做（${blocked.reason}）`,
        );
      }
    }
  }
}

const TEMPLATE_TOP_KEYS = new Set([
  "name", "version", "description", "author", "license", "connectors",
  "acceptance", "approve_actions", "never_actions", "trial", "trial_files", "workflow",
]);

/** 解析模板文本（YAML/JSON，与工作流定义同一套 YAML 子集解析器）。 */
export function parseTemplateText(text: string, sourceName: string): unknown {
  if (text.length > TEMPLATE_MAX_CHARS) {
    throw new TemplateError(`模板过大（超过 ${TEMPLATE_MAX_CHARS} 字）`);
  }
  return parseWorkflowText(text, sourceName);
}

/**
 * 把解析出的值校验成模板定义；knownTools 传了才校验工具名（市场校验传
 * KNOWN_TOOLS，本地导入传 TOOL_SCHEMAS 的名字）；home 传了才核红线表。
 */
export function validateTemplateDefinition(
  value: unknown,
  knownTools?: Set<string> | null,
  home?: string | null,
): TemplateDefinition {
  if (!isObj(value)) throw new TemplateError("模板无效：顶层须是一个映射");
  for (const k of Object.keys(value)) {
    if (!TEMPLATE_TOP_KEYS.has(k)) throw new TemplateError(`模板无效：未知顶层字段 ${k}`);
  }
  const name = needStr(value.name, "name", 1, 100);
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new TemplateError("模板无效（name）：首字须是字母或数字，其余只允许字母、数字、空格、- 和 _");
  }
  const version = needStr(value.version, "version", 1, 32);
  const license = needStr(value.license, "license", 1, 64);
  const description = value.description === undefined ? undefined : needStr(value.description, "description", 1, 500);
  const author = value.author === undefined ? undefined : needStr(value.author, "author", 1, 100);
  const connectors = value.connectors === undefined ? [] : needStrArray(value.connectors, "connectors");
  for (const c of connectors) {
    if (!getDeclaration(c)) {
      throw new TemplateError(`模板无效（connectors）：没有这个连接器 ${c}（先 nyra connector list 看看目录）`);
    }
  }
  const acceptance = value.acceptance === undefined ? [] : needStrArray(value.acceptance, "acceptance");
  for (const a of acceptance) {
    if (!isKnownChecker(a)) throw new TemplateError(`模板无效（acceptance）：未知 checker ${a}（nyra handover checkers 列出能用的）`);
  }
  const approveActions = value.approve_actions === undefined ? [] : needStrArray(value.approve_actions, "approve_actions");
  for (const a of approveActions) {
    if (!(BUSINESS_ACTION_IDS as readonly string[]).includes(a)) {
      throw new TemplateError(`模板无效（approve_actions）：未知业务动作 ${a}`);
    }
  }
  const neverActions = value.never_actions === undefined ? [] : needStrArray(value.never_actions, "never_actions");
  for (const a of neverActions) {
    if (!(BUSINESS_ACTION_IDS as readonly string[]).includes(a)) {
      throw new TemplateError(`模板无效（never_actions）：未知业务动作 ${a}`);
    }
  }
  for (const a of approveActions) {
    if (neverActions.includes(a)) throw new TemplateError(`模板无效：业务动作 ${a} 不能同时在 approve_actions 与 never_actions 里`);
  }
  let trial: { inputs?: Record<string, unknown> } | undefined;
  if (value.trial !== undefined) {
    if (!isObj(value.trial)) throw new TemplateError("模板无效（trial）：须是一个映射");
    if (value.trial.inputs !== undefined && !isObj(value.trial.inputs)) {
      throw new TemplateError("模板无效（trial.inputs）：须是一个映射");
    }
    trial = value.trial as { inputs?: Record<string, unknown> };
  }
  let trialFiles: { path: string; content: string }[] | undefined;
  if (value.trial_files !== undefined) {
    if (!Array.isArray(value.trial_files)) throw new TemplateError("模板无效（trial_files）：须是数组");
    trialFiles = [];
    for (const f of value.trial_files) {
      if (!isObj(f) || typeof f.path !== "string" || typeof f.content !== "string") {
        throw new TemplateError("模板无效（trial_files）：每项须是 {path, content}");
      }
      const p = f.path as string;
      if (!p || p.startsWith("/") || p.includes("..") || p.includes("\\")) {
        throw new TemplateError(`模板无效（trial_files）：路径 ${p} 只允许工作目录下的相对路径`);
      }
      if ((f.content as string).length > 65536) {
        throw new TemplateError(`模板无效（trial_files）：${p} 内容超过 64KB`);
      }
      trialFiles.push({ path: p, content: f.content as string });
    }
  }
  if (!isObj(value.workflow)) throw new TemplateError("模板无效（workflow）：须是一个工作流定义");
  const workflow = validateWorkflowDefinition(value.workflow, knownTools);
  if (workflow.name !== name) {
    throw new TemplateError(`模板无效：workflow.name（${workflow.name}）须与模板名（${name}）一致`);
  }
  if (trial?.inputs) {
    for (const k of Object.keys(trial.inputs)) {
      if (workflow.inputs !== undefined && !(k in workflow.inputs)) {
        throw new TemplateError(`模板无效（trial.inputs）：工作流没有声明 inputs.${k}（已声明：${Object.keys(workflow.inputs).join("、") || "无"}）`);
      }
    }
  }
  const def: TemplateDefinition = {
    name, version, license, connectors, acceptance,
    approve_actions: approveActions as BusinessAction[],
    never_actions: neverActions as BusinessAction[],
    workflow,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(trial !== undefined ? { trial } : {}),
    ...(trialFiles !== undefined ? { trial_files: trialFiles } : {}),
  };
  checkApproveCoverage(workflow.steps, def.approve_actions, "流程");
  checkNeverActions(def, home ?? null);
  return def;
}

/** 模板里流程用的工具名（市场校验与安装计划用）。 */
export function templateWorkflowTools(def: TemplateDefinition): string[] {
  const seen = new Set<string>();
  for (const t of collectWorkflowTools(def.workflow)) seen.add(t.tool);
  return [...seen].sort();
}

/**
 * 生命周期事件没有运行上下文时走证据文件（与审阅队列的 recordReviewEvent
 * 同款口径）：不记目标全文、不记绝对路径、不记客户信息原文，只记模板 id、
 * 名字与状态变化。审计写盘失败不拦操作。
 */
export function recordTemplateEvent(
  home: string | undefined,
  type: string,
  fields: Record<string, unknown>,
): void {
  try {
    const h = nyraHome(home);
    const lines = [`事件：${type}`, `时间：${new Date().toISOString()}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) lines.push(`${k}：${String(v).slice(0, 200)}`);
    }
    new EvidenceStore(join(h, "evidence"), "templates").save(
      "template",
      `template://${String(fields.template_id ?? "unknown")}`,
      lines.join("\n"),
    );
  } catch { /* 审计写盘失败不拦操作，与信任阶梯审计同款口径 */ }
}

export function listTemplates(home: string): TemplateLedgerEntry[] {
  return loadTemplateLedger(home).templates;
}

export function getTemplateEntry(home: string, id: string): TemplateLedgerEntry | null {
  return loadTemplateLedger(home).templates.find((t) => t.id === id || t.name === id) ?? null;
}

export function loadTemplateDefinition(home: string, id: string): { def: TemplateDefinition; text: string; entry: TemplateLedgerEntry } {
  const entry = getTemplateEntry(home, id);
  if (!entry) throw new TemplateError(`没有这个模板：${id}（先 nyra template list 看看）`);
  const path = join(templatesDir(home), entry.file);
  if (!existsSync(path)) throw new TemplateError(`模板定义文件丢了：${entry.file}`);
  const text = readFileSync(path, "utf-8");
  const def = validateTemplateDefinition(parseTemplateText(text, entry.file));
  return { def, text, entry };
}

function writeFile0600(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
}

/** 从已校验的定义文本导入（文件导入与内置模板共用；source 记 local 或市场 id）。 */
export function importTemplateText(home: string, text: string, sourceName: string, source: string, knownTools?: Set<string> | null): TemplateLedgerEntry {
  const def = validateTemplateDefinition(parseTemplateText(text, sourceName), knownTools, home);
  const ledger = loadTemplateLedger(home);
  if (ledger.templates.some((t) => t.name === def.name)) {
    throw new TemplateError(`导入失败：模板 ${def.name} 已存在（先 nyra template remove ${def.name} --yes 再导入）`);
  }
  const ext = /\.json$/i.test(sourceName) ? ".json" : ".yaml";
  const file = `${templateSlug(def.name)}${ext}`;
  const dir = templatesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, file);
  if (existsSync(dest)) {
    throw new TemplateError(`导入失败：定义文件已存在但账本里没有 ${def.name}（先手动清理 ${dest}）`);
  }
  writeFile0600(dest, text);
  const entry: TemplateLedgerEntry = {
    id: def.name, name: def.name, version: def.version, file,
    status: "draft", source, trialRunId: null, trialAt: null,
    trialAcceptance: null, activatedAt: null,
    installedAt: nowIso(), updatedAt: nowIso(),
  };
  ledger.templates.push(entry);
  saveTemplateLedger(home, ledger);
  recordTemplateEvent(home, "template_imported", {
    template_id: entry.id, template_name: entry.name, source,
  });
  return entry;
}

/** 从文件导入模板（拒绝符号链接；工具名按 TOOL_SCHEMAS 校验）。 */
export async function importTemplate(home: string, filePath: string): Promise<TemplateLedgerEntry> {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) {
    throw new TemplateError(`导入失败：文件不存在或不安全：${filePath}`);
  }
  const text = readFileSync(filePath, "utf-8");
  const { TOOL_SCHEMAS } = await import("./tools.ts");
  const knownTools = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));
  return importTemplateText(home, text, basename(filePath), "local", knownTools);
}

/**
 * 把模板内嵌的工作流同步进工作流注册表（流程定义以模板文件为准，JSON 落盘
 * 到工作流目录）。已同步过且内容一致时不动；内容对不上直接拒绝（模板改了
 * 须先 remove 再 import，不静默覆盖已试跑过的流程）。
 */
export function syncTemplateWorkflow(home: string, id: string): string {
  const { def, entry } = loadTemplateDefinition(home, id);
  const file = `${templateSlug(def.name)}.json`;
  const dir = workflowDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, file);
  const text = JSON.stringify(def.workflow, null, 2) + "\n";
  const registry = loadWorkflowRegistry(home);
  const existing = registry.workflows.find((w) => w.name === def.name);
  if (existing) {
    if (existing.file !== file) {
      throw new TemplateError(`模板 ${def.name} 的工作流文件已被改名（${existing.file}），先 nyra template remove ${def.name} --yes 再导入`);
    }
    if (existsSync(dest) && readFileSync(dest, "utf-8") !== text) {
      throw new TemplateError(`模板 ${def.name} 的工作流定义与已同步的不一致，先 nyra template remove ${def.name} --yes 再导入`);
    }
    if (!existsSync(dest)) writeFile0600(dest, text);
    return def.name;
  }
  if (existsSync(dest)) {
    throw new TemplateError(`导入失败：工作流定义文件已存在但注册表里没有 ${def.name}（先手动清理 ${dest}）`);
  }
  writeFile0600(dest, text);
  registry.workflows.push({
    name: def.name, file, status: "draft",
    trialRunId: null, trialAt: null, activatedAt: null, updatedAt: nowIso(),
  });
  saveWorkflowRegistry(home, registry);
  void entry;
  return def.name;
}

/** 试跑数据文件：只写不存在的文件，已有的用户文件绝不覆盖。 */
function materializeTrialFiles(home: string, def: TemplateDefinition, workdir: string): string[] {
  const written: string[] = [];
  for (const f of def.trial_files ?? []) {
    const dest = join(workdir, f.path);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content, { encoding: "utf-8", mode: 0o600 });
    written.push(f.path);
  }
  void home;
  return written;
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | null {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.type === "parallel") {
      for (const b of s.branches ?? []) {
        const found = findStep(b, id);
        if (found) return found;
      }
    }
  }
  return null;
}

/** 从一次运行里拼验收输入：改动文件（写步骤的参数里取相对路径）、轨迹、输出文本。 */
function checkerInputForRun(def: TemplateDefinition, run: WorkflowRun, workdir: string): CheckerInput {
  const changedFiles: string[] = [];
  const trajectory: string[] = [];
  const outputs: string[] = [];
  for (const n of run.nodes) {
    if (n.output) outputs.push(n.output);
    if (n.type !== "tool") continue;
    const step = findStep(run.definition.steps, n.id);
    if (!step || !step.tool) continue;
    trajectory.push(step.tool);
    if (n.status !== "ok" || !n.input) continue;
    // 只有写类工具才算改动文件：读步骤（read_file 等）的 path 只是输入，不算改动。
    if (step.tool !== "write_file" && step.tool !== "edit_file" &&
      step.tool !== "apply_patch" && step.tool !== "export_office") continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(n.input) as Record<string, unknown>;
    } catch {
      continue;
    }
    const p = step.tool === "export_office" ? args.out : args.path;
    if (typeof p === "string" && p && !p.startsWith("/") && !p.includes("..") && !changedFiles.includes(p)) {
      changedFiles.push(p);
    }
  }
  return {
    workdir,
    changedFiles,
    diffStat: null,
    title: `模板 ${def.name} 运行 ${run.id}`,
    summary: `${run.status}，${run.nodes.length} 个节点`,
    outputText: outputs.join("\n").slice(-8000),
    trajectory,
    spentUsd: run.spentUsd,
  };
}

export interface TemplateAcceptance {
  results: CheckerResult[];
  passed: boolean;
  failed: string[];
}

/** 对一次运行逐项跑模板的验收标准（确定性，不调模型）。 */
export function evaluateTemplateAcceptance(def: TemplateDefinition, run: WorkflowRun, workdir: string): TemplateAcceptance {
  const input = checkerInputForRun(def, run, workdir);
  const results: CheckerResult[] = [];
  for (const id of def.acceptance) {
    results.push(runChecker(id, input));
  }
  const failed = results.filter((r) => !r.passed).map((r) => r.id);
  return { results, passed: failed.length === 0, failed };
}

function formatTrialReport(
  def: TemplateDefinition, run: WorkflowRun, acceptance: TemplateAcceptance,
  trialFilesWritten: string[], inputs: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`模板：${def.name} v${def.version}`);
  lines.push(`试跑运行：${run.id}（${run.status}）`);
  lines.push(`输入：${JSON.stringify(inputs)}`);
  lines.push(`试跑数据文件（本次新建）：${trialFilesWritten.join("、") || "无"}`);
  lines.push(`花费：${run.spentUsd === null ? "未计价" : `$${run.spentUsd}`}`);
  lines.push("跑了哪几步：");
  for (const n of run.nodes) {
    lines.push(`- ${n.id}（${n.type}）：${n.status}${n.error ? `——${n.error.slice(0, 200)}` : ""}`);
  }
  const plan = dryRunPlan(def.workflow, inputs);
  lines.push("会写什么 / 会发什么（dry-run 计划）：");
  for (const a of plan.actions) lines.push(`- [${a.kind}] ${a.nodeId}：${a.detail}`);
  if (plan.skippedNodes.length) lines.push(`跳过的节点（if 为假）：${plan.skippedNodes.join("、")}`);
  lines.push("验收标准：");
  for (const r of acceptance.results) {
    lines.push(`- ${r.id}：${r.passed ? "通过" : "未通过"}——${r.detail}`);
  }
  return lines.join("\n");
}

/**
 * 试跑：拿真实数据真执行一遍（写/发动作都会真发生，须 --yes）。上一次试跑
 * 已跑完时，直接认那次运行，不重新跑一遍（缺口 25 的一轮试跑语义）；失败
 * 或取消的试跑先清掉工作流登记再重跑（改好模板或数据后能再试）；等审批的
 * 试跑须先在工作流里批了再续跑。
 */
export async function trialTemplate(
  home: string, id: string, inputOverrides: Record<string, unknown>,
  req: WorkflowRunRequest, confirm: boolean,
): Promise<{ run: WorkflowRun; acceptance: TemplateAcceptance; reportPath: string; reused: boolean }> {
  const { def, entry } = loadTemplateDefinition(home, id);
  const workflowName = syncTemplateWorkflow(home, id);
  const inputs: Record<string, unknown> = { ...(def.trial?.inputs ?? {}), ...inputOverrides };
  // 试跑数据文件先落盘（流程第一步可能就要读它），已有的用户文件绝不覆盖。
  const trialFilesWritten = materializeTrialFiles(home, def, req.workdir);
  let run: WorkflowRun;
  let reused = false;
  if (entry.trialRunId) {
    const prev = getWorkflowRun(home, entry.trialRunId);
    if (prev && prev.status === "completed") {
      run = prev;
      reused = true;
    } else if (prev && prev.status === "failed") {
      removeWorkflow(home, workflowName, true);
      syncTemplateWorkflow(home, id);
      if (!confirm) throw new TemplateError("试跑会真实执行（写/发动作都会真发生），须加 --yes 确认");
      run = await trialWorkflow(home, workflowName, inputs, req, true);
    } else if (prev && prev.status === "awaiting_approval") {
      throw new TemplateError(
        `上一次试跑还在等审批（${entry.trialRunId}），先 nyra workflow approve ${entry.trialRunId} --yes 批了，等它跑完再试`,
      );
    } else if (prev && prev.status === "running") {
      throw new TemplateError(`上一次试跑还在跑（${entry.trialRunId}），等它结束再试`);
    } else {
      if (!confirm) throw new TemplateError("试跑会真实执行（写/发动作都会真发生），须加 --yes 确认");
      run = await trialWorkflow(home, workflowName, inputs, req, true);
    }
  } else {
    if (!confirm) throw new TemplateError("试跑会真实执行（写/发动作都会真发生），须加 --yes 确认");
    run = await trialWorkflow(home, workflowName, inputs, req, true);
  }
  const acceptance = evaluateTemplateAcceptance(def, run, req.workdir);
  const report = formatTrialReport(def, run, acceptance, trialFilesWritten, inputs);
  const reportPath = new EvidenceStore(join(nyraHome(home), "evidence"), "templates").save(
    "template_trial", `template://${def.name}/trial/${run.id}`, report,
  );
  // 试跑 id 先记账本（哪怕这次停在审批节点或失败了），下次 trial 才知道
  // 该续跑、该重跑还是该等审批；只有跑完了才记 trial_passed 与验收分。
  if (run.status === "completed") {
    const ledger = loadTemplateLedger(home);
    const e = ledger.templates.find((t) => t.name === def.name);
    if (e) {
      e.status = "trial_passed";
      e.trialRunId = run.id;
      e.trialAt = run.endedAt ?? nowIso();
      e.trialAcceptance = { passed: acceptance.passed, failed: acceptance.failed };
      e.updatedAt = nowIso();
      saveTemplateLedger(home, ledger);
    }
  } else {
    const ledger = loadTemplateLedger(home);
    const e = ledger.templates.find((t) => t.name === def.name);
    if (e) {
      e.trialRunId = run.id;
      e.updatedAt = nowIso();
      saveTemplateLedger(home, ledger);
    }
  }
  recordTemplateEvent(home, "template_trial", {
    template_id: def.name, run_id: run.id, status: run.status,
    acceptance: acceptance.passed ? "pass" : `fail:${acceptance.failed.join(",")}`,
  });
  return { run, acceptance, reportPath, reused };
}

/** 激活：须试跑通过且验收全过，再人工确认（--yes）。 */
export function activateTemplate(home: string, id: string, confirm: boolean, workdir?: string): TemplateLedgerEntry {
  if (!confirm) throw new TemplateError("激活须加 --yes 确认（激活前必须先试跑通过）");
  const { def, entry } = loadTemplateDefinition(home, id);
  if (entry.status !== "trial_passed") {
    throw new TemplateError(`模板 ${def.name} 还没试跑通过（当前 ${entry.status}），先 nyra template trial ${def.name} --yes`);
  }
  if (!entry.trialAcceptance?.passed) {
    const failed = entry.trialAcceptance?.failed ?? [];
    throw new TemplateError(
      `模板 ${def.name} 的试跑验收没全过（未通过：${failed.join("、") || "未知"}），修好模板或数据后再试跑，验收全过才能激活`,
    );
  }
  activateWorkflow(home, def.name, true, workdir);
  const ledger = loadTemplateLedger(home);
  const e = ledger.templates.find((t) => t.name === def.name);
  if (!e) throw new TemplateError(`模板账本里没有 ${def.name}`);
  e.status = "active";
  e.activatedAt = nowIso();
  e.updatedAt = nowIso();
  saveTemplateLedger(home, ledger);
  recordTemplateEvent(home, "template_activated", { template_id: def.name });
  return e;
}

/** 执行已激活的模板：跑前重核红线（用户收紧红线后，已激活的模板也不许绕过）。 */
export async function runTemplate(
  home: string, id: string, inputOverrides: Record<string, unknown>, req: WorkflowRunRequest,
): Promise<{ run: WorkflowRun; acceptance: TemplateAcceptance }> {
  const { def, entry } = loadTemplateDefinition(home, id);
  if (entry.status !== "active") {
    throw new TemplateError(`模板 ${def.name} 还没激活（当前 ${entry.status}），先试跑再激活`);
  }
  checkNeverActions(def, home);
  const run = await runWorkflowByName(home, def.name, inputOverrides, req);
  const acceptance = evaluateTemplateAcceptance(def, run, req.workdir);
  recordTemplateEvent(home, "template_run", {
    template_id: def.name, run_id: run.id, status: run.status,
    acceptance: acceptance.passed ? "pass" : `fail:${acceptance.failed.join(",")}`,
  });
  return { run, acceptance };
}

/** dry-run：只列出会写/会发什么，不执行。 */
export function dryRunTemplate(home: string, id: string, inputOverrides: Record<string, unknown>): { run: WorkflowRun; plan: ReturnType<typeof dryRunPlan> } {
  const { def } = loadTemplateDefinition(home, id);
  syncTemplateWorkflow(home, id);
  const inputs: Record<string, unknown> = { ...(def.trial?.inputs ?? {}), ...inputOverrides };
  const { run, plan } = dryRunWorkflowByName(home, def.name, inputs);
  return { run, plan };
}

export function removeTemplate(home: string, id: string, confirm: boolean): void {
  if (!confirm) throw new TemplateError("删除模板须加 --yes 确认");
  const { def, entry } = loadTemplateDefinition(home, id);
  try {
    removeWorkflow(home, def.name, true);
  } catch (err: unknown) {
    if (!(err instanceof Error) || !/没有这个工作流/.test(err.message)) throw err;
  }
  const path = join(templatesDir(home), entry.file);
  try { rmSync(path, { force: true }); } catch { /* 文件已不在不拦删除 */ }
  const ledger = loadTemplateLedger(home);
  const idx = ledger.templates.findIndex((t) => t.name === def.name);
  if (idx >= 0) ledger.templates.splice(idx, 1);
  saveTemplateLedger(home, ledger);
  recordTemplateEvent(home, "template_removed", { template_id: def.name });
}

/** 市场安装时用：把市场下发的模板文件登记进账本（状态 draft，须试跑后才能激活）。 */
export function registerInstalledTemplate(home: string, text: string, sourceName: string, source: string): TemplateLedgerEntry {
  return importTemplateText(home, text, sourceName, source);
}

/** 市场卸载时用：删模板文件与账本条目（已激活的工作流一并移除）。 */
export function removeTemplateEntry(home: string, name: string): void {
  removeTemplate(home, name, true);
}

/** 内置模板（声明式纯文本；随源码分发，nyra template import --builtin <id> 装入）。 */
export const BUILTIN_TEMPLATE_SHOP_ORDER = `name: shop_order_followup
version: 1.0.0
license: MIT
description: "店铺订单异常跟进（Hollow & Scale）：订单号直查 Shopify 订单（shopify_orders 工具），核对物流、起草客户回复、等批发出。"
connectors:
  - "shopify"
  - "gmail"
acceptance:
  - "has-changes"
  - "file-exists:draft.txt"
approve_actions:
  - "send_message"
never_actions:
  - "pay"
  - "delete"
trial:
  inputs:
    order_id: "ORD-TEST-001"
    customer_email: "test@example.com"
    draft_path: "draft.txt"
workflow:
  name: shop_order_followup
  version: 1
  mode: fixed
  inputs:
    order_id: "ORD-TEST-001"
    customer_email: "test@example.com"
    draft_path: "draft.txt"
  steps:
    - id: fetch_order
      type: tool
      tool: shopify_orders
      args:
        order_id: "{{inputs.order_id}}"
    - id: check_logistics
      type: llm
      prompt: "根据以下 Shopify 订单直查结果核对物流状态，写出三行结论：订单号、当前物流状态、下一步该做什么。订单结果：{{steps.fetch_order.output}}"
    - id: draft_reply
      type: llm
      prompt: "按物流核对结论起草一封给客户的回复邮件，语气平实，说清当前状态与下一步，不承诺做不到的时间。核对结论：{{steps.check_logistics.output}}"
    - id: save_draft
      type: tool
      tool: write_file
      args:
        path: "{{inputs.draft_path}}"
        content: "{{steps.draft_reply.output}}"
    - id: approve_send
      type: approve
      title: "确认发出这封客户回复？"
    - id: send_reply
      type: tool
      tool: gmail_send
      args:
        to:
          - "{{inputs.customer_email}}"
        subject: "订单异常跟进：{{inputs.order_id}}"
        body: "{{steps.draft_reply.output}}"
`;

export const BUILTIN_TEMPLATE_OVERDUE_INVOICE = `name: overdue_invoice
version: 1.0.0
license: MIT
description: "逾期发票催款：读逾期发票表、起草催款邮件、等批发出。只催款，不改账、不退款。"
connectors:
  - "gmail"
acceptance:
  - "has-changes"
  - "file-exists:draft.txt"
approve_actions:
  - "send_message"
never_actions:
  - "pay"
  - "delete"
trial:
  inputs:
    invoice_path: "invoices.csv"
    customer_email: "test@example.com"
    draft_path: "draft.txt"
trial_files:
  - path: "invoices.csv"
    content: "样例逾期发票：发票号 INV-TEST-001，客户 test@example.com，金额 1200 元，逾期 15 天。"
workflow:
  name: overdue_invoice
  version: 1
  mode: fixed
  inputs:
    invoice_path: "invoices.csv"
    customer_email: "test@example.com"
    draft_path: "draft.txt"
  steps:
    - id: find_invoice
      type: tool
      tool: read_file
      args:
        path: "{{inputs.invoice_path}}"
    - id: draft_reminder
      type: llm
      prompt: "根据以下逾期发票信息起草一封催款邮件，语气平实，写清发票号、金额、逾期天数与付款方式，不威胁、不加罚息。发票信息：{{steps.find_invoice.output}}"
    - id: save_draft
      type: tool
      tool: write_file
      args:
        path: "{{inputs.draft_path}}"
        content: "{{steps.draft_reminder.output}}"
    - id: approve_send
      type: approve
      title: "确认发出这封催款邮件？"
    - id: send_reminder
      type: tool
      tool: gmail_send
      args:
        to:
          - "{{inputs.customer_email}}"
        subject: "逾期发票提醒"
        body: "{{steps.draft_reminder.output}}"
`;

export const BUILTIN_TEMPLATE_EXPENSE_REVIEW = `name: expense_review
version: 1.0.0
license: MIT
description: "费用报销审核：按政策读报销单、汇总核对结果，等批。只审核、不打款，打款永远禁做。"
acceptance:
  - "has-changes"
  - "file-exists:summary.txt"
never_actions:
  - "pay"
  - "delete"
trial:
  inputs:
    expense_path: "expense.csv"
    summary_path: "summary.txt"
trial_files:
  - path: "expense.csv"
    content: "样例报销单：申请人张三，交通费 320 元，餐费 180 元，合计 500 元，附票据 2 张。"
workflow:
  name: expense_review
  version: 1
  mode: fixed
  inputs:
    expense_path: "expense.csv"
    summary_path: "summary.txt"
  steps:
    - id: read_expense
      type: tool
      tool: read_file
      args:
        path: "{{inputs.expense_path}}"
    - id: review_summary
      type: llm
      prompt: "按常规报销政策核对以下报销单，逐项写通过或存疑及原因，最后给合计与结论，不编造政策条文，拿不准的写存疑。报销单：{{steps.read_expense.output}}"
    - id: save_summary
      type: tool
      tool: write_file
      args:
        path: "{{inputs.summary_path}}"
        content: "{{steps.review_summary.output}}"
`;

export const BUILTIN_TEMPLATE_ONBOARDING = `name: onboarding
version: 1.0.0
license: MIT
description: "新员工入职：读手册答疑、写账号开通清单与跟进事项。只出清单，不建账号、不删数据；建账号须人手工做，不在模板流程里。"
acceptance:
  - "has-changes"
  - "file-exists:checklist.txt"
never_actions:
  - "delete"
trial:
  inputs:
    handbook_path: "handbook.txt"
    checklist_path: "checklist.txt"
trial_files:
  - path: "handbook.txt"
    content: "样例员工手册：入职第一天找行政领工牌与门禁，第二天参加安全培训，邮箱与系统账号由 IT 在入职单批后开通，试用期三个月。"
workflow:
  name: onboarding
  version: 1
  mode: fixed
  inputs:
    handbook_path: "handbook.txt"
    checklist_path: "checklist.txt"
  steps:
    - id: read_handbook
      type: tool
      tool: read_file
      args:
        path: "{{inputs.handbook_path}}"
    - id: answer_questions
      type: llm
      prompt: "读以下员工手册，回答新员工最常问的三个问题（第一天找谁、账号怎么开通、试用期多久），并列一份入职跟进清单（待办、负责人、截止时间），手册里没有的写不知道，不编。手册：{{steps.read_handbook.output}}"
    - id: write_checklist
      type: tool
      tool: write_file
      args:
        path: "{{inputs.checklist_path}}"
        content: "{{steps.answer_questions.output}}"
`;

export const BUILTIN_TEMPLATE_MEETING_FOLLOWUP = `name: meeting_followup
version: 1.0.0
license: MIT
description: "会议纪要转跟进：读会议纪要、提取跟进事项与负责人、写成跟进清单。只出清单，不对外发。"
acceptance:
  - "has-changes"
  - "file-exists:followup.txt"
approve_actions:
  - "send_message"
never_actions:
  - "delete"
trial:
  inputs:
    notes_path: "notes.txt"
    followup_path: "followup.txt"
trial_files:
  - path: "notes.txt"
    content: "样例会议纪要：周会决定下周三前上线新品页面（负责人李四），客服回复时效从 24 小时提到 12 小时（负责人王五），下周复盘。"
workflow:
  name: meeting_followup
  version: 1
  mode: fixed
  inputs:
    notes_path: "notes.txt"
    followup_path: "followup.txt"
  steps:
    - id: read_notes
      type: tool
      tool: read_file
      args:
        path: "{{inputs.notes_path}}"
    - id: extract_actions
      type: llm
      prompt: "从以下会议纪要里提取跟进事项，每项写事项、负责人、截止时间，纪要里没写负责人的标待定，不编造。纪要：{{steps.read_notes.output}}"
    - id: save_followup
      type: tool
      tool: write_file
      args:
        path: "{{inputs.followup_path}}"
        content: "{{steps.extract_actions.output}}"
`;

export const BUILTIN_TEMPLATES: { id: string; text: string }[] = [
  { id: "shop_order_followup", text: BUILTIN_TEMPLATE_SHOP_ORDER },
  { id: "overdue_invoice", text: BUILTIN_TEMPLATE_OVERDUE_INVOICE },
  { id: "expense_review", text: BUILTIN_TEMPLATE_EXPENSE_REVIEW },
  { id: "onboarding", text: BUILTIN_TEMPLATE_ONBOARDING },
  { id: "meeting_followup", text: BUILTIN_TEMPLATE_MEETING_FOLLOWUP },
];

export function getBuiltinTemplate(id: string): string | null {
  return BUILTIN_TEMPLATES.find((t) => t.id === id)?.text ?? null;
}

/** 内置模板全量校验（市场校验与测试共用：须全过，否则是模板本身写错了）。 */
export function validateBuiltinTemplates(knownTools?: Set<string> | null): { id: string; def: TemplateDefinition }[] {
  return BUILTIN_TEMPLATES.map(({ id, text }) => ({
    id,
    def: validateTemplateDefinition(parseTemplateText(text, `${id}.yaml`), knownTools, null),
  }));
}

/** 内置模板装入账本（已装过直接返回现有条目，不重复装）。 */
export function importBuiltinTemplate(home: string, id: string, knownTools?: Set<string> | null): TemplateLedgerEntry {
  const text = getBuiltinTemplate(id);
  if (!text) throw new TemplateError(`没有这个内置模板：${id}（nyra template list --builtin 看看）`);
  const existing = getTemplateEntry(home, id);
  if (existing) return existing;
  return importTemplateText(home, text, `${id}.yaml`, "builtin", knownTools);
}

/** --input k=v 解析（与 workflow.ts 的 parseInputFlag 同口径：键须小写字母开头，值按 true/false/数字/字符串转）。 */
function parseTemplateInputFlag(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--input") continue;
    const kv = argv[i + 1];
    if (!kv || !kv.includes("=")) throw new TemplateError("--input 后面须跟 k=v");
    const eq = kv.indexOf("=");
    const k = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) throw new TemplateError(`输入无效：${k} 须是小写字母开头的变量名`);
    if (raw === "true") out[k] = true;
    else if (raw === "false") out[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[k] = Number(raw);
    else out[k] = raw;
  }
  if (Object.keys(out).length > 32) throw new TemplateError("输入无效：最多 32 个");
  return out;
}

function templateFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const TEMPLATE_USAGE = `用法：
  nyra template list [--builtin]        列出已装模板（--builtin 列内置模板）
  nyra template show <名字>             看一个模板的流程、连接器与红线
  nyra template builtin <名字>          打印一个内置模板的全文
  nyra template import <文件>           从文件导入模板（只装草稿）
  nyra template import --builtin <名字> 装入一个内置模板（只装草稿）
  nyra template trial <名字> [--input k=v ...] [--max-cost 2] --yes
                                        试跑：拿真实数据真执行一遍，报告进证据链
  nyra template activate <名字> --yes   激活（须先试跑通过且验收全过）
  nyra template run <名字> [--input k=v ...] [--max-cost 2]
                                        执行已激活的模板（发出仍须人批）
  nyra template dry-run <名字> [--input k=v ...]
                                        只列会写/会发什么，不执行
  nyra template remove <名字> --yes     删除模板（含它同步的工作流）
  nyra template publish <模板名|文件> [--license <许可证>] [--dry-run] [--out <目录>]
                                        打包成市场条目（走市场三道门）
  nyra template install <市场条目 id> [--force]
                                        从市场装模板（只装草稿，激活前须试跑）
Usage:
  nyra template list [--builtin]        List installed templates (--builtin lists built-ins)
  nyra template trial <name> --yes      Trial run with real data; report goes to the evidence chain
  nyra template activate <name> --yes   Activate (trial must pass first)
  nyra template run <name>              Run an activated template (sending still needs approval)`;

export async function handleTemplate(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write(`${TEMPLATE_USAGE}\n`);
    return 2;
  }
  try {
    const config = loadConfig(home);
    const askConfirm = async (prompt: string): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    };
    const newRun = (task: string): { store: RunStore; runId: string } => {
      const store = new RunStore(join(home, "runs"));
      const run = store.create(task, "cli", home, "readonly", 1);
      return { store, runId: run.run_id };
    };
    const maxCostRaw = templateFlagValue(argv, "--max-cost");
    const maxCostUsd = maxCostRaw === undefined ? 2 : Number(maxCostRaw);
    if (Number.isNaN(maxCostUsd) || maxCostUsd <= 0) {
      process.stderr.write("错误：--max-cost 须是大于 0 的数字\n");
      return 2;
    }
    const req: WorkflowRunRequest = {
      workdir: process.cwd(),
      mode: "normal",
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      maxCostUsd,
    };
    if (action === "list") {
      if (argv.includes("--builtin")) {
        for (const t of BUILTIN_TEMPLATES) {
          const def = validateTemplateDefinition(parseTemplateText(t.text, `${t.id}.yaml`), null, null);
          process.stdout.write(`- ${t.id} v${def.version}：${def.description ?? ""}\n`);
        }
        return 0;
      }
      const entries = listTemplates(home);
      if (!entries.length) {
        process.stdout.write("还没有模板。内置模板：nyra template list --builtin；装入：nyra template import --builtin shop_order_followup\n");
        return 0;
      }
      for (const e of entries) {
        process.stdout.write(`- ${e.name} v${e.version}（${e.status}，来源 ${e.source}${e.trialAt ? `，试跑 ${e.trialAt.slice(0, 10)}` : ""}）\n`);
      }
      return 0;
    }
    if (action === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template show <名字>\n"); return 2; }
      const { def, entry } = loadTemplateDefinition(home, id);
      process.stdout.write(`${def.name} v${def.version}（${entry.status}，来源 ${entry.source}）\n`);
      if (def.description) process.stdout.write(`说明：${def.description}\n`);
      process.stdout.write(`许可证：${def.license}\n`);
      process.stdout.write(`连接器：${def.connectors.join("、") || "无"}\n`);
      process.stdout.write(`验收标准：${def.acceptance.join("、") || "无"}\n`);
      process.stdout.write(`永远须人批：${def.approve_actions.join("、") || "无"}\n`);
      process.stdout.write(`永远禁做：${def.never_actions.join("、") || "无"}\n`);
      process.stdout.write(`流程（${def.workflow.mode}）：\n`);
      const printSteps = (steps: WorkflowStep[], indent: string): void => {
        for (const s of steps) {
          if (s.type === "tool") process.stdout.write(`${indent}- ${s.id}：工具 ${s.tool}\n`);
          else if (s.type === "llm") process.stdout.write(`${indent}- ${s.id}：模型\n`);
          else if (s.type === "approve") process.stdout.write(`${indent}- ${s.id}：审批节点\n`);
          else if (s.type === "knowledge") process.stdout.write(`${indent}- ${s.id}：查知识库\n`);
          else if (s.type === "skill") process.stdout.write(`${indent}- ${s.id}：技能 ${s.skill ?? ""}\n`);
          else if (s.type === "delegate") process.stdout.write(`${indent}- ${s.id}：派子 agent\n`);
          else if (s.type === "parallel") {
            process.stdout.write(`${indent}- ${s.id}：并行\n`);
            (s.branches ?? []).forEach((b, i) => printSteps(b, `${indent}  分支${i + 1} `));
          }
        }
      };
      printSteps(def.workflow.steps, "  ");
      process.stdout.write(`工具：${templateWorkflowTools(def).join("、") || "无"}\n`);
      return 0;
    }
    if (action === "builtin") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template builtin <名字>\n"); return 2; }
      const text = getBuiltinTemplate(id);
      if (!text) { process.stderr.write(`错误：没有这个内置模板：${id}\n`); return 1; }
      process.stdout.write(text);
      return 0;
    }
    if (action === "import") {
      const builtinIdx = argv.indexOf("--builtin");
      if (builtinIdx !== -1) {
        const id = argv[builtinIdx + 1];
        if (!id) { process.stderr.write("错误：用法：nyra template import --builtin <名字>\n"); return 2; }
        const { TOOL_SCHEMAS } = await import("./tools.ts");
        const knownTools = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));
        const entry = importBuiltinTemplate(home, id, knownTools);
        process.stdout.write(`已装入内置模板 ${entry.name} v${entry.version}（草稿，未激活）\n`);
        process.stdout.write(`下一步：nyra template trial ${entry.name} --yes（试跑通过且验收全过才能激活）\n`);
        return 0;
      }
      const file = argv[1];
      if (!file) { process.stderr.write("错误：用法：nyra template import <文件> 或 nyra template import --builtin <名字>\n"); return 2; }
      const entry = await importTemplate(home, resolveHome(file));
      process.stdout.write(`已导入模板 ${entry.name} v${entry.version}（草稿，未激活）\n`);
      process.stdout.write(`下一步：nyra template trial ${entry.name} --yes（试跑通过且验收全过才能激活）\n`);
      return 0;
    }
    if (action === "trial") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template trial <名字> [--input k=v ...] --yes\n"); return 2; }
      const inputs = parseTemplateInputFlag(argv);
      const { run, acceptance, reportPath, reused } = await trialTemplate(home, id, inputs, req, argv.includes("--yes"));
      if (reused) process.stdout.write(`已试跑过，直接认上一次的运行 ${run.id}（改输入须先 remove 再导入）\n`);
      process.stdout.write(`试跑 ${run.id}：${run.status}\n`);
      process.stdout.write(`验收：${acceptance.passed ? "全过" : `未通过：${acceptance.failed.join("、")}`}（${acceptance.results.map((r) => `${r.id}:${r.passed ? "过" : "不过"}`).join("、") || "无验收标准"}）\n`);
      process.stdout.write(`试跑报告已进证据链：${reportPath}\n`);
      if (run.status !== "completed") {
        process.stdout.write("试跑没跑完：修好模板或数据后再试（失败的试跑可直接重跑，等审批的先在工作流里批了再续跑）\n");
        return 1;
      }
      if (!acceptance.passed) {
        process.stdout.write("验收没全过：修好模板或数据后再试跑，验收全过才能激活。\n");
        return 1;
      }
      process.stdout.write(`试跑通过，下一步：nyra template activate ${id} --yes\n`);
      return 0;
    }
    if (action === "activate") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template activate <名字> --yes\n"); return 2; }
      const entry = activateTemplate(home, id, argv.includes("--yes"));
      process.stdout.write(`已激活模板 ${entry.name} v${entry.version}\n`);
      process.stdout.write("激活后每次执行仍走审批：起草可自由做，发出须人批。\n");
      return 0;
    }
    if (action === "run") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template run <名字> [--input k=v ...]\n"); return 2; }
      const inputs = parseTemplateInputFlag(argv);
      const { run, acceptance } = await runTemplate(home, id, inputs, req);
      process.stdout.write(`运行 ${run.id}：${run.status}（${run.nodes.length} 个节点）\n`);
      process.stdout.write(`验收：${acceptance.passed ? "全过" : `未通过：${acceptance.failed.join("、")}`}\n`);
      return run.status === "completed" && acceptance.passed ? 0 : 1;
    }
    if (action === "dry-run") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template dry-run <名字> [--input k=v ...]\n"); return 2; }
      const inputs = parseTemplateInputFlag(argv);
      const { run, plan } = dryRunTemplate(home, id, inputs);
      process.stdout.write(`dry-run ${run.id}（只列计划，不执行）\n`);
      for (const a of plan.actions) process.stdout.write(`- [${a.kind}] ${a.nodeId}：${a.detail}\n`);
      if (plan.skippedNodes.length) process.stdout.write(`跳过的节点（if 为假）：${plan.skippedNodes.join("、")}\n`);
      return 0;
    }
    if (action === "remove") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template remove <名字> --yes\n"); return 2; }
      removeTemplate(home, id, argv.includes("--yes"));
      process.stdout.write(`已删除模板 ${id}\n`);
      return 0;
    }
    if (action === "publish") {
      const target = argv[1];
      if (!target) { process.stderr.write("错误：用法：nyra template publish <模板名|文件> [--license <许可证>] [--dry-run] [--out <目录>]\n"); return 2; }
      const licenseIdx = argv.indexOf("--license");
      const license = licenseIdx !== -1 ? argv[licenseIdx + 1] : undefined;
      const outIdx = argv.indexOf("--out");
      const outDir = outIdx !== -1 ? argv[outIdx + 1] : undefined;
      const dryRun = argv.includes("--dry-run");
      const mod = await import("./marketplace.ts");
      const { store, runId } = newRun(`marketplace publish template ${target}`);
      const result = await mod.publishMarketplaceEntry(home, { template: target }, { config, dryRun, outDir, license, store, runId });
      process.stdout.write(`${dryRun ? "试运行（未写出任何文件，未记账本）" : "已打包"}：${result.itemName} v${result.version}（业务流程模板）\n`);
      process.stdout.write(`输出目录：${result.outDir}\n`);
      process.stdout.write(`文件：${result.files.join("、")}\n`);
      process.stdout.write(`Bot Ready 自评：${result.botReady.score}/100${result.botReady.missing.length ? `（缺：${result.botReady.missing.join("、")}）` : "（满分）"}\n`);
      process.stdout.write(`审查：${result.review.source === "skipped" ? "已跳过（审查层未开启；只走了两道确定性门）" : `${result.review.decision === "ALLOW" ? "通过" : "拦截"}（${result.review.reviewerModel ?? ""}，${result.review.reason}）`}\n`);
      for (const w of result.warnings) process.stdout.write(`提醒：${w}\n`);
      if (!dryRun) {
        process.stdout.write("下一步：把输出目录里的文件提交到策展仓库 nyra-community（提 PR），market-entry.json 是给维护者的索引片段。\n");
      }
      return 0;
    }
    if (action === "install") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra template install <市场条目 id> [--force]\n"); return 2; }
      const force = argv.includes("--force");
      const mod = await import("./marketplace.ts");
      const prepared = await mod.prepareMarketplaceInstall(home, id, { config });
      if (prepared.entry.kind !== "template") {
        process.stderr.write(`错误：市场条目 ${id} 不是模板（kind 是 ${prepared.entry.kind}，用 nyra market install 装它）\n`);
        return 2;
      }
      process.stdout.write(`${prepared.plannedChanges.join("\n")}\n`);
      if (!await askConfirm("确认安装？(y/N) ")) {
        process.stdout.write("已取消，未安装任何文件。\n");
        return 0;
      }
      const { store, runId } = newRun(`marketplace install template ${id}`);
      const result = mod.executeMarketplaceInstall(home, prepared, { force, store, runId });
      process.stdout.write(`已安装模板 ${result.installed.item_name} v${result.installed.version}（草稿，未激活）\n`);
      if (result.overwritten) process.stdout.write("（覆盖了旧版）\n");
      process.stdout.write(`下一步：nyra template trial ${result.installed.item_name} --yes（试跑通过且验收全过才能激活）\n`);
      process.stdout.write(`卸载：nyra market uninstall ${result.installed.item_name}\n`);
      return 0;
    }
    process.stdout.write(`${TEMPLATE_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
