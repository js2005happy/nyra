# 逆向笔记：一台机器上的 "Grok Bot"

> 目的：记录从 `C:\Users\Public\Desktop\Grok Bot.lnk` 追下去看到了什么，哪些机制我们采纳了，
> 哪些**故意不采纳**及理由。不是宣传材料，也不含对方代码——只有观察到的结构与设计取向。

## 它是什么

```
Grok Bot.lnk → C:\Program Files\Grok Bot\Grok Bot.exe（238 MB）
            → Electron → resources/app.asar（57 MB，903 个文件）
            → package.json: name "sand", productName "Grok Bot", author SpaceXAI
              homepage: https://cursor.com
              依赖 60+ 个 @anysphere/* 与 @sand/* 内部包
              构建时间 2026-11-13
```

结论：**Cursor 的换皮/分支构建**（内部代号 `sand`），不是独立实现。asar 里是打包后的 bundle，
没有源码；能读出结构与行为取向，读不到可维护的源码。

几个能说明设计重心的包名（按名字即可判断职责，未展开反编译）：

| 包 | 推断职责 |
|---|---|
| `@anysphere/agent-core` `agent-exec` `agent-client` | agent 主循环 / 执行 / 客户端 |
| `@sand/local-exec-daemon` `local-exec-protocol` | **把 shell 挪进独立进程**，自定义协议 |
| `@anysphere/mcp-core` `mcp-agent-exec` | MCP 接入与执行 |
| `@anysphere/agent-summarization` `agent-transcript` | 会话压缩 / 转写落盘 |
| `@anysphere/model-selection` | 模型选择 |
| `@sand/sand-eval-runner` | 确定性评测（固定任务 + 重跑） |
| `@anysphere/voice-call-harness` | 语音通话 |
| `@anysphere/otel-proto` | OpenTelemetry |

## 采纳了什么

**1. 本地执行守护进程（已落地，#114）**

观察：shell 不在 agent 进程里跑，而是 daemon 进程执行，两者经本地 socket 上的行协议通信，
带 `workspace_readonly` / `workspace_readwrite` 这类权限级别与 `needs_permission` 这类状态。

采纳的是**边界思想**，不是它的实现：

- 行协议 + token + 协议版本比对（`src/execDaemon.ts`）
- 目录白名单（`allowedRoots`）
- **超时杀整棵进程树**：这是我在实现过程中自己踩出来的——`child.kill()` 在 Windows 上只杀
  `cmd.exe`，`ping`/`npm` 这类孙进程继续持有 stdout 管道，600ms 超时实测 5177ms 才返回

**2. 协议版本显式化**

它的错误码里有 `sidecar_not_running` / `sidecar_unreachable` / `sidecar_timeout` 这类
"对端没起来/连不上/超时"的明确分类。照这个思路，Nyra 的 daemon 客户端把
`exitCode === null` 定义为"没拿到退出码"（被拒/启动失败/被杀），**绝不当 0**。

## 故意没采纳的

| 它的做法 | 我们为什么不照搬 |
|---|---|
| 把 daemon 作为**默认**执行路径 | 要先把 daemon 与 bwrap/seatbelt/Windows 沙箱的职责划分定死；两边都要边界时容易互相抵消。Nyra 目前做成 opt-in 开关 |
| 庞大的内部包拆分（60+ 包） | Nyra 是单仓库小项目，按包拆会把"改一处要跑五个包"的成本引进来 |
| `voice-call-harness` | 与 Nyra 的定位（终端/网关 agent）无关 |
| 闭源 bundle | 无法维护、无法审计；只借鉴机制，不搬代码 |

## 我们这边对应已有的东西（避免重复造）

| 能力 | Nyra 已有 |
|---|---|
| 多 agent 并行 | `parallelDelegate`（含并发上限、账本诚实性） |
| 会话压缩 | `compact` + 上下文建议 |
| 运行记录 / 重放 | `runs`（state.json + events.jsonl）+ `evidence verify` |
| MCP | `mcp` 工具 + 延迟加载阈值 |
| 模型选择 | `modelRouting`（compact / delegate / tool 三档） |
| 可观测 | `telemetry`（OTel） |
| 协议接入 | `acp` / `a2a` / `agui` |

## 怎么复现这套观察

```powershell
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut("C:\Users\Public\Desktop\Grok Bot.lnk")
$s.TargetPath; $s.WorkingDirectory; $s.Description
# asar 解包：读 12/16 字节处的 header 长度，剪出 header JSON，再按 offset/size 逐文件切
```

解包脚本在 `C:\Users\Administrator\re\grokbot\{extract,list,get}.cjs`（本机临时目录，不入库）。
