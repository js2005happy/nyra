# 验收者（verifier）——并行产出合入前的验收门（缺口 13）

群聊有了角色分工，但并行 agent 的产出一直是直接进主线、没有集中检查。
本批补上“验收者”这一环：产出先进验收门，过了才交回、才进合并队列；
不通过打回重做，验收结论进证据链（谁验的、验了什么、为什么通过/打回）。
别家的验收只管“过了”，Nyra 管“过得可审计”。

## 和独立审查层（缺口 10）的区别

| | 审查员 reviewer（缺口 10） | 验收者 verifier（缺口 13） |
|---|---|---|
| 审什么 | 一次**敏感工具调用**（执行前） | 一次**并行产出**（合入前） |
| 结论 | ALLOW / BLOCK | verified / failed / not-verified |
| 默认 | 关闭（opt-in） | 关闭（opt-in） |
| 失败时 | 拦截调用（fail-closed） | 不合并、不重做（除非开了 rework） |

复用的东西：便宜模型解析链（`verifier.model` > `smart_approvals.reviewer_model` >
`deepseek:deepseek-flash`）、`reviewWithReviewer` 的运行件与 verdict 解析口径
（JSON 里找最后一个 `{...}`，`decision: approve/deny` + `reason`）、
`multiModelFactory` / delegate 便宜模型 / 主模型的 runner fallback 链、
`src/runs.ts` 的事件注册口径。分开写的东西：结论语义（审调用 vs 验收产出）、
检查清单（确定性六项，见下）、打回重做循环、群聊里的验收者角色。
合并队列不另建——复用 3b 的 review queue（enqueue → verify → decide → apply）。

## 默认关闭，怎么开

`config.json` 的 `verifier` 一节（`nyra verifier` 管理，见下）：

```json
{
  "verifier": {
    "enabled": false,
    "provider": null,
    "model": null,
    "rework": false,
    "rules": []
  }
}
```

- `enabled`：总开关，默认 `false`。没开时 delegate 的产出照旧交回，
  `verification` 记 `not-verified`，不调模型、不记事件。
- `model`：验收用的模型，形如 `deepseek:deepseek-flash`；不填时走
  `smart_approvals.reviewer_model`，再不填用 `deepseek:deepseek-flash`
  （只决定“显示口径”，实际用的 runner 以 `verifierRunner()` 为准）。
- `rework`：默认 `false`。开了才打回重做；没开时未通过就停在那，等人处理。
- `rules`：附加的验收规则（字符串数组），写进验收提示词；目前是人工约定，
  不做自动执行。

队列与定时任务里不自动换模型、不自动放行审批——这条护城河对 verifier
同样适用：它只验收、不代人批准，合入仍要 3b 的 review queue 逐项批。

## 检查清单（确定性六项，先跑它）

模型复核之前先跑纯函数 `runDeterministicChecks`，一项不过就不用调模型：

| 检查 | 过 | 不过 |
|---|---|---|
| `has-changes` | 改动文件非空 | 无改动（只调研的任务） |
| `files-exist` | 每个改动文件在 worktree / 工作目录里存在 | 列出缺的文件 |
| `diff-stat` | 有改动文件时 diffStat 非空 | 有改动文件但 diffStat 为空 |
| `evidence-complete` | 摘要非空、花费已结算（或未知） | 摘要为空、花费为负 |
| `draft-labeled` | 非草稿，或已标草稿且未声称已完成 | 标题/摘要含草稿标记（草稿/草案/初稿/待完善/WIP/draft）却声称已完成（已完成/已搞定/已交付/ready/验收通过/测试通过） |
| `ui-before-shot` | 无界面改动，或摘要已提 before/对比/截图 | 改了界面文件（`.tsx`/`.jsx`/`.vue`/`.svelte`/`.css`、`desktop/ui/` 下）但摘要里没提 before/对比/截图 |

后两项是 DSH-5 的诚实交付口径：草稿不能按已完成验收，UI 改动没图不算
ready。它们是**启发式文本判定**——只核对标题/摘要里的说法，不验截图像素
真假（像素真假靠模型复核与人）；误判时用 `add-rule` 覆盖或人工批。
模型复核的提示词里同样写了这两条（`VERIFIER_SYSTEM_PROMPT`），两道门
口径一致。

## 验收结论

- `verified`：确定性六项全过，且模型复核 approve（或无模型时只靠确定性，
  方法记 `verifier-deterministic`，并在结论里写清“未跑测试、未审语义”，
  别把它当成“代码是对的”）。
- `failed`：确定性不过（不调模型），或模型 deny（reason 原样写进结论）。
- `not-verified`：三种情况——验收者未开启（skipped）；产出无改动可验
  （跳过验收，不打回重做）；模型不可用/解析不出结论（unavailable，
  fail-closed：不得合并，不得当成通过）。

验收不编花费：`spentUsd` 只用来核对证据完整性，成本以 delegate 的记账为准。

## 群聊里的验收者

群聊的默认机器人从 4 个变 5 个，新增 `verifier`（验收者，只读）：
按检查清单独立验收产出，不通过打回重做；它只看任务、摘要与 diff，
不跑工具、不改文件。群聊的机器人列表与 `room.json` 里都能看到它。
它和审查员一样参加每轮群聊（轮到它时给出的是一句验收口径的意见，
不是自由发挥的点子）；真正的验收门在 delegate / review queue 里，
不在群聊轮次里。

## delegate 验收门

`delegateDetailed` / `delegateParallel` 的产出先过验收门再交回：

- 未通过且开了 `rework`：同一子 agent、同一 worktree 就地重做 **1 次**
  （复用完整上下文，不新开子 agent；无改动可改时不重做）。
  重做后通过时结论行写清“第 1 次验收未通过，已打回重做 1 次后通过”。
- 记账只在最终产出确定后记一次：`child.lastCost` 是两次运行的累计值，
  记两次会 double-count。
- 结论进 `DelegateResult.verification`（`status` / `note` / `method` / `at`），
  结果文本末尾加一行“验收：通过/未通过/未验收”。
- `delegateParallel` 的每个线程结论透传到 `ParallelThreadEvidence.verification`，
  汇总文本末尾有“验证结论：验收者已验收 N 个线程（通过 x 个，未通过 y 个）”。

## review queue 的 verify

验收者开启后，`nyra review verify <id>` / `POST /api/review/:id/verify`
改跑完整验收（方法记 `verifier` 或 `verifier-deterministic`），并另记一条
`verifier_verdict` 事件；未开启时沿用原来的 `files-exist` 轻量核对，
行为一字不改。`verify` 对无改动文件的项仍报错（无处核对）。

## CLI

```bash
nyra verifier status              # 看开关、模型、打回重做、附加规则
nyra verifier enable | disable    # 开 / 关（默认关闭）
nyra verifier set-model deepseek:deepseek-flash
nyra verifier rework-on | rework-off
nyra verifier add-rule "改动须附测试命令与结果" | remove-rule <规则> | list-rules
nyra verifier check --title <标题> --summary <摘要> --workdir <目录> \
  --files a.txt,b.txt [--worktree <路径>] [--diff-stat <文本>]
```

`check` 是试运行（退出码 0 通过、3 未通过、2 验收者未开启、1 用法错误），
不写配置、不进队列，适合在 CI 或脚本里先验一次。

## 证据链

新事件类型（已在 `src/runs.ts` 的 `EVENT_FIELDS` 注册）：

| 事件 | 字段 |
|---|---|
| `verifier_verdict` | `target`, `verdict`, `reason`, `verifier_model`, `source`, `checks_passed`, `checks_failed` |
| `verifier_rework` | `target`, `attempt`, `reason` |

`review_verified` 仍记（方法字段会变成 `verifier` / `verifier-deterministic`）。
事件里不记绝对路径（`appendEvent` 的 `redact()` 会把长词串当疑似密钥掩掉）。

## 已知局限（诚实边界）

- **只验新文件时 diff-stat 会空**：`git diff --stat HEAD` 不含 untracked
  文件，纯新建文件的产出会在 `diff-stat` 一项失败（与 3b 的 `files-exist`
  同一口径）；改动里只要有一个已入库文件被改，diff 就非空。想验纯新建
  产出时，人可以在 review queue 里看文件清单后直接批。
- **确定性检查不跑测试、不审语义**：它只核对“改动存在、文件存在、
  diff 完整、证据齐全”；代码对不对要靠模型复核与人的 review。
- **模型复核的结论只看 JSON**：解析不出 `decision` 时按不可用处理
  （not-verified），不猜结论。
- **验收者与审查员共用便宜模型链**：模型名一样时是同一个便宜模型在
  审两道门，但上下文是独立的（验收只看到任务、摘要与 diff）。
- **验收模型调用不进用量账本**（与 reviewer 同款）；成本以 delegate
  记账为准，验收本身的 token 花费目前不单独结算。
- **诚实交付两项是启发式文本判定**：`draft-labeled` 只看标题/摘要里有
  没有草稿标记与完成声称，`ui-before-shot` 只看摘要里提没提 before/
  对比/截图——它们核对的是“说法”，不验截图像素真假；一张 after 图冒充
  before 图、或摘要里随手写一句“有截图”，确定性检查拦不住，要靠模型
  复核与人的 review。误判（比如摘要里“草稿”指的不是本次产出）时，用
  `verifier add-rule` 覆盖或人工批。
