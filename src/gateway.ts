// src/gateway.ts — 单 gateway（第 3 阶段，nyra/webui.py + nyra/server.py 对应）。
// `nyra ui` 启动 gateway，拥有全部会话；CLI、网页、定时任务、群聊都接
// gateway；gateway 默认按需启动，不强制常驻（一次性任务直接跑完退出，
// 不留进程）。双客户端同时连一个 gateway 时共用同一份会话状态：
// 同一会话同一时刻只跑一个 agent（第二个 send 得 409，不丢消息、
// 不重复发）；历史与事件都从同一份内存 + 会话文件 + conversations 存档读。
// 鉴权与 Python 版一致：除 /api/health 外都要 X-Nyra-Token（owner）或
// 设备 token（手机）；HTML 页与 manifest/icon 允许 ?token=；无 CORS；
// loopback 绑定时校验 Host 头（防 DNS 重绑定）。
// 压缩分层（方案 2.6 第 7 条）：网关阈值 85% 落在这里——用量比 ≥85% 时先
// 剪旧工具结果（不调 LLM），仍超就记事件、等 agent 侧 50% 压缩接手。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { Agent } from "./agent.ts";
import {
  loadConfig, resolveProfile, resolveProvider, validateMode,
  getProviderPresets, VERSION, VALID_MODES, resolveSandbox, type ResolvedProvider,
} from "./config.ts";
import { resolvePresetFallbackChain } from "./modelPresets.ts";
import { Provider, buildProviderChain, makeModelFactory, switchTriggerFor, switchTriggerLabel, type ProviderLike, type SwitchRecord } from "./providers.ts";
import { TOOL_SCHEMAS, SESSION_GRANT_TOOLS, APPROVE_ALWAYS, MUTATING_TOOLS, type ApproveResult } from "./tools.ts";
import { SessionRules, RuleStore, RULE_SCOPES, MAX_FEEDBACK, normalizeProject, type RuleScope, type RuleSuggestion } from "./approvalRules.ts";
import { encode as qrEncode, toSvg as qrSvg } from "./qrcode.ts";
import { MOBILE_V2_HTML, MOBILE_V2_MANIFEST, MOBILE_ICON_ROUTES, MOBILE_FONT_ROUTE, mobileIconPng, mobileFaviconSvg, mobileFaviconIco, mobileFont } from "./webuiMobile.ts";
import { markSvg } from "./brandMark.ts";
import { runHooks } from "./hooks.ts";
import { getGmailStatus } from "./connectors/gmail.ts";
import {
  dispatchEvent, listEventTriggersPublic, normalizeWebhookEvent, verifyWebhookSignature,
  EventTriggerError, WebhookError, WEBHOOK_SOURCES, type WebhookSource,
} from "./eventTriggers.ts";
import { listMailInboxPublic } from "./mailInbox.ts";
import { listResponsibilitiesPublic } from "./responsibilities.ts";
import {
  ThreadError, createThread, getThread, listThreads, searchThreads,
  copyThread, pruneThread, getThreadState, updateThreadState,
  getThreadHistory, listThreadRuns, setThreadStatus, threadPublic,
} from "./threads.ts";
  // 缺口 30：网关入口此前完全不接成本硬顶与用量账本——Web UI 一跑等于绕过 --max-cost。
import { resolvePricing, resolveMonthlyLimit, monthlyCapDecided } from "./cost.ts";
import { recordModelSwitch, switchTimeShort } from "./modelSwitch.ts";
import { UsageLedger, monthKeyString, nextMonthlyResetDate } from "./usageLedger.ts";
import type { UsageSnapshot } from "./usage.ts";
import { resolveSandboxBackend, type SandboxMode } from "./sandbox.ts";
import { loadSession, saveSession, newSessionId, listSessions, resolveNyraHome, sessionPath, MemoryDeleteError } from "./memory.ts";
import { ConversationStore } from "./conversations.ts";
import { trimOldToolResults, GATEWAY_COMPACT_THRESHOLD, DEFAULT_AUTO_COMPACT_THRESHOLD, validateAutoCompactThreshold } from "./compact.ts";
import { loadSchedule, saveSchedule, schedulePath, listScheduleTasks, removeScheduleTask, runDueTasks, type ScheduleTask } from "./scheduler.ts";
import { enqueueAutomationResults, listReviewItems, getReviewItem, decideReviewItem, applyReviewItem, verifyReviewItem, ReviewQueueError, REVIEW_ID_RE, type ReviewStatus } from "./reviewQueue.ts";
import { appendInbox } from "./tasks.ts";
import { buildPlan, renderPlan, savePlan, readApprovedPlan, approvedExecutionTask, PlanError } from "./planMode.ts";
import { loadSkills, canonicalSkillDirs } from "./skills.ts";
import { pluginSkillDirs } from "./plugins.ts";
// H1：网关逐回合记客户端——每条 HTTP 发起的回合记审计 + 最近客户端账本。
import { describeGatewayClient, listGatewayClients, recordGatewayRound } from "./gatewayClients.ts";
// H2：网关 presence（桌面活跃 → 手机通知静默）。
import { isDesktopActive, isPresenceSurface, listActivePresence, loadGatewayPresence, recordPresenceHeartbeat, shouldNotifyMobile, PRESENCE_ACTIVE_WINDOW_MS, type PresenceSurface } from "./gatewayPresence.ts";
import { loadModelCache, manualWindowFromConfig, resolveContextWindow, type WindowSource } from "./modelCatalog.ts";
import { resolveAuxRouting, resolvePlanActRouting } from "./modelRouting.ts";
import { MCPToolManager, NyraMcpServer, appendMcpServerAudit, buildMcpManager, mcpServerConfig } from "./mcp.ts";
import { McpCostTracker, estimateToolCost, costLimitUsd } from "./mcpCost.ts";
import { DeviceRegistry, defaultDevicesPath, startDiscoveryResponder, PairingError } from "./pairing.ts";
import { FullModeRequests } from "./fullModeRequests.ts";
import { assertValidPairingPublicKey, encryptTokenForPeer, PairingCryptoError } from "./pairingCrypto.ts";
import { memoryScopes, memoryView, memorySave, deleteMemoryForScope, MemoryBrowserError } from "./memoryBrowser.ts";
import { listArtifacts, getArtifact } from "./artifacts.ts";
import { summarizeLastTurn, type TurnSummary } from "./turnSummary.ts";
import { projectMemoryView, projectMemoryFile } from "./projectMemory.ts";
import { EvidenceStore } from "./evidence.ts";
import { activeHandoffForSession, isBotMutedForSession } from "./hitl.ts";
import { GroupStore, type BotConfig, type RoomMessage } from "./groups.ts";
import {
  GroupEventHub, ChiefError, CHIEF_MAX_MEMBERS, CHIEF_PERMISSION,
  chiefCandidates, createChiefGroup, getChiefRun, listChiefRuns, proposeChiefGroup, runChiefGroup,
} from "./chiefGroup.ts";
import { TeamError, getTeam, listTeams, prepareTeamDispatch, publicTeam } from "./team.ts";
import { getGroupPlan, listGroupPlans } from "./groupPlan.ts";
import { isBotModeEnabled, setBotMode } from "./groupBotMode.ts";
import { createInvite, inviteQuota, loadInvites, revokeInvite, InviteError } from "./invites.ts";
import { listExploreTemplates } from "./mobileExplore.ts";
import { assignMascots } from "./mascots.ts";
// 群聊页嵌进二进制（.txt 后缀：bun-types 只给 *.txt 声明了 string 类型；
// 内容分别是群聊页 HTML 与 JS，原文件在 nyra/ 已随 Python 删除，改这里要同步改 .txt）。
import GROUP_UI_HTML from "./assets/group_ui.html.txt" with { type: "text" };
import GROUP_UI_JS from "./assets/group-ui.js.txt" with { type: "text" };
import { decideSmartApproval, reviewerEnabled, smartApprovalConfig, readAudit } from "./smartApprovals.ts";
import { reviewerStatus, resolveReviewerModel } from "./reviewer.ts";
import { rewind as doRewind, storeHistoryToAgentMessages, type RewindAction } from "./rewind.ts";
import { MANIFEST, CSP, solidPng } from "./webuiPage.ts";
// 桌面端界面（按 docs/design 设计稿重做）；旧页 PAGE_HTML 仍从 webuiPage.ts 导出，不再挂在 / 上。
import { DESKTOP_HTML } from "./webuiDesktop.ts";
import { keyStatus, setKey, removeKey, maskKey, validateKey, validateProviderKey, openVault, vaultState, migrateKeysToVault, keysPath } from "./keystore.ts";
import { loadMcpServers } from "./mcp.ts";
import { saveConfig, configPath, effectiveModelFor } from "./config.ts";
import { listMarketplacePublic } from "./marketplace.ts";
import { listDrafts } from "./skillDrafts.ts";
import { listLearning, type LearningKind, type LearningStatus } from "./learning.ts";
import { exportAudit } from "./costCaps.ts";
import {
  AccountStore, AccountSessionStore, MagicLinkStore,
  loginWithMagicLink, AccountError, type Account,
} from "./accounts.ts";

export const GATEWAY_DEFAULT_HOST = "127.0.0.1";
export const GATEWAY_DEFAULT_PORT = 8765;
/** 审批卡自动拒绝的等待秒数：默认 600（约 10 分钟）；运维可用
 *  NYRA_APPROVAL_TIMEOUT_S 覆盖（测试用短超时验证超时路径时也走它）。 */
export const APPROVAL_TIMEOUT = (() => {
  const v = Number(process.env.NYRA_APPROVAL_TIMEOUT_S ?? 600);
  return Number.isFinite(v) && v > 0 ? v : 600;
})();
export const MAX_BODY = 256 * 1024;
export const MAX_EVENT_TEXT = 4000;
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export const APPROVAL_ID_RE = /^[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PROJECT_ENTRIES = 2000;
const STARTUP_SIZES: [number, number][] = [
  [640, 1136], [750, 1334], [1125, 2436], [1170, 2532], [1284, 2778], [1536, 2048], [2048, 2732],
];

export const FORBIDDEN_PAGE = `<!doctype html><meta charset="utf-8"><title>Nyra</title>
<body style="font:16px system-ui;padding:40px;color:#2A2D34;background:#F3F5F4">
<h1>需要访问 token</h1><p>请使用启动 <code>nyra ui</code> 时终端里打印的完整链接（含 <code>?token=</code>）。</p>
<p>Open the full link printed in the terminal (it contains <code>?token=</code>).</p></body>`;

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** 对端地址是不是本机回环（127.0.0.0/8、::1、IPv4 映射的 ::ffff:127.x）。 */
export function isLoopbackPeer(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function clip(text: unknown, limit = MAX_EVENT_TEXT): string {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

export interface PendingApproval {
  id: string;
  tool: string;
  summary: string;
  always: boolean;
  /** 挂起时刻（Date.now() 毫秒）：审批卡倒计时与 expires_at 由它算。 */
  createdAt: number;
  /** shell 命令原文（手机审批卡等宽显示）；非 shell 为 null。 */
  command?: string | null;
  /** “允许并不再询问”的建议规则；null = 只能单次允许（复合/危险命令）。 */
  suggestion?: RuleSuggestion | null;
  decision: ApproveResult | null;
  resolve: (v: ApproveResult) => void;
}

export interface SessionRun {
  sessionId: string;
  agent: Agent | null;
  events: Record<string, unknown>[];
  status: "idle" | "running" | "done" | "error";
  error: string;
  pending: PendingApproval | null;
  baseMessages: Record<string, unknown>[];
  /** 本会话“不再询问”规则：Agent 的 ToolContext 与手机审批卡共用这一份。 */
  sessionRules?: SessionRules;
  /** 会话钩子：SessionStart 是否已触发过（只触发一次，见 fireSessionStart）。 */
  hooksStarted?: boolean;
  /** 会话钩子：SessionEnd 是否已触发过（只触发一次，见 fireSessionEnd）。 */
  hooksEnded?: boolean;
  /** 缺口 30：上一次写进用量账本的用量快照（算增量用；不落盘）。 */
  lastLedgerSnapshot?: UsageSnapshot | null;
  /** 缺口 30：上一次写账本时的已花金额（算增量用；不落盘）。 */
  lastLedgerSpent?: number | null;
  /** P0-3：已收到停止请求、底层正在收尾（还没落定，不谎报已停）。 */
  stopping?: boolean;
  /** P0-3：最近一轮是被停止打断的（lastCancelledReason === "stop"）。 */
  interrupted?: boolean;
}

export interface GatewayOptions {
  home?: string;
  workdir?: string;
  mode?: string;
  providerName?: string | null;
  model?: string | null;
  profile?: string | null;
  maxTurns?: number | null;
  host?: string;
  port?: number;
  token?: string;
  verbose?: boolean;
  config?: Record<string, unknown>;
  providerFactory?: () => ProviderLike;
  reviewerFactory?: () => { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> } | null;
  /** 跑在哪个外壳里："desktop" = Tauri 桌面端（cli 在 --print-url-json 模式下传入），/api/info 回 shell 字段，页面据此决定是否播入场动画。 */
  shell?: string | null;
}

/** 路径的最后一段文件夹名：/ 与 \ 都当分隔符（Windows 路径在侧栏不再整串显示）。 */
export function projectBaseName(path: string): string {
  const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || "");
}

/** 群聊机器人 / 总指挥团队成员的内部会话 id（groups.ts runBot：group-<房间>-<成员>）。 */
export function isGroupMemberSessionId(id: string): boolean {
  return /^group-[a-z][a-z0-9_-]*-[A-Za-z0-9_.-]+$/.test(id);
}

export class Gateway {
  home: string;
  workdir: string;
  mode: string;
  host: string;
  port: number;
  token: string;
  verbose: boolean;
  config: Record<string, unknown>;
  providerName: string | null;
  model: string | null;
  profile: string | null;
  maxTurns: number | null;
  contextWindowTokens: number | null;
  /** 窗口数值的来源（cli/manual/cache/builtin/family/unknown），见 modelCatalog。 */
  contextWindowSource: WindowSource = "unknown";
  /** 用于解析窗口的模型名。 */
  contextWindowModel: string | null = null;
  autoCompactEnabled: boolean;
  autoCompactThreshold: number;
  pairOrigin: string | null = null;
  /** lastTurnOutcome 的落盘会话缓存（会话 id → 文件指纹 + 汇总），最多 200 条。 */
  private outcomeCache = new Map<string, { mtimeMs: number; size: number; ino: number; outcome: TurnSummary | null }>();
  server: Server | null = null;
  runs: Map<string, SessionRun> = new Map();
  approvals: Map<string, { run: SessionRun; pending: PendingApproval }> = new Map();
  /** 手机开完全模式的待确认请求（内存，10 分钟过期，网关重启清掉）。 */
  fullModeRequests = new FullModeRequests();
  devices: DeviceRegistry;
  /** 缺口 41 下一批：账号目录 / 会话 / magic link 存储（文件版；Postgres 网关接线见已知局限）。 */
  accountsDirectory: AccountStore;
  accountSessions: AccountSessionStore;
  magicLinks: MagicLinkStore;
  private _store: ConversationStore | null = null;
  groups: GroupStore;
  /** 群事件流（总指挥分派、成员交回、群里异步发消息）：手机群聊页轮询 / SSE 读它。 */
  groupEvents = new GroupEventHub();
  /** 总指挥团队分派起的 chief 会话：会话 id → 团队与纪元（GET /api/teams/runs/:id 用）。 */  teamRuns: Map<string, { team_id: string; team_name: string; chief: string; epoch: number | null; task: string; created_at: string }> = new Map();
  /** H1：本网关进程启动以来各会话最后一回合是哪个客户端发的（sessionsView 用；持久记录在 gateway-audit.jsonl 里）。 */
  private lastClientBySession = new Map<string, string>();
  mcpManager: MCPToolManager | null = null;
  mcpCost: McpCostTracker;
  private providerInstance: ProviderLike | null = null;
  private reviewerInstance: { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> } | null | undefined = undefined;
  private providerFactory?: () => ProviderLike;
  private reviewerFactory?: GatewayOptions["reviewerFactory"];
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private discoverySocket: { close: () => void } | null = null;
  private projectsLock = false;
  /** 外壳标记（见 GatewayOptions.shell）。 */
  shell: string | null = null;

  constructor(opts: GatewayOptions = {}) {
    this.home = resolveNyraHome(opts.home);
    this.workdir = opts.workdir ?? process.cwd();
    this.config = opts.config ?? loadConfig(this.home);
    this.mode = validateMode(opts.mode ?? (resolveProfile(opts.profile ?? null, this.config).mode as string) ?? "auto");
    this.host = opts.host ?? GATEWAY_DEFAULT_HOST;
    this.port = opts.port ?? GATEWAY_DEFAULT_PORT;
    this.token = opts.token ?? randomBytes(24).toString("base64url");
    this.verbose = opts.verbose ?? false;
    this.providerName = opts.providerName ?? null;
    this.model = opts.model ?? null;
    this.profile = opts.profile ?? null;
    this.maxTurns = opts.maxTurns ?? null;
    // 模型上下文窗口自动识别：手动配置 > 刷新缓存 > 内置表 > 同系列推断；
    // 未知模型不猜数字（resolver 给原因）。与 CLI buildAgent 同优先级。
    const gwProfile = resolveProfile(opts.profile ?? null, this.config);
    const gwManual = manualWindowFromConfig(this.config);
    const gwWindow = resolveContextWindow({
      model: opts.model ?? gwProfile.model ?? effectiveModelFor(this.config, opts.providerName ?? gwProfile.provider) ?? null,
      provider: opts.providerName ?? gwProfile.provider ?? (this.config.provider as string | null) ?? null,
      manual: gwManual.value, manualKey: gwManual.key,
      cache: loadModelCache(this.home),
    });
    this.contextWindowTokens = gwWindow.window;
    this.contextWindowSource = gwWindow.source;
    this.contextWindowModel = gwWindow.model;
    this.autoCompactEnabled = Boolean(this.config.auto_compact_enabled ?? false);
    this.autoCompactThreshold = validateAutoCompactThreshold(
      (this.config.auto_compact_threshold as number | undefined) ?? DEFAULT_AUTO_COMPACT_THRESHOLD,
    );
    this.providerFactory = opts.providerFactory;
    this.reviewerFactory = opts.reviewerFactory;
    this.shell = opts.shell === "desktop" ? "desktop" : null;
    this.devices = new DeviceRegistry(defaultDevicesPath(this.home));
    // 缺口 41 下一批：账号鉴权的存储（文件版，与 CLI 同口径；Postgres 网关接线留待后续）。
    this.accountsDirectory = new AccountStore(this.home);
    this.accountSessions = new AccountSessionStore(this.home);
    this.magicLinks = new MagicLinkStore(this.home);
    // 群聊机器人走网关同一沙箱配置：这里只做配置解析（resolveSandbox 不查
    // 后端二进制是否存在），后端不可用时不拦网关启动，留给机器人跑 shell 时
    // toolShell 逐次 fail-closed——网关只聊天不用 shell 的部署不受影响。
    // 配置名本身非法（不在 VALID_SANDBOXES 里）时 resolveSandbox 直接抛错，
    // 与首次 send 时 sandboxSettings() 的行为一致。
    const groupSandbox = resolveSandbox(this.config);
    this.groups = new GroupStore(join(this.home, "groups"), {
      sandbox: { backend: groupSandbox.backend, mode: groupSandbox.mode as SandboxMode, allowNet: groupSandbox.allowNet },
    });
    this.mcpCost = new McpCostTracker(this.home);
    if (!isLoopbackHost(this.host)) {
      const lan = lanIPv4();
      this.pairOrigin = `http://${lan ?? this.host}:${this.port}`;
    }
  }

  // -- provider ---------------------------------------------------------
  provider(): ProviderLike {
    if (this.providerFactory) {
      if (!this.providerInstance) this.providerInstance = this.providerFactory();
      return this.providerInstance;
    }
    if (this.providerInstance) return this.providerInstance;
    const profile = resolveProfile(this.profile, this.config);
    const primaryCfg = resolveProvider({
      home: this.home, config: this.config,
      providerName: this.providerName ?? profile.provider, model: this.model ?? profile.model ?? undefined,
    });
    const chain = resolvePresetFallbackChain(this.config, primaryCfg.name);
    this.providerInstance = buildProviderChain(
      primaryCfg, chain,
      (record) => this.onSwitch(record),
      {
        resolver: (name: string) => resolveProvider({ home: this.home, config: this.config, providerName: name }),
        // G-P1-33：故障账本接线——切换时标 degraded、建链时过滤未恢复的尾巴。
        health: { home: this.home },
      },
    );
    if (this.maxTurns === null) this.maxTurns = (this.config.max_turns as number | undefined) ?? 20;
    return this.providerInstance;
  }

  /** 定时任务/队列用的主 provider：不走兜底链（安全红线：队列里不切换）。 */
  primaryProvider(): ProviderLike {
    if (this.providerFactory) return this.providerFactory();
    const profile = resolveProfile(this.profile, this.config);
    const cfg = resolveProvider({
      home: this.home, config: this.config,
      providerName: this.providerName ?? profile.provider, model: this.model ?? profile.model ?? undefined,
    });
    if ((cfg as ResolvedProvider).auth === "cli") {
      throw new Error("定时任务不得使用 CLI provider（Codex），请在配置里改用 HTTP provider");
    }
    return new Provider(cfg);
  }

  /** 缺口 24：多模型工厂（Plan/Act 分模型 + compact/delegate/reviewer/verifier）。 */
  private modelFactory(): (name: string, model: string | null) => ProviderLike {
    const profile = resolveProfile(this.profile, this.config);
    const primaryName = this.providerName ?? profile.provider;
    return makeModelFactory({ home: this.home, config: this.config, primaryName: primaryName as string });
  }

  /** 缺口 24：Plan/Act 分模型路由（与 CLI 同口径）。 */
  private planActModels(): { plan?: string; act?: string } {
    const r = resolvePlanActRouting(this.config, this.provider().model);
    return { plan: r.plan, act: r.act };
  }

  /** 缺口 24：辅助任务路由（压缩/子任务便宜模型，与 CLI 同口径）。 */
  private auxModels(): { compact?: string; delegate?: string } {
    const r = resolveAuxRouting(this.config, this.provider().model);
    return { compact: r.compact, delegate: r.delegate };
  }

  private reviewer(): { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> } | null {
    if (this.reviewerInstance !== undefined) return this.reviewerInstance;
    if (this.reviewerFactory) {
      this.reviewerInstance = this.reviewerFactory();
      return this.reviewerInstance;
    }
    if (!reviewerEnabled(this.config)) { this.reviewerInstance = null; return null; }
    const cfg = smartApprovalConfig(this.config);
    try {
      const resolved = resolveProvider({
        home: this.home, config: this.config,
        providerName: cfg.reviewer_provider ?? undefined, model: cfg.reviewer_model ?? undefined,
      });
      const p = new Provider(resolved);
      if (!p.hasCredentials()) { this.reviewerInstance = null; return null; }
      this.reviewerInstance = p;
      return p;
    } catch {
      this.reviewerInstance = null;
      return null;
    }
  }

  /** 缺口 17：对外 MCP 服务实例（懒创建，一个网关进程一个；审查 runner 按需
   * 解析，activeSessionIds 取网关当前会话——forget_session 的进行中保护用）。 */
  private mcpServerInstance: NyraMcpServer | null = null;
  private mcpServer(): NyraMcpServer {
    if (!this.mcpServerInstance) {
      this.mcpServerInstance = new NyraMcpServer({
        home: this.home,
        config: this.config,
        workdir: this.workdir,
        reviewerRunner: () => this.reviewer(),
        activeSessionIds: () => this.runs.keys(),
      });
    }
    return this.mcpServerInstance;
  }

  private onSwitch(record: SwitchRecord): void {
    const reason = record.error.length > 120 ? record.error.slice(0, 117) + "…" : record.error;
    const trigger = record.trigger ?? switchTriggerFor(record.kind);
    // G-P1-33：这次切换把 from 标 degraded 时，提示里写明恢复时间。
    const degradedNote = record.degradedUntil ? `；${record.from} 已标故障，${switchTimeShort(new Date(record.degradedUntil))} 前不再选用` : "";
    process.stderr.write(`模型切换（${switchTriggerLabel(trigger)}）：${record.from} 失败（${reason}），已切换到 ${record.to} 继续${degradedNote}\n`);
    const running = [...this.runs.values()].filter((run) => run.status === "running");
    // 备用模型切换通知：每次真切换记一行审计（SIEM 导出第 7 个来源）；
    // run_id 只在恰好一个会话在跑时才认得出，多会话并发时记 null（事件本身
    // 已按会话分别记进各 running 会话的事件流，网页端照样立刻看到）。
    recordModelSwitch(this.home, record, { runId: running.length === 1 ? running[0].sessionId : null });
    for (const run of running) {
      this.record(run, "model_switch", { from: record.from, to: record.to, error: reason, trigger, kind: record.kind, ...(record.degradedUntil ? { degraded_until: record.degradedUntil } : {}) });
    }
  }

  // -- sessions ---------------------------------------------------------
  getRun(sessionId: string, create?: true): SessionRun;
  getRun(sessionId: string, create: false): SessionRun | null;
  getRun(sessionId: string, create = true): SessionRun | null {
    let run = this.runs.get(sessionId);
    if (!run && create) {
      run = { sessionId, agent: null, events: [], status: "idle", error: "", pending: null, baseMessages: [], sessionRules: new SessionRules() };
      this.runs.set(sessionId, run);
    }
    return run ?? null;
  }

  newSession(): string {
    const sid = newSessionId();
    const run = this.getRun(sid);
    this.fireSessionStart(run);
    return sid;
  }

  /**
   * 逐会话关闭（DELETE /api/sessions/:id）：触发一次 SessionEnd（fireSessionEnd
   * 自带去重；无钩子时立即返回）并从 live 会话表里删掉该会话；持久化会话文件
   * 保留（仍可从列表/历史读到）。运行中的会话不中途杀任务，返回 "running"
   * （调用方回 409，等它跑完再关）；live 表里没有、磁盘上也没有该会话时返回
   * "unknown"；磁盘上有、live 表里没有时没有 live 会话可关，直接返回 "closed"
   * （关闭是幂等的）。SessionEnd 钩子等跑完再返回（与 stop() 同款约定，
   * 避免关完钩子还在跑；钩子有超时封顶，不会无限等）。
   */
  async closeSession(sessionId: string): Promise<"closed" | "running" | "unknown"> {
    const run = this.getRun(sessionId, false);
    if (!run) {
      if (!this.sessionKnown(sessionId)) return "unknown";
      return "closed";
    }
    if (run.status === "running") return "running";
    await (this.fireSessionEnd(run) ?? Promise.resolve());
    this.runs.delete(sessionId);
    return "closed";
  }

  /**
   * P0-3 窗口停止按钮（POST /api/sessions/:id/stop）：对正在跑的会话发
   * 取消信号（复用可靠性第 1 项的 Agent.requestStop，原因 stop），不等底
   * 层收尾就返回 { stopping: true }——界面先显示“正在停止”，底层真的停
   * 了（doWork 落定）才把 stopping 清掉、把 interrupted 标上。不在跑时
   * 返回 ok: false，不抛错（停止是幂等的）。
   * 等审批卡住时：先把挂起的审批按拒绝解开，agent 才会继续走到下一轮
   * 模型调用、撞上已 abort 的信号停下；否则会卡满 600 秒等超时。
   */
  stopSession(sessionId: string): { ok: boolean; status: string; stopping: boolean } {
    const run = this.getRun(sessionId, false);
    if (!run || run.status !== "running") return { ok: false, status: run?.status ?? "idle", stopping: false };
    if (run.pending) {
      try { this.decide(run.pending.id, false); } catch { /* 审批解不开也不拦停止 */ }
    }
    if (run.agent) run.agent.requestStop();
    run.stopping = true;
    return { ok: true, status: "running", stopping: true };
  }

  /**
   * P0-3 花钱之前先看见上限：第一次花钱的任务开始前，月度上限必须已明
   * 确选定（填过数字、或明确选过“不设上限”）。没选定时、且当前 provider
   * 是要 Key 的付费模型，直接拦下并指去设置；本地/免 Key 模型不花钱，
   * 不拦。CLI 与 plan() 走同一道门（executePlan 复用 send()）。
   */
  private requireMonthlyCapDecision(): void {
    if (monthlyCapDecided(this.config)) return;
    let name: string | null = null;
    try { name = (this.provider() as unknown as { name?: string }).name ?? null; } catch { name = null; }
    if (!name) name = typeof this.config.provider === "string" ? this.config.provider : null;
    if (!name) return;
    const presets = getProviderPresets(this.config);
    const preset = presets[name] as unknown as { envKey?: string | null } | undefined;
    if (!preset || !preset.envKey) return;
    throw new Error("请先在设置里选定月度上限（填一个数字，或明确选“不设上限”），再开始花钱的任务。设置 → 通用 → 月度上限。");
  }

  sessionKnown(sid: string): boolean {
    if (this.getRun(sid, false)) return true;
    return loadSession(sid, this.home) !== null;
  }

  sessionMessages(sessionId: string): Record<string, unknown>[] {
    const run = this.getRun(sessionId, false);
    if (run && run.status === "running") return [...run.baseMessages];
    if (run && run.agent) return [...run.agent.messages];
    return loadSession(sessionId, this.home) ?? [];
  }

  sessionView(sessionId: string, since = 0): Record<string, unknown> {
    const run = this.getRun(sessionId, false);
    const messages = this.sessionMessages(sessionId);
    let events: Record<string, unknown>[] = [];
    let status = "idle";
    let pending: Record<string, unknown> | null = null;
    let error = "";
    let total = 0;
    if (run) {
      events = run.events.slice(since);
      status = run.status;
      error = run.error;
      total = run.events.length;
      if (run.pending) {
        const { resolve: _r, decision: _d, ...rest } = run.pending as unknown as Record<string, unknown>;
        void _r; void _d;
        pending = rest;
      }
    }
    const plan = this.findPlan(messages, run?.events ?? []);
    return {
      id: sessionId, status, error, messages, events, next: total, pending,
      evidence: this.listEvidence(sessionId),
      plan,
      usage: run?.agent ? run.agent.usage.snapshot() : null,
      // P0-3：停止状态（正在停止 / 最近一轮被打断）、本次金额、本月预算。
      // cost 没调过用时为 null；status 是 unpriced/missing 时 spent_usd 为
      // null，不编数字——界面据此显示“金额未知，已暂停”。
      stopping: run?.stopping ?? false,
      interrupted: run?.interrupted ?? false,
      cost: run?.agent?.lastCost
        ? { status: run.agent.lastCost.status, spent_usd: run.agent.lastCost.spentUsd }
        : null,
      budget: this.budgetSummary(),
      // 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 可视化的
      // 网页端接口：沿用 sessionView 的返回体，加 context breakdown 字段；
      // 无 live agent 时为 null（读会话文件时不拼系统提示，不编造数字）。
      context: run?.agent ? run.agent.contextUsage() : null,
      auto_compact_count: run?.agent ? run.agent.autoCompactCount : 0,
    };
  }

  private findPlan(messages: Record<string, unknown>[], events: Record<string, unknown>[]): Record<string, unknown> | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "plan_ready" && e.data && typeof e.data === "object") {
        const d = e.data as Record<string, unknown>;
        return { plan: d.plan, sha256: d.sha256, path: "plan.md", status: "ready" };
      }
    }
    void messages;
    return null;
  }

  private listEvidence(sessionId: string): { name: string }[] {
    const dir = join(this.home, "evidence", sessionId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).map((f) => ({ name: f }));
    } catch { return []; }
  }

  sessionsView(): Record<string, unknown> {
    const projects = this.loadProjects();
    const byId = new Map<string, { id: string; preview: string; count: number; mtime: string }>();
    for (const item of listSessions(this.home)) byId.set(item.id, item);
    // 刚建、还没落盘的 live 会话也要出现在列表里（否则新建后列表是空的）。
    for (const [id, run] of this.runs) {
      if (!byId.has(id)) {
        const msgs = run.agent ? run.agent.messages : [];
        const firstUser = msgs.find((m) => m.role === "user");
        byId.set(id, {
          id, preview: typeof firstUser?.content === "string" ? firstUser.content.slice(0, 60) : "",
          count: msgs.length, mtime: new Date().toISOString().slice(0, 19),
        });
      }
    }
    // 设计稿 v8（手机列表副标题写结果）：最近 40 个会话附上最后一轮的真实汇总（改了几个文件、跑了几条命令、
    // 有没有 git push）；会话文件超过 4 MiB 的不读，outcome 记 null，界面退回原来的副标题。
    const recentIds = new Set([...byId.values()].sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))).slice(0, 40).map((x) => x.id));
    // 群聊 / 总指挥团队成员各自的内部会话（id = group-<房间>-<成员>，首条是
    // 「以下是共享群聊记录…」提示词）不是用户自己的对话：从列表里拿掉，
    // 归到所属总指挥任务下（member_sessions），会话本身照旧能按 id 打开。
    const memberSessions = this.groupMemberSessions([...byId.values()]);
    for (const id of memberSessions.ids) byId.delete(id);
    const sessions = [...byId.values()].map((item) => {
      const workdir = projects[item.id];
      // status：手机列表的状态点用（运行中 / 出错 / 空闲）；没有 live run 的会话一律 idle。
      const status = this.runs.get(item.id)?.status ?? "idle";
      const outcome = recentIds.has(item.id) && status !== "running" ? this.lastTurnOutcome(item.id) : null;
      // H1：本网关进程启动以来，这个会话最后一回合是哪个客户端发的
      // （没跑过回合时 null；持久记录在 gateway-audit.jsonl 里）。
      const last_client = this.lastClientBySession.get(item.id) ?? null;
      return { ...item, workdir: workdir ?? null, project: workdir ? projectBaseName(workdir) : null, status, outcome, last_client };
    });
    return {
      sessions,
      member_sessions: memberSessions.byRun,
      project: { name: projectBaseName(this.workdir), workdir: this.workdir },
    };
  }

  /**
   * 找出群聊成员的内部会话：ids 是要从会话列表隐藏的全部 id；byRun 把属于
   * 总指挥任务的那些按任务归组（总指挥 run id → 成员会话摘要）。
   */
  private groupMemberSessions(items: { id: string; count: number; mtime: string }[]): {
    ids: Set<string>;
    byRun: Record<string, { id: string; member: string; count: number; mtime: string }[]>;
  } {
    const ids = new Set<string>();
    const byRun: Record<string, { id: string; member: string; count: number; mtime: string }[]> = {};
    const owner = new Map<string, { run: string; member: string }>();
    try {
      for (const run of listChiefRuns(this.home)) {
        for (const m of run.members ?? []) owner.set(`group-${run.room_id}-${m.id}`, { run: run.id, member: m.id });
      }
    } catch { /* 总指挥记录读不了时只隐藏，不归组 */ }
    for (const item of items) {
      if (!isGroupMemberSessionId(item.id)) continue;
      ids.add(item.id);
      const o = owner.get(item.id);
      if (!o) continue;
      (byRun[o.run] ??= []).push({ id: item.id, member: o.member, count: item.count, mtime: item.mtime });
    }
    return { ids, byRun };
  }

  private lastTurnOutcome(sessionId: string): TurnSummary | null {
    try {
      const run = this.runs.get(sessionId);
      let messages: Record<string, unknown>[] | null = run?.agent ? run.agent.messages : null;
      if (messages) return summarizeLastTurn(messages);
      // 落盘会话：按 (mtime, 大小, inode) 缓存汇总结果——列表每次刷新都要最近 40 个会话的
      // outcome，文件没变就不再整份读、整份 JSON 解析（4 MiB 上限不变）。
      const path = sessionPath(sessionId, this.home);
      if (!existsSync(path)) { this.outcomeCache.delete(sessionId); return null; }
      const st = statSync(path);
      if (st.size > 4 * 1024 * 1024) return null;
      const hit = this.outcomeCache.get(sessionId);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return hit.outcome;
      const loaded = loadSession(sessionId, this.home);
      const outcome = loaded ? summarizeLastTurn(loaded) : null;
      this.outcomeCache.delete(sessionId);
      this.outcomeCache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, outcome });
      while (this.outcomeCache.size > 200) {
        const oldest = this.outcomeCache.keys().next().value;
        if (oldest === undefined) break;
        this.outcomeCache.delete(oldest);
      }
      return outcome;
    } catch { return null; }
  }

  private projectsPath(): string {
    return join(this.home, "sessions", "ui-projects.json");
  }

  private loadProjects(): Record<string, string> {
    try {
      const data = JSON.parse(readFileSync(this.projectsPath(), "utf-8")) as Record<string, unknown>;
      if (!data || typeof data !== "object") return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof k === "string" && typeof v === "string" && SESSION_ID_RE.test(k)) out[k] = v;
      }
      return out;
    } catch { return {}; }
  }

  private rememberProject(sessionId: string): void {
    if (this.projectsLock) return;
    this.projectsLock = true;
    try {
      const data = this.loadProjects();
      const workdir = this.workdir;
      if (data[sessionId] === workdir) return;
      data[sessionId] = workdir;
      const entries = Object.entries(data);
      const trimmed = entries.length > MAX_PROJECT_ENTRIES
        ? Object.fromEntries(entries.slice(-MAX_PROJECT_ENTRIES)) : data;
      const path = this.projectsPath();
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(trimmed), "utf-8");
      renameSync(tmp, path);
    } catch { /* 分组是装饰性的，失败不影响运行 */ }
    finally { this.projectsLock = false; }
  }

  /**
   * 缺口 30：网关入口的成本口径。此前 `nyra ui` 起的 agent 完全不接
   * maxCostUsd / monthlyCostLimitUsd，Web UI 一跑就等于绕过 `--max-cost`——
   * 硬顶只对 CLI 生效，那不叫硬顶。
   *
   * 与 cli.buildAgent 同语义：单价按 config.pricing 解析（未配置则金额未知，不编造），
   * 月度上限 = 配置值（网关没有 CLI 覆盖），本月已花 = 账本里的 LLM + MCP 花费。
   */
  private costOptions(): {
    maxCostUsd: number | null;
    pricing: ReturnType<typeof resolvePricing>;
    monthlyCostLimitUsd: number | null;
    monthlySpentBeforeUsd: (() => { spentUsd: number; incomplete: boolean } | null) | null;
  } {
    const cfg = this.config as Record<string, unknown>;
    const limit = typeof cfg.max_cost_usd === "number" ? cfg.max_cost_usd : null;
    // provider 解析可能失败（未配 key / 无 providerFactory）：单价未知不影响封顶，
    // 但不能让 costOptions 自己抛错——否则 send 直接起不来。
    let model: string | null = null;
    try {
      model = this.provider().model ?? null;
    } catch {
      model = this.model ?? null;
    }
    const monthlyLimit = resolveMonthlyLimit(cfg, null);
    const ledger = new UsageLedger(this.home);
    const spentBefore = monthlyLimit === null ? null : (): { spentUsd: number; incomplete: boolean } | null => {
      try {
        const llm = ledger.monthTotal(monthKeyString());
        const mcp = new McpCostTracker(this.home).monthTotalUsd(monthKeyString());
        return { spentUsd: llm.spentUsd + mcp, incomplete: llm.incomplete };
      } catch {
        return null; // 账本读不了就不封顶，不假装
      }
    };
    return {
      maxCostUsd: limit,
      pricing: resolvePricing(cfg.pricing, model),
      monthlyCostLimitUsd: monthlyLimit,
      monthlySpentBeforeUsd: spentBefore,
    };
  }

  /**
   * P0-3：月度预算摘要（设置页与会话视图共用）：上限、本月已花、是否已
   * 明确选定、下次重置日。账本读失败时已花记 null，不当 0 用。
   */
  budgetSummary(): Record<string, unknown> {
    const cfg = this.config as Record<string, unknown>;
    let spent: number | null = null;
    let incomplete = false;
    try {
      const ledger = new UsageLedger(this.home);
      const llm = ledger.monthTotal(monthKeyString());
      const mcp = new McpCostTracker(this.home).monthTotalUsd(monthKeyString());
      spent = llm.spentUsd + mcp;
      incomplete = llm.incomplete;
    } catch { spent = null; }
    return {
      monthly_cost_limit_usd: resolveMonthlyLimit(cfg, null),
      monthly_cost_limit_decided: monthlyCapDecided(cfg),
      monthly_spent_usd: spent,
      monthly_spent_incomplete: incomplete,
      monthly_reset_at: nextMonthlyResetDate(),
    };
  }

  /** 缺口 30：把网关运行的用量增量写进账本（热力图与月度硬顶的事实源）。 */
  private flushUsageToLedger(run: SessionRun, kind: string, data: Record<string, unknown>): void {
    try {
      if (kind === "usage" || kind === "cost_update") {
        const agent = run.agent;
        if (!agent) return;
        const snap = agent.usage.snapshot();
        const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
        const rec = new UsageLedger(this.home).recordDelta(
          snap, run.lastLedgerSnapshot ?? null, spent, run.lastLedgerSpent ?? null, agent.provider.model,
        );
        run.lastLedgerSnapshot = snap;
        run.lastLedgerSpent = spent;
        void rec;
      }
    } catch { /* 账本写失败绝不破坏运行 */ }
  }
  record(run: SessionRun, kind: string, data: Record<string, unknown>): void {
    this.flushUsageToLedger(run, kind, data);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === "content" || key === "result") clean[key] = clip(value);
      else if (key === "arguments") clean[key] = value && typeof value === "object" ? value : clip(value, 1000);
      else clean[key] = value;
    }
    run.events.push({ seq: run.events.length, type: kind, data: clean, ts: Date.now() / 1000 });
  }

  info(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      version: VERSION, mode: this.mode, modes: [...VALID_MODES], workdir: this.workdir,
      shell: this.shell, platform: process.platform,
    };
    try {
      const prov = this.provider();
      out.provider = (prov as unknown as { name?: string }).name ?? "?";
      out.model = (prov as unknown as { model?: string }).model ?? "?";
      const has = (prov as unknown as { hasCredentials?: () => boolean }).hasCredentials;
      out.provider_desc = `${out.provider} / ${out.model}`;
      out.credentials = typeof has === "function" ? has.call(prov) : true;
      const switches = (prov as unknown as { switches?: unknown[] }).switches;
      if (switches) out.model_switches = switches;
      const chain = (prov as unknown as { providers?: { name?: string }[] }).providers;
      out.fallback_chain = Array.isArray(chain) && chain.length
        ? chain.map((p) => p.name ?? "?") : [out.provider];
    } catch (err) {
      out.provider = null; out.model = null; out.provider_desc = "";
      out.credentials = false; out.provider_error = err instanceof Error ? err.message : String(err);
      out.fallback_chain = [];
    }
    const presets = getProviderPresets(this.config);
    out.keys = Object.entries(presets).map(([name, preset]) => ({
      provider: name, env: preset.envKey ?? null,
      configured: Boolean(preset.envKey && process.env[preset.envKey]),
      connector: Boolean((preset as unknown as { connector?: boolean }).connector),
      needs_key: preset.envKey !== undefined && preset.envKey !== null && name !== "ollama",
    }));
    out.config = {
      max_turns: this.config.max_turns ?? null,
      context_window_tokens: this.contextWindowTokens,
      auto_compact_enabled: this.autoCompactEnabled,
      auto_compact_threshold: this.autoCompactThreshold,
      mcp_enabled: Boolean(this.config.mcp_enabled ?? false),
      sandbox: (this.config.sandbox as string) || "local",
      profiles: Object.keys((this.config.profiles as Record<string, unknown>) ?? {}).sort(),
    };
    out.mcp_tools = this.mcpManager ? this.mcpManager.toolSchemas.length : 0;
    // P0-3：桌面页启动时按这里的语言渲染（未设时跟随系统）；月度预算摘要
    // 供状态栏显示“未选月度上限”提示用（每 15 秒随 loadInfo 刷新）。
    out.language = typeof this.config.language === "string" ? this.config.language : null;
    out.budget = this.budgetSummary();
    out.providers = Object.entries(presets).map(([name, preset]) => ({
      provider: name, model: preset.defaultModel ?? null, env_key: preset.envKey ?? null,
    }));
    out.provider_count = Object.keys(presets).length;
    out.tools = TOOL_SCHEMAS.filter((s) => {
      const fn = (s as Record<string, unknown>).function as Record<string, unknown> | undefined;
      return fn && typeof fn.name === "string" && !fn.name.startsWith("poppy_");
    }).map((s) => {
      const fn = (s as Record<string, unknown>).function as Record<string, unknown>;
      return { name: fn.name, description: fn.description ?? "", needs_approval: MUTATING_TOOLS.has(fn.name as string) };
    });
    out.tool_count = (out.tools as unknown[]).length;
    try {
      out.skills = loadSkills(canonicalSkillDirs(this.workdir, this.home, pluginSkillDirs(this.home)))
        .map((s) => ({ name: s.name, description: s.description }));
    } catch { out.skills = []; }
    out.smart_approvals = { reviewer_enabled: reviewerEnabled(this.config) };
    out.mcp_cost = { limit_usd: costLimitUsd(this.config), spent_usd: this.mcpCost.totalUsd() };
    return out;
  }

  setMode(newMode: string): string {
    const mode = validateMode(newMode);
    for (const run of this.runs.values()) {
      if (run.status === "running") throw new Error("有任务正在执行，请完成后再切换模式");
    }
    if (mode === this.mode) return mode;
    if (this.mcpManager) { this.mcpManager.stopAll(); this.mcpManager = null; }
    for (const run of this.runs.values()) {
      if (run.agent) { run.agent.setMode(mode); run.agent.mcpManager = null; }
    }
    this.mode = mode;
    void this.ensureMcpManager();
    for (const run of this.runs.values()) {
      if (run.agent) run.agent.mcpManager = this.mcpManager;
    }
    return mode;
  }

  setProvider(name: string, model?: string | null): Record<string, unknown> {
    const presets = getProviderPresets(this.config);
    if (!presets[name]) throw new Error(`未知的 provider：${name}`);
    this.providerName = name;
    this.model = model ?? null;
    this.providerInstance = null;
    const prov = this.provider();
    for (const run of this.runs.values()) {
      if (run.agent) run.agent.provider = prov;
    }
    return {
      provider: (prov as unknown as { name?: string }).name ?? name,
      model: (prov as unknown as { model?: string }).model ?? model ?? null,
    };
  }

  async ensureMcpManager(): Promise<MCPToolManager | null> {
    if (this.mcpManager) return this.mcpManager;
    // 与 Python webui/server 一致：auto/readonly 不启动 MCP 子进程；
    // full 是显式 opt-in。网页端不能批准本地 MCP 进程启动。
    if (this.mode !== "full") return null;
    if (!this.config.mcp_enabled) return null;
    // MCP 服务器进程走网关同一沙箱配置（sandboxSettings 已做 fail-closed
    // 校验）；沙箱不可用时 buildMcpManager 抛错，服务器不启动——与 shell
    // 工具的 fail-closed 口径一致。工作目录是网关工作区。
    const manager = await buildMcpManager({
      mode: this.mode, interactive: false, config: this.config,
      sandbox: this.sandboxSettings(), workdir: this.workdir,
    });
    this.mcpManager = manager;
    return manager;
  }

  pendingApprovals(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const [id, { run, pending }] of this.approvals) {
      out.push({
        id, session: run.sessionId, tool: pending.tool, summary: pending.summary, always: pending.always,
        command: pending.command ?? null, suggestion: pending.suggestion ?? null,
        // P0-3：审批卡倒计时用——过期时刻与等待秒数，界面据此写明“约 10 分钟内不处理将自动拒绝”。
        expires_at: new Date(pending.createdAt + APPROVAL_TIMEOUT * 1000).toISOString(),
        timeout_seconds: APPROVAL_TIMEOUT,
      });
    }
    return out;
  }

  // -- approval (smart approvals 接入点) ----------------------------------
  private async approve(run: SessionRun, tool: string, summary: string, details?: Record<string, unknown>): Promise<ApproveResult> {
    const command = typeof details?.command === "string" ? details.command : null;
    const decision = await decideSmartApproval({
      tool, summary, command,
      config: this.config,
      reviewer: this.reviewer(),
      reviewerModelName: smartApprovalConfig(this.config).reviewer_model ?? smartApprovalConfig(this.config).reviewer_provider ?? null,
      home: this.home,
    });
    if (decision.verdict === "DENY") {
      this.record(run, "approval_result", { tool, approved: false, always: false, timeout: false, tier: decision.tier, reason: decision.reason });
      return false;
    }
    if (decision.verdict === "APPROVE") {
      this.record(run, "approval_result", { tool, approved: true, always: false, timeout: false, tier: decision.tier, reason: decision.reason });
      return true;
    }
    // ESCALATE → 挂起等人工（评审模型默认关时也走这里，与第 2 阶段二值审批一致）。
    const approvalId = randomBytes(8).toString("hex");
    const canAlways = SESSION_GRANT_TOOLS.has(tool);
    const rawSuggestion = details?.suggestion;
    const suggestion = rawSuggestion && typeof rawSuggestion === "object" ? rawSuggestion as RuleSuggestion : null;
    let resolveFn: (v: ApproveResult) => void = () => {};
    const waiter = new Promise<ApproveResult>((resolve) => { resolveFn = resolve; });
    const pending: PendingApproval = {
      id: approvalId, tool, summary, always: canAlways, command, suggestion, decision: null, resolve: resolveFn,
      createdAt: Date.now(),
    };
    this.approvals.set(approvalId, { run, pending });
    run.pending = pending;
    this.record(run, "approval", { id: approvalId, tool, summary, always: canAlways, command, suggestion, tier: decision.tier, reason: decision.reason });
    let timedOut = false;
    const timer = setTimeout(() => {
      if (this.approvals.has(approvalId)) {
        timedOut = true;
        this.approvals.delete(approvalId);
        if (run.pending === pending) run.pending = null;
        resolveFn(false);
      }
    }, APPROVAL_TIMEOUT * 1000);
    timer.unref?.();
    const decided = await waiter;
    clearTimeout(timer);
    this.approvals.delete(approvalId);
    if (run.pending === pending) run.pending = null;
    if (decided && typeof decided === "object") {
      this.record(run, "approval_result", {
        id: approvalId, approved: decided.approved, always: false, timeout: timedOut,
        scope: decided.scope ?? null, rule: decided.scope ? suggestion?.label ?? null : null,
        feedback: decided.approved ? null : decided.feedback ?? null,
      });
      return decided;
    }
    const approved = decided === APPROVE_ALWAYS ? true : Boolean(decided);
    const always = decided === APPROVE_ALWAYS;
    this.record(run, "approval_result", { id: approvalId, approved, always, timeout: timedOut });
    return decided;
  }

  /**
   * 审批决定。scope = "session" | "project"：允许并按建议规则不再询问（建议为空时拒绝请求，
   * 复合/危险命令只能单次允许）；feedback：拒绝时带回给 agent 的说明。
   */
  decide(approvalId: string, approve: boolean, always = false, opts?: { scope?: unknown; feedback?: unknown }): boolean {
    const item = this.approvals.get(approvalId);
    if (!item) return false;
    const { pending } = item;
    const scope = opts?.scope;
    if (approve && scope !== undefined && scope !== null && scope !== "") {
      if (!RULE_SCOPES.includes(scope as RuleScope)) throw new Error("规则范围只能是 session 或 project");
      if (!pending.suggestion) throw new Error("这个操作不能记成“不再询问”规则（复合或危险命令），请单次允许");
      pending.decision = { approved: true, scope: scope as RuleScope };
      pending.resolve(pending.decision);
      return true;
    }
    if (!approve && typeof opts?.feedback === "string" && opts.feedback.trim()) {
      pending.decision = { approved: false, feedback: opts.feedback.trim().slice(0, MAX_FEEDBACK) };
      pending.resolve(pending.decision);
      return true;
    }
    if (approve && always) {
      if (!pending.always) throw new Error("这个操作不支持“本会话始终允许”，请逐次批准");
      pending.decision = APPROVE_ALWAYS;
    } else {
      pending.decision = Boolean(approve);
    }
    pending.resolve(pending.decision);
    return true;
  }

  // -- sandbox（调研报告第 9 项，网关接线） -------------------------------
  /**
   * 网关沙箱配置：与 CLI buildAgent 同一套来源与优先级——config.json 的
   * sandbox / sandbox_mode / sandbox_allow_net + NYRA_SANDBOX* 环境变量
   *（见 config.resolveSandbox / sandbox.resolveSandboxBackend），不另发明配置键。
   * 这里再做一次 fail-closed 校验（与 CLI 相同）：显式 bwrap 缺失、e2b、
   * danger-full-access + bwrap 时抛错，会话不启动（send 里转成 error 状态）；
   * auto 回落到工具级不报错。默认断网（allowNet=false）。
   * 钩子不在沙箱内跑：PreToolUse/PostToolUse 仍在宿主机上由 tools.ts 触发。
   */
  private sandboxSettings(): { backend: string | null; mode: SandboxMode; allowNet: boolean } {
    const settings = resolveSandbox(this.config);
    resolveSandboxBackend(this.config);
    return { backend: settings.backend, mode: settings.mode as SandboxMode, allowNet: settings.allowNet };
  }

  // -- session hooks（调研报告第 1 项，会话生命周期） ----------------------
  /**
   * 会话钩子触发点（网关侧）：SessionStart 在会话新建（newSession）或首次
   * send 建 Agent 成功后触发；SessionEnd 在逐会话关闭（DELETE /api/sessions/:id，
   * 见 closeSession）或网关关停（stop）时为每个已开始的会话触发。
   * 约定与 CLI 侧一致：超时走 config.json hooks.timeout_ms（runHooks 内
   * clamp 到 1–120 秒，默认 10 秒）；SessionStart/End 是只通知事件，钩子
   * 故障只警告、不影响会话，退出码 2 只通知不拦截；
   * 无钩子时 runHooks 直接返回、不 spawn。SessionStart 不阻塞 HTTP 响应，
   * 以 fire-and-forget 方式触发；SessionEnd 在 stop 里 await，等钩子跑完
   * （有超时封顶）再关停，避免进程退出把钩子杀在半路。
   */
  private fireSessionStart(run: SessionRun): void {
    if (run.hooksStarted) return;
    run.hooksStarted = true;
    void runHooks("SessionStart", { home: this.home, workdir: this.workdir }).catch(() => {
      // SessionStart 是只通知事件，钩子故障只警告；这里再兜一层，绝不影响会话。
    });
  }

  /**
   * 触发一次 SessionEnd。未开始过（hooksStarted 为假）或已触发过时返回 null；
   * 否则返回钩子 Promise，由 stop() 统一 await。
   */
  private fireSessionEnd(run: SessionRun): Promise<void> | null {
    if (!run.hooksStarted || run.hooksEnded) return null;
    run.hooksEnded = true;
    return runHooks("SessionEnd", { home: this.home, workdir: this.workdir }).then(
      () => {},
      () => { /* 同上：钩子故障不破坏关停流程。 */ },
    );
  }

  // -- running ------------------------------------------------------------
  /**
   * H1：记一回合的客户端——审计行（gateway-audit.jsonl）+ 最近客户端账本
   * + 内存里的会话归属（sessionsView 的 last_client 用）。审计写失败不
   * 抛错、不破坏回合本身（recordGatewayRound 内部已吞掉）。
   */
  private noteRoundClient(sessionId: string, who: "owner" | "account" | Record<string, unknown> | null, channel: "session" | "group"): void {
    const ref = describeGatewayClient(who);
    if (!ref) return;
    recordGatewayRound(this.home, { sessionId, client: ref.client, kind: ref.kind, channel });
    this.lastClientBySession.set(sessionId, ref.client);
  }

  send(sessionId: string, text: string, team?: { soulAgent: string; teamId: string; teamEpoch: number | null; display: string }): SessionRun {
    const run = this.getRun(sessionId);
    if (run.status === "running") throw new Error("这个会话正在执行任务，请等它完成");
    run.events = [];
    run.error = "";
    run.interrupted = false;
    run.stopping = false;
    // G-P1-32 对话转人工坐席：会话转人工期间 bot 不再自动回复——这条消息
    // 不建 agent、不调模型，只记事件与收件箱，等真人接手或接回。账本损坏、
    // 状态不明时也不回（fail-closed，见 hitl.ts 的 isBotMutedForSession）。
    if (isBotMutedForSession(this.home, sessionId)) {
      const handoff = activeHandoffForSession(this.home, sessionId);
      run.status = "done";
      this.record(run, "hitl_bot_held", { session: sessionId, handoff: handoff?.id ?? "" });
      try {
        appendInbox(sessionId, "hitl-held", `会话 ${sessionId} 已转人工，有新消息未回（转人工单 ${handoff?.id ?? "未知"}）`, this.home);
      } catch { /* 收件箱失败不破坏静默 */ }
      return run;
    }
    run.status = "running";
    // P0-3：花钱之前先看见上限——月度上限没选定时，付费模型不开始跑。
    // 转人工静默（上面已 return）不调模型，不拦；本地/免 Key 模型不拦。
    try {
      this.requireMonthlyCapDecision();
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
      return run;
    }
    try {
      if (!run.agent) {
        const provider = this.provider();
        run.agent = new Agent(provider, {
          workdir: this.workdir, mode: this.mode, maxTurns: this.maxTurns ?? 20,
          sessionId, interactive: true, initiator: "gateway",
          messages: loadSession(sessionId, this.home),
          // 总指挥团队分派（POST /api/teams/:id/dispatch）：Soul = 参谋长、团队模式 chief 角色（工具只剩
          // delegate / delegate_parallel，见 team.ts ORCHESTRATOR_TOOLS）；成员的对外动作照常走下面的审批桥。
          ...(team ? { soulAgent: team.soulAgent, teamId: team.teamId, teamRole: "chief" as const, teamEpoch: team.teamEpoch } : {}),
          mcpManager: this.mcpManager,
          onEvent: (kind, data) => this.record(run, kind, data),
          approveFn: (tool, summary, details) => this.approve(run, tool, summary, details),
          sessionRules: run.sessionRules ?? (run.sessionRules = new SessionRules()),
          contextWindowTokens: this.contextWindowTokens,
          contextWindowSource: this.contextWindowSource,
          contextWindowModel: this.contextWindowModel,
          autoCompactEnabled: this.autoCompactEnabled,
          autoCompactThreshold: this.autoCompactThreshold,
          // 缺口 10：独立审查层用的模型名（reviewer.model / smart_approvals
          // reviewer_model / 默认 deepseek-flash）。
          reviewerModel: resolveReviewerModel(this.config).model,
          // 缺口 24：多模型工厂 + Plan/Act 分模型 + 辅助任务便宜模型。
          multiModelFactory: this.modelFactory(),
          planActModels: this.planActModels(),
          auxModels: this.auxModels(),
          // 缺口 24：Repo Map + 子 agent 独立推理档位。
          repoMap: (() => {
            const rm = (this.config as Record<string, unknown>).repo_map;
            if (!rm || typeof rm !== "object") return { enabled: false };
            const o = rm as Record<string, unknown>;
            return { enabled: o.enabled === true, tokenBudget: typeof o.token_budget === "number" ? o.token_budget : undefined };
          })(),
          delegateReasoningEffort: typeof this.config.delegate_reasoning_effort === "string" ? this.config.delegate_reasoning_effort : null,
          home: this.home,
          // 单技能启停：网关起的 agent 与 CLI 同口径（config.skills.disabled）。
          skillsDisabled: (() => {
            const sk = (this.config as Record<string, unknown>).skills;
            if (!sk || typeof sk !== "object") return [];
            const d = (sk as Record<string, unknown>).disabled;
            return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
          })(),
          // 缺口 30：成本硬顶与单价（与 CLI 同语义；Web UI 入口不再绕过 --max-cost）。
          ...this.costOptions(),
          // 调研报告第 9 项：OS 级分级沙箱（网关接线）——与 CLI buildAgent 同语义：
          // 配置 + 环境变量解析、fail-closed 校验在 sandboxSettings 里；Agent 再
          // 透传给 ToolContext，shell 执行时由 toolShell 解析生效（含 auto 回落
          // 提示一次、默认断网）。钩子仍在宿主机跑，不进沙箱。
          sandbox: this.sandboxSettings(),
        });
      } else {
        run.agent.setMode(this.mode);
      }
      run.baseMessages = [...run.agent.messages];
    } catch (err) {
      run.status = "error";
      run.error = `无法启动：${err instanceof Error ? err.message : String(err)}`;
      return run;
    }
    // 调研报告第 1 项：经 send 隐式建出的会话（未走 newSession）也在这里补
    // 一次 SessionStart；fireSessionStart 自带去重，只触发一次。
    this.fireSessionStart(run);
    // 设计稿 v8：回复底部的“本轮 token”= 本轮结束时的累计用量 − 这里记下的起点。事件流每轮清空，
    // 所以起点跟着 user 事件一起记；累计用量里有没报用量的调用时界面不显示（missing_calls 对不上）。
    let usageBase: Record<string, unknown> | null = null;
    try {
      const snap = run.agent!.usage.snapshot();
      usageBase = { total_tokens: snap.total_tokens ?? (snap.calls === 0 ? 0 : null), missing_calls: snap.missing_calls };
    } catch { usageBase = null; }
    const shown = team ? team.display : text;
    this.record(run, "user", usageBase ? { content: shown, usage_base: usageBase } : { content: shown });
    try { this.store.record(sessionId, "user", shown); } catch { /* 存档失败不阻塞运行 */ }
    this.rememberProject(sessionId);
    void this.doWork(run, text);
    return run;
  }

  private async doWork(run: SessionRun, text: string): Promise<void> {
    try {
      const provider = run.agent!.provider;
      const has = (provider as unknown as { hasCredentials?: () => boolean }).hasCredentials;
      if (typeof has === "function" && !has.call(provider)) {
        throw new Error("未找到可用的 API 凭据：请设置对应 provider 的环境变量 Key 后重启 ui");
      }
      const finalText = await run.agent!.run(text);
      try { this.store.record(run.sessionId, "assistant", finalText); } catch { /* ignore */ }
      run.status = "done";
      this.gatewayCompactCheck(run);
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      // P0-3：底层落定了才清 stopping（“正在停止”→已停）；因停止取消的
      // 轮次标 interrupted——刷新后会话视图仍能看到是被打断的。
      run.stopping = false;
      if (run.agent?.lastCancelledReason === "stop") run.interrupted = true;
    }
  }

  plan(sessionId: string, text: string): SessionRun {
    const run = this.getRun(sessionId);
    if (run.status === "running") throw new Error("这个会话正在执行任务，请等它完成");
    run.events = [];
    run.error = "";
    run.interrupted = false;
    run.stopping = false;
    run.status = "running";
    run.baseMessages = run.agent ? [...run.agent.messages] : (loadSession(sessionId, this.home) ?? []);
    this.record(run, "user", { content: text, plan: true });
    void (async () => {
      try {
        // P0-3：规划也要调付费模型，花钱之前先看见上限（与 send() 同款门）。
        this.requireMonthlyCapDecision();
        const provider = this.provider();
        // 缺口 24：Plan 阶段用强推理模型（配了 plan_model 时）；没配沿用主模型。
        const planModel = this.planActModels().plan
          ? (() => { try { return this.modelFactory()("plan", this.planActModels().plan!); } catch { return provider; } })()
          : provider;
        const has = (planModel as unknown as { hasCredentials?: () => boolean }).hasCredentials;
        if (typeof has === "function" && !has.call(planModel)) {
          throw new PlanError("未找到可用的 API 凭据：请设置对应 provider 的环境变量 Key 后重启 ui");
        }
        const details = await buildPlan(planModel, text, this.workdir, TOOL_SCHEMAS as Record<string, unknown>[]);
        const body = renderPlan(text, details);
        const digest = savePlan(this.workdir, body);
        this.rememberProject(sessionId);
        this.record(run, "plan_ready", { plan: body, sha256: digest, path: "plan.md" });
        run.status = "done";
      } catch (err) {
        run.status = "error";
        run.error = `规划失败：${err instanceof Error ? err.message : String(err)}`;
      }
    })();
    return run;
  }

  executePlan(sessionId: string, digest: string): SessionRun {
    if (this.mode === "readonly") throw new Error("只读模式不能执行计划，请切换到 auto 或 full 模式");
    const approved = readApprovedPlan(this.workdir, digest);
    return this.send(sessionId, approvedExecutionTask(approved));
  }

  // -- gateway 压缩分层（85%） --------------------------------------------
  /**
   * 网关层压缩检查：用量比 ≥85% 时先剪旧工具结果（不调 LLM）。
   * 返回是否触发、用量比与消息数变化；仍超 85% 时只记事件，
   * 下一轮由 agent 侧 50% 自动压缩接手（不反复调模型）。
   */
  gatewayCompactCheck(run: SessionRun): { triggered: boolean; ratio: number | null; before: number; after: number } {
    const agent = run.agent;
    if (!agent) return { triggered: false, ratio: null, before: 0, after: 0 };
    const snap = agent.usage.snapshot() as unknown as { last_prompt_tokens: number | null; context_window_tokens: number | null };
    const window = snap.context_window_tokens;
    const last = snap.last_prompt_tokens;
    const ratio = window !== null && window !== undefined && last !== null && last !== undefined && window > 0
      ? last / window : null;
    if (ratio === null || ratio < GATEWAY_COMPACT_THRESHOLD) {
      return { triggered: false, ratio, before: agent.messages.length, after: agent.messages.length };
    }
    const before = agent.messages.length;
    const trimmed = trimOldToolResults(agent.messages as never);
    const changed = JSON.stringify(trimmed) !== JSON.stringify(agent.messages);
    if (changed) {
      agent.messages = trimmed as unknown as Record<string, unknown>[];
      saveSession(agent.sessionId, agent.messages, this.home);
    }
    this.record(run, "gateway_compact", {
      method: changed ? "trim_tool_results" : "none",
      ratio, before, after: agent.messages.length,
      still_above_threshold: ratio >= GATEWAY_COMPACT_THRESHOLD,
    });
    return { triggered: true, ratio, before, after: agent.messages.length };
  }

  // -- rewind ---------------------------------------------------------------
  rewindSession(sessionId: string, messageId: number, action: RewindAction, text?: string | null): Record<string, unknown> {
    const result = doRewind(this.store, sessionId, messageId, action, text ?? null);
    const run = this.getRun(sessionId, false);
    if (result.action !== "fork") {
      // live 会话与会话文件按同一份存档重建，保证三端看到的历史一致。
      const rows = this.store.history(sessionId, 100000);
      const messages = storeHistoryToAgentMessages(rows);
      if (run?.agent) run.agent.messages = messages;
      saveSession(sessionId, messages, this.home);
      if (run) {
        run.baseMessages = [...messages];
        this.record(run, "rewind", { action: result.action, message_id: messageId, kept: result.kept, deleted: result.deleted });
      }
    } else if (result.new_session_id) {
      const rows = this.store.history(result.new_session_id, 100000);
      const messages = storeHistoryToAgentMessages(rows);
      saveSession(result.new_session_id, messages, this.home);
      this.getRun(result.new_session_id);
    }
    return { ...result };
  }

  storeHistory(sessionId: string): Record<string, unknown>[] {
    return this.store.history(sessionId, 100000).map((r) => ({
      id: r.id, role: r.role, text: r.text, tool_name: r.tool_name, created_at: r.created_at,
    }));
  }

  // -- MCP（含成本） ----------------------------------------------------------
  mcpTools(): Record<string, unknown>[] {
    if (!this.mcpManager) return [];
    return this.mcpManager.toolSchemas.map((s) => {
      const name = s.function.name;
      const route = this.mcpManager!.routeFor(name);
      const server = route ? route[0] : "";
      const rawTool = route ? route[1] : name;
      const est = estimateToolCost(this.config, server, rawTool);
      const limit = costLimitUsd(this.config);
      const spent = this.mcpCost.totalUsd();
      return {
        name, description: s.function.description, server, tool: rawTool,
        estimate_usd: est.estimate_usd, priced: est.priced, source: est.source,
        limit_usd: limit, spent_usd: spent,
        estimate_line: this.mcpCost.estimateLine(this.config, server, rawTool),
      };
    });
  }

  async mcpCall(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.mcpManager) throw new Error("MCP 未启用或无可用服务器");
    const route = this.mcpManager.routeFor(toolName);
    if (!route) throw new Error(`错误：未知 MCP 工具 ${toolName}`);
    const [server, rawTool] = route;
    const estimateLine = this.mcpCost.estimateLine(this.config, server, rawTool);
    const check = this.mcpCost.checkBeforeCall(this.config, server, rawTool);
    if (check.blocked) {
      this.mcpCost.record(server, rawTool, check.estimate_usd, "blocked_over_limit");
      throw new Error(check.blocked);
    }
    const result = await this.mcpManager.execute(toolName, args);
    const failed = result.startsWith("MCP 调用失败") || result.startsWith("错误：");
    const rec = this.mcpCost.record(server, rawTool, check.estimate_usd, failed ? "failed" : "called");
    return { ok: !failed, result, estimate_usd: check.estimate_usd, estimate_line: estimateLine, total_usd_after: rec.total_usd_after };
  }

  // -- schedule ---------------------------------------------------------------
  scheduleList(): ScheduleTask[] {
    return listScheduleTasks(loadSchedule(schedulePath(this.home)));
  }

  scheduleAction(action: string, name: string): Record<string, unknown> {
    const data = loadSchedule(schedulePath(this.home));
    if (action === "add") {
      throw Object.assign(new Error("网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；请用 nyra schedule add 命令添加"), { status: 409 });
    }
    if (action === "toggle") {
      for (const task of data.tasks) {
        if (task.name === name) {
          task.enabled = !(task.enabled ?? true);
          saveSchedule(data, schedulePath(this.home));
          return { task };
        }
      }
      throw Object.assign(new Error("任务不存在"), { status: 404 });
    }
    if (action === "remove") {
      if (removeScheduleTask(data, name)) {
        saveSchedule(data, schedulePath(this.home));
        return { ok: true };
      }
      throw Object.assign(new Error("任务不存在"), { status: 404 });
    }
    throw Object.assign(new Error("未知的操作"), { status: 400 });
  }

  /** 定时任务守护：到期任务用主 provider（不走兜底链）跑，结果进 inbox。 */
  startScheduler(intervalSeconds = 60): void {
    if (this.schedulerTimer) return;
    const tick = async () => {
      let data;
      try { data = loadSchedule(schedulePath(this.home)); } catch { return; }
      try {
        const results = await runDueTasks(data, async (task) => {
          const agent = new Agent(this.primaryProvider(), {
            workdir: this.workdir, mode: this.mode, maxTurns: this.maxTurns ?? 20,
            sessionId: `schedule-${task.name}`, interactive: false, home: this.home, initiator: "cron",
            // 缺口 30：定时任务是无人值守入口，更要受成本硬顶约束。
            ...this.costOptions(),
            mcpManager: null,
            // 调研报告第 9 项：定时任务用的 Agent 也接沙箱（与 send 同一套解析；
            // 配置非法时这里抛错，tick 的 catch 会记日志，任务不裸奔执行）。
            sandbox: this.sandboxSettings(),
            // 缺口 10：定时任务同样过独立审查（无人值守入口更要第二双眼睛）。
            reviewerModel: resolveReviewerModel(this.config).model,
          });
          const out = await agent.run(task.prompt);
          appendInbox(`schedule-${task.name}`, "ok", out.slice(0, 200), this.home);
          return out;
        });
        saveSchedule(data, schedulePath(this.home));
        // 缺口 3b：跑成功的定时任务结果进审阅队列（Automations → review queue），
        // 手机 PWA 的“审阅”标签页就是批复面；入队失败不破坏 tick（只记日志），
        // 队列本身 fail-closed：不批就不放行。
        try {
          enqueueAutomationResults(this.home, results);
        } catch (err) {
          process.stderr.write(`审阅队列入队失败：${err instanceof Error ? err.message : String(err)}\n`);
        }
      } catch (err) {
        process.stderr.write(`定时任务执行失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
    };
    this.schedulerTimer = setInterval(() => { void tick(); }, intervalSeconds * 1000);
    this.schedulerTimer.unref?.();
    void tick();
  }

  stopScheduler(): void {
    if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
  }

  // -- “允许并不再询问”规则 ---------------------------------------------------
  /** 本项目的持久规则 + （给了会话时）该会话的本会话规则。 */
  rulesView(sessionId: string | null): Record<string, unknown> {
    const project = new RuleStore(this.home).list(this.workdir);
    const session: unknown[] = [];
    for (const run of this.runs.values()) {
      if (sessionId !== null && run.sessionId !== sessionId) continue;
      for (const rule of run.sessionRules?.list() ?? []) session.push({ ...rule, session: run.sessionId });
    }
    return { project: normalizeProject(this.workdir), rules: [...session, ...project] };
  }

  revokeRule(ruleId: string): boolean {
    if (ruleId.startsWith("s-")) {
      for (const run of this.runs.values()) if (run.sessionRules?.remove(ruleId)) return true;
      return false;
    }
    return new RuleStore(this.home).remove(ruleId, this.workdir);
  }

  // -- 桌面端：首次引导 / API Key / 设置（src/webuiDesktop.ts 消费） ---------------------
  /** 需要 Key 的 provider 清单 + 每个的 Key 来源（只给掩码）。密码箱只开一次（PBKDF2 很贵）。 */
  keysView(): Record<string, unknown> {
    const presets = getProviderPresets(this.config);
    const vault = openVault(this.home);
    const vstate = { exists: vaultState(this.home).exists, unlocked: vault !== null };
    const providers = Object.entries(presets).map(([name, preset]) => {
      const local = name === "ollama" || preset.auth === "cli";
      const status = local ? { source: "none_needed", masked: "" } : keyStatus(preset.envKey, this.home, vault);
      return {
        provider: name, env_key: local ? null : preset.envKey ?? null, needs_key: !local && Boolean(preset.envKey),
        default_model: preset.defaultModel ?? null, models: [...(preset.models ?? [])],
        base_url: preset.baseUrl ?? null, local, ...status,
      };
    });
    return { providers, vault: vstate, storage: vault ? "vault" : "file" };
  }

  /** 首次引导：当前 provider 没有可用 Key（且不是本地/CLI provider）时 needs_setup。 */
  setupView(): Record<string, unknown> {
    const info = this.info();
    const keys = this.keysView();
    return {
      needs_setup: !info.credentials,
      provider: info.provider ?? null, model: info.model ?? null,
      provider_error: info.provider_error ?? null,
      ...keys,
    };
  }

  saveKey(provider: string, key: unknown): Record<string, unknown> {
    const preset = getProviderPresets(this.config)[provider];
    if (!preset) throw new Error(`未知的 provider：${provider}`);
    if (!preset.envKey || provider === "ollama" || preset.auth === "cli") throw new Error("这个 provider 不使用 API Key");
    // H5：界面保存 Key 是模型 Key 入口——OAuth 形状的串在这里就拦住（Bot
    // 电脑凭证不走这里，见 keystore.ts 的 validateProviderKey）。
    const saved = setKey(preset.envKey, validateProviderKey(key), this.home);
    this.providerInstance = null; // 下次用到时按新 Key 重建
    for (const run of this.runs.values()) {
      if (run.agent && run.status !== "running") { try { run.agent.provider = this.provider(); } catch { /* 还没配好也不拦 */ } }
    }
    return { provider, env_key: preset.envKey, ...saved, status: keyStatus(preset.envKey, this.home) };
  }

  deleteKey(provider: string): boolean {
    const preset = getProviderPresets(this.config)[provider];
    if (!preset || !preset.envKey) return false;
    const ok = removeKey(preset.envKey, this.home);
    this.providerInstance = null;
    return ok;
  }

  /**
   * 测试连接：真的请求一次 provider 的 GET {base_url}/models（OpenAI 兼容）。
   * key 不给时用已保存的。返回只含掩码；错误信息里的 Key 一律替换掉。
   */
  async testKey(provider: string, key: unknown, model?: string | null): Promise<Record<string, unknown>> {
    const presets = getProviderPresets(this.config);
    if (!presets[provider]) throw new Error(`未知的 provider：${provider}`);
    const resolved: ResolvedProvider = resolveProvider({ home: this.home, config: this.config, providerName: provider, model: model ?? undefined });
    if (resolved.auth === "cli") return { ok: true, provider, masked: "", detail: "cli" };
    let apiKey = resolved.apiKey;
    // H5：网关测 Key 是模型 Key 入口——OAuth 形状的串在这里就拦住，不发出去才发现。
    if (typeof key === "string" && key.trim()) apiKey = validateProviderKey(key);
    const needsKey = provider !== "ollama" && Boolean(resolved.envKey);
    if (needsKey && !apiKey) return { ok: false, provider, masked: "", status: null, error: "还没有 API Key" };
    const cfg: ResolvedProvider = { ...resolved, apiKey, auth: apiKey ? "env" : "none", hasKey: true, keySource: resolved.keySource };
    const masked = maskKey(apiKey);
    const scrub = (text: string): string => (apiKey ? text.split(apiKey).join("[已隐藏]") : text);
    const started = Date.now();
    try {
      const models = await new Provider(cfg).listModels(15);
      return { ok: true, provider, masked, models: models.length, model_found: models.includes(cfg.model), ms: Date.now() - started };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: unknown })?.status;
      // Ollama 没启动是最常见的失败：只报“网络错误”用户不知道怎么办，直接写清。
      const hint = provider === "ollama" ? "（Ollama 可能没启动：先在终端跑 ollama serve，再点一次「测试连接」）" : "";
      return { ok: false, provider, masked, status: typeof status === "number" ? status : null, error: scrub(msg + hint).slice(0, 300) };
    }
  }

  /** 设置页的通用 + 上下文开关（真后端：读写 config.json，与命令行共用）。 */
  settingsView(): Record<string, unknown> {
    const cfg = this.config;
    const toolSearch = (cfg.tool_search && typeof cfg.tool_search === "object") ? cfg.tool_search as Record<string, unknown> : {};
    const savedMode = typeof cfg.mode === "string" && (cfg.mode === "readonly" || cfg.mode === "auto") ? cfg.mode : "auto";
    let servers: Record<string, unknown>[] = [];
    try {
      const all = loadMcpServers(cfg);
      const routes = new Map<string, number>();
      if (this.mcpManager) {
        for (const s of this.mcpManager.toolSchemas) {
          const r = this.mcpManager.routeFor(s.function.name);
          if (r) routes.set(r[0], (routes.get(r[0]) ?? 0) + 1);
        }
      }
      const custom = (cfg.mcp_servers && typeof cfg.mcp_servers === "object") ? Object.keys(cfg.mcp_servers as object) : [];
      servers = Object.values(all).map((srv) => ({
        name: srv.name, command: srv.command.split(/[\\/]/).pop() ?? srv.command,
        preset: !custom.includes(srv.name), connected: routes.has(srv.name), tools: routes.get(srv.name) ?? 0,
      }));
    } catch { servers = []; }
    return {
      general: {
        default_mode: savedMode, current_mode: this.mode,
        max_turns: typeof cfg.max_turns === "number" ? cfg.max_turns : 20,
        reasoning_effort: typeof cfg.reasoning_effort === "string" ? cfg.reasoning_effort : null,
        language: typeof cfg.language === "string" ? cfg.language : null,
        update_check_enabled: cfg.update_check_enabled === true,
      },
      context: {
        auto_compact_enabled: this.autoCompactEnabled,
        auto_compact_threshold: this.autoCompactThreshold,
        tool_search_enabled: Boolean(toolSearch.enabled),
        context_window_tokens: this.contextWindowTokens,
        context_window_source: this.contextWindowSource,
      },
      model: {
        default_provider: typeof cfg.provider === "string" ? cfg.provider : null,
        default_model: effectiveModelFor(cfg, typeof cfg.provider === "string" ? cfg.provider : "deepseek"),
      },
      mcp: { enabled: Boolean(cfg.mcp_enabled), active: Boolean(this.mcpManager), mode_allows: this.mode === "full", servers },
      // P0-3：月度预算（设置页“通用”分区用）：上限、本月已花、是否已明确选定、下次重置日。
      budget: this.budgetSummary(),
      paths: { home: this.home, config: configPath(this.home), keys: keysPath(this.home) },
    };
  }

  /** 改设置：只收白名单字段，逐个校验；写回 config.json 并在本进程立即生效。 */
  applySettings(body: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if ("default_mode" in body) {
      const m = String(body.default_mode);
      if (m !== "readonly" && m !== "auto") throw new Error("默认模式只能是 readonly 或 auto（完全访问不保存为默认）");
      patch.mode = m;
    }
    if ("max_turns" in body) {
      const n = Number(body.max_turns);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("max_turns 必须是 1–200 的整数");
      patch.max_turns = n;
    }
    if ("reasoning_effort" in body) {
      const v = body.reasoning_effort;
      if (v !== null && !["minimal", "low", "medium", "high", "xhigh"].includes(String(v))) throw new Error("reasoning_effort 只允许 minimal|low|medium|high|xhigh 或 null");
      patch.reasoning_effort = v === null ? null : String(v);
    }
    if ("language" in body) {
      const v = body.language;
      if (v !== null && v !== "zh" && v !== "en") throw new Error("language 只允许 zh、en 或 null（跟随系统）");
      patch.language = v;
    }
    if ("auto_compact_enabled" in body) {
      if (typeof body.auto_compact_enabled !== "boolean") throw new Error("auto_compact_enabled 必须是 true/false");
      patch.auto_compact_enabled = body.auto_compact_enabled;
    }
    if ("auto_compact_threshold" in body) {
      patch.auto_compact_threshold = validateAutoCompactThreshold(Number(body.auto_compact_threshold));
    }
    if ("tool_search_enabled" in body) {
      if (typeof body.tool_search_enabled !== "boolean") throw new Error("tool_search_enabled 必须是 true/false");
      const cur = (this.config.tool_search && typeof this.config.tool_search === "object") ? this.config.tool_search as Record<string, unknown> : {};
      patch.tool_search = { top_k: 12, ...cur, enabled: body.tool_search_enabled };
    }
    if ("mcp_enabled" in body) {
      if (typeof body.mcp_enabled !== "boolean") throw new Error("mcp_enabled 必须是 true/false");
      patch.mcp_enabled = body.mcp_enabled;
    }
    if ("update_check_enabled" in body) {
      // 更新检查 opt-in：默认关闭；只有显式 true 时 `nyra update-check` 才联网。
      if (typeof body.update_check_enabled !== "boolean") throw new Error("update_check_enabled 必须是 true/false");
      patch.update_check_enabled = body.update_check_enabled;
    }
    if ("default_provider" in body) {
      const name = String(body.default_provider);
      const presets = getProviderPresets(this.config);
      if (!presets[name]) throw new Error(`未知的 provider：${name}`);
      patch.provider = name;
      const model = typeof body.default_model === "string" && body.default_model.trim() ? body.default_model.trim().slice(0, 180) : presets[name].defaultModel ?? null;
      patch.model = model;
    }
    if ("monthly_cost_limit_usd" in body) {
      // P0-3：月度上限必选其一——数字（≥0）或明确的 null（不设上限）。
      // 只要这个键出现，就算“已明确选定”（monthly_cost_limit_decided 记
      // true）；不传这个键时不改旧值、不算选过。空串、NaN、负数都拒绝。
      const v = body.monthly_cost_limit_usd;
      if (v !== null) {
        const n = Number(v);
        if (v === "" || !Number.isFinite(n) || n < 0) throw new Error("monthly_cost_limit_usd 必须是大于等于 0 的数字，或 null（不设上限）");
        patch.monthly_cost_limit_usd = n;
      } else {
        patch.monthly_cost_limit_usd = null;
      }
      patch.monthly_cost_limit_decided = true;
    }
    const unknown = Object.keys(body).filter((k) => ![
      "default_mode", "max_turns", "reasoning_effort", "language", "auto_compact_enabled", "auto_compact_threshold",
      "tool_search_enabled", "mcp_enabled", "default_provider", "default_model",
      "monthly_cost_limit_usd", "update_check_enabled",
    ].includes(k));
    if (unknown.length) throw new Error(`不支持的设置项：${unknown.join(", ")}`);
    if (!Object.keys(patch).length) throw new Error("没有要保存的设置");
    saveConfig(this.home, patch);
    Object.assign(this.config, patch);
    if ("auto_compact_enabled" in patch) this.autoCompactEnabled = Boolean(patch.auto_compact_enabled);
    if ("auto_compact_threshold" in patch) this.autoCompactThreshold = patch.auto_compact_threshold as number;
    if ("provider" in patch) {
      try { this.setProvider(String(patch.provider), (patch.model as string | null) ?? null); } catch { /* 默认值已保存；当前运行沿用原 provider */ }
    }
    return this.settingsView();
  }

  // -- pairing ------------------------------------------------------------------
  startPairing(): Record<string, unknown> {
    if (!this.pairOrigin) {
      throw new PairingError("网页界面只监听本机（127.0.0.1），手机连不上。请用 nyra ui --pair 重新启动");
    }
    const info = this.devices.startPairing();
    const url = `${this.pairOrigin}/m#pair=${info.code}`;
    // 二维码本机生成（src/qrcode.ts），内容就是带配对码的 /m 链接（码在 # 后，不发给服务器日志）。
    let qrSvgText: string | null = null;
    try { qrSvgText = qrSvg(qrEncode(url, "M"), { title: "Nyra 配对二维码" }); } catch { qrSvgText = null; }
    return { ...info, url, qr_svg: qrSvgText };
  }

  // -- HTTP -----------------------------------------------------------------------
  async start(): Promise<{ host: string; port: number; url: string }> {
    // 界面保存在 keys.json 里的 Key：密码箱此刻已解锁就搬进密码箱（只搬一次，失败不拦启动）。
    try { migrateKeysToVault(this.home); } catch { /* ignore */ }
    await this.ensureMcpManager();
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    if (!isLoopbackHost(this.host)) {
      try { this.discoverySocket = startDiscoveryResponder({ httpPort: this.port, name: "Nyra" }); } catch { /* 发现端口被占不阻塞启动 */ }
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
    const shownHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    if (this.pairOrigin && this.host === "0.0.0.0") {
      const lan = lanIPv4();
      this.pairOrigin = `http://${lan ?? this.host}:${this.port}`;
    }
    return { host: shownHost, port: this.port, url: this.gatewayUrl() };
  }

  gatewayUrl(): string {
    const shown = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    const host = shown.includes(":") ? `[${shown}]` : shown;
    return `http://${host}:${this.port}?token=${this.token}`;
  }

  urlJson(): Record<string, unknown> {
    const shown = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    return {
      // nyra 固定为 "ui"：桌面端外壳（desktop/src-tauri/src/lib.rs 的
      // parse_start_line）只认这个值，Python 版 url_json() 也是 "ui"。
      nyra: "ui", version: VERSION,
      url: this.gatewayUrl(), host: shown, port: this.port, token: this.token,
    };
  }

  // -- HTTP 路由 ------------------------------------------------------------
  private hostOk(req: IncomingMessage): boolean {
    if (!isLoopbackHost(this.host)) return true;
    const host = (req.headers.host ?? "").trim().toLowerCase();
    const name = host.startsWith("[")
      ? host.split("]", 1)[0] + "]"
      : host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
    return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  }

  /**
   * 电脑端自己的 token（启动时随机生成、打印在本机终端/桌面外壳里）只认来自回环地址的连接：
   * 监听局域网（--pair / --host）时，别的主机就算拿到这个 token 也不算数。
   * 手机等已配对设备走各自的设备 token（device()），不受这条限制。
   */
  private tokenOk(req: IncomingMessage): boolean {
    if (!isLoopbackPeer(req.socket?.remoteAddress)) return false;
    const supplied = req.headers["x-nyra-token"] ?? req.headers["x-angel-token"] ?? "";
    if (!supplied || typeof supplied !== "string") return false;
    const a = Buffer.from(supplied, "utf-8");
    const b = Buffer.from(this.token, "utf-8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** 页面/manifest/icon 允许 ?token=；API 一律只认请求头。 */
  private pageTokenOk(req: IncomingMessage): boolean {
    if (this.tokenOk(req)) return true;
    if (!isLoopbackPeer(req.socket?.remoteAddress)) return false;
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const q = url.searchParams.get("token") ?? "";
      if (!q) return false;
      const a = Buffer.from(q, "utf-8");
      const b = Buffer.from(this.token, "utf-8");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  }

  private device(req: IncomingMessage): Record<string, unknown> | null {
    const supplied = req.headers["x-nyra-token"];
    if (typeof supplied !== "string" || !supplied) return null;
    return this.devices.authenticate(supplied) as Record<string, unknown> | null;
  }

  /** 返回 "owner" | device | account | null；null 表示未通过鉴权。 */
  private async apiAuth(req: IncomingMessage): Promise<"owner" | "account" | Record<string, unknown> | null> {
    if (this.tokenOk(req)) return "owner";
    const d = this.device(req);
    if (d) return d;
    // 缺口 41 下一批：账号会话 token（登录后发的 token，代表"人"）。owner 角色
    // 的账号等同 owner（返回 "owner"）；user 角色只读（返回 "account"）。
    const acct = await this.accountFromSession(req);
    if (!acct) return null;
    return acct.role === "owner" ? "owner" : "account";
  }

  /** 用账号会话 token 认身份：验 token → 取账号 → 返回账号；验不过返回 null。 */
  private async accountFromSession(req: IncomingMessage): Promise<Account | null> {
    const supplied = req.headers["x-nyra-token"];
    if (typeof supplied !== "string" || !supplied) return null;
    try {
      const verified = await this.accountSessions.verify(supplied);
      if (!verified) return null;
      const account = await this.accountsDirectory.findById(verified.account_id);
      // 已停用的账号按未登录处理（停用时会话已撤销，这是双保险）。
      if (!account || account.status === "suspended") return null;
      return account;
    } catch {
      // 账号文件损坏等 fail-closed：当未登录处理，不拖垮网关。
      return null;
    }
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = Buffer.from(JSON.stringify(data), "utf-8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    res.end(body);
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    this.sendJson(res, status, { error: message });
  }

  private sendHtml(res: ServerResponse, status: number, html: string, csp = true): void {
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
    if (csp) headers["Content-Security-Policy"] = CSP;
    res.writeHead(status, headers);
    res.end(html);
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY) throw new Error("请求体过大");
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请求体必须是 JSON 对象");
    return data as Record<string, unknown>;
  }

  /** 缺口 7：webhook 验签要原始字节（HMAC 算在原文上），先读 raw 再解析 JSON。 */
  private async readRawBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY) throw new Error("请求体过大");
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private route(req: IncomingMessage): { path: string; query: URLSearchParams } {
    const url = new URL(req.url ?? "/", "http://x");
    return { path: url.pathname, query: url.searchParams };
  }

  private validSid(raw: string): string | null {
    const sid = decodeURIComponent(raw);
    return SESSION_ID_RE.test(sid) ? sid : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res);
    } catch (err) {
      process.stderr.write(`[nyra gateway] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        try { this.sendError(res, 500, "服务器内部错误"); } catch { /* ignore */ }
      } else { try { res.end(); } catch { /* ignore */ } }
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.verbose) process.stderr.write(`[nyra gateway] ${req.method} ${(req.url ?? "").split("?")[0]}\n`);
    if (!this.hostOk(req)) { this.sendError(res, 421, "Host 不被允许"); return; }
    const { path, query } = this.route(req);
    const method = req.method ?? "GET";

    // 手机公共壳：页面与静态资源不含秘密，不用 token；API 仍要鉴权。
    // 手机 v2（src/webuiMobile.ts）：按 docs/assets/screenshots 设计稿的黑白界面、审批底部弹层、从应用图标（src/appIcon.ts）光栅化的图标。
    if (method === "GET" && (path === "/m" || path === "/m/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
      res.end(MOBILE_V2_HTML);
      return;
    }
    if (method === "GET" && path === "/m/manifest.json") {
      const body = Buffer.from(JSON.stringify(MOBILE_V2_MANIFEST), "utf-8");
      res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8", "Content-Length": body.length });
      res.end(body);
      return;
    }
    const mobileIcon = MOBILE_ICON_ROUTES[path];
    if (method === "GET" && mobileIcon) {
      const png = mobileIconPng(mobileIcon.size, mobileIcon.kind);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "public, max-age=86400" });
      res.end(png);
      return;
    }
    // 手机字体（Inter / JetBrains Mono，OFL）：公开静态资源，页面用 FontFace 从 ArrayBuffer 加载（CSP 不变）。
    const fontMatch = MOBILE_FONT_ROUTE.exec(path);
    if (method === "GET" && fontMatch) {
      const font = mobileFont(fontMatch[1]);
      if (!font) { this.sendError(res, 404, "未找到"); return; }
      res.writeHead(200, { "Content-Type": "font/woff", "Content-Length": font.length, "Cache-Control": "public, max-age=86400" });
      res.end(font);
      return;
    }
    if (method === "GET" && path === "/favicon.ico") {
      const ico = mobileFaviconIco();
      res.writeHead(200, { "Content-Type": "image/x-icon", "Content-Length": ico.length, "Cache-Control": "public, max-age=86400" });
      res.end(ico);
      return;
    }
    if (method === "GET" && path === "/m/favicon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(mobileFaviconSvg());
      return;
    }
    const startupMatch = /^\/m\/startup\/(\d{3,4})x(\d{3,4})\.png$/.exec(path);
    if (method === "GET" && startupMatch) {
      const w = Number(startupMatch[1]);
      const h = Number(startupMatch[2]);
      if (!STARTUP_SIZES.some(([a, b]) => a === w && b === h)) { this.sendError(res, 404, "未找到"); return; }
      const png = solidPng(w, h, MOBILE_V2_MANIFEST.background_color);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      res.end(png);
      return;
    }
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      if (!this.pageTokenOk(req) && !this.device(req)) { this.sendHtml(res, 403, FORBIDDEN_PAGE); return; }
      this.sendHtml(res, 200, DESKTOP_HTML);
      return;
    }
    if (method === "GET" && path === "/manifest.json") {
      if (!this.pageTokenOk(req)) { this.sendError(res, 403, "token 无效"); return; }
      this.sendJson(res, 200, MANIFEST);
      return;
    }
    if (method === "GET" && path === "/nyra-mark.svg") {
      if (!this.pageTokenOk(req)) { this.sendError(res, 403, "token 无效"); return; }
      // 内置品牌标志（方块头，与 docs/assets/nyra-mark.svg 同源生成），不再依赖当前目录下有 docs/。
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(markSvg());
      return;
    }
    if (method === "GET" && path === "/groups") {
      if (!this.pageTokenOk(req)) { this.sendHtml(res, 403, FORBIDDEN_PAGE); return; }
      this.sendHtml(res, 200, GROUP_UI_HTML);
      return;
    }
    if (method === "GET" && path === "/group-ui.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(GROUP_UI_JS);
      return;
    }

    if (method === "OPTIONS") { this.sendError(res, 403, "不支持跨域请求"); return; }
    if (method === "GET" && path === "/api/health") { this.sendJson(res, 200, { ok: true, version: VERSION }); return; }

    // 缺口 38：Agent 名片——GET /.well-known/agent-card.json（公开：名片本身
    // 就是公开信息，不含密钥与内部状态）。默认不发布：关闭时当不存在（404），
    // 不泄露端点；peer_card.publish 开后才回名片 JSON。
    // 第 2 批 G-P1-5：配了 peer_card.visible_circles 时，名片只对配了的圈
    // 开放——请求须带有效 grant（Bearer nyra-grant-...，scope 含 card:read），
    // 且 grant 的好友须在可见圈里；验不过一律 404（不泄露限制细节）。
    if (method === "GET" && path === "/.well-known/agent-card.json") {
      const { peerCardConfig, buildAgentCard, cardVisibleToCircle } = await import("./peerCard.ts");
      const cfg = peerCardConfig(this.config);
      if (!cfg.publish) { this.sendError(res, 404, "未找到"); return; }
      if (cfg.visibleCircles !== null) {
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        let admitted = false;
        if (token) {
          try {
            const { verifyFriendGrant } = await import("./friendGrants.ts");
            const { loadFriendBook, findFriend } = await import("./peerCard.ts");
            const v = verifyFriendGrant(this.home, token, "card:read");
            if (v) {
              const entry = findFriend(loadFriendBook(this.home), v.peer);
              if (entry && !entry.blocked && cardVisibleToCircle(this.config, entry.circle)) admitted = true;
            }
          } catch { admitted = false; }
        }
        if (!admitted) { this.sendError(res, 404, "未找到"); return; }
      }
      this.sendJson(res, 200, buildAgentCard(this.home, this.config) as unknown as Record<string, unknown>);
      return;
    }

    // 缺口 17：对外 MCP 服务（Streamable HTTP，JSON-RPC）——POST /mcp。
    // 默认关闭：关闭时当不存在（404），不泄露端点；开启后走通用 token 鉴权
    //（owner 或设备 token，与 /api/* 同款 apiAuth），鉴权失败记一行审计。
    // 无状态：只回 JSON，不要求 Mcp-Session-Id；GET 只接受 POST（405）。
    if (path === "/mcp") {
      if (method !== "POST") { this.sendError(res, 405, "对外 MCP 服务只接受 POST"); return; }
      if (!mcpServerConfig(this.config).enabled) { this.sendError(res, 404, "未找到"); return; }
      const who = await this.apiAuth(req);
      if (who === null) {
        try { appendMcpServerAudit(this.home, { tool: "(auth)", caller: "unknown", ok: false, error: "token 无效" }); } catch { /* 审计写失败不破坏响应 */ }
        this.sendError(res, 403, "token 无效"); return;
      }
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      const result = await this.mcpServer().handle(body, who === "owner" ? "owner" : "device");
      if (result.body === null) { res.writeHead(202); res.end(); return; }
      this.sendJson(res, 200, result.body);
      return;
    }

    // SCIM 2.0（缺口 43 第二批）：挂在 /api/ 通用鉴权之前——SCIM 用自己的
    // Bearer token（`nyra sso scim token` 签发），不走 X-Nyra-Token。
    // 鉴权在 handleScimRequest 里做（未配 token 或验不过一律 401），
    // 这里只读原文 body 再转交；网关用文件版 store
    // （与 accounts.md §12 已知的 Postgres 网关接线局限同口径）。
    if (path === "/scim/v2" || path.startsWith("/scim/v2/")) {
      const { handleScimRequest } = await import("./scim.ts");
      const bodyText = (await this.readRawBody(req)).toString("utf-8");
      const result = await handleScimRequest({
        method,
        path,
        headers: req.headers,
        bodyText,
        home: this.home,
      });
      this.sendJson(res, result.status, result.body);
      return;
    }

    if (!path.startsWith("/api/")) { this.sendError(res, 404, "未找到"); return; }

    // POST /api/pair 是唯一无需鉴权的 API：手机拿一次性配对码换设备 token。
    if (method === "POST" && path === "/api/pair") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      try {
        const device = this.devices.redeem(String(body.code ?? ""), String(body.name ?? ""));
        this.sendJson(res, 200, device);
      } catch (err) {
        if (err instanceof PairingError) this.sendError(res, 401, err.message);
        else this.sendError(res, 500, `保存设备失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // POST /api/pair/encrypted：配对加密版。手机先发临时 ECDH 公钥，网关用它
    // 把设备 token 加密后发回，token 不再明文过网（见 src/pairingCrypto.ts）。
    // 明文 /api/pair 保留：已装 APK 与经明文 HTTP 局域网 IP 加载的手机页上
    // WebCrypto 不可用（crypto.subtle 只在安全上下文里有），仍靠它配对。
    if (method === "POST" && path === "/api/pair/encrypted") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      try {
        // 先验公钥再兑换：公钥非法不能烧掉一次性配对码。
        assertValidPairingPublicKey(String(body.public_key ?? ""));
        const device = this.devices.redeem(String(body.code ?? ""), String(body.name ?? ""));
        const envelope = encryptTokenForPeer(device.token, String(body.public_key ?? ""));
        this.sendJson(res, 200, { id: device.id, name: device.name, envelope });
      } catch (err) {
        if (err instanceof PairingError) this.sendError(res, 401, err.message);
        else if (err instanceof PairingCryptoError) this.sendError(res, 400, "public_key 不合法");
        else this.sendError(res, 500, `配对失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // 缺口 41 下一批：magic link 兑换端点（无鉴权：用户点邮件链接时还没有会话 token）。
    // token 从 query 或 body 里拿（邮件链接用 query，CLI 轮询用 body）；redeem 一次性、
    // 15 分钟有效、重放必失败。成功返回账号 + 会话 token（只此一次返回原文）。
    if (method === "POST" && path === "/api/account/magic-link") {
      let token = query.get("token") ?? "";
      if (!token) {
        try {
          const body = await this.readBody(req);
          token = String(body.token ?? "");
        } catch { /* body 不是 JSON 时按无 token 处理 */ }
      }
      if (!token) { this.sendError(res, 400, "缺少 token"); return; }
      try {
        const { account, session } = await loginWithMagicLink({ home: this.home, token });
        this.sendJson(res, 200, {
          account: { id: account.id, email: account.email, name: account.name, role: account.role },
          session: { id: session.id, token: session.token, expires_at: session.expires_at },
        });
      } catch (err) {
        if (err instanceof AccountError) this.sendError(res, 401, err.message);
        else this.sendError(res, 500, `兑换失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // 缺口 7：webhook 入口（事件触发任务）。放在通用 token 鉴权之前：generic 用
    // 网关 token（x-nyra-token），github/slack 用各自的 HMAC 签名（密钥只存密码箱）。
    // 鉴权失败直接 4xx，不进队列；验签通过才解析 body、归一化、派发进任务队列。
    const webhookMatch = /^\/api\/webhooks\/([A-Za-z]+)$/.exec(path);
    if (method === "POST" && webhookMatch) {
      const source = webhookMatch[1] as WebhookSource;
      if (!WEBHOOK_SOURCES.includes(source)) { this.sendError(res, 400, "webhook 来源只允许 generic|github|slack"); return; }
      let raw: Buffer;
      try { raw = await this.readRawBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw.toString("utf-8") || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
        body = parsed as Record<string, unknown>;
      } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      const headers = req.headers as Record<string, string | string[] | undefined>;
      let auth = "gateway-token";
      try {
        if (source === "generic") {
          if (await this.apiAuth(req) === null) { this.sendError(res, 403, "token 无效"); return; }
        } else {
          auth = verifyWebhookSignature(source, raw, headers, this.home).auth;
        }
        const normalized = normalizeWebhookEvent(source, body, headers, raw);
        if ("challenge" in normalized) { this.sendJson(res, 200, { challenge: normalized.challenge }); return; }
        const result = dispatchEvent({ ...normalized.event, auth }, { home: this.home });
        this.sendJson(res, 202, { accepted: true, ...result });
        // 缺口 25 的尾巴：同名事件的工作流触发器也跑一遍。不等它跑完再回
        // 202（工作流可能跑很久）；失败只记 stderr，不破坏 webhook 响应。
        void import("./workflowTriggers.ts").then(async ({ fireWorkflowEventTriggers }) => {
          try {
            await fireWorkflowEventTriggers(this.home, { ...normalized.event, auth });
          } catch (err: unknown) {
            process.stderr.write(`工作流事件触发失败：${err instanceof Error ? err.message : String(err)}\n`);
          }
        }).catch(() => { /* 触发模块载入失败也不破坏 webhook */ });
      } catch (err) {
        if (err instanceof WebhookError) this.sendError(res, err.status, err.message);
        else if (err instanceof EventTriggerError) this.sendError(res, 400, err.message);
        else this.sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (method === "POST" && path.startsWith("/api/webhooks/")) {
      this.sendError(res, 400, "webhook 来源只允许 generic|github|slack");
      return;
    }

    const who = await this.apiAuth(req);
    if (who === null) { this.sendError(res, 403, "token 无效"); return; }
    const isOwner = who === "owner";
    if (await this.chiefRoutes(method, path, query, req, res)) return;

    if (method === "GET" && path === "/api/approvals") {
      this.sendJson(res, 200, { approvals: this.pendingApprovals() });
      return;
    }
    if (method === "GET" && path === "/api/mode/requests") {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上查看完全模式请求"); return; }
      const requests = this.fullModeRequests.list().map((r) => ({
        id: r.id, device: r.device,
        created_at: new Date(r.createdAt * 1000).toISOString(),
        expires_at: new Date(r.expiresAt * 1000).toISOString(),
      }));
      this.sendJson(res, 200, { requests });
      return;
    }
    // 缺口 3b：审阅队列（供手机 PWA 的“审阅”标签页消费）。fail-closed：队列只
    // 展示与批复，批复本身不合并代码；合并是单独的 apply 动作（worktree 文件
    // 拷回工作目录），且只接受 approved 的项。
    if (method === "GET" && path === "/api/review") {
      const status = query.get("status") as ReviewStatus | null;
      if (status && !["pending", "approved", "rejected", "applied"].includes(status)) {
        this.sendError(res, 400, "status 只允许 pending|approved|rejected|applied");
        return;
      }
      try {
        this.sendJson(res, 200, { items: listReviewItems(this.home, status ?? undefined) });
      } catch (err) {
        this.sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const reviewGetMatch = /^\/api\/review\/([0-9a-f]{16})$/.exec(path);
    // 缺口 6：连接器状态（供桌面端连接管理页消费；页面本身在 desktop/）。
    // 只返回状态与账号邮箱，不返回任何 token / client_secret。
    if (method === "GET" && path === "/api/connectors") {
      const gmail = getGmailStatus(this.home, this.config);
      this.sendJson(res, 200, {
        connectors: [{
          id: "gmail",
          name: "Gmail",
          enabled: gmail.enabled,
          configured: gmail.configured,
          ...(gmail.email ? { email: gmail.email } : {}),
          ...(gmail.scopes ? { scopes: gmail.scopes } : {}),
        }],
      });
      return;
    }
    // 内置机器人市场（第一阶段：静态策展仓库 + 本地客户端；供桌面端/手机 PWA
    // 的市场页消费；只给公开元数据，不含绝对路径与技能正文）。
    if (method === "GET" && path === "/api/marketplace") {
      try { this.sendJson(res, 200, listMarketplacePublic(this.home)); }
      catch (err) { this.sendError(res, 400, `市场读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // 缺口 11 留的口子：技能草稿清单（供桌面端/手机 PWA 的市场页消费；
    // 草稿是用户自己的内容，含正文；只读，不含批准操作——批准走 CLI）。
    if (method === "GET" && path === "/api/skill-drafts") {
      try {
        const drafts = listDrafts(this.home).map((d) => ({
          name: d.name,
          status: d.status,
          quality: d.quality,
          source_run_id: d.source_run_id,
          created_at: d.created_at,
          updated_at: d.updated_at,
        }));
        this.sendJson(res, 200, { drafts });
      } catch (err) { this.sendError(res, 400, `技能草稿读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // O5：学习队列只读面（供桌面端/手机 PWA 的学习页消费；只读，不含批准操作——
    // 批准与发布走 CLI；owner 默认 default，可按 ?owner= 账号 id 看别人的队列，
    // 网关本身只认机主 token，跨账号查看只在同一台机主电脑上发生）。
    if (method === "GET" && path === "/api/learning") {
      try {
        const owner = query.get("owner") ?? "default";
        const items = listLearning(this.home, owner, {
          ...(query.get("status") ? { status: query.get("status") as LearningStatus } : {}),
          ...(query.get("kind") ? { kind: query.get("kind") as LearningKind } : {}),
          ...(query.get("shared") === "1" ? { shared: true } : {}),
        }).map((p) => ({
          id: p.id,
          kind: p.kind,
          owner: p.owner,
          title: p.title,
          summary: p.summary,
          source: p.source,
          evidence: p.evidence,
          ref: p.ref,
          status: p.status,
          created_at: p.created_at,
          decided_at: p.decided_at,
          decision_reason: p.decision_reason,
          published_ref: p.published_ref,
          shared_to: p.shared_to,
          shared_at: p.shared_at,
        }));
        this.sendJson(res, 200, { owner, proposals: items });
      } catch (err) { this.sendError(res, 400, `学习队列读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // O2：审计导出 API（只读）。与 CLI 的 `nyra governance audit export` 同一份
    // 导出（JSONL + 哈希链），只是这里返回解析后的 JSON；审计导出本身照常记
    // audit_exported。只限本机机主（已配对设备也不给）。
    if (method === "GET" && path === "/api/audit/export") {
      if (!isOwner) { this.sendError(res, 403, "审计导出只能在电脑上查看"); return; }
      try {
        const format = query.get("format") ?? "json";
        if (format !== "json" && format !== "jsonl") { this.sendError(res, 400, "format 只支持 json 或 jsonl"); return; }
        const limitRaw = query.get("limit") ?? "5000";
        const limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50000) { this.sendError(res, 400, "limit 须是 1–50000 的整数"); return; }
        const sourcesRaw = query.get("sources") ?? "";
        const result = exportAudit(this.home, {
          from: query.get("from") ?? undefined,
          to: query.get("to") ?? undefined,
          sources: sourcesRaw ? sourcesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          actor: query.get("actor") ?? undefined,
          type: query.get("type") ?? undefined,
          scope: query.get("scope") ?? undefined,
          initiator: query.get("initiator") ?? undefined,
        });
        if (result.lines > limit) {
          this.sendError(res, 400, `记录太多（${result.lines} 条，超过 limit ${limit}）：请加 from/to/source/actor/type/scope/initiator 过滤，或用 nyra governance audit export 导出到文件`);
          return;
        }
        if (format === "jsonl") {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          res.end(result.text);
          return;
        }
        const records = result.text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        this.sendJson(res, 200, {
          ok: true,
          lines: result.lines,
          out_hash: result.outHash,
          header_hash: result.headerHash,
          records,
        });
      } catch (err) { this.sendError(res, 400, `审计导出失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    if (method === "GET" && reviewGetMatch) {
      try {
        this.sendJson(res, 200, getReviewItem(this.home, reviewGetMatch[1]));
      } catch (err) {
        if (err instanceof ReviewQueueError && err.message.includes("不存在")) this.sendError(res, 404, err.message);
        else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (method === "GET" && path.startsWith("/api/review/")) {
      this.sendError(res, 400, "审阅项 id 无效");
      return;
    }
    if (method === "GET" && (path === "/api/devices" || path === "/api/pair/status")) {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上管理已配对设备"); return; }
      this.sendJson(res, 200, {
        devices: this.devices.listDevices(),
        pairing: this.devices.pairingStatus(),
        lan: Boolean(this.pairOrigin),
      });
      return;
    }
    // H1：最近用过哪些客户端（只限机主）：半夜多一个陌生客户端时，
    // 在这里与 gateway-audit.jsonl 里都能看见。已配对设备也不给——
    // 客户端清单本身就是审计视角，只有机主能查。
    if (method === "GET" && path === "/api/clients") {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上查看客户端"); return; }
      this.sendJson(res, 200, { clients: listGatewayClients(this.home) });
      return;
    }
    // H2：网关 presence（只限机主查）：桌面是否活跃、要不要推手机、
    // 当前活跃的客户端。手机端按 should_notify_mobile 决定推不推通知。
    if (method === "GET" && path === "/api/presence") {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上查看在线状态"); return; }
      const active = listActivePresence(this.home);
      this.sendJson(res, 200, {
        desktop_active: isDesktopActive(this.home),
        should_notify_mobile: shouldNotifyMobile(this.home),
        window_ms: PRESENCE_ACTIVE_WINDOW_MS,
        active: active.map((r) => ({ client: r.client, kind: r.kind, surface: r.surface, last_active: r.last_active })),
        clients: loadGatewayPresence(this.home).map((r) => ({ client: r.client, kind: r.kind, surface: r.surface, first_seen: r.first_seen, last_active: r.last_active, heartbeats: r.heartbeats })),
      });
      return;
    }
    // H2：客户端报心跳（任何有效 token 都能报；身份取自 apiAuth，不信任
    // body 里的 client）。surface 不报时按 kind 推断（owner→desktop，
    // device→mobile，account→web）。10 秒内重复心跳不写盘，返回 throttled。
    if (method === "POST" && path === "/api/presence/heartbeat") {
      const ref = describeGatewayClient(who);
      if (!ref) { this.sendError(res, 400, "客户端身份无效"); return; }
      let body: Record<string, unknown> = {};
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      const surface = body.surface === undefined ? undefined : body.surface;
      if (surface !== undefined && !isPresenceSurface(surface)) { this.sendError(res, 400, "surface 只允许 desktop|mobile|web"); return; }
      const out = recordPresenceHeartbeat(this.home, { client: ref.client, kind: ref.kind, surface: surface as PresenceSurface | undefined, source: "heartbeat" });
      if (!out.ok) { this.sendError(res, 500, "心跳没写上"); return; }
      this.sendJson(res, 200, { ok: true, throttled: out.throttled, desktop_active: isDesktopActive(this.home), should_notify_mobile: shouldNotifyMobile(this.home) });
      return;
    }
    if (method === "GET" && path === "/api/info") { this.sendJson(res, 200, this.info()); return; }
    // 缺口 41 下一批：当前账号信息（供登录后的客户端显示"我是谁"）。账号会话
    // token 鉴权；owner/设备 token 访问时返回"未用账号登录"（不泄露账号目录）。
    if (method === "GET" && path === "/api/account") {
      const acct = await this.accountFromSession(req);
      if (!acct) {
        this.sendJson(res, 200, { account: null });
        return;
      }
      const sessions = await this.accountSessions.listSessions(acct.id);
      this.sendJson(res, 200, {
        account: {
          id: acct.id, email: acct.email, name: acct.name, role: acct.role,
          providers: acct.providers.map((p) => p.provider),
          created_at: acct.created_at,
        },
        sessions: sessions.map((s) => ({ id: s.id, created_at: s.created_at, last_seen: s.last_seen, expires_at: s.expires_at })),
      });
      return;
    }
    if (method === "GET" && path === "/api/rules") {
      const sid = query.get("session");
      this.sendJson(res, 200, this.rulesView(sid && SESSION_ID_RE.test(sid) ? sid : null));
      return;
    }
    // 桌面端首次引导 / 设置：Key 只回掩码；改动类接口只给电脑本机（owner）。
    if (method === "GET" && path === "/api/setup") { this.sendJson(res, 200, this.setupView()); return; }
    if (method === "GET" && path === "/api/keys") {
      if (!isOwner) { this.sendError(res, 403, "API Key 只能在电脑上管理"); return; }
      this.sendJson(res, 200, this.keysView());
      return;
    }
    if (method === "GET" && path === "/api/settings") { this.sendJson(res, 200, this.settingsView()); return; }
    if (method === "GET" && path === "/api/schedule") {
      try { this.sendJson(res, 200, { tasks: this.scheduleList() }); }
      catch (err) { this.sendError(res, 400, `定时任务读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // 缺口 7：事件触发器清单（供桌面端/手机 PWA 消费；只给元数据，不含任务提示词）。
    if (method === "GET" && path === "/api/event-triggers") {
      try { this.sendJson(res, 200, { triggers: listEventTriggersPublic(this.home) }); }
      catch (err) { this.sendError(res, 400, `事件触发器读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // 缺口 22：邮件入口状态（供桌面端/手机 PWA 消费；只给设置与待回信数，不含邮件正文）。
    if (method === "GET" && path === "/api/mail-inbox") {
      try { this.sendJson(res, 200, listMailInboxPublic(this.home)); }
      catch (err) { this.sendError(res, 400, `邮件入口读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // 缺口 8：常驻责任清单（供桌面端/手机 PWA 消费；只给元数据，不含责任目标）。
    if (method === "GET" && path === "/api/responsibilities") {
      try { this.sendJson(res, 200, { responsibilities: listResponsibilitiesPublic(this.home) }); }
      catch (err) { this.sendError(res, 400, `常驻责任读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // 缺口 10：独立审查层状态（供桌面端/手机 PWA 消费；只给开关与模型名，不含凭证）。
    if (method === "GET" && path === "/api/reviewer") {
      try { this.sendJson(res, 200, reviewerStatus(this.config, this.home)); }
      catch (err) { this.sendError(res, 400, `审查层状态读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    if (method === "GET" && path === "/api/memory/scopes") {
      this.sendJson(res, 200, { scopes: memoryScopes(this.home) });
      return;
    }
    if (method === "GET" && path === "/api/memory") {
      try {
        const result = memoryView(this.home, query.get("scope") ?? "global", query.get("room"), query.get("bot"));
        this.sendJson(res, 200, result);
      } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
      return;
    }
    if (method === "GET" && path === "/api/sessions") { this.sendJson(res, 200, this.sessionsView()); return; }
    // G-P1-37：远端线程操作 API（LangGraph threads.py 借鉴）。读接口认任何
    // 已鉴权调用方；写接口只认机主（owner）与设备 token，账号 user 角色只读
    // （fail-closed：user 角色调写接口直接 403）。
    if (path === "/api/threads" || path.startsWith("/api/threads/")) {
      const match = /^\/api\/threads(?:\/([0-9a-f]{16})(?:\/(copy|prune|state|history|runs|archive|unarchive))?)?$/.exec(path);
      if (!match) { this.sendError(res, 404, "未找到"); return; }
      const threadId = match[1] ?? null;
      const action = match[2] ?? null;
      const isWrite = method === "POST" || method === "PUT";
      if (isWrite && who === "account") { this.sendError(res, 403, "账号 user 角色只读，写线程须用机主或设备 token"); return; }
      try {
        if (method === "GET" && !threadId) {
          const q = query.get("q") ?? "";
          const status = query.get("status") ?? "";
          const list = q
            ? searchThreads(this.home, q, status === "active" || status === "archived" ? status : undefined)
            : listThreads(this.home).filter((t) => !status || t.status === status);
          this.sendJson(res, 200, { threads: list.map((t) => threadPublic(t)) });
          return;
        }
        if (method === "POST" && !threadId) {
          const body = await this.readBody(req);
          const title = typeof body.title === "string" ? body.title : "";
          const state = body.state !== undefined && body.state !== null
            ? (body.state as Record<string, unknown>) : undefined;
          const t = createThread(this.home, title, state ? { state } : undefined);
          this.sendJson(res, 201, { thread: t });
          return;
        }
        if (!threadId) { this.sendError(res, 404, "未找到"); return; }
        if (method === "GET" && !action) { this.sendJson(res, 200, { thread: getThread(this.home, threadId) }); return; }
        if (method === "POST" && action === "copy") {
          this.sendJson(res, 201, { thread: copyThread(this.home, threadId) });
          return;
        }
        if (method === "POST" && action === "prune") {
          const body = await this.readBody(req);
          const keep = body.keep === undefined ? 50 : Number(body.keep);
          this.sendJson(res, 200, pruneThread(this.home, threadId, keep));
          return;
        }
        if (method === "GET" && action === "state") {
          this.sendJson(res, 200, { state: getThreadState(this.home, threadId) });
          return;
        }
        if (method === "PUT" && action === "state") {
          const body = await this.readBody(req);
          const patch = (body.patch ?? {}) as Record<string, unknown>;
          this.sendJson(res, 200, { state: updateThreadState(this.home, threadId, patch) });
          return;
        }
        if (method === "GET" && action === "history") {
          const limit = query.get("limit") ? Number(query.get("limit")) : 50;
          this.sendJson(res, 200, { history: getThreadHistory(this.home, threadId, limit) });
          return;
        }
        if (method === "POST" && (action === "archive" || action === "unarchive")) {
          const t = setThreadStatus(this.home, threadId, action === "archive" ? "archived" : "active");
          this.sendJson(res, 200, { thread: threadPublic(t) });
          return;
        }
        if (method === "GET" && action === "runs") {
          this.sendJson(res, 200, { runs: listThreadRuns(this.home, threadId) });
          return;
        }
      } catch (err) {
        if (err instanceof ThreadError) {
          this.sendError(res, /不存在/.test(err.message) ? 404 : 400, err.message);
        } else {
          this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      this.sendError(res, 404, "未找到");
      return;
    }
    // 设计稿 v8 pc-03：项目记忆卡（只读）。三个文件在不在、多大，MEMORY.md 最近 3 条带来源会话与时间。
    if (method === "GET" && path === "/api/project-memory") {
      try { this.sendJson(res, 200, projectMemoryView(this.home, this.workdir, 3)); }
      catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
      return;
    }
    if (method === "GET" && path === "/api/project-memory/file") {
      try { this.sendJson(res, 200, projectMemoryFile(this.home, this.workdir, query.get("kind") ?? "")); }
      catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
      return;
    }
    if (method === "GET" && path === "/api/mcp/tools") { this.sendJson(res, 200, { tools: this.mcpTools() }); return; }
    if (method === "GET" && path === "/api/mcp/spend") {
      this.sendJson(res, 200, { limit_usd: costLimitUsd(this.config), spent_usd: this.mcpCost.totalUsd() });
      return;
    }
    if (method === "GET" && path === "/api/smart-approvals/audit") {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上查看审批审计日志"); return; }
      this.sendJson(res, 200, { records: readAudit(this.home).slice(-100) });
      return;
    }
    const artifactsMatch = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(path);
    if (method === "GET" && artifactsMatch) {
      const sid = this.validSid(artifactsMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      this.sendJson(res, 200, { artifacts: listArtifacts(sid, this.home) });
      return;
    }
    const artifactMatch = /^\/api\/artifacts\/([0-9a-f]{12})$/.exec(path);
    if (method === "GET" && artifactMatch) {
      const rec = getArtifact(artifactMatch[1], this.home);
      if (!rec) { this.sendError(res, 404, "产物不存在"); return; }
      this.sendJson(res, 200, rec);
      return;
    }
    const historyMatch = /^\/api\/sessions\/([^/]+)\/history$/.exec(path);
    if (method === "GET" && historyMatch) {
      const sid = this.validSid(historyMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      this.sendJson(res, 200, { messages: this.storeHistory(sid) });
      return;
    }
    const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && eventsMatch) {
      const sid = this.validSid(eventsMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      if (!this.sessionKnown(sid)) { this.sendError(res, 404, "会话不存在"); return; }
      let since = 0;
      try { since = Math.max(0, Number(query.get("since") ?? "0") || 0); } catch { since = 0; }
      this.streamEvents(req, res, sid, since);
      return;
    }
    const sessionGetMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionGetMatch) {
      const sid = this.validSid(sessionGetMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      let since = 0;
      try { since = Math.max(0, Number(query.get("since") ?? "0") || 0); } catch { since = 0; }
      this.sendJson(res, 200, this.sessionView(sid, since));
      return;
    }
    if (method === "GET" && path === "/api/groups") {
      this.sendJson(res, 200, { groups: this.groups.listRooms() });
      return;
    }
    const groupMatch = /^\/api\/groups\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (method === "GET" && groupMatch) {
      try { this.sendJson(res, 200, this.groups.get(groupMatch[1])); }
      catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
      return;
    }

    // ---- 手机端 Cue 式界面（B 批）：探索页模板、个人页聚合、邀请账本、Bot Mode 开关 ----
    // 诚实边界写在响应里：钱包/电话只是入口（available: false），邮箱如实报
    // Gmail 连接器状态（收发闭环仍 blocked，见 docs/mobile-cue.md），邀请码
    // 现在不能兑现注册（cloudReady: false），电脑是本地网关状态、云端未部署。
    if (method === "GET" && path === "/api/mobile/explore") {
      this.sendJson(res, 200, { templates: listExploreTemplates() });
      return;
    }
    if (method === "GET" && path === "/api/mobile/profile") {
      const settings = this.settingsView();
      const gmail = getGmailStatus(this.home, this.config);
      const info = this.info();
      let devices = 0;
      try { devices = this.devices.listDevices().length; } catch { devices = 0; }
      const quota = inviteQuota(this.home);
      this.sendJson(res, 200, {
        usage: this.budgetSummary(),
        wallet: { available: false, note: "coming-soon" },
        apps: {
          mcp: (settings.mcp as Record<string, unknown> | undefined)?.servers ?? [],
          mcp_enabled: (settings.mcp as Record<string, unknown> | undefined)?.enabled ?? false,
          connectors: [{ id: "gmail", name: "Gmail", enabled: gmail.enabled, configured: gmail.configured }],
        },
        mail: {
          ...gmail,
          // Gmail 真实闭环仍 blocked（授权同意页转圈，2026-11-24 评审结论）：
          // configured 只表示密码箱里有条目，不等于收发已通。
          loop: "blocked",
          loopNote: "Gmail 收发闭环仍在排查，未通",
        },
        phone: { available: false, note: "coming-soon" },
        skills: { count: Array.isArray(info.skills) ? info.skills.length : 0 },
        computer: {
          version: info.version ?? null,
          platform: info.platform ?? null,
          mode: info.mode ?? null,
          devices,
          lan: Boolean(this.pairOrigin),
          cloud: { available: false, note: "cloud-not-deployed" },
        },
        botMode: { enabled: isBotModeEnabled(this.home) },
        invites: { total: quota.total, used: quota.used, remaining: quota.remaining },
      });
      return;
    }
    if (method === "GET" && path === "/api/mobile/invites") {
      const store = loadInvites(this.home);
      const quota = inviteQuota(this.home);
      this.sendJson(res, 200, {
        cloudReady: false,
        cloudNote: "云端登录后端未部署，邀请码现在不能兑现注册",
        total: quota.total, used: quota.used, remaining: quota.remaining,
        invites: store.invites,
      });
      return;
    }
    if (method === "GET" && path === "/api/mobile/bot-mode") {
      this.sendJson(res, 200, { enabled: isBotModeEnabled(this.home) });
      return;
    }

    // ---- DELETE ----
    if (method === "DELETE" && sessionGetMatch) {
      const sid = this.validSid(sessionGetMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      const outcome = await this.closeSession(sid);
      if (outcome === "unknown") { this.sendError(res, 404, "会话不存在"); return; }
      if (outcome === "running") { this.sendError(res, 409, "会话正在执行任务，请等它完成再关闭"); return; }
      this.sendJson(res, 200, { id: sid, closed: true });
      return;
    }

    // 缺口 2：网关删除记忆。body：{scope, room?, bot?, ids? | session_id?,
    // revision?}——ids 与 session_id 至少给一个；revision 有值时走 CAS
    // （memoryBrowser.ts 的思路：对不上 409，一条都不删）。进行中会话的
    // 记忆拒绝删除（与 closeSession 对齐回 409）。信任级别与已有的
    // POST /api/memory（整文件保存）一致：token 鉴权、用户主动发起，
    // 不另设审批；agent 工具侧的删除仍走 checkApproval（见 tools.ts）。
    if (method === "DELETE" && path === "/api/memory") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      const scope = String(body.scope ?? "global");
      const room = typeof body.room === "string" ? body.room : null;
      const bot = typeof body.bot === "string" ? body.bot : null;
      const ids = Array.isArray(body.ids)
        ? (body.ids as unknown[]).map((v) => String(v)).filter(Boolean)
        : undefined;
      const sessionId = typeof body.session_id === "string" && body.session_id ? body.session_id : undefined;
      if ((!ids || !ids.length) && !sessionId) { this.sendError(res, 400, "须指定 ids（记忆 id 列表）或 session_id（来源会话）之一"); return; }
      const running = new Set(
        [...this.runs.values()].filter((r) => r.status === "running").map((r) => r.sessionId),
      );
      if (sessionId && running.has(sessionId)) { this.sendError(res, 409, "该会话正在执行任务，请等它完成再删除其记忆"); return; }
      try {
        const result = deleteMemoryForScope(this.home, scope, room, bot, {
          ids,
          session_id: sessionId,
          activeSessionIds: running,
          revision: typeof body.revision === "string" ? body.revision : undefined,
        });
        // 删除本身进证据链：删了什么、删后数量（网关侧无审批卡，批准方记 token 持有人）。
        try {
          const store = new EvidenceStore(join(this.home, "evidence"), "memory");
          store.save(
            "memory_delete",
            `memory://${scope}`,
            [
              "网关 DELETE /api/memory",
              `范围：${scope}${scope === "bot" ? `（${room}/${bot}）` : ""}`,
              `批准：token 持有人（${isOwner ? "本机" : "已配对设备"}）`,
              `删了 ${result.deleted.length} 条，删后剩 ${result.remaining} 条：`,
              ...result.deleted.map((e) => `- [${e.id}] ${e.text}（来源会话：${e.source_session ?? "未记录"}；${e.created_at || "时间未记录"}）`),
              ...(result.skipped.length ? [`跳过（owner 不符，未删）：${result.skipped.map((s) => s.id).join("、")}`] : []),
              ...(result.notFound.length ? [`未找到：${result.notFound.join("、")}`] : []),
            ].join("\n"),
          );
        } catch { /* 证据落盘失败不破坏删除结果 */ }
        this.sendJson(res, 200, {
          deleted: result.deleted.length,
          deleted_ids: result.deleted.map((e) => e.id),
          remaining: result.remaining,
          skipped: result.skipped,
          not_found: result.notFound,
        });
      } catch (err) {
        if (err instanceof MemoryBrowserError && err.name === "MemoryConflict") this.sendError(res, 409, err.message);
        else if (err instanceof MemoryDeleteError && err.reason === "session_running") this.sendError(res, 409, err.message);
        else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // ---- POST ----
    if (method === "POST") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      // 手机端 Cue 式界面（B 批）写接口：邀请码发放/吊销、Bot Mode 开关。
      // 机主手机（设备 token）也能做，与群聊发消息同级；不管设备。
      if (path === "/api/mobile/invites") {
        try {
          const note = typeof body.note === "string" ? body.note : "";
          const rec = createInvite(this.home, note);
          const quota = inviteQuota(this.home);
          this.sendJson(res, 201, { invite: rec, total: quota.total, used: quota.used, remaining: quota.remaining, cloudReady: false });
        } catch (err) {
          this.sendError(res, err instanceof InviteError ? 400 : 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      const inviteRevokeMatch = /^\/api\/mobile\/invites\/([A-Za-z0-9]{6})\/revoke$/.exec(path);
      if (inviteRevokeMatch) {
        try {
          const rec = revokeInvite(this.home, inviteRevokeMatch[1]);
          const quota = inviteQuota(this.home);
          this.sendJson(res, 200, { invite: rec, total: quota.total, used: quota.used, remaining: quota.remaining });
        } catch (err) {
          this.sendError(res, err instanceof InviteError ? 400 : 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/mobile/bot-mode") {
        if (typeof body.enabled !== "boolean") {
          this.sendError(res, 400, "enabled 必须是 true/false");
          return;
        }
        const state = setBotMode(this.home, body.enabled);
        this.sendJson(res, 200, { enabled: state.enabled });
        return;
      }
      if (path === "/api/pair/start") {
        if (!isOwner) { this.sendError(res, 403, "只能在电脑上管理已配对设备"); return; }
        try { this.sendJson(res, 200, this.startPairing()); }
        catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      // 撤销“不再询问”规则：只会收紧权限，手机也可以做。
      const ruleRevokeMatch = /^\/api\/rules\/([A-Za-z0-9-]{1,40})\/revoke$/.exec(path);
      if (ruleRevokeMatch) {
        if (!this.revokeRule(ruleRevokeMatch[1])) { this.sendError(res, 404, "规则不存在"); return; }
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/api/keys" || path === "/api/keys/test" || path === "/api/keys/remove" || path === "/api/settings") {
        if (!isOwner) { this.sendError(res, 403, path === "/api/settings" ? "设置只能在电脑上修改" : "API Key 只能在电脑上管理"); return; }
        const provider = String(body.provider ?? "").trim();
        try {
          if (path === "/api/settings") { this.sendJson(res, 200, this.applySettings(body)); return; }
          if (!provider) { this.sendError(res, 400, "请指定 provider"); return; }
          if (path === "/api/keys") { this.sendJson(res, 200, this.saveKey(provider, body.key)); return; }
          if (path === "/api/keys/remove") { this.sendJson(res, 200, { ok: this.deleteKey(provider) }); return; }
          this.sendJson(res, 200, await this.testKey(provider, body.key, typeof body.model === "string" ? body.model : null));
        } catch (err) {
          this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      const revokeMatch = /^\/api\/devices\/([^/]+)\/revoke$/.exec(path);
      if (revokeMatch) {
        if (!isOwner) { this.sendError(res, 403, "只能在电脑上管理已配对设备"); return; }
        if (!/^[0-9a-f]{16}$/.test(revokeMatch[1])) { this.sendError(res, 400, "设备 id 无效"); return; }
        if (!this.devices.revoke(revokeMatch[1])) { this.sendError(res, 404, "设备不存在"); return; }
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/api/memory") {
        try {
          const result = memorySave(
            this.home,
            String(body.scope ?? "global"),
            typeof body.room === "string" ? body.room : null,
            typeof body.bot === "string" ? body.bot : null,
            String(body.revision ?? ""), String(body.content ?? ""),
          );
          this.sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof MemoryBrowserError && err.name === "MemoryConflict") this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/sessions") { this.sendJson(res, 201, { id: this.newSession() }); return; }
      if (path === "/api/provider") {
        const name = String(body.provider ?? "").trim();
        if (!name) { this.sendError(res, 400, "请指定 provider"); return; }
        try {
          const switched = this.setProvider(name, typeof body.model === "string" ? body.model.trim() || null : null);
          this.sendJson(res, 200, switched);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      if (method === "POST" && path === "/api/mode/confirm") {
        if (!isOwner) { this.sendError(res, 403, "只能在电脑上确认完全模式请求"); return; }
        const requestId = String(body.request_id ?? "");
        const approve = body.approve === true;
        const decision = this.fullModeRequests.decide(requestId, approve);
        if (decision === null) { this.sendError(res, 404, "请求不存在或已过期"); return; }
        if (!decision) { this.sendJson(res, 200, { rejected: true }); return; }
        try {
          const mode = this.setMode("full");
          this.sendJson(res, 200, { mode });
        } catch (err) {
          if (err instanceof Error && err.message.includes("正在执行")) this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/mode") {
        // 手机切到全权模式：手机自己的两次确认不够，须电脑上再确认一次。
        // 非机主请求 full 只记一笔待确认请求（202），模式不动；机主在电脑上
        // 用 `nyra gw mode-confirm <id>` 批了才生效。手机发来的 confirm 标记
        // 不再采信（手机自己断言的不算确认）。已经是 full 时直接回 200。
        if (!isOwner && String(body.mode ?? "") === "full") {
          if (this.mode === "full") { this.sendJson(res, 200, { mode: "full" }); return; }
          const deviceName = typeof who === "object" && who !== null && typeof (who as Record<string, unknown>).name === "string"
            ? String((who as Record<string, unknown>).name) : "手机";
          const req = this.fullModeRequests.request(deviceName);
          this.sendJson(res, 202, {
            pending: true,
            request_id: req.id,
            expires_at: new Date(req.expiresAt * 1000).toISOString(),
            message: "已发送给电脑确认，请在电脑上确认（10 分钟内有效）",
          });
          return;
        }
        try {
          const mode = this.setMode(String(body.mode ?? ""));
          this.sendJson(res, 200, { mode });
        } catch (err) {
          if (err instanceof Error && err.message.includes("正在执行")) this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/schedule") {
        try {
          const result = this.scheduleAction(String(body.action ?? ""), String(body.name ?? ""));
          this.sendJson(res, 200, result);
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          this.sendError(res, status, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/mcp/call") {
        const tool = String(body.tool ?? "");
        const args = (body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments))
          ? body.arguments as Record<string, unknown> : {};
        if (!tool) { this.sendError(res, 400, "请指定 MCP 工具"); return; }
        try {
          const result = await this.mcpCall(tool, args);
          this.sendJson(res, 200, result);
        } catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      if (path === "/api/groups") {
        try {
          const bots = (body.bots as BotConfig[] | null | undefined) ?? null;
          const room = this.groups.create(String(body.id ?? ""), String(body.name ?? ""), bots);
          this.sendJson(res, 201, room);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const groupMsgMatch = /^\/api\/groups\/([a-z][a-z0-9_-]{0,31})\/messages$/.exec(path);
      if (groupMsgMatch) {
        try {
          const rounds = body.rounds === undefined ? 1 : Number(body.rounds);
          if (body.async === true) {
            // 手机群聊页：不等成员回答完，立刻回 202；回答逐条进群事件流（GET /api/groups/:id/events）。
            this.groups.get(groupMsgMatch[1]);
            this.sendGroupAsync(groupMsgMatch[1], String(body.text ?? ""), rounds);
            // H1：群聊回合也记客户端（202 接受时记，回答是异步跑的）。
            this.noteRoundClient(`group-${groupMsgMatch[1]}`, who, "group");
            this.sendJson(res, 202, { room: groupMsgMatch[1], accepted: true });
            return;
          }
          const result = await this.groups.send(groupMsgMatch[1], String(body.text ?? ""), rounds);
          // H1：群聊回合记客户端。
          this.noteRoundClient(`group-${groupMsgMatch[1]}`, who, "group");
          this.sendJson(res, 200, result);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const sendMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
      if (sendMatch) {
        const sid = this.validSid(sendMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const text = String(body.text ?? "").trim();
        if (!text) { this.sendError(res, 400, "消息不能为空"); return; }
        try {
          const run = this.send(sid, text);
          // H1：每条会话回合记是哪个客户端发的（审计 + 最近客户端账本）。
          // send 抛错（409 正在跑）时不记；转人工静默也记——消息确实是这个
          // 客户端发来的，只是 bot 没回。
          this.noteRoundClient(sid, who, "session");
          this.sendJson(res, 202, { id: sid, status: run.status, error: run.error });
        } catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path);
      if (stopMatch) {
        const sid = this.validSid(stopMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        // P0-3 窗口停止按钮：不在跑时不抛错（停止是幂等的）；在跑时发取
        // 消信号就返回，界面先显示“正在停止”，底层落定后再变已停止。
        this.sendJson(res, 200, this.stopSession(sid));
        return;
      }
      const planMatch = /^\/api\/sessions\/([^/]+)\/plan$/.exec(path);
      if (planMatch) {
        const sid = this.validSid(planMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const text = String(body.text ?? "").trim();
        if (!text) { this.sendError(res, 400, "任务不能为空"); return; }
        try {
          const run = this.plan(sid, text);
          this.sendJson(res, 202, { id: sid, status: run.status, error: run.error });
        } catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const execMatch = /^\/api\/sessions\/([^/]+)\/plan\/execute$/.exec(path);
      if (execMatch) {
        const sid = this.validSid(execMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const digest = String(body.sha256 ?? "");
        if (!SHA256_RE.test(digest)) { this.sendError(res, 400, "需要完整的 64 位 SHA-256 计划校验值"); return; }
        try {
          const run = this.executePlan(sid, digest);
          this.sendJson(res, 202, { id: sid, status: run.status, error: run.error });
        } catch (err) {
          if (err instanceof Error && err.message.includes("正在执行")) this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      const rewindMatch = /^\/api\/sessions\/([^/]+)\/rewind$/.exec(path);
      if (rewindMatch) {
        const sid = this.validSid(rewindMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const run = this.getRun(sid, false);
        if (run && run.status === "running") { this.sendError(res, 409, "会话正在执行，先停下再回退"); return; }
        const messageId = Number(body.message_id);
        const action = String(body.action ?? "") as RewindAction;
        if (!Number.isInteger(messageId) || messageId <= 0) { this.sendError(res, 400, "message_id 无效"); return; }
        if (!["truncate", "edit", "fork"].includes(action)) { this.sendError(res, 400, "未知的回退操作"); return; }
        try {
          const result = this.rewindSession(sid, messageId, action, typeof body.text === "string" ? body.text : null);
          this.sendJson(res, 200, result);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const decideMatch = /^\/api\/approvals\/([0-9a-f]{16})$/.exec(path);
      if (decideMatch) {
        try {
          const ok = this.decide(decideMatch[1], Boolean(body.approve), Boolean(body.always), { scope: body.scope, feedback: body.feedback });
          if (!ok) { this.sendError(res, 404, "审批已失效"); return; }
          this.sendJson(res, 200, { ok: true });
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      // 缺口 3b：审阅队列批复/验证/应用。批复人记 token 持有人：本机 owner 或
      // 已配对设备名；每一次批复都进证据链（decideReviewItem 内记
      // review_decision 事件或 evidence/review/ 证据文件）。fail-closed：
      // 非 pending 的项批复会回 400，状态原样不动。
      const reviewActionMatch = /^\/api\/review\/([0-9a-f]{16})\/(decide|apply|verify)$/.exec(path);
      if (reviewActionMatch) {
        const [, reviewId, action] = reviewActionMatch;
        const by = isOwner
          ? "owner（本机）"
          : `device:${String((who as Record<string, unknown>).name ?? (who as Record<string, unknown>).id ?? "unknown")}`;
        try {
          if (action === "decide") {
            if (typeof body.approve !== "boolean") { this.sendError(res, 400, "decide 需要 approve（true/false）"); return; }
            const { item } = decideReviewItem(this.home, reviewId, body.approve ? "approved" : "rejected", {
              by, note: typeof body.note === "string" ? body.note : null,
            });
            this.sendJson(res, 200, { ok: true, item });
          } else if (action === "apply") {
            const { item, appliedFiles } = applyReviewItem(this.home, reviewId, { by });
            this.sendJson(res, 200, { ok: true, item, applied_files: appliedFiles });
          } else {
            const { item } = await verifyReviewItem(this.home, reviewId);
            this.sendJson(res, 200, { ok: true, item });
          }
        } catch (err) {
          if (err instanceof ReviewQueueError && err.message.includes("不存在")) this.sendError(res, 404, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      this.sendError(res, 404, "未找到");
      return;
    }

    this.sendError(res, 404, "未找到");
  }

  // -- 总指挥 / 团队 / 群事件（第 1 阶段，docs/chief.md） --------------------
  /** 团队分派：过三道门、拿 lead 租约，起一个 chief 会话（审批照常进手机“待你决定”）。返回会话 id = run_id。 */
  async dispatchTeam(idOrName: string, task: string): Promise<{ run_id: string; team_id: string; epoch: number | null; status: string; error: string }> {
    const { plan, chiefTask } = await prepareTeamDispatch(this.home, idOrName, task);
    const sid = this.newSession();
    this.teamRuns.set(sid, { team_id: plan.team.id, team_name: plan.team.name, chief: plan.chief, epoch: plan.epoch ?? null, task: plan.task, created_at: new Date().toISOString() });
    const run = this.send(sid, chiefTask, { soulAgent: plan.chief, teamId: plan.team.id, teamEpoch: plan.epoch ?? null, display: plan.task });
    this.record(run, "team_dispatched", { team_id: plan.team.id, chief: plan.chief, members: plan.members.length, epoch: plan.epoch ?? null });
    return { run_id: sid, team_id: plan.team.id, epoch: plan.epoch ?? null, status: run.status, error: run.error };
  }

  /** 总指挥建群后的分派：后台跑，事件进群事件流。 */
  startChiefRun(runId: string, roomId: string): void {
    this.groupEvents.push(roomId, "chief_started", { run_id: runId });
    void runChiefGroup(this.home, this.groups, runId, (type, data) => { this.groupEvents.push(roomId, type, data); })
      .catch((err) => { this.groupEvents.push(roomId, "chief_failed", { run_id: runId, error: err instanceof Error ? err.message : String(err) }); });
  }

  /** 群里异步发一条消息（手机群聊页用）：立刻回 202，成员回答逐条进事件流。 */
  sendGroupAsync(roomId: string, text: string, rounds: number): void {
    this.groupEvents.push(roomId, "group_send_started", { text: text.slice(0, 200) });
    void this.groups.send(roomId, text, rounds, { onEntry: (entry: RoomMessage) => { this.groupEvents.push(roomId, "group_reply", { sender: entry.sender, error: Boolean(entry.error) }); } })
      .then((r) => { this.groupEvents.push(roomId, "group_send_done", { total: r.total }); })
      .catch((err) => { this.groupEvents.push(roomId, "group_send_failed", { error: err instanceof Error ? err.message : String(err) }); });
  }

  private groupView(roomId: string): Record<string, unknown> {
    const room = this.groups.get(roomId);
    const keys = assignMascots(room.bots.map((b) => b.id));
    const runs = listChiefRuns(this.home, roomId);
    return {
      ...room,
      bots: room.bots.map((b) => ({ ...b, mascot: keys[b.id] })),
      chief: runs[0] ?? null,
      events_next: this.groupEvents.since(roomId, Number.MAX_SAFE_INTEGER).next,
    };
  }

  private teamRunView(sid: string): Record<string, unknown> | null {
    const meta = this.teamRuns.get(sid);
    if (!meta) return null;
    const run = this.getRun(sid, false);
    const msgs = this.sessionMessages(sid);
    const last = [...msgs].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content);
    return { run_id: sid, ...meta, status: run?.status ?? "idle", error: run?.error ?? "", output: run?.status === "done" && last ? String(last.content) : null };
  }

  /** 团队 / 总指挥 / 群事件路由（鉴权之后调用）；处理了返回 true。 */
  private async chiefRoutes(method: string, path: string, query: URLSearchParams, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const fail = (err: unknown, status = 400) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendError(res, status, msg);
    };
    if (method === "GET" && path === "/api/teams") {
      try {
        const teams = listTeams(this.home).map((t) => {
          const keys = assignMascots(t.members);
          return { ...publicTeam(t), mascots: { chief: "chief", ...keys } };
        });
        this.sendJson(res, 200, { teams });
      } catch (err) { fail(err); }
      return true;
    }
    const teamRunMatch = /^\/api\/teams\/runs\/([^/]+)(\/events)?$/.exec(path);
    if (method === "GET" && teamRunMatch) {
      const sid = this.validSid(teamRunMatch[1]);
      if (!sid || !this.teamRuns.has(sid)) { this.sendError(res, 404, "没有这个团队分派"); return true; }
      if (teamRunMatch[2]) {
        let since = 0;
        try { since = Math.max(0, Number(query.get("since") ?? "0") || 0); } catch { since = 0; }
        this.streamEvents(req, res, sid, since);
        return true;
      }
      this.sendJson(res, 200, this.teamRunView(sid));
      return true;
    }
    const teamMatch = /^\/api\/teams\/([^/]+)(\/dispatch)?$/.exec(path);
    if (teamMatch && !teamRunMatch) {
      const idOrName = decodeURIComponent(teamMatch[1]);
      if (method === "GET" && !teamMatch[2]) {
        const team = getTeam(this.home, idOrName);
        if (!team) { this.sendError(res, 404, `找不到团队 ${idOrName}`); return true; }
        this.sendJson(res, 200, { ...publicTeam(team), mascots: { chief: "chief", ...assignMascots(team.members) } });
        return true;
      }
      if (method === "POST" && teamMatch[2]) {
        let body: Record<string, unknown>;
        try { body = await this.readBody(req); } catch (err) { fail(err); return true; }
        try {
          const out = await this.dispatchTeam(idOrName, String(body.task ?? ""));
          this.sendJson(res, 202, out);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fail(err, err instanceof TeamError && /找不到团队/.test(msg) ? 404 : err instanceof TeamError && /分派被拒|已解散|硬顶/.test(msg) ? 409 : 400);
        }
        return true;
      }
    }
    if (method === "GET" && path === "/api/chief") {
      try {
        const { team, candidates } = chiefCandidates(this.home, query.get("team"));
        const runs = listChiefRuns(this.home).slice(0, 20);
        this.sendJson(res, 200, {
          max: CHIEF_MAX_MEMBERS, permission: CHIEF_PERMISSION,
          team: team ? publicTeam(team) : null, candidates,
          runs, running: runs.filter((r) => r.status === "running").length,
        });
      } catch (err) { fail(err); }
      return true;
    }
    if (method === "POST" && path === "/api/chief/proposals") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { fail(err); return true; }
      try { this.sendJson(res, 200, proposeChiefGroup(this.home, body.task, { team: typeof body.team === "string" ? body.team : null })); }
      catch (err) { fail(err); }
      return true;
    }
    if (method === "POST" && path === "/api/chief/groups") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { fail(err); return true; }
      try {
        const { run, room } = createChiefGroup(this.home, this.groups, {
          task: body.task, members: body.members, title: body.title,
          team: typeof body.team === "string" ? body.team : null,
        });
        if (body.start !== false) this.startChiefRun(run.id, run.room_id);
        this.sendJson(res, 201, { run, room: { id: room.id, name: room.name } });
      } catch (err) { fail(err, err instanceof ChiefError ? 400 : 400); }
      return true;
    }
    const chiefRunMatch = /^\/api\/chief\/runs\/(chief_[0-9a-f]{12})$/.exec(path);
    if (method === "GET" && chiefRunMatch) {
      const run = getChiefRun(this.home, chiefRunMatch[1]);
      if (!run) { this.sendError(res, 404, "没有这个总指挥任务"); return true; }
      this.sendJson(res, 200, run);
      return true;
    }
    const gid = /^\/api\/groups\/([a-z][a-z0-9_-]{0,31})\/(plans|events|view)$/.exec(path);
    if (method === "GET" && gid) {
      const roomId = gid[1];
      try { this.groups.get(roomId); } catch (err) { this.sendError(res, 404, err instanceof Error ? err.message : String(err)); return true; }
      if (gid[2] === "plans") {
        try { this.sendJson(res, 200, { plans: listGroupPlans(this.home, roomId), chief_runs: listChiefRuns(this.home, roomId) }); }
        catch (err) { fail(err); }
        return true;
      }
      if (gid[2] === "view") { this.sendJson(res, 200, this.groupView(roomId)); return true; }
      let since = 0;
      try { since = Math.max(0, Number(query.get("since") ?? "0") || 0); } catch { since = 0; }
      if (query.get("format") === "json") { this.sendJson(res, 200, this.groupEvents.since(roomId, since)); return true; }
      this.streamGroupEvents(req, res, roomId, since);
      return true;
    }
    const planMatch = /^\/api\/plans\/(gplan_[0-9a-f]{12})$/.exec(path);
    if (method === "GET" && planMatch) {
      try {
        const plan = getGroupPlan(this.home, planMatch[1]);
        if (!plan) { this.sendError(res, 404, "没有这个计划"); return true; }
        this.sendJson(res, 200, plan);
      } catch (err) { fail(err); }
      return true;
    }
    return false;
  }

  private streamGroupEvents(req: IncomingMessage, res: ServerResponse, roomId: string, since: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    const write = (text: string): boolean => { try { res.write(text); return true; } catch { return false; } };
    write(": connected\n\n");
    let cursor = Math.max(0, since);
    let lastWrite = Date.now();
    let closed = false;
    req.on("close", () => { closed = true; clearInterval(timer); });
    const timer = setInterval(() => {
      if (closed) { clearInterval(timer); return; }
      const { events, next } = this.groupEvents.since(roomId, cursor);
      for (const e of events) {
        if (!write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)) return;
        lastWrite = Date.now();
      }
      cursor = Math.max(cursor, next);
      if (Date.now() - lastWrite >= 15000) { write(": heartbeat\n\n"); lastWrite = Date.now(); }
    }, 200);
    timer.unref?.();
  }

  private streamEvents(req: IncomingMessage, res: ServerResponse, sid: string, since: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    const write = (text: string): boolean => { try { res.write(text); return true; } catch { return false; } };
    write(": connected\n\n");
    let cursor = Math.max(0, since);
    let lastWrite = Date.now();
    let closed = false;
    req.on("close", () => { closed = true; clearInterval(timer); });
    const timer = setInterval(() => {
      if (closed) { clearInterval(timer); return; }
      try {
        const view = this.sessionView(sid, cursor) as unknown as {
          events: Record<string, unknown>[]; next: number; status: string; error: string;
        };
        for (const event of view.events) {
          if (!write("data: " + JSON.stringify(event) + "\n\n")) return;
          lastWrite = Date.now();
        }
        cursor = view.next;
        if (view.status === "done" || view.status === "error") {
          write("data: " + JSON.stringify({ type: "run_finished", data: { status: view.status, error: view.error }, ts: Date.now() / 1000 }) + "\n\n");
          clearInterval(timer);
          res.end();
          return;
        }
        if (Date.now() - lastWrite >= 15000) { write(": heartbeat\n\n"); lastWrite = Date.now(); }
      } catch { clearInterval(timer); try { res.end(); } catch { /* ignore */ } }
    }, 200);
    timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopScheduler();
    // 调研报告第 1 项：网关关停 = 全部 live 会话结束，为每个已开始的会话
    // 触发一次 SessionEnd（fireSessionEnd 自带去重；无钩子时立即返回）。
    // 这里 await 是有意的：关停后进程很快退出，不等钩子跑完就可能把它杀在半路。
    await Promise.allSettled(
      [...this.runs.values()].map((run) => this.fireSessionEnd(run) ?? Promise.resolve()),
    );
    if (this.discoverySocket) { try { this.discoverySocket.close(); } catch { /* ignore */ } this.discoverySocket = null; }
    if (this.mcpManager) { try { this.mcpManager.stopAll(); } catch { /* ignore */ } this.mcpManager = null; }
    if (this.server) {
      await new Promise<void>((resolve) => { this.server!.close(() => resolve()); });
      this.server = null;
    }
    try { this._store?.close(); } catch { /* ignore */ }
  }

  /**
   * 对话存档懒加载：构造/启动时不开 SQLite 库，首次访问会话历史时才建库
   * （第 4 阶段性能收尾：空闲 RSS 不为还没用到的存档付 SQLite 的页成本）。
   */
  get store(): ConversationStore {
    if (!this._store) this._store = new ConversationStore(this.home);
    return this._store;
  }
}
