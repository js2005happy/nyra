# 签名与验证（SIGNING）

Nyra 有三层签名，分别解决不同问题。**第 1 层在 0.5.12 起恢复（v0.5.2–v0.5.11 的 Release 没有 SHA256SUMS，原因见下），第 2 层是本地约定，第 3 层接线已就绪（0.5.1），等商业证书到位。**

| 层 | 签什么 | 解决什么 | 状态 |
|---|---|---|---|
| 1 | Release 产物 | 用户能证明下载的二进制确实由本仓库构建、且没被篡改 | ⚠️ 0.5.12 起恢复（v0.5.2–v0.5.11 缺失，原因见下） |
| 2 | Git 提交 | 提交确实来自维护者本人 | ⚙️ 本地 SSH 签名（见下） |
| 3 | Windows/macOS 二进制 | 消除 SmartScreen / Gatekeeper 首次运行警告 | ⚙️ 接线已就绪（0.5.1，条件式），证书未配置、产物仍未签名 |

---

## 第 1 层：Release 产物签名（sigstore keyless）

### 为什么用 keyless 而不是 GPG 长期密钥

- 长期私钥要么进 CI secrets（可被窃取、无法轮换），要么人工签（发版必忘）。
- keyless 用 GitHub OIDC 换一张 **10 分钟有效**的证书，签名写入 [Rekor](https://rekor.sigstore.dev) 透明日志。
- 验证方不需要预先信任任何公钥，只需要信任"这个身份 = 这个仓库的这条 workflow"。

### 打标签发版后自动发生

```
git tag v0.5.0 && git push origin v0.5.0
→ Node binaries 建 Release → Node binaries 跑完触发 release-sign.yml（workflow_run）
→ 下载全部产物 → 生成 SHA256SUMS → cosign 签名 → SLSA 来源证明 → 回传 Release
```

### 当前真实状态：v0.5.2–v0.5.11 没有 SHA256SUMS

`SHA256SUMS` 只存在于 v0.5.1，v0.5.2 至 v0.5.11 的 Release 都没有。根因有三处，都在 `release-sign.yml` 里，0.5.12 已修：

1. **`gh --jq -r` 写法是错的**：`gh release view … --json assets --jq -r '.assets[].name'` 里 `--jq` 只接受一个参数，`-r` 被当成 jq 表达式，真正的表达式变成多余位置参数，gh 报 `accepts at most 1 arg(s), received 2` 直接退出；这一步在 `bash -e` 下一失败整个 job 就红了，签名在第一轮询就断了。已修成 `--jq '.assets[].name'`（不带 `-r`），偶发的 gh 失败只算“这次没等到”，继续等。
2. **签名工作流根本没启动**：Release 是 CI 用默认 `GITHUB_TOKEN` 建的（`node-binaries.yml` 的 softprops/action-gh-release），GitHub 不会因此触发 `release: published` 工作流——用 `GITHUB_TOKEN` 触发的事件（除 workflow_dispatch / repository_dispatch 外）不会再触发新的 workflow run。所以只靠 `release: published` 时，tag 推送建 Release 根本不会启动签名。已改走 `workflow_run`：Node binaries 跑完（它负责建 Release）即触发，等待循环再等桌面/手机产物挂齐；手动建的 Release 仍走 `release` 事件，手动重跑仍走 `workflow_dispatch`。
3. **等待循环没有 fail-closed 出口**：以前等满 50 分钟仍缺产物时，脚本会照常下载、签名一份不全的清单。已补：等不到就直接失败，不签不全的清单。

`SHA256SUMS` 从 0.5.12 起恢复。v0.5.11 在 2026-11-24 手动跑签名工作流补了 `SHA256SUMS` 与签名，好让安装脚本能装它；这份签名只证明“签名时 Release 上的这些文件”，不是构建时的来源证明。v0.5.2–v0.5.10 不回头补。安装脚本默认钉住一个已发布、附件齐全的版本（见 docs/installers.md）并强制校验：下载后先对同一 Release 的 `SHA256SUMS` 校验，哈希对不上、清单里没有、下载不到 `SHA256SUMS`，一律拒绝安装；`verify-release.sh` 在没有 `SHA256SUMS` 时直接报“没有 SHA256SUMS”并退出码 1。

Release 页面会多出这些文件：

| 文件 | 作用 |
|---|---|
| `SHA256SUMS` | 每个产物的 sha256 |
| `SHA256SUMS.sig` | 对清单的签名 |
| `SHA256SUMS.pem` | 签名时的短期证书（含 OIDC 身份） |
| `SHA256SUMS.bundle` | 签名 + 证书 + Rekor 凭证（推荐用这个验证） |
| `*.intoto.jsonl` | SLSA 来源证明 |

### 用户怎么验证

```bash
# 一键（自动下载 + 验签 + 校哈希 + 验来源）
bash scripts/verify-release.sh v0.5.0

# 手动两步
cosign verify-blob SHA256SUMS.bundle \
  --certificate-identity-regexp "^https://github\.com/js2005happy/nyra/\.github/workflows/release-sign\.yml@refs/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum -c SHA256SUMS
```

Windows 用 PowerShell：

```powershell
cosign verify-blob SHA256SUMS.bundle `
  --certificate-identity-regexp "^https://github\.com/js2005happy/nyra/\.github/workflows/release-sign\.yml@refs/" `
  --certificate-oidc-issuer https://token.actions.githubusercontent.com `
  SHA256SUMS
Get-FileHash .\nyra-windows-x64.exe -Algorithm SHA256   # 与 SHA256SUMS 对照
```

再核来源证明：

```bash
gh attestation verify nyra-linux-x64 --repo js2005happy/nyra
```

---

## 第 2 层：Git 提交签名（SSH，无需 GPG）

比 GPG 简单：直接用已有的 SSH 密钥，GitHub 也支持。

```bash
# 一次性配置（仓库级）
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git config commit.gpgsign true
git config tag.gpgsign true

# 验证
git log --show-signature -1
```

然后在 GitHub → Settings → SSH and GPG keys → **New SSH key** → Key type 选 **Signing Key**，粘贴同一个 `id_ed25519.pub`。

之后每个提交在 GitHub 上会显示 **Verified**；改过的历史会显示 Unverified。

---

## 第 3 层：二进制代码签名（条件式，需商业证书）

> 目标版本 0.5.1：签名接线已就绪，证书尚未配置，**本版产物仍是未签名的**。证书到位后，下版构建自动带签名，不用再改代码。

### 现在是什么状态

- Windows 桌面安装包（.msi / .exe）：未签名。
- macOS 桌面安装包（.app / .dmg）：只有 ad-hoc 签名，未公证。
- Windows 命令行版（nyra-windows-x64.exe）：未签名。
- macOS 命令行版：未签名（见文末说明）。

### 工作原理（条件式，不拖发版）

CI 里的签名是“有证书就签、没证书照常出未签名包”：

- 仓库里**一个签名秘密都没有**时，构建与以前完全一致，产物未签名。
- 秘密配齐后，下一次构建自动签名（桌面端走 Tauri 自身的签名流程，Windows 命令行版走 osslsigncode）。
- **秘密只配了一半时，构建会直接报错停住**，绝不悄悄出一个未签名包让你误以为签好了。

证书和密码只放在 GitHub Secrets 里，**不要发给任何人（包括我），不要放进 git**。

### Windows：OV 代码签名证书

#### 买哪里

OV（组织验证）代码签名证书，个人可办，需要身份验证（一般几天）：

| 厂商 | 大约价格 | 备注 |
| --- | --- | --- |
| Sectigo | 约 $100–250/年 | 常用的 OV 证书 |
| DigiCert | 约 $100–250/年 | 常用的 OV 证书 |
| SSL.com | 约 $100–250/年 | 常用的 OV 证书 |
| Certum（开源证书） | 约 $60–110/年 | 备选，便宜；只适用于开源项目名义 |

买的时候确认两件事：① 是**代码签名（Code Signing）证书**，不是 SSL 证书（SSL 证书签不了程序）；② 问清楚私钥能不能导出 `.pfx` 文件（见下面一节）。

#### 导出 .pfx 并配好秘密

1. 拿到证书文件（`.cer`）和私钥文件（`.key`）后，合成 `.pfx`（会让你设一个导出密码，**记好它**）：
   ```bash
   openssl pkcs12 -export -in cert.cer -inkey private-key.key -out certificate.pfx
   ```
2. 把 `.pfx` 转成 base64（Windows 上用 `certutil -encode certificate.pfx base64cert.txt`，取文件内容；macOS/Linux 上用 `openssl base64 -A -in certificate.pfx`）。
3. 到 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，加两个秘密：
   | 秘密名 | 内容 |
   | --- | --- |
   | `WINDOWS_CERTIFICATE` | 上一步的 base64 文本 |
   | `WINDOWS_CERTIFICATE_PASSWORD` | 导出 `.pfx` 时设的密码 |
4. 下次跑桌面工作流或 Node binaries 工作流时，Windows 产物会自动签名（带 DigiCert 的 RFC 3161 时间戳，证书过期后签名仍有效）。

#### 先问一句：你的证书导得出 .pfx 吗

实话：2023 年 6 月 1 日起，证书厂商不再把代码签名私钥放进文件发给你，多数新证书发在**硬件 token（U 盘钥匙）或云 HSM**上（比如 DigiCert KeyLocker、SSL.com eSigner）。如果买到的证书导不出 `.pfx`，上面这套流程不适用，要改走厂商自己的签名服务（工作流要另改一小步，届时再接）。**买之前先问厂商一句“私钥能不能导出 .pfx”**，能导出的再按上面配。

### macOS：Apple Developer Program

#### 注册与建证书

1. 注册 [Apple Developer Program](https://developer.apple.com/programs/)，$99/年（免费账号只能开发测试，不能公证）。
2. 在自己的 Mac 上用“钥匙串访问”生成一个证书签名请求（CSR）。
3. 到 Apple Developer 的 Certificates, Identifiers & Profiles 页面，建一个 **Developer ID Application** 证书（这是发给 App Store 以外用户的类型），上传 CSR，下载安装到钥匙串。
4. 在“钥匙串访问”里找到这个证书，展开后右键私钥 → 导出，存成 `.p12` 文件并设一个导出密码。
5. 把 `.p12` 转成 base64：
   ```bash
   openssl base64 -A -in /path/to/certificate.p12 -out certificate-base64.txt
   ```

#### 配好秘密

到 GitHub 仓库 → Settings → Secrets and variables → Actions，加这些秘密：

| 秘密名 | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | `.p12` 的 base64 文本 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `KEYCHAIN_PASSWORD` | CI 里临时钥匙串的密码（自己编一个强密码，只放 Secrets 里） |
| `APPLE_ID` | 你的 Apple ID 邮箱（公证用） |
| `APPLE_PASSWORD` | **专用密码**（在 appleid.apple.com 上生成的 app-specific password，**不是**你的 Apple ID 账号密码） |
| `APPLE_TEAM_ID` | 10 位的 Team ID（在 Apple Developer 账号页能看到） |

配好后，下次跑桌面工作流时，macOS 安装包会自动签名并提交公证（只配了签名、没配公证的三个秘密时，只签名不公证，不报错）。

### 怎么验证签好了

Windows（在 Windows 上）：

```powershell
signtool verify /pa Nyra_0.5.1_x64_en-US.msi
(Get-AuthenticodeSignature .\nyra-windows-x64.exe).Status  # 应为 Valid
```

macOS（在 Mac 上）：

```bash
codesign -dv --verbose=4 /Applications/Nyra.app
spctl -a -vvv -t install Nyra_0.5.1_universal.dmg
xcrun stapler validate Nyra_0.5.1_universal.dmg  # 公证票据已钉上时通过
```

Windows 命令行版（任意平台都可用 osslsigncode）：

```bash
osslsigncode verify -in nyra-windows-x64.exe
```

### 一句实话：签了也不等于立刻没警告

OV 证书签好后，Windows SmartScreen 的警告**不会立刻消失**，要随安装量积累信任才会慢慢消失（微软 2024 年起不再给 EV 证书特殊待遇，OV 和 EV 在这点上一样）。也可以把文件提交给微软人工复核，但不保证通过。macOS 上签名 + 公证做好后，Gatekeeper 一般直接放行。

### 还没做的事

- **macOS 的 Node 命令行版暂不签名**：它是裸 Mach-O 文件，公证票据钉不上去（staple 只支持 .app/.dmg/.pkg），要签得走“打 zip 包再提交公证”的路，构建流程要另改。桌面端 .app/.dmg 是已签名的路，先用那条。
- 证书到期前记得续费并更新 Secrets 里的证书（时间戳能保证旧签名在证书过期后仍有效，但新构建必须用有效期内的证书）。

> 顺序建议：先把第 1、2 层跑顺（零成本、立刻生效），第 3 层等证书下来再补。**第 1 层比第 3 层更重要**——SmartScreen 只是"提示"，而产物签名解决的是"下载到的是不是官方构建"。

---

## 常见问题

**Q：keyless 签名会不会因为证书 10 分钟就过期而失效？**
不会。证书短命是设计：验证时校验的是「签名时刻」证书链 + Rekor 里的时间戳凭证，与现在有没有过期无关。

**Q：能不能不用 cosign，改用 GPG + SHA256SUMS？**
可以，但你得长期保管私钥并让用户预先导入公钥。keyless 的优势是零密钥分发。

**Q：仓库是 private 的话 keyless 还能用吗？**
能，OIDC 身份基于仓库，与可见性无关；但用户验证需要能访问 Release。

**Q：产物里有个文件签名失败怎么办？**
`release-sign.yml` 最后一步是「验证自己的签名」，失败会让整个 job 红掉——这是有意的 fail-closed，不允许静默产出未签名的发布。
