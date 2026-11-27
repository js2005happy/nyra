# 常驻多渠道网关（缺口 27）

一个进程、四个渠道：Telegram、Discord、Slack、WhatsApp。网关常驻跑着，
每条入站消息先过 bindings 确定性路由，再交给对应的 Bot 接——哪个 agent 接、
进哪个沙箱、要不要 @、能不能走云端转写，都是绑定里写明的，不靠模型临场决定。

复用已有的东西，不另起一套：四个适配器是 `src/bot/channels/` 的四个
（Phase 1–3 的 Telegram 骨架 + Discord/Slack/WhatsApp），执行是
`BotRunner`（会话队列、幂等去重、角色路由、审批桥、配额、月度硬顶），
沙箱是 `src/sandbox.ts` 的分级沙箱，语音转写是缺口 15 的 `src/voice.ts`。
本批新写的只有三层：kind 协议（`src/channels/kind.ts`）、bindings 路由
（`src/channels/bindings.ts`）、常驻网关（`src/channels/gateway.ts` +
`src/channels/cli.ts`）。

## 快速开始

```sh
# 1. 配 token（环境变量、密码箱、keys.json 三处都行，见各渠道的 kind）
export TELEGRAM_BOT_TOKEN=...

# 2. 看健康：哪个渠道缺什么一目了然
nyra channels health

# 3. 前台启动网关（Ctrl+C 停；四个渠道一个进程）
nyra channels start

# 4. 另一个终端看运行态
nyra channels status
nyra bot status   # 也有一行网关运行态
```

没配 token 的渠道直接跳过、不报错，网关照常跑其他渠道。一个渠道都没
启动起来时 `start` 直接退出并说明缺什么，不空跑一个没用的进程。

## kind 协议（DSH-3）

借 dsh-superagent 的 SourceKind 形状，不抄它的代码与提示词：一个渠道
一种 kind，每种 kind 声明八个接口（`src/channels/kind.ts` 的
`ChannelKind`）：

| 接口 | 是什么 |
| --- | --- |
| `schema` | 配置校验：字段、必填、格式（token 之类秘密值只报“已配/未配”，不回显） |
| `fields` | 设置表单：给人看的字段定义（内置四种渠道与 schema 相同） |
| `health` | 健康检查条目名（按 kind 加前缀，如 `telegram:token`，不撞保留名） |
| `scope` | 接收范围：私聊全收，群里默认只收 @ |
| `channel` | 收发能力：轮询/webhook、编辑、按钮、语音（只写实测过的适配器能力） |
| `threadContext` | 会话怎么算一个线程（如 `telegram:<chat id>`） |
| `policy` | 策略默认口径：群里默认只响应 @，准入怎么设 |
| `environment` | 运行环境：要不要公网入口、有什么风险 |

四个内置 kind：

- **Telegram**：Bot API 长轮询收消息，不需要公网入口；支持编辑与语音。
- **Discord**：Gateway WebSocket 收消息，REST 发消息；收消息须开 Message Content Intent。
- **Slack**：Socket Mode 收事件，Web API 发消息，审批按钮闭环；两个 token 都要配。
- **WhatsApp**：Cloud API 发消息；收消息靠 Meta 的服务器往公网回调 URL 推
  webhook——没有公网入口就收不到消息，网关不内置 webhook 服务器。
  本渠道用的是 Meta 官方 Cloud API，不是 Baileys 之类的非官方客户端——
  Baileys 有封号风险，Nyra 不用它，也不要把两者的风险混为一谈。
  另注意：用户 2026-11-04 已要求关闭 WhatsApp——本批只做接入形态与
  风险说明，默认不启用，真接通须用户另行点头。

健康检查（`nyra channels health`）：token 缺失与适配器构造失败是 `error`
（须人处理）；最近一次轮询失败是 `degraded`（可能是网络抖动，会重试）；
都没问题是 `ok`。

### 新渠道怎么接（11 步清单）

按 dsh cookbook 的 11 步改成 Nyra 的做法：

1. **事件映射**：定好 Trigger id、Thread id、Channel 地址的拼法——一旦落盘，改了会断开已有记录。
2. **配置**：在 `CHANNEL_KINDS` 里加一份 kind 声明（schema/fields/health 八个接口齐全）；默认配置什么都不收。
3. **消息翻译**：适配器把平台消息转成 `InboundMessage`（机器人自己的消息不产 Trigger；@ 判定按平台实际机制写）。
4. **接收范围**：scope 写清私聊/群聊各收什么；范围外的消息记 filtered 原因，不静默丢。
5. **回复**：Channel 接口写清发消息/编辑/按钮哪些真能做，做不了的别写。
6. **线程上下文**：定好 sessionKey 拼法与同一线程的归属。
7. **准入**：policy 写清默认口径与 admission 表怎么设（见下）。
8. **执行变量**：Agent 执行需要的变量（工作目录、沙箱档位、语音开关）从绑定里取，不读平台侧的状态。
9. **插件入口与轮询**：适配器实现 `ChannelAdapter`（pollOnce + sendText + editText，可选 downloadFile），轮询失败退避 1 秒起、翻倍、上限 30 秒。
10. **注册**：kind 进 `CHANNEL_KINDS`，子命令进 `src/subcommands.ts`，帮助行与 `docs/COMMANDS.md` 同步（docCheck D1/D2 会验）。
11. **测试**：假 transport 覆盖翻译、路由、准入、健康四项；真 token 的验证等用户点头再做。

## bindings 与确定性路由

账本 `~/.nyra/channel-bindings.json`（原子写 0600；损坏先备份再抛错，
不静默重建——与团队账本同口径）。一条绑定：

```sh
nyra channels bindings add --channel telegram --chat 100 --agent nyra \
  --sandbox strict --admission allowlist --allowlist 7,8 \
  --mention-only --priority 10 --note "客服群只接名单里的人"
```

| 字段 | 意思 |
| --- | --- |
| `channel` / `chat` / `sender` | 匹配谁：渠道 + 聊天 id + 发送者 id，`*` 表示任意 |
| `agent` | 接这条消息的 agent（Soul 名） |
| `sandbox` | 绑定级沙箱档位：`strict`（只读断网）/ `standard`（工作目录可写断网，默认）/ `open`（工作目录可写放网） |
| `admission` | 准入：`open` 全接 / `allowlist` 只接名单里的人 |
| `mentionOnly` | 群里是否只响应 @；不填用 kind 的默认口径（默认只响应 @） |
| `voiceCloud` | 语音消息是否允许走云端转写（默认只走本地 whisper.cpp） |
| `priority` | 同具体程度时，大的先赢（0–100） |
| `enabled` | 停用的绑定不参与路由 |

路由是纯函数（`routeInbound`），不读磁盘、不调模型——`nyra channels explain`
可以离线重放任意一条消息的路由决定：

```sh
nyra channels explain --channel telegram --chat 100 --sender 8 --group
# 结论：dropped（bd-xxx，规则 drop:not_in_allowlist）——发送者 8 不在绑定 bd-xxx 的 allowlist 里
# 候选（按匹配排序）：...
```

**匹配规则**：显式绑定按“具体程度 → priority → 创建时间”排序，第一名
命中即接。具体程度分：chat 精确 4 分、sender 精确 2 分、allowlist 非空 1 分。

**准入是三维**（接收范围 × 是否 @ × 是否在名单）：

- 没命中任何显式绑定 → 落到渠道默认绑定（`default:<渠道>`，agent 取
  config 的 `bot.agent`，沙箱 standard，准入 open）。
- 命中但准入失败（不在 allowlist / 群里没 @）→ **直接丢弃并记原因，
  不再落到默认绑定**。显式绑过的范围不许悄悄换 agent 接（fail-closed）。
- 私聊不受 @ 门限制（@ 门只管群）。

**默认绑定的 runner 永远建一个**，否则 fallback 的消息没人接；但它不参与
路由匹配（chat/sender 都是 `*`，放进匹配会抢掉所有消息）。

## 渠道会话默认进沙箱

每条绑定一个沙箱档位，BotRunner 按绑定建、Agent 的沙箱按档位走：

- `strict`：只读 + 断网——最适合公开群聊里接陌生人的消息。
- `standard`：工作目录可写 + 断网——默认档位。
- `open`：工作目录可写 + 放网——只给可信的聊天开。

档位只收紧，不放宽到宿主机直跑。`NYRA_SANDBOX*` 环境变量仍最高
（`resolveSandbox` 的既有口径，绑定档位覆盖的是 config，不是环境变量）。

## 对外发送须审批

路由只决定“谁接”，不决定“能不能发”。对外发送（发消息、付款、删除、
发布）永远走 runner 自己的审批门（approvalBridge + 缺口 51 的业务动作
红线表 + 缺口 28 的 Soul invariant + GROK-6 的信任阶梯），与单渠道
`nyra bot <渠道> start` 同款口径。网关不另开口子。

## 证据链

每条入站消息写一行 `~/.nyra/bot-audit.jsonl`（append-only 0600，
只记 channel、sessionKey、messageId、结论、绑定、规则、原因，不记用户
原文与 token）：

- `routed`——命中哪条绑定、哪条规则；
- `dropped:not_in_allowlist` / `dropped:mention_only`——为什么丢弃；
- `dropped:circle`——发件人没通过信任圈准入（缺口 34：未绑定身份、
  好友不在任何信任圈里、好友已拉黑、账本读失败；只记最小审计，不进
  agent 上下文、不耗 token，详见 `docs/circles.md`）；
- `error:no-runner`——绑定命中了但 runner 不在（建 runner 失败时）。

之后 runner 自己的每条审计记录（ok、blocked、审批结论等）都带
`binding_id`，能与路由决定关联起来。`bot-audit.jsonl` 进 SIEM 导出
第 8 个来源（标签 `bot`，见 `docs/governance.md`）：

```sh
nyra governance audit export --sources bot
```

网关还写一份状态文件 `~/.nyra/channel-gateway-status.json`（每 5 秒最多
写一次）：各渠道 started、token、绑定数、已路由/已丢弃/出错计数、最近轮询时间。
`nyra channels status` 读它。

## 信任圈预过滤（缺口 34）

绑定路由只定“谁接”，信任圈再定“接不接”：路由命中后，网关按发件人
id 查 `circles.json` 里的绑定认出身份，再查准入。圈外消息在网关层
直接丢弃（`dropped:circle`），不进 agent 上下文、不耗 token、不调
模型；圈内照常路由。单渠道 Bot（`startPolling` 循环）用同一套口径，
绕过网关不等于绕过准入。

新接一个渠道时，先跑 `nyra circle owner` 登记机主、再跑 `nyra circle
bind` 绑定每个要放行的好友，否则他们的消息到不了 agent——这是故意
的（默认全封闭），不是 bug。详见 `docs/circles.md`。

## 语音入口：语音指挥

Telegram 的语音消息先映射成 `voice` 附件，再转文字当任务：说一句话、
干完回文字汇报。只转写每条消息的第一条语音（多了说明并忽略）。

- 转写优先本地 whisper.cpp；云端只在绑定显式开 `voiceCloud` 时走。
- 转写失败直接回说明，不进模型；转写出空文本回“没识别出文字”。
- 语音不碰支付与对外发送（缺口 15 的边界，沿用至今）。
- 转写原文不进审计（只记引擎与花费），与转写账本同口径。
- 云端转写的花费按时长估算进配额账本（时长或单价未知时记 null，不编数字）。

目前只有 Telegram 适配器映射了语音消息（Discord/Slack/WhatsApp 的
kind 声明里 `supportsVoice: false`，如实写没实现的功能）。

## 命令

```sh
nyra channels start                     # 前台启动常驻网关（Ctrl+C 停）
nyra channels stop                      # 停掉网关（SIGTERM，等最多 5 秒）
nyra channels status                    # 网关运行态 + 各渠道 token/绑定/路由计数
nyra channels health                    # 各渠道 kind 健康检查
nyra channels bindings list             # 列出显式绑定（+ 隐式默认绑定说明）
nyra channels bindings add ...          # 加一条绑定（见上）
nyra channels bindings remove <id> --yes   # 删绑定（须 --yes）
nyra channels bindings show <id>        # 看一条绑定 + kind 默认口径
nyra channels explain --channel ... --chat ... --sender ... [--mention] [--group]
```

改绑定后网关要重启才认（`nyra channels stop` 后再 `start`）。
`nyra bot status` 也有一行网关运行态。

notifier（Phase 3 主动推送）只在默认绑定的 runner 上开——同一渠道多个
runner 各起一个推送巡查会重复推送。

## 5.4 Telegram 真接口验证（Cue A 批，待 token）

适配器与网关都已实现（`src/bot/channels/telegram.ts`、`src/channels/gateway.ts`），
假 transport 上的测试都过了（`tests/node/test-bot-telegram.test.ts`：收发归一化、
@ 判定、审批按钮回调、API 失败不含 token、空 token 拒绝构造）。只差在真实
Bot 账号上跑通一次。

**用户只需做一步（免费、一次性）**：在 Telegram 里找 @BotFather，`/newbot`
建一个测试 bot，拿到 token（形如 `123456:ABC...`），交给 Nyra 三种方式任选
其一：环境变量 `TELEGRAM_BOT_TOKEN`、密码箱同名条目、或同名文件
（解析顺序就是这个顺序，见 `src/bot/index.ts` 的 `resolveTelegramToken`）。
token 只存密码箱/环境变量，不进日志与事件。

**验证步骤（拿到 token 后）**：

1. `nyra channels health`：Telegram 三项全 ok（token / adapter / poll）。
2. `nyra channels start` 起网关（长轮询，不需要公网入口）。
3. 在 Telegram 私聊里给测试 bot 发一条消息 → 网关路由到指定 Bot → 回一条
   消息，全程进运行记录。
4. 触发一次审批：在 Telegram 里点一次通过、一次拒绝，审批卡闭环。

**当前状态（2026-11-27）**：token 未到。无 token 时 `nyra channels health`
已实测干净报错（Telegram token/adapter 两项 error、poll 一项 ok、exit 0，
不崩溃），不是未验证的空白——缺的是第 1–4 步的真接口跑通。

## 诚实边界

- 真实 Telegram/Discord/Slack/WhatsApp Bot 未接通（token 仍等用户），
  只在假 transport 上验证过；不要催 token。Telegram 真接口验证步骤见上节，
  token 一到就按步骤跑。
- WhatsApp 收消息须公网回调 URL 转发进适配器的 `handleWebhook`，
  网关不内置 webhook 服务器；没配好之前 WhatsApp 只发不收。
- WhatsApp 默认不启用（用户 2026-11-04 已要求关闭），真接通等用户另行点头。
- 路由决定是确定性的，但“哪条绑定该接”是对是错靠人配——配错了绑定，
  消息就会去错 agent，网关不替人审绑定本身。
- 语音转写只在假转写器上验过真流程；真 whisper.cpp 与真云端 STT 未在
  真 API 上跑通（与缺口 15 同款边界）。
- Windows/macOS 真机未验证。
