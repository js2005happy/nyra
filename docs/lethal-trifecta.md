# 致命三元组（十年清单第 5 项）

一个 agent 同时具备下面三项，就能被一段不可信内容骗着把隐私数据发出去
（Simon Willison 2025-06，OWASP ASI01）：

1. **接触隐私数据**——读邮箱、数据库、内部文档、密钥；
2. **暴露在不可信内容里**——网页、邮件、用户上传的文档、第三方工具输出；
3. **能对外通信**——发 HTTP 请求、发邮件、写共享位置。

砍掉任意一项，窃取路径就断了。Nyra 三项都有，所以不靠“模型自己小心”，
靠确定性控制：每轮任务记清三条腿各走了哪一步，三项齐全的任务里所有写操作
强制走人工审批，没人可问就默认只读；`nyra doctor` 里也查这一项。

诚实边界：提示注入无法彻底修好，这里做的是标记 + 隔离 + 审批三层兜底。
对外绝不宣称注入已解决。

## 三条腿与工具表

静态画像在 `src/lethalTrifecta.ts`（`assessTrifecta`），工具分类是字面名表，
测试盯着它与注册表同步（新工具加进来没分类就挂）：

- **腿 1（接触隐私数据）**：`read_file`、`list_dir`、`grep_search`、`git_status`、
`memory_search`、`session_search`、`knowledge_search`、`gmail_search`、`gmail_read`、
`slack_channels`、`slack_history`、`shopify_products`、`shopify_orders`、
`shopify_inventory`、`editor_context`、`describe_image`、`media_ingest`、
`read_skill`、`lsp_diagnostics`、`lsp_symbols`、`browser_screenshot`、
`computer_screenshot`、`computer_windows`（截图读的是屏幕内容，窗口标题
可能就是一封邮件的主题）。
- **腿 2（暴露在不可信内容里）**：`web_fetch`、`web_search`、`github_repo_read`、
`github_search`、`feed_read`、`browser_navigate`、`browser_click`、
`computer_windows`、`gmail_search`、`gmail_read`、`slack_channels`、
`slack_history`、`describe_image`、`media_ingest`、`delegate`、
`delegate_parallel`、`multi_model_research`。
- **腿 3（能对外通信）**：`shell`、`http_post`、`gmail_send`、`slack_send`、
`web_fetch`、`web_search`、`github_repo_read`、`github_search`、`feed_read`、
`browser_navigate`、`browser_click`、`group_session_create`、
`group_session_send`、`group_session_assign`、`multi_model_research`、
`media_ingest`。

没进任何一条腿的是本地写/本地渲染工具（`write_file`、`edit_file`、
`apply_patch`、`memory_append` 等）：它们是被管的一方，不是腿——三项齐全后，
正是这些写操作要被强制审批。

动态 MCP 工具（运行时名形如 `mcp__<server>__<tool>`，以及裸 `mcp` 名）按规则算：
调的是第三方服务器，回来的东西不可信（腿 2），调用本身就是对外通信（腿 3）。

## 运行时记账

`TrifectaTracker`（`src/lethalTrifecta.ts`）：Agent 构造时建一个、挂进
`ToolContext.trifectaTracker`，每轮任务开始前 `runLoopInner` 里 `reset()`。
记账点：

- 腿 1：`executeTool` 里工具执行成功后，工具本身占腿 1 就记一次；
- 腿 2：同上，结果里带结构化不可信标签就记一次（来源取标签里的 `source`）；
- 腿 3：`checkApproval` 里，本次调用本身就是对外通信时记一次。

失败的结果不记账——没拿到的东西不算接触。记账失败绝不破坏主循环（try 包着）。

三条腿齐全时发一次 `trifecta_completed` 事件（只记哪几条腿、哪个工具补齐了
第三条，不记内容）；再记也不重复发。

## 强制审批 + 默认只读

三项齐全的任务里，所有写操作强制走人工审批（`checkApproval`）：

- 跳过 allow 快路、幂等短路、脚本快路径、记住的规则、`approveFnGrants` 缓存；
- 审批摘要里写清为什么逼问（“致命三元组：本轮既接触了隐私数据、又收到了
不可信内容，还能对外通信”）；
- 这次批了就执行，但“始终允许”不记录——下次写还得再问；
- auto/creator 模式非交互本来就拒绝；full 模式下无人可问（没有委派审批回调）
就直接拒绝，并记一条 `trifecta_blocked` 事件（只记工具名与原因）。

逃生口：`NYRA_TRIFECTA_GUARD=0` 关掉强制审批。关了之后 `nyra doctor` 的
三元组检查会报失败，给出修复（删掉这个环境变量）。

没挂 tracker 的调用方（网关直调工具、老测试）守卫不生效，行为与以前一致。

## 不可信内容结构化标记

外部内容进上下文前，除了中文框线（``……``），
再打一行机器可解析的标签（`src/untrusted.ts`，`frameUntrusted` 里统一打）：

```
[untrusted-content kind="web" source="Gmail" integrity="untrusted"]
```

`kind` 是来源种类（`inferUntrustedKind` 按来源名推断）：`web`（网址）、`email`
（Gmail/邮件）、`chat`（Slack/群聊）、`peer`（对端）、`file`（文件/文档）、
`agent-ui`（AG-UI）、`event`（事件）、`image`（图片）、`external`（认不出）。
`source` 是来源名（不含内容），`integrity` 固定 `untrusted`。

- `markUntrusted(text, source)`：一次打好标记，返回结构化标签 + 框好的文本 +
是否拦下可疑句。密级按 `contentLabels.looksSecret` 判定：含疑似密钥/凭据的
标 `secret`，其余标 `internal`。
- `parseUntrustedTag` / `isUntrustedFramed`：从文本里读回标签（下游不用猜
“这段是不是外部来的”，读标签就行）。
- 伪造标签：外部内容里自己写一条同款标签行，`sanitize` 时会被中和成
`[外部数据标记（原文）]`（`SPOOFED_MARKERS` 同款处理），`frameUntrusted`
直接调用的路径也一样中和。伪造者改不了自己内容的定级；伪造的标签行就算
漏网，也只会让 tracker 多记一条腿（更谨慎），永远不能把不可信洗成可信。
- 本地文件默认按用户自己的数据处理，不打不可信标记（用户明确要求读的文件）；
从网上/邮件/第三方来的才打。

标签行本身是结构，不是提示词里的一句话——系统提示不是安全控制。

## doctor 检查

`nyra doctor` 第 2c 项“致命三元组”：静态画像 53 个内置工具各腿计数。
三项齐全 + 守卫开着 = 通过（写明已强制审批 + 默认只读）；三项齐全 + 守卫
关了 = 失败，给修复；三项没齐全 = 通过（没有一条能偷数据的完整路径）。

## 运行事件

`src/runs.ts` 的 `EVENT_FIELDS` 已登记：

- `trifecta_completed: ["legs", "tool"]`——三条腿在本轮齐全时记一条；
- `trifecta_blocked: ["tool", "reason"]`——齐全后被拦下的写操作记一条。

事件里只记腿、工具名、原因，不记内容，不记绝对路径。

## 已知限制

- 网关（`gateway.ts`）直接建的 `ToolContext` 没挂 tracker，守卫只在 agent
主循环生效。
- 本地文件不打不可信标记：如果用户上传的文档本身带注入指令，读文件这一步
不会标它；拦它的是扫描（可疑句拦截）+ 审批（写操作须人批），不是标记。
- 注入没解决：标记 + 隔离 + 审批是三层兜底，不是根治。

## 测试

`tests/node/test-lethal-trifecta.test.ts`（20 项）：静态画像（53 工具齐全、
受限集合 2/1/0 腿）、分类表与注册表双向同步、Tracker 逐腿记账与只发一次事件、
结构化标记（标签往返解析、密级、伪造标签被中和）、`checkApproval` 强制
（齐全 + full 模式 + 无 approveFn + 非交互 → 拒绝并记 `trifecta_blocked`；
有 approveFn → 被问且“始终允许”不记录）、守卫开关、`executeTool` 记账
（成功记、失败不记）。`tests/node/doctor.test.ts`：新检查存在且通过；
`NYRA_TRIFECTA_GUARD=0` 时失败。
