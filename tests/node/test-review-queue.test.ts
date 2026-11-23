// tests/node/test-review-queue.test.ts — 缺口 3b（review queue + 手机审批面）。
//
// 钉住的事：
//   - 队列入队/批复/拒绝/状态机（只允许 pending → approved/rejected → applied，
//     终态与非法转移抛错且状态原样不动——fail-closed）；
//   - 每一项批复进证据链（有运行目录时写 events.jsonl，否则写 evidence/review/）；
//   - 未批复不放行：apply 只接受 approved；异常不断状态；
//   - 并行结果进队（只进成功且有改动的线程，其余进 skipped）；定时任务结果进队；
//   - 轻量 verifier 只核对文件存在，并写清没验证什么；
//   - CLI（nyra review）与网关 API（/api/review）入口；
//   - 新事件类型已在 src/runs.ts 的 EVENT_FIELDS 注册（事件写得进去，不静默丢失）。
import { test, expect } from "bun:test";
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync,
  symlinkSync, rmSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  enqueueReviewItem, enqueueParallelResults, enqueueAutomationResults,
  listReviewItems, getReviewItem, decideReviewItem, verifyReviewItem,
  applyReviewItem, handleReview, reviewQueuePath, ReviewQueueError,
} from "../../src/reviewQueue.ts";
import { RunStore } from "../../src/runs.ts";
import { Agent } from "../../src/agent.ts";
import { fakeProvider } from "./fake-provider.ts";
import { Gateway } from "../../src/gateway.ts";
import type { ParallelDelegateResult } from "../../src/parallelDelegate.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-review-"));
}

function fakeParallelResult(): ParallelDelegateResult {
  return {
    results: [
      {
        index: 0, task: "修 A 模块拼写", status: "ok", summary: "改了 a.txt，未验证。",
        error: null, durationMs: 100, model: "fake-1",
        evidence: {
          changedFiles: ["a.txt"], diffStat: " a.txt | 2 +-\n 1 file changed",
          worktreePath: "/tmp/wt-0", verification: { status: "not-verified", note: "3a 不做自动验证" },
          spentUsd: 0.01,
        },
      },
      {
        index: 1, task: "调研 B", status: "ok", summary: "只调研，无改动。",
        error: null, durationMs: 50, model: "fake-1",
        evidence: {
          changedFiles: [], diffStat: null, worktreePath: null,
          verification: { status: "not-verified", note: "3a 不做自动验证" }, spentUsd: null,
        },
      },
      {
        index: 2, task: "修 C", status: "failed", summary: null,
        error: "子任务失败", durationMs: 80, model: "fake-1",
        evidence: {
          changedFiles: [], diffStat: null, worktreePath: null,
          verification: { status: "not-verified", note: "3a 不做自动验证" }, spentUsd: 0.005,
        },
      },
    ],
    succeeded: 2, failed: 1, timedOut: 0, rejected: 0,
    totalSpentUsd: 0.015, totalDurationMs: 230,
    maxConcurrency: 5, timeoutMs: 600000, maxConcurrencyClamped: false,
    reviewEnqueued: [], reviewEnqueueError: null,
  };
}

/** 捕获 stdout/stderr 调用 handleReview，返回 [code, stdout, stderr]。 */
async function runCli(home: string, argv: string[]): Promise<[number, string, string]> {
  let out = "";
  let err = "";
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { out += s; return true; }) as never;
  process.stderr.write = ((s: string) => { err += s; return true; }) as never;
  try {
    const code = await handleReview(argv, home);
    return [code, out, err];
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

// ---- 入队与校验 ----

test("ReviewQueue.test_enqueue_roundtrip", () => {
  const home = makeHome();
  const { item } = enqueueReviewItem(home, {
    source: "delegate", title: "改 a.txt", summary: "摘要",
    changedFiles: ["a.txt"], diffStat: " a.txt | 2 +-", spentUsd: 0.02,
  });
  expect(item.status).toBe("pending");
  expect(item.verification.status).toBe("not-verified");
  expect(item.verification.method).toBeNull();
  expect(item.verification.note).toContain("未经核实");
  expect(listReviewItems(home)).toHaveLength(1);
  expect(getReviewItem(home, item.id).title).toBe("改 a.txt");
  // 队列文件 0600（Windows 除外）。
  if (process.platform !== "win32") {
    expect(statSync(reviewQueuePath(home)).mode & 0o777).toBe(0o600);
  }
  expect(JSON.parse(readFileSync(reviewQueuePath(home), "utf-8")).version).toBe(1);
});

test("ReviewQueue.test_enqueue_validation", () => {
  const home = makeHome();
  expect(() => enqueueReviewItem(home, { source: "delegate", title: "" })).toThrow(ReviewQueueError);
  expect(() => enqueueReviewItem(home, { source: "other" as never, title: "x" })).toThrow(ReviewQueueError);
  expect(() => enqueueReviewItem(home, { source: "delegate", title: "x", changedFiles: ["/etc/passwd"] })).toThrow(ReviewQueueError);
  expect(() => enqueueReviewItem(home, { source: "delegate", title: "x", changedFiles: ["../escape.txt"] })).toThrow(ReviewQueueError);
  expect(() => enqueueReviewItem(home, { source: "delegate", title: "x", spentUsd: -1 })).toThrow(ReviewQueueError);
  expect(listReviewItems(home)).toHaveLength(0);
});

test("ReviewQueue.test_corrupt_queue_throws_not_silent_empty", () => {
  const home = makeHome();
  writeFileSync(reviewQueuePath(home), "{ 不是 json", "utf-8");
  expect(() => listReviewItems(home)).toThrow(ReviewQueueError);
});

test("ReviewQueue.test_queue_symlink_refused", () => {
  const home = makeHome();
  const target = join(home, "real.json");
  writeFileSync(target, JSON.stringify({ version: 1, items: [] }), "utf-8");
  symlinkSync(target, reviewQueuePath(home));
  expect(() => listReviewItems(home)).toThrow(ReviewQueueError);
});

// ---- 批复状态机（fail-closed） ----

test("ReviewQueue.test_decide_approve_reject_and_illegal_transitions", () => {
  const home = makeHome();
  const a = enqueueReviewItem(home, { source: "delegate", title: "甲" }).item;
  const b = enqueueReviewItem(home, { source: "delegate", title: "乙" }).item;
  const decided = decideReviewItem(home, a.id, "approved", { by: "cli", note: "看过 diff" });
  expect(decided.item.status).toBe("approved");
  expect(decided.item.decidedBy).toBe("cli");
  expect(decided.item.decisionNote).toBe("看过 diff");
  // 已批的不能再批：抛错且状态原样不动。
  expect(() => decideReviewItem(home, a.id, "rejected", { by: "cli" })).toThrow(ReviewQueueError);
  expect(getReviewItem(home, a.id).status).toBe("approved");
  expect(() => decideReviewItem(home, a.id, "approved", { by: "cli" })).toThrow(ReviewQueueError);
  const rej = decideReviewItem(home, b.id, "rejected", { by: "cli" });
  expect(rej.item.status).toBe("rejected");
  expect(() => decideReviewItem(home, b.id, "approved", { by: "cli" })).toThrow(ReviewQueueError);
  expect(getReviewItem(home, b.id).status).toBe("rejected");
  // 不存在的项与空批复人同样拒绝。
  expect(() => decideReviewItem(home, "0123456789abcdef", "approved", { by: "cli" })).toThrow(ReviewQueueError);
  expect(() => decideReviewItem(home, b.id, "approved", { by: "" })).toThrow(ReviewQueueError);
});

test("ReviewQueue.test_decide_requires_pending_list_order", () => {
  const home = makeHome();
  const a = enqueueReviewItem(home, { source: "delegate", title: "甲" }).item;
  enqueueReviewItem(home, { source: "delegate", title: "乙" });
  decideReviewItem(home, a.id, "approved", { by: "cli" });
  const pending = listReviewItems(home, "pending");
  expect(pending).toHaveLength(1);
  expect(pending[0].title).toBe("乙");
  // 默认列表待审在前。
  expect(listReviewItems(home)[0].status).toBe("pending");
});

// ---- 证据链 ----

test("ReviewQueue.test_decision_goes_to_events_jsonl_when_run_exists", () => {
  const home = makeHome();
  const store = new RunStore(join(home, "runs"));
  const run = store.create("任务", "20260101-000000-abcdef", process.cwd(), "auto", 5, "running");
  const { item } = enqueueReviewItem(home, {
    source: "parallel", title: "线程", runId: run.run_id, changedFiles: ["a.txt"], spentUsd: 0.01,
  });
  const decided = decideReviewItem(home, item.id, "approved", { by: "owner（本机）" });
  expect(decided.evidenceChannel).toBe("events");
  const events = readFileSync(join(home, "runs", run.run_id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const enqueued = events.find((e) => e.type === "review_enqueued");
  expect(enqueued).toBeDefined();
  expect(enqueued.item_id).toBe(item.id);
  expect(enqueued.source).toBe("parallel");
  expect(enqueued.spent_usd).toBe(0.01);
  const decision = events.find((e) => e.type === "review_decision");
  expect(decision).toBeDefined();
  expect(decision.decision).toBe("approved");
  expect(decision.decided_by).toBe("owner（本机）");
});

test("ReviewQueue.test_decision_falls_back_to_evidence_file_without_run", () => {
  const home = makeHome();
  const { item } = enqueueReviewItem(home, { source: "automation", title: "定时任务：巡查" });
  const decided = decideReviewItem(home, item.id, "rejected", { by: "device:我的手机" });
  expect(decided.evidenceChannel).toBe("evidence");
  const dir = join(home, "evidence", "review");
  expect(existsSync(dir)).toBe(true);
  const files = readdirSync(dir).filter((f: string) => f.includes("review_decision"));
  expect(files.length).toBeGreaterThan(0);
  const content = readFileSync(join(dir, files[0]), "utf-8");
  expect(content).toContain(item.id);
  expect(content).toContain("拒绝");
  expect(content).toContain("device:我的手机");
});

test("ReviewQueue.test_unknown_event_type_still_rejected_by_runstore", () => {
  // 新事件类型须在 EVENT_FIELDS 注册，否则 appendEvent 抛错导致事件静默丢失
  // （缺口 5 的教训）。这里直接验四个新类型都能写进 events.jsonl。
  const home = makeHome();
  const store = new RunStore(join(home, "runs"));
  const run = store.create("任务", "20260101-000000-abcdef", process.cwd(), "auto", 5, "running");
  for (const [type, fields] of [
    ["review_enqueued", { item_id: "0123456789abcdef", source: "parallel", spent_usd: 0.01 }],
    ["review_decision", { item_id: "0123456789abcdef", decision: "approved", decided_by: "cli", spent_usd: 0.01 }],
    ["review_verified", { item_id: "0123456789abcdef", status: "verified", method: "files-exist" }],
    ["review_applied", { item_id: "0123456789abcdef", files: "a.txt" }],
  ] as [string, Record<string, unknown>][]) {
    expect(() => store.appendEvent(run.run_id, type, fields)).not.toThrow();
  }
  const lines = readFileSync(join(home, "runs", run.run_id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean);
  // store.create 本身先写了一条 run_started，再加本批 4 条。
  expect(lines).toHaveLength(5);
  const types = lines.map((l) => JSON.parse(l).type);
  for (const t of ["review_enqueued", "review_decision", "review_verified", "review_applied"]) {
    expect(types).toContain(t);
  }
});

// ---- 轻量 verifier ----

test("ReviewQueue.test_verify_files_exist_pass_and_fail", async () => {
  const home = makeHome();
  const wt = mkdtempSync(join(tmpdir(), "nyra-wt-"));
  writeFileSync(join(wt, "a.txt"), "x", "utf-8");
  const ok = enqueueReviewItem(home, {
    source: "parallel", title: "有文件", worktreePath: wt,
    changedFiles: ["a.txt"], diffStat: " a.txt | 1 +",
  }).item;
  const verified = await verifyReviewItem(home, ok.id);
  expect(verified.item.verification.status).toBe("verified");
  expect(verified.item.verification.method).toBe("files-exist");
  // 写清没验证什么：不把“文件在”等同于“代码对”。
  expect(verified.item.verification.note).toContain("没跑测试");
  expect(verified.item.verification.note).toContain("没审代码语义");
  const bad = enqueueReviewItem(home, {
    source: "parallel", title: "缺文件", worktreePath: wt,
    changedFiles: ["missing.txt"], diffStat: " missing.txt | 1 +",
  }).item;
  const failed = await verifyReviewItem(home, bad.id);
  expect(failed.item.verification.status).toBe("failed");
  expect(failed.item.verification.note).toContain("missing.txt");
  // 验证本身也进证据链（无运行目录时走证据文件）。
  expect(verified.evidenceChannel).toBe("evidence");
});

test("ReviewQueue.test_verify_without_base_throws", async () => {
  const home = makeHome();
  const item = enqueueReviewItem(home, { source: "automation", title: "无处核对" }).item;
  await expect(verifyReviewItem(home, item.id)).rejects.toThrow(ReviewQueueError);
  expect(getReviewItem(home, item.id).verification.status).toBe("not-verified");
});

// ---- 应用（apply） ----

test("ReviewQueue.test_apply_copies_worktree_files_only_when_approved", () => {
  const home = makeHome();
  const wt = mkdtempSync(join(tmpdir(), "nyra-wt-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-wd-"));
  mkdirSync(join(wt, "sub"), { recursive: true });
  writeFileSync(join(wt, "sub", "new.txt"), "新内容\n", "utf-8");
  const item = enqueueReviewItem(home, {
    source: "parallel", title: "合并不", workdir: wd, worktreePath: wt,
    changedFiles: ["sub/new.txt"], diffStat: " sub/new.txt | 1 +",
  }).item;
  // pending 不能应用：fail-closed。
  expect(() => applyReviewItem(home, item.id)).toThrow(ReviewQueueError);
  expect(getReviewItem(home, item.id).status).toBe("pending");
  expect(existsSync(join(wd, "sub", "new.txt"))).toBe(false);
  decideReviewItem(home, item.id, "approved", { by: "cli" });
  const applied = applyReviewItem(home, item.id, { by: "cli" });
  expect(applied.item.status).toBe("applied");
  expect(applied.appliedFiles).toEqual(["sub/new.txt"]);
  expect(readFileSync(join(wd, "sub", "new.txt"), "utf-8")).toBe("新内容\n");
  expect(applied.evidenceChannel).toBe("evidence");
  // 已应用不能再应用。
  expect(() => applyReviewItem(home, item.id)).toThrow(ReviewQueueError);
});

test("ReviewQueue.test_apply_missing_file_keeps_approved", () => {
  const home = makeHome();
  const wt = mkdtempSync(join(tmpdir(), "nyra-wt-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-wd-"));
  writeFileSync(join(wt, "a.txt"), "a", "utf-8");
  const item = enqueueReviewItem(home, {
    source: "parallel", title: "缺一个", workdir: wd, worktreePath: wt,
    changedFiles: ["a.txt", "gone.txt"], diffStat: " 2 files changed",
  }).item;
  decideReviewItem(home, item.id, "approved", { by: "cli" });
  expect(() => applyReviewItem(home, item.id)).toThrow(ReviewQueueError);
  // 状态保持 approved（不把半成品记成 applied），错误里写清已拷好的文件。
  expect(getReviewItem(home, item.id).status).toBe("approved");
  expect(existsSync(join(wd, "a.txt"))).toBe(true);
});

test("ReviewQueue.test_apply_without_worktree_marks_applied", () => {
  const home = makeHome();
  const item = enqueueReviewItem(home, { source: "delegate", title: "原地改动" }).item;
  decideReviewItem(home, item.id, "approved", { by: "cli" });
  const applied = applyReviewItem(home, item.id);
  expect(applied.item.status).toBe("applied");
  expect(applied.item.appliedNote).toContain("无需合并");
});

// ---- 并行 / 定时结果进队 ----

test("ReviewQueue.test_enqueue_parallel_results_only_ok_with_changes", () => {
  const home = makeHome();
  const { enqueued, skipped } = enqueueParallelResults(home, fakeParallelResult(), { sessionId: "s1" });
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0].source).toBe("parallel");
  expect(enqueued[0].title).toContain("并行线程 1");
  expect(enqueued[0].changedFiles).toEqual(["a.txt"]);
  expect(enqueued[0].spentUsd).toBe(0.01);
  expect(enqueued[0].verification.status).toBe("not-verified");
  expect(enqueued[0].sessionId).toBe("s1");
  expect(skipped.map((s) => s.index)).toEqual([1, 2]);
  expect(listReviewItems(home)).toHaveLength(1);
});

test("ReviewQueue.test_enqueue_automation_results_only_ok", () => {
  const home = makeHome();
  const { enqueued, skipped } = enqueueAutomationResults(home, [
    { name: "巡查", status: "ok", summary: "一切正常" },
    { name: "坏的", status: "error", summary: "失败：超时" },
  ]);
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0].source).toBe("automation");
  expect(enqueued[0].sessionId).toBe("schedule-巡查");
  expect(enqueued[0].verification.note).toContain("未上报改动文件");
  expect(skipped.map((s) => s.name)).toEqual(["坏的"]);
});

// ---- delegateParallel opt-in 入队 ----

test("ReviewQueue.test_delegate_parallel_optin_enqueue", async () => {
  const repo = mkdtempSync(join(tmpdir(), "nyra-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "内容\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
  const home = makeHome();
  const makeWriter = () => fakeProvider([
    {
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "new.txt", content: "新文件\n" }) } }],
    },
    { content: "写完了。改了 new.txt，未验证。" },
  ]);
  const makeAgent = () => new Agent(makeWriter() as never, {
    workdir: repo, mode: "full", maxTurns: 2, interactive: false,
    home, sessionId: null, skillsDirs: [], checkpointStore: null,
  } as never);
  const agent = makeAgent();
  const worktrees: string[] = [];
  try {
    // 默认不入队（自动行为必须 opt-in）。
    const plain = await agent.delegateParallel([{ task: "新建 new.txt", isolation: "worktree" }]);
    expect(plain.reviewEnqueued).toEqual([]);
    expect(listReviewItems(home)).toHaveLength(0);
    if (plain.results[0]?.evidence.worktreePath) worktrees.push(plain.results[0].evidence.worktreePath);
    // opt-in 入队：成功且有改动的线程进队（脚本式 provider 每测要一个新的）。
    const queued = await makeAgent().delegateParallel(
      [{ task: "新建 new.txt", isolation: "worktree" }],
      { enqueueReview: true },
    );
    expect(queued.reviewEnqueued).toHaveLength(1);
    expect(queued.reviewEnqueueError).toBeNull();
    if (queued.results[0]?.evidence.worktreePath) worktrees.push(queued.results[0].evidence.worktreePath);
    const items = listReviewItems(home);
    expect(items).toHaveLength(1);
    expect(items[0].changedFiles).toContain("new.txt");
    expect(items[0].verification.status).toBe("not-verified");
  } finally {
    for (const wt of worktrees) {
      spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: repo });
      rmSync(wt, { recursive: true, force: true });
    }
  }
});

// ---- 与 #79 合并时的语义冲突回归 ----

test("ReviewQueue.test_format_tolerates_result_without_review_fields", async () => {
  // #79 的测试用手写 ParallelDelegateResult 字面量（没有 3b 的 reviewEnqueued /
  // reviewEnqueueError 字段）调 formatParallelResults；合并后这里曾抛
  // TypeError（undefined.length）。格式化函数必须容忍缺新字段的结果。
  const { formatParallelResults } = await import("../../src/parallelDelegate.ts");
  const legacy = {
    results: [],
    succeeded: 0, failed: 0, timedOut: 1, rejected: 0,
    totalSpentUsd: 0.05, totalDurationMs: 100,
    maxConcurrency: 5, timeoutMs: 600000, maxConcurrencyClamped: false,
    pendingAfterTimeout: 1,
  } as never;
  const text = formatParallelResults(legacy);
  expect(text).toContain("≥$0.0500");
  expect(text).not.toContain("已进审阅队列");
});

// ---- CLI ----

test("ReviewQueue.test_cli_list_show_approve_reject_apply", async () => {
  const home = makeHome();
  const [c0] = await runCli(home, ["list"]);
  expect(c0).toBe(0);
  const [, out1] = await runCli(home, ["enqueue", "--title", "CLI 入队", "--files", "a.txt,b.txt", "--spent", "0.03"]);
  expect(out1).toContain("已入队");
  const item = listReviewItems(home)[0];
  const [c2, out2] = await runCli(home, ["show", item.id]);
  expect(c2).toBe(0);
  expect(out2).toContain("CLI 入队");
  expect(out2).toContain("未经核实");
  const [c3] = await runCli(home, ["approve", item.id, "--by", "tester"]);
  expect(c3).toBe(0);
  expect(getReviewItem(home, item.id).status).toBe("approved");
  const [c4] = await runCli(home, ["apply", item.id]);
  expect(c4).toBe(0);
  expect(getReviewItem(home, item.id).status).toBe("applied");
  // 非法转移：CLI 回 1，状态不动。
  const [c5, , err5] = await runCli(home, ["approve", item.id]);
  expect(c5).toBe(1);
  expect(err5).toContain("错误");
  expect(getReviewItem(home, item.id).status).toBe("applied");
  // 用法错回 2。
  const [c6] = await runCli(home, ["approve"]);
  expect(c6).toBe(2);
  const [c7] = await runCli(home, ["bogus"]);
  expect(c7).toBe(2);
});

test("ReviewQueue.test_cli_json_output", async () => {
  const home = makeHome();
  enqueueReviewItem(home, { source: "delegate", title: "JSON 项" });
  const [code, out] = await runCli(home, ["list", "--json"]);
  expect(code).toBe(0);
  const parsed = JSON.parse(out) as { items: { title: string }[] };
  expect(parsed.items).toHaveLength(1);
  expect(parsed.items[0].title).toBe("JSON 项");
});

// ---- 网关 API（PWA 消费） ----

test("ReviewQueue.test_gateway_api_decide_apply_verify", async () => {
  const home = makeHome();
  const wt = mkdtempSync(join(tmpdir(), "nyra-wt-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-wd-"));
  writeFileSync(join(wt, "a.txt"), "a", "utf-8");
  const item = enqueueReviewItem(home, {
    source: "parallel", title: "网关项", workdir: wd, worktreePath: wt,
    changedFiles: ["a.txt"], diffStat: " a.txt | 1 +", spentUsd: 0.02,
  }).item;
  const gw = new Gateway({ home, workdir: wd, host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const owner = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    // 未带 token 拒绝。
    const noAuth = await fetch(`${base}/api/review`);
    expect(noAuth.status).toBe(403);
    const list = await fetch(`${base}/api/review`, { headers: owner });
    expect(list.status).toBe(200);
    const listed = await list.json() as { items: { id: string }[] };
    expect(listed.items).toHaveLength(1);
    const one = await fetch(`${base}/api/review/${item.id}`, { headers: owner });
    expect(one.status).toBe(200);
    const badId = await fetch(`${base}/api/review/zzz`, { headers: owner });
    expect(badId.status).toBe(400);
    // 轻量验证通过。
    const verify = await fetch(`${base}/api/review/${item.id}/verify`, { method: "POST", headers: owner, body: "{}" });
    expect(verify.status).toBe(200);
    const verified = await verify.json() as { item: { verification: { status: string } } };
    expect(verified.item.verification.status).toBe("verified");
    // 手机批复：批准。
    const decide = await fetch(`${base}/api/review/${item.id}/decide`, {
      method: "POST", headers: owner, body: JSON.stringify({ approve: true, note: "手机上看过" }),
    });
    expect(decide.status).toBe(200);
    const decided = await decide.json() as { item: { status: string; decidedBy: string } };
    expect(decided.item.status).toBe("approved");
    expect(decided.item.decidedBy).toContain("本机");
    // 再批一次：400，状态不动（fail-closed）。
    const again = await fetch(`${base}/api/review/${item.id}/decide`, {
      method: "POST", headers: owner, body: JSON.stringify({ approve: false }),
    });
    expect(again.status).toBe(400);
    // 应用：worktree 文件拷回。
    const apply = await fetch(`${base}/api/review/${item.id}/apply`, { method: "POST", headers: owner, body: "{}" });
    expect(apply.status).toBe(200);
    expect(readFileSync(join(wd, "a.txt"), "utf-8")).toBe("a");
    expect(getReviewItem(home, item.id).status).toBe("applied");
    // 批复进了证据链（无运行目录 → evidence/review/）。
    const dir = join(home, "evidence", "review");
    const decisionFiles = readdirSync(dir).filter((f: string) => f.includes("review_decision"));
    expect(decisionFiles.length).toBeGreaterThan(0);
  } finally {
    await gw.stop();
  }
});

test("ReviewQueue.test_gateway_api_missing_item_404", async () => {
  const home = makeHome();
  const gw = new Gateway({ home, workdir: home, host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const owner = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const res = await fetch(`${base}/api/review/0123456789abcdef/decide`, {
      method: "POST", headers: owner, body: JSON.stringify({ approve: true }),
    });
    expect(res.status).toBe(404);
    // 缺 approve 字段是请求本身无效（400），与“项不存在”（404）区分开。
    const noApprove = await fetch(`${base}/api/review/0123456789abcdef/decide`, {
      method: "POST", headers: owner, body: JSON.stringify({}),
    });
    expect(noApprove.status).toBe(400);
  } finally {
    await gw.stop();
  }
});

// ---- PWA 页面含审阅标签页 ----

test("ReviewQueue.test_mobile_page_has_review_tab", async () => {
  const home = makeHome();
  const gw = new Gateway({ home, workdir: home, host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const page = await fetch(`http://127.0.0.1:${info.port}/m`);
    expect(page.status).toBe(200);
    const html = await page.text();
    // v14：审阅与审批合并成“待你决定”标签页（inbox-view）。
    expect(html).toContain("inbox-view");
    expect(html).toContain("m.tab.inbox");
    expect(html).toContain("review-approve");
  } finally {
    await gw.stop();
  }
});
