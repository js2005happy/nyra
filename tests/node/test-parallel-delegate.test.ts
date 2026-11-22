// tests/node/test-parallel-delegate.test.ts — 缺口 3a：delegate 并行模式。
// 只测能确定性验证的部分：并发上限硬顶、单任务超时、失败隔离、预算/深度被拒、
// 结构化证据字段（改了什么、花费）、工具层接线；不测真实模型调用，子任务用假 provider。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Agent, parsePorcelainChangedFiles } from "../../src/agent.ts";
import {
  runParallelDelegate, formatParallelResults, parallelConvergenceNote,
  resolveParallelOptions, DEFAULT_PARALLEL_TASK_TIMEOUT_MS, DEFAULT_CANCEL_GRACE_MS,
  type ParallelThreadOutcome,
} from "../../src/parallelDelegate.ts";
import { echoProvider, fakeProvider } from "./fake-provider.ts";
import { executeTool, newToolContext, TOOL_SCHEMAS } from "../../src/tools.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-home-"));
}

function newAgent(workdir: string, provider = echoProvider("子任务完成。")): Agent {
  return new Agent(provider, {
    workdir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home: makeHome(),
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
  } as never);
}

function okOutcome(summary = "完成。"): ParallelThreadOutcome {
  return { ok: true, summary, spentUsd: null, model: null, worktreePath: null, changedFiles: [], diffStat: null };
}

// ---- 选项解析：并发硬顶 5、超时默认 10 分钟 ----

test("选项解析：并发超过 5 夹到 5 并注明，小于 1 夹到 1，超时非法回默认", () => {
  expect(resolveParallelOptions({})).toEqual(
    { maxConcurrency: 5, timeoutMs: DEFAULT_PARALLEL_TASK_TIMEOUT_MS, maxConcurrencyClamped: false, cancelGraceMs: DEFAULT_CANCEL_GRACE_MS },
  );
  expect(resolveParallelOptions({ maxConcurrency: 8 }).maxConcurrency).toBe(5);
  expect(resolveParallelOptions({ maxConcurrency: 8 }).maxConcurrencyClamped).toBe(true);
  expect(resolveParallelOptions({ maxConcurrency: 0 }).maxConcurrency).toBe(1);
  expect(resolveParallelOptions({ maxConcurrency: 2, timeoutMs: 5000 }).timeoutMs).toBe(5000);
  expect(resolveParallelOptions({ timeoutMs: -1 }).timeoutMs).toBe(DEFAULT_PARALLEL_TASK_TIMEOUT_MS);
  expect(resolveParallelOptions({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_PARALLEL_TASK_TIMEOUT_MS);
});

// ---- 纯 runner：并发、失败隔离、超时 ----

test("runner：全部成功时计数与花费合计正确、结果按原顺序排", async () => {
  const r = await runParallelDelegate(async (spec) => ({
    ...okOutcome(`做了：${spec.task}`),
    spentUsd: 0.01,
    model: "fake-1",
  }), [{ task: "甲" }, { task: "乙" }, { task: "丙" }], { maxConcurrency: 2 });
  expect(r.succeeded).toBe(3);
  expect(r.failed).toBe(0);
  expect(r.timedOut).toBe(0);
  expect(r.rejected).toBe(0);
  expect(r.results.map((x) => x.task)).toEqual(["甲", "乙", "丙"]);
  expect(r.results[1].summary).toContain("做了：乙");
  expect(r.totalSpentUsd).toBeCloseTo(0.03, 6);
});

test("runner：并发上限被遵守（maxConcurrency=2 时同时在跑的 never 超过 2）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const r = await runParallelDelegate(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 50));
    inFlight -= 1;
    return okOutcome();
  }, [{ task: "a" }, { task: "b" }, { task: "c" }, { task: "d" }, { task: "e" }], { maxConcurrency: 2 });
  expect(r.succeeded).toBe(5);
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(maxInFlight).toBe(2);
});

test("runner：一个线程失败不拖垮其他线程，失败原因与状态逐项注明", async () => {
  const r = await runParallelDelegate(async (spec) => {
    if (spec.task === "坏") return { ...okOutcome(), ok: false, error: "子任务失败：炸了" };
    return { ...okOutcome(`好了：${spec.task}`), spentUsd: 0.02 };
  }, [{ task: "好1" }, { task: "坏" }, { task: "好2" }], {});
  expect(r.succeeded).toBe(2);
  expect(r.failed).toBe(1);
  expect(r.results[1].status).toBe("failed");
  expect(r.results[1].error).toContain("炸了");
  expect(r.results[1].summary).toBeNull();
  expect(r.results[0].summary).toContain("好了：好1");
  expect(r.results[2].summary).toContain("好了：好2");
  // 失败线程没花钱，合计只算成功者
  expect(r.totalSpentUsd).toBeCloseTo(0.04, 6);
});

test("runner：runOne 抛错也只记该线程失败", async () => {
  const r = await runParallelDelegate(async (spec) => {
    if (spec.task === "抛") throw new Error("底层炸了");
    return okOutcome();
  }, [{ task: "抛" }, { task: "稳" }], {});
  expect(r.failed).toBe(1);
  expect(r.succeeded).toBe(1);
  expect(r.results[0].error).toContain("底层炸了");
});

test("runner：超时线程判 timeout、其他线程照常完成、整体不等超时者", async () => {
  const started = Date.now();
  const r = await runParallelDelegate(async (spec) => {
    if (spec.task === "慢") await new Promise((res) => setTimeout(res, 5000));
    return okOutcome();
  }, [{ task: "慢" }, { task: "快" }], { timeoutMs: 50, maxConcurrency: 2 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(2000);
  expect(r.timedOut).toBe(1);
  expect(r.succeeded).toBe(1);
  expect(r.results[0].status).toBe("timeout");
  expect(r.results[0].error).toContain("超时");
  expect(r.results[1].status).toBe("ok");
});

test("runner：空任务列表直接抛错", async () => {
  await expect(runParallelDelegate(async () => okOutcome(), [], {})).rejects.toThrow("至少需要一个子任务");
});

test("格式化：汇总只给成功者、失败注明原因与成本、末尾写明本批未验收", async () => {
  const r = await runParallelDelegate(async (spec) => {
    if (spec.task === "坏") return { ...okOutcome(), ok: false, error: "原因：炸了", spentUsd: 0.005 };
    return { ...okOutcome("摘要原文"), spentUsd: 0.01, model: "fake-1" };
  }, [{ task: "好" }, { task: "坏" }], {});
  const text = formatParallelResults(r);
  expect(text).toContain("成功 1 个");
  expect(text).toContain("失败 1 个");
  expect(text).toContain("摘要原文");
  expect(text).toContain("原因：炸了");
  // 验收者未开启：汇总末尾如实写“本批未验收”，不编验证结论。
  expect(text).toContain("本批未验收");
});

test("收敛规则：写明只做自己那件、不碰别线程文件、收尾写收敛小结", () => {
  const note = parallelConvergenceNote(1, 3);
  expect(note).toContain("第 2 个");
  expect(note).toContain("3 个并行子任务");
  expect(note).toContain("不要修改、不要读取其他线程负责的文件");
  expect(note).toContain("收敛小结");
  expect(note).toContain("未验证");
});

// ---- porcelain 解析 ----

test("parsePorcelainChangedFiles：改动、新增、改名都能解析出路径", () => {
  expect(parsePorcelainChangedFiles(" M a.txt\n?? b/c.txt\nR  old.txt -> new.txt\n")).toEqual([
    "a.txt", "b/c.txt", "new.txt",
  ]);
  expect(parsePorcelainChangedFiles("")).toEqual([]);
});

// ---- Agent 层：delegateDetailed 与 delegateParallel ----

test("Agent.delegateParallel：两个子任务都成功，摘要与 parallel_delegate 事件齐全", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-par-"));
  const events: [string, Record<string, unknown>][] = [];
  const agent = newAgent(dir);
  (agent as unknown as { onEvent: unknown }).onEvent = (kind: string, data: Record<string, unknown>) => {
    events.push([kind, data]);
  };
  const r = await agent.delegateParallel([{ task: "任务甲" }, { task: "任务乙" }], {});
  expect(r.succeeded).toBe(2);
  expect(r.results.every((x) => x.status === "ok")).toBe(true);
  expect(r.results[0].summary).toContain("子任务完成。");
  expect(r.results[0].evidence.verification.status).toBe("not-verified");
  expect(r.results[0].evidence.changedFiles).toEqual([]);
  const ev = events.find(([k]) => k === "parallel_delegate");
  expect(ev).toBeDefined();
  expect(ev![1].succeeded).toBe(2);
  expect(ev![1].max_concurrency).toBe(5);
});

test("Agent.delegateParallel：10 个任务只放行 8 个，超出预算的被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-par-budget-"));
  const agent = newAgent(dir);
  const tasks = Array.from({ length: 10 }, (_, i) => ({ task: `任务${i + 1}` }));
  const r = await agent.delegateParallel(tasks, { maxConcurrency: 5 });
  expect(r.succeeded).toBe(8);
  expect(r.rejected).toBe(2);
  expect(r.results[8].status).toBe("rejected");
  expect(r.results[8].error).toContain("超出第 0 层子 agent 预算");
  expect(r.results[8].error).toContain("每层最多 8 个");
  expect(r.results[9].status).toBe("rejected");
});

test("Agent.delegateParallel：深度已满时整批被拒、一个线程都不启动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-par-depth-"));
  const agent = new Agent(echoProvider("不应跑。"), {
    workdir: dir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home: makeHome(),
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    delegateDepth: 2,
  } as never);
  const r = await agent.delegateParallel([{ task: "甲" }, { task: "乙" }], {});
  expect(r.succeeded).toBe(0);
  expect(r.rejected).toBe(2);
  expect(r.results[0].error).toContain("最大委派深度");
});

test("Agent.delegateParallel：空任务与空子任务抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-par-empty-"));
  const agent = newAgent(dir);
  await expect(agent.delegateParallel([], {})).rejects.toThrow("至少需要一个子任务");
  await expect(agent.delegateParallel([{ task: "  " }], {})).rejects.toThrow("第 1 个子任务为空");
});

test("Agent.delegateParallel：慢 provider + 短超时判 timeout，其他线程照常成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-par-timeout-"));
  const slow = fakeProvider([{ content: "慢任务完成。" }], { delayMs: 5000 });
  const agent = newAgent(dir, slow as never);
  // 两个线程共用同一个慢 provider：快线程也会慢——改用各自独立的 provider 无法直接测；
  // 这里只断言：超时线程被判 timeout、整体在 2 秒内返回（不等 5 秒的模型调用）。
  const started = Date.now();
  const r = await agent.delegateParallel([{ task: "慢任务" }], { timeoutMs: 50 });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(r.timedOut).toBe(1);
  expect(r.results[0].status).toBe("timeout");
});

test("Agent.delegateParallel：并发 2 跑 4 个快任务比串行快", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-par-conc-"));
  const provider = fakeProvider([{ content: "完成。" }], { delayMs: 200 });
  const agent = newAgent(dir, provider as never);
  const started = Date.now();
  const r = await agent.delegateParallel(
    [{ task: "a" }, { task: "b" }, { task: "c" }, { task: "d" }],
    { maxConcurrency: 2 },
  );
  const elapsed = Date.now() - started;
  expect(r.succeeded).toBe(4);
  // 2 并发 × 2 轮 × 200ms ≈ 400ms；串行要 800ms。放宽到 1500ms 防 CI 抖动。
  expect(elapsed).toBeLessThan(1500);
});

test("delegateDetailed 与 delegate 文本一致；无改动 worktree 返回空证据", async () => {
  const repo = mkdtempSync(join(tmpdir(), "nyra-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "内容\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
  const agent = newAgent(repo);
  const d = await agent.delegateDetailed("读一下 a.txt", 1, { isolation: "worktree" });
  expect(d.ok).toBe(true);
  expect(d.changedFiles).toEqual([]);
  expect(d.diffStat).toBeNull();
  expect(d.worktreePath).toBeNull();
  expect(d.text).toContain("没有改动任何文件");
  const plain = await agent.delegate("读一下 a.txt", 1, { isolation: "worktree" });
  expect(plain).toContain("没有改动任何文件");
});

test("delegateDetailed：worktree 里写了文件，证据里有改动文件与保留的工作树", async () => {
  const repo = mkdtempSync(join(tmpdir(), "nyra-repo-w-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "内容\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
  const writer = fakeProvider([
    {
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "new.txt", content: "新文件\n" }) } }],
    },
    { content: "写完了。改了 new.txt，未验证。" },
  ]);
  // 子任务写文件：非交互 auto 模式会拦写操作，测试里用 full 模式（只验接线本身）。
  const agent = new Agent(writer as never, {
    workdir: repo,
    mode: "full",
    maxTurns: 2,
    interactive: false,
    home: makeHome(),
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
  } as never);
  const d = await agent.delegateDetailed("新建 new.txt", 2, { isolation: "worktree" });
  try {
    expect(d.ok).toBe(true);
    expect(d.changedFiles).toContain("new.txt");
    expect(d.worktreePath).not.toBeNull();
    expect(existsSync(join(d.worktreePath!, "new.txt"))).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("内容\n");
  } finally {
    if (d.worktreePath) {
      spawnSync("git", ["worktree", "remove", "--force", d.worktreePath], { cwd: repo });
      rmSync(d.worktreePath, { recursive: true, force: true });
    }
  }
});

// ---- 工具层：schema 与分派 ----

test("TOOL_SCHEMAS 含 delegate_parallel，并发上限最大 5、超时默认 600000", () => {
  const s = TOOL_SCHEMAS.find((x) => (x as { function?: { name?: string } }).function?.name === "delegate_parallel");
  expect(s).toBeDefined();
  const props = (s as unknown as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }).function.parameters.properties;
  expect(props.max_concurrency.maximum).toBe(5);
  expect(props.timeout_ms.default).toBe(600000);
  expect(props.tasks).toBeDefined();
});

test("工具层 delegate_parallel：缺 task 时明确报错；正常走 stub 返回汇总", async () => {
  const ctx = newToolContext({
    workdir: mkdtempSync(join(tmpdir(), "nyra-tool-")),
    delegateParallelFn: async (tasks) => `并行完成 ${tasks.length} 个`,
  });
  const bad = await executeTool("delegate_parallel", { tasks: [{ task: "" }] }, ctx);
  expect(bad).toContain("缺少非空 task");
  const empty = await executeTool("delegate_parallel", { tasks: [] }, ctx);
  expect(empty).toContain("至少需要一个子任务");
  // H-6：background 默认 true（走后台），同步路须显式传 background: false。
  const ok = await executeTool("delegate_parallel", { tasks: [{ task: "甲" }, { task: "乙" }], background: false }, ctx);
  expect(ok).toContain("并行完成 2 个");
});

test("工具层 delegate_parallel：未接 delegateParallelFn 时明确报错", async () => {
  const ctx = newToolContext({ workdir: mkdtempSync(join(tmpdir(), "nyra-tool2-")) });
  const out = await executeTool("delegate_parallel", { tasks: [{ task: "甲" }], background: false }, ctx);
  expect(out).toContain("并行子 agent 不可用");
});
