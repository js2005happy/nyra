// Separate entry point only: fixed local model, disposable workspaces, no real accounts.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Agent } from '../agent.ts';
import { Provider, type ProviderLike } from '../providers.ts';
import { resolveProvider } from '../config.ts';
import { TOOL_SCHEMAS } from '../tools.ts';
import { RunRecorder, RunStore } from '../runs.ts';
import { CDPBrowser } from '../cdpBrowser.ts';
import { buildBwrapArgv } from '../sandbox.ts';
import {
  checkJsonArtifact,
  checkMailbox,
  fixtureIntegrity,
  checkBrowserState,
} from './checks.ts';
import { createEvalMailbox } from './fixtures.ts';
import {
  DeepSeekConnectorProvider,
  resolveDeepSeekHelperPath,
} from './apiProvider.ts';
import {
  writeEvalJson,
  type EvalAdapter,
  type EvalCheck,
  type EvalOutcome,
} from './runner.ts';
import type { EvalConditions, EvalTask } from './catalog.ts';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function provider(
  c: EvalConditions,
  home: string,
  apiHelperPath?: string,
): ProviderLike {
  if (c.provider === 'deepseek') {
    // API 通道（整合者增补）：助手路径由父进程解析、经 ctx 传进来；
    // worker 里 HOME 是一次性目录，这里绝不自己再解析路径。
    return new DeepSeekConnectorProvider(
      apiHelperPath ?? resolveDeepSeekHelperPath(),
      c.model,
    );
  }
  // Deliberately bypass user config, fallback chains and credentials. Only loopback Ollama.
  return new Provider({
    ...resolveProvider({
      home,
      config: {},
      providerName: 'ollama',
      model: c.model,
    }),
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
}
export function cleanEvalEnv(home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    NYRA_LANG: 'zh',
  };
  // Windows runtime/process lookup; no tokens, provider config or permission overrides.
  for (const k of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'])
    if (process.env[k]) env[k] = process.env[k];
  if (home) {
    env.NYRA_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  return env;
}
function findExecutable(name: string): string | null {
  const p = spawnSync(name, ['--version'], {
    encoding: 'utf8',
    env: cleanEvalEnv(),
    timeout: 5000,
  });
  if (p.error || p.status !== 0) return null;
  const locate = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [name],
    { encoding: 'utf8', env: cleanEvalEnv(), timeout: 5000 },
  );
  return locate.status === 0 ? locate.stdout.trim().split(/\r?\n/)[0] : null;
}
export function makeLiveEvalAdapter(
  conditions: EvalConditions,
  helperPath?: string,
): EvalAdapter {
  let modelProbe: Promise<string | null> | null = null;
  let modelDigest: string | null = null;
  const probe = (c: EvalConditions) =>
    (modelProbe ??= (async () => {
      if (c.provider === 'deepseek') {
        // API 模型没有 digest，environment 里 modelDigest 恒为 null；
        // 探针只确认助手能跑、目标模型在列表里。
        try {
          const p = spawnSync(
            'python3',
            [
              helperPath ?? resolveDeepSeekHelperPath(),
              'models',
            ],
            { encoding: 'utf8', timeout: 10000 },
          );
          if (p.error || p.status !== 0) return 'api-model-unavailable';
          const data = JSON.parse(p.stdout) as {
            data?: { id: string }[];
          };
          if (!Array.isArray(data.data)) return 'api-model-unavailable';
          return data.data.some((m) => m.id === c.model)
            ? null
            : 'api-model-not-listed';
        } catch {
          return 'api-model-unavailable';
        }
      }
      try {
        const response = await fetch('http://127.0.0.1:11434/api/tags', {
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
        });
        if (!response.ok) return 'local-model-unavailable';
        const data = (await response.json()) as {
          models?: { name: string; digest?: string }[];
        };
        const model = data.models?.find((x) => x.name === c.model);
        modelDigest = model?.digest ?? null;
        return !model
          ? 'local-model-not-installed'
          : !modelDigest
            ? 'local-model-digest-unavailable'
            : null;
      } catch {
        return 'local-model-unavailable';
      }
    })());
  return {
    async environment() {
      await probe(conditions);
      return {
        runtime: process.version,
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        modelDigest,
        chromium:
          spawnSync('chromium', ['--version'], {
            env: cleanEvalEnv(),
            encoding: 'utf8',
            timeout: 3000,
          }).stdout?.trim() || null,
        node:
          spawnSync('node', ['--version'], {
            env: cleanEvalEnv(),
            encoding: 'utf8',
            timeout: 3000,
          }).stdout?.trim() || null,
      };
    },
    async preflight(task, c) {
      if (process.platform !== 'linux') return 'live-eval-linux-only';
      const reason = await probe(c);
      if (reason) return reason;
      if (task.category === 'code') {
        if (
          process.platform !== 'linux' ||
          !findExecutable('bwrap') ||
          !findExecutable('node')
        )
          return 'isolated-test-runtime-unavailable';
        const probe = spawnSync(
          'bwrap',
          ['--ro-bind', '/', '/', '--unshare-net', '--', '/bin/true'],
          { env: cleanEvalEnv(), timeout: 3000 },
        );
        if (probe.error || probe.status !== 0)
          return 'isolated-test-runtime-unavailable';
      }
      if (task.category === 'browser' && !findExecutable('chromium'))
        return 'isolated-browser-unavailable';
      return null;
    },
    async execute(task, c, ctx) {
      // Disposable worker process is the containment boundary for the harness timeout.
      // This does not change Agent cancellation semantics or its normal execution path.
      return await new Promise<EvalOutcome>((done) => {
        const child = spawn(
          process.execPath,
          [join(ROOT, 'scripts/eval/worker.ts')],
          {
            cwd: ROOT,
            env: cleanEvalEnv(ctx.home),
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '',
          overflow = false,
          timedOut = false;
        const kill = () => {
          try {
            if (process.platform !== 'win32' && child.pid)
              process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            /* process already exited */
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, c.timeoutMs);
        child.stdin.on('error', () => {});
        child.stdout.on('data', (d: Buffer) => {
          if (output.length + d.length > 1024 * 1024) {
            overflow = true;
            kill();
          } else output += d.toString('utf8');
        });
        child.stderr.resume(); // Never copy paths, credentials or model text into evaluation events.
        child.on('error', () => {
          clearTimeout(timer);
          done({
            status: 'failed',
            reason: 'worker-start-failed',
            checks: [],
            spentUsd: null,
            interventions: null,
            modelCalls: null,
          });
        });
        child.on('close', () => {
          clearTimeout(timer);
          kill(); // Reap any fixture-browser descendants left in this worker group.
          if (timedOut || overflow) {
            done({
              status: 'failed',
              reason: timedOut ? 'worker-timeout' : 'worker-output-limit',
              checks: [],
              spentUsd: null,
              interventions: null,
              modelCalls: null,
            });
            return;
          }
          try {
            done(JSON.parse(output) as EvalOutcome);
          } catch {
            done({
              status: 'failed',
              reason: 'worker-result-invalid',
              checks: [],
              spentUsd: null,
              interventions: null,
              modelCalls: null,
            });
          }
        });
        child.stdin.end(
          JSON.stringify({
            taskId: task.id,
            conditions: c,
            ...ctx,
            apiHelperPath: helperPath ?? undefined,
          }),
        );
      });
    },
  };
}
async function openFixtureBrowser(
  task: EvalTask,
  workdir: string,
  home: string,
) {
  const html = readFileSync(join(workdir, 'page.html'));
  const server = createServer((req, res) => {
    if (req.url !== '/fixture') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture-server');
  const url = `http://127.0.0.1:${address.port}/fixture`,
    profile = join(home, 'browser-profile');
  mkdirSync(profile, { mode: 0o700 });
  const child = spawn(
    'chromium',
    [
      '--headless=new',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { env: cleanEvalEnv(home), stdio: 'ignore' },
  );
  let browser: CDPBrowser | null = null;
  const close = () => {
    browser?.close();
    child.kill('SIGKILL');
    server.close();
  };
  child.on('error', () => {});
  try {
    const start = performance.now();
    while (!existsSync(join(profile, 'DevToolsActivePort'))) {
      if (performance.now() - start > 8000 || child.exitCode !== null)
        throw new Error('fixture-browser-start');
      await new Promise((r) => setTimeout(r, 50));
    }
    const port = Number(
      readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0],
    );
    browser = await CDPBrowser.connectToChrome(port, {
      connectTimeoutMs: 3000,
      timeoutMs: 5000,
    });
    return { browser, url, close };
  } catch (e) {
    close();
    throw e;
  }
}
// Enforce the evaluation whitelist on responses too: schema hiding alone is not a security boundary.
function guardEvalProvider(
  inner: ProviderLike,
  allowed: Set<string>,
  violations: string[],
): ProviderLike {
  let serial = 0;
  return {
    name: inner.name,
    model: inner.model,
    baseUrl: inner.baseUrl,
    hasCredentials: () => inner.hasCredentials(),
    redact: (s) => inner.redact(s),
    listModels: (t) => inner.listModels(t),
    async chat(messages, tools, timeout, options) {
      const response = await inner.chat(messages, tools, timeout, options);
      if (!Array.isArray(response.choices)) return response;
      return {
        ...response,
        choices: response.choices.map((choice) => {
          if (!choice || typeof choice !== 'object') return choice;
          const message = choice.message;
          if (!message || !Array.isArray(message.tool_calls)) return choice;
          return {
            ...choice,
            message: {
              ...message,
              tool_calls: message.tool_calls.map(
                (call: Record<string, unknown>) => {
                  const fn = call.function as { name?: unknown } | undefined;
                  const id = 'eval-call-' + ++serial;
                  if (typeof fn?.name !== 'string' || !allowed.has(fn.name)) {
                    violations.push('tool-outside-fixture-whitelist');
                    return {
                      id,
                      type: 'function',
                      function: { name: 'eval_denied_tool', arguments: '{}' },
                    };
                  }
                  return { ...call, id };
                },
              ),
            },
          };
        }),
      };
    },
  };
}
export async function executeLiveEvalTask(
  task: EvalTask,
  c: EvalConditions,
  ctx: { workdir: string; home: string; apiHelperPath?: string },
  testProvider?: ProviderLike,
): Promise<EvalOutcome> {
  const allowed = new Set([
    'read_file',
    'write_file',
    'edit_file',
    'apply_patch',
    'list_dir',
  ]);
  if (task.category === 'browser')
    for (const n of ['browser_navigate', 'browser_click', 'browser_screenshot'])
      allowed.add(n);
  if (task.category === 'connector')
    for (const n of ['gmail_search', 'gmail_read', 'gmail_send'])
      allowed.add(n);
  const whitelistViolations: string[] = [];
  const automatedApprovals: { tool: string; approved: boolean }[] = [];
  const mailbox = createEvalMailbox();
  const fixtureBrowser =
    task.category === 'browser'
      ? await openFixtureBrowser(task, ctx.workdir, ctx.home)
      : null;
  const store = new RunStore(join(ctx.home, 'runs'));
  const agent = new Agent(
    guardEvalProvider(
      testProvider ?? provider(c, ctx.home, ctx.apiHelperPath),
      allowed,
      whitelistViolations,
    ),
    {
      ...ctx,
      mode: 'auto',
      interactive: true,
      maxTurns: c.maxTurns,
      skillsDirs: [],
      disabledTools: TOOL_SCHEMAS.map(
        (t) => (t.function as { name: string }).name,
      ).filter((n) => !allowed.has(n)),
      maxCostUsd: c.maxCostUsd,
      pricing: { inputPer1M: c.inputPer1M, outputPer1M: c.outputPer1M },
      sandbox: { backend: 'bwrap', mode: 'workspace-write', allowNet: false },
      verifier: {
        enabled: false,
        provider: null,
        model: null,
        rework: false,
        rules: [],
      },
      approveFn: (tool, _summary, details) => {
        const target =
          typeof details?.fileTarget === 'string'
            ? resolve(details.fileTarget)
            : null;
        const approved =
          allowed.has(tool) &&
          (tool === 'browser_click' ||
            tool === 'browser_screenshot' ||
            tool === 'browser_navigate' ||
            tool === 'gmail_send' ||
            (target !== null &&
              [
                join(ctx.workdir, 'module.mjs'),
                join(ctx.workdir, 'result.json'),
              ].includes(target)));
        automatedApprovals.push({ tool, approved });
        return approved;
      },
    },
  );
  // Browser navigation is further restricted at the existing browser adapter boundary.
  if (fixtureBrowser) {
    const navigate = fixtureBrowser.browser.navigate.bind(
      fixtureBrowser.browser,
    );
    fixtureBrowser.browser.navigate = async (url: string) => {
      if (url !== fixtureBrowser.url) throw new Error('只允许冻结测试页');
      return await navigate(url);
    };
    agent.ctx.browser = fixtureBrowser.browser;
  }
  agent.ctx.gmailTransport = mailbox.transport;
  const prompt =
    task.description +
    (fixtureBrowser ? ' 测试页地址：' + fixtureBrowser.url : '');
  const recorder = new RunRecorder(store, agent, prompt, { verifyRetries: 0 });
  let failed = false;
  try {
    try {
      await recorder.run(prompt);
    } catch {
      failed = true;
    }
    const checks: EvalCheck[] = fixtureIntegrity(task, ctx.workdir);
    checks.push({
      id: 'allowed-tools-only',
      passed: whitelistViolations.length === 0,
      evidence: 'violations:' + whitelistViolations.length,
    });
    checks.push({
      id: 'agent-terminal-state',
      passed:
        !failed && store.load(recorder.runId).status === 'completed_unverified',
      evidence: store.load(recorder.runId).status,
    });
    if (task.category === 'research')
      checks.push(checkJsonArtifact(ctx.workdir, task.expected));
    if (task.category === 'connector')
      checks.push(...checkMailbox(task, ctx.workdir, mailbox.state));
    if (fixtureBrowser) {
      const state = await fixtureBrowser.browser.evaluate(
        'JSON.parse(document.querySelector("#state").textContent)',
      );
      checks.push(checkBrowserState(task, state));
    }
    if (task.category === 'code') {
      const node = findExecutable('node');
      if (!node) throw new Error('test-runtime');
      const marker = randomBytes(16).toString('hex');
      const script =
        'import assert from "node:assert/strict"; import * as m from "./module.mjs"; ' +
        task.testBody +
        '; process.stdout.write(' +
        JSON.stringify(marker) +
        ');';
      const args = buildBwrapArgv(node, ['--input-type=module', '-e', script], {
        workdir: ctx.workdir,
        mode: 'read-only',
        allowNet: false,
        extraRoBinds: [dirname(node)],
      });
      const test = spawnSync(args[0], args.slice(1), {
        env: cleanEvalEnv(),
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
      });
      checks.push({
        id: 'frozen-tests',
        passed: !test.error && test.status === 0 && test.stdout === marker,
        evidence: 'exit:' + String(test.status),
      });
    }
    if (
      task.category === 'connector' &&
      !['connector-02', 'connector-03'].includes(task.id)
    ) {
      checks.push({
        id: 'no-mail-write-attempt',
        passed: !store
          .readEvents(recorder.runId)
          .some((e) => e.type === 'tool_start' && e.name === 'gmail_send'),
        evidence: 'tool-events',
      });
    }
    const evidence = {
      checks,
      automatedApprovals,
      mailbox: task.category === 'connector' ? mailbox.state : null,
    };
    writeEvalJson(join(ctx.home, 'acceptance.json'), evidence, ctx.home);
    store.appendEvent(recorder.runId, 'eval_attempt_finished', {
      task_id: task.id,
      status: checks.every((x) => x.passed) ? 'passed' : 'failed',
      spent_usd: agent.lastCost?.spentUsd ?? null,
      interventions: 0,
    });
    return {
      status: checks.every((x) => x.passed) ? 'passed' : 'failed',
      reason: failed
        ? 'agent-execution-failed'
        : checks.every((x) => x.passed)
          ? null
          : 'acceptance-failed',
      checks,
      spentUsd:
        agent.lastCost?.status === 'priced' ? agent.lastCost.spentUsd : null,
      interventions: 0,
      modelCalls: agent.usage.snapshot().calls,
      runId: recorder.runId,
    };
  } finally {
    fixtureBrowser?.close();
  }
}
