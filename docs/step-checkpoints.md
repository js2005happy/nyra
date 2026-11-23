# 步级检查点 + 时间旅行（G-P1-40）

工作流跑完一步，状态就丢了——想“回到第三步改个值重跑”只能整条重跑。本批补上步级检查点（LangGraph checkpoint + MAF WorkflowCheckpoint 的想法，只借想法不抄代码）：每步跑完记一条状态快照，改某一步的值、作废它后面的检查点，再从那一步重放后续步骤。

## 和旧检查点的区别

| | 旧的 `src/checkpoints.ts`（`/rewind`） | 新的步级检查点 |
|---|---|---|
| 记什么 | 写文件前的**文件快照**（最多 20 个） | 每步的**状态快照**（步骤 id、序号、状态摘要、输入指纹） |
| 能干什么 | 恢复文件 | 改某一步的值、从任意一步重放 |
| 互相影响 | 不混用、不互相覆盖 | 各记各的 |

`src/resume.ts` 是子 agent 注册表 + 启动扫荡，也和本批无关。

## 每步自动记一条

工作流每跑完一个节点，`recordNode` 顺手记一条检查点（`src/stepCheckpoints.ts` 的 `buildStepCheckpoint` + `snapshotStepsState`）：

- **状态**：扁平记录，键是 `steps.<步骤 id>.output` / `steps.<步骤 id>.ok`，只认标量（字符串 / 数字 / 布尔 / null）；字符串 ≤ 1000 字，输出摘要 ≤ 500 字；状态最多 32 步、64 个键。
- **输入指纹**：节点输入的 SHA-256（64 位 hex），只用于比对，不存输入原文。
- **不记的东西**：大文件内容、密钥、文件原文——检查点里没有它们，`update_state` 也写不进去。

检查点写失败不破坏运行（静默跳过）：检查点是“能回放就回放”的能力，不是运行正确性的前提。

## Store 三档

| 后端 | 位置 | 说明 |
|---|---|---|
| `file`（默认） | `~/.nyra/step-checkpoints/<运行 id>.json` | 0600 原子写，符号链接拒绝，损坏先备份再回空 |
| `memory` | 进程内 Map | 同一进程内按 home 共享；测试与临时跑用，跨进程不共享 |
| `remote` | HTTP `{base}/runs/{runId}/checkpoints` | GET/PUT JSON，凭据只读 `NYRA_STEP_CHECKPOINT_TOKEN` 环境变量 |

解析优先级：`opts` 显式传 > 环境变量 `NYRA_STEP_CHECKPOINT_STORE` / `NYRA_STEP_CHECKPOINT_REMOTE_URL` > `config.json` 的 `step_checkpoint_store` / `step_checkpoint_remote_url` > 默认 file。remote 没配地址直接报错。

每运行最多 500 条检查点；同一步只留最新一条（upsert 去重）。

```sh
nyra checkpoint store                                    # 看当前后端
nyra checkpoint store --backend memory|file|remote       # 改后端（写进 config.json）
nyra checkpoint store --remote-url <地址>                # 配远端地址（须是 http(s)）
```

远端后端在**运行中自动记录时是 best-effort**（fire-and-forget，写不上不破坏运行）；CLI 的 list/show/update/replay 走 awaited 读写，远端挂了直接报错。

## 查与改

```sh
nyra checkpoint list <运行 id> [--json]                  # 列这条运行的检查点（作废的标 [作废]）
nyra checkpoint show <运行 id> <步骤 id> [--json]        # 看某一步的检查点（for_each 的轮次写 loop[1] 这种节点 id 也行）
nyra checkpoint history <运行 id> [--json]               # 全部检查点（含作废的）
nyra checkpoint update <运行 id> <步骤 id> --set 键=值 [--set ...] [--unset 键]
```

改值规则：

- 键只认 `steps.<步骤 id>.output` / `.ok`；`.ok` 只认 `true` / `false`；output 是字符串原值（不解析 JSON——`--set` 的值就是要进提示词的原文）。
- 改了某一步，**它后面的检查点全部作废**（它们是按旧值算出来的）；作废的检查点不能再改、不能再重放。
- 改的决定记进原运行的事件链（`step_checkpoint_updated`，只记元数据：运行 id、步骤 id、作废了几条）；写不上不破坏更新。

## 时间旅行：重放

```sh
nyra checkpoint replay <运行 id> <步骤 id> [--dry-run] [--yes]
```

做法是**分叉重放**，不是原地改写：原运行的记录不动，新建一条运行（`replayedFrom` 记来源：原运行 id、步骤 id、时间），节点取原运行到检查点为止的前缀——其中被 `update` 改过的步骤输出，先按检查点里的新值换掉——再从下一步接着跑。已跑过的步骤不重跑。

- **只认 fixed 形态**：coordinator / dynamic 的重放计划直接返回不支持（协调者的下一步是运行中决定的，没法从中间接）。
- **for_each**：检查点是 `loop[1]` 这种轮次节点时，重放从所属的循环步骤 `loop` 的下一条开始（整段循环重跑，不单跑某一轮）。
- **花钱 / 审批的步骤**：后面有调模型（llm / delegate / skill）或审批（approve）步骤时，`--dry-run` 只看计划（列每步的分类：deterministic / costed / approval），不加 `--yes` 直接拒绝（退出码 2）。审批节点重放时重新问人，不复用旧批复。
- **红线不动**：重放不绕审批、不绕成本硬顶——月度硬顶与 `--max-cost` 照常（前缀已花的钱算进新运行），重放事件 `step_checkpoint_replayed` 进新运行的事件链。

## 诚实边界

- 只在临时 home / 假 provider / 注入 fetch 上验过；remote 后端只对本机回环 HTTP 服务器验过往返，没对真远端服务跑过。
- 远端后端在运行中自动记录是 best-effort：网络抖一下，那一步的检查点就没了，事后只能从下一条有检查点的步骤重放。
- for_each 检查点重放时整段循环重跑；审批节点重放重新问人。
- Windows/macOS 真机未验证。
