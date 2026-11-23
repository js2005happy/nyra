# 声明式可复用工作流（缺口 25）

多步活写成一个 DSL 文件，`nyra workflow run` 跑起来：步骤固定就按固定图跑；下一步要看情况定的，用协调者形态——一个协调者 agent 每轮决定下一步，还能在运行中生成新步骤；研究类任务、开始不知道要派生多少子问题，就用动态形态（种子步骤可以为空）。

做法借的是 Dify 的声明式 Workflow DSL（YAML/JSON 文本、节点编排、Human Input 审批节点）与 Proto 的三级复用阶梯（工作流激活前先拿真实数据试跑、通过才激活；非活跃测试只预览写/发动作而不真执行），不抄 Dify 的节点 API 形状与画布交互，也不拿 Proto 的演示数字当事实。G-5 的三种执行形态（固定图 / 协调者 / 动态）都已落地。

## 一个例子

```yaml
name: 每日简报草稿
version: 1
mode: fixed
description: 拉目录清单，起草一份简报，等人批了再存成文件
max_cost_usd: 0.5
triggers:
  - type: schedule
    cron: "0 8 * * *"
steps:
  - id: fetch
    type: tool
    tool: list_dir
    args:
      path: .
  - id: draft
    type: llm
    prompt: "根据以下目录清单起草今日简报：{{steps.fetch.output}}"
    if: steps.fetch.ok == true
  - id: check
    type: approve
    title: "简报草稿待确认"
    summary: "{{steps.draft.output}}"
    on_reject: skip
  - id: save
    type: tool
    tool: write_file
    args:
      path: "briefing.md"
      content: "{{steps.draft.output}}"
    if: steps.check.approved == true
```

## 节点

节点就是 Nyra 已有的东西，不是新概念：

| type | 意思 | 关键字段 |
| --- | --- | --- |
| `tool` | 调一个 Nyra 工具 | `tool`（名字，导入时对 `TOOL_SCHEMAS` 核对）、`args`（映射，值里能写模板） |
| `llm` | 一次模型调用 | `prompt`（必填）、`system`（可选） |
| `delegate` | 派一个子 agent 跑任务 | `task`（必填）、`max_turns`（1–12，默认 6） |
| `skill` | 按技能正文带路的 delegate 单次任务 | `skill`（技能名）、`task`（必填） |
| `knowledge` | 知识检索（缺口 1 的 BM25 同一套） | `base`（知识库名）、`query`、`top_k`（1–20，默认 5） |
| `approve` | 人工审批节点（复用审阅队列） | `title`（必填）、`summary`、`on_reject`（`fail` 默认 / `skip`） |
| `parallel` | 并行分支（2–8 个，嵌套上限 3 层） | `branches`（分支数组，每个分支是步骤数组） |

控制结构（不是新节点，是步骤上的通用字段）：

- `if: "<条件>"`——条件为假跳过该节点（记 `skipped`）。条件语法见下。
- `for_each: {items: "<模板>", as: <变量名>, max: <上限>}`——对列表逐项跑同一节点。`max` 默认 10、上限 50；列表长度超 `max` 直接拒绝，不静默截断。`items` 可以是 JSON 数组文本（上游工具节点输出的 JSON 数组）——inputs 只认标量、节点输出是字符串，循环否则拿不到数组。轮次结果记为 `<id>[0]`、`<id>[1]`……，合并节点记为 `<id>`（输出是各轮输出拼成的 JSON 数组）。

限制（违反的在 `import`/`validate` 时直接拒绝，不等跑到一半才炸）：

- 步骤 id 全工作流唯一，小写字母开头、只含小写字母/数字/`_`/`-`、不超过 32 字（模板与条件里的路径是 `[A-Za-z0-9_.]`，中文 id 写不进路径）。
- 节点总数（含并行分支内）不超过 50 个。
- 审批节点只认顶层步骤：不许放并行分支里（续跑要回到确定的顶层步号），也不许放循环里。
- 循环嵌套上限 3 层，并行嵌套上限 3 层（G-5 的 ADK 硬规矩：递归设硬深度上限）。
- `mode` 三选一：`fixed`（固定图）、`coordinator`（协调者）、`dynamic`（动态）。`coordinator` / `dynamic` 必须写 `goal`（目标陈述，1–2000 字；`fixed` 写了会被拒绝）；`coordinator` 配置（`max_rounds` 1–20 默认 10、`max_new_steps` 0–10，默认 coordinator 3 / dynamic 5）只用于这两种形态；`coordinator` 的 `steps` 是计划（非空），`dynamic` 的 `steps` 是种子步骤（可为空，但为空时 `max_new_steps` 不能同时是 0，否则没步骤可跑）。
- 动态生成的步骤不能是审批节点（审批须写进计划，或让协调者用 `ask` 停下来问人）；其余校验与计划步骤同一套（工具名对 `TOOL_SCHEMAS` 核对、id 唯一、字段合法）。

## 条件与模板

`if` 里的条件是确定性表达式，不调模型（G-5 的另一条硬规矩：简单决策用 if/else）：

- 变量：`inputs.<名>`、`steps.<id>.output|ok|approved|spent_usd`、`loop.<变量>|index`。
- 字面量：字符串（单/双引号）、数字、布尔、`null`。
- 运算符：`==` `!=` `>` `>=` `<` `<=`、`contains`（左边字符串含子串，或数组含元素）、`and` `or` `not`、括号。
- 未知变量、类型不匹配（比如对字符串用 `>`）、结果不是布尔值，一律抛错，不静默当 false。

模板用 `{{path}}`，路径与条件里的变量同一套：

- `{{inputs.channel}}`、`{{steps.fetch.output}}`、`{{loop.item}}`、`{{loop.index}}`。
- 整串恰好一个占位符时返回原始值（数组/数字/布尔不被串化）——循环的 `items` 就靠这个；嵌在句子里时按字符串拼。
- 未知变量抛错。

## 协调者与动态

`mode: coordinator` 与 `mode: dynamic` 共用一个协调者循环，差别只在起点：协调者的 `steps` 是计划（要跑哪些步骤、每个步骤是什么），动态的 `steps` 是种子步骤（可以为空，全部步骤运行中派生）。

```yaml
name: 调研简报
version: 1
mode: coordinator
goal: 调研三个竞品的定价，汇总成一份对比表
coordinator:
  max_rounds: 10
  max_new_steps: 3
steps:
  - id: fetch_a
    type: tool
    tool: read_file
    args:
      path: "notes/a.md"
  - id: fetch_b
    type: tool
    tool: read_file
    args:
      path: "notes/b.md"
  - id: summarize
    type: llm
    prompt: "汇总 {{steps.fetch_a.output}} 与 {{steps.fetch_b.output}}，列一张对比表"
```

每轮只调一次模型做决定（不是 agent 自由发挥）：

- 提示词里只列“当前可执行的步骤”——`if` 已用确定性求值筛过（条件暂时算不出来的先不列，等依赖跑完再说），不把简单判断交给模型。这是 G-5 的 ADK 硬规矩在协调者里的落法。
- 模型只回一个 JSON 决定，四选一：`run`（跑一个可执行步骤）、`new_step`（生成一个新步骤并马上跑它）、`finish`（目标达成，附一句话总结）、`ask`（缺关键信息，停下来问人）。
- 新步骤一次一个、要过同一套 DSL 校验（工具名、id 唯一、字段合法），通过才执行，并追加进定义快照（`show` 与运行记录里都能看到）；动态步骤不能是审批节点。
- 每个决定都记进运行账本（`coordinator.decisions`，含轮数、动作、步骤 id、是否有效、决定本身的花费）与事件（`workflow_coordinator_decision` / `workflow_dynamic_step`），是“协调者当时怎么想的”的证据；时间线里看得到每一轮。

硬上限（超了即停，不循环烧钱）：

- 轮数 `max_rounds`（默认 10、上限 20）：轮数用完目标还没达成，整轮失败。
- 新步骤数 `max_new_steps`（默认 coordinator 3 / dynamic 5、上限 10）：额度用完，协调者再想生成新步骤会被拒绝（记一次坏决定）。
- 每步骤最多跑 3 次：同一节点反复跑会被拦下来（条件为假、跑满次数、审批节点已跑过的步骤，不再列入可执行）。
- 连续坏决定 2 次：决定不是合法 JSON、动作不认、步骤 id 不存在或当前不可执行、新步骤校验不过，都记一次坏决定；连续 2 次整轮失败。坏决定也记进账本与事件（`action: invalid`），不是静默丢掉。
- 已执行节点总数 50 个：与固定图的节点上限同一道防线。

问人（`ask`）与审批节点：

- 协调者 `ask` 时，问题进审阅队列（source `automation`），运行挂起（`awaiting_approval`），批了记一个 `ask-<轮数>` 节点继续循环，拒了整轮失败。问人的问题与批复都在账本里。
- 计划里的审批节点照常工作：跑到就挂起，批复后 `nyra workflow resume <运行 id>` 回到协调者循环续跑（轮数与动态步骤从运行记录里恢复，不丢）；拒绝按 `on_reject`（`fail` / `skip`）处理。审批节点一轮只跑一次，不会反复问。
- 挂起 resume 后，协调者从挂起前的轮数继续，不是从头开始。

成本：协调者每轮的决策调用也按实报 usage 计价进月度账本、算进 `--max-cost`（与 llm 节点同口径：没报 usage 记 `null` 不编数字）。月度硬顶在每轮决策调用前重判，超了即停。

## 审批节点

跑到 `approve` 节点时，工作流挂起（状态 `awaiting_approval`），审阅项进审阅队列（source `automation`，标题写清是哪个工作流的哪个节点）。批复后：

```sh
nyra review approve <审阅项 id> --by <你的名字>   # 或 reject
nyra workflow resume <运行 id>
```

- 批准：审批节点记 `ok`（`approved: true`），从下一顶层步骤续跑。
- 拒绝 + `on_reject: skip`：审批节点记 `skipped`，继续往下跑。
- 拒绝 + `on_reject: fail`（默认）：整轮标失败。
- 还没批复就 `resume` 会直接报错，不会偷偷跑下去。

## dry-run 与 verify

```sh
nyra workflow dry-run <名字> [--input k=v]...
nyra workflow verify <运行 id>
```

dry-run 只列出会写/会发什么，不执行：

- 工具节点按名字分类：`read`（读）/ `write`（写）/ `send`（发）。分类看工具名里的动词（`read/list/search/get` → 读，`send/mail/post/publish/notify` → 发，其余默认按写算——宁可多报，不漏报）。
- `llm` / `delegate` / `skill` 节点记 `unknown-model-action`：动作由模型临场决定，dry-run 无法枚举（可能产生写/发动作），不会假装列全了。
- 协调者/动态形态的 dry-run 再加两句实话：计划步骤只是“候选”（详情里写明“协调者运行中决定是否执行”），协调者还能再生成的新步骤另记一条 `__coordinator__`（`unknown-model-action`，动作无法枚举）。`dynamic` 种子步骤为空时，计划部分就是空的，只剩这一条。
- 循环步骤按一轮列动作，循环变量写成 `<循环项>`，并标“每轮一次”。
- dry-run 不知道前面步骤的输出是什么：走过的步骤记一个占位输出（`<模型输出，dry-run 未知>` / `<工具输出，dry-run 未知>`），后面的步骤引用 `{{steps.<id>.output}}` 时按占位渲染，不炸；占位进计划文本，使用者一眼能看出这是未知值。`if` 条件引用了前面步骤的输出、dry-run 无法判定时，按会执行列出并注明；真正写错的 `if`（语法错、类型错）仍抛错。
- 计划带 SHA-256（定义名 + 输入 + 动作 + 跳过节点算出来的）。`verify` 用运行里存的定义快照重算计划、比哈希：定义快照或输入被改过就失败。

## 成本

- 模型节点按实报 usage 计价（单价表走 `config.json` 的 `pricing`，与 `nyra cost` 同源），记进月度用量账本。没报 usage 的调用金额记 `null`（未知），不编数字。
- `--max-cost N`（美元）或定义里的 `max_cost_usd`：本次运行已知花费超了即停。月度硬顶（`config.json` 的 `monthly_cost_limit_usd`）在每个模型节点前重判。两处都只对已知金额生效——未知部分不假装封顶，文档里明说这是下界。
- 工具节点按 Nyra 全仓惯例判定失败：返回文本以 `错误：`/`执行失败：` 开头即失败（与 consoleUi / gateway / jsonMode / repeatGuard / runs.ts 同口径），不把报错文本当成功输出往下传。边界与全仓一致：文件内容本身以 `错误：` 开头时会被误判为失败。

## 两道门：试跑 + 激活

工作流激活前有两道门（Proto 的做法，Nyra 做得更硬）：

```sh
nyra workflow trial <名字> --yes [--input k=v]...   # 真实数据试跑（真执行）
nyra workflow activate <名字> --yes                  # 人工确认后激活
```

1. `trial` 拿真实数据真执行一遍——写/发动作都会真发生，所以必须加 `--yes`。跑通才记 `trial_passed`（注册表里记试跑运行 id 与时间）。
2. `activate` 人工确认后才标 `active`。没试跑通过的激活不了。激活时还会把工作流里纯脚本的摘要钉死（`script:<SHA-256>`，详见 `docs/script-purity.md`）：纯脚本跑的时候不用每次都问，改了内容授权自动失效、跑就拒绝；已激活的老工作流用 `nyra script preauth grant --yes` 补钉。
3. 只有 `active` 的工作流才能挂触发器。**触发器执行本身是下一批**：本批 DSL 里只声明 + 校验触发器入口（`schedule` 须是 5 字段 cron，`event` 须给事件名），不重做事件系统、不真的挂定时/事件触发。

## 账本

- 定义文件：`~/.nyra/workflows/<名字>.yaml|json`（DSL 文本本身，Git 友好；全中文名时文件名用名字哈希前缀）。
- 注册表：`~/.nyra/workflows.json`（名字 → 状态 `draft` / `trial_passed` / `active` + 试跑记录，原子写 0600，损坏先备份再抛错）。
- 运行账本：`~/.nyra/workflow-runs.json`（运行记录 + 定义快照，原子写 0600，上限 200 条，超了丢最老的）。每节点输入（渲染后，截断到 4000 字）/输出/耗时/花费都在里面的 `nodes` 数组里，逐节点回看直接读账本；`nyra workflow show <名字>` 只列最近运行的 id 与状态。协调者形态的运行记录里多一个 `coordinator` 对象（轮数、已执行步骤、每步骤执行次数、动态步骤、每轮决定），挂起 `resume` 后从这里续跑；动态步骤也追加进定义快照的 `steps` 里。
- 运行事件：`runs/<运行>/events.jsonl` 里有 `workflow_started` / `workflow_node` / `workflow_awaiting_approval` / `workflow_completed` / `workflow_failed` 五种事件（只记元数据与 id，不记节点输入/输出原文、不记绝对路径），协调者形态再加三种（`workflow_coordinator_decision` / `workflow_dynamic_step` / `workflow_coordinator_ask`，同样只记元数据与 id，不记提示词原文与决定全文），`nyra timeline <运行 id>` 能看到。

## CLI

```sh
nyra workflow import <文件.yaml|json>              # 导入（校验 DSL 与工具名，状态 draft）
nyra workflow list                                 # 列出已导入的工作流与状态
nyra workflow show <名字>                          # 定义摘要（触发器、节点数、最近运行）
nyra workflow run <名字> [--input k=v]...          # 真执行（写/发动作都会真发生）
nyra workflow dry-run <名字> [--input k=v]...      # 只列出会写/会发什么，不执行
nyra workflow resume <运行 id>                     # 审批后从挂起的节点续跑
nyra workflow trial <名字> --yes [--input k=v]...  # 真实数据试跑，跑通才记 trial_passed
nyra workflow activate <名字> --yes                # 试跑通过后激活
nyra workflow remove <名字> --yes                  # 删除定义与注册（运行记录保留）
nyra workflow verify <运行 id>                     # 用定义快照重算 dry-run 计划、比哈希
nyra workflow triggers <status|enable|disable|run> # 触发器执行总开关（默认关；enable 须 --yes）与到点触发器手动跑一轮
```

`--input k=v` 覆盖 `inputs` 的默认值（`k` 须是已声明的输入名；`true`/`false`/数字自动认类型）。`--max-cost N` 设本次运行的成本上限（美元），不给则用定义里的 `max_cost_usd`。

## YAML 子集

DSL 用自写的确定性 YAML 子集解析器（无依赖），只认 block 风格：映射、序列、嵌套、纯量（plain / 单引号 / 双引号）、块标量 `|` 与 `>`（支持 `+`/`-` chomping 指示；`>` 的折叠在子集里简化：换行变空格，空行分段不支持）。以下一律拒绝并报明原因：Tab 缩进、flow 风格（`{}` / `[]`）、锚点与别名（`&` / `*`）、标签（`!`）、重复键、缩进不一致、超过 2000 行或嵌套超过 10 层。`.json` 文件走 `JSON.parse`。

## 三种执行形态（都已落地）

| 形态 | 状态 |
| --- | --- |
| 固定图 | 第一批已做：步骤按 DSL 里的顺序跑，分支/循环/并行是控制结构 |
| 协调者 | 本批已做：计划步骤是“候选”，协调者 agent 每轮决定下一步，可生成新步骤 |
| 动态 | 本批已做：种子步骤可为空，协调者运行中派生子问题；与协调者共用一个循环 |

`mode` 写错（不是这三个之一）会在 `import` 时直接拒绝。`nyra workflow show <名字>` 会打印形态、目标与协调者配置；`nyra workflow run` / `trial` / `resume` 在三种形态下是同一个命令，协调者形态挂起后 `resume` 回到协调者循环续跑。

## 触发器执行（缺口 25 的尾巴，G-P1-37）

定义里的 `triggers` 字段以前只校验、不执行。本批补上执行层，复用现有守护进程轮询器与事件派发，不另起调度器：

- **定时触发**：`triggers: [{ type: "schedule", cron: "30 10 * * *" }]`（5 字段 cron：分 时 日 月 周；`*`、列表、范围、步长都认；日与周两边都限时任一边命中；7 当周日）。守护进程每轮跑到点的触发器（每轮最多 5 个、同一分钟不重复），只跑 `active` 的工作流，执行走 `runWorkflowByName`（mode normal、interactive false、成本上限继承定义里的 `max_cost_usd`）；失败记 `failed` 不炸整轮；每轮结果写证据 `~/.nyra/evidence/workflow-triggers/<日期>.jsonl`。
- **事件触发**：`triggers: [{ type: "event", event: "github_issue_opened" }]`（事件名精确命中）。网关 webhook 与 Gmail 轮询派发事件后顺带触发同名工作流（fire-and-forget，不等跑完、不破坏 webhook 响应）；同事件 id 只跑一次；事件 payload 不注进工作流输入（不可信外部数据）。
- **总开关默认关**：`nyra workflow triggers enable --yes` 才开（须显式批准）；`status` 看开关与最近触发记录；`disable` 关闭；`run` 手动跑一轮到点触发器。关着时定时与事件触发全部跳过，只记 skipped。

## 诚实边界

- dry-run 只能枚举确定性节点的动作；模型节点的动作无法枚举。协调者/动态形态下计划步骤只是候选，新步骤的动作同样无法枚举。
- 成本只对报了 usage 的调用计价；没报的记未知，硬顶只对已知部分生效。协调者每轮的决策调用也计价，但“决定本身花了多少”只在账本与事件里记，不单独列节点。
- 技能节点是“按技能正文带路的 delegate 子 agent 单次任务”，不是完整 agent 会话。
- 知识节点是 BM25 检索（缺口 1 的同一套），不是向量检索。
- `for_each` 的列表来自上游节点输出的 JSON 数组文本（inputs 只认标量）。
- 审批节点只认顶层步骤；动态生成的步骤不能是审批节点；触发器本批只声明不执行；图本身不会自己长出来——新步骤一次一个、要过校验、且有硬上限。
- 协调者可能选错步骤、可能连续两次决定无法执行（那时整轮失败，不循环烧钱）；清单（计划）本身对不对靠人审，协调者只保证按计划与目标推进，不保证计划本身是对的。
- 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
