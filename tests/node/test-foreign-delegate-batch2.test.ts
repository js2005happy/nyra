// tests/node/test-foreign-delegate-batch2.test.ts — 第 2 批 G-P1-8 / G-P1-10：
// 外来 agent 委派强制走隔离分支（有改动留分支等合入，无改动直接丢弃）。
// 全部用临时 home 与临时 git 仓库，假 provider，不调模型。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { getForeignBranch, listForeignBranches } from "../../src/foreignBranch.ts";

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls: Record<string, unknown>[][] = [];
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

function toolReply(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-fdelegate-repo-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

test("ForeignDelegateBatch2.test_foreign_delegate_writes_only_in_branch", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-fdelegate-home-"));
  const workdir = makeRepo();
  try {
    const provider = new FakeProvider([
      toolReply("c1", "delegate", { task: "写个文件", foreign: true, max_turns: 3 }),
      toolReply("c2", "write_file", { path: "foreign-note.txt", content: "外来机器人写的\n" }),
      textReply("子任务做完了"),
      textReply("父级收尾"),
    ]);
    const parentEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const agent = new Agent(provider as never, {
      workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
      origin: "peer", peerName: "alice",
      onEvent: (kind, data) => { parentEvents.push({ kind, data }); },
    });
    const out = await agent.run("派个外来任务写文件");
    expect(out).toContain("父级收尾");
    const branches = listForeignBranches(home);
    expect(branches.length).toBe(1);
    const rec = branches[0];
    expect(rec.branch.startsWith("nyra/foreign/")).toBe(true);
    expect(rec.peer).toBe("alice");
    expect(rec.status).toBe("open");
    expect(rec.changed_files).toContain("foreign-note.txt");
    // 改动只在分支 worktree 里，主工作区没被写乱。
    expect(existsSync(join(rec.worktree, "foreign-note.txt"))).toBe(true);
    expect(existsSync(join(workdir, "foreign-note.txt"))).toBe(false);
    expect(readFileSync(join(rec.worktree, "foreign-note.txt"), "utf-8")).toContain("外来机器人写的");
    // 交回文本写合入/丢弃命令（不自动合入，等机主决定）：它在 delegate 的
    // tool_result 里，不在父级最终文本里。
    const delegateResult = parentEvents.find((e) => e.kind === "tool_result" && e.data.name === "delegate");
    const delegateText = String(delegateResult?.data.result ?? "");
    expect(delegateText).toContain(`nyra peer branch merge ${rec.task_id} --yes`);
    expect(delegateText).toContain(`nyra peer branch drop ${rec.task_id} --yes`);
    // 账本里能按任务查到这条分支。
    expect(getForeignBranch(home, rec.task_id)?.status).toBe("open");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ForeignDelegateBatch2.test_foreign_delegate_no_changes_drops_branch", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-fdelegate-home-"));
  const workdir = makeRepo();
  try {
    const provider = new FakeProvider([
      toolReply("c1", "delegate", { task: "只看一眼", foreign: true, max_turns: 3 }),
      textReply("看完了，没什么可改的"),
      textReply("父级收尾"),
    ]);
    const agent = new Agent(provider as never, {
      workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
      origin: "peer", peerName: "bob",
    });
    const out = await agent.run("派个外来任务只看一眼");
    expect(out).toContain("父级收尾");
    const branches = listForeignBranches(home);
    expect(branches.length).toBe(1);
    expect(branches[0].status).toBe("dropped");
    expect(existsSync(branches[0].worktree)).toBe(false);
    expect(existsSync(join(workdir, "README.md"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ForeignDelegateBatch2.test_foreign_delegate_refuses_non_git_workdir", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-fdelegate-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-fdelegate-plain-"));
  try {
    const provider = new FakeProvider([
      toolReply("c1", "delegate", { task: "写个文件", foreign: true, max_turns: 3 }),
      textReply("父级收尾"),
    ]);
    const parentEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const agent = new Agent(provider as never, {
      workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
      origin: "peer", peerName: "alice",
      onEvent: (kind, data) => { parentEvents.push({ kind, data }); },
    });
    const out = await agent.run("派个外来任务");
    expect(out).toContain("父级收尾");
    // 委派失败不进最终文本：父级只拿到 delegate 的 tool_result。
    const delegateResult = parentEvents.find((e) => e.kind === "tool_result" && e.data.name === "delegate");
    expect(String(delegateResult?.data.result ?? "")).toContain("不是 git 仓库");
    expect(String(delegateResult?.data.result ?? "")).toContain("不许直接在主工作区干活");
    expect(listForeignBranches(home).length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
