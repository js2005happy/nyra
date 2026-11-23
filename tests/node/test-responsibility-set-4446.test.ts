// tests/node/test-responsibility-set-4446.test.ts — 缺口 45 深化：责任可改 + 列表标记。
// 改复查节奏 / 汇报规则 / 升级条件 / 过期时间 / 归属人；list 显示下次巡查与到期标记。
// 时间断言一律相对当前时间构造，不写死绝对日期窗口。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addResponsibility, expiryLabel, formatRelativeTime, nextCheckLabel,
  setResponsibilityStatus, updateResponsibility, validateResponsibility,
  type ResponsibilityData,
} from "../../src/responsibilities.ts";

function setup(): { home: string; workdir: string } {
  const home = mkdtempSync(join(tmpdir(), "nyra-resp4446-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-resp4446-wd-"));
  return { home, workdir };
}

function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "依赖安全更新", goal: "检查依赖有没有可用的安全更新，有就记下来",
    every_seconds: 600, report: "on-finding", ...overrides,
  };
}

function newData(): ResponsibilityData {
  return { responsibilities: [] };
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("ResponsibilitySet4446Test.test_update_changes_fields_and_keeps_identity", () => {
  const data = newData();
  const added = addResponsibility(data, makeRaw());
  const expires = new Date(Date.now() + 2 * 86400_000).toISOString();
  const updated = updateResponsibility(data, "依赖安全更新", {
    every_seconds: 3600, report: "always", escalate_on: "发现高危漏洞", expires_at: expires, owner: "alice",
  });
  expect(updated.id).toBe(added.id);
  expect(updated.name).toBe("依赖安全更新");
  expect(updated.goal).toBe(added.goal);
  expect(updated.every_seconds).toBe(3600);
  expect(updated.report).toBe("always");
  expect(updated.escalate_on).toEqual(["发现高危漏洞"]);
  expect(updated.expires_at).toBe(new Date(expires).toISOString());
  expect(updated.owner).toBe("alice");
  expect(updated.status).toBe("active");
  expect(data.responsibilities[0]).toBe(updated);
});

test("ResponsibilitySet4446Test.test_update_revalidates", () => {
  const data = newData();
  addResponsibility(data, makeRaw());
  expect(() => updateResponsibility(data, "依赖安全更新", { every_seconds: 59 })).toThrow(/60/);
  expect(() => updateResponsibility(data, "依赖安全更新", { report: "daily" })).toThrow(/on-finding/);
  expect(() => updateResponsibility(data, "依赖安全更新", { done_when: ["no-such-checker:x"] })).toThrow(/checker/);
  expect(() => updateResponsibility(data, "依赖安全更新", { expires_at: "不是时间" })).toThrow(/ISO/);
  expect(() => updateResponsibility(data, "没有这个责任", { every_seconds: 3600 })).toThrow(/没有这个责任/);
});

test("ResponsibilitySet4446Test.test_update_terminal_refuses", () => {
  const { home } = setup();
  const data = newData();
  addResponsibility(data, makeRaw());
  setResponsibilityStatus(data, "依赖安全更新", "cancelled", home);
  expect(() => updateResponsibility(data, "依赖安全更新", { every_seconds: 3600 })).toThrow(/终态/);
});

test("ResponsibilitySet4446Test.test_relative_time_labels", () => {
  const now = new Date();
  expect(formatRelativeTime(null, now)).toBe("—");
  expect(formatRelativeTime(new Date(now.getTime() + 30_000).toISOString(), now)).toBe("30秒后");
  expect(formatRelativeTime(new Date(now.getTime() + 90_000).toISOString(), now)).toBe("1分后");
  expect(formatRelativeTime(new Date(now.getTime() - 2 * 3600_000).toISOString(), now)).toBe("2小时前");
  expect(formatRelativeTime(new Date(now.getTime() + 3 * 86400_000).toISOString(), now)).toBe("3天后");
  const neverChecked = validateResponsibility(makeRaw());
  expect(nextCheckLabel(neverChecked, now)).toBe("待首次巡查");
  expect(expiryLabel(neverChecked, now)).toBe("不过期");
  const checked = validateResponsibility(makeRaw({
    last_check: new Date(now.getTime() - 100_000).toISOString(), every_seconds: 600,
  }));
  expect(nextCheckLabel(checked, now)).toBe("下次巡查 8分后");
  const paused = validateResponsibility(makeRaw({ enabled: false }));
  expect(nextCheckLabel(paused, now)).toBe("—");
  const expiring = validateResponsibility(makeRaw({ expires_at: new Date(now.getTime() + 2 * 86400_000).toISOString() }));
  expect(expiryLabel(expiring, now)).toBe("到期 2天后");
});

test("ResponsibilitySet4446Test.test_cli_set_and_list_markers", () => {
  const { home } = setup();
  const add = runCli(home, ["responsibility", "add", "--name", "依赖安全更新", "--goal", "检查依赖安全更新", "--every", "600"]);
  expect(add.status).toBe(0);
  expect(add.stdout).toContain("已添加常驻责任");
  const set = runCli(home, ["responsibility", "set", "--name", "依赖安全更新", "--every", "3600", "--report", "always", "--owner", "alice"]);
  expect(set.status).toBe(0);
  expect(set.stdout).toContain("已更新");
  const list = runCli(home, ["responsibility", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("依赖安全更新");
  expect(list.stdout).toContain("待首次巡查");
  expect(list.stdout).toContain("不过期");
  expect(list.stdout).toContain("每次汇报");
  const expires = new Date(Date.now() + 2 * 86400_000 + 3600_000).toISOString();
  const setExpiry = runCli(home, ["responsibility", "set", "--name", "依赖安全更新", "--expires-at", expires]);
  expect(setExpiry.status).toBe(0);
  const list2 = runCli(home, ["responsibility", "list"]);
  expect(list2.stdout).toContain("到期 2天后");
  const setNone = runCli(home, ["responsibility", "set", "--name", "依赖安全更新", "--expires-at", "none"]);
  expect(setNone.status).toBe(0);
  const list3 = runCli(home, ["responsibility", "list"]);
  expect(list3.stdout).toContain("不过期");
  const setNothing = runCli(home, ["responsibility", "set", "--name", "依赖安全更新"]);
  expect(setNothing.status).toBe(2);
  expect(setNothing.stderr).toContain("至少要改一项");
  const setBad = runCli(home, ["responsibility", "set", "--name", "依赖安全更新", "--every", "30"]);
  expect(setBad.status).toBe(1);
  expect(setBad.stderr).toContain("60");
});
