// Deliberately separate from normal CLI execution; no user configuration/account loading.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EVAL_CONDITIONS, EVAL_TASKS } from '../src/eval/catalog.ts';
import {
  evalHash,
  readEvalJson,
  runEvalSuite,
  selectFailedEvalTasks,
  writeEvalJson,
} from '../src/eval/runner.ts';
import { makeLiveEvalAdapter } from '../src/eval/live.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2),
  action = args[0];
function flag(name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (!args[i + 1] || args[i + 1].startsWith('--'))
    throw new Error('选项缺值：' + name);
  return args[i + 1];
}
try {
  const knownFlags = new Set(['--out', '--from', '--model', '--retries']);
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    if (
      !knownFlags.has(args[i]) ||
      seen.has(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('评测选项无效');
    seen.add(args[i]);
  }
  if (!action || action === '--help') {
    console.log(
      '用法：bun run scripts/eval.ts list | run --out <报告.json> | rerun --from <报告.json> --out <新报告.json>\n可选：--model <本地模型名> --retries <0–2>；退出码 0 全部首次通过，3 有失败或阻塞，2 用法错误。',
    );
  } else if (action === 'list')
    console.log(
      JSON.stringify(
        {
          conditions: DEFAULT_EVAL_CONDITIONS,
          tasks: EVAL_TASKS.map(({ solution, testBody, ...t }) => t),
        },
        null,
        2,
      ),
    );
  else if (action === 'run' || action === 'rerun') {
    const out = flag('--out');
    if (!out) throw new Error('必须指定 --out；不会覆盖旧基线');
    const { existsSync } = await import('node:fs');
    if (existsSync(out)) throw new Error('报告已存在，请用新文件名');
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (revision.status !== 0) throw new Error('无法确定源码版本');
    const sourceRevision = revision.stdout.trim();
    const tracked = spawnSync('git', ['ls-files', 'src'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (tracked.status !== 0) throw new Error('无法确定核心源码摘要');
    const sourceHash = evalHash(
      tracked.stdout
        .trim()
        .split('\n')
        .filter((p) => Boolean(p) && !p.startsWith('src/eval/'))
        .sort()
        .map((p) => [p, readFileSync(join(root, p), 'utf8')]),
    );
    const harnessFiles = [
      ...readdirSync(join(root, 'src/eval'))
        .filter((x) => x.endsWith('.ts'))
        .map((x) => 'src/eval/' + x),
      'scripts/eval.ts',
      'scripts/eval/worker.ts',
    ];
    const harnessHash = evalHash(
      harnessFiles.sort().map((p) => [p, readFileSync(join(root, p), 'utf8')]),
    );
    let conditions = {
      ...DEFAULT_EVAL_CONDITIONS,
      model: flag('--model') ?? DEFAULT_EVAL_CONDITIONS.model,
    };
    let taskIds: string[] | undefined,
      parentReport: string | undefined,
      requiredConditionsHash: string | undefined;
    if (action === 'rerun') {
      const from = flag('--from');
      if (!from) throw new Error('重跑须指定 --from');
      const previous = readEvalJson(from);
      taskIds = selectFailedEvalTasks(
        previous,
        sourceRevision,
        harnessHash,
        sourceHash,
      );
      if (!taskIds.length)
        throw new Error('没有失败的已执行任务；阻塞任务须补齐条件后新建基线');
      if (flag('--model') && flag('--model') !== previous.conditions.model)
        throw new Error('同条件重跑不能更换模型');
      conditions = previous.conditions;
      parentReport = previous.id;
      requiredConditionsHash = previous.conditionsHash;
    }
    const report = await runEvalSuite({
      root: join(dirname(resolve(out)), '.eval-runs'),
      sourceRevision,
      sourceHash,
      harnessHash,
      conditions,
      adapter: makeLiveEvalAdapter(conditions),
      taskIds,
      parentReport,
      requiredConditionsHash,
      retries: Number(flag('--retries') ?? 1),
      onProgress: (id, status) =>
        process.stderr.write(id + ' ' + status + '\n'),
    });
    writeEvalJson(out, report);
    console.log(JSON.stringify(report.summary, null, 2));
    process.exitCode =
      report.summary.passed === report.summary.total && report.summary.total > 0
        ? 0
        : 3;
  } else throw new Error('未知评测子命令');
} catch {
  process.stderr.write(
    '评测未启动：参数、报告或版本无效；请运行 --help 并检查输入。\n',
  );
  process.exitCode = 2;
}
