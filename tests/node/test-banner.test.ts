// tests/node/test-banner.test.ts — 终端外观 v2（半块字符标志欢迎屏 / 信息卡 / 信任确认 / 输入区 / 状态栏）。
// 内联快照锁定无色布局；颜色只做"去掉 ANSI 后与无色版完全一致"的检查。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderHeader, renderTrustPrompt, renderStatusBar, renderInputFrame, renderRule, renderTips, renderReply,
  renderOk, renderError, renderEcho, supportsBoxDrawing, shortenPath, truncateLeft, stripAnsi, inputRows,
  gitBranch, modeBadge, MARK_MIN_COLS,
} from "../../src/banner.ts";
import { textWidth } from "../../src/consoleUi.ts";
import { TERM_MARK_COLS, TERM_MARK_ROWS } from "../../src/termMark.ts";

const INFO = { version: "0.5.11", model: "deepseek / deepseek-flash", mode: "auto", cwd: "/home/sj/projects/nyra-cli", branch: "main" };

test("BannerTest.test_header_snapshot_wide", () => {
  const out = renderHeader(INFO, { width: 100, color: false, unicode: true, home: "/home/sj" }).join("\n");
  expect(out).toBe([
    "",
    "  ▄██████████████▄",
    " ██████████████████",
    " ██████████████████",
    " █████▀▀████▀▀█████   Nyra v0.5.11",
    " █████  ████  █████   跑在你电脑上的开源 AI Agent",
    " █████  ████  █████",
    " ██████████████████",
    " ██████████████████",
    "  ▀██████████████▀",
    "",
    "╭──────────────────────────────────────────╮",
    "│ 模型  deepseek / deepseek-flash          │",
    "│ 模式   auto                              │",
    "│ 目录  ~/projects/nyra-cli                │",
    "│ 分支  ⎇ main                             │",
    "╰──────────────────────────────────────────╯",
  ].join("\n"));
});

test("BannerTest.test_header_narrow_truncates_then_falls_back_to_single_line", () => {
  const lines = renderHeader(INFO, { width: 50, color: false, unicode: true, home: "/home/sj" });
  expect(lines.join("\n")).toContain("█");
  expect(renderHeader(INFO, { width: MARK_MIN_COLS, color: false, unicode: true }).join("\n")).toContain("…");
  // 50 列仍然出标志（介绍截断）；恰好在阈值上才出标志，低一列退回单行。
  expect(renderHeader(INFO, { width: MARK_MIN_COLS, unicode: true }).join("")).toContain("█");
  expect(renderHeader(INFO, { width: MARK_MIN_COLS - 1, unicode: true }).join("")).not.toContain("█");
  const narrow = renderHeader(INFO, { width: MARK_MIN_COLS - 1, color: false, unicode: true, home: "/home/sj" });
  expect(narrow.slice(0, 2)).toEqual(["", "✻ Nyra 0.5.11"]);
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(50);
});

test("BannerTest.test_header_compact_for_non_tty", () => {
  const lines = renderHeader(INFO, { width: 120, unicode: true, compact: true });
  expect(lines[1]).toBe("✻ Nyra 0.5.11");
  expect(lines.join("")).not.toContain("█");
});

test("BannerTest.test_header_snapshot_ascii", () => {
  const out = renderHeader(INFO, { width: 100, color: false, unicode: false, home: "/home/sj" }).join("\n");
  expect(out).toBe([
    "",
    "* Nyra 0.5.11",
    "+------------------------------------------+",
    "| 模型  deepseek / deepseek-flash          |",
    "| 模式   auto                              |",
    "| 目录  ~/projects/nyra-cli                |",
    "| 分支  git:main                           |",
    "+------------------------------------------+",
  ].join("\n"));
  // ASCII 回退里不能有任何非 ASCII 的画框 / 块字 / 符号。
  expect(out).not.toMatch(/[\u2500-\u259f\u273b\u2387…›●✓✗]/);
  const ascii = { unicode: false };
  expect(renderStatusBar({ model: "m", mode: "auto", contextUsage: 0.1, branch: "dev" }, { width: 80, ...ascii })).not.toMatch(/[^\x00-\x7f上下文]/);
  expect(renderInputFrame({ model: "m", mode: "auto", contextUsage: null }, { width: 40, ...ascii }).prompt).toBe("> ");
  expect(renderReply("hi", ascii)).toBe("* hi");
  expect(renderOk("好", ascii)).toBe("+ 好");
  expect(renderError("坏", ascii)).toBe("x 坏");
});

test("BannerTest.test_header_without_branch_has_no_branch_row", () => {
  const out = renderHeader({ ...INFO, branch: null }, { width: 100, unicode: true, home: "/home/sj" }).join("\n");
  expect(out).not.toContain("分支");
});

test("BannerTest.test_mark_replaces_wordmark", () => {
  // 不再有 NYRA 块字（用户不要字标）；"Nyra" 只作为纯文字标题出现。
  const out = renderHeader(INFO, { width: 100, color: false, unicode: true, home: "/home/sj" });
  const mark = out.slice(1, 1 + TERM_MARK_ROWS);
  expect(mark.length).toBe(TERM_MARK_ROWS);
  for (const l of mark) expect(textWidth(l.slice(0, 1 + TERM_MARK_COLS))).toBeLessThanOrEqual(1 + TERM_MARK_COLS);
  expect(out.join("\n")).not.toContain("██▄   ██");
  expect(out.join("\n")).toContain("Nyra v0.5.11");
});

test("BannerTest.test_never_angel", () => {
  const all = [
    renderHeader(INFO, { width: 100, unicode: true }).join("\n"),
    renderHeader(INFO, { width: 40, unicode: false }).join("\n"),
    renderTrustPrompt("/tmp/x", { width: 80 }).lines.join("\n"),
    renderTrustPrompt("/tmp/x", { width: 80 }).question,
    renderStatusBar({ model: "m", mode: "auto", contextUsage: null }, { width: 80 }),
    renderTips({ width: 120, pet: true }),
  ].join("\n");
  expect(all.toLowerCase()).not.toContain("angel");
  expect(all).toContain("Nyra");
});

test("BannerTest.test_header_box_lines_have_equal_width", () => {
  for (const width of [100, 60, 40, 30]) {
    const lines = renderHeader({ ...INFO, cwd: "C:\\Users\\Administrator\\WorkBuddy\\2026-11-18-12-08-26\\nyra-cli" },
      { width, unicode: true, home: "C:\\Users\\Administrator" });
    const box = lines.filter((l) => /^[╭│╰]/.test(l));
    const widths = box.map((l) => textWidth(l));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(width);
    for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(width);
  }
});

test("BannerTest.test_header_long_windows_path_shortened", () => {
  const lines = renderHeader({ ...INFO, cwd: "C:\\Users\\Administrator\\WorkBuddy\\2026-11-18-12-08-26\\nyra-cli" },
    { width: 44, unicode: true, home: "C:\\Users\\Administrator" });
  const dirLine = lines.find((l) => l.includes("目录"))!;
  expect(dirLine).toContain("…");
  expect(dirLine).toContain("nyra-cli");
  expect(dirLine).not.toContain("Administrator");
});

test("BannerTest.test_header_tiny_terminal_drops_box", () => {
  const lines = renderHeader(INFO, { width: 20, unicode: true, home: "/home/sj" });
  expect(lines.join("")).not.toContain("╭");
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(20);
});

test("BannerTest.test_color_levels_keep_layout", () => {
  const plain = renderHeader(INFO, { width: 100, color: false, home: "/home/sj" });
  expect(plain.join("\n")).not.toContain("\x1b[");
  for (const level of [1, 2, 3] as const) {
    const colored = renderHeader(INFO, { width: 100, color: true, level, home: "/home/sj" });
    expect(colored.join("\n")).toContain("\x1b[");
    // 标志行：256 色 / truecolor 是抗锯齿画法，字形可以不同，但显示宽度一致；其余行逐字一致。
    const markRows = 1 + TERM_MARK_ROWS;
    expect(colored.slice(markRows).map(stripAnsi)).toEqual(plain.slice(markRows));
    colored.slice(0, markRows).forEach((l, i) => {
      const w = textWidth(stripAnsi(l));
      if (stripAnsi(l).includes("Nyra") || plain[i].includes("AI")) expect(w).toBe(textWidth(plain[i]));
      else expect(w).toBeLessThanOrEqual(1 + TERM_MARK_COLS);
    });
    if (level === 1) expect(colored.map(stripAnsi)).toEqual(plain);
  }
  // truecolor 用 38;2，256 色用 38;5，16 色不用两者。
  const tc = renderHeader(INFO, { width: 100, color: true, level: 3 }).join("");
  const c256 = renderHeader(INFO, { width: 100, color: true, level: 2 }).join("");
  const c16 = renderHeader(INFO, { width: 100, color: true, level: 1 }).join("");
  expect(tc).toContain("38;2;");
  expect(c256).toContain("38;5;");
  expect(c256).not.toContain("38;2;");
  expect(c16).not.toMatch(/38;[25];/);
  // level 0（NO_COLOR）即使 color=true 也无色。
  expect(renderHeader(INFO, { width: 100, color: true, level: 0 }).join("")).not.toContain("\x1b[");
  const bar = renderStatusBar({ model: "m", mode: "auto", contextUsage: 0.2 }, { width: 80, color: false });
  expect(bar).not.toContain("\x1b[");
  expect(stripAnsi(renderStatusBar({ model: "m", mode: "auto", contextUsage: 0.2 }, { width: 80, color: true })))
    .toBe(bar);
});

test("BannerTest.test_mode_badge_colors", () => {
  // readonly 绿、auto 蓝紫、full 红：底色互不相同。
  const bg = (m: string) => /48;2;[0-9;]+/.exec(modeBadge(m, 3))![0];
  expect(new Set([bg("readonly"), bg("auto"), bg("full")]).size).toBe(3);
  expect(bg("readonly")).toBe("48;2;76;154;108");
  expect(bg("full")).toBe("48;2;201;73;63");
  expect(modeBadge("auto", 0)).toBe(" auto ");
});

test("BannerTest.test_shorten_path", () => {
  expect(shortenPath("/home/sj", 40, "/home/sj")).toBe("~");
  expect(shortenPath("/home/sj/a/b", 40, "/home/sj")).toBe("~/a/b");
  expect(shortenPath("/home/sjx/a", 40, "/home/sj")).toBe("/home/sjx/a");
  expect(shortenPath("C:\\Users\\Admin\\proj", 40, "C:\\Users\\Admin")).toBe("~\\proj");
  expect(truncateLeft("abcdefghij", 5)).toBe("…ghij");
  expect(textWidth(truncateLeft("工作目录很长很长", 7))).toBeLessThanOrEqual(7);
});

test("BannerTest.test_trust_prompt_snapshot", () => {
  const t = renderTrustPrompt("/home/sj/projects/nyra-cli", { width: 100, unicode: true });
  expect(t.lines.join("\n")).toBe([
    "╭───────────────────────────────────────╮",
    "│ 信任这个工作目录吗？                  │",
    "│ /home/sj/projects/nyra-cli            │",
    "│ Nyra 可以在这里读取、修改和执行文件。 │",
    "╰───────────────────────────────────────╯",
  ].join("\n"));
  expect(t.question).toContain("(y/N)");
});

test("BannerTest.test_status_bar_snapshot", () => {
  expect(renderStatusBar({ model: "deepseek / deepseek-flash", mode: "auto", contextUsage: null, branch: "main" }, { width: 80 }))
    .toBe("  deepseek / deepseek-flash  auto                            上下文 -- · ⎇ main");
  expect(renderStatusBar({ model: "deepseek", mode: "full", contextUsage: 0.254 }, { width: 60, unicode: false }))
    .toBe("  deepseek  full                                 上下文 25%");
});

test("BannerTest.test_status_bar_right_aligned", () => {
  for (const width of [60, 80, 120]) {
    const bar = renderStatusBar({ model: "deepseek", mode: "auto", contextUsage: 0.5, branch: "main" }, { width });
    expect(textWidth(bar)).toBe(width - 1);
    expect(bar.endsWith("main")).toBe(true);
  }
});

test("BannerTest.test_status_bar_mode_hint_only_when_supported", () => {
  const without = renderStatusBar({ model: "m", mode: "auto", contextUsage: null }, { width: 100 });
  expect(without).not.toContain("shift+tab");
  const withKey = renderStatusBar({ model: "m", mode: "auto", contextUsage: null, modeSwitchKey: true }, { width: 100 });
  expect(withKey).toContain("shift+tab"); // 提示文案随界面语言（zh：shift+tab 切换模式）
});

test("BannerTest.test_status_bar_fits_narrow_terminal", () => {
  for (const width of [20, 30, 44]) {
    const bar = renderStatusBar({ model: "a-very-long-provider / a-very-long-model-name", mode: "auto", contextUsage: 0.5, branch: "feature/x" }, { width });
    expect(textWidth(bar)).toBeLessThanOrEqual(width);
  }
  // 窄时先丢分支，保留上下文。
  const mid = renderStatusBar({ model: "deepseek", mode: "auto", contextUsage: 0.5, branch: "a-long-branch-name" }, { width: 40 });
  expect(mid).toContain("上下文 50%");
  expect(mid).not.toContain("a-long-branch-name");
});

test("BannerTest.test_input_frame", () => {
  const f = renderInputFrame({ model: "m", mode: "auto", contextUsage: null }, { width: 40, unicode: true });
  expect(f.prompt).toBe("› ");
  expect(f.above).toEqual(["─".repeat(40)]);
  expect(f.below[0]).toBe("─".repeat(40));
  expect(f.below[1]).toContain("auto");
  // 给小伙伴让出右侧列。
  const r = renderInputFrame({ model: "m", mode: "auto", contextUsage: null }, { width: 100, unicode: true, reserveRight: 12 });
  expect(r.above[0]).toBe("─".repeat(88));
  expect(textWidth(r.below[1])).toBeLessThanOrEqual(88);
  expect(renderRule(4, { unicode: false })).toBe("----");
  expect(inputRows("", 80)).toBe(1);
  expect(inputRows("x".repeat(100), 80)).toBe(2);
  const colored = renderInputFrame({ model: "m", mode: "auto", contextUsage: null }, { width: 40, color: true, level: 3 });
  expect(colored.prompt).toContain("\x1b[");
  expect(stripAnsi(colored.prompt)).toBe("› ");
});

test("BannerTest.test_tips_only_real_commands_and_fit", () => {
  const tips = renderTips({ width: 120, pet: true });
  for (const c of ["/help", "/mode", "/undo", "/pet"]) expect(tips).toContain(c);
  expect(renderTips({ width: 120 })).not.toContain("/pet");
  for (const w of [30, 50, 70]) expect(textWidth(renderTips({ width: w, pet: true }))).toBeLessThanOrEqual(w - 1);
});

test("BannerTest.test_reply_echo_ok_error", () => {
  expect(renderReply("第一行\n第二行", {})).toBe("● 第一行\n  第二行");
  expect(renderEcho("hi", {})).toBe("› hi");
  expect(renderOk("已切换", {})).toBe("✓ 已切换");
  expect(renderError("错误：x", {})).toBe("✗ 错误：x");
  expect(renderError("错误：x", { color: true, level: 1 })).toContain("\x1b[31m");
  expect(renderOk("ok", { color: true, level: 1 })).toContain("32");
});

test("BannerTest.test_git_branch_detection", () => {
  const root = mkdtempSync(join(tmpdir(), "nyra-git-"));
  expect(gitBranch(root)).toBeNull();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feat/tui\n");
  mkdirSync(join(root, "a", "b"), { recursive: true });
  expect(gitBranch(join(root, "a", "b"))).toBe("feat/tui");
  writeFileSync(join(root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  expect(gitBranch(root)).toBe("0123456");
  // worktree：.git 是指向 gitdir 的文件。
  const wt = join(root, "wt");
  mkdirSync(join(root, "gd"));
  writeFileSync(join(root, "gd", "HEAD"), "ref: refs/heads/wt-branch\n");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), "gitdir: ../gd\n");
  expect(gitBranch(wt)).toBe("wt-branch");
});

test("BannerTest.test_supports_box_drawing_detection", () => {
  // Windows：Windows Terminal / VS Code / ConEmu 才用框线；裸 conhost 退回 ASCII。
  expect(supportsBoxDrawing({ WT_SESSION: "abc" }, "win32")).toBe(true);
  expect(supportsBoxDrawing({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
  expect(supportsBoxDrawing({ ConEmuANSI: "ON" }, "win32")).toBe(true);
  expect(supportsBoxDrawing({}, "win32", "10.0.22631")).toBe(true);   // Win11，快捷方式启动无 WT_SESSION
  expect(supportsBoxDrawing({}, "win32", "10.0.18362")).toBe(true);   // Win10 1903
  expect(supportsBoxDrawing({}, "win32", "10.0.17763")).toBe(false);  // 老 Win10
  expect(supportsBoxDrawing({}, "win32", "6.1.7601")).toBe(false);    // Win7
  expect(supportsBoxDrawing({ NYRA_ASCII: "1" }, "win32", "10.0.22631")).toBe(false);
  // 强制开关。
  expect(supportsBoxDrawing({ NYRA_ASCII: "1", WT_SESSION: "abc" }, "win32")).toBe(false);
  expect(supportsBoxDrawing({ NYRA_UNICODE: "1" }, "win32")).toBe(true);
  // 其他平台：默认支持；dumb 或明确非 UTF-8 的 locale 不支持。
  expect(supportsBoxDrawing({}, "linux")).toBe(true);
  expect(supportsBoxDrawing({ LANG: "en_US.UTF-8" }, "darwin")).toBe(true);
  expect(supportsBoxDrawing({ TERM: "dumb" }, "linux")).toBe(false);
  expect(supportsBoxDrawing({ LANG: "zh_CN.GBK" }, "linux")).toBe(false);
});

test("BannerTest.test_status_bar_cost_segment", () => {
  const bar = renderStatusBar({ model: "deepseek", mode: "auto", contextUsage: 0.25, cost: "成本 $0.0180/$1.00", branch: "main" }, { width: 100 });
  expect(bar).toContain("上下文 25% · 成本 $0.0180/$1.00 · ⎇ main");
  // 窄时先丢分支，再丢成本，上下文保留。
  const narrow = renderStatusBar({ model: "deepseek", mode: "auto", contextUsage: 0.25, cost: "成本 $0.0180/$1.00", branch: "main" }, { width: 52 });
  expect(narrow).toContain("上下文 25%");
  expect(narrow).not.toContain("main");
  expect(textWidth(narrow)).toBeLessThanOrEqual(52);
});
