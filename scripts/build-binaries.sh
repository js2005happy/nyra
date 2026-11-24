#!/usr/bin/env bash
# Nyra 单文件可执行构建脚本（Bun --compile，第 1 阶段）。
#
# 产出（默认写到 ./dist/，二进制不进 git，走 GitHub Releases 分发）：
#   nyra-linux-x64        Linux x86-64
#   nyra-linux-arm64      Linux arm64
#   nyra-windows-x64.exe  Windows x86-64（PE32+，首次构建会下载约 53MB 的 Windows 运行时）
#   nyra-macos-arm64      macOS arm64（Mach-O）
#   nyra-macos-x64        macOS x86-64（Mach-O）
#
# 用法：
#   ./scripts/build-binaries.sh [--out-dir DIR] [--only linux-x64|linux-arm64|windows-x64|macos-arm64|macos-x64] [--help]
#   默认全编 5 个；本机验证用 --only linux-x64。
#   要求：bun >= 1.4。Windows/macOS 产物只在本机验证过“能产出、格式正确”，
#   运行时行为待真机/CI 验证（第 0 阶段结论）；macOS 未签名——Gatekeeper
#   首次运行会拦，需用户右键“打开”或等后续公证流程，不要编造“已签名”。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
ONLY=""

usage() {
    sed -n '2,16p' "$0"
    cat <<'EOF'

选项：
  --out-dir DIR   产出目录（默认 ./dist）
  --only TARGET   只编一个：linux-x64 | linux-arm64 | windows-x64 | macos-arm64 | macos-x64
  --help          显示本帮助
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --out-dir) [ $# -ge 2 ] || { echo "错误：--out-dir 需要一个目录参数。" >&2; exit 2; }; OUT_DIR="$2"; shift 2 ;;
        --only) [ $# -ge 2 ] || { echo "错误：--only 需要一个目标参数。" >&2; exit 2; }; ONLY="$2"; shift 2 ;;
        --help) usage; exit 0 ;;
        *) echo "错误：未知选项 $1" >&2; usage >&2; exit 2 ;;
    esac
done

command -v bun >/dev/null 2>&1 || { echo "错误：找不到 bun，请先安装 Bun 1.4+（https://bun.sh）。" >&2; exit 1; }

# 不用 declare -A（关联数组要 bash 4+，macOS 自带的 /bin/bash 还是 3.2，
# 在 Mac 上跑会直接报语法错）；用 case 查表，bash 3.2 也能跑。
target_for() {
    case "$1" in
        linux-x64) echo "bun-linux-x64 nyra-linux-x64" ;;
        linux-arm64) echo "bun-linux-arm64 nyra-linux-arm64" ;;
        windows-x64) echo "bun-windows-x64 nyra-windows-x64.exe" ;;
        macos-arm64) echo "bun-darwin-arm64 nyra-macos-arm64" ;;
        macos-x64) echo "bun-darwin-x64 nyra-macos-x64" ;;
        *) return 1 ;;
    esac
}

mkdir -p "$OUT_DIR"

build_one() {
    local name="$1" target="$2" outfile="$3"
    echo "编 ${name}（${target}）..."
    bun build --compile --target="$target" --outfile "$OUT_DIR/$outfile" "$ROOT/src/cli.ts"
    echo "  -> ${OUT_DIR}/${outfile}（$(du -h "$OUT_DIR/$outfile" | cut -f1)）"
}

if [ -n "$ONLY" ]; then
    spec="$(target_for "$ONLY")" || { echo "错误：未知目标 $ONLY，可选：linux-x64 linux-arm64 windows-x64 macos-arm64 macos-x64" >&2; exit 2; }
    build_one "$ONLY" ${spec% *} ${spec#* }
else
    for name in linux-x64 linux-arm64 windows-x64 macos-arm64 macos-x64; do
        spec="$(target_for "$name")"
        build_one "$name" ${spec% *} ${spec#* }
    done
fi

echo "完成。产物在 $OUT_DIR/（二进制不进 git，走 GitHub Releases 分发）。"
