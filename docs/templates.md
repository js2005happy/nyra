# 业务流程模板库（缺口 46）

把跨系统业务流程做成可复用、可试跑、可审批的模板包，随机器人市场分发。

## 一个模板是什么

模板是声明式纯文本文件（YAML/JSON，Git 友好、可 diff、可审），不是黑盒。每个模板含四件套：

- **流程 DSL**：缺口 25 的工作流定义（`workflow` 一节，`name` 须与模板名一致）；
- **所需连接器**：`connectors`，缺口 44 的目录声明（须是目录里有的连接器）；
- **验收标准**：`acceptance`，缺口 29 的 checker 口径（须是 `nyra handover checkers` 列出的已知 checker，如 `has-changes`、`file-exists:草稿.txt`）；
- **试跑数据**：`trial.inputs`（须是流程已声明的输入）与 `trial_files`（试跑前落盘，已有的用户文件绝不覆盖）。

模板里还须写明两张表，直接引用缺口 51 的红线表，不另起一套：

- `approve_actions`：哪些业务动作永远须人批（如 `send_message`）；
- `never_actions`：哪些业务动作永远禁做（如 `pay`、`delete`）。

## 两道门

复用缺口 25 的 trial/activate，不另起一套：

1. **试跑**：`nyra template trial <名字> --yes`，拿真实数据真执行一遍（写/发动作都会真发生，须 `--yes`）。跑通才记 `trial_passed`；试跑报告进证据链（跑了哪几步、读了什么数据、会写什么、会发什么），验收标准逐项打分，不过不让激活。失败的试跑可直接重跑；等审批的试跑先在工作流里批了再续跑；已试跑过直接认上一次的运行（改输入须先 remove 再导入）。
2. **激活**：`nyra template activate <名字> --yes`，人工确认后才 `active`。激活后每次执行仍走审批（起草可自由做，发出须人批——审批节点在流程里）。

**静态可验的审批覆盖**：凡是业务动作落在 `approve_actions` 里的工具步骤，它前面（同一层步骤表里）必须有一个审批节点，否则导入时直接拒绝。红线表禁做的步骤同样在导入时就拒绝，不等到跑起来才拦。执行前还会重核一次用户当前的红线表——用户收紧红线后，已激活的模板也不许绕过。

模型节点（`llm` / `delegate` / `skill`）的动作 dry-run 无法枚举，审批覆盖只核工具步骤——这是诚实边界，不是漏洞：模型节点的动作在运行中仍走审批链。

## dry-run

`nyra template dry-run <名字>` 只列会写/会发什么，不执行（复用缺口 25 的 dry-run 口径）。

dry-run 不知道前面步骤的输出是什么：走过的步骤记一个占位输出（`<模型输出，dry-run 未知>` / `<工具输出，dry-run 未知>`），后面的步骤引用 `{{steps.<id>.output}}` 时按占位渲染，不炸；占位进计划文本，使用者一眼能看出这是未知值。`if` 条件引用了前面步骤的输出、dry-run 无法判定时，按会执行列出并注明，不直接炸掉整个计划；真正写错的 `if`（语法错、类型错）仍抛错。

## 内置模板（首批 5 个）

| 模板 | 流程 | 须人批 | 永远禁做 |
| --- | --- | --- | --- |
| `shop_order_followup` | 店铺订单异常跟进（Hollow & Scale）：订单号直查 Shopify 订单、核对物流、起草客户回复、等批发出 | 发消息 | 付款、删除信息 |
| `overdue_invoice` | 逾期发票催款：读逾期发票表、起草催款邮件、等批发出 | 发消息 | 付款、删除信息 |
| `expense_review` | 费用报销审核：按政策读报销单、汇总核对结果，等批 | — | 付款、删除信息 |
| `onboarding` | 新员工入职：读手册答疑、写账号开通清单与跟进事项 | — | 删除信息 |
| `meeting_followup` | 会议纪要转跟进：读会议纪要、提取跟进事项与负责人、写成跟进清单 | 发消息 | 删除信息 |

第一个必须是店铺订单异常跟进——用户自己的店是最好的试跑场，跑通了再推广到通用模板。第一步是订单号直查 Shopify 订单（`shopify_orders` 工具，缺口 44 深化补齐），不再走 Gmail 搜订单邮件。建账号不在入职模板的流程里，须人手工做。

```sh
nyra template import --builtin shop_order_followup   # 只装草稿
nyra template trial shop_order_followup --yes        # 真实数据试跑，报告进证据链
nyra template activate shop_order_followup --yes     # 试跑通过且验收全过才能激活
nyra template run shop_order_followup --input order_id=ORD-123
nyra template dry-run shop_order_followup            # 只列会写/会发什么
```

## 随机器人市场分发

市场 kind 加 `template`，复用市场的验证信封与安装策略，只接线、不重写市场：

- **清单校验**：模板文件解析 + 校验（名字/版本须与索引一致；工具名须已知；连接器/验收/红线动作须已知）。
- **确定性规则**：第三方模板禁 `shell` 与 `http_post` 工具步骤（业务流程不该跑任意命令或对外发请求）；其余高危模式与技能/机器人同一套扫描。
- **独立审查**：与技能/机器人同一道门。
- **安装**：只装草稿（状态 `draft`），激活前须试跑 + 人工确认；`--yes` 不跳过市场安装的确认。卸载走 `nyra market uninstall <名字>`。
- **发布**：`nyra template publish <模板名|文件> [--license <许可证>] [--dry-run] [--out <目录>]`，走市场三道门 + 脱敏检查；`market-entry.json` 是给维护者的索引片段。
- **Bot Ready**：模板不参与评分（模板的“就绪”是试跑 + 人工确认，不是静态分），自评恒为 0/100 并注明原因。

```sh
nyra template install shop_order_followup           # 从市场装（只装草稿）
nyra market list                                     # 模板条目显示为“业务流程模板”
```

## 文件与账本

- 模板定义：`~/.nyra/templates/<模板名>.yaml`（或 `.json`），0600。
- 账本：`~/.nyra/templates.json`，原子写 0600，损坏先备份（`.corrupt-<时间戳>`）再抛错。
- 模板内嵌的工作流同步进工作流注册表（`~/.nyra/workflows/<模板名>.json`，定义以模板文件为准；内容对不上直接拒绝，改模板须先 remove 再导入，不静默覆盖已试跑过的流程）。
- 试跑报告：证据链 `evidence/templates/template_trial/`。
- 生命周期事件没有运行上下文时走 `evidence/templates/` 下的证据文件（与审阅队列的证据回落同款口径）：只记模板 id、名字与状态变化，不记目标全文、不记绝对路径、不记客户信息原文。

## 命令

```sh
nyra template list [--builtin]        # 列出已装模板（--builtin 列内置模板）
nyra template show <名字>             # 看一个模板的流程、连接器与红线
nyra template builtin <名字>          # 打印一个内置模板的全文
nyra template import <文件>           # 从文件导入模板（只装草稿）
nyra template import --builtin <名字> # 装入一个内置模板（只装草稿）
nyra template trial <名字> [--input k=v ...] [--max-cost 2] --yes
nyra template activate <名字> --yes
nyra template run <名字> [--input k=v ...] [--max-cost 2]
nyra template dry-run <名字> [--input k=v ...]
nyra template remove <名字> --yes     # 删除模板（含它同步的工作流）
nyra template publish <模板名|文件> [--license <许可证>] [--dry-run] [--out <目录>]
nyra template install <市场条目 id> [--force]
```

## 诚实边界

- 审批覆盖只核工具步骤：模型节点的动作 dry-run 无法枚举，运行中仍走审批链。
- 验收标准只验 checker 能验的：`has-changes` / `file-exists:` 这类程序核对，不验语义——草稿写错了东西、验收项本身写错了，照样判通过，标准本身对不对靠人审。
- 试跑报告只拼已有证据，不重新判断：巡查结论错了简报照抄也会错，窗口外的事不进简报——试跑报告同理，跑了什么就记什么。
- 真 API 未跑通，只在假 provider 与本地确定性检查上验过；Windows/macOS 真机未验证。
