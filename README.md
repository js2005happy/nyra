<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/nyra-mark-dark.svg">
    <img src="docs/assets/nyra-mark.svg" width="72" height="72" alt="Nyra">
  </picture>
</p>

<h1 align="center">Nyra</h1>

<p align="center">
  <b>一个跑在你电脑上的开源 AI Agent：读懂项目、改代码、跑命令、联网查证，每一步都先问你。</b><br>
  <sub>An open-source AI agent that works on your machine and asks before every action.</sub>
</p>

<p align="center">
  <a href="https://js2005happy.github.io/nyra/">官网</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="GUIDE.md">完整手册</a> ·
  <a href="ROADMAP.md">路线图</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <img alt="Node 单文件二进制" src="https://img.shields.io/badge/node-single%20binary-0B0B0C">
  <img alt="测试" src="https://img.shields.io/badge/tests-node%20suite-0B0B0C">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-0B0B0C">
</p>

<p align="center">
  <img src="docs/assets/screenshots/mac.png" alt="Nyra 桌面端：会话、审批与 diff 审核" width="100%">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/windows.png" alt="Nyra for Windows"></td>
    <td width="50%"><img src="docs/assets/screenshots/ios.png" alt="Nyra for iOS"></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/assets/screenshots/android.png" alt="Nyra for Android"></td>
  </tr>
</table>

<p align="center"><sub>桌面端与移动端界面设计稿（macOS · Windows · iOS · Android），图中数据为示例。目前可用的是命令行与本地网页界面。</sub></p>

---

## 为什么是 Nyra

| | |
|---|---|
| **先问再做** | 写文件、跑命令默认逐项审批；`auto` / `readonly` / `full` 三种模式随时切换。 |
| **改错了能退** | 每次写入前自动存检查点，`/undo`、`/rewind 3` 一键回到之前，绝不覆盖别人的修改。 |
| **先计划，后执行** | `--plan` 只读生成 `plan.md`，你用 SHA-256 批准那一版，改一个字节旧批准就失效。 |
| **说话有出处** | 联网抓到的原文存为证据，结论必须附来源链接。 |
| **任意模型** | DeepSeek、Grok、OpenAI、通义、Kimi、智谱、Gemini、本地 Ollama 等 14 个预设，也能接本机 Codex 登录态；失败可自动换备用（默认关闭）。 |
| **并行产出先验收再合入** | 群聊多一个验收者角色：子 agent 的产出先过检查清单与模型复核，不通过打回重做 1 次，验收结论进证据链；默认关闭（`nyra verifier enable` 开启）。 |
| **性能优先** | 开箱即用，`git clone` 完就能跑；热点路径按性能选择最合适的语言实现。 |

## 0.4.1 更新了什么

0.4.1 是一次安全加固更新，没有改常用功能，升级后照常用（详细技术记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **密码箱更难破解**：加密强度从 20 万次提到 60 万次，旧密码箱下次解锁时自动升级，不用你动手，解锁只慢约 0.4 秒。
- **主密码至少 8 位，输错 5 次会暂时锁住**：防别人乱猜你的密码，正常用不受影响。
- **配对的设备 180 天不用会自动失效**：丢了的旧手机连不上，常用设备一直用就一直有效。
- **配对码还是 6 位，好记**：错 5 次就作废，暴力猜码猜不进去。
- **联网取网页时，内网地址会被拦住**：防模型被骗去摸你内网的服务，正常上网不受影响。
- **只读操作默认只能看工作目录里的东西**：读文件、列目录、搜内容都一样，想看外面要自己放开。
- **群聊里各机器人的 Key 不再明文存文件**：改存进密码箱或本机加密，旧文件读到就自动转加密。
- **聊天记录导出存档时，里面的 Key、私钥会被删掉再存**：私钥整段删干净。
- **危险命令黑名单更严了**：`rm -r -f /` 这种变着花样的写法也能拦住，同时文档里写明它不是沙箱、拦不住存心绕过的人。
- **首次启动向导输 Key 时屏幕上只显示 `*`**：Key 只显示后 4 位；已有 Key 可以一键迁进密码箱，不用再明文躺在 shell 配置里。
- **桌面版第二次打开会直接回到已开的窗口**：不会再起一个重复的程序。
- **Windows 安装脚本加了卸载开关**：`.\install-node.ps1 -Uninstall` 一键卸载；桌面“网页界面”快捷方式指向的 `nyra ui --open` 是真实命令，点开就能用。

## 0.5.0 更新了什么

0.5.0 是一次“更好用、更省钱、更安全”的更新，常用功能照常用（详细技术记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **多了 Hooks 钩子：检查不再只靠模型自觉**：工具动手之前、之后可以跑你自己写的检查脚本，不合规的直接拦住（比如写文件前先拦下含 TODO 的内容）；默认一个钩子都不装，装了才生效，钩子出问题也不会把正常任务拖死。
- **技能更省 token 了**：技能平时只留一句话简介，用到哪个才读全文；碰到匹配的文件，相关技能会自动加载，长会话更省钱、更快。
- **上下文终于看得见了**：`/context` 一眼看到上下文被系统提示、技能、对话、工具结果各占了多少；压缩后自动把你的记忆和规则读回来，不会丢；`/compact focus` 可以指定留住某部分内容再压缩。
- **命令默认进沙箱跑（Linux）**：只能动工作目录里的东西、默认断网，模型想干坏事也干不成；没装 bwrap 或在 Windows/macOS 上会自动退回工具级限制，并明确告诉你现在是哪一级隔离，不会悄悄裸奔。

## 未发布（0.5.4）更新了什么

0.5.4 是一次“对外连接 + Bot 方向起步”的更新，常用功能照常用（详细技术记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **别的 agent 也能当 Nyra 的 Bot 接进来了**：`nyra agui register <名字> <地址>` 登记一个外部 AG-UI endpoint，绑上名片好友、过了信任圈准入、握手成功就能连上（只读接入，能看任务产物、不能写）；`nyra agui send` 发消息走 AG-UI 事件流，对方回的工具调用只当提议记下来、不执行；想请对方动手干活（`nyra agui exec`）须机主先显式接受（`accept-write --yes`），没接受就直接拒绝；对方发来的任何内容先过注入扫描，可疑的就地拦截进证据链。A2A 对端用 `nyra agui a2a <好友名> <消息>`（复用名片 + 交接，照样先过信任圈与审查门）。详见 `docs/agui.md`。但这批只在假 endpoint 上验过，真 AG-UI 服务还没接通过；Nyra 的 Bot 对外暴露成 AG-UI endpoint 是下一批。
- **Bot 的屏幕能看了（只读），在干什么、下一步干什么一目了然**：`nyra screen watch <电脑 id>` 看一帧实时画面——正在看哪个页面、最近在做什么，只记帧指纹、不记帧内容、不截图；`nyra screen activity <电脑 id>` 列活动列表，正在做什么取活动账本最新一条，下一步取关联运行的时间线阶段（等审批/卡住/等审阅/进行中/空闲），没有关联运行就明说看不到、不编一个。画面只对机主与信任圈成员可见，画面里出现密码、验证码、卡号时自动打码（只记打了哪几类，不记原文、不留存）。详见 `docs/bot-screen.md`。但本机没有真实浏览器画面，本批是假画面模型——画面描述是活动摘要的确定性文本，不是模型看图的结果；人接管操作（take the wheel）是第二批，本批只有只读看屏。
- **每通电话都有三本账可查了**：`nyra call ledger` 列全部通话账，`nyra call show <通话 id>` 看一通的完整账，`nyra call summary` 看合计——传输用了多少带宽、看了几帧、STT 几分钟、理解与干活各花多少 token，本地模型（whisper.cpp、本地小视觉模型）与云端分开记，本地不花钱但账里分得清；录制默认关，只有全体同意才开始计录制账，谁撤销同意就停录，新加入的人须另行同意；每通电话结束出一份纪要进证据链（谁参加、何时、时长、三本账汇总、委派了什么任务），不含通话内容原文。账本只记用量数字。但传输账是本地模型数（语音回环记 0，视频记信令面实测字节数），没有真 TURN/STUN 带宽计量；按人拆分的成本分摊是后续批次。详见 `docs/call-ledger.md`。
- **Nyra 能当 MCP 服务器了**：别的 agent 可以经网关调 Nyra 的记忆读写、任务派发与证据查询；写操作默认关闭，开了也要过独立审查。
- **并行委派默认后台跑，跑完合成为一份交付物**：`delegate_parallel` 现在默认后台跑（立即回 handle，聊天继续），跑完单条 consolidated 消息回填，扇出直接落任务板（重启不丢），跑完了没回填由 Heartbeat 提醒；`merge: true` 时批跑完多一次合并步，把各线程的结构化摘要合成一份交付物，过 verifier 确定性检查再进审阅队列人批。`nyra fanout <list|show|recover>` 查与回收跑一半的扇出。
- **团队模式来了（常驻参谋长）**：一个参谋长独占入口，只拆解、分派、汇总，不写业务代码；下游专职 agent 各做执行，只回简报。每个成员先有一份角色契约（Charter：负责什么、信息来源、输出格式、审批门、停下条件，`nyra soul charter set`），没完整契约接不了单；成员之间用 inbox/outbox/changelog 交接文件（落在各 agent 自己的电脑 workspace 里，不共用一台电脑）；下游的对外动作（发消息、采购、删除、发布）一律回参谋长/人批，不由子代理自批。`nyra team <create|list|show|add|remove|dissolve|dispatch|handover>`，详见 `docs/team.md`。参谋长是单点瓶颈与单点故障，拆错了全队白跑；Charter 写得再好模型也可能不遵守，交付时只做确定性抽查，内容对错仍由验收与人批负责。
- **子 agent 也能分层拆任务了（默认不开）**：大任务不用父级一次拆到底——委派时传 `orchestrator: true`，子 agent 才能再往下派，最多嵌套 2 层（`config.json` 里 `delegate_max_depth` 可配 1–5）；不传就是 flat，子 agent 再派直接被拒。**每层预算各算各的**：每层 8 个子 agent 名额，第 0 层用满不挤占第 1 层；派回已经在链里的人（A 派 B、B 派 A）直接按循环委派拒绝。花名册上能看到每行是第几层，停一个子 agent 照样连子树一起停。层数越深越难控成本与定位问题，别无脑开深。
- **责任有了完整的样子，早上还有一份简报**：`nyra responsibility add` 领责任时能一次写清归谁（owner）、做到什么样算完成（done_when，文件在不在这类看得见的由程序验，看不见的得人点头）、什么情况必须叫你（escalate_on，巡查发现里出现你写的那个词就进审阅队列等人批）、什么时候到期作废；能暂停、恢复、取消（取消是终态），到期自己失效，不永久占着记忆。`nyra responsibility brief` 每天早上出一份晨间简报——昨夜进展、今日待决策、异常提醒，每条都写明来源（哪次巡查、审阅队列哪一项），不调模型所以不花 token；没事就安静，不写收件箱也不发消息。详见 `docs/responsibilities.md`。但升级条件只是子串匹配，词写窄了会漏、写宽了会多；简报只拼已有的证据，巡查结论错了简报照抄也会错。
- **长任务有了“完成”的明确定义**：`nyra goal create "上线 0.5.4" --item "跑通全量" --item "推上 main"`——目标陈述 + 动态进度清单 + 逐项验证，清单每一项都要附证据（方法 + 结论）才算通过，全部通过才能标完成，任务板行全做完不算、模型自己说完了也不算；中途加指令（`nyra goal instruct`）不会把进度清掉；能暂停、恢复（恢复前重验证，证据失效的项退回待做）、取消（取消是终态）。但清单本身是模型自己拆的，清单拆错了目标就错了——建目标时先看一眼清单有没有漏项，比事后验一百遍都有用。
- **新 agent / 新技能先从只读干起，干好了再放手**：信任阶梯（`nyra trust register agent <名字> --yes` 登记，默认只读）。想发消息先攒够 5 次连续成功升到发送级，想碰付款先升到购买级；每次记成功有 10% 概率被随机抽查，抽中了要人复核才算数，驳回按违规算；出了事随时可以降级，先降下来再查。没登记的老 agent 不受影响，该怎么跑还怎么跑。
- **跨系统业务流程可以存成模板复用了**：`nyra template import --builtin shop_order_followup` 装一个模板（流程 DSL + 连接器 + 验收标准 + 试跑数据，纯文本文件），先 `trial --yes` 拿真实数据试跑一遍（报告进证据链，验收逐项打分），过了人确认一次才 `activate`；激活后每次执行仍走审批，发出须人批。首批 5 个模板，店铺订单异常跟进打头（查订单邮件、核对物流、起草客户回复、等批发出），还有逾期发票催款、费用报销审核、新员工入职、会议纪要转跟进。模板随机器人市场分发（`nyra template install/publish`），第三方模板禁 shell 与对外发请求。详见 `docs/templates.md`。但审批覆盖只核工具步骤，模型节点的动作运行中仍走审批链；验收只核程序能核的，标准写错了全过也是错的。
- **新用户不用先读文档了，三问就能把 agent 立起来**：`nyra init` 问三个问题（叫什么、干什么活、什么风格/红线），生成身份文件、按角色装好技能包，出一份配置清单给你确认后才生效；还有一键角色模板（`nyra templates`：研究员 / 助理 / 店小二），模板是本地文件，可以导出分享；装好后 agent 第一次唤醒会主动发一条就绪简报（我是谁、我会什么、我的红线、本次 0 token），`nyra wake` 随时能重发一次。详见 `docs/onboarding.md`。但简报目前只发到终端和机主收件箱，推到 Telegram 这类外部渠道要等 Bot 真接通。
- **多人多 agent 可以同场开视频会了**：`nyra session create <标题>` 建一个联合会话，邀已批准且在信任圈里的好友 agent 进会（圈外直接拒绝）；会上交代的事当场变任务（`nyra session delegate --to <成员> --task <任务> --accept <标准>`，验收标准落成一份交付契约，发不出去时任务留在会话账本里、不丢），只共享任务产物与显式打包的上下文（`nyra session share`，记忆、会话历史、密钥与任意本地文件一律不共享）；画面默认不留存（会话结束帧记录就清空），录制要全体在会成员都同意才行。详见 `docs/sessions.md`。但这批的“SFU 转发”是本地扇出模型（不是真 SFU 服务器），没原生 WebRTC 栈、不拨真实电话、媒体面未加密，别当端到端加密用；委派的验收目前只记契约，跑确定性验收是下一批。
- **谁能给 agent 发任务，现在由信任圈说了算**：默认全封闭——没被引进圈的人，发来的消息在网关层直接丢弃，不进 agent 上下文、不耗 token（对方是“收到后拒绝”，Nyra 是“看不见”）。`nyra circle create work` 建圈、`nyra circle invite work <好友名>` 引人（只能由机主或已在圈里的人引，入圈的前提是已批准、未拉黑的好友）、`nyra circle revoke work <好友名> --yes` 撤销（撤销后对方立刻发不进来）；网关按渠道发件人 id 认人，`nyra circle bind --channel telegram --sender <id> --friend <好友名>` 绑定好友、`nyra circle owner` 登记机主，不绑定就一律丢弃。互问、交接、分享也先过这道门：对方不在圈里就不问、不发包、不分享（分享先全员验一遍，不过整批拒绝）。分组圈（`nyra peer circle`，管“我主动发给谁”）和信任圈（管“谁能发任务”）是两套账本，别混了；团队成员是本机内部 agent，走参谋长分派，不过这道门。详见 `docs/circles.md`。但名片拉取的 per-circle 可见性这批没做，名片还是按老口径公开拉取。
- **外部文档也能进知识库被检索了**：`nyra kb add <库> --file <手册.pdf>` 把 PDF、手册、网页收进来（文本/Markdown、PDF 最小抽取、网页抓正文），按标题分块后用 BM25 检索；agent 在运行里调 `knowledge_search`，每条结果都带出处（文档名、章节、分数），检索记录进证据链，能回溯原文；`nyra knowledge test <库> --file <问题文件>` 先拿一批典型问题试召回、调参，调好再接入。详见 `docs/knowledge.md`。但本批只有 BM25，复杂 PDF（扫描件、加密、内嵌子集字体）抽不出可用文本；向量检索与 parent-child 分块是下一批。
- **多步活可以写成工作流复用了**：YAML/JSON 写一次（工具调用、技能、delegate 子 agent、知识检索、LLM 判断 + if/for_each/parallel），`nyra workflow run` 按固定图跑；下一步要看情况定的，用协调者形态——协调者 agent 每轮决定下一步，还能在运行中生成新步骤，研究类任务用动态形态（种子步骤可以为空）；中间要人看一眼就插一个审批节点（进审阅队列，批了再续跑），协调者缺关键信息会自己停下来问人；先 `dry-run` 看它会写/会发什么（模型节点的动作列不出来，会明说；协调者形态下计划步骤只是候选），再 `trial` 拿真实数据试跑一遍，跑通了人确认一次才激活。详见 `docs/workflow.md`。
- **工作流里的纯脚本不用每次都问了**：步骤里的脚本先过白名单静态分析（Python/JS/Lua/PHP 四种语言，64 KB 上限，只认白名单模块与成员，看不懂的一律判不纯），纯的按只读命令走快路径；激活时把纯脚本的内容摘要（`script:<SHA-256>`）钉死——改了内容授权自动失效，跑就拒绝，得重新试跑 + 激活。授权只在例行里有效，不会变成聊天里的“记住批准”。每次没问的原因（纯的、摘要是多少）都写进证据链与审计。`nyra script check <文件>` 先判纯不纯，`nyra script preauth <list|grant|revoke>` 管授权，详见 `docs/script-purity.md`。但静态分析不是沙箱：它只看代码长什么样，不看运行时干了什么，纯脚本照样受 shell 审批的硬边界管。
- **交接先立契约，程序验过了才算交完**：`nyra handover contract create` 立一份交接契约——交什么（交付物清单）、怎么算过（验收项，文件在不在、输出含不含某句话、调没调某个工具）、能改几轮（修正轮次上限，默认 1 轮）；成员交活时 `nyra handover contract check` 由程序逐项核对，不调模型：全过接受、不过打回（给待改清单，改完再交）、轮次用完停下等人（得人看一眼认下或放弃）。`nyra team handover send --contract` 能把契约挂到交接包上，对方 `ack` 时先程序验收，过了才接下，没过包就留在收件箱等改完再交；验收通过给交活方在信任阶梯上记一次成功，打回/停下记一次违规。详见 `docs/handover-contract.md`。但程序只核“文件在不在、验收项过没过”，不看内容对不对——验收标准写错了，全过也是错的。
- **备用模型切换不再静默**：备用模型开着、真切了模型时当场就告诉你——从谁切到谁、原来那家报的什么错、触发原因、什么时候、哪次运行；终端 stderr 一行、网关事件流实时推、群聊回复前面附上。每次切换还记一行审计（`~/.nyra/model-switch-audit.jsonl`，SIEM 导出第 7 个来源），用量汇总里能看到本月切了几次、最近一次从谁切到谁（`nyra stats` / `nyra cost --show` / 运行结束汇总，0 次时不占地方）；`nyra models fallback` 一次看清开关、链顺序与本月统计。备用本身还是默认关、只你开、只切允许列表里的；队列和定时任务照样不切换。
- **四个渠道可以一个网关常驻跑了**：`nyra channels start`——Telegram、Discord、Slack、WhatsApp 一个进程全接上，入站消息先过 bindings 再分给对应的 agent：哪条群聊归谁、谁只读谁能写、要不要 @、能不能走云端转写，都在绑定里写明（`nyra channels bindings add`），`nyra channels explain` 能离线重放任意一条消息落到谁手里、为什么；没命中任何绑定的落到默认绑定，命中了但不在名单里、群里没 @ 的直接丢弃、不悄悄换人接。每条入站的路由决定都写进 `bot-audit.jsonl`（SIEM 导出第 8 个来源）。渠道会话默认进沙箱（strict 只读断网、standard 可写断网、open 可写放网），对外发送照样走审批门。Telegram 的语音消息能直接当任务了：转文字、干完回文字汇报（本地 whisper 优先，云端须绑定显式开；语音不碰支付与对外发送）。详见 `docs/channels.md`。WhatsApp 目前只做了接入形态与风险说明，默认不启用，真接通等你点头。
- **接单时先定验收标准，跑完逐项打分**：`nyra contract create` 把验收标准写成契约（交付物 + 必填属性 + 检查清单），先 `show` 看一遍、再 `activate --yes` 人点头，跑任务时 `--contract` 挂上，收尾逐项打分进运行报告——全部通过才算“被接受”，有 fail 就是未接受，没评完的（模型项没模型、人工项没标记、复跑忽过忽不过）是待定，不算接受。报告顶部还给三数：检查通过率、每被接受任务成本、三次复核一致性。另有一套 Golden 测试集（`nyra golden add/run/rescore`）：固定输入 + 期望输出 + 期望工具轨迹，跑分看结果分与轨迹分，只作内部回归基线，不对外宣传。详见 `docs/delivery-contract.md`。但契约只保证“标准写清了、结果可查”，不保证“标准本身是对的”——标准写错了，逐项全过也是错的。
- **在跑的任务卡住了会自己喊人**：看门狗（`nyra reconciler scan` 立刻扫、`status` 看状态、`enable` 开自动巡查）定期扫任务板里在跑的任务——超过 30 分钟没动静先标出来、收件箱留一条提醒；下一轮还卡着就自动重排回队列再跑一次（最多 2 次，可配）；重排用完还卡着就停下进 blocked，只等人看一眼，不悄悄丢任务、也不无上限自循环。绑的运行死了走失败路径，运行跑完了只提醒一次（任务标完成还是要附验证证据，不能因为“运行完了”就自动算完），运行在等你批不算卡住。自动巡查默认关，你点头才开；手动扫不受开关限制。详见 `docs/reconciler.md`。但看门狗只量“有没有动静”，不量“动静对不对”——一直在写无意义日志也算有进展。
- **盯页面或文件，变了才喊你**：`nyra watch add --url <地址>` 或 `--file <路径>` 立一个监测，第一次只记基线不吭声，之后内容哈希变了才汇报，格式固定是“变了什么 → 详情 → 来源”（新增/删除几行 + 各最多 8 行摘录 + 来源与时间），写收件箱；目标取不到（文件没了、页面 404、抓失败）会明说缺什么，不静默。想“变了就动手”就另声明条件与动作：`--condition contains:9 月发票`（新内容含这句话才触发）、`--action enqueue-task:<任务>`（触发后把任务推进队列，执行时照常走审批）或 `--action download:<相对路径>`（下载是写操作，触发时只记一条待批准，得你跑 `nyra watch run-action <id> --yes` 才真的下载）。自动巡查默认关，你点头才开。详见 `docs/watch.md`。但监测只量“哈希变了没有”，不量“变化重不重要”——无关紧要的词变了也会报一遍；靠 JS 动态加载的页面可能抓到空壳。
- **手机 APK 构建修好了**：0.5.3 连挂 3 次的原因是 `mobile/package.json` 里缺 TypeScript，补上后本地验证通过。
- **Bot 方向 Phase 1 来了**：Telegram 渠道先跑起来——长轮询收消息、同一会话串行排队、消息去重与配额、/help /status /new /stop 这些指令不走模型；外部用户强制只读，不能写文件、跑命令。
- **Bot 方向 Phase 2 来了**：按人分角色（机主、管理员、受信任用户、默认外部用户），能写什么由角色白名单定；机主和管理员的写操作要逐次在聊天里审批——回 `/approve` / `/reject` 或点按钮放行，超时自动拒绝，非管理员的放行无效；审批绕不过用量硬顶与配额。
- **Bot 方向 Phase 3 来了**：场景 B 的主动推送——定时任务与队列任务跑完后把结果推到 Telegram（默认只推失败），没异常时静默巡查不打扰（月度预算快用完、当天预算用完、队列积压、审批没人批时才提醒），指定文件变了也推一次；发附件不再只回一句“不支持”，纯文本文档会提取内容一起处理，图片只记元信息、不假装看懂。推送默认全关，要显式开才推。
- **连接器授权状态机来了**：Gmail、Shopify、Slack 先以目录形式进来了，每个连接器都声明了它要什么权限、提供什么工具、会碰什么数据；第一次用某个连接器要你显式批准一次，之后就不再重复问；授权过期自动标出来、撤销立即失效。令牌只存在本机密码箱，不交给任何第三方。
- **连接器目录能安装、能一键授权、能量用量了**：`nyra connector install <连接器>` 把连接器登记进你的目录，`nyra connector auth <连接器>` 一键走它自己的授权流程（OAuth 登录即用），`nyra connector uninstall` 卸载时授权同时撤销、访问立即断；`nyra connector usage` 看每个连接器被调了多少次（总次数、分操作次数、最后调用时间），每次调用还记一条运行事件。三个连接器本身没动——Shopify 还是只读、Slack 发消息还是要你批、Gmail 深化还是那套。
- **Shopify 能只读查店了**：自己的店铺商品、订单、库存可以直接查（自定义应用 token，只存本机密码箱，订单输出不含客户邮箱与地址）；改价、改库存、退款这些写操作本批一律拒绝，下一批再做。
- **Slack 也接进来了**：频道和消息能读，发消息要你显式批准才发，挂起的审批能以审批卡发到频道里点批准/拒绝（按钮回调这批只记审计，回写审批桥是下一批）；删消息、改频道、管理成员一律拒绝。
- **Gmail 深化了**：附件能只读下载（图片只记元信息、文本文档提取内容，超 10MB 拒绝、可执行文件不碰）；标签能列、能加、能去，已读/未读能标，邮件能移进回收站——改标签、标已读、进回收站都要你显式确认；永久删除本批不提供。OAuth 流程与通用流程合并了，`nyra gmail auth` 走同一条路。
- **多 agent 任务能看时间线了**：一次任务谁在何时干了什么、哪次模型调用花了多少 token、哪步被验收打回，都能按时间重建出来；`nyra timeline <运行 ID>` 看时间线，`nyra replay <运行 ID>` 按轮次逐步回放（只读，不重新执行、不花 token），`--out` 还能导出一份 Markdown 报告。
- **失败能沉淀成回归用例了**：一次任务跑完，失败的步骤可以沉淀进回归测例库（`nyra regression precipitate --run <运行 ID>`），下次改指令或改 harness 后先跑回归集；时间线顶部还多了一行“当前阶段”，一眼能看出这次运行在等谁、等什么。验收也多了一条诚实口径：草稿不能按已完成验收，UI 改动没附 before 截图不算 ready。
- **每个 Bot 有了自己的一台电脑**：Bot 不再只活在一次会话里——`nyra bot computer create --agent <名字>` 给它一台持久电脑，有自己的工作目录、自己的浏览器配置与登录态、自己的 shell；关机后电脑还在，唤醒接着干。默认每台电脑只归一个 Bot，共享要你显式点头、默认只读；登录密码存在密码箱里，Bot 自己看不到，由应用代填；内存声明超了系统 80% 就建不出来，不会悄悄扩容。**第二批接线做完了**：Bot 启动时自动绑上自己那台电脑，处理消息/任务就在电脑的 workspace 里跑（消息到了先唤醒，闲置够久再睡）；聊天里 `/computer-shell own <命令>` 就能在自己的电脑上跑 shell（别的电脑要审批），`--cred <账号>` 能把密码箱里的凭证代填进命令，回显前脱敏成 `***`。**第三批收尾**：群聊里指令也要先 @ Bot 才理（之前 `/new`、`/stop` 不用 @ 就能清会话、停任务，是个口子，现已堵上）；定时任务也能指定 `--agent <名字>`，到点跑在那台 Bot 的电脑里，没接电脑时回退到原来的目录照常跑。
- **任务能带图/视频了**：报错截图、设计稿可以直接附在任务后面让模型看（`nyra --image 截图.png "这是什么意思"`），视频先抽帧再看；模型看不了图会直接告诉你换哪个模型，不会假装看懂也不会白烧 token。看了哪张图、模型据此做了什么决定，都进证据链（`nyra timeline` 能查到）。
- **Agent 之间能直接协作了**：两个 Nyra 实例可以互相提问、交接任务——你在 A 上问 B 一个问题，B 用只读模式回一段回答；A 上没跑完的任务能打包交接给 B 续跑（只含任务描述、已验证的结论、已做步骤与待办，不含令牌与绝对路径）。交接本身进证据链（谁交的、交了什么、对方接没接），默认只读，写操作要对方显式接受。对端要你自己配（`nyra peer`），默认关闭。
- **语音能指挥了**：对 Nyra 说一句话就能派活——`nyra --voice 录音.wav` 先转文字再当任务跑，转写优先本地 whisper.cpp、没有就走云端 STT；任务跑完还能把结果读出来（`--speak`，默认关，只读结果前 500 字）。语音只指挥不聊天，语音里说“转账”“发邮件”也不会自动执行，写操作照常过审批；转写与回读的花费进用量账本，超预算会停住。实时语音通话是下一波的事，这批只做异步指挥。
- **能直接交办公成品了**：结构化内容可以写成可编辑的真 DOCX/XLSX/PPTX（`nyra export --format docx|xlsx|pptx --from 内容.json --out 成品.docx`，或让 agent 调 `export_office` 工具），不是截图也不是 PDF；表格、公式、数值格式、图片页都支持。文件里的每个数字都要有来源，没来源的标“未核实”，文末另附事实核查；写文件照常过审批，路径只允许在工作区内。
- **公开视频能抓成文字了**：给一条公开视频链接，先取字幕（免费、零 token），没有字幕再提音频走本地 whisper.cpp 转写（`nyra media ingest <链接>`，或让 agent 调 `media_ingest` 工具）；DRM/付费墙、cookies、批量搬运一律拒绝，只为自己看/学习。yt-dlp 二进制不进仓库，由 `nyra media setup` 按官方 release 下载并验签安装；默认关闭，须先 `nyra media enable`。

- **每个 agent 有了自己的 Soul（身份层）**：身份（名字、人格、目标）+ 信奉的规则（Tenets）存在 `~/.nyra/souls/<agent>.json`，与模型配置分文件——换模型只改配置，Soul 不动，换脑不换魂。不变量（invariant）编译进权限规则层（deny > ask > allow），违反时在工具调用前由代码拦截（自定义 allow 规则打不开、幂等重试绕不过、批了也不放行），拦截记进证据链；偏好（prior）只进提示词。每条 Tenet 可开关、可删、可导出，默认不上传；`nyra soul show` 直接看全部 Tenet。
- **业务动作有了硬红线表**：发消息、付款、签署文件、删除信息、改密码、转账永远要人批，交易证券、在账户之间转钱、收集卡号/身份证号、冒充真人对外联系永远禁做——即使批了也不做（`nyra bot redlines` 看表；收紧随时改，放松要你显式批准并记原因）。红线由审查层、审批链和连接器发信入口三处执行，不是靠模型自觉；每个连接器（Gmail/Shopify/Slack）自带一份默认表。
- **任务不再丢在内存里了**：任务板（`nyra kanban`）把任务记成账本里的一行，崩溃不丢、失败 3 次熔断进 blocked 等你 reset、标完成之前必须附上验证证据（没验证的完成标不上去）；子 agent 崩了能续跑（`nyra subagent sweep` 扫一遍，超 120 秒没心跳的标待续跑，连崩 3 次的挂起，续跑前先验状态、无人值守时强制只读）；副作用先记下来再执行（`nyra side-effects`），重启后按年龄从老到新恢复，已做过的不重复做；平时安静巡查（`nyra heartbeat`），没事不吭声，有事（未读消息、熔断任务、待续跑的子 agent、中断的运行）先记证据再写收件箱；对话里顺口说的跟进（“下周二提醒我看报价”）只当提议，你确认一次才生效，过期自动失效、不进记忆。自动续跑默认全关，要你显式开才跑。
- **并行子 agent 有了实时花名册，还能单点停止**：`nyra roster list` 一眼看到每个在跑的子 agent 在干什么、跑了多久、卡在哪（只读快照，不花 token；token 和花费默认不显示，点进 `nyra roster show` 的详情才看）；一个子 agent 跑偏了不用整批推倒重来，`nyra subagent stop <运行 id> --yes` 只停它一个（连它的子树一起停），任务板上那份活进审阅留着部分成果等人看——注意这是“请求停止”，停没停下来以 `confirm-stopped` 的确认为准，没停下来不会谎称已停；模型调用本身停不掉，已发出去的动作也收不回。**单点引导与结构化输出契约也来了**：`nyra subagent steer <运行 id> "<引导文本>" --yes` 能给在跑的子 agent 递一句话，引导排队、等它一轮工具跑完再消费，不打断在跑的活；子任务还能带 `output_schema`，交回的结果先按 schema 校验，格式不对给一次纠正机会（只纠格式不重做），纠正完还不对就按失败走、不静默收坏结果。
- **企业治理控制面来了**：策略改一次算一个版本（`nyra governance policy`），授权（Mandate）绑着发布时的策略版本、改不了，续跑和恢复之前按当前策略重验证——冲突了就拒绝，不偷偷放行；Bot 自己接活默认是 observe 档，只记“如果放行会接”不真干，你看过记录没问题再切 auto（切之前先套月度硬顶，触顶不接）；自优化的提议（`nyra optimize`）只起草改指令的建议，你批了才改文件，验证要 validation 和 holdout 都过才放行，不过就自动回滚。
- **企业 SSO 与 SCIM 账号开通来了**：公司的身份提供方（Entra ID、Okta 等 OIDC IdP）能接进来登录（`nyra sso provider add` 注册，`nyra sso login` 登录，走授权码 + PKCE + 回环回调，邮箱没验证过的不让进）；人事系统能用 SCIM 协议批量开账号、停账号、管群组（`nyra sso scim token` 签发 Bearer token，挂在网关 `/scim/v2` 上）；账号停用是真停用——会话立即全撤销，登录、绑定、网关鉴权三处同时失效，恢复了也要重新登录；进 owner 群组提权，进 user 组不降级。登录密码与 SCIM token 只存密码箱，审计里只记 id 与指纹，不记邮箱、不记 token。
- **成本上限能按层分了，审计能导给 SIEM 了**：月度硬顶是组织级上限，这批在它下面又分了四层——团队、角色、单个 Bot、人设（Soul），哪层先到就哪层停（`nyra governance caps set agent:nyra --usd 5`）；子层上限不能超过组织级，要抬先抬组织级。触顶不是直接丢任务：运行先停住，任务进 `paused` 态留着（`nyra kanban resume` 恢复，之前失败几次还记几次），放行前先重判一次，还超就继续等；谁把上限抬高了、抬到多少，都记进审计链。审计日志能导给 SIEM 了（`nyra governance audit export`，一种格式 JSONL，每行带哈希链，导完 `audit verify` 能验出有没有被改过）；导出里不含邮箱、token、密码、绝对路径。缺口 43 至此做完。
- **实时语音通话来了（最小闭环）**：`nyra voice call start` 建通话、接听后一段一段喂音频，转写优先本地 whisper.cpp（静音段直接跳过不花钱），云端默认关闭、开了也要先过月度硬顶；agent 的回话能合成语音读出来。语音里说“转账”“发消息”不会自动执行——那段会被扣下，要你回文字确认才算数；转写原文不落盘，只记时长、字数与指纹。传输这批还是本机回环（不拨真实电话），不花 token；理解与回读按需花，挂断后三本账分开列给你看。
- **视频通话来了（信令 + ICE 直连 + 按需看帧）**：`nyra video call start` 建通话、`connect` 跑协商连通（信令走 WebSocket，NAT 穿透走 STUN/TURN + ICE 检查，媒体面走提名出来的 UDP 直连通道），画面按需看——点一下才看、画面变了才看、定时看三种档，本地视觉模型优先、云端默认关、走了云端先过月度硬顶；描述原文不落盘，只记指纹。视频里说“转账”“发消息”同样扣下，要你回文字确认；录制默认关，双方同意才落盘；网弱了自动切仅语音，网好了自己回来。传输不花 token，看和听按需花，挂断后三本账分开列给你看。
- **名片加好友来了**：每个 agent 有一张公开名片（`nyra peer card` 看，内容由 Soul 身份与对外 MCP 工具清单如实生成，不编造没有的能力），默认不发布——开了才有人拉得到。加好友要双向批准：你发请求、对方拿着你给的好友码（`NYR-XXXX-XXXX`，24 小时有效）来登记、你点了批准才算好友，没批准之前对方什么都看不到、什么都调不动；好友默认只读，能分圈、能改成“可提议修改”。好友之间只分享已完成任务的产物，不分享原始对话、凭证与用量细节。视频通话也能直接打给好友：`nyra video call start --friend pilot --yes`。

## 0.5.2 更新了什么

0.5.2 是一次“补齐缺口 + 市场上线”的更新，常用功能照常用（详细技术记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **内置机器人市场来了**：能装别人做好的机器人和技能包了，装之前先过三道检查（清单、危险命令扫描、独立审查），装完默认只读，不会自动跑你的东西；想发布自己的机器人也能从这儿打包。
- **授权漏洞挖掘技能包**：按范围卡做事的漏洞挖掘技能，先定范围、再证伪、提交前过七问，只报真有危害的发现。
- **Gmail 能原生接了**：Gmail 收发直接走原生接口，不用再绕路。
- **邮件能当任务入口了**：发封邮件就能派活，不用再开终端；事件符合条件也会自动进任务队列。
- **敏感动作多了一道独立审查**：对外发送、删改关键文件、跑命令之前，先有独立的审查员看一遍，拿不准就拦住；默认关闭，想开再开。
- **做完任务能自动起草技能了**：一次成功的任务做完，会自动起草一份技能草稿，人工批准后才安装；长期不用的技能会自动归档。
- **委派、审阅、模型选择也补齐了**：子任务能并行跑、审阅有队列、每个 agent 能自己选模型、改动前有影子快照能联合回滚。
- **用量看得更清楚了**：用量热力图、429 冷却、月度支出硬顶都接上了，花超了会停住，不会悄悄超支。
- **标志和终端欢迎屏统一了**：正式标志全仓统一成圆盘 + 光标，终端欢迎屏改成像素字符画，不再嵌内联图片。

## 0.5.1 更新了什么

0.5.1 是一次“补齐与更稳”的更新，常用功能照常用（详细技术记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **网关里的命令也进沙箱了**：之前只有终端里的命令进沙箱，网页端、手机端发来的任务现在也一样隔离，默认断网；没装 bwrap 就退回工具级并告诉你，强制要沙箱时缺 bwrap 会直接报错停住，不会悄悄裸奔。
- **会话开始和结束时，你的检查脚本也会跑了**：钩子以前只在工具动手前后触发，现在会话一开一合也会触发（比如开局记一笔、结束时收尾）；钩子出问题不会把正常任务拖死，没装钩子时一点额外开销都没有。
- **文件级压缩也会把记忆和规则读回来了**：`nyra --compact` 压缩完同样自动读回记忆和规则，和 REPL 里 `/compact` 的行为一致，压缩失败时不读。
- **技能列表顺序统一了**：`--list-skills`、网页端状态、提示词里的技能顺序现在是同一个来源，不会各说各话。
- **模型原地打转会被拦住**：同一个失败的工具调用试 3 次就停手、换个办法；同一个答案重复 3 次提醒、10 次直接停轮，不再烧完轮数才罢休；停下来时会老实告诉你哪几步失败了、哪几步是被拦住的。
- **工具失败重试不再重复干活**：只读操作直接重试，写操作重试前先读回确认到底写没写进去，确认不了的干脆不重试；网络抖动类的错先重试两次还不行才换 provider，用量上限的错不重试。
- **安装包签名已接好线**：证书到位后，Windows 与 macOS 安装包、Windows 命令行版都会自动带签名；这版证书还没到，仍是未签名包，买证书的步骤见 `docs/SIGNING.md`。
- **Agent 不会再改自己的规则文件了**：`.git`、`.nyra`、技能目录和 `AGENTS.md` 这些路径现在默认拒写，改规则得显式放开（`NYRA_ALLOW_PROTECTED_WRITES=1`）。
- **技能能带自己的工具和模型了**：技能可以声明用哪些工具、建议用什么模型；技能正文里写的 `!命令` 会在渲染时执行，把真实仓库状态带进上下文——只有你自己家目录下的技能里的命令才会执行，仓库随带或插件里的默认不执行。
- **权限规则可以写进文件了**：学 Claude Code 的 `Tool(specifier)` 写法，allow / ask / deny 三档，deny 永远优先，规则可以随仓库提交、随团队共享。
- **子任务可以在隔离的工作区里干活了**：委派子 Agent 时可选独立 git worktree，主工作区一个字节都不动，干完把改动摘要交回你决定合不合；还能给子任务指定工具白名单和独立模型。
- **钩子能改工具入参、也能做决定了**：PreToolUse 钩子除了拦与不拦，还能在 stdout 里返回 allow/deny/ask 和改写后的入参（比如把危险的 `rm -rf` 改写成 `ls`），多个钩子取最严的决定，格式写错就当没这回事。
- **没验证通过的运行不会再自称“已完成”**：模型回复里出现“已完成”这类话，但验证没通过时，输出最前面会加一条【未验证】横幅，原文保留不删。

## 快速开始

**新用户：下载、运行，两步**（Node 单文件二进制，不用装 Python、不用装 Node）：

```bash
# 1）下载：到 https://github.com/js2005happy/nyra/releases 下最新版，
#    按平台拿一个文件（Linux x64：nyra-linux-x64；Windows：nyra-windows-x64.exe；
#    macOS arm64：nyra-macos-arm64，Intel：nyra-macos-x64）
# 2）运行（以 Linux 为例）：
chmod +x nyra-linux-x64
./nyra-linux-x64 setup      # 首次启动向导（中文，三步到第一个任务）
./nyra-linux-x64 doctor     # 中文自检：Key、网络、目录权限、磁盘
```

> 注意：Release 里已有现成二进制（最新版 v0.5.3，见下文「安装」）：Linux x64/arm64、Windows x64、macOS arm64/x64 各一个。想自己编：`bash scripts/build-binaries.sh --only linux-x64`（产物在 `dist/`，Windows/macOS 同理，只编对应目标）。

还没 Key 也能先跑 `--help` / `--version` / `--list-providers`（不联网、不花钱）。跑模型任务需要 Key：没设 Key 时会直接打印设置说明并退出（退出码 1），不会发请求、不会产生费用。没有 Key 可先用本地模型：`nyra --provider ollama "…"`（需本机装好 Ollama）或 `--provider codex`（复用本机 Codex 登录）。

> 注意：0.5.3 的 Node 二进制是完整版（agent 核心、网页界面、插件市场、创造模式都在内）。Windows/macOS 二进制未签名、未公证，首次运行会有系统提示（见各平台安装文档）。

**源码方式（想自己构建或看代码）**：见下文「安装 → 从源码构建」。

各平台的完整安装方式（一键脚本、`.deb`、桌面端、手机 PWA）见下文「安装」。

交互模式里输入 `/help` 查看全部命令，`/status` 看 Token 用量，`/diff` 看最近一次改动。

## 安装

最新版 **v0.5.3**，所有安装方式都不用装 Python、不用装 Node/Bun（Node 单文件二进制自带运行时）。装完先跑验证，再配 Key（配 Key 的方法见上文「快速开始」）：

```bash
nyra --version   # 应输出 nyra 0.5.3 (node runtime)
nyra doctor      # 中文自检：Key、网络、目录权限、磁盘
nyra setup       # 首次启动向导（中文，三步到第一个任务）
```

> **签名状态（实话）**：Windows/macOS 的 Node 二进制与桌面安装包目前**未签名、未公证**（证书待购买，见 [docs/SIGNING.md](docs/SIGNING.md)）。首次运行时系统会弹警告（Windows SmartScreen 点“更多信息 → 仍要运行”；macOS Gatekeeper 右键点二进制选“打开”放行一次），属正常，不是文件坏了。

### Windows

| 方式 | 怎么做 | 适合谁 |
| --- | --- | --- |
| Node 二进制（推荐，命令行） | 到 [Releases](https://github.com/js2005happy/nyra/releases) 下最新版，下载 `nyra-windows-x64.exe`，放到固定文件夹（如 `C:\Tools\nyra\`）并把文件夹加进 PATH | 只用命令行 |
| 一键脚本 | PowerShell 里跑 `irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 \| iex`（装到 `~\nyra`、加 PATH、建桌面快捷方式） | 想一步到位 |
| 桌面端（带窗口） | 在 Release 里下载 `Nyra_0.5.3_x64-setup.exe` 或 `Nyra_0.5.3_x64_en-US.msi` | 想要窗口界面 |

验证：`nyra --version` 应输出 `nyra 0.5.3 (node runtime)`。常见问题：exe 双击后窗口一闪而过是正常的（它是控制台程序，在 PowerShell 里跑）；SmartScreen 警告见上文。详见 [docs/windows-install.md](docs/windows-install.md)，桌面端见 [docs/desktop.md](docs/desktop.md)。

> 如实说明：Windows 二进制在 CI 的 `windows-latest` 上跑过 `--version` / `--example` 冒烟，但还没在任何一台真 Windows 电脑上跑过。装不上时把报错原文贴到仓库 issue 里。

### macOS

| 方式 | 怎么做 | 适合谁 |
| --- | --- | --- |
| Node 二进制（推荐，命令行） | `bash scripts/install-node-macos.sh`（从 Releases 下载对应架构：arm64 用 `nyra-macos-arm64`，Intel 用 `nyra-macos-x64`；装到 `~/.local/share/nyra`，链接在 `~/.local/bin/nyra`） | 只用命令行 |
| 手动下载 | 到 [Releases](https://github.com/js2005happy/nyra/releases) 下最新版，按架构下载 `nyra-macos-arm64` 或 `nyra-macos-x64`，`chmod +x` 后直接跑 | 不想跑脚本 |
| 桌面端（带窗口，`.dmg`） | 在 Release 里下载 `Nyra_0.5.3_universal.dmg` | 想要窗口界面 |

验证：`nyra --version` 应输出 `nyra 0.5.3 (node runtime)`。常见问题：Gatekeeper 首次运行会拦，右键点二进制选“打开”放行一次；`~/.local/bin` 不在 PATH 里时按脚本提示加到 `~/.zshrc`。`.pkg` 安装器没有。详见 [docs/macos-install.md](docs/macos-install.md)，桌面端见 [docs/desktop.md](docs/desktop.md)。

> 如实说明：macOS 安装脚本是在 Linux 上写好、只做了语法与占位替换检查，**尚未在真 Mac 上跑通过**；桌面 `.dmg` 也没有在真机上手动装过。

### Linux

| 方式 | 怎么做 | 适合谁 |
| --- | --- | --- |
| Node 二进制（推荐） | `bash scripts/install-node.sh`（从 Releases 下载对应架构：x64 用 `nyra-linux-x64`，arm64 用 `nyra-linux-arm64`；装到 `~/.local/share/nyra`，链接在 `~/.local/bin/nyra`） | 大多数人 |
| 手动下载 | 到 [Releases](https://github.com/js2005happy/nyra/releases) 下最新版，按架构下载，`chmod +x` 后直接跑 | 不想跑脚本 |
| `.deb` / tarball | 自己打出来：`bash scripts/build-binaries.sh --only linux-x64 && bash scripts/build-package-node.sh`，再 `sudo dpkg -i dist/nyra-node_0.5.3_amd64.deb`（`.deb` / tarball 不在 Release 里） | Debian/Ubuntu，想装进系统目录 |
| 调度器常驻 | 安装时加 `--with-systemd`，再 `systemctl --user enable --now nyra-scheduler.service`（只装服务文件、不自动启动；不需要 root） | 想让定时任务后台一直跑 |

验证：`nyra --version` 应输出 `nyra 0.5.3 (node runtime)`。常见问题：`nyra: command not found` 是 `~/.local/bin` 不在 PATH 里，加 `export PATH="$HOME/.local/bin:$PATH"` 到 `~/.bashrc`；没用户 systemd 总线的机器（容器、WSL 默认配置）用 `nyra schedule daemon` 在终端里跑。详见 [docs/linux-install.md](docs/linux-install.md)、[docs/linux-packaging.md](docs/linux-packaging.md)、[docs/linux-systemd.md](docs/linux-systemd.md)。

### 手机 PWA（不用应用商店）与安卓 APK

手机版是电脑上 `nyra ui` 顺带提供的手机页面（`/m`），装到主屏幕就能当 App 用：电脑上跑 `nyra ui --pair`，手机和电脑连同一个 Wi-Fi，扫终端里的二维码配对，再在浏览器里点“添加到主屏幕”（安卓 Chrome 右上角 ⋮，iPhone Safari 点分享）。没有 APK / IPA，手机直接连你电脑上的 Nyra，工具仍在电脑上执行。详见 [docs/mobile-pwa.md](docs/mobile-pwa.md)。

> 如实说明：没有在真手机上验证过（只在电脑上用 Playwright 模拟 iPhone 14 与 Pixel 7 跑过）；真机上的“添加到主屏幕”菜单、系统启动屏、iOS 独立窗口的存储行为都还没亲手试过。

**安卓 APK（0.5.3 起）**：想装真 App 而不是浏览器书签时，到 [Releases](https://github.com/js2005happy/nyra/releases) 下最新版下载 `nyra-android-debug.apk`，装到手机上，打开后填电脑的局域网地址与配对码连接（配对方法与上面 PWA 相同）。iPhone 仍用上面的 PWA（没有 IPA，要 Apple Developer 账号与证书，见 [docs/installers.md](docs/installers.md)）。

> 如实说明：APK 是 debug 签名（不是正式签名），且只在 CI 里编出来、没在真机上装过；第一次装时如有出入以手机上实际出现的为准。

### 从源码构建

```bash
git clone https://github.com/js2005happy/nyra.git nyra && cd nyra
bun run src/cli.ts "解释一下这个项目的结构"   # 一次性任务（需先装 Bun）
bun run src/cli.ts                          # 交互模式
bun run src/cli.ts ui --open                # 本地网页界面
```

只编单文件二进制：`bash scripts/build-binaries.sh --only linux-x64`（产物在 `dist/`；5 个目标：`linux-x64` / `linux-arm64` / `windows-x64` / `macos-arm64` / `macos-x64`）。Linux 桌面端（Tauri）本地编不了（缺系统库），靠 CI 构建，见 [docs/desktop.md](docs/desktop.md)。

> 0.4.0 已移除 Python 版：仓库里不再有 Python 代码，`python3 -m nyra` 不可用；唯一运行方式是 Node 单文件二进制（或上面这样用 Bun 跑源码）。

## 断点续跑与结果验证

长任务会把运行状态记在 `~/.nyra/runs/<run_id>/`（目录权限 0700，文件 0600）。单次任务和 `--json` 会打印运行 ID。

- 中途中断后用 `nyra --resume-run <run_id>` 接着跑。尚未得到结果的工具调用**不会自动重跑**（可能已经产生副作用），会先告诉模型结果未知。续跑时先前会话里放行的审批全部作废，需要重新确认。已经 `verified` 或 `completed_unverified` 的运行不能再续。
- 用 `--verify "python -m unittest"`（或配置 `verify_command`、项目 `AGENTS.md` 里的 `verify:` 行）做结果自证。验证命令在**创建任务时冻结**，之后再改 `AGENTS.md` 不算数。只有命令真实退出码 0 才是 `verified`；失败会把输出作为不可信的工具消息交回模型，最多再试 2 次，仍失败则为 `verify_failed`（`--json` 退出码 4）。没配置验证命令时状态是 `completed_unverified`，报告会写明「未验证」。模型自己说「已验证」不会改变状态。来自 `AGENTS.md` 的 `verify:` 视为外部内容：任意模式（含 `--mode full`）都要先确认一次再冻结；`--json` 或其它非交互运行需加 `--trust-agents-verify`，否则跳过该命令并记为未验证。命令行 `--verify` 和用户配置 `verify_command` 不需要这步确认。续跑只用已冻结的命令，不再读取 `AGENTS.md`。
- 后台队列：`nyra task add "任务" [--workdir D] [--verify CMD] [--mode readonly|auto] [--trust-agents-verify]` 入队；`nyra task worker [--once]` 顺序执行（同时只能有一个 worker）。遇到需要审批的操作会停下并标为 `awaiting_approval`，不会自动放行。前台用 `nyra task approve <run_id>` 继续。`nyra task list|show|cancel` 查看或取消（只能取消还在排队的任务）。定时任务到期后也会进入这个队列，且与队列一样拒绝 `full` 模式。worker 不会自动信任 `AGENTS.md` 里的验证命令，需在 `task add` 时加 `--trust-agents-verify` 或显式 `--verify`。完成通知写在 `~/.nyra/inbox.jsonl`，打开 REPL 或输入 `/status` 时会看到未读通知。

## 它能做什么

- **编程**：读代码、`apply_patch` 精确改文件、跑测试，改动前在审批卡片里展示 diff。
- **研究**：`web_search` + `web_fetch` 联网查证，原文存档，结论附链接。
- **自动化**：内置调度器，`nyra schedule add` 按间隔或每天定时跑任务。
- **多机器人群聊**：一个房间里组长、架构师、开发者、审查员分工讨论，各自记忆与权限独立（默认只读）。
- **插件市场**：只装带来源、可审计的技能包（`nyra plugin install <本地目录|git URL>`），哈希锁定、升级不覆盖你改过的文件。
- **创造模式**：一句话搓出专属插件，先验证、你确认后才安装（[手册](GUIDE.md#创造模式一句话搓出插件)）。
- **隔离执行**：`--sandbox` 支持 `auto`（默认）/ `local` / `bwrap`（Linux）/ `seatbelt`（macOS）/ `jobobject`（Windows）；`auto` 在 Linux 且有 bwrap 时用 bwrap，否则退回工具级限制并明确告诉你，不会悄悄裸奔。0.3.0 的 `--sandbox e2b`（E2B 云沙盒）已在 0.4.0 移除，Node 版 E2B 后端尚未移植，显式 `--sandbox e2b` 会直接报错。
- **配对码协作**：两个 Nyra 用 6 位配对码配对，宿主以只读模式跑任务、只传任务文本与结果（[手册](GUIDE.md#审批模式)）。
- **本地密码箱**：API Key 加密存在本机，不写进配置文件或聊天记录（[手册](GUIDE.md#审批模式)）。
- **本地知识库**：把文本、文件、网页收进知识库再提问，只按库内内容回答并注明依据（[手册](GUIDE.md#审批模式)）。
- **MCP 内置预置**：10 个常用 MCP 服务器开箱即用，不用手写配置（[手册](GUIDE.md#审批模式)）。
- **MCP HTTP 传输 + 对外 MCP 服务**：客户端除 stdio 外可接 HTTP 的 MCP 服务器（`transport: "http"`，响应 JSON 或 SSE）；Nyra 也能当 MCP 服务器，别的 agent 经网关 `POST /mcp` 调记忆与任务（默认关闭、默认只读，写操作须显式开且过独立审查，详见 [docs/mcp.md](docs/mcp.md)）。

## 审批模式

| 模式 | 行为 |
|---|---|
| `readonly` | 只读文件、联网查资料，不写不执行 |
| `auto`（默认） | 写文件 / 执行命令前问你 `[y/N/a]`；无人值守时不会悄悄写入 |
| `full` | 不再确认，适合你明确信任的任务 |
| `creator`（创造模式） | 一句话做插件：先对齐 spec、生成、验证，安装前请你确认；写文件/执行命令时与 `auto` 一样逐项确认 |

```bash
nyra --mode readonly "看看这个目录里有什么"
nyra --plan "评估登录逻辑并列出修复步骤"
nyra --execute-plan --approve-plan <完整 SHA-256>
```

## 配置模型

优先级：命令行参数 > 环境变量 > `~/.nyra/config.json`。Key 只从环境变量读，绝不写进文件或日志。

| Provider | 环境变量 | 默认模型 |
|---|---|---|
| deepseek（默认） | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| xai（Grok） | `XAI_API_KEY` | `grok-4.3` |
| openai | `OPENAI_API_KEY` | `gpt-4o-mini` |
| qwen（通义） | `DASHSCOPE_API_KEY` | `qwen-plus` |
| kimi | `MOONSHOT_API_KEY` | `kimi-k3` |
| glm（智谱） | `ZHIPU_API_KEY` | `glm-5.3` |
| gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| ollama（本地） | 无需 Key | `qwen2.5:7b` |
| codex | 无需 Key（本机 Codex 登录） | `codex-default` |

另有 openrouter、mistral、groq、together 与 `custom`（`NYRA_API_KEY` + `NYRA_BASE_URL` + `NYRA_MODEL`）。`nyra --list-providers` 查看全部，详见 [完整手册](GUIDE.md#配置模型)。

## 网页界面

```bash
nyra ui --open
```

一个内嵌页面，不加载任何外部资源（字体随包内嵌）。只监听本机，每次启动生成随机访问 token。

桌面端 v2 按定稿设计稿实现（黑白极简，浅色/深色跟随系统）：左侧按项目分组的会话列表；对话流里工具调用折叠成步骤行，写文件、跑命令前出现审批卡片（拒绝 / 本会话始终允许 / 允许一次，附真实 diff）；右侧审阅面板看改动 diff、计划、证据、终端输出与 Token 用量；输入框可切审批模式、选模型、开计划模式（先只读写出 `plan.md`，审核后按 SHA-256 执行）。Key 只从环境变量读，页面不输入也不保存。手机宽度可用，全键盘可操作。详见 [完整手册](GUIDE.md#网页界面)。

### 桌面 App（预览，macOS / Windows）

`desktop/` 里是用 Tauri 2（Rust + 系统 WebView）做的原生外壳：打开后在后台启动本机的 `nyra ui`（只绑 127.0.0.1、随机端口与 token），窗口直接显示它，退出时一并关闭；找不到 Nyra 二进制时显示安装引导。Windows 安装包（`.msi` / NSIS `.exe`）与 macOS `.dmg` 在 Release 里直接下载；两个包都**未签名**。安装与打开未签名 App 的步骤见 [docs/desktop.md](docs/desktop.md)。

## 安全边界

- 默认逐项审批；`a`（本会话始终允许）只对同一文件、或完全相同的命令与目录生效。
- 文件工具不能写出工作目录；MCP 子进程默认拿不到你的 API Key。
- 检查点能撤销本地文件改动，但撤销不了 shell、网络请求等外部副作用。
- 命令默认走沙箱（见上文“隔离执行”）；但沙箱不是万能的，运行不可信代码请再加一层隔离环境。

## 文档

- [完整手册](GUIDE.md)：全部功能、命令与安全说明
- [DESIGN.md](DESIGN.md)：架构与设计来源
- [ROADMAP.md](ROADMAP.md)：接下来要做什么
- [VERIFICATION.md](VERIFICATION.md)：真实环境验证记录
- [CHANGELOG.md](CHANGELOG.md)：版本变更
- [docs/desktop.md](docs/desktop.md)：桌面 App（macOS / Windows，预览）
- [docs/windows-install.md](docs/windows-install.md)、[docs/macos-install.md](docs/macos-install.md)、[docs/linux-install.md](docs/linux-install.md)：各平台安装
- [docs/linux-packaging.md](docs/linux-packaging.md)：tarball 与 `.deb` 打包
- [docs/linux-systemd.md](docs/linux-systemd.md)：systemd 调度器服务
- [docs/mobile-pwa.md](docs/mobile-pwa.md)：手机 PWA

## 测试

```bash
bun x tsc -p tsconfig.json --noEmit   # 类型检查
bun test tests/node                    # Node 测试（全部 mock，无需 Key）
```

## 致谢与许可

代码全部原创，借鉴了 Codex、OpenCode、Goose、OpenHands 等开源 agent 的设计思想（来源见 [DESIGN.md](DESIGN.md)），没有复制源码。以 [MIT](LICENSE) 许可发布。

## 命令索引

全部子命令见 [docs/COMMANDS.md](./docs/COMMANDS.md)（由测试机械校验与代码一致）。
