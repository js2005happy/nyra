// tests/node/test-stats-json.test.ts — `nyra stats --json` 的机器可读契约。
//
// 成本侧第四个 JSON 出口（savings / cost / verdict / stats），契约同一套：只加字段、不改名、不删字段。
// 例外（2026-11-27 去月度限额批）：monthly_limit_usd 字段随功能一起删掉，
// 这是批内有意的契约改动，见 T2 / T6。
//
// 这里锁的关键语义：**有调用但没配单价时 `month_spent_usd` 是 null，不是 0**，
// 并且 `incomplete: true` 单独给一个布尔——"有调用未计价"与"真没花钱"是两件事，
// 消费方必须能一眼区分，而不是从 null 里猜。
import { test, expect } from "bun:test";
import { buildStatsJson, STATS_JSON_SCHEMA } from "../../src/statsCli.ts";

const base = {
  month: "2026-11",
  monthTokens: 12000,
  monthSpentUsd: 1.5,
  incomplete: false,
  mcpSpentUsd: 0.2,
  resetAt: "2026-12-01",
  today: { date: "2026-11-20", tokens: 800, spent: 0.1, calls: 3 },
  days: [
    { date: "2026-11-19", tokens: 900, spent: 0.2, calls: 2 },
    { date: "2026-11-20", tokens: 800, spent: 0.1, calls: 3 },
  ],
};

test("T1 schema_version 是显式常量", () => {
  expect(STATS_JSON_SCHEMA).toBe(1);
  expect(buildStatsJson(base).schema_version).toBe(1);
});

test("T2 字段顺序稳定（契约：只加不改）", () => {
  expect(Object.keys(buildStatsJson(base))).toEqual([
    "schema_version", "month", "month_tokens", "month_spent_usd", "incomplete",
    "mcp_spent_usd", "reset_at", "today", "days", "model_switches",
  ]);
});

test("T3 未计价 → month_spent_usd 为 null + incomplete 为 true（两件事分开表达）", () => {
  const j = buildStatsJson({ ...base, monthSpentUsd: null, incomplete: true });
  expect(j.month_spent_usd).toBeNull();
  expect(j.month_spent_usd).not.toBe(0);
  expect(j.incomplete).toBe(true);
});

test("T4 没今日数据时 today 为 null（不编造 0 调用）", () => {
  expect(buildStatsJson({ ...base, today: null }).today).toBeNull();
});

test("T5 days 保留调用数（看板要画「每天几次」而不只是 token）", () => {
  const j = buildStatsJson(base);
  expect(j.days).toHaveLength(2);
  expect(j.days[0].calls).toBe(2);
  expect(j.days[1]).toMatchObject({ date: "2026-11-20", tokens: 800, spent_usd: 0.1, calls: 3 });
});

test("T6 月度上限字段已随功能删掉（不再输出 monthly_limit_usd）", () => {
  const j = buildStatsJson(base);
  expect("monthly_limit_usd" in j).toBe(false);
  // 本月花费记账本身还在：month_spent_usd 照常给数。
  expect(j.month_spent_usd).toBe(1.5);
});

test("T7 空账本也能安全输出（全零 + 空 days）", () => {
  const j = buildStatsJson({
    month: "2026-11", monthTokens: 0, monthSpentUsd: 0, incomplete: false, mcpSpentUsd: 0,
    resetAt: "2026-12-01", today: null, days: [],
  });
  expect(j.days).toEqual([]);
  expect(j.month_tokens).toBe(0);
});

test("T8 可 JSON.stringify / parse（CI 与看板消费）", () => {
  const round = JSON.parse(JSON.stringify(buildStatsJson(base)));
  expect(round.schema_version).toBe(1);
  expect(round.days).toHaveLength(2);
});
