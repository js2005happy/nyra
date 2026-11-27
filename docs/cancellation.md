# 取消口径：真取消执行（可靠性打磨第 1 项第一批）

以前的“停下”是假的：`/stop` 只在花名册上记一笔请求，超时只在上层
Promise.race 决出胜负就当停了，底层模型调用、工具、子进程照常在后台
跑完，花掉的钱照样算。本批补的是一套统一的取消信号：从三处发起点
（`/stop`、超时、预算触顶）都能发信号，信号一路传到模型请求（abort）、
工具执行、子进程（kill），并且只有确认底层真的停了，才把任务标成已停。

## 三条发起路径

| 发起点 | 怎么发信号 | 走通的真实路径 |
|---|---|---|
| `/stop`（Bot） | Bot 队列 abort 该会话在跑任务的信号，`Agent.run(text, { signal })` 一路往下传 | 队列信号 → 模型请求 abort → 运行收敛成“已取消” |
| `/stop`（子 agent） | `nyra subagent stop <运行 id> --yes` 在注册表记请求；子 agent 主循环每 500ms 的监视器看到请求就 abort 本轮信号 | 注册表请求 → 监视器 abort → 子 agent 行自己标 `stopped`（`markSubagentStopped`） |
| 超时 | 并行线程到点先发取消信号，再等宽限期确认；单任务超时同理 | 超时 → 线程信号 abort → 宽限内确认停下才标 `stopConfirmed: true` |
| 预算触顶 | 主循环每 500ms 的监视器跑 `costCapTripped()`（与 `checkCost` 同口径的只读判定：单次上限），触顶就 abort 本轮信号 | 单次上限超限 → 监视器 abort → 运行收敛成“已取消（成本上限已触顶）” |

“金额未知则暂停”已落地（可靠性打磨第 2 项，并发预算预留，详见 `docs/budget.md`）：`costCapTripped`
算不出金额时仍返回 false，不 abort——金额未知由请求前预留门（`reserveNextCall`）
与 `checkCost` 的严格分支暂停（默认开），不进这个 500ms 监视器：监视器只看已计价的数，暂停不是取消，不走 abort。

## 信号传到哪

信号是标准的 `AbortSignal`，新模块 `src/cancel.ts`（叶子模块，不 import
任何 src 内模块）只做三件事：`CancelController`（abort 只生效一次，先到的
原因赢，`CancelReason = "stop" | "timeout" | "budget"`）、`combineSignals`
（任一 abort 则合并信号 abort，原因原样传）、`raceWithSignal` /
`awaitSettled`（只“不等了”，不假装“停了”）。

- **模型请求**：`Provider.chat` 加 `opts?: { signal }`；`Provider.postJson`
  合并外部信号与内部超时控制器，外部 abort 抛 `CancelError`（不是超时）；
  `CliProvider.chat` 信号 abort 时杀整个 Codex 子进程组；
  `FallbackProvider` / `KeyRotatingProvider` 把信号传给底层 provider，
  `CancelError` 不是 `ProviderError`，直接穿过、不重试、不切换；信号
  进来时已 abort，入口直接按取消抛，不再尝试任何 provider；退避睡眠
  被中断且信号已 abort 时抛 `CancelError` 而不是原错；
  `Agent` 主循环的模型调用、`runHookPrompt`、`describeImages` 都传信号。
- **工具执行**：`ToolContext.cancelSignal`，`executeTool` 入口先查信号，已
  abort 直接抛 `CancelError`；shell 工具（流式与非流式）abort 时 killTree，
  `fetchChecked` 合并外部信号与超时控制器；`web_fetch` / `web_search` /
  `http_post` 传信号且 `CancelError` 原样抛、不吞成错误文本。`executeTool`
  的 catch 里 `CancelError` 原样上抛（不是工具失败），否则 Agent 主循环
  收不到取消信号。
- **子进程**：`runShellStreaming` / `toolShell` / `runSandboxed`（bwrap）/
  `runSeatbelt` / Windows 沙箱，abort 时杀进程（组），close 后以
  `CancelError` 拒绝；已 abort 时不启动。
- **子 agent**：`delegateDetailed` 建子 Agent 时传
  `combineSignals([父级信号, opts.signal])`，子任务被取消时父级认得出
  （`child.lastCancelledReason`）：不验收、不重做、不标 completed/failed，
  记账、发 `delegate_end ok:false`、清 worktree、交回“已取消”结果。

## 停止确认语义

- 只有确认底层真的停了（模型请求已 abort、子进程已退出、工具已收尾），
  才释放执行槽位、才把任务标成已停止。
- 停不下来时任务保持“正在停止”而不是谎报已停：并行线程的
  `stopConfirmed: false`，`pendingAfterTimeout` 记的就是这类线程数
  （宽限期内未确认停下的线程数）；花名册上行还是 `running`，标“已请求停止”。
- 宽限期：超时或整批取消发信号后，等底层停下最多 1 秒（默认，
  `cancelGraceMs` 可配）。配合停下的确认只要毫秒级（abort 是即时的），
  宽限只在不理信号的线程上才烧满——烧满了就如实记“正在停止”，不无限等。
- 排队的线程不再启动：整批取消后，排队线程直接标 `cancelled`（不调 runner）。
- 取消收敛成“已取消”的部分成果文本（`cancelledText`），不是失败：
  发 `run_cancelled` 事件（已注册进 EVENT_FIELDS，`reason` + `source`，
  `src/timeline.ts` 加渲染；`source` 按原因定：budget→`budget-cap`、
  timeout→`timeout`、stop 时外部信号已 abort→`external-signal` 否则
  `stop-request`）；子 agent 行调 `markSubagentStopped`（与人工确认
  `acknowledgeSubagentStop` 同一语义、同一 `subagent_stopped` 事件，
  只是调用方是运行本身）。

## 不改的行为

取消是高风险改动，只改取消路径，正常执行路径的行为不变：没收到取消信号
时，模型调用、工具、子进程、委派的流程与以前完全一致；`checkCost` 仍在调
用返回后硬停（预算预留是下一项的事）。

## 已知局限（诚实边界）

- 已发出去的外部动作停不掉（消息已发出、请求已到对方手里），只能停
  “还在本机跑着的”部分。
- 宽限到了还没停的线程，底层可能还在收尾：它的 worktree 清理与花费记账
  照常走，事后多花的钱会计入父级 `delegateSpentUsd`，但不进本批返回的
  `totalSpentUsd`——汇总文本写成 `≥$x` 并注明“上值只是下限”。
- 进程退出，后台跑着的模型循环就停了，跑一半的任务不能原地续跑，须
  `nyra fanout recover` 回收（与以前同款，不是本批引入的）。
- 只在假 provider / 假 transport 与本地确定性检查上验过；真 API 未跑通，
  Windows/macOS 真机未验证。
