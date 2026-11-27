// src/bot/notifier.ts — Bot 方向 Phase 3：场景 B 主动推送。
//
// 场景 B（个人/业务自动化监控与任务 Bot）的主动推送：定时任务/队列任务
// 跑完推结果、Heartbeat 静默巡查（只在有异常时推，无异常不打扰）、
// Watch 文件变化监测（变了才推一次，只报“变了”，不含文件内容）。
//
// 三条硬边界：
//   - 默认全关：notifier.enabled 须显式开；且须配了 owner（只有机主能
//     开）与 target_chat_id（推去哪），缺一个就不推、不报错刷屏；
//   - 推送内容只写结论与数字，不含用户原文、文件内容与敏感信息；watch
//     只记哈希、不读内容进推送；
//   - 去重防刷屏：同一条件在冷却期内只推一次（状态落盘
//     `~/.nyra/bot-notify-state.json`，0600、原子写）；watch 第一次见
//     到文件只记基线、不推。
//
// 证据：每次推送记一行 bot-audit.jsonl（outcome `notify:<kind>`）与运行
// 事件 bot_notify_sent；watch 变化另记 bot_watch_changed（只记哈希）。
// 事件落点复用 approvalBridge.ts 的 recordBotEvent（有运行目录走
// events.jsonl，没有走 evidence/bot/）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveNyraHome } from "../memory.ts";
import { recordBotEvent } from "./approvalBridge.ts";
import { atomicWriteJson } from "./dedupAndQuota.ts";
import type { BotNotifierPolicy } from "./types.ts";

export const BOT_NOTIFY_STATE_FILE = "bot-notify-state.json";

export interface NotifierState {
  /** 今日 token 花费。 */
  dailySpentUsd: number;
  /** 当天预算（null = 没配，不告警）。 */
  dailyBudgetUsd: number | null;
  /** 挂起审批数。 */
  pendingApprovals: number;
  /** 最老挂起审批已等多久（毫秒；null = 没有挂起）。 */
  oldestPendingApprovalMs: number | null;
  /** 会话队列深度。 */
  queueDepth: number;
}

export interface BotNotifierOptions {
  home: string;
  policy: BotNotifierPolicy;
  /** 机主 id（null = 没配，notifier 不开：只有 owner 能开）。 */
  owner: string | null;
  /** 发消息（BotRunner 传 adapter.sendText；daemon/worker 传新建的适配器）。 */
  send: (chatId: string, threadId: string | null, text: string) => Promise<string>;
  /** 审计回调（BotRunner 挂 bot-audit.jsonl；测试可记下来验）。 */
  audit?: (outcome: string, extra: Record<string, unknown>) => void;
  /** 推送事件要挂的运行 id（没有时为 null，走 evidence/bot/ 回落）。 */
  runId?: string | null;
  /** 读当前状态（BotRunner 传活的读数；daemon/worker 不传，tick 只跑 watch）。 */
  state?: () => NotifierState | null;
  now?: () => number;
}

export interface TaskResultInput {
  name: string;
  status: string;
  summary: string;
}

interface NotifyStateFile {
  version: number;
  /** 每条件上次推送时间（毫秒时间戳）。 */
  lastNotifiedAt: Record<string, number>;
  /** 每条件上次推送时的值（watch 记哈希）：值没变就不重推。 */
  lastValue: Record<string, string>;
  /** watch 上次见到的文件哈希（"missing" = 文件不存在）。 */
  watchHash: Record<string, string>;
}

function emptyStateFile(): NotifyStateFile {
  return { version: 1, lastNotifiedAt: {}, lastValue: {}, watchHash: {} };
}

function fileHash(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return "missing";
    const data = readFileSync(path);
    return createHash("sha256").update(data).digest("hex").slice(0, 12);
  } catch {
    return "missing";
  }
}

export class BotNotifier {
  readonly home: string;
  readonly policy: BotNotifierPolicy;
  private readonly owner: string | null;
  private readonly sendFn: BotNotifierOptions["send"];
  private readonly auditFn: BotNotifierOptions["audit"];
  private readonly runId: string | null;
  private readonly stateFn: BotNotifierOptions["state"];
  private readonly nowFn: () => number;
  private stateFile: NotifyStateFile;

  constructor(opts: BotNotifierOptions) {
    this.home = opts.home;
    this.policy = opts.policy;
    this.owner = opts.owner;
    this.sendFn = opts.send;
    this.auditFn = opts.audit;
    this.runId = opts.runId ?? null;
    this.stateFn = opts.state;
    this.nowFn = opts.now ?? Date.now;
    this.stateFile = emptyStateFile();
    try {
      const raw = readFileSync(join(resolveNyraHome(this.home), BOT_NOTIFY_STATE_FILE), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const p = parsed as Partial<NotifyStateFile>;
        if (p.lastNotifiedAt && typeof p.lastNotifiedAt === "object") this.stateFile.lastNotifiedAt = p.lastNotifiedAt as Record<string, number>;
        if (p.lastValue && typeof p.lastValue === "object") this.stateFile.lastValue = p.lastValue as Record<string, string>;
        if (p.watchHash && typeof p.watchHash === "object") this.stateFile.watchHash = p.watchHash as Record<string, string>;
      }
    } catch { /* 没有或损坏都当空状态：最坏是多推一次，不丢告警 */ }
  }

  /** 开的条件：显式开 + 配了 owner + 配了目标会话；缺一个就不推。 */
  enabled(): boolean {
    return this.policy.enabled === true && this.owner !== null && this.policy.targetChatId !== null;
  }

  private save(): void {
    try {
      atomicWriteJson(this.home, BOT_NOTIFY_STATE_FILE, this.stateFile);
    } catch { /* 状态写盘失败不破坏推送：最坏是冷却失效多推一次 */ }
  }

  private audit(outcome: string, extra: Record<string, unknown>): void {
    try { this.auditFn?.(outcome, extra); } catch { /* 审计回调故障不改变推送语义 */ }
  }

  /**
   * 同一条件在冷却期内只推一次：值没变且没过冷却就跳过；否则记下这次
   * 推送的时间与值，返回 true。值变了立刻再推，不用等冷却过。
   */
  private shouldNotify(key: string, value: string): boolean {
    const now = this.nowFn();
    const lastAt = this.stateFile.lastNotifiedAt[key];
    const lastVal = this.stateFile.lastValue[key];
    if (lastVal === value && typeof lastAt === "number" && now - lastAt < this.policy.notifyCooldownMs) return false;
    this.stateFile.lastNotifiedAt[key] = now;
    this.stateFile.lastValue[key] = value;
    this.save();
    return true;
  }

  /** 发一条推送：记审计 + 运行事件；发送失败返回 false（调用方不重试刷屏）。 */
  private async push(kind: string, text: string): Promise<boolean> {
    const target = this.policy.targetChatId;
    if (target === null) return false;
    try {
      await this.sendFn(target, null, text);
    } catch {
      return false;
    }
    this.audit(`notify:${kind}`, { target_chat_id: target });
    try {
      recordBotEvent(this.home, this.runId, "bot_notify_sent", { kind, target_chat_id: target, summary: text.slice(0, 100) }, `bot-notify://${kind}`);
    } catch { /* 事件写失败不改变推送结果 */ }
    return true;
  }

  /**
   * 定时/队列任务完成推送：notify_tasks = failures（默认）只推失败，
   * all 成功也推，none 不推。summary 只取前 200 字（调用方已截断过，
   * 这里再截一次防超长）。
   */
  async notifyTaskResult(result: TaskResultInput): Promise<boolean> {
    if (!this.enabled()) return false;
    const mode = this.policy.notifyTasks;
    if (mode === "none") return false;
    const ok = result.status === "ok";
    if (mode === "failures" && ok) return false;
    const summary = result.summary.slice(0, 200);
    const text = ok
      ? `定时任务「${result.name}」已完成：${summary}`
      : `定时任务「${result.name}」失败：${summary}`;
    return this.push("task_result", text);
  }

  /**
   * Heartbeat 巡查 + Watch：一轮检查，返回推出的文案（没异常返回空
   * 数组，不打扰）。state 读不到（daemon/worker 进程没传 state）时只
   * 跑 watch，heartbeat 检查跳过。
   */
  async tick(): Promise<string[]> {
    if (!this.enabled()) return [];
    const pushed: string[] = [];
    const st = this.stateFn ? this.stateFn() : null;
    if (st) {
      // 当天预算用完。
      if (st.dailyBudgetUsd !== null && st.dailySpentUsd >= st.dailyBudgetUsd && this.shouldNotify("daily-budget", "over")) {
        const text = `今天的 token 预算已用完（已花 $${st.dailySpentUsd.toFixed(4)}），今天不再进模型。`;
        if (await this.push("heartbeat", text)) pushed.push(text);
      }
      // 会话队列积压。
      if (st.queueDepth > this.policy.queueDepthWarn && this.shouldNotify("queue", "over")) {
        const text = `会话队列积压：${st.queueDepth} 条消息在排队（超过 ${this.policy.queueDepthWarn} 条的告警线）。`;
        if (await this.push("heartbeat", text)) pushed.push(text);
      }
      // 挂起审批没人批。
      if (st.pendingApprovals > 0 && st.oldestPendingApprovalMs !== null
        && st.oldestPendingApprovalMs >= this.policy.pendingApprovalWarnMinutes * 60000
        && this.shouldNotify("pending-approval", "waiting")) {
        const minutes = Math.floor(st.oldestPendingApprovalMs / 60000);
        const text = `有 ${st.pendingApprovals} 条审批等了超过 ${minutes} 分钟没人批（/status 可看列表）。`;
        if (await this.push("heartbeat", text)) pushed.push(text);
      }
    }
    // Watch：文件哈希变了才推一次，只报“变了”，不含文件内容。
    for (const w of this.policy.watches) {
      const hash = fileHash(w.file) ?? "missing";
      const prev = this.stateFile.watchHash[w.id];
      if (prev === undefined) {
        // 第一次见到：只记基线，不推。
        this.stateFile.watchHash[w.id] = hash;
        this.save();
        continue;
      }
      if (prev === hash) continue;
      if (!this.shouldNotify(`watch:${w.id}`, hash)) {
        this.stateFile.watchHash[w.id] = hash;
        this.save();
        continue;
      }
      this.stateFile.watchHash[w.id] = hash;
      this.save();
      const text = `监控目标「${w.label}」发生了变化。`;
      if (await this.push("watch", text)) {
        pushed.push(text);
        try {
          recordBotEvent(this.home, this.runId, "bot_watch_changed", { watch_id: w.id, label: w.label, from_hash: prev, to_hash: hash }, `bot-watch://${w.id}`);
        } catch { /* ignore */ }
      }
    }
    return pushed;
  }
}
