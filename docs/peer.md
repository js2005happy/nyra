# 对端协作（缺口 12）：Agent 间直接协作

两个 Nyra 实例之间可以直接协作：互相提问、交接任务、共享上下文。
本批只做**异步**协作（问一句、等一段回答；交过去、对方续跑）。
实时视频会是缺口 39 的事。

## 快速开始

1. 在对端（B）上开启对外 MCP 服务并拿到网关 token：

```sh
nyra mcp server enable
nyra gw status   # 看网关地址与 token（token 只在 B 的本机上能看到）
```

2. 在本机（A）的 `config.json` 里配对端（名字 + 网关 `/mcp` 地址）：

```json
{
"peers": {
  "enabled": true,
  "list": [{ "name": "b", "url": "http://192.168.1.20:8080/mcp" }]
}
}
```

3. 开启对端协作与独立审查层（两道门，缺一不可）：

```sh
nyra peer enable
nyra reviewer enable
```

4. 给对端存网关 token（只存密码箱，不写进 config）：

```sh
nyra peer auth b
```

5. 问一句 / 交接一次运行：

```sh
nyra peer ask --to b "周报一般怎么写？"
nyra peer handoff --to b --run 20261120-120000-abcdef
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `nyra peer status` | 查看对端协作状态（是否开启、已配对端） |
| `nyra peer enable \| disable` | 开启 / 关闭对端协作（默认关闭） |
| `nyra peer list` | 列出已配对端（名字与地址，不含令牌） |
| `nyra peer auth <名字>` | 给对端存网关 token（只存密码箱） |
| `nyra peer ask --to <名字> [--timeout N] <问题>` | 问对端一个问题并等答复（默认等 180 秒，最长 600 秒） |
| `nyra peer handoff --to <名字> --run <运行ID> [--mode readonly\|auto] [--share evidence]` | 把一次运行的上下文交接给对端续跑（默认只读） |

退出码：0 成功、1 运行失败（对端拒了、网络不通、运行不存在）、2 用法错误。

## 互问是怎么跑的

`ask` 调对端对外 MCP 服务的新只读工具 `answer_question`：
对端用只读 agent 短跑（最多 4 轮）回一段回答（截到 4000 字）。
回答花的是**对端**的 token；本机只记“问过”这一事实。

对端不可信：答复只当作外部输入，过 `wrapUntrusted` 再用，
答复里的指令、链接、文件路径一律按不可信输入处理，绝不直接当指令执行。

## 交接包里有什么、没有什么

交接包从源运行的 `state.json` 与 `events.jsonl` 拼出来，
**不读会话文件**（完整对话历史不共享）。

| 字段 | 默认 | 内容 |
| --- | --- | --- |
| `task` | 共享 | 任务描述（已脱敏） |
| `conclusions` | 共享 | 已验证的结论（验收结论；没有时写明“没有已验证的结论”） |
| `steps` | 共享 | 已做步骤（工具名 + 成功/失败，不含参数） |
| `todos` | 共享 | 待办（挂起的审批、中断提示） |
| `evidence` | 不共享 | 事件类型计数 + 事件总数（只共享类型摘要，不共享事件内容） |

`evidence` 须 `--share evidence` 显式加。包里永远没有：
令牌、密码、绝对路径（先过 `redact` 再把 home 与工作目录替换成占位符）、
完整对话历史。

对端收到后以只读模式入队续跑（`dispatch_task`，默认 `readonly`）；
`--mode auto` 时对端按自己的审批跑写操作，写操作仍须对方显式接受。
对端接下后回 `run_id` 即记 `accepted`；对端审查拦截或入队失败记 `rejected`。

## 三处审计

每次互问 / 交接都写三处，只记元数据与指纹，不记问题原文、答复原文与交接包内容：

- **Beads 账本** `~/.nyra/peer-handoffs.jsonl`：谁交的、交了什么、对方接没接
（`sent` / `accepted` / `rejected` / `failed` / `answered`，可按 id 查）。
这是报告里 Beads（任务、决策、依赖、进度以原子单元记下来）的最小落地；
完整的 Beads（任务拆解、依赖图、git backed 同步）是后续批次。
- **对端审计** `~/.nyra/peer-audit.jsonl`：每次调用一行（对端名、动作、指纹、结论）。
- **运行事件** `peer_asked` / `peer_handoff`：进证据链，`nyra timeline` 能看到
（“问对端 B（已答复）”“交接给对端 B（accepted）”）。

## 安全边界

- 默认关闭：`peers.enabled` 与 `mcp_server.enabled` 都默认 `false`，
对端协作与对外服务各开各的门。
- 对外发送是写操作：须过独立审查层（虚拟动作 `peer_ask` / `peer_handoff`），
审查层未开启时直接拒绝（fail-closed），不是静默放行。
- 不做局域网自动发现、不扫网段：对端须用户显式配，名字只认字母数字、
下划线与连字符，地址只认 `http://` / `https://`。
- 对端网关 token 的读取顺序：`NYRA_PEER_TOKEN_<名字>` 环境变量 →
密码箱条目 `peer-token-<名字>`（`NYRA_PEER_TOKEN_<名字>` 里的名字大写，
非字母数字转下划线）。没有 token 时调用方按 403 的报错文案指引用户去存。
- 对端花的 token 记在对端自己的账本里；本机不掌握对端花了多少，
审计里只记“问过 / 交过”这一事实。

## 已知局限

- 真实对端未接通过，只在假对端（本机 HTTP）上验过。
- `answer_question` 的回答花对端 token、无单独计费（对端自己的用量账本会记）。
- 实时视频会（多人多 agent 视频会）是缺口 39 的事，本批只做异步。
- 局域网自动发现没做；跨用户互问的“对方是谁”只认对端名，不做身份认证
（网关 token 是唯一的鉴权手段，见 `docs/mcp.md`）。
- Windows / macOS 真机未验证。

## 名片与加好友（缺口 38，§4.3 第三批）

好友 = 一个人 + 他的 agent。加好友不是扫个码就完事——双向批准才互认：
你发请求、对方批准，另一边同样走一遍；没批准之前，对方什么都看不到、
什么都调不动。

### 名片

`nyra peer card` 看我的名片（JSON）。名片是 A2A 风格的一张卡：名字、
描述、能力清单、端点、认证方式。内容由 Soul（`~/.nyra/souls/<agent>.json`，
见 `docs/soul.md`）与对外 MCP 服务的工具清单如实生成，不编造没有的能力：

- 名字与描述来自 Soul 身份（name / persona / goal），没配 Soul 时是默认值。
- 技能 = 对外 MCP 服务的工具清单（`search_memory`、`query_evidence`、
  `answer_question`、`add_memory`、`forget_session`、`dispatch_task`）。
- `authentication.schemes` 只有 `bearer`；`capabilities` 里 streaming 与
  pushNotifications 都是 false——Nyra 目前只回 JSON、不做流式推送。

名片本身是公开信息（不含密钥与内部状态），但默认不发布。发布开关在
`config.json` 的 `peer_card` 一节：

```json
{
  "peer_card": {
    "publish": true,
    "public_url": "https://nyra.example.com"
  }
}
```

- `publish` 默认关；关时网关 `GET /.well-known/agent-card.json` 当不存在
  （404），不泄露端点。
- `public_url` 只认 http(s)，即网关根地址；名片里
  `supportedInterfaces[0].url` 就是它（v1.0 形状；A2A 名片的 MCP
  端点是它后面加 `/mcp`，只在 A2A 名片里发）。不配时
  `supportedInterfaces[0].url` 是 null。
- 开关也可以用命令改：`nyra peer card publish on|off`（改 `config.json`，
  不重启也生效——网关每次请求都读当前配置）。
- 第 3 批 G-P1-7 名片 JWS 签名：`nyra peer card keygen` 生成 P-256 钥匙
  （私钥只存密码箱），`nyra peer card sign on|off` 开关签名，
  `nyra peer card trust <好友名>` 钉住对方公钥（TOFU），
  `nyra peer card verify <好友名>` 验钉住的钥匙还对不对得上。
  详见 `docs/peer-discovery.md`。

### 好友码

`nyra peer code` 看我的好友码。格式 `NYR-XXXX-XXXX`（字母表去掉了 0/1/I/O，
免得念错），24 小时有效，过期自动换新（`--regenerate` 立即换一枚）。
码是双方人工比对的共享口令：你把码发给对方（聊天里贴一下就行），对方
登记请求时带上这枚码，我这边验得上才认——错码不认、过期码不认。

账本与事件里只记码的 SHA-256 前 12 位指纹，不记码本身。

### 加好友（双向批准）

```bash
# 我发请求：先拉对方名片校验（格式不对、名片没发布都直接拒绝）
nyra peer add --name pilot --url http://127.0.0.1:18080/mcp
# 对方把码给你，你登记他的请求（--code 必填）
nyra peer request --name pilot --url http://127.0.0.1:18080/mcp --code NYR-ABCD-1234
# 批准（默认只读，须 --yes）
nyra peer accept pilot --yes
# 拒绝
nyra peer decline pilot --yes
```

- 发请求只记我方账本，不通知对方——对方那边也要走一遍 `request` + `accept`
  才算双向。状态分得开：`好友（双向）`（两边都走了流程）与 `好友`
  （只我这边批准了）。
- 未批准前对方什么都看不到、什么都调不动：`share` 与视频 `--friend`
  都只认已批准、未拉黑的好友。
- 批准、拒绝、拉黑、删除都须 `--yes`（accept/decline/block/remove），
  删圈也须 `--yes`。

### 好友分圈与权限档

```bash
nyra peer circle create work        # 建圈（default 是默认圈，不用建、不能删）
nyra peer circle list
nyra peer friend pilot --circle work --tier propose
nyra peer circle delete work        # 删圈须先移空
```

- 每个好友归属一个圈（默认 `default`），权限档只有两档：`readonly`
  （默认，只读）与 `propose`（可提议修改，不能直接改）。
- 圈只决定“我主动发给谁”与“共享给谁”：`share --to <圈名>` 发给整圈
  （圈名与好友名重名时好友优先）；`well-known` 名片端点本身是公开的，
  圈不限制谁来拉名片——缺口 34 第一批做了信任圈准入（谁能发任务，
  详见 `docs/circles.md`），名片拉取的 per-circle 可见性仍未做
  （留给后续批次）。
- 人的权限和 agent 的权限分开管：这里只管 agent 这一侧；人那一侧是
  视频通话面板的事（设计稿已从公开站点下线）。

### 只共享任务产物

```bash
nyra peer share --to pilot --run 20261120-120000-abcdef
nyra peer share --to work --run 20261120-120000-abcdef --share evidence
```

- 只共享已完成任务的产物（文件 / 结论 / 证据摘要），不共享原始对话、
  凭证、内部账本与用量细节。底层复用缺口 12 的交接包与审查门：先过独立
  审查（`reviewer` 须开），放行才发；只读模式，不给写权限。
- `--to` 可为好友名或圈名；发给整圈时逐个发、逐个记结果（某一家拒绝
  不影响其他家）。
- 对方发来的名片、消息、任务产物一律按不可信输入处理：先验格式再用，
  不直接执行、不直接进记忆、不直接进审批（缺口 12 的口径沿用）。

### 视频通话接线

```bash
nyra video call start --friend pilot --yes
```

- `--friend <好友名>` 按好友账本解析：须是已批准、未拉黑的好友，否则
  拒绝呼叫（`--peer` 保持原样：任意名字 + `--yes`）。
- `--friend` 与 `--peer` 二选一；呼叫有名有姓的对方须 `--yes` 的规矩沿用。
- 本批只校验好友身份，不改通话媒体面。

### 账本与证据链

- 好友账本 `~/.nyra/friends.json`（原子写 0600，损坏先备份再抛错，
  不静默重建）+ 好友码 `~/.nyra/friend-codes.json`（同款写法）。
- 8 个新运行事件已注册进 EVENT_FIELDS（`friend_requested` /
  `friend_request_received` / `friend_accepted` / `friend_declined` /
  `friend_blocked` / `friend_unblocked` / `friend_removed` /
  `friend_code_regenerated`），每次好友操作单独建一条只记 friend_* 事件的
  证据运行（peer.ts 同款做法）；审计进 `~/.nyra/peer-audit.jsonl`
  （只记对端名、名片指纹与码指纹）。
- 第 3 批新事件：`peer_discovered`（发现，记地址、名字、签名结论）、
  `peer_token_set` / `peer_token_revoked`（per-peer token，只记给谁，
  不记原文）。

### 公开发现与 per-peer token（第 3 批 G-P1-4）

不靠线下传码发现并加上一台别人的机器人：`nyra peer discover <地址>`
拉对方 well-known 名片、验签名、记进发现账本；`--as <好友名>` 时
同时发好友请求，仍须对方批准。A2A v1.0 起名片签名是准入门槛：没签名、
篡改过、过期签名都拒绝、不进账本，对方须先跑 `nyra peer card keygen`
再开 `nyra peer card sign on`。名片 JWS 签名（G-P1-7，v1.0 升级）与
per-peer token（出站，每好友一条，吊销一家不影响别家）详见
`docs/peer-discovery.md`。

### 已知局限

- 真实对端未接通过：只在假名片服务器（本机 Bun.serve）与假 MCP 服务器
  上验过握手与分享。
- 名片发布只在网关跑着时才可达；网关没跑，对方拉不到名片。
- 圈可以限制名片拉取（G-P1-5，第 2 批）：`config.json` 的 `peer_card.visible_circles`
  配了圈名时，只有这些圈的好友凭有效 grant 才能拉到名片；不配时不限制圈
  （只认 publish 开关）。网关 well-known 端点按圈放行，不认的直接 404，
  不泄露“是没配还是没权限”。
- 视频 `--friend` 只校验好友身份，不改媒体面；跨 agent 联合会话是
  缺口 39 的事，缺口 34 第一批已落地。
- Windows / macOS 真机未验证。

## 好友 grant：好友码升级（缺口 G-P1-6，第 2 批）

好友码不再是一串死码，改成带 scope、可吊销的授权（Hermes 的 grant 思路，
只抄机制）：

```sh
nyra peer grant issue <好友名> <scope,...> [--days <天数>]
nyra peer grant list [--peer <好友名>]
nyra peer grant verify <token> [--scope <scope>]
nyra peer grant revoke <授权 id>
```

- scope 精确匹配，可选：`card:read`（拉名片）、`session:join`（进会）、
  `share:receive`（收共享）、`call:video`（视频通话）。多 scope 用逗号隔开。
- token 形如 `nyra-grant-…`，只在签发时打印一次；账本
  `~/.nyra/friend-grants.json`（0600）里只记 SHA-256，不记原文。
- 默认 30 天有效，可配 1–90 天；过期自动失效，不用手动清。
- 吊销只影响这一家：每 peer 的授权独立记，吊销 alice 的不影响 bob。
- 只发给已批准、未拉黑的好友；陌生人、待批的、拉黑的都签发不出去。

## 对方写操作默认进提议（缺口 G-P1-10，第 2 批）

对端发来的任务（来源 peer）里，写操作一律不直接执行：先记一条提议
进 `~/.nyra/peer-proposals.json`（0600），等机主批了才执行。

- 进提议的工具：`write_file` / `edit_file` / `apply_patch` / `shell` /
  `http_post` / `gmail_send` / `memory_append` / `memory_delete` /
  `memory_forget` / `save_skill` / `plan`。只读工具不受影响，照常跑。
- 批准只标 `accepted`，不自动执行——执行由机主上下文另跑；提议不过期、
  不静默执行。
- 来源只记 `local` / `peer`，不记 peer 名（`~/.nyra/task-origins.json`）；
  MCP 派发的任务记 `peer`。

```sh
nyra peer proposal list [--status pending|accepted|declined|executed] [--peer <好友名>]
nyra peer proposal show <提议 id>
nyra peer proposal accept <提议 id> --yes
nyra peer proposal decline <提议 id> --yes
```

例外：隔离分支内的文件写操作不进提议门——见下节。写文件类操作被
`workspaceWritePath` 物理限制在工作目录内，而外来子任务的工作目录
就是隔离 worktree，写不出去；`shell`、发邮件、改记忆仍进提议门。

## 外来 agent 先在隔离分支干活（缺口 G-P1-8，第 2 批）

外来好友机器人派来的任务，不直接在主工作区干活：先在隔离分支
`nyra/foreign/<任务 id>` 上跑，改动留在分支上，机主看过再决定合不合入。

```sh
nyra peer branch list
nyra peer branch merge <任务 id> --yes
nyra peer branch drop <任务 id> --yes
```

- 委派时 `delegate` 带 `foreign: true`（或隔离方式本身就是 worktree 时
  由外来任务强制改成 worktree）；工作目录不是 git 仓库时直接拒绝，
  不退化成主工作区直写。
- 跑完有改动：改动清单记进分支账本，交回文本写合入 / 丢弃命令，
  不自动合入。合入是 `git merge --no-ff`，冲突时自动 abort、分支保持
  open，机主手动解决。
- 没改动、取消、失败时：worktree 与分支一并删掉、账本标 dropped，
  改动不进主工作区。
