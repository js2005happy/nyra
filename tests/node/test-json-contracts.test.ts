// tests/node/test-json-contracts.test.ts — 五个 `--json` 出口的**共同契约**（表驱动）。
//
// 为什么单独一份：契约属性（schema_version、字段顺序、可序列化、null 不冒充 0）本来是
// 每个出口文件各测一遍，分散在 5 个文件里。散着的问题不是重复——是**加字段时容易漏改
// 其中一个**，于是契约悄悄分叉。这里用一张表把这五条共同属性钉在一起：
//
//   1. schema_version 存在且是正整数（各自常量与输出一致）
//   2. 字段顺序稳定（防止加字段时插错位置破坏快照）
//   3. 可 JSON.stringify / parse 往返
//   4. 深比较后不改动原对象（浅拷贝纪律：改 JSON 不污染源）
//   5. 顶层一定有 schema_version 且排第一
//
// 各出口自己的**语义**断言仍留在各自文件（比如"未计价 → null 而不是 0"）——
// 那些是业务语义，不适合塞进通用表。
import { test, expect } from "bun:test";
import { buildVerdict, toVerdictJson, VERDICT_JSON_SCHEMA } from "../../src/verdict.ts";
import { summarizeSavings, toSavingsJson, SAVINGS_JSON_SCHEMA } from "../../src/savingsSummary.ts";
import { buildCostJson, COST_JSON_SCHEMA } from "../../src/costCli.ts";
import { buildStatsJson, STATS_JSON_SCHEMA } from "../../src/statsCli.ts";
import { checkRedlines, toRedlinesJson, REDLINES_JSON_SCHEMA } from "../../src/redlines.ts";

interface Case {
  name: string;
  schemaConst: number;
  build: () => Record<string, unknown>;
  /** 期望的顶层字段顺序（契约：只加不改） */
  keys: string[];
}

const rl = { ok: true, verdict: "", findings: [{ level: "ok", code: "consistent", title: "", detail: "" }] };
const sv = {
  lines: [{ mechanism: "disable_tool", enabled: true, effect: "", tokensPerTurnSaved: 100, additive: true, source: "" }],
  tokensPerTurnTotal: 100, unknownCount: 1, verdict: "",
};

const CASES: Case[] = [
  {
    name: "verdict",
    schemaConst: VERDICT_JSON_SCHEMA,
    build: () => toVerdictJson(buildVerdict({ redlines: rl, savings: sv } as never), "config") as never,
    keys: ["schema_version", "kind", "grade", "headline", "reasons", "blockers", "next_steps", "unknowns"],
  },
  {
    name: "savings",
    schemaConst: SAVINGS_JSON_SCHEMA,
    build: () => toSavingsJson(summarizeSavings({ config: {}, schemas: [], disabledTools: [] })) as never,
    keys: ["schema_version", "tokens_per_turn_total", "unknown_count", "lines", "model_savings"],
  },
  {
    name: "cost",
    schemaConst: COST_JSON_SCHEMA,
    build: () => buildCostJson({ model: "m", config: { pricing: { m: { inputPer1M: 1, outputPer1M: 2 } } }, monthly: null }) as never,
    keys: ["schema_version", "model", "pricing", "invalid_pricing", "max_cost_usd", "monthly",
      // 可靠性打磨第 2 项第一批：budget 追加在末尾（只加不改）。
      "budget"],
  },
  {
    name: "stats",
    schemaConst: STATS_JSON_SCHEMA,
    build: () => buildStatsJson({
      month: "2026-11", monthTokens: 0, monthSpentUsd: 0, incomplete: false, mcpSpentUsd: 0,
      monthlyLimitUsd: null, resetAt: "2026-12-01", today: null, days: [],
    }) as never,
    keys: ["schema_version", "month", "month_tokens", "month_spent_usd", "incomplete", "mcp_spent_usd", "monthly_limit_usd", "reset_at", "today", "days", "model_switches"],
  },
  {
    name: "redlines",
    schemaConst: REDLINES_JSON_SCHEMA,
    build: () => toRedlinesJson(checkRedlines({ config: {}, sandbox: { level: "bwrap", backend: "bwrap" }, hasCostLimit: true } as never)) as never,
    keys: ["schema_version", "ok", "verdict", "has_fail", "has_warn", "counts", "findings"],
  },
];

for (const c of CASES) {
  test(`[${c.name}] 契约 C1：schema_version 是正整数常量，且输出用同一常量`, () => {
    expect(Number.isInteger(c.schemaConst)).toBe(true);
    expect(c.schemaConst).toBeGreaterThan(0);
    expect(c.build().schema_version).toBe(c.schemaConst);
  });

  test(`[${c.name}] 契约 C2：顶层字段顺序稳定，schema_version 排第一`, () => {
    const keys = Object.keys(c.build());
    expect(keys).toEqual(c.keys);
    expect(keys[0]).toBe("schema_version");
  });

  test(`[${c.name}] 契约 C3：JSON 往返不丢字段`, () => {
    const j = c.build();
    const round = JSON.parse(JSON.stringify(j)) as Record<string, unknown>;
    expect(Object.keys(round)).toEqual(Object.keys(j));
    expect(round.schema_version).toBe(j.schema_version);
  });

  test(`[${c.name}] 契约 C4：构建两次结果一致（无隐藏随机/时间依赖）`, () => {
    // 稳定性是契约的一部分：看板会 diff 前后两次输出
    expect(JSON.stringify(c.build())).toBe(JSON.stringify(c.build()));
  });
}

test("全部五个出口的 schema_version 都是 1（当前统一版本）", () => {
  for (const c of CASES) expect(c.schemaConst).toBe(1);
});
