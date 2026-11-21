// src/channels/gateway.ts — 常驻多渠道网关（缺口 27）。
//
// 一个进程、四个渠道：每渠道一个适配器（复用 src/bot/channels/ 的四个
// 适配器，不另起一套），每条绑定一个被动式 BotRunner（只调公开的
// handleMessage，不调 startPolling——轮询循环由网关自己跑，复用同一套
// 退避口径：失败 1 秒起、翻倍、上限 30 秒）。
//
// 入站链路：适配器 pollOnce → bindings 确定性路由 → 命中交给对应 runner
// 的 handleMessage；路由决定（routed / dropped，带 binding_id / rule /
// reason）写 bot-audit.jsonl——这就是渠道证据链，进 SIEM 导出第 8 个来源。
// 对外发送永远走 runner 自己的审批门，路由只决定“谁接”，不决定“能不能发”。
//
// 常驻形态：前台进程 + pidfile（`~/.nyra/channel-gateway.pid`，与
// `nyra bot <渠道> start` 同款做法）；状态文件
// `~/.nyra/channel-gateway-status.json` 每 5 秒最多写一次，供
// `nyra channels status` 读。Ctrl+C / SIGTERM 停掉轮询与全部 runner 的
// 后台服务，再删 pidfile。
//
// WhatsApp 注意：适配器的 pollOnce 只出队 webhook 已转进来的消息——没有
// 公网回调 URL 把 Meta 的 POST 转发进 handleWebhook，WhatsApp 就收不到
// 消息（见 kind 的 environment 说明）。网关不内置 webhook 服务器。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "../memory.ts";
import { botPolicyFromConfig, type BotChannel } from "../bot/types.ts";
import {
  appendBotAudit,
  BotRunner,
  type BotStatus,
  resolveDiscordToken,
  resolveSlackTokens,
  resolveTelegramToken,
  resolveWhatsAppCredentials,
} from "../bot/index.ts";
import { TelegramAdapter } from "../bot/channels/telegram.ts";
import { DiscordAdapter } from "../bot/channels/discord.ts";
import { SlackAdapter } from "../bot/channels/slack.ts";
import { WhatsAppAdapter } from "../bot/channels/whatsapp.ts";
import type { ChannelAdapter, InboundMessage } from "../bot/types.ts";
import { channelKindFor } from "./kind.ts";
import { defaultBinding, loadBindingStore, routeInbound, type ChannelBinding, type RouteInput } from "./bindings.ts";
import { checkCircleInbound } from "../circles.ts";

export const CHANNEL_GATEWAY_PID_FILE = "channel-gateway.pid";
export const CHANNEL_GATEWAY_STATUS_FILE = "channel-gateway-status.json";

const GATEWAY_CHANNELS: BotChannel[] = ["telegram", "discord", "slack", "whatsapp"];
const STATUS_WRITE_MIN_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function gatewayPidPath(home: string): string {
  return join(resolveNyraHome(home), CHANNEL_GATEWAY_PID_FILE);
}

/** 读网关 pidfile：没有、不是数字、进程已死都返回 null。 */
export function readGatewayPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(gatewayPidPath(home), "utf-8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

function writeGatewayPid(home: string): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(gatewayPidPath(home), `${process.pid}\n`, { encoding: "utf-8", mode: 0o600 });
}

function removeGatewayPid(home: string): void {
  try { rmSync(gatewayPidPath(home), { force: true }); } catch { /* ignore */ }
}

export interface GatewayStatusFile {
  pid: number;
  startedAt: string | null;
  updatedAt: string;
  channels: GatewayChannelState[];
}

/** 读网关状态文件：没有或损坏返回 null（不抛错）。 */
export function readGatewayStatusFile(home: string): GatewayStatusFile | null {
  try {
    const raw = readFileSync(join(resolveNyraHome(home), CHANNEL_GATEWAY_STATUS_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.channels)) return null;
    return parsed as unknown as GatewayStatusFile;
  } catch {
    return null;
  }
}

/**
 * 按 token 解析建一个渠道适配器（不联网：构造只存 token，连接在 pollOnce 里）。
 * token 未配或构造失败返回 null。网关与 `nyra channels health` 共用。
 */
export function buildChannelAdapter(channel: BotChannel, home: string): ChannelAdapter | null {
  try {
    if (channel === "telegram") {
      const { token } = resolveTelegramToken(home);
      if (!token) return null;
      return new TelegramAdapter({ token });
    }
    if (channel === "discord") {
      const { token } = resolveDiscordToken(home);
      if (!token) return null;
      return new DiscordAdapter({ token });
    }
    if (channel === "slack") {
      const { appToken, botToken } = resolveSlackTokens(home);
      if (!appToken || !botToken) return null;
      return new SlackAdapter({ appToken, botToken });
    }
    const { token, phoneNumberId } = resolveWhatsAppCredentials(home);
    if (!token || !phoneNumberId) return null;
    return new WhatsAppAdapter({ token, phoneNumberId });
  } catch {
    return null;
  }
}

/** 网关要的 runner 能力（BotRunner 全满足；测试注入假 runner 用）。 */
export interface ChannelRunner {
  readonly agent: string;
  readonly bindingId: string | null;
  handleMessage(msg: InboundMessage): Promise<void>;
  startServices(opts?: { notifier?: boolean }): void;
  stopServices(): void;
  status(): BotStatus;
}

export interface GatewayRunnerState {
  bindingId: string;
  agent: string;
  queueDepth: number;
  activeSessions: string[];
}

export interface GatewayChannelState {
  channel: BotChannel;
  started: boolean;
  tokenPresent: boolean;
  /** 已启用的显式绑定数（0 表示只用隐式默认绑定）。 */
  bindings: number;
  runners: GatewayRunnerState[];
  lastPollOk: boolean | null;
  lastPollAt: string | null;
  routed: number;
  dropped: number;
  errors: number;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  channels: GatewayChannelState[];
}

export interface ChannelGatewayOptions {
  home: string;
  workdir: string;
  config: Record<string, unknown>;
  /** 注入的适配器构造（测试用假适配器；不传按 token 解析建真适配器）。 */
  createAdapter?: (channel: BotChannel) => ChannelAdapter | null;
  /** 注入的 runner 构造（测试用假 runner；不传按绑定建真 BotRunner）。 */
  createRunner?: (binding: ChannelBinding, adapter: ChannelAdapter) => ChannelRunner;
}

export class ChannelGateway {
  private readonly home: string;
  private readonly workdir: string;
  private readonly config: Record<string, unknown>;
  private readonly createAdapterFn: (channel: BotChannel) => ChannelAdapter | null;
  private readonly createRunnerFn: (binding: ChannelBinding, adapter: ChannelAdapter) => ChannelRunner;
  private running = false;
  private startedAt: string | null = null;
  private stopController: AbortController | null = null;
  private stoppedResolver: (() => void) | null = null;
  private readonly channels = new Map<BotChannel, GatewayChannelState>();
  private readonly runners = new Map<BotChannel, Map<string, ChannelRunner>>();
  private lastStatusWriteMs = 0;
  private signalHandler: (() => void) | null = null;

  constructor(opts: ChannelGatewayOptions) {
    this.home = opts.home;
    this.workdir = opts.workdir;
    this.config = opts.config;
    this.createAdapterFn = opts.createAdapter ?? ((channel) => this.defaultCreateAdapter(channel));
    this.createRunnerFn = opts.createRunner ?? ((binding, adapter) => this.defaultCreateRunner(binding, adapter));
  }

  private defaultCreateAdapter(channel: BotChannel): ChannelAdapter | null {
    return buildChannelAdapter(channel, this.home);
  }

  private defaultCreateRunner(binding: ChannelBinding, adapter: ChannelAdapter): ChannelRunner {
    const kind = channelKindFor(binding.channel);
    return new BotRunner({
      home: this.home,
      workdir: this.workdir,
      config: this.config,
      adapter,
      agent: binding.agent,
      bindingId: binding.id,
      sandboxOverride: binding.sandbox,
      voiceCloud: binding.voiceCloud,
      policyOverride: { mentionOnly: binding.mentionOnly ?? kind.policy.mentionDefault },
    });
  }

  /** 启动网关：已在运行直接抛错；绑定账本损坏直接抛错（fail-closed，不带病跑）。 */
  async start(): Promise<void> {
    if (this.running) return;
    const alive = readGatewayPid(this.home);
    if (alive !== null) throw new Error(`渠道网关已在运行（pid ${alive}），先跑 nyra channels stop 停掉它`);
    // 账本损坏先备份再抛错（loadBindingStore 的口径）——网关不带病启动。
    const store = loadBindingStore(this.home);
    const policy = botPolicyFromConfig(this.config);
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.stopController = new AbortController();
    for (const channel of GATEWAY_CHANNELS) {
      const explicit = store.bindings.filter((b) => b.channel === channel && b.enabled);
      // 默认绑定的 runner 永远建一个——路由没命中显式绑定时落到它，要有
      // runner 接。但它不参与路由匹配（routeBindings 只含显式绑定）：
      // 默认绑定 chat/sender 都是 *，放进匹配会抢掉所有消息、还会在群里
      // 按 kind 默认口径把没 @ 的消息丢弃，fallback 语义就没了。
      const bindings = [...explicit, defaultBinding(channel, policy.agent)];
      const state: GatewayChannelState = {
        channel,
        started: false,
        tokenPresent: false,
        bindings: explicit.length,
        runners: [],
        lastPollOk: null,
        lastPollAt: null,
        routed: 0,
        dropped: 0,
        errors: 0,
      };
      this.channels.set(channel, state);
      const adapter = this.createAdapterFn(channel);
      if (!adapter) {
        process.stderr.write(`渠道网关：${channel} 未启动（token 未配，跑 nyra channels health 看缺什么）。\n`);
        continue;
      }
      state.tokenPresent = true;
      const runners = new Map<string, ChannelRunner>();
      for (const binding of bindings) {
        try {
          const runner = this.createRunnerFn(binding, adapter);
          runners.set(binding.id, runner);
          // notifier 只在默认绑定的 runner 上开——同一渠道多个 runner 各起
          // 一个推送巡查会重复推送。
          const isDefault = binding.id === defaultBinding(channel, policy.agent).id;
          runner.startServices({ notifier: isDefault });
        } catch (err) {
          process.stderr.write(`渠道网关：绑定 ${binding.id} 的 runner 建不出来（${err instanceof Error ? err.message : String(err)}）：这条绑定不接消息。\n`);
        }
      }
      if (runners.size === 0) {
        process.stderr.write(`渠道网关：${channel} 没有可用的 runner，未启动。\n`);
        continue;
      }
      state.started = true;
      this.runners.set(channel, runners);
      void this.pollLoop(channel, adapter, explicit, runners, this.stopController.signal);
    }
    writeGatewayPid(this.home);
    this.writeStatusFile(true);
    const handler = () => { this.stop(); };
    this.signalHandler = handler;
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }

  /** 停网关：停轮询、停全部 runner 的后台服务、删 pidfile。 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopController?.abort();
    this.stopController = null;
    for (const runners of this.runners.values()) {
      for (const runner of runners.values()) {
        try { runner.stopServices(); } catch { /* ignore */ }
      }
    }
    if (this.signalHandler) {
      process.removeListener("SIGINT", this.signalHandler);
      process.removeListener("SIGTERM", this.signalHandler);
      this.signalHandler = null;
    }
    removeGatewayPid(this.home);
    if (this.stoppedResolver) {
      const resolve = this.stoppedResolver;
      this.stoppedResolver = null;
      resolve();
    }
  }

  /** 等网关停下（`nyra channels start` 前台等 Ctrl+C 用）。 */
  waitStopped(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => { this.stoppedResolver = resolve; });
  }

  status(): GatewayStatus {
    const channels: GatewayChannelState[] = [...this.channels.values()].map((s) => {
      const runners = this.runners.get(s.channel);
      return {
        ...s,
        runners: runners
          ? [...runners.values()].map((r) => {
              const st = r.status();
              return { bindingId: r.bindingId ?? "", agent: r.agent, queueDepth: st.queueDepth, activeSessions: st.activeSessions };
            })
          : [],
      };
    });
    return { running: this.running, pid: this.running ? process.pid : readGatewayPid(this.home), startedAt: this.startedAt, channels };
  }

  private async pollLoop(
    channel: BotChannel,
    adapter: ChannelAdapter,
    bindings: ChannelBinding[],
    runners: Map<string, ChannelRunner>,
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.channels.get(channel);
    if (!state) return;
    try { await adapter.getMe?.(); } catch { /* username 拿不到不影响运行 */ }
    let backoffMs = 1000;
    while (this.running && !signal.aborted) {
      try {
        const msgs = await adapter.pollOnce(signal);
        backoffMs = 1000;
        state.lastPollOk = true;
        state.lastPollAt = new Date().toISOString();
        for (const m of msgs) {
          // 与 BotRunner.startPolling 同口径：每条消息 fire-and-forget（会话
          // 内串行由 runner 的 SessionQueue 保证），一条消息卡住不堵别的会话。
          void this.routeAndHandle(channel, m, bindings, runners).catch((err) => {
            state.errors += 1;
            process.stderr.write(`渠道网关：处理 ${channel} 消息失败：${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
        this.writeStatusFile();
      } catch (err) {
        if (!this.running || signal.aborted) break;
        state.lastPollOk = false;
        state.lastPollAt = new Date().toISOString();
        process.stderr.write(`渠道网关：${channel} 轮询失败（${backoffMs}ms 后重试）：${err instanceof Error ? err.message : String(err)}\n`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  /** 路由一条入站消息：决定写审计，命中交给对应 runner，丢弃直接返回。 */
  private async routeAndHandle(
    channel: BotChannel,
    msg: InboundMessage,
    bindings: ChannelBinding[],
    runners: Map<string, ChannelRunner>,
  ): Promise<void> {
    const state = this.channels.get(channel);
    const sessionKey = `${channel}:${msg.chatId}`;
    const input: RouteInput = {
      channel,
      chat: msg.chatId,
      sender: msg.senderId,
      mentioned: msg.isMentioned,
      isGroup: msg.chatType === "group" || msg.chatType === "supergroup",
    };
    const decision = routeInbound(input, bindings);
    if (decision.outcome === "dropped") {
      if (state) state.dropped += 1;
      appendBotAudit(this.home, {
        ts: new Date().toISOString(),
        channel,
        session_key: sessionKey,
        message_id: msg.messageId,
        outcome: `dropped:${decision.rule.replace("drop:", "")}`,
        binding_id: decision.bindingId,
        rule: decision.rule,
        reason: decision.reason,
      });
      return;
    }
    // 缺口 34：信任圈预过滤——圈外发件人的消息在网关层直接丢弃，不进
    // agent 上下文、不耗 token。认的是 circles.json 里的绑定 + 准入，
    // 不是绑定的 agent：绑定决定“谁接”，圈决定“接不接”。
    const admission = checkCircleInbound(this.home, channel, msg.senderId);
    if (!admission.admitted) {
      if (state) state.dropped += 1;
      appendBotAudit(this.home, {
        ts: new Date().toISOString(),
        channel,
        session_key: sessionKey,
        message_id: msg.messageId,
        outcome: "dropped:circle",
        binding_id: decision.bindingId,
        rule: "circle:admission",
        reason: admission.reason,
      });
      return;
    }
    const runner = runners.get(decision.bindingId);
    if (!runner) {
      if (state) state.errors += 1;
      appendBotAudit(this.home, {
        ts: new Date().toISOString(),
        channel,
        session_key: sessionKey,
        message_id: msg.messageId,
        outcome: "error:no-runner",
        binding_id: decision.bindingId,
        rule: decision.rule,
        reason: `绑定 ${decision.bindingId} 的 runner 不在，没法接这条消息`,
      });
      return;
    }
    if (state) state.routed += 1;
    appendBotAudit(this.home, {
      ts: new Date().toISOString(),
      channel,
      session_key: sessionKey,
      message_id: msg.messageId,
      outcome: "routed",
      binding_id: decision.bindingId,
      rule: decision.rule,
      reason: decision.reason,
    });
    await runner.handleMessage(msg);
  }

  private writeStatusFile(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStatusWriteMs < STATUS_WRITE_MIN_MS) return;
    this.lastStatusWriteMs = now;
    try {
      const dir = resolveNyraHome(this.home);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, CHANNEL_GATEWAY_STATUS_FILE);
      const tmp = join(dir, `.gateway-status.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      const data = JSON.stringify(
        { pid: process.pid, startedAt: this.startedAt, updatedAt: new Date().toISOString(), channels: this.status().channels },
        null,
        2,
      ) + "\n";
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path);
    } catch { /* 状态文件写失败不破坏网关运行 */ }
  }
}
