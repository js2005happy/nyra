// tests/node/test-site-internal-docs.test.ts — 内部资料不得出现在公开站点上。
//
// docs/ 由 GitHub Pages 直接发布（js2005happy.github.io/nyra/，带 .nojekyll，
// 无构建步骤过滤）。COMPETITIVE-RESEARCH.md、COMPETITOR-SETTINGS.md 与
// docs/design/（约 80MB 设计稿）曾经随 docs/ 一起发布，任何人都能直接访问。
// 2026-11-24 已从仓库发布路径移出（内容留在 git 历史里，不删历史）。
// 这里锁死两点：路径不存在、站内页面不再链接或提到它们。
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");

const REMOVED_PATHS = [
  "docs/COMPETITIVE-RESEARCH.md",
  "docs/COMPETITOR-SETTINGS.md",
  "docs/design",
];

const FORBIDDEN_MARKERS = [
  "COMPETITIVE-RESEARCH",
  "COMPETITOR-SETTINGS",
  "docs/design",
];

/** 站内页面：docs/ 下的 md 与 html；CHANGELOG.md 是历史记录，豁免。 */
function sitePages(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".md") && !e.name.endsWith(".html")) continue;
      const rel = p.slice(ROOT.length + 1).replace(/\\/g, "/");
      if (rel === "docs/CHANGELOG.md") continue;
      out.push({ rel, text: readFileSync(p, "utf-8") });
    }
  };
  walk(DOCS);
  return out;
}

test("内部资料路径不存在于发布树", () => {
  for (const p of REMOVED_PATHS) {
    expect(existsSync(join(ROOT, p))).toBe(false);
  }
});

test("站内页面不再链接或提到内部资料", () => {
  const bad: string[] = [];
  for (const { rel, text } of sitePages()) {
    for (const m of FORBIDDEN_MARKERS) {
      if (text.includes(m)) bad.push(`${rel} 提到 ${m}`);
    }
  }
  expect(bad).toEqual([]);
});

test("官网首页不链接内部资料", () => {
  const index = readFileSync(join(DOCS, "index.html"), "utf-8");
  for (const m of FORBIDDEN_MARKERS) expect(index).not.toContain(m);
});
