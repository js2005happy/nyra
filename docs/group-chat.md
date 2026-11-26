# 群聊 swarm / handoff（缺口 G-P1-2）

一个群聊里多个机器人按顺序发言、分工做事（AutoGen 的 swarm/handoff 思路，
只抄机制、不搬实现）。跟 `groups.ts` 的并行轮不同：这里是**顺序发言**，
一次只一个机器人说话。

## 房间与发言模式

```sh
nyra group room create <房间 id> <名字> --bot <机器人 id> [--bot ...]
nyra group room list
nyra group room show <房间 id>
```

每个机器人用默认模型跑，说明走默认提示词。三种发言模式：

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
