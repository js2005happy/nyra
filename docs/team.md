# 团队模式（GROK 批，新缺口 52）

一个人说话，后面藏着一支队伍：一个常驻参谋长独占入口，只拆解、分派、汇总，不写业务代码；下游专职 agent 各做执行，只回简报。用户只跟一个人说话，团队复杂度藏在后面；入口唯一，审批门只有一道。

借鉴来源是 Hermes 子代理并行界面与 GrokBot 多 Bot 团队的做法（见 `research_notes/nyra-hermes-subagents-grokbot-team-20261121.md` §3），只借机制，不搬文字：不抄 Hermes 的 `delegate_task` API 形状与 `/agents` 键位，不抄 GrokBot 模板文案与 charter 原文（包括各家指南里的逐字岗位描述），不拿帖子里的演示数字（21 秒 / 50 秒 / 1 分 25 秒、20+ 代理）当事实写进文档，不把 `/goal`、`/loop`、`/swarm` 当三件套照搬。

## 四件东西

### 1. Charter 角色契约（GROK-2，缺口 28 深化）

每个 agent / Soul 一份书面契约，写进 Soul 文件，与 Tenet 并列：

| 字段 | 意思 |
|---|---|
| `own` | 负责什么 |
| `sources` | 信息来源（1–10 条，每条最长 200 字） |
| `output` | 输出格式 |
| `approval` | 审批门 |
| `stop` | 停下条件 |

每项 1–1000 字，五项齐全有效才算一份契约。写坏了拒绝落盘，旧契约不动。

```bash
nyra soul charter set <agent> --own "负责什么" --sources "来源1、来源2" --output "输出格式" --approval "审批门" --stop "停下条件" [--yes]
nyra soul charter show [agent]
nyra soul charter clear <agent> [--yes] # 清掉后该 agent 不能再接团队单，直到重写一份
```

建 agent 接单须有完整 Charter：建团队、加成员、分派前都校验（`requireCharter`），缺了直接拒绝，不静默放行。

合同写得再好模型也可能不遵守，所以配了 verifier 抽查与审计：成员交付时 `verifyCharterCompliance` 做确定性抽查（Charter 在不在、齐不齐、交付物非空、Charter 的 output 里用反引号声明的标记（如 `## 结论`）在不在交付物里），结论行贴在交回文本末尾（`charter_valid: true/false`，与 H-4 的 `schema_valid` 行同款口径；没声明标记那项跳过，不算通过也不算失败）。抽查是启发式检查，只核说法不验语义——抽查过了不等于守合同了，内容对错仍由 verifier + 人批负责，不要拿“抽查过了”当“交付物对了”。抽查结论进证据链（`team_charter_verified` 事件）。

### 2. 文件交接 inbox / outbox / changelog（GROK-4，缺口 12/30 深化）

团队成员之间用共享目录的约定结构交接，不靠聊天记录复制粘贴：

- `inbox/`：待办（别人发给我的）
- `outbox/`：已完成 + 证据（我发出去的底）
- `changelog.md`：改了什么（双方各记一行）

交接目录落在各 agent 自己的电脑 workspace 内（`handover/inbox/`、`handover/outbox/`、`handover/changelog.md`，缺口 42 一 Bot 一台电脑），不要为“方便”退回共享一台电脑。没 Soul 就没电脑，交接没地方落——先建 Soul，不静默回退到共享目录。

交接包（`handover/inbox/<ho_id>.json`）：id、时间、谁发给谁、一句话任务、备注、文件清单。文件只内联小文本（≤ 8 KiB、最多 5 个内联），大文件与二进制只记 SHA-256 指纹、不复制内容。路径只认交出方 workspace 内的相对路径：绝对路径、`..` 逃逸、符号链接一律拒绝（交接包不能成为读 workspace 外文件的旁路）。

```bash
nyra team handover send --from <agent> --to <agent> --task "一句话" [--note "备注"] [--file <相对路径>...] [--contract <契约 id>]
nyra team handover list <agent> [--box inbox|outbox]
nyra team handover show <agent> <id>
nyra team handover ack <agent> <id> [--workdir <目录>] # 接收方确认接下（没挂契约：只是“接了”，内容对错仍由 verifier + 人批负责；挂了契约：先程序验收，过了才接下）
```

挂了交接契约的包（Pi Bot 借鉴第 2 条，详见 `docs/handover-contract.md`）：发包时契约须存在、待验收、from/to 与本次交接一致；`ack` 时先跑程序验收——全过才接下，不过打回（包保持待接，对方改完再 `ack`）、轮次用完停下等人（须人 `nyra handover contract resolve --yes` 认下或 `close --yes` 放弃）；验收地默认交出方电脑的 workdir（`--workdir` 可指定别处）。挂到包上的契约只用文件类与内置 checker，`output-contains` / `trajectory-contains` 类 checker 请走 `nyra handover contract check` 单独验。

交接事件进证据链（`team_handover_sent` / `team_handover_received` / `team_handover_accepted`，只记 id 与双方名），beads 账本（`peer-handoffs.jsonl`）记一条 handoff。

文件交接不管内容对错：包到了、接下了，不等于里面的东西是对的。

### 3. 常驻参谋长 1+N 星型枢纽（GROK-1，新缺口 52）

```bash
nyra team create <团队名> --chief <参谋长> --members <成员1,成员2,...>
nyra team list [--all]
nyra team show <团队名或 id>
nyra team add <团队名或 id> <成员>
nyra team remove <团队名或 id> <成员> # 至少留一个成员
nyra team dissolve <团队名或 id> [--yes] # 解散是终态
nyra team dispatch <团队名或 id> "<任务>" [--dry-run]
```

规则：

- 团队账本 `~/.nyra/teams.json`（原子写 0600，损坏先备份再抛错），最多 8 个成员，参谋长不能同时是成员，同名 active 团队不重复。
- 参谋长独占入口：只拆解、分派、汇总，不写业务代码；下游专职 agent 各做执行，只回简报。
- 下游之间不直接互发指令：只有参谋长能分派（`delegateDetailed` 的团队门：非参谋长调 delegate 直接拒绝；分派须指定 `agent`，只认团队成员；成员接单须有完整 Charter）；成员之间要交接只通过参谋长或 beads 交接。**例外（H-7 嵌套编排）**：被参谋长授予 `orchestrator` 角色的成员也能再往下分派（委派时传 `orchestrator: true`，仍须指定 `agent`、仍须完整 Charter；没授予的成员调 delegate 仍被团队门拒绝，收到的还是这条团队门文案）。
- 分派是 `delegate` 工具的 `agent` 参数（只认团队成员）与 `delegate_parallel` 每条线程的 `agent` 参数；内部机械步（H-5 合并子 agent）走 `internal` 旁路，不走分派门。
- 参谋长的上下文是瓶颈：只收摘要不收全文。`buildChiefTask` 给参谋长的任务文本写明了这六条（拆解、分派、汇总；只派给名单里的成员；下游不互发指令；只收简报；对外动作回参谋长/人批；拆错了全队白跑，不能拆就直接说）。
- 分派前三道门（`planTeamDispatch`，不调模型、不花 token）：团队须 active、参谋长与每个成员的 Charter 须完整、月度硬顶（组织级 + 分层，`checkAutoAllowed`）须没触顶；不过直接拒绝，连参谋长都不起。`--dry-run` 只出计划，不跑模型。
- 参谋长是单点瓶颈与单点故障，拆错了全队白跑；本身也要受月度硬顶约束。分派跑的是一个 chief run（工作目录落在参谋长自己的电脑 workspace 里），有运行记录可查。
- 叫法按 Nyra 自己的 Soul / peer / kanban 词汇来，不抄“参谋长—经理—工作者”叫法与 GrokBot 名字（Soul 身份名用“参谋长”可以，那是 Nyra 自己的 Soul 命名）。

### 4. 外发审批门进团队模式（GROK-3，缺口 51 + 43 接线）

接线活，不是新建：Nyra 已有红线与审批，这条是把它们接进团队模式。

团队模式下，任何子代理 / 下游 Bot 的对外通信、采购、删除、发布，一律回主 agent / 人批，不由子代理自批。门在 `checkApproval` 里，位置在 Soul invariant 之后、权限规则 allow 快路与幂等重试短路之前：deny 规则仍生效，allow 快路与幂等短路不走，full 模式同样不放行。门本身不判断对错，只拦住等人看。

拦的范围（`teamApprovalRequired`，纯函数）：业务动作映射到的工具（目前是 `gmail_send` → 发消息）+ 对外工具表（`slack_send`、`http_post`、浏览器/电脑操作）。本地读写与 shell 不在门内。参谋长自己的对外动作不走门（门后就是他与人）；没进团队模式不走门。

审批卡上写清“谁替谁申请、为什么”（`<成员> 替团队 <名> 申请 <工具>（<动作>）：<摘要> —— 团队模式下对外动作一律回参谋长 <名> / 人批，不由子代理自批。`）。有审批桥（Bot / 网页端）时走它，批了就放行（不记“始终允许”规则——团队门每次都要人看）；没审批桥时非交互直接拒绝，交互走终端人工确认。

无审批的自主团队绝不允许：Bot 自己招 Bot、自己发、自己买一律禁止。Bot 接线：`config.json` 的 `bot.team`（团队名或 id）配了团队时，Bot 只能是该团队的参谋长或成员（启动时校验，不在团队里直接拒绝启动），且须有完整 Charter；Bot 的 Agent 按团队身份跑（`soulAgent` = Bot 的 agent、`teamId`、`teamRole`），对外动作走团队审批门。

## 账本与证据链

- 团队账本 `~/.nyra/teams.json`（0600），审计 `~/.nyra/team-audit.jsonl`（append-only，0600）。
- 交接包与 changelog 落在各 agent 电脑 workspace 的 `handover/` 下（见上）。
- 13 个新运行事件已注册进 EVENT_FIELDS（`soul_charter_set` / `soul_charter_cleared` / `team_created` / `team_member_added` / `team_member_removed` / `team_dissolved` / `team_dispatched` / `team_handover_sent` / `team_handover_received` / `team_handover_accepted` / `team_approval_requested` / `team_approval_decided` / `team_charter_verified`），只记元数据与 id，不记任务原文、不记交接包内容、不记绝对路径；`src/timeline.ts` 加渲染。

## 已知局限

- 参谋长是单点瓶颈与单点故障，拆错了全队白跑，只收摘要不收全文。
- Charter 写得再好模型也可能不遵守，抽查是确定性启发式检查、只核说法不验语义。
- 文件交接不管内容对错，内容对错仍由 verifier + 人批负责。
- 团队审批门只拦对外动作，不拦本地读写与 shell。
- 真实多 agent 场景只在假 provider 上验过；模型调用的取消已接通
  （可靠性打磨第 1 项第一批：/stop、超时、预算触顶都发取消信号，
  见 `docs/cancellation.md`）。
- Windows/macOS 真机未验证。
