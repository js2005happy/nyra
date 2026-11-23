// tests/node/test-knowledge-33b.test.ts — 缺口 33 第二批：知识库 RAG 做深。
//   - parent-child 分块（子块精确匹配、命中后返回父块 + 命中子块摘录）
//   - 确定性 rerank（覆盖率 + 标题命中）与 --no-rerank 对比
//   - 中文 PDF：十六进制串 + ToUnicode CMap（bfchar / bfrange）
//   - 向量检索未做（providers.ts 无 embeddings 通道，见 docs/knowledge.md）
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  KnowledgeBase, KnowledgeError, extractPdfText, parseToUnicodeCMap,
  rerankCandidates, chunkChildren, knowledgeMain,
} from "../../src/knowledge.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-kb33b-"));
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

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return { logs, restore: () => { process.stdout.write = orig; } };
}

// ---- 确定性 rerank ----

test("Knowledge33bTest.test_rerank_formula_exact", () => {
  const scores = rerankCandidates(["alpha", "beta", "gamma"], [
    { bm25: 10, title: "alpha beta", text: "alpha beta gamma" },
    { bm25: 10, title: "无", text: "alpha" },
  ]);
  // 全覆盖 + 标题命中：10 × (1 + 0.3 + 0.2) = 15；覆盖 1/3、无标题命中：10 × 1.1 = 11。
  expect(scores[0]).toBeCloseTo(15, 10);
  expect(scores[1]).toBeCloseTo(11, 10);
});

test("Knowledge33bTest.test_rerank_flips_order", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "alpha alpha alpha", "甲", "manual");
    kb.addText("docs", "alpha beta gamma delta", "alpha beta gamma", "manual");
    for (let i = 0; i < 6; i++) kb.addText("docs", "beta gamma delta", `填${i}`, "manual");
    const off = kb.searchWithOptions("docs", "alpha beta gamma delta", { rerank: false });
    expect(off[0][1].title).toBe("甲");
    const on = kb.searchWithOptions("docs", "alpha beta gamma delta", { rerank: true });
    expect(on[0][1].title).toBe("alpha beta gamma");
    expect(on[0][0]).toBeGreaterThan(on[1][0]);
  } finally { cleanup(home); }
});

test("Knowledge33bTest.test_no_rerank_cli_flag", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "alpha alpha alpha", "甲", "manual");
    kb.addText("docs", "alpha beta gamma delta", "alpha beta gamma", "manual");
    for (let i = 0; i < 6; i++) kb.addText("docs", "beta gamma delta", `填${i}`, "manual");
    const cap = captureStdout();
    try {
      expect(await knowledgeMain(["search", "docs", "alpha beta gamma delta", "--no-rerank"], kbBase(home))).toBe(0);
    } finally { cap.restore(); }
    const first = cap.logs.join("").split("\n").find((l) => l.includes("\t"));
    expect(first).toContain("甲");
    expect(() => kb.searchWithOptions("docs", "alpha", { rerank: "yes" as never })).toThrow(KnowledgeError);
  } finally { cleanup(home); }
});

// ---- parent-child 分块 ----

test("Knowledge33bTest.test_chunk_children_sentence_split", () => {
  expect(chunkChildren("短文本")).toEqual([]);
  const kids = chunkChildren("第一句。第二句！第三句？第四句；第五行\n第六句。".repeat(20));
  expect(kids.length).toBeGreaterThan(1);
  for (const k of kids) expect(k.length).toBeLessThanOrEqual(300);
});

test("Knowledge33bTest.test_parent_child_hit_returns_parent_with_excerpt", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const long = "工业机器人调试手册。".repeat(20) + "番茄炒蛋做法：先炒鸡蛋，再放番茄。".repeat(10);
    kb.addText("docs", `# 手册\n${long}`, "手册", "manual");
    const hits = kb.searchWithOptions("docs", "番茄炒蛋", {});
    expect(hits.length).toBe(1);
    expect(hits[0][1].title).toBe("手册");
    expect(hits[0][1].matchExcerpt).toContain("番茄炒蛋做法");
    expect(hits[0][1].text).toContain("工业机器人调试手册");
    const hits2 = kb.searchWithOptions("docs", "工业机器人调试", {});
    expect(hits2.length).toBe(1);
    expect(hits2[0][1].matchExcerpt).toContain("工业机器人调试手册");
  } finally { cleanup(home); }
});

test("Knowledge33bTest.test_parent_child_dedupes_same_parent", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    // 同一父块的两个子块都含“机器人”，归并后只返回一个父块结果。
    const long = "工业机器人调试规范。".repeat(25) + "机器人焊接工艺要求。".repeat(25);
    kb.addText("docs", `# 手册\n${long}`, "手册", "manual");
    kb.addText("docs", "番茄炒蛋需要先炒鸡蛋。", "烹饪", "manual");
    const hits = kb.searchWithOptions("docs", "机器人", { topK: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0][1].title).toBe("手册");
  } finally { cleanup(home); }
});

test("Knowledge33bTest.test_childless_parent_still_scored_and_counted_once", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    kb.addText("docs", "工业机器人用于汽车制造。", "短笔记", "manual");
    expect(kb.listBases()[0].notes).toBe(1);
    expect(kb.search("docs", "工业机器人", 5)[0][1].title).toBe("短笔记");
    const long = "工业机器人调试手册。".repeat(30);
    kb.addText("docs", `# 长\n${long}`, "长笔记", "manual");
    // 1 个父块 + 若干子块，条数仍只计父块。
    expect(kb.listBases()[0].notes).toBe(2);
  } finally { cleanup(home); }
});

test("Knowledge33bTest.test_old_base_without_children_still_searches", () => {
  const home = tempHome();
  try {
    const kb = new KnowledgeBase(kbBase(home));
    kb.create("docs", "老库");
    // 模拟第一批建的库：notes.jsonl 里只有父块，没有子块。
    const dir = join(kbBase(home), "docs");
    writeFileSync(join(dir, "notes.jsonl"), [
      JSON.stringify({ id: "a1", title: "机器人", source: "manual", date: "2026-11-20", text: "工业机器人用于汽车制造焊接。", created_at: "2026-11-20T00:00:00" }),
      JSON.stringify({ id: "a2", title: "烹饪", source: "manual", date: "2026-11-20", text: "番茄炒蛋需要先炒鸡蛋。", created_at: "2026-11-20T00:00:00" }),
      "",
    ].join("\n"));
    const hits = kb.searchWithOptions("docs", "工业机器人汽车制造", {});
    // 第二条笔记不含任何查询词，BM25 为 0 不返回；老库只有一条命中。
    expect(hits.length).toBe(1);
    expect(hits[0][1].title).toBe("机器人");
  } finally { cleanup(home); }
});

test("Knowledge33bTest.test_search_async_pool_path_with_children", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    for (let i = 0; i < 40; i++) {
      // 每篇约 440 字 → 1 父块 + 2 子块，40 篇共 120 条笔记，触发 worker 池路径。
      kb.addText("docs", `# 主题 ${i}\n${"工业机器人调试要点。".repeat(40)}`, `主题 ${i}`, "manual");
    }
    const sync = kb.searchWithOptions("docs", "工业机器人调试", { topK: 3 });
    const asyncRes = await kb.searchAsync("docs", "工业机器人调试", 3);
    expect(asyncRes.length).toBe(3);
    expect(asyncRes.map(([, n]) => n.title)).toEqual(sync.map(([, n]) => n.title));
    for (const [, n] of asyncRes) expect(n.kind).not.toBe("child");
    await kb.closePool();
  } finally { cleanup(home); }
});

// ---- 中文 PDF：ToUnicode CMap ----

/** 最小中文 PDF：Type0 字体 + ToUnicode CMap（bfchar），内容流用十六进制串。 */
function minimalCjkPdf(cmapBody: string, contentOps: string, flate = true): Buffer {
  const content = Buffer.from(`BT /F1 24 Tf 100 700 Td ${contentOps} ET`, "latin1");
  const stream = flate ? deflateSync(content) : content;
  const cmap = Buffer.from(
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    cmapBody +
    "endcmap\nend\nend\n",
    "latin1",
  );
  const cmapStream = flate ? deflateSync(cmap) : cmap;
  const head = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length " + String(stream.length) + (flate ? " /Filter /FlateDecode" : "") + " >>\nstream\n";
  const mid = "\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEE+SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>\nendobj\n6 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEE+SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> >>\nendobj\n7 0 obj\n<< /Length " + String(cmapStream.length) + (flate ? " /Filter /FlateDecode" : "") + " >>\nstream\n";
  const tail = "\nendstream\nendobj\n%%EOF\n";
  return Buffer.concat([Buffer.from(head, "latin1"), stream, Buffer.from(mid, "latin1"), cmapStream, Buffer.from(tail, "latin1")]);
}

const BFCHAR_BODY =
  "4 beginbfchar\n<0001> <4E2D>\n<0002> <6587>\n<0003> <6D4B>\n<0004> <8BD5>\nendbfchar\n";

test("Knowledge33bTest.test_parse_to_unicode_cmap_bfchar_and_bfrange", () => {
  const { map } = parseToUnicodeCMap(
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    "2 beginbfchar\n<0001> <4E2D>\n<0002> <6587>\nendbfchar\n" +
    "1 beginbfrange\n<0003> <0005> <6D4B>\nendbfrange\n" +
    "1 beginbfrange\n<0006> <0007> [<8BD5> <8BD6>]\nendbfrange\n",
  );
  expect(map.get(0x0001)).toBe("中");
  expect(map.get(0x0002)).toBe("文");
  expect(map.get(0x0003)).toBe("测");
  expect(map.get(0x0004)).toBe("浌"); // bfrange 单目标：6D4B + 1 = 6D4C
  expect(map.get(0x0005)).toBe("浍"); // 6D4B + 2 = 6D4D
  expect(map.get(0x0006)).toBe("试");
  expect(map.get(0x0007)).toBe("诖"); // 数组式 bfrange 第二项：8BD6
});

test("Knowledge33bTest.test_extract_pdf_chinese_via_tounicode", () => {
  const text = extractPdfText(minimalCjkPdf(BFCHAR_BODY, "<00010002> Tj 100 650 Td <00030004> Tj"));
  expect(text).toContain("中文");
  expect(text).toContain("测试");
});

test("Knowledge33bTest.test_extract_pdf_chinese_tj_array_mixed", () => {
  // TJ 数组里的元素直接就是串，不套括号：[<0001> 120 (Hello)] TJ。
  const text = extractPdfText(minimalCjkPdf(BFCHAR_BODY, "[<0001> 120 (Hello)] TJ"));
  expect(text).toContain("中");
  expect(text).toContain("Hello");
});

/** 最小拉丁 PDF：Type1 字体、无 ToUnicode（测“无 CMap 时十六进制串”的回退口径）。 */
function minimalLatinPdf(contentOps: string): Buffer {
  const content = Buffer.from(`BT /F1 24 Tf 100 700 Td ${contentOps} ET`, "latin1");
  const stream = deflateSync(content);
  const head = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length " + String(stream.length) + " /Filter /FlateDecode >>\nstream\n";
  const tail = "\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n%%EOF\n";
  return Buffer.concat([Buffer.from(head, "latin1"), stream, Buffer.from(tail, "latin1")]);
}

test("Knowledge33bTest.test_extract_pdf_hex_without_cmap", () => {
  // 无 CMap 的纯 ASCII 十六进制串可解；非 ASCII 十六进制串是字形编号，直接跳过不返回乱码。
  expect(extractPdfText(minimalLatinPdf("<48656C6C6F> Tj"))).toContain("Hello");
  expect(extractPdfText(minimalLatinPdf("<4E2D6587> Tj"))).toBe("");
});

test("Knowledge33bTest.test_add_pdf_chinese_end_to_end", () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const dir = mkdtempSync(join(tmpdir(), "nyra-kb33b-pdf-"));
    const pdfPath = join(dir, "manual.pdf");
    writeFileSync(pdfPath, minimalCjkPdf(BFCHAR_BODY, "<00010002> Tj 100 650 Td <00030004> Tj"));
    const notes = kb.addFile("docs", pdfPath);
    expect(notes.length).toBe(1);
    const hits = kb.search("docs", "中文测试", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0][1].title).toContain("manual.pdf");
    expect(hits[0][1].text).toContain("中文");
  } finally { cleanup(home); }
});

// ---- 工具与测试台用上命中片段 ----

test("Knowledge33bTest.test_knowledge_search_tool_uses_match_excerpt", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const long = "工业机器人调试手册。".repeat(20) + "番茄炒蛋做法：先炒鸡蛋，再放番茄。".repeat(10);
    kb.addText("docs", `# 手册\n${long}`, "手册", "manual");
    const ctx = newToolContext({ workdir: home, home, mode: "auto", interactive: true });
    const out = await executeTool("knowledge_search", { base: "docs", query: "番茄炒蛋" }, ctx);
    expect(out).toContain("手册");
    expect(out).toContain("番茄炒蛋做法：先炒鸡蛋");
    expect(out).toContain("检索记录已存入证据链");
  } finally { cleanup(home); }
});

test("Knowledge33bTest.test_bench_json_uses_match_excerpt", async () => {
  const home = tempHome();
  try {
    const kb = seedDocs(home);
    const long = "工业机器人调试手册。".repeat(20) + "番茄炒蛋做法：先炒鸡蛋，再放番茄。".repeat(10);
    kb.addText("docs", `# 手册\n${long}`, "手册", "manual");
    const qfile = join(home, "questions.txt");
    writeFileSync(qfile, "番茄炒蛋怎么做？\n");
    const cap = captureStdout();
    try {
      expect(await knowledgeMain(["test", "docs", "--file", qfile, "--json"], kbBase(home))).toBe(0);
    } finally { cap.restore(); }
    const parsed = JSON.parse(cap.logs.join(""));
    expect(parsed.questions[0].hits.length).toBeGreaterThan(0);
    expect(parsed.questions[0].hits[0].excerpt).toContain("番茄炒蛋做法");
  } finally { cleanup(home); }
});
