// src/evalLoop.ts — G-P1-29：评测驱动的优化闭环（loop 一半）。
//
//   缺口：20 题固定评测有了，`nyra optimize` 单条人批流程有了，但两者
//   不通——每轮改进都要人逐条从失败里手挑。Turnstone 的 optimizer 是
//   全自动 UCB 循环；Nyra 的版本是“自动提议 + 自动排队 + 验证结果回
//   填 UCB”，apply 那一步仍须人批（提案只建议、不自动改代码）。
//
//   一轮 loop = 读一份已完成的评测报告 → 失败按（类别 + 首个未通过
//   的验收项）聚类成臂 → 没有未结提议的簇自动起草一条模板提议 →
//   按 UCB 分数排队，给出下一条最值得批的提议。verify 的结果（放行
//   记 1、失败记 0）由 optimizer.ts 在 verifyProposal 里回填进臂账
//   本，下一份报告进来时重排——闭环跨报告跑，不靠一次循环改完。
//
//   确定性：聚类、起草模板、UCB 分数全是纯函数；不调模型、不花 token；
//   不重跑评测（评测要花模型钱，只读人跑好的报告）；不自动改代码。
import { existsSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { listProposals, proposeOptimization, resolveTargetPath } from "./optimizer.ts";
import { ensureArm, loadArmsLedger, rankArms, recordLoopRun, totalPulls, ucbScore } from "./optimizerArms.ts";
import { readEvalJson, type EvalReport } from "./eval/runner.ts";
import { EVAL_TASKS } from "./eval/catalog.ts";
import { appendGovernanceAudit } from "./governance.ts";

export class EvalLoopError extends Error {}

export interface EvalFailureCluster {
  key: string;
  category: string;
  checkId: string;
  taskIds: string[];
  reasons: string[];
}

export interface EvalLoopOutcome {
  reportId: string;
  clusters: EvalFailureCluster[];
  drafted: string[];
  reused: string[];
  rankedArms: string[];
  recommendedProposalId: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function getFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** 读并校验一份评测报告：只认已完成的 nyra-real-tasks-v1 报告，任务 id 须在目录里。 */
export function loadEvalReportForLoop(reportPath: string): EvalReport {
  if (!reportPath || !existsSync(reportPath) || !lstatSync(reportPath).isFile()) {
    throw new EvalLoopError(`评测报告不存在或不是文件：${reportPath}`);
  }
  let report: EvalReport;
  try {
    report = readEvalJson(reportPath);
  } catch {
    throw new EvalLoopError(`评测报告不是有效 JSON：${reportPath}`);
  }
  if (!report || typeof report !== "object" || report.schemaVersion !== 1 || report.suite !== "nyra-real-tasks-v1") {
    throw new EvalLoopError("评测报告格式不对（须是 schemaVersion 1 的 nyra-real-tasks-v1 报告）");
  }
  if (!report.id || typeof report.id !== "string") throw new EvalLoopError("评测报告缺 id");
  if (!report.finishedAt) throw new EvalLoopError(`评测报告 ${report.id} 还没跑完（finishedAt 为空），请用已完成的报告`);
  if (!Array.isArray(report.results)) throw new EvalLoopError("评测报告缺 results");
  const known = new Set(EVAL_TASKS.map((t) => t.id));
  const unknown = [...new Set(report.results.map((r) => r.taskId))].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new EvalLoopError(`评测报告里有目录外的任务 id：${unknown.slice(0, 5).join("、")}${unknown.length > 5 ? " 等" : ""}`);
  }
  return report;
}

/**
 * 失败聚类：只看每题第一次尝试；passed/blocked 不进簇。
 * 簇键 = 类别 + 首个未通过的验收项 id（没有验收项时记 no-checks）。
 */
export function clusterEvalFailures(report: EvalReport): EvalFailureCluster[] {
  const byKey = new Map<string, EvalFailureCluster>();
  for (const result of report.results) {
    const first = result.attempts?.[0];
    if (!first || first.status !== "failed") continue;
    const checkId = first.checks?.find((c) => !c.passed)?.id ?? "no-checks";
    const key = `${result.category}:${checkId}`;
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = { key, category: result.category, checkId, taskIds: [], reasons: [] };
      byKey.set(key, cluster);
    }
    if (!cluster.taskIds.includes(result.taskId)) cluster.taskIds.push(result.taskId);
    const reason = (first.reason ?? "").trim();
    if (reason && !cluster.reasons.includes(reason) && cluster.reasons.length < 2) {
      cluster.reasons.push(reason.slice(0, 120));
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 从一个失败簇套模板，起草一条追加到指令文档末尾的教训。 */
export function draftFromEvalCluster(cluster: EvalFailureCluster, reportId: string): string {
  const tasks = cluster.taskIds.join("、");
  const reasons = cluster.reasons.length > 0 ? `失败原因：${cluster.reasons.join("；")}。` : "";
  return `注意：评测 ${cluster.category} 类任务在 ${cluster.checkId} 上失败（报告 ${reportId}，任务 ${tasks}）。${reasons}改指令前先确认失败是提示词/工具用法问题而不是模型本身能力问题；不要为了过评测放宽验收。`;
}

/**
 * 跑一轮 loop：读报告 → 聚类 → 建臂 → 没有未结提议的簇自动起草 → 按 UCB 排队。
 * 只起草 draft 提议，不 apply、不改文件；人批之后 verify 的结果会回填进臂账本。
 */
export function runEvalLoop(
  home: string,
  workdir: string,
  opts: { reportPath: string; target: string; by?: string },
): EvalLoopOutcome {
  if (!opts.target?.trim()) throw new EvalLoopError("用法：nyra optimize loop --eval-report <报告.json> --target <指令文档，如 docs/notes.md>");
  resolveTargetPath(workdir, opts.target);
  const report = loadEvalReportForLoop(opts.reportPath);
  const clusters = clusterEvalFailures(report);
  const open = listProposals(home).filter((p) => ["draft", "approved", "applied"].includes(p.status));
  const drafted: string[] = [];
  const reused: string[] = [];
  for (const cluster of clusters) {
    ensureArm(home, cluster.key, { category: cluster.category, checkId: cluster.checkId });
    const existing = open.find((p) => p.armKey === cluster.key);
    if (existing) {
      reused.push(existing.id);
      continue;
    }
    const proposal = proposeOptimization(home, {
      target: opts.target,
      newText: draftFromEvalCluster(cluster, report.id),
      rationale: `评测报告 ${report.id} 里 ${cluster.taskIds.length} 题在 ${cluster.key} 上失败，loop 自动起草（UCB 臂 ${cluster.key}）。`,
      sourceKind: "eval-report",
      sourceRef: `${report.id}:${cluster.key}`,
      armKey: cluster.key,
      by: (opts.by ?? "eval-loop").trim() || "eval-loop",
    });
    drafted.push(proposal.id);
  }
  const arms = loadArmsLedger(home).arms;
  const rankedArms = rankArms(arms).map((a) => a.key);
  // open 是起草前的快照，新起草的提议不在里面，补查一次现行账本。
  let recommendedProposalId: string | null = null;
  for (const key of rankedArms) {
    const candidate = listProposals(home).find((p) => p.armKey === key && p.status === "draft");
    if (candidate) {
      recommendedProposalId = candidate.id;
      break;
    }
  }
  recordLoopRun(home, {
    id: `elr_${randomBytes(6).toString("hex")}`,
    at: nowIso(),
    reportId: report.id,
    clusters: clusters.map((c) => c.key),
    drafted,
    reused,
    rankedArms,
  });
  appendGovernanceAudit(home, {
    action: "optimizer_loop_run",
    report_id: report.id,
    clusters: clusters.length,
    drafted: drafted.length,
    reused: reused.length,
  });
  return { reportId: report.id, clusters, drafted, reused, rankedArms, recommendedProposalId };
}

/** 臂一览（按 UCB 分数排，附分数、拉动与奖励）。 */
export function listRankedArms(home: string): { key: string; category: string; checkId: string; pulls: number; rewards: number; score: number }[] {
  const arms = loadArmsLedger(home).arms;
  const total = totalPulls(arms);
  return rankArms(arms).map((a) => ({
    key: a.key,
    category: a.category,
    checkId: a.checkId,
    pulls: a.pulls,
    rewards: a.rewards,
    score: ucbScore(a, total),
  }));
}

function printLoopOutcome(outcome: EvalLoopOutcome): void {
  console.log(`评测报告 ${outcome.reportId}：${outcome.clusters.length} 个失败簇`);
  for (const c of outcome.clusters) {
    console.log(`  ${c.key}（${c.taskIds.length} 题：${c.taskIds.join("、")}）`);
  }
  console.log(`新起草提议 ${outcome.drafted.length} 条：${outcome.drafted.join("、") || "无"}`);
  console.log(`已有未结提议、复用 ${outcome.reused.length} 条：${outcome.reused.join("、") || "无"}`);
  console.log(`UCB 排队：${outcome.rankedArms.join(" > ") || "（暂无臂）"}`);
  if (outcome.recommendedProposalId) {
    console.log(`下一步最值得批：${outcome.recommendedProposalId}（nyra optimize approve <id> --yes，批过再 apply、verify）`);
  } else {
    console.log("没有可批的 draft 提议");
  }
  console.log("注意：loop 只起草、不改文件；改文件须人批 apply，验证不过自动回滚。");
}

function printArms(home: string): void {
  const rows = listRankedArms(home);
  if (rows.length === 0) {
    console.log("暂无 UCB 臂（先跑一次 nyra optimize loop 读评测报告）");
    return;
  }
  for (const r of rows) {
    const score = Number.isFinite(r.score) ? r.score.toFixed(3) : "∞（未试过）";
    console.log(`${r.key} 分数 ${score} 拉动 ${r.pulls} 奖励 ${r.rewards}`);
  }
}

// ---------------------------------------------------------------------------
// CLI：nyra optimize loop|arms（从 optimizer.ts 的 handleOptimize 动态 import
// 进来，避免 evalLoop → optimizer 的静态 import 成环）。
// ---------------------------------------------------------------------------

export function handleOptimizeLoop(args: string[], home: string, workdir: string): number {
  const [sub, ...rest] = args;
  const json = hasFlag(args, "--json");
  if (sub === "loop") {
    const reportPath = getFlag(rest, "--eval-report");
    const target = getFlag(rest, "--target");
    if (!reportPath || !target) {
      throw new EvalLoopError("用法：nyra optimize loop --eval-report <报告.json> --target <指令文档，如 docs/notes.md> [--json]");
    }
    const outcome = runEvalLoop(home, workdir, { reportPath, target });
    if (json) console.log(JSON.stringify(outcome, null, 2));
    else printLoopOutcome(outcome);
    return 0;
  }
  if (sub === "arms") {
    const rows = listRankedArms(home);
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printArms(home);
    }
    return 0;
  }
  throw new EvalLoopError("用法：nyra optimize <loop|arms> ...（loop 读评测报告自动起草提议并按 UCB 排队；arms 看臂排行。详见 docs/governance.md）");
}
