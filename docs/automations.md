# 自动化 bundle

一次装好整条自动化（OpenHands preset / bundle 借鉴，G-P1-37）：装一个
自动化就同时装好 event 触发器、自带建议触发器、一个线程（状态与历史
落点），以及可选的线程 cron。触发器本身还是已有的 event 触发器
（`docs/event-triggers.md`）与线程 cron（`docs/threads.md`），本
文只讲“一次装好”这一层。

## bundle 里有什么

```json
{
  "id": "deploy-watch",
  "name": "部署完成记一笔",
  "description": "部署完成时记一条部署记录进收件箱。",
  "triggers": [
    { "name": "deploy-done", "source": "webhook", "event": "deploy.done",
      "task": "部署完成：记一条部署记录进收件箱，含版本与时间。", "mode": "readonly" }
  ],
  "suggested_triggers": [
    { "name": "deploy-failed", "source": "webhook", "event": "deploy.failed",
      "task": "部署失败：只读摘要，写进收件箱并标红，不要自动重部署。", "mode": "readonly" }
  ],
  "thread": { "title": "deploy-watch 自动化", "state": { "preset": "deploy-watch" } },
  "thread_crons": [ { "cron": "0 9 * * 1", "workflow": "weekly-review" } ]
}
```

- `triggers`：装好即启用（`enabled: true`）。
- `suggested_triggers`：建议触发器——**装好但默认关闭**
  （`enabled: false` + `suggested: true` 标记），机主看过再开。
  开法：`nyra events enable <名>`，或 `nyra automation suggested` 先看。
- `thread`：给自动化建一个线程，状态与历史落在这里。
- `thread_crons`：给这个线程绑 cron（到点跑工作流）。引用的工作流
  不存在或不是 `active` 时，那条 cron 跳过并记进安装结果的警告里，
  不建悬空绑定；有 `thread_crons` 时须先定义 `thread`。

## 内置自动化

| id | 做什么 |
|---|---|
| `github-pr-triage` | 收到 PR 事件（`github.pull_request`）时只读 triage；issue 评论的 triage 是建议触发器，默认关 |
| `deploy-watch` | 部署完成（`deploy.done`）记一笔进收件箱；部署失败的提醒是建议触发器，默认关，不自动重部署 |
| `gmail-invoice-watch` | 收到主题含“发票”的新邮件（`gmail.new_mail` + `subject_contains: 发票`）时读全文、提取发票号与金额写进收件箱汇报，不付款、不回信 |

事件名都是已有的真实事件名，不编新事件源。

## CLI

```sh
nyra automation list
nyra automation show github-pr-triage
nyra automation install github-pr-triage
nyra automation install ./my-bundle.json   # 从 JSON 文件装自己的 bundle（严格校验，不合格直接拒绝）
nyra automation suggested                  # 列已装的建议触发器
nyra automation remove github-pr-triage --yes
```

安装记录存在 `~/.nyra/automation-bundles.json`（0600 原子写，损坏先
备份再报错），只记 id、名字、触发器名、线程 id，不记触发任务正文。
移除时按安装记录清掉建出来的触发器与线程，不留孤儿；线程建一半
失败时回滚刚建的触发器。

## 已知局限

- bundle 只装 Nyra 已有的触发器形态（event 触发器 + 线程 cron），
  不含 workflow 定义本身：bundle 想定时跑某个工作流，那个工作流须
  先存在且是 `active`（`nyra workflow import` + `activate`）。
- 建议触发器没有“到期自动删”：装好一直留着，机主不用时用
  `nyra automation remove` 整个移除，或 `nyra events remove <名>`
  单独删。
- Windows/macOS 真机未验证。
