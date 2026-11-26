// tests/node/test-gateway-presence.test.ts — H2：网关 presence（桌面活跃 → 手机通知静默）。
// 只做网关侧：心跳账本、5 分钟活跃窗口、要不要推手机的决定、网关端点与 CLI 动作。
// 手机端按 should_notify_mobile 决定推不推（随后接）；桌面端由桌面应用调
// 心跳接口上报。owner 回合（本机回环 token）即桌面活跃。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import {
  PRESENCE_ACTIVE_WINDOW_MS, PRESENCE_HEARTBEAT_MIN_INTERVAL_MS,
  isDesktopActive, isPresenceRowActive, isPresenceSurface, listActivePresence,
  loadGatewayPresence, recordPresenceHeartbeat, shouldNotifyMobile,
} from "../../src/gatewayPresence.ts";
import { recordGatewayRound } from "../../src/gatewayClients.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-presence-"));
}

const T0 = new Date("2026-11-25T10:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

test("GatewayPresenceTest.test_heartbeat_roundtrip_and_surface_default", () => {
  const home = tmpHome();
  try {
    expect(loadGatewayPresence(home)).toEqual([]);
    const r1 = recordPresenceHeartbeat(home, { client: "device:phone1", kind: "device", source: "heartbeat", now: T0 });
    expect(r1).toEqual({ ok: true, throttled: false });
    const rows = loadGatewayPresence(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client: "device:phone1", kind: "device", surface: "mobile", heartbeats: 1, source: "heartbeat" });
    // device 不报 surface 时默认 mobile；owner 默认 desktop；account 默认 web。
    recordPresenceHeartbeat(home, { client: "owner", kind: "owner", source: "heartbeat", now: T0 });
    recordPresenceHeartbeat(home, { client: "account:u1", kind: "account", source: "heartbeat", now: T0 });
    const byId = new Map(loadGatewayPresence(home).map((r) => [r.client, r]));
    expect(byId.get("owner")!.surface).toBe("desktop");
    expect(byId.get("account:u1")!.surface).toBe("web");
    expect(isPresenceSurface("desktop")).toBe(true);
    expect(isPresenceSurface("bogus")).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GatewayPresenceTest.test_heartbeat_throttle_within_10s", () => {
  const home = tmpHome();
  try {
    recordPresenceHeartbeat(home, { client: "owner", kind: "owner", surface: "desktop", source: "heartbeat", now: T0 });
    const again = recordPresenceHeartbeat(home, { client: "owner", kind: "owner", surface: "desktop", source: "heartbeat", now: plus(5000) });
    expect(again).toEqual({ ok: true, throttled: true });
    expect(loadGatewayPresence(home)[0].heartbeats).toBe(1);
    const later = recordPresenceHeartbeat(home, { client: "owner", kind: "owner", surface: "desktop", source: "heartbeat", now: plus(PRESENCE_HEARTBEAT_MIN_INTERVAL_MS + 1000) });
    expect(later.throttled).toBe(false);
    expect(loadGatewayPresence(home)[0].heartbeats).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GatewayPresenceTest.test_active_window_5min_and_notify_decision", () => {
  const home = tmpHome();
  try {
    recordPresenceHeartbeat(home, { client: "owner", kind: "owner", surface: "desktop", source: "heartbeat", now: T0 });
    recordPresenceHeartbeat(home, { client: "device:phone1", kind: "device", surface: "mobile", source: "heartbeat", now: T0 });
    // 窗口内：桌面活跃 → 手机静默。
    expect(isDesktopActive(home, T0)).toBe(true);
    expect(shouldNotifyMobile(home, T0)).toBe(false);
    expect(listActivePresence(home, T0)).toHaveLength(2);
    // 正好 5 分钟边界仍算活跃；超过 5 分钟桌面不活跃 → 推手机。
    expect(isPresenceRowActive(loadGatewayPresence(home)[0], plus(PRESENCE_ACTIVE_WINDOW_MS))).toBe(true);
    expect(isDesktopActive(home, plus(PRESENCE_ACTIVE_WINDOW_MS + 1000))).toBe(false);
    expect(shouldNotifyMobile(home, plus(PRESENCE_ACTIVE_WINDOW_MS + 1000))).toBe(true);
    expect(listActivePresence(home, plus(PRESENCE_ACTIVE_WINDOW_MS + 1000))).toEqual([]);
    // 只有手机活跃时也要推（桌面不活跃才推手机，只看桌面）。
    expect(shouldNotifyMobile(home, plus(PRESENCE_ACTIVE_WINDOW_MS + 1000))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GatewayPresenceTest.test_owner_round_marks_desktop_active", () => {
  const home = tmpHome();
  try {
    expect(recordGatewayRound(home, { sessionId: "s1", client: "owner", kind: "owner", channel: "session" })).toBe(true);
    const rows = loadGatewayPresence(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client: "owner", surface: "desktop", source: "round" });
    expect(isDesktopActive(home)).toBe(true);
    expect(shouldNotifyMobile(home)).toBe(false);
    // 非 owner 回合不记 presence（手机/账号回合不是桌面活跃）。
    const home2 = tmpHome();
    try {
      recordGatewayRound(home2, { sessionId: "s1", client: "device:phone1", kind: "device", channel: "session" });
      expect(loadGatewayPresence(home2)).toEqual([]);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GatewayPresenceTest.test_gateway_endpoints", async () => {
  const home = tmpHome();
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "auto", config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    // 初始：桌面不活跃，手机会推。
    const empty = await fetch(`${base}/api/presence`, { headers });
    expect(empty.status).toBe(200);
    const e = await empty.json() as { desktop_active: boolean; should_notify_mobile: boolean; window_ms: number; active: unknown[] };
    expect(e.desktop_active).toBe(false);
    expect(e.should_notify_mobile).toBe(true);
    expect(e.window_ms).toBe(PRESENCE_ACTIVE_WINDOW_MS);
    expect(e.active).toEqual([]);
    // 非机主 token 查不到（403）。
    const bad = await fetch(`${base}/api/presence`, { headers: { "X-Nyra-Token": "wrong", "Content-Type": "application/json" } });
    expect(bad.status).toBe(403);
    // owner 报心跳（不带 surface，按 kind 推断为 desktop）。
    const hb = await fetch(`${base}/api/presence/heartbeat`, { method: "POST", headers, body: "{}" });
    expect(hb.status).toBe(200);
    const h = await hb.json() as { ok: boolean; throttled: boolean; desktop_active: boolean; should_notify_mobile: boolean };
    expect(h.ok).toBe(true);
    expect(h.desktop_active).toBe(true);
    expect(h.should_notify_mobile).toBe(false);
    const after = await fetch(`${base}/api/presence`, { headers });
    const a = await after.json() as { desktop_active: boolean; should_notify_mobile: boolean; active: { client: string; surface: string }[] };
    expect(a.desktop_active).toBe(true);
    expect(a.should_notify_mobile).toBe(false);
    expect(a.active[0]).toMatchObject({ client: "owner", surface: "desktop" });
    // 非法 surface 报 400。
    const badSurface = await fetch(`${base}/api/presence/heartbeat`, { method: "POST", headers, body: JSON.stringify({ surface: "tv" }) });
    expect(badSurface.status).toBe(400);
  } finally {
    await gw.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
