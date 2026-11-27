// tests/node/test-mcp.test.ts — MCP 原生客户端专项（第 3 阶段）。
// 假 MCP 服务器（stdio JSON-RPC）：现代版 discover、旧版 initialize 回退、
// tools/list 分页、tools/call、多轮往返报错；预置清单；成本上限停手。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { writeFakeMcpServer as fakeServerPath } from "./fake-mcp-server.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MCPClient, MCPServerConfig, MCPToolManager, loadMcpServers,
  MCPError, sandboxedMcpSpawnArgs, mcpServerRoBinds, findOnPath,
} from "../../src/mcp.ts";
import { MCP_PRESETS, DEFAULT_MCP_PRESETS, getPreset, listPresets, resolvePreset } from "../../src/mcpPresets.ts";
import { McpCostTracker, estimateToolCost, costLimitUsd } from "../../src/mcpCost.ts";




test("McpPresetsTest.test_eleven_presets_and_defaults", () => {
  expect(Object.keys(MCP_PRESETS).length).toBe(11);
  expect(listPresets().length).toBe(11);
  expect([...DEFAULT_MCP_PRESETS]).toEqual(["memory", "sequential-thinking", "fetch", "time"]);
  expect(getPreset("memory")?.command).toBe("npx");
  expect(getPreset("nope")).toBe(null);
  const [raw, reason] = resolvePreset("github", {}, {});
  expect(raw).toBe(null);
  expect(reason).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  const [raw2] = resolvePreset("filesystem", { filesystem: ["/tmp/docs"] }, {});
  expect((raw2 as { args: string[] }).args).toContain("/tmp/docs");
  const [raw3, reason3] = resolvePreset("filesystem", {}, {});
  expect(raw3).toBe(null);
  expect(reason3).toContain("mcp_preset_args");
});

test("McpPresetsTest.test_local_stdio_presets_filesystem_fetch_memory", () => {
  // 三个本地 stdio 预置（Cue A 批 5.1）：memory 与 filesystem 走 npx，
  // fetch 只能走 uvx——官方没有出过这个服务器的 npm 包。
  const memory = getPreset("memory")!;
  expect(memory.command).toBe("npx");
  expect(memory.args).toContain("@modelcontextprotocol/server-memory");
  expect(memory.requires_env).toEqual([]);
  expect(memory.requires_args).toBe(false);
  const fetch = getPreset("fetch")!;
  expect(fetch.command).toBe("uvx");
  expect(fetch.args).toContain("mcp-server-fetch");
  expect(fetch.requires_env).toEqual([]);
  const fs = getPreset("filesystem")!;
  expect(fs.command).toBe("npx");
  expect(fs.args).toContain("@modelcontextprotocol/server-filesystem");
  expect(fs.requires_args).toBe(true);
  // memory 与 fetch 不用额外条件就能解析；filesystem 必须给目录。
  const [mRaw] = resolvePreset("memory", {}, {});
  expect((mRaw as { command: string }).command).toBe("npx");
  const [fRaw] = resolvePreset("fetch", {}, {});
  expect((fRaw as { command: string }).command).toBe("uvx");
  const [fsRaw] = resolvePreset("filesystem", { filesystem: ["/tmp/docs"] }, {});
  expect((fsRaw as { args: string[] }).args.slice(-1)).toEqual(["/tmp/docs"]);
});

test("McpPresetsTest.test_github_remote_http_preset_needs_pat", () => {
  // Cue A 批 5.5：GitHub 官方远程 MCP（只读）是 http 预置，不在默认里。
  const preset = getPreset("github-remote")!;
  expect(preset.transport).toBe("http");
  expect(preset.url).toBe("https://api.githubcopilot.com/mcp/readonly");
  expect(preset.requires_env).toEqual(["GITHUB_MCP_TOKEN"]);
  expect([...DEFAULT_MCP_PRESETS]).not.toContain("github-remote");
  // 没 PAT 就跳过，不编造。
  const [noRaw, noReason] = resolvePreset("github-remote", {}, {});
  expect(noRaw).toBe(null);
  expect(noReason).toContain("GITHUB_MCP_TOKEN");
  // 有 PAT 就解析成 http 配置：url 对、Authorization 带上 token。
  const [raw] = resolvePreset("github-remote", {}, { GITHUB_MCP_TOKEN: "ghp_testtoken123" });
  expect((raw as { transport: string }).transport).toBe("http");
  expect((raw as { url: string }).url).toBe("https://api.githubcopilot.com/mcp/readonly");
  const headers = (raw as { headers: Record<string, string> }).headers;
  expect(headers.Authorization).toBe("Bearer ghp_testtoken123");
  expect(JSON.stringify(raw)).not.toContain("${GITHUB_MCP_TOKEN}");
});

test("McpClientTest.test_modern_discover_and_paginated_tools", async () => {
  const server = fakeServerPath();
  const client = new MCPClient(new MCPServerConfig("fake", "node", [server]), 10);
  try {
    client.start();
    const tools = await client.listTools();
    expect(client.era).toBe("modern");
    expect(client.negotiatedVersion).toBe("2026-07-28");
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    const out = await client.callTool("echo", { x: 1 });
    expect(out).toContain("called echo");
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("McpClientTest.test_legacy_initialize_fallback", async () => {
  const server = fakeServerPath();
  // FAKE_MCP_MODE 经配置 env 显式声明进子进程——MCP 子进程走环境白名单，父进程环境不再透传。
  const client = new MCPClient(new MCPServerConfig("fake", "node", [server], { FAKE_MCP_MODE: "legacy" }), 10);
  try {
    client.start();
    const tools = await client.listTools();
    expect(client.era).toBe("legacy");
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("McpClientTest.test_input_required_reports_clearly", async () => {
  // 注意：这里故意不用 await expect(...).rejects.toThrow(...)。
  // Bun 1.4.x 在 Windows 上有个 bug（oven-sh/bun#44429，同类 #44025）：
  // 测试通过 expect().rejects/.resolves 等待一个 promise 时，若前后
  // 两次管道/套接字回复几乎同时到达，后一次回复的 data 事件会丢
  // 失（字节已到本机、监听器收不到），请求随之超时。本测试正好
  // 满足该条件：tools/list 第二页的回复与 need-more 的回复在同一
  // 毫秒到达；改用普通 await + try/catch 后触发条件消失。生产代
  // 码从不用 expect().rejects，因此不受影响。
  // 客户端请求超时是 10 秒；零字节丢失时会再重试一次（最长又 10 秒），
  // 测试超时放宽到 25 秒，让客户端自己的报错先出来，不要只剩光秃秃
  // 的测试超时。
  const server = fakeServerPath();
  const client = new MCPClient(new MCPServerConfig("fake", "node", [server]), 10);
  try {
    client.start();
    await client.listTools();
    let thrown: unknown = null;
    try {
      await client.callTool("need-more", {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("多轮往返");
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
}, 25000);

test("McpManagerTest.test_start_all_routes_and_execute", async () => {
  const server = fakeServerPath();
  const manager = new MCPToolManager({
    fake: MCPServerConfig.fromDict("fake", { command: "node", args: [server] }),
  }, 10);
  try {
    await manager.startAll();
    expect(manager.hasTools()).toBe(true);
    expect(manager.toolSchemas.map((s) => s.function.name)).toEqual(["mcp_fake_echo", "mcp_fake_add"]);
    const out = await manager.execute("mcp_fake_add", { a: 1, b: 2 });
    expect(out).toContain("called add");
    expect(await manager.execute("mcp_fake_nope", {})).toContain("未知 MCP 工具");
  } finally {
    manager.stopAll();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("McpCostTest.test_estimate_limit_and_block", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mcp-cost-"));
  const tracker = new McpCostTracker(home);
  const config = {
    mcp_cost_limit_usd: 0.05,
    mcp_tool_costs: { "fake.echo": 0.02 },
    mcp_servers: { fake: { command: "node", args: [], cost_per_call_usd: 0.03 } },
  };
  const est = estimateToolCost(config, "fake", "echo");
  expect(est.estimate_usd).toBe(0.02);
  expect(est.priced).toBe(true);
  const unpriced = estimateToolCost(config, "other", "x");
  expect(unpriced.priced).toBe(false);
  expect(unpriced.estimate_usd).toBe(0);
  expect(costLimitUsd(config)).toBe(0.05);
  expect(costLimitUsd({})).toBe(null);
  // 调用前检查：两次 0.02 可过，第三次超上限停手。
  expect(tracker.checkBeforeCall(config, "fake", "echo").blocked).toBe(null);
  tracker.record("fake", "echo", 0.02, "called");
  tracker.record("fake", "echo", 0.02, "called");
  expect(tracker.totalUsd()).toBeCloseTo(0.04, 10);
  const blocked = tracker.checkBeforeCall(config, "fake", "echo");
  expect(blocked.blocked).toContain("成本上限已到");
  expect(tracker.estimateLine(config, "fake", "echo")).toContain("预估 $0.0200");
});

test("McpServersTest.test_load_servers_presets_then_user_wins", () => {
  const servers = loadMcpServers({ mcp_presets: ["memory"], mcp_servers: { memory: { command: "node", args: ["x"] } } });
  expect(servers.memory.command).toBe("node");
  const defaults = loadMcpServers({});
  expect(Object.keys(defaults).sort()).toEqual(["fetch", "memory", "sequential-thinking", "time"]);
  const none = loadMcpServers({ mcp_presets: [] });
  expect(Object.keys(none)).toEqual([]);
});

// ---- MCP 沙箱（0.5.2 缺口收尾） ----------------------------------------

const SANDBOX_ENV_KEYS = [
  "NYRA_SANDBOX", "ANGEL_SANDBOX", "NYRA_SANDBOX_MODE", "ANGEL_SANDBOX_MODE",
  "NYRA_SANDBOX_ALLOW_NET", "ANGEL_SANDBOX_ALLOW_NET",
  // G-P1-39：e2b 解析认 E2B_API_KEY，环境清理须一并清掉它，否则 startAll
  // 的“不可用后端”用例在配了 key 的机器上会解析成功。
  "E2B_API_KEY",
] as const;

/** 沙箱环境变量临时清空，用完原样恢复（resolveSandboxBackend 优先读 env）。 */
async function withCleanSandboxEnv(fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of SANDBOX_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try { await fn(); } finally {
    for (const k of SANDBOX_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test("McpSandbox.test_local_passthrough", () => {
  const server = fakeServerPath();
  const [cmd, args] = sandboxedMcpSpawnArgs(
    new MCPServerConfig("fake", "node", [server]),
    { backend: "local", mode: "workspace-write", allowNet: false },
    "/tmp/wd",
  );
  expect(cmd).toBe("node");
  expect(args).toEqual([server]);
});

test("McpSandbox.test_bwrap_argv_binds_server_dir_ro", () => {
  const server = fakeServerPath();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-mcp-wd-"));
  const [cmd, args] = sandboxedMcpSpawnArgs(
    new MCPServerConfig("fake", "node", [server, "--flag"]),
    { backend: "bwrap", mode: "workspace-write", allowNet: false },
    workdir,
  );
  expect(cmd).toBe("bwrap");
  expect(args).toContain("--unshare-net");
  expect(args).toContain("--die-with-parent");
  // 服务器文件所在目录只读追加绑定（工作区外，不绑就读不到）。
  expect(args).toContain(dirname(server));
  expect(args).toContain("--bind");
  expect(args).toContain(workdir);
  // 末尾是原命令，不经过 /bin/sh -c（长驻 stdio 进程）。
  const tail = args.slice(args.indexOf("--") + 1);
  expect(tail).toEqual(["node", server, "--flag"]);
  expect(args).not.toContain("-c");
});

test("McpSandbox.test_seatbelt_argv", () => {
  const workdir = mkdtempSync(join(tmpdir(), "nyra-mcp-wd-"));
  const [cmd, args] = sandboxedMcpSpawnArgs(
    new MCPServerConfig("fake", "node", ["/tmp/fake.mjs"]),
    { backend: "seatbelt", mode: "workspace-write", allowNet: false },
    workdir,
  );
  expect(cmd).toBe("sandbox-exec");
  expect(args[0]).toBe("-p");
  // profile 里的路径是 SBPL 转义过的：Windows 上反斜杠会翻倍，断言要按
  // 转义后的形式比，否则 raw workdir 在 profile 里永远找不到（Node CI #113）。
  const expectedInProfile = process.platform === "win32" ? workdir.replace(/\\/g, "\\\\") : workdir;
  expect(args[1]).toContain(expectedInProfile);
  expect(args.slice(2)).toEqual(["node", "/tmp/fake.mjs"]);
});

test("McpSandbox.test_jobobject_e2b_unknown_refused", () => {
  const cfg = new MCPServerConfig("fake", "node", ["/tmp/fake.mjs"]);
  const wd = "/tmp/wd";
  expect(() => sandboxedMcpSpawnArgs(cfg, { backend: "jobobject", mode: "workspace-write", allowNet: false }, wd)).toThrow(MCPError);
  expect(() => sandboxedMcpSpawnArgs(cfg, { backend: "e2b", mode: "workspace-write", allowNet: false }, wd)).toThrow(MCPError);
  expect(() => sandboxedMcpSpawnArgs(cfg, { backend: "nope", mode: "workspace-write", allowNet: false }, wd)).toThrow(MCPError);
});

test("McpSandbox.test_bwrap_danger_mode_refused", () => {
  const cfg = new MCPServerConfig("fake", "node", ["/tmp/fake.mjs"]);
  expect(() => sandboxedMcpSpawnArgs(cfg, { backend: "bwrap", mode: "danger-full-access", allowNet: false }, "/tmp/wd")).toThrow("danger-full-access");
});

test("McpSandbox.test_ro_binds_skip_workdir_and_system_dirs", () => {
  const workdir = mkdtempSync(join(tmpdir(), "nyra-mcp-wd-"));
  const server = fakeServerPath();
  const binds = mcpServerRoBinds(
    new MCPServerConfig("fake", "node", [server, join(workdir, "data.json")]),
    workdir,
  );
  // 服务器文件目录在内；工作区内参数不在内；系统目录不重复加。
  expect(binds).toContain(dirname(server));
  expect(binds).not.toContain(workdir);
  expect(mcpServerRoBinds(new MCPServerConfig("fake", "node", []), workdir)).not.toContain("/usr/bin");
});

test("McpSandbox.test_find_on_path", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-mcp-path-"));
  const fakeBin = join(dir, "mycmd");
  writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", "utf-8");
  expect(findOnPath("mycmd", dir)).toBe(fakeBin);
  expect(findOnPath("mycmd", "/nonexistent")).toBeNull();
  expect(findOnPath("node")).not.toBeNull();
  // 绝对路径直通：/bin/sh 只在 POSIX 上存在；Windows 上用本机可执行文件
  // 断言同款行为（Node CI #113：Windows 上 /bin/sh 不存在，返回 null 是对的）。
  if (process.platform === "win32") {
    expect(findOnPath(process.execPath)).toBe(process.execPath);
  } else {
    expect(findOnPath("/bin/sh")).toBe("/bin/sh");
  }
});

test("McpSandbox.test_manager_start_all_refuses_unavailable_backend", async () => {
  await withCleanSandboxEnv(async () => {
    const server = fakeServerPath();
    // 后端用 e2b：它在所有平台上都解析失败（没配 E2B_API_KEY 时；G-P1-39 起
    // 有 key 才解析成功，控制面与执行仍是两回事），是唯一全平台
    // 都不可用的后端。不能用 seatbelt 充当“不可用后端”——macOS 上 sandbox-exec
    // 真实存在，解析会成功，startAll 就不会拒绝（Node CI #119 macOS 失败根因）。
    const manager = new MCPToolManager(
      { fake: new MCPServerConfig("fake", "node", [server]) },
      10,
      { sandbox: { backend: "e2b", mode: "workspace-write", allowNet: false }, workdir: "/tmp" },
    );
    let caught: unknown = null;
    try { await manager.startAll(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MCPError);
    // 一个服务器都没启动，不存在裸奔的进程。
    expect(manager.clients).toEqual({});
    expect(manager.toolSchemas).toEqual([]);
  });
});

test("McpSandbox.test_manager_start_all_local_runs_fake_server", async () => {
  await withCleanSandboxEnv(async () => {
    const server = fakeServerPath();
    const manager = new MCPToolManager(
      { fake: new MCPServerConfig("fake", "node", [server]) },
      10,
      { sandbox: { backend: "local", mode: "workspace-write", allowNet: false }, workdir: "/tmp" },
    );
    try {
      await manager.startAll();
      expect(manager.hasTools()).toBe(true);
      expect(manager.toolSchemas.map((s) => s.function.name)).toContain("mcp_fake_echo");
    } finally {
      manager.stopAll();
      await new Promise((r) => setTimeout(r, 300));
    }
  });
});

test("McpSandbox.test_client_start_refuses_jobobject", () => {
  const server = fakeServerPath();
  const client = new MCPClient(
    new MCPServerConfig("fake", "node", [server]), 10,
    { backend: "jobobject", mode: "workspace-write", allowNet: false, workdir: "/tmp" },
  );
  expect(() => client.start()).toThrow(MCPError);
  expect(client.process).toBeNull();
});
