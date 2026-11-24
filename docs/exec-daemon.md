# 本地执行守护进程

> 把 shell 从 agent 进程里挪出去，做成一个只认 token 的执行守护进程。

## 为什么

Nyra 现在跑 shell 是**同进程 spawn**（`src/tools.ts` 的 `runShellStreaming`）。这意味着：

- agent 进程被提示注入攻陷 → 攻击者直接拿到 `spawn`
- 命令在跑，agent 崩了 → 命令跟着挂
- 想给 shell 单独限权（换用户、挂 seccomp/Job Object、只挂工作目录）→ 没地方下手

守护进程把这三件事变成可做的：

```
agent 进程  ──(行协议 + token)──>  exec daemon  ──spawn──>  子进程
   ↑                                    ↑
被攻陷时只拿到"客户端"            可以独立限权/重启/审计
```

## 协议（一行一个 JSON）

请求：

```json
{ "id": "c1", "type": "exec", "v": 1, "token": "…", "command": "npm test", "cwd": "/repo", "timeoutMs": 30000 }
```

事件（服务端 → 客户端）：

```json
{ "id": "c1", "type": "stdout", "text": "…" }
{ "id": "c1", "type": "stderr", "text": "…" }
{ "id": "c1", "type": "exit", "code": 0, "timedOut": false }
{ "id": "c1", "type": "denied", "reason": "token 无效" }
```

约定：

- `v` 与 `EXEC_PROTOCOL_VERSION` 必须相等（不做半升级兼容，错配就明说）
- `token` 错 → `denied`，**绝不执行**
- `exitCode: null` 表示「没拿到退出码」（被拒 / 启动失败 / 被杀），**不要当 0**
- 一行一条消息；坏行丢弃计数，不中断连接

## 两个实现细节（都踩过）

### 1. 超时必须杀**整棵进程树**

第一版用 `child.kill()`：Windows 上只杀 `cmd.exe`，`ping`/`npm` 这些孙进程继续活着并**继续持有 stdout 管道**，于是 `close` 事件迟迟不来，客户端被吊到慢命令自己结束（实测 600ms 超时，实际 5077ms 才返回）。

现在：

- `win32` → `taskkill /pid <pid> /T /F`（`/T` 才是连子孙）
- POSIX → `detached: true` 起进程组，超时 `process.kill(-pid, "SIGKILL")`
- **并且**杀完立刻发 `exit`，不等 `close`（管道可能仍被持有）

### 2. 默认只绑回环

`host` 默认 `127.0.0.1`。绑 `0.0.0.0` 等于把 shell 暴露到局域网——一个 token 挡不住端口扫描。

## 用法

```ts
import { startExecDaemon, ExecDaemonClient } from "./execDaemon.ts";

// 独立运行（推荐：单独进程、单独限权）
const d = await startExecDaemon({ allowedRoots: ["/repo"] });
const c = new ExecDaemonClient({ port: d.port, token: d.token });

const r = await c.run("npm test", { cwd: "/repo", timeoutMs: 120_000 });
if (r.exitCode === null) throw new Error(r.error);
```

## 接入工具层（opt-in，纯增量）

`ToolContext.execDaemon` 是可选项：传了就**在流式分支之前**接管 shell；不传完全保持旧行为。

```ts
const agent = new Agent(provider, {
  workdir, home, mode: "auto",
  execDaemon: { run: (cmd, o) => client.run(cmd, { cwd: o?.cwd, timeoutMs: o?.timeoutMs }) },
});
```

结果整形交给 `formatExecResult()`（纯函数、单测覆盖），三条与旧 shell 工具一致的语义：

| 情况 | 输出 |
|---|---|
| 非零退出码 | 附 `（退出码 N）` —— 不标出来模型会把失败当成功 |
| 超时 | `错误：命令超时（N 秒）` + 已产生的输出 |
| 被拒 / 启动失败 | 把原因带出来，**不**当成 0 |

## 还没做的（诚实边界）

- 接的是"可选开关"，**不是默认路径**：默认仍走同进程 spawn / 沙箱后端。要变默认得先决定 daemon 与 bwrap/seatbelt/Windows 沙箱的职责划分——两边都要边界时容易互相抵消
- 流式输出（`tool_stream` 事件）在 daemon 路径上暂不转发：`run()` 是聚合式返回，要流式需把事件往上透（下一步）
- daemon 端限权目前只靠 `allowedRoots` + 系统账号；没有 seccomp/Job Object 的具体配置
- 没有 TLS/管道认证：回环 + token 是当前的全部鉴权。跨机部署必须换（Unix socket + 文件权限，或 TLS）
