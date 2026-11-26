**中文** · [English](installers.en.md)

# 安装包与发版：每次发版安装包同步更新

**站规（2026-11-20）：PC 端与移动端安装包都要做好，每次更新安装包也要
同步更新。** 本文档就是这条站规的落地机制：发版时不用任何人手动传文件，
安装包随 tag 自动挂进 Release，再由签名工作流等齐后统一签名。

## 发版时发生了什么（打一个 `v*` tag 之后）

| 产物 | 工作流 | 触发 | 怎么挂进 Release |
| --- | --- | --- | --- |
| 5 个 Node 二进制 | `node-binaries.yml` | tag / main 推送 / PR / 手动 | `release` 作业：建 Release（写正文、生成 notes）并挂 `dist/*` |
| macOS 通用 `.dmg`、Windows `.msi` / NSIS `-setup.exe` | `desktop.yml` | tag / 手动 | `release` 作业：只挂文件，不写正文（正文归 node-binaries 管） |
| 安卓 APK（稳定名 `nyra-android.apk`；debug 签名时另有旧名 `nyra-android-debug.apk`） | `mobile.yml` | tag / 手动 | `release` 作业：只挂文件，不写正文 |
| 桌面安装包的稳定名副本（`Nyra-windows-x64-setup.exe`、`Nyra-windows-x64.msi`、`Nyra-macos-universal.dmg`、`Nyra-linux-x86_64.AppImage`、`Nyra-linux-amd64.deb`） | `desktop.yml` | tag | `release` 作业：内容与带版本号的同一文件相同，供 `releases/latest/download/<稳定名>` 下载链接用 |
| `SHA256SUMS` + `.sig` + `.pem` + `.bundle`、SLSA 证明 | `release-sign.yml` | Node binaries 跑完自动（`workflow_run`）/ Release 手动建后 / 手动填 tag | 等齐全部 9 项产物再下载、算哈希、签名、回挂；等不到就失败，不签不全的清单 |

时序注意：三个构建工作流是并行的，Release 由最先跑完的那个创建；
`release-sign.yml` 在 Node binaries 跑完时触发（`workflow_run`——Release
是 CI 用默认 `GITHUB_TOKEN` 建的，GitHub 不会因此触发 `release` 工作流，
只靠 `release: published` 时签名根本不会启动，v0.5.2–v0.5.11 就是这么
丢的），但它会先等齐 9 项产物（最多 50 分钟——桌面 Tauri 构建比 Node
二进制慢得多），等不到就失败（fail-closed，不签不全的清单），之后手动
`workflow_dispatch` 填 tag 重跑。`SHA256SUMS` 只存在于 v0.5.1，
v0.5.2–v0.5.11 的 Release 都没有（根因另有 `gh --jq -r` 写法错误，见
`docs/SIGNING.md`）；从 0.5.12 起恢复，v0.5.2–v0.5.11 不回头补。

最终一个 Release 应有 **13 个附件**：5 个 Node 二进制 + 3 个桌面安装包
（`.dmg`、`.msi`、`-setup.exe`）+ 1 个安卓 APK + `SHA256SUMS` + `.sig` +
`.pem` + `.bundle`（SLSA 的 `*.intoto.jsonl` 只做来源证明，不挂附件）。

移动构建前提：`mobile/package.json` 的 devDependencies 必须有 `typescript`
（与根目录同版本），因为 `capacitor.config.ts` 是 TS 文件——`bun x cap add android`
读它时找不到 TypeScript 会直接失败、构建走不到 Gradle（0.5.3 曾因此连挂 3 次）。

## 安装脚本钉住的默认版本

三份安装脚本（`scripts/install-node.sh`、`scripts/install-node-macos.sh`、
`scripts/install-node.ps1`）默认不再是无校验的 `latest`，而是钉住
`DEFAULT_VERSION`（当前 `v0.5.15`，写在每份脚本头部显眼处）。下载后先对同一
Release 的 `SHA256SUMS` 校验再安装：哈希对不上、清单里没有这个文件、
下载不到 `SHA256SUMS`，一律拒绝安装（fail-closed）。`--version latest`
仍可显式传，但同样要校验；`--from-file` 从本地文件装，不联网、不校验。
指定的版本还没发布（Release 里找不到对应文件，GitHub 回 404）时，脚本直接说
“版本 vX.Y.Z 还没发布”，不再提示“检查网络”。

**默认版本只能指向已经发布、附件齐全的 Release。** 发版顺序：先推 tag，等
Release 上的二进制、桌面安装包、APK 与 `SHA256SUMS`（签名工作流产出）都挂齐，
再把三份脚本的默认版本改成新版本号，单独提交。Node CI 的 `installer-release-check`
会用 1 字节 GET 逐个核对默认版本 Release 上的附件（含 `SHA256SUMS`），缺一个就红。

v0.5.11 的 `SHA256SUMS` 与签名是 2026-11-24 手动跑签名工作流补上的：它证明的是
“签名时 Release 上的这些文件”，不是构建时的来源证明。

## 版本号：六处（升版时一处都不能漏）

发版前把版本号升到新版，六处一致：

1. 根 `package.json`
2. `src/config.ts` 的 `VERSION`
3. `desktop/package.json`
4. `desktop/src-tauri/tauri.conf.json`
5. `desktop/src-tauri/Cargo.toml`（与 `Cargo.lock` 里的 `nyra-desktop` 条目）
6. `mobile/package.json`

`desktop.yml` 的 “Check versions match” 步骤会核对前五处（第 6 处不在它
的检查里，升版时人工核对）。安卓 APK 的 `versionName` / `versionCode`
不依赖第 6 处：`mobile.yml` 在构建时从 tag 现场写进
`android/app/build.gradle`（`versionName` = tag 去掉 `v`，`versionCode` =
工作流运行号）。

开发期间根 `package.json` 与 `src/config.ts` 可以先行带 `-dev` 后缀（与 CHANGELOG 顶部“未发布”对应）；正式发版时六处一起升到同一个版本号。

## 手动操作（发版之外）

- **只重编某一类安装包**：Actions 里手动跑对应的工作流（`workflow_dispatch`），
  不带 tag 时只出 Artifacts，不挂 Release。
- **只重跑签名**：Actions → “Sign release artifacts” → Run workflow，填 tag
  （如 `v0.5.3`）；它会重新下载全部产物、重算 `SHA256SUMS`、重新签名并
  `--clobber` 回挂。
- **SHA256SUMS 缺失的范围是 v0.5.2–v0.5.11**（原因见 `docs/SIGNING.md`）：
  不要回头改这些 Release；从 0.5.12 起恢复。

## 签名状态（实话）

- `SHA256SUMS` 的 cosign keyless 签名与 SLSA 证明从 0.5.12 起是自动的，
  每个 Release 都有，用户可用 `scripts/verify-release.sh` 验证；
  v0.5.2–v0.5.11 的 Release 没有 `SHA256SUMS`（原因见 `docs/SIGNING.md`），
  只有 v0.5.1 有。没有 `SHA256SUMS` 时 `verify-release.sh` 直接报
  “没有 SHA256SUMS”并退出码 1，不指向不存在的文件。
- 安装包本身的**代码签名**是另一回事，见 `docs/SIGNING.md`：证书没买，
  Windows `.msi` / `.exe` 与 macOS `.dmg` 目前未签名、未公证；安卓 APK
  从 0.5.14 起正式签名（签名者 CN=Nyra，证书 SHA-256 以 `D3:CD:8C:92` 开头），
  发版 tag 构建缺 `ANDROID_KEYSTORE_*` secrets 时直接失败、不退回 debug 签名，
  验签不通过也失败（见 `docs/SIGNING.md` 第 4 层）。从 0.5.13 及更早的临时签名版
  升级需先卸载一次，之后可直接覆盖升级；
  iOS 没有安装包（要 Apple Developer 账号与证书，与桌面签名同一笔待办）。
