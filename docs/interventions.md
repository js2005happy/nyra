# 运行时消息拦截（G-P2-1）

AutoGen 的 `InterventionHandler` 挂在 runtime 层：`on_send` / `on_publish`
两点可改写、记日志、丢弃消息。Nyra 原来只有工具调用点的审查 / judge /
hooks——群聊里对方 agent 发来的每条消息没有一道可编程的拦截器，本批
补这一层：消息进总线时先过拦截器，再决定放行、改写还是丢弃。

## 拦截点

| 总线 | 入口 | 拦截点 |
|---|---|---|
| group（群聊） | `GroupStore.send()` 的入口消息 | `send`（senderKind 按调用方给，默认 owner） |
| group（群聊） | `GroupStore.send()` / `runOneBot()` 里 bot 的回复 | `publish`（senderKind `bot`） |
| a2a | `dispatchA2aRpc` 的 `message/send` / `message/stream` | `send`（senderKind `peer`，发送者 `a2a:<token 名>`） |
| agui | `serveAguiServerRun` | `send`（senderKind `peer`，发送者 `agui:<token 名>`） |

本地 CLI 自己的消息不走总线，不拦截。网关 `/api/groups/:id/messages`
默认按机主消息走（senderKind 默认 `owner`），对方 agent 经 A2A / AG-UI
进来才按 `peer` 走。

## 规则

配置 `~/.nyra/interventions.json`（0600 原子写，符号链接拒绝，损坏先
备份再回默认）：

```json
{
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "id": "ivr-0123456789ab",
      "name": "拦外部链接",
      "enabled": true,
      "action": "drop",
      "bus": "a2a",
      "kind": "send",
      "match": { "contains": ["http://", "https://"] },
      "reason": "对端发来的链接先拦下"
    }
  ]
}
```

- 匹配：`bus` / `sender`（精确匹配发送者名）/ `kind` 三个过滤器 +
  `match`（`contains` 任一子串命中，大小写不敏感；`regex` 正则；两样
  都配了任一命中即算）。
- 动作：`log` 只记审计；`rewrite` 改写后放行（`rewrite.replace` 全文
  替换、`prefix` / `suffix` 前后加一段，按 replace → prefix → suffix
  的顺序应用）；`drop` 丢弃。
- 多条规则命中时结论按 `drop` > `rewrite` > `log` 取最严的；rewrite
  按规则顺序依次应用。
- 可选挂 judge 门槛（`judgeThreshold` 0–100）：只有 judge 评分达线
  规则才触发。judge 是程序扩展点（`applyInterventions` 的
  `opts.judge` 注入），**本批生产接线不接真模型 judge**——没接 judge
  时带门槛的规则不触发，只记审计（`judge_missing`），不静默放行也
  不静默丢弃。

## 姿态：默认只记日志

- 总开关默认开，但默认动作只有 `log`。
- `drop` / `rewrite` 规则建出来**默认是关的**，须机主显式跑
  `nyra intervention enable <id>` 才生效——丢弃与改写是机主亲手开的。
- 机主自己的消息永远不拦截（`senderKind === "owner"` 直接放行，不记审计）。
- 拦截器本身抛错时当放行（fail-open——总线不能因为拦截器坏了就全停；
  规则校验与配置损坏在读配置时已先行处理）。

## CLI

```sh
nyra intervention list [--json]
nyra intervention add --name <名> --action log|rewrite|drop [--bus group|peer|a2a|agui] [--sender <名>] [--kind send|publish] [--contains <词> ...] [--regex <表达式>] [--prefix <文字>] [--suffix <文字>] [--replace <旧>=<新>] [--judge <0-100>] [--reason <文字>]
nyra intervention remove <id>
nyra intervention enable <id> | disable <id>
nyra intervention on | off
nyra intervention log [--limit <条数>] [--json]
nyra intervention test --bus <总线> --sender <名> --sender-kind owner|peer|bot|system --kind send|publish --text <文字>
```

`test` 是干跑：只报结论（`pass` / `log` / `rewrite` / `drop` + 命中
的规则），不写审计、不发事件。

## 审计与事件

- 审计 `~/.nyra/intervention-audit.jsonl`（append-only 0600，超 2000
  行只留最近 1000 行）：每条命中的规则记一行——时间、消息 id、总线、
  发送者、动作、规则 id、文本指纹（SHA-256 前 16 位）、文本长度、
  judge 评分（有才记）。**绝不记消息原文**。
- 运行事件（`src/runs.ts` 的 EVENT_FIELDS，只记元数据与指纹）：
  `bus_message_rewritten` / `bus_message_dropped`。`log` 只记审计，
  不发事件（免得噪音）。
- 群聊入口被丢弃时 `GroupStore.send()` 直接报中文错（规则 id 在错里）；
  A2A 入口被丢弃时回 JSON-RPC 错误（不建任务、不跑模型）；AG-UI 入口
  被丢弃时与注入扫描同款处理（`RUN_ERROR` + `status: "blocked"`）；
  swarm 里某轮 bot 回复被丢弃时那轮不进群记录、不计消息数（`droppedTurns`
  计入结果与 1000 轮硬顶）。

## 诚实边界

- 只在临时 home / 假 bot runner / 假 A2A 与 AG-UI 客户端上验过；真对端
  agent 发来的消息没在真联调上跑过。
- judge 回调是程序扩展点，生产接线没接真模型 judge（带门槛的规则在
  生产里目前不触发）。
- 拦截只在群聊 / A2A / AG-UI 三个入口生效；ACP 服务端与网关会话路由
  （`Gateway.send()`）不在本批覆盖范围。
- Windows/macOS 真机未验证。
