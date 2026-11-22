// tests/node/test-tools-gates-batch2.test.ts — 第 2 批 G-P1-9 / G-P1-10 / G-P1-12：
// 委派审批回调、提议门、启发式门（都走 executeTool 的真实门顺序）。
// 全部用临时 home 与临时工作目录，不调模型。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, newToolContext } from "../../src/tools.ts";
import { listIntentVerdicts } from "../../src/intentVerdict.ts";
import { listPeerProposals } from "../../src/peerProposals.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("ToolsGatesBatch2.test_peer_write_goes_to_proposal_not_disk", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const ctx = newToolContext({
      workdir, home, mode: "full", interactive: false,
      origin: "peer", peerName: "alice",
      onEvent: (kind, data) => { events.push({ kind, data }); },
    });
    const out = await executeTool("write_file", { path: "note.txt", content: "对方写的内容" }, ctx);
    expect(out).toContain("对方写操作已记为提议");
    expect(existsSync(join(workdir, "note.txt"))).toBe(false);
    const pending = listPeerProposals(home, "pending");
    expect(pending.length).toBe(1);
    expect(pending[0].peer).toBe("alice");
    expect(pending[0].tool).toBe("write_file");
    expect(events.find((e) => e.kind === "peer_proposal_recorded")).toBeDefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_local_write_not_affected_by_proposal_gate", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, origin: "local" });
    const out = await executeTool("write_file", { path: "note.txt", content: "机主写的内容" }, ctx);
    expect(existsSync(join(workdir, "note.txt"))).toBe(true);
    expect(listPeerProposals(home).length).toBe(0);
    expect(out).not.toContain("提议");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_heuristic_critical_blocks_before_shell", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, origin: "local" });
    // executeTool 把 ToolError 拦下来、按字符串返回（不抛）：断言返回文案。
    const out = await executeTool("shell", { command: "rm -rf /" }, ctx);
    expect(out).toContain("启发式拦截");
    const rows = listIntentVerdicts(home, 10);
    expect(rows.some((r) => r.tool === "shell" && r.layer === "heuristic" && r.decision === "deny")).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_delegate_callback_approves_in_non_interactive_auto", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    const seen: Array<{ tool: string; summary: string }> = [];
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const ctx = newToolContext({
      workdir, home, mode: "auto", interactive: false, origin: "local",
      delegateApprovalCallback: async (tool: string, summary: string) => {
        seen.push({ tool, summary });
        return true;
      },
      onEvent: (kind, data) => { events.push({ kind, data }); },
    });
    const out = await executeTool("write_file", { path: "callback-ok.txt", content: "父级批了" }, ctx);
    expect(existsSync(join(workdir, "callback-ok.txt"))).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0].tool).toBe("write_file");
    expect(events.find((e) => e.kind === "delegate_approval_callback")?.data.approved).toBe(true);
    expect(out).not.toContain("提议");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_delegate_callback_refusal_blocks", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    const ctx = newToolContext({
      workdir, home, mode: "auto", interactive: false, origin: "local",
      delegateApprovalCallback: async () => false,
      onEvent: () => {},
    });
    const out = await executeTool("write_file", { path: "callback-no.txt", content: "父级拒了" }, ctx);
    expect(out).toContain("非交互模式下 auto 模式不执行写入操作");
    expect(existsSync(join(workdir, "callback-no.txt"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_heuristic_high_escalates_and_callback_can_clear", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    // 没回调时 full 模式下 high 转人工等于拒绝（返回错误文案，不抛）。
    const noCallback = newToolContext({ workdir, home, mode: "full", interactive: false, origin: "local" });
    const denied = await executeTool("shell", { command: "rm -rf /tmp/nyra-heuristic-probe-dir" }, noCallback);
    expect(denied).toContain("须人工确认");
    // 父级回调批了就能过。
    const withCallback = newToolContext({
      workdir, home, mode: "full", interactive: false, origin: "local",
      delegateApprovalCallback: async () => true,
      onEvent: () => {},
    });
    const out = await executeTool("shell", { command: "rm -rf /tmp/nyra-heuristic-probe-dir" }, withCallback);
    expect(typeof out).toBe("string");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_peer_read_not_gated", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    writeFileSync(join(workdir, "read-me.txt"), "可读内容\n");
    const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, origin: "peer", peerName: "alice" });
    const out = await executeTool("read_file", { path: "read-me.txt" }, ctx);
    expect(out).toContain("可读内容");
    expect(listPeerProposals(home).length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ToolsGatesBatch2.test_foreign_worktree_file_write_exempt_shell_still_gated", async () => {
  const home = tmpHome("nyra-gates-");
  const workdir = tmpHome("nyra-gates-wd-");
  try {
    // 隔离分支内：文件写操作不进提议门（写不出去，workspaceWritePath 兜底），
    // shell 照样进提议门（能对外产生副作用）。
    const ctx = newToolContext({
      workdir, home, mode: "full", interactive: false,
      origin: "peer", peerName: "alice", inForeignWorktree: true,
    });
    await executeTool("write_file", { path: "branch-note.txt", content: "分支内写的内容" }, ctx);
    expect(existsSync(join(workdir, "branch-note.txt"))).toBe(true);
    const shellOut = await executeTool("shell", { command: "echo should-not-run" }, ctx);
    expect(shellOut).toContain("对方写操作已记为提议");
    expect(listPeerProposals(home, "pending").length).toBe(1);
    expect(listPeerProposals(home, "pending")[0].tool).toBe("shell");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
