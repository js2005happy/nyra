// Private worker; only the parent evaluation entry point launches this process.
import { EVAL_TASKS, type EvalConditions } from '../../src/eval/catalog.ts';
import { executeLiveEvalTask } from '../../src/eval/live.ts';
const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as {
  taskId: string;
  conditions: EvalConditions;
  workdir: string;
  home: string;
  apiHelperPath?: string;
};
const task = EVAL_TASKS.find((t) => t.id === input.taskId);
if (!task) throw new Error('评测任务不存在');
// Agent's human-facing console output must not corrupt the worker JSON protocol.
console.log = () => {};
console.error = () => {};
try {
  process.stdout.write(
    JSON.stringify(await executeLiveEvalTask(task, input.conditions, input)),
  );
} catch {
  process.stdout.write(
    JSON.stringify({
      status: 'failed',
      reason: 'worker-execution-failed',
      checks: [],
      spentUsd: null,
      interventions: null,
      modelCalls: null,
    }),
  );
}
