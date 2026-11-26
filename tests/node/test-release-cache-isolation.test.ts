// tests/node/test-release-cache-isolation.test.ts — H9：发版缓存隔离，测试钉住。
// 规则：任何 CI 缓存的键必须钉死分支/tag（github.ref），restore-keys 只许
// 回落到同一分支的前缀，绝不跨分支串味；发版 tag 构建从干净缓存起步。
// setup-node 内置的 npm 缓存键不含分支，不许用，改走显式 actions/cache。
// 本文件只做文本级守门（仓库里没有 YAML 解析器）：CI 自己跑起来时还会
// 再验一次工作流语法。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WF = join(process.cwd(), ".github", "workflows");

function read(name: string): string {
  return readFileSync(join(WF, name), "utf-8");
}

test("ReleaseCacheIsolationTest.test_desktop_npm_cache_is_branch_scoped", () => {
  const yml = read("desktop.yml");
  // 不许用 setup-node 内置 npm 缓存：它的键只含 OS + 锁文件哈希，不含分支。
  expect(yml).not.toContain("cache: npm");
  expect(yml).not.toContain("cache-dependency-path");
  // 显式 actions/cache 的键必须钉死 github.ref。
  const cacheStep = yml.match(/uses: actions\/cache@v4[\s\S]*?(?=\n      - name:|\n  [a-z]+:|\Z)/);
  expect(cacheStep).not.toBeNull();
  const block = cacheStep![0];
  expect(block).toContain("key: npm-${{ runner.os }}-${{ github.ref }}-${{ hashFiles('desktop/package-lock.json') }}");
  // restore-keys 只许回落到同一分支的前缀，不许出现不含 github.ref 的回落键。
  const lines = block.split("\n");
  const at = lines.findIndex((l) => l.trim().startsWith("restore-keys:"));
  expect(at).toBeGreaterThanOrEqual(0);
  const baseIndent = lines[at].length - lines[at].trimStart().length;
  const keys = lines.slice(at + 1).filter((l) => l.trim() && l.length - l.trimStart().length > baseIndent).map((l) => l.trim());
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) expect(k).toContain("github.ref");
});

test("ReleaseCacheIsolationTest.test_desktop_rust_cache_is_branch_scoped", () => {
  const yml = read("desktop.yml");
  const rustStep = yml.match(/uses: Swatinem\/rust-cache@v2[\s\S]*?(?=\n      - name:|\n  [a-z]+:|\Z)/);
  expect(rustStep).not.toBeNull();
  // rust-cache v2 的 key 输入是“加在自动 job 键之外的附加键”——钉死分支。
  expect(rustStep![0]).toContain("key: ${{ github.ref }}");
});

test("ReleaseCacheIsolationTest.test_other_workflows_use_no_cache", () => {
  // node-ci / node-binaries / mobile / release-facts / release-sign 目前
  // 全都不用缓存（每次 bun install / 全新构建），天然隔离；一旦有人加
  // 缓存，本测试就失败，逼他按同一条规则把键钉死分支。
  for (const name of ["node-ci.yml", "node-binaries.yml", "mobile.yml", "release-facts.yml", "release-sign.yml"]) {
    const yml = read(name);
    expect(yml).not.toContain("actions/cache");
    expect(yml).not.toContain("rust-cache");
    expect(yml).not.toMatch(/^\s*cache:\s/m);
  }
});
