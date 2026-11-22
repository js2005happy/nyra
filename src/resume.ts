// src/resume.ts — 缺口 30：崩溃自续与持久子 agent。
//
// Nyra 的 delegate 失败即失败：子 agent 没有自己的持久行，网关一崩，
// 中断的轮次、做到哪一步、为什么停，全丢了。本批补持久层：
//   - 注册表 ~/.nyra/subagents.json（原子写 0600，损坏先备份再抛错）：
//     每个子 agent 运行一行——状态 + 停止原因 + 心跳检查点 + 续跑次数；
//   - 启动扫荡（sweep）：活着的 worker 在跑时不动（WorkerLock 在谁手里
//     就跳过，fail-closed）；重启后 running 的行标 resume_pending、
//     停止原因 crashed；同一运行连崩 3 次仍活跃 → suspended（防毒消息
//     无限崩网关，Hermes 同款刹车）；
//   - 续跑先验状态再动手：读运行记录 + 事件 + 工作目录，验不过不续跑，
//     续跑动作本身进运行事件；auto_resume 默认关（须显式开）；
//     无人值守续跑强制只读复查（缺口 8 的硬约束）——写操作须人批。
//
// 注意：delegate 子任务目前没有独立的 RunStore 运行（只在父运行的事件里
// 记 delegate_start/end），所以注册表挂的是任务队列 / 主运行的 runId。
// delegate 调用点自动注册是下一批（须改 agent.ts 的 delegate 路径），
// 本批先立持久层 + CLI + 扫荡，任务队列的运行可直接注册续跑。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore, prepareResume, type RunState } from "./runs.ts";
import { WorkerLock, TASKS_DIR, WORKER_LOCK, buildProvider, runOne } from "./tasks.ts";
import { checkAutoAllowed, getAgentMode, recordDryRun, revalidateMandateForResume } from "./governance.ts";
import { listKanbanTasks, requestKanbanReview } from "./kanban.ts";

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export type SubagentStatus = "running" | "resume_pending" | "suspended" | "completed" | "failed" | "stopped";
export type StopReason = "completed" | "crashed" | "timeout" | "approval_blocked" | "cancelled" | "unknown";

/** Hermes 的刹车：跨 3 次连续重启仍活跃的会话挂起。 */
export const MAX_RESTARTS_BEFORE_SUSPEND = 3;
/** 启动扫荡只认 120 秒内的心跳为“活着”——超过即视为已崩（Hermes 同款 120 秒）。 */
export const STALE_HEARTBEAT_MS = 120_000;

export interface SubagentRun {
  runId: string;
  agent: string;
  sessionId: string;
  workdir: string;
  mode: string;
  status: SubagentStatus;
  stopReason: StopReason;
  lastStep: string | null;
  lastHeartbeatAt: string | null;
  restarts: number;
  autoResume: boolean;
  unattended: boolean;
  /** 缺口 43：绑定的治理授权 id（可空）。续跑前按当前 Policy 重验证。 */
  mandateId: string | null;
  /** H-3：父运行 id（可空）。子树停用时沿 parentRunId 递归。 */
  parentRunId: string | null;
  /** H-7：委派层级（可空，老行没有）：delegate 派出的子 agent 是第几层
   * （根 agent 的直接子任务是第 1 层）；花名册详情里可见。 */
  delegateDepth: number | null;
  /** H-3：已请求停止的时间 / 发起人 / 备注（可空）。请求是请求，不是已停。 */
  stopRequestedAt: string | null;
  stopRequestedBy: string | null;
  stopNote: string | null;
  /** H-3：确认停下的时间（可空）。 */
  stoppedAt: string | null;
  /** H-2：排队等消费的引导（每条含 id/文本/发起人/排队与消费时间）。 */
  steerQueue: QueuedSteer[];
  createdAt: string;
  updatedAt: string;
}

/** H-2：一条排队中的引导——子 agent 在下一个检查点消费；在跑的工具调用不被打断。 */
export interface QueuedSteer {
  id: string;
  text: string;
  by: string;
  queuedAt: string;
  consumedAt: string | null;
}

/** H-2：引导文本上限（1000 字）——检查点消息里整条带给模型，太长会撑爆上下文。 */
export const MAX_STEER_TEXT_LENGTH = 1000;

export interface SubagentRegistry {
  version: 1;
  runs: SubagentRun[];
}

export function subagentRegistryPath(home: string): string {
  return join(home, "subagents.json");
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

export function loadSubagentRegistry(home: string): SubagentRegistry {
  const path = subagentRegistryPath(home);
  if (!existsSync(path)) return { version: 1, runs: [] };
  if (lstatSync(path).isSymbolicLink()) throw new ResumeError("子 agent 注册表不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new ResumeError("子 agent 注册表损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as SubagentRegistry).version !== 1 || !Array.isArray((raw as SubagentRegistry).runs)) {
    backupCorrupt(path);
    throw new ResumeError("子 agent 注册表格式无效，已备份");
  }
  // H-3：老注册表里的行没有 parentRunId/stop* 字段，读时补 null，
  // 下次保存即回写——只加字段，不改旧行的语义。
  // H-2：同款——老行没有 steerQueue，读时补空数组。
  const registry = raw as SubagentRegistry;
  for (const row of registry.runs) {
    if (row.parentRunId === undefined) row.parentRunId = null;
    if (row.stopRequestedAt === undefined) row.stopRequestedAt = null;
    if (row.stopRequestedBy === undefined) row.stopRequestedBy = null;
    if (row.stopNote === undefined) row.stopNote = null;
    if (row.stoppedAt === undefined) row.stoppedAt = null;
    if (!Array.isArray(row.steerQueue)) row.steerQueue = [];
  }
  return registry;
}

export function saveSubagentRegistry(home: string, registry: SubagentRegistry): void {
  const path = subagentRegistryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ResumeError("子 agent 注册表不能是符号链接");
  const tmp = join(dirname(path), `.subagents-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(registry, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function getRun(registry: SubagentRegistry, runId: string): SubagentRun {
  const row = registry.runs.find((r) => r.runId === runId);
  if (!row) throw new ResumeError(`注册表里没有子 agent 运行 ${runId}`);
  return row;
}

/** 找运行记录：先任务队列（tasks/），再主运行（runs/）。 */
export function findRunStore(home: string, runId: string): { store: RunStore; state: RunState; dir: string } | null {
  for (const dir of [TASKS_DIR, "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      const state = store.load(runId);
      return { store, state, dir };
    } catch { /* 不在这个目录 */ }
  }
  return null;
}

export function registerSubagentRun(
  home: string,
  opts: { runId: string; agent?: string; sessionId?: string; workdir?: string; mode?: string; autoResume?: boolean; unattended?: boolean; mandateId?: string; parentRunId?: string; delegateDepth?: number },
): SubagentRun {
  const registry = loadSubagentRegistry(home);
  const existing = registry.runs.find((r) => r.runId === opts.runId);
  if (existing) throw new ResumeError(`子 agent 运行 ${opts.runId} 已在注册表里`);
  const at = nowIso();
  const row: SubagentRun = {
    runId: opts.runId, agent: opts.agent ?? "nyra",
    sessionId: opts.sessionId ?? "", workdir: opts.workdir ?? process.cwd(),
    mode: opts.mode ?? "auto", status: "running", stopReason: "unknown",
    lastStep: null, lastHeartbeatAt: null, restarts: 0,
    autoResume: opts.autoResume ?? false, unattended: opts.unattended ?? false,
    mandateId: opts.mandateId ?? null,
    parentRunId: opts.parentRunId ?? null,
    // H-7：委派层级（老行没有时为 null，由花名册按 parentRunId 现算兜底）。
    delegateDepth: opts.delegateDepth ?? null,
    stopRequestedAt: null, stopRequestedBy: null, stopNote: null, stoppedAt: null,
    steerQueue: [],
    createdAt: at, updatedAt: at,
  };
  registry.runs.push(row);
  saveSubagentRegistry(home, registry);
  return row;
}

export function getSubagentRun(home: string, runId: string): SubagentRun {
  return getRun(loadSubagentRegistry(home), runId);
}

export function listSubagentRuns(home: string, filter?: { status?: SubagentStatus; agent?: string }): SubagentRun[] {
  const registry = loadSubagentRegistry(home);
  return registry.runs
    .filter((r) => (!filter?.status || r.status === filter.status) && (!filter?.agent || r.agent === filter.agent))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 心跳检查点：做到哪一步 + 什么时候。只记摘要（≤300 字），不记正文。 */
export function heartbeatSubagent(home: string, runId: string, lastStep: string): SubagentRun {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status === "completed" || row.status === "failed" || row.status === "suspended" || row.status === "stopped") {
    throw new ResumeError(`子 agent 运行 ${runId} 已终态（${row.status}），不再接受心跳`);
  }
  row.lastStep = String(lastStep).slice(0, 300);
  row.lastHeartbeatAt = nowIso();
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  return row;
}

export interface SweepReport {
  markedPending: string[];
  suspended: string[];
  skipped: string | null;
  resumed: string[];
  /** 缺口 43：observe 模式或月度硬顶挡下的自动续跑，只记干跑、不真干。 */
  dryRuns: string[];
}

/** 启动扫荡：running 的行按心跳年龄标 resume_pending（crashed）；连崩
 * 满 3 次的挂起（suspended）。活着的 worker 持有锁时整个扫荡跳过——
 * 扫荡只在启动时跑，不跟活着的 worker 抢。auto 时只续跑 autoResume=true
 * 的行（其余留给人）；续跑本身走 resumeSubagentRun（先验状态）。 */
export async function sweepSubagents(
  home: string,
  opts?: { auto?: boolean; now?: Date },
): Promise<SweepReport> {
  const report: SweepReport = { markedPending: [], suspended: [], skipped: null, resumed: [], dryRuns: [] };
  mkdirSync(join(home, TASKS_DIR), { recursive: true });
  const lock = new WorkerLock(join(home, TASKS_DIR, WORKER_LOCK));
  if (!lock.acquire()) {
    report.skipped = "已有 worker 在运行，扫荡跳过（启动时再跑）";
    return report;
  }
  try {
    const registry = loadSubagentRegistry(home);
    const nowMs = (opts?.now ?? new Date()).getTime();
    for (const row of registry.runs) {
      if (row.status !== "running") continue;
      const lastBeat = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : 0;
      if (nowMs - lastBeat < STALE_HEARTBEAT_MS && row.lastHeartbeatAt) continue;
      row.stopReason = "crashed";
      row.updatedAt = nowIso();
      if (row.restarts >= MAX_RESTARTS_BEFORE_SUSPEND) {
        row.status = "suspended";
        report.suspended.push(row.runId);
      } else {
        row.status = "resume_pending";
        report.markedPending.push(row.runId);
      }
      const found = findRunStore(home, row.runId);
      if (found) {
        try { found.store.appendEvent(row.runId, "subagent_resume_pending", { run_id: row.runId, reason: "crashed" }); } catch { /* 事件写不上不破坏扫荡 */ }
      }
    }
    saveSubagentRegistry(home, registry);
    if (opts?.auto) {
      for (const runId of [...report.markedPending]) {
        const row = getRun(loadSubagentRegistry(home), runId);
        if (!row.autoResume) continue;
        // H-3：已请求停止的行不自动续跑——停下优先于续跑，须先取消请求或确认停下。
        if (row.stopRequestedAt) continue;
        // 缺口 43（DSH-2）：自动续跑先过接单模式与月度硬顶。observe 模式只记
        // 干跑、不真干；月度硬顶已触顶也不续跑，同样只记干跑。
        if (getAgentMode(home, row.agent) === "observe") {
          recordDryRun(home, {
            agent: row.agent, kind: "resume_subagent", action: "resume", target: runId,
            reason: "observe 模式：评估通过，只记干跑，不真干",
          });
          report.dryRuns.push(runId);
          continue;
        }
        const cap = checkAutoAllowed(home, row.agent);
        if (!cap.allowed) {
          recordDryRun(home, {
            agent: row.agent, kind: "resume_subagent", action: "resume", target: runId,
            reason: cap.reason,
          });
          report.dryRuns.push(runId);
          continue;
        }
        try {
          await resumeSubagentRun(home, runId, {});
          report.resumed.push(runId);
        } catch (err: unknown) {
          process.stderr.write(`自动续跑 ${runId} 失败：${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
    return report;
  } finally {
    lock.release();
  }
}

export interface PreparedResume {
  nextState: RunState;
  messages: Record<string, unknown>[];
  interruptedToolCalls: number;
  restarts: number;
  store: RunStore;
}

/** 先验状态再动手（可单独测的一半）：验四样——注册表状态、运行记录可续
 * 跑、工作目录还在、会话能读；任一不过就抛错、不动运行。无人值守续跑
 * 强制只读（mode 压成 readonly，写操作须人批，缺口 8 硬约束）。
 * suspended 的行须 --force 才续。验过后注册表标 running、restarts+1、
 * 续跑事件进运行记录；执行本身是调用方（resumeSubagentRun）的事。 */
export function prepareSubagentResume(
  home: string,
  runId: string,
  opts?: { force?: boolean },
): PreparedResume {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status === "suspended" && !opts?.force) {
    throw new ResumeError(`子 agent 运行 ${runId} 已挂起（连崩 ${row.restarts} 次），续跑须加 --force 并由人确认`);
  }
  // H-3：已请求停止的行不续跑——先取消请求（nyra subagent cancel-stop）
  // 或确认停下（nyra subagent confirm-stopped），再决定要不要重新注册跑。
  if (row.stopRequestedAt) {
    throw new ResumeError(`子 agent 运行 ${runId} 已请求停止（${row.stopRequestedBy ?? "未记发起人"}），不续跑；先取消请求或确认停下`);
  }
  if (row.status !== "resume_pending" && row.status !== "suspended") {
    throw new ResumeError(`只能续跑 resume_pending/suspended 状态的子 agent 运行，当前为 ${row.status}`);
  }
  // 缺口 43（DSH-1）：绑了授权的运行，续跑前按当前 Policy 重验证。冲突、
  // 撤销、不存在时直接抛错、拒绝续跑；换发了新授权就更新注册表上的绑定。
  if (row.mandateId) {
    const currentMandateId = revalidateMandateForResume(home, row.mandateId);
    if (currentMandateId !== row.mandateId) row.mandateId = currentMandateId;
  }
  const found = findRunStore(home, runId);
  if (!found) throw new ResumeError(`找不到运行记录 ${runId}（任务队列与主运行里都没有），无法验状态`);
  const { store, state } = found;
  if (!["interrupted", "failed", "incomplete", "awaiting_approval", "verify_failed"].includes(state.status)) {
    throw new ResumeError(`运行 ${runId} 当前状态为 ${state.status}，不能续跑`);
  }
  const workdir = state.workdir;
  if (!existsSync(workdir)) throw new ResumeError(`原工作目录不存在：${workdir}`);
  // 先验状态：prepareResume 会修会话（补中断调用的占位结果）、校验模式与
  // 步数，验不过直接抛错；续跑本身从这里才开始。
  const mode = row.unattended ? "readonly" : undefined;
  const [nextState, messages, count] = prepareResume(store, runId, { home, mode });
  row.status = "running";
  row.restarts += 1;
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  try {
    store.appendEvent(runId, "subagent_resumed", { run_id: runId, mode: nextState.mode });
  } catch { /* 事件写不上不破坏续跑 */ }
  return { nextState, messages, interruptedToolCalls: count, restarts: row.restarts, store };
}

export interface ResumeResult {
  runId: string;
  status: string;
  output: string;
  interruptedToolCalls: number;
  restarts: number;
}

export type ResumeRunner = (
  state: RunState,
  opts: { store: RunStore; provider: unknown; home: string },
) => Promise<[RunState, string]>;

/** 续跑（执行一半）：prepareSubagentResume 验过状态后，用 runner 真跑
 * 一遍，再按终态回写注册表。runner 默认是 tasks.runOne（真执行）；测试
 * 传假 runner 只验状态机，不碰模型。 */
export async function resumeSubagentRun(
  home: string,
  runId: string,
  opts?: { force?: boolean; runner?: ResumeRunner },
): Promise<ResumeResult> {
  const prepared = prepareSubagentResume(home, runId, { force: opts?.force });
  const { nextState, interruptedToolCalls, restarts, store } = prepared;
  const runner: ResumeRunner = opts?.runner ?? (async (state, o) => {
    const [provider] = buildProvider(undefined, o.home);
    return runOne(state, { store: o.store, provider, interactive: false, home: o.home, resume: true });
  });
  const [final, output] = await runner(nextState, { store, provider: null, home });
  const registry2 = loadSubagentRegistry(home);
  const row2 = getRun(registry2, runId);
  if (final.status === "verified" || final.status === "completed_unverified") {
    row2.status = "completed";
    row2.stopReason = "completed";
  } else if (final.status === "failed") {
    row2.status = "failed";
    row2.stopReason = "unknown";
  } else if (final.status === "awaiting_approval") {
    row2.status = "resume_pending";
    row2.stopReason = "approval_blocked";
  } else if (final.status === "interrupted") {
    row2.status = "resume_pending";
    row2.stopReason = "crashed";
  } else {
    row2.status = "running";
  }
  row2.updatedAt = nowIso();
  saveSubagentRegistry(home, registry2);
  return { runId, status: final.status, output, interruptedToolCalls, restarts };
}

export function suspendSubagentRun(home: string, runId: string, reason = "人工挂起"): SubagentRun {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status === "completed" || row.status === "failed" || row.status === "stopped") throw new ResumeError(`子 agent 运行 ${runId} 已终态（${row.status}），不能挂起`);
  row.status = "suspended";
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  const found = findRunStore(home, runId);
  if (found) {
    try { found.store.appendEvent(runId, "subagent_suspended", { run_id: runId, restarts: row.restarts }); } catch { /* ignore */ }
  }
  void reason;
  return row;
}

// H-1/H-3：单点停止（只走既有状态机，不新造一套）。
//
// 语义是“请求停止”，不是“已停止”：requestSubagentStop 只在注册表上记
// 一笔请求（stopRequestedAt/By/Note），并把绑了同一运行的 working 任务
// 板任务送 review（partial 路径：部分成果留着，等人看）；子 agent 的
// 运行循环收到请求后发取消信号——在途模型调用 abort、在途工具与子进程
// 被掐断（可靠性打磨第 1 项第一批，见 docs/cancellation.md），底层确认
// 停下后运行自己调 markSubagentStopped 标 stopped；没停下来就保持
// running，行如实写“正在停止”，不谎称已停。已发出去的外部动作停不掉。
// 人工确认仍走 acknowledgeSubagentStop（confirm-stopped）。
export interface StopReport {
  requested: string[];
  alreadyRequested: string[];
  skipped: { runId: string; reason: string }[];
}

/** 委派检查点用的钩子：这行有没有待处理的停止请求。 */
export function isStopRequested(home: string, runId: string): boolean {
  try {
    return getSubagentRun(home, runId).stopRequestedAt !== null;
  } catch { return false; }
}

// H-2：单点引导（排队式，不打断在跑的调用）。
//
// 引导只确认“已排队”，不谎称“已送达”：queueSteer 把文本写进注册表行的
// steerQueue，子 agent 在委派检查点（runLoop 每轮工具调用跑完、下一轮
// 模型调用之前）消费；消费时只改接下来的方向，不改已做过的、不改已发出
// 去的动作。引导文本是用户指令，进证据链（subagent_steer_queued 在父
// 运行的事件链里，subagent_steer_consumed 由父级在子任务结束后补记）；
// 引导不能绕过红线（deny 的动作仍拒），也不能给子 agent 加它没有的权限
// ——检查点只递纸条，不改工具白名单、不改模式、不改审批。
export function queueSteer(
  home: string,
  runId: string,
  text: string,
  opts?: { by?: string },
): QueuedSteer {
  const clean = (text ?? "").trim();
  if (!clean) throw new ResumeError("引导文本不能为空");
  if (clean.length > MAX_STEER_TEXT_LENGTH) {
    throw new ResumeError(`引导文本太长（${clean.length} 字，上限 ${MAX_STEER_TEXT_LENGTH} 字），请拆短再发`);
  }
  const by = (opts?.by ?? "operator").slice(0, 60);
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status !== "running" && row.status !== "resume_pending") {
    throw new ResumeError(`只能给 running/resume_pending 的子 agent 排引导，${runId} 当前为 ${row.status}`);
  }
  const steer: QueuedSteer = {
    id: `steer-${randomBytes(4).toString("hex")}`,
    text: clean,
    by,
    queuedAt: nowIso(),
    consumedAt: null,
  };
  row.steerQueue.push(steer);
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  // 事件记在父运行的链上（委派行本身没有独立的 RunStore）；父运行找不
  // 到时只记队列不记事件，队列才是事实来源，不静默丢引导。
  if (row.parentRunId) {
    const found = findRunStore(home, row.parentRunId);
    if (found) {
      try {
        found.store.appendEvent(row.parentRunId, "subagent_steer_queued", {
          run_id: runId, by, steer_id: steer.id, text: clean.slice(0, 500),
        });
      } catch { /* 事件写不上不破坏排队 */ }
    }
  }
  return steer;
}

/** 委派检查点消费引导：取回尚未消费的，逐条标 consumedAt。只在子 agent
 * 自己的检查点里调；调用方把返回的文本当用户消息递给模型。 */
export function consumeSteers(home: string, runId: string): QueuedSteer[] {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  const pending = row.steerQueue.filter((s) => !s.consumedAt);
  if (!pending.length) return [];
  const at = nowIso();
  for (const s of pending) s.consumedAt = at;
  row.updatedAt = at;
  saveSubagentRegistry(home, registry);
  return pending;
}

/** 委派结束时回写行状态（执行结论，不含验收结论）：子任务正常跑完标
 * completed，抛错标 failed；已终态的行不动。写不上注册表不破坏委派结果。 */
export function finishSubagentRun(home: string, runId: string, status: "completed" | "failed"): void {
  try {
    const registry = loadSubagentRegistry(home);
    const row = registry.runs.find((r) => r.runId === runId);
    if (!row) return;
    if (row.status === "completed" || row.status === "failed" || row.status === "stopped" || row.status === "suspended") return;
    row.status = status;
    row.stopReason = status === "completed" ? "completed" : "unknown";
    row.updatedAt = nowIso();
    saveSubagentRegistry(home, registry);
  } catch { /* 注册表写不上不破坏委派结果 */ }
}

function appendStopEvent(home: string, runId: string, type: string, fields: Record<string, unknown>): void {
  const found = findRunStore(home, runId);
  if (!found) return;
  try { found.store.appendEvent(runId, type, fields); } catch { /* 事件写不上不破坏停止 */ }
}

/** 找绑了同一运行的 working 任务板任务，有就送 review（partial 路径：
 * 部分成果留着，等人看）；没绑任务板任务时只记注册表与事件。 */
function routeKanbanTaskToReview(home: string, runId: string, by: string, step: string | null): string | null {
  const tasks = listKanbanTasks(home, { status: "working" });
  const task = tasks.find((t) => t.runId === runId);
  if (!task) return null;
  try {
    requestKanbanReview(home, task.id, by, `已请求停止，停在：${step ?? "未记步骤"}（部分成果留着，等人看）`);
  } catch { return null; }
  return task.id;
}

/** 请求停止：只在 running/resume_pending 的行上记请求，沿 parentRunId
 * 递归停子树（还在跑的孩子一起停，终态/已挂起的跳过并写清原因）。
 * 已请求过的幂等返回，不重复记事件。 */
export function requestSubagentStop(
  home: string,
  runId: string,
  opts?: { by?: string; reason?: string },
): StopReport {
  const by = (opts?.by ?? "operator").slice(0, 60);
  const reason = (opts?.reason ?? "").trim().slice(0, 200);
  const report: StopReport = { requested: [], alreadyRequested: [], skipped: [] };
  const visit = (id: string, depth: number): void => {
    if (depth > 5) {
      report.skipped.push({ runId: id, reason: "子树太深（超过 5 层），未继续往下停" });
      return;
    }
    const registry = loadSubagentRegistry(home);
    const row = registry.runs.find((r) => r.runId === id);
    if (!row) {
      report.skipped.push({ runId: id, reason: "注册表里没有这个运行" });
      return;
    }
    if (row.status === "completed" || row.status === "failed" || row.status === "stopped") {
      report.skipped.push({ runId: id, reason: `已终态（${row.status}），无须再停` });
      return;
    }
    if (row.status === "suspended") {
      report.skipped.push({ runId: id, reason: "已挂起，无须再停" });
      return;
    }
    if (row.stopRequestedAt) {
      report.alreadyRequested.push(id);
    } else {
      row.stopRequestedAt = nowIso();
      row.stopRequestedBy = by;
      row.stopNote = reason || null;
      row.updatedAt = nowIso();
      saveSubagentRegistry(home, registry);
      report.requested.push(id);
      appendStopEvent(home, id, "subagent_stop_requested", { run_id: id, by, step: row.lastStep ?? "" });
      routeKanbanTaskToReview(home, id, by, row.lastStep);
    }
    const children = loadSubagentRegistry(home).runs.filter((r) => r.parentRunId === id);
    for (const child of children) visit(child.runId, depth + 1);
  };
  visit(runId, 0);
  return report;
}

/** 确认停下：running/resume_pending 的行标 stopped（stopReason cancelled），
 * 停在哪一步以心跳检查点为准，调用方给了 --step 就以给的为准。确认是
 * 对“已经停了”这个事实的断言——没停下来不要调它，调了就是谎报。
 * 绑的任务板任务留在 review，等人看部分成果再定去向（不停任务板的状态机）。
 *
 * 可靠性打磨第 1 项第一批：运行循环自己确认停下时调 markSubagentStopped
 *（同一语义，只是调用方是运行本身——它已确认底层真的停了；人工确认
 * 仍走本函数）。 */
export function acknowledgeSubagentStop(
  home: string,
  runId: string,
  opts?: { by?: string; step?: string },
): SubagentRun {
  const by = (opts?.by ?? "operator").slice(0, 60);
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status !== "running" && row.status !== "resume_pending") {
    throw new ResumeError(`只能确认 running/resume_pending 状态的子 agent 运行已停下，当前为 ${row.status}`);
  }
  if (opts?.step) row.lastStep = String(opts.step).slice(0, 300);
  row.status = "stopped";
  row.stopReason = "cancelled";
  row.stoppedAt = nowIso();
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  appendStopEvent(home, runId, "subagent_stopped", { run_id: runId, by, step: row.lastStep ?? "" });
  return row;
}

/**
 * 运行自己确认停下（可靠性打磨第 1 项第一批）：与 acknowledgeSubagentStop
 * 同一语义、同一事件，只是调用方是运行循环本身——它在取消信号发出后已
 * 确认底层真的停了（模型请求已 abort、子进程已退出、工具已收尾），才调
 * 本函数标 stopped。调用时若行上还有待处理的停止请求，一并清掉（请求
 * 已兑现）；行已终态时不做任何事（返回当前行，不抛错——运行收尾路径
 * 不应因注册表状态再炸一次）。
 */
export function markSubagentStopped(
  home: string,
  runId: string,
  opts?: { by?: string; step?: string },
): SubagentRun {
  const by = (opts?.by ?? "agent").slice(0, 60);
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status !== "running" && row.status !== "resume_pending") return row;
  if (opts?.step) row.lastStep = String(opts.step).slice(0, 300);
  row.status = "stopped";
  row.stopReason = "cancelled";
  row.stoppedAt = nowIso();
  row.stopRequestedAt = null;
  row.stopRequestedBy = null;
  row.stopNote = null;
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  appendStopEvent(home, runId, "subagent_stopped", { run_id: runId, by, step: row.lastStep ?? "" });
  return row;
}

/** 取消停止请求：清掉 stopRequestedAt/By/Note，行回到可续跑状态。
 * 任务板任务若已因这次请求进了 review，不自动搬回来——等人用 kanban decide 定。 */
export function cancelSubagentStop(home: string, runId: string, opts?: { by?: string }): SubagentRun {
  const by = (opts?.by ?? "operator").slice(0, 60);
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (!row.stopRequestedAt) throw new ResumeError(`子 agent 运行 ${runId} 没有待处理的停止请求，无须取消`);
  row.stopRequestedAt = null;
  row.stopRequestedBy = null;
  row.stopNote = null;
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  appendStopEvent(home, runId, "subagent_stop_cancelled", { run_id: runId, by });
  return row;
}

const USAGE =
  "用法：nyra subagent <list|show|register|heartbeat|sweep|resume|suspend|stop|confirm-stopped|cancel-stop|steer> [选项]\n" +
  "  list [--status running|resume_pending|suspended|completed|failed|stopped] [--agent <名字>] [--json]\n" +
  "  show <运行 id> [--json]\n" +
  "  register <运行 id> [--agent <名字>] [--workdir <目录>] [--mode readonly|auto] [--auto-resume] [--unattended] [--parent <父运行 id>]\n" +
  "  heartbeat <运行 id> \"<做到哪一步>\"\n" +
  "  sweep [--auto]        启动扫荡：running 的行按心跳标 resume_pending/挂起；--auto 只续跑 autoResume=true 的行\n" +
  "  resume <运行 id> [--force]   先验状态再续跑；无人值守的行强制只读；挂起的行须 --force\n" +
  "  suspend <运行 id>\n" +
  "  stop <运行 id> --yes [--reason \"<原因>\"] [--by <名字>]   请求停止（沿 parentRunId 递归停子树；在途调用收到取消信号后 abort，停没停下以 confirm-stopped 为准）\n" +
  "  confirm-stopped <运行 id> [--step \"<停在哪一步>\"] [--by <名字>]   确认已停下（只对已停的事实断言，没停不要调）\n" +
  "  cancel-stop <运行 id> [--by <名字>]   取消停止请求（任务板任务若已进 review，等人用 kanban decide 定）\n" +
  "  steer <运行 id> \"<引导文本>\" --yes [--by <名字>]   排队引导（只确认“已排队”，子 agent 在下一个检查点消费；在跑的工具调用不会被打断）\n";

export async function handleSubagent(argv: string[], home: string): Promise<number> {
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
    if (action === "list") {
      const rows = listSubagentRuns(resolvedHome, {
        status: get("--status") as SubagentStatus | undefined,
        agent: get("--agent"),
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return 0;
      }
      if (!rows.length) {
        process.stdout.write("注册表里没有子 agent 运行（nyra subagent register <运行 id> 注册）。\n");
        return 0;
      }
      for (const r of rows) {
        process.stdout.write(`${r.runId} [${r.status}] ${r.agent} 续跑 ${r.restarts} 次${r.autoResume ? " auto" : ""}${r.lastStep ? ` 上一步：${r.lastStep.slice(0, 50)}` : ""}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const row = getSubagentRun(resolvedHome, argv[1] ?? "");
      process.stdout.write(JSON.stringify(row, null, 2) + "\n");
      return 0;
    }
    if (action === "register") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent register <运行 id> [--agent <名字>] [--auto-resume] [--unattended] [--mandate <授权 id>] [--parent <父运行 id>]\n");
        return 2;
      }
      const row = registerSubagentRun(resolvedHome, {
        runId, agent: get("--agent"), workdir: get("--workdir"),
        mode: get("--mode"), autoResume: argv.includes("--auto-resume"),
        unattended: argv.includes("--unattended"), mandateId: get("--mandate") ?? undefined,
        parentRunId: get("--parent") ?? undefined,
      });
      process.stdout.write(`已注册子 agent 运行 ${row.runId}（${row.status}）。\n`);
      return 0;
    }
    if (action === "heartbeat") {
      const runId = argv[1] ?? "";
      const step = argv[2] ?? "";
      if (!runId || !step) {
        process.stderr.write("错误：用法：nyra subagent heartbeat <运行 id> \"<做到哪一步>\"\n");
        return 2;
      }
      const row = heartbeatSubagent(resolvedHome, runId, step);
      process.stdout.write(`${row.runId} 心跳已记：${row.lastStep}\n`);
      return 0;
    }
    if (action === "sweep") {
      const report = await sweepSubagents(resolvedHome, { auto: argv.includes("--auto") });
      if (report.skipped) {
        process.stdout.write(`${report.skipped}\n`);
        return 0;
      }
      process.stdout.write(`扫荡完成：标 resume_pending ${report.markedPending.length} 个，挂起 ${report.suspended.length} 个，自动续跑 ${report.resumed.length} 个。\n`);
      return 0;
    }
    if (action === "resume") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent resume <运行 id> [--force]\n");
        return 2;
      }
      const result = await resumeSubagentRun(resolvedHome, runId, { force: argv.includes("--force") });
      process.stdout.write(`续跑完成：${runId} 状态 ${result.status}（续跑 ${result.restarts} 次，中断调用补了 ${result.interruptedToolCalls} 个占位结果）。\n${result.output}\n`);
      return result.status === "failed" || result.status === "verify_failed" ? 4 : 0;
    }
    if (action === "suspend") {
      const row = suspendSubagentRun(resolvedHome, argv[1] ?? "");
      process.stdout.write(`${row.runId} 已挂起（${row.status}）。\n`);
      return 0;
    }
    if (action === "stop") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent stop <运行 id> --yes [--reason \"<原因>\"] [--by <名字>]\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        process.stderr.write("停止一个子 agent 须加 --yes 确认：nyra subagent stop <运行 id> --yes（只记“已请求停止”，不停下来不算停）\n");
        return 2;
      }
      const report = requestSubagentStop(resolvedHome, runId, { by: get("--by"), reason: get("--reason") });
      const parts: string[] = [];
      if (report.requested.length) parts.push(`已请求停止 ${report.requested.length} 个：${report.requested.join("、")}`);
      if (report.alreadyRequested.length) parts.push(`早已请求过 ${report.alreadyRequested.length} 个：${report.alreadyRequested.join("、")}`);
      for (const s of report.skipped) parts.push(`${s.runId} 未停：${s.reason}`);
      parts.push("注意：这只是“请求停止”，在途调用收到取消信号后 abort、确认停下后行才标 stopped；若宽限内没停下来，行保持 running、如实写“正在停止”，须用 nyra subagent confirm-stopped 确认。");
      process.stdout.write(parts.join("\n") + "\n");
      return 0;
    }
    if (action === "confirm-stopped") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent confirm-stopped <运行 id> [--step \"<停在哪一步>\"] [--by <名字>]\n");
        return 2;
      }
      const row = acknowledgeSubagentStop(resolvedHome, runId, { by: get("--by"), step: get("--step") });
      process.stdout.write(`${row.runId} 已确认停下（${row.status}，停在：${row.lastStep ?? "未记步骤"}）。\n`);
      return 0;
    }
    if (action === "cancel-stop") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent cancel-stop <运行 id> [--by <名字>]\n");
        return 2;
      }
      const row = cancelSubagentStop(resolvedHome, runId, { by: get("--by") });
      process.stdout.write(`${row.runId} 的停止请求已取消（回到 ${row.status}，可正常续跑）。\n`);
      return 0;
    }
    if (action === "steer") {
      const runId = argv[1] ?? "";
      const text = argv[2] ?? "";
      if (!runId || !text) {
        process.stderr.write("错误：用法：nyra subagent steer <运行 id> \"<引导文本>\" --yes [--by <名字>]\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        process.stderr.write("给在跑的子 agent 发引导须加 --yes 确认：nyra subagent steer <运行 id> \"<引导文本>\" --yes（只确认“已排队”，子 agent 在下一个检查点才消费）\n");
        return 2;
      }
      const steer = queueSteer(resolvedHome, runId, text, { by: get("--by") });
      process.stdout.write(`引导已排队：${steer.id}（子 agent 在下一个检查点消费；在跑的工具调用不会被打断；排队不等于已送达）。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 subagent ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
