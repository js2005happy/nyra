// tests/node/test-bot-screen-50.test.ts — 缺口 50 第一批：只读看屏 + 活动列表。
// 钉住的事：
//   - 打码是确定性规则（卡号 / 密码 / 验证码），打码后原文不留存；
//   - 帧指纹是 SHA-256 前 12 位（确定性、可复现），只记指纹与收件人；
//   - 看屏只对机主与信任圈成员可见，圈外拒绝；休眠的电脑没有实时画面；
//   - 活动列表与时间线同源（正在做取活动账本、下一步取运行时间线阶段），
//     没有关联运行时下一步明说看不到、不编；
//   - 运行事件已注册（bot_screen_watched / bot_screen_redacted），打码事件
//     只记种类；CLI 端到端。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { defaultSoul, saveSoul } from "../../src/soul.ts";
import { createComputer, readComputerActivity, recordBrowserVisit, recordComputerActivity, sleepComputer } from "../../src/bot/computer.ts";
import { inviteToCircle, saveCircleBook, type CircleBook } from "../../src/circles.ts";
import { saveFriendBook } from "../../src/peerCard.ts";
import {
  SCREEN_FRAME_HASH_RE,
  ScreenError,
  describeScreen,
  frameHashFor,
  handleScreen,
  listScreenActivity,
  redactScreenText,
  screenStatus,
  watchScreen,
} from "../../src/botScreen.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
}

function now(): string {
  return new Date().toISOString();
}

/** 信任圈成员 seeding（test-circles-34.test.ts 同款：直接写好友账本 + 圈账本）。 */
function seedAdmission(home: string, name: string, circle = "work"): void {
  saveFriendBook(home, {
    version: 1,
    friends: [{
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
    }],
    circles: [{ name: "default", created_at: now() }],
  });
  const book: CircleBook = {
    version: 1,
    circles: [{ name: circle, description: "", created_at: now(), created_by: "owner", members: [] }],
    bindings: [],
  };
  saveCircleBook(home, book);
  inviteToCircle(home, { circle, identity: name });
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

test("BotScreenTest.test_redact_card_number", () => {
  const { text, redacted } = redactScreenText("付款页显示卡号 4111 1111 1111 1111，请确认。");
  expect(redacted).toEqual(["payment"]);
  expect(text).toContain("[卡号已打码]");
  expect(text).not.toContain("4111");
});

test("BotScreenTest.test_redact_password_and_code", () => {
  const { text, redacted } = redactScreenText("登录框 password: s3cret-pass，验证码 483920 请填写。");
  expect(redacted).toEqual(["password", "verification_code"]);
  expect(text).toContain("password：[已打码]");
  expect(text).toContain("验证码：[验证码已打码]");
  expect(text).not.toContain("s3cret-pass");
  expect(text).not.toContain("483920");
});

test("BotScreenTest.test_redact_clean_text_untouched", () => {
  const { text, redacted } = redactScreenText("正在看 example.com，最近在做 browser.open。");
  expect(redacted).toEqual([]);
  expect(text).toBe("正在看 example.com，最近在做 browser.open。");
});

test("BotScreenTest.test_frame_hash_deterministic", () => {
  const a = frameHashFor("cmp_0123456789ab", "2026-11-22T00:00:00.000Z", "example.com", "browser.open");
  const b = frameHashFor("cmp_0123456789ab", "2026-11-22T00:00:00.000Z", "example.com", "browser.open");
  const c = frameHashFor("cmp_0123456789ab", "2026-11-22T00:00:00.000Z", "example.com", "shell.run");
  expect(a).toBe(b);
  expect(SCREEN_FRAME_HASH_RE.test(a)).toBe(true);
  expect(a).not.toBe(c);
});

test("BotScreenTest.test_watch_owner_live_frame", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  recordBrowserVisit(home, id, "https://example.com/some/page?x=1");
  const frame = watchScreen(home, id, "owner", { at: "2026-11-22T00:00:00.000Z" });
  expect(frame.live).toBe(true);
  expect(frame.host).toBe("example.com");
  expect(frame.frameHash).toBe(frameHashFor(id, "2026-11-22T00:00:00.000Z", "example.com", "browser.open"));
  expect(frame.recipients).toEqual(["owner"]);
  expect(frame.description).toContain("example.com");
  expect(frame.redacted).toEqual([]);
  const activities = readComputerActivity(home, id, 5);
  expect(activities[activities.length - 1].action).toBe("screen.watch");
});

test("BotScreenTest.test_watch_sleeping_has_no_frame", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  sleepComputer(home, id, "测试休眠");
  const frame = watchScreen(home, id, "owner");
  expect(frame.live).toBe(false);
  expect(frame.frameHash).toBeNull();
  expect(frame.description).toContain("休眠");
});

test("BotScreenTest.test_watch_stranger_denied_friend_allowed", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  expect(() => watchScreen(home, id, "stranger")).toThrow(ScreenError);
  expect(() => watchScreen(home, id, "stranger")).toThrow("不在信任圈里");
  seedAdmission(home, "teammate");
  const frame = watchScreen(home, id, "teammate");
  expect(frame.live).toBe(true);
  expect(frame.recipients).toEqual(["teammate"]);
});

test("BotScreenTest.test_watch_redacts_and_mirrors_events", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  const frame = watchScreen(home, id, "owner", {
    runId: run.run_id,
    screenText: "支付页：卡号 4111222233334444，密码：hunter2。",
    at: "2026-11-22T00:00:00.000Z",
  });
  expect(frame.redacted).toEqual(["password", "payment"]);
  expect(frame.description).not.toContain("4111222233334444");
  expect(frame.description).not.toContain("hunter2");
  const events = readEvents(home, run.run_id);
  const watched = events.find((e) => e.type === "bot_screen_watched");
  expect(watched).toBeDefined();
  expect(watched?.frame_hash).toBe(frame.frameHash);
  const redacted = events.find((e) => e.type === "bot_screen_redacted");
  expect(redacted).toBeDefined();
  expect(redacted?.kinds).toBe("password,payment");
  expect(JSON.stringify(events)).not.toContain("4111222233334444");
  expect(JSON.stringify(events)).not.toContain("hunter2");
});

test("BotScreenTest.test_activity_current_and_next_none_without_run", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  recordBrowserVisit(home, id, "https://example.com/");
  const activity = listScreenActivity(home, id, "owner");
  expect(activity.current?.action).toBe("browser.open");
  expect(activity.next).toBeNull();
  expect(activity.nextSource).toBe("none");
  expect(activity.runId).toBeNull();
});

test("BotScreenTest.test_activity_next_from_timeline", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  recordComputerActivity(home, { computerId: id, kind: "shell", action: "shell.run", target: "echo hi", runId: run.run_id, ok: true });
  const activity = listScreenActivity(home, id, "owner", { runId: run.run_id });
  expect(activity.nextSource).toBe("timeline");
  expect(activity.next).toBe("进行中");
  expect(activity.stage).toContain("进行中");
  expect(activity.runId).toBe(run.run_id);
});

test("BotScreenTest.test_activity_next_from_latest_activity_run", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  recordComputerActivity(home, { computerId: id, kind: "shell", action: "shell.run", target: "echo hi", runId: run.run_id, ok: true });
  const activity = listScreenActivity(home, id, "owner");
  expect(activity.nextSource).toBe("timeline");
  expect(activity.next).toBe("进行中");
});

test("BotScreenTest.test_activity_next_survives_watch_without_run", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  recordComputerActivity(home, { computerId: id, kind: "shell", action: "shell.run", target: "echo hi", runId: run.run_id, ok: true });
  watchScreen(home, id, "owner");
  const activity = listScreenActivity(home, id, "owner");
  expect(activity.current?.action).toBe("screen.watch");
  expect(activity.nextSource).toBe("timeline");
  expect(activity.next).toBe("进行中");
});

test("BotScreenTest.test_describe_screen_sleeping_and_empty", () => {
  const sleeping = describeScreen({ state: "sleeping" } as never, null, null);
  expect(sleeping).toContain("休眠");
  const empty = describeScreen({ state: "active" } as never, null, null);
  expect(empty).toContain("还没打开过页面");
});

test("BotScreenTest.test_status_takeover_is_second_batch", () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  const status = screenStatus(home, id, "owner");
  expect(status.takeover).toBe("second-batch");
  expect(status.viewers).toContain("信任圈");
  expect(() => screenStatus(home, id, "stranger")).toThrow(ScreenError);
});

test("BotScreenTest.test_cli_watch_activity_status", async () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  recordBrowserVisit(home, id, "https://example.com/");
  const watch = await capture(() => handleScreen(["watch", id], home));
  expect(watch.code).toBe(0);
  expect(watch.out).toContain("实时画面");
  expect(watch.out).toContain("帧指纹");
  expect(watch.out).toContain("example.com");
  const activity = await capture(() => handleScreen(["activity", id], home));
  expect(activity.code).toBe(0);
  expect(activity.out).toContain("正在做");
  expect(activity.out).toContain("下一步：看不到");
  const status = await capture(() => handleScreen(["status", id], home));
  expect(status.code).toBe(0);
  expect(status.out).toContain("第二批");
});

test("BotScreenTest.test_cli_denied_and_unknown", async () => {
  const home = tmpHome("nyra-screen-");
  const { id } = setupComputer(home);
  const denied = await capture(() => handleScreen(["watch", id, "--as", "stranger"], home));
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("不在信任圈里");
  const unknown = await capture(() => handleScreen(["watch", "cmp_0123456789ab"], home));
  expect(unknown.code).toBe(1);
  const help = await capture(() => handleScreen(["--help"], home));
  expect(help.code).toBe(0);
  expect(help.out).toContain("nyra screen");
});
