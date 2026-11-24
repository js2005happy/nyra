# SSO 与 SCIM（企业身份接入与账号开通）

缺口 43 第二批（SSO/SCIM），挂在缺口 41 的账号体系上。分层上限 + 审计导出是缺口 43 第三批，本批不做。

## SSO 登录（OIDC）

一个 SSO 身份提供方 = 一个 OIDC issuer。登录走授权码 + PKCE + 回环回调（复用 `src/oauth.ts`，与 Google 登录同款流程），不是用户名密码直登。

### 注册身份提供方

```sh
nyra sso provider add --id corp --issuer https://login.microsoftonline.com/<tenant>/v2.0 --client-id <client_id> --name "公司 IdP"
nyra sso provider list
nyra sso provider remove corp --yes
```

- 注册表 `~/.nyra/sso-providers.json`（0600、原子写、损坏先备份再抛错，与 accounts.ts 同款纪律），只存 `id / name / issuer / client_id / scopes`，**client_secret 不进注册表**。
- `id`：小写字母开头、字母数字 `_ -`、最长 32 字；`issuer` 必须是 `https://` 开头（不带 query/fragment）；`scopes` 默认 `openid email profile`。
- `client_secret` 只存密码箱，条目 `sso-client-<id>`（与 Google 客户端同形：`{client_id, client_secret}`，CLI 首次登录时交互粘贴存入，`vault.add(name, value, true)`）。

### 登录

```sh
nyra sso login corp
nyra sso status
```

流程：拉 `/.well-known/openid-configuration` 发现端点 → 回环回调拿授权码 → 换 token → 取 userinfo。

- 发现文档的 `issuer` 必须与注册的一致，三个端点必须都是 `https`——不一致直接拒绝，不猜、不补。
- userinfo 要求 `email_verified === true`，未验证的邮箱不能建账号（fail-closed）。
- 身份链到缺口 41 的账号（provider `"sso"`，`LinkedIdentity.issuer` 记 issuer，`sub` 是 IdP 的 sub；同邮箱链到同一个账号，不建第二个）。
- 已停用的账号拒绝登录（`upsertAccount` 里拦，见下）。

### 组织强制 SSO 与邮箱域名路由（O3）

组织可以要求成员只能走 SSO 登录（不再接受 GitHub / Google / 邮箱 magic link）：

```sh
# 组织管理员开强制 SSO：绑身份提供方 + 绑定邮箱域名
nyra org sso 研发组 on --provider corp --domains example.com,example.cn
# 关掉
nyra org sso 研发组 off
# 用户先查自己该走哪个提供方登录
nyra sso route me@example.com
nyra sso login corp
```

- 开关存在组织账本（`Org.require_sso` / `sso_provider` / `sso_domains`），改动进组织审计（`org-audit.jsonl`，动作 `org_sso_changed`）与运行事件 `org_sso_changed`。
- 拦截点在登录发会话之前（`loginWithGoogle` / `loginWithGithub` / `requestMagicLink` / `loginWithMagicLink`）：邮箱域名命中强制 SSO 的组织，或账号已是强制 SSO 组织的成员时，非 SSO 登录直接拒绝并提示该走的 `nyra sso login <提供方>`。SSO 登录本身不受影响。
- 路由只做建议：`nyra sso route <邮箱>` 按域名找组织、打印对应的身份提供方与登录命令；域名没绑定任何组织时提示走默认登录。
- 先开开关、后注册提供方是合法顺序：此时非 SSO 登录仍会被拦，提示里写 `<身份提供方>`，CLI 会提醒先绑提供方。
- 只做登录，不做 SCIM 全量同步；actor 直接对应 IdP 的 sub，不另起身份体系；自托管单机场景下 SSO 默认关。

## SCIM 2.0 账号开通（RFC 7643 / 7644）

SCIM 端点挂在网关上：`/scim/v2/Users`、`/scim/v2/Groups`，另有 `/scim/v2/ServiceProviderConfig`、`/scim/v2/ResourceTypes`、`/scim/v2/Schemas`。鉴权用 SCIM 自己的 Bearer token，**不走 `X-Nyra-Token`**。

```sh
nyra sso scim token        # 签发 Bearer token（只显示一次，只存 SHA-256）
nyra sso scim token --yes  # 重签发（旧 token 立即失效）
nyra sso scim revoke-token # 吊销
nyra sso scim status       # token 与端点状态
```

- token 是随机 32 字节，磁盘 `~/.nyra/scim-token.json`（0600）只存 SHA-256，原文只打印一次；`handleScimRequest` 用 `timingSafeEqual` 比对，未配 token 或验不过一律 401。
- 网关在 `/api/` 通用鉴权之前挂载 `/scim/v2`（`src/gateway.ts`），用文件版 store（与 accounts.md §12 已知的 Postgres 网关接线局限同口径）。

### Users（映射到账号）

`userName` = 邮箱，`active` = `status !== "suspended"`，`externalId` = 账号的 `external_id`。

| 操作 | 语义 |
| --- | --- |
| `POST /Users` | 建账号（`userName` 邮箱必填，`displayName` / `externalId` 可选，`active` 默认 true；重复邮箱 409）。SCIM 建的用户没有 provider 身份（IdP 只给邮箱与外部 id），登录仍要走 SSO/Google/GitHub/邮箱任一方式链身份——SCIM 只开通，不发凭证。 |
| `GET /Users` | 列表。filter 只支持 `userName eq` / `emails.value eq` / `active eq`（其余 400）；`startIndex` 1 起、`count` 分页（上限 200）。 |
| `GET /Users/:id` | 单个。 |
| `PUT /Users/:id` | 全量替换：`userName` 不可改（400）；`displayName` 不可通过 SCIM 改（没有改名接口，拒绝而不是静默丢弃）；`externalId` / `active` / `groups` 可改。 |
| `PATCH /Users/:id` | `add` / `replace` / `remove`，路径限 `active` / `displayName`（拒绝）/ `emails`（拒绝）/ `externalId` / `groups` / `userName`（拒绝）。 |
| `DELETE /Users/:id` | **停用 + 清 externalId + 移出全部群组**。账号记录保留备审计，不硬删。 |

### Groups（自有账本）

账本 `~/.nyra/scim-groups.json`（0600、原子写）。群组可选 `role`（`"owner" | "user"`）：

- 成员进 **owner 组提权**（user → owner）；
- 进 user 组**不降级**、离组**不降级**——降权必须管理员显式做，不静默降权。

`POST /Groups`（`displayName` 必填，`role` 可选，`members` 是 `[{value: 账号 id}]`）、`GET` 列表/单个、`PUT` 全量替换、`PATCH`（`displayName` 改名、`members` 加/减，`members[value eq "…"]` 只删指定成员）、`DELETE`。

## 账号停用（fail-closed，立即失能）

停用是缺口 43 第二批的核心安全语义，不只是改个状态：

1. `suspendAccount`：改状态 → **撤销该账号全部会话** → 记审计。会话撤销后网关鉴权（`accountSessions.verify`）与 `getCurrentAccount` 同时失效，不留“停用了还能用旧会话”的窗口。
2. 网关 `accountFromSession` 验过会话后也查一次 status，已停用返回 null（双保险）。
3. `upsertAccount` 在找到已停用账号时直接抛错——覆盖 Google / GitHub / 邮箱 / SSO 四条登录链 + link 流程。
4. 恢复（`reactivateAccount`）只改状态，**不恢复已撤销的会话**——被停用期间的会话作废了就是作废了，须重新登录。

CLI：

```sh
nyra account suspend <账号 id> [--yes]    # 交互确认，--yes 跳过
nyra account reactivate <账号 id>
nyra account list                          # 显示 id 与“已停用”标记
```

`nyra account status` 对已停用账号显示“未登录”（停用就是停用，不留后门）。

## 证据链与审计

- 新审计链 `~/.nyra/sso-audit.jsonl`（append-only，0600）：`sso_login`、`sso_provider_added/removed`、`scim_user_created/updated/deactivated/reactivated/deleted`、`scim_group_created/updated/deleted`、`scim_token_issued/revoked`。字段只有 `ts / action / account_id / external_id / issuer_hash / provider_id / group_id`——**不记邮箱、不记 token、不记 secret**，issuer 只记 12 位 SHA-256 指纹。
- 账号停用/恢复走已有的 `accounts-audit.jsonl`（不重复记进 sso-audit）。
- 13 个新运行事件已注册进 `src/runs.ts` 的 `EVENT_FIELDS`：`sso_login` / `sso_provider_added` / `sso_provider_removed` / `scim_user_created` / `scim_user_updated` / `scim_user_deactivated` / `scim_user_reactivated` / `scim_user_deleted` / `scim_group_created` / `scim_group_updated` / `scim_group_deleted` / `account_suspended` / `account_reactivated`（只记 id 与指纹；有运行上下文时镜像，CLI/网关调用时 runId 为空则只记审计）。

## Postgres 后端（表结构 v1 → v2）

`ACCOUNTS_SCHEMA_VERSION` = 2。迁移语句（幂等，老库直接跑）：

```sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE account_identities ADD COLUMN IF NOT EXISTS issuer text;
```

`PostgresAccountStore` 实现 `suspend` / `reactivate` / `setRole` / `updateExternalId`；`create` 插 `status 'active'`（+ 可选 `external_id`）；`linkIdentity` 存 `issuer` 并拒绝已停用账号。

## 已知局限

- 真实 OIDC 身份提供方未接通（只用 stub fetch + 真回环服务器验过登录流程）；真实 SCIM 客户端（Okta / Entra）未接通过。
- Postgres v2 迁移只在 FakeDb 替身上验过 SQL，未在真 Neon 库上跑过。
- 网关 SCIM 用文件版 store（Postgres 后端网关接线仍是已知局限，见 accounts.md §12）。
- Windows/macOS 真机未验证。
