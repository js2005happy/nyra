# Nyra Zed 扩展（协议核）

把 Nyra 接进 Zed：与 VS Code / JetBrains host 共用同一 core（`src/editorBridge.ts` 的 JSON-lines 协议）。

## 状态：协议核已实现并可测，完整扩展接线待真机

本目录现在有：

- `extension.toml`：Zed 扩展清单。
- `Cargo.toml` + `src/lib.rs`：协议核（std-only，零依赖）——出站消息编码（hello / snapshot / ask / preview / apply / ping）、服务端回复解码、工作区相对路径校验。`cargo test` 可离线跑（本机已跑过，见下）。

缺的：完整 Zed 扩展接线（`register_extension`、slash 命令、agent server），那个要接 `zed_extension_api` crate——本机走代理时 crates.io 返回 403，拉不到 crate，所以接线留给能访问 crates.io 的真机做。协议核本身不依赖那个 crate，编码结果与 Nyra 侧的 `parseEditorMessage` 对得上（字段名、版本、路径规则都按 `src/editorBridge.ts` 写）。

## 测

```bash
cd editors/zed && cargo test
```

## 完整扩展怎么做（真机）

1. 在能访问 crates.io 的机器上，`Cargo.toml` 加 `zed_extension_api` 依赖。
2. 用 `zed_extension_api::register_extension!` 注册扩展，slash 命令（如 `/nyra`）里调本协议核的编码函数，spawn `nyra editor serve --stdio` 收发 JSON 行。
3. `zed` CLI 打包安装后验证：快照、问答、diff 预览三件。
