# 最小稳定契约 nyra-contract-v1（H7）

Bot 之间互操作、机器人市场里的 Bot 调别的 Bot，都走这一层。契约**不是新协议**：它是 MCP 与 A2A 两个既有面的一张“稳定子集清单”——10 条命令，每条写死它走哪个既有面（MCP 工具名 / A2A 方法名），不新增模型工具，不新增协议方法。

- 契约标识：`nyra-contract-v1`（版本号写进 id，`src/agentContract.ts` 的 `NYRA_CONTRACT_ID` / `NYRA_CONTRACT_VERSION`）。
- 看契约：`nyra mcp contract`（只读，MCP 服务关着也能看；自检不过会报出来并 exit 1）。
- 对方认不认：A2A agent 卡片（`GET /.well-known/agent-card.json`）里带 `contract` 字段，`nyra a2a card` 能看到。

## 10 条命令

| 命令 | 中文名 | 面 | 对应既有实现 | 写？ |
|---|---|---|---|---|
| `ping` | 连通性检查 | A2A | `agent/card` | 只读 |
| `ask` | 问一个问题 | MCP | `answer_question` | 只读 |
| `recall` | 查记忆 | MCP | `search_memory` | 只读 |
| `remember` | 记一条记忆 | MCP | `add_memory` | 写 |
| `forget` | 忘掉一个会话的记忆 | MCP | `forget_session` | 写 |
| `tasks` | 查任务 | 两面 | MCP `query_evidence` / A2A `tasks/get` | 只读 |
| `skills` | 列技能 | A2A | `agent/card` 的 `skills` 字段 | 只读 |
| `status` | 查状态 | A2A | `agent/card` | 只读 |
| `delegate` | 委派一个任务 | MCP | `dispatch_task` | 写 |
| `handoff` | 交接给另一台 Bot | A2A | `message/send`（payload 里带 contract id 与交接单） | 写 |

输入/输出形状见 `src/agentContract.ts` 的 `AGENT_CONTRACT_COMMANDS`（每条的 `inputs` / `outputs`）；契约自检 `validateAgentContract()` 保证：命令名唯一、每条都写明了面、MCP 工具名真实存在（6 个 MCP 工具全在契约里）、A2A 方法真实存在、写操作标清楚了。

写操作的安全口径不变：MCP 侧的写命令仍须 `allow_writes` 开启 + 独立审查层放行（审查层没开直接拒）；`delegate` 先记提议、不自动放行；`remember` 须过对方的记忆证据门。

## 选法：为什么是这 10 条

只认 MCP 与 A2A 上**已经存在**的东西。`cost`（查花费）故意不在这 10 条里：跨 Bot 成本归属是 B7 剩余，验收与归属规则没定之前不把 cost 写进稳定契约。

## 不在本批做（B7 剩余）

- **契约化交接验收**：对方是否按契约回了验收证据（`handoff` 只定 payload 形状，“已收下”不代表“已验收”）。
- **跨 Bot 成本归属**：一次跨 Bot 任务的花费归谁。

这两件等契约本身跑稳了再做，不在本批的 `nyra-contract-v1` 里。

## 版本化

改命令名、改输入/输出形状、删命令，都算破环：升版本号（`nyra-contract-v2`），旧版在文档里注明废弃时间。只加新命令（不改旧命令）可以只升小版本说明，但 id 里的 `v1` 不动——调用方按 id 认版，不按小版本。
