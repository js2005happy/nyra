// tests/node/test-sessions-39.test.ts — 缺口 39：跨 agent 联合会话。
// 全部用临时 home 与假对端，不连真实渠道、不拨真实电话、不花真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  SESSION_MAX_FRAMES,
  acceptDelegation,
  checkSessionAdmission,
  completeDelegation,
  consentRecording,
  createSession,
  delegateInSession,
  endSession,
  fanoutFrame,
  findSession,
  handleSession,
  joinSession,
  leaveSession,
  listSessions,
  loadSessionBook,
  recordingAllowed,
  saveSessionBook,
  shareInSession,
  SessionError,
} from "../../src/session.ts";
import { loadCircleBook, saveCircleBook, type CircleBook } from "../../src/circles.ts";
import { loadFriendBook, saveFriendBook, type FriendBook } from "../../src/peerCard.ts";
import { PEER_AUDIT_FILE } from "../../src/peer.ts";
import { RunStore } from "../../src/runs.ts";
import { getContract } from "../../src/contract.ts";
import { saveConfig } from "../../src/config.ts";

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

/** 直接写信任圈账本给好友准入（不走带审计的 invite）。 */
function seedAdmission(home: string, name: string, circle = "work"): void {
  seedFriend(home, name);
  let circleBook: CircleBook;
  try {
    circleBook = loadCircleBook(home);
  } catch {
    circleBook = { version: 1, circles: [], bindings: [] };
  }
  const member = { identity: name, kind: "friend" as const, invited_by: "owner", invited_at: now(), channel: "test" };
  const idx = circleBook.circles.findIndex((c) => c.name === circle);
  if (idx >= 0) circleBook.circles[idx].members.push(member);
  else circleBook.circles.push({ name: circle, description: "", created_at: now(), created_by: "owner", members: [member] });
  saveCircleBook(home, circleBook);
}

function seedPeerConfig(home: string, peerName: string, enabled = true): void {
  saveConfig(home, {
    peers: { enabled, list: [{ name: peerName, url: "http://127.0.0.1:9/mcp" }] },
    reviewer: { enabled: true },
  });
}

const allowRunner = {
  async chat(): Promise<Record<string, unknown>> {
    return { choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "测试放行" }) } }] };
  },
};

const denyRunner = {
  async chat(): Promise<Record<string, unknown>> {
    return { choices: [{ message: { content: JSON.stringify({ decision: "deny", reason: "测试拦截" }) } }] };
  },
};

/** 假对端传输：只认 dispatch_task，回一个带 run_id 的入队答复。 */
function fakeClientFactory() {
  return {
    async callTool(name: string, _args: Record<string, unknown>): Promise<string> {
      if (name === "dispatch_task") return "任务已入队：run_id 20261122-120000-abcdef（模式 readonly，状态 queued）";
      throw new Error(`未知工具：${name}`);
    },
    stop(): void { /* ignore */ },
  };
}

function readAllRunEvents(home: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const base = join(home, "runs");
  if (!existsSync(base)) return out;
  for (const runId of readdirSync(base)) {
    const p = join(base, runId, "events.jsonl");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch { /* ignore */ }
    }
  }
  return out;
}

function readAudit(home: string): Record<string, unknown>[] {
  const p = join(home, PEER_AUDIT_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function seedRun(home: string): string {
  const store = new RunStore(join(home, "runs"));
  const state = store.create("测试任务：整理一份周报", "sess-39", join(home, "work"), "auto", 5, "completed_unverified");
  store.appendEvent(state.run_id, "tool_result", { id: "t1", name: "read_file", ok: true, args_hash: "aaa" });
  store.appendEvent(state.run_id, "verifier_verdict", { target: "t1", verdict: "verified", reason: "检查全过", verifier_model: "fake", source: "test", checks_passed: 1, checks_failed: 0 });
  return state.run_id;
}

test("Sessions39Test.test_create_session", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会：跟进 affiliate 项目");
    expect(session.status).toBe("active");
    expect(session.id).toMatch(/^ses-[0-9a-f]{8}$/);
    expect(session.members.map((m) => m.identity)).toEqual(["owner", "self"]);
    expectPerms(join(home, "sessions.json"), 0o600);
    const events = readAllRunEvents(home);
    expect(events.some((e) => e.type === "session_created" && e.session === session.id)).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_create_session_empty_title", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    expect(() => createSession(home, "   ")).toThrow("标题不能为空");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_join_admission_gates", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    expect(() => joinSession(home, session.id, "stranger")).toThrow("好友账本里没有");
    seedFriend(home, "blocked-one", { blocked: true });
    expect(() => joinSession(home, session.id, "blocked-one")).toThrow("已拉黑");
    seedFriend(home, "pending-one", { inbound: "pending" });
    expect(() => joinSession(home, session.id, "pending-one")).toThrow("还不是好友");
    seedFriend(home, "no-circle");
    expect(() => joinSession(home, session.id, "no-circle")).toThrow("不在任何信任圈里");
    const detail = checkSessionAdmission(home, "no-circle");
    expect(detail.admitted).toBe(false);
    seedAdmission(home, "pilot");
    const member = joinSession(home, session.id, "pilot");
    expect(member.kind).toBe("friend");
    expect(() => joinSession(home, session.id, "pilot")).toThrow("已在会话");
    const after = findSession(loadSessionBook(home), session.id)!;
    expect(after.members.map((m) => m.identity)).toContain("pilot");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_leave_and_auto_end", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    const left = leaveSession(home, session.id, "pilot");
    expect(left.status).toBe("active");
    leaveSession(home, session.id, "self");
    const ended = leaveSession(home, session.id, "owner");
    expect(ended.status).toBe("ended");
    expect(ended.frames).toEqual([]);
    expect(() => leaveSession(home, session.id, "owner")).toThrow("已结束");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_end_session_rules", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    expect(() => endSession(home, session.id, "pilot")).toThrow("只有机主能结束");
    const ended = endSession(home, session.id);
    expect(ended.status).toBe("ended");
    expect(ended.ended_at).not.toBeNull();
    expect(() => endSession(home, session.id)).toThrow("已结束");
    expect(() => joinSession(home, session.id, "pilot")).toThrow("已结束");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_corrupt_book_backups_and_throws", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    createSession(home, "周会");
    writeFileSync(join(home, "sessions.json"), "{ 不是 json", "utf-8");
    expect(() => loadSessionBook(home)).toThrow("已损坏");
    const backups = readdirSync(home).filter((f) => f.startsWith("sessions.json.corrupt-"));
    expect(backups.length).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_delegate_to_self_stays_local", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    const delegation = await delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "self",
      task: "把本周的订单异常整理成清单", acceptance: ["清单含全部异常订单", "每单有处理建议"],
    });
    expect(delegation.status).toBe("delegated");
    expect(delegation.delivery).toBe("pending");
    expect(delegation.delivery_reason).toContain("本机会内任务");
    expect(delegation.contract_id).not.toBeNull();
    const contract = getContract(home, delegation.contract_id!);
    expect(contract?.status).toBe("active");
    expect(contract?.checks.length).toBe(2);
    const events = readAllRunEvents(home);
    expect(events.some((e) => e.type === "session_delegated" && e.delegation === delegation.id)).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_delegate_requires_member_and_acceptance", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    await expect(delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "pilot",
      task: "整理清单", acceptance: ["有清单"],
    })).rejects.toThrow("不在会话");
    await expect(delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "self",
      task: "整理清单", acceptance: [],
    })).rejects.toThrow("验收标准");
    await expect(delegateInSession(home, {
      sessionId: session.id, from: "stranger", to: "self",
      task: "整理清单", acceptance: ["有清单"],
    })).rejects.toThrow("不在会话");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_delegate_unconfigured_peer_stays_pending", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    const delegation = await delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "pilot",
      task: "把本周的订单异常整理成清单", acceptance: ["清单含全部异常订单"],
    });
    expect(delegation.delivery).toBe("pending");
    expect(delegation.delivery_reason).toContain("未配在");
    expect(delegation.status).toBe("delegated");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_delegate_disabled_peers_stays_pending", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    seedPeerConfig(home, "pilot", false);
    const delegation = await delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "pilot",
      task: "把本周的订单异常整理成清单", acceptance: ["清单含全部异常订单"],
    });
    expect(delegation.delivery).toBe("pending");
    expect(delegation.delivery_reason).toContain("未开启");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_delegate_delivery_via_fake_peer", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    seedPeerConfig(home, "pilot", true);
    const delegation = await delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "pilot",
      task: "把本周的订单异常整理成清单", acceptance: ["清单含全部异常订单"],
      deps: { clientFactory: fakeClientFactory as never, reviewerRunner: allowRunner as never, token: "fake-token" },
    });
    expect(delegation.delivery).toBe("sent");
    expect(delegation.peer_run_id).toBe("20261122-120000-abcdef");
    const audit = readAudit(home);
    expect(audit.some((a) => a.action === "session_delegated" && a.delivery === "sent")).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_delegate_review_block_keeps_task", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    seedPeerConfig(home, "pilot", true);
    const delegation = await delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "pilot",
      task: "把本周的订单异常整理成清单", acceptance: ["清单含全部异常订单"],
      deps: { clientFactory: fakeClientFactory as never, reviewerRunner: denyRunner as never, token: "fake-token" },
    });
    expect(delegation.delivery).toBe("blocked");
    expect(delegation.status).toBe("delegated");
    expect(delegation.peer_run_id).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_accept_and_complete_lifecycle", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    const delegation = await delegateInSession(home, {
      sessionId: session.id, from: "owner", to: "self",
      task: "把本周的订单异常整理成清单", acceptance: ["清单含全部异常订单"],
    });
    expect(() => acceptDelegation(home, session.id, delegation.id, "stranger")).toThrow("只有被委派方");
    const accepted = acceptDelegation(home, session.id, delegation.id, "self");
    expect(accepted.status).toBe("accepted");
    expect(() => acceptDelegation(home, session.id, delegation.id, "self")).toThrow("不用再接");
    const done = completeDelegation(home, session.id, delegation.id, "self", "清单已出，共 3 单");
    expect(done.status).toBe("completed");
    expect(done.note).toBe("清单已出，共 3 单");
    expect(() => completeDelegation(home, session.id, delegation.id, "self")).toThrow("不能再交活");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_share_allowlist", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    const share = shareInSession(home, {
      sessionId: session.id, from: "owner",
      items: [{ kind: "product", label: "本周异常订单清单" }],
    });
    expect(share.to).toEqual(["self", "pilot"]);
    expect(share.items[0].file).toBe("");
    for (const denied of ["memory", "history", "secret", "file", "key"]) {
      expect(() => shareInSession(home, {
        sessionId: session.id, from: "owner",
        items: [{ kind: denied, label: "不该共享的东西" }],
      })).toThrow("不在共享 allowlist 里");
    }
    expect(() => shareInSession(home, {
      sessionId: session.id, from: "owner",
      items: [{ kind: "weird", label: "未知种" }],
    })).toThrow("共享种类只认");
    expect(() => shareInSession(home, {
      sessionId: session.id, from: "stranger",
      items: [{ kind: "note", label: "你好" }],
    })).toThrow("不在会话");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_share_with_run_writes_package", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    const runId = seedRun(home);
    const share = shareInSession(home, {
      sessionId: session.id, from: "owner",
      items: [{ kind: "product", label: "周报运行的交接包" }],
      runId,
    });
    expect(share.items[0].file).toBe(`sessions/${session.id}/shared/${share.id}.md`);
    const pkgPath = join(home, share.items[0].file);
    expect(existsSync(pkgPath)).toBe(true);
    expectPerms(pkgPath, 0o600);
    expect(readFileSync(pkgPath, "utf-8")).toContain("测试任务：整理一份周报");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_fanout_model", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    const { recipients, frame } = fanoutFrame(home, session.id, "owner", "abcdef123456");
    expect(recipients).toEqual(["self", "pilot"]);
    expect(frame.hash).toBe("abcdef123456");
    expect(() => fanoutFrame(home, session.id, "owner", "NOT-A-HASH")).toThrow("只认 12 位小写 hex");
    expect(() => fanoutFrame(home, session.id, "stranger", "abcdef123456")).toThrow("不在会话");
    const audit = readAudit(home);
    expect(audit.some((a) => a.action === "session_frame_fanned" && a.hash === "abcdef123456")).toBe(true);
    for (let i = 0; i < SESSION_MAX_FRAMES + 5; i++) {
      fanoutFrame(home, session.id, "owner", String(i).padStart(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "a"));
    }
    const after = findSession(loadSessionBook(home), session.id)!;
    expect(after.frames.length).toBe(SESSION_MAX_FRAMES);
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_recording_consent_gate", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    const session = createSession(home, "周会");
    seedAdmission(home, "pilot");
    joinSession(home, session.id, "pilot");
    expect(recordingAllowed(findSession(loadSessionBook(home), session.id)!)).toBe(false);
    consentRecording(home, session.id, "owner", true);
    consentRecording(home, session.id, "self", true);
    expect(recordingAllowed(findSession(loadSessionBook(home), session.id)!)).toBe(false);
    const all = consentRecording(home, session.id, "pilot", true);
    expect(all.allowed).toBe(true);
    expect(all.consented).toEqual(["owner", "self", "pilot"]);
    seedAdmission(home, "second");
    joinSession(home, session.id, "second");
    expect(recordingAllowed(findSession(loadSessionBook(home), session.id)!)).toBe(false);
    consentRecording(home, session.id, "second", true);
    expect(recordingAllowed(findSession(loadSessionBook(home), session.id)!)).toBe(true);
    const revoked = consentRecording(home, session.id, "pilot", false);
    expect(revoked.allowed).toBe(false);
    expect(() => consentRecording(home, session.id, "stranger", true)).toThrow("不在会话");
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_cli_smoke", async () => {
  const home = tmpHome("nyra-ses39-");
  try {
    expect(await handleSession(["create", "周会：跟进 affiliate 项目"], home)).toBe(0);
    const sessions = listSessions(home);
    expect(sessions.length).toBe(1);
    const id = sessions[0].id;
    seedAdmission(home, "pilot");
    expect(await handleSession(["join", id, "pilot"], home)).toBe(0);
    expect(await handleSession(["join", id, "stranger"], home)).toBe(1);
    expect(await handleSession(["delegate", id, "--to", "pilot", "--task", "整理异常订单", "--accept", "清单齐全"], home)).toBe(0);
    const book = loadSessionBook(home);
    const delegation = findSession(book, id)!.delegations[0];
    expect(delegation.delivery).toBe("pending");
    expect(await handleSession(["accept", id, delegation.id, "--by", "pilot"], home)).toBe(0);
    expect(await handleSession(["complete", id, delegation.id, "--by", "pilot", "--note", "已出清单"], home)).toBe(0);
    expect(await handleSession(["share", id, "--kind", "note", "--label", "本周重点是物流"], home)).toBe(0);
    expect(await handleSession(["share", id, "--kind", "memory", "--label", "全部记忆"], home)).toBe(1);
    expect(await handleSession(["frame", id, "--hash", "abcdef123456"], home)).toBe(0);
    expect(await handleSession(["record", id, "--status"], home)).toBe(0);
    expect(await handleSession(["record", id, "--consent"], home)).toBe(0);
    expect(await handleSession(["show", id], home)).toBe(0);
    expect(await handleSession(["end", id], home)).toBe(2);
    expect(await handleSession(["end", id, "--yes"], home)).toBe(0);
    const ended = findSession(loadSessionBook(home), id)!;
    expect(ended.status).toBe("ended");
    expect(ended.frames).toEqual([]);
    expect(await handleSession(["delegate", id, "--to", "pilot", "--task", "x", "--accept", "y"], home)).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("Sessions39Test.test_list_sessions", () => {
  const home = tmpHome("nyra-ses39-");
  try {
    expect(listSessions(home)).toEqual([]);
    createSession(home, "会一");
    createSession(home, "会二");
    expect(listSessions(home).length).toBe(2);
  } finally {
    cleanup(home);
  }
});
