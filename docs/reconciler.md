# 卡住步骤看门狗（Pi Bot 借鉴第 3 条）

借 Pi Bot 群组自推进 reconciler 的形状，不抄它的 API 与文案，不接 pi 当
内核，不捆 MinGit。Pi Bot 的做法是每秒扫一遍运行中的步骤 + 步骤结束事件
触发 settled()，双通道；运行记录全落盘，崩溃后 recover() 续跑。Nyra 已
有的东西比它全：任务板（`docs/kanban.md`，持久任务板、标 done 前须附验
证证据、满 3 次熔断进 blocked 只人 reset）+ 崩溃自续（`docs/resume.md`，
auto_resume 默认关、无人值守续跑强制只读）+ Heartbeat（`docs/heartbeat.md`，
只读轮询、无事安静）。本批补的是卡住步骤看门狗：给任务板加一个
reconciler，定期扫在跑的步骤，卡住时按策略处理——先提醒/标记，再按轮
次上限重试，超限进 blocked 只等人，不悄悄丢任务、也不无上限自循环。

## 口径

- **扫谁**：任务板里状态为 working 的任务（queued / review / blocked 的
  不管；blocked 只等人 reset）。
- **什么叫卡住**：静默时长超过阈值（默认 1800 秒）。静默时长按“最后有
  进展的时间”算，三处信号取最新：任务本身的 `updatedAt`、绑的运行的
  `updated_at`、子 agent 心跳 `lastHeartbeatAt`。任一处动了都算有进展，
  长任务不会因为“跑得久”被误判。
- **阶梯**（一轮扫描只走一步，不一次跳到底）：
  1. **标卡住**：第一次发现，记 `stuckAt`（本轮卡住 episode 的首次发现
     时间）、`stuckFlags + 1`、账本 history 留一条、镜像 `reconciler_stuck`
     事件、收件箱（`inbox.jsonl`）留一条提醒，让 Heartbeat 与收件箱检查
     能看见。任务仍在 working，不动它。
  2. **自动重排**：下一轮扫仍卡着、且 `watchdogRetries < maxRetries`
     时，走 fail 路径回队列（`attempts + 1`，满 maxAttempts 照样熔断进
     blocked），等下一轮 tick 再派发；`watchdogRetries + 1`，镜像
     `reconciler_retried` 事件。
  3. **停下等人**：重排用完仍卡着，直接进 blocked（不走 fail 路径——
     fail 还要再攒 attempts，超限停下等人不该等熔断计数凑满），镜像
     `reconciler_blocked` 事件；blocked 只能人 `kanban reset`，reset
     清重排预算（`watchdogRetries = 0`），累计被标卡住次数（`stuckFlags`）
     留着当历史。
  4. **恢复进展**：有进展且之前标过卡住，清 `stuckAt`，镜像
     `reconciler_recovered` 事件。离开 working（任何原因）也清 `stuckAt`。
- **绑的运行已进终态**（步骤结束事件通道 `settle`，或扫描时顺带看到）：
  - 失败（`failed` / `interrupted` / `verify_failed`，与 `sweepStaleWorking`
    同款口径）→ 走 fail 路径，镜像 `reconciler_failed` 不再另设（直接用
    kanban 自己的 `kanban_blocked` / `kanban_transition` 事件）。
  - 已结束（`verified` / `completed_unverified` / `incomplete`，轮数到
    顶算已结束不算失败，resume 还能续跑）→ 只记一条 `reconciler_run_done`
    事件（账本 `notedRunDone` 去重，同一运行只提醒一次），**不替人标完
    成**——完成须附验证证据，人说了算；任务也不算卡住（等验证不是没进展）。
  - 在等人工批准（`awaiting_approval`）→ 不算卡住，跳过。等批本身就是
    下一步（Pi Bot 的 reconciler 也跳过“执行体 waiting 或有待回答的问题”）。
- **双通道**：`nyra reconciler scan`（手动立刻扫，不受启用开关限制）与
  守护进程每轮调的 `runDueReconciliations`（未启用或未到扫描间隔时只回
  skipped）；步骤结束事件触发 `nyra reconciler settle <运行 id>`（运行
  结束时立刻调和它绑的任务，没绑返回 `{found: false}`）。

## 刹车（一条不丢）

- **无人值守强制只读起步**：看门狗只重排任务板任务（回队列等下一轮 tick
  派发），不调模型、不写任务板账本以外的文件、不对外发、不碰审批；重排
  回来的任务续跑时照样强制只读（resume.ts 既有口径）。
- **红线表与成本硬顶照样在**：重排不绕过任何一道门——续跑的任务要做的
  动作照样过审批（敏感操作照样人批）、照样计价进月度账本、触顶照样停下。
- **自动巡查默认关**：`reconciler.enabled` 默认 false，显式 opt-in 才自动
  巡查；手动 `nyra reconciler scan` 是人当场点的动作，不受开关限制。
- **不丢任务、不自循环**：重排有上限（默认 2 次，最多 5 次，0 表示标完
  直接停下），超限进 blocked 只等人；任务板账本本身是持久的，崩溃不丢。

## 配置

`config.json` 里加一节 `reconciler`（非法值回默认，与信任阶梯同款口径）：

| 键 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `reconciler.enabled` | `false` | 布尔 | 自动巡查开关（只 `true` 算开） |
| `reconciler.stuck_after_seconds` | `1800` | 整数 60–86400 | 多少秒无进展算卡住 |
| `reconciler.max_retries` | `2` | 整数 0–5 | 每任务最多自动重排几次 |
| `reconciler.scan_interval_seconds` | `300` | 整数 60–3600 | 守护进程每几秒扫一遍 |

`nyra config explain` 第 11 项就是它（`reconciler.*` 四个键），`docs/CONFIG-MAP.md`
由 `node --experimental-strip-types scripts/gen-config-map.ts` 从 explainAll()
重新生成。

## 命令

| 命令 | 说明 |
| --- | --- |
| `nyra reconciler scan` | 立刻扫一遍在跑的任务（不受启用开关限制） |
| `nyra reconciler status [--json]` | 配置 + 上次扫描 + 在跑/卡住/blocked 数 |
| `nyra reconciler enable` / `disable` | 开/关自动巡查（写 `config.json` 整节） |
| `nyra reconciler config [--stuck-after-seconds N] [--max-retries N] [--scan-interval-seconds N]` | 改阈值/轮次/间隔（逐项校验范围，至少给一项） |
| `nyra reconciler settle <运行 id>` | 步骤结束事件通道：运行结束时立刻调和它绑的任务 |

## 账本与事件

- 账本 `~/.nyra/reconciler.json`（原子写 0600，损坏先备份
  `.corrupt-<时间戳>` 再抛错）：`{version: 1, lastScanAt, notedRunDone[]}`
  （上次扫描时间 + 已提醒过的 run_done 运行 id，最多 50 条）。
- 任务板行加三字段（`src/kanban.ts`）：`stuckAt`（本轮卡住 episode 的首次
  发现时间，有进展即清零）、`stuckFlags`（累计被标卡住次数）、
  `watchdogRetries`（看门狗累计自动重排次数，`kanban reset` 时清零）。
  老行缺字段时读出来补默认值（null / 0 / 0），下次保存即回写。
- 5 个新运行事件已注册进 `EVENT_FIELDS`（`src/runs.ts`），只记元数据与
  id，不记任务标题、不记运行输出、不记绝对路径；`src/timeline.ts` 加渲染：

| 事件 | 字段 | 含义 |
| --- | --- | --- |
| `reconciler_stuck` | task_id, idle_seconds, retries | 标卡住 |
| `reconciler_retried` | task_id, idle_seconds, retries, attempts | 自动重排 |
| `reconciler_blocked` | task_id, idle_seconds, retries | 重排用完，停下等人 |
| `reconciler_recovered` | task_id, idle_seconds | 恢复进展 |
| `reconciler_run_done` | task_id, run_id, status | 运行已结束，任务仍在 working |

- 守护进程轮询：`nyra schedule` 的 pollers 里在 Heartbeat 之后加看门狗
  poller（动态 import `reconciler.ts`，调 `runDueReconciliations(home)`，
  有动作才打印一行 `[看门狗] …`，失败只记 stderr，不破坏定时任务）。

## 诚实边界

- 看门狗只量“有没有动静”，不量“动静对不对”——运行一直在写无意义的
  日志、任务一直在改无关字段，都算有进展；内容本身对不对靠验收与人审。
- 进展信号三处取最新是启发式：任务 `updatedAt` 是状态变更时间，不是
  真实工作量；运行 `updated_at` 与子 agent 心跳也一样——“有动静”不等于
  “在往正确的方向走”。
- 重排只是“回队列等下一轮 tick 再派发”，派发本身由 `kanbanTick` 决定；
  看门狗不保证重排后立刻有人接，也不保证重排后就不卡了。
- 真 API 未跑通，只在假 provider 与本地确定性检查上验过；Windows/macOS
  真机未验证。
