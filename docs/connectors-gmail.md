# 原生应用连接器：Gmail（缺口 6，第一批）

缺口 6 的第一批只做 Gmail 的最小可用闭环：授权、读邮件、按 thread 回复、代发草稿。
Slack / WhatsApp 等后续按同一模式扩展（同一目录 `src/connectors/`、同一批
凭证与审批口径）；应用事件源（缺口 7）与邮件即任务入口（缺口 22）是下一批。

## 启用：三步

1. **准备 OAuth 客户端**（Google Cloud Console）：
   - 建一个 **Desktop app** 类型的 OAuth 2.0 客户端，拿到 `client_id` 与 `client_secret`。
   - 回调地址用回环地址：`http://127.0.0.1`（任意端口，Nyra 授权时现场起一个
     临时回调服务器，端口随机；Desktop app 类型允许回环回调，不用在 Google
     那边逐个登记端口）。
   - 测试模式（Testing）下只有加进测试用户名单的账号能授权；要给别人用先点
     Publish App。自己的账号直接授权即可。
2. **授权**：`nyra gmail auth`。
   - 先解锁密码箱（没有先跑 `nyra vault init`）。
   - `client_id` / `client_secret` 交互输入，只存密码箱（条目 `gmail-oauth-client`），
     绝不写命令行、不进配置文件。
   - 终端打印授权链接，在浏览器里打开、选账号、点同意；Google 把授权码送回
     本机回环回调（5 分钟超时，state 校验防 CSRF）。
   - 换到 token 后存密码箱（条目 `gmail-oauth`），同时自动把连接器启用
     （`config.json` 的 `connectors.gmail.enabled: true`）。
3. **确认状态**：`nyra gmail status`——启用与否、授权与否、账号邮箱（密码箱
   未解锁时看不到账号邮箱，只显示“已授权”）。

吊销：`nyra gmail revoke`（先尽力在 Google 侧吊销 refresh token，再删本地
token、关闭连接器）。

## 申请的 scope

- `gmail.readonly`（读邮件）、`gmail.send`（发邮件）、`gmail.compose`（建草稿）、`gmail.modify`（改标签、标已读、进回收站；缺口 44 第三批新增）。
- 只读用户授权的范围；不申请整邮箱权限（`mail.google.com` 全量 scope 不用）。

## 凭证放在哪

| 东西 | 放在哪 |
|---|---|
| `client_id` / `client_secret` | 密码箱条目 `gmail-oauth-client` |
| `access_token` / `refresh_token` / `expires_at` / 账号邮箱 | 密码箱条目 `gmail-oauth` |
| 开关 `connectors.gmail.enabled` | `config.json`（默认 `false`，显式 opt-in）|

配置文件里永远不放任何凭证；日志与证据里也不写 token（证据只记发了什么、
谁批准的）。`access_token` 过期前 60 秒或收到 401 时自动用 refresh token
换一次、重试一次；刷新失败即报“授权失效，请重新运行 `nyra gmail auth`”，
不静默降级。刷新后新 token 尽量写回密码箱：只有 `NYRA_VAULT_PASSWORD` 在时
才能解锁写回；写不进去也不破坏本次运行（内存里的新 token 照常用，下次
运行再刷新一次即可，refresh token 本身不变）。

## 终端命令

```
nyra gmail status                              状态（启用/授权/账号）
nyra gmail auth                                浏览器授权（回环回调）
nyra gmail search <查询> [--limit N]           按 Gmail 搜索语法找邮件（默认 10 封，最多 25）
nyra gmail read <id>                           读一封邮件全文
nyra gmail send --to <邮箱> --subject <主题> --body <正文>
nyra gmail drafts                              列出草稿（只读；G-P0-6 做深）
nyra gmail send-draft <草稿id> [--yes]         发一封草稿（写操作，须显式确认并过红线；草稿不完整不发，详见 docs/connectors.md）
                [--cc <邮箱>] [--bcc <邮箱>] [--thread <id>] [--draft] [--yes]
                                               发一封（默认先展示确认；--draft 只存草稿）
nyra gmail labels                              列出标签（只读）
nyra gmail label <id> <标签id> [--yes]         给邮件加标签（写操作，须显式确认）
nyra gmail unlabel <id> <标签id> [--yes]       给邮件去标签（写操作，须显式确认）
nyra gmail mark-read <id> [--yes]              标已读（写操作，须显式确认；read 仍是读全文）
nyra gmail mark-unread <id> [--yes]            标未读（写操作，须显式确认）
nyra gmail trash <id> [--yes]                  移进回收站（写操作，须显式确认；永久删除不提供）
nyra gmail attachment <messageId> <attachmentId> [--out <路径>]
                                               下载附件并校验（图片只记元信息、文本文档提取内容）
nyra gmail revoke [--yes]                      吊销授权并删除本地 token
```

搜索用 Gmail 原生语法，如 `from:boss@example.com is:unread`、
`subject:发票 after:2026/1/1`。

附件只读下载（缺口 44 第三批）：先读邮件全文找附件 part，再取原始字节；
下载落临时目录（0600）校验、处理完即删。单个附件超 10MB 拒绝；图片只记
元信息不看图；文本文档提取内容（超 8000 字截断）；PDF/Office/可执行文件
不解析；`--out` 可原样保存（0600）。改标签、标已读、进回收站都是写操作，
没给 `--yes` 时交互问一句 `[y/N]`，答非 y 一律取消。永久删除本批不提供：
`nyra gmail delete` / `purge` 直接拒绝，想彻底删除去 Gmail 网页端。

## 工具（给模型用）

| 工具 | 说明 | 审批 |
|---|---|---|
| `gmail_search` | 按 Gmail 搜索语法找邮件，返回发件人、主题、时间与摘要列表；单次最多 25 封 | 只读，不需审批 |
| `gmail_read` | 按 id 读一封邮件全文 | 只读，不需审批 |
| `gmail_send` | 发一封邮件；`thread_id` 给了就是按 thread 回复；`draft: true` 只存草稿不发送 | 与 `write_file` 同级审批 |

三点硬边界：

- **发必须走现有审批**：`gmail_send` 进了 `MUTATING_TOOLS` 与 `HOOKED_TOOLS`——
  readonly 模式拒绝、auto 非交互拒绝、权限规则 deny 拒绝、PreToolUse 钩子
  可以拦截；full 模式按启动时已授权的口径放行（与 `write_file` 完全一致）。
  连接器本身不绕过审批，也不批量群发：一次调用只发一封。
- **每次代发都附证据**：`~/.nyra/evidence/<会话>/` 里记一条 `gmail_send`
  （收件人、抄送/密送、主题、回复的 thread、批准渠道、正文、发出去的邮件 id），
  与证据链同口径。CLI 的 `nyra gmail send` 同样写证据。
- **邮件是不可信外部数据**：搜索结果与正文都包 `wrapUntrusted` 再交给模型，
  里面的指令性文字一律不执行；正文只读事实信息。`gmail_search` 返回的摘要
  同样包标记——主题行也可以是攻击面。

未启用或未授权时，工具直接返回错误（里面写清下一步该跑 `nyra gmail auth`），
不走到审批那一步。

## 网关

`GET /api/connectors`（需鉴权）：列出连接器状态，供桌面端连接管理页消费——
页面本身在 `desktop/`（Hark）。只返回 id、名字、启用与否、授权与否、账号邮箱
与 scope，不返回任何 token / client_secret。

## 定时任务里发信

定时任务跑在 auto 非交互模式：`gmail_send` 默认会被审批拒绝（与 `write_file`
同款 fail-closed）。想让定时任务代发，必须显式配一条权限规则（`nyra permissions`
里给 `gmail_send` 写 allow 规则），且规则只放行明确的收件人与主题范围——
不要给定时任务开无条件放行。

## 已知局限（本批不做，下一批再说）

- 只做 Gmail：Slack / WhatsApp 等后续按同一模式扩展，不在本批。
- 附件只读下载（缺口 44 第三批已落地）；不发送附件；不永久删除邮件（只进回收站）；不转发给外部、不改他人标签。
- 没有应用事件源（缺口 7：新邮件触发任务）与邮件即任务入口（缺口 22：读到邮件直接建任务），那是下一批。
- Web UI 连接管理页在 `desktop/`，归 Hark；本批只给了网关 `GET /api/connectors` 状态接口。
- 发信不做收件人格式校验：地址写错时 Gmail API 会直接报错，错误原样返回。
- 回环回调只在能打开浏览器的本机上能用；无头服务器上授权要另想办法（下一批评估）。
- 刷新后 token 回写密码箱需要 `NYRA_VAULT_PASSWORD`；没配时只内存生效（见上）。
