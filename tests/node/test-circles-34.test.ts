// tests/node/test-circles-34.test.ts — 缺口 34：Circles 信任圈与跨实例准入。
// 全部用临时 home 与假网关/假对端，不连真实渠道、不花真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  CIRCLES_FILE,
  CircleError,
  admissionDetail,
  bindChannelSender,
  checkCircleInbound,
  createCircle,
  deleteCircle,
  handleCircle,
  inviteToCircle,
  isAdmitted,
  listBindings,
  listCircles,
  loadCircleBook,
  memberCircles,
  resolveSenderIdentity,
  revokeFromCircle,
  saveCircleBook,
  unbindChannelSender,
  type CircleBook,
  type CircleMember,
} from "../../src/circles.ts";
import { PEER_AUDIT_FILE, askPeer, handoffPeer, type PeerEntry } from "../../src/peer.ts";
import { loadFriendBook, saveFriendBook, shareWithFriend, type FriendBook } from "../../src/peerCard.ts";
import { RunStore } from "../../src/runs.ts";
import { ChannelGateway, type ChannelRunner, type InboundMessage, type BotStatus } from "../../src/channels/gateway.ts";
import type { ChannelAdapter, OutgoingMessage } from "../../src/bot/types.ts";
import { saveBindingStore, type ChannelBinding } from "../../src/channels/bindings.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function now(): string {
  return new Date().toISOString();
}

/** 直接写好友账本 seeding（不走带审计的 invite，避免冲掉既有审计断言）。 */
function seedFriend(home: string, name: string, opts?: { blocked?: boolean; inbound?: "accepted" | "pending" | "declined" }): void {
  let book: FriendBook;
  try {
    book = loadFriendBook(home);
  } catch {
    book = { version: 1, friends: [], circles: [{ name: "default", created_at: now() }] };
  }
  const entry = {
    name,
    url: "http://127.0.0.1:9/mcp",
    card_hash: "seed",
    circle: "default",
    tier: "readonly" as const,
    outbound: "accepted" as const,
    inbound: opts?.inbound ?? "accepted",
    blocked: opts?.blocked ?? false,
    code_hash: null,
    created_at: now(),
    updated_at: now(),
  };
  const idx = book.friends.findIndex((f) => f.name === name);
  if (idx >= 0) book.friends[idx] = entry;
  else book.friends.push(entry);
  saveFriendBook(home, book);
}

function seedAdmission(home: string, name: string, circle = "work"): void {
  seedFriend(home, name);
  const book: CircleBook = {
    version: 1,
    circles: [{ name: circle, description: "", created_at: now(), created_by: "owner", members: [] }],
    bindings: [],
  };
  saveCircleBook(home, book);
  inviteToCircle(home, { circle, identity: name });
}

function readPeerAudit(home: string): Record<string, unknown>[] {
  const p = join(home, PEER_AUDIT_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readBotAudit(home: string): Record<string, unknown>[] {
  const p = join(home, "bot-audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const allowRunner = {
  async chat(): Promise<Record<string, unknown>> {
    return { choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "测试放行" }) } }] };
  },
};

function peerConfig(): Record<string, unknown> {
  return { peers: { enabled: true, list: [{ name: "pilot", url: "http://127.0.0.1:9/mcp" }] }, reviewer: { enabled: true } };
}

// ---- 账本与圈 CRUD ---------------------------------------------------------

test("CirclesTest.test_empty_book_closed_by_default", () => {
  const home = tmpHome("nyra-cir-");
  try {
    expect(loadCircleBook(home).circles).toEqual([]);
    expect(loadCircleBook(home).bindings).toEqual([]);
    // 默认全封闭：没圈 = 谁也进不来，机主本人除外。
    expect(isAdmitted(home, "owner")).toBe(true);
    expect(isAdmitted(home, "stranger")).toBe(false);
    expect(memberCircles(home, "stranger")).toEqual([]);
  } finally { cleanup(home); }
});

test("CirclesTest.test_create_list_delete_circle", () => {
  const home = tmpHome("nyra-cir-");
  try {
    const c = createCircle(home, "work", { description: "工作圈" });
    expect(c.name).toBe("work");
    expect(c.created_by).toBe("owner");
    expect(listCircles(home).map((x) => x.name)).toEqual(["work"]);
    expect(() => createCircle(home, "work")).toThrow("已存在");
    expect(() => createCircle(home, "default")).toThrow("default");
    expect(() => createCircle(home, "Bad Name!")).toThrow("圈名");
    expect(() => createCircle(home, "x".repeat(33))).toThrow("圈名");
    deleteCircle(home, "work");
    expect(listCircles(home)).toEqual([]);
    expect(() => deleteCircle(home, "work")).toThrow("没有这个圈");
  } finally { cleanup(home); }
});

test("CirclesTest.test_book_file_permissions_0600", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    expectPerms(join(home, CIRCLES_FILE), 0o600);
  } finally { cleanup(home); }
});

test("CirclesTest.test_corrupt_book_backed_up_then_throws", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    writeFileSync(join(home, CIRCLES_FILE), "{ not json", "utf-8");
    expect(() => loadCircleBook(home)).toThrow("已损坏，已备份");
    const bak = readdirSync(home).find((f) => f.startsWith(`${CIRCLES_FILE}.corrupt-`));
    expect(bak).toBeTruthy();
    expect(readFileSync(join(home, bak!), "utf-8")).toBe("{ not json");
    // 损坏的账本按不准入处理，不抛错（fail-closed）。
    expect(isAdmitted(home, "owner")).toBe(true);
    expect(isAdmitted(home, "pilot")).toBe(false);
    expect(checkCircleInbound(home, "telegram", "7").admitted).toBe(false);
  } finally { cleanup(home); }
});

// ---- 引入 / 撤销 -----------------------------------------------------------

test("CirclesTest.test_invite_requires_approved_unblocked_friend", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    // 好友账本里没有。
    expect(() => inviteToCircle(home, { circle: "work", identity: "ghost" })).toThrow("好友账本里没有");
    // 还没批准的请求。
    seedFriend(home, "pending-one", { inbound: "pending" });
    expect(() => inviteToCircle(home, { circle: "work", identity: "pending-one" })).toThrow("还不是好友");
    // 拉黑的。
    seedFriend(home, "blocked-one", { blocked: true });
    expect(() => inviteToCircle(home, { circle: "work", identity: "blocked-one" })).toThrow("已拉黑");
    // 圈不存在。
    seedFriend(home, "pilot");
    expect(() => inviteToCircle(home, { circle: "nope", identity: "pilot" })).toThrow("没有这个圈");
  } finally { cleanup(home); }
});

test("CirclesTest.test_invite_and_revoke_roundtrip", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    seedFriend(home, "pilot");
    const m: CircleMember = inviteToCircle(home, { circle: "work", identity: "pilot", channel: "telegram" });
    expect(m.invited_by).toBe("owner");
    expect(m.channel).toBe("telegram");
    expect(isAdmitted(home, "pilot")).toBe(true);
    expect(memberCircles(home, "pilot")).toEqual(["work"]);
    expect(() => inviteToCircle(home, { circle: "work", identity: "pilot" })).toThrow("已在");
    // 撤销后立即失去准入。
    revokeFromCircle(home, "work", "pilot");
    expect(isAdmitted(home, "pilot")).toBe(false);
    expect(memberCircles(home, "pilot")).toEqual([]);
    expect(() => revokeFromCircle(home, "work", "pilot")).toThrow("不在");
    // 删圈须先移空成员。
    inviteToCircle(home, { circle: "work", identity: "pilot" });
    expect(() => deleteCircle(home, "work")).toThrow("还有成员");
    revokeFromCircle(home, "work", "pilot");
    deleteCircle(home, "work");
    expect(listCircles(home)).toEqual([]);
  } finally { cleanup(home); }
});

test("CirclesTest.test_invite_only_by_owner_or_circle_member", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    seedFriend(home, "pilot");
    seedFriend(home, "second");
    // 圈外人不能引入。
    expect(() => inviteToCircle(home, { circle: "work", identity: "second", by: "outsider" })).toThrow("不在 work 圈里");
    // 圈内成员可以引入。
    inviteToCircle(home, { circle: "work", identity: "pilot" });
    const m = inviteToCircle(home, { circle: "work", identity: "second", by: "pilot", channel: "telegram" });
    expect(m.invited_by).toBe("pilot");
    expect(isAdmitted(home, "second")).toBe(true);
  } finally { cleanup(home); }
});

test("CirclesTest.test_admission_detail_reasons", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    seedFriend(home, "pilot");
    expect(admissionDetail(home, "owner")).toEqual({ admitted: true, reason: "机主本人，永远准入", circles: [] });
    const notIn = admissionDetail(home, "pilot");
    expect(notIn.admitted).toBe(false);
    expect(notIn.reason).toContain("不在任何信任圈里");
    inviteToCircle(home, { circle: "work", identity: "pilot" });
    const inCircle = admissionDetail(home, "pilot");
    expect(inCircle.admitted).toBe(true);
    expect(inCircle.circles).toEqual(["work"]);
    expect(admissionDetail(home, "ghost").admitted).toBe(false);
  } finally { cleanup(home); }
});

test("CirclesTest.test_circle_events_and_audit", () => {
  const home = tmpHome("nyra-cir-");
  try {
    createCircle(home, "work");
    seedFriend(home, "pilot");
    inviteToCircle(home, { circle: "work", identity: "pilot" });
    revokeFromCircle(home, "work", "pilot");
    const audit = readPeerAudit(home);
    expect(audit.map((r) => r.action)).toEqual(["circle_created", "circle_invited", "circle_revoked"]);
    expect(audit[1].peer).toBe("pilot");
    expect(audit[1].circle).toBe("work");
    // 引入/撤销进了证据链：运行事件里找得到。
    const store = new RunStore(join(home, "runs"));
    const events = store.list().flatMap((s) => store.readEvents(s.run_id));
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("circle_created");
    expect(kinds).toContain("circle_invited");
    expect(kinds).toContain("circle_revoked");
    const invited = events.find((e) => e.type === "circle_invited") as Record<string, unknown>;
    expect(invited.peer).toBe("pilot");
    expect(invited.circle).toBe("work");
  } finally { cleanup(home); }
});

// ---- 渠道发件人绑定 ---------------------------------------------------------

test("CirclesTest.test_bind_unbind_channel_sender", () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    expect(resolveSenderIdentity(home, "telegram", "7")).toBeNull();
    const b = bindChannelSender(home, { channel: "telegram", sender: "7", identity: "pilot" });
    expect(b.identity).toBe("pilot");
    expect(resolveSenderIdentity(home, "telegram", "7")).toBe("pilot");
    expect(listBindings(home)).toHaveLength(1);
    // 同一渠道+发件人重复绑定会覆盖。
    bindChannelSender(home, { channel: "telegram", sender: "7", identity: "owner" });
    expect(resolveSenderIdentity(home, "telegram", "7")).toBe("owner");
    expect(listBindings(home)).toHaveLength(1);
    unbindChannelSender(home, "telegram", "7");
    expect(resolveSenderIdentity(home, "telegram", "7")).toBeNull();
    expect(() => unbindChannelSender(home, "telegram", "7")).toThrow("没有这条绑定");
    // 渠道只认四个。
    expect(() => bindChannelSender(home, { channel: "email", sender: "7", identity: "pilot" })).toThrow("渠道只认");
    // 绑定只认已批准好友。
    expect(() => bindChannelSender(home, { channel: "telegram", sender: "8", identity: "ghost" })).toThrow("好友账本里没有");
  } finally { cleanup(home); }
});

test("CirclesTest.test_check_circle_inbound", () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    seedFriend(home, "outsider");
    createCircle(home, "work");
    inviteToCircle(home, { circle: "work", identity: "pilot" });
    bindChannelSender(home, { channel: "telegram", sender: "7", identity: "pilot" });
    bindChannelSender(home, { channel: "telegram", sender: "8", identity: "outsider" });
    bindChannelSender(home, { channel: "telegram", sender: "1", identity: "owner" });
    const admitted = checkCircleInbound(home, "telegram", "7");
    expect(admitted).toEqual({ admitted: true, identity: "pilot", reason: expect.stringContaining("work") });
    expect(checkCircleInbound(home, "telegram", "8").admitted).toBe(false);
    expect(checkCircleInbound(home, "telegram", "8").identity).toBe("outsider");
    expect(checkCircleInbound(home, "telegram", "1")).toEqual({ admitted: true, identity: "owner", reason: "机主本人" });
    // 未绑定的发件人默认丢弃。
    const unknown = checkCircleInbound(home, "telegram", "999");
    expect(unknown.admitted).toBe(false);
    expect(unknown.identity).toBeNull();
    expect(unknown.reason).toContain("未绑定身份");
  } finally { cleanup(home); }
});

// ---- CLI -------------------------------------------------------------------

test("CirclesTest.test_cli_end_to_end", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    expect(await handleCircle(["create", "work"], home)).toBe(0);
    expect(await handleCircle(["invite", "work", "pilot"], home)).toBe(0);
    expect(await handleCircle(["check", "pilot"], home)).toBe(0);
    expect(await handleCircle(["bind", "--channel", "telegram", "--sender", "7", "--friend", "pilot"], home)).toBe(0);
    expect(await handleCircle(["owner", "--channel", "telegram", "--sender", "1"], home)).toBe(0);
    expect(await handleCircle(["bindings"], home)).toBe(0);
    expect(await handleCircle(["show", "work"], home)).toBe(0);
    expect(await handleCircle(["list"], home)).toBe(0);
    // 撤销与删圈须 --yes。
    expect(await handleCircle(["revoke", "work", "pilot"], home)).toBe(2);
    expect(await handleCircle(["revoke", "work", "pilot", "--yes"], home)).toBe(0);
    expect(await handleCircle(["check", "pilot"], home)).toBe(1);
    expect(await handleCircle(["delete", "work", "--yes"], home)).toBe(0);
    expect(listCircles(home)).toEqual([]);
  } finally { cleanup(home); }
});

test("CirclesTest.test_cli_invite_by_non_member_rejected", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    seedFriend(home, "second");
    await handleCircle(["create", "work"], home);
    expect(await handleCircle(["invite", "work", "second", "--by", "outsider"], home)).toBe(1);
    expect(isAdmitted(home, "second")).toBe(false);
  } finally { cleanup(home); }
});

// ---- 网关预过滤 -------------------------------------------------------------

class FakeRunner implements ChannelRunner {
  readonly agent: string;
  readonly bindingId: string | null;
  handled: InboundMessage[] = [];
  constructor(agent: string, bindingId: string) {
    this.agent = agent;
    this.bindingId = bindingId;
  }
  async handleMessage(msg: InboundMessage): Promise<void> {
    this.handled.push(msg);
  }
  startServices(): void {}
  stopServices(): void {}
  status(): BotStatus {
    return { running: true, model: "fake:test", queueDepth: 0, activeSessions: [], todaySpentUsd: 0, dedupSize: 0, monthlySpentUsd: null, monthlyLimitUsd: null, pendingApprovals: 0 };
  }
}

function gwMsg(over: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "100",
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

function gwBinding(): ChannelBinding {
  return {
    id: "bd-one", channel: "telegram", chat: "*", sender: "*", agent: "nyra",
    sandbox: "standard", admission: "open", allowlist: [], mentionOnly: null, priority: 0,
    voiceCloud: false, enabled: true, createdAt: now(), updatedAt: now(),
  } as ChannelBinding;
}

class FakeChannelAdapter implements ChannelAdapter {
  readonly channel: "telegram" | "discord" | "slack" | "whatsapp" = "telegram";
  botUsername: string | null = "FakeBot";
  private queue: InboundMessage[];
  constructor(queue: InboundMessage[]) {
    this.queue = [...queue];
  }
  async getMe(): Promise<{ id: number; username: string | null }> {
    return { id: 1, username: "FakeBot" };
  }
  async pollOnce(): Promise<InboundMessage[]> {
    await new Promise((r) => setTimeout(r, 10));
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }
  async sendText(_msg: OutgoingMessage): Promise<string> {
    return "1";
  }
  async editText(): Promise<void> {}
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

test("CirclesTest.test_gateway_drops_out_of_circle", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedAdmission(home, "pilot");
    bindChannelSender(home, { channel: "telegram", sender: "7", identity: "pilot" });
    bindChannelSender(home, { channel: "telegram", sender: "1", identity: "owner" });
    saveBindingStore(home, { version: 1, bindings: [gwBinding()] });
    const runner = new FakeRunner("nyra", "bd-one");
    const tgQueue = [
      gwMsg({ messageId: "m-out", senderId: "999" }),
      gwMsg({ messageId: "m-in", senderId: "7" }),
      gwMsg({ messageId: "m-owner", senderId: "1" }),
    ];
    const gateway = new ChannelGateway({
      home, workdir: home, config: {},
      createAdapter: (channel) => (channel === "telegram" ? new FakeChannelAdapter(tgQueue) : null),
      createRunner: () => runner,
    });
    await gateway.start();
    // 圈外发件人丢弃、圈内好友与机主照常路由。
    const ok = await waitFor(() => runner.handled.length === 2);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(runner.handled.map((m) => m.messageId)).toEqual(["m-in", "m-owner"]);
    const audit = readBotAudit(home);
    const dropped = audit.find((r) => r.message_id === "m-out");
    expect(dropped?.outcome).toBe("dropped:circle");
    expect(dropped?.rule).toBe("circle:admission");
    expect(dropped?.reason).toContain("未绑定身份");
    expect(audit.find((r) => r.message_id === "m-in")?.outcome).toBe("routed");
    expect(gateway.status().channels.find((c) => c.channel === "telegram")?.dropped).toBe(1);
    expect(gateway.status().channels.find((c) => c.channel === "telegram")?.routed).toBe(2);
    gateway.stop();
  } finally { cleanup(home); }
});

// ---- 对端互问 / 交接 / 分享的准入闸 -----------------------------------------

test("CirclesTest.test_ask_peer_blocked_out_of_circle", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    const peer: PeerEntry = { name: "pilot", url: "http://127.0.0.1:9/mcp" };
    await expect(askPeer({
      config: peerConfig(), home, peer, question: "帮我看看这段日志",
      deps: { reviewerRunner: allowRunner },
    })).rejects.toThrow("不在信任圈里");
    // 拒绝进了 Beads 与审计（失败路径），没去连对端。
    const audit = readPeerAudit(home);
    expect(audit.some((r) => r.action === "ask" && r.ok === false)).toBe(true);
  } finally { cleanup(home); }
});

test("CirclesTest.test_ask_peer_passes_gate_when_admitted", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedAdmission(home, "pilot");
    const peer: PeerEntry = { name: "pilot", url: "http://127.0.0.1:9/mcp" };
    // 过了准入闸才会去连对端：对端连不上，报错应是连接失败而不是“不在信任圈里”。
    let msg = "";
    try {
      await askPeer({ config: peerConfig(), home, peer, question: "帮我看看这段日志", deps: { reviewerRunner: allowRunner } });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).not.toContain("不在信任圈里");
    expect(msg.length).toBeGreaterThan(0);
  } finally { cleanup(home); }
});

test("CirclesTest.test_handoff_peer_blocked_out_of_circle", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    const store = new RunStore(join(home, "runs"));
    const state = store.create("测试任务：整理一份周报", "agent", process.cwd(), "readonly", 1, "completed_unverified");
    const out = await handoffPeer({
      config: peerConfig(), home, peer: { name: "pilot", url: "http://127.0.0.1:9/mcp" },
      runId: state.run_id, deps: { reviewerRunner: allowRunner },
    });
    expect(out.status).toBe("rejected");
    expect(out.bead.error).toContain("不在信任圈里");
  } finally { cleanup(home); }
});

test("CirclesTest.test_handoff_peer_passes_gate_when_admitted", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedAdmission(home, "pilot");
    const store = new RunStore(join(home, "runs"));
    const state = store.create("测试任务：整理一份周报", "agent", process.cwd(), "readonly", 1, "completed_unverified");
    const out = await handoffPeer({
      config: peerConfig(), home, peer: { name: "pilot", url: "http://127.0.0.1:9/mcp" },
      runId: state.run_id, deps: { reviewerRunner: allowRunner },
    });
    // 过了准入闸才会去连对端：连不上记 failed，不是 rejected。
    expect(out.status).toBe("failed");
    expect(out.bead.error ?? "").not.toContain("不在信任圈里");
  } finally { cleanup(home); }
});

test("CirclesTest.test_share_with_friend_blocked_out_of_circle", async () => {
  const home = tmpHome("nyra-cir-");
  try {
    seedFriend(home, "pilot");
    const store = new RunStore(join(home, "runs"));
    const state = store.create("测试任务：整理一份周报", "agent", process.cwd(), "readonly", 1, "completed_unverified");
    const calls: string[] = [];
    await expect(shareWithFriend(home, peerConfig(), {
      to: "pilot", runId: state.run_id,
      deps: {
        reviewerRunner: allowRunner,
        clientFactory: () => {
          calls.push("called");
          throw new Error("不应被调用");
        },
      },
    })).rejects.toThrow("不在信任圈里");
    // 整批拒绝：对端一次没被叫。
    expect(calls).toEqual([]);
  } finally { cleanup(home); }
});
