# 连接器目录与授权框架（缺口 44 第 0 批 + 第一批）

用户 2026-11-20 拍板：Bot Phase 3 做完先做这一批。对应总报告里的缺口 44
（原生业务连接器目录，先决缺口 6 已落地）与 AgentKit 调研报告里值得学的
两点：连接器目录模式、每应用一次批准 + 每用户一次授权的授权状态机。

## 连接器目录

目录里先有 3 个连接器（缺口 44 定义：先接 3 个做深，不拼数量）：

| 连接器 | 状态 | 说明 |
|---|---|---|
| Gmail | 已接入 | 读信、按 thread 回复、代发草稿（缺口 6 已落地）；附件下载、标签、标已读、进回收站（缺口 44 第三批） |
| Shopify | 已接入（只读） | 用户自己的 Hollow & Scale 店铺：查商品、订单、库存（缺口 44 第一批，只读起步） |
| Slack | 已接入 | 团队消息与审批卡的落点：读频道/消息、发消息（须显式批准）、发审批卡（缺口 44 第二批） |

试点连接器在目录里看得见、用不了，不假装已接通。本批之后目录里暂无试点连接器。

### 安装 / 卸载（缺口 44 第一批）

目录是“用户装了哪些连接器”的账本（`~/.nyra/connector-directory.json`，0600、
原子写，损坏先备份再抛错），不是声明本身：声明在代码里，是代码；目录记的是
用户自己的安装动作（装了哪个、什么时候装的、谁装的）。

- **安装**：`nyra connector install <连接器>`。只装声明里有的连接器；试点装不了；
  重复安装是幂等的（不重复记审计、不改第一次的安装时间）。安装本身不发凭证——
  凭证走各连接器自己的授权流程（见下“一键连接”）。
- **卸载**：`nyra connector uninstall <连接器> [--yes]`。从目录里拿掉 + 同时撤销
  授权（`markConnectorRevoked`），访问立即断，不等下次启动；用量历史保留
  （审计与用量账本是历史，不跟着删）。没装的卸载不了——先装后卸，报错比静默
  成功更不容易误操作。

安装与卸载各记一条审计（`installed` / `uninstalled`）与一条运行事件
（`connector_installed` / `connector_uninstalled`，只记连接器与用户）。

## 统一授权入口（一键连接，缺口 44 第一批）

`nyra connector auth <连接器>`：普通用户一键连接业务系统（OAuth 登录即用）。
这里只做路由，不另起一套 OAuth——具体流程复用各连接器自己的授权实现：
Gmail 走 loopback 回调（`nyra gmail auth` 同款）、Shopify 粘贴自定义应用的
Admin API access token、Slack 粘贴 Bot token。授权成功后自动在状态机里记
“已授权”，凭证只存密码箱（见下“令牌存放”），token 原文绝不进账本、审计与事件。

## 用量（缺口 44 第一批）

`nyra connector usage [连接器]`：每个连接器的调用次数（总次数、分操作次数、
最后调用时间），存在 `~/.nyra/connector-usage.json`（0600、原子写）。

调用计数是派生数据——审计 `connector-audit.jsonl` 才是事实源：三个客户端
（Gmail / Shopify / Slack）每次真实调用都在各自的 `audit()` 里记一行审计，
同时调 `recordConnectorCall` 把计数写进用量账本、把 `connector_call` 事件
写进运行记录（有 runId 时进该运行的 events.jsonl，没 runId 时走证据文件回落）。
事件里只记操作名、条数、耗时，不记 token、不记响应内容、不记客户信息。
用量账本损坏时先备份再从空开始（不抛错、不拦调用）。

## 权限声明格式

每个连接器上架时必须声明四件套（声明在 `src/connectors/registry.ts`
的 `CONNECTOR_DECLARATIONS` 里，是代码，不是散文）：

1. **读/写范围**：OAuth scope 或能力描述，分读、写两列。
2. **工具组**：它提供的工具名 + 每个工具是只读还是可写。
3. **会访问的数据**：给用户看的 plain 描述（不是 scope 原文）。
4. **永远须人批 / 永远禁做**：哪些写操作永远须人批、哪些永远禁做
   （引用缺口 51 红线表；本批先写连接器自己的禁做清单）。

批准时用户看得到这份声明，不是点了同意才知道。**声明缺失的连接器默认
只读、且每次使用都要重新确认（fail-closed）**——`effectivePermissions`
对没声明的连接器一律返回只读 + 每次确认。

## 授权状态机

四态：**未授权 → 已授权 → 已过期 / 已撤销**。

```
未授权 ──显式批准一次──▶ 已授权 ──refresh 失败──▶ 已过期
   ▲                        │  ▲
   │                        │  └──── 重新授权 ──────┘
   └──── 重新授权 ──────────┴── 撤销 ──▶ 已撤销 ── 重新授权 ──▶ 已授权
```

- **每应用一次批准**：首次使用某连接器须用户显式批准一次（`nyra connector
  approve <连接器>`，或走该连接器自己的授权流程如 `nyra gmail auth`），
  之后同应用同用户不再重复问。
- **每用户一次授权**：授权按用户隔离（复用缺口 41 的账号体系：本机当前
  会话的 account_id；没登录时记在 `local` 名下）。
- **过期自动标记**：refresh token 失效（坏了/被撤销）时，下一次调用直接
  报“授权已过期，请重新授权”，不再拿死掉的 refresh token 反复试。
  注意：Gmail 的 `expires_at` 是 access_token 的过期时刻（约 1 小时），
  不是授权的过期——access token 过期靠 refresh 自动换，不代表授权失效。
- **撤销立即失效**：状态一写“已撤销”，之后每次调用都直接拒绝，不等下次
  启动才失效；Gmail 撤销时同时吊销远端 token、删除本地 token、关闭连接器。

状态账本在 `~/.nyra/connector-auth.json`（0600、原子写）；审计在
`~/.nyra/connector-audit.jsonl`（只记动作、连接器、用户、token 指纹与
原因，不记邮箱、不记 token）；授权/过期/撤销三件事另记运行事件
`connector_authorized` / `connector_expired` / `connector_revoked`
（已注册进 `EVENT_FIELDS`）。

### 已有授权的迁移

本批落地前已经跑过 `nyra gmail auth` 的用户不打断：第一次调用
`createGmailTransport` 时，密码箱里已有凭证但状态账本还没记录的，沿用
已有授权迁移为“已授权”（迁移记进审计，`migratedFrom: "existing-credentials"`）。

## 令牌存放（硬边界）

**只走本地密码箱**（nyra vault / `~/.nyra/keys.json`，0600），绝不建任何
第三方托管 vault、不把令牌发到任何外部服务——这是 AgentKit 调研里明确
不学的点。状态机只存 token 指纹（SHA-256 前 12 位），token 本身绝不进
状态文件、审计与事件。

## CLI

```
nyra connector list                              列出全部连接器与授权状态
nyra connector status [连接器]                   查看一个/全部连接器的授权状态与权限声明
nyra connector approve <连接器>                  显式批准一次
nyra connector revoke <连接器> [--yes]           撤销授权（立即失效）
nyra connector auth <连接器>                     一键连接：走该连接器自己的授权流程（OAuth 登录即用）
nyra connector install <连接器>                  安装到目录：把连接器登记进你的目录（只装声明里有的；试点装不了）
nyra connector uninstall <连接器> [--yes]        从目录卸载：同时撤销授权，访问立即断
nyra connector usage [连接器]                    用量：每个连接器的调用次数（总次数、分操作次数、最后调用时间）
nyra connector flows                             列出全部业务流程（每条一条真实业务流程 + 验收标准）
nyra connector flow <流程id> [参数]              跑一条业务流程（见“业务流程（G-P0-6）”一节）
nyra connector bundle <连接器> [--out <目录>]    导出连接器包（四件套：权限声明 + 工具清单 + 业务流程 + 红线表，机器人市场验证用）
```

`nyra gmail status` 也会多一行授权状态；`nyra gmail auth` 成功后自动在
状态机里记“已授权”，`nyra gmail revoke` 后自动记“已撤销”。`nyra slack
status` 同款（多一行授权状态）；`nyra slack auth` 成功后自动在状态机里
记“已授权”，`nyra connector revoke slack` 后自动记“已撤销”并删本地凭证。

## 模型工具（缺口 44 深化）

声明里的工具现在模型真能调了（以前 Shopify / Slack 的工具只存在于声明里）：

| 工具 | 作用 | 审批 |
|---|---|---|
| `shopify_products` | 列商品（只读） | 不用批 |
| `shopify_orders` | 按订单号直查 / 列订单（只读） | 不用批 |
| `shopify_inventory` | 查库存水平（只读） | 不用批 |
| `slack_channels` | 列频道（只读） | 不用批 |
| `slack_history` | 读频道消息（只读，输出包在不可信标记里） | 不用批 |
| `slack_send` | 发消息到频道 | 与 `gmail_send` 同级审批（永远须人批） |

Shopify 写工具一个不加：模型工具表里没有改价、改库存、退款、删单的入口。
发消息的审批卡仍只走 CLI（`nyra slack card`），不给模型。

**立即撤销**：撤销连接器授权后，Bot 立即失去访问，不等下次启动。工具层
每次调用都现建客户端、现查授权账本，没有内存缓存——`nyra connector
revoke shopify` 之后，下一条 `shopify_products` 调用直接被拒。

**调用账本**：每次调用都记进运行记录（`connector_call` 事件）：调了哪个
系统、哪个操作、读/写了什么、谁调的（`user_id`）。没 runId 时走证据文件
（`evidence/connector/`），用量账本（`connector-usage.json`）只记次数。

## 连接器包（缺口 44 深化，四件套）

一个连接器 = 四件套，打包进机器人市场的验证信封：

1. **权限声明**：能读什么、能写什么、哪些写操作永远须人批、哪些永远禁做
   （直接引用缺口 51 红线表）；
2. **工具清单**：模型工具 + 只走终端的工具（贴标签、标已读、进回收站、
   发审批卡这些没有模型工具的，只走 `nyra gmail` / `nyra slack` 命令）；
3. **业务流程**：见“业务流程（G-P0-6）”一节，每条带验收标准；
4. **红线表**：默认红线表（缺口 51），写操作必须落在“永远须人批”或
   “永远禁做”档，只读工具必须落在“自由做”档，否则打包拒绝。

导出：`nyra connector bundle <连接器> [--out <目录>]`，写出 6 个文件
（`connector.json` / `tools.json` / `flows.json` / `redlines.json` /
`permission-statement.txt` / `market-entry.json`），导出记录进证据链。
打包校验是 fail-closed：声明缺失、红线表缺失、流程缺失或验收为空、工具
组里有未知工具、写工具没落到非自由档，任一成立就拒绝打包。

市场侧（见 `docs/marketplace.md`）：kind `connector` 只验证、不安装——
内置连接器已在代码里，包里的四件套没有地方可以“装”进去；第三方连接器
安装是下一批（须先有第三方声明注册表）。

## 接线点

状态检查只接在 `createGmailTransport` 里——所有真实的 Gmail 调用（Agent
工具、CLI、事件触发轮询）都走它，检查一处就全拦住了；假 transport 注入
（测试用）不走状态检查。Gmail 功能本身一字不改：读仍只读、发仍走审批。

## Shopify（只读起步，缺口 44 第一批）

### 凭证：自定义应用 token，不走 OAuth

Shopify 的 OAuth 授权码流程要一个公网回调地址，Nyra 跑在本机 localhost
上没有，所以本批用**自定义应用的 Admin API access token**：

1. Shopify 后台 → 设置 → 应用 → 开发自定义应用 → 建一个应用；
2. 只勾三个读权限：`read_products`、`read_orders`、`read_inventory`（多了不要）；
3. 安装应用，复制 **Admin API access token**（`shpat_…` 开头）；
4. 运行 `nyra shopify auth`，粘贴店铺域名与 token（只存密码箱，不进配置文件）。

授权时会先拿 `shop.json` 探一下：401 说明 token 不对或读权限没给，不存；
网络不通时先存下、下次调用再验。授权成功自动启用连接器，并在状态机里记
“已授权”（之后同应用同用户不再重复问）。

### 只读工具

| 命令 | 作用 |
|---|---|
| `nyra shopify products [--limit N] [--page-info X]` | 列出商品（默认 50 条一页，上限 250） |
| `nyra shopify product <id>` | 查一个商品 |
| `nyra shopify orders [--limit N] [--status any\|open\|closed\|cancelled\|archived] [--page-info X]` | 列出订单（默认全部状态） |
| `nyra shopify order <id>` | 查一个订单 |
| `nyra shopify fulfill <id>` | 订单履约核查：订单详情 + 行项目 + 库存逐项核对（只读，不改订单、不动库存） |
| `nyra shopify inventory [--location-id N] [--inventory-item-id N] [--limit N] [--page-info X]` | 查库存水平（按地点 / 商品过滤） |
| `nyra shopify status` | 查看状态（是否启用、是否已授权、店铺域名） |

订单输出**不含客户邮箱与地址**（`customer` 对象整个不解析）；每次调用
记一行审计（`connector-audit.jsonl`，`action: "call"`），只记操作名、
记录数、耗时，不记 token、不记响应内容、不记客户信息。

### 订单履约核查（G-P0-6 做深，只读）

```
nyra shopify fulfill <id>
```

查一个订单能不能发货：先读订单详情（含行项目），再按库存项 id 查库存
水平，逐项核对“可售 ≥ 要发”，出四档结论之一：

- `fulfillable`：每项库存都够，可以发货；
- `short`：有项缺货（或无法核查），现在发不了，缺几件写清楚；
- `already-fulfilled`：订单已发货，无需再核；
- `cancelled`：订单已取消（看 `cancelled_at`，不是发货状态），不发货。

无法核查按缺货算（fail-closed）：行项目没有 `inventory_item_id`、或库存
接口没返回该项，记“无法核查”，不静默跳过。结论只读判断——不改订单状
态、不动库存、不下单；退出码：可以发货 / 已发货为 0，缺货 / 已取消为 1。

### 写操作一律拒绝

本批不提供任何写入口：改价、改库存、下单、退款、发折扣码、删单一律在调
API 之前就拒绝（`shopifyWriteRefusal`，CLI 上撞见 `set-price` /
`update-inventory` / `refund` 等词也直接回一句明确拒绝）。写操作是以后
的一批，到时也要先过审批与红线表（缺口 51）。

### 撤销的诚实说明

`nyra connector revoke shopify` 只删本地凭证：自定义应用的 token **没有
远端吊销接口**，想彻底作废 token 必须去 Shopify 后台删除该自定义应用
（撤销时会明确提示这一点）。401（token 被删/被轮换/权限被收回）时自动标
“已过期”，下次调用直接报“请重新授权”。

## Slack（读 + 发消息须批 + 审批卡，缺口 44 第二批）

### 凭证：Bot token，不走 OAuth

Slack 的 OAuth 授权码流程要一个公网回调地址，Nyra 跑在本机 localhost
上没有，所以本批用 **app 的 Bot token**：

1. Slack 后台建一个 app（或打开已有 app）→ OAuth & Permissions；
2. 勾三个 scope：`channels:read`、`channels:history`、`chat:write`（多了不要）；
3. Install to Workspace，复制 **Bot User OAuth Token**（`xoxb_…` 开头）；
4. 运行 `nyra slack auth`，粘贴 workspace 名（可选）与 token（只存密码箱，不进配置文件）。

授权时会先拿 `auth.test` 探一下：`invalid_auth` 说明 token 不对，不存；
网络不通时先存下、下次调用再验。授权成功自动启用连接器，并在状态机里记
“已授权”（之后同应用同用户不再重复问）。

### 读工具

| 命令 | 作用 |
|---|---|
| `nyra slack channels [--limit N] [--cursor X]` | 列出频道（默认 50 条一页，上限 250；翻页走 `response_metadata.next_cursor`） |
| `nyra slack history --channel <id> [--limit N] [--cursor X]` | 读某频道的消息历史（默认 50 条一页，上限 250） |
| `nyra slack status` | 查看状态（是否启用、是否已授权、workspace） |

每次调用记一行审计（`connector-audit.jsonl`，`action: "call"`），只记操作名、
记录数、耗时，不记 token、不记消息内容。

### 发消息：本批唯一的写操作，须显式批准

```
nyra slack send --channel <id> --text <内容> [--yes]
```

没给 `--yes` 时会交互问一句“确认发送到频道 …？”，答 y 才发；不答、答 n
或在非交互环境下没给 `--yes`，一律拒绝、不发。声明里“发消息”列在“永远须
人批”，调用层（`postMessage`）本身不管批——批的动作在 CLI 这一层，审计里
以 `reason: "explicit-approval"` 留痕。注意：独立审查层（缺口 10 的模型复核）
本批没有接进 `nyra slack send`，批的动作就是人这一下确认（--yes 或交互
确认），不是模型复核；接审查层是以后的一批。

### 审批卡：把挂起审批发到频道

```
nyra slack card --channel <id> --approval <id>
```

从 Bot Phase 2 的挂起审批账本（`bot-approvals.json`）里读一条挂起审批，
拼成 Block Kit 消息发到指定频道：一段说明（工具、说明、参数指纹、申请人、
有效期）+ 两个按钮（批准 / 拒绝，value 只带审批 id 与结论，不带 token、
不带参数原文）。账本没有、损坏、找不到这条、已处理、已过期都直接报错、
不发卡。

**按钮回调回写审批桥（G-P0-6 做深）**：Slack 把按钮点击以交互请求发回
来时，`resolveSlackApprovalCallback` 解析出结论（批准/拒绝 + 审批 id），
调审批桥 `decide`（via `"button"`，档位 `once`），再记一行解决审计
（`operation: "approval_callback_resolved"`）。只认 owner/admin 白名单
（不在白名单的决定人报 `not-approver`，审批仍挂起）；找不到审批报
`not-found`；已处理过的审批报 `not-pending`，重复回调不重复解决（幂等）。
CLI 入口：`nyra slack callback --payload <json> [--by <用户id>]`（`--by`
省略时取配置的 `bot.owner`，没配就报用法错）；真正的 Socket Mode / Events
接线调用同一个 resolver，网关接线是下一步，不在本批假装接通。`handleApprovalCallback`
仍只做“收到并记审计”，两处审计各记各的——“收到回调”和“审批已解决”
是两行，不混成一行。

### 写操作管控

删消息、改频道、管理成员一律拒绝（`refuseSlackWrite`，CLI 上撞见
`delete-message` / `update-channel` / `invite` 等词也直接回一句明确拒
绝，本批连写入口都不提供）。

### 撤销的诚实说明

`nyra connector revoke slack` 只删本地凭证：Bot token **没有 CLI 可调的
远端吊销接口**，想彻底作废 token 必须去 Slack 后台撤销该 app 的 Bot token
（撤销时会明确提示这一点）。`invalid_auth`（token 被撤销/被轮换）时自动标
“已过期”，下次调用直接报“请重新授权”。

## Gmail 深化（附件 + 标签 + 已读 + 回收站，缺口 44 第三批）

缺口 6 只做了最小闭环（读信、按 thread 回复、代发草稿），明确不处理附件、
标签、删除、已读；本批把这四件补上。OAuth 接线同时收尾：`gmail.ts` 里
自写的授权码流程与 `oauth.ts` 的通用流程合并，只合 Gmail 这一路——
`nyra gmail auth` 与 `nyra connector approve gmail` 走同一条路，行为不变
（授权 URL 参数顺序、回环回调文案、超时提示一字不差；网关接线与多用户
权限模型仍是以后的一批）。

### 附件只读下载

```
nyra gmail attachment <messageId> <attachmentId> [--out <路径>]
```

先读邮件全文找到附件所在的 part（文件名与 mime 类型都在 part 上），再调
`attachments.get` 取原始字节；下载先落临时目录（`mkdtemp`、0600）校验，
处理完即删、不落盘。口径与 Bot Phase 3 的 `src/bot/attachments.ts` 是
同一套（复用其白名单与截断口径，不另起一套）：

- 单个附件超 **10MB** 直接拒绝并明说上限；
- 图片只记元信息（类型、大小），本批不看图（Agent.run 只接受字符串，
  视觉模型没接）；
- 文本文档（`.txt/.md/.json` 等与 `text/*`）提取内容，超 8000 字截断并注明；
- 其他类型（PDF、Office、可执行文件等）拒绝解析，可执行文件一律不碰；
  `--out <路径>` 可把原始字节原样保存（0600），默认不保存、只打印说明与
  提取文本。

### 标签与已读：写操作，须显式确认

```
nyra gmail labels                        # 只读：列出标签
nyra gmail label <id> <标签id> [--yes]   # 加标签
nyra gmail unlabel <id> <标签id> [--yes] # 去标签
nyra gmail mark-read <id> [--yes]        # 标已读（去掉 UNREAD 标签）
nyra gmail mark-unread <id> [--yes]      # 标未读（加上 UNREAD 标签）
```

没给 `--yes` 时交互问一句“确认给邮件 …？”（`[y/N]`，默认不改）；答非 y
一律取消、不改。注意：`nyra gmail read <id>` 仍是读一封邮件全文，已读/
未读改用 `mark-read` / `mark-unread`（`read` 这个词已被占用）。

### 草稿列表与发送草稿（G-P0-6 做深）

```
nyra gmail drafts                      # 只读：列出草稿（id 与邮件 id）
nyra gmail send-draft <草稿id> [--yes] # 发一封草稿（写操作，须显式确认并过红线）
```

`drafts` 只列草稿 id 与邮件 id——主题与收件人要发之前再取（`send-draft`
先读草稿详情，确认时把收件人、主题、摘要展示给用户看，答 y 才发）。
草稿不完整（收件人或主题为空）不发。发草稿与 `send` 同款门：须显式批准
（`--yes` 或交互确认），且过缺口 51 红线（收紧到永远禁做时即使已批准也
拒绝）；发完写发送证据（`gmail_send`，只记收件人、主题、草稿 id、邮件 id，
正文发送前未读取、证据里明说这一点，不编一个空正文）。

### 删除：只进回收站，永久删除不提供

```
nyra gmail trash <id> [--yes]            # 移进回收站（可恢复）
```

确认口径与上面一样（`--yes` 或交互 y）。`nyra gmail delete` / `purge`
在 CLI 上撞见直接回一句明确拒绝——永久删除是硬红线（缺口 51），本批
连入口都不提供；想彻底删除请去 Gmail 网页端操作。撤销的诚实说明与之前
一样：`nyra gmail revoke` 只删本地凭证，彻底作废须去 Google 账号页。

### 权限声明与审计

Registry 里 Gmail 的声明已补全：读 scope（`gmail.readonly`）与写 scope
（`gmail.send`、`gmail.compose`、`gmail.modify`）分开列；新增四个能力
（读附件、改标签、改已读、进回收站）；永远须人批：改标签、改已读、
进回收站；永远禁做：永久删除、转发给外部、改他人标签。

每次调用记一行审计（`connector-audit.jsonl`，`action: "call"`），只记
操作名、记录数、耗时，不记 token、不记邮件内容、不记附件内容。

## 业务流程（G-P0-6 做深）

报告 G-P0-6 的要求：“别拼数量，按缺口 44 已有的队形做深——每个接进来
的系统都要能跑通一条真实业务流程并有验收标准。”所以本批不加新连接器，
只给已有的三家各补一条端到端流程，每条带验收检查（跑完出“通过 / 不通过”
的结论，不只打印一堆数据）：

| 流程 id | 连接器 | 跑通的业务 | 验收检查 |
|---|---|---|---|
| `slack-approval-roundtrip` | Slack | 审批卡闭环：按钮回调回写审批桥 | `callback-parsed`、`approver-allowed`、`approval-resolved` |
| `shopify-order-fulfillment` | Shopify | 订单履约核查：订单详情 + 行项目 + 库存逐项核对 | `order-found`、`order-not-cancelled`、`items-covered` |
| `gmail-draft-send` | Gmail | 草稿闭环：列草稿、读草稿、发草稿 | `draft-found`、`draft-complete`、`draft-sent` |

```\nnyra connector flows                             # 列出全部业务流程\nnyra connector flow <流程id> [参数] [--json]     # 跑一条流程，退出码：通过 0、不通过 1、用法错 2\nnyra connector flow slack-approval-roundtrip --payload <json> [--by <用户id>]\nnyra connector flow shopify-order-fulfillment --order <id>\nnyra connector flow gmail-draft-send --draft <id> [--yes]\n```\n\n运行器（`src/connectors/flows.ts` 的 `runConnectorFlow`）只做三件事：
按 id 找流程、跑它、把结论记进审计（`operation: "flow:<流程 id>"`）+
用量（`recordConnectorCall`）+ 证据文件（`evidence/connector/` 下的
`connector_flow` 报告）。验收检查是流程自己评的，运行器不替流程编结论；
流程里抛出的前置错误（缺参数、没批准、没桥）也收成“不通过”的结论返回，
只有未知的流程 id 才抛错。事件复用已有的 `connector_call`，不新增事件
类型；模型工具不新增，流程只走 CLI + 库函数。\n\n发草稿那条仍是写操作：`nyra connector flow gmail-draft-send` 先读草稿
展示收件人/主题给用户确认（`--yes` 跳过），确认后才跑流程；流程内再过
一次缺口 51 红线。Slack 那条要审批桥：CLI 按本机配置建（`bot.owner`），
网关传运行中 BotRunner 的桥——模块不自己建桥，免得两处各建一个桥、各读
一份账本。\n\n## 已知局限（诚实边界）

- 真实 Gmail OAuth 授权未在真应用上跑通，只在假 vault / 假 OAuth 上验过。
- 真实 Shopify 店铺未接通，只在假 API 上验过；自定义应用 token 的授权流程未在真店上跑通。
- 真实 Slack workspace 未接通，只在假 API 上验过；Bot token 的授权流程未在真 workspace 上跑通；审批卡按钮回调回写审批桥已在假审批桥 + 假回调上验过，真实 Socket Mode / Events 接线还没接（网关接线是下一步）。
- Gmail 深化已落地（附件只读下载、标签、标已读、进回收站）；Shopify 写操作是以后的一批。
- G-P0-6 三条业务流程只在假 API / 假审批桥上验过：Slack 回调回写没走过真实 Socket Mode，Shopify 履约核查没对过真实店铺的订单与库存，Gmail 草稿发送没在真实 Gmail 账号上发过（真机 Gmail 授权仍卡在 Google 同意页提交转圈，本批没再试）。
- 过期只在 refresh 失败时标记：access token 正常过期不标（它会被自动刷新）。
- 授权状态按本机当前会话的 account_id 隔离；网关多用户权限模型是缺口 41
  的下一批，本批不碰。
