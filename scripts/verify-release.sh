#!/usr/bin/env bash
# 验证 Nyra 发布产物的签名与来源。
#
# 用法（在下载了 Release 附件的目录里执行）：
#   ./scripts/verify-release.sh                    # 校验当前目录的 SHA256SUMS + 所有产物
#   ./scripts/verify-release.sh v0.5.0             # 用 gh 自动下载该 Release 的产物后再校验
#
# fail-closed：没有 SHA256SUMS（文件不存在或是空的）时直接报
# “没有 SHA256SUMS”并退出码 1，不指向不存在的文件、不跳过校验；
# 清单里的文件缺失、哈希对不上，同样失败。没有网络 / 没有 gh 时也
# 直接失败并给出中文原因，不静默通过。
#
# 依赖：cosign ≥2.4（keyless 验证）、sha256sum、可选 gh。
# 安装 cosign：
#   macOS   brew install cosign
#   Linux   https://docs.sigstore.dev/cosign/system_config/installation/
#   Windows scoop install cosign   /   winget install sigstore.cosign

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-verify-lib.sh
. "$ROOT/release-verify-lib.sh"

REPO="${NYRA_REPO:-js2005happy/nyra}"
TAG="${1:-}"
WORKDIR="$(mktemp -d)"

need() {
  if [ -f "$1" ] || command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  echo "缺少依赖：$1" >&2
  exit 1
}
need "${NYRA_COSIGN:-cosign}"

if [[ -n "$TAG" ]]; then
  need gh
  # latest 只解析一次，随后整份 Release 都从那个不可变 tag 下载。
  RESOLVED="$(nyra_resolve_release_tag "$TAG")"
  echo "==> 下载 $REPO 的 Release $RESOLVED 到 $WORKDIR"
  gh release download "$RESOLVED" --repo "$REPO" --dir "$WORKDIR" --clobber
  cd "$WORKDIR"
else
  echo "==> 使用当前目录：$PWD"
fi

# 1) 签名（发布者）然后 2) 清单里每一个文件的哈希（完整性）。
# 哈希对上不能代替这一步签名。
echo "==> 验证 SHA256SUMS 的 sigstore 签名，并核对清单覆盖的产物"
if [[ ! -s SHA256SUMS ]]; then
  echo "没有 SHA256SUMS：当前目录里没有可用的哈希清单（文件不存在或是空的），无法校验；该 Release 可能没有附带 SHA256SUMS" >&2
  exit 1
fi
nyra_verify_sums_signature "$PWD"
NORM="$(mktemp)"
nyra_normalize_sums SHA256SUMS > "$NORM"
while IFS=$'\t' read -r name expected; do
  [ -n "${name:-}" ] || continue
  actual="$(nyra_file_sha256 "$PWD/$name")"
  if [[ "$actual" != "$expected" ]]; then
    echo "哈希不匹配：$name 的 sha256 与已验签的 SHA256SUMS 不符" >&2
    rm -f "$NORM"
    exit 1
  fi
  echo "  哈希通过：$name"
done < "$NORM"
rm -f "$NORM"

# 3) 校验 SLSA 来源证明（可选，需要 gh + 该产物有 .intoto.jsonl）
echo "==> 校验来源证明（若存在）"
for f in *; do
  [[ -f "$f.intoto.jsonl" ]] || continue
  base="${f%.intoto.jsonl}"
  [[ -f "$base" ]] || continue
  if gh attestation verify "$base" --repo "$REPO" >/dev/null 2>&1; then
    echo "  ✅ $base 的来源证明有效"
  else
    echo "  ⚠️  $base 的来源证明验证失败或无 attestation"
  fi
done

echo ""
echo "✅ 全部通过：产物来自 $REPO 的官方构建流程，且未被篡改。"
# 注意：不能写成 [[ -n "$TAG" ]] && echo … 作最后一行——TAG 为空时
# 整个脚本的退出码会变成 1，好 bundle 也报失败。显式 exit 0。
if [[ -n "$TAG" ]]; then echo "   工作目录保留在：$WORKDIR"; fi
exit 0
