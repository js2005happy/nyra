// tests/node/test-session-join-batch2.test.ts — 第 2 批 G-P1-5：进群准入（待批进会）。
// 全部用临时 home，不调模型、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFriendBook, saveFriendBook } from "../../src/peerCard.ts";
import { inviteToCircle, loadCircleBook, revokeFromCircle, saveCircleBook } from "../../src/circles.ts";
import {
  approveJoinSession,
  checkSessionAdmission,
  createSession,
  declineJoinSession,
  listPendingJoins,
  requestJoinSession,
} from "../../src/session.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function now(): string {
  return new Date().toISOString();
}

function seedAdmission(home: string, name: string, circle = "work"): void {
  let book;
  try { book = loadFriendBook(home); } catch { book = { version: 1, friends: [], circles: [{ name: "default", created_at: now() }] }; }
  const entry = {
    name,
    url: "http://127.0.0.1:9/mcp",
    card_hash: "seed",
    circle: "default",
    tier: "readonly" as const,
    outbound: "accepted" as const,
    inbound: "accepted" as const,
    blocked: false,
    code_hash: null,
    created_at: now(),
    updated_at: now(),
  };
  const idx = book.friends.findIndex((f) => f.name === name);
  if (idx >= 0) book.friends[idx] = entry;
  else book.friends.push(entry);
  saveFriendBook(home, book);
  // 圈账本是整本保存：已有就复用（别把先前邀请的人踢出去），没有才新建。
  let circleBook;
  try { circleBook = loadCircleBook(home); } catch { circleBook = null; }
  if (!circleBook) {
    saveCircleBook(home, {
      version: 1,
      circles: [{ name: circle, description: "", created_at: now(), created_by: "owner", members: [] }],
      bindings: [],
    });
  } else if (!circleBook.circles.some((c) => c.name === circle)) {
    circleBook.circles.push({ name: circle, description: "", created_at: now(), created_by: "owner", members: [] });
    saveCircleBook(home, circleBook);
  }
  inviteToCircle(home, { circle, identity: name });
}

test("SessionJoinBatch2.test_request_approve_flow", () => {
  const home = tmpHome("nyra-sjoin-");
  try {
    seedAdmission(home, "alice");
    const session = createSession(home, "测试会");
    const req = requestJoinSession(home, session.id, "alice");
    expect(req.status).toBe("pending");
    expect(req.identity).toBe("alice");
    expect(listPendingJoins(home, session.id).length).toBe(1);
    // 重复请求报错。
    expect(() => requestJoinSession(home, session.id, "alice")).toThrow("待批的进会请求");
    const member = approveJoinSession(home, session.id, req.id);
    expect(member.identity).toBe("alice");
    expect(listPendingJoins(home, session.id).length).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SessionJoinBatch2.test_stranger_request_rejected_at_gate", () => {
  const home = tmpHome("nyra-sjoin-");
  try {
    const session = createSession(home, "测试会");
    expect(checkSessionAdmission(home, "nobody").admitted).toBe(false);
    expect(() => requestJoinSession(home, session.id, "nobody")).toThrow("进不了会");
    expect(listPendingJoins(home, session.id).length).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SessionJoinBatch2.test_decline_and_approve_rechecks_admission", () => {
  const home = tmpHome("nyra-sjoin-");
  try {
    seedAdmission(home, "bob");
    seedAdmission(home, "carol");
    const session = createSession(home, "测试会");
    const bobReq = requestJoinSession(home, session.id, "bob");
    const declined = declineJoinSession(home, session.id, bobReq.id);
    expect(declined.status).toBe("declined");
    // 只有机主能批。
    const carolReq = requestJoinSession(home, session.id, "carol");
    expect(() => approveJoinSession(home, session.id, carolReq.id, "someone-else")).toThrow("只有机主能批准");
    // 批准时重查准入闸：请求后把 carol 踢出圈，批准失败、请求保持待批。
    revokeFromCircle(home, "work", "carol");
    expect(() => approveJoinSession(home, session.id, carolReq.id)).toThrow("现在进不了会");
    expect(listPendingJoins(home, session.id).length).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
