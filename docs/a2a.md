# A2A 服务端

Nyra 对外暴露成 A2A agent（Agent2Agent Protocol v0.3）：别的 agent 经
HTTP 用 JSON-RPC 2.0 调用 Nyra。AG-UI 服务端（`docs/agui.md`）走 AG-UI
事件，ACP（`docs/acp.md`）走 stdio，A2A 走 HTTP + JSON-RPC；三者共用
同一套治理：对方消息先过注入扫描、运行一律 origin `"peer"`、写操作进
peer 提议门、成本硬顶照常、不自动换模型。

## 开起来

```sh
nyra a2a serve enable            # 默认关闭，先启用
nyra a2a serve token new --name 客户端名   # 建调用 token，明文只显示一次
nyra a2a serve start             # 前台启动，默认 http://127.0.0.1:8767，Ctrl-C 停
nyra a2a serve status            # 看启用状态、地址、token 数
nyra a2a card                    # 打印本机的 A2A 名片（JSON）
```

`serve start` 支持 `--port <端口>` 与 `--host <地址>`；`--host 0.0.0.0`
是显式选择，启动时打警告。服务端只在前台命令跑着的时候才监听，停了
端点就不存在，不留后台口子。

## 发现：名片

- `GET /.well-known/agent.json`（v0.3 标准）与
  `GET /.well-known/agent-card.json`（老路径，同内容），不鉴权——名片
  是公开契约，只含名字、描述、技能、鉴权方式，不含任何数据。
- 名片复用缺口 38 的 `buildAgentCard`（名字与描述取 Soul，技能取对外
  MCP 服务的工具清单），再按 A2A v0.3 的形状重排：`protocolVersion`
  `"0.3"`、`url` 是服务端地址、`capabilities.streaming: true`（流式
  本批真做了）、`pushNotifications: false`（没做）、
  `securitySchemes: { bearer: { type: "http", scheme: "bearer" } }`。
  开了名片签名（`peer_card.signing`）且密码箱里有钥匙时，名片带 JWS
  签名与公钥 JWK；没钥匙发素名片，不报错、不假装签过。

## 调用：JSON-RPC 2.0（POST /）

`agent/card` 不鉴权；其余方法须 `Authorization: Bearer <token>`，无
token 回 401、错 token 回 403（包在 JSON-RPC 错误信封里，码 -32000）。

| 方法 | 说明 |
| --- | --- |
| `message/send` | 同步跑一轮，回 Task（completed / failed / rejected） |
| `message/stream` | SSE 流：status-update → artifact-update → 最终 Task |
| `tasks/get` | 按 id 取任务（`historyLength: 0` 不带 history） |
| `tasks/cancel` | 取消跑中的任务；终态任务报 -32002 |
| `tasks/list` | 列任务（`contextId` 过滤、`pageSize` 上限 100） |
| `tasks/resubscribe` | 重放某任务的状态历史 + artifact + 最终任务（SSE） |
| `agent/card` | RPC 形式的名片（不鉴权） |

任务状态：`submitted → working → completed / failed / canceled /
rejected`。注入扫描命中的消息不进模型，任务直接 `rejected`。
`input-required` 本批不发：Nyra 不向调用方反问，缺信息直接在回答里
说明。

消息只认 `text` part；`file` / `data` part 报 -32005（内容类型不
支持，不假装能读）。`configuration.pushNotificationConfig` 带了报
-32003（推送通知本批不支持）；`acceptedOutputModes` 里非 `text` 的
报 -32005。`message/send` 带 `taskId` 可以续跑同一任务（多一轮、
多一件 artifact）；任务正在跑时再发报 -32600。`contextId` 把多轮
任务归到同一上下文，对应本地会话 `a2a-<contextId>`，同上下文接着
上轮跑。

一轮的回答以 artifact（`name: "result"`，一个 text part）回给调用
方；工具调用过程不对调用方暴露（A2A 只约定任务与 artifact，不约定
工具细节）。

## 治理

与 AG-UI / ACP 服务端看齐，fail-closed：

- 对方消息先过确定性注入扫描，可疑直接 `rejected`（`a2a_blocked`
  进证据链），不执行、不进模型上下文。
- 服务端运行一律以 origin `"peer"` 跑 Agent：只读工具正常执行，写
  操作进 peer 提议门（只记提议，`nyra peer proposal accept <提议 id>
  --yes` 才执行）。
- token 的写授权（`nyra a2a serve grant <token-id> --yes`）只决定模型
  看不看得到写工具：没授权时写工具直接从工具表里拿掉；有授权时才
  能提议，执行仍须机主逐条批。
- 成本硬顶照常（单次 + 月度上限，网关同款口径），服务端不自动换模
  型（只用主 provider）。
- 任务账本 `~/.nyra/a2a-tasks.json`（0600 原子写，最多留 200 条），
  只存文本 part 与结论，不存文件与二进制；损坏回空列表。
- 新运行事件 `a2a_task_created` / `a2a_task_finished` /
  `a2a_task_cancelled` / `a2a_blocked` 已注册进 EVENT_FIELDS（只记任
  务 id、上下文 id、状态、字数、花费，不记原文）。

## 没做的事

- A2A 客户端走 JSON-RPC：已有 `nyra agui a2a`（走名片 + 交接的老口
  子），本批不动它。
- `input-required` 反问流、推送通知、客户端指定的 MCP 服务器。
- 服务端运行不分配 Bot 电脑（用主 agent 的工作目录）；MCP 工具不
  暴露给服务端运行。
- 真 A2A 客户端（ADK / LangGraph 等）联调未做；只在临时 home /
  本机回环 + 假客户端上验过。
