// tests/node/test-mcp-http.test.ts — 缺口 17：MCP Streamable HTTP 客户端。
// 对照 stdio 客户端（test-mcp.test.ts）：同款协商（discover 探现代版，
// 失败回退旧版 initialize）、同款工具列表分页、同款 tools/call 文本拼法；
// 区别只在传输：POST JSON-RPC，响应 JSON 或 SSE。
// 无状态（2026-07-28）：不存、不发 Mcp-Session-Id，每请求带 MCP-Protocol-Version 头。
import { test, expect } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MCPHttpClient, MCPServerConfig, MCPToolManager, MCPError, MCPRequestError } from "../../src/mcp.ts";

type FakeMode = "modern" | "legacy" | "sse" | "slow" | "sessionful";

interface FakeHttp {
  url: string;
  close: () => void;
  seenSessionIds: string[];
  seenProtocolVersions: string[];
}

function rpcReply(body: Record<string, unknown>, mode: FakeMode): Record<string, unknown> {
  const id = body.id;
  const method = body.method;
  const params = (body.params ?? {}) as Record<string, unknown>;
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "server/discover") {
    if (mode === "legacy") return err(-32601, "Method not found");
    return {
      jsonrpc: "2.0", id,
      result: { supportedVersions: ["2026-07-28"], _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-http-modern", version: "1" } } },
    };
  }
  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake-http-legacy", version: "1" } },
    };
  }
  if (method === "tools/list") {
    const cursor = params.cursor;
    if (!cursor) {
      return {
        jsonrpc: "2.0", id,
        result: { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } }], nextCursor: "page2" },
      };
    }
    return {
      jsonrpc: "2.0", id,
      result: { tools: [{ name: "add", description: "加法", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] },
    };
  }
  if (method === "tools/call") {
    const name = params.name;
    if (name === "need-more") {
      return { jsonrpc: "2.0", id, result: { resultType: "input_required", inputRequests: { extra: "需要补充" } } };
    }
    return {
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: "called " + name + " " + JSON.stringify((params.arguments as Record<string, unknown>) || {}) }] },
    };
  }
  return err(-32601, "Method not found");
}

function startFakeHttpMcp(mode: FakeMode, opts: { status?: number } = {}): Promise<FakeHttp> {
  const seenSessionIds: string[] = [];
  const seenProtocolVersions: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") seenSessionIds.push(sid);
      const pv = req.headers["mcp-protocol-version"];
      if (typeof pv === "string") seenProtocolVersions.push(pv);
      if (opts.status) {
        res.writeHead(opts.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const respond = () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* 空体按通知处理 */ }
        const reply = rpcReply(parsed, mode);
        // sessionful 模式：老式有状态服务器每回都给 Mcp-Session-Id，
        // 2026-07-28 客户端必须忽略它（无状态，不存、不发）。
        const headers: Record<string, string> = {};
        if (mode === "sessionful") headers["Mcp-Session-Id"] = "sess-1";
        if (mode === "sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
          res.end("data: " + JSON.stringify(reply) + "\n\n");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(reply));
      };
      if (mode === "slow") setTimeout(respond, 2000);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/mcp`, close: () => server.close(), seenSessionIds, seenProtocolVersions });
    });
  });
}

function httpConfig(url: string, timeout?: number): MCPHttpClient {
  const cfg = MCPServerConfig.fromDict("fake", { transport: "http", url });
  return new MCPHttpClient(cfg, timeout ?? 10);
}

test("McpHttpTest.test_modern_discover_list_and_call", async () => {
  const fake = await startFakeHttpMcp("modern");
  try {
    const client = httpConfig(fake.url);
    const tools = await client.listTools();
    expect(client.era).toBe("modern");
    expect(client.negotiatedVersion).toBe("2026-07-28");
    expect(client.serverInfo?.name).toBe("fake-http-modern");
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    const out = await client.callTool("echo", { x: 1 });
    expect(out).toContain("called echo");
    expect(out).toContain('"x":1');
    // 无状态：每个请求都带 MCP-Protocol-Version 头，从不发 Mcp-Session-Id。
    expect(fake.seenSessionIds).toEqual([]);
    expect(fake.seenProtocolVersions.length).toBeGreaterThan(0);
    expect(fake.seenProtocolVersions.every((v) => v === "2026-07-28")).toBe(true);
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_stateful_server_session_id_ignored", async () => {
  const fake = await startFakeHttpMcp("sessionful");
  try {
    const client = httpConfig(fake.url);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    await client.callTool("echo", {});
    // 老式有状态服务器每回都给 Mcp-Session-Id，客户端一律忽略、不回发。
    expect(fake.seenSessionIds).toEqual([]);
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_legacy_fallback_when_discover_missing", async () => {
  const fake = await startFakeHttpMcp("legacy");
  try {
    const client = httpConfig(fake.url);
    const tools = await client.listTools();
    expect(client.era).toBe("legacy");
    expect(client.negotiatedVersion).toBe("2025-11-25");
    expect(client.serverInfo?.name).toBe("fake-http-legacy");
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_sse_response_parsed", async () => {
  const fake = await startFakeHttpMcp("sse");
  try {
    const client = httpConfig(fake.url);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    const out = await client.callTool("add", { a: 1, b: 2 });
    expect(out).toContain("called add");
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_input_required_throws", async () => {
  const fake = await startFakeHttpMcp("modern");
  try {
    const client = httpConfig(fake.url);
    let caught: unknown = null;
    try { await client.callTool("need-more", {}); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as Error).message).toContain("补充输入");
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_http_error_status_surfaces_code", async () => {
  const fake = await startFakeHttpMcp("modern", { status: 404 });
  try {
    const client = httpConfig(fake.url);
    let caught: unknown = null;
    try { await client.listTools(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MCPRequestError);
    expect((caught as MCPRequestError).code).toBe(404);
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_timeout_aborts", async () => {
  const fake = await startFakeHttpMcp("slow");
  try {
    const client = httpConfig(fake.url, 0.3);
    let caught: unknown = null;
    try { await client.listTools(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as Error).message).toContain("超时");
  } finally {
    fake.close();
  }
});

test("McpHttpTest.test_from_dict_validates_http_config", () => {
  expect(() => MCPServerConfig.fromDict("x", { transport: "http" })).toThrow("url");
  expect(() => MCPServerConfig.fromDict("x", { transport: "http", url: "ftp://example.com/mcp" })).toThrow("http");
  expect(() => MCPServerConfig.fromDict("x", { transport: "bogus", command: "node" })).toThrow("transport");
  expect(() => MCPServerConfig.fromDict("x", { command: "" })).toThrow("command");
  const ok = MCPServerConfig.fromDict("x", { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } });
  expect(ok.transport).toBe("http");
  expect(ok.url).toBe("https://example.com/mcp");
  expect(ok.headers).toEqual({ Authorization: "Bearer t" });
  // stdio 仍是默认传输。
  const stdio = MCPServerConfig.fromDict("y", { command: "node", args: ["a.js"] });
  expect(stdio.transport).toBe("stdio");
});

test("McpHttpTest.test_manager_routes_http_server", async () => {
  const fake = await startFakeHttpMcp("modern");
  try {
    const servers = { fake: MCPServerConfig.fromDict("fake", { transport: "http", url: fake.url }) };
    const manager = new MCPToolManager(servers, 10);
    await manager.startAll();
    try {
      expect(manager.hasTools()).toBe(true);
      expect(manager.toolSchemas.map((s) => s.function.name)).toEqual(["mcp_fake_echo", "mcp_fake_add"]);
      const out = await manager.execute("mcp_fake_echo", { x: 2 });
      expect(out).toContain("called echo");
    } finally {
      manager.stopAll();
    }
  } finally {
    fake.close();
  }
});
