# Circles 信任圈与跨实例准入（缺口 34 第一批）

缺口 12 只说“互问、交接、共享上下文”，缺“谁有资格说话”这一层。
本批补上：每 agent 一份 `circles.json` 允许名单，准入即能力——只有
被引入信任圈的身份能给 agent 发任务；圈外消息在网关层直接丢弃，
不进 agent 上下文、不耗 token（对方是“收到后拒绝”，Nyra 是“看不
见”，更省 token 也更安全）。

别家做法是 Hello Minds 的 Circles（默认全封闭，引入是唯一的准入
方式，圈内 agent 可共享上下文）。Nyra 不学对方的隐患：其 FAQ 承认
“任何人无需账号即可直接 email 你的 Mind”（地址暴露即入口）；
Nyra 的 agent 邮箱入口（缺口 22）坚持白名单发件人 + 审批双保险，
见下面“邮件入口”一节。

## 两套“圈”，不要混淆

| | 分组圈（缺口 38） | 信任圈（缺口 34，本批） |
| --- | --- | --- |
| 账本 | `friends.json` 里的 circles 列表 + 每好友一个 `circle` 字段 | `~/.nyra/circles.json` |
| 决定什么 | “我主动发给谁、共享给谁” | “谁有资格发任务” |
| 命令 | `nyra peer circle <create\|list\|delete>` | `nyra circle <create\|list\|show\|invite\|revoke\|delete\|bind\|unbind\|owner\|check\|bindings>` |
| 默认 | 新好友进 `default` 分组 | 默认全封闭：没圈 = 谁也进不来，机主本人除外 |

两套圈名字可以相同、账本分开，不自动同步、无隐藏副作用。刚加的
好友只在 `default` 分组里，**不自动获得发任务资格**，须另行引进
信任圈。

## 准入规则

- **成员只记好友名**（`friends.json` 里已有的身份），不另起一套
  身份体系；入圈的前提是已批准、未拉黑的好友（双向握手已过）。
- **引入只能由机主或已在该圈里的成员发起**：圈外人不能往圈里拉人。
- **撤销后立即失去准入**：网关丢弃其消息、互问/交接/分享拒绝；
  历史证据与审计不删（不可变审计），但不再向该身份提供新上下文。
- **机主本人永远准入**，但网关要先认出你是谁：机主的渠道发件人
  id 须用 `nyra circle owner` 登记一次（见下）。
- **团队成员不经过网关准入**：团队成员是本机内部 agent（Soul agent
  id，见 `docs/team.md`），走参谋长分派；圈只管外部来信（渠道消息、
  对端呼叫、邮件）。

## 命令

```bash
nyra circle create work [--desc <描述>]        # 建信任圈（默认全封闭）
nyra circle list                                # 列出信任圈（成员数）与绑定数
nyra circle show work                           # 看一个圈的成员（谁引进的、何时、通过什么渠道）
nyra circle invite work pilot [--by <引入者>] [--channel <渠道>]   # 引入好友进圈
nyra circle revoke work pilot --yes             # 撤销成员（立即失去准入）
nyra circle delete work --yes                   # 删圈（须先移空成员）
nyra circle bind --channel telegram --sender 123456 --friend pilot    # 绑定渠道发件人到好友
nyra circle unbind --channel telegram --sender 123456                # 解绑
nyra circle owner --channel telegram --sender 123456                 # 登记机主的渠道身份
nyra circle check pilot                         # 看一个身份有没有发任务的资格
nyra circle bindings                            # 列出全部渠道发件人绑定
```

- `revoke` / `delete` 是破坏性操作，须加 `--yes`。
- `invite` 默认由机主发起（`--by` 不写就是机主）、渠道默认 `cli`；
  `--by` 写圈内成员名时，由该成员发起引入。
- `bind` 只认已批准、未拉黑的好友；同一渠道 + 发件人重复绑定会覆盖
  （上一次绑定失效）。
- 圈名只认字母、数字、下划线、连字符（1–32 字），`default` 是分组圈
  的保留名、不能建为准入圈。

## 网关预过滤

网关（`src/channels/gateway.ts` 的 `routeAndHandle`）与单渠道 Bot
（`src/bot/index.ts` 的 `startPolling` 循环）用同一套口径：

1. 绑定路由先定“谁接”（命中绑定 → 落默认绑定 → 命中但不在名单里
   直接丢弃，不落默认绑定，缺口 27 的口径不变）。
2. 再过信任圈：按发件人 id 查 `circles.json` 里的绑定，认出身份后
   查准入。圈外直接丢弃——只记一条最小审计，不进 agent 上下文、
   不耗 token、不调模型。
3. 圈内照常路由。

丢弃记进 `~/.nyra/bot-audit.jsonl`（SIEM 导出第 8 个来源，标签
`bot`）：`outcome: "dropped:circle"`、`rule: "circle:admission"`、
`reason` 写明为什么（发件人未绑定身份 / 好友不在任何信任圈里 /
好友已拉黑 / 账本读失败）。网关状态里的 `dropped` 计数包含这类丢弃。

网关按发件人 id 认人，不认名字：没绑定的发件人一律丢弃。所以新接
一个渠道时，先跑 `nyra circle owner` 登记机主、再跑 `nyra circle
bind` 绑定每个要放行的好友，否则他们的消息到不了 agent——这是
故意的（默认全封闭），不是 bug。

## 跨 agent 交接最小上下文

交接包本身是缺口 12 已有的任务级 allowlist（默认只带
`task` / `conclusions` / `steps` / `todos`，`evidence` 须显式加；
不含令牌、密码、绝对路径与完整对话历史）、默认只读、渲染头写明
“写操作须对方显式接受”。本批只加一道准入闸，不改包的内容：

- `nyra peer ask --to <对端>`：对方不在信任圈里直接拒绝（记 Beads
  与审计，不连对端、不耗 token）。
- `nyra peer handoff --to <对端> --run <运行>`：对方不在信任圈里
  记 bead `rejected`（不发包）。
- `nyra peer share --to <好友>`：先全员验一遍准入，不过整批拒绝、
  不发一半（某一家不在圈里，整批都不发）。

撤销后：后续的互问/交接/分享拒绝；已经交出去的包对方手里还有，但
Nyra 不再向该身份提供新的上下文（历史证据与审计不删）。

## 邮件入口

邮件入口（缺口 22，`src/mailInbox.ts`）**不归圈管**，它有自己的
白名单发件人 + 审批双保险，本批只核对已落地、写进文档，不重做：

- 白名单发件人发来的邮件才进队列（`mail-inbox.allowlist`，配置里
  配邮箱数组；非白名单发件人不触发）。
- 进队列的任务仍按现有审批规则跑（写操作照常挂起等审批，不自动
  放行），成本上限、白名单/沙箱全部继承。
- 整个入口默认关闭（`enabled: false`），显式启用 + 加白名单才是
  opt-in。

也就是说：邮件准入看邮箱白名单，渠道与对端准入看信任圈，两套门
各管各的入口，不互相代替。

## 账本与证据链

- 账本 `~/.nyra/circles.json`（原子写 0600，损坏先备份
  `.corrupt-<时间戳>` 再抛错，不静默重建）：

  ```json
  {
    "version": 1,
    "circles": [
      {
        "name": "work",
        "description": "",
        "created_at": "2026-11-22T00:00:00.000Z",
        "created_by": "owner",
        "members": [
          { "identity": "pilot", "kind": "friend", "invited_by": "owner", "invited_at": "2026-11-22T00:00:00.000Z", "channel": "telegram" }
        ]
      }
    ],
    "bindings": [
      { "channel": "telegram", "sender": "123456", "identity": "pilot", "bound_at": "2026-11-22T00:00:00.000Z", "bound_by": "owner" }
    ]
  }
  ```

  绑定里的 `identity` 是好友名或字面 `"owner"`（机主）。
- 删圈写墓碑（H6，Hermes 借鉴）：`circles.json` 里加 `deleted` 列表（名字 +
  删除时间 + 谁删的），删掉的圈只留这一条；建同名圈是用户显式决定——清掉墓碑
  继续建，并记 `circle_recreated` 审计与运行事件；任何重扫/同步都不许悄悄把
  删掉的圈建回来。
- 引入/撤销/建圈/删圈/重建/绑定都进证据链：6 个运行事件已注册进
  EVENT_FIELDS（`circle_created` / `circle_deleted` / `circle_recreated` /
  `circle_invited` / `circle_revoked` / `circle_binding_set`，
  `src/timeline.ts` 加渲染），每次操作单独建一条只记 circle_*
  事件的证据运行（缺口 38 的 `recordFriendEvent` 同款做法）；审计
  进 `~/.nyra/peer-audit.jsonl`（只记圈名、身份名、引入者与渠道，
  不记消息内容）。
- 圈外丢弃只进 `bot-audit.jsonl`，不建运行（丢弃本身不值得一条
  证据运行）。

## 已知局限

- 真实对端未接通过：只在假对端（本机 HTTP）与假渠道上验过准入
  与丢弃。
- 名片拉取的 per-circle 可见性本批不做：名片仍按缺口 38 的口径
  公开拉取，圈只限制“谁能发任务”，不限制“谁能拉名片”。
- 跨实例传输复用缺口 12 的协议工作，本批没建新协议。
- Windows / macOS 真机未验证。
