// tests/node/test-governance.test.ts — 缺口 43 企业治理控制面（DSH-1 + DSH-2）。
// 钉住的事：
//   - Policy 版本化：首次发布 v1、哈希随版本变、规则写坏拒绝发布、历史保留；
//   - Mandate 不可变：绑定发布时 Policy 版本；重验证 current / renewed /
//     conflicted 三态；已撤销拒绝续跑；superseded 链顺着找到当前授权；
//   - Policy 发布通知受影响的授权与工单（任务板未终态任务 + 收件箱）；
//   - observe/auto 两档：默认 observe；切 auto 须显式；
//   - 干跑记录：只记不执行、同动作去重、定夺后不能再定；
//   - 分层每日上限门：没配上限不挡人，配了且已触顶就拒绝（月度上限已移除）；
//   - 续跑/恢复钩子：resume 的 prepare 与 side-effects 的 recover 都先重验证；
//   - sweep 的 auto 续跑在 observe 模式下只记干跑；Heartbeat 同样只记干跑；
//   - CLI 端到端与退出码（冲突重验证 exit 2、切 auto 没 --yes exit 2）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  publishPolicy, getCurrentPolicy, loadPolicyStore, issueMandate, getMandate, listMandates,
  revalidateMandate, revalidateMandateForResume, revokeMandate,
  getAgentMode, setAgentMode, recordDryRun, listDryRuns, decideDryRun,
  checkAutoAllowed, evaluateProactiveAction, GovernanceError,
  policyPath, mandatePath,
} from "../../src/governance.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import { setCap } from "../../src/costCaps.ts";
import { createKanbanTask } from "../../src/kanban.ts";
import { loadInbox } from "../../src/tasks.ts";
import {
  registerSubagentRun, loadSubagentRegistry, saveSubagentRegistry, sweepSubagents,
  prepareSubagentResume,
} from "../../src/resume.ts";
import { recordSideEffect, getSideEffect, recoverSideEffects } from "../../src/sideEffects.ts";
import { addHeartbeatMonitor, runHeartbeat } from "../../src/heartbeat.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("GovernanceTest.test_policy_publish_versions_and_hash", () => {
  const home = tmpHome("nyra-gov-");
  const v1 = publishPolicy(home, { reason: "第一版" });
  expect(v1.policy.version).toBe(1);
  expect(v1.policy.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(v1.affectedMandates).toEqual([]);
  expectPerms(policyPath(home), 0o600);
  // 规则写坏了拒绝发布，不静默丢规则。
  expect(() => publishPolicy(home, { reason: "坏规则", rules: { allow: [], ask: [], deny: ["!!!不是规则"] } }))
    .toThrow(GovernanceError);
  const v2 = publishPolicy(home, { reason: "第二版", rules: { allow: ["Bash(git *)"], ask: [], deny: [] } });
  expect(v2.policy.version).toBe(2);
  expect(v2.policy.hash).not.toBe(v1.policy.hash);
  const store = loadPolicyStore(home);
  expect(store.current?.version).toBe(2);
  expect(store.history).toHaveLength(1);
  expect(store.history[0].version).toBe(1);
  // 不给规则 = 沿用当前策略的规则。
  const v3 = publishPolicy(home, { reason: "第三版" });
  expect(v3.policy.rules.allow).toEqual(["Bash(git *)"]);
  expect(getCurrentPolicy(home).version).toBe(3);
  // 原因必填、不能超长。
  expect(() => publishPolicy(home, { reason: "  " })).toThrow(GovernanceError);
  expect(() => publishPolicy(home, { reason: "x".repeat(301) })).toThrow(GovernanceError);
});

test("GovernanceTest.test_mandate_revalidate_states", () => {
  const home = tmpHome("nyra-gov-");
  const m = issueMandate(home, { scope: "agent:nyra", issuer: "owner", channel: "cli" });
  expect(m.id).toMatch(/^md_[0-9a-f]{12}$/);
  expect(m.policyVersion).toBe(1);
  expect(m.strength).toBe("observe");
  expectPerms(mandatePath(home), 0o600);
  // 已是当前版本 → current。
  expect(revalidateMandate(home, m.id).result).toBe("current");
  // 发新策略（无冲突）→ renewed，旧授权标 superseded。
  publishPolicy(home, { reason: "加一条不冲突的规则", rules: { allow: ["Read"], ask: [], deny: [] } });
  const renewed = revalidateMandate(home, m.id);
  expect(renewed.result).toBe("renewed");
  expect(renewed.newMandateId).not.toBeNull();
  expect(renewed.mandate.id).toBe(renewed.newMandateId);
  expect(getMandate(home, m.id).status).toBe("superseded");
  expect(getMandate(home, m.id).supersededBy).toBe(renewed.newMandateId);
  // 顺着旧 id 验，跟着 superseded 链找到当前授权。
  const viaOld = revalidateMandate(home, m.id);
  expect(viaOld.result).toBe("current");
  expect(viaOld.mandate.id).toBe(renewed.newMandateId);
  // 发一条与授权冲突的策略：授权允许 Bash(git *)，策略拒绝它。
  const m2 = issueMandate(home, {
    scope: "agent:nyra", issuer: "owner",
    rules: { allow: ["Bash(git *)"], ask: [], deny: [] },
  });
  publishPolicy(home, { reason: "收紧 git", rules: { allow: [], ask: [], deny: ["Bash(git *)"] } });
  const conflicted = revalidateMandate(home, m2.id);
  expect(conflicted.result).toBe("conflicted");
  expect(conflicted.conflicts.length).toBeGreaterThan(0);
  expect(conflicted.conflicts[0]).toContain("Bash(git *)");
  expect(() => revalidateMandateForResume(home, m2.id)).toThrow(/冲突/);
  // 撤销后拒绝续跑。
  revokeMandate(home, m2.id, "不再需要");
  expect(getMandate(home, m2.id).status).toBe("revoked");
  expect(() => revalidateMandate(home, m2.id)).toThrow(/已撤销/);
  expect(() => revalidateMandate(home, "md_000000000000")).toThrow(/找不到授权/);
  // 授权签发校验。
  expect(() => issueMandate(home, { scope: "", issuer: "x" })).toThrow(GovernanceError);
  expect(() => issueMandate(home, { scope: "agent:nyra", issuer: "" })).toThrow(GovernanceError);
  expect(() => issueMandate(home, { scope: "agent:nyra", issuer: "x", strength: "turbo" as never })).toThrow(GovernanceError);
  expect(listMandates(home, { status: "revoked" })).toHaveLength(1);
});

test("GovernanceTest.test_policy_publish_notifies_affected", () => {
  const home = tmpHome("nyra-gov-");
  const task = createKanbanTask(home, { title: "给 nyra 的活", kind: "task", agent: "nyra" });
  const other = createKanbanTask(home, { title: "给别人的活", kind: "task", agent: "other" });
  const m = issueMandate(home, { scope: "agent:nyra", issuer: "owner" });
  const result = publishPolicy(home, { reason: "新版策略" });
  expect(result.affectedMandates).toEqual([m.id]);
  expect(result.affectedTasks).toEqual([task.id]);
  expect(result.affectedTasks).not.toContain(other.id);
  expect(result.notifyError).toBeNull();
  const inbox = loadInbox(home);
  expect(inbox.some((i) => String(i.summary).includes("策略已发布 v2"))).toBe(true);
});

test("GovernanceTest.test_mode_defaults_and_set", () => {
  const home = tmpHome("nyra-gov-");
  expect(getAgentMode(home, "nyra")).toBe("observe");
  expect(setAgentMode(home, "nyra", "auto", "cli")).toBe("auto");
  expect(getAgentMode(home, "nyra")).toBe("auto");
  expect(setAgentMode(home, "nyra", "observe", "cli")).toBe("observe");
  expect(() => setAgentMode(home, "Bad Name", "auto", "cli")).toThrow(GovernanceError);
  expect(() => setAgentMode(home, "nyra", "turbo" as never, "cli")).toThrow(GovernanceError);
});

test("GovernanceTest.test_dry_run_record_decide_dedup", () => {
  const home = tmpHome("nyra-gov-");
  const a = recordDryRun(home, { agent: "nyra", kind: "resume_subagent", action: "resume", target: "run-1", reason: "observe 模式" });
  expect(a.id).toMatch(/^dr_[0-9a-f]{12}$/);
  expect(a.status).toBe("recorded");
  // 同一待办只留一条未定的记录，不重复记。
  const b = recordDryRun(home, { agent: "nyra", kind: "resume_subagent", action: "resume", target: "run-1", reason: "observe 模式" });
  expect(b.id).toBe(a.id);
  expect(listDryRuns(home)).toHaveLength(1);
  const decided = decideDryRun(home, a.id, "promoted", "owner");
  expect(decided.status).toBe("promoted");
  expect(decided.decidedBy).toBe("owner");
  expect(() => decideDryRun(home, a.id, "discarded", "owner")).toThrow(/不能再定/);
  expect(() => decideDryRun(home, "dr_000000000000", "promoted", "owner")).toThrow(/找不到干跑记录/);
  // 定夺后同动作可再记一条新的。
  const c = recordDryRun(home, { agent: "nyra", kind: "resume_subagent", action: "resume", target: "run-1", reason: "observe 模式" });
  expect(c.id).not.toBe(a.id);
  expect(listDryRuns(home, { status: "recorded" })).toHaveLength(1);
  expect(listDryRuns(home, { agent: "other" })).toHaveLength(0);
});

test("GovernanceTest.test_tiered_daily_cap_gate", () => {
  const home = tmpHome("nyra-gov-");
  // 没配分层每日上限就不挡人（月度上限已移除，旧 config 键也不拦）。
  writeFileSync(join(home, "config.json"), JSON.stringify({ monthly_cost_limit_usd: 0.5 }), "utf-8");
  expect(checkAutoAllowed(home, "nyra").allowed).toBe(true);
  // 配了每日上限、还没花 → 放行；花超了 → 拒绝。
  setCap(home, "agent:nyra", { dayUsd: 0.5, reason: "测试" });
  expect(checkAutoAllowed(home, "nyra").allowed).toBe(true);
  new UsageLedger(home).recordDelta(
    { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, calls: 1 },
    null, 1.0, null, "test-model", new Date(), "nyra",
  );
  const blocked = checkAutoAllowed(home, "nyra");
  expect(blocked.allowed).toBe(false);
  expect(blocked.monthSpentUsd).toBeCloseTo(1.0);
  expect(blocked.reason).toContain("分层成本上限已触顶");
  expect(blocked.reason).toContain("当日");
  // 分层每日上限已触顶时，would-accept 评估直接 would-deny。
  const verdict = evaluateProactiveAction(home, "nyra", { kind: "resume_subagent", target: "run-1" });
  expect(verdict.decision).toBe("would-deny");
  expect(verdict.reason).toContain("分层成本上限已触顶");
});

test("GovernanceTest.test_evaluate_proactive_action", () => {
  const home = tmpHome("nyra-gov-");
  // observe 模式：评估通过，只记干跑。
  const v1 = evaluateProactiveAction(home, "nyra", { kind: "resume_subagent", target: "run-1" });
  expect(v1.decision).toBe("would-accept");
  expect(v1.mode).toBe("observe");
  expect(v1.reason).toContain("observe");
  expect(v1.requiresApproval).toBe(false);
  // gmail_send 命中红线表 approve 档：可接，但须人批。
  const v2 = evaluateProactiveAction(home, "nyra", { kind: "send", target: "x", tool: "gmail_send" });
  expect(v2.decision).toBe("would-accept");
  expect(v2.requiresApproval).toBe(true);
  // auto 模式：评估通过可执行（仍受硬顶与审批约束）。
  setAgentMode(home, "nyra", "auto", "cli");
  const v3 = evaluateProactiveAction(home, "nyra", { kind: "resume_subagent", target: "run-1" });
  expect(v3.decision).toBe("would-accept");
  expect(v3.mode).toBe("auto");
  expect(v3.reason).toContain("auto");
});

test("GovernanceTest.test_sweep_auto_observe_only_dry_runs", async () => {
  const home = tmpHome("nyra-gov-");
  const row = registerSubagentRun(home, { runId: "run-sweep-1", agent: "nyra", autoResume: true });
  expect(row.status).toBe("running");
  // 默认 observe：sweep 只记干跑，不真续跑（也没 runner 可跑）。
  const report = await sweepSubagents(home, { auto: true });
  expect(report.markedPending).toContain("run-sweep-1");
  expect(report.dryRuns).toContain("run-sweep-1");
  expect(report.resumed).toEqual([]);
  const runs = listDryRuns(home, { agent: "nyra" });
  expect(runs.some((d) => d.target === "run-sweep-1" && d.kind === "resume_subagent")).toBe(true);
});

test("GovernanceTest.test_prepare_resume_revalidates_mandate", () => {
  const home = tmpHome("nyra-gov-");
  const m = issueMandate(home, { scope: "agent:nyra", issuer: "owner" });
  const row = registerSubagentRun(home, { runId: "run-resume-1", agent: "nyra", mandateId: m.id });
  // 把行标成 resume_pending（没有运行记录，续跑会在找记录那步失败）。
  const registry = loadSubagentRegistry(home);
  const found = registry.runs.find((r) => r.runId === row.runId)!;
  found.status = "resume_pending";
  saveSubagentRegistry(home, registry);
  // 撤销授权 → prepare 直接拒绝，不碰运行记录。
  revokeMandate(home, m.id, "测试撤销");
  expect(() => prepareSubagentResume(home, "run-resume-1")).toThrow(/已撤销/);
  // 换一个授权：发新策略后，prepare 先换发授权、再因找不到运行记录失败——
  // 换发本身已落盘，旧授权 superseded。
  const m2 = issueMandate(home, { scope: "agent:nyra", issuer: "owner" });
  const registry2 = loadSubagentRegistry(home);
  registry2.runs.find((r) => r.runId === row.runId)!.mandateId = m2.id;
  saveSubagentRegistry(home, registry2);
  publishPolicy(home, { reason: "新版策略" });
  expect(() => prepareSubagentResume(home, "run-resume-1")).toThrow(/找不到运行记录/);
  expect(getMandate(home, m2.id).status).toBe("superseded");
  const renewed = listMandates(home, { status: "active" }).find((x) => x.scope === "agent:nyra")!;
  expect(renewed.policyVersion).toBe(2);
});

test("GovernanceTest.test_side_effects_recover_revalidates_mandate", async () => {
  const home = tmpHome("nyra-gov-");
  const m = issueMandate(home, { scope: "agent:nyra", issuer: "owner" });
  const bad = recordSideEffect(home, { description: "绑了撤销授权的副作用", mandateId: m.id });
  revokeMandate(home, m.id, "测试撤销");
  const report = await recoverSideEffects(home, {});
  expect(report.failed).toContain(bad.id);
  expect(getSideEffect(home, bad.id).status).toBe("failed");
  expect(String(getSideEffect(home, bad.id).recoveryNote)).toContain("授权重验证失败");
  // 换发路径：发新策略后恢复，授权更新绑定、副作用留待人工（无执行器）。
  const m2 = issueMandate(home, { scope: "agent:nyra", issuer: "owner" });
  const ok = recordSideEffect(home, { description: "绑了旧版授权的副作用", mandateId: m2.id });
  publishPolicy(home, { reason: "新版策略" });
  const report2 = await recoverSideEffects(home, {});
  expect(report2.leftPending).toContain(ok.id);
  const after = getSideEffect(home, ok.id);
  expect(after.mandateId).not.toBe(m2.id);
  expect(getMandate(home, m2.id).status).toBe("superseded");
});

test("GovernanceTest.test_heartbeat_observe_records_dry_run", () => {
  const home = tmpHome("nyra-gov-");
  addHeartbeatMonitor(home, { agent: "nyra", intervalMinutes: 30 });
  const row = registerSubagentRun(home, { runId: "run-hb-1", agent: "nyra" });
  const registry = loadSubagentRegistry(home);
  registry.runs.find((r) => r.runId === row.runId)!.status = "resume_pending";
  saveSubagentRegistry(home, registry);
  const result = runHeartbeat(home, "nyra", { force: true });
  expect(result.findings.some((f) => f.kind === "resume_pending")).toBe(true);
  const runs = listDryRuns(home, { agent: "nyra" });
  expect(runs.some((d) => d.target === "run-hb-1" && d.kind === "resume_subagent")).toBe(true);
  // 第二次巡查不重复记（去重）。
  runHeartbeat(home, "nyra", { force: true });
  expect(listDryRuns(home, { agent: "nyra" }).filter((d) => d.target === "run-hb-1")).toHaveLength(1);
});

test("GovernanceTest.test_cli_end_to_end", () => {
  const home = tmpHome("nyra-gov-");
  const p1 = runCli(home, ["governance", "policy", "publish", "--reason", "第一版"]);
  expect(p1.status).toBe(0);
  expect(p1.stdout).toContain("策略已发布 v1");
  const show = runCli(home, ["governance", "policy", "show", "--json"]);
  expect(show.status).toBe(0);
  expect(JSON.parse(show.stdout).version).toBe(1);
  const mi = runCli(home, ["governance", "mandate", "issue", "--scope", "agent:nyra", "--issuer", "owner", "--allow", "Bash(git *)"]);
  expect(mi.status).toBe(0);
  expect(mi.stdout).toMatch(/授权已签发 md_[0-9a-f]{12}/);
  const list = runCli(home, ["governance", "mandate", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("agent:nyra");
  // 切 auto 没 --yes 拒绝。
  const noYes = runCli(home, ["governance", "mode", "set", "--agent", "nyra", "auto"]);
  expect(noYes.status).toBe(2);
  expect(getAgentMode(home, "nyra")).toBe("observe");
  const yes = runCli(home, ["governance", "mode", "set", "--agent", "nyra", "auto", "--yes"]);
  expect(yes.status).toBe(0);
  expect(getAgentMode(home, "nyra")).toBe("auto");
  // 冲突重验证：策略拒绝授权允许的规则，退出码 2。
  runCli(home, ["governance", "policy", "publish", "--reason", "收紧 git", "--deny", "Bash(git *)"]);
  const mandateId = listMandates(home)[0].id;
  const conflicted = runCli(home, ["governance", "mandate", "revalidate", mandateId]);
  expect(conflicted.status).toBe(2);
  expect(conflicted.stdout).toContain("冲突");
  const dry = runCli(home, ["governance", "dry-runs", "list"]);
  expect(dry.status).toBe(0);
  // 坏规则拒绝发布。
  const bad = runCli(home, ["governance", "policy", "publish", "--reason", "坏", "--deny", "!!!"]);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("规则写坏了");
});
