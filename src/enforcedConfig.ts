// src/enforcedConfig.ts — 管理员锁定段（对齐 Codex `requirements.toml` 的轻量版）。
//
// 问题：`config.json` 是普通文件，agent 自己（或用户）都能改。于是「红线」只是建议：
// `max_cost_usd` 被删掉就没有硬顶，`sandbox` 改成 local 就没有隔离，`deny_read_globs`
// 清空就能读 .env。这不是权限设计，是摆设。
//
// 轻量解法：`config.enforced` 段里写的键**优先于一切覆盖来源**——CLI 参数、`config import`、
// 甚至同文件里重复的顶层键。它不是强安全边界（能改文件的人仍能改 enforced），
// 但挡住了「agent 顺手改配置绕过硬顶」这条最现实的路。
//
// 纪律：
//   - **白名单**：只有安全相关的键可以被锁，避免把 `enforced` 变成第二份配置
//   - **锁定不静默**：被拒绝的覆盖要报出来（`ignoredOverrides`），不装作没发生
//   - **纯函数**：不读写文件，便于单测与在各入口复用
import { DANGEROUS_KEYS } from "./configSecurity.ts";

/**
 * 允许被 `enforced` 锁定的键（安全相关子集）。
 * 不在名单里的键即使在 `enforced` 里写了也会被忽略并报出——防止 `enforced` 变成第二份配置。
 */
export const ENFORCEABLE_KEYS: readonly string[] = [
  "max_cost_usd",
  "deny_read_globs",
  "disabled_tools",
  "sandbox",
  "sandbox_mode",
  "verify_command",
  ...DANGEROUS_KEYS,
];

export interface EnforcedResolution {
  /** 被锁定的键 → 值（只含白名单内的键）。 */
  values: Record<string, unknown>;
  /** `enforced` 里写了但不允许锁的键（报出来，不静默忽略）。 */
  rejectedKeys: string[];
}

export interface EnforcedApplyResult<T> {
  /** 应用锁定后的配置/选项。 */
  value: T;
  /** 被锁定值覆盖掉的来源（键 + 原值），用于向用户说明"你改的不生效，因为被锁了"。 */
  ignoredOverrides: { key: string; attempted: unknown; locked: unknown }[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** 从 config 读出锁定段（只保留白名单内的键）。纯函数。 */
export function resolveEnforced(config: Record<string, unknown> | null | undefined): EnforcedResolution {
  const raw = isPlainObject(config) ? config.enforced : undefined;
  if (!isPlainObject(raw)) return { values: {}, rejectedKeys: [] };
  const values: Record<string, unknown> = {};
  const rejectedKeys: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (ENFORCEABLE_KEYS.includes(k)) values[k] = v;
    else rejectedKeys.push(k);
  }
  return { values, rejectedKeys };
}

/**
 * 把锁定值盖到一组选项上（锁定优先）。纯函数。
 *
 * `attempted` 是「本来要用的值」（CLI / 配置文件 / 导入），`locked` 是 `config.enforced` 里的值。
 * 两者不同时记进 `ignoredOverrides`——用户才知道自己那行配置为什么没生效。
 */
export function applyEnforced<T extends Record<string, unknown>>(
  attempted: T,
  enforced: Record<string, unknown>,
): EnforcedApplyResult<T> {
  const out: Record<string, unknown> = { ...attempted };
  const ignoredOverrides: EnforcedApplyResult<T>["ignoredOverrides"] = [];
  for (const [k, locked] of Object.entries(enforced)) {
    if (!ENFORCEABLE_KEYS.includes(k)) continue;
    const has = Object.prototype.hasOwnProperty.call(attempted, k);
    const current = has ? attempted[k] : undefined;
    if (has && JSON.stringify(current) !== JSON.stringify(locked)) {
      ignoredOverrides.push({ key: k, attempted: current, locked });
    }
    out[k] = locked;
  }
  return { value: out as T, ignoredOverrides };
}

/** 人类可读：哪些键被锁、哪些 attempted 被覆盖。 */
export function formatEnforced(res: EnforcedResolution, ignored: readonly { key: string; attempted: unknown; locked: unknown }[] = []): string {
  const lines: string[] = [];
  const keys = Object.keys(res.values);
  lines.push(keys.length ? `管理员锁定（config.enforced，共 ${keys.length} 项）：` : "管理员锁定：未配置（config.enforced 为空）");
  for (const k of keys) lines.push(`  🔒 ${k} = ${JSON.stringify(res.values[k])}`);
  for (const k of res.rejectedKeys) lines.push(`  ⚠️  ${k} 不在可锁名单内，已忽略（防 enforced 变成第二份配置）`);
  for (const o of ignored) lines.push(`  ⚠️  ${o.key} 的尝试值 ${JSON.stringify(o.attempted)} 被锁定值 ${JSON.stringify(o.locked)} 覆盖`);
  return lines.join("\n");
}

/**
 * 取某个键的**生效值**：被锁就用锁定值，否则用配置文件里的值。纯函数。
 *
 * 存在的理由：#82 只把 enforced 接进了 CLI 的命令行选项，运行时的几条读取路径
 * （禁读清单、权限规则、沙箱模式）仍直接读 config.json 顶层——于是"锁了"其实没锁，
 * 这是把功能做成摆设。凡是要读安全键的地方都应走这里。
 */
export function effectiveValue(config: Record<string, unknown> | null | undefined, key: string): unknown {
  const enforced = resolveEnforced(config).values;
  if (Object.prototype.hasOwnProperty.call(enforced, key)) return enforced[key];
  if (!isPlainObject(config)) return undefined;
  return config[key];
}

/** 取字符串数组型的生效值（禁读清单等）：只保留非空字符串项。 */
export function effectiveStringList(config: Record<string, unknown> | null | undefined, key: string): string[] {
  const v = effectiveValue(config, key);
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/**
 * 只在**被锁**时返回锁定值；没锁返回 undefined。
 *
 * 与 ``effectiveValue`` 的区别（踩过）：effectiveValue 没锁时返回 config 顶层值，
 * 拿它当"是否有锁"的判定会让**优先级顺序失效**——
 * 例如每任务硬顶：``enforcedOnly ?? cli ?? config`` 才是对的；
 * 用 effectiveValue 会变成"config 有值就压过 CLI"，与文档写的 CLI 优先矛盾。
 */
export function enforcedOnly(config: Record<string, unknown> | null | undefined, key: string): unknown {
  const enforced = resolveEnforced(config).values;
  return Object.prototype.hasOwnProperty.call(enforced, key) ? enforced[key] : undefined;
}