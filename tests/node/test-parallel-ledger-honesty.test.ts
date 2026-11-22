// tests/node/test-parallel-ledger-honesty.test.ts — 并行委派的总账不能假装是最终账单。
//
// 背景（docs/parallel-delegate.md「已知局限」第一条）：超时先发取消信号，
// 再等宽限期确认底层停下；宽限到了还没停的线程（pendingAfterTimeout）事后
// 花掉的钱会计入父级 delegateSpentUsd，**但不进本批返回的
// totalSpentUsd**。之前汇总文本只说了「不进此合计」，没告诉调用方"这个数只是下限"。
//
// 口径错了比没有数字更危险——和看板那次是同一类问题。
import { test, expect } from "bun:test";
import { formatParallelResults, type ParallelDelegateResult } from "../../src/parallelDelegate.ts";

function result(over: Partial<ParallelDelegateResult> = {}): ParallelDelegateResult {
  return {
    results: [],
    succeeded: 1,
    failed: 0,
    timedOut: 0,
    rejected: 0,
    cancelled: 0,
    totalSpentUsd: 0.05,
    pendingAfterTimeout: 0,
    totalDurationMs: 12000,
    maxConcurrency: 5,
    timeoutMs: 600000,
    maxConcurrencyClamped: false,
    ...over,
  };
}

test("没有超时线程：金额不加 ≥，并明说上值为全部", () => {
  const text = formatParallelResults(result());
  expect(text).not.toContain("≥");
  expect(text).toContain("无正在停止的线程");
  expect(text).toContain("$0.0500");
});

test("有超时线程：金额标 ≥（是下限不是账单）", () => {
  const text = formatParallelResults(result({ timedOut: 2, pendingAfterTimeout: 2 }));
  expect(text).toContain("≥$0.0500");
});

test("有超时线程：明确写出几个线程仍在停止中、花费未结算", () => {
  const text = formatParallelResults(result({ timedOut: 2, pendingAfterTimeout: 2 }));
  expect(text).toContain("2 个线程宽限期内未确认停下、仍在停止中");
  expect(text).toContain("未结算");
  expect(text).toContain("下限");
});

test("未计价时不写 ≥（未知就是未知，不叠加假精度）", () => {
  const text = formatParallelResults(result({ totalSpentUsd: null, timedOut: 1, pendingAfterTimeout: 1 }));
  expect(text).toContain("未知（未计价）");
  expect(text).not.toContain("≥");
});

test("pendingAfterTimeout 与 timedOut 语义分开：被拒线程不算待结算", () => {
  const text = formatParallelResults(result({ timedOut: 1, rejected: 3, pendingAfterTimeout: 1 }));
  expect(text).toContain("被拒 3 个");
  expect(text).toContain("1 个线程宽限期内未确认停下、仍在停止中");
});

test("总账其余字段保持原样（不因这次改动改变口径）", () => {
  const text = formatParallelResults(result({ succeeded: 3, failed: 1, timedOut: 1, rejected: 2, pendingAfterTimeout: 1 }));
  expect(text).toContain("成功 3 个");
  expect(text).toContain("失败 1 个");
  expect(text).toContain("超时 1 个");
  expect(text).toContain("被拒 2 个");
  expect(text).toContain("12.0 秒");
});
