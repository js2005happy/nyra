// tests/node/test-memory-proposals.test.ts — 对话里自动提炼记忆（G-P1-34）。
// 确定性规则抽取（不调模型）、待确认队列、进库前人工确认 + 记忆证据门、
// 拒绝留痕、CLI 全程。只在临时 home 上跑，不碰真记忆。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  extractCandidates, extractMemoryProposals, listMemoryProposals, getMemoryProposal,
  approveMemoryProposal, rejectMemoryProposal, readMemoryProposals,
  MEMORY_PROPOSALS_FILE, MEMORY_PROPOSAL_CONTENT_MAX_CHARS,
} from "../../src/memoryProposals.ts";
import { listGateRejections } from "../../src/memoryGate.ts";
import { saveSession } from "../../src/memory.ts";
import { RunStore } from "../../src/runs.ts";
import { handleMemoryProposals } from "../../src/memoryProposalCli.ts";
import { Agent } from "../../src/agent.ts";

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

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function captureOutput(): { out: string; err: string; restore: () => void } {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  return { get out() { return out; }, get err() { return err; }, restore: () => { (process.stdout as unknown as { write: unknown }).write = origOut; (process.stderr as unknown as { write: unknown }).write = origErr; } };
}

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

// ---- 纯函数抽取 -----------------------------------------------------------

test("抽取：显式记住 + 身份与偏好 + 长期指令才提，闲聊与任务要求不提", () => {
  const drafts = extractCandidates([
    user("请记住，我是铜陵职业技术学院工业机器人技术专业的学生。"),
    assistant("好的，记下了。"),
    user("我喜欢用工业机器人调试做例子，以后讲课都用这个。"),
    user("今天天气不错，帮我查一下明天的课表。"),
    user("我的指导老师是梅小龙。"),
    user("以后回复都用中文，不要用英文。"),
    user("我的意思是先把这个放一放。"),
  ]);
  const contents = drafts.map((d) => d.content);
  expect(contents.some((c) => c.includes("我是铜陵职业技术学院"))).toBe(true);
  expect(contents.some((c) => c.includes("我喜欢用工业机器人调试"))).toBe(true);
  expect(contents.some((c) => c.includes("我的指导老师是梅小龙"))).toBe(true);
  expect(contents.some((c) => c.includes("以后回复都用中文"))).toBe(true);
  expect(contents.some((c) => c.includes("天气不错"))).toBe(false);
  expect(contents.some((c) => c.includes("课表"))).toBe(false);
  expect(contents.some((c) => c.includes("我的意思是"))).toBe(false);
  // 显式“记住”且含“我”的是 about_you，长期指令是 how_to。
  const identity = drafts.find((d) => d.content.includes("我是铜陵职业技术学院"));
  expect(identity?.category).toBe("about_you");
  const standing = drafts.find((d) => d.content.includes("以后回复都用中文"));
  expect(standing?.category).toBe("how_to");
  // 依据是逐字原话：引用句就是用户原句本身。
  for (const d of drafts) {
    expect(d.evidenceQuotes).toHaveLength(1);
    expect(d.evidenceSource).toContain(d.evidenceQuotes[0]);
  }
});

test("抽取：助手回合不提、空记住不提、一次最多 5 条、单条最多 300 字", () => {
  const drafts = extractCandidates([
    assistant("记住，我是你的助手。"),
    user("记住。"),
    user("我是学生。我叫姜晟。我喜欢机器人。我不喜欢熬夜。我的生日是 1 月 1 日。以后都用中文。"),
    user("我喜欢" + "很".repeat(400) + "长的句子。"),
  ]);
  expect(drafts.length).toBe(5);
  expect(drafts.every((d) => d.content.length <= MEMORY_PROPOSAL_CONTENT_MAX_CHARS + 1)).toBe(true);
  expect(drafts.some((d) => d.content.includes("我是你的助手"))).toBe(false);
});

test("抽取：工作类表述进 work 分类", () => {
  const drafts = extractCandidates([
    user("以后每周一都要把项目进度发给客户。"),
  ]);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].category).toBe("work");
});

// ---- 账本与去重 -----------------------------------------------------------

test("账本：提炼进队列、0600 权限、重复提炼不重复进、已进库的不再提", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    const msgs = [user("请记住，我喜欢用工业机器人调试做例子。")];
    const r1 = extractMemoryProposals(home, "sess-1", msgs);
    expect(r1.added).toBe(1);
    expectPerms(join(home, MEMORY_PROPOSALS_FILE), 0o600);
    const r2 = extractMemoryProposals(home, "sess-1", msgs);
    expect(r2.added).toBe(0);
    expect(r2.skipped).toBe(1);
    // 确认进库后，再提同一句也不再进队列。
    const pending = listMemoryProposals(home, { status: "pending" });
    expect(pending).toHaveLength(1);
    const ok = approveMemoryProposal(home, pending[0].id, {});
    expect(ok.ok).toBe(true);
    const r3 = extractMemoryProposals(home, "sess-1", msgs);
    expect(r3.added).toBe(0);
  } finally {
    cleanup(home);
  }
});

test("账本：损坏先备份再回空账本，不拦运行", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    writeFileSync(join(home, MEMORY_PROPOSALS_FILE), "{ not json", "utf-8");
    const out = readMemoryProposals(home);
    expect(out).toEqual([]);
    // 备份文件已生成（.bak- 时间戳后缀）。
    const files = readdirSync(home).filter((f) => f.startsWith(MEMORY_PROPOSALS_FILE + ".bak-"));
    expect(files.length).toBe(1);
    // 损坏后仍能正常提炼。
    const r = extractMemoryProposals(home, "sess-1", [user("我是铜陵职业技术学院的学生。")]);
    expect(r.added).toBe(1);
  } finally {
    cleanup(home);
  }
});

// ---- 确认进库（过证据门）与拒绝 --------------------------------------------

test("确认：过证据门进结构化记忆库，候选标 confirmed 并记条目 id", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    extractMemoryProposals(home, "sess-1", [user("请记住，我是铜陵职业技术学院工业机器人技术专业的学生。")]);
    const p = listMemoryProposals(home, { status: "pending" })[0];
    const res = approveMemoryProposal(home, p.id, {});
    expect(res.ok).toBe(true);
    expect(res.entryId).toMatch(/^memg_[0-9a-f]{12}$/);
    const after = getMemoryProposal(home, p.id)!;
    expect(after.status).toBe("confirmed");
    expect(after.entryId).toBe(res.entryId);
    expect(after.decidedAt).not.toBeNull();
    // 已决定过不能再确认。
    const again = approveMemoryProposal(home, p.id, {});
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("already-decided");
  } finally {
    cleanup(home);
  }
});

test("确认：改后正文同样过门，含密钥的候选被门拦下、留在队列里", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    extractMemoryProposals(home, "sess-1", [user("记住，我的 key 是 sk-abcdefgh12345678。")]);
    const p = listMemoryProposals(home, { status: "pending" })[0];
    expect(p).toBeDefined();
    const res = approveMemoryProposal(home, p.id, {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("secret:sk-key");
    const after = getMemoryProposal(home, p.id)!;
    expect(after.status).toBe("pending");
    expect(after.decisionReason).toBe("secret:sk-key");
    const rows = listGateRejections(home, 5);
    expect(rows.some((r) => r.action === "proposal_approve" && r.reason === "secret:sk-key")).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("确认：改后正文进库，正文与条目一致", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    extractMemoryProposals(home, "sess-1", [user("请记住，我喜欢用工业机器人调试做例子。")]);
    const p = listMemoryProposals(home, { status: "pending" })[0];
    const res = approveMemoryProposal(home, p.id, { content: "用户喜欢用工业机器人调试做例子。" });
    expect(res.ok).toBe(true);
    const after = getMemoryProposal(home, p.id)!;
    expect(after.content).toBe("用户喜欢用工业机器人调试做例子。");
  } finally {
    cleanup(home);
  }
});

test("拒绝：标 rejected + 理由，拒绝记进拒绝账本，同一句不再重复提", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    const msgs = [user("请记住，我喜欢用工业机器人调试做例子。")];
    extractMemoryProposals(home, "sess-1", msgs);
    const p = listMemoryProposals(home, { status: "pending" })[0];
    const res = rejectMemoryProposal(home, p.id, "只是随口一说，不用记");
    expect(res.ok).toBe(true);
    const after = getMemoryProposal(home, p.id)!;
    expect(after.status).toBe("rejected");
    expect(after.decisionReason).toBe("只是随口一说，不用记");
    const rows = listGateRejections(home, 5);
    expect(rows.some((r) => r.action === "proposal_reject" && r.reason === "user-rejected")).toBe(true);
    // 已拒绝的同一句不再重复提。
    const r2 = extractMemoryProposals(home, "sess-1", msgs);
    expect(r2.added).toBe(0);
    // 已决定过不能再拒绝。
    expect(rejectMemoryProposal(home, p.id).ok).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("查不到的候选：确认与拒绝都报 not-found，不抛错", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    expect(approveMemoryProposal(home, "memp_0123456789ab", {}).reason).toBe("not-found");
    expect(rejectMemoryProposal(home, "memp_0123456789ab").ok).toBe(false);
    expect(getMemoryProposal(home, "memp_0123456789ab")).toBeNull();
  } finally {
    cleanup(home);
  }
});

// ---- 事件注册 ---------------------------------------------------------------

test("事件注册：memory_proposal_extracted / memory_proposal_decided 可记，未知事件拒绝", () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    const store = new RunStore(join(home, "runs"));
    const run = store.create("t", "sess-1", tmpdir(), "full", 5);
    store.appendEvent(run.run_id, "memory_proposal_extracted", { session: "sess-1", added: 2, total: 2 });
    store.appendEvent(run.run_id, "memory_proposal_decided", { proposal: "memp_0123456789ab", decision: "approve", entry: "memg_0123456789ab" });
    expect(() => store.appendEvent(run.run_id, "no_such_event_xyz", {})).toThrow("运行事件无效");
  } finally {
    cleanup(home);
  }
});

// ---- CLI 全程 -----------------------------------------------------------------

test("CLI：extract → review → approve 全程，决定记进证据文件", async () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    const sessionId = "20261124-020000-ab12";
    saveSession(sessionId, [
      user("请记住，我是铜陵职业技术学院工业机器人技术专业的学生。"),
      assistant("好的。"),
      user("我喜欢用工业机器人调试做例子。"),
    ], home);
    let cap = captureOutput();
    let code = await handleMemoryProposals(["extract", sessionId], home);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("提炼出 2 条候选记忆");
    cap = captureOutput();
    code = await handleMemoryProposals(["review"], home);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("我是铜陵职业技术学院");
    const pending = listMemoryProposals(home, { status: "pending" });
    expect(pending).toHaveLength(2);
    cap = captureOutput();
    code = await handleMemoryProposals(["review", "approve", pending[0].id], home);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("已确认进库");
    expect(listMemoryProposals(home, { status: "pending" })).toHaveLength(1);
    // 决定记进了证据文件。
    const evidenceDir = join(home, "evidence", "memory");
    expect(existsSync(evidenceDir)).toBe(true);
    const files = readdirSync(evidenceDir);
    expect(files.some((f) => f.includes("memory_proposal_decided"))).toBe(true);
    // review reject 另一条。
    cap = captureOutput();
    code = await handleMemoryProposals(["review", "reject", pending[1].id, "--reason", "不用记"], home);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("已拒绝");
    expect(listMemoryProposals(home, { status: "pending" })).toHaveLength(0);
  } finally {
    cleanup(home);
  }
});

test("CLI：extract 找不到会话、review 空队列、参数缺失都给用法不抛错", async () => {
  const home = tmpHome("nyra-mp-home-");
  try {
    let cap = captureOutput();
    let code = await handleMemoryProposals(["extract", "no-such-session"], home);
    cap.restore();
    expect(code).toBe(1);
    cap = captureOutput();
    code = await handleMemoryProposals(["review"], home);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("没有待确认的候选记忆");
    cap = captureOutput();
    code = await handleMemoryProposals(["extract"], home);
    cap.restore();
    expect(code).toBe(2);
    cap = captureOutput();
    code = await handleMemoryProposals(["review", "approve"], home);
    cap.restore();
    expect(code).toBe(2);
  } finally {
    cleanup(home);
  }
});

// ---- 对话结束自动提炼（Agent 钩子）------------------------------------------

test("Agent 钩子：对话结束自动提炼候选进队列，不进库、不破坏回复", async () => {
  const home = tmpHome("nyra-mp-home-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-mp-wd-"));
  try {
    const provider = new FakeProvider([textReply("好的，记下了。")]);
    const agent = new Agent(provider as never, { home, workdir, mode: "full", skillsDirs: [] });
    const final = await agent.run("请记住，我是铜陵职业技术学院工业机器人技术专业的学生。");
    expect(final).toContain("好的，记下了。");
    const pending = listMemoryProposals(home, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toContain("我是铜陵职业技术学院");
    // 只是候选，没进库。
    const { listMemoryGateEntries } = await import("../../src/memoryGate.ts");
    expect(listMemoryGateEntries(home)).toHaveLength(0);
  } finally {
    cleanup(home);
    rmSync(workdir, { recursive: true, force: true });
  }
});
