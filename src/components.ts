// src/components.ts — O7：生成式 UI（服务端白名单组件表）。
//
// 模型想给用户看结构化内容时不直接拼 HTML/任意标记，只调 `render_component`：
// 组件名必须在白名单里、已发布、没被该 Bot 屏蔽；props 只接受字面数据
//（string / number / boolean / null / 数组 / 纯对象），不做新的工具调用、
// 不拼 HTML、不执行代码。工具返回的是一段可读文本（CLI fallback）；同时经
// ctx.onEvent 发 `component_rendered` 事件，AG-UI 层把它转成 CUSTOM 事件
// 推给网页端，网页端按组件名渲染（渲染本身是桌面端的界面工作）。
//
// 不另起 A2UI 协议：这里只做“白名单 + 校验 + 文本渲染”的兼容层。
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export class ComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComponentError";
  }
}

export const COMPONENTS_FILE = "components.json";

export type ComponentPropType = "string" | "number" | "boolean" | "array" | "object";

export interface ComponentPropSpec {
  type: ComponentPropType;
  required?: boolean;
  description: string;
}

export interface ComponentSpec {
  name: string;
  description: string;
  /** 未发布的组件模型不能调（先在白名单里占位，发布后再开）。 */
  published: boolean;
  props: Record<string, ComponentPropSpec>;
}

/** 内置只读组件（只读展示先行，写操作仍过审批）。 */
export const BUILTIN_COMPONENTS: readonly ComponentSpec[] = [
  {
    name: "table",
    description: "表格：列名 + 行（行可以是数组，或按列名写的对象）。",
    published: true,
    props: {
      title: { type: "string", description: "表标题（可选）" },
      columns: { type: "array", required: true, description: "列名列表，如 [\"任务\", \"状态\"]" },
      rows: { type: "array", required: true, description: "行：每行是数组，或按列名写的对象" },
    },
  },
  {
    name: "card",
    description: "卡片：标题 + 一段正文 + 若干键值字段。",
    published: true,
    props: {
      title: { type: "string", required: true, description: "卡片标题" },
      body: { type: "string", description: "正文（可选）" },
      fields: { type: "object", description: "键值字段（可选），如 {\"负责人\": \"小明\"}" },
    },
  },
  {
    name: "list",
    description: "列表：标题 + 若干行文本。",
    published: true,
    props: {
      title: { type: "string", description: "列表标题（可选）" },
      items: { type: "array", required: true, description: "行文本列表" },
    },
  },
  {
    name: "code",
    description: "代码块：语言 + 代码正文（只展示，不执行）。",
    published: true,
    props: {
      language: { type: "string", description: "语言名（可选，如 typescript）" },
      code: { type: "string", required: true, description: "代码正文" },
    },
  },
  {
    name: "chart-bar",
    description: "柱状图：标签 + 数值（只展示，不做新的工具调用）。",
    published: true,
    props: {
      title: { type: "string", description: "图标题（可选）" },
      labels: { type: "array", required: true, description: "标签列表" },
      values: { type: "array", required: true, description: "数值列表，与 labels 一一对应" },
    },
  },
];

export function getComponentSpec(name: string): ComponentSpec | null {
  return BUILTIN_COMPONENTS.find((c) => c.name === name) ?? null;
}

export function listComponentNames(): string[] {
  return BUILTIN_COMPONENTS.map((c) => c.name);
}

// ---- 每 Bot 屏蔽表 ---------------------------------------------------------

export interface ComponentConfig {
  version: 1;
  /** bot id → 被屏蔽的组件名列表。 */
  blocked: Record<string, string[]>;
}

export function componentsPath(home: string): string {
  return join(resolveNyraHome(home), COMPONENTS_FILE);
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadComponentConfig(home: string): ComponentConfig {
  const path = componentsPath(home);
  if (!existsSync(path)) return { version: 1, blocked: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new ComponentError(`组件配置已损坏，已备份到 ${backup}，请检查后再试`);
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as ComponentConfig).blocked !== "object") {
    throw new ComponentError("组件配置结构不对（须含 blocked 映射）");
  }
  const blocked: Record<string, string[]> = {};
  for (const [bot, names] of Object.entries((parsed as ComponentConfig).blocked)) {
    if (typeof bot !== "string" || !Array.isArray(names)) continue;
    blocked[bot] = names.filter((n): n is string => typeof n === "string" && !!getComponentSpec(n));
  }
  return { version: 1, blocked };
}

function saveComponentConfig(home: string, config: ComponentConfig): void {
  atomicWriteJson(componentsPath(home), config);
}

export function isComponentBlocked(home: string, botId: string, name: string): boolean {
  const config = loadComponentConfig(home);
  return (config.blocked[botId] ?? []).includes(name);
}

export function blockComponent(home: string, botId: string, name: string): boolean {
  const spec = getComponentSpec(name);
  if (!spec) throw new ComponentError(`没有这个组件（白名单只有 ${listComponentNames().join(" / ")}）`);
  const config = loadComponentConfig(home);
  const list = config.blocked[botId] ?? [];
  if (list.includes(name)) return false;
  config.blocked[botId] = [...list, name];
  saveComponentConfig(home, config);
  return true;
}

export function unblockComponent(home: string, botId: string, name: string): boolean {
  const config = loadComponentConfig(home);
  const list = config.blocked[botId] ?? [];
  if (!list.includes(name)) return false;
  config.blocked[botId] = list.filter((n) => n !== name);
  if (!config.blocked[botId]!.length) delete config.blocked[botId];
  saveComponentConfig(home, config);
  return true;
}

// ---- props 校验（只认字面数据）---------------------------------------------

const MAX_PROPS_DEPTH = 5;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isLiteral(value: unknown, depth: number): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (depth >= MAX_PROPS_DEPTH) return false;
  if (Array.isArray(value)) return value.every((v) => isLiteral(v, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([k, v]) => !FORBIDDEN_KEYS.has(k) && isLiteral(v, depth + 1),
    );
  }
  return false;
}

function propTypeOf(value: unknown): ComponentPropType | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "object";
  return null;
}

/**
 * 校验一次渲染请求：组件存在、已发布、没被该 Bot 屏蔽、props 齐全且类型对。
 * 不合规直接抛 ComponentError（工具层把它转成给模型的错误文本，不崩运行）。
 */
export function validateRenderRequest(
  home: string,
  botId: string,
  name: unknown,
  props: unknown,
): { spec: ComponentSpec; props: Record<string, unknown> } {
  if (typeof name !== "string" || !name) throw new ComponentError("组件名不能为空");
  const spec = getComponentSpec(name);
  if (!spec) throw new ComponentError(`没有这个组件：${name}（白名单只有 ${listComponentNames().join(" / ")}）`);
  if (!spec.published) throw new ComponentError(`组件 ${name} 还没发布，不能用`);
  if (isComponentBlocked(home, botId, name)) throw new ComponentError(`Bot ${botId} 已屏蔽组件 ${name}（nyra components unblock ${botId} ${name} 恢复）`);
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new ComponentError(`组件 ${name} 的 props 须是一个对象`);
  }
  const given = props as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(key in spec.props)) throw new ComponentError(`组件 ${name} 没有 ${key} 这个属性（只认 ${Object.keys(spec.props).join("、")}）`);
  }
  for (const [key, propSpec] of Object.entries(spec.props)) {
    const value = given[key];
    if (value === undefined) {
      if (propSpec.required) throw new ComponentError(`组件 ${name} 缺少必填属性 ${key}（${propSpec.description}）`);
      continue;
    }
    if (!isLiteral(value, 0)) throw new ComponentError(`组件 ${name} 的属性 ${key} 只接受字面数据（字符串/数字/布尔/null/数组/纯对象）`);
    const actual = propTypeOf(value);
    if (actual !== propSpec.type) throw new ComponentError(`组件 ${name} 的属性 ${key} 须是 ${propSpec.type}，当前是 ${actual ?? typeof value}`);
  }
  if (name === "chart-bar") {
    const labels = given.labels as unknown[];
    const values = given.values as unknown[];
    if (labels.length !== values.length) throw new ComponentError("chart-bar 的 labels 与 values 须一一对应（长度相等）");
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new ComponentError("chart-bar 的 values 须全是数字");
  }
  if (name === "table") {
    const columns = given.columns as unknown[];
    if (!columns.length) throw new ComponentError("table 的 columns 不能为空");
    if (columns.some((c) => typeof c !== "string")) throw new ComponentError("table 的 columns 须全是字符串");
    const rows = given.rows as unknown[];
    for (const row of rows) {
      if (Array.isArray(row)) {
        if (row.some((c) => typeof c !== "string" && typeof c !== "number")) throw new ComponentError("table 的行（数组形式）只接受字符串或数字");
      } else if (row && typeof row === "object") {
        if (Object.values(row as Record<string, unknown>).some((c) => typeof c !== "string" && typeof c !== "number")) {
          throw new ComponentError("table 的行（对象形式）只接受字符串或数字");
        }
      } else {
        throw new ComponentError("table 的每行须是数组或按列名写的对象");
      }
    }
  }
  if (name === "list") {
    const items = given.items as unknown[];
    if (items.some((i) => typeof i !== "string")) throw new ComponentError("list 的 items 须全是字符串");
  }
  return { spec, props: given };
}

// ---- 文本渲染（CLI fallback；网页端按组件名另行渲染）----------------------

function cell(value: unknown): string {
return String(value?? "");
}

function renderTable(props: Record<string, unknown>): string {
const title = typeof props.title === "string" && props.title? `${props.title}\n`: "";
const columns = props.columns as string[];
const rows = props.rows as unknown[];
const header = `| ${columns.join(" | ")} |`;
const divider = `| ${columns.map(() => "---").join(" | ")} |`;
const lines = rows.map((row) => {
const cells = Array.isArray(row)
? (row as unknown[]).map(cell)
: columns.map((c) => cell((row as Record<string, unknown>)[c]));
return `| ${cells.join(" | ")} |`;
});
return `${title}${header}\n${divider}\n${lines.join("\n")}`;
}

function renderCard(props: Record<string, unknown>): string {
const lines = [``];
if (typeof props.body === "string" && props.body) lines.push(props.body);
const fields = props.fields as Record<string, unknown> | undefined;
if (fields) {
for (const [k, v] of Object.entries(fields)) lines.push(`${k}：${cell(v)}`);
}
return lines.join("\n");
}

function renderList(props: Record<string, unknown>): string {
const title = typeof props.title === "string" && props.title? `${props.title}\n`: "";
const items = props.items as string[];
return title + items.map((i) => `- ${i}`).join("\n");
}

function renderCode(props: Record<string, unknown>): string {
const language = typeof props.language === "string" && props.language? props.language: "";
return `\`\`\`${language}\n${props.code as string}\n\`\`\``;
}

function renderChartBar(props: Record<string, unknown>): string {
const title = typeof props.title === "string" && props.title? `${props.title}\n`: "";
const labels = props.labels as string[];
const values = props.values as number[];
const max = Math.max(...values, 0);
const width = 20;
const lines = labels.map((label, i) => {
const value = values[i]!;
const filled = max > 0? Math.round((value / max) * width): 0;
return `${label} ${"█".repeat(filled)}${"░".repeat(width - filled)} ${value}`;
});
return title + lines.join("\n");
}

/** 文本渲染（已校验过的 props 才进这里）。 */
export function renderComponentText(name: string, props: Record<string, unknown>): string {
switch (name) {
case "table": return renderTable(props);
case "card": return renderCard(props);
case "list": return renderList(props);
case "code": return renderCode(props);
case "chart-bar": return renderChartBar(props);
default: throw new ComponentError(`没有这个组件：${name}`);
}
}

/** 审计行：只记组件名与 Bot id，不记 props 内容（props 可能含用户数据）。 */
export function appendComponentAudit(home: string, entry: Record<string, unknown>): void {
const dir = resolveNyraHome(home);
mkdirSync(dir, { recursive: true, mode: 0o700});
appendFileSync(join(dir, "components-audit.jsonl"), JSON.stringify({ at: new Date().toISOString(),...entry}) + "\n", "utf-8");
}
