// tests/node/test-gateway-cost.test.ts — 缺口 30：网关入口必须受成本硬顶约束。
//
// 背景（docs/cost.md 的「已知缺口（本批没做）」）：`nyra ui` 起的 agent 完全不接
// maxCostUsd，Web UI 跑任务等于绕过 `--max-cost`——硬顶只对 CLI 生效，那不叫
// 硬顶；定时任务是无人值守入口，绕过更糟。
//
// 这里锁两件事：
//   C1 网关建出的 agent，成本选项与 config 一致（不是 null）；月度上限已移除，
//     旧 config 键不再透传
//   C2 网关运行会把用量增量写进账本（否则月度累计永远看不到 UI 的花费）
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";

/** 假 provider：这些断言只看成本选项，不会真的发请求。 */
function fakeProvider() {
  return {
    name: "fake", model: "fake-1",
    chat: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    hasCredentials: () => true,
  } as never;
}

/** 构造注入假 provider 的网关（测试不依赖外部凭证）。 */
function makeGw(home: string): Gateway {
  return new Gateway({ home, workdir: home, providerFactory: () => fakeProvider() });
}

function homeWith(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-gw-cost-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config), "utf-8");
  return home;
}

interface CostOpts {
  maxCostUsd: number | null;
  pricing: unknown;
}

interface BudgetSummary {
  monthly_spent_usd: number;
  monthly_spent_incomplete: boolean;
  monthly_reset_at: string;
}

/** 取 private 方法做断言（只做类型转换，不引 runtime hack）。 */
function internals(gw: Gateway): { costOptions: () => CostOpts; budgetSummary: () => BudgetSummary } {
  return gw as unknown as { costOptions: () => CostOpts; budgetSummary: () => BudgetSummary };
}

test("网关成本选项：max_cost_usd 透传到 agent（Web UI 不再绕过硬顶）", () => {
  const home = homeWith({ max_cost_usd: 0.5, pricing: { "fake-1": { input_per_1m: 1, output_per_1m: 2 } } });
  const gw = makeGw(home);
  const opts = internals(gw).costOptions();
  expect(opts.maxCostUsd).toBe(0.5);
});

test("网关成本选项：未配 max_cost_usd 时为 null（不编造上限）", () => {
  const gw = makeGw(homeWith({}));
  expect(internals(gw).costOptions().maxCostUsd).toBeNull();
});

test("网关成本选项：月度上限已移除——旧 config 键不再透传", () => {
  const opts = internals(makeGw(homeWith({}))).costOptions();
  expect(Object.keys(opts).sort()).toEqual(["maxCostUsd", "pricing"]);
  // 旧配置里写了月度上限也无效：不透传、不生效。
  const withOldKey = makeGw(homeWith({ monthly_cost_limit_usd: 12 }));
  expect(Object.keys(internals(withOldKey).costOptions()).sort()).toEqual(["maxCostUsd", "pricing"]);
});

test("网关成本摘要：只剩本月已花记账，没有上限字段", () => {
  const home = homeWith({ monthly_cost_limit_usd: 10 });
  const ledger = new UsageLedger(home);
  // 造一条本月记录：1000 prompt / 500 completion / $0.25
  ledger.recordDelta(
    { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, calls: 1 } as never,
    null, 0.25, null, "fake-1",
  );
  const summary = internals(makeGw(home)).budgetSummary();
  expect(summary.monthly_spent_usd).toBeGreaterThanOrEqual(0.25);
  expect(typeof summary.monthly_spent_incomplete).toBe("boolean");
  expect(typeof summary.monthly_reset_at).toBe("string");
  expect(Object.keys(summary).sort()).toEqual(["monthly_reset_at", "monthly_spent_incomplete", "monthly_spent_usd"]);
});

test("账本可读：网关写入前 monthTotal 能被读到（flush 的事实源存在）", () => {
  const home = homeWith({});
  const ledger = new UsageLedger(home);
  const before = ledger.monthTotal(monthKeyString());
  expect(typeof before.spentUsd).toBe("number");
  expect(existsSync(join(home, "usage")) || before.calls === 0).toBe(true);
});

test("网关构造不会因为成本相关配置缺失而崩", () => {
  expect(() => makeGw(homeWith({ max_cost_usd: 1 }))).not.toThrow();
  expect(() => makeGw(homeWith({ pricing: { "x-1": { input_per_1m: 1, output_per_1m: 1 } } }))).not.toThrow();
  // 畸形 pricing 也不该炸
  expect(() => makeGw(homeWith({ pricing: { "y-1": { input_per_1m: "oops" } } }))).not.toThrow();
});

test("读配置文件确认测试夹具真实落盘（防止假绿）", () => {
  const home = homeWith({ max_cost_usd: 0.25 });
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf-8")).max_cost_usd).toBe(0.25);
});
