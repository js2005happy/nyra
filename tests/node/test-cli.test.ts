// tests/node/test-cli.test.ts — 对应 tests/test_cli_providers.py（35 唯一）+ test_commands.py（19 唯一）的核心项，
// 外加 vault 子命令、信任、自定义命令与 --json/--plan 冒烟。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs, isTrusted, addTrusted, listCustomCommands, handleVault, USAGE,
  parseCompactCommand, formatContextUsage, contextSuggestion,
} from "../../src/cli.ts";
import { VERSION } from "../../src/config.ts";

test("CliTest.test_version_string", () => {
  expect(VERSION).toBe("0.5.8");
  expect(USAGE).toContain("0.5.8");
});

test("CliTest.test_parse_args_flags", () => {
  const a = parseArgs(["--help"]);
  expect(a.help).toBe(true);
  const b = parseArgs(["--version"]);
  expect(b.version).toBe(true);
  const c = parseArgs(["--list-providers", "--list-skills", "--list-sessions"]);
  expect(c.listProviders).toBe(true);
  expect(c.listSkills).toBe(true);
  expect(c.listSessions).toBe(true);
});

test("CliTest.test_parse_args_value_flags", () => {
  const a = parseArgs(["--provider", "xai", "--model", "grok-4.3", "--mode", "auto", "--max-turns", "5"]);
  expect(a.provider).toBe("xai");
  expect(a.model).toBe("grok-4.3");
  expect(a.mode).toBe("auto");
  expect(a.maxTurns).toBe(5);
  const b = parseArgs(["--provider=xai", "--model=grok-4.3", "--max-turns=3"]);
  expect(b.provider).toBe("xai");
  expect(b.model).toBe("grok-4.3");
  expect(b.maxTurns).toBe(3);
});

test("CliTest.test_parse_args_task_positional", () => {
  const a = parseArgs(["帮我写个脚本"]);
  expect(a.task).toBe("帮我写个脚本");
  const b = parseArgs(["--json", "做点事"]);
  expect(b.jsonMode).toBe(true);
  expect(b.task).toBe("做点事");
});

test("CliTest.test_parse_args_subcommand_first", () => {
  const a = parseArgs(["schedule", "list"]);
  expect(a.subcommand).toBe("schedule");
  expect(a.subArgs).toEqual(["list"]);
  const b = parseArgs(["kb", "list"]);
  expect(b.subcommand).toBe("kb");
  const c = parseArgs(["vault", "list"]);
  expect(c.subcommand).toBe("vault");
});

test("CliTest.test_parse_args_unknown_flag", () => {
  const a = parseArgs(["--no-such-flag"]);
  expect(a.unknown).toBe("--no-such-flag");
  const b = parseArgs(["--provider"]);
  expect(b.unknown).toBe("--provider");
});

test("CliTest.test_parse_args_plan_and_verify", () => {
  const a = parseArgs(["--plan", "做计划", "--verify", "true", "--verify-timeout", "60", "--verify-retries", "2"]);
  expect(a.planMode).toBe(true);
  expect(a.verify).toBe("true");
  expect(a.verifyTimeout).toBe(60);
  expect(a.verifyRetries).toBe(2);
  const b = parseArgs(["--execute-plan", "--approve-plan", "abc123"]);
  expect(b.executePlan).toBe(true);
  expect(b.approvePlan).toBe("abc123");
});

test("CliTest.test_parse_args_resume", () => {
  const a = parseArgs(["--resume", "20261118-000000-ab12"]);
  expect(a.resume).toBe("20261118-000000-ab12");
  const b = parseArgs(["--resume-run", "20261118-000000-ab12"]);
  expect(b.resumeRun).toBe("20261118-000000-ab12");
});

test("CliTest.test_trust_add_and_check", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-trust-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-trust-wd-"));
  expect(isTrusted(wd, home)).toBe(false);
  addTrusted(wd, home);
  expect(isTrusted(wd, home)).toBe(true);
  expect(existsSync(join(home, "trusted_workspaces.json"))).toBe(true);
  // 再次添加不重复、不报错。
  addTrusted(wd, home);
  expect(isTrusted(wd, home)).toBe(true);
});

test("CliTest.test_trust_reads_python_dict_format", () => {
  // Python 版 nyra/trust.py 的字典格式 {"version": 1, "folders": {...}} 必须能读。
  const home = mkdtempSync(join(tmpdir(), "nyra-trust-py-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-trust-py-wd-"));
  const other = mkdtempSync(join(tmpdir(), "nyra-trust-py-other-"));
  writeFileSync(join(home, "trusted_workspaces.json"), JSON.stringify({
    version: 1,
    folders: { [wd]: { trusted_at: "2026-11-18T00:00:00+0000" } },
  }) + "\n");
  expect(isTrusted(wd, home)).toBe(true);
  expect(isTrusted(other, home)).toBe(false);
  // 追加写入后旧条目不丢失（转为数组格式），文件权限 0600。
  addTrusted(other, home);
  expect(isTrusted(wd, home)).toBe(true);
  expect(isTrusted(other, home)).toBe(true);
  const parsed = JSON.parse(readFileSync(join(home, "trusted_workspaces.json"), "utf-8")) as unknown;
  expect(Array.isArray(parsed)).toBe(true);
  expect((parsed as string[]).length).toBe(2);
  // Windows 没有 POSIX 权限位，写盘默认 0666，不断言 0600。
  if (process.platform !== "win32") {
    expectPerms(join(home, "trusted_workspaces.json"), 0o600);
  }
});

test("CliTest.test_list_custom_commands", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cmd-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-cmd-wd-"));
  mkdirSync(join(wd, ".nyra", "commands"), { recursive: true });
  writeFileSync(join(wd, ".nyra", "commands", "deploy.md"), "# 部署\n");
  writeFileSync(join(wd, ".nyra", "commands", "review.md"), "# 评审\n");
  const cmds = listCustomCommands(wd, home);
  expect(cmds).toContain("deploy");
  expect(cmds).toContain("review");
});

test("CliTest.test_vault_init_add_get_list_remove", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-vault-cli-"));
  const input = { passwords: ["pw-12345", "pw-12345"], secrets: ["sk-test-abc"] };
  expect(await handleVault(["init"], home, input)).toBe(0);
  expect(await handleVault(["add", "DEEPSEEK_API_KEY"], home, input)).toBe(0);
  expect(await handleVault(["list"], home, input)).toBe(0);
  expect(await handleVault(["get", "DEEPSEEK_API_KEY"], home, input)).toBe(0);
  expect(await handleVault(["get", "NO_SUCH_KEY"], home, input)).toBe(1);
  expect(await handleVault(["remove", "DEEPSEEK_API_KEY"], home, input)).toBe(0);
  expect(await handleVault(["list"], home, input)).toBe(0);
});

test("CliTest.test_vault_rejects_password_from_argv", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-vault-cli-"));
  const input = { passwords: ["pw-12345", "pw-12345"], secrets: [] };
  // add 多一个 argv 参数即返回 2（密钥绝不从 argv 读）。
  expect(await handleVault(["add", "K", "secret-from-argv"], home, input)).toBe(2);
  expect(await handleVault(["bogus-cmd"], home, input)).toBe(2);
});

function runCli(args: string[], home: string): { code: number; out: string } {
  const r = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" }, // 断言的是中文界面文案
    encoding: "utf-8", timeout: 60000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("CliTest.test_binary_help_and_version", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const help = runCli(["--help"], home);
  expect(help.code).toBe(0);
  expect(help.out).toContain("nyra");
  const ver = runCli(["--version"], home);
  expect(ver.code).toBe(0);
  expect(ver.out).toContain("0.5.8");
});

test("CliTest.test_binary_list_providers_skills_sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const prov = runCli(["--list-providers"], home);
  expect(prov.code).toBe(0);
  expect(prov.out).toContain("deepseek");
  const skills = runCli(["--list-skills"], home);
  expect(skills.code).toBe(0);
  expect(skills.out).toContain("debugging");
  const sessions = runCli(["--list-sessions"], home);
  expect(sessions.code).toBe(0);
});

test("CliTest.test_binary_json_no_task_exit_2", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const r = runCli(["--json"], home);
  expect(r.code).toBe(2);
  expect(r.out).toContain("schema_version");
  expect(r.out).toContain("invalid_arguments");
});

test("CliTest.test_parse_args_subcommand_provider_prescan", () => {
  // 回归：parseArgs 在子命令 early-return 前先扫 --provider/--model，
  // 否则 setup --provider nope 里的 provider 恒为 undefined，向导按配置跑。
  const a = parseArgs(["setup", "--provider", "nope"]);
  expect(a.subcommand).toBe("setup");
  expect(a.subArgs).toEqual(["--provider", "nope"]);
  expect(a.provider).toBe("nope");
  const b = parseArgs(["setup", "--provider=nope", "--model", "m1"]);
  expect(b.provider).toBe("nope");
  expect(b.model).toBe("m1");
  const c = parseArgs(["setup"]);
  expect(c.subcommand).toBe("setup");
  expect(c.provider).toBeUndefined();
  // schedule/task 等仍从 subArgs 取自己的参数，预扫不影响它们。
  const d = parseArgs(["schedule", "list"]);
  expect(d.subcommand).toBe("schedule");
  expect(d.subArgs).toEqual(["list"]);
  expect(d.provider).toBeUndefined();
  const e = parseArgs(["task", "list"]);
  expect(e.subcommand).toBe("task");
  expect(e.subArgs).toEqual(["list"]);
});

test("CliTest.test_binary_setup_unknown_provider_one_line_error", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-setup-"));
  const r = runCli(["setup", "--provider", "nope"], home);
  expect(r.code).toBe(1);
  expect(r.out).toContain("模型配置有问题");
  expect(r.out).not.toContain("at ");
  expect(r.out).not.toContain(".ts:");
  const ex = runCli(["--example", "--provider", "nope"], home);
  expect(ex.code).toBe(1);
  expect(ex.out).toContain("模型配置有问题");
  expect(ex.out).not.toContain("at ");
});

test("CliTest.test_binary_setup_no_flag_unchanged", () => {
  // 无 flag 的 setup 仍进向导（管道 stdin EOF 时按默认一路走完），不报配置错。
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-setup-"));
  const r = runCli(["setup"], home);
  expect(r.out).toContain("欢迎使用 Nyra");
  expect(r.out).not.toContain("模型配置有问题");
});

test("CliTest.test_binary_memory_export_import_roundtrip", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const nyraHome = join(home, ".nyra");
  mkdirSync(nyraHome, { recursive: true });
  writeFileSync(join(nyraHome, "MEMORY.md"), "## 事实\n\n- 用户是学生\n\n## 偏好\n\n- 喜欢中文\n");
  const exp = runCli(["memory", "export"], home);
  expect(exp.code).toBe(0);
  expect(exp.out).toContain("用户是学生");
  const imp = runCli(["memory", "import"], home);
  expect(imp.code).toBe(0);
});

test("CliTest.test_binary_permissions_roundtrip", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-perm-"));
  const list0 = runCli(["permissions", "list"], home);
  expect(list0.code).toBe(0);
  expect(JSON.parse(list0.out).count).toBe(0);
  const noConfirm = runCli(["permissions", "grant", "--site", "https://example.com", "--scope", "read"], home);
  expect(noConfirm.code).toBe(1);
  expect(noConfirm.out).toContain("需要用户显式 --confirm");
  const grant = runCli(["permissions", "grant", "--site", "https://example.com", "--scope", "read", "--confirm"], home);
  expect(grant.code).toBe(0);
  expect(JSON.parse(grant.out).changed).toBe(true);
  const check = runCli(["permissions", "check", "--site", "https://example.com", "--scope", "read"], home);
  expect(check.code).toBe(0);
  const checked = JSON.parse(check.out);
  expect(checked.local_intent).toBe("recorded");
  expect(checked.may_execute_remote_action).toBe(false);
  const list1 = runCli(["permissions", "list"], home);
  expect(JSON.parse(list1.out).count).toBe(1);
  const audit = runCli(["permissions", "audit"], home);
  expect(audit.code).toBe(0);
  expect(JSON.parse(audit.out).events.length).toBe(1);
  const revoke = runCli(["permissions", "revoke", "--site", "https://example.com", "--scope", "read"], home);
  expect(revoke.code).toBe(0);
  expect(JSON.parse(revoke.out).changed).toBe(true);
});

test("CliTest.test_binary_eigenflux_doctor_and_onboarding", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-ef-"));
  const doc = runCli(["eigenflux", "doctor"], home);
  expect(doc.code).toBe(0);
  const report = JSON.parse(doc.out);
  expect(report.status).toBe("not_checked");
  expect(report.network_actions_allowed).toBe(false);
  const checked = runCli(["eigenflux", "doctor", "--check"], home);
  // 本机无 eigenflux 二进制：状态 cli_not_installed，退出 1（与 Python 口径一致）。
  expect(checked.code).toBe(1);
  expect(JSON.parse(checked.out).status).toBe("cli_not_installed");
  const onb = runCli(["eigenflux", "onboarding"], home);
  expect(onb.code).toBe(0);
  const steps = JSON.parse(onb.out);
  expect(steps.blocked).toBe(true);
  expect(steps.requiresHumanOnboarding).toBe(true);
  const policy0 = runCli(["eigenflux", "policy", "show"], home);
  expect(policy0.code).toBe(0);
  const shown = JSON.parse(policy0.out);
  expect(shown.network_actions_enabled).toBe(false);
  expect(shown.capabilities.feed_read.local_intent).toBe("denied");
  const noConfirm = runCli(["eigenflux", "policy", "allow", "--capability", "feed_read"], home);
  expect(noConfirm.code).toBe(1);
  expect(noConfirm.out).toContain("必须由用户显式提供 --confirm");
  const allow = runCli(["eigenflux", "policy", "allow", "--capability", "feed_read", "--confirm"], home);
  expect(allow.code).toBe(0);
  expect(JSON.parse(allow.out).changed).toBe(true);
  expect(JSON.parse(allow.out).local_intent).toBe("allowed");
  const policy1 = runCli(["eigenflux", "policy", "show"], home);
  expect(JSON.parse(policy1.out).capabilities.feed_read.local_intent).toBe("allowed");
  expect(JSON.parse(policy1.out).network_actions_enabled).toBe(false);
  const audit = runCli(["eigenflux", "policy", "audit"], home);
  expect(audit.code).toBe(0);
  expect(JSON.parse(audit.out).events.length).toBe(1);
  const deny = runCli(["eigenflux", "policy", "deny", "--capability", "feed_read"], home);
  expect(deny.code).toBe(0);
  expect(JSON.parse(deny.out).changed).toBe(true);
});

function runCliInWorkdir(args: string[], home: string, workdir: string): { code: number; out: string } {
  const r = spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), ...args], {
    cwd: workdir,
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" }, // 断言的是中文界面文案
    encoding: "utf-8", timeout: 60000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("CliTest.test_creator_pomodoro_e2e", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-creator-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-cli-creator-work-"));
  const res = runCliInWorkdir(["creator", "做个番茄钟", "--yes"], home, workdir);
  expect(res.code).toBe(0);
  expect(res.out).toContain("已安装 pomodoro 0.1.0");
  expect(existsSync(join(workdir, ".nyra", "creator", "pomodoro", "spec.md"))).toBe(true);
  expect(existsSync(join(home, ".nyra", "plugins", "pomodoro", "panel", "pomodoro.html"))).toBe(true);
  const list = runCliInWorkdir(["plugin", "list"], home, workdir);
  expect(list.out).toContain("pomodoro");
  const skills = runCliInWorkdir(["--list-skills"], home, workdir);
  expect(skills.out).toContain("pomodoro");
  const un = runCliInWorkdir(["plugin", "uninstall", "pomodoro"], home, workdir);
  expect(un.code).toBe(0);
});

test("CliTest.test_creator_todo_scan_verify_and_unknown", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-creator-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-cli-creator-work-"));
  const res = runCliInWorkdir(["creator", "扫描 TODO", "--yes"], home, workdir);
  expect(res.code).toBe(0);
  expect(res.out).toContain("已安装 todo-scan 0.1.0");
  const staging = join(workdir, ".nyra", "creator", "todo-scan", "staging");
  const verify = runCliInWorkdir(["creator", "verify", staging], home, workdir);
  expect(verify.code).toBe(0);
  expect(verify.out).toContain("验证通过");
  const unknown = runCliInWorkdir(["creator", "给我做个天气插件"], home, workdir);
  expect(unknown.code).toBe(1);
  expect(unknown.out).toContain("没有现成的模板");
});

test("CliTest.test_parse_args_creator_mode", () => {
  const a = parseArgs(["--mode", "creator", "做点事"]);
  expect(a.mode).toBe("creator");
  const b = parseArgs(["creator", "做个番茄钟", "--yes"]);
  expect(b.subcommand).toBe("creator");
  expect(b.subArgs).toEqual(["做个番茄钟", "--yes"]);
  expect(USAGE).toContain("creator");
});

// ---- 调研报告第 3 项：上下文补齐（学 Claude Code）----

test("ContextCliTest.test_parse_compact_command", () => {
  expect(parseCompactCommand("/compact")).toEqual({ focus: "" });
  expect(parseCompactCommand("/compact focus 部署")).toEqual({ focus: "部署" });
  expect(parseCompactCommand("/compact focus 部署 回滚")).toEqual({ focus: "部署 回滚" });
  // 缺关键词、未知参数：分发返回 null，REPL 打印用法，不当任务发给模型。
  expect(parseCompactCommand("/compact focus")).toBeNull();
  expect(parseCompactCommand("/compact foo")).toBeNull();
  expect(parseCompactCommand("/context")).toBeNull();
});

test("ContextCliTest.test_format_context_usage_reported_and_estimated", () => {
  const reported = {
    system: 100, skills: 0, history: 300, toolResults: 100, totalChars: 500,
    windowTokens: 1000, usedTokens: 125, estimated: false,
  };
  const out = formatContextUsage(reported);
  expect(out).toContain("系统提示：100（20%）");
  expect(out).toContain("技能全文：0（0%）");
  expect(out).toContain("对话历史：300（60%）");
  expect(out).toContain("工具结果：100（20%）");
  expect(out).toContain("总计：500 字符");
  expect(out).toContain("模型窗口：1,000 tokens");
  expect(out).toContain("已用 token：125（模型实报）");
  expect(out).not.toContain("估算");
  // 对话历史 > 50% 时建议 /compact focus。
  expect(out).toContain("/compact focus");
  const estimated = { ...reported, usedTokens: 125, estimated: true, windowTokens: null };
  const out2 = formatContextUsage(estimated);
  expect(out2).toContain("约 125（估算：4 字符 ≈ 1 token，模型未报告用量）");
  // 窗口未知时不再只写“未配置”，同时给下一步（模型表自动识别后仍未知时）。
  expect(out2).toContain("模型窗口：未知");
  expect(out2).toContain("nyra models refresh");
});

test("ContextCliTest.test_context_suggestion_thresholds", () => {
  const base = { system: 0, skills: 0, history: 0, toolResults: 0, totalChars: 0, windowTokens: null, usedTokens: 0, estimated: true };
  expect(contextSuggestion(base)).toContain("无需优化");
  expect(contextSuggestion({ ...base, system: 30, history: 30, toolResults: 40, totalChars: 100 })).toContain("均衡");
  expect(contextSuggestion({ ...base, system: 60, history: 40, totalChars: 100 })).toContain("系统提示");
  expect(contextSuggestion({ ...base, skills: 60, history: 40, totalChars: 100 })).toContain("技能全文");
  expect(contextSuggestion({ ...base, toolResults: 60, history: 40, totalChars: 100 })).toContain("工具结果");
});

test("ContextCliTest.test_usage_documents_context_and_compact_focus", () => {
  expect(USAGE).toContain("/context");
  expect(USAGE).toContain("/compact focus");
});
