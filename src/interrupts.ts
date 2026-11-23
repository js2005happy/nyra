// src/interrupts.ts — G-P1-41：结构化人机回环（LangGraph HumanInterrupt 的想法，Node 实现）。
//
// 审批卡 / 审阅队列 / judge 都是“批一次工具调用”；这里补的是另一种形态：
// 工作流跑到指定步骤前后停住，人看一眼、回一句话或改几个参数，带着改完的
// 值原地继续。只由机主显式配（interrupt_before / interrupt_after），默认不停。
//
// 叶模块：只引 node 内置，不 import 其他 src 文件（workflow.ts 静态 import
// 它才不成环）。账本与 hitl.ts 同款：0600 原子写，损坏先备份再回空。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class InterruptError extends Error {}

export type InterruptDecision = "accept" | "ignore" | "respond" | "edit";
export type InterruptPoint = "before" | "after";
export type InterruptStatus = "pending" | "resolved";

export type InterruptSchemaFieldType = "string" | "number" | "boolean";

export interface InterruptSchemaField {
  name: string;
  type: InterruptSchemaFieldType;
  required?: boolean;
  description?: string;
}

export interface InterruptResponseSchema {
  fields: InterruptSchemaField[];
}

export interface InterruptSpec {
  prompt?: string;
  schema?: InterruptResponseSchema;
}

/** 一条结构化中断单。contextSummary 只记步骤输入/输出摘要（≤500 字），
 *  不记对话原文；response / editedValues 只记人回的值。 */
export interface HumanInterrupt {
  version: 1;
  id: string;
  runId: string;
  workflow: string;
  stepId: string;
  point: InterruptPoint;
  status: InterruptStatus;
  prompt: string;
  schema: InterruptResponseSchema;
  contextSummary: string;
  createdAt: string;
  resolvedAt: string | null;
  decision: InterruptDecision | null;
  response: Record<string, string | number | boolean> | null;
  editedValues: Record<string, unknown> | null;
  resolvedBy: string | null;
}

export const MAX_INTERRUPTS = 200;
export const MAX_SCHEMA_FIELDS = 16;
export const MAX_PROMPT_CHARS = 500;
export const MAX_CONTEXT_CHARS = 500;
export const MAX_VALUE_CHARS = 1000;
export const MAX_EDIT_VALUE_CHARS = 1000;
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const EDIT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

const DECISIONS: InterruptDecision[] = ["accept", "ignore", "respond", "edit"];

function interruptsPath(home: string): string {
  return join(home, "interrupts.json");
}

function atomicWrite0600(path: string, data: string): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

export function validateInterruptSchema(value: unknown, where = "response_schema"): InterruptResponseSchema {
  if (!isRecord(value)) throw new InterruptError(`${where} 须是一个对象（fields 列表）`);
  for (const k of Object.keys(value)) {
    if (k !== "fields") throw new InterruptError(`${where} 里不认的键：${k}（只认 fields）`);
  }
  const fields = value.fields;
  if (!Array.isArray(fields)) throw new InterruptError(`${where}.fields 须是一个列表`);
  if (fields.length > MAX_SCHEMA_FIELDS) {
    throw new InterruptError(`${where}.fields 最多 ${MAX_SCHEMA_FIELDS} 个，现有 ${fields.length} 个`);
  }
  const seen = new Set<string>();
  const out: InterruptSchemaField[] = [];
  for (const raw of fields) {
    if (!isRecord(raw)) throw new InterruptError(`${where}.fields 里的每一项须是一个对象`);
    for (const k of Object.keys(raw)) {
      if (!["name", "type", "required", "description"].includes(k)) {
        throw new InterruptError(`${where}.fields 里的字段不认的键：${k}（只认 name / type / required / description）`);
      }
    }
    const name = raw.name;
    if (typeof name !== "string" || !FIELD_NAME_RE.test(name)) {
      throw new InterruptError(`${where}.fields 里的字段名须是小写字母开头、只含小写字母数字下划线（≤32 字），现有：${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new InterruptError(`${where}.fields 里的字段名重复：${name}`);
    seen.add(name);
    const type = raw.type;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new InterruptError(`${where}.fields 里字段 ${name} 的 type 只认 string / number / boolean，现有：${JSON.stringify(type)}`);
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      throw new InterruptError(`${where}.fields 里字段 ${name} 的 required 只认 true / false`);
    }
    if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 200)) {
      throw new InterruptError(`${where}.fields 里字段 ${name} 的 description 须是 ≤200 字的字符串`);
    }
    out.push({
      name,
      type,
      ...(raw.required !== undefined ? { required: raw.required } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
    });
  }
  return { fields: out };
}

/** 校验工作流定义里 interrupt_before / interrupt_after 的写法（导入时调）。 */
export function validateInterruptSpec(value: unknown, where: string): InterruptSpec {
  if (!isRecord(value)) throw new InterruptError(`${where} 须是一个对象（prompt / schema）`);
  for (const k of Object.keys(value)) {
    if (k !== "prompt" && k !== "schema") throw new InterruptError(`${where} 里不认的键：${k}（只认 prompt / schema）`);
  }
  const out: InterruptSpec = {};
  if (value.prompt !== undefined) {
    if (typeof value.prompt !== "string" || value.prompt.length < 1 || value.prompt.length > MAX_PROMPT_CHARS) {
      throw new InterruptError(`${where}.prompt 须是 1–${MAX_PROMPT_CHARS} 字的字符串`);
    }
    out.prompt = value.prompt;
  }
  if (value.schema !== undefined) out.schema = validateInterruptSchema(value.schema, `${where}.schema`);
  return out;
}

/** 按 response_schema 校验人回的 response（respond 决定用）。 */
export function validateInterruptResponse(
  schema: InterruptResponseSchema,
  values: unknown,
): Record<string, string | number | boolean> {
  if (!isRecord(values)) throw new InterruptError("respond 的值须是键=值的一组（--set 键=值 可重复）");
  const known = new Map(schema.fields.map((f) => [f.name, f]));
  for (const k of Object.keys(values)) {
    if (!known.has(k)) throw new InterruptError(`response 里不认的字段：${k}（schema 里没有）`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const f of schema.fields) {
    const v = values[f.name];
    if (v === undefined) {
      if (f.required) throw new InterruptError(`response 里缺必填字段：${f.name}`);
      continue;
    }
    if (typeof v !== f.type) throw new InterruptError(`response 里字段 ${f.name} 须是 ${f.type}，现有 ${typeof v}`);
    if (f.type === "string" && (v as string).length > MAX_VALUE_CHARS) {
      throw new InterruptError(`response 里字段 ${f.name} 最多 ${MAX_VALUE_CHARS} 字`);
    }
    if (f.type === "number" && !Number.isFinite(v as number)) {
      throw new InterruptError(`response 里字段 ${f.name} 须是有限数字`);
    }
    out[f.name] = v as string | number | boolean;
  }
  return out;
}

/** 校验 edit 决定的人改值：只改 allowed 里的键，值须是标量且类型对得上。 */
export function validateEditValues(
  values: unknown,
  allowed: Record<string, InterruptSchemaFieldType>,
): Record<string, unknown> {
  if (!isRecord(values)) throw new InterruptError("edit 的值须是键=值的一组（--set 键=值 可重复）");
  const keys = Object.keys(values);
  if (keys.length === 0) throw new InterruptError("edit 须至少改一个值（--set 键=值）");
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!EDIT_KEY_RE.test(k)) throw new InterruptError(`edit 的键只认字母开头、字母数字下划线（≤32 字），现有：${k}`);
    if (!(k in allowed)) throw new InterruptError(`这个步骤改不了 ${k}（可改的键：${Object.keys(allowed).join("、") || "无"}）`);
    const v = values[k];
    if (!isScalar(v)) throw new InterruptError(`edit 里 ${k} 的值须是字符串 / 数字 / 布尔，不能是对象或列表`);
    if (typeof v !== allowed[k]) throw new InterruptError(`edit 里 ${k} 须是 ${allowed[k]}，现有 ${typeof v}`);
    if (typeof v === "string" && v.length > MAX_EDIT_VALUE_CHARS) {
      throw new InterruptError(`edit 里 ${k} 最多 ${MAX_EDIT_VALUE_CHARS} 字`);
    }
    if (typeof v === "number" && !Number.isFinite(v)) throw new InterruptError(`edit 里 ${k} 须是有限数字`);
    out[k] = v;
  }
  return out;
}

function readLedger(home: string): HumanInterrupt[] {
  const p = interruptsPath(home);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("not an array");
    const items: HumanInterrupt[] = [];
    for (const it of raw) {
      if (!isRecord(it) || typeof it.id !== "string" || typeof it.runId !== "string") continue;
      items.push(it as unknown as HumanInterrupt);
    }
    return items;
  } catch {
    const bak = `${p}.bak-${Date.now()}`;
    try {
      renameSync(p, bak);
    } catch {
      // 备份失败也不拦：直接回空账本，旧账本丢了也比卡住强。
    }
    return [];
  }
}

function saveLedger(home: string, items: HumanInterrupt[]): void {
  let kept = items;
  if (kept.length > MAX_INTERRUPTS) {
    const resolved = kept.filter((i) => i.status === "resolved");
    const pending = kept.filter((i) => i.status === "pending");
    const drop = Math.min(resolved.length, kept.length - MAX_INTERRUPTS);
    kept = [...pending, ...resolved.slice(drop)];
  }
  atomicWrite0600(interruptsPath(home), JSON.stringify(kept, null, 2));
}

export function createInterrupt(
  home: string,
  args: {
    runId: string;
    workflow: string;
    stepId: string;
    point: InterruptPoint;
    prompt: string;
    schema: InterruptResponseSchema;
    contextSummary: string;
  },
): HumanInterrupt {
  // 同一条运行、同一个步骤、同一个点，挂起的单只有一张：重入（比如触发器
  // 与手动各跑一轮撞上）直接回已有的，不重复建。
  const existing = findInterrupt(home, args.runId, args.stepId, args.point);
  if (existing && existing.status === "pending") return existing;
  const items = readLedger(home);
  const now = new Date().toISOString();
  const it: HumanInterrupt = {
    version: 1,
    id: `int-${randomBytes(6).toString("hex")}`,
    runId: args.runId,
    workflow: args.workflow,
    stepId: args.stepId,
    point: args.point,
    status: "pending",
    prompt: args.prompt,
    schema: args.schema,
    contextSummary: args.contextSummary.slice(0, MAX_CONTEXT_CHARS),
    createdAt: now,
    resolvedAt: null,
    decision: null,
    response: null,
    editedValues: null,
    resolvedBy: null,
  };
  items.push(it);
  saveLedger(home, items);
  return it;
}

export function getInterrupt(home: string, id: string): HumanInterrupt {
  const it = readLedger(home).find((i) => i.id === id);
  if (!it) throw new InterruptError(`找不到中断单：${id}`);
  return it;
}

export function findInterrupt(home: string, runId: string, stepId: string, point: InterruptPoint): HumanInterrupt | null {
  return readLedger(home).find((i) => i.runId === runId && i.stepId === stepId && i.point === point) ?? null;
}

export function listInterrupts(home: string, status?: InterruptStatus): HumanInterrupt[] {
  const items = readLedger(home);
  const filtered = status ? items.filter((i) => i.status === status) : items;
  return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 记录决定。accept / ignore 不带值；respond 带 schema 校验过的 response；
 *  edit 带步骤输入覆盖（值校验在续跑时按步骤类型再做一次）。 */
export function resolveInterrupt(
  home: string,
  id: string,
  decision: InterruptDecision,
  opts: { response?: unknown; editedValues?: unknown; by?: string } = {},
): HumanInterrupt {
  if (!DECISIONS.includes(decision)) throw new InterruptError(`不认的决定：${decision}（只认 accept / ignore / respond / edit）`);
  const items = readLedger(home);
  const it = items.find((i) => i.id === id);
  if (!it) throw new InterruptError(`找不到中断单：${id}`);
  if (it.status !== "pending") throw new InterruptError(`中断单 ${id} 已经是 ${it.status}，不能再回`);
  let response: Record<string, string | number | boolean> | null = null;
  let editedValues: Record<string, unknown> | null = null;
  if (decision === "accept" || decision === "ignore") {
    if (opts.response !== undefined || opts.editedValues !== undefined) {
      throw new InterruptError(`${decision} 不带值（要回值用 respond，要改参数用 edit）`);
    }
  } else if (decision === "respond") {
    response = validateInterruptResponse(it.schema, opts.response ?? {});
  } else {
    if (!isRecord(opts.editedValues)) throw new InterruptError("edit 须带 --set 键=值（至少改一个参数）");
    const flat: Record<string, unknown> = {};
    for (const k of Object.keys(opts.editedValues)) {
      const v = (opts.editedValues as Record<string, unknown>)[k];
      if (!isScalar(v)) throw new InterruptError(`edit 里 ${k} 的值须是字符串 / 数字 / 布尔`);
      flat[k] = v;
    }
    if (Object.keys(flat).length === 0) throw new InterruptError("edit 须至少改一个值（--set 键=值）");
    editedValues = flat;
  }
  it.status = "resolved";
  it.decision = decision;
  it.response = response;
  it.editedValues = editedValues;
  it.resolvedAt = new Date().toISOString();
  it.resolvedBy = opts.by ?? "local";
  saveLedger(home, items);
  return it;
}

/** 测试用：账本文件权限（0600）是否达标。
 *  Windows 没有 POSIX 权限位（chmod 只映射只读位，mode 拿不到 0600），
 *  退化为“不能是全开”，与 tests/node/fsPerms.ts 的 expectPerms 同款。 */
export function interruptsLedgerModeOk(home: string): boolean {
  const p = interruptsPath(home);
  if (!existsSync(p)) return true;
  try {
    const mode = statSync(p).mode & 0o777;
    if (process.platform === "win32") return mode !== 0o777;
    return mode === 0o600;
  } catch {
    return false;
  }
}
