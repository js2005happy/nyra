// src/kanban.ts — 缺口 26：持久任务板（Kanban 式 durable work queue）。
//
// 任务是账本里的一行，不是内存里的对象：崩溃不丢、重启可续、审阅可往返、
// 完成有门。Hermes 只对 PR 任务验 CI checks；Nyra 的完成边界是通用的——
// 任何任务标 done 之前须附验证证据（方法 + 结论 + 通过与否），验证不过
// 不许标完成，验证结论进账本与证据链。这是“跑完能自证”在任务板上的落点。
//
// 账本 ~/.nyra/kanban.json（原子写 0600，损坏先备份再抛错，与
// regression-cases.json 同款口径）；只记元数据，不记任务正文以外的模型
// 输出、不记参数原文、不记绝对路径（workdir 只记相对路径或工作区名，
// 事件里更不记——过 appendEvent 的 redact 会把长词串掩掉）。
//
// 状态机：queued → working → review → working（批复）/ queued（打回）；
// working --失败--> queued（attempts+1）/ blocked（attempts 满 3 次，熔断）；
// working|review --附验证证据且通过--> done。blocked 只能由人 reset 回
// queued（nyra kanban reset），不自动放行。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { SOUL_AGENT_ID_RE } from "./soul.ts";
import { addTask, listTasks } from "./tasks.ts";
// 缺口 50 第二批：接管期间禁启动任务——只读接管账本的叶子模块
// （takeoverLedger 不 import 任何 src 模块，不形成循环导入）。
import { getActiveTakeoverForAgent } from "./takeoverLedger.ts";

export class KanbanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KanbanError";
  }
}

export type KanbanStatus = "queued" | "working" | "blocked" | "review" | "done" | "paused";
export type KanbanKind = "task" | "delegate" | "heartbeat" | "commitment";

export interface KanbanVerification {
  method: string;
  summary: string;
  passed: boolean;
  at: string;
}

export interface KanbanReview {
  by: string;
  note: string;
  at: string;
}

export interface KanbanTask {
  id: string;
  title: string;
  kind: KanbanKind;
  status: KanbanStatus;
  agent: string | null;
  workdir: string;
  runId: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  verification: KanbanVerification | null;
  review: KanbanReview | null;
  /** Pi Bot 借鉴第 3 条：卡住步骤看门狗——本轮卡住 episode 的首次发现
   * 时间（有进展即清零）；累计被标卡住次数；看门狗累计自动重排次数。 */
  stuckAt: string | null;
  stuckFlags: number;
  watchdogRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanHistoryEntry {
  at: string;
  action: string;
  taskId: string;
  note: string;
}

export interface KanbanStore {
  version: 1;
  tasks: KanbanTask[];
  history: KanbanHistoryEntry[];
}

export const KANBAN_MAX_ATTEMPTS = 3;
export const MAX_TITLE_CHARS = 200;

export function kanbanPath(home: string): string {
  return join(home, "kanban.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newTaskId(): string {
  return `kb_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadKanbanStore(home: string): KanbanStore {
  const path = kanbanPath(home);
  if (!existsSync(path)) return { version: 1, tasks: [], history: [] };
  if (lstatSync(path).isSymbolicLink()) throw new KanbanError("任务板账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new KanbanError("任务板账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as KanbanStore).version !== 1 ||
    !Array.isArray((raw as KanbanStore).tasks) || !Array.isArray((raw as KanbanStore).history)) {
    backupCorrupt(path);
    throw new KanbanError("任务板账本格式无效，已备份");
  }
  // Pi Bot 借鉴第 3 条：老行没有看门狗三字段，读时补默认值，下次保存即
  // 回写——只加字段，不改旧行的语义。
  for (const t of (raw as KanbanStore).tasks) {
    if (t.stuckAt === undefined) t.stuckAt = null;
    if (typeof t.stuckFlags !== "number") t.stuckFlags = 0;
    if (typeof t.watchdogRetries !== "number") t.watchdogRetries = 0;
  }
  return raw as KanbanStore;
}

export function saveKanbanStore(home: string, store: KanbanStore): void {
  const path = kanbanPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new KanbanError("任务板账本不能是符号链接");
  const tmp = join(dirname(path), `.kanban-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordHistory(store: KanbanStore, action: string, taskId: string, note: string): void {
  store.history.push({ at: nowIso(), action, taskId, note: note.slice(0, 200) });
  if (store.history.length > 500) store.history.splice(0, store.history.length - 500);
}

/** 有运行上下文时把任务板动作镜像进运行事件（证据链）；没上下文时账本
 *  history 就是审计，不静默丢——mirror 失败一律吞掉，只写账本。 */
function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

function getTask(store: KanbanStore, id: string): KanbanTask {
  const task = store.tasks.find((t) => t.id === id);
  if (!task) throw new KanbanError(`找不到任务板任务 ${id}`);
  return task;
}

export function createKanbanTask(
  home: string,
  opts: { title: string; kind?: KanbanKind; agent?: string | null; workdir?: string; maxAttempts?: number },
): KanbanTask {
  const title = (opts.title ?? "").trim();
  if (!title) throw new KanbanError("任务标题不能为空");
  if (title.length > MAX_TITLE_CHARS) throw new KanbanError("任务标题过长（超过 200 字符）");
  const kind = opts.kind ?? "task";
  if (!["task", "delegate", "heartbeat", "commitment"].includes(kind)) throw new KanbanError("任务类型无效");
  const agent = opts.agent ?? null;
  if (agent !== null && !SOUL_AGENT_ID_RE.test(agent)) throw new KanbanError("agent 必须是小写字母开头的 agent id（小写字母/数字/_/-，最长 32 字）");
  const maxAttempts = opts.maxAttempts ?? KANBAN_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new KanbanError("--max-attempts 必须是 1 到 10 的整数");
  const store = loadKanbanStore(home);
  const at = nowIso();
  const task: KanbanTask = {
    id: newTaskId(), title, kind, status: "queued", agent,
    workdir: opts.workdir ?? process.cwd(), runId: null,
    attempts: 0, maxAttempts, lastError: null, verification: null, review: null,
    stuckAt: null, stuckFlags: 0, watchdogRetries: 0,
    createdAt: at, updatedAt: at,
  };
  store.tasks.push(task);
  recordHistory(store, "created", task.id, `${kind} ${title.slice(0, 60)}`);
  saveKanbanStore(home, store);
  mirrorEvent(home, null, "kanban_created", { task_id: task.id, kind });
  return task;
}

export function getKanbanTask(home: string, id: string): KanbanTask {
  return getTask(loadKanbanStore(home), id);
}

export function listKanbanTasks(home: string, filter?: { status?: KanbanStatus; agent?: string }): KanbanTask[] {
  const store = loadKanbanStore(home);
  return store.tasks
    .filter((t) => (!filter?.status || t.status === filter.status) && (!filter?.agent || t.agent === filter.agent))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function transition(home: string, id: string, to: KanbanStatus, note: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  const from = task.status;
  task.status = to;
  // Pi Bot 借鉴第 3 条：离开 working 即本轮卡住 episode 结束，清标记
  // （stuckFlags 累计留着，watchdogRetries 是重排预算、由 reset 清）。
  if (to !== "working") task.stuckAt = null;
  task.updatedAt = nowIso();
  recordHistory(store, `status:${from}->${to}`, task.id, note);
  saveKanbanStore(home, store);
  mirrorEvent(home, task.runId, "kanban_transition", { task_id: task.id, from, to });
  return task;
}

export function startKanbanTask(home: string, id: string, runId?: string | null): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "queued") throw new KanbanError(`只能启动 queued 状态的任务，当前为 ${task.status}`);
  // 缺口 50 第二批：接管期间 Bot 已暂停——该 agent 的电脑正被人接管时，
  // 新任务一律禁启动（防双写；交还后恢复进队列再跑）。
  if (task.agent && getActiveTakeoverForAgent(home, task.agent)) {
    throw new KanbanError(`Bot 已暂停（接管中），先交还再启动任务：${task.agent} 的电脑正被人接管`);
  }
  if (runId) task.runId = runId;
  saveKanbanStore(home, store);
  return transition(home, id, "working", runId ? `开始执行，运行 ${runId}` : "开始执行");
}

/** 执行失败：attempts+1；满 maxAttempts 时熔断进 blocked（须人 reset），
 * 否则回 queued 等下一轮 tick 再跑。 */
export function failKanbanTask(home: string, id: string, error: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "working") throw new KanbanError(`只能标记 working 状态的任务失败，当前为 ${task.status}`);
  task.attempts += 1;
  task.lastError = String(error).slice(0, 300);
  task.updatedAt = nowIso();
  saveKanbanStore(home, store);
  if (task.attempts >= task.maxAttempts) {
    const done = transition(home, id, "blocked", `失败 ${task.attempts} 次，熔断进 blocked：${task.lastError.slice(0, 100)}`);
    mirrorEvent(home, task.runId, "kanban_blocked", { task_id: task.id, attempts: task.attempts });
    return done;
  }
  return transition(home, id, "queued", `失败 ${task.attempts}/${task.maxAttempts} 次，回队列：${task.lastError.slice(0, 100)}`);
}

/**
 * 缺口 43 第三批：分层成本上限触顶时的可恢复暂停态。
 * 暂停不是失败：attempts 不动（不进熔断计数），lastError 记触顶原因，
 * 恢复后回 queued 等下一轮 tick。只能从 working/queued 暂停（已在
 * working 的任务是上限回调直接停的；queued 的是手动暂停）。
 */
export function pauseKanbanTask(home: string, id: string, reason: string, note?: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "working" && task.status !== "queued") {
    throw new KanbanError(`只能暂停 working 或 queued 状态的任务，当前为 ${task.status}`);
  }
  task.lastError = String(reason).slice(0, 300);
  task.updatedAt = nowIso();
  saveKanbanStore(home, store);
  return transition(home, id, "paused", note ?? `分层成本上限暂停：${task.lastError.slice(0, 100)}`);
}

/** 从 paused 恢复：回 queued（不重置 attempts，下一轮 tick 再跑）。 */
export function resumeKanbanTask(home: string, id: string, note?: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "paused") throw new KanbanError(`只能恢复 paused 状态的任务，当前为 ${task.status}`);
  task.lastError = null;
  task.updatedAt = nowIso();
  saveKanbanStore(home, store);
  return transition(home, id, "queued", note ?? "分层上限放行，恢复进队列");
}

export function requestKanbanReview(home: string, id: string, by: string, note = ""): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "working") throw new KanbanError(`只能对 working 状态的任务请求审阅，当前为 ${task.status}`);
  task.review = { by: by.slice(0, 60), note: String(note).slice(0, 300), at: nowIso() };
  saveKanbanStore(home, store);
  return transition(home, id, "review", `请求审阅（${task.review.by}）`);
}

/** 审阅往返：批准回 working 继续干；打回回 queued 并记 note（下次接着改）。 */
export function decideKanbanReview(home: string, id: string, decision: "approve" | "reject", note = ""): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "review") throw new KanbanError(`只能批复 review 状态的任务，当前为 ${task.status}`);
  const cleanNote = String(note).slice(0, 300);
  task.review = { by: task.review?.by ?? "", note: cleanNote, at: nowIso() };
  saveKanbanStore(home, store);
  mirrorEvent(home, task.runId, "kanban_reviewed", { task_id: task.id, decision });
  if (decision === "approve") return transition(home, id, "working", `审阅通过：${cleanNote.slice(0, 100)}`);
  return transition(home, id, "queued", `审阅打回：${cleanNote.slice(0, 100)}`);
}

/** 附验证证据（通用完成边界的一半）：方法 + 结论 + 通过与否；不通过时
 * 任务留在原状态，只记证据——验证失败不是执行失败，不进熔断计数。 */
export function verifyKanbanTask(home: string, id: string, verification: { method: string; summary: string; passed: boolean }): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "working" && task.status !== "review") throw new KanbanError(`只能给 working/review 状态的任务附验证证据，当前为 ${task.status}`);
  const method = verification.method.trim().slice(0, 60);
  if (!method) throw new KanbanError("验证方法不能为空");
  task.verification = { method, summary: String(verification.summary).slice(0, 300), passed: verification.passed, at: nowIso() };
  task.updatedAt = nowIso();
  recordHistory(store, "verified", task.id, `${method}：${verification.passed ? "通过" : "未通过"}`);
  saveKanbanStore(home, store);
  mirrorEvent(home, task.runId, "kanban_verified", { task_id: task.id, method, passed: verification.passed });
  return task;
}

/** 完成边界：没有通过的验证证据，done 标不上去。模型的自述不算证据。 */
export function completeKanbanTask(home: string, id: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "working" && task.status !== "review") throw new KanbanError(`只能完成 working/review 状态的任务，当前为 ${task.status}`);
  if (!task.verification || !task.verification.passed) {
    throw new KanbanError("完成前须附通过的验证证据（先 nyra kanban verify --passed），没验证的完成标不上去");
  }
  return transition(home, id, "done", `完成（验证：${task.verification.method}）`);
}

/** 熔断后由人 reset：attempts 清零回 queued。不自动放行。
 * Pi Bot 借鉴第 3 条：看门狗的重排预算也清零（重新开始算），累计被标卡
 * 住的次数（stuckFlags）留着，那是历史。 */
export function resetKanbanTask(home: string, id: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "blocked") throw new KanbanError(`只能 reset blocked 状态的任务，当前为 ${task.status}`);
  task.attempts = 0;
  task.watchdogRetries = 0;
  task.lastError = null;
  saveKanbanStore(home, store);
  return transition(home, id, "queued", "人工 reset 回队列");
}

/** Pi Bot 借鉴第 3 条：看门狗重排用完仍卡住时直接进 blocked（不走 fail
 * 路径——fail 还要再攒 attempts，超限停下等人不该等熔断计数凑满）。 */
export function blockKanbanTask(home: string, id: string, reason: string): KanbanTask {
  const store = loadKanbanStore(home);
  const task = getTask(store, id);
  if (task.status !== "working") throw new KanbanError(`只能停下 working 状态的任务，当前为 ${task.status}`);
  task.lastError = String(reason).slice(0, 300);
  task.updatedAt = nowIso();
  saveKanbanStore(home, store);
  const done = transition(home, id, "blocked", `看门狗停下：${task.lastError.slice(0, 100)}`);
  mirrorEvent(home, task.runId, "kanban_blocked", { task_id: task.id, attempts: task.attempts });
  return done;
}

export function removeKanbanTask(home: string, id: string): boolean {
  const store = loadKanbanStore(home);
  const idx = store.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  store.tasks.splice(idx, 1);
  recordHistory(store, "removed", id, "已删除");
  saveKanbanStore(home, store);
  return true;
}

export interface KanbanTickReport {
  claimed: number;
  dispatched: number;
  runId: string | null;
  skipped: string | null;
}

/** 调度 tick（确定性部分）：取最老的一个 queued 任务交给 dispatch（调用方
 * 决定怎么跑——守护进程里 dispatch 是 tasks.addTask 进队列，worker 执行；
 * tick 本身不调模型、不执行任务）。dispatch 抛错走 fail 路径。 */
export function kanbanTick(
  home: string,
  opts: { dispatch: (task: KanbanTask) => string | null },
): KanbanTickReport {
  const queued = listKanbanTasks(home, { status: "queued" });
  if (!queued.length) return { claimed: 0, dispatched: 0, runId: null, skipped: "队列为空" };
  const task = queued[0];
  // 缺口 50 第二批：接管期间 Bot 已暂停——调度 tick 直接跳过，不 claim
  //（startKanbanTask 的守卫会拒启动；tick 在这里先跳过，不让任务进
  // working 也不进 fail 路径）。
  if (task.agent && getActiveTakeoverForAgent(home, task.agent)) {
    return { claimed: 0, dispatched: 0, runId: null, skipped: `Bot 已暂停（接管中），跳过派发：${task.agent} 的电脑正被人接管` };
  }
  // 先 claim（queued → working），再派发：派发抛错时任务已是 working，
  // 走同一条 fail 路径（attempts+1，满 3 次熔断）。
  startKanbanTask(home, task.id);
  let runId: string | null = null;
  try {
    runId = opts.dispatch(task);
  } catch (err: unknown) {
    failKanbanTask(home, task.id, err instanceof Error ? err.message : String(err));
    return { claimed: 1, dispatched: 0, runId: null, skipped: `派发失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 120) };
  }
  if (runId) {
    const store = loadKanbanStore(home);
    const claimed = getTask(store, task.id);
    claimed.runId = runId;
    claimed.updatedAt = nowIso();
    saveKanbanStore(home, store);
  }
  return { claimed: 1, dispatched: 1, runId, skipped: null };
}

/** 扫荡：working 任务绑的运行已进终态失败（failed/interrupted/
 * verify_failed）时走 fail 路径；runStatus 由调用方提供（假函数可测）。
 * 缺口 43 第三批：运行因分层成本上限已超而失败时不走 fail 路径（不进
 * 熔断计数），走暂停路径——runError 由调用方提供（返回运行的 error 原文）。 */
export function sweepStaleWorking(
  home: string,
  runStatus: (runId: string) => string | null,
  runError?: (runId: string) => string | null,
): { swept: number; failed: string[] } {
  const working = listKanbanTasks(home, { status: "working" });
  const failed: string[] = [];
  for (const task of working) {
    if (!task.runId) continue;
    const status = runStatus(task.runId);
    if (status === "failed" || status === "interrupted" || status === "verify_failed") {
      const err = runError?.(task.runId) ?? null;
      if (err && err.includes("分层成本上限已超")) {
        pauseKanbanTask(home, task.id, err);
        failed.push(task.id);
        continue;
      }
      failKanbanTask(home, task.id, `运行 ${task.runId} 状态 ${status}`);
      failed.push(task.id);
    }
  }
  return { swept: failed.length, failed };
}

const USAGE =
  "用法：nyra kanban <create|list|show|start|fail|pause|resume|review|decide|verify|done|reset|remove|tick|sweep> [选项]\n" +
  "  create \"<标题>\" [--kind task|delegate|heartbeat|commitment] [--agent <名字>] [--workdir <目录>] [--max-attempts N]\n" +
  "  list [--status queued|working|blocked|review|done|paused] [--agent <名字>] [--json]\n" +
  "  show <任务 id> [--json]\n" +
  "  start <任务 id> [--run <运行 id>]\n" +
  "  fail <任务 id> \"<原因>\"\n" +
  "  pause <任务 id> \"<原因>\"    分层成本上限暂停（可恢复，attempts 不动）\n" +
  "  resume <任务 id>              从 paused 恢复回 queued\n" +
  "  review <任务 id> [--by <名字>]\n" +
  "  decide <任务 id> <approve|reject> [--note \"<说明>\"]\n" +
  "  verify <任务 id> --method \"<方法>\" --summary \"<结论>\" [--passed|--failed]\n" +
  "  done <任务 id>\n" +
  "  reset <任务 id>\n" +
  "  remove <任务 id> --yes\n" +
  "  tick            取最老 queued 任务进队列（dispatch 走 tasks.addTask，不调模型）\n" +
  "  sweep           working 任务绑的运行已失败时走 fail 路径\n";

export function handleKanban(argv: string[], home: string): number {
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
    if (action === "create") {
      const title = argv[1] ?? "";
      const kind = (get("--kind") as KanbanKind | undefined) ?? "task";
      const maxAttempts = get("--max-attempts") ? parseInt(get("--max-attempts")!, 10) : undefined;
      const task = createKanbanTask(resolvedHome, {
        title, kind, agent: get("--agent") ?? null,
        workdir: get("--workdir"), maxAttempts,
      });
      process.stdout.write(`${task.id}\n`);
      return 0;
    }
    if (action === "list") {
      const tasks = listKanbanTasks(resolvedHome, {
        status: get("--status") as KanbanStatus | undefined,
        agent: get("--agent"),
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(tasks, null, 2) + "\n");
        return 0;
      }
      if (!tasks.length) {
        process.stdout.write("任务板是空的（nyra kanban create \"<标题>\" 新建）。\n");
        return 0;
      }
      for (const t of tasks) {
        process.stdout.write(`${t.id} [${t.status}] ${t.kind} ${t.title.slice(0, 60)}${t.agent ? ` @${t.agent}` : ""}${t.attempts ? ` 失败 ${t.attempts}/${t.maxAttempts}` : ""}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const task = getKanbanTask(resolvedHome, argv[1] ?? "");
      process.stdout.write(JSON.stringify(task, null, 2) + "\n");
      return 0;
    }
    if (action === "start") {
      const task = startKanbanTask(resolvedHome, argv[1] ?? "", get("--run") ?? null);
      process.stdout.write(`${task.id} 已开始（${task.status}）\n`);
      return 0;
    }
    if (action === "fail") {
      const task = failKanbanTask(resolvedHome, argv[1] ?? "", argv[2] ?? "未说明原因");
      process.stdout.write(`${task.id} ${task.status}（失败 ${task.attempts}/${task.maxAttempts} 次）\n`);
      return 0;
    }
    // 缺口 43 第三批：分层成本上限暂停（可恢复，attempts 不动）。
    if (action === "pause") {
      const task = pauseKanbanTask(resolvedHome, argv[1] ?? "", argv[2] ?? "分层成本上限已超");
      process.stdout.write(`${task.id} 已暂停（${task.status}，恢复用 nyra kanban resume ${task.id}）\n`);
      return 0;
    }
    if (action === "resume") {
      const task = resumeKanbanTask(resolvedHome, argv[1] ?? "");
      process.stdout.write(`${task.id} 已恢复回队列（${task.status}）\n`);
      return 0;
    }
    if (action === "review") {
      const task = requestKanbanReview(resolvedHome, argv[1] ?? "", get("--by") ?? "reviewer");
      process.stdout.write(`${task.id} 已送审（${task.status}）\n`);
      return 0;
    }
    if (action === "decide") {
      const decision = argv[2] as "approve" | "reject" | undefined;
      if (decision !== "approve" && decision !== "reject") {
        process.stderr.write("错误：用法：nyra kanban decide <任务 id> <approve|reject> [--note \"<说明>\"]\n");
        return 2;
      }
      const task = decideKanbanReview(resolvedHome, argv[1] ?? "", decision, get("--note") ?? "");
      process.stdout.write(`${task.id} ${decision === "approve" ? "审阅通过，回 working" : "审阅打回，回 queued"}（${task.status}）\n`);
      return 0;
    }
    if (action === "verify") {
      const method = get("--method") ?? "";
      const summary = get("--summary") ?? "";
      if (!method || !summary) {
        process.stderr.write("错误：用法：nyra kanban verify <任务 id> --method \"<方法>\" --summary \"<结论>\" [--passed|--failed]\n");
        return 2;
      }
      const passed = argv.includes("--failed") ? false : true;
      const task = verifyKanbanTask(resolvedHome, argv[1] ?? "", { method, summary, passed });
      process.stdout.write(`${task.id} 验证证据已附：${method} ${passed ? "通过" : "未通过"}\n`);
      return 0;
    }
    if (action === "done") {
      const task = completeKanbanTask(resolvedHome, argv[1] ?? "");
      process.stdout.write(`${task.id} 已完成（${task.status}）\n`);
      return 0;
    }
    if (action === "reset") {
      const task = resetKanbanTask(resolvedHome, argv[1] ?? "");
      process.stdout.write(`${task.id} 已 reset 回队列（${task.status}）\n`);
      return 0;
    }
    if (action === "remove") {
      const id = argv[1] ?? "";
      if (!argv.includes("--yes")) {
        process.stderr.write("删除任务板任务须加 --yes 确认：nyra kanban remove <任务 id> --yes\n");
        return 2;
      }
      if (!removeKanbanTask(resolvedHome, id)) {
        process.stderr.write(`找不到任务板任务 ${id}\n`);
        return 1;
      }
      process.stdout.write(`已删除任务板任务 ${id}。\n`);
      return 0;
    }
    if (action === "tick") {
      // tick 的 dispatch 是 tasks.addTask：只进队列，不调模型，执行靠
      // `nyra task worker`（与调度器、事件触发同一条执行路）。
      const report = kanbanTick(resolvedHome, {
        dispatch: (task) => {
          const state = addTask(task.title, { workdir: task.workdir, mode: "auto", home: resolvedHome });
          return state.run_id;
        },
      });
      if (!report.claimed) {
        process.stdout.write("任务板没有 queued 任务，本轮无事可做。\n");
        return 0;
      }
      process.stdout.write(report.dispatched ? `已派发 1 个任务，运行 ${report.runId}（执行靠 nyra task worker）。\n` : `派发失败：${report.skipped}\n`);
      return report.dispatched ? 0 : 1;
    }
    if (action === "sweep") {
      const store = new RunStore(join(resolvedHome, "tasks"));
      const states = listTasks(store);
      const byId = new Map(states.map((s) => [s.run_id, s.status]));
      // 缺口 43 第三批：sweep 顺带把运行的 error 原文递进去——因分层成本
      // 上限已超而失败的走暂停路径（不进熔断计数），不是 fail 路径。
      const byErr = new Map(states.map((s) => [s.run_id, s.error ?? null]));
      const report = sweepStaleWorking(resolvedHome, (runId) => byId.get(runId) ?? null, (runId) => byErr.get(runId) ?? null);
      process.stdout.write(report.swept ? `扫荡完成：${report.swept} 个 working 任务绑的运行已失败，走 fail/暂停路径。\n` : "扫荡完成：没有 working 任务绑的运行已失败。\n");
      return 0;
    }
    process.stderr.write(`错误：未知子命令 kanban ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
