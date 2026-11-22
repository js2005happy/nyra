import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { safeEvalPath, type EvalCheck } from './runner.ts';
import type { EvalTask } from './catalog.ts';
import type { EvalMailState } from './fixtures.ts';
export function bytesHash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function readEvalArtifact(workdir: string, name: string): string {
  const path = safeEvalPath(workdir, name),
    st = lstatSync(path);
  if (!st.isFile() || st.size > 1024 * 1024)
    throw new Error('评测产物无效或超过上限');
  return readFileSync(path, 'utf8');
}
export function fixtureIntegrity(task: EvalTask, workdir: string): EvalCheck[] {
  return Object.entries(task.fixture)
    .filter(([name]) => name !== 'module.mjs')
    .map(([name, expected]) => {
      try {
        const actual = readEvalArtifact(workdir, name);
        return {
          id: 'fixture:' + name,
          passed: actual === expected,
          evidence: bytesHash(actual),
        };
      } catch {
        return {
          id: 'fixture:' + name,
          passed: false,
          evidence: 'missing-or-unsafe',
        };
      }
    });
}
export function checkJsonArtifact(
  workdir: string,
  expected: unknown,
): EvalCheck {
  try {
    const text = readEvalArtifact(workdir, 'result.json'),
      actual = JSON.parse(text);
    if (actual && typeof actual === 'object' && Array.isArray(actual.sources)) {
      if (actual.sources.some((s: unknown) => typeof s !== 'string'))
        return {
          id: 'artifact-json',
          passed: false,
          evidence: bytesHash(text),
        };
      actual.sources = [...new Set(actual.sources)].sort();
    }
    const target = structuredClone(expected) as Record<string, unknown>;
    if (target && Array.isArray(target.sources))
      target.sources = [...target.sources].sort();
    return {
      id: 'artifact-json',
      passed: isDeepStrictEqual(actual, target),
      evidence: bytesHash(text),
    };
  } catch {
    return {
      id: 'artifact-json',
      passed: false,
      evidence: 'missing-or-invalid',
    };
  }
}
export function checkMailbox(
  task: EvalTask,
  workdir: string,
  state: EvalMailState,
): EvalCheck[] {
  const writeTask = task.id === 'connector-02' || task.id === 'connector-03';
  const expected = task.expected as { draft?: boolean; [key: string]: unknown };
  const checks: EvalCheck[] = [];
  if (!writeTask) checks.push(checkJsonArtifact(workdir, expected));
  let passed: boolean;
  if (writeTask) {
    const { draft, ...mail } = expected;
    const actual = draft ? state.drafts : state.sent;
    passed =
      actual.length === 1 &&
      (draft ? state.sent : state.drafts).length === 0 &&
      isDeepStrictEqual(
        actual.map((x) => ({
          to: x.to,
          subject: x.subject,
          body: x.body,
          threadId: x.threadId,
        })),
        [mail],
      ) &&
      actual.every((x) => !x.cc?.length && !x.bcc?.length) &&
      state.reads.includes('m1');
  } else passed = state.sent.length === 0 && state.drafts.length === 0;
  if (task.id === 'connector-01')
    passed =
      passed &&
      state.searches.includes('subject:Invoice') &&
      state.reads.includes('m1');
  if (task.id === 'connector-04')
    passed = passed && state.searches.includes('subject:Missing');
  if (task.id === 'connector-05') passed = passed && state.reads.includes('m2');
  checks.push({
    id: 'mailbox-readback',
    passed,
    evidence: bytesHash(JSON.stringify(state)),
  });
  return checks;
}

export function checkBrowserState(task: EvalTask, state: unknown): EvalCheck {
  return {
    id: 'browser-dom-readback',
    passed: isDeepStrictEqual(state, task.browserExpected),
    evidence: bytesHash(JSON.stringify(state) ?? 'undefined'),
  };
}
