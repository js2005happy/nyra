# 一键自托管部署（O4）

一个命令把 Nyra 服务端跑起来：单机 Docker Compose 优先，Helm 单机版备选。
先做单容器，不做托管更新；镜像签名复用 P0-1 的 cosign keyless + SLSA 链路
（发版时 Release 带 SHA256SUMS 与签名文件，见 docs/installers.md）。

## 一键部署（Docker Compose）

前置：Docker（Desktop 或 Engine + compose 插件）与 curl。

```sh
bash scripts/deploy.sh up
# 改端口：bash scripts/deploy.sh up --port 8080
```

脚本做的事：构建镜像 → `docker compose up -d` → 等 `GET /api/health`
通过（最多 120 秒）→ 打印地址 → 记一笔部署级审计
（`nyra governance deploy`，O2，见 `docs/governance.md`）。

- 地址：`http://127.0.0.1:8765`（默认端口 8765，可用 `NYRA_PORT` 改）。
- 访问 token 在容器日志里：`docker compose logs nyra | grep -i http`——
  链接里含本次启动的访问 token，不要分享。
- 数据：宿主的 `$NYRA_HOME`（默认 `~/.nyra`）bind mount 进容器
  `/home/nyra/.nyra`；删容器不丢数据。容器按调用者的 UID/GID 跑，
  写出来的文件属主与宿主一致。
- 镜像：`Dockerfile`（oven/bun 基础镜像）跑同一份 `bun src/cli.ts ui`
  （网关 + 网页界面），不改单文件二进制形态；健康检查走已有的
  `GET /api/health`（无鉴权）。
- 环境变量：`NYRA_PORT`（默认 8765）、`NYRA_HOME`（默认 `~/.nyra`）、
  `NYRA_BACKUP_DIR`（默认 `~/.nyra-backups`）。

## 升级与回滚

```sh
bash scripts/deploy.sh upgrade            # 先备份 $NYRA_HOME，再拉新版、重建、等健康
bash scripts/deploy.sh rollback <备份目录> # 停容器、恢复备份、重起、等健康
bash scripts/deploy.sh status             # 容器状态 + 健康检查
bash scripts/deploy.sh down               # 停容器（数据保留在 $NYRA_HOME 里）
```

- 升级前备份在 `$NYRA_BACKUP_DIR/nyra-<时间戳>/`；升级失败时脚本直接告诉你
  用哪条 rollback 命令恢复，不要自己手动拷。
- 升级时仓库须是 git 检出（`git pull --ff-only` 拉新版）；不是 git 检出
  （比如从压缩包解出来的）时脚本跳过拉取、提醒你先自己更新代码再跑 `up`。
- 回滚恢复的是备份时刻的整份数据（含审计日志）：升级那笔部署审计会随回滚
  消失，备查靠回滚那笔审计（里面写了备份目录）+ 备份目录本身。

## Helm 单机版

```sh
helm install nyra ./helm/nyra
# 真用时先把 persistence.enabled 打开（默认 emptyDir，随 Pod 删而丢，只适合试跑）：
helm install nyra ./helm/nyra --set persistence.enabled=true
kubectl port-forward svc/nyra 8765:8765
```

- 单副本 + 本地卷（PVC 或 emptyDir），不做多副本与托管更新。
- 探针走 `GET /api/health`（liveness + readiness）。

## 从单机到集群

现在不要直接上多副本：网关是单进程有状态的（会话、定时任务、配对码都在
本机文件里），多副本要先解决共享状态与选主。真要扩时按这个顺序：
单机 Compose → 单 Pod Helm（上面）→ 共享存储 + 单副本 → 再谈多副本。

## 已知局限

- 没跑过真 Docker：本机没有 Docker 守护进程，Dockerfile 与 compose 只做了
  语法与配置校验（`bash -n`、YAML 解析、helm 模板展开、deploy.sh 用 stub
  docker + 假 health 服务实跑全流程），镜像构建与真容器启动须在有 Docker
  的机器上再验一次。
- 不做托管更新：没有 watchtower / 自动拉新镜像，升级靠人跑 `upgrade`。
- 不做 TLS：默认只监听本机回环（compose 映射到宿主 8765）；要从公网访问时，
  自己在前面放反向代理 + TLS，不要直接把 8765 暴露到公网。
- 首次运行仍走网页里的首次运行流程（建账号、接模型），容器不预置任何账号与 Key。
