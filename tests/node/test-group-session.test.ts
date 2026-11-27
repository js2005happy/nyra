// tests/node/test-group-session.test.ts — Bot 群聊会话批。
// 全部用临时 home 与假 runner/假账本，不调真实模型、不联网。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupStore, type Bot, type BotRunner, type BotTurnContext } from "../../src/groups.ts";
import {
  consumeSessionApproval,
  completeAssignment,
  createAssignment,
  createGroupSession,
  dropAssignment,
  endGroupSession,
  findSessionApproval,
  getGroupSession,
  inviteToSession,
  listGroupSessions,
  memberToolAllowlist,
  nextSpeaker,
  recordSessionApproval,
  runSessionRound,
  sessionPresence,
  staleAssignments,
  type GroupSession,
} from "../../src/groupSession.ts";
import type { Skill } from "../../src/skills.ts";
import { recordPresenceHeartbeat } from "../../src/gatewayPresence.ts";
import { createCircle } from "../../src/circles.ts";
import { RunStore } from "../../src/runs.ts";
import { TOOL_SCHEMAS } from "../../src/tools.ts";
import { BudgetLedger, type BudgetReservation } from "../../src/budget.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-group-session-"));
}

function makeStore(home: string, runner: BotRunner): GroupStore {
  return new GroupStore(join(home, "groups"), { home, botRunner: runner });
}

function scriptRunner(script: Record<string, string[]>): BotRunner & { calls: string[] } {
  const calls: string[] = [];
  const seen: Record<string, number> = {};
  const runner = (async (bot: Bot, _prompt: string, _ctx: BotTurnContext) => {
    calls.push(bot.id);
    const n = seen[bot.id] ?? 0;
    seen[bot.id] = n + 1;
    const lines = script[bot.id] ?? ["（无回复）"];
    return { text: lines[Math.min(n, lines.length - 1)] };
  }) as BotRunner & { calls: string[] };
  runner.calls = calls;
  return runner;
}

function makeRoom(home: string, store: GroupStore, bots = ["bot-a", "bot-b"], roomId = "room-1"): string {
  store.create(roomId, "测试房间", bots.map((id) => ({
    id,
    name: id,
    role: "测试",
    instructions: `你是测试机器人 ${id}。`,
  })));
  return roomId;
}

function fakeLedger(blockBot?: string): Pick<
  import("../../src/budget.ts").BudgetLedger,
  "reserve" | "settle" | "release"
> & { reserved: string[]; settled: string[]; released: string[] } {
  const reserved: string[] = [];
  const settled: string[] = [];
  const released: string[] = [];
  let n = 0;
  const row = (owner: string, amountUsd: number): BudgetReservation => ({
    id: `rsv-test-${n++}`,
    owner,
    amountUsd,
    reason: "group-turn",
    bindingScope: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    pid: null,
    status: "reserved",
    settledUsd: null,
  });
  return {
    reserved,
    settled,
    released,
    reserve(owner: string, amountUsd: number, opts: { reason?: string } = {}) {
      reserved.push(owner);
      if (blockBot && owner.endsWith(`:${blockBot}`)) {
        return { ok: false as const, reason: `${blockBot} 的预算已触顶`, bindingScope: null as string | null };
      }
      return { ok: true as const, reservation: row(owner, amountUsd) };
    },
    settle(id: string, actualUsd: number) {
      settled.push(`${id}:${actualUsd}`);
      return row("settled", actualUsd);
    },
    release(id: string) {
      released.push(id);
      return row("released", 0);
    },
  };
}

test("GroupSession.test_create_owner_and_bots", () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const { session, pausedPrevious } = createGroupSession(home, "room-1", { store });
    expect(session.id.startsWith("gs-")).toBe(true);
    expect(session.status).toBe("open");
    expect(session.name).toBe("测试房间");
    expect(pausedPrevious).toEqual([]);
    const owner = session.members.find((m) => m.kind === "owner");
    expect(owner?.id).toBe("owner");
    expect(session.members.filter((m) => m.kind === "bot").map((m) => m.id)).toEqual(["bot-a", "bot-b"]);
    expect(existsSync(join(home, "group-sessions", `${session.id}.json`))).toBe(true);
    const again = getGroupSession(home, session.id);
    expect(again.roomId).toBe("room-1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_create_one_open_per_room", () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const first = createGroupSession(home, "room-1", { store }).session;
    const second = createGroupSession(home, "room-1", { store });
    expect(second.pausedPrevious).toEqual([first.id]);
    expect(getGroupSession(home, first.id).status).toBe("paused");
    expect(second.session.status).toBe("open");
    expect(listGroupSessions(home).map((s) => s.id)).toContain(second.session.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_create_rejects_bad_room_and_circle", () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    expect(() => createGroupSession(home, "no-such-room", { store })).toThrow();
    makeRoom(home, store);
    expect(() => createGroupSession(home, "room-1", { store, circle: "no-such-circle" })).toThrow("没有这个信任圈");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_create_member_cap_two_to_six", async () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store, ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e", "bot-f"]);
    const session = createGroupSession(home, "room-1", { store }).session;
    expect(session.members.filter((m) => m.kind === "bot").length).toBe(6);
    // 第 7 个邀请直接拒绝。
    const card = {
      name: "Extra",
      description: "多余的",
      version: "1.0",
      skills: [],
      authentication: { schemes: ["bearer"] },
      endpoints: { mcp: null },
    };
    await expect(inviteToSession(home, session.id, "https://example.com/card.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(card) }),
      },
    })).rejects.toThrow("到上限了");
    // 房间只有 1 个机器人时建会话也拒绝（手写 room.json 绕过房间创建的守卫）。
    const soloDir = join(home, "groups", "room-solo");
    mkdirSync(soloDir, { recursive: true });
    const soloRoom = JSON.parse(readFileSync(join(home, "groups", "room-1", "room.json"), "utf-8"));
    soloRoom.id = "room-solo";
    soloRoom.bots = soloRoom.bots.slice(0, 1);
    writeFileSync(join(soloDir, "room.json"), JSON.stringify(soloRoom, null, 2));
    expect(() => createGroupSession(home, "room-solo", { store })).toThrow("2–6");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_next_speaker_priority", () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    // @ 点名最高。
    expect(nextSpeaker(session, { ownerMessage: "@bot-b 请说" })).toEqual({ speaker: "bot-b", mode: "mention" });
    // 交接其次。
    expect(nextSpeaker(session, { lastBotMessage: "好的，HANDOFF: bot-b" })).toEqual({ speaker: "bot-b", mode: "handoff" });
    // 指派再次（负责人还没回）。
    const s2: GroupSession = {
      ...session,
      assignments: [{
        id: "asg-1", assignee: "bot-b", task: "写报告", status: "open",
        createdBy: "owner", createdAt: "2026-11-26T00:00:00.000Z", createdTurn: 0,
      }],
    };
    expect(nextSpeaker(s2, {})).toEqual({ speaker: "bot-b", mode: "assignment" });
    // 路由再次。
    expect(nextSpeaker(session, { routerPick: "bot-b" })).toEqual({ speaker: "bot-b", mode: "router" });
    // 都没有 → 轮询，从第一个开始。
    expect(nextSpeaker(session, {})).toEqual({ speaker: "bot-a", mode: "round-robin" });
    // 轮询接着上一个发言者走。
    const s3: GroupSession = { ...session, lastSpeaker: "bot-a", consecutiveTurns: 1 };
    expect(nextSpeaker(s3, {})).toEqual({ speaker: "bot-b", mode: "round-robin" });
    // 同一 Bot 连续 2 轮到顶：@ 点名与轮询都跳过它。
    const s4: GroupSession = { ...session, lastSpeaker: "bot-a", consecutiveTurns: 2 };
    expect(nextSpeaker(s4, { ownerMessage: "@bot-a 再说" })).toEqual({ speaker: "bot-b", mode: "round-robin" });
    expect(nextSpeaker(s4, {})).toEqual({ speaker: "bot-b", mode: "round-robin" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_broadcast_mention_all", async () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    // broadcast 走轮询、mode 是 broadcast；@all 不算点名（"all" 不是成员）。
    expect(nextSpeaker(session, { broadcast: true })).toEqual({ speaker: "bot-a", mode: "broadcast" });
    const s2: GroupSession = { ...session, lastSpeaker: "bot-a", consecutiveTurns: 1 };
    expect(nextSpeaker(s2, { broadcast: true })).toEqual({ speaker: "bot-b", mode: "broadcast" });
    expect(nextSpeaker(session, { ownerMessage: "@all 大家说说" })).toEqual({ speaker: "bot-a", mode: "round-robin" });
    // 整轮：@所有人 让全体各说一轮，mode 都是 broadcast，不建指派。
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store2 = makeStore(home, runner);
    makeRoom(home, store2, ["bot-a", "bot-b"], "room-2");
    const s3 = createGroupSession(home, "room-2", { store: store2 }).session;
    const result = await runSessionRound(home, s3.id, "@所有人 大家说说想法", {
      store: store2, botRunner: runner, ledger: fakeLedger(), rounds: 2,
    });
    expect(result.turns.map((t) => t.speaker)).toEqual(["bot-a", "bot-b"]);
    expect(result.turns.map((t) => t.mode)).toEqual(["broadcast", "broadcast"]);
    expect(result.session.assignments).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_round_robin_and_consecutive_cap", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1", "a2", "a3"], "bot-b": ["b1", "b2", "b3"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const result = await runSessionRound(home, session.id, "开始讨论", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 3,
    });
    expect(result.turns.map((t) => t.speaker)).toEqual(["bot-a", "bot-b", "bot-a"]);
    expect(result.turns.map((t) => t.mode)).toEqual(["round-robin", "round-robin", "round-robin"]);
    expect(result.session.turnCount).toBe(3);
    expect(result.stoppedBy).toBe("轮次跑完");
    // 同一 Bot 反复把话接回自己：连续 2 轮到顶即停。
    const runner2 = scriptRunner({ "bot-a": ["HANDOFF: bot-a 继续", "HANDOFF: bot-a 再继续", "HANDOFF: bot-a 还继续"], "bot-b": ["b1"] });
    const store2 = makeStore(home, runner2);
    makeRoom(home, store2, ["bot-a", "bot-b"], "room-2");
    const selfHandoff = createGroupSession(home, "room-2", { store: store2 }).session;
    const r2 = await runSessionRound(home, selfHandoff.id, "你好", {
      store: store2, botRunner: runner2, ledger: fakeLedger(), rounds: 5,
    });
    // 到顶只跳过该 Bot、落到下一位：5 轮跑满，但没有任何 Bot 连说 3 轮。
    expect(r2.turns.length).toBe(5);
    expect(r2.turns.map((t) => t.speaker)).toContain("bot-b");
    const speakers = r2.turns.map((t) => t.speaker);
    for (let i = 0; i + 2 < speakers.length; i++) {
      expect(speakers[i] === speakers[i + 1] && speakers[i + 1] === speakers[i + 2]).toBe(false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_round_reserves_conservative_estimate_without_estimate_usd", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const ledger = new BudgetLedger(home);
    const result = await runSessionRound(home, session.id, "开始讨论", {
      store, botRunner: runner, ledger, rounds: 1,
      pricing: { inputPer1M: 1, outputPer1M: 2 },
    });
    expect(result.turns.length).toBe(1);
    // 没给 estimateUsd 时不再预留 0：按单价保守估算（4 字提示 + 2000 补全 ≈ $0.004）。
    const rows = ledger.list().filter((r) => r.reason === "group-turn");
    expect(rows.length).toBe(1);
    expect(rows[0].amountUsd).toBeCloseTo(0.004, 4);
    // 既没 estimateUsd 也没 pricing：仍留 0（只靠事后 checkCost），如实记下来。
    const store2 = makeStore(home, runner);
    makeRoom(home, store2, ["bot-a", "bot-b"], "room-2");
    const session2 = createGroupSession(home, "room-2", { store: store2 }).session;
    const before = ledger.list().filter((r) => r.reason === "group-turn").length;
    await runSessionRound(home, session2.id, "开始讨论", {
      store: store2, botRunner: runner, ledger, rounds: 1,
    });
    const after = ledger.list().filter((r) => r.reason === "group-turn");
    expect(after.length).toBe(before + 1);
    // list() 是最新在前：after[0] 才是第二场的新行。
    expect(after[0].amountUsd).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_per_message_cap", async () => {
  const home = tmpHome();
  try {
    const script: Record<string, string[]> = {
      "bot-a": Array.from({ length: 30 }, (_, i) => `a${i}`),
      "bot-b": Array.from({ length: 30 }, (_, i) => `b${i}`),
    };
    const runner = scriptRunner(script);
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    // rounds 给 99 也只跑 10 条：每条机主消息有总上限（Hermes 对齐取 10）。
    const result = await runSessionRound(home, session.id, "长讨论", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 99,
    });
    expect(result.turns.length).toBe(10);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_empty_reply_passes", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": [""], "bot-b": ["b1", "b2"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const result = await runSessionRound(home, session.id, "开始", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 3,
    });
    expect(result.turns[0].speaker).toBe("bot-a");
    expect(result.turns[0].content).toBe("（无回复）");
    expect(result.turns[1].speaker).toBe("bot-b");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_owner_question_pauses_swarm", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const result = await runSessionRound(home, session.id, "这个怎么做？", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 3,
    });
    expect(result.turns.length).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_mention_creates_assignment_and_handoff", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({
      "bot-a": ["收到，HANDOFF: bot-b"],
      "bot-b": ["我来接，完成：报告写好了"],
    });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const result = await runSessionRound(home, session.id, "@bot-a 请把报告写好", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 3,
    });
    expect(result.turns[0].speaker).toBe("bot-a");
    expect(result.turns[0].mode).toBe("mention");
    expect(result.turns[1].speaker).toBe("bot-b");
    expect(result.turns[1].mode).toBe("handoff");
    const after = getGroupSession(home, session.id);
    expect(after.assignments.length).toBe(1);
    expect(after.assignments[0].assignee).toBe("bot-a");
    expect(after.assignments[0].status).toBe("open");
    // @ 点名那次的批准已被消耗（一次性）。
    expect(after.approvals.length).toBe(1);
    expect(after.approvals[0].used).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_assignment_done_drop_stale", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const a = createAssignment(home, session, "bot-b", "写报告", "owner");
    expect(a.status).toBe("open");
    const done = completeAssignment(home, getGroupSession(home, session.id), a.id);
    expect(done.status).toBe("done");
    expect(() => completeAssignment(home, getGroupSession(home, session.id), a.id)).toThrow();
    const b = createAssignment(home, getGroupSession(home, session.id), "bot-a", "再写一份", "owner");
    const dropped = dropAssignment(home, getGroupSession(home, session.id), b.id);
    expect(dropped.status).toBe("dropped");
    // stale：bot-b 的指派建在第 0 轮，5 轮过去负责人一次没回。
    const c = createAssignment(home, getGroupSession(home, session.id), "bot-b", "一直没人做", "owner");
    const s = getGroupSession(home, session.id);
    s.turnCount = 5;
    expect(staleAssignments(s).map((x) => x.id)).toContain(c.id);
    expect(staleAssignments(s).map((x) => x.id)).not.toContain(a.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_budget_per_bot_and_cap_skips_only_that_bot", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const ledger = fakeLedger("bot-b");
    const result = await runSessionRound(home, session.id, "开始", {
      store, botRunner: runner, ledger, rounds: 2,
      actualUsdFor: () => 0.001,
    });
    expect(result.turns.map((t) => t.speaker)).toEqual(["bot-a"]);
    expect(result.skipped.map((s) => s.bot)).toEqual(["bot-b"]);
    expect(ledger.reserved).toContain(`group:${session.id}:bot-a`);
    expect(ledger.reserved).toContain(`group:${session.id}:bot-b`);
    expect(ledger.settled.length).toBe(1);
    expect(ledger.settled[0].endsWith(":0.001")).toBe(true);
    // 没给 actualUsdFor 时走 release（不编数字）。
    const ledger2 = fakeLedger();
    const session2 = createGroupSession(home, "room-1", { store }).session;
    await runSessionRound(home, session2.id, "开始", {
      store, botRunner: runner, ledger: ledger2, rounds: 1,
    });
    expect(ledger2.released.length).toBe(1);
    expect(ledger2.settled.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_approval_is_per_bot_and_single_use", () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    recordSessionApproval(home, session, "bot-a", "write_file", "approved");
    // 另一 Bot 同名工具查不到批准。
    expect(findSessionApproval(session, "bot-b", "write_file")).toBeNull();
    expect(findSessionApproval(session, "bot-a", "write_file")).not.toBeNull();
    // 消耗一次后就没了。
    expect(consumeSessionApproval(home, session, "bot-a", "write_file")).toBe(true);
    expect(findSessionApproval(session, "bot-a", "write_file")).toBeNull();
    expect(consumeSessionApproval(home, session, "bot-a", "write_file")).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_presence_owner_and_bots", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    // 机主刚在网关报过心跳 → 在线。
    recordPresenceHeartbeat(home, { client: "owner", kind: "owner", source: "heartbeat" });
    const s = getGroupSession(home, session.id);
    const botB = s.members.find((m) => m.id === "bot-b");
    if (botB) botB.lastActiveAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const { saveSessionFile } = await import("../../src/groupSession.ts");
    saveSessionFile(home, s);
    const p = sessionPresence(home, s);
    expect(p.owner.active).toBe(true);
    expect(p.bots.find((b) => b.id === "bot-a")?.active).toBe(true);
    expect(p.bots.find((b) => b.id === "bot-b")?.active).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_invite_by_card_and_bad_card", async () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const goodCard = {
      name: "Card Bot",
      description: "受邀测试机器人",
      version: "1.0",
      skills: [{ id: "chat", name: "聊天", description: "聊天" }],
      authentication: { schemes: ["bearer"] },
      endpoints: { mcp: null },
    };
    const member = await inviteToSession(home, session.id, "https://example.com/.well-known/agent-card.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(goodCard) }),
      },
    });
    expect(member.id).toBe("card-bot");
    expect(member.invited).toBe(true);
    expect(member.provider).toBeNull();
    expect(getGroupSession(home, session.id).members.map((m) => m.id)).toContain("card-bot");
    // 坏卡片（缺 name）直接拒绝。
    await expect(inviteToSession(home, session.id, "https://example.com/bad.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ description: "x", skills: [] }) }),
      },
    })).rejects.toThrow();
    // 好友账本里没有的名字也拒绝。
    await expect(inviteToSession(home, session.id, "不存在的好友")).rejects.toThrow("好友账本里没有");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_invited_member_can_speak_via_injected_runner", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({
      "bot-a": ["a1"],
      "card-bot": ["我是受邀成员"],
    });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const goodCard = {
      name: "Card Bot",
      description: "受邀测试机器人",
      version: "1.0",
      skills: [{ id: "chat", name: "聊天", description: "聊天" }],
      authentication: { schemes: ["bearer"] },
      endpoints: { mcp: null },
    };
    await inviteToSession(home, session.id, "https://example.com/.well-known/agent-card.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(goodCard) }),
      },
    });
    const result = await runSessionRound(home, session.id, "@card-bot 你好", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 1,
    });
    expect(result.turns[0].speaker).toBe("card-bot");
    expect(result.turns[0].content).toBe("我是受邀成员");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_invite_posts_self_intro", async () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const goodCard = {
      name: "Card Bot",
      description: "受邀测试机器人",
      version: "1.0",
      skills: [{ id: "chat", name: "聊天", description: "聊天" }],
      authentication: { schemes: ["bearer"] },
      endpoints: { mcp: null },
    };
    const member = await inviteToSession(home, session.id, "https://example.com/.well-known/agent-card.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(goodCard) }),
      },
      store,
    });
    expect(member.description).toBe("受邀测试机器人");
    expect(member.skills).toEqual(["聊天"]);
    const room = store.get("room-1");
    const intro = room.messages.find((m) => m.sender === "card-bot");
    expect(intro?.content).toContain("大家好，我是Card Bot");
    expect(intro?.content).toContain("受邀测试机器人");
    // 邀请后会话文件里也能读回描述与技能。
    const back = getGroupSession(home, session.id).members.find((m) => m.id === "card-bot");
    expect(back?.description).toBe("受邀测试机器人");
    expect(back?.skills).toEqual(["聊天"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_member_tool_allowlist", () => {
  const member = {
    kind: "bot",
    id: "card-bot",
    name: "Card Bot",
    skills: ["聊天", "不存在的技能"],
  } as GroupSessionMember;
  const skills: Skill[] = [
    { name: "聊天", description: "", when: "", keywords: [], allowedTools: ["read_file", "grep_search"], instructions: "", path: "/tmp/chat.md" },
    { name: "搜索", description: "", when: "", keywords: [], allowedTools: ["web_search"], instructions: "", path: "/tmp/search.md" },
  ];
  expect(memberToolAllowlist(member, skills)).toEqual(["grep_search", "read_file"]);
  expect(memberToolAllowlist({ ...member, skills: ["搜索"] }, skills)).toEqual(["web_search"]);
  // 没技能、或技能本地没有、或命中的技能没声明工具时都不限。
  expect(memberToolAllowlist({ ...member, skills: [] }, skills)).toBeNull();
  expect(memberToolAllowlist({ ...member, skills: ["不存在的技能"] }, skills)).toBeNull();
  expect(memberToolAllowlist({ ...member, skills: ["聊天"] }, [{ ...skills[0], allowedTools: undefined }])).toBeNull();
});

test("GroupSession.test_invited_member_tools_filtered_by_skills", async () => {
  const home = tmpHome();
  try {
    // 本地技能：聊天技能只声明 read_file。
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(
      join(home, "skills", "chat.md"),
      "---\nname: 聊天\ndescription: 聊天\nallowed-tools: read_file\n---\n聊天技能。\n",
    );
    const seen: { id: string; allowedTools: string[] | null }[] = [];
    const runner = (async (bot: Bot, _prompt: string, ctx: BotTurnContext) => {
      seen.push({ id: bot.id, allowedTools: ctx.allowedTools ?? null });
      return { text: `${bot.id} 回复` };
    }) as BotRunner;
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    const goodCard = {
      name: "Card Bot",
      description: "受邀测试机器人",
      version: "1.0",
      skills: [{ id: "chat", name: "聊天", description: "聊天" }],
      authentication: { schemes: ["bearer"] },
      endpoints: { mcp: null },
    };
    await inviteToSession(home, session.id, "https://example.com/.well-known/agent-card.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(goodCard) }),
      },
      store,
    });
    await runSessionRound(home, session.id, "@card-bot 你好", {
      store, botRunner: runner, ledger: fakeLedger(), rounds: 2,
    });
    expect(seen.find((s) => s.id === "card-bot")?.allowedTools).toEqual(["read_file"]);
    // 没技能的本地成员不限工具。
    expect(seen.find((s) => s.id === "bot-a")?.allowedTools ?? null).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_local_member_provider_model", async () => {
  const home = tmpHome();
  try {
    // 本地建房间时指定 provider/model：会话成员带上它。
    const store = makeStore(home, scriptRunner({}));
    store.create("room-1", "测试房间", [
      { id: "bot-a", name: "bot-a", role: "测试", instructions: "你是测试机器人。", provider: "openlux", model: "deepseek-v4.1-flash" },
      { id: "bot-b", name: "bot-b", role: "测试", instructions: "你是测试机器人。" },
    ]);
    const session = createGroupSession(home, "room-1", { store }).session;
    const a = session.members.find((m) => m.id === "bot-a");
    expect(a?.provider).toBe("openlux");
    expect(a?.model).toBe("deepseek-v4.1-flash");
    expect(session.members.find((m) => m.id === "bot-b")?.model).toBeNull();
    // 邀请时顺带指定 provider/model。
    const card = {
      name: "Card Bot",
      description: "受邀",
      version: "1.0",
      skills: [],
      authentication: { schemes: ["bearer"] },
      endpoints: { mcp: null },
    };
    const member = await inviteToSession(home, session.id, "https://example.com/card.json", {
      fetchDeps: {
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(card) }),
      },
      provider: "deepseek",
      model: "deepseek-flash",
    });
    expect(member.provider).toBe("deepseek");
    expect(member.model).toBe("deepseek-flash");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_circle_visibility", () => {
  const home = tmpHome();
  try {
    const store = makeStore(home, scriptRunner({}));
    makeRoom(home, store);
    createCircle(home, "team", { description: "测试圈" });
    const s = createGroupSession(home, "room-1", { store, circle: "team" }).session;
    // 默认列表不列非 default 圈的会话（机主不在该圈成员里）。
    expect(listGroupSessions(home).map((x) => x.id)).not.toContain(s.id);
    expect(listGroupSessions(home, { circle: "team" }).map((x) => x.id)).toContain(s.id);
    expect(() => createGroupSession(home, "room-1", { store, circle: "nope" })).toThrow("没有这个信任圈");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_events_registered", () => {
  const home = tmpHome();
  try {
    const store = new RunStore(join(home, "runs"));
    const state = store.create("群聊会话事件测试", "group-session", process.cwd(), "readonly", 1, "running");
    const cases: [string, Record<string, unknown>][] = [
      ["group_session_created", { session: "gs-01234567", room: "room-1", members: 3 }],
      ["group_session_ended", { session: "gs-01234567", room: "room-1", turns: 5 }],
      ["group_turn", { session: "gs-01234567", room: "room-1", speaker: "bot-a", mode: "round-robin" }],
      ["group_assignment", { session: "gs-01234567", room: "room-1", assignment: "asg-1", assignee: "bot-a", status: "open" }],
      ["group_member", { session: "gs-01234567", room: "room-1", member: "bot-a", kind: "bot", action: "invited" }],
      ["group_approval", { session: "gs-01234567", room: "room-1", bot: "bot-a", tool: "assign", approved: true }],
      ["group_budget", { session: "gs-01234567", room: "room-1", bot: "bot-a", reserved_usd: 0.001, settled_usd: 0.001 }],
    ];
    for (const [type, fields] of cases) {
      store.appendEvent(state.run_id, type, fields);
    }
    const text = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
    for (const [type] of cases) expect(text).toContain(`"type":"${type}"`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GroupSession.test_tool_schemas", () => {
  const names = TOOL_SCHEMAS.map((s) => (s.function as { name: string }).name);
  expect(names).toContain("group_session_create");
  expect(names).toContain("group_session_send");
  expect(names).toContain("group_session_assign");
  expect(names.length).toBe(54);
});

// ---- CLI 冒烟：子进程跑真 CLI，建房间 → 建会话 → 列表/展示/发送/指派/完成/presence/结束 ----

const CLI = join(import.meta.dir, "../../src/cli.ts");

async function runCli(args: string[], home: string, workdir: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args, "--workdir", workdir], {
    env: { ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + err };
}

test("GroupSession.test_cli_smoke", async () => {
  const home = tmpHome();
  const workdir = tmpHome();
  try {
    let r = await runCli(["group", "session", "--help"], home, workdir);
    expect(r.out).toContain("create|list|show|send|members|assign|done|presence|invite|end");
    r = await runCli(["group", "room", "create", "room-1", "测试房间", "--bot", "bot-a", "--bot", "bot-b"], home, workdir);
    expect(r.code).toBe(0);
    r = await runCli(["group", "session", "create", "room-1"], home, workdir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("群聊会话已建");
    const id = r.out.match(/gs-[0-9a-f]+/)?.[0];
    expect(id).toBeTruthy();
    r = await runCli(["group", "session", "list"], home, workdir);
    expect(r.out).toContain(id!);
    r = await runCli(["group", "session", "show", id!], home, workdir);
    expect(r.out).toContain("成员");
    // 没有模型凭证：机器人会报错，但命令本身应正常结束（错误记进群记录）。
    r = await runCli(["group", "session", "send", id!, "大家好"], home, workdir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 轮");
    expect(r.out).toContain("轮次跑完");
    r = await runCli(["group", "session", "assign", id!, "@bot-a", "测试任务"], home, workdir);
    expect(r.out).toContain("指派已建");
    const asg = r.out.match(/asg-[0-9a-f]+/)?.[0];
    expect(asg).toBeTruthy();
    r = await runCli(["group", "session", "done", id!, asg!], home, workdir);
    expect(r.out).toContain("指派已完成");
    r = await runCli(["group", "session", "presence", id!], home, workdir);
    expect(r.out).toContain("机主");
    r = await runCli(["group", "session", "end", id!], home, workdir);
    expect(r.out).toContain("会话已结束");
    r = await runCli(["group", "session", "list"], home, workdir);
    expect(r.out).toContain("ended");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}, 60_000);

test("GroupSession.test_cli_room_create_provider_model", async () => {
  const home = tmpHome();
  const workdir = tmpHome();
  try {
    // 本地建房间时 --provider/--model 落到会话成员身上。
    let r = await runCli(
      ["group", "room", "create", "room-1", "测试房间", "--bot", "bot-a", "--bot", "bot-b",
        "--provider", "openlux", "--model", "deepseek-v4.1-flash"],
      home, workdir,
    );
    expect(r.code).toBe(0);
    r = await runCli(["group", "session", "create", "room-1"], home, workdir);
    expect(r.code).toBe(0);
    const id = r.out.match(/gs-[0-9a-f]+/)?.[0];
    expect(id).toBeTruthy();
    const member = getGroupSession(home, id!).members.find((m) => m.id === "bot-a");
    expect(member?.provider).toBe("openlux");
    expect(member?.model).toBe("deepseek-v4.1-flash");
    // invite 没给 --card 时报用法错，不崩。
    r = await runCli(["group", "session", "invite", id!, "--provider", "deepseek"], home, workdir);
    expect(r.code).toBe(2);
    expect(r.out).toContain("用法");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}, 60_000);
