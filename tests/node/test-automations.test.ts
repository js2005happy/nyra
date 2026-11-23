// tests/node/test-automations.test.ts — G-P1-37：自动化 bundle。
// 覆盖：内置 3 个装一遍（触发器启用、建议触发器默认关且带标记、
// 线程已建）、未知 id、JSON 文件装与校验正反例、移除清干净、
// 重复安装拒绝、建议触发器列表、线程 cron 引用不存在的工作流时跳过。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationError, BUILTIN_AUTOMATIONS, installAutomation,
  removeAutomation, listAutomations, getAutomation, listInstalledSuggested,
  validateBundleDef, automationBundlesPath,
} from "../../src/automations.ts";
import { listEventTriggers } from "../../src/eventTriggers.ts";
import { listThreads } from "../../src/threads.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("AutomationsTest.test_builtin_ids", () => {
  expect(BUILTIN_AUTOMATIONS.map((b) => b.id)).toEqual([
    "github-pr-triage", "deploy-watch", "gmail-invoice-watch",
  ]);
});

test("AutomationsTest.test_install_github_pr_triage", async () => {
  const home = tmpHome("nyra-auto-");
  const { bundle, warnings } = await installAutomation(home, "github-pr-triage");
  expect(warnings).toEqual([]);
  expect(bundle.trigger_names).toEqual(["pr-triage"]);
  expect(bundle.suggested_names).toEqual(["issue-comment-triage"]);
  expect(bundle.thread_id).toBeTruthy();
  expectPerms(automationBundlesPath(home), 0o600);
  const triggers = listEventTriggers(home);
  const main = triggers.find((t) => t.name === "pr-triage")!;
  expect(main.enabled).toBe(true);
  expect(main.event).toBe("github.pull_request");
  expect(main.mode).toBe("readonly");
  expect((main as { suggested?: boolean }).suggested).toBeUndefined();
  const suggested = triggers.find((t) => t.name === "issue-comment-triage")!;
  expect(suggested.enabled).toBe(false);
  expect(suggested.suggested).toBe(true);
  expect(listThreads(home).length).toBe(1);
  expect(listThreads(home)[0].state).toEqual({ preset: "github-pr-triage" });
  const listed = await listInstalledSuggested(home);
  expect(listed.map((t) => t.name)).toEqual(["issue-comment-triage"]);
  expect(listed[0].enabled).toBe(false);
});

test("AutomationsTest.test_install_all_builtins", async () => {
  const home = tmpHome("nyra-auto-");
  for (const b of BUILTIN_AUTOMATIONS) {
    const r = await installAutomation(home, b.id);
    expect(r.bundle.id).toBe(b.id);
  }
  expect(listAutomations(home).length).toBe(3);
  expect(listEventTriggers(home).length).toBe(5); // 3 启用 + 2 建议
  expect(listThreads(home).length).toBe(3);
  const gmail = listEventTriggers(home).find((t) => t.name === "invoice-mail")!;
  expect(gmail.source).toBe("gmail");
  expect(gmail.event).toBe("gmail.new_mail");
  expect(gmail.match).toEqual({ subject_contains: "发票" });
});

test("AutomationsTest.test_install_unknown_and_duplicate", async () => {
  const home = tmpHome("nyra-auto-");
  await expect(installAutomation(home, "no-such-bundle")).rejects.toThrow(AutomationError);
  await installAutomation(home, "deploy-watch");
  await expect(installAutomation(home, "deploy-watch")).rejects.toThrow(AutomationError);
});

test("AutomationsTest.test_install_from_json_file", async () => {
  const home = tmpHome("nyra-auto-");
  const file = join(home, "my-bundle.json");
  writeFileSync(file, JSON.stringify({
    id: "my-bundle",
    name: "我的 bundle",
    description: "从文件装",
    triggers: [
      { name: "ping", source: "webhook", event: "ping.received", task: "收到 ping：回一声收到。", mode: "readonly" },
    ],
    suggested_triggers: [],
    thread: { title: "my-bundle 自动化" },
  }));
  const { bundle } = await installAutomation(home, file);
  expect(bundle.id).toBe("my-bundle");
  expect(getAutomation(home, "my-bundle").name).toBe("我的 bundle");
  expect(listEventTriggers(home).some((t) => t.name === "ping")).toBe(true);
});

test("AutomationsTest.test_install_from_json_validation", async () => {
  const home = tmpHome("nyra-auto-");
  const bad = join(home, "bad.json");
  // 触发器名重复。
  writeFileSync(bad, JSON.stringify({
    id: "bad-1", name: "坏", description: "",
    triggers: [{ name: "dup", source: "webhook", event: "a.b", task: "t", mode: "readonly" }],
    suggested_triggers: [{ name: "dup", source: "webhook", event: "c.d", task: "t", mode: "readonly" }],
  }));
  await expect(installAutomation(home, bad)).rejects.toThrow(AutomationError);
  // 来源非法。
  writeFileSync(bad, JSON.stringify({
    id: "bad-2", name: "坏", description: "",
    triggers: [{ name: "x", source: "sms", event: "a.b", task: "t", mode: "readonly" }],
    suggested_triggers: [],
  }));
  await expect(installAutomation(home, bad)).rejects.toThrow(AutomationError);
  // thread_crons 没配 thread。
  writeFileSync(bad, JSON.stringify({
    id: "bad-3", name: "坏", description: "",
    triggers: [],
    suggested_triggers: [],
    thread_crons: [{ cron: "0 9 * * *", workflow: "wf" }],
  }));
  await expect(installAutomation(home, bad)).rejects.toThrow(AutomationError);
  // 坏 JSON。
  writeFileSync(bad, "{ not json");
  await expect(installAutomation(home, bad)).rejects.toThrow(AutomationError);
  expect(listAutomations(home)).toEqual([]);
  expect(listEventTriggers(home)).toEqual([]);
});

test("AutomationsTest.test_validate_bundle_def", () => {
  expect(() => validateBundleDef({ id: "bad id!", name: "x", description: "", triggers: [] })).toThrow(AutomationError);
  expect(() => validateBundleDef({ id: "ok", name: "x", description: "", triggers: "nope" })).toThrow(AutomationError);
  const ok = validateBundleDef({
    id: "ok", name: "好", description: "d",
    triggers: [{ name: "t", source: "gmail", event: "gmail.new_mail", task: "做事", mode: "auto" }],
    suggested_triggers: [],
  });
  expect(ok.triggers[0].mode).toBe("auto");
});

test("AutomationsTest.test_thread_cron_missing_workflow_skipped", async () => {
  const home = tmpHome("nyra-auto-");
  const file = join(home, "cron-bundle.json");
  writeFileSync(file, JSON.stringify({
    id: "cron-bundle",
    name: "带 cron 的 bundle",
    description: "引用的工作流不存在",
    triggers: [],
    suggested_triggers: [],
    thread: { title: "cron-bundle 自动化" },
    thread_crons: [{ cron: "0 9 * * 1", workflow: "no-such-workflow" }],
  }));
  const { bundle, warnings } = await installAutomation(home, file);
  expect(bundle.skipped_crons.length).toBe(1);
  expect(bundle.skipped_crons[0].workflow).toBe("no-such-workflow");
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("no-such-workflow");
  const thread = listThreads(home)[0];
  expect(thread.crons).toEqual([]);
});

test("AutomationsTest.test_remove_cleans_triggers_and_thread", async () => {
  const home = tmpHome("nyra-auto-");
  await installAutomation(home, "github-pr-triage");
  await installAutomation(home, "deploy-watch");
  const r = await removeAutomation(home, "github-pr-triage");
  expect(r.removedTriggers).toBe(2);
  expect(r.removedThread).toBe(true);
  expect(listEventTriggers(home).map((t) => t.name)).toEqual(["deploy-done", "deploy-failed"]);
  expect(listAutomations(home).map((b) => b.id)).toEqual(["deploy-watch"]);
  expect(listThreads(home).length).toBe(1);
  await expect(removeAutomation(home, "github-pr-triage")).rejects.toThrow(AutomationError);
});

test("AutomationsTest.test_cli_full_flow", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = tmpHome("nyra-auto-");
  const workdir = tmpHome("nyra-auto-wd-");
  const runCli = (args: string[]) => spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir, encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
  expect(runCli(["automation", "list"]).status).toBe(0);
  const installed = runCli(["automation", "install", "deploy-watch"]);
  expect(installed.status).toBe(0);
  expect(installed.stdout).toContain("deploy-watch");
  expect(installed.stdout).toContain("建议触发器");
  expect(runCli(["automation", "suggested"]).status).toBe(0);
  expect(runCli(["automation", "show", "deploy-watch"]).status).toBe(0);
  expect(runCli(["automation", "remove", "deploy-watch"]).status).toBe(2);
  expect(runCli(["automation", "remove", "deploy-watch", "--yes"]).status).toBe(0);
  expect(listAutomations(home)).toEqual([]);
});
