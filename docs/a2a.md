# A2A 服务端

Nyra 对外暴露成 A2A agent（Agent2Agent Protocol v1.0，2026-03-12 生产稳定版）：别的 agent 经 HTTP 用 JSON-RPC 2.0 调用 Nyra。AG-UI 服务端（`docs/agui.md`）走 AG-UI 事件，ACP（`docs/acp.md`）走 stdio，A2A 走 HTTP + JSON-RPC；三者共用同一套治理：对方消息先过注入扫描、再打不可信标记才进模型上下文，运行一律 origin `"peer"`、写操作进 peer 提议门、成本硬顶照常、不自动换模型。

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

## 发现：名片（v1.0）

- `GET /.well-known/agent-card.json`（v1.0 标准路径）与
  `GET /.well-known/agent.json`（老路径，同内容），不鉴权——名片
  是公开契约，只含名字、描述、技能、鉴权方式，不含任何数据。
- 名片是 v1.0 的形状：`supportedInterfaces[0]` 里是地址 + `JSONRPC` +
  协议 `"1.0"`，`capabilities` 里 `streaming: true`（流式真做了）、
  `pushNotifications: false`（没做）、`stateTransitionHistory: true`
  （resubscribe 能重放历史）、`extendedAgentCard: false`（没做，见
  下）；技能带 `tags` / `examples` / `inputModes` / `outputModes`；
  鉴权走 `securitySchemes: { bearer: { type: "http", scheme: "bearer" } }`。
- 名片里带 `contract` 字段：最小稳定契约 `nyra-contract-v1` 与它的 10 条
  命令（问、记、查任务、列技能……），对方照着调就行；详见
  `docs/agent-contract.md`。
- 开了名片签名（`peer_card.signing`）且密码箱里有钥匙时，名片同时带
  v1.0 的 `signatures[]`（JWS 分离式，签规范化后的整张名片）与老版
  紧凑 JWS `signature` + `public_key`（老对方还能认）；没钥匙发素
  名片，不报错、不假装签过。签名算法只认 ES256（P-256），有效期
  30 天，私钥只存密码箱（条目 `peer-card-signing-key`，复用已有的，
  不新建）。详见 `docs/peer-discovery.md` 的名片签名一节。

## 收卡的规矩：没验过不收

发现（`nyra peer discover`）与加好友（`nyra peer add` /
`nyra peer request`，以及发现后加好友）现在只收验过签名的名片：
没签名、篡改过、过期签名一律拒绝并报错，不进发现账本、不建好友
条目，拒收记一条 `peer_discovery_rejected` 事件（只记地址与原因）。
对方没跑过 `nyra peer card keygen` 再开 `nyra peer card sign on`
时名片没签名，发现不了——先让对方把签名开起来。

群聊邀请（`nyra group session invite`）不强制签名：邀请是机主亲手
点的操作，新成员默认只读、回复必过拦截器；那条线没变，见
`docs/group-chat.md`。per-peer token 拉卡（`fetchAgentCardAuthed`）
也不强制，只回验签结论。

## 调用：JSON-RPC 2.0（POST /）

`agent/card` 不鉴权；其余方法须 `Authorization: Bearer <token>`，无
token 回 401、错 token 回 403（包在 JSON-RPC 错误信封里，码 -32000）。

| 方法 | 说明 |
| --- | --- |
| `message/send` | 同步跑一轮，回 Task（TASK_STATE_COMPLETED / FAILED / REJECTED） |
| `message/stream` | SSE 流：taskStatusUpdate → taskArtifactUpdate → 最终 Task |
| `tasks/get` | 按 id 取任务（`historyLength: 0` 不带 history） |
| `tasks/cancel` | 取消跑中的任务；终态任务报 -32002 |
| `tasks/list` | 列任务（`contextId` 过滤、`pageSize` 上限 100、游标分页 `cursor` / `nextCursor`） |
| `tasks/resubscribe` | 重放某任务的状态历史 + artifact + 最终任务（SSE） |
| `agent/card` | RPC 形式的名片（不鉴权） |

任务状态（线上是 v1.0 的写法）：`TASK_STATE_SUBMITTED → TASK_STATE_WORKING → TASK_STATE_COMPLETED / TASK_STATE_FAILED / TASK_STATE_CANCELED / TASK_STATE_REJECTED`。注入扫描命中的消息不进模型，任务直接 `TASK_STATE_REJECTED`。`TASK_STATE_INPUT_REQUIRED` 本批不发：Nyra 不向调用方反问，缺信息直接在回答里说明。

消息只认 `text` part（`{ text, mediaType: "text/plain" }`）；`file` /
`data` / `url` / `raw` part 报 -32005（内容类型不支持，不假装能读）。
角色线上是 `ROLE_USER` / `ROLE_AGENT`。`message/send` 带 `taskId`
可以续跑同一任务（多一轮、多一件 artifact，`taskId` 在 message 对象
上，老版放 params 里也认）；任务正在跑时再发报 -32600。`contextId`
把多轮任务归到同一上下文，对应本地会话 `a2a-<contextId>`，同上下文
接着上轮跑。`configuration.pushNotificationConfig` 带了报 -32003
（推送通知本批不支持）；`acceptedOutputModes` 里非 `text` 的报
-32005。

一轮的回答以 artifact（`name: "result"`，一个 text part）回给调用
方；工具调用过程不对调用方暴露（A2A 只约定任务与 artifact，不约定
工具细节）。Task 带 `createdAt` / `lastModified`（ISO 8601 UTC，
毫秒精度）。

错误信封：码还是 JSON-RPC 标准码 + A2A 码（-32001 任务不存在、-32002
任务不可取消、-32003 推送不支持、-32005 内容类型不支持），`error.data`
是 google.rpc.ErrorInfo 数组（`reason` + `domain: "a2a-protocol.org"`）。

## 治理

与 AG-UI / ACP 服务端看齐，fail-closed：

- 对方消息先过确定性注入扫描，可疑直接 `TASK_STATE_REJECTED`
  （`a2a_blocked` 进证据链），不执行、不进模型上下文。
- 扫过的消息进模型前还打一层不可信标记（`[untrusted-content kind="peer" source="peer:a2a:<token 名>"]` + 中文框线，见 `docs/lethal-trifecta.md`）：模型能看到这段话是外面来的，按不可信输入处理；账本 history 里仍存对方发来的原文，标记只加在送进模型的那份上。
- 服务端运行一律以 origin `"peer"` 跑 Agent：只读工具正常执行，写
  操作进 peer 提议门（只记提议，`nyra peer proposal accept <提议 id>
  --yes` 才执行）。
- token 的写授权（`nyra a2a serve grant <token-id> --yes`）只决定模型
  看不看得到写工具：没授权时写工具直接从工具表里拿掉；有授权时才
  能提议，执行仍须机主逐条批。
- 成本硬顶照常（单次硬顶 + 分层每日上限，网关同款口径），服务端不自动换模
  型（只用主 provider）。
- 任务账本 `~/.nyra/a2a-tasks.json`（0600 原子写，最多留 200 条），
  只存文本 part 与结论，不存文件与二进制；损坏回空列表。账本里状
  态存小写（submitted/working/...），发到线上的那一刻再翻成 v1.0
  的写法。
- 新运行事件 `a2a_task_created` / `a2a_task_finished` /
  `a2a_task_cancelled` / `a2a_blocked` 已注册进 EVENT_FIELDS（只记任
  务 id、上下文 id、状态、字数、花费，不记原文）；拒收的发现记
  `peer_discovery_rejected`（只记地址与原因）。

## 没做的事

- gRPC 传输与多租户（tenant）：只做 HTTP，v1.0 的 gRPC 绑定与 tenant 字段都不接。
- `agent/getAuthenticatedExtendedCard`：能力里 `extendedAgentCard: false`，调了回 -32601 未知方法。
- A2A 客户端走 JSON-RPC：已有 `nyra agui a2a`（走名片 + 交接的老口子），本批不动它。
- `input-required` 反问流、推送通知、客户端指定的 MCP 服务器。
- 服务端运行不分配 Bot 电脑（用主 agent 的工作目录）；MCP 工具不暴露给服务端运行。
- 真 A2A 客户端（ADK / LangGraph 等）联调未做；只在临时 home / 本机回环 + 假客户端上验过。
- 好友分圈（缺口 34）不在本批：发现与加好友的圈还是默认圈，分圈以后再做。
