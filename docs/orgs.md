# 组织与团队 workspace（缺口 49 第一批）

报告：`~/workspace/research_notes/nyra-bot-direction-20261120.md` §6 缺口 49。
本批只做第一批：组织创建与管理、成员开通/回收、角色 admin/member/viewer
与权限校验。共享 Bot 与租户隔离是第二批。

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
```

操作者默认是当前登录账号（`nyra account status` 的那位），没登录时按机主。
`remove` / `role` / `delete` 须 `--yes`；`add` 不须（可逆、有审计）。

## 审计与证据

- 审计 `~/.nyra/org-audit.jsonl`（只追加）：动作、组织 id、账号 id、角色、
  操作者。不记邮箱。
- 运行事件（已注册进 `src/runs.ts` 的 `EVENT_FIELDS`）：`org_created` /
  `org_deleted` / `org_member_added` / `org_member_removed` / `org_role_changed`。

## 第二批的扩展位（本批只占位，不执行）

- `Org.shared_bots`：Team Bot 的 id 列表。共享 Bot 默认只读，写操作须 Bot
  主人显式接受；队友教给 Team Bot 的东西先进待审区，须 owner/Manager 批。
- `Org.isolation`：租户隔离三面开关（数据 / 设置 / 用量）。隔离是硬边界，
  不是提示词：租户间数据不互通，跨租户读文件须对方显式接受，越权访问记
  证据链并告警。
- `Org.private_catalog`：组织内私有策展目录，与公开市场共用同一套验证信封
  与安装策略。

## 诚实边界

- 本批只建组织层（身份与角色），不产生组织归属的数据：没有组织归属的任务、
  记忆、文件，隔离无物可隔——第二批共享 Bot 与租户隔离落地后，数据面才按
  `org_id` 行级隔离。
- 只在临时 home 上验过（假账号目录，不连真实 IdP）；SCIM 联动只验了“停用即
  失能”的判定，没走真实 IdP 的开通/回收流程；Windows/macOS 真机未验证。
