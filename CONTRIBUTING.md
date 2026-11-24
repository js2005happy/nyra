# 参与贡献

谢谢你愿意帮 Nyra 变得更好。提 issue、改文档、修 bug、加功能都欢迎。

## 先说几条约定

- **只写真的。** 文档、界面文案、提交说明里只写已经实现并验证过的东西；没做完的写「即将推出」，没在真机上验过就写明没验过。
- **安全优先。** 审批门、工作区边界、沙箱、密钥不落盘这些行为不能被悄悄放宽；要放宽请先开 issue 讨论。
- **不提交密钥。** 截图、日志、测试夹具里不能出现 API Key、token、个人信息。
- **一次只做一件事。** 一个 PR 解决一个问题，方便审阅和回滚。

## 本地开发

需要 [Bun](https://bun.sh) ≥ 1.4（运行时与测试都用它）。

```bash
git clone https://github.com/js2005happy/nyra.git && cd nyra
bun install
bun run src/cli.ts --help            # 跑源码
bun run src/cli.ts ui --open         # 本地网页界面
```

桌面 App 在 `desktop/`（Tauri 2），安卓 App 在 `mobile/`（Capacitor），都由 CI 构建；本地改它们的界面时，大部分页面其实来自 `src/webuiDesktop.ts`、`src/webuiMobile.ts` 与 `src/assets/`，用 `nyra ui` 就能看到效果。

## 提交前请跑

```bash
bun x tsc -p tsconfig.json --noEmit   # 类型检查
bun test tests/node                    # 全部测试（全部 mock，无需 Key、不联网）
```

测试较多，机器慢时可以先只跑相关文件，例如 `bun test tests/node/test-gateway.test.ts`。如果你在代理环境里，跑测试前先取消代理变量（`HTTP_PROXY` / `HTTPS_PROXY` 等），部分测试会起本机回环服务。

新功能、修 bug 请带上测试：修 bug 的测试应在修复前失败、修复后通过。

## 提交说明

用 `类型(范围): 说明`，说明用中文，写清楚改了什么、为什么：

```
fix(gateway): 会话列表只显示用户自己的对话
feat(ui): 助手回复安全渲染 Markdown
docs(readme): 换成真实运行截图
```

常用类型：`feat` / `fix` / `docs` / `test` / `ci` / `chore` / `refactor`。

## 提 issue

- Bug：用「内测问题反馈（Bug）」模板，写清平台、版本（`nyra --version`）、复现步骤、期望与实际结果。**不要贴 API Key**。
- 体验与建议：用「内测体验反馈」模板。
- 安全问题：**不要公开提 issue**，见 [SECURITY.md](SECURITY.md)。

## 许可

提交的贡献按本仓库的 [MIT 许可](LICENSE) 发布。参与即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
