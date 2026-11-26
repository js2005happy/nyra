// tests/node/test-docs-facts.test.ts — 文档里写死的事实要跟代码对得上。
// 回归：GUIDE 写“Nyra 有 24 个工具”，实际 TOOL_SCHEMAS 已经 46 个；README/GUIDE 的快速开始
// 被版本说明和冷门功能挤到一两百行以后，新用户找不到入口。
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_SCHEMAS } from "../../src/tools.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf-8");

test("GUIDE 的工具数量等于 TOOL_SCHEMAS", () => {
  const guide = read("GUIDE.md");
  expect(guide).toContain(`内置 ${TOOL_SCHEMAS.length} 个工具`);
  expect(guide).not.toMatch(/有 24 个工具|24 个工具 \+/);
});

test("GUIDE.md：快速开始在前 80 行内", () => {
  const lines = read("GUIDE.md").split("\n");
  const at = lines.findIndex((l) => l.trim() === "## 快速开始");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThan(80);
});

// README 改成下载按钮在最上面：新用户第一屏就能点到安装包，不用往下翻找快速开始。
const STABLE_ASSETS = [
  "Nyra-windows-x64-setup.exe",
  "Nyra-macos-universal.dmg",
  "Nyra-linux-x86_64.AppImage",
  "Nyra-linux-amd64.deb",
  "nyra-android.apk",
];

test("README.md：下载按钮在前 40 行、在主截图之前，五个平台都链 releases/latest/download 的稳定文件名", () => {
  const lines = read("README.md").split("\n");
  const firstDownload = lines.findIndex((l) => l.includes("releases/latest/download/"));
  const heroShot = lines.findIndex((l) => l.includes("docs/assets/screenshots/"));
  expect(firstDownload).toBeGreaterThanOrEqual(0);
  expect(firstDownload).toBeLessThan(40);
  expect(heroShot).toBeGreaterThan(firstDownload);
  const top = lines.slice(0, heroShot).join("\n");
  for (const name of STABLE_ASSETS) {
    expect(top).toContain(`releases/latest/download/${name}`);
  }
  // 签名状态如实写在按钮下面
  expect(top).toMatch(/未做代码签名|未签名/);
  expect(top).toMatch(/公证/);
  expect(top).toMatch(/debug|临时/);
});

test("README.md：引用的截图文件都存在", () => {
  const readme = read("README.md");
  const refs = [...readme.matchAll(/(docs\/assets\/screenshots\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]!);
  expect(refs.length).toBeGreaterThan(0);
  for (const r of refs) expect(existsSync(join(ROOT, r))).toBe(true);
});
