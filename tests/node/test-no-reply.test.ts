// tests/node/test-no-reply.test.ts — NO_REPLY 静默收敛：
// 任务收尾在末尾输出 NO_REPLY，即“无须打扰用户”：runOne 不写收件箱、
// 不回邮件，workerOnce 不推 Bot 通知；运行记录本身照常留。
// 用假 provider 跑真 workerOnce，不调模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTask, isNoReplyReply, listTasks, loadInbox, workerOnce,
} from "../../src/tasks.ts";
import { RunStore } from "../../src/runs.ts";
import { fakeProvider } from "./fake-provider.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-noreply-test-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

test("isNoReplyReply：只有末尾的 NO_REPLY 才算", () => {
  expect(isNoReplyReply("查完了，没事。\nNO_REPLY")).toBe(true);
  expect(isNoReplyReply("  NO_REPLY  \n")).toBe(true);
  expect(isNoReplyReply("NO_REPLY")).toBe(true);
  expect(isNoReplyReply("NO_REPLY\n还有事")).toBe(false);
  expect(isNoReplyReply("no_reply")).toBe(false);
  expect(isNoReplyReply("")).toBe(false);
  expect(isNoReplyReply(null)).toBe(false);
  expect(isNoReplyReply("NO_REPLYX")).toBe(false);
});

test("workerOnce：NO_REPLY 的任务不写收件箱、不推 Bot 通知；普通任务照常", async () => {
  const home = tempHome();
  try {
    const store = new RunStore(join(home, "tasks"));
    const workdir = tempHome();
    try {
      addTask("看一眼收件箱", { workdir, home, store });
      const pushed: Array<{ name: string; status: string; summary: string }> = [];
      const provider = fakeProvider([{ content: "看过了，没事。\nNO_REPLY" }]);
      const processed = await workerOnce({ store, provider, config: null, home, onTaskResult: (r) => { pushed.push(r); } });
      expect(processed).toHaveLength(1);
      expect(processed[0][1]).toContain("NO_REPLY");
      expect(loadInbox(home)).toEqual([]);
      expect(pushed).toEqual([]);
      // 普通任务：收件箱与通知都照常。
      addTask("再看一眼", { workdir, home, store });
      const provider2 = fakeProvider([{ content: "发现一件事要处理。" }]);
      await workerOnce({ store, provider: provider2, config: null, home, onTaskResult: (r) => { pushed.push(r); } });
      expect(loadInbox(home)).toHaveLength(1);
      expect(pushed).toHaveLength(1);
      expect(listTasks(store)).toHaveLength(2);
    } finally {
      cleanup(workdir);
    }
  } finally {
    cleanup(home);
  }
});
