# Nyra VS Code 扩展

把 Nyra 接进 VS Code：光标、选区、打开的文件与诊断直接当 agent 上下文，不用再往外贴代码。

## 装

开发版（直接拷目录，不用打包）：

```bash
cp -r editors/vscode ~/.vscode/extensions/nyra
# 重启 VS Code
```

打包版（需要 `vsce`）：

```bash
npx @vscode/vsce package --out nyra-0.5.6.vsix
code --install-extension nyra-0.5.6.vsix
```

前提：`nyra` 在 PATH 上（编译好的二进制，或 `bun` + 仓库）。不在 PATH 上时在设置里改 `nyra.cliPath`，或设环境变量 `NYRA_CLI_PATH`（指向二进制绝对路径，或仓库内 `src/cli.ts`）。

## 命令

- `Nyra: 问当前选区`：带着当前选区（没选区时带当前文件）问 Nyra，回答进「Nyra」输出频道。
- `Nyra: 同步当前编辑器状态`：手动发一次快照。
- `Nyra: 对比当前文件与磁盘`：虚拟文档左右对比（Cline 同款做法），只算 diff、不动磁盘；diff 文本同时写进输出频道，附预览 id。
- `Nyra: 看编辑器桥状态`：工作区、当前文件、打开文件数、诊断数、桥连接状态。

设置：`nyra.autoSnapshot`（默认开）：切文件、改选区、诊断变化时自动同步快照（500ms 防抖）。只发元数据与选区文本，不发整文件内容；选区与诊断文本进模型前过脱敏（见 `src/editorBridge.ts`）。

## 结构

- `package.json`：扩展清单（命令、配置、激活事件）。
- `extension.js`：薄胶水层（VS Code API 只在这里）。
- `bridge.js`：协议客户端（spawn `nyra editor serve --stdio`，JSON-lines），不依赖 vscode，可直接在 `bun test` 里测（见 `tests/node/test-vscode-bridge-batch5.test.ts`）。

## 诚实边界

- 本机没有装 VS Code：扩展只在假 `vscode` 模块 + 假子进程上测过协议与命令逻辑，真机 VS Code 里点一遍命令尚未验证。
- 扩展里问 Nyra 是派生子进程跑一次完整 CLI 任务；serve 模式下子进程非交互，写操作按既有规则 fail-closed（想让 Nyra 改文件，先在终端里跑或等审批接线）。
- 应用预览（落盘）目前只在 CLI 侧（`nyra editor apply --preview <id> --yes`），扩展内还没接“点一下应用”的按钮——diff 预览里只给预览 id，落盘须回终端确认。
