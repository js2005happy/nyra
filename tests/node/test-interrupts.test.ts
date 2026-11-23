// tests/node/test-interrupts.test.ts — G-P1-41 结构化人机回环。
//
// 钉住的事：
//   - schema / spec 校验正反例（字段数、字段名、类型、必填、prompt 长度）；
//   - 账本往返/0600/损坏备份/上限 200（丢最旧的已终态单，挂起的保留）；
//   - 状态机：只有 pending 能回，accept/ignore 不带值，respond 按 schema 校验，
//     edit 须带值；同一运行同一位置挂起的单只有一张；
//   - 工作流导入校验：并行分支内、审批节点、coordinator/dynamic 配中断都拒绝；
//   - 端到端真跑 fixed 工作流（假 provider）：before/after 挂起与四种决定续跑、
//     edit 改参数只重跑受影响步骤、after 点 edit 改输出并同步步级检查点、
//     续跑不绕审批、if 为假的步骤不打扰人；
//   - CLI 全程（handleInterrupt，不经过浏览器）；事件注册与进链。
// 全部在临时 home / 假 provider 上跑，不调真模型、不碰真文件系统外的东西。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  createInterrupt,
  getInterrupt,
  findInterrupt,
  listInterrupts,
  resolveInterrupt,
  validateInterruptSchema,
  validateInterruptSpec,
  validateInterruptResponse,
  validateEditValues,
  interruptsLedgerModeOk,
} from "../../src/interrupts.ts";
import { getStepStateHistory, resolveStepCheckpointStore } from "../../src/stepCheckpoints.ts";
import {
  getWorkflowRun,
  importWorkflow,
  parseWorkflowDefinition,
  resumeWorkflowFromInterrupt,
  runWorkflowByName,
  validateWorkflowDefinition,
  type WorkflowRunRequest,
} from "../../src/workflow.ts";
import { handleInterrupt } from "../../src/interruptCli.ts";
import { getReviewItem } from "../../src/reviewQueue.ts";
import { RunStore } from "../../src/runs.ts";
import type { ProviderLike } from "../../src/providers.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-int-test-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

class FakeProvider {
  name = "fake";
  model = "fake-model";
  baseUrl = "";
  calls: unknown[][] = [];
  private replies: string[];
  constructor(replies: string[] = ["第一句的回答", "第二句的回答", "第三句的回答"]) {
    this.replies = [...replies];
  }
  hasCredentials(): boolean { return true; }
  redact(t: string): string { return t; }
  async listModels(): Promise<string[]> { return ["fake-model"]; }
  async chat(messages: unknown[]): Promise<Record<string, unknown>> {
    this.calls.push(messages as unknown[]);
    const text = this.replies.shift() ?? "FAKE-REPLY";
    return {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }
}

function reqFor(home: string, provider: FakeProvider): WorkflowRunRequest {
  return {
    workdir: home,
    mode: "normal",
    interactive: false,
    providerFactory: async (): Promise<ProviderLike> => provider as unknown as ProviderLike,
  };
}

function writeDefFile(home: string, text: string, name = "wf.yaml"): string {
  const p = join(home, name);
  writeFileSync(p, text);
  return p;
}

/** 两步 llm 工作流；s2 的 interrupt 由调用方指定（before / after / 无）。 */
function twoStepYaml(point: "before" | "after" | "none", withSchema = true): string {
  const interrupt = point === "none" ? "" : [
    `    interrupt_${point}:`,
    "      prompt: 第二句跑之前看一眼",
    ...(withSchema ? [
      "      schema:",
      "        fields:",
      "          - name: note",
      "            type: string",
      "            required: false",
      "            description: 给下一步留一句话",
    ] : []),
  ].join("\n") + "\n";
  return [
    "name: 问两句",
    "version: 1",
    "mode: fixed",
    "steps:",
    "  - id: s1",
    "    type: llm",
    "    prompt: 第一句",
    "  - id: s2",
    "    type: llm",
    '    prompt: "第二句看第一句：{{steps.s1.output}}"',
    interrupt,
    "",
  ].join("\n");
}

function baseArgs(runId: string, stepId: string, point: "before" | "after") {
  return {
    runId, workflow: "问两句", stepId, point,
    prompt: "看一眼", schema: { fields: [] }, contextSummary: "摘要",
  };
}

// ---------------------------------------------------------------------------
// schema / spec 校验
// ---------------------------------------------------------------------------

test("InterruptTest.test_schema_valid_and_empty", () => {
  expect(validateInterruptSchema({ fields: [] }).fields).toEqual([]);
  const s = validateInterruptSchema({ fields: [{ name: "note", type: "string", required: true, description: "备注" }] });
  expect(s.fields).toEqual([{ name: "note", type: "string", required: true, description: "备注" }]);
});

test("InterruptTest.test_schema_rejects_bad_fields", () => {
  expect(() => validateInterruptSchema({ fields: [{ name: "Note", type: "string" }] })).toThrow("字段名");
  expect(() => validateInterruptSchema({ fields: [{ name: "1x", type: "string" }] })).toThrow("字段名");
  expect(() => validateInterruptSchema({ fields: [{ name: "a", type: "string" }, { name: "a", type: "number" }] })).toThrow("重复");
  expect(() => validateInterruptSchema({ fields: [{ name: "a", type: "text" }] })).toThrow("type");
  expect(() => validateInterruptSchema({ fields: [{ name: "a", type: "string", required: "yes" }] })).toThrow("required");
  expect(() => validateInterruptSchema({ fields: [{ name: "a", type: "string", description: "x".repeat(201) }] })).toThrow("description");
  expect(() => validateInterruptSchema({ fields: [{ name: "a", type: "string", extra: 1 }] })).toThrow("不认的键");
  expect(() => validateInterruptSchema({ fields: Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, type: "string" })) })).toThrow("最多 16");
  expect(() => validateInterruptSchema({})).toThrow("fields");
  expect(() => validateInterruptSchema("nope")).toThrow();
});

test("InterruptTest.test_spec_validation", () => {
  expect(validateInterruptSpec({ prompt: "看一眼" }, "x")).toEqual({ prompt: "看一眼" });
  expect(() => validateInterruptSpec({ prompt: "x".repeat(501) }, "x")).toThrow("prompt");
  expect(() => validateInterruptSpec({ prompt: "" }, "x")).toThrow("prompt");
  expect(() => validateInterruptSpec({ other: 1 }, "x")).toThrow("不认的键");
  expect(() => validateInterruptSpec("nope", "x")).toThrow();
});

test("InterruptTest.test_response_validation", () => {
  const schema = { fields: [
    { name: "note", type: "string" as const },
    { name: "count", type: "number" as const, required: true },
    { name: "ok", type: "boolean" as const },
  ] };
  expect(validateInterruptResponse(schema, { count: 3 })).toEqual({ count: 3 });
  expect(validateInterruptResponse(schema, { note: "hi", count: 1, ok: true })).toEqual({ note: "hi", count: 1, ok: true });
  expect(() => validateInterruptResponse(schema, { count: 1, nope: 1 })).toThrow("不认的字段");
  expect(() => validateInterruptResponse(schema, {})).toThrow("缺必填字段");
  expect(() => validateInterruptResponse(schema, { count: "3" })).toThrow("须是 number");
  expect(() => validateInterruptResponse(schema, { count: 1, note: "x".repeat(1001) })).toThrow("最多 1000");
  expect(() => validateInterruptResponse(schema, { count: Number.NaN })).toThrow("有限数字");
  expect(() => validateInterruptResponse(schema, "nope")).toThrow();
});

test("InterruptTest.test_edit_values_validation", () => {
  const allowed = { prompt: "string", max_turns: "number" } as Record<string, "string" | "number" | "boolean">;
  expect(validateEditValues({ prompt: "新提示" }, allowed)).toEqual({ prompt: "新提示" });
  expect(() => validateEditValues({}, allowed)).toThrow("至少改一个");
  expect(() => validateEditValues({ other: "x" }, allowed)).toThrow("改不了 other");
  expect(() => validateEditValues({ max_turns: "6" }, allowed)).toThrow("须是 number");
  expect(() => validateEditValues({ prompt: { nested: 1 } }, allowed)).toThrow("对象或列表");
  expect(() => validateEditValues({ prompt: "x".repeat(1001) }, allowed)).toThrow("最多 1000");
});

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

test("InterruptTest.test_ledger_create_list_get_idempotent", () => {
  const home = tempHome();
  try {
    const a = createInterrupt(home, baseArgs("run-1", "s1", "before"));
    expect(a.id.startsWith("int-")).toBe(true);
    expect(a.status).toBe("pending");
    expect(a.decision).toBeNull();
    // 同一条运行、同一个步骤、同一个点，挂起的单只有一张。
    const b = createInterrupt(home, baseArgs("run-1", "s1", "before"));
    expect(b.id).toBe(a.id);
    expect(listInterrupts(home)).toHaveLength(1);
    expect(listInterrupts(home, "pending")).toHaveLength(1);
    expect(listInterrupts(home, "resolved")).toHaveLength(0);
    expect(getInterrupt(home, a.id).id).toBe(a.id);
    expect(findInterrupt(home, "run-1", "s1", "before")?.id).toBe(a.id);
    expect(findInterrupt(home, "run-1", "s1", "after")).toBeNull();
    expect(() => getInterrupt(home, "int-nope")).toThrow("找不到中断单");
    expect(interruptsLedgerModeOk(home)).toBe(true);
    expectPerms(join(home, "interrupts.json"), 0o600);
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_resolve_state_machine", () => {
  const home = tempHome();
  try {
    const a = createInterrupt(home, baseArgs("run-1", "s1", "before"));
    expect(() => resolveInterrupt(home, a.id, "accept", { response: { x: 1 } })).toThrow("不带值");
    const done = resolveInterrupt(home, a.id, "accept", { by: "local" });
    expect(done.status).toBe("resolved");
    expect(done.decision).toBe("accept");
    expect(done.resolvedBy).toBe("local");
    expect(done.resolvedAt).not.toBeNull();
    expect(() => resolveInterrupt(home, a.id, "ignore")).toThrow("已经是 resolved");

    const schema = { fields: [{ name: "note", type: "string" as const, required: true }] };
    const b = createInterrupt(home, { ...baseArgs("run-2", "s1", "before"), schema });
    expect(() => resolveInterrupt(home, b.id, "respond", { response: {} })).toThrow("缺必填字段");
    const br = resolveInterrupt(home, b.id, "respond", { response: { note: "ok" } });
    expect(br.response).toEqual({ note: "ok" });

    const c = createInterrupt(home, baseArgs("run-3", "s1", "before"));
    expect(() => resolveInterrupt(home, c.id, "edit")).toThrow("至少改一个");
    const ce = resolveInterrupt(home, c.id, "edit", { editedValues: { prompt: "新的" } });
    expect(ce.editedValues).toEqual({ prompt: "新的" });

    expect(() => resolveInterrupt(home, "int-nope", "accept")).toThrow("找不到中断单");
    expect(() => resolveInterrupt(home, c.id, "wrong" as never)).toThrow("不认的决定");
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_ledger_corrupt_backup_and_cap", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "interrupts.json"), "{ broken json");
    expect(listInterrupts(home)).toEqual([]);
    // 损坏先备份再回空：原文件已改名，账本读出来是空的。
    expect(existsSync(join(home, "interrupts.json"))).toBe(false);
    const names = readdirSync(home);
    expect(names.some((n: string) => n.startsWith("interrupts.json.bak-"))).toBe(true);

    // 上限 200：200 条已终态 + 1 条挂起，再建 1 条时丢最旧的已终态单，挂起的保留。
    for (let i = 0; i < 200; i++) {
      const it = createInterrupt(home, baseArgs(`run-old-${i}`, "s1", "before"));
      resolveInterrupt(home, it.id, "accept");
    }
    const pending = createInterrupt(home, baseArgs("run-keep", "s1", "before"));
    createInterrupt(home, baseArgs("run-new", "s1", "before"));
    const all = listInterrupts(home);
    expect(all).toHaveLength(200);
    expect(all.some((i) => i.id === pending.id)).toBe(true);
    expect(all.some((i) => i.runId === "run-old-0")).toBe(false);
    expect(all.some((i) => i.runId === "run-new")).toBe(true);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 工作流导入校验
// ---------------------------------------------------------------------------

test("InterruptTest.test_workflow_definition_rejects_bad_interrupt", () => {
  const badApprove = [
    "name: 坏的", "version: 1", "mode: fixed", "steps:",
    "  - id: gate", "    type: approve", "    title: 确认",
    "    interrupt_before:", "      prompt: 看一眼", "",
  ].join("\n");
  expect(() => parseWorkflowDefinition(badApprove, "wf.yaml")).toThrow("审批节点");

  // 并行分支内的步骤：对象形式直接调校验（YAML 子集的嵌套列表写法另有 defToYaml 覆盖）。
  const badBranchDef = {
    name: "坏的", version: 1, mode: "fixed",
    steps: [{
      id: "p", type: "parallel",
      branches: [
        [{ id: "a", type: "llm", prompt: "甲", interrupt_before: { prompt: "看一眼" } }, { id: "b", type: "llm", prompt: "乙" }],
        [{ id: "c", type: "llm", prompt: "丙" }, { id: "d", type: "llm", prompt: "丁" }],
      ],
    }],
  };
  expect(() => validateWorkflowDefinition(badBranchDef)).toThrow("并行分支内");

  const badMode = [
    "name: 坏的", "version: 1", "mode: coordinator", "goal: 做点事", "steps:",
    "  - id: s1", "    type: llm", "    prompt: 第一句",
    "    interrupt_before:", "      prompt: 看一眼", "",
  ].join("\n");
  expect(() => parseWorkflowDefinition(badMode, "wf.yaml")).toThrow("只用于 fixed 形态");

  const badPrompt = [
    "name: 坏的", "version: 1", "mode: fixed", "steps:",
    "  - id: s1", "    type: llm", "    prompt: 第一句",
    "    interrupt_before:", `      prompt: ${"x".repeat(501)}`, "",
  ].join("\n");
  expect(() => parseWorkflowDefinition(badPrompt, "wf.yaml")).toThrow("prompt");

  expect(() => parseWorkflowDefinition(twoStepYaml("before"), "wf.yaml")).not.toThrow();
});

// ---------------------------------------------------------------------------
// 端到端：before 点
// ---------------------------------------------------------------------------

test("InterruptTest.test_before_pause_respond_resume", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    await importWorkflow(home, writeDefFile(home, twoStepYaml("before")));
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    expect(run.pendingNodeId).toBe("s2");
    expect(run.pendingInterruptId).not.toBeNull();
    expect(provider.calls).toHaveLength(1);
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(it.stepId).toBe("s2");
    expect(it.point).toBe("before");
    expect(it.schema.fields).toHaveLength(1);
    expect(it.schema.fields[0].name).toBe("note");
    expect(it.contextSummary).toContain("第二句看第一句");
    // respond 后续跑。
    expect(await handleInterrupt(["respond", it.id, "--set", "note=没问题"], home)).toBe(0);
    const run2 = await resumeWorkflowFromInterrupt(home, run.id, reqFor(home, provider));
    expect(run2.status).toBe("completed");
    expect(run2.nodes).toHaveLength(2);
    expect(provider.calls).toHaveLength(2);
    expect(getInterrupt(home, it.id).decision).toBe("respond");
    // 已回过的单不能再回。
    expect(await handleInterrupt(["respond", it.id, "--set", "note=又一句"], home)).toBe(1);
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_before_edit_reruns_only_affected_step", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    await importWorkflow(home, writeDefFile(home, twoStepYaml("before", false)));
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(await handleInterrupt(["edit", it.id, "--set", "prompt=改后的第二句"], home)).toBe(0);
    const run2 = await resumeWorkflowFromInterrupt(home, run.id, reqFor(home, provider));
    expect(run2.status).toBe("completed");
    // 只重跑受影响的步骤：s1 只跑了一次，s2 用改后的 prompt 跑了一次。
    expect(provider.calls).toHaveLength(2);
    const secondCall = provider.calls[1] as { content: string }[];
    expect(JSON.stringify(secondCall)).toContain("改后的第二句");
    expect(JSON.stringify(secondCall)).not.toContain("第二句看第一句");
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_before_edit_tool_args", async () => {
  const home = tempHome();
  try {
    const f1 = join(home, "a.txt");
    const f2 = join(home, "b.txt");
    writeFileSync(f1, "文件甲的内容");
    writeFileSync(f2, "文件乙的内容");
    const yaml = [
      "name: 读一个文件",
      "version: 1",
      "mode: fixed",
      "steps:",
      "  - id: read",
      "    type: tool",
      "    tool: read_file",
      "    args:",
      `      path: ${JSON.stringify(f1)}`,
      "    interrupt_before:",
      "      prompt: 读之前看一眼路径",
      "",
    ].join("\n");
    await importWorkflow(home, writeDefFile(home, yaml));
    const run = await runWorkflowByName(home, "读一个文件", {}, reqFor(home, new FakeProvider()));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(await handleInterrupt(["edit", it.id, "--set", `path=${f2}`], home)).toBe(0);
    const run2 = await resumeWorkflowFromInterrupt(home, run.id, reqFor(home, new FakeProvider()));
    expect(run2.status).toBe("completed");
    expect(run2.nodes[0].output).toContain("文件乙的内容");
    expect(run2.nodes[0].output).not.toContain("文件甲的内容");
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_before_ignore_skips_step", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    await importWorkflow(home, writeDefFile(home, twoStepYaml("before", false)));
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(await handleInterrupt(["resume", it.id, "--decision", "ignore"], home)).toBe(0);
    const run2 = getWorkflowRun(home, run.id)!;
    expect(run2.status).toBe("completed");
    expect(run2.nodes).toHaveLength(2);
    expect(run2.nodes[1].status).toBe("skipped");
    expect(run2.nodes[1].output).toContain("ignore");
    expect(provider.calls).toHaveLength(1);
    expect(getInterrupt(home, it.id).decision).toBe("ignore");
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_if_false_step_does_not_interrupt", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    const yaml = [
      "name: 条件跳过",
      "version: 1",
      "mode: fixed",
      "inputs:",
      "  go: false",
      "steps:",
      "  - id: s1",
      "    type: llm",
      "    prompt: 第一句",
      "    if: inputs.go",
      "    interrupt_before:",
      "      prompt: 看一眼",
      "",
    ].join("\n");
    await importWorkflow(home, writeDefFile(home, yaml));
    const run = await runWorkflowByName(home, "条件跳过", {}, reqFor(home, provider));
    expect(run.status).toBe("completed");
    expect(run.nodes[0].status).toBe("skipped");
    expect(listInterrupts(home)).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 端到端：after 点
// ---------------------------------------------------------------------------

test("InterruptTest.test_after_pause_accept_resume", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    const yaml = [
      "name: 问两句",
      "version: 1",
      "mode: fixed",
      "steps:",
      "  - id: s1",
      "    type: llm",
      "    prompt: 第一句",
      "    interrupt_after:",
      "      prompt: 第一句跑完了，看一眼",
      "  - id: s2",
      "    type: llm",
      '    prompt: "第二句看第一句：{{steps.s1.output}}"',
      "",
    ].join("\n");
    await importWorkflow(home, writeDefFile(home, yaml));
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    expect(run.pendingNodeId).toBe("s1");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(it.point).toBe("after");
    expect(it.contextSummary).toContain("第一句的回答");
    expect(await handleInterrupt(["resume", it.id, "--decision", "accept"], home, { providerFactory: async () => provider as unknown as ProviderLike })).toBe(0);
    const run2 = getWorkflowRun(home, run.id)!;
    expect(run2.status).toBe("completed");
    expect(provider.calls).toHaveLength(2);
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_after_edit_output_syncs_checkpoint", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    const yaml = [
      "name: 问两句",
      "version: 1",
      "mode: fixed",
      "steps:",
      "  - id: s1",
      "    type: llm",
      "    prompt: 第一句",
      "    interrupt_after:",
      "      prompt: 第一句跑完了，改一下结果",
      "  - id: s2",
      "    type: llm",
      '    prompt: "第二句看第一句：{{steps.s1.output}}"',
      "",
    ].join("\n");
    await importWorkflow(home, writeDefFile(home, yaml));
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(await handleInterrupt(["edit", it.id, "--set", "output=改后的结果"], home)).toBe(0);
    expect(await handleInterrupt(["resume", it.id], home, { providerFactory: async () => provider as unknown as ProviderLike })).toBe(0);
    const run2 = getWorkflowRun(home, run.id)!;
    expect(run2.status).toBe("completed");
    expect(run2.nodes[0].output).toContain("改后的结果");
    // s2 用的就是改后的输出。
    const secondCall = provider.calls[1] as { content: string }[];
    expect(JSON.stringify(secondCall)).toContain("改后的结果");
    // 步级检查点同步了改后的值。
    const store = resolveStepCheckpointStore(home);
    const history = await getStepStateHistory(store, run.id);
    const s1cp = history.find((c) => c.stepId === "s1");
    expect(s1cp).toBeTruthy();
    expect(s1cp!.state["steps.s1.output"]).toBe("改后的结果");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 续跑不绕审批
// ---------------------------------------------------------------------------

test("InterruptTest.test_resume_does_not_bypass_approval", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    const yaml = [
      "name: 先问再批",
      "version: 1",
      "mode: fixed",
      "steps:",
      "  - id: s1",
      "    type: llm",
      "    prompt: 第一句",
      "    interrupt_before:",
      "      prompt: 看一眼",
      "  - id: gate",
      "    type: approve",
      "    title: 发版前确认",
      "",
    ].join("\n");
    await importWorkflow(home, writeDefFile(home, yaml));
    const run = await runWorkflowByName(home, "先问再批", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(await handleInterrupt(["resume", it.id, "--decision", "accept"], home, { providerFactory: async () => provider as unknown as ProviderLike })).toBe(0);
    const run2 = getWorkflowRun(home, run.id)!;
    expect(run2.status).toBe("awaiting_approval");
    expect(run2.pendingNodeId).toBe("gate");
    expect(run2.reviewItemId).not.toBeNull();
    const item = getReviewItem(home, run2.reviewItemId!);
    expect(item.status).toBe("pending");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// CLI 全程
// ---------------------------------------------------------------------------

test("InterruptTest.test_cli_full_flow", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    await importWorkflow(home, writeDefFile(home, twoStepYaml("before")));
    expect(await handleInterrupt([], home)).toBe(2);
    expect(await handleInterrupt(["list"], home)).toBe(0);
    expect(await handleInterrupt(["list", "--status", "bogus"], home)).toBe(2);
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    expect(await handleInterrupt(["show", it.id], home)).toBe(0);
    expect(await handleInterrupt(["show", "int-nope"], home)).toBe(1);
    expect(await handleInterrupt(["list", "--json"], home)).toBe(0);
    // 没回就 resume：报错。
    expect(await handleInterrupt(["resume", it.id], home)).toBe(2);
    // --set 当 respond 一次性回掉并续跑。
    expect(await handleInterrupt(["resume", it.id, "--set", "note=行"], home, { providerFactory: async () => provider as unknown as ProviderLike })).toBe(0);
    const run2 = getWorkflowRun(home, run.id)!;
    expect(run2.status).toBe("completed");
    // 已终态的单：list --status resolved 能看到。
    const listed = listInterrupts(home, "resolved");
    expect(listed).toHaveLength(1);
    expect(await handleInterrupt(["resume", it.id], home)).toBe(1);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 事件注册与进链
// ---------------------------------------------------------------------------

test("InterruptTest.test_events_registered", () => {
  const home = tempHome();
  try {
    const store = new RunStore(join(home, "runs"));
    const st = store.create("t", "sess-1", home, "normal", 1);
    expect(() => store.appendEvent(st.run_id, "workflow_interrupt_created", { workflow_run_id: "r1", interrupt_id: "int-1", step_id: "s1", point: "before" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_interrupt_resolved", { workflow_run_id: "r1", interrupt_id: "int-1", decision: "accept" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_interrupt_resumed", { workflow_run_id: "r1", interrupt_id: "int-1", decision: "accept" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_interrupt_nope", {})).toThrow();
  } finally {
    cleanup(home);
  }
});

test("InterruptTest.test_events_in_run_chain", async () => {
  const home = tempHome();
  const provider = new FakeProvider();
  try {
    await importWorkflow(home, writeDefFile(home, twoStepYaml("before")));
    const run = await runWorkflowByName(home, "问两句", {}, reqFor(home, provider));
    expect(run.status).toBe("awaiting_interrupt");
    const it = getInterrupt(home, run.pendingInterruptId!);
    const store = new RunStore(join(home, "runs"));
    const storeRun = store.list().find((s) => s.session_id === `workflow-${run.id}`);
    expect(storeRun).toBeTruthy();
    const types1 = store.readEvents(storeRun!.run_id).map((e) => e.type as string);
    expect(types1).toContain("workflow_interrupt_created");
    expect(await handleInterrupt(["respond", it.id, "--set", "note=ok"], home)).toBe(0);
    expect(await handleInterrupt(["resume", it.id], home, { providerFactory: async () => provider as unknown as ProviderLike })).toBe(0);
    // 续跑的 runner 会新建一个同 session_id 的 RunStore 运行（审批续跑同款），
    // 事件链分在两条记录里：合并同一 session_id 的全部记录再看。
    const allRuns = store.list().filter((s) => s.session_id === `workflow-${run.id}`);
    expect(allRuns.length).toBeGreaterThanOrEqual(2);
    const types2 = allRuns.flatMap((r) => store.readEvents(r.run_id)).map((e) => e.type as string);
    expect(types2).toContain("workflow_interrupt_resolved");
    expect(types2).toContain("workflow_interrupt_resumed");
    // 事件里不记回复原文。
    const resolved = allRuns.flatMap((r) => store.readEvents(r.run_id)).find((e) => e.type === "workflow_interrupt_resolved");
    expect(JSON.stringify(resolved)).not.toContain("ok");
  } finally {
    cleanup(home);
  }
});
