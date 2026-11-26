// tests/node/test-sandbox-os-backends.test.ts — macOS seatbelt / Windows jobobject 端到端可用。
//
// 回归：config.ts 以前另维护一份 VALID_SANDBOXES（只有 auto/local/bwrap/e2b），
// CLI buildAgent 与网关都先过它，`--sandbox seatbelt`、`--sandbox jobobject`、
// config.json 写 "sandbox":"seatbelt" 全部报“Invalid sandbox backend”，
// 而 doctor 还在教用户这么用。现在 config.ts 复用 sandbox.ts 的 SANDBOX_BACKENDS。
//
// 三层：config 解析（纯函数）、网关（同进程 + 探测覆盖模拟平台）、
// 真 CLI 子进程（在 CI 的三个平台上各自验证本平台的真实结果）。
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VALID_SANDBOXES, resolveSandbox } from "../../src/config.ts";
import { SANDBOX_BACKENDS, resolveSandboxBackend, setSandboxProbeForTests } from "../../src/sandbox.ts";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const SANDBOX_ENV_KEYS = ["NYRA_SANDBOX", "ANGEL_SANDBOX", "NYRA_SANDBOX_MODE", "ANGEL_SANDBOX_MODE"];

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withCleanSandboxEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of SANDBOX_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

afterEach(() => setSandboxProbeForTests(undefined));

test("config 的后端表就是 sandbox.ts 那一份（不再两处维护）", () => {
  expect(VALID_SANDBOXES).toBe(SANDBOX_BACKENDS);
  expect([...VALID_SANDBOXES]).toContain("seatbelt");
  expect([...VALID_SANDBOXES]).toContain("jobobject");
});

test("resolveSandbox：CLI 参数与 config.json 都接受 seatbelt / jobobject", () => {
  withCleanSandboxEnv(() => {
    expect(resolveSandbox({}, "seatbelt").backend).toBe("seatbelt");
    expect(resolveSandbox({}, "jobobject").backend).toBe("jobobject");
    expect(resolveSandbox({ sandbox: "seatbelt" }).backend).toBe("seatbelt");
    expect(resolveSandbox({ sandbox: "jobobject" }).backend).toBe("jobobject");
    expect(() => resolveSandbox({}, "bogus")).toThrow("Invalid sandbox backend: bogus");
  });
});

test("resolveSandboxBackend：探测覆盖模拟 macOS / Windows 时解析到 OS 沙箱", () => {
  withCleanSandboxEnv(() => {
    setSandboxProbeForTests({ platform: "darwin", seatbeltAvailable: true, bwrapAvailable: false, jobObjectAvailable: false });
    expect(resolveSandboxBackend({}, "seatbelt").level).toBe("seatbelt");
    setSandboxProbeForTests({ platform: "win32", seatbeltAvailable: false, bwrapAvailable: false, jobObjectAvailable: true });
    expect(resolveSandboxBackend({ sandbox: "jobobject" }).level).toBe("jobobject");
  });
});

test("网关：config 写 sandbox=seatbelt（模拟 macOS）能启动并跑完一轮", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of SANDBOX_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    setSandboxProbeForTests({ platform: "darwin", seatbeltAvailable: true, bwrapAvailable: false, jobObjectAvailable: false });
    const gw = new Gateway({
      home: tmpDir("nyra-sbos-home-"), workdir: tmpDir("nyra-sbos-wd-"), mode: "auto",
      providerFactory: () => fakeProvider([{ content: "好的。" }]),
      config: { mcp_enabled: false, fallback_enabled: false, sandbox: "seatbelt" },
    });
    const run = gw.send(gw.newSession(), "打个招呼");
    const start = Date.now();
    while (run.status !== "done" && run.status !== "error" && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run.error ?? "").not.toContain("Invalid sandbox backend");
    expect(run.status).toBe("done");
    expect(run.agent!.ctx.sandbox).toEqual({ backend: "seatbelt", mode: "workspace-write", allowNet: false });
    await gw.stop();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("网关：config 写 sandbox=jobobject（模拟 Windows）能启动", () => {
  withCleanSandboxEnv(() => {
    setSandboxProbeForTests({ platform: "win32", seatbeltAvailable: false, bwrapAvailable: false, jobObjectAvailable: true });
    const gw = new Gateway({
      home: tmpDir("nyra-sbos-home-"), workdir: tmpDir("nyra-sbos-wd-"), mode: "auto",
      providerFactory: () => fakeProvider([{ content: "好的。" }]),
      config: { mcp_enabled: false, fallback_enabled: false, sandbox: "jobobject" },
    });
    expect(gw).toBeTruthy();
    void gw.stop();
  });
});

/** 真 CLI 子进程：`--compact 不存在的会话` 会完整走一遍 buildAgent（含两道沙箱解析）但不调模型。 */
async function runCompact(sandbox: string): Promise<{ code: number; stderr: string }> {
  const home = tmpDir("nyra-sbos-cli-");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0", DEEPSEEK_API_KEY: "sk-test-not-real" };
  for (const k of SANDBOX_ENV_KEYS) delete env[k];
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "--sandbox", sandbox, "--compact", "no-such-session", "--workdir", tmpDir("nyra-sbos-wd-")],
    env, stdout: "pipe", stderr: "pipe",
  });
  const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stderr };
}

for (const backend of ["seatbelt", "jobobject"]) {
  test(`CLI --sandbox ${backend}：不再报无效后端；本平台支持时走到 buildAgent 之后`, async () => {
    const { stderr } = await runCompact(backend);
    expect(stderr).not.toContain("Invalid sandbox backend");
    const native = (backend === "seatbelt" && process.platform === "darwin") || (backend === "jobobject" && process.platform === "win32");
    if (native) {
      // 平台支持：沙箱解析通过，buildAgent 建好 agent，卡在“会话不存在”。
      // （Windows 上 Job Object 探测失败时会给出清楚的不可用提示，也不算无效后端。）
      expect(stderr.includes("no-such-session") || stderr.includes("不可用")).toBe(true);
    } else {
      // 别的平台：给出“只支持 macOS / Windows”的明确提示，而不是“无效后端”。
      expect(stderr).toMatch(/只支持 (macOS|Windows)/);
    }
  }, 60000);
}
