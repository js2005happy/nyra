# 本地小路由（零 token 意图分类）

群聊里没 @ 谁、多 Bot 时，Nyra 要先判这条消息该谁接。原来只有一条路：
便宜模型一句话分流（Jev 路由，见 `docs/group-chat.md`）。本地小路由在
它前面再加一棒：一个手写的小神经网络，先在本地判意图，判得准就
直接派给对应的 Bot，不花 token、不调模型；判不准就落到便宜模型
那一棒，模型也判不出才回落全员回答。

## 它是什么

一个三层 MLP（多层感知机），纯 TypeScript 手写，不引新依赖：

- 输入：词袋二值向量（ASCII 词 + 汉字 + 汉字二元组，768 个词）。
- 隐藏层：24 个单元，tanh。
- 输出：6 个标签的 softmax 概率，取最大的当结论。

标签只有 6 个：`code`（写代码）、`research`（查资料）、`write`
（写文章）、`ops`（部署运维）、`chat`（闲聊）、`spam`（垃圾消息）。
垃圾消息不派给任何 Bot，直接回落。

训练数据是随仓带的人工例句（`src/localRouterData.ts`，69 条训练 +
24 条留出验证），训练脚本 `scripts/train-local-router.ts` 只在
开发时跑，权重以 JSON 随仓放在
`src/assets/local-router-weights.json.txt`，运行时只读，不训练、
不联网。留出集准确率当前 100%（24/24），训练脚本低于 80% 就
拒绝写盘。

## 开关

默认关。只认 `config.json` 里 `local_router` 一节：

```json
{
  "local_router": {
    "enabled": true,
    "threshold": 0.6
  }
}
```

- `enabled`：默认 `false`。不开时群聊走原来的 Jev 路由，不受影响。
- `threshold`：默认 `0.6`，只认 (0, 1] 之间的数。本地置信度低于
  它就回落到便宜模型那一棒；实际生效的阈值取本地阈值与 Jev 阈值
  里更严的那个——本地判出但过不了 Jev 阈值的结论，不直接进
  群聊，而是给模型一次机会。

队列与定时任务里不自动路由（只在交互群聊 `send` 里用），与 Jev
路由同款。路由只决定“谁回答”，不决定“能不能做”：选中的 Bot
照样走审批、预算、证据链。

## 命令

```sh
nyra router status               # 看开关、阈值、权重状态
nyra router test <消息…> [--json]  # 干跑一次分类，不发消息、不调模型
```

`nyra group route --room <房间 id> --message <消息> [--json]` 干跑
群聊路由时，本地开了也会先走本地那一棒，输出里会写明这次是
本地判的还是模型判的（`--json` 里是 `decider: "local" | "model"`）。

权重坏了时 `status` 如实报损坏，`test` 直接报错退出（不拿坏权重
硬猜）；群聊里权重坏了等于本地这棒不存在，直接走模型那一棒。

## 审计

每次本地分类都记一条运行事件 `local_router_decision`（标签、
置信度、是否回落、原因；不记消息全文）：

- 本地判中时，`jev_routed` 事件的原因会写“本地小路由（零 token）”，
  不冒充成模型判的。
- 本地回落时也记一笔（标签与置信度都在），方便看它到底是判错了
  还是把握不够。

## 局限

- 只懂 6 类意图，6 类之外的消息（比如“帮我订机票”）把握低，
  会回落到模型那一棒——这是设计，不是 bug。
- 标签到 Bot 的映射只看成员 role / name / instructions 里有没有
  映射词（`src/localRouterData.ts` 的 `LABEL_KEYWORDS`）；Bot 的
  role 写得含糊（比如只写“助手”）时可能对不上，就回落。
- 训练数据只有几十条人工例句，覆盖面窄；想扩意图或加语料时，
  往 `src/localRouterData.ts` 里加例子，再跑
  `bun scripts/train-local-router.ts` 重新生成权重（留出集低于
  80% 时脚本拒绝写盘）。
- 权重是随仓的 JSON；换了训练数据忘了重新训练时，权重还是旧的，
  以 `nyra router status` 看到的版本与词表数为准。
- Windows/macOS 真机未验证。
