// tests/node/test-policy.test.ts — O1：CEL 风格策略网关。
// 表达式解析/求值、账本、checkApproval 接线、CLI，均在临时 home 上验，
// 不联网、不调真模型、不写真实 ~/.nyra。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPolicyRule,
  evaluatePolicy,
  evaluatePolicyCall,
  evaluateRule,
  globMatch,
  handlePolicy,
  loadPolicy,
  parsePolicyExpression,
  removePolicyRule,
  setPolicyDryRun,
  setPolicyRuleEnabled,
  POLICY_AUDIT_FILE,
  type PolicyContext,
  type PolicyStore,
} from "../../src/policy.ts";
import { checkApproval, newToolContext, resetPermissionRulesCache } from "../../src/tools.ts";
import { saveConfig } from "../../src/config.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctxFor(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    "tool.name": "shell",
    "tool.target": "ls",
    "bot.id": "default",
    "actor.id": "default",
    "actor.role": "",
    "file.path": "",
    "initiator.kind": "person",
    command: "ls",
    "page.url": "",
    "page.host": "",
    "mcp.server": "",
    "mcp.tool": "",
    mode: "full",
    ...over,
  };
}

function rule(action: "allow" | "ask" | "deny", when: string, enabled = true) {
  return {
    id: "pol_0123456789ab",
    action,
    when,
    description: "",
    enabled,
    created_at: "",
  };
}

function storeWith(rules: ReturnType<typeof rule>[], dryRun = false): PolicyStore {
  return { version: 1, dry_run: dryRun, rules };
}

// ---- 表达式解析 ----

test("PolicyTest.test_parse_basic_comparison", () => {
  const ast = parsePolicyExpression('tool.name == "shell"');
  expect(typeof ast).not.toBe("string");
  expect(evaluateRule(rule("deny", 'tool.name == "shell"'), ctxFor())).toBe(true);
  expect(evaluateRule(rule("deny", 'tool.name == "read_file"'), ctxFor())).toBe(false);
});

test("PolicyTest.test_parse_logic_and_parens", () => {
  const c = ctxFor({ "tool.name": "shell", "initiator.kind": "routine" });
  expect(evaluateRule(rule("deny", 'tool.name == "shell" && initiator.kind == "routine"'), c)).toBe(true);
  expect(evaluateRule(rule("deny", 'tool.name == "shell" && initiator.kind == "person"'), c)).toBe(false);
  expect(evaluateRule(rule("deny", '!(tool.name == "shell")'), c)).toBe(false);
  expect(evaluateRule(rule("deny", '(tool.name == "read_file" || tool.name == "shell") && bot.id == "default"'), c)).toBe(true);
});

test("PolicyTest.test_parse_in_matches_string_ops", () => {
  const c = ctxFor({ "file.path": "src/policy.ts", "initiator.kind": "cron", command: "git status" });
  expect(evaluateRule(rule("deny", 'initiator.kind in ["routine", "cron"]'), c)).toBe(true);
  expect(evaluateRule(rule("deny", 'initiator.kind in ["routine"]'), c)).toBe(false);
  expect(evaluateRule(rule("deny", 'file.path matches "src/**"'), c)).toBe(true);
  expect(evaluateRule(rule("deny", 'file.path matches "docs/**"'), c)).toBe(false);
  expect(evaluateRule(rule("deny", 'command startsWith "git "'), c)).toBe(true);
  expect(evaluateRule(rule("deny", 'command contains "status"'), c)).toBe(true);
  expect(evaluateRule(rule("deny", 'command contains "push"'), c)).toBe(false);
});

test("PolicyTest.test_parse_rejects_unknown_field_and_bad_syntax", () => {
  expect(typeof parsePolicyExpression("nope.field == \"x\"")).toBe("string");
  expect(typeof parsePolicyExpression('tool.name == "shell')).toBe("string");
  expect(typeof parsePolicyExpression("")).toBe("string");
  expect(typeof parsePolicyExpression('tool.name == "shell" &&')).toBe("string");
  expect(typeof parsePolicyExpression('tool.name == "shell"')).not.toBe("string");
  // 类型错误只在求值期报（解析只校验语法与字段名）。
  expect(typeof evaluateRule(rule("deny", "tool.name matches 3"), ctxFor())).toBe("string");
});

test("PolicyTest.test_glob_match", () => {
  expect(globMatch("src/**", "src/policy.ts")).toBe(true);
  expect(globMatch("src/*.ts", "src/policy.ts")).toBe(true);
  expect(globMatch("*.ts", "src/policy.ts")).toBe(true);
  expect(globMatch("docs/**", "src/policy.ts")).toBe(false);
  expect(globMatch("a?c", "abc")).toBe(true);
  expect(globMatch("a?c", "ac")).toBe(false);
});

// ---- 求值次序与 fail-closed ----

test("PolicyTest.test_deny_beats_allow_and_ask", () => {
  const c = ctxFor();
  const store = storeWith([
    rule("allow", 'tool.name == "shell"'),
    rule("deny", 'tool.name == "shell"'),
  ]);
  const d = evaluatePolicy(store, c);
  expect(d.decision).toBe("deny");
  expect(d.rule?.action).toBe("deny");
});

test("PolicyTest.test_ask_beats_allow_no_match_null", () => {
  const c = ctxFor();
  const ask = evaluatePolicy(storeWith([
    rule("allow", 'tool.name == "shell"'),
    rule("ask", 'tool.name == "shell"'),
  ]), c);
  expect(ask.decision).toBe("ask");
  const none = evaluatePolicy(storeWith([rule("allow", 'tool.name == "read_file"')]), c);
  expect(none.decision).toBe(null);
});

test("PolicyTest.test_disabled_rule_ignored", () => {
  const c = ctxFor();
  const d = evaluatePolicy(storeWith([rule("deny", 'tool.name == "shell"', false)]), c);
  expect(d.decision).toBe(null);
});

test("PolicyTest.test_bad_deny_rule_fails_closed_bad_allow_does_not", () => {
  // deny 规则表达式无效（加载时已被 loadPolicy 滤掉；这里直接测 evaluateRule
  // 对已加载的坏表达式求值出错的路径）：未知字段在解析期报错。
  const c = ctxFor();
  const badDeny = evaluateRule({ ...rule("deny", 'tool.name == "shell"'), when: "nope.field == \"x\"" }, c);
  expect(typeof badDeny).toBe("string");
  // evaluatePolicy 对坏 deny 规则按命中处理（fail-closed）。
  const store: PolicyStore = {
    version: 1,
    dry_run: false,
    rules: [{ ...rule("deny", 'nope.field == "x"') }],
  };
  expect(evaluatePolicy(store, c).decision).toBe("deny");
  const allowStore: PolicyStore = {
    version: 1,
    dry_run: false,
    rules: [{ ...rule("allow", 'nope.field == "x"') }],
  };
  expect(evaluatePolicy(allowStore, c).decision).toBe(null);
});

// ---- 账本 ----

test("PolicyTest.test_store_roundtrip_and_cli_add", async () => {
  const home = tmpHome("nyra-policy-store-");
  const r = addPolicyRule(home, "deny", 'tool.name == "shell"', "禁 shell");
  expect(r.id).toMatch(/^pol_[0-9a-f]{12}$/);
  const loaded = loadPolicy(home);
  expect(loaded.store.rules).toHaveLength(1);
  expect(loaded.store.rules[0]!.when).toBe('tool.name == "shell"');
  expect(loaded.store.rules[0]!.description).toBe("禁 shell");
  expect(loaded.corrupt).toBe(false);
  // 坏表达式加不进去。
  expect(() => addPolicyRule(home, "deny", 'nope.field == "x"')).toThrow(/未知字段/);
  expect(loadPolicy(home).store.rules).toHaveLength(1);
  // 停用/启用/删除。
  expect(setPolicyRuleEnabled(home, r.id, false)).toBe(true);
  expect(loadPolicy(home).store.rules[0]!.enabled).toBe(false);
  expect(setPolicyRuleEnabled(home, r.id, true)).toBe(true);
  expect(removePolicyRule(home, r.id)).toBe(true);
  expect(loadPolicy(home).store.rules).toHaveLength(0);
  expect(removePolicyRule(home, r.id)).toBe(false);
  // dry-run 开关。
  setPolicyDryRun(home, true);
  expect(loadPolicy(home).store.dry_run).toBe(true);
  setPolicyDryRun(home, false);
  expect(loadPolicy(home).store.dry_run).toBe(false);
  rmSync(home, { recursive: true, force: true });
});

test("PolicyTest.test_corrupt_store_is_no_policy_with_audit", () => {
  const home = tmpHome("nyra-policy-corrupt-");
  writeFileSync(join(home, "policy.json"), "{ 不是 json", { mode: 0o600 });
  const loaded = loadPolicy(home);
  expect(loaded.corrupt).toBe(true);
  expect(loaded.store.rules).toHaveLength(0);
  expect(loaded.warnings.length).toBeGreaterThan(0);
  // 损坏记了审计，但不拦默认流程：无规则 = 不命中。
  const auditPath = join(home, POLICY_AUDIT_FILE);
  expect(existsSync(auditPath)).toBe(true);
  expect(readFileSync(auditPath, "utf-8")).toContain("load_failed");
  const result = evaluatePolicyCall(home, { tool: "shell" });
  expect(result.decision).toBe(null);
  expect(result.corrupt).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

// ---- checkApproval 接线 ----

test("PolicyTest.test_check_approval_policy_deny_blocks_shell", async () => {
  const home = tmpHome("nyra-policy-deny-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-policy-work-"));
  addPolicyRule(home, "deny", 'tool.name == "shell" && command startsWith "rm "', "禁删命令");
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    approveFn: async () => true,
    onEvent: (type, data) => { events.push({ type, data }); },
  });
  await expect(checkApproval(ctx, "shell", "删文件", { command: "rm -rf /tmp/x", cwd: workdir })).rejects.toThrow(/策略网关拒绝/);
  expect(events.some((e) => e.type === "policy_denied")).toBe(true);
  const audit = readFileSync(join(home, POLICY_AUDIT_FILE), "utf-8");
  expect(audit).toContain("denied");
  // 不命中 deny 的命令不受影响。
  await checkApproval(ctx, "shell", "列文件", { command: "ls", cwd: workdir });
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("PolicyTest.test_check_approval_policy_deny_beats_permission_allow", async () => {
  const home = tmpHome("nyra-policy-deny-allow-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-policy-work2-"));
  saveConfig(home, { permissions: { allow: ["shell"] } });
  resetPermissionRulesCache();
  addPolicyRule(home, "deny", 'tool.name == "shell"');
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    approveFn: async () => true,
  });
  await expect(checkApproval(ctx, "shell", "跑命令", { command: "ls", cwd: workdir })).rejects.toThrow(/策略网关拒绝/);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("PolicyTest.test_check_approval_policy_allow_fast_path", async () => {
  const home = tmpHome("nyra-policy-allow-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-policy-work3-"));
  addPolicyRule(home, "allow", 'tool.name == "read_file"');
  let approveCalls = 0;
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    approveFn: async () => { approveCalls += 1; return true; },
  });
  await checkApproval(ctx, "read_file", "读文件", { fileTarget: "a.txt" });
  // allow 规则直接放行，不经过人工审批函数。
  expect(approveCalls).toBe(0);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("PolicyTest.test_check_approval_policy_ask_forces_manual_chain", async () => {
  const home = tmpHome("nyra-policy-ask-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-policy-work4-"));
  addPolicyRule(home, "ask", 'tool.name == "shell" && initiator.kind == "routine"', "例行跑命令须人批");
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    routineId: "routine-1",
    initiatorKind: "routine",
    approveFn: async () => true,
    onEvent: (type, data) => { events.push({ type, data }); },
  });
  await checkApproval(ctx, "shell", "例行跑命令", { command: "ls", cwd: workdir });
  expect(events.some((e) => e.type === "policy_ask")).toBe(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("PolicyTest.test_check_approval_policy_dry_run_does_not_block", async () => {
  const home = tmpHome("nyra-policy-dryrun-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-policy-work5-"));
  addPolicyRule(home, "deny", 'tool.name == "shell"');
  setPolicyDryRun(home, true);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    approveFn: async () => true,
    onEvent: (type, data) => { events.push({ type, data }); },
  });
  await checkApproval(ctx, "shell", "跑命令", { command: "ls", cwd: workdir });
  expect(events.some((e) => e.type === "policy_dry_run" && e.data.would === "deny")).toBe(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

// ---- CLI ----

test("PolicyTest.test_cli_add_test_list", async () => {
  const home = tmpHome("nyra-policy-cli-");
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    expect(await handlePolicy(["add", "deny", 'tool.name == "shell"'], home)).toBe(0);
    expect(await handlePolicy(["test", "--tool", "shell"], home)).toBe(0);
    expect(await handlePolicy(["test", "--tool", "read_file"], home)).toBe(0);
    expect(await handlePolicy(["list"], home)).toBe(0);
    expect(await handlePolicy(["add", "deny", 'nope.field == "x"'], home)).toBe(2);
    expect(await handlePolicy(["dry-run", "on"], home)).toBe(0);
    expect(await handlePolicy(["status"], home)).toBe(0);
  } finally {
    console.log = origLog;
  }
  expect(lines.some((l) => l.includes("命中规则"))).toBe(true);
  expect(lines.some((l) => l.includes("没有规则命中"))).toBe(true);
  expect(loadPolicy(home).store.dry_run).toBe(true);
  rmSync(home, { recursive: true, force: true });
});
