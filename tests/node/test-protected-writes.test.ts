// tests/node/test-protected-writes.test.ts — 受保护写入路径守卫（PR #31 审阅意见 1）。
//
// 覆盖边界：
//   - 顶层 AGENTS.md / .git / .nyra / commands / skills 一律拒写（大小写不敏感）
//   - 子目录里的同名文件不拦（docs/AGENTS.md、src/skills/x.md）
//   - NYRA_ALLOW_PROTECTED_WRITES=1 显式放开
//   - 工作目录之外仍然拒写（原有行为不能被破坏）
//   - 文件工具与直接 shell 重定向受保护；cp/tee/脚本等替代 shell 写法另有安全回归
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedWritePath, workspaceWritePath } from "../../src/tools.ts";
import type { ToolContext } from "../../src/tools.ts";

let workdir: string;

function ctx(): ToolContext {
  return { workdir, mode: "auto", interactive: false } as unknown as ToolContext;
}

function envIs(name: string): string | undefined {
  return process.env[name];
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "nyra-protected-"));
});

afterEach(() => {
  delete process.env.NYRA_ALLOW_PROTECTED_WRITES;
  rmSync(workdir, { recursive: true, force: true });
});

test("isProtectedWritePath：顶层受保护路径一律命中", () => {
  for (const p of [
    ".git",
    ".git/config",
    ".git/refs/heads/main",
    ".nyra",
    ".nyra/state.json",
    "commands",
    "commands/deploy.md",
    "skills",
    "skills/debugging.md",
    "AGENTS.md",
    "CLAUDE.md",
    "nyra.json",
    ".nyra.json",
    "./AGENTS.md",
    "AGENTS.md".toUpperCase(),
  ]) {
    expect(isProtectedWritePath(p)).toBe(true);
  }
});

test("isProtectedWritePath：子目录同名文件不拦", () => {
  for (const p of [
    "docs/AGENTS.md",
    "src/skills/foo.md",
    "src/commands/x.ts",
    "src/.gitkeep",
    "README.md",
    "src/tools.ts",
    "packages/app/skills/index.ts",
  ]) {
    expect(isProtectedWritePath(p)).toBe(false);
  }
});

test("workspaceWritePath：受保护路径拒绝写入，且给出可操作提示", () => {
  for (const p of ["AGENTS.md", ".git/config", "commands/deploy.md", "skills/debugging.md", ".nyra/state.json"]) {
    expect(() => workspaceWritePath(ctx(), p)).toThrow(/拒绝写入受保护路径/);
    expect(() => workspaceWritePath(ctx(), p)).toThrow(/NYRA_ALLOW_PROTECTED_WRITES=1/);
  }
});

test("workspaceWritePath：普通路径正常放行", () => {
  expect(() => workspaceWritePath(ctx(), "src/app.ts")).not.toThrow();
  expect(() => workspaceWritePath(ctx(), "docs/AGENTS.md")).not.toThrow();
  expect(() => workspaceWritePath(ctx(), "src/skills/a.md")).not.toThrow();
});

test("NYRA_ALLOW_PROTECTED_WRITES=1 显式放开受保护路径", () => {
  process.env.NYRA_ALLOW_PROTECTED_WRITES = "1";
  expect(() => workspaceWritePath(ctx(), "AGENTS.md")).not.toThrow();
  expect(() => workspaceWritePath(ctx(), ".git/config")).not.toThrow();
});

test("放开的取值支持 1/true/yes（大小写不敏感），其他值不放行", () => {
  for (const v of ["1", "true", "YES"]) {
    process.env.NYRA_ALLOW_PROTECTED_WRITES = v;
    expect(() => workspaceWritePath(ctx(), "AGENTS.md")).not.toThrow();
  }
  for (const v of ["0", "false", "no", ""]) {
    process.env.NYRA_ALLOW_PROTECTED_WRITES = v;
    expect(() => workspaceWritePath(ctx(), "AGENTS.md")).toThrow(/拒绝写入受保护路径/);
  }
});

test("工作目录之外仍然拒写（原有护栏不被削弱）", () => {
  expect(() => workspaceWritePath(ctx(), "../outside.txt")).toThrow(/禁止写入工作目录之外的路径/);
  expect(() => workspaceWritePath(ctx(), "a/../../outside.txt")).toThrow(/禁止写入工作目录之外的路径/);
});

// Windows 风格工作目录 + 后端：与 workspaceShellCwd 同款误判（Node CI #113）。
// 后端分支曾用 !base.startsWith("/") 判定绝对路径，C:/... 一律被误拒。
function backendCtx(workdir: string): ToolContext {
  return { workdir, mode: "auto", interactive: false, backend: { name: "test" } } as unknown as ToolContext;
}

test("workspaceWritePath：Windows 风格 workdir + backend 不误拒", () => {
  const ctx = backendCtx("C:/Users/test/work");
  expect(workspaceWritePath(ctx, "src/app.ts")).toBe("C:/Users/test/work/src/app.ts");
  expect(workspaceWritePath(ctx, "docs/note.md")).toBe("C:/Users/test/work/docs/note.md");
});

test("workspaceWritePath：后端分支工作目录外绝对路径仍拒绝", () => {
  const ctx = backendCtx("C:/Users/test/work");
  expect(() => workspaceWritePath(ctx, "/etc/passwd")).toThrow(/禁止写入工作目录之外的路径/);
  expect(() => workspaceWritePath(ctx, "../outside.txt")).toThrow(/禁止写入工作目录之外的路径/);
});

test("环境变量未设置时，原有的 envIs 助手不受影响（防止误用全局状态）", () => {
  expect(envIs("NYRA_ALLOW_PROTECTED_WRITES")).toBeUndefined();
});
