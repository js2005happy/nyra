// src/eval/scenarios.ts — G-P1-30：场景评测台（纯函数，不调模型、不花 token）。
//
//   缺口：20 题固定评测有了、Golden 测试集有了、optimize 的三数据集 +
//   holdout 有了，但评测不是“一等公民”——没有数据集管理、没有逐轮
//   打分、没有场景级成绩单、没有成熟度评分、没有对外可复现的 benchmark
//   清单。本文件补前两块 + 可复现清单的纯函数部分：
//     - 场景：4 个内置场景与固定任务的 4 类一一对应（code / browser /
//       research / connector），每个场景有中英文名与说明；
//     - 成绩单：从一份已完成的评测报告算每场景的首轮通过率、重试挽回
//       数、成熟度（0–4，阈值见 MATURITY_THRESHOLDS）；
//     - 清单：可复现清单（manifest）把报告的版本、条件、环境、摘要与
//       结果哈希钉在一起，换一台机器照单重跑能逐项比对。
//   运行（按场景跑、按基准集跑）不在这里，在 scripts/eval.ts。
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { EVAL_TASKS, type EvalCategory } from "./catalog.ts";
import { evalHash, type EvalReport } from "./runner.ts";

export class EvalBenchError extends Error {}

/** 一个场景 = 一类固定任务。 */
export interface EvalScenario {
  id: EvalCategory;
  name: string;
  nameEn: string;
  description: string;
  taskIds: string[];
}

const SCENARIO_META: Record<EvalCategory, { name: string; nameEn: string; description: string }> = {
  code: {
    name: "代码修复",
    nameEn: "code fix",
    description: "在隔离进程里按冻结断言修好一个小函数，验收程序与 guard 不可动。",
  },
  browser: {
    name: "浏览器操作",
    nameEn: "browser ops",
    description: "在隔离测试页上按指令点按，真实 CDP 读回状态逐字段比对。",
  },
  research: {
    name: "资料问答",
    nameEn: "research QA",
    description: "只用冻结资料作答，写 result.json，答案与来源逐字段比对。",
  },
  connector: {
    name: "连接器调用",
    nameEn: "connector calls",
    description: "走测试传输层调 Gmail 工具，宿主独立读回传输层与产物核对。",
  },
};

export const EVAL_SCENARIOS: readonly EvalScenario[] = (
  ["code", "browser", "research", "connector"] as const
).map((id) => ({
  id,
  ...SCENARIO_META[id],
  taskIds: EVAL_TASKS.filter((t) => t.category === id).map((t) => t.id),
}));

/** 成熟度档位：按已执行任务的首轮通过率定（blocked 不计分母）。 */
export const MATURITY_LABELS = ["未达标", "起步", "可用", "稳定", "成熟"] as const;

export interface Maturity {
  level: number | null;
  label: string;
}

export function maturityForRate(executed: number, passed: number): Maturity {
  if (executed <= 0) return { level: null, label: "未评测" };
  const rate = passed / executed;
  if (rate >= 0.95) return { level: 4, label: MATURITY_LABELS[4] };
  if (rate >= 0.8) return { level: 3, label: MATURITY_LABELS[3] };
  if (rate >= 0.6) return { level: 2, label: MATURITY_LABELS[2] };
  if (rate >= 0.4) return { level: 1, label: MATURITY_LABELS[1] };
  return { level: 0, label: MATURITY_LABELS[0] };
}

/** 读并校验一份评测报告：内置套件、外部基准集、仓内探针的报告都认。 */
export function loadEvalReportForBench(reportPath: string): EvalReport {
  let raw: string;
  try {
    if (!reportPath || !existsSync(reportPath) || !lstatSync(reportPath).isFile()) {
      throw new EvalBenchError(`评测报告不存在或不是文件：${reportPath}`);
    }
    raw = readFileSync(reportPath, "utf-8");
  } catch (e) {
    if (e instanceof EvalBenchError) throw e;
    throw new EvalBenchError(`评测报告读不出来：${reportPath}`);
  }
  let report: EvalReport;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new EvalBenchError(`评测报告不是有效 JSON：${reportPath}`);
  }
  if (!report || typeof report !== "object" || report.schemaVersion !== 1) {
    throw new EvalBenchError("评测报告格式不对（须是 schemaVersion 1 的报告）");
  }
  const suite = (report as { suite?: unknown }).suite;
  if (
    typeof suite !== "string" ||
    (!(
      suite === "nyra-real-tasks-v1" ||
      suite.startsWith("nyra-benchmark:") ||
      suite.startsWith("nyra-probe:")
    ))
  ) {
    throw new EvalBenchError(`评测报告的 suite 不认：${String(suite)}`);
  }
  if (!report.id || typeof report.id !== "string") throw new EvalBenchError("评测报告缺 id");
  if (!report.finishedAt) throw new EvalBenchError(`评测报告 ${report.id} 还没跑完（finishedAt 为空），请用已完成的报告`);
  if (!Array.isArray(report.results)) throw new EvalBenchError("评测报告缺 results");
  for (const r of report.results) {
    if (
      !r ||
      typeof r.taskId !== "string" ||
      typeof r.category !== "string" ||
      !Array.isArray(r.attempts) ||
      r.attempts.length === 0 ||
      !["passed", "failed", "blocked"].includes(r.attempts[0]?.status)
    ) {
      throw new EvalBenchError(`评测报告里有无效的结果行（任务 ${String(r?.taskId ?? "?")}）`);
    }
  }
  return report;
}

export interface ScenarioScore {
  scenario: string;
  name: string;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  executed: number;
  firstAttemptPassRate: number | null;
  retryRecovery: number;
  maturity: Maturity;
}

export interface EvalScorecard {
  reportId: string;
  suite: string;
  scenarios: ScenarioScore[];
  overall: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    executed: number;
    firstAttemptPassRate: number | null;
    retryRecovery: number;
    maturity: Maturity;
  };
}

function scoreRows(results: EvalReport["results"]): Omit<ScenarioScore, "scenario" | "name"> {
  const first = results.map((r) => r.attempts[0]);
  const passed = first.filter((a) => a.status === "passed").length;
  const failed = first.filter((a) => a.status === "failed").length;
  const blocked = first.filter((a) => a.status === "blocked").length;
  const executed = passed + failed;
  const retryRecovery = results.filter(
    (r) => r.attempts[0]?.status === "failed" && r.attempts.slice(1).some((a) => a.status === "passed"),
  ).length;
  return {
    total: results.length,
    passed,
    failed,
    blocked,
    executed,
    firstAttemptPassRate: executed ? passed / executed : null,
    retryRecovery,
    maturity: maturityForRate(executed, passed),
  };
}

/**
 * 场景成绩单：按类别分组算首轮通过率与成熟度；逐轮打分 = 每题 attempts
 * 里的首轮状态 + 重试挽回（recoveredOnRetry 的分场景版）。
 * 内置 4 个场景恒有行（没跑到的记 0 题、成熟度“未评测”）；报告里出现
 * 的其他类别另起一行，按类别名排在内置场景之后。
 */
export function scenarioScorecard(report: EvalReport): EvalScorecard {
  const byCategory = new Map<string, EvalReport["results"]>();
  for (const r of report.results) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }
  const scenarios: ScenarioScore[] = [];
  for (const s of EVAL_SCENARIOS) {
    scenarios.push({ scenario: s.id, name: s.name, ...scoreRows(byCategory.get(s.id) ?? []) });
  }
  const extra = [...byCategory.keys()].filter((c) => !EVAL_SCENARIOS.some((s) => s.id === c)).sort();
  for (const c of extra) {
    scenarios.push({ scenario: c, name: c, ...scoreRows(byCategory.get(c)!) });
  }
  return {
    reportId: report.id,
    suite: report.suite,
    scenarios,
    overall: scoreRows(report.results),
  };
}

/** 可复现清单：报告的版本、条件、环境、摘要与结果哈希钉在一起。 */
export interface EvalManifest {
  manifestVersion: 1;
  suite: string;
  reportId: string;
  sourceRevision: string;
  sourceHash: string;
  harnessHash: string;
  catalogHash: string;
  conditions: EvalReport["conditions"];
  environment: Record<string, string | null>;
  summary: EvalReport["summary"];
  resultsHash: string;
}

export function buildEvalManifest(report: EvalReport): EvalManifest {
  const canonical = [...report.results].sort((a, b) => a.taskId.localeCompare(b.taskId));
  return {
    manifestVersion: 1,
    suite: report.suite,
    reportId: report.id,
    sourceRevision: report.sourceRevision,
    sourceHash: report.sourceHash,
    harnessHash: report.harnessHash,
    catalogHash: report.catalogHash,
    conditions: report.conditions,
    environment: report.environment,
    summary: report.summary,
    resultsHash: evalHash(canonical),
  };
}
