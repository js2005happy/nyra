// src/brainSchema.ts — H10：脑文件夹 Schema 化。
// ~/.nyra 的结构契约：src/assets/brain-schema.json.txt（版本化，v1）。
// 只核对顶层一层（文件/目录、是否必需、权限位），不递归子目录。
// 判定口径：缺必需文件、类型不对、权限位不对 → 失败；未登记的条目只上报、
// 不判失败——新功能往 ~/.nyra 加文件时，先更新 schema，再让 doctor 通过。
// 迁移时先验 schema 再动手（见 docs/brain-schema.md）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import SCHEMA_JSON from "./assets/brain-schema.json.txt" with { type: "text" };

export interface BrainSchemaEntry {
  path: string;
  kind: "file" | "dir";
  required: boolean;
  /** POSIX 权限位（八进制数，如 0o600）；只在有明确强制的地方填。 */
  mode?: number;
  note?: string;
}

export interface BrainSchema {
  version: number;
  description?: string;
  entries: BrainSchemaEntry[];
}

export type BrainSchemaProblem = "missing-required" | "wrong-kind" | "wrong-mode" | "unknown";

export interface BrainSchemaIssue {
  path: string;
  problem: BrainSchemaProblem;
  detail: string;
}

export interface BrainSchemaReport {
  schemaVersion: number;
  /** 缺必需 / 类型错 / 权限错任一出现即 false；未登记条目不影响 ok。 */
  ok: boolean;
  checked: number;
  issues: BrainSchemaIssue[];
  /** 未登记的顶层条目（只上报，不判失败）。 */
  unknown: string[];
}

const MAX_UNKNOWN_LISTED = 10;

/** 读内置 schema；形状不对直接抛错（打包时就该发现，不要静默通过）。 */
export function loadBrainSchema(): BrainSchema {
  const raw = JSON.parse(SCHEMA_JSON) as Partial<BrainSchema>;
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new Error("脑文件夹 schema 版本无效");
  }
  if (!Array.isArray(raw.entries) || !raw.entries.length) {
    throw new Error("脑文件夹 schema 没有条目");
  }
  const seen = new Set<string>();
  for (const rawEntry of raw.entries) {
    const e = rawEntry as Partial<BrainSchemaEntry> & { mode?: number | string };
    if (!e || typeof e.path !== "string" || !e.path || e.path.includes("/") || e.path.includes("\\") || e.path === "." || e.path === "..") {
      throw new Error(`脑文件夹 schema 条目路径无效：${JSON.stringify(e?.path)}`);
    }
    if (e.kind !== "file" && e.kind !== "dir") {
      throw new Error(`脑文件夹 schema 条目类型无效：${e.path}`);
    }
    if (typeof e.required !== "boolean") {
      throw new Error(`脑文件夹 schema 条目 required 无效：${e.path}`);
    }
    // JSON 里没有八进制字面量：权限位在 schema 文件里写成 "0600" 这样的
    // 八进制字符串，这里解析成数字；直接写数字时按十进制读（不推荐）。
    if (e.mode !== undefined) {
      if (typeof e.mode === "string") {
        if (!/^[0-7]{3,4}$/.test(e.mode)) throw new Error(`脑文件夹 schema 条目权限位无效：${e.path}`);
        (e as { mode: number }).mode = parseInt(e.mode, 8);
      } else if (typeof e.mode !== "number" || !Number.isInteger(e.mode)) {
        throw new Error(`脑文件夹 schema 条目权限位无效：${e.path}`);
      }
    }
    if (seen.has(e.path)) throw new Error(`脑文件夹 schema 条目重复：${e.path}`);
    seen.add(e.path);
  }
  return raw as BrainSchema;
}

export function validateBrainSchema(home: string, schema: BrainSchema = loadBrainSchema()): BrainSchemaReport {
  const issues: BrainSchemaIssue[] = [];
  const unknown: string[] = [];
  const known = new Map(schema.entries.map((e) => [e.path, e]));
  let checked = 0;
  for (const entry of schema.entries) {
    checked += 1;
    const target = join(home, entry.path);
    if (!existsSync(target)) {
      if (entry.required) {
        issues.push({ path: entry.path, problem: "missing-required", detail: `必需的${entry.kind === "file" ? "文件" : "目录"}缺失` });
      }
      continue;
    }
    let st;
    try {
      st = statSync(target);
    } catch {
      issues.push({ path: entry.path, problem: "missing-required", detail: "存在但读不到状态" });
      continue;
    }
    const isDir = st.isDirectory();
    if ((entry.kind === "dir") !== isDir) {
      issues.push({ path: entry.path, problem: "wrong-kind", detail: `应为${entry.kind === "file" ? "文件" : "目录"}，实际是${isDir ? "目录" : "文件"}` });
      continue;
    }
    if (entry.mode !== undefined && process.platform !== "win32" && !isDir) {
      const mode = st.mode & 0o777;
      if (mode !== entry.mode) {
        issues.push({ path: entry.path, problem: "wrong-mode", detail: `权限 ${mode.toString(8)}，应为 ${entry.mode.toString(8)}` });
      }
    }
  }
  let actual: string[] = [];
  try {
    actual = readdirSync(home);
  } catch {
    // 目录本身读不到时，doctor 的“配置目录”一项已报失败；这里不再重复报。
    return { schemaVersion: schema.version, ok: issues.length === 0, checked, issues, unknown };
  }
  for (const name of actual) {
    if (!known.has(name)) unknown.push(name);
  }
  unknown.sort();
  return { schemaVersion: schema.version, ok: issues.length === 0, checked, issues, unknown };
}

/** doctor 用的单行小结：失败原因 + 未登记条目（最多列 10 个，其余只计数）。 */
export function summarizeBrainSchema(report: BrainSchemaReport): string {
  const parts: string[] = [`schema v${report.schemaVersion}，已核对 ${report.checked} 个条目`];
  if (report.issues.length) {
    parts.push(`问题 ${report.issues.length} 个：${report.issues.map((i) => `${i.path}（${i.detail}）`).join("；")}`);
  }
  if (report.unknown.length) {
    const listed = report.unknown.slice(0, MAX_UNKNOWN_LISTED).join("、");
    const rest = report.unknown.length > MAX_UNKNOWN_LISTED ? `等 ${report.unknown.length} 个` : "";
    parts.push(`未登记条目 ${report.unknown.length} 个：${listed}${rest}（不影响使用，新功能加文件时记得更新 schema）`);
  }
  return parts.join("；");
}
