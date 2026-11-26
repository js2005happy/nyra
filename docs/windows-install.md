**中文** · [English](windows-install.en.md)

# 在 Windows 上安装 Nyra

两种装法：**Node 二进制 exe 单文件**（不用装 Python，推荐）或
**`scripts/install-node.ps1` 一键脚本**（从 GitHub Releases 下载 exe 并
装好，建桌面快捷方式）。想要带窗口的桌面端（不是命令行）装
Release 里的 `.msi` / `-setup.exe`，见 [docs/desktop.md](desktop.md)。
手动一步步装见官网安装面板
（Windows · PowerShell 一栏），和下面几种装法不冲突。

> **先说实话（2026-11-19）**：Node 二进制 exe 是 `node-binaries` 工作流在
> `ubuntu-latest` 上用 Bun 交叉编译出来的，格式已验（PE32+ x86-64），
> 并在 `windows-latest` CI 上跑过 `--version` / `--example` 冒烟；
> 但还没在任何一台真 Windows 电脑上跑过。exe 未签名，SmartScreen 首次
> 运行会弹警告，点“更多信息”→“仍要运行”。第一台真机就是你的电脑：
> 如果装不上，把报错原文贴到仓库 issue 里。

> 0.4.0 注：旧 Python 版 exe（PyInstaller 打包，`build-windows.yml`
> 工作流产出）已随 Python 一起删除；`scripts/install.ps1`（从源码装，
> 需要 Python）也已删除（0.4.0 起）。命令行仍只有 Node 二进制一种装法；
> 0.5.1 起 Release 里另有桌面安装包（`.msi` / `-setup.exe`，见
> [docs/desktop.md](desktop.md)），那是带窗口的桌面端，不是命令行。

## 方式一：Node 二进制 exe 单文件（不用装 Python，推荐）

1. 去仓库 [Releases](https://github.com/js2005happy/nyra/releases) 下最新版，
   下载 `nyra-windows-x64.exe`（打了 `v*` 标签时才有；没打标签时去
   Actions → Node binaries → 最近一次运行下载 `nyra-binaries` 附件）。
   或一键安装（见方式二）。
2. 把 `nyra.exe` 放到一个固定文件夹（比如 `C:\Tools\nyra\`），把这个
   文件夹加进 PATH（设置 → 系统 → 关于 → 高级系统设置 → 环境变量，
   在 Path 里加一行），或每次用完整路径跑它。
3. 配一个模型 Key（以 DeepSeek 为例；只对当前 PowerShell 窗口有效，
   想长期有效请在系统环境变量里加）：

   ```powershell
   $env:DEEPSEEK_API_KEY="sk-..."
   ```

4. 验证：`nyra.exe --version` 应打印 `nyra 0.5.15 (node runtime)`，
   再跑 `nyra.exe setup` 走首次启动向导。

Node exe 是 Bun `--compile` 打的单文件控制台程序，自带运行时，不用
管理员权限，不写注册表、不装服务。你的会话、记忆、配置仍存在
`%USERPROFILE%\.nyra`。

## 方式二：一键脚本（从 Releases 下载并装好）

```powershell
irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex
```

或把 `scripts/install-node.ps1` 下载下来，右键“使用 PowerShell 运行”
（如果提示执行策略，先跑一次
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`）。

脚本会做这些事：

- 从 GitHub Releases 下载 `nyra-windows-x64.exe` 到 `~\nyra`（默认
  最新版，可用 `-Version v0.5.2` 指定）；
- 把安装目录加进用户 PATH（新开终端生效）；
- 在桌面建两个快捷方式：**Nyra 终端**（`nyra.exe`）与
  **Nyra 网页界面**（`nyra.exe ui --open`），图标用安装目录里的
  `nyra.ico`（有才用，没有就跳过，不报错）；
- 跑 `nyra.exe --version` 自检；
- 不写注册表、不装服务、不需要管理员权限。

装完先配 Key（同方式一第 3 步），再双击桌面快捷方式开始用；
验证：`nyra --version` 应打印 `nyra 0.5.2 (node runtime)`。

## 常见问题

- **快捷方式是默认图标，没有 Nyra 图标**：正常。图标文件
  `branding/nyra.ico` 还没推送到仓库（2026-11-18），脚本会先跳过
  图标、只建快捷方式；图标推上去后重跑一次脚本即可换上。
- **PowerShell 提示“无法加载文件，因为在此系统上禁止运行脚本”**：
  这是执行策略，跑
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重试；
  `irm | iex` 的方式不受执行策略影响。
- **exe 双击后窗口一闪而过**：exe 是控制台程序，请在 PowerShell 或
  终端里跑 `nyra.exe`，不要双击。
- **远程脚本安全吗**：`irm | iex` 会直接执行网上拉下来的代码，只
  从官方仓库地址
  `raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1`
  拉；不放心就先下载下来读一遍再跑。
