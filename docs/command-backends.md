# 命令后端可换（G-P1-39）

命令跑在哪，由后端决定。默认永远是本机（local），换后端须机主显式操作。

## 后端一览

| 后端 | 种类 | 状态 |
|---|---|---|
| `local`（默认） | 本机 | 可用：宿主机直接跑，工具级隔离 + 沙箱（bwrap/Seatbelt/Job Object）照常 |
| `docker` | 本机 | 可用：本机 `docker run` 起容器跑命令（工作目录 bind 进容器，默认断网） |
| `ssh` | 远端 | 可用：`ssh` 到指定主机上跑命令（须先配 host，BatchMode，不交互输密码） |
| `e2b` | 云端 | 一半：控制面（list/create/kill）已接；沙箱内跑命令须 SDK，未接线 |
| `modal` / `daytona` / `vercel_sandbox` | 云端 | 未接线：等云端商业决策后再接 |

插件可注册更多后端（`registerCommandBackend`，进程内注册表，重名报错）。

## 切换后端

```bash
nyra backend list              # 全部后端 + 当前后端 + 可用性
nyra backend use docker        # 切换当前后端（选未配置/不可用的须加 --yes）
nyra backend status [id]       # 各后端可用性
nyra --backend docker "跑个测试"  # 单次换后端，不改配置
```

优先级：`--backend` > `NYRA_COMMAND_BACKEND` 环境变量 > 配置文件 `active`。
网关/守护进程下次起任务时读最新配置，不用重启。

## Docker 后端

```bash
nyra backend docker [--image <镜像>] [--extra-args <a,b>]   # 看 / 改配置
```

- 默认镜像 `debian:bookworm-slim`，可改（须是本机已拉取或能拉取的镜像）。
- 工作目录 bind 进容器（同一路径），`--network none` 默认断网（放开网络走
  `--sandbox-allow-net` 的同款开关，即 `ctx.sandbox.allowNet`）。
- `read-only` 模式下工作目录以只读方式 bind。
- 本机没装 docker 或 daemon 未响应时，`status` 报 unavailable，执行时直接
  报错，不静默回落本机。

## SSH 后端

```bash
nyra backend ssh [--host <user@host>] [--port <端口>] [--key-file <路径>] [--remote-workdir <目录>] [--clear-host]
```

- 目标只认 `user@host`（不含空格、不以 `-` 开头），`--host` 写错直接拒绝。
- `ssh` 用 `BatchMode=yes`（不交互问密码）、`StrictHostKeyChecking=accept-new`、
  `ConnectTimeout=10`；远端命令整段当一个参数传，单引号转义后由远端 `sh -c` 跑。
- 配了 `remote_workdir` 时先 `cd` 过去再跑；没配时在远端家目录跑。
- `status` 只认配置（host 配没配、密钥文件在不在），不拨号探测。
- 密钥文件只记路径，不记内容；没配 `--key-file` 时走 ssh 默认（agent / `~/.ssh`）。

## E2B 后端

```bash
nyra backend e2b list
nyra backend e2b create [--template <模板>] [--timeout <秒>]
nyra backend e2b get <沙箱 id>
nyra backend e2b kill <沙箱 id>
```

- 凭据只读环境变量 `E2B_API_KEY`，绝不写进配置文件；没配时控制面直接报未配置。
- 控制面走 `https://api.e2b.dev` 的 REST（`GET /sandboxes`、`POST /sandboxes`、
  `GET /sandboxes/:id`、`DELETE /sandboxes/:id`），重定向直接拒绝。
- `create` 会在云端建一个沙箱（按 E2B 账单计费），须机主显式敲命令。
- 模板/超时默认 `base` / 1800 秒，配置在 `command-backends.json` 的 `e2b` 一节；
  沙箱 id 为空时 `config.json` 的 `e2b_sandbox_id` 作回退。
- **沙箱内跑命令未接线**：控制面 REST 没有跑命令的接口，跑命令要走沙箱里的
  envd agent（gRPC，SDK 负责）；`--sandbox e2b` 或 `--backend e2b` 跑命令时
  直接报错，不回落本机。接线前置条件见 `docs/sandbox.md` 的 e2b 一节。

## 云端后端（modal / daytona / vercel_sandbox）

只注册 + 报未配置，不接真 API、不花钱。接线等云端商业决策（谁出云端算力、
怎么收费）拍板后再做，与缺口 14 云端接力同一批。

## 配置文件

`~/.nyra/command-backends.json`（0600 原子写，符号链接拒绝，损坏先备份再回默认）：

```json
{
  "active": "local",
  "docker": { "image": "debian:bookworm-slim", "extra_args": [] },
  "ssh": { "host": null, "port": 22, "key_file": null, "remote_workdir": null },
  "e2b": { "template": "base", "timeout": 1800, "sandbox_id": null }
}
```

## 安全口径

- 后端分发在审批之后、执行之前：危险命令黑名单与审批门先过，后端只决定
  “命令在哪跑”，不绕过任何一道门。
- 未配置/不可用/未接线的后端执行时直接报错，绝不静默回落本机。
- 后端切换是整机执行策略：子 agent 继承父级的后端；网关起的任务同样走当前后端。
- `--sandbox` 仍管 MCP 服务器等本机沙箱面；shell 执行时后端赢过 `--sandbox`
  （命令在 docker/远端跑时，本机沙箱那一轴不再适用）。

## 诚实边界

- Docker 后端只在注入 runner（记录 argv、回 canned 输出）与 argv 单测里验过，
  没在本机真 docker 上跑过（本机没装 docker daemon）。
- SSH 后端只在注入 runner 与 argv 单测里验过，没对真远端主机跑过。
- E2B 控制面只在注入 fetch（canned 响应）里验过，没拿真 Key 调过真 API；
  沙箱内跑命令没接线（须 SDK）。
- Windows/macOS 真机未验证。
