# 对话式入职 + 一键角色模板（缺口 35）

Nyra 以前是 CLI 优先：新用户须自己写配置、装技能、定 agent，第一次用要先读文档、写配置、装技能。本批补三件：`nyra init` 对话式入职、`nyra templates` 一键角色模板、首次唤醒就绪简报。

## `nyra init`：三个问题立起来

不加参数时交互问三个问题：

1. **叫什么？**——agent 的名字（默认 Nyra）。
2. **干什么活？**——`1 研究员` / `2 助理` / `3 店小二`，或直接写一句话（自定义角色）。
3. **什么风格、有什么红线？**——比如“说话直接；不对外发消息、不花钱”。

问完出一份**配置清单**（名字、风格、干什么、技能包、Tenet、权限），用户确认后才生效；**没确认不写任何东西**。已有 Soul 时默认不覆盖（要覆盖加 `--force`，覆盖前仍须确认）。

也可以一次写清，不交互：

```
nyra init --name 阿研 --role researcher --redline "不对外发消息" --yes
nyra init --name 阿助 --role custom --work "每天早上帮我看一眼店铺订单" --yes
```

入职完成即第一次唤醒：agent 主动发一条**就绪简报**（我是谁、我会什么、我的红线是什么、本次花了多少 token），走终端 + 机主收件箱。入职不调模型，本次恒为 0 token。

## `nyra templates`：一键角色模板

三个内置角色模板，每个 = Soul（身份 + Tenets）+ 技能包 + 权限规则的打包文件：

| 模板 | 干什么 | 技能包 |
|---|---|---|
| `researcher` 研究员 | 查资料、核实事实，交付带来源的结论 | web-research、verify-research、deep-thinking |
| `assistant` 助理 | 日常杂事：整理文件、起草、排障 | file-organizer、creator-mode、debugging |
| `shopkeeper` 店小二 | 店铺客服与订单跟进：查订单、核对信息、起草回复 | web-research、verify-research、file-organizer |

```
nyra templates list                  # 看有哪些模板
nyra templates show researcher       # 看一个模板的全部内容
nyra templates apply shopkeeper --name 小二 --yes   # 应用一个模板（同样过确认门）
```

模板是**本地文件**，可导出分享：

```
nyra templates export researcher researcher-pack.json
nyra templates import researcher-pack.json --yes   # 导入先验后装
```

导入时先验形状与技能存在性：kind/version 不对、id 顶替内置模板、技能名不认、技能不是内置技能、deny 规则解析不出、prior 带了 deny——有一条不过就**一个都不装**。导入的包存在 `~/.nyra/onboarding-templates/<id>.json`，`list` 里能看到，`apply` 也能用。

## `nyra wake`：唤醒重发简报

入职后随时可以重发一次就绪简报：

```
nyra wake
```

简报内容与入职完成时发的那份一样（身份、能力、红线、token 数），走终端 + 机主收件箱。还没入职时 `nyra wake` 会告诉你先跑 `nyra init`。

## 不要混淆的几组命令

- **`nyra init` vs `nyra setup`**：`setup` 是首次启动向导，配模型与运行环境、跑示例任务；`init` 定身份与角色，不碰模型配置。
- **`nyra init` vs `nyra vault init` vs `nyra soul init`**：`vault init` 建密码箱；`soul init` 只建一个空 Soul 文件；`init` 是完整入职（Soul + 技能包 + 清单确认 + 就绪简报）。
- **`nyra templates`（复数）vs `nyra template`（单数，缺口 46）**：前者是**入职角色模板**（Soul + 技能包 + 权限规则）；后者是**业务流程模板**（流程 DSL + 连接器 + 验收标准 + 红线表引用）。用途不同、格式不同、命令不同，不合并、不互相改名。

## 技能包怎么装

按角色预装技能包 = 把随仓 `skills/` 目录里的技能文件拷进 `~/.nyra/skills/`。已经在那里的不覆盖（不顶替用户改过的版本）；源目录缺文件时整体拒绝、不装一半。**不从网上拉取、不走厂商 Hub、不注册、不上传**。

## 账本与证据链

- 账本 `~/.nyra/onboarding.json`（原子写 0600，损坏先备份再抛错）：agent、角色、模板 id、装了哪些技能、简报发过没有。
- 技能装在 `~/.nyra/skills/<技能名>.md`；自定义模板包存在 `~/.nyra/onboarding-templates/<id>.json`。
- 3 个新运行事件已注册进 EVENT_FIELDS（`onboarding_completed` / `onboarding_template_applied` / `onboarding_ready_briefing`，`src/timeline.ts` 加渲染），每次入职、应用模板、发简报都单独建一条证据运行，只记 agent、角色与模板 id，不记三问答案原文。

## 已知局限

- 就绪简报只发给机主本人（终端 + 收件箱）；直接推到 Telegram/Discord 等外部渠道须 Bot 已接通（缺口 27），本批不接线。
- 模板包只能引用随仓的六个内置技能（web-research、verify-research、deep-thinking、debugging、file-organizer、creator-mode）；`authorized-bughunt` 是授权漏洞挖掘技能，不进任何角色包。
- 真 API 未跑通，只在假 provider 与本地确定性检查上验过；Windows/macOS 真机未验证。
