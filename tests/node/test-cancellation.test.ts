// tests/node/test-cancellation.test.ts — 可靠性打磨第 1 项第一批：真取消执行。
// 测的是“底层真的停了”，不是 Promise.race 返回了：
//   - 模型请求 abort（假 transport 上断言信号真的 abort 了）；
//   - 超时后子进程确实退出（shell 工具，用 pid 断言进程已死）；
//   - /stop、超时、预算触顶走同一条取消信号（Agent 层）；
//   - 停不下来时如实记“正在停止”，不谎报已停。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CancelController, CancelError, awaitSettled, cancelErrorFromSignal,
  combineSignals, isCancelError, raceWithSignal,
} from "../../src/cancel.ts";
import {
  Provider, FallbackProvider, type ProviderLike, type ResolvedProvider,
} from "../../src/providers.ts";
import {
  runParallelDelegate, formatParallelResults,
  type ParallelTaskSpec, type ParallelThreadOutcome,
} from "../../src/parallelDelegate.ts";
import { Agent } from "../../src/agent.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";
import {
  registerSubagentRun, requestSubagentStop, getSubagentRun,
} from "../../src/resume.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("CancellationTest.test_cancel_controller_abort_once_first_reason_wins", () => {
  const c = new CancelController();
  expect(c.aborted).toBe(false);
  expect(c.reason).toBe(null);
  c.abort("timeout");
  expect(c.aborted).toBe(true);
  expect(c.reason).toBe("timeout");
  c.abort("stop");
  expect(c.reason).toBe("timeout");
  expect(() => c.throwIfAborted()).toThrow("已取消");
  expect(isCancelError(new CancelError("budget"))).toBe(true);
  expect(isCancelError(new Error("plain"))).toBe(false);
  expect(isCancelError(cancelErrorFromSignal(c.signal, "stop"))).toBe(true);
});

test("CancellationTest.test_combine_signals_any_abort_wins", () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineSignals([a.signal, b.signal]);
  expect(combined.aborted).toBe(false);
  b.abort(new CancelError("budget"));
  expect(combined.aborted).toBe(true);
  expect(cancelErrorFromSignal(combined, "stop").reason).toBe("budget");
  const already = new AbortController();
  already.abort(new CancelError("stop"));
  expect(combineSignals([already.signal]).aborted).toBe(true);
  expect(combineSignals([]).aborted).toBe(false);
});

test("CancellationTest.test_race_with_signal_resolves_and_aborts", async () => {
  expect(await raceWithSignal(Promise.resolve(42), new AbortController().signal)).toBe(42);
  const ac = new AbortController();
  const p = raceWithSignal(new Promise(() => {}), ac.signal);
  setTimeout(() => ac.abort(new CancelError("timeout")), 20);
  await expect(p).rejects.toThrow("已取消");
});

test("CancellationTest.test_await_settled_grace", async () => {
  const fast = await awaitSettled(Promise.resolve("ok"), 100);
  expect(fast.settled).toBe(true);
  expect(fast.value).toBe("ok");
  const slow = await awaitSettled(new Promise(() => {}), 30);
  expect(slow.settled).toBe(false);
});

function providerCfg(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash",
    apiKey: "test", keySource: "env", hasKey: true, envKey: "TEST_KEY", auth: "env",
    preset: { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-flash", envKey: "DEEPSEEK_API_KEY" },
    ...overrides,
  } as ResolvedProvider;
}

test("CancellationTest.test_provider_chat_external_abort_kills_request", async () => {
  const origFetch = globalThis.fetch;
  let seenSignal: AbortSignal | null = null;
  let fetchCalls = 0;
  (globalThis as Record<string, unknown>).fetch = async (_url: unknown, init?: Record<string, unknown>) => {
    fetchCalls += 1;
    const sig = init?.signal as AbortSignal | undefined;
    seenSignal = sig ?? null;
    await new Promise<void>((resolve) => {
      if (!sig) { setTimeout(resolve, 10000); return; }
      if (sig.aborted) { resolve(); return; }
      sig.addEventListener("abort", () => resolve(), { once: true });
    });
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  try {
    const p = new Provider(providerCfg());
    const ac = new AbortController();
    const promise = p.chat([{ role: "user", content: "hi" } as never], undefined, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(new CancelError("stop")), 50);
    await expect(promise).rejects.toThrow("已取消");
    expect(fetchCalls).toBe(1);
    expect(seenSignal).not.toBeNull();
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
  } finally {
    (globalThis as Record<string, unknown>).fetch = origFetch;
  }
});

test("CancellationTest.test_fallback_provider_cancel_not_retried_or_switched", async () => {
  let calls = 0;
  const hanging: ProviderLike = {
    name: "hanging", model: "m-hanging", baseUrl: "https://example.invalid",
    hasCredentials: () => true,
    listModels: async () => [],
    redact: (t: string) => t,
    chat: async (_msgs: unknown[], _tools?: unknown, _timeout?: number, opts?: { signal?: AbortSignal }) => {
      calls += 1;
      const sig = opts?.signal;
      await new Promise<void>((resolve, reject) => {
        if (!sig) { setTimeout(resolve, 10000); return; }
        if (sig.aborted) { reject(cancelErrorFromSignal(sig, "stop")); return; }
        sig.addEventListener("abort", () => reject(cancelErrorFromSignal(sig, "stop")), { once: true });
      });
      return {};
    },
  };
  const fb = new FallbackProvider([hanging], null, { retryDelaysMs: [0, 0] });
  const ac = new AbortController();
  const promise = fb.chat([{ role: "user", content: "hi" } as never], undefined, undefined, { signal: ac.signal });
  setTimeout(() => ac.abort(new CancelError("stop")), 50);
  await expect(promise).rejects.toThrow("已取消");
  expect(calls).toBe(1);
});

function taskSpec(task: string): ParallelTaskSpec {
  return { task };
}

function outcome(summary: string): ParallelThreadOutcome {
  return { ok: true, summary, spentUsd: null, model: null, worktreePath: null, changedFiles: [], diffStat: null };
}

test("CancellationTest.test_parallel_timeout_uncooperative_runner_stays_stopping", async () => {
  const neverRunner = async (): Promise<ParallelThreadOutcome> => new Promise(() => {});
  const result = await runParallelDelegate(neverRunner, [taskSpec("永不结束")], { timeoutMs: 50, cancelGraceMs: 50 });
  expect(result.results[0].status).toBe("timeout");
  expect(result.results[0].stopConfirmed).toBe(false);
  expect(result.pendingAfterTimeout).toBe(1);
  expect(result.timedOut).toBe(1);
  const text = formatParallelResults(result);
  expect(text).toContain("宽限期内未确认停下、仍在停止中");
  expect(text).toContain("上值只是下限");
});

test("CancellationTest.test_parallel_timeout_cooperative_runner_confirmed_stopped", async () => {
  const coopRunner = async (_spec: ParallelTaskSpec, _index: number, signal?: AbortSignal): Promise<ParallelThreadOutcome> => {
    await new Promise<void>((resolve) => {
      if (!signal) { setTimeout(resolve, 10000); return; }
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return outcome("收到取消信号后收尾退出");
  };
  const result = await runParallelDelegate(coopRunner, [taskSpec("配合停下")], { timeoutMs: 50, cancelGraceMs: 500 });
  expect(result.results[0].status).toBe("timeout");
  expect(result.results[0].stopConfirmed).toBe(true);
  expect(result.pendingAfterTimeout).toBe(0);
  const text = formatParallelResults(result);
  expect(text).toContain("底层已确认停下");
  expect(text).toContain("无正在停止的线程");
});

test("CancellationTest.test_parallel_batch_cancel_queued_thread_never_starts", async () => {
  let runnerCalls = 0;
  const waitingRunner = async (_spec: ParallelTaskSpec, _index: number, signal?: AbortSignal): Promise<ParallelThreadOutcome> => {
    runnerCalls += 1;
    await new Promise<void>((resolve) => {
      if (!signal) { setTimeout(resolve, 10000); return; }
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return outcome("收到取消信号后收尾退出");
  };
  const ac = new AbortController();
  const promise = runParallelDelegate(waitingRunner, [taskSpec("先跑"), taskSpec("排队")], {
    maxConcurrency: 1, timeoutMs: 60000, cancelGraceMs: 500, signal: ac.signal,
  });
  setTimeout(() => ac.abort(new CancelError("stop")), 50);
  const result = await promise;
  expect(result.cancelled).toBe(2);
  expect(result.results[0].status).toBe("cancelled");
  expect(result.results[0].stopConfirmed).toBe(true);
  expect(result.results[1].status).toBe("cancelled");
  expect(result.results[1].error).toContain("未启动");
  expect(runnerCalls).toBe(1);
  const text = formatParallelResults(result);
  expect(text).toContain("被取消 2 个");
});

test("CancellationTest.test_shell_tool_abort_kills_child_process", async () => {
  if (process.platform === "win32") return;
  const workdir = tmp("nyra-cancel-shell-");
  const pidFile = join(workdir, "pid.txt");
  const ac = new AbortController();
  const ctx = newToolContext({ workdir, mode: "auto", interactive: true, approveFn: async () => true, cancelSignal: ac.signal });
  const promise = executeTool("shell", { command: `echo $$ > ${pidFile}; sleep 30`, timeout: 60 }, ctx);
  await new Promise((r) => setTimeout(r, 300));
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  expect(Number.isFinite(pid) && pid > 0).toBe(true);
  ac.abort(new CancelError("stop"));
  await expect(promise).rejects.toThrow("已取消");
  await new Promise((r) => setTimeout(r, 200));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

class HangingProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls = 0;
  constructor(private hangOnCall: number, private firstStep?: Record<string, unknown>) {}
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(_messages: unknown[], _tools?: unknown, _timeout?: number, opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (this.calls !== this.hangOnCall) {
      return (this.firstStep ?? {
        choices: [{ message: { content: "完成。", tool_calls: [] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }) as Record<string, unknown>;
    }
    const sig = opts?.signal;
    await new Promise<void>((resolve, reject) => {
      if (!sig) { setTimeout(resolve, 60000); return; }
      if (sig.aborted) { reject(cancelErrorFromSignal(sig, "stop")); return; }
      sig.addEventListener("abort", () => reject(cancelErrorFromSignal(sig, "stop")), { once: true });
    });
    throw new Error("unreachable");
  }
}

test("CancellationTest.test_agent_run_external_signal_aborts_model_call", async () => {
  const home = tmp("nyra-cancel-agent-");
  const workdir = tmp("nyra-cancel-agent-work-");
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent(new HangingProvider(1) as never, {
    workdir, home, mode: "full", skillsDirs: [],
    onEvent: (kind, data) => { events.push({ kind, data }); },
  });
  const ac = new AbortController();
  const promise = agent.run("测试取消", { signal: ac.signal });
  setTimeout(() => ac.abort(new CancelError("stop")), 100);
  const text = await promise;
  expect(text).toContain("已取消");
  expect(agent.lastCancelledReason).toBe("stop");
  const cancelled = events.find((e) => e.kind === "run_cancelled");
  expect(cancelled).toBeDefined();
  expect(cancelled?.data.reason).toBe("stop");
});

test("CancellationTest.test_agent_budget_cap_aborts_in_flight_call", async () => {
  const home = tmp("nyra-cancel-budget-");
  const workdir = tmp("nyra-cancel-budget-work-");
  writeFileSync(join(workdir, "hello.txt"), "hello\n");
  let monthSpent = 0.5;
  const firstStep = {
    choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent(new HangingProvider(2, firstStep) as never, {
    workdir, home, mode: "full", skillsDirs: [],
    pricing: { inputPer1M: 1, outputPer1M: 2 },
    monthlyCostLimitUsd: 1,
    monthlySpentBeforeUsd: () => ({ spentUsd: monthSpent, incomplete: false }),
    onEvent: (kind, data) => { events.push({ kind, data }); },
  });
  const promise = agent.run("先读文件再继续");
  setTimeout(() => { monthSpent = 100; }, 300);
  const text = await promise;
  expect(text).toContain("已取消");
  expect(text).toContain("成本上限已触顶");
  expect(agent.lastCancelledReason).toBe("budget");
  const cancelled = events.find((e) => e.kind === "run_cancelled");
  expect(cancelled).toBeDefined();
  expect(cancelled?.data.reason).toBe("budget");
  expect(cancelled?.data.source).toBe("budget-cap");
});

test("CancellationTest.test_agent_subagent_stop_request_aborts_run_and_marks_stopped", async () => {
  const home = tmp("nyra-cancel-stop-");
  const workdir = tmp("nyra-cancel-stop-work-");
  const runId = "run-stop-test-1";
  registerSubagentRun(home, { runId, agent: "nyra", workdir, mode: "auto" });
  const agent = new Agent(new HangingProvider(1) as never, {
    workdir, home, mode: "full", skillsDirs: [], subagentRunId: runId,
  });
  const promise = agent.run("测试停止请求");
  setTimeout(() => requestSubagentStop(home, runId, { by: "test" }), 100);
  const text = await promise;
  expect(text).toContain("已取消");
  expect(agent.lastCancelledReason).toBe("stop");
  expect(getSubagentRun(home, runId).status).toBe("stopped");
});
