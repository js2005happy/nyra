# 群组计划引擎（缺口 G-P1-1）

群聊里的分工任务落成一份计划：每一步都有负责人与验收项，一步一步跑，
上一步没过就停下。步骤隔离与验收独立（Pi 的任务板思路，只抄机制）。

## 建计划与加步骤

```sh
nyra group plan create <房间 id> --title <标题> \
  --step-title <第一步标题> --assignee <负责人> \
  --accept <验收项> [--accept <验收项> ...] [--workdir <目录>]
nyra group plan add-step <计划 id> --title <标题> --assignee <负责人> \
  --accept <验收项> [--accept <验收项> ...]
nyra group plan list <房间 id>
nyra group plan show <计划 id>
```

- 计划至少要有一条步骤，每步都要有负责人与至少一项验收项，否则建不起来。
- 账本在 `~/.nyra/group-plans.json`。

## 跑计划：隔离 worktree + 独立验收

```sh
nyra group plan start <计划 id>
```

每一步：

1. **建隔离 worktree**：`git worktree add -b nyra/plan/<计划>/<步>`，
   机器人在自己的 worktree 里干活，不碰主工作区。工作目录不是 git
   仓库时退化成空目录，并记一条 note（不静默假装隔离了）。
2. **跑**：真实 agent 在步骤 worktree 里跑任务。
3. **验收**：先跑确定性检查（改动文件在不在、diff 摘要完整不完整，
   不过就保持 running、不判失败也不放行），再逐项核验收项——执行者
   须按 `验收 acc-N：通过/未通过——证据` 的格式逐项报结论，**没报结论
   的项按没过算**。全过才标 done。
4. 验收项落成缺口 29 的交付契约（manual 项，步骤启动即激活）。

上一步没过，计划停在那一步，不硬跑下一步。计划状态按步骤派生：
全 done = done；有 failed 且没有 running/pending = failed；其余 = active。

## 事件

`group_plan_created` / `group_plan_step_started` /
`group_plan_step_completed` / `group_plan_step_failed`，只记计划与步骤 id，
不记绝对路径。

## 诚实边界

- 程序验收只核“文件在不在、验收项过没过”，不验语义——文件里写错了
  东西、验收项本身写错了，照样判通过，标准本身对不对靠人审。
- 真实多 agent 场景只在假 provider 与本地确定性检查上验过；
  Windows/macOS 真机未验证。
