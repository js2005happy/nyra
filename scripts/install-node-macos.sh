#!/usr/bin/env bash
# Nyra macOS 安装脚本（Node 二进制版，只写 $HOME，不需要 root、不需要 Python）。
#
# 做什么：
#   - 从 GitHub Releases 下载对应架构的二进制
#     （arm64 用 nyra-macos-arm64，Intel 用 nyra-macos-x64），放到 ~/.local/share/nyra/；
#   - 在 ~/.local/bin/nyra 放一个指向二进制的符号链接；
#   - 建 ~/.nyra（0700，Nyra 的配置与数据目录）；
#   - 装完跑 `nyra --version` 自检；
#   - 加 --with-launchd 时，再把 launchd/ai.nyra.scheduler.plist 装到
#     ~/Library/LaunchAgents/（只装文件、不 load：用户确认后再加载，
#     见 docs/macos-install.md）。
#
# 用法：
#   ./scripts/install-node-macos.sh [--version TAG] [--from-file PATH]
#                                   [--prefix DIR] [--bin-dir DIR]
#                                   [--with-launchd] [--uninstall] [--help]
#   默认 --version 是下面 DEFAULT_VERSION 钉住的版本（当前 v0.5.13，
#   发版时改那一处）；已编好二进制时用 --from-file 本地安装。
#   --version 传版本号时带 v 前缀，如 v0.5.1（不带 v 也行，脚本会补上）；
#   latest 也可显式传，但仍要校验。
#
#   下载后先对同一 Release 的 SHA256SUMS 校验再安装：哈希对不上、
#   清单里没有这个文件、下载不到 SHA256SUMS，一律拒绝安装（fail-closed）。
#   --from-file 从本地文件装，不联网、不校验（日志里会写明未校验）。
#
# 要求：curl；--with-launchd 还要 launchctl。
# 注意（诚实写，不编造）：
#   - 二进制未签名、未公证：macOS Gatekeeper 首次运行会拦，
#     需右键点“打开”放行一次，或等后续公证流程；不要编造“已签名”。
#   - .dmg 安装包由 CI 构建（Actions → Build desktop app → 产物
#     Nyra-macos-universal），不在 Release 里；.pkg 没有，不要假装已提供。
#   - 旧的 Python 版安装脚本 scripts/install-macos.sh 已在 0.4.0 删除。
set -euo pipefail

REPO="js2005happy/nyra"
# 默认安装版本（钉住，不再是无校验的 latest）。发版时改这一处，
# 同时改 install-node.sh、install-node.ps1 与 docs/installers.md。
# 默认版本只指向已经发布、附件齐全（含 SHA256SUMS）的 Release：发版流程在新 Release
# 挂齐附件之后才改这里，CI（installer-release-check）会核对这一点。
DEFAULT_VERSION="v0.5.13"
VERSION="$DEFAULT_VERSION"
FROM_FILE=""
PREFIX="${HOME}/.local/share/nyra"
BIN_DIR="${HOME}/.local/bin"
WITH_LAUNCHD=0
UNINSTALL=0

log()  { printf '%s\n' "nyra-install: $*"; }
die()  { printf '%s\n' "nyra-install: 错误：$*" >&2; exit 1; }

# 拒绝危险的 --prefix：空、根目录、$HOME 本身、已存在的文件、含空格。
# （卸载时 rm -rf $PREFIX，不拦住的话 --prefix / 或 --prefix $HOME 会删掉系统或整个 home。）
check_prefix() {
    local p="$1"
    [ -n "$p" ] || die "--prefix 不能为空"
    [ "$p" != "/" ] || die "--prefix 不能是 /"
    [ "$p" != "$HOME" ] || die "--prefix 不能就是 \$HOME（会删掉你的 home）"
    if [ -e "$p" ] && [ ! -d "$p" ]; then
        die "--prefix 已存在且不是目录：$p"
    fi
    case "$p" in
        *' '*) die "--prefix 不能含空格：$p" ;;
    esac
}

# 本脚本只在 macOS 上跑：在别的系统上直接拒绝，别装一半。
check_darwin() {
    [ "$(uname -s)" = "Darwin" ] || die "这个脚本只在 macOS 上运行"
}

usage() {
    sed -n '2,32p' "$0"
    cat <<'EOF'

选项：
  --version TAG      Release 版本（默认 DEFAULT_VERSION 钉住的 v0.5.13）
  --from-file PATH   从本地已编好的二进制安装（不联网下载）
  --prefix DIR       安装位置（默认 ~/.local/share/nyra）
  --bin-dir DIR      nyra 链接位置（默认 ~/.local/bin）
  --with-launchd     再装 launchd 定时任务文件（只装文件、不 load）
  --uninstall        卸载：停掉并删掉服务、安装目录与链接；
                     ~/.nyra（你的数据）会保留
  --help             显示本帮助
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || die "--version 需要一个参数"; VERSION="$2"; shift 2 ;;
        --from-file) [ $# -ge 2 ] || die "--from-file 需要一个路径"; FROM_FILE="$2"; shift 2 ;;
        --prefix) [ $# -ge 2 ] || die "--prefix 需要一个目录"; PREFIX="$2"; shift 2 ;;
        --bin-dir) [ $# -ge 2 ] || die "--bin-dir 需要一个目录"; BIN_DIR="$2"; shift 2 ;;
        --with-launchd) WITH_LAUNCHD=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --help) usage; exit 0 ;;
        *) die "未知选项 $1" ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
LABEL="ai.nyra.scheduler"
PLIST_NAME="ai.nyra.scheduler.plist"
PLIST_SRC="$ROOT/launchd/$PLIST_NAME"
PLIST_DST="${HOME}/Library/LaunchAgents/$PLIST_NAME"

check_darwin
check_prefix "$PREFIX"
# 版本号统一成 v 前缀（仓库标签是 v*；不带 v 传进来会 404）。
if [ "$VERSION" != "latest" ]; then
    case "$VERSION" in
        v*) ;;
        *) VERSION="v$VERSION" ;;
    esac
fi

arch_asset() {
    case "$(uname -m)" in
        arm64) echo "nyra-macos-arm64" ;;
        x86_64) echo "nyra-macos-x64" ;;
        *) die "不支持的架构：$(uname -m)（目前只提供 arm64 与 x64 二进制）" ;;
    esac
}

# 校验下载好的二进制：先下同一 Release 的 SHA256SUMS，对上哈希才装。
# 下不到 SHA256SUMS、清单是空的、清单里没有这个文件、哈希对不上，
# 一律拒绝安装（fail-closed）；失败时删掉已下载的临时文件再退出。
# macOS 默认没有 sha256sum，用 shasum -a 256。
verify_asset() {
    local asset="$1" file="$2" sums_url sums_file expected actual
    if [ "$VERSION" = "latest" ]; then
        sums_url="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
    else
        sums_url="https://github.com/$REPO/releases/download/$VERSION/SHA256SUMS"
    fi
    sums_file="$(mktemp)"
    curl -fL -s -o "$sums_file" "$sums_url" || { rm -f "$sums_file" "$file"; die "没有 SHA256SUMS：下载不到 $sums_url，拒绝安装（该 Release 可能没有附带哈希清单）"; }
    [ -s "$sums_file" ] || { rm -f "$sums_file" "$file"; die "没有 SHA256SUMS：$sums_url 下载到的清单是空的，拒绝安装"; }
    expected="$(awk -v name="$asset" '$2 == name || $2 == ("*" name) { print $1 }' "$sums_file" | head -1)"
    rm -f "$sums_file"
    [ -n "$expected" ] || { rm -f "$file"; die "没有 SHA256SUMS：清单里没有 $asset，拒绝安装"; }
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        rm -f "$file"; die "需要 sha256sum 或 shasum 才能校验（都没有时拒绝安装）"
    fi
    [ "$actual" = "$expected" ] || { rm -f "$file"; die "哈希不匹配：$asset 的 sha256 与 SHA256SUMS 不符，拒绝安装（文件可能被篡改）"; }
    log "哈希校验通过：$asset"
}

# 下载前先确认这个版本真的发布了：Release 里没有这个文件时 GitHub 回 404。
# 这时直接说“还没发布”，不再让人去查网络。用 1 字节的 GET（Range: 0-0）探测，
# 不用 HEAD（Release 附件对 HEAD 会回 401）。网络本身不通时不在这里拦，交给下载报错。
check_released() {
    local url="$1" code=""
    if command -v curl >/dev/null 2>&1; then
        code="$(curl -sL -o /dev/null -r 0-0 -w '%{http_code}' "$url" 2>/dev/null || true)"
    elif command -v wget >/dev/null 2>&1; then
        code="$(wget -q -S -O /dev/null --header='Range: bytes=0-0' "$url" 2>&1 | awk '/^  HTTP\//{c=$2} END{print c}' || true)"
    fi
    if [ "$code" = "404" ]; then
        die "版本 $VERSION 还没发布（Release 里找不到 $(basename "$url")）。请用 --version 指定一个已发布的版本（见 https://github.com/$REPO/releases），或稍后再试。"
    fi
}

if [ "$UNINSTALL" -eq 1 ]; then
    check_prefix "$PREFIX"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST" "$BIN_DIR/nyra"
    rm -rf "$PREFIX"
    log "已卸载（~/.nyra 里的数据保留）。"
    exit 0
fi

ASSET="$(arch_asset)"
mkdir -p "$PREFIX" "$BIN_DIR"
[ -d "${HOME}/.nyra" ] || mkdir -m 700 "${HOME}/.nyra"

if [ -n "$FROM_FILE" ]; then
    [ -f "$FROM_FILE" ] || die "找不到本地二进制：$FROM_FILE（先跑 ./scripts/build-binaries.sh）"
    log "从本地文件安装：$FROM_FILE（本地文件，不联网、不做哈希校验）"
    cp "$FROM_FILE" "$PREFIX/nyra"
else
    command -v curl >/dev/null 2>&1 || die "需要 curl 才能下载"
    if [ "$VERSION" = "latest" ]; then
        URL="https://github.com/$REPO/releases/latest/download/$ASSET"
    else
        URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
    fi
    check_released "$URL"
    log "下载 $URL"
    # 先下到临时文件、成功后再 mv 到位：下载失败时不留半截二进制。
    TMP_BIN="$PREFIX/nyra.tmp.$$"
    rm -f "$TMP_BIN"
    curl -fL --progress-bar -o "$TMP_BIN" "$URL" || { rm -f "$TMP_BIN"; die "下载失败，检查网络或到 https://github.com/$REPO/releases 手动下载 $ASSET"; }
    verify_asset "$ASSET" "$TMP_BIN"
    mv "$TMP_BIN" "$PREFIX/nyra"
fi
chmod 755 "$PREFIX/nyra"
ln -sf "$PREFIX/nyra" "$BIN_DIR/nyra"
log "已装到 $PREFIX/nyra，链接在 $BIN_DIR/nyra"

if [ "$WITH_LAUNCHD" -eq 1 ]; then
    if [ -f "$PLIST_SRC" ] && command -v launchctl >/dev/null 2>&1; then
        mkdir -p "$(dirname "$PLIST_DST")"
        # plist 里 __NYRA_BIN__ / __NYRA_HOME__ 是占位符，换成真实路径。
        sed -e "s|__NYRA_BIN__|$BIN_DIR/nyra|g" \
            -e "s|__NYRA_HOME__|$HOME|g" \
            "$PLIST_SRC" > "$PLIST_DST"
        chmod 644 "$PLIST_DST"
        # 只装文件、不 load：用户确认后再跑 launchctl load。
        log "plist 已装到 $PLIST_DST（未加载）；加载请跑：launchctl load $PLIST_DST"
    else
        log "警告：没装 launchd 服务（缺文件或缺 launchctl），只装了二进制。"
    fi
fi

log "自检："
"$BIN_DIR/nyra" --version
log "装好了。下一步：nyra setup（首次启动向导），或 nyra doctor 自检。"
log "注意：Gatekeeper 首次运行可能拦截，右键点二进制选“打开”放行一次。"
log "提示：~/.local/bin 需要在 PATH 里；不在的话把 export PATH=\"\$HOME/.local/bin:\$PATH\" 加进 ~/.zshrc。"
