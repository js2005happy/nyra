# Nyra Windows 一键安装脚本（Node 二进制版，不需要管理员权限，不需要 Python）。
# 用法：在 PowerShell 里运行：
#   irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex
# 或下载后双击 / 右键“使用 PowerShell 运行”。
# 卸载：.\install-node.ps1 -Uninstall（删安装目录、两个桌面快捷方式、
# 从用户级 PATH 摘掉安装目录；~/.nyra 数据保留）。
# 作用：从 GitHub Releases 下载 nyra-windows-x64.exe 到 ~/nyra，
# 把 ~/nyra 加进当前用户的 PATH，在桌面建两个快捷方式
# （Nyra 终端 / Nyra 网页界面，带 Nyra 图标），不写注册表、不装服务。
# 网页界面快捷方式调的是真实命令 `nyra ui --open`（0.4.0 起有 ui 子命令）。
#
# 默认版本钉在下面 param 的 $Version = "v0.5.12"（发版时改这一处，
# 同时改 install-node.sh、install-node-macos.sh 与 docs/installers.md）；
# 不再默认 latest。latest 只解析一次，产物、SHA256SUMS 和签名都从
# 这一个 tag 下载。先用 cosign 验清单签名（发布者），再核对哈希（完整性）。
# 签名缺失、验签失败、清单格式不对、哈希不符，一律拒绝，并且不运行
# 下载到的 exe。哈希对上不能代替签名。
# -FromFile 从本地文件装，不联网、不校验（日志里会写明未校验）。
# 注意：v0.5.12 尚未正式发版（本批不打 tag、不发 Release），在它发版
# 之前默认安装会因下载不到而拒绝——这是有意的 fail-closed，不是 bug。
#
# 注意（诚实写，不编造）：
#   - exe 未签名：首次运行 SmartScreen 会弹警告，点“更多信息”→“仍要运行”；
#     积累信誉或买代码签名证书后才会消失。
#   - exe 本身未经真机运行验证：CI 会在 windows-latest 上跑 `nyra.exe --version`
#     烟雾测试；真机首次运行体验待用户反馈后补充。
#   - 旧的 Python 版安装脚本 scripts/install.ps1 已在 0.4.0 删除。
param(
    [string]$Version = "v0.5.12",
    [string]$InstallDir = "$env:USERPROFILE\nyra",
    [string]$FromFile = "",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Repo = "js2005happy/nyra"
$Asset = "nyra-windows-x64.exe"

function Write-Info($msg) { Write-Host "nyra-install: $msg" }
function Write-ErrAndExit($msg) { Write-Host "nyra-install: 错误：$msg" -ForegroundColor Red; exit 1 }

function Resolve-NyraReleaseTag {
    param([string]$Version, [string]$RepoName)
    $v = $Version.Trim()
    if ($v -eq "" -or $v -eq "latest") {
        if ($env:NYRA_LATEST_JSON_FILE) {
            $obj = Get-Content -Raw -Path $env:NYRA_LATEST_JSON_FILE | ConvertFrom-Json
        } else {
            $obj = Invoke-RestMethod -Headers @{ Accept = "application/vnd.github+json" } -Uri "https://api.github.com/repos/$RepoName/releases/latest"
        }
        $tag = [string]$obj.tag_name
        if ($tag -notmatch '^v') { throw "解析 latest 失败：没有以 v 开头的 tag_name" }
        return $tag
    }
    if ($v -notmatch '^v') { return "v$v" }
    return $v
}

function Get-NyraDownloadUrl {
    param([string]$RepoName, [string]$Tag, [string]$Name)
    if ($Tag -notmatch '^v') { throw "拒绝：版本必须是已解析的 tag（以 v 开头），不能是 latest：$Tag" }
    if ($Name -notmatch '^[A-Za-z0-9._+-]+$') { throw "拒绝：产物名非法：$Name" }
    return "https://github.com/$RepoName/releases/download/$Tag/$Name"
}

function Get-NyraPublisherIdentity {
    param([string]$RepoName)
    return "^https://github\.com/$RepoName/\.github/workflows/release-sign\.yml@refs/"
}

# 先验签再核对哈希。失败抛错，不运行产物。NYRA_COSIGN 可指向测试替身。
function Test-NyraReleaseMaterial {
    param([string]$Dir, [string]$AssetName, [string]$File, [string]$RepoName)
    $sums = Join-Path $Dir "SHA256SUMS"
    if (-not (Test-Path $sums) -or (Get-Item $sums).Length -eq 0) {
        throw "没有 SHA256SUMS：哈希清单不存在或是空的，拒绝继续"
    }
    $cosign = if ($env:NYRA_COSIGN) { $env:NYRA_COSIGN } else { "cosign" }
    if (-not (Get-Command $cosign -ErrorAction SilentlyContinue)) {
        throw "无法验证发布者：没有可用的 cosign。SHA256 对上只说明文件和清单一致，不能证明清单来自 $RepoName 的 release-sign 工作流。"
    }
    $ident = Get-NyraPublisherIdentity $RepoName
    $bundle = Join-Path $Dir "SHA256SUMS.bundle"
    $sig = Join-Path $Dir "SHA256SUMS.sig"
    $pem = Join-Path $Dir "SHA256SUMS.pem"
    if (Test-Path $bundle) {
        & $cosign verify-blob --bundle $bundle --certificate-identity-regexp $ident --certificate-oidc-issuer "https://token.actions.githubusercontent.com" $sums
        if ($LASTEXITCODE -ne 0) { throw "签名验证失败：SHA256SUMS 的 sigstore bundle 未通过。拒绝继续。" }
    } elseif ((Test-Path $sig) -and (Test-Path $pem)) {
        & $cosign verify-blob --signature $sig --certificate $pem --certificate-identity-regexp $ident --certificate-oidc-issuer "https://token.actions.githubusercontent.com" $sums
        if ($LASTEXITCODE -ne 0) { throw "签名验证失败：SHA256SUMS 的 sig/pem 未通过。拒绝继续。" }
    } else {
        throw "缺少签名材料：没有 SHA256SUMS.bundle，也没有成对的 SHA256SUMS.sig 与 SHA256SUMS.pem。哈希清单未被认证，拒绝继续。只核对哈希不能证明发布者。"
    }
    $seen = @{}
    $expected = $null
    foreach ($raw in Get-Content $sums) {
        $line = $raw.TrimEnd("`r").Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?([^\s/\\]+)\s*$') {
            throw "SHA256SUMS 格式不对：$line"
        }
        $hash = $Matches[1].ToLower()
        $name = $Matches[2]
        if ($name.Contains("..")) { throw "SHA256SUMS 文件名非法：$name" }
        if ($seen.ContainsKey($name)) { throw "SHA256SUMS 里 $name 出现了两次" }
        $seen[$name] = $true
        if ($name -eq $AssetName) { $expected = $hash }
    }
    if (-not $expected) { throw "SHA256SUMS 里没有 $AssetName" }
    $actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        throw "哈希不匹配：$AssetName 的 sha256 与已验签的 SHA256SUMS 不符，拒绝继续（文件可能被篡改）。"
    }
}

function Save-NyraOptional {
    param([string]$Url, [string]$Dest)
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
    } catch {
        Remove-Item $Dest -Force -ErrorAction SilentlyContinue
    }
}

if ($env:NYRA_INSTALL_SKIP_MAIN -eq "1") {
    return
}

if ($Uninstall) {
    # 卸载：删安装目录、两个桌面快捷方式、从用户级 PATH 摘掉安装目录；保留 ~/.nyra 数据。
    $Desktop = [Environment]::GetFolderPath("Desktop")
    foreach ($name in @("Nyra 终端.lnk", "Nyra 网页界面.lnk")) {
        $lnk = Join-Path $Desktop $name
        if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Info "已删除快捷方式：$lnk" }
    }
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -like "*$InstallDir*") {
        $norm = $InstallDir.TrimEnd("\")
        $parts = $UserPath -split ";" | Where-Object { $_ -ne "" -and $_.TrimEnd("\") -ne $norm }
        [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
        Write-Info "已把 $InstallDir 从用户 PATH 摘掉（新开终端生效）。"
    }
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Info "已删除安装目录：$InstallDir" }
    Write-Info "已卸载。数据目录 $env:USERPROFILE\.nyra 已保留（如需彻底清除请手动删除）。"
    exit 0
}

try {
    $Tag = Resolve-NyraReleaseTag -Version $Version -RepoName $Repo
    $Url = Get-NyraDownloadUrl -RepoName $Repo -Tag $Tag -Name $Asset
} catch {
    Write-ErrAndExit $_.Exception.Message
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Exe = Join-Path $InstallDir "nyra.exe"

if ($FromFile -ne "") {
    if (-not (Test-Path $FromFile)) { Write-ErrAndExit "找不到本地二进制：$FromFile（先在 CI 或 Linux 上编好）" }
    Write-Info "从本地文件安装：$FromFile（本地文件，不联网、不验签、不核对哈希）"
    Copy-Item $FromFile $Exe -Force
} else {
    $Stage = Join-Path $env:TEMP ("nyra-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    $StagedExe = Join-Path $Stage $Asset
    try {
        Write-Info "安装 Release $Tag（产物、清单和签名都来自这个 tag，只解析一次）"
        Write-Info "下载 $Url"
        Invoke-WebRequest -Uri $Url -OutFile $StagedExe -UseBasicParsing
        Invoke-WebRequest -Uri (Get-NyraDownloadUrl $Repo $Tag "SHA256SUMS") -OutFile (Join-Path $Stage "SHA256SUMS") -UseBasicParsing
        Save-NyraOptional (Get-NyraDownloadUrl $Repo $Tag "SHA256SUMS.bundle") (Join-Path $Stage "SHA256SUMS.bundle")
        Save-NyraOptional (Get-NyraDownloadUrl $Repo $Tag "SHA256SUMS.sig") (Join-Path $Stage "SHA256SUMS.sig")
        Save-NyraOptional (Get-NyraDownloadUrl $Repo $Tag "SHA256SUMS.pem") (Join-Path $Stage "SHA256SUMS.pem")
        Test-NyraReleaseMaterial -Dir $Stage -AssetName $Asset -File $StagedExe -RepoName $Repo
        Copy-Item $StagedExe $Exe -Force
        Write-Info "签名与哈希都已通过：$Asset（哈希只证明和已验签的清单一致）"
    } catch {
        Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
        Write-ErrAndExit "$($_.Exception.Message) 已删除本次下载的文件，未安装、未运行。"
    }
    Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
}

# ~/.nyra（0700 语义：Windows 没有 POSIX 权限位，只保证目录存在）
$NyraHome = Join-Path $env:USERPROFILE ".nyra"
New-Item -ItemType Directory -Force -Path $NyraHome | Out-Null

# PATH：只加当前用户级，不动系统级
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Info "已把 $InstallDir 加进用户 PATH（新开终端生效）。"
}

# 桌面快捷方式（Nyra 终端 / Nyra 网页界面）
try {
    $Shell = New-Object -ComObject WScript.Shell
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $Icon = Join-Path $InstallDir "nyra.ico"
    $Term = $Shell.CreateShortcut((Join-Path $Desktop "Nyra 终端.lnk"))
    $Term.TargetPath = $Exe
    $Term.WorkingDirectory = $InstallDir
    if (Test-Path $Icon) { $Term.IconLocation = $Icon }
    $Term.Save()
    $Web = $Shell.CreateShortcut((Join-Path $Desktop "Nyra 网页界面.lnk"))
    $Web.TargetPath = $Exe
    $Web.Arguments = "ui --open"
    $Web.WorkingDirectory = $InstallDir
    if (Test-Path $Icon) { $Web.IconLocation = $Icon }
    $Web.Save()
    Write-Info "桌面快捷方式已建好。"
} catch {
    Write-Info "警告：桌面快捷方式没建好（$($_.Exception.Message)），不影响使用。"
}

Write-Info "自检："
& $Exe --version
Write-Info "装好了。下一步：在新开的终端里跑 nyra setup（首次启动向导），或 nyra doctor 自检。"
Write-Info "注意：SmartScreen 首次运行会弹警告，点“更多信息”→“仍要运行”。"
