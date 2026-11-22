// src/bot/sessionQueue.ts — Bot 方向 Phase 1：会话级 FIFO 串行队列。
//
// 为什么要按会话串行：同一个群/私聊里两条消息同时进模型会互相抢会话文件、
// 回复乱序；不同会话之间则互不影响、可以并行。所以队列以 sessionKey 为
// 粒度：同一 key 严格串行，不同 key 各走各的。
//
// 取消语义（/stop 与超时共用同一条路）：
//   - 排队中的任务：直接出队，调用方的 enqueue promise 以 "cancelled" 兑现；
//   - 正在跑的任务：abort 它的 AbortSignal，任务函数自己负责在信号触发后
//     尽快收尾（BotRunner 里是 agent.run(text, { signal })，信号一路传
//     给模型请求、工具执行与子进程，见 docs/cancellation.md）；
//   - cancel() 之后同一 key 的新任务照常入队（取消只影响当时的任务，不锁会话）。
export type QueueResult = "done" | "cancelled";

interface QueueEntry {
  fn: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** 本次取消的原因（timeout = 队列超时掐断；stop = /stop 主动取消）。 */
  abortReason: "timeout" | "stop" | null;
  resolve: (r: QueueResult) => void;
  reject: (err: unknown) => void;
}

export class SessionQueue {
  private queues = new Map<string, QueueEntry[]>();
  private active = new Map<string, QueueEntry>();

  /**
   * 把任务排进指定会话的队列；同一会话的任务按入队顺序依次执行。
   * timeoutMs > 0 时超时自动 abort（与 /stop 同一条取消路）。
   * 返回 "done"（跑完）或 "cancelled"（排队时被取消，或跑的时候被 abort——
   * 后一种由任务函数自己在信号触发后兑现；函数若忽略信号继续跑完，仍
   * 以 "done" 兑现，调用方按信号状态自行决定要不要丢弃结果）。
   */
  enqueue(
    sessionKey: string,
    fn: (signal: AbortSignal) => Promise<void>,
    opts?: { timeoutMs?: number },
  ): Promise<QueueResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = opts?.timeoutMs;
    const entry: QueueEntry = {
      fn,
      controller,
      timeoutTimer: null,
      abortReason: null,
      resolve: () => {},
      reject: () => {},
    };
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        entry.abortReason = "timeout";
        controller.abort();
      }, timeoutMs);
      entry.timeoutTimer = timer;
    }
    const promise = new Promise<QueueResult>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    const q = this.queues.get(sessionKey) ?? [];
    q.push(entry);
    this.queues.set(sessionKey, q);
    void this.pump(sessionKey);
    return promise;
  }

  private async pump(sessionKey: string): Promise<void> {
    if (this.active.has(sessionKey)) return;
    const q = this.queues.get(sessionKey);
    const entry = q?.shift();
    if (!entry) {
      if (q?.length === 0) this.queues.delete(sessionKey);
      return;
    }
    this.active.set(sessionKey, entry);
    try {
      await entry.fn(entry.controller.signal);
      entry.resolve(entry.controller.signal.aborted ? "cancelled" : "done");
    } catch (err) {
      entry.reject(err);
    } finally {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      this.active.delete(sessionKey);
      void this.pump(sessionKey);
    }
  }

  /** 取消该会话正在跑的任务（abort 信号）与全部排队任务（直接出队）。 */
  cancel(sessionKey: string): { cancelledActive: boolean; cancelledQueued: number } {
    const active = this.active.get(sessionKey);
    let cancelledActive = false;
    if (active) {
      active.abortReason = "stop";
      active.controller.abort();
      cancelledActive = true;
    }
    const q = this.queues.get(sessionKey) ?? [];
    const cancelledQueued = q.length;
    for (const entry of q) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      entry.resolve("cancelled");
    }
    this.queues.delete(sessionKey);
    return { cancelledActive, cancelledQueued };
  }

  /** 该会话正在跑的任务是否存在（/stop 没任务时要老实说“没有在跑的任务”）。 */
  isActive(sessionKey: string): boolean {
    return this.active.has(sessionKey);
  }

  /** 该会话当前任务的取消原因（未取消时为 null；供任务函数决定回复文案）。 */
  abortReason(sessionKey: string): "timeout" | "stop" | null {
    return this.active.get(sessionKey)?.abortReason ?? null;
  }

  /** 该会话排队中的任务数（不含正在跑的）。 */
  queuedDepth(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  /** 该会话的总深度（正在跑 1 + 排队 N），供 /status 与队列深度展示。 */
  depth(sessionKey: string): number {
    return (this.active.has(sessionKey) ? 1 : 0) + this.queuedDepth(sessionKey);
  }

  /** 全部会话的总深度。 */
  totalDepth(): number {
    let total = this.active.size;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  /** 正在跑的会话 key 列表（调试与 /status 用）。 */
  activeKeys(): string[] {
    return [...this.active.keys()];
  }
}
