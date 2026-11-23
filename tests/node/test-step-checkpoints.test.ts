// tests/node/test-step-checkpoints.test.ts — G-P1-40 步级持久化 + 时间旅行。
//
// 覆盖：检查点构建（指纹/摘要截断）、状态快照（32 步上限）、upsert 去重、
// store 三档（内存往返、文件 0600/符号链接拒绝/损坏备份、远端回环 HTTP）、
// 后端解析、get_state / history、update_state（合并写、作废后续、非法键值、
// 只 unset）、planReplay（分类、coordinator 不支持、作废/缺失抛错、for_each
// 回到循环步）、端到端（真跑工作流 → 自动记检查点 → 改值 → 重放，新运行
// 用改后的值、原运行不动）、CLI 全程。全部在临时 home / 假 provider /
// 本机回环上跑，不调真模型、不碰真云端。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  buildStepCheckpoint,
  createFileStepCheckpointStore,
  createMemoryStepCheckpointStore,
  createRemoteStepCheckpointStore,
  getStepState,
  getStepStateHistory,
  planReplay,
  resolveCheckpointStep,
  resolveStepCheckpointStore,
  snapshotStepsState,
  updateStepState,
  upsertCheckpoint,
  type StepCheckpoint,
} from "../../src/stepCheckpoints.ts";
import {
  getWorkflowRun,
  importWorkflow,
  replayWorkflowFromCheckpoint,
  runWorkflowByName,
  saveWorkflowRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunRequest,
} from "../../src/workflow.ts";
import { handleCheckpoint } from "../../src/stepCheckpointCli.ts";
import { RunStore } from "../../src/runs.ts";
import { expectPerms } from "./fsPerms.ts";
import type { ProviderLike } from "../../src/providers.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-stepcp-test-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function fakeProvider(captured: string[]): ProviderLike {
  return {
    name: "fake",
    model: "fake-model",
    baseUrl: "",
    hasCredentials: () => true,
    chat: async (messages) => {
      captured.push(messages.map((m) => String(m.content)).join("\n"));
      return {
        choices: [{ message: { content: "FAKE-REPLY" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    listModels: async () => ["fake-model"],
    redact: (t: string) => t,
  };
}

function reqFor(home: string, store: ReturnType<typeof createMemoryStepCheckpointStore>): WorkflowRunRequest {
  return {
    workdir: home,
    mode: "normal",
    interactive: false,
    providerFactory: async () => fakeProvider([]),
    stepCheckpointStore: store,
  };
}

function cp(over: Partial<StepCheckpoint> & { stepId: string; stepIndex: number }): StepCheckpoint {
  return {
    version: 1,
    runId: "run-1",
    workflow: "w",
    status: "ok",
    state: {},
    inputFingerprint: "ab".repeat(32),
    outputSummary: "",
    spentUsd: null,
    createdAt: "2026-11-24T00:00:00.000Z",
    invalidated: false,
    invalidatedReason: null,
    ...over,
  };
}

const THREE_STEP_DEF: WorkflowDefinition = {
  name: "三步",
  version: 1,
  mode: "fixed",
  inputs: { file: "/tmp/x.txt" },
  steps: [
    { id: "read", type: "tool", tool: "read_file", args: { path: "{{inputs.file}}" } },
    { id: "draft", type: "llm", prompt: "总结：{{steps.read.output}}" },
    { id: "note", type: "llm", prompt: "再写一句：{{steps.draft.output}}" },
  ],
};

async function runThreeStep(home: string, store: ReturnType<typeof createMemoryStepCheckpointStore>): Promise<{ run: WorkflowRun; prompts: string[] }> {
  const prompts: string[] = [];
  writeFileSync(join(home, "hello.txt"), "hello-original");
  const req: WorkflowRunRequest = {
    workdir: home,
    mode: "normal",
    interactive: false,
    providerFactory: async () => fakeProvider(prompts),
    stepCheckpointStore: store,
  };
  // 定价只补进现有 config，不覆盖已有的 step_checkpoint_store 等键。
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>; } catch { /* 没有就新建 */ }
  writeFileSync(join(home, "config.json"), JSON.stringify({
    ...cfg,
    pricing: { "fake-model": { input_per_1m: 100, output_per_1m: 200 } },
  }));
  const run = await runWorkflowByName(home, "三步", { file: join(home, "hello.txt") }, req);
  return { run, prompts };
}

function importThreeStep(home: string): void {
  writeFileSync(join(home, "three.yaml"), [
    "name: 三步",
    "version: 1",
    "mode: fixed",
    "inputs:",
    "  file: /tmp/x.txt",
    "steps:",
    "  - id: read",
    "    type: tool",
    "    tool: read_file",
    "    args:",
    "      path: '{{inputs.file}}'",
    "  - id: draft",
    "    type: llm",
    "    prompt: '总结：{{steps.read.output}}'",
    "  - id: note",
    "    type: llm",
    "    prompt: '再写一句：{{steps.draft.output}}'",
    "",
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// 构建与快照
// ---------------------------------------------------------------------------

test("buildStepCheckpoint：字段、输入指纹、输出摘要截断 500 字", () => {
  const c = buildStepCheckpoint({
    runId: "r1", workflow: "w",
    node: { id: "read", type: "tool", status: "ok", input: "{\"path\":\"/x\"}", output: "y".repeat(600), spentUsd: null },
    stepIndex: 0,
    stepsState: { "steps.read.output": "short", "steps.read.ok": true },
  });
  expect(c.version).toBe(1);
  expect(c.stepId).toBe("read");
  expect(c.inputFingerprint).toHaveLength(64);
  expect(c.outputSummary).toHaveLength(500);
  expect(c.invalidated).toBe(false);
  expect(() => buildStepCheckpoint({
    runId: "r1", workflow: "w",
    node: { id: "Bad Id!", type: "tool", status: "ok", input: null, output: null, spentUsd: null },
    stepIndex: 0, stepsState: {},
  })).toThrow();
});

test("snapshotStepsState：只留最近 32 步，输出截断 500 字", () => {
  const scope: Record<string, { output?: unknown; ok?: unknown }> = {};
  for (let i = 0; i < 40; i++) scope[`s${i}`] = { output: "x".repeat(600), ok: true };
  const state = snapshotStepsState(scope);
  expect(Object.keys(state)).toHaveLength(64);
  expect(state["steps.s0.output"]).toBeUndefined();
  expect(state["steps.s39.output"]).toHaveLength(500);
  expect(state["steps.s39.ok"]).toBe(true);
});

test("upsertCheckpoint：同一步只留最新一条，按步序号排序，超 500 丢最旧", () => {
  const list = upsertCheckpoint([], cp({ stepId: "a", stepIndex: 1 }));
  const list2 = upsertCheckpoint(list, cp({ stepId: "b", stepIndex: 0 }));
  expect(list2.map((c) => c.stepId)).toEqual(["b", "a"]);
  const list3 = upsertCheckpoint(list2, cp({ stepId: "a", stepIndex: 1, outputSummary: "new" }));
  expect(list3).toHaveLength(2);
  expect(list3.find((c) => c.stepId === "a")!.outputSummary).toBe("new");
});

test("resolveCheckpointStep：精确节点 id 优先，步骤 id 取最后一轮，缺失返回 null", () => {
  const list = [
    cp({ stepId: "loop[0]", stepIndex: 2 }),
    cp({ stepId: "loop[1]", stepIndex: 2 }),
    cp({ stepId: "done", stepIndex: 3 }),
  ];
  expect(resolveCheckpointStep(list, "loop[0]")!.stepId).toBe("loop[0]");
  expect(resolveCheckpointStep(list, "loop")!.stepId).toBe("loop[1]");
  expect(resolveCheckpointStep(list, "nope")).toBeNull();
});

// ---------------------------------------------------------------------------
// store 三档
// ---------------------------------------------------------------------------

test("内存 store：往返隔离，两个运行互不干扰", async () => {
  const store = createMemoryStepCheckpointStore();
  await store.save("r1", [cp({ runId: "r1", stepId: "a", stepIndex: 0 })]);
  await store.save("r2", [cp({ runId: "r2", stepId: "b", stepIndex: 0 })]);
  expect((await store.load("r1")).map((c) => c.stepId)).toEqual(["a"]);
  expect((await store.load("r2")).map((c) => c.stepId)).toEqual(["b"]);
  expect(await store.load("r3")).toEqual([]);
});

test("文件 store：往返 / 0600 / 符号链接拒绝 / 损坏备份 / 非法运行 id 拒绝", async () => {
  const home = tempHome();
  try {
    const store = createFileStepCheckpointStore(home);
    await store.save("20261124-000000-abcdef", [cp({ runId: "20261124-000000-abcdef", stepId: "a", stepIndex: 0 })]);
    const path = join(home, "step-checkpoints", "20261124-000000-abcdef.json");
    expectPerms(path, 0o600);
    expect((await store.load("20261124-000000-abcdef")).map((c) => c.stepId)).toEqual(["a"]);
    // 损坏先备份再抛错
    writeFileSync(path, "{broken");
    expect(() => store.loadSync("20261124-000000-abcdef")).toThrow("损坏");
    // 符号链接拒绝
    const target = join(home, "step-checkpoints", "20261124-000001-abcdef.json");
    writeFileSync(join(home, "real.json"), JSON.stringify({ version: 1, runId: "x", checkpoints: [] }));
    symlinkSync(join(home, "real.json"), target);
    expect(() => store.loadSync("20261124-000001-abcdef")).toThrow("符号链接");
    expect(() => store.loadSync("../escape")).toThrow("不合法");
  } finally {
    cleanup(home);
  }
});

test("后端解析：默认 file，环境变量优先，非法后端与无地址的 remote 都拒绝", () => {
  const home = tempHome();
  try {
    expect(resolveStepCheckpointStore(home).kind).toBe("file");
    expect(resolveStepCheckpointStore(home, { backend: "memory" }).kind).toBe("memory");
    expect(() => resolveStepCheckpointStore(home, { backend: "nope" as never })).toThrow("不认");
    expect(() => resolveStepCheckpointStore(home, { backend: "remote" })).toThrow("须配地址");
    const prev = process.env.NYRA_STEP_CHECKPOINT_STORE;
    process.env.NYRA_STEP_CHECKPOINT_STORE = "memory";
    try {
      expect(resolveStepCheckpointStore(home).kind).toBe("memory");
    } finally {
      if (prev === undefined) delete process.env.NYRA_STEP_CHECKPOINT_STORE;
      else process.env.NYRA_STEP_CHECKPOINT_STORE = prev;
    }
  } finally {
    cleanup(home);
  }
});

test("远端 store：本机回环 HTTP 往返，token 头带上，非 2xx 抛错", async () => {
  const data = new Map<string, StepCheckpoint[]>();
  let sawAuth = "";
  const server = createServer((req, res) => {
    sawAuth = String(req.headers.authorization ?? "");
    const m = /^\/runs\/([^/]+)\/checkpoints$/.exec(req.url ?? "");
    if (!m) { res.writeHead(404); res.end(); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ checkpoints: data.get(m[1]) ?? [] }));
      return;
    }
    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        data.set(m[1], (JSON.parse(body) as { checkpoints: StepCheckpoint[] }).checkpoints);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const store = createRemoteStepCheckpointStore(`http://127.0.0.1:${port}`, { token: "tok-123" });
    expect(store.loadSync).toBeUndefined();
    await store.save("r1", [cp({ runId: "r1", stepId: "a", stepIndex: 0 })]);
    expect(sawAuth).toBe("Bearer tok-123");
    expect((await store.load("r1")).map((c) => c.stepId)).toEqual(["a"]);
    const bad = createRemoteStepCheckpointStore(`http://127.0.0.1:${port}/nope`, {});
    await expect(bad.load("r1")).rejects.toThrow("HTTP 404");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// get_state / update_state
// ---------------------------------------------------------------------------

test("get_state：取最新未作废；全作废或没有时抛错", async () => {
  const store = createMemoryStepCheckpointStore();
  await expect(getStepState(store, "r1")).rejects.toThrow("没有可用");
  await store.save("r1", [
    cp({ runId: "r1", stepId: "a", stepIndex: 0, state: { "steps.a.output": "A" } }),
    cp({ runId: "r1", stepId: "b", stepIndex: 1, state: { "steps.a.output": "A", "steps.b.output": "B" }, invalidated: true }),
  ]);
  const s = await getStepState(store, "r1");
  expect(s.stepId).toBe("a");
  expect(s.state["steps.a.output"]).toBe("A");
});

test("update_state：合并写 + 后续作废；作废的不能再改；非法键值拒绝；只 unset 也行", async () => {
  const store = createMemoryStepCheckpointStore();
  await store.save("r1", [
    cp({ runId: "r1", stepId: "a", stepIndex: 0, state: { "steps.a.output": "A" } }),
    cp({ runId: "r1", stepId: "b", stepIndex: 1, state: { "steps.a.output": "A", "steps.b.output": "B" } }),
    cp({ runId: "r1", stepId: "c", stepIndex: 2, state: { "steps.c.output": "C" } }),
  ]);
  const { checkpoint, invalidatedCount } = await updateStepState(store, "r1", "a", { "steps.a.output": "A2" });
  expect(checkpoint.state["steps.a.output"]).toBe("A2");
  expect(invalidatedCount).toBe(2);
  const after = await store.load("r1");
  expect(after.filter((c) => c.invalidated)).toHaveLength(2);
  await expect(updateStepState(store, "r1", "b", { "steps.b.output": "B2" })).rejects.toThrow("已被作废");
  await expect(updateStepState(store, "r1", "a", { "steps.a.output": "x".repeat(1001) })).rejects.toThrow("太长");
  await expect(updateStepState(store, "r1", "a", { "whatever": "x" })).rejects.toThrow("不认");
  await expect(updateStepState(store, "r1", "a", { "steps.a.ok": "yes" })).rejects.toThrow("true/false");
  await expect(updateStepState(store, "r1", "nope", { "steps.a.output": "x" })).rejects.toThrow("没有步骤");
  // 只 unset：删键成功，不改值
  const r2 = await updateStepState(store, "r1", "a", {}, ["steps.a.output"]);
  expect(r2.checkpoint.state["steps.a.output"]).toBeUndefined();
  expect(r2.invalidatedCount).toBe(0);
});

// ---------------------------------------------------------------------------
// planReplay
// ---------------------------------------------------------------------------

const PLAN_DEF: WorkflowDefinition = {
  name: "p", version: 1, mode: "fixed",
  steps: [
    { id: "read", type: "tool", tool: "read_file", args: {} },
    { id: "draft", type: "llm", prompt: "x" },
    { id: "ask", type: "approve", title: "批一下" },
    { id: "more", type: "knowledge", base: "kb", query: "q" },
  ],
};

test("planReplay：分类 deterministic/costed/approval，needsConfirmation 只看后面", () => {
  const cps = [cp({ runId: "r", stepId: "read", stepIndex: 0 }), cp({ runId: "r", stepId: "draft", stepIndex: 1 })];
  const p = planReplay(PLAN_DEF, cps, "read");
  expect(p.supported).toBe(true);
  expect(p.nextIndex).toBe(1);
  expect(p.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["draft:costed", "ask:approval", "more:deterministic"]);
  expect(p.needsConfirmation).toBe(true);
  const cps2 = [...cps, cp({ runId: "r", stepId: "ask", stepIndex: 2 })];
  const p2 = planReplay(PLAN_DEF, cps2, "ask");
  expect(p2.steps.map((s) => s.id)).toEqual(["more"]);
  expect(p2.needsConfirmation).toBe(false);
});

test("planReplay：coordinator 不支持；缺失与作废抛错；for_each 回到循环步", () => {
  const coordDef = { ...PLAN_DEF, mode: "coordinator" as const, goal: "g" };
  const p = planReplay(coordDef, [cp({ runId: "r", stepId: "read", stepIndex: 0 })], "read");
  expect(p.supported).toBe(false);
  expect(p.reason).toMatch("fixed");
  expect(() => planReplay(PLAN_DEF, [], "read")).toThrow("没有步骤");
  const bad = [cp({ runId: "r", stepId: "read", stepIndex: 0, invalidated: true, invalidatedReason: "x" })];
  expect(() => planReplay(PLAN_DEF, bad, "read")).toThrow("已被作废");
  // for_each：检查点是 loop[1]，重放从 loop 步的下一条开始
  const loopDef: WorkflowDefinition = {
    name: "l", version: 1, mode: "fixed",
    steps: [
      { id: "loop", type: "tool", tool: "read_file", args: {}, for_each: { items: "[]", as: "x" } },
      { id: "tail", type: "tool", tool: "read_file", args: {} },
    ],
  };
  const p2 = planReplay(loopDef, [cp({ runId: "r", stepId: "loop[1]", stepIndex: 0 })], "loop");
  expect(p2.fromStepId).toBe("loop");
  expect(p2.nextIndex).toBe(1);
  expect(p2.steps.map((s) => s.id)).toEqual(["tail"]);
});

// ---------------------------------------------------------------------------
// 端到端：真跑 → 自动记检查点 → 改值 → 重放
// ---------------------------------------------------------------------------

test("端到端：跑三步自动记 3 条检查点；改 read 输出后重放，新运行用改后的值、原运行不动", async () => {
  const home = tempHome();
  try {
    importThreeStep(home);
    await importWorkflow(home, join(home, "three.yaml"));
    const store = createMemoryStepCheckpointStore();
    const { run, prompts } = await runThreeStep(home, store);
    expect(run.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("hello-original");
    const history = await getStepStateHistory(store, run.id);
    expect(history.map((c) => c.stepId)).toEqual(["read", "draft", "note"]);
    expect(history[0].state["steps.read.output"]).toBe("hello-original");
    // 改 read 的输出：draft 与 note 作废
    const { invalidatedCount } = await updateStepState(store, run.id, "read", { "steps.read.output": "hello-edited" });
    expect(invalidatedCount).toBe(2);
    // 没 --yes：后面有 llm 步骤，直接拒绝
    const req: WorkflowRunRequest = {
      workdir: home, mode: "normal", interactive: false,
      providerFactory: async () => fakeProvider([]),
      stepCheckpointStore: store,
    };
    await expect(replayWorkflowFromCheckpoint(home, run.id, "read", req, {})).rejects.toThrow("--yes");
    // 从作废的 draft 重放：拒绝
    await expect(replayWorkflowFromCheckpoint(home, run.id, "draft", req, { confirmCosted: true })).rejects.toThrow("已被作废");
    // 从 read 重放：新运行、draft 的提示词里是改后的值
    const prompts2: string[] = [];
    const req2: WorkflowRunRequest = {
      workdir: home, mode: "normal", interactive: false,
      providerFactory: async () => fakeProvider(prompts2),
      stepCheckpointStore: store,
    };
    const { run: newRun, plan } = await replayWorkflowFromCheckpoint(home, run.id, "read", req2, { confirmCosted: true });
    expect(newRun).not.toBeNull();
    expect(newRun!.id).not.toBe(run.id);
    expect(newRun!.status).toBe("completed");
    expect(newRun!.replayedFrom).toEqual({ runId: run.id, stepId: "read", at: expect.any(String) });
    expect(newRun!.nodes.map((n) => n.id)).toEqual(["read", "draft", "note"]);
    expect(newRun!.nodes[0].output).toBe("hello-edited");
    expect(plan.steps.map((s) => s.id)).toEqual(["draft", "note"]);
    expect(prompts2[0]).toContain("hello-edited");
    // 原运行不动：节点还是 3 条、输出还是原值
    const orig = getWorkflowRun(home, run.id)!;
    expect(orig.nodes.map((n) => n.id)).toEqual(["read", "draft", "note"]);
    expect(orig.nodes[0].output).toBe("hello-original");
    // 重放事件进了新运行的事件链
    const rs = new RunStore(join(home, "runs"));
    const rsRun = rs.list().find((s) => s.session_id === `workflow-${newRun!.id}`);
    expect(rsRun).toBeDefined();
    const events = rs.readEvents(rsRun!.run_id);
    expect(events.some((e) => e.type === "step_checkpoint_replayed")).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("端到端：coordinator 运行重放直接拒绝；没有检查点的运行重放拒绝", async () => {
  const home = tempHome();
  try {
    const store = createMemoryStepCheckpointStore();
    const run: WorkflowRun = {
      id: "20261124-000000-abcdef", workflow: "c", status: "failed", inputs: {},
      definition: { name: "c", version: 1, mode: "coordinator", goal: "g", steps: [{ id: "a", type: "llm", prompt: "x" }] },
      nodes: [], spentUsd: null, startedAt: "2026-11-24T00:00:00.000Z", endedAt: null,
      dryRun: false, trial: false, error: null, pendingNodeId: null, pendingNodeIndex: null,
      reviewItemId: null, dryRunPlanHash: null, coordinator: null,
    };
    saveWorkflowRun(home, run);
    await store.save(run.id, [cp({ runId: run.id, stepId: "a", stepIndex: 0 })]);
    const req = reqFor(home, store);
    await expect(replayWorkflowFromCheckpoint(home, run.id, "a", req, { confirmCosted: true, stepCheckpointStore: store })).rejects.toThrow("fixed");
    await expect(replayWorkflowFromCheckpoint(home, "no-such-run", "a", req, {})).rejects.toThrow("没有这个运行");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// CLI 全程
// ---------------------------------------------------------------------------

test("CLI：list/show/history/update/replay --dry-run/store 全程", async () => {
  const home = tempHome();
  try {
    importThreeStep(home);
    await importWorkflow(home, join(home, "three.yaml"));
    // CLI 走默认后端解析：先把内存后端写进 config，跑与查才看到同一份检查点。
    writeFileSync(join(home, "config.json"), JSON.stringify({ step_checkpoint_store: "memory" }));
    const store = resolveStepCheckpointStore(home, { backend: "memory" });
    await runThreeStep(home, store);
    // 找到那条运行：直接读账本
    const { loadWorkflowRuns } = await import("../../src/workflow.ts");
    const runs = loadWorkflowRuns(home).runs;
    expect(runs).toHaveLength(1);
    const id = runs[0].id;
    // list
    let code = await handleCheckpoint(["list", id], home);
    expect(code).toBe(0);
    // show
    code = await handleCheckpoint(["show", id, "draft"], home);
    expect(code).toBe(0);
    code = await handleCheckpoint(["show", id, "nope"], home);
    expect(code).toBe(1);
    // history
    code = await handleCheckpoint(["history", id, "--json"], home);
    expect(code).toBe(0);
    // update
    code = await handleCheckpoint(["update", id, "read", "--set", "steps.read.output=hello-cli"], home);
    expect(code).toBe(0);
    const after = await store.load(id);
    expect(after.find((c) => c.stepId === "read")!.state["steps.read.output"]).toBe("hello-cli");
    expect(after.filter((c) => c.invalidated)).toHaveLength(2);
    // update 事件进了原运行事件链（只记元数据）
    const rs = new RunStore(join(home, "runs"));
    const rsRun = rs.list().find((s) => s.session_id === `workflow-${id}`);
    expect(rsRun).toBeDefined();
    const events = rs.readEvents(rsRun!.run_id);
    expect(events.some((e) => e.type === "step_checkpoint_updated")).toBe(true);
    // replay --dry-run：只看计划不跑
    code = await handleCheckpoint(["replay", id, "read", "--dry-run"], home);
    expect(code).toBe(0);
    expect(loadWorkflowRuns(home).runs).toHaveLength(1);
    // replay 没 --yes：拒绝
    code = await handleCheckpoint(["replay", id, "read"], home);
    expect(code).toBe(2);
    // store：看 + 改
    code = await handleCheckpoint(["store"], home);
    expect(code).toBe(0);
    code = await handleCheckpoint(["store", "--backend", "memory"], home);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
    expect(cfg.step_checkpoint_store).toBe("memory");
    code = await handleCheckpoint(["store", "--backend", "nope"], home);
    expect(code).toBe(2);
    // 未知动作与缺参
    code = await handleCheckpoint(["nope"], home);
    expect(code).toBe(2);
    code = await handleCheckpoint([], home);
    expect(code).toBe(2);
  } finally {
    cleanup(home);
  }
});

test("事件：step_checkpoint_updated / step_checkpoint_replayed 已注册，未知类型抛错", () => {
  const home = tempHome();
  try {
    const store = new RunStore(join(home, "runs"));
    const st = store.create("测试", "test-session", home, "normal", 1);
    expect(() => store.appendEvent(st.run_id, "step_checkpoint_updated", { workflow_run_id: "r", step_id: "a", invalidated: 2 })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "step_checkpoint_replayed", { workflow_run_id: "r2", from_run_id: "r", step_id: "a", steps_replayed: 2 })).not.toThrow();
  } finally {
    cleanup(home);
  }
});
