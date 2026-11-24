// tests/node/test-docs-facts.test.ts — 文档里写死的事实要跟代码对得上。
// 回归：GUIDE 写“Nyra 有 24 个工具”，实际 TOOL_SCHEMAS 已经 46 个；README/GUIDE 的快速开始
// 被版本说明和冷门功能挤到一两百行以后，新用户找不到入口。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_SCHEMAS } from "../../src/tools.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf-8");

test("GUIDE 的工具数量等于 TOOL_SCHEMAS", () => {
  const guide = read("GUIDE.md");
  expect(guide).toContain(`内置 ${TOOL_SCHEMAS.length} 个工具`);
  expect(guide).not.toMatch(/有 24 个工具|24 个工具 \+/);
});

for (const f of ["README.md", "GUIDE.md"]) {
  test(`${f}：快速开始在前 80 行内`, () => {
    const lines = read(f).split("\n");
    const at = lines.findIndex((l) => l.trim() === "## 快速开始");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(80);
  });
}
