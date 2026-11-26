# Nyra 服务端容器（O4：一键自托管部署，单容器优先）。
#
# 只做一件事：跑同一份 `bun src/cli.ts ui`（网关 + 网页界面），不改单文件
# 二进制形态。数据全部留在 bind mount 的目录里（NYRA_HOME），镜像本身不含任何账号、
# 密钥、会话或模型 Key。构建时只装依赖（当前运行时依赖为空，装的是空集；
# 今后加依赖也不用改 Dockerfile）。
FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production NYRA_HOME=/home/nyra/.nyra
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN adduser --disabled-password --gecos "" nyra \
  && mkdir -p /home/nyra/.nyra \
  && chown -R nyra:nyra /app /home/nyra
USER nyra
EXPOSE 8765
# 健康检查走已有的 GET /api/health（无鉴权，见 src/gateway.ts）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8765/api/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["bun", "src/cli.ts", "ui", "--host", "0.0.0.0", "--port", "8765"]
