#!/usr/bin/env bash
# Nyra Linux 安装脚本（Node 二进制版，只写 $HOME，不需要 root、不需要 Python）。
#
# 做什么：
#   - 从 GitHub Releases 下载对应架构的 nyra 单文件二进制
#     （nyra-linux-x64 / nyra-linux-arm64），放到 ~/.local/share/nyra/；
#   - 在 ~/.local/bin/nyra 放一个指向二进制的符号链接；
#   - 建 ~/.nyra（0700，Nyra 的配置与数据目录）；
#   - 装完跑 `nyra --version` 自检（doctor 等配好 Key 后再跑，见下）；
#   - 加 --with-systemd 时，再把 systemd/nyra-scheduler.service 装到
#     ~/.config/systemd/user/（只装文件、不 enable/start：用户确认后再启用，
#     见 docs/linux-systemd.md）。
#
# 用法：
#   ./scripts/install-node.sh [--version TAG] [--from-file PATH]
#                             [--prefix DIR] [--bin-dir DIR]
#                             [--with-systemd] [--uninstall] [--help]
#   默认 --version 是下面 DEFAULT_VERSION 钉住的版本（当前 v0.5.12，
#   发版时改那一处）；已编好二进制时用 --from-file dist/nyra-linux-x64
#   从本地文件安装（不联网下载）。--version 传版本号时带 v 前缀，
#   如 v0.5.1（不带 v 也行，脚本会补上）；latest 也可显式传，但仍要校验。
#   重复跑就是升级：旧二进制会被替换，~/.nyra 里的数据不动。
#
#   下载后先对同一 Release 的 SHA256SUMS 校验再安装：哈希对不上、
#   清单里没有这个文件、下载不到 SHA256SUMS，一律拒绝安装（fail-closed）。
#   --from-file 从本地文件装，不联网、不校验（日志里会写明未校验）。
#
# 要求：curl 或 wget（二选一）；--with-systemd 还要 systemctl。
# 不装 Python、不装 Node、不装 Bun——二进制自带运行时。
# Windows/macOS 产物未签名与未公证的问题见 docs/windows-install.md
# 与 docs/macos-install.md；Linux 产物为动态链接，需要 glibc。

set -euo pipefail

REPO="js2005happy/nyra"
# 默认安装版本（钉住，不再是无校验的 latest）。发版时改这一处，
# 同时改 install-node-macos.sh、install-node.ps1 与 docs/installers.md。
# 默认版本只指向已经发布、附件齐全（含 SHA256SUMS）的 Release：发版流程在新 Release
# 挂齐附件之后才改这里，CI（installer-release-check）会核对这一点。
DEFAULT_VERSION="v0.5.12"
VERSION="$DEFAULT_VERSION"
FROM_FILE=""
PREFIX="${HOME}/.local/share/nyra"
BIN_DIR="${HOME}/.local/bin"
WITH_SYSTEMD=0
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
        *' '*) die "--prefix 不能含空格：$p（systemd 的 ExecStart 不好写）" ;;
    esac
}

# 本脚本只在 Linux 上跑：在别的系统上直接拒绝，别装一半。
# （macOS 用 scripts/install-node-macos.sh，Windows 用 scripts/install-node.ps1。）
check_linux() {
    [ "$(uname -s)" = "Linux" ] || die "这个脚本只在 Linux 上运行"
}

usage() {
    sed -n '2,31p' "$0"
    cat <<'EOF'

选项：
  --version TAG      Release 版本（默认 DEFAULT_VERSION 钉住的 v0.5.12）
  --from-file PATH   从本地已编好的二进制安装（不联网下载）
  --prefix DIR       安装位置（默认 ~/.local/share/nyra）
  --bin-dir DIR      nyra 链接位置（默认 ~/.local/bin）
  --with-systemd     再装 systemd 用户服务文件（只装文件、不启动，
                     只在带 systemd 的 Linux 上有效）
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
        --with-systemd) WITH_SYSTEMD=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --help) usage; exit 0 ;;
        *) die "未知选项 $1" ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SRC="$ROOT/systemd/nyra-scheduler.service"
SERVICE_DST="${HOME}/.config/systemd/user/nyra-scheduler.service"

check_linux
check_prefix "$PREFIX"
# 版本号统一成 v 前缀（仓库标签是 v*；不带 v 传进来会 404）。
if [ "$VERSION" != "latest" ]; then
    case "$VERSION" in
        v*) ;;
        *) VERSION="v$VERSION" ;;
    esac
fi

arch_name() {
    case "$(uname -m)" in
        x86_64|amd64) echo "nyra-linux-x64" ;;
        aarch64|arm64) echo "nyra-linux-arm64" ;;
        *) die "不支持的架构：$(uname -m)（目前只提供 x64 与 arm64 二进制）" ;;
    esac
}

# 下载到临时文件、成功后再 mv 到位：下载失败（断网、404）时不留半截
# 二进制，否则后面 chmod +x 与 --version 自检会对着损坏文件报错，
# 而符号链接还指着它。
download() {
    # 注意：不能写成一行 local url="$1" dest="$2" tmp="$dest.tmp.$$"
    # ——同一条 local 里的右值在赋值前就全展开了，$dest 当时还没绑定，
    # set -u 下直接报 "dest: unbound variable"（下载路径此前一直是坏的，
    # CI 只跑 --from-file 从没走过 download()）。
    local url="$1"
    local dest="$2"
    local tmp="$dest.tmp.$$"
    rm -f "$tmp"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --progress-bar -o "$tmp" "$url" || { rm -f "$tmp"; die "下载失败：$url（检查网络，或到 https://github.com/$REPO/releases 手动下载）"; }
    elif command -v wget >/dev/null 2>&1; then
        wget -q --show-progress -O "$tmp" "$url" || { rm -f "$tmp"; die "下载失败：$url（检查网络，或到 https://github.com/$REPO/releases 手动下载）"; }
    else
        die "需要 curl 或 wget 才能下载（二选一）"
    fi
    mv "$tmp" "$dest"
}

# 校验下载好的二进制：先下同一 Release 的 SHA256SUMS，对上哈希才装。
# 下不到 SHA256SUMS、清单是空的、清单里没有这个文件、哈希对不上，
# 一律拒绝安装（fail-closed）；失败时删掉已下载的临时文件再退出。
verify_asset() {
    local asset="$1" file="$2" sums_url sums_file expected actual
    if [ "$VERSION" = "latest" ]; then
        sums_url="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
    else
        sums_url="https://github.com/$REPO/releases/download/$VERSION/SHA256SUMS"
    fi
    sums_file="$(mktemp)"
    if command -v curl >/dev/null 2>&1; then
        curl -fL -s -o "$sums_file" "$sums_url" || { rm -f "$sums_file" "$file"; die "没有 SHA256SUMS：下载不到 $sums_url，拒绝安装（该 Release 可能没有附带哈希清单）"; }
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$sums_file" "$sums_url" || { rm -f "$sums_file" "$file"; die "没有 SHA256SUMS：下载不到 $sums_url，拒绝安装（该 Release 可能没有附带哈希清单）"; }
    else
        rm -f "$sums_file" "$file"; die "需要 curl 或 wget 才能下载 SHA256SUMS 做校验"
    fi
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
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now nyra-scheduler.service 2>/dev/null || true
    fi
    rm -f "$SERVICE_DST" "$BIN_DIR/nyra"
    rm -rf "$PREFIX"
    log "已卸载（~/.nyra 里的数据保留）。"
    exit 0
fi

ASSET="$(arch_name)"
mkdir -p "$PREFIX" "$BIN_DIR"
[ -d "${HOME}/.nyra" ] || mkdir -m 700 "${HOME}/.nyra"

if [ -n "$FROM_FILE" ]; then
    [ -f "$FROM_FILE" ] || die "找不到本地二进制：$FROM_FILE（先跑 ./scripts/build-binaries.sh）"
    log "从本地文件安装：$FROM_FILE（本地文件，不联网、不做哈希校验）"
    cp "$FROM_FILE" "$PREFIX/nyra"
else
    if [ "$VERSION" = "latest" ]; then
        URL="https://github.com/$REPO/releases/latest/download/$ASSET"
    else
        URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
    fi
    check_released "$URL"
    log "下载 $URL"
    TMP_BIN="$PREFIX/nyra.tmp.$$"
    rm -f "$TMP_BIN"
    download "$URL" "$TMP_BIN"
    verify_asset "$ASSET" "$TMP_BIN"
    mv "$TMP_BIN" "$PREFIX/nyra"
fi
chmod 755 "$PREFIX/nyra"
ln -sf "$PREFIX/nyra" "$BIN_DIR/nyra"
log "已装到 $PREFIX/nyra，链接在 $BIN_DIR/nyra"

if [ "$WITH_SYSTEMD" -eq 1 ]; then
    if [ -f "$SERVICE_SRC" ] && command -v systemctl >/dev/null 2>&1; then
        mkdir -p "$(dirname "$SERVICE_DST")"
        cp "$SERVICE_SRC" "$SERVICE_DST"
        # 服务文件已是 Node 版（调二进制）；这里只把路径换成真实安装位置。
        sed -i "s|^ExecStart=.*|ExecStart=$BIN_DIR/nyra schedule daemon|" "$SERVICE_DST"
        sed -i "s|^WorkingDirectory=.*|WorkingDirectory=%h|" "$SERVICE_DST"
        # 只装文件、不启动：用户确认后再跑 systemctl --user enable --now。
        log "服务文件已装到 $SERVICE_DST（未启动）；启用请跑：systemctl --user enable --now nyra-scheduler.service"
    else
        log "警告：没装 systemd 服务（缺文件或缺 systemctl），只装了二进制。"
    fi
fi

log "自检："
"$BIN_DIR/nyra" --version
log "装好了。下一步：nyra setup（首次启动向导，三步到第一个任务），或 nyra doctor 自检。"
log "提示：~/.local/bin 需要在 PATH 里；不在的话把 export PATH=\"\$HOME/.local/bin:\$PATH\" 加进 ~/.bashrc。"
