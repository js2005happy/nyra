**中文** · [English](macos-install.en.md)

# 在 macOS 上安装 Nyra（一键脚本）

> 状态：Node 版脚本是在 Linux 上写好、只做了语法与占位替换检查，
> **尚未在真 Mac 上跑通过**。在 Mac 上第一次跑时若有报错，请把报错贴
> 回来，脚本会跟着修。Linux 安装见
> [docs/linux-install.md](linux-install.md)，Windows 见
> [docs/windows-install.md](windows-install.md)。

## 方式一（推荐）：Node 单文件二进制

`scripts/install-node-macos.sh` 从 GitHub Releases 下载对应架构的二进制
（arm64 用 `nyra-macos-arm64`，Intel 用 `nyra-macos-x64`），**不需要 root，
不需要 Python，也不需要 Node/Bun**（运行时自带）。

```bash
bash scripts/install-node-macos.sh
bash scripts/install-node-macos.sh --version v0.5.2 --with-launchd
```

注意：二进制未签名、未公证，macOS Gatekeeper 首次运行会拦，需右键点
二进制选“打开”放行一次。`.dmg` / `.pkg` 安装包本机做不了，是待办
（见下），不要假装已提供。

> 0.5.2 说明：二进制是完整版（agent 核心、网页界面、插件市场、创造模式
> 都在内）。`--with-launchd` 只装 plist 文件、不 `launchctl load`；
> 确认无误后自己跑 `launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist`
> 再启用（见“调度器”一节）。

### .dmg 安装包（桌面端，CI 构建，不在 Release 里）

- `.dmg` 有，但只在 GitHub Actions 的构建产物里：打开仓库的
  **Actions → Build desktop app**，选一次成功的运行（`v0.5.2` 标签那次
  就行），在页面底部 **Artifacts** 下载 `Nyra-macos-universal`（解压后是
  `Nyra_<版本>_universal.dmg`，Apple 芯片与 Intel 通用）。下载产物需要
  登录 GitHub。`.dmg` 是桌面端（带窗口），不是命令行；桌面端的安装与
  打开未签名 App 的步骤见 [docs/desktop.md](desktop.md)。
- `.pkg`（安装器包）没有，也不计划用它：macOS 只提供 `.dmg` 拖放安装。
- 本机做 `.dmg` 是待办：这台开发机是 Linux，做不出 macOS 安装包，也没法
  验证；做出来之前不要在文档里写“已提供”。

## 它会做什么

- 把二进制装到 `~/.local/share/nyra/nyra`（`--prefix` 可改）；
- 在 `~/.local/bin/nyra` 放符号链接；
- 建 `~/.nyra`（权限 0700，配置与数据目录）；
- 装完跑 `nyra --version` 自检，通不过就报错；
- 加 `--with-launchd` 时，再把调度器 plist 装到
  `~/Library/LaunchAgents/ai.nyra.scheduler.plist`（只装文件、不加载，
  见“调度器”一节）。

重复跑就是升级：旧安装整个被替换，`~/.nyra` 里的数据不动。

## 前置条件

- macOS（本脚本会在非 macOS 系统上直接拒绝，不装一半）；
- `curl`（下载用）；
- 可选：`launchctl`（只要 `--with-launchd` 时用到；macOS 自带）。

脚本不联网装任何东西（除了下载二进制那一步）。

## 安装

```bash
# 方式一：直接从 GitHub Releases 下载安装（默认最新版）
bash scripts/install-node-macos.sh

# 方式二：已经 clone 好了，从本地已编好的二进制安装（不用再下一遍）
bash scripts/build-binaries.sh --only macos-arm64   # 或 macos-x64
bash scripts/install-node-macos.sh --from-file dist/nyra-macos-arm64

# 方式三：顺手把调度器 plist 装好（只装文件、不加载，见“调度器”一节）
bash scripts/install-node-macos.sh --from-file dist/nyra-macos-arm64 --with-launchd
```

装完如果提示 `~/.local/bin 不在 PATH 里`，按提示加一行。macOS 默认
shell 是 zsh，永久生效这样加到 `~/.zshrc`：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

然后新开一个终端，跑 `nyra --version`，看到 `nyra 0.5.2 (node runtime)` 就装好了。
第一次用先配 Key（以 DeepSeek 为例）：

```bash
export DEEPSEEK_API_KEY=你的key
nyra "解释一下这个项目的结构"
```

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--version TAG` | `v0.5.14`（钉住） | 从 GitHub Releases 下载的版本（带 `v` 前缀，如 `v0.5.2`；不带 `v` 也行，脚本会补上；`latest` 也可显式传） |
| `--from-file PATH` | — | 从本地已编好的二进制安装（不联网下载） |
| `--prefix DIR` | `~/.local/share/nyra` | 安装位置（不能是 `/`、不能就是 `$HOME`、不能含空格） |
| `--bin-dir DIR` | `~/.local/bin` | 启动器位置 |
| `--with-launchd` | 关 | 再装 launchd 用户 agent 文件（只装、不加载） |
| `--uninstall` | — | 卸载（见下） |
| `--help` | — | 显示帮助 |

下载后先对同一 Release 的 `SHA256SUMS` 校验再安装：哈希对不上、清单里没有这个文件、下载不到 `SHA256SUMS`，一律拒绝安装。`--from-file` 从本地文件装，不联网、不校验。

## 升级

再跑一遍安装命令就行，例如：

```bash
bash scripts/install-node-macos.sh --from-file dist/nyra-macos-arm64
```

## 卸载

```bash
bash scripts/install-node-macos.sh --uninstall
```

这会停掉并删掉 launchd agent、删掉安装目录与启动器。**`~/.nyra` 会保留**，
里面的会话、任务与配置都在；想连数据一起清掉，自己删 `~/.nyra`。

## 调度器（launchd 用户 agent）

`--with-launchd` 会把 `launchd/ai.nyra.scheduler.plist` 装到
`~/Library/LaunchAgents/ai.nyra.scheduler.plist`，**只装文件、不加载**。
确认无误后自己加载启用。它是 Linux 上 `systemd/nyra-scheduler.service` 的 macOS 等价物：

| systemd（Linux） | launchd（macOS） |
| --- | --- |
| `WantedBy=default.target`（登录时启动） | `RunAtLoad=true` |
| `Restart=on-failure`（崩了重启） | `KeepAlive` + `SuccessfulExit=false`（非 0 退出才重启） |
| `WorkingDirectory=%h` | `WorkingDirectory` = 安装目录的家目录 |

它只负责让 `nyra schedule daemon` 一直跑着；daemon 自己
每 60 秒查一次日程，到点的任务才执行（见 `nyra schedule list` /
`nyra schedule add`）。日志在 `~/.nyra/logs/scheduler.out.log` 与
`scheduler.err.log`。

常用命令：

```bash
launchctl list ai.nyra.scheduler   # 看 agent 是否在跑（有输出就是在跑）
launchctl start ai.nyra.scheduler  # 手动启动一次
launchctl stop ai.nyra.scheduler   # 停掉（开机还会再起，除非 unload）
launchctl unload ~/Library/LaunchAgents/ai.nyra.scheduler.plist  # 停用开机自启
launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist    # 重新启用
tail -f ~/.nyra/logs/scheduler.err.log  # 看 daemon 的报错
```

注意：plist 模板里的 `__NYRA_BIN__` / `__NYRA_HOME__` 是占位符，
安装脚本会按本次安装的实际路径替换；不要手改已安装的 plist，
重装会被覆盖。

## 排错

- `这个脚本只在 macOS 上运行`：你在 Linux/Windows 上跑了它；Linux 用
  `scripts/install-node.sh`，Windows 用 `scripts/install-node.ps1`。
- `下载失败`：检查网络与仓库地址；已编好二进制时改用
  `--from-file`，不走网络。
- `--with-launchd` 后提示“load 失败”：安装本身已成功，只是 agent
  没启动；按上文“调度器”一节手动跑 `launchctl load` 与 `list` 检查，
  或直接用 `nyra schedule daemon` 在终端里跑。
- 装完 `nyra: command not found`：`~/.local/bin` 不在 PATH 里，见上文
  “安装”一节的 PATH 说明；也可以用完整路径 `~/.local/bin/nyra`。
- `launchctl list` 没有输出：agent 没在跑；先 `launchctl load
  ~/Library/LaunchAgents/ai.nyra.scheduler.plist`，再 `list`；
  仍不行时看 `~/.nyra/logs/scheduler.err.log`。
- `launchctl load` 报 Dubious ownership 之类：plist 文件属主或权限不
  对；删掉重装一次（脚本会写成 644、属主是你自己），不要手动 chmod
  成 777。

## 安全说明

脚本只写 `$HOME` 里的四个地方（安装目录、启动器目录、`~/.nyra`，
`--with-launchd` 时再加 `~/Library/LaunchAgents/`）；不读、不存任何
API Key（Key 仍由你自己用环境变量给）。launchd agent 只跑调度器
daemon，不监听端口、不对外联网（daemon 跑任务时按任务本身的需要
联网，与 Linux 的 systemd 服务一致）。
