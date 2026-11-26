#!/usr/bin/env bash
# 给 Capacitor 生成的 android/app/build.gradle 加上正式签名配置（release 构建）。
# 只在 CI 有签名密钥时调用；密钥文件路径与密码全走环境变量，不写进仓库、不打印。
#   NYRA_KEYSTORE_PATH      keystore 文件（PKCS12）
#   NYRA_KEYSTORE_PASSWORD  keystore 密码
#   NYRA_KEY_ALIAS          别名（nyra）
#   NYRA_KEY_PASSWORD       私钥密码（PKCS12 与 keystore 密码相同，可不设）
set -euo pipefail
GRADLE="android/app/build.gradle"
[ -f "$GRADLE" ] || { echo "找不到 $GRADLE（先 cap add android）" >&2; exit 1; }
grep -q "nyraRelease" "$GRADLE" && { echo "已打过签名补丁"; exit 0; }
cat >> "$GRADLE" <<'GRADLE'

// Nyra：正式签名（mobile/scripts/patch-android-signing.sh 追加；值来自 CI 环境变量）
android {
    signingConfigs {
        nyraRelease {
            storeFile file(System.getenv("NYRA_KEYSTORE_PATH"))
            storePassword System.getenv("NYRA_KEYSTORE_PASSWORD")
            keyAlias System.getenv("NYRA_KEY_ALIAS")
            keyPassword(System.getenv("NYRA_KEY_PASSWORD") ?: System.getenv("NYRA_KEYSTORE_PASSWORD"))
            storeType "pkcs12"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.nyraRelease
        }
    }
}
GRADLE
echo "已追加正式签名配置"
