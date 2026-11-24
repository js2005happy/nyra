# 在 Linux 上安装 Nyra（一键脚本）

## 方式一（推荐）：Node 单文件二进制

`scripts/install-node.sh` 从 GitHub Releases 下载对应架构的单文件二进制，**不需要 root，不需要 Python，也不需要 Node/Bun**（运行时自带）。

```bash
# 直接下载安装（默认最新版）
bash scripts/install-node.sh

# 指定版本 / 顺手装 systemd 用户服务
bash scripts/install-node.sh --version v0.5.2 --with-systemd

# 已编好二进制时从本地安装（不联网下载）
bash scripts/build-binaries.sh --only linux-x64
bash scripts/install-node.sh --from-file dist/nyra-linux-x64
```

它会：下载二进制到 `~/.local/share/nyra/nyra`、在 `~/.local/bin/nyra` 放符号链接、建 `~/.nyra`（0700）、跑 `nyra --version` 自检。重复跑就是升级，`~/.nyra` 里的数据不动。

想要现成的发布包（tarball / `.deb`，需要 root 装 `.deb`）：见
[docs/linux-packaging.md](linux-packaging.md)。

前置条件：`curl` 或 `wget`（二选一）；`--with-systemd` 时还要 `systemctl --user`。

> 0.5.2 说明：二进制是完整版（agent 核心、网页界面、插件市场、创造模式
> 都在内）。`--with-systemd` 只装服务文件、不启动（`schedule daemon`
> 已存在）；确认无误后自己跑 `systemctl --user enable --now nyra-scheduler.service`
> 再启用，见 [docs/linux-systemd.md](linux-systemd.md)。

> 旧 Python 版安装脚本 `scripts/install.sh` 已在 0.4.0 随 Python 一起删除；
> 下面只剩 Node 二进制一种装法。

## 它会做什么

- 把二进制装到 `~/.local/share/nyra/nyra`（`--prefix` 可改）；
- 在 `~/.local/bin/nyra` 放符号链接；
- 建 `~/.nyra`（权限 0700，配置与数据目录）；
- 装完跑 `nyra --version` 自检，通不过就报错；
- 加 `--with-systemd` 时，再把调度器服务文件装到
  `~/.config/systemd/user/nyra-scheduler.service`（只装文件、不启动，
  见 [docs/linux-systemd.md](linux-systemd.md)）。

重复跑就是升级：旧安装整个被替换，`~/.nyra` 里的数据不动。

## 前置条件

- `curl` 或 `wget`（二选一，下载用）；
- 可选：`systemctl --user`（只要 `--with-systemd` 时用到）。

脚本不联网装任何东西（除了下载二进制那一步）。

## 安装

```bash
# 方式一：还没 clone 仓库，让脚本自己从 GitHub 拉
bash scripts/install-node.sh

# 方式二：已经 clone 好了，从当前检出安装（不用再下一遍）
git clone https://github.com/js2005happy/nyra.git
cd nyra
bash scripts/build-binaries.sh --only linux-x64   # 先编出 dist/nyra-linux-x64
bash scripts/install-node.sh --from-file dist/nyra-linux-x64

# 方式三：顺手把调度器装成 systemd 用户服务，开机自启、崩了自动重启
bash scripts/install-node.sh --from-file dist/nyra-linux-x64 --with-systemd
```

装完如果提示 `~/.local/bin 不在 PATH 里`，按提示加一行到你的
`~/.bashrc`（或 `~/.zshrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
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
| `--version TAG` | `v0.5.12`（钉住） | 从 GitHub Releases 下载的版本（带 `v` 前缀，如 `v0.5.1`；不带 `v` 也行，脚本会补上）。显式传 `latest` 时只解析一次 tag，产物和校验材料都从那个 tag 下载 |
| `--from-file PATH` | — | 从本地已编好的二进制安装（不联网下载） |
| `--prefix DIR` | `~/.local/share/nyra` | 安装位置（不能是 `/`、不能就是 `$HOME`、不能含空格） |
| `--bin-dir DIR` | `~/.local/bin` | 启动器位置 |
| `--with-systemd` | 关 | 再装 systemd 用户服务文件（只装、不启动） |
| `--uninstall` | — | 卸载（见下） |
| `--help` | — | 显示帮助 |

## 升级

再跑一遍安装命令就行，例如：

```bash
bash scripts/install-node.sh --from-file dist/nyra-linux-x64
```

## 卸载

```bash
bash scripts/install-node.sh --uninstall
```

这会停掉并删掉 systemd 服务、删掉安装目录与启动器。**`~/.nyra` 会保留**，
里面的会话、任务与配置都在；想连数据一起清掉，自己删 `~/.nyra`。

## 排错

- `下载失败`：检查网络与仓库地址；已编好二进制时改用
  `--from-file dist/nyra-linux-x64`，不走网络。
- `--with-systemd` 后提示“enable 失败”：安装本身已成功，只是这台机器
  没有用户 systemd 总线（比如容器、WSL 默认配置）；按
  [docs/linux-systemd.md](linux-systemd.md) 手动跑 `daemon-reload` 与
  `enable --now`，或直接用 `nyra schedule daemon` 在终端里跑。
- 装完 `nyra: command not found`：`~/.local/bin` 不在 PATH 里，见上文
  “安装”一节的 PATH 说明；也可以用完整路径 `~/.local/bin/nyra`。

## 安全说明

脚本只写 `$HOME` 里的三个地方（安装目录、启动器目录、`~/.nyra`，
`--with-systemd` 时再加 `~/.config/systemd/user/`）；不读、不存任何
API Key（Key 仍由你自己用环境变量给，systemd 服务用 drop-in 补，
见 [docs/linux-systemd.md](linux-systemd.md) 的说明）。
