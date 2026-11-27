# GitHub 公共 API 只读工具（Cue A 批 5.2）

两个只读工具，走 GitHub 公共 REST API 未认证档，**不要新账号、不要花钱**，
也不需要 token。只读公开内容；私有仓库、写操作、需要登录的接口一律不走
这两个工具。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `github_repo_read` | `repo`（必填，`owner/name`）、`path`（可选，不填读 README）、`ref`（可选，分支或提交，不填默认分支） | 读公开仓库的文件或 README；`path` 是目录时列出目录内容。 |
| `github_search` | `query`（必填）、`type`（`repositories` 或 `issues`，默认 `repositories`）、`count`（默认 5，最多 10） | 搜公开仓库或 issue。 |

## 限额与报错

- 未认证档 **60 次/小时**，按出口 IP 计——本机与别人共享出口 IP，限额可能
  比想象中先到。限额用完时工具直接报错，报出重置时间，**不要编造结果**。
- 仓库/内容不存在报 404，不编造。
- 返回内容按不可信外部数据处理：先过 `sanitizeUntrustedText` 再
  `frameUntrusted`，并像 `web_fetch` 一样把原文存进证据链（来源链接附在
  返回末尾）。

## 本机验证环境说明

本机沙箱的 DNS 拦截让公开域名都解析到 198.18.x.x，`assertPublicUrl`
会拦住 `api.github.com`。验证时用本地开发放行开关
`NYRA_ALLOW_PRIVATE_URLS=1`（只在验证进程里设，不进代码、不进配置）；
正常机器上 DNS 是真实公网 IP，不需要它。

## 真接口验收记录（2026-11-27，本机）

探针 `~/workspace/tmp-test-run/probe-github-tools.ts`（不进仓库），
`NYRA_ALLOW_PRIVATE_URLS=1` 下跑通，3/3：

- `github_repo_read {repo: js2005happy/nyra}`：读到 README 真文（带不可信
  外部数据标记与证据保存）。
- `github_repo_read {repo: js2005happy/nyra, path: README.md}`：读到文件真文。
- `github_search {query: "nyra agent", type: repositories, count: 3}`：
  共约 13 条，显示 3 条，含真实仓库链接。

限额耗尽时的报错（`GitHub 公共 API 限额已用完…重置时间…`）只走了代码分支，
本次未实际触发（共享出口 IP 下 3 次调用远未到 60 次上限）。
