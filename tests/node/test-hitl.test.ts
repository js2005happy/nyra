// tests/node/test-hitl.test.ts — G-P1-32 对话转人工坐席。
// 钉住的事：
//   - 账本默认空；保存 0600；损坏先备份再回空账本；
//   - 状态机：pending → active → handed_back，pending 也能 cancel，非法流转报错；
//   - 同一会话已有进行中的单时拒绝新单；
//   - 指定接手人时只认该身份或机主；handback 只认接手人或机主；cancel 只认发起人或机主；
//   - 静默门：pending/active 时 bot 不回，接回/取消后恢复；账本损坏时也不回（fail-closed）；
//   - CLI：start 须 --yes，全程 start/takeover/handback/status/list；
//   - 网关 send 静默门：转人工期间不建 agent、不调模型，记 hitl_bot_held 事件与收件箱；
//   - 新运行事件已注册。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  HitlError,
  startHandoff, takeoverHandoff, handbackHandoff, cancelHandoff,
  getHandoff, listHandoffs, activeHandoffForSession, isBotMutedForSession,
  loadHitlLedger, HITL_LEDGER_NAME,
} from "../../src/hitl.ts";
import { RunStore } from "../../src/runs.ts";
import { Gateway } from "../../src/gateway.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, workdir: string, args: string[]) {
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls: Record<string, unknown>[][] = [];
  constructor(private script: Record<string, unknown>[]) {}
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    return this.script[0];
  }
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

test("HitlTest.test_start_creates_pending_handoff_0600", () => {
  const home = tmpHome("nyra-hitl-");
  const h = startHandoff(home, { sessionId: "sess-1", by: "owner@example.com", reason: "用户要找真人" });
  expect(h.id.startsWith("hitl_")).toBe(true);
  expect(h.status).toBe("pending");
  expect(h.reason).toBe("用户要找真人");
  expectPerms(join(home, HITL_LEDGER_NAME), 0o600);
  expect(loadHitlLedger(home)).toHaveLength(1);
});

test("HitlTest.test_start_validation", () => {
  const home = tmpHome("nyra-hitl-");
  expect(() => startHandoff(home, { sessionId: "  ", by: "a@b.c" })).toThrow(HitlError);
  expect(() => startHandoff(home, { sessionId: "s", by: "  " })).toThrow(HitlError);
  expect(() => startHandoff(home, { sessionId: "s", by: "a@b.c", reason: "x".repeat(501) })).toThrow(HitlError);
  expect(loadHitlLedger(home)).toHaveLength(0);
});

test("HitlTest.test_second_start_same_session_rejected", () => {
  const home = tmpHome("nyra-hitl-");
  startHandoff(home, { sessionId: "sess-1", by: "a@b.c" });
  expect(() => startHandoff(home, { sessionId: "sess-1", by: "a@b.c" })).toThrow(HitlError);
  startHandoff(home, { sessionId: "sess-2", by: "a@b.c" });
  expect(loadHitlLedger(home)).toHaveLength(2);
});

test("HitlTest.test_takeover_and_handback_flow", () => {
  const home = tmpHome("nyra-hitl-");
  const h = startHandoff(home, { sessionId: "sess-1", by: "a@b.c" });
  expect(() => handbackHandoff(home, h.id, "a@b.c")).toThrow(HitlError);
  const taken = takeoverHandoff(home, h.id, "human@example.com");
  expect(taken.status).toBe("active");
  expect(taken.takenBy).toBe("human@example.com");
  expect(() => takeoverHandoff(home, h.id, "other@example.com")).toThrow(HitlError);
  expect(() => handbackHandoff(home, h.id, "other@example.com")).toThrow(HitlError);
  const back = handbackHandoff(home, h.id, "human@example.com");
  expect(back.status).toBe("handed_back");
  expect(back.handedBackBy).toBe("human@example.com");
  expect(() => handbackHandoff(home, h.id, "human@example.com")).toThrow(HitlError);
});

test("HitlTest.test_takeover_assignee_only_or_owner", () => {
  const home = tmpHome("nyra-hitl-");
  const h = startHandoff(home, { sessionId: "sess-1", by: "a@b.c", assignee: "named@example.com" });
  expect(() => takeoverHandoff(home, h.id, "someone@example.com", false)).toThrow(HitlError);
  const byOwner = takeoverHandoff(home, h.id, "owner@example.com", true);
  expect(byOwner.status).toBe("active");
});

test("HitlTest.test_cancel_only_pending_and_only_requester_or_owner", () => {
  const home = tmpHome("nyra-hitl-");
  const h = startHandoff(home, { sessionId: "sess-1", by: "a@b.c" });
  expect(() => cancelHandoff(home, h.id, "someone@example.com", false)).toThrow(HitlError);
  const cancelled = cancelHandoff(home, h.id, "a@b.c");
  expect(cancelled.status).toBe("cancelled");
  const h2 = startHandoff(home, { sessionId: "sess-1", by: "a@b.c" });
  takeoverHandoff(home, h2.id, "human@example.com");
  expect(() => cancelHandoff(home, h2.id, "a@b.c")).toThrow(HitlError);
});

test("HitlTest.test_get_unknown_handoff_throws", () => {
  const home = tmpHome("nyra-hitl-");
  expect(() => getHandoff(home, "hitl_000000000000")).toThrow(HitlError);
});

test("HitlTest.test_mute_follows_handoff_lifecycle", () => {
  const home = tmpHome("nyra-hitl-");
  expect(isBotMutedForSession(home, "sess-1")).toBe(false);
  const h = startHandoff(home, { sessionId: "sess-1", by: "a@b.c" });
  expect(isBotMutedForSession(home, "sess-1")).toBe(true);
  expect(isBotMutedForSession(home, "sess-2")).toBe(false);
  takeoverHandoff(home, h.id, "human@example.com");
  expect(isBotMutedForSession(home, "sess-1")).toBe(true);
  handbackHandoff(home, h.id, "human@example.com");
  expect(isBotMutedForSession(home, "sess-1")).toBe(false);
  expect(activeHandoffForSession(home, "sess-1")).toBeNull();
});

test("HitlTest.test_corrupt_ledger_mutes_fail_closed", () => {
  const home = tmpHome("nyra-hitl-");
  writeFileSync(join(home, HITL_LEDGER_NAME), "{not json", "utf-8");
  expect(isBotMutedForSession(home, "sess-1")).toBe(true);
  expect(readdirSync(home).some((f) => f.startsWith(`${HITL_LEDGER_NAME}.bak-`))).toBe(true);
  expect(loadHitlLedger(home)).toHaveLength(0);
});

test("HitlTest.test_list_newest_first_and_status_filter", () => {
  const home = tmpHome("nyra-hitl-");
  const a = startHandoff(home, { sessionId: "s-a", by: "a@b.c" });
  const b = startHandoff(home, { sessionId: "s-b", by: "a@b.c" });
  takeoverHandoff(home, b.id, "human@example.com");
  const all = listHandoffs(home);
  expect(all[0].id).toBe(b.id);
  expect(listHandoffs(home, "pending").map((h) => h.id)).toEqual([a.id]);
  expect(listHandoffs(home, "active").map((h) => h.id)).toEqual([b.id]);
  expect(listHandoffs(home, "handed_back")).toHaveLength(0);
});

test("HitlTest.test_cli_start_requires_yes", () => {
  const home = tmpHome("nyra-hitl-");
  const workdir = tmpHome("nyra-hitl-wd-");
  const r = runCli(home, workdir, ["hitl", "start", "sess-1"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--yes");
  expect(loadHitlLedger(home)).toHaveLength(0);
});

test("HitlTest.test_cli_full_flow", () => {
  const home = tmpHome("nyra-hitl-");
  const workdir = tmpHome("nyra-hitl-wd-");
  const start = runCli(home, workdir, ["hitl", "start", "sess-1", "--yes", "--reason", "用户要找真人"]);
  expect(start.status).toBe(0);
  expect(start.stdout).toContain("已转人工");
  const handoffs = loadHitlLedger(home);
  expect(handoffs).toHaveLength(1);
  const id = handoffs[0].id;
  const dup = runCli(home, workdir, ["hitl", "start", "sess-1", "--yes"]);
  expect(dup.status).toBe(1);
  const status = runCli(home, workdir, ["hitl", "status", "sess-1"]);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain(id);
  expect(status.stdout).toContain("待接手");
  const take = runCli(home, workdir, ["hitl", "takeover", id]);
  expect(take.status).toBe(0);
  expect(take.stdout).toContain("已接手");
  const back = runCli(home, workdir, ["hitl", "handback", id]);
  expect(back.status).toBe(0);
  expect(back.stdout).toContain("已接回 bot");
  expect(isBotMutedForSession(home, "sess-1")).toBe(false);
  const list = runCli(home, workdir, ["hitl", "list", "--status", "handed_back"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain(id);
  const bad = runCli(home, workdir, ["hitl", "takeover", "hitl_000000000000"]);
  expect(bad.status).toBe(1);
});

test("HitlTest.test_cli_status_empty_and_unknown", () => {
  const home = tmpHome("nyra-hitl-");
  const workdir = tmpHome("nyra-hitl-wd-");
  const r = runCli(home, workdir, ["hitl", "status", "no-such-session"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("没有进行中的转人工单");
  const bad = runCli(home, workdir, ["hitl", "bogus"]);
  expect(bad.status).toBe(2);
});

test("HitlTest.test_gateway_send_held_while_handed_off", async () => {
  const home = tmpHome("nyra-hitl-");
  const workdir = tmpHome("nyra-hitl-wd-");
  const provider = new FakeProvider([textReply("bot 答复")]);
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, config: { mcp_enabled: false }, providerFactory: () => provider as never });
  startHandoff(home, { sessionId: "sess-1", by: "a@b.c" });
  const held = gw.send("sess-1", "你好");
  expect(held.status).toBe("done");
  expect(provider.calls).toHaveLength(0);
  expect(held.events.some((e) => (e as Record<string, unknown>).type === "hitl_bot_held")).toBe(true);
  const inbox = readFileSync(join(home, "inbox.jsonl"), "utf-8");
  expect(inbox).toContain("hitl-held");
  // 接回后恢复：同一会话再发消息，模型真被调用。
  const handoffs = loadHitlLedger(home);
  takeoverHandoff(home, handoffs[0].id, "human@example.com");
  handbackHandoff(home, handoffs[0].id, "human@example.com");
  const run = gw.send("sess-1", "你好");
  const deadline = Date.now() + 15000;
  while (run.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(run.status).toBe("done");
  expect(provider.calls.length).toBeGreaterThan(0);
});

test("HitlTest.test_gateway_send_unmuted_runs_normally", async () => {
  const home = tmpHome("nyra-hitl-");
  const workdir = tmpHome("nyra-hitl-wd-");
  const provider = new FakeProvider([textReply("bot 答复")]);
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, config: { mcp_enabled: false }, providerFactory: () => provider as never });
  const run = gw.send("sess-9", "你好");
  const deadline = Date.now() + 15000;
  while (run.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(run.status).toBe("done");
  expect(provider.calls.length).toBeGreaterThan(0);
});

test("HitlTest.test_hitl_events_registered", () => {
  const home = tmpHome("nyra-hitl-");
  const store = new RunStore(join(home, "runs"));
  const run = store.create("t", "sess-1", tmpdir(), "full", 5);
  for (const type of ["hitl_started", "hitl_takeover", "hitl_handback", "hitl_cancelled", "hitl_bot_held"]) {
    store.appendEvent(run.run_id, type, { handoff: "hitl_0123456789ab", session: "sess-1", by: "a@b.c" });
  }
  expect(() => store.appendEvent(run.run_id, "no_such_event_xyz", {})).toThrow("运行事件无效");
});
