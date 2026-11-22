# 意向验证 judge（Turnstone 借鉴第 2 批）

> 借鉴 turnstonelabs/turnstone 的 judge 机制：每个工具调用执行前，先由一个
> LLM judge 打分——风险评估 + 证据，通过才跑。只借想法，不搬代码
> （Turnstone 是 Python，Nyra 是完整 Node 运行时）。
> 与缺口 10 独立审查层的区别：审查层是二值 ALLOW/BLOCK（危险就拦）；
> judge 是打分制——风险分 0–100 + 引用证据，分段映射三档结论。
> 审查层看“危险不危险”，judge 多看一层“这次调用与原始任务的意向对不对
> 得上”，并把“拿不准”从 BLOCK 降级成转人工——人看一眼再定，而不是
> 直接杀掉这次调用。

## 问题

缺口 10 的审查只有放行与拦截两档：模型拿不准的调用直接 BLOCK，工具结果
里只剩一条拦截原因，agent 想继续只能换个写法再试一次；人想放行这次
调用也没有入口——审查门在审批之前，拦了就到不了审批。
Turnstone 的 judge 把“拿不准”单独成档：高分才拒绝，中段转人工，低分
放行；分数量化后，每次调用的风险高低在证据链里留得住、能回查。

## 怎么做

敏感动作先过 judge 打分，再执行：

1. **独立上下文**：judge 只看到原始任务（第一条用户消息）、最近 6 条消息
   与这次拟执行的工具调用，看不到主 agent 的完整对话与工具历史。
   拟调用内容只出现在 XML 块内，块内是指令数据、不是给 judge 的指令
   （与审查层同款防注入写法）。
2. **打分 + 证据**：judge 只输出一个 JSON 对象
   `{"risk_score": 0-100, "evidence": [...], "reason": "..."}`。
   `risk_score` 是“这次调用是错的 / 有害的 / 偏离任务”的风险：0 = 与
   任务一致、无害；100 = 一定有害或完全偏离。`evidence` 必须从任务或拟
   调用里逐字摘 1–3 句原话，证明为什么给这个分；摘不到就写 `[]`，
   不编造引用。
3. **分段映射（三档）**：分数到结论的映射只看配置的两条线，不由模型定档——

   | 分数 | 结论 | 含义 |
   |---|---|---|
   | `< escalate_at`（默认 40） | allow | 放行，继续执行 |
   | `>= escalate_at` 且 `< deny_at`（默认 70） | escalate | 转人工：本次调用强制走人工审批链 |
   | `>= deny_at` | deny | 拒绝，不执行 |

   拿不准就往高了打（judge 提示里写明），中段分进转人工、不是直接放行。
4. **结论进证据链**：每条 judge 结论（放行、转人工、拒绝都记）发
   `tool_judge_verdict` 事件进 `events.jsonl`：谁判的（`judge_model`）、
   判了什么工具（`tool`）、结论（`verdict`）、风险分（`risk_score`）、
   证据（`evidence`）、为什么（`reason`）。
5. **fail-closed**：judge 模型出错、超时、输出解析不出分数、judge 模型
   不可用，一律拒绝。不静默放行，也不降级成转人工——拿不准的调用不能
   靠“转人工”兜底后又没人可问时悄悄跑掉；full 模式下转人工同样拒绝。

## 层级

按顺序，先钩子、再审查门、再 judge 门、最后人工审批：

| 门 | 内容 | 成本 |
|---|---|---|
| 确定性钩子 | PreToolUse 钩子（危险操作先拦） | 零（不调模型） |
| 审查门（缺口 10） | 确定性规则 + 红线 + Soul + 二值模型审查 | 一次便宜模型调用（只审被审集） |
| judge 门（本批） | 风险分 + 证据 + 三档结论 | 一次便宜模型调用（只审被审集） |
| 人工审批 | 权限规则 + approveFn / 终端确认 | 人的一次确认 |

judge 只在审查门放行后跑；审查层没开时 judge 也能单独开。红线 never
与 Soul invariant 不在 judge 里重复查——`checkApproval` 里对每个写
操作都查，judge 关了它们也在。judge 只是多一层分级判断，不是替代品。

转人工的接线：judge 判 escalate 时在 `ToolContext` 上记一笔
`judgeEscalation`（只认本次调用的工具名），`checkApproval` 读到后跳过
allow 快路、幂等短路、“记住的允许”规则与脚本快路径，强制走到人工
审批链，并在审批摘要里附上风险分与理由；full 模式下无人可问，转人工
等于拒绝。标记读完就清掉，`runToolJudge` 每次调用都会刷新它，不会把
上一次的转人工漏到下一次调用上。

## 开关与配置

默认关闭（显式 opt-in），关闭时行为与之前完全一致，零打扰、零性能损耗。

```json
{
  "judge": {
    "enabled": false,
    "provider": null,
    "model": null,
    "tools": null,
    "deny_at": 70,
    "escalate_at": 40
  }
}
```

| 键 | 含义 |
|---|---|
| `enabled` | 总开关。`true` 才打分 |
| `provider` / `model` | judge 模型。不填时沿用审查层的模型解析（`reviewer.model` / `smart_approvals.reviewer_model` / 默认 `deepseek` / `deepseek-flash`），已有审查配置不用再配一遍 |
| `tools` | 被审工具集。不填时用默认集（与审查层同一批：`write_file`、`edit_file`、`apply_patch`、`shell`、`export_office`、`media_ingest`、`memory_forget`、`memory_delete`、`gmail_send`、`http_post` 等，只读工具不在内） |
| `deny_at` | 拒绝线（0–100，默认 70）。`>=` 此分拒绝 |
| `escalate_at` | 转人工线（0–100，默认 40）。`>=` 此分且 `< deny_at` 转人工；配得比拒绝线高时按拒绝线钳住（中段不存在时全部直接拒绝，不静默改成放行） |

## CLI

```bash
nyra judge status                                  # 看开关、模型、被审工具、分段
nyra judge enable | disable                       # 开 / 关
nyra judge set-model deepseek:deepseek-flash       # 设 judge 模型（也可只写模型名）
nyra judge set-thresholds 70 40                   # 设分段：拒绝线 70，转人工线 40
nyra judge check --tool shell --args '{"command":"rm -rf /tmp/x"}' [--task "清理临时文件"]
                                                   # 试运行一次打分：0 = 放行，2 = 转人工，3 = 拒绝
nyra judge verdicts [--limit 20] [--layer heuristic|judge] [--decision allow|escalate|deny]
                                                   # 查最近的意向验证结论（启发式 + judge 两层都落库）
```

`check` 即使 judge 未开启也按开启后的口径打一次分（生产上未开启时不打），
方便先试再开。

## 接线位置

| 位置 | 作用 |
|---|---|
| `src/toolJudge.ts`（新） | 配置解析、分段映射、模型打分（独立上下文）、现场建 judge 模型实例 |
| `src/tools.ts` | `executeTool` 里 judge 门：审查门之后、执行之前；幂等重试不重评（首次已评过）；`checkApproval` 里转人工强制走人工审批链；拒绝文案进 `APPROVAL_REFUSAL_MARKERS`（见下） |
| `src/runs.ts` | `tool_judge_verdict` 进 `EVENT_FIELDS` |
| `src/timeline.ts` | `tool_judge_verdict` 的时间线渲染（结论 + 风险分 + 证据） |

## 本批顺手修的真问题：模型安全门会被幂等重试绕过

本地验证探针实证：审查层 BLOCK 的 `write_file`，经 `executeToolIdempotent`
重试后被写出去了——重试置 `idempotentRetry`，`executeTool` 跳过审查门，
`checkApproval` 的幂等短路又跳过审批，拦住的写操作直接执行。

根因是 `isApprovalRefusalResult` 的标记表里没有模型安全门的拒绝文案，
重试逻辑认不出“这是审查拦住的”，当成普通工具失败重试了。
本批把两条文案补进 `APPROVAL_REFUSAL_MARKERS`（`独立审查拦截`、
`意向验证 judge 拒绝`），审查与 judge 拦住的写操作一律不重试；回归测试
`tests/node/test-tool-judge.test.ts` 盯着这两条（审查 BLOCK 与 judge
deny 的写操作经 `executeToolIdempotent` 都不落盘）。

注意：权限钩子（PreToolUse）拦住的写操作仍有同一类重试缺口，本批没动——
钩子失败分“确定性拦截”与“钩子本身出错”两种，后者重试可能是合理的，
要分开处理，留给后续批次。

## 与审查层的关系

两层是不同分工，不要混用：

| | 独立审查层（缺口 10） | 意向验证 judge（本批） |
|---|---|---|
| 位置 | 执行前（`executeTool` 里，钩子之后、审批之前） | 同样位置，审查门之后 |
| 开关 | `reviewer.enabled` | `judge.enabled` |
| 结论 | ALLOW / BLOCK（无人工档；拦了就是拦了） | allow / escalate / deny（中段转人工） |
| 输出 | 结论 + 一句话理由 | 风险分 + 引用证据 + 理由 |
| 审什么 | 全部被审工具（写文件、删改、发信、发请求、跑命令） | 同一批工具 |
| 审计 | `reviewer_verdict` 事件 | `tool_judge_verdict` 事件 |

两者可共用同一个模型配置（`judge.model` 不填时沿用审查层的模型解析），
但开关各自独立；都开时每次被审调用多两次便宜模型调用（审查一次、
judge 一次），只读工具不受影响。

## 启发式前置 + verdict 落库（缺口 G-P1-12，第 2 批）

judge 是模型打分，要花 token、要等模型。启发式是零成本的规则层，
先扫一遍，再决定要不要调 judge（Turnstone 的意向验证思路，两层）：

| 启发式结论 | 处理 |
|---|---|
| critical（删根目录、拉远程内容喂 shell、读凭据又往外发、毁设备类命令） | 直接拒绝，不调 judge 模型 |
| high（读凭据文件、提权命令、对外发疑似凭据、rm -rf 带绝对路径） | 转人工：风险分标 85，交给 `checkApproval` 强制走人工审批链 |
| medium（写工作区外绝对路径等） | 只留痕，放行 |
| 没命中 | 直接过 |

- 顺序：审查门 → judge → 启发式 → 提议门 → 单写者门。两层结论都落库。
- 落库 `~/.nyra/intent-verdicts.jsonl`（0600，上限 2000 条）：只记工具名、
  层（heuristic/judge）、结论、规则、理由，不记参数原文。
- `judge` 的打分结论同样落库（`tool_judge_verdict` 事件已有，落库与之
  并列，不互相替代）。

```bash
nyra judge verdicts [--limit <条数>] [--layer heuristic|judge] [--decision allow|escalate|deny]
```

## 已知局限

- judge 是“第二双眼睛”，不是“绝对正确”：它也会误判。误拒绝时工具
  结果里有风险分、证据与理由，改一下调用再试；误放行时人工审批与
  权限规则仍是后两道防线（judge 门在审批之前，打过了分还要过审批）。
- 风险分是模型给的数字，不是实测概率：同一调用换个说法分数会浮动；
  分段线（40/70）是默认值，可按实际误判情况用 `set-thresholds` 调。
- `mcp_` 工具经 MCP 管理器直行时不经过 `executeTool`，本批不审（管理
  器路径仍有 checkApproval）；下一批再接。
- judge 每次被审调用多一次便宜模型调用：judge 开启后，敏感操作会多花
  一点 token 与一点延迟；只读工具不进 judge，不受影响。
- judge 的模型调用不走预算预留账本（与审查层同款口径）：便宜模型、
  只审敏感工具，成本靠模型选择与工具集控制，不靠逐调用预留。
- 证据是模型从任务与拟调用里摘的原话，只证明“judge 看到了什么”，
  不保证摘出来的就是真正的风险点；证据为空时理由仍以 `reason` 为准。
