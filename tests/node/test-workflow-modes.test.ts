// tests/node/test-workflow-modes.test.ts — 缺口 25 其余形态：协调者 / 动态工作流。
//
// 覆盖：DSL 校验（goal/coordinator 配置边界、dynamic 空步骤）、协调者循环
// （按决定跑计划步骤、决策调用计价、动态生成新步骤、ask 挂起与续跑两条路、
// 连续坏决定、轮数上限、每步骤执行次数上限、每节点重判单次硬顶）、dry-run 候选
// 标记与新步骤额度、3 个新事件注册与时间线渲染、CLI show。全部在临时 home
// 里跑，协调者决定用剧本假 provider（按顺序回 JSON 决定），不碰真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateWorkflowDefinition,
  dryRunPlan,
  importWorkflow,
  runWorkflowByName,
  dryRunWorkflowByName,
  resumeWorkflow,
  getWorkflowRun,
  loadWorkflowRuns,
  saveWorkflowRun,
  handleWorkflow,
  resolveMaxRounds,
  resolveMaxNewSteps,
  WorkflowError,
} from "../../src/workflow.ts";
import type { WorkflowDefinition, WorkflowRun, WorkflowRunRequest } from "../../src/workflow.ts";
import { decideReviewItem, getReviewItem } from "../../src/reviewQueue.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import type { ProviderLike } from "../../src/providers.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-wf-modes-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** 剧本假 provider：按顺序回 JSON 决定（用完重复最后一条），每次调用记 usage 10/5。
 *  同一个 provider 实例跨 resume 复用，剧本不从头重放。 */
function scriptedProvider(replies: string[]): { provider: ProviderLike; calls: () => number } {
  let i = 0;
  let n = 0;
  const provider: ProviderLike = {
    name: "fake",
    model: "fake-model",
    baseUrl: "",
    hasCredentials: () => true,
    chat: async () => {
      n++;
      const text = replies[Math.min(i, replies.length - 1)];
      i++;
      return {
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    listModels: async () => ["fake-model"],
    redact: (t: string) => t,
  };
  return { provider, calls: () => n };
}

function reqFor(home: string, script: { provider: ProviderLike }, maxCostUsd?: number): WorkflowRunRequest {
  return {
    workdir: home,
    mode: "normal",
    interactive: false,
    providerFactory: async () => script.provider,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}

function writePricing(home: string, monthlyLimit?: number): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({
    pricing: { "fake-model": { input_per_1m: 100, output_per_1m: 200 } },
    ...(monthlyLimit !== undefined ? { monthly_cost_limit_usd: monthlyLimit } : {}),
  }));
}

function writeDefFile(home: string, text: string, name = "wf.yaml"): string {
  const p = join(home, name);
  writeFileSync(p, text);
  return p;
}

/** 测试用 YAML 序列化（goal / coordinator / steps 子集，不依赖 workflow.ts 的生成器）。 */
function defToYaml(def: WorkflowDefinition): string {
  const lines: string[] = [
    `name: ${def.name}`,
    "version: 1",
    `mode: ${def.mode}`,
  ];
  if (def.goal !== undefined) lines.push(`goal: ${JSON.stringify(def.goal)}`);
  if (def.coordinator !== undefined) {
    lines.push("coordinator:");
    if (def.coordinator.max_rounds !== undefined) lines.push(`  max_rounds: ${def.coordinator.max_rounds}`);
    if (def.coordinator.max_new_steps !== undefined) lines.push(`  max_new_steps: ${def.coordinator.max_new_steps}`);
  }
  if (def.inputs) {
    lines.push("inputs:");
    for (const [k, v] of Object.entries(def.inputs)) {
      lines.push(`  ${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
    }
  }
  if (def.max_cost_usd !== undefined) lines.push(`max_cost_usd: ${def.max_cost_usd}`);
  if (def.steps.length) {
    lines.push("steps:");
    for (const s of def.steps) {
      lines.push(`  - id: ${s.id}`);
      lines.push(`    type: ${s.type}`);
      if (s.if) lines.push(`    if: ${JSON.stringify(s.if)}`);
      if (s.tool) lines.push(`    tool: ${s.tool}`);
      if (s.args) {
        lines.push(`    args:`);
        for (const [k, v] of Object.entries(s.args)) {
          lines.push(`      ${k}: ${JSON.stringify(v)}`);
        }
      }
      if (s.prompt) lines.push(`    prompt: ${JSON.stringify(s.prompt)}`);
      if (s.task) lines.push(`    task: ${JSON.stringify(s.task)}`);
      if (s.title) lines.push(`    title: ${JSON.stringify(s.title)}`);
      if (s.on_reject) lines.push(`    on_reject: ${s.on_reject}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const RUN = (step: string): string => JSON.stringify({ action: "run", step });
const FINISH = (summary = "做完了"): string => JSON.stringify({ action: "finish", summary });

// ---------------------------------------------------------------------------
// DSL 校验
// ---------------------------------------------------------------------------

test("校验：coordinator 空计划被拒；dynamic 空步骤可跑；goal 为空串被拒；coordinator 未知字段被拒", () => {
  const base: WorkflowDefinition = {
    name: "协调", version: 1, mode: "coordinator", goal: "读一个文件",
    steps: [{ id: "r", type: "tool", tool: "read_file", args: { path: "/tmp/x" } }],
  };
  expect(validateWorkflowDefinition(base).mode).toBe("coordinator");
  expect(() => validateWorkflowDefinition({ ...base, steps: [] })).toThrow(/非空数组/);
  expect(() => validateWorkflowDefinition({ ...base, goal: "   " })).toThrow(/goal/);
  expect(() => validateWorkflowDefinition({ ...base, coordinator: { max_rounds: 5, bogus: 1 } as never })).toThrow(/不认字段/);
  expect(resolveMaxRounds(base)).toBe(10);
  expect(resolveMaxNewSteps(base)).toBe(3);
  const dyn: WorkflowDefinition = { name: "动态", version: 1, mode: "dynamic", goal: "随便查查", steps: [] };
  expect(validateWorkflowDefinition(dyn).mode).toBe("dynamic");
  expect(resolveMaxNewSteps(dyn)).toBe(5);
  expect(resolveMaxNewSteps({ ...dyn, coordinator: { max_new_steps: 2 } })).toBe(2);
});

// ---------------------------------------------------------------------------
// 协调者循环：happy path
// ---------------------------------------------------------------------------

test("协调者：按决定跑计划步骤再 finish，决策调用的成本也计价进账本", async () => {
  const home = tempHome();
  try {
    writePricing(home);
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "协调跑", version: 1, mode: "coordinator", goal: "读文件并总结",
      steps: [
        { id: "read", type: "tool", tool: "read_file", args: { path: file } },
        { id: "draft", type: "llm", prompt: "总结：{{steps.read.output}}" },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    // 剧本第 3 条是 llm 节点本身的模型回复（节点执行也要调一次模型），第 4 条才是第 3 轮决定。
    const script = scriptedProvider([RUN("read"), RUN("draft"), "FAKE-REPLY", FINISH("读完并总结了")]);
    const run = await runWorkflowByName(home, "协调跑", {}, reqFor(home, script));
    expect(run.status).toBe("completed");
    expect(run.nodes.map((n) => n.id)).toEqual(["read", "draft"]);
    expect(run.nodes[0].output).toContain("AAA");
    expect(run.nodes[1].output).toBe("FAKE-REPLY");
    expect(run.coordinator?.round).toBe(3);
    expect(run.coordinator?.executed).toEqual(["read", "draft"]);
    expect(run.coordinator?.decisions.map((d) => d.action)).toEqual(["run", "run", "finish"]);
    expect(run.coordinator?.decisions.every((d) => d.ok)).toBe(true);
    expect(script.calls()).toBe(4);
    // 4 次模型调用（3 次决策 + 1 次 llm 节点）×（10 token × $100/百万 + 5 token × $200/百万 = $0.002）
    expect(run.spentUsd).toBeCloseTo(0.008, 6);
    expect(new UsageLedger(home).monthTotal(monthKeyString(new Date())).spentUsd).toBeCloseTo(0.008, 6);
    const store = new RunStore(join(home, "runs"));
    const storeRun = store.list().find((s) => s.session_id === `workflow-${run.id}`);
    const text = formatTimelineText(buildTimeline(store, storeRun!.run_id));
    expect(text).toContain("协调者第 1 轮决定");
    expect(text).toContain("跑步骤");
  } finally {
    cleanup(home);
  }
});

test("协调者：if 为假的步骤不列入可执行，协调者想跑它记坏决定", async () => {
  const home = tempHome();
  try {
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "条件筛", version: 1, mode: "coordinator", goal: "读文件",
      steps: [
        { id: "nope", type: "tool", tool: "read_file", args: { path: file }, if: "inputs.flag == true" },
        { id: "read", type: "tool", tool: "read_file", args: { path: file } },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    // 第 1 轮想跑条件为假的 nope（坏决定 1 次），第 2 轮跑 read，第 3 轮 finish。
    const script = scriptedProvider([RUN("nope"), RUN("read"), FINISH()]);
    const run = await runWorkflowByName(home, "条件筛", {}, reqFor(home, script));
    expect(run.status).toBe("completed");
    expect(run.coordinator?.decisions[0].action).toBe("invalid");
    expect(run.coordinator?.decisions[0].error).toContain("不可执行");
    expect(run.nodes.map((n) => n.id)).toEqual(["read"]);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 动态：生成新步骤
// ---------------------------------------------------------------------------

test("动态：种子为空（YAML 缺 steps 键与 JSON 空数组都行），协调者生成新步骤并跑它", async () => {
  const home = tempHome();
  try {
    const file = join(home, "a.txt");
    writeFileSync(file, "动态内容");
    const newStep = JSON.stringify({
      action: "new_step",
      step: { id: "fetch", type: "tool", tool: "read_file", args: { path: file } },
    });
    // YAML：steps 键缺省（YAML 子集写不出空列表）
    const yamlDef: WorkflowDefinition = { name: "动态空", version: 1, mode: "dynamic", goal: "读一个文件", steps: [] };
    await importWorkflow(home, writeDefFile(home, defToYaml(yamlDef), "dyn.yaml"));
    const script1 = scriptedProvider([newStep, FINISH("读到了")]);
    const run1 = await runWorkflowByName(home, "动态空", {}, reqFor(home, script1));
    expect(run1.status).toBe("completed");
    expect(run1.nodes.find((n) => n.id === "fetch")?.output).toContain("动态内容");
    expect(run1.definition.steps).toHaveLength(1);
    expect(run1.definition.steps[0].id).toBe("fetch");
    expect(run1.coordinator?.dynamicSteps).toHaveLength(1);
    expect(run1.coordinator?.decisions[0].action).toBe("new_step");

    // JSON：steps 空数组
    const jsonDef = JSON.stringify({ name: "动态空二", version: 1, mode: "dynamic", goal: "读一个文件", steps: [] });
    await importWorkflow(home, writeDefFile(home, jsonDef, "dyn2.json"));
    const script2 = scriptedProvider([newStep, FINISH()]);
    const run2 = await runWorkflowByName(home, "动态空二", {}, reqFor(home, script2));
    expect(run2.status).toBe("completed");
    expect(run2.nodes.find((n) => n.id === "fetch")?.output).toContain("动态内容");
  } finally {
    cleanup(home);
  }
});

test("动态：新步骤是审批节点被拒绝；新步骤 id 重复也被拒绝（各跑一轮，坏决定不连续）", async () => {
  const home = tempHome();
  try {
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "动态坏决定", version: 1, mode: "dynamic", goal: "读文件",
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: file } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const approveStep = JSON.stringify({
      action: "new_step",
      step: { id: "gate", type: "approve", title: "批一下" },
    });
    const dupStep = JSON.stringify({
      action: "new_step",
      step: { id: "read", type: "tool", tool: "read_file", args: { path: file } },
    });
    // 审批节点：坏决定 1 次后继续跑计划步骤。
    const scriptA = scriptedProvider([approveStep, RUN("read"), FINISH()]);
    const runA = await runWorkflowByName(home, "动态坏决定", {}, reqFor(home, scriptA));
    expect(runA.status).toBe("completed");
    expect(runA.coordinator?.decisions[0].action).toBe("invalid");
    expect(runA.coordinator?.decisions[0].error).toContain("审批节点");
    expect(runA.nodes.map((n) => n.id)).toEqual(["read"]);
    expect(runA.coordinator?.dynamicSteps).toHaveLength(0);
    // id 重复：同样坏决定 1 次后继续。
    const scriptB = scriptedProvider([dupStep, RUN("read"), FINISH()]);
    const runB = await runWorkflowByName(home, "动态坏决定", {}, reqFor(home, scriptB));
    expect(runB.status).toBe("completed");
    expect(runB.coordinator?.decisions[0].action).toBe("invalid");
    expect(runB.coordinator?.decisions[0].error).toContain("重复");
    expect(runB.nodes.map((n) => n.id)).toEqual(["read"]);
    expect(runB.coordinator?.dynamicSteps).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// ask：挂起与续跑
// ---------------------------------------------------------------------------

test("协调者：ask 挂起，批了记 ask 节点继续循环；拒了整轮失败", async () => {
  const home = tempHome();
  try {
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "要问人", version: 1, mode: "coordinator", goal: "读文件",
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: file } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const ask = JSON.stringify({ action: "ask", question: "用哪个文件？" });

    // 批了继续
    const script1 = scriptedProvider([ask, RUN("read"), FINISH()]);
    const run1 = await runWorkflowByName(home, "要问人", {}, reqFor(home, script1));
    expect(run1.status).toBe("awaiting_approval");
    expect(run1.pendingNodeId).toBe("__ask__");
    expect(run1.pendingNodeIndex).toBe(-1);
    expect(run1.reviewItemId).toBeTruthy();
    expect(getReviewItem(home, run1.reviewItemId!).status).toBe("pending");
    await expect(resumeWorkflow(home, run1.id, reqFor(home, script1))).rejects.toThrow(/还没批复/);
    decideReviewItem(home, run1.reviewItemId!, "approved", { by: "test" });
    const resumed1 = await resumeWorkflow(home, run1.id, reqFor(home, script1));
    expect(resumed1.status).toBe("completed");
    expect(resumed1.nodes.find((n) => n.id === "ask-1")?.approved).toBe(true);
    expect(resumed1.nodes.find((n) => n.id === "read")?.output).toContain("AAA");
    expect(resumed1.coordinator?.round).toBe(3);

    // 拒了失败
    const script2 = scriptedProvider([ask, FINISH()]);
    const run2 = await runWorkflowByName(home, "要问人", {}, reqFor(home, script2));
    expect(run2.status).toBe("awaiting_approval");
    decideReviewItem(home, run2.reviewItemId!, "rejected", { by: "test" });
    const resumed2 = await resumeWorkflow(home, run2.id, reqFor(home, script2));
    expect(resumed2.status).toBe("failed");
    expect(resumed2.error).toContain("提问被拒绝");
  } finally {
    cleanup(home);
  }
});

test("协调者：计划里的审批节点挂起，批复后回到协调者循环续跑（轮数不丢）", async () => {
  const home = tempHome();
  try {
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "计划审批", version: 1, mode: "coordinator", goal: "读文件",
      steps: [
        { id: "gate", type: "approve", title: "看一眼", on_reject: "skip" },
        { id: "read", type: "tool", tool: "read_file", args: { path: file } },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const script = scriptedProvider([RUN("gate"), RUN("read"), FINISH()]);
    const run = await runWorkflowByName(home, "计划审批", {}, reqFor(home, script));
    expect(run.status).toBe("awaiting_approval");
    expect(run.pendingNodeId).toBe("gate");
    expect(run.pendingNodeIndex).toBe(0);
    decideReviewItem(home, run.reviewItemId!, "approved", { by: "test" });
    const resumed = await resumeWorkflow(home, run.id, reqFor(home, script));
    expect(resumed.status).toBe("completed");
    expect(resumed.nodes.find((n) => n.id === "gate")?.approved).toBe(true);
    expect(resumed.nodes.find((n) => n.id === "read")?.output).toContain("AAA");
    expect(resumed.coordinator?.round).toBe(3);
    expect(resumed.coordinator?.executed).toEqual(["gate", "read"]);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 硬上限：坏决定、轮数、每步骤次数、单次硬顶
// ---------------------------------------------------------------------------

test("协调者：连续两次坏决定整轮失败，不循环烧钱", async () => {
  const home = tempHome();
  try {
    const def: WorkflowDefinition = {
      name: "坏决定", version: 1, mode: "coordinator", goal: "读文件",
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: "/tmp/x" } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const script = scriptedProvider(["这不是 JSON", "也不是 JSON"]);
    const run = await runWorkflowByName(home, "坏决定", {}, reqFor(home, script));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("连续 2 次");
    expect(run.coordinator?.decisions).toHaveLength(2);
    expect(run.coordinator?.decisions.every((d) => d.action === "invalid" && !d.ok)).toBe(true);
    expect(script.calls()).toBe(2);
  } finally {
    cleanup(home);
  }
});

test("协调者：轮数用完即停；同一节点最多跑 3 次", async () => {
  const home = tempHome();
  try {
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "轮数上限", version: 1, mode: "coordinator", goal: "读文件",
      coordinator: { max_rounds: 1 },
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: file } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const script1 = scriptedProvider([RUN("read"), RUN("read")]);
    const run1 = await runWorkflowByName(home, "轮数上限", {}, reqFor(home, script1));
    expect(run1.status).toBe("failed");
    expect(run1.error).toContain("轮数用完");
    expect(run1.nodes).toHaveLength(1);

    const def2: WorkflowDefinition = {
      name: "次数上限", version: 1, mode: "coordinator", goal: "读文件",
      coordinator: { max_rounds: 10 },
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: file } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def2)));
    const script2 = scriptedProvider([RUN("read")]);
    const run2 = await runWorkflowByName(home, "次数上限", {}, reqFor(home, script2));
    expect(run2.status).toBe("failed");
    expect(run2.error).toContain("连续 2 次");
    expect(run2.nodes.filter((n) => n.id === "read")).toHaveLength(3);
    expect(run2.coordinator?.runCounts["read"]).toBe(3);
  } finally {
    cleanup(home);
  }
});

test("协调者：单次硬顶每节点后重判，超了即停", async () => {
  const home = tempHome();
  try {
    writePricing(home);
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "单次硬顶", version: 1, mode: "coordinator", goal: "读文件",
      max_cost_usd: 0.001,
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: file } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    // 第 1 轮决策调用花 $0.002（已超 $0.001 单次上限）；节点落盘后重判，停下。
    const script = scriptedProvider([RUN("read"), FINISH()]);
    const run = await runWorkflowByName(home, "单次硬顶", {}, reqFor(home, script));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("成本上限已超");
    expect(run.error).toContain("本次运行已花");
  } finally {
    cleanup(home);
  }
});

test("协调者：旧月度上限配置不再拦工作流，照常跑完", async () => {
  const home = tempHome();
  try {
    // 旧配置写着月度上限 $0.001，两轮决策调用共花 $0.004，远超旧上限——
    // 月度上限已移除，不再重判，工作流照常跑完。
    writePricing(home, 0.001);
    const file = join(home, "a.txt");
    writeFileSync(file, "AAA");
    const def: WorkflowDefinition = {
      name: "旧月度配置", version: 1, mode: "coordinator", goal: "读文件",
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: file } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const script = scriptedProvider([RUN("read"), FINISH()]);
    const run = await runWorkflowByName(home, "旧月度配置", {}, reqFor(home, script));
    expect(run.status).toBe("completed");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// dry-run 与事件、CLI
// ---------------------------------------------------------------------------

test("dry-run：协调者形态的计划步骤标候选，新步骤额度另记一条；哈希可验证", () => {
  const home = tempHome();
  try {
    const def: WorkflowDefinition = {
      name: "干跑", version: 1, mode: "coordinator", goal: "读写文件",
      steps: [
        { id: "r", type: "tool", tool: "read_file", args: { path: "/tmp/x" } },
        { id: "w", type: "tool", tool: "write_file", args: { path: "/tmp/y", content: "hi" } },
        { id: "m", type: "llm", prompt: "总结一下" },
      ],
    };
    const plan = dryRunPlan(def, {});
    expect(plan.actions.map((a) => a.nodeId)).toEqual(["r", "w", "m", "__coordinator__"]);
    expect(plan.actions[0].kind).toBe("read");
    expect(plan.actions[0].detail).toContain("候选步骤");
    expect(plan.actions[1].kind).toBe("write");
    expect(plan.actions[2].kind).toBe("unknown-model-action");
    expect(plan.actions[3].kind).toBe("unknown-model-action");
    expect(plan.actions[3].detail).toContain("最多再生成 3 个");
    expect(dryRunPlan(def, {}).hash).toBe(plan.hash);
    const run: WorkflowRun = {
      id: "20261121-120000-abcdef", workflow: "干跑", status: "completed", inputs: {},
      definition: def, nodes: [], spentUsd: 0, startedAt: "2026-11-21T12:00:00Z", endedAt: "2026-11-21T12:00:01Z",
      dryRun: true, trial: false, error: null, pendingNodeId: null, pendingNodeIndex: null,
      reviewItemId: null, dryRunPlanHash: plan.hash, coordinator: null,
    };
    saveWorkflowRun(home, run);
    const loaded = getWorkflowRun(home, run.id)!;
    expect(loaded.dryRunPlanHash).toBe(plan.hash);
    expect(loadWorkflowRuns(home).runs).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("事件：三个新事件类型已注册（appendEvent 不抛错），未知类型抛错", () => {
  const home = tempHome();
  try {
    const store = new RunStore(join(home, "runs"));
    const st = store.create("测试", "test-session", home, "normal", 1);
    expect(() => store.appendEvent(st.run_id, "workflow_coordinator_decision", { round: 1, action: "run", step: "read", spent_usd: 0.002 })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_dynamic_step", { step_id: "fetch", step_type: "tool" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_coordinator_ask", { round: 2, review_item_id: "rv-1" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_nope", {})).toThrow();
  } finally {
    cleanup(home);
  }
});

test("CLI：show 打印形态与目标；usage 里提到三种形态", async () => {
  const home = tempHome();
  try {
    const def: WorkflowDefinition = {
      name: "协调展示", version: 1, mode: "coordinator", goal: "读一个文件",
      coordinator: { max_rounds: 5, max_new_steps: 2 },
      steps: [{ id: "r", type: "tool", tool: "read_file", args: { path: "/tmp/x" } }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = "";
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    try {
      expect(await handleWorkflow(["show", "协调展示"], home)).toBe(0);
      expect(out).toContain("coordinator");
      expect(out).toContain("读一个文件");
      expect(out).toContain("最多 5 轮");
      expect(await handleWorkflow([], home)).toBe(2);
      expect(out).toContain("coordinator");
      expect(out).toContain("dynamic");
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origWrite;
      (process.stderr as unknown as { write: unknown }).write = origErr;
    }
  } finally {
    cleanup(home);
  }
});
