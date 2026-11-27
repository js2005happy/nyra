# 群聊 swarm / handoff（缺口 G-P1-2）

一个群聊里多个机器人按顺序发言、分工做事（AutoGen 的 swarm/handoff 思路，
只抄机制、不搬实现）。跟 `groups.ts` 的并行轮不同：这里是**顺序发言**，
一次只一个机器人说话。

## 房间与发言模式

```sh
nyra group room create <房间 id> <名字> --bot <机器人 id> [--bot ...] [--provider <服务商>] [--model <模型>]
nyra group room list
nyra group room show <房间 id>
```

每个机器人默认走默认模型；建房时给了 `--provider` / `--model`，房间里所有机器人都用它（进会话后成员也带着走）。三种发言模式：

- `round-robin`：按建房时的顺序轮流说。
- `selector`：上一条消息 `@` 点了谁就谁说，没点名按顺序来。
- `handoff`：上一条消息里的 `HANDOFF: <机器人 id>` 优先于 `@` 点名，
  点谁谁接。

```sh
nyra group chat run <房间 id> --task <任务> [--mode round-robin|selector|handoff]
nyra group chat send <房间 id> <消息> [--rounds <轮数>]
```

## 终止条件：可组合

终止条件可以 AND / OR 组合（CLI 里多个条件默认 AND）：

| 条件 | 意思 |
|---|---|
| `max-messages` | 消息到 N 条就停（默认 20 条） |
| `mention-text` | 消息里出现指定文本就停 |
| `token-budget` | 累计估算 token 到上限就停（估算口径：字符数 / 4） |
| `timeout` | 超过毫秒数就停 |
| `handoff` | 交接给指定机器人就停 |
| `external` | 外部叫停（shouldStop 回调） |

硬顶 1000 轮：再怎么配也跑不过 1000 轮，没上限的群聊不能跑。

```sh
nyra group chat run room-1 --task "分工写周报" --mode handoff \
  --max-messages 20 --mention-text "完成"
```

## 事件

群聊的开始、每轮发言、交接、终止都进运行事件
（`group_chat_started` / `group_chat_turn` / `group_chat_handoff` /
`group_chat_terminated`），只记轮次与终止原因，不记消息原文。
被拦截器丢弃的轮次另记 `group_chat_turn_dropped`（详见
`docs/interventions.md`：bot 回复是总线上的 `publish` 消息，先过拦截器
再进群记录）。

## Jev 式快速决策路由（M2：学 OpenMausBot 的 Jev）

群消息没 @ 谁时，默认所有机器人都回答——人一多就吵。开了 Jev 路由后，
先用便宜模型快速判一句“这事该谁接”，只交给那一个 Bot；判不出来就
回落全员回答，不静默丢消息。

```sh
# 干跑：只看分流结果，不发消息、不跑 Bot
nyra group route --room room-1 --message "帮我查一下这周的报错"
# 开关（config.json，默认全关）：开了才在 chat send 里分流
# jev_router_enabled: true
# jev_model: "deepseek-flash"（路由用的便宜模型）
# jev_confidence_threshold: 0.6（低于它回落全员回答）
```

- 路由只决定“谁回答”，不决定“能不能做”——选中的 Bot 照样走审批、
  预算、证据链；路由不碰审批与预算。
- 回落条件（任一满足就全员回答）：decider 失败/没判出来、选了不存在
  的成员、置信度越界（不在 0–1）、置信度低于阈值、房间里只有一个机器人
  时不用分流。
- 路由结论进证据链（`jev_routed` 事件：房间、选中的成员、置信度、
  是否回落、回落原因；不记消息全文）。
- 路由不走 fallback 链、不自动换模型；队列与定时任务里不自动路由，
  只在交互 `chat send` 里用。

## 诚实边界

- 只在假 bot runner（本机确定性回复）上验过发言顺序、handoff 优先
  与终止条件组合；真实多机器人场景只在假 provider 上验过。
- token 估算是字符数 / 4，不是模型真实计费口径；预算只是停表，
  不是成本硬顶。
- Windows/macOS 真机未验证。

## 群聊会话（Bot 群聊批）

房间只是个容器：机主在外面看着，Bot 按顺序各说各的。会话是房间里
的一场联合讨论——机主是正式成员，能直接在会话里说话、@ 某台 Bot
交活、看每台 Bot 在干什么。

```sh
nyra group session create room-1 --name "周会"        # 开会话（同一房间同时只一个 open，旧的自动 paused）
nyra group session list                                # 列会话
nyra group session show gs-xxxxxxxx                    # 看成员、轮次、指派
nyra group session send gs-xxxxxxxx "大家先看这个报错" # 发一轮（默认 3 轮）
nyra group session send gs-xxxxxxxx "@所有人 大家先看这个报错" # @ 所有人：全体按轮询各说一轮
nyra group session send gs-xxxxxxxx "@bot-a 你先查" --rounds 5
nyra group session members gs-xxxxxxxx                 # 看成员与在线状态
nyra group session assign gs-xxxxxxxx @bot-a "写一份复盘"  # 指派
nyra group session done gs-xxxxxxxx asg-xxxxxxxx       # 指派完成
nyra group session presence gs-xxxxxxxx                # 机主与各 Bot 在不在线
nyra group session invite gs-xxxxxxxx --card <URL|好友名> [--provider <服务商>] [--model <模型>]  # 名片邀请成员进会话
nyra group session end gs-xxxxxxxx                     # 结束会话
```

- 轮次规矩：@ 点名 > 交接（上一条 Bot 消息里写 `HANDOFF: 某 Bot`）
  > 指派 > 路由 > 轮询；同一台 Bot 连续最多 2 轮；每条机主消息最多
  10 条（`--rounds` 给再大也只跑 10 条）；机主一提问（以 ? 或 ？
  结尾，或含 @owner）只跑 1 轮；空回复与重复回复算 pass，该 Bot
  本轮不再被选中。`@所有人` / `@all` 是向整个房间简要说明：全体按
  轮询顺序各说一轮，不建指派。一场会话里 Bot 成员 2–6 个（房间建
  时就卡这个数，邀请再多也进不来）。
- 每个成员可带自己的 provider/model：本地建房间时 `--provider` /
  `--model` 一次给全房，邀请时也可顺带指定；不给就走默认链。
- 每台 Bot 的账分开记：发言前按 `group:<会话>:<bot>` 预留预算，
  某台触顶只跳过它自己；批准按（Bot，工具）记，一次性消耗，别台
  的批准不能复用。指派轮与 @ 点名轮发言前须有该 Bot 未消耗的
  指派批准（建指派时记一条），缺了就跳过并记 `group_approval`
  事件（approved: false）。
- 指派：@ 点名自动建一条（任务就是去掉 @ 点名后的消息）；负责人
  回复里含“完成”自动结掉；5 轮没动静的指派算 stale（`staleAssignments`
  判）；`done` / 丢弃用 `nyra group session done` 与接口里的
  `dropAssignment`。
- presence：机主走网关桌面活跃（`isDesktopActive`），Bot 看
  `lastActiveAt`，同 5 分钟窗口；`nyra group session presence`
  一次看全。
- 名片邀请：好友名走好友账本 + `fetchAgentCard` + `parseAgentCard`
  复验，URL 直接取卡；拉黑的好友拒绝；邀请进来的成员只读、Key
  为空走默认链，回复必过拦截器；新成员进群先自我介绍一条（描述
  优先，没有描述就用 role）；名片上的 skills 记到成员身上，轮次
  里按技能过滤该成员的可用工具（技能在本地技能索引里找到、且声明
  了 allowed-tools 时才限，没技能或没声明时不限，与以前一致）；
  邀请时可顺带给 `--provider` / `--model`；房间创建时只许 readonly Bot 的
  规矩不变，会话不放宽执行型能力。
- 模型工具（工具总数 48→51）：`group_session_create`（room 必填）、
  `group_session_send`（session/message 必填）、`group_session_assign`
  （session/bot/task 必填）。模型工具不接 router（落到轮询），
  CLI send 接了与 `group route` 同款的 Jev + 本地路由链。
- 会话文件在 `~/.nyra/group-sessions/<gs-id>.json`（0600），7 类
  运行事件已注册（`group_session_created` / `group_session_ended` /
  `group_turn` / `group_assignment` / `group_member` / `group_approval` /
  `group_budget`）。

### 诚实边界

- FTS5 会话搜索本批没接：会话 id 是 `gs-` 形，不进 conversations.db；
  会话可查靠会话文件 + 运行事件 + `nyra group session show`。
- 预算预留默认是 0（limitsFor 默认 []、estimateUsd 默认 null；每 Bot
  分开记账与触顶只停该 Bot 的逻辑是假账本验的，生产上限未接真数）。
- 只在临时 home / 假 provider 上验过；真模型没跑；Windows/macOS
  真机未验证。

## Bot Mode 开关（Cue B 批，Hermes 缺口 7）

群聊会话的启用 / 停用配置，CLI 与手机端共用同一个配置源
`~/.nyra/group-bot-mode.json`（0600、原子写；缺文件或坏文件时 fail-open，
默认开，与 Hermes 默认开启一致）。

- CLI：`nyra group bot-mode <on|off|status>`。
- 手机端：设置页“群聊”分区里的开关（网关 `GET|POST /api/mobile/bot-mode`）。
- 关了拦两个入口：群聊会话轮次 `runSessionRound`（CLI `group session send` +
  `group_session_send` 工具）与房间 swarm 聊天 `GroupStore.send`（CLI
  `group chat send` + 网关 /m 群聊页）——手机上“群聊”就是房间，只拦会话
  会让手机上的开关看起来是假的。关了时两处都抛同一句
  （`BOT_MODE_OFF_MESSAGE`，见 `src/groupBotMode.ts`）。
- 详见 `docs/mobile-cue.md`。
