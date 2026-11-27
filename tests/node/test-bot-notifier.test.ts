// tests/node/test-bot-notifier.test.ts — Bot 方向 Phase 3：主动推送。
// 假发送 + 假状态 + 假时钟，不联网、不用真实 token、不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotNotifier, type NotifierState } from "../../src/bot/notifier.ts";
import { DEFAULT_NOTIFIER_POLICY, type BotNotifierPolicy } from "../../src/bot/types.ts";

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseState(over: Partial<NotifierState> = {}): NotifierState {
  return {
    dailySpentUsd: 0,
    dailyBudgetUsd: null,
    pendingApprovals: 0,
    oldestPendingApprovalMs: null,
    queueDepth: 0,
    ...over,
  };
}

function makeNotifier(
  home: string,
  policyOver: Partial<BotNotifierPolicy> = {},
  opts: { owner?: string | null; state?: () => NotifierState | null; now?: () => number } = {},
) {
  const sent: { chatId: string; text: string }[] = [];
  const audited: string[] = [];
  let nowMs = 1_000_000;
  const policy: BotNotifierPolicy = { ...DEFAULT_NOTIFIER_POLICY, enabled: true, targetChatId: "123", ...policyOver };
  const notifier = new BotNotifier({
    home,
    policy,
    owner: opts.owner === undefined ? "123" : opts.owner,
    send: async (chatId, _threadId, text) => {
      sent.push({ chatId, text });
      return "1";
    },
    audit: (outcome) => { audited.push(outcome); },
    state: opts.state,
    now: opts.now ?? (() => nowMs),
  });
  return { notifier, sent, audited, advance: (ms: number) => { nowMs += ms; } };
}

test("默认关闭：enabled=false 时 tick 与任务推送都不推", async () => {
  const home = tempHome("nyra-bot-ntf1-");
  try {
    const { notifier, sent } = makeNotifier(home, { enabled: false }, { state: () => baseState({ queueDepth: 99 }) });
    expect(await notifier.tick()).toEqual([]);
    expect(await notifier.notifyTaskResult({ name: "t", status: "error", summary: "boom" })).toBe(false);
    expect(sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("没配 owner 或没配目标会话时不开", async () => {
  const home = tempHome("nyra-bot-ntf2-");
  try {
    const a = makeNotifier(home, {}, { owner: null, state: () => baseState({ queueDepth: 99 }) });
    expect(await a.notifier.tick()).toEqual([]);
    expect(a.sent.length).toBe(0);
    const b = makeNotifier(home, { targetChatId: null }, { state: () => baseState({ queueDepth: 99 }) });
    expect(await b.notifier.tick()).toEqual([]);
    expect(b.sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("任务结果：failures 只推失败，all 成功也推，none 都不推", async () => {
  const home = tempHome("nyra-bot-ntf3-");
  try {
    const f = makeNotifier(home, { notifyTasks: "failures" });
    expect(await f.notifier.notifyTaskResult({ name: "ok-task", status: "ok", summary: "done" })).toBe(false);
    expect(await f.notifier.notifyTaskResult({ name: "bad-task", status: "error", summary: "boom" })).toBe(true);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0].text).toContain("bad-task");
    expect(f.sent[0].text).toContain("失败");
    const a = makeNotifier(home, { notifyTasks: "all" });
    expect(await a.notifier.notifyTaskResult({ name: "ok-task", status: "ok", summary: "done" })).toBe(true);
    expect(a.sent[0].text).toContain("已完成");
    const n = makeNotifier(home, { notifyTasks: "none" });
    expect(await n.notifier.notifyTaskResult({ name: "bad-task", status: "error", summary: "boom" })).toBe(false);
    expect(n.sent.length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Heartbeat 不再有月度提醒：本月花再多也不推月度上限提醒", async () => {
  // 月度上限已移除：NotifierState 里没有月度上限字段，tick 不再因本月
  // 花费推任何提醒；每日预算提醒仍在（见下一则测试）。
  const home = tempHome("nyra-bot-ntf4-");
  try {
    const { notifier, sent } = makeNotifier(home, {}, {
      state: () => baseState({ dailySpentUsd: 0, dailyBudgetUsd: null, queueDepth: 0, pendingApprovals: 0 }),
    });
    expect(await notifier.tick()).toEqual([]);
    expect(sent.length).toBe(0);
    const state = baseState({});
    expect("monthlySpentUsd" in state).toBe(false);
    expect("monthlyLimitUsd" in state).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Heartbeat：当天预算用完、队列积压、审批没人批都推，没异常不推", async () => {
  const home = tempHome("nyra-bot-ntf5-");
  try {
    const clean = makeNotifier(home, {}, { state: () => baseState() });
    expect(await clean.notifier.tick()).toEqual([]);
    const budget = makeNotifier(home, {}, { state: () => baseState({ dailySpentUsd: 5, dailyBudgetUsd: 5 }) });
    const b = await budget.notifier.tick();
    expect(b.length).toBe(1);
    expect(b[0]).toContain("今天的 token 预算已用完");
    const queue = makeNotifier(home, {}, { state: () => baseState({ queueDepth: 6 }) });
    const q = await queue.notifier.tick();
    expect(q.length).toBe(1);
    expect(q[0]).toContain("队列积压");
    const pending = makeNotifier(home, {}, {
      state: () => baseState({ pendingApprovals: 2, oldestPendingApprovalMs: 11 * 60000 }),
    });
    const p = await pending.notifier.tick();
    expect(p.length).toBe(1);
    expect(p[0]).toContain("2 条审批");
    const fresh = makeNotifier(home, {}, {
      state: () => baseState({ pendingApprovals: 1, oldestPendingApprovalMs: 5 * 60000 }),
    });
    expect(await fresh.notifier.tick()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Watch：首次只记基线不推，改了推一次，不变不推，再改再推", async () => {
  const home = tempHome("nyra-bot-ntf6-");
  try {
    const dir = mkdtempSync(join(tmpdir(), "nyra-bot-watch-"));
    try {
      const file = join(dir, "status.txt");
      writeFileSync(file, "v1\n");
      const { notifier, sent } = makeNotifier(home, {
        watches: [{ id: "w1", label: "状态文件", file }],
      });
      expect(await notifier.tick()).toEqual([]);
      expect(sent.length).toBe(0);
      writeFileSync(file, "v2\n");
      const pushed = await notifier.tick();
      expect(pushed.length).toBe(1);
      expect(pushed[0]).toContain("状态文件");
      expect(pushed[0]).toContain("发生了变化");
      expect(sent.length).toBe(1);
      expect(await notifier.tick()).toEqual([]);
      writeFileSync(file, "v3\n");
      expect((await notifier.tick()).length).toBe(1);
      expect(sent.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Watch 状态落盘：新实例读到基线，改文件后照样推", async () => {
  const home = tempHome("nyra-bot-ntf7-");
  try {
    const dir = mkdtempSync(join(tmpdir(), "nyra-bot-watch2-"));
    try {
      const file = join(dir, "status.txt");
      writeFileSync(file, "v1\n");
      const watches = [{ id: "w1", label: "状态文件", file }];
      const first = makeNotifier(home, { watches });
      expect(await first.notifier.tick()).toEqual([]);
      const second = makeNotifier(home, { watches });
      writeFileSync(file, "v2\n");
      const pushed = await second.notifier.tick();
      expect(pushed.length).toBe(1);
      // 状态文件确实落盘了。
      const stateRaw = readFileSync(join(home, "bot-notify-state.json"), "utf-8");
      expect(stateRaw).toContain("w1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("发送失败返回 false，不抛错", async () => {
  const home = tempHome("nyra-bot-ntf8-");
  try {
    const notifier = new BotNotifier({
      home,
      policy: { ...DEFAULT_NOTIFIER_POLICY, enabled: true, targetChatId: "123" },
      owner: "123",
      send: async () => { throw new Error("network down"); },
    });
    expect(await notifier.notifyTaskResult({ name: "t", status: "error", summary: "boom" })).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("没传 state 时 tick 只跑 watch，不崩", async () => {
  const home = tempHome("nyra-bot-ntf9-");
  try {
    const dir = mkdtempSync(join(tmpdir(), "nyra-bot-watch3-"));
    try {
      const file = join(dir, "status.txt");
      writeFileSync(file, "v1\n");
      const { notifier, sent } = makeNotifier(home, { watches: [{ id: "w1", label: "状态文件", file }] });
      expect(await notifier.tick()).toEqual([]);
      writeFileSync(file, "v2\n");
      expect((await notifier.tick()).length).toBe(1);
      expect(sent.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
