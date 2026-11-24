// tests/node/test-permission-hardening.test.ts — 对齐 Codex 的两项权限加固（2026-11 竞品对齐）。
//
// 1) 复合命令拆分：`Bash(git *)` 不能放行 `git status && rm -rf /`
//    —— 这是规则引擎的真实绕过（旧实现整串匹配，白名单规则可被夹带私货）
// 2) 读侧禁读清单 deny_read_globs（学 Codex requirements.toml）
//    —— 写侧有受保护路径，读侧原来什么都没有，.env / 私钥照样能被读进上下文
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRules, evaluate, splitCompound } from "../../src/permissionRules.ts";
import { workspaceReadPath, workspaceWritePath, resetDenyReadCache } from "../../src/tools.ts";
import type { ToolContext } from "../../src/tools.ts";

let home: string;
let workdir: string;

function ctx(): ToolContext {
  return { workdir, home, mode: "auto", interactive: false } as unknown as ToolContext;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyra-perm-home-"));
  workdir = mkdtempSync(join(tmpdir(), "nyra-perm-wd-"));
  resetDenyReadCache();
});

afterEach(() => {
  resetDenyReadCache();
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

// ---- 1) 复合命令 ----

test("复合命令：白名单规则不能夹带私货（旧实现的绕过）", () => {
  const rules = parseRules({ allow: ["Bash(git *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "git status && rm -rf /" })).toBeNull();
  expect(evaluate(rules, { tool: "Bash", target: "git status" })?.action).toBe("allow");
});

test("复合命令：每段都允许才允许", () => {
  const rules = parseRules({ allow: ["Bash(git *)", "Bash(ls *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "git status && ls -la" })?.action).toBe("allow");
});

test("复合命令：任一段 ask 就 ask，任一段 deny 就 deny", () => {
  const rules = parseRules({ allow: ["Bash"], ask: ["Bash(git push *)"], deny: ["Bash(rm *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "npm i && git push origin main" })?.action).toBe("ask");
  expect(evaluate(rules, { tool: "Bash", target: "npm i && rm -rf dist" })?.action).toBe("deny");
});

test("复合命令：分隔符全覆盖（&& || ; | 换行）", () => {
  expect(splitCompound("a && b").length).toBe(2);
  expect(splitCompound("a || b").length).toBe(2);
  expect(splitCompound("a ; b").length).toBe(2);
  expect(splitCompound("a | b").length).toBe(2);
  expect(splitCompound("a\nb").length).toBe(2);
});

test("复合命令：单段与非命令类工具不受影响", () => {
  const rules = parseRules({ allow: ["Bash(git *)"], deny: ["Bash(rm *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "git log" })?.action).toBe("allow");
  expect(evaluate(rules, { tool: "Edit", target: "src/a.ts" })).toBeNull();
});

// ---- 2) 读侧禁读清单 ----

test("deny_read_globs：命中即拒读，错误信息说明原因", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ deny_read_globs: ["**/.env", "secrets/**"] }), "utf-8");
  writeFileSync(join(workdir, ".env"), "OPENAI_KEY=sk-test", "utf-8");
  mkdirSync(join(workdir, "secrets"));
  writeFileSync(join(workdir, "secrets", "key.pem"), "-----BEGIN", "utf-8");
  mkdirSync(join(workdir, "src"));
  writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;", "utf-8");

  expect(() => workspaceReadPath(ctx(), ".env")).toThrow(/拒绝读取敏感路径/);
  expect(() => workspaceReadPath(ctx(), "secrets/key.pem")).toThrow(/deny_read_globs/);
  // 普通文件照常放行
  expect(() => workspaceReadPath(ctx(), "src/a.ts")).not.toThrow();
});

test("deny_read_globs：没配就用默认清单（.env 默认拒读）", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({}), "utf-8");
  writeFileSync(join(workdir, ".env"), "x=1", "utf-8");
  expect(() => workspaceReadPath(ctx(), ".env")).toThrow(/deny_read_globs/);
});

test("deny_read_globs：配置损坏时用默认清单，不把 agent 卡死", () => {
  writeFileSync(join(home, "config.json"), "{ 坏 json", "utf-8");
  writeFileSync(join(workdir, "a.txt"), "x", "utf-8");
  writeFileSync(join(workdir, ".env"), "x=1", "utf-8");
  expect(() => workspaceReadPath(ctx(), "a.txt")).not.toThrow();
  expect(() => workspaceReadPath(ctx(), ".env")).toThrow(/deny_read_globs/);
});

test("deny_read_globs：改配置后 resetDenyReadCache 生效", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ deny_read_globs: ["**/.env"] }), "utf-8");
  writeFileSync(join(workdir, ".env"), "x=1", "utf-8");
  expect(() => workspaceReadPath(ctx(), ".env")).toThrow();

  // 改成显式清空 → 清缓存后应放行（只有显式 [] 才是放宽，{} 仍用默认清单）
  writeFileSync(join(home, "config.json"), JSON.stringify({ deny_read_globs: [] }), "utf-8");
  resetDenyReadCache();
  expect(() => workspaceReadPath(ctx(), ".env")).not.toThrow();
});

// ---- 3) 软链规范化（CI #491：macOS /var 软链）----
//
// macOS 的 tmpdir 是 /var/folders/...（软链到 /private/var/folders/...）：
// workdir 与文件路径可能一个走软链、一个走真实路径，字符串前缀比较会把
// 目录内文件误判成越界。旧实现只做 resolve() 后的字符串比较，不解析软链。

test("workspaceReadPath：软链工作目录 + 真实路径可读（CI #491）", () => {
  const real = mkdtempSync(join(tmpdir(), "nyra-real-"));
  const link = join(tmpdir(), `nyra-link-${Date.now()}-${process.pid}`);
  symlinkSync(real, link);
  try {
    writeFileSync(join(real, "t.txt"), "hello");
    const ctxLink = { workdir: link, home, mode: "auto", interactive: false } as unknown as ToolContext;
    const ctxReal = { workdir: real, home, mode: "auto", interactive: false } as unknown as ToolContext;
    expect(() => workspaceReadPath(ctxLink, join(real, "t.txt"))).not.toThrow();
    expect(() => workspaceReadPath(ctxReal, join(link, "t.txt"))).not.toThrow();
    // 工作目录内不存在的文件仍放行（读侧报“文件不存在”，不是抛错）
    expect(() => workspaceReadPath(ctxLink, join(real, "no-such-file.txt"))).not.toThrow();
    expect(() => workspaceReadPath(ctxLink, join(link, "no-such-file.txt"))).not.toThrow();
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("workspaceReadPath：软链不能绕过越界拒绝（CI #491）", () => {
  const real = mkdtempSync(join(tmpdir(), "nyra-real-"));
  const outside = mkdtempSync(join(tmpdir(), "nyra-outside-"));
  const link = join(tmpdir(), `nyra-link-${Date.now()}-${process.pid}`);
  symlinkSync(real, link);
  try {
    writeFileSync(join(outside, "secret.txt"), "x");
    const ctxLink = { workdir: link, home, mode: "auto", interactive: false } as unknown as ToolContext;
    expect(() => workspaceReadPath(ctxLink, join(outside, "secret.txt"))).toThrow(/只能访问工作目录内/);
    // 目录内软链指向目录外：经软链读目录外文件同样拒绝
    symlinkSync(outside, join(real, "esc"));
    try {
      expect(() => workspaceReadPath(ctxLink, join(real, "esc", "secret.txt"))).toThrow(/只能访问工作目录内/);
    } finally {
      rmSync(join(real, "esc"), { force: true });
    }
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("workspaceWritePath：经软链逃出工作目录的写入被拒绝（CI #491）", () => {
  const real = mkdtempSync(join(tmpdir(), "nyra-real-"));
  const outside = mkdtempSync(join(tmpdir(), "nyra-outside-"));
  try {
    // 目录内软链指向目录外：旧实现只看字符串前缀，放行；修后应拒绝。
    // 注意写侧用相对路径（绝对路径会被 join 到工作目录下，见 test-extra-dirs）。
    symlinkSync(outside, join(real, "esc"));
    const ctxReal = { workdir: real, home, mode: "auto", interactive: false } as unknown as ToolContext;
    expect(() => workspaceWritePath(ctxReal, "esc/x.txt")).toThrow(/禁止写入工作目录之外/);
    // 目录内正常写入仍放行
    expect(() => workspaceWritePath(ctxReal, "plain.txt")).not.toThrow();
  } finally {
    rmSync(join(real, "esc"), { force: true });
    rmSync(real, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
