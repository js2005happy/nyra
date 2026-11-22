# 实时花名册与单点停止（H-1 + H-3）

借 Hermes 子代理并行界面的做法，不抄它的 API 形状与键位：Nyra 版先做
CLI 文本版——一张只读花名册 + 单点停止。桌面版 live 面板是后话。

## 花名册：`nyra roster <list|show>`

```text
nyra roster list [--all] [--agent <名字>] [--json]
nyra roster show <运行 id> [--json]
```

花名册是只读视图：每次调用从注册表（`~/.nyra/subagents.json`）+
任务板（`~/.nyra/kanban.json`）+ 运行记录现算，不重新执行、不花 token。
一行只放三项——状态、已耗时、当前动作：

```text
run-1 [进行中] nyra 3m 12s · 写完了第二章
run-2 [已卡住（心跳超时（120 秒没动静））] nyra 8m 01s · 写到第三步
```

- **状态口径复用 DSH-5 工单阶段表**（`src/timeline.ts` 的
  `deriveRunStage`）：进行中 / 等回答 / 等审阅 / 已卡住 / 空闲。
  注册表行按心跳与状态映射过去——running + 新鲜心跳 = 进行中，
  心跳超 120 秒 = 已卡住（与扫荡同口径），resume_pending = 已卡住
  （已崩待续跑），suspended = 已卡住（连崩挂起），终态
  （completed/failed/stopped）= 空闲；任务板 delegate 任务 working =
  进行中、review = 等审阅。
- **token/费用默认不显示**：列表（文本与 `--json`）里没有 token 与
  花费字段。想看用量点进详情：`nyra roster show <运行 id>` 末尾有
  一节“用量详情”（模型调用次数、子任务调用次数、token 合计、花费），
  那是详情视图才出现的地方。协作时各用各的 token，花名册上不混账。
- **默认只显示未终态的行**（在跑的才值得看），`--all` 才含终态行。
- **任务板 delegate 任务也上榜**：绑了注册表行的挂到同一行上
  （多一个“任务板”标记），没绑注册表行的单独成行（`delegate-task`），
  免得“在跑的任务板任务”在花名册上隐身。
- **子树有缩进**：`nyra subagent register --parent <父运行 id>` 登记的
  父子关系，花名册按深度缩进显示（最多 5 层）。
- 花名册是调用时的一张快照，没有实时推送通道——桌面版 live 面板
  是后话，CLI 文本版先把“卡在哪一眼可见”立起来。

## 单点停止：`nyra subagent stop`

```text
nyra subagent stop <运行 id> --yes [--reason "<原因>"] [--by <名字>]
nyra subagent confirm-stopped <运行 id> [--step "<停在哪一步>"] [--by <名字>]
nyra subagent cancel-stop <运行 id> [--by <名字>]
```

停止是**“请求停止”，不是“已停止”**：

1. `stop` 只在注册表上记一笔请求（`stopRequestedAt/By/Note`），并把
   绑了同一运行的 working 任务板任务送 review（partial 路径：部分成果
   留着，等人看，备注里写清停在哪一步）；沿 `parentRunId` 递归停子树
   （还在跑的孩子一起停，终态/已挂起的跳过并写清原因）。`--yes` 必填，
   停一个在跑的子 agent 是控制动作，不静默做。
2. 子 agent 收到请求后发取消信号停下——在途模型调用 abort、在途
   工具与子进程被掐断，底层确认停下后行自己标 `stopped`
   （`stopReason` 为 `cancelled`），花名册上是空闲（已终态）；人也可以
   用 `confirm-stopped` 确认（它是对“已经停了”这个事实的断言：没停
   下来不要调它，调了就是谎报）。
3. 停不下来的如实说“正在停止”：`stop` 之后行还是 `running`，花名册
   上标“已请求停止”，不写成已停。

**已请求停止的行不续跑**：`nyra subagent resume` 直接拒绝（先取消
请求或确认停下）；启动扫荡的自动续跑跳过这类行（只标 resume_pending，
不真续跑）。模型调用的取消已接通（可靠性打磨第 1 项第一批：停止请求
发取消信号，在途模型调用 abort、在途工具与子进程被掐断，确认停下后
行才标 `stopped`；宽限期内没停下来，行保持 `running`、如实写“正在
停止”），已发出去的外部动作仍停不掉——这是诚实边界。

**取消请求**：`cancel-stop` 清掉请求，行回到可续跑状态；任务板任务
若已因这次请求进了 review，不自动搬回来，等人用 `kanban decide` 定。

## 事件（证据链）

`subagent_stop_requested`（哪个运行、谁发起、停在哪一步）/
`subagent_stopped`（哪个运行、谁确认、停在哪一步）/
`subagent_stop_cancelled`（哪个运行、谁取消）已注册进 `EVENT_FIELDS`，
有运行上下文时镜像进运行事件；`src/timeline.ts` 加渲染。step 是心跳
检查点里的上一步摘要，不记任务正文。

## 已知局限

- 委派主循环里的检查点已接线（H-2 + H-4，见 `docs/steer-schema.md`）：
  delegate 调用点自动注册 + 每轮末尾过检查点（停止优先于引导），
  所以本批的停止语义完整落在在跑的 delegate 子任务上：工具跑完后
  停在当轮，不再往下跑；提前交回的行不标 `completed`，停没停下来
  以人的 `confirm-stopped` 为准。模型调用本身停不下来（与 Bot
  `/stop` 同一限制），已发出去的外部动作也停不掉。
- 花名册是快照，没有推送通道；桌面版 live 面板是后话。
- Windows/macOS 真机未验证。
