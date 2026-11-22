# Nyra 应用图标：定稿 C · 方块团子

Nyra 的应用图标是 bot 形象（紫色团子，见 [`../bot/`](../bot/)）的方块形态：团子本身变成圆角方块，整块紫色撑满图标，只留两只深色竖胶囊眼。安卓圆形遮罩下，它正好还原成圆团子，和界面里的 Nyra 头像是同一个角色。

- 团子紫 `#8688ff`，眼睛 `#141414`（竖胶囊，比例取自 `../bot/avatars/svg/nyra-idle.svg`）。
- 平涂：无渐变、无高光、无描边。
- 小尺寸规则与头像一致：≤ 20px 眼睛放大 18%，≤ 28px 放大 8%（favicon 已按此放大）。

## 文件

| 路径 | 内容 |
| --- | --- |
| `C/nyra-C-master-1024.svg/.png` | 满版方形母版 1024×1024，无遮罩（iOS、应用商店用，由系统加遮罩） |
| `C/nyra-C-ios-1024.svg/.png` | iOS 超椭圆遮罩预览 1024 |
| `C/nyra-C-macos-1024.svg/.png` | macOS 网格 1024：主体 824 + 四边各 100 边距 + 投影，可直接做 `.icns` |
| `C/nyra-C-android-fg-432.svg/.png` | Android 自适应前景层 432（108dp 画布，画面映射到中心 72dp 安全区） |
| `C/nyra-C-android-bg-432.svg/.png` | Android 自适应背景层 432（纯紫） |
| `C/nyra-C-android-round-512.svg/.png` | Android 圆形遮罩预览 512 |
| `C/nyra-C-win-256.svg/.png` | Windows 256：6% 边距，圆角 19% |
| `C/nyra-C-favicon-16.svg/.png`、`-32` | 浏览器 favicon 16 / 32：满格，圆角 22% |
| `board.png` | 定稿 C 在各端的真实像素预览：macOS Dock 64px（深 / 浅）、iOS 主屏 60px、Android 圆形遮罩 56px、Android 圆角方 + 浅壁纸、Windows 任务栏 24 / 32px（深 / 浅）、浏览器 favicon 16 / 32px（深 / 浅标签栏 + 像素放大） |
| `applied.png` | 替换到仓库后各端实际文件的效果：apple-touch 180、`icon.icns`、`icon.ico` 256、Android 前景 + 圆形遮罩合成、Linux / PWA、favicon |

## 各端尺寸

| 平台 | 母版 | 交付尺寸 |
| --- | --- | --- |
| iOS / apple-touch | `master-1024` | 1024（商店），180（apple-touch-icon），系统加超椭圆遮罩 |
| macOS | `macos-1024` | `.icns` 16 / 32 / 128 / 256 / 512（各含 @2x） |
| Windows | `win-256` | `.ico` 16 / 24 / 32 / 48 / 64 / 256 |
| Android | `android-fg-432` + `android-bg-432` | 自适应图标 108dp（432px @4x），安全区 72dp；圆形遮罩预览 `android-round-512` |
| Linux / PWA | `master-1024` | `icon.png` 512，PWA 192 / 512 |
| 浏览器 | `favicon-16` / `favicon-32` | `favicon.ico` 16 + 32 |
