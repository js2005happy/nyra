# 结构化人机回环（G-P1-41）

审批卡 / 审阅队列 / judge 都是“批一次工具调用”；结构化人机回环是另一种形态：**工作流跑到指定步骤前后停住，人看一眼、回一句话或改几个参数，带着改完的值原地继续**。想法借 LangGraph 的 HumanInterrupt（带 id 与 response_schema 的结构化中断），Node 实现，不抄代码。

## 和别的人机机制的区别

| 机制 | 停在哪 | 人能做什么 | 续跑 |
|---|---|---|---|
| 审批节点（`approve`） | 跑到该节点 | 批 / 拒（拒了按 on_reject 走） | `nyra workflow resume` |
| 审阅队列（`nyra review`） | 工具调用前 | 批 / 拒一次调用 | 自动继续 |
| judge（`nyra judge`） | 高风险动作前 | 允许 / 转人工 / 拒绝 | 按裁决 |
| 转人工（`nyra hitl`） | 整个会话 | 接手对话，bot 静默 | `nyra hitl handback` |
| **人机回环（本批）** | **指定步骤前后** | **accept / ignore / respond / edit** | **`nyra interrupt resume`** |

## 定义写法

只在工作流定义里显式配 `interrupt_before` / `interrupt_after` 的步骤前后停住，**默认不停**。只认 **fixed 形态的顶层步骤**：

```yaml
name: 发版检查
version: 1
mode: fixed
steps:
  - id: build
    type: tool
    tool: shell
    args: { command: "bun run build" }
    interrupt_after:
      prompt: "构建完了，看一眼输出，没问题就继续发版。"
      schema:
        fields:
          - { name: note, type: string, required: false, description: "给下一步留一句话" }
  - id: release
    type: llm
    prompt: "按构建输出写发版说明：{{steps.build.output}}"
    interrupt_before:
      prompt: "发版说明的提示词没问题吗？要改直接改 prompt。"
```

- `prompt`：给人看的一句话（1–500 字，不写用默认文案）。
- `schema`：人能回哪些字段（最多 16 个，字段名小写字母开头、只含小写字母数字下划线；type 只认 string / number / boolean；required 默认 false；description ≤200 字）。
- 不认的写法导入时直接拒绝：并行分支内的步骤配中断、审批节点配中断、coordinator / dynamic 形态配中断。

## 四种决定

- `accept`：原样继续（before 点跑该步，after 点跑下一步）。
- `ignore`：跳过（before 点该步记 skipped，after 点直接继续下一步；已跑完的步骤结果不动，只记决定）。
- `respond`：回一组值（按 response_schema 校验：未知字段、缺必填、类型错都拒绝），值只记在中断单上，**不改参数**——适合“留一句话给下一步看”。
- `edit`：改参数后只重跑受影响的步骤。before 点改该步输入，after 点只能改该步的输出（`--set output=新值`）。

edit 能改什么（只改已声明的键，值须是标量且类型对得上；对象 / 列表参数不认 edit）：

| 步骤类型 | 可改的键 |
|---|---|
| tool | args 里已声明的标量键（字符串 / 数字 / 布尔） |
| llm | prompt、system（配了才认） |
| delegate | task、max_turns（配了才认） |
| skill | task |
| knowledge | query、base、top_k（配了才认） |
| approve / parallel / for_each | 不支持 edit |

## CLI 全程

```sh
nyra interrupt list [--status pending|resolved] [--json]
nyra interrupt show <中断单 id> [--json]
nyra interrupt respond <中断单 id> --set note=没问题 [--set ...]
nyra interrupt edit <中断单 id> --set prompt=改后的提示词
nyra interrupt edit <中断单 id> --set output=改后的结果   # after 点
nyra interrupt resume <中断单 id> [--decision accept|ignore] [--set 键=值 ...]
```

- `resume`：已回过的单直接续跑；没回的单加 `--decision accept|ignore` 一次性回掉，或加 `--set` 当 respond 一次性回掉（`--decision edit` 须配 `--set`）。
- `nyra workflow resume` 只接审批挂起（`awaiting_approval`），人工回环挂起（`awaiting_interrupt`）走 `nyra interrupt resume`，混用会直接报错。
- 续跑是真跑工作流：写 / 发动作都会真发生，审批节点照常挂起，`--max-cost` / 分层每日上限重新核，不绕审批、不绕成本硬顶。

## 中断单与证据链

中断单存 `~/.nyra/interrupts.json`（0600 原子写，损坏先备份再回空账本，上限 200 条、超了丢最旧的已终态单）：

- 每条单有 id（`int-` + 随机）、运行 id、工作流名、步骤 id、停在哪一点（before / after）、状态（pending / resolved）、提示词、response_schema、上下文摘要（步骤输入 / 输出摘要，≤500 字）、创建时间、解决时间、决定、回的值、改的值、解决人（本机 CLI 操作者即机主，记 `local`）。
- 同一条运行、同一个步骤、同一个点，挂起的单只有一张（重入直接回已有的，不重复建）。
- 决定记运行事件与证据链：`workflow_interrupt_created`（哪个运行、哪个步骤、停在哪一点）、`workflow_interrupt_resolved`（哪个单、什么决定）、`workflow_interrupt_resumed`（哪个单、什么决定）。只记决定与参数键，**不记对话原文、不记回复内容、不记步骤输入 / 输出原文**。

## 边界与注意

- if 为假会跳过的步骤不打扰人（跑前不建单）；跑后中断只对成功跑完的步骤生效（跳过 / 失败的步骤不建单）。
- for_each 步骤的中断只触发一次（整段循环前后各一次，循环内单步不单独停）；循环步骤不支持 edit。
- 触发器跑到带中断的工作流时会停住等人（状态 `awaiting_interrupt`），不会自己续跑；reconciler 不把等回环的运行当卡住。
- `nyra checkpoint replay` 重放时会重新走中断点（新运行、新中断单）；after 点 edit 改的输出会同步写回步级检查点（有检查点时走 `updateStepState`，写失败不拦续跑）。
- 中断恢复不绕审批：续跑后跑到审批节点仍挂起，须先 `nyra review` 批复再 `nyra workflow resume`。
- 不做自动转人工（只由机主或 bot 显式触发）；没有真人坐席端（真人只通过本地 CLI / 收件箱看到中断单）。

## 诚实边界

- 只在临时 home / 假 provider 上验过；没有真模型在中断续跑下跑过一轮。
- 中断只在 fixed 形态的顶层步骤生效；并行分支内、coordinator / dynamic、审批节点都不认。
- after 点 ignore 不改已跑完的步骤结果（只记决定）。
- Windows / macOS 真机未验证。
