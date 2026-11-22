# Bot 方向：Telegram + Discord + Slack + WhatsApp 渠道（Phase 1 骨架 + Phase 2 角色与审批 + Phase 3 推送与附件）

用户 2026-11-20 给的双场景架构：场景 A（外部社群/客服/办公 IM Bot）
与场景 B（个人/业务自动化监控与任务 Bot）复用同一套 Bot Core（会话
队列 + 幂等去重 + 权限策略 + 模型/工具执行 + 成本计量）。Phase 1 做
了核心骨架 + Telegram 渠道；Phase 2 做了 router（角色与工具白名单）
与 approvalBridge（聊天内审批）+ 用量硬顶；Phase 3 做了场景 B 的主
动推送（notifier：Heartbeat 静默巡查 + Watch 文件变化 + 任务结果推
送）与附件处理（文本文档提取、图片只记元信息）。2026-11-21 新增
Discord 渠道（Gateway 收消息 + REST 发消息）、Slack 渠道（Socket
Mode 收事件 + Web API 发消息，含审批按钮闭环）与 WhatsApp 渠道
（Cloud API 发消息 + webhook 收消息）。**常驻多渠道网关见
[`docs/channels.md`](channels.md)**（缺口 27）：四个渠道一个进程跑着，
入站消息先过 bindings 确定性路由再交给对应的 Bot（每条绑定一个
BotRunner、一个沙箱档位），路由决定进 `bot-audit.jsonl` 证据链；单渠道
前台跑仍用下面的 `nyra bot <渠道> start`。

## 快速开始

### 每 Bot 一台持久电脑（缺口 42 第一批）

每个 Bot（Soul 身份）有一台自己的持久电脑：自己的工作目录、自己的
浏览器配置与登录态、自己的 shell。详见 [`docs/bot-computer.md`](bot-computer.md)——
创建（`nyra bot computer create --agent <Soul>`）、休眠/唤醒、凭证 Vault、
隔离分级（默认独占；共享须用户显式 opt-in，默认只读、写操作须经审批）、
资源上限（内存声明超系统 80% 时创建直接拒绝）。

### Bot 与电脑（缺口 42 第二批：BotRunner 接线）

Bot 启动时按 config 的 `bot.agent`（默认 `nyra`）绑上自己那台电脑
（`src/bot/binding.ts` 的 `resolveBotComputer`）：

- 已有电脑 → 直接用；有 Soul、没电脑 → 自动建一台（默认 1024 MB /
  50% / 15 分钟，建电脑自带 `computer.created` 活动）；没 Soul → 不接，
  启动时打一条提示（跑 `nyra soul init <agent>` 与
  `nyra bot computer create --agent <agent>` 接入），任务照常在启动目录跑。
- 绑定在 BotRunner 构造时定死，运行中换电脑要重启 Bot。
- Agent 的工作目录就是电脑的 workspace（`agentWorkdir`）：Agent 自带的
  shell 工具、读写文件的工具都落在电脑的 workspace 里。消息到了先唤醒
  休眠的电脑（唤醒失败不挡任务），跑完记一笔 `task.run` 活动（只记会话
  key、花费与成败，不记用户原文）；取消的任务不记。闲置到点的电脑由
  BotRunner 每 5 分钟扫一次休眠（`sweepSleepDue()`，与
  `nyra bot computer sleep-due` 同款逻辑）。
- `nyra bot status` 里本 Bot（`bot.agent` 相同）的电脑行带
  “（本 Bot 的电脑）”标注；启动行也写清绑的是哪台电脑（未接时写“未接”）。

聊天里的 `/computer-shell`（只机主/管理员；确定性指令，不走模型）：

```
/computer-shell <电脑 id|own> <命令...> [--cred <账号> ...]
```

`own`（也认 `me` / `mine`）指 Bot 自己那台电脑；别的 id 须是合法电脑 id。
跨电脑写操作走 `checkComputerAccess`：deny 直接拒绝（不建审批）；ask
走 approvalBridge 审批（批了才跑，批的人记进 `shell.run` 的
`approvedBy`）；allow 直接跑。`--cred` 把 Vault 里该账号的凭证代填进沙箱
环境变量 `NYRA_CRED_<账号>`（命令里用 `$NYRA_CRED_<账号>` 引用）；回显前
把代填的明文脱敏成 `***`，绝不把明文发回聊天（群聊里其他人也看不到）。
注意：Agent 在 workspace 里的自由工具调用不经过 `computer.ts`，由正常
运行证据（events.jsonl）覆盖；确定性电脑动作（shell、凭证、生命周期、
task.run）才进活动账本与运行事件。

### Telegram

1. 在 Telegram 里找 @BotFather，发 `/newbot`，按提示起名字，拿到 token。
2. 把 token 存好（二选一，绝不写进配置文件）：
   - 环境变量：`TELEGRAM_BOT_TOKEN=<token>`；
   - 或密码箱：`nyra vault add TELEGRAM_BOT_TOKEN`（交互输入；没解锁密码箱时
     进 `~/.nyra/keys.json`，0600）。
3. 启动轮询：`nyra bot telegram start`（前台跑；Ctrl+C 或
   `nyra bot telegram stop` 停止）。查看状态：`nyra bot telegram status`。

### Discord

1. 到 Discord 开发者门户（discord.com/developers）新建 Application → Bot，拿到 token。
2. **开启 Message Content Intent**（Bot 页面 → Privileged Gateway Intents），否则
   读不到消息正文（Discord 2022-08 起这是 privileged intent）。
3. 用 OAuth2 → URL Generator 把 bot 邀请进你的服务器（scope `bot`，权限至少
   `Send Messages` + `Read Message History` + `View Channels`）。
4. 存 token（同 Telegram）：环境变量 `DISCORD_BOT_TOKEN` 或 `nyra vault add DISCORD_BOT_TOKEN`。
5. 启动：`nyra bot discord start`；状态 `nyra bot discord status`。

### Slack

Slack 走 Socket Mode（官方为「无公网回调」场景的方案，家里电脑也能跑），
需要两个 token：

1. 到 Slack 后台（api.slack.com/apps）新建 app。
2. **开 Socket Mode**：Settings → Socket Mode → Enable，拿 **app-level token**
   （`xapp-…`）。这是连 Socket Mode、收事件用的。
3. **建 Bot User**：Bot Users → 加一个 Bot，拿 **bot token**（`xoxb-…`）。这是
   发 / 编辑消息用的。
4. 给 bot token 配 scope（至少 `chat:write` + `channels:read`，私聊 `im:read`）；
   订阅事件（app_mention、message.im）。
5. 存两个 token（二选一，绝不写进配置文件）：
   - 环境变量：`SLACK_APP_TOKEN=<xapp-…>` 与 `SLACK_BOT_TOKEN=<xoxb-…>`；
   - 或密码箱：`nyra vault add SLACK_APP_TOKEN`、`nyra vault add SLACK_BOT_TOKEN`
     （交互输入；没解锁密码箱时进 `~/.nyra/keys.json`，0600）。
6. 启动：`nyra bot slack start`；状态 `nyra bot slack status`。

Slack 渠道只接三类消息：群里 `app_mention`（有人 @ 了 Bot）、私聊
`message.im`，以及审批按钮回调 `block_actions`（审批卡的批准/拒绝按钮）。
群里的普通闲聊不接（避免把所有话都吃进模型）。与 Discord 的 Gateway 不
同，Socket Mode 不需要应用层心跳（WebSocket 协议层 ping/pong 兜底）、没
有 sequence/RESUME——断了就拆掉重新 `apps.connections.open` 拿新 URL 重连。

Slack 的审批闭环：审批提示以 Block Kit 消息发出（带「批准 / 拒绝」两个
按钮，value 沿用 `bot:approve:<id>` / `bot:reject:<id>`），审批人点按钮 →
`block_actions` 交互事件经 Socket Mode 推来 → 归一化成 `/approve <id>` 指令
走与 Telegram 按钮同一条 `decide()` 链路；`answerCallback` 经 WebSocket 回
`interaction` ack 消掉客户端转圈。与 Telegram 唯一的区别是 ack 走 Socket
Mode 信封而非 REST，主链路零改动。

### WhatsApp

WhatsApp 与前三个渠道有一个**关键不同**：Cloud API 收消息没有官方轮询或
Socket Mode 等价物，Meta 只通过 **webhook**（HTTPS POST 到你的公网回调
URL）推消息。所以 WhatsApp 渠道不能像前三个那样在「家里电脑」上直接跑通
收消息，需要一个公网 HTTPS 入口（ngrok / Cloudflare Tunnel，或部署到有
公网域名的机器）把 Meta 的请求转发进适配器的 `handleWebhook`。

1. 到 Meta 开发者后台（developers.facebook.com）建 WhatsApp 应用，拿
   **system user access token** 与 **号码 id**（Phone Number ID）。
2. 存两个凭证（二选一，绝不写进配置文件）：
   - 环境变量：`WHATSAPP_ACCESS_TOKEN=<token>` 与
     `WHATSAPP_PHONE_NUMBER_ID=<号码 id>`；
   - 或密码箱：`nyra vault add WHATSAPP_ACCESS_TOKEN`、
     `nyra vault add WHATSAPP_PHONE_NUMBER_ID`。
3. 配 webhook：把公网入口（隧道/部署）的 URL 填进 Meta 后台的 callback URL，
   配 verify token，完成 `hub.challenge` 握手；公网入口把 Meta 的 GET（握手）
   转发给 `verifyWebhook`、POST（消息）转发给 `handleWebhook`（带
   `X-Hub-Signature-256` 验签）。
4. 启动：`nyra bot whatsapp start`；状态 `nyra bot whatsapp status`。

WhatsApp 只接两类消息：私聊文本（免 @）与群聊文本（`chatType=group`；
WhatsApp 群聊没有「@ 机器人」机制，`isMentioned` 恒 false，靠文本匹配）。
按钮回发（interactive 的 button_reply / list_reply）取标题当正文。发消息走
`/{phone_number_id}/messages`，编辑退化为补发（Cloud API 不支持改已发消息）。
行内审批按钮（interactive button）未接，审批提示里的 `/approve <id>` 指令
可直接回复。

## 消息处理主链路

```
Telegram getUpdates 长轮询 / Discord Gateway 事件 / Slack Socket Mode 事件 / WhatsApp webhook
  → 归一化 InboundMessage
  → 幂等去重（messageId，落盘，重启后仍有效）
  → 群聊 @ 过滤（mentionOnly 默认开，没 @ 直接忽略；指令同样要过这道门）
  → 确定性指令优先（/help、/status、/new、/stop、/model、/approve、/reject、/computer-shell）
  → 配额（单用户/天、单群聊/分钟、当天 token 预算）
  → 月度硬顶预检（超了直接回绝，不调模型）
  → 附件处理（Phase 3：文本文档提取进上下文，图片只记元信息）
  → 会话排队（同一 sessionKey 串行，不同会话并行）
  → 先发“处理中…”占位 → Agent 执行（画像定 mode）→ 分片回发（编辑占位 + 续发）
（另有一条不进主链路的推送线：notifier 的 Heartbeat 巡查 + Watch +
任务结果推送，见下文“Phase 3：主动推送”。）
```

会话 key：群聊按 `telegram:<chatId>:<threadId>`，私聊按
`telegram:<senderId>`。会话历史与长期记忆按这个 key 隔离（Agent 的
会话文件 id 是 `bot-telegram-…`，不含 `:`，过 sessionPath 校验）：
A 用户的上下文绝不进 B 用户的 Agent。

## 确定性指令（不走模型、不扣 token、不计配额）

| 指令 | 作用 |
|---|---|
| `/help` | 帮助：命令列表与限制 |
| `/status` | 运行状态、队列深度、今日与本月花费 |
| `/new` | 开新会话（清除当前会话历史） |
| `/stop` | 停止当前正在处理的任务 |
| `/model` | 当前用的模型 |
| `/approve <id>`、`/reject <id>` | 放行/拒绝一条挂起的审批（Phase 2 接真逻辑；只有 owner/admin 能批，非白名单的放行无效并记审计） |
| `/computer-shell <电脑 id\|own> <命令...> [--cred <账号> ...]` | 在一台电脑上跑 shell（只机主/管理员；own 是 Bot 自己那台电脑；跨电脑写操作须审批；--cred 代填 Vault 凭证，回显脱敏） |

群聊里发指令也要先 @ Bot（mentionOnly 的规矩对指令同样适用）。

## Phase 2：角色与聊天内审批

### 角色表（按 senderId 认人：owner > admins > members > 默认 guest）

| 角色 | 能用的工具 | 能发起审批 | 能批准审批 | 步数/超时 |
|---|---|---|---|---|
| owner（机主） | 全部工具（除 `browser_*`、`computer_*` 前缀） | 是 | 是 | 按配置 |
| admin（管理员） | 只读工具 + `write_file`、`edit_file`、`plan`、`memory_append`（不给 shell） | 是 | 是 | 按配置 |
| member（受信任用户） | 只读工具 | 否 | 否 | 按配置 |
| guest（默认外部用户） | 只读工具 | 否 | 否 | 最多 6 步、60 秒 |

角色只定默认画像：`profiles` 能覆盖各角色的系统提示词、最大步数与
超时；能不能发起/批准审批是硬边界，配置改不了。按 chatId 的系统提
示词（`chat_system_prompts`）优先于按角色的——特定群聊可以有自己的
Bot 人设。画像变了重建 Agent（会话记忆还在，换的是 mode 与工具集）。

白名单是两道门：Agent 构造时不在白名单的工具直接从 schema 里拿掉
（`disabledTools`），模型看不到也调不到；审批层再拦一次——写操作进
`approveFn` 前先查白名单，不在白名单的直接拒绝、不建审批。

### 审批流程（approvalBridge）

1. owner/admin 的 Agent 要做写操作时，`approveFn` 先在白名单里查一
   遍，通过后建一条挂起审批（`approvalBridge.requestApproval`），向当
   前会话（或 `approval_chat_id` 指定的审批人私聊）发提示：审批 id、
   工具、风险说明、参数摘要（只记参数指纹 `args_hash`，不记原文），并
   附行内按钮「批准」「拒绝」。
2. 审批人回 `/approve <id>` / `/reject <id>`，或点按钮（Telegram
   callback query，本批只认 `bot:approve:<id>` / `bot:reject:<id>`
   两种回调）；放行前校验审批人是否在 owner/admin 白名单内——非白
   名单的放行无效，挂起项还在，并记审计。
3. 挂起动作超时（默认 60 秒，`approval_timeout_ms` 可改，夹在 5 秒到
   10 分钟之间）自动拒绝并记审计；`/stop` 或会话取消时，同会话的挂
   起审批一并取消。
4. 结论写两处：`~/.nyra/bot-audit.jsonl` 一行审计（只记结论，不记用
   户原文），与运行事件 `bot_approval_requested` /
   `bot_approval_decided`（已注册进 `EVENT_FIELDS`）。`/status` 能看
   到当前挂起审批数。

### 用量硬顶（审批绕不过配额）

- 执行前先做月度硬顶预检（本月已花 ≥ 上限直接回绝，不调模型）；
  单次硬顶走 Agent 自带的 checkCost；高频触发仍走 Phase 1 的三档配
  额（单用户/天、单群聊/分钟、当天 token 预算），审批放行不绕过配额。
- 拒绝的审批不扣 token（只记审计与事件）；放行后执行的花费照常进
  用量账本（delta 制，与 CLI 同口径）。

## Phase 3：主动推送（notifier）+ 附件处理

### 主动推送（场景 B）

notifier 默认全关，三个条件缺一个就不推：`bot.notifier.enabled`
显式开 + 配了 `bot.owner`（只有机主能开）+ 配了
`bot.notifier.target_chat_id`（推去哪个会话：私聊填 owner 的用户
id，群聊填群 id）。推三类东西，内容只写结论与数字，不含用户原文
与文件内容：

- **任务结果**：定时任务（`nyra schedule daemon` 跑的）与队列任务
  （`nyra task worker` 跑的，含事件触发进队列的任务）跑完后推送。
  `notify_tasks` 决定推什么：`failures`（默认，只推失败）、`all`
  （成功也推）、`none`（不推）。
- **Heartbeat 静默巡查**：Bot 轮询进程里按
  `heartbeat_interval_ms`（默认 5 分钟）巡查一次，无异常不打扰，
  有异常才推：本月花费达到上限的 `monthly_spend_warn_ratio`（默认
  0.8）或已用完、当天 token 预算用完、会话队列积压超过
  `queue_depth_warn`（默认 5 条）、有审批超过
  `pending_approval_warn_minutes`（默认 10 分钟）没人批。同一条件
  在 `notify_cooldown_ms`（默认 1 小时）内只推一次，条件升级（如月
  度比例从 0.8 档升到用完）立刻再推。
- **Watch 文件变化**：`watches` 里每个监控项是一条 `{id, label,
  file}`，文件内容哈希变了就推一次「监控目标「label」发生了变化」，
  只报“变了”，不含文件内容、不读内容进推送；第一次见到文件只记基
  线，不推。状态落盘 `~/.nyra/bot-notify-state.json`（0600、原子写）。

每次推送记一行 `bot-audit.jsonl`（`notify:<kind>`）与运行事件
`bot_notify_sent`；Watch 变化另记 `bot_watch_changed`（只记前后哈
希）。网关内置的定时任务守护（`gw schedule`）本批不接 notifier，
任务结果推送只走 `nyra schedule daemon` 与 `nyra task worker` 两个
进程——网关进程里跑的任务结果仍进审阅队列与收件箱，不推 Telegram。

### 附件处理

- 图片（PNG/JPEG/WebP/GIF，按 magic bytes 认，不信扩展名）：下载后
  只记元信息（尺寸、大小），**本批没有接视觉模型**，回复里老实说
  “暂不支持看图”，不进模型、不假装看懂。
- 文档：只提取纯文本类（.txt/.md/.json/.csv/.log/.yaml/.yml），内
  容拼进发给 Agent 的提示词（单个文档最多取
  `attachment_text_chars` 字，默认 20000，超了截断并注明）；pdf、
  docx、可执行文件等一律不碰、不解析、不执行。
- 上限与失败：单个附件超过 `attachment_max_bytes`（默认 10MB）直接
  跳过；一条消息最多处理前 5 个附件；下载失败、超限、类型不在白名单、
  空文件都回一句明确说明，不静默丢弃。附件下载走 `getFile` 拿到的临
  时地址，处理完立即删临时文件（临时目录 `mkdtemp`，0600），不落盘
  留痕；附件处理在配额与月度预检之后，光发附件绕不过限额。

## 配额与成本

默认配额（config.json 的 `bot` 一节可改）：

- 单用户每天最多 100 条进模型的消息；
- 单群聊每分钟最多 10 条；
- 当天 token 预算默认不设（`daily_token_budget_usd: null`）。

用量记进现有用量账本（与 CLI 同口径：provider 实报 token + 已配单价
才算钱，算不出不挡人）；月度硬顶与单次硬顶走 Agent 自带的 checkCost，
超了直接中止（与 CLI 同一条诚实边界）。模型兜底链不进 Bot：只用主
provider，绝不自动换模型。

## 安全边界

- Bot token 只从环境变量或密码箱读，绝不硬编码、不记日志、不记审计；
  报错里只写方法名与 HTTP 状态（URL 里含 token，绝不能进错误文案）。
- 外部用户默认只读：guest/member 的 Agent mode 写死 `readonly`，只
  能问答与查询；owner/admin 的写操作逐次走聊天内审批（Phase 2），
  白名单外的工具模型看不到也调不到，审批层再拦一次。
- 审批拒绝绝不重试：审批拒绝曾是“错误字符串”进幂等重试，重试时
  `idempotentRetry` 短路跳过审批、把拒绝过的写操作执行了（Phase 2
  修，见 `isApprovalRefusalResult`；回归测试
  `test_approval_refusal_never_retries` 盯着）。拒绝后模型只看到一
  句“用户拒绝执行”，可以换做法继续，不会静默执行。
- 去重与配额记录在 `~/.nyra/bot-dedup.json` / `~/.nyra/bot-quota.json`
  （0600、原子写）；每条处理过的消息写一行 `~/.nyra/bot-audit.jsonl`
 （只记 channel、sessionKey、messageId、结论、字数、花费，不记用户原文）。
- 附件下载到临时目录处理完即删（不落盘）；图片不进模型（无视觉接线，
  只记元信息）；文本文档提取的内容进 Agent 上下文，超长截断并注明。
- 主动推送默认全关（须显式开 + 配 owner + 配目标会话）；推送只写结
  论与数字，不含用户原文与文件内容；Watch 只记哈希。

## 配置（config.json 的 `bot` 一节）

```json
{
  "bot": {
    "enabled": false,
    "mention_only": true,
    "max_turns": 12,
    "timeout_ms": 120000,
    "per_user_daily_limit": 100,
    "per_chat_per_minute_limit": 10,
    "daily_token_budget_usd": null,
    "admins": [],
    "owner": null,
    "members": [],
    "approval_timeout_ms": 60000,
    "approval_chat_id": null,
    "chat_system_prompts": {},
    "profiles": {},
    "notifier": {
      "enabled": false,
      "target_chat_id": null,
      "heartbeat_interval_ms": 300000,
      "notify_cooldown_ms": 3600000,
      "notify_tasks": "failures",
      "monthly_spend_warn_ratio": 0.8,
      "queue_depth_warn": 5,
      "pending_approval_warn_minutes": 10,
      "watches": []
    },
    "attachment_max_bytes": 10485760,
    "attachment_text_chars": 20000,
    "telegram": { "enabled": false, "username": null }
  }
}
```

`admins` 是管理员的 Telegram 用户 id（数字 id，不是 @用户名），留给
Phase 2 的审批指令认人；`owner` 是机主的 id（只认一个），`members`
是受信任用户 id 列表。`approval_timeout_ms` 是挂起审批的超时（默认
60 秒，夹在 5 秒到 10 分钟之间，超时自动拒绝）；`approval_chat_id`
为空时审批提示发在当前会话，填了则发到指定审批人私聊。
`chat_system_prompts` 按 chatId 覆盖系统提示词；`profiles` 按角色
覆盖系统提示词、最大步数与超时（例：`"profiles": {"guest":
{"maxTurns": 4}}`）。`timeout_ms` 是单条消息从入队到出结果的超时
（默认 120 秒；超时按取消处理）。
`team`（GROK 批，新缺口 52）：团队名或 id，配了它 Bot 就跑在该团队里——Bot 只能是该团队的参谋长或成员（启动时校验，不在团队里直接拒绝启动），且须有完整 Charter；团队模式下 Bot 的对外动作一律回参谋长/人批（详见 `docs/team.md`）。不配时 Bot 是单机，行为不变。
`notifier` 一节（Phase 3，见上文“主动推送”）：`enabled` 默认 false；
`target_chat_id` 是推送目标会话的 id；`heartbeat_interval_ms` 默认
300000（5 分钟，夹在 60 秒到 1 小时之间）；`notify_cooldown_ms` 默认
3600000（1 小时，夹在 60 秒到 24 小时之间）；`notify_tasks` 是
`failures`（默认）/`all`/`none`；`monthly_spend_warn_ratio` 默认
0.8（夹在 0.1 到 1 之间）；`queue_depth_warn` 默认 5；
`pending_approval_warn_minutes` 默认 10；`watches` 是
`{id, label, file}` 的列表（`file` 须是绝对路径）。`attachment_max_bytes`
默认 10485760（10MB，夹在 1KB 到 50MB 之间）；`attachment_text_chars`
默认 20000（夹在 1000 到 100000 之间）。

## 已知局限（诚实边界）

- 真实 Telegram Bot 未接通：token 须用户在 @BotFather 建机器人后提供；
  轮询与审批按钮只在本地用假 Telegram API 验过。
- `/stop` 与超时现在会真中断在跑的模型调用：取消信号从 Bot 队列传给
  `Agent.run(text, { signal })`，一路到模型请求（abort）、工具执行与子
  进程（kill），确认停下后才释放执行槽位（见 `docs/cancellation.md`）。
  Bot 侧仍保留 Promise.race 作安全网与取消清理：排队中的任务直接出队；
  在跑的任务取消后 Agent 实例丢弃、挂起审批一并取消、会话文件按取消前
  的快照恢复（取消瞬间恢复一次，后台调用结束后再恢复一次；若期间已有
  新任务，不恢复，以免抹掉新进度）。
- 超长回复按 4000 字符分片；代码围栏切开时自动补收尾/重开围栏。
- 群聊 @ 判定靠 Bot 用户名（启动时 getMe 拿一次）；拿不到时退化为看
  文本里的 @，text_mention 实体在没拿到 Bot id 时宁可漏判也不误判。
- `nyra bot telegram start` 是前台进程（pid 记在
  `~/.nyra/bot-telegram.pid`）；机器重启后要重新启动，常驻化（系统
  服务/守护进程）是以后的一批。
- 附件：图片没有接视觉模型（只记元信息）；pdf/docx 等非纯文本文档不
  解析；网关内置的定时任务守护不推 Telegram（任务结果推送只走
  `nyra schedule daemon` 与 `nyra task worker`）。
- Bot 电脑（缺口 42 第一批）：没有容器后端（缺口 18 未做），隔离靠
  目录 + 权限边界兜底，不是容器级隔离；CPU 上限只记声明、不做 cgroup
  强制执行；浏览器 profile 只管配置与登录态清单，本批不真正打开页面
  （打开页面与看屏幕是缺口 50 的事）；真实 Bot 未接通验证，只在假
  transport 与假浏览器 profile 上验过。
