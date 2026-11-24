# 安装包与发版：每次发版安装包同步更新

**站规（2026-11-20）：PC 端与移动端安装包都要做好，每次更新安装包也要
同步更新。** 本文档就是这条站规的落地机制：发版时不用任何人手动传文件，
安装包随 tag 自动挂进 Release，再由签名工作流等齐后统一签名。

## 发版时发生了什么（打一个 `v*` tag 之后）

| 产物 | 工作流 | 触发 | 怎么挂进 Release |
| --- | --- | --- | --- |
| 5 个 Node 二进制 | `node-binaries.yml` | tag / main 推送 / PR / 手动 | `release` 作业：建 Release（写正文、生成 notes）并挂 `dist/*` |
| macOS 通用 `.dmg`、Windows `.msi` / NSIS `-setup.exe` | `desktop.yml` | tag / 手动 | `release` 作业：只挂文件，不写正文（正文归 node-binaries 管） |
| 安卓 debug APK（`nyra-android-debug.apk`） | `mobile.yml` | tag / 手动 | `release` 作业：只挂文件，不写正文 |
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
`DEFAULT_VERSION`（当前 `v0.5.12`，写在每份脚本头部显眼处）。发版时
三处一起改到新版本号（与下面“版本号六处”同步）。`--version latest`
会先把最新 Release 解析成一个 tag，再只从那个 tag 下载二进制、
`SHA256SUMS` 和签名。安装前用 cosign 验证清单签名，再核对哈希。
签名材料缺失、验签失败、清单格式不对、哈希不符，一律拒绝，并且
不运行下载到的文件。哈希一致不能代替签名。`--from-file` 从本地文件装，
不联网、不验签（日志会写明）。

注意：`v0.5.12` 尚未正式发版（本批只改源码与工作流，不打 tag、不发
Release），在它发版之前默认安装会因下载不到而拒绝——这是有意的
fail-closed，不是 bug。已发布的版本里，v0.5.2–v0.5.11 没有
`SHA256SUMS` 和 sigstore 签名，安装会被拒绝；只有 v0.5.1 带这两样。
本地 `--from-file` 安装不验签，日志会写明。

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

开发期间的过渡态：根 `package.json` 与 `src/config.ts` 先行 `0.5.12-dev`
（开发版后缀，明确不是正式版，与 CHANGELOG 顶部“未发布（0.5.12）”
对应），桌面/手机四处仍为 `0.5.11`；正式发版时六处一起升到 `0.5.12`。
此期间手动跑 desktop 工作流会因版本检查失败，属预期（打 tag 发版前会
统一）；Node CI 与 Node binaries 不跑这项检查，不受影响。

## 手动操作（发版之外）

- **只重编某一类安装包**：Actions 里手动跑对应的工作流（`workflow_dispatch`），
  不带 tag 时只出 Artifacts，不挂 Release。
- **只重跑签名**：Actions → “Sign release artifacts” → Run workflow，填 tag
  （如 `v0.5.3`）；它会重新下载全部产物、重算 `SHA256SUMS`、重新签名并
  `--clobber` 回挂。
- **SHA256SUMS 缺失的范围是 v0.5.2–v0.5.11**（原因见 `docs/SIGNING.md`）：
  不要回头改这些 Release；从 0.5.12 起恢复。

## 签名状态（实话）

- `SHA256SUMS` 的 cosign keyless 签名与 SLSA 证明从 0.5.12 起按工作流生成；
  在 v0.5.12 真正发出之前，这句话还不是已发布事实。用户用
  `scripts/verify-release.sh` 先验签再核对哈希。v0.5.2–v0.5.11 没有
  `SHA256SUMS` 和签名（原因见 `docs/SIGNING.md`），只有 v0.5.1 有。
  没有清单或签名时脚本退出码 1。哈希一致不是发布者证明。
- 安装包本身的**代码签名**是另一回事，见 `docs/SIGNING.md`：证书没买，
  Windows `.msi` / `.exe` 与 macOS `.dmg` 目前未签名、未公证；安卓 APK
  是 Gradle 自动生成的 debug 签名（正式 keystore 待用户决定后再接）；
  iOS 没有安装包（要 Apple Developer 账号与证书，与桌面签名同一笔待办）。
