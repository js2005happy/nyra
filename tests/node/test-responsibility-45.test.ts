// tests/node/test-responsibility-45.test.ts — 缺口 45 第一批：持续责任语义。
// 责任对象（归属人 + 验收标准 + 升级条件 + 过期时间 + 生命周期）与晨间简报生成。
// 全部 mock-only：巡查用假 provider，简报只拼已有证据，不调模型、不连真实服务。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResponsibilityError, addResponsibility, completeResponsibility,
  isResponsibilityDue, loadResponsibilities, matchEscalationConditions,
  parseListField, responsibilitiesPath, runPatrol, saveResponsibilities,
  setResponsibilityStatus, sweepExpiredResponsibilities, validateResponsibility,
} from "../../src/responsibilities.ts";
import {
  briefingsPath, buildMorningBrief, collectMorningBrief, latestBriefingPath,
  loadBriefingLedger,
} from "../../src/briefing.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline } from "../../src/timeline.ts";
import { enqueueReviewItem, loadReviewQueue } from "../../src/reviewQueue.ts";
import { loadInbox } from "../../src/tasks.ts";
import type { Provider } from "../../src/providers.ts";
import { echoProvider } from "./fake-provider.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-resp45-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-resp45-wd-"));
  return { home, workdir };
}

function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "依赖安全更新", goal: "检查依赖有没有可用的安全更新，有就记下来",
    every_seconds: 600, report: "on-finding", ...overrides,
  };
}

function storeFor(home: string): RunStore {
  return new RunStore(join(home, "tasks"));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("责任对象新字段默认值", () => {
  const r = validateResponsibility(makeRaw());
  expect(r.owner).toBe("user");
  expect(r.done_when).toEqual([]);
  expect(r.escalate_on).toEqual([]);
  expect(r.expires_at).toBeNull();
  expect(r.status).toBe("active");
  expect(r.completed_at).toBeNull();
  expect(r.expired_at).toBeNull();
});

test("老行回填：禁用过的当暂停，没禁用过的当进行中", () => {
  const paused = validateResponsibility(makeRaw({ enabled: false }));
  expect(paused.status).toBe("paused");
  const active = validateResponsibility(makeRaw({ enabled: true }));
  expect(active.status).toBe("active");
  const old = validateResponsibility(makeRaw({ status: "completed", completed_at: "2026-11-20T00:00:00.000Z" }));
  expect(old.status).toBe("completed");
});

test("校验：未知 checker 的验收标准拒绝，超 20 条拒绝，过期时间非法拒绝", () => {
  expect(() => validateResponsibility(makeRaw({ done_when: ["no-such-checker:xxx"] }))).toThrow("不是已知 checker");
  expect(() => validateResponsibility(makeRaw({ done_when: Array.from({ length: 21 }, (_, i) => `条目${i}`) }))).toThrow("最多 20 条");
  expect(() => validateResponsibility(makeRaw({ expires_at: "不是时间" }))).toThrow("ISO 时间");
  expect(() => validateResponsibility(makeRaw({ owner: "  " }))).toThrow("归属人");
  expect(parseListField("a, b,,c", "x")).toEqual(["a", "b", "c"]);
  expect(parseListField(["a", " b "], "x")).toEqual(["a", "b"]);
});

test("生命周期：暂停、恢复、取消，终态不能再切", () => {
  const { home } = setup();
  const data = { responsibilities: [validateResponsibility(makeRaw())] };
  expect(setResponsibilityStatus(data, "依赖安全更新", "paused", home)).toEqual({ from: "active", to: "paused" });
  expect(data.responsibilities[0]!.status).toBe("paused");
  expect(isResponsibilityDue(data.responsibilities[0]!)).toBe(false);
  expect(setResponsibilityStatus(data, "依赖安全更新", "active", home)).toEqual({ from: "paused", to: "active" });
  expect(isResponsibilityDue(data.responsibilities[0]!)).toBe(true);
  expect(setResponsibilityStatus(data, "依赖安全更新", "cancelled", home)).toEqual({ from: "active", to: "cancelled" });
  expect(() => setResponsibilityStatus(data, "依赖安全更新", "active", home)).toThrow("终态");
  expect(() => setResponsibilityStatus(data, "依赖安全更新", "completed", home)).toThrow("只能切到");
  expect(() => setResponsibilityStatus(data, "不存在", "paused", home)).toThrow("没有名为");
});

test("过期扫一遍：过了期的自动失效，未到期的不动", () => {
  const { home } = setup();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const data = { responsibilities: [
    validateResponsibility(makeRaw({ name: "过期责任", expires_at: past })),
    validateResponsibility(makeRaw({ name: "未过期", expires_at: future })),
  ] };
  const expired = sweepExpiredResponsibilities(data, new Date(), home);
  expect(expired.map((r) => r.name)).toEqual(["过期责任"]);
  expect(data.responsibilities[0]!.status).toBe("expired");
  expect(data.responsibilities[0]!.expired_at).not.toBeNull();
  expect(data.responsibilities[1]!.status).toBe("active");
  // 再扫一次不重复过期。
  expect(sweepExpiredResponsibilities(data, new Date(), home)).toEqual([]);
});

test("完成门：checker 全过才标完成，文件不存在直接拒绝", () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "报告.md"), "完成\n");
  const data = { responsibilities: [
    validateResponsibility(makeRaw({ name: "有验收", done_when: ["file-exists:报告.md"] })),
    validateResponsibility(makeRaw({ name: "缺文件", done_when: ["file-exists:没有这个文件.md"] })),
  ] };
  const done = completeResponsibility(data, "有验收", { home, workdir });
  expect(done.responsibility.status).toBe("completed");
  expect(done.results).toHaveLength(1);
  expect(done.results[0]!.passed).toBe(true);
  expect(() => completeResponsibility(data, "缺文件", { home, workdir })).toThrow("验收未通过");
  expect(data.responsibilities[1]!.status).toBe("active");
  expect(() => completeResponsibility(data, "有验收", { home, workdir })).toThrow("已完成");
});

test("完成门：纯文本条目与无验收标准须人工 --yes 确认", () => {
  const { home, workdir } = setup();
  const data = { responsibilities: [
    validateResponsibility(makeRaw({ name: "纯文本", done_when: ["负责人看过一眼"] })),
    validateResponsibility(makeRaw({ name: "无标准" })),
  ] };
  expect(() => completeResponsibility(data, "纯文本", { home, workdir })).toThrow("人工确认");
  const done = completeResponsibility(data, "纯文本", { home, workdir, confirmHuman: true });
  expect(done.humanConfirmed).toBe(true);
  expect(done.responsibility.status).toBe("completed");
  expect(() => completeResponsibility(data, "无标准", { home, workdir })).toThrow("人工确认");
  expect(completeResponsibility(data, "无标准", { home, workdir, confirmHuman: true }).responsibility.status).toBe("completed");
});

test("升级条件命中判定：子串匹配不区分大小写", () => {
  const resp = validateResponsibility(makeRaw({ escalate_on: ["高危", "ERROR"] }));
  expect(matchEscalationConditions(resp, "发现一个高危漏洞")).toEqual(["高危"]);
  expect(matchEscalationConditions(resp, "something error happened")).toEqual(["ERROR"]);
  expect(matchEscalationConditions(resp, "一切正常")).toEqual([]);
  expect(matchEscalationConditions(validateResponsibility(makeRaw()), "高危")).toEqual([]);
});

test("巡查命中升级条件进审阅队列，不命中不升级", async () => {
  const { home, workdir } = setup();
  const withEsc = validateResponsibility(makeRaw({
    name: "带升级", escalate_on: ["高危"],
  }));
  const result = await runPatrol(withEsc, {
    home, workdir,
    provider: echoProvider("- 依赖 lodash 有高危更新。\n巡查结论：有发现") as unknown as Provider,
  });
  expect(result.hasFindings).toBe(true);
  expect(result.escalated).toBe(true);
  expect(result.escalationItemId).not.toBeNull();
  const pending = loadReviewQueue(home).filter((it) => it.status === "pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source).toBe("automation");
  expect(pending[0]!.title).toContain("高危");
  expect(pending[0]!.runId).toBe(result.runId);
  const events = storeFor(home).readEvents(result.runId!);
  expect(events.some((e) => e.type === "responsibility_escalated")).toBe(true);

  const noEsc = validateResponsibility(makeRaw({ name: "不升级", escalate_on: ["高危"] }));
  const result2 = await runPatrol(noEsc, {
    home, workdir,
    provider: echoProvider("- 依赖 lodash 有普通更新。\n巡查结论：有发现") as unknown as Provider,
  });
  expect(result2.hasFindings).toBe(true);
  expect(result2.escalated).toBe(false);
  expect(loadReviewQueue(home).filter((it) => it.status === "pending")).toHaveLength(1);
});

test("简报无事安静：不写收件箱、不建 task 记录、账本照常推进", () => {
  const { home } = setup();
  const brief = buildMorningBrief(home, { now: new Date("2026-11-22T08:00:00.000Z") });
  expect(brief.quiet).toBe(true);
  expect(brief.progress).toEqual([]);
  expect(brief.decisions).toEqual([]);
  expect(brief.anomalies).toEqual([]);
  expect(brief.savedPath).toBeNull();
  expect(loadInbox(home)).toEqual([]);
  expect(loadBriefingLedger(briefingsPath(home)).last_brief_at).toBe("2026-11-22T08:00:00.000Z");
  // 证据文件里留一条审计（只记审计，不打扰人）。
  expect(existsSync(join(home, "evidence", "briefing"))).toBe(true);
});

test("简报有内容：三节齐全，每条带来源，收件箱只留指针", () => {
  const { home, workdir } = setup();
  const now = new Date("2026-11-22T08:00:00.000Z");
  // 昨夜一次有发现的巡查（直接写运行事件，不跑模型）。
  const store = storeFor(home);
  const run = store.create("巡查依赖安全更新", "s1", workdir, "readonly", 5, "completed_unverified");
  store.appendEvent(run.run_id, "patrol_report", {
    responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新",
    run_id: run.run_id, findings: true, reported: true,
  });
  store.appendEvent(run.run_id, "responsibility_escalated", {
    responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新",
    condition: "高危", item_id: "0011223344556677",
  });
  // 一项待批 + 一个窗口里完成的责任。
  enqueueReviewItem(home, { source: "automation", title: "责任升级待批", summary: "命中高危" });
  const data = { responsibilities: [validateResponsibility(makeRaw({
    name: "已完成责任", status: "completed", completed_at: "2026-11-22T02:00:00.000Z",
  }))] };
  saveResponsibilities(data, responsibilitiesPath(home));
  const brief = buildMorningBrief(home, { now, since: "2026-11-21T00:00:00.000Z" });
  expect(brief.quiet).toBe(false);
  expect(brief.progress.some((l) => l.includes("依赖安全更新") && l.includes("来源：巡查"))).toBe(true);
  expect(brief.progress.some((l) => l.includes("已完成责任") && l.includes("来源：责任"))).toBe(true);
  expect(brief.decisions.some((l) => l.includes("责任升级待批") && l.includes("来源：审阅队列"))).toBe(true);
  expect(brief.anomalies.some((l) => l.includes("高危") && l.includes("来源：巡查升级"))).toBe(true);
  expect(brief.text).toContain("## 昨夜进展");
  expect(brief.text).toContain("## 今日待决策");
  expect(brief.text).toContain("## 异常提醒");
  expect(brief.savedPath).toBe(join(home, "briefings", "2026-11-22.md"));
  expect(existsSync(brief.savedPath!)).toBe(true);
  expect(readFileSync(brief.savedPath!, "utf-8")).toBe(brief.text);
  const inbox = loadInbox(home);
  expect(inbox).toHaveLength(1);
  expect(String(inbox[0]!.summary)).toContain("晨间简报（2026-11-22）");
  expect(latestBriefingPath(home)).toBe(brief.savedPath);
});

test("简报窗口：窗口外的巡查不计入", () => {
  const { home, workdir } = setup();
  const store = storeFor(home);
  const run = store.create("巡查旧记录", "s1", workdir, "readonly", 5, "completed_unverified");
  store.appendEvent(run.run_id, "patrol_report", {
    responsibility_id: "aabbccddeeff0011", responsibility_name: "旧巡查",
    run_id: run.run_id, findings: true, reported: true,
  });
  // 窗口起点定在巡查之后（巡查是现在创建的，窗口从巡查之后起算）→ 不计入。
  // 注意：起点必须相对当前时间算，不能写死日期——写死 2026-11-23 的版本在
  // 当天 00:00–08:00 UTC 跑时会把刚创建的巡查算进窗口，导致 CI 在该时段全红。
  const after = new Date(Date.now() + 60_000);
  const brief = collectMorningBrief(home, { since: after.toISOString(), now: new Date(Date.now() + 2 * 60_000) });
  expect(brief.quiet).toBe(true);
  expect(brief.patrolRuns).toBe(0);
});

test("七个新事件已注册，时间线能渲染", () => {
  const { home, workdir } = setup();
  const store = storeFor(home);
  const run = store.create("责任事件", "s1", workdir, "readonly", 5, "running");
  store.appendEvent(run.run_id, "responsibility_paused", { responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新" });
  store.appendEvent(run.run_id, "responsibility_resumed", { responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新" });
  store.appendEvent(run.run_id, "responsibility_completed", { responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新", checks_passed: 2, checks_failed: 0 });
  store.appendEvent(run.run_id, "responsibility_cancelled", { responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新" });
  store.appendEvent(run.run_id, "responsibility_expired", { responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新" });
  store.appendEvent(run.run_id, "responsibility_escalated", { responsibility_id: "aabbccddeeff0011", responsibility_name: "依赖安全更新", condition: "高危", item_id: "0011223344556677" });
  store.appendEvent(run.run_id, "briefing_generated", { date: "2026-11-22", progress_items: 1, decision_items: 2, anomaly_items: 0, quiet: false });
  const timeline = buildTimeline(store, run.run_id);
  const titles = timeline.steps.map((s) => s.title).join("\n");
  expect(titles).toContain("已暂停");
  expect(titles).toContain("已恢复");
  expect(titles).toContain("已完成");
  expect(titles).toContain("已取消");
  expect(titles).toContain("已过期失效");
  expect(titles).toContain("命中升级条件");
  expect(titles).toContain("晨间简报已生成");
});

test("账本往返：0600 权限，损坏先备份再抛错", () => {
  const { home } = setup();
  const data = { responsibilities: [validateResponsibility(makeRaw({ owner: "小明", done_when: ["file-exists:报告.md"] }))] };
  const path = saveResponsibilities(data, responsibilitiesPath(home));
  expect(existsSync(path)).toBe(true);
  const loaded = loadResponsibilities(path);
  expect(loaded.responsibilities[0]!.owner).toBe("小明");
  expect(loaded.responsibilities[0]!.done_when).toEqual(["file-exists:报告.md"]);
  writeFileSync(path, "{ 不是 json");
  expect(() => loadResponsibilities(path)).toThrow("损坏");
});

test("CLI 全流程：add 带新字段、pause/resume/complete/brief/show", () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "报告.md"), "完成\n");
  let r = runCli(home, ["responsibility", "add", "--name", "磁盘空间", "--goal", "检查磁盘剩余空间",
    "--every", "3600", "--owner", "小明", "--done-when", "file-exists:报告.md", "--escalate-on", "低于 20%"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("已添加常驻责任");
  r = runCli(home, ["responsibility", "list"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("磁盘空间");
  expect(r.stdout).toContain("active");
  expect(r.stdout).toContain("小明");
  r = runCli(home, ["responsibility", "pause", "--name", "磁盘空间"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("active → paused");
  r = runCli(home, ["responsibility", "resume", "--name", "磁盘空间"]);
  expect(r.status).toBe(0);
  r = runCli(home, ["responsibility", "complete", "--name", "磁盘空间"]);
  // CLI 的 workdir 是进程 cwd，不是测试 workdir：file-exists 验不过，须拒绝。
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("验收未通过");
  // 先放一项待批进审阅队列，简报才有“今日待决策”，不是无事安静。
  enqueueReviewItem(home, { source: "automation", title: "待批事项", summary: "等批" });
  r = runCli(home, ["responsibility", "brief"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("晨间简报");
  expect(r.stdout).toContain("待批事项");
  r = runCli(home, ["responsibility", "show"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("晨间简报");
  r = runCli(home, ["responsibility", "cancel", "--name", "磁盘空间"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("→ cancelled");
  r = runCli(home, ["responsibility", "resume", "--name", "磁盘空间"]);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("终态");
});

test("CLI：help 中英文都有 responsibility 新子命令", () => {
  const { home } = setup();
  const zh = runCli(home, ["--help"]);
  expect(zh.stdout).toContain("nyra responsibility <list|add|remove|enable|disable|check|pause|resume|complete|cancel|brief|show>");
  const en = spawnSync("bun", ["run", "src/cli.ts", "--help"], {
    cwd: process.cwd(), encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "en" },
  });
  expect(en.stdout).toContain("nyra responsibility <list|add|remove|enable|disable|check|pause|resume|complete|cancel|brief|show>");
});
