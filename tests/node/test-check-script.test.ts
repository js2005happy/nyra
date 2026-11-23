// tests/node/test-check-script.test.ts — 缺口 25 触发器执行 + Kooyu 零 Token 值守：
// 本地脚本预检的门禁与三态判定。全部用 spawnFn 桩或 git --version 跑，
// 不碰真网络、不调模型。
import { test, expect } from "bun:test";
import {
  describeCheckScriptOutcome, runCheckScript, validateCheckScriptDef,
  type CheckScriptDef, type SpawnResult,
} from "../../src/checkScript.ts";

function def(command: string, extra?: Partial<CheckScriptDef>): CheckScriptDef {
  return validateCheckScriptDef({ name: "t", command, ...extra });
}

function stubSpawn(result: SpawnResult): (argv: string[], cwd: string, timeoutMs: number) => SpawnResult {
  return () => result;
}

test("门禁：删除/提权/联网/任意代码执行的程序一律拒绝", () => {
  for (const cmd of [
    "rm -rf /tmp/x",
    "sudo apt update",
    "curl https://example.com",
    "wget https://example.com",
    "ssh user@host",
    "bash -c \"echo hi\"",
    "python3 -c \"print(1)\"",
    "node script.js",
    "find / -name x",
    "git status; rm -rf x",
    "git status && curl https://example.com",
    "git status $(whoami)",
    "npx foo",
  ]) {
    expect(() => validateCheckScriptDef({ name: "t", command: cmd })).toThrow();
  }
});

test("门禁：简单命令过（并钉住批准前缀）", () => {
  expect(def("git status").approvedCommand).toBe("git status");
  expect(def("git --version").approvedCommand).toBe("git --version");
  expect(def("df -h /tmp").approvedCommand).toBe("df -h /tmp");
  expect(def("true").approvedCommand).toBe("true");
});

test("门禁：名字/模式/超时/命中动作校验", () => {
  expect(() => validateCheckScriptDef({ name: "", command: "true" })).toThrow();
  expect(() => validateCheckScriptDef({ name: "t", command: "true", mode: "nope" })).toThrow();
  expect(() => validateCheckScriptDef({ name: "t", command: "true", timeoutSec: 1 })).toThrow();
  expect(() => validateCheckScriptDef({ name: "t", command: "true", timeoutSec: 121 })).toThrow();
  expect(() => validateCheckScriptDef({ name: "t", command: "true", onHit: "nope" })).toThrow();
  expect(def("true", { timeoutSec: 5 }).timeoutSec).toBe(5);
});

test("判定 non-empty-stdout-is-hit：有输出命中，无输出安静，非 0 退出是失败", () => {
  const d = def("echo hi");
  const hit = runCheckScript(d, { spawnFn: stubSpawn({ status: 0, stdout: "hi\n", stderr: "" }) });
  expect(hit.outcome).toBe("hit");
  expect(hit.exitCode).toBe(0);
  const quiet = runCheckScript(d, { spawnFn: stubSpawn({ status: 0, stdout: "  \n", stderr: "" }) });
  expect(quiet.outcome).toBe("quiet");
  const failed = runCheckScript(d, { spawnFn: stubSpawn({ status: 2, stdout: "", stderr: "boom" }) });
  expect(failed.outcome).toBe("failed");
  expect(failed.reason).toContain("退出码 2");
});

test("判定 exit-zero-is-hit：0 命中、1 安静、其他码失败", () => {
  const d = def("true", { mode: "exit-zero-is-hit" });
  expect(runCheckScript(d, { spawnFn: stubSpawn({ status: 0, stdout: "", stderr: "" }) }).outcome).toBe("hit");
  expect(runCheckScript(d, { spawnFn: stubSpawn({ status: 1, stdout: "", stderr: "" }) }).outcome).toBe("quiet");
  const failed = runCheckScript(d, { spawnFn: stubSpawn({ status: 3, stdout: "", stderr: "" }) });
  expect(failed.outcome).toBe("failed");
  expect(failed.reason).toContain("退出码 3");
});

test("超时与启动失败都算 failed，不抛错", () => {
  const d = def("true");
  const timeout = runCheckScript(d, { spawnFn: stubSpawn({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT", message: "timed out" } }) });
  expect(timeout.outcome).toBe("failed");
  expect(timeout.reason).toContain("超时");
  const spawnErr = runCheckScript(d, { spawnFn: () => { throw new Error("spawn ENOENT"); } });
  expect(spawnErr.outcome).toBe("failed");
  expect(spawnErr.reason).toContain("启动失败");
});

test("运行时再验批准原文：命令被改过就拒绝", () => {
  const d = def("git status");
  const tampered: CheckScriptDef = { ...d, command: "git log" };
  const r = runCheckScript(tampered, { spawnFn: stubSpawn({ status: 0, stdout: "x", stderr: "" }) });
  expect(r.outcome).toBe("failed");
  expect(r.reason).toContain("原文不符");
});

test("输出截断到 4000 字", () => {
  const d = def("echo hi");
  const r = runCheckScript(d, { spawnFn: stubSpawn({ status: 0, stdout: "x".repeat(5000), stderr: "" }) });
  expect(r.outcome).toBe("hit");
  expect(r.stdout.length).toBe(4000);
});

test("真跑：git --version 有输出即命中（不碰网络）", () => {
  const d = def("git --version");
  const r = runCheckScript(d);
  expect(r.outcome).toBe("hit");
  expect(r.stdout).toContain("git version");
});

test("真跑：环境变量只给白名单，密钥类变量不进子进程", () => {
  if (process.platform === "win32") return;
  process.env.NYRA_CHECK_SCRIPT_TEST_SECRET = "do-not-leak-xyz";
  try {
    // env 本身在拒绝清单里（会泄环境变量），用 printenv 验白名单过滤。
    const d = def("printenv");
    const r = runCheckScript(d);
    expect(r.outcome).toBe("hit");
    expect(r.stdout).not.toContain("do-not-leak-xyz");
    expect(r.stdout).not.toContain("NYRA_CHECK_SCRIPT_TEST_SECRET");
  } finally {
    delete process.env.NYRA_CHECK_SCRIPT_TEST_SECRET;
  }
});

test("描述：一行说清命中/失败/安静", () => {
  const d = def("echo hi");
  expect(describeCheckScriptOutcome(d, { outcome: "hit", stdout: "hello\nworld\n", stderr: "", exitCode: 0, durationMs: 1 })).toBe("巡检脚本 t 命中：hello");
  expect(describeCheckScriptOutcome(d, { outcome: "failed", stdout: "", stderr: "", exitCode: 2, durationMs: 1, reason: "退出码 2" })).toContain("执行失败");
  expect(describeCheckScriptOutcome(d, { outcome: "quiet", stdout: "", stderr: "", exitCode: 0, durationMs: 1 })).toContain("安静");
});
