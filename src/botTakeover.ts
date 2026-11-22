// src/botTakeover.ts — 缺口 50 第二批：接管（take the wheel）。
//
// 口径（Bot 方向报告 §6 缺口 50）：接管是审计事件，不是悄悄接手。
//   - 生命周期：takeover（须 --yes 或交互确认，未确认不接管）→ 接管期间
//     Bot 暂停（任务板挂起：该电脑 agent 的 working/queued 任务进 paused，
//     新任务启动被拒、调度 tick 跳过，防双写）→ handover 交还给 Bot
//     （交还时记做了什么、Bot 从哪一步继续）。
//   - 审计：每次接管记一条审计——谁、何时、为什么、暂停了几个任务、做了
//     什么、交还时状态——进接管账本（takeovers.json，原子写 0600）+ 电脑
//     活动账本（screen.takeover / screen.handover）+ 运行事件
//     （bot_takeover_started / bot_takeover_ended，有 --run 且运行存在时
//     才镜像）+ 时间线渲染。审计里不记密码/验证码/支付信息原文——交还时
//     填的 did / resumeFrom 先过第一批的确定性打码（redactScreenText）。
//   - 可见性：接管只能由机主或信任圈成员发起（缺口 34 的 isAdmitted，
//     与第一批看屏同款门）；圈外直接拒绝。交还只能由接管那个人或机主做。
//   - 电脑本身的状态机不动：ComputerState 只认 active / sleeping，接管
//     不改电脑状态——“暂停”只落在任务板上（paused）与接管账本里
//     （status active），不另起一套电脑状态。
//   - 假模型诚实说明：本机没有真实浏览器画面，本批的接管动作是确定性
//     模型——接管只记“我接管了、Bot 停了、我做了什么、交还了”，不抓真实
//     浏览器画面、不注入真实输入；真实浏览器画面的抓取与输入注入未接通。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getComputer, recordComputerActivity, ComputerError } from "./bot/computer.ts";
import { getKanbanTask, listKanbanTasks, pauseKanbanTask, resumeKanbanTask, KanbanError } from "./kanban.ts";
import { isAdmitted, OWNER_IDENTITY } from "./circles.ts";
import { RunStore } from "./runs.ts";
import { redactScreenText, SCREEN_REDACTION_KINDS, type ScreenRedactionKind } from "./botScreen.ts";
import {
  getActiveTakeover,
  listTakeovers,
  loadTakeoverLedger,
  newTakeoverId,
  saveTakeoverLedger,
  type TakeoverRecord,
} from "./takeoverLedger.ts";

export class TakeoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TakeoverError";
  }
}

const RUN_ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

/** 接管人准入：机主永远能接管；别人须已批准好友且在任一信任圈里（与看屏同款门）。 */
export function checkTakeoverActor(home: string, actor: string): { allowed: boolean; reason: string } {
  if (!actor.trim()) return { allowed: false, reason: "接管要指明是谁在接管（--as <身份>，默认机主）" };
  if (actor === OWNER_IDENTITY) return { allowed: true, reason: "机主本人" };
  if (isAdmitted(home, actor)) return { allowed: true, reason: "信任圈成员" };
  return { allowed: false, reason: `${actor} 不在信任圈里，不能接管这台电脑（先 nyra circle invite <圈名> ${actor}）` };
}

function requireActor(home: string, actor: string): void {
  const check = checkTakeoverActor(home, actor);
  if (!check.allowed) throw new TakeoverError(`接管被拒：${check.reason}`);
}

/** 运行事件镜像：只在运行真实存在时写（账本是源头，镜像丢了不影响审计）。 */
function mirrorToRun(home: string, runId: string | null | undefined, type: string, fields: Record<string, unknown>): void {
  if (!runId || !RUN_ID_RE.test(runId)) return;
  if (!existsSync(join(home, "runs", runId, "state.json"))) return;
  try {
    new RunStore(join(home, "runs")).appendEvent(runId, type, fields);
  } catch { /* 镜像失败不影响接管 */ }
}

export interface TakeoverOptions {
  reason?: string;
  /** 须显式确认（CLI 传 --yes；没确认直接拒绝，不接管）。 */
  confirm: boolean;
  runId?: string | null;
  at?: string;
}

/**
 * 接管：人接手这台电脑，Bot 暂停。
 * 前置：电脑存在且醒着（休眠的电脑没有进行中的操作可接管）；接管人须是
 * 机主或信任圈成员；须显式确认；同一台电脑不能同时有两场接管。
 * 暂停：该电脑 agent 的 working/queued 任务全部进 paused（原因记“接管”，
 * 交还时只恢复这些），新任务启动被拒、调度 tick 跳过（守卫在 kanban.ts 里）。
 */
export function takeoverComputer(home: string, computerId: string, by: string, opts: TakeoverOptions): TakeoverRecord {
  const computer = getComputer(home, computerId);
  requireActor(home, by);
  if (!opts.confirm) {
    throw new TakeoverError("接管是敏感操作，须加 --yes 确认（或交互确认）：接管期间 Bot 会暂停，交还后才继续");
  }
  if (computer.state === "sleeping") {
    throw new TakeoverError(`电脑 ${computerId} 在休眠，没有进行中的操作可接管（先 nyra bot computer wake ${computerId} 唤醒）`);
  }
  const existing = getActiveTakeover(home, computerId);
  if (existing) {
    throw new TakeoverError(`电脑 ${computerId} 已经被 ${existing.takenBy} 接管了（${existing.at}，原因：${existing.reason}），先等他交还`);
  }
  const reason = (opts.reason ?? "").trim() || "未说明原因";
  const at = opts.at ?? new Date().toISOString();
  // 暂停：只动 working/queued 的任务；paused/blocked/review/done 的不动。
  const toPause = listKanbanTasks(home, { agent: computer.agent }).filter(
    (t) => t.status === "working" || t.status === "queued",
  );
  const pausedTaskIds: string[] = [];
  for (const task of toPause) {
    pauseKanbanTask(home, task.id, `接管 ${computerId}（${by}）：${reason}`, `接管暂停（${by}）：${reason}`);
    pausedTaskIds.push(task.id);
  }
  const record: TakeoverRecord = {
    id: newTakeoverId(),
    computerId,
    agent: computer.agent,
    takenBy: by,
    reason,
    at,
    status: "active",
    pausedTaskIds,
    handedBackAt: null,
    handedBackBy: null,
    did: null,
    resumeFrom: null,
    resumedTaskIds: [],
  };
  const ledger = loadTakeoverLedger(home);
  ledger.takeovers.push(record);
  saveTakeoverLedger(home, ledger);
  recordComputerActivity(home, {
    computerId,
    kind: "task",
    action: "screen.takeover",
    target: computer.name,
    ok: true,
    detail: `接管（${by}）：${reason}，暂停 ${pausedTaskIds.length} 个任务`,
  });
  mirrorToRun(home, opts.runId, "bot_takeover_started", {
    computer_id: computerId,
    takeover_id: record.id,
    taken_by: by,
    reason,
    paused_count: pausedTaskIds.length,
  });
  return record;
}

export interface HandoverOptions {
  /** 接管期间做了什么（先打码再记，原文不留存）。 */
  did?: string;
  /** Bot 从哪一步继续（先打码再记）。 */
  resumeFrom?: string;
  runId?: string | null;
  at?: string;
}

export interface HandoverResult {
  record: TakeoverRecord;
  /** 交还时恢复的任务 id（暂停时记的任务里，交还那一刻仍是 paused 的）。 */
  resumedTaskIds: string[];
  /** 交还时填的 did / resumeFrom 打了哪几类（没命中时为空）。 */
  redacted: ScreenRedactionKind[];
}

/**
 * 交还：把电脑还给 Bot，Bot 从挂起点继续。
 * 前置：这台电脑当前须有人在接管；交还只能由接管那个人或机主做（别人
 * 不能替人交还）。交还时填的 did / resumeFrom 先打码再记，原文不留存。
 * 恢复：接管时暂停的任务里，交还那一刻仍是 paused 的回 queued（下一轮
 * tick 再跑）；中途被人手动恢复过的不再动。
 */
export function handoverComputer(home: string, computerId: string, by: string, opts: HandoverOptions = {}): HandoverResult {
  const computer = getComputer(home, computerId);
  requireActor(home, by);
  const record = getActiveTakeover(home, computerId);
  if (!record) {
    throw new TakeoverError(`电脑 ${computerId} 现在没人接管，不用交还（要接管先 nyra screen takeover ${computerId} --yes）`);
  }
  if (by !== record.takenBy && by !== OWNER_IDENTITY) {
    throw new TakeoverError(`这场接管是 ${record.takenBy} 接的，只有他本人或机主能交还（你是 ${by}）`);
  }
  const at = opts.at ?? new Date().toISOString();
  const didRaw = (opts.did ?? "").trim();
  const resumeRaw = (opts.resumeFrom ?? "").trim();
  const didRedacted = didRaw ? redactScreenText(didRaw) : { text: "", redacted: [] as ScreenRedactionKind[] };
  const resumeRedacted = resumeRaw ? redactScreenText(resumeRaw) : { text: "", redacted: [] as ScreenRedactionKind[] };
  // 合并两处的打码种类，按固定顺序（与第一批 redactScreenText 同款口径）。
  const redactedSet = new Set([...didRedacted.redacted, ...resumeRedacted.redacted]);
  const redacted = SCREEN_REDACTION_KINDS.filter((k) => redactedSet.has(k));
  const resumedTaskIds: string[] = [];
  for (const taskId of record.pausedTaskIds) {
    try {
      const task = getKanbanTask(home, taskId);
      if (task.status !== "paused") continue;
      resumeKanbanTask(home, taskId, `接管交还（${by}）：回队列等下一轮`);
      resumedTaskIds.push(taskId);
    } catch { /* 任务没了或状态变了就跳过，不拦交还 */ }
  }
  const ledger = loadTakeoverLedger(home);
  const stored = ledger.takeovers.find((t) => t.id === record.id);
  if (!stored) throw new TakeoverError(`接管记录 ${record.id} 不见了，交还失败`);
  stored.status = "handed_back";
  stored.handedBackAt = at;
  stored.handedBackBy = by;
  stored.did = didRedacted.text || null;
  stored.resumeFrom = resumeRedacted.text || null;
  stored.resumedTaskIds = resumedTaskIds;
  saveTakeoverLedger(home, ledger);
  recordComputerActivity(home, {
    computerId,
    kind: "task",
    action: "screen.handover",
    target: computer.name,
    ok: true,
    detail: `交还（${by}）：恢复 ${resumedTaskIds.length} 个任务${stored.resumeFrom ? `，从 ${stored.resumeFrom} 继续` : ""}`,
  });
  mirrorToRun(home, opts.runId, "bot_takeover_ended", {
    computer_id: computerId,
    takeover_id: record.id,
    handed_back_by: by,
    did: stored.did ?? "",
    resume_from: stored.resumeFrom ?? "",
  });
  return { record: stored, resumedTaskIds, redacted };
}

// ---------------------------------------------------------------------------
// 状态：这台电脑的接管情况（只读）
// ---------------------------------------------------------------------------

export interface TakeoverStatusView {
  computerId: string;
  agent: string;
  state: string;
  /** 正在进行的接管（没有时为 null）。 */
  active: TakeoverRecord | null;
  /** 最近一次已交还的接管（没有时为 null）。 */
  lastHandedBack: TakeoverRecord | null;
}

export function takeoverStatus(home: string, computerId: string, viewer: string): TakeoverStatusView {
  const computer = getComputer(home, computerId);
  requireActor(home, viewer);
  const all = listTakeovers(home, computerId);
  const handedBack = all.filter((t) => t.status === "handed_back");
  return {
    computerId,
    agent: computer.agent,
    state: computer.state,
    active: getActiveTakeover(home, computerId),
    lastHandedBack: handedBack.length ? handedBack[handedBack.length - 1] : null,
  };
}

// ---------------------------------------------------------------------------
// CLI：`nyra screen takeover|handover <电脑 id>`（接管是写操作，须确认）
// ---------------------------------------------------------------------------

export const SCREEN_TAKEOVER_USAGE =
  "用法：nyra screen <takeover|handover> <电脑 id> [--as <身份>] [--yes] [--run <运行 id>]\n" +
  "  takeover <电脑 id> [--as <身份>] [--reason <原因>] [--run <运行 id>] --yes   接管（take the wheel）：人接手这台电脑，Bot 暂停（任务板挂起、新任务禁启动、调度 tick 跳过，防双写）；须 --yes 或交互确认\n" +
  "  handover <电脑 id> [--as <身份>] [--did <做了什么>] [--resume-from <从哪步继续>] [--run <运行 id>]   交还：把电脑还给 Bot，暂停的任务回队列从挂起点继续；did / resume-from 先打码（密码/验证码/卡号）再记，原文不留存";

export interface ScreenTakeoverCliInput {
  /** 确认：测试注入；没注入时 --yes 或交互读 stdin（y/yes 才算确认）。 */
  confirm?: (prompt: string) => Promise<boolean>;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

async function readConfirm(input: ScreenTakeoverCliInput | undefined, prompt: string): Promise<boolean> {
  if (input?.confirm) return input.confirm(prompt);
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
  });
  const v = answer.trim().toLowerCase();
  return v === "y" || v === "yes";
}

export async function handleScreenTakeover(argv: string[], home: string, input?: ScreenTakeoverCliInput): Promise<number> {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(SCREEN_TAKEOVER_USAGE + "\n");
      return 0;
    }
    if (cmd !== "takeover" && cmd !== "handover") {
      process.stdout.write(SCREEN_TAKEOVER_USAGE + "\n");
      return 2;
    }
    const id = argv[1];
    if (!id) {
      process.stderr.write(`用法：nyra screen ${cmd} <电脑 id>\n`);
      return 2;
    }
    const by = flagValue(argv, "--as") ?? OWNER_IDENTITY;
    const runId = flagValue(argv, "--run") ?? null;
    if (cmd === "takeover") {
      const reason = flagValue(argv, "--reason");
      let confirm = argv.includes("--yes");
      if (!confirm) {
        confirm = await readConfirm(input, `接管电脑 ${id} 吗？接管期间 Bot 会暂停（任务板挂起），交还后才继续 [y/N] `);
      }
      const record = takeoverComputer(home, id, by, { reason, confirm, runId });
      process.stdout.write(`已接管电脑 ${record.computerId}（agent ${record.agent}）— ${record.takenBy}，${record.at}\n`);
      process.stdout.write(`原因：${record.reason}\n`);
      process.stdout.write(`Bot 已暂停：${record.pausedTaskIds.length} 个任务进 paused（新任务禁启动、调度 tick 跳过，防双写）\n`);
      process.stdout.write(`交还：nyra screen handover ${record.computerId} [--did <做了什么>] [--resume-from <从哪步继续>]\n`);
      return 0;
    }
    const result = handoverComputer(home, id, by, {
      did: flagValue(argv, "--did"),
      resumeFrom: flagValue(argv, "--resume-from"),
      runId,
    });
    const record = result.record;
    process.stdout.write(`已交还电脑 ${record.computerId}（agent ${record.agent}）— ${record.handedBackBy}，${record.handedBackAt}\n`);
    if (record.did) process.stdout.write(`接管期间做了：${record.did}\n`);
    if (record.resumeFrom) process.stdout.write(`Bot 从这步继续：${record.resumeFrom}\n`);
    process.stdout.write(`恢复了 ${result.resumedTaskIds.length} 个任务回队列（下一轮 tick 再跑）\n`);
    if (result.redacted.length) process.stdout.write(`已打码：${result.redacted.join("、")}（原文不留存）\n`);
    return 0;
  } catch (err) {
    if (err instanceof TakeoverError || err instanceof ComputerError || err instanceof KanbanError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
