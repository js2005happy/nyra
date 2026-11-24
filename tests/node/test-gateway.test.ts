// tests/node/test-gateway.test.ts — 单 gateway 专项（第 3 阶段）。
// 双客户端一致性、SSE、token 鉴权、并发 send 得 409、会话/历史一致。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { GatewayClient } from "../../src/gatewayClient.ts";
import { fakeProvider } from "./fake-provider.ts";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-gw-"));
}

async function startGateway(home: string, workdir: string) {
  writeFileSync(join(workdir, "hello.txt"), "你好，世界\n", "utf-8");
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    providerFactory: () => fakeProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } }],
      },
      { content: "已读到文件：你好，世界。" },
    ], { delayMs: 400 }),
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  return { gw, info };
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("GatewayHealthTest.test_health_no_token_and_info_needs_token", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json() as { ok: boolean }).ok).toBe(true);
    const noToken = await fetch(`${base}/api/info`);
    expect(noToken.status).toBe(403);
    const withToken = await fetch(`${base}/api/info`, { headers: { "X-Nyra-Token": gw.token } });
    expect(withToken.status).toBe(200);
    const body = await withToken.json() as { version: string; mode: string };
    expect(body.version).toBe("0.5.13");
    expect(body.mode).toBe("full");
    // X-Angel-Token 兼容（spec 07）。
    const angel = await fetch(`${base}/api/info`, { headers: { "X-Angel-Token": gw.token } });
    expect(angel.status).toBe(200);
  } finally {
    await gw.stop();
  }
});

test("GatewayDualClientTest.test_two_clients_same_session_same_history", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const clientA = new GatewayClient({ url: base, token: gw.token });
    const clientB = new GatewayClient({ url: base, token: gw.token });
    const { id } = await clientA.createSession();
    // 客户端 A 发，客户端 B 立刻再发同一会话：第二个得 409（不开两个 agent）。
    const sent = await clientA.send(id, "读一下 hello.txt") as { status: string };
    expect(sent.status).toBe("running");
    let conflict = false;
    try { await clientB.send(id, "再读一遍"); } catch (err) { conflict = String(err).includes("正在执行"); }
    expect(conflict).toBe(true);
    // 等跑完：两个客户端看到的历史完全一致，且只有一轮工具调用。
    await waitFor(async () => {
      const v = await clientA.sessionView(id) as { status: string };
      return v.status === "done";
    });
    const viewA = await clientA.sessionView(id) as { messages: { role: string; content: string }[]; status: string };
    const viewB = await clientB.sessionView(id) as { messages: { role: string; content: string }[]; status: string };
    expect(viewB.status).toBe("done");
    expect(JSON.stringify(viewB.messages)).toBe(JSON.stringify(viewA.messages));
    const assistants = viewA.messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2); // 一轮工具调用 + 最终回答
    expect(assistants[1].content).toContain("你好，世界");
    // 历史存档里也只有一轮问答（不丢、不重复）。
    const history = await clientA.history(id);
    expect(history.messages.filter((m) => m.role === "user").length).toBe(1);
    expect(history.messages.filter((m) => m.role === "assistant").length).toBe(1);
    // 第二轮：客户端 B 发，A 也能看到。
    await clientB.send(id, "再说一遍");
    await waitFor(async () => {
      const v = await clientA.sessionView(id) as { status: string };
      return v.status === "done";
    });
    const viewA2 = await clientA.sessionView(id) as { messages: unknown[] };
    expect(viewA2.messages.length).toBeGreaterThan(viewA.messages.length);
  } finally {
    await gw.stop();
  }
});

test("GatewaySseTest.test_events_stream_ends_with_run_finished", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const client = new GatewayClient({ url: base, token: gw.token });
    const { id } = await client.createSession();
    await client.send(id, "读一下 hello.txt");
    const res = await fetch(`${base}/api/sessions/${id}/events?since=0`, { headers: { "X-Nyra-Token": gw.token } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("run_finished");
    expect(text).toContain('"type":"user"');
  } finally {
    await gw.stop();
  }
});

test("GatewaySessionsTest.test_sessions_list_and_approvals_empty", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const client = new GatewayClient({ url: base, token: gw.token });
    const { id } = await client.createSession();
    const list = await client.sessions() as { sessions: { id: string }[] };
    expect(list.sessions.some((s) => s.id === id)).toBe(true);
    const approvals = await client.approvals() as { approvals: unknown[] };
    expect(approvals.approvals).toEqual([]);
  } finally {
    await gw.stop();
  }
});

test("GatewayGroupsTest.test_groups_crud_over_http", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const list0 = await fetch(`${base}/api/groups`, { headers });
    expect(list0.status).toBe(200);
    expect((await list0.json() as { groups: unknown[] }).groups).toEqual([]);
    const bad = await fetch(`${base}/api/groups`, {
      method: "POST", headers, body: JSON.stringify({ id: "BAD ID!", name: "x" }),
    });
    expect(bad.status).toBe(400);
    const created = await fetch(`${base}/api/groups`, {
      method: "POST", headers, body: JSON.stringify({ id: "dev", name: "开发群" }),
    });
    expect(created.status).toBe(201);
    const room = await created.json() as { id: string; name: string; bots: unknown[] };
    expect(room.id).toBe("dev");
    expect(room.name).toBe("开发群");
    expect(room.bots.length).toBeGreaterThan(0);
    const got = await fetch(`${base}/api/groups/dev`, { headers });
    expect(got.status).toBe(200);
    expect((await got.json() as { id: string }).id).toBe("dev");
    const list1 = await fetch(`${base}/api/groups`, { headers });
    expect((await list1.json() as { groups: { id: string }[] }).groups.map((g) => g.id)).toEqual(["dev"]);
    const missing = await fetch(`${base}/api/groups/nope`, { headers });
    expect(missing.status).toBe(400);
  } finally {
    await gw.stop();
  }
});

test("GatewayCreatorTest.test_info_modes_include_creator_and_set_mode", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    expect(gw.info().modes).toContain("creator");
    expect(gw.setMode("creator")).toBe("creator");
    expect(gw.mode).toBe("creator");
    expect(() => gw.setMode("nope")).toThrow();
    const viaHttp = await fetch(`${base}/api/mode`, {
      method: "POST", headers, body: JSON.stringify({ mode: "auto" }),
    });
    expect(viaHttp.status).toBe(200);
    expect((await viaHttp.json() as { mode: string }).mode).toBe("auto");
    const bad = await fetch(`${base}/api/mode`, {
      method: "POST", headers, body: JSON.stringify({ mode: "nope" }),
    });
    expect(bad.status).toBe(400);
  } finally {
    await gw.stop();
  }
});

test("GatewayGroupUiTest.test_groups_page_and_js_served_embedded", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const noToken = await fetch(`${base}/groups`);
    expect(noToken.status).toBe(403);
    const page = await fetch(`${base}/groups?token=${gw.token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("/group-ui.js");
    const js = await fetch(`${base}/group-ui.js`);
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(1000);
  } finally {
    await gw.stop();
  }
});

test("GatewayCreatorTest.test_url_json_nyra_field_is_ui_for_desktop_shell", async () => {
  // 桌面端外壳（desktop/src-tauri/src/lib.rs parse_start_line）只认 nyra == "ui"；
  // Python 版 url_json() 也是 "ui"，Node 移植一度错写成 "nyra" 导致外壳永远认不出启动行。
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wd-"));
  const { gw } = await startGateway(home, workdir);
  try {
    const json = gw.urlJson();
    expect(json.nyra).toBe("ui");
    expect(typeof json.url).toBe("string");
    expect(String(json.url)).toContain("token=");
    expect(json.token).toBe(gw.token);
  } finally {
    await gw.stop();
  }
});
