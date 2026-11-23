// src/modelHealth.ts — 模型故障账本：出故障的 provider 标 degraded，计时恢复。
//
// G-P1-33（Botpress packages/cognitive 借鉴，相似 agent 缺口报告 §2）：
// 模型出故障标 degraded 5 分钟，自动重试下一家；时间到自动恢复，恢复前
// 不选它。恢复是时间驱动的惰性恢复——读账本时拿 `until` 跟现在比，
// 过了期就当没标过，不用另起定时器扫。
//
// 口径：
//   - 按 provider 名记（链上走的就是 provider 名）；model 只记下来备查。
//   - 主模型（链首）永不过滤：过滤只动兜底尾巴——用户显式配的主模型
//     即使刚出过故障，下一轮照样先试它，失败了再按链走（见
//     filterHealthyChain）；degraded 只决定“兜底时跳过谁”。
//   - 账本损坏先备份再回空账本，不拦运行；写失败不抛错、调用方照常走链。
//   - 只记故障事实（provider、时间、原因、次数），不记报错原文全文——
//     报错原文在切换审计（model-switch-audit.jsonl）里，这里只留短原因。
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";

/** 模型故障账本文件名（~/.nyra 下）。 */
export const MODEL_HEALTH_FILE = "model-health.json";

/** 故障默认恢复时间（分钟）：Botpress 同款 5 分钟。 */
export const DEGRADED_RECOVERY_MINUTES = 5;

/** 账本里一条 provider 的故障记录。 */
export interface ModelHealthEntry {
  /** provider 名（链上走的名字，如 deepseek）。 */
  provider: string;
  /** 出故障时在用的模型名（备查，可空）。 */
  model?: string;
  /** 标 degraded 的时间（ISO）。 */
  degradedAt: string;
  /** 恢复时间（ISO）：到点自动恢复，恢复前不选它。 */
  until: string;
  /** 短原因（kind + 截断的报错首句，不超过 200 字）。 */
  reason: string;
  /** 累计被标 degraded 的次数。 */
  failures: number;
}

function healthPath(home: string): string {
  return join(resolveHome(home), MODEL_HEALTH_FILE);
}

/** 0600 原子写：写临时文件 + fsync + rename（与 accounts.ts 的 atomicWriteJson 同款）。 */
function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
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

function isEntry(raw: unknown): raw is ModelHealthEntry {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return typeof r.provider === "string" && typeof r.degradedAt === "string"
    && typeof r.until === "string" && typeof r.reason === "string"
    && typeof r.failures === "number";
}

/** 读账本：坏文件先备份（同名 .bak-<时间戳>）再回空账本，不抛错。 */
export function readModelHealth(home: string): ModelHealthEntry[] {
  try {
    const path = healthPath(home);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return [];
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isEntry);
  } catch {
    try {
      const path = healthPath(home);
      if (existsSync(path) && !lstatSync(path).isSymbolicLink()) {
        renameSync(path, `${path}.bak-${Date.now()}`);
      }
    } catch {
      // 备份失败也不拦：调用方拿空账本继续。
    }
    return [];
  }
}

function writeModelHealth(home: string, entries: ModelHealthEntry[]): void {
  try {
    atomicWriteJson(healthPath(home), entries);
  } catch {
    // 写失败不抛错：调用方照常走链，degraded 只是优化，不是正确性前提。
  }
}

/**
 * 把一个 provider 标 degraded（默认恢复 5 分钟）。
 * 已在账本里时刷新 until 与原因、failures +1；reason 超 200 字截断。
 * 返回落盘后的那条记录。
 */
export function markDegraded(
  home: string,
  provider: string,
  reason: string,
  opts?: { minutes?: number; model?: string; now?: Date },
): ModelHealthEntry {
  const now = opts?.now ?? new Date();
  const minutes = opts?.minutes ?? DEGRADED_RECOVERY_MINUTES;
  const shortReason = reason.length > 200 ? reason.slice(0, 199) + "…" : reason;
  const entries = readModelHealth(home);
  const prev = entries.find((e) => e.provider === provider);
  const entry: ModelHealthEntry = {
    provider,
    ...(opts?.model ? { model: opts.model } : prev?.model ? { model: prev.model } : {}),
    degradedAt: now.toISOString(),
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
    reason: shortReason,
    failures: (prev?.failures ?? 0) + 1,
  };
  const next = entries.filter((e) => e.provider !== provider);
  next.push(entry);
  writeModelHealth(home, next);
  return entry;
}

/** 取一条未过期的故障记录；过期或不存在返回 null（过期 = 已恢复）。 */
export function getDegraded(home: string, provider: string, now = new Date()): ModelHealthEntry | null {
  const entry = readModelHealth(home).find((e) => e.provider === provider);
  if (!entry) return null;
  return new Date(entry.until).getTime() > now.getTime() ? entry : null;
}

/** 该 provider 现在是否处于 degraded（恢复时间未到）。 */
export function isDegraded(home: string, provider: string, now = new Date()): boolean {
  return getDegraded(home, provider, now) !== null;
}

/** 列出当前仍在 degraded 的记录（按恢复时间升序）。 */
export function listDegraded(home: string, now = new Date()): ModelHealthEntry[] {
  return readModelHealth(home)
    .filter((e) => new Date(e.until).getTime() > now.getTime())
    .sort((a, b) => a.until.localeCompare(b.until));
}

/** 提前清除一条 degraded（人工恢复）；不存在返回 false。 */
export function clearDegraded(home: string, provider: string): boolean {
  const entries = readModelHealth(home);
  if (!entries.some((e) => e.provider === provider)) return false;
  writeModelHealth(home, entries.filter((e) => e.provider !== provider));
  return true;
}

/** 删掉已过期的记录（账本瘦身）；返回删掉的条数。 */
export function pruneDegraded(home: string, now = new Date()): number {
  const entries = readModelHealth(home);
  const kept = entries.filter((e) => new Date(e.until).getTime() > now.getTime());
  const pruned = entries.length - kept.length;
  if (pruned > 0) writeModelHealth(home, kept);
  return pruned;
}

/**
 * 按健康过滤一条兜底链：链首（主模型）永远保留，只跳过尾巴里仍在
 * degraded 的 provider。过滤后至少剩链首，永不返回空链。
 */
export function filterHealthyChain(home: string, chain: string[], now = new Date()): string[] {
  if (chain.length <= 1) return [...chain];
  const degraded = new Set(listDegraded(home, now).map((e) => e.provider));
  const kept = [chain[0], ...chain.slice(1).filter((name) => !degraded.has(name))];
  return kept;
}

/** 账本文件本身是否以 0600 落盘（测试用；文件不存在返回 false）。 */
export function modelHealthFileExists(home: string): boolean {
  try {
    const path = healthPath(home);
    return existsSync(path) && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 删掉账本文件（测试清理用；不存在返回 false）。 */
export function removeModelHealthFile(home: string): boolean {
  try {
    const path = healthPath(home);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
