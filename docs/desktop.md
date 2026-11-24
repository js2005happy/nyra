# Nyra 桌面端（macOS / Windows）

Nyra 桌面端是一个原生窗口：用系统自带的 WebView（macOS 的 WKWebView、Windows 的 WebView2）显示本机的 Nyra 网页界面，外壳用 [Tauri 2](https://tauri.app)（Rust）写，源码在 `desktop/`。安装包只有几 MB，不内置浏览器内核，也**不内置 Python**。

> 状态：预览版。安装包由 GitHub Actions 构建（工作流 “Build desktop app”，`.github/workflows/desktop.yml`），**没有代码签名**。0.5.3 起，Windows 的 `.msi` / `-setup.exe` 与 macOS 的 `.dmg` 在发版时自动挂进 Release（机制见 `docs/installers.md`）；0.5.2 的 `.dmg` 仍只在 Actions 产物里。macOS 与 Windows 的安装包都没有在真机上手动装过，见文末“已知限制”。

## 它怎么工作

1. 打开 Nyra 后，外壳在本机找一个能运行 Nyra 的程序（顺序见下），在后台启动：
   `nyra ui --host 127.0.0.1 --port 0 --print-url-json --exit-on-stdin-close --workdir ~/Nyra`
2. Nyra 只监听 `127.0.0.1` 的随机端口，每次启动生成新的随机 token，把地址和 token 作为一行 JSON 打到标准输出；外壳读到后让窗口打开这个地址。
3. 关闭窗口 / 退出 App 时，外壳关闭子进程的标准输入，Nyra 自行退出；3 秒内没退就强制结束。
4. 找不到合适的 Nyra 二进制时，窗口显示引导页（怎么装 Nyra），并有“重新检测”按钮，不会崩溃。

查找顺序（按 `desktop/src-tauri/src/lib.rs` 的 `nyra_binary_candidates`）：

1. 环境变量 `NYRA_BIN` 指定的路径（设了它就优先用）；
2. `PATH` 上的 `nyra` 命令（安装脚本放的启动器，或 Windows 单文件 `nyra.exe`）；
3. 安装脚本的默认位置：`~/.local/share/nyra/nyra`（macOS / Linux 一键脚本装的地方）、`~/.local/bin/nyra`、`~/nyra/nyra`（Windows 一键脚本装在 `~/nyra/nyra.exe`，也在这里找）。

每个候选都会先跑一次 `--version`，输出里含 `(node runtime)` 才算数（不是 Node 单文件二进制的就跳过）。**不需要 Python**：桌面端只认 Node 单文件二进制，Python 版 Nyra 已在 0.4.0 删除。

工作目录默认是 `~/Nyra`（没有就新建），可用环境变量 `NYRA_DESKTOP_WORKDIR` 改。

macOS 上从程序坞 / 访达打开的 App 拿不到终端里 `~/.zshrc` 设置的 `PATH` 与 API Key。外壳启动时会读一次登录 shell 的环境（`$SHELL -ilc env`，10 秒超时），补上缺的变量（不覆盖已有的），所以在 `~/.zshrc` 里 `export DEEPSEEK_API_KEY=...` 这类设置对桌面端同样有效；每个 App 只读一次，改了 `~/.zshrc` 要重启 App 才生效。Windows 上用“系统属性 → 环境变量”设置的用户变量会直接生效。

## 安装

### 先决条件：安装包已内嵌命令行

- **安装包里已带同版本 Nyra 命令行**（`tauri.conf.json` 的 `externalBin`：`binaries/nyra-cli`）：装好桌面 App 就能直接用，不用再单独装命令行版。想让桌面端改用指定位置的二进制，设环境变量 `NYRA_BIN=<完整路径>`。
- 不需要 Python、不需要 Node、不需要 Bun。
- 模型 Key 可以从环境变量读，也可以在桌面 App 的首次设置页粘贴保存（见 README“配置模型”）。

### 下载安装包

| 产物 | 怎么拿 |
| --- | --- |
| `Nyra_<版本>_x64_en-US.msi` 与 `Nyra_<版本>_x64-setup.exe`（Windows，NSIS，装到当前用户，不需要管理员） | **Release 里直接下载**：[Releases](https://github.com/js2005happy/nyra/releases) |
| `Nyra_<版本>_universal.dmg`（macOS，Apple 芯片与 Intel 通用） | **Release 里直接下载**：[Releases](https://github.com/js2005happy/nyra/releases)（0.5.3 起发版时自动挂进 Release；0.5.2 的 `.dmg` 仍只在 Actions 产物里：打开仓库的 **Actions → Build desktop app**，选 `v0.5.2` 标签那次运行，在页面底部 **Artifacts** 下载 `Nyra-macos-universal`，需要登录 GitHub，下载下来是 zip，先解压） |

两个安装包都是**未签名**的（见下文打开步骤）。

### macOS：打开未签名的 App

安装包**没有 Apple 开发者签名、没有公证**（只有 macOS 要求的 ad-hoc 签名，不代表任何开发者身份）。第一次打开会被 Gatekeeper 拦下：

1. 打开 `.dmg`，把 Nyra 拖进“应用程序”；
2. 在“应用程序”里**右键（或按住 Control 点按）Nyra → 打开**，在弹窗里再点“打开”；
3. macOS 15 及以后右键可能不再给“打开”按钮：先双击一次让它被拦，然后到 **系统设置 → 隐私与安全性**，在页面下方点“仍要打开”。

也可以在终端里去掉下载隔离标记（只对你信任的文件这样做）：

```bash
xattr -dr com.apple.quarantine /Applications/Nyra.app
```

### Windows：SmartScreen 提示

安装包**没有代码签名证书**，运行 `.msi` 或 `-setup.exe` 时 SmartScreen 会显示“Windows 已保护你的电脑”：点 **更多信息 → 仍要运行**。Windows 10/11 自带 WebView2；极少数精简系统缺少时，NSIS 安装程序会自动下载安装 WebView2 运行时。

## 安全

- 网页界面的 CSP、token 鉴权、`Host` 头校验都**原样保留**，桌面端没有放宽任何一项；地址只绑 `127.0.0.1`，端口随机，token 每次启动随机生成，主要经由子进程的标准输出管道（JSON 行）交给外壳。注意：Nyra 在 `--print-url-json` 模式下仍会把带 token 的人类可读启动行写到标准错误，外壳在引导页显示失败详情前会把其中的 `token=…` 打码，token 不会出现在引导页上。
- 窗口只允许显示内置引导页与这次启动的 `http://127.0.0.1:<端口>`；其他任何网址（包括别的本机端口）都不会在窗口里打开，`http(s)` / `mailto` 链接交给系统默认浏览器。
- 网页界面拿不到任何 Tauri 原生接口（`capabilities` 里没有放行远程地址）；只有内置引导页能调用一个“重新检测”命令。
- 桌面端不播入场动画（入场动画只在手机主屏幕 App 上播放）。

## 从源码构建

需要 Rust（stable）、Node.js 18+，以及各平台的 Tauri 依赖（见 Tauri 文档 “Prerequisites”）。

```bash
cd desktop
npm ci
npx tauri dev                                   # 开发运行
npx tauri build --bundles app,dmg               # macOS（本机架构）
npx tauri build --target universal-apple-darwin --bundles app,dmg   # macOS 通用包
npx tauri build --bundles msi,nsis              # Windows
cd src-tauri && cargo test                      # 外壳的单元测试
```

应用图标是紫色团子方块（几何在 `src/appIcon.ts`），由 `bun scripts/make-icons.ts` 生成（零依赖，自带光栅化与 PNG / ICO / ICNS 编码，任何平台都能跑；`--check` 只核对 SVG）。

- 画面：团子本身就是图块——整块纯紫 #8688ff，只有两只 #141414 竖胶囊眼（比例同界面里的团子头像）。和手机启动器、PWA、favicon 同一套。矢量源 `desktop/icon-src/nyra-app-icon.svg`（Windows / Linux 图块，四周 6% 边距、圆角 19%）。
- 16 / 24 / 32 px 用满格圆角版 `desktop/icon-src/nyra-mark-small.svg`（不留边距，眼睛按小尺寸规则放大：≤20 px +18%，≤28 px +8%），标题栏、任务栏、资源管理器列表里也看得清。
- `icon.ico`（16/24/32/48/64/256）用于 exe、安装程序（`nsis.installerIcon`）、桌面与开始菜单快捷方式、任务栏和窗口；`icon.icns`（16–1024，含 @2x；≥64 px 按 macOS 图标网格 824/1024 的连续圆角主体 + 标准投影）用于 macOS 的 .app、程序坞与访达；`icon.png`（512）给 Linux。没有使用 Tauri 默认图标。
- 启动引导页（`desktop/ui/`）的标志：方块头 `mark.svg`（`mark-dark.svg` 内容相同，保留 `<picture>` 结构），由 `bun scripts/make-icons.ts` 从 `src/brandMark.ts` 生成。

## 已知限制 / 待办

- **未签名**：没有 Apple Developer ID 签名与公证、没有 Windows 代码签名证书，所以有上面的 Gatekeeper / SmartScreen 提示。
- **内嵌同版本命令行**：安装包里已带 `binaries/nyra-cli`，外壳优先用它；`NYRA_BIN` 指定的二进制优先于内嵌的；都找不到时只显示引导页。
- **没有自动更新**：新版本需要重新下载安装。
- **没有在真机上手动验证**：只在 CI 上构建通过、在 Linux 上编译并跑过外壳单元测试；macOS / Windows 上的实际启动、Python 查找、退出清理还没在真机上点过。
- 没有菜单栏 / 托盘、没有多窗口；网页界面里 `target="_blank"` 的同源链接不会打开新窗口。
- 单实例：第二次启动直接聚焦已有窗口，不会再起一个本机服务。
