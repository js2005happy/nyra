// tests/node/test-channels.test.ts — 缺口 27：常驻多渠道网关 + bindings 确定性路由 + DSH-3 kind 协议。
// 全部用假适配器 / 假 runner / 注入的假转写，不联网、不用真实 token、不调真模型、不装 whisper。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramAdapter } from "../../src/bot/channels/telegram.ts";
import { BotRunner, appendBotAudit, type AgentRunResult } from "../../src/bot/index.ts";
import { type BotStatus, type ChannelAdapter, type InboundMessage, type OutgoingMessage } from "../../src/bot/types.ts";
import { AUDIT_SOURCES, exportAudit } from "../../src/costCaps.ts";
import {
  channelKindFor,
  checkKindHealth,
  listChannelKinds,
  validateKindConfig,
} from "../../src/channels/kind.ts";
import {
  configWithSandboxTier,
  defaultBinding,
  defaultBindingId,
  explainRoute,
  loadBindingStore,
  routeInbound,
  sandboxOverrideFor,
  saveBindingStore,
  validateBindingInput,
  type ChannelBinding,
  type RouteInput,
} from "../../src/channels/bindings.ts";
import { ChannelGateway, readGatewayPid, type ChannelRunner } from "../../src/channels/gateway.ts";
import { handleChannels } from "../../src/channels/cli.ts";
import { saveFriendBook } from "../../src/peerCard.ts";
import { saveCircleBook } from "../../src/circles.ts";

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function readAudit(home: string): Record<string, unknown>[] {
  const path = join(home, "bot-audit.jsonl");
  try {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function binding(over: Partial<ChannelBinding> & { id: string }): ChannelBinding {
  const now = new Date().toISOString();
  return {
    channel: "telegram",
    chat: "*",
    sender: "*",
    agent: "nyra",
    sandbox: "standard",
    admission: "open",
    allowlist: [],
    mentionOnly: null,
    voiceCloud: false,
    enabled: true,
    priority: 0,
    note: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function routeMsg(over: Partial<RouteInput>): RouteInput {
  return { channel: "telegram", chat: "7", sender: "7", mentioned: false, isGroup: false, ...over };
}

// ---- kind 协议 ---------------------------------------------------------------

test("kind：四种内置渠道齐全，能力与风险说明如实", () => {
  const kinds = listChannelKinds();
  expect(kinds.map((k) => k.kind).sort()).toEqual(["discord", "slack", "telegram", "whatsapp"]);
  const tg = channelKindFor("telegram");
  expect(tg.channel.supportsVoice).toBe(true);
  expect(tg.channel.supportsPolling).toBe(true);
  expect(tg.channel.supportsWebhook).toBe(false);
  expect(tg.channel.supportsEdit).toBe(true);
  expect(channelKindFor("slack").channel.supportsButtons).toBe(true);
  expect(channelKindFor("discord").channel.supportsVoice).toBe(false);
  const wa = channelKindFor("whatsapp");
  expect(wa.channel.supportsWebhook).toBe(true);
  expect(wa.channel.supportsPolling).toBe(false);
  expect(wa.environment.needsPublicUrl).toBe(true);
  // 风险说明不把 Cloud API 与 Baileys 混为一谈。
  expect(wa.environment.notes).toContain("Cloud API");
  expect(wa.environment.notes).toContain("Baileys");
  // 健康条目名按 kind 加前缀。
  expect(tg.health).toEqual(["telegram:token", "telegram:adapter", "telegram:poll"]);
});

test("kind 校验：缺必填与格式不对都报错，通过返回空", () => {
  const tg = channelKindFor("telegram");
  const missing = validateKindConfig(tg, {});
  expect(missing.length).toBe(1);
  expect(missing[0]).toContain("TELEGRAM_BOT_TOKEN");
  const badFormat = validateKindConfig(tg, { TELEGRAM_BOT_TOKEN: "not-a-token" });
  expect(badFormat.length).toBe(1);
  expect(badFormat[0]).toContain("格式不对");
  expect(validateKindConfig(tg, { TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" })).toEqual([]);
  const sl = channelKindFor("slack");
  expect(validateKindConfig(sl, { SLACK_APP_TOKEN: "xapp-1-A09-123abc", SLACK_BOT_TOKEN: "xoxb-123-abc" })).toEqual([]);
  expect(validateKindConfig(sl, { SLACK_APP_TOKEN: "xapp-1-A09-123abc" }).length).toBe(1);
});

test("kind 健康：token 缺失是 error，轮询失败是 degraded，全好是 ok", () => {
  const tg = channelKindFor("telegram");
  const noToken = checkKindHealth(tg, { tokenPresent: false, adapterOk: false, lastPollOk: null, bindings: 0 });
  expect(noToken.status).toBe("error");
  expect(noToken.entries.find((e) => e.name === "telegram:token")?.status).toBe("error");
  const pollFailed = checkKindHealth(tg, { tokenPresent: true, adapterOk: true, lastPollOk: false, bindings: 1 });
  expect(pollFailed.status).toBe("degraded");
  expect(pollFailed.bindings).toBe(1);
  const ok = checkKindHealth(tg, { tokenPresent: true, adapterOk: true, lastPollOk: true, bindings: 0 });
  expect(ok.status).toBe("ok");
});

// ---- 绑定账本与校验 -----------------------------------------------------------

test("绑定账本：存取往返；损坏先备份再抛错，不静默重建", () => {
  const home = tempHome("nyra-chan-store-");
  try {
    expect(loadBindingStore(home).bindings).toEqual([]);
    saveBindingStore(home, { version: 1, bindings: [binding({ id: "bd-one", chat: "100" })] });
    const loaded = loadBindingStore(home);
    expect(loaded.bindings.length).toBe(1);
    expect(loaded.bindings[0].chat).toBe("100");
    // 写坏账本再读：备份 + 抛错。
    writeFileSync(join(home, "channel-bindings.json"), "{ not json", "utf-8");
    expect(() => loadBindingStore(home)).toThrow("损坏");
    const backups = readdirSync(home).filter((f) => f.startsWith("channel-bindings.json.corrupt-"));
    expect(backups.length).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("绑定校验：agent/档位/准入/priority 不合规都报错", () => {
  const base: Record<string, unknown> = {
    id: "bd-ok", channel: "telegram", chat: "*", sender: "*", agent: "nyra",
    sandbox: "standard", admission: "open", allowlist: [], mentionOnly: null, priority: 0,
  };
  expect(validateBindingInput(base)).toEqual([]);
  expect(validateBindingInput({ ...base, agent: "Bad Agent" }).length).toBeGreaterThan(0);
  expect(validateBindingInput({ ...base, sandbox: "full" }).length).toBeGreaterThan(0);
  expect(validateBindingInput({ ...base, admission: "allowlist", allowlist: [] }).length).toBeGreaterThan(0);
  expect(validateBindingInput({ ...base, admission: "allowlist", allowlist: ["7"] })).toEqual([]);
  expect(validateBindingInput({ ...base, priority: 101 }).length).toBeGreaterThan(0);
  expect(validateBindingInput({ ...base, priority: -1 }).length).toBeGreaterThan(0);
  expect(validateBindingInput({ ...base, channel: "wechat" }).length).toBeGreaterThan(0);
});

// ---- 确定性路由 ---------------------------------------------------------------

test("路由：具体程度胜出，同级按 priority，再按创建时间", () => {
  const early = binding({ id: "bd-early", chat: "100", sender: "*", createdAt: "2026-01-01T00:00:00.000Z" });
  const late = binding({ id: "bd-late", chat: "100", sender: "*", createdAt: "2026-01-02T00:00:00.000Z" });
  // 同具体程度、同 priority：先创建的赢。
  expect(routeInbound(routeMsg({ chat: "100" }), [late, early]).bindingId).toBe("bd-early");
  // priority 大的赢（与创建时间无关）。
  const highPrio = binding({ id: "bd-high", chat: "100", sender: "*", priority: 10, createdAt: "2026-01-03T00:00:00.000Z" });
  expect(routeInbound(routeMsg({ chat: "100" }), [early, highPrio]).bindingId).toBe("bd-high");
  // sender 精确（2 分）胜过只有 chat 精确。
  const senderExact = binding({ id: "bd-sender", chat: "100", sender: "7", createdAt: "2026-01-04T00:00:00.000Z" });
  expect(routeInbound(routeMsg({ chat: "100", sender: "7" }), [early, senderExact]).bindingId).toBe("bd-sender");
  // 停用的绑定不参与。
  const disabled = binding({ id: "bd-off", chat: "100", sender: "7", enabled: false, createdAt: "2026-01-05T00:00:00.000Z" });
  expect(routeInbound(routeMsg({ chat: "100", sender: "7" }), [disabled, senderExact]).bindingId).toBe("bd-sender");
  expect(routeInbound(routeMsg({ chat: "100", sender: "7" }), [disabled]).outcome).toBe("fallback");
});

test("路由：allowlist 与只响应 @ 失败直接丢弃，不落到默认绑定", () => {
  const allow = binding({ id: "bd-allow", chat: "300", sender: "*", admission: "allowlist", allowlist: ["7"] });
  const dropped = routeInbound(routeMsg({ chat: "300", sender: "8" }), [allow]);
  expect(dropped.outcome).toBe("dropped");
  expect(dropped.bindingId).toBe("bd-allow");
  expect(dropped.rule).toBe("drop:not_in_allowlist");
  expect(dropped.reason).toContain("8");
  // 名单里的人正常接。
  expect(routeInbound(routeMsg({ chat: "300", sender: "7" }), [allow]).outcome).toBe("routed");
  // 群里没 @：mentionOnly 绑定直接丢弃。
  const mention = binding({ id: "bd-mention", chat: "100", sender: "*", mentionOnly: true });
  const noMention = routeInbound(routeMsg({ chat: "100", sender: "7", isGroup: true, mentioned: false }), [mention]);
  expect(noMention.outcome).toBe("dropped");
  expect(noMention.rule).toBe("drop:mention_only");
  expect(routeInbound(routeMsg({ chat: "100", sender: "7", isGroup: true, mentioned: true }), [mention]).outcome).toBe("routed");
});

test("路由：没命中落到默认绑定；私聊不受 mention 门限制", () => {
  const d = routeInbound(routeMsg({ chat: "999", sender: "5" }), []);
  expect(d.outcome).toBe("fallback");
  expect(d.bindingId).toBe(defaultBindingId("telegram"));
  expect(d.rule).toBe("fallback:default");
  // 私聊：mentionOnly 绑定也接（@ 门只管群）。
  const mention = binding({ id: "bd-mention", chat: "100", sender: "*", mentionOnly: true });
  expect(routeInbound(routeMsg({ chat: "100", sender: "7", isGroup: false, mentioned: false }), [mention]).outcome).toBe("routed");
  // kind 默认口径：mentionOnly 为 null 时群里默认只响应 @。
  const kindDefault = binding({ id: "bd-kind", chat: "100", sender: "*", mentionOnly: null });
  expect(routeInbound(routeMsg({ chat: "100", sender: "7", isGroup: true, mentioned: false }), [kindDefault]).outcome).toBe("dropped");
});

test("路由解释：候选按匹配排序，准入结果写明", () => {
  const allow = binding({ id: "bd-allow", chat: "300", sender: "*", admission: "allowlist", allowlist: ["7"] });
  const generic = binding({ id: "bd-generic", chat: "*", sender: "*" });
  const ex = explainRoute(routeMsg({ chat: "300", sender: "8" }), [generic, allow]);
  expect(ex.outcome).toBe("dropped");
  expect(ex.bindingId).toBe("bd-allow");
  expect(ex.candidates[0].bindingId).toBe("bd-allow");
  expect(ex.candidates[0].admission).toBe("drop:not_in_allowlist");
  expect(ex.candidates[1].bindingId).toBe("bd-generic");
  expect(ex.candidates[1].admission).toBe("pass");
});

test("沙箱档位：strict 只读断网、standard 可写断网、open 可写放网；合并进 config 不动其他键", () => {
  expect(sandboxOverrideFor("strict")).toEqual({ backend: "auto", mode: "read-only", allowNet: false });
  expect(sandboxOverrideFor("standard")).toEqual({ backend: "auto", mode: "workspace-write", allowNet: false });
  expect(sandboxOverrideFor("open")).toEqual({ backend: "auto", mode: "workspace-write", allowNet: true });
  const merged = configWithSandboxTier({ provider: "deepseek", sandbox_mode: "danger-full-access" }, "strict");
  expect(merged.provider).toBe("deepseek");
  expect(merged.sandbox_mode).toBe("read-only");
  expect(merged.sandbox_allow_net).toBe(false);
});

test("默认绑定：id、agent、档位、准入口径", () => {
  const d = defaultBinding("telegram", "nyra");
  expect(d.id).toBe("default:telegram");
  expect(d.agent).toBe("nyra");
  expect(d.chat).toBe("*");
  expect(d.sender).toBe("*");
  expect(d.sandbox).toBe("standard");
  expect(d.admission).toBe("open");
  expect(d.enabled).toBe(true);
});

// ---- 审计导出第 8 个来源 -------------------------------------------------------

test("审计导出第 8 个来源 bot，且只导它时只有路由行", () => {
  const home = tempHome("nyra-chan-export-");
  try {
    expect(AUDIT_SOURCES.some((s) => s.file === "bot-audit.jsonl" && s.label === "bot")).toBe(true);
    appendBotAudit(home, {
      ts: new Date().toISOString(), channel: "telegram", session_key: "telegram:100",
      message_id: "1", outcome: "routed", binding_id: "bd-one", rule: "specificity:4", reason: "命中绑定 bd-one",
    });
    const exported = exportAudit(home, { sources: ["bot"] });
    expect(exported.lines).toBe(1);
    expect(exported.text).toContain("bot");
    expect(exported.text).toContain("bd-one");
    expect(exported.text).toContain("routed");
  } finally {
    cleanup(home);
  }
});

// ---- Telegram 语音映射 ---------------------------------------------------------

test("Telegram 语音映射：voice 进附件，带时长与 mime", async () => {
  const seen: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    let body: Record<string, unknown> | null = null;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)) as Record<string, unknown>; } catch { body = null; }
    }
    seen.push({ url: u, body });
    const handler = (u: string): unknown => {
      if (u.includes("/getMe")) return { id: 999, username: "NyraTestBot" };
      if (u.includes("/getUpdates")) {
        if (typeof body?.offset === "number") return [];
        return [{
          update_id: 10,
          message: {
            message_id: 1, date: 1700000000,
            chat: { id: 7, type: "private" },
            from: { id: 7, username: "user" },
            voice: { file_id: "voice-file-1", duration: 5, mime_type: "audio/ogg", file_size: 1234 },
          },
        }];
      }
      return null;
    };
    return new Response(JSON.stringify({ ok: true, result: handler(u) }), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new TelegramAdapter({ token: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", fetchImpl });
  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(1);
  expect(msgs[0].attachments.length).toBe(1);
  expect(msgs[0].attachments[0].kind).toBe("voice");
  expect(msgs[0].attachments[0].fileId).toBe("voice-file-1");
  expect(msgs[0].attachments[0].durationSeconds).toBe(5);
  expect(msgs[0].attachments[0].mimeType).toBe("audio/ogg");
  expect(msgs[0].text).toBe("");
});

// ---- 网关（假适配器 + 假 runner） ----------------------------------------------

class FakeChannelAdapter implements ChannelAdapter {
  readonly channel: "telegram" | "discord" | "slack" | "whatsapp";
  botUsername: string | null = "FakeBot";
  private queue: InboundMessage[];
  constructor(channel: "telegram" | "discord" | "slack" | "whatsapp", queue: InboundMessage[]) {
    this.channel = channel;
    this.queue = [...queue];
  }
  async getMe(): Promise<{ id: number; username: string | null }> {
    return { id: 1, username: "FakeBot" };
  }
  async pollOnce(): Promise<InboundMessage[]> {
    // 像长轮询一样等一会儿再回，避免空转烧 CPU。
    await new Promise((r) => setTimeout(r, 10));
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }
  async sendText(msg: OutgoingMessage): Promise<string> {
    return "1";
  }
  async editText(): Promise<void> {}
}

class FakeRunner implements ChannelRunner {
  readonly agent: string;
  readonly bindingId: string | null;
  handled: InboundMessage[] = [];
  servicesStarted = 0;
  servicesStopped = 0;
  notifierOn: boolean | null = null;
  constructor(agent: string, bindingId: string) {
    this.agent = agent;
    this.bindingId = bindingId;
  }
  async handleMessage(msg: InboundMessage): Promise<void> {
    this.handled.push(msg);
  }
  startServices(opts?: { notifier?: boolean }): void {
    this.servicesStarted++;
    this.notifierOn = opts?.notifier ?? true;
  }
  stopServices(): void {
    this.servicesStopped++;
  }
  status(): BotStatus {
    return {
      running: true, model: "fake:test", queueDepth: 0, activeSessions: [],
      todaySpentUsd: 0, dedupSize: 0, monthlySpentUsd: null, pendingApprovals: 0,
    };
  }
}

function gwMsg(over: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "7",
    threadId: null,
    senderId: "7",
    senderRole: "member",
    isMentioned: false,
    messageId: "1",
    text: "你好",
    attachments: [],
    chatType: "private",
    timestamp: Date.now(),
    ...over,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** 缺口 34：直接写账本，让这些渠道发件人通过信任圈准入（不走带审计的 invite）。 */
function seedCircleSenders(home: string, senders: { channel: string; sender: string; identity: string }[]): void {
  const now = new Date().toISOString();
  const friends = senders.filter((s) => s.identity !== "owner").map((s) => ({
    name: s.identity, url: "http://127.0.0.1:9/mcp", card_hash: "seed", circle: "default",
    tier: "readonly" as const, outbound: "accepted" as const, inbound: "accepted" as const,
    blocked: false, code_hash: null, created_at: now, updated_at: now,
  }));
  saveFriendBook(home, { version: 1, friends, circles: [{ name: "default", created_at: now }] });
  saveCircleBook(home, {
    version: 1,
    circles: [{
      name: "work", description: "", created_at: now, created_by: "owner",
      members: friends.map((f) => ({ identity: f.name, kind: "friend" as const, invited_by: "owner", invited_at: now, channel: "test" })),
    }],
    bindings: senders.map((s) => ({ channel: s.channel, sender: s.sender, identity: s.identity, bound_at: now, bound_by: "owner" })),
  });
}

test("网关：按绑定路由，审计记 routed/dropped，停后删 pidfile", async () => {
  const home = tempHome("nyra-chan-gw-");
  try {
    saveBindingStore(home, {
      version: 1,
      bindings: [
        binding({ id: "bd-one", chat: "100", sender: "*", agent: "agent-one" }),
        binding({ id: "bd-two", chat: "100", sender: "9", agent: "agent-two", admission: "allowlist", allowlist: ["9"] }),
        binding({ id: "bd-allow", chat: "300", sender: "*", agent: "agent-three", admission: "allowlist", allowlist: ["7"] }),
        binding({ id: "bd-dc", channel: "discord", chat: "*", sender: "*", agent: "agent-dc" }),
      ],
    });
    // 缺口 34：发件人 9/5/55 先过信任圈（m5 的发件人 8 故意不种：它走 allowlist 丢弃）。
    seedCircleSenders(home, [
      { channel: "telegram", sender: "9", identity: "s9" },
      { channel: "telegram", sender: "5", identity: "s5" },
      { channel: "discord", sender: "55", identity: "s55" },
    ]);
    const tgQueue = [
      gwMsg({ messageId: "m1", chatId: "100", senderId: "9" }),
      gwMsg({ messageId: "m2", chatId: "100", senderId: "5" }),
      gwMsg({ messageId: "m3", chatId: "200", senderId: "5" }),
      gwMsg({ messageId: "m4", chatId: "100", senderId: "5", text: "第二条" }),
      gwMsg({ messageId: "m5", chatId: "300", senderId: "8" }),
    ];
    const dcQueue = [gwMsg({ messageId: "d1", channel: "discord", chatId: "55", senderId: "55" })];
    const runners = new Map<string, FakeRunner>();
    const gateway = new ChannelGateway({
      home,
      workdir: home,
      config: {},
      createAdapter: (channel) => {
        if (channel === "telegram") return new FakeChannelAdapter("telegram", tgQueue);
        if (channel === "discord") return new FakeChannelAdapter("discord", dcQueue);
        return null;
      },
      createRunner: (b, _adapter) => {
        const r = new FakeRunner(b.agent, b.id);
        runners.set(b.id, r);
        return r;
      },
    });
    await gateway.start();
    // 5 条路由成功（m1/m2/m3/m4/d1），m5 被 allowlist 丢弃。
    const ok = await waitFor(() => {
      const total = [...runners.values()].reduce((n, r) => n + r.handled.length, 0);
      return total === 5;
    });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(runners.get("bd-two")?.handled.map((m) => m.messageId)).toEqual(["m1"]);
    expect(runners.get("bd-one")?.handled.map((m) => m.messageId)).toEqual(["m2", "m4"]);
    expect(runners.get("default:telegram")?.handled.map((m) => m.messageId)).toEqual(["m3"]);
    expect(runners.get("bd-allow")?.handled.length).toBe(0);
    expect(runners.get("bd-dc")?.handled.map((m) => m.messageId)).toEqual(["d1"]);
    // notifier 只在默认绑定的 runner 上开。
    expect(runners.get("default:telegram")?.notifierOn).toBe(true);
    expect(runners.get("bd-one")?.notifierOn).toBe(false);
    // 审计：5 条 routed + 1 条 dropped，带绑定与规则。
    const audit = readAudit(home);
    const outcomes = audit.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "routed").length).toBe(5);
    expect(outcomes).toContain("dropped:not_in_allowlist");
    const dropped = audit.find((r) => r.outcome === "dropped:not_in_allowlist");
    expect(dropped?.binding_id).toBe("bd-allow");
    expect(dropped?.rule).toBe("drop:not_in_allowlist");
    const routed = audit.find((r) => r.message_id === "m1");
    expect(routed?.binding_id).toBe("bd-two");
    expect(routed?.rule).toBe("specificity:7");
    // 状态计数。
    const st = gateway.status();
    const tgState = st.channels.find((c) => c.channel === "telegram");
    expect(tgState?.started).toBe(true);
    expect(tgState?.bindings).toBe(3);
    expect(tgState?.routed).toBe(4);
    expect(tgState?.dropped).toBe(1);
    expect(st.channels.find((c) => c.channel === "slack")?.started).toBe(false);
    gateway.stop();
    expect(existsSync(join(home, "channel-gateway.pid"))).toBe(false);
    expect(readGatewayPid(home)).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("网关：token 未配的渠道跳过，零渠道启动时 status 全是未运行", async () => {
  const home = tempHome("nyra-chan-gw2-");
  try {
    const gateway = new ChannelGateway({
      home, workdir: home, config: {},
      createAdapter: () => null,
    });
    await gateway.start();
    const st = gateway.status();
    expect(st.channels.every((c) => !c.started)).toBe(true);
    expect(existsSync(join(home, "channel-gateway.pid"))).toBe(true);
    gateway.stop();
    expect(existsSync(join(home, "channel-gateway.pid"))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("网关：某个绑定的 runner 建不出来不影响其他绑定", async () => {
  const home = tempHome("nyra-chan-gw3-");
  try {
    saveBindingStore(home, {
      version: 1,
      bindings: [
        binding({ id: "bd-bad", chat: "100", sender: "*", agent: "agent-bad" }),
        binding({ id: "bd-good", chat: "200", sender: "*", agent: "agent-good" }),
      ],
    });
    // 缺口 34：发件人 1 登记为机主，先过信任圈（否则两条消息都会被圈丢弃，测不到 runner 缺失）。
    seedCircleSenders(home, [{ channel: "telegram", sender: "1", identity: "owner" }]);
    const tgQueue = [
      gwMsg({ messageId: "g1", chatId: "100", senderId: "1" }),
      gwMsg({ messageId: "g2", chatId: "200", senderId: "1" }),
    ];
    const runners = new Map<string, FakeRunner>();
    const gateway = new ChannelGateway({
      home,
      workdir: home,
      config: {},
      createAdapter: (channel) => (channel === "telegram" ? new FakeChannelAdapter("telegram", tgQueue) : null),
      createRunner: (b, _adapter) => {
        if (b.id === "bd-bad") throw new Error("模拟建 runner 失败");
        const r = new FakeRunner(b.agent, b.id);
        runners.set(b.id, r);
        return r;
      },
    });
    await gateway.start();
    const ok = await waitFor(() => (runners.get("bd-good")?.handled.length ?? 0) === 1);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(runners.get("bd-good")?.handled[0].messageId).toBe("g2");
    // g1 的绑定没 runner：审计记 error:no-runner。
    const audit = readAudit(home);
    expect(audit.some((r) => r.outcome === "error:no-runner" && r.binding_id === "bd-bad")).toBe(true);
    gateway.stop();
  } finally {
    cleanup(home);
  }
});

// ---- 语音入口（BotRunner） -----------------------------------------------------

class VoiceFakeAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = "FakeBot";
  sent: { chatId: string; threadId: string | null; text: string; id: string }[] = [];
  edited: { chatId: string; messageId: string; text: string }[] = [];
  private nextId = 1;
  async getMe(): Promise<{ id: number; username: string | null }> {
    return { id: 1, username: "FakeBot" };
  }
  async pollOnce(): Promise<InboundMessage[]> {
    return [];
  }
  async sendText(msg: OutgoingMessage): Promise<string> {
    const id = String(this.nextId++);
    this.sent.push({ chatId: msg.chatId, threadId: msg.threadId, text: msg.text, id });
    return id;
  }
  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    this.edited.push({ chatId, messageId, text });
  }
  async downloadFile(): Promise<{ bytes: Buffer; fileName?: string; mimeType?: string }> {
    return { bytes: Buffer.from("fake-ogg-bytes"), fileName: "voice.ogg", mimeType: "audio/ogg" };
  }
}

function voiceMsg(over: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "7",
    threadId: null,
    senderId: "7",
    senderRole: "member",
    isMentioned: false,
    messageId: "v1",
    text: "",
    attachments: [{ kind: "voice", fileId: "voice-file-1", mimeType: "audio/ogg", durationSeconds: 5 }],
    chatType: "private",
    timestamp: Date.now(),
    ...over,
  };
}

test("语音入口：注入转写，Agent 收到转写文本，回复带转写说明", async () => {
  const home = tempHome("nyra-chan-voice-");
  try {
    const adapter = new VoiceFakeAdapter();
    let agentText = "";
    const runner = new BotRunner({
      home, workdir: home, config: {}, adapter,
      agentRun: async (_key, text, _signal) => {
        agentText = text;
        return { text: "收到", promptTokens: 0, completionTokens: 0, spentUsd: null } as AgentRunResult;
      },
      voiceTranscribe: async () => ({ text: "帮我查一下今天的任务", engine: "fake-stt" }),
    });
    await runner.handleMessage(voiceMsg({}));
    expect(agentText).toBe("帮我查一下今天的任务");
    expect(adapter.edited[0].text).toContain("已把语音转成文字（fake-stt）");
    expect(adapter.edited[0].text).toContain("收到");
    expect(readAudit(home).map((r) => r.outcome)).toContain("ok");
  } finally {
    cleanup(home);
  }
});

test("语音入口：转写器返回空时回失败说明，不进模型", async () => {
  const home = tempHome("nyra-chan-voice2-");
  try {
    const adapter = new VoiceFakeAdapter();
    let calls = 0;
    const runner = new BotRunner({
      home, workdir: home, config: {}, adapter,
      agentRun: async () => {
        calls++;
        return { text: "不该跑", promptTokens: 0, completionTokens: 0, spentUsd: null } as AgentRunResult;
      },
      voiceTranscribe: async () => null,
    });
    await runner.handleMessage(voiceMsg({}));
    expect(calls).toBe(0);
    expect(adapter.sent.map((s) => s.text).join("")).toContain("语音转写失败");
    expect(readAudit(home).map((r) => r.outcome)).toContain("error:voice-transcribe");
  } finally {
    cleanup(home);
  }
});

test("语音入口：转写出空文本时回请再说一次，不进模型", async () => {
  const home = tempHome("nyra-chan-voice3-");
  try {
    const adapter = new VoiceFakeAdapter();
    let calls = 0;
    const runner = new BotRunner({
      home, workdir: home, config: {}, adapter,
      agentRun: async () => {
        calls++;
        return { text: "不该跑", promptTokens: 0, completionTokens: 0, spentUsd: null } as AgentRunResult;
      },
      voiceTranscribe: async () => ({ text: "   ", engine: "fake-stt" }),
    });
    await runner.handleMessage(voiceMsg({}));
    expect(calls).toBe(0);
    expect(adapter.sent.map((s) => s.text).join("")).toContain("没识别出文字");
    expect(readAudit(home).map((r) => r.outcome)).toContain("notice:voice-empty");
  } finally {
    cleanup(home);
  }
});

test("语音入口：默认实现无本地无云端时如实报不可用", async () => {
  const home = tempHome("nyra-chan-voice4-");
  try {
    const adapter = new VoiceFakeAdapter();
    let calls = 0;
    const runner = new BotRunner({
      home, workdir: home, config: {}, adapter,
      agentRun: async () => {
        calls++;
        return { text: "不该跑", promptTokens: 0, completionTokens: 0, spentUsd: null } as AgentRunResult;
      },
    });
    await runner.handleMessage(voiceMsg({}));
    expect(calls).toBe(0);
    expect(adapter.sent.map((s) => s.text).join("")).toContain("语音转写失败");
  } finally {
    cleanup(home);
  }
});

test("绑定进 runner：binding_id 进审计、mentionOnly 覆盖生效、沙箱档位存下来", async () => {
  const home = tempHome("nyra-chan-voice5-");
  try {
    const adapter = new VoiceFakeAdapter();
    let calls = 0;
    const runner = new BotRunner({
      home, workdir: home, config: {}, adapter,
      agentRun: async () => {
        calls++;
        return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null } as AgentRunResult;
      },
      bindingId: "bd-x",
      sandboxOverride: "strict",
      policyOverride: { mentionOnly: false },
    });
    expect(runner.bindingId).toBe("bd-x");
    expect(runner.sandboxOverride).toBe("strict");
    // 群里没 @：全局默认会忽略，绑定覆盖 mentionOnly=false 后放行。
    await runner.handleMessage(gwMsg({ messageId: "p1", chatId: "100", chatType: "group", isMentioned: false, text: "开工" }));
    expect(calls).toBe(1);
    const audit = readAudit(home);
    expect(audit.some((r) => r.outcome === "ok" && r.binding_id === "bd-x")).toBe(true);
  } finally {
    cleanup(home);
  }
});

// ---- CLI：bindings 管理 ---------------------------------------------------------

test("CLI：bindings add/list/explain 走通，写进账本", async () => {
  const home = tempHome("nyra-chan-cli-");
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  try {
    // 测试里吞掉 CLI 的打印，只断言返回值与账本。
    process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
    process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
    const added = await handleChannels(["bindings", "add", "--channel", "telegram", "--agent", "nyra", "--chat", "100", "--sandbox", "strict"], home);
    expect(added).toBe(0);
    const store = loadBindingStore(home);
    expect(store.bindings.length).toBe(1);
    expect(store.bindings[0].chat).toBe("100");
    expect(store.bindings[0].sandbox).toBe("strict");
    expect(store.bindings[0].id.startsWith("bd-")).toBe(true);
    const listed = await handleChannels(["bindings", "list"], home);
    expect(listed).toBe(0);
    const explained = await handleChannels(["explain", "--channel", "telegram", "--chat", "100", "--sender", "5"], home);
    expect(explained).toBe(0);
    const bad = await handleChannels(["bindings", "add", "--channel", "wechat", "--agent", "nyra"], home);
    expect(bad).toBe(1);
    expect(loadBindingStore(home).bindings.length).toBe(1);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
    cleanup(home);
  }
});
