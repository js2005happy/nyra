# ACP 服务端（Agent Client Protocol v1）

G-P1-20 另一半：AG-UI 服务端（缺口 47 第二批）把 Nyra 对外暴露成
AG-UI endpoint（HTTP + SSE），本批做 ACP 协议——编辑器 / 别的客户端
经 stdio 用 JSON-RPC 2.0 直接驱动 Nyra。两者不是二选一：AG-UI 管
agent—人交互的事件流，ACP 管编辑器里 agent—客户端的会话协议；
治理口径同一套（只读先行、写操作进 peer 提议门、成本硬顶、不自动换模型）。

协议依据：agentclientprotocol.com/protocol/v1（2026-11-23 核对，
protocolVersion 1 稳定版；v2 是 Preview，本批不混进 v1 会话）。

## 用法

```sh
nyra acp serve                  # 启动服务端：stdin 读 JSON-RPC 行，stdout 只写协议行
nyra acp status                 # 看写开关与默认模式
nyra acp grant --yes            # 机主显式开写工具可见性（只放行“提议”，执行仍逐条批）
nyra acp revoke-grant           # 关写工具可见性
```

编辑器侧（以 Zed 这类 ACP 客户端为例）把 `nyra acp serve` 配成
custom agent 的启动命令即可；stdout 只走协议行，日志一律走 stderr，
混进一句日志都会把客户端的 JSON 解析炸掉。stdin 关闭即退出，
未完成的一轮随进程结束。

## 协议覆盖

| 方法 | 本批口径 |
|---|---|
| `initialize` | 回 protocolVersion 1 + 能力 + `agentInfo`（Nyra / 版本号）+ 空 `authMethods`（不需要认证） |
| `authenticate` | -32602（authMethods 为空，调了就拒绝） |
| `session/new` | 回 `{sessionId, modes}`；cwd 须是已存在的绝对目录；非空 `mcpServers`、systemPrompt、additionalDirectories 直接 -32602 |
| `session/load` | 回放 user/assistant 文本（`user_message_chunk` / `agent_message_chunk`）；同进程走内存记录，进程重启后靠落盘会话（`acp-<id>`）重建；未知会话 -32002 |
| `session/prompt` | 一轮：流 `session/update` → 回 `{stopReason}`（end_turn / cancelled / refusal） |
| `session/cancel`（通知） | 取消该会话正在跑的一轮 |
| `$/cancel_request`（通知） | 按 prompt 请求 id 取消 |
| `session/set_mode` | default / readonly 切换，回 `{}`，并广播 `current_mode_update` |
| `session/close` | 幂等，回 `{}`；未知会话按规范也算成功 |
| `session/resume` / `session/list` / `session/delete` / `session/set_model` / `session/set_config_option` | -32601（本批未实现） |

`session/update` 变体：`agent_message_chunk`（回答增量）、`tool_call`
（工具调用，带 kind：read/search/edit/execute/fetch/think/other）、
`tool_call_update`（completed / failed / cancelled）、`usage_update`
（used/size 是 token 数，cost 是美元金额，可选）、`current_mode_update`。
`plan` 与 `available_commands_update` 不发——Nyra 没有 ACP 意义上的
计划结构与斜杠命令可发。

prompt 内容块：只支持 `text` 与 `resource_link`（拼成一行链接），
带 text 的 `resource` 用它的 text；image / audio 与不带 text 的
resource 直接 -32602（能力里没广告 image/audio，收了就是失信）。
单轮 prompt 最多 200,000 字。

## 治理（与 AG-UI 服务端看齐，fail-closed）

- 对方消息先过确定性注入扫描：命中直接 `stopReason: "refusal"`，
  不进模型；`acp_blocked` 进证据链。
- 服务端运行一律以 origin `"peer"` 跑 Agent：只读工具正常执行，
  写操作进 peer 提议门（只记提议，`nyra peer proposal accept <提议 id> --yes`
  才执行）；提议对应的工具调用在流里标 `cancelled`，并告诉客户端本轮未执行。
- 写工具可见性默认关（`~/.nyra/acp-server.json`，0600 原子写）：
  没开时 default 模式也看不到写工具；`nyra acp grant --yes` 开了之后
  模型才看得到写工具——但也只是“看得到”，调用照样只记提议。
  服务端跑着的时候改开关，下一轮生效。
- 两个 mode：`default`（完整工具，受写开关管）与 `readonly`
  （写工具直接从工具表里拿掉，模型连提议都提不出来）。
- 成本硬顶照常（单次硬顶 + 分层每日上限，AG-UI 服务端同款口径），
  服务端不自动换模型（只用主 provider）。
- 证据链：4 个新运行事件 `acp_session_created` / `acp_session_loaded` /
  `acp_prompt_finished` / `acp_blocked`（已注册进 EVENT_FIELDS），
  只记元数据，不记 prompt 与回答原文。

## 没做的事

- **A2A 服务端**：另排，不在本批。
- **出站请求**：`session/request_permission` 不发（写操作走 peer 提议门，
  不向客户端实时要批）；fs/* 与 terminal/* 客户端方法不调
  （Nyra 内置文件工具直接走本地文件系统，不经过客户端）。
- **客户端指定的 MCP 服务器**：`session/new` 里非空 `mcpServers`
  直接拒绝，Nyra 用自己的 MCP 配置。
- **MCP 工具不暴露给服务端运行**（与 AG-UI 服务端同口径）。

## 诚实边界

只在临时 home / 假 runner / 假客户端上验过；真编辑器
（Zed / JetBrains 等）未接通过；真模型跑一轮未在 ACP 通道上跑过
（Agent 接线与 AG-UI 服务端同款，但 ACP 通道本身只走了假 runner）；
Windows/macOS 真机未验证。
