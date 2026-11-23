// src/evalCli.ts — G-P1-30：nyra eval（场景评测台 + 外部基准集 + 仓内探针）。
//
//   只读命令（scenarios / scorecard / benchmarks / benchmark / probes /
//   manifest）+ 两处写盘：import（写 ~/.nyra/eval-benchmarks/）与
//   manifest --out（写一份 JSON 清单）。不跑评测、不调模型、不花 token；
//   跑在 scripts/eval.ts（bun run scripts/eval.ts run --scenario /
//   --benchmark / --probe），与正常 CLI 执行刻意分开。
import { writeEvalJson } from "./eval/runner.ts";
import {
  buildEvalManifest,
  EVAL_SCENARIOS,
  loadEvalReportForBench,
  scenarioScorecard,
} from "./eval/scenarios.ts";
import {
  importBenchmark,
  listBenchmarks,
  listRepoProbes,
  loadBenchmark,
  loadRepoProbe,
  removeBenchmark,
} from "./eval/benchmarks.ts";

export class EvalCliError extends Error {}

const USAGE =
  "用法：nyra eval <scenarios|scorecard <报告.json>|benchmarks|import <文件> [--name <名>]|benchmark <名>|remove <名> --yes|probes|probe <名>|manifest <报告.json> [--out <文件>]> [--json]（详见 docs/eval.md）";

function getFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export function handleEval(args: string[], home: string, _workdir: string): number {
  const [sub, ...rest] = args;
  const json = hasFlag(args, "--json");
  if (!sub || sub === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (sub === "scenarios") {
    const rows = EVAL_SCENARIOS.map((s) => ({
      id: s.id,
      name: s.name,
      nameEn: s.nameEn,
      description: s.description,
      tasks: s.taskIds.length,
      taskIds: s.taskIds,
    }));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else {
      for (const r of rows) {
        console.log(`${r.id}（${r.name}）：${r.tasks} 题——${r.description}`);
      }
    }
    return 0;
  }
  if (sub === "scorecard") {
    const reportPath = rest.find((a) => !a.startsWith("--"));
    if (!reportPath) throw new EvalCliError("用法：nyra eval scorecard <报告.json> [--json]");
    const card = scenarioScorecard(loadEvalReportForBench(reportPath));
    if (json) {
      console.log(JSON.stringify(card, null, 2));
      return 0;
    }
    console.log(`评测报告 ${card.reportId}（${card.suite}）`);
    for (const s of card.scenarios) {
      console.log(
        `  ${s.scenario}（${s.name}）：${s.passed}/${s.total} 过（首轮通过率 ${pct(s.firstAttemptPassRate)}，失败 ${s.failed}，阻塞 ${s.blocked}，重试挽回 ${s.retryRecovery}）成熟度 ${s.maturity.level === null ? "未评测" : `${s.maturity.level} 级 ${s.maturity.label}`}`,
      );
    }
    const o = card.overall;
    console.log(
      `  合计：${o.passed}/${o.total} 过（首轮通过率 ${pct(o.firstAttemptPassRate)}，失败 ${o.failed}，阻塞 ${o.blocked}，重试挽回 ${o.retryRecovery}）成熟度 ${o.maturity.level === null ? "未评测" : `${o.maturity.level} 级 ${o.maturity.label}`}`,
    );
    return 0;
  }
  if (sub === "benchmarks") {
    const rows = listBenchmarks(home);
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      console.log("暂无已导入的基准集（nyra eval import <文件>）");
      return 0;
    }
    for (const r of rows) {
      console.log(
        r.valid
          ? `${r.name} v${r.version}（${r.tasks} 题，来源 ${r.source}）`
          : `${r.name}（无效：${r.error}）`,
      );
    }
    return 0;
  }
  if (sub === "import") {
    const file = rest.find((a) => !a.startsWith("--"));
    const name = getFlag(rest, "--name");
    if (!file) throw new EvalCliError("用法：nyra eval import <文件> [--name <名>]");
    const set = importBenchmark(home, file, name ?? undefined);
    if (json) console.log(JSON.stringify({ name: set.name, version: set.version, tasks: set.tasks.length }, null, 2));
    else console.log(`已导入基准集 ${set.name} v${set.version}（${set.tasks.length} 题）`);
    return 0;
  }
  if (sub === "benchmark") {
    const name = rest.find((a) => !a.startsWith("--"));
    if (!name) throw new EvalCliError("用法：nyra eval benchmark <名> [--json]");
    const set = loadBenchmark(home, name);
    if (json) {
      console.log(JSON.stringify(set, null, 2));
      return 0;
    }
    console.log(`基准集 ${set.name} v${set.version}（来源 ${set.source}，${set.tasks.length} 题）`);
    for (const t of set.tasks) {
      console.log(`  ${t.id} [${t.category}] ${t.checks.length} 个验收项`);
    }
    return 0;
  }
  if (sub === "remove") {
    const name = rest.find((a) => !a.startsWith("--"));
    if (!name || !hasFlag(rest, "--yes")) {
      throw new EvalCliError("用法：nyra eval remove <名> --yes（删掉已导入的基准集，不可恢复）");
    }
    removeBenchmark(home, name);
    console.log(`已删除基准集 ${name}`);
    return 0;
  }
  if (sub === "probes") {
    const { dir, available, probes } = listRepoProbes();
    if (json) {
      console.log(JSON.stringify({ dir, available, probes }, null, 2));
      return 0;
    }
    if (!available) {
      console.log(`仓内探针不可用（当前安装不含 evals/probes 目录：${dir}）`);
      return 0;
    }
    if (probes.length === 0) {
      console.log("仓内暂无探针");
      return 0;
    }
    for (const p of probes) {
      console.log(
        p.valid
          ? `${p.name} v${p.version}（${p.tasks} 题，来源 ${p.source}）`
          : `${p.name}（无效：${p.error}）`,
      );
    }
    return 0;
  }
  if (sub === "manifest") {
    const reportPath = rest.find((a) => !a.startsWith("--"));
    const out = getFlag(rest, "--out");
    if (!reportPath) throw new EvalCliError("用法：nyra eval manifest <报告.json> [--out <文件>] [--json]");
    const manifest = buildEvalManifest(loadEvalReportForBench(reportPath));
    if (out) {
      writeEvalJson(out, manifest);
      console.log(`可复现清单已写 ${out}（结果哈希 ${manifest.resultsHash.slice(0, 12)}）`);
      return 0;
    }
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }
  if (sub === "probe") {
    // 探针详情是 benchmark 的同款形状：nyra eval probe <名> 与 benchmark <名> 分开，
    // 免得仓内探针与已导入基准集重名时读错地方。
    const name = rest.find((a) => !a.startsWith("--"));
    if (!name) throw new EvalCliError("用法：nyra eval probe <名> [--json]");
    const set = loadRepoProbe(name);
    if (json) {
      console.log(JSON.stringify(set, null, 2));
      return 0;
    }
    console.log(`仓内探针 ${set.name} v${set.version}（来源 ${set.source}，${set.tasks.length} 题）`);
    for (const t of set.tasks) {
      console.log(`  ${t.id} [${t.category}] ${t.checks.length} 个验收项`);
    }
    return 0;
  }
  throw new EvalCliError(USAGE);
}
