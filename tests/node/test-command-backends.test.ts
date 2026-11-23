// tests/node/test-command-backends.test.ts — G-P1-39：命令后端可换。
// 注册表 + 配置 + 探测 + Docker/SSH 执行器 + E2B 控制面 + CLI + toolShell 分发。
// 全用临时 home 与注入 runner/fetch，不调真 docker、不拨真 ssh、不拿真 Key 调真 API。
import { test, expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  BUILTIN_COMMAND_BACKENDS, E2bExecutionUnsupportedError, E2bNotConfiguredError,
  buildDockerArgv, buildSshArgv, defaultCommandBackendConfig,
  detectDockerBinary, e2bCreateSandbox, e2bGetSandbox, e2bKillSandbox, e2bListSandboxes,
  getCommandBackend, isKnownCommandBackend, listCommandBackends,
  loadCommandBackendConfig, probeAllBackends, probeBackend,
  registerCommandBackend, resolveActiveBackend, resolveE2bSettings,
  runBackendCommand, runDockerCommand, runSshCommand, saveCommandBackendConfig,
  setActiveBackend, shellQuote, unregisterCommandBackend,
  type FetchFn, type ProcessRunner, type RunProcessResult,
} from "../../src/commandBackends.ts";
import { handleBackend } from "../../src/commandBackendCli.ts";
import { resolveSandboxBackend } from "../../src/sandbox.ts";
import { newToolContext, executeTool } from "../../src/tools.ts";

function tmpHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(home, { recursive: true });
  return home;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return {
    logs,
    restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; },
  };
}

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

/** 记录 argv、回 canned 输出的假 runner。 */
function fakeRunner(seen: string[][], out: RunProcessResult): ProcessRunner {
  return async (argv) => { seen.push([...argv]); return { ...out }; };
}

/** 记录 fetch 请求、回 canned JSON 的假 fetch。 */
function fakeFetch(seen: Array<{ url: string; init: Record<string, unknown> }>, status: number, body: string): FetchFn {
  return async (url, init) => {
    seen.push({ url, init });
    return { status, text: async () => body };
  };
}

// ---- 注册表 ----

test("注册表：内置 7 个后端，local 在首位", () => {
  expect(BUILTIN_COMMAND_BACKENDS.map((b) => b.id)).toEqual(
    ["local", "docker", "modal", "daytona", "vercel_sandbox", "ssh", "e2b"],
  );
  expect(listCommandBackends().length).toBe(7);
  expect(getCommandBackend("docker")?.kind).toBe("local");
  expect(getCommandBackend("ssh")?.kind).toBe("remote");
  expect(getCommandBackend("e2b")?.kind).toBe("cloud");
  expect(isKnownCommandBackend("nope")).toBe(false);
});

test("注册表：插件可注册更多，重名报错、非法 id 报错、内置不能注销", () => {
  registerCommandBackend({ id: "mybox", label: "MyBox", kind: "remote", description: "测试后端", requires: [] });
  expect(isKnownCommandBackend("mybox")).toBe(true);
  expect(() => registerCommandBackend({ id: "mybox", label: "MyBox", kind: "remote", description: "x", requires: [] }))
    .toThrow("已注册");
  expect(() => registerCommandBackend({ id: "Bad-Id", label: "x", kind: "local", description: "x", requires: [] }))
    .toThrow("只认小写字母");
  expect(() => unregisterCommandBackend("local")).toThrow("内置后端");
  expect(() => unregisterCommandBackend("nope")).toThrow("未注册");
  unregisterCommandBackend("mybox");
  expect(isKnownCommandBackend("mybox")).toBe(false);
});

// ---- 配置文件 ----

test("配置：默认 active 是 local；save/load 往返，文件 0600", () => {
  const home = tmpHome("nyra-backend-cfg-");
  try {
    expect(loadCommandBackendConfig(home).active).toBe("local");
    const cfg = defaultCommandBackendConfig();
    cfg.docker.image = "node:20";
    cfg.ssh.host = "u@example.com";
    cfg.ssh.port = 2222;
    saveCommandBackendConfig(home, cfg);
    expectPerms(join(home, "command-backends.json"), 0o600);
    const back = loadCommandBackendConfig(home);
    expect(back.docker.image).toBe("node:20");
    expect(back.ssh.host).toBe("u@example.com");
    expect(back.ssh.port).toBe(2222);
  } finally { cleanup(home); }
});

test("配置：损坏先备份再回默认；符号链接拒绝读写", () => {
  const home = tmpHome("nyra-backend-corrupt-");
  try {
    writeFileSync(join(home, "command-backends.json"), "{not json", "utf-8");
    const cfg = loadCommandBackendConfig(home);
    expect(cfg.active).toBe("local");
    expect(existsSync(join(home, "command-backends.json"))).toBe(true);
  } finally { cleanup(home); }
  const home2 = tmpHome("nyra-backend-link-");
  try {
    const target = join(home2, "real.json");
    writeFileSync(target, "{}", "utf-8");
    symlinkSync(target, join(home2, "command-backends.json"));
    expect(() => loadCommandBackendConfig(home2)).toThrow("符号链接");
    expect(() => saveCommandBackendConfig(home2, defaultCommandBackendConfig())).toThrow("符号链接");
  } finally { cleanup(home2); }
});

test("配置：active 写了未知 id 时读回落到 local；非法端口/超时回默认", () => {
  const home = tmpHome("nyra-backend-sanitize-");
  try {
    writeFileSync(join(home, "command-backends.json"), JSON.stringify({
      active: "nope", ssh: { host: "u@h", port: 99999 }, e2b: { timeout: -5 },
    }), "utf-8");
    const cfg = loadCommandBackendConfig(home);
    expect(cfg.active).toBe("local");
    expect(cfg.ssh.port).toBe(22);
    expect(cfg.e2b.timeout).toBe(1800);
  } finally { cleanup(home); }
});

// ---- 生效后端解析 ----

test("resolveActiveBackend：flag > 环境变量 > 配置文件；未知 id 报错", async () => {
  const home = tmpHome("nyra-backend-resolve-");
  try {
    setActiveBackend(home, "ssh");
    await withEnv({ NYRA_COMMAND_BACKEND: undefined, ANGEL_COMMAND_BACKEND: undefined }, () => {
      expect(resolveActiveBackend(home).id).toBe("ssh");
    });
    await withEnv({ NYRA_COMMAND_BACKEND: "docker" }, () => {
      expect(resolveActiveBackend(home).id).toBe("docker");
      expect(resolveActiveBackend(home, "local").id).toBe("local");
    });
    expect(() => resolveActiveBackend(home, "nope")).toThrow("未知的命令后端");
  } finally { cleanup(home); }
});

test("setActiveBackend：未知 id 拒绝且不写文件", () => {
  const home = tmpHome("nyra-backend-set-");
  try {
    expect(() => setActiveBackend(home, "nope")).toThrow("未知的命令后端");
    expect(existsSync(join(home, "command-backends.json"))).toBe(false);
    setActiveBackend(home, "docker");
    expect(loadCommandBackendConfig(home).active).toBe("docker");
  } finally { cleanup(home); }
});

// ---- 探测 ----

test("probe：local 永远 available；云端三家永远 not_configured", async () => {
  const home = tmpHome("nyra-backend-probe-");
  try {
    expect((await probeBackend("local", home)).status).toBe("available");
    for (const id of ["modal", "daytona", "vercel_sandbox"]) {
      const p = await probeBackend(id, home);
      expect(p.status).toBe("not_configured");
      expect(p.detail).toMatch("未接线");
    }
    expect((await probeBackend("nope", home)).status).toBe("unavailable");
  } finally { cleanup(home); }
});

test("probe docker：没装报 unavailable；装了且 daemon 通报 available；daemon 不通报 unavailable", async () => {
  const home = tmpHome("nyra-backend-probe-docker-");
  try {
    const p1 = await probeBackend("docker", home, { dockerInstalled: false });
    expect(p1.status).toBe("unavailable");
    expect(p1.detail).toMatch("没装 docker");
    const p2 = await probeBackend("docker", home, { dockerInstalled: true, dockerInfo: async () => 0 });
    expect(p2.status).toBe("available");
    const p3 = await probeBackend("docker", home, { dockerInstalled: true, dockerInfo: async () => 1 });
    expect(p3.status).toBe("unavailable");
    expect(p3.detail).toMatch("daemon");
    // 真探测：本机没装 docker 时 detectDockerBinary 返回 false（不依赖 daemon）。
    expect(typeof detectDockerBinary()).toBe("boolean");
  } finally { cleanup(home); }
});

test("probe ssh：未配报 not_configured；配了 host 报 configured；密钥不存在报 not_configured", async () => {
  const home = tmpHome("nyra-backend-probe-ssh-");
  try {
    expect((await probeBackend("ssh", home)).status).toBe("not_configured");
    const cfg = loadCommandBackendConfig(home);
    cfg.ssh.host = "u@example.com";
    cfg.ssh.key_file = join(home, "no-such-key");
    saveCommandBackendConfig(home, cfg);
    const p = await probeBackend("ssh", home);
    expect(p.status).toBe("not_configured");
    expect(p.detail).toMatch("密钥文件不存在");
    cfg.ssh.key_file = null;
    saveCommandBackendConfig(home, cfg);
    const p2 = await probeBackend("ssh", home);
    expect(p2.status).toBe("configured");
    expect(p2.detail).toContain("u@example.com");
  } finally { cleanup(home); }
});

test("probe e2b：无 key 报 not_configured；有 key 报 configured", async () => {
  const home = tmpHome("nyra-backend-probe-e2b-");
  try {
    await withEnv({ E2B_API_KEY: undefined }, async () => {
      expect((await probeBackend("e2b", home)).status).toBe("not_configured");
    });
    const p = await probeBackend("e2b", home, { e2bApiKeyPresent: true });
    expect(p.status).toBe("configured");
    const all = await probeAllBackends(home, { dockerInstalled: false, e2bApiKeyPresent: false });
    expect(all.map((x) => x.id)).toEqual(["local", "docker", "modal", "daytona", "vercel_sandbox", "ssh", "e2b"]);
  } finally { cleanup(home); }
});

// ---- shell 转义与 argv 拼接 ----

test("shellQuote：单引号按 POSIX 转义", () => {
  expect(shellQuote("abc")).toBe("'abc'");
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
  expect(shellQuote("")).toBe("''");
});

test("buildDockerArgv：默认断网 + bind + 默认镜像；allowNet 去掉 --network；read-only 只读 bind", () => {
  const argv = buildDockerArgv("echo hi", { workdir: "/tmp/wd" });
  expect(argv.slice(0, 4)).toEqual(["docker", "run", "--rm", "-i"]);
  expect(argv).toContain("--network");
  expect(argv).toContain("none");
  expect(argv).toContain("/tmp/wd:/tmp/wd");
  expect(argv).toContain("debian:bookworm-slim");
  expect(argv.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  const net = buildDockerArgv("echo hi", { workdir: "/tmp/wd", allowNet: true, image: "node:20", extraArgs: ["--cpus", "1"] });
  expect(net).not.toContain("--network");
  expect(net).toContain("node:20");
  expect(net).toContain("--cpus");
  const ro = buildDockerArgv("echo hi", { workdir: "/tmp/wd", mode: "read-only" });
  expect(ro).toContain("/tmp/wd:/tmp/wd:ro");
});

test("buildSshArgv：BatchMode + 端口 + 密钥 + 远端 cd + 转义；非法 host 拒绝", () => {
  const argv = buildSshArgv("echo 'hi'", { host: "u@example.com", port: 2222, keyFile: "/tmp/k", remoteWorkdir: "/srv/app" });
  expect(argv[0]).toBe("ssh");
  expect(argv).toContain("BatchMode=yes");
  expect(argv).toContain("-p");
  expect(argv).toContain("2222");
  expect(argv).toContain("-i");
  expect(argv).toContain("/tmp/k");
  expect(argv).toContain("u@example.com");
  const remote = argv[argv.length - 1];
  expect(remote).toContain("cd '/srv/app'");
  expect(remote).toContain("sh -c 'echo '\\''hi'\\'''");
  const plain = buildSshArgv("ls", { host: "u@h" });
  expect(plain).not.toContain("-p");
  expect(plain[plain.length - 1]).toBe("sh -c 'ls'");
  expect(() => buildSshArgv("ls", { host: "a b" })).toThrow("不合法");
  expect(() => buildSshArgv("ls", { host: "-oProxyCommand=x" })).toThrow("不合法");
});

// ---- 注入 runner 真跑 ----

test("runDockerCommand / runSshCommand：注入 runner 收到 argv、回 canned 输出", async () => {
  const seenDocker: string[][] = [];
  const r1 = await runDockerCommand("echo hi", {
    workdir: "/tmp/wd", runner: fakeRunner(seenDocker, { code: 0, stdout: "hi\n", stderr: "" }),
  });
  expect(r1.stdout).toBe("hi\n");
  expect(seenDocker[0][0]).toBe("docker");
  expect(seenDocker[0]).toContain("echo hi");
  const seenSsh: string[][] = [];
  const r2 = await runSshCommand("echo hi", {
    host: "u@h", runner: fakeRunner(seenSsh, { code: 3, stdout: "", stderr: "boom" }),
  });
  expect(r2.code).toBe(3);
  expect(r2.stderr).toBe("boom");
  expect(seenSsh[0][0]).toBe("ssh");
});

// ---- 后端分发 ----

test("runBackendCommand：docker/ssh 按配置跑；ssh 未配 host 报错；e2b/云端/未知一律抛错不回落", async () => {
  const home = tmpHome("nyra-backend-dispatch-");
  try {
    const cfg = loadCommandBackendConfig(home);
    cfg.docker.image = "node:20";
    cfg.ssh.host = "u@example.com";
    saveCommandBackendConfig(home, cfg);
    const seen: string[][] = [];
    const r = await runBackendCommand("docker", "echo hi", {
      home, workdir: "/tmp/wd", deps: { dockerRunner: fakeRunner(seen, { code: 0, stdout: "hi", stderr: "" }) },
    });
    expect(r.stdout).toBe("hi");
    expect(seen[0]).toContain("node:20");
    const seenSsh: string[][] = [];
    await runBackendCommand("ssh", "echo hi", {
      home, workdir: "/tmp/wd", deps: { sshRunner: fakeRunner(seenSsh, { code: 0, stdout: "hi", stderr: "" }) },
    });
    expect(seenSsh[0]).toContain("u@example.com");
    await expect(runBackendCommand("e2b", "echo hi", { home, workdir: "/tmp/wd" }))
      .rejects.toBeInstanceOf(E2bExecutionUnsupportedError);
    await expect(runBackendCommand("modal", "echo hi", { home, workdir: "/tmp/wd" }))
      .rejects.toThrow("未接线");
    await expect(runBackendCommand("nope", "echo hi", { home, workdir: "/tmp/wd" }))
      .rejects.toThrow("未知的命令后端");
    const cfg2 = loadCommandBackendConfig(home);
    cfg2.ssh.host = null;
    saveCommandBackendConfig(home, cfg2);
    await expect(runBackendCommand("ssh", "echo hi", { home, workdir: "/tmp/wd" }))
      .rejects.toThrow("没配目标");
  } finally { cleanup(home); }
});

// ---- E2B 控制面（注入 fetch） ----

test("E2B 控制面：list/create/get/kill 的方法、路径与 Key 头都对；无 key 直接报错", async () => {
  const seen: Array<{ url: string; init: Record<string, unknown> }> = [];
  await withEnv({ E2B_API_KEY: "e2b_test_key" }, async () => {
    const list = await e2bListSandboxes(fakeFetch(seen, 200, `[{"sandboxID":"s1"}]`));
    expect((list as Array<{ sandboxID: string }>)[0].sandboxID).toBe("s1");
    expect(seen[0].url).toBe("https://api.e2b.dev/sandboxes");
    expect(seen[0].init.method).toBe("GET");
    expect((seen[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("e2b_test_key");
    const created = await e2bCreateSandbox({ template: "base", timeout: 300 }, fakeFetch(seen, 200, `{"sandboxID":"s2"}`));
    expect((created as { sandboxID: string }).sandboxID).toBe("s2");
    expect(seen[1].init.method).toBe("POST");
    expect(seen[1].init.body).toBe(JSON.stringify({ templateID: "base", timeout: 300 }));
    await e2bGetSandbox("s2", fakeFetch(seen, 200, `{"sandboxID":"s2"}`));
    expect(seen[2].url).toBe("https://api.e2b.dev/sandboxes/s2");
    await e2bKillSandbox("s2", fakeFetch(seen, 200, ``));
    expect(seen[3].init.method).toBe("DELETE");
  });
  await withEnv({ E2B_API_KEY: undefined }, async () => {
    await expect(e2bListSandboxes(fakeFetch(seen, 200, `[]`))).rejects.toBeInstanceOf(E2bNotConfiguredError);
    expect(seen.length).toBe(4); // 无 key 时一次请求都没发
  });
});

test("E2B 控制面：HTTP 500、3xx 重定向、非 JSON 一律报错", async () => {
  await withEnv({ E2B_API_KEY: "e2b_test_key" }, async () => {
    await expect(e2bListSandboxes(fakeFetch([], 500, "boom"))).rejects.toThrow("HTTP 500");
    await expect(e2bListSandboxes(fakeFetch([], 302, ""))).rejects.toThrow("重定向");
    await expect(e2bListSandboxes(fakeFetch([], 200, "not json"))).rejects.toThrow("不是 JSON");
    await expect(e2bGetSandbox("  ")).rejects.toThrow("不能为空");
  });
});

test("resolveE2bSettings：后端配置为准；沙箱 id 为空时 config.json 回退", () => {
  const home = tmpHome("nyra-backend-e2bsettings-");
  try {
    expect(resolveE2bSettings(home, { e2b_sandbox_id: "s9" })).toEqual(
      { template: "base", timeout: 1800, sandboxId: "s9" },
    );
    const cfg = loadCommandBackendConfig(home);
    cfg.e2b.sandbox_id = "s1";
    saveCommandBackendConfig(home, cfg);
    expect(resolveE2bSettings(home, { e2b_sandbox_id: "s9" }).sandboxId).toBe("s1");
  } finally { cleanup(home); }
});

test("resolveSandboxBackend e2b：有 key 解析为 e2b，没 key 报错（G-P1-39）", async () => {
  await withEnv({ E2B_API_KEY: undefined, NYRA_SANDBOX: undefined, ANGEL_SANDBOX: undefined }, () => {
    expect(() => resolveSandboxBackend({}, "e2b")).toThrow("E2B_API_KEY");
  });
  await withEnv({ E2B_API_KEY: "e2b_test_key" }, () => {
    const r = resolveSandboxBackend({}, "e2b");
    expect(r.backend).toBe("e2b");
    expect(r.level).toBe("e2b");
  });
});

// ---- CLI 全程 ----

test("CLI backend：list/use/status/docker/ssh 全程", async () => {
  const home = tmpHome("nyra-backend-cli-");
  try {
    const cap = captureStdout();
    try {
      expect(await handleBackend(["list"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("当前后端：local");
      cap.logs.length = 0;
      expect(await handleBackend(["use", "nope"], home)).toBe(2);
      // modal 恒为未配置（不依赖本机装没装 docker，CI 运行器上有 docker 时
      // use docker 不带 --yes 也会成功，不能拿它断言拒绝）。
      expect(await handleBackend(["use", "modal"], home)).toBe(2);
      expect(await handleBackend(["use", "modal", "--yes"], home)).toBe(0);
      expect(loadCommandBackendConfig(home).active).toBe("modal");
      cap.logs.length = 0;
      expect(await handleBackend(["status", "docker"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("docker");
      expect(await handleBackend(["status", "nope"], home)).toBe(2);
      cap.logs.length = 0;
      expect(await handleBackend(["docker", "--image", "node:20"], home)).toBe(0);
      expect(loadCommandBackendConfig(home).docker.image).toBe("node:20");
      expect(await handleBackend(["docker"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("node:20");
      expect(await handleBackend(["ssh", "--host", "u@example.com", "--port", "2222"], home)).toBe(0);
      expect(loadCommandBackendConfig(home).ssh.host).toBe("u@example.com");
      expect(loadCommandBackendConfig(home).ssh.port).toBe(2222);
      expect(await handleBackend(["ssh", "--host", "a b"], home)).toBe(2);
      expect(await handleBackend(["ssh", "--port", "0"], home)).toBe(2);
      expect(await handleBackend(["bogus"], home)).toBe(2);
    } finally { cap.restore(); }
  } finally { cleanup(home); }
});

test("CLI backend e2b：无 key 时 list 报错 1；注入 fetch 时 list/create 正常", async () => {
  const home = tmpHome("nyra-backend-cli-e2b-");
  try {
    const cap = captureStdout();
    try {
      await withEnv({ E2B_API_KEY: undefined }, async () => {
        expect(await handleBackend(["e2b", "list"], home)).toBe(1);
      });
      const seen: Array<{ url: string; init: Record<string, unknown> }> = [];
      await withEnv({ E2B_API_KEY: "e2b_test_key" }, async () => {
        expect(await handleBackend(["e2b", "list"], home, {
          fetchFn: fakeFetch(seen, 200, `[{"sandboxID":"s1"}]`),
        })).toBe(0);
        expect(cap.logs.join("")).toContain("s1");
        expect(await handleBackend(["e2b", "create", "--template", "base", "--timeout", "300"], home, {
          fetchFn: fakeFetch(seen, 200, `{"sandboxID":"s2"}`),
        })).toBe(0);
        expect(await handleBackend(["e2b", "kill"], home)).toBe(2); // 缺 id
        expect(await handleBackend(["e2b", "bogus"], home)).toBe(2);
      });
    } finally { cap.restore(); }
  } finally { cleanup(home); }
});

// ---- toolShell 分发 ----

test("toolShell 分发：docker/ssh 经注入 runner 跑；e2b/modal 直接报错不回落本机", async () => {
  const wd = tmpHome("nyra-backend-shell-");
  const home = tmpHome("nyra-backend-shell-home-");
  try {
    const cfg = loadCommandBackendConfig(home);
    cfg.ssh.host = "u@example.com";
    saveCommandBackendConfig(home, cfg);
    const seenDocker: string[][] = [];
    const ctxDocker = newToolContext({
      workdir: wd, home, mode: "full", interactive: false,
      commandBackend: "docker",
      commandBackendDeps: { dockerRunner: fakeRunner(seenDocker, { code: 0, stdout: "from-docker", stderr: "" }) },
    });
    const outDocker = await executeTool("shell", { command: "echo hi", timeout: 10 }, ctxDocker);
    expect(outDocker).toContain("from-docker");
    expect(seenDocker[0][0]).toBe("docker");
    const seenSsh: string[][] = [];
    const ctxSsh = newToolContext({
      workdir: wd, home, mode: "full", interactive: false,
      commandBackend: "ssh",
      commandBackendDeps: { sshRunner: fakeRunner(seenSsh, { code: 0, stdout: "from-ssh", stderr: "" }) },
    });
    expect(await executeTool("shell", { command: "echo hi", timeout: 10 }, ctxSsh)).toContain("from-ssh");
    expect(seenSsh[0][0]).toBe("ssh");
    const ctxE2b = newToolContext({ workdir: wd, home, mode: "full", interactive: false, commandBackend: "e2b" });
    const outE2b = await executeTool("shell", { command: "touch should-not-exist.txt", timeout: 10 }, ctxE2b);
    expect(outE2b).toMatch("未接线");
    expect(outE2b).toMatch("未降级为本机");
    expect(existsSync(join(wd, "should-not-exist.txt"))).toBe(false);
    const ctxModal = newToolContext({ workdir: wd, home, mode: "full", interactive: false, commandBackend: "modal" });
    expect(await executeTool("shell", { command: "echo hi", timeout: 10 }, ctxModal)).toMatch("未接线");
  } finally { cleanup(wd); cleanup(home); }
});

test("toolShell 分发：--sandbox e2b 有 key 时解析成功、执行直接报错不跑命令", async () => {
  const wd = tmpHome("nyra-backend-shell-e2b-");
  const home = tmpHome("nyra-backend-shell-e2b-home-");
  try {
    await withEnv({ E2B_API_KEY: "e2b_test_key" }, async () => {
      const ctx = newToolContext({
        workdir: wd, home, mode: "full", interactive: false,
        sandbox: { backend: "e2b", mode: "workspace-write", allowNet: false },
      });
      const out = await executeTool("shell", { command: "touch should-not-exist.txt", timeout: 10 }, ctx);
      expect(out).toMatch("未接线");
      expect(out).toMatch("未降级为本机");
      expect(existsSync(join(wd, "should-not-exist.txt"))).toBe(false);
    });
  } finally { cleanup(wd); cleanup(home); }
});

test("toolShell 分发：commandBackend 为 local/未设时走原有本机路径", async () => {
  const wd = tmpHome("nyra-backend-shell-local-");
  const home = tmpHome("nyra-backend-shell-local-home-");
  try {
    const ctx = newToolContext({ workdir: wd, home, mode: "full", interactive: false, commandBackend: "local" });
    expect(await executeTool("shell", { command: "echo legacy-path", timeout: 10 }, ctx)).toContain("legacy-path");
  } finally { cleanup(wd); cleanup(home); }
});
