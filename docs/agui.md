# 协议中立接入（AG-UI / A2A）

缺口 47 第一批：外部 agent 可以作为 Nyra 的一个 Bot 接入——用对方的
模型、工具与运行时，Nyra 提供 workspace、治理、记忆与体验。做兼容者，
不另起协议：Nyra 实现 AG-UI 客户端兼容，能接任意 AG-UI endpoint。
第二批：反过来，Nyra 自己对外暴露成 AG-UI endpoint，别的 agent /
编辑器能调用 Nyra（`nyra agui serve`）。

## 分工（CopilotKit 的划分）

- MCP 管工具（缺口 17：客户端 stdio + Streamable HTTP 已落地，对外 MCP
  服务 `nyra mcp server` 也已落地，见 `docs/mcp.md`）。
- A2A 管 agent 间通信（缺口 38 的名片 + 缺口 12 的交接）。
- AG-UI 管 agent—人交互（本批：`nyra agui`；服务端：`nyra agui serve`）。

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
  治理接线）——已做，见下节「服务端：把 Nyra 对外暴露成 AG-UI endpoint」。
- 外部 agent 落在哪台持久电脑上（缺口 42 的电脑分配）：本批未做——
  服务端运行目前用主 agent 的工作目录，不分配 Bot 电脑。
- 真实外部 AG-UI 服务的对接：本批只在假 endpoint（本机 HTTP）上
  验过；真 API 未跑通；Windows/macOS 真机未验证。

## 服务端：把 Nyra 对外暴露成 AG-UI endpoint（缺口 47 第二批）

别的 agent / 编辑器调 Nyra：Nyra 起一个本地 AG-UI endpoint，
对方按 AG-UI 协议发 run 请求、收 SSE 事件流。

```sh
nyra agui serve enable                     # 先启用（默认关闭，不启用起不来）
nyra agui serve token new --name editor    # 建一条调用 token（明文只显示一次）
nyra agui serve start                      # 前台启动：http://127.0.0.1:8766，Ctrl-C 停
nyra agui serve status                     # 看配置与 token
nyra agui serve grant <token-id> --yes     # 给某 token 写提议权
nyra agui serve token revoke <token-id>    # 吊销 token（立即失效）
```

协议面（与第一批客户端同款口径，Nyra 自己的客户端能连上另一台 Nyra）：

- **发现**：`GET /` 或 `POST { type: "handshake", protocol: "ag-ui", ... }`
  回 `{ ok: true, protocol: "ag-ui", version, capabilities }`，不鉴权。
- **运行**：`POST /`，须 `Authorization: Bearer <token>`（无 token 401、
  错 token 403），body 是 AG-UI run 请求 `{ threadId, runId, messages,
  tools?, state? }`，任务取 messages 里最后一条 user 消息；回 SSE 流
  `RUN_STARTED` → `TEXT_MESSAGE_START`/`TEXT_MESSAGE_CONTENT`（delta
  是规范的增量字段，第一批客户端也已认）→ `TOOL_CALL_START`/`ARGS`/
  `END` → `TEXT_MESSAGE_END` → `STATE_SNAPSHOT` → `RUN_FINISHED`，
  出错发 `RUN_ERROR`（不发 `RUN_FINISHED`）。
- **多轮**：threadId 对应本地会话（`agui-server-<thread>`），同 thread
  的后续请求接着上轮上下文跑；state 字段本批只接受、不应用。

安全口径（与第一批镜像，fail-closed）：

1. 默认关闭、只在前台命令跑着时监听，停了端点就不存在；默认只绑
   127.0.0.1（回环），默认端口 8766（网关是 8765）；`--host 0.0.0.0`
   是操作者显式选择，启动时打警告。
2. token 只存 SHA-256 指纹（timingSafeEqual 比对），明文永不落盘，
   只在 `token new` 时显示一次；配置 `~/.nyra/agui-server.json`
   原子写 0600。
3. 对方发来的消息先过确定性注入扫描（与第一批同一套规则），可疑
   直接以 `RUN_ERROR` 拒掉进证据链（`agui_server_blocked`），不执行、
   不进模型上下文。
4. 服务端运行一律以 origin `"peer"` 跑 Agent：只读工具正常执行，
   写操作进第 2 批 G-P1-10 的 peer 提议门——只记提议（`nyra peer
   proposal accept <提议 id> --yes` 才能执行），本次不执行。token
   的写授权（`serve grant --yes`）只决定模型看不看得到写工具：没
   授权时写工具直接从工具表里拿掉，模型连提议都提不出来；有授权
   时才能提议，执行仍须机主逐条批。——写操作分两层：提议权与执行权，
   本批只做到提议权。
5. 成本硬顶照常（单次 `max_cost_usd` + 月度上限，网关同款口径），
   超支停下；服务端不自动换模型（只用主 provider，不接 fallback 链）。
6. 证据链：9 个新运行事件（`agui_server_started` /
   `agui_server_run_started` / `agui_server_run_finished` /
   `agui_server_blocked` / `agui_server_tool_proposed` /
   `agui_server_write_granted` / `agui_server_write_revoked` /
   `agui_server_token_created` / `agui_server_token_revoked`），只记
   thread/run/token 名与结论，不记消息原文与 token 明文。

第二批不做：ACP 协议（G-P1-20 的另一半，另排）；A2A 服务端；MCP
工具暴露给服务端运行（mcpManager 为 null）；服务端运行的独立审查
模型（peer 提议门已在写操作前面拦住，读操作不需要审查）；真 AG-UI
客户端（CopilotKit 等）联调——只在 Nyra 自己的客户端 + 假客户端上
验过；媒体面未加密，别当端到端加密用。
