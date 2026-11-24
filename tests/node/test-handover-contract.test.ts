// tests/node/test-handover-contract.test.ts — Pi Bot 借鉴第 2 条：交接契约的
// 程序化验收。
//
// 覆盖：立契约的校验（from≠to、任务长度、交付物路径相对无逃逸、验收项
// checker 已知、轮次上限 0–5、id 不重复）、程序验收（交付物逐件核对：
// 存在/普通文件/非符号链接/非空 + checker 逐项跑）、结论三态（全过接受、
// 不过打回、轮次用完停下等人）、人工定夺/放弃、挂交接包、信任阶梯联动
// （通过记成功、打回/停下记违规，未登记主体不抛错只提示）、账本 0600 与
// 损坏先备份再抛错、审计 JSONL、运行事件注册（accepted/sent_back/
// stopped/resolved/closed）、CLI（contract create/list/show/check/
// resolve/close + checkers）。全部在临时 home 里跑，不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHandoverContract, getHandoverContract, listHandoverContracts,
  checkHandoverContract, resolveHandoverContract, closeHandoverContract,
  linkHandoverPackage, handoverContractHash, formatHandoverContract,
  HandoverContractError, HANDOVER_CONTRACTS_FILE, HANDOVER_CONTRACT_AUDIT_FILE,
  type HandoverContract,
} from "../../src/handoverContract.ts";
import { registerSubject, loadTrustStore } from "../../src/trustLadder.ts";
import { handleHandover } from "../../src/handoverCli.ts";
import { RunStore } from "../../src/runs.ts";
import { expectPerms } from "./fsPerms.ts";
import { defaultSoul, saveSoul, setCharter } from "../../src/soul.ts";
import { sendHandover, ackHandover, readHandover, listHandovers, handleTeam, TeamError } from "../../src/team.ts";
import { resolveBotComputer } from "../../src/bot/binding.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { AUDIT_SOURCES } from "../../src/costCaps.ts";

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-handover-test-"));
  // 抽查关掉，成功计数才确定（默认 10% 随机抽查会让计数浮动）。
  writeFileSync(join(home, "config.json"), JSON.stringify({ trust_ladder: { spot_check_rate: 0 } }), "utf-8");
  return home;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function workdir(home: string): string {
  const dir = join(home, "work");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWork(dir: string, rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function makeContract(home: string, over: Partial<Parameters<typeof createHandoverContract>[1]> = {}): HandoverContract {
  return createHandoverContract(home, {
    from: "worker",
    to: "chief",
    task: "写报告并改代码",
    deliverables: [{ id: "report", path: "report.md", description: "报告" }],
    checks: [{ id: "exists", label: "报告存在", checker: "file-exists:report.md" }],
    ...over,
  });
}

function makeRun(home: string, dir: string): string {
  const store = new RunStore(join(home, "runs"));
  return store.create("写报告并改代码", "sess-1", dir, "normal", 10).run_id;
}

function runEvents(home: string, runId: string): { type: string; [key: string]: unknown }[] {
  // 事件存在 runs/<id>/events.jsonl 里，不在 run state 上（与缺口 29 的测法同款）。
  const store = new RunStore(join(home, "runs"));
  return store.readEvents(runId) as { type: string; [key: string]: unknown }[];
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return { logs, restore: () => { process.stdout.write = orig; } };
}

// ---- 立契约 ----

test("立契约：id 前缀 hc-、待验收、默认轮次上限 1、账本 0600", () => {
  const home = tempHome();
  try {
    const c = makeContract(home);
    expect(c.id.startsWith("hc_")).toBe(true); // 与 team.ts 的 ho_ 同款下划线口径
    expect(c.status).toBe("pending");
    expect(c.maxRounds).toBe(1);
    expect(c.roundsUsed).toBe(0);
    expect(c.attempts).toEqual([]);
    expect(c.packageId).toBeNull();
    expect(existsSync(join(home, HANDOVER_CONTRACTS_FILE))).toBe(true);
    expectPerms(join(home, HANDOVER_CONTRACTS_FILE), 0o600);
  } finally { cleanup(home); }
});

test("立契约校验：from 与 to 相同、任务空/超长、无交付物、无验收项都拒绝", () => {
  const home = tempHome();
  try {
    expect(() => makeContract(home, { from: "chief", to: "chief" })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { task: "  " })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { task: "x".repeat(201) })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { deliverables: [] })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { checks: [] })).toThrow(HandoverContractError);
  } finally { cleanup(home); }
});

test("立契约校验：交付物路径须相对、无 .. 逃逸、id 不重复；验收项 checker 须已知、id 不重复；轮次 0–5", () => {
  const home = tempHome();
  try {
    expect(() => makeContract(home, { deliverables: [{ id: "a", path: "/tmp/x.md", description: "绝" }] })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { deliverables: [{ id: "a", path: "../x.md", description: "逃" }] })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { deliverables: [{ id: "a", path: "", description: "空" }] })).toThrow(HandoverContractError);
    expect(() => makeContract(home, {
      deliverables: [
        { id: "a", path: "a.md", description: "甲" },
        { id: "a", path: "b.md", description: "乙" },
      ],
    })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { checks: [{ id: "x", label: "未知", checker: "no-such-checker" }] })).toThrow(HandoverContractError);
    expect(() => makeContract(home, {
      checks: [
        { id: "x", label: "甲", checker: "has-changes" },
        { id: "x", label: "乙", checker: "has-changes" },
      ],
    })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { maxRounds: 6 })).toThrow(HandoverContractError);
    expect(() => makeContract(home, { maxRounds: -1 })).toThrow(HandoverContractError);
    expect(makeContract(home, { maxRounds: 0 }).maxRounds).toBe(0);
    expect(makeContract(home, { maxRounds: 5 }).maxRounds).toBe(5);
  } finally { cleanup(home); }
});

test("契约指纹只算任务+交付物+验收项：同内容两份契约指纹相同，时间戳与状态不进指纹", () => {
  const home = tempHome();
  try {
    const a = makeContract(home);
    const b = makeContract(home);
    expect(a.id).not.toBe(b.id);
    expect(handoverContractHash(a)).toBe(handoverContractHash(b));
  } finally { cleanup(home); }
});

test("list 过滤：按状态/from/to；get 找不到返回 null", () => {
  const home = tempHome();
  try {
    const a = makeContract(home);
    const b = makeContract(home, { from: "helper" });
    closeHandoverContract(home, b.id, "cli");
    expect(listHandoverContracts(home)).toHaveLength(2);
    expect(listHandoverContracts(home, { status: "pending" })).toHaveLength(1);
    expect(listHandoverContracts(home, { status: "closed" })[0]!.id).toBe(b.id);
    expect(listHandoverContracts(home, { from: "helper" })).toHaveLength(1);
    expect(listHandoverContracts(home, { to: "chief", status: "pending" })[0]!.id).toBe(a.id);
    expect(getHandoverContract(home, "hc-不存在")).toBeNull();
  } finally { cleanup(home); }
});

// ---- 程序验收 ----

test("验收全过：接受、attempt 记逐项结果、信任记一次成功、审计与事件都留痕", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    writeWork(dir, "report.md", "# 报告\n已完成\n");
    registerSubject(home, "agent", "worker");
    const c = makeContract(home, {
      checks: [
        { id: "exists", label: "报告存在", checker: "file-exists:report.md" },
        { id: "changed", label: "有可验收的改动", checker: "has-changes" },
      ],
    });
    const runId = makeRun(home, dir);
    const result = checkHandoverContract(home, c.id, { workdir: dir }, { runId });
    expect(result.verdict).toBe("accepted");
    expect(result.attempt.passedCount).toBe(3); // 1 件交付物 + 2 项验收
    expect(result.attempt.total).toBe(3);
    expect(result.attempt.items.every((i) => i.passed)).toBe(true);
    expect(result.trustRecorded).toBe(true);
    expect(result.text).toContain("已通过程序验收");
    const after = getHandoverContract(home, c.id)!;
    expect(after.status).toBe("accepted");
    expect(after.attempts).toHaveLength(1);
    const store = loadTrustStore(home);
    const subject = store.subjects["agent:worker"]!;
    expect(subject.successes_at_level).toBe(1);
    expect(subject.violations_total).toBe(0);
    const audit = readFileSync(join(home, HANDOVER_CONTRACT_AUDIT_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.some((a) => a.action === "contract_checked" && a.verdict === "accepted")).toBe(true);
    const events = runEvents(home, runId);
    const ev = events.find((e) => e.type === "handover_contract_accepted");
    expect(ev).toBeDefined();
    expect(ev!.contract_id).toBe(c.id);
    expect(ev!.passed).toBe(3);
    expect(ev!.total).toBe(3);
  } finally { cleanup(home); }
});

test("验收不过：交付物缺失打回、信任记一次违规清零成功计数、文本给待改清单", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    registerSubject(home, "agent", "worker");
    const c = makeContract(home);
    const result = checkHandoverContract(home, c.id, { workdir: dir });
    expect(result.verdict).toBe("sent-back");
    expect(result.attempt.passedCount).toBe(0);
    expect(result.attempt.items[0]!.detail).toContain("不在工作目录里");
    expect(result.text).toContain("打回");
    expect(result.text).toContain("改完再交");
    const after = getHandoverContract(home, c.id)!;
    expect(after.status).toBe("sent-back");
    expect(after.roundsUsed).toBe(1);
    const subject = loadTrustStore(home).subjects["agent:worker"]!;
    expect(subject.violations_total).toBe(1);
    expect(subject.successes_at_level).toBe(0);
  } finally { cleanup(home); }
});

test("轮次用完：第二次不过停下等人；resolve 后认下；已终态再验收拒绝", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const c = makeContract(home);
    const first = checkHandoverContract(home, c.id, { workdir: dir });
    expect(first.verdict).toBe("sent-back");
    const second = checkHandoverContract(home, c.id, { workdir: dir });
    expect(second.verdict).toBe("stopped");
    expect(second.text).toContain("停下");
    const stopped = getHandoverContract(home, c.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.roundsUsed).toBe(2);
    expect(() => checkHandoverContract(home, c.id, { workdir: dir })).toThrow(HandoverContractError);
    expect(() => resolveHandoverContract(home, c.id, "chief")).not.toThrow();
    expect(getHandoverContract(home, c.id)!.status).toBe("resolved");
    expect(() => resolveHandoverContract(home, c.id, "chief")).toThrow(HandoverContractError);
  } finally { cleanup(home); }
});

test("轮次上限 0：第一次不过直接停下等人", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const c = makeContract(home, { maxRounds: 0 });
    const result = checkHandoverContract(home, c.id, { workdir: dir });
    expect(result.verdict).toBe("stopped");
    expect(getHandoverContract(home, c.id)!.status).toBe("stopped");
  } finally { cleanup(home); }
});

test("交付物是空文件：未过且 detail 说是空的", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    writeWork(dir, "report.md", "");
    const c = makeContract(home);
    const result = checkHandoverContract(home, c.id, { workdir: dir });
    expect(result.verdict).toBe("sent-back");
    expect(result.attempt.items[0]!.detail).toContain("空");
  } finally { cleanup(home); }
});

test("交付物是符号链接：未过且 detail 说是符号链接（建链失败时跳过断言）", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    writeWork(dir, "real.md", "真内容");
    try {
      symlinkSync(join(dir, "real.md"), join(dir, "report.md"));
    } catch {
      return; // Windows 上没权限建符号链接时跳过（CI 上该平台守卫与全仓同口径）
    }
    const c = makeContract(home);
    const result = checkHandoverContract(home, c.id, { workdir: dir });
    expect(result.verdict).toBe("sent-back");
    expect(result.attempt.items[0]!.detail).toContain("符号链接");
  } finally { cleanup(home); }
});

test("checker 逐项跑：output-contains / trajectory-contains / no-tool 按输入判定", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    writeWork(dir, "report.md", "已完成");
    const c = makeContract(home, {
      checks: [
        { id: "out", label: "输出含已完成", checker: "output-contains:已完成" },
        { id: "traj", label: "调过 read", checker: "trajectory-contains:read" },
        { id: "notool", label: "没调 send", checker: "no-tool:send_message" },
      ],
    });
    const ok = checkHandoverContract(home, c.id, { workdir: dir, outputText: "结果：已完成", trajectory: ["read", "write"] });
    expect(ok.verdict).toBe("accepted");
    const c2 = makeContract(home, {
      checks: [
        { id: "out", label: "输出含已完成", checker: "output-contains:已完成" },
        { id: "notool", label: "没调 send", checker: "no-tool:send_message" },
      ],
    });
    const bad = checkHandoverContract(home, c2.id, { workdir: dir, outputText: "结果：什么都没查到", trajectory: ["send_message"] });
    expect(bad.verdict).toBe("sent-back");
    expect(bad.attempt.items.filter((i) => !i.passed)).toHaveLength(2);
  } finally { cleanup(home); }
});

test("未登记的主体：验收失败不抛错、trustRecorded 为 false", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const c = makeContract(home);
    const result = checkHandoverContract(home, c.id, { workdir: dir });
    expect(result.verdict).toBe("sent-back");
    expect(result.trustRecorded).toBe(false);
  } finally { cleanup(home); }
});

test("打回事件进运行证据链：sent_back 事件带轮次与通过数", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const c = makeContract(home);
    const runId = makeRun(home, dir);
    checkHandoverContract(home, c.id, { workdir: dir }, { runId });
    const events = runEvents(home, runId);
    const ev = events.find((e) => e.type === "handover_contract_sent_back");
    expect(ev).toBeDefined();
    expect(ev!.round).toBe(1);
    expect(ev!.passed).toBe(0);
    expect(ev!.total).toBe(2); // 1 件交付物 + 1 项验收
  } finally { cleanup(home); }
});

// ---- 挂包 / 定夺 / 放弃 ----

test("挂交接包：挂上记 packageId；再挂另一包、挂已终态契约、挂不存在的契约都拒绝", () => {
  const home = tempHome();
  try {
    const c = makeContract(home);
    expect(() => linkHandoverPackage(home, "hc-不存在", "hd-1")).toThrow(HandoverContractError);
    linkHandoverPackage(home, c.id, "hd-1");
    expect(getHandoverContract(home, c.id)!.packageId).toBe("hd-1");
    expect(() => linkHandoverPackage(home, c.id, "hd-2")).toThrow(HandoverContractError);
    const dir = workdir(home);
    checkHandoverContract(home, c.id, { workdir: dir });
    checkHandoverContract(home, c.id, { workdir: dir });
    expect(getHandoverContract(home, c.id)!.status).toBe("stopped");
    expect(() => linkHandoverPackage(home, c.id, "hd-3")).toThrow(HandoverContractError);
  } finally { cleanup(home); }
});

test("放弃：待验收能放弃；已接受的不能放弃；pending 不能 resolve", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    writeWork(dir, "report.md", "内容");
    const a = makeContract(home);
    expect(() => resolveHandoverContract(home, a.id, "chief")).toThrow(HandoverContractError);
    const closed = closeHandoverContract(home, a.id, "chief");
    expect(closed.status).toBe("closed");
    expect(() => closeHandoverContract(home, a.id, "chief")).toThrow(HandoverContractError);
    const b = makeContract(home);
    checkHandoverContract(home, b.id, { workdir: dir });
    expect(() => closeHandoverContract(home, b.id, "chief")).toThrow(HandoverContractError);
  } finally { cleanup(home); }
});

test("账本损坏：先备份再抛错，旧数据不丢", () => {
  const home = tempHome();
  try {
    const c = makeContract(home);
    writeFileSync(join(home, HANDOVER_CONTRACTS_FILE), "{ 坏的 json", "utf-8");
    expect(() => createHandoverContract(home, {
      from: "worker", to: "chief", task: "再来一份",
      deliverables: [{ id: "r", path: "r.md", description: "r" }],
      checks: [{ id: "e", label: "在", checker: "file-exists:r.md" }],
    })).toThrow(HandoverContractError);
    // 备份名是 <账本>.corrupt-<时间戳>（与全仓同口径），旧数据原样留着。
    const backups = readdirSync(home).filter((f) => f.startsWith(HANDOVER_CONTRACTS_FILE + ".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, backups[0]!), "utf-8")).toBe("{ 坏的 json");
    expect(c.id.startsWith("hc_")).toBe(true);
  } finally { cleanup(home); }
});

test("formatHandoverContract：含 id、状态、交付物、验收项、轮次与最近一次验收", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const c = makeContract(home);
    checkHandoverContract(home, c.id, { workdir: dir });
    const text = formatHandoverContract(getHandoverContract(home, c.id)!);
    expect(text).toContain(c.id);
    expect(text).toContain("已打回");
    expect(text).toContain("report.md");
    expect(text).toContain("file-exists:report.md");
    expect(text).toContain("1/1");
    expect(text).toContain("最近一次验收");
  } finally { cleanup(home); }
});

// ---- CLI ----

test("CLI 全流程：create/list/show/check/resolve/close + checkers", async () => {
  const home = tempHome();
  const { logs, restore } = captureStdout();
  try {
    const dir = workdir(home);
    expect(await handleHandover(["contract", "create", "--from", "worker", "--to", "chief", "--task", "写报告", "--deliverable", "report:report.md:报告", "--check", "exists:file-exists:report.md:报告存在"], home)).toBe(0);
    expect(logs.join("")).toContain("交接契约已立");
    const id = listHandoverContracts(home)[0]!.id;
    expect(await handleHandover(["contract", "list"], home)).toBe(0);
    expect(logs.join("")).toContain(id);
    expect(await handleHandover(["contract", "show", id], home)).toBe(0);
    expect(logs.join("")).toContain("写报告");
    // 没写文件时验收打回，退出 1。
    expect(await handleHandover(["contract", "check", id, "--workdir", dir], home)).toBe(1);
    expect(logs.join("")).toContain("已打回");
    writeWork(dir, "report.md", "内容");
    expect(await handleHandover(["contract", "check", id, "--workdir", dir], home)).toBe(0);
    expect(logs.join("")).toContain("已接受");
    // 已接受的契约不能 close；checkers 列得出。
    expect(await handleHandover(["contract", "close", id, "--yes"], home)).toBe(1);
    expect(await handleHandover(["checkers"], home)).toBe(0);
    expect(logs.join("")).toContain("file-exists");
    expect(await handleHandover(["contract", "list", "--json"], home)).toBe(0);
    expect(logs.join("")).toContain(id);
  } finally { restore(); cleanup(home); }
});

test("CLI 参数错误：缺 from 返回 1、check 缺 workdir 返回 2、resolve 缺 --yes 返回 2、未知子命令返回 2", async () => {
  const home = tempHome();
  const { restore } = captureStdout();
  try {
    expect(await handleHandover(["contract", "create", "--to", "chief", "--task", "写报告"], home)).toBe(1);
    const c = makeContract(home);
    const dir = workdir(home);
    expect(await handleHandover(["contract", "check", c.id], home)).toBe(2);
    expect(await handleHandover(["contract", "resolve", c.id], home)).toBe(2);
    expect(await handleHandover(["contract", "nonsense"], home)).toBe(2);
    expect(await handleHandover(["nonsense"], home)).toBe(2);
    expect(await handleHandover(["contract", "check", c.id, "--workdir", dir, "--output-file", join(dir, "不存在.txt")], home)).toBe(1);
  } finally { restore(); cleanup(home); }
});

test("CLI check 打回后 resolve：停下等人后人能定夺认下", async () => {
  const home = tempHome();
  const { logs, restore } = captureStdout();
  try {
    const dir = workdir(home);
    const c = makeContract(home, { maxRounds: 0 });
    expect(await handleHandover(["contract", "check", c.id, "--workdir", dir], home)).toBe(1);
    expect(logs.join("")).toContain("停下");
    expect(await handleHandover(["contract", "resolve", c.id, "--yes"], home)).toBe(0);
    expect(getHandoverContract(home, c.id)!.status).toBe("resolved");
  } finally { restore(); cleanup(home); }
});

test("审计 JSONL 每行都能解析：立约与验收各留一行", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const c = makeContract(home);
    checkHandoverContract(home, c.id, { workdir: dir });
    const lines = readFileSync(join(home, HANDOVER_CONTRACT_AUDIT_FILE), "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.action)).toContain("contract_created");
    expect(rows.map((r) => r.action)).toContain("contract_checked");
    expect(rows.every((r) => typeof r.at === "string" && typeof r.contract_id === "string")).toBe(true);
  } finally { cleanup(home); }
});

// ---- 与 GROK-4 文件交接的接线 ----

function makeSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
  setCharter(home, agent, {
    own: "负责写报告",
    sources: ["任务板", "上周报告"],
    output: "以 ## 结论 开头，附三条要点",
    approval: "对外发送前须人批",
    stop: "缺关键数据时停下问人",
  });
}

function workerWorkdir(home: string): string {
  const binding = resolveBotComputer(home, "worker");
  if (!binding) throw new Error("worker 还没有电脑（先建 Soul）");
  return binding.workdir;
}

test("team 接线：send 挂契约，ack 先程序验收——过了才接下", () => {
  const home = tempHome();
  try {
    makeSoul(home, "worker");
    makeSoul(home, "chief");
    const dir = workerWorkdir(home);
    writeWork(dir, "report.md", "# 报告\n已完成\n");
    const c = makeContract(home);
    const pkg = sendHandover(home, { from: "worker", to: "chief", task: "写报告并改代码", files: ["report.md"], contractId: c.id });
    expect(pkg.contract_id).toBe(c.id);
    expect(getHandoverContract(home, c.id)!.packageId).toBe(pkg.id);
    const accepted = ackHandover(home, "chief", pkg.id);
    expect(accepted.status).toBe("accepted");
    expect(getHandoverContract(home, c.id)!.status).toBe("accepted");
  } finally { cleanup(home); }
});

test("team 接线：ack 时验收没过打回，包保持待接；补文件后重 ack 才接下", () => {
  const home = tempHome();
  try {
    makeSoul(home, "worker");
    makeSoul(home, "chief");
    const dir = workerWorkdir(home);
    const c = makeContract(home);
    const pkg = sendHandover(home, { from: "worker", to: "chief", task: "写报告并改代码", files: [], contractId: c.id });
    // 只调一次 ack（每调一次算一轮验收轮次，再调就是第二轮了）。
    let firstErr: unknown = null;
    try { ackHandover(home, "chief", pkg.id); } catch (e) { firstErr = e; }
    expect(firstErr).toBeInstanceOf(TeamError);
    expect((firstErr as Error).message).toContain("打回");
    expect(readHandover(home, "chief", pkg.id).pkg.status).toBe("sent");
    expect(getHandoverContract(home, c.id)!.status).toBe("sent-back");
    writeWork(dir, "report.md", "# 报告\n已完成\n");
    const accepted = ackHandover(home, "chief", pkg.id);
    expect(accepted.status).toBe("accepted");
  } finally { cleanup(home); }
});

test("team 接线：send 挂 from/to 不一致或已终态的契约都拒绝；没挂契约的包 ack 不变", () => {
  const home = tempHome();
  try {
    makeSoul(home, "worker");
    makeSoul(home, "chief");
    makeSoul(home, "helper");
    const dir = workerWorkdir(home);
    writeWork(dir, "report.md", "内容");
    const mismatch = makeContract(home, { from: "helper", to: "chief" });
    expect(() => sendHandover(home, { from: "worker", to: "chief", task: "写报告", files: ["report.md"], contractId: mismatch.id })).toThrow(TeamError);
    const closed = makeContract(home);
    closeHandoverContract(home, closed.id, "chief");
    expect(() => sendHandover(home, { from: "worker", to: "chief", task: "写报告", files: ["report.md"], contractId: closed.id })).toThrow(TeamError);
    // 没挂契约的包：ack 还是原来那样直接接下。
    const plain = sendHandover(home, { from: "worker", to: "chief", task: "只交代一句话", files: [] });
    expect(plain.contract_id).toBeNull();
    expect(ackHandover(home, "chief", plain.id).status).toBe("accepted");
  } finally { cleanup(home); }
});

test("team CLI：handover send --contract 与 ack --workdir 走得通", async () => {
  const home = tempHome();
  const { logs, restore } = captureStdout();
  try {
    makeSoul(home, "worker");
    makeSoul(home, "chief");
    const dir = workerWorkdir(home);
    writeWork(dir, "report.md", "内容");
    const c = makeContract(home);
    expect(await handleTeam(["handover", "send", "--from", "worker", "--to", "chief", "--task", "写报告", "--file", "report.md", "--contract", c.id], home)).toBe(0);
    expect(logs.join("")).toContain("挂交接契约");
    const pkgId = listHandovers(home, "chief", "inbox")[0]!.id;
    expect(await handleTeam(["handover", "ack", "chief", pkgId], home)).toBe(0);
    expect(readHandover(home, "chief", pkgId).pkg.status).toBe("accepted");
    expect(await handleTeam(["handover", "show", "chief", pkgId], home)).toBe(0);
    expect(logs.join("")).toContain("交接契约");
  } finally { restore(); cleanup(home); }
});

test("时间线渲染：五种交接契约事件都看得懂", () => {
  const home = tempHome();
  try {
    const dir = workdir(home);
    const store = new RunStore(join(home, "runs"));
    const runId = store.create("写报告", "sess-1", dir, "normal", 10).run_id;
    store.appendEvent(runId, "handover_contract_accepted", { contract_id: "hc_a", from: "worker", to: "chief", round: 1, passed: 3, total: 3 });
    store.appendEvent(runId, "handover_contract_sent_back", { contract_id: "hc_b", from: "worker", to: "chief", round: 1, passed: 0, total: 2 });
    store.appendEvent(runId, "handover_contract_stopped", { contract_id: "hc_c", from: "worker", to: "chief", round: 2, passed: 1, total: 2 });
    store.appendEvent(runId, "handover_contract_resolved", { contract_id: "hc_c", from: "worker", to: "chief", by: "chief" });
    store.appendEvent(runId, "handover_contract_closed", { contract_id: "hc_d", from: "worker", to: "chief", by: "chief" });
    const text = formatTimelineText(buildTimeline(store, runId));
    expect(text).toContain("交接契约已接受");
    expect(text).toContain("交接契约已打回");
    expect(text).toContain("交接契约已停下等人");
    expect(text).toContain("交接契约人工已定夺");
    expect(text).toContain("交接契约已放弃");
  } finally { cleanup(home); }
});

test("审计：交接契约验收审计进 SIEM 导出（第 11 个来源）", () => {
  expect(AUDIT_SOURCES.some((s) => s.file === "handover-contract-audit.jsonl" && s.label === "handover_contract")).toBe(true);
  expect(AUDIT_SOURCES.length).toBe(11); // O1 加了第 11 个来源（策略网关审计 policy-audit.jsonl）。
  expect(AUDIT_SOURCES[9]!.file).toBe("handover-contract-audit.jsonl");
});
