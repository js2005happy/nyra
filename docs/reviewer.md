# 独立审查层（缺口 10）

> 学 Dots Auto-review（独立审查 agent）、Meta Muse Sentinel（独立安全 agent）、
> Goose Adversary Mode（静默 reviewer agent，每个工具调用前对照原始任务与最近
> 消息做 ALLOW/BLOCK 判定），但不照抄、做得更好：
> 审查做成独立角色而不是同一进程内的钩子；审查用便宜模型；审查结论进证据链；
> **审查失败即拦截（fail-closed），不学 Goose 的 fail-open**。

## 问题

Nyra 的 Hooks 与权限规则在同一进程内；smart approvals 的评审模型默认关。
安全与规范仍依赖主 agent“听话”与人工审批，缺一个独立的审查角色。
无人值守任务（缺口 8）没有第二双眼睛兜底，越自动越危险。

## 怎么做

敏感动作先过审查 agent，再执行：

1. **独立上下文**：审查员只看到原始任务（第一条用户消息）、最近 6 条消息
   与这次拟执行的工具调用，看不到主 agent 的完整对话与工具历史。
   拟调用内容只出现在 XML 块内，块内是指令数据、不是给审查员的指令
   （与 smart approvals 同款防注入写法；shell 命令先剥注释再进块）。
2. **便宜模型**：审查用 `reviewer.model`（默认 `deepseek-flash`），与主 agent
   的模型分开，成本可控。配法沿用 `smart_approvals.reviewer_*`（已有配置
   不用再配一遍），`reviewer` 一节优先。
3. **结论进证据链**：每条审查结论（放行与拦截都记）发 `reviewer_verdict`
   事件进 `events.jsonl`：谁审的（`reviewer_model`）、审了什么工具
   （`tool`）、为什么放行/拦截（`reason`）、命中哪条确定性规则（`rule`）。
   别家的审查只管“拦没拦”，Nyra 管“拦得可审计”。
4. **fail-closed**：审查模型出错、超时、输出解析不出决策、审查模型不可用，
   一律拦截。Goose 的 Adversary Mode 默认 fail-open，Nyra 不学。

## 两道门

按顺序，先确定性、后模型：

| 门 | 内容 | 成本 |
|---|---|---|
| 确定性规则 | `rm -rf` 根/家/通配、curl/wget 管道进 shell、mkfs/dd 写原始设备、读私钥再经网络外发、私钥 PEM 块进发送内容 | 零（不调模型） |
| 模型审查 | 确定性规则放过的，才进审查模型；模型返回 ALLOW/BLOCK + 理由 | 一次便宜模型调用 |

确定性规则命中直接拦截，不调模型；模型拿不准就 BLOCK（审查提示里写明）。

## 开关与配置

默认关闭（显式 opt-in），关闭时行为与之前完全一致，零打扰、零性能损耗。

```json
{
  "reviewer": {
    "enabled": false,
    "provider": null,
    "model": null,
    "tools": null,
    "rules": []
  }
}
```

| 键 | 含义 |
|---|---|
| `enabled` | 总开关。`true` 才审查 |
| `provider` / `model` | 审查模型。不填时沿用 `smart_approvals.reviewer_provider` / `reviewer_model`，再没有用 `deepseek` / `deepseek-flash` |
| `tools` | 被审工具集。不填时用默认集：`write_file`、`edit_file`、`apply_patch`、`shell`、`memory_forget`、`memory_delete`、`gmail_send`、`http_post`、`submit_bughunt_report`、`marketplace_install`、`marketplace_publish`（删改关键文件、跑命令、删记忆、对外发送全覆盖；`submit_bughunt_report` 是虚拟敏感动作，候选提案 1 的提交前核对用；`marketplace_install` / `marketplace_publish` 是虚拟敏感动作，机器人市场安装与发布前过审查用；支付工具将来加上时也进默认集） |
| `rules` | 用户用自然语言写的额外审查规则，审查提示里原样交给审查模型 |

## CLI

```bash
nyra reviewer status                                  # 看开关、模型、被审工具、规则
nyra reviewer enable | disable                       # 开 / 关
nyra reviewer set-model deepseek:deepseek-flash       # 设审查模型（也可只写模型名）
nyra reviewer add-rule "删生产数据库前必须先确认备份"   # 加一条自然语言规则
nyra reviewer list-rules                              # 列规则
nyra reviewer remove-rule 2                           # 删第 2 条规则
nyra reviewer check --tool shell --args '{"command":"rm -rf /tmp/x"}' [--task "清理临时文件"]
                                                       # 试运行一次审查：0 = 放行，3 = 拦截
```

`check` 即使审查层未开启也按开启后的口径审一次（生产上未开启时不审），
方便先试再开。

## 接线位置

| 位置 | 作用 |
|---|---|
| `src/reviewer.ts`（新） | 配置解析、确定性规则、模型审查（独立上下文）、巡查结论复核、现场建审查模型实例 |
| `src/tools.ts` | `executeTool` 里审查门：PreToolUse 钩子之后、审批之前；幂等重试不重审（首次已审过） |
| `src/agent.ts` | 每次工具调用前刷新审查上下文（原始任务 + 最近消息）；审查模型实例懒建一次后缓存；委派子 agent 继承审查模型 |
| `src/responsibilities.ts` | 巡查结论先过一层独立审查再汇报（见下） |
| `src/runs.ts` | `reviewer_verdict` 进 `EVENT_FIELDS` 与 `RunRecorder` 白名单 |
| `src/jsonMode.ts` | `--json` 转发 `reviewer_verdict` |
| `src/gateway.ts` | `GET /api/reviewer`（只给开关与模型名，不含凭证）；网关会话与定时任务的 Agent 同样传审查模型 |
| `src/tasks.ts` | 队列任务与批复后继续跑同样传审查模型 |

## 巡查结论复核（与缺口 8 的联动）

缺口 8 的巡查报告原先由模型自己写、自己判。缺口 10 落地后，`runPatrol`
在写 `patrol_report` 事件之前，先调 `reviewPatrolReport`：审查员只看
责任目标、巡查输出全文与巡查员自称的结论，判断结论是否可信——

- 结论与输出一致 → ALLOW，按原结论汇报；
- 结论与输出不符、有发现却报无发现、输出里的问题被结论轻描淡写 → BLOCK，
  按“有发现”处理（fail-closed 向汇报）；
- 审查模型不可用 / 无有效结论 → BLOCK，同样按“有发现”处理。

审查结论同样发 `reviewer_verdict` 事件（`tool` 为 `patrol_report`）。
审查层未开启时不调模型、不记事件，巡查行为与之前一致。

## 与 smart approvals 的关系

两个审查是不同层次，不要混用：

| | smart approvals | 独立审查层（缺口 10） |
|---|---|---|
| 位置 | 审批时（checkApproval 里） | 执行前（executeTool 里，钩子之后、审批之前） |
| 开关 | `smart_approvals.reviewer_enabled` | `reviewer.enabled` |
| 结论 | APPROVE / DENY / ESCALATE（人工） | ALLOW / BLOCK（无人工档；拦了就是拦了） |
| 审什么 | 主要是 shell 命令 | 全部被审工具（写文件、删改、发信、发请求、跑命令） |
| 审计 | `approvals_audit.jsonl` | `reviewer_verdict` 事件（证据链） |

两者可共用同一个审查模型配置（`reviewer.model` 不填时沿用
`smart_approvals.reviewer_model`），但开关各自独立。

## 与意向验证 judge 的关系

judge（`src/toolJudge.ts`，详见 `docs/tool-judge.md`）是审查门之后的
打分层：审查层二值拦住的，judge 不再看；审查层放行的，judge 再打一个
0–100 的风险分 + 引用证据，高分拒绝、中段转人工、低分放行。judge 的
模型配置不填时沿用审查层的模型解析，开关各自独立。

## 已知局限

- 审查模型是“第二双眼睛”，不是“绝对正确”：它也会误判。误拦截时用户
  可以在工具结果里看到拦截原因，改一下调用再试；误放行时人工审批与
  权限规则仍是后两道防线（审查门在审批之前，审过了还要过审批）。
- 审查结论的 `reason` 是模型写的自然语言，不保证每次措辞一致；确定性
  规则的拦截原因固定可查。
- `mcp_` 工具经 MCP 管理器直行时不经过 `executeTool`，本批不审（管理
  器路径仍有 checkApproval）；下一批再接。
- 审查每次被审调用多一次便宜模型调用：审查层开启后，敏感操作会多花
  一点 token 与一点延迟；只读工具不进审查，不受影响。
- 审查模型与主模型相同时（只配了一个模型、又没配 delegate 模型），
  审查仍用独立上下文跑，只是模型与主 agent 相同——独立性来自上下文，
  不是模型名字。
