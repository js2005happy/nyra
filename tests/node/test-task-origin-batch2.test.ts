// tests/node/test-task-origin-batch2.test.ts — 第 2 批 G-P1-10 / G-P1-11：
// 任务来源账本（MCP 派发记 peer，本地任务记 local；来源只记 local/peer，不记人名）。
// 全部用临时 home，不调模型、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markTaskOrigin, readTaskOrigin } from "../../src/taskOrigin.ts";
import { addTask } from "../../src/tasks.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("TaskOriginBatch2.test_mark_and_read_roundtrip", () => {
  const home = tmpHome("nyra-origin-");
  try {
    expect(readTaskOrigin(home, "run-nope")).toBeNull();
    markTaskOrigin(home, "run-1", "peer");
    markTaskOrigin(home, "run-2", "local");
    expect(readTaskOrigin(home, "run-1")).toBe("peer");
    expect(readTaskOrigin(home, "run-2")).toBe("local");
    // 账本只记来源，不记 peer 名。
    const raw = readFileSync(join(home, "task-origins.json"), "utf-8");
    expect(raw).not.toContain("alice");
    expect(raw).toContain("peer");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("TaskOriginBatch2.test_add_task_records_peer_origin", async () => {
  const home = tmpHome("nyra-origin-");
  const workdir = tmpHome("nyra-origin-wd-");
  try {
    const state = await addTask("帮我看看 README", {
      home, workdir, mode: "readonly", maxTurns: 1,
      origin: "peer",
    });
    expect(readTaskOrigin(home, state.run_id)).toBe("peer");
    const localState = await addTask("本地任务", {
      home, workdir, mode: "readonly", maxTurns: 1,
    });
    expect(readTaskOrigin(home, localState.run_id)).toBe("local");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
