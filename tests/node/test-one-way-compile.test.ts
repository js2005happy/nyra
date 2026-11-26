// tests/node/test-one-way-compile.test.ts — H8：单向编译成规则，测试钉住。
// 规则（见 DESIGN.md“单向编译”一节）：源只读、派生单向、写回必过门。
// - 写 MEMORY.md 只有一个入口：appendMemory（src/memory.ts）。
// - 写技能源文件只有一个入口：saveSkillFile（src/skills.ts）。
// - 派生（索引/分块/缓存）只写自己的文件，删了可重建，绝不写回源。
// 本文件静态扫描全仓 src/**/*.ts：改了入口名、或新加一条写源的路径，
// 测试就失败——改规则要先改 DESIGN.md 再改这里的允许清单，并写清理由。
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { appendMemory, loadMemorySummary } from "../../src/memory.ts";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (e.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const WRITE_CALL = /\b(writeFileSync|appendFileSync|createWriteStream|renameSync|copyFileSync)\b/;

test("OneWayCompileTest.test_only_appendMemory_writes_memory_md", () => {
  // 除 src/memory.ts 外，任何源文件不得在同一行里用文件写原语碰 MEMORY.md。
  // memoryExchange.ts 调 appendMemory 写记忆（函数调用，不是文件写原语），
  // 不触发本条；它本身也要过记忆门，见 memoryGate.ts。
  const offenders: string[] = [];
  for (const f of listTsFiles(SRC)) {
    if (f === join(SRC, "memory.ts")) continue;
    const lines = readFileSync(f, "utf-8").split("\n");
    lines.forEach((line, i) => {
      if (WRITE_CALL.test(line) && line.includes("MEMORY.md")) {
        offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

test("OneWayCompileTest.test_skill_writers_are_allowlisted", () => {
  // 写技能文件的行只允许出现在下面这几处（每处都有去向说明）：
  // - src/skills.ts：saveSkillFile，唯一的源写入口（用户批准的技能安装/保存）。
  // - src/creator.ts：写进 stagingDir 下的 skills/（打包 staging，派生，只出不进）。
  // - src/marketplace.ts：从 skillsDir 拷进安装目录的 skills/（安装，派生，只出不进）。
  // - src/teamPack.ts：拷进打包目录的 skills/（打包，派生，只出不进）。
  // 其他任何文件出现“写原语 + skills 路径”都算违规：先改 DESIGN.md 再改这里。
  const allowed: { file: string; mustMatch: RegExp }[] = [
    { file: join(SRC, "creator.ts"), mustMatch: /stagingDir/ },
    { file: join(SRC, "marketplace.ts"), mustMatch: /join\(dir, "skills"/ },
    { file: join(SRC, "teamPack.ts"), mustMatch: /join\(dir, "skills"/ },
  ];
  const offenders: string[] = [];
  for (const f of listTsFiles(SRC)) {
    if (f === join(SRC, "skills.ts")) continue;
    const lines = readFileSync(f, "utf-8").split("\n");
    lines.forEach((line, i) => {
      if (!WRITE_CALL.test(line)) return;
      if (!line.includes("skillsDir") && !line.includes('"skills"')) return;
      const rule = allowed.find((a) => a.file === f);
      if (!rule || !rule.mustMatch.test(line)) {
        offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

test("OneWayCompileTest.test_design_doc_names_the_two_gates", () => {
  // DESIGN.md 的单向编译一节必须存在，且点名两个写入口；
  // 改入口名而不改文档，测试就失败。
  const design = readFileSync(join(ROOT, "DESIGN.md"), "utf-8");
  expect(design).toContain("## 单向编译");
  expect(design).toContain("appendMemory");
  expect(design).toContain("saveSkillFile");
  expect(design).toContain("src/memory.ts");
  expect(design).toContain("src/skills.ts");
});

test("OneWayCompileTest.test_derived_index_is_rebuildable_source_untouched", () => {
  // 派生可删可重建：删掉记忆 sidecar 索引（MEMORY.md.index.json），
  // 源 MEMORY.md 一字不动；再追加一条记忆，索引重建、内容正确。
  const home = mkdtempSync(join(tmpdir(), "nyra-owc-"));
  try {
    const target = join(home, "MEMORY.md");
    appendMemory("第一条记忆", target, home);
    appendMemory("第二条记忆", target, home);
    const before = readFileSync(target, "utf-8");
    expect(before).toContain("第一条记忆");
    expect(before).toContain("第二条记忆");
    const indexPath = `${target}.index.json`;
    expect(existsSync(indexPath)).toBe(true);
    rmSync(indexPath);
    expect(readFileSync(target, "utf-8")).toBe(before);
    appendMemory("第三条记忆", target, home);
    expect(existsSync(indexPath)).toBe(true);
    const after = readFileSync(target, "utf-8");
    expect(after).toContain("第三条记忆");
    expect(after.startsWith(before)).toBe(true);
    expect(loadMemorySummary(40, target, home)).toContain("第三条记忆");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OneWayCompileTest.test_appendMemory_ignores_blank", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-owc-"));
  try {
    const target = join(home, "MEMORY.md");
    appendMemory("   \n  ", target, home);
    expect(existsSync(target)).toBe(false);
    appendMemory("有效记忆", target, home);
    expect(readFileSync(target, "utf-8")).toContain("有效记忆");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
