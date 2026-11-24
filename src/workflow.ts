// src/workflow.ts — 缺口 25：声明式可复用工作流（DSL + 三种执行形态 + 审批节点 + dry-run）。
//
// 做法借的是 Dify 的声明式 Workflow DSL（YAML/JSON 文本、节点编排、Human Input
// 审批节点）与 Proto 的三级复用阶梯（工作流激活前先拿真实数据试跑、通过才激活；
// 非活跃测试只预览写/发动作而不真执行），不抄 Dify 的节点 API 形状与画布交互，
// 也不拿 Proto 的演示数字当事实。G-5 的三种执行形态（固定图 / 协调者 / 动态）：
// 第一批做了固定图，第二批加了协调者与动态（见下文「协调者循环」一节）。
//
// 节点就是 Nyra 已有的东西——工具调用、技能、delegate 子 agent、知识检索、
// LLM 判断；分支/循环/并行是 DSL 里的控制结构，不是新概念。简单决策用 if/else，
// 不调模型（G-5 的 ADK 硬规矩）；递归（循环嵌套）设硬深度上限。
//
// 每节点继承 Nyra 现有三件套：审批（approve 节点直接复用审阅队列 review queue，
// 批复后 `nyra workflow resume` 续跑）、成本硬顶（每节点记 token/费用，超
// --max-cost 即停；月度硬顶在模型节点前重判）、证据链（每节点输入/输出/耗时
// 落盘，`nyra evidence verify` 可验；运行事件进 runs，时间线可看）。
//
// 两道门（Proto 的做法，Nyra 做得更硬）：工作流激活前强制“真实数据试跑 +
// 人工确认”——`nyra workflow trial` 跑通才记 trial_passed，`nyra workflow
// activate --yes` 才标 active；只有 active 的工作流才能挂定时/事件触发
// （触发执行本身是下一批，本批 DSL 里只声明 + 校验触发器入口）。
// dry-run 只列出会写/会发什么，不执行；dry-run 报告带 SHA-256，`nyra workflow
// verify <运行 id>` 用存下来的定义快照重算计划、比哈希——结果本身可验证。
//
// 诚实边界（写进文档，不粉饰）：
//   - dry-run 只能枚举确定性节点（tool 节点）的写/发动作；llm / delegate /
//     skill 节点的动作由模型临场决定，dry-run 只能写“可能产生写/发动作，
//     无法枚举”，不能假装列全了。协调者/动态形态的 dry-run 再加两句实话：
//     计划步骤只是“候选”（协调者运行中决定跑不跑），协调者还能再生成新步骤，
//     那些动作同样无法枚举。
//   - 成本只对“报了 usage 的调用”计价；没报 usage 的调用金额记 null（未知），
//     不编数字；月度硬顶与 --max-cost 只对已知部分生效，未知部分不假装封顶。
//     协调者每轮的决策调用也按实报 usage 计价进月度账本，同样算进 --max-cost。
//   - 技能节点是“按技能正文带路的 delegate 子 agent 单次任务”，不是完整
//     agent 会话；知识节点是 BM25 检索（缺口 1 的同一套），不是向量检索。
//   - 审批节点（approve）只认顶层步骤：不许放并行分支里（续跑要回到确定的
//     顶层步号，分支里的挂起续跑会重跑整个并行节点），也不许放循环里；
//     违反的在 import/validate 时直接拒绝，不等跑到一半才炸。动态生成的步骤
//     不能是审批节点（审批须写进计划，或让协调者用 ask 停下来问人）。
//   - 触发器本批只声明 + 校验，不触发执行；挂定时/事件触发是下一批的事。
//   - 协调者是“每轮一次模型调用做决定”，不是 agent 自由发挥：简单判断仍走
//     确定性 if（不调模型），下一步只从当前可执行的步骤里选；图本身不会自己
//     长出来——新步骤一次一个、要过同一套 DSL 校验，且有硬上限（轮数 / 新步骤
//     数 / 每步骤执行次数 / 连续坏决定数），超了即停，不循环烧钱。
//   - 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
//
// 账本：定义文件 ~/.nyra/workflows/<名字>.yaml|json（DSL 文本本身，Git 友好）；
// 注册表 ~/.nyra/workflows.json（名字 → 状态 trial/draft/active + 试跑记录，
// 原子写 0600，损坏先备份再抛错）；运行账本 ~/.nyra/workflow-runs.json（运行
// 记录 + 定义快照，原子写 0600，上限 200 条，超了丢最老的）；节点证据进
// workflow-runs.json（每节点输入/输出/耗时/成本）与 runs/<运行>/events.jsonl
//（workflow_node 事件），`nyra workflow show <运行 id>` 能逐节点回看。
//
// 本模块对 tools.ts / agent.ts / tasks.ts 只做动态 import（函数内 import）：
// 工具执行与模型调用只在真的跑到模型节点时才加载，避免把重依赖拉进纯 DSL
// 解析路径；且 tools → creator 的模块求值链不在本模块的静态 import 里。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { resolveHome, loadConfig } from "./config.ts";
import {
  pinWorkflowScripts,
  listPreauth,
  revokePreauth,
  workflowRoutineId,
  type PinResult,
} from "./scriptPreauth.ts";
// scriptPreauth 只依赖 scriptPurity 与 node 内置模块，是叶子模块，
// 静态导入不会形成循环（本模块对 tools.ts 的动态 import 惯例不受影响）。
// stepCheckpoints 同款叶子模块（只引 node 内置 + config）：recordNode 里
// 每节点记一条步级检查点；本模块绝不被它反向 import。
import {
  buildStepCheckpoint,
  planReplay,
  resolveStepCheckpointStore,
  snapshotStepsState,
  updateStepState,
  upsertCheckpoint,
  type ReplayPlan,
  type StepCheckpointStore,
} from "./stepCheckpoints.ts";
// interrupts 同款叶子模块（只引 node 内置）：结构化人机回环的中断单与
// schema 校验；本模块绝不被它反向 import。
import {
  createInterrupt,
  findInterrupt,
  getInterrupt,
  validateInterruptSpec,
  validateEditValues,
  type InterruptDecision,
  type InterruptPoint,
  type InterruptSchemaFieldType,
  type InterruptSpec,
  InterruptError,
} from "./interrupts.ts";
import { RunStore } from "./runs.ts";
import { enqueueReviewItem, getReviewItem } from "./reviewQueue.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { resolvePricing, computeCostUsd, resolveMonthlyLimit, checkMonthlyCap } from "./cost.ts";
import type { Pricing } from "./cost.ts";
import type { ProviderLike, ChatMessage } from "./providers.ts";

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export const MAX_STEPS = 50;
export const MAX_LOOP_ITERATIONS = 50;
export const DEFAULT_LOOP_ITERATIONS = 10;
export const MAX_PARALLEL_DEPTH = 3;
export const MAX_PARALLEL_BRANCHES = 8;
export const MAX_INPUTS = 20;
export const MAX_TRIGGERS = 10;
export const MAX_NAME_CHARS = 100;
export const MAX_DESC_CHARS = 500;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_TASK_CHARS = 4000;
export const MAX_OUTPUT_CHARS = 4000;
export const MAX_RUNS_KEPT = 200;
// 协调者 / 动态形态的硬上限（G-5 的 ADK 硬规矩：递归设硬深度上限；简单决策不调模型）。
export const MAX_COORDINATOR_ROUNDS = 20;
export const DEFAULT_COORDINATOR_ROUNDS = 10;
export const MAX_NEW_STEPS = 10;
export const DEFAULT_COORDINATOR_NEW_STEPS = 3;
export const DEFAULT_DYNAMIC_NEW_STEPS = 5;
export const MAX_STEP_RUNS = 3;
export const MAX_BAD_DECISIONS = 2;
export const MAX_GOAL_CHARS = 2000;
/** 协调者 ask 挂起的哨兵节点 id：不对应 steps 里的任何步骤，resume 时单独处理。 */
export const ASK_NODE_ID = "__ask__";
export const WORKFLOW_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,99}$/u;
export const STEP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export type WorkflowMode = "fixed" | "coordinator" | "dynamic";
export type WorkflowStatus = "draft" | "trial_passed" | "active";
export type WorkflowRunStatus = "running" | "awaiting_approval" | "awaiting_interrupt" | "completed" | "failed";
export type NodeType = "tool" | "llm" | "delegate" | "knowledge" | "skill" | "approve" | "parallel";

/** 协调者配置（只用于 coordinator / dynamic；fixed 写了直接拒绝）。 */
export interface WorkflowCoordinatorConfig {
  max_rounds?: number;
  max_new_steps?: number;
}

/** 协调者一轮的决定（记进运行账本与事件，是“协调者当时怎么想的”的证据）。 */
export interface WorkflowCoordinatorDecision {
  round: number;
  action: "run" | "new_step" | "finish" | "ask" | "invalid";
  step?: string;
  summary?: string;
  ok: boolean;
  error?: string | null;
  spent_usd: number | null;
}

/** 协调者运行态（存在运行记录里，挂起 resume 后从这里续跑，不丢轮数与动态步骤）。 */
export interface WorkflowCoordinatorState {
  round: number;
  executed: string[];
  runCounts: Record<string, number>;
  dynamicSteps: WorkflowStep[];
  decisions: WorkflowCoordinatorDecision[];
}

/** 协调者一轮解析后的决定（内部用，不进账本；进账本的是 WorkflowCoordinatorDecision）。 */
interface CoordinatorDecisionParsed {
  action: "run" | "new_step" | "finish" | "ask";
  stepId?: string;
  step?: WorkflowStep;
  summary?: string;
  question?: string;
}

export interface WorkflowStep {
  id: string;
  type: NodeType;
  if?: string;
  for_each?: { items: string; as: string; max?: number };
  tool?: string;
  args?: Record<string, unknown>;
  prompt?: string;
  system?: string;
  task?: string;
  max_turns?: number;
  base?: string;
  query?: string;
  top_k?: number;
  skill?: string;
  title?: string;
  summary?: string;
  on_reject?: "fail" | "skip";
  branches?: WorkflowStep[][];
  // G-P1-41：步骤前后的结构化人机回环。须机主显式配，默认不停；只认
  // fixed 形态的顶层步骤（并行分支内的步骤不认，审批节点已有审批流程
  // 也不认；coordinator/dynamic 的步骤由协调者每轮现定，停不住）。
  interrupt_before?: InterruptSpec;
  interrupt_after?: InterruptSpec;
}

export interface WorkflowTrigger {
  type: "schedule" | "event";
  cron?: string;
  event?: string;
}

export interface WorkflowDefinition {
  name: string;
  version: 1;
  description?: string;
  mode: WorkflowMode;
  /** 目标陈述（coordinator / dynamic 必填；fixed 不认）。 */
  goal?: string;
  /** 协调者配置（coordinator / dynamic 可选；fixed 不认）。 */
  coordinator?: WorkflowCoordinatorConfig;
  inputs?: Record<string, string | number | boolean>;
  max_cost_usd?: number;
  triggers?: WorkflowTrigger[];
  /** fixed / coordinator：计划步骤（非空）；dynamic：种子步骤（可为空，协调者运行中派生）。 */
  steps: WorkflowStep[];
}

export interface WorkflowRegistryEntry {
  name: string;
  file: string;
  status: WorkflowStatus;
  trialRunId: string | null;
  trialAt: string | null;
  activatedAt: string | null;
  updatedAt: string;
}

export interface WorkflowRegistry {
  version: 1;
  workflows: WorkflowRegistryEntry[];
}

export interface WorkflowNodeResult {
  id: string;
  type: NodeType;
  status: "ok" | "skipped" | "failed";
  startedAt: string;
  endedAt: string;
  ms: number;
  /** 渲染后的节点输入（工具参数 / 提示词 / 任务文本，截断到 4000 字）——节点级证据链的一半。 */
  input: string | null;
  output: string | null;
  approved: boolean | null;
  spentUsd: number | null;
  error: string | null;
}

export interface WorkflowRun {
  id: string;
  workflow: string;
  status: WorkflowRunStatus;
  inputs: Record<string, unknown>;
  definition: WorkflowDefinition;
  nodes: WorkflowNodeResult[];
  spentUsd: number | null;
  startedAt: string;
  endedAt: string | null;
  dryRun: boolean;
  trial: boolean;
  error: string | null;
  pendingNodeId: string | null;
  pendingNodeIndex: number | null;
  /** 挂起的中断单 id（G-P1-41）：运行在等人工回环时有值，否则为 null。 */
  pendingInterruptId?: string | null;
  reviewItemId: string | null;
  dryRunPlanHash: string | null;
  /** 协调者运行态（fixed 形态为 null；挂起 resume 后从这里续跑）。 */
  coordinator: WorkflowCoordinatorState | null;
  /** 时间旅行重放的来源（G-P1-40）：从哪个运行的哪一步重放过来；正常运行为 null。 */
  replayedFrom?: { runId: string; stepId: string; at: string } | null;
}

/** 协调者最多跑几轮（定义里没配用默认值 10，上限 20）。 */
export function resolveMaxRounds(def: WorkflowDefinition): number {
  return def.coordinator?.max_rounds ?? DEFAULT_COORDINATOR_ROUNDS;
}

/** 协调者最多再生成几个新步骤（定义里没配用默认值：coordinator 3、dynamic 5，上限 10）。 */
export function resolveMaxNewSteps(def: WorkflowDefinition): number {
  if (def.coordinator?.max_new_steps !== undefined) return def.coordinator.max_new_steps;
  return def.mode === "dynamic" ? DEFAULT_DYNAMIC_NEW_STEPS : DEFAULT_COORDINATOR_NEW_STEPS;
}

export interface WorkflowRunsLedger {
  version: 1;
  runs: WorkflowRun[];
}

export function workflowDir(home: string): string {
  return join(home, "workflows");
}

export function workflowRegistryPath(home: string): string {
  return join(home, "workflows.json");
}

export function workflowRunsPath(home: string): string {
  return join(home, "workflow-runs.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

export function newWorkflowRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(3).toString("hex")}`;
}

export function newCoordinatorState(): WorkflowCoordinatorState {
  return { round: 0, executed: [], runCounts: {}, dynamicSteps: [], decisions: [] };
}

function slugifyName(name: string): string {
  const slug = name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  // 全中文名会筛空：退回名字哈希前缀，保证文件名总有合法值。
  return slug || `wf-${sha256Hex(name).slice(0, 8)}`;
}

/** 原子写 0600（与 goals.json / kanban.json 同款口径）；写坏不留半截文件。 */
function atomicWriteJson0600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try { chmodSync0600(path); } catch { /* Windows 没有 POSIX 权限位 */ }
}

function chmodSync0600(path: string): void {
  chmodSync(path, 0o600);
}

/** 读 JSON 账本：不存在返回 null；损坏先备份（.corrupt-<时间戳>）再抛错。 */
function readJsonLedger<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new WorkflowError(`账本不安全（符号链接）：${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { copyFileSync(path, backup); } catch { /* 备份失败也不挡抛错 */ }
    throw new WorkflowError(`账本损坏，已备份到 ${backup}：${path}`);
  }
}

// ---------------------------------------------------------------------------
// YAML 子集解析器（确定性、无依赖）
//
// 只认 block 风格：映射、序列、嵌套、纯量（plain / 单引号 / 双引号）、
// 块标量 | 与 >（支持 +/- chomping 指示）、注释。以下一律拒绝并报明原因：
// Tab 缩进、flow 风格（{} / []）、锚点与别名（& / *）、标签（!）、重复键、
// 缩进不一致、超过 2000 行或嵌套超过 10 层。JSON 走 JSON.parse，不走这里。
// ---------------------------------------------------------------------------

const MAX_YAML_LINES = 2000;
const MAX_YAML_DEPTH = 10;

interface YamlLine {
  indent: number;
  text: string;
  no: number;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) {
      if (i > 0 && line[i - 1] === "\\") continue;
      inDouble = !inDouble;
    } else if (c === "#" && !inSingle && !inDouble) {
      if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line;
}

function parseYamlScalar(raw: string, where: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    const q = s[0];
    const inner = s.slice(1, -1);
    if (q === "'") return inner.replace(/''/g, "'");
    // 单遍反转义：一个正则一次扫过，按“反斜杠 + 下一字符”整体替换。
    // 顺序 replace 链是错的——先处理 \\n/\\t 会把“转义反斜杠 + 字母 n/t”
    //（如 Windows 路径 C:\\nyra-... 里的 \\n）误读成换行/制表符，路径被
    // 改写，Windows 上整轮 run 失败（CI #491：Windows 4 败）。单遍扫描时
    // \\ 只吃掉两个反斜杠，后面的字母保持原样。
    // 覆盖 JSON.stringify 会产出的转义（\\ \" \n \r \t \b \f \uXXXX）与
    // YAML 双引号常见转义；不认识的转义原样保留（与旧实现同款宽容）。
    return inner.replace(/\\(?:([\\"\/bfnrt0aev ])|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g, (m, simple: string | undefined, u: string | undefined, x: string | undefined) => {
      if (simple !== undefined) {
        switch (simple) {
          case "0": return "\0";
          case "a": return "\x07";
          case "b": return "\b";
          case "f": return "\f";
          case "n": return "\n";
          case "r": return "\r";
          case "t": return "\t";
          case "v": return "\v";
          case "e": return "\x1b";
          case " ": return " ";
          case "\\": return "\\";
          case '"': return '"';
          case "/": return "/";
          default: return m;
        }
      }
      if (u !== undefined) return String.fromCodePoint(parseInt(u, 16));
      if (x !== undefined) return String.fromCodePoint(parseInt(x, 16));
      return m;
    });
  }
  // 模板占位符 {{...}} 是纯量，不是 flow 风格（DSL 里满地都是 unquoted 的 {{inputs.x}}）。
  if (s.startsWith("{") && !s.startsWith("{{")) {
    throw new WorkflowError(`YAML 解析失败（${where}）：不支持 flow 风格、锚点/别名与标签，只认 block 风格`);
  }
  if (s.startsWith("[") || s.startsWith("&") || s.startsWith("*") || s.startsWith("!")) {
    throw new WorkflowError(`YAML 解析失败（${where}）：不支持 flow 风格、锚点/别名与标签，只认 block 风格`);
  }
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function splitYamlKeyValue(text: string, where: string): [string, string] | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) {
      if (i > 0 && text[i - 1] === "\\") continue;
      inDouble = !inDouble;
    } else if (c === ":" && !inSingle && !inDouble) {
      if (i + 1 >= text.length || text[i + 1] === " ") {
        return [text.slice(0, i), text.slice(i + 1)];
      }
    }
  }
  return null;
}

function parseYamlBlock(lines: YamlLine[], start: number, indent: number, depth: number, where: string): [unknown, number] {
  if (depth > MAX_YAML_DEPTH) throw new WorkflowError(`YAML 解析失败（${where}）：嵌套超过 ${MAX_YAML_DEPTH} 层`);
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (first.indent < indent) return [null, start];
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseYamlList(lines, start, first.indent, depth, where);
  }
  return parseYamlMap(lines, start, indent, depth, where);
}

function parseYamlMap(lines: YamlLine[], start: number, indent: number, depth: number, where: string): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new WorkflowError(`YAML 解析失败（第 ${line.no} 行）：缩进不一致（期望 ${indent} 格，实际 ${line.indent} 格）`);
    if (line.text.startsWith("- ") || line.text === "-") break;
    const kv = splitYamlKeyValue(line.text, `第 ${line.no} 行`);
    if (!kv) throw new WorkflowError(`YAML 解析失败（第 ${line.no} 行）：这一行不是 “键: 值” 的形式：${line.text.slice(0, 60)}`);
    const key = String(parseYamlScalar(kv[0], `第 ${line.no} 行`));
    if (key in out) throw new WorkflowError(`YAML 解析失败（第 ${line.no} 行）：重复的键 ${key}`);
    const rest = kv[1].trim();
    i++;
    if (rest === "" || rest === "|" || rest === ">" || rest === "|-" || rest === "|+" || rest === ">-" || rest === ">+") {
      if (rest === "" ) {
        if (i < lines.length && lines[i].indent > indent) {
          const [v, next] = parseYamlBlock(lines, i, lines[i].indent, depth + 1, where);
          out[key] = v;
          i = next;
        } else {
          out[key] = null;
        }
      } else {
        const [v, next] = parseYamlBlockScalar(lines, i, indent, rest, line.no);
        out[key] = v;
        i = next;
      }
    } else {
      out[key] = parseYamlScalar(rest, `第 ${line.no} 行`);
    }
  }
  return [out, i];
}

function parseYamlList(lines: YamlLine[], start: number, indent: number, depth: number, where: string): [unknown[], number] {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new WorkflowError(`YAML 解析失败（第 ${line.no} 行）：缩进不一致（期望 ${indent} 格，实际 ${line.indent} 格）`);
    if (!(line.text.startsWith("- ") || line.text === "-")) break;
    const itemText = line.text === "-" ? "" : line.text.slice(2);
    i++;
    if (itemText === "") {
      if (i < lines.length && lines[i].indent > indent) {
        const [v, next] = parseYamlBlock(lines, i, lines[i].indent, depth + 1, where);
        out.push(v);
        i = next;
      } else {
        out.push(null);
      }
      continue;
    }
    // "- key: value"：行内就是一个映射的开头
    const kv = splitYamlKeyValue(itemText, `第 ${line.no} 行`);
    if (kv) {
      const sub: YamlLine[] = [{ indent: indent + 2, text: itemText, no: line.no }];
      while (i < lines.length && lines[i].indent > indent) {
        sub.push(lines[i]);
        i++;
      }
      const [v, consumed] = parseYamlMap(sub, 0, indent + 2, depth + 1, where);
      if (consumed !== sub.length) {
        throw new WorkflowError(`YAML 解析失败（第 ${sub[consumed]?.no ?? line.no} 行）：缩进不一致（期望 ${indent + 2} 格）`);
      }
      out.push(v);
      continue;
    }
    out.push(parseYamlScalar(itemText, `第 ${line.no} 行`));
  }
  return [out, i];
}

function parseYamlBlockScalar(lines: YamlLine[], start: number, parentIndent: number, header: string, _lineNo: number): [string, number] {
  const literal = header.startsWith("|");
  const chomp = header.endsWith("-") ? "strip" : header.endsWith("+") ? "keep" : "clip";
  let i = start;
  let minIndent = Number.POSITIVE_INFINITY;
  while (i < lines.length && lines[i].indent > parentIndent) {
    minIndent = Math.min(minIndent, lines[i].indent);
    i++;
  }
  if (!Number.isFinite(minIndent)) return ["", start];
  // YamlLine.text 已去前导空白，内容用 indent - minIndent 还原相对缩进。
  const rawParts: string[] = [];
  for (let k = start; k < i; k++) {
    rawParts.push(" ".repeat(lines[k].indent - minIndent) + lines[k].text);
  }
  // 折叠标量 > 在子集里简化：换行变空格（空行分段不支持，见 docs/workflow.md）。
  const body0 = literal ? rawParts.join("\n") : rawParts.join(" ");
  let body: string;
  if (chomp === "strip") body = body0.replace(/\n+$/, "");
  else if (chomp === "clip") body = rawParts.length ? body0.replace(/\n*$/, "") + "\n" : "";
  else body = body0 + "\n";
  return [body, i];
}

/** 解析 DSL 文本：.json 走 JSON.parse，其余走 YAML 子集；空文档报错。 */
export function parseWorkflowText(text: string, sourceName: string): unknown {
  if (!text.trim()) throw new WorkflowError(`工作流定义为空：${sourceName}`);
  if (/\.json$/i.test(sourceName)) {
    try {
      return JSON.parse(text) as unknown;
    } catch (err: unknown) {
      throw new WorkflowError(`JSON 解析失败（${sourceName}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const rawLines = text.split("\n");
  if (rawLines.length > MAX_YAML_LINES) throw new WorkflowError(`YAML 解析失败：超过 ${MAX_YAML_LINES} 行`);
  const lines: YamlLine[] = [];
  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    const leading = raw.match(/^[ \t]*/)?.[0] ?? "";
    if (leading.includes("\t")) {
      throw new WorkflowError(`YAML 解析失败（第 ${n + 1} 行）：缩进里不许用 Tab`);
    }
    const noComment = stripYamlComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ indent, text: noComment.trimStart(), no: n + 1 });
  }
  if (!lines.length) throw new WorkflowError(`工作流定义为空：${sourceName}`);
  if (lines[0].indent !== 0) throw new WorkflowError("YAML 解析失败：首行必须顶格");
  const [value] = parseYamlBlock(lines, 0, 0, 0, sourceName);
  return value;
}

// ---------------------------------------------------------------------------
// DSL 校验（fail-closed：写错在 import/validate 时就拒绝，不等跑到一半才炸）
// ---------------------------------------------------------------------------

const NODE_COMMON_KEYS = new Set(["id", "type", "if", "for_each", "interrupt_before", "interrupt_after"]);
const NODE_KEYS: Record<NodeType, Set<string>> = {
  tool: new Set(["tool", "args"]),
  llm: new Set(["prompt", "system"]),
  delegate: new Set(["task", "max_turns"]),
  knowledge: new Set(["base", "query", "top_k"]),
  skill: new Set(["skill", "task"]),
  approve: new Set(["title", "summary", "on_reject"]),
  parallel: new Set(["branches"]),
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function needStr(v: unknown, where: string, min = 1, max = 8000): string {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    throw new WorkflowError(`工作流定义无效（${where}）：须是 ${min}–${max} 字的字符串`);
  }
  return v;
}

function needInt(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new WorkflowError(`工作流定义无效（${where}）：须是 ${min}–${max} 的整数`);
  }
  return v;
}

const CRON_FIELD_RE = /^[0-9*,/-]+$/;
function validateCron(cron: string, where: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((p) => !CRON_FIELD_RE.test(p))) {
    throw new WorkflowError(`工作流定义无效（${where}）：cron 须是 5 个字段（分 时 日 月 周），只认数字、*、,、-、/`);
  }
}

function validateStep(raw: unknown, where: string, depth: number, ids: Set<string>, knownTools?: Set<string> | null, dynamicStep = false): WorkflowStep {
  if (!isObj(raw)) throw new WorkflowError(`工作流定义无效（${where}）：步骤须是映射`);
  const id = raw.id;
  if (typeof id !== "string" || !STEP_ID_RE.test(id)) {
    throw new WorkflowError(`工作流定义无效（${where}）：步骤 id 须是小写字母开头、只含小写字母/数字/_/-、不超过 32 字`);
  }
  if (ids.has(id)) throw new WorkflowError(`工作流定义无效：步骤 id 重复：${id}`);
  ids.add(id);
  const type = raw.type;
  if (typeof type !== "string" || !(type in NODE_KEYS)) {
    throw new WorkflowError(`工作流定义无效（步骤 ${id}）：type 须是 tool / llm / delegate / knowledge / skill / approve / parallel 之一`);
  }
  const step = raw as unknown as WorkflowStep;
  const allowed = new Set([...NODE_COMMON_KEYS, ...NODE_KEYS[type as NodeType]]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new WorkflowError(`工作流定义无效（步骤 ${id}）：${type} 节点不认字段 ${k}`);
  }
  // G-P1-41：interrupt_before / interrupt_after 只认 fixed 形态的顶层步骤；
  // 并行分支内的步骤（depth > 0）与审批节点不认（审批节点已有审批流程）。
  const hasInterrupt = raw.interrupt_before !== undefined || raw.interrupt_after !== undefined;
  if (hasInterrupt && depth > 0) {
    throw new WorkflowError(`工作流定义无效（步骤 ${id}）：并行分支内的步骤不支持 interrupt_before / interrupt_after（只认顶层步骤）`);
  }
  if (hasInterrupt && type === "approve") {
    throw new WorkflowError(`工作流定义无效（步骤 ${id}）：审批节点已有审批流程，不用再配 interrupt_before / interrupt_after`);
  }
  for (const key of ["interrupt_before", "interrupt_after"] as const) {
    if (raw[key] !== undefined) {
      try {
        validateInterruptSpec(raw[key], `步骤 ${id} 的 ${key}`);
      } catch (err) {
        if (err instanceof InterruptError) throw new WorkflowError(`工作流定义无效（步骤 ${id} 的 ${key}）：${err.message}`);
        throw err;
      }
    }
  }
  if (raw.if !== undefined) needStr(raw.if, `步骤 ${id} 的 if`, 1, 500);
  if (raw.for_each !== undefined) {
    if (type === "approve") {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：审批节点不支持放在循环里`);
    }
    if (!isObj(raw.for_each)) throw new WorkflowError(`工作流定义无效（步骤 ${id}）：for_each 须是映射`);
    needStr(raw.for_each.items, `步骤 ${id} 的 for_each.items`, 1, 500);
    const as = raw.for_each.as;
    if (typeof as !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(as)) {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：for_each.as 须是小写字母开头的变量名`);
    }
    if (raw.for_each.max !== undefined) needInt(raw.for_each.max, `步骤 ${id} 的 for_each.max`, 1, MAX_LOOP_ITERATIONS);
  }
  if (type === "tool") {
    needStr(raw.tool, `步骤 ${id} 的 tool`, 1, 100);
    if (knownTools && !knownTools.has(raw.tool as string)) {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：未知工具 ${raw.tool}`);
    }
    if (raw.args !== undefined && !isObj(raw.args)) throw new WorkflowError(`工作流定义无效（步骤 ${id}）：args 须是映射`);
  } else if (type === "llm") {
    needStr(raw.prompt, `步骤 ${id} 的 prompt`, 1, MAX_PROMPT_CHARS);
    if (raw.system !== undefined) needStr(raw.system, `步骤 ${id} 的 system`, 1, MAX_PROMPT_CHARS);
  } else if (type === "delegate") {
    needStr(raw.task, `步骤 ${id} 的 task`, 1, MAX_TASK_CHARS);
    if (raw.max_turns !== undefined) needInt(raw.max_turns, `步骤 ${id} 的 max_turns`, 1, 12);
  } else if (type === "knowledge") {
    needStr(raw.base, `步骤 ${id} 的 base`, 1, 100);
    needStr(raw.query, `步骤 ${id} 的 query`, 1, 2000);
    if (raw.top_k !== undefined) needInt(raw.top_k, `步骤 ${id} 的 top_k`, 1, 20);
  } else if (type === "skill") {
    needStr(raw.skill, `步骤 ${id} 的 skill`, 1, 100);
    needStr(raw.task, `步骤 ${id} 的 task`, 1, MAX_TASK_CHARS);
  } else if (type === "approve") {
    if (dynamicStep) {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：动态生成的步骤不能是审批节点（审批须写进计划，或让协调者用 ask 停下来问人）`);
    }
    needStr(raw.title, `步骤 ${id} 的 title`, 1, 200);
    if (raw.summary !== undefined) needStr(raw.summary, `步骤 ${id} 的 summary`, 1, 2000);
    if (raw.on_reject !== undefined && raw.on_reject !== "fail" && raw.on_reject !== "skip") {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：on_reject 只认 fail / skip`);
    }
  } else if (type === "parallel") {
    if (depth >= MAX_PARALLEL_DEPTH) {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：并行嵌套超过 ${MAX_PARALLEL_DEPTH} 层（G-5 硬深度上限）`);
    }
    if (!Array.isArray(raw.branches) || raw.branches.length < 2 || raw.branches.length > MAX_PARALLEL_BRANCHES) {
      throw new WorkflowError(`工作流定义无效（步骤 ${id}）：parallel 须有 2–${MAX_PARALLEL_BRANCHES} 个分支`);
    }
    for (let b = 0; b < raw.branches.length; b++) {
      const branch = raw.branches[b];
      if (!Array.isArray(branch) || branch.length === 0) {
        throw new WorkflowError(`工作流定义无效（步骤 ${id}）：parallel 第 ${b + 1} 个分支不能为空`);
      }
      const hasApprove = (list: unknown[]): boolean => list.some((s) => {
        if (!isObj(s)) return false;
        if (s.type === "approve") return true;
        return Array.isArray(s.branches) && s.branches.some((br) => Array.isArray(br) && hasApprove(br));
      });
      if (hasApprove(branch)) {
        throw new WorkflowError(`工作流定义无效（步骤 ${id}）：审批节点只认顶层步骤，不许放并行分支里`);
      }
      for (const sub of branch) validateStep(sub, `${where} 分支 ${b + 1}`, depth + 1, ids, knownTools, dynamicStep);
    }
  }
  return step;
}

function countSteps(steps: WorkflowStep[]): number {
  let n = 0;
  const walk = (list: WorkflowStep[]): void => {
    for (const s of list) {
      n++;
      if (s.type === "parallel" && s.branches) for (const b of s.branches) walk(b);
    }
  };
  walk(steps);
  return n;
}

/** 把解析出的值校验成 WorkflowDefinition；knownTools 传了才校验工具名。 */
export function validateWorkflowDefinition(value: unknown, knownTools?: Set<string> | null): WorkflowDefinition {
  if (!isObj(value)) throw new WorkflowError("工作流定义无效：顶层须是映射");
  const name = value.name;
  if (typeof name !== "string" || !WORKFLOW_NAME_RE.test(name) || name.length > MAX_NAME_CHARS) {
    throw new WorkflowError("工作流定义无效：name 须是字母/数字开头、只含字母/数字/空格/_/-、不超过 100 字");
  }
  if (value.version !== 1) throw new WorkflowError("工作流定义无效：version 目前只认 1");
  const mode = value.mode;
  if (mode !== "fixed" && mode !== "coordinator" && mode !== "dynamic") {
    throw new WorkflowError("工作流定义无效：mode 只认 fixed / coordinator / dynamic");
  }
  const allowedTop = new Set(["name", "version", "description", "mode", "goal", "coordinator", "inputs", "max_cost_usd", "triggers", "steps"]);
  for (const k of Object.keys(value)) {
    if (!allowedTop.has(k)) throw new WorkflowError(`工作流定义无效：顶层不认字段 ${k}`);
  }
  const def = value as unknown as WorkflowDefinition;
  if (def.goal !== undefined) {
    if (mode === "fixed") throw new WorkflowError("工作流定义无效：goal 只用于 coordinator / dynamic，fixed 不认");
    needStr(def.goal, "goal", 1, MAX_GOAL_CHARS);
  }
  if (mode !== "fixed" && (def.goal === undefined || def.goal.trim() === "")) {
    throw new WorkflowError(`工作流定义无效：mode ${mode} 须写 goal（协调者要知道目标是什么）`);
  }
  if (def.coordinator !== undefined) {
    if (mode === "fixed") throw new WorkflowError("工作流定义无效：coordinator 配置只用于 coordinator / dynamic，fixed 不认");
    if (!isObj(def.coordinator)) throw new WorkflowError("工作流定义无效：coordinator 须是映射");
    const c = def.coordinator as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (k !== "max_rounds" && k !== "max_new_steps") throw new WorkflowError(`工作流定义无效：coordinator 不认字段 ${k}`);
    }
    if (c.max_rounds !== undefined) needInt(c.max_rounds, "coordinator.max_rounds", 1, MAX_COORDINATOR_ROUNDS);
    if (c.max_new_steps !== undefined) needInt(c.max_new_steps, "coordinator.max_new_steps", 0, MAX_NEW_STEPS);
  }
  if (def.description !== undefined) needStr(def.description, "description", 1, MAX_DESC_CHARS);
  if (def.inputs !== undefined) {
    if (!isObj(def.inputs)) throw new WorkflowError("工作流定义无效：inputs 须是映射");
    const keys = Object.keys(def.inputs);
    if (keys.length > MAX_INPUTS) throw new WorkflowError(`工作流定义无效：inputs 最多 ${MAX_INPUTS} 个`);
    for (const k of keys) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) throw new WorkflowError(`工作流定义无效：inputs 的键 ${k} 须是小写字母开头的变量名`);
      const v = (def.inputs as Record<string, unknown>)[k];
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new WorkflowError(`工作流定义无效：inputs.${k} 的默认值只认字符串/数字/布尔`);
      }
    }
  }
  if (def.max_cost_usd !== undefined) {
    if (typeof def.max_cost_usd !== "number" || !Number.isFinite(def.max_cost_usd) || def.max_cost_usd <= 0 || def.max_cost_usd > 1000) {
      throw new WorkflowError("工作流定义无效：max_cost_usd 须是 0–1000 的数字");
    }
  }
  if (def.triggers !== undefined) {
    if (!Array.isArray(def.triggers) || def.triggers.length > MAX_TRIGGERS) {
      throw new WorkflowError(`工作流定义无效：triggers 最多 ${MAX_TRIGGERS} 个`);
    }
    for (let i = 0; i < def.triggers.length; i++) {
      const t = def.triggers[i];
      if (!isObj(t)) throw new WorkflowError(`工作流定义无效：triggers[${i}] 须是映射`);
      if (t.type === "schedule") {
        if (typeof t.cron !== "string") throw new WorkflowError(`工作流定义无效：triggers[${i}] 的 schedule 须给 cron`);
        validateCron(t.cron, `triggers[${i}]`);
      } else if (t.type === "event") {
        needStr(t.event, `triggers[${i}] 的 event`, 1, 100);
      } else {
        throw new WorkflowError(`工作流定义无效：triggers[${i}] 的 type 只认 schedule / event`);
      }
    }
  }
  // dynamic 允许 steps 键缺省（YAML 子集写不出空列表）：缺省按空数组算；其他形态缺 steps 直接拒绝。
  if (def.steps === undefined && mode === "dynamic") def.steps = [];
  if (!Array.isArray(def.steps)) {
    throw new WorkflowError("工作流定义无效：steps 须是数组");
  }
  if (mode === "dynamic") {
    // dynamic 允许种子步骤为空（协调者运行中派生），但新步骤额度不能同时是 0，否则没步骤可跑。
    if (def.steps.length === 0 && resolveMaxNewSteps(def) === 0) {
      throw new WorkflowError("工作流定义无效：dynamic 模式 steps 为空时，coordinator.max_new_steps 不能是 0（否则没步骤可跑）");
    }
  } else if (def.steps.length === 0) {
    throw new WorkflowError("工作流定义无效：steps 须是非空数组");
  }
  const ids = new Set<string>();
  for (const s of def.steps) validateStep(s, "顶层", 0, ids, knownTools);
  // G-P1-41：interrupt_before / interrupt_after 只用于 fixed 形态——
  // coordinator / dynamic 的步骤由协调者每轮现定，停不住，配了直接拒绝。
  if (mode !== "fixed") {
    for (const s of def.steps) {
      const step = s as unknown as WorkflowStep;
      if (step.interrupt_before !== undefined || step.interrupt_after !== undefined) {
        throw new WorkflowError(`工作流定义无效（步骤 ${step.id}）：interrupt_before / interrupt_after 只用于 fixed 形态，${mode} 形态的步骤由协调者每轮现定，停不住`);
      }
    }
  }
  if (countSteps(def.steps) > MAX_STEPS) {
    throw new WorkflowError(`工作流定义无效：节点总数超过 ${MAX_STEPS} 个（含并行分支内节点）`);
  }
  return def;
}

export function parseWorkflowDefinition(text: string, sourceName: string, knownTools?: Set<string> | null): WorkflowDefinition {
  return validateWorkflowDefinition(parseWorkflowText(text, sourceName), knownTools);
}

// ---------------------------------------------------------------------------
// 条件求值（G-5：简单决策用 if/else，不调模型）与模板渲染
//
// 条件语法：标识符（inputs.<名> / steps.<id>.output|approved|ok / loop.<变量>|index）、
// 字符串/数字/布尔字面量、== != > >= < <=、contains、and or not、括号。
// 未知变量、类型不匹配一律抛错（fail-closed，不静默当 false）。
// ---------------------------------------------------------------------------

export type ScopeValue = string | number | boolean | null | unknown[] | Record<string, unknown>;
export type EvalScope = Record<string, ScopeValue>;

type CondAst =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "ref"; path: string[] }
  | { kind: "not"; expr: CondAst }
  | { kind: "and"; left: CondAst; right: CondAst }
  | { kind: "or"; left: CondAst; right: CondAst }
  | { kind: "cmp"; op: string; left: CondAst; right: CondAst };

function tokenizeCondition(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === "(" || c === ")") { tokens.push(c); i++; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== q) {
        if (src[j] === "\\" && j + 1 < src.length && q === '"') { out += src[j + 1]; j += 2; continue; }
        out += src[j];
        j++;
      }
      if (j >= src.length) throw new WorkflowError(`条件解析失败：字符串没闭合：${src.slice(0, 60)}`);
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    const m = /^(==|!=|>=|<=|>|<)/.exec(src.slice(i));
    if (m) { tokens.push(m[1]); i += m[1].length; continue; }
    const w = /^[A-Za-z0-9_.]+/.exec(src.slice(i));
    if (w) { tokens.push(w[0]); i += w[0].length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { tokens.push(num[0]); i += num[0].length; continue; }
    throw new WorkflowError(`条件解析失败：认不出的字符 ${c}：${src.slice(0, 60)}`);
  }
  return tokens;
}

function parseCondition(src: string): CondAst {
  const tokens = tokenizeCondition(src);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string | undefined => tokens[pos++];
  function parseOr(): CondAst {
    let left = parseAnd();
    while (peek() === "or") { next(); left = { kind: "or", left, right: parseAnd() }; }
    return left;
  }
  function parseAnd(): CondAst {
    let left = parseNot();
    while (peek() === "and") { next(); left = { kind: "and", left, right: parseNot() }; }
    return left;
  }
  function parseNot(): CondAst {
    if (peek() === "not") { next(); return { kind: "not", expr: parseNot() }; }
    return parseCmp();
  }
  function parseCmp(): CondAst {
    const left = parsePrimary();
    const op = peek();
    if (op === "==" || op === "!=" || op === ">" || op === ">=" || op === "<" || op === "<=" || op === "contains") {
      next();
      return { kind: "cmp", op, left, right: parsePrimary() };
    }
    return left;
  }
  function parsePrimary(): CondAst {
    const t = next();
    if (t === undefined) throw new WorkflowError(`条件解析失败：表达式不完整：${src.slice(0, 60)}`);
    if (t === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new WorkflowError(`条件解析失败：括号没闭合：${src.slice(0, 60)}`);
      return inner;
    }
    if (t.startsWith('"')) {
      try { return { kind: "lit", value: JSON.parse(t) as string }; } catch { throw new WorkflowError(`条件解析失败：字符串没闭合：${src.slice(0, 60)}`); }
    }
    if (t === "true") return { kind: "lit", value: true };
    if (t === "false") return { kind: "lit", value: false };
    if (t === "null") return { kind: "lit", value: null };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "lit", value: Number(t) };
    if (/^[A-Za-z][A-Za-z0-9_.]*$/.test(t)) return { kind: "ref", path: t.split(".") };
    throw new WorkflowError(`条件解析失败：认不出的词 ${t}`);
  }
  const ast = parseOr();
  if (pos !== tokens.length) throw new WorkflowError(`条件解析失败：多余的词 ${tokens[pos]}`);
  return ast;
}

function lookupScope(scope: EvalScope, path: string[]): ScopeValue {
  let cur: unknown = scope;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") {
      throw new WorkflowError(`条件求值失败：变量 ${path.join(".")} 不存在`);
    }
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) throw new WorkflowError(`条件求值失败：变量 ${path.join(".")} 不存在`);
  }
  return cur as ScopeValue;
}

function valuesEqual(a: ScopeValue, b: ScopeValue): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function evalCondition(src: string, scope: EvalScope): boolean {
  const ast = parseCondition(src);
  const ev = (node: CondAst): ScopeValue => {
    switch (node.kind) {
      case "lit": return node.value;
      case "ref": return lookupScope(scope, node.path);
      case "not": {
        const v = ev(node.expr);
        if (typeof v !== "boolean") throw new WorkflowError("条件求值失败：not 后面须是布尔值");
        return !v;
      }
      case "and": {
        const l = ev(node.left);
        const r = ev(node.right);
        if (typeof l !== "boolean" || typeof r !== "boolean") throw new WorkflowError("条件求值失败：and 两边须是布尔值");
        return l && r;
      }
      case "or": {
        const l = ev(node.left);
        const r = ev(node.right);
        if (typeof l !== "boolean" || typeof r !== "boolean") throw new WorkflowError("条件求值失败：or 两边须是布尔值");
        return l || r;
      }
      case "cmp": {
        const l = ev(node.left);
        const r = ev(node.right);
        if (node.op === "==") return valuesEqual(l, r);
        if (node.op === "!=") return !valuesEqual(l, r);
        if (node.op === "contains") {
          if (typeof l === "string" && typeof r === "string") return l.includes(r);
          if (Array.isArray(l)) return l.some((x) => valuesEqual(x as ScopeValue, r));
          throw new WorkflowError("条件求值失败：contains 左边须是字符串或数组");
        }
        if (typeof l !== "number" || typeof r !== "number") {
          throw new WorkflowError(`条件求值失败：${node.op} 两边须是数字`);
        }
        if (node.op === ">") return l > r;
        if (node.op === ">=") return l >= r;
        if (node.op === "<") return l < r;
        return l <= r;
      }
    }
  };
  const out = ev(ast);
  if (typeof out !== "boolean") throw new WorkflowError("条件求值失败：if 的结果须是布尔值");
  return out;
}

/** 模板渲染：{{path}}；整串恰好一个占位符时返回原始值（数组/数字/布尔不被串化）。 */
export function renderTemplate(text: string, scope: EvalScope): unknown {
  const re = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return text;
  if (matches.length === 1 && matches[0][0] === text) {
    return lookupScope(scope, matches[0][1].split("."));
  }
  return text.replace(re, (_m, path: string) => {
    const v = lookupScope(scope, path.split("."));
    if (v === null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

function renderValue(value: unknown, scope: EvalScope): unknown {
  if (typeof value === "string") return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, scope));
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderValue(v, scope);
    return out;
  }
  return value;
}

/** 键排序的稳定 JSON（dry-run 计划哈希与条件 == 比较共用）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// 注册表与运行账本（原子写 0600；损坏先备份再抛错，与 goals.json 同口径）
// ---------------------------------------------------------------------------

export function loadWorkflowRegistry(home: string): WorkflowRegistry {
  const parsed = readJsonLedger<WorkflowRegistry>(workflowRegistryPath(home));
  if (!parsed) return { version: 1, workflows: [] };
  if (parsed.version !== 1 || !Array.isArray(parsed.workflows)) {
    throw new WorkflowError("workflows.json 格式无效：version 须为 1 且 workflows 须是数组");
  }
  return parsed;
}

export function saveWorkflowRegistry(home: string, registry: WorkflowRegistry): void {
  atomicWriteJson0600(workflowRegistryPath(home), registry);
}

export function loadWorkflowRuns(home: string): WorkflowRunsLedger {
  const parsed = readJsonLedger<WorkflowRunsLedger>(workflowRunsPath(home));
  if (!parsed) return { version: 1, runs: [] };
  if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
    throw new WorkflowError("workflow-runs.json 格式无效：version 须为 1 且 runs 须是数组");
  }
  return parsed;
}

export function saveWorkflowRun(home: string, run: WorkflowRun): void {
  const ledger = loadWorkflowRuns(home);
  const idx = ledger.runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) ledger.runs[idx] = run;
  else ledger.runs.push(run);
  while (ledger.runs.length > MAX_RUNS_KEPT) ledger.runs.shift();
  atomicWriteJson0600(workflowRunsPath(home), ledger);
}

export function getWorkflowRun(home: string, runId: string): WorkflowRun | null {
  return loadWorkflowRuns(home).runs.find((r) => r.id === runId) ?? null;
}

export function loadWorkflowDefinitionFile(home: string, name: string): { def: WorkflowDefinition; file: string; text: string } {
  const registry = loadWorkflowRegistry(home);
  const entry = registry.workflows.find((w) => w.name === name);
  if (!entry) throw new WorkflowError(`没有这个工作流：${name}（先 nyra workflow import <文件> 导入）`);
  const path = join(workflowDir(home), entry.file);
  if (!existsSync(path)) throw new WorkflowError(`工作流定义文件丢了：${entry.file}`);
  const text = readFileSync(path, "utf-8");
  const def = parseWorkflowDefinition(text, entry.file);
  return { def, file: entry.file, text };
}

export function listWorkflows(home: string): WorkflowRegistryEntry[] {
  return loadWorkflowRegistry(home).workflows;
}

// ---------------------------------------------------------------------------
// dry-run 计划（只列出会写/会发什么，不执行；结果带 SHA-256，可验证）
// ---------------------------------------------------------------------------

export interface DryRunAction {
  nodeId: string;
  kind: "write" | "send" | "unknown-model-action" | "read";
  detail: string;
}

export interface DryRunPlan {
  workflow: string;
  inputs: Record<string, unknown>;
  actions: DryRunAction[];
  skippedNodes: string[];
  hash: string;
}

const TOOL_READ_HINTS = new Set(["read_file", "list_dir", "search", "grep", "read", "list", "show", "get", "fetch", "status"]);

function toolActionKind(toolName: string, args: Record<string, unknown>): DryRunAction["kind"] {
  const lower = toolName.toLowerCase();
  if (lower.includes("send") || lower.includes("mail") || lower.includes("post") || lower.includes("publish") || lower.includes("notify") || lower.includes("message")) return "send";
  if (TOOL_READ_HINTS.has(lower) || lower.startsWith("read") || lower.startsWith("list") || lower.startsWith("search") || lower.startsWith("get")) return "read";
  if (lower.includes("write") || lower.includes("create") || lower.includes("edit") || lower.includes("delete") || lower.includes("update") || lower.includes("set") || lower.includes("move") || lower.includes("mkdir")) return "write";
  void args;
  return "write";
}

/** 对一段步骤做静态 dry-run 枚举；llm/delegate/skill 节点记 unknown-model-action。
 *  协调者/动态形态下计划步骤只是“候选”（协调者运行中决定跑不跑），详情里写明；
 *  协调者还能再生成的新步骤不在这里，其动作在 dryRunPlan 里另记一条。 */
function planSteps(steps: WorkflowStep[], scope: EvalScope, actions: DryRunAction[], skipped: string[], depth: number, mode: WorkflowMode = "fixed"): void {
  const candidate = mode === "fixed" ? "" : "（候选步骤：协调者运行中决定是否执行）";
  // dry-run 不知道前面步骤的输出是什么：给每个走过的步骤记一个占位输出，
  // 后面的步骤引用 {{steps.<id>.output}} 时按占位渲染，不炸；占位进计划文本，
  // 使用者一眼能看出这是未知值，不会当成真内容。
  const setStepOutput = (s: EvalScope, id: string, note: string): void => {
    const stepOutputs = s.steps as Record<string, ScopeValue>;
    stepOutputs[id] = { output: note };
  };
  for (const step of steps) {
    // if 引用了前面步骤的输出时 dry-run 无法判定真假：按会执行列出并注明，
    // 不直接炸掉整个计划；真正写错的 if（语法错、类型错）仍抛错。
    let ifUndecidable = false;
    if (step.if !== undefined) {
      let cond: boolean;
      try {
        cond = evalCondition(step.if, scope);
      } catch (err: unknown) {
        // 引用了前面步骤的输出（占位是字符串，求值报“不存在”或“须是布尔值”）
        // 都算无法判定；真正写错的 if（语法错、类型错）仍抛错。
        if (err instanceof Error && (err.message.includes("不存在") || err.message.includes("须是布尔值"))) {
          ifUndecidable = true;
          cond = true;
        } else {
          throw new WorkflowError(`dry-run 失败（步骤 ${step.id} 的 if 求值出错）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!cond) { skipped.push(step.id); continue; }
    }
    const undecidableNote = ifUndecidable ? "（if 条件在 dry-run 里无法判定，按会执行列出）" : "";
    // 循环步骤：dry-run 不知道循环跑几轮，只按一轮列动作；循环变量用占位符渲染，
    // 让使用者一眼看出这是每轮都会做的动作（不静默当成只做一次）。
    const stepScope: EvalScope = step.for_each
      ? { ...scope, loop: { [step.for_each.as]: "<循环项>", index: 0 } }
      : scope;
    if (step.type === "tool") {
      const args = (renderValue(step.args ?? {}, stepScope) as Record<string, unknown>);
      actions.push({ nodeId: step.id, kind: toolActionKind(step.tool ?? "", args), detail: `${step.tool} ${stableStringify(args)}${step.for_each ? "（每轮一次）" : ""}${candidate}${undecidableNote}` });
      setStepOutput(stepScope, step.id, "<工具输出，dry-run 未知>");
    } else if (step.type === "llm" || step.type === "delegate" || step.type === "skill") {
      actions.push({ nodeId: step.id, kind: "unknown-model-action", detail: `${step.type} 节点的动作由模型临场决定，dry-run 无法枚举（可能产生写/发动作）${step.for_each ? "（每轮一次）" : ""}${candidate}${undecidableNote}` });
      setStepOutput(stepScope, step.id, "<模型输出，dry-run 未知>");
    } else if (step.type === "knowledge") {
      actions.push({ nodeId: step.id, kind: "read", detail: `知识检索 ${step.base ?? ""}：${String(renderTemplate(step.query ?? "", stepScope))}${candidate}${undecidableNote}` });
      setStepOutput(stepScope, step.id, "<知识检索结果，dry-run 未知>");
    } else if (step.type === "approve") {
      actions.push({ nodeId: step.id, kind: "read", detail: `审批节点（人工批复，dry-run 不进审阅队列）：${step.title ?? ""}${candidate}${undecidableNote}` });
    } else if (step.type === "parallel") {
      if (depth >= MAX_PARALLEL_DEPTH) throw new WorkflowError(`dry-run 失败（步骤 ${step.id}）：并行嵌套超过 ${MAX_PARALLEL_DEPTH} 层`);
      for (const branch of step.branches ?? []) planSteps(branch, stepScope, actions, skipped, depth + 1, mode);
    }
  }
}

export function dryRunPlan(def: WorkflowDefinition, inputs: Record<string, unknown>): DryRunPlan {
  const scope: EvalScope = { inputs: inputs as ScopeValue, steps: {}, loop: {} };
  const actions: DryRunAction[] = [];
  const skipped: string[] = [];
  planSteps(def.steps, scope, actions, skipped, 0, def.mode);
  const maxNew = resolveMaxNewSteps(def);
  if (def.mode !== "fixed" && maxNew > 0) {
    actions.push({ nodeId: "__coordinator__", kind: "unknown-model-action", detail: `协调者最多再生成 ${maxNew} 个新步骤，其动作无法枚举（可能产生写/发动作）` });
  }
  const hash = sha256Hex(stableStringify({ workflow: def.name, inputs, actions, skipped }));
  return { workflow: def.name, inputs, actions, skippedNodes: skipped, hash };
}

/** 用运行里存的定义快照重算 dry-run 计划、比哈希（verify 口径）。 */
export function verifyDryRunPlan(run: WorkflowRun): { ok: boolean; expectedHash: string; actualHash: string } {
  const plan = dryRunPlan(run.definition, run.inputs);
  return { ok: plan.hash === run.dryRunPlanHash, expectedHash: run.dryRunPlanHash ?? "", actualHash: plan.hash };
}

// ---------------------------------------------------------------------------
// 执行器（固定图：按 steps 顺序跑；分支/循环/并行是 DSL 控制结构）
// ---------------------------------------------------------------------------

export class WorkflowPendingApproval extends Error {
  reviewItemId: string;
  nodeId: string;
  nodeIndex: number;
  constructor(reviewItemId: string, nodeId: string, nodeIndex: number) {
    super(`审批节点 ${nodeId} 等待人工批复`);
    this.name = "WorkflowPendingApproval";
    this.reviewItemId = reviewItemId;
    this.nodeId = nodeId;
    this.nodeIndex = nodeIndex;
  }
}

/** G-P1-41：跑到配了 interrupt_before / interrupt_after 的步骤，停住等人。
 *  不是错误，是挂起：runFrom 抓到它后把运行标 awaiting_interrupt 再返回。 */
export class WorkflowPendingInterrupt extends Error {
  interruptId: string;
  stepId: string;
  point: InterruptPoint;
  nodeIndex: number;
  constructor(interruptId: string, stepId: string, point: InterruptPoint, nodeIndex: number) {
    super(`步骤 ${stepId} 在 ${point === "before" ? "跑前" : "跑后"}停下来等人（中断单 ${interruptId}）`);
    this.name = "WorkflowPendingInterrupt";
    this.interruptId = interruptId;
    this.stepId = stepId;
    this.point = point;
    this.nodeIndex = nodeIndex;
  }
}

export interface WorkflowRunOptions {
  home: string;
  workdir: string;
  mode: "normal" | "readonly";
  interactive: boolean;
  maxCostUsd?: number;
  providerFactory?: () => Promise<ProviderLike>;
  dryRun?: boolean;
  trial?: boolean;
  /** 步级检查点 store（G-P1-40；测试传内存 store，不传默认按配置解析）。 */
  stepCheckpointStore?: StepCheckpointStore;
  /** G-P1-41：interrupt resume 时带的步骤输入覆盖（只给 edit 决定用），
   *  按步骤 id 索引；续跑前已按步骤类型校验过。 */
  stepInputOverrides?: Map<string, Record<string, unknown>>;
}

function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（输出过长，已截断，原文 ${text.length} 字）`;
}

function extractChatText(resp: Record<string, unknown>): string {
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, unknown>).text as string : "")).join("");
  }
  return "";
}

function extractChatUsage(resp: Record<string, unknown>): { prompt: number | null; completion: number | null } {
  const u = resp.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return { prompt: null, completion: null };
  const p = u.prompt_tokens;
  const c = u.completion_tokens;
  return {
    prompt: typeof p === "number" ? p : null,
    completion: typeof c === "number" ? c : null,
  };
}

class WorkflowRunner {
  def: WorkflowDefinition;
  inputs: Record<string, unknown>;
  run: WorkflowRun;
  home: string;
  workdir: string;
  mode: "normal" | "readonly";
  interactive: boolean;
  maxCostUsd: number | null;
  providerFactory: (() => Promise<ProviderLike>) | null;
  providerCache: ProviderLike | null = null;
  store: RunStore;
  storeRunId: string;
  ledger: UsageLedger;
  scope: EvalScope;
  spentKnown = 0;
  monthlyLimit: number | null;
  config: Record<string, unknown>;
  coordState: WorkflowCoordinatorState | null;
  badDecisions = 0;
  knownTools: Set<string> | null = null;
  /** 步级检查点 store（G-P1-40）：recordNode 每节点记一条；远端后端在运行里是 best-effort。 */
  stepCheckpointStore: StepCheckpointStore;
  /** G-P1-41：interrupt resume 时带的步骤输入覆盖（只给 edit 决定用）。 */
  stepInputOverrides: Map<string, Record<string, unknown>>;

  constructor(def: WorkflowDefinition, inputs: Record<string, unknown>, opts: WorkflowRunOptions, existingRun?: WorkflowRun) {
    this.def = def;
    this.inputs = inputs;
    this.home = opts.home;
    this.workdir = opts.workdir;
    this.mode = opts.mode;
    this.interactive = opts.interactive;
    this.maxCostUsd = opts.maxCostUsd ?? (typeof def.max_cost_usd === "number" ? def.max_cost_usd : null);
    this.providerFactory = opts.providerFactory ?? null;
    this.store = new RunStore(join(opts.home, "runs"));
    this.ledger = new UsageLedger(opts.home);
    this.config = loadConfig(opts.home);
    this.stepCheckpointStore = opts.stepCheckpointStore ?? resolveStepCheckpointStore(opts.home, { config: this.config });
    this.stepInputOverrides = opts.stepInputOverrides ?? new Map();
    this.monthlyLimit = resolveMonthlyLimit(this.config);
    this.scope = { inputs: inputs as ScopeValue, steps: {}, loop: {} };
    if (existingRun) {
      this.run = existingRun;
      this.run.status = "running";
      this.run.endedAt = null;
      this.run.error = null;
      // 续跑：把已记节点的输出重放回 scope，供后续步骤的模板/条件用。
      for (const n of existingRun.nodes) {
        if (n.status === "skipped") continue;
        (this.scope.steps as Record<string, unknown>)[n.id] = {
          output: n.output ?? "",
          ok: n.status === "ok",
          approved: n.approved,
          spent_usd: n.spentUsd,
        };
      }
      for (const n of existingRun.nodes) {
        if (typeof n.spentUsd === "number") this.spentKnown += n.spentUsd;
      }
    } else {
      this.run = {
        id: newWorkflowRunId(),
        workflow: def.name,
        status: "running",
        inputs,
        definition: def,
        nodes: [],
        spentUsd: null,
        startedAt: nowIso(),
        endedAt: null,
        dryRun: opts.dryRun ?? false,
        trial: opts.trial ?? false,
        error: null,
        pendingNodeId: null,
        pendingNodeIndex: null,
        pendingInterruptId: null,
        reviewItemId: null,
        dryRunPlanHash: null,
        coordinator: null,
      };
    }
    // 协调者运行态：fixed 为 null；续跑时从已有运行记录里恢复（轮数、动态步骤、
    // 决策记录都不丢），新运行从空状态起步。run.coordinator 与 coordState 是
    // 同一个对象引用，saveRun 直接把它写进账本。
    if (def.mode === "fixed") {
      this.coordState = null;
      this.run.coordinator = null;
    } else if (existingRun) {
      this.coordState = existingRun.coordinator ?? newCoordinatorState();
      this.run.coordinator = this.coordState;
    } else {
      this.coordState = newCoordinatorState();
      this.run.coordinator = this.coordState;
    }
    const storeRun = this.store.create(`工作流 ${def.name}`, `workflow-${this.run.id}`, this.workdir, this.mode, 1);
    this.storeRunId = storeRun.run_id;
  }

  emit(type: string, fields: Record<string, unknown>): void {
    try {
      this.store.appendEvent(this.storeRunId, type, { ...fields, workflow_run_id: this.run.id, workflow: this.def.name });
    } catch { /* 事件写失败不破坏运行 */ }
  }

  saveRun(): void {
    try { saveWorkflowRun(this.home, this.run); } catch { /* 账本写失败不破坏运行，结束时再报 */ }
  }

  async getProvider(): Promise<ProviderLike> {
    if (this.providerCache) return this.providerCache;
    if (!this.providerFactory) {
      throw new WorkflowError("这个工作流有模型节点（llm / delegate / skill），但没有可用的模型 provider：先配好模型再跑");
    }
    this.providerCache = await this.providerFactory();
    return this.providerCache;
  }

  /** 模型节点前重判月度硬顶（与 Agent 同口径：按下界判定，只会晚触发、不会误触发）。 */
  checkMonthlyCapOrThrow(): void {
    if (this.monthlyLimit === null) return;
    const before = this.ledger.monthTotal(monthKeyString(new Date())).spentUsd;
    const check = checkMonthlyCap(before, this.spentKnown, this.monthlyLimit);
    if (check.exceeded && check.monthSpentUsd !== null) {
      throw new WorkflowError(`月度成本上限已超：本月已花 $${check.monthSpentUsd.toFixed(4)}（上限 $${this.monthlyLimit.toFixed(2)}），运行已中止`);
    }
  }

  /** 每节点后重判 --max-cost（只对已知金额生效；未知金额不假装封顶）。 */
  checkMaxCostOrThrow(): void {
    if (this.maxCostUsd !== null && this.spentKnown > this.maxCostUsd) {
      throw new WorkflowError(`成本上限已超：本次运行已花 $${this.spentKnown.toFixed(4)}（上限 $${this.maxCostUsd.toFixed(2)}），运行已中止`);
    }
  }

  pricingFor(provider: ProviderLike): Pricing | null {
    return resolvePricing(this.config.pricing, (provider as { model?: string | null }).model ?? null);
  }

  /**
   * 记一个节点：进运行账本（输入/输出/耗时/成本全留）+ runs 事件（workflow_node，
   * 时间线可看）+ scope（供后续步骤模板/条件用）。这就是节点级证据链——
   * 账本在 ~/.nyra/workflow-runs.json，事件在 runs/<运行>/events.jsonl，
   * `nyra workflow show <运行 id>` 能逐节点回看。不用 EvidenceStore：
   * 那是网页取证（save(kind, url, content)）用的，工作流节点证据不往那塞。
   */
  recordNode(result: WorkflowNodeResult): void {
    this.run.nodes.push(result);
    (this.scope.steps as Record<string, unknown>)[result.id] = {
      output: result.output ?? "",
      ok: result.status === "ok",
      approved: result.approved,
      spent_usd: result.spentUsd,
    };
    if (typeof result.spentUsd === "number") this.spentKnown += result.spentUsd;
    this.emit("workflow_node", {
      node_id: result.id,
      node_type: result.type,
      status: result.status,
      ms: result.ms,
      spent_usd: result.spentUsd,
    });
    this.saveRun();
    this.recordStepCheckpoint(result);
    this.checkMaxCostOrThrow();
  }

  /**
   * G-P1-40：每节点跑完记一条步级检查点（状态快照 + 输入指纹 + 输出摘要）。
   * 检查点写失败绝不破坏运行（静默跳过——检查点是“能回放就回放”的能力，
   * 不是运行正确性的前提；缺了它只是那一步没法时间旅行）。
   * 远端后端在运行里是 best-effort（fire-and-forget，CLI 操作才 await）。
   */
  private recordStepCheckpoint(result: WorkflowNodeResult): void {
    try {
      const baseId = result.id.replace(/\[\d+\]$/, "");
      const stepIndex = this.def.steps.findIndex((s) => s.id === baseId);
      const cp = buildStepCheckpoint({
        runId: this.run.id,
        workflow: this.def.name,
        node: result,
        stepIndex: stepIndex >= 0 ? stepIndex : 0,
        stepsState: snapshotStepsState(this.scope.steps as Record<string, { output?: unknown; ok?: unknown }>),
      });
      const store = this.stepCheckpointStore;
      if (store.saveSync && store.loadSync) {
        const list = store.loadSync(this.run.id);
        store.saveSync(this.run.id, upsertCheckpoint(list, cp));
      } else {
        void (async () => {
          const list = await store.load(this.run.id);
          await store.save(this.run.id, upsertCheckpoint(list, cp));
        })().catch(() => { /* 远端检查点写失败不破坏运行 */ });
      }
    } catch { /* 检查点写失败不破坏运行 */ }
  }

  async executeStep(step: WorkflowStep, parallelDepth: number, forEachDepth: number): Promise<WorkflowNodeResult> {
    if (step.if !== undefined) {
      let cond: boolean;
      try {
        cond = evalCondition(step.if, this.scope);
      } catch (err: unknown) {
        throw new WorkflowError(`步骤 ${step.id} 的 if 求值出错：${err instanceof Error ? err.message : String(err)}`);
      }
      if (!cond) {
        const skipped: WorkflowNodeResult = {
          id: step.id, type: step.type, status: "skipped",
          startedAt: nowIso(), endedAt: nowIso(), ms: 0,
          input: step.if, output: "if 条件为假，跳过", approved: null, spentUsd: null, error: null,
        };
        this.recordNode(skipped);
        return skipped;
      }
    }
    if (step.for_each !== undefined) {
      if (forEachDepth >= 3) {
        throw new WorkflowError(`步骤 ${step.id}：循环嵌套超过 3 层（G-5 硬深度上限）`);
      }
      if (step.type === "approve") {
        throw new WorkflowError(`步骤 ${step.id}：审批节点不支持放在循环里（本批限制）`);
      }
      const itemsRaw0 = renderTemplate(step.for_each.items, this.scope);
      // items 可以是 JSON 数组文本（上游工具节点输出的 JSON 数组）——
      // inputs 只认标量、节点输出是字符串，循环否则永远拿不到数组。
      let itemsRaw: unknown = itemsRaw0;
      if (typeof itemsRaw0 === "string") {
        try {
          const parsed: unknown = JSON.parse(itemsRaw0);
          if (Array.isArray(parsed)) itemsRaw = parsed;
        } catch { /* 不是 JSON 数组，按原值走下面的“不是数组”报错 */ }
      }
      if (!Array.isArray(itemsRaw)) {
        throw new WorkflowError(`步骤 ${step.id}：for_each.items 求值后不是数组（要数组本身，或 JSON 数组文本）`);
      }
      const max = step.for_each.max ?? DEFAULT_LOOP_ITERATIONS;
      if (itemsRaw.length > max) {
        throw new WorkflowError(`步骤 ${step.id}：循环 ${itemsRaw.length} 次超过上限 ${max} 次（for_each.max），拒绝静默截断`);
      }
      if (itemsRaw.length === 0) {
        const empty: WorkflowNodeResult = {
          id: step.id, type: step.type, status: "skipped",
          startedAt: nowIso(), endedAt: nowIso(), ms: 0,
          input: step.for_each.items, output: "for_each 列表为空，跳过", approved: null, spentUsd: null, error: null,
        };
        this.recordNode(empty);
        return empty;
      }
      const startedAt = nowIso();
      const startMs = Date.now();
      const outputs: string[] = [];
      let spent: number | null = 0;
      let anyFailed = false;
      let failError: string | null = null;
      for (let i = 0; i < itemsRaw.length; i++) {
        (this.scope.loop as Record<string, unknown>)[step.for_each.as] = itemsRaw[i] as ScopeValue;
        (this.scope.loop as Record<string, unknown>).index = i;
        const inner: WorkflowStep = { ...step };
        delete (inner as Partial<WorkflowStep>).for_each;
        delete (inner as Partial<WorkflowStep>).if;
        try {
          // record=false：轮次内不重复记账，只记下面这一条带 [i] 后缀的轮次记录。
          const r = await this.executeStepInner(inner, parallelDepth, forEachDepth + 1, false);
          const iterResult: WorkflowNodeResult = { ...r, id: `${step.id}[${i}]` };
          this.recordNode(iterResult);
          outputs.push(r.output ?? "");
          if (typeof r.spentUsd === "number") spent = (spent ?? 0) + r.spentUsd;
          else spent = null;
          if (r.status === "failed") { anyFailed = true; failError = r.error; break; }
        } catch (err: unknown) {
          if (err instanceof WorkflowPendingApproval) throw err;
          anyFailed = true;
          failError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      delete (this.scope.loop as Record<string, unknown>)[step.for_each.as];
      delete (this.scope.loop as Record<string, unknown>).index;
      const combined: WorkflowNodeResult = {
        id: step.id, type: step.type,
        status: anyFailed ? "failed" : "ok",
        startedAt, endedAt: nowIso(), ms: Date.now() - startMs,
        input: step.for_each.items,
        output: outputs.length > 1 ? JSON.stringify(outputs) : (outputs[0] ?? ""),
        approved: null, spentUsd: spent, error: failError,
      };
      // 合并节点只进账本与事件，不走 recordNode：各轮次已记过账，
      // 合并节点的 spentUsd 是轮次之和，再加会 double-count。
      this.run.nodes.push(combined);
      (this.scope.steps as Record<string, unknown>)[step.id] = {
        output: combined.output ?? "",
        ok: combined.status === "ok",
        approved: null,
        spent_usd: combined.spentUsd,
      };
      this.emit("workflow_node", { node_id: step.id, node_type: step.type, status: combined.status, ms: combined.ms, spent_usd: combined.spentUsd });
      this.saveRun();
      this.checkMaxCostOrThrow();
      if (anyFailed) throw new WorkflowError(failError ?? `步骤 ${step.id} 在循环中失败`);
      return combined;
    }
    return this.executeStepInner(step, parallelDepth, forEachDepth);
  }

  async executeStepInner(step: WorkflowStep, parallelDepth: number, forEachDepth: number, record = true): Promise<WorkflowNodeResult> {
    const startedAt = nowIso();
    const startMs = Date.now();
    const finish = (partial: Omit<WorkflowNodeResult, "startedAt" | "endedAt" | "ms" | "input">, input: string): WorkflowNodeResult => ({
      ...partial,
      input: input.length > MAX_OUTPUT_CHARS ? input.slice(0, MAX_OUTPUT_CHARS) + "\n…（输入过长，已截断）" : input,
      startedAt, endedAt: nowIso(), ms: Date.now() - startMs,
    });
    const recordIf = (result: WorkflowNodeResult): void => {
      if (record) this.recordNode(result);
    };
    try {
      if (step.type === "tool") {
        const args = renderValue(step.args ?? {}, this.scope) as Record<string, unknown>;
        // G-P1-41：edit 决定带的输入覆盖（续跑前已按步骤类型校验过）。
        const toolOverrides = this.stepInputOverrides.get(step.id);
        if (toolOverrides) {
          for (const [k, v] of Object.entries(toolOverrides)) {
            if (!(k in args)) throw new WorkflowError(`步骤 ${step.id}：edit 覆盖的键 ${k} 不在 tool 参数里`);
            args[k] = v;
          }
        }
        const { executeTool, newToolContext } = await import("./tools.ts");
        const ctx = newToolContext({
          workdir: this.workdir, home: this.home, mode: this.mode,
          interactive: this.interactive,
          memoryPath: join(this.home, "memory"),
          skillsDir: join(this.home, "skills"),
          // Pi Bot 借鉴第 1 条：工作流步骤跑在例行上下文里——shell 步骤的
          // 纯脚本快路径与摘要预授权靠 routineId 生效；判定事件只把脚本
          // 相关的两类转进本次运行的证据链，别的审批事件不往工作流事件里塞。
          routineId: workflowRoutineId(this.def.name),
          routineStepId: step.id,
          onEvent: (type, fields) => {
            if (type === "script_pure" || type === "script_preauth_used") this.emit(type, fields);
          },
        });
        const out = await executeTool(step.tool ?? "", args, ctx);
        // 失败判定按 Nyra 全仓惯例：工具返回文本以“错误：”/“执行失败：”开头
        // 即失败（consoleUi / gateway / jsonMode / repeatGuard / runs.ts 同口径），
        // 不把报错文本当成功输出往下传。边界与全仓一致：文件内容本身以“错误：”
        // 开头时会被误判为失败——读这类文件时先用 shell 等工具确认内容。
        if (out.startsWith("错误：") || out.startsWith("执行失败：")) {
          throw new WorkflowError(out.slice(0, 500));
        }
        const result = finish({ id: step.id, type: "tool", status: "ok", output: truncateOutput(out), approved: null, spentUsd: null, error: null }, stableStringify(args));
        recordIf(result);
        return result;
      }
      if (step.type === "llm") {
        this.checkMonthlyCapOrThrow();
        const provider = await this.getProvider();
        // G-P1-41：edit 决定可改 prompt / system。
        const llmOverrides = this.stepInputOverrides.get(step.id);
        const prompt = llmOverrides?.prompt !== undefined ? String(llmOverrides.prompt) : String(renderTemplate(step.prompt ?? "", this.scope));
        const messages: ChatMessage[] = [];
        if (step.system) messages.push({ role: "system", content: llmOverrides?.system !== undefined ? String(llmOverrides.system) : String(renderTemplate(step.system, this.scope)) });
        messages.push({ role: "user", content: prompt });
        const resp = await provider.chat(messages);
        const text = extractChatText(resp);
        const usage = extractChatUsage(resp);
        const pricing = this.pricingFor(provider);
        const spent = pricing ? computeCostUsd(usage.prompt, usage.completion, pricing) : null;
        if (usage.prompt !== null || usage.completion !== null) {
          this.ledger.recordDelta(
            { calls: 1, reported_calls: 1, missing_calls: 0, prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: (usage.prompt ?? 0) + (usage.completion ?? 0), prompt_samples: 1, completion_samples: 1, total_samples: 1, last_prompt_tokens: usage.prompt, context_window_tokens: null, context_window_source: "unknown", context_window_model: null, context_remaining_tokens: null },
            null, spent, null, (provider as { model?: string | null }).model ?? null, new Date(), "workflow",
          );
        }
        const result = finish({ id: step.id, type: "llm", status: "ok", output: truncateOutput(text), approved: null, spentUsd: spent, error: null }, prompt);
        recordIf(result);
        return result;
      }
      if (step.type === "delegate" || step.type === "skill") {
        this.checkMonthlyCapOrThrow();
        const provider = await this.getProvider();
        const { Agent } = await import("./agent.ts");
        let task: string;
        // G-P1-41：edit 决定可改 task（skill 步骤改的是任务文本部分）。
        const dlOverrides = this.stepInputOverrides.get(step.id);
        const taskText = dlOverrides?.task !== undefined ? String(dlOverrides.task) : String(renderTemplate(step.task ?? "", this.scope));
        const maxTurns = (dlOverrides?.max_turns as number | undefined) ?? step.max_turns ?? 6;
        if (step.type === "skill") {
          const { loadSkills, readSkillBody, canonicalSkillDirs } = await import("./skills.ts");
          const skills = loadSkills(canonicalSkillDirs(this.workdir, this.home));
          const skillBody = readSkillBody(skills, step.skill ?? "");
          task = `${skillBody}\n\n任务：${taskText}`;
        } else {
          task = taskText;
        }
        const agent = new Agent(provider, {
          workdir: this.workdir, mode: this.mode, maxTurns,
          sessionId: `wf-${this.run.id}`, messages: [], interactive: false,
          home: this.home, reviewerModel: undefined,
        });
        const before = agent.usage.snapshot();
        const d = await agent.delegateDetailed(task, maxTurns);
        if (!d.ok) throw new WorkflowError(d.text.slice(0, 500));
        const text = d.text;
        const after = agent.usage.snapshot();
        const inTok = (after.prompt_tokens ?? 0) - (before.prompt_tokens ?? 0);
        const outTok = (after.completion_tokens ?? 0) - (before.completion_tokens ?? 0);
        const pricing = this.pricingFor(provider);
        // 成本优先用子任务自己算的 spentUsd（与它内部的计价同源）；没算出来
        // 时再按 token 差值与工作流的单价表算，算不出记 null、不编数字。
        const spent = d.spentUsd ?? (pricing && (inTok > 0 || outTok > 0) ? computeCostUsd(inTok, outTok, pricing) : null);
        if (inTok > 0 || outTok > 0) {
          this.ledger.recordDelta(after, before, spent, null, (provider as { model?: string | null }).model ?? null, new Date(), "workflow");
        }
        const result = finish({ id: step.id, type: step.type, status: "ok", output: truncateOutput(text), approved: null, spentUsd: spent, error: null }, step.type === "skill" ? `${step.skill}\n${taskText}` : task);
        recordIf(result);
        return result;
      }
      if (step.type === "knowledge") {
        const { KnowledgeBase } = await import("./knowledge.ts");
        const kb = new KnowledgeBase(join(this.home, "knowledge"));
        // G-P1-41：edit 决定可改 base / query / top_k。
        const kbOverrides = this.stepInputOverrides.get(step.id);
        const baseName = kbOverrides?.base !== undefined ? String(kbOverrides.base) : (step.base ?? "");
        const query = kbOverrides?.query !== undefined ? String(kbOverrides.query) : String(renderTemplate(step.query ?? "", this.scope));
        const topK = (kbOverrides?.top_k as number | undefined) ?? step.top_k ?? 5;
        if (!kb.exists(baseName)) {
          throw new WorkflowError(`知识库不存在：${baseName}（先 nyra kb create ${baseName}，再 nyra kb add ${baseName} --text ... 写入）`);
        }
        const hits = kb.search(baseName, query, topK);
        const output = hits.length
          ? hits.map(([score, note]) => `[${score.toFixed(2)}] ${note.title}\n${note.text.slice(0, 500)}`).join("\n\n")
          : "知识库里没找到相关内容。";
        const result = finish({ id: step.id, type: "knowledge", status: "ok", output: truncateOutput(output), approved: null, spentUsd: null, error: null }, query);
        recordIf(result);
        return result;
      }
      if (step.type === "approve") {
        const title = String(renderTemplate(step.title ?? "", this.scope));
        const summary = step.summary ? String(renderTemplate(step.summary, this.scope)) : "";
        const { item } = enqueueReviewItem(this.home, {
          source: "automation",
          title: `工作流 ${this.def.name} 审批：${title}`.slice(0, 200),
          summary: summary || "人工批复后继续跑，拒绝按 on_reject 处理。",
          runId: `workflow-${this.run.id}`,
          sessionId: `workflow-${this.run.id}`,
          workdir: this.workdir,
        });
        throw new WorkflowPendingApproval(item.id, step.id, -1);
      }
      if (step.type === "parallel") {
        if (parallelDepth >= MAX_PARALLEL_DEPTH) {
          throw new WorkflowError(`步骤 ${step.id}：并行嵌套超过 ${MAX_PARALLEL_DEPTH} 层`);
        }
        const branchResults: WorkflowNodeResult[][] = [];
        const settled = await Promise.allSettled(
          (step.branches ?? []).map(async (branch) => {
            const results: WorkflowNodeResult[] = [];
            for (const sub of branch) {
              results.push(await this.executeStep(sub, parallelDepth + 1, forEachDepth));
            }
            return results;
          }),
        );
        let failed: WorkflowNodeResult | null = null;
        for (const s of settled) {
          if (s.status === "fulfilled") branchResults.push(s.value);
          else {
            const err = s.reason as unknown;
            if (err instanceof WorkflowPendingApproval) throw err;
            failed = finish({ id: step.id, type: "parallel", status: "failed", output: null, approved: null, spentUsd: null, error: err instanceof Error ? err.message : String(err) }, `parallel ${step.branches?.length ?? 0} 个分支`);
          }
        }
        if (failed) {
          recordIf(failed);
          throw new WorkflowError(failed.error ?? `步骤 ${step.id} 的并行分支失败`);
        }
        const branchOutputs = branchResults.map((rs) => rs.map((r) => r.output ?? "").join("\n")).join("\n");
        const result = finish({ id: step.id, type: "parallel", status: "ok", output: truncateOutput(branchOutputs), approved: null, spentUsd: null, error: null }, `parallel ${step.branches?.length ?? 0} 个分支`);
        recordIf(result);
        return result;
      }
      throw new WorkflowError(`步骤 ${step.id}：未知的节点类型`);
    } catch (err: unknown) {
      if (err instanceof WorkflowPendingApproval) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const failed = finish({ id: step.id, type: step.type, status: "failed", output: null, approved: null, spentUsd: null, error: message }, step.type === "tool" ? stableStringify(step.args ?? {}) : (step.prompt ?? step.task ?? step.query ?? step.title ?? ""));
      recordIf(failed);
      throw new WorkflowError(message);
    }
  }

  /** 从顶层第 startIndex 步开始跑；跑完返回运行记录。协调者/动态形态不走固定图，走 runCoordinator。 */
  async runFrom(startIndex: number): Promise<WorkflowRun> {
    if (this.def.mode !== "fixed") return this.runCoordinator();
    this.emit("workflow_started", { status: this.run.status, dry_run: this.run.dryRun, trial: this.run.trial });
    try {
      for (let i = startIndex; i < this.def.steps.length; i++) {
        const step = this.def.steps[i];
        try {
          // G-P1-41：配了 interrupt_before 的步骤，跑前先停住等人。
          // if 为假会跳过的步骤不打扰人（executeStep 里同样会跳过）。
          if (!this.willSkipByIf(step)) await this.checkInterruptPoint(step, "before", i);
          const result = await this.executeStep(step, 0, 0);
          // 跑后中断只对成功跑完的步骤生效：跳过/失败的步骤不打扰人
          // （失败的整轮已失败，executeStep 会直接抛错到外层）。
          if (result.status === "ok") await this.checkInterruptPoint(step, "after", i);
        } catch (err: unknown) {
          if (err instanceof WorkflowPendingInterrupt) {
            err.nodeIndex = i;
            this.run.status = "awaiting_interrupt";
            this.run.pendingNodeId = err.stepId;
            this.run.pendingNodeIndex = i;
            this.run.pendingInterruptId = err.interruptId;
            this.run.reviewItemId = null;
            this.saveRun();
            this.emit("workflow_awaiting_interrupt", { node_id: err.stepId, interrupt_id: err.interruptId, point: err.point });
            return this.run;
          }
          if (err instanceof WorkflowPendingApproval) {
            err.nodeIndex = i;
            this.run.status = "awaiting_approval";
            this.run.pendingNodeId = err.nodeId;
            this.run.pendingNodeIndex = i;
            this.run.reviewItemId = err.reviewItemId;
            this.saveRun();
            this.emit("workflow_awaiting_approval", { node_id: err.nodeId, review_item_id: err.reviewItemId });
            return this.run;
          }
          throw err;
        }
      }
      this.run.status = "completed";
      this.run.endedAt = nowIso();
      this.run.spentUsd = this.spentKnown;
      this.saveRun();
      this.emit("workflow_completed", { spent_usd: this.spentKnown, nodes: this.run.nodes.length });
      return this.run;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.run.status = "failed";
      this.run.endedAt = nowIso();
      this.run.error = message;
      this.run.spentUsd = this.spentKnown;
      this.saveRun();
      this.emit("workflow_failed", { error: message.slice(0, 200) });
      return this.run;
    }
  }

  // -------------------------------------------------------------------------
  // G-P1-41：结构化人机回环
  // -------------------------------------------------------------------------

  /** 这个步骤会不会被 if 跳过（会跳过就不打扰人）。if 求值出错时按“不跳过”
   *  算，交给 executeStep 正常报错。 */
  private willSkipByIf(step: WorkflowStep): boolean {
    if (step.if === undefined) return false;
    try {
      return !evalCondition(step.if, this.scope);
    } catch {
      return false;
    }
  }

  /** 步骤前/后的中断点：没配就不停；已回过的直接过；挂起的抛错挂起；
   *  第一次到就建单、记事件、抛错挂起。 */
  private checkInterruptPoint(step: WorkflowStep, point: InterruptPoint, index: number): void {
    const spec = point === "before" ? step.interrupt_before : step.interrupt_after;
    if (!spec) return;
    const existing = findInterrupt(this.home, this.run.id, step.id, point);
    if (existing) {
      if (existing.status === "resolved") return;
      throw new WorkflowPendingInterrupt(existing.id, step.id, point, index);
    }
    const context = point === "before" ? this.renderStepInputSummary(step) : this.lastNodeOutputSummary(step.id);
    const it = createInterrupt(this.home, {
      runId: this.run.id,
      workflow: this.def.name,
      stepId: step.id,
      point,
      prompt: spec.prompt ?? (point === "before"
        ? `步骤 ${step.id}（${step.type}）马上要跑，先看一眼再继续？`
        : `步骤 ${step.id}（${step.type}）跑完了，结果如上，继续还是改一下？`),
      schema: spec.schema ?? { fields: [] },
      contextSummary: context,
    });
    this.emit("workflow_interrupt_created", { interrupt_id: it.id, step_id: step.id, point });
    throw new WorkflowPendingInterrupt(it.id, step.id, point, index);
  }

  /** 跑前中断单里的人看什么：步骤渲染后的输入摘要（≤500 字）。算不出
   *  来就写一句，绝不因摘要失败拦住运行。 */
  private renderStepInputSummary(step: WorkflowStep): string {
    try {
      if (step.type === "tool") return stableStringify(renderValue(step.args ?? {}, this.scope)).slice(0, 500);
      if (step.type === "llm") return String(renderTemplate(step.prompt ?? "", this.scope)).slice(0, 500);
      if (step.type === "delegate" || step.type === "skill") return String(renderTemplate(step.task ?? "", this.scope)).slice(0, 500);
      if (step.type === "knowledge") return String(renderTemplate(step.query ?? "", this.scope)).slice(0, 500);
      if (step.type === "approve") return String(renderTemplate(step.title ?? "", this.scope)).slice(0, 500);
      return `parallel（${step.branches?.length ?? 0} 个分支）`;
    } catch {
      return "（输入摘要算不出来）";
    }
  }

  private lastNodeOutputSummary(stepId: string): string {
    const node = [...this.run.nodes].reverse().find((n) => n.id === stepId);
    if (!node) return "（无输出）";
    return (node.output ?? "（无输出）").slice(0, 500);
  }

  /** after 点 edit：把该步在 scope 里的输出与节点记录改成新值，并同步步级
   *  检查点（有检查点时走 updateStepState；检查点写失败不拦续跑）。
   *  公开方法：模块级的 resumeWorkflowFromInterrupt 要调它。 */
  applyAfterPointEdit(stepId: string, output: string): void {
    const scopeStep = (this.scope.steps as Record<string, unknown>)[stepId];
    if (scopeStep && typeof scopeStep === "object") {
      (scopeStep as Record<string, unknown>).output = output;
    }
    const node = [...this.run.nodes].reverse().find((n) => n.id === stepId);
    if (node) node.output = truncateOutput(output);
    try {
      updateStepState(this.stepCheckpointStore, this.run.id, stepId, { [`steps.${stepId}.output`]: output });
    } catch { /* 检查点同步失败不拦续跑 */ }
  }

  // -------------------------------------------------------------------------
  // 协调者循环（G-5 第二、三种形态：coordinator / dynamic）
  //
  // 每轮只调一次模型做决定（不是 agent 自由发挥）：提示词里只列“当前可执行
  // 的步骤”（if 已用确定性求值筛过，不把简单判断交给模型），模型只回一个
  // JSON 决定——run（跑一个可执行步骤）/ new_step（生成一个新步骤并马上跑）
  // / finish（目标达成）/ ask（缺关键信息，停下来问人）。决定本身进账本与
  // 事件（workflow_coordinator_decision），是“协调者当时怎么想的”的证据。
  //
  // 硬上限（超了即停，不循环烧钱）：轮数（max_rounds，默认 10、上限 20）、
  // 新步骤数（max_new_steps，默认 coordinator 3 / dynamic 5、上限 10）、
  // 每步骤执行次数（3 次）、连续坏决定数（2 次）、已执行节点总数（50 个）。
  // 审批节点一轮只跑一次（批了就过了，拒了按 on_reject 走，不会反复问）。
  // 协调者每轮的决策调用也按实报 usage 计价进月度账本、算进 --max-cost。
  // -------------------------------------------------------------------------

  coordinatorRound(): number {
    return this.coordState?.round ?? 0;
  }

  private stepOneLine(step: WorkflowStep): string {
    if (step.type === "tool") return `tool ${step.tool ?? ""}`;
    if (step.type === "llm") return `llm：${(step.prompt ?? "").slice(0, 60)}`;
    if (step.type === "delegate") return `delegate：${(step.task ?? "").slice(0, 60)}`;
    if (step.type === "skill") return `skill ${step.skill ?? ""}：${(step.task ?? "").slice(0, 60)}`;
    if (step.type === "knowledge") return `知识检索 ${step.base ?? ""}：${(step.query ?? "").slice(0, 60)}`;
    if (step.type === "approve") return `审批：${step.title ?? ""}`;
    return `parallel（${step.branches?.length ?? 0} 个分支）`;
  }

  /** 当前可执行的步骤：if 用确定性求值筛过（条件暂时算不出来的先不列，等依赖
   *  跑完再说），每步骤最多跑 3 次，审批节点一轮只跑一次。 */
  private eligibleCoordinatorSteps(): WorkflowStep[] {
    const state = this.coordState!;
    const out: WorkflowStep[] = [];
    for (const s of this.def.steps) {
      if ((state.runCounts[s.id] ?? 0) >= MAX_STEP_RUNS) continue;
      if (s.type === "approve" && state.executed.includes(s.id)) continue;
      if (s.if !== undefined) {
        let cond: boolean;
        try {
          cond = evalCondition(s.if, this.scope);
        } catch {
          continue;
        }
        if (!cond) continue;
      }
      out.push(s);
    }
    return out;
  }

  private coordinatorPrompt(eligible: WorkflowStep[]): { system: string; user: string } {
    const state = this.coordState!;
    const maxRounds = resolveMaxRounds(this.def);
    const maxNew = resolveMaxNewSteps(this.def);
    const newLeft = maxNew - state.dynamicSteps.length;
    const system = [
      "你是工作流协调者：按目标一步步推进，每轮只做一个决定。",
      "只回一个 JSON 对象，不要写别的字。动作四选一：",
      '{"action":"run","step":"<步骤 id>"}——跑一个下面列出的可执行步骤；',
      '{"action":"new_step","step":{...}}——生成一个新步骤并马上跑它（type 只认 tool / llm / delegate / knowledge / skill；id 小写字母开头、不超过 32 字、不能与已有步骤重名；tool 必须是 Nyra 已有的工具名；不能是审批节点）；',
      '{"action":"finish","summary":"<一句话总结>"}——目标已达成，结束；',
      '{"action":"ask","question":"<要问人的问题>"}——缺关键信息，停下来问人（人批了继续，拒了整轮失败）。',
      "不要编步骤 id，不要选没列出的步骤；目标没达成不要 finish。",
    ].join("\n");
    const lines: string[] = [];
    lines.push(`目标：${this.def.goal ?? ""}`);
    lines.push(`第 ${state.round + 1} / ${maxRounds} 轮；还能生成 ${newLeft} 个新步骤；每步骤最多跑 ${MAX_STEP_RUNS} 次。`);
    lines.push("可执行的步骤：");
    if (!eligible.length) lines.push("- （当前没有可执行的步骤；可以生成新步骤，或 finish，或 ask）");
    for (const s of eligible) {
      lines.push(`- ${s.id}（${s.type}）：${this.stepOneLine(s)}${state.runCounts[s.id] ? `，已跑 ${state.runCounts[s.id]} 次` : ""}`);
    }
    lines.push("已完成的步骤：");
    if (!state.executed.length) lines.push("- （无）");
    for (const id of state.executed) {
      const node = [...this.run.nodes].reverse().find((n) => n.id === id || n.id.startsWith(`${id}[`));
      lines.push(`- ${id}：${node?.status ?? "?"}${node?.output ? `，输出：${node.output.slice(0, 500)}` : ""}`);
    }
    lines.push(`已花 $${this.spentKnown.toFixed(4)}（上限 ${this.maxCostUsd !== null ? `$${this.maxCostUsd.toFixed(2)}` : "未设"}）。`);
    return { system, user: lines.join("\n") };
  }

  private parseCoordinatorDecision(text: string, round: number): CoordinatorDecisionParsed {
    let json = text.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(json);
    if (fenced) json = fenced[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new WorkflowError(`协调者第 ${round} 轮的决定不是合法 JSON（只回一个 JSON 对象）：${text.slice(0, 200)}`);
    }
    if (!isObj(parsed)) throw new WorkflowError(`协调者第 ${round} 轮的决定不是 JSON 对象`);
    const action = parsed.action;
    if (action === "run") {
      if (typeof parsed.step !== "string" || !STEP_ID_RE.test(parsed.step)) {
        throw new WorkflowError(`协调者第 ${round} 轮的 run 决定没给合法的步骤 id`);
      }
      return { action, stepId: parsed.step };
    }
    if (action === "new_step") {
      if (!isObj(parsed.step)) throw new WorkflowError(`协调者第 ${round} 轮的 new_step 决定没给步骤对象`);
      return { action, step: parsed.step as unknown as WorkflowStep };
    }
    if (action === "finish") {
      if (typeof parsed.summary !== "string" || !parsed.summary.trim() || parsed.summary.length > MAX_GOAL_CHARS) {
        throw new WorkflowError(`协调者第 ${round} 轮的 finish 决定须给 1–${MAX_GOAL_CHARS} 字的总结`);
      }
      return { action, summary: parsed.summary };
    }
    if (action === "ask") {
      if (typeof parsed.question !== "string" || !parsed.question.trim() || parsed.question.length > MAX_GOAL_CHARS) {
        throw new WorkflowError(`协调者第 ${round} 轮的 ask 决定须给 1–${MAX_GOAL_CHARS} 字的问题`);
      }
      return { action, question: parsed.question };
    }
    throw new WorkflowError(`协调者第 ${round} 轮的决定不认动作 ${String(action)}（只认 run / new_step / finish / ask）`);
  }

  private async validateCoordinatorDecision(decision: CoordinatorDecisionParsed, eligible: WorkflowStep[], round: number): Promise<void> {
    const state = this.coordState!;
    if (decision.action === "run") {
      const id = decision.stepId!;
      if (eligible.some((s) => s.id === id)) return;
      if (this.def.steps.some((s) => s.id === id)) {
        throw new WorkflowError(`协调者第 ${round} 轮想跑步骤 ${id}，但它当前不可执行（条件为假，或已跑满 ${MAX_STEP_RUNS} 次，或审批节点已跑过）`);
      }
      throw new WorkflowError(`协调者第 ${round} 轮想跑步骤 ${id}，但没有这个步骤`);
    }
    if (decision.action === "new_step") {
      const maxNew = resolveMaxNewSteps(this.def);
      if (state.dynamicSteps.length >= maxNew) {
        throw new WorkflowError(`协调者第 ${round} 轮想生成新步骤，但新步骤额度已用完（max_new_steps=${maxNew}）`);
      }
      const tools = await this.getKnownTools();
      const ids = new Set(this.def.steps.map((s) => s.id));
      validateStep(decision.step, `第 ${round} 轮动态步骤`, 0, ids, tools, true);
    }
  }

  private async getKnownTools(): Promise<Set<string>> {
    if (this.knownTools) return this.knownTools;
    const { TOOL_SCHEMAS } = await import("./tools.ts");
    this.knownTools = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));
    return this.knownTools;
  }

  /** 协调者每轮一次模型调用：决定本身也按实报 usage 计价进月度账本、算进 --max-cost。 */
  private async callCoordinator(eligible: WorkflowStep[]): Promise<{ text: string; spent: number | null }> {
    this.checkMonthlyCapOrThrow();
    const provider = await this.getProvider();
    const { system, user } = this.coordinatorPrompt(eligible);
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const resp = await provider.chat(messages);
    const text = extractChatText(resp);
    const usage = extractChatUsage(resp);
    const pricing = this.pricingFor(provider);
    const spent = pricing ? computeCostUsd(usage.prompt, usage.completion, pricing) : null;
    if (usage.prompt !== null || usage.completion !== null) {
      this.ledger.recordDelta(
        { calls: 1, reported_calls: 1, missing_calls: 0, prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: (usage.prompt ?? 0) + (usage.completion ?? 0), prompt_samples: 1, completion_samples: 1, total_samples: 1, last_prompt_tokens: usage.prompt, context_window_tokens: null, context_window_source: "unknown", context_window_model: null, context_remaining_tokens: null },
        null, spent, null, (provider as { model?: string | null }).model ?? null, new Date(), "workflow",
      );
    }
    if (typeof spent === "number") this.spentKnown += spent;
    return { text, spent };
  }

  async runCoordinator(): Promise<WorkflowRun> {
    const state = this.coordState!;
    this.emit("workflow_started", { status: this.run.status, dry_run: this.run.dryRun, trial: this.run.trial });
    try {
      for (;;) {
        const round = state.round + 1;
        if (state.round >= resolveMaxRounds(this.def)) {
          throw new WorkflowError(`协调者轮数用完（max_rounds=${resolveMaxRounds(this.def)}），目标还没达成`);
        }
        if (this.run.nodes.length >= MAX_STEPS) {
          throw new WorkflowError(`已执行节点超过 ${MAX_STEPS} 个，停止（防失控）`);
        }
        state.round = round;
        const eligible = this.eligibleCoordinatorSteps();
        const { text, spent } = await this.callCoordinator(eligible);
        let decision: CoordinatorDecisionParsed | null = null;
        let decisionError: string | null = null;
        try {
          decision = this.parseCoordinatorDecision(text, round);
          await this.validateCoordinatorDecision(decision, eligible, round);
        } catch (err: unknown) {
          decisionError = err instanceof Error ? err.message : String(err);
        }
        if (decision === null || decisionError !== null) {
          state.decisions.push({ round, action: "invalid", ok: false, error: decisionError, spent_usd: spent });
          this.emit("workflow_coordinator_decision", { round, action: "invalid", step: null, spent_usd: spent });
          this.saveRun();
          this.badDecisions++;
          this.checkMaxCostOrThrow();
          if (this.badDecisions >= MAX_BAD_DECISIONS) {
            throw new WorkflowError(`协调者连续 ${MAX_BAD_DECISIONS} 次决定无法执行（最近一次：${decisionError}），运行已中止`);
          }
          continue;
        }
        this.badDecisions = 0;
        const stepId = decision.action === "run" ? decision.stepId! : decision.action === "new_step" ? (decision.step as WorkflowStep).id : undefined;
        state.decisions.push({
          round,
          action: decision.action,
          ...(stepId ? { step: stepId } : {}),
          ...(decision.action === "finish" ? { summary: decision.summary } : {}),
          ...(decision.action === "ask" ? { summary: decision.question } : {}),
          ok: true,
          error: null,
          spent_usd: spent,
        });
        this.emit("workflow_coordinator_decision", { round, action: decision.action, step: stepId ?? null, spent_usd: spent });
        this.saveRun();
        this.checkMaxCostOrThrow();
        if (decision.action === "finish") {
          this.run.status = "completed";
          this.run.endedAt = nowIso();
          this.run.spentUsd = this.spentKnown;
          this.saveRun();
          this.emit("workflow_completed", { spent_usd: this.spentKnown, nodes: this.run.nodes.length });
          return this.run;
        }
        if (decision.action === "ask") {
          const question = decision.question!;
          const { item } = enqueueReviewItem(this.home, {
            source: "automation",
            title: `工作流 ${this.def.name} 提问：${question.slice(0, 200)}`,
            summary: question,
            runId: `workflow-${this.run.id}`,
            sessionId: `workflow-${this.run.id}`,
            workdir: this.workdir,
          });
          this.emit("workflow_coordinator_ask", { round, review_item_id: item.id });
          throw new WorkflowPendingApproval(item.id, ASK_NODE_ID, -1);
        }
        if (decision.action === "new_step") {
          const step = decision.step as WorkflowStep;
          state.dynamicSteps.push(step);
          // 动态步骤追加进定义快照：续跑与 show 都能看到它；校验时已确认 id 不重复。
          this.def.steps.push(step);
          this.emit("workflow_dynamic_step", { step_id: step.id, step_type: step.type });
        }
        const step = decision.action === "run"
          ? eligible.find((s) => s.id === decision.stepId)!
          : (decision.step as WorkflowStep);
        state.executed.push(step.id);
        state.runCounts[step.id] = (state.runCounts[step.id] ?? 0) + 1;
        this.saveRun();
        await this.executeStep(step, 0, 0);
      }
    } catch (err: unknown) {
      if (err instanceof WorkflowPendingApproval) {
        this.run.status = "awaiting_approval";
        if (err.nodeId === ASK_NODE_ID) {
          this.run.pendingNodeId = ASK_NODE_ID;
          this.run.pendingNodeIndex = -1;
        } else {
          this.run.pendingNodeId = err.nodeId;
          this.run.pendingNodeIndex = this.def.steps.findIndex((s) => s.id === err.nodeId);
        }
        this.run.reviewItemId = err.reviewItemId;
        this.saveRun();
        this.emit("workflow_awaiting_approval", { node_id: err.nodeId, review_item_id: err.reviewItemId });
        return this.run;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.run.status = "failed";
      this.run.endedAt = nowIso();
      this.run.error = message;
      this.run.spentUsd = this.spentKnown;
      this.saveRun();
      this.emit("workflow_failed", { error: message.slice(0, 200) });
      return this.run;
    }
  }
}

// ---------------------------------------------------------------------------
// 管理：import / run / dry-run / resume / trial / activate / remove / verify
// ---------------------------------------------------------------------------

export interface WorkflowRunRequest {
  workdir: string;
  mode: "normal" | "readonly";
  interactive: boolean;
  maxCostUsd?: number;
  providerFactory?: () => Promise<ProviderLike>;
  /** 步级检查点 store（G-P1-40；测试传内存 store，不传默认按配置解析）。 */
  stepCheckpointStore?: StepCheckpointStore;
}

/** 模型 provider 懒加载：只有跑到 llm / delegate / skill 节点时才建（buildProvider 在 tasks.ts）。 */
function defaultProviderFactory(home: string): () => Promise<ProviderLike> {
  let cached: ProviderLike | null = null;
  return async () => {
    if (cached) return cached;
    const { buildProvider } = await import("./tasks.ts");
    const [provider] = buildProvider(loadConfig(home), home);
    cached = provider as unknown as ProviderLike;
    return cached;
  };
}

export async function importWorkflow(home: string, filePath: string): Promise<{ name: string; file: string }> {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) {
    throw new WorkflowError(`导入失败：文件不存在或不安全：${filePath}`);
  }
  const text = readFileSync(filePath, "utf-8");
  const { TOOL_SCHEMAS } = await import("./tools.ts");
  const knownTools = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));
  const def = parseWorkflowDefinition(text, basename(filePath), knownTools);
  const registry = loadWorkflowRegistry(home);
  if (registry.workflows.some((w) => w.name === def.name)) {
    throw new WorkflowError(`导入失败：工作流 ${def.name} 已存在（先 nyra workflow remove ${def.name} --yes 再导入）`);
  }
  const ext = /\.json$/i.test(filePath) ? ".json" : ".yaml";
  const file = `${slugifyName(def.name)}${ext}`;
  const dir = workflowDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, file);
  if (existsSync(dest)) {
    throw new WorkflowError(`导入失败：定义文件已存在但注册表里没有 ${def.name}（先手动清理 ${dest}）`);
  }
  const tmp = `${dest}.tmp-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  try { chmodSync(dest, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
  registry.workflows.push({ name: def.name, file, status: "draft", trialRunId: null, trialAt: null, activatedAt: null, updatedAt: nowIso() });
  saveWorkflowRegistry(home, registry);
  return { name: def.name, file };
}

function resolveInputs(def: WorkflowDefinition, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(def.inputs ?? {}) };
  for (const [k, v] of Object.entries(overrides)) {
    if (def.inputs !== undefined && !(k in def.inputs)) {
      throw new WorkflowError(`输入无效：工作流 ${def.name} 没有声明 inputs.${k}（已声明：${Object.keys(def.inputs).join("、") || "无"}）`);
    }
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) throw new WorkflowError(`输入无效：${k} 须是小写字母开头的变量名`);
    out[k] = v;
  }
  return out;
}

export async function runWorkflowByName(home: string, name: string, inputOverrides: Record<string, unknown>, req: WorkflowRunRequest): Promise<WorkflowRun> {
  const { def } = loadWorkflowDefinitionFile(home, name);
  return runWorkflowDefinition(home, def, inputOverrides, req);
}

/**
 * G-P2-5：直接跑一个已校验的内联工作流定义（不经注册表）——声明式 agent
 * 的 workflow.inline 走这一条；与 runWorkflowByName 同款 runner 与输入解析。
 */
export async function runWorkflowDefinition(home: string, def: WorkflowDefinition, inputOverrides: Record<string, unknown>, req: WorkflowRunRequest): Promise<WorkflowRun> {
  const inputs = resolveInputs(def, inputOverrides);
  const runner = new WorkflowRunner(def, inputs, {
    home, workdir: req.workdir, mode: req.mode, interactive: req.interactive,
    maxCostUsd: req.maxCostUsd,
    providerFactory: req.providerFactory ?? defaultProviderFactory(home),
    stepCheckpointStore: req.stepCheckpointStore,
  });
  return runner.runFrom(0);
}

/** dry-run：只列出会写/会发什么，不执行；计划 + 哈希存一条运行记录，供 verify 重算比对。 */
export function dryRunWorkflowByName(home: string, name: string, inputOverrides: Record<string, unknown>): { run: WorkflowRun; plan: DryRunPlan } {
  const { def } = loadWorkflowDefinitionFile(home, name);
  const inputs = resolveInputs(def, inputOverrides);
  const plan = dryRunPlan(def, inputs);
  const run: WorkflowRun = {
    id: newWorkflowRunId(), workflow: name, status: "completed", inputs, definition: def,
    nodes: [], spentUsd: 0, startedAt: nowIso(), endedAt: nowIso(),
    dryRun: true, trial: false, error: null,
    pendingNodeId: null, pendingNodeIndex: null, pendingInterruptId: null, reviewItemId: null, dryRunPlanHash: plan.hash,
    coordinator: null,
  };
  saveWorkflowRun(home, run);
  return { run, plan };
}

/** 试跑：拿真实数据真执行一遍（写/发动作都会真发生，须 --yes）。跑通才记 trial_passed。 */
export async function trialWorkflow(home: string, name: string, inputOverrides: Record<string, unknown>, req: WorkflowRunRequest, confirm: boolean): Promise<WorkflowRun> {
  if (!confirm) throw new WorkflowError("试跑会真实执行（写/发动作都会真发生），须加 --yes 确认");
  const { def } = loadWorkflowDefinitionFile(home, name);
  const inputs = resolveInputs(def, inputOverrides);
  const runner = new WorkflowRunner(def, inputs, {
    home, workdir: req.workdir, mode: req.mode, interactive: req.interactive,
    maxCostUsd: req.maxCostUsd,
    providerFactory: req.providerFactory ?? defaultProviderFactory(home),
    trial: true,
    stepCheckpointStore: req.stepCheckpointStore,
  });
  const run = await runner.runFrom(0);
  if (run.status === "completed") {
    const registry = loadWorkflowRegistry(home);
    const entry = registry.workflows.find((w) => w.name === name);
    if (entry) {
      entry.status = "trial_passed";
      entry.trialRunId = run.id;
      entry.trialAt = run.endedAt ?? nowIso();
      entry.updatedAt = nowIso();
      saveWorkflowRegistry(home, registry);
    }
  }
  return run;
}

export function activateWorkflow(home: string, name: string, confirm: boolean, workdir?: string): WorkflowRegistryEntry {
  if (!confirm) throw new WorkflowError("激活须加 --yes 确认（激活前必须先试跑通过）");
  const registry = loadWorkflowRegistry(home);
  const entry = registry.workflows.find((w) => w.name === name);
  if (!entry) throw new WorkflowError(`没有这个工作流：${name}（先 nyra workflow import <文件> 导入）`);
  if (entry.status !== "trial_passed") {
    throw new WorkflowError(`工作流 ${name} 还没试跑通过（当前 ${entry.status}），先 nyra workflow trial ${name} --yes`);
  }
  entry.status = "active";
  entry.activatedAt = nowIso();
  entry.updatedAt = nowIso();
  saveWorkflowRegistry(home, registry);
  // Pi Bot 借鉴第 1 条：激活时把纯脚本的摘要钉死（预授权）。钉摘要要读
  // 脚本文件，读失败不破坏激活（只跳过那一步）；钉死的步骤内容一改，
  // 跑时直接拒绝，须重新 trial + activate。
  try {
    grantWorkflowScriptPreauth(home, name, workdir ?? process.cwd());
  } catch { /* 钉摘要失败不破坏激活 */ }
  return entry;
}

/**
 * Pi Bot 借鉴第 1 条：给工作流钉纯脚本摘要（预授权）。激活时自动调一次；
 * 激活前就推上 main 的老工作流用 `nyra script preauth grant` 补钉。
 * 只钉纯脚本——不纯的、含模板的、指定了 cwd 的、不是单条脚本调用的步骤
 * 都跳过（理由在 skipped 里），不拦工作流本身。
 */
export function grantWorkflowScriptPreauth(home: string, name: string, workdir: string): PinResult {
  const { def } = loadWorkflowDefinitionFile(home, name);
  return pinWorkflowScripts(home, workdir, workflowRoutineId(name), def.steps);
}

export function removeWorkflow(home: string, name: string, confirm: boolean): void {
  if (!confirm) throw new WorkflowError("删除须加 --yes 确认");
  const registry = loadWorkflowRegistry(home);
  const idx = registry.workflows.findIndex((w) => w.name === name);
  if (idx < 0) throw new WorkflowError(`没有这个工作流：${name}`);
  const entry = registry.workflows[idx];
  const path = join(workflowDir(home), entry.file);
  if (existsSync(path)) rmSync(path);
  registry.workflows.splice(idx, 1);
  saveWorkflowRegistry(home, registry);
  // 预授权跟着工作流走：删了工作流，钉死的摘要一并撤销。
  try { revokePreauth(home, workflowRoutineId(name)); } catch { /* ignore */ }
}

/** 续跑挂起的运行：审阅项已批复则继续，已拒绝按 on_reject 处理，还没批复就报错。
 *  协调者/动态形态：批复后回到协调者循环续跑（轮数与动态步骤从运行记录里恢复）；
 *  协调者 ask 挂起（pendingNodeId 是 __ask__ 哨兵）：批了记一个 ask 节点继续循环，
 *  拒了整轮失败。 */
export async function resumeWorkflow(home: string, runId: string, req: WorkflowRunRequest): Promise<WorkflowRun> {
  const run = getWorkflowRun(home, runId);
  if (!run) throw new WorkflowError(`没有这个运行：${runId}`);
  if (run.status !== "awaiting_approval") {
    throw new WorkflowError(`运行 ${runId} 当前是 ${run.status}，不是等待审批，不能 resume`);
  }
  if (!run.reviewItemId || run.pendingNodeIndex === null || !run.pendingNodeId) {
    throw new WorkflowError(`运行 ${runId} 的挂起信息不完整`);
  }
  const isCoordinator = run.definition.mode !== "fixed";
  const runner = new WorkflowRunner(run.definition, run.inputs, {
    home, workdir: req.workdir, mode: req.mode, interactive: req.interactive,
    maxCostUsd: req.maxCostUsd,
    providerFactory: req.providerFactory ?? defaultProviderFactory(home),
    stepCheckpointStore: req.stepCheckpointStore,
  }, run);
  const clearPending = (): void => {
    run.pendingNodeId = null;
    run.pendingNodeIndex = null;
    run.reviewItemId = null;
  };
  const continueAfter = (nextIndex: number): Promise<WorkflowRun> => {
    if (isCoordinator) return runner.runCoordinator();
    return runner.runFrom(nextIndex);
  };
  if (run.pendingNodeId === ASK_NODE_ID) {
    const askItem = getReviewItem(home, run.reviewItemId);
    if (askItem.status === "approved" || askItem.status === "applied") {
      // ask 节点 id 避开计划里已有的步骤 id（scope 里同名会互相覆盖）。
      let askId = `ask-${runner.coordinatorRound()}`;
      while (run.definition.steps.some((s) => s.id === askId)) askId = `${askId}-x`;
      const askNode: WorkflowNodeResult = {
        id: askId, type: "approve", status: "ok",
        startedAt: nowIso(), endedAt: nowIso(), ms: 0,
        input: askItem.title, output: `已批准协调者的提问：${askItem.title}`, approved: true, spentUsd: null, error: null,
      };
      runner.recordNode(askNode);
      clearPending();
      return runner.runCoordinator();
    }
    if (askItem.status === "rejected") {
      run.status = "failed";
      run.endedAt = nowIso();
      run.error = `协调者的提问被拒绝：${askItem.title}`;
      run.spentUsd = runner.spentKnown;
      clearPending();
      saveWorkflowRun(home, run);
      runner.emit("workflow_failed", { error: run.error.slice(0, 200) });
      return run;
    }
    throw new WorkflowError(`审阅项 ${askItem.id} 还没批复（当前 ${askItem.status}），先 nyra review approve/reject 再 resume`);
  }
  const idx = run.pendingNodeIndex;
  const step = run.definition.steps[idx];
  if (!step || step.id !== run.pendingNodeId) {
    throw new WorkflowError(`运行 ${runId} 的挂起节点对不上定义快照`);
  }
  const item = getReviewItem(home, run.reviewItemId);
  const title = step.title ?? step.id;
  if (item.status === "approved" || item.status === "applied") {
    const approved: WorkflowNodeResult = {
      id: step.id, type: "approve", status: "ok",
      startedAt: nowIso(), endedAt: nowIso(), ms: 0,
      input: title, output: `已批准：${title}`, approved: true, spentUsd: null, error: null,
    };
    runner.recordNode(approved);
    clearPending();
    return continueAfter(idx + 1);
  }
  if (item.status === "rejected") {
    if (step.on_reject === "skip") {
      const skipped: WorkflowNodeResult = {
        id: step.id, type: "approve", status: "skipped",
        startedAt: nowIso(), endedAt: nowIso(), ms: 0,
        input: title, output: `已拒绝，按 on_reject=skip 跳过：${title}`, approved: false, spentUsd: null, error: null,
      };
      runner.recordNode(skipped);
      clearPending();
      return continueAfter(idx + 1);
    }
    run.status = "failed";
    run.endedAt = nowIso();
    run.error = `审批节点 ${step.id} 被拒绝（on_reject=fail）`;
    run.spentUsd = runner.spentKnown;
    clearPending();
    saveWorkflowRun(home, run);
    runner.emit("workflow_failed", { error: run.error.slice(0, 200) });
    return run;
  }
  throw new WorkflowError(`审阅项 ${item.id} 还没批复（当前 ${item.status}），先 nyra review approve/reject 再 resume`);
}

// ---------------------------------------------------------------------------
// G-P1-41：结构化人机回环——续跑
// ---------------------------------------------------------------------------

/** 这个步骤 edit 决定能改哪些输入键（键 → 类型）。approve / parallel /
// for_each 步骤没有可改的输入，edit 直接拒绝；tool 的对象/列表参数不认
// edit（CLI 的 --set 只能传标量）。 */
export function editableInputTypes(step: WorkflowStep): Record<string, InterruptSchemaFieldType> | null {
  if (step.for_each !== undefined) return null;
  if (step.type === "tool") {
    const args = step.args ?? {};
    const out: Record<string, InterruptSchemaFieldType> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string") out[k] = "string";
      else if (typeof v === "number") out[k] = "number";
      else if (typeof v === "boolean") out[k] = "boolean";
    }
    return Object.keys(out).length ? out : null;
  }
  if (step.type === "llm") {
    const out: Record<string, InterruptSchemaFieldType> = { prompt: "string" };
    if (step.system !== undefined) out.system = "string";
    return out;
  }
  if (step.type === "delegate") {
    const out: Record<string, InterruptSchemaFieldType> = { task: "string" };
    if (step.max_turns !== undefined) out.max_turns = "number";
    return out;
  }
  if (step.type === "skill") return { task: "string" };
  if (step.type === "knowledge") {
    const out: Record<string, InterruptSchemaFieldType> = { query: "string", base: "string" };
    if (step.top_k !== undefined) out.top_k = "number";
    return out;
  }
  return null;
}

/** 按步骤类型校验 edit 决定的人改值，返回校验过的覆盖记录。 */
export function validateStepEditValues(step: WorkflowStep, values: Record<string, unknown>): Record<string, unknown> {
  const allowed = editableInputTypes(step);
  if (!allowed) {
    const why = step.for_each !== undefined
      ? "（循环步骤不支持 edit，改循环内单步请拆步骤）"
      : step.type === "approve"
        ? "（审批节点没有可改的输入）"
        : step.type === "parallel"
          ? "（并行步骤不支持 edit）"
          : "（这个步骤没有标量输入可改）";
    throw new WorkflowError(`步骤 ${step.id}（${step.type}）没有可改的输入参数，不能 edit${why}`);
  }
  try {
    return validateEditValues(values, allowed);
  } catch (err) {
    if (err instanceof InterruptError) throw new WorkflowError(`edit 值校验失败（步骤 ${step.id}）：${err.message}`);
    throw err;
  }
}

/** G-P1-41：从挂起的中断单续跑。只认 awaiting_interrupt 的运行与已回的单。
 *  决定按点位走：before 点 accept/respond 原样跑该步、ignore 记 skipped 后
 *  继续、edit 带输入覆盖跑该步；after 点 accept/ignore/respond 继续下一步、
 *  edit 改该步在 scope 里的输出再继续。审批节点与成本硬顶照常（续跑后跑到
 *  审批节点仍挂起，--max-cost / 月度硬顶重新核）。 */
export async function resumeWorkflowFromInterrupt(home: string, runId: string, req: WorkflowRunRequest): Promise<WorkflowRun> {
  const run = getWorkflowRun(home, runId);
  if (!run) throw new WorkflowError(`没有这个运行：${runId}`);
  if (run.status !== "awaiting_interrupt") {
    throw new WorkflowError(`运行 ${runId} 当前是 ${run.status}，不是等待人工回环，不能 interrupt resume（审批挂起用 nyra workflow resume）`);
  }
  if (!run.pendingInterruptId || run.pendingNodeIndex === null || !run.pendingNodeId) {
    throw new WorkflowError(`运行 ${runId} 的挂起信息不完整`);
  }
  const it = getInterrupt(home, run.pendingInterruptId);
  if (it.runId !== runId) throw new WorkflowError(`中断单 ${it.id} 与运行 ${runId} 对不上`);
  if (it.status !== "resolved" || !it.decision) {
    throw new WorkflowError(`中断单 ${it.id} 还没回（当前 ${it.status}），先 nyra interrupt respond/edit 再 resume，或 resume 时加 --decision accept|ignore`);
  }
  if (run.definition.mode !== "fixed") {
    throw new WorkflowError("只有 fixed 形态支持结构化人机回环");
  }
  const idx = run.pendingNodeIndex;
  const step = run.definition.steps[idx];
  if (!step || step.id !== run.pendingNodeId) {
    throw new WorkflowError(`运行 ${runId} 的挂起节点对不上定义快照`);
  }
  const decision: InterruptDecision = it.decision;
  const overrides = new Map<string, Record<string, unknown>>();
  if (it.point === "before" && decision === "edit") {
    overrides.set(step.id, validateStepEditValues(step, it.editedValues ?? {}));
  }
  const runner = new WorkflowRunner(run.definition, run.inputs, {
    home, workdir: req.workdir, mode: req.mode, interactive: req.interactive,
    maxCostUsd: req.maxCostUsd,
    providerFactory: req.providerFactory ?? defaultProviderFactory(home),
    stepCheckpointStore: req.stepCheckpointStore,
    stepInputOverrides: overrides,
  }, run);
  const clearPending = (): void => {
    run.pendingNodeId = null;
    run.pendingNodeIndex = null;
    run.pendingInterruptId = null;
  };
  const resumed = (): void => {
    runner.emit("workflow_interrupt_resumed", { interrupt_id: it.id, decision });
  };
  if (it.point === "before") {
    if (decision === "ignore") {
      const skipped: WorkflowNodeResult = {
        id: step.id, type: step.type, status: "skipped",
        startedAt: nowIso(), endedAt: nowIso(), ms: 0,
        input: step.prompt ?? step.task ?? step.query ?? step.title ?? "",
        output: `人工回环 ignore：跳过步骤 ${step.id}`, approved: null, spentUsd: null, error: null,
      };
      runner.recordNode(skipped);
      clearPending();
      resumed();
      return runner.runFrom(idx + 1);
    }
    // accept / respond / edit：原样或带覆盖跑该步。
    clearPending();
    resumed();
    return runner.runFrom(idx);
  }
  // after 点：accept / ignore / respond 继续下一步；edit 先改该步输出再继续。
  if (decision === "edit") {
    const output = (it.editedValues ?? {}).output;
    if (typeof output !== "string") {
      throw new WorkflowError("after 点的 edit 只能改 output（--set output=新值）");
    }
    runner.applyAfterPointEdit(step.id, output);
  }
  clearPending();
  resumed();
  return runner.runFrom(idx + 1);
}

/**
 * G-P1-40 时间旅行：从某一步的检查点重放后续步骤。
 *
 * 做法是“分叉重放”，不是原地改写：原运行的记录不动，新建一条运行
 * （replayedFrom 记来源），节点取原运行到检查点为止的前缀——其中被
 * update_state 改过的步骤输出，先按检查点里的新值换掉——再从下一步
 * 接着跑。已跑过的步骤不重跑；审批节点重放时重新问人（不复用旧批复）；
 * 月度硬顶与 --max-cost 照常（前缀已花的钱算进新运行的 spentKnown）。
 * 只有 fixed 形态能重放；后面有调模型 / 审批的步骤时，没 --yes 直接拒绝。
 */
export interface ReplayWorkflowResult {
  run: WorkflowRun | null;
  plan: ReplayPlan;
}

export async function replayWorkflowFromCheckpoint(
  home: string,
  runId: string,
  stepId: string,
  req: WorkflowRunRequest,
  opts?: { stepCheckpointStore?: StepCheckpointStore; confirmCosted?: boolean; dryRun?: boolean },
): Promise<ReplayWorkflowResult> {
  const run = getWorkflowRun(home, runId);
  if (!run) throw new WorkflowError(`没有这个运行：${runId}`);
  const store = opts?.stepCheckpointStore ?? req.stepCheckpointStore ?? resolveStepCheckpointStore(home);
  const checkpoints = await store.load(runId);
  if (!checkpoints.length) throw new WorkflowError(`运行 ${runId} 没有步级检查点（还没跑过步骤，或检查点后端里没有这条运行）`);
  const plan = planReplay(run.definition, checkpoints, stepId);
  if (!plan.supported) throw new WorkflowError(plan.reason ?? "这个运行不支持重放");
  if (plan.needsConfirmation && !opts?.confirmCosted && !opts?.dryRun) {
    const costed = plan.steps.filter((s) => s.kind !== "deterministic").map((s) => s.id).join("、");
    throw new WorkflowError(`重放后面有调模型 / 审批的步骤（${costed}），须加 --yes 确认（先 --dry-run 看计划）`);
  }
  if (opts?.dryRun) return { run: null, plan };
  // 前缀：到检查点节点为止（含它）；被改过的步骤输出按检查点状态换掉。
  const cp = checkpoints.find((c) => c.stepId === plan.fromNodeId) ?? null;
  const cutIndex = run.nodes.findIndex((n) => n.id === plan.fromNodeId);
  if (cutIndex < 0 || !cp) throw new WorkflowError(`运行 ${runId} 里找不到检查点 ${plan.fromNodeId} 对应的节点`);
  const prefix = run.nodes.slice(0, cutIndex + 1).map((n) => ({ ...n }));
  for (const [key, value] of Object.entries(cp.state)) {
    const m = /^steps\.(.+)\.output$/.exec(key);
    if (!m || typeof value !== "string") continue;
    const node = prefix.find((n) => n.id === m[1]);
    if (node) node.output = value;
  }
  const replayed: WorkflowRun = {
    ...run,
    id: newWorkflowRunId(),
    status: "running",
    nodes: prefix,
    spentUsd: null,
    startedAt: nowIso(),
    endedAt: null,
    dryRun: false,
    trial: false,
    error: null,
    pendingNodeId: null,
    pendingNodeIndex: null,
    pendingInterruptId: null,
    reviewItemId: null,
    dryRunPlanHash: null,
    coordinator: null,
    replayedFrom: { runId, stepId: plan.fromStepId, at: nowIso() },
  };
  const runner = new WorkflowRunner(run.definition, run.inputs, {
    home, workdir: req.workdir, mode: req.mode, interactive: req.interactive,
    maxCostUsd: req.maxCostUsd,
    providerFactory: req.providerFactory ?? defaultProviderFactory(home),
    stepCheckpointStore: store,
  }, replayed);
  runner.emit("step_checkpoint_replayed", {
    from_run_id: runId, step_id: plan.fromStepId, steps_replayed: plan.steps.length,
  });
  const result = await runner.runFrom(plan.nextIndex);
  return { run: result, plan };
}

export function verifyWorkflowRun(home: string, runId: string): { ok: boolean; expectedHash: string; actualHash: string; run: WorkflowRun } {
  const run = getWorkflowRun(home, runId);
  if (!run) throw new WorkflowError(`没有这个运行：${runId}`);
  if (!run.dryRun) throw new WorkflowError(`运行 ${runId} 不是 dry-run（只有 dry-run 的运行能 verify）`);
  const v = verifyDryRunPlan(run);
  return { ...v, run };
}

// ---------------------------------------------------------------------------
// CLI：nyra workflow <动作>
// ---------------------------------------------------------------------------

const WORKFLOW_USAGE = [
  "用法：nyra workflow <import|list|show|run|dry-run|resume|trial|activate|remove|verify|triggers> [参数]",
  "",
  "  import <文件.yaml|json>              导入工作流定义（校验 DSL 与工具名，状态 draft）",
  "  list                                 列出已导入的工作流与状态",
  "  show <名字>                          看定义摘要（触发器、节点、最近运行）",
  "  run <名字> [--input k=v]...          真执行（写/发动作都会真发生）",
  "  dry-run <名字> [--input k=v]...      只列出会写/会发什么，不执行；计划带哈希可 verify",
  "  resume <运行 id>                     审批通过/拒绝后，从挂起的节点继续跑",
  "  trial <名字> --yes [--input k=v]...  拿真实数据试跑一遍（真执行），跑通才记 trial_passed",
  "  activate <名字> --yes                试跑通过后激活（只有 active 的工作流会被触发执行）",
  "  triggers <status|enable|disable|run>  触发器执行总开关（默认关；enable 须 --yes）与到点触发器手动跑一轮",
  "  remove <名字> --yes                  删除定义与注册（运行记录保留）",
  "  verify <运行 id>                     用定义快照重算 dry-run 计划、比哈希",
  "",
  "  --input k=v    覆盖 inputs 的默认值（k 须是已声明的输入名；true/false/数字自动认类型）",
  "  --max-cost N   本次运行的成本上限（美元），超了即停；不给则用定义里的 max_cost_usd",
  "",
  "工作流激活前有两道门：trial 真实数据试跑 + activate 人工确认。三种执行形态",
  "都已落地：fixed（固定图，按 DSL 顺序跑）、coordinator（协调者 agent 每轮决定",
  "下一步，可生成新步骤）、dynamic（动态：种子步骤可为空，协调者运行中派生子问题）。",
  "协调者每轮只调一次模型做决定，简单判断仍走 if（不调模型）；轮数、新步骤数、",
  "每步骤执行次数都有硬上限，超了即停。详见 docs/workflow.md。",
].join("\n");

function parseInputFlag(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--input") continue;
    const kv = argv[i + 1];
    if (!kv || !kv.includes("=")) throw new WorkflowError("--input 后面须跟 k=v");
    const eq = kv.indexOf("=");
    const k = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) throw new WorkflowError(`输入无效：${k} 须是小写字母开头的变量名`);
    if (raw === "true") out[k] = true;
    else if (raw === "false") out[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[k] = Number(raw);
    else out[k] = raw;
  }
  if (Object.keys(out).length > MAX_INPUTS) throw new WorkflowError(`输入无效：最多 ${MAX_INPUTS} 个`);
  return out;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function printRunSummary(run: WorkflowRun): void {
  const spent = typeof run.spentUsd === "number" ? `$${run.spentUsd.toFixed(4)}` : "未知（有调用没报用量）";
  process.stdout.write(`运行 ${run.id}：${run.status}（${run.nodes.length} 个节点，已花 ${spent}）\n`);
  if (run.status === "awaiting_approval") {
    if (run.pendingNodeId === ASK_NODE_ID) {
      process.stdout.write(`协调者停下来问人了（审阅项 ${run.reviewItemId ?? "?"}）。\n先 nyra review approve ${run.reviewItemId ?? ""}（或 reject），再 nyra workflow resume ${run.id}\n`);
      return;
    }
    process.stdout.write(`审批节点 ${run.pendingNodeId ?? "?"} 已进审阅队列（审阅项 ${run.reviewItemId ?? "?"}）。\n先 nyra review approve ${run.reviewItemId ?? ""}（或 reject），再 nyra workflow resume ${run.id}\n`);
  }
  if (run.status === "awaiting_interrupt") {
    // G-P1-41：结构化人机回环挂起——先回中断单，再 resume。
    process.stdout.write(`步骤 ${run.pendingNodeId ?? "?"} 在等人工回环（中断单 ${run.pendingInterruptId ?? "?"}）。\n先 nyra interrupt show ${run.pendingInterruptId ?? ""} 看一眼，再 nyra interrupt respond/edit ${run.pendingInterruptId ?? ""} --set 键=值，最后 nyra interrupt resume ${run.pendingInterruptId ?? ""}\n`);
  }
  if (run.status === "failed" && run.error) {
    process.stdout.write(`失败原因：${run.error}\n`);
  }
}

export async function handleWorkflow(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(WORKFLOW_USAGE + "\n");
    return 2;
  }
  const resolvedHome = home || resolveHome();
  const req: WorkflowRunRequest = {
    workdir: process.cwd(),
    mode: "normal",
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
  const maxCostRaw = flagValue(argv, "--max-cost");
  if (maxCostRaw !== undefined) {
    const n = Number(maxCostRaw);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write("错误：--max-cost 须是大于 0 的数字\n");
      return 2;
    }
    req.maxCostUsd = n;
  }
  try {
    if (action === "import") {
      const file = argv[1];
      if (!file) { process.stderr.write("错误：import 后面须跟定义文件路径\n"); return 2; }
      const { name, file: saved } = await importWorkflow(resolvedHome, file);
      process.stdout.write(`已导入工作流 ${name}（${saved}，状态 draft）。\n下一步：nyra workflow trial ${name} --yes（真实数据试跑，通过后才能激活）\n`);
      return 0;
    }
    if (action === "list") {
      const entries = listWorkflows(resolvedHome);
      if (!entries.length) {
        process.stdout.write("还没有工作流，先 nyra workflow import <文件.yaml|json>\n");
        return 0;
      }
      for (const e of entries) {
        const trial = e.trialRunId ? ` 试跑 ${e.trialRunId}` : "";
        process.stdout.write(`${e.name}  ${e.status}${trial}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：show 后面须跟工作流名字\n"); return 2; }
      const registry = loadWorkflowRegistry(resolvedHome);
      const entry = registry.workflows.find((w) => w.name === name);
      if (!entry) { process.stderr.write(`错误：没有这个工作流：${name}\n`); return 1; }
      const { def } = loadWorkflowDefinitionFile(resolvedHome, name);
      process.stdout.write(`${def.name}（${entry.status}）${def.description ? `：${def.description}` : ""}\n`);
      process.stdout.write(`形态 ${def.mode}${def.goal ? `，目标：${def.goal.slice(0, 100)}` : ""}\n`);
      if (def.mode !== "fixed") {
        process.stdout.write(`协调者：最多 ${resolveMaxRounds(def)} 轮，最多再生成 ${resolveMaxNewSteps(def)} 个新步骤\n`);
      }
      process.stdout.write(`节点 ${countSteps(def.steps)} 个，触发器 ${def.triggers?.length ?? 0} 个${def.max_cost_usd ? `，成本上限 $${def.max_cost_usd}` : ""}\n`);
      const runs = loadWorkflowRuns(resolvedHome).runs.filter((r) => r.workflow === name).slice(-5);
      if (runs.length) {
        process.stdout.write("最近运行：\n");
        for (const r of runs) process.stdout.write(`  ${r.id}  ${r.status}${r.dryRun ? "（dry-run）" : ""}${r.trial ? "（试跑）" : ""}\n`);
      }
      return 0;
    }
    if (action === "run") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：run 后面须跟工作流名字\n"); return 2; }
      const run = await runWorkflowByName(resolvedHome, name, parseInputFlag(argv), req);
      printRunSummary(run);
      return run.status === "completed" || run.status === "awaiting_approval" || run.status === "awaiting_interrupt" ? 0 : 1;
    }
    if (action === "dry-run") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：dry-run 后面须跟工作流名字\n"); return 2; }
      const { run, plan } = dryRunWorkflowByName(resolvedHome, name, parseInputFlag(argv));
      if (!plan.actions.length) {
        process.stdout.write("这个工作流在当前输入下没有任何动作。\n");
      } else {
        process.stdout.write("dry-run 计划（只列出，不执行）：\n");
        for (const a of plan.actions) {
          process.stdout.write(`  [${a.kind}] ${a.nodeId}：${a.detail}\n`);
        }
      }
      if (plan.skippedNodes.length) process.stdout.write(`跳过的节点（if 为假）：${plan.skippedNodes.join("、")}\n`);
      process.stdout.write(`计划哈希 ${plan.hash}（运行 ${run.id}，可用 nyra workflow verify ${run.id} 重算比对）\n`);
      return 0;
    }
    if (action === "resume") {
      const runId = argv[1];
      if (!runId) { process.stderr.write("错误：resume 后面须跟运行 id\n"); return 2; }
      const run = await resumeWorkflow(resolvedHome, runId, req);
      printRunSummary(run);
      return run.status === "completed" || run.status === "awaiting_approval" || run.status === "awaiting_interrupt" ? 0 : 1;
    }
    if (action === "trial") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：trial 后面须跟工作流名字\n"); return 2; }
      const run = await trialWorkflow(resolvedHome, name, parseInputFlag(argv), req, argv.includes("--yes"));
      printRunSummary(run);
      if (run.status === "completed") {
        process.stdout.write(`试跑通过，工作流 ${name} 已记 trial_passed，可 nyra workflow activate ${name} --yes 激活。\n`);
        return 0;
      }
      return 1;
    }
    if (action === "activate") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：activate 后面须跟工作流名字\n"); return 2; }
      activateWorkflow(resolvedHome, name, argv.includes("--yes"), req.workdir);
      const pinned = listPreauth(resolvedHome, workflowRoutineId(name)).length;
      process.stdout.write(`工作流 ${name} 已激活。纯脚本摘要已钉 ${pinned} 个（改了内容须重新 trial + activate；nyra script preauth list --workflow ${name} 查看）。触发器执行默认关闭，须 nyra workflow triggers enable --yes 显式开启后，active 工作流的触发器才会被执行。\n`);
      return 0;
    }
    if (action === "triggers") {
      const sub = argv[1] ?? "";
      const { describeWorkflowTriggers, runDueWorkflowTriggers, setWorkflowTriggersEnabled } = await import("./workflowTriggers.ts");
      if (sub === "status") {
        const st = describeWorkflowTriggers(resolvedHome);
        process.stdout.write(`触发器执行：${st.enabled ? "已开启" : "未开启（默认关，nyra workflow triggers enable --yes 开启）"}\n`);
        process.stdout.write(`补跑策略：${st.policy.catchUp === "once" ? "once（漏掉的只补跑一次，其余记 missed）" : "skip（直接跳到下一档，漏掉的全记 missed）"}，窗口 ${st.policy.catchUpWindowMinutes} 分钟（nyra cron policy 改）\n`);
        if (st.hold.held) {
          process.stdout.write(`配额 hold：挂起中，至 ${st.hold.holdUntil ?? "未知"}（暂停 ${st.hold.pauseId ?? "未知"}，层 ${st.hold.scope ?? "未知"}）；期间定时与事件触发全部挂起（nyra cron hold 看）\n`);
        } else {
          process.stdout.write("配额 hold：没有。\n");
        }
        if (!st.workflows.length) {
          process.stdout.write("没有 active 且带触发器的工作流。\n");
          return 0;
        }
        for (const w of st.workflows) {
          const desc = w.triggers.map((t) => (t.type === "schedule" ? `定时 ${t.cron}` : `事件 ${t.event}`)).join("、");
          process.stdout.write(`${w.name}：${desc}\n`);
        }
        return 0;
      }
      if (sub === "enable") {
        if (!argv.includes("--yes")) {
          process.stderr.write("错误：开启触发器执行须加 --yes，明确允许守护进程按触发器自动跑工作流（只跑 active 的工作流，写操作照常挂起等审批）。\n");
          return 2;
        }
        setWorkflowTriggersEnabled(resolvedHome, true);
        process.stdout.write("触发器执行已开启：守护进程每轮会跑到点的定时触发器，网关与 Gmail 轮询会触发同名事件的工作流。\n");
        return 0;
      }
      if (sub === "disable") {
        setWorkflowTriggersEnabled(resolvedHome, false);
        process.stdout.write("触发器执行已关闭。\n");
        return 0;
      }
      if (sub === "run") {
        const report = await runDueWorkflowTriggers(resolvedHome, { workdir: req.workdir, now: new Date() });
        if (report.skipped) {
          process.stdout.write(`触发器执行跳过：${report.skipped}\n`);
          return 0;
        }
        // G-P1-37：顺带跑到点的线程 cron（与工作流触发器共用总开关）。
        const { fireDueThreadCrons } = await import("./threads.ts");
        const threadReport = await fireDueThreadCrons(resolvedHome, { workdir: req.workdir, now: new Date() });
        const threadFired = threadReport.fired.filter((f) => f.status !== "skipped");
        for (const m of report.missed ?? []) {
          process.stdout.write(`工作流 ${m.workflow} 漏跑 ${m.count} 次${m.caughtUp ? "（已补跑一次）" : ""}，见事故账 nyra cron incidents。\n`);
        }
        for (const m of threadReport.missed ?? []) {
          process.stdout.write(`线程 ${m.threadId.slice(0, 8)} 的工作流 ${m.workflow} 漏跑 ${m.count} 次${m.caughtUp ? "（已补跑一次）" : ""}，见事故账 nyra cron incidents。\n`);
        }
        if (!report.fired.length && !threadFired.length) {
          process.stdout.write("本轮没有到点的触发器。\n");
          return 0;
        }
        for (const f of report.fired) {
          process.stdout.write(`工作流 ${f.workflow} 已触发（${f.status === "ok" ? `运行 ${f.runId}` : `失败：${f.error ?? ""}`}）\n`);
        }
        for (const f of threadFired) {
          process.stdout.write(`线程 ${f.threadId.slice(0, 8)} 的工作流 ${f.workflow} 已触发（${f.status === "ok" ? `运行 ${f.runId}` : `失败：${f.error ?? ""}`}）\n`);
        }
        return report.fired.every((f) => f.status === "ok") && threadFired.every((f) => f.status !== "failed") ? 0 : 1;
      }
      process.stderr.write(`错误：未知动作 triggers ${sub}（应为 status|enable|disable|run）\n${WORKFLOW_USAGE}\n`);
      return 2;
    }
    if (action === "remove") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：remove 后面须跟工作流名字\n"); return 2; }
      removeWorkflow(resolvedHome, name, argv.includes("--yes"));
      process.stdout.write(`工作流 ${name} 已删除（运行记录保留在 workflow-runs.json 里）。\n`);
      return 0;
    }
    if (action === "verify") {
      const runId = argv[1];
      if (!runId) { process.stderr.write("错误：verify 后面须跟运行 id\n"); return 2; }
      const v = verifyWorkflowRun(resolvedHome, runId);
      if (v.ok) {
        process.stdout.write(`dry-run 计划验证通过：哈希一致（${v.actualHash}）\n`);
        return 0;
      }
      process.stdout.write(`dry-run 计划验证失败：存的哈希 ${v.expectedHash}，重算 ${v.actualHash}（定义快照或输入被改过）\n`);
      return 1;
    }
    process.stderr.write(`错误：未知动作 ${action}\n${WORKFLOW_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`错误：${message}\n`);
    return 1;
  }
}
