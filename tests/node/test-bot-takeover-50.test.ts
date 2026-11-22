// tests/node/test-bot-takeover-50.test.ts — 缺口 50 第二批：接管（take the wheel）。
// 钉住的事：
//   - 接管须显式确认（--yes 或交互确认），未确认不接管；休眠的电脑不可接管；
//     同一台电脑不能同时有两场接管；接管只能由机主或信任圈成员发起；
//   - 接管期间 Bot 暂停：该电脑 agent 的 working/queued 任务进 paused，
//     新任务启动被拒、调度 tick 跳过（防双写）；交还后暂停的任务回 queued；
//   - 交还只能由接管那个人或机主做；交还时填的 did / resumeFrom 先打码
//     再记，原文不进账本、不进事件；
//   - 接管是审计事件：接管账本 + 电脑活动账本 + 运行事件（bot_takeover_*）
//     + 时间线渲染，字段齐全；CLI 端到端。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { defaultSoul, saveSoul } from "../../src/soul.ts";
import { createComputer, readComputerActivity, sleepComputer } from "../../src/bot/computer.ts";
import { inviteToCircle, saveCircleBook, type CircleBook } from "../../src/circles.ts";
import { saveFriendBook } from "../../src/peerCard.ts";
import { createKanbanTask, getKanbanTask, kanbanTick, resumeKanbanTask, startKanbanTask } from "../../src/kanban.ts";
import { buildTimeline } from "../../src/timeline.ts";
import { screenStatus } from "../../src/botScreen.ts";
import { expectPerms } from "./fsPerms.ts";
import {
  getActiveTakeover,
  loadTakeoverLedger,
  takeoverLedgerPath,
} from "../../src/takeoverLedger.ts";
import {
  TakeoverError,
  checkTakeoverActor,
  handleScreenTakeover,
  handoverComputer,
  takeoverComputer,
  takeoverStatus,
} from "../../src/botTakeover.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
}

function now(): string {
  return new Date().toISOString();
}

/** 信任圈成员 seeding（test-circles-34.test.ts 同款：直接写好友账本 + 圈账本；一次可种多人）。 */
function seedAdmission(home: string, names: string | string[], circle = "work"): void {
  const list = Array.isArray(names) ? names : [names];
  saveFriendBook(home, {
    version: 1,
    friends: list.map((name) => ({
      name,
      url: "http://127.0.0.1:9/mcp",
      card_hash: "seed",
      circle: "default",
      tier: "readonly",
      outbound: "accepted",
      inbound: "accepted",
      blocked: false,
      code_hash: null,
      created_at: now(),
      updated_at: now(),
    })),
    circles: [{ name: "default", created_at: now() }],
  });
  const book: CircleBook = {
    version: 1,
    circles: [{ name: circle, description: "", created_at: now(), created_by: "owner", members: [] }],
    bindings: [],
  };
  saveCircleBook(home, book);
  for (const name of list) inviteToCircle(home, { circle, identity: name });
}

function setupComputer(home: string): { id: string } {
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  return { id: c.id };
}

function readEvents(home: string, runId: string): Record<string, unknown>[] {
  const p = join(home, "runs", runId, "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => { out += String(chunk); return true; };
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => { err += String(chunk); return true; };
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origOut;
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }
}

test("BotTakeoverTest.test_ledger_roundtrip_and_perms", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const record = takeoverComputer(home, id, "owner", { reason: "登录墙", confirm: true });
  expect(record.status).toBe("active");
  expect(record.takenBy).toBe("owner");
  expect(record.reason).toBe("登录墙");
  expect(record.pausedTaskIds).toEqual([]);
  expectPerms(takeoverLedgerPath(home), 0o600);
  const ledger = loadTakeoverLedger(home);
  expect(ledger.takeovers.length).toBe(1);
  expect(ledger.takeovers[0].id).toBe(record.id);
  const result = handoverComputer(home, id, "owner", { did: "过了登录墙", resumeFrom: "第 3 步" });
  expect(result.record.status).toBe("handed_back");
  expect(result.record.did).toBe("过了登录墙");
  expect(result.record.resumeFrom).toBe("第 3 步");
  expect(getActiveTakeover(home, id)).toBeNull();
});

test("BotTakeoverTest.test_ledger_corrupt_backed_up", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  takeoverComputer(home, id, "owner", { confirm: true });
  writeFileSync(takeoverLedgerPath(home), "{not json", "utf-8");
  expect(() => loadTakeoverLedger(home)).toThrow("已损坏");
  expect(existsSync(takeoverLedgerPath(home))).toBe(false);
});

test("BotTakeoverTest.test_takeover_requires_confirm", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  expect(() => takeoverComputer(home, id, "owner", { confirm: false })).toThrow(TakeoverError);
  expect(getActiveTakeover(home, id)).toBeNull();
});

test("BotTakeoverTest.test_takeover_sleeping_refused", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  sleepComputer(home, id, "测试休眠");
  expect(() => takeoverComputer(home, id, "owner", { confirm: true })).toThrow("休眠");
});

test("BotTakeoverTest.test_takeover_stranger_refused_friend_allowed", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  expect(checkTakeoverActor(home, "stranger").allowed).toBe(false);
  expect(() => takeoverComputer(home, id, "stranger", { confirm: true })).toThrow("不在信任圈里");
  seedAdmission(home, "teammate");
  const record = takeoverComputer(home, id, "teammate", { confirm: true });
  expect(record.takenBy).toBe("teammate");
  expect(record.reason).toBe("未说明原因");
});

test("BotTakeoverTest.test_takeover_twice_refused", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  takeoverComputer(home, id, "owner", { reason: "2FA", confirm: true });
  expect(() => takeoverComputer(home, id, "owner", { confirm: true })).toThrow("已经被");
});

test("BotTakeoverTest.test_takeover_pauses_tasks_and_blocks_start", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const working = createKanbanTask(home, { title: "正在做的活", agent: "nyra" });
  startKanbanTask(home, working.id);
  const queued = createKanbanTask(home, { title: "排队的活", agent: "nyra" });
  const record = takeoverComputer(home, id, "owner", { reason: "登录墙", confirm: true });
  expect(record.pausedTaskIds).toContain(working.id);
  expect(record.pausedTaskIds).toContain(queued.id);
  expect(getKanbanTask(home, working.id).status).toBe("paused");
  expect(getKanbanTask(home, queued.id).status).toBe("paused");
  // 接管期间新任务禁启动。
  const fresh = createKanbanTask(home, { title: "新来的活", agent: "nyra" });
  expect(() => startKanbanTask(home, fresh.id)).toThrow("接管中");
  // 调度 tick 跳过，不 claim 也不进 fail 路径。
  const tick = kanbanTick(home, { dispatch: () => "run-x" });
  expect(tick.claimed).toBe(0);
  expect(tick.skipped).toContain("接管中");
  expect(getKanbanTask(home, fresh.id).status).toBe("queued");
  expect(getKanbanTask(home, fresh.id).attempts).toBe(0);
});

test("BotTakeoverTest.test_handover_resumes_tasks", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const working = createKanbanTask(home, { title: "正在做的活", agent: "nyra" });
  startKanbanTask(home, working.id);
  takeoverComputer(home, id, "owner", { confirm: true });
  const result = handoverComputer(home, id, "owner", { did: "输了验证码", resumeFrom: "继续填表" });
  expect(result.resumedTaskIds).toContain(working.id);
  expect(getKanbanTask(home, working.id).status).toBe("queued");
  // 交还后能正常启动。
  const started = startKanbanTask(home, working.id);
  expect(started.status).toBe("working");
});

test("BotTakeoverTest.test_handover_only_taker_or_owner", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  seedAdmission(home, ["teammate", "teammate2"]);
  takeoverComputer(home, id, "teammate", { confirm: true });
  expect(() => handoverComputer(home, id, "teammate2", {})).toThrow("只有他本人或机主能交还");
  // 机主能替人交还。
  const result = handoverComputer(home, id, "owner", {});
  expect(result.record.handedBackBy).toBe("owner");
});

test("BotTakeoverTest.test_handover_without_takeover_refused", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  expect(() => handoverComputer(home, id, "owner", {})).toThrow("没人接管");
});

test("BotTakeoverTest.test_handover_redacts_did", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  takeoverComputer(home, id, "owner", { confirm: true, runId: run.run_id });
  const result = handoverComputer(home, id, "owner", {
    did: "输了密码：hunter2，卡号 4111222233334444 已付",
    resumeFrom: "验证码 123456 已填",
    runId: run.run_id,
  });
  expect(result.redacted).toEqual(["password", "verification_code", "payment"]);
  expect(result.record.did).not.toContain("hunter2");
  expect(result.record.did).not.toContain("4111222233334444");
  expect(result.record.resumeFrom).not.toContain("123456");
  const ledgerText = readFileSync(takeoverLedgerPath(home), "utf-8");
  expect(ledgerText).not.toContain("hunter2");
  expect(ledgerText).not.toContain("4111222233334444");
  expect(ledgerText).not.toContain("123456");
  const events = readEvents(home, run.run_id);
  expect(JSON.stringify(events)).not.toContain("hunter2");
  expect(JSON.stringify(events)).not.toContain("4111222233334444");
  const ended = events.find((e) => e.type === "bot_takeover_ended");
  expect(ended).toBeDefined();
  expect(ended?.handed_back_by).toBe("owner");
});

test("BotTakeoverTest.test_events_mirrored_and_timeline", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  const record = takeoverComputer(home, id, "owner", { reason: "登录墙", confirm: true, runId: run.run_id });
  handoverComputer(home, id, "owner", { did: "过了墙", resumeFrom: "第 2 步", runId: run.run_id });
  const events = readEvents(home, run.run_id);
  const started = events.find((e) => e.type === "bot_takeover_started");
  expect(started).toBeDefined();
  expect(started?.takeover_id).toBe(record.id);
  expect(started?.taken_by).toBe("owner");
  expect(started?.paused_count).toBe(0);
  const ended = events.find((e) => e.type === "bot_takeover_ended");
  expect(ended).toBeDefined();
  expect(ended?.did).toBe("过了墙");
  const tl = buildTimeline(store, run.run_id);
  expect(tl.steps.some((s) => s.title.includes("接管开始"))).toBe(true);
  expect(tl.steps.some((s) => s.title.includes("接管结束"))).toBe(true);
  // 电脑活动账本也记了接管与交还。
  const activities = readComputerActivity(home, id, 10);
  expect(activities.some((a) => a.action === "screen.takeover")).toBe(true);
  expect(activities.some((a) => a.action === "screen.handover")).toBe(true);
});

test("BotTakeoverTest.test_screen_status_shows_active_takeover", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  expect(screenStatus(home, id, "owner").takeover).toBeNull();
  const record = takeoverComputer(home, id, "owner", { confirm: true });
  expect(screenStatus(home, id, "owner").takeover).toBe(record.id);
  const view = takeoverStatus(home, id, "owner");
  expect(view.active?.id).toBe(record.id);
  expect(view.lastHandedBack).toBeNull();
  handoverComputer(home, id, "owner", {});
  expect(screenStatus(home, id, "owner").takeover).toBeNull();
  expect(takeoverStatus(home, id, "owner").lastHandedBack?.id).toBe(record.id);
});

test("BotTakeoverTest.test_cli_takeover_handover", async () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const working = createKanbanTask(home, { title: "正在做的活", agent: "nyra" });
  startKanbanTask(home, working.id);
  // 没加 --yes、stdin 不是 TTY：拒绝接管。
  const noYes = await capture(() => handleScreenTakeover(["takeover", id], home));
  expect(noYes.code).toBe(1);
  expect(noYes.err).toContain("--yes");
  expect(getActiveTakeover(home, id)).toBeNull();
  // 加 --yes：接管成功，任务暂停。
  const took = await capture(() => handleScreenTakeover(["takeover", id, "--reason", "登录墙", "--yes"], home));
  expect(took.code).toBe(0);
  expect(took.out).toContain("已接管");
  expect(took.out).toContain("Bot 已暂停");
  expect(getKanbanTask(home, working.id).status).toBe("paused");
  // 再接管一次：拒绝。
  const twice = await capture(() => handleScreenTakeover(["takeover", id, "--yes"], home));
  expect(twice.code).toBe(1);
  expect(twice.err).toContain("已经被");
  // 交还：任务回队列。
  const back = await capture(() => handleScreenTakeover(["handover", id, "--did", "过了登录墙", "--resume-from", "继续填表"], home));
  expect(back.code).toBe(0);
  expect(back.out).toContain("已交还");
  expect(back.out).toContain("过了登录墙");
  expect(getKanbanTask(home, working.id).status).toBe("queued");
  // 没接管时再交还：拒绝。
  const empty = await capture(() => handleScreenTakeover(["handover", id], home));
  expect(empty.code).toBe(1);
  expect(empty.err).toContain("没人接管");
});

test("BotTakeoverTest.test_cli_stranger_refused_and_help", async () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const denied = await capture(() => handleScreenTakeover(["takeover", id, "--as", "stranger", "--yes"], home));
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("不在信任圈里");
  const help = await capture(() => handleScreenTakeover(["--help"], home));
  expect(help.code).toBe(0);
  expect(help.out).toContain("nyra screen");
  expect(help.out).toContain("takeover");
});

test("BotTakeoverTest.test_handover_resume_skips_manually_resumed", () => {
  const home = tmpHome("nyra-takeover-");
  const { id } = setupComputer(home);
  const working = createKanbanTask(home, { title: "正在做的活", agent: "nyra" });
  startKanbanTask(home, working.id);
  takeoverComputer(home, id, "owner", { confirm: true });
  // 中途有人手动把任务恢复回队列（绕过交还），交还时不再动它。
  resumeKanbanTask(home, working.id);
  const result = handoverComputer(home, id, "owner", {});
  expect(result.resumedTaskIds).not.toContain(working.id);
  expect(getKanbanTask(home, working.id).status).toBe("queued");
});
