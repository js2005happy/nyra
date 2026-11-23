# 手机端（Capacitor 壳 + 启动器页）

手机 App 是个“启动器壳”，不是把 Nyra 搬进手机：agent 在云端跑
（第 6 批，见 `docs/mobile-cloud.md`），手机用账号登录后直连云端服务。
壳里只装一张静态启动页（`www/index.html`），用户填云端地址、点
Google / GitHub / 邮箱任一按钮打开云端登录页，登完进云端手机页。
局域网表单（电脑 IP + 8765 端口 + 配对码，跳电脑上 `nyra ui` 的手机页
`/m`）退到了启动器页底部的“旧版”折叠区——真云端没上线前它是唯一
能走通的手机路，保留；云端上线走通后，旧版入口再删。所以不需要任何
Capacitor 插件，也没有 `server.url`（云端地址由用户在启动器页里填一次、
存在 localStorage，下次直接用）。

## 路线决定（为什么是 Capacitor、为什么先只做安卓）

- **TWA 不做**：Trusted Web Activity 要一个公开 HTTPS 源来托管 PWA，
  Nyra 的手机页只在用户自己的局域网里（`http://<电脑 IP>:8765/m`），
  没有公开源，包不起来。
- **Tauri Mobile 不做**：那会在 `desktop/` 里再开一套移动端目标（Hark 的
  领地），而桌面壳现在的做法是启动已安装的 `nyra` 二进制——手机上没有
  这个二进制，整条路要重做，不是一批能跑通的量。
- **Capacitor**：只包启动器页 + 图标 + 独立窗口，改动面最小（`mobile/` 一个
  新目录，不碰 `desktop/`、不碰 `src/`），安卓 debug APK 在 CI 里能直接
  编出来。代价是 iOS 暂缓：iOS 包要 Apple Developer 账号与证书才能装到
  真机上，与桌面签名的证书是同一笔待办（见 `docs/SIGNING.md`），证书
  到位后再接。

## 目录

| 路径 | 说明 |
| --- | --- |
| `www/index.html` | 启动器页：静态单文件，不发任何外部请求；主入口是账号登录（填云端地址 → 打开云端登录页 /app），局域网表单退到“旧版”折叠区；云端地址与上次连过的电脑各记在 localStorage |
| `assets/` | 图标与启动图源文件（已提交进仓库）：`icon.png` / `icon-foreground.png` / `icon-background.png` / `splash.png` / `splash-dark.png`，由 `scripts/make-assets.ts` 从正式标志生成 |
| `scripts/make-assets.ts` | 生成 `assets/`：`bun scripts/make-assets.ts`（改标志时才跑，零依赖，复用 `src/brandMark.ts`） |
| `scripts/patch-android-manifest.sh` | 给生成的 Android 清单加 `android:usesCleartextTraffic="true"`：启动器要跳明文 HTTP 的局域网地址，Android 9+ 默认会拦；Capacitor 8 的 `cap sync` 不会自己加 |
| `capacitor.config.ts` | `appId dev.nyra.mobile`，`webDir www` |
| `android/` | **不提交**：CI 里 `bun x cap add android` 现场生成（见 `.github/workflows/mobile.yml`） |

## 本地构建（要 Android SDK，见“已知局限”）

```bash
cd mobile
bun install
bun x cap add android        # 只在 android/ 不存在时跑
bun x cap sync android
bash scripts/patch-android-manifest.sh
bun x @capacitor/assets generate --android
cd android && ./gradlew assembleDebug --no-daemon
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

## 版本

APK 的 `versionName` / `versionCode` 在 CI 里从 tag 写进
`android/app/build.gradle`（`versionName` = tag 去掉 `v`，`versionCode` =
工作流运行号，单调递增）；`mobile/package.json` 的 `version` 只作参考，
发版升版时与根版本号一起升（六处清单见 `docs/installers.md`）。

## 已知局限（实话）

- APK 是 **debug 签名**（Gradle 自动生成的 debug keystore）：能装、能跑，
  但不是正式签名；正式 keystore 是后续待办，需要用户自己的 keystore 进
  CI secrets，与 OV 证书同一类待办。
- **没在真机上装过**：APK 只在 CI 里编出来；真机安装、云端登录跳转、局域网跳转、配对
  流程都还没亲手试过，第一次装时如有出入以手机上实际出现的为准。
- **真云端还没上线**：启动器页的账号登录按钮打开的是云端登录页，
  但云端服务本身未部署（见 `docs/mobile-cloud.md` §3）；云端地址没配好时
  按钮会先提示配地址，不会链向设计占位地址。
- iOS 没有安装包（原因见上文“路线决定”）；iPhone 继续用 PWA（见
  `docs/mobile-pwa.md`）。
- 跳到 `/m` 后 WebView 就离开了 Capacitor 上下文：页面是电脑直接提供的，
  没有 Capacitor 插件可用；按系统返回键会回到启动器页。
