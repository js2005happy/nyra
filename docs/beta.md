**中文** · [English](beta.en.md)

# Nyra 内测上手说明

谢谢你来试 Nyra！这份说明只写**现在已经能用**的功能；还没做好的标了「即将推出」。
遇到问题或有想法，请按文末「如何反馈」告诉我们。

> Nyra 还在早期内测阶段：界面和功能会频繁变化，也会有粗糙的地方。
> 它会在你的电脑上读写文件、执行命令——默认每一步动手前都会先问你，请看清审批卡再点「允许」。

## 1. 安装

所有安装包都在 [Releases 最新版](https://github.com/js2005happy/nyra/releases/latest) 里。

| 平台 | 下载 | 说明 |
| --- | --- | --- |
| Windows 10/11 | `Nyra-windows-x64-setup.exe`（或 `.msi`） | 双击安装，装到当前用户，不需要管理员。安装包**没有代码签名**，SmartScreen 会提示「已保护你的电脑」，点「更多信息 → 仍要运行」。 |
| macOS（Apple 芯片 / Intel） | `Nyra-macos-universal.dmg` | 打开 dmg，把 Nyra 拖进「应用程序」。安装包**没有公证**，第一次打开要在「应用程序」里右键 Nyra → 打开，再确认一次。 |
| Linux x64 | `Nyra-linux-x86_64.AppImage` 或 `Nyra-linux-amd64.deb` | AppImage：`chmod +x` 后直接运行；deb：`sudo apt install ./Nyra-linux-amd64.deb`。 |
| 只要命令行 | `nyra-windows-x64.exe` / `nyra-macos-arm64` / `nyra-macos-x64` / `nyra-linux-x64` / `nyra-linux-arm64` | 单文件，不用装 Node 或 Python。也可以用一键脚本（见下）。 |
| 安卓 | `nyra-android.apk` | 手机上的「启动器」，用来连你家里的电脑（见第 3 节）。从 0.5.14 起 APK 正式签名（签名者 CN=Nyra），从 0.5.13 及更早的临时签名版升级**需要先卸载一次**，之后就能直接覆盖升级。 |
| iPhone | 没有安装包 | 用 Safari 打开电脑上的手机网页（见第 3 节），可「添加到主屏幕」。 |

一键安装命令行版：

```bash
# Linux
curl -fsSL https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.sh | bash
# macOS
curl -fsSL https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node-macos.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex
```

装好后在终端里跑：

```bash
nyra --version   # 看到版本号就说明装好了
nyra doctor      # 自检：Key、网络、目录权限、磁盘
```

桌面应用里已经带了同版本的命令行，只用桌面应用的话不用另外装。

## 2. 配置模型

Nyra 本身不带模型，需要你用自己的模型 API Key（Key 只存在你自己的电脑上）。

- **桌面应用 / 网页界面**：第一次打开会弹出「设置 Nyra」，选一个模型提供商、粘贴 Key、点「测试连接」，再点「保存并开始」。之后可以在 **设置 → 模型** 里换模型或换 Key。
- **命令行**：运行 `nyra setup`，按三步向导走完。也可以用环境变量，例如 `export DEEPSEEK_API_KEY=...`。
- **本地模型**：本机装了 Ollama 时，选 Ollama 即可，不需要 Key。
- **自定义的 OpenAI 兼容服务**：在 `~/.nyra/config.json` 里加 `custom_providers`，写上 `base_url` 和 `default_model`，再把 `provider` 设成它的名字；Nyra 会直接用它自己的 `default_model`（0.5.13 起不需要再在顶层写一遍 `model`）。

`nyra --list-providers` 可以看全部内置的提供商。没配 Key 时，Nyra 不会发出任何模型请求。

## 3. 手机连电脑

手机不运行 Nyra 本身：手机连到你电脑上的 Nyra，工具仍然在电脑上执行。目前手机和电脑需要在**同一个 Wi-Fi** 里。

1. 在电脑终端里运行：

   ```bash
   nyra ui --pair
   ```

   终端会显示一个二维码、一个手机网址和一个 6 位配对码（5 分钟内有效、只能用一次，输错 5 次作废）。
   也可以在网页界面的 **设置 → 手机与设备 → 连接手机** 里看到同样的二维码。
   （桌面应用默认只监听本机，要连手机请用上面的命令启动。）
2. 手机连接：
   - **安卓 App**：打开 Nyra，展开「连家里电脑」，填电脑的局域网地址、端口和配对码，点连接。下次打开可以一键直连上次的电脑。
   - **手机浏览器（安卓 / iPhone）**：用相机扫二维码，或在浏览器打开终端里显示的网址，输入配对码。可以「添加到主屏幕」当 App 用。
3. 连上后可以：看对话列表、发新任务、在「待你决定」里批准或拒绝审批、看自动化、跟总指挥说要做的事。

每台手机拿到自己的长期凭证，电脑上只存哈希，可以在 **设置 → 手机与设备** 里随时撤销。

**即将推出**：手机端用账号登录（Google、GitHub、邮箱）、不在同一个 Wi-Fi 也能连——登录按钮已经在 App 首页，但云端服务还没上线，现在点不通。

## 4. 开始用

- 桌面应用或 `nyra ui`：在输入框里描述任务，回车发送。动手前会出现审批卡：「允许一次」/「不行，换个做法」。
- 命令行：`nyra` 进入交互模式，`/help` 看全部命令，`/exit` 退出。
- 权限模式可以在输入框下面切换：只读、写入前先问（默认）、完全访问。

## 5. 如何反馈

到仓库的 [Issues → New issue](https://github.com/js2005happy/nyra/issues/new/choose) 选一个模板：

- **内测问题反馈（Bug）**：装不上、打不开、报错、结果不对。
- **内测体验反馈**：好不好用、哪里看不懂、希望加什么。

请写上平台、Nyra 版本（`nyra --version` 或 设置 → 关于）和复现步骤，能附截图更好。

> **⚠️ 不要在 Issue 里贴 API Key、密码或配对码。** 贴日志和截图前先检查一遍。
> 发现安全问题请不要公开提交，按 [SECURITY.md](../SECURITY.md) 私下报告。
