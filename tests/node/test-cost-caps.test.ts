// tests/node/test-cost-caps.test.ts — 缺口 43 第三批：分层成本上限 + 审计导出。
// 钉住的事：
//   - 用量账本按 agent 归属记账（recordDelta 末参），分层按 agent 分组；
//   - setCap：只支持 agent 层每日上限，org / team / role / persona 层与月度
//     维一律拒绝；抬高/取消记放宽 + 审计；旧 caps 文件读时迁移（剥月度字段、
//     丢无剩余限额的层）；
//   - 分层判定：只剩 agent 每日层（美元与 token 两维），美元算不出只判 token、
//     未归属行只会晚触发（incomplete）；
//   - 暂停/恢复/放弃与同 agent 同层同日去重；恢复先重判，还超拒绝；
//   - 暂停同步任务板 paused 状态（attempts 不动）；sweep 遇上限失败走暂停；
//   - 审计导出：JSONL + 哈希链，验链通过、篡改能验出、绝对路径与密钥不进导出；
//   - Agent 回调集成：运行中触顶抛错中止并建暂停记录；
//   - checkAutoAllowed 的分层门：触顶不接单；
//   - CLI 端到端与退出码（check 超限 exit 2、verify 失败 exit 2）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  setCap, listCaps, getCap, assignTeam, evaluateTieredCaps,
  pauseForCap, resumePause, discardPause, listPauses, exportAudit, verifyAuditFile,
  makeTieredCapCheck, parseCapScope, capsPath, pausesPath, CostCapsError,
  type TieredCtxHolder,
} from "../../src/costCaps.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import {
  createKanbanTask, startKanbanTask, getKanbanTask, sweepStaleWorking,
} from "../../src/kanban.ts";
import { checkAutoAllowed } from "../../src/governance.ts";
import { Agent, AgentError } from "../../src/agent.ts";

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

/** 往用量账本记一笔：total_tokens 个 token、spentUsd 美元、归属 agent。 */
function recordUsage(home: string, agent: string | null, tokens: number, spentUsd: number | null): void {
  const ledger = new UsageLedger(home);
  const snap = {
    calls: 1, reported_calls: 1, missing_calls: 0,
    prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens,
    prompt_samples: 0, completion_samples: 0, total_samples: 0,
    last_prompt_tokens: tokens, context_window_tokens: null, context_remaining_tokens: null,
  };
  ledger.recordDelta(snap as never, null, spentUsd, null, "fake-1", new Date(), agent);
}

/** 读治理审计链（append-only jsonl），只取 action 字段。 */
function auditActions(home: string): string[] {
  const path = join(home, "governance-audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { action?: string }).action ?? "");
}

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(_messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

test("CostCapsTest.test_ledger_attribution_by_agent", () => {
  const home = tmpHome("nyra-caps-");
  recordUsage(home, "bot-a", 150, 0.03);
  recordUsage(home, "bot-b", 50, 0.01);
  recordUsage(home, null, 70, null);
  const month = monthKeyString();
  const byAgent = new UsageLedger(home).monthSpendByAgent(month);
  expect(byAgent.byAgent.get("bot-a")?.totalTokens).toBe(150);
  expect(byAgent.byAgent.get("bot-a")?.spentUsd).toBeCloseTo(0.03);
  expect(byAgent.byAgent.get("bot-b")?.totalTokens).toBe(50);
  expect(byAgent.unattributed.totalTokens).toBe(70);
  // 未归属行有未计价花费 → incomplete。
  const total = new UsageLedger(home).monthAgentTotal(month, "bot-a");
  expect(total.totalTokens).toBe(150);
  expect(total.spentUsd).toBeCloseTo(0.03);
  expect(total.incomplete).toBe(true);
});

test("CostCapsTest.test_set_cap_rejects_non_agent_and_monthly", () => {
  const home = tmpHome("nyra-caps-");
  // 月度限额已移除：非 agent 层一律拒绝。
  expect(() => setCap(home, "org", { dayUsd: 10, reason: "测试" })).toThrow(CostCapsError);
  expect(() => setCap(home, "team:t1", { dayTokens: 100, reason: "测试" })).toThrow(CostCapsError);
  expect(() => setCap(home, "role:user", { dayTokens: 100, reason: "测试" })).toThrow(CostCapsError);
  expect(() => setCap(home, "persona:bot-a", { dayTokens: 100, reason: "测试" })).toThrow(CostCapsError);
  expect(listCaps(home)).toEqual([]);
  // 月度维也不再接受：传了直接拒绝（即使是 agent 层）。
  expect(() => setCap(home, "agent:bot-a", { monthUsd: 10, reason: "测试" })).toThrow(CostCapsError);
  expect(() => setCap(home, "agent:bot-a", { monthTokens: 100, reason: "测试" })).toThrow(CostCapsError);
  // 旧 config 里的月度上限也不再有任何效力。
  writeFileSync(join(home, "config.json"), JSON.stringify({ monthly_cost_limit_usd: 5 }));
  const cap = setCap(home, "agent:bot-a", { dayUsd: 4, dayTokens: 1000, reason: "测试" });
  expect(cap.scope).toBe("agent:bot-a");
  expect(cap.dayUsd).toBe(4);
  expectPerms(capsPath(home), 0o600);
  expect(auditActions(home)).toContain("cost_cap_set");
});

test("CostCapsTest.test_set_cap_relax_records_audit", () => {
  const home = tmpHome("nyra-caps-");
  setCap(home, "agent:bot-a", { dayUsd: 1, reason: "测试" });
  // 抬高上限 = 放宽，记 relaxations + cost_cap_relaxed。
  const raised = setCap(home, "agent:bot-a", { dayUsd: 5, reason: "测试" });
  expect(raised.dayUsd).toBe(5);
  const store = JSON.parse(readFileSync(capsPath(home), "utf-8")) as {
    relaxations: { scope: string; field: string; old_value: number | null; new_value: number | null }[];
  };
  expect(store.relaxations.length).toBe(1);
  expect(store.relaxations[0]).toMatchObject({ scope: "agent:bot-a", field: "dayUsd", oldValue: 1, newValue: 5 });
  expect(auditActions(home)).toContain("cost_cap_relaxed");
  // 取消上限同样是放宽。
  setCap(home, "agent:bot-a", { dayUsd: null, dayTokens: null, reason: "测试" });
  expect(getCap(home, "agent:bot-a")).toBeNull();
  const store2 = JSON.parse(readFileSync(capsPath(home), "utf-8")) as { relaxations: unknown[] };
  expect(store2.relaxations.length).toBe(3); // 抬高 1 条 + 取消时 dayUsd 1 条 + cap-removed 1 条
  // 范围写坏了拒绝。
  expect(() => parseCapScope("agent:")).toThrow(CostCapsError);
  expect(() => parseCapScope("role:admin")).toThrow(CostCapsError);
  expect(() => parseCapScope("bogus:x")).toThrow(CostCapsError);
});

test("CostCapsTest.test_evaluate_agent_day_layer", () => {
  const home = tmpHome("nyra-caps-");
  recordUsage(home, "bot-a", 150, 0.03);
  setCap(home, "agent:bot-a", { dayTokens: 100, reason: "测试" });
  // team 层已随月度限额移除，不能再设。
  expect(() => setCap(home, "team:t1", { dayTokens: 10000, reason: "测试" })).toThrow(CostCapsError);
  assignTeam(home, "bot-a", "t1");
  const ev = evaluateTieredCaps(home, { agent: "bot-a" });
  expect(ev.allowed).toBe(false);
  expect(ev.bindingScope).toBe("agent:bot-a:day");
  expect(ev.bindingReason).toContain("agent:bot-a:day");
  expect(ev.bindingReason).toContain("当日");
  // 没超的 agent 放行。
  recordUsage(home, "bot-b", 10, null);
  const ok = evaluateTieredCaps(home, { agent: "bot-b" });
  expect(ok.allowed).toBe(true);
  expect(ok.bindingScope).toBeNull();
});

test("CostCapsTest.test_legacy_monthly_caps_migrated_away", () => {
  const home = tmpHome("nyra-caps-");
  // 旧文件：team 层月度上限 + agent 层只剩月度字段 + agent 层已有每日上限。
  writeFileSync(join(home, "cost-caps.json"), JSON.stringify({
    version: 1,
    caps: [
      { scope: "team:t1", kind: "team", monthUsd: 10, monthTokens: 100, setBy: "t", setAt: "2026-11-01T00:00:00.000Z", reason: "旧" },
      { scope: "agent:bot-a", kind: "agent", monthUsd: 0.01, monthTokens: 100, setBy: "t", setAt: "2026-11-01T00:00:00.000Z", reason: "旧" },
      { scope: "agent:bot-b", kind: "agent", monthUsd: null, monthTokens: null, dayUsd: 0.5, dayTokens: null, setBy: "t", setAt: "2026-11-01T00:00:00.000Z", reason: "新" },
    ],
    agentTeams: {}, relaxations: [{ id: "cr_old", at: "2026-11-01T00:00:00.000Z", scope: "agent:bot-a", field: "monthUsd", oldValue: 1, newValue: 5, by: "t", reason: "旧" }],
  }));
  // 读时迁移：只剩每日上限的 agent:bot-b 留下，其余层丢掉；relaxations 历史不重写。
  expect(listCaps(home).map((c) => c.scope)).toEqual(["agent:bot-b"]);
  expect(getCap(home, "agent:bot-b")?.dayUsd).toBe(0.5);
  const store = JSON.parse(readFileSync(capsPath(home), "utf-8")) as { relaxations: { field: string }[] };
  expect(store.relaxations[0].field).toBe("monthUsd");
  // bot-a 当日花再多也不再被旧月度上限拦。
  recordUsage(home, "bot-a", 150, 0.03);
  expect(evaluateTieredCaps(home, { agent: "bot-a" }).allowed).toBe(true);
  // bot-b 的每日上限照常生效。
  recordUsage(home, "bot-b", 10, 0.6);
  expect(evaluateTieredCaps(home, { agent: "bot-b" }).allowed).toBe(false);
});

test("CostCapsTest.test_evaluate_usd_layer_and_unpriced_only_token", () => {
  const home = tmpHome("nyra-caps-");
  recordUsage(home, "bot-a", 10, 0.5);
  setCap(home, "agent:bot-a", { dayUsd: 0.4, dayTokens: 100000, reason: "测试" });
  const ev = evaluateTieredCaps(home, { agent: "bot-a" });
  expect(ev.allowed).toBe(false);
  expect(ev.bindingReason).toContain("$0.50");
  // 美元没计价时只判 token：花了 10 token、没花钱，上限 100 token → 放行。
  const home2 = tmpHome("nyra-caps-");
  recordUsage(home2, "bot-a", 10, null);
  setCap(home2, "agent:bot-a", { dayUsd: 0.01, dayTokens: 100, reason: "测试" });
  expect(evaluateTieredCaps(home2, { agent: "bot-a" }).allowed).toBe(true);
  // 进行中花费也算进去。
  const ev2 = evaluateTieredCaps(home2, { agent: "bot-a", inProgressUsd: 0.02, inProgressTokens: 95 });
  expect(ev2.allowed).toBe(false);
});

test("CostCapsTest.test_pause_resume_discard_lifecycle", () => {
  const home = tmpHome("nyra-caps-");
  recordUsage(home, "bot-a", 150, null);
  setCap(home, "agent:bot-a", { dayTokens: 100, reason: "测试" });
  const ev = evaluateTieredCaps(home, { agent: "bot-a" });
  const pause = pauseForCap(home, ev, { taskId: "task-1" });
  expect(pause).not.toBeNull();
  expect(pause!.agent).toBe("bot-a");
  expect(pause!.scope).toBe("agent:bot-a:day");
  expect(pause!.taskId).toBe("task-1");
  expectPerms(pausesPath(home), 0o600);
  // 同 agent 同层同日去重：再暂停一次返回同一条。
  const again = pauseForCap(home, ev, {});
  expect(again!.id).toBe(pause!.id);
  expect(listPauses(home).length).toBe(1);
  // 恢复先重判：还超就拒绝。
  expect(() => resumePause(home, pause!.id, "test")).toThrow(CostCapsError);
  // 放宽上限后再恢复：放行。
  setCap(home, "agent:bot-a", { dayTokens: 1000, reason: "测试" });
  const resumed = resumePause(home, pause!.id, "test");
  expect(resumed.status).toBe("resumed");
  expect(auditActions(home)).toContain("cost_cap_paused");
  expect(auditActions(home)).toContain("cost_cap_resumed");
  // 没超限时手动暂停也建一条（scope 为 manual），可放弃。
  const pause2 = pauseForCap(home, evaluateTieredCaps(home, { agent: "bot-a" }), {});
  expect(pause2.scope).toBe("manual");
  const discarded2 = discardPause(home, pause2.id, "test");
  expect(discarded2.status).toBe("discarded");
  recordUsage(home, "bot-a", 2000, null);
  const pause3 = pauseForCap(home, evaluateTieredCaps(home, { agent: "bot-a" }), {});
  expect(pause3.scope).toBe("agent:bot-a:day");
  const discarded = discardPause(home, pause3.id, "test");
  expect(discarded.status).toBe("discarded");
  expect(listPauses(home).filter((p) => p.status === "paused")).toEqual([]);
});

test("CostCapsTest.test_pause_syncs_kanban_paused_state", () => {
  const home = tmpHome("nyra-caps-");
  recordUsage(home, "bot-a", 150, null);
  setCap(home, "agent:bot-a", { dayTokens: 100, reason: "测试" });
  const task = createKanbanTask(home, { title: "上限任务", agent: "bot-a" });
  startKanbanTask(home, task.id, "run-1");
  const pause = pauseForCap(home, evaluateTieredCaps(home, { agent: "bot-a" }), { taskId: task.id, runId: "run-1" });
  expect(pause).not.toBeNull();
  const after = getKanbanTask(home, task.id);
  expect(after.status).toBe("paused");
  // 暂停不是失败：attempts 不动。
  expect(after.attempts).toBe(0);
  // 恢复暂停后任务板 paused → queued。
  setCap(home, "agent:bot-a", { dayTokens: 1000, reason: "测试" });
  resumePause(home, pause!.id, "test");
  expect(getKanbanTask(home, task.id).status).toBe("queued");
});

test("CostCapsTest.test_sweep_cap_failure_pauses_not_fails", () => {
  const home = tmpHome("nyra-caps-");
  const task = createKanbanTask(home, { title: "扫荡任务" });
  startKanbanTask(home, task.id, "run-cap");
  const report = sweepStaleWorking(
    home,
    (runId) => (runId === "run-cap" ? "failed" : null),
    (runId) => (runId === "run-cap" ? "AgentError: 分层成本上限已超（agent:bot-a token 150/100）" : null),
  );
  expect(report.swept).toBe(1);
  const after = getKanbanTask(home, task.id);
  expect(after.status).toBe("paused");
  expect(after.attempts).toBe(0);
  // 普通失败仍走 fail 路径。
  const task2 = createKanbanTask(home, { title: "普通失败任务" });
  startKanbanTask(home, task2.id, "run-plain");
  sweepStaleWorking(
    home,
    (runId) => (runId === "run-plain" ? "failed" : null),
    (runId) => (runId === "run-plain" ? "Error: 模型调用失败" : null),
  );
  const after2 = getKanbanTask(home, task2.id);
  expect(after2.status).toBe("queued");
  expect(after2.attempts).toBe(1);
});

test("CostCapsTest.test_export_audit_hash_chain_and_tamper", () => {
  const home = tmpHome("nyra-caps-");
  setCap(home, "agent:bot-a", { dayUsd: 1, reason: "测试" });
  const out = join(home, "audit-export.jsonl");
  const res = exportAudit(home, { out: out });
  expect(res.lines).toBeGreaterThan(0); // 数据行（不含头部）：cost_cap_set 一条
  expect(existsSync(out)).toBe(true);
  expectPerms(out, 0o600);
  const check = verifyAuditFile(home, out);
  expect(check.ok).toBe(true);
  expect(check.lines).toBe(res.lines);
  // 篡改一行正文 → 验链失败。
  const lines = readFileSync(out, "utf-8").trim().split("\n");
  const tampered = JSON.parse(lines[1]) as Record<string, unknown>;
  tampered.action = "forged_action";
  lines[1] = JSON.stringify(tampered);
  const badPath = join(home, "audit-tampered.jsonl");
  writeFileSync(badPath, lines.join("\n") + "\n");
  const bad = verifyAuditFile(home, badPath);
  expect(bad.ok).toBe(false);
  expect(bad.firstError).toContain("hash");
  // 导出操作本身进了审计链。
  expect(auditActions(home)).toContain("audit_exported");
  // 已存在的文件拒写（除非 --force）。
  expect(() => exportAudit(home, { out: out })).toThrow(CostCapsError);
  expect(() => exportAudit(home, { out: out, force: true })).not.toThrow();
});

test("CostCapsTest.test_export_redacts_paths_and_secrets", () => {
  const home = tmpHome("nyra-caps-");
  // 手写一条含绝对路径与密钥字段的审计行，看导出里是否脱敏。
  // 注意：值里别写 sk-… 样的秘钥样字符串（环境层会先脱敏，测不到代码行为）。
  const auditPath = join(home, "governance-audit.jsonl");
  writeFileSync(auditPath, JSON.stringify({
    at: "2026-11-21T10:00:00.000Z", action: "policy_changed",
    detail: `策略文件在 ${home}/governance-policy.json`, api_key: "plain-value-123",
  }) + "\n");
  const out = join(home, "audit-export.jsonl");
  exportAudit(home, { out: out });
  const text = readFileSync(out, "utf-8");
  expect(text).not.toContain(home);
  expect(text).not.toContain("plain-value-123");
  expect(text).toContain("<redacted>");
  expect(text).toContain("[home]");
  // 脱敏后的导出照样能验链通过。
  expect(verifyAuditFile(home, out).ok).toBe(true);
});

test("CostCapsTest.test_agent_callback_stops_run_and_pauses", async () => {
  const home = tmpHome("nyra-caps-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-caps-wd-"));
  recordUsage(home, "bot-a", 150, null);
  setCap(home, "agent:bot-a", { dayTokens: 100, reason: "测试" });
  const ctx: TieredCtxHolder = { runId: "run-agent-1" };
  const agent = new Agent(new FakeProvider([textReply("你好")]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
    tieredCapCheck: makeTieredCapCheck(home, "bot-a", ctx),
  });
  await expect(agent.run("说你好")).rejects.toThrow("分层成本上限已超");
  const pauses = listPauses(home);
  expect(pauses.length).toBe(1);
  expect(pauses[0].runId).toBe("run-agent-1");
  expect(pauses[0].agent).toBe("bot-a");
});

test("CostCapsTest.test_check_auto_allowed_tiered_gate", () => {
  const home = tmpHome("nyra-caps-");
  recordUsage(home, "bot-a", 150, null);
  setCap(home, "agent:bot-a", { dayTokens: 100, reason: "测试" });
  const denied = checkAutoAllowed(home, "bot-a");
  expect(denied.allowed).toBe(false);
  expect(denied.reason).toContain("分层成本上限已触顶");
  const ok = checkAutoAllowed(home, "bot-b");
  expect(ok.allowed).toBe(true);
});

test("CostCapsTest.test_cli_caps_and_audit_end_to_end", () => {
  const home = tmpHome("nyra-caps-");
  const set = runCli(home, ["governance", "caps", "set", "--scope", "agent:bot-a", "--day-tokens", "100", "--reason", "测试", "--yes"]);
  expect(set.status).toBe(0);
  expect(set.stdout).toContain("agent:bot-a");
  const oldFlag = runCli(home, ["governance", "caps", "set", "--scope", "agent:bot-a", "--tokens", "100", "--reason", "测试", "--yes"]);
  expect(oldFlag.status).not.toBe(0);
  const list = runCli(home, ["governance", "caps", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("agent:bot-a");
  recordUsage(home, "bot-a", 150, null);
  // check 超限退出码 2。
  const check = runCli(home, ["governance", "caps", "check", "--agent", "bot-a"]);
  expect(check.status).toBe(2);
  expect(check.stdout).toContain("层 token 上限已超");
  // pause / pauses / resume / discard 走 CLI。
  const pause = runCli(home, ["governance", "caps", "pause", "--agent", "bot-a", "--reason", "测试"]);
  expect(pause.status).toBe(0);
  const pauses = runCli(home, ["governance", "caps", "pauses", "--json"]);
  expect(pauses.status).toBe(0);
  const parsed = JSON.parse(pauses.stdout) as { id: string }[];
  expect(parsed.length).toBe(1);
  const discard = runCli(home, ["governance", "caps", "discard", parsed[0].id, "--yes"]);
  expect(discard.status).toBe(0);
  // 审计导出与验证走 CLI。
  const out = join(home, "audit.jsonl");
  const exp = runCli(home, ["governance", "audit", "export", "--out", out]);
  expect(exp.status).toBe(0);
  expect(existsSync(out)).toBe(true);
  const verify = runCli(home, ["governance", "audit", "verify", out]);
  expect(verify.status).toBe(0);
  expect(verify.stdout).toContain("通过");
  // 篡改后 verify 退出码 2。
  const lines = readFileSync(out, "utf-8").trim().split("\n");
  const tampered = JSON.parse(lines[1]) as Record<string, unknown>;
  tampered.action = "forged";
  lines[1] = JSON.stringify(tampered);
  const badPath = join(home, "audit-bad.jsonl");
  writeFileSync(badPath, lines.join("\n") + "\n");
  const bad = runCli(home, ["governance", "audit", "verify", badPath]);
  expect(bad.status).toBe(2);
});

test("CostCapsTest.test_kanban_pause_resume_cli", () => {
  const home = tmpHome("nyra-caps-");
  const created = runCli(home, ["kanban", "create", "上限暂停任务"]);
  expect(created.status).toBe(0);
  const id = created.stdout.trim();
  const started = runCli(home, ["kanban", "start", id]);
  expect(started.status).toBe(0);
  const paused = runCli(home, ["kanban", "pause", id, "分层成本上限已超"]);
  expect(paused.status).toBe(0);
  expect(paused.stdout).toContain("已暂停");
  expect(getKanbanTask(home, id).status).toBe("paused");
  const resumed = runCli(home, ["kanban", "resume", id]);
  expect(resumed.status).toBe(0);
  expect(getKanbanTask(home, id).status).toBe("queued");
});
