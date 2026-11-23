// src/cronMaturity.ts — G-P1-38：cron 的成熟语义（Hermes cron/* 借鉴）。
//
// 三件确定性的事：
//   1. 漏跑补跑：守护进程停过一段时间后，到点的定时触发器按策略处理——
//      catch_up "once" 只补跑一次（最近一次漏掉的），其余漏掉的记一笔
//      missed ×N；"skip" 直接跳到下一档，漏掉的全记 missed ×N。
//      统计窗口可配（默认 120 分钟，上限 1440）；从触发器第一次被记
//      lastFired 之后才开始算漏跑——没跑过一次的触发器不算“漏过”。
//   2. 配额 hold：成本上限触顶（cost-pauses.json 里有本月未决暂停）时，
//      定时触发与事件触发全部挂起，并打一个 quota_hold_until 戳；戳过期
//      后再查暂停——暂停还在就续戳，暂停已解除就放行并记一笔释放。
//      hold 只拦自动触发，不拦机主手动跑工作流。
//   3. 事故账：漏跑 / 补跑 / 配额 hold / 失败统一记进一份事故账本
//      `~/.nyra/cron-incidents.jsonl`（append-only，0600，最多留 500 条），
//      `nyra cron incidents` 可查。
//
// 本模块是叶子：只引 node 内置。cron 匹配（5 字段）原来在
// workflowTriggers.ts，本批挪到这里，workflowTriggers 反向 import
// （threads.ts 与测试仍从 workflowTriggers import cronMatches，
// 那里做 re-export，调用方不用改）。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export class CronMaturityError extends Error {
  constructor(message: string) { super(message); this.name = "CronMaturityError"; }
}

// ---- cron：5 字段（分 时 日 月 周），只认数字、*、,、-、/ ----

const CRON_FIELD_RE = /^[0-9*,/-]+$/;

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      const n = Number(part.slice(slash + 1));
      if (!Number.isInteger(n) || n < 1) return null;
      step = n;
    }
    let lo: number; let hi: number;
    if (range === "" || range === "*") { lo = min; hi = max; }
    else if (/^\d+$/.test(range)) { lo = Number(range); hi = lo; }
    else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) return null;
      lo = Number(m[1]); hi = Number(m[2]);
      if (lo > hi) return null;
    }
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/**
 * cron 是否匹配这一分钟。日（月）与周（日）按标准 cron 规则：只限制了
 * 一边就按那一边算，两边都限制了任一边命中即可，两边都不限制即命中。
 * 解析失败返回 false（守护进程里跳过、不炸轮询）。
 */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((p) => !CRON_FIELD_RE.test(p))) return false;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dowRaw = parseCronField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return false;
  // 周日 7 当 0。
  const dow = new Set([...dowRaw].map((v) => (v === 7 ? 0 : v)));
  if (!minute.has(date.getMinutes()) || !hour.has(date.getHours()) || !month.has(date.getMonth() + 1)) return false;
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";
  const domHit = dom.has(date.getDate());
  const dowHit = dow.has(date.getDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/** "YYYY-MM-DDTHH:mm"（本地时间，与 workflowTriggers 的 lastFired 同款）。 */
export function minuteKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** minuteKey 的逆运算；格式不对或值越界返回 null（不抛错，调用方当“没记过”处理）。 */
export function parseMinuteKey(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  const hour = Number(m[4]); const minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  // Date 会把越界值 rollover（例如 2 月 30 日变成 3 月 2 日），须逐字段核对。
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
    || d.getHours() !== hour || d.getMinutes() !== minute) return null;
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 漏掉的 cron 分钟：cron 匹配、且在 (anchor, now) 开区间里的分钟（不含
 * 当前这一分钟——当前分钟走正常触发路径）。anchor 为 null 时返回 []。
 * 枚举按分钟步进；调用方须先把 anchor 钳进窗口（默认 120 分钟），
 * 这里再加一道硬上限：超过 1440 分钟的区间直接截到最近 1440 分钟。
 */
export function missedCronMinutes(cron: string, anchor: Date | null, now: Date): Date[] {
  if (!anchor) return [];
  const out: Date[] = [];
  const start = new Date(Math.max(anchor.getTime() + 60_000, now.getTime() - 1440 * 60_000));
  // 从 anchor 之后的第一分钟开始，到 now 之前的一分钟为止。
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes());
  if (first.getTime() <= anchor.getTime()) first.setMinutes(first.getMinutes() + 1);
  const last = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  for (let t = first.getTime(); t < last.getTime(); t += 60_000) {
    const d = new Date(t);
    if (cronMatches(cron, d)) out.push(d);
  }
  return out;
}

// ---- 事故账 ----

export const CRON_INCIDENTS_FILE = "cron-incidents.jsonl";
export const MAX_CRON_INCIDENTS = 500;

export type CronIncidentKind = "missed" | "caught_up" | "quota_held" | "quota_released" | "failed";

export interface CronIncident {
  at: string;
  kind: CronIncidentKind;
  /** "workflow" | "thread"：事故来自工作流触发器还是线程 cron。 */
  source: "workflow" | "thread";
  workflow: string;
  trigger_index?: number;
  thread_id?: string;
  cron_id?: string;
  /** 漏掉 / 补跑的那一分钟（minuteKey）。 */
  scheduled_minute?: string;
  /** missed 的条数。 */
  count?: number;
  /** 补跑策略（missed / caught_up 时记）。 */
  policy?: "once" | "skip";
  /** quota_held / quota_released 时记。 */
  pause_id?: string;
  scope?: string;
  hold_until?: string;
  run_id?: string | null;
  /** failed 时记（前 200 字）。 */
  error?: string;
  /** 补充说明（例如戳续期、手动清戳的原因）。 */
  note?: string;
}

export function cronIncidentsPath(home: string): string {
  return join(home, CRON_INCIDENTS_FILE);
}

function isIncidentPathSafe(path: string): boolean {
  return !existsSync(path) || !lstatSync(path).isSymbolicLink();
}

/**
 * 记一笔事故（append-only，0600）。写盘失败不抛错——事故账本身坏了不该
 * 破坏触发流程，调用方也不用管返回值。超过上限时截到最近 MAX 条
 * （重写文件，旧文件先 rename 留底再换新）。
 */
export function appendCronIncident(home: string, entry: Omit<CronIncident, "at">): void {
  try {
    const path = cronIncidentsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    if (!isIncidentPathSafe(path)) return;
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, line, null, "utf-8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    pruneCronIncidents(home);
  } catch { /* 事故账落盘失败不破坏触发 */ }
}

function pruneCronIncidents(home: string, maxEntries = MAX_CRON_INCIDENTS): void {
  try {
    const path = cronIncidentsPath(home);
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= maxEntries) return;
    const kept = lines.slice(lines.length - maxEntries);
    const tmp = join(dirname(path), `.cron-incidents-${process.pid}`);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, kept.join("\n") + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
  } catch { /* 截断失败不破坏触发 */ }
}

/** 读事故账（新的在前）；文件不存在回 []；坏行跳过（不炸整份）。 */
export function listCronIncidents(
  home: string,
  filter?: { kind?: CronIncidentKind; workflow?: string; limit?: number },
): CronIncident[] {
  const path = cronIncidentsPath(home);
  if (!existsSync(path)) return [];
  if (lstatSync(path).isSymbolicLink()) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: CronIncident[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<CronIncident>;
      if (!row || typeof row !== "object" || typeof row.at !== "string" || typeof row.kind !== "string") continue;
      if (filter?.kind && row.kind !== filter.kind) continue;
      if (filter?.workflow && row.workflow !== filter.workflow) continue;
      out.push(row as CronIncident);
    } catch { /* 坏行跳过 */ }
  }
  out.reverse();
  const limit = filter?.limit && Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 20;
  return out.slice(0, limit);
}

// ---- 配额 hold ----

/** 成本暂停账本文件名（与 costCaps.ts 的 PAUSES_FILE 同款，不 import 它——叶子不拉求值链）。 */
export const COST_PAUSES_FILE = "cost-pauses.json";

export interface ActiveCostPause {
  id: string;
  scope: string;
  at: string;
}

/**
 * 本月有没有未决的成本暂停：cost-pauses.json 里 status 为 "paused"、
 * 且 at 与 now 同月的行。文件不存在、损坏、格式不对时一律当“没有”
 * （fail-open：暂停账本本身坏了不该把全部 cron 永久钉死；一旦 hold
 * 戳已经打出，戳本身说了算，见 workflowTriggers 的 evaluateQuotaHold）。
 */
export function findActiveCostPause(home: string, now = new Date()): ActiveCostPause | null {
  const path = join(home, COST_PAUSES_FILE);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { pauses?: unknown }).pauses)) return null;
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  for (const p of (raw as { pauses: Array<Record<string, unknown>> }).pauses) {
    if (!p || typeof p !== "object") continue;
    if (p.status !== "paused") continue;
    if (typeof p.at !== "string" || p.at.slice(0, 7) !== month) continue;
    if (typeof p.id !== "string" || typeof p.scope !== "string") continue;
    return { id: p.id, scope: p.scope, at: p.at };
  }
  return null;
}
