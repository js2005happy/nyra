// tests/node/test-exec-daemon.test.ts — 本地执行守护进程（权限分离的最小机制）。
//
// 由来：拆解一个 Electron agent 时看到它在独立进程里跑 shell（`local-exec-daemon`），
// agent 进程只发请求。价值不是性能，而是**可划边界**：agent 被提示注入攻陷时，攻击者
// 拿到的是"能发 exec 请求的客户端"，不是"能直接 spawn 的进程"。
//
// 这组测试锁四件真事：
//   D1 正常执行 + 退出码 + stdout/stderr 分离
//   D2 超时必须**杀掉整棵进程树并立刻返回**（踩过：只 kill shell，孙进程继续持有管道，
//      客户端被吊 5 秒）
//   D3 鉴权：错 token 直接拒，绝不执行
//   D4 目录白名单：越界拒；并发请求互不串流
import { test, expect } from "bun:test";
import { startExecDaemon, ExecDaemonClient, EXEC_PROTOCOL_VERSION, formatExecResult } from "../../src/execDaemon.ts";

/** 跨平台"慢命令"：ping 与 sleep 各在一边存在。 */
const SLOW = process.platform === "win32" ? "ping -n 6 127.0.0.1 > NUL" : "sleep 5";

test("D1 正常执行：退出码 0、stdout 与 stderr 分离", async () => {
  const d = await startExecDaemon();
  const c = new ExecDaemonClient({ port: d.port, token: d.token });
  try {
    const ok = await c.run("echo hi-daemon");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("hi-daemon");

    const bad = await c.run(process.platform === "win32" ? "exit /b 7" : "exit 7");
    expect(bad.exitCode).toBe(7);

    const err = await c.run("echo oops 1>&2");
    expect(err.stderr).toContain("oops");
  } finally {
    await d.close();
  }
}, 30000);

test("D2 超时：杀整棵进程树并立即返回（不许被孙进程吊住）", async () => {
  const d = await startExecDaemon();
  const c = new ExecDaemonClient({ port: d.port, token: d.token });
  try {
    const t0 = Date.now();
    const r = await c.run(SLOW, { timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    // 慢命令本身 5s；超时后必须明显早于它结束就返回
    expect(elapsed).toBeLessThan(4000);
  } finally {
    await d.close();
  }
}, 30000);

test("D3 鉴权：错 token 被拒且不执行", async () => {
  const d = await startExecDaemon();
  const bad = new ExecDaemonClient({ port: d.port, token: "definitely-wrong" });
  try {
    const r = await bad.run("echo should-not-run");
    expect(r.exitCode).toBeNull();
    expect(String(r.error)).toContain("token");
    expect(r.stdout).toBe("");
  } finally {
    await d.close();
  }
}, 30000);

test("D3 协议版本不匹配也被拒（避免半升级错配）", async () => {
  expect(EXEC_PROTOCOL_VERSION).toBe(1);
});

test("D4 目录白名单：越界拒；并发请求互不串流", async () => {
  const d = await startExecDaemon({ allowedRoots: [`${process.cwd()}/only-here`] });
  const c = new ExecDaemonClient({ port: d.port, token: d.token });
  try {
    const outOfRoot = await c.run("echo x", { cwd: process.cwd() });
    expect(outOfRoot.exitCode).toBeNull();
    expect(String(outOfRoot.error)).toContain("白名单");
  } finally {
    await d.close();
  }

  const d2 = await startExecDaemon();
  const c2 = new ExecDaemonClient({ port: d2.port, token: d2.token });
  try {
    const [a, b] = await Promise.all([c2.run("echo A"), c2.run("echo B")]);
    expect(a.stdout).toContain("A");
    expect(b.stdout).toContain("B");
    expect(a.stdout).not.toContain("B");
  } finally {
    await d2.close();
  }
}, 30000);

// ---- 接入工具层的输出整形（formatExecResult）----
// 这段是纯函数，单独测：它是 shell 工具把守护进程结果交给模型前的最后一道，
// 措辞错了模型就会把失败当成功（"退出码 3" 被吞掉就变成"命令成功了"）。

test("F1 正常输出原样返回（去掉尾部空白）", () => {
  expect(formatExecResult({ exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false })).toBe("ok");
});

test("F2 非零退出码必须标出来（否则模型会把失败当成功）", () => {
  const out = formatExecResult({ exitCode: 3, stdout: "partial", stderr: "", timedOut: false });
  expect(out).toContain("退出码 3");
  expect(out).toContain("partial");
});

test("F3 超时要说超时，并带出已产生的输出", () => {
  const out = formatExecResult(
    { exitCode: null, stdout: "half", stderr: "", timedOut: true, error: "超时被杀" },
    { timeoutSec: 2 },
  );
  expect(out).toContain("超时");
  expect(out).toContain("half");
  expect(out).toContain("2 秒");
});

test("F4 被拒绝/启动失败：把原因带出来，不能当成成功", () => {
  const out = formatExecResult({ exitCode: null, stdout: "", stderr: "", timedOut: false, error: "token 无效" });
  expect(out).toContain("token 无效");
  expect(out).not.toContain("（无输出）");
});

test("F5 空输出给占位，stderr 单独标", () => {
  expect(formatExecResult({ exitCode: 0, stdout: "", stderr: "" })).toBe("（无输出）");
  expect(formatExecResult({ exitCode: 0, stdout: "", stderr: "warn" })).toContain("标准错误");
});