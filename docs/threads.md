# 远端线程操作 API

线程是一段可接着跑的会话（LangGraph `threads.py` 借鉴，G-P1-37）：建一个
线程、往里写状态、跑工作流、把结果记回线程，下次接着跑。手机 / 远端调
网关的 `/api/threads`，本机调 `nyra thread`，走的是同一份账本
（`~/.nyra/threads.json`，0600 原子写，损坏先备份再报错）。

## 线程里有什么

- `id`：16 位 hex，建线程时生成。
- `title`：标题（≤ 100 字）。
- `status`：`active`（进行中）或 `archived`（已归档；归档后 cron 不再跑）。
- `state`：状态对象，只认标量值（字符串 ≤ 1000 字、数字、布尔值、
  `null`）；键不超过 32 个。`state` 里不要放对话原文与密钥。
- `history`：历史摘要（每条 `{at, kind, summary}`，摘要 ≤ 500 字，
  最多 200 条）；只记摘要，不记对话原文。
- `runs`：线程上跑过的工作流（`{run_id, workflow, status, at}`，
  最多 100 条）。
- `crons`：绑的定时触发器（`{id, cron, workflow, last_fired}`，
  一个线程最多 10 条）。

## CLI

```sh
nyra thread create "每周店铺复盘"
nyra thread list
nyra thread search 复盘
nyra thread show <线程 id>
nyra thread copy <线程 id>              # 复制接着跑：只复制状态与历史，不复制运行记录与 cron
nyra thread prune <线程 id> --keep 50   # 剪掉旧历史，只留最近 50 条
nyra thread state <线程 id>             # 看状态
nyra thread state <线程 id> --set week=12 --set done=true --unset draft
nyra thread history <线程 id> --limit 20
nyra thread runs <线程 id>
nyra thread cron-add <线程 id> "0 9 * * 1" weekly-review   # 给线程绑 cron（create_for_thread）
nyra thread cron-remove <线程 id> <cron id>
nyra thread crons <线程 id>
nyra thread archive <线程 id>
nyra thread remove <线程 id> --yes
```

## 线程 cron（create_for_thread）

`cron-add` 给线程绑一条定时触发器：到点跑指定的工作流，运行 id 与
结果记回线程（`runs` 与 `history`），成功那次再把 `thread_cron_fired`
事件镜像进那次工作流运行的事件链。触发记录进证据链
`evidence/thread-crons/<日期>.jsonl`。

安全闸（与工作流触发器共用）：

- 触发器执行总开关默认关，须 `nyra workflow triggers enable --yes`
  显式开启，否则线程 cron 一条都不跑；
- 只跑 `active` 的工作流，不存在或不是 `active` 的跳过（记 skipped）；
- 每轮最多跑 5 条；同一分钟不重复跑；
- 复制线程不复制 cron——复制的 cron 会让同一工作流一分钟跑两次。

守护进程每轮顺带跑到点的线程 cron；手动跑一轮用
`nyra workflow triggers run`（工作流触发器与线程 cron 一起跑）。

## 网关 API（远端调）

都在 `/api/threads` 下，与 `/api/*` 同款鉴权（`X-Nyra-Token`）：
读接口认任何已鉴权调用方；**写接口只认机主（owner）与设备 token，
账号 user 角色只读**，调写接口直接 403。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/threads?q=&status=` | 列线程（只给元数据，可按标题/id 搜、按状态筛） |
| POST | `/api/threads` | 建线程（`{title, state?}`） |
| GET | `/api/threads/:id` | 看线程详情 |
| POST | `/api/threads/:id/copy` | 复制线程 |
| POST | `/api/threads/:id/prune` | 剪历史（`{keep?}`，默认 50） |
| GET | `/api/threads/:id/state` | 看状态 |
| PUT | `/api/threads/:id/state` | 合并写状态（`{patch}`，`null` 表示删键） |
| GET | `/api/threads/:id/history?limit=` | 看历史 |
| GET | `/api/threads/:id/runs` | 看线程上跑过的工作流 |
| POST | `/api/threads/:id/archive` | 归档 |
| POST | `/api/threads/:id/unarchive` | 取消归档 |

不存在的线程 id 返回 404，其余参数错误返回 400。

## 已知局限

- 线程是本机账本 + 网关 HTTP 接口，不是真云端服务：手机调的是家里
  电脑的网关（第 6 批的云端同步另算）；真云端部署须等云计算器的
  商业决策。
- 线程 cron 跑的是工作流（`runWorkflowByName`），不是“在线程里续跑
  agent 对话”；对话续跑仍走会话（`nyra session` / 网关会话）。
- Windows/macOS 真机未验证。
