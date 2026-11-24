// 第四份审计 P1 的补洞：主分支已有审批全文、默认拒读和子进程白名单。
// 这里锁住仍漏掉的面：grep 读到 .env / 软链逃出工作区、手机审批截断、
// 桌面紧凑卡在允许按钮前不展示全文、MCP 启动确认只列变量名、Codex 只多带 CODEX_HOME。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, newToolContext, resetDenyReadCache, type ToolContext } from "../../src/tools.ts";
import { codexChildEnv } from "../../src/providers.ts";
import { mcpStartPrompt } from "../../src/mcp.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(home: string, workdir: string): ToolContext {
  return newToolContext({
    workdir, home, mode: "auto", interactive: true,
    memoryPath: join(workdir, "MEMORY.md"), skillsDir: join(workdir, "skills"),
    approveFn: async () => true,
  });
}

test("SecurityP1.grep_skips_dotenv_symlink_and_outside_dir", async () => {
  const home = tmp("nyra-p1-home-");
  const workdir = tmp("nyra-p1-wd-");
  writeFileSync(join(workdir, "visible.txt"), "NEEDLE-VISIBLE\n");
  writeFileSync(join(workdir, ".env"), "NEEDLE-SECRET-ENV\n");
  symlinkSync(join(workdir, ".env"), join(workdir, "alias.txt"));
  const outside = tmp("nyra-p1-out-");
  writeFileSync(join(outside, "leak.txt"), "NEEDLE-OUTSIDE\n");
  symlinkSync(outside, join(workdir, "escape"));
  resetDenyReadCache();
  const out = await executeTool("grep_search", { pattern: "NEEDLE", path: "." }, ctx(home, workdir));
  expect(out).toContain("NEEDLE-VISIBLE");
  expect(out).not.toContain("NEEDLE-SECRET-ENV");
  expect(out).not.toContain("NEEDLE-OUTSIDE");
});

test("SecurityP1.write_through_benign_symlink_updates_target_not_agents", async () => {
  const home = tmp("nyra-p1-home-");
  const workdir = tmp("nyra-p1-wd-");
  writeFileSync(join(workdir, "safe.txt"), "old\n");
  writeFileSync(join(workdir, "AGENTS.md"), "ORIGINAL\n");
  symlinkSync(join(workdir, "safe.txt"), join(workdir, "link.txt"));
  symlinkSync(join(workdir, "AGENTS.md"), join(workdir, "notes.md"));
  const seen: string[] = [];
  const c = newToolContext({
    workdir, home, mode: "auto", interactive: true,
    memoryPath: join(workdir, "MEMORY.md"), skillsDir: join(workdir, "skills"),
    approveFn: async (_tool, summary) => { seen.push(summary); return true; },
  });
  const ok = await executeTool("write_file", { path: "link.txt", content: "new\n" }, c);
  expect(seen.join("\n")).toContain("link.txt → safe.txt");
  expect(ok).toContain("已写入");
  expect(readFileSync(join(workdir, "safe.txt"), "utf-8")).toBe("new\n");
  const denied = await executeTool("write_file", { path: "notes.md", content: "PWNED\n" }, c);
  expect(denied).toContain("拒绝写入受保护路径");
  expect(readFileSync(join(workdir, "AGENTS.md"), "utf-8")).toBe("ORIGINAL\n");
});

test("SecurityP1.read_follows_only_after_recheck", async () => {
  const home = tmp("nyra-p1-home-");
  const workdir = tmp("nyra-p1-wd-");
  writeFileSync(join(workdir, "safe.txt"), "hello-safe\n");
  writeFileSync(join(workdir, ".env"), "SECRET=fixture\n");
  symlinkSync(join(workdir, "safe.txt"), join(workdir, "link.txt"));
  symlinkSync(join(workdir, ".env"), join(workdir, "alias.txt"));
  resetDenyReadCache();
  const c = ctx(home, workdir);
  expect(await executeTool("read_file", { path: "link.txt" }, c)).toContain("hello-safe");
  const denied = await executeTool("read_file", { path: "alias.txt" }, c);
  expect(denied).toContain("deny_read_globs");
  expect(denied).not.toContain("SECRET=fixture");
});

test("SecurityP1.mobile_approval_shows_full_summary", () => {
  const js = readFileSync(join(import.meta.dir, "../../src/assets/mobile-app.js.txt"), "utf-8");
  const start = js.indexOf("function scopeBox");
  const end = js.indexOf("function waitChip");
  const scope = js.slice(start, end);
  expect(scope).toContain("m.scope.detail");
  expect(scope).not.toContain("slice(0, 120)");
});

test("SecurityP1.desktop_compact_card_includes_full_scope", () => {
  const js = readFileSync(join(import.meta.dir, "../../src/assets/desktop-app.js.txt"), "utf-8");
  const start = js.indexOf("function approvalCard");
  const end = js.indexOf("async function decide");
  const card = js.slice(start, end);
  expect(card).toContain("appr-full");
  expect(card).toContain("scopeBox(info)");
  const review = js.slice(js.indexOf("function renderReview"));
  expect(review).toContain("scopeBox(pendInfo)");
});

test("SecurityP1.mcp_start_prompt_names_env_without_values", () => {
  const prompt = mcpStartPrompt("mail", ["BRAVE_API_KEY"], { GITHUB_TOKEN: "ghp-should-not-appear" });
  expect(prompt).toContain("BRAVE_API_KEY");
  expect(prompt).toContain("GITHUB_TOKEN");
  expect(prompt).not.toContain("ghp-should-not-appear");
  expect(mcpStartPrompt("plain", [], {})).toContain("默认白名单");
});

test("SecurityP1.codex_env_keeps_home_path_not_tokens", () => {
  const savedHome = process.env.CODEX_HOME;
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.CODEX_HOME = "/tmp/nyra-codex-home-fixture";
  process.env.GITHUB_TOKEN = "ghp-fake-codex";
  try {
    const env = codexChildEnv();
    expect(env.CODEX_HOME).toBe("/tmp/nyra-codex-home-fixture");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedToken;
  }
});
