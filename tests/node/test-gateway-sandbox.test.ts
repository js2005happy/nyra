// tests/node/test-gateway-sandbox.test.ts — 网关沙箱接线（调研报告第 9 项）。
// Gateway.send() / 定时任务建 Agent 时按 config + NYRA_SANDBOX 环境变量解析沙箱，
// 与 CLI buildAgent 同语义：auto 回落工具级、显式 bwrap 缺失 fail-closed、默认断网。
// bwrap 相关场景一律用 PATH 受控的假 bwrap shim，禁止依赖本机真有 bwrap。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";
import { seatbeltAvailable } from "../../src/seatbelt.ts";

const SANDBOX_ENV_KEYS = [
  "NYRA_SANDBOX", "ANGEL_SANDBOX", "NYRA_SANDBOX_MODE", "ANGEL_SANDBOX_MODE",
  "NYRA_SANDBOX_ALLOW_NET", "ANGEL_SANDBOX_ALLOW_NET",
] as const;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 临时改环境变量（含 PATH），用完原样恢复。 */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function cleanSandboxEnv(): Record<string, undefined> {
  return Object.fromEntries(SANDBOX_ENV_KEYS.map((k) => [k, undefined])) as Record<string, undefined>;
}

/** PATH 里放一个假 bwrap：记录参数到烘进脚本的日志路径，再把最后一个参数当 shell 命令跑。
    日志路径写死在脚本里——bwrap 子进程走环境白名单 + --clearenv，父进程的 BWRAP_LOG 不再透传。 */
function makeBwrapShim(): { dir: string; log: string } {
  const dir = tmpDir("nyra-bwrap-shim-");
  const log = join(dir, "bwrap-args.log");
  writeFileSync(join(dir, "bwrap"), `#!/bin/sh
echo "$@" >> "${log}"
for last; do :; done
sh -c "$last"
`, "utf-8");
  chmodSync(join(dir, "bwrap"), 0o755);
  return { dir, log };
}

async function waitRunDone(run: { status: string }, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (run.status === "done" || run.status === "error") return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待会话结束超时（当前状态 ${run.status}）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 一轮 shell 工具调用后回一句话的假 provider。 */
function shellProvider(command: string) {
  return fakeProvider([
    {
      content: "",
      toolCalls: [{ id: "call-1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command, timeout: 10 }) } }],
    },
    { content: "完成。" },
  ]);
}

function makeGateway(home: string, workdir: string, config: Record<string, unknown>, provider: ReturnType<typeof fakeProvider>) {
  return new Gateway({
    home, workdir, mode: "full",
    providerFactory: () => provider,
    config: { mcp_enabled: false, fallback_enabled: false, ...config },
  });
}

test("网关沙箱：auto 无 bwrap 时回落工具级（macOS 有 sandbox-exec 时进 Seatbelt），会话正常跑完、命令照常执行、提示只给一次", async () => {
  const home = tmpDir("nyra-gw-sandbox-home-");
  const workdir = tmpDir("nyra-gw-sandbox-wd-");
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, async () => {
    const provider = shellProvider("echo gw-auto-fallback");
    const gw = makeGateway(home, workdir, { sandbox: "auto" }, provider);
    const run = gw.send(gw.newSession(), "跑一下 shell");
    await waitRunDone(run);
    expect(run.status).toBe("done");
    expect(run.error).toBe("");
    // shell 输出回到模型消息里，证明命令真跑了（不是被沙箱配置拦下）。
    expect(JSON.stringify(run.agent!.messages)).toContain("gw-auto-fallback");
    // 回落提示只给一次：ToolContext 上的标记已被置位。
    // macOS 上 auto 会进 Seatbelt（sandbox-exec 系统自带），不回落工具级、
    // 不给回落提示——这是隔离补强批的新行为；会话照常跑完、命令照常执行才是要断言的。
    if (process.platform === "darwin" && seatbeltAvailable()) {
      expect(run.agent!.ctx.sandboxFallbackWarned).toBeFalsy();
    } else {
      expect(run.agent!.ctx.sandboxFallbackWarned).toBe(true);
    }
    // 接线用的是解析出的配置本身（backend auto、默认断网）。
    expect(run.agent!.ctx.sandbox).toEqual({ backend: "auto", mode: "workspace-write", allowNet: false });
    await gw.stop();
  });
});

test("网关沙箱：显式 bwrap 但无 bwrap 时会话启动失败、模型一次都不跑、文件不建", async () => {
  const home = tmpDir("nyra-gw-sandbox-home-");
  const workdir = tmpDir("nyra-gw-sandbox-wd-");
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, async () => {
    const provider = shellProvider("touch should-not-exist.txt");
    const gw = makeGateway(home, workdir, { sandbox: "bwrap" }, provider);
    const run = gw.send(gw.newSession(), "跑一下 shell");
    expect(run.status).toBe("error");
    if (process.platform === "linux") expect(run.error).toMatch("bubblewrap");
    else expect(run.error).toMatch("只支持 Linux");
    expect(provider.calls).toBe(0);
    expect(existsSync(join(workdir, "should-not-exist.txt"))).toBe(false);
    await gw.stop();
  });
});

test("网关沙箱：默认断网；config 与环境变量都能放开网络", async () => {
  const home = tmpDir("nyra-gw-sandbox-home-");
  const workdir = tmpDir("nyra-gw-sandbox-wd-");
  await withEnv(cleanSandboxEnv(), async () => {
    // 默认：allowNet 为 false。
    const provider = shellProvider("echo net-default");
    const gw = makeGateway(home, workdir, {}, provider);
    const run = gw.send(gw.newSession(), "跑一下");
    await waitRunDone(run);
    expect(run.status).toBe("done");
    expect(run.agent!.ctx.sandbox?.allowNet).toBe(false);
    expect(run.agent!.ctx.sandbox?.backend).toBe("auto");
    await gw.stop();
    // config 放开：sandbox_allow_net=true。
    const provider2 = shellProvider("echo net-config");
    const gw2 = makeGateway(home, workdir, { sandbox_allow_net: true }, provider2);
    const run2 = gw2.send(gw2.newSession(), "跑一下");
    await waitRunDone(run2);
    expect(run2.status).toBe("done");
    expect(run2.agent!.ctx.sandbox?.allowNet).toBe(true);
    await gw2.stop();
    // 环境变量放开：NYRA_SANDBOX_ALLOW_NET=1（优先级高于 config）。
    await withEnv({ NYRA_SANDBOX_ALLOW_NET: "1" }, async () => {
      const provider3 = shellProvider("echo net-env");
      const gw3 = makeGateway(home, workdir, { sandbox_allow_net: false }, provider3);
      const run3 = gw3.send(gw3.newSession(), "跑一下");
      await waitRunDone(run3);
      expect(run3.status).toBe("done");
      expect(run3.agent!.ctx.sandbox?.allowNet).toBe(true);
      await gw3.stop();
    });
  });
  // Node CI #73：Windows 运行器上该用例 5187ms 超时（Bun 默认 5 秒），
  // 与 rewind 用例同因——运行器偏慢，非逻辑问题，单用例放宽到 15 秒。
}, 15000);

test("网关沙箱：danger-full-access 与显式 bwrap 互斥，会话启动失败", async () => {
  const home = tmpDir("nyra-gw-sandbox-home-");
  const workdir = tmpDir("nyra-gw-sandbox-wd-");
  await withEnv(cleanSandboxEnv(), async () => {
    const provider = shellProvider("echo nope");
    const gw = makeGateway(home, workdir, { sandbox: "bwrap", sandbox_mode: "danger-full-access" }, provider);
    const run = gw.send(gw.newSession(), "跑一下");
    expect(run.status).toBe("error");
    expect(run.error).toMatch("danger-full-access 与沙箱互斥");
    expect(provider.calls).toBe(0);
    await gw.stop();
  });
});

test("网关沙箱：bwrap + 假 shim 时命令经 bwrap 跑通，参数含工作目录绑定与默认断网", async () => {
  if (process.platform !== "linux") { console.log("跳过：bwrap 只在 Linux，假 shim 依赖 /bin/sh"); return; }
  const home = tmpDir("nyra-gw-sandbox-home-");
  const workdir = tmpDir("nyra-gw-sandbox-wd-");
  const { dir, log } = makeBwrapShim();
  await withEnv({ ...cleanSandboxEnv(), PATH: `${dir}:${process.env.PATH ?? ""}` }, async () => {
    const provider = shellProvider("echo via-shim-gw");
    const gw = makeGateway(home, workdir, { sandbox: "bwrap" }, provider);
    const run = gw.send(gw.newSession(), "跑一下");
    await waitRunDone(run);
    expect(run.status).toBe("done");
    expect(JSON.stringify(run.agent!.messages)).toContain("via-shim-gw");
    const recorded = readFileSync(log, "utf-8");
    expect(recorded).toContain("--bind");
    expect(recorded).toContain(workdir);
    expect(recorded).toContain("--unshare-net");
    await gw.stop();
  });
});
