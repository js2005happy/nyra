// tests/node/test-sandbox-escape.test.ts — 隔离补强批：真实 bwrap 逃逸场景测试。
// 只在 Linux 且本机有 bwrap 时跑（detectBwrap()）；其他平台或无 bwrap 时跳过，
// 不阻塞 macOS/Windows CI。与 test-sandbox.test.ts 的假 shim 不同，这里验的是
// 真内核隔离：出工作区写、symlink 逃逸、断网联网都必须被挡住。
import { test, expect } from "bun:test";
import { mkdtempSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { detectBwrap, runSandboxed } from "../../src/sandbox.ts";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 有真 bwrap 才跑，否则跳过（本文件所有测试共用）。 */
function needBwrap(): boolean {
  if (process.platform !== "linux" || !detectBwrap()) {
    console.log("跳过：逃逸测试需要 Linux + 真实 bwrap");
    return false;
  }
  return true;
}

function hasCurl(): boolean {
  try {
    execFileSync("which", ["curl"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("escape：工作区内写成功（沙箱本身能跑的对照）", async () => {
  if (!needBwrap()) return;
  const wd = tmpDir("nyra-escape-wd-");
  const r = await runSandboxed("echo hello-escape > hello.txt", {
    workdir: wd, allowNet: false, mode: "workspace-write", timeout: 30,
  });
  expect(r.code).toBe(0);
  expect(readFileSync(join(wd, "hello.txt"), "utf-8")).toContain("hello-escape");
});

test("escape：出工作区写 /etc 失败，宿主机上无文件", async () => {
  if (!needBwrap()) return;
  const wd = tmpDir("nyra-escape-wd-");
  const target = `/etc/nyra-escape-${Date.now()}`;
  const r = await runSandboxed(`echo hi > ${target}`, {
    workdir: wd, allowNet: false, mode: "workspace-write", timeout: 30,
  });
  expect(r.code).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("escape：经工作区内 symlink 写 /etc 失败，宿主机上无文件", async () => {
  if (!needBwrap()) return;
  const wd = tmpDir("nyra-escape-wd-");
  symlinkSync("/etc", join(wd, "link"));
  const name = `nyra-escape-link-${Date.now()}`;
  const target = `/etc/${name}`;
  const r = await runSandboxed(`echo hi > link/${name}`, {
    workdir: wd, allowNet: false, mode: "workspace-write", timeout: 30,
  });
  expect(r.code).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("escape：读 /etc/passwd 成功（系统目录只读挂载，不是全封闭）", async () => {
  if (!needBwrap()) return;
  const wd = tmpDir("nyra-escape-wd-");
  const r = await runSandboxed("cat /etc/passwd", {
    workdir: wd, allowNet: false, mode: "workspace-write", timeout: 30,
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("root:");
});

test("escape：断网时 curl 外网失败", async () => {
  if (!needBwrap()) return;
  if (!hasCurl()) { console.log("跳过：本机无 curl"); return; }
  const wd = tmpDir("nyra-escape-wd-");
  const r = await runSandboxed("curl -m 5 -s http://example.com", {
    workdir: wd, allowNet: false, mode: "workspace-write", timeout: 30,
  });
  expect(r.code).not.toBe(0);
});

test("escape：read-only 模式工作区内写失败", async () => {
  if (!needBwrap()) return;
  const wd = tmpDir("nyra-escape-wd-");
  const r = await runSandboxed("echo hi > hello.txt", {
    workdir: wd, allowNet: false, mode: "read-only", timeout: 30,
  });
  expect(r.code).not.toBe(0);
  expect(existsSync(join(wd, "hello.txt"))).toBe(false);
});
