# 并发预算预留（可靠性打磨第 2 项）

## 一句话

模型调用发出之前，先按单价与预估量把额度预留下来——预留失败（超上限）直接拒绝、不发请求；所有会话、所有并行任务共享同一本原子预算账本；未配单价或调用缺用量时不再继续跑，暂停等人工处理。

## 为什么要做

以前有三个洞：

- **未配单价或缺用量时继续跑**：算不出金额就不检查，等于上限形同虚设。
- **成本在调用返回后才检查**：调用已经发出、钱已经花了，硬顶只能事后止损。
- **并行任务有在途花费**：几个线程同时跑，各自只看“已花”，没人算“正在花”的那部分，合起来很容易超支。

本批把检查点挪到调用之前，并给在途花费记一本账。

## 账本：`~/.nyra/budget-ledger.json`

- 格式：`{version: 1, reservations: [...]}`，每行一笔预留：`id`（`rsv_<12 位 hex>`）、`owner`（谁预留的：子 agent 用注册表行 id，主 agent 用会话 id，都没有时是 `cli`）、`amountUsd`、`reason`（`next-call` / `parallel-thread` / `manual`）、`bindingScope`（撞上的是哪层上限：`run` / `monthly` / `tiered:<层>`，没撞上时为 null）、`createdAt` / `expiresAt`、`pid`、`status`（`reserved` / `settled` / `released`）、`settledUsd`（结算时的实际花费，没结算时为 null）。
- 只记用量数字，不记任务文本、不记模型回答、不记绝对路径。
- 权限 0600，原子写（先写临时文件再改名）；文件损坏时先备份成 `budget-ledger.json.corrupt-<时间戳>` 再抛错，不静默丢账。
- 每次读写都重新读文件，不在内存里缓存——跨会话、跨进程共享靠文件本身。同一个进程里的并发预留是原子的（整段 reserve 都是同步文件操作，不会被别的线程插队）；跨进程的读改写仍有竞态窗口，同一台机器上两个进程同时预留时以文件为准、后写的那笔以最新文件重算（见“诚实边界”）。
- 过期：默认 TTL 1 小时；过期预留在读时不计入、不拦路，下次写盘（reserve 写盘、`nyra budget list/show` 的 prune）时标 `released` 留痕。调用/线程预留的 owner 进程已死（`process.kill(pid, 0)` 抛 ESRCH）同样算过期——崩溃的进程不留僵尸预留。**手动预留（`nyra budget reserve`）例外：它是跨进程持有的，预留命令跑完退出是正常的，只按 TTL 过期、不看 pid**（真 CLI 冒烟跑出来的问题：初稿按 pid 清掉了刚预留的手动记录）。

## 预留算法

每次模型调用发出前（`Agent.reserveNextCall`，在 `actModel.chat` 之前）：

1. 没有美元上限（单次 `--max-cost` / 月度上限）且没有分层回调 → 不预留，直接发请求。
2. 未配单价：有美元上限要守且严格模式开 → 暂停（见下），调用不发出；非严格模式 → 继续跑（旧行为）；只有分层回调时 → 先判一次分层（USD 传 null，只判 token 层），判不过直接抛分层文案。
3. 已有调用未报用量（`missing_calls > 0`）：同上——有美元上限且严格模式 → 暂停，不再发下一轮调用。
4. 预估本次调用：`estimateCallUsd(prompt 字符数, 单价)`，输入按提示字符 / 2.5 折 token，补全默认按 400 token 算（与 `nyra cost --estimate` 同一套换算）。
5. 分层预判：把“本次运行已花 + 在途预留 + 本次预留”当在途花费传给分层回调，超了直接抛它的文案（回调里已按现有口径建暂停记录）。
6. 只有分层回调、没有美元上限时到此为止（不预留，没上限可守）。
7. 拼 limits 逐层算 `已花 + 在途预留 + 本次 <= 上限`：单次层（已花 = 本次运行已计价合计：主 agent + 已完成子任务 + 语音）、月度层（已花 = 账本里本月已落盘的 + 本次运行进行中）。任一层不够 → 拒绝，调用不发出，发 `budget_rejected` 事件。
8. 成功 → 写盘，发 `budget_reserved` 事件，返回预留记录。

调用返回后：按实际增量结算（新已花 − 预留时已花），发 `budget_settled` 事件；本次调用没报用量、算不出实际花费 → 释放预留（不编结算数），随后 `checkCost` 的严格分支暂停。调用抛错（取消、provider 报错等）→ 释放预留，发 `budget_released` 事件（reason 记 `call-failed` / `cancelled`）。

## “金额未知则暂停”严格模式

开关：`config.json` 的 `budget.strict_unknown_amount`，默认 **true**（fail-closed）。改开关：`nyra budget strict --on/--off --yes`（改配置须 `--yes`，与 `governance caps` 同款确认口径）。

触发（只针对美元上限——没上限可超，算不出也无所谓）：

- **未配单价**（`no-pricing:<模型>`）：严格模式下第一次调用前就暂停，还没花钱。
- **调用返回缺用量**（`missing-usage:<n>次调用未报用量`）：之前的花费算不出来，严格模式下不再发下一轮调用。

暂停不是取消：建一条暂停记录（`cost-pauses.json`，scope 固定 `unknown-amount`，同 agent + 同 scope + 同月去重），发 `budget_paused` 事件，运行以 AgentError 结束（文案里写清哪条原因、怎么配单价、怎么恢复）。暂停的任务板任务同步进 `paused`（与分层暂停同款）。

恢复：`nyra governance caps resume <暂停 id> --yes`。恢复条件（`costCaps.resumePause` 的 unknown-amount 分支，不走分层重判）：

- 严格模式已关 → 放行；
- 原因是 `no-pricing` 且该模型现在能解析出单价 → 放行；
- 否则拒绝（文案：先配单价，或 `nyra budget strict --off`，或放弃该暂停）。

放行后发 `budget_resumed` 事件，任务板 paused 任务回 `queued`。注意：恢复后，未计价的用量仍按未知记，不事后补算、不补编。

## 与分层成本上限的关系

分层回调（`tieredCapCheck`，缺口 43 第三批）不走预留账本，原因只有一条：**它的 token 层不需要单价**。

- 单价未知时，分层仍先判一次（USD 传 null，USD 层跳过、只判 token 层）。只配了 token 层上限、无单价时，分层照样拦停——不能被“金额未知暂停”抢先（回归测试在 `test-budget-reservation.test.ts`，旧口径见 `test-cost-caps.test.ts` 的 `test_agent_callback_stops_run_and_pauses`）。
- 单价已知时，分层预判把在途花费（已花 + 在途预留 + 本次预留）传给回调，超了直接抛分层文案。
- 预算触顶的取消仍走第 1 项的监视器 + `CancelError`（reason: `budget`）：500ms 监视器跑 `costCapTripped()`，只看已计价的数；金额未知不进监视器（暂停不是取消，不走 abort）。

## 并行委派：线程级预留

每个并行线程启动前，先按悲观档预估（`estimateRunCost` 的 `pessimisticUsd`：任务字符 + 2000 系统字符 + 该线程 maxTurns 轮）预留整线程的预算（`runParallelDelegate` 的 `reserveThread` 钩子）：

- 预留失败的线程直接标 `rejected`、不启动（不调 runner），原因写清哪层不够。
- 线程预留 TTL = 该批 `timeoutMs` + 60 秒。
- 跑完后按线程结果结算：`ok` / `failed` 的线程按 `evidence.spentUsd` 结算（有数才结算，否则释放）；`timeout` / `cancelled` 的线程释放（事后多花的钱仍按第 1 项口径进父级 `delegateSpentUsd`，不进本批 `totalSpentUsd`）。
- **保守双计**：子 agent 自身的逐调用预留与线程级预留用同一本账、同笔钱在两层都占着——只会早拒、不会超支。
- 只有分层回调、没有美元上限的并行批：不做线程预留（没上限可守），分层由每个子 agent 自己的逐调用门判。

## CLI：`nyra budget`

```text
nyra budget list [--json]              预留记录（在途 + 已结算/已释放历史）
nyra budget show [--json]              在途预留 + 本月已花 + 严格模式 + 待处理暂停
nyra budget reserve <金额> [--reason <原因>] [--ttl-ms <毫秒>]
nyra budget settle <预留 id> <实际花费>
nyra budget release <预留 id>
nyra budget strict [--on | --off] [--yes]
```

金额单位是美元。手动预留只对月度上限（配了才查：本月已花 + 在途预留 + 本次 <= 上限）；单次运行上限没有运行上下文，查不了。`strict` 不带 `--on/--off` 时只显示当前状态；改开关须 `--yes`。

`nyra cost --show` 同样多一行在途预留 + 严格模式；`--show --json` 的 `budget` 字段（追加在 `monthly` 之后）：`active_reserved_usd`、`strict_unknown_amount`。

## 每日上限与用量仪表（M1：学 OMB 的 usage_limits）

只借“按 Bot 分 + 界面可见”，不借 OMB 的宽松语义——Nyra 的硬顶不变：
调用前预留、未知单价暂停、日/月上限触顶就停。

- 每 Bot 每天也能单独设上限：`nyra governance caps set --scope agent:<id> --day-usd <美元> --day-tokens <token 数> --reason <原因>`（与月上限 `--usd` / `--tokens` 同款，只 agent 层可用；其他层传了直接拒绝）。每日上限在本地自然日 0 点重置，触顶时的恢复办法写“等明天 0 点重置”。
- 用到 80% 就告警：每日/每月任一窗口的美元或 token 用到 80% 以上，`nyra governance caps eval` 与用量仪表都会标出来（分层判定里的 `warnings`，kind 是 `approaching_limit`）；没超限只是提醒，不停。
- 用量仪表：`nyra usage [--agent <id>] [--json]`，按 Bot 列当日/当月两行用量条（已花/上限、百分比、80% 告警、触顶暂停状态）。`usage` 模型工具是同一份数，Bot 自己查还剩多少额度，不用问机主。数字只来自用量账本与分层判定；没设上限的窗口写“不限”，不编数；美元数是下界——未归属（CLI 交互运行与网关会话的花费，分不下去，只算组织级总数）与未计价的调用不摊到任何 Bot。

## 事件

6 个新运行事件（`src/runs.ts` 的 `EVENT_FIELDS` 已注册，时间线有渲染）：`budget_reserved`（reservation_id、owner、amount_usd）、`budget_settled`（reservation_id、reserved_usd、actual_usd）、`budget_released`（reservation_id、amount_usd、reason）、`budget_rejected`（owner、amount_usd、reason）、`budget_paused`（pause_id、agent、reason）、`budget_resumed`（pause_id、agent）。

## 诚实边界

- 只在假 provider / 假 transport 与本地确定性检查上验过；真 API 未跑通；Windows/macOS 真机未验证。
- 预估不是实测：补全默认按 400 token 算，实际补全更长时结算数会比预留大——预留是“事前拦超支”，不是“精确报价”。结算永远按实际用量算，预留与实际的差额在结算时找平。
- 跨进程竞态：同一进程内的并发预留是原子的；两个进程同时预留时，后写的那笔以最新文件重算，先写的可能被后写的覆盖——同机多进程并发是已知边界，不是严格串行化。
- 已发出去的外部动作停不掉；暂停只停“还没发的调用”。
- 进程退出则后台模型循环停了，跑一半的任务须 `nyra fanout recover` 回收（旧行为）。
