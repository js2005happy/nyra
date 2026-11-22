// tests/node/test-bot-runner-approval.test.ts — Bot 方向 Phase 2：聊天内审批接线 + 预算预检。
// 假适配器 + 假模型执行，不联网、不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRunner, type AgentRunResult } from "../../src/bot/index.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import type { ChannelAdapter, InboundMessage, OutgoingMessage } from "../../src/bot/types.ts";

class FakeAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = "FakeBot";
  sent: { chatId: string; threadId: string | null; text: string; id: string; buttons?: { text: string; callbackData: string }[][] }[] = [];
  edited: { chatId: string; messageId: string; text: string }[] = [];
  answered: { callbackId: string; text: string }[] = [];
  private nextId = 1;

  async getMe(): Promise<{ id: number; username: string | null }> {
    return { id: 1, username: "FakeBot" };
  }

  async pollOnce(): Promise<InboundMessage[]> {
    return [];
  }

  async sendText(msg: OutgoingMessage): Promise<string> {
    const id = String(this.nextId++);
    this.sent.push({ chatId: msg.chatId, threadId: msg.threadId, text: msg.text, id, buttons: msg.inlineKeyboard });
    return id;
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    this.edited.push({ chatId, messageId, text });
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    this.answered.push({ callbackId, text });
  }
}

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMsg(over: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "7",
    threadId: null,
    senderId: "7",
    senderRole: "member",
    isMentioned: false,
    messageId: "1",
    text: "你好",
    attachments: [],
    chatType: "private",
    timestamp: Date.now(),
    ...over,
  };
}

function makeRunner(home: string, config: Record<string, unknown> = {}) {
  const adapter = new FakeAdapter();
  const runner = new BotRunner({
    home, workdir: home, config, adapter,
    agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null }),
  });
  return { runner, adapter };
}

function readAudit(home: string): Record<string, unknown>[] {
  const path = join(home, "bot-audit.jsonl");
  try {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function seedApproval(runner: BotRunner) {
  const item = await runner.bridge.requestApproval({
    sessionKey: "telegram:7", chatId: "7", threadId: null, tool: "write_file",
    summary: "写文件 a.txt", argsHash: "abcdef123456", requestedBy: "1", requestedByRole: "owner",
  });
  return item;
}

test("/approve：管理员批准挂起项，回确认，提示消息被改成已批准", async () => {
  const home = tempHome("nyra-bot-rapp-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1", admins: ["2"] } });
    const item = await seedApproval(runner);
    await runner.handleMessage(makeMsg({ messageId: "10", senderId: "2", text: `/approve ${item.id}` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain(`已批准 ${item.id}`);
    expect(adapter.edited.some((e) => e.text.includes("已批准"))).toBe(true);
    expect(runner.bridge.pending(item.id)?.status).toBe("approved");
    expect(readAudit(home).map((r) => r.outcome)).toContain("approval:approved");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/approve：非管理员批了无效，挂起项还在", async () => {
  const home = tempHome("nyra-bot-rapp2-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1", admins: ["2"] } });
    const item = await seedApproval(runner);
    await runner.handleMessage(makeMsg({ messageId: "10", senderId: "99", text: `/approve ${item.id}` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("只有管理员");
    expect(runner.bridge.pending(item.id)?.status).toBe("pending");
    expect(readAudit(home).map((r) => r.outcome)).toContain("approval:denied-not-approver");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/reject：管理员拒绝挂起项；不存在的 id 回没找到", async () => {
  const home = tempHome("nyra-bot-rapp3-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1" } });
    const item = await seedApproval(runner);
    await runner.handleMessage(makeMsg({ messageId: "10", senderId: "1", text: `/reject ${item.id}` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain(`已拒绝 ${item.id}`);
    expect(runner.bridge.pending(item.id)?.status).toBe("rejected");
    await runner.handleMessage(makeMsg({ messageId: "11", senderId: "1", text: "/approve deadbeef" }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("没找到");
    await runner.handleMessage(makeMsg({ messageId: "12", senderId: "1", text: "/approve" }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("用法");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("按钮回调：点批准按钮放行并回 ack；/status 能看到挂起审批数", async () => {
  const home = tempHome("nyra-bot-rapp4-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1" } });
    const item = await seedApproval(runner);
    expect(runner.status().pendingApprovals).toBe(1);
    await runner.handleMessage(makeMsg({
      messageId: "20", senderId: "1", text: `/approve ${item.id}`,
      viaCallback: true, callbackId: "cb-1",
    }));
    expect(adapter.answered).toEqual([{ callbackId: "cb-1", text: "已批准" }]);
    expect(runner.status().pendingApprovals).toBe(0);
    await runner.handleMessage(makeMsg({ messageId: "21", senderId: "1", text: "/status" }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("挂起审批：0 条");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/help 按角色说话：guest 看到只读说明，owner 看到审批命令", async () => {
  const home = tempHome("nyra-bot-rapp5-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1" } });
    await runner.handleMessage(makeMsg({ messageId: "1", senderId: "99", text: "/help" }));
    expect(adapter.sent[0].text).toContain("普通用户（只读）");
    await runner.handleMessage(makeMsg({ messageId: "2", senderId: "1", text: "/help" }));
    expect(adapter.sent[1].text).toContain("机主（全权）");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("月度硬顶预检：本月已花 ≥ 上限时直接回绝，不调模型", async () => {
  const home = tempHome("nyra-bot-rapp6-");
  try {
    // 先往用量账本里记一笔本月已花 $0.05。
    const ledger = new UsageLedger(home);
    ledger.recordDelta(
      { calls: 1, prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      null, 0.05, null, "fake-1",
    );
    expect(ledger.monthTotal(monthKeyString()).spentUsd).toBeCloseTo(0.05);
    let calls = 0;
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home, workdir: home,
      config: { monthly_cost_limit_usd: 0.01 },
      adapter,
      agentRun: async (): Promise<AgentRunResult> => {
        calls++;
        return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
      },
    });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "hi" }));
    expect(calls).toBe(0);
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("本月预算已用完");
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("0.05");
    expect(readAudit(home).map((r) => r.outcome)).toContain("blocked:monthly-budget");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("当天预算：超了也不进模型（审批放行绕不过配额的前提：配额门在执行前）", async () => {
  const home = tempHome("nyra-bot-rapp7-");
  try {
    let calls = 0;
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home, workdir: home,
      config: { bot: { daily_token_budget_usd: 1 } },
      adapter,
      agentRun: async (): Promise<AgentRunResult> => {
        calls++;
        return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 5 };
      },
    });
    // 第一条花掉 $5（超预算），第二条直接被预算门拦住。
    await runner.handleMessage(makeMsg({ messageId: "1", text: "第一条" }));
    expect(calls).toBe(1);
    await runner.handleMessage(makeMsg({ messageId: "2", text: "第二条" }));
    expect(calls).toBe(1);
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("预算已用完");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/approve session：记一条会话授权，/grants 能看到，/revoke-grant 能撤销", async () => {
  const home = tempHome("nyra-bot-rapp7-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1", admins: ["2"] } });
    const item = await seedApproval(runner);
    await runner.handleMessage(makeMsg({ messageId: "30", senderId: "2", text: `/approve ${item.id} session` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain(`已批准 ${item.id}`);
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("不再问");
    const grant = runner.bridge.findGrant("write_file", "abcdef123456", "telegram:7");
    expect(grant).not.toBeNull();
    expect(grant?.scope).toBe("session");
    await runner.handleMessage(makeMsg({ messageId: "31", senderId: "2", text: "/grants" }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain(grant!.id);
    await runner.handleMessage(makeMsg({ messageId: "32", senderId: "2", text: `/revoke-grant ${grant!.id}` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("已撤销");
    expect(runner.bridge.findGrant("write_file", "abcdef123456", "telegram:7")).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/approve always：记持久授权落盘；/approve 档位写错回用法；非管理员看不到授权", async () => {
  const home = tempHome("nyra-bot-rapp8-");
  try {
    const { runner, adapter } = makeRunner(home, { bot: { owner: "1", admins: ["2"] } });
    const item = await seedApproval(runner);
    await runner.handleMessage(makeMsg({ messageId: "40", senderId: "1", text: `/approve ${item.id} always` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("以后都不再问");
    expect(existsSync(join(home, "bot-approval-grants.json"))).toBe(true);
    expect(runner.bridge.findGrant("write_file", "abcdef123456", "telegram:99")).not.toBeNull();
    const item2 = await seedApproval(runner);
    await runner.handleMessage(makeMsg({ messageId: "41", senderId: "1", text: `/approve ${item2.id} bogus` }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("用法");
    expect(runner.bridge.pending(item2.id)?.status).toBe("pending");
    await runner.handleMessage(makeMsg({ messageId: "42", senderId: "99", text: "/grants" }));
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("只有管理员");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
