// src/computerGuard.ts — 真机电脑操作（CUA）的守卫层。
//
// Pi `packages/computer/src/guard/` 的想法，Node 实现，不抄 Pi 代码。
// 三平台驱动（src/computer.ts）与 5 个 computer 工具已经有了，缺的是
// 守卫：blocklist（不许碰的窗口/按键）、grants（可撤销授权）、
// foreground（动手前看当前前台窗口）、activity（每一次动作留痕）。
//
// 叶模块：只引 node 内置，不引任何 src 模块，避循环导入。
// 账本都在家目录下（~/.nyra/），0600，损坏先备份再回默认值/空账本。
// 输入文本内容绝不记账本（type 只记长度），窗口标题截断后才记。
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export const GUARD_CONFIG_NAME = "computer-guard.json";
export const GRANTS_NAME = "computer-grants.json";
export const ACTIVITY_NAME = "computer-activity.jsonl";
export const DISPLAY_RECORD_NAME = "computer-display.json";
export const DEFAULT_MAX_ACTIONS_PER_MINUTE = 60;
export const DEFAULT_GRANT_MINUTES = 120;
export const VIRTUAL_DISPLAY = ":99";
export const MAX_TITLE_LEN = 60;

export class ComputerGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerGuardError";
  }
}

/** 默认禁碰的窗口标题子串（大小写不敏感）：系统设置、密码管理器、银行支付、凭据。机主可在 CLI 里增删。 */
export const DEFAULT_BLOCKED_TITLES: readonly string[] = [
  "settings",
  "system preferences",
  "系统设置",
  "偏好设置",
  "控制面板",
  "lock screen",
  "锁屏",
  "1password",
  "bitwarden",
  "keepass",
  "lastpass",
  "dashlane",
  "enpass",
  "keychain",
  "钥匙串",
  "密码管理",
  "bank",
  "银行",
  "payment",
  "支付",
  "wallet",
  "钱包",
  "alipay",
  "支付宝",
  "wechat pay",
  "微信支付",
  "paypal",
  "credential",
  "凭据",
  "certificate",
  "证书管理",
];

/** 默认禁按的组合键（归一化后比对）：锁屏与安全注意序列。 */
export const DEFAULT_BLOCKED_KEYS: readonly string[] = [
  "ctrl+alt+delete",
  "super+l",
];

export interface ComputerGuardConfig {
  blocked_titles: string[];
  blocked_keys: string[];
  /** 开了才要求“先发授权再动手”（默认关：原有审批门已覆盖，机主按需收紧）。 */
  require_grant: boolean;
  /** 开了才要求 DISPLAY 必须是本机 Xvfb 虚拟桌面（默认关，Linux 才有意义）。 */
  require_virtual_display: boolean;
  /** 每分钟最多几次写动作（click/type/key），超了拒绝。 */
  max_actions_per_minute: number;
}

export function defaultGuardConfig(): ComputerGuardConfig {
  return {
    blocked_titles: [...DEFAULT_BLOCKED_TITLES],
    blocked_keys: [...DEFAULT_BLOCKED_KEYS],
    require_grant: false,
    require_virtual_display: false,
    max_actions_per_minute: DEFAULT_MAX_ACTIONS_PER_MINUTE,
  };
}

// ---- 小工具：0600 原子写 JSON 与损坏备份（与 circles.ts / hitl.ts 同口径） ----

function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true });
}

function backupCorrupt(path: string): void {
  try {
    renameSync(path, `${path}.bak-${Date.now()}`);
  } catch {
    // 备份失败也不拦运行。
  }
}

function writeJsonAtomic(home: string, name: string, data: unknown): void {
  ensureHome(home);
  const path = join(home, name);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // 部分文件系统不支持 chmod，不拦。
  }
  renameSync(tmp, path);
}

function readJsonFile<T>(home: string, name: string, fallback: T): T {
  const path = join(home, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    backupCorrupt(path);
    return fallback;
  }
}

/** 标题是否命中禁碰名单（子串匹配，大小写不敏感；空标题不命中）。 */
export function matchesBlocklist(title: string, list: readonly string[]): boolean {
  const hay = title.trim().toLowerCase();
  if (!hay) return false;
  for (const needle of list) {
    const n = needle.trim().toLowerCase();
    if (n && hay.includes(n)) return true;
  }
  return false;
}

/** 按键是否在禁按名单里（归一化：小写、去空格、`+` 两边不留空）。 */
export function normalizeKeyName(key: string): string {
  return key.trim().toLowerCase().replace(/\s*\+\s*/g, "+");
}

export function isBlockedKey(key: string, list: readonly string[]): boolean {
  const norm = normalizeKeyName(key);
  if (!norm) return false;
  return list.some((k) => normalizeKeyName(k) === norm);
}

// ---- 守卫配置 ----

export function readGuardConfig(home: string | null): ComputerGuardConfig {
  const defaults = defaultGuardConfig();
  if (home === null) return defaults;
  const raw = readJsonFile<Partial<ComputerGuardConfig>>(home, GUARD_CONFIG_NAME, {});
  if (typeof raw !== "object" || raw === null) return defaults;
  return {
    blocked_titles: Array.isArray(raw.blocked_titles)
      ? raw.blocked_titles.filter((t): t is string => typeof t === "string")
      : defaults.blocked_titles,
    blocked_keys: Array.isArray(raw.blocked_keys)
      ? raw.blocked_keys.filter((k): k is string => typeof k === "string")
      : defaults.blocked_keys,
    require_grant: typeof raw.require_grant === "boolean" ? raw.require_grant : defaults.require_grant,
    require_virtual_display: typeof raw.require_virtual_display === "boolean"
      ? raw.require_virtual_display
      : defaults.require_virtual_display,
    max_actions_per_minute: Number.isInteger(raw.max_actions_per_minute) && (raw.max_actions_per_minute as number) > 0
      ? (raw.max_actions_per_minute as number)
      : defaults.max_actions_per_minute,
  };
}

export function writeGuardConfig(home: string, patch: Partial<ComputerGuardConfig>): ComputerGuardConfig {
  const next = { ...readGuardConfig(home), ...patch };
  writeJsonAtomic(home, GUARD_CONFIG_NAME, next);
  return next;
}

// ---- 授权（grants）：按会话发、可撤销、可过期 ----

export interface ComputerGrant {
  id: string;
  /** 不填 session_id = 整机授权；填了只认该会话。 */
  scope: { session_id?: string };
  label?: string;
  created_at: string;
  /** null = 不过期。 */
  expires_at: string | null;
  revoked: boolean;
  revoked_reason?: string;
}

function readGrants(home: string): ComputerGrant[] {
  const list = readJsonFile<unknown>(home, GRANTS_NAME, []);
  if (!Array.isArray(list)) return [];
  return list.filter((g): g is ComputerGrant => (
    typeof g === "object" && g !== null && typeof (g as ComputerGrant).id === "string"
  ));
}

function writeGrants(home: string, list: ComputerGrant[]): void {
  writeJsonAtomic(home, GRANTS_NAME, list);
}

export function issueGrant(
  home: string,
  opts: { sessionId?: string; minutes?: number; label?: string } = {},
): ComputerGrant {
  const now = new Date();
  const minutes = opts.minutes ?? DEFAULT_GRANT_MINUTES;
  const grant: ComputerGrant = {
    id: `cg-${randomBytes(4).toString("hex")}`,
    scope: opts.sessionId ? { session_id: opts.sessionId } : {},
    label: opts.label,
    created_at: now.toISOString(),
    expires_at: minutes > 0 ? new Date(now.getTime() + minutes * 60_000).toISOString() : null,
    revoked: false,
  };
  const list = readGrants(home);
  list.push(grant);
  writeGrants(home, list);
  return grant;
}

export function revokeGrant(home: string, id: string, reason?: string): boolean {
  const list = readGrants(home);
  const grant = list.find((g) => g.id === id);
  if (!grant || grant.revoked) return false;
  grant.revoked = true;
  if (reason) grant.revoked_reason = reason;
  writeGrants(home, list);
  return true;
}

export function listGrants(home: string): ComputerGrant[] {
  return readGrants(home).slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function isGrantActive(grant: ComputerGrant, now = new Date()): boolean {
  if (grant.revoked) return false;
  if (grant.expires_at && now >= new Date(grant.expires_at)) return false;
  return true;
}

/**
 * 找一张当前能用的授权：先找会话专属的，再找整机授权。
 * 授权被撤销或过期一律不算（惰性判断，不改文件）。
 */
export function findActiveGrant(home: string, sessionId: string | null, now = new Date()): ComputerGrant | null {
  const list = readGrants(home).filter((g) => isGrantActive(g, now));
  if (sessionId) {
    const scoped = list.find((g) => g.scope.session_id === sessionId);
    if (scoped) return scoped;
  }
  return list.find((g) => !g.scope.session_id) ?? null;
}

// ---- 活动账本（append-only jsonl，0600；输入文本只记长度，绝不记内容） ----

export type ComputerActionName =
  | "computer_click"
  | "computer_type"
  | "computer_key"
  | "computer_screenshot"
  | "computer_windows";

export interface ComputerActivityEntry {
  time: string;
  action: ComputerActionName;
  x?: number;
  y?: number;
  button?: string;
  key?: string;
  text_len?: number;
  /** 前台窗口标题（截断 60 字）；拿不到时不填。 */
  window?: string;
  grant_id?: string;
  session_id?: string;
  result: "ok" | "refused" | "error";
  reason?: string;
  /** 前台窗口能不能确定：后端报不出来时记 unknown（不静默跳过检查）。 */
  foreground?: "known" | "unknown";
}

export function recordComputerActivity(home: string | null, entry: ComputerActivityEntry): void {
  if (home === null) return;
  try {
    ensureHome(home);
    const path = join(home, ACTIVITY_NAME);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // 账本写失败不破坏本次操作。
  }
}

export function listComputerActivity(home: string, limit = 20): ComputerActivityEntry[] {
  const path = join(home, ACTIVITY_NAME);
  if (!existsSync(path)) return [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: ComputerActivityEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ComputerActivityEntry;
      if (parsed && typeof parsed.action === "string" && typeof parsed.time === "string") out.push(parsed);
    } catch {
      // 坏行跳过。
    }
  }
  return out.slice(-Math.max(1, limit)).reverse();
}

/** 最近 windowMs 毫秒内的动作条数（限流用，含被拒的尝试）。 */
export function countRecentActivity(home: string, windowMs = 60_000, now = Date.now()): number {
  const path = join(home, ACTIVITY_NAME);
  if (!existsSync(path)) return 0;
  let count = 0;
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { time?: string };
        if (parsed.time && now - new Date(parsed.time).getTime() <= windowMs) count += 1;
      } catch {
        // 坏行跳过。
      }
    }
  } catch {
    return 0;
  }
  return count;
}

// ---- 虚拟桌面（Xvfb，Linux 才有） ----

export interface ComputerDisplayRecord {
  display: string;
  pid: number;
  started_at: string;
}

export function readDisplayRecord(home: string | null): ComputerDisplayRecord | null {
  if (home === null) return null;
  const raw = readJsonFile<Partial<ComputerDisplayRecord> | null>(home, DISPLAY_RECORD_NAME, null);
  if (!raw || typeof raw.display !== "string" || typeof raw.pid !== "number") return null;
  return { display: raw.display, pid: raw.pid, started_at: typeof raw.started_at === "string" ? raw.started_at : "" };
}

function writeDisplayRecord(home: string, record: ComputerDisplayRecord): void {
  writeJsonAtomic(home, DISPLAY_RECORD_NAME, record);
}

export function clearDisplayRecord(home: string): void {
  try {
    rmSync(join(home, DISPLAY_RECORD_NAME), { force: true });
  } catch {
    // 删不掉不拦。
  }
}

export interface VirtualDisplayDeps {
  platform?: string;
  /** 默认在 PATH 里找 Xvfb；测试可注入。 */
  whichXvfb?: () => string | null;
  /** 默认 spawn("Xvfb", [display], { detached: true, stdio: "ignore" })；测试可注入。 */
  spawnXvfb?: (display: string) => ChildProcess;
  /** 默认 process.kill(pid, 0) 探活；测试可注入。 */
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  display?: string;
}

function defaultWhichXvfb(): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "Xvfb");
    try {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // 继续找。
    }
  }
  return null;
}

/**
 * 起一个 Xvfb 虚拟桌面并记下 display + pid。只支持 Linux；Xvfb 没装
 * 或该 display 已被占用时直接报错，不静默回落到真机桌面。
 */
export function startVirtualDisplay(home: string, deps: VirtualDisplayDeps = {}): ComputerDisplayRecord {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") {
    throw new ComputerGuardError("虚拟桌面只支持 Linux（Xvfb）");
  }
  const display = deps.display ?? VIRTUAL_DISPLAY;
  const xvfb = (deps.whichXvfb ?? defaultWhichXvfb)();
  if (!xvfb) {
    throw new ComputerGuardError("找不到 Xvfb（Debian/Ubuntu 用 sudo apt-get install xvfb）");
  }
  const existing = readDisplayRecord(home);
  if (existing && existing.display === display) {
    const alive = (deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } }))(existing.pid);
    if (alive) throw new ComputerGuardError(`虚拟桌面 ${display} 已经在跑（pid ${existing.pid}），先停掉再起`);
  }
  const child = (deps.spawnXvfb ?? ((d: string) => {
    const c = spawn("Xvfb", [d], { detached: true, stdio: "ignore" });
    c.unref();
    return c;
  }))(display);
  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new ComputerGuardError("启动 Xvfb 失败：没拿到进程号");
  }
  const record: ComputerDisplayRecord = { display, pid, started_at: new Date().toISOString() };
  writeDisplayRecord(home, record);
  return record;
}

export function stopVirtualDisplay(home: string, deps: VirtualDisplayDeps = {}): boolean {
  const record = readDisplayRecord(home);
  if (!record) return false;
  const kill = deps.kill ?? ((pid: number) => { try { process.kill(pid, "SIGTERM"); } catch { /* 已经死了 */ } });
  try {
    kill(record.pid);
  } catch {
    // 杀不掉也清记录，不拦。
  }
  clearDisplayRecord(home);
  return true;
}

export function displayStatus(home: string, deps: VirtualDisplayDeps = {}): { record: ComputerDisplayRecord | null; alive: boolean } {
  const record = readDisplayRecord(home);
  if (!record) return { record: null, alive: false };
  const alive = (deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } }))(record.pid);
  return { record, alive };
}

// ---- 守卫检查：写动作（click/type/key）执行前必过 ----

export interface ComputerActionRequest {
  action: "computer_click" | "computer_type" | "computer_key";
  x?: number;
  y?: number;
  button?: string;
  /** 按键原文（只做禁按名单比对，不记账本）。 */
  key?: string;
  /** 输入文本长度（只记长度，不记内容）。 */
  textLen?: number;
  sessionId?: string | null;
  /** 当前 DISPLAY（tools.ts 传 process.env.DISPLAY；测试可注入）。 */
  display?: string;
  /** 读前台窗口标题；后端报不出来时返回 null（检查跳过并记 unknown）。 */
  getForegroundTitle?: () => Promise<string | null>;
}

export interface ComputerGuardDecision {
  grantId?: string;
  foregroundTitle?: string | null;
  foregroundKnown: boolean;
}

/**
 * 写动作放行检查。顺序：禁按按键 → 前台窗口禁碰名单 → 授权（开了才查）
 * → 虚拟桌面（开了才查）→ 每分钟限流。任一不过都抛 ComputerGuardError，
 * 调用方记 refused 账本与 computer_refused 事件后再转 ToolError。
 * home 为 null 时只有内存里的默认禁碰名单生效（文件账本无处可放）——
 * 测试 ctx 没 home 时行为不变；生产运行 agent 一律带 home。
 */
export async function checkComputerAction(
  home: string | null,
  req: ComputerActionRequest,
): Promise<ComputerGuardDecision> {
  const config = readGuardConfig(home);
  if (req.action === "computer_key" && req.key !== undefined && isBlockedKey(req.key, config.blocked_keys)) {
    throw new ComputerGuardError(`禁按的组合键：${req.key}（在禁按名单里，防误锁屏/误触系统键）`);
  }
  let foregroundTitle: string | null = null;
  let foregroundKnown = false;
  if (req.getForegroundTitle) {
    try {
      foregroundTitle = await req.getForegroundTitle();
    } catch {
      foregroundTitle = null;
    }
    foregroundKnown = foregroundTitle !== null;
    if (foregroundTitle && matchesBlocklist(foregroundTitle, config.blocked_titles)) {
      throw new ComputerGuardError(`当前前台窗口“${foregroundTitle.slice(0, MAX_TITLE_LEN)}”在禁碰名单里，不动手`);
    }
  }
  let grantId: string | undefined;
  if (config.require_grant) {
    if (home === null) {
      throw new ComputerGuardError("开了授权检查但没有家目录，无法校验授权（先发授权：nyra computer grant issue）");
    }
    const grant = findActiveGrant(home, req.sessionId ?? null);
    if (!grant) {
      throw new ComputerGuardError("没有可用的电脑操作授权（先发授权：nyra computer grant issue）");
    }
    grantId = grant.id;
  }
  if (config.require_virtual_display) {
    if (home === null) {
      throw new ComputerGuardError("开了虚拟桌面检查但没有家目录，无法校验（先起虚拟桌面：nyra computer display start）");
    }
    const record = readDisplayRecord(home);
    if (!record || req.display !== record.display) {
      throw new ComputerGuardError(
        `只允许在虚拟桌面 ${record ? record.display : VIRTUAL_DISPLAY} 上操作（先起虚拟桌面：nyra computer display start）`,
      );
    }
  }
  if (home !== null && countRecentActivity(home, 60_000) >= config.max_actions_per_minute) {
    throw new ComputerGuardError(`一分钟内电脑操作已满 ${config.max_actions_per_minute} 次，稍后再试`);
  }
  return { grantId, foregroundTitle, foregroundKnown };
}
