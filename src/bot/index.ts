// src/bot/index.ts — Bot 方向 Phase 3：notifier 主动推送 + 附件处理。
//
// 主链路（Phase 3）：
//   验签与解析（适配器）→ 幂等去重 → 角色路由（router：owner/admin/member/
//   guest）→ 确定性指令优先（/approve、/reject 接真逻辑）→ 群聊 @ 过滤 →
//   配额（用户/天、群聊/分钟、当天预算）→ 月度硬顶预检 → 附件处理
//   （文本文档提取进上下文，图片只记元信息）→ 会话排队 → 占位
//   “处理中…” → Agent 执行（画像定 mode：guest/member 只读，owner/
//   admin 的写操作逐次走 approvalBridge 聊天内审批）→ 分片回发。
//   另有一条不进主链路的推送线：notifier（Heartbeat 静默巡查 + Watch
//   文件变化 + 定时/队列任务结果），默认全关，见 notifier.ts。
//
// 取消与超时的诚实边界：与 Phase 1 相同（/stop 与超时不能真中断在跑的
// 模型调用，只能不等结果、不回发、丢弃 Agent 实例、按取消前快照恢复会话
// 文件）；本批多了一条：取消时同会话的挂起审批一并取消（bridge.
// cancelSession），免得晚一步点的“批准”复活已经没了的任务。审批本身
// 也有 TTL（默认 60 秒，可配），超时自动拒绝。
//
// 权限：角色只认 config 的 bot.owner / bot.admins / bot.members（见
// router.ts）；白名单两道门（Agent 的 disabledTools 不让工具进模型，
// approveFn 里再查一次 isToolAllowed）；审批默认关闭——owner/admin
// 都没配时谁也批不了，写操作一律拒绝。模型兜底链不进 Bot（单 provider，
// 绝不自动换模型）；月度硬顶与单次硬顶走 Agent 自带的 checkCost，另加
// 一道执行前预检（本月已花 ≥ 上限时直接回绝、不进模型）。
//
// 证据：每条处理过的消息写一行 `~/.nyra/bot-audit.jsonl`（只记 channel、
// sessionKey、messageId、结论、字数、花费、错误原因，不记用户原文与
// token；与 mcp-server-audit.jsonl 同款做法）；审批结论另记运行事件
// bot_approval_requested / bot_approval_decided（有运行目录时写它的
// events.jsonl，没有时写 evidence/bot/ 下的证据文件，见 approvalBridge.ts
// 的 recordBotEvent）。
//
// 缺口 42 第二批（BotRunner 接线）：Bot 启动时按 config 的 bot.agent
// （默认 "nyra"）绑一台电脑（binding.ts：已有就用、有 Soul 没电脑就自动建、
// 没 Soul 就不接并提示）；Agent 的工作目录就是电脑的 workspace，消息到了
// 先唤醒电脑、跑完记一笔 task.run 活动，闲置到点的电脑 5 分钟扫一次休眠。
// 聊天里的 /computer-shell <id|own> <命令> 让机主/管理员在指定电脑上跑 shell：
// 跨电脑写操作走 checkComputerAccess（deny 拒绝、ask 走 approvalBridge 审批、
// allow 直接跑），--cred 把 Vault 凭证代填进沙箱环境变量，回显前脱敏。
//
// 缺口 27（常驻多渠道网关，见 src/channels/）：BotRunner 按绑定建——
// 绑定 id、沙箱档位、语音云端开关、mentionOnly 覆盖都经 BotRunnerOptions 传
// 进来；startServices/stopServices 从 startPolling/stopPolling 里抽出来，
// 供网关复用（网关只调 handleMessage，不调 startPolling）；语音附件经
// transcribeVoiceAttachment 转文字当任务（本地优先，云端须绑定显式开）。
// 路由决定本身由网关写 bot-audit.jsonl（outcome routed/dropped，带
// binding_id/rule/reason），本文件的 audit 闭包只给每条记录补 binding_id。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type ApproveFn } from "../agent.ts";
import { loadConfig, resolveHome, resolveProvider, resolveSandbox } from "../config.ts";
import { resolveEnforced } from "../enforcedConfig.ts";
import { getFileKey, maskKey } from "../keystore.ts";
import { getCredential } from "../vault.ts";
import { resolvePricing, resolveMonthlyLimit } from "../cost.ts";
import { McpCostTracker } from "../mcpCost.ts";
import { loadSession, resolveNyraHome, saveSession, sessionPath } from "../memory.ts";
import { buildProviderChain } from "../providers.ts";
import { resolveReviewerModel } from "../reviewer.ts";
import { monthKeyString, UsageLedger } from "../usageLedger.ts";
import { makeTieredCapCheck, type TieredCtxHolder } from "../costCaps.ts";
import type { UsageSnapshot } from "../usage.ts";
// 缺口 27：语音入口（语音指挥）与绑定级沙箱档位。voice.ts 与 channels/bindings.ts
// 都不 import bot/index.ts，没有循环导入。
import { estimateSttCostUsd, httpEndpointOf, resolveVoiceConfig, sniffAudioKind, transcribeAudio } from "../voice.ts";
import { createHash } from "node:crypto";
import { configWithSandboxTier, type BindingSandboxTier } from "../channels/bindings.ts";
import { checkCircleInbound } from "../circles.ts";
import { ApprovalBridge, approvalArgsHash } from "./approvalBridge.ts";
import { resolveBotComputer, type BotComputerBinding } from "./binding.ts";
import { processAttachments } from "./attachments.ts";
import { DedupStore, QuotaStore } from "./dedupAndQuota.ts";
import { splitMessage } from "./formatter.ts";
import { BotNotifier } from "./notifier.ts";
import {
  checkComputerAccess,
  computerResourceSummary,
  computerWorkspacePath,
  getComputer,
  handleComputer,
  listComputers,
  recordComputerActivity,
  runComputerShell,
  sleepDueComputers,
  touchComputerActivity,
  validateComputerId,
  wakeComputer,
  type BotComputer,
} from "./computer.ts";
import { botToolRedlineVerdict, handleBusinessRedlines } from "../businessRedlines.ts";

/** 给 schedule daemon / task worker 共用（buildNotifierFromConfig 的返回类型）。 */
export { BotNotifier } from "./notifier.ts";
import { agentOptionsForProfile, isToolAllowed, profileForRole, resolveRole, type BotProfile, type BotRole } from "./router.ts";
import { SessionQueue } from "./sessionQueue.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import { DiscordAdapter } from "./channels/discord.ts";
import { SlackAdapter } from "./channels/slack.ts";
import { WhatsAppAdapter } from "./channels/whatsapp.ts";
import {
  botPolicyFromConfig,
  memorySessionIdFor,
  sessionKeyFor,
  type BotPolicy,
  type ChannelAdapter,
  type InboundMessage,
} from "./types.ts";
import { getTeam, requireCharter } from "../team.ts";

export const BOT_AUDIT_FILE = "bot-audit.jsonl";
export const BOT_TELEGRAM_PID_FILE = "bot-telegram.pid";
export const BOT_DISCORD_PID_FILE = "bot-discord.pid";
export const BOT_SLACK_PID_FILE = "bot-slack.pid";
export const BOT_WHATSAPP_PID_FILE = "bot-whatsapp.pid";
export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
export const DISCORD_TOKEN_ENV = "DISCORD_BOT_TOKEN";
export const SLACK_APP_TOKEN_ENV = "SLACK_APP_TOKEN";
export const SLACK_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";
export const WHATSAPP_TOKEN_ENV = "WHATSAPP_ACCESS_TOKEN";
export const WHATSAPP_PHONE_ID_ENV = "WHATSAPP_PHONE_NUMBER_ID";
/**
 * 密码箱/keys.json 里的条目名就是环境变量名（与 keystore 的口径一致：
 * `telegram-bot-token` 这种小写连字符名过不了 validEnvName，进不了
 * keys.json；webhook-secret 这类例外只走密码箱，不走 keys.json）。
 */
export const TELEGRAM_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";
export const DISCORD_TOKEN_KEY = "DISCORD_BOT_TOKEN";
export const SLACK_APP_TOKEN_KEY = "SLACK_APP_TOKEN";
export const SLACK_BOT_TOKEN_KEY = "SLACK_BOT_TOKEN";
export const WHATSAPP_TOKEN_KEY = "WHATSAPP_ACCESS_TOKEN";
export const WHATSAPP_PHONE_ID_KEY = "WHATSAPP_PHONE_NUMBER_ID";

export interface AgentRunResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  spentUsd: number | null;
}

export type AgentRunFn = (sessionKey: string, text: string, signal: AbortSignal) => Promise<AgentRunResult>;

export interface BotRunnerOptions {
  home: string;
  workdir: string;
  config: Record<string, unknown>;
  adapter: ChannelAdapter;
  /** 注入的模型执行（测试用假 runner；不传用真 Agent）。 */
  agentRun?: AgentRunFn;
  /** 本 Bot 的 Soul 身份（测试里模拟不同 agent 用；不传读 config 的 bot.agent）。 */
  agent?: string;
  // 缺口 27：渠道网关（src/channels/gateway.ts）按绑定建 runner 时传。
  /** 这台 runner 归属的绑定 id（进 bot-audit.jsonl 的 binding_id，供路由回放关联）。 */
  bindingId?: string;
  /** 绑定级沙箱档位（strict/standard/open；不传用全局 config 的沙箱设置）。 */
  sandboxOverride?: BindingSandboxTier;
  /** 语音消息是否允许走云端转写（默认只走本地 whisper.cpp；云端须绑定显式开）。 */
  voiceCloud?: boolean;
  /** 注入的语音转写（测试用假转写；不传走默认实现：下载 → 本地优先/云端）。 */
  voiceTranscribe?: VoiceTranscriber;
  /** 策略覆盖（目前只用 mentionOnly：绑定的 mentionOnly 优先于全局 config）。 */
  policyOverride?: { mentionOnly?: boolean };
}

/** 语音转写器：给一段语音字节与 mime 类型，返回转写文本与引擎名；转不了返回 null。 */
export type VoiceTranscriber = (bytes: Buffer, mimeType: string, fileName?: string) => Promise<{ text: string; engine: string } | null>;

export interface BotStatus {
  running: boolean;
  model: string | null;
  queueDepth: number;
  activeSessions: string[];
  todaySpentUsd: number;
  dedupSize: number;
  monthlySpentUsd: number | null;
  monthlyLimitUsd: number | null;
  /** 当前挂起的审批数（/status 里能看到有没有等着批的）。 */
  pendingApprovals: number;
}

interface AuditRecord {
  ts: string;
  channel: string;
  session_key: string;
  message_id: string;
  outcome: string;
  chars?: number;
  spent_usd?: number | null;
  error?: string;
  /** 审批审计：审批 id、工具名、决定人、事件落点（events / evidence / none）。 */
  approval_id?: string;
  tool?: string;
  decided_by?: string;
  event_channel?: string;
  /** 缺口 27：路由审计——命中哪条绑定、哪条规则、为什么（dropped 时是丢弃原因）。 */
  binding_id?: string;
  rule?: string;
  reason?: string;
}

/** 渠道审计写一行（网关写路由决定用；BotRunner 内部走私有的 appendAudit）。 */
export function appendBotAudit(home: string, rec: AuditRecord): void {
  appendAudit(home, rec);
}

function appendAudit(home: string, rec: AuditRecord): void {
  try {
    const dir = resolveNyraHome(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, BOT_AUDIT_FILE);
    appendFileSync(path, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") { try { chmodSync(path, 0o600); } catch { /* ignore */ } }
  } catch { /* 审计写失败不破坏消息处理 */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 解析行首的确定性指令：`/help`、`/help@BotName` 都认；正文里的 `/x` 不算。 */
export function parseBotCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const first = trimmed.split(/\s+/)[0] ?? "";
  const body = first.slice(1);
  if (!body) return null;
  const at = body.indexOf("@");
  const command = (at >= 0 ? body.slice(0, at) : body).toLowerCase();
  // 缺口 42 第二批：命令名允许连字符（/computer-shell）。连字符只出现在命令
  // 名里，参数部分不受影响；未知指令仍由 handleCommand 的 default 回“未知指令”。
  if (!/^[a-z][a-z0-9_-]*$/.test(command)) return null;
  return { command, args: trimmed.slice(first.length).trim() };
}

export class BotRunner {
  readonly home: string;
  readonly workdir: string;
  readonly config: Record<string, unknown>;
  readonly policy: BotPolicy;
  readonly adapter: ChannelAdapter;
  /** 本 Bot 的 Soul 身份（config 的 bot.agent，默认 "nyra"；电脑挂在这个身份下）。 */
  readonly agent: string;
  /** GROK-1：本 Bot 跑在哪个团队里（config 的 bot.team；null = 不在团队里）。 */
  readonly teamId: string | null;
  /** GROK-1：本 Bot 在团队里的角色（chief = 参谋长；member = 成员；null = 不在团队里）。 */
  readonly teamRole: "chief" | "member" | null;
  /** 绑上的电脑（缺口 42 第二批；没接上时为 null，任务仍在启动目录跑）。 */
  readonly boundComputer: BotComputer | null;
  /** Agent 实际的工作目录：接上电脑时是电脑的 workspace，否则是启动目录。 */
  readonly agentWorkdir: string;
  readonly queue = new SessionQueue();
  readonly dedup: DedupStore;
  readonly quota: QuotaStore;
  readonly bridge: ApprovalBridge;
  /** 场景 B 主动推送（Phase 3）：Heartbeat + Watch + 任务结果推送。 */
  readonly notifier: BotNotifier;
  readonly modelName: string | null;
  private readonly agentRunFn: AgentRunFn;
  /** 缺口 27：渠道网关按绑定建 runner 时传（见 BotRunnerOptions）。 */
  readonly bindingId: string | null;
  readonly sandboxOverride: BindingSandboxTier | null;
  readonly voiceCloud: boolean;
  private readonly voiceTranscribeFn: VoiceTranscriber | null;
  /** 云端转写用的 provider endpoint（懒建、建一次；建不出来记 null，不再重试）。 */
  private voiceEndpointCache: { done: boolean; endpoint: { baseUrl: string; apiKey: string } | null } = { done: false, endpoint: null };
  /** 每会话一个 Agent 实例；角色变了就重建（画像、mode、白名单都跟着角色走）。 */
  private agents = new Map<string, { agent: Agent; role: BotRole }>();
  /** 每会话上次 flush 的用量快照（delta 制记账，与 CLI 的 makeUsageFlusher 同口径）。 */
  private lastSnap = new Map<string, UsageSnapshot>();
  private lastSpent = new Map<string, number | null>();
  private flushedUsd = 0;
  private ledger: UsageLedger;
  /** 取消过的会话（后台调用结束后的恢复守门：epoch 变了说明已有新任务，不恢复）。 */
  private abortEpochs = new Map<string, number>();
  /** 本次排队任务的请求上下文（chatId/threadId/发信人/画像；approveFn 靠它找审批提示该发去哪）。 */
  private sessionCtx = new Map<string, { chatId: string; threadId: string | null; senderId: string; profile: BotProfile }>();
  /** 审批过期扫荡的定时器（startPolling 起、stopPolling 停）。 */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 电脑闲置休眠扫荡的定时器（缺口 42 第二批；startPolling 起、stopPolling 停）。 */
  private computerSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 主动推送的巡查定时器（startPolling 起、stopPolling 停；notifier 没开时不建）。 */
  private notifyTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopController: AbortController | null = null;

  constructor(opts: BotRunnerOptions) {
    this.home = opts.home;
    this.workdir = opts.workdir;
    this.config = opts.config;
    // 缺口 27：绑定级 mentionOnly 覆盖全局 config（绑定的口径优先于全局；
    // 不传覆盖时行为与以前一致）。
    this.policy = opts.policyOverride?.mentionOnly !== undefined
      ? { ...botPolicyFromConfig(opts.config), mentionOnly: opts.policyOverride.mentionOnly }
      : botPolicyFromConfig(opts.config);
    this.bindingId = opts.bindingId ?? null;
    this.sandboxOverride = opts.sandboxOverride ?? null;
    this.voiceCloud = opts.voiceCloud ?? false;
    this.voiceTranscribeFn = opts.voiceTranscribe ?? null;
    this.adapter = opts.adapter;
    // 缺口 42 第二批：BotRunner 接电脑。构造时定死绑定（运行中换电脑要重启）；
    // 没接上（没 Soul 或建电脑失败）时任务仍在启动目录跑，并打一条提示——
    // 没电脑的 Bot 在第一批之前就是这么跑的，不因电脑接不上而拒绝启动。
    this.agent = opts.agent ?? this.policy.agent;
    let binding: BotComputerBinding | null = null;
    try {
      binding = resolveBotComputer(opts.home, this.agent);
    } catch (err) {
      process.stderr.write(`Bot 电脑绑定失败（${err instanceof Error ? err.message : String(err)}）：先用启动目录跑任务。\n`);
    }
    this.boundComputer = binding?.computer ?? null;
    this.agentWorkdir = binding?.workdir ?? opts.workdir;
    if (!binding) {
      process.stderr.write(`Bot 未接持久电脑（agent ${this.agent} 没有 Soul 或电脑建不出来）：任务在启动目录跑；跑 \`nyra soul init ${this.agent}\` 与 \`nyra bot computer create --agent ${this.agent}\` 接入持久电脑。\n`);
    }
    // GROK-1：团队模式——配了 bot.team 时 Bot 只能是该团队的参谋长或成员，
    // 且须有完整 Charter 才能接单；三者任一不满足直接拒绝启动（fail-closed，
    // 不静默跑成单机 Bot）。没配团队时 teamId/teamRole 都是 null，行为不变。
    if (this.policy.team) {
      const team = getTeam(opts.home, this.policy.team);
      if (!team) throw new Error(`Bot 团队模式启动失败：找不到团队 ${this.policy.team}（先跑 nyra team create 建团队，或把 config.json 的 bot.team 清掉）`);
      if (team.status !== "active") throw new Error(`Bot 团队模式启动失败：团队 ${team.name} 已解散`);
      if (this.agent !== team.chief && !team.members.includes(this.agent)) {
        throw new Error(`Bot 团队模式启动失败：agent ${this.agent} 不是团队 ${team.name} 的参谋长也不是成员（参谋长 ${team.chief}，成员 ${team.members.join("、")}）`);
      }
      try {
        requireCharter(opts.home, this.agent, "Bot 团队模式");
      } catch (err: unknown) {
        throw new Error(`Bot 团队模式启动失败：${err instanceof Error ? err.message : String(err)}`);
      }
      this.teamId = team.id;
      this.teamRole = this.agent === team.chief ? "chief" : "member";
    } else {
      this.teamId = null;
      this.teamRole = null;
    }
    this.dedup = new DedupStore(opts.home);
    this.quota = new QuotaStore(opts.home);
    this.bridge = new ApprovalBridge({
      home: opts.home,
      policy: this.policy,
      send: (chatId, threadId, text, buttons) =>
        this.adapter.sendText({ chatId, threadId, text, inlineKeyboard: buttons }),
      edit: (chatId, messageId, text) => this.adapter.editText(chatId, messageId, text),
      audit: (outcome, extra) => {
        appendAudit(this.home, {
          ts: new Date().toISOString(),
          channel: this.adapter.channel,
          session_key: typeof extra.session_key === "string" ? extra.session_key : "",
          message_id: typeof extra.approval_id === "string" ? extra.approval_id : "",
          outcome,
          approval_id: typeof extra.approval_id === "string" ? extra.approval_id : undefined,
          tool: typeof extra.tool === "string" ? extra.tool : undefined,
          decided_by: typeof extra.decided_by === "string" ? extra.decided_by : undefined,
          event_channel: typeof extra.event_channel === "string" ? extra.event_channel : undefined,
          ...(this.bindingId ? { binding_id: this.bindingId } : {}),
        });
      },
    });
    this.ledger = new UsageLedger(opts.home);
    // Phase 3：主动推送（Heartbeat + Watch + 任务结果）。notifier 自己
    // 认 enabled / owner / target_chat_id 三个开的条件，缺一个就不推。
    this.notifier = new BotNotifier({
      home: opts.home,
      policy: this.policy.notifier,
      owner: this.policy.owner,
      send: (chatId, threadId, text) => this.adapter.sendText({ chatId, threadId, text }),
      audit: (outcome, extra) => {
        appendAudit(this.home, {
          ts: new Date().toISOString(),
          channel: this.adapter.channel,
          session_key: typeof extra.session_key === "string" ? extra.session_key : "",
          message_id: "",
          outcome,
          ...(this.bindingId ? { binding_id: this.bindingId } : {}),
        });
      },
      state: () => {
        const monthly = this.monthSpentBeforeUsd();
        return {
          monthlySpentUsd: monthly !== null ? monthly.spentUsd : null,
          monthlyLimitUsd: resolveMonthlyLimit(this.config),
          dailySpentUsd: this.quota.dailySpentUsd(),
          dailyBudgetUsd: this.policy.dailyTokenBudgetUsd,
          pendingApprovals: this.bridge.pendingCount(),
          oldestPendingApprovalMs: this.bridge.oldestPendingAgeMs(),
          queueDepth: this.queue.totalDepth(),
        };
      },
    });
    let model: string | null = null;
    try {
      const cfg = resolveProvider({ home: opts.home, config: opts.config });
      model = `${cfg.name}:${cfg.model}`;
    } catch { /* 模型名拿不到时 /model 如实说未配置 */ }
    this.modelName = model;
    this.agentRunFn = opts.agentRun ?? ((k, t, s) => this.runRealAgent(k, t, s));
  }

  // -- Agent 执行（复用 agent.ts / tools.ts 的执行路径，不另起执行器） ----

  /** 本月已花（用量账本 LLM + MCP − 本进程已 flush 的，避免重复算；算不出返回 null，不挡人）。 */
  private monthSpentBeforeUsd(): { spentUsd: number; incomplete: boolean } | null {
    try {
      const llm = this.ledger.monthTotal(monthKeyString());
      const mcp = new McpCostTracker(this.home).monthTotalUsd(monthKeyString());
      return { spentUsd: llm.spentUsd + mcp - this.flushedUsd, incomplete: llm.incomplete };
    } catch {
      return null;
    }
  }

  /**
   * Agent 的审批回调（checkApproval 经 approveFn 调到这里）：
   * 白名单外的工具直接拒绝、不建审批（第二道门）；白名单内的写操作建挂
   * 起审批、等聊天里的决定。放行只决定这一次调用能不能跑——花费照常
   * 进账本、月度/单次硬顶照常由 checkCost 在轮次里执行，审批绕不过配额。
   */
  private approveViaBridge(sessionKey: string, profile: BotProfile): ApproveFn {
    return async (tool, summary, details) => {
      // 缺口 51：业务动作硬红线——never 档直接拒绝、不建挂起审批（不浪费一次
      // 人工审批；即使已批准也不放行）。approve 档走下面的正常审批链。
      const redline = botToolRedlineVerdict(this.home, tool);
      if (redline?.blocked) {
        return { approved: false, feedback: `业务动作红线拦截：${redline.reason}` };
      }
      if (!isToolAllowed(profile, tool)) {
        return { approved: false, feedback: `工具 ${tool} 不在你的角色（${profile.role}）白名单里，不能执行。` };
      }
      if (!profile.canRequestApproval) {
        return { approved: false, feedback: "你的角色不能发起审批。" };
      }
      const ctx = this.sessionCtx.get(sessionKey);
      if (!ctx) {
        return { approved: false, feedback: "会话上下文丢失，无法发起审批。" };
      }
      const argsHash = approvalArgsHash({
        tool,
        command: (details as Record<string, unknown> | undefined)?.command,
        fileTarget: (details as Record<string, unknown> | undefined)?.fileTarget,
        cwd: (details as Record<string, unknown> | undefined)?.cwd,
      });
      const approval = await this.bridge.requestApproval({
        sessionKey,
        chatId: ctx.chatId,
        threadId: ctx.threadId,
        tool,
        summary,
        argsHash,
        requestedBy: ctx.senderId,
        requestedByRole: profile.role,
      });
      const decision = await this.bridge.waitForDecision(approval.id);
      if (decision.approved) return true;
      return { approved: false, feedback: decision.reason || "审批未通过。" };
    };
  }

  private buildAgent(sessionKey: string, profile: BotProfile): Agent {
    const sessionId = memorySessionIdFor(sessionKey);
    const primaryCfg = resolveProvider({ home: this.home, config: this.config });
    const provider = buildProviderChain(primaryCfg, [primaryCfg.name], null, {
      resolver: (name: string) => resolveProvider({ home: this.home, config: this.config, providerName: name }),
    });
    const hasCredentials = (provider as unknown as { hasCredentials?: () => boolean }).hasCredentials;
    if (typeof hasCredentials === "function" && !hasCredentials.call(provider)) {
      throw new Error("未找到可用的模型 API 凭据：请先配好 provider 的 Key");
    }
    // 缺口 27：绑定级沙箱档位覆盖全局 config（NYRA_SANDBOX* 环境变量仍
    // 最高，见 resolveSandbox；没绑定档位时行为与以前一致）。
    const agentConfig = this.sandboxOverride ? configWithSandboxTier(this.config, this.sandboxOverride) : this.config;
    const sandbox = resolveSandbox(agentConfig);
    const monthlyLimit = resolveMonthlyLimit(this.config);
    const monthlySpentBeforeUsd = monthlyLimit === null ? null : () => this.monthSpentBeforeUsd();
    // 缺口 43 第三批：分层成本上限——Bot 的 agent id 就是 this.agent（BotRunner
    // 构造时定死），回调收本次运行进行中的花费、超了先建暂停记录再抛错中止。
    // 暂停记录没运行 id 时不带 taskId（Bot 任务不在任务板上时没有 taskId）。
    const tieredCtx: TieredCtxHolder = {};
    const tieredCapCheck = makeTieredCapCheck(this.home, this.agent, tieredCtx);
    // 画像定 Agent：mode / interactive / 白名单 / 系统提示词 / 步数都跟着角色走
    //（guest/member 只读；owner/admin 的写操作逐次走 approvalBridge）。
    // 工作目录是 Bot 那台电脑的 workspace（缺口 42 第二批；没接电脑时是启动目录）。
    const ao = agentOptionsForProfile(profile);
    return new Agent(provider, {
      workdir: this.agentWorkdir,
      mode: ao.mode,
      maxTurns: ao.maxTurns,
      sessionId,
      interactive: ao.interactive,
      approveFn: ao.interactive ? this.approveViaBridge(sessionKey, profile) : null,
      disabledTools: ao.disabledTools,
      systemInstructions: ao.systemInstructions,
      messages: loadSession(sessionId, this.home),
      channel: this.adapter.channel,
      home: this.home,
      maxCostUsd: (() => {
        const enf = resolveEnforced(this.config).values;
        if (typeof enf.max_cost_usd === "number") return enf.max_cost_usd;
        return typeof this.config.max_cost_usd === "number" ? (this.config.max_cost_usd as number) : null;
      })(),
      pricing: resolvePricing(this.config.pricing, primaryCfg.model),
      monthlyCostLimitUsd: monthlyLimit,
      monthlySpentBeforeUsd,
      // 缺口 43 第三批：分层成本上限（与月度硬顶同级硬停）。
      tieredCapCheck,
      // GROK-1：团队模式（config bot.team 配了时）——Bot 跑参谋长/成员的 Soul，
      // 团队审批门（GROK-3）按 teamId 判定；没配团队时不传，行为与以前一致。
      ...(this.teamId ? { soulAgent: this.agent, teamId: this.teamId, teamRole: this.teamRole } : {}),
      reviewerModel: resolveReviewerModel(this.config).model,
      sandbox: { backend: sandbox.backend, mode: sandbox.mode as "read-only" | "workspace-write" | "danger-full-access", allowNet: sandbox.allowNet },
    });
  }

  private getAgent(sessionKey: string, profile: BotProfile): Agent {
    const cached = this.agents.get(sessionKey);
    if (cached && cached.role === profile.role) return cached.agent;
    const agent = this.buildAgent(sessionKey, profile);
    this.agents.set(sessionKey, { agent, role: profile.role });
    return agent;
  }

  private flushUsage(sessionKey: string, agent: Agent): void {
    try {
      const snap = agent.usage.snapshot();
      const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
      const rec = this.ledger.recordDelta(snap, this.lastSnap.get(sessionKey) ?? null, spent, this.lastSpent.get(sessionKey) ?? null, agent.provider.model, undefined, this.agent);
      if (rec && rec.spent_usd !== null) this.flushedUsd += rec.spent_usd;
      this.lastSnap.set(sessionKey, snap);
      this.lastSpent.set(sessionKey, spent);
    } catch { /* 账本写失败不破坏回复 */ }
  }

  /**
   * 缺口 27：云端转写用的 provider endpoint（懒建、建一次；建不出来记 null，
   * 不再重试——没凭据时本地转写仍可走，不因云端建不出来而挡住本地路）。
   */
  private voiceEndpoint(): { baseUrl: string; apiKey: string } | null {
    if (this.voiceEndpointCache.done) return this.voiceEndpointCache.endpoint;
    this.voiceEndpointCache.done = true;
    try {
      const primaryCfg = resolveProvider({ home: this.home, config: this.config });
      const provider = buildProviderChain(primaryCfg, [primaryCfg.name], null, {
        resolver: (name: string) => resolveProvider({ home: this.home, config: this.config, providerName: name }),
      });
      this.voiceEndpointCache.endpoint = httpEndpointOf(provider);
    } catch {
      this.voiceEndpointCache.endpoint = null;
    }
    return this.voiceEndpointCache.endpoint;
  }

  /**
   * 缺口 27：转写一条语音附件。注入的转写器优先（测试用）；默认实现下载
   * 音频后走 transcribeAudio（本地 whisper.cpp 优先，云端只在绑定显式开
   * voiceCloud 时走）。返回 ok:false 时调用方直接回说明、不进模型。
   */
  private async transcribeVoiceAttachment(
    att: InboundMessage["attachments"][number],
  ): Promise<{ ok: true; text: string; engine: string; costUsd: number | null } | { ok: false; error: string }> {
    try {
      // downloadFile 是可选方法：这个渠道的适配器没实现就直说不支持。
      if (typeof this.adapter.downloadFile !== "function") {
        return { ok: false, error: "这个渠道不支持下载语音文件" };
      }
      const downloaded = await this.adapter.downloadFile(att.fileId);
      const mimeType = att.mimeType ?? downloaded.mimeType ?? "audio/ogg";
      if (this.voiceTranscribeFn) {
        const res = await this.voiceTranscribeFn(downloaded.bytes, mimeType, att.name ?? downloaded.fileName);
        if (!res) return { ok: false, error: "语音转写不可用（转写器返回空）" };
        return { ok: true, text: res.text, engine: res.engine, costUsd: null };
      }
      const voiceConfig = resolveVoiceConfig(this.config);
      const sniffed = sniffAudioKind(downloaded.bytes);
      const kind = sniffed ?? (mimeType === "audio/mpeg" || mimeType === "audio/mp3" ? "mp3" : mimeType === "audio/wav" || mimeType === "audio/x-wav" ? "wav" : "ogg");
      const endpoint = this.voiceCloud ? this.voiceEndpoint() : null;
      const transcription = await transcribeAudio({
        input: {
          bytes: downloaded.bytes,
          kind,
          sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
          source: att.name ?? downloaded.fileName ?? "语音消息",
          durationSeconds: typeof att.durationSeconds === "number" ? att.durationSeconds : null,
        },
        config: voiceConfig,
        endpoint,
      });
      const costUsd = transcription.engine.startsWith("cloud:")
        ? estimateSttCostUsd(transcription.seconds, voiceConfig)
        : null;
      return { ok: true, text: transcription.text, engine: transcription.engine, costUsd };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 真 Agent 执行：取消信号与 agent.run race；取消后丢弃结果、丢弃 Agent
   * 实例、恢复取消前的会话快照（恢复守门见 runAgent 的 epoch 逻辑）。
   */
  private async runRealAgent(sessionKey: string, text: string, signal: AbortSignal): Promise<AgentRunResult> {
    const sessionId = memorySessionIdFor(sessionKey);
    const snapshotBefore = loadSession(sessionId, this.home);
    const epoch = (this.abortEpochs.get(sessionKey) ?? 0) + 1;
    this.abortEpochs.set(sessionKey, epoch);
    const profile = this.sessionCtx.get(sessionKey)?.profile ?? profileForRole("guest", this.policy);
    const agent = this.getAgent(sessionKey, profile);
    const beforeSnap = agent.usage.snapshot();
    const beforeSpent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    const runPromise = agent.run(text);
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("已取消"));
      else signal.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
    });
    let resultText: string;
    try {
      resultText = await Promise.race([runPromise, aborted]);
    } catch (err) {
      // 取消后：丢弃 Agent 实例；同会话的挂起审批一并取消（免得晚一步点的
      // “批准”复活已经没了的任务）；后台调用结束后再恢复一次快照（epoch
      // 没变才恢复）。
      this.agents.delete(sessionKey);
      this.bridge.cancelSession(sessionKey, this.queue.abortReason(sessionKey) === "timeout" ? "处理超时，审批已取消。" : "任务已停止，审批已取消。");
      try { saveSession(sessionId, snapshotBefore ?? [], this.home); } catch { /* ignore */ }
      void runPromise.then(
        () => { if (this.abortEpochs.get(sessionKey) === epoch) { try { saveSession(sessionId, snapshotBefore ?? [], this.home); } catch { /* ignore */ } } },
        () => {},
      );
      throw err;
    }
    this.flushUsage(sessionKey, agent);
    const snap = agent.usage.snapshot();
    const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    return {
      text: resultText,
      promptTokens: Math.max(0, (snap.prompt_tokens ?? 0) - (beforeSnap.prompt_tokens ?? 0)),
      completionTokens: Math.max(0, (snap.completion_tokens ?? 0) - (beforeSnap.completion_tokens ?? 0)),
      spentUsd: spent !== null && beforeSpent !== null ? Math.max(0, spent - beforeSpent) : spent,
    };
  }

  private restoreSession(sessionKey: string): void {
    const sessionId = memorySessionIdFor(sessionKey);
    try {
      const path = sessionPath(sessionId, this.home);
      if (existsSync(path)) rmSync(path);
    } catch { /* ignore */ }
    this.agents.delete(sessionKey);
    this.lastSnap.delete(sessionKey);
    this.lastSpent.delete(sessionKey);
  }

  /**
   * Bot 在电脑里跑完一次消息任务，记一笔 task.run 活动（只记会话 key、花费
   * 与成败，不记用户原文；没接电脑时不记）。目标是会话 key（telegram:7 这
   * 种），不是文件路径，不含隐私。
   */
  private recordTaskActivity(sessionKey: string, ok: boolean, spentUsd: number | null): void {
    if (!this.boundComputer) return;
    try {
      recordComputerActivity(this.home, {
        computerId: this.boundComputer.id,
        kind: "task",
        action: "task.run",
        target: sessionKey,
        ok,
        spentUsd,
        detail: ok ? "完成" : "失败",
      });
    } catch { /* 活动记失败不破坏回复 */ }
  }

  /** 消息到了就是一次活动：休眠的电脑先唤醒，并把闲置计时拨回现在（免得
   * 扫荡把正在干活的电脑睡了）。唤醒失败不挡任务——workspace 目录本身还在。 */
  private wakeBoundComputer(): void {
    if (!this.boundComputer) return;
    try {
      const current = getComputer(this.home, this.boundComputer.id);
      if (current.state === "sleeping") wakeComputer(this.home, current.id);
      touchComputerActivity(this.home, current.id);
    } catch { /* ignore */ }
  }

  /** 闲置到点的电脑全部休眠（nyra bot computer sleep-due 的同款逻辑；Bot
   * 自己的电脑闲置够久也会睡，下一条消息再唤醒）。startPolling 每 5 分钟
   * 调一次；测试直接调这个方法，不用等定时器。 */
  sweepSleepDue(): void {
    try {
      sleepDueComputers(this.home);
    } catch { /* 扫荡失败不破坏轮询 */ }
  }

  // -- 确定性指令（不走模型、不扣 token、不计配额） ----

  private helpText(profile: BotProfile): string {
    const roleDesc = { owner: "机主（全权）", admin: "管理员", member: "受信任用户", guest: "普通用户（只读）" }[profile.role];
    return [
      `Nyra Bot（Phase 3）：你的角色是${roleDesc}。`,
      "命令：",
      "/help — 本帮助",
      "/status — 运行状态、队列深度、今日花费、挂起审批",
      "/new — 开新会话（清除当前会话历史）",
      "/stop — 停止当前正在处理的任务",
      "/model — 当前用的模型",
      "/approve <id>、/reject <id> — 批准/拒绝一条挂起的审批（只有 owner/admin 能批；也可以点审批提示下的按钮）",
      "/computer-shell <电脑 id|own> <命令...> [--cred <账号> ...] — 在一台电脑上跑 shell（只机主/管理员；own 是 Bot 自己那台电脑；跨电脑写操作须审批；--cred 把 Vault 里的凭证代填进环境变量）",
      "群聊里只有 @ 我时才回复；私聊直接发消息就行。",
      "附件：图片只记元信息（本批暂不支持看图），纯文本文档（.txt/.md 等）会提取内容一起处理。",
    ].join("\n");
  }

  private statusText(): string {
    const st = this.status();
    const lines = [
      "Nyra Bot 运行状态：",
      `模型：${st.model ?? "未配置"}`,
      `队列深度：共 ${st.queueDepth}（进行中会话：${st.activeSessions.length ? st.activeSessions.join("、") : "无"}）`,
      `今日 token 花费：${st.todaySpentUsd > 0 ? `$${st.todaySpentUsd.toFixed(4)}` : "无"}`,
      `本月已花：${st.monthlySpentUsd !== null ? `$${st.monthlySpentUsd.toFixed(4)}` : "未知（未计价）"}${st.monthlyLimitUsd !== null ? ` / 上限 $${st.monthlyLimitUsd.toFixed(2)}` : "（未设上限）"}`,
      `挂起审批：${st.pendingApprovals} 条`,
      `去重记录：${st.dedupSize} 条`,
    ];
    return lines.join("\n");
  }

  private async handleCommand(msg: InboundMessage, command: string, args: string, profile: BotProfile): Promise<void> {
    const key = sessionKeyFor(msg);
    const reply = async (text: string): Promise<void> => {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text });
    };
    let outcome = `command:${command}`;
    switch (command) {
      case "help":
        await reply(this.helpText(profile));
        break;
      case "status":
        await reply(this.statusText());
        break;
      case "new": {
        this.restoreSession(key);
        await reply("已开启新会话，之前的内容已清除。");
        break;
      }
      case "stop": {
        const { cancelledActive, cancelledQueued } = this.queue.cancel(key);
        if (!cancelledActive && cancelledQueued === 0) {
          await reply("没有正在处理的任务。");
        } else {
          await reply("已停止当前任务。");
        }
        outcome = "command:stop";
        break;
      }
      case "model":
        await reply(`当前模型：${this.modelName ?? "未配置"}`);
        break;
      case "computer-shell": {
        outcome = await this.handleComputerShellCommand(msg, profile, args);
        break;
      }
      case "approve":
      case "reject": {        const id = args.split(/\s+/)[0] ?? "";
        if (!id) {
          await reply("用法：/approve <审批 id> 或 /reject <审批 id>（审批提示里有 id）。");
          outcome = "approval:missing-id";
          break;
        }
        const res = await this.bridge.decide(id, command === "approve", msg.senderId, msg.viaCallback ? "button" : "command");
        if (!res.ok) {
          if (res.reason === "not-approver") {
            await reply("只有管理员（owner/admin）能审批这条请求。");
            outcome = "approval:denied-not-approver";
          } else if (res.reason === "not-found") {
            await reply(`没找到审批 ${id}（可能已被清理）。`);
            outcome = "approval:not-found";
          } else {
            await reply(`审批 ${id} 已处理过，不能再批。`);
            outcome = "approval:not-pending";
          }
        } else {
          await reply(res.decision?.approved ? `已批准 ${id}。` : `已拒绝 ${id}。`);
          outcome = res.decision?.approved ? "approval:approved" : "approval:rejected";
        }
        if (msg.viaCallback && msg.callbackId) {
          try {
            await this.adapter.answerCallback?.(msg.callbackId, res.ok ? (res.decision?.approved ? "已批准" : "已拒绝") : "处理失败");
          } catch { /* 回 ack 失败不改变审批结论 */ }
        }
        break;
      }
      default:
        // 未知指令不进模型、不报错刷屏：只回一句帮助入口。
        await reply("未知指令。发 /help 看能用的命令。");
        outcome = "command:unknown";
        break;
    }
    appendAudit(this.home, { ts: new Date().toISOString(), channel: msg.channel, session_key: key, message_id: msg.messageId, outcome });
  }

  /**
   * /computer-shell <电脑 id|own> <命令...> [--cred <账号> ...]（缺口 42 第二批）：
   * 机主/管理员在聊天里让 Bot 在一台电脑上跑 shell。own = Bot 自己那台电脑。
   * 跨电脑写操作走 checkComputerAccess：deny 直接拒绝；ask 走 approvalBridge
   * 审批（批了才跑，批的人记进 shell.run 活动的 approvedBy）；allow 直接跑。
   * --cred 把 Vault 里该账号的凭证代填进沙箱环境变量 NYRA_CRED_<账号>；
   * 回显前把代填的明文脱敏成 ***，绝不把明文发回聊天（群聊里其他人也看不到）。
   * 返回值是这次指令的审计 outcome（handleCommand 记进 bot-audit.jsonl）。
   */
  private async handleComputerShellCommand(msg: InboundMessage, profile: BotProfile, args: string): Promise<string> {
    const reply = async (text: string): Promise<void> => {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text });
    };
    if (profile.role !== "owner" && profile.role !== "admin") {
      await reply("只有机主/管理员能用 /computer-shell。");
      return "command:computer-shell-denied-role";
    }
    const parts = args.split(/\s+/).filter(Boolean);
    const creds: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--cred" && i + 1 < parts.length) { creds.push(parts[++i]); continue; }
      rest.push(parts[i]);
    }
    const target = rest[0] ?? "";
    const command = rest.slice(1).join(" ").trim();
    if (!target || !command) {
      await reply("用法：/computer-shell <电脑 id|own> <命令...> [--cred <账号> ...]");
      return "command:computer-shell-usage";
    }
    let computerId: string;
    try {
      if (target === "own" || target === "me" || target === "mine") {
        if (!this.boundComputer) {
          await reply(`这台 Bot 还没接电脑（agent ${this.agent} 没有 Soul 或电脑建不出来）：先跑 nyra soul init ${this.agent} 与 nyra bot computer create --agent ${this.agent}。`);
          return "command:computer-shell-no-computer";
        }
        computerId = this.boundComputer.id;
      } else {
        validateComputerId(target);
        computerId = target;
      }
    } catch (err) {
      await reply(`电脑 id 不对：${err instanceof Error ? err.message : String(err)}`);
      return "command:computer-shell-bad-id";
    }
    const key = sessionKeyFor(msg);
    let access;
    try {
      access = checkComputerAccess(this.home, computerId, this.agent, "write");
    } catch (err) {
      await reply(`跑不了：${err instanceof Error ? err.message : String(err)}`);
      return "command:computer-shell-denied";
    }
    if (access.decision === "deny") {
      await reply(`跑不了：${access.reason}`);
      return "command:computer-shell-denied";
    }
    let approvedBy: string | null = null;
    if (access.decision === "ask") {
      const computer = getComputer(this.home, computerId);
      const approval = await this.bridge.requestApproval({
        sessionKey: key,
        chatId: msg.chatId,
        threadId: msg.threadId,
        tool: "computer-shell",
        summary: `在电脑 ${computerId}（${computer.agent} 的电脑）上跑 shell：${command}`,
        argsHash: approvalArgsHash({ tool: "computer-shell", command, cwd: computerWorkspacePath(this.home, computer) }),
        requestedBy: msg.senderId,
        requestedByRole: profile.role,
      });
      const decision = await this.bridge.waitForDecision(approval.id);
      if (!decision.approved) {
        await reply(`审批未通过：${decision.reason || "已拒绝"}`);
        return "command:computer-shell-rejected";
      }
      approvedBy = decision.decidedBy;
    }
    let result;
    try {
      result = await runComputerShell(this.home, computerId, command, {
        agent: this.agent, credentials: creds, approvedBy,
      });
    } catch (err) {
      await reply(`执行失败：${err instanceof Error ? err.message : String(err)}`);
      return "command:computer-shell-error";
    }
    // 回显脱敏：代填进去的凭证明文一律替换成 ***（命令本身 echo 了凭证也一样）。
    const redact = (text: string): string => {
      let out = text;
      for (const v of result.filledValues) {
        if (v) out = out.split(v).join("***");
      }
      return out;
    };
    const output = redact(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim());
    const full = `退出码 ${result.code}${output ? `\n${output}` : ""}`;
    const chunks = splitMessage(full);
    await reply(chunks[0]);
    for (const chunk of chunks.slice(1)) {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: chunk });
    }
    return "command:computer-shell";
  }

  // -- 主链路 ----

  status(): BotStatus {
    let monthlySpent: number | null = null;
    try {
      monthlySpent = this.ledger.monthTotal(monthKeyString()).spentUsd;
    } catch { /* ignore */ }
    return {
      running: this.running,
      model: this.modelName,
      queueDepth: this.queue.totalDepth(),
      activeSessions: this.queue.activeKeys(),
      todaySpentUsd: this.quota.dailySpentUsd(),
      dedupSize: this.dedup.size(),
      monthlySpentUsd: monthlySpent,
      monthlyLimitUsd: resolveMonthlyLimit(this.config),
      pendingApprovals: this.bridge.pendingCount(),
    };
  }

  async handleMessage(msg: InboundMessage): Promise<void> {
    const key = sessionKeyFor(msg);
    const dedupKey = `${msg.channel}:${msg.messageId}`;
    if (this.dedup.checkAndMark(dedupKey)) {
      appendAudit(this.home, { ts: new Date().toISOString(), channel: msg.channel, session_key: key, message_id: msg.messageId, outcome: "duplicate" });
      return;
    }
    const audit = (outcome: string, extra?: Partial<AuditRecord>): void => {
      appendAudit(this.home, { ts: new Date().toISOString(), channel: msg.channel, session_key: key, message_id: msg.messageId, outcome, ...(this.bindingId ? { binding_id: this.bindingId } : {}), ...extra });
    };
    // 角色路由（Phase 2）：画像跟着发信人走，guest 默认只读。
    const profile = profileForRole(resolveRole(msg, this.policy), this.policy, msg.chatId);
    // 群聊 @ 过滤（mentionOnly 默认开；私聊不受影响）——缺口 42 第三批：
    // 这道门对确定性指令同样适用（docs/bot.md 一直这么写，之前代码把指令
    // 放在门前是漏的：/new、/stop 没做角色限制，群里任何人不用 @ 就能清会
    // 话、停任务）。审批按钮回调不受影响（Telegram 回调统一置 isMentioned）。
    if ((msg.chatType === "group" || msg.chatType === "supergroup") && this.policy.mentionOnly && !msg.isMentioned) {
      audit("ignored:not-mentioned");
      return;
    }
    // 确定性指令优先：不走模型、不扣 token、不计配额。
    const cmd = parseBotCommand(msg.text);
    if (cmd) {
      await this.handleCommand(msg, cmd.command, cmd.args, profile);
      return;
    }
    // 空消息（没正文也没附件）直接忽略。
    if (!msg.text.trim() && msg.attachments.length === 0) {
      audit("ignored:empty");
      return;
    }
    // 配额三档（用户/天、群聊/分钟、当天 token 预算）。
    const senderKey = `${msg.channel}:${msg.senderId}`;
    if (!this.quota.userAllowed(senderKey, this.policy.perUserDailyLimit)) {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: `今天的消息额度已用完（每人每天 ${this.policy.perUserDailyLimit} 条），明天再来。` });
      audit("blocked:quota-user");
      return;
    }
    if (!this.quota.chatMinuteAllowed(key, this.policy.perChatPerMinuteLimit)) {
      audit("blocked:quota-chat");
      return;
    }
    if (!this.quota.budgetAllowed(this.policy.dailyTokenBudgetUsd)) {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: "今天的 token 预算已用完，明天再来。" });
      audit("blocked:quota-budget");
      return;
    }
    // 月度硬顶预检：本月已花 ≥ 上限时直接回绝、不进模型（轮次里的 checkCost 是第二道门；审批放行绕不过这两道）。
    const monthlyLimit = resolveMonthlyLimit(this.config);
    if (monthlyLimit !== null) {
      const spent = this.monthSpentBeforeUsd();
      if (spent !== null && spent.spentUsd >= monthlyLimit) {
        await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: `本月预算已用完（已花 $${spent.spentUsd.toFixed(4)} / 上限 $${monthlyLimit.toFixed(2)}），本月不再执行新任务。` });
        audit("blocked:monthly-budget");
        return;
      }
    }
    // Phase 3：附件处理（配额与月度预检之后——附件下载也要受配额约束，
    // 否则光发附件就能绕过限额刷下载）。文本文档提取进上下文，图片只
    // 记元信息；没正文、又没提取出可用内容时只回说明，不进模型。
    // 语音附件不进 processAttachments（它是“语音指挥”入口，见下）。
    let effectiveText = msg.text;
    let attachmentNotices: string[] = [];
    const voiceAtts = msg.attachments.filter((a) => a.kind === "voice");
    const otherAtts = msg.attachments.filter((a) => a.kind !== "voice");
    if (otherAtts.length > 0) {
      const attRes = await processAttachments(this.adapter, otherAtts, {
        maxBytes: this.policy.attachmentMaxBytes,
        textChars: this.policy.attachmentTextChars,
      });
      attachmentNotices = attRes.notices;
      if (attRes.extractedText) {
        effectiveText = effectiveText.trim()
          ? `${effectiveText}\n\n${attRes.extractedText}`
          : attRes.extractedText;
      }
    }
    // 缺口 27：语音入口——“语音指挥”（说一句话、干完回文字汇报）。只转写
    // 第一条语音（多条时其余忽略并说明）；转写失败直接回说明，不进模型；
    // 转写出的文字就是任务文本。语音不碰支付与对外发送（缺口 15 的边界，
    // 沿用至今：那两类动作在 Agent 层同样要过审批门，这里不另开口子）。
    // 转写原文不进审计（只记引擎与花费），与转写账本同口径。
    if (voiceAtts.length > 0) {
      const voice = await this.transcribeVoiceAttachment(voiceAtts[0]);
      if (!voice.ok) {
        await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: `语音转写失败：${voice.error}` });
        audit("error:voice-transcribe", { error: voice.error });
        return;
      }
      if (!voice.text.trim()) {
        await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: "语音里没识别出文字，请再说一次。" });
        audit("notice:voice-empty");
        return;
      }
      attachmentNotices.unshift(`已把语音转成文字（${voice.engine}）`);
      if (voiceAtts.length > 1) attachmentNotices.unshift("只转写了第一条语音，其余忽略。");
      effectiveText = effectiveText.trim() ? `${effectiveText}\n\n${voice.text}` : voice.text;
      if (voice.costUsd !== null) this.quota.recordSpent(voice.costUsd);
    }
    if (!effectiveText.trim()) {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: attachmentNotices.join("\n") });
      audit("notice:attachment");
      return;
    }
    // 先发占位，再排队（排队久的用户也知道 Bot 收到了）。
    let placeholderId: string;
    try {
      placeholderId = await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: "处理中…" });
    } catch (err) {
      audit("error:placeholder", { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.quota.recordUser(senderKey);
    const replied = { done: false };
    // 请求上下文只在本次任务跑的时候挂在会话上（approveFn 靠它发审批提示）；
    // 同一会话的任务串行，任务开始时挂、结束时摘，不会被后一条消息提前覆盖。
    const ctx = { chatId: msg.chatId, threadId: msg.threadId, senderId: msg.senderId, profile };
    const result = await this.queue.enqueue(key, async (signal) => {
      this.sessionCtx.set(key, ctx);
      try {
        // 缺口 42 第二批：消息到了就唤醒 Bot 的电脑（休眠只是状态位，workspace
        // 一直在），任务落在电脑的 workspace 里跑（Agent 的 workdir 已绑过去）。
        this.wakeBoundComputer();
        const res = await this.agentRunFn(key, effectiveText, signal);
        if (signal.aborted) return;
        this.recordTaskActivity(key, true, res.spentUsd);
        this.quota.recordSpent(res.spentUsd);
        // 附件说明贴在回复前面（“已读取文档 X”“图片暂不支持看图”这类
        // 提示用户要看到；没附件时 notices 为空，回复原样不变）。
        const replyText = attachmentNotices.length
          ? `${attachmentNotices.join("\n")}\n\n${res.text || "（没有返回内容）"}`
          : (res.text || "（没有返回内容）");
        const chunks = splitMessage(replyText);
        await this.adapter.editText(msg.chatId, placeholderId, chunks[0]);
        replied.done = true;
        for (const chunk of chunks.slice(1)) {
          await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: chunk });
        }
        audit("ok", { chars: res.text.length, spent_usd: res.spentUsd });
      } catch (err) {
        const reason = this.queue.abortReason(key);
        if (signal.aborted || reason) {
          const text = reason === "timeout" ? "处理超时，已取消。" : "已停止。";
          try { await this.adapter.editText(msg.chatId, placeholderId, text); } catch { /* ignore */ }
          replied.done = true;
          audit("cancelled", { error: reason ?? "aborted" });
          return;
        }
        this.recordTaskActivity(key, false, null);
        const message = err instanceof Error ? err.message : String(err);
        try { await this.adapter.editText(msg.chatId, placeholderId, `处理失败：${message}`); } catch { /* ignore */ }
        replied.done = true;
        audit("error:agent", { error: message });
      } finally {
        if (this.sessionCtx.get(key) === ctx) this.sessionCtx.delete(key);
      }
    }, { timeoutMs: profile.timeoutMs });
    if (result === "cancelled" && !replied.done) {
      // 排队时被 /stop 取消：任务函数没跑过，占位还挂着，这里收尾。
      try { await this.adapter.editText(msg.chatId, placeholderId, "已取消。"); } catch { /* ignore */ }
      audit("cancelled:queued");
    }
  }

  // -- 轮询循环 ----

  /**
   * 缺口 27：启动后台服务（审批过期扫荡 + 电脑休眠扫荡 + 主动推送巡查）。
   * startPolling 调它（notifier 默认开）；渠道网关按绑定建 runner 时也调它，
   * 但 notifier 只在默认绑定的 runner 上开——同一渠道多个 runner 各起一个
   * 推送巡查会重复推送（notifier 的状态文件有冷却，但两个进程/实例会竞写）。
   */
  startServices(opts?: { notifier?: boolean }): void {
    // 过期扫荡：把没人等、到期的挂起审批标 expired（等人的那个由 waitForDecision 自己的定时器处理）。
    this.bridge.sweepExpired();
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => { this.bridge.sweepExpired(); }, 30000);
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    }
    // Phase 3：主动推送巡查（notifier 没开时不建定时器；tick 内部还会再
    // 认一次 enabled / owner / target，缺一个就不推）。
    if (this.policy.notifier.enabled && opts?.notifier !== false && !this.notifyTimer) {
      this.notifyTimer = setInterval(() => {
        void this.notifier.tick().catch((err) => {
          process.stderr.write(`Bot 推送巡查失败：${err instanceof Error ? err.message : String(err)}\n`);
        });
      }, this.policy.notifier.heartbeatIntervalMs);
      if (typeof this.notifyTimer.unref === "function") this.notifyTimer.unref();
    }
    // 缺口 42 第二批：电脑闲置休眠扫荡（5 分钟一次；先扫一次再起定时器）。
    this.sweepSleepDue();
    if (!this.computerSweepTimer) {
      this.computerSweepTimer = setInterval(() => { this.sweepSleepDue(); }, 5 * 60 * 1000);
      if (typeof this.computerSweepTimer.unref === "function") this.computerSweepTimer.unref();
    }
  }

  /** 停掉 startServices 起的三个定时器（stopPolling 与渠道网关共用）。 */
  stopServices(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.notifyTimer) {
      clearInterval(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (this.computerSweepTimer) {
      clearInterval(this.computerSweepTimer);
      this.computerSweepTimer = null;
    }
  }

  async startPolling(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    this.startServices();
    try {
      await this.adapter.getMe?.();
    } catch { /* username 拿不到不影响运行：@ 判定退化为看文本里的 @ */ }
    let backoffMs = 1000;
    while (this.running) {
      try {
        const msgs = await this.adapter.pollOnce(this.stopController.signal);
        backoffMs = 1000;
        for (const m of msgs) {
          // 缺口 34：信任圈预过滤（与网关同款口径）——单渠道 Bot 也要过圈，
          // 否则绕过网关就等于绕过准入。圈外消息直接丢弃，只记审计。
          const admission = checkCircleInbound(this.home, m.channel, m.senderId);
          if (!admission.admitted) {
            appendAudit(this.home, {
              ts: new Date().toISOString(),
              channel: m.channel,
              session_key: `${m.channel}:${m.chatId}`,
              message_id: m.messageId,
              outcome: "dropped:circle",
              ...(this.bindingId ? { binding_id: this.bindingId } : {}),
              rule: "circle:admission",
              reason: admission.reason,
            });
            continue;
          }
          void this.handleMessage(m).catch((err) => {
            process.stderr.write(`Bot 处理消息失败：${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
      } catch (err) {
        if (!this.running) break;
        process.stderr.write(`Bot 轮询失败（${backoffMs}ms 后重试）：${err instanceof Error ? err.message : String(err)}\n`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  stopPolling(): void {
    this.running = false;
    this.stopServices();
    this.stopController?.abort();
    this.stopController = null;
  }
}

// -- Token 解析（环境变量 > 密码箱 > keys.json；绝不硬编码、不记日志） ----

/**
 * Phase 3：给定时任务守护进程（`nyra schedule daemon`）与任务 worker
 * （`nyra task worker`）用的 notifier。notifier 开的条件（显式开 +
 * 配了 owner + 配了目标会话 + token 能拿到）缺一个就返回 null，调用
 * 方不推、不报错。daemon/worker 进程里没有 BotRunner 的活状态，tick
 * 只跑 watch；任务结果推送走 notifyTaskResult。
 */
export function buildNotifierFromConfig(home: string, config: Record<string, unknown>): BotNotifier | null {
  const policy = botPolicyFromConfig(config);
  if (!policy.notifier.enabled || policy.owner === null || policy.notifier.targetChatId === null) return null;
  const token = resolveTelegramToken(home);
  if (!token.token) return null;
  const adapter = new TelegramAdapter({ token: token.token });
  return new BotNotifier({
    home,
    policy: policy.notifier,
    owner: policy.owner,
    send: (chatId, threadId, text) => adapter.sendText({ chatId, threadId, text }),
    audit: (outcome) => {
      appendAudit(home, { ts: new Date().toISOString(), channel: "telegram", session_key: "", message_id: "", outcome });
    },
  });
}

export function resolveTelegramToken(home: string): { token: string | null; source: "env" | "vault" | "file" | "missing" } {
  const env = process.env[TELEGRAM_TOKEN_ENV];
  if (env && env.trim()) return { token: env.trim(), source: "env" };
  const vaultToken = getCredential(TELEGRAM_TOKEN_KEY, home);
  if (vaultToken) return { token: vaultToken, source: "vault" };
  const file = getFileKey(TELEGRAM_TOKEN_KEY, home);
  if (file) return { token: file, source: "file" };
  return { token: null, source: "missing" };
}

/** Discord Bot token 解析（与 Telegram 同款三来源：环境变量 → 密码箱 → 文件）。 */
export function resolveDiscordToken(home: string): { token: string | null; source: "env" | "vault" | "file" | "missing" } {
  const env = process.env[DISCORD_TOKEN_ENV];
  if (env && env.trim()) return { token: env.trim(), source: "env" };
  const vaultToken = getCredential(DISCORD_TOKEN_KEY, home);
  if (vaultToken) return { token: vaultToken, source: "vault" };
  const file = getFileKey(DISCORD_TOKEN_KEY, home);
  if (file) return { token: file, source: "file" };
  return { token: null, source: "missing" };
}

/** Slack 凭证解析：两个 token 各三来源（环境变量 → 密码箱 → 文件），同款口径。 */
export function resolveSlackTokens(home: string): {
  appToken: string | null;
  botToken: string | null;
  source: "env" | "vault" | "file" | "missing";
} {
  const appEnv = process.env[SLACK_APP_TOKEN_ENV];
  const botEnv = process.env[SLACK_BOT_TOKEN_ENV];
  // 两个 token 都从环境变量来才算 env 来源（缺一个降级到 vault/file 补）。
  if (appEnv && appEnv.trim() && botEnv && botEnv.trim()) {
    return { appToken: appEnv.trim(), botToken: botEnv.trim(), source: "env" };
  }
  const appVault = getCredential(SLACK_APP_TOKEN_KEY, home);
  const botVault = getCredential(SLACK_BOT_TOKEN_KEY, home);
  if (appVault && botVault) return { appToken: appVault, botToken: botVault, source: "vault" };
  const appFile = getFileKey(SLACK_APP_TOKEN_KEY, home);
  const botFile = getFileKey(SLACK_BOT_TOKEN_KEY, home);
  if (appFile && botFile) return { appToken: appFile, botToken: botFile, source: "file" };
  // 三来源都凑不齐两个 token：能拼一个算一个（start 会再判空拒绝）。
  const app = appEnv?.trim() || appVault || appFile || null;
  const bot = botEnv?.trim() || botVault || botFile || null;
  return { appToken: app, botToken: bot, source: "missing" };
}

/** WhatsApp 凭证解析：access token + 号码 id 各三来源，同款口径。 */
export function resolveWhatsAppCredentials(home: string): {
  token: string | null;
  phoneNumberId: string | null;
  source: "env" | "vault" | "file" | "missing";
} {
  const tokenEnv = process.env[WHATSAPP_TOKEN_ENV];
  const phoneEnv = process.env[WHATSAPP_PHONE_ID_ENV];
  if (tokenEnv && tokenEnv.trim() && phoneEnv && phoneEnv.trim()) {
    return { token: tokenEnv.trim(), phoneNumberId: phoneEnv.trim(), source: "env" };
  }
  const tokenVault = getCredential(WHATSAPP_TOKEN_KEY, home);
  const phoneVault = getCredential(WHATSAPP_PHONE_ID_KEY, home);
  if (tokenVault && phoneVault) return { token: tokenVault, phoneNumberId: phoneVault, source: "vault" };
  const tokenFile = getFileKey(WHATSAPP_TOKEN_KEY, home);
  const phoneFile = getFileKey(WHATSAPP_PHONE_ID_KEY, home);
  if (tokenFile && phoneFile) return { token: tokenFile, phoneNumberId: phoneFile, source: "file" };
  const token = tokenEnv?.trim() || tokenVault || tokenFile || null;
  const phoneNumberId = phoneEnv?.trim() || phoneVault || phoneFile || null;
  return { token, phoneNumberId, source: "missing" };
}

type BotChannelName = "telegram" | "discord" | "slack" | "whatsapp";

function pidPath(home: string, channel: BotChannelName): string {
  const file = channel === "telegram" ? BOT_TELEGRAM_PID_FILE
    : channel === "discord" ? BOT_DISCORD_PID_FILE
    : channel === "slack" ? BOT_SLACK_PID_FILE
    : BOT_WHATSAPP_PID_FILE;
  return join(resolveNyraHome(home), file);
}

function readPid(home: string, channel: BotChannelName): number | null {
  try {
    const raw = readFileSync(pidPath(home, channel), "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(home: string, channel: BotChannelName): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(pidPath(home, channel), `${process.pid}\n`, { encoding: "utf-8", mode: 0o600 });
}

function removePid(home: string, channel: BotChannelName): void {
  try { rmSync(pidPath(home, channel), { force: true }); } catch { /* ignore */ }
}

// -- CLI：nyra bot telegram <start|stop|status> ----

/** `nyra bot status`：渠道（Telegram/Discord/Slack/WhatsApp 运行态 + token 配置）+ 电脑总览（数量、醒/休眠、已声明内存）。 */
export function handleBotStatus(home: string): number {
  const resolvedHome = home || resolveHome();
  const config = loadConfig(resolvedHome);
  const channelMeta: { channel: BotChannelName; label: string; tokenDesc: string }[] = [
    { channel: "telegram", label: "Telegram", tokenDesc: "" },
    { channel: "discord", label: "Discord", tokenDesc: "" },
    { channel: "slack", label: "Slack", tokenDesc: "" },
    { channel: "whatsapp", label: "WhatsApp", tokenDesc: "" },
  ];
  for (const meta of channelMeta) {
    const pid = readPid(resolvedHome, meta.channel);
    const alive = pid !== null && pidAlive(pid);
    let tokenLine: string;
    if (meta.channel === "slack") {
      const tokens = resolveSlackTokens(resolvedHome);
      tokenLine = tokens.appToken && tokens.botToken
        ? `已配置（${tokens.source}，${maskKey(tokens.appToken)} / ${maskKey(tokens.botToken)}）`
        : "未配置（需 app token + bot token）";
    } else if (meta.channel === "whatsapp") {
      const creds = resolveWhatsAppCredentials(resolvedHome);
      tokenLine = creds.token && creds.phoneNumberId
        ? `已配置（${creds.source}，${maskKey(creds.token)} / 号码 ${creds.phoneNumberId}）`
        : "未配置（需 access token + 号码 id）";
    } else {
      const resolveToken = meta.channel === "telegram" ? resolveTelegramToken : resolveDiscordToken;
      const token = resolveToken(resolvedHome);
      tokenLine = token.token ? `已配置（${token.source}，${maskKey(token.token)}）` : "未配置";
    }
    process.stdout.write(`${meta.label} Bot：${alive ? `运行中（pid ${pid}）` : "未运行"}，Token：${tokenLine}\n`);
  }
  // 缺口 27：渠道网关运行态（只读 pidfile，不 import channels/gateway.ts——
  // 那边 import bot/index.ts，反向 import 会成循环导入）。
  let gwPid: number | null = null;
  try {
    const raw = Number(readFileSync(join(resolveNyraHome(resolvedHome), "channel-gateway.pid"), "utf-8").trim());
    if (Number.isInteger(raw) && raw > 0) {
      try { process.kill(raw, 0); gwPid = raw; } catch { /* 进程已死 */ }
    }
  } catch { /* 没有 pidfile */ }
  process.stdout.write(`渠道网关：${gwPid !== null ? `运行中（pid ${gwPid}）` : "未运行"}（nyra channels status 看详情）\n`);
  const summary = computerResourceSummary(resolvedHome);
  process.stdout.write(`电脑：${summary.computers} 台（醒着 ${summary.active}，休眠 ${summary.sleeping}），已声明内存 ${summary.declaredMemoryMb} MB / 上限 ${summary.memoryCapMb} MB（系统 ${summary.systemMemoryMb} MB 的 80%）\n`);
  if (summary.cpuOverSubscribed) {
    process.stdout.write(`注意：CPU 已超配（醒着的电脑共声明 ${summary.declaredCpuPercent}%，${summary.cpuCores} 核共 ${100 * summary.cpuCores}%），跑满时会互相抢。\n`);
  }
  const computers = listComputers(resolvedHome);
  // 缺口 42 第二批：标出本 Bot（config 的 bot.agent）那台电脑。
  const botAgent = botPolicyFromConfig(config).agent;
  for (const c of computers) {
    process.stdout.write(`- ${c.id}（${c.name}，agent ${c.agent}）— ${c.state === "active" ? "醒着" : "休眠"}，${c.isolation === "dedicated" ? "独占" : "共享"}${c.agent === botAgent ? "（本 Bot 的电脑）" : ""}\n`);
  }
  process.stdout.write("详情见 docs/bot.md 与 docs/bot-computer.md。\n");
  return 0;
}

export async function handleBot(argv: string[], home: string): Promise<number> {
  const resolvedHome = home || resolveHome();
  const channel = argv[0];
  // 缺口 51：业务动作硬红线表（`nyra bot redlines ...`；`nyra redlines` 是
  // 另一条命令——上线红线自检，不要混用）。
  if (channel === "redlines") {
    return handleBusinessRedlines(argv.slice(1), resolvedHome);
  }
  // 缺口 42 第一批：每 Bot 一台持久电脑（`nyra bot computer ...`）。
  if (channel === "computer") {
    return handleComputer(argv.slice(1), resolvedHome);
  }
  // 缺口 42 第一批：`nyra bot status`——渠道 + 电脑总览。
  if (channel === "status") {
    return handleBotStatus(resolvedHome);
  }
  const action = argv[1];
  if (channel !== "telegram" && channel !== "discord" && channel !== "slack" && channel !== "whatsapp") {
    process.stdout.write("用法：nyra bot telegram <start|stop|status>\n       nyra bot discord <start|stop|status>\n       nyra bot slack <start|stop|status>\n       nyra bot whatsapp <start|stop|status>\n       nyra bot computer <create|list|status|sleep|wake|remove|credential|shell|sleep-due>\n       nyra bot status\n       nyra bot redlines <status|list|show|tighten|loosen|set>\n");
    return 2;
  }
  if (!action) {
    process.stdout.write(`用法：nyra bot ${channel} <start|stop|status>\n`);
    return 2;
  }
  const label = channel === "telegram" ? "Telegram" : channel === "discord" ? "Discord" : channel === "slack" ? "Slack" : "WhatsApp";
  const cn: BotChannelName = channel;

  if (action === "stop") {
    const pid = readPid(resolvedHome, cn);
    if (pid === null || !pidAlive(pid)) {
      if (pid !== null) removePid(resolvedHome, cn);
      process.stdout.write(`${label} Bot 未在运行。\n`);
      return 0;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      process.stderr.write(`停止失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    removePid(resolvedHome, cn);
    process.stdout.write(`已停止 ${label} Bot（pid ${pid}）。\n`);
    return 0;
  }
  if (action === "status") {
    const pid = readPid(resolvedHome, cn);
    const alive = pid !== null && pidAlive(pid);
    const config = loadConfig(resolvedHome);
    const quota = new QuotaStore(resolvedHome);
    const dedup = new DedupStore(resolvedHome);
    let monthlySpent: number | null = null;
    try {
      monthlySpent = new UsageLedger(resolvedHome).monthTotal(monthKeyString()).spentUsd;
    } catch { /* ignore */ }
    process.stdout.write(`${label} Bot：${alive ? `运行中（pid ${pid}）` : "未运行"}\n`);
    if (cn === "slack") {
      const tokens = resolveSlackTokens(resolvedHome);
      process.stdout.write(`Token：${tokens.appToken && tokens.botToken ? `已配置（${tokens.source}，${maskKey(tokens.appToken)} / ${maskKey(tokens.botToken)}）` : `未配置（需 app token ${SLACK_APP_TOKEN_ENV} + bot token ${SLACK_BOT_TOKEN_ENV}，或 nyra vault add 分别存）`}\n`);
    } else if (cn === "whatsapp") {
      const creds = resolveWhatsAppCredentials(resolvedHome);
      process.stdout.write(`Token：${creds.token && creds.phoneNumberId ? `已配置（${creds.source}，${maskKey(creds.token)} / 号码 ${creds.phoneNumberId}）` : `未配置（需 access token ${WHATSAPP_TOKEN_ENV} + 号码 id ${WHATSAPP_PHONE_ID_ENV}，或 nyra vault add 分别存）`}\n`);
    } else {
      const resolveToken = cn === "telegram" ? resolveTelegramToken : resolveDiscordToken;
      const tokenEnv = cn === "telegram" ? TELEGRAM_TOKEN_ENV : DISCORD_TOKEN_ENV;
      const token = resolveToken(resolvedHome);
      process.stdout.write(`Token：${token.token ? `已配置（${token.source}，${maskKey(token.token)}）` : `未配置（环境变量 ${tokenEnv}，或 nyra vault add ${tokenEnv}）`}\n`);
    }
    process.stdout.write(`今日 token 花费：${quota.dailySpentUsd() > 0 ? `$${quota.dailySpentUsd().toFixed(4)}` : "无"}\n`);
    process.stdout.write(`本月已花：${monthlySpent !== null ? `$${monthlySpent.toFixed(4)}` : "未知（未计价）"}\n`);
    process.stdout.write(`去重记录：${dedup.size()} 条\n`);
    process.stdout.write(`详情见 docs/bot.md。\n`);
    return 0;
  }
  if (action === "start") {
    const pid = readPid(resolvedHome, cn);
    if (pid !== null && pidAlive(pid)) {
      process.stderr.write(`${label} Bot 已在运行（pid ${pid}），先 nyra bot ${channel} stop 再启动。\n`);
      return 1;
    }
    if (pid !== null) removePid(resolvedHome, cn);
    const config = loadConfig(resolvedHome);
    let adapter: ChannelAdapter;
    if (cn === "slack") {
      const tokens = resolveSlackTokens(resolvedHome);
      if (!tokens.appToken || !tokens.botToken) {
        const hint = "先在 Slack 后台（api.slack.com/apps）建 app，开 Socket Mode（拿 app-level token xapp-…）+ Bot User（拿 bot token xoxb-…）";
        process.stderr.write(`未找到 ${label} token：${hint}，再用环境变量 ${SLACK_APP_TOKEN_ENV} 与 ${SLACK_BOT_TOKEN_ENV}（或 nyra vault add 分别存）存两个 token（详见 docs/bot.md）。\n`);
        return 1;
      }
      adapter = new SlackAdapter({ appToken: tokens.appToken, botToken: tokens.botToken });
    } else if (cn === "whatsapp") {
      const creds = resolveWhatsAppCredentials(resolvedHome);
      if (!creds.token || !creds.phoneNumberId) {
        const hint = "先在 Meta 开发者后台（developers.facebook.com）建 WhatsApp 应用，拿 system user access token + 号码 id（Phone Number ID）";
        process.stderr.write(`未找到 ${label} 凭证：${hint}，再用环境变量 ${WHATSAPP_TOKEN_ENV} 与 ${WHATSAPP_PHONE_ID_ENV}（或 nyra vault add 分别存）（详见 docs/bot.md）。\n`);
        return 1;
      }
      adapter = new WhatsAppAdapter({ token: creds.token, phoneNumberId: creds.phoneNumberId });
    } else {
      const resolveToken = cn === "telegram" ? resolveTelegramToken : resolveDiscordToken;
      const tokenEnv = cn === "telegram" ? TELEGRAM_TOKEN_ENV : DISCORD_TOKEN_ENV;
      const token = resolveToken(resolvedHome);
      if (!token.token) {
        const hint = cn === "telegram"
          ? "先在 @BotFather 建机器人"
          : "先在 Discord 开发者门户（discord.com/developers）建应用 + Bot，并开启 Message Content Intent";
        process.stderr.write(`未找到 ${label} Bot token：${hint}，再用环境变量 ${tokenEnv} 或 nyra vault add ${tokenEnv} 存 token（详见 docs/bot.md）。\n`);
        return 1;
      }
      adapter = cn === "telegram"
        ? new TelegramAdapter({ token: token.token })
        : new DiscordAdapter({ token: token.token });
    }
    const runner = new BotRunner({ home: resolvedHome, workdir: process.cwd(), config, adapter });
    writePid(resolvedHome, cn);
    process.stdout.write(`${label} Bot 已启动（pid ${process.pid}，模型：${runner.modelName ?? "未配置"}，电脑：${runner.boundComputer ? `${runner.boundComputer.id}（${runner.boundComputer.name}）` : "未接"}）。Ctrl+C 停止，或 nyra bot ${channel} stop。\n`);
    const shutdown = (): void => {
      runner.stopPolling();
      removePid(resolvedHome, cn);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await runner.startPolling();
    removePid(resolvedHome, cn);
    return 0;
  }
  process.stdout.write(`用法：nyra bot ${channel} <start|stop|status>\n`);
  return 2;
}
