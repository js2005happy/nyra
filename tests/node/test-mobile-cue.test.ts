// tests/node/test-mobile-cue.test.ts — Cue 方向 B 批：探索页模板、个人页接口、
// 邀请账本、Bot Mode 开关。全部用临时 home 与假 runner，不调真实模型、不联网。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExploreTemplates, getExploreTemplate } from "../../src/mobileExplore.ts";
import { createInvite, inviteQuota, loadInvites, revokeInvite, InviteError, INVITE_TOTAL_SLOTS } from "../../src/invites.ts";
import { BOT_MODE_OFF_MESSAGE, isBotModeEnabled, loadBotMode, setBotMode } from "../../src/groupBotMode.ts";
import { GroupStore, type Bot, type BotRunner, type BotTurnContext } from "../../src/groups.ts";
import { createGroupSession, runSessionRound } from "../../src/groupSession.ts";
import type { BudgetReservation } from "../../src/budget.ts";
import { Gateway } from "../../src/gateway.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-mobile-cue-"));
}

function makeStore(home: string, runner: BotRunner): GroupStore {
  return new GroupStore(join(home, "groups"), { home, botRunner: runner });
}

function scriptRunner(script: Record<string, string[]>): BotRunner {
  const seen: Record<string, number> = {};
  return (async (bot: Bot, _prompt: string, _ctx: BotTurnContext) => {
    const n = seen[bot.id] ?? 0;
    seen[bot.id] = n + 1;
    const lines = script[bot.id] ?? ["（无回复）"];
    return { text: lines[Math.min(n, lines.length - 1)] };
  }) as BotRunner;
}

function makeRoom(home: string, store: GroupStore, bots = ["bot-a", "bot-b"], roomId = "room-1"): string {
  store.create(roomId, "测试房间", bots.map((id) => ({
    id, name: id, role: "测试", instructions: `你是测试机器人 ${id}。`,
  })));
  return roomId;
}

function fakeLedger(): Pick<import("../../src/budget.ts").BudgetLedger, "reserve" | "settle" | "release"> {
  let n = 0;
  const row = (owner: string, amountUsd: number): BudgetReservation => ({
    id: `rsv-test-${n++}`, owner, amountUsd, reason: "group-turn", bindingScope: null,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    pid: null, status: "reserved", settledUsd: null,
  });
  return {
    reserve(owner: string, amountUsd: number) { return { ok: true as const, reservation: row(owner, amountUsd) }; },
    settle(id: string, actualUsd: number) { return row("settled", actualUsd); },
    release(id: string) { return row("released", 0); },
  };
}

// ---------------------------------------------------------------- 探索页 ---
test("MobileCue.test_explore_templates_six_from_cue", () => {
  const list = listExploreTemplates();
  expect(list.map((t) => t.id)).toEqual(["parcel", "housing", "monitor", "fridge", "save", "ticket"]);
  for (const t of list) {
    expect(t.title.zh.length).toBeGreaterThan(0);
    expect(t.title.en.length).toBeGreaterThan(0);
    expect(t.subtitle.zh.length).toBeGreaterThan(0);
    expect(t.prompt.zh.length).toBeGreaterThan(10);
    expect(t.prompt.en.length).toBeGreaterThan(10);
    // 模板只是开场白：不编“已完成”的结果、不编价格与班次。
    for (const lang of ["zh", "en"] as const) {
      expect(t.prompt[lang]).not.toContain("已下单");
      expect(t.prompt[lang]).not.toContain("已订好");
      expect(t.prompt[lang]).not.toContain("已寄出");
    }
    expect(t.prompt.zh).toContain("先问我");
  }
  expect(getExploreTemplate("parcel")?.id).toBe("parcel");
  expect(getExploreTemplate("no-such")).toBeNull();
  // 返回的是副本：改了不影响内置表。
  const again = listExploreTemplates();
  again[0].title.zh = "改过";
  expect(listExploreTemplates()[0].title.zh).toBe("寄包裹");
});

// ---------------------------------------------------------------- 邀请账本 ---
test("MobileCue.test_invite_quota_five_slots_revoke_frees", () => {
  const home = tmpHome();
  try {
    expect(INVITE_TOTAL_SLOTS).toBe(5);
    expect(inviteQuota(home)).toEqual({ total: 5, used: 0, remaining: 5 });
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rec = createInvite(home, `第${i + 1}个`);
      expect(/^[A-HJ-NP-Z2-9]{6}$/.test(rec.code)).toBe(true);
      expect(rec.status).toBe("active");
      expect(rec.redeemedBy).toEqual([]);
      codes.push(rec.code);
    }
    expect(new Set(codes).size).toBe(5);
    expect(inviteQuota(home)).toEqual({ total: 5, used: 5, remaining: 0 });
    // 第 6 个超发拒绝，不编名额。
    expect(() => createInvite(home)).toThrow("名额已用完");
    // 吊销一个释放名额，再发一个能发。
    const revoked = revokeInvite(home, codes[0]);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();
    expect(inviteQuota(home)).toEqual({ total: 5, used: 4, remaining: 1 });
    expect(() => revokeInvite(home, codes[0])).toThrow("已经吊销过了");
    expect(() => revokeInvite(home, "ZZZZZZ")).toThrow("没有这个邀请码");
    const again = createInvite(home);
    expect(again.code).not.toBe(codes[0]);
    // 落盘：文件在，0600，读回一致。
    const path = join(home, "invites.json");
    expect(existsSync(path)).toBe(true);
    const stored = loadInvites(home);
    expect(stored.invites.length).toBe(6);
    expect(stored.invites.filter((i) => i.status === "active").length).toBe(5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Bot Mode 开关 ---
test("MobileCue.test_bot_mode_default_on_toggle_persists", () => {
  const home = tmpHome();
  try {
    expect(isBotModeEnabled(home)).toBe(true);
    expect(loadBotMode(home).enabled).toBe(true);
    const off = setBotMode(home, false);
    expect(off.enabled).toBe(false);
    expect(isBotModeEnabled(home)).toBe(false);
    expect(existsSync(join(home, "group-bot-mode.json"))).toBe(true);
    // 坏文件 fail-open：不把群聊整个关掉。
    writeFileSync(join(home, "group-bot-mode.json"), "{坏掉");
    expect(isBotModeEnabled(home)).toBe(true);
    setBotMode(home, true);
    expect(isBotModeEnabled(home)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("MobileCue.test_bot_mode_off_blocks_session_round_and_room_send", async () => {
  const home = tmpHome();
  try {
    const runner = scriptRunner({ "bot-a": ["a1"], "bot-b": ["b1"] });
    const store = makeStore(home, runner);
    makeRoom(home, store);
    const session = createGroupSession(home, "room-1", { store }).session;
    // 默认开：能跑一轮。
    const ok = await runSessionRound(home, session.id, "开始讨论", { store, botRunner: runner, ledger: fakeLedger(), rounds: 1 });
    expect(ok.turns.length).toBeGreaterThan(0);
    // 关了：会话与房间都拦，报同一句。
    setBotMode(home, false);
    await expect(runSessionRound(home, session.id, "再说一句", { store, botRunner: runner, ledger: fakeLedger() }))
      .rejects.toThrow(BOT_MODE_OFF_MESSAGE);
    await expect(store.send("room-1", "大家说说")).rejects.toThrow(BOT_MODE_OFF_MESSAGE);
    // 再打开：恢复。
    setBotMode(home, true);
    const ok2 = await runSessionRound(home, session.id, "继续", { store, botRunner: runner, ledger: fakeLedger(), rounds: 1 });
    expect(ok2.turns.length).toBeGreaterThan(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 网关接口 ---
test("MobileCue.test_gateway_mobile_endpoints", async () => {
  const home = tmpHome();
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const owner = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    // /m 页含新标签。
    const page = await fetch(`${base}/m`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-tab="explore"');
    expect(html).toContain('data-tab="profile"');
    expect(html).toContain('id="explore-view"');
    expect(html).toContain('id="profile-view"');
    expect(html).toContain('id="botmode-switch"');
    // 探索页模板。
    const ex = await fetch(`${base}/api/mobile/explore`, { headers: owner });
    expect(ex.status).toBe(200);
    const exJson = await ex.json() as { templates: { id: string }[] };
    expect(exJson.templates.map((t) => t.id)).toEqual(["parcel", "housing", "monitor", "fridge", "save", "ticket"]);
    // 个人页聚合：六个入口 + 邀请 + 开关都在，不编假功能。
    const prof = await fetch(`${base}/api/mobile/profile`, { headers: owner });
    expect(prof.status).toBe(200);
    const p = await prof.json() as Record<string, Record<string, unknown>>;
    expect(p.usage).toBeDefined();
    expect(p.wallet.available).toBe(false);
    expect(p.phone.available).toBe(false);
    expect(p.mail.loop).toBe("blocked");
    expect(Array.isArray(p.apps.mcp)).toBe(true);
    expect(typeof p.skills.count).toBe("number");
    expect(p.computer.cloud).toEqual({ available: false, note: "cloud-not-deployed" });
    expect(p.botMode.enabled).toBe(true);
    expect(p.invites.remaining).toBe(5);
    // Bot Mode 开关往返。
    const off = await fetch(`${base}/api/mobile/bot-mode`, { method: "POST", headers: owner, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect((await off.json() as { enabled: boolean }).enabled).toBe(false);
    const getOff = await fetch(`${base}/api/mobile/bot-mode`, { headers: owner });
    expect((await getOff.json() as { enabled: boolean }).enabled).toBe(false);
    const bad = await fetch(`${base}/api/mobile/bot-mode`, { method: "POST", headers: owner, body: JSON.stringify({ enabled: "yes" }) });
    expect(bad.status).toBe(400);
    await fetch(`${base}/api/mobile/bot-mode`, { method: "POST", headers: owner, body: JSON.stringify({ enabled: true }) });
    // 邀请：发码、列表、吊销、超发 400。
    const created = await fetch(`${base}/api/mobile/invites`, { method: "POST", headers: owner, body: JSON.stringify({ note: "给朋友" }) });
    expect(created.status).toBe(201);
    const createdJson = await created.json() as { invite: { code: string }; remaining: number; cloudReady: boolean };
    expect(createdJson.cloudReady).toBe(false);
    expect(/^[A-HJ-NP-Z2-9]{6}$/.test(createdJson.invite.code)).toBe(true);
    expect(createdJson.remaining).toBe(4);
    const list = await fetch(`${base}/api/mobile/invites`, { headers: owner });
    const listJson = await list.json() as { cloudReady: boolean; invites: { code: string }[] };
    expect(listJson.cloudReady).toBe(false);
    expect(listJson.invites.map((i) => i.code)).toContain(createdJson.invite.code);
    const revoked = await fetch(`${base}/api/mobile/invites/${createdJson.invite.code}/revoke`, { method: "POST", headers: owner, body: "{}" });
    expect(revoked.status).toBe(200);
    const revokedAgain = await fetch(`${base}/api/mobile/invites/${createdJson.invite.code}/revoke`, { method: "POST", headers: owner, body: "{}" });
    expect(revokedAgain.status).toBe(400);
  } finally {
    await gw.stop();
  }
});

test("MobileCue.test_gateway_mobile_profile_honest_when_gmail_unconfigured", async () => {
  const home = tmpHome();
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const prof = await fetch(`${base}/api/mobile/profile`, { headers: { "X-Nyra-Token": gw.token } });
    const p = await prof.json() as { mail: Record<string, unknown> };
    // 全新 home 里 Gmail 没配过：不报“已连接”。
    expect(p.mail.configured).toBe(false);
    expect(p.mail.loop).toBe("blocked");
  } finally {
    await gw.stop();
  }
});
