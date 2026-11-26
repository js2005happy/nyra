#!/usr/bin/env bash
# Nyra 一键自托管部署（O4）：单机 Docker Compose 优先，Helm 备选。
#
#   bash scripts/deploy.sh up [--port 8765] [--note "说明"]
#   bash scripts/deploy.sh upgrade [--note "说明"]   # 先备份数据再拉新版重建
#   bash scripts/deploy.sh rollback <备份目录>       # 恢复备份并重起
#   bash scripts/deploy.sh down                     # 停容器，数据卷保留
#   bash scripts/deploy.sh status                   # 容器状态 + 健康检查
#
# 数据（账号、会话、记忆、审计、密钥库）全部在 $NYRA_HOME 里（默认 ~/.nyra），
# compose 把它挂成命名卷 nyra-data；删容器不丢数据。升级先备份、回滚恢复备份。
# 部署/升级/回滚成功后记一笔部署级审计（nyra governance deploy，O2），
# 记不上也不拦住部署本身（只打印提醒）。镜像签名复用 P0-1 的 cosign keyless
# + SLSA 链路（见 docs/deploy.md），本脚本不做签名验证——跑之前先自己核对
# 镜像来源。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${NYRA_PORT:-8765}"
HOME_DIR="${NYRA_HOME:-$HOME/.nyra}"
BACKUP_ROOT="${NYRA_BACKUP_DIR:-$HOME/.nyra-backups}"
COMPOSE_FILE="$ROOT/docker-compose.yml"
# 让 compose 里的 ${NYRA_HOME} 与本脚本备份/回滚的是同一份目录；容器按调用者
# 的 UID/GID 跑，写出来的文件属主与宿主一致（UID 是 bash 只读变量，不能直接改）。
export NYRA_HOME="$HOME_DIR"
export NYRA_UID="${NYRA_UID:-$(id -u)}"
export NYRA_GID="${NYRA_GID:-$(id -g)}"

usage() {
  cat <<'EOF'
用法：bash scripts/deploy.sh <up|upgrade|rollback|down|status> [选项]
  up [--port 8765] [--note "说明"]   构建并启动（等健康检查通过后打印地址）
  upgrade [--note "说明"]            先备份 $NYRA_HOME，再拉新版、重建、等健康
  rollback <备份目录>                停容器、恢复备份、重起、等健康
  down                               停容器（数据卷保留）
  status                             容器状态 + 健康检查
环境变量：NYRA_PORT（默认 8765）、NYRA_HOME（默认 ~/.nyra）、
  NYRA_BACKUP_DIR（默认 ~/.nyra-backups）。详见 docs/deploy.md。
EOF
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "错误：找不到 $1（$2）" >&2
    exit 1
  fi
}

# docker compose：优先 `docker compose`（v2 插件），没有再试 `docker-compose`。
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    echo "错误：找不到 docker compose（装 Docker Desktop 或 docker compose 插件）" >&2
    exit 1
  fi
}

wait_healthy() {
  local tries=0
  while [ "$tries" -lt 60 ]; do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

# 部署级审计（O2）：记不上不拦部署。note 里不要写密钥。
record_audit() {
  local kind="$1" note="$2"
  if command -v bun >/dev/null 2>&1 && [ -f "$ROOT/src/cli.ts" ]; then
    if ! bun "$ROOT/src/cli.ts" governance deploy "$note" --kind "$kind" >/dev/null 2>&1; then
      echo "提醒：部署审计没记上（nyra governance deploy 失败），部署本身已完成。"
    fi
  fi
}

backup_home() {
  local stamp backup
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="$BACKUP_ROOT/nyra-$stamp"
  mkdir -p "$BACKUP_ROOT"
  if [ -d "$HOME_DIR" ]; then
    cp -r "$HOME_DIR" "$backup"
    echo "已备份 $HOME_DIR → $backup" >&2
  else
    mkdir -p "$backup"
    echo "提醒：$HOME_DIR 还不存在，建了空备份目录 $backup（首次部署正常）。" >&2
  fi
  echo "$backup"
}

cmd_up() {
  local note="自托管部署（docker compose）"
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      *) echo "错误：up 不认 $1" >&2; usage; exit 2 ;;
    esac
  done
  need_cmd docker "https://docs.docker.com/get-docker/"
  need_cmd curl "健康检查用 curl"
  export NYRA_PORT="$PORT"
  compose up -d --build
  if wait_healthy; then
    echo "Nyra 已起来：http://127.0.0.1:${PORT}"
    echo "访问 token 在容器日志里：docker compose -f $COMPOSE_FILE logs nyra | grep -i http"
    echo "（链接里含本次启动的访问 token，不要分享。）"
    record_audit deploy "$note"
  else
    echo "错误：等了 120 秒健康检查还没通过，看日志：docker compose -f $COMPOSE_FILE logs nyra" >&2
    exit 1
  fi
}

cmd_upgrade() {
  local note="自托管升级（docker compose）"
  while [ $# -gt 0 ]; do
    case "$1" in
      --note) note="$2"; shift 2 ;;
      *) echo "错误：upgrade 不认 $1" >&2; usage; exit 2 ;;
    esac
  done
  need_cmd docker "https://docs.docker.com/get-docker/"
  need_cmd curl "健康检查用 curl"
  local backup
  backup="$(backup_home)"
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "拉新版…"
    git -C "$ROOT" pull --ff-only || { echo "错误：git pull 失败（有冲突或没网），备份在 $backup，先处理再重跑。" >&2; exit 1; }
  else
    echo "提醒：$ROOT 不是 git 检出，跳过拉取——请先自己更新代码，再跑 up。"
  fi
  export NYRA_PORT="$PORT"
  compose up -d --build
  if wait_healthy; then
    echo "升级完成：http://127.0.0.1:${PORT}（备份在 $backup）"
    record_audit upgrade "$note（备份：$backup）"
  else
    echo "错误：升级后健康检查没通过，备份在 $backup，用 rollback 恢复：bash scripts/deploy.sh rollback $backup" >&2
    exit 1
  fi
}

cmd_rollback() {
  local backup="${1:-}"
  if [ -z "$backup" ] || [ ! -d "$backup" ]; then
    echo "错误：rollback 须给一个已有的备份目录（看 $BACKUP_ROOT）" >&2
    exit 2
  fi
  need_cmd docker "https://docs.docker.com/get-docker/"
  need_cmd curl "健康检查用 curl"
  compose down
  rm -rf "$HOME_DIR"
  cp -r "$backup" "$HOME_DIR"
  echo "已恢复备份 $backup → $HOME_DIR"
  export NYRA_PORT="$PORT"
  compose up -d
  if wait_healthy; then
    echo "回滚完成：http://127.0.0.1:${PORT}"
    record_audit rollback "自托管回滚（备份：$backup）"
  else
    echo "错误：回滚后健康检查没通过，看日志：docker compose -f $COMPOSE_FILE logs nyra" >&2
    exit 1
  fi
}

cmd_down() {
  compose down
  echo "已停（数据在 $HOME_DIR 里，删容器不丢；彻底清掉数据须自己删 $HOME_DIR）"
}

cmd_status() {
  compose ps
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "健康：http://127.0.0.1:${PORT}/api/health 通"
  else
    echo "不健康：http://127.0.0.1:${PORT}/api/health 不通（容器可能还没起来）"
    exit 1
  fi
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    up) cmd_up "$@" ;;
    upgrade) cmd_upgrade "$@" ;;
    rollback) cmd_rollback "$@" ;;
    down) cmd_down "$@" ;;
    status) cmd_status "$@" ;;
    "" | "-h" | "--help" | "help") usage ;;
    *) echo "错误：不认 $cmd" >&2; usage; exit 2 ;;
  esac
}

main "$@"
