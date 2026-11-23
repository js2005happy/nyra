// tests/node/test-i18n.test.ts — 终端界面中英双语：文案表完整性、语言探测优先级、
// /lang 切换与持久化、英文/中文欢迎屏与状态栏快照（含 CJK 宽度对齐）。
import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MESSAGES, t, tList, setLang, getLang, detectLang, systemLang, normalizeLang, extractLangFlag, type MsgKey,
} from "../../src/i18n.ts";
import { initLang, parseLangCommand, usageText, USAGE, USAGE_EN } from "../../src/cli.ts";
import { renderHeader, renderStatusBar, renderTips, renderTrustPrompt, stripAnsi } from "../../src/banner.ts";
import { approvalOptions, renderApprovalMenu } from "../../src/approvalUi.ts";
import { idleQuips, happyQuips, worriedQuips, approvalQuip } from "../../src/pet.ts";
import { textWidth } from "../../src/consoleUi.ts";

afterEach(() => setLang("zh")); // 库默认 zh，别把语言状态漏给其他测试

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("I18n.test_both_languages_have_the_same_keys", () => {
  const zhKeys = Object.keys(MESSAGES.zh).sort();
  const enKeys = Object.keys(MESSAGES.en).sort();
  expect(enKeys).toEqual(zhKeys);
  expect(zhKeys.length).toBeGreaterThan(100);
  for (const k of zhKeys as MsgKey[]) {
    expect(MESSAGES.zh[k].length).toBeGreaterThan(0);
    expect(MESSAGES.en[k].length).toBeGreaterThan(0);
    // 两种语言的占位符一致（漏一个就会把 {x} 原样打到终端上）。
    expect(placeholders(MESSAGES.en[k])).toEqual(placeholders(MESSAGES.zh[k]));
  }
});

test("I18n.test_user_visible_text_says_nyra_never_angel", () => {
  for (const lang of ["zh", "en"] as const) {
    for (const v of Object.values(MESSAGES[lang])) expect(v.toLowerCase()).not.toContain("angel");
  }
  expect(USAGE_EN.toLowerCase()).not.toContain("angel");
  expect(USAGE.toLowerCase()).not.toContain("angel");
});

test("I18n.test_english_table_has_no_chinese_except_language_names", () => {
  for (const [k, v] of Object.entries(MESSAGES.en)) {
    const cjk = v.replace(/中文/g, "").match(/[\u4e00-\u9fff]/);
    if (cjk) throw new Error(`en 文案里有中文：${k} = ${v}`);
  }
});

test("I18n.test_t_fills_placeholders_and_lists", () => {
  expect(t("repl.modeSwitched", { mode: "full" }, "en")).toBe("Switched to full mode.");
  expect(t("repl.modeSwitched", { mode: "full" }, "zh")).toBe("已切换到 full 模式。");
  setLang("en");
  expect(t("spinner.running", { tool: "shell" })).toBe("Running shell…");
  expect(tList("pet.happy").length).toBe(3);
});

test("I18n.test_normalize_lang", () => {
  expect(normalizeLang("zh_CN.UTF-8")).toBe("zh");
  expect(normalizeLang("zh-TW")).toBe("zh");
  expect(normalizeLang("en_US.UTF-8")).toBe("en");
  expect(normalizeLang("EN")).toBe("en");
  expect(normalizeLang("C.UTF-8")).toBeNull();
  expect(normalizeLang("fr")).toBeNull();
  expect(normalizeLang(42)).toBeNull();
});

test("I18n.test_system_lang_order_and_windows", () => {
  expect(systemLang({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "linux")).toBe("zh");
  expect(systemLang({ LC_MESSAGES: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, "linux")).toBe("en");
  expect(systemLang({ LANG: "zh_CN.UTF-8" }, "linux")).toBe("zh");
  // C / POSIX 视为未设置，往下找。
  expect(systemLang({ LC_ALL: "C", LANG: "zh_CN.UTF-8" }, "linux")).toBe("zh");
  expect(systemLang({ LANG: "C.UTF-8" }, "linux")).toBeNull();
  // 其他语言的系统按英文。
  expect(systemLang({ LANG: "fr_FR.UTF-8" }, "linux")).toBe("en");
  // Windows：环境变量为空时用 Intl 的 locale。
  expect(systemLang({}, "win32", () => "zh-CN")).toBe("zh");
  expect(systemLang({}, "win32", () => "en-US")).toBe("en");
  expect(systemLang({}, "linux")).toBeNull();
});

test("I18n.test_detect_priority_flag_env_config_system_default", () => {
  const sys = { LANG: "zh_CN.UTF-8" };
  // 什么都没有 → en
  expect(detectLang({ env: {}, platform: "linux" })).toBe("en");
  // 系统语言
  expect(detectLang({ env: sys, platform: "linux" })).toBe("zh");
  // config 盖过系统
  expect(detectLang({ env: sys, config: { language: "en" }, platform: "linux" })).toBe("en");
  // NYRA_LANG 盖过 config
  expect(detectLang({ env: { ...sys, NYRA_LANG: "zh" }, config: { language: "en" }, platform: "linux" })).toBe("zh");
  // --lang 盖过一切
  expect(detectLang({ flag: "en", env: { ...sys, NYRA_LANG: "zh" }, config: { language: "zh" }, platform: "linux" })).toBe("en");
  // 非法值跳过，落到下一级
  expect(detectLang({ env: { NYRA_LANG: "klingon" }, config: { language: "zh" }, platform: "linux" })).toBe("zh");
});

test("I18n.test_extract_lang_flag_and_init", () => {
  expect(extractLangFlag(["--lang", "en", "doctor"])).toEqual({ value: "en", lang: "en", rest: ["doctor"] });
  expect(extractLangFlag(["doctor", "--lang=zh"])).toEqual({ value: "zh", lang: "zh", rest: ["doctor"] });
  expect(extractLangFlag(["任务"]).value).toBeUndefined();
  expect(extractLangFlag(["--lang", "xx"]).lang).toBeNull();
  const ok = initLang(["--lang", "en", "--help"], { language: "zh" });
  expect(ok.error).toBeUndefined();
  expect(ok.argv).toEqual(["--help"]);
  expect(getLang()).toBe("en");
  expect(usageText()).toBe(USAGE_EN);
  const bad = initLang(["--lang", "xx"], null);
  expect(bad.error).toContain("--lang");
});

test("I18n.test_parse_lang_command", () => {
  expect(parseLangCommand("/lang zh")).toBe("zh");
  expect(parseLangCommand("/lang en")).toBe("en");
  expect(parseLangCommand("/lang English")).toBe("en");
  expect(parseLangCommand("/lang")).toBeNull();
  expect(parseLangCommand("/lang fr")).toBeNull();
});

const INFO = { version: "0.5.11", model: "deepseek / deepseek-flash", mode: "auto", cwd: "/home/sj/projects/nyra-cli", branch: "main" };

/** 框线行（╭ │ ╰ 开头）的显示宽度必须一致。 */
function expectBoxAligned(lines: string[]): void {
  const box = lines.map(stripAnsi).filter((l) => /^[╭│╰+|]/.test(l));
  expect(box.length).toBeGreaterThan(2);
  const w = textWidth(box[0]);
  for (const l of box) expect(textWidth(l)).toBe(w);
}

test("I18n.test_header_snapshot_en", () => {
  setLang("en");
  const lines = renderHeader(INFO, { width: 100, color: false, unicode: true, home: "/home/sj" });
  expect(lines.slice(4).join("\n")).toBe([
    " █████▀▀████▀▀█████   Nyra v0.5.11",
    " █████  ████  █████   An open-source AI agent that runs on your computer",
    " █████  ████  █████",
    " ██████████████████",
    " ██████████████████",
    "  ▀██████████████▀",
    "",
    "╭──────────────────────────────────────────╮",
    "│ Model   deepseek / deepseek-flash        │",
    "│ Mode     auto                            │",
    "│ Folder  ~/projects/nyra-cli              │",
    "│ Branch  ⎇ main                           │",
    "╰──────────────────────────────────────────╯",
  ].join("\n"));
  expectBoxAligned(lines);
  // 彩色版去掉 ANSI 后：标志以下逐字一致（标志行是抗锯齿画法，只比宽度）。
  const colored = renderHeader(INFO, { width: 100, color: true, unicode: true, home: "/home/sj" }).map(stripAnsi);
  expect(colored.slice(10)).toEqual(lines.slice(10));
  expect(colored[4]).toEndWith("Nyra v0.5.11");
  expect(textWidth(colored[4])).toBe(textWidth(lines[4]));
  expect(textWidth(colored[5])).toBe(textWidth(lines[5]));
});

test("I18n.test_header_snapshot_zh", () => {
  setLang("zh");
  const lines = renderHeader(INFO, { width: 100, color: false, unicode: true, home: "/home/sj" });
  expect(lines.slice(4).join("\n")).toBe([
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
  expectBoxAligned(lines);
});

test("I18n.test_info_card_aligned_with_cjk_values_both_languages", () => {
  for (const lang of ["zh", "en"] as const) {
    setLang(lang);
    for (const width of [100, 62, 40, 30]) {
      const lines = renderHeader({ ...INFO, model: "通义千问 / qwen-max-最新", cwd: "/home/sj/项目/小工具/很长的中文目录名字" }, { width, unicode: true, home: "/home/sj" });
      expectBoxAligned(lines);
      for (const l of lines) expect(textWidth(stripAnsi(l))).toBeLessThanOrEqual(width);
    }
  }
});

test("I18n.test_trust_prompt_both_languages_aligned", () => {
  for (const lang of ["zh", "en"] as const) {
    setLang(lang);
    const p = renderTrustPrompt("/home/sj/项目/nyra", { width: 80 });
    expectBoxAligned(p.lines);
    expect(p.question).toContain("(y/N)");
  }
  setLang("en");
  expect(stripAnsi(renderTrustPrompt("/x", { width: 80 }).lines[1])).toContain("Do you trust this folder?");
});

test("I18n.test_status_bar_snapshots_and_right_alignment", () => {
  const info = { model: "deepseek / deepseek-flash", mode: "auto", contextUsage: 0.12, branch: "main", cost: null as string | null };
  setLang("en");
  expect(renderStatusBar(info, { width: 80, color: false, unicode: true })).toBe(
    "  deepseek / deepseek-flash  auto                          context 12% · ⎇ main",
  );
  setLang("zh");
  expect(renderStatusBar(info, { width: 80, color: false, unicode: true })).toBe(
    "  deepseek / deepseek-flash  auto                           上下文 12% · ⎇ main",
  );
  // 右侧字段右对齐到 width-1（含中文成本段、中文分支名），两种语言都一样。
  for (const lang of ["zh", "en"] as const) {
    setLang(lang);
    for (const width of [120, 80, 60]) {
      const s = stripAnsi(renderStatusBar({ ...info, cost: t("status.costUnknown"), branch: "功能/双语" }, { width, color: true, unicode: true }));
      expect(textWidth(s)).toBe(width - 1);
    }
  }
});

test("I18n.test_tips_mention_lang_in_both_languages", () => {
  setLang("en");
  expect(renderTips({ width: 100, unicode: true, pet: true })).toBe(" Tips /help commands · /lang zh 中文 · /mode switch mode · /undo undo · /pet buddy");
  setLang("zh");
  expect(renderTips({ width: 120, unicode: true, pet: true })).toBe(" 提示 /help 全部命令 · /lang en English · /mode 切换权限模式 · /undo 撤销改动 · /pet 小伙伴开关");
  // 窄屏从后往前丢，/lang 留到最后。
  expect(renderTips({ width: 40, unicode: true })).toContain("/lang en");
  for (const w of [40, 60, 80]) expect(textWidth(renderTips({ width: w, unicode: true, pet: true }))).toBeLessThanOrEqual(w - 1);
});

test("I18n.test_approval_menu_and_pet_lines_follow_language", () => {
  setLang("en");
  const menu = renderApprovalMenu(approvalOptions(true), 0);
  expect(menu).toContain("Yes, run once");
  expect(menu).toContain("Enter to confirm · Esc to cancel");
  expect(approvalQuip()).toBe("Need your OK here.");
  for (const q of [...idleQuips(), ...happyQuips(), ...worriedQuips(), approvalQuip()]) expect(textWidth(q)).toBeLessThanOrEqual(24);
  setLang("zh");
  expect(renderApprovalMenu(approvalOptions(false), 0)).toContain("是，执行一次");
  expect(approvalQuip()).toBe("这步要你点个头。");
  for (const q of [...idleQuips(), ...happyQuips(), ...worriedQuips()]) expect(textWidth(q)).toBeLessThanOrEqual(24);
});

/** 子进程跑一次 REPL（ollama 不需要 Key、不联网；管道输入 → 非 TTY 纯文本界面）。 */
function runRepl(home: string, input: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), LANG: "en_US.UTF-8", ...extraEnv };
  for (const k of ["NYRA_LANG", "LC_ALL", "LC_MESSAGES", "NYRA_HOOKS", "NYRA_SANDBOX", "NYRA_SANDBOX_MODE"]) if (!(k in extraEnv)) delete env[k];
  const wd = mkdtempSync(join(tmpdir(), "nyra-i18n-wd-"));
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), "--provider", "ollama", "--trust", "--workdir", wd], {
    cwd: process.cwd(), env: env as Record<string, string>, input, encoding: "utf-8", timeout: 60000,
  });
}

test("I18n.test_lang_command_switches_now_and_persists", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-i18n-home-"));
  // 首次启动：系统语言 en_US → 英文，不询问。（管道输入时 REPL 每次只处理一行，所以分几次跑。）
  const first = runRepl(home, "/help\n");
  expect(first.status).toBe(0);
  expect(first.stdout).toContain("Type /help for commands");
  expect(first.stdout).toContain("Commands:");
  expect(first.stdout).toContain("context --");
  // 切换立即生效：确认语与随后重画的状态行都已是中文。
  const sw = runRepl(home, "/lang zh\n");
  expect(sw.status).toBe(0);
  const at = sw.stdout.indexOf("已切换到中文。");
  expect(at).toBeGreaterThan(0);
  expect(sw.stdout.slice(at)).toContain("上下文 --");
  expect(sw.stdout.slice(0, at)).toContain("context --");
  const cfg = JSON.parse(readFileSync(join(home, ".nyra", "config.json"), "utf-8"));
  expect(cfg.language).toBe("zh");
  // 下次启动沿用配置（盖过系统语言 en_US）。
  const second = runRepl(home, "/help\n");
  expect(second.stdout).toContain("输入 /help 查看命令");
  expect(second.stdout).toContain("命令：");
  // NYRA_LANG 盖过配置。
  expect(runRepl(home, "/exit\n", { NYRA_LANG: "en" }).stdout).toContain("Type /help for commands");
  // 切回英文同样持久化。
  expect(runRepl(home, "/lang en\n").stdout).toContain("Switched to English.");
  expect(JSON.parse(readFileSync(join(home, ".nyra", "config.json"), "utf-8")).language).toBe("en");
  // 用法错误
  expect(runRepl(home, "/lang fr\n").stderr).toContain("/lang zh|en");
}, 60000);

test("I18n.test_lang_flag_beats_env_for_help", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-i18n-help-"));
  mkdirSync(join(home, ".nyra"), { recursive: true });
  writeFileSync(join(home, ".nyra", "config.json"), JSON.stringify({ language: "zh" }));
  const env = { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh" } as Record<string, string>;
  const en = spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), "--lang", "en", "--help"], { env, encoding: "utf-8", timeout: 30000 });
  expect(en.status).toBe(0);
  expect(en.stdout).toContain("Usage:");
  const zh = spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), "--help"], { env, encoding: "utf-8", timeout: 30000 });
  expect(zh.stdout).toContain("用法：");
  const bad = spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), "--lang", "fr", "--help"], { env, encoding: "utf-8", timeout: 30000 });
  expect(bad.status).toBe(2);
}, 60000);

test("I18n.test_dashboard_cost_reason_follows_language", async () => {
  const { localizeCostReason } = await import("../../src/dashboard.ts");
  setLang("en");
  expect(localizeCostReason("未配置该模型的单价（config.pricing），无法计算金额")).toBe("no price configured for this model (config.pricing)");
  expect(localizeCostReason("有 3 次调用未上报 usage，金额不完整，不做超支判定")).toContain("3 call(s)");
  expect(localizeCostReason("something else")).toBe("something else");
  setLang("zh");
  expect(localizeCostReason("usage 里没有可用的 token 数")).toBe("usage 里没有可用的 token 数");
});
