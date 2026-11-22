# 协议中立接入（AG-UI / A2A）

缺口 47 第一批：外部 agent 可以作为 Nyra 的一个 Bot 接入——用对方的
模型、工具与运行时，Nyra 提供 workspace、治理、记忆与体验。做兼容者，
不另起协议：Nyra 实现 AG-UI 客户端兼容，能接任意 AG-UI endpoint。

## 分工（CopilotKit 的划分）

- MCP 管工具（缺口 17：客户端 stdio + Streamable HTTP 已落地，对外 MCP
  服务 `nyra mcp server` 也已落地，见 `docs/mcp.md`）。
- A2A 管 agent 间通信（缺口 38 的名片 + 缺口 12 的交接）。
- AG-UI 管 agent—人交互（本批：`nyra agui`）。

## 用法

```sh
nyra agui register <名字> <地址> [--peer <好友名>]   # 登记一个外部 AG-UI endpoint
nyra agui link <名字> <好友名>                       # 绑定名片好友（发现层）
nyra agui connect <名字>                             # 准入闸 + 握手后连接（只读）
nyra agui send <名字> <消息>                         # 发消息，走 AG-UI 事件流（只读）
nyra agui exec <名字> <工具> [参数 JSON]              # 请对方执行它的一只工具（写操作）
nyra agui accept-write <名字> --yes                  # 机主显式接受写操作
nyra agui revoke-write <名字>                        # 撤销写接受
nyra agui disconnect <名字>                          # 断开（写接受随断开一并撤销）
nyra agui a2a <好友名> <消息>                         # 给 A2A 对端发消息
nyra agui list [--json] / nyra agui show <名字> [--json]
```

## 安全口径（三条，一条不丢）

1. **“协议中立”不等于“信任中立”**：对方 agent 发来的任何内容
   （文本、工具调用提议、链接、文件）都按不可信输入处理——先过
   缺口 10 的确定性注入扫描（`src/untrusted.ts` 的
   `isSuspiciousSegment`，与审查层同一套规则形状），可疑内容就地
   拦截进证据链（`agui_content_blocked`），不执行、不进模型上下文。
   对方回的文本一律包 `wrapUntrusted` 再交出去。
2. **接入先做读，再做写**：外部 agent 先以只读 Bot 接入（能看任务
   产物、不能写）。`send` 只读，对方回的 `TOOL_CALL` 只当提议记下
   来（`agui_tool_proposed`），不执行。`exec` 是写操作：须机主显
   式接受（`accept-write --yes`，接受记录进证据链），接受前一律
   拒绝（`agui_write_blocked`），断开连接时接受一并撤销。
3. **准入复用信任圈**：`connect` 前须绑定名片好友，且对方须是已
   批准好友且在信任圈里（缺口 34 的 `isAdmitted`），圈外直接拒绝，
   不连对方。A2A（`a2a`）复用缺口 12 的 `askPeer`：自带对端协作
   开关、信任圈闸与独立审查门（审查层未开启时直接拒绝，fail-closed）。

## 握手与事件流

- **发现握手**是 Nyra 的一小段 JSON 交换（不是 AG-UI 事件流本身）：
  发 `POST { type: "handshake", protocol: "ag-ui", client: "nyra",
  version }`，对方回 `{ ok: true, protocol: "ag-ui", version,
  capabilities: { events, tools } }`。对方不认握手时 `connect` 直
  接失败，不静默当成已连接。
- **事件流**走 AG-UI 的事件名（SSE，`data: {json}` 行，也认
  `event: <类型>` 行）：`RUN_STARTED` / `RUN_FINISHED` /
  `RUN_ERROR`、`TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` /
  `TEXT_MESSAGE_END`、`TOOL_CALL_START` / `TOOL_CALL_ARGS` /
  `TOOL_CALL_END`、`STATE_SNAPSHOT` / `STATE_DELTA`、`STEP_STARTED` /
  `STEP_FINISHED`。未知类型照收（只计数），不致命。
- 账本 `~/.nyra/agui-endpoints.json`（原子写 0600，损坏先备份再
  抛错）：只记 endpoint 名、地址、协议版本、能力声明、连接状态与
  写接受人，不记凭证原文——AG-UI endpoint 本批不配凭证；需要鉴权
  的对端走缺口 12 的对端 token（密码箱 `peer-token-<名字>`）。
- 证据链：12 个新运行事件（`agui_registered` / `agui_connected` /
  `agui_disconnected` / `agui_run_started` / `agui_run_finished` /
  `agui_content_blocked` / `agui_tool_proposed` /
  `agui_write_accepted` / `agui_write_revoked` /
  `agui_write_blocked` / `agui_a2a_sent` / `agui_a2a_received`），
  只记 endpoint 名、对方名、运行 id 与结论，不记地址原文（只记
  host）、消息原文与答复原文。

## 缺口 17 实际状态（本批动手前在代码里核实）

Bot 方向报告成文时写缺口 17“待做”，但代码已先于本批落地：MCP
客户端 stdio + Streamable HTTP（`MCPHttpClient`），对外 MCP 服务
（`NyraMcpServer` + 网关 `POST /mcp`，`nyra mcp server` 开关，默认
关闭、默认只读、写操作过独立审查层）均已实现。所以缺口 47 的先决
条件 38 与 17 在本批动手时均已满足，本批不补缺口 17。

## 本批不做

- Nyra 的 Bot 对外暴露为 AG-UI/A2A endpoint（第二批：对外暴露 +
  治理接线）。
- 外部 agent 落在哪台持久电脑上（缺口 42 的电脑分配，第二批随对
  外暴露一起定）。
- 真实外部 AG-UI 服务的对接：本批只在假 endpoint（本机 HTTP）上
  验过；真 API 未跑通；Windows/macOS 真机未验证。
