**中文** · [English](#contributing)

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

---

# Contributing

[中文](#参与贡献) · **English**

Thanks for wanting to make Nyra better. Issues, doc fixes, bug fixes and new features are all welcome.

## A few ground rules

- **Only write what's true.** Docs, interface text and commit messages describe only what has been implemented and verified. Anything unfinished is marked "Coming soon", and anything not tested on a real device says so.
- **Safety first.** Behavior such as approval gates, workspace boundaries, sandboxing and keeping keys off disk must never be loosened quietly; if you want to loosen something, open an issue to discuss it first.
- **Never commit secrets.** Screenshots, logs and test fixtures must not contain API keys, tokens or personal information.
- **One thing at a time.** One PR solves one problem, so it's easy to review and roll back.

## Local development

You need [Bun](https://bun.sh) ≥ 1.4 (used for both the runtime and the tests).

```bash
git clone https://github.com/js2005happy/nyra.git && cd nyra
bun install
bun run src/cli.ts --help            # run from source
bun run src/cli.ts ui --open         # local web interface
```

The desktop app is in `desktop/` (Tauri 2) and the Android app is in `mobile/` (Capacitor); both are built in CI. When changing their interface locally, most pages actually come from `src/webuiDesktop.ts`, `src/webuiMobile.ts` and `src/assets/`, so `nyra ui` shows the result.

## Before you submit, run

```bash
bun x tsc -p tsconfig.json --noEmit   # type check
bun test tests/node                    # all tests (fully mocked, no key, no network)
```

There are a lot of tests; on a slow machine, run just the relevant files first, e.g. `bun test tests/node/test-gateway.test.ts`. If you're behind a proxy, unset the proxy variables (`HTTP_PROXY` / `HTTPS_PROXY` and so on) before running tests, since some tests start local loopback servers.

Please include tests with new features and bug fixes: a bug-fix test should fail before the fix and pass after it.

## Commit messages

Use `type(scope): description`. The description is written in Chinese and says what changed and why:

```
fix(gateway): 会话列表只显示用户自己的对话        # session list shows only the user's own conversations
feat(ui): 助手回复安全渲染 Markdown              # render assistant replies as Markdown safely
docs(readme): 换成真实运行截图                   # switch to real screenshots of the running app
```

Common types: `feat` / `fix` / `docs` / `test` / `ci` / `chore` / `refactor`.

## Filing issues

- Bugs: use the "内测问题反馈（Bug） / Beta bug report" template, with your platform, version (`nyra --version`), steps to reproduce, and expected vs. actual results. **Never paste API keys.**
- Experience and suggestions: use the "内测体验反馈 / Beta feedback" template.
- Security problems: **don't file a public issue**; see [SECURITY.md](SECURITY.md).

## License

Contributions are released under this repository's [MIT license](LICENSE). By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
