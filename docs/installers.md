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
| `SHA256SUMS` + `.sig` + `.pem` + `.bundle`、SLSA 证明 | `release-sign.yml` | Release 发布后自动 / 手动填 tag | 等齐全部 9 项产物再下载、算哈希、签名、回挂 |

时序注意：三个构建工作流是并行的，Release 由最先跑完的那个创建；
`release-sign.yml` 在 Release 发布时触发，但它会先等齐 9 项产物（最多
50 分钟——桌面 Tauri 构建比 Node 二进制慢得多），等不到就失败（fail-closed，
不签不全的清单），之后手动 `workflow_dispatch` 填 tag 重跑。

最终一个 Release 应有 **13 个附件**：5 个 Node 二进制 + 3 个桌面安装包
（`.dmg`、`.msi`、`-setup.exe`）+ 1 个安卓 APK + `SHA256SUMS` + `.sig` +
`.pem` + `.bundle`（SLSA 的 `*.intoto.jsonl` 只做来源证明，不挂附件）。

移动构建前提：`mobile/package.json` 的 devDependencies 必须有 `typescript`
（与根目录同版本），因为 `capacitor.config.ts` 是 TS 文件——`bun x cap add android`
读它时找不到 TypeScript 会直接失败、构建走不到 Gradle（0.5.3 曾因此连挂 3 次）。

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

## 手动操作（发版之外）

- **只重编某一类安装包**：Actions 里手动跑对应的工作流（`workflow_dispatch`），
  不带 tag 时只出 Artifacts，不挂 Release。
- **只重跑签名**：Actions → “Sign release artifacts” → Run workflow，填 tag
  （如 `v0.5.3`）；它会重新下载全部产物、重算 `SHA256SUMS`、重新签名并
  `--clobber` 回挂。
- **0.5.2 是例外**：0.5.2 发版时这套机制还没上，Windows 安装包是手动挂的，
  macOS `.dmg` 没进 Release；自动化从 0.5.3 起生效，不要回头改 0.5.2 的
  Release。

## 签名状态（实话）

- `SHA256SUMS` 的 cosign keyless 签名与 SLSA 证明是自动的，每个 Release
  都有，用户可用 `scripts/verify-release.sh` 验证。
- 安装包本身的**代码签名**是另一回事，见 `docs/SIGNING.md`：证书没买，
  Windows `.msi` / `.exe` 与 macOS `.dmg` 目前未签名、未公证；安卓安装包
  敬请期待——目前只有 Gradle 自动生成的 debug 签名 APK（正式 keystore
  待用户决定后再接）；
  iOS 没有安装包（要 Apple Developer 账号与证书，与桌面签名同一笔待办）。
