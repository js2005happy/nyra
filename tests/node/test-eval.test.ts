import { test, expect, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EVAL_TASKS, DEFAULT_EVAL_CONDITIONS } from '../../src/eval/catalog.ts';
import {
  runEvalSuite,
  summarizeEval,
  selectFailedEvalTasks,
  safeEvalPath,
  validateEvalConditions,
  writeEvalJson,
  type EvalAdapter,
  type EvalOutcome,
} from '../../src/eval/runner.ts';
import {
  DeepSeekConnectorProvider,
  resolveDeepSeekEvalPricing,
  resolveDeepSeekHelperPath,
} from '../../src/eval/apiProvider.ts';
import { isCancelError } from '../../src/cancel.ts';
import {
  checkJsonArtifact,
  checkMailbox,
  fixtureIntegrity,
  checkBrowserState,
} from '../../src/eval/checks.ts';
import { createEvalMailbox } from '../../src/eval/fixtures.ts';
import { executeLiveEvalTask, cleanEvalEnv } from '../../src/eval/live.ts';
import { expectPerms } from './fsPerms.ts';
const dirs: string[] = [];
function tmp() {
  const p = mkdtempSync(join(tmpdir(), 'nyra-eval-test-'));
  dirs.push(p);
  return p;
}
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
const pass = (): EvalOutcome => ({
  status: 'passed',
  reason: null,
  checks: [{ id: 'state', passed: true, evidence: 'hash' }],
  spentUsd: 0,
  interventions: 0,
  modelCalls: 1,
});
const fail = (): EvalOutcome => ({
  ...pass(),
  status: 'failed',
  reason: 'acceptance-failed',
  checks: [{ id: 'state', passed: false, evidence: 'hash' }],
});
const opts = (adapter: EvalAdapter) => ({
  root: tmp(),
  sourceRevision: 'baseline',
  harnessHash: 'harness',
  adapter,
});
const adapter = (
  execute: EvalAdapter['execute'],
  preflight: EvalAdapter['preflight'] = async () => null,
): EvalAdapter => ({ execute, preflight });
test('Eval catalog has twenty distinct fixed tasks with four equal categories', () => {
  expect(EVAL_TASKS).toHaveLength(20);
  expect(new Set(EVAL_TASKS.map((t) => t.id)).size).toBe(20);
  for (const category of ['code', 'browser', 'research', 'connector'])
    expect(EVAL_TASKS.filter((t) => t.category === category)).toHaveLength(5);
  expect(EVAL_TASKS.every((t) => t.description && t.acceptance)).toBe(true);
  expect(DEFAULT_EVAL_CONDITIONS.model).toBe('qwen2.5:7b');
  expect(DEFAULT_EVAL_CONDITIONS.maxCostUsd).toBe(0);
});
test('Eval keeps first failure and retries from fresh identical fixture and home', async () => {
  const contexts: string[] = [],
    hashes: string[] = [];
  let n = 0;
  const config = opts(
    adapter(async (task, c, ctx) => {
      contexts.push(ctx.workdir);
      hashes.push(readFileSync(join(ctx.workdir, 'module.mjs'), 'utf8'));
      expect(readdirSync(ctx.home)).toEqual([]);
      writeFileSync(join(ctx.home, 'state'), 'dirty');
      writeFileSync(join(ctx.workdir, 'module.mjs'), 'dirty');
      task.description = 'mutated';
      c.model = 'mutated';
      return n++ === 0 ? fail() : pass();
    }),
  );
  const report = await runEvalSuite({ ...config, taskIds: ['code-01'] });
  expect(contexts[0]).not.toBe(contexts[1]);
  expect(hashes[0]).toBe(hashes[1]);
  expect(report.conditions.model).toBe('qwen2.5:7b');
  expect(report.results[0].attempts.map((a) => a.status)).toEqual([
    'failed',
    'passed',
  ]);
  expect(report.summary.successRateAll).toBe(0);
  expect(report.summary.recoveredOnRetry).toBe(1);
  expect(report.summary.modelCalls).toBe(2);
  expect(report.results[0].attempts[0].conditionsHash).toBe(
    report.results[0].attempts[1].conditionsHash,
  );
  const eventFiles = join(config.root, report.id, 'runs');
  const events = readFileSync(
    join(eventFiles, readdirSync(eventFiles)[0], 'events.jsonl'),
    'utf8',
  );
  expect(events).toContain('eval_retry_scheduled');
  expect(events).not.toContain(config.root);
  expectPerms(join(config.root, report.id, 'report.json'), 0o600);
  const regression = JSON.parse(
    readFileSync(join(config.root, report.id, 'regression-cases.json'), 'utf8'),
  );
  expect(regression.cases).toHaveLength(1);
  expect(regression.cases[0].status).toBe('verified');
  expect(JSON.stringify(regression)).not.toContain(config.root);
});
test('Eval blocked prerequisites are not failures and do not invoke or retry model', async () => {
  let calls = 0;
  const report = await runEvalSuite({
    ...opts(
      adapter(
        async () => {
          calls++;
          return pass();
        },
        async () => 'local-model-unavailable',
      ),
    ),
  });
  expect(calls).toBe(0);
  expect(report.summary.blocked).toBe(20);
  expect(report.summary.attempts).toBe(20);
  expect(report.summary.successRateExecuted).toBeNull();
  expect(report.summary.executionCoverage).toBe(0);
  expect(report.summary.spentUsd).toBe(0);
});
test('Eval cannot pass with absent or failing acceptance checks', async () => {
  for (const checks of [
    [],
    [{ id: 'file', passed: false, evidence: 'missing' }],
  ]) {
    const report = await runEvalSuite({
      ...opts(adapter(async () => ({ ...pass(), checks }))),
      taskIds: ['research-01'],
      retries: 0,
    });
    expect(report.summary.failed).toBe(1);
  }
});
test('Eval unknown cost and interventions remain unknown across retries', async () => {
  const report = await runEvalSuite({
    ...opts(
      adapter(async () => ({ ...fail(), spentUsd: null, interventions: null })),
    ),
    taskIds: ['code-01'],
  });
  expect(report.summary.spentUsd).toBeNull();
  expect(report.summary.knownSpentUsd).toBe(0);
  expect(report.summary.interventions).toBeNull();
  expect(report.summary.unknownCostAttempts).toBe(2);
});
test('Eval execution exception is failed with unknown usage and bounded retry', async () => {
  let n = 0;
  const report = await runEvalSuite({
    ...opts(
      adapter(async () => {
        n++;
        throw new Error('private path');
      }),
    ),
    taskIds: ['code-01'],
  });
  expect(n).toBe(2);
  expect(report.summary.failed).toBe(1);
  expect(report.summary.spentUsd).toBeNull();
  expect(JSON.stringify(report)).not.toContain('private path');
});
test('Eval rejects invalid attempts metrics and task identifiers', async () => {
  for (const retries of [-1, 3, 1.5])
    await expect(
      runEvalSuite({ ...opts(adapter(async () => pass())), retries }),
    ).rejects.toThrow();
  await expect(
    runEvalSuite({ ...opts(adapter(async () => pass())), taskIds: ['../bad'] }),
  ).rejects.toThrow();
  const report = await runEvalSuite({
    ...opts(adapter(async () => ({ ...pass(), spentUsd: NaN }))),
    taskIds: ['code-01'],
    retries: 0,
  });
  expect(report.summary.failed).toBe(1);
  expect(report.summary.spentUsd).toBeNull();
});
test('Eval replays only mapped failed fixed tasks with pinned conditions and revision', async () => {
  const report = await runEvalSuite({
    ...opts(adapter(async () => fail())),
    taskIds: ['code-01'],
    retries: 0,
  });
  expect(selectFailedEvalTasks(report, 'baseline', 'harness')).toEqual([
    'code-01',
  ]);
  expect(() => selectFailedEvalTasks(report, 'other', 'harness')).toThrow();
  expect(() =>
    selectFailedEvalTasks(report, 'baseline', 'harness', 'dirty-core'),
  ).toThrow();
  expect(() =>
    selectFailedEvalTasks(
      { ...report, conditions: { ...report.conditions, model: 'other' } },
      'baseline',
      'harness',
    ),
  ).toThrow();
  expect(() =>
    selectFailedEvalTasks(report, 'baseline', 'new-harness'),
  ).toThrow();
});
test('Eval denominator separates coverage from executed success and keeps totals', async () => {
  const report = await runEvalSuite({
    ...opts(
      adapter(
        async (t) =>
          t.id === 'code-01'
            ? pass()
            : { ...fail(), spentUsd: 0.02, interventions: 2 },
        async (t) => (t.id === 'code-03' ? 'blocked' : null),
      ),
    ),
    taskIds: ['code-01', 'code-02', 'code-03'],
    retries: 0,
  });
  expect(report.summary.successRateAll).toBe(1 / 3);
  expect(report.summary.successRateExecuted).toBe(0.5);
  expect(report.summary.executionCoverage).toBe(2 / 3);
  expect(report.summary.spentUsd).toBe(0.02);
  expect(report.summary.interventions).toBe(2);
  expect(summarizeEval([]).successRateAll).toBeNull();
});
test('Eval real artifact comparison rejects prose and verifies sources and source integrity', () => {
  const workdir = tmp(),
    task = EVAL_TASKS.find((t) => t.id === 'research-01')!;
  mkdirSync(join(workdir, 'sources'));
  for (const [p, v] of Object.entries(task.fixture))
    writeFileSync(join(workdir, p), v);
  writeFileSync(join(workdir, 'result.json'), 'Done');
  expect(checkJsonArtifact(workdir, task.expected).passed).toBe(false);
  writeFileSync(join(workdir, 'result.json'), JSON.stringify(task.expected));
  expect(checkJsonArtifact(workdir, task.expected).passed).toBe(true);
  expect(fixtureIntegrity(task, workdir).every((c) => c.passed)).toBe(true);
  writeFileSync(join(workdir, 'sources/current.md'), 'changed');
  expect(fixtureIntegrity(task, workdir).every((c) => c.passed)).toBe(false);
  writeFileSync(
    join(workdir, 'result.json'),
    JSON.stringify({ answer: 49.9, sources: ['old.md'] }),
  );
  expect(checkJsonArtifact(workdir, task.expected).passed).toBe(false);
});
test('Eval symlink and traversal artifacts cannot escape workspace', () => {
  const workdir = tmp(),
    outside = tmp();
  writeFileSync(join(outside, 'result.json'), '{}');
  expect(() => safeEvalPath(workdir, '../result.json')).toThrow();
  expect(() => safeEvalPath(workdir, '/tmp/result.json')).toThrow();
  if (process.platform !== 'win32') {
    symlinkSync(join(outside, 'result.json'), join(workdir, 'result.json'));
    expect(checkJsonArtifact(workdir, {}).passed).toBe(false);
    expect(() => writeEvalJson(join(workdir, 'result.json'), {}, workdir)).toThrow();
  }
});
test('Eval report is private and atomic json', () => {
  const dir = tmp(),
    p = join(dir, 'report.json');
  writeEvalJson(p, { a: 1 }, dir);
  writeEvalJson(p, { a: 2 }, dir);
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 2 });
  expectPerms(p, 0o600);
  expect(readdirSync(join(p, '..')).filter((n) => n.endsWith('.tmp'))).toEqual(
    [],
  );
});
test('Eval mailbox verifies actual state and thread rather than generated success text', async () => {
  const { transport, state } = createEvalMailbox(),
    task = EVAL_TASKS.find((t) => t.id === 'connector-02')!;
  await transport.get('m1');
  await transport.createDraft({
    to: ['buyer@example.test'],
    subject: 'Re: Invoice',
    body: 'Received',
    threadId: 'wrong',
  });
  expect(checkMailbox(task, tmp(), state).every((c) => c.passed)).toBe(false);
  state.drafts[0].threadId = 't1';
  expect(checkMailbox(task, tmp(), state).every((c) => c.passed)).toBe(true);
  await transport.send(state.drafts[0]);
  expect(checkMailbox(task, tmp(), state).every((c) => c.passed)).toBe(false);
});
test('Eval mailbox rejects recipients outside reserved test domain', async () => {
  const { transport, state } = createEvalMailbox();
  await expect(
    transport.send({
      to: ['person@real.invalid'],
      subject: 'test',
      body: 'test',
    }),
  ).rejects.toThrow();
  expect(state.sent).toEqual([]);
});
test('Eval local environment does not inherit keys permission overrides or config', () => {
  const old = process.env.NYRA_ALLOW_PROTECTED_WRITES;
  process.env.NYRA_ALLOW_PROTECTED_WRITES = '1';
  try {
    const env = cleanEvalEnv('isolated');
    expect(env.NYRA_ALLOW_PROTECTED_WRITES).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NYRA_HOME).toBe('isolated');
  } finally {
    if (old === undefined) delete process.env.NYRA_ALLOW_PROTECTED_WRITES;
    else process.env.NYRA_ALLOW_PROTECTED_WRITES = old;
  }
});
class ScriptProvider {
  name = 'fake';
  model = 'test-only';
  baseUrl = 'https://fake.invalid';
  index = 0;
  constructor(private replies: Record<string, unknown>[]) {}
  hasCredentials() {
    return true;
  }
  redact(s: string) {
    return s;
  }
  async listModels() {
    return ['test-only'];
  }
  async chat() {
    return this.replies[Math.min(this.index++, this.replies.length - 1)];
  }
}
function tool(name: string, args: unknown) {
  return {
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 't-' + name,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}
function text() {
  return {
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    choices: [{ message: { content: '已完成', tool_calls: [] } }],
  };
}
async function liveMock(taskId: string, replies: Record<string, unknown>[]) {
  const task = EVAL_TASKS.find((t) => t.id === taskId)!,
    base = tmp(),
    workdir = join(base, 'workspace'),
    home = join(base, 'home');
  mkdirSync(workdir);
  mkdirSync(home);
  for (const [p, v] of Object.entries(task.fixture)) {
    mkdirSync(join(workdir, p, '..'), { recursive: true });
    writeFileSync(join(workdir, p), v);
  }
  return executeLiveEvalTask(
    task,
    { ...DEFAULT_EVAL_CONDITIONS },
    { workdir, home },
    new ScriptProvider(replies),
  );
}
test('Eval actual agent text-only completion cannot pass file acceptance', async () => {
  const out = await liveMock('research-01', [text()]);
  expect(out.status).toBe('failed');
  expect(out.checks.some((c) => c.id === 'artifact-json' && !c.passed)).toBe(
    true,
  );
});
test('Eval actual agent file writes traverse permission gate and evidence recorder', async () => {
  const out = await liveMock('research-01', [
    tool('write_file', {
      path: 'result.json',
      content: JSON.stringify(
        EVAL_TASKS.find((t) => t.id === 'research-01')!.expected,
      ),
    }),
    text(),
  ]);
  expect(out.status).toBe('passed');
  expect(out.modelCalls).toBe(2);
  expect(out.spentUsd).toBe(0);
  expect(out.interventions).toBe(0);
  expect(out.runId).toBeTruthy();
});
test('Eval actual agent connector reply must reach isolated mailbox with correct thread', async () => {
  const out = await liveMock('connector-03', [
    tool('gmail_read', { id: 'm1' }),
    tool('gmail_send', {
      to: ['buyer@example.test'],
      subject: 'Re: Invoice',
      body: 'Confirmed',
      thread_id: 't1',
    }),
    text(),
  ]);
  expect(out.status).toBe('passed');
  expect(out.checks.find((c) => c.id === 'mailbox-readback')?.passed).toBe(
    true,
  );
});
test('Eval actual agent forbidden source edit fails even after claiming completion', async () => {
  const out = await liveMock('research-01', [
    tool('write_file', { path: 'sources/current.md', content: 'changed' }),
    text(),
  ]);
  expect(out.status).toBe('failed');
});
for (const task of EVAL_TASKS.filter((t) => t.category === 'code')) {
  test(
    'Eval frozen code grader accepts reference and rejects original ' + task.id,
    () => {
      const workdir = tmp();
      const run = (module: string) => {
        writeFileSync(join(workdir, 'module.mjs'), module);
        return spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            'import assert from "node:assert/strict"; import * as m from "./module.mjs"; ' +
              task.testBody,
          ],
          { cwd: workdir, encoding: 'utf8', timeout: 5000 },
        );
      };
      expect(run(task.fixture['module.mjs']).status).not.toBe(0);
      expect(run(task.solution!).status).toBe(0);
    },
  );
}

test('Eval browser acceptance compares independent DOM state for all five tasks', () => {
  for (const task of EVAL_TASKS.filter((t) => t.category === 'browser')) {
    expect(checkBrowserState(task, task.browserExpected).passed).toBe(true);
    expect(checkBrowserState(task, { completed: true }).passed).toBe(false);
    expect(checkBrowserState(task, undefined).passed).toBe(false);
  }
});
test('Eval rerun rejects changed observed model digest and unfinished reports', async () => {
  const environment = async () => ({ modelDigest: 'version-a' });
  const report = await runEvalSuite({
    ...opts({ ...adapter(async () => fail()), environment }),
    taskIds: ['code-01'],
    retries: 0,
  });
  expect(() =>
    selectFailedEvalTasks(
      { ...report, finishedAt: null },
      'baseline',
      'harness',
    ),
  ).toThrow();
  await expect(
    runEvalSuite({
      ...opts({
        ...adapter(async () => pass()),
        environment: async () => ({ modelDigest: 'version-b' }),
      }),
      taskIds: ['code-01'],
      requiredConditionsHash: report.conditionsHash,
    }),
  ).rejects.toThrow();
});

test('Eval fabricated hidden tool cannot fetch or pass even with correct artifact', async () => {
  const out = await liveMock('research-01', [
    tool('web_fetch', { url: 'https://example.invalid' }),
    tool('write_file', {
      path: 'result.json',
      content: JSON.stringify(
        EVAL_TASKS.find((t) => t.id === 'research-01')!.expected,
      ),
    }),
    text(),
  ]);
  expect(out.status).toBe('failed');
  expect(out.checks.find((c) => c.id === 'allowed-tools-only')?.passed).toBe(
    false,
  );
});

test('Eval API conditions accept DeepSeek flash and pro with peak pricing and reject the rest', () => {
  const base = { ...DEFAULT_EVAL_CONDITIONS, provider: 'deepseek' };
  expect(() =>
    validateEvalConditions({
      ...base,
      model: 'deepseek-flash',
      inputPer1M: 0.3,
      outputPer1M: 1.2,
      maxCostUsd: 1,
    }),
  ).not.toThrow();
  expect(() =>
    validateEvalConditions({
      ...base,
      model: 'deepseek-v4-pro',
      inputPer1M: 1.32,
      outputPer1M: 3.96,
      maxCostUsd: 1,
    }),
  ).not.toThrow();
  expect(() =>
    validateEvalConditions({
      ...base,
      model: 'deepseek-flash',
      inputPer1M: 0.15,
      outputPer1M: 1.2,
      maxCostUsd: 1,
    }),
  ).toThrow();
  expect(() =>
    validateEvalConditions({
      ...base,
      model: 'deepseek-unknown',
      inputPer1M: 0.3,
      outputPer1M: 1.2,
      maxCostUsd: 1,
    }),
  ).toThrow();
  expect(() =>
    validateEvalConditions({
      ...base,
      model: 'deepseek-flash',
      inputPer1M: 0.3,
      outputPer1M: 1.2,
      maxCostUsd: 0,
    }),
  ).toThrow();
  expect(() => validateEvalConditions({ ...base, provider: 'openai' })).toThrow();
  expect(() => validateEvalConditions({ ...DEFAULT_EVAL_CONDITIONS })).not.toThrow();
  expect(resolveDeepSeekEvalPricing('deepseek-flash')).toEqual({
    inputPer1M: 0.3,
    outputPer1M: 1.2,
  });
  expect(resolveDeepSeekEvalPricing('nope')).toBeNull();
});

function stubDeepSeekHelper(): string {
  const path = join(tmp(), 'deepseek-stub.py');
  writeFileSync(
    path,
    [
      'import json, sys, time',
      'cmd = sys.argv[1]',
      "if cmd == 'models':",
      "    print(json.dumps({'data': [{'id': 'deepseek-flash'}, {'id': 'deepseek-v4-pro'}]}))",
      "elif cmd == 'chat-tools':",
      '    req = json.load(sys.stdin)',
      "    if any('SLEEP-MARKER' in str(m.get('content', '')) for m in req.get('messages', [])):",
      '        time.sleep(10)',
      "    tools = req.get('tools') or []",
      '    calls = []',
      '    if tools:',
      "        fn = tools[0].get('function', {})",
      "        calls.append({'id': 'call-1', 'type': 'function', 'function': {'name': fn.get('name'), 'arguments': '{}'}})",
      "    print(json.dumps({'id': 'chatcmpl-stub', 'object': 'chat.completion', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'stub reply', 'tool_calls': calls}, 'finish_reason': 'tool_calls' if calls else 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}))",
      '',
    ].join('\n'),
  );
  return path;
}

test('Eval DeepSeek connector provider returns canned usage and echoes tool names', async () => {
  const helper = stubDeepSeekHelper();
  const provider = new DeepSeekConnectorProvider(helper, 'deepseek-flash');
  expect(provider.name).toBe('deepseek');
  expect(provider.hasCredentials()).toBe(true);
  expect(provider.redact('plain')).toBe('plain');
  expect(await provider.listModels()).toEqual([
    'deepseek-flash',
    'deepseek-v4-pro',
  ]);
  const res = await provider.chat(
    [{ role: 'user', content: 'hi' }],
    [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'read',
          parameters: {},
        },
      },
    ],
    30,
  );
  const choice = (res.choices as Record<string, unknown>[])[0];
  const message = choice.message as Record<string, unknown>;
  expect(message.content).toBe('stub reply');
  expect(
    (message.tool_calls as Record<string, unknown>[])[0].function,
  ).toEqual({ name: 'read_file', arguments: '{}' });
  expect((res.usage as Record<string, unknown>).prompt_tokens).toBe(10);
  expect(
    new DeepSeekConnectorProvider(
      join(tmp(), 'missing.py'),
      'deepseek-flash',
    ).hasCredentials(),
  ).toBe(false);
  const old = process.env.NYRA_EVAL_DEEPSEEK_HELPER;
  process.env.NYRA_EVAL_DEEPSEEK_HELPER = '/tmp/picked.py';
  try {
    expect(resolveDeepSeekHelperPath()).toBe('/tmp/picked.py');
  } finally {
    if (old === undefined) delete process.env.NYRA_EVAL_DEEPSEEK_HELPER;
    else process.env.NYRA_EVAL_DEEPSEEK_HELPER = old;
  }
  expect(resolveDeepSeekHelperPath().split(sep).join('/')).toContain(
    'custom.deepseek/bin/deepseek.py',
  );
});

test('Eval DeepSeek connector provider abort kills helper and throws CancelError', async () => {
  const provider = new DeepSeekConnectorProvider(
    stubDeepSeekHelper(),
    'deepseek-flash',
  );
  const controller = new AbortController();
  const pending = provider.chat(
    [{ role: 'user', content: 'SLEEP-MARKER' }],
    null,
    30,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);
  let caught: unknown;
  try {
    await pending;
  } catch (e) {
    caught = e;
  }
  expect(isCancelError(caught)).toBe(true);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(
    provider.chat([{ role: 'user', content: 'hi' }], null, 30, {
      signal: alreadyAborted.signal,
    }),
  ).rejects.toThrow();
});
