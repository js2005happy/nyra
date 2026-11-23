# 用户账号登录（缺口 41）

> 用户 2026-11-20 拍板：每个用户需要用谷歌、GitHub 或邮箱登录。
> 第一批做：账号身份 + 会话模块 + Google OAuth 与 GitHub 设备流两条完整登录链 + 邮箱 magic link 令牌核心。
> 下一批（已完成，2026-11-20 续）做：网关三路鉴权接线 + `GET /api/account` + `POST /api/account/magic-link` 兑换路由 + `nyra account login email` 完整链。详见文末「§12 下一批（已完成）」。

## 1. 现状：登录之前 Nyra 只有三种“身份”，没有“用户”

| 身份 | 在哪 | 是什么 |
|---|---|---|
| 网关 owner token | `src/gateway.ts` 的 `Gateway.token`（随机 24 字节，`nyra ui` 启动时打印） | 一台电脑一个 token，请求头 `X-Nyra-Token`；谁拿到它就是 owner |
| 设备 token | `src/pairing.ts` 的 `DeviceRegistry`（6 位配对码 → 32 字节 token，SHA-256 存盘，180 天不用失效） | 一部手机一个 token，同样走 `X-Nyra-Token`；是设备身份，不是人的身份 |
| 模型方凭证 | 密码箱 `vault.json`（PBKDF2 60 万轮，主密码加密，`src/vault.ts`） | 各家模型 / Gmail 的 key 与 OAuth token；配置文件里绝不放凭证 |

缺的是：**人**。一台电脑被两个人用、一个网关被几台手机连时，Nyra 分不出谁是谁，也没法让每个人用自己的 Google / GitHub / 邮箱登录。本批补的就是这一层。

## 2. 目标与非目标

目标：

- 一个账号 = 一个人（邮箱是主标识），可挂多个登录方式（Google、GitHub、邮箱各一个）。
- 登录后发一张会话 token（只此一次返回原文，磁盘只存 SHA-256），之后凭它证明身份。
- 三种登录方式里至少两条本批端到端跑通（Google、GitHub）；邮箱的令牌核心本批做完，投递端点下一批。
- 所有登录、登出、绑定、撤销都进审计（`~/.nyra/accounts-audit.jsonl`，只记动作与账号 id，不记邮箱、不记 token）。

非目标（本批不做，下一批）：

- 网关接受账号会话 token（`src/gateway.ts` 的 `apiAuth` 改造：owner token / 设备 token / 账号会话三路并存，owner 角色的账号等同 owner，其余账号先只读——权限模型下一批定）。
- 邮箱 magic link 的投递端点（网关 `POST /api/account/magic-link` 兑换路由 + `nyra account login email` 的完整链）。
- 多用户权限模型（角色只有 `owner` / `user` 两个值先占位；`user` 在本批网关接线前没有任何额外能力，不编造）。
- 服务端组件：没有任何 Nyra 中央服务器。托管形态（多用户共用一台 Nyra 服务）需要的“账号目录”只定义接口（见 §7），不假装它已存在。
- 云端连接（第 6 批，见 `docs/mobile-cloud.md` §13）：手机端改走账号登录 + 直连云端服务，客户端一半（地址解析、HTTP 客户端、同步协议、CLI、启动器页）已做；服务端按 API 契约另行实现，真云端未部署。

## 3. 身份模型

账号（`~/.nyra/accounts.json`，0600，原子写，损坏先备份再抛错——身份文件损坏不静默清空，fail-closed）：

```json
{
  "accounts": [
    {
      "id": "9f2c41aa7d0e4b08",
      "email": "user@example.com",
      "name": "张三",
      "role": "owner",
      "providers": [
        { "provider": "google", "sub": "110123456789012345678", "email": "user@example.com", "linked_at": "2026-11-20T06:00:00Z" }
      ],
      "created_at": "2026-11-20T06:00:00Z",
      "last_seen": "2026-11-20T06:00:00Z"
    }
  ]
}
```

规则：

- 第一个创建的账号自动是 `owner`，之后是 `user`（单机场景第一个登录的人就是机主，与“第一个配对的设备就是 owner”的既有口径一致）。
- 同一个邮箱只对应一个账号：Google 邮箱与 GitHub 邮箱相同 → 链到同一个账号（`linkIdentity`，不建第二个）。
- 同一个 provider + sub 只能属于一个账号（已绑到别的账号上 → 拒绝，不静默合并）。
- 账号 id 是 16 位 hex（随机 8 字节）；事件与审计里只出现这个 id，不出现邮箱——`appendEvent` 的 redact 会把 ≥32 字连续词串当疑似密钥掩掉，16 位 hex 安全。
- 邮箱只做大小写归一（转小写、去首尾空白），不做格式之外的猜测；无效邮箱拒绝。
- **账号状态（缺口 43 第二批，SSO/SCIM）**：`status`（`"active" | "suspended"`，老文件没有这个字段按 active 处理）+ `suspended_at` + `external_id`（SCIM 外部标识）；`LinkedIdentity` 加可选 `issuer`（SSO 身份提供方，只有 provider 为 `"sso"` 时有）。停用即失能：改状态 → 撤销该账号全部会话 → 记审计；网关 `accountFromSession` 验过会话后也查一次 status；`upsertAccount` 找到已停用账号时直接抛错（覆盖四条登录链 + link 流程）；恢复只改状态，不恢复已撤销的会话。详见 `docs/sso.md`。

## 4. 会话模型

会话（`~/.nyra/account-sessions.json`，与账号文件同等存储纪律；token 原文只在发的那一刻返回一次）：

- token：32 字节随机，base64url；磁盘只存 SHA-256（与配对 token 同款做法）。
- 校验：`timingSafeEqual` 比哈希；过期（默认 30 天）或 30 天没用过 → 失效并剪掉（配对是 180 天；账号会话更短，因为它能代表一个人，不是一部手机）。
- `last_seen` 滑动刷新（60 秒内不重复写盘，与配对同款节流）。
- 撤销：按会话 id 撤销一条、按账号撤销全部；登出 = 撤销当前会话 + 清掉本机保存的当前 token。
- 本机当前 token 存在 `~/.nyra/account-session.json`（0600，只存 `{ token, account_id, issued_at }`；它是本机的“cookie 罐”，丢了就重新登录，不是什么长期凭证）。

## 5. 三种登录方式

### 5.1 Google（本批端到端）：授权码 + PKCE + 回环回调

与 Gmail 连接器的 OAuth 同款做法（`src/connectors/gmail.ts`），但走独立的通用模块 `src/oauth.ts`（gmail.ts 本批不动，下一批再考虑合并不合）：

1. OAuth 客户端在密码箱条目 `oauth-google-client`（`{client_id, client_secret}`，Desktop app 类型；没有就交互输入，绝不写命令行、绝不进配置文件）。
2. 生成 PKCE：`code_verifier`（43–128 字 base64url）+ S256 `code_challenge`；`state` 16 字节 hex 防 CSRF。
3. 授权 URL：`https://accounts.google.com/o/oauth2/v2/auth`，scope 固定 `openid email profile`（只取身份，不申请 Gmail / Drive 权限——登录不是授权读邮件，别多要权限）。
4. 回环回调服务器只听 `127.0.0.1` 随机端口，5 分钟超时；state 对不上或 `error` 参数直接拒绝。
5. 换 token：`POST https://oauth2.googleapis.com/token`（固定 URL，不接受调用方传入任意 URL），带 `code_verifier`。
6. 取身份：`GET https://openidconnect.googleapis.com/v1/userinfo`，严格解析 `{sub, email, email_verified, name}`；`email_verified` 不是 true → 拒绝（未验证的邮箱不能建账号，fail-closed）；缺字段即报错，不猜、不补默认值。
7. Google 的 access/refresh token **本批不存**：登录只是一次身份证明，Nyra 之后不替用户调 Google API；存了用不上的 token 是多余的攻击面。将来需要时再存密码箱。

### 5.2 GitHub（本批端到端）：设备流

设备流不用回环服务器，SSH 过去也能登（回环在远程终端上打不开浏览器，设备流是 CLI 的正确做法）：

1. OAuth 客户端在密码箱条目 `oauth-github-client`（`{client_id}` 即可，设备流不需要 secret；没有就交互输入）。
2. `POST https://github.com/login/device/code`（`client_id` + `scope=read:user user:email`）→ `device_code` / `user_code` / `verification_uri` / `expires_in` / `interval`。
3. 终端打印 `user_code` 与验证地址，用户在浏览器里输码；按 `interval` 轮询 `POST https://github.com/login/oauth/access_token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`），`authorization_pending` 继续等、`slow_down` 加间隔、`expired_token` / `access_denied` 直接报错。
4. 取身份：`GET https://api.github.com/user`；`email` 为空时再取 `GET https://api.github.com/user/emails`（取 `primary` 且 `verified` 的那条）；没有已验证邮箱 → 拒绝。
5. 端点全部是固定常量；`fetch` 可注入，测试用 stub，不碰真 GitHub。

### 5.3 邮箱 magic link（本批：令牌核心 + 发信接口；投递端点下一批）

令牌（`~/.nyra/magic-links.json`，同等存储纪律）：

- `issue(email)` → 32 字节 token（只此一次返回原文，磁盘只存 SHA-256），15 分钟有效、一次性；`redeem(token)` 校验哈希、过期与已用状态，通过后立即标记已用（重放第二次必失败）。
- 发信走显式接口 `MailSender { send(to, subject, body): Promise<void> }`，不假装 Nyra 有发信服务。本批给一个 `GmailMailSender` 适配器：用已授权的 Gmail 连接器发（没授权就报错“未配置发信方式：先跑 nyra gmail auth”——不静默丢邮件）。
- 链接指向的兑换端点是网关 `POST /api/account/magic-link`，随网关接线在下一批上线；所以本批 CLI 没有 `nyra account login email`（发一条点开就 404 的链接是不诚实的）。令牌核心 + 发信接口 + 测试本批先行，端点一到就接上。

## 6. 存储与审计一览

| 文件 | 内容 | 纪律 |
|---|---|---|
| `~/.nyra/accounts.json` | 账号与已绑身份 | 0600，原子写，损坏先备份再抛错 |
| `~/.nyra/account-sessions.json` | 会话（只存 token 的 SHA-256） | 同上 |
| `~/.nyra/magic-links.json` | magic link 令牌（只存 SHA-256） | 同上 |
| `~/.nyra/account-session.json` | 本机当前会话 token（cookie 罐） | 0600，登出即删 |
| `~/.nyra/accounts-audit.jsonl` | 登录/登出/绑定/撤销审计行 | 只记动作、provider、账号 id、时间；不记邮箱、不记 token |

OAuth 客户端（`oauth-google-client` / `oauth-github-client`）只存密码箱，不进配置文件、不进账号文件（与 Gmail 连接器同款规则）。

Postgres 后端（连接串存在时）：同一份数据进上面 §8 的五张表，不再写这些文件；本机当前会话（`account-session.json`，CLI 的 cookie 罐）仍在本地文件里。

## 7. 服务端接口（不假装它已存在）

托管形态下账号要跨机器同步，本批只定义接口，本地文件实现是它的第一个实现：

```ts
export interface AccountDirectory {
  findByProvider(provider: AccountProvider, sub: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  findById(id: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  create(input: { email: string; name?: string }): Promise<Account>;
  linkIdentity(accountId: string, identity: Omit<LinkedIdentity, "linked_at">): Promise<Account>;
  touchLastSeen(accountId: string): Promise<void>;
}
export interface AccountSessionDirectory {
  issue(accountId: string, ttlSeconds?: number): Promise<{ id: string; token: string; expires_at: string }>;
  verify(token: string): Promise<{ account_id: string; session_id: string } | null>;
  listSessions(accountId: string): Promise<Omit<AccountSession, "token_sha256">[]>;
  revoke(sessionId: string): Promise<boolean>;
  revokeAllForAccount(accountId: string): Promise<number>;
}
export interface MagicLinkDirectory {
  issue(email: string, ttlSeconds?: number): Promise<{ id: string; token: string; expires_at: string }>;
  redeem(token: string): Promise<string | null>;
}
```

`AccountStore` / `AccountSessionStore` / `MagicLinkStore` 实现这三个接口；Postgres 实现（`PostgresAccountStore` / `PostgresAccountSessionStore` / `PostgresMagicLinkStore`，见 §8）是第二个实现。登录流程（`loginWithGoogle` / `loginWithGithub` / `loginWithMagicLink` / `upsertAccount` / `getCurrentAccount`）接受可选的 `stores?: AccountsStores` 注入，不传就用本地文件实现。`src/accounts.ts` 里不出现任何指向不存在的服务端的 URL 或默认端点。

## 8. Postgres 后端（控制面数据进库，Neon 起步）

用户 2026-11-20 拍板：客户数据库先用 Neon 免费档起步（Postgres，新加坡，$0，开发/测试库）；以后上线迁阿里云 RDS PG Serverless 时走 pg_dump / pg_restore。Neon 项目还没开（需要用户的 Neon 账号），所以本批先做到“接上连接串就能跑”，不因为没库停下。

### 表结构（v2，`src/accountsDb.ts` 的 `ACCOUNTS_SCHEMA_STATEMENTS`）

| 表 | 内容 | 备注 |
|---|---|---|
| `accounts` | 账号（id、邮箱、名字、角色、创建/最后出现时间） | 邮箱唯一按小写比；机主只能有一个（部分唯一索引） |
| `account_identities` | 已绑身份（账号 id、provider、sub、邮箱、名字） | 主键 (provider, sub)；每账号每 provider 一个 |
| `account_sessions` | 会话（只存 token 的 SHA-256） | 与文件版同款 TTL/失活规则 |
| `magic_links` | magic link 令牌（只存 SHA-256） | 兑换一条 UPDATE 原子认领 |
| `account_audit` | 审计行 | 只记动作、provider、账号 id；不记邮箱、不记 token |
| `schema_migrations` | 已应用的表结构版本 | 当前 v2 |

v2（缺口 43 第二批，SSO/SCIM）：`accounts` 加 `status`（`'active' | 'suspended'`，默认 active）/ `suspended_at` / `external_id`（SCIM 外部标识），`account_identities` 加 `issuer`（SSO 身份提供方）；迁移语句全部 `ADD COLUMN IF NOT EXISTS`，老库直接跑。详见 `docs/sso.md`。

迁移友好（为 pg_dump / pg_restore 留的）：只用最标准的 Postgres 类型（text / timestamptz），不用任何扩展（不用 citext、不用 pgcrypto），id 全部由应用层生成（不依赖序列），建表语句全部幂等（`IF NOT EXISTS` + 版本行 `ON CONFLICT DO NOTHING`）。

### 连接串来源（按优先级，绝不硬编码）

1. 环境变量 `NYRA_DATABASE_URL`（托管/服务形态的标准做法，首选）；
2. `config.json` 的 `database.url`（用户明确要求支持配置来源；注意连接串里含密码，放配置文件等于把密码放明文文件里，首选仍是环境变量）；
3. 密码箱条目 `database-url`（`NYRA_VAULT_PASSWORD` 解锁时才读得到，盘上最安全的放法；读不到就静默跳过）。

三处都没有 → 本地文件后端（默认行为不变）。`resolveDatabaseUrl` / `resolveAccountsBackend`（`src/accountsDb.ts`）。

### 接线现状

- CLI：`nyra account …` 在连接串存在时自动改走 Postgres（每次先跑一遍建表，空库第一次就建好），退出前关连接；连接串配错了（连不上、库不存在）明确报错退出码 1，不挂起。`nyra account --help` 里写明了这条规则。
- 驱动：Bun 自带的 SQL 客户端（`Bun.sql`，全局就有，不用再装 `pg` 驱动）；SQL 文本里只用 `$1、$2…` 占位、参数单独传，值绝不拼进 SQL 文本。
- 网关接线在下一批（`apiAuth` 认账号会话 token 时，网关侧同样用这组 Postgres 存储）。

### 与文件版行为不同的两处（有意为之）

- 机主抢位：两个进程同时首登时，后到的 `INSERT` 会撞机主唯一索引（23505），自动重试为普通用户；文件版是读-改-写，没有这层保护。
- magic link 兑换的过期判断用库时间（`expires_at > now()` 写在 UPDATE 里，原子认领）；文件版用注入的时钟。托管时库时间才是准的。

## 9. 安全边界（fail-closed 清单）

- 未验证的邮箱不能建账号（Google `email_verified`、GitHub `verified` 都必须为真）。
- state 对不上、PKCE 对不上、magic link 过期或已用 → 拒绝，不重试、不降级。
- 账号/会话/magic link 文件损坏 → 备份后抛错，不静默清空重建（清空等于把机主身份抹掉）。
- token 原文只在签发那一刻返回一次；磁盘、日志、审计、事件里永远只有 SHA-256 或账号 id。
- OAuth 端点全部是代码里的固定常量；`fetch` 注入只用于测试，不接受调用方传入任意 URL（与 Gmail 连接器同款）。
- 登录是显式用户操作（`nyra account login …`），没有自动登录、没有自动换账号、队列与定时任务里不碰账号会话（与“队列/定时任务不自动换模型、不自动放行”同款纪律）。

## 10. CLI

```
nyra account status                  当前登录状态（账号邮箱、登录方式、会话过期时间）
nyra account login google            Google 登录（回环回调；首次要 OAuth 客户端）
nyra account login github            GitHub 登录（设备流：终端给码，浏览器里输码）
nyra account link google|github      给当前账号再绑一个登录方式
nyra account list                    列出本机账号（不含 token 哈希）
nyra account revoke <会话 id>|--all  撤销会话
nyra account logout                  登出（撤销当前会话 + 清掉本机 token）
```

退出码：0 成功、1 一般错误、2 用法错误。`nyra account login email` 下一批（等网关兑换端点）。数据库：设 `NYRA_DATABASE_URL` 后账号数据存 Postgres（见 §8），否则存本机文件。

## 11. 本批范围与下一批

本批做完：设计（本文档）+ `src/oauth.ts` + `src/accounts.ts`（账号、会话、magic link 核心、审计）+ Google 与 GitHub 两条完整登录链 + CLI + 测试（`tests/node/test-accounts.test.ts`）。第二批（同属缺口 41）：Postgres 后端 `src/accountsDb.ts`（表结构 v1、连接串三来源、CLI 自动切换、机主抢位重试、magic link 原子认领）+ 测试（`tests/node/test-accounts-db.test.ts`，SQL 走替身、失败路径连本机已关闭端口）。

## 12. 网关接线（下一批，已完成 2026-11-20 续）

本批做：网关三路鉴权 + 账号端点 + magic link 兑换路由 + `nyra account login email` 完整链。改动都在 `src/gateway.ts` 与 `src/cli.ts`。

### 12.1 三路鉴权（`apiAuth` 改异步）

`Gateway.apiAuth(req)` 从「owner token / 设备 token」二路，扩展为「owner token / 设备 token / 账号会话 token」三路。账号会话 token 走 `AccountSessionStore.verify`（SHA-256 比对、过期/失活裁剪），验过后按账号角色返回：

- owner 角色账号 → 返回 `"owner"`（等同 owner token，能访问 owner-only 端点）；
- user 角色账号 → 返回 `"account"`（`isOwner` 为 false，先只读）。

账号文件损坏等 fail-closed：当未登录处理（返回 null），不拖垮网关。网关用文件版 `AccountStore` / `AccountSessionStore` / `MagicLinkStore`（与 CLI 同口径）；Postgres 后端的网关接线仍是已知局限（见下）。

### 12.2 `GET /api/account`

返回当前账号（邮箱、名字、角色、已绑登录方式、创建时间）与会话列表（不含 token 哈希）。owner/设备 token 访问时返回 `{ account: null }`（不泄露账号目录）。账号会话 token 访问时返回完整账号信息。

### 12.3 `POST /api/account/magic-link`（兑换路由，无鉴权）

用户点邮件里的链接（`?token=…`）或 CLI 轮询（body 里的 `token`）兑换。复用 `loginWithMagicLink`：redeem 一次性校验 → upsert 账号 → 签发会话 token（只此一次返回原文）→ 写本机 session cookie → 审计。无效/过期/重放 token 回 401，缺 token 回 400。

### 12.4 `nyra account login email <邮箱> [--gateway <url>]`

发 magic link（走已授权的 Gmail 连接器发信，没授权提示先 `nyra gmail auth`）→ 提示用户点邮件链接 → 轮询本机 session cookie（最多 5 分钟）检测登录成功。网关地址默认 `http://127.0.0.1:8765`（`nyra ui` 默认端口）。

### 12.5 已知局限

- **Postgres 后端网关接线未做**：网关账号鉴权用文件版 store；设了 `NYRA_DATABASE_URL` 后 CLI 走 Postgres，但网关仍读文件，两者会看到不同的账号目录（同一台机器同跑 CLI 与网关时需注意）。网关常驻进程的 Postgres 连接生命周期（启动建表、退出关连接）留待后续。
- **多用户权限模型未细化**：`user` 角色先只读（owner-only 端点 403），"user 到底能干什么"仍是占位，未定义细粒度能力。
- `nyra account login email` 依赖网关在跑（链接指向网关兑换端点）；网关没起时用户点了链接会失败，CLI 会提示稍后查看状态。

## 13. 云端连接（第 6 批）

手机端改账号登录、不走局域网（用户 2026-11-23 令）：手机用 Google / GitHub / 邮箱
登录（复用本文件的同一套账号制），登录后直连云端 Nyra 服务，agent 在云端跑，
像 Codex 一样。客户端一半已做（`src/cloud.ts`、`src/cloudSync.ts`、`src/cloudCli.ts`、
`nyra cloud …`、手机启动器页），服务端按 API 契约另行实现，真云端未部署。
设计占位地址 `https://api.nyra.example`（`.example` 保留域名，解析不到真实服务），
没配真实地址时连接直接拒绝。同步协议与冲突规则、CLI、启动器页改动，
详见 `docs/mobile-cloud.md`。

