// tests/node/test-gateway-owner-token-loopback.test.ts — 电脑端自己的 token 只认回环连接。
//
// 回归：tokenOk() 以前不看对端地址。`nyra ui --pair` 监听 0.0.0.0 时，局域网里任何主机
// 只要拿到电脑端 token 就是“主人”。现在主人 token 只接受 127.0.0.0/8 / ::1；
// 已配对手机的设备 token 不受影响，照常可以从局域网用。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, isLoopbackPeer } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeGateway(): Gateway {
  return new Gateway({
    home: tmpDir("nyra-owner-home-"), workdir: tmpDir("nyra-owner-wd-"), mode: "auto",
    host: "127.0.0.1", port: 0, token: "owner-token-for-test",
    providerFactory: () => fakeProvider([{ content: "好的。" }]),
    config: { mcp_enabled: false, fallback_enabled: false },
  });
}

/** 只带鉴权需要的字段的假请求：请求头 + 对端地址。 */
function fakeReq(remoteAddress: string, headers: Record<string, string>, url = "/api/sessions") {
  return { headers, url, socket: { remoteAddress } } as unknown as import("node:http").IncomingMessage;
}

type AuthAccess = { apiAuth(req: unknown): Promise<unknown>; pageTokenOk(req: unknown): boolean };

test("isLoopbackPeer：127.x、::1、::ffff:127.x 算回环；局域网、空值不算", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackPeer(a)).toBe(true);
  for (const a of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "fe80::1", "", undefined, null, "127.example"]) {
    expect(isLoopbackPeer(a as string | undefined)).toBe(false);
  }
});

test("主人 token：回环来的算 owner，局域网来的不算（请求头与 ?token= 都一样）", async () => {
  const gw = makeGateway() as unknown as AuthAccess;
  const h = { "x-nyra-token": "owner-token-for-test" };
  expect(await gw.apiAuth(fakeReq("127.0.0.1", h))).toBe("owner");
  expect(await gw.apiAuth(fakeReq("::ffff:127.0.0.1", h))).toBe("owner");
  expect(await gw.apiAuth(fakeReq("192.168.1.20", h))).toBeNull();
  expect(await gw.apiAuth(fakeReq("::ffff:192.168.1.20", { "x-angel-token": "owner-token-for-test" }))).toBeNull();
  expect(gw.pageTokenOk(fakeReq("127.0.0.1", {}, "/?token=owner-token-for-test"))).toBe(true);
  expect(gw.pageTokenOk(fakeReq("192.168.1.20", {}, "/?token=owner-token-for-test"))).toBe(false);
});

test("设备 token：已配对手机从局域网照常通过（不受回环限制）", async () => {
  const gateway = makeGateway();
  const { code } = gateway.devices.startPairing();
  const device = gateway.devices.redeem(code, "测试手机");
  const gw = gateway as unknown as AuthAccess;
  const who = await gw.apiAuth(fakeReq("192.168.1.20", { "x-nyra-token": device.token })) as Record<string, unknown> | null;
  expect(who).not.toBeNull();
  expect(who).not.toBe("owner");
  expect((who as Record<string, unknown>).id).toBe(device.id);
});

test("真连接：本机回环带主人 token 的 API 请求照常 200，不带 token 被拒", async () => {
  const gateway = makeGateway();
  const { port } = await gateway.start();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { "X-Nyra-Token": "owner-token-for-test" } });
    expect(ok.status).toBe(200);
    const no = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect([401, 403]).toContain(no.status);
  } finally {
    await gateway.stop();
  }
});
