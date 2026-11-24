// tests/node/test-config-explain.test.ts — `nyra config explain`：「这个能力由哪个键控制」。
// 场景：控制同一件事的入口有好几个（features / config / env / CLI），改一处不生效只能翻源码。
import { test, expect } from "bun:test";
import { explainAll, explainOne, formatExplain } from "../../src/configExplain.ts";

const CAPABILITIES = [
  "tool_search", "run_recall", "cost_cap", "aux_model_routing",
  "plan_act_model_routing",
  "reasoning_effort", "extra_writable_dirs", "deny_read_globs", "sandbox",
  "nested_delegate", "trust_ladder", "reconciler", "watch",
  // 可靠性打磨第 2 项第一批：budget 追加在末尾（只加不改）。
  "budget",
  // 改进清单第二轮：update_check 追加在末尾（只加不改）。
  "update_check",
];

test("列出全部能力（顺序固定，便于文档引用）", () => {
  const all = explainAll({ config: {} });
  expect(all.map((c) => c.capability)).toEqual(CAPABILITIES);
});

test("每个能力都列出「可改的键」与来源", () => {
  for (const c of explainAll({ config: {} })) {
    expect(c.keys.length).toBeGreaterThan(0);
    expect(["cli", "config", "env", "default", "conflict"]).toContain(c.source);
    expect(c.note.length).toBeGreaterThan(0);
  }
});

test("tool_search：三处入口都列出来（features / config / env）", () => {
  const c = explainOne({ config: {} }, "tool_search")!;
  expect(c.effective).toBe("off");
  expect(c.keys.join(" ")).toContain("features.tool_search");
  expect(c.keys.join(" ")).toContain("tool_search.enabled");
  expect(c.keys.join(" ")).toContain("NYRA_LAZY_TOOLS");
});

test("tool_search：env 一票否决优先于 features", () => {
  const c = explainOne({ config: { features: { tool_search: true } }, env: { NYRA_LAZY_TOOLS: "0" } }, "tool_search")!;
  expect(c.effective).toBe("off");
  expect(c.source).toBe("env");
  expect(c.note).toContain("一票否决");
});

test("nested_delegate：默认 2 层，config 可配 1–5，非法回 2", () => {
  expect(explainOne({ config: {} }, "nested_delegate")!.effective).toBe("2 层");
  const c = explainOne({ config: { delegate_max_depth: 4 } }, "nested_delegate")!;
  expect(c.effective).toBe("4 层");
  expect(c.source).toBe("config");
  expect(explainOne({ config: { delegate_max_depth: 99 } }, "nested_delegate")!.effective).toBe("2 层");
});

test("trust_ladder：默认 5 次成功/级、抽查 10%，非法值回默认", () => {
  expect(explainOne({ config: {} }, "trust_ladder")!.effective).toBe("5 次成功/级，抽查 10%");
  const c = explainOne({ config: { trust_ladder: { required_successes: 3, spot_check_rate: 0.5 } } }, "trust_ladder")!;
  expect(c.effective).toBe("3 次成功/级，抽查 50%");
  expect(c.source).toBe("config");
  expect(explainOne({ config: { trust_ladder: { required_successes: 99, spot_check_rate: 9 } } }, "trust_ladder")!.effective)
    .toBe("5 次成功/级，抽查 10%");
});

test("cost_cap：CLI 覆盖 config，来源标 cli", () => {
  expect(explainOne({ config: { max_cost_usd: 5 }, cli: { maxCost: 2 } }, "cost_cap")).toMatchObject({
    effective: "$2",
    source: "cli",
  });
  expect(explainOne({ config: { max_cost_usd: 5 } }, "cost_cap")).toMatchObject({ effective: "$5", source: "config" });
});

test("aux_model_routing：展示实际路由目标，与主模型相同则视为未配", () => {
  expect(explainOne({ config: { compact_model: "cheap", model: "main" } }, "aux_model_routing")?.effective).toContain("压缩→cheap");
  expect(explainOne({ config: { compact_model: "main", model: "main" } }, "aux_model_routing")?.effective).toBe("off");
});

test("plan_act_model_routing：展示规划/执行分模型，与主模型相同则视为未配", () => {
  expect(explainOne({ config: { plan_model: "reasoner", act_model: "cheap", model: "main" } }, "plan_act_model_routing")?.effective).toContain("规划→reasoner");
  expect(explainOne({ config: { plan_model: "main", model: "main" } }, "plan_act_model_routing")?.effective).toBe("off");
});

test("extra_writable_dirs：不存在的目录会被拒绝并说明（不撒谎说可写）", () => {
  const c = explainOne({ config: { extra_writable_dirs: ["/nope-does-not-exist-xyz"] } }, "extra_writable_dirs")!;
  expect(c.effective).toBe("none");
  expect(c.note).toContain("被拒");
});

test("未知能力返回 null（CLI 据此给可用列表）", () => {
  expect(explainOne({ config: {} }, "没有这个能力")).toBeNull();
  expect(explainOne({ config: {} }, "")).toBeNull();
});

test("能力名大小写与空白不敏感", () => {
  expect(explainOne({ config: {} }, "  TOOL_SEARCH  ")?.capability).toBe("tool_search");
});

test("formatExplain：每项都带生效值与可改键", () => {
  const text = formatExplain(explainAll({ config: {} }));
  for (const cap of CAPABILITIES) expect(text).toContain(cap);
  expect(text).toContain("可改的键");
  expect(text).toContain("来源：");
});
