// tests/node/test-marketplace-b1b7.test.ts — Hermes Bot Marketplace 借鉴 B1–B7 专项：
// B1 市场 Bot 更新流程（按所有权合并、mode 只严不松、routine 按名合并、墓碑）、
// B2 bot.json 模型钉选、B3 env_requires 与 .env.EXAMPLE、B4 预览写 routine 全文、
// B5 单个 Bot 的 git URL 安装、B6 装完进花名册（声明 + 常驻会话）、
// B7 交接目标声明与现有委派接线。全部 mock-only，不连真实服务、不调模型。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketSource,
  parseBotManifest,
  prepareMarketplaceInstall, prepareMarketplaceInstallFromUrl,
  prepareMarketplaceUpdate, executeMarketplaceUpdate,
  executeMarketplaceInstall, uninstallMarketplaceEntry,
  listInstalled, findInstalled,
  compareVersions, mergeRoutines, mergeBotMode,
  formatRoutinesForDisplay,
  marketBotTemplate, isMarketGitUrl,
  type BotRoutine,
} from "../../src/marketplace.ts";
import { RunStore } from "../../src/runs.ts";
import { listStoredAgentDecls, loadStoredAgentDecl } from "../../src/agentDecl.ts";
import { validateOpts } from "../../src/agentDeclCli.ts";
import { loadSessionBook } from "../../src/session.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function goodSkillMd(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: 一个干净的测试技能",
    "when: 测试时用",
    "keywords: test",
    "---",
    "",
    "# 做法",
    "",
    "先读文件，再动手。",
    "",
  ].join("\n");
}

/** 默认机器人清单（v0.1.0，readonly，无钉模型/环境变量/交接）。 */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "demo-bot",
    version: "0.1.0",
    description: "测试机器人",
    author: "tester",
    license: "MIT",
    homepage: "https://example.com/demo-bot",
    skills: ["demo-skill"],
    tools: ["read_file"],
    permissions: ["fs:read-workspace"],
    mode: "readonly",
    ...overrides,
  };
}

function baseRoutines(): BotRoutine[] {
  return [
    { name: "daily-check", kind: "schedule", schedule: "0 9 * * *", task: "检查一下工作目录里的文件有没有新增", mode: "readonly" },
  ];
}

/** 建一个只含一台机器人的市场源目录并登记到 home；返回源目录。
 * 技能名按机器人名区分（demo-bot-skill），不然同一 home 里装两台
 * 机器人会撞技能名（插件市场不许两个插件提供同名技能）。 */
function seedBotSource(home: string, manifest: Record<string, unknown>, routines?: BotRoutine[]): string {
  const dir = tmpHome("nyra-market-b1b7-src-");
  const botDir = join(dir, "bots", String(manifest.name));
  const skillName = `${manifest.name}-skill`;
  mkdirSync(join(botDir, "skills"), { recursive: true });
  writeFileSync(join(botDir, "bot.json"), JSON.stringify({ ...manifest, skills: [skillName] }, null, 2));
  writeFileSync(join(botDir, "skills", `${skillName}.md`), goodSkillMd(skillName));
  if (routines) writeFileSync(join(botDir, "routines.json"), JSON.stringify(routines, null, 2));
  const index = {
    version: 1,
    name: "test-market-b1b7",
    entries: [
      { id: String(manifest.name), kind: "bot", name: String(manifest.name), version: String(manifest.version), description: String(manifest.description ?? ""), author: "tester", license: "MIT", source: "https://example.com/demo-bot", path: `bots/${manifest.name}`, tools: ["read_file"], permissions: ["fs:read-workspace"], mode: manifest.mode ?? "readonly" },
    ],
  };
  writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
  addMarketSource(home, dir);
  return dir;
}

/** 把源目录里的机器人改写成新版（bot.json + routines.json + index.json 版本一起改）。
 * 技能名同样按机器人名区分（与 seedBotSource 同款口径）。 */
function rewriteBotSource(dir: string, manifest: Record<string, unknown>, routines?: BotRoutine[]): void {
  const botDir = join(dir, "bots", String(manifest.name));
  writeFileSync(join(botDir, "bot.json"), JSON.stringify({ ...manifest, skills: [`${manifest.name}-skill`] }, null, 2));
  if (routines) writeFileSync(join(botDir, "routines.json"), JSON.stringify(routines, null, 2));
  const indexPath = join(dir, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf-8")) as { entries: { id: string; version: string }[] };
  for (const e of index.entries) {
    if (e.id === String(manifest.name)) e.version = String(manifest.version);
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

async function installBot(home: string, id: string, opts: { store?: RunStore; runId?: string } = {}) {
  const prepared = await prepareMarketplaceInstall(home, id, { config: {} });
  return { prepared, result: executeMarketplaceInstall(home, prepared, opts) };
}

function runCli(home: string, args: string[], input?: string) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    input,
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

/** B5 测试用的工作区外暂存（不在 /tmp 上：全量套件跑到后面会把 512M 的 /tmp 写满，
 * 这两项要建 git 仓库 + 跑 git clone + spawn CLI，/tmp 满了就装不上；用完 finally 清掉）。 */
function scratchHome(prefix: string): string {
  const base = join(process.env.HOME ?? tmpdir(), "workspace", "nyra-market-b1b7-test-scratch");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

/** 建一个只含一台机器人的本地 git 仓库（B5 用 file:// 装它，不联网）。 */
function seedGitBotRepo(manifest: Record<string, unknown> = baseManifest()): { dir: string; url: string } {
  const dir = scratchHome("nyra-market-b1b7-git-");
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "bot.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "skills", "demo-skill.md"), goodSkillMd("demo-skill"));
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf-8" });
  const init = git("init");
  expect(init.status).toBe(0);
  expect(git("add", "-A").status).toBe(0);
  expect(git("commit", "-m", "init").status).toBe(0);
  return { dir, url: `file://${dir}` };
}

// ---- B2/B3/B7：bot.json 新字段的解析校验 ----

test("MarketplaceB1B7Test.test_parse_bot_manifest_new_fields_ok", () => {
  const dir = tmpHome("nyra-market-b1b7-bot-");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({
    model: "deepseek-flash",
    env_requires: [
      { name: "MY_API_KEY", description: "测试密钥", required: true },
      { name: "OPTIONAL_FLAG", description: "可选开关", required: false, default: "off" },
    ],
    hands_off_to: [{ target: "helper-bot", when: "需要帮忙时交给它" }],
  }), null, 2));
  const m = parseBotManifest(dir);
  expect(m.model).toBe("deepseek-flash");
  expect(m.env_requires?.length).toBe(2);
  expect(m.env_requires?.[0].name).toBe("MY_API_KEY");
  expect(m.hands_off_to?.[0].target).toBe("helper-bot");
});

test("MarketplaceB1B7Test.test_parse_bot_manifest_rejects_bad_model", () => {
  const dir = tmpHome("nyra-market-b1b7-bot-");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ model: "" }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("model");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ model: "x".repeat(129) }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("model");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ model: 42 }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("model");
});

test("MarketplaceB1B7Test.test_parse_bot_manifest_rejects_bad_env_requires", () => {
  const dir = tmpHome("nyra-market-b1b7-bot-");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ env_requires: [] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("env_requires");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ env_requires: [{ name: "my_key", description: "小写名", required: true }] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("env_requires");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ env_requires: [{ name: "MY_KEY", description: "必填不是布尔", required: "yes" }] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("env_requires");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ env_requires: [{ name: "MY_KEY", description: "默认值太长", required: false, default: "x".repeat(201) }] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("env_requires");
});

test("MarketplaceB1B7Test.test_parse_bot_manifest_rejects_bad_hands_off_to", () => {
  const dir = tmpHome("nyra-market-b1b7-bot-");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ hands_off_to: [] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("hands_off_to");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ hands_off_to: [{ target: "Bad Name", when: "x" }] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("hands_off_to");
  writeFileSync(join(dir, "bot.json"), JSON.stringify(baseManifest({ hands_off_to: [{ target: "helper-bot", when: "" }] }), null, 2));
  expect(() => parseBotManifest(dir)).toThrow("hands_off_to");
});

test("MarketplaceB1B7Test.test_bot_template_has_new_fields", () => {
  const tpl = marketBotTemplate();
  expect(tpl).toContain("model");
  expect(tpl).toContain("env_requires");
  expect(tpl).toContain("hands_off_to");
  // 模板本身须能过解析（示例值要合法）。
  const dir = tmpHome("nyra-market-b1b7-bot-");
  writeFileSync(join(dir, "bot.json"), tpl);
  const m = parseBotManifest(dir);
  expect(m.model).toBe("deepseek-flash");
});

// ---- B2：模型钉选 ----

test("MarketplaceB1B7Test.test_install_rejects_unknown_model", async () => {
  const home = tmpHome("nyra-market-b1b7-home-");
  seedBotSource(home, baseManifest({ model: "no-such-model-xyz" }), baseRoutines());
  await expect(prepareMarketplaceInstall(home, "demo-bot", { config: {} })).rejects.toThrow("不是已配置的模型");
});

test("MarketplaceB1B7Test.test_install_records_pinned_model", async () => {
  const home = tmpHome("nyra-market-b1b7-home-");
  seedBotSource(home, baseManifest({ model: "deepseek-flash" }), baseRoutines());
  const { result } = await installBot(home, "demo-bot");
  expect(result.installed.model).toBe("deepseek-flash");
  expect(findInstalled(home, "demo-bot")?.model).toBe("deepseek-flash");
  // 花名册声明里也钉着同一个模型（nyra agent run 就用它）。
  const decl = loadStoredAgentDecl(home, "demo-bot", validateOpts(home));
  expect(decl.model).toBe("deepseek-flash");
});

// ---- B3：env_requires 与 .env.EXAMPLE ----

test("MarketplaceB1B7Test.test_install_writes_env_example", async () => {
  const home = tmpHome("nyra-market-b1b7-home-");
  seedBotSource(home, baseManifest({
    env_requires: [
      { name: "MY_API_KEY", description: "测试密钥", required: true },
      { name: "OPTIONAL_FLAG", description: "可选开关", required: false },
    ],
  }), baseRoutines());
  const { result } = await installBot(home, "demo-bot");
  const example = join(home, "plugins", "demo-bot", ".env.EXAMPLE");
  expect(existsSync(example)).toBe(true);
  const text = readFileSync(example, "utf-8");
  expect(text).toContain("MY_API_KEY");
  expect(text).toContain("测试密钥");
  expect(text).toContain("OPTIONAL_FLAG");
  // 只写名字与说明，不写值（连“示例值”都不写）。
  expect(text).not.toContain("sk-");
  expect(findInstalled(home, "demo-bot")?.env_requires?.length).toBe(2);
  expect(result.installed.env_requires?.[0].name).toBe("MY_API_KEY");
});

test("MarketplaceB1B7Test.test_install_plan_reports_env_set_unset", async () => {
  const home = tmpHome("nyra-market-b1b7-home-");
  seedBotSource(home, baseManifest({
    env_requires: [{ name: "MY_API_KEY", description: "测试密钥", required: true }],
  }), baseRoutines());
  process.env.MY_API_KEY = "test-value-not-a-real-key";
  try {
    const p1 = await prepareMarketplaceInstall(home, "demo-bot", { config: {} });
    expect(p1.plannedChanges.join("\n")).toContain("MY_API_KEY（必填）：已设置");
    // 值绝不进预览。
    expect(p1.plannedChanges.join("\n")).not.toContain("test-value-not-a-real-key");
  } finally {
    delete process.env.MY_API_KEY;
  }
  const p2 = await prepareMarketplaceInstall(home, "demo-bot", { config: {} });
  expect(p2.plannedChanges.join("\n")).toContain("MY_API_KEY（必填）：未设置");
});

test("MarketplaceB1B7Test.test_uninstall_removes_env_example", async () => {
  const home = tmpHome("nyra-market-b1b7-home-");
  seedBotSource(home, baseManifest({
    env_requires: [{ name: "MY_API_KEY", description: "测试密钥", required: true }],
  }), baseRoutines());
  await installBot(home, "demo-bot");
  expect(existsSync(join(home, "plugins", "demo-bot", ".env.EXAMPLE"))).toBe(true);
  const out = uninstallMarketplaceEntry(home, "demo-bot");
  expect(out.removed).toContain(".env.EXAMPLE");
  expect(existsSync(join(home, "plugins", "demo-bot", ".env.EXAMPLE"))).toBe(false);
});

// ---- B4：预览写 routine 全文 ----

test("MarketplaceB1B7Test.test_install_plan_lists_routine_text", async () => {
  const home = tmpHome("nyra-market-b1b7-home-");
  seedBotSource(home, baseManifest(), baseRoutines());
  const prepared = await prepareMarketplaceInstall(home, "demo-bot", { config: {} });
  const plan = prepared.plannedChanges.join("\n");
  expect(plan).toContain("daily-check");
  expect(plan).toContain("检查一下工作目录里的文件有没有新增");
});

test("MarketplaceB1B7Test.test_routine_display_truncates_long_task", () => {
  const lines = formatRoutinesForDisplay([
    { name: "long-one", kind: "schedule", schedule: "0 9 * * *", task: "x".repeat(500), mode: "readonly" },
  ]);
  const text = lines.join("\n");
  expect(text).toContain("long-one");
  expect(text).toContain("全文在条目目录 routines.json 里");
  expect(text).not.toContain("x".repeat(500));
});

// ---- B5：单个 Bot 的 git URL 安装 ----

test("MarketplaceB1B7Test.test_is_market_git_url", () => {
expect(isMarketGitUrl("https://github.com/js2005happy/nyra-community.git")).toBe(true);
expect(isMarketGitUrl("git@github.com:js2005happy/nyra-community.git")).toBe(true);
expect(isMarketGitUrl("file:///tmp/some-bot")).toBe(true);
expect(isMarketGitUrl("https://example.com/bot.zip")).toBe(false);
expect(isMarketGitUrl("http://example.com/bot.git")).toBe(false);
expect(isMarketGitUrl("")).toBe(false);
expect(isMarketGitUrl("demo-bot")).toBe(false);
});

test("MarketplaceB1B7Test.test_install_from_git_url", async () => {
const home = scratchHome("nyra-market-b1b7-home-");
const repo = seedGitBotRepo(baseManifest({ model: "deepseek-flash"}));
try {
const { url } = repo;
const prepared = await prepareMarketplaceInstallFromUrl(home, url, { config: {}});
expect(prepared.entry.name).toBe("demo-bot");
const tempDir = prepared.dir;
// 临时克隆目录在 ~/.nyra/marketplace-tmp/ 下，不在 /tmp 上。
expect(tempDir.startsWith(join(home, ".nyra", "marketplace-tmp"))).toBe(true);
const result = executeMarketplaceInstall(home, prepared, {});
prepared.cleanup?.();
expect(result.installed.kind).toBe("bot");
expect(result.installed.source_url).toBe(url);
expect(existsSync(join(home, "plugins", "demo-bot", "bot.json"))).toBe(true);
expect(existsSync(join(home, "plugins", "demo-bot", "skills", "demo-skill.md"))).toBe(true);
// 临时克隆目录已清掉（.git 不会留下来）。
expect(existsSync(tempDir)).toBe(false);
expect(findInstalled(home, "demo-bot")?.source_url).toBe(url);
} finally {
rmSync(home, { recursive: true, force: true });
rmSync(repo.dir, { recursive: true, force: true });
}
});

test("MarketplaceB1B7Test.test_install_from_url_rejects_zip_and_non_bot", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
await expect(prepareMarketplaceInstallFromUrl(home, "https://example.com/bot.zip", { config: {}})).rejects.toThrow("不是 git 地址");
await expect(prepareMarketplaceInstallFromUrl(home, "not-a-url", { config: {}})).rejects.toThrow("不是 git 地址");
// 有 git 仓库但根目录没有 bot.json。
const dir = tmpHome("nyra-market-b1b7-git-");
writeFileSync(join(dir, "README.md"), "# 不是机器人\n");
const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",...args], { cwd: dir, encoding: "utf-8"});
expect(git("init").status).toBe(0);
expect(git("add", "-A").status).toBe(0);
expect(git("commit", "-m", "init").status).toBe(0);
await expect(prepareMarketplaceInstallFromUrl(home, `file://${dir}`, { config: {}})).rejects.toThrow("不是单个 Bot");
});

// ---- B6：装完进花名册 ----

test("MarketplaceB1B7Test.test_install_enrolls_roster_and_session", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest({ model: "deepseek-flash"}), baseRoutines());
const store = new RunStore(join(home, "runs"));
const run = store.create("marketplace install demo-bot", "cli", home, "readonly", 1);
const { result} = await installBot(home, "demo-bot", { store, runId: run.run_id});
expect(result.installed.agent_decl).toBe(true);
expect(result.installed.agent_session_id).toBeDefined();
// 声明进花名册：nyra agent list 的来源就是这张表。
const decls = listStoredAgentDecls(home, validateOpts(home)).decls;
expect(decls.map((d) => d.name)).toContain("demo-bot");
const decl = loadStoredAgentDecl(home, "demo-bot", validateOpts(home));
expect(decl.instructions).toContain("");
expect(decl.model).toBe("deepseek-flash");
// 常驻会话在账本里（复用联合会话账本，不另起存储）。
const book = loadSessionBook(home);
const session = book.sessions.find((s) => s.id === result.installed.agent_session_id);
expect(session).toBeDefined();
expect(session!.title).toBe("Bot demo-bot 的常驻会话");
expect(session!.status).toBe("active");
});

test("MarketplaceB1B7Test.test_uninstall_cleans_roster_and_session", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest(), baseRoutines());
const { result} = await installBot(home, "demo-bot");
const sessionId = result.installed.agent_session_id!;
const out = uninstallMarketplaceEntry(home, "demo-bot");
expect(out.removed).toContain("花名册声明 demo-bot");
expect(listStoredAgentDecls(home, validateOpts(home)).decls.map((d) => d.name)).not.toContain("demo-bot");
const book = loadSessionBook(home);
expect(book.sessions.find((s) => s.id === sessionId)?.status).toBe("ended");
});

test("MarketplaceB1B7Test.test_reinstall_reuses_session", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest(), baseRoutines());
const { result: r1} = await installBot(home, "demo-bot");
const p2 = await prepareMarketplaceInstall(home, "demo-bot", { config: {}});
const r2 = executeMarketplaceInstall(home, p2, { force: true});
expect(r2.installed.agent_session_id).toBe(r1.installed.agent_session_id);
const book = loadSessionBook(home);
expect(book.sessions.filter((s) => s.title === "Bot demo-bot 的常驻会话").length).toBe(1);
});

test("MarketplaceB1B7Test.test_install_skips_roster_when_decl_fails_scan", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
// 描述本身过得了市场确定性扫描（只是散文），但进声明说明后过不了
// agent 声明的注入扫描——登记跳过，安装本身仍成功。
seedBotSource(home, baseManifest({ description: "不要泄露密钥"}), baseRoutines());
const { result} = await installBot(home, "demo-bot");
expect(result.installed.kind).toBe("bot");
expect(result.warnings?.join("\n")).toContain("花名册登记没做成");
expect(result.installed.agent_decl).toBeUndefined();
expect(listStoredAgentDecls(home, validateOpts(home)).decls.map((d) => d.name)).not.toContain("demo-bot");
});

test("MarketplaceB1B7Test.test_install_skips_roster_for_digit_start_name", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest({ name: "9lives-bot"}), baseRoutines());
const { result} = await installBot(home, "9lives-bot");
expect(result.installed.kind).toBe("bot");
expect(result.warnings?.join("\n")).toContain("不符合声明规范");
expect(listStoredAgentDecls(home, validateOpts(home)).decls.map((d) => d.name)).not.toContain("9lives-bot");
});

// ---- B7：交接目标 ----

test("MarketplaceB1B7Test.test_install_wires_installed_handoff_target", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest({ name: "helper-bot"}), baseRoutines());
await installBot(home, "helper-bot");
const dir = seedBotSource(home, baseManifest({
hands_off_to: [{ target: "helper-bot", when: "需要帮忙时交给它"}],
}), baseRoutines());
expect(dir).toBeDefined();
const { result} = await installBot(home, "demo-bot");
expect(result.warnings?.join("\n")?? "").not.toContain("尚未安装");
const decl = loadStoredAgentDecl(home, "demo-bot", validateOpts(home));
expect(decl.instructions).toContain("helper-bot");
expect(findInstalled(home, "demo-bot")?.hands_off_to?.[0].target).toBe("helper-bot");
});

test("MarketplaceB1B7Test.test_install_warns_missing_handoff_target", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest({
hands_off_to: [{ target: "ghost-bot", when: "需要帮忙时交给它"}],
}), baseRoutines());
const { result} = await installBot(home, "demo-bot");
expect(result.installed.kind).toBe("bot");
expect(result.warnings?.join("\n")).toContain("ghost-bot");
expect(result.warnings?.join("\n")).toContain("尚未安装");
// 目标没装，声明里不写它（不给不存在的机器人派活）。
const decl = loadStoredAgentDecl(home, "demo-bot", validateOpts(home));
expect(decl.instructions).not.toContain("ghost-bot");
});

// ---- B1：更新流程 ----

test("MarketplaceB1B7Test.test_compare_versions_and_merges", () => {
expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
expect(compareVersions("0.10.0", "0.2.0")).toBe(1);
expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
expect(compareVersions("abc", "0.1.0")).toBe(null);
expect(mergeBotMode("readonly", "auto")).toBe("readonly");
expect(mergeBotMode("auto", "auto")).toBe("auto");
expect(mergeBotMode(undefined, "auto")).toBe("readonly");
const merged = mergeRoutines(
[
{ name: "a", kind: "schedule", schedule: "0 9 * * *", task: "旧 a", mode: "readonly"},
{ name: "b", kind: "schedule", schedule: "0 9 * * *", task: "旧 b", mode: "readonly"},
],
[
{ name: "b", kind: "schedule", schedule: "0 9 * * *", task: "新 b", mode: "readonly"},
{ name: "c", kind: "schedule", schedule: "0 9 * * *", task: "新 c", mode: "readonly"},
],
);
expect(merged.map((r) => r.name)).toEqual(["b", "c", "a"]);
expect(merged[0].task).toBe("新 b");
});

test("MarketplaceB1B7Test.test_update_merges_and_keeps_user_changes", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
const dir = seedBotSource(home, baseManifest({ mode: "readonly"}), baseRoutines());
const store = new RunStore(join(home, "runs"));
const run = store.create("marketplace install demo-bot", "cli", home, "readonly", 1);
await installBot(home, "demo-bot", { store, runId: run.run_id});
// 用户改过技能文件 + 自己加了一条 routine。
const skillPath = join(home, "plugins", "demo-bot", "skills", "demo-bot-skill.md");
writeFileSync(skillPath, readFileSync(skillPath, "utf-8") + "\n我改过。\n");
const installedRoutines = JSON.parse(readFileSync(join(home, "plugins", "demo-bot", "routines.json"), "utf-8")) as BotRoutine[];
installedRoutines.push({ name: "my-own", kind: "schedule", schedule: "0 10 * * *", task: "我自己的例行检查", mode: "readonly"});
writeFileSync(join(home, "plugins", "demo-bot", "routines.json"), JSON.stringify(installedRoutines, null, 2));
// 新版 v0.2.0：mode 放宽到 auto（更新后仍须是 readonly），routine 刷新 + 新增。
rewriteBotSource(dir, baseManifest({ version: "0.2.0", mode: "auto"}), [
{ name: "daily-check", kind: "schedule", schedule: "0 9 * * *", task: "新版检查任务全文", mode: "readonly"},
{ name: "weekly-report", kind: "schedule", schedule: "0 9 * * 1", task: "每周汇总一次", mode: "readonly"},
]);
const plan = await prepareMarketplaceUpdate(home, "demo-bot", { config: {}});
expect(plan.needsUpdate).toBe(true);
expect(plan.previousVersion).toBe("0.1.0");
expect(plan.newVersion).toBe("0.2.0");
expect(plan.modifiedFiles.join("\n")).toContain("demo-bot-skill.md");
expect(plan.manifestModified).toContain("routines.json");
const res = executeMarketplaceUpdate(home, plan, { store, runId: run.run_id});
expect(res.updated).toBe(true);
expect(res.version).toBe("0.2.0");
expect(res.mode).toBe("readonly");
expect(res.routinesMerged).toBe(3);
expect(res.keptModified.join("\n")).toContain("demo-bot-skill.md");
expect(readFileSync(skillPath, "utf-8")).toContain("我改过。");
const merged = JSON.parse(readFileSync(join(home, "plugins", "demo-bot", "routines.json"), "utf-8")) as BotRoutine[];
expect(merged.map((r) => r.name)).toEqual(["daily-check", "weekly-report", "my-own"]);
expect(merged[0].task).toBe("新版检查任务全文");
const installedBot = JSON.parse(readFileSync(join(home, "plugins", "demo-bot", "bot.json"), "utf-8")) as { mode: string};
expect(installedBot.mode).toBe("readonly");
// 账本原地改版本（不另起一条记录），卸载历史不断。
const ledger = listInstalled(home);
expect(ledger.length).toBe(1);
expect(ledger[0].version).toBe("0.2.0");
expect(ledger[0].previous_version).toBe("0.1.0");
expect(ledger[0].updated_at).toBeDefined();
expect(ledger[0].installed_at).toBeDefined();
expect(ledger[0].status).toBe("installed");
const events = store.readEvents(run.run_id);
expect(events.some((e) => e.type === "marketplace_updated")).toBe(true);
expect(JSON.stringify(events)).not.toContain(home);
});

test("MarketplaceB1B7Test.test_update_already_latest_and_downgrade", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
const dir = seedBotSource(home, baseManifest({ version: "0.2.0"}), baseRoutines());
await installBot(home, "demo-bot");
const plan = await prepareMarketplaceUpdate(home, "demo-bot", { config: {}});
expect(plan.needsUpdate).toBe(false);
expect(plan.planLines.join("\n")).toContain("已是最新版");
const res = executeMarketplaceUpdate(home, plan, {});
expect(res.updated).toBe(false);
// 市场版比已装版旧：拒绝降级。
rewriteBotSource(dir, baseManifest({ version: "0.1.0"}), baseRoutines());
await expect(prepareMarketplaceUpdate(home, "demo-bot", { config: {}})).rejects.toThrow("不降级");
});

test("MarketplaceB1B7Test.test_update_never_revives_uninstalled", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
seedBotSource(home, baseManifest(), baseRoutines());
await installBot(home, "demo-bot");
uninstallMarketplaceEntry(home, "demo-bot");
expect(findInstalled(home, "demo-bot")).toBeNull();
await expect(prepareMarketplaceUpdate(home, "demo-bot", { config: {}})).rejects.toThrow("不会把它复活");
});

test("MarketplaceB1B7Test.test_update_resyncs_roster_decl", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
const dir = seedBotSource(home, baseManifest({ description: "测试机器人"}), baseRoutines());
await installBot(home, "demo-bot");
// 先装好交接目标，再更新本机器人（新描述 + 新交接）。
seedBotSource(home, baseManifest({ name: "helper-bot"}), baseRoutines());
await installBot(home, "helper-bot");
rewriteBotSource(dir, baseManifest({
version: "0.2.0",
description: "测试机器人第二版",
hands_off_to: [{ target: "helper-bot", when: "需要帮忙时交给它"}],
}), baseRoutines());
const plan = await prepareMarketplaceUpdate(home, "demo-bot", { config: {}});
const res = executeMarketplaceUpdate(home, plan, {});
expect(res.updated).toBe(true);
const decl = loadStoredAgentDecl(home, "demo-bot", validateOpts(home));
expect(decl.instructions).toContain("测试机器人第二版");
expect(decl.instructions).toContain("helper-bot");
});

test("MarketplaceB1B7Test.test_update_keeps_user_modified_decl", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
const dir = seedBotSource(home, baseManifest({ description: "测试机器人"}), baseRoutines());
await installBot(home, "demo-bot");
// 用户自己改了声明说明（不再是市场生成的版本）。
const declPath = join(home, ".nyra", "agents", "demo-bot.json");
const declJson = JSON.parse(readFileSync(declPath, "utf-8")) as Record<string, unknown>;
declJson.instructions = "我自己写的说明";
writeFileSync(declPath, JSON.stringify(declJson, null, 2));
rewriteBotSource(dir, baseManifest({ version: "0.2.0", description: "测试机器人第二版"}), baseRoutines());
const plan = await prepareMarketplaceUpdate(home, "demo-bot", { config: {}});
const res = executeMarketplaceUpdate(home, plan, {});
expect(res.updated).toBe(true);
expect(res.warnings.join("\n")).toContain("你改过");
const decl = loadStoredAgentDecl(home, "demo-bot", validateOpts(home));
expect(decl.instructions).toBe("我自己写的说明");
});

// ---- CLI：update 与 URL 安装、show 写全文 ----

test("MarketplaceB1B7Test.test_cli_update_and_show", async () => {
const home = tmpHome("nyra-market-b1b7-home-");
const dir = seedBotSource(home, baseManifest({ model: "deepseek-flash"}), baseRoutines());
const install = runCli(home, ["market", "install", "demo-bot"], "y\n");
expect(install.status).toBe(0);
expect(install.stdout).toContain("已安装 demo-bot");
expect(install.stdout).toContain("已登记进花名册");
const show = runCli(home, ["market", "show", "demo-bot"]);
expect(show.status).toBe(0);
expect(show.stdout).toContain("模型钉选：deepseek-flash");
expect(show.stdout).toContain("检查一下工作目录里的文件有没有新增");
rewriteBotSource(dir, baseManifest({ version: "0.2.0", model: "deepseek-flash"}), baseRoutines());
const update = runCli(home, ["market", "update", "demo-bot"], "y\n");
expect(update.status).toBe(0);
expect(update.stdout).toContain("已更新 demo-bot");
expect(update.stdout).toContain("v0.1.0 → v0.2.0");
const installed = runCli(home, ["market", "installed"]);
expect(installed.stdout).toContain("demo-bot");
expect(installed.stdout).toContain("v0.2.0");
});

test("MarketplaceB1B7Test.test_cli_install_from_git_url", async () => {
const home = scratchHome("nyra-market-b1b7-home-");
const repo = seedGitBotRepo();
try {
const { url } = repo;
const install = runCli(home, ["market", "install", url], "y\n");
expect(install.status).toBe(0);
expect(install.stdout).toContain("已安装 demo-bot");
expect(existsSync(join(home, "plugins", "demo-bot", "bot.json"))).toBe(true);
} finally {
rmSync(home, { recursive: true, force: true });
rmSync(repo.dir, { recursive: true, force: true });
}
});
