# 常驻责任巡查（缺口 8）

## 这是什么

常驻责任制：给 Nyra 领一份**持续责任**——一份目标、一份复查节奏、一份汇报条件。守护进程每轮按节奏巡查一次：目标还好吗？有问题吗？发现问题先记进证据链再汇报，而不是直接动手改。

> **缺口 45（持续责任语义）**：责任从“目标 + 节奏 + 汇报条件”升级成一份**显式对象**——归属人、验收标准（done_when）、升级条件（escalate_on）、过期时间（expires_at）、生命周期（进行中/暂停/已完成/已取消/已过期），外加每天早上的一份**晨间简报**（昨夜进展、今日待决策、异常提醒，每条结论附来源；无事安静，不打扰人）。调度器还是那个调度器，变的是语义：用户交的不再是一次提示，而是一份责任。

> **无人值守时强制只读是硬约束**：巡查在架构上就不能写、不能发，而不是靠模型自觉。写操作在工具层直接拒绝（`checkApproval` 的 `unattended` 分支，在权限规则之前），巡查 Agent 的模式锁定 `readonly`，`setMode` 不得离开只读。责任存储里**没有“可写”档位**——校验层拒绝任何 `mode` 键，巡查没有可写选项可以选。

## 责任的要素

| 要素 | 说明 |
| --- | --- |
| 目标（goal） | 一句话说清这份责任看什么，≤ 8000 字 |
| 复查节奏（every_seconds） | 每隔多久巡查一次，最小 60 秒 |
| 汇报条件（report） | `on-finding`（默认：有发现才汇报）或 `always`（每次都汇报） |
| 权限上限 | 永远只读。没有例外，没有开关 |
| 归属人（owner） | 这份责任归谁，默认 `user`，≤ 100 字 |
| 验收标准（done_when） | 完成门：全过才能标完成。每条 1–200 字，最多 20 条；带冒号的按 checker 跑（须是已知 checker，如 `file-exists:报告.md`），不带冒号的是纯文本条目，须人 `--yes` 确认 |
| 升级条件（escalate_on） | 用户写明的子串（每条 1–200 字，最多 20 条）：巡查发现里命中了就进审阅队列等人批，不是模型自己决定要不要打扰人 |
| 过期时间（expires_at） | ISO 时间；到期自动失效，不永久驻留记忆 |
| 生命周期（status） | `active`（进行中）/ `paused`（暂停）/ `completed`（已完成）/ `cancelled`（已取消）/ `expired`（已过期）；后三者是终态 |

责任存在 `~/.nyra/responsibilities.json`（原子写 0600，损坏先备份再报错；名唯一）。每条责任还记：最近一次巡查时间、结论（有发现/无发现/失败）、最近一次摘要。老责任读出来自动回填新字段（没写 status 的按 enabled 推断：禁用过当暂停，没禁用过当进行中）。

## 用法

```bash
# 领一份责任：每 10 分钟看一眼依赖有没有可用的安全更新
nyra responsibility add --name 依赖安全更新 --goal "检查 package.json 里的依赖有没有可用的安全更新，有就记下来" --every 600

# 只在有发现时汇报（默认）；每次都汇报：
nyra responsibility add --name 磁盘空间 --goal "检查工作目录所在磁盘的剩余空间，低于 20% 就汇报" --every 3600 --report always

# 立刻巡查一次（不等下一轮）
nyra responsibility check --name 依赖安全更新

# 列出、停用、启用、删除
nyra responsibility list
nyra responsibility disable --name 依赖安全更新
nyra responsibility enable --name 依赖安全更新
nyra responsibility remove --name 依赖安全更新

# 缺口 45：领责任时一次写清归属人、验收标准、升级条件、过期时间（逗号分隔）
nyra responsibility add --name 盯报价 --goal "每天看一眼供应商报价页，变了就记下来" --every 86400 \
  --owner 小明 --done-when "file-exists:报价记录.md" --escalate-on "涨价,下架" --expires-at 2026-12-31T00:00:00Z

# 缺口 45 深化：建好后改复查节奏 / 汇报规则 / 升级条件 / 过期时间 / 归属人
# 只改传了的项，没传的不动；--expires-at none 是清掉过期时间（不过期）。
# 改完重跑全量校验（--every 仍须 ≥60 秒、验收标准仍须是已知 checker）；
# 已完成 / 已过期 / 已取消的终态责任拒绝改。
nyra responsibility set --name 盯报价 --every 3600 --report always --owner 小明
nyra responsibility set --name 盯报价 --escalate-on "涨价,下架,断货"
nyra responsibility set --name 盯报价 --expires-at none

# 列表带下次巡查与到期标记（相对时间，不写死日期）
nyra responsibility list
# 依赖安全更新	active	user	每 600 秒	待首次巡查	不过期	有发现汇报		检查依赖有没有可用的安全更新

# 生命周期：暂停、恢复、完成、取消（完成须验收标准全过；取消是终态）
nyra responsibility pause --name 盯报价
nyra responsibility resume --name 盯报价
nyra responsibility complete --name 盯报价
nyra responsibility cancel --name 盯报价
# 纯文本验收标准（或没有验收标准）时，complete 须人工 --yes 确认才算数
nyra responsibility complete --name 盯报价 --yes

# 晨间简报：每天早上出一份（昨夜进展、今日待决策、异常提醒），无事安静
nyra responsibility brief
# 只看上一份已生成的简报，不重新生成
nyra responsibility brief --show
```

巡查由守护进程跑（`nyra schedule daemon`）：每轮检查哪些责任到期了，到期的进任务队列跑。`nyra schedule run` 只跑一轮，也会巡查到期的责任。没有守护进程在跑时，责任只躺着，不会自己巡查。

## 巡查是怎么跑的

1. 守护进程每轮找出到期的责任（`last_check + every_seconds ≤ 现在`），逐个跑。
2. 每个责任经**任务队列**入队（`mode: "readonly"` + `unattended: true`），由 `runOne` 以只读 Agent 执行。巡查提示词 = 目标 + 只读硬约束 + 最后一行固定结论 `巡查结论：有发现/无发现`。
3. 结论从最后一行结论行解析；**模型没写结论行时按“有发现”处理**（fail-closed：宁可多汇报一次，不可漏报）。巡查任务不配 verify 命令，完成状态是 `completed_unverified`（跑完了、没走验证步骤），不是失败。
4. 结论记 `patrol_report` 事件进证据链（哪个责任、哪次运行、有没有发现、有没有汇报）。**汇报条件只控制收件箱通知，不控制证据**：没发现的巡查同样留一条报告事件。
5. 按汇报条件写收件箱：`on-finding` 只在有发现时写；`always` 每次都写。收件箱条目就是 `nyra task list` 旁边那份待办（`~/.nyra/inbox.json`）。
6. 单个责任跑的时候抛错（模型报错、任务异常），只记 `last_status: "error"`，不破坏整轮——其他责任照常巡查。如果任务没抛错但终态不是 completed（比如轮次耗尽），结论仍按输出解析、按汇报条件处理（没结论行按“有发现”汇报，不让一次没结论的巡查悄悄过去）。
7. 只读巡查不应该走到审批：如果任务终态是 `awaiting_approval`，巡查抛错（说明有地方想写东西，约束出了问题）。

## 只读是怎么锁死的

四道防线，任何一道都能拦住写操作：

1. **存储层没有可写档位**：责任校验拒绝任何 `mode` 键；`addTask` 里 `unattended: true` 时模式强制 `readonly`（调用方传 `auto` 也按只读落盘）。
2. **Agent 层锁定**：`AgentOptions.unattended` 为 true 时，构造函数把模式强制为 `readonly`；`setMode` 不得离开 `readonly`；委派出的子 agent 继承 `unattended`（纵深防御：巡查不能把写活外包给子 agent）。
3. **工具层直接拒绝**：`checkApproval` 里 `unattended` 检查在权限规则之前——就算权限规则写了 allow，也打不开无人值守的写操作。被拦的写操作记 `patrol_write_blocked` 事件（哪个工具、为什么拦）。
4. **队列层不给审批留口子**：巡查任务以 `quietInbox: true` 跑，不写默认收件箱入口；终态 `awaiting_approval` 即抛错。

## 晨间简报是怎么拼的

`nyra responsibility brief` 每天早上跑一次（定时任务或手动都行），只读拼证据，不调模型、零 token：

1. **窗口**：自上次简报起，最多回溯 24 小时（账本丢了或太久没简报时最多回溯 7 天，不无限追溯）。
2. **昨夜进展**：窗口里各次巡查的 `patrol_report` 事件（有发现的逐条列出，附“来源：巡查「X」，run …”）+ 窗口里完成的责任。
3. **今日待决策**：审阅队列里所有待批项（每项都须人批，不由模型代劳），附“来源：审阅队列 …”。
4. **异常提醒**：巡查命中的升级（附条件与审阅队列项 id）+ 窗口里过期失效的责任 + 巡查失败的责任。
5. **先记证据链再汇报**：全文进 `evidence/briefing/`，正文存 `~/.nyra/briefings/<日期>.md`（0600），收件箱只留一条指针（进展几条、待决策几项、异常几条）。`brief --show` 重看上一份。
6. **无事安静**：三节全空时回 NO_REPLY——不写收件箱、不建 task 记录、不发消息，只留一条审计，账本照常推进窗口，下次简报不再重复扫同一窗口。

## 证据链

- `patrol_report`：每次巡查一条（责任 id/名、运行 id、结论、是否汇报）。
- `patrol_write_blocked`：巡查里每次被拦下的写操作一条（工具名、原因）。
- `responsibility_paused` / `responsibility_resumed` / `responsibility_cancelled`：生命周期变化（责任 id/名）。
- `responsibility_completed`：标完成（责任 id/名、验收通过/未通过各几项）。
- `responsibility_expired`：到期自动失效（责任 id/名）。
- `responsibility_escalated`：巡查命中用户写明的升级条件（责任 id/名、命中的条件、审阅队列项 id）。
- `briefing_generated`：简报生成（日期、进展/待决策/异常各几条、无事安静时 quiet 为真）。
- 生命周期事件没有运行上下文时走 `evidence/responsibility/` 下的证据文件（与审阅队列的证据回落同款口径），不静默丢审计。
- 网关 `GET /api/responsibilities`：只返回元数据（名、节奏、汇报条件、上次巡查），不含责任目标——桌面端管理页在 `desktop/`。

## 诚实边界

- **巡查发现的问题不会自动修**：巡查只汇报。修不修、怎么修，由人决定（或另开一个有人在场的任务）。这是设计，不是缺口。
- **结论行靠模型写**：`巡查结论：有发现/无发现` 是提示词里的约定，模型不遵守时按“有发现”处理（多汇报，不漏报）。结论的准确性取决于模型当次的判断。
- **升级条件是子串匹配**：命中与否只看巡查输出里有没有出现用户写明的那个词，不看语义——词写窄了会漏升级，词写宽了会多升级，条件本身对不对靠人审。
- **完成门只验 checker 能验的**：`file-exists` 这类看得见的东西程序能验；纯文本验收标准程序验不了，须人 `--yes` 确认——确认本身记进事件，事后可查，但“标准本身对不对”仍靠人审。
- **简报只拼已有证据，不重新判断**：简报不调模型，所以不会“发现”巡查与审阅队列之外的事；窗口外的事不进简报；巡查结论错了，简报照抄也会错——简报保证“每条结论有来源可查”，不保证“结论本身是对的”。
- **轮询是守护进程的节奏**：责任到期后最晚在下一轮守护进程巡查时跑；守护进程没跑，责任就不会巡查。`check` 子命令可立即巡查一次。
- **巡查花 token**：每次巡查是一次模型调用（`--max-turns` 可调，默认 20）。节奏设得太密会烧钱；建议从 600 秒起，按需调密。
- **网关与群聊机器人暂不接责任管理**：责任的增删改只在终端；网关只给只读清单。
- **缺口 10（独立审查层）是下一批**：巡查结论目前由模型自己写、自己判；缺口 10 落地后，巡查报告会先过一层独立审查再汇报。
