// tests/node/test-connector-bundle-4446.test.ts — 缺口 44 深化：连接器即技能包。
// 四件套（权限声明 + 工具清单 + 业务流程 + 红线表）打包、导出、市场验证。
// 不联网、不读凭证、不碰真实连接器。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_SCHEMAS } from "../../src/tools.ts";
import {
  buildConnectorBundle, exportConnectorBundle, CONNECTOR_BUNDLE_FILES,
  CONNECTOR_CLI_ONLY_TOOLS,
} from "../../src/connectors/bundle.ts";
import {
  addMarketSource, verifyMarketplaceEntry, scanMarketplaceEntry,
  computeBotReadyForDir, prepareMarketplaceInstall,
} from "../../src/marketplace.ts";

const KNOWN = new Set(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string));

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("ConnectorBundle4446Test.test_gmail_bundle_four_pieces", () => {
  const b = buildConnectorBundle("gmail", KNOWN);
  expect(b.kind).toBe("connector");
  expect(b.connector).toBe("gmail");
  expect(b.version).toBe("1.0.0");
  expect(b.scopes.read.length).toBeGreaterThan(0);
  expect(b.scopes.write).toContain("https://www.googleapis.com/auth/gmail.send");
  expect(b.alwaysRequireApproval).toContain("gmail_send");
  expect(b.redlineTable).toBe("gmail");
  expect(b.redlines.send_message).toBe("approve");
  const modelTools = b.tools.filter((t) => t.surface === "model").map((t) => t.name);
  expect(modelTools).toEqual(expect.arrayContaining(["gmail_search", "gmail_read", "gmail_send"]));
  const cliTools = b.tools.filter((t) => t.surface === "cli").map((t) => t.name);
  expect(cliTools).toEqual(expect.arrayContaining(["gmail_label", "gmail_trash", "gmail_attachment"]));
  expect(b.flows.map((f) => f.id)).toContain("gmail-draft-send");
  expect(b.flows.every((f) => f.acceptance.length > 0)).toBe(true);
  expect(b.permissionStatement).toContain("永远须人批");
  expect(b.permissionStatement).toContain("gmail_send");
  expect(b.permissionStatement).toContain("凭证只存本机密码箱");
});

test("ConnectorBundle4446Test.test_shopify_bundle_read_only", () => {
  const b = buildConnectorBundle("shopify", KNOWN);
  expect(b.tools.map((t) => t.name).sort()).toEqual(["shopify_inventory", "shopify_orders", "shopify_products"]);
  expect(b.tools.every((t) => t.access === "read")).toBe(true);
  expect(b.tools.every((t) => t.surface === "model")).toBe(true);
  expect(b.tools.every((t) => t.tier === "free")).toBe(true);
  expect(b.flows.map((f) => f.id)).toContain("shopify-order-fulfillment");
  expect(b.permissionStatement).toContain("shopify_orders");
});

test("ConnectorBundle4446Test.test_slack_bundle_send_is_approve", () => {
  const b = buildConnectorBundle("slack", KNOWN);
  const send = b.tools.find((t) => t.name === "slack_send")!;
  expect(send.surface).toBe("model");
  expect(send.access).toBe("write");
  expect(send.action).toBe("send_message");
  expect(send.tier).toBe("approve");
  const card = b.tools.find((t) => t.name === "slack_approval_card")!;
  expect(card.surface).toBe("cli");
  expect(card.cli).toBe(CONNECTOR_CLI_ONLY_TOOLS.slack_approval_card.cli);
  expect(b.flows.map((f) => f.id)).toContain("slack-approval-roundtrip");
});

test("ConnectorBundle4446Test.test_unknown_connector_cannot_bundle", () => {
  // 注册表里目前只有 gmail / shopify / slack 三个已接入声明，没有试点声明，
  // 所以“试点不能打包”那条分支现阶段测不到（代码里留着，等以后加试点声明时再测）。
  expect(() => buildConnectorBundle("no-such-connector", KNOWN)).toThrow(/未知连接器/);
});

test("ConnectorBundle4446Test.test_unknown_tool_in_declaration_refuses", () => {
  const partial = new Set([...KNOWN].filter((n) => n !== "shopify_orders"));
  expect(() => buildConnectorBundle("shopify", partial)).toThrow(/shopify_orders/);
});

test("ConnectorBundle4446Test.test_export_writes_six_files_and_refuses_nonempty", () => {
  const home = tmpDir("nyra-bundle4446-home-");
  const out = join(tmpDir("nyra-bundle4446-out-"), "nyra-connector-shopify");
  const exported = exportConnectorBundle(home, "shopify", out, KNOWN);
  expect(exported.dir).toBe(out);
  expect(exported.files).toEqual([...CONNECTOR_BUNDLE_FILES]);
  for (const f of CONNECTOR_BUNDLE_FILES) expect(existsSync(join(out, f))).toBe(true);
  const connectorJson = JSON.parse(readFileSync(join(out, "connector.json"), "utf-8")) as Record<string, unknown>;
  expect(connectorJson.connector).toBe("shopify");
  expect(connectorJson.kind).toBe("connector");
  const marketEntry = JSON.parse(readFileSync(join(out, "market-entry.json"), "utf-8")) as Record<string, unknown>;
  expect(marketEntry.id).toBe("connector-shopify");
  expect(marketEntry.kind).toBe("connector");
  expect(marketEntry.path).toBe(".");
  const statement = readFileSync(join(out, "permission-statement.txt"), "utf-8");
  expect(statement).toContain("Shopify");
  expect(statement).toContain("shopify_orders");
  expect(() => exportConnectorBundle(home, "shopify", out, KNOWN)).toThrow(/已有文件/);
});

test("ConnectorBundle4446Test.test_market_verify_connector_bundle", () => {
  const home = tmpDir("nyra-bundle4446-mkt-home-");
  const srcDir = tmpDir("nyra-bundle4446-mkt-src-");
  const bundleDir = join(srcDir, "connector-shopify");
  exportConnectorBundle(home, "shopify", bundleDir, KNOWN);
  writeFileSync(join(srcDir, "index.json"), JSON.stringify({
    version: 1,
    name: "test-market",
    entries: [
      { id: "connector-shopify", kind: "connector", name: "shopify", version: "1.0.0", description: "Shopify 连接器包", author: "nyra", license: "MIT", path: "connector-shopify" },
    ],
  }, null, 2));
  addMarketSource(home, srcDir);
  const resolved = {
    entry: { id: "connector-shopify", kind: "connector" as const, name: "shopify", version: "1.0.0", description: "Shopify 连接器包", license: "MIT", path: "connector-shopify" },
    source: { name: "test", kind: "local" as const, path: srcDir, added_at: "" },
    dir: bundleDir,
  };
  const v = verifyMarketplaceEntry(resolved);
  expect(v.ok).toBe(true);
  expect(v.errors).toEqual([]);
  expect(v.tools).toEqual(expect.arrayContaining(["shopify_products", "shopify_orders", "shopify_inventory"]));
  expect(v.permissions).toContain("connector:shopify");
  // 只读包不该凭空多出 approve:send_message（权限只按工具实际动作派生）。
  expect(v.permissions).not.toContain("approve:send_message");
  const hits = scanMarketplaceEntry(resolved);
  expect(hits).toEqual([]);
  const ready = computeBotReadyForDir(resolved.entry, bundleDir);
  expect(ready.score).toBe(0);
  expect(ready.missing.join("")).toContain("不参与 Bot Ready 评分");
});

test("ConnectorBundle4446Test.test_market_verify_gmail_bundle_permissions", () => {
  const home = tmpDir("nyra-bundle4446-mkt2-home-");
  const bundleDir = join(tmpDir("nyra-bundle4446-mkt2-src-"), "connector-gmail");
  exportConnectorBundle(home, "gmail", bundleDir, KNOWN);
  const resolved = {
    entry: { id: "connector-gmail", kind: "connector" as const, name: "gmail", version: "1.0.0", description: "Gmail 连接器包", license: "MIT", path: "connector-gmail" },
    source: { name: "test", kind: "local" as const, path: tmpdir(), added_at: "" },
    dir: bundleDir,
  };
  const v = verifyMarketplaceEntry(resolved);
  expect(v.ok).toBe(true);
  expect(v.permissions).toContain("connector:gmail");
  expect(v.permissions).toContain("approve:send_message");
});

test("ConnectorBundle4446Test.test_market_install_refuses_connector", async () => {
  const home = tmpDir("nyra-bundle4446-install-home-");
  const srcDir = tmpDir("nyra-bundle4446-install-src-");
  const bundleDir = join(srcDir, "connector-shopify");
  exportConnectorBundle(home, "shopify", bundleDir, KNOWN);
  writeFileSync(join(srcDir, "index.json"), JSON.stringify({
    version: 1,
    name: "test-market",
    entries: [
      { id: "connector-shopify", kind: "connector", name: "shopify", version: "1.0.0", description: "Shopify 连接器包", author: "nyra", license: "MIT", path: "connector-shopify" },
    ],
  }, null, 2));
  addMarketSource(home, srcDir);
  await expect(prepareMarketplaceInstall(home, "connector-shopify", { config: {} })).rejects.toThrow(/只验证、不安装/);
  // 拒绝安装后什么都没落盘：已装账本里没有这个条目。
  expect(existsSync(join(home, "marketplace-installed.json"))).toBe(false);
});
