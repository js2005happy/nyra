// tests/node/test-verifier-honesty.test.ts — DSH-5b 诚实交付口径（缺口 13 验收器小修）。
// 钉住的事：
//   - draft-labeled：标题/摘要含草稿标记却声称已完成 → 不通过；
//     只含草稿标记（未声称完成）、只声称完成（非草稿）、裸“通过” → 都通过；
//   - ui-before-shot：改了界面文件但摘要里没提 before/对比/截图 → 不通过；
//     裸 .html 不算界面文件，desktop/ui/ 路径算；
//   - 两项都是启发式文本判定：只核对说法，不验截图像素。
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDeterministicChecks, VERIFIER_SYSTEM_PROMPT, type VerifierInput } from "../../src/verifier.ts";

function makeWorkdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-vh-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
  }
  return dir;
}

function baseInput(workdir: string, over: Partial<VerifierInput> = {}): VerifierInput {
  return {
    title: "修 a.txt 拼写",
    summary: "改了 a.txt，跑了 bun test，12 通过。",
    changedFiles: ["a.txt"],
    diffStat: " a.txt | 2 +-\n 1 file changed",
    worktreePath: workdir,
    workdir: null,
    spentUsd: 0.01,
    ...over,
  };
}

function checkById(workdir: string, over: Partial<VerifierInput>, id: string) {
  const checks = runDeterministicChecks(baseInput(workdir, over));
  const c = checks.find((x) => x.id === id);
  expect(c).toBeDefined();
  return c!;
}

test("VerifierHonestyTest.test_draft_claiming_done_fails", () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const c = checkById(dir, { title: "草稿：新页面", summary: "已完成，测试全部通过。" }, "draft-labeled");
  expect(c.passed).toBe(false);
  expect(c.detail).toContain("草稿");
  expect(c.detail).toContain("已完成");
});

test("VerifierHonestyTest.test_draft_without_completion_claim_passes", () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  expect(checkById(dir, { title: "草稿：新页面", summary: "先搭了个架子，还没写完。" }, "draft-labeled").passed).toBe(true);
  // 摘要里说初稿、但没声称完成，也通过。
  expect(checkById(dir, { summary: "这是初稿，搭了个架子。" }, "draft-labeled").passed).toBe(true);
});

test("VerifierHonestyTest.test_bare_pass_is_not_a_completion_claim", () => {
  // 裸“通过”不算完成声称：摘要里“12 通过”配草稿标题也不应误判。
  const dir = makeWorkdir({ "a.txt": "x\n" });
  expect(checkById(dir, { title: "草稿：新页面", summary: "跑了 bun test，12 通过。" }, "draft-labeled").passed).toBe(true);
});

test("VerifierHonestyTest.test_latin_wip_and_ready", () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  expect(checkById(dir, { title: "wip: new page", summary: "ready for review" }, "draft-labeled").passed).toBe(false);
  expect(checkById(dir, { title: "wip: new page", summary: "still working on it" }, "draft-labeled").passed).toBe(true);
});

test("VerifierHonestyTest.test_ui_change_without_before_fails", () => {
  const dir = makeWorkdir({ "Button.tsx": "export {};\n", "style.css": ".a {}\n" });
  expect(checkById(dir, { changedFiles: ["Button.tsx"], diffStat: " Button.tsx | 2 +-\n 1 file changed", summary: "改了按钮样式。" }, "ui-before-shot").passed).toBe(false);
  expect(checkById(dir, { changedFiles: ["style.css"], diffStat: " style.css | 2 +-\n 1 file changed", summary: "调了颜色。" }, "ui-before-shot").passed).toBe(false);
});

test("VerifierHonestyTest.test_ui_change_with_before_mention_passes", () => {
  const dir = makeWorkdir({ "Button.tsx": "export {};\n" });
  expect(checkById(dir, { changedFiles: ["Button.tsx"], diffStat: " Button.tsx | 2 +-\n 1 file changed", summary: "改了按钮样式，附 before/after 对比截图。" }, "ui-before-shot").passed).toBe(true);
});

test("VerifierHonestyTest.test_bare_html_is_not_ui_but_desktop_ui_paths_are", () => {
  const dir = makeWorkdir({ "index.html": "<html></html>\n", "desktop/ui/README.md": "# ui\n" });
  // 裸 .html 是文档页，不是产品界面：通过。
  expect(checkById(dir, { changedFiles: ["index.html"], diffStat: " index.html | 2 +-\n 1 file changed", summary: "改了文档页。" }, "ui-before-shot").passed).toBe(true);
  // desktop/ui/ 路径下的文件（哪怕是 .md）也算界面：没提 before 就不通过。
  expect(checkById(dir, { changedFiles: ["desktop/ui/README.md"], diffStat: " README.md | 2 +-\n 1 file changed", summary: "改了界面说明。" }, "ui-before-shot").passed).toBe(false);
});

test("VerifierHonestyTest.test_system_prompt_carries_honesty_rules", () => {
  expect(VERIFIER_SYSTEM_PROMPT).toContain("草稿");
  expect(VERIFIER_SYSTEM_PROMPT).toContain("before");
});
