# 子 agent 具名预设（G-P2-3）

子 agent 以前只有白名单与模型指定，没有具名、可分层覆盖的预设——比如一个"只能读、不能写"的 review 预设。本批补预设层，不动已有委派语义。

## 内置预设

| 预设 | 工具 | 说明 |
|---|---|---|
| `general-purpose` | 不限（沿用现有白名单语义） | 默认预设 |
| `review` | 只读工具 + `shell` | 读文件、搜索、列文件、读测试报告等；禁写文件；`shell` 只允许只读命令 |

`review` 的 shell 是只读的：只认 `ls cat head tail grep find wc sort uniq diff pwd echo printf file stat du df uname whoami date git` 开头的命令，且拒绝重定向、命令替换、后台 `&`、环境赋值、`sudo`、`cd`、`git` 写动词（add / commit / push / pull / fetch / merge / rebase / checkout / reset / clean / rm / mv / restore / apply / cherry-pick / init / clone / worktree / update-index）。`git` 只放行只读子命令（status / log / diff / show / branch / ls-files / rev-parse / blame / grep / ls-tree / cat-file / describe / tag；`stash` 只放行 `list`，`remote` 只放行无参或 `-v`，`config` 只放行 0–1 个非标志词）。

**边界**：只读判定是启发式。审批门与 mode 仍在上面兜底——`review` 预设绝不能绕过审批门去写；写操作与审批门语义不动。

## 解析优先级

```
session（本次委派参数）> project（项目配置文件）> user（用户配置文件）> builtin（内置）
```

- **session**：本次委派的 `--preset` 参数（`nyra delegate --preset review`，或 `delegate` / `delegate_parallel` 工具的 `preset` 参数）。
- **project**：`<工作目录>/.nyra/subagent-presets.json`，可覆盖内置预设、同名覆盖内置，或新增自定义预设。只读不写（CLI 不写项目层）。
- **user**：`~/.nyra/subagent-presets.json`（0600 原子写，符号链接拒绝读写，损坏先备份再回空，非法条目逐条丢弃并记 errors），可覆盖内置预设或新增自定义预设。
- **builtin**：`general-purpose` 与 `review`。

未指定预设时走默认名解析：显式 `--preset` > 项目 `defaultPreset` > 用户 `defaultPreset` > `general-purpose`。

**fail-closed**：未知的预设名、非法名（只认 `^[a-z][a-z0-9_-]{0,31}$`）、`defaultPreset` 指到不存在的名字，委派直接拒绝，不启动子任务。自定义预设只认白名单工具名，非法工具名、空 `tools`、`maxTurns` 超出 1–12、`shellReadOnly` 不是布尔值，校验时拒绝并报错。

**收窄**：预设 tools 与显式 tools 取交集——显式只能收窄，不能放宽。模型优先级：显式 > 预设 > `delegate_model`。`maxTurns` 只往下夹（预设更小才生效）。限制性预设（非 `general-purpose` 或非 builtin 来源）记进委派备注，含定义来源与名来源。

## 委派入口

- `nyra delegate "<任务>" [--preset <预设名>] [--max-turns <1-12>] [--model <模型>] [--agent <成员>] [--json]`：一次性委派，起一个子 agent 跑任务并打摘要；`--json` 打结构化输出；失败退出码 1。
- `delegate` / `delegate_parallel` 工具：可带 `preset` 参数；并行委派的每任务也可带 `preset`。

## 自定义预设

```bash
nyra subagent preset list [--json] [--workdir <目录>]
nyra subagent preset show <名> [--json] [--workdir <目录>]
nyra subagent preset add <名> --tools read_file,grep,shell --yes [--model <模型>] [--max-turns <轮数>] [--shell-read-only]
nyra subagent preset remove <名> --yes
nyra subagent preset default [<名>|--clear]
```

`add` / `remove` 只写用户层，须 `--yes`；内置预设删不掉；`default` 设/清/显示用户层默认。`list` / `show` 的 `--workdir` 看项目层。

## 审计

委派时，限制性预设发运行事件 `delegate_preset_applied`（已注册进 `EVENT_FIELDS`），只记预设名、定义来源、生效后的工具表（逗号串），不记任务原文。默认 `general-purpose` 不发事件。
