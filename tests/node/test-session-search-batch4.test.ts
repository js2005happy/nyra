// tests/node/test-session-search-batch4.test.ts — G-P1-14 会话全文搜索。
//   - 按会话分组（每会话摘录上限 3 条、命中附上文下文）
//   - scope=project 按工作目录过滤；本批之前记的消息（无 working_dir）只进 scope=all
//   - session / after / before 过滤；中文二字短词走 LIKE 兜底
//   - neighbors 上下文；meta 标题与工作目录随 record 记入；分叉继承元数据
//   - 导出 Markdown（全文按序、头部元数据）；sanitizeForModel 脱敏
//   - 联合会话准入闸（未准入的外来成员拒绝，本机会话放行）
//   - session_search 工具（命中 + 证据链 + 空 query 列会话 + scope=project）
//   - session_searched / session_exported 事件注册与时间线渲染
//   - nyra search CLI 冒烟（子进程跑真 CLI，不调模型）
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../src/conversations.ts";
import {
  assertSessionAdmitted, exportSessionMarkdown, formatSessionSearchResults,
  recordSessionExport, recordSessionSearch, sanitizeForModel, searchSessions,
} from "../../src/sessionSearch.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { SUBCOMMANDS } from "../../src/subcommands.ts";

const T0 = 1700000000;

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-search4-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

interface Seed {
  store: ConversationStore;
  projA: string;
  projB: string;
  ids: Record<string, number>;
}

function seed(home: string, projA: string, projB: string): Seed {
  const store = new ConversationStore(home);
  const ids: Record<string, number> = {};
  ids.a1 = store.record("sess-a", "user", "工业机器人调试遇到转速不稳的问题", null, T0, { workingDir: projA });
  ids.a2 = store.record("sess-a", "assistant", "先检查伺服驱动器参数", null, T0 + 10, { workingDir: projA });
  ids.a3 = store.record("sess-a", "user", "机器人调试第二步：校准零点", null, T0 + 20, { workingDir: projA });
  ids.a4 = store.record("sess-a", "assistant", "机器人调试第三步：跑一遍示教程序", null, T0 + 30, { workingDir: projA });
  ids.a5 = store.record("sess-a", "user", "机器人调试第四步：复查扭矩", null, T0 + 40, { workingDir: projA });
  ids.a6 = store.record("sess-a", "assistant", "收尾：写一份机器人调试记录", null, T0 + 50, { workingDir: projA });
  store.record("sess-b", "user", "工业机器人调试的另一个项目", null, T0 + 1000, { workingDir: projB });
  store.record("sess-b", "assistant", "这里也谈机器人调试", null, T0 + 1010, { workingDir: projB });
  store.record("sess-b", "assistant", "汽车制造产线停机了", null, T0 + 1020, { workingDir: projB });
  // 本批之前记的消息：没有 working_dir，只进 scope=all。
  store.record("sess-old", "user", "机器人调试老会话", null, T0 + 2000);
  return { store, projA, projB, ids };
}

function makeRun(home: string): string {
  const store = new RunStore(join(home, "runs"));
  return store.create("会话搜索测试任务", "sess-a", home, "normal", 10).run_id;
}

function runEvents(home: string, runId: string): { type: string; [key: string]: unknown }[] {
  const store = new RunStore(join(home, "runs"));
  return store.readEvents(runId) as { type: string; [key: string]: unknown }[];
}

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(argv: string[], home: string, workdir: string): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv, "--workdir", workdir],
    env: { ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0" },
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

test("SessionSearchBatch4.test_search_groups_by_session_and_caps_snippets", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const out = await searchSessions(home, { query: "机器人调试", scope: "all", limit: 5 });
    expect(out.total_sessions).toBe(3);
    expect(out.total_matches).toBe(6);
    const a = out.results.find((r) => r.session_id === "sess-a");
    expect(a).toBeDefined();
    // sess-a 有 5 条命中，每会话最多留 3 条摘录。
    expect(a!.hits.length).toBe(3);
    expect(a!.message_count).toBe(6);
    // 命中附上文下文：第二步那条，上文是伺服驱动器，下文是第三步。
    const second = a!.hits.find((h) => h.snippet.includes("第二步"));
    expect(second).toBeDefined();
    expect(second!.context_before).toContain("伺服驱动器");
    expect(second!.context_after).toContain("第三步");
    // 按 last_at 倒序：最晚的 sess-old 在最前。
    expect(out.results[0].session_id).toBe("sess-old");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_scope_project_filters_by_working_dir", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const proj = await searchSessions(home, { query: "机器人调试", scope: "project", projectDir: projA, limit: 5 });
    expect(proj.results.map((r) => r.session_id)).toEqual(["sess-a"]);
    const other = await searchSessions(home, { query: "机器人调试", scope: "project", projectDir: projB, limit: 5 });
    expect(other.results.map((r) => r.session_id)).toEqual(["sess-b"]);
    const all = await searchSessions(home, { query: "机器人调试", scope: "all", limit: 5 });
    expect(all.total_sessions).toBe(3);
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_old_session_without_working_dir_only_in_all", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const proj = await searchSessions(home, { query: "机器人调试老会话", scope: "project", projectDir: projA, limit: 5 });
    expect(proj.results.length).toBe(0);
    const all = await searchSessions(home, { query: "机器人调试老会话", scope: "all", limit: 5 });
    expect(all.results.map((r) => r.session_id)).toEqual(["sess-old"]);
    // 无关键词列会话时也一样：project 里看不到老会话。
    const listed = await searchSessions(home, { query: null, scope: "project", projectDir: projA, limit: 5 });
    expect(listed.results.map((r) => r.session_id)).toEqual(["sess-a"]);
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_session_and_time_filters", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const one = await searchSessions(home, { query: "机器人调试", scope: "all", sessionId: "sess-a", limit: 5 });
    expect(one.results.map((r) => r.session_id)).toEqual(["sess-a"]);
    const after = await searchSessions(home, { query: "机器人调试", scope: "all", after: T0 + 100, limit: 5 });
    expect(after.results.map((r) => r.session_id).sort()).toEqual(["sess-b", "sess-old"]);
    const before = await searchSessions(home, { query: "机器人调试", scope: "all", before: T0 + 100, limit: 5 });
    expect(before.results.map((r) => r.session_id)).toEqual(["sess-a"]);
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_short_chinese_token_falls_back_to_like", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    // “汽车”只有两个字，低于 FTS5 最小 3 字符，走 LIKE 兜底，仍能搜到。
    const out = await searchSessions(home, { query: "汽车", scope: "all", limit: 5 });
    expect(out.total_sessions).toBe(1);
    expect(out.results[0].session_id).toBe("sess-b");
    expect(out.results[0].hits[0].snippet).toContain("汽车制造产线停机了");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_neighbors_context", () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store, ids } = seed(home, projA, projB);
  try {
    const nb = store.neighbors("sess-a", ids.a3);
    expect(nb.before?.text).toContain("伺服驱动器");
    expect(nb.after?.text).toContain("第三步");
    const head = store.neighbors("sess-a", ids.a1);
    expect(head.before).toBeNull();
    expect(head.after?.text).toContain("伺服驱动器");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_meta_title_and_working_dir_recorded", () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    // 标题取首条用户消息，工作目录随 record 记入；已有标题不再改写。
    const meta = store.getSessionMeta("sess-a");
    expect(meta?.working_dir).toBe(projA);
    expect(meta?.title).toBe("工业机器人调试遇到转速不稳的问题");
    const listed = store.sessions().find((s) => s.session_id === "sess-a");
    expect(listed?.working_dir).toBe(projA);
    expect(listed?.title).toBe("工业机器人调试遇到转速不稳的问题");
    expect(listed?.count).toBe(6);
    // 没有 working_dir 的老会话：working_dir 与 title 仍有（标题有，目录没有）。
    expect(store.getSessionMeta("sess-old")?.working_dir).toBeNull();
    expect(store.getSessionMeta("sess-old")?.title).toBe("机器人调试老会话");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_copy_up_to_inherits_meta", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store, ids } = seed(home, projA, projB);
  try {
    const n = store.copyUpTo("sess-a", ids.a4, "sess-a-fork");
    expect(n).toBe(4);
    const meta = store.getSessionMeta("sess-a-fork");
    expect(meta?.working_dir).toBe(projA);
    expect(meta?.title).toBe("工业机器人调试遇到转速不稳的问题");
    // 分叉的新会话在 scope=project 里也能搜到。
    const out = await searchSessions(home, { query: "机器人调试", scope: "project", projectDir: projA, limit: 5 });
    expect(out.results.map((r) => r.session_id).sort()).toEqual(["sess-a", "sess-a-fork"]);
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_export_markdown_full_text_in_order", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const outPath = join(home, "exports", "sess-a.md");
    const done = await exportSessionMarkdown(home, "sess-a", outPath);
    expect(done.messages).toBe(6);
    expect(done.path).toBe(outPath);
    const body = readFileSync(outPath, "utf-8");
    expect(body).toContain("# 会话 sess-a");
    expect(body).toContain(`- 工作目录：${projA}`);
    expect(body).toContain("- 消息数：6");
    expect(body.indexOf("转速不稳")).toBeLessThan(body.indexOf("第二步"));
    expect(body.indexOf("第二步")).toBeLessThan(body.indexOf("收尾"));
    await expect(exportSessionMarkdown(home, "sess-missing", join(home, "no.md"))).rejects.toThrow("没有消息可导出");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_sanitize_masks_long_token_and_sk", () => {
  const long = "aGVsbG9Xb3JsZEhlbGxvV29ybGRIZWxsb1dvcmxk123456";
  const dirty = `密钥是 sk-abc123xyz456，还有一串 ${long}，以及 Bearer abcdefgh`;
  const clean = sanitizeForModel(dirty);
  expect(clean).not.toContain("sk-abc123xyz456");
  expect(clean).not.toContain(long);
  expect(clean).not.toContain("Bearer abcdefgh");
  expect(clean).toContain("[已隐藏]");
  // 普通文本不动。
  expect(sanitizeForModel("机器人调试遇到转速不稳")).toBe("机器人调试遇到转速不稳");
  // 工具返回里脱敏后的摘录仍可读：标题与普通词保留。
  const out = formatSessionSearchResults({
    results: [{ session_id: "sess-a", title: "机器人调试", working_dir: null, message_count: 1, last_at: T0, hits: [{ message_id: 1, role: "user", snippet: `密钥 ${long}`, created_at: T0, context_before: null, context_after: null }] }],
    total_matches: 1,
    total_sessions: 1,
  }, { forModel: true });
  expect(out).not.toContain(long);
  expect(out).toContain("[已隐藏]");
});

test("SessionSearchBatch4.test_joint_session_gate_rejects_unadmitted_friend", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    writeFileSync(join(home, "sessions.json"), JSON.stringify({
      sessions: [{ id: "sess-joint", members: [{ identity: "alice", kind: "friend", left_at: null }] }],
    }), "utf-8");
    await expect(assertSessionAdmitted(home, "sess-joint")).rejects.toThrow("准入闸");
    await expect(searchSessions(home, { query: "机器人调试", scope: "all", sessionId: "sess-joint", limit: 5 })).rejects.toThrow("准入闸");
    await expect(exportSessionMarkdown(home, "sess-joint", join(home, "joint.md"))).rejects.toThrow("准入闸");
    // 本机会话（账本里没有）放行。
    await assertSessionAdmitted(home, "sess-a");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_session_search_tool", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const ctx = newToolContext({ workdir: projA, home, mode: "auto", interactive: true });
    const out = await executeTool("session_search", { query: "机器人调试", scope: "all" }, ctx);
    expect(out).toContain("找到 6 条命中，分属 3 个会话");
    expect(out).toContain("sess-a");
    expect(out).toContain("检索记录已存入证据链");
    const evDir = join(home, "evidence", "session-search");
    expect(existsSync(evDir)).toBe(true);
    const files = readdirSync(evDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    expect(readFileSync(join(evDir, files[0]), "utf-8")).toContain("机器人调试");
    // 空 query 列会话；scope=project 时只认 ctx.workdir 下的会话。
    const listed = await executeTool("session_search", { scope: "all" }, ctx);
    expect(listed).toContain("sess-a");
    expect(listed).toContain("sess-b");
    const proj = await executeTool("session_search", { query: "机器人调试", scope: "project" }, ctx);
    expect(proj).toContain("sess-a");
    expect(proj).not.toContain("sess-b");
    expect(proj).not.toContain("sess-old");
    expect(await executeTool("session_search", { query: "火星殖民计划", scope: "all" }, ctx)).toContain("没有找到相关会话");
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_record_session_search_dual_channel", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    const ev = await recordSessionSearch(home, null, { scope: "all", query: "机器人调试", hits: 6, sessions: 3 }, "找到 6 条命中");
    expect(ev.channel).toBe("evidence");
    expect(ev.path).toBeDefined();
    expect(existsSync(ev.path!)).toBe(true);
    const runId = makeRun(home);
    const run = await recordSessionSearch(home, runId, { scope: "project", query: "机器人调试", hits: 3, sessions: 1 }, "找到 3 条命中");
    expect(run.channel).toBe("events");
    const events = runEvents(home, runId);
    expect(events.some((e) => e.type === "session_searched")).toBe(true);
    const hit = events.find((e) => e.type === "session_searched")!;
    expect(hit.scope).toBe("project");
    expect(hit.hits).toBe(3);
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_record_session_export_dual_channel", async () => {
  const home = tempHome();
  const projA = mkdtempSync(join(tmpdir(), "nyra-search4-proja-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, projA, projB);
  try {
    // 无运行上下文：写 evidence/session-search/ 证据文件。
    const ev = await recordSessionExport(home, null, { session_id: "sess-a", messages: 6 }, "会话 sess-a 已导出（6 条消息）");
    expect(ev.channel).toBe("evidence");
    expect(ev.path).toBeDefined();
    expect(existsSync(ev.path!)).toBe(true);
    expect(readFileSync(ev.path!, "utf-8")).toContain("sess-a");
    // 有运行：写 events.jsonl。
    const runId = makeRun(home);
    const run = await recordSessionExport(home, runId, { session_id: "sess-a", messages: 6 }, "会话 sess-a 已导出（6 条消息）");
    expect(run.channel).toBe("events");
    const events = runEvents(home, runId);
    expect(events.some((e) => e.type === "session_exported")).toBe(true);
    expect(events.find((e) => e.type === "session_exported")!.messages).toBe(6);
  } finally { store.close(); cleanup(home); rmSync(projA, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});

test("SessionSearchBatch4.test_events_registered_and_timeline_renders", () => {
  const home = tempHome();
  try {
    const runId = makeRun(home);
    const store = new RunStore(join(home, "runs"));
    expect(() => store.appendEvent(runId, "session_searched", { scope: "all", query: "机器人调试", hits: 6, sessions: 3 })).not.toThrow();
    expect(() => store.appendEvent(runId, "session_exported", { session_id: "sess-a", messages: 6 })).not.toThrow();
    const events = runEvents(home, runId);
    expect(events.filter((e) => e.type === "session_searched").length).toBe(1);
    expect(events.filter((e) => e.type === "session_exported").length).toBe(1);
    const tl = buildTimeline(new RunStore(join(home, "runs")), runId);
    const text = formatTimelineText(tl);
    expect(text).toContain("会话搜索");
    expect(text).toContain("已导出");
  } finally { cleanup(home); }
});

test("SessionSearchBatch4.test_subcommand_registered", () => {
  expect((SUBCOMMANDS as readonly string[]).includes("search")).toBe(true);
});

test("SessionSearchBatch4.test_cli_smoke", async () => {
  const home = tempHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-search4-cliwd-"));
  const projB = mkdtempSync(join(tmpdir(), "nyra-search4-projb-"));
  const { store } = seed(home, workdir, projB);
  try {
    store.close();
    // 默认 scope=project：只搜 --workdir 下记的会话。
    const proj = await runCli(["search", "机器人调试"], home, workdir);
    expect(proj.code).toBe(0);
    expect(proj.stdout).toContain("sess-a");
    expect(proj.stdout).not.toContain("sess-b");
    // scope=all：三个会话都回。
    const all = await runCli(["search", "机器人调试", "--scope", "all"], home, workdir);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("分属 3 个会话");
    // 不给关键词：列出最近会话。
    const list = await runCli(["search"], home, workdir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("sess-a");
    // --export + --session：导出指定的会话全文。
    const outPath = join(home, "exports", "cli-sess-a.md");
    const exp = await runCli(["search", "机器人调试", "--scope", "all", "--session", "sess-a", "--export", outPath], home, workdir);
    expect(exp.code).toBe(0);
    expect(exp.stdout).toContain("已导出会话 sess-a");
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf-8")).toContain("机器人调试第二步");
    // 不给 --session 时导出命中的第一个会话（按 last_at 倒序，最晚的是 sess-old）。
    const outPath2 = join(home, "exports", "cli-first.md");
    const exp2 = await runCli(["search", "机器人调试", "--scope", "all", "--export", outPath2], home, workdir);
    expect(exp2.code).toBe(0);
    expect(exp2.stdout).toContain("已导出会话 sess-old");
    expect(readFileSync(outPath2, "utf-8")).toContain("机器人调试老会话");
    // 两次导出都进了证据链（evidence/session-search/ 下两个 session_export 记录）。
    const evFiles = readdirSync(join(home, "evidence", "session-search")).filter((f) => f.includes("session_export"));
    expect(evFiles.length).toBe(2);
    // --json 与不认的 scope。
    const js = await runCli(["search", "机器人调试", "--scope", "all", "--json"], home, workdir);
    expect(js.code).toBe(0);
    expect(JSON.parse(js.stdout).total_sessions).toBe(3);
    const bad = await runCli(["search", "机器人调试", "--scope", "nope"], home, workdir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--scope 只认 project 或 all");
    const badDate = await runCli(["search", "机器人调试", "--after", "不是日期"], home, workdir);
    expect(badDate.code).toBe(1);
    expect(badDate.stderr).toContain("解析不出来");
  } finally { cleanup(home); rmSync(workdir, { recursive: true, force: true }); rmSync(projB, { recursive: true, force: true }); }
});
