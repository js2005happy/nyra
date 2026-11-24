**中文** · [English](#security-policy)

# 安全策略

## 支持的版本

安全修复只进最新的正式版本（[最新 Release](https://github.com/js2005happy/nyra/releases/latest)）与 `main` 分支。请先升级到最新版再确认问题是否仍在。

## 报告漏洞

**请不要在公开 issue、讨论区或 PR 里披露漏洞细节。**

请通过 GitHub 仓库的 **Security → Report a vulnerability**（私下漏洞报告）提交。如果你看不到这个入口，请开一个**不含任何细节**的 issue，标题写「请求私下联系方式：安全问题」，我们会回复私下沟通的方式。

报告里尽量写清：

- 受影响的版本与平台（`nyra --version`、操作系统）；
- 问题类型（例如绕过审批、写出工作区、密钥泄露、配对或网关鉴权问题）；
- 复现步骤或概念验证；
- 你认为的影响范围。

请不要在报告里附上真实的 API Key 或他人数据。

## 我们会怎么处理

- 尽快确认收到，并告诉你是否能复现；
- 修复后发新版本，在 Release 说明与 [CHANGELOG](CHANGELOG.md) 里写明修了什么；
- 你愿意的话，在说明里致谢你的名字或 ID。

## 范围说明

Nyra 在你自己的电脑上执行命令。审批门、工作区边界、命令黑名单和沙箱能降低风险，但不是万能的：运行不可信的代码或仓库时，请再加一层隔离环境（虚拟机、容器）。各平台沙箱的真实能力与限制见 [docs/sandbox.md](docs/sandbox.md)，签名现状见 [docs/SIGNING.md](docs/SIGNING.md)。

---

# Security policy

[中文](#安全策略) · **English**

## Supported versions

Security fixes only go into the latest release ([latest Release](https://github.com/js2005happy/nyra/releases/latest)) and the `main` branch. Please upgrade to the latest version first and check whether the problem is still there.

## Reporting a vulnerability

**Please don't disclose vulnerability details in public issues, discussions or PRs.**

Report it through the repository's **Security → Report a vulnerability** (private vulnerability reporting). If you can't see that option, open an issue **without any details**, titled "请求私下联系方式：安全问题" (requesting a private contact: security issue), and we'll reply with a way to talk privately.

If you can, include:

- the affected version and platform (`nyra --version`, operating system);
- the kind of problem (for example bypassing approvals, writing outside the workspace, key leaks, pairing or gateway authentication issues);
- steps to reproduce or a proof of concept;
- what you think the impact is.

Please don't include real API keys or other people's data in the report.

## What we'll do

- Confirm receipt as soon as we can, and tell you whether we can reproduce it;
- Ship a new version with the fix, and describe what was fixed in the Release notes and the [CHANGELOG](CHANGELOG.md);
- Credit you by name or ID in the notes, if you'd like.

## Scope

Nyra runs commands on your own computer. Approval gates, workspace boundaries, the command blocklist and sandboxing reduce the risk, but they can't stop everything: when running untrusted code or repositories, add another layer of isolation (a virtual machine or container). The actual capabilities and limits of the sandbox on each platform are in [docs/sandbox.md](docs/sandbox.md) (Chinese), and the current signing status is in [docs/SIGNING.md](docs/SIGNING.md) (Chinese).
