# 类型化中间件链（G-P2-4）

MAF 的做法：`AgentMiddleware` / `FunctionMiddleware` / `ChatMiddleware`
三层，内置 `RetryMiddleware`、`CachingMiddleware`、Validation、TokenCounter，
还有审批流 `function_approval_request` + `approval_mode="never_require"`
可按工具配。Nyra 原来只有 Hooks（拦截一环），重试、缓存、token 计数
各处散着实现——本批把三层链 + 四件内置做成可组合的中间件（只借想法，
不抄代码）。

## 三层

| 层 | 包住什么 | 内置 |
|---|---|---|
| chat | 模型调用前后（主循环的 `actModel.chat`） | token 计数 |
| function | 工具调用前后（常规分支与 MCP 分支） | 审批模式、校验、缓存、重试 |
| agent | 整轮前后（`runLoopInner`） | token 总量汇总 |

中间件形如 `(ctx, next) => result`，按注册顺序执行；不调 `next()` 即
短路，直接返回自己的结果。链本身是通用组合子
`runMiddlewareChain(fns, ctx, terminal)`（`src/middleware.ts`）。

接线点（`src/agent.ts`，只接主循环）：

- agent 层包住 `runLoopInner`（`runLoop` 的 try/catch/finally 不动）。
- chat 层包住主循环 2138 行附近的 `actModel.chat(...)`。940 行与
  2575 行的两处 `provider.chat` 不接（压缩与视觉的辅助调用）。
- function 层包住工具循环的常规分支（`executeToolIdempotent`）与 MCP
  分支（含无管理器时直接调 `executeTool` 的那条）。`search_tools` /
  disabled / refusal / resumeHit 分支不包——它们没执行工具。

function 层内顺序固定：**审批模式 → 校验 → 缓存 → 重试 → 执行**。
重试在最内层，只重试 terminal 抛出的可重试异常，不重复校验、不重复
查缓存；校验失败直接短路，不进工具。

## 内置四件

### 校验（默认开）

function 层。schema 由调用方注入（agent.ts 从 `TOOL_SCHEMAS` 现场拼）。
必填缺失或类型错（string / number / integer / boolean / array / object）
直接短路，返回 `错误：参数校验失败：…` 给模型，不进工具、不产生
副作用。工具不在 `TOOL_SCHEMAS` 里（`mcp_*` 等）直接放行，审批门仍在。
失败记 `middleware_validation_failed` 事件（只记工具名与字段名，不记
参数值）。

### 重试（默认关，须显式配）

function 层。只重试 next() **抛出**的可重试异常：`retryable === true`
或 kind 在 `quota / rate_limit / server / timeout / network`；
CancelError、AbortError、审批类（`retryable === false`）与未知错误
一律不重试。指数退避 + 抖动：
`delay = min(maxInterval, initial × backoff^attempt) × (0.75 + random × 0.5)`。
每次重试记 `middleware_retry` 事件（层、工具、轮次、等待毫秒、错误 kind）。

工具结果字符串里的错误不归这里管——已有的 `executeToolIdempotent`
负责只读重试与写核查（见 `src/tools.ts`）；这里只重试抛出的异常。
分工写死，免得双重试。

### 缓存（默认关）

function 层。键 = `sha256(工具名 + "\n" + 参数稳定序列化)`，只缓存
注入的白名单内只读工具（agent.ts 传 `READONLY_TOOLS`）。参数键里带
`key / token / password / secret / auth / credential / passwd` 的调用
不缓存；失败结果（`错误：` / `执行失败：` 开头）不缓存；单条结果超过
16000 字不缓存；写操作结果永远不缓存。命中记 `middleware_cache_hit`
事件（工具名 + 参数指纹哈希前 16 位，不记参数原文与结果原文）。

两档 store：`memory`（进程内 Map，跨运行共享）与 `file`
（`~/.nyra/middleware-cache.json`，0600 原子写、符号链接拒绝、TTL、
maxEntries 超了丢最旧的；损坏直接丢弃）。store 翻转须重启才生效。

### token 计数（默认开）

chat 层：每次模型调用后记一笔 `middleware_tokens` 事件（本次调用的
用量，没报就是 null + `missing_calls` 记 1）。agent 层：整轮结束时记
一笔 `middleware_tokens_total` 事件（累计用量；一次模型调用都没跑过
时不记）。计数只认模型实报的 `usage`，没报时记 `missing_calls`，
绝不编 0——与 `UsageTracker`（`src/usage.ts`）同款口径。

chat 层不挂重试：provider 的 `FallbackProvider` 已有同提供商重试
（指数退避 + 抖动 + Retry-After），再包一层会双重试。

## 配置

`~/.nyra/middleware.json`（0600 原子写、符号链接拒绝读写、损坏先备份
再回默认值、越界数值夹到范围内并记 errors）：

```json
{
  "version": 1,
  "layers": { "chat": true, "function": true, "agent": true },
  "validation": { "enabled": true },
  "tokens": { "enabled": true },
  "retry": { "enabled": false, "maxRetries": 2, "initialIntervalMs": 500, "backoffFactor": 2, "maxIntervalMs": 8000 },
  "cache": { "enabled": false, "store": "memory", "ttlSeconds": 300, "maxEntries": 200 },
  "approvalModes": {}
}
```

默认值：只开校验与 token 计数，重试与缓存默认关。配置每轮 runLoop
现读，CLI 改完下一轮即生效。层开关关了整层跳过（terminal 直调）。

## 审批模式

按工具配 `approval_mode`，默认 `require`。`never_require` 只对只读
工具可配——写工具配了在加载时丢弃（`validateApprovalModes`）、
`checkApproval` 里再拦一道（`ToolContext.approvalMode` 闭包，
fail-closed）。只读工具本来就不需要审批，所以 `never_require` 在
Nyra 里没有行为变化——它是策略声明面 + 校验面 + 事件留痕：
显式配了非默认模式的工具调用记一笔 `middleware_approval_mode`
事件（工具名与模式），默认 require 不记（满地都是，记了全是噪音）。
文档如实写明这一点，不得夸大。

## 运行事件

已注册进 `src/runs.ts` 的 `EVENT_FIELDS`：

| 事件 | 字段 | 说明 |
|---|---|---|
| `middleware_retry` | layer, tool, attempt, delay_ms, kind | 每次重试 |
| `middleware_cache_hit` | tool, args_hash | 缓存命中（指纹前 16 位） |
| `middleware_validation_failed` | tool, fields | 校验失败（字段名逗号串） |
| `middleware_tokens` | model, prompt_tokens, completion_tokens, total_tokens, missing_calls | 每次模型调用 |
| `middleware_tokens_total` | prompt_tokens, completion_tokens, total_tokens, missing_calls, calls | 整轮结束 |
| `middleware_approval_mode` | tool, mode | 非默认审批模式的调用 |

## CLI

```sh
nyra middleware status [--json]
nyra middleware enable <validation|tokens|retry|cache|chat|function|agent> [--yes]
nyra middleware disable <validation|tokens|retry|cache|chat|function|agent> [--yes]
nyra middleware set [--retry-max-retries <0-4>] [--retry-initial-ms <0-60000>] \
  [--retry-backoff <1-4>] [--retry-max-ms <100-60000>] \
  [--cache-ttl-seconds <10-86400>] [--cache-max-entries <1-5000>] \
  [--cache-store <memory|file>] [--yes]
nyra middleware approval [tool] [--mode require|never_require] [--yes]
nyra middleware cache-clear [--yes]
```

写操作一律须 `--yes`（防手滑，与 subagent preset 同款）。`approval`
不给工具名时列出已配的模式；`never_require` 配到写工具上直接拒绝。
`cache-clear` 只清文件缓存——memory 缓存是进程内的，须重启才清。

## 不做

- 现有各处散着的重试/缓存逻辑迁移（只接新链，老逻辑不动）：
  `FallbackProvider` 的同提供商重试、`executeToolIdempotent` 的只读
  重试与写核查、`UsageTracker` 的用量累计都还在原地，本批不改。
  新链与老逻辑的关系：
  - chat 层只做 token 计数，重试仍归 provider 链；
  - function 层重试只重试抛出的可重试异常，工具结果字符串错误
    仍归 `executeToolIdempotent`；
  - token 计数与 `UsageTracker` 是两套累计（链的事件进运行事件链，
    `UsageTracker` 仍负责成本结算），数字口径一致（都只认实报 usage）。
- 真分布式缓存（只做进程内 + 文件两档）。
- 中间件热加载（配置每轮重读，链装配本身不热换）。

## 诚实边界

只在临时 home / 假 provider 上验过；`nyra middleware` 真跑（调模型
花真钱）未跑过；重试的退避抖动用注入的随机数在测试里验过边界，
真网络抖动下的实际等待时间未实测；文件缓存只对本机文件验过往返，
没对共享文件系统跑过；Windows/macOS 真机未验证。
