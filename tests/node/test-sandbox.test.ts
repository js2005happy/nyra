// tests/node/test-sandbox.test.ts — OS 级分级沙箱（调研报告第 9 项，学 Codex CLI）。
// 本机无 bwrap（`which bwrap` 无结果），测试覆盖“bwrap 不可用”路径；
// 需要 bwrap 的场景一律用 PATH 里放的假 bwrap 脚本（shim）验证，禁止依赖真实 bwrap。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectBwrap, resolveSandboxBackend, buildBwrapArgs, runSandboxed,
  getSandboxStatus, SandboxUnavailableError, toolLevelFallbackNotice,
  describeSandboxLevel, sandboxLevelText,
} from "../../src/sandbox.ts";
import { seatbeltAvailable } from "../../src/seatbelt.ts";
import { findPowerShell } from "../../src/windowsSandbox.ts";
import { DEFAULT_CONFIG, VALID_SANDBOXES, resolveSandbox } from "../../src/config.ts";
import { newToolContext, executeTool } from "../../src/tools.ts";

const SANDBOX_ENV_KEYS = [
  "NYRA_SANDBOX", "ANGEL_SANDBOX", "NYRA_SANDBOX_MODE", "ANGEL_SANDBOX_MODE",
  "NYRA_SANDBOX_ALLOW_NET", "ANGEL_SANDBOX_ALLOW_NET",
  // G-P1-39：e2b 解析认 E2B_API_KEY，环境清理须一并清掉它。
  "E2B_API_KEY",
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

/** PATH 里放一个假 bwrap：记录参数到日志，再把最后一个参数当 shell 命令跑。
 * 日志路径直接烘进脚本（不读环境变量）：runSandboxed 给沙箱加 --clearenv 后，
 * 父进程的环境变量不再透传进 bwrap 子进程，shim 不能再靠 $BWRAP_LOG 找日志。 */
function makeBwrapShim(): { dir: string; log: string } {
  const dir = tmpDir("nyra-bwrap-shim-");
  const log = join(dir, "bwrap-args.log");
  writeFileSync(join(dir, "bwrap"), `#!/bin/sh
LOG=${JSON.stringify(log)}
echo "$@" >> "$LOG"
for last; do :; done
sh -c "$last"
`, "utf-8");
  chmodSync(join(dir, "bwrap"), 0o755);
  return { dir, log };
}

test("detectBwrap：空目录 PATH 返回 false；不存在的 PATH 目录也返回 false", () => {
  // 不直接断言本机真实 PATH：GitHub Ubuntu 运行器上实际装有 bwrap，
  // detectBwrap() 会返回 true——那是正确行为，不是测试能假定的环境。
  // 受控 PATH（空目录）下一定是 false，才是与环境无关的断言。
  expect(detectBwrap(tmpDir("nyra-empty-path-"))).toBe(false);
  expect(detectBwrap("/definitely/not/a/real/dir")).toBe(false);
});

test("detectBwrap：PATH 里放假 bwrap 脚本就能找到", () => {
  // 假 shim 是 #!/bin/sh 脚本，detectBwrap 在非 Linux 直接返回 false，跳过。
  if (process.platform !== "linux") { console.log("跳过：bwrap 只在 Linux，假 shim 依赖 /bin/sh"); return; }
  const { dir } = makeBwrapShim();
  expect(detectBwrap(dir)).toBe(true);
});

test("buildBwrapArgs：含 --bind 工作目录、--ro-bind 系统目录、默认 --unshare-net、--unshare-user-try、--die-with-parent、--chdir", () => {
  const wd = tmpDir("nyra-sandbox-wd-");
  const args = buildBwrapArgs("echo hi", { workdir: wd, allowNet: false, mode: "workspace-write" });
  expect(args[0]).toBe("bwrap");
  expect(args).toContain("--bind");
  expect(args).toContain(wd);
  expect(args).toContain("--unshare-net");
  // 断网时先建 user ns，否则无特权用户配不了 loopback；user ns 须在 net ns 之前。
  expect(args).toContain("--unshare-user-try");
  expect(args.indexOf("--unshare-user-try")).toBeLessThan(args.indexOf("--unshare-net"));
  expect(args).toContain("--die-with-parent");
  expect(args).toContain("--chdir");
  expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  // 系统目录只读挂载：实现只挂真实存在的目录，/usr 等在 Windows 上不存在时
  // 按设计跳过（不是实现漏了）。只在 Linux 断言完整参数。
  if (process.platform === "linux") {
    expect(args).toContain("--ro-bind");
    expect(args).toContain("/usr");
  }
});

test("buildBwrapArgs：allowNet 时无 --unshare-net、无 --unshare-user-try；read-only 时工作目录只读", () => {
  const wd = tmpDir("nyra-sandbox-wd-");
  const netArgs = buildBwrapArgs("echo hi", { workdir: wd, allowNet: true, mode: "workspace-write" });
  expect(netArgs).not.toContain("--unshare-net");
  expect(netArgs).not.toContain("--unshare-user-try");
  const roArgs = buildBwrapArgs("echo hi", { workdir: wd, allowNet: false, mode: "read-only" });
  expect(roArgs).not.toContain("--bind");
  const roIdx = roArgs.indexOf("--ro-bind");
  expect(roIdx).toBeGreaterThanOrEqual(0);
  expect(roArgs.slice(roIdx)).toContain(wd);
});

test("buildBwrapArgs：danger-full-access 拒绝进 bwrap", () => {
  const wd = tmpDir("nyra-sandbox-wd-");
  expect(() => buildBwrapArgs("echo hi", { workdir: wd, allowNet: false, mode: "danger-full-access" }))
    .toThrow("danger-full-access 与沙箱互斥");
});

test("config 默认值：sandbox=auto、sandbox_mode=workspace-write、默认断网；VALID_SANDBOXES 含 auto/bwrap", () => {
  expect(DEFAULT_CONFIG.sandbox).toBe("auto");
  expect(DEFAULT_CONFIG.sandbox_mode).toBe("workspace-write");
  expect(DEFAULT_CONFIG.sandbox_allow_net).toBe(false);
  expect([...VALID_SANDBOXES]).toEqual(["auto", "local", "bwrap", "e2b"]);
  const settings = resolveSandbox({});
  expect(settings.backend).toBe("auto");
  expect(settings.mode).toBe("workspace-write");
  expect(settings.allowNet).toBe(false);
});

test("resolveSandbox：NYRA_SANDBOX_ALLOW_NET=1 放开网络；非法 mode 报错", async () => {
  await withEnv({ ...cleanSandboxEnv(), NYRA_SANDBOX_ALLOW_NET: "1" }, () => {
    expect(resolveSandbox({}).allowNet).toBe(true);
    expect(resolveSandboxBackend({}, "auto").allowNet).toBe(true);
  });
  expect(() => resolveSandbox({ sandbox_mode: "nope" })).toThrow("Invalid sandbox_mode");
  expect(() => resolveSandboxBackend({ sandbox_mode: "nope" }, "auto")).toThrow("Invalid sandbox_mode");
});

test("auto 在无 bwrap 且无 sandbox-exec 时解析为 tool-level（本机即是），并给出工具级提示文案", async () => {
  // PATH 换成空目录再解析：GitHub Ubuntu 运行器上有真 bwrap，不控 PATH 时
  // auto 会解析为 bwrap——那是正确行为，测试不能假定运行器没装 bwrap。
  // macOS 上 sandbox-exec 是固定路径（/usr/bin/sandbox-exec），空 PATH 藏不住它，
  // auto 会进 Seatbelt——同样是正确行为；要测“无后端可用”须用探测覆盖把 Seatbelt 关掉。
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, () => {
    const r = resolveSandboxBackend({}, "auto", { seatbeltAvailable: false });
    expect(r.backend).toBe("local");
    expect(r.level).toBe("tool-level");
    expect(r.mode).toBe("workspace-write");
    expect(r.allowNet).toBe(false);
    expect(toolLevelFallbackNotice(r)).toMatch("工具级隔离，不是 OS 沙箱");
  });
});

test("local：显式只要工具级，即便 PATH 里有 bwrap 也不用", async () => {
  if (process.platform !== "linux") { console.log("跳过：bwrap 只在 Linux，假 shim 依赖 /bin/sh"); return; }
  const { dir } = makeBwrapShim();
  await withEnv({ ...cleanSandboxEnv(), PATH: `${dir}:${process.env.PATH ?? ""}` }, () => {
    expect(detectBwrap()).toBe(true);
    const r = resolveSandboxBackend({}, "local");
    expect(r.backend).toBe("local");
    expect(r.level).toBe("tool-level");
  });
});

test("auto：PATH 里有 bwrap 时解析为 bwrap", async () => {
  if (process.platform !== "linux") { console.log("跳过：bwrap 只在 Linux，假 shim 依赖 /bin/sh"); return; }
  const { dir } = makeBwrapShim();
  await withEnv({ ...cleanSandboxEnv(), PATH: `${dir}:${process.env.PATH ?? ""}` }, () => {
    const r = resolveSandboxBackend({}, "auto");
    expect(r.backend).toBe("bwrap");
    expect(r.level).toBe("bwrap");
  });
});

test("bwrap 强制缺失时报错信息清楚：点名缺 bwrap、给安装方法、给回退选项", async () => {
  if (process.platform !== "linux") {
    // 非 Linux 上实现先报平台不支持（Linux-only），不是“找不到 bwrap”——以实现为准。
    await withEnv(cleanSandboxEnv(), () => {
      expect(() => resolveSandboxBackend({}, "bwrap")).toThrow("只支持 Linux");
    });
    return;
  }
  // Linux 上 PATH 换成空目录：运行器有真 bwrap 时不控 PATH 根本不会抛错。
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, () => {
    expect(() => resolveSandboxBackend({}, "bwrap")).toThrow("找不到 bwrap");
    expect(() => resolveSandboxBackend({}, "bwrap")).toThrow("apt install bubblewrap");
    expect(() => resolveSandboxBackend({}, "bwrap")).toThrow("auto");
  });
});

test("e2b：没配 E2B_API_KEY 时解析失败；有 key 时解析为 e2b（G-P1-39）", async () => {
  await withEnv(cleanSandboxEnv(), () => {
    expect(() => resolveSandboxBackend({}, "e2b")).toThrow("E2B_API_KEY");
  });
  await withEnv({ ...cleanSandboxEnv(), E2B_API_KEY: "e2b_test_key" }, () => {
    const r = resolveSandboxBackend({}, "e2b");
    expect(r.backend).toBe("e2b");
    expect(r.level).toBe("e2b");
    expect(describeSandboxLevel(r)).toMatch("E2B_API_KEY 已设");
    expect(sandboxLevelText("e2b")).toMatch("E2B");
  });
});

test("danger-full-access：显式 bwrap 时抛错；auto 时落到工具级", async () => {
  await withEnv(cleanSandboxEnv(), () => {
    expect(() => resolveSandboxBackend({ sandbox_mode: "danger-full-access" }, "bwrap"))
      .toThrow("danger-full-access 与沙箱互斥");
    const r = resolveSandboxBackend({ sandbox_mode: "danger-full-access" }, "auto");
    expect(r.level).toBe("tool-level");
    expect(r.mode).toBe("danger-full-access");
  });
});

test("runSandboxed：无 bwrap 时抛 SandboxUnavailableError（绝不静默裸奔）", async () => {
  const wd = tmpDir("nyra-sandbox-wd-");
  await withEnv({ ...cleanSandboxEnv(), PATH: tmpDir("nyra-empty-path-") }, async () => {
    expect(detectBwrap()).toBe(false);
    await expect(runSandboxed("echo hi", { workdir: wd, allowNet: false, mode: "workspace-write" }))
      .rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

test("runSandboxed：假 bwrap shim 端到端跑通一次，参数里含工作目录绑定与默认断网", async () => {
  if (process.platform !== "linux") { console.log("跳过：bwrap 只在 Linux，假 shim 依赖 /bin/sh"); return; }
  const wd = tmpDir("nyra-sandbox-wd-");
  const { dir, log } = makeBwrapShim();
  await withEnv({ ...cleanSandboxEnv(), PATH: `${dir}:${process.env.PATH ?? ""}`, BWRAP_LOG: log }, async () => {
    const result = await runSandboxed("echo shim-hello", { workdir: wd, allowNet: false, mode: "workspace-write" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("shim-hello");
    const recorded = readFileSync(log, "utf-8");
    expect(recorded).toContain("--bind");
    expect(recorded).toContain(wd);
    expect(recorded).toContain("--unshare-net");
    // 白名单环境：bwrap 参数里有 --clearenv（第四份审计 P0）。
    expect(recorded).toContain("--clearenv");
  });
});

test("getSandboxStatus：auto 无 bwrap 且无 sandbox-exec 时 level 为 tool-level；显式 bwrap 缺失时 level 为 none 且不抛错", async () => {
  // PATH 换成空目录：运行器有真 bwrap 时 auto 会是 bwrap、forced 不会是 none。
  // macOS 上 sandbox-exec 是固定路径，空 PATH 藏不住：auto 会进 Seatbelt，须用探测覆盖关掉。
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, () => {
    const auto = getSandboxStatus({}, null, { seatbeltAvailable: false });
    expect(auto.level).toBe("tool-level");
    expect(auto.bwrapAvailable).toBe(false);
    expect(auto.detail).toMatch("工具级");
    const forced = getSandboxStatus({}, "bwrap");
    expect(forced.level).toBe("none");
    // 显式 bwrap 缺失的原因按平台分：Linux 是“找不到 bwrap”，非 Linux 是平台不支持——以实现为准。
    if (process.platform === "linux") expect(forced.detail).toMatch("bubblewrap");
    else expect(forced.detail).toMatch("只支持 Linux");
  });
});

test("toolShell 接线：auto 无 bwrap 且无 sandbox-exec 时走现有路径跑通；首次执行给一次工具级提示", async () => {
  const wd = tmpDir("nyra-shell-wd-");
  // PATH 换成空目录：运行器有真 bwrap 时 auto 会进 bwrap 分支，不会打印工具级提示。
  // shell 本身走绝对路径 /bin/sh（POSIX）/ ComSpec（Windows），空 PATH 不影响执行。
  // macOS 上 sandbox-exec 是固定路径，空 PATH 藏不住：须用探测覆盖把 Seatbelt 关掉，
  // 否则 auto 进 Seatbelt、工具级提示不会出现。
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
    try {
      const ctx = newToolContext({
        workdir: wd, mode: "full", interactive: false,
        sandbox: { backend: "auto", mode: "workspace-write", allowNet: false },
        sandboxProbe: { seatbeltAvailable: false },
      });
      const out = await executeTool("shell", { command: "echo hello-shell", timeout: 10 }, ctx);
      expect(out).toContain("hello-shell");
      expect(errors.join("\n")).toMatch("工具级隔离，不是 OS 沙箱");
      // 第二次不再重复提示。
      errors.length = 0;
      await executeTool("shell", { command: "echo again", timeout: 10 }, ctx);
      expect(errors.join("\n")).not.toMatch("工具级隔离");
    } finally {
      console.error = origError;
    }
  });
});

test("toolShell 接线：显式 bwrap 但无 bwrap 时命令不跑、返回清楚的报错", async () => {
  const wd = tmpDir("nyra-shell-wd-");
  // PATH 换成空目录：运行器有真 bwrap 时命令真会跑，touch 文件就建出来了。
  const emptyPath = tmpDir("nyra-empty-path-");
  await withEnv({ ...cleanSandboxEnv(), PATH: emptyPath }, async () => {
    const ctx = newToolContext({
      workdir: wd, mode: "full", interactive: false,
      sandbox: { backend: "bwrap", mode: "workspace-write", allowNet: false },
    });
    const out = await executeTool("shell", { command: "touch should-not-exist.txt", timeout: 10 }, ctx);
    expect(out).toMatch("沙箱配置有问题");
    // 报错原因按平台分：Linux 是“找不到 bwrap”，非 Linux 是平台不支持——以实现为准。
    if (process.platform === "linux") expect(out).toMatch("bubblewrap");
    else expect(out).toMatch("只支持 Linux");
    expect(existsSync(join(wd, "should-not-exist.txt"))).toBe(false);
  });
});

test("toolShell 接线：bwrap + 假 shim 时命令经 shim 跑通（含流式分支）", async () => {
  if (process.platform !== "linux") { console.log("跳过：bwrap 只在 Linux，假 shim 依赖 /bin/sh"); return; }
  const wd = tmpDir("nyra-shell-wd-");
  const { dir, log } = makeBwrapShim();
  await withEnv({ ...cleanSandboxEnv(), PATH: `${dir}:${process.env.PATH ?? ""}`, BWRAP_LOG: log }, async () => {
    const streamed: string[] = [];
    const ctx = newToolContext({
      workdir: wd, mode: "full", interactive: false, streamToolOutput: true,
      onEvent: (_kind, data) => { if (typeof data.text === "string") streamed.push(data.text); },
      sandbox: { backend: "bwrap", mode: "workspace-write", allowNet: false },
    });
    const out = await executeTool("shell", { command: "echo via-shim", timeout: 10 }, ctx);
    expect(out).toContain("via-shim");
    expect(streamed.join("")).toContain("via-shim");
    expect(readFileSync(log, "utf-8")).toContain("--bind");
  });
});

test("toolShell 接线：未配 sandbox 的旧调用保持原行为（不解析、不提示）", async () => {
  const wd = tmpDir("nyra-shell-wd-");
  await withEnv(cleanSandboxEnv(), async () => {
    const ctx = newToolContext({ workdir: wd, mode: "full", interactive: false });
    const out = await executeTool("shell", { command: "echo legacy-path", timeout: 10 }, ctx);
    expect(out).toContain("legacy-path");
  });
});

// ---- 隔离补强批：macOS auto → Seatbelt、Windows auto 仍不选 Job Object ----

test("auto：macOS + sandbox-exec 可用时解析为 Seatbelt（探测覆盖模拟 darwin）", () => {
  const r = resolveSandboxBackend({}, null, { platform: "darwin", seatbeltAvailable: true });
  expect(r.backend).toBe("seatbelt");
  expect(r.level).toBe("seatbelt");
  expect(r.seatbeltAvailable).toBe(true);
});

test("auto：macOS 无 sandbox-exec 时回落工具级；danger-full-access 同样落工具级", () => {
  const noSb = resolveSandboxBackend({}, null, { platform: "darwin", seatbeltAvailable: false });
  expect(noSb.backend).toBe("local");
  expect(noSb.level).toBe("tool-level");
  const danger = resolveSandboxBackend({ sandbox_mode: "danger-full-access" }, null, { platform: "darwin", seatbeltAvailable: true });
  expect(danger.backend).toBe("local");
  expect(danger.level).toBe("tool-level");
});

test("auto：Windows 有 PowerShell 时仍不选 Job Object（隔离面不同、未真机验证）", () => {
  const r = resolveSandboxBackend({}, null, { platform: "win32", jobObjectAvailable: true });
  expect(r.backend).toBe("local");
  expect(r.level).toBe("tool-level");
});

test("getSandboxStatus：探测覆盖的三后端可用性字段如实上报", () => {
  const s = getSandboxStatus({}, null, { platform: "darwin", bwrapAvailable: false, seatbeltAvailable: true, jobObjectAvailable: false });
  expect(s.level).toBe("seatbelt");
  expect(s.bwrapAvailable).toBe(false);
  expect(s.seatbeltAvailable).toBe(true);
  expect(s.jobObjectAvailable).toBe(false);
});

test("toolShell 接线：jobobject + 断网时联网工具在 PowerShell 启动前就被拦", async () => {
  const wd = tmpDir("nyra-shell-wd-");
  // 有真 PowerShell 的机器（Windows 运行器）上，未被拦截的命令会真跑：
  // 回环 curl 发出去、连不上，返回的是 curl 报错 + 沙箱退出码，不是“启动失败”。
  // 无 PowerShell 的机器（Linux/macOS）上才走到“Job Object 启动失败”。
  const ps = findPowerShell();
  await withEnv(cleanSandboxEnv(), async () => {
    const ctx = newToolContext({
      workdir: wd, mode: "full", interactive: false,
      sandbox: { backend: "jobobject", mode: "workspace-write", allowNet: false },
      sandboxProbe: { platform: "win32", jobObjectAvailable: true },
    });
    const out = await executeTool("shell", { command: "curl https://example.com", timeout: 10 }, ctx);
    expect(out).toMatch("禁止联网工具 curl");
    // 回环豁免：不触发拦截，继续走到 PowerShell 启动（有则真跑、无则启动失败）。
    const local = await executeTool("shell", { command: "curl http://localhost:3000/x", timeout: 10 }, ctx);
    expect(local).not.toMatch("禁止联网工具");
    if (ps === null) expect(local).toMatch("Job Object 启动失败");
    else expect(local).toMatch("沙箱内命令退出码");
    // allowNet=true 时不拦截，同样走到 PowerShell 启动。
    const ctxNet = newToolContext({
      workdir: wd, mode: "full", interactive: false,
      sandbox: { backend: "jobobject", mode: "workspace-write", allowNet: true },
      sandboxProbe: { platform: "win32", jobObjectAvailable: true },
    });
    const outNet = await executeTool("shell", { command: "curl https://example.com", timeout: 10 }, ctxNet);
    expect(outNet).not.toMatch("禁止联网工具");
    if (ps === null) expect(outNet).toMatch("Job Object 启动失败");
    else expect(outNet).not.toMatch("Job Object 启动失败");
  });
});

// 隔离补强批：macOS 真机有 sandbox-exec 时 auto 解析为 Seatbelt（新行为，
// 探测覆盖版已在上面测过；这里断言真实探测链路，只在 macOS 真机上跑）。
test("auto：macOS 真机有 sandbox-exec 时解析为 Seatbelt", () => {
  if (process.platform !== "darwin" || !seatbeltAvailable()) {
    console.log("跳过：仅 macOS 且有 sandbox-exec 时可断言");
    return;
  }
  const r = resolveSandboxBackend({}, "auto");
  expect(r.backend).toBe("seatbelt");
  expect(r.level).toBe("seatbelt");
});
