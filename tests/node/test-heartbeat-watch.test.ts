// tests/node/test-heartbeat-watch.test.ts — 缺口 25 触发器执行 + Kooyu 零 Token 值守：
// Heartbeat 的巡检脚本、指纹去重、唤醒入队。全部在临时 home 里跑，
// 脚本执行用 spawnFn 桩（真跑只用 git --version），不调模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCheckScript, addHeartbeatMonitor, handleHeartbeat, listCheckScripts,
  loadHeartbeatSeen, removeCheckScript, runHeartbeat, setHeartbeatWake,
} from "../../src/heartbeat.ts";
import { appendInbox, listTasks } from "../../src/tasks.ts";
import { RunStore } from "../../src/runs.ts";
import type { SpawnResult } from "../../src/checkScript.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-hb-watch-test-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function hitSpawn(stdout = "disk 92%\n"): (argv: string[], cwd: string, timeoutMs: number) => SpawnResult {
  return () => ({ status: 0, stdout, stderr: "" });
}

function quietSpawn(): (argv: string[], cwd: string, timeoutMs: number) => SpawnResult {
  return () => ({ status: 0, stdout: "", stderr: "" });
}

test("去重：同一异常只通知一次，第二次只记审计、不写收件箱", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: ["inbox_unread"] });
    appendInbox("seed-1", "done", "种子未读", home);
    const first = runHeartbeat(home, "nyra", { force: true });
    expect(first.quiet).toBe(false);
    expect(first.fresh).toBe(1);
    expect(first.deduped).toBe(0);
    const inboxAfterFirst = readFileSync(join(home, "inbox.jsonl"), "utf-8").split("\n").filter(Boolean);
    const second = runHeartbeat(home, "nyra", { force: true });
    expect(second.findings).toHaveLength(1);
    expect(second.fresh).toBe(0);
    expect(second.deduped).toBe(1);
    expect(second.quiet).toBe(true);
    const inboxAfterSecond = readFileSync(join(home, "inbox.jsonl"), "utf-8").split("\n").filter(Boolean);
    expect(inboxAfterSecond.length).toBe(inboxAfterFirst.length);
    expect(Object.keys(loadHeartbeatSeen(home).seen)).toHaveLength(1);
  } finally {
    cleanup(home);
  }
});

test("去重：摘要变了就是新异常，会再通知", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: ["inbox_unread"] });
    appendInbox("seed-1", "done", "一条未读", home);
    expect(runHeartbeat(home, "nyra", { force: true }).fresh).toBe(1);
    appendInbox("seed-2", "done", "第二条未读", home);
    const second = runHeartbeat(home, "nyra", { force: true });
    expect(second.fresh).toBe(1);
    expect(second.quiet).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("巡检脚本：命中算发现，安静不算；命中输出变了再通知", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: [] });
    addCheckScript(home, "nyra", { name: "磁盘", command: "df -h /tmp", mode: "non-empty-stdout-is-hit", onHit: "notify" });
    const hit = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn("disk 92%\n") });
    expect(hit.findings.some((f) => f.kind === "check_script")).toBe(true);
    expect(hit.fresh).toBe(1);
    const again = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn("disk 92%\n") });
    expect(again.deduped).toBe(1);
    expect(again.fresh).toBe(0);
    const changed = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn("disk 97%\n") });
    expect(changed.fresh).toBe(1);
    expect(changed.quiet).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("巡检脚本：安静的脚本不产生发现；执行失败算发现但不唤醒", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: [], wakeEnabled: true });
    addCheckScript(home, "nyra", { name: "安静", command: "true", mode: "non-empty-stdout-is-hit", onHit: "wake" });
    const quiet = runHeartbeat(home, "nyra", { force: true, spawnFn: quietSpawn() });
    expect(quiet.findings).toEqual([]);
    expect(quiet.quiet).toBe(true);
    expect(quiet.woken).toEqual([]);
    addCheckScript(home, "nyra", { name: "坏掉", command: "false", mode: "non-empty-stdout-is-hit", onHit: "wake" });
    const failed = runHeartbeat(home, "nyra", {
      force: true,
      spawnFn: () => ({ status: 2, stdout: "", stderr: "boom" }),
    });
    expect(failed.findings.some((f) => f.summary.includes("坏掉") && f.summary.includes("执行失败"))).toBe(true);
    expect(failed.woken).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("唤醒：wake 命中 + 开关开 → 只读任务入队；开关关着不唤醒；同一异常不重复唤醒", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: [], wakeEnabled: true });
    addCheckScript(home, "nyra", { name: "磁盘", command: "df -h /tmp", mode: "non-empty-stdout-is-hit", onHit: "wake" });
    const store = new RunStore(join(home, "tasks"));
    const first = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn() });
    expect(first.woken).toHaveLength(1);
    const tasks = listTasks(store).filter((t) => t.run_id === first.woken[0]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].mode).toBe("readonly");
    expect((tasks[0] as unknown as Record<string, unknown>).unattended).toBe(true);
    expect(tasks[0].task).toContain("NO_REPLY");
    const second = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn() });
    expect(second.woken).toEqual([]);
    expect(second.deduped).toBe(1);
    // 开关关掉后，输出变了的新异常也不唤醒（只通知）。
    setHeartbeatWake(home, "nyra", false);
    const third = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn("disk 99%\n") });
    expect(third.fresh).toBe(1);
    expect(third.woken).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("唤醒：onHit=notify 的命中只通知不唤醒", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: [], wakeEnabled: true });
    addCheckScript(home, "nyra", { name: "磁盘", command: "df -h /tmp", mode: "non-empty-stdout-is-hit", onHit: "notify" });
    const r = runHeartbeat(home, "nyra", { force: true, spawnFn: hitSpawn() });
    expect(r.fresh).toBe(1);
    expect(r.woken).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("无效脚本配置跳过，不破坏巡查", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: [] });
    // 绕开 addCheckScript 的校验，直接把危险命令写进账本。
    const p = join(home, "heartbeats.json");
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { monitors: Array<Record<string, unknown>> };
    raw.monitors[0].scripts = [{ name: "危险", command: "rm -rf /tmp/x", mode: "non-empty-stdout-is-hit", timeoutSec: 30, onHit: "notify", approvedCommand: "rm -rf /tmp/x" }];
    writeFileSync(p, JSON.stringify(raw));
    const r = runHeartbeat(home, "nyra", { force: true });
    expect(r.findings).toEqual([]);
    expect(r.quiet).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("CLI：check-script 加/列/跑/删，--yes 是硬门", () => {
  const home = tempHome();
  try {
    expect(handleHeartbeat(["add", "--agent", "nyra", "--checks", ""], home)).toBe(0);
    // 不加 --yes 拒绝。
    expect(handleHeartbeat(["check-script", "add", "--agent", "nyra", "--name", "磁盘", "--command", "df -h /tmp"], home)).toBe(2);
    expect(listCheckScripts(home, "nyra")).toEqual([]);
    // 危险命令即使加 --yes 也拒绝。
    expect(handleHeartbeat(["check-script", "add", "--agent", "nyra", "--name", "危险", "--command", "curl https://example.com", "--yes"], home)).toBe(1);
    expect(handleHeartbeat(["check-script", "add", "--agent", "nyra", "--name", "版本", "--command", "git --version", "--yes"], home)).toBe(0);
    expect(listCheckScripts(home, "nyra")).toHaveLength(1);
    expect(handleHeartbeat(["check-script", "list", "--agent", "nyra"], home)).toBe(0);
    expect(handleHeartbeat(["check-script", "run", "--agent", "nyra", "--name", "版本"], home)).toBe(0);
    expect(handleHeartbeat(["check-script", "run", "--agent", "nyra", "--name", "没有"], home)).toBe(1);
    expect(handleHeartbeat(["check-script", "remove", "--agent", "nyra", "--name", "版本"], home)).toBe(2);
    expect(handleHeartbeat(["check-script", "remove", "--agent", "nyra", "--name", "版本", "--yes"], home)).toBe(0);
    expect(listCheckScripts(home, "nyra")).toEqual([]);
    expect(removeCheckScript(home, "nyra", "没有")).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("CLI：wake 开关与 seen-clear", () => {
  const home = tempHome();
  try {
    addHeartbeatMonitor(home, { agent: "nyra", checks: ["inbox_unread"] });
    appendInbox("seed-1", "done", "一条未读", home);
    runHeartbeat(home, "nyra", { force: true });
    expect(Object.keys(loadHeartbeatSeen(home).seen)).toHaveLength(1);
    expect(handleHeartbeat(["wake", "--agent", "nyra", "--on"], home)).toBe(0);
    expect(handleHeartbeat(["wake", "--agent", "nyra"], home)).toBe(2);
    expect(handleHeartbeat(["wake", "--agent", "nyra", "--off"], home)).toBe(0);
    expect(handleHeartbeat(["seen-clear"], home)).toBe(2);
    expect(handleHeartbeat(["seen-clear", "--yes"], home)).toBe(0);
    expect(existsSync(join(home, "heartbeat-seen.json"))).toBe(false);
    // 清空后重复异常会再通知一次。
    const again = runHeartbeat(home, "nyra", { force: true });
    expect(again.fresh).toBe(1);
  } finally {
    cleanup(home);
  }
});
