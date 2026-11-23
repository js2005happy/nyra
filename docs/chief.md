# 总指挥（第 1 阶段）

手机上把一件事交给**总指挥**：它出一张群聊方案（成员、分工、权限），你增删成员、确认后建群；
总指挥在群里逐个 @成员分派，成员做完交回，总指挥汇总给你。代码标识沿用 `chief`（团队模式里的参谋长），界面统一叫“总指挥”。

## 手机上怎么用

1. **对话**页顶上常驻总指挥卡：在输入框里说你想做成什么，点发送。
2. 进入总指挥页，出一张**方案卡**：默认成员、每人的分工、权限（这一阶段只有“只读”）。
   - 点成员右边的 `−` 移出；点“添加成员”或“调整”打开成员抽屉，勾选进群的人（2–6 个，手机上一个群最多 6 个成员）。
   - 点“确认创建群聊”。
3. 进入**群聊页**：顶部进度条（交回几块 / 正在谁），总指挥的**分派卡**（每位成员一行：@成员、分工、状态、交回的第一句），
   成员交回的消息，最后是总指挥的**汇总卡**（每位成员一行；没交回的写明“没交回”，不编结论）。
4. 群里可以继续发消息，点上方成员胶囊可 @点名；消息异步发出，成员回答逐条进群。

对话列表里，进行中的群聊排在“进行中”，跑完的在“群聊”分组；总指挥卡上显示正在带的群聊。

## 方案怎么出

确定性，不调模型配人：

- 候选成员 = 你已建的团队成员（`nyra team create`，需要 Soul + 完整 Charter；分工取 Charter 的“负责什么”）
  + 群聊默认成员（架构师、开发者、审查员、验收者；带队的是总指挥，所以“组长”不在候选里）。
- 有团队（≥2 个成员）时默认勾团队成员，否则默认勾 3 个默认成员。
- 不同 agent 用不同丸子头像（`src/mascots.ts`）：默认助手是紫色圆形 Nyra，总指挥是唯一浅色带天线的那只，
  其他成员按 id 固定分配，同一个群里不重复。

## 第 1 阶段的边界

- **成员权限只有“只读”**：群成员只看、只分析，不改文件、不跑会改东西的命令（群聊建群本来就只许 readonly）。
  “写入前先问 / 完全访问”的成员权限、群内审批、验收打回、停止与改向属于第 2 阶段，界面上不出现。
- **分派是顺序的**：一次只让一个成员回答；某个成员出错记“没交回”，不影响后面的人。
- 汇总只取每位成员交回内容的第一句，不另调模型写结论。

## 网关接口

全部需要设备 token（`X-Nyra-Token`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/chief` | 候选成员、上限（6）、权限（readonly）、最近的总指挥任务 |
| POST | `/api/chief/proposals` | `{ task, team? }` → 方案（成员、候选、上下限） |
| POST | `/api/chief/groups` | `{ task, members[], team?, title?, start? }` → 建群并在后台分派，回 `{ run, room }` |
| GET | `/api/chief/runs/:id` | 一次总指挥任务（步骤状态、交回摘录、汇总） |
| GET | `/api/groups/:id/view` | 群视图：成员（带丸子）、消息、最近一次总指挥任务、事件游标 |
| GET | `/api/groups/:id/events?since=N` | 群事件流（SSE；`&format=json` 回 JSON）：`chief_started` / `chief_dispatched` / `chief_step_started` / `chief_step_returned` / `chief_step_failed` / `chief_summary` / `group_send_*` / `group_reply` |
| GET | `/api/groups/:id/plans` | 群计划（`src/groupPlan.ts`）+ 本群的总指挥任务 |
| POST | `/api/groups/:id/messages` | 原接口；加 `async: true` 立刻回 202，回答进事件流 |
| GET | `/api/teams` · `/api/teams/:id` | `nyra team` 的团队（参谋长、成员、各自的丸子） |
| POST | `/api/teams/:id/dispatch` | `{ task }` → 过三道门、参谋长拿 lead 租约，起一个 chief 会话（Soul = 参谋长，工具只剩 delegate / delegate_parallel），审批照常进“待你决定”；回 `{ run_id, epoch }` |
| GET | `/api/teams/runs/:id` · `/events` | 团队分派的状态与输出；事件流同会话事件流 |

`POST /api/teams/:id/dispatch` 与 `nyra team dispatch` 共用 `prepareTeamDispatch`（`src/team.ts`）：别的 lead 拿着租约时拒绝（409），不抢。

账本：`~/.nyra/chief-runs.json`（0600 原子写，最多留 200 条）；群消息仍在群聊目录。群事件流在网关进程内存里，重启后从 0 开始（手机端重新拉群视图即可）。

## 诚实边界

只在临时 home、假群成员、假 provider 上验过；真模型下的群分派、团队分派没在真机上跑过。云端账号登录后端未部署，
手机上只能经局域网配对连家里电脑使用总指挥。
