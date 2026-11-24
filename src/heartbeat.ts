// src/heartbeat.ts — 缺口 31：Heartbeat 式静默巡查 + 推断承诺。
//
// 调度器只会“到点跑任务”，接不住“收件箱有事就告诉我、没事别吵我”。
// Heartbeat 补这一层：每 agent 一个 monitor，按间隔批量检查——
// 无事安静（NO_REPLY：只记审计、不写收件箱、不发消息）；有发现先记
// 证据（~/.nyra/evidence/heartbeat/<日期>.jsonl），再写收件箱汇报。
// 检查本身只读：无人值守时同样只读，写操作与对外发送不在检查项里
// （缺口 8 的硬约束——巡查不写东西）。
//
// 推断承诺：模型从对话里推断出的短期跟进（“下周二提醒我看报价”），
// 须经用户确认一次才生效；到期提醒一次；过期自动失效——不永久进记忆，
// 与缺口 2（记忆删除）的语义一致。账本 ~/.nyra/commitments.json。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { addTask, appendInbox, loadInbox } from "./tasks.ts";
import { listKanbanTasks } from "./kanban.ts";
import { listFanouts } from "./fanout.ts";
import { listSubagentRuns } from "./resume.ts";
import { getAgentMode, recordDryRun } from "./governance.ts";
import {
  describeCheckScriptOutcome, runCheckScript, validateCheckScriptDef,
  type CheckScriptDef, type SpawnResult,
} from "./checkScript.ts";

export class HeartbeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeartbeatError";
  }
}

export type CheckKind = "inbox_unread" | "kanban_blocked" | "resume_pending" | "stale_runs" | "fanout_unfinished";
export const CHECK_KINDS: CheckKind[] = ["inbox_unread", "kanban_blocked", "resume_pending", "stale_runs", "fanout_unfinished"];

export interface HeartbeatMonitor {
  agent: string;
  intervalMinutes: number;
  enabled: boolean;
  checks: CheckKind[];
  /** 零 Token 值守：本地脚本预检（Kooyu 借鉴，见 checkScript.ts）。 */
  scripts?: CheckScriptDef[];
  /** 唤醒总开关：默认关；只对 onHit=wake 的巡检命中生效，须显式开启。 */
  wakeEnabled?: boolean;
  lastRunAt: string | null;
  lastFindings: number;
}

export interface HeartbeatStore {
  version: 1;
  monitors: HeartbeatMonitor[];
}

export interface HeartbeatFinding {
  kind: CheckKind | "check_script";
  summary: string;
  count: number;
}

export interface HeartbeatRunResult {
  agent: string;
  findings: HeartbeatFinding[];
  quiet: boolean;
  skipped: string | null;
  /** 本轮新发现（去重后）：只有这些写收件箱 / 可能唤醒。 */
  fresh: number;
  /** 本轮被指纹去重拦下的重复发现（只记审计，不重复通知）。 */
  deduped: number;
  /** 本轮唤醒主控入队的任务 run_id。 */
  woken: string[];
}

export function heartbeatsPath(home: string): string {
  return join(home, "heartbeats.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function loadJsonLedger<T>(path: string, empty: T, errorName: string): T {
  if (!existsSync(path)) return empty;
  if (lstatSync(path).isSymbolicLink()) throw new HeartbeatError(`${errorName}不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new HeartbeatError(`${errorName}损坏，已备份，请检查后恢复`);
  }
  if (!raw || typeof raw !== "object" || (raw as { version?: number }).version !== 1) {
    backupCorrupt(path);
    throw new HeartbeatError(`${errorName}格式无效，已备份`);
  }
  return raw as T;
}

function saveJsonLedger(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new HeartbeatError("账本不能是符号链接");
  const tmp = join(dirname(path), `.hb-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

export function loadHeartbeatStore(home: string): HeartbeatStore {
  return loadJsonLedger<HeartbeatStore>(heartbeatsPath(home), { version: 1, monitors: [] }, "Heartbeat 配置");
}

export function saveHeartbeatStore(home: string, store: HeartbeatStore): void {
  saveJsonLedger(heartbeatsPath(home), store);
}

// ---- 指纹去重：同一异常只通知一次 ----

export const HEARTBEAT_SEEN_FILE = "heartbeat-seen.json";
const HEARTBEAT_SEEN_KEEP = 1000;

export function heartbeatSeenPath(home: string): string {
  return join(home, HEARTBEAT_SEEN_FILE);
}

export interface HeartbeatSeenStore {
  version: 1;
  seen: Record<string, { at: string; kind: string }>;
}

/** 异常指纹：种类 + 摘要的 SHA-256 前 16 位。摘要变了（比如未读数 3→5、脚本输出变了）就是新异常。 */
export function heartbeatFingerprint(kind: string, summary: string): string {
  return `hb:${createHash("sha256").update(`${kind}\n${summary}`).digest("hex").slice(0, 16)}`;
}

/**
 * 去重账本只是通知缓存，不是安全控制：损坏就备份后从空开始，
 * 绝不能因为它坏了就破坏巡查。
 */
export function loadHeartbeatSeen(home: string): HeartbeatSeenStore {
  const p = heartbeatSeenPath(home);
  const empty: HeartbeatSeenStore = { version: 1, seen: {} };
  if (!existsSync(p)) return empty;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<HeartbeatSeenStore>;
    if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.seen || typeof raw.seen !== "object") return empty;
    return { version: 1, seen: raw.seen as Record<string, { at: string; kind: string }> };
  } catch {
    backupCorrupt(p);
    return empty;
  }
}

export function saveHeartbeatSeen(home: string, store: HeartbeatSeenStore): void {
  const keys = Object.keys(store.seen);
  if (keys.length > HEARTBEAT_SEEN_KEEP) {
    for (const k of keys.slice(0, keys.length - HEARTBEAT_SEEN_KEEP)) delete store.seen[k];
  }
  try {
    saveJsonLedger(heartbeatSeenPath(home), store);
  } catch {
    // 去重记不上不破坏巡查（下轮会再通知一次，不静默丢异常）。
  }
}

export function clearHeartbeatSeen(home: string): void {
  try { rmSync(heartbeatSeenPath(home), { force: true }); } catch { /* 没有就不清 */ }
}

/** 检查项全是只读（读收件箱、读任务板、读注册表、读运行记录），
// 巡查本身不写、不发——无人值守时这条同样成立。 */
export function runChecks(home: string, kinds: CheckKind[]): HeartbeatFinding[] {
  const findings: HeartbeatFinding[] = [];
  for (const kind of kinds) {
    if (kind === "inbox_unread") {
      // 巡查自己的通知不计入：否则每轮都把上一轮的巡查通知当成新的未读，
      // 未读数每轮涨 1，去重永远不生效（自反馈循环）。
      const unread = loadInbox(home, true).filter((i) => !String(i.run_id).startsWith("heartbeat-"));
      if (unread.length) findings.push({ kind, summary: `${unread.length} 条未读收件箱消息`, count: unread.length });
    } else if (kind === "kanban_blocked") {
      const blocked = listKanbanTasks(home, { status: "blocked" });
      if (blocked.length) findings.push({ kind, summary: `任务板有 ${blocked.length} 个熔断任务：${blocked.map((t) => t.id).join("、").slice(0, 100)}`, count: blocked.length });
    } else if (kind === "resume_pending") {
      const pending = listSubagentRuns(home, { status: "resume_pending" });
      if (pending.length) findings.push({ kind, summary: `${pending.length} 个子 agent 等续跑`, count: pending.length });
    } else if (kind === "stale_runs") {
      const stale: string[] = [];
      for (const dir of ["tasks", "runs"]) {
        try {
          const store = new RunStore(join(home, dir));
          for (const s of store.list()) {
            if (store.markStale(s.run_id).status === "interrupted") stale.push(s.run_id);
          }
        } catch { /* 目录不存在就跳过 */ }
      }
      if (stale.length) findings.push({ kind, summary: `${stale.length} 个运行已中断`, count: stale.length });
    } else if (kind === "fanout_unfinished") {
      // H-6：后台扇出“跑完了没人看”的兜底——已中断/失败的，或跑完但回填没送到的，都要人处理。
      const pending = listFanouts(home).filter((f) =>
        f.status === "interrupted" || f.status === "failed" ||
        ((f.status === "done" || f.status === "partial") && !f.delivered));
      if (pending.length) findings.push({ kind, summary: `${pending.length} 个后台扇出待处理：${pending.map((f) => `${f.id}（${f.status === "interrupted" ? "已中断" : f.status === "failed" ? "失败" : "未回填"}）`).join("、").slice(0, 200)}`, count: pending.length });
    }
  }
  return findings;
}

function appendHeartbeatAudit(home: string, agent: string, findings: HeartbeatFinding[], extra?: { fresh?: number; deduped?: number; woken?: string[] }): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dir = join(home, "evidence", "heartbeat");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) return;
  const entry = { at: nowIso(), agent, findings: findings.length, items: findings.map((f) => ({ kind: f.kind, summary: f.summary, count: f.count })), ...(extra ?? {}) };
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(entry) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function addHeartbeatMonitor(
  home: string,
  opts: { agent: string; intervalMinutes?: number; checks?: CheckKind[]; wakeEnabled?: boolean },
): HeartbeatMonitor {
  const agent = opts.agent.trim();
  if (!agent) throw new HeartbeatError("agent 不能为空");
  const intervalMinutes = opts.intervalMinutes ?? 30;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new HeartbeatError("--every-minutes 必须是 5 到 1440 的整数");
  }
  const checks = opts.checks ?? [...CHECK_KINDS];
  for (const c of checks) {
    if (!CHECK_KINDS.includes(c)) throw new HeartbeatError(`未知检查项 ${c}（可选：${CHECK_KINDS.join("、")}）`);
  }
  const store = loadHeartbeatStore(home);
  if (store.monitors.some((m) => m.agent === agent)) throw new HeartbeatError(`已有 agent ${agent} 的 Heartbeat 配置`);
  const monitor: HeartbeatMonitor = { agent, intervalMinutes, enabled: true, checks, scripts: [], wakeEnabled: opts.wakeEnabled === true, lastRunAt: null, lastFindings: 0 };
  store.monitors.push(monitor);
  saveHeartbeatStore(home, store);
  return monitor;
}

export function listHeartbeatMonitors(home: string): HeartbeatMonitor[] {
  return loadHeartbeatStore(home).monitors;
}

export function setHeartbeatEnabled(home: string, agent: string, enabled: boolean): HeartbeatMonitor {
  const store = loadHeartbeatStore(home);
  const monitor = store.monitors.find((m) => m.agent === agent);
  if (!monitor) throw new HeartbeatError(`没有 agent ${agent} 的 Heartbeat 配置`);
  monitor.enabled = enabled;
  saveHeartbeatStore(home, store);
  return monitor;
}

export function removeHeartbeatMonitor(home: string, agent: string): boolean {
  const store = loadHeartbeatStore(home);
  const idx = store.monitors.findIndex((m) => m.agent === agent);
  if (idx < 0) return false;
  store.monitors.splice(idx, 1);
  saveHeartbeatStore(home, store);
  return true;
}

// ---- 巡检脚本（零 Token 值守） ----

/** 给 monitor 加一条巡检脚本：命令须过审批规则门禁（validateCheckScriptDef 内校验）。 */
export function addCheckScript(home: string, agent: string, input: Record<string, unknown>): CheckScriptDef {
  const def = validateCheckScriptDef(input);
  const store = loadHeartbeatStore(home);
  const monitor = store.monitors.find((m) => m.agent === agent);
  if (!monitor) throw new HeartbeatError(`没有 agent ${agent} 的 Heartbeat 配置（先 nyra heartbeat add --agent ${agent}）`);
  const scripts = monitor.scripts ?? [];
  if (scripts.some((s) => s.name === def.name)) throw new HeartbeatError(`已有同名巡检脚本：${def.name}`);
  scripts.push(def);
  monitor.scripts = scripts;
  saveHeartbeatStore(home, store);
  return def;
}

export function listCheckScripts(home: string, agent: string): CheckScriptDef[] {
  const monitor = loadHeartbeatStore(home).monitors.find((m) => m.agent === agent);
  if (!monitor) throw new HeartbeatError(`没有 agent ${agent} 的 Heartbeat 配置（先 nyra heartbeat add --agent ${agent}）`);
  return [...(monitor.scripts ?? [])];
}

export function removeCheckScript(home: string, agent: string, name: string): boolean {
  const store = loadHeartbeatStore(home);
  const monitor = store.monitors.find((m) => m.agent === agent);
  if (!monitor) throw new HeartbeatError(`没有 agent ${agent} 的 Heartbeat 配置（先 nyra heartbeat add --agent ${agent}）`);
  const scripts = monitor.scripts ?? [];
  const idx = scripts.findIndex((s) => s.name === name);
  if (idx < 0) return false;
  scripts.splice(idx, 1);
  monitor.scripts = scripts;
  saveHeartbeatStore(home, store);
  return true;
}

export function setHeartbeatWake(home: string, agent: string, enabled: boolean): HeartbeatMonitor {
  const store = loadHeartbeatStore(home);
  const monitor = store.monitors.find((m) => m.agent === agent);
  if (!monitor) throw new HeartbeatError(`没有 agent ${agent} 的 Heartbeat 配置`);
  monitor.wakeEnabled = enabled;
  saveHeartbeatStore(home, store);
  return monitor;
}

/** 唤醒任务提示词：只读核查；无须处理就回 NO_REPLY 静默结束（runOne 不写收件箱、worker 不推 Bot 通知）。 */
export function buildWakePrompt(finding: HeartbeatFinding): string {
  return `【值守唤醒】巡查发现需要你看一眼：${finding.summary}。\n请只读核查（不要写文件、不要对外发消息）；如确认无须处理，在回复末尾输出 NO_REPLY 静默结束；如确需处理，回复处理建议（由值守记录，不直接发消息）。`;
}

export function runHeartbeat(home: string, agent: string, opts?: { force?: boolean; now?: Date; spawnFn?: (argv: string[], cwd: string, timeoutMs: number) => SpawnResult }): HeartbeatRunResult {
  const store = loadHeartbeatStore(home);
  const monitor = store.monitors.find((m) => m.agent === agent);
  if (!monitor) throw new HeartbeatError(`没有 agent ${agent} 的 Heartbeat 配置（先 nyra heartbeat add --agent ${agent}）`);
  if (!monitor.enabled) return { agent, findings: [], quiet: true, skipped: "已停用", fresh: 0, deduped: 0, woken: [] };
  const now = opts?.now ?? new Date();
  if (!opts?.force && monitor.lastRunAt) {
    const last = new Date(monitor.lastRunAt).getTime();
    if (!Number.isNaN(last) && now.getTime() - last < monitor.intervalMinutes * 60_000) {
      return { agent, findings: [], quiet: true, skipped: "未到间隔", fresh: 0, deduped: 0, woken: [] };
    }
  }
  const findings = runChecks(home, monitor.checks);
  // 零 Token 值守：巡检脚本先跑本地命令（不调模型）；命中与执行失败都算发现，
  // 安静的脚本不产生发现、不花 Token。无效的脚本配置跳过，只记 stderr。
  const scriptDefs: CheckScriptDef[] = [];
  for (const s of monitor.scripts ?? []) {
    try {
      scriptDefs.push(validateCheckScriptDef(s as unknown as Record<string, unknown>));
    } catch (err: unknown) {
      process.stderr.write(`跳过无效巡检脚本 ${s.name}：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  // wake 判定要知道哪条发现来自哪条脚本：按发现顺序对齐（脚本发现紧跟在 runChecks 之后）。
  const scriptFindings: Array<{ finding: HeartbeatFinding; def: CheckScriptDef; hit: boolean }> = [];
  for (const def of scriptDefs) {
    let outcome;
    try {
      outcome = runCheckScript(def, opts?.spawnFn ? { spawnFn: opts.spawnFn } : undefined);
    } catch (err: unknown) {
      outcome = { outcome: "failed" as const, stdout: "", stderr: "", exitCode: null, durationMs: 0, reason: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.outcome === "quiet") continue;
    const finding: HeartbeatFinding = { kind: "check_script", summary: describeCheckScriptOutcome(def, outcome), count: 1 };
    findings.push(finding);
    scriptFindings.push({ finding, def, hit: outcome.outcome === "hit" });
  }
  monitor.lastRunAt = now.toISOString();
  monitor.lastFindings = findings.length;
  saveHeartbeatStore(home, store);
  // 指纹去重：同一异常只通知一次。重复发现只记审计，不写收件箱、不唤醒。
  const seen = loadHeartbeatSeen(home);
  const fresh: HeartbeatFinding[] = [];
  let deduped = 0;
  for (const f of findings) {
    const fp = heartbeatFingerprint(f.kind, f.summary);
    if (seen.seen[fp]) { deduped += 1; continue; }
    fresh.push(f);
  }
  const woken: string[] = [];
  if (fresh.length) {
    // 唤醒：只有 fresh 的、onHit=wake 的巡检命中，且 monitor 开了 wake，才入队。
    // 唤醒任务以 unattended（只读）入队：主控只能看不能写，写操作照样要人批；
    // 先入队成功再记指纹（入队失败下轮重试，不静默丢异常）。
    for (const sf of scriptFindings) {
      if (!sf.hit || sf.def.onHit !== "wake" || monitor.wakeEnabled !== true) continue;
      if (!fresh.includes(sf.finding)) continue;
      try {
        const state = addTask(buildWakePrompt(sf.finding), {
          workdir: process.cwd(), mode: "auto", unattended: true, maxTurns: 8, home,
        });
        woken.push(state.run_id);
        seen.seen[heartbeatFingerprint(sf.finding.kind, sf.finding.summary)] = { at: now.toISOString(), kind: sf.finding.kind };
      } catch (err: unknown) {
        process.stderr.write(`唤醒入队失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    // 其余 fresh 发现记指纹（唤醒过的上面已记，这里跳过重复记）。
    for (const f of fresh) {
      const fp = heartbeatFingerprint(f.kind, f.summary);
      if (!seen.seen[fp]) seen.seen[fp] = { at: now.toISOString(), kind: f.kind };
    }
    saveHeartbeatSeen(home, seen);
  }
  appendHeartbeatAudit(home, agent, findings, { fresh: fresh.length, deduped, woken });
  // 缺口 43（DSH-2）：observe 模式下，Heartbeat 发现的待续跑子 agent 只记
  // 干跑、不真干（recordDryRun 自带去重，同一待续跑只留一条未定的记录）。
  if (findings.some((f) => f.kind === "resume_pending") && getAgentMode(home, agent) === "observe") {
    for (const row of listSubagentRuns(home, { status: "resume_pending" })) {
      try {
        recordDryRun(home, {
          agent, kind: "resume_subagent", action: "resume", target: row.runId,
          reason: "Heartbeat 发现待续跑子 agent；observe 模式：只记录，不执行",
        });
      } catch { /* 干跑记不上不破坏巡查 */ }
    }
  }
  if (!fresh.length) return { agent, findings, quiet: true, skipped: null, fresh: 0, deduped, woken };
  // 有新发现：先记证据（上一步 audit），再汇报（收件箱，不直接发消息打扰）。
  const summary = fresh.map((f) => f.summary).join("；").slice(0, 200);
  appendInbox(`heartbeat-${agent}`, "heartbeat", summary, home);
  return { agent, findings, quiet: false, skipped: null, fresh: fresh.length, deduped, woken };
}

/** 守护进程每轮调：只跑到期的 monitor；跑失败只记 stderr，不破坏守护进程。 */
export function runDueHeartbeats(home: string): HeartbeatRunResult[] {
  const results: HeartbeatRunResult[] = [];
  for (const monitor of listHeartbeatMonitors(home)) {
    if (!monitor.enabled) continue;
    try {
      const r = runHeartbeat(home, monitor.agent, {});
      if (!r.skipped) results.push(r);
    } catch (err: unknown) {
      process.stderr.write(`Heartbeat ${monitor.agent} 失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return results;
}

// ---- 推断承诺 ----

export type CommitmentStatus = "proposed" | "confirmed" | "reminded" | "expired" | "done";

export interface Commitment {
  id: string;
  text: string;
  agent: string;
  channel: string;
  status: CommitmentStatus;
  proposedAt: string;
  remindAt: string;
  expiresAt: string;
  confirmedAt: string | null;
}

export interface CommitmentStore {
  version: 1;
  commitments: Commitment[];
}

export function commitmentsPath(home: string): string {
  return join(home, "commitments.json");
}

function newCommitmentId(): string {
  return `cm_${randomBytes(6).toString("hex")}`;
}

export function loadCommitmentStore(home: string): CommitmentStore {
  return loadJsonLedger<CommitmentStore>(commitmentsPath(home), { version: 1, commitments: [] }, "推断承诺账本");
}

export function saveCommitmentStore(home: string, store: CommitmentStore): void {
  saveJsonLedger(commitmentsPath(home), store);
}

/** 模型推断出的跟进只进“提议”态——须用户确认一次才生效，不直接进记忆。 */
export function proposeCommitment(
  home: string,
  opts: { text: string; agent?: string; channel?: string; remindAt: string; expiresAt: string },
): Commitment {
  const text = (opts.text ?? "").trim();
  if (!text) throw new HeartbeatError("承诺内容不能为空");
  if (text.length > 500) throw new HeartbeatError("承诺内容过长（超过 500 字符）");
  const remindAt = new Date(opts.remindAt);
  const expiresAt = new Date(opts.expiresAt);
  const now = new Date();
  if (Number.isNaN(remindAt.getTime()) || Number.isNaN(expiresAt.getTime())) throw new HeartbeatError("提醒时间与过期时间须是 ISO 时间");
  if (remindAt.getTime() >= expiresAt.getTime()) throw new HeartbeatError("提醒时间须早于过期时间");
  if (expiresAt.getTime() <= now.getTime()) throw new HeartbeatError("过期时间须在未来");
  const store = loadCommitmentStore(home);
  const commitment: Commitment = {
    id: newCommitmentId(), text, agent: opts.agent ?? "nyra", channel: opts.channel ?? "",
    status: "proposed", proposedAt: nowIso(),
    remindAt: remindAt.toISOString(), expiresAt: expiresAt.toISOString(), confirmedAt: null,
  };
  store.commitments.push(commitment);
  saveCommitmentStore(home, store);
  return commitment;
}

export function getCommitment(home: string, id: string): Commitment {
  const c = loadCommitmentStore(home).commitments.find((x) => x.id === id);
  if (!c) throw new HeartbeatError(`找不到推断承诺 ${id}`);
  return c;
}

export function listCommitments(home: string, filter?: { status?: CommitmentStatus; agent?: string }): Commitment[] {
  return loadCommitmentStore(home).commitments
    .filter((c) => (!filter?.status || c.status === filter.status) && (!filter?.agent || c.agent === filter.agent))
    .sort((a, b) => a.remindAt.localeCompare(b.remindAt));
}

export function confirmCommitment(home: string, id: string): Commitment {
  const store = loadCommitmentStore(home);
  const c = store.commitments.find((x) => x.id === id);
  if (!c) throw new HeartbeatError(`找不到推断承诺 ${id}`);
  if (c.status !== "proposed") throw new HeartbeatError(`只能确认 proposed 状态的承诺，当前为 ${c.status}`);
  c.status = "confirmed";
  c.confirmedAt = nowIso();
  saveCommitmentStore(home, store);
  return c;
}

export function doneCommitment(home: string, id: string): Commitment {
  const store = loadCommitmentStore(home);
  const c = store.commitments.find((x) => x.id === id);
  if (!c) throw new HeartbeatError(`找不到推断承诺 ${id}`);
  if (c.status !== "confirmed" && c.status !== "reminded") throw new HeartbeatError(`只能完成 confirmed/reminded 状态的承诺，当前为 ${c.status}`);
  c.status = "done";
  saveCommitmentStore(home, store);
  return c;
}

/** 过期扫荡：过了期的提议/已确认自动失效——不永久驻留记忆，也不提醒。 */
export function expireCommitments(home: string, now: Date = new Date()): { expired: string[] } {
  const store = loadCommitmentStore(home);
  const expired: string[] = [];
  for (const c of store.commitments) {
    if ((c.status === "proposed" || c.status === "confirmed") && new Date(c.expiresAt).getTime() <= now.getTime()) {
      c.status = "expired";
      expired.push(c.id);
    }
  }
  if (expired.length) saveCommitmentStore(home, store);
  return { expired };
}

/** 到期提醒：已确认且到了提醒时间的，进收件箱提醒一次（状态变 reminded，
 * 不重复提醒）。 */
export function remindDueCommitments(home: string, now: Date = new Date()): Commitment[] {
  expireCommitments(home, now);
  const store = loadCommitmentStore(home);
  const reminded: Commitment[] = [];
  for (const c of store.commitments) {
    if (c.status === "confirmed" && new Date(c.remindAt).getTime() <= now.getTime()) {
      c.status = "reminded";
      reminded.push(c);
      appendInbox(`commitment-${c.id}`, "commitment", c.text.slice(0, 200), home);
    }
  }
  if (reminded.length) saveCommitmentStore(home, store);
  return reminded;
}

const USAGE =
  "用法：nyra heartbeat <add|list|remove|enable|disable|run|wake|check-script|seen-clear|commitments> [选项]\n" +
  "  add --agent <名字> [--every-minutes N（默认 30，5–1440）] [--checks inbox_unread,kanban_blocked,resume_pending,stale_runs] [--wake]\n" +
  "  list [--json]\n" +
  "  remove --agent <名字> --yes\n" +
  "  enable|disable --agent <名字>\n" +
  "  run [--agent <名字>|--all] [--force]   未到间隔的跳过；无事安静，有新发现写收件箱\n" +
  "  wake --agent <名字> --on|--off   唤醒总开关（默认关；只对 onHit=wake 的巡检命中生效）\n" +
  "  check-script add --agent <名字> --name <名字> --command \"<命令>\" [--mode non-empty-stdout-is-hit|exit-zero-is-hit] [--timeout N（默认 30，5–120）] [--on-hit notify|wake] --yes   加一条本地脚本预检（命令须过审批规则门禁，--yes 即批准该命令）\n" +
  "  check-script list --agent <名字> [--json]\n" +
  "  check-script remove --agent <名字> --name <名字> --yes\n" +
  "  check-script run --agent <名字> --name <名字>   只跑一次看结果（不通知、不唤醒）\n" +
  "  seen-clear --yes   清空去重账本（下轮重复异常会再通知一次）\n" +
  "  commitments propose \"<内容>\" --remind-at <ISO> --expires-at <ISO> [--agent <名字>] [--channel <渠道>]\n" +
  "  commitments confirm <承诺 id>\n" +
  "  commitments list [--status proposed|confirmed|reminded|expired|done] [--json]\n" +
  "  commitments done <承诺 id>\n" +
  "  commitments expire   过期扫荡（过期自动失效，不进记忆）\n" +
  "  commitments remind   到期提醒（已确认且到时间的进收件箱一次）\n";

export function handleHeartbeat(argv: string[], home: string): number {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    if (action === "add") {
      const agent = get("--agent") ?? "";
      const every = get("--every-minutes") ? parseInt(get("--every-minutes")!, 10) : undefined;
      const checks = get("--checks") ? (get("--checks")!.split(",").map((s) => s.trim()).filter(Boolean) as CheckKind[]) : undefined;
      const monitor = addHeartbeatMonitor(resolvedHome, { agent, intervalMinutes: every, checks, wakeEnabled: argv.includes("--wake") });
      process.stdout.write(`已添加 Heartbeat：agent ${monitor.agent}，每 ${monitor.intervalMinutes} 分钟检查（${monitor.checks.join("、")}）${monitor.wakeEnabled ? "，唤醒已开" : "，唤醒未开"}。\n`);
      return 0;
    }
    if (action === "list") {
      const monitors = listHeartbeatMonitors(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(monitors, null, 2) + "\n");
        return 0;
      }
      if (!monitors.length) {
        process.stdout.write("没有 Heartbeat 配置（nyra heartbeat add --agent <名字> 新建）。\n");
        return 0;
      }
      for (const m of monitors) {
        process.stdout.write(`${m.agent} [${m.enabled ? "启用" : "停用"}] 每 ${m.intervalMinutes} 分钟，上次 ${m.lastRunAt ?? "未跑"}，上次发现 ${m.lastFindings} 项\n`);
      }
      return 0;
    }
    if (action === "remove") {
      const agent = get("--agent") ?? "";
      if (!argv.includes("--yes")) {
        process.stderr.write("删除 Heartbeat 配置须加 --yes 确认：nyra heartbeat remove --agent <名字> --yes\n");
        return 2;
      }
      if (!removeHeartbeatMonitor(resolvedHome, agent)) {
        process.stderr.write(`没有 agent ${agent} 的 Heartbeat 配置\n`);
        return 1;
      }
      process.stdout.write(`已删除 agent ${agent} 的 Heartbeat 配置。\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const agent = get("--agent") ?? "";
      const monitor = setHeartbeatEnabled(resolvedHome, agent, action === "enable");
      process.stdout.write(`agent ${monitor.agent} 的 Heartbeat 已${action === "enable" ? "启用" : "停用"}。\n`);
      return 0;
    }
    if (action === "run") {
      const force = argv.includes("--force");
      if (argv.includes("--all")) {
        const results = listHeartbeatMonitors(resolvedHome)
          .filter((m) => m.enabled)
          .map((m) => {
            try { return runHeartbeat(resolvedHome, m.agent, { force }); }
            catch (err: unknown) { process.stderr.write(`Heartbeat ${m.agent} 失败：${err instanceof Error ? err.message : String(err)}\n`); return null; }
          })
          .filter((r): r is HeartbeatRunResult => r !== null);
        const found = results.reduce((n, r) => n + r.findings.length, 0);
        process.stdout.write(found ? `Heartbeat 跑完：${results.length} 个 monitor，共 ${found} 项发现（已写收件箱）。\n` : "Heartbeat 跑完：无事安静。\n");
        return 0;
      }
      const agent = get("--agent") ?? "";
      if (!agent) {
        process.stderr.write("错误：用法：nyra heartbeat run --agent <名字> [--force] 或 --all\n");
        return 2;
      }
      const result = runHeartbeat(resolvedHome, agent, { force });
      if (result.skipped) {
        process.stdout.write(`Heartbeat ${agent}：${result.skipped}。\n`);
        return 0;
      }
      if (result.quiet) {
        process.stdout.write(`Heartbeat ${agent}：无事安静。\n`);
        return 0;
      }
      process.stdout.write(`Heartbeat ${agent}：${result.findings.length} 项发现，已写收件箱：${result.findings.map((f) => f.summary).join("；")}\n`);
      return 0;
    }
    if (action === "wake") {
      const agent = get("--agent") ?? "";
      if (!argv.includes("--on") && !argv.includes("--off")) {
        process.stderr.write("错误：用法：nyra heartbeat wake --agent <名字> --on|--off\n");
        return 2;
      }
      const monitor = setHeartbeatWake(resolvedHome, agent, argv.includes("--on"));
      process.stdout.write(`agent ${monitor.agent} 的 Heartbeat 唤醒已${argv.includes("--on") ? "开启（只对 onHit=wake 的巡检命中生效）" : "关闭"}。\n`);
      return 0;
    }
    if (action === "check-script") {
      const sub = argv[1] ?? "";
      const agent = get("--agent") ?? "";
      if (sub === "add") {
        if (!argv.includes("--yes")) {
          process.stderr.write("错误：加巡检脚本须加 --yes，明确批准该命令在无人值守时定期执行（命令须过审批规则门禁）。\n");
          return 2;
        }
        const name = get("--name") ?? "";
        const command = get("--command") ?? "";
        const timeout = get("--timeout") ? parseInt(get("--timeout")!, 10) : undefined;
        const def = addCheckScript(resolvedHome, agent, {
          name, command,
          mode: get("--mode"), timeoutSec: timeout, onHit: get("--on-hit"),
        });
        process.stdout.write(`已加巡检脚本 ${def.name}（${def.command}，${def.mode}，${def.timeoutSec} 秒，命中${def.onHit === "wake" ? "唤醒主控" : "写收件箱"}）。\n`);
        return 0;
      }
      if (sub === "list") {
        const scripts = listCheckScripts(resolvedHome, agent);
        if (argv.includes("--json")) {
          process.stdout.write(JSON.stringify(scripts, null, 2) + "\n");
          return 0;
        }
        if (!scripts.length) {
          process.stdout.write("没有巡检脚本。\n");
          return 0;
        }
        for (const s of scripts) {
          process.stdout.write(`${s.name}  ${s.command}（${s.mode}，${s.timeoutSec} 秒，命中${s.onHit === "wake" ? "唤醒" : "通知"}）\n`);
        }
        return 0;
      }
      if (sub === "remove") {
        const name = get("--name") ?? "";
        if (!argv.includes("--yes")) {
          process.stderr.write("删除巡检脚本须加 --yes 确认：nyra heartbeat check-script remove --agent <名字> --name <名字> --yes\n");
          return 2;
        }
        if (!removeCheckScript(resolvedHome, agent, name)) {
          process.stderr.write(`没有巡检脚本 ${name}\n`);
          return 1;
        }
        process.stdout.write(`已删除巡检脚本 ${name}。\n`);
        return 0;
      }
      if (sub === "run") {
        const name = get("--name") ?? "";
        const scripts = listCheckScripts(resolvedHome, agent);
        const def = scripts.find((s) => s.name === name);
        if (!def) {
          process.stderr.write(`没有巡检脚本 ${name}\n`);
          return 1;
        }
        const outcome = runCheckScript(def);
        process.stdout.write(`${describeCheckScriptOutcome(def, outcome)}（${outcome.durationMs} 毫秒${outcome.reason ? `，${outcome.reason}` : ""}）\n`);
        if (outcome.stdout.trim()) process.stdout.write(`输出：\n${outcome.stdout}\n`);
        return outcome.outcome === "failed" ? 1 : 0;
      }
      process.stderr.write(`错误：未知子命令 check-script ${sub}\n${USAGE}`);
      return 2;
    }
    if (action === "seen-clear") {
      if (!argv.includes("--yes")) {
        process.stderr.write("清空去重账本须加 --yes 确认：nyra heartbeat seen-clear --yes\n");
        return 2;
      }
      clearHeartbeatSeen(resolvedHome);
      process.stdout.write("去重账本已清空（下轮重复异常会再通知一次）。\n");
      return 0;
    }
    if (action === "commitments") {
      const sub = argv[1] ?? "";
      if (sub === "propose") {
        const text = argv[2] ?? "";
        const remindAt = get("--remind-at") ?? "";
        const expiresAt = get("--expires-at") ?? "";
        if (!text || !remindAt || !expiresAt) {
          process.stderr.write("错误：用法：nyra heartbeat commitments propose \"<内容>\" --remind-at <ISO> --expires-at <ISO>\n");
          return 2;
        }
        const c = proposeCommitment(resolvedHome, { text, agent: get("--agent"), channel: get("--channel"), remindAt, expiresAt });
        process.stdout.write(`${c.id}（提议态：须用户确认一次才生效，过期自动失效，不进记忆）\n`);
        return 0;
      }
      if (sub === "confirm") {
        const c = confirmCommitment(resolvedHome, argv[2] ?? "");
        process.stdout.write(`${c.id} 已确认，到 ${c.remindAt} 提醒。\n`);
        return 0;
      }
      if (sub === "list") {
        const items = listCommitments(resolvedHome, { status: get("--status") as CommitmentStatus | undefined });
        if (argv.includes("--json")) {
          process.stdout.write(JSON.stringify(items, null, 2) + "\n");
          return 0;
        }
        if (!items.length) {
          process.stdout.write("没有推断承诺。\n");
          return 0;
        }
        for (const c of items) {
          process.stdout.write(`${c.id} [${c.status}] ${c.text.slice(0, 60)}（提醒 ${c.remindAt}，过期 ${c.expiresAt}）\n`);
        }
        return 0;
      }
      if (sub === "done") {
        const c = doneCommitment(resolvedHome, argv[2] ?? "");
        process.stdout.write(`${c.id} 已完成。\n`);
        return 0;
      }
      if (sub === "expire") {
        const { expired } = expireCommitments(resolvedHome);
        process.stdout.write(expired.length ? `过期扫荡：${expired.length} 个承诺已失效。\n` : "过期扫荡：没有承诺过期。\n");
        return 0;
      }
      if (sub === "remind") {
        const reminded = remindDueCommitments(resolvedHome);
        process.stdout.write(reminded.length ? `到期提醒：${reminded.length} 个承诺已写收件箱。\n` : "到期提醒：没有承诺到时间。\n");
        return 0;
      }
      process.stderr.write(`错误：未知子命令 commitments ${sub}\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`错误：未知子命令 heartbeat ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
