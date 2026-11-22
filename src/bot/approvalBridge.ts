// src/bot/approvalBridge.ts — Bot 方向 Phase 2：聊天内审批闭环。
//
// Agent 想做写操作时，checkApproval 调 BotRunner 挂进来的 approveFn，
// approveFn 到这里建一条挂起审批、向会话发提示（附 approvalId、风险说明、
// 参数摘要，带四个按钮），然后等人的决定：
//   - 审批人回 /approve <id> 或 /reject <id>，或点按钮 → decide() 解决；
//   - 批准可带档位：一次（默认）、本次会话（session）、一直（always）。
//     session 档只在内存里、进程重启即失效；always 档持久化进
//     bot-approval-grants.json，可用 /grants 查看、/revoke-grant 撤销；
//     授权只认“工具 + 参数指纹”精确匹配，不泛化；红线 never 档与角色
//     白名单仍在授权之前查——授权永远绕不过红线。
//   - 没人批、TTL 到了 → 自动拒绝（fail-closed）；
//   - /stop 或队列超时把在跑的任务掐了 → cancelSession() 把同会话的挂起项
//     一并取消，免得人晚一步点的“批准”复活一个已经没了的任务。
// 只有 owner / admin 能批（白名单在 config 的 bot.owner / bot.admins 里）；
// 非白名单的人点批准无效，并记审计。审批放行不绕过配额：放行只决定这
// 一次工具调用能不能跑，花费照常进用量账本、月度硬顶与单次硬顶照常由
// Agent 的 checkCost 在轮次里执行。
//
// 审计两路：每条结论写一行 ~/.nyra/bot-audit.jsonl（经注入的 audit 回调，
// 与主链路同一文件、同一口径，只记结论不记用户原文与参数原文）；同时
// 记运行事件 bot_approval_requested / bot_approval_decided（EVENT_FIELDS
// 已登记）：有对应运行目录时写它的 events.jsonl，没有时写
// evidence/bot/ 下的证据文件（与 recordReviewEvent 同款回落），两路都
// 失败时返回 "none"，调用方须在审计里写明、不能静默。
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore } from "../evidence.ts";
import { resolveNyraHome } from "../memory.ts";
import { RunStore } from "../runs.ts";
import { atomicWriteJson } from "./dedupAndQuota.ts";
import type { BotRole } from "./router.ts";
import type { BotPolicy } from "./types.ts";

export const BOT_APPROVALS_FILE = "bot-approvals.json";
/** 审批 id 长度（8 位 hex，聊天里手打也方便）。 */
export const APPROVAL_ID_BYTES = 4;
/** 按钮回调数据前缀（Telegram callback_data 上限 64 字节，id 只有 8 位，够用）。 */
export const APPROVAL_CALLBACK_PREFIX = "bot:";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

/**
 * 审批决定档位（借鉴 Hermes HQ 的 Run once / session / always）：
 *   - once：只放行这一次调用（默认；与以前行为一致）；
 *   - session：本次会话里同一工具 + 同一参数指纹不再问（只在内存里，
 *     进程重启即失效）；
 *   - always：以后都不再问（持久化进 bot-approval-grants.json，可撤销）。
 * 授权只认“工具 + 参数指纹”精确匹配（比前缀规则更窄，不泛化）；红线
 * never 档与角色白名单仍在授权之前查——授权永远绕不过红线。
 */
export type ApprovalScope = "once" | "session" | "always";
export const BOT_APPROVAL_GRANTS_FILE = "bot-approval-grants.json";

export interface ApprovalGrant {
  /** 授权 id（grant_<12hex>，与 8 位 hex 的审批 id 区分开）。 */
  id: string;
  tool: string;
  argsHash: string;
  scope: "session" | "always";
  /** session 档绑定的会话；always 档为 null（全会话通用）。 */
  sessionKey: string | null;
  grantedBy: string;
  grantedAt: number;
}

export interface PendingApproval {
  id: string;
  sessionKey: string;
  chatId: string;
  threadId: string | null;
  tool: string;
  /** 风险说明（checkApproval 传来的 summary，截断后存；只给审批人看，不进审计与事件）。 */
  summary: string;
  /** 参数指纹（tool + command/fileTarget/cwd 的 sha256 前 12 位，不可还原原文）。 */
  argsHash: string;
  requestedBy: string;
  requestedByRole: BotRole;
  /** 提示消息的平台侧 id（决定后编辑这条消息写结论）。 */
  promptMessageId: string | null;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: number;
  via?: "command" | "button" | "timeout" | "cancelled";
  /** 批准时带的档位（once 不记，session/always 记下来备查）。 */
  scope?: ApprovalScope;
  reason?: string;
}

export interface BridgeDecision {
  approved: boolean;
  decidedBy: string | null;
  via: "command" | "button" | "timeout" | "cancelled";
  reason: string;
  /** 批准时带的档位（授权覆盖放行时由 recordGrantUse 另记事件，这里不填）。 */
  scope?: ApprovalScope;
}

export interface DecideResult {
  ok: boolean;
  /** not-approver（不在白名单）/ not-found（没有这条或已处理）/ not-pending（已处理过）。 */
  reason?: string;
  decision?: BridgeDecision;
}

export type BotEventChannel = "events" | "evidence" | "none";

export interface ApprovalBridgeOptions {
  home: string;
  policy: BotPolicy;
  /** 发审批提示（返回平台侧消息 id）；按钮由调用方按 inlineKeyboard 传。 */
  send: (chatId: string, threadId: string | null, text: string, buttons?: { text: string; callbackData: string }[][]) => Promise<string>;
  /** 编辑提示消息写结论（没有时不编辑，只发新消息）。 */
  edit?: (chatId: string, messageId: string, text: string) => Promise<void>;
  /** 审计回调（BotRunner 挂 bot-audit.jsonl；测试可记下来验）。 */
  audit?: (outcome: string, extra: Record<string, unknown>) => void;
  /** 审批事件要挂的运行 id（Bot 不建运行记录时为 null，走 evidence/bot/ 回落）。 */
  runId?: string | null;
  /** 挂起 TTL（毫秒；默认取 policy.approvalTimeoutMs；测试可传很小的值）。 */
  ttlMs?: number;
  now?: () => number;
}

/**
 * 审批事件落点（与 reviewQueue.ts 的 recordReviewEvent 同款回落）：
 * 有对应运行目录 → 该运行的 events.jsonl；没有 → evidence/bot/ 下的
 * 证据文件；两路都失败 → "none"（调用方把结果写进审计，不静默）。
 */
export function recordBotEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>, evidenceKey?: string): BotEventChannel {
  const nyraHome = resolveNyraHome(home);
  if (runId) {
    for (const sub of ["runs", "tasks"]) {
      const base = join(nyraHome, sub);
      if (!existsSync(join(base, runId))) continue;
      try {
        new RunStore(base).appendEvent(runId, type, fields);
        return "events";
      } catch { /* 该 store 写失败就试下一个；都失败再走证据文件 */ }
    }
  }
  try {
    const id = String(fields.approval_id ?? "unknown");
    new EvidenceStore(join(nyraHome, "evidence"), "bot").save(
      type,
      evidenceKey ?? `bot-approval://${id}`,
      `${type} ${id} ${JSON.stringify(fields)}`,
    );
    return "evidence";
  } catch {
    return "none";
  }
}

/** 参数指纹：只记单向哈希，原文（命令、文件路径）绝不进审计与事件。 */
export function approvalArgsHash(input: { tool: string; command?: unknown; fileTarget?: unknown; cwd?: unknown }): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ tool: input.tool, command: input.command ?? null, fileTarget: input.fileTarget ?? null, cwd: input.cwd ?? null }));
  return h.digest("hex").slice(0, 12);
}

interface ApprovalsFile {
  version: number;
  approvals: Record<string, PendingApproval>;
}

interface GrantsFile {
  version: number;
  grants: Record<string, ApprovalGrant>;
}

export class ApprovalBridge {
  readonly home: string;
  readonly policy: BotPolicy;
  private readonly ttlMs: number;
  private readonly sendFn: ApprovalBridgeOptions["send"];
  private readonly editFn: ApprovalBridgeOptions["edit"];
  private readonly auditFn: ApprovalBridgeOptions["audit"];
  private readonly runId: string | null;
  private readonly nowFn: () => number;
  private items = new Map<string, PendingApproval>();
  private waiters = new Map<string, { resolve: (d: BridgeDecision) => void; timer: ReturnType<typeof setTimeout> }>();
  /** session 档授权：只在内存里，进程重启即失效。 */
  private sessionGrants = new Map<string, ApprovalGrant>();
  /** always 档授权：持久化进 bot-approval-grants.json。 */
  private alwaysGrants = new Map<string, ApprovalGrant>();

  constructor(opts: ApprovalBridgeOptions) {
    this.home = opts.home;
    this.policy = opts.policy;
    this.ttlMs = opts.ttlMs ?? opts.policy.approvalTimeoutMs;
    this.sendFn = opts.send;
    this.editFn = opts.edit;
    this.auditFn = opts.audit;
    this.runId = opts.runId ?? null;
    this.nowFn = opts.now ?? Date.now;
    this.load();
    this.loadGrants();
  }

  private load(): void {
    let data: ApprovalsFile | null = null;
    try {
      data = JSON.parse(readFileSync(join(resolveNyraHome(this.home), BOT_APPROVALS_FILE), "utf-8")) as ApprovalsFile;
    } catch { /* 没有账本或损坏都当空账本：挂起的审批本来就该过期失效 */ }
    if (!data || typeof data !== "object" || !data.approvals || typeof data.approvals !== "object") return;
    const now = this.nowFn();
    for (const item of Object.values(data.approvals)) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      // 上个进程留下的挂起项：没过期的留着等 sweep，过期的一律标 expired。
      if (item.status === "pending" && item.expiresAt <= now) item.status = "expired";
      this.items.set(item.id, item);
    }
  }

  private save(): void {
    try {
      atomicWriteJson(this.home, BOT_APPROVALS_FILE, { version: 1, approvals: Object.fromEntries(this.items) });
    } catch { /* 账本写盘失败不破坏审批流程：最坏是重启后挂起项丢失，超时自动拒绝兜底 */ }
  }

  /** 读 always 档授权（损坏或缺失都当空账本；session 档本来就不落盘）。 */
  private loadGrants(): void {
    let data: GrantsFile | null = null;
    try {
      data = JSON.parse(readFileSync(join(resolveNyraHome(this.home), BOT_APPROVAL_GRANTS_FILE), "utf-8")) as GrantsFile;
    } catch { /* 没有账本或损坏都当空账本 */ }
    if (!data || typeof data !== "object" || !data.grants || typeof data.grants !== "object") return;
    for (const g of Object.values(data.grants)) {
      if (!g || typeof g !== "object" || typeof g.id !== "string" || g.scope !== "always") continue;
      if (typeof g.tool !== "string" || typeof g.argsHash !== "string") continue;
      this.alwaysGrants.set(g.id, g);
    }
  }

  private saveGrants(): void {
    try {
      atomicWriteJson(this.home, BOT_APPROVAL_GRANTS_FILE, { version: 1, grants: Object.fromEntries(this.alwaysGrants) });
    } catch { /* 授权写盘失败不破坏审批流程：最坏是重启后 always 授权丢失，下次再问 */ }
  }

  private newGrantId(): string {
    let id = `grant_${randomBytes(6).toString("hex")}`;
    while (this.sessionGrants.has(id) || this.alwaysGrants.has(id)) id = `grant_${randomBytes(6).toString("hex")}`;
    return id;
  }

  /**
   * 查有没有覆盖这次调用的授权：先查本次会话的 session 档，再查 always 档。
   * 只做精确匹配（工具 + 参数指纹全等），不泛化。调用方须先查红线与角色
   * 白名单——授权查到也不绕过那两道门（见 BotRunner.approveViaBridge）。
   */
  findGrant(tool: string, argsHash: string, sessionKey: string): ApprovalGrant | null {
    for (const g of this.sessionGrants.values()) {
      if (g.tool === tool && g.argsHash === argsHash && g.sessionKey === sessionKey) return g;
    }
    for (const g of this.alwaysGrants.values()) {
      if (g.tool === tool && g.argsHash === argsHash) return g;
    }
    return null;
  }

  /**
   * 记一笔“授权覆盖放行”：不建挂起审批，但结论一样进审计与运行事件
   *（bot_approval_decided，decision approved，via grant-session /
   * grant-always，approval_id 记授权 id），证据链里看得出这次调用是
   * 靠授权放行的、不是新批的。
   */
  recordGrantUse(grant: ApprovalGrant, sessionKey: string): void {
    const via = grant.scope === "session" ? "grant-session" : "grant-always";
    const channel = this.record("bot_approval_decided", {
      approval_id: grant.id, decision: "approved", decided_by: grant.grantedBy, via,
      scope: grant.scope, reason: grant.scope === "session" ? "本次会话授权覆盖" : "一直批准授权覆盖",
    });
    this.audit("approval:grant-used", {
      approval_id: grant.id, session_key: sessionKey, tool: grant.tool,
      scope: grant.scope, granted_by: grant.grantedBy, event_channel: channel,
    });
  }

  /**
   * 授权覆盖放行（供 BotRunner.approveViaBridge 调）：同一工具 + 同一参数
   * 指纹已有 session/always 授权时记一笔授权使用（审计 + 事件）并返回
   * true；没有授权返回 false，调用方继续走正常审批链。红线与角色白名单
   * 由调用方在调这里之前查——授权绕不过那两道门。
   */
  tryGrant(tool: string, argsHash: string, sessionKey: string): boolean {
    const grant = this.findGrant(tool, argsHash, sessionKey);
    if (!grant) return false;
    this.recordGrantUse(grant, sessionKey);
    return true;
  }

  /** 列出全部授权（session 档在前、always 档在后，各按授权时间排）。 */
  listGrants(): ApprovalGrant[] {
    const all = [...this.sessionGrants.values(), ...this.alwaysGrants.values()];
    return all.sort((a, b) => a.grantedAt - b.grantedAt);
  }

  /** 撤销一条授权（session 档只清内存，always 档同时落盘）。不存在返回 false。 */
  revokeGrant(id: string): boolean {
    if (this.sessionGrants.delete(id)) return true;
    if (this.alwaysGrants.delete(id)) {
      this.saveGrants();
      return true;
    }
    return false;
  }

  private audit(outcome: string, extra: Record<string, unknown>): void {
    try { this.auditFn?.(outcome, extra); } catch { /* 审计回调故障不改变审批语义 */ }
  }

  private record(type: "bot_approval_requested" | "bot_approval_decided", fields: Record<string, unknown>): BotEventChannel {
    return recordBotEvent(this.home, this.runId, type, fields);
  }

  private newId(): string {
    let id = randomBytes(APPROVAL_ID_BYTES).toString("hex");
    while (this.items.has(id)) id = randomBytes(APPROVAL_ID_BYTES).toString("hex");
    return id;
  }

  /** 审批人白名单：只有 owner / admin 能批（member / guest 点了也无效）。 */
  canApprove(senderId: string): boolean {
    if (this.policy.owner !== null && senderId === this.policy.owner) return true;
    return this.policy.admins.includes(senderId);
  }

  pending(id: string): PendingApproval | undefined {
    return this.items.get(id);
  }

  pendingForSession(sessionKey: string): PendingApproval[] {
    return [...this.items.values()].filter((i) => i.sessionKey === sessionKey && i.status === "pending");
  }

  pendingCount(): number {
    let n = 0;
    for (const i of this.items.values()) if (i.status === "pending") n++;
    return n;
  }

  /** 最老挂起审批已等多久（毫秒；没有挂起时为 null；Phase 3 的 Heartbeat 提醒用）。 */
  oldestPendingAgeMs(now: number = Date.now()): number | null {
    let oldest: number | null = null;
    for (const i of this.items.values()) {
      if (i.status !== "pending") continue;
      if (oldest === null || i.createdAt < oldest) oldest = i.createdAt;
    }
    return oldest === null ? null : Math.max(0, now - oldest);
  }

  private promptText(item: PendingApproval): string {
    const seconds = Math.max(1, Math.round((item.expiresAt - item.createdAt) / 1000));
    return [
      `⏳ 需要审批（id：${item.id}）`,
      `工具：${item.tool}`,
      `说明：${item.summary.slice(0, 500)}`,
      `发起：${item.requestedBy}（${item.requestedByRole}）`,
      `${seconds} 秒内有效；管理员回复 /approve ${item.id} 或 /reject ${item.id}，或点下面的按钮。`,
      `“本次会话都批准”：这次会话里同样的操作不再问；“一直批准”：以后都不再问（只认这一次的工具与参数，可用 /grants 查看与撤销）。`,
      `超时没人批会自动拒绝。`,
    ].join("\n");
  }

  private outcomeText(item: PendingApproval): string {
    const mark = item.status === "approved" ? "✅ 已批准" : item.status === "rejected" ? "❌ 已拒绝" : item.status === "expired" ? "⌛ 已超时自动拒绝" : "🚫 已取消";
    const scopeNote = item.status === "approved" && item.scope === "session"
      ? "（本次会话里同样的操作不再问）"
      : item.status === "approved" && item.scope === "always"
        ? "（以后都不再问，可用 /grants 撤销）"
        : "";
    return [
      `${mark}${scopeNote}（id：${item.id}）`,
      `工具：${item.tool}`,
      item.decidedBy ? `决定人：${item.decidedBy}${item.via ? `（${item.via === "button" ? "按钮" : item.via === "command" ? "指令" : item.via}）` : ""}` : "",
      item.reason ? `原因：${item.reason}` : "",
    ].filter(Boolean).join("\n");
  }

  private async editPrompt(item: PendingApproval): Promise<void> {
    if (!this.editFn || !item.promptMessageId) return;
    try { await this.editFn(item.chatId, item.promptMessageId, this.outcomeText(item)); } catch { /* 提示消息编辑失败不改变审批结论 */ }
  }

  /**
   * 建一条挂起审批并向会话发提示。同一会话里同一工具 + 同一参数指纹已有
   * 挂起项时直接复用它（模型重试循环里重复问同一件事不会刷屏）。
   */
  async requestApproval(input: {
    sessionKey: string;
    chatId: string;
    threadId: string | null;
    tool: string;
    summary: string;
    argsHash: string;
    requestedBy: string;
    requestedByRole: BotRole;
  }): Promise<PendingApproval> {
    const existing = [...this.items.values()].find(
      (i) => i.status === "pending" && i.sessionKey === input.sessionKey && i.tool === input.tool && i.argsHash === input.argsHash,
    );
    if (existing) return existing;
    const now = this.nowFn();
    const item: PendingApproval = {
      id: this.newId(),
      sessionKey: input.sessionKey,
      chatId: this.policy.approvalChatId ?? input.chatId,
      threadId: this.policy.approvalChatId !== null ? null : input.threadId,
      tool: input.tool,
      summary: input.summary.slice(0, 500),
      argsHash: input.argsHash,
      requestedBy: input.requestedBy,
      requestedByRole: input.requestedByRole,
      promptMessageId: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "pending",
    };
    this.items.set(item.id, item);
    this.save();
    const buttons = [
      [
        { text: "✅ 批准一次", callbackData: `${APPROVAL_CALLBACK_PREFIX}approve-once:${item.id}` },
        { text: "❌ 拒绝", callbackData: `${APPROVAL_CALLBACK_PREFIX}reject:${item.id}` },
      ],
      [
        { text: "✅ 本次会话都批准", callbackData: `${APPROVAL_CALLBACK_PREFIX}approve-session:${item.id}` },
        { text: "✅ 一直批准", callbackData: `${APPROVAL_CALLBACK_PREFIX}approve-always:${item.id}` },
      ],
    ];
    try {
      item.promptMessageId = await this.sendFn(item.chatId, item.threadId, this.promptText(item), buttons);
    } catch { /* 提示发不出去不影响挂起项本身：/approve 指令照常能批 */ }
    this.save();
    const channel = this.record("bot_approval_requested", {
      approval_id: item.id, tool: item.tool, args_hash: item.argsHash,
      session_key: item.sessionKey, requested_by: item.requestedBy, role: item.requestedByRole,
    });
    this.audit("approval:requested", { approval_id: item.id, session_key: item.sessionKey, tool: item.tool, event_channel: channel });
    return item;
  }

  /**
   * 等一条审批的决定。TTL 到了自动拒绝（fail-closed）；调用方取消等待
   * 时（任务已停止/超时）用 cancelSession 解决，不要直接丢弃 promise。
   */
  waitForDecision(id: string): Promise<BridgeDecision> {
    const item = this.items.get(id);
    if (!item) {
      return Promise.resolve({ approved: false, decidedBy: null, via: "cancelled", reason: "审批不存在（可能已被清理）。" });
    }
    if (item.status !== "pending") {
      return Promise.resolve({
        approved: item.status === "approved",
        decidedBy: item.decidedBy ?? null,
        via: item.via ?? "cancelled",
        reason: item.reason ?? "",
        scope: item.scope ?? "once",
      });
    }
    return new Promise<BridgeDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        void this.expire(id, "审批超时（无人审批），已自动拒绝。");
        resolve({ approved: false, decidedBy: null, via: "timeout", reason: "审批超时（无人审批），已自动拒绝。" });
      }, Math.max(0, item.expiresAt - this.nowFn()));
      if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.waiters.set(id, { resolve, timer });
    });
  }

  private resolveWaiter(id: string, decision: BridgeDecision): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(decision);
  }

  private async expire(id: string, reason: string): Promise<void> {
    const item = this.items.get(id);
    if (!item || item.status !== "pending") return;
    item.status = "expired";
    item.reason = reason;
    item.via = "timeout";
    item.decidedAt = this.nowFn();
    this.save();
    const channel = this.record("bot_approval_decided", {
      approval_id: item.id, decision: "expired", decided_by: "", via: "timeout", reason,
    });
    this.audit("approval:expired", { approval_id: item.id, session_key: item.sessionKey, tool: item.tool, event_channel: channel });
    await this.editPrompt(item);
  }

  /** 过期扫荡（轮询循环定期调）：把到期的挂起项标 expired 并改提示文案。 */
  sweepExpired(now = this.nowFn()): void {
    for (const item of [...this.items.values()]) {
      if (item.status === "pending" && item.expiresAt <= now && !this.waiters.has(item.id)) {
        void this.expire(item.id, "审批超时（无人审批），已自动拒绝。");
      }
    }
  }

  /**
   * 解决一条挂起审批（/approve、/reject、按钮回调共用这个入口）。
   * 非白名单的人一律返回 not-approver（不改状态、不解决等待者，并记审计）；
   * 已处理过的返回 not-pending。批准时 scope 带 session/always 会顺手
   * 记一条授权（精确匹配工具 + 参数指纹；拒绝不记授权）。
   */
  async decide(id: string, approved: boolean, decidedBy: string, via: "command" | "button", scope: ApprovalScope = "once"): Promise<DecideResult> {
    const item = this.items.get(id);
    if (!item) return { ok: false, reason: "not-found" };
    if (item.status !== "pending") return { ok: false, reason: "not-pending" };
    if (!this.canApprove(decidedBy)) {
      this.audit("approval:denied-not-approver", { approval_id: id, session_key: item.sessionKey, tool: item.tool, decided_by: decidedBy });
      return { ok: false, reason: "not-approver" };
    }
    const scopeNorm: ApprovalScope = scope === "session" || scope === "always" ? scope : "once";
    item.status = approved ? "approved" : "rejected";
    item.decidedBy = decidedBy;
    item.decidedAt = this.nowFn();
    item.via = via;
    item.scope = scopeNorm;
    item.reason = approved ? "" : "审批人拒绝执行。";
    let grant: ApprovalGrant | null = null;
    if (approved && scopeNorm !== "once") {
      grant = {
        id: this.newGrantId(),
        tool: item.tool,
        argsHash: item.argsHash,
        scope: scopeNorm,
        sessionKey: scopeNorm === "session" ? item.sessionKey : null,
        grantedBy: decidedBy,
        grantedAt: this.nowFn(),
      };
      if (scopeNorm === "session") this.sessionGrants.set(grant.id, grant);
      else {
        this.alwaysGrants.set(grant.id, grant);
        this.saveGrants();
      }
    }
    this.save();
    const decision: BridgeDecision = {
      approved,
      decidedBy,
      via,
      reason: item.reason ?? "",
      scope: scopeNorm,
    };
    const channel = this.record("bot_approval_decided", {
      approval_id: item.id, decision: approved ? "approved" : "rejected", decided_by: decidedBy, via,
      scope: scopeNorm, grant_id: grant?.id ?? "", reason: item.reason ?? "",
    });
    this.audit(approved ? "approval:approved" : "approval:rejected", {
      approval_id: item.id, session_key: item.sessionKey, tool: item.tool, decided_by: decidedBy,
      scope: scopeNorm, grant_id: grant?.id ?? "", event_channel: channel,
    });
    this.resolveWaiter(id, decision);
    await this.editPrompt(item);
    return { ok: true, decision };
  }

  /** 取消某会话的全部挂起项（/stop、队列超时时调；已解决的等待者收到“已取消”）。 */
  cancelSession(sessionKey: string, reason: string): void {
    for (const item of [...this.items.values()]) {
      if (item.sessionKey !== sessionKey || item.status !== "pending") continue;
      item.status = "cancelled";
      item.reason = reason;
      item.via = "cancelled";
      item.decidedAt = this.nowFn();
      this.save();
      const channel = this.record("bot_approval_decided", {
        approval_id: item.id, decision: "cancelled", decided_by: "", via: "cancelled", reason,
      });
      this.audit("approval:cancelled", { approval_id: item.id, session_key: item.sessionKey, tool: item.tool, event_channel: channel });
      this.resolveWaiter(item.id, { approved: false, decidedBy: null, via: "cancelled", reason });
      void this.editPrompt(item);
    }
  }
}
