// tests/node/test-tool-judge.test.ts — Turnstone 意向验证 judge（打分制）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline } from "../../src/timeline.ts";
import {
  judgeConfig, judgeEnabled, resolveJudgeModel, judgedTools, verdictForScore,
  JUDGE_SYSTEM_PROMPT, buildJudgeMessages, parseJudgeOutput, judgeToolCall,
  buildJudgeRunner, judgeStatus, DEFAULT_JUDGE_DENY_AT, DEFAULT_JUDGE_ESCALATE_AT,
} from "../../src/toolJudge.ts";
import {
  executeTool, executeToolIdempotent, newToolContext, checkApproval,
  rememberApprovalRule,
} from "../../src/tools.ts";

function fakeJudge(score: number, evidence: string[] = ["任务里写了清理临时文件"], reason = "测试打分") {
  return {
    seen: [] as unknown[],
    async chat(messages: unknown[]) {
      this.seen.push(messages);
      return { choices: [{ message: { content: JSON.stringify({ risk_score: score, evidence, reason }) } }] };
    },
  };
}

function fakeJudgeRaw(content: string) {
  return {
    seen: [] as unknown[],
    async chat(messages: unknown[]) {
      this.seen.push(messages);
      return { choices: [{ message: { content } }] };
    },
  };
}

function throwingJudge() {
  return {
    seen: [] as unknown[],
    async chat(_messages: unknown[]): Promise<Record<string, unknown>> {
      throw new Error("judge-model-unavailable-probe-9f27");
    },
  };
}

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 往临时 Nyra 家目录写一份只开 judge 的 config.json。 */
function enableJudgeIn(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ judge: { enabled: true } }), "utf-8");
}

const ENABLED = { judge: { enabled: true } };

test("ToolJudgeTest.test_config_defaults_disabled", () => {
  const cfg = judgeConfig({});
  expect(cfg.enabled).toBe(false);
  expect(cfg.provider).toBeNull();
  expect(cfg.model).toBeNull();
  expect(cfg.tools).toBeNull();
  expect(cfg.denyAt).toBe(DEFAULT_JUDGE_DENY_AT);
  expect(cfg.escalateAt).toBe(DEFAULT_JUDGE_ESCALATE_AT);
  expect(DEFAULT_JUDGE_DENY_AT).toBe(70);
  expect(DEFAULT_JUDGE_ESCALATE_AT).toBe(40);
  expect(judgeEnabled({})).toBe(false);
  expect(judgeEnabled({ judge: { enabled: true } })).toBe(true);
  // 显式 false 以外的写法都不算开启（字符串 "true" 也不开，防误配）。
  expect(judgeEnabled({ judge: { enabled: "true" } })).toBe(false);
});

test("ToolJudgeTest.test_config_explicit_section_and_clamping", () => {
  const cfg = judgeConfig({
    judge: { enabled: true, provider: "xai", model: "grok-4.3", tools: ["shell"], deny_at: 80, escalate_at: 50 },
  });
  expect(cfg.enabled).toBe(true);
  expect(cfg.provider).toBe("xai");
  expect(cfg.model).toBe("grok-4.3");
  expect(cfg.tools).toEqual(["shell"]);
  expect(cfg.denyAt).toBe(80);
  expect(cfg.escalateAt).toBe(50);
  // 越界钳到 0–100；转人工线配得比拒绝线高时按拒绝线钳住（中段不存在，不静默放行）。
  expect(judgeConfig({ judge: { deny_at: 150, escalate_at: 90 } }).denyAt).toBe(100);
  expect(judgeConfig({ judge: { deny_at: 70, escalate_at: 90 } }).escalateAt).toBe(70);
  expect(judgeConfig({ judge: { deny_at: -5, escalate_at: -10 } }).denyAt).toBe(0);
  expect(judgeConfig({ judge: { deny_at: -5, escalate_at: -10 } }).escalateAt).toBe(0);
  // 非数字回默认值。
  expect(judgeConfig({ judge: { deny_at: "high" } }).denyAt).toBe(70);
  expect(judgeConfig({ judge: { escalate_at: "low" } }).escalateAt).toBe(40);
});

test("ToolJudgeTest.test_model_resolution_fallback_chain", () => {
  // judge.* 优先。
  expect(resolveJudgeModel({ judge: { provider: "xai", model: "grok-4.3" } })).toEqual({ provider: "xai", model: "grok-4.3" });
  // 只配 judge.model 时 provider 沿用审查层解析。
  expect(resolveJudgeModel({ judge: { model: "grok-4.3" }, reviewer: { provider: "xai", model: "grok-4" } }))
    .toEqual({ provider: "xai", model: "grok-4.3" });
  // 都不配时沿用审查层。
  expect(resolveJudgeModel({ reviewer: { provider: "xai", model: "grok-4.3" } })).toEqual({ provider: "xai", model: "grok-4.3" });
  // 什么都不配时默认 deepseek-flash。
  expect(resolveJudgeModel({})).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  // 被审工具集默认与审查层同一批。
  expect(judgedTools({})).toContain("shell");
  expect(judgedTools({})).toContain("write_file");
  expect(judgedTools({})).not.toContain("read_file");
  expect(judgedTools({ judge: { tools: ["shell"] } })).toEqual(["shell"]);
});

test("ToolJudgeTest.test_verdict_for_score_boundaries", () => {
  const cfg = judgeConfig({});
  expect(verdictForScore(0, cfg)).toBe("allow");
  expect(verdictForScore(39, cfg)).toBe("allow");
  expect(verdictForScore(40, cfg)).toBe("escalate");
  expect(verdictForScore(69, cfg)).toBe("escalate");
  expect(verdictForScore(70, cfg)).toBe("deny");
  expect(verdictForScore(100, cfg)).toBe("deny");
  // 自定义分段同样按线走。
  const custom = judgeConfig({ judge: { deny_at: 80, escalate_at: 50 } });
  expect(verdictForScore(49, custom)).toBe("allow");
  expect(verdictForScore(50, custom)).toBe("escalate");
  expect(verdictForScore(80, custom)).toBe("deny");
});

test("ToolJudgeTest.test_parse_judge_output", () => {
  const ok = parseJudgeOutput(JSON.stringify({ risk_score: 55, evidence: ["清理临时文件"], reason: "命令与任务一致但删文件不可逆" }));
  expect(ok).not.toBeNull();
  expect(ok!.riskScore).toBe(55);
  expect(ok!.evidence).toEqual(["清理临时文件"]);
  expect(ok!.reason).toBe("命令与任务一致但删文件不可逆");
  // 分数钳到 0–100、取整。
  expect(parseJudgeOutput(JSON.stringify({ risk_score: 150 }))!.riskScore).toBe(100);
  expect(parseJudgeOutput(JSON.stringify({ risk_score: -5 }))!.riskScore).toBe(0);
  expect(parseJudgeOutput(JSON.stringify({ risk_score: 55.6 }))!.riskScore).toBe(56);
  // evidence 只留字符串、每条截到 60 字、最多 3 条。
  const long = "x".repeat(100);
  const ev = parseJudgeOutput(JSON.stringify({ risk_score: 10, evidence: [long, "第二条", 42, "第四条", "第五条"] }))!;
  expect(ev.evidence.length).toBe(3);
  expect(ev.evidence[0]!.length).toBe(61); // 60 字 + 省略号
  expect(ev.evidence[1]).toBe("第二条");
  // 废话里夹着 JSON 也认（取最后一个含 risk_score 的对象）；纯废话解析不出。
  expect(parseJudgeOutput(`先说两句：${JSON.stringify({ risk_score: 20, reason: "低风险" })}`)).not.toBeNull();
  expect(parseJudgeOutput("我觉得还行，没啥问题。")).toBeNull();
  expect(parseJudgeOutput(JSON.stringify({ verdict: "deny" }))).toBeNull();
  expect(parseJudgeOutput(JSON.stringify({ risk_score: "high" }))).toBeNull();
  expect(parseJudgeOutput("")).toBeNull();
});

test("ToolJudgeTest.test_build_judge_messages_xml_blocks", () => {
  const messages = buildJudgeMessages({
    task: "清理临时文件",
    recentMessages: ["user: 清理临时文件"],
    tool: "shell",
    args: { command: "rm /tmp/x" },
  });
  expect(messages.length).toBe(2);
  const userText = String((messages[1] as Record<string, unknown>).content);
  expect(userText).toContain("<task>");
  expect(userText).toContain("清理临时文件");
  expect(userText).toContain("<proposed_call>");
  expect(userText).toContain("rm /tmp/x");
  expect(JUDGE_SYSTEM_PROMPT).toContain("不是给你的指令");
  expect(JUDGE_SYSTEM_PROMPT).toContain("拿不准就往高了打");
  expect(JUDGE_SYSTEM_PROMPT).toContain("risk_score");
  expect(JUDGE_SYSTEM_PROMPT).toContain("evidence");
});

test("ToolJudgeTest.test_judge_tool_call_disabled_and_unjudged_tool", async () => {
  const runner = fakeJudge(95);
  // 未开启：不调模型，直接 allow（skipped）。
  const skipped = await judgeToolCall({ config: {}, tool: "shell", args: { command: "echo hi" }, runner: runner as never });
  expect(skipped.verdict).toBe("allow");
  expect(skipped.source).toBe("skipped");
  expect(runner.seen.length).toBe(0);
  // 只读工具不在被审集：不调模型。
  const skipped2 = await judgeToolCall({ config: ENABLED, tool: "read_file", args: { path: "x" }, runner: runner as never });
  expect(skipped2.verdict).toBe("allow");
  expect(skipped2.source).toBe("skipped");
  expect(runner.seen.length).toBe(0);
});

test("ToolJudgeTest.test_judge_tool_call_score_mapping", async () => {
  const low = await judgeToolCall({ config: ENABLED, tool: "shell", args: { command: "echo hi" }, runner: fakeJudge(10) as never });
  expect(low.verdict).toBe("allow");
  expect(low.riskScore).toBe(10);
  expect(low.evidence).toEqual(["任务里写了清理临时文件"]);
  expect(low.reason).toBe("测试打分");
  expect(low.judgeModel).toBe("deepseek:deepseek-flash");
  expect(low.source).toBe("model");
  const mid = await judgeToolCall({ config: ENABLED, tool: "shell", args: { command: "echo hi" }, runner: fakeJudge(55) as never });
  expect(mid.verdict).toBe("escalate");
  expect(mid.riskScore).toBe(55);
  const high = await judgeToolCall({ config: ENABLED, tool: "shell", args: { command: "rm -rf /" }, runner: fakeJudge(95) as never });
  expect(high.verdict).toBe("deny");
  expect(high.riskScore).toBe(95);
});

test("ToolJudgeTest.test_judge_tool_call_fail_closed", async () => {
  // 模型抛错 → deny。
  const throwing = await judgeToolCall({ config: ENABLED, tool: "shell", args: { command: "echo hi" }, runner: throwingJudge() as never });
  expect(throwing.verdict).toBe("deny");
  expect(throwing.riskScore).toBe(100);
  expect(throwing.source).toBe("model");
  // 输出解析不出分数 → deny。
  const garbage = await judgeToolCall({ config: ENABLED, tool: "shell", args: { command: "echo hi" }, runner: fakeJudgeRaw("我觉得还行。") as never });
  expect(garbage.verdict).toBe("deny");
  expect(garbage.riskScore).toBe(100);
  // 模型不可用 → deny（unavailable）。
  const unavailable = await judgeToolCall({ config: ENABLED, tool: "shell", args: { command: "echo hi" }, runner: null });
  expect(unavailable.verdict).toBe("deny");
  expect(unavailable.source).toBe("unavailable");
  expect(unavailable.reason).toContain("judge 模型不可用");
});

test("ToolJudgeTest.test_build_runner_returns_null_without_credentials", () => {
  const home = tmpHome("nyra-judge-runner-");
  // 不存在的 provider：解析失败，返回 null（不抛错）。
  const runner = buildJudgeRunner({ judge: { provider: "no-such-provider-9f27", model: "x" } }, home);
  expect(runner).toBeNull();
  const st = judgeStatus({ judge: { provider: "no-such-provider-9f27", model: "x" } }, home);
  expect(st.enabled).toBe(false);
  expect(st.provider).toBe("no-such-provider-9f27");
  expect(st.model).toBe("x");
  expect(st.denyAt).toBe(70);
  expect(st.escalateAt).toBe(40);
  expect(st.hasCredentials).toBe(false);
  // 默认状态：deepseek / deepseek-flash（凭证有没有取决于本机环境，不断言）。
  const defaults = judgeStatus({}, home);
  expect(defaults.provider).toBe("deepseek");
  expect(defaults.model).toBe("deepseek-flash");
});

test("ToolJudgeTest.test_judge_verdict_event_roundtrip", () => {
  const home = tmpHome("nyra-judge-ev-");
  const store = new RunStore(join(home, "tasks"));
  const runId = store.create("judge 事件测试", "test-session-judge-probe-9f27", home, "auto", 20).run_id;
  store.appendEvent(runId, "tool_judge_verdict", {
    tool: "shell", verdict: "escalate", risk_score: 55, evidence: "清理临时文件", reason: "删文件不可逆", judge_model: "deepseek:deepseek-flash",
  });
  const events = store.readEvents(runId);
  const verdict = events.find((e) => e.type === "tool_judge_verdict") as Record<string, unknown> | undefined;
  expect(verdict).toBeDefined();
  expect(verdict!.tool).toBe("shell");
  expect(verdict!.verdict).toBe("escalate");
  expect(verdict!.risk_score).toBe(55);
  expect(verdict!.evidence).toBe("清理临时文件");
  expect(verdict!.reason).toBe("删文件不可逆");
  expect(verdict!.judge_model).toBe("deepseek:deepseek-flash");
});

test("ToolJudgeTest.test_judge_verdict_timeline_renders", () => {
  const home = tmpHome("nyra-judge-tl-");
  const store = new RunStore(join(home, "tasks"));
  const runId = store.create("judge 时间线测试", "test-session-judge-tl-9f27", home, "auto", 20).run_id;
  store.appendEvent(runId, "tool_judge_verdict", {
    tool: "shell", verdict: "escalate", risk_score: 55, evidence: "清理临时文件", reason: "删文件不可逆", judge_model: "deepseek:deepseek-flash",
  });
  const timeline = buildTimeline(store, runId);
  const step = timeline.steps.find((s) => s.title.includes("judge"));
  expect(step).toBeDefined();
  expect(step!.title).toContain("风险 55 分");
  expect(step!.title).toContain("escalate");
  expect(step!.detail ?? "").toContain("清理临时文件");
});

test("ToolJudgeTest.test_execute_tool_gate_denies_and_never_retries", async () => {
  const home = tmpHome("nyra-judge-gate-");
  enableJudgeIn(home);
  const workdir = tmpHome("nyra-judge-gate-wd-");
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx = newToolContext({
    workdir, mode: "full", home,
    judgeRunner: fakeJudge(95, ["rm -rf /"], "删根目录") as never,
    reviewTask: "清理临时文件",
    onEvent: (kind, data) => { events.push({ kind, data }); },
  });
  // 拒绝后经 executeToolIdempotent 重试也不落盘（拒绝文案进重试黑名单）。
  const denied = await executeToolIdempotent("write_file", { path: "judge-deny-probe-9f27.txt", content: "must-not-exist" }, ctx, { maxRetries: 2, delaysMs: [0] });
  expect(denied.startsWith("错误：")).toBe(true);
  expect(denied).toContain("意向验证 judge 拒绝了 write_file");
  expect(denied).toContain("95");
  expect(existsSync(join(workdir, "judge-deny-probe-9f27.txt"))).toBe(false);
  const verdictEvent = events.find((e) => e.kind === "tool_judge_verdict");
  expect(verdictEvent).toBeDefined();
  expect(verdictEvent!.data.verdict).toBe("deny");
  expect(verdictEvent!.data.risk_score).toBe(95);
  expect(verdictEvent!.data.evidence).toBe("rm -rf /");
});

test("ToolJudgeTest.test_reviewer_denied_write_never_retries", async () => {
  // 回归：审查层 BLOCK 的写操作经 executeToolIdempotent 重试也不落盘
  // （2026-11-22 探针实证：没加标记前重试把文件写出去了）。
  const home = tmpHome("nyra-judge-rev-");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ reviewer: { enabled: true } }), "utf-8");
  const workdir = tmpHome("nyra-judge-rev-wd-");
  const blockingReviewer = {
    async chat(_messages: unknown[]) {
      return { choices: [{ message: { content: JSON.stringify({ decision: "BLOCK", reason: "探针拦截" }) } }] };
    },
  };
  const ctx = newToolContext({
    workdir, mode: "full", home,
    reviewerRunner: blockingReviewer as never,
    onEvent: () => {},
  });
  const denied = await executeToolIdempotent("write_file", { path: "reviewer-deny-probe-9f27.txt", content: "must-not-exist" }, ctx, { maxRetries: 2, delaysMs: [0] });
  expect(denied).toContain("独立审查拦截了 write_file");
  expect(existsSync(join(workdir, "reviewer-deny-probe-9f27.txt"))).toBe(false);
});

test("ToolJudgeTest.test_execute_tool_gate_allows_low_score", async () => {
  const home = tmpHome("nyra-judge-allow-");
  enableJudgeIn(home);
  const workdir = tmpHome("nyra-judge-allow-wd-");
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx = newToolContext({
    workdir, mode: "full", home,
    judgeRunner: fakeJudge(10) as never,
    reviewTask: "清理临时文件",
    onEvent: (kind, data) => { events.push({ kind, data }); },
  });
  const out = await executeTool("shell", { command: "echo hello-judge-allow-probe-9f27" }, ctx);
  expect(out).toContain("hello-judge-allow-probe-9f27");
  expect(events.find((e) => e.kind === "tool_judge_verdict")?.data.verdict).toBe("allow");
});

test("ToolJudgeTest.test_execute_tool_gate_skips_unjudged_tool", async () => {
  const home = tmpHome("nyra-judge-gate2-");
  enableJudgeIn(home);
  const workdir = tmpHome("nyra-judge-gate2-wd-");
  writeFileSync(join(workdir, "note-judge-probe-9f27.txt"), "hello judge\n");
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx = newToolContext({
    workdir, mode: "full", home,
    judgeRunner: fakeJudge(95) as never,
    onEvent: (kind, data) => { events.push({ kind, data }); },
  });
  // 只读工具不进 judge：judge 打 95 分也照常读。
  const out = await executeTool("read_file", { path: "note-judge-probe-9f27.txt" }, ctx);
  expect(out).toContain("hello judge");
  expect(events.find((e) => e.kind === "tool_judge_verdict")).toBeUndefined();
});

test("ToolJudgeTest.test_execute_tool_gate_disabled_skips", async () => {
  const home = tmpHome("nyra-judge-gate3-");
  const workdir = tmpHome("nyra-judge-gate3-wd-");
  const runner = fakeJudge(95);
  const ctx = newToolContext({
    workdir, mode: "full", home,
    judgeRunner: runner as never,
    onEvent: () => {},
  });
  // 家目录没有 config.json（默认关闭）：judge 模型一次都不调，命令照常执行。
  const out = await executeTool("shell", { command: "echo hello-judge-gate-probe-9f27" }, ctx);
  expect(out).toContain("hello-judge-gate-probe-9f27");
  expect(runner.seen.length).toBe(0);
});

test("ToolJudgeTest.test_escalate_forces_human_approval_over_remembered_rule", async () => {
  const home = tmpHome("nyra-judge-esc-");
  enableJudgeIn(home);
  const workdir = tmpHome("nyra-judge-esc-wd-");
  const command = "echo judge-escalate-probe-9f27";
  const approvals: Array<{ tool: string; summary: string }> = [];
  const ctx = newToolContext({
    workdir, mode: "auto", home, interactive: true,
    judgeRunner: fakeJudge(55, ["echo 一句无害命令"], "删改之外但拿不准") as never,
    reviewTask: "跑一句无害命令",
    approveFn: (async (tool: string, summary: string) => {
      approvals.push({ tool, summary });
      return true;
    }) as never,
    onEvent: () => {},
  });
  // 先记一条“始终允许”规则：没 judge 时这条命令直接放行、不问人。
  expect(rememberApprovalRule(ctx, "shell", command, "session")).not.toBeNull();
  const out = await executeTool("shell", { command }, ctx);
  expect(out).toContain("judge-escalate-probe-9f27");
  // 转人工绕过了“记住的允许”：人被问了一次，摘要里写清了风险分与理由。
  expect(approvals.length).toBe(1);
  expect(approvals[0]!.tool).toBe("shell");
  expect(approvals[0]!.summary).toContain("意向验证 judge");
  expect(approvals[0]!.summary).toContain("55");
  // 对照：judge 未开时同一条命令直接放行，不问人。
  const home2 = tmpHome("nyra-judge-esc2-");
  const workdir2 = tmpHome("nyra-judge-esc2-wd-");
  const approvals2: Array<{ tool: string; summary: string }> = [];
  const ctx2 = newToolContext({
    workdir: workdir2, mode: "auto", home: home2, interactive: true,
    approveFn: (async (tool: string, summary: string) => {
      approvals2.push({ tool, summary });
      return true;
    }) as never,
    onEvent: () => {},
  });
  expect(rememberApprovalRule(ctx2, "shell", command, "session")).not.toBeNull();
  const out2 = await executeTool("shell", { command }, ctx2);
  expect(out2).toContain("judge-escalate-probe-9f27");
  expect(approvals2.length).toBe(0);
});

test("ToolJudgeTest.test_escalate_rejected_by_human_never_retries", async () => {
  const home = tmpHome("nyra-judge-escrej-");
  enableJudgeIn(home);
  const workdir = tmpHome("nyra-judge-escrej-wd-");
  const ctx = newToolContext({
    workdir, mode: "auto", home, interactive: true,
    judgeRunner: fakeJudge(55) as never,
    reviewTask: "写个文件",
    approveFn: (async () => false) as never,
    onEvent: () => {},
  });
  const refused = await executeToolIdempotent("write_file", { path: "judge-escalate-reject-probe-9f27.txt", content: "must-not-exist" }, ctx, { maxRetries: 2, delaysMs: [0] });
  expect(refused).toContain("用户拒绝执行");
  expect(existsSync(join(workdir, "judge-escalate-reject-probe-9f27.txt"))).toBe(false);
});

test("ToolJudgeTest.test_escalate_refused_in_full_mode", async () => {
  const home = tmpHome("nyra-judge-full-");
  enableJudgeIn(home);
  const workdir = tmpHome("nyra-judge-full-wd-");
  const ctx = newToolContext({
    workdir, mode: "full", home,
    judgeRunner: fakeJudge(55) as never,
    reviewTask: "写个文件",
    onEvent: () => {},
  });
  const out = await executeTool("write_file", { path: "judge-full-probe-9f27.txt", content: "must-not-exist" }, ctx);
  expect(out).toContain("full 模式下无人可问");
  expect(existsSync(join(workdir, "judge-full-probe-9f27.txt"))).toBe(false);
});

test("ToolJudgeTest.test_check_approval_escalation_skips_idempotent_shortcircuit", async () => {
  const home = tmpHome("nyra-judge-ca-");
  const workdir = tmpHome("nyra-judge-ca-wd-");
  // 幂等重试 + 转人工标记：不走短路，照样问人；人说不就拒绝。
  const ctx = newToolContext({
    workdir, mode: "auto", home, interactive: true,
    idempotentRetry: true,
    judgeEscalation: { tool: "shell", riskScore: 55, reason: "测试转人工" },
    approveFn: (async () => false) as never,
    onEvent: () => {},
  });
  let thrown = "";
  try {
    await checkApproval(ctx, "shell", "测试", { command: "echo hi" });
  } catch (err: unknown) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  expect(thrown).toContain("用户拒绝执行");
  // 标记已被消费：同一次 ctx 再调不再转人工。
  expect(ctx.judgeEscalation).toBeNull();
  // 对照：没有转人工标记时幂等重试直接放行、不问人。
  const approvals: string[] = [];
  const ctx2 = newToolContext({
    workdir, mode: "auto", home, interactive: true,
    idempotentRetry: true,
    approveFn: (async (tool: string) => {
      approvals.push(tool);
      return true;
    }) as never,
    onEvent: () => {},
  });
  await checkApproval(ctx2, "shell", "测试", { command: "echo hi" });
  expect(approvals.length).toBe(0);
});

test("ToolJudgeTest.test_cli_judge_status_enable_thresholds_and_check", () => {
  const home = tmpHome("nyra-judge-cli-");
  const run = (args: string[]) => spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" },
    encoding: "utf-8", timeout: 60000,
  });
  const status0 = run(["judge", "status"]);
  expect(status0.status).toBe(0);
  expect((status0.stdout ?? "")).toContain("禁用");
  expect((status0.stdout ?? "")).toContain("deepseek:deepseek-flash");
  const enable = run(["judge", "enable"]);
  expect(enable.status).toBe(0);
  expect((enable.stdout ?? "")).toContain("已启用意向验证 judge");
  const setThresholds = run(["judge", "set-thresholds", "80", "50"]);
  expect(setThresholds.status).toBe(0);
  expect((setThresholds.stdout ?? "")).toContain("80");
  const status1 = run(["judge", "status"]);
  expect((status1.stdout ?? "")).toContain("启用");
  expect((status1.stdout ?? "")).toContain("80");
  expect((status1.stdout ?? "")).toContain("50");
  // 分段配反了拒绝写盘。
  expect(run(["judge", "set-thresholds", "50", "80"]).status).toBe(2);
  // check：配一个不存在的 provider，judge 模型建不出来 → fail-closed 拒绝，退出码 3
  //（不用真实模型，结论与本机有没有凭证无关）。
  const setModel = run(["judge", "set-model", "no-such-provider-9f27:x"]);
  expect(setModel.status).toBe(0);
  const denied = run(["judge", "check", "--tool", "shell", "--args", JSON.stringify({ command: "echo hi" })]);
  expect(denied.status).toBe(3);
  expect((denied.stdout ?? "")).toContain("deny");
  expect((denied.stdout ?? "")).toContain("judge 模型不可用");
  // 用法错误与未知子命令。
  expect(run(["judge", "check"]).status).toBe(2);
  expect(run(["judge", "bogus-cmd"]).status).toBe(2);
  // 配置落盘：enabled、分段与模型都写进了 config.json。
  const saved = JSON.parse(readFileSync(join(home, ".nyra", "config.json"), "utf-8")) as Record<string, unknown>;
  const judge = saved.judge as Record<string, unknown>;
  expect(judge.enabled).toBe(true);
  expect(judge.deny_at).toBe(80);
  expect(judge.escalate_at).toBe(50);
  expect(judge.model).toBe("x");
  expect(existsSync(join(home, ".nyra", "config.json"))).toBe(true);
});

test("ToolJudgeTest.test_system_prompt_tells_judge_to_score_with_evidence", () => {
  expect(JUDGE_SYSTEM_PROMPT).toContain("risk_score");
  expect(JUDGE_SYSTEM_PROMPT).toContain("evidence");
  expect(JUDGE_SYSTEM_PROMPT).toContain("逐字摘");
  expect(JUDGE_SYSTEM_PROMPT).toContain("不要编造引用");
});
