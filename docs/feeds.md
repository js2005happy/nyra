# RSS/Atom 订阅阅读（Cue A 批 5.3）

一个工具 `feed_read`，读公开 RSS/Atom 订阅源，不要账号、不要花钱。
本地解析 XML，不引重型依赖。

## 用法

| 动作 | 参数 | 说明 |
|---|---|---|
| `list`（默认） | — | 列出订阅。 |
| `read` | `feed`（源名或 URL）、`count`（默认 5，最多 10） | 拉取某源最新条目（标题、链接、时间、摘要）。 |
| `add` | `name`、`url` | 加订阅。按 URL 去重；URL 只接受 http(s)。 |
| `remove` | `feed`（源名或 URL） | 取消订阅。 |

订阅存在 `~/.nyra/feeds.json`（0600、原子写，与连接器目录同口径）。
文件不存在时用 3 个内置源，不建文件：

- GitHub Blog — https://github.blog/feed/
- Hacker News — https://news.ycombinator.com/rss
- Nyra Releases — https://github.com/js2005happy/nyra/releases.atom

## 说明

- `list` / `read` 不写文件；`add` / `remove` 改订阅文件，所以整个工具不
  在只读集合里——但 `add` 按 URL 去重、`remove` 不存在的订阅只是报一句，
  两个写动作本身幂等，重试不会重复产生副作用。
- 返回内容按不可信外部数据处理（`sanitizeUntrustedText` +
  `frameUntrusted`），原文存进证据链。
- 源挂了、不是 RSS/Atom、解析不到条目时直接报错，不编造。

## 本机验证环境说明

本机沙箱的 DNS 拦截让公开域名都解析到 198.18.x.x，`assertPublicUrl`
会拦住订阅源。验证时用本地开发放行开关
`NYRA_ALLOW_PRIVATE_URLS=1`（只在验证进程里设，不进代码、不进配置）；
正常机器上 DNS 是真实公网 IP，不需要它。

## 真接口验收记录（2026-11-27，本机）

探针 `~/workspace/tmp-test-run/probe-feed-read.ts`（不进仓库），
`NYRA_ALLOW_PRIVATE_URLS=1` 下跑通，4/4：

- `list`：3 个内置源都在（GitHub Blog、Hacker News、Nyra Releases）。
- `read GitHub Blog`：最新 3 条，标题与链接真实（首条 Art of play in the age of AI）。
- `read Hacker News`：最新 3 条，标题与链接真实（首条 AI made self-hosting fun again）。
- `read Nyra Releases`：最新 3 条，标题与链接真实（首条 v0.5.15）。
