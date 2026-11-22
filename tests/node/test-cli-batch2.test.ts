// tests/node/test-cli-batch2.test.ts — 第 2 批 CLI 冒烟：sfu / group / peer grant、
// proposal、branch、join、team lead、judge verdicts 命令在全新 home 上能跑完。
// 用子进程跑真 CLI（`bun src/cli.ts …`），不调模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(argv: string[], home: string, workdir: string): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv, "--workdir", workdir],
    env: {
      ...process.env,
      NYRA_HOME: home,
      NYRA_CONFIG: join(home, "config.json"),
      NYRA_LAZY_TOOLS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function fresh(): { home: string; workdir: string } {
  return {
    home: mkdtempSync(join(tmpdir(), "nyra-b2cli-home-")),
    workdir: mkdtempSync(join(tmpdir(), "nyra-b2cli-wd-")),
  };
}

test("CliBatch2.test_sfu_commands", async () => {
  const { home, workdir } = fresh();
  try {
    const created = await runCli(["sfu", "create", "room-1"], home, workdir);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("语音房已建");
    const rooms = await runCli(["sfu", "rooms"], home, workdir);
    expect(rooms.code).toBe(0);
    expect(rooms.stdout).toContain("room-1");
    const joined = await runCli(["sfu", "join", "room-1", "alice", "speaker"], home, workdir);
    expect(joined.code).toBe(0);
    const turn = await runCli(["sfu", "turn", "room-1", "alice"], home, workdir);
    expect(turn.code).toBe(0);
    expect(turn.stdout).toContain("TURN");
    const closed = await runCli(["sfu", "close", "room-1"], home, workdir);
    expect(closed.code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("CliBatch2.test_group_room_and_plan_commands", async () => {
  const { home, workdir } = fresh();
  try {
    const created = await runCli(["group", "room", "create", "room-1", "测试群", "--bot", "bot-a", "--bot", "bot-b"], home, workdir);
    expect(created.code).toBe(0);
    const listed = await runCli(["group", "room", "list"], home, workdir);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("room-1");
    const plan = await runCli([
      "group", "plan", "create", "room-1", "--title", "分工任务",
      "--step-title", "第一步", "--assignee", "bot-a", "--accept", "产出 a.txt",
    ], home, workdir);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("计划已建");
    const plans = await runCli(["group", "plan", "list", "room-1"], home, workdir);
    expect(plans.code).toBe(0);
    expect(plans.stdout).toContain("分工任务");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("CliBatch2.test_judge_verdicts_and_peer_lists_empty", async () => {
  const { home, workdir } = fresh();
  try {
    const verdicts = await runCli(["judge", "verdicts"], home, workdir);
    expect(verdicts.code).toBe(0);
    const grants = await runCli(["peer", "grant", "list"], home, workdir);
    expect(grants.code).toBe(0);
    const proposals = await runCli(["peer", "proposal", "list"], home, workdir);
    expect(proposals.code).toBe(0);
    const branches = await runCli(["peer", "branch", "list"], home, workdir);
    expect(branches.code).toBe(0);
    const joins = await runCli(["session", "join-list"], home, workdir);
    expect(joins.code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("CliBatch2.test_team_lead_without_team_fails_cleanly", async () => {
  const { home, workdir } = fresh();
  try {
    const res = await runCli(["team", "lead", "status", "no-such-team"], home, workdir);
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("找不到团队");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
