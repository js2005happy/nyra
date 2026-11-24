# scripts/release-verify-lib.sh — 安装与 verify-release.sh 共用的发布校验。
#
# 被 source，不要直接执行。不依赖 bash 4 的关联数组（macOS 自带 bash 3.2）。
# 网络只出现在 nyra_resolve_release_tag 的 latest 分支；测试用
# NYRA_LATEST_JSON_FILE 注入本地 JSON，不访问 GitHub。
#
# 校验顺序：先确认 SHA256SUMS 的 sigstore 签名（发布者），再按清单核对
# 产物哈希（完整性）。哈希对上只说明文件和清单一致，不能代替签名。

nyra_normalize_version() {
  local v="$1"
  v="$(printf '%s' "$v" | tr -d '[:space:]')"
  if [ -z "$v" ] || [ "$v" = "latest" ]; then
    printf '%s\n' "latest"
    return 0
  fi
  case "$v" in
    v*) printf '%s\n' "$v" ;;
    *) printf 'v%s\n' "$v" ;;
  esac
}

# 从 GitHub release JSON 里取出唯一的 tag_name。不是 v 开头就失败。
nyra_parse_latest_tag_json() {
  local json tag
  json="$(cat)"
  tag="$(printf '%s\n' "$json" | awk -F'"' '/"tag_name"/ { print $4; exit }')"
  case "$tag" in
    v*) printf '%s\n' "$tag" ;;
    *)
      printf '%s\n' "解析 latest 失败：响应里没有以 v 开头的 tag_name" >&2
      return 1
      ;;
  esac
}

# 显式版本原样归一；latest 只解析一次，之后调用方必须用返回的 tag。
nyra_resolve_release_tag() {
  local version tag json url
  version="$(nyra_normalize_version "$1")"
  if [ "$version" != "latest" ]; then
    printf '%s\n' "$version"
    return 0
  fi
  if [ -n "${NYRA_LATEST_JSON_FILE:-}" ]; then
    json="$(cat "$NYRA_LATEST_JSON_FILE")" || {
      printf '%s\n' "解析 latest 失败：读不到 $NYRA_LATEST_JSON_FILE" >&2
      return 1
    }
  else
    url="https://api.github.com/repos/${NYRA_REPO:-js2005happy/nyra}/releases/latest"
    if command -v curl >/dev/null 2>&1; then
      json="$(curl -fsSL -H "Accept: application/vnd.github+json" "$url")" || {
        printf '%s\n' "解析 latest 失败：无法读取 $url" >&2
        return 1
      }
    elif command -v wget >/dev/null 2>&1; then
      json="$(wget -qO- --header="Accept: application/vnd.github+json" "$url")" || {
        printf '%s\n' "解析 latest 失败：无法读取 $url" >&2
        return 1
      }
    else
      printf '%s\n' "解析 latest 需要 curl 或 wget" >&2
      return 1
    fi
  fi
  printf '%s\n' "$json" | nyra_parse_latest_tag_json
}

# 只接受已经解析好的 v* tag。拒绝 latest，避免产物和清单打到不同的 Release。
nyra_download_url() {
  local repo="$1" tag="$2" name="$3"
  case "$tag" in
    v*) ;;
    *)
      printf '%s\n' "拒绝：版本必须是已解析的 tag（以 v 开头），不能是 latest：$tag" >&2
      return 1
      ;;
  esac
  case "$name" in
    *[!A-Za-z0-9._+-]*|""|.*)
      printf '%s\n' "拒绝：产物名非法：$name" >&2
      return 1
      ;;
  esac
  printf 'https://github.com/%s/releases/download/%s/%s\n' "$repo" "$tag" "$name"
}

# 与 release-sign.yml 里 cosign verify-blob 的身份正则一致。
nyra_publisher_identity_regexp() {
  local repo="${1:-${NYRA_REPO:-js2005happy/nyra}}"
  printf '%s\n' "^https://github\.com/${repo}/\.github/workflows/release-sign\.yml@refs/"
}

# 严格读完 SHA256SUMS。空、坏行、重复名、带路径的名字都失败。
# 成功时把「文件名<TAB>小写哈希」打到 stdout。
nyra_normalize_sums() {
  local sums="$1" line hash name seen
  if [ ! -s "$sums" ]; then
    printf '%s\n' "没有 SHA256SUMS：哈希清单不存在或是空的" >&2
    return 1
  fi
  seen="$(mktemp)" || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ""|\#*) continue ;;
    esac
    if ! printf '%s\n' "$line" | grep -Eq '^[0-9a-fA-F]{64}[[:space:]]+\*?[^[:space:]/\\]+[[:space:]]*$'; then
      rm -f "$seen"
      printf '%s\n' "SHA256SUMS 格式不对：${line}" >&2
      return 1
    fi
    hash="$(printf '%s\n' "$line" | awk '{ print tolower($1) }')"
    name="$(printf '%s\n' "$line" | awk '{ n=$2; sub(/^\*/, "", n); print n }')"
    case "$name" in
      *..*)
        rm -f "$seen"
        printf '%s\n' "SHA256SUMS 文件名非法：$name" >&2
        return 1
        ;;
    esac
    if grep -Fxq "$name" "$seen"; then
      rm -f "$seen"
      printf '%s\n' "SHA256SUMS 里 $name 出现了两次" >&2
      return 1
    fi
    printf '%s\n' "$name" >> "$seen"
    printf '%s\t%s\n' "$name" "$hash"
  done < "$sums"
  rm -f "$seen"
}

nyra_expected_hash_for() {
  local sums="$1" asset="$2" norm name hash found
  norm="$(mktemp)" || return 1
  if ! nyra_normalize_sums "$sums" > "$norm"; then
    rm -f "$norm"
    return 1
  fi
  found=""
  while IFS=$'\t' read -r name hash; do
    [ -n "${name:-}" ] || continue
    if [ "$name" = "$asset" ]; then
      found="$hash"
    fi
  done < "$norm"
  rm -f "$norm"
  if [ -z "$found" ]; then
    printf '%s\n' "SHA256SUMS 里没有 $asset" >&2
    return 1
  fi
  printf '%s\n' "$found"
}

nyra_file_sha256() {
  local file="$1"
  if [ ! -f "$file" ]; then
    printf '%s\n' "找不到要校验的文件：$file" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print tolower($1) }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print tolower($1) }'
  else
    printf '%s\n' "需要 sha256sum 或 shasum 才能校验产物，拒绝继续" >&2
    return 1
  fi
}

# 发布者：cosign 验 SHA256SUMS。没有 cosign、没有签名材料、验签失败都拒绝。
# NYRA_COSIGN 可指向测试用的替身，不访问网络。
nyra_verify_sums_signature() {
  local dir="$1"
  local sums="$dir/SHA256SUMS"
  local cosign="${NYRA_COSIGN:-cosign}"
  local repo="${NYRA_REPO:-js2005happy/nyra}"
  local ident
  ident="$(nyra_publisher_identity_regexp "$repo")"
  if [ ! -x "$cosign" ] && ! command -v "$cosign" >/dev/null 2>&1; then
    printf '%s\n' "无法验证发布者：没有可用的 cosign。SHA256 对上只说明文件和清单一致，不能证明清单来自 ${repo} 的 release-sign 工作流。安装 cosign 后再试。" >&2
    return 1
  fi
  if [ -f "$dir/SHA256SUMS.bundle" ]; then
    "$cosign" verify-blob \
      --bundle "$dir/SHA256SUMS.bundle" \
      --certificate-identity-regexp "$ident" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$sums" || {
      printf '%s\n' "签名验证失败：SHA256SUMS 的 sigstore bundle 未通过。拒绝继续。" >&2
      return 1
    }
  elif [ -f "$dir/SHA256SUMS.sig" ] && [ -f "$dir/SHA256SUMS.pem" ]; then
    "$cosign" verify-blob \
      --signature "$dir/SHA256SUMS.sig" \
      --certificate "$dir/SHA256SUMS.pem" \
      --certificate-identity-regexp "$ident" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$sums" || {
      printf '%s\n' "签名验证失败：SHA256SUMS 的 sig/pem 未通过。拒绝继续。" >&2
      return 1
    }
  else
    printf '%s\n' "缺少签名材料：没有 SHA256SUMS.bundle，也没有成对的 SHA256SUMS.sig 与 SHA256SUMS.pem。哈希清单未被认证，拒绝继续。只核对哈希不能证明发布者。" >&2
    return 1
  fi
}

# 先验签，再严格解析清单，再比对产物。失败时不执行产物。
nyra_verify_asset_dir() {
  local dir="$1" asset="$2" file="$3"
  local expected actual
  if [ ! -s "$dir/SHA256SUMS" ]; then
    printf '%s\n' "没有 SHA256SUMS：哈希清单不存在或是空的，拒绝继续" >&2
    return 1
  fi
  nyra_verify_sums_signature "$dir" || return 1
  expected="$(nyra_expected_hash_for "$dir/SHA256SUMS" "$asset")" || return 1
  actual="$(nyra_file_sha256 "$file")" || return 1
  if [ "$actual" != "$expected" ]; then
    printf '%s\n' "哈希不匹配：$asset 的 sha256 与已验签的 SHA256SUMS 不符，拒绝继续（文件可能被篡改）。" >&2
    return 1
  fi
  return 0
}
