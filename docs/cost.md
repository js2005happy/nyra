# 成本：用量、硬顶与热力图

> 缺口 20（用量热力图 + 429 冷却显示 + 运行级统计头）与缺口 29（月度支出硬顶），2026-11-20。
> **2026-11-27：月度上限已全部移除（见下“月度上限已移除”一节），缺口 29 废止。**
> 定位锚点不变：**跑完能自证、成本有硬顶、权限有边界**。本页只讲成本那条。

## 一句话

- 单次运行上限 `--max-cost` / `max_cost_usd`：一次运行花超即停。
- 本月花费只记账、只展示，不再有月度上限（2026-11-27 移除）。
- 用量账本 `~/.nyra/usage_daily.jsonl`：单次上限、分层每日上限与热力图共用同一份数，
  只记 provider 实报的 token 与已算出的金额，不估算、不补编。

## 月度上限已移除（缺口 29 废止，2026-11-27）

月度上限（`--monthly-max-cost` / `config.json` 的 `monthly_cost_limit_usd`、
`resolveMonthlyLimit` / `checkMonthlyCap` / `monthlyCapDecided`）已全部拿掉，
包括首次花钱必选上限的那道门（网关 `requireMonthlyCapDecision`）。
旧配置里写了月度上限也不再生效；设置端点再收到该键会报“不支持的设置项”；
`nyra cost --show --json` 与 `nyra stats --json` 不再输出 `limit_usd` /
`monthly_limit_usd` 字段。

留下的只有两样：

- **本月花费记账与展示**：`本月已花 = 本月 LLM 花费（用量账本）+ 本月 MCP 花费（mcp_spend.jsonl）+ 本次运行进行中的花费`，照常能看见；有未计价记录时本月合计只是**下界**（实际花费只会更高），只用于展示，不触发任何判定。
- **每条任务自身的硬顶**：单次运行上限 `--max-cost` / `max_cost_usd`（一次运行花超即停）与分层每日上限（见下）不动。子任务继承单价与单次上限，子任务花的钱同时进账本与父级的单次硬顶合计——委派不是旁路。

### 诚实边界（与 `--max-cost` 同一条）

- 未配单价 / provider 未报用量时算不出金额：**有美元上限（单次）且严格模式开（默认开）时暂停运行**等人工处理（可靠性打磨第 2 项，详见 `docs/budget.md`）；没配任何美元上限、或严格模式已关时才不抛错、不假装封顶，只把状态留在 `lastCost` 里。分层回调的 token 层不需要单价，单价未知时仍照常判 token 层。
- 与 #61 回忆感知的成本估算的关系：**月度累计只计实际花费**（上报用量
  × 单价）。回忆下调只影响 `nyra cost --estimate` 事前估算的悲观档，
  是“有历史可复用时可能少跑几轮”的投影，不进实际累计。

### 查看

```
nyra cost --show        # 定价、单次上限与本月已花
nyra stats              # 本月累计 + 今日 + 最近 7 天
```

## 分层成本上限（缺口 43 第三批）

分层上限只剩 **agent 每日层**（美元与 token 两维，本地自然日 0 点重置）。
月度上限已移除，组织级 / 团队 / 角色 / 人设层与月度维一律不再接受，
旧 caps 文件读时迁移（剥月度字段、丢无剩余限额的层）。
详见 `docs/governance.md` 的「分层成本上限」一节；这里只讲成本口径：

- **没有组织级上限**：`caps set org` / `team:` / `role:` / `persona:` 直接拒绝；
  只 `agent:<id>` 可设每日上限。
- **同一份数**：分层花费按用量账本的 `agent` 归属拆分（定时任务
  `--agent` 与 Bot 的运行按 agent 记账；CLI 交互运行没有 agent id，
  不记归属）；MCP 花费没有 agent 归属，只在组织级计入。
- **分层花费是下界**：未归属的行分不下去，只会晚触发、不会误触发；
  美元算不出时该层只判 token。
- **触顶是可恢复暂停**：运行中触顶先建暂停记录再抛错中止（与单次
  硬顶同级硬停）；暂停记录带 runId / taskId 引用，任务板多一个
  `paused` 状态（`nyra kanban pause` / `resume`，恢复回 queued，
  attempts 不动）。放行前先重判，还超就拒绝。
- **放宽要留痕**：抬高或取消上限记 `cost_cap_relaxed`（谁放的、
  什么时候、从多少到多少），进治理审计链。

```bash
nyra governance caps set agent:nyra --day-usd 5 --day-tokens 100000 --yes
nyra governance caps check --agent nyra
nyra governance caps pauses
```

## 用量热力图（缺口 20）

```
nyra stats heatmap [--weeks N]   # 默认 8 周；N 为 1–52
```

- 行 = 周（最旧在上），列 = 周一…周日；格子深浅按单日 token 量相对
  当期最高值分档（`· ░ ▒ ▓ █`）。
- 格子只管“一眼看趋势”：每天的精确 token 数与花费在下方逐日列出
  （最近 14 天），不靠深浅猜数字。
- 账本从本批起才开始记，**此前的运行没有留存用量，不补编历史**；
  账本为空时如实说“暂无用量记录”。
- REPL 里同样可用：`/stats` 看本次会话用量与本月累计，
  `/stats heatmap [周数]` 看热力图。

## 429 冷却倒计时（缺口 20）

被限速重试时，等待时间直接显示在用户眼前：

- TTY 的 spinner 行变成 `限速冷却：<provider> 第 N 次重试，约 Ns 后继续…`，
  每秒减一；非 TTY / 一次性任务写一行 stderr；`--json` 发一个
  `rate_limit_cooldown` 事件（含 `provider` / `attempt` / `delay_ms` / `kind`）。
- 等待时间 = 本次重试计划的 `delayMs`：服务端 `Retry-After` 与客户端
  退避（1s/3s + 抖动）取最大值；服务端没给 `Retry-After` 时只显示
  客户端退避，不编一个假的等待时间；`Retry-After` 封顶 10 分钟。
- 只有真的发生重试时才显示：单 provider 单 Key 没有重试循环时，
  429 直接报错，没有冷却可显示。注意：用量上限类 429（文案含
  “用量上限/额度已用完”）不重试、不显示冷却，直接按终结错误处理。

## 运行级统计头（缺口 20）

`nyra evidence verify <运行 ID>` 与每次运行结束的报告顶部都有一行：

```
运行统计：用时 12.3s · 轮次 5 · LLM 调用 5 · 工具调用 12 · 错误 1 · 花费 $0.0234
```

- 时长、轮次、花费来自 `state.json`（用量摘要在运行结束时落盘，
  子任务的花费单独记 `delegate_spent_usd`，不漏也不重复计）；
  调用数与错误数从 `events.jsonl` 数出来。
- 数不出的字段写“未知”，不猜；有未计价用量时花费后标
  “（部分用量未计价，实际花费只会更高）”。
- 前置修复：此前 CLI 一次性任务与 `--json` 是先建 `RunRecorder`
  再覆盖 `agent.onEvent`，把 recorder 的事件 wrapper 摘掉了，
  事件根本进不了 `events.jsonl`（只有 `run_started`/状态事件）。
  本批改成先挂 `onEvent` 再建 recorder，事件既显示又落盘；
  统计头的调用数才有真实来源。

## 已知缺口（原「本批没做」两条，现已补齐）

### 已补：网关入口的成本口径

- 网关（`nyra ui`）的 agent 现在接同一套 `maxCostUsd` / `pricing`
  （见 `Gateway.costOptions()`；月度上限已移除，不再透传），
  `send()` 与定时任务两个入口都接；运行中的 `usage` / `cost_update` 事件
  由 `Gateway.flushUsageToLedger()` 增量写账本。
- **已知边界**：多会话并发时并发会话之间不保证严格互斥（要严格需给账本写入加锁）。并发预算预留
  （可靠性打磨第 2 项，详见 `docs/budget.md`）给在途花费上了一把锁：
  同一本预留账本跨会话共享，调用前先预留、在途预留计入上限判定——
  但预留只锁增量，不是全量串行化。

### 已补：看板成本段含委派花费

- `DashboardSnapshot` 新增 `delegate_usd` / `run_total_usd`；
  `cost_update` 与 REPL 看板行在存在子任务花费时追加
  `（含子任务 $x，合计 $y）`，单 agent 口径的数字仍然保留。
- 没有子任务、或金额为 0 / 非有限值时**不加这一项**——不制造噪音，也不编造合计。

## 辅助模型省了多少：用账本算实测值

`nyra savings` 的 aux_model_routing 行现在直接给**实测**数字，不再写「单价差决定省多少，算不出」。

做法（`src/modelSavings.ts`，纯函数）：

1. 读用量账本（每笔都有 `model` / `prompt_tokens` / `completion_tokens` / `spent_usd`）
2. 对**非主模型**的每一笔，用**主模型单价 × 同样 tokens** 算反事实花费
3. 实际花费 − 反事实 = 省下的钱（可能是负数，说明辅助模型反而更贵——照实报）

三条纪律：

| 纪律 | 原因 |
|---|---|
| 缺 model 名或主模型没单价 → 不进合计，计入 `unknownCalls` | 算不出就说算不出，不填 0 |
| 反事实用**同一份 tokens**，prompt/completion 分开计价 | 混用总 token 会把节省算虚 |
| 负数照实报，文案写「多花」 | 配错比没配更该被看见 |

输出示例：

```text
辅助模型：实测省 $0.0230
  cheap：1 次 · 实际 $0.0020 · 主模型口径 $0.0250 · 省 $0.0230
```

## 机器可读：`nyra savings --json`

人看单页（默认输出），机器拿结构：

```bash
nyra savings --json
```
```
  "tokens_per_turn_total": 391,
  "unknown_count": 4,
  "lines": [
    { "mechanism": "disable_tool", "enabled": true,
      "tokens_per_turn_saved": 391, "additive": true, "effect": "…", "source": "…" }
  ],
  "model_savings": {
    "main_model": "…", "total_saved_usd": 0.023, "unknown_calls": 0, "main_spent_usd": null,
    "rows": [{ "model": "…", "calls": 2, "actual_usd": 0.002,
               "counterfactual_usd": 0.025, "saved_usd": 0.023 }]
  }
}
```

契约纪律（与 `nyra verdict --json` 一致）：

- **只加字段、不改名、不删字段**，客户端按 `schema_version` 判断兼容
- `tokens_per_turn_saved` 为 `null` 表示**算不出**，不是 0——把"不知道"写成 0 会让看板画出假的下降曲线
- 没传实测节省时 `model_savings` 为 `null`，不编造 0

## 机器可读：`nyra cost --show --json`

```json
  "model": "…",
  "pricing": [{ "model": "…", "input_per_1m": 1, "output_per_1m": 2 }],
  "invalid_pricing": ["配置无效的模型名"],
  "max_cost_usd": 5,
  "monthly": { "spent_usd": 1.2, "mcp_usd": 0.2, "month": "2026-11", "reset_at": "2026-12-01" },
  "budget": { "active_reserved_usd": 0.05, "strict_unknown_amount": true }
}
```

两条要紧的语义：

- **`max_cost_usd` 没配是 `null`，不是 0**——写成 0 会让 CI 把「没设上限」读成「上限为 0 美元」，报警逻辑直接反转
- **`invalid_pricing` 会点名**：配置里写了但解析失败的模型不再是"静默忽略"，CI 能直接报警

## 机器可读：`nyra stats --json`

成本侧第四个出口，回答「本月到底花了多少、每天花了多少」。

```json
{
  "schema_version": 1,
  "month": "2026-11",
  "month_tokens": 12000,
  "month_spent_usd": 1.5,
  "incomplete": false,
  "mcp_spent_usd": 0.2,
  "reset_at": "2026-12-01",
  "today": { "date": "2026-11-20", "tokens": 800, "spent_usd": 0.1, "calls": 3 },
  "days": [{ "date": "2026-11-19", "tokens": 900, "spent_usd": 0.2, "calls": 2 }]
}
```

关键语义：**「有调用未计价」与「真没花钱」是两件事**——

- 有调用但没配单价 → `month_spent_usd: null` + `incomplete: true`
- 真没花钱 → `month_spent_usd: 0` + `incomplete: false`

写成 0 会让看板显示「这个月免费」，把漏配单价彻底藏起来。