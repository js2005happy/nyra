# 手机端 Cue 式界面（Cue 方向 B 批）

往 Manus Cue 的手机端靠齐的第一步：探索页、个人页、邀请制、Bot Mode 开关。
都在网关的手机页 `/m` 里，不在启动器页（启动器页只是连电脑的入口，本批没动）。

## 诚实边界（先读这段）

- 手机端现在只是启动器壳，**唯一能走通的是连家里电脑**（同 Wi-Fi + 配对码，
  见 `mobile/README.md`）。云端后端未部署，手机页 `/m` 只在局域网里能打开。
- **钱包、电话只是入口**：点进去只说“即将推出”，没有真功能。
- **邮箱入口不假装能用**：Gmail 收发闭环仍在排查，入口原样显示这个状态。
- **邀请码现在不能兑现注册**：云端登录后端未部署，账本只记码和名额，等云端
  上线后启用。
- 本批只在临时 home / 假 provider 上验过；真模型没跑；真机未验证。

## 探索页

底栏“探索”：6 张任务模板卡片，内容按 Cue 截图里的来：

| 模板 | 干什么 |
| --- | --- |
| 寄包裹 | 帮你寄个包裹 |
| 寻找出租房 | 找一处合租/整租房 |
| 找显示器 | 挑一台显示器 |
| 补满冰箱 | 按你的清单补货 |
| 一起省钱 | 看看这个月哪里能省 |
| 预订票 | 订机票 / 火车票 / 演出票 |

点模板后先选房间，在群聊里开一轮执行（`POST /api/groups/:id/messages`，
`async: true`，走已有的群聊发消息接口）。模板只是开场白：提示词要求 Bot
先问清缺的信息（地址、预算、日期……）再动手，**不编地址、价格、班次、
房源，不编执行结果**。

接口：`GET /api/mobile/explore`（模板列表，中英双语标题/副标题/提示词，
见 `src/mobileExplore.ts`）。

## 个人页

底栏“我的”：六个入口 + 邀请区。

| 入口 | 接的是什么 |
| --- | --- |
| 用量 | 用量账本 `budgetSummary()`：本月已花、上限、重置时间 |
| 钱包 | 入口，点进去“即将推出” |
| 应用 | 已接的 MCP 预置 / 连接器状态（`settingsView().mcp.servers` + Gmail 状态） |
| 邮箱 | Gmail 状态原样：`configured` 只表示密码箱里有条目，**不等于收发已通**；收发闭环仍在排查 |
| 电话 | 入口，点进去“即将推出” |
| 技能 | 已装技能数（`info().skills`） |
| 电脑 | 网关运行状态 + 已配对设备数（`info()` + `devices.listDevices()`）；云端未部署 |

接口：`GET /api/mobile/profile`（一次聚合上面全部 + `botMode` + `invites`）。

## 邀请制

与缺口 48（每 Bot 数字身份）挂钩。机主共 **5 个名额**（按 Cue 截图“5 个
邀请名额已用完”取的数）。

- `nyra invite create [--note <备注>]`：发一个 6 位邀请码（去掉易混的
  0/O、1/I/L），占 1 个名额；名额用完拒绝。
- `nyra invite list`：名额（已用/剩余）与记录。
- `nyra invite revoke <码>`：吊销，释放名额。
- 账本落盘 `~/.nyra/invites.json`（0600、原子写，损坏回落空账本）。
- **没有兑现**：云端登录后端未部署，兑现不了就不写假的 redeem 接口。
- 个人页的邀请区也能发码 / 吊销 / 看名额，接口 `GET|POST /api/mobile/invites`
  与 `POST /api/mobile/invites/:code/revoke`（返回里 `cloudReady: false`）。

## Bot Mode 开关（Hermes 缺口 7）

群聊会话的启用 / 停用配置，CLI 与手机端共用同一个配置源
`~/.nyra/group-bot-mode.json`（0600、原子写；缺文件或坏文件时 fail-open，
默认开，与 Hermes 默认开启一致）。

- CLI：`nyra group bot-mode <on|off|status>`。
- 手机端：设置页“群聊”分区里的开关（接口 `GET|POST /api/mobile/bot-mode`）。
- 关了拦两个入口：群聊会话轮次 `runSessionRound`（CLI `group session send` +
  `group_session_send` 工具）与房间 swarm 聊天 `GroupStore.send`（CLI
  `group chat send` + 网关 /m 群聊页）——手机上“群聊”就是房间，只拦会话
  会让手机上的开关看起来是假的。关了时两处都抛同一句：
  “Bot Mode 已关闭：群聊不跑 Bot 轮次（nyra group bot-mode on 重新打开，
  或在手机设置页打开）”。

## 底栏

手机页底栏从 4 个加到 6 个：对话 / 待你决定 / 探索 / 自动化 / 我的 / 设置。
