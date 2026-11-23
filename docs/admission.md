# 企业级准入账本（G-P2-2）

Nyra 现在：信任圈、角色白名单、红线表、审计导出都有，但那是分散在各模块里的
单机记录。一个人想查「谁批了谁进群、谁改了策略、谁领了 token」要翻好几本账。
本批把这三件事收进**同一本统一的准入账本**。

只借了 Turnstone（turnstonelabs/turnstone，开源自托管多节点 agent 编排）里
append-only 审计日志的**想法**，Node 实现是 Nyra 自己的，没抄代码。

## 账本长什么样

文件在 `~/.nyra/admission-ledger.jsonl`，一行一条事件，JSONL 格式。

- **只追加，不改写**：写账本只往文件尾巴追加；没有改写、删除、重写入口。
  审计账被改了就什么都证明不了，所以干脆不提供改的路。
- **0600**：文件只机主能读写；符号链接拒绝读写（别让账本指到别人文件上）。
- **坏行跳过**：读账本时坏行（不是 JSON、缺字段）跳过并计数，读不崩；
  `nyra admission log` 会在末尾提示坏行数，请手动检查账本文件。
- **只记元数据，绝不记原文**：每条事件只记 actor（谁批的）、subject（谁进的）、
  circle（哪个圈）、role（什么角色）、scope（什么能力）、token 指纹
  （SHA-256 前 12 位）、策略版本与哈希、≤200 字的 detail。
  **token 原文、消息原文、密钥、绝对路径、策略变更的原因原文一律不进账本。**

## 事件种（7 个）

| 种 | 意思 |
| --- | --- |
| `friend_approved` | 好友批准（谁批的、谁、哪个圈、什么档位） |
| `friend_declined` | 好友拒绝（拒绝也记账，不然审计缺一半） |
| `member_joined` | 成员进圈 |
| `member_left` | 成员离圈 |
| `policy_changed` | 策略变更（谁改的、哪个范围、旧版本 → 新版本、策略哈希） |
| `token_issued` | token 发放（只记指纹，不记值） |
| `token_revoked` | token 吊销（只记指纹，不记值） |

## 接线点（5 处）

写账本都是 **best-effort**：写失败不破坏原操作——批了就是批了，吊销照样
立即生效，账本缺一条是审计的事，不是操作的事。

| 接线点 | 事件 |
| --- | --- |
| `src/peerCard.ts` 的 `acceptFriend` / `declineFriend` | `friend_approved` / `friend_declined` |
| `src/circles.ts` 的 `inviteToCircle` / `revokeFromCircle` | `member_joined` / `member_left` |
| `src/friendGrants.ts` 的 `issueFriendGrant` / `revokeFriendGrant` | `token_issued` / `token_revoked`（指纹 = grant 的 token_hash 前 12 位） |
| `src/peerTokens.ts` 的 `setPeerToken` / `revokePeerToken` | `token_issued` / `token_revoked`（指纹 = token 的 SHA-256 前 12 位；没删掉时不记） |
| `src/governance.ts` 的 `publishPolicy` | `policy_changed`（版本、哈希、范围；原因原文不进账本） |

**没接的**：`ensureDefaultPolicy`（系统初始默认策略，不是人的决定；接了会让
每个新 home 第一次跑就多一条账本条目，污染测试）。组织成员开通（`orgs.ts`）
不在本批三处接线点内，没接——账本只覆盖上面这五处。

**不新增运行事件类型**：各接线点原有的运行事件（`circle_invited`、
`friend_accepted`、`friend_grant_issued`、`peer_token_set`、`policy_changed`）
已经进了运行事件链，账本是跨模块的统一审计视图，不再另发一套运行事件。

## CLI

```sh
nyra admission log [--kind <种>] [--actor <人>] [--subject <人>] [--circle <圈>] [--since <ISO 时间>] [--until <ISO 时间>] [--limit <条数>] [--json]
nyra admission show <id> [--json]
nyra admission who-approved <人> [--limit <条数>] [--json]
nyra admission policy-history [--limit <条数>] [--json]
nyra admission export [--out <路径>]
```

- `log`：按种 / 批的人 / 被批的人 / 圈 / 时间范围查，新的在前，默认最多 100 条
  （上限 1000；`--limit` 给 0 或超过 1000 报错；`--since` / `--until` 不是有效
  时间报错）。`--json` 打 JSON 数组。
- `show <id>`：看一条事件，id 形如 `adm-` + 16 位十六进制；没有返回 1。
- `who-approved <人>`：谁批了某人进群 / 拿 token（只认 `friend_approved`、
  `member_joined`、`token_issued` 三种批准类事件），新的在前。
- `policy-history`：策略变更历史，新的在前。
- `export`：导出整本账本 JSONL。不给 `--out` 时打到 stdout；给 `--out` 时写文件
  （0600，原子写，目标是符号链接时拒绝）。账本本身只含元数据与指纹，导出
  也不含 token 原文与消息原文——导出就是账本原文，不用再脱敏。
- `--help` 与未知动作返回 2（与 `nyra intervention` 同款）。

## API（`src/admission.ts`，叶模块，只引 node 内置）

- `admissionLedgerPath(home)`：账本路径 `~/.nyra/admission-ledger.jsonl`。
- `admissionFingerprint(value)`：SHA-256 前 12 位。
- `appendAdmission(home, event)`：严格版，写失败抛 `AdmissionError`。
- `recordAdmission(home, event)`：best-effort 版，写失败返回 `null`，不抛错——
  接线点都走这个。
- `readAdmissions(home)`：返回 `{ entries, skipped }`（skipped = 坏行数）。
- `listAdmissions(home, filter)`：按种 / 人 / 圈 / 时间过滤，新的在前，默认
  limit 100、上限 1000。
- `getAdmission(home, id)`：按 id 取一条，没有返回 `null`。
- `whoApproved(home, subject, limit)`：某人的批准类事件。
- `policyHistory(home, limit)`：策略变更历史。
- `exportAdmissions(home)` / `exportAdmissionsToFile(home, path)`：导出 JSONL 原文。

校验：actor / subject ≤128 字，circle / role ≤32 字，scope 每项 ≤64 字，
detail ≤200 字；token 指纹与策略哈希须 12 位十六进制；策略版本须非负整数。

## 不做

- **真 OIDC SSO**：没有外部 IdP 接线。账本里 actor 就是身份字符串；以后接 IdP
  时 subject 直接对应 IdP 的 `sub`，账本格式不用改。只留这个说明，不加死配置代码。
- **RBAC 全面重构**：现有角色白名单不动，账本只记账。
- **多节点同步**：账本是本机文件，多节点合并不做。

## 诚实边界

- 只在临时 home、假 provider 上验过；账本只覆盖上面列出的五处接线点，
  组织成员开通（orgs.ts）等其他准入动作没进账本。
- 账本是本机文件：多节点、多机主场景下各节点各记各的账，没有跨节点合并。
- Windows / macOS 真机未验证。
