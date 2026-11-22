# 合并成一份交付物 + 后台扇出落任务板（H-5 + H-6）

> Hermes 借鉴第三批。借的是做法，不抄 API 形状与键位；演示数字
> （21 秒、50 秒、1 分 25 秒、20+ 代理之类）不写进文档、不当事实。
> 缺口 13（验收队列）与缺口 30/31/26（任务板、崩溃自续、Heartbeat）的深化。

## H-5：批跑完后合成一份交付物

以前并行委派的产出是文本汇总 + review queue（缺口 3a + 3b），缺“合成一份
文件”这一步。本批补上：

```
各线程按 output_schema 交结构化摘要（H-4 契约）
  → 编排者跑一次合并步（一次模型调用）
  → verifier 确定性检查（5 项，只核说法不验语义）
  → review queue 人批（verification 方法 merge-deterministic）
```

用法：模型调 `delegate_parallel` 时传 `merge: true`，或代码里调
`Agent.delegateParallel(tasks, { merge: true, mergeTitle, mergeFormat })`。
`mergeFormat` 是 `plan` / `report` / `file`，默认 `report`。

合并步本身要花一次模型调用 + 校验，成本如实记账：合并步占 1 次子 agent
预算（上限 8 次，5 线程 + 合并 = 6，够用；预算用完时合并失败，原文汇总
仍在）。合并子 agent 只读（`tools: ["read_file"]`，只做合成，不改文件、
不跑命令），完整版落盘 `~/.nyra/merged/<mg_id>.md`（0600），审阅项的
summary 前加一句完整版路径。

### 合并任务怎么写（buildMergeTask）

每线程一节，标题写成“线程 N：<任务一句话>”；失败线程写清原因，绝不写成
已完成；“改动文件”清单只列各线程**证据**里的文件（摘要里自称改了的文件
不算证据）；契约未通过的线程写“契约未通过（schema_valid: false），原文
保留待人核”；不编造数字、结论与验证结果；末尾一段“合并说明”。

### verifier 的 5 项确定性检查（src/merge.ts）

| 检查 | 不通过时说明什么 |
|---|---|
| not-empty | 交付物是空的 |
| threads-covered | 有成功线程没被提到（丢了线程） |
| failed-listed | 失败线程没如实列出（丢了失败，或把没跑完的写成已完成） |
| schema-flags-kept | 契约未通过的线程没标注 |
| files-consistent | 列出的改动文件超出各线程证据里的文件（编造文件） |

检查不过时合并仍算完成（`merged.ok: true`，`verified: false`），审阅项的
verification 状态记 `failed`，等人工复。**不要拿“合并了”当“对了”**：
合并步也可能引入幻觉与遗漏，这 5 项只是启发式文本判定，只核说法不验语
义；内容对错由人批复。

无成功线程时不调合并子 agent，直接回 `ok: false`（“没有成功线程可合
并”）；合并子 agent 失败时同样回 `ok: false`，原因记在 `merged` 里，并
行结果本身不受影响。

新事件：`merge_started` / `merge_finished`（已注册进 EVENT_FIELDS，
`src/timeline.ts` 有渲染）。

## H-6：顶层委派默认后台跑，跑完回填

以前 `delegate_parallel` 是同轮等待：模型调完等全部线程跑完才继续。本批
改成**默认后台**：顶层委派立即回一个 handle，聊天继续；全部跑完后结果以
单条 consolidated 消息回填（H-5 的合并步就是回填内容）。

```json
{
  "tasks": [{ "task": "调研 A 方案" }, { "task": "调研 B 方案" }],
  "background": true,
  "backfill": "single",
  "merge": true
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `background` | `true` | 立即回 handle，后台跑；显式传 `false` 才同轮等结果 |
| `backfill` | `single` | `single`：跑完回填一条 consolidated 消息；`per-group`：每线程完成回一条，再加最后汇总 |
| `merge` | `false` | 回填内容用 H-5 的合并步合成一份交付物（须人批） |

行为变化是故意的：`background` 默认开。但结果里写清“后台跑，等回填”，
且任务板上有行可查——handle 里带扇出 id 与任务板 id：
“后台跑，等回填：已派发 N 个子任务（fanout fo_xxx，任务板 kb_xxx）……
进度看 `nyra fanout show <id>` 或 `nyra kanban list`；要等结果不要后台
跑，调 delegate_parallel 时传 `background: false`”。

### 扇出落任务板与账本

后台扇出直接落任务板（`kind: delegate`，`nyra kanban` 可查），重启不丢，
不走 Hermes“重启即丢”的老路。扇出自己的账本是 `~/.nyra/fanout.json`
（原子写 0600，损坏先备份再抛错），只记元数据——不记任务正文、不记模型
输出原文、不记绝对路径：

```bash
nyra fanout list
nyra fanout show <扇出 id>
nyra fanout recover   # 回收跑一半的扇出（进程退出后）
```

状态：`running` / `done` / `partial`（部分成功）/ `failed` / `interrupted`
（回收后）。全部跑完时按成功数定状态（0 成功 `failed`、全部成功 `done`、
否则 `partial`），任务板行走对应路径（失败走 fail，成功/部分成功先
verify（方法 fanout）再 done），单条 consolidated 回填消息写进收件箱
（`delivered` 只在收件箱写入成功时才记 true）。

**重启恢复**：进程退出，后台跑着的模型循环就停了——扇出记录与任务板行
还在，但跑一半的任务不能原地续跑（没有模型循环的检查点可恢复，与崩溃
自续同款限制）。`nyra fanout recover` 把 running 的扇出标
`interrupted`，绑的任务板行走 fail 路径（attempts+1，满 3 次熔断进
blocked，只人 reset），并写收件箱通知；已终态的扇出不动。

新事件：`fanout_started` / `fanout_finished` / `fanout_backfilled` /
`fanout_interrupted`（已注册进 EVENT_FIELDS，`src/timeline.ts` 有渲染）。

### “跑完了没人看”由 Heartbeat 兜底

新检查项 `fanout_unfinished`（默认开启，见 `docs/heartbeat.md`）：扇出
状态为 `interrupted` / `failed`，或 `done` / `partial` 但 `delivered`
是 false（跑完了没回填）时，Heartbeat 有发现、先记证据再写收件箱。
已回填的 `done` 不提醒。

## 已知局限（诚实边界）

- 进程退出，后台跑着的模型循环就停了，跑一半的任务不能原地续跑，须
  `nyra fanout recover` 回收（见上）。
- 合并确定性检查是启发式文本判定，只核说法不验语义；内容对错由人批复。
- 合并子 agent 只读；合并步占 1 次子 agent 预算。
- 真实多 agent 场景只在假 provider 上验过；模型调用的取消已接通
  （可靠性打磨第 1 项第一批：/stop、超时、预算触顶都发取消信号，
  见 `docs/cancellation.md`）；Windows/macOS 真机未验证。
