// 统一取消信号（可靠性打磨第 1 项第一批：真取消执行）。
//
// 问题：以前 /stop、超时、预算触顶各走各的——parallelDelegate.ts 用
// Promise.race 决出胜负就当停了，底层子任务继续跑；Bot 队列取消也掐不断
// 在跑的模型调用。本模块给三条发起路径一个共同的取消信号：一个
// AbortSignal，从发起处一路传到模型请求（abort）、工具执行、子进程（kill）。
//
// 口径：
//   - 取消只有三种原因：stop（/stop 或子任务停止请求）、timeout（并行
//     线程超时）、budget（成本上限触顶）。原因随 CancelError 一起传，
//     不靠字符串比对。
//   - 停止确认：只有底层真的停了（模型请求已 abort、子进程已退出、工具
//     已收尾），才释放执行槽位、才把任务标成已停止；宽限期内没停下来，
//     任务保持“正在停止”（pendingAfterTimeout 计数），不谎报已停。
//   - 本模块是叶子模块：不 import 任何 src 内模块，任何模块都能 import
//     它，不会形成循环导入。
export type CancelReason = "stop" | "timeout" | "budget";

/** 取消原因对应的中文说明（只用于终端/事件文案，不用于判定）。 */
export const CANCEL_REASON_TEXT: Record<CancelReason, string> = {
  stop: "收到停止请求",
  timeout: "超时",
  budget: "成本上限已触顶",
};

/** 取消错误：凡是“因为取消而停下”都抛它，调用方用 isCancelError 认。 */
export class CancelError extends Error {
  readonly reason: CancelReason;
  constructor(reason: CancelReason) {
    super(`已取消：${CANCEL_REASON_TEXT[reason]}`);
    this.name = "CancelError";
    this.reason = reason;
  }
}

export function isCancelError(err: unknown): err is CancelError {
  return err instanceof CancelError || (err instanceof Error && err.name === "CancelError");
}

/** 从一个已 abort 的信号里还原 CancelError；信号原因不是 CancelError 时用 fallback。 */
export function cancelErrorFromSignal(signal: AbortSignal, fallback: CancelReason): CancelError {
  const r = signal.reason as unknown;
  if (r instanceof CancelError) return r;
  if (r instanceof Error && r.name === "CancelError") {
    const reason = (r as unknown as { reason?: unknown }).reason;
    if (reason === "stop" || reason === "timeout" || reason === "budget") return new CancelError(reason);
  }
  return new CancelError(fallback);
}

/**
 * 取消控制器：一处发起，多处监听。abort(reason) 只生效一次——先到的
 * 原因赢，后到的不覆盖（超时与预算同时触顶时原因以先到的为准）。
 */
export class CancelController {
  private controller = new AbortController();
  private _reason: CancelReason | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get aborted(): boolean {
    return this.controller.signal.aborted;
  }
  get reason(): CancelReason | null {
    return this._reason;
  }

  abort(reason: CancelReason): void {
    if (this.controller.signal.aborted) return;
    this._reason = reason;
    this.controller.abort(new CancelError(reason));
  }

  throwIfAborted(): void {
    if (this.controller.signal.aborted) throw new CancelError(this._reason ?? "stop");
  }
}

/**
 * 合并多个信号：任一 abort，合并后的信号就 abort（原因原样传过去）。
 * 空列表返回一个永远不 abort 的信号；只有一个直接返回它本身。
 * 注意：合并后的信号不随原信号“恢复”——AbortSignal 本来就不可恢复。
 */
export function combineSignals(signals: Array<AbortSignal | undefined | null>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0];
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener(
      "abort",
      () => {
        if (!controller.signal.aborted) controller.abort(s.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

/**
 * 让一个 promise 跟着信号走：信号 abort 时不等 promise，自己先以
 * CancelError 拒绝。promise 本身不停——它停不停是它自己的事（例如
 * 模型请求要自己监听信号 abort，见 providers.ts；子进程要自己监听
 * 信号 kill，见 tools.ts）。只用来“不等了”，不用它假装“停了”。
 */
export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined | null,
  reason: CancelReason,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelErrorFromSignal(signal, reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(cancelErrorFromSignal(signal, reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * 等一个 promise 在宽限期内落定：落定了返回 { settled: true }（带值或
 * 带错），宽限到了仍没落定返回 { settled: false }。用于停止确认——
 * 发取消信号后等底层收尾，宽限到了还没停就如实记“正在停止”，不硬等、
 * 不谎报。注意：宽限到时不取消 promise 本身，它之后落定也只是没人接。
 */
export async function awaitSettled<T>(
  promise: Promise<T>,
  graceMs: number,
): Promise<{ settled: boolean; value?: T; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), Math.max(0, graceMs));
  });
  const done = promise.then(
    (value) => ({ settled: true as const, value }),
    (error) => ({ settled: true as const, error }),
  );
  const result = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
