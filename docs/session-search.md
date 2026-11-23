# 会话全文搜索（G-P1-14）

长会话一多，翻旧对话全靠肉眼。本批把会话全文搜索做出来：CLI 能搜，
模型自己也能搜（`session_search` 工具），搜到之后能把整段会话导出为
Markdown。

借 Goose（SQLite FTS，全会话搜、按会话分组回摘要与命中消息）与 OpenCode
（search + read、scope 分 project/all、模型自己能搜）的想法，TypeScript
重写，不抄两家代码。

## 索引在哪

索引就是 `src/conversations.ts` 的 `ConversationStore`：SQLite FTS5
（trigram 分词，缺失或短词时 LIKE 兜底），文件在 `~/.nyra/conversations.db`。
REPL 每轮问答记入时（`src/cli.ts` 的两处 `store.record`）就经触发器进
索引，增量更新，不用全量重建；索引损坏可直接删了重建（只丢搜索索引，
不丢会话本身——会话原文另在 `saveSession` 的 JSON 里）。

## CLI

```sh
nyra search <关键词> [--scope project|all] [--session <会话 id>]
  [--after <日期>] [--before <日期>] [--limit <n>] [--export <路径>] [--json]
```

- 不给关键词时列出最近会话（OpenCode 无 query 即列会话同款）。
- `scope` 默认 `project`：只搜当前工作目录下记的会话；`all` 搜全部。
  工作目录是记消息时写进 `session_meta` 的；本批之前记的消息没有这一项，
  只进 `scope=all`。
- `--session` 只搜某一会话；`--after` / `--before` 按时间过滤
  （`YYYY-MM-DD` 或 ISO 时间；`--before` 只给到天时含当天整天）。
- `--limit` 最多返回几个会话（默认 5），每会话最多 3 条命中消息，
  每条附一条上文、一条下文。
- `--export <路径>` 把命中的第一个会话（或 `--session` 指定的会话）
  全文导出为 Markdown；`--json` 输出机器可读的 JSON。

## 模型工具：session_search

只读工具，不需审批。参数与 CLI 同款（`query`、`scope`、`session_id`、
`after`、`before`、`limit`），不给 `query` 时列出最近会话。返回按会话
分组的命中消息与上文下文，模型再决定要不要深读。

结果进模型上下文前过一遍脱敏（与 `src/runs.ts` 的 `redact()` 同款口径：
≥32 字连续词串当疑似密钥掩掉，另加 `sk-` / `Bearer` / `key=` 形态）。
写时 `scrubSecrets` 已扫过一遍，这里是读时第二道。CLI 直接打印用户
自己的会话原文，不过这道。

检索记录进证据链：问了什么、命中几条、分属几个会话（`session_searched`
事件；没有运行上下文时写 `evidence/session-search/` 下的证据文件，
与 `knowledge_search` 同款双通道）。导出同样记一条 `session_exported`
（哪个会话、几条消息），走同款双通道。

## 只搜自己的会话

`conversations.db` 里只记本机 REPL 记入的机主会话，联合会话（缺口 39）
的共享内容不在库里，本来就搜不到。有人显式拿一个联合会话 id 当
`--session` 过滤时，先查 `sessions.json`：是联合会话且里面有未准入的
外来成员就拒绝——搜别人的会话须对方先过缺口 34 的准入闸。

## 导出

`--export` 只做 Markdown（Goose 的 `export_markdown` 同款），不做 HTML。
导出的文件含会话标题、工作目录、消息数、时间范围与按时间顺序的全部消息。

## 诚实边界

- 只在本地 SQLite FTS5 + LIKE 兜底上验过；FTS5 不可用时自动退 LIKE
  （短词、中文二字词都走 LIKE，不静默丢结果）。
- 标题取首条用户消息前 120 字，不是模型写的摘要。
- 搜不到 ≠ 没说过：`scope=project` 只认记消息时写下的工作目录，
  本批之前记的会话只能用 `scope=all` 搜到。
- Windows/macOS 真机未验证。
