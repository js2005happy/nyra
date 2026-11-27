// src/bot/types.ts — Bot 方向 Phase 1：双场景共用的 Bot 内核类型。
//
// 用户 2026-11-20 给的双场景架构：场景 A（外部社群/客服/办公 IM Bot）与
// 场景 B（个人/业务自动化监控与任务 Bot）复用同一套 Bot Core（会话队列 +
// 幂等去重 + 权限策略 + 模型/工具执行 + 成本计量），只在入口、策略与推送
// 上区分。本批只做 Phase 1：核心骨架 + Telegram 渠道；场景 B 的 notifier
// 与 Phase 2 的 router / approvalBridge 不在本批。
//
// 两条 key 的区分（不要混用）：
//   - sessionKey：Bot 内的会话标识，`telegram:<chatId>:<threadId>`（群聊）
//     或 `telegram:<senderId>`（私聊）；只用于队列、去重、配额与审计。
//   - memorySessionId：Agent 会话文件的 id，必须过 sessionPath 的校验
//     （不含 `:` `/` `\` 与 `..`），由 sessionKey 派生：`bot-telegram-…`。
//     会话历史与长期记忆按 memorySessionId 隔离，A 用户的上下文绝不进
//     B 用户的 Agent（Agent 自己按 sessionId 读写会话文件）。

export type BotChannel = "telegram" | "discord" | "slack" | "whatsapp";

export type BotChatType = "private" | "group" | "supergroup" | "channel";

/** Bot 角色（router.ts 认的权限档位）：owner（机主）/ admin（管理员）/ member（受信任用户）/ guest（默认外部用户）。 */
export type BotRole = "owner" | "admin" | "member" | "guest";

/** 适配器上报的发信人角色（渠道侧的说法，不可信：Telegram 适配器现在所有人都报 member，不能当权限依据，见 router.ts）。 */
export type BotSenderRole = "owner" | "admin" | "member" | "unknown";

/** 每角色可配的三项（步数/超时/提示词）；能不能发起/批准审批是硬边界，配置改不了。 */
export interface BotProfileOverride {
  maxTurns?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

/** 场景 B 主动推送配置（Phase 3；默认全关，只有配了 owner 才能开）。 */
export interface BotNotifierPolicy {
  enabled: boolean;
  /** 推送目标会话（Telegram chatId；私聊填 owner 的用户 id，群聊填群 id）。 */
  targetChatId: string | null;
  /** Heartbeat 巡查间隔（毫秒；默认 300000，夹在 60 秒到 1 小时之间）。 */
  heartbeatIntervalMs: number;
  /** 同一条件重复推送的冷却（毫秒；默认 3600000，夹在 60 秒到 24 小时之间）。 */
  notifyCooldownMs: number;
  /** 定时/队列任务完成时推什么：failures（只推失败，默认）/ all（成功也推）/ none。 */
  notifyTasks: "failures" | "all" | "none";
  /** 会话队列深度超过这个数就告警（默认 5）。 */
  queueDepthWarn: number;
  /** 有挂起审批超过这么多分钟没人批就提醒一次（默认 10）。 */
  pendingApprovalWarnMinutes: number;
  /** 文件监控：文件内容变了（哈希变了）就推一次，只报“变了”，不含文件内容。 */
  watches: { id: string; label: string; file: string }[];
}

export const DEFAULT_NOTIFIER_POLICY: BotNotifierPolicy = {
  enabled: false,
  targetChatId: null,
  heartbeatIntervalMs: 300000,
  notifyCooldownMs: 3600000,
  notifyTasks: "failures",
  queueDepthWarn: 5,
  pendingApprovalWarnMinutes: 10,
  watches: [],
};

/** 渠道归一化后的入站消息（各平台原始 payload 由适配器转成这一个形状）。 */
export interface InboundMessage {
  channel: BotChannel;
  /** 群聊：群 id；私聊：发信人 id（Telegram 私聊里 chatId 即 senderId）。 */
  chatId: string;
  /** 话题/子线程 id（Telegram 的 message_thread_id）；无话题时为 null。 */
  threadId: string | null;
  senderId: string;
  senderRole: BotSenderRole;
  /** 群聊里是否 @ 了本 Bot（mentionOnly 为 true 时的放行条件）。 */
  isMentioned: boolean;
  /** 平台侧消息 id（去重的键；平台超时重试会重发同一 id）。 */
  messageId: string;
  /** 正文（无正文时为空串；纯附件消息走 attachments）。 */
  text: string;
  /** 附件：类型与平台侧 file_id + 平台给的元信息（大小/类型/图片尺寸）；内容 Phase 3 才下载。 */
  attachments: { kind: string; fileId: string; name?: string; sizeBytes?: number; mimeType?: string; width?: number; height?: number; durationSeconds?: number }[];
  chatType: BotChatType;
  /** 平台侧时间戳（毫秒）。 */
  timestamp: number;
  /** 按钮回调来的消息（Phase 2）：正文是回调数据转成的指令（如 /approve <id>）。 */
  viaCallback?: boolean;
  /** 平台侧回调 id（回 ack 用，如 Telegram 的 answerCallbackQuery）。 */
  callbackId?: string;
}

/** Bot 发出的消息（适配器按平台限制落地）。 */
export interface OutgoingMessage {
  chatId: string;
  threadId: string | null;
  text: string;
  replyToMessageId?: string;
  /** 行内按钮（Phase 2 的审批提示用；平台不支持时忽略）。 */
  inlineKeyboard?: { text: string; callbackData: string }[][];
}

/** 渠道适配器：收（轮询或回调归一化）与发（文本/编辑）两件事。 */
export interface ChannelAdapter {
  readonly channel: BotChannel;
  /** 本 Bot 的用户名（群聊 @ 判定用；未拿到时为 null，mentionOnly 退化为看文本里的 @）。 */
  botUsername: string | null;
  /** 拉一次新消息并归一化（长轮询一批；回调渠道由网关调 handleMessage）。 */
  pollOnce(signal?: AbortSignal): Promise<InboundMessage[]>;
  /** 拿一次 Bot 自己的信息（id 与 username，供群聊 @ 判定）。 */
  getMe(): Promise<{ id: number; username: string | null }>;
  /** 发一条文本；返回平台侧消息 id（占位消息后续靠它编辑）。 */
  sendText(msg: OutgoingMessage): Promise<string>;
  /** 编辑一条已发消息（占位“处理中…”完成后更新）。 */
  editText(chatId: string, messageId: string, text: string): Promise<void>;
  /** 回应一次按钮点击（消掉客户端的等待转圈；平台不支持时忽略）。 */
  answerCallback?(callbackId: string, text: string): Promise<void>;
  /** 按平台侧 file_id 下载附件（返回字节；平台不支持或拿不到时抛错；Phase 3）。 */
  downloadFile?(fileId: string): Promise<{ bytes: Buffer; fileName?: string; mimeType?: string }>;
}

/** Bot 动作（Phase 2 的 approvalBridge 与 router 共用这一个动作表）。 */
export type BotAction =
  | { kind: "reply"; text: string }
  | { kind: "edit"; messageId: string; text: string }
  | { kind: "ignore"; reason: string }
  | { kind: "notice"; text: string };

/** Bot 安全与配额策略（config.json 的 `bot` 一节，见 botPolicyFromConfig）。 */
export interface BotPolicy {
  /** 本 Bot 跑在哪个 Soul 身份下（缺口 42 第二批：BotRunner 接线；与 Soul 的
   * agent id 同口径 `^[a-z][a-z0-9_-]{0,31}$`，非法值回默认 "nyra"）。
   * Bot 的电脑挂在这个身份下（每 agent 一台）；没配 Soul 时 Bot 照常跑，
   * 只不接电脑（工作目录仍是启动时的目录，并在启动时打一条提示）。 */
  agent: string;
  /** GROK-1：本 Bot 跑在哪个团队里（团队名或 id；null = 不在团队里）。
   * 配了团队时 Bot 只能是该团队的参谋长或成员（启动时校验，不在团队里
   * 直接报错、不静默跑成单机）；团队模式下 Bot 的对外动作一律回参谋长/
   * 人批（GROK-3 团队审批门）。 */
  team?: string | null;
  /** 群聊里只有被 @ 才响应（默认 true；私聊不受影响）。 */
  mentionOnly: boolean;
  /** 每次 Bot 回复最多走几轮 agent（默认 12；超了诚实收尾，不烧完）。 */
  maxTurns: number;
  /** 单条消息从入队到出结果的超时（毫秒；默认 120000；超时按取消处理）。 */
  timeoutMs: number;
  /** 单用户每天最多发几条进模型的消息（默认 100；确定性指令不计）。 */
  perUserDailyLimit: number;
  /** 单群聊每分钟最多几条进模型的消息（默认 10；防刷屏与洪峰）。 */
  perChatPerMinuteLimit: number;
  /** 每天 token 花费预算（美元；null = 不设；超了当天不再进模型）。 */
  dailyTokenBudgetUsd: number | null;
  /** 管理员的平台侧用户 id（/approve 等管理指令只认他们；Phase 1 先占位）。 */
  admins: string[];
  /** 机主的平台侧用户 id（唯一全权角色；null = 没配，机主档位空着）。 */
  owner: string | null;
  /** 受信任用户（member 档位：只读，但步数/超时比 guest 宽松）。 */
  members: string[];
  /** 一条审批挂起多久没人批就自动拒绝（毫秒；默认 60000；须小于 bot.timeout_ms 才有意义）。 */
  approvalTimeoutMs: number;
  /** 审批提示改发到哪个会话（chatId；null = 发到发起审批的当前会话）。 */
  approvalChatId: string | null;
  /** 按 chatId 覆盖系统提示词（特定群聊可以有自己的 Bot 人设，优先于按角色的）。 */
  chatSystemPrompts: Record<string, string>;
  /** 每角色可配的三项（步数/超时/提示词）；白名单与审批权限不在里面。 */
  profiles: Partial<Record<BotRole, BotProfileOverride>>;
  /** 场景 B 主动推送（Phase 3）：默认全关；开的条件见 notifier.ts（须配 owner + 目标会话）。 */
  notifier: BotNotifierPolicy;
  /** 单个附件下载上限（字节；默认 10MB，夹在 1KB 到 50MB 之间）。 */
  attachmentMaxBytes: number;
  /** 单个文本文档提取进上下文的字符上限（默认 20000，夹在 1000 到 100000 之间）。 */
  attachmentTextChars: number;
  /** Telegram 渠道开关与用户名（用户名用于群聊 @ 判定）。 */
  telegram: { enabled: boolean; username: string | null };
  /** Discord 渠道开关（@ 判定靠 mentions 数组，不需要用户名）。 */
  discord: { enabled: boolean };
  /** Slack 渠道开关（Socket Mode 收事件 + Web API 发消息，需要 app token + bot token）。 */
  slack: { enabled: boolean };
  /** WhatsApp 渠道开关（Cloud API 发消息 + webhook 收消息，需要 access token + 号码 id + 公网入口）。 */
  whatsapp: { enabled: boolean };
}

export const DEFAULT_BOT_POLICY: BotPolicy = {
  agent: "nyra",
  team: null,
  mentionOnly: true,
  maxTurns: 12,
  timeoutMs: 120000,
  perUserDailyLimit: 100,
  perChatPerMinuteLimit: 10,
  dailyTokenBudgetUsd: null,
  admins: [],
  owner: null,
  members: [],
  approvalTimeoutMs: 60000,
  approvalChatId: null,
  chatSystemPrompts: {},
  profiles: {},
  notifier: { ...DEFAULT_NOTIFIER_POLICY },
  attachmentMaxBytes: 10 * 1024 * 1024,
  attachmentTextChars: 20000,
  telegram: { enabled: false, username: null },
  discord: { enabled: false },
  slack: { enabled: false },
  whatsapp: { enabled: false },
};

function asNonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function asPosInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** 从 config.json 的 `bot` 一节解析策略；缺失/非法值一律回默认值，不抛错。 */
export function botPolicyFromConfig(config: Record<string, unknown>): BotPolicy {
  const raw = (config as Record<string, unknown>).bot;
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tg = b.telegram && typeof b.telegram === "object" && !Array.isArray(b.telegram)
    ? (b.telegram as Record<string, unknown>)
    : {};
  const asIdList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const asId = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  // 审批 TTL 夹在 5 秒到 10 分钟之间：太短人来不及批、太长挂起的写操作占着 Agent 的轮次超时（bot.timeout_ms）也没意义。
  const approvalTimeoutMs = Math.min(600000, Math.max(5000, asPosInt(b.approval_timeout_ms, DEFAULT_BOT_POLICY.approvalTimeoutMs)));
  const chatSystemPrompts: Record<string, string> = {};
  const csp = b.chat_system_prompts;
  if (csp && typeof csp === "object" && !Array.isArray(csp)) {
    for (const [k, v] of Object.entries(csp as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() && k.trim()) chatSystemPrompts[k.trim()] = v.slice(0, 4000);
    }
  }
  const profiles: Partial<Record<BotRole, BotProfileOverride>> = {};
  const rawProfiles = b.profiles;
  if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
    for (const role of ["owner", "admin", "member", "guest"] as const) {
      const p = (rawProfiles as Record<string, unknown>)[role];
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      const over: BotProfileOverride = {};
      const po = p as Record<string, unknown>;
      if (typeof po.max_turns === "number" && Number.isFinite(po.max_turns) && po.max_turns > 0) over.maxTurns = Math.floor(po.max_turns);
      if (typeof po.timeout_ms === "number" && Number.isFinite(po.timeout_ms) && po.timeout_ms > 0) over.timeoutMs = Math.floor(po.timeout_ms);
      if (typeof po.system_prompt === "string" && po.system_prompt.trim()) over.systemPrompt = po.system_prompt.slice(0, 4000);
      if (over.maxTurns !== undefined || over.timeoutMs !== undefined || over.systemPrompt !== undefined) profiles[role] = over;
    }
  }
  // Phase 3：notifier 配置解析；缺失/非法值一律回默认值，不抛错。
  const notifier: BotNotifierPolicy = { ...DEFAULT_NOTIFIER_POLICY, watches: [] };
  const rawNotifier = b.notifier;
  if (rawNotifier && typeof rawNotifier === "object" && !Array.isArray(rawNotifier)) {
    const n = rawNotifier as Record<string, unknown>;
    notifier.enabled = n.enabled === true;
    notifier.targetChatId = asId(n.target_chat_id);
    notifier.heartbeatIntervalMs = Math.min(3600000, Math.max(60000, asPosInt(n.heartbeat_interval_ms, DEFAULT_NOTIFIER_POLICY.heartbeatIntervalMs)));
    notifier.notifyCooldownMs = Math.min(86400000, Math.max(60000, asPosInt(n.notify_cooldown_ms, DEFAULT_NOTIFIER_POLICY.notifyCooldownMs)));
    if (n.notify_tasks === "all" || n.notify_tasks === "none") notifier.notifyTasks = n.notify_tasks;
    notifier.queueDepthWarn = asNonNegInt(n.queue_depth_warn, DEFAULT_NOTIFIER_POLICY.queueDepthWarn);
    notifier.pendingApprovalWarnMinutes = asNonNegInt(n.pending_approval_warn_minutes, DEFAULT_NOTIFIER_POLICY.pendingApprovalWarnMinutes);
    if (Array.isArray(n.watches)) {
      for (const w of n.watches as unknown[]) {
        if (!w || typeof w !== "object" || Array.isArray(w)) continue;
        const wo = w as Record<string, unknown>;
        const id = typeof wo.id === "string" && wo.id.trim() ? wo.id.trim().slice(0, 64) : "";
        const file = typeof wo.file === "string" && wo.file.trim() ? wo.file.trim() : "";
        if (!id || !file) continue;
        const label = typeof wo.label === "string" && wo.label.trim() ? wo.label.trim().slice(0, 120) : id;
        if (notifier.watches.some((x) => x.id === id)) continue;
        notifier.watches.push({ id, label, file });
      }
    }
  }
  return {
    // 缺口 42 第二批：Bot 的 Soul 身份（电脑挂在它下面）；与 SOUL_AGENT_ID_RE
    // 同口径，非法值回默认，不抛错（与本文件其他配置项的容错口径一致）。
    agent: typeof b.agent === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(b.agent.trim())
      ? b.agent.trim()
      : DEFAULT_BOT_POLICY.agent,
    // GROK-1：团队名或 id（空 = 不在团队里）；只做字符串归一化，存在性与
    // 成员身份在 BotRunner 启动时校验（不在团队里直接报错）。
    team: asId(b.team),
    mentionOnly: b.mention_only === false ? false : DEFAULT_BOT_POLICY.mentionOnly,
    maxTurns: asPosInt(b.max_turns, DEFAULT_BOT_POLICY.maxTurns),
    timeoutMs: asPosInt(b.timeout_ms, DEFAULT_BOT_POLICY.timeoutMs),
    perUserDailyLimit: asNonNegInt(b.per_user_daily_limit, DEFAULT_BOT_POLICY.perUserDailyLimit),
    perChatPerMinuteLimit: asNonNegInt(b.per_chat_per_minute_limit, DEFAULT_BOT_POLICY.perChatPerMinuteLimit),
    dailyTokenBudgetUsd:
      typeof b.daily_token_budget_usd === "number" && Number.isFinite(b.daily_token_budget_usd) && b.daily_token_budget_usd >= 0
        ? b.daily_token_budget_usd
        : null,
    admins: asIdList(b.admins),
    owner: asId(b.owner),
    members: asIdList(b.members),
    approvalTimeoutMs,
    approvalChatId: asId(b.approval_chat_id),
    chatSystemPrompts,
    profiles,
    notifier,
    attachmentMaxBytes: Math.min(50 * 1024 * 1024, Math.max(1024, asPosInt(b.attachment_max_bytes, DEFAULT_BOT_POLICY.attachmentMaxBytes))),
    attachmentTextChars: Math.min(100000, Math.max(1000, asPosInt(b.attachment_text_chars, DEFAULT_BOT_POLICY.attachmentTextChars))),
    telegram: {
      enabled: tg.enabled === true,
      username: typeof tg.username === "string" && tg.username.trim() ? tg.username.trim().replace(/^@/, "") : null,
    },
    discord: {
      enabled: b.discord && typeof b.discord === "object" && !Array.isArray(b.discord)
        ? (b.discord as Record<string, unknown>).enabled === true
        : false,
    },
    slack: {
      enabled: b.slack && typeof b.slack === "object" && !Array.isArray(b.slack)
        ? (b.slack as Record<string, unknown>).enabled === true
        : false,
    },
    whatsapp: {
      enabled: b.whatsapp && typeof b.whatsapp === "object" && !Array.isArray(b.whatsapp)
        ? (b.whatsapp as Record<string, unknown>).enabled === true
        : false,
    },
  };
}

/** Bot 总开关：`bot.enabled` 或任一渠道开着才算开（默认全关）。 */
export function botEnabled(config: Record<string, unknown>): boolean {
  const raw = (config as Record<string, unknown>).bot;
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tg = b.telegram && typeof b.telegram === "object" && !Array.isArray(b.telegram)
    ? (b.telegram as Record<string, unknown>)
    : {};
  const dc = b.discord && typeof b.discord === "object" && !Array.isArray(b.discord)
    ? (b.discord as Record<string, unknown>)
    : {};
  const sl = b.slack && typeof b.slack === "object" && !Array.isArray(b.slack)
    ? (b.slack as Record<string, unknown>)
    : {};
  const wa = b.whatsapp && typeof b.whatsapp === "object" && !Array.isArray(b.whatsapp)
    ? (b.whatsapp as Record<string, unknown>)
    : {};
  return b.enabled === true || tg.enabled === true || dc.enabled === true || sl.enabled === true || wa.enabled === true;
}

/** 会话 key：群聊按 channel:chatId:threadId，私聊按 channel:senderId。 */
export function sessionKeyFor(msg: Pick<InboundMessage, "channel" | "chatId" | "threadId" | "senderId" | "chatType">): string {
  if (msg.chatType === "private") return `${msg.channel}:${msg.senderId}`;
  return `${msg.channel}:${msg.chatId}:${msg.threadId ?? "0"}`;
}

/**
 * Agent 会话文件 id：sessionPath 禁 `:` `/` `\` 与 `..`，所以把 sessionKey
 * 里除字母数字与 `-` `_` 之外的字符都换成 `-`，再加 `bot-` 前缀。
 * 同一个 sessionKey 永远得到同一个 id；不同 sessionKey 不会撞上：
 * chatId / threadId / senderId 都是纯整数（群 id 可带一个前导 `-`），
 * 所以 `:` 换成 `-` 后映射仍是单射的——私聊 key 只有一个数字段，
 * 群聊 key 恒有两个数字段，两边不可能拼出同一个 id。
 */
export function memorySessionIdFor(sessionKey: string): string {
  const safe = sessionKey.replace(/[^A-Za-z0-9_-]/g, "-");
  return `bot-${safe}`;
}
