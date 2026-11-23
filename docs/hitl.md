# 对话转人工坐席（HITL，G-P1-32）

Bot 对外服务时，转人工是兜底项：bot 卡住、答不上来、对方明确要找真人，
对话能转给真人、真人接手、处理完再接回 bot。没有它，bot 卡住就只能干晾着。

## 用法

```sh
nyra hitl start <会话 id> --yes [--reason <原因>] [--assignee <身份>]
nyra hitl takeover <单号>
nyra hitl handback <单号>
nyra hitl cancel <单号>
nyra hitl status [会话 id | 单号]
nyra hitl list [--status pending|active|handed_back|cancelled]
```

## 状态机

```
pending（待接手） ──takeover──▶ active（真人接手中） ──handback──▶ handed_back（已接回 bot）
     │
     └──cancel──▶ cancelled（已取消）
```

- `start`：发起转人工，须 `--yes` 显式确认；同一会话已有进行中的单时拒绝，
  先处理旧单。`--reason` 写原因（最多 500 字），`--assignee` 指定接手人身份。
- `takeover`：真人接手。只认机主或信任圈成员；指定了接手人时只认该身份或机主。
- `handback`：接回 bot。只认接手人本人或机主；接回后 bot 恢复自动回复。
- `cancel`：取消待接手的单。只认发起人或机主；active 的单不能取消，只能接回。

## 转人工期间 bot 不自动回

转人工单 pending 或 active 时，网关 `send()` 不再为该会话起 agent、不调模型：
这条消息只记一个 `hitl_bot_held` 事件，并往收件箱写一条提醒，等真人接手或接回。
账本损坏、状态不明时也不回（fail-closed）。

注意：静默门只接在网关会话路由上。ACP / A2A / AG-UI 服务端的会话用的是
自己的会话命名空间（`acp-<id>`、`agui-server-<thread>`），不在本批覆盖范围；
本地 CLI 跑的任务也不受转人工影响——转人工管的是 bot 对外服务的会话。

## 账本与证据链

- 账本 `~/.nyra/hitl.json`（0600 原子写，损坏先备份再回空账本，最多留 200 条；
  超了丢最旧的已终态单，进行中的单永远保留）。
- 流转记运行事件 `hitl_started` / `hitl_takeover` / `hitl_handback` /
  `hitl_cancelled` / `hitl_bot_held`（只记单号、会话 id 与操作人身份，不记对话原文）。

## 不在本批

- 真人坐席端：没有，真人只通过本地 CLI / 收件箱看到转人工单，不接真实时通讯渠道。
- 自动转人工：不做。转人工只由机主或 bot 显式触发，不自动判定（bot 判断
  “该转人工了”本身就不可靠，误判会把正常对话静默掉）。
- 转人工时的对话上下文同步给真人：真人就在本机，直接读会话记录，不另做同步。
