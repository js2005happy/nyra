# 声明式 agent（G-P2-5）

一个 YAML 文件声明一个 agent：`instructions`（系统提示词）+ `tools`（工具白名单）+ 可选的 `model` / `workflow` / `approval` / `limits`。格式名 `nyra-agent-v1`，借 MAF declarative（`_loader.py` / `_models.py`）的想法，Node 实现，不抄代码。

工作流本身已经能用 YAML 声明（见 `docs/workflow.md`），Soul 是 JSON、角色模板是打包文件——本批补的是“agent 本身”这一层：一个文件把一个 agent 的身份、工具、模型、工作流打包在一起。

## 声明格式

```yaml
version: 1
name: review
description: 只读代码审查员（可选，1–500 字）
instructions: |
  你是代码审查员，只做只读检查，不改动任何文件。
  读相关文件，逐条列出问题（文件、行号、原因、建议），最后给一句总体判断。
tools:                        # 可选；不写 = 不限工具（沿用现有白名单语义）
  - read_file
  - list_dir
  - grep_search
  - git_status
model: deepseek-flash        # 可选；须是已配置的模型（裸名或 provider:model）
workflow:                    # 可选；ref 引用已声明的工作流，或 inline 一个 fixed 工作流
  ref: research-flow
approval:                    # 可选；按工具配审批模式，never_require 只对只读工具生效
  read_file: never_require
limits:                      # 可选
  max_turns: 6               # 1–12
  max_cost_usd: 0.5          # 0–1000
```

- `version` 只认 1，`name` 只认 `^[a-z][a-z0-9_-]{0,31}$`（与具名预设同款口径）。
- `instructions` 必填，1–8000 字。加载时过注入扫描（all 档，见下）。
- `tools` 非空数组，全须是已注册的工具名；未知工具名直接拒绝加载（fail-closed）。
- `model` 须在已知模型表里（内置模型表 + 模型缓存 + config 里配过的模型）；`knownModels` 传 null 时带 model 直接拒绝。
- `workflow` 二选一：`ref` 引用一个已声明的工作流（名字须合工作流名规则，传 home 时须在注册表里存在）；`inline` 只认 fixed 形态，name 缺省时用声明名，version 按 1，走工作流校验。
- `approval` 每项只认 `require` / `never_require`，走 G-P2-4 的 `validateApprovalModes`：never_require 配到写工具上加载时直接拒绝。
- `limits` 只认 `max_turns`（1–12）与 `max_cost_usd`（0–1000）。
- 顶层未知字段直接拒绝，不静默丢字段。文件解析失败、未知字段、非法值一律 fail-closed，报错是中文。

## 注入扫描

声明的 `instructions` 加载时过现有注入扫描（`src/untrusted.ts` 的 `suspiciousLabels`，**all 档**）：

- 只认高置信模式（忽略/覆盖指令、执行命令/删文件、泄露机密、exfiltrate 等中英文）。
- context 档会把正常身份写法（“你现在是……”）也拦掉，加载时不用。
- all 档仍会误伤“不要泄露密钥”这类话（命中“中文：泄露机密”），报错里列出命中模式名，改写一句就能过。

## 声明仓库

`nyra agent load <文件.yaml|json>` 校验后注册进 `~/.nyra/agents/<名字>.yaml`（0600 原子写，符号链接拒绝；同名已存在须 `--yes` 覆盖）。扩展名跟来源走（`.yaml` / `.yml` / `.json`）。

- `nyra agent load <文件> [--yes]`：校验并注册。
- `nyra agent show <名字> [--json]`：看一条已注册声明（重解析、重校验）。
- `nyra agent list [--json]`：列已注册声明（坏文件逐个跳过，记 errors，不拦列表）。
- `nyra agent remove <名字> --yes`：删一条。
- `nyra agent run <名字> ["<任务>"] [--preset <预设>] [--json]`：用声明跑一轮。

## run 的两条路

- **声明带 workflow**：走工作流。`ref` 走 `runWorkflowByName`，`inline` 走 `runWorkflowDefinition`（直接跑已校验的内联定义，不经注册表）。任务文本当 `inputs.task` 传进去——工作流没声明 `task` 输入时直接拒绝（resolveInputs 的规则）。声明的 `model` 有配时，工作流的 provider 按它建；`limits.max_cost_usd` 有配时当 `--max-cost` 用。返回码同 `nyra workflow run`：completed / awaiting_approval / awaiting_interrupt 为 0，否则 1。
- **声明没带 workflow**：走 agent 主循环。先按声明建一个具名预设（`agentDeclToPreset`：name / description / tools / model / maxTurns），再走 `nyra delegate` 同款一次性委派：`--preset` 没给时用声明名当预设名，声明的 instructions 拼到子任务系统提示最前面，声明的 approval 只对本次委派的子任务生效，`max_turns` 取 `limits.max_turns` 否则 6。没 workflow 又没任务时报错（退出码 2）。

## 白名单与预设的关系（与 G-P2-3 同款口径）

声明的 `tools` 是白名单上限：run 时声明转成的预设 tools 与 `--preset` 指定的预设 tools 取交集，只能收窄，不能放宽。声明没配 tools 时不限工具（沿用现有白名单语义）。

声明的 `approval` 同样只对本次委派的子任务生效，不改全局中间件配置；写工具配 `never_require` 也按 `require` 算（纵深防御，见 `src/agent.ts` 的 `resolveMiddlewareApprovalMode`）。

## 事件与证据链

不新增运行事件类型：run 路径复用 `delegate` 已有事件（限制性预设记 `delegate_preset_applied` 等）；load 是本地文件操作（同预设 add 不记事件）。

## 示例

`examples/agents/` 下两个示例声明：

- `review.yaml`：只读代码审查员，无 workflow，工具只读表、无 shell，approval 把 read_file / list_dir 配成 never_require。
- `research.yaml`：研究员，带内联 fixed 工作流（inputs 含 task，两步 llm：调研 / 汇总）。

```sh
nyra agent load examples/agents/review.yaml
nyra agent run review "审查 src/agentDecl.ts 的改动"
nyra agent load examples/agents/research.yaml
nyra agent run research "对比一下 Nyra 与 MAF 的中间件设计"
```

## 不做

- 声明式工作流本身（已有，不动）。
- agent 声明的热加载（改了声明要重新 load）。
- 多 agent 声明的编排（那是工作流的事）。
- desktop/ 不碰。

## 诚实边界

只在临时 home / 假 provider 上验过；`nyra agent run` 真跑（调模型花真钱）未跑过；文件缓存 / 内联工作流真跑未实测；Windows / macOS 真机未验证。
