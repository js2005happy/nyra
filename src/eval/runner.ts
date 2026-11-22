// Opt-in evaluation runner. It never replays arbitrary production side effects.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { RunStore } from '../runs.ts';
import { resolveDeepSeekEvalPricing } from './apiProvider.ts';
import {
  addRegressionCases,
  loadRegressionStore,
  setRegressionCaseStatus,
} from '../regression.ts';
import {
  DEFAULT_EVAL_CONDITIONS,
  EVAL_TASKS,
  type EvalConditions,
  type EvalTask,
} from './catalog.ts';
export type EvalStatus = 'passed' | 'failed' | 'blocked';
export interface EvalCheck {
  id: string;
  passed: boolean;
  evidence: string;
}
export interface EvalOutcome {
  status: EvalStatus;
  reason: string | null;
  checks: EvalCheck[];
  spentUsd: number | null;
  interventions: number | null;
  modelCalls: number | null;
  runId?: string | null;
}
export interface EvalAttempt extends EvalOutcome {
  taskId: string;
  attempt: number;
  durationMs: number;
  conditionsHash: string;
}
export interface EvalResult {
  taskId: string;
  category: string;
  attempts: EvalAttempt[];
}
export interface EvalReport {
  schemaVersion: 1;
  suite: 'nyra-real-tasks-v1';
  id: string;
  createdAt: string;
  sourceRevision: string;
  sourceHash: string;
  harnessHash: string;
  catalogHash: string;
  conditions: EvalConditions;
  conditionsHash: string;
  environment: Record<string, string | null>;
  wallDurationMs: number;
  finishedAt: string | null;
  parentReport: string | null;
  results: EvalResult[];
  summary: ReturnType<typeof summarizeEval>;
}
export interface EvalAdapter {
  environment?(): Promise<Record<string, string | null>>;
  preflight(task: EvalTask, conditions: EvalConditions): Promise<string | null>;
  execute(
    task: EvalTask,
    conditions: EvalConditions,
    context: { workdir: string; home: string; apiHelperPath?: string },
  ): Promise<EvalOutcome>;
}
export function evalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function safeEvalPath(root: string, name: string): string {
  if (
    !name ||
    name.includes('\\') ||
    name.split('/').some((p) => p === '..' || p === '.' || !p)
  )
    throw new Error('评测相对路径无效');
  const base = resolve(root),
    path = resolve(base, name);
  if (!path.startsWith(base + sep)) throw new Error('评测路径越界');
  let ancestor = base;
  for (;;) {
    try {
      if (lstatSync(ancestor).isSymbolicLink())
        throw new Error('评测根目录不能经过符号链接');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let cursor = base;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error('评测路径不能是符号链接');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return path;
}
export function writeEvalJson(path: string, value: unknown): void {
  // Trusted output location; refuse symlink parents instead of following them.
  let cursor = resolve(path);
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error('评测输出不能经过符号链接');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    rmSync(tmp, { force: true });
  }
}
export function validateEvalConditions(c: EvalConditions): void {
  if (c.provider === 'deepseek') {
    // API 通道（整合者增补）：只认峰时价表里的两个模型，单价须与表精确一致，
    // 每尝试上限须大于 0；digest 不存在，报告里记 null。
    const pricing = resolveDeepSeekEvalPricing(c.model);
    if (!pricing)
      throw new Error('API 基线只支持 deepseek-flash 与 deepseek-v4-pro');
    if (
      c.inputPer1M !== pricing.inputPer1M ||
      c.outputPer1M !== pricing.outputPer1M ||
      c.maxCostUsd <= 0
    )
      throw new Error('API 基线单价须与 DeepSeek 峰时价一致，且须设每尝试上限');
  } else if (
    c.provider !== 'ollama' ||
    !/^[A-Za-z0-9_.:/-]{1,120}$/.test(c.model) ||
    c.model.includes('..')
  )
    throw new Error('第一批只支持显式本地 Ollama 模型');
  else if (c.inputPer1M !== 0 || c.outputPer1M !== 0 || c.maxCostUsd !== 0)
    throw new Error('本地模型 API 预算必须为 0；硬件成本不计入美元账本');
  if (
    !Number.isInteger(c.maxTurns) ||
    c.maxTurns < 1 ||
    c.maxTurns > 20 ||
    !Number.isInteger(c.timeoutMs) ||
    c.timeoutMs < 1 ||
    c.timeoutMs > 600000
  )
    throw new Error('评测轮数或超时无效');
}
export function summarizeEval(results: EvalResult[]) {
  const attempts = results.flatMap((r) => r.attempts);
  const initial = results
    .filter((r) => r.attempts.length)
    .map((r) => r.attempts[0]);
  const passed = initial.filter((a) => a.status === 'passed').length;
  const failed = initial.filter((a) => a.status === 'failed').length;
  const blocked = initial.filter((a) => a.status === 'blocked').length;
  const executed = passed + failed;
  const unknownCostAttempts = attempts.filter(
    (a) => a.spentUsd === null,
  ).length;
  const unknownInterventionAttempts = attempts.filter(
    (a) => a.interventions === null,
  ).length;
  const knownSpentUsd = attempts.reduce((n, a) => n + (a.spentUsd ?? 0), 0);
  return {
    total: results.length,
    passed,
    failed,
    blocked,
    executed,
    successRateAll: results.length ? passed / results.length : null,
    successRateExecuted: executed ? passed / executed : null,
    executionCoverage: results.length ? executed / results.length : null,
    recoveredOnRetry: results.filter(
      (r) =>
        r.attempts[0]?.status === 'failed' &&
        r.attempts.slice(1).some((a) => a.status === 'passed'),
    ).length,
    attempts: attempts.length,
    modelCalls: attempts.some((a) => a.modelCalls === null)
      ? null
      : attempts.reduce((n, a) => n + (a.modelCalls ?? 0), 0),
    unknownModelCallAttempts: attempts.filter((a) => a.modelCalls === null)
      .length,
    knownSpentUsd,
    spentUsd: unknownCostAttempts ? null : knownSpentUsd,
    unknownCostAttempts,
    durationMs:
      Math.round(attempts.reduce((n, a) => n + a.durationMs, 0) * 1000) / 1000,
    interventions: unknownInterventionAttempts
      ? null
      : attempts.reduce((n, a) => n + (a.interventions ?? 0), 0),
    unknownInterventionAttempts,
  };
}
function validateOutcome(o: EvalOutcome): EvalOutcome {
  if (
    !['passed', 'failed', 'blocked'].includes(o.status) ||
    !Array.isArray(o.checks) ||
    o.checks.some(
      (c) =>
        typeof c.id !== 'string' ||
        typeof c.passed !== 'boolean' ||
        typeof c.evidence !== 'string',
    ) ||
    (o.modelCalls !== null &&
      (!Number.isInteger(o.modelCalls) || o.modelCalls < 0)) ||
    (o.spentUsd !== null && (!Number.isFinite(o.spentUsd) || o.spentUsd < 0)) ||
    (o.interventions !== null &&
      (!Number.isInteger(o.interventions) || o.interventions < 0))
  )
    throw new Error('评测适配器返回无效指标');
  if (
    o.status === 'passed' &&
    (!o.checks.length || o.checks.some((c) => !c.passed))
  )
    return { ...o, status: 'failed', reason: '验收项没有全部通过' };
  return o;
}
export function selectFailedEvalTasks(
  previous: EvalReport,
  sourceRevision: string,
  harnessHash: string,
  sourceHash: string = sourceRevision,
): string[] {
  if (
    previous.schemaVersion !== 1 ||
    previous.suite !== 'nyra-real-tasks-v1' ||
    previous.sourceRevision !== sourceRevision ||
    previous.sourceHash !== sourceHash ||
    previous.harnessHash !== harnessHash ||
    previous.catalogHash !== evalHash(EVAL_TASKS) ||
    !previous.finishedAt ||
    previous.conditionsHash !==
      evalHash({
        conditions: previous.conditions,
        environment: previous.environment,
      })
  )
    throw new Error('评测条件或版本已变化，请新建基线，不能冒充同条件重跑');
  validateEvalConditions(previous.conditions);
  if (
    !Array.isArray(previous.results) ||
    previous.results.some(
      (r) => !EVAL_TASKS.some((t) => t.id === r.taskId) || !r.attempts?.length,
    )
  )
    throw new Error('评测报告任务无效');
  return [
    ...new Set(
      previous.results
        .filter((r) => r.attempts[0]?.status === 'failed')
        .map((r) => r.taskId),
    ),
  ];
}
export async function runEvalSuite(options: {
  root: string;
  sourceRevision: string;
  sourceHash?: string;
  harnessHash: string;
  adapter: EvalAdapter;
  conditions?: EvalConditions;
  retries?: number;
  taskIds?: string[];
  parentReport?: string;
  requiredConditionsHash?: string;
  onProgress?: (taskId: string, status: EvalStatus) => void;
}): Promise<EvalReport> {
  const wallStarted = performance.now();
  const conditions = structuredClone(
    options.conditions ?? DEFAULT_EVAL_CONDITIONS,
  );
  validateEvalConditions(conditions);
  const retries = options.retries ?? 1;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2)
    throw new Error('失败重跑次数须为 0–2');
  const ids = options.taskIds ?? EVAL_TASKS.map((t) => t.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !EVAL_TASKS.some((t) => t.id === id))
  )
    throw new Error('评测任务 ID 无效');
  const environment = (await options.adapter.environment?.()) ?? {};
  const conditionsHash = evalHash({ conditions, environment });
  if (
    options.requiredConditionsHash &&
    options.requiredConditionsHash !== conditionsHash
  )
    throw new Error('模型或运行环境已变化，请新建基线');
  const id = 'ev-' + randomBytes(6).toString('hex');
  const suiteRoot = safeEvalPath(options.root, id);
  mkdirSync(suiteRoot, { recursive: true, mode: 0o700 });
  const store = new RunStore(join(suiteRoot, 'runs'));
  const suiteRun = store.create('固定任务评测', id, suiteRoot, 'auto', 1);
  const report: EvalReport = {
    schemaVersion: 1,
    suite: 'nyra-real-tasks-v1',
    id,
    createdAt: new Date().toISOString(),
    sourceRevision: options.sourceRevision,
    sourceHash: options.sourceHash ?? options.sourceRevision,
    harnessHash: options.harnessHash,
    catalogHash: evalHash(EVAL_TASKS),
    conditions,
    environment,
    conditionsHash,
    wallDurationMs: 0,
    finishedAt: null,
    parentReport: options.parentReport ?? null,
    results: [],
    summary: summarizeEval([]),
  };
  const checkpoint = () => {
    report.summary = summarizeEval(report.results);
    writeEvalJson(join(suiteRoot, 'report.json'), report);
  };
  checkpoint();
  for (const taskId of ids) {
    const task = EVAL_TASKS.find((t) => t.id === taskId)!;
    const result: EvalResult = {
      taskId,
      category: task.category,
      attempts: [],
    };
    report.results.push(result);
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const started = performance.now();
      store.appendEvent(suiteRun.run_id, 'eval_attempt_started', {
        task_id: taskId,
        attempt,
        conditions_hash: report.conditionsHash.slice(0, 12),
      });
      const attemptRoot = safeEvalPath(suiteRoot, taskId + '/' + attempt);
      const workdir = join(attemptRoot, 'workspace'),
        home = join(attemptRoot, 'home');
      mkdirSync(workdir, { recursive: true, mode: 0o700 });
      mkdirSync(home, { mode: 0o700 });
      for (const [name, content] of Object.entries(task.fixture)) {
        const path = safeEvalPath(workdir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, { mode: 0o600 });
      }
      let outcome: EvalOutcome;
      try {
        const reason = await options.adapter.preflight(
          structuredClone(task),
          structuredClone(conditions),
        );
        outcome = reason
          ? {
              status: 'blocked',
              reason,
              checks: [],
              spentUsd: 0,
              interventions: 0,
              modelCalls: 0,
            }
          : validateOutcome(
              await options.adapter.execute(
                structuredClone(task),
                structuredClone(conditions),
                { workdir, home },
              ),
            );
      } catch {
        // Uncertain side effects/usage are never represented as free successful calls.
        outcome = {
          status: 'failed',
          reason: '评测执行异常，指标未知',
          checks: [],
          spentUsd: null,
          interventions: null,
          modelCalls: null,
        };
      }
      result.attempts.push({
        ...outcome,
        taskId,
        attempt,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        conditionsHash: report.conditionsHash,
      });
      store.appendEvent(suiteRun.run_id, 'eval_attempt_finished', {
        task_id: taskId,
        attempt,
        status: outcome.status,
        spent_usd: outcome.spentUsd,
        duration_ms: result.attempts.at(-1)!.durationMs,
        interventions: outcome.interventions,
        child_run_id: outcome.runId ?? null,
      });
      // Reuse the existing failure metadata store. Only fixed disposable tasks can be replayed.
      const caseTitle =
        'eval:' + taskId + ':' + report.conditionsHash.slice(0, 12);
      if (outcome.status === 'failed')
        addRegressionCases(suiteRoot, [
          {
            id: 'rg_' + randomBytes(6).toString('hex'),
            sourceRunId: suiteRun.run_id,
            kind: 'verdict-failed',
            title: caseTitle,
            detail: '固定任务产物验收或执行未通过',
            status: 'open',
            createdAt: new Date().toISOString(),
          },
        ]);
      if (outcome.status === 'passed')
        for (const c of loadRegressionStore(suiteRoot).cases) {
          if (
            c.sourceRunId === suiteRun.run_id &&
            c.title === caseTitle &&
            c.status === 'open'
          )
            setRegressionCaseStatus(suiteRoot, c.id, 'verified');
        }
      checkpoint();
      options.onProgress?.(taskId, outcome.status);
      if (outcome.status !== 'failed') break;
      if (attempt <= retries)
        store.appendEvent(suiteRun.run_id, 'eval_retry_scheduled', {
          task_id: taskId,
          attempt: attempt + 1,
        });
    }
  }
  report.finishedAt = new Date().toISOString();
  report.wallDurationMs =
    Math.round((performance.now() - wallStarted) * 1000) / 1000;
  checkpoint();
  store.setStatus(
    suiteRun.run_id,
    report.results.every((r) => r.attempts[0].status === 'passed')
      ? 'verified'
      : 'incomplete',
  );
  return report;
}
export function readEvalJson(path: string): EvalReport {
  return JSON.parse(readFileSync(path, 'utf8'));
}
