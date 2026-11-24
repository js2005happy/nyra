#!/usr/bin/env bash
# Nyra Linux 打包脚本（Node 二进制版）：产出发布 tarball 与 Debian 包。
#
# 产出（默认写到 ./dist/，可用 --out-dir 改）：
#   nyra-node-<版本>.tar.gz      解压即用的发布归档（顶层目录 nyra-node-<版本>/，含 nyra 二进制）
#   nyra-node_<版本>_amd64.deb   Debian 包，装到 /usr/share/nyra，启动器 /usr/bin/nyra
#
# 规则：
#   - 版本号只从 package.json 的 version 读，不手写两份；
#   - 只打包白名单文件：已编好的 Linux 二进制 + README.md、GUIDE.md、
#     CHANGELOG.md、LICENSE 与 docs/linux-*.md；.git、.venv、dist/ 里
#     的其他产物、node_modules/ 绝不进包；
#   - 二进制来自 --binary（默认 ./dist/nyra-linux-x64）；没编出来就报错，
#     不静默打包一个空包；
#   - deb 只声明 Depends: libc6（动态链接的运行时依赖），不要求装 Python；
#     不写 maintainer 脚本：不碰用户 systemd、不动 ~/.nyra，装完由用户
#     自己按 docs/linux-packaging.md 启用服务；
#   - 只在 Linux 上跑；没有 dpkg-deb 时只产出 tarball 并警告（--no-deb
#     亦然），不报错中断。
#   - 旧的 Python 版打包脚本是 scripts/build_package.sh（仍可用，产出
#     nyra-<版本>.tar.gz / nyra_<版本>_all.deb，Depends python3）。
#
# 用法：
#   ./scripts/build-package-node.sh [--binary PATH] [--arch amd64|arm64]
#                                   [--out-dir DIR] [--no-deb] [--help]
#   默认 --binary 为 ./dist/nyra-linux-x64，--arch 为 amd64。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
BUILD_DEB=1
BINARY="$ROOT/dist/nyra-linux-x64"
ARCH="amd64"

usage() {
    cat <<'EOF'
用法：scripts/build-package-node.sh [--binary PATH] [--arch amd64|arm64] [--out-dir DIR] [--no-deb] [--help]

  --binary PATH   已编好的 Linux 二进制（默认 ./dist/nyra-linux-x64）
  --arch ARCH     目标架构：amd64（默认）或 arm64
  --out-dir DIR   产出目录（默认 ./dist）
  --no-deb        只产出 tarball，不产出 .deb
  --help          显示本帮助
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --binary) [ $# -ge 2 ] || { echo "错误：--binary 需要一个路径参数。" >&2; exit 2; }; BINARY="$2"; shift 2 ;;
        --arch) [ $# -ge 2 ] || { echo "错误：--arch 需要一个参数。" >&2; exit 2; }; ARCH="$2"; shift 2 ;;
        --out-dir) [ $# -ge 2 ] || { echo "错误：--out-dir 需要一个目录参数。" >&2; exit 2; }; OUT_DIR="$2"; shift 2 ;;
        --no-deb) BUILD_DEB=0; shift ;;
        --help) usage; exit 0 ;;
        *) echo "错误：未知选项 $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$ARCH" in
    amd64|arm64) ;;
    *) echo "错误：--arch 只支持 amd64 或 arm64。" >&2; exit 2 ;;
esac

[ -f "$BINARY" ] || { echo "错误：找不到二进制 $BINARY（先跑 ./scripts/build-binaries.sh）。" >&2; exit 1; }
[ -x "$BINARY" ] || { echo "错误：$BINARY 没有执行权限。" >&2; exit 1; }

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
[ -n "$VERSION" ] || { echo "错误：读不到 package.json 里的 version。" >&2; exit 1; }

mkdir -p "$OUT_DIR"
#  staging 目录放 OUT_DIR 下面，不放 /tmp：二进制 109MB，mktemp 默认的 /tmp
# 在不少机器上是小 tmpfs（本机 512M），staging 复制一遍就可能 ENOSPC；
# OUT_DIR 与最终产物同一文件系统，空间一定够。trap 保证退出时清掉。
STAGE="$(mktemp -d "$OUT_DIR/.nyra-pkg-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

TOP="nyra-node-$VERSION"
mkdir -p "$STAGE/$TOP"
cp "$BINARY" "$STAGE/$TOP/nyra"
chmod 755 "$STAGE/$TOP/nyra"
for f in README.md GUIDE.md CHANGELOG.md LICENSE; do
    [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/$TOP/"
done
mkdir -p "$STAGE/$TOP/docs"
cp "$ROOT"/docs/linux-*.md "$STAGE/$TOP/docs/" 2>/dev/null || true

TARBALL="$OUT_DIR/nyra-node-$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" "$TOP"
echo "tarball：$TARBALL（$(du -h "$TARBALL" | cut -f1)）"

if [ "$BUILD_DEB" -eq 1 ] && command -v dpkg-deb >/dev/null 2>&1; then
    DEBROOT="$(mktemp -d "$OUT_DIR/.nyra-deb-root.XXXXXX")"
    trap 'rm -rf "$STAGE" "$DEBROOT"' EXIT
    mkdir -p "$DEBROOT/usr/share/nyra" "$DEBROOT/usr/bin" "$DEBROOT/DEBIAN"
    # mktemp 建的目录是 0700，dpkg-deb 要求 DEBIAN 目录权限在 0755~0775 之间。
    chmod 755 "$DEBROOT" "$DEBROOT/DEBIAN" "$DEBROOT/usr" "$DEBROOT/usr/share" "$DEBROOT/usr/share/nyra" "$DEBROOT/usr/bin"
    cp "$BINARY" "$DEBROOT/usr/share/nyra/nyra"
    chmod 755 "$DEBROOT/usr/share/nyra/nyra"
    ln -sf /usr/share/nyra/nyra "$DEBROOT/usr/bin/nyra"
    cat > "$DEBROOT/DEBIAN/control" <<EOF
Package: nyra-node
Version: $VERSION
Architecture: $ARCH
Maintainer: Nyra <nyra@example.invalid>
Description: Nyra — 跑在你电脑上的开源 AI Agent（Node 单文件二进制）
Depends: libc6
Section: utils
Priority: optional
EOF
    DEB="$OUT_DIR/nyra-node_${VERSION}_${ARCH}.deb"
    dpkg-deb --build "$DEBROOT" "$DEB" >/dev/null
    echo "deb：$DEB（$(du -h "$DEB" | cut -f1)）"
elif [ "$BUILD_DEB" -eq 1 ]; then
    echo "警告：找不到 dpkg-deb，只产出了 tarball（可用 --no-deb 消掉这条警告）。"
fi
echo "完成。安装：解压 tarball 后跑里面的 nyra，或 sudo dpkg -i <deb>。"
