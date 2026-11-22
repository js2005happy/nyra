# 并行 delegate（缺口 3a）

> 缺口 3（多线程并行 + worktree + review queue + 手机审批的调度面）的第一批：
> 只做并行 delegate。review queue 与手机审批面是第二批（3b），已落地
> （见 docs/review-queue.md）；本批每线程的结构化证据就是 3b 消费的接口。

## 用法

模型在主循环里显式调 `delegate_parallel`：

```json
{
  "tasks": [
    { "task": "调研 A 方案的优缺点", "tools": ["web_search", "web_fetch", "read_file"] },
    { "task": "在 worktree 里修 B 模块的拼写错误", "isolation": "worktree" }
  ],
  "max_concurrency": 5,
  "timeout_ms": 600000
}
```

每项子任务的字段与 `delegate` 同义：`task`（必填）、`max_turns`（1–12，默认 6）、
`isolation`（`none` / `worktree`）、`tools`（白名单）、`model`（子任务模型）、
`output_schema`（结构化输出契约，见 `docs/steer-schema.md`：校验失败给一次
有界纠正轮，仍失败按失败走）。
也可以在代码里直接调 `Agent.delegateParallel(tasks, opts)`，返回结构化结果
（`ParallelDelegateResult`，见 `src/parallelDelegate.ts`）。

## 后台扇出与合并（H-5 + H-6，详见 docs/merge-fanout.md）

`delegate_parallel` 默认后台跑：`background` 默认 `true`，顶层委派立即回
handle，跑完后单条 consolidated 消息回填；显式传 `background: false`
才同轮等结果。`backfill` 是 `single`（默认）/ `per-group`（每线程完成回
一条）。`merge: true` 时批跑完加一次合并步（一次模型调用 + verifier
确定性检查 + review queue 人批），合成为一份交付物；合并步只读、不改
文件，完整版落盘 `~/.nyra/merged/<mg_id>.md`。后台扇出直接落任务板
（`kind: delegate`），重启不丢；`nyra fanout <list|show|recover>` 查与回收。

## 嵌套编排 opt-in（H-7，缺口 13 深化）

默认 flat：子 agent 不能再派子 agent。大任务想分层拆（父级拆给子级，
子级再拆给孙级），须父级在委派时显式授予 `orchestrator: true`：

```json
{ "task": "调研 A 方案", "orchestrator": true }
```

`delegate_parallel` 每条线程也可以单独给 `orchestrator`。规则：

- 深度上限默认 2 层（`config.json` 的 `delegate_max_depth` 可配 1–5，
  非法值回 2）；根 agent 是第 0 层，不受 flat 门限制。
- 每层预算独立记账：每层各有 8 个子 agent 名额（与串行 `delegate` 共用
  同一份按层预算），第 0 层用满不影响第 1 层；超了直接 `rejected`，不启动、
  不占预算。金额上各层仍按既有口径（子任务花费进父级 `delegateSpentUsd`，
  月度硬顶与分层成本上限在每层都生效），不另建分层金额账本。
- 防循环委派：分派时显式指定的 agent 已在当前委派链里（A 派 B、B 派 A
  或更长的环）直接拒绝；没指定 agent 时子级继承父级 Soul，继承不是循环。
- 团队模式：默认只有参谋长能分派；被授予 `orchestrator` 角色的成员也能
  再往下分派（仍须指定 agent、仍须完整 Charter）。详见 `docs/team.md`。
- 内部机械步（H-5 合并子 agent，`internal: true`）绕过深度门与 flat 门
  （它只读合成、不再委派），但仍占一次子 agent 预算。
- 拒绝进证据链：`delegate_rejected` 事件（task_id / reason / depth）；
  `delegate_start` 多了 `depth` 与 `layer_remaining` 两个字段，花名册
  （`nyra roster`）详情里能看到每行的委派层级；H-3 的停止沿 `parentRunId`
  递归停子树，嵌套层同样走这条路；H-2 的引导检查点与 H-5/H-6 的
  `output_schema` 契约、合并步在嵌套层同样适用，不另起一套。
- 强不了在哪：层数越深，上下文与成本越难控，失败定位越难；不要拿
  “后台跑”当“跑完了”、不要拿“合并了”当“对了”。

## 硬约束（不是默认值，是顶）

| 约束 | 值 | 说明 |
|---|---|---|
| 默认并发上限 | 5 | 同时跑的线程数；调用方给再大也只按 5 跑，并在结果里注明被夹住了 |
| 单任务超时 | 10 分钟（600000ms，可配） | 到点先发取消信号（模型请求 abort、子进程 kill），再等宽限期（默认 1 秒）确认底层停下；宽限到了还没停，线程标“正在停止” |
| 每层子 agent 总数 | 8（每层独立记账，与串行 delegate 共用同一份按层预算） | 超出的线程直接 `rejected`，不启动、不占预算 |
| 嵌套深度 | 2 层（`config.delegate_max_depth` 可配 1–5） | 深度已满时整批 `rejected`，一个线程都不启动 |

并行是 opt-in：只有显式调 `delegate_parallel` 才并行，串行 `delegate`
的行为一点没变，不会自动把一批串行调用改成并行。

## 失败隔离

任一线程失败/超时/被取消只记自己那一项，其余线程照常跑完；主流程只汇总成功者，
失败逐项注明原因与已花成本。线程状态共五种：`ok` / `failed` / `timeout` / `rejected` / `cancelled`（整批取消时被取消的线程）。
工具返回的汇总文本先给总账（成功几个、失败几个、超时几个、被拒几个、总耗时、
已计价花费合计），再逐线程列状态、耗时、花费、模型、worktree 路径与改动文件、
失败原因、成功者的摘要原文。

## 权限边界（与串行 delegate 同款，不另开旁路）

- 每线程照常走 `delegateDetailed`：工具白名单、worktree 隔离、沙箱、成本上限
  （单次 `--max-cost` 与月度上限，子任务继承父级口径）、审批回调全部继承。
- 收敛规则写进子任务的系统提示（`parallelConvergenceNote`）：只做自己那件任务，
  不修改、不读取其他线程负责的文件；不等其他线程、不跨线程协调；收尾写收敛小结
  （改了哪些文件、验证结论、没验证就写“未验证”）；审批规则与父级相同，不自动放行。
- 缺口 5 的规则同样守住：队列/定时任务里不自动换模型——`tasks.ts` 的
  `buildProvider` 只给单个 provider，子任务继承父级 provider，本批不新增任何
  自动切换；并行本身不自动放行任何审批，`approveFn` 逐次照常走。

## 给 3b 的接口：每线程的证据字段

`ParallelThreadResult.evidence`（`Agent.delegateParallel` 的结构化返回）：

| 字段 | 内容 |
|---|---|
| `changedFiles` | worktree 隔离下改动的文件（相对路径，取自 `git status --porcelain`）；非 worktree 为空 |
| `diffStat` | `git diff --stat HEAD` 原文；无改动或非 worktree 为 `null` |
| `worktreePath` | 改动留下的 worktree 路径；无改动、无隔离或已清理时为 `null` |
| `verification` | 现在恒为 `{ status: "not-verified" }`——3a 不做自动验证、不替子任务编验证结论；子任务自述的验证情况见摘要原文，真正的验收结论由 3b 的 verifier 填写 |
| `spentUsd` | 该线程已花美元；未计价（无单价 / provider 未报用量）时为 `null`，不编数字 |

整批汇总还发 `parallel_delegate` 事件（进 `events.jsonl` 与 `--json` 事件流）：
`succeeded` / `failed` / `total_spent_usd` / `max_concurrency`。

## 为什么没复用 ToolPool 的 worker 池

报告建议复用 `src/toolPool.ts` 的 worker 池，核查后未照搬：该池是
`node:worker_threads` 的 CPU 池（BM25 打分 / JSON 解析 / spin），子 agent 是带
provider、工具集、审批回调与 worktree 状态的主线程异步对象，进 worker 线程要
序列化全部上下文且 worktree/sandbox 状态无法共享。本批复用的是它的纪律而不是
它的线程：有界槽位 + 排队 + 单任务超时硬约束，语义与 ToolPool 对齐（超时即判失败、
不静默等下去），实现在主线程用信号量做。若以后真要把子 agent 放进 worker 线程，
需先解决 provider 与审批状态的序列化，那是另一批工作，不在本批假装已解决。

## 已知局限（诚实边界）

- **超时先发取消信号、再等宽限期确认**：到点先给线程发取消信号
  （模型请求 abort、子进程 kill），再等宽限期（默认 1 秒，可配
  `cancelGraceMs`）确认底层停下；宽限到了还没停，线程标“正在停止”
  （`stopConfirmed: false`），槽位照样释放，但结果里如实记
  `pendingAfterTimeout`（宽限期内未确认停下的线程数）。它的 worktree
  清理与花费记账（`delegate` 的 `recordChildUsage`）照常走，事后多花
  的钱仍会计入父级的 `delegateSpentUsd`，但不进本批返回的
  `totalSpentUsd`。**为了让这条不吃人**：结果里新增 `pendingAfterTimeout`
  （宽限期内未确认停下的线程数），有这类线程时汇总文本的金额写成
  `≥$x` 并注明「上值只是下限」——不要把 `totalSpentUsd` 当最终账单，
  也不要把它当上限。
- **非 worktree 的并行线程共享同一工作目录**：两个线程同时改同一文件会互相覆盖，
  本批不做冲突检测与合并（那是 3b / 缺口 13 验收队列的事）；需要隔离写操作时用
  `isolation: "worktree"`，每线程各拿一个独立工作树。
- **验证结论目前是占位**：`verification.status` 恒为 `not-verified`，子任务摘要里
  自述的验证情况未经核实，不要把它当成已验证的结论。
- **并发上限 5 是进程内上限**：同一时间只能有一批并行委派在跑（主 agent 在等工具
  结果），不存在两批互相抢槽位的情况；网关多会话各自有自己的 Agent，互不共享上限。
- 未在真机 Windows/macOS 上跑过并行 worktree 流程，靠 CI 的三平台任务验证。
