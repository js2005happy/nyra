// tests/node/test-knowledge-33.test.ts — 缺口 33 第一批：外部文档知识库 RAG 管道。
//   - 检索参数面（TopK / 最低分 / 来源 / 日期范围）
//   - PDF 最小文本抽取（FlateDecode + 未压缩）与收录
//   - knowledge_search 工具（出处 + 证据链）
//   - nyra knowledge test 检索测试台
//   - knowledge_search 运行事件注册与时间线渲染
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  KnowledgeBase, KnowledgeError, extractPdfText, recordKnowledgeSearch, runKnowledgeTest,
  knowledgeMain, MAX_PDF_BYTES, type KnowledgeSearchOptions,
} from "../../src/knowledge.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { SUBCOMMANDS } from "../../src/subcommands.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-kb33-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function kbBase(home: string): string {
  return join(home, "knowledge");
}

function seedDocs(home: string): KnowledgeBase {
  const kb = new KnowledgeBase(kbBase(home));
  kb.create("docs", "测试库");
  return kb;
}

function makeRun(home: string): string {
  const store = new RunStore(join(home, "runs"));
  return store.create("知识库测试任务", "sess-1", home, "normal", 10).run_id;
}

function runEvents(home: string, runId: string): { type: string; [key: string]: unknown }[] {
  const store = new RunStore(join(home, "runs"));
  return store.readEvents(runId) as { type: string; [key: string]: unknown }[];
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return { logs, restore: () => { process.stdout.write = orig; } };
}

/** 最小手写 PDF：正文流里只有一行 (文本) Tj；flate=true 时流经 FlateDecode 压缩。 */
function minimalPdf(text: string, flate: boolean): Buffer {
  const content = Buffer.from(`BT /F1 24 Tf 100 700 Td (${text}) Tj ET`, "latin1");
  const stream = flate ? deflateSync(content) : content;
  const head = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length " + String(stream.length) + (flate ? " /Filter /FlateDecode" : "") + " >>\nstream\n";
  const tail = "\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n%%EOF\n";
  return Buffer.concat([Buffer.from(head, "latin1"), stream, Buffer.from(tail, "latin1")]);
}

// ---- 检索参数面 ----

test("Knowledge33Test.test_search_options_top_k", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    for (let i = 0; i < 4; i++) kb.addText("docs", `# 笔记 ${i}\n工业机器人调试内容 ${i} 汽车制造。`, `笔记 ${i}`, "manual");
    expect(kb.searchWithOptions("docs", "工业机器人调试", { topK: 2 }).length).toBe(2);
    expect(kb.searchWithOptions("docs", "工业机器人调试", { topK: 0 }).length).toBe(0);
    expect(kb.search("docs", "工业机器人调试", 1).length).toBe(1);
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_search_options_min_score", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造焊接调试。工业机器人汽车制造。", "机器人", "manual");
    kb.addText("docs", "# 烹饪\n番茄炒蛋需要先炒鸡蛋，工业机器人这个词只出现一次。", "烹饪", "manual");
    const all = kb.searchWithOptions("docs", "工业机器人汽车制造");
    expect(all.length).toBe(2);
    const mid = (all[0][0] + all[1][0]) / 2;
    const filtered = kb.searchWithOptions("docs", "工业机器人汽车制造", { minScore: mid });
    expect(filtered.length).toBe(1);
    expect(filtered[0][1].title).toContain("机器人");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_search_options_source_filter", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造。", "机器人", "handbook-a.md");
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造。", "机器人", "handbook-b.md");
    expect(kb.searchWithOptions("docs", "工业机器人", {}).length).toBe(2);
    const one = kb.searchWithOptions("docs", "工业机器人", { source: "handbook-a" });
    expect(one.length).toBe(1);
    expect(one[0][1].source).toContain("handbook-a");
    expect(kb.searchWithOptions("docs", "工业机器人", { source: "不存在的来源" }).length).toBe(0);
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_search_options_date_range", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 旧\n工业机器人旧版手册。", "旧", "manual", "2026-01-10");
    kb.addText("docs", "# 新\n工业机器人新版手册。", "新", "manual", "2026-11-20");
    expect(kb.searchWithOptions("docs", "工业机器人", { dateFrom: "2026-11-01" }).length).toBe(1);
    expect(kb.searchWithOptions("docs", "工业机器人", { dateTo: "2026-02-01" }).length).toBe(1);
    expect(kb.searchWithOptions("docs", "工业机器人", { dateFrom: "2026-06-01", dateTo: "2026-06-30" }).length).toBe(0);
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_search_options_bad_params_rejected", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造。", "机器人", "manual");
    expect(() => kb.searchWithOptions("docs", "工业机器人", { minScore: -1 })).toThrow(KnowledgeError);
    expect(() => kb.searchWithOptions("docs", "工业机器人", { topK: Number.NaN })).toThrow(KnowledgeError);
    expect(() => kb.searchWithOptions("docs", "工业机器人", { dateFrom: "2026-13-01" })).toThrow(KnowledgeError);
    expect(() => kb.searchWithOptions("docs", "工业机器人", { dateFrom: "2026-11-20", dateTo: "2026-01-01" })).toThrow(KnowledgeError);
  } finally { cleanup(home); }
});

// ---- PDF 最小文本抽取与收录 ----

test("Knowledge33Test.test_extract_pdf_uncompressed", () => {
  const text = extractPdfText(minimalPdf("Robot maintenance manual", false));
  expect(text).toContain("Robot maintenance manual");
});

test("Knowledge33Test.test_extract_pdf_flate", () => {
  const text = extractPdfText(minimalPdf("Robot maintenance manual", true));
  expect(text).toContain("Robot maintenance manual");
});

test("Knowledge33Test.test_extract_pdf_no_text_empty", () => {
  const buf = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 20 >>\nstream\n", "latin1"),
    Buffer.from("1 0 0 1 0 0 cm\n", "latin1"),
    Buffer.from("endstream\nendobj\n%%EOF\n", "latin1"),
  ]);
  expect(extractPdfText(buf)).toBe("");
});

test("Knowledge33Test.test_add_pdf_via_add_file", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const dir = mkdtempSync(join(tmpdir(), "nyra-kb33-pdf-"));
    const pdfPath = join(dir, "manual.pdf");
    writeFileSync(pdfPath, minimalPdf("Robot maintenance manual", true));
    const notes = kb.addFile("docs", pdfPath);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0].source).toBe(pdfPath);
    expect(kb.search("docs", "Robot maintenance", 5)[0][1].title).toContain("manual.pdf");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_add_dir_picks_up_pdf", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const dir = mkdtempSync(join(tmpdir(), "nyra-kb33-dir-"));
    writeFileSync(join(dir, "a.md"), "# A\nRobot maintenance content.");
    writeFileSync(join(dir, "b.pdf"), minimalPdf("Robot maintenance manual", false));
    writeFileSync(join(dir, "c.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const added = kb.addDir("docs", dir);
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(kb.search("docs", "Robot maintenance", 5).length).toBeGreaterThanOrEqual(2);
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_add_pdf_rejects_non_pdf", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const dir = mkdtempSync(join(tmpdir(), "nyra-kb33-bad-"));
    const badPath = join(dir, "fake.pdf");
    writeFileSync(badPath, "这根本不是 PDF");
    expect(() => kb.addFile("docs", badPath)).toThrow(KnowledgeError);
    expect(MAX_PDF_BYTES).toBe(20 * 1024 * 1024);
  } finally { cleanup(home); }
});

// ---- knowledge_search 工具 ----

test("Knowledge33Test.test_knowledge_search_tool_returns_citations_and_records_evidence", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造焊接。", "机器人", "handbook.md");
    const ctx = newToolContext({ workdir: home, home, mode: "auto", interactive: true });
    const out = await executeTool("knowledge_search", { base: "docs", query: "工业机器人汽车制造" }, ctx);
    expect(out).toContain("handbook.md");
    expect(out).toContain("分数");
    expect(out).toContain("检索记录已存入证据链");
    const evDir = join(home, "evidence", "knowledge");
    expect(existsSync(evDir)).toBe(true);
    const files = readdirSync(evDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    const body = readFileSync(join(evDir, files[0]), "utf-8");
    expect(body).toContain("handbook.md");
    expect(body).toContain("工业机器人汽车制造");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_knowledge_search_tool_empty_and_unknown_base", async () => {
  const home = tempHome();
  try {
    seedDocs(home);
    const ctx = newToolContext({ workdir: home, home, mode: "auto", interactive: true });
    expect(await executeTool("knowledge_search", { base: "docs", query: "火星殖民计划" }, ctx)).toContain("没有找到相关内容");
    expect(await executeTool("knowledge_search", { base: "nope", query: "工业机器人" }, ctx)).toContain("错误");
    expect(await executeTool("knowledge_search", { base: "docs", query: "" }, ctx)).toContain("错误");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_knowledge_search_tool_params", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造。", "机器人", "handbook-a.md", "2026-01-10");
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造。", "机器人", "handbook-b.md", "2026-11-20");
    const ctx = newToolContext({ workdir: home, home, mode: "auto", interactive: true });
    const bySource = await executeTool("knowledge_search", { base: "docs", query: "工业机器人", source: "handbook-b" }, ctx);
    expect(bySource).toContain("handbook-b.md");
    expect(bySource).not.toContain("handbook-a.md");
    const byDate = await executeTool("knowledge_search", { base: "docs", query: "工业机器人", date_from: "2026-11-01" }, ctx);
    expect(byDate).toContain("handbook-b.md");
    expect(byDate).not.toContain("handbook-a.md");
    const byTopK = await executeTool("knowledge_search", { base: "docs", query: "工业机器人", top_k: 1 }, ctx);
    expect(byTopK.match(/\[\d+\]/g)?.length).toBe(1);
  } finally { cleanup(home); }
});

// ---- 检索测试台 ----

test("Knowledge33Test.test_knowledge_test_bench_text_output", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造焊接。", "机器人", "manual");
    const qfile = join(home, "questions.txt");
    writeFileSync(qfile, "# 典型问题\n工业机器人用在哪？\n火星殖民计划\n");
    const cap = captureStdout();
    try {
      expect(await knowledgeMain(["test", "docs", "--file", qfile], kbBase(home))).toBe(0);
    } finally { cap.restore(); }
    const out = cap.logs.join("");
    expect(out).toContain("问题：工业机器人用在哪？");
    expect(out).toContain("火星殖民计划");
    expect(out).toContain("（无命中）");
    expect(out).toContain("汇总：共 2 个问题，1 个有命中");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_knowledge_test_bench_json_output", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造焊接。", "机器人", "manual");
    const qfile = join(home, "questions.txt");
    writeFileSync(qfile, "工业机器人用在哪？\n");
    const cap = captureStdout();
    try {
      expect(await knowledgeMain(["test", "docs", "--file", qfile, "--json"], kbBase(home))).toBe(0);
    } finally { cap.restore(); }
    const parsed = JSON.parse(cap.logs.join(""));
    expect(parsed.questions.length).toBe(1);
    expect(parsed.questions[0].hits.length).toBeGreaterThan(0);
    expect(parsed.questions[0].hits[0].source).toBe("manual");
    expect(parsed.summary).toEqual({ total: 1, hit: 1, avgTopScore: expect.any(Number) });
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_run_knowledge_test_pure", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "# 机器人\n工业机器人用于汽车制造。", "机器人", "manual");
    const opts: KnowledgeSearchOptions = { topK: 5 };
    const { results, hitCount, avgTopScore } = runKnowledgeTest(kb, "docs", ["工业机器人用在哪？", "火星殖民计划"], opts);
    expect(results.length).toBe(2);
    expect(hitCount).toBe(1);
    expect(avgTopScore).not.toBeNull();
    expect(avgTopScore!).toBeGreaterThan(0);
  } finally { cleanup(home); }
});

// ---- 事件注册与时间线 ----

test("Knowledge33Test.test_record_knowledge_search_events_channel", async () => {
  const home = tempHome();
  try {
    seedDocs(home);
    const runId = makeRun(home);
    const rec = await recordKnowledgeSearch(home, runId, { base: "docs", query: "工业机器人", hits: 1, topScore: 3.5 }, "知识库：docs\n问题：工业机器人");
    expect(rec.channel).toBe("events");
    const types = runEvents(home, runId).map((e) => e.type);
    expect(types).toContain("knowledge_search");
    const tl = buildTimeline(new RunStore(join(home, "runs")), runId);
    expect(formatTimelineText(tl)).toContain("知识库");
    expect(formatTimelineText(tl)).toContain("docs");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_record_knowledge_search_evidence_fallback", async () => {
  const home = tempHome();
  try {
    seedDocs(home);
    const rec = await recordKnowledgeSearch(home, null, { base: "docs", query: "工业机器人", hits: 2, topScore: 4.2 }, "知识库：docs\n问题：工业机器人\n命中：2 条");
    expect(rec.channel).toBe("evidence");
    expect(rec.path).toBeTruthy();
    const body = readFileSync(rec.path!, "utf-8");
    expect(body).toContain("工业机器人");
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_event_registered_in_event_fields", () => {
  const home = tempHome();
  try {
    const runId = makeRun(home);
    const store = new RunStore(join(home, "runs"));
    expect(() => store.appendEvent(runId, "knowledge_search", { base: "docs", query: "工业机器人", hits: 1, topScore: 2.5 })).not.toThrow();
  } finally { cleanup(home); }
});

test("Knowledge33Test.test_knowledge_alias_in_subcommands", () => {
  expect([...SUBCOMMANDS]).toContain("kb");
  expect([...SUBCOMMANDS]).toContain("knowledge");
});
