# Nyra 沙箱（隔离执行）

> 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI + Gemini CLI + OpenClaw）。
> 目标版本 0.5.1。沙箱与审批拆成两轴：沙箱定“物理上能做什么”，
> 审批定“何时问人”。两把旋钮互相独立，互不替代。

## 两轴模型

| 轴 | 管什么 | 在哪配 | 出处 |
|---|---|---|---|
| 沙箱 | 命令在物理上能做什么：能写哪、能不能联网 | `config.json` 的 `sandbox` / `sandbox_mode` / `sandbox_allow_net`，或 `--sandbox` / 环境变量 | `src/sandbox.ts` |
| 审批 | 何时停下问人：哪些工具调用要先经用户同意 | `--mode` 与审批流程（`src/tools.ts` 的 `checkApproval`） | 审批流程不变 |

举例：`workspace-write` 沙箱 + `auto` 审批模式下，工作区内的命令自动跑、
不用每次问；但命令想写工作区之外、想联网时，沙箱在系统调用层直接挡住
（写操作以 `EPERM` 失败），而不是靠模型“听话”不写。审批拦的是“要不要做”，
沙箱拦的是“能不能做”。

## 三档模式

`config.json` 的 `sandbox_mode`（或 `NYRA_SANDBOX_MODE`），默认 `workspace-write`。

| 模式 | 含义 |
|---|---|
| `workspace-write`（默认） | 工作区内可读写、跑命令；出工作区写与联网被挡住。常用路径不受影响。 |
| `read-only` | 工作目录也只读挂载；任何写、执行、联网都要审批（审批仍由审批轴决定）。 |
| `danger-full-access` | 无限制，不推荐。**该模式与沙箱互斥**：进 bwrap 会直接抛错拒绝；想用它必须显式走 `--sandbox local`（工具级），并自行承担风险。不要在日常使用、不要在群聊/渠道会话里用。 |

> ⚠️ 警告：`danger-full-access` 意味着模型命令不受任何 OS 级限制，
> 包括删除、格式化、联网外发等。只在你完全信任当前任务、且已看过命令原文时
> 才用，用完立即改回。Nyra 不会替你悄悄开这个模式。

## 后端：auto / local / bwrap / seatbelt / jobobject / e2b

`config.json` 的 `sandbox`（或 `NYRA_SANDBOX` 环境变量，或 `--sandbox`），
默认 `auto`。优先级：CLI flag > 环境变量 > `config.json`。

| 后端 | 行为 | 怎么选 |
|---|---|---|
| `auto`（默认） | Linux 且本机装了 bwrap → 用 bwrap（OS 沙箱）；macOS 且本机有 sandbox-exec → 用 Seatbelt（OS 沙箱）；否则回落到工具级隔离（现有工作区 containment + shell 黑名单），并在 doctor 与首次 shell 执行时给一次提示，说明这是工具级隔离、不是 OS 沙箱。**Windows 上 auto 仍不自动选 Job Object**（见下）。 | 默认就用它。对普通用户无感。 |
| `local` | 显式只要工具级，即使用户机器上有 bwrap 也不用。 | 想退出 OS 沙箱的开关（例如 bwrap 与某个工具不兼容时）。 |
| `bwrap` | 强制要求 bwrap：找不到 bwrap、或非 Linux 平台、或启动失败 → 直接报错退出（fail-closed），绝不静默降级裸奔。 | 想确保“没有 OS 沙箱就宁可不跑”时用。 |
| `seatbelt` | macOS `sandbox-exec`（SBPL profile）：强制要求 macOS 与 sandbox-exec，缺失即 fail-closed。 | macOS 上想用 OS 级沙箱时用（见“macOS：Seatbelt 后端”一节）。 |
| `jobobject` | Windows Job Object（PowerShell + kernel32）：强制要求 Windows 与 PowerShell，缺失即 fail-closed。进程级沙箱：随作业死、进程数上限；**文件靠工具级规则，网络在断网时靠工具级拦截**（见“Windows：Job Object 后端”一节）。 | Windows 上想用进程级沙箱时用。 |
| `e2b` | 命令后端（G-P1-39）：控制面已接（`nyra backend e2b list\|create\|kill`，须 `E2B_API_KEY`）；沙箱内跑命令须 SDK，未接线，执行时直接报错、不回落本机。 | 控制面用 `nyra backend e2b`；执行先用 local 或 docker。 |

默认行为对普通用户无感：工作目录内读写、跑命令都不受影响。
只有“出工作区写”与“联网”这两类在 bwrap 下会被挡住；挡住时报错会写清楚
是哪条规则拦的（例如 `EPERM` / 网络不可达），以及怎么放开（见下节）。

## e2b 接线评估（0.5.2 结论：暂不接线 → G-P1-39 更新：控制面已接，执行仍未接）

E2B 云沙箱原型已跑通（Muse 连接器 `custom.e2b`，项目
`angels-project-2c22`），G-P1-39 把控制面接进了 Nyra（注册表 + 配置 +
`nyra backend e2b list|create|kill`，凭据只读 `E2B_API_KEY` 环境变量）。
但沙箱内跑命令本批仍不做，原因如下：

1. **Node 侧没有执行路径**：连接器的 REST API 只有控制面
   （list/create/get/kill），没有“在沙箱里跑命令”的接口；沙箱内执行
   要走 E2B SDK（Python SDK 在 `~/workspace/angel/.venv` 里有，Node
   的 `@e2b/sdk` 不在 `bun.lock` / `node_modules` / `package.json` 里，
   引入即新增依赖与锁文件改动）。连接器文档亦明确写着“在沙箱里跑命令
   尚无 REST 接口，须 Python SDK”。
2. **凭据不在 Nyra 的配置里**：`E2B_API_KEY` 只存在 Muse 连接器的安全
   存储里，Nyra 没有对应的配置键与环境变量约定；接线要先定凭据落点
   （新增 `E2B_API_KEY` 环境变量/配置项），不能把 Key 抄进 Nyra 配置文件。
3. **生命周期与现有后端形态不匹配**：bwrap/Seatbelt/Job Object 都是一锤子
   形态（`runSandboxed(command)`：起进程、等退出、回结果）；E2B 沙箱是
   长驻的（建出来一直跑到超时或被杀，默认超时 1800 秒，免费档上限 1 小时）。
   套进一锤子形态要么每次命令都新建沙箱（冷启动 + 多次 API 往返，慢），
   要么新增一个有状态的长驻沙箱管理器（复用、续期、退出清理），都不是小改动。
4. **网络与账号依赖**：e2b 要联网 + 云账号（用量/限速），而现有后端全是
   本地进程；测试要求 mock-only，真实路径不拿真 Key 跑不通，等于发出去
   一个本地验不了的后端。

前置条件（以后要接执行时缺一不可）：① 引入 `@e2b/sdk`（或等价 Node 客户端）
并锁定版本；② 定 `E2B_API_KEY` 的落点与读取方式（G-P1-39 已定：只读环境
变量）；③ 定生命周期形态（每次命令新建 vs 长驻复用，含超时、续期、退出清理）；
④ 用真 Key 在有网环境跑通一次端到端（含断网/超时/沙箱超时的 fail-closed 行为）。
在那之前显式 `--sandbox e2b` 有 key 时解析成功、执行时直接报错（不回落本机），
没 key 时解析就失败。

## 默认断网与怎么放开网络

bwrap 沙箱默认断网（`--unshare-net`）：沙箱内的命令连不上外网。断网时先加 `--unshare-user-try`：无特权用户在 init user ns 拥有的 net ns 里配不了 loopback（bwrap 报 `loopback: Failed RTM_NEWADDR`），先建 user ns 才能拿到 CAP_NET_ADMIN；`-try` 在禁了无特权 userns 的机器上退回原行为，不硬失败。放开网络时（`allowNet`）不加这两项。

放开网络（二选一）：

1. 临时放开一次：`NYRA_SANDBOX_ALLOW_NET=1 nyra "帮我跑 …"`；
2. 长期放开：`config.json` 里加 `"sandbox_allow_net": true`。

放开后仍受审批与 shell 黑名单约束；需要联网的操作仍建议先看一眼命令原文。

## 各平台的隔离级别（不夸大）

| 平台 | auto 下的实际隔离 |
|---|---|
| Linux + 已装 bwrap | OS 级沙箱：bubblewrap（`--bind` 工作目录可写，`/usr`、`/lib`、`/lib64`、`/bin`、`/etc` 只读挂载，`--proc`、`/dev`、默认断网、`--die-with-parent`）。 |
| Linux，未装 bwrap | 工具级隔离：工作区 containment + shell 黑名单 + 审批。不是 OS 沙箱，命令在宿主机上跑。 |
| Windows | auto 下仍是工具级隔离（不是 OS 沙箱）。显式 `--sandbox jobobject` 可用进程级沙箱（Job Object，见下节）。 |
| macOS | auto 下有 sandbox-exec 就进 Seatbelt（OS 级沙箱，SBPL 最小集 profile）；无 sandbox-exec 时回落工具级。显式 `--sandbox seatbelt` 可强制要求。 |

用 `nyra doctor` 看当前生效的隔离级别（“隔离级别”一项恒为通过，
bwrap 缺失是预期内的降级，不算故障；该行同时列出 bwrap / Seatbelt /
Job Object 三个后端的可用性，auto 会选谁一眼可见；seccomp 拒单的
可用性也在同一行）。

## bot-box 纵深（M4，只 Linux）

bwrap 盒子再加三道：seccomp 拒单、出口代理、凭证经纪人。三道默认
都不开，用时由调用方显式打开；不开时行为与原来一模一样。

- **seccomp 拒单**（`src/seccomp.ts`）：经典 BPF 程序，35 个系统调用
  一律返回 EPERM——mount、chroot、ptrace、bpf、userfaultfd、setns、
  kexec、keyctl 这些能越狱的都禁了；日常的 open/read/write/execve
  不动。刻意没禁 clone3（现代运行时派生线程/进程要用它，盒子里的
  user+pid 命名空间已经把它关住了）与 unshare（盒内挂载命名空间本来
  就是私有的，再 unshare 也逃不出去，嵌套沙箱工具还要用它）。
  只在 Linux x86-64 上可用；`runSandboxed` 传 `seccomp: true` 就加载，
  本机不支持时直接抛错、不进沙箱也不裸奔（fail-closed）。程序经 fd
  传进 bwrap（`--seccomp 3`），调用方不用管 fd 的事。
- **出口代理**（`src/egressGate.ts`）：沙箱里只认一个 HTTP 代理
  （`runSandboxed` 传 `egressProxy: "http://127.0.0.1:<端口>"`，只设
  http_proxy/https_proxy 环境变量，代理本身由调用方起停）。
  代理只放公网地址：内网、loopback、链路本地、云元数据（169.254.169.254）、
  组播、文档地址一律拒掉并计数；DNS 由代理自己解析，逐个验 IP（有一个
  不公开就拒，DNS 重绑定也逃不过去），连解析到的 IP、不连主机名；
  只放 80/443 端口；只接 CONNECT 隧道与绝对 URI 的 http://；
  转发时剥掉客户端的 authorization / proxy-authorization / cookie /
  x-api-key / api-key 请求头。
- **凭证经纪人**（`src/credentialBroker.ts`）：沙箱里的 Bot 拿不到真凭
  证。宿主先在 Broker 上登记授权（名字 → 固定上游 + 真请求头，只在
  宿主内存里），再给 Bot 发一个短命 token（`nyra_brk_…`，默认 1 小时，
  绑 botId/threadId）。Bot 拿 token 到 Broker 的
  `/b/<token>/<grant>/<path>` 来换：Broker 验 token（只存 sha256 哈希、
  算哈希查表，不比明文）、剥掉客户端自己带的凭证头、加上 grant 的
  真头、转发到 grant 绑定的固定上游。token 可吊销（单个 / 按 Bot 全吊 /
  过期清理）；真凭证只在宿主进程内存里，绝不进沙箱环境变量、不进磁盘、
  不进事件。上游一律 https（http 只许本机回环的测试上游）。

三道都不接线到 CLI 默认路径：现在只是库 + `runSandboxed` 两个可选
参数 + doctor 自检行。哪条 Bot 线要开，由那条线的调用方在代码里
显式打开（开 seccomp、起 gate、登记 grant、发 token）。

## 与 Hooks 的职责分工

- PreToolUse / PostToolUse 钩子在**沙箱外（宿主机）**跑检查（`src/hooks.ts`
  已是宿主机 spawn，本项不动它）；沙箱内只跑命令本身。
- 也就是说：钩子决定“这次调用允不允许发生”，沙箱决定“命令跑起来后
  物理上能碰到什么”。钩子拦不住的越界写，沙箱在内核层再拦一道；
  沙箱挡住的命令，钩子不会在沙箱内重跑一次。
- 钩子本身的配置与写法见 `docs/hooks.md`。

## 网关接线（`nyra ui`）

网关会话与定时任务建 Agent 时，按与 CLI 同一套来源与优先级解析沙箱，
不另发明配置键：`config.json` 的 `sandbox` / `sandbox_mode` /
`sandbox_allow_net` + `NYRA_SANDBOX` / `NYRA_SANDBOX_MODE` /
`NYRA_SANDBOX_ALLOW_NET` 环境变量（CLI 的 `--sandbox` 旗标只对 CLI 有效，
网关没有对应旗标）。行为与 CLI 一致：

- `auto`（默认）：Linux 且装了 bwrap 就进 OS 沙箱，macOS 且有 sandbox-exec
  就进 Seatbelt，否则回落工具级，在该会话首次执行 shell 时提示一次；
- 显式 `bwrap` 但本机无 bwrap、`e2b` 没配 key、`danger-full-access` + `bwrap`：
  fail-closed，会话启动失败（`send` 返回 error 状态），命令不跑；
- 默认断网（`sandbox_allow_net` 未开时沙箱内 `--unshare-net`）。

钩子仍在宿主机跑，不进沙箱。

## 群聊机器人与 MCP 服务器进沙箱

0.5.1 留下的两处缺口已在 0.5.2 补齐，与 shell 工具同一后端解析口径
（`resolveSandboxBackend`，配置来源与优先级不变），都是 fail-closed：

- **群聊机器人**：`GroupStore` 增加 `sandbox` 选项，`defaultBotRunner`
  建 Agent 时原样透传；网关构造 `GroupStore` 时传
  `resolveSandbox(this.config)` 的结果（只做配置解析，不查后端二进制
  是否存在——后端不可用时不拦网关启动，留给机器人跑 shell 时逐次
  fail-closed）。注意：生产上群聊创建只允许 `readonly` 机器人
  （`create()` 有守卫），机器人实际跑不到 shell；沙箱透传是纵深防御，
  等以后有了“执行型机器人单独授权”的路径时直接生效。
- **MCP 服务器进程**：`MCPToolManager` 增加 `sandbox` 选项
  （`buildMcpManager` 透传，网关 `ensureMcpManager` 传
  `sandboxSettings()` 与网关工作区）；`startAll()` 里用
  `resolveSandboxBackend` 解析一次，解析失败整批拒绝启动。每个服务器
  进程的 spawn 参数由 `sandboxedMcpSpawnArgs`（纯函数）算出：
  `local` 原样启动；`bwrap` 复用 `buildBwrapArgv`（argv 版，不经过
  `/bin/sh -c`，stdio 管道原样透传），服务器命令与绝对路径参数所在目录
  追加只读绑定（服务器可执行文件本身常在工作区外，不绑就读不到）；
  `seatbelt` 走 `sandbox-exec -p <profile>`（profile 与 shell 同款）；
  `jobobject` 装不下长驻 stdio 进程、显式指定时直接拒绝；
  `e2b` 沙箱内跑命令须 SDK、未接线，显式指定时直接拒绝。服务器启动失败时沿用已有语义：
  该服务器跳过并在 stderr 警告，不影响其他服务器——但沙箱原因导致的
  失败绝不会让服务器裸奔启动。

诚实边界：MCP 服务器在 bwrap/Seatbelt 里只能读写工作区与临时目录，
需要写工作区外文件或缓存目录的服务器会跑不起来（报错里会写明）；这时
改用 `--sandbox local`（工具级）或把服务器的工作目录/缓存指到工作区内。

## bwrap 安装指引

```sh
# Debian / Ubuntu
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap

# Arch Linux
sudo pacman -S bubblewrap
```

装好后 `which bwrap` 能找到即生效；`nyra doctor` 的“隔离级别”一项
会从“工具级”变成“OS 沙箱（bwrap）”。不用重启 Nyra。

## 常见问题

- **命令在沙箱里报 `Permission denied` / `EPERM`？**
  多半是写了工作区之外的路径。把输出写回工作区内，或检查命令里的绝对路径。
- **命令在沙箱里连不上网？**
  默认断网是设计。确认确实需要联网后，用 `NYRA_SANDBOX_ALLOW_NET=1` 放开。
- **`--sandbox bwrap` 直接报错退出？**
  这是 fail-closed：本机没装 bwrap（或不在 Linux 上）。按上面装 bwrap，
  或改回 `--sandbox auto` / `--sandbox local`。
- **沙箱会不会影响 `write_file` / `edit_file`？**
  不会直接影响：文件工具仍走工作区 containment + 审批；沙箱目前只隔离
  `shell` 工具的命令执行（工具级沙箱，学 Gemini CLI 的做法，不隔离整个
  CLI 进程）。

---

## 受保护写入路径（与沙箱互补，但不是同一件事）

workspaceWritePath 上挂了一层受保护判定：工作目录内的以下路径**默认拒写**。

| 类型 | 路径 |
|---|---|
| 目录 | `.git` / `.nyra` / `commands` / `skills`（均为**顶层**目录） |
| 单文件（仅根级） | `AGENTS.md` / `CLAUDE.md` / `nyra.json` / `.nyra.json` |

判定按"工作目录内的相对路径"做，大小写不敏感；子目录里的同名文件**不拦**（`docs/AGENTS.md`、`src/skills/a.md` 都能写）。

### 三个必须知道的边界

1. **只覆盖文件工具**：`write_file` / `edit_file` / `apply_patch` / `plan` 走 `workspaceWritePath`，被拦；**`shell` 不在覆盖范围内**——`echo x >> AGENTS.md` 照样成功，即使进了 bwrap（AGENTS.md 就在工作目录内）。要封死 shell 的写操作得靠权限规则层（S5）。
2. **顶层同名目录会被一刀切**：如果你的项目自己就有顶层 `commands/` 或 `skills/`（例如前端的技能组件目录），agent 将无法写入这些目录。这是刻意的取舍，用下面的环境变量放开。
3. **放开方式**：`NYRA_ALLOW_PROTECTED_WRITES=1`（也接受 `true` / `yes`，大小写不敏感）。它是全进程开关，不区分路径——放开就是全部放开。

```bash
# 确需让 agent 维护自己的规则文件时（例如让它在 skills/ 下生成新技能）
NYRA_ALLOW_PROTECTED_WRITES=1 nyra "<task>"
```

### 为什么默认拦

agent 的指令来源就是 `AGENTS.md` / `commands/*.md` / `skills/*.md`。允许它改这些，等于允许它给自己放权——在一次被污染的会话里，这是最直接的持久化路径。`.git` 则是回滚与审计的底线。

---

## macOS：Seatbelt 后端（P0-6）

Linux 用 bwrap，macOS 用系统自带的 `sandbox-exec`（SBPL profile）。两者是同一层东西：**内核级拦截**，不是工具级规则。

```bash
nyra --sandbox seatbelt "<task>"     # 显式要求（非 macOS 会报错，不静默降级）
nyra --sandbox auto "<task>"         # macOS 有 sandbox-exec 时 auto 直接选 Seatbelt
```

### profile 的形状

原则是 **deny default，再逐项放行**（Apple 推荐的写法，也比"默认允许再禁止"安全）：

| mode | 文件写 | 网络 |
|---|---|---|
| `read-only` | 不给 `file-write*`，只留 `/dev/null` 等设备节点 | 按 `allowNet` |
| `workspace-write` | 只有工作目录 + `/private/tmp` + `/private/var/folders` | 按 `allowNet`，默认只放 localhost |
| `danger-full-access` | `(allow default)`，与 bwrap 后端语义一致 | 全放开 |

- 可额外追加可写路径（例如 `~/.nyra` 要写会话/记忆时）
- 路径里的 `"` 与 `\` 会被转义——不能靠路径注入 profile

### 三个边界（别高估它）

1. 拦的是系统调用面（文件/网络/进程），**拦不住工作目录内的逻辑破坏**（比如删自己的源码）。
2. `sandbox-exec` 失败即 fail-closed：报错说"命令未执行"并**不会退化成裸奔**；要裸奔必须显式 `--sandbox local`。
3. SBPL 不是 Apple 的稳定 API，语法可能随系统版本变化；这里只用了最小集 `(allow/deny file-*/network-*/process-*)`。

### 验证状态

- profile 生成是纯函数，在任何平台都能单测（`tests/node/test-seatbelt.test.ts`）
- **真机执行尚未在 macOS 上跑过**——CI 只有 ubuntu / windows / macos-latest 三档，mac 档会走 Seatbelt 分支，但本机（Windows）无法本地复现；首次 mac 运行时请重点看 `docs/sandbox.md` 这节

## Windows：Job Object 后端（P0-6）

Linux 用 bwrap，macOS 用 Seatbelt，Windows 用系统自带的 **Job Object**
（kernel32 API，通过 PowerShell + Add-Type P/Invoke 调用，不依赖原生模块）。

```bash
nyra --sandbox jobobject "<task>"   # 显式要求（非 Windows 会报错，不静默降级）
nyra --sandbox auto "<task>"         # 注意：auto 不会自动选 Job Object（见下）
```

### 为什么是 Job Object，不是 AppContainer

| 方案 | 能不能落地 | 结论 |
|---|---|---|
| Job Object | 能：纯 PowerShell 就能建作业、设限制、把子进程接进去 | ✅ 选它 |
| AppContainer | 难：要建容器档案、配 capability SID、走 STARTUPINFOEX；且默认拿不到用户文件（agent 要读写工作区），不适合做默认后端 | ❌ 不做 |

### 它到底管什么（不夸大）

Job Object 只管**进程生命周期与资源**，文件与网络靠工具级规则补：

| 限制 | 怎么做 | 默认值 |
|---|---|---|
| 随作业死 | `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（0x2000）：作业句柄一关，作业内全部进程一起死，孤儿进程不留 | 恒开 |
| 进程数上限 | `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`（0x8）+ `ActiveProcessLimit`：同时存活进程数 | 64 |
| 作业总内存上限 | `JOB_OBJECT_LIMIT_JOB_MEMORY`（0x200）+ `JobMemoryLimit`，走扩展结构 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`（class 9） | 默认不设（只在需要时配） |
| 文件写 | 工具级：工作区 containment + shell 黑名单 + 审批（与 auto 回落到工具级时同一套）；`toolShell` 在后端分发前先跑这两道检查，jobobject 分支同样经过 | 恒开 |
| 网络（断网时） | 工具级拦截（`src/tools.ts` 的 `checkJobObjectNetworkDenied`）：allowNet=false 时拦掉已知联网工具（curl / wget / nc / ncat / bitsadmin / Invoke-WebRequest / Invoke-RestMethod / Start-BitsTransfer / certutil -urlcache），localhost / 127.0.0.1 回环豁免；allowNet=true 时不拦 | 恒开 |

> 诚实边界：网络拦截是**命令名黑名单，不是内核级拦截**——改名、换工具、
> 编码命令都能绕过；它补的是“随手联网”，不是“蓄意逃逸”。真正的 OS 级
> 网络隔离要等 AppContainer 后端（见下表，本批不做）。**不要把 Job Object
> 当成 bwrap/Seatbelt 那样的内核级文件网络拦截**——它不是。

> 语义修复（0.5.2）：旧代码把内存上限写进了 `JOBOBJECT_BASIC_LIMIT_INFORMATION`
> （class 2）的第二个字段——那个槽位真实含义是 `PerJobUserTimeLimit`
> （CPU 时间上限），不是内存上限；布局字节数恰好对得上所以 echo 测试没炸，
> 但 512MB 会被当成约 54 秒 CPU 时间。现在改用扩展结构（class 9：嵌套
> `BasicLimits` + 6 个 IO 计数器 + 4 个内存字段），`SetInformationJobObject`
> 传 class 9；`BasicLimits` 里的第二个字段已正名为 `PerJobUserTimeLimit`。

文件写仍由工具级规则兜底（工作区 containment + shell 黑名单 + 审批），和
auto 回落到工具级时同一套；断网时的联网由工具级拦截补（见上表“网络”一行）。
**不要把 Job Object 当成 bwrap/Seatbelt 那样的内核级文件网络拦截**——它不是。

### 实现形状

- 脚本生成是纯函数（`src/windowsSandbox.ts` 的 `buildJobObjectScript`），任何平台可单测。
- 子进程是 `cmd.exe /c (<命令>)`，与非沙箱的 Windows 路径同一台 shell（`ComSpec`，
  默认 `cmd.exe`）。
- 命令与工作目录走 Base64 进脚本：任意引号、`$`、反引号都不会破坏脚本结构；
  CreateProcess 命令行约 32KB 上限，超长命令会启动失败并报错。
- 输出不是流式：子进程输出先落临时文件（防管道死锁），命令结束时一次性返回；
  `onStream` 不适用，`tools.ts` 的 jobobject 分支不传它。
- 子进程先启动、再接进作业，中间有毫秒级窗口：启动瞬间 fork 出的子进程理论上
  可能逃出作业；作业关柄时只杀作业内的进程。

### 三个边界（别高估它）

1. **OS 层拦不住文件与网络**：工作目录外的写靠工具级规则拦；断网时的联网靠工具级拦截（命令名黑名单）拦，都不靠 Job Object 本身。
2. PowerShell 启动失败、建作业失败时一律 fail-closed；**接不进作业分两种**：
   子进程已在父作业中（例如 CI runner 的作业，Windows 规定一个进程只能属于
   一个作业）或在接管前已退出时，降级为直接执行并在 stderr 告警（Job Object
   限制不生效，工具级规则兜底）——否则 CI 上永远跑不通（CI #92 根因）；其余
   接管失败仍 fail-closed，报错说"命令未执行"并**不会退化成裸奔**；要裸奔必须
   显式 `--sandbox local`。
3. `danger-full-access` 与 Job Object 互斥（与 bwrap/Seatbelt 同款规则）。

### 验证状态

- 脚本生成与探测是纯函数，在任何平台都能单测（`tests/node/test-windows-sandbox.test.ts`）
- **真机执行尚未在 Windows 上跑过**——本机是 Linux，靠 CI 的 Windows 任务验证
  （`run echo` 与 `exit 3` 两例只在 win32 上跑）；首次 Windows 运行时请重点看这节