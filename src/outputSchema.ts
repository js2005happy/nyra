// src/outputSchema.ts — H-4：子任务结构化输出契约（output_schema）。
//
// 只做确定性校验，不调模型、不花 token。子代理事先在任务文本里看到契约，
// 答完父级按契约校验：先从回答里抽 JSON（```json 代码块优先，其次整段，
// 再其次第一个配对的 {…} / […]），再按 JSON Schema 子集校验。
// 支持的关键字：type、required、properties、additionalProperties、items、
// enum、minLength、maxLength、minimum、maximum、pattern；
// 不认识的关键字直接忽略，不因不认识而报错。
// 契约只管格式不管对错；schema 写得太严会逼子代理编造字段凑格式，
// 那是调用方写契约的责任，校验层不替它兜底。

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
  /** 抽到的 JSON 值；没抽到时为 null。 */
  parsed: unknown;
}

const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 契约本身是否合法（调用方给的 schema 写坏了要在委派前拒绝，不等跑完才发现）。 */
export function checkOutputSchema(schema: unknown): string | null {
  if (!isPlainObject(schema)) return "output_schema 必须是 JSON Schema 对象";
  if (schema.type !== undefined && (typeof schema.type !== "string" || !KNOWN_TYPES.has(schema.type))) {
    return "output_schema 的 type 必须是 string/number/integer/boolean/object/array/null 之一";
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    return "output_schema 的 properties 必须是个对象";
  }
  if (schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string"))) {
    return "output_schema 的 required 必须是字符串数组";
  }
  if (schema.items !== undefined && !isPlainObject(schema.items)) return "output_schema 的 items 必须是个对象";
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return "output_schema 的 enum 必须是个数组";
  return null;
}

function tryParse(s: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: null };
  }
}

/** 从一段可能夹着散文的回答里抽第一段 JSON：先找 ```json 代码块，再试
 * 整段，最后扫第一个配对的 {…} / […]（感知字符串与转义）。 */
export function extractJsonCandidate(text: string): { found: boolean; value: unknown } {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed.ok) return { found: true, value: parsed.value };
  }
  const whole = tryParse(text.trim());
  if (whole.ok) return { found: true, value: whole.value };
  let attempts = 0;
  for (let i = 0; i < text.length && attempts < 5; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    attempts += 1;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") { inStr = true; continue; }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParse(text.slice(i, j + 1));
          if (parsed.ok) return { found: true, value: parsed.value };
          break;
        }
      }
    }
  }
  return { found: false, value: null };
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkSingleType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && !Number.isNaN(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

/** type 可以是单个类型，也可以是联合类型数组（strict 归一化把可选属性
 * 放宽成 [原类型, "null"] 后会用到）。 */
function checkType(value: unknown, type: string | string[]): boolean {
  if (Array.isArray(type)) return type.some((t) => checkSingleType(value, t));
  return checkSingleType(value, type);
}

const MAX_ERRORS = 10;

function validateValue(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  const at = path || "根";
  if ((typeof schema.type === "string" || Array.isArray(schema.type)) && !checkType(value, schema.type as string | string[])) {
    errors.push(`${at} 应为 ${Array.isArray(schema.type) ? schema.type.join("/") : schema.type}，实际为 ${typeName(value)}`);
    return;
  }
  if (Array.isArray(schema.enum)) {
    const hit = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!hit) errors.push(`${at} 不在 enum 允许值里`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${at} 长度 ${value.length}，短于 minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${at} 长度 ${value.length}，超过 maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${at} 不符合 pattern ${schema.pattern}`);
      } catch { /* 坏 pattern 是 schema 的错，调用方校验时已拦，这里不报错 */ }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${at} 为 ${value}，小于 minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${at} 为 ${value}，大于 maximum ${schema.maximum}`);
    }
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) errors.push(`${at} 缺少必填字段 ${key}`);
        if (errors.length >= MAX_ERRORS) return;
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value && isPlainObject(sub)) validateValue(value[key], sub, `${at}.${key}`, errors);
        if (errors.length >= MAX_ERRORS) return;
      }
    }
    if (schema.additionalProperties === false && isPlainObject(schema.properties)) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${at} 有多余字段 ${key}（additionalProperties 为 false）`);
        if (errors.length >= MAX_ERRORS) return;
      }
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      validateValue(value[i], schema.items, `${at}[${i}]`, errors);
      if (errors.length >= MAX_ERRORS) return;
    }
  }
}

/** 对一段回答做契约校验：抽不到 JSON 就是未通过（不是“没给契约”）。 */
export function validateOutputSchema(text: string, schema: Record<string, unknown>): SchemaValidation {
  const extracted = extractJsonCandidate(text);
  if (!extracted.found) {
    return { valid: false, errors: ["回答里没找到 JSON（要一段符合契约的 JSON）"], parsed: null };
  }
  const errors: string[] = [];
  validateValue(extracted.value, schema, "", errors);
  return { valid: errors.length === 0, errors: errors.map((e) => e.slice(0, 200)), parsed: extracted.value };
}

/** 对已解析的 JSON 值做 schema 校验（不从文本里抽 JSON）。供工具参数
 * 二次校验用：工具参数已经是解析后的对象，直接按 schema 验。 */
export function validateJsonValue(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  validateValue(value, schema, "", errors);
  return errors.map((e) => e.slice(0, 200));
}
