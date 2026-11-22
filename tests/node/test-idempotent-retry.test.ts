// tests/node/test-idempotent-retry.test.ts — 幂等重试（OpenMausBot C 项）。
// 覆盖：provider 瞬时错误重试后成功、重试次数上限、用量上限文本不重试、
// 写操作重试前先查状态、只读工具直接重试。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError, FallbackProvider, classifyHttpError, httpError,
  isTransientProviderError, jitteredDelayMs, providerRetryDelayMs,
  sleepMs, MAX_SAME_PROVIDER_RETRIES,
  type ProviderLike,
} from "../../src/providers.ts";
import { isCancelError } from "../../src/cancel.ts";
import {
  executeTool, executeToolIdempotent, verifyWriteApplied, READONLY_TOOLS,
  newToolContext, workspaceShellCwd,
} from "../../src/tools.ts";

function fakeProvider(name: string, chat: (msgs: unknown[]) => Promise<Record<string, unknown>>): ProviderLike {
  return {
    name, model: "m-" + name, baseUrl: "https://example.invalid",
    hasCredentials: () => true,
    chat: chat as ProviderLike["chat"],
    listModels: async () => [],
    redact: (t: string) => t,
  };
}

function okReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

test("IdempotentRetry.test_quota_text_beats_429_status", () => {
  expect(classifyHttpError(429, "You've hit your weekly limit")).toBe("quota");
  expect(classifyHttpError(429, "out of usage credits")).toBe("quota");
  expect(classifyHttpError(429, "用量上限，请稍后再试")).toBe("quota");
  expect(classifyHttpError(429, "slow down")).toBe("rate_limit");
  expect(classifyHttpError(402, "no balance")).toBe("quota");
  expect(httpError(429, "You've hit your weekly limit").kind).toBe("quota");
  expect(httpError(429, "slow down").kind).toBe("rate_limit");
});

test("IdempotentRetry.test_transient_classification_table", () => {
  // 可重试：429 / 过载 / 5xx / 连接重置 / 超时。
  expect(isTransientProviderError(new ProviderError("slow down", { kind: "rate_limit" }))).toBe(true);
  expect(isTransientProviderError(new ProviderError("boom", { kind: "server" }))).toBe(true);
  expect(isTransientProviderError(new ProviderError("timeout", { kind: "timeout" }))).toBe(true);
  expect(isTransientProviderError(new ProviderError("reset", { kind: "network" }))).toBe(true);
  // 绝不重试：用量上限（即使 kind 是 rate_limit）、认证、未知模型、
  // 无效请求、404、安全拦截、用户中断。
  expect(isTransientProviderError(new ProviderError("You've hit your weekly limit", { kind: "rate_limit", status: 429 }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("quota exceeded", { kind: "quota" }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("bad key", { kind: "auth" }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("model_not_found", { kind: "config" }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("unknown model", { kind: "client" }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("bad request", { kind: "client" }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("blocked by safety filter", { kind: "server" }))).toBe(false);
  expect(isTransientProviderError(new ProviderError("用户已取消", { kind: "timeout" }))).toBe(false);
  expect(isTransientProviderError(new Error("plain"))).toBe(false);
});

test("IdempotentRetry.test_backoff_jitter_within_25_percent", () => {
  expect(jitteredDelayMs(1000, () => 0)).toBe(750);
  expect(jitteredDelayMs(1000, () => 1)).toBe(1250);
  expect(jitteredDelayMs(1000, () => 0.5)).toBe(1000);
  expect(providerRetryDelayMs(0, () => 0.5)).toBe(1000);
  expect(providerRetryDelayMs(1, () => 0.5)).toBe(3000);
  expect(providerRetryDelayMs(9, () => 0.5)).toBe(3000);
});

test("IdempotentRetry.test_transient_error_retried_then_succeeds", async () => {
  let calls = 0;
  const flaky = fakeProvider("flaky", async () => {
    calls += 1;
    if (calls <= 2) throw new ProviderError("boom", { kind: "server" });
    return okReply("recovered");
  });
  const fb = new FallbackProvider([flaky], null, {
    retryDelaysMs: [0, 0],
    sleep: async () => {},
  });
  const out = await fb.chat([{ role: "user", content: "hi" }]);
  expect(((out.choices as Record<string, unknown>[])[0].message as Record<string, unknown>).content).toBe("recovered");
  expect(calls).toBe(3);
  expect(fb.switches.length).toBe(0);
  expect(fb.retries.length).toBe(2);
  expect(fb.retries[0].provider).toBe("flaky");
});

test("IdempotentRetry.test_retry_cap_is_two", async () => {
  let calls = 0;
  const alwaysDown = fakeProvider("down", async () => {
    calls += 1;
    throw new ProviderError("boom", { kind: "server" });
  });
  const fb = new FallbackProvider([alwaysDown], null, {
    retryDelaysMs: [0, 0],
    sleep: async () => {},
  });
  let caught: unknown = null;
  try { await fb.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ProviderError);
  expect(calls).toBe(1 + MAX_SAME_PROVIDER_RETRIES);
  expect(fb.retries.length).toBe(MAX_SAME_PROVIDER_RETRIES);
});

test("IdempotentRetry.test_quota_text_never_retried_but_still_switches", async () => {
  let primaryCalls = 0;
  const primary = fakeProvider("p1", async () => {
    primaryCalls += 1;
    throw new ProviderError("You've hit your weekly limit", { kind: "rate_limit", status: 429 });
  });
  const secondary = fakeProvider("p2", async () => okReply("from-p2"));
  const fb = new FallbackProvider([primary, secondary], null, {
    retryDelaysMs: [0, 0],
    sleep: async () => {},
  });
  const out = await fb.chat([{ role: "user", content: "hi" }]);
  expect(((out.choices as Record<string, unknown>[])[0].message as Record<string, unknown>).content).toBe("from-p2");
  // 用量上限不重试同一 provider（只调 1 次），但切换语义不动：仍切到 p2。
  expect(primaryCalls).toBe(1);
  expect(fb.retries.length).toBe(0);
  expect(fb.switches.length).toBe(1);
  expect(fb.switches[0].kind).toBe("rate_limit");
});

test("IdempotentRetry.test_auth_error_never_retried", async () => {
  let calls = 0;
  const bad = fakeProvider("bad", async () => {
    calls += 1;
    throw new ProviderError("bad key", { kind: "auth" });
  });
  const fb = new FallbackProvider([bad], null, {
    retryDelaysMs: [0, 0],
    sleep: async () => {},
  });
  let caught: unknown = null;
  try { await fb.chat([{ role: "user", content: "hi" }]); } catch (e) { caught = e; }
  expect((caught as ProviderError).kind).toBe("auth");
  expect(calls).toBe(1);
  expect(fb.retries.length).toBe(0);
});

test("IdempotentRetry.test_sleep_is_interruptible", async () => {
  const controller = new AbortController();
  controller.abort();
  let caught: unknown = null;
  try { await sleepMs(5000, controller.signal); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(Error);
  // 退避睡眠被中断时 FallbackProvider 不再重发：信号已 abort 就是取消，
  // 直接抛 CancelError（不是原错）；进来时已 abort 的信号连 provider
  // 都不再尝试（可靠性打磨第 1 项第一批的新口径，旧口径“抛原错”已作废）。
  let calls = 0;
  const flaky = fakeProvider("flaky", async () => {
    calls += 1;
    throw new ProviderError("boom", { kind: "server" });
  });
  const fb = new FallbackProvider([flaky], null, { retryDelaysMs: [1000] });
  const ac = new AbortController();
  ac.abort();
  let caught2: unknown = null;
  try { await fb.chat([{ role: "user", content: "hi" }], undefined, 60, { signal: ac.signal }); } catch (e) { caught2 = e; }
  expect(isCancelError(caught2)).toBe(true);
  expect(calls).toBe(0);
});

// ---- 工具侧 ----

function testCtx() {
  const workdir = mkdtempSync(join(tmpdir(), "nyra-retry-"));
  const ctx = newToolContext({
    workdir,
    mode: "full",
    interactive: false,
    memoryPath: join(workdir, "MEMORY.md"),
    skillsDir: join(workdir, "skills"),
  });
  return { workdir, ctx };
}

test("IdempotentRetry.test_readonly_tools_directly_retried", async () => {
  // 本地 HTTP 服务：第一次 500，之后 200。web_fetch 是只读工具，可直接重试。
  // 注意：Bun 的 `bun test` 会在同一个进程里并发跑多个测试文件，process.env
  // 是进程全局的——这个开关用完必须恢复，否则同进程里其他文件的 SSRF 拦截
  // 测试（test-net 的 test_assert_public_url_blocks_private、test-tools 的
  // test_web_fetch_and_http_post_block_private_urls）会被旁路掉，在 CI 上
  // 全平台失败（Node CI #49 的教训：本文件第 181 行曾经只设不恢复）。
  const savedAllowPrivate = process.env.NYRA_ALLOW_PRIVATE_URLS;
  process.env.NYRA_ALLOW_PRIVATE_URLS = "1";
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1;
      if (hits === 1) return new Response("nope", { status: 500 });
      return new Response("<html><body>hello retry</body></html>", { status: 200 });
    },
  });
  try {
    const { ctx } = testCtx();
    const result = await executeToolIdempotent(
      "web_fetch", { url: `http://127.0.0.1:${server.port}/x` }, ctx, { delaysMs: [0, 0] },
    );
    expect(result).toContain("hello retry");
    expect(hits).toBe(2);
  } finally {
    server.stop();
    if (savedAllowPrivate === undefined) delete process.env.NYRA_ALLOW_PRIVATE_URLS;
    else process.env.NYRA_ALLOW_PRIVATE_URLS = savedAllowPrivate;
  }
});

test("IdempotentRetry.test_readonly_retry_cap", async () => {
  const { ctx } = testCtx();
  let calls = 0;
  const result = await executeToolIdempotent("read_file", { path: "missing.txt" }, ctx, {
    delaysMs: [0, 0],
    executor: async () => {
      calls += 1;
      return "错误：文件不存在";
    },
  });
  expect(result).toContain("错误：");
  expect(calls).toBe(3);
});

test("IdempotentRetry.test_write_retry_checks_state_first", async () => {
  const { workdir, ctx } = testCtx();
  const args = { path: "a.txt", content: "already there" };
  // 模拟“写入已生效、但返回报错”的执行器：第一次调用就把文件写好再报失败。
  let calls = 0;
  const result = await executeToolIdempotent("write_file", args, ctx, {
    delaysMs: [0, 0],
    executor: async () => {
      calls += 1;
      writeFileSync(join(workdir, "a.txt"), "already there", "utf-8");
      return "错误：模拟写入后失败";
    },
  });
  expect(result).toContain("已生效");
  expect(result).toContain("未重复执行");
  // 重试前核查发现已生效：执行器只被调了 1 次，没有重复写。
  expect(calls).toBe(1);
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("already there");
});

test("IdempotentRetry.test_write_not_applied_is_retried", async () => {
  const { ctx } = testCtx();
  let calls = 0;
  const result = await executeToolIdempotent("write_file", { path: "a.txt", content: "x" }, ctx, {
    delaysMs: [0, 0],
    executor: async () => {
      calls += 1;
      return "错误：写入失败";
    },
  });
  expect(result).toContain("错误：");
  // 未生效 → 重试 2 次，共 3 次调用。
  expect(calls).toBe(3);
});

test("IdempotentRetry.test_unverifiable_write_is_not_retried", async () => {
  const { ctx } = testCtx();
  let calls = 0;
  const result = await executeToolIdempotent("apply_patch", { path: "a.txt", patch: "x" }, ctx, {
    delaysMs: [0, 0],
    executor: async () => {
      calls += 1;
      return "错误：补丁失败";
    },
  });
  expect(result).toContain("错误：");
  // apply_patch 无法通用核查：不盲目重试。
  expect(calls).toBe(1);
});

test("IdempotentRetry.test_retry_calls_carry_idempotent_retry_flag", async () => {
  const { ctx } = testCtx();
  const seen: (boolean | undefined)[] = [];
  const result = await executeToolIdempotent("read_file", { path: "missing.txt" }, ctx, {
    delaysMs: [0, 0],
    executor: async (_name, _args, c) => {
      seen.push(c.idempotentRetry);
      return "错误：文件不存在";
    },
  });
  expect(result).toContain("错误：");
  // 首次调用不带标记，两次重试带标记；结束后标记恢复，不泄漏到下次调用。
  expect(seen).toEqual([undefined, true, true]);
  expect(ctx.idempotentRetry).toBeUndefined();
});

test("IdempotentRetry.test_shell_cwd_backend_accepts_windows_workdir", () => {
  // 回归：Node CI #113——workspaceShellCwd 的后端分支曾用 startsWith("/")
  // 判定绝对路径，Windows 工作目录（C:/...）被误判为“工作目录之外”，带
  // 后端的 shell 调用在 Windows 上全部被拒。后端分支不做存在性检查，
  // Windows 风格路径在 Linux 上也能断言。
  const ctx = newToolContext({
    workdir: "C:/Users/test/work",
    mode: "full",
    interactive: false,
    memoryPath: "C:/Users/test/work/MEMORY.md",
    skillsDir: "C:/Users/test/work/skills",
    backend: { runCommand: () => "ok" },
  });
  expect(workspaceShellCwd(ctx, null)).toBe("C:/Users/test/work");
  expect(workspaceShellCwd(ctx, "sub")).toBe("C:/Users/test/work/sub");
  // 工作目录之外的绝对路径仍拒绝：重试只能跳过人工弹窗，不能绕过 containment。
  expect(() => workspaceShellCwd(ctx, "/etc")).toThrow("禁止在工作目录之外启动 shell");
});

test("IdempotentRetry.test_retry_skips_approval", async () => {
  const { workdir } = testCtx();
  let approvals = 0;
  const ctx = newToolContext({
    workdir,
    mode: "auto",
    interactive: true,
    memoryPath: join(workdir, "MEMORY.md"),
    skillsDir: join(workdir, "skills"),
    approveFn: async () => { approvals += 1; return true; },
    backend: { runCommand: () => "ok" },
  });
  const first = await executeTool("shell", { command: "echo hi" }, ctx);
  expect(first).toContain("ok");
  expect(approvals).toBe(1);
  // 幂等重试：同一已批操作不再弹审批。
  ctx.idempotentRetry = true;
  try {
    const retried = await executeTool("shell", { command: "echo hi" }, ctx);
    expect(retried).toContain("ok");
    expect(approvals).toBe(1);
  } finally {
    delete ctx.idempotentRetry;
  }
});

test("IdempotentRetry.test_retry_skips_hooks", async () => {
  const savedHooksEnv = process.env.NYRA_HOOKS;
  delete process.env.NYRA_HOOKS;
  const home = mkdtempSync(join(tmpdir(), "nyra-retry-hooks-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-retry-hooks-work-"));
  try {
    const preMarker = join(workdir, "pre.marker");
    const postMarker = join(workdir, "post.marker");
    for (const [event, marker] of [["PreToolUse", preMarker], ["PostToolUse", postMarker]] as const) {
      const dir = join(home, "hooks", `${event}.d`);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "mark.sh");
      writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\n`, "utf-8");
      chmodSync(path, 0o755);
    }
    const ctx = newToolContext({
      workdir, mode: "full", interactive: false, home,
      memoryPath: join(workdir, "MEMORY.md"),
      skillsDir: join(workdir, "skills"),
      backend: { runCommand: () => "ok" },
    });
    const first = await executeTool("shell", { command: "echo hi" }, ctx);
    expect(first).toContain("ok");
    expect(existsSync(preMarker)).toBe(true);
    expect(existsSync(postMarker)).toBe(true);
    // 幂等重试：钩子不重跑，标记删掉后仍不存在。
    rmSync(preMarker, { force: true });
    rmSync(postMarker, { force: true });
    ctx.idempotentRetry = true;
    const retried = await executeTool("shell", { command: "echo hi" }, ctx);
    expect(retried).toContain("ok");
    expect(existsSync(preMarker)).toBe(false);
    expect(existsSync(postMarker)).toBe(false);
  } finally {
    if (savedHooksEnv === undefined) delete process.env.NYRA_HOOKS;
    else process.env.NYRA_HOOKS = savedHooksEnv;
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("IdempotentRetry.test_verify_write_applied", async () => {
  const { workdir, ctx } = testCtx();
  expect(READONLY_TOOLS.has("read_file")).toBe(true);
  expect(READONLY_TOOLS.has("write_file")).toBe(false);
  expect(READONLY_TOOLS.has("browser_screenshot")).toBe(false);
  writeFileSync(join(workdir, "a.txt"), "hello", "utf-8");
  expect(await verifyWriteApplied("write_file", { path: "a.txt", content: "hello" }, ctx)).toBe(true);
  expect(await verifyWriteApplied("write_file", { path: "a.txt", content: "other" }, ctx)).toBe(false);
  expect(await verifyWriteApplied("write_file", { path: "nope.txt", content: "x" }, ctx)).toBe(false);
  expect(await verifyWriteApplied("edit_file", { path: "a.txt", old_text: "h", new_text: "hello" }, ctx)).toBe(true);
  expect(await verifyWriteApplied("edit_file", { path: "a.txt", old_text: "h", new_text: "bye" }, ctx)).toBe(false);
  writeFileSync(join(workdir, "plan.md"), "# 标题\n\n1. 第一步\n", "utf-8");
  expect(await verifyWriteApplied("plan", { title: "标题", steps: ["第一步"], path: "plan.md" }, ctx)).toBe(true);
  expect(await verifyWriteApplied("shell", { command: "echo hi" }, ctx)).toBeNull();
  expect(await verifyWriteApplied("http_post", { url: "https://example.invalid", body: "" }, ctx)).toBeNull();
});

test("IdempotentRetry.test_approval_refusal_never_retries", async () => {
  // 回归：审批拒绝曾被当成普通失败重试——重试时 ctx.idempotentRetry 置 true，
  // checkApproval 直接放行，拒绝过的写操作照样执行（Bot Phase 2 全链路测试先抓到）。
  // 拒绝（approveFn 说不 / 只读模式 / 权限规则 deny）一律不重试、只问一次。
  const home = mkdtempSync(join(tmpdir(), "nyra-retry-refuse-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-retry-refuse-wd-"));
  try {
    let asked = 0;
    const ctx = newToolContext({
      workdir, home, mode: "auto", interactive: true,
      memoryPath: join(workdir, "MEMORY.md"),
      skillsDir: join(workdir, "skills"),
      approveFn: async () => { asked += 1; return false; },
    });
    const result = await executeToolIdempotent("write_file", { path: "a.txt", content: "hi\n" }, ctx, { delaysMs: [0] });
    expect(result).toContain("拒绝");
    expect(existsSync(join(workdir, "a.txt"))).toBe(false);
    expect(asked).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("IdempotentRetry.test_readonly_refusal_never_retries", async () => {
  // 同上：readonly 拒绝也是审批拒绝，重试不能绕过只读模式。
  const home = mkdtempSync(join(tmpdir(), "nyra-retry-ro-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-retry-ro-wd-"));
  try {
    const ctx = newToolContext({
      workdir, home, mode: "readonly", interactive: false,
      memoryPath: join(workdir, "MEMORY.md"),
      skillsDir: join(workdir, "skills"),
    });
    const result = await executeToolIdempotent("write_file", { path: "a.txt", content: "hi\n" }, ctx, { delaysMs: [0] });
    expect(result).toContain("只读");
    expect(existsSync(join(workdir, "a.txt"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
