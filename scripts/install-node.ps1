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
# 默认版本钉在下面 param 的 $Version = "v0.5.15"（发版时改这一处，
# 同时改 install-node.sh、install-node-macos.sh 与 docs/installers.md）；
# 不再默认 latest。下载后先对同一 Release 的 SHA256SUMS 校验再安装：
# 下不到 SHA256SUMS、清单里没有这个文件、哈希对不上，一律拒绝安装。
# -FromFile 从本地文件装，不联网、不校验（日志里会写明未校验）。
# 默认版本只指向已经发布、附件齐全（含 SHA256SUMS）的 Release：发版流程在新 Release
# 挂齐附件之后才改这里，CI（installer-release-check）会核对这一点。
#
# 注意（诚实写，不编造）：
#   - exe 未签名：首次运行 SmartScreen 会弹警告，点“更多信息”→“仍要运行”；
#     积累信誉或买代码签名证书后才会消失。
#   - exe 本身未经真机运行验证：CI 会在 windows-latest 上跑 `nyra.exe --version`
#     烟雾测试；真机首次运行体验待用户反馈后补充。
#   - 旧的 Python 版安装脚本 scripts/install.ps1 已在 0.4.0 删除。
param(
    [string]$Version = "v0.5.15",
    [string]$InstallDir = "$env:USERPROFILE\nyra",
    [string]$FromFile = "",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Repo = "js2005happy/nyra"
$Asset = "nyra-windows-x64.exe"

function Write-Info($msg) { Write-Host "nyra-install: $msg" }
function Write-ErrAndExit($msg) { Write-Host "nyra-install: 错误：$msg" -ForegroundColor Red; exit 1 }

# 校验下载好的 exe：先下同一 Release 的 SHA256SUMS，对上哈希才装。
# 下不到 SHA256SUMS、清单是空的、清单里没有这个文件、哈希对不上，
# 一律删掉已下载的 exe 再拒绝安装（fail-closed）。
function Test-Sha256 {
    param([string]$Asset, [string]$File)
    if ($Version -eq "latest") {
        $SumsUrl = "https://github.com/$Repo/releases/latest/download/SHA256SUMS"
    } else {
        $SumsUrl = "https://github.com/$Repo/releases/download/$Version/SHA256SUMS"
    }
    $SumsFile = Join-Path $env:TEMP ("SHA256SUMS-" + [Guid]::NewGuid().ToString("N"))
    try {
        Invoke-WebRequest -Uri $SumsUrl -OutFile $SumsFile -UseBasicParsing
    } catch {
        Remove-Item $File -Force -ErrorAction SilentlyContinue
        Write-ErrAndExit "没有 SHA256SUMS：下载不到 $SumsUrl，拒绝安装（该 Release 可能没有附带哈希清单）。下载失败：$($_.Exception.Message)"
    }
    if (-not (Test-Path $SumsFile) -or (Get-Item $SumsFile).Length -eq 0) {
        Remove-Item $SumsFile -Force -ErrorAction SilentlyContinue
        Remove-Item $File -Force -ErrorAction SilentlyContinue
        Write-ErrAndExit "没有 SHA256SUMS：$SumsUrl 下载到的清单是空的，拒绝安装"
    }
    $Expected = $null
    foreach ($line in Get-Content $SumsFile) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') {
            if ($Matches[2] -eq $Asset) { $Expected = $Matches[1].ToLower(); break }
        }
    }
    Remove-Item $SumsFile -Force -ErrorAction SilentlyContinue
    if (-not $Expected) {
        Remove-Item $File -Force -ErrorAction SilentlyContinue
        Write-ErrAndExit "没有 SHA256SUMS：清单里没有 $Asset，拒绝安装"
    }
    $Actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
    if ($Actual -ne $Expected) {
        Remove-Item $File -Force -ErrorAction SilentlyContinue
        Write-ErrAndExit "哈希不匹配：$Asset 的 SHA256 与 SHA256SUMS 不符，拒绝安装（文件可能被篡改）"
    }
    Write-Info "哈希校验通过：$Asset"
}

# 下载前先确认这个版本真的发布了：Release 里没有这个文件时 GitHub 回 404，
# 这时直接说“还没发布”，不再让人去查网络。用 1 字节的 GET 探测（不用 HEAD）。
# 网络本身不通时不在这里拦，交给下载报错。
function Assert-Released {
    param([string]$Url)
    $Probe = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri $Url -Method Get -Headers @{ Range = "bytes=0-0" } -UseBasicParsing -OutFile $Probe | Out-Null
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        if ($code -eq 404) {
            Remove-Item $Probe -Force -ErrorAction SilentlyContinue
            Write-ErrAndExit "版本 $Version 还没发布（Release 里找不到 $Asset）。请用 -Version 指定一个已发布的版本（见 https://github.com/$Repo/releases），或稍后再试。"
        }
    }
    Remove-Item $Probe -Force -ErrorAction SilentlyContinue
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

if ($Version -eq "latest") {
    $Url = "https://github.com/$Repo/releases/latest/download/$Asset"
} else {
    $Url = "https://github.com/$Repo/releases/download/$Version/$Asset"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Exe = Join-Path $InstallDir "nyra.exe"

if ($FromFile -ne "") {
    if (-not (Test-Path $FromFile)) { Write-ErrAndExit "找不到本地二进制：$FromFile（先在 CI 或 Linux 上编好）" }
    Write-Info "从本地文件安装：$FromFile（本地文件，不联网、不做哈希校验）"
    Copy-Item $FromFile $Exe -Force
} else {
    Assert-Released -Url $Url
    Write-Info "下载 $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Exe -UseBasicParsing
    } catch {
        Write-ErrAndExit "下载失败：$($_.Exception.Message)。检查网络，或到 https://github.com/$Repo/releases 手动下载 $Asset。"
    }
    Test-Sha256 -Asset $Asset -File $Exe
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
