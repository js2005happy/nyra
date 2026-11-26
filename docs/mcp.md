# MCP：HTTP 传输与对外 MCP 服务（缺口 17）

Nyra 的 MCP 分两半：**客户端**（Nyra 调别人的 MCP 服务器）与**对外服务**
（别的 agent 调 Nyra）。两半的鉴权与审批规则不一样，不要混用。

## 客户端：stdio 与 HTTP 两种传输

`mcp_servers` 里每个服务器配一种传输（默认 `stdio`，不填就是它）：

```json
{
  "mcp_servers": {
    "local-tools": { "command": "npx", "args": ["-y", "some-mcp-server"] },
    "remote-tools": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

- **stdio**：启子进程（原有行为），子进程默认拿不到你的 API Key，可走沙箱。
- **http**：Streamable HTTP（2026-07-28 无状态）——每个请求都是独立的 POST
  （JSON-RPC 2.0），响应是 JSON 或 SSE；**没有会话**：客户端不存、不发
  `Mcp-Session-Id`，老式有状态服务器回了也忽略；每个请求自带协议版本
  （`_meta` 里 `io.modelcontextprotocol/protocolVersion` + `MCP-Protocol-Version`
  请求头）。不启子进程、不走沙箱（沙箱只约束本地子进程）；`url` 只接受
  `http://` / `https://`；`headers`（可放 `Authorization` 等）绝不写进日志与事件。
- 两边协商同款：先 `server/discover` 探现代版（2026-07-28），失败回退旧版
  `initialize`（2025-11-25）；`tools/list` 分页、`tools/call` 文本拼法一致；
  服务器要求补充输入（`input_required`，多轮往返）时直接报错，Nyra 暂不支持。
  （`server/discover` 是主路；`initialize` 只留给不会 discover 的老服务器作兼容回退。）
- 成本与上限不变：`cost_per_call_usd` / `mcp_cost_limit_usd` 对两种传输都生效
  （见 `GET /api/mcp/spend`）。

## 对外服务：Nyra 当 MCP 服务器

**默认关闭。** 开启后，别的 agent 可以通过网关的 `POST /mcp` 调 Nyra 的
记忆与任务——但不是无鉴权的：

- **鉴权**：走网关已有的 token（`X-Nyra-Token`：owner token 或设备 token，
  与 `/api/*` 同款）。无 token 或错 token 回 403；服务未开启时端点当不存
  在（404），不泄露端点。
- **工具**（5 个）：

  | 工具 | 读写 | 说明 |
  |---|---|---|
  | `search_memory` | 读 | BM25 检索长期记忆（`query` 必填，`limit` 默认 5、最多 20） |
  | `query_evidence` | 读 | 读某次运行的事件记录（`run_id` 必填，`limit` 默认 20、最多 100） |
  | `add_memory` | 写 | 往长期记忆追加一条（`text` 必填，最多 2000 字） |
  | `forget_session` | 写 | 删除某个会话在长期记忆里的全部条目（`session_id` 必填；进行中的会话拒绝删除，与缺口 2 的删除 API 同口径） |
  | `dispatch_task` | 写 | 给 Nyra 派一个任务（`task` 必填，最多 8000 字；`mode` 只能是 `readonly` 或 `auto`，默认 `readonly`；任务进队列后按模式跑，须跑 `nyra task worker` 才执行） |

- **审批（写操作两道门）**：写操作须先显式开 `allow_writes`，且每次都要
  过独立审查层（缺口 10）：三个写操作对应虚拟敏感动作
  `mcp_server_add_memory` / `mcp_server_forget_session` /
  `mcp_server_dispatch_task`，已加进 `DEFAULT_REVIEWED_TOOLS`，用户收窄
  `reviewer.tools` 也不影响这道门。**审查层未开启时写操作直接拒绝**
  （fail-closed），不像机器人市场那道门那样放行——对外服务面对的是外部
  客户端，默认不信任。审查结论（放行与拦截都）记 `reviewer_verdict` 事件。
- **证据**：带 id 的每次调用都记一条 `mcp_server_call` 事件进运行记录
  （网关每次对外服务调用复用一个“对外服务”运行，不会每次调用新建一个
  运行目录；事件里只记参数指纹 `args_hash`，不记参数原文）；每次调用另写
  一行审计 `~/.nyra/mcp-server-audit.jsonl`（鉴权失败也记）。`ping` 与
  `notifications/*` 是协议噪声，只进审计、不进运行记录。
- **协议**：无状态 Streamable HTTP（2026-07-28）——只回 JSON（暂不支持 SSE
  流式回包），没有会话、不要求也不理会 `Mcp-Session-Id`；主路是
  `server/discover`（回支持的版本列表 + capabilities + `_meta` 里的 serverInfo
  + 缓存提示 `ttlMs`/`cacheScope`）；请求带了不支持的协议版本时回 -32022
  并列出支持的版本；`initialize` 只留给不会 discover 的老客户端作兼容。
  批量请求（数组）不支持；通知（无 id）不执行、不回包（202）。协议层错误
  （未知方法 -32601、参数无效 -32602）回 JSON-RPC 错误码；工具执行层失败
  （审查拦截、删除冲突、入队失败）回 `isError` 结果。

## 开关（CLI）

```bash
nyra mcp server status            # 看开关、写操作、审查层状态
nyra mcp server enable            # 开启对外服务（默认只读）
nyra mcp server allow-writes-on   # 允许写操作（仍须过独立审查层）
nyra mcp server allow-writes-off  # 关回只读
nyra mcp server disable           # 关闭对外服务
nyra mcp contract                 # 打印最小稳定契约 nyra-contract-v1 的 10 条命令（只读，服务关着也能看）
```

最小稳定契约 `nyra-contract-v1` 是 MCP 与 A2A 的同一张子集清单：10 条命令（问、记、查任务、列技能……），每条对应一个已有的 MCP 工具或 A2A 方法，不另起协议。详见 `docs/agent-contract.md`。

配置在 `config.json` 的 `mcp_server` 一节：`{ "enabled": false, "allow_writes": false }`。

## 客户端示例

别的 agent（支持 Streamable HTTP 的 MCP 客户端）连 Nyra：

```
端点：http://<你的电脑>:<网关端口>/mcp
请求头：X-Nyra-Token: <网关 token>
```

网关 token 在 `nyra ui --print-url-json` 启动时输出（一行 JSON，含 url 与
token）；不要把它发给不可信的客户端——拿到 token 就等于拿到记忆读写与任务派发权限（写操作
仍有审查层兜底，但读操作没有）。

## 已知局限

- 对外服务只回 JSON，不做 SSE 流式回包；不支持批量请求。
- 对外调用不进用量账本（与审查员同款）；读操作没有按调用计费。
- `query_evidence` 只读 `runs/` 与 `tasks/` 两个目录的事件；网关会话本身
  的实时消息不在事件里。
- `forget_session` 的“进行中”保护只看网关当前会话；CLI 正在跑的会话不在
  网关视野里，revision 冲突仍会兜底拦截。
- `Bun.sql` 的 Postgres 后端与本批无关；对外服务读写的是本地 `MEMORY.md`
  与本地任务队列，不走数据库。
