// tests/node/test-docs-bilingual.test.ts — 对外文档中英双语：每份中文文档都有英文版，顶部互相链接；
// 英文版里写死的事实（工具数量）跟代码对得上；README.en.md 指向英文文档；英文文档里的相对链接都能打开。
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOOL_SCHEMAS } from "../../src/tools.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf-8");

const PAIRS: [string, string][] = [
  ["GUIDE.md", "GUIDE.en.md"],
  ["docs/beta.md", "docs/beta.en.md"],
  ["docs/installers.md", "docs/installers.en.md"],
  ["docs/macos-install.md", "docs/macos-install.en.md"],
  ["docs/windows-install.md", "docs/windows-install.en.md"],
];

const base = (p: string) => p.split("/").pop()!;

test("每份中文文档都有英文版，顶部互相链接", () => {
  for (const [zh, en] of PAIRS) {
    expect({ en, exists: existsSync(join(ROOT, en)) }).toEqual({ en, exists: true });
    const zhTop = read(zh).split("\n").slice(0, 3).join("\n");
    const enTop = read(en).split("\n").slice(0, 3).join("\n");
    expect(zhTop).toContain(`[English](${base(en)})`);
    expect(enTop).toContain(`[中文](${base(zh)})`);
  }
});

test("GUIDE.en.md：工具数量等于 TOOL_SCHEMAS，快速开始在前 80 行内，章节数与中文版一致", () => {
  const guide = read("GUIDE.en.md");
  expect(guide).toContain(`Nyra has ${TOOL_SCHEMAS.length} built-in tools`);
  const lines = guide.split("\n");
  const at = lines.findIndex((l) => l.trim() === "## Quick start");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThan(80);
  const heads = (t: string) => t.split("\n").filter((l) => /^#{2,3} /.test(l)).length;
  expect(heads(guide)).toBe(heads(read("GUIDE.md")));
});

test("README.en.md 指向英文文档，不再把英文读者带到中文上手说明", () => {
  const readme = read("README.en.md");
  expect(readme).toContain("(docs/beta.en.md)");
  expect(readme).toContain("(GUIDE.en.md)");
  expect(readme).not.toContain("(docs/beta.md)");
});

test("英文文档里的相对链接都指向存在的文件", () => {
  const bad: string[] = [];
  for (const f of ["README.en.md", ...PAIRS.map((p) => p[1])]) {
    const text = read(f);
    for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(join(ROOT, dirname(f), target))) bad.push(`${f} → ${target}`);
    }
  }
  expect(bad).toEqual([]);
});
