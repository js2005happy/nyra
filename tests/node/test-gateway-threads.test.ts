// tests/node/test-gateway-threads.test.ts — G-P1-37：网关 /api/threads 真测。
// 真起一个 Gateway（127.0.0.1:0），走网关 token 鉴权：建列详情复制剪历史、
// 状态读写、归档、404、无 token 403、user 角色账号写接口 403。
// mock-only：线程账本在临时 home 里，不碰真云端。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { AccountStore, AccountSessionStore } from "../../src/accounts.ts";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-gw-thr-"));
}

async function startGateway(home: string, workdir: string) {
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  return { gw, info };
}

async function seedUserToken(home: string): Promise<string> {
  const directory = new AccountStore(home);
  await directory.create({ email: "owner@example.com" }); // 第一个是 owner
  const user = await directory.create({ email: "user@example.com" });
  const sessions = new AccountSessionStore(home);
  const session = await sessions.issue(user.id);
  return session.token;
}

test("GatewayThreadsTest.test_crud_flow", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-thr-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const auth = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    // 建线程。
    const created = await fetch(`${base}/api/threads`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ title: "网关线程", state: { week: 1 } }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { thread: { id: string; title: string; state: Record<string, unknown> } };
    const id = createdBody.thread.id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(createdBody.thread.state).toEqual({ week: 1 });
    // 列表（只给元数据，不给 state）。
    const listed = await fetch(`${base}/api/threads`, { headers: auth });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { threads: Array<Record<string, unknown>> };
    expect(listedBody.threads.length).toBe(1);
    expect(listedBody.threads[0]).not.toHaveProperty("state");
    // 搜。
    const searched = await fetch(`${base}/api/threads?q=网关`, { headers: auth });
    const searchedBody = await searched.json() as { threads: unknown[] };
    expect(searchedBody.threads.length).toBe(1);
    const missed = await fetch(`${base}/api/threads?q=不存在`, { headers: auth });
    const missedBody = await missed.json() as { threads: unknown[] };
    expect(missedBody.threads.length).toBe(0);
    // 详情。
    const shown = await fetch(`${base}/api/threads/${id}`, { headers: auth });
    expect(shown.status).toBe(200);
    // 状态读写。
    const state = await fetch(`${base}/api/threads/${id}/state`, { headers: auth });
    const stateBody = await state.json() as { state: Record<string, unknown> };
    expect(stateBody.state).toEqual({ week: 1 });
    const updated = await fetch(`${base}/api/threads/${id}/state`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ patch: { week: 2, done: true } }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { state: Record<string, unknown> };
    expect(updatedBody.state).toEqual({ week: 2, done: true });
    // 复制（状态复制了，id 不同）。
    const copied = await fetch(`${base}/api/threads/${id}/copy`, { method: "POST", headers: auth });
    expect(copied.status).toBe(201);
    const copiedBody = await copied.json() as { thread: { id: string; title: string } };
    expect(copiedBody.thread.id).not.toBe(id);
    expect(copiedBody.thread.title).toContain("（副本）");
    // 历史与运行（新建的线程是空的）。
    const history = await fetch(`${base}/api/threads/${id}/history`, { headers: auth });
    const historyBody = await history.json() as { history: unknown[] };
    expect(historyBody.history).toEqual([]);
    const runs = await fetch(`${base}/api/threads/${id}/runs`, { headers: auth });
    const runsBody = await runs.json() as { runs: unknown[] };
    expect(runsBody.runs).toEqual([]);
    // 剪历史（空历史也能剪）。
    const pruned = await fetch(`${base}/api/threads/${id}/prune`, {
      method: "POST", headers: auth, body: JSON.stringify({ keep: 10 }),
    });
    expect(pruned.status).toBe(200);
    // 归档与取消归档。
    const archived = await fetch(`${base}/api/threads/${id}/archive`, { method: "POST", headers: auth });
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json() as { thread: { status: string } };
    expect(archivedBody.thread.status).toBe("archived");
    const unarchived = await fetch(`${base}/api/threads/${id}/unarchive`, { method: "POST", headers: auth });
    const unarchivedBody = await unarchived.json() as { thread: { status: string } };
    expect(unarchivedBody.thread.status).toBe("active");
    // 不存在的线程 id：404。
    const missing = await fetch(`${base}/api/threads/0000000000000000`, { headers: auth });
    expect(missing.status).toBe(404);
    // 参数错：空标题 400。
    const badTitle = await fetch(`${base}/api/threads`, {
      method: "POST", headers: auth, body: JSON.stringify({ title: "" }),
    });
    expect(badTitle.status).toBe(400);
  } finally {
    await gw.stop();
  }
});

test("GatewayThreadsTest.test_no_token_403", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-thr-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/api/threads`);
    expect(res.status).toBe(403);
    const bad = await fetch(`${base}/api/threads`, {
      method: "POST",
      headers: { "X-Nyra-Token": "not-a-valid-token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(bad.status).toBe(403);
  } finally {
    await gw.stop();
  }
});

test("GatewayThreadsTest.test_user_role_readonly", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-thr-wd-"));
  const userToken = await seedUserToken(home);
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const userAuth = { "X-Nyra-Token": userToken, "Content-Type": "application/json" };
    // user 角色：读接口能过。
    const listed = await fetch(`${base}/api/threads`, { headers: userAuth });
    expect(listed.status).toBe(200);
    // user 角色：写接口 403。
    const created = await fetch(`${base}/api/threads`, {
      method: "POST", headers: userAuth, body: JSON.stringify({ title: "不该建" }),
    });
    expect(created.status).toBe(403);
  } finally {
    await gw.stop();
  }
});
