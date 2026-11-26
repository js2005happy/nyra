// tests/node/test-mcp-server.test.ts — 缺口 17：对外 MCP 服务。
// 覆盖：initialize/tools-list、记忆三工具、任务派发、证据查询、鉴权拒绝、
// 审查门（放行/拦截/未开启）、每次调用都记进运行记录与审计文件。
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NyraMcpServer, appendMcpServerAudit } from "../../src/mcp.ts";
import { appendMemory } from "../../src/memory.ts";
import { Gateway } from "../../src/gateway.ts";

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

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-mcp-server-"));
  appendMemory("测试记忆甲：Nyra 对外 MCP 服务的种子条目", undefined, home, undefined, "sess-abc");
  appendMemory("测试记忆乙：同一个会话的第二条", undefined, home, undefined, "sess-abc");
  appendMemory("测试记忆丙：另一个会话的条目", undefined, home, undefined, "sess-other");
  return home;
}

function serverConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mcp_server: { enabled: true, allow_writes: true },
    reviewer: { enabled: true },
    ...overrides,
  };
}

function makeServer(home: string, config: Record<string, unknown>, runner?: () => { chat: (...args: unknown[]) => Promise<Record<string, unknown>> } | null): NyraMcpServer {
  return new NyraMcpServer({
    home,
    config,
    reviewerRunner: runner ?? (() => allowRunner as never),
    activeSessionIds: () => [],
  });
}

async function call(server: NyraMcpServer, id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await server.handle({ jsonrpc: "2.0", id, method, params: params ?? {} }, "owner");
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

function toolText(body: Record<string, unknown>): { text: string; isError: boolean } {
  const result = body.result as Record<string, unknown>;
  const content = result.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? "", isError: result.isError === true };
}

/** 读某个 home 下全部运行事件（runs/ 与 tasks/）。 */
function readAllRunEvents(home: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const dir of ["runs", "tasks"]) {
    const base = join(home, dir);
    if (!existsSync(base)) continue;
    for (const runId of readdirSync(base)) {
      const p = join(base, runId, "events.jsonl");
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* ignore */ }
      }
    }
  }
  return out;
}

function readAudit(home: string): Record<string, unknown>[] {
  const p = join(home, "mcp-server-audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("McpServerTest.test_initialize_and_tools_list", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig());
  const init = await call(server, 1, "initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const initResult = init.result as Record<string, unknown>;
  expect(initResult.protocolVersion).toBe("2026-07-28");
  expect((initResult.serverInfo as Record<string, unknown>).name).toBe("Nyra");
  const list = await call(server, 2, "tools/list");
  const tools = (list.result as Record<string, unknown>).tools as { name: string }[];
  expect(tools.map((t) => t.name)).toEqual(["search_memory", "query_evidence", "answer_question", "add_memory", "forget_session", "dispatch_task"]);
  // 只读模式下写工具不出现。
  const ro = makeServer(home, serverConfig({ mcp_server: { enabled: true, allow_writes: false } }));
  const roList = await call(ro, 1, "tools/list");
  const roTools = (roList.result as Record<string, unknown>).tools as { name: string }[];
  expect(roTools.map((t) => t.name)).toEqual(["search_memory", "query_evidence", "answer_question"]);
});

test("McpServerTest.test_search_memory_add_memory_forget_session", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig());
  const found = await call(server, 1, "tools/call", { name: "search_memory", arguments: { query: "对外 MCP 服务" } });
  expect(toolText(found).text).toContain("测试记忆甲");
  const added = await call(server, 2, "tools/call", { name: "add_memory", arguments: { text: "测试记忆丁：对外写进来的新条目" } });
  const addedOut = toolText(added);
  expect(addedOut.isError).toBe(false);
  expect(addedOut.text).toContain("已记入长期记忆");
  const refound = await call(server, 3, "tools/call", { name: "search_memory", arguments: { query: "新条目" } });
  expect(toolText(refound).text).toContain("测试记忆丁");
  const deleted = await call(server, 4, "tools/call", { name: "forget_session", arguments: { session_id: "sess-abc" } });
  const deletedOut = toolText(deleted);
  expect(deletedOut.isError).toBe(false);
  expect(deletedOut.text).toContain("2 条记忆");
  // BM25 对中文按字切分，搜“第二条”也会低相关度命中“条目”，所以删没删
  // 直接看文件：甲/乙两行已不在，丙还在。
  const memoryText = readFileSync(join(home, "MEMORY.md"), "utf-8");
  expect(memoryText).not.toContain("测试记忆甲");
  expect(memoryText).not.toContain("测试记忆乙");
  expect(memoryText).toContain("测试记忆丙");
  // 另一个会话的条目还在。
  const kept = await call(server, 6, "tools/call", { name: "search_memory", arguments: { query: "另一个会话" } });
  expect(toolText(kept).text).toContain("测试记忆丙");
});

test("McpServerTest.test_forget_running_session_refused", async () => {
  const home = makeHome();
  const server = new NyraMcpServer({
    home,
    config: serverConfig(),
    reviewerRunner: () => allowRunner as never,
    activeSessionIds: () => ["sess-abc"],
  });
  const res = await call(server, 1, "tools/call", { name: "forget_session", arguments: { session_id: "sess-abc" } });
  const out = toolText(res);
  expect(out.isError).toBe(true);
  expect(out.text).toContain("正在执行任务");
});

test("McpServerTest.test_dispatch_task_and_query_evidence", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig());
  const dispatched = await call(server, 1, "tools/call", { name: "dispatch_task", arguments: { task: "测试任务：请回复 ok", mode: "readonly" } });
  const out = toolText(dispatched);
  expect(out.isError).toBe(false);
  expect(out.text).toContain("任务已入队");
  const runId = /run_id ([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/.exec(out.text)?.[1];
  expect(runId).toBeTruthy();
  expect(existsSync(join(home, "tasks", runId!))).toBe(true);
  // 证据查询：对外服务运行的事件里有这次派发。
  const runs = readdirSync(join(home, "runs"));
  expect(runs.length).toBeGreaterThanOrEqual(1);
  const servingRun = runs[0];
  const ev = await call(server, 2, "tools/call", { name: "query_evidence", arguments: { run_id: servingRun } });
  const evText = toolText(ev).text;
  expect(evText).toContain("mcp_server_call");
  expect(evText).toContain("dispatch_task");
});

test("McpServerTest.test_reviewer_deny_blocks_write", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig(), () => denyRunner as never);
  const res = await call(server, 1, "tools/call", { name: "add_memory", arguments: { text: "不该写进去的条目" } });
  const out = toolText(res);
  expect(out.isError).toBe(true);
  expect(out.text).toContain("拦截");
  const found = await call(server, 2, "tools/call", { name: "search_memory", arguments: { query: "不该写进去" } });
  expect(toolText(found).text).toContain("未找到相关记忆");
});

test("McpServerTest.test_reviewer_disabled_blocks_write_fail_closed", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig({ reviewer: { enabled: false } }));
  const res = await call(server, 1, "tools/call", { name: "add_memory", arguments: { text: "审查层没开时不该写进去" } });
  const out = toolText(res);
  expect(out.isError).toBe(true);
  expect(out.text).toContain("审查层未开启");
  // 读操作不受影响。
  const found = await call(server, 2, "tools/call", { name: "search_memory", arguments: { query: "对外 MCP 服务" } });
  expect(toolText(found).text).toContain("测试记忆甲");
});

test("McpServerTest.test_disabled_server_and_protocol_errors", async () => {
  const home = makeHome();
  const off = makeServer(home, serverConfig({ mcp_server: { enabled: false, allow_writes: false } }));
  const res = await off.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "owner");
  expect((res.body as Record<string, unknown>).error).toBeTruthy();
  const server = makeServer(home, serverConfig());
  const unknown = await call(server, 1, "nope/method");
  expect((unknown.error as Record<string, unknown>).code).toBe(-32601);
  const unknownTool = await call(server, 2, "tools/call", { name: "no_such_tool", arguments: {} });
  expect((unknownTool.error as Record<string, unknown>).code).toBe(-32602);
  const badParams = await call(server, 3, "tools/call", { name: "search_memory", arguments: {} });
  expect((badParams.error as Record<string, unknown>).code).toBe(-32602);
  // 通知（无 id）不执行、不回包。
  const notif = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, "owner");
  expect(notif.status).toBe(202);
  expect(notif.body).toBeNull();
});

test("McpServerTest.test_every_call_recorded_in_run_and_audit", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig());
  await call(server, 1, "initialize", { protocolVersion: "2026-07-28" });
  await call(server, 2, "tools/list");
  await call(server, 3, "tools/call", { name: "search_memory", arguments: { query: "对外 MCP 服务" } });
  await call(server, 4, "tools/call", { name: "add_memory", arguments: { text: "证据链测试条目" } });
  await call(server, 5, "tools/call", { name: "no_such_tool", arguments: {} });
  const events = readAllRunEvents(home).filter((e) => e.type === "mcp_server_call");
  expect(events.length).toBe(5);
  expect(events.map((e) => e.tool)).toEqual(["initialize", "tools/list", "search_memory", "add_memory", "tools/call"]);
  // 写操作那条记了审查结论；失败那条 ok=false。
  const addEvent = events.find((e) => e.tool === "add_memory")!;
  expect(addEvent.reviewer_decision).toBe("ALLOW");
  expect(addEvent.ok).toBe(true);
  const failEvent = events.find((e) => e.tool === "tools/call")!;
  expect(failEvent.ok).toBe(false);
  // 审查结论另有一条 reviewer_verdict 事件。
  const verdicts = readAllRunEvents(home).filter((e) => e.type === "reviewer_verdict");
  expect(verdicts.length).toBe(1);
  expect(verdicts[0].decision).toBe("ALLOW");
  // 审计文件同样 5 行，且不含原文参数（只有 args_hash 指纹）。
  const audit = readAudit(home);
  expect(audit.length).toBe(5);
  expect(audit.every((a) => typeof a.args_hash === "string" && a.args_hash.length === 64)).toBe(true);
  expect(JSON.stringify(audit)).not.toContain("证据链测试条目");
});

test("McpServerTest.test_gateway_auth_and_route", async () => {
  const home = makeHome();
  const gw = new Gateway({
    home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "full",
    config: serverConfig(),
    reviewerFactory: () => allowRunner as never,
  });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const rpc = (method: string, params?: Record<string, unknown>, id = 1) =>
      ({ jsonrpc: "2.0", id, method, params: params ?? {} });
    // 无 token 拒绝。
    const noToken = await fetch(`${base}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpc("initialize", { protocolVersion: "2026-07-28" })),
    });
    expect(noToken.status).toBe(403);
    // 错 token 拒绝。
    const wrongToken = await fetch(`${base}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Nyra-Token": "wrong" },
      body: JSON.stringify(rpc("initialize", { protocolVersion: "2026-07-28" })),
    });
    expect(wrongToken.status).toBe(403);
    // GET 只接受 POST。
    const get = await fetch(`${base}/mcp`, { headers: { "X-Nyra-Token": gw.token } });
    expect(get.status).toBe(405);
    // 正确 token 走通：initialize + 写记忆 + 再读出来。
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const initRes = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(rpc("initialize", { protocolVersion: "2026-07-28" })) });
    expect(initRes.status).toBe(200);
    const initBody = await initRes.json() as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("Nyra");
    const addRes = await fetch(`${base}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify(rpc("tools/call", { name: "add_memory", arguments: { text: "网关端写进来的条目" } }, 2)),
    });
    expect(addRes.status).toBe(200);
    const addBody = await addRes.json() as { result: { content: { text: string }[] } };
    expect(addBody.result.content[0].text).toContain("已记入长期记忆");
    const searchRes = await fetch(`${base}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify(rpc("tools/call", { name: "search_memory", arguments: { query: "网关端写进来" } }, 3)),
    });
    const searchBody = await searchRes.json() as { result: { content: { text: string }[] } };
    expect(searchBody.result.content[0].text).toContain("网关端写进来的条目");
    // 网关端调用也记进了运行记录与审计。
    const events = readAllRunEvents(home).filter((e) => e.type === "mcp_server_call");
    expect(events.some((e) => e.tool === "add_memory" && e.caller === "owner")).toBe(true);
    expect(readAudit(home).length).toBeGreaterThanOrEqual(3);
  } finally {
    await gw.stop();
  }
});

test("McpServerTest.test_gateway_disabled_returns_404", async () => {
  const home = makeHome();
  const gw = new Gateway({
    home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "full",
    config: serverConfig({ mcp_server: { enabled: false, allow_writes: false } }),
  });
  const info = await gw.start();
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: "POST",
      headers: { "X-Nyra-Token": gw.token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(404);
  } finally {
    await gw.stop();
  }
});

test("McpServerTest.test_audit_helper_writes_jsonl", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mcp-audit-"));
  appendMcpServerAudit(home, { tool: "(auth)", caller: "unknown", ok: false, error: "token 无效" });
  const lines = readAudit(home);
  expect(lines.length).toBe(1);
  expect(lines[0].tool).toBe("(auth)");
  expect(lines[0].ok).toBe(false);
  expect(typeof lines[0].at).toBe("string");
});

test("McpServerTest.test_http_client_talks_to_own_server", async () => {
  // 两半互通：Nyra 的 HTTP 客户端（MCPHttpClient）直连 Nyra 自己的对外服务。
  const { MCPHttpClient, MCPServerConfig } = await import("../../src/mcp.ts");
  const home = makeHome();
  const gw = new Gateway({
    home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "full",
    config: serverConfig(),
    reviewerFactory: () => allowRunner as never,
  });
  const info = await gw.start();
  try {
    const cfg = MCPServerConfig.fromDict("nyra-self", {
      transport: "http",
      url: `http://127.0.0.1:${info.port}/mcp`,
      headers: { "X-Nyra-Token": gw.token },
    });
    const client = new MCPHttpClient(cfg, 10);
    const tools = await client.listTools();
    expect(client.era).toBe("modern");
    expect(client.negotiatedVersion).toBe("2026-07-28");
    expect(tools.map((t) => t.name)).toEqual(["search_memory", "query_evidence", "answer_question", "add_memory", "forget_session", "dispatch_task"]);
    const found = await client.callTool("search_memory", { query: "对外 MCP 服务" });
    expect(found).toContain("测试记忆甲");
    const added = await client.callTool("add_memory", { text: "客户端直连写进来的条目" });
    expect(added).toContain("已记入长期记忆");
  } finally {
    await gw.stop();
  }
});

test("McpServerTest.test_discover_returns_supported_versions", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig());
  const res = await call(server, 1, "server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  const result = res.result as Record<string, unknown>;
  expect(result.supportedVersions).toEqual(["2026-07-28"]);
  expect((result.capabilities as Record<string, unknown>).tools).toEqual({});
  const meta = result._meta as Record<string, unknown>;
  expect((meta["io.modelcontextprotocol/serverInfo"] as Record<string, unknown>).name).toBe("Nyra");
  // 缓存提示是规范要求字段；工具列表随 allow_writes 开关变，ttlMs 取 0 = 立即过期。
  expect(result.ttlMs).toBe(0);
  expect(result.cacheScope).toBe("public");
});

test("McpServerTest.test_unsupported_protocol_version_rejected", async () => {
  const home = makeHome();
  const server = makeServer(home, serverConfig());
  const bad = await call(server, 1, "tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } });
  const err = bad.error as Record<string, unknown>;
  expect(err.code).toBe(-32022);
  expect(((err.data as Record<string, unknown>).supported as string[])).toContain("2026-07-28");
  // 带现代版的请求正常走；不带 _meta 的当旧客户端兼容。
  const ok = await call(server, 2, "tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
  expect(((ok.result as Record<string, unknown>).tools as { name: string }[]).length).toBe(6);
  const legacy = await call(server, 3, "tools/list");
  expect(((legacy.result as Record<string, unknown>).tools as { name: string }[]).length).toBe(6);
});
