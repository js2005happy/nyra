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

REPO="${NYRA_REPO:-js2005happy/nyra}"
TAG="${1:-}"
WORKDIR="$(mktemp -d)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少依赖：$1" >&2; exit 1; }; }
need cosign

if [[ -n "$TAG" ]]; then
  need gh
  echo "==> 下载 $REPO 的 Release $TAG 到 $WORKDIR"
  gh release download "$TAG" --repo "$REPO" --dir "$WORKDIR" --clobber
  cd "$WORKDIR"
else
  echo "==> 使用当前目录：$PWD"
fi

[[ -s SHA256SUMS ]] || { echo "没有 SHA256SUMS：当前目录里没有可用的哈希清单（文件不存在或是空的），无法校验；该 Release 可能没有附带 SHA256SUMS" >&2; exit 1; }

# 1) 验证签名本身（keyless：校验签发身份 = 本仓库的 release-sign.yml）
echo "==> 验证 SHA256SUMS 的 sigstore 签名"
if [[ -f SHA256SUMS.bundle ]]; then
  cosign verify-blob SHA256SUMS.bundle \
    --certificate-identity-regexp "^https://github\.com/${REPO}/\.github/workflows/release-sign\.yml@refs/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    SHA256SUMS
elif [[ -f SHA256SUMS.sig && -f SHA256SUMS.pem ]]; then
  cosign verify-blob \
    --signature SHA256SUMS.sig \
    --certificate SHA256SUMS.pem \
    --certificate-identity-regexp "^https://github\.com/${REPO}/\.github/workflows/release-sign\.yml@refs/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    SHA256SUMS
else
  echo "找不到 SHA256SUMS.bundle 或 .sig/.pem，无法验证" >&2
  exit 1
fi

# 2) 校验产物哈希
echo "==> 校验产物哈希"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi

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
