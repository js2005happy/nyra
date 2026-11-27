// src/toolStrict.ts — 十年清单第 4 项：严格模式结构化输出。
//
// 两件事，互为兜底：
//   1. 支持 strict 的 provider：工具参数 schema 归一化成 OpenAI strict 子集
//      （全部对象 additionalProperties: false、全部属性进 required、可选属性
//      放宽为可空），发送时 function.strict = true。
//   2. 所有 provider：工具调用返回后按 schema 做二次校验，失败只重试一次，
//      重试仍失败按原有错误路径走（不执行、不静默吞）。
//
// 本模块只 import ./outputSchema.ts（叶模块，防循环）。不调模型、不花钱。
import { validateJsonValue } from "./outputSchema.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 各 provider 的工具级 strict 支持（2026-11-27 逐家核实，见 docs/strict-mode.md）。
 *  true = 默认开 strict；false = 不发 strict，走二次校验＋一次重试。
 *  注意：本树 15 个内置 provider 全走 OpenAI 兼容接口（src/providers.ts 只有
 *  一个 Provider 类），没有原生 Anthropic / Gemini provider；那两家的
 *  output_config（管最终文本）与工具 strict（管工具参数）独立配置的约束，
 *  只记在 docs/strict-mode.md 里，将来接原生 provider 时再落地。 */
export const STRICT_TOOLS_BY_PROVIDER: Record<string, boolean> = {
  // OpenAI：官方 strict（function.strict），最权威。
  openai: true,
  // xAI：工具 strict 恒为 true（显式传也接受），additionalProperties 默认 false。
  xai: true,
  // 通义千问（DashScope）：接受工具级 strict 标志，response_format json_schema
  // strict 已有文档；Nyra 默认模型 qwen-plus 在列。
  qwen: true,
  // Together：函数调用本身就是约束解码强制的，schema 即函数参数规约。
  together: true,
  // DeepSeek：strict 是 Beta 接口专属（须走 /beta），Nyra 预置走生产 /v1。
  deepseek: false,
  // OpenLux：网关，未公开 strict 处理方式，路由模型各异。
  openlux: false,
  // OpenRouter：透传，路由端点不支持 strict 时会 400/404。
  openrouter: false,
  // Ollama：/v1 的 response_format json_schema 只管文本，工具级 strict 未见文档。
  ollama: false,
  // Kimi（Moonshot）：MFJS 子集，minimum/maximum 等关键字会 400（Nyra 的
  // delegate schema 恰好含 minimum/maximum），工具级 strict 是否强制未见明文。
  kimi: false,
  // 智谱 GLM：response_format 只有 text/json_object，无 json_schema/strict
  // 文档，官方建议客户端校验＋修复循环。
  glm: false,
  // Gemini（走 Google 的 OpenAI 兼容端点 /v1beta/openai）：兼容层
  // response_format json_schema 只管文本，工具级 strict 未见文档。
  gemini: false,
  // Mistral：工具参数 strict 未见文档（response_format strict 是另一回事，
  // Nyra 工具调用不用 response_format）。
  mistral: false,
  // Groq：response_format strict 有，但工具级 strict 未见文档；部分模型上
  // 结构化输出与工具不可同用。
  groq: false,
  // codex：CLI provider，根本不调工具，strict 不适用。
  codex: false,
  // 自定义端点：未知行为，默认不发。
  custom: false,
};

/** 决定某个 provider 发不发 strict。优先级：环境变量 > 预置覆盖 > 支持表。
 *  环境变量 NYRA_STRICT_TOOLS：`0` 全关；逗号列表里写 provider 名强制开
 *  （如 `openlux`）、`no:<名>` 强制关（如 `no:qwen`）；没命中的名字走下面两层。
 *  预置覆盖：自定义 provider 可在 custom_providers 条目里写 strict_tools。 */
export function resolveStrictTools(providerName: string, presetOverride?: boolean | null): boolean {
  const env = (process.env.NYRA_STRICT_TOOLS ?? "").trim();
  if (env === "0") return false;
  if (env !== "") {
    for (const token of env.split(",")) {
      const t = token.trim();
      if (!t) continue;
      if (t === providerName) return true;
      if (t === `no:${providerName}`) return false;
    }
  }
  if (typeof presetOverride === "boolean") return presetOverride;
  return STRICT_TOOLS_BY_PROVIDER[providerName] ?? false;
}

/** OpenAI strict 子集里硬性不支持的关键字（出现即整工具判为不能 strict，
 * 原样发、走校验重试）。default 不在里面：它是纯提示，归一化时剥掉。 */
const HARD_UNSUPPORTED = new Set([
  "oneOf", "allOf", "not", "dependentRequired", "dependentSchemas",
  "if", "then", "else", "contains", "prefixItems", "patternProperties",
  "propertyNames", "minProperties", "maxProperties", "uniqueItems",
  "unevaluatedProperties", "$ref", "$defs", "$dynamicRef", "$dynamicAnchor",
]);

/** 可选属性放宽为可空：strict 要求全部属性进 required，模型总得给可选属性
 * 填点什么，null 是诚实的“没给”。 */
function makeNullable(prop: Record<string, unknown>): void {
  if (typeof prop.type === "string") {
    if (prop.type !== "null") prop.type = [prop.type, "null"];
  } else if (Array.isArray(prop.type)) {
    if (!prop.type.includes("null")) prop.type = [...prop.type, "null"];
  }
  if (Array.isArray(prop.enum) && !prop.enum.includes(null)) prop.enum = [...prop.enum, null];
  if (Array.isArray(prop.anyOf)) {
    const hasNull = prop.anyOf.some((b) => isPlainObject(b) && (b as Record<string, unknown>).type === "null");
    if (!hasNull) prop.anyOf = [...prop.anyOf, { type: "null" }];
  }
}

/** 把一个 schema 节点就地归一化成 strict 子集。返回 ok=false 时整工具
 * 不能 strict（原样发、走校验重试）。入参必须是深拷贝，不改原对象。 */
function strictifyNode(node: unknown): { ok: boolean; reason?: string } {
  if (!isPlainObject(node)) return { ok: false, reason: "schema 节点不是对象" };
  for (const key of Object.keys(node)) {
    if (HARD_UNSUPPORTED.has(key)) return { ok: false, reason: `不支持的关键字 ${key}` };
  }
  // default 是纯提示（工具实现自己有默认值），strict 子集外，剥掉不改变校验语义。
  delete node.default;
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) {
      const r = strictifyNode(branch);
      if (!r.ok) return r;
    }
  }
  const type = node.type;
  if (type === "array") {
    if (node.items === undefined) return { ok: true };
    if (!isPlainObject(node.items)) return { ok: false, reason: "数组 items 不是对象" };
    return strictifyNode(node.items);
  }
  if (type === "object" || (type === undefined && isPlainObject(node.properties))) {
    if (!isPlainObject(node.properties)) {
      return { ok: false, reason: "自由格式对象（没有 properties），strict 表达不了" };
    }
    const props = node.properties as Record<string, Record<string, unknown>>;
    // properties 为空：schema 没说清允许哪些键——可能是“无参工具”，也可能
    // 只是占位写法。只在原 schema 已显式 additionalProperties: false 时才
    // 当作无参工具 strict 化；否则判为自由格式（走校验重试，校验按原 schema
    // 验，无 additionalProperties 约束即放行），不把所有键都当成多余键。
    if (Object.keys(props).length === 0) {
      if (node.additionalProperties === false) {
        node.required = [];
        return { ok: true };
      }
      return { ok: false, reason: "properties 为空，未说明允许哪些键，strict 表达不了" };
    }
    node.additionalProperties = false;
    const origRequired = Array.isArray(node.required) ? node.required as string[] : [];
    const keys = Object.keys(props);
    node.required = keys;
    for (const key of keys) {
      const prop = props[key];
      if (!isPlainObject(prop)) return { ok: false, reason: `属性 ${key} 不是对象` };
      const r = strictifyNode(prop);
      if (!r.ok) return r;
      if (!origRequired.includes(key)) makeNullable(prop);
    }
    return { ok: true };
  }
  // string/number/integer/boolean/null 等叶子：无事可做。
  return { ok: true };
}

export interface NormalizeParametersResult {
  /** 归一化后的 parameters（深拷贝，原对象不动）。 */
  schema: Record<string, unknown>;
  /** 能否发 strict。false 时 schema 只是深拷贝的原样，调用方原样发。 */
  strict: boolean;
  reason?: string;
}

/** 归一化一个工具的 parameters（根必须是对象）。 */
export function normalizeParameters(parameters: Record<string, unknown>): NormalizeParametersResult {
  const clone = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  if (clone.type !== "object" && !isPlainObject(clone.properties)) {
    return { schema: clone, strict: false, reason: "parameters 根不是对象" };
  }
  const r = strictifyNode(clone);
  if (!r.ok) return { schema: clone, strict: false, reason: r.reason };
  return { schema: clone, strict: true };
}

export interface StrictToolResult {
  /** 归一化后的工具（深拷贝，原对象不动）；能 strict 的带 function.strict = true。 */
  tool: Record<string, unknown>;
  strict: boolean;
  reason?: string;
}

/** 归一化一个工具定义：能 strict 的加 strict: true，不能的原样返回。 */
export function normalizeToolForStrict(tool: Record<string, unknown>): StrictToolResult {
  const clone = JSON.parse(JSON.stringify(tool)) as Record<string, unknown>;
  const fn = clone.function as Record<string, unknown> | undefined;
  if (!isPlainObject(fn) || typeof fn.name !== "string") {
    return { tool: clone, strict: false, reason: "工具定义缺少 function/name" };
  }
  const params = fn.parameters as Record<string, unknown> | undefined;
  if (!isPlainObject(params)) {
    return { tool: clone, strict: false, reason: "工具没有 parameters 对象" };
  }
  const norm = normalizeParameters(params);
  if (!norm.strict) return { tool: clone, strict: false, reason: norm.reason };
  fn.parameters = norm.schema;
  fn.strict = true;
  return { tool: clone, strict: true };
}

/** 按 provider 的 strict 决定转换整组工具。strict 关时原样返回同一数组
 * （不改、不拷贝，Provider.chat 的 payload 只做 JSON.stringify）。 */
export function applyStrictToTools(
  providerName: string,
  presetOverride: boolean | undefined,
  tools: Record<string, unknown>[] | null | undefined,
): Record<string, unknown>[] | null | undefined {
  if (tools === null || tools === undefined) return tools;
  if (!resolveStrictTools(providerName, presetOverride)) return tools;
  return tools.map((t) => normalizeToolForStrict(t).tool);
}

/** 校验时给缺失的可选属性补 null：归一化后的 schema 要求全部属性必填，
 * 模型没给可选属性是合法的，补 null 后再验就不会误报“缺少必填字段”。 */
function fillMissingOptionals(args: Record<string, unknown>, orig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const props = orig.properties as Record<string, Record<string, unknown>> | undefined;
  if (!isPlainObject(props)) return out;
  const origRequired = new Set(
    (Array.isArray(orig.required) ? orig.required : []).filter((x): x is string => typeof x === "string"),
  );
  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in out)) {
      if (!origRequired.has(key)) out[key] = null;
      continue;
    }
    const v = out[key];
    if (isPlainObject(v) && isPlainObject(propSchema) &&
      (propSchema.type === "object" || isPlainObject(propSchema.properties))) {
      out[key] = fillMissingOptionals(v, propSchema);
    } else if (Array.isArray(v) && isPlainObject(propSchema) && propSchema.type === "array" &&
      isPlainObject(propSchema.items)) {
      out[key] = v.map((item) => isPlainObject(item)
        ? fillMissingOptionals(item, propSchema.items as Record<string, unknown>)
        : item);
    }
  }
  return out;
}

/** 对已解析的工具参数做 schema 校验（strict 语义：多余键不通过、可选属性
 * 可为 null）。能 strict 化的按归一化后的 schema 验，不能的按原 schema 验。
 * 返回错误列表，空表示通过。 */
export function validateToolCallArgs(args: unknown, parameters: unknown): string[] {
  if (!isPlainObject(args)) return ["工具参数必须是 JSON 对象"];
  if (!isPlainObject(parameters)) return [];
  const norm = normalizeParameters(parameters);
  if (!norm.strict) return validateJsonValue(args, parameters);
  const filled = fillMissingOptionals(args, parameters);
  return validateJsonValue(filled, norm.schema);
}

/** 批量校验一轮的 tool_calls。返回 map：键是原 tool_call 对象，值是错误列表；
 * 没进 map 的就是通过；未知工具名没有 schema 可校验，跳过（执行层自会报错）。 */
export function validateToolCalls(
  toolCalls: Record<string, unknown>[],
  schemas: Record<string, unknown>[],
): Map<Record<string, unknown>, string[]> {
  const byName = new Map<string, Record<string, unknown>>();
  for (const s of schemas) {
    const fn = (s as Record<string, unknown>).function as Record<string, unknown> | undefined;
    if (isPlainObject(fn) && typeof fn.name === "string") {
      byName.set(fn.name, fn.parameters as Record<string, unknown>);
    }
  }
  const out = new Map<Record<string, unknown>, string[]>();
  for (const tc of toolCalls) {
    const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
    const name = isPlainObject(fn) && typeof fn.name === "string" ? fn.name : "";
    const raw = isPlainObject(fn) && typeof fn.arguments === "string" ? fn.arguments : "{}";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      out.set(tc, ["工具参数不是合法的 JSON"]);
      continue;
    }
    if (!isPlainObject(parsed)) {
      out.set(tc, ["工具参数必须是 JSON 对象"]);
      continue;
    }
    const params = name ? byName.get(name) : undefined;
    if (params === undefined) continue;
    const errors = validateToolCallArgs(parsed, params);
    if (errors.length > 0) out.set(tc, errors);
  }
  return out;
}

/** 校验失败时推给模型的修复消息：只让模型按 schema 重发一次工具调用，
 * 不改任务、不解释。调用方只在每轮发一次（重试一次的上限在 agent.ts 里）。 */
export function buildToolArgRepairMessage(invalid: Map<Record<string, unknown>, string[]>): string {
  const lines: string[] = ["工具参数校验失败，请只按工具 schema 重新发一次工具调用（参数不对，不要改任务、不要解释）："];
  for (const [tc, errors] of invalid) {
    const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
    const name = isPlainObject(fn) && typeof fn.name === "string" ? fn.name : "未知工具";
    lines.push(`- ${name}：${errors.join("；")}`);
  }
  const text = lines.join("\n");
  return text.length > 1000 ? text.slice(0, 997) + "…" : text;
}
