# 模型切换：每 agent 选模型 + 用量触顶自动换（缺口 5）

Nyra 的模型面比别家广（14 个 provider + 本地 Ollama + Codex 登录态），但以前
切换只是配置项：主 agent 没有“选模型”的产品入口，对话中途换不了模型，某家
订阅用量触顶时任务直接失败。本批把切换做成产品功能——每个 agent 可独立选
模型，对话中途可换且不丢历史，触顶时按用户预设的备用链自动换下一家并明确
告知。与 Turnstone 的区别：别家换了就换了，Nyra 换了要留痕——每一次换模型
都进运行事件（何时换、从谁换到谁、为什么换、当时已花多少），与成本硬顶
同口径。

## 安全红线（用户 2026-11-17 定，一条不许破）

- **兜底默认关闭**：`fallback_enabled` 默认 `false`。没开时触顶就是失败，
  不静默换。`--fallback` 只开本次运行，`--no-fallback` 只关本次运行。
- **只用户自己开启**：自动换只能由用户在配置 / 命令行里显式打开，
  Nyra 自己不开。
- **只切允许列表内服务商**：允许列表就是 `fallback_providers`。未知名字
  与 CLI provider（Codex）进不了链；手动换模型也只允许切到列表里的。
- **网页端切换须页面显示**：Web UI 的模型卡是 Hark 的 desktop/ 范围，
  本批只做 CLI + 配置 + 后端；网关的切换照样写进会话事件流。
- **队列/定时任务里不切换**：调度任务与任务队列只用单个 provider
  （`tasks.ts` 的 `buildProvider` 与网关的 `primaryProvider()`），
  触顶就失败，不自动换、不重排。

## 每个 agent 怎么选模型

| Agent | 选模型 | 触顶自动换 |
|---|---|---|
| 主 agent（终端） | `--provider <名> --model <模型>`（本次运行）、`--profile <名>`（profiles 里配 provider/model）、REPL `/model`（对话中途换，本次会话有效） | `fallback_enabled` + `fallback_providers`（config.json 全局），或 `--fallback`（本次运行） |
| 群聊机器人 | 建机器人时配 `provider` / `model`（`room.json` 的 bot 字段） | 该机器人自己的 `fallback_enabled` / `fallback_providers`；`null` = 沿用全局配置 |
| 定时任务 / 任务队列 | profile 的 provider/model | **永不自动换**（设计如此，见上） |
| 压缩 / 子任务 | `compact_model` / `delegate_model`（便宜模型路由） | 走主模型时含兜底链；独立模型自身的兜底不在本批范围（工厂当前未接线，实际回退到主模型） |

## 用量触顶自动换：怎么开、怎么配

`config.json`：

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "fallback_enabled": true,
  "fallback_providers": ["deepseek", "xai", "ollama"]
}
```

- `fallback_enabled`：总开关，默认 `false`。开了才会在触顶时自动换。
- `fallback_providers`：允许列表 + 备用顺序。主 agent 永远是链头，
  列表里的按顺序排在后面；显式空列表 `[]` = 无兜底（只剩主 agent）。
  默认 `["deepseek", "xai", "ollama"]`。
- 环境变量同义：`NYRA_FALLBACK=1` / `NYRA_FALLBACK_PROVIDERS=xai,ollama`
  （`NYRA_` 前缀，旧 `ANGEL_` 回退保留）。优先级：显式参数 >
  环境变量 > 配置文件 > 默认。

**什么算“用量触顶”**（触发条件，只分三档，其余失败分类不动）：

| 触发 | 判定 | 行为 |
|---|---|---|
| 用量触顶 | HTTP 402，或 429 但文案是配额类（"weekly limit"、"quota exceeded"、"用量已用完"、"余额不足"等） | **不重试同一家，直接换下一家**——重试同一家没有意义，只会烧钱 |
| 请求过于频繁 | 429 且文案不是配额类；状态码不是 429、但文案明说限流的也认（如 503 + `capacity exhausted`、500 + `overloaded`，见“429 接力”一节） | 先重试同一家（至多 2 次，退避 1s/3s + 抖动，服务端 `Retry-After` 更长时以服务端为准），重试无果再换 |
| 服务端 / 超时 / 网络 | 5xx、超时、连接失败 | 同上：先重试同一家，再换 |

**什么不换**：认证错（401/403）——换模型修不好认证；未知模型、无效
请求、安全拦截、用户中断——直接失败。全部备用都失败时，报错里列出
每一家失败的原因。

**换模型时用户会看到什么**：切换发生的同一次运行里就有一条通知，绝不
静默。三个面：

- **终端**：stderr 一行，例如

```
模型切换（用量触顶）：deepseek 失败（用量上限 (HTTP 429)：…），已切换到 xai 继续（运行 run_xxx，2026-11-21 19:40）
```

括号里是触发原因（用量触顶 / 请求过于频繁 / 服务端错误 / 请求超时 /
网络错误 / 调用失败），不是让用户从报错原文里猜；行尾附运行 id 与本地
时间，REPL 里没有 RunRecorder 时只附时间。`--json` 模式发
`model_switch` 事件（见 `docs/json-events.md`）。
- **网关（`nyra ui`）**：切换记进在跑会话的事件流，网页端经 SSE 立刻
  看到同一条 `model_switch` 事件（带时间戳）；`/status` 里 `model_switches`
  列出本进程的切换记录，`fallback_chain` 列出当前链。
- **群聊机器人**：切换附在当轮回复前面发出去（与终端同款文案），用户
  当轮就看到；当条消息的 `model_switches` 里照旧记结构化记录，供事后核对。
  私聊 Bot 目前只用主模型、不走兜底链（也就不会触发切换）；队列/定时任务
  同样不切换（见下）。

**切换审计**：每次真切换记一行 `~/.nyra/model-switch-audit.jsonl`
（append-only 0600，写失败不拦运行）：时间、运行 id（有才记）、机器人 id
（群聊才有）、从谁切到谁、触发原因、报错原文（已脱敏：home 目录换
`[home]`、Key 样字符串与 ≥32 字连续词串换 `<redacted>`、超 500 字截断）。
审计是 SIEM 导出第 7 个来源（`nyra governance audit export` 可指定
`--sources model_switch` 只导它；导出前同样脱敏）。限流/配额切换时，
审计行多一个 `handoff_id`（接力摘要的 id，见下）。切换把 from 标
degraded 时，审计行多一个 `degraded_until`（恢复时间，见下）。

## 降级预设 best / fast（G-P1-33）

Botpress 的 `packages/cognitive` 有 best / fast 两档预设。Nyra 的
`config.json` 加 `model_preset`（`"best"` | `"fast"`，不填 = 不用预设）：

```json
{
  "fallback_enabled": true,
  "fallback_providers": ["deepseek", "xai", "ollama"],
  "model_preset": "fast"
}
```

- 预设只排**兜底尾巴**的顺序，不换主模型：链首永远是用户配的主模型，
  预设排的是“主模型挂了之后先试谁”。主模型本身想换档时，看
  `nyra models preset` 的排序、手动改 `provider` / `model`。
- 排序键只用内置模型表的硬数据（窗口、价格、视觉支持），不编质量分：
  - **fast（便宜优先）**：输入价升序 → 输出价升序 → 窗口降序 → 模型名升序。
    没核实价格的排最后——不编价格，也不假装它便宜。
  - **best（能力优先）**：窗口降序 → 支持视觉优先 → 输入价升序 → 模型名升序。
- 每机器人自己的备用链（显式 `fallback_providers`）优先于预设——
  显式指定的顺序不动。预设不碰 `fallback_enabled` 总开关：开关关着时
  链仍只有主模型，预设只在“兜底已开、链不止一家”时生效。
- `nyra models preset` 只看不改（当前预设 + 排过序的链 + 该预设前 5 的模型）；
  `nyra models preset best|fast` 写入配置；`nyra models preset off` 清掉。

## 故障账本：标 degraded，计时恢复（G-P1-33）

模型出故障时，Nyra 把它标 degraded，默认 **5 分钟**内不再选用，时间到
自动恢复（Botpress 同款 5 分钟）：

- 账本 `~/.nyra/model-health.json`（0600 原子写，损坏先备份再回空账本）：
  provider 名、恢复时间 `until`、短原因、累计次数。恢复是时间驱动的
  惰性恢复——读账本时拿 `until` 跟现在比，过期就当没标过，不用另起
  定时器扫。
- **什么时候标**：兜底链里某一家可恢复失败、真切换走之前，把刚失败那家
  标 degraded，恢复时间挂在切换记录上。认证错（401/403）不可恢复、
  根本走不到切换，也就不会标——标 degraded 的只会是“过会儿可能好的”
  故障（用量触顶、限流、服务端错误、超时、网络错误）。
- **过滤口径**：建链时按账本过滤兜底尾巴（链首主模型永远保留——用户
  显式配的主模型即使刚出过故障，下一轮照样先试它，失败了再按链走）；
  过滤后至少剩链首，永不返回空链。账本写失败不拦切换、不拦建链。
- **用户看到什么**：切换通知里多一句“`{from}` 已标故障，`{until}` 前
  不再选用”（`until` 是本地时间短格式）；审计行多 `degraded_until`；
  `model_switch` 事件同样带 `degraded_until`。`nyra models fallback`
  里有故障账本行；`nyra models health` 列出当前被标故障的模型（恢复
  时间、原因、累计次数），`nyra models health clear <provider>` 提前恢复它。
- **队列/定时任务**：照旧不切换（见下）——也就不会标 degraded。

## 429 接力：限流识别 + 接力摘要 + 接力记录

借 Kooyu 的 429 接力（只借想法不照抄）：限流把任务打断时，Nyra 不只
换模型、发一条通知，还给下一个模型留一份“接着干”的摘要——最近任务、
最近进展、已做修改（勿重复）。半自动到此为止：摘要只生成、只存证、
只在通知里引用，**不自动开新会话续跑、不自动重试已失败的调用**。
续跑是主控或用户手动做的事（`nyra models handoff <id>` 看摘要，拿着
它去新会话里继续）。

**限流识别**：对模型报错文本做正则识别（Kooyu 同款表，中英文都认）：
`429`、`rate limit`、`too many requests`、`quota exceeded`、`usage limit`、
`capacity exhausted`、`overloaded`、`credit balance`、`insufficient_quota`，
中文“限流、配额、过于频繁、额度用尽/不足/耗尽”。命中即限流类；分档仍
按老口径——配额类文案（`quota exceeded`、`配额不足`等）先判 quota
（终结：不重试同一家、直接换），其余判 rate_limit（先重试同一家 2 次，
再换）。新增：状态码不是 429、但文案明说限流的也认，例如 503 +
`capacity exhausted`、500 + `overloaded` 会判 rate_limit 而不是笼统的
server。认不出来的报错按原有逻辑走，不把所有报错都当限流。

**接力摘要**：限流/配额触发切换时才配，非限流切换没有。内容（新模块
`src/quotaHandoff.ts`，`buildQuotaHandoff`，纯函数）：

- 最近任务：最后一条用户消息（≤500 字）；
- 最近进展：最后一条模型回复（≤500 字）；
- 已做修改：对话里模型调过的工具（工具名 + 路径，如
  `write_file src/login.ts`，去重、最多 10 条；没有写操作时明说没有，
  不编清单）；
- 末尾固定一句：“请基于当前工作区现状继续完成未竟工作，勿重复已完成
  修改；不要重发已失败的调用。”

摘要里的文本与审计同款脱敏（home 目录换 `[home]`、Key 样字符串与
≥32 字连续词串换 `<redacted>`、超长截断），token 原文不进记录。

**接力记录**：每份摘要一条记录（id `qh_` + 12 位十六进制），存
`~/.nyra/quota-handoffs.jsonl`（append-only 0600，写失败不拦运行；
同 id 只存一次）。审计行里的 `handoff_id` 就是这条记录的 id，两边
对得上。`nyra models fallback` 在有接力时多露一行本月接力次数与最近
一次的 id。

**通知里的引用**：切换通知还是立刻发（终端 stderr、网关事件流、群聊
回复内附），限流切换时末尾多一句接力摘要的 id 与查看办法，例如
“接力摘要已存证（qh_abc123，运行 `nyra models handoff qh_abc123`
查看）”——只引用，不把全文塞进通知。

**查看**：`nyra models handoff` 列最近 10 条（新的在前），
`nyra models handoff <id>` 看一条的全文。只读，不续跑。

**用量汇总里可见**：本月切过模型时，`nyra stats`、运行结束汇总、
`nyra cost --show`（文本与 `--json` 的 `monthly.model_switches`）里多一行
切换统计——本月次数、触发原因分布、最近一次从谁切到谁；0 次时不打印。
`nyra models fallback` 一次看清开关、链顺序与本月切换统计（含最近一次
的报错原文）。

## 对话中途换模型：`/model`

REPL 里：

```
/model                              查看当前模型、允许切换的名单、自动换开没开
/model xai                          切到 xai（默认模型 grok-4.3），本次会话有效
/model deepseek:deepseek-v4-pro     切到指定模型
```

- **不丢历史**：只换 provider，会话消息、工具状态、检查点、用量累计
  原样保留——新模型接到的就是同一段对话。
- **只做同 OpenAI 兼容协议内切换**：Codex CLI provider 不能中途接入或
  切出（它走子进程、没有可复用的会话），要用 Codex 请退出重进并用
  `--provider codex` 指定。
- **只切允许列表**：名单是 `primary + fallback_providers`（与兜底链同一份，
  不受 `fallback_enabled` 开关影响——手动换是用户当场点的显式动作，
  不是静默自动切换）。列表外的拒绝并告诉你允许哪些；目标没有凭证也拒绝。
- **换完的模型照样能自动换**：新链以目标为 primary、兜底开关与本次运行
  一致；上下文窗口与单价按新模型重配（`nyra models` 的内置表口径）。
- **留痕**：手动切换同样发 `model_switch` 事件（`trigger: "manual"`），
  进 `events.jsonl`。

`/model` 只改本次会话，不写 `config.json`。要持久换主模型，改配置的
`provider` / `model`，或用 `--provider/--model`、`--profile`。

## 换模型留痕：事件里有什么

自动换与手动换都发 `model_switch` 事件，`events.jsonl` 里一行：

```json
{"at": "2026-11-20T...", "type": "model_switch", "from": "deepseek / deepseek-flash", "to": "xai / grok-4.3", "reason": "用量上限 (HTTP 429)：…", "trigger": "quota", "kind": "quota", "status": 429, "spent_usd": 0.0123}
```

- `trigger`：`quota`（用量触顶）/ `rate_limit` / `server` / `timeout` /
  `network` / `other` / `manual`（手动切换）。
- `spent_usd`：切换当时本次运行已花费（美元）；未配单价或 provider 未报
  用量时为 `null`，不编数字——与成本硬顶同口径。
- `nyra evidence verify` 复核时，`model_switch` 事件与工具调用一样是
  运行记录的一部分。

## 哪些场景不会自动换

- 兜底没开（默认）：触顶直接失败，报错写清是用量上限、不要重复重试。
- 队列 / 定时任务：失败即失败，不换、不重排（失败会进任务记录，等人处理）。
- 备用链里没有能用的下一家（都没配 Key、或列表为空）：失败，报错列出
  每一家的失败原因。
- 认证错、未知模型、安全拦截、用户中断：直接失败，不换。
- 主 agent 是 Codex CLI provider 时：没有兜底链（CLI 不进兜底链）。

## 已知局限

- 中途换模型只做同 OpenAI 兼容协议内切换；Codex CLI 与 Ollama 本地模型
  之间、以及涉及非 OpenAI 协议的模型，暂不支持中途切换。
- 备用链切换后，新模型的上下文窗口按 `nyra models` 的内置表 / 刷新缓存
  解析；表里没有的模型窗口未知时不编数字，自动压缩阈值按未知处理。
- 网关（`nyra ui`）的自动切换沿用全局配置；每会话在网页端单独开关
  兜底、以及 Web UI 模型卡，属于 desktop/（Hark），不在本批范围。
- 群聊机器人中途换模型（`room.json` 改 bot 的 provider/model 后）下次
  发言生效，正在跑的那轮不换。

## Tool Model：工具续跑轮走便宜模型（`config.tool_model`，默认关）

一轮 agent 循环里，读工具结果、继续调工具这些**机械续跑**对模型能力要求低，却按主模型价格计费。

```json
{ "tool_model": "cheap-model" }
```

判定规则（`shouldUseToolModel`，纯函数）：

| 场景 | 用谁 |
|---|---|
| 首轮（还没有 assistant 消息） | 主模型 |
| 上一条 assistant 有正文（已答过用户） | 主模型 |
| 上一条 assistant 只有 `tool_calls`、无正文 | **tool_model** |
| 没配 `tool_model` | 主模型（默认关） |

### 兜底：最终答复不交给便宜模型

模型可能在「续跑轮」里直接给出最终答复。所以 agent 侧有一条硬兜底：
**便宜模型产出的响应若没有 `tool_calls`，就用主模型重发一次**，并记 `tool_model_escalated` 事件。

这条兜底意味着：最坏情况下你在最后一轮多付一次调用费，但**不会**让用户拿到便宜模型写的答复。
省下的钱不能拿答复质量换。

### 与 `compact_model` / `delegate_model` 的关系

三者同属辅助路由（`resolveAuxRouting`），都会在配成"与主模型相同"时被忽略并记进 `ignored`——
配置成同一个值等于没配，不假装优化。
