# 企业治理控制面（缺口 43，第一批：DSH-1 + DSH-2 + G-4 的治理部分）

Bot 往企业方向走，第一件要补的不是功能，是治理：谁有权让它干什么、策略
改了旧授权还算不算数、没人看着的时候它能不能自己接活、自优化的提议谁拍
板。本批（2026-11-21，7×24 无人值守第三批，带刹车）立了四件东西：

- **版本化 Policy**（DSH-1）：策略每次改动算一个版本哈希；
- **不可变 Mandate**（DSH-1）：授权绑定发布时的 Policy 版本与哈希，不可变，
  恢复/续跑前按当前 Policy 重验证；
- **observe / auto 两档 + 干跑记录**（DSH-2）：Bot 主动工作默认 observe，
  评估通过只记“如果放行会接”，不真干；
- **带人批的自优化环**（G-4）：提议只起草，须人批才生效，三数据集 +
  holdout 定放行。

SSO/SCIM、分层成本上限、审计导出是缺口 43 定义里剩下的活，本批不做（见
末尾“本批没做的事”）。

## Policy：版本化策略

账本 `~/.nyra/governance-policy.json`（原子写 0600，损坏先备份再抛错），
一节 `current` + 历史（最多 50 个版本）。

```bash
# 发布新版策略（--reason 必填，写清楚为什么改）
nyra governance policy publish --reason "收紧 git 写操作" \
  --deny "Bash(git *)" --allow "Read" --ask "Edit"
# 不给规则 = 沿用当前策略的规则；首次发布用默认空规则
nyra governance policy publish --reason "只改原因"
nyra governance policy show [--json]
nyra governance policy list [--json]
```

- 版本号从 1 起，每次发布 +1；哈希 = SHA-256（版本号 + 范围 + 三档规则，
  规则排序后算），改动一行规则就换哈希。
- 规则写坏了直接拒绝发布（`parseRules` 的 warnings 非空就抛错），不静默
  丢规则——写了以为挡住了、实际没生效，是最危险的静默失效。
- 发布时通知受影响的工单：仍在 active、绑定旧版本 Policy 的授权所覆盖的
  任务板任务（未终态的 queued / working / review），同时写一条收件箱消息
  （`nyra governance`，`policy_changed`）。通知写不上不拦发布，但会打印
  一句说明。

## Mandate：不可变授权

账本 `~/.nyra/governance-mandates.json`（原子写 0600）。Mandate 的字段：

| 字段 | 含义 |
| --- | --- |
| `id` | `md_` + 12 位 hex |
| `scope` | 范围，例如 `agent:nyra`、`global`、`run:<id>`、`task:<id>` |
| `strength` | `observe` / `auto`（签发时定，不可改） |
| `rules` | 授权自带的 allow / ask / deny 规则（可空） |
| `issuer` | 发送者身份（谁签的） |
| `channel` | 接收方式：`cli` / `telegram` / `discord` / `api` / `gateway` |
| `policyVersion` / `policyHash` | 签发时绑定的 Policy 版本与哈希 |
| `status` | `active` / `superseded` / `revoked` |

```bash
nyra governance mandate issue --scope agent:nyra --issuer owner \
  [--strength observe|auto] [--channel cli] [--allow "Bash(git *)"]
nyra governance mandate list [--status active|superseded|revoked] [--json]
nyra governance mandate show <授权 id> [--json]
nyra governance mandate revalidate <授权 id>
nyra governance mandate revoke <授权 id> --reason <原因> --yes
```

重验证（`revalidate`）三态：

- **current**：已是当前 Policy 版本，原样返回；
- **renewed**：旧版本且无冲突——换发新授权（新 id，绑定当前版本），旧授权
  标 `superseded`（`supersededBy` 指向新授权）。顺着旧 id 再验，会跟着
  superseded 链找到当前授权；
- **conflicted**：旧版本且有冲突——原授权不动，调用方必须拒绝续跑/恢复
  （CLI 退出码 2）。冲突判定：授权里每条 allow / ask 规则，拿当前 Policy
  的规则集求值，命中 deny 就是冲突。

撤销（`revoke`）是终态：已撤销的授权不能续跑或恢复，须重新签发。

**续跑 / 恢复前重验证**（钩子已接线）：

- `nyra subagent resume` / `prepareSubagentResume`：绑了授权的运行（注册
  表 `mandateId`，`nyra subagent register --mandate <id>`），续跑前先重验
  证——冲突、撤销、不存在时直接抛错、拒绝续跑；换发了新授权就更新注册表
  上的绑定。
- `nyra side-effects recover`：绑了授权的副作用（`nyra side-effects
  record --mandate <id>`）同理，验证失败标 `failed`、不执行；换发了更新
  绑定。

## observe / auto：接单模式

账本 `~/.nyra/governance-modes.json`。每个 agent 一档，默认 **observe**。

```bash
nyra governance mode show [--agent <名字>]
nyra governance mode set --agent <名字> observe
nyra governance mode set --agent <名字> auto --yes   # 切 auto 须 --yes
```

- **observe**：Bot 主动工作先默认这档。评估通过只记干跑记录，不真干。
  人看过记录没问题，再显式切 auto。
- **auto**：评估通过可执行，但仍受月度硬顶与审批约束——auto 不是免审批，
  只是“评估通过不用先记干跑”。

**月度硬顶门**（接单前先套）：`checkAutoAllowed` 读本月用量账本（LLM +
MCP）与 `config.json` 的 `monthly_cost_limit_usd`，已触顶就不接。没配上限
就不挡人（`checkMonthlyCap` 的语义：上限为 null 时不超）。

**“would accept”评估**（`evaluateProactiveAction`，只判定、不执行）：

1. 月度硬顶已触顶 → `would-deny`；
2. 工具命中红线表 never 档 → `would-deny`；命中 approve 档 →
   `would-accept` 但 `requiresApproval: true`；
3. observe 模式 → `would-accept`（只记干跑，不真干）；
4. auto 模式 → `would-accept`（可执行，仍受月度硬顶与审批约束）。

## 干跑记录

账本 `~/.nyra/dry-runs.jsonl`（append-only，0600）。一条记录 = 一次“如果
放行会接”的评估：agent、类型（`kind`，如 `resume_subagent`）、动作、目
标、原因、预估花费（可空）、状态（`recorded` / `promoted` / `discarded`）。

```bash
nyra governance dry-runs list [--agent <名字>] [--status recorded|promoted|discarded] [--json]
nyra governance dry-runs show <记录 id> [--json]
nyra governance dry-runs promote <记录 id> --yes
nyra governance dry-runs discard <记录 id> --yes
```

- 同一待办（agent + kind + action + target）只留一条未定的记录，不重复
  记；定夺后可再记一条新的。
- `promote` / `discard` 只改账本状态，**不执行任何动作**——要执行请手动
  操作。干跑记录是“人看过、没问题”的凭证，不是执行器。
- 两处自动记干跑（都是 observe 模式下）：
  - 启动扫荡的自动续跑（`sweepSubagents`，`auto: true`）：observe 模式或
    月度硬顶挡下的续跑，只记干跑、不真干（`SweepReport.dryRuns`）；
  - Heartbeat：巡查发现待续跑子 agent 时，observe 模式只记干跑。

## 自优化环（G-4）

提议账本 `~/.nyra/optimization-proposals.json`（原子写 0600）。proposer
只起草改指令建议，须人批才生效；三数据集 + holdout 定放行。

```bash
# 从回归用例起草（按失败种类套模板，追加到指令文档末尾）
nyra optimize propose --target docs/notes.md --from-regression rg_xxxx
# 人工起草（--old-text 为空表示追加；非空表示替换，须恰好出现一次）
nyra optimize propose --target docs/notes.md --old-text "旧行" --new-text "新行" \
  --rationale "为什么改" [--train-cases a,b] [--validation-cases a,b] [--holdout-cases a,b] \
  [--train-tests tests/node/x.test.ts] [--validation-tests ...] [--holdout-tests ...] \
  [--max-iterations 3] [--max-minutes 60]
nyra optimize list [--status draft|approved|rejected|applied|released|failed] [--json]
nyra optimize show <提议 id> [--json]
nyra optimize edit <提议 id> [--old-text ...] [--new-text ...] [--rationale ...]
nyra optimize approve <提议 id> --yes [--note ...]
nyra optimize reject <提议 id> --yes [--note ...]
nyra optimize apply <提议 id> --yes
nyra optimize verify <提议 id>
nyra optimize revert <提议 id> --yes
```

状态机：`draft` → `approved` / `rejected` → `applied` → `released` /
`failed`；`failed` 可修订回 `draft` 再批再改；`revert` 把已应用的改动还
原、提议回 `draft`。

- **提议是确定性的模板起草**：从回归用例的失败种类（`tool-failed` /
  `delegate-failed` / `verdict-failed` / `llm-failed` / `run-error`）套
  一句话教训，或人工手写。不调模型、不花 token、不自动改代码。
- **人批是硬门**：`draft` 不能 `apply`，批过才能改文件；批过的提议不能
  再改（想改请重新起草，或等它 `failed` 后修订回 `draft`）。
- **验证**：先跑 validation 测试，再跑 holdout 测试。两者都过才放行
  （`released`）；任一不过自动回滚文件、状态标 `failed`。没有测试文件时
  对应项跳过。验证超时按失败处理。
- **回滚是确定的文本还原**：追加的去掉追加的尾巴，替换的把新文本换回旧
  文本。目标文件在验证前被别人改动、还原对不上时，不硬写、标 `failed`
  等人工处理。
- **循环有硬上限**：`maxIterations`（默认 3，1–10）、`maxMinutes`（默认
  60，5–600）。`maxCostUsd` 恒为 null——确定性起草不花钱，成本上限在本
  批没有意义。
- **目标文件边界**：只限工作目录下的 `.md` 指令文档（相对路径），不碰
  `MEMORY.md`、不进 `.nyra/`、不越出工作目录。验证测试只限
  `tests/node/` 下的 `.test.ts` 文件；回归用例 id 须在库里存在。

## 评测驱动的优化闭环（G-P1-29）

`nyra optimize loop` 把评测报告接进自优化环：读报告 → 失败聚类成臂
→ 自动起草提议 → UCB 排队；verify 的结果回填进臂账本，下一份报告重排。

```bash
nyra optimize loop --eval-report docs/eval-results/<报告>.json --target docs/notes.md [--json]
nyra optimize arms [--json]
```

- **只读已完成的报告**：须是 schemaVersion 1 的 nyra-real-tasks-v1 报告，
  未跑完、目录外任务 id 都拒绝；loop 不重跑评测（评测要花模型钱），只读
  人跑好的报告。
- **聚类**：只看每题第一次尝试；passed/blocked 不进簇；簇键 = 类别
  （code/browser/research/connector）+ 首个未通过的验收项 id（无验收项
  记 no-checks）。
- **起草**：没有未结提议（draft/approved/applied）的簇自动起草一条模板提议
  （来源 `eval-report`，带 armKey）；已有未结提议的簇复用，不重起。起草
  的都是 draft，不改文件。
- **UCB 排队**：臂账本 `~/.nyra/optimizer-arms.json`（原子写 0600）；分数
  = 均值 + √2·√(ln(总拉动 + 1)/拉动)，没拉过的臂优先，分数相等按 key 升
  序；`arms` 看排行，loop 结束打印下一条最值得批的提议。
- **回填**：verify 放行记奖励 1、失败记 0（拉动次数只在 verify 时 +1）；
  闭环跨报告跑，一轮 loop 只处理一份报告。
- **apply 仍须人批**：批过才能改文件，验证不过自动回滚——loop 不改变
  这条硬门。

## 分层成本上限（缺口 43 第三批）

组织级上限就是已有的月度硬顶（`config.json` 的
`monthly_cost_limit_usd`，本月 LLM + MCP 花费；见 `docs/cost.md`）——
**组织级没有第二套数字**，`caps set org` 直接拒绝。分层是叠加在
它之上的第二道门，只在它下面分：

| 层 | 范围 | 花费怎么算 |
|---|---|---|
| `org` | 组织级 | 本月 LLM + MCP（唯一含 MCP 的层） |
| `team:<id>` | 团队 | 成员 agent 的花费之和 |
| `role:owner` / `role:user` | 角色 | 请求方账号的角色（Bot 侧 `this.agent` 归属的账号角色） |
| `agent:<id>` | 单个 Bot agent | 该 agent 自己的花费 |
| `persona:<id>` | 人设（Soul） | 该 Soul 的花费（与 agent 层同一份数） |

多层同时设了，取最严的一层（先超的先触发）。子层上限超过组织级
上限时直接拒绝设置——要先显式抬组织级。没配组织级上限时子层各自
生效。

- **账本**：`~/.nyra/cost-caps.json`（上限 + 团队归属 + 放宽记录，
  0600、原子写）与 `~/.nyra/cost-pauses.json`（暂停记录，0600、
  原子写）。上限 100 条封顶，超了先删旧的再设。
- **归属**：用量账本每行多一个可选 `agent` 字段（`src/usageLedger.ts`
  的 `recordDelta` 末参）。CLI 定时任务 `--agent` 与 Bot（`this.agent`）
  的运行按 agent 记账；CLI 交互运行没有 agent id，不记归属——
  分层分不下去，但组织级月度硬顶照样管它。MCP 花费没有 agent
  归属，只在组织级计入。
- **分层花费是下界**：未归属的行分不下去，只会晚触发、不会误触发。
  账本里有未归属/未计价的行时判定结果带 `incomplete: true`，
  美元算不出时该层只判 token。
- **放宽要留痕**：抬高或取消上限记一条 `cost_cap_relaxed`（谁放的、
  什么时候、从多少到多少），进 `~/.nyra/governance-audit.jsonl`，
  有运行上下文时镜像运行事件；设置记 `cost_cap_set`。
- **触顶是可恢复暂停，不是丢弃**：运行中触顶（`Agent.checkCost`
  的分层回调，`makeTieredCapCheck`）先建暂停记录再抛错中止
  （与月度硬顶同级硬停）；暂停记录带 runId / taskId 引用——
  运行记录与任务板行就是检查点，不另写检查点文件。同 agent
  同层同月只留一条暂停记录。任务板多一个 `paused` 状态：
  `nyra kanban pause <id> "<原因>"` / `resume <id>`（恢复回
  queued，attempts 不动、不进熔断计数）；`kanban sweep` 扫到
  因分层上限已超而失败的运行，走暂停路径不是 fail 路径。
  放行（`caps resume <暂停 id>`）先重判一次，还超就拒绝。
- **金额未知暂停**：未配单价或调用缺用量时，严格模式（默认开）下建一条
  scope 为 `unknown-amount` 的暂停记录（不是分层触顶，不走分层重判；
  恢复条件见 `docs/budget.md`：严格模式已关、或该模型现在能解析出单价时放行）。
- **接单门**：`checkAutoAllowed` 在月度硬顶之后再套分层判定
  （observe/auto 接单前都判，触顶不接单）。分层判定本身出问题
  （账本损坏等）不拦接单——月度硬顶已在前面判过，分层是叠加
  的第二道门，不是第一道门的替代。

CLI（`nyra governance caps …`）：

```
nyra governance caps set <范围> [--usd <美元>] [--tokens <数>] [--yes]
nyra governance caps list [--json]
nyra governance caps show <范围>
nyra governance caps check [--agent <名字>] [--run-usd <美元>] [--run-tokens <数>] [--json]
nyra governance caps assign-team <团队 id> --agent <名字> [--yes]
nyra governance caps pause [--agent <名字>] [--task <任务 id>] [--run <运行 id>]
nyra governance caps pauses [--json]
nyra governance caps resume <暂停 id> --yes
nyra governance caps discard <暂停 id> --yes
```

`check` 超限退出码 2；`resume` / `discard` 须 `--yes`。

## 审计导出（缺口 43 第三批）

导出给 SIEM 的格式只一种：**JSONL**。每条记录带可验证的完整性——
哈希链：第一行是 `export_header`（含 10 份治理审计日志与策略/
授权文件的 SHA-256 指纹、导出时间、导出范围），之后每行带
`seq` / `prev_hash` / `hash`（SHA-256，稳定序列化后算）；导出后
能验出篡改（`audit verify` 验头部哈希、seq 连续、prev_hash 衔接、
hash 重算；来源文件漂移只警告，不判失败——导出那一刻的指纹在
头部里，事后文件变了是正常的追加）。

覆盖的 10 份治理审计日志：`governance-audit.jsonl`（策略/授权/
模式/干跑/提议 + 本批的上限与暂停）、`sso-audit.jsonl`、
`accounts-audit.jsonl`、`business-redlines-audit.jsonl`、
`soul-audit.jsonl`、`trust-ladder-audit.jsonl`（信任阶梯）、
`model-switch-audit.jsonl`（备用模型切换）、`bot-audit.jsonl`
（缺口 27：渠道路由决定——routed/dropped + 绑定/规则/原因）、
`script-preauth-audit.jsonl`（Pi Bot 借鉴第 1 条：脚本预授权——granted / revoked / used / refused）、
`handover-contract-audit.jsonl`（Pi Bot 借鉴第 2 条：交接契约验收——created / linked / checked / resolved / closed）。策略文件（`governance-policy.json`、
`governance-mandates.json`）与上限账本（`cost-caps.json`、
`cost-pauses.json`）只导出指纹，不导出正文。运行级证据链
（`runs/` 下的 `events.jsonl`）不在本导出里——那是运行证据，
不是治理审计。

```
nyra governance audit export [--from <ISO 日期>] [--to <ISO 日期>] [--out <文件>] [--force]
nyra governance audit verify <导出文件>
```

`--out` 已存在时拒写（除非 `--force`），写出的文件 0600；
不给 `--out` 时导出走 stdout、摘要走 stderr。导出操作本身记
一条 `audit_exported` 进 `governance-audit.jsonl`（导出多少行、
出文件的 12 位指纹、覆盖了哪几份来源）。`verify` 失败退出码 2。

只记元数据与指纹：导出里不出现邮箱、token、secret、绝对路径——数据行在
导出前脱敏（home 目录换成 `[home]`，其他用户路径前缀换成 `[path]`，
密钥样字段的值换成 `<redacted>`），哈希链在脱敏后的行上算。

## 审计与事件

- 审计链 `~/.nyra/governance-audit.jsonl`（append-only，0600）：策略发布、
  授权签发/重验证/替代/撤销、模式切换、干跑记录与定夺、提议创建/定夺/
  应用/放行/失败，都记一笔。写失败不抛错（审计丢了不该拦住正事）。
- 运行事件（`src/runs.ts` 的 `EVENT_FIELDS`，有运行上下文时镜像）：
  `policy_changed`、`mandate_issued`、`mandate_revalidated`、
  `mandate_superseded`、`mandate_revoked`、`governance_mode_changed`、
  `dry_run_recorded`、`dry_run_decided`、`proposal_created`、
  `proposal_decided`、`proposal_applied`、`proposal_released`、
  `proposal_failed`、`proposal_reverted`。事件里只记 id 与指纹（SHA-256
  前 12 位），不记原文、不记绝对路径。
- 缺口 43 第三批新增运行事件：`cost_cap_set`、`cost_cap_relaxed`、
  `cost_cap_paused`、`cost_cap_resumed`、`cost_cap_discarded`（只记
  范围、字段、数值、暂停 id、agent，不记原因原文）。`audit_exported`
  没有运行上下文，不镜像运行事件——`governance-audit.jsonl` 里那条
  就是记录。

## 本批没做的事（诚实边界）

- SSO / SCIM（第二批已做）、分层成本上限与审计导出（第三批已做，
  见上两节）——缺口 43 定义里的三项至此做完。
- 只在假接口/假环境上验过：真实 Telegram / Discord Bot 未接通（token
  仍等用户），sweep 与 Heartbeat 的干跑只在假注册表与假 home 上验过；
  自优化环的 verify 默认跑真 `bun test`（CLI 端到端已用真测试文件验过
  通过与失败两条路），但没在真实生产指令文档上跑过。
- Policy 通知只覆盖任务板上未终态的任务；定时任务与审阅队列里的工单不
  在通知范围内。
- `evaluateProactiveAction` 的 never 档分支经工具路径测不到——目前只有
  `gmail_send` 映射到业务动作（approve 档），never 档的业务动作（交易
  证券、转移资金等）没有对应的 Nyra 工具。
- Windows / macOS 真机未验证。
