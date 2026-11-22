// src/roster.ts — H-1：并行子代理实时花名册（缺口 21 深化）+ H-3 单点停止的只读视图。
//
// 花名册是只读视图：每次调用从注册表 + 任务板 + 运行记录现算，不重新执行、
// 不花 token。主界面一行只放三项——状态、已耗时、当前动作；token/费用默认
// 不显示，点进详情（nyra roster show）才看（桌面取舍原则：token 消耗放
// 设置里，不放主界面；协作时各用各的 token）。
//
// 阶段口径复用 DSH-5 工单阶段表（src/timeline.ts 的 deriveRunStage）：
// 进行中 / 等回答 / 等审阅 / 已卡住 / 空闲。注册表行按心跳与状态映射过去——
// running + 新鲜心跳 = 进行中，心跳超 120 秒 = 已卡住（与扫荡同口径），
// resume_pending = 已卡住（已崩待续跑），suspended = 已卡住（连崩挂起），
// 终态（completed/failed/stopped）= 空闲；任务板 delegate 任务 working =
// 进行中、review = 等审阅（DSH-5 里 completed_unverified 就是等审阅）。
// 花名册是调用时的一张快照，没有实时推送通道——桌面版 live 面板是后话，
// CLI 文本版先把“卡在哪一眼可见”立起来。
import { join } from "node:path";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { deriveRunStage, formatDurationMs, stageDisplay, type RunStageInfo } from "./timeline.ts";
import { STALE_HEARTBEAT_MS, listSubagentRuns, type SubagentRun } from "./resume.ts";
import { listKanbanTasks, type KanbanTask } from "./kanban.ts";

export interface RosterRow {
  /** 显示 id：注册表行是运行 id，任务板行是任务 id。 */
  id: string;
  runId: string | null;
  agent: string;
  kind: "subagent" | "delegate-task";
  status: string;
  stage: RunStageInfo;
  elapsedMs: number | null;
  currentAction: string | null;
  stopRequested: boolean;
  parentRunId: string | null;
  kanbanTaskId: string | null;
  depth: number;
  /** H-7：委派层级（注册表里记的 delegateDepth；老行没有时为 null）。 */
  delegateDepth: number | null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

function rowFromRegistry(r: SubagentRun, nowMs: number): RosterRow {
  const createdMs = Date.parse(r.createdAt);
  const elapsedMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : null;
  let stage: RunStageInfo;
  if (TERMINAL_STATUSES.has(r.status)) {
    const done = r.status === "completed" ? "跑完了" : r.status === "failed" ? "失败了" : "已停下";
    stage = { stage: "idle", label: "空闲（已终态）", waitingOn: null, waitingFor: done };
  } else if (r.status === "suspended") {
    stage = { stage: "blocked", label: "已卡住", waitingOn: null, waitingFor: `连崩 ${r.restarts} 次已挂起，须 --force 续跑` };
  } else if (r.status === "resume_pending") {
    stage = { stage: "blocked", label: "已卡住", waitingOn: null, waitingFor: "已崩，待续跑" };
  } else {
    // running：心跳超 120 秒视为已崩（与扫荡同口径），其余走 DSH-5 阶段判定。
    const lastBeat = r.lastHeartbeatAt ? Date.parse(r.lastHeartbeatAt) : 0;
    const stale = !r.lastHeartbeatAt || nowMs - lastBeat >= STALE_HEARTBEAT_MS;
    stage = deriveRunStage({
      status: stale ? "interrupted" : "running",
      approvalsPending: [], delegatesPending: [], toolsPending: [],
      lastFailureTitle: stale ? "心跳超时（120 秒没动静）" : null,
    });
  }
  const stopRequested = r.stopRequestedAt !== null;
  if (stopRequested && stage.stage === "working") {
    stage = { ...stage, waitingFor: "已请求停止，在途调用收到取消信号后 abort，确认停下后标 stopped" };
  }
  return {
    id: r.runId, runId: r.runId, agent: r.agent, kind: "subagent",
    status: r.status, stage, elapsedMs,
    currentAction: r.lastStep ? r.lastStep.slice(0, 60) : null,
    stopRequested, parentRunId: r.parentRunId ?? null,
    kanbanTaskId: null, depth: 0,
    // H-7：老行没有 delegateDepth 字段时按 parentRunId 现算的层级兜底
    // （buildRoster 里统一回填，这里先置 null）。
    delegateDepth: typeof r.delegateDepth === "number" ? r.delegateDepth : null,
  };
}

function rowFromKanbanTask(t: KanbanTask, nowMs: number): RosterRow {
  const createdMs = Date.parse(t.createdAt);
  const elapsedMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : null;
  const stage = deriveRunStage({
    status: t.status === "review" ? "completed_unverified" : "running",
    approvalsPending: [], delegatesPending: [], toolsPending: [],
    lastFailureTitle: null,
  });
  return {
    id: t.id, runId: t.runId, agent: t.agent ?? "nyra", kind: "delegate-task",
    status: t.status, stage, elapsedMs,
    currentAction: t.lastError ? t.lastError.slice(0, 60) : t.title.slice(0, 60),
    stopRequested: false, parentRunId: null, kanbanTaskId: t.id, depth: 0,
    delegateDepth: null,
  };
}

/** 现算花名册：注册表行 + 没绑注册表行的任务板 delegate 任务。
 * 默认只含未终态的行（在跑的才值得看），--all 才含终态行。 */
export function buildRoster(home: string, opts?: { now?: Date; includeTerminal?: boolean; agent?: string }): RosterRow[] {
  const nowMs = (opts?.now ?? new Date()).getTime();
  const rows: RosterRow[] = [];
  const byRunId = new Map<string, RosterRow>();
  for (const r of listSubagentRuns(home, { agent: opts?.agent })) {
    if (!opts?.includeTerminal && TERMINAL_STATUSES.has(r.status)) continue;
    const row = rowFromRegistry(r, nowMs);
    rows.push(row);
    byRunId.set(r.runId, row);
  }
  // 任务板上的 delegate 任务：绑了注册表行的挂上去（kanbanTaskId），没绑
  // 的单独成行，免得“在跑的任务板任务”在花名册上隐身。
  for (const t of listKanbanTasks(home, { agent: opts?.agent })) {
    if (t.kind !== "delegate") continue;
    if (t.status !== "working" && t.status !== "review") continue;
    if (t.runId && byRunId.has(t.runId)) {
      byRunId.get(t.runId)!.kanbanTaskId = t.id;
      continue;
    }
    rows.push(rowFromKanbanTask(t, nowMs));
  }
  // 子树深度：沿 parentRunId 往上数，成环时兜底（不死循环）。
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    let depth = 0;
    let cur = r.parentRunId;
    const seen = new Set<string>([r.id]);
    while (cur && byId.has(cur) && depth < 5) {
      if (seen.has(cur)) break;
      seen.add(cur);
      depth += 1;
      cur = byId.get(cur)!.parentRunId;
    }
    r.depth = depth;
  }
  rows.sort((a, b) => (a.depth - b.depth) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/** 文本花名册：一行只放状态 + 已耗时 + 当前动作，不放 token/费用。 */
export function formatRosterText(rows: RosterRow[]): string {
  if (!rows.length) return "花名册是空的（没有在跑的子 agent；nyra subagent register <运行 id> 注册）。";
  const lines = ["子 agent 花名册（只读快照：调用时现算，不重新执行、不花 token；token/费用默认不显示，详情看 nyra roster show）：", ""];
  for (const r of rows) {
    const indent = "  ".repeat(r.depth);
    const action = r.currentAction ? ` · ${r.currentAction}` : "";
    const stop = r.stopRequested ? " · 已请求停止" : "";
    const task = r.kind === "delegate-task" ? "（任务板任务）" : "";
    lines.push(`${indent}${r.id} [${stageDisplay(r.stage)}] ${r.agent} ${formatDurationMs(r.elapsedMs)}${action}${stop}${task}`);
  }
  return lines.join("\n");
}

export interface RosterDetail {
  row: RosterRow;
  /** 用量详情只在详情里出现（token/费用默认折叠，点进来才看）。 */
  usage: { calls: number; delegateCalls: number; totalTokens: number | null; spentUsd: number | null } | null;
  runStatus: string | null;
}

export function getRosterDetail(home: string, id: string): RosterDetail {
  const rows = buildRoster(home, { includeTerminal: true });
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`花名册里没有 ${id}`);
  let usage: RosterDetail["usage"] = null;
  let runStatus: string | null = null;
  if (row.runId) {
    for (const dir of ["tasks", "runs"]) {
      try {
        const store = new RunStore(join(home, dir));
        const state = store.load(row.runId);
        runStatus = state.status;
        const s = (state.usage_summary ?? {}) as Record<string, unknown>;
        usage = {
          calls: typeof s.calls === "number" ? s.calls : 0,
          delegateCalls: typeof s.delegate_calls === "number" ? s.delegate_calls : 0,
          totalTokens: typeof s.total_tokens === "number" ? s.total_tokens : null,
          spentUsd: typeof s.spent_usd === "number" ? s.spent_usd : null,
        };
        break;
      } catch { /* 不在这个目录 */ }
    }
  }
  return { row, usage, runStatus };
}

export function formatRosterDetailText(detail: RosterDetail): string {
  const { row, usage, runStatus } = detail;
  const lines = [
    `${row.id}（${row.kind === "delegate-task" ? "任务板任务" : "子 agent"}）`,
    `阶段：${stageDisplay(row.stage)}`,
    `状态：${row.status}${row.stopRequested ? "（已请求停止）" : ""}`,
    `agent：${row.agent}${row.parentRunId ? ` · 父运行：${row.parentRunId}` : ""}${row.kanbanTaskId ? ` · 任务板：${row.kanbanTaskId}` : ""}`,
    `委派层级：${row.delegateDepth !== null ? `第 ${row.delegateDepth} 层` : "未记（老行）"}`,
    `已耗时：${formatDurationMs(row.elapsedMs)}`,
    `当前动作：${row.currentAction ?? "未记"}`,
    `运行记录状态：${runStatus ?? "找不到运行记录"}`,
  ];
  if (usage) {
    lines.push(`用量详情：模型调用 ${usage.calls} 次 · 子任务调用 ${usage.delegateCalls} 次 · token 合计 ${usage.totalTokens ?? "未知"} · 花费 ${usage.spentUsd !== null ? `$${usage.spentUsd.toFixed(4)}` : "未知"}`);
  } else {
    lines.push("用量详情：无（没有可读的运行记录）");
  }
  return lines.join("\n");
}

const USAGE =
  "用法：nyra roster <list|show> [选项]\n" +
  "  list [--all] [--agent <名字>] [--json]   实时花名册：状态 + 已耗时 + 当前动作（只读快照，不花 token；token/费用默认不显示）\n" +
  "  show <运行 id> [--json]                 看一行详情（含用量详情：token/费用只在详情里出现）\n";

export function handleRoster(argv: string[], home: string): number {
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
      const rows = buildRoster(resolvedHome, {
        includeTerminal: argv.includes("--all"),
        agent: get("--agent"),
      });
      if (argv.includes("--json")) {
        // 列表 JSON 只含状态/耗时/动作，不含 token/费用（与文本输出同口径）。
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(formatRosterText(rows) + "\n");
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra roster show <运行 id> [--json]\n");
        return 2;
      }
      const detail = getRosterDetail(resolvedHome, id);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(detail, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(formatRosterDetailText(detail) + "\n");
      return 0;
    }
    process.stderr.write(`错误：未知子命令 roster ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
