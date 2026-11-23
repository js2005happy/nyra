// src/responsibilities.ts — 常驻责任制 + 无人值守强制只读（缺口 8）。
//
// 责任 = 目标 + 复查节奏 + 汇报条件 + 权限上限（永远只读）。
// 调度器从“到点跑一个任务”升级为“领一份持续责任、自己定复查节奏”：
// 守护进程每轮跑一次到期的责任，巡查只读、发现先记证据链再汇报、动手改
// 永远要等人来批——别家是“发现了就干”，Nyra 是“发现了先记、汇报了再干”。
//
// 无人值守强制只读是架构级硬约束，不是靠模型自觉：
//   - 责任没有模式字段：校验层就拒绝任何 `mode` 键，巡查没有“可写”的档位；
//   - 巡查任务以 `unattended: true` + `readonly` 入队（见 tasks.addTask），
//     写操作在 `checkApproval` 里直接拒绝（连权限规则 allow 都打不开，
//     见 src/tools.ts），并记 `patrol_write_blocked` 事件；
//   - 巡查中途 `Agent.setMode` 不得离开 readonly（纵深防御）。
// 与任务队列的区别：队列里的任务（事件触发、邮件入口、人工 `task add`）
// 是“排队等执行”，写操作挂起等人工审批（awaiting_approval）；巡查是
// “没人看着的自动跑”，所以根本不给写操作留审批口子——没人能批，就不写。
// 巡查跑完：结论进证据链（`patrol_report` 事件）+ 按汇报条件写收件箱；
// 没发现的巡查同样留一条报告事件（证据不缺席，只是不打扰人）。
import { randomBytes } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { isKnownChecker, runChecker, type CheckerInput, type CheckerResult } from "./checkers.ts";
import { loadConfig } from "./config.ts";
import { EvidenceStore } from "./evidence.ts";
import type { Provider } from "./providers.ts";
import { reviewPatrolReport, type ReviewerLike } from "./reviewer.ts";
import { RunStore } from "./runs.ts";
import { addTask, appendInbox, buildProvider, nyraHome, runOne, TASKS_DIR } from "./tasks.ts";

export class ResponsibilityError extends Error {
  constructor(message: string) { super(message); this.name = "ResponsibilityError"; }
}

export type ResponsibilityReport = "on-finding" | "always";

/** 责任生命周期：进行中 / 暂停 / 已完成 / 已取消 / 已过期。取消、完成、过期是终态。 */
export type ResponsibilityStatus = "active" | "paused" | "completed" | "cancelled" | "expired";

export const RESPONSIBILITY_STATUSES: readonly ResponsibilityStatus[] =
  ["active", "paused", "completed", "cancelled", "expired"];

export const MAX_LIST_ITEMS = 20;
export const MAX_LIST_ITEM_CHARS = 200;

export interface Responsibility {
  id: string;
  name: string;
  goal: string;
  every_seconds: number;
  report: ResponsibilityReport;
  enabled: boolean;
  workdir?: string | null;
  max_turns: number;
  last_check?: string | null;
  last_status?: string | null;
  last_summary?: string | null;
  /** 缺口 45：责任是显式对象——归属人（默认 user）、验收标准、升级条件、过期时间、生命周期。 */
  owner: string;
  done_when: string[];
  escalate_on: string[];
  expires_at: string | null;
  status: ResponsibilityStatus;
  completed_at?: string | null;
  expired_at?: string | null;
}

export interface ResponsibilityData { responsibilities: Responsibility[]; }

export const RESPONSIBILITIES_FILE = "responsibilities.json";
export const MAX_GOAL_CHARS = 8000;
export const MIN_CHECK_SECONDS = 60;

export function responsibilitiesPath(home?: string): string {
  return join(nyraHome(home), RESPONSIBILITIES_FILE);
}

export function validateResponsibility(raw: Record<string, unknown>): Responsibility {
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 100) {
    throw new ResponsibilityError("责任名不能为空且不超过 100 字符");
  }
  if (typeof raw.goal !== "string" || !raw.goal.trim() || raw.goal.length > MAX_GOAL_CHARS) {
    throw new ResponsibilityError("责任目标不能为空且不超过 8000 字符");
  }
  const every = raw.every_seconds;
  if (typeof every !== "number" || !Number.isInteger(every) || every < MIN_CHECK_SECONDS) {
    throw new ResponsibilityError("--every 必须是不小于 60 的整数秒数");
  }
  const report = (raw.report as string) ?? "on-finding";
  if (report !== "on-finding" && report !== "always") {
    throw new ResponsibilityError("汇报条件只允许 on-finding（有发现才汇报）或 always（每次都汇报）");
  }
  // 缺口 8 的硬约束：责任没有模式——巡查永远只读。任何想给巡查加模式的
  // 写法都在校验层拒绝，不留“可写巡查”的口子。
  if ("mode" in raw && raw.mode !== undefined && raw.mode !== null) {
    throw new ResponsibilityError("巡查责任没有模式——巡查永远只读，写操作须有人在场审批");
  }
  if (raw.workdir !== null && raw.workdir !== undefined && typeof raw.workdir !== "string") {
    throw new ResponsibilityError("工作目录无效");
  }
  const maxTurns = (raw.max_turns as number) ?? 20;
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new ResponsibilityError("--max-turns 必须为正整数");
  }
  // 缺口 45：责任对象的四件新东西——归属人、验收标准、升级条件、过期时间。
  // 验收标准里带冒号的按 checker 规格校验（须是已知 checker，如 file-exists:报告.md），
  // 不带冒号的是纯文本条目，只作人工验收口径，complete 时须人 --yes 确认。
  const owner = (raw.owner as string) ?? "user";
  if (typeof owner !== "string" || !owner.trim() || owner.trim().length > 100) {
    throw new ResponsibilityError("责任归属人不能为空且不超过 100 字符");
  }
  const doneWhen = parseListField(raw.done_when, "done_when");
  for (const item of doneWhen) {
    if (item.includes(":") && !isKnownChecker(item)) {
      throw new ResponsibilityError(`验收标准不是已知 checker：${item}`);
    }
  }
  const escalateOn = parseListField(raw.escalate_on, "escalate_on");
  const expiresRaw = (raw.expires_at as string | null) ?? null;
  let expiresAt: string | null = null;
  if (expiresRaw !== null && expiresRaw !== undefined) {
    if (typeof expiresRaw !== "string" || Number.isNaN(new Date(expiresRaw).getTime())) {
      throw new ResponsibilityError("--expires-at 须是 ISO 时间（如 2026-12-31T00:00:00Z）");
    }
    expiresAt = new Date(expiresRaw).toISOString();
  }
  // 老行回填：没写 status 的按 enabled 推断（禁用过当暂停，没禁用过当进行中）；
  // 已终态的以 status 为准，不再看 enabled。
  const rawStatus = (raw.status as string) ?? "";
  const status: ResponsibilityStatus = (RESPONSIBILITY_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as ResponsibilityStatus)
    : (raw.enabled === false ? "paused" : "active");
  return {
    id: typeof raw.id === "string" && /^[0-9a-f]{16}$/.test(raw.id) ? raw.id : randomBytes(8).toString("hex"),
    name: raw.name.trim(),
    goal: raw.goal.trim(),
    every_seconds: every,
    report,
    enabled: raw.enabled !== false,
    workdir: (raw.workdir as string | null) ?? null,
    max_turns: maxTurns,
    last_check: (raw.last_check as string | null) ?? null,
    last_status: (raw.last_status as string | null) ?? null,
    last_summary: (raw.last_summary as string | null) ?? null,
    owner: owner.trim(),
    done_when: doneWhen,
    escalate_on: escalateOn,
    expires_at: expiresAt,
    status,
    completed_at: (raw.completed_at as string | null) ?? null,
    expired_at: (raw.expired_at as string | null) ?? null,
  };
}

/** 逗号分隔或数组两种写法都认；空串、超长、超 20 条都拒绝。 */
export function parseListField(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value)
    ? value.map((v) => String(v ?? "").trim())
    : String(value).split(",").map((v) => v.trim());
  const cleaned = items.filter(Boolean);
  if (cleaned.length > MAX_LIST_ITEMS) {
    throw new ResponsibilityError(`${field} 最多 ${MAX_LIST_ITEMS} 条`);
  }
  for (const item of cleaned) {
    if (item.length > MAX_LIST_ITEM_CHARS) {
      throw new ResponsibilityError(`${field} 每条不超过 ${MAX_LIST_ITEM_CHARS} 字`);
    }
  }
  return cleaned;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadResponsibilities(path?: string): ResponsibilityData {
  const p = path ?? responsibilitiesPath();
  if (!existsSync(p)) return { responsibilities: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new ResponsibilityError("责任文件损坏，已备份，请检查后重新添加");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).responsibilities)) {
    backupCorrupt(p);
    throw new ResponsibilityError("责任文件格式无效，已备份");
  }
  const responsibilities: Responsibility[] = [];
  const names = new Set<string>();
  for (const item of (raw as ResponsibilityData).responsibilities) {
    try {
      const resp = validateResponsibility(item as unknown as Record<string, unknown>);
      if (names.has(resp.name)) throw new ResponsibilityError(`已存在同名责任：${resp.name}`);
      responsibilities.push(resp);
      names.add(resp.name);
    } catch (err: unknown) {
      process.stderr.write(`跳过无效责任：${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
  }
  return { responsibilities };
}

export function saveResponsibilities(data: ResponsibilityData, path?: string): string {
  const p = path ?? responsibilitiesPath();
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = join(join(p, ".."), `.responsibilities-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, p); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
  return p;
}

export function listResponsibilities(home?: string): Responsibility[] {
  return [...loadResponsibilities(responsibilitiesPath(home)).responsibilities];
}

/** 网关 /api/responsibilities：只给元数据，不含责任目标（与事件触发器同口径）。 */
export function listResponsibilitiesPublic(home?: string): Array<Pick<Responsibility, "id" | "name" | "every_seconds" | "report" | "enabled" | "last_check" | "last_status" | "status" | "owner">> {
  return listResponsibilities(home).map((r) => ({
        id: r.id, name: r.name, every_seconds: r.every_seconds, report: r.report,
        enabled: r.enabled, last_check: r.last_check ?? null, last_status: r.last_status ?? null,
        status: r.status, owner: r.owner,
      }));
}

export function addResponsibility(data: ResponsibilityData, raw: Record<string, unknown>): Responsibility {
  const cleaned = validateResponsibility(raw);
  if (data.responsibilities.some((r) => r.name === cleaned.name)) throw new ResponsibilityError(`已存在同名责任：${cleaned.name}`);
  data.responsibilities.push(cleaned);
  return cleaned;
}

/**
 * 缺口 45 深化：建好后改复查节奏 / 汇报规则 / 升级条件 / 过期时间 / 归属人。
 * 改完重跑 validateResponsibility 全量校验（--every 仍须 ≥60 秒、验收标准仍
 * 须是已知 checker、--expires-at 仍须是 ISO 时间），终态责任（已完成/已过期/
 * 已取消）拒绝改——终态是终态，改它等于改历史。
 */
export function updateResponsibility(data: ResponsibilityData, name: string, patch: Record<string, unknown>): Responsibility {
  const idx = data.responsibilities.findIndex((r) => r.name === name);
  if (idx < 0) throw new ResponsibilityError(`没有这个责任：${name}`);
  const current = data.responsibilities[idx]!;
  if (current.status === "completed" || current.status === "expired" || current.status === "cancelled") {
    throw new ResponsibilityError(`责任「${name}」已是终态（${current.status}），不能再改`);
  }
  const updated = validateResponsibility({ ...current, ...patch });
  data.responsibilities[idx] = updated;
  return updated;
}

/** 相对时间（“3 小时后”“2 天前”）：列表标记用，不写死绝对日期。 */
export function formatRelativeTime(targetIso: string | null, now: Date = new Date()): string {
  if (!targetIso) return "—";
  const ms = new Date(targetIso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "—";
  const abs = Math.abs(ms);
  const unit = abs < 60_000 ? "秒" : abs < 3_600_000 ? "分" : abs < 86_400_000 ? "小时" : "天";
  const n = abs < 60_000 ? Math.floor(abs / 1000)
    : abs < 3_600_000 ? Math.floor(abs / 60_000)
    : abs < 86_400_000 ? Math.floor(abs / 3_600_000)
    : Math.floor(abs / 86_400_000);
  return ms >= 0 ? `${n}${unit}后` : `${n}${unit}前`;
}

/** 下次巡查标记：只有进行中的责任才有下次巡查；没巡查过的是待首次巡查。 */
export function nextCheckLabel(resp: Responsibility, now: Date = new Date()): string {
  if (resp.status !== "active") return "—";
  if (!resp.last_check) return "待首次巡查";
  const next = new Date(new Date(resp.last_check).getTime() + resp.every_seconds * 1000);
  return `下次巡查 ${formatRelativeTime(next.toISOString(), now)}`;
}

/** 到期标记：没设过期时间的责任不过期。 */
export function expiryLabel(resp: Responsibility, now: Date = new Date()): string {
  if (!resp.expires_at) return "不过期";
  return `到期 ${formatRelativeTime(resp.expires_at, now)}`;
}

export function removeResponsibility(data: ResponsibilityData, name: string): boolean {
  const idx = data.responsibilities.findIndex((r) => r.name === name);
  if (idx < 0) return false;
  data.responsibilities.splice(idx, 1);
  return true;
}

export function setResponsibilityEnabled(data: ResponsibilityData, name: string, enabled: boolean): boolean {
  const resp = data.responsibilities.find((r) => r.name === name);
  if (!resp) return false;
  resp.enabled = enabled;
  return true;
}

/**
 * 生命周期事件没有运行上下文时走证据文件（与审阅队列的 recordReviewEvent
 * 同款口径）：不记目标全文、不记绝对路径，只记责任 id、名字与状态变化。
 * 有运行上下文的调用方（如巡查里的升级）直接用 RunStore.appendEvent。
 */
export function recordResponsibilityEvent(
  home: string | undefined,
  type: string,
  fields: Record<string, unknown>,
): void {
  try {
    const h = nyraHome(home);
    const lines = [`事件：${type}`, `时间：${new Date().toISOString()}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) lines.push(`${k}：${String(v).slice(0, 200)}`);
    }
    new EvidenceStore(join(h, "evidence"), "responsibility").save(
      "responsibility",
      `responsibility://${String(fields.responsibility_id ?? "unknown")}`,
      lines.join("\n"),
    );
  } catch { /* 审计写盘失败不拦操作，与信任阶梯审计同款口径 */ }
}

/** 状态机：暂停/恢复/取消。完成与过期走专用函数（完成要验 done_when，过期由 sweep 扫）。 */
export function setResponsibilityStatus(
  data: ResponsibilityData,
  name: string,
  to: ResponsibilityStatus,
  home?: string,
): { from: ResponsibilityStatus; to: ResponsibilityStatus } {
  const resp = data.responsibilities.find((r) => r.name === name);
  if (!resp) throw new ResponsibilityError(`没有名为 ${name} 的责任`);
  if (to !== "paused" && to !== "active" && to !== "cancelled") {
    throw new ResponsibilityError(`状态只能切到 paused（暂停）/ active（恢复）/ cancelled（取消），完成请走 complete、过期由系统扫`);
  }
  const from = resp.status;
  if (from === "completed" || from === "cancelled" || from === "expired") {
    throw new ResponsibilityError(`责任「${name}」已是终态 ${from}，不能再切状态`);
  }
  if (from === to) return { from, to };
  resp.status = to;
  resp.enabled = to !== "paused";
  recordResponsibilityEvent(home, to === "paused" ? "responsibility_paused" : to === "cancelled" ? "responsibility_cancelled" : "responsibility_resumed", {
    responsibility_id: resp.id, responsibility_name: resp.name,
  });
  return { from, to };
}

/** 到期扫一遍：进行中/暂停的责任过了 expires_at 就自动失效，不永久驻留记忆。 */
export function sweepExpiredResponsibilities(
  data: ResponsibilityData,
  now: Date = new Date(),
  home?: string,
): Responsibility[] {
  const expired: Responsibility[] = [];
  for (const resp of data.responsibilities) {
    if ((resp.status !== "active" && resp.status !== "paused") || !resp.expires_at) continue;
    if (new Date(resp.expires_at).getTime() > now.getTime()) continue;
    resp.status = "expired";
    resp.expired_at = now.toISOString();
    expired.push(resp);
    recordResponsibilityEvent(home, "responsibility_expired", {
      responsibility_id: resp.id, responsibility_name: resp.name,
    });
  }
  return expired;
}

/**
 * 完成门：done_when 全过才标完成（复用缺口 29 的 checker，确定性、不调模型）。
 * 带冒号的条目按 checker 跑；纯文本条目程序验不了，须人 --yes 人工确认（确认本身
 * 记进事件，事后可查是谁确认的）；没有验收标准时同样须 --yes。checker 不过直接拒绝。
 */
export function completeResponsibility(
  data: ResponsibilityData,
  name: string,
  opts: { home?: string; workdir: string; confirmHuman?: boolean },
): { responsibility: Responsibility; results: CheckerResult[]; humanConfirmed: boolean } {
  const resp = data.responsibilities.find((r) => r.name === name);
  if (!resp) throw new ResponsibilityError(`没有名为 ${name} 的责任`);
  if (resp.status === "completed") throw new ResponsibilityError(`责任「${name}」已完成`);
  if (resp.status === "cancelled" || resp.status === "expired") {
    throw new ResponsibilityError(`责任「${name}」已是终态 ${resp.status}，不能标完成`);
  }
  const input: CheckerInput = {
    workdir: resp.workdir ?? opts.workdir,
    changedFiles: [], diffStat: null,
    title: resp.name, summary: resp.goal,
    outputText: resp.last_summary ?? "", trajectory: [], spentUsd: null,
  };
  const results: CheckerResult[] = [];
  let humanNeeded = resp.done_when.length === 0;
  for (const item of resp.done_when) {
    if (!item.includes(":")) { humanNeeded = true; continue; }
    const result = runChecker(item, input);
    results.push(result);
    if (!result.passed) {
      throw new ResponsibilityError(`验收未通过：${item}——${result.detail}`);
    }
  }
  const humanConfirmed = humanNeeded ? (opts.confirmHuman ?? false) : false;
  if (humanNeeded && !opts.confirmHuman) {
    throw new ResponsibilityError(`责任「${name}」有 ${resp.done_when.length === 0 ? "0 条验收标准" : "纯文本验收标准"}，程序验不了，须人工确认（complete --yes）才能标完成`);
  }
  resp.status = "completed";
  resp.completed_at = new Date().toISOString();
  const passed = results.filter((r) => r.passed).length;
  recordResponsibilityEvent(opts.home, "responsibility_completed", {
    responsibility_id: resp.id, responsibility_name: resp.name,
    checks_passed: passed, checks_failed: results.length - passed,
    human_confirmed: humanConfirmed,
  });
  return { responsibility: resp, results, humanConfirmed };
}

/** 升级条件命中判定：用户写明的子串（不区分大小写），命中任一条即升级——不是模型自己判断。 */
export function matchEscalationConditions(resp: Responsibility, text: string): string[] {
  if (!resp.escalate_on.length || !text) return [];
  const lower = text.toLowerCase();
  return resp.escalate_on.filter((c) => lower.includes(c.toLowerCase()));
}

export function isResponsibilityDue(resp: Responsibility, now: Date = new Date()): boolean {
  if (resp.enabled === false) return false;
  // 缺口 45：只有进行中的责任才到期巡查——暂停/完成/取消/过期都不跑。
  if (resp.status !== "active") return false;
  if (!resp.last_check) return true;
  const last = new Date(resp.last_check);
  if (Number.isNaN(last.getTime())) return true;
  return (now.getTime() - last.getTime()) / 1000 >= resp.every_seconds;
}

export function dueResponsibilities(data: ResponsibilityData, now: Date = new Date()): Responsibility[] {
  return data.responsibilities.filter((r) => isResponsibilityDue(r, now));
}

/** 巡查提示词：目标 + 只读硬约束 + 结论格式（最后一行固定写法，供解析）。 */
export function buildPatrolPrompt(resp: Responsibility): string {
  return [
    `你是 Nyra 的巡查员，正在执行常驻责任「${resp.name}」。`,
    `目标：${resp.goal}`,
    `规则（硬约束，不是建议）：`,
    `1. 只读巡查：你只能读取文件、联网查询、调用只读工具；任何写入、发送、执行命令都会被系统直接拒绝，不要尝试。`,
    `2. 发现问题先记录、再汇报，不要直接动手改；需要动手改的，写进结论里等人来批。`,
    `3. 结束时用最后一行给出结论，格式固定为：「巡查结论：有发现」或「巡查结论：无发现」。`,
    `4. 有发现时，在结论前列出每条发现（一行一条，以“- ”开头），只写事实与证据，不写推测。`,
  ].join("\n");
}

const PATROL_CONCLUSION_RE = /^巡查结论：(有发现|无发现)\s*$/;

/**
* 解析巡查结论：取最后一个结论行；没有结论行时按“有发现”处理——
* 宁可多汇报一次，也不让一次没结论的巡查悄悄过去（fail-closed 向汇报）。
*/
export function parsePatrolConclusion(output: string): boolean {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PATROL_CONCLUSION_RE.exec(lines[i].trim());
    if (m) return m[1] === "有发现";
  }
  return true;
}

export interface PatrolResult {
  name: string;
  status: string;
  summary: string;
  runId: string | null;
  hasFindings: boolean;
  reported: boolean;
  /** 缺口 45：命中用户写明的升级条件时进审阅队列等人批（不是模型自己决定要不要打扰人）。 */
  escalated: boolean;
  escalationItemId: string | null;
}

/**
* 跑一次巡查：经任务队列落盘（run 记录 + 证据链），只读、无人值守。
* 结论进 `patrol_report` 事件；按汇报条件写收件箱（没发现的巡查不打扰人，
* 但证据链里同样留一条报告事件）。
*/
export async function runPatrol(
  resp: Responsibility,
  opts: { home: string; workdir: string; provider?: Provider; config?: Record<string, unknown> | null; reviewerRunner?: ReviewerLike | null },
): Promise<PatrolResult> {
  const home = opts.home;
  const workdir = opts.workdir;
  const config = opts.config ?? loadConfig(home);
  const provider = opts.provider ?? buildProvider(config, home)[0];
  const store = new RunStore(join(nyraHome(home), TASKS_DIR));
  const state = addTask(buildPatrolPrompt(resp), {
      workdir, mode: "readonly", unattended: true,
      maxTurns: resp.max_turns, store, config, home,
    });
  const [final, output] = await runOne(state, {
      store, provider, config, interactive: false, home, quietInbox: true,
    });
  // 只读巡查不应走到审批：如果挂起了，说明有写操作绕过了只读拒绝——
  // 大声报错，不要把它当成一次“有发现”汇报。
  if (final.status === "awaiting_approval") {
    throw new ResponsibilityError(`巡查「${resp.name}」意外挂起等审批（只读巡查不应走到审批）`);
  }
  const hasFindingsBeforeReview = parsePatrolConclusion(output);
  // 缺口 10：巡查结论先过一层独立审查再汇报（缺口 8 的巡查报告原先由模型
  // 自己写、自己判）。审查结论进 reviewer_verdict 事件；审查拦截（结论与
  // 发现不符、有发现被掩盖、审查失败）时按“有发现”处理（fail-closed 向汇报）。
  // 审查层未开启时 reviewPatrolReport 直接返回 skipped，不调模型、不记事件。
  let hasFindings = hasFindingsBeforeReview;
  const review = await reviewPatrolReport({
    config, goal: resp.goal, output, hasFindings: hasFindingsBeforeReview, home,
    ...(opts.reviewerRunner !== undefined ? { runner: opts.reviewerRunner } : {}),
  });
  if (review.source !== "skipped") {
    store.appendEvent(final.run_id, "reviewer_verdict", {
      tool: "patrol_report", decision: review.decision, reason: review.reason,
      reviewer_model: review.reviewerModel ?? "", rule: review.rule ?? "",
    });
    if (review.decision === "BLOCK") hasFindings = true;
  }
  const shouldReport = resp.report === "always" || hasFindings;
  store.appendEvent(final.run_id, "patrol_report", {
      responsibility_id: resp.id, responsibility_name: resp.name, run_id: final.run_id,
      findings: hasFindings, reported: shouldReport,
    });
  const firstLine = output.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  const summary = (hasFindings ? "有发现" : "无发现") + (firstLine ? `：${firstLine.slice(0, 160)}` : "");
  // 缺口 45：升级条件是用户在责任里写明的子串，巡查发现里命中了就进审阅队列
  // 等人批（来源 automation，与定时任务结果同款）；入队失败直接抛错，不让一次
  // 该升级的发现悄悄只走收件箱——巡查会记 error，下一轮还能再跑。
  let escalated = false;
  let escalationItemId: string | null = null;
  if (hasFindings) {
    const matched = matchEscalationConditions(resp, output);
    if (matched.length > 0) {
      const condition = matched[0]!;
      const findingLines = output.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("- ")).slice(0, 3);
      const { enqueueReviewItem } = await import("./reviewQueue.ts");
      const { item } = enqueueReviewItem(home, {
        source: "automation",
        title: `责任「${resp.name}」升级：命中「${condition}」`,
        summary: `巡查发现命中责任里写明的升级条件「${condition}」。${findingLines.length ? `发现：${findingLines.join("；").slice(0, 400)}` : `巡查摘要：${summary.slice(0, 200)}`}`,
        runId: final.run_id,
      });
      escalationItemId = item.id;
      escalated = true;
      store.appendEvent(final.run_id, "responsibility_escalated", {
        responsibility_id: resp.id, responsibility_name: resp.name,
        condition, item_id: item.id,
      });
    }
  }
  if (shouldReport) {
    appendInbox(final.run_id, final.status, `巡查「${resp.name}」${summary}`, home);
  }
  resp.last_check = new Date().toISOString();
  resp.last_status = final.status;
  resp.last_summary = summary.slice(0, 200);
  return {
    name: resp.name, status: final.status, summary,
    runId: final.run_id, hasFindings, reported: shouldReport,
    escalated, escalationItemId,
  };
}

/** 跑所有到期的责任（守护进程每轮调一次）；单个责任失败不破坏整轮。先扫过期，再跑到期巡查。 */
export async function runDueResponsibilities(
  data: ResponsibilityData,
  opts: { home: string; workdir: string; provider?: Provider; now?: Date },
): Promise<PatrolResult[]> {
  const now = opts.now ?? new Date();
  sweepExpiredResponsibilities(data, now, opts.home);
  const results: PatrolResult[] = [];
  for (const resp of dueResponsibilities(data, now)) {
    try {
      results.push(await runPatrol(resp, { home: opts.home, workdir: opts.workdir, provider: opts.provider }));
    } catch (err: unknown) {
      const msg = `失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      resp.last_check = now.toISOString();
      resp.last_status = "error";
      resp.last_summary = msg;
      results.push({ name: resp.name, status: "error", summary: msg, runId: null, hasFindings: false, reported: false, escalated: false, escalationItemId: null });
    }
  }
  return results;
}
