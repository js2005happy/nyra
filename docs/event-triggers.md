# 事件触发任务（缺口 7）

调度器从“到点跑”升级为“有事就动”。两条入口进同一条任务队列：

1. **webhook**：外部服务（GitHub、Slack、任意能发 HTTP POST 的系统）把事件推到网关
   `POST /api/webhooks/:source` → 验签 → 匹配触发器 → 进任务队列；
2. **应用事件源**：本批先做 **Gmail 新邮件轮询**（`gmail.new_mail`），守护进程每轮顺带
   查一次收件箱，新邮件按触发器派发；Slack / 日历等事件源后续按同一模式扩展。

触发只是入队，执行仍走任务队列（`nyra task worker` 跑，或 `nyra task worker --once`
跑一轮）。队列任务的权限规则一点没变：只允许 `readonly` / `auto`，`full` 在触发器
校验层就拒绝；非交互运行时写操作照常挂起等审批（`awaiting_approval`），不自动放行；
成本上限（单次 + 月度）、工具白名单、沙箱全部继承。

## 触发器

存在 `~/.nyra/event-triggers.json`（原子写 0600，损坏先备份成
`.corrupt-<时间戳>` 再报错，不静默丢配置）。

```bash
# GitHub 有新 issue 时，让 agent 先读一遍再汇报（只读，不改代码）
nyra events add --name github-issue-triage --source webhook --event github.issues \
  --task 'GitHub 有新 issue：{{event.summary}}。先读 issue 全文（见下方事件数据），判断是 bug 还是提问，写一段中文摘要到 inbox，不要改代码。' \
  --mode readonly

# 收到标题含“发票”的邮件就触发
nyra events add --name invoice-mail --source gmail \
  --task '收到一封可能含发票的邮件：发件人 {{event.actor}}，主题 {{event.summary}}。用 gmail_read 读全文，提取发票号与金额，写进 inbox 汇报，不要付款、不要回信。' \
  --match-subject 发票

nyra events list
nyra events disable --name github-issue-triage
nyra events remove --name github-issue-triage
```

任务模板占位符：`{{event.type}}`（如 `github.issues`）、`{{event.source}}`
（`webhook` / `gmail`）、`{{event.id}}`、`{{event.actor}}`（谁发的）、
`{{event.summary}}`（主题/标题，前 200 字）、`{{event.payload}}`（事件全文 JSON，
前 4000 字）。

匹配条件（可叠加，全部满足才触发，不区分大小写）：

- `--match-from <子串>`：发件人含该子串（Gmail 事件取发件人；webhook 事件取 sender）；
- `--match-subject <子串>`：主题/标题含该子串；
- `--match-text <子串>`：主题 + 事件全文含该子串。

`nyra events test --name <名> --payload '<JSON>'`：只测匹配、不派发，打印
“匹配：是/否”与渲染后的任务提示词（前 800 字）。`--payload` 里可带 `actor` /
`summary` 字段模拟发件人与主题。

## webhook 入口

`POST /api/webhooks/:source`，来源只允许 `generic` / `github` / `slack`，
请求体必须是 JSON 对象（上限 256 KiB）。事件类型：

- `generic`：`X-Nyra-Event` 请求头，或 body 里的 `event` / `type` / `event_type`
  字段；事件 id 取 `X-Nyra-Event-Id` 请求头或 body 的 `event_id` / `id`，都没有时
  用 body 的 SHA-256 前 32 位（相同 body 重试时去重仍生效）；
- `github`：事件类型取 `X-GitHub-Event` 请求头（触发器里写 `github.push`、
  `github.issues` 这种）；事件 id 取 `X-GitHub-Delivery` 请求头；
- `slack`：`body.type` 为 `url_verification` 时直接回 `challenge`，不派发；
  `event_callback` 时事件类型为 `slack.<event.type>`（如 `slack.message`），
  事件 id 取 `body.event_id`。

成功返回 `202 { accepted: true, dispatched: [{ triggerId, triggerName, runId }],
skipped: [{ triggerId, triggerName, reason }] }`。`skipped` 的原因有：
`duplicate`（同一事件重复投递，返回原 run_id）、`too-many-matches`（单个事件
命中超过 10 个触发器）、`rate-limited`（每分钟派发超过 20 次）。

### 鉴权（缺一不可）

- `generic`：网关 token（`X-Nyra-Token` 请求头，与其他 API 同规则），无 token
  直接 403；
- `github`：`X-Hub-Signature-256: sha256=<HMAC-SHA256>`，密钥存密码箱条目
  `webhook-secret-github`；没配密钥直接 503，不静默放行无签名事件；
- `slack`：`X-Slack-Signature: v0=<HMAC-SHA256>`，签在 `v0:<时间戳>:<原文>` 上，
  时间戳超过 5 分钟直接拒；密钥存密码箱条目 `webhook-secret-slack`。

设密钥（交互输入，绝不要写在命令行里）：

```bash
nyra vault add webhook-secret-github
nyra vault add webhook-secret-slack
```

网关须带 `NYRA_VAULT_PASSWORD` 启动才能读到密码箱里的密钥；没带时 github/slack
的 webhook 一律 503。`generic` 不用密码箱，只认网关 token。

## Gmail 新邮件轮询

守护进程（`nyra schedule daemon`）每轮顺带跑一次轮询，但只有同时满足以下条件才
真的打 Gmail API：存在启用的 `gmail` 来源触发器，且 Gmail 已启用+已授权。
轮询间隔 5 分钟，不到间隔直接跳过（不打 API）。状态在
`~/.nyra/event-sources/gmail.json`（上次轮询时间 + 最近 500 个已见邮件 id）。

- 首轮只建基线：把当前收件箱记为已见，不派发——否则首次启用会把当天旧邮件全派一遍；
- 之后每轮只派发没见过的新邮件（`in:inbox after:<日期>` 查，日期重叠 1 天防漏，
  已见 id 去重）；
- 每封新邮件的事件是 `gmail.new_mail`，发件人进 `{{event.actor}}`，主题 + 摘要进
  `{{event.summary}}`，完整头信息进 `{{event.payload}}`（正文不进事件，
  任务里用 `gmail_read` 再读）。

手动跑一次：`nyra events poll`（强制轮询一次，不受 5 分钟间隔限制）。

每封新邮件派发后，还会顺带触发同名事件的工作流（`docs/workflow.md` 的触发器执行：事件名精确命中、同事件 id 去重、事件 payload 不注进工作流输入；网关 webhook 派发后同样顺带触发）。

## 可审计与幂等

- 每一次触发都在新任务的 `events.jsonl` 里记一条 `event_triggered`（触发器 id/名、
  来源、事件 id、事件类型、任务 run_id、模式、鉴权方式）。事件 id 过长时只记
  SHA-256 指纹（`appendEvent` 会把 32 字以上的类 token 字符串抹掉），完整 id 在
  `~/.nyra/event-deliveries.json`（最近 1000 条投递记录）；
- 同一事件重复投递（webhook 重试、轮询日期重叠）只派发一次，第二次返回原 run_id；
- 触发器文件损坏先备份再报错；投递记录损坏备份后从空开始（投递记录只是幂等账本，
  不是安全控制，不拦派发）。

## 已知局限

- 执行靠任务队列：只配了触发器、没跑 `nyra task worker` 时，任务只会排队不会执行；
  触发器本身不启动 worker（`nyra schedule daemon` 只负责轮询入队）；
- webhook 只认 `generic` / `github` / `slack` 三种来源，日历、Notion 等事件源
  后续按同一模式扩展（缺口 22 的邮件即任务入口是下一步）；
- 轮询是 5 分钟一轮的拉模式，不是 Gmail push：新邮件最晚 5 分钟后才触发，
  且只看收件箱（`in:inbox`），归档/其他标签的邮件不触发；
- 事件内容是不可信外部数据：payload 包 `wrapUntrusted` 再进提示词，摘要只取
  前 200 字元数据；事件里的指令性文字一律不执行，只按触发器任务本身的要求处理；
- 速率限制是进程内计数：网关重启后清零；`nyra events poll` 手动轮询不受
  5 分钟间隔限制，但仍受每分钟 20 次派发上限约束；
- `GET /api/event-triggers` 只返回触发器元数据（id/名/来源/事件/模式/是否启用），
  不含任务提示词（提示词只在终端看）；桌面端连接管理页在 `desktop/`。
