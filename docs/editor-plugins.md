# 编辑器插件

Nyra 原来只有一个 LSP 客户端（`src/lsp.ts`），是模型按需调的工具，没有编辑器里的常驻入口——用户在编辑器里改代码时，Nyra 看不见光标、选区、打开的文件和报错，上下文全靠人贴。本批按 Continue 的做法补一层“IDE 接口抽象 + 各编辑器共用同一 core”：协议与状态在 Nyra 侧（`src/editorBridge.ts`），三个编辑器 host 只负责采集与展示。

## 架构

```
编辑器 host（VS Code / JetBrains / Zed）
  │  JSON-lines（stdin/stdout，每行一条消息）
  ▼
nyra editor serve --stdio          ← 子进程，协议服务端（src/editorBridge.ts）
  │  快照 / 诊断 / diff 预览 / ask 派生
  ▼
~/.nyra/editor-state.json（0600）  ← 最近快照
~/.nyra/editor-previews.json（0600）← 待应用预览（最多 20 条）
~/.nyra/evidence/editor/           ← 编辑器事件证据文件
```

协议版本 1，消息类型：`hello` / `snapshot` / `diagnostics` / `ask` / `preview` / `apply` / `ping`，回复：`hello` / `ack` / `pong` / `diff` / `applied` / `answer_chunk` / `answer_done` / `error`。非法消息（类型未知、字段缺失、路径越界、超 1MB）一律回 `error`，服务循环不崩。

## CLI

```bash
nyra editor serve [--stdio]        # 启动桥服务（只支持 stdio）
nyra editor status                 # 最近快照 + 待应用预览
nyra editor snapshot [--json]      # 打印最近快照
nyra editor ask <问题>             # 带上最近快照问一次 Nyra（派生一次完整 CLI 运行）
nyra editor preview --file <相对路径> --new <新内容文件>   # 只算 diff，存预览
nyra editor apply --preview <id> --yes                  # 应用预览（须 --yes）
nyra editor hosts                  # 查三个 host 的安装状态
```

`ask` 是派生一次完整 CLI 运行（`nyra "<快照 + 问题>"`），stdio 继承：provider、成本硬顶、审批链全是正常 CLI 那套，终端里能交互审批。serve 模式下的 ask 走同一条路，但子进程 stdin 为 null（非交互），写操作按既有规则 fail-closed——只读问答照常跑，想改文件时子进程会明确拒绝。

## diff 预览（学 Cline 的虚拟文档）

`preview` 只算 unified diff、不动磁盘，预览 id 存进账本；`apply` 时先核对文件自预览后没变过（变过就拒绝，重新 preview），再写盘。协议层的 `apply` 消息必须带 `approved: true`——扩展侧须先弹过用户确认才发，服务端只认这一位，不替扩展做决定。VS Code 侧的对比用虚拟文档左右对照（`nyra-preview` scheme），同样不动磁盘。

## 模型工具

`editor_context`（只读，不需审批）：读最近一次编辑器快照——当前文件、光标、选区文本、打开的文件、诊断。编辑器没连上时直接说没快照，不编内容。选区与诊断文本进上下文前过脱敏（与 `runs.redact` 同款口径）。工具总数 39→40。

## 三个 host 的状态

| host | 状态 | 说明 |
| --- | --- | --- |
| VS Code（`editors/vscode/`） | 完整实现 | 扩展清单 + 协议客户端（`bridge.js`，可单测）+ 薄胶水（`extension.js`）。命令：问选区、同步快照、虚拟 diff 对比、看桥状态；`nyra.autoSnapshot` 默认开（500ms 防抖）。 |
| JetBrains（`editors/jetbrains/`） | 骨架，未编译 | `plugin.xml` + Kotlin 客户端（同协议）+ 两个 Action + 工具窗口骨架。本机无 IntelliJ / Gradle，须在真机上建插件工程编译；诊断采集留空待补。 |
| Zed（`editors/zed/`） | 协议核已实现，完整接线待真机 | `extension.toml` + Rust 协议核（std-only，`cargo test` 可离线跑）。完整接线须 `zed_extension_api` crate，本机走代理时 crates.io 返回 403，拉不到。 |

## 安全口径

- 路径只认工作区相对路径，绝对路径与 `..` 越界一律拒绝；快照的工作区须等于 serve 的工作区。
- 事件里只记 host、相对路径、计数与 diff 行数，不记文件原文、不记选区文本；选区文本只进模型上下文，且过脱敏。
- 快照与预览账本只存在机主自己的 `~/.nyra` 下（0600），不经过网络。
- 写操作只有两条路：CLI `apply --yes`（显式确认），或 agent 自己的 `apply_patch`（走正常审批链）。

## 诚实边界

- 本机没有 VS Code / IntelliJ / Zed：VS Code 扩展只在假 `vscode` 模块 + 假子进程上测过协议与命令逻辑，真机里点一遍命令尚未验证；JetBrains 没编译过；Zed 只测了协议核，完整扩展没装过。
- serve 模式下问 Nyra 是非交互子进程：能回答、能读文件，写操作会被明确拒绝（须回终端确认，或等审批接线）。
- 扩展里应用预览（落盘按钮）还没接——diff 预览只给预览 id，落盘须回终端跑 `nyra editor apply --preview <id> --yes`。
- 诊断目前只接 VS Code 自带的 Problems；JetBrains 侧诊断采集留空；Nyra 自己的 LSP 客户端（`src/lsp.ts`）仍可独立查诊断与符号，与插件互补。
