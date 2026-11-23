// src/tasks.ts — 任务队列，与 Python 版 nyra/tasks.py 同语义。
// 队列只允许 readonly / auto，不允许 full（定时与后台任务不做写入审批旁路）。
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeSync, fsyncSync, unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, resolveProfile, resolveProvider, resolveHome } from "./config.ts";
import { Provider, buildProviderChain } from "./providers.ts";
import { loadSession } from "./memory.ts";
import { RunStore, prepareResume, resolveVerifyOrigin, acceptVerifyCommand, resolveVerifySettings, RunNotResumable, type RunState } from "./runs.ts";
import { ApprovalRequired } from "./tools.ts";
import { Agent } from "./agent.ts";
import { resolveReviewerModel } from "./reviewer.ts";
import { markTaskOrigin, readTaskOrigin } from "./taskOrigin.ts";
import type { TaskOrigin } from "./contentLabels.ts";
import { pythonJsonDump } from "./pyjson.ts";
import { t } from "./i18n.ts";

export const TASKS_DIR = "tasks";
export const WORKER_LOCK = "worker.lock";
export const INBOX_NAME = "inbox.jsonl";
export const MAX_TASK_CHARS = 8000;

export class TaskError extends Error {
  constructor(message: string) { super(message); this.name = "TaskError"; }
}

export function nyraHome(home?: string): string {
  return home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
}

function taskStore(home?: string): RunStore {
  return new RunStore(join(nyraHome(home), TASKS_DIR));
}

function privateChmod(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { if (process.platform !== "win32") throw new Error(`无法设置权限：${path}`); }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

export class WorkerLock {
  path: string;
  private held = false;

  constructor(path: string) { this.path = path; }

  acquire(): boolean {
    try {
      const fd = openSync(this.path, "wx", 0o600);
      writeSync(fd, String(process.pid), null, "utf-8");
      closeSync(fd);
      this.held = true;
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      try {
        const raw = readFileSync(this.path, "utf-8").trim();
        const pid = parseInt(raw, 10);
        if (!Number.isNaN(pid)) {
          try { process.kill(pid, 0); return false; } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
              rmSync(this.path, { force: true });
              return this.acquire();
            }
            return false;
          }
        }
      } catch { /* ignore */ }
      return false;
    }
  }

  release(): void {
    if (this.held) { rmSync(this.path, { force: true }); this.held = false; }
  }
}

export function addTask(
  task: string,
  opts?: {
    workdir?: string; mode?: string; verifyCmd?: string | null; maxTurns?: number;
    store?: RunStore; config?: Record<string, unknown> | null; trustAgentsVerify?: boolean;
    home?: string;
    /**
     * 缺口 8：无人值守巡查——为 true 时模式强制 readonly（调用方传 auto 也
     * 按 readonly 落盘），并在运行记录里记 unattended: true。队列任务与
     * 人工运行不设：它们走“写操作挂起等审批”，不是无人值守。
     */
    unattended?: boolean;
    /**
     * 第 2 批 G-P1-10：任务来源（local/peer；不传默认 local）。MCP 派发
     * 传 peer，来源记进 ~/.nyra/task-origins.json，runOne 起 Agent 前
     * 读出来传给 Agent（peer 任务的写操作进提议门）。
     */
    origin?: TaskOrigin;
  },
): RunState {
  const workdir = opts?.workdir ?? process.cwd();
  const unattended = opts?.unattended === true;
  const mode = unattended ? "readonly" : (opts?.mode ?? "auto");
  if (!task || typeof task !== "string" || task.trim() === "") throw new TaskError("任务内容不能为空");
  if (task.length > MAX_TASK_CHARS) throw new TaskError("任务过长（超过 8000 字符）");
  if (!["readonly", "auto"].includes(mode)) throw new TaskError("队列任务只允许 readonly 或 auto");
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new TaskError("工作目录不存在");
  const maxTurns = opts?.maxTurns ?? 20;
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) throw new TaskError("--max-turns 必须为正整数");
  const config = opts?.config ?? loadConfig(opts?.home);
  const [command, source] = resolveVerifyOrigin(opts?.verifyCmd ?? null, config, workdir);
  let verifyCmd: string | null = null;
  let skipReason: string | null = null;
  if (command) {
    const [accepted, reason] = acceptVerifyCommand(command, source, {
      trustAgents: opts?.trustAgentsVerify ?? false, interactive: false,
    });
    verifyCmd = accepted;
    skipReason = reason;
  }
  const store = opts?.store ?? taskStore(opts?.home);
  const state = store.create(task, newSessionIdForTask(), workdir, mode, maxTurns, "queued", verifyCmd, { unattended });
  if (skipReason) store.update(state.run_id, { verify_result: { skip_reason: skipReason } });
  // 第 2 批 G-P1-10：来源记进任务来源账本（只记 run_id + 来源，不记任务文本）。
  // 记失败直接让派发报错——来源记不下来时这条任务不该悄悄按 local 跑。
  markTaskOrigin(opts?.home ?? null, state.run_id, opts?.origin ?? "local");
  return state;
}

function newSessionIdForTask(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

export function cancelTask(runId: string, store?: RunStore): RunState {
  const s = store ?? taskStore();
  const state = s.markStale(runId);
  if (state.status === "running" || state.status === "awaiting_approval") {
    throw new TaskError(`任务正在运行（${state.status}），不能取消`);
  }
  if (state.status === "queued") return s.setStatus(runId, "failed", { error: "已取消" });
  throw new TaskError(`任务当前状态为 ${state.status}，不能取消`);
}

export function listTasks(store?: RunStore): RunState[] {
  const s = store ?? taskStore();
  const result: RunState[] = [];
  for (const state of s.list()) {
    try { result.push(s.markStale(state.run_id)); } catch { result.push(state); }
  }
  return result;
}

export function showTask(runId: string, store?: RunStore, eventLimit = 20): [RunState, Record<string, unknown>[]] {
  const s = store ?? taskStore();
  const state = s.markStale(runId);
  const events: Record<string, unknown>[] = [];
  const path = join(s.baseDir, runId, "events.jsonl");
  if (existsSync(path) && !lstatSync(path).isSymbolicLink()) {
    const lines = readFileSync(path, "utf-8").split("\n");
    for (const line of lines.slice(-eventLimit)) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { continue; }
    }
  }
  return [state, events];
}

/**
 * NO_REPLY 静默收敛（与 Heartbeat / 晨间简报同款约定）：任务收尾在末尾输出
 * NO_REPLY，即“无须打扰用户”。runOne 不写收件箱、不回邮件，workerOnce
 * 不推 Bot 通知；运行记录本身照常留（证据链不断）。等待审批的任务不适用
 * ——审批本身就是待办，仍须写收件箱让人看到。
 */
export function isNoReplyReply(output: unknown): boolean {
  if (typeof output !== "string") return false;
  // 运行记录会在模型回复后追加 "----" 开头的统计行（用时/轮次/花费……）：
  // 只看模型回复本身，NO_REPLY 须是模型回复的最后一行。
  const lines = output.split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === "----") break;
    body.push(line.trim());
  }
  const nonEmpty = body.filter(Boolean);
  return nonEmpty.length > 0 && nonEmpty[nonEmpty.length - 1] === "NO_REPLY";
}

export function appendInbox(runId: string, status: string, summary: string, home?: string): void {
  const h = nyraHome(home);
  mkdirSync(h, { recursive: true });
  privateChmod(h, 0o700);
  const path = join(h, INBOX_NAME);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TaskError("inbox 不能是符号链接");
  const entry = { run_id: runId, status, summary: String(summary).slice(0, 200), read: false, at: nowIso() };
  const fd = openSync(path, "a", 0o600);
  try {
    privateChmod(path, 0o600);
    writeSync(fd, pythonJsonDump(entry) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function loadInbox(home?: string, unreadOnly = false): Record<string, unknown>[] {
  const path = join(nyraHome(home), INBOX_NAME);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return [];
  const items: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      if (typeof item === "object" && item !== null && (!unreadOnly || !item.read)) items.push(item);
    } catch { continue; }
  }
  return items;
}

export function markInboxRead(home?: string): number {
  const h = nyraHome(home);
  const path = join(h, INBOX_NAME);
  const items = loadInbox(home);
  if (!items.length || !items.some((i) => !i.read)) return 0;
  let counted = 0;
  const tmp = join(h, `.inbox-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    for (const item of items) {
      if (!item.read) { item.read = true; counted += 1; }
      writeSync(fd, pythonJsonDump(item) + "\n", null, "utf-8");
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  privateChmod(tmp, 0o600);
  renameSync(tmp, path);
  privateChmod(path, 0o600);
  return counted;
}

export function formatUnreadInbox(home?: string): string {
  const items = loadInbox(home, true);
  if (!items.length) return "";
  const lines = [t("inbox.title", { n: items.length })];
  for (const item of items) lines.push(`- ${item.run_id}  ${item.status}  ${item.summary ?? ""}`);
  return lines.join("\n");
}

function deferApproval(tool: string, summary: string): never {
  throw new ApprovalRequired(tool, summary);
}

export function buildProvider(config?: Record<string, unknown> | null, home?: string): [Provider, Record<string, unknown>] {
  const cfg = config ?? loadConfig(home);
  const profile = resolveProfile(null, cfg);
  const resolved = resolveProvider({ home: home ?? resolveHome(), config: cfg, providerName: profile.provider, model: profile.model ?? undefined });
  const provider = new Provider(resolved);
  if (!provider.hasCredentials()) throw new TaskError("当前模型没有可用凭证");
  return [provider, cfg];
}

export async function runOne(
  state: RunState,
  opts: { store: RunStore; provider: Provider; config?: Record<string, unknown> | null; resume?: boolean; interactive?: boolean; approveFn?: ((tool: string, summary: string, details?: Record<string, unknown>) => Promise<boolean | "always"> | boolean | "always") | null; home?: string; quietInbox?: boolean },
): Promise<[RunState, string]> {
  const [timeout, retries] = resolveVerifySettings(null, null, opts.config ?? null);
  const messages = loadSession(state.session_id, opts.home) ?? [];
  const defer = opts.approveFn !== undefined && opts.approveFn !== null ? opts.approveFn : (!opts.interactive ? deferApproval : null);
  const { RunRecorder } = await import("./runs.ts");
  // 第 2 批 G-P1-10：任务来源——起 Agent 前读来源账本传给 Agent；读不到
  // 按 local 处理（老任务没有来源记录）。对方身份名用默认 mcp-peer
  // （来源账本只记来源不记人名；MCP 派发的任务本来就来自 mcp-peer）。
  const taskOrigin = readTaskOrigin(opts.home ?? null, state.run_id);
  const agent = new Agent(opts.provider, {
    workdir: state.workdir, mode: state.mode, maxTurns: state.max_turns,
    // 缺口 8：运行记录里记了 unattended 的任务，Agent 同样以无人值守跑
    //（只读锁定 + 写操作工具层直接拒绝）；队列任务与人工运行不设。
    unattended: state.unattended === true,
    origin: taskOrigin ?? "local",
    sessionId: state.session_id, messages,
    interactive: defer !== null ? true : (opts.interactive ?? false),
    approveFn: defer ?? undefined, skillsDirs: [], home: opts.home,
    // 缺口 10：队列任务同样过独立审查（审查模型从配置解析）。
    reviewerModel: resolveReviewerModel(opts.config ?? {}).model,
  });
  const recorder = new RunRecorder(opts.store, agent, state.task, {
    state, verifyTimeout: timeout, verifyRetries: retries,
  });
  try {
    const output = await recorder.run(state.task);
    const final = opts.store.load(recorder.runId);
    // 缺口 8：巡查自己管汇报（按汇报条件写收件箱），runOne 的默认收件箱
    // 入口会打扰人（没发现也记一条），quietInbox 时跳过。
    // NO_REPLY：模型明确说无须打扰，收件箱与邮件回信都跳过（运行记录照常留）。
    const silent = isNoReplyReply(output);
    if (!opts.quietInbox && !silent) appendInbox(final.run_id, final.status, output, opts.home);
    // 缺口 22：邮件任务跑完回信（只回白名单发件人、只回原线程、一次一封；
    // 回信失败不破坏任务结果，只记 stderr）。
    if (!silent) {
      try {
        const { replyMailResultForRun } = await import("./mailInbox.ts");
        await replyMailResultForRun(final.run_id, final.status, output, { home: opts.home });
      } catch (err: unknown) {
        process.stderr.write(`邮件入口：回信失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return [final, output];
  } catch (err: unknown) {
    if (err instanceof ApprovalRequired) {
      const final = opts.store.load(recorder.runId);
      const pending = (final.pending_approval ?? {}) as Record<string, unknown>;
      const note = `等待审批：${pending.tool ?? ""}`;
      if (!opts.quietInbox) appendInbox(final.run_id, "awaiting_approval", note, opts.home);
      return [final, note];
    }
    throw err;
  }
}

export async function workerOnce(opts?: { store?: RunStore; provider?: Provider; config?: Record<string, unknown> | null; home?: string; onTaskResult?: (result: { name: string; status: string; summary: string }) => Promise<void> | void }): Promise<[RunState, string][]> {
  const store = opts?.store ?? taskStore(opts?.home);
  const provider = opts?.provider ?? buildProvider(opts?.config, opts?.home)[0];
  const processed: [RunState, string][] = [];
  for (;;) {
    const queued = listTasks(store).filter((s) => s.status === "queued").reverse();
    if (!queued.length) break;
    const state = store.claim(queued[0].run_id);
    const [final, output] = await runOne(state, { store, provider, config: opts?.config, interactive: false, home: opts?.home });
    processed.push([final, output]);
    // NO_REPLY：模型明确说无须打扰，Bot 通知也跳过。
    if (opts?.onTaskResult && !isNoReplyReply(output)) {
      try {
        // 队列任务没有人名，用 run_id 当标识，摘要放任务正文前 120 字。
        await opts.onTaskResult({ name: final.run_id, status: final.status, summary: final.task.replace(/\n/g, " ").slice(0, 120) });
      } catch { /* 推送失败不破坏任务结果 */ }
    }
  }
  return processed;
}

export async function approveTask(runId: string, opts?: { store?: RunStore; provider?: Provider; config?: Record<string, unknown> | null; home?: string }): Promise<[RunState, string]> {
  const store = opts?.store ?? taskStore(opts?.home);
  const state = store.markStale(runId);
  if (state.status !== "awaiting_approval") throw new TaskError(`只能批准处于 awaiting_approval 的任务，当前状态为 ${state.status}`);
  store.update(runId, { pending_approval: null });
  const [next, messages, count] = prepareResume(store, runId, { home: opts?.home });
  const provider = opts?.provider ?? buildProvider(opts?.config, opts?.home)[0];
  const [timeout, retries] = resolveVerifySettings(null, null, opts?.config ?? null);
  const { RunRecorder } = await import("./runs.ts");
  const agent = new Agent(provider, {
    workdir: next.workdir, mode: next.mode, maxTurns: next.max_turns,
    sessionId: next.session_id, messages, interactive: true, skillsDirs: [], home: opts?.home,
    // 缺口 10：批复后继续跑同样过独立审查。
    reviewerModel: resolveReviewerModel(opts?.config ?? {}).model,
  });
  const recorder = new RunRecorder(store, agent, next.task, {
    state: next, interruptedToolCalls: count, verifyTimeout: timeout, verifyRetries: retries,
  });
  const output = await recorder.run(next.task);
  const final = store.load(recorder.runId);
  appendInbox(final.run_id, final.status, output, opts?.home);
  // 缺口 22：邮件任务跑完回信（同 runOne：批复后跑完才回，等待审批时不回）。
  try {
    const { replyMailResultForRun } = await import("./mailInbox.ts");
    await replyMailResultForRun(final.run_id, final.status, output, { home: opts?.home });
  } catch (err: unknown) {
    process.stderr.write(`邮件入口：回信失败：${err instanceof Error ? err.message : String(err)}\n`);
  }
  return [final, output];
}

export async function handleTask(argv: string[], workdir: string): Promise<number> {
  if (!argv.length) { process.stdout.write("用法：nyra task <add|list|show|cancel|worker|approve> [选项]\n"); return 2; }
  const action = argv[0];
  const store = taskStore();

  if (action === "add") {
    const task = argv[1] ?? "";
    let wd = workdir; let verify: string | null = null; let mode = "auto";
    let maxTurns: number | null = null; let trust = false;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--workdir") wd = argv[++i];
      else if (argv[i] === "--verify") verify = argv[++i];
      else if (argv[i] === "--mode") mode = argv[++i];
      else if (argv[i] === "--max-turns") maxTurns = parseInt(argv[++i], 10);
      else if (argv[i] === "--trust-agents-verify") trust = true;
    }
    const config = loadConfig();
    const turns = maxTurns ?? (typeof config.max_turns === "number" ? config.max_turns : 20);
    try {
      const state = addTask(task, { workdir: wd, mode, verifyCmd: verify, maxTurns: turns, store, config, trustAgentsVerify: trust });
      const skip = (state.verify_result as Record<string, unknown> | null)?.skip_reason as string | undefined;
      if (skip) process.stderr.write(`注意：${skip}\n`);
      process.stdout.write(state.run_id + "\n");
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  if (action === "list") {
    for (const state of listTasks(store)) {
      const preview = state.task.replace(/\n/g, " ").slice(0, 60);
      process.stdout.write(`${state.run_id}  ${state.status}  ${preview}\n`);
    }
    return 0;
  }

  if (action === "show") {
    try {
      const [state, events] = showTask(argv[1], store);
      process.stdout.write(JSON.stringify({ state, events }, null, 2) + "\n");
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  if (action === "cancel") {
    try {
      cancelTask(argv[1], store);
      process.stdout.write(`已取消 ${argv[1]}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  if (action === "worker") {
    const once = argv.includes("--once");
    const intervalIdx = argv.indexOf("--interval");
    const interval = intervalIdx >= 0 ? parseFloat(argv[intervalIdx + 1]) : 2.0;
    const lock = new WorkerLock(join(store.baseDir, WORKER_LOCK));
    if (!lock.acquire()) { process.stderr.write("错误：已有 worker 在运行\n"); return 1; }
    try {
      for (;;) {
        try {
          const [provider, config] = buildProvider();
          // Phase 3：队列任务结果推送（Bot notifier；没开时返回 null，不推）。
          let taskNotifier: import("./bot/index.ts").BotNotifier | null = null;
          try {
            const { buildNotifierFromConfig } = await import("./bot/index.ts");
            taskNotifier = buildNotifierFromConfig(resolveHome(), config ?? loadConfig());
          } catch { /* notifier 建不起来就不推，不破坏 worker */ }
          const processed = await workerOnce({ store, provider, config, onTaskResult: taskNotifier ? (r) => { void taskNotifier!.notifyTaskResult(r); } : undefined });
          for (const [final, output] of processed) {
            process.stdout.write(`${final.run_id}  ${final.status}  ${String(output).split("\n")[0].slice(0, 80)}\n`);
          }
        } catch (err: unknown) {
          process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
          if (once) return 1;
        }
        if (once) return 0;
        await new Promise((r) => setTimeout(r, interval * 1000));
      }
    } finally {
      lock.release();
    }
  }

  if (action === "approve") {
    try {
      const [final, output] = await approveTask(argv[1], { store });
      process.stdout.write(output + "\n");
      return final.status !== "verify_failed" ? 0 : 4;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  process.stderr.write(`错误：未知子命令 task ${action}\n`);
  return 2;
}
