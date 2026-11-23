// tests/node/test-computer-guard.test.ts — G-P1-35 真机电脑操作守卫。
// 钉住的事：
//   - blocklist 子串匹配（中英、大小写不敏感）与禁按组合键归一化；
//   - 配置默认/往返/0600/损坏备份；授权发/撤/过期/会话作用域；
//   - 活动账本只记长度不记输入文本内容、0600、坏行跳过、每分钟限流；
//   - 守卫检查：禁按、禁碰前台窗口、前台未知放行并记 unknown、授权开关、
//     虚拟桌面开关、home 为 null 时只剩内存默认名单；
//   - activeWindow 三平台解析（假 runner）；虚拟桌面起停（注入替身）；
//   - CLI 全程；工具层接线（拒绝进账本、放行进账本、事件已注册）。
// 全部用临时 home 与假 runner / 假电脑对象，不碰真桌面、不联网。
import { test, expect } from "bun:test";
import {
  mkdtempSync, readFileSync, writeFileSync, readdirSync, appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  ComputerControl,
  type CommandResult,
  type CommandRunner,
} from "../../src/computer.ts";
import {
  checkComputerAction,
  countRecentActivity,
  displayStatus,
  findActiveGrant,
  issueGrant,
  isBlockedKey,
  listComputerActivity,
  listGrants,
  matchesBlocklist,
  readGuardConfig,
  recordComputerActivity,
  revokeGrant,
  startVirtualDisplay,
  stopVirtualDisplay,
  writeGuardConfig,
  GUARD_CONFIG_NAME,
  GRANTS_NAME,
  ACTIVITY_NAME,
  DISPLAY_RECORD_NAME,
  DEFAULT_BLOCKED_TITLES,
} from "../../src/computerGuard.ts";
import { handleComputerGuard } from "../../src/computerGuardCli.ts";
import { executeTool, newToolContext, type ToolContext } from "../../src/tools.ts";
import { RunStore } from "../../src/runs.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function capture() {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  return {
    get out() { return out; },
    get err() { return err; },
    restore: () => {
      (process.stdout as unknown as { write: unknown }).write = origOut;
      (process.stderr as unknown as { write: unknown }).write = origErr;
    },
  };
}

function ok(stdout: Buffer | string = "", stderr = ""): CommandResult {
  return { stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr, code: 0 };
}

function fail(code: number, stderr = ""): CommandResult {
  return { stdout: Buffer.from(""), stderr, code };
}

interface Fake {
  runner: CommandRunner;
  calls: string[][];
}

function fakeRunner(handler: (argv: string[]) => CommandResult = () => ok()): Fake {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    return handler(argv);
  };
  return { runner, calls };
}

function x11Control(fake: Fake, extra: Record<string, unknown> = {}) {
  return new ComputerControl({
    backend: "x11",
    platform: "linux",
    env: { DISPLAY: ":0", PATH: "/usr/bin:/bin" },
    runner: fake.runner,
    which: () => "/usr/bin/xdotool",
    commandTimeoutMs: 200,
    screenshotTimeoutMs: 200,
    ...extra,
  });
}

function windowsControl(fake: Fake, extra: Record<string, unknown> = {}) {
  return new ComputerControl({
    backend: "windows",
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    runner: fake.runner,
    commandTimeoutMs: 200,
    screenshotTimeoutMs: 200,
    ...extra,
  });
}

function macosControl(fake: Fake, extra: Record<string, unknown> = {}) {
  return new ComputerControl({
    backend: "macos",
    platform: "darwin",
    env: {},
    runner: fake.runner,
    which: () => "/usr/bin/osascript",
    commandTimeoutMs: 200,
    screenshotTimeoutMs: 200,
    ...extra,
  });
}

function fakeComputer(overrides: Record<string, unknown> = {}) {
  return {
    backend: "x11",
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    click: async (_x: number, _y: number, _button?: string) => {},
    typeText: async (_text: string) => {},
    press: async (_key: string) => {},
    windows: async () => [{ id: "1", title: "编辑器", x: 0, y: 0, width: 800, height: 600 }],
    ...overrides,
  } as unknown as ToolContext["computer"];
}

function toolCtx(home: string, extra: Partial<ToolContext> = {}): ToolContext {
  return newToolContext({ workdir: home, mode: "full", interactive: false, home, ...extra });
}

// ---- blocklist / 禁按 ----

test("ComputerGuardTest.test_blocklist_matches_substring_case_insensitive", () => {
  expect(matchesBlocklist("系统设置", DEFAULT_BLOCKED_TITLES)).toBe(true);
  expect(matchesBlocklist("Settings", DEFAULT_BLOCKED_TITLES)).toBe(true);
  expect(matchesBlocklist("VS Code - Settings", DEFAULT_BLOCKED_TITLES)).toBe(true);
  expect(matchesBlocklist("1Password - 我的保险库", DEFAULT_BLOCKED_TITLES)).toBe(true);
  expect(matchesBlocklist("支付宝", DEFAULT_BLOCKED_TITLES)).toBe(true);
  expect(matchesBlocklist("编辑器", DEFAULT_BLOCKED_TITLES)).toBe(false);
  expect(matchesBlocklist("终端", DEFAULT_BLOCKED_TITLES)).toBe(false);
  expect(matchesBlocklist("", DEFAULT_BLOCKED_TITLES)).toBe(false);
  expect(matchesBlocklist("浏览器", ["浏览器"])).toBe(true);
  expect(matchesBlocklist("浏览器", [])).toBe(false);
});

test("ComputerGuardTest.test_blocked_keys_normalized", () => {
  expect(isBlockedKey("ctrl+alt+delete", ["ctrl+alt+delete"])).toBe(true);
  expect(isBlockedKey("Ctrl+Alt+Delete", ["ctrl+alt+delete"])).toBe(true);
  expect(isBlockedKey("ctrl + alt + delete", ["ctrl+alt+delete"])).toBe(true);
  expect(isBlockedKey("Super+L", ["super+l"])).toBe(true);
  expect(isBlockedKey("Enter", ["ctrl+alt+delete", "super+l"])).toBe(false);
  expect(isBlockedKey("", ["ctrl+alt+delete"])).toBe(false);
});

// ---- 配置 ----

test("ComputerGuardTest.test_config_defaults_and_roundtrip_0600", () => {
  const defaults = readGuardConfig(null);
  expect(defaults.require_grant).toBe(false);
  expect(defaults.require_virtual_display).toBe(false);
  expect(defaults.max_actions_per_minute).toBe(60);
  expect(defaults.blocked_titles).toContain("系统设置");
  expect(defaults.blocked_keys).toContain("ctrl+alt+delete");
  const home = tmpHome("nyra-cguard-");
  const next = writeGuardConfig(home, { require_grant: true, max_actions_per_minute: 5 });
  expect(next.require_grant).toBe(true);
  expect(next.max_actions_per_minute).toBe(5);
  expect(next.blocked_titles).toEqual(defaults.blocked_titles);
  expect(readGuardConfig(home).require_grant).toBe(true);
  expectPerms(join(home, GUARD_CONFIG_NAME), 0o600);
});

test("ComputerGuardTest.test_config_corrupt_backs_up_and_returns_defaults", () => {
  const home = tmpHome("nyra-cguard-");
  writeFileSync(join(home, GUARD_CONFIG_NAME), "{ not json");
  const config = readGuardConfig(home);
  expect(config.require_grant).toBe(false);
  expect(config.max_actions_per_minute).toBe(60);
  const names = readdirSync(home);
  expect(names.some((n) => n.startsWith(`${GUARD_CONFIG_NAME}.bak-`))).toBe(true);
});

// ---- 授权 ----

test("ComputerGuardTest.test_grant_issue_list_revoke", () => {
  const home = tmpHome("nyra-cguard-");
  const g = issueGrant(home, { label: "测试" });
  expect(g.id.startsWith("cg-")).toBe(true);
  expect(g.expires_at).not.toBeNull();
  expect(g.revoked).toBe(false);
  expect(listGrants(home).length).toBe(1);
  expect(revokeGrant(home, g.id, "不用了")).toBe(true);
  expect(revokeGrant(home, g.id)).toBe(false);
  expect(revokeGrant(home, "cg-00000000")).toBe(false);
  expect(listGrants(home)[0].revoked).toBe(true);
  expectPerms(join(home, GRANTS_NAME), 0o600);
});

test("ComputerGuardTest.test_grant_expiry_and_scope_match", () => {
  const home = tmpHome("nyra-cguard-");
  const never = issueGrant(home, { minutes: 0 });
  expect(never.expires_at).toBeNull();
  expect(findActiveGrant(home, null)?.id).toBe(never.id);
  // 手工写一张已过期的授权：惰性判断，不算可用。
  const expired = {
    id: "cg-deadbeef", scope: {}, label: "过期", created_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-01T01:00:00.000Z", revoked: false,
  };
  writeFileSync(join(home, GRANTS_NAME), JSON.stringify([expired]));
  expect(findActiveGrant(home, null)).toBeNull();
  // 会话专属授权只认该会话，整机授权兜底。
  const scoped = issueGrant(home, { sessionId: "sess-1" });
  expect(findActiveGrant(home, "sess-1")?.id).toBe(scoped.id);
  expect(findActiveGrant(home, "sess-2")).toBeNull();
  const wide = issueGrant(home, {});
  expect(findActiveGrant(home, "sess-2")?.id).toBe(wide.id);
  expect(findActiveGrant(home, "sess-1")?.id).toBe(scoped.id);
});

// ---- 活动账本 ----

test("ComputerGuardTest.test_activity_records_without_text_content", () => {
  const home = tmpHome("nyra-cguard-");
  recordComputerActivity(home, {
    time: new Date().toISOString(), action: "computer_type", text_len: 11,
    session_id: "sess-1", result: "ok", foreground: "known",
  });
  recordComputerActivity(home, {
    time: new Date().toISOString(), action: "computer_click", x: 10, y: 20, button: "left",
    result: "ok",
  });
  const raw = readFileSync(join(home, ACTIVITY_NAME), "utf-8");
  expect(raw.includes("secret")).toBe(false);
  const entries = listComputerActivity(home, 10);
  expect(entries.length).toBe(2);
  expect(entries[0].action).toBe("computer_click");
  expect(entries[1].action).toBe("computer_type");
  expect(entries[1].text_len).toBe(11);
  expect("text" in entries[1]).toBe(false);
  expect(listComputerActivity(home, 1).length).toBe(1);
  expectPerms(join(home, ACTIVITY_NAME), 0o600);
});

test("ComputerGuardTest.test_activity_bad_lines_skipped", () => {
  const home = tmpHome("nyra-cguard-");
  recordComputerActivity(home, { time: new Date().toISOString(), action: "computer_key", key: "Enter", result: "ok" });
  appendFileSync(join(home, ACTIVITY_NAME), "{ broken json\n");
  expect(listComputerActivity(home, 10).length).toBe(1);
  expect(countRecentActivity(home, 60_000)).toBe(1);
});

test("ComputerGuardTest.test_activity_no_home_is_noop", () => {
  recordComputerActivity(null, { time: new Date().toISOString(), action: "computer_key", key: "Enter", result: "ok" });
  expect(listComputerActivity(tmpHome("nyra-cguard-"), 10)).toEqual([]);
});

// ---- 守卫检查 ----

test("ComputerGuardTest.test_check_refuses_blocked_key", async () => {
  const home = tmpHome("nyra-cguard-");
  await expect(checkComputerAction(home, { action: "computer_key", key: "ctrl+alt+delete" }))
    .rejects.toThrow("禁按的组合键");
  await expect(checkComputerAction(home, { action: "computer_key", key: "Ctrl+Alt+Delete" }))
    .rejects.toThrow("禁按的组合键");
  const okDecision = await checkComputerAction(home, { action: "computer_key", key: "Enter" });
  expect(okDecision.foregroundKnown).toBe(false);
});

test("ComputerGuardTest.test_check_refuses_blocked_foreground", async () => {
  const home = tmpHome("nyra-cguard-");
  await expect(checkComputerAction(home, {
    action: "computer_click", x: 10, y: 20,
    getForegroundTitle: async () => "系统设置",
  })).rejects.toThrow("禁碰名单");
  await expect(checkComputerAction(home, {
    action: "computer_type", textLen: 3,
    getForegroundTitle: async () => "1Password - 我的保险库",
  })).rejects.toThrow("禁碰名单");
});

test("ComputerGuardTest.test_check_foreground_unknown_passes", async () => {
  const home = tmpHome("nyra-cguard-");
  const d1 = await checkComputerAction(home, {
    action: "computer_click", x: 1, y: 2,
    getForegroundTitle: async () => null,
  });
  expect(d1.foregroundKnown).toBe(false);
  const d2 = await checkComputerAction(home, { action: "computer_click", x: 1, y: 2 });
  expect(d2.foregroundKnown).toBe(false);
  const d3 = await checkComputerAction(home, {
    action: "computer_click", x: 1, y: 2,
    getForegroundTitle: async () => "编辑器",
  });
  expect(d3.foregroundKnown).toBe(true);
  expect(d3.foregroundTitle).toBe("编辑器");
});

test("ComputerGuardTest.test_check_grant_required", async () => {
  const home = tmpHome("nyra-cguard-");
  writeGuardConfig(home, { require_grant: true });
  await expect(checkComputerAction(home, { action: "computer_click", x: 1, y: 2 }))
    .rejects.toThrow("没有可用的电脑操作授权");
  const grant = issueGrant(home, {});
  const d = await checkComputerAction(home, { action: "computer_click", x: 1, y: 2 });
  expect(d.grantId).toBe(grant.id);
  revokeGrant(home, grant.id);
  await expect(checkComputerAction(home, { action: "computer_click", x: 1, y: 2 }))
    .rejects.toThrow("没有可用的电脑操作授权");
});

test("ComputerGuardTest.test_check_virtual_display", async () => {
  const home = tmpHome("nyra-cguard-");
  writeGuardConfig(home, { require_virtual_display: true });
  await expect(checkComputerAction(home, { action: "computer_click", x: 1, y: 2, display: ":99" }))
    .rejects.toThrow("只允许在虚拟桌面");
  writeFileSync(join(home, DISPLAY_RECORD_NAME), JSON.stringify({
    display: ":99", pid: 4242, started_at: new Date().toISOString(),
  }));
  await expect(checkComputerAction(home, { action: "computer_click", x: 1, y: 2, display: ":0" }))
    .rejects.toThrow("只允许在虚拟桌面");
  const d = await checkComputerAction(home, { action: "computer_click", x: 1, y: 2, display: ":99" });
  expect(d.foregroundKnown).toBe(false);
});

test("ComputerGuardTest.test_check_rate_limit", async () => {
  const home = tmpHome("nyra-cguard-");
  writeGuardConfig(home, { max_actions_per_minute: 2 });
  for (let i = 0; i < 2; i++) {
    recordComputerActivity(home, { time: new Date().toISOString(), action: "computer_click", x: i, y: i, result: "ok" });
  }
  await expect(checkComputerAction(home, { action: "computer_click", x: 9, y: 9 }))
    .rejects.toThrow("一分钟内电脑操作已满 2 次");
});

test("ComputerGuardTest.test_check_home_null_uses_defaults_only", async () => {
  const d = await checkComputerAction(null, { action: "computer_click", x: 1, y: 2 });
  expect(d.foregroundKnown).toBe(false);
  expect(d.grantId).toBeUndefined();
});

// ---- activeWindow 三平台解析（假 runner） ----

test("ComputerGuardTest.test_active_window_x11", async () => {
  const fake = fakeRunner((argv) => {
    if (argv[0] === "xdotool" && argv[1] === "getactivewindow") return ok("12345\n");
    if (argv[0] === "xdotool" && argv[1] === "getwindowname") return ok("编辑器\n");
    return ok();
  });
  const ctl = x11Control(fake);
  expect(await ctl.activeWindow()).toEqual({ id: "12345", title: "编辑器" });
  const dead = fakeRunner(() => fail(1, "no active window"));
  const ctl2 = x11Control(dead);
  expect(await ctl2.activeWindow()).toBeNull();
});

test("ComputerGuardTest.test_active_window_windows_and_macos", async () => {
  const titleB64 = Buffer.from("记事本", "utf-8").toString("base64");
  const winFake = fakeRunner(() => ok(`456|${titleB64}\n`));
  const winCtl = windowsControl(winFake);
  expect(await winCtl.activeWindow()).toEqual({ id: "456", title: "记事本" });
  expect(winFake.calls[0][0]).toBe("powershell");
  const macFake = fakeRunner(() => ok("Safari|新标签页\n"));
  const macCtl = macosControl(macFake);
  expect(await macCtl.activeWindow()).toEqual({ id: "Safari", title: "新标签页" });
  const macNoWin = fakeRunner(() => ok("Finder|\n"));
  const macCtl2 = macosControl(macNoWin);
  expect(await macCtl2.activeWindow()).toEqual({ id: "Finder", title: "Finder" });
  const macFail = fakeRunner(() => fail(1, "no frontmost"));
  const macCtl3 = macosControl(macFail);
  expect(await macCtl3.activeWindow()).toBeNull();
});

// ---- 虚拟桌面（注入替身，不真起 Xvfb） ----

test("ComputerGuardTest.test_virtual_display_start_stop_injected", () => {
  const home = tmpHome("nyra-cguard-");
  const deps = {
    platform: "linux",
    whichXvfb: () => "/usr/bin/Xvfb",
    spawnXvfb: () => ({ pid: 4242 }) as never,
    isAlive: () => true,
    kill: () => {},
  };
  expect(displayStatus(home).record).toBeNull();
  const record = startVirtualDisplay(home, deps);
  expect(record.display).toBe(":99");
  expect(record.pid).toBe(4242);
  expect(displayStatus(home, deps).alive).toBe(true);
  expect(() => startVirtualDisplay(home, deps)).toThrow("已经在跑");
  expect(stopVirtualDisplay(home, deps)).toBe(true);
  expect(displayStatus(home).record).toBeNull();
  expect(stopVirtualDisplay(home, deps)).toBe(false);
  expect(() => startVirtualDisplay(home, { ...deps, platform: "win32" })).toThrow("只支持 Linux");
  expect(() => startVirtualDisplay(home, { ...deps, whichXvfb: () => null })).toThrow("找不到 Xvfb");
});

// ---- CLI 全程 ----

test("ComputerGuardTest.test_cli_full_flow", async () => {
  const home = tmpHome("nyra-cguard-");
  const cap = capture();
  try {
    expect(await handleComputerGuard(["status"], home)).toBe(0);
    expect(cap.out).toContain("电脑操作守卫");
    expect(cap.out).toContain("授权检查：关");
    expect(await handleComputerGuard(["activity"], home)).toBe(0);
    expect(cap.out).toContain("还没有电脑操作活动");
    expect(await handleComputerGuard(["display", "status"], home)).toBe(0);
    expect(cap.out).toContain("虚拟桌面：未启动");
    expect(await handleComputerGuard(["grant", "issue", "--minutes", "30", "--label", "测试授权"], home)).toBe(0);
    expect(cap.out).toContain("已发授权");
    const idMatch = /cg-[0-9a-f]+/.exec(cap.out);
    expect(idMatch).not.toBeNull();
    const id = idMatch![0];
    expect(await handleComputerGuard(["grants"], home)).toBe(0);
    expect(cap.out).toContain(id);
    expect(await handleComputerGuard(["grant", "revoke", id], home)).toBe(0);
    expect(cap.out).toContain("已撤销授权");
    expect(await handleComputerGuard(["grant", "revoke", id], home)).toBe(1);
    expect(await handleComputerGuard(["blocklist", "add", "测试窗口"], home)).toBe(0);
    expect(cap.out).toContain("已加入禁碰名单");
    expect(await handleComputerGuard(["blocklist"], home)).toBe(0);
    expect(cap.out).toContain("测试窗口");
    expect(await handleComputerGuard(["blocklist", "remove", "测试窗口"], home)).toBe(0);
    expect(cap.out).toContain("已从禁碰名单移除");
    expect(await handleComputerGuard(["blocklist", "remove", "测试窗口"], home)).toBe(1);
    expect(await handleComputerGuard(["require", "grant", "on"], home)).toBe(0);
    expect(cap.out).toContain("授权检查已开启");
    expect(readGuardConfig(home).require_grant).toBe(true);
    expect(await handleComputerGuard(["require", "grant", "off"], home)).toBe(0);
    expect(await handleComputerGuard(["require", "display", "on"], home)).toBe(0);
    expect(readGuardConfig(home).require_virtual_display).toBe(true);
    expect(await handleComputerGuard(["require", "display", "off"], home)).toBe(0);
    expect(await handleComputerGuard(["nope"], home)).toBe(2);
    expect(await handleComputerGuard(["grant", "issue", "--minutes", "abc"], home)).toBe(2);
    expect(await handleComputerGuard(["grant", "revoke"], home)).toBe(2);
  } finally {
    cap.restore();
  }
});

// ---- 工具层接线 ----

test("ComputerGuardTest.test_tools_guard_refusals_and_activity", async () => {
  const home = tmpHome("nyra-cguard-");
  const ctx = toolCtx(home, { computer: fakeComputer() });
  expect(await executeTool("computer_click", { x: 10, y: 20 }, ctx)).toBe("已点击（10, 20，left键）");
  let entries = listComputerActivity(home, 10);
  expect(entries.length).toBe(1);
  expect(entries[0].action).toBe("computer_click");
  expect(entries[0].result).toBe("ok");
  // 授权开关开了、没授权：写动作拒绝（executeTool 把 ToolError 转成“错误：…”文案返回），只读动作照常。
  writeGuardConfig(home, { require_grant: true });
  expect(await executeTool("computer_click", { x: 1, y: 2 }, ctx)).toContain("没有可用的电脑操作授权");
  expect(await executeTool("computer_type", { text: "abc" }, ctx)).toContain("没有可用的电脑操作授权");
  expect(await executeTool("computer_windows", {}, ctx)).toContain("可见窗口");
  entries = listComputerActivity(home, 10);
  expect(entries.filter((e) => e.result === "refused").length).toBe(2);
  // 发了授权就放行。
  issueGrant(home, {});
  expect(await executeTool("computer_click", { x: 1, y: 2 }, ctx)).toBe("已点击（1, 2，left键）");
  writeGuardConfig(home, { require_grant: false });
  // 输入文本只记长度，不记内容。
  expect(await executeTool("computer_type", { text: "secret-text" }, ctx)).toBe("已输入 11 个字符");
  const raw = readFileSync(join(home, ACTIVITY_NAME), "utf-8");
  expect(raw.includes("secret-text")).toBe(false);
  expect(raw.includes("secret")).toBe(false);
  entries = listComputerActivity(home, 10);
  const typed = entries.find((e) => e.action === "computer_type" && e.text_len === 11);
  expect(typed).toBeDefined();
});

test("ComputerGuardTest.test_tools_blocked_foreground_and_key", async () => {
  const home = tmpHome("nyra-cguard-");
  const blocked = fakeComputer({
    activeWindow: async () => ({ id: "9", title: "系统设置" }),
  });
  const ctx = toolCtx(home, { computer: blocked });
  expect(await executeTool("computer_click", { x: 1, y: 2 }, ctx)).toContain("禁碰名单");
  const plain = fakeComputer();
  const ctx2 = toolCtx(home, { computer: plain });
  expect(await executeTool("computer_key", { key: "ctrl+alt+delete" }, ctx2)).toContain("禁按的组合键");
  expect(await executeTool("computer_key", { key: "Enter" }, ctx2)).toBe("已按键：Enter");
  // 工具调用失败也记 error 账本。
  const failing = fakeComputer({ click: async () => { throw new Error("点不动"); } });
  const ctx3 = toolCtx(home, { computer: failing });
  expect(await executeTool("computer_click", { x: 1, y: 2 }, ctx3)).toContain("错误：");
  const entries = listComputerActivity(home, 20);
  expect(entries.some((e) => e.action === "computer_click" && e.result === "error")).toBe(true);
});

// ---- 事件注册 ----

test("ComputerGuardTest.test_events_registered", () => {
  const home = tmpHome("nyra-cguard-");
  const store = new RunStore(join(home, "runs"));
  const run = store.create("t", "sess-1", tmpdir(), "full", 5);
  store.appendEvent(run.run_id, "computer_action", { action: "computer_click", result: "ok", grant_id: "", window: "" });
  store.appendEvent(run.run_id, "computer_refused", { action: "computer_click", reason: "禁碰名单" });
  expect(() => store.appendEvent(run.run_id, "no_such_event_xyz", {})).toThrow("运行事件无效");
});
