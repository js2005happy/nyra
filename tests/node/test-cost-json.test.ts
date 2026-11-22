// tests/node/test-cost-json.test.ts — `nyra cost --show --json` 的机器可读契约。
//
// 与 `savings --json` / `verdict --json` 同一套纪律：只加字段、不改名、不删字段。
//
// 这里有一条特别重要的语义：**`max_cost_usd` 没配时是 null，不是 0**。
// 写成 0 会让 CI 把"没设上限"读成"上限是 0 美元"——含义完全相反，
// 报警逻辑会因此漏报（本该警告"没有硬顶"，结果看起来像硬顶为 0）。
import { test, expect } from "bun:test";
import { buildCostJson, COST_JSON_SCHEMA } from "../../src/costCli.ts";

const cfg = {
  pricing: { m1: { inputPer1M: 1, outputPer1M: 2 }, bad: "x" },
  max_cost_usd: 5,
};

const monthly = { limitUsd: 50, spentUsd: 1.2, mcpUsd: 0.2, month: "2026-11", resetAt: "2026-12-01" };

test("C1 schema_version 是显式常量", () => {
  expect(COST_JSON_SCHEMA).toBe(1);
  expect(buildCostJson({ model: "m1", config: cfg, monthly }).schema_version).toBe(1);
});

test("C2 字段顺序稳定（契约：只加不改）", () => {
  expect(Object.keys(buildCostJson({ model: "m1", config: cfg, monthly }))).toEqual([
    "schema_version", "model", "pricing", "invalid_pricing", "max_cost_usd", "monthly",
    // 可靠性打磨第 2 项第一批：budget 追加在末尾（只加不改）。
    "budget",
  ]);
});

test("C3 有效定价进 pricing，无效定价进 invalid_pricing（能被静默忽略才是真问题）", () => {
  const j = buildCostJson({ model: "m1", config: cfg, monthly });
  expect(j.pricing.map((p) => p.model)).toContain("m1");
  expect(j.pricing.find((p) => p.model === "m1")).toEqual({ model: "m1", input_per_1m: 1, output_per_1m: 2 });
  expect(j.invalid_pricing).toEqual(["bad"]);
});

test("C4 没配单次上限 → null（不是 0，否则语义反转）", () => {
  const j = buildCostJson({ model: null, config: {}, monthly: null });
  expect(j.max_cost_usd).toBeNull();
  expect(j.max_cost_usd).not.toBe(0);
});

test("C5 月度字段用 snake_case，且数值原样搬运", () => {
  const j = buildCostJson({ model: "m1", config: cfg, monthly });
  expect(j.monthly).toEqual({
    limit_usd: 50, spent_usd: 1.2, mcp_usd: 0.2, month: "2026-11", reset_at: "2026-12-01",
    model_switches: { count: 0, by_trigger: {}, last: null },
  });
});

test("C6 没传 monthly（无 home）→ null，不编造本月花费", () => {
  expect(buildCostJson({ model: "m1", config: cfg, monthly: null }).monthly).toBeNull();
});

test("C7 pricing 不是对象时安全降级为空列表", () => {
  const j = buildCostJson({ model: null, config: { pricing: "nope" }, monthly: null });
  expect(j.pricing).toEqual([]);
  expect(j.invalid_pricing).toEqual([]);
});

test("C8 可 JSON.stringify / parse（CI 与看板消费）", () => {
  const round = JSON.parse(JSON.stringify(buildCostJson({ model: "m1", config: cfg, monthly })));
  expect(round.schema_version).toBe(1);
  expect(round.monthly.limit_usd).toBe(50);
});
