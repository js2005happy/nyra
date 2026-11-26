# 组织与团队 workspace（缺口 49 第一批 + 第二批）

报告：`~/workspace/research_notes/nyra-bot-direction-20261120.md` §6 缺口 49。
第一批：组织创建与管理、成员开通/回收、角色 admin/member/viewer 与权限校验。
第二批：共享 Bot、租户隔离（任务与记忆带 org_id 归属、文件走组织工作区）、
组织内私有目录。

## 模型

- **组织（租户）**：一个团队 workspace。账本 `~/.nyra/orgs.json`（0600 原子写，
  损坏先备份再抛错）。组织名 1–64 字，不区分大小写判重。
- **成员**：只记账号 id（缺口 41 的全局账号，不另存邮箱与名片）。
  成员字段：`account_id`、`role`、`added_by`、`added_at`。
- **角色**：`admin`（管成员与设置）、`member`（可读写）、`viewer`（只读）。
- **机主**：字面 `"owner"`，或全局角色为 `owner` 的账号，是超级管理员——
  任何组织全部操作都允许，不须是成员。机主不占成员位。

## 权限表（第二批共享 Bot 与隔离沿用同一张表）

| 角色 | read | write | manage |
| --- | --- | --- | --- |
| viewer | ✅ | ❌ | ❌ |
| member | ✅ | ✅ | ❌ |
| admin | ✅ | ✅ | ✅ |
| 机主 / 全局 owner | ✅ | ✅ | ✅ |

判定函数：`canOrg(home, orgRef, accountId, action)`（`src/orgs.ts`），
门：`requireOrgAccess`（不允许直接抛错，供网关与第二批调用）。

fail-closed：账本读失败、账号不存在、账号已停用，一律按“拒绝”处理，
不抛错、不放行。停用账号的组织权限立即失效——判定每次都现查账号状态，
不靠同步任务。

## 不变量

组织有成员时至少留一名 admin 成员：撤掉最后一名 admin、或把最后一名
admin 降级时，若组织里还剩别的成员，直接拒绝；把组织删空成员时允许
（空组织仍归机主管理与删除）。

## 与已有身份层的关系

- **账号（缺口 41）**：成员校验走 `AccountStore`。账号不存在、或已停用，
  开通直接拒绝。
- **SCIM（缺口 43）**：SCIM 开通的是“账号”，组织命令开通的是“账号进哪个
  组织”。SCIM 停用账号后，组织权限立即失效（现查账号状态，不留快照）。
  组织不建自己的 SCIM 群组映射：SCIM 群组的 `role: owner` 会提权全局角色，
  组织 admin 只是组织内角色，两者不能混用。
- **信任圈（缺口 34）**：圈管“谁能给 agent 发任务”，组织管“谁在哪个团队
  里、能做什么”。两套账本分开，组织角色不替代准入圈。

## CLI

```
nyra org create <组织名> [--desc <描述>]
nyra org list
nyra org show <组织>
nyra org add <组织> <邮箱或账号id> [--role admin|member|viewer]
nyra org remove <组织> <邮箱或账号id> --yes
nyra org role <组织> <邮箱或账号id> <admin|member|viewer> --yes
nyra org delete <组织> --yes
nyra org check <组织> <邮箱或账号id> [read|write|manage]
nyra org sso <组织> <on|off> [--provider <id>] [--domains a.com,b.com]
```

`org sso` 开/关组织强制 SSO（须机主或该组织 admin；开后成员只能走 SSO 登录，见 `docs/sso.md`「组织强制 SSO 与邮箱域名路由」；`--provider` 绑身份提供方 id，`--domains` 绑邮箱域名，多个用逗号分隔）。

操作者默认是当前登录账号（`nyra account status` 的那位），没登录时按机主。
`remove` / `role` / `delete` 须 `--yes`；`add` 不须（可逆、有审计）。

### 第二批子命令（共享 Bot / 租户隔离 / 组织内私有目录）

```
nyra org share <组织> <bot-id> [--name <名>] [--to <邮箱,...>|all] [--desc <描述>]
nyra org shared <组织>
nyra org unshare <组织> <bot-id> --yes
nyra org grant-write <组织> <bot-id> <邮箱> <write_memory|write_file|send_message,...> [--expires <ISO>]
nyra org revoke-write <组织> <bot-id> <邮箱> --yes
nyra org grants <组织> <bot-id>
nyra org learnings <组织> <bot-id> submit <内容>
nyra org learnings <组织> <bot-id> list [--status pending|approved|rejected]
nyra org learnings <组织> <bot-id> approve <id> --yes / reject <id> --yes
nyra org workspace <组织> <目录> --yes
nyra org file-read <组织> <相对路径>
nyra org cross-access <组织> grant <路径前缀> <邮箱|org:组织> [--expires <ISO>]
nyra org cross-access <组织> list
nyra org cross-access <组织> revoke <grant-id> --yes
nyra org catalog <组织> publish <文件> --yes
nyra org catalog <组织> list
nyra org catalog <组织> install <模板名> --yes
nyra org catalog <组织> remove <模板名> --yes
nyra org tasks <组织>
nyra org task-add <组织> <任务文本...> [--mode readonly|auto]
nyra org violations <组织> [--limit N]
nyra org isolation <组织>
nyra org memory <组织> [--limit N]
```

破坏性操作（`unshare` / `revoke-write` / 批教学 / `cross-access revoke` /
`catalog publish|install|remove`）须 `--yes`。

## 共享 Bot（第二批）

- 发布：`nyra org share`，发布者须组织 write。共享出去的 Bot 默认只读：
  能看任务产物，不能写记忆、文件、密钥。共享给全组织（`--to all`，默认）
  或指定的人（`--to <邮箱,...>`，只认账号 id 列表）；指定人共享时，不在
  名单里的人连列表都看不到。
- 写操作：`write_memory` / `write_file` / `send_message` 三档，须 Bot 主人
  显式接受（`nyra org grant-write`；机主可代行，组织 admin 不行）。授权可
  设过期时间，过期当场失效；取消共享时写授权随之失效。写以读为前提：没读
  权限的账号拿了授权也写不了。Bot 主人恒可写。
- 判定口径（`src/orgSharing.ts`）：`canReadSharedBot(home, orgRef, botRef, accountId)` /
  `canSharedBotWrite(home, orgRef, botRef, accountId, action)`。Bot 不存在或
  已取消共享时直接 false，不抛错。
- 账本：`~/.nyra/org-sharing.json`（0600 原子写，损坏备份），共享记录、
  写授权、教学待审、跨租户读授权记在同一本账里。

## 队友教学（Review learnings，第二批）

队友教给 Team Bot 的东西先挂待审区（`learnings submit`，提交者须组织
write），须 Bot 主人或组织 admin（Manager）批了才生效（`learnings approve`；
`reject` 是拒绝，不生效）。批准后落成一条组织记忆条目（scope=org，见下），
走记忆证据门 CLI 路径：引用即教学内容本身，批准人即依据提供者；落不进去
时教学留在待审区（fail-closed，不静默丢掉）。

## 租户隔离（第二批，硬边界）

- **数据隔离恒开，不可关闭**：`Org.isolation.data` 缺字段的老组织、或账本里
  写了 `data: false` 的组织，同样按开处理。设置隔离与用量隔离尚未实现，
  `nyra org isolation` 只读展示为关，不造假开关。
- **任务归属**：`addTask` 传 `orgId` 即记进 sidecar 账本
  `~/.nyra/task-orgs.json`（与 `taskOrigin.ts` 同款做法，不动 RunState）；
  `nyra org task-add` 排组织任务。读/列走隔离门（`canAccessTask` /
  `listOrgTasks`）：不是该组织成员直接拒绝，没归属的任务（全局任务）谁都
  能读。
- **记忆归属**：结构化条目 scope=org + orgId（`src/memoryGate.ts`）。
  `nyra memory remember --org <组织>` 写组织记忆（须组织 write）、
  `nyra memory entries --org <组织>` 列、`nyra memory entry <id>` 读组织
  条目时走读校验；拒绝记一次隔离违反。模型工具 `memory_append` 没有账号
  上下文（ToolContext 无 account id），组织记忆写入只走 CLI 与 API，不动
  工具路径。
- **文件**：组织绑一个工作区（`nyra org workspace`，admin 绑，目录须存在、
  绝对路径）。读文件只认工作区下的相对路径：本组织成员（read）或机主直接
  读；组织外的人须一条有效的跨租户读授权（`nyra org cross-access grant`，
  授权给账号或 `org:<组织>`，可设路径前缀与过期时间）。`..` 逃出工作区、
  绝对路径不在工作区内、符号链接——全部拦下。单文件上限 1MB。
- **越权访问（隔离违反）**：拒绝时记进四处——违规账本
  `~/.nyra/org-violations.jsonl`（0600）、组织审计、运行事件
  `org_isolation_violation`、收件箱告警。`nyra org violations` 只认组织
  admin 或机主查看。
- **还没覆盖的**：组织级设置与用量分账（隔离开关只读展示为关）；会话、
  知识库、Bot 电脑文件等其他数据面尚未按 org_id 隔离——本批只覆盖任务与
  记忆两类归属 + 文件工作区边界。

## 组织内私有目录（第二批）

只在组织内分享 Bot 配置，与公开市场共用同一套验证信封与安装策略，不另起
一套扫描与审批：

- 发布校验用 `validateTemplateDefinition(parseTemplateText(text), KNOWN_TOOLS, home)`，
  KNOWN_TOOLS 从 `creator.ts` 动态 import（与 `marketplace.ts` 同款）。
- 安装走 `importTemplateText(..., KNOWN_TOOLS)`（与市场安装同一条路，draft
  状态、须试跑后激活）。
- 模板文本存 `~/.nyra/org-catalog/<org_id>/<slug>.yaml`（0600），账本
  `~/.nyra/org-catalog.json`。发布须 manage（组织 admin 或机主），安装须
  组织 read。已安装的全局模板不受组织目录移除影响。

## 审计与证据

- 审计 `~/.nyra/org-audit.jsonl`（只追加）：动作、组织 id、账号 id、角色、
  操作者。不记邮箱。
- 运行事件（已注册进 `src/runs.ts` 的 `EVENT_FIELDS`）：第一批 `org_created` /
  `org_deleted` / `org_member_added` / `org_member_removed` / `org_role_changed` / `org_sso_changed`（O3）；
  第二批 `org_bot_shared` / `org_bot_unshared` / `org_bot_write_granted` /
  `org_bot_write_revoked` / `org_learning_submitted` / `org_learning_approved` /
  `org_learning_rejected` / `org_isolation_violation` / `org_workspace_set` /
  `org_cross_access_granted` / `org_cross_access_revoked` /
  `org_catalog_published` / `org_catalog_installed`（`org_catalog_removed` 只
  记审计，不注册事件）。

## 第二批的扩展位（已落地）

- `Org.shared_bots`：Team Bot 的 id 列表。共享 Bot 默认只读，写操作须 Bot
  主人显式接受；队友教给 Team Bot 的东西先进待审区，须 owner/Manager 批。
- `Org.isolation`：租户隔离三面开关（数据 / 设置 / 用量）。数据隔离是硬边界，
  恒开、不可关闭；设置与用量隔离尚未实现，只读展示为关。
- `Org.private_catalog`：组织内私有策展目录，与公开市场共用同一套验证信封
  与安装策略。

## 诚实边界

- 第一批只建组织层（身份与角色），不产生组织归属的数据：没有组织归属的任务、
  记忆、文件，隔离无物可隔——第二批共享 Bot 与租户隔离落地后，数据面才按
  `org_id` 行级隔离。
- 第二批覆盖的归属：任务（sidecar 账本）与记忆（scope=org 条目）两类 + 文件
  工作区边界；组织级设置、用量分账、会话、知识库、Bot 电脑文件尚未按 org_id
  隔离。模型工具 `memory_append` 写不了组织记忆（无账号上下文），只走 CLI
  与 API。
- 只在临时 home 上验过（假账号目录，不连真实 IdP）；SCIM 联动只验了“停用即
  失能”的判定，没走真实 IdP 的开通/回收流程；网关接线未做；Windows/macOS
  真机未验证。
