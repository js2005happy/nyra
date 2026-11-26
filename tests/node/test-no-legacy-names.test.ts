// tests/node/test-no-legacy-names.test.ts — 对外文本里不出现开发期的协作方名字。
// 以前文档和注释里写过“页面在 desktop/，归某协作方”这类话；统一改成中性说法后，用这条防回潮。
// 名字拼接出来，避免这个测试文件自己成为命中。
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["src", "docs", "mobile", "desktop/src", ".github", "scripts"];
const ROOT_FILES = ["README.md", "GUIDE.md", "CHANGELOG.md", "ROADMAP.md", "DESIGN.md", "VERIFICATION.md"];
const EXTS = new Set([".ts", ".md", ".yml", ".yaml", ".html", ".js", ".css", ".json", ".sh", ".ps1", ".rs"]);
const SKIP = new Set(["node_modules", "design", "dist", "target", "android", "eval-results"]);

function walk(dir: string, out: string[]): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(n)) && st.size < 2_000_000) out.push(p);
  }
}

const LEGACY = new RegExp("\\b" + ["H", "ark"].join("") + "\\b");

test("仓库文本不含开发期协作方的名字", () => {
  const files: string[] = ROOT_FILES.map((f) => join(ROOT, f));
  for (const d of DIRS) walk(join(ROOT, d), files);
  const hits: string[] = [];
  for (const f of files) {
    let text = "";
    try { text = readFileSync(f, "utf-8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      if (LEGACY.test(line)) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
    });
  }
  expect(hits).toEqual([]);
});
