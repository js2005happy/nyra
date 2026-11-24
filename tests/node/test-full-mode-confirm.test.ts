// tests/node/test-full-mode-confirm.test.ts — 手机开完全模式须电脑确认。
//
// 以前的口径：手机自己点两次确认、带 confirm: "full" 发给网关就放行——
// 手机自己断言的不算确认。现在：非机主请求 full 只记一笔待确认请求
// （202，模式不动），机主在电脑上用 nyra gw mode-confirm <id> 批了才生效；
// 拒绝、过期（10 分钟）、不存在的 id 都不通过。机主直接切不受影响。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FullModeRequests, FULL_MODE_REQUEST_TTL_SECONDS } from "../../src/fullModeRequests.ts";
import { Gateway } from "../../src/gateway.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("待确认请求：10 分钟过期，过期后决定不到", () => {
  let now = 1_000_000;
  const store = new FullModeRequests({ clock: () => now });
  expect(FULL_MODE_REQUEST_TTL_SECONDS).toBe(600);
  const a = store.request("Pixel 7");
  const b = store.request("iPhone");
  expect(a.id).not.toBe(b.id);
  expect(a.expiresAt).toBe(now + 600);
  expect(store.list().map((r) => r.device)).toEqual(["Pixel 7", "iPhone"]);
  now += 599;
  expect(store.list().length).toBe(2);
  now += 2;
  expect(store.list()).toEqual([]);
  expect(store.decide(a.id, true)).toBeNull();
  expect(store.decide("nope", true)).toBeNull();
});

test("待确认请求：批准返回 true，拒绝返回 false，都只生效一次", () => {
  const store = new FullModeRequests();
  const a = store.request("Pixel 7");
  const b = store.request("iPhone");
  expect(store.decide(a.id, true)).toBe(true);
  expect(store.decide(a.id, true)).toBeNull();
  expect(store.decide(b.id, false)).toBe(false);
  expect(store.list()).toEqual([]);
});

// ---------------------------------------------------------- 网关端到端 ---
async function pairedGateway() {
  const home = tmp("nyra-fullmode-");
  const gw = new Gateway({ home, workdir: tmp("nyra-fullmode-wd-"), host: "0.0.0.0", port: 0, mode: "auto", config: { mcp_enabled: false } });
  const info = await gw.start();
  const base = `http://127.0.0.1:${info.port}`;
  const started = gw.startPairing() as { code: string };
  const dev = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel 7" }) })).json() as { token: string };
  return { gw, base, phone: { "X-Nyra-Token": dev.token }, owner: { "X-Nyra-Token": gw.token } };
}

test("网关：手机请求 full 得 202、模式不动；电脑拒绝后模式仍不动", async () => {
  const { gw, base, phone, owner } = await pairedGateway();
  try {
    const pending = await fetch(`${base}/api/mode`, { method: "POST", headers: phone, body: JSON.stringify({ mode: "full" }) });
    expect(pending.status).toBe(202);
    const { request_id, expires_at } = await pending.json() as { request_id: string; expires_at: string };
    expect(request_id).toBeTruthy();
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(gw.mode).toBe("auto");
    const denied = await fetch(`${base}/api/mode/confirm`, { method: "POST", headers: owner, body: JSON.stringify({ request_id, approve: false }) });
    expect(denied.status).toBe(200);
    expect((await denied.json() as { rejected: boolean }).rejected).toBe(true);
    expect(gw.mode).toBe("auto");
    // 同一个 id 只生效一次。
    expect((await fetch(`${base}/api/mode/confirm`, { method: "POST", headers: owner, body: JSON.stringify({ request_id, approve: true }) })).status).toBe(404);
  } finally { await gw.stop(); }
});

test("网关：不存在的 id 确认报 404；已经是 full 时手机再请求直接 200、不建请求", async () => {
  const { gw, base, phone, owner } = await pairedGateway();
  try {
    expect((await fetch(`${base}/api/mode/confirm`, { method: "POST", headers: owner, body: JSON.stringify({ request_id: "nope", approve: true }) })).status).toBe(404);
    expect((await fetch(`${base}/api/mode`, { method: "POST", headers: owner, body: JSON.stringify({ mode: "full" }) })).status).toBe(200);
    expect(gw.mode).toBe("full");
    expect((await fetch(`${base}/api/mode`, { method: "POST", headers: phone, body: JSON.stringify({ mode: "full" }) })).status).toBe(200);
    const list = await (await fetch(`${base}/api/mode/requests`, { headers: owner })).json() as { requests: unknown[] };
    expect(list.requests).toEqual([]);
  } finally { await gw.stop(); }
});
