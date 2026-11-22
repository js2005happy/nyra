// src/parallelDelegate.ts — 缺口 3a：delegate 并行模式。
//
// 只做并行 delegate 本身：多个互不依赖的子任务同时跑、各自带超时硬约束、
// 失败的线程不拖垮主流程；review queue 与手机审批面是第二批（3b），本批不做，
// 但每线程的结果已经是结构化证据（改了什么、验证结论、成本），可直接被 3b 消费。
//
// 关于 toolPool：报告建议复用 src/toolPool.ts 的 worker 池，核查后未照搬——
// 该池是 node:worker_threads 的 CPU 池（BM25 打分 / JSON 解析 / spin），
// 子 agent 是带 provider、工具集、审批回调与 worktree 状态的主线程异步对象，
// 进 worker 线程要序列化全部上下文且 worktree/sandbox 状态无法共享。
// 本模块复用的是它的纪律而不是它的线程：有界槽位 + 排队 + 单任务超时硬约束，
// 语义与 ToolPool 对齐（超时即判失败、不静默等下去），实现在主线程用信号量做。
// 若以后真要把子 agent 放进 worker 线程，需先解决 provider 与审批状态的
// 序列化，那是另一批工作，不在本批假装已解决。

// 验收结论的状态与审阅队列共用同一套口径（type-only，编译期抹掉，无循环 import）。
import type { VerificationStatus } from "./reviewQueue.ts";
/** H-5：合并后的交付物（type-only；merge.ts 只 import 本文件的类型，无循环 import）。 */
import type { MergedDeliverable } from "./merge.ts";
/**
 * 统一取消信号（可靠性打磨第 1 项第一批）。cancel.ts 是叶子模块，
 * 不 import 任何 src 内模块，这里 import 它不会形成循环导入。
 */
import {
  awaitSettled, CancelController, combineSignals,
  isCancelError, type CancelReason,
} from "./cancel.ts";

/** 并行默认并发上限（学 Goose 的硬约束：默认 5，同时也是上限）。 */
export const DEFAULT_PARALLEL_MAX_CONCURRENCY = 5;
/** 并发上限硬顶：调用方给再大也只按 5 跑，并在结果里注明被夹住了。 */
export const MAX_PARALLEL_CONCURRENCY = 5;
/** 单任务默认超时：10 分钟。子任务是 LLM 多轮循环，30 秒（ToolPool 的默认值）不够用。 */
export const DEFAULT_PARALLEL_TASK_TIMEOUT_MS = 600_000;
/**
 * 取消确认宽限（可靠性打磨第 1 项第一批）：超时或整批取消发信号后，
 * 等底层停下最多 1 秒。宽限到了还没停，线程标“正在停止”
 *（stopConfirmed: false），槽位照样释放——不无限等、不谎报已停。
 */
export const DEFAULT_CANCEL_GRACE_MS = 1_000;

export interface ParallelTaskSpec {
task: string;
maxTurns?: number;
isolation?: "none" | "worktree";
tools?: string[];
model?: string;
/** H-4：结构化输出契约（JSON Schema），与 delegate 的 output_schema 同义。 */
outputSchema?: Record<string, unknown>;
/** GROK-1：团队模式下这条线程分派给哪个成员（Soul agent 名）；只认团队成员。 */
agent?: string;
/** H-7：授予这条线程的子 agent 的 orchestrator 角色（允许它再委派）；默认不开。 */
orchestrator?: boolean;
}

export type ParallelThreadStatus = "ok" | "failed" | "timeout" | "rejected" | "cancelled";

/**
* 3b review queue 的消费接口：每线程的证据。
* verification 由缺口 13 的验收者填写：验收者开启时是真实验收结论
* （verified/failed，方法与时间见 method/at）；未开启时恒为
* "not-verified"（3a 不做自动验证、不替子任务编验证结论；子任务自述的
* 验证情况见 summary 原文，不要把它当成已验证的结论）。
*/
export interface ParallelThreadEvidence {
/** worktree 隔离下改动的文件（相对路径，取自 git status --porcelain）；非 worktree 为空。 */
changedFiles: string[];
/** worktree 隔离下的 `git diff --stat HEAD` 原文；无改动或非 worktree 为 null。 */
diffStat: string | null;
/** 改动留下的 worktree 路径；无改动、无隔离或已清理时为 null。 */
worktreePath: string | null;
/** 验收结论（缺口 13）：状态 + 原因 + 方法（verifier/verifier-deterministic）+ 时间；未验收时只有状态与原因。 */
verification: { status: VerificationStatus; note: string; method?: string | null; at?: string | null };
/** 该线程已花美元；未计价（无单价 / provider 未报用量）时为 null，不编数字。 */
spentUsd: number | null;
}

export interface ParallelThreadResult {
index: number;
task: string;
status: ParallelThreadStatus;
/** 成功时为子任务摘要原文；失败/超时/被拒/被取消时为 null。 */
summary: string | null;
/** 失败/超时/被拒/被取消的原因；成功时为 null。 */
error: string | null;
durationMs: number;
model: string | null;
evidence: ParallelThreadEvidence;
/** H-4：结构化输出契约的校验结论（没给契约时为 null；通过 true / 未通过 false）。 */
schemaValid: boolean | null;
/**
 * 停止确认（可靠性打磨第 1 项第一批）：ok/failed/rejected 的线程恒
 * 为 true（已落定）；timeout/cancelled 的线程为 true 表示宽限期内
 * 底层确认停下了，false 表示宽限到了仍没停下——任务保持“正在停止”，
 * 不谎报已停（见 pendingAfterTimeout）。
 */
stopConfirmed: boolean;
}

export interface ParallelDelegateResult {
results: ParallelThreadResult[];
succeeded: number;
failed: number;
timedOut: number;
rejected: number;
/** 整批取消时被取消的线程数（单个线程因取消信号停下，不算 failed）。 */
cancelled: number;
/** 全部线程已花美元合计；任一线程未计价时仍为已计价部分之和，调用方不得当成全量。 */
totalSpentUsd: number | null;
  /**
   * 超时/取消后宽限期内仍未确认停下的线程数（stopConfirmed: false 的
   * 线程）。它们的最终花费事后会计入父级 delegateSpentUsd，但不进
   * totalSpentUsd——>0 时 totalSpentUsd 只是下限（汇总文本写 "≥"）。
   * 这些线程不是“已停”，是“正在停止”：槽位已释放，但底层可能还在收尾。
   */
  pendingAfterTimeout: number;
totalDurationMs: number;
maxConcurrency: number;
timeoutMs: number;
/** 并发上限被硬顶夹住时为 true（调用方给了 >5）。 */
maxConcurrencyClamped: boolean;
/** 3b：已进审阅队列的项 id（只在调用方 opt-in 入队时有内容，否则为空）。 */
reviewEnqueued: string[];
/** 3b：opt-in 入队失败时的原因；未要求入队或入队成功时为 null。 */
reviewEnqueueError: string | null;
/** H-5：合并步的交付物；没开合并时为 null。 */
merged: MergedDeliverable | null;
}

export interface ParallelDelegateOptions {
maxConcurrency?: number;
timeoutMs?: number;
/** H-6：每线程结束时回调（per-group 回填用；回调里抛错不影响线程结果）。 */
onThreadDone?: (result: ParallelThreadResult) => void;
/**
 * 整批取消信号（可靠性打磨第 1 项第一批）：abort 时所有在跑线程收到
 * 取消信号（模型请求 abort、子进程 kill），排队的线程直接标 cancelled
 * 不再启动。不传时只有单线程超时能触发取消。
 */
signal?: AbortSignal;
/** 取消确认宽限毫秒数（默认 1 秒）；非法值回默认。 */
cancelGraceMs?: number;
}

export interface ResolvedParallelOptions {
maxConcurrency: number;
timeoutMs: number;
maxConcurrencyClamped: boolean;
/** 取消确认宽限毫秒数（已解析，恒为非负数）。 */
cancelGraceMs: number;
}

/** 并发与超时解析：并发夹在 [1, 5]，超时必须是正数否则回默认。 */
export function resolveParallelOptions(opts: ParallelDelegateOptions = {}): ResolvedParallelOptions {
let maxConcurrency = opts.maxConcurrency;
if (typeof maxConcurrency!== "number" ||!Number.isFinite(maxConcurrency)) {
maxConcurrency = DEFAULT_PARALLEL_MAX_CONCURRENCY;
}
maxConcurrency = Math.floor(maxConcurrency);
const clamped = maxConcurrency > MAX_PARALLEL_CONCURRENCY;
if (maxConcurrency < 1) maxConcurrency = 1;
if (clamped) maxConcurrency = MAX_PARALLEL_CONCURRENCY;
let timeoutMs = opts.timeoutMs;
if (typeof timeoutMs!== "number" ||!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
timeoutMs = DEFAULT_PARALLEL_TASK_TIMEOUT_MS;
}
let cancelGraceMs = opts.cancelGraceMs;
if (typeof cancelGraceMs!== "number" ||!Number.isFinite(cancelGraceMs) || cancelGraceMs < 0) {
cancelGraceMs = DEFAULT_CANCEL_GRACE_MS;
}
return { maxConcurrency, timeoutMs: Math.floor(timeoutMs), maxConcurrencyClamped: clamped, cancelGraceMs: Math.floor(cancelGraceMs) };
}

/** 单个线程的执行结果（由调用方把 delegate 的结构化结果适配进来）。 */
export interface ParallelThreadOutcome {
ok: boolean;
/** 成功时为子任务摘要；失败时可为空，错误见 error。 */
summary: string;
error?: string;
spentUsd: number | null;
model: string | null;
worktreePath: string | null;
changedFiles: string[];
diffStat: string | null;
/** 缺口 13：验收者的验收结论（未开启时不填，调用方按 not-verified 处理）。 */
verification?: ParallelThreadEvidence["verification"];
/** H-4：结构化输出契约的校验结论（没给契约时不填，调用方按 null 处理）。 */
schemaValid?: boolean | null;
}

export type ParallelRunner = (
spec: ParallelTaskSpec,
index: number,
/**
 * 当线程取消信号（可靠性打磨第 1 项第一批）：超时或整批取消时 abort；
 * runner 须把它传给子任务的 Agent（delegateDetailed 的 opts.signal），
 * 子任务的在途调用才能被掐断。不传时 runner 按旧行为跑（无信号）。
 */
signal?: AbortSignal,
) => Promise<ParallelThreadOutcome>;

const NOT_VERIFIED_NOTE =
"3a 不做自动验证：本线程未经过独立验证，验证结论待 3b 的 review queue / verifier 填写；" +
"子任务自述的验证情况见摘要原文，不要把它当成已验证的结论。";

function emptyEvidence(): ParallelThreadEvidence {
return {
changedFiles: [],
diffStat: null,
worktreePath: null,
verification: { status: "not-verified", note: NOT_VERIFIED_NOTE},
spentUsd: null,
};
}

/**
* 并行跑一批子任务。
*
* 并发语义：最多 maxConcurrency 个同时在跑，其余排队；每个线程单独计时，
* 超过 timeoutMs 即判 timeout。超时不是只在上层决出胜负就当停了——
* 可靠性打磨第 1 项第一批：超时先给线程发取消信号（模型请求 abort、
* 子进程 kill），再等宽限期（cancelGraceMs，默认 1 秒）确认底层停下；
* 宽限到了还没停，线程标“正在停止”（stopConfirmed: false），槽位照样
* 释放，但结果里如实记 pendingAfterTimeout，不谎报已停。整批取消信号
* （opts.signal）同理：abort 时在跑线程收信号、排队线程直接标 cancelled
* 不再启动。超时/取消线程的花费不进本批返回的 totalSpentUsd，事后多花
* 的钱仍会计入父级的 delegateSpentUsd，这一点在文档里写明了，不要把
* totalSpentUsd 当成最终账单。
*
* 失败隔离：任一线程抛错/超时/被取消只记自己那一项，其余线程照常跑完；
* 主流程汇总成功者，失败原因与已花成本逐项注明。
*/
export async function runParallelDelegate(
runOne: ParallelRunner,
tasks: ParallelTaskSpec[],
opts: ParallelDelegateOptions = {},
): Promise<ParallelDelegateResult> {
if (!Array.isArray(tasks) || tasks.length === 0) {
throw new Error("并行委派至少需要一个子任务");
}
const { maxConcurrency, timeoutMs, maxConcurrencyClamped, cancelGraceMs } = resolveParallelOptions(opts);
const startedAt = Date.now();
const results: ParallelThreadResult[] = new Array(tasks.length);
let next = 0;

async function runThread(index: number): Promise<void> {
const spec = tasks[index];
const threadStartedAt = Date.now();
// 每个线程一个取消控制器：超时或整批取消时先 abort 它，再等宽限期
// 确认底层停下（runThreadWithCancel）。槽位只有线程落定或宽限到期
// 才释放——“正在停止”的线程不谎报已停。
const threadCancel = new CancelController();
const threadSignal = combineSignals([opts.signal, threadCancel.signal]);
const base: Omit<ParallelThreadResult, "status" | "summary" | "error"> = {
index,
task: spec.task,
durationMs: 0,
model: null,
evidence: emptyEvidence(),
schemaValid: null,
stopConfirmed: true,
};
const finish = (
status: ParallelThreadStatus,
summary: string | null,
error: string | null,
stopConfirmed: boolean,
outcome?: ParallelThreadOutcome,
): void => {
const evidence = emptyEvidence();
if (outcome) {
evidence.changedFiles = outcome.changedFiles?? [];
evidence.diffStat = outcome.diffStat?? null;
evidence.worktreePath = outcome.worktreePath?? null;
evidence.spentUsd = outcome.spentUsd?? null;
if (outcome.verification) evidence.verification = outcome.verification;
}
results[index] = {
...base,
status,
summary,
error,
durationMs: Date.now() - threadStartedAt,
model: outcome?.model?? null,
evidence,
schemaValid: outcome?.schemaValid?? null,
stopConfirmed,
};
// H-6：per-group 回填钩子——回调里抛错不影响线程结果。
if (opts.onThreadDone) {
try { opts.onThreadDone(results[index]); } catch { /* ignore */ }
}
};
// 可靠性打磨第 1 项第一批：整批已取消时排队的线程不再启动，直接标
// cancelled（不调 runner）；已启动的线程走下面的取消流程。
if (opts.signal?.aborted) {
finish("cancelled", null, "整批已取消：取消信号已发出，线程未启动", true);
return;
}
try {
const runner = runOne(spec, index, threadSignal);
const ran = await runThreadWithCancel(runner, opts.signal ?? null, threadCancel, timeoutMs, cancelGraceMs);
if (ran.outcome) {
const outcome = ran.outcome;
if (outcome.ok) finish("ok", outcome.summary, null, true, outcome);
else finish("failed", null, outcome.error || "子任务失败（未给原因）", true, outcome);
} else if (ran.status === "timeout" || ran.status === "cancelled") {
finish(ran.status, null, ran.error ?? null, ran.stopConfirmed);
} else {
finish("failed", null, ran.error ?? "未知错误", true);
}
} catch (err: unknown) {
if (isCancelError(err)) {
finish("cancelled", null, (err as Error).message, true);
} else {
finish("failed", null, err instanceof Error? err.message: String(err), true);
}
}
}

async function worker(): Promise<void> {
while (next < tasks.length) {
const index = next;
next += 1;
await runThread(index);
}
}

const workers = Array.from(
{ length: Math.min(maxConcurrency, tasks.length)},
() => worker(),
);
await Promise.all(workers);

let succeeded = 0;
let failed = 0;
let timedOut = 0;
let rejected = 0;
let cancelled = 0;
let totalSpent: number | null = null;
for (const r of results) {
if (r.status === "ok") succeeded += 1;
else if (r.status === "failed") failed += 1;
else if (r.status === "timeout") timedOut += 1;
else if (r.status === "cancelled") cancelled += 1;
else rejected += 1;
if (typeof r.evidence.spentUsd === "number") {
totalSpent = (totalSpent?? 0) + r.evidence.spentUsd;
}
}
// 停止确认：宽限期内没确认停下的线程（stopConfirmed: false）才进
// pendingAfterTimeout——它们是“正在停止”，不是“已停”。
const pendingAfterTimeout = results.filter((r) => !r.stopConfirmed).length;
return {
results,
succeeded,
failed,
timedOut,
rejected,
cancelled,
totalSpentUsd: totalSpent,
pendingAfterTimeout,
totalDurationMs: Date.now() - startedAt,
maxConcurrency,
timeoutMs,
maxConcurrencyClamped,
reviewEnqueued: [],
reviewEnqueueError: null,
// H-5：本层不做合并（合并在 agent.ts 的 delegateParallel 里，跑完才有结果可合）。
merged: null,
};
}

/**
* 跑一个线程，带真取消：超时或整批取消时先给线程发取消信号，再等宽限
* 期确认底层停下。返回 outcome 为 null 时线程没产出结果（超时/被取消），
* stopConfirmed 说明宽限期内底层停没停下。
*
* 注意：runner 是调用方传进来的 promise，本函数不替它 abort——abort
* 是 runner 自己的事（它收到的 threadSignal 已接上取消控制器，模型
* 请求 abort、子进程 kill 都由它内部做）。本函数只负责“发信号 + 等确认”。
*/
async function runThreadWithCancel(
runner: Promise<ParallelThreadOutcome>,
batchSignal: AbortSignal | null,
threadCancel: CancelController,
timeoutMs: number,
graceMs: number,
): Promise<{ outcome: ParallelThreadOutcome | null; status: ParallelThreadStatus; stopConfirmed: boolean; error?: string }> {
// 底层落定后结果不要了，但 rejection 不能没人接。
void runner.catch(() => undefined);
let timer: ReturnType<typeof setTimeout> | null = null;
const timeout = new Promise<"timeout">((resolve) => {
timer = setTimeout(() => resolve("timeout"), timeoutMs);
});
const batchAbort: Promise<"cancelled"> = !batchSignal
? new Promise<"cancelled">(() => undefined)
: batchSignal.aborted
? Promise.resolve("cancelled")
: new Promise<"cancelled">((resolve) => {
batchSignal.addEventListener("abort", () => resolve("cancelled"), { once: true });
});
const done = runner.then(
(outcome) => ({ kind: "done" as const, outcome }),
(error: unknown) => ({ kind: "error" as const, error }),
);
const first = await Promise.race([
done,
timeout.then(() => ({ kind: "timeout" as const })),
batchAbort.then(() => ({ kind: "cancelled" as const })),
]);
if (timer) clearTimeout(timer);
if (first.kind === "done") return { outcome: first.outcome, status: "ok", stopConfirmed: true };
if (first.kind === "error") {
// runner 自己抛 CancelError：底层已经因取消停下，确认已停。
if (isCancelError(first.error)) {
return { outcome: null, status: "cancelled", stopConfirmed: true, error: (first.error as Error).message };
}
// 非取消错误原样抛，调用方按失败记。
throw first.error;
}
// 超时或整批取消：先发取消信号，再等宽限期确认底层停下。
const reason: CancelReason = first.kind === "timeout" ? "timeout" : "stop";
threadCancel.abort(reason);
const settled = await awaitSettled(runner, graceMs);
if (first.kind === "timeout") {
return {
outcome: null,
status: "timeout",
stopConfirmed: settled.settled,
error: settled.settled
? `子任务超时：${timeoutMs}ms 内未返回（已发取消信号，底层已确认停下）`
: `子任务超时：${timeoutMs}ms 内未返回（已发取消信号，底层在 ${graceMs}ms 宽限期内未确认停下，仍在停止中）`,
};
}
return {
outcome: null,
status: "cancelled",
stopConfirmed: settled.settled,
error: settled.settled
? "整批已取消：取消信号已发出，底层已确认停下"
: `整批已取消：取消信号已发出，底层在 ${graceMs}ms 宽限期内未确认停下，仍在停止中`,
};
}

/**
* 收敛规则（写进并行子任务的系统提示，见 agent.ts 的 delegate）：
* 各线程只做自己那件任务、不碰别线程的文件、不等别的线程；
* 结束时在摘要末尾另起一段写收敛小结（改了哪些文件、验证结论、未验证就写未验证），
* 供 3b 的 review queue 直接消费；审批规则与父级相同，不自动放行。
*/
export function parallelConvergenceNote(index: number, total: number): string {
return (
`你是 ${total} 个并行子任务中的第 ${index + 1} 个，只做自己这件任务：` +
`不要修改、不要读取其他线程负责的文件；不要等待其他线程，也不要跨线程协调；` +
`结束时在摘要末尾另起一段写收敛小结：改了哪些文件（相对路径）、验证结论（跑了什么验证命令、结果如何；没验证就写“未验证”）。` +
`审批规则与父级相同：写文件、执行命令仍按父级审批规则来，不要自动放行；不要编造花费数字。`
);
}

/** 格式化成给模型/用户看的文本：只汇总成功者，失败逐项注明原因与已花成本。 */
export function formatParallelResults(result: ParallelDelegateResult): string {
const lines: string[] = [];
lines.push(
`并行委派完成：共 ${result.results.length} 个线程，成功 ${result.succeeded} 个` +
(result.failed? `，失败 ${result.failed} 个`: "") +
(result.timedOut? `，超时 ${result.timedOut} 个`: "") +
(result.cancelled? `，被取消 ${result.cancelled} 个`: "") +
(result.rejected? `，被拒 ${result.rejected} 个`: "") +
`；总耗时 ${(result.totalDurationMs / 1000).toFixed(1)} 秒` +
    `；已计价花费合计 ${result.totalSpentUsd === null ? "未知（未计价）" : (result.pendingAfterTimeout > 0 ? "≥" : "") + "$" + result.totalSpentUsd.toFixed(4)}` +
    `（${result.pendingAfterTimeout > 0 ? `${result.pendingAfterTimeout} 个线程宽限期内未确认停下、仍在停止中，其花费未结算——上值只是下限` : "无正在停止的线程，上值为全部"}）` +
`；并发上限 ${result.maxConcurrency}（${result.maxConcurrencyClamped? "调用方要求更高，已按硬顶 5 夹住": "默认"}）` +
`，单任务超时 ${Math.round(result.timeoutMs / 1000)} 秒。`,
);
for (const r of result.results) {
const head = ``;
if (r.status === "ok") {
lines.push(
`${head}成功；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费 ${r.evidence.spentUsd === null? "未知（未计价）": "$" + r.evidence.spentUsd.toFixed(4)}` +
(r.model? `；模型 ${r.model}`: "") +
(r.evidence.worktreePath
? `；worktree：${r.evidence.worktreePath}` +
(r.evidence.changedFiles.length
? `，改动文件：${r.evidence.changedFiles.join("、")}`
: "，无文件改动")
: "") +
`；验收：${r.evidence.verification.status === "verified" ? "通过" : r.evidence.verification.status === "failed" ? "未通过" : "未验收"}${r.evidence.verification.method ? `（${r.evidence.verification.method}）` : ""}` +
`\n${r.summary?? ""}`,
);
} else if (r.status === "timeout") {
lines.push(
`${head}超时；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费未知（超时前未结算）；停止确认：${r.stopConfirmed ? "底层已确认停下" : "宽限期内未确认停下，仍在停止中"}；原因：${r.error?? ""}`,
);
} else if (r.status === "cancelled") {
lines.push(
`${head}被取消；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费未知（取消前未结算）；停止确认：${r.stopConfirmed ? "底层已确认停下" : "宽限期内未确认停下，仍在停止中"}；原因：${r.error?? ""}`,
);
} else if (r.status === "rejected") {
lines.push(`${head}被拒；原因：${r.error?? ""}`);
} else {
lines.push(
`${head}失败；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费 ${r.evidence.spentUsd === null? "未知（未计价）": "$" + r.evidence.spentUsd.toFixed(4)}` +
`；原因：${r.error?? ""}`,
);
}
}
const verifiedCount = result.results.filter((r) => r.evidence.verification.status === "verified").length;
const failedCount = result.results.filter((r) => r.evidence.verification.status === "failed").length;
lines.push(
verifiedCount + failedCount > 0
? `验证结论：验收者已验收 ${verifiedCount + failedCount} 个线程（通过 ${verifiedCount} 个，未通过 ${failedCount} 个），未通过的已打回（见各线程证据的 verification 字段），合入前仍需 3b 的 review queue 逐项批。`
: "验证结论：本批未验收（验收者未开启，见各线程证据的 verification 字段），需 3b 的 review queue 验收后再合并。",
);
if (result.reviewEnqueued?.length) {
lines.push(`已进审阅队列 ${result.reviewEnqueued.length} 项（nyra review list 查看）：${result.reviewEnqueued.join("、")}`);
}
if (result.reviewEnqueueError) {
lines.push(`入队失败（结果本身不受影响）：${result.reviewEnqueueError}`);
}
// H-5：开了合并时附合并交付物（#79 同款容忍：手写结果可能没有 merged 字段）。
if (result.merged) {
const m = result.merged;
lines.push(
m.ok
? `合并交付物：${m.title}\n${m.text}\n\n合并核验：确定性检查 ${m.checks.filter((c) => c.passed).length} 通过 / ${m.checks.filter((c) => !c.passed).length} 未通过（merge-deterministic）${m.verified ? "；可进审阅。" : "；未通过，须人批复后再用，不要把合并结果当已验证。"}` +
(m.file ? `\n完整版文件：${m.file}（~/.nyra 下）。` : "") +
(m.reviewItemId ? `\n审阅队列：${m.reviewItemId}（nyra review show ${m.reviewItemId} 查看并批复）。` : `\n审阅队列：未入队${m.reviewEnqueueError ? `（${m.reviewEnqueueError}）` : ""}。`)
: `合并步失败：${m.error ?? "未知原因"}（各线程原文汇总见上，合并交付物未生成）。`,
);
}
return lines.join("\n\n");
}
