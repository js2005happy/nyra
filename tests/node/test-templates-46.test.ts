// tests/node/test-templates-46.test.ts — 缺口 46 第一批：业务流程模板库。
//
// 覆盖：模板格式解析与校验（连接器/验收标准/红线引用/审批覆盖/禁做检查）、
// 内置 5 个模板全量校验、导入/试跑/激活/执行/删除全流程两道门、验收不通过
// 拦激活、执行前重核红线、账本损坏备份、市场 kind template 接线（校验、
// 确定性规则、Bot Ready、安装/卸载、发布 dry-run）、CLI 入口冒烟。
// 全部在临时 home 里跑，不碰真模型（llm 节点用假 provider；试跑模板是纯
// 工具流程）、不碰真 Gmail（发信步骤只做校验，或用 if 关掉再试跑）。
import { test, expect } from "bun:test";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync,
  existsSync, readdirSync,
} from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTemplateText, validateTemplateDefinition, validateBuiltinTemplates,
  importBuiltinTemplate, importTemplateText, listTemplates, loadTemplateDefinition,
  trialTemplate, activateTemplate, runTemplate, dryRunTemplate, removeTemplate,
  handleTemplate, BUILTIN_TEMPLATE_SHOP_ORDER,
  templatesDir,
} from "../../src/templates.ts";
import type { WorkflowRunRequest } from "../../src/workflow.ts";
import type { ProviderLike } from "../../src/providers.ts";
import { KNOWN_TOOLS } from "../../src/creator.ts";
import { applyRedlineChange } from "../../src/businessRedlines.ts";
import { loadWorkflowRegistry } from "../../src/workflow.ts";
import {
  verifyMarketplaceEntry, scanMarketplaceEntry, computeBotReadyForDir,
  addMarketSource, prepareMarketplaceInstall, executeMarketplaceInstall,
  uninstallMarketplaceEntry, publishMarketplaceEntry,
} from "../../src/marketplace.ts";
import type { MarketEntryMeta } from "../../src/marketplace.ts";
import { RunStore } from "../../src/runs.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-tpl-test-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function fakeProvider(): ProviderLike {
  return {
    name: "fake",
    model: "fake-model",
    baseUrl: "",
    hasCredentials: () => true,
    chat: async () => ({
      choices: [{ message: { content: "FAKE-REPLY" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    listModels: async () => ["fake-model"],
    redact: (t: string) => t,
  };
}

function reqFor(workdir: string): WorkflowRunRequest {
  return {
    workdir,
    mode: "normal",
    interactive: false,
    providerFactory: async () => fakeProvider(),
    maxCostUsd: 2,
  };
}

/** 纯工具试跑模板：读试跑数据、写一份汇总（无模型、无发信，可真跑）。 */
const TOOL_ONLY_TEMPLATE = `name: tool_only_test
version: 1.0.0
license: MIT
description: "测试用纯工具模板"
acceptance:
  - "has-changes"
  - "file-exists:out.txt"
trial:
  inputs:
    in_path: "input.txt"
    out_path: "out.txt"
trial_files:
  - path: "input.txt"
    content: "测试输入：三行数据。"
workflow:
  name: tool_only_test
  version: 1
  mode: fixed
  inputs:
    in_path: "input.txt"
    out_path: "out.txt"
  steps:
    - id: read_input
      type: tool
      tool: read_file
      args:
        path: "{{inputs.in_path}}"
    - id: write_out
      type: tool
      tool: write_file
      args:
        path: "{{inputs.out_path}}"
        content: "{{steps.read_input.output}}"
`;

/** 发信模板（只做校验与审批覆盖测试，不真跑发信步骤）。 */
const SEND_TEMPLATE = `name: send_test
version: 1.0.0
license: MIT
description: "测试用发信模板"
connectors:
  - "gmail"
acceptance:
  - "has-changes"
  - "file-exists:draft.txt"
approve_actions:
  - "send_message"
trial:
  inputs:
    draft_path: "draft.txt"
    customer_email: "test@example.com"
workflow:
  name: send_test
  version: 1
  mode: fixed
  inputs:
    draft_path: "draft.txt"
    customer_email: "test@example.com"
  steps:
    - id: write_draft
      type: tool
      tool: write_file
      args:
        path: "{{inputs.draft_path}}"
        content: "草稿"
    - id: approve_send
      type: approve
      title: "确认发出？"
    - id: send_mail
      type: tool
      tool: gmail_send
      args:
        to:
          - "{{inputs.customer_email}}"
        subject: "测试"
        body: "正文"
`;

function sendTemplateNoApprove(): string {
  return SEND_TEMPLATE.replace("    - id: approve_send\n      type: approve\n      title: \"确认发出？\"\n", "");
}

function sendTemplateNeverSend(): string {
  return SEND_TEMPLATE.replace("approve_actions:\n  - \"send_message\"\n",
    "never_actions:\n  - \"send_message\"\n");
}

/** 发信步骤用输入开关关掉的模板：试跑能跑完，执行前重核红线可测。 */
const SEND_GATED_TEMPLATE = SEND_TEMPLATE.replace("name: send_test", "name: send_gated_test")
  .replace("name: send_test\n  version: 1", "name: send_gated_test\n  version: 1")
  .replace("    customer_email: \"test@example.com\"\n  steps:", "    customer_email: \"test@example.com\"\n    really_send: false\n  steps:")
  .replace("    customer_email: \"test@example.com\"\nworkflow:", "    customer_email: \"test@example.com\"\n    really_send: false\nworkflow:")
  .replace("    - id: send_mail\n      type: tool\n      tool: gmail_send",
    "    - id: send_mail\n      type: tool\n      tool: gmail_send\n      if: \"inputs.really_send\"")
  .replace("    - id: approve_send\n      type: approve\n      title: \"确认发出？\"",
    "    - id: approve_send\n      type: approve\n      title: \"确认发出？\"\n      if: \"inputs.really_send\"");

test("Templates46Test.test_parse_and_validate_minimal", () => {
  const def = validateTemplateDefinition(parseTemplateText(TOOL_ONLY_TEMPLATE, "t.yaml"), KNOWN_TOOLS, null);
  expect(def.name).toBe("tool_only_test");
  expect(def.workflow.steps.length).toBe(2);
  expect(def.acceptance).toEqual(["has-changes", "file-exists:out.txt"]);
});

test("Templates46Test.test_builtins_all_validate", () => {
  const defs = validateBuiltinTemplates(KNOWN_TOOLS);
  expect(defs.map((d) => d.id)).toEqual([
    "shop_order_followup", "overdue_invoice", "expense_review", "onboarding", "meeting_followup",
  ]);
  for (const { def } of defs) {
    expect(def.workflow.name).toBe(def.name);
    expect(def.license).toBe("MIT");
    expect(def.acceptance.length).toBeGreaterThan(0);
  }
});

test("Templates46Test.test_builtin_shop_redlines", () => {
  const defs = validateBuiltinTemplates(null);
  const shop = defs.find((d) => d.id === "shop_order_followup")!.def;
  expect(shop.connectors).toEqual(["shopify", "gmail"]);
  expect(shop.approve_actions).toContain("send_message");
  expect(shop.never_actions).toContain("pay");
  expect(shop.never_actions).toContain("delete");
  expect(shop.acceptance).toContain("has-changes");
  // 缺口 44 深化：第一步改走 shopify_orders 直查订单，不再走 Gmail 搜邮件；
  // 试跑种子文件 order-mail.txt 已删，说明里的“尚未接入”也已删。
  expect(shop.workflow.steps[0]?.tool).toBe("shopify_orders");
  expect(shop.workflow.steps[0]?.id).toBe("fetch_order");
  expect(shop.trial_files).toBeUndefined();
  expect(shop.description).not.toContain("尚未接入");
});

test("Templates46Test.test_import_builtin_draft", () => {
  const home = tempHome();
  try {
    const entry = importBuiltinTemplate(home, "expense_review", KNOWN_TOOLS);
    expect(entry.status).toBe("draft");
    expect(entry.source).toBe("builtin");
    const file = join(templatesDir(home), entry.file);
    expect(existsSync(file)).toBe(true);
    expectPerms(file, 0o600);
    expect(listTemplates(home).map((t) => t.name)).toContain("expense_review");
    expect(() => importBuiltinTemplate(home, "expense_review", KNOWN_TOOLS)).not.toThrow();
    expect(listTemplates(home).length).toBe(1);
  } finally { cleanup(home); }
});

test("Templates46Test.test_import_rejects_send_without_approve", () => {
  const home = tempHome();
  try {
    expect(() => importTemplateText(home, sendTemplateNoApprove(), "s.yaml", "local", KNOWN_TOOLS))
      .toThrow("没有审批节点");
  } finally { cleanup(home); }
});

test("Templates46Test.test_import_rejects_never_action", () => {
  const home = tempHome();
  try {
    expect(() => importTemplateText(home, sendTemplateNeverSend(), "s.yaml", "local", KNOWN_TOOLS))
      .toThrow("禁了它");
  } finally { cleanup(home); }
});

test("Templates46Test.test_import_rejects_unknown_connector_checker_and_overlap", () => {
  const home = tempHome();
  try {
    const badConnector = TOOL_ONLY_TEMPLATE.replace("description: \"测试用纯工具模板\"\n",
      "description: \"测试用纯工具模板\"\nconnectors:\n  - \"nope\"\n");
    expect(() => importTemplateText(home, badConnector, "t.yaml", "local", KNOWN_TOOLS)).toThrow("没有这个连接器");
    const badChecker = TOOL_ONLY_TEMPLATE.replace('  - "has-changes"', '  - "no_such_checker"');
    expect(() => importTemplateText(home, badChecker, "t.yaml", "local", KNOWN_TOOLS)).toThrow("未知 checker");
    const overlap = TOOL_ONLY_TEMPLATE.replace("acceptance:\n  - \"has-changes\"\n  - \"file-exists:out.txt\"\n",
      "acceptance:\n  - \"has-changes\"\n  - \"file-exists:out.txt\"\napprove_actions:\n  - \"send_message\"\nnever_actions:\n  - \"send_message\"\n");
    expect(() => importTemplateText(home, overlap, "t.yaml", "local", KNOWN_TOOLS)).toThrow("不能同时在");
  } finally { cleanup(home); }
});

test("Templates46Test.test_import_rejects_name_mismatch_and_bad_trial_input", () => {
  const home = tempHome();
  try {
    const mismatch = TOOL_ONLY_TEMPLATE.replace("  name: tool_only_test\n  version: 1", "  name: other_name\n  version: 1");
    expect(() => importTemplateText(home, mismatch, "t.yaml", "local", KNOWN_TOOLS)).toThrow("须与模板名");
    const badInput = TOOL_ONLY_TEMPLATE.replace('    in_path: "input.txt"', '    in_path: "input.txt"\n    nope: "x"');
    expect(() => importTemplateText(home, badInput, "t.yaml", "local", KNOWN_TOOLS)).toThrow("没有声明 inputs.nope");
  } finally { cleanup(home); }
});

test("Templates46Test.test_import_rejects_redline_never", () => {
  const home = tempHome();
  try {
    applyRedlineChange(home, "gmail", "send_message", "never");
    expect(() => importTemplateText(home, SEND_TEMPLATE, "s.yaml", "local", KNOWN_TOOLS))
      .toThrow("永远禁做");
  } finally { cleanup(home); }
});

test("Templates46Test.test_dry_run_lists_writes_without_executing", () => {
  const home = tempHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tpl-work-"));
  try {
    importTemplateText(home, TOOL_ONLY_TEMPLATE, "t.yaml", "local", KNOWN_TOOLS);
    const { plan } = dryRunTemplate(home, "tool_only_test", {});
    expect(plan.actions.some((a) => a.kind === "write" && a.nodeId === "write_out")).toBe(true);
    expect(existsSync(join(workdir, "out.txt"))).toBe(false);
  } finally { cleanup(home); cleanup(workdir); }
});

test("Templates46Test.test_trial_activate_run_full_gate", async () => {
  const home = tempHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tpl-work-"));
  try {
    importTemplateText(home, TOOL_ONLY_TEMPLATE, "t.yaml", "local", KNOWN_TOOLS);
    await expect(runTemplate(home, "tool_only_test", {}, reqFor(workdir)))
      .rejects.toThrow("还没激活");
    const { run, acceptance, reportPath } = await trialTemplate(home, "tool_only_test", {}, reqFor(workdir), true);
    expect(run.status).toBe("completed");
    expect(acceptance.passed).toBe(true);
    expect(existsSync(join(workdir, "input.txt"))).toBe(true);
    expect(existsSync(join(workdir, "out.txt"))).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf-8")).toContain("验收标准");
    const afterTrial = listTemplates(home)[0];
    expect(afterTrial.status).toBe("trial_passed");
    const activated = activateTemplate(home, "tool_only_test", true);
    expect(activated.status).toBe("active");
    const ran = await runTemplate(home, "tool_only_test", {}, reqFor(workdir));
    expect(ran.run.status).toBe("completed");
    expect(ran.acceptance.passed).toBe(true);
    // 试跑重跑直接认上一次的运行，不重新跑。
    const again = await trialTemplate(home, "tool_only_test", {}, reqFor(workdir), true);
    expect(again.reused).toBe(true);
    expect(again.run.id).toBe(run.id);
  } finally { cleanup(home); cleanup(workdir); }
});

test("Templates46Test.test_activate_blocked_before_trial_and_on_failed_acceptance", async () => {
  const home = tempHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tpl-work-"));
  try {
    importTemplateText(home, TOOL_ONLY_TEMPLATE, "t.yaml", "local", KNOWN_TOOLS);
    expect(() => activateTemplate(home, "tool_only_test", true)).toThrow("还没试跑通过");
    // 只读不写的模板：试跑跑完但验收 has-changes 不过，激活须拦住。
    const readOnly = TOOL_ONLY_TEMPLATE.replace("name: tool_only_test", "name: read_only_test")
      .replace("  name: tool_only_test\n  version: 1", "  name: read_only_test\n  version: 1")
      .replace(/    - id: write_out\n      type: tool\n      tool: write_file\n      args:\n        path: "\{\{inputs\.out_path\}\}"\n        content: "\{\{steps\.read_input\.output\}\}"\n/, "");
    importTemplateText(home, readOnly, "r.yaml", "local", KNOWN_TOOLS);
    const { acceptance } = await trialTemplate(home, "read_only_test", {}, reqFor(workdir), true);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failed).toContain("has-changes");
    expect(() => activateTemplate(home, "read_only_test", true)).toThrow("验收没全过");
  } finally { cleanup(home); cleanup(workdir); }
});

test("Templates46Test.test_trial_requires_yes", async () => {
  const home = tempHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tpl-work-"));
  try {
    importTemplateText(home, TOOL_ONLY_TEMPLATE, "t.yaml", "local", KNOWN_TOOLS);
    await expect(trialTemplate(home, "tool_only_test", {}, reqFor(workdir), false))
      .rejects.toThrow("须加 --yes 确认");
  } finally { cleanup(home); cleanup(workdir); }
});

test("Templates46Test.test_run_rechecks_redline", async () => {
  const home = tempHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-tpl-work-"));
  try {
    importTemplateText(home, SEND_GATED_TEMPLATE, "g.yaml", "local", KNOWN_TOOLS);
    const { run, acceptance } = await trialTemplate(home, "send_gated_test", {}, reqFor(workdir), true);
    expect(run.status).toBe("completed");
    expect(acceptance.passed).toBe(true);
    activateTemplate(home, "send_gated_test", true);
    applyRedlineChange(home, "gmail", "send_message", "never");
    await expect(runTemplate(home, "send_gated_test", {}, reqFor(workdir)))
      .rejects.toThrow("永远禁做");
  } finally { cleanup(home); cleanup(workdir); }
});

test("Templates46Test.test_remove_template_cleans_workflow", () => {
  const home = tempHome();
  try {
    importTemplateText(home, TOOL_ONLY_TEMPLATE, "t.yaml", "local", KNOWN_TOOLS);
    const { entry } = loadTemplateDefinition(home, "tool_only_test");
    expect(existsSync(join(templatesDir(home), entry.file))).toBe(true);
    removeTemplate(home, "tool_only_test", true);
    expect(listTemplates(home)).toEqual([]);
    expect(loadWorkflowRegistry(home).workflows).toEqual([]);
    expect(() => loadTemplateDefinition(home, "tool_only_test")).toThrow("没有这个模板");
  } finally { cleanup(home); }
});

test("Templates46Test.test_ledger_corrupt_backups_and_throws", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "templates.json"), "{ broken");
    expect(() => listTemplates(home)).toThrow("模板账本损坏");
    expect(readdirSync(home).some((f) => f.startsWith("templates.json.corrupt-"))).toBe(true);
  } finally { cleanup(home); }
});

// ---- 市场 kind template 接线 ----

function seedTemplateSource(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "nyra-market-src-"));
  writeFileSync(join(dir, "shop_order_followup.yaml"), BUILTIN_TEMPLATE_SHOP_ORDER);
  const shellTemplate = BUILTIN_TEMPLATE_SHOP_ORDER
    .replace("name: shop_order_followup", "name: shell_template")
    .replace("  name: shop_order_followup\n  version: 1", "  name: shell_template\n  version: 1")
    .replace("    - id: fetch_order\n      type: tool\n      tool: shopify_orders\n      args:\n        order_id: \"{{inputs.order_id}}\"",
      "    - id: run_shell\n      type: tool\n      tool: shell\n      args:\n        command: \"echo hi\"");
  writeFileSync(join(dir, "shell_template.yaml"), shellTemplate);
  const index = {
    version: 1,
    name: "test-market",
    entries: [
      { id: "shop_order_followup", kind: "template", name: "shop_order_followup", version: "1.0.0", description: "店铺订单异常跟进", author: "tester", license: "MIT", path: "shop_order_followup.yaml" },
      { id: "shell_template", kind: "template", name: "shell_template", version: "1.0.0", description: "含 shell 的模板", author: "tester", license: "MIT", path: "shell_template.yaml" },
    ],
  };
  writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
  return { dir, file: join(dir, "shop_order_followup.yaml") };
}

function fakeTemplateEntry(id: string, dir: string, path: string): { entry: MarketEntryMeta; source: { name: string; kind: "local"; path: string; added_at: string }; dir: string } {
  return {
    entry: { id, kind: "template", name: id, version: "1.0.0", description: "测试模板", license: "MIT", path },
    source: { name: "test", kind: "local", path: dir, added_at: "" },
    dir,
  };
}

test("Templates46Test.test_market_verify_template", () => {
  const { dir, file } = seedTemplateSource();
  try {
    const resolved = fakeTemplateEntry("shop_order_followup", file, "shop_order_followup.yaml");
    const v = verifyMarketplaceEntry(resolved);
    expect(v.ok).toBe(true);
    expect(v.tools).toContain("shopify_orders");
    expect(v.tools).toContain("gmail_send");
    expect(v.permissions).toContain("connector:shopify");
    expect(v.permissions).toContain("approve:send_message");
    expect(v.permissions).toContain("never:pay");
  } finally { cleanup(dir); }
});

test("Templates46Test.test_market_scan_blocks_shell_in_template", () => {
  const { dir } = seedTemplateSource();
  try {
    const resolved = fakeTemplateEntry("shell_template", join(dir, "shell_template.yaml"), "shell_template.yaml");
    const hits = scanMarketplaceEntry(resolved);
    expect(hits.some((h) => h.rule === "template-shell")).toBe(true);
  } finally { cleanup(dir); }
});

test("Templates46Test.test_market_bot_ready_template_is_zero", () => {
  const { dir, file } = seedTemplateSource();
  try {
    const resolved = fakeTemplateEntry("shop_order_followup", file, "shop_order_followup.yaml");
    const ready = computeBotReadyForDir(resolved.entry, resolved.dir);
    expect(ready.score).toBe(0);
    expect(ready.missing.join("")).toContain("不参与 Bot Ready");
  } finally { cleanup(dir); }
});

test("Templates46Test.test_market_install_and_uninstall_template", async () => {
  const home = tempHome();
  const { dir } = seedTemplateSource();
  try {
    addMarketSource(home, dir);
    const store = new RunStore(join(home, "runs"));
    const run = store.create("marketplace install shop_order_followup", "cli", home, "readonly", 1);
    const prepared = await prepareMarketplaceInstall(home, "shop_order_followup", { config: {} });
    expect(prepared.entry.kind).toBe("template");
    expect(prepared.plannedChanges.join("\n")).toContain("试跑 + 人工确认");
    const result = executeMarketplaceInstall(home, prepared, { store, runId: run.run_id });
    expect(result.installed.kind).toBe("template");
    expect(result.installed.status).toBe("installed");
    const entry = listTemplates(home).find((t) => t.name === "shop_order_followup");
    expect(entry?.status).toBe("draft");
    expect(entry?.source).toBe("shop_order_followup");
    const un = uninstallMarketplaceEntry(home, "shop_order_followup", { store, runId: run.run_id });
    expect(un.kind).toBe("template");
    expect(un.removed.some((r) => r.startsWith("templates/"))).toBe(true);
    expect(listTemplates(home)).toEqual([]);
  } finally { cleanup(home); cleanup(dir); }
});

test("Templates46Test.test_market_publish_template_dry_run", async () => {
  const home = tempHome();
  const { dir, file } = seedTemplateSource();
  try {
    const result = await publishMarketplaceEntry(home, { template: file }, { config: {}, dryRun: true });
    expect(result.kind).toBe("template");
    expect(result.itemName).toBe("shop_order_followup");
    expect(result.files).toContain("shop_order_followup.yaml");
    expect(result.botReady.score).toBe(0);
  } finally { cleanup(home); cleanup(dir); }
});

test("Templates46Test.test_handle_template_cli_smoke", async () => {
  const home = tempHome();
  try {
    expect(await handleTemplate(["list", "--builtin"], home)).toBe(0);
    expect(await handleTemplate(["import", "--builtin", "expense_review"], home)).toBe(0);
    expect(await handleTemplate(["show", "expense_review"], home)).toBe(0);
    expect(await handleTemplate(["dry-run", "expense_review"], home)).toBe(0);
    expect(await handleTemplate(["list"], home)).toBe(0);
    expect(await handleTemplate(["builtin", "shop_order_followup"], home)).toBe(0);
    expect(await handleTemplate(["nope"], home)).toBe(2);
  } finally { cleanup(home); }
});
