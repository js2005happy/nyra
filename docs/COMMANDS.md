# 命令速查（全部子命令）

> 由 `tests/node/test-doc-consistency.test.ts` 机械校验：这里与 `src/cli.ts` 的 `subcommands` 集合必须**一一对应**。
> 加子命令不写进这里 → CI 红；写了不存在的命令 → 也红。

## 运行与结论

| 命令 | 作用 |
|---|---|
| `nyra` | 跑任务（默认入口，无子命令） |
| `nyra verdict [任务]` | 一条结论：这次跑得值不值（红线 + 省钱 + 回忆 + 历史） |
| `nyra verdict --run <id>` | 给单次运行打分 |
| `nyra verdict --recent N` | 最近 N 次的趋势：该修什么 |
| `nyra guard [--strict]` | 门禁形态：red 时退出码 2（`--strict` 下 yellow 也拦） |
| `nyra redlines [--json]` | 上线红线自检（证据/权限/沙箱/成本/钩子）；`--json` 给 CI 按 `code` 判定 |
| `nyra evidence verify <运行 ID>` | 独立复核运行的证据链 |
| `nyra timeline <运行 ID> [--verbose] [--json] [--out <路径>]` | 执行时间线：按时间重建一次多 agent 任务（只读回放，不重新执行） |
| `nyra replay <运行 ID> [--verbose]` | 会话回放：按轮次逐步重现一次运行的关键步骤（只读，不重新执行） |
| `nyra regression <list\|precipitate --run <运行 ID>\|remove <用例 id>\|status <用例 id> <open\|verified\|retired>>` | 回归测例库：把一次运行的失败步骤沉淀为回归用例（只记元数据，不调模型、不自动重跑，详见 `docs/regression.md`） |
| `nyra contract <create\|list\|show\|activate\|attach\|verify\|mark-item\|remove\|stats>` | 交付契约（缺口 29）：接单时先定验收标准（交付物 + 检查清单），跑完逐项打分，全部通过才算被接受（详见 `docs/delivery-contract.md`） |
| `nyra golden <add\|list\|show\|remove\|run\|rescore>` | Golden 测试集（G-2）：固定输入 + 期望输出 + 期望工具轨迹，跑分看结果分与轨迹分（详见 `docs/delivery-contract.md`） |
| `nyra "任务" --contract <契约 id>` | 本次运行挂上已激活的交付契约，收尾逐项打分进运行报告 |
| `nyra "任务" --image <图片路径> [--image ...] [--video <视频路径或链接>]` | 图像/视频输入：图片进首轮用户消息，视频先抽帧再进（模型须支持看图，详见 docs/vision.md） |
| `nyra --voice <音频路径> ["任务"] [--yes]` | 语音指挥：先转文字再当任务跑（本地 whisper 优先、云端兜底；转写文字默认先审后发，`--yes` 明确跳过审阅，JSON 模式下没给 `--yes` 直接拒绝；详见 docs/voice.md） |
| `nyra "任务" --speak` | 任务跑完后把结果读出来（默认关；只读结果前 500 字） |
| `nyra restore [检查点]` | 从影子快照恢复文件与会话 |

## 成本与用量

| 命令 | 作用 |
|---|---|
| `nyra cost --show` | 定价、单次上限、月度上限与本月已花 |
| `nyra cost --estimate "<任务>"` | 成本预估（含回忆感知的下调） |
| `nyra savings [任务]` | 省钱机制汇总 + 辅助模型实测节省 + 逐模型明细 |
| `nyra stats [--heatmap]` | 本月用量与每日热力图 |
| `nyra telemetry [status\|spans\|metrics\|export\|enable\|disable\|otlp]` | 可观测性：trace（span 落盘 + OTLP 导出）+ metrics（计数器与直方图）+ 运行事件 trace 关联（详见 `docs/telemetry.md`） |

## 配置与开关

| 命令 | 作用 |
|---|---|
| `nyra config export / import` | 设置导出与导入（默认剔除密钥；越权字段需 `--allow-dangerous`） |
| `nyra config explain [能力]` | 这个能力由哪个键控制、现在生效吗 |
| `nyra features` | 功能开关列表（CLI > config > 默认） |
| `nyra tools` | 工具集体检：每轮 schema 成本与裁剪建议 |
| `nyra models [list\|show\|refresh\|fallback\|handoff\|preset\|health]` | 模型上下文窗口查询与刷新；`fallback` 看备用链开关、顺序与本月切换统计；`handoff` 查限流接力摘要；`preset` 看/设降级预设（best/fast）；`health` 看故障账本与提前恢复 |
| `nyra reviewer <status\|enable\|disable\|set-model\|add-rule\|remove-rule\|list-rules\|check>` | 独立审查层：敏感工具调用先过独立审查 agent，审查失败即拦截（详见 `docs/reviewer.md`） |
| `nyra judge <status\|enable\|disable\|set-model\|set-thresholds\|check\|verdicts>` | 意向验证 judge：敏感工具调用先打风险分（0-100 + 引用证据），高分拒绝、中段转人工；第 2 批 G-P1-12：启发式前置（critical 直接拒、high 转人工，零成本规则先扫一遍）+ verdict 落库，`verdicts` 查最近结论（详见 `docs/tool-judge.md`） |
| `nyra verifier <status\|enable\|disable\|set-model\|rework-on\|rework-off\|add-rule\|remove-rule\|list-rules\|check>` | 验收者：并行产出合入前先验收，不通过打回重做，结论进证据链（详见 `docs/verifier.md`） |
| `nyra account <status\|login\|logout\|list\|revoke\|link\|suspend\|reactivate>` | 用户账号登录：Google / GitHub / 邮箱 / SSO，账号身份 + 会话（详见 `docs/accounts.md`） |
| `nyra cloud <status\|connect\|disconnect\|sync\|push\|pull\|pref\|devices\|set-url>` | 第 6 批：手机云端连接——账号登录后直连云端服务、跨端同步，不走局域网（详见 `docs/mobile-cloud.md`） |
| `nyra sso <provider\|login\|status\|scim>` | 缺口 43 第二批：企业 SSO——OIDC 身份提供方注册与登录、SCIM 账号开通（详见 `docs/sso.md`） |
| `nyra init [--name 名字] [--role researcher\|assistant\|shopkeeper\|custom] [--work 干什么活] [--persona 风格] [--redline 红线] [--agent default] [--yes] [--force]` | 缺口 35：对话式入职——三个问题（叫什么、干什么活、什么风格/红线）→ 生成 Soul + 按角色预装技能包 + 配置清单确认后生效，确认后发就绪简报（详见 `docs/onboarding.md`） |
| `nyra templates <list\|show <角色>\|apply <角色>\|export <角色> <文件>\|import <文件>>` | 缺口 35：一键角色模板——研究员 / 助理 / 店小二（Soul + 技能包 + 权限规则的打包文件，可导出成本地文件分享；导入先验后装；与 `nyra template` 业务流程模板不同，详见 `docs/onboarding.md`） |
| `nyra wake` | 缺口 35：唤醒——重发一次就绪简报（我是谁、我会什么、我的红线、本次 0 token），走终端 + 机主收件箱（详见 `docs/onboarding.md`） |

## 记忆与复用

| 命令 | 作用 |
|---|---|
| `nyra recall "<任务>" [--cross-dir]` | 查这个任务有哪些历史可复用 |
| `nyra memory <export\|import\|search\|forget…>` | 记忆交换与检索/删除 |
| `nyra memory <remember\|entries\|entry\|update\|rejections>` | 结构化记忆条目（证据门：写记忆须附用户原话依据，见本页“记忆证据门”一节）；`remember`/`entries` 支持 `--org` 组织记忆 |
| `nyra memory recall <status\|on\|off\|cross-on\|cross-off\|test>` | 主动记忆（G-P1-31）：回复前召回，不够升级深挖；默认关，按会话可开关，跨会话须显式开 |
| `nyra memory <extract\|review>` | 对话里自动提炼记忆（G-P1-34）：对话结束自动提炼候选，`extract` 从指定会话手动提炼一次，`review` 逐条确认进库或拒绝，进库前过记忆证据门 |
| `nyra soul <show\|status\|list\|init\|add\|remove\|enable\|disable\|edit\|export\|import>` | Soul 身份层：每 agent 的身份与 Tenets，不变量编译进规则层、代码拦截；Charter 角色契约（`soul charter <set\|show\|clear>`，团队接单须有完整 Charter，详见 `docs/soul.md` 与 `docs/team.md`） |
| `nyra style <learn\|show\|list\|delete…>` | 分应用文风学习 |
| `nyra skills <status\|enable\|disable\|draft\|drafts\|show\|approve\|reject\|archive\|sweep>` | 技能自沉淀：成功任务自动起草技能草稿，人工批准后才安装，低质自动归档（详见 `docs/skill-sedimentation.md`） |
| `nyra bughunt <install\|status\|scope\|template\|check>` | 授权漏洞挖掘技能包：范围卡 + 证伪验证 + 提交前七问 + 证据卫生，提交前核对（详见 `docs/bughunt.md`） |
| `nyra market <list\|show\|source\|install\|uninstall\|installed\|publish\|template>` | 内置机器人市场：浏览、安装、发布技能包与机器人配置，三道门审查 + Bot Ready 评分 + 安装账本（详见 `docs/marketplace.md`） |

## 后台与协作

| 命令 | 作用 |
|---|---|
| `nyra ui` | 启动 gateway 网页界面（含手机 PWA） |
| `nyra gw <sessions\|send\|view\|approve…>` | 连正在跑的 gateway 当客户端 |
| `nyra schedule <list\|add\|remove\|run\|daemon>` | 定时任务（`add` 可加 `--agent <名字>`，让任务跑在该 Bot 的电脑里） |
| `nyra events <list\|add\|remove\|enable\|disable\|test\|poll>` | 事件触发任务：webhook 与新邮件触发进任务队列（详见 `docs/event-triggers.md`） |
| `nyra mail-inbox <status\|enable\|disable\|allowlist\|set\|poll>` | 邮件即任务入口：白名单发件人的邮件直接进任务队列，跑完回信（详见 `docs/mail-inbox.md`） |
| `nyra responsibility <list\|add\|set\|remove\|enable\|disable\|check\|pause\|resume\|complete\|cancel\|brief\|show>` | 持续责任语义：责任对象（归属人 + 验收标准 + 升级条件 + 过期时间）与晨间简报，无事安静（详见 `docs/responsibilities.md`） |
| `nyra bot telegram <start\|stop\|status>` | Bot 方向 Phase 1+2+3：Telegram 渠道（长轮询收消息、会话串行、去重配额、确定性指令；角色路由与聊天内审批；主动推送 notifier 与附件处理，详见 `docs/bot.md`） |
| `nyra bot discord <start\|stop\|status>` | Bot 方向：Discord 渠道（Gateway 收 MESSAGE_CREATE 事件、REST 发/编辑消息；需 Message Content Intent，详见 `docs/bot.md`） |
| `nyra bot slack <start\|stop\|status>` | Bot 方向：Slack 渠道（Socket Mode 收 app_mention/message.im 事件、Web API 发/编辑消息；需 app token + bot token，详见 `docs/bot.md`） |
| `nyra bot whatsapp <start\|stop\|status>` | Bot 方向：WhatsApp 渠道（Cloud API 发消息 + webhook 收消息；需 access token + 号码 id + 公网入口，详见 `docs/bot.md`） |
| `nyra bot redlines <status\|list\|show\|tighten\|loosen\|set>` | Bot 缺口 51：业务动作硬红线表——发消息/付款/删除永远须人批，转钱/交易证券永远禁做（详见 `docs/business-redlines.md`） |
| `nyra bot computer <create\|list\|status\|sleep\|wake\|remove\|credential\|shell\|sleep-due>` | Bot 缺口 42 第一批 + 第二批：每 Bot 一台持久电脑——持久 workspace + 浏览器 profile + 凭证 Vault + 隔离分级；第二批 BotRunner 接线：Bot 启动时绑电脑、Agent 在电脑的 workspace 里跑、`/computer-shell`（详见 `docs/bot-computer.md` 与 `docs/bot.md`） |
| `nyra bot status` | Bot 总览：Telegram/Discord/Slack/WhatsApp 运行态 + 电脑数量与资源，本 Bot 的电脑带标注（详见 `docs/bot.md` 与 `docs/bot-computer.md`） |
| `nyra bot approvals <list\|revoke <授权 id>>` | Hermes HQ 借鉴第 1 批：审批授权管理——批准时可带档位（一次/本次会话/一直），session 档只在内存里、always 档持久化进 bot-approval-grants.json，可用 `/grants` 查看、`/revoke-grant` 或本命令撤销（详见 `docs/bot.md`） |
| `nyra channels <start\|stop\|status\|health\|bindings\|explain>` | 缺口 27：常驻多渠道网关——四渠道一个进程、bindings 确定性路由、渠道会话默认进沙箱、每条入站路由进证据链、语音指挥入口（详见 `docs/channels.md`） |
| `nyra task <add\|list\|show\|cancel\|worker\|approve>` | 后台任务队列 |
| `nyra kanban <create\|list\|show\|start\|fail\|review\|decide\|verify\|done\|reset\|remove\|tick\|sweep>` | 缺口 26：持久任务板——任务是账本里的一行，崩溃不丢、熔断进 blocked、完成须附验证证据（详见 `docs/kanban.md`） |
| `nyra reconciler <scan\|status\|enable\|disable\|config\|settle>` | Pi Bot 借鉴第 3 条：卡住步骤看门狗——working 任务超时无进展先标出来、再按轮次上限自动重排、超限进 blocked 只等人；自动巡查默认关（详见 `docs/reconciler.md`） |
| `nyra watch <add\|list\|show\|remove\|check\|enable\|disable\|config\|run-action>` | 缺口 32：变化监测例程——盯页面或文件，变了才汇报（变了什么 → 详情 → 来源）；触发条件与动作分开声明，下载类敏感动作须人批；自动巡查默认关（详见 `docs/watch.md`） |
| `nyra goal <create\|list\|show\|add-item\|start-item\|verify-item\|complete\|pause\|resume\|cancel\|instruct\|link\|split>` | GROK-5（缺口 26/30 深化）：长目标对象——目标陈述 + 动态进度清单 + 逐项验证，全部通过才标完成；中途加指令不丢目标，可暂停/恢复/取消；恢复前重验证；目标可拆成任务板任务（详见 `docs/goal-object.md`） |
| `nyra trust <register\|list\|show\|evidence\|promote\|demote\|review\|check>` | GROK-6（缺口 43 治理深化）：信任阶梯——新 agent / 新技能默认只读，攒够 N 次连续成功且零违规才升一级（只读 → 起草 → 发送 → 购买）；每次记成功有概率被随机抽查，抽中须复核才计入；降级随时可做（详见 `docs/trust-ladder.md`） |
| `nyra workflow <import\|list\|show\|run\|dry-run\|resume\|trial\|activate\|remove\|verify\|triggers>` | 缺口 25 其余形态：声明式可复用工作流——三种执行形态（固定图 / 协调者 / 动态）+ 审批节点（复用审阅队列）+ dry-run；激活前须真实数据试跑 + 人工确认；协调者每轮只调一次模型做决定，简单判断仍走 if；触发器执行（定时 cron 与事件，默认关，`triggers enable --yes` 开启，只跑 active 的工作流，详见 `docs/workflow.md`） |
| `nyra template <list\|show\|builtin\|import\|trial\|activate\|run\|dry-run\|remove\|publish\|install>` | 缺口 46：业务流程模板库——流程 DSL + 连接器 + 验收标准 + 试跑数据，激活前须真实数据试跑 + 人工确认；首批 5 个模板（店铺订单异常跟进打头），随机器人市场分发（详见 `docs/templates.md`） |
| `nyra script <check\|preauth>` | Pi Bot 借鉴第 1 条：脚本内容判定 + 摘要预授权——纯脚本（白名单静态分析）走快路径不用每次问，例行里的脚本按内容摘要 `script:<SHA-256>` 钉死，内容一改授权自动失效；判定结果写进证据链与审计（详见 `docs/script-purity.md`） |
| `nyra handover <contract\|checkers>` | Pi Bot 借鉴第 2 条：交接契约的程序化验收——交付物 + 验收项 + 修正轮次上限；验收是程序核对，不调模型，不过打回、轮次用完停下等人；打回与停下记一次信任阶梯违规；结果进证据链与审计（详见 `docs/handover-contract.md`） |
| `nyra fanout <list\|show\|recover>` | H-5 + H-6：后台扇出——顶层委派默认后台跑，跑完单条 consolidated 消息回填；合并步合成为一份交付物（详见 `docs/merge-fanout.md`） |
| `nyra team <create\|list\|show\|add\|remove\|dissolve\|dispatch\|handover\|writer\|lead>` | GROK 批（新缺口 52）：团队模式——参谋长独占入口，只拆解、分派、汇总；成员须有完整 Charter 才能接单；交接走 inbox/outbox/变更日志；对外动作一律回参谋长/人批；单写者门（同一文件同一时间只一个 agent 写，名额由参谋长移交）与零工具编排者（参谋长只剩委派工具）见 `docs/write-gate.md`；第 2 批 G-P1-3：lead 租约 + 纪元（`lead <status\|acquire\|release\|transfer>`，换 lead 纪元 +1，旧纪元指令不路由，详见 `docs/team.md`） |
| `nyra sfu <create\|rooms\|status\|join\|leave\|turn\|record\|close\|reclaim\|video>` | 第 2 批 G-P0-2：群组语音 SFU——选型 mediasoup（Node 原生库，不另起服务），本地实现不走网络；一个 agent + N 个说话者（上限 8，听众 32）、闲置 60 秒回收；TURN 凭据带 TTL（默认 3600 秒）；录制全体同意门（详见 `docs/sfu.md`）；第 3 批：`video` 群组视频——Producer/Consumer、按需看帧、带宽自适应、10 分钟模拟（详见 `docs/group-video.md`） |
| `nyra group <room\|chat\|plan>` | 第 2 批 G-P1-1/G-P1-2：群聊 swarm + 群组计划——`room` 建群聊房（顺序发言，round-robin/selector/handoff 三种模式）；`chat run/send` 跑群聊（终止条件可 AND/OR 组合：消息数/关键词/token 预算/超时/交接/外部叫停）；`plan` 建分工计划（每步有负责人与验收项，步骤走隔离 worktree、验收独立，详见 `docs/group-chat.md` 与 `docs/group-plan.md`） |
| `nyra meeting <create\|list\|join\|reconnect\|transcript\|minutes\|record\|dispatch>` | 第 3 批：进外部会议——Meet/Zoom 受控浏览器进会（只认 meet.google.com 与 zoom.us）、听字幕出纪要；进会、录制、发言都要机主批；断线重连纪元 +1、字幕去重、待办不重复派（详见 `docs/meeting.md`） |
| `nyra rendezvous <register\|nodes\|route\|status\|remove\|epoch>` | 第 3 批 G-P1-13：Rendezvous 多节点路由——HRW 一致性哈希把任务 key 路由到节点（只认本机/局域网端点，无 active 节点时拒绝路由，不静默本地执行；节点变更纪元 +1，详见 `docs/mesh.md`） |
| `nyra queue <enqueue\|list\|show\|claim\|complete\|fail>` | 第 3 批 G-P1-13：队列驱动底座——幂等键入队（重复提交回已有任务）、节点认领 + 租约（默认 60 秒）、完成须节点 + 租约令牌对得上、纪元防旧指令重执行（详见 `docs/mesh.md`） |
| `nyra subagent <list\|show\|register\|heartbeat\|sweep\|resume\|suspend\|stop\|confirm-stopped\|cancel-stop\|steer>` | 缺口 30：崩溃自续——子 agent 持久行 + 心跳检查点 + 启动扫荡 + 先验状态再续跑；H-3：单点停止（请求停止/确认停下/取消请求，停止现在真中断在途调用——模型请求 abort、工具与子进程被掐断，确认停下后才标已停，停不下来如实写“正在停止”，详见 `docs/roster.md` 与 `docs/cancellation.md`）；H-2：单点引导（排队式引导、检查点消费，`nyra subagent steer <运行 id> "<引导文本>" --yes`，详见 `docs/steer-schema.md`）；H-4：结构化输出契约（`delegate` / `delegate_parallel` 可带 `output_schema`，详见 `docs/steer-schema.md`） |
| `nyra roster <list\|show>` | H-1：实时花名册——每个子 agent 一行：状态 + 已耗时 + 当前动作（只读快照，token/费用默认不显示，详见 `docs/roster.md`） |
| `nyra side-effects <list\|show\|record\|mark\|recover>` | DSH-4：先存后做的副作用队列——执行前先落库，重启按年龄恢复、带 recovery note（详见 `docs/kanban.md`） |
| `nyra heartbeat <add\|list\|remove\|enable\|disable\|run\|commitments\|check-script\|wake\|seen-clear>` | 缺口 31：静默巡查——无事安静、有发现先记证据再写收件箱；推断承诺须用户确认一次、过期自动失效；零 Token 值守：巡检脚本预检（只跑本地只读命令，命中才通知/唤醒）、指纹去重（重复异常不重复通知）、唤醒入队只读任务、模型回 NO_REPLY 静默收敛（详见 `docs/heartbeat.md`） |
| `nyra governance <policy\|mandate\|mode\|dry-runs>` | 缺口 43：企业治理——版本化策略 + 不可变授权 + observe/auto 接单模式 + 干跑记录（详见 `docs/governance.md`） |
| `nyra governance caps <set\|list\|show\|check\|assign-team\|pause\|resume\|discard\|pauses>` | 缺口 43 第三批：分层成本上限——按 Bot/角色/团队/人设设月度美元与 token 上限，触顶进可恢复暂停态，放宽留痕（详见 `docs/governance.md`） |
| `nyra governance audit <export\|verify>` | 缺口 43 第三批：审计导出——治理审计日志导出给 SIEM（JSONL + 哈希链，可验证；详见 `docs/governance.md`） |
| `nyra kanban pause <id> "<原因>"` / `nyra kanban resume <id>` | 缺口 43 第三批：任务板 `paused` 状态——分层上限触顶暂停（可恢复，attempts 不动） |
| `nyra optimize <propose\|list\|show\|edit\|approve\|reject\|apply\|verify\|revert\|loop\|arms>` | G-4：带人批的自优化环——只起草改指令建议，须人批才生效，三数据集 + holdout 定放行；G-P1-29：`loop` 读评测报告自动起草提议并按 UCB 排队，`arms` 看臂排行（详见 `docs/governance.md`） |
| `nyra eval <scenarios\|scorecard\|benchmarks\|import\|benchmark\|remove\|probes\|probe\|manifest>` | G-P1-30：评测当一等公民——场景成绩单 + 外部基准集导入 + 仓内探针 + 可复现清单；跑评测走 `bun run scripts/eval.ts run --scenario/--benchmark/--probe`（详见 `docs/eval.md`） |
| `nyra review <list\|show\|approve\|reject\|apply…>` | 审阅队列：逐项批准并行线程与定时任务结果 |
| `nyra hitl <start\|takeover\|handback\|cancel\|status\|list>` | 对话转人工坐席（G-P1-32）：会话转给真人、真人接手、再接回 bot；转人工期间 bot 不自动回（详见 `docs/hitl.md`） |

## 扩展与集成

| 命令 | 作用 |
|---|---|
| `nyra plugin <list\|search\|install\|enable…>` | 插件市场（只装带来源、可审计的技能包） |
| `nyra creator "<一句话需求>"` | 创造模式：一句话搓出插件（先验证、经确认才安装） |
| `nyra kb <create\|list\|add\|search\|ask\|remove\|test>` | 本地知识库：外部文档（文本/Markdown/PDF/网页）收录、parent-child 分块、BM25 检索 + 确定性 rerank（`--no-rerank` 只按 BM25）+ 检索测试台，中文 PDF（带 ToUnicode）可读（详见 `docs/knowledge.md`） |
| `nyra knowledge test <库名> --file <问题文件>` | 检索测试台：批量典型问题看召回片段与分数，调参对比（`--no-rerank` 对比 BM25 原序，详见 `docs/knowledge.md`） |
| `nyra search <关键词> [--scope project\|all] [--session <会话 id>] [--after <日期>] [--before <日期>] [--limit <n>] [--export <路径>] [--json]` | 会话全文搜索：搜自己过去的对话，按会话分组回命中消息与上文下文；不给关键词列出最近会话；`--export` 把会话全文导出为 Markdown（详见 `docs/session-search.md`） |
| `nyra editor <serve\|status\|snapshot\|ask\|preview\|apply\|hosts>` | 编辑器插件：编辑器桥服务（VS Code / JetBrains / Zed 共用同一协议），快照带光标选区与诊断进模型上下文，diff 预览不动磁盘、应用须显式确认（详见 `docs/editor-plugins.md`） |
| `nyra hooks list` | 列出已安装的钩子 |
| `nyra permissions` | Poppy 站点授权意向（本地账本，只记录不授权） |
| `nyra eigenflux` | EigenFlux 接入检测与本地网络限制 |
| `nyra gmail <status\|auth\|search\|read\|send\|drafts\|send-draft\|labels\|label\|unlabel\|mark-read\|mark-unread\|trash\|attachment\|revoke>` | Gmail 连接器：读邮件、按 thread 回复、代发草稿（发信走审批）；草稿列表与发送草稿（G-P0-6 做深）；附件只读下载、标签、标已读、进回收站（写操作须显式确认；永久删除不提供，详见 `docs/connectors-gmail.md`） |
| `nyra connector <status\|list\|approve\|revoke\|auth\|install\|uninstall\|usage\|flows\|flow\|bundle>` | 连接器目录：安装 / 一键授权 / 撤销 / 用量 / 业务流程 / 导出连接器包（详见 `docs/connectors.md`） |
| `nyra shopify <auth\|status\|products\|product\|orders\|order\|fulfill\|inventory>` | Shopify 连接器（只读）：查商品、订单、库存；订单履约核查（G-P0-6 做深）；写操作一律拒绝（详见 `docs/connectors.md`） |
| `nyra slack <auth\|status\|channels\|history\|send\|card\|callback>` | Slack 连接器：读频道/消息、发消息（须显式批准）、发审批卡、按钮回调回写审批桥（G-P0-6 做深）；删消息/改频道/管理成员一律拒绝（详见 `docs/connectors.md`） |
| `nyra mcp server <status\|enable\|disable\|allow-writes-on\|allow-writes-off>` | 对外 MCP 服务开关：别的 agent 经网关 `POST /mcp` 调 Nyra 的记忆与任务（默认关闭；写操作须显式开且过独立审查，详见 `docs/mcp.md`） |
| `nyra peer <status\|enable\|disable\|list\|auth\|ask\|handoff\|card\|code\|add\|request\|accept\|friends\|block\|circle\|share\|grant\|proposal\|branch\|discover\|token>` | 对端协作：问别的 Nyra 实例、交接运行上下文、名片加好友（默认关闭；对外发送须开独立审查，详见 `docs/peer.md`）；第 2 批 G-P1-5/G-P1-6/G-P1-8/G-P1-10：名片 per-circle 可见性、带 scope 可吊销的 grant、对方写操作默认进提议、外来任务隔离分支；第 3 批 G-P1-4/G-P1-7：公开发现（well-known 名片 + 验签，不靠线下传码）、per-peer token（出站，每好友一条）、名片 JWS 签名（详见 `docs/peer-discovery.md`） |
| `nyra circle <create\|list\|show\|invite\|revoke\|delete\|bind\|unbind\|owner\|check\|bindings>` | 信任圈与跨实例准入：谁能给 agent 发任务（默认全封闭，圈外消息网关直接丢弃；详见 `docs/circles.md`） |
| `nyra org <create\|list\|show\|add\|remove\|role\|delete\|check>` | 组织与团队 workspace：组织/成员/角色 admin/member/viewer（机主是超级管理员；详见 `docs/orgs.md`） |
| `nyra org <share\|shared\|unshare\|grant-write\|revoke-write\|grants\|learnings\|workspace\|file-read\|cross-access\|catalog\|tasks\|task-add\|violations\|isolation\|memory>` | 共享 Bot（默认只读、写须主人接受）、租户隔离（任务与记忆带 org_id 归属、文件走组织工作区）、组织内私有目录（详见 `docs/orgs.md`） |
| `nyra session <create\|list\|show\|join\|leave\|delegate\|accept\|verify\|complete\|share\|frame\|record\|end\|join-request\|join-approve\|join-decline\|join-list>` | 跨 agent 联合会话：多人多 agent 视频会（本地扇出模型），会内委派 + 共享任务产物（allowlist），画面默认不留存、录制须全体同意；第 2 批 G-P1-5：好友进会要批（待批请求，批准时重查准入闸）；39-40 后续：交活即按契约跑验收（`verify` 看逐项结论，`complete` 须 `--confirm`/`--fail` 逐项确认，全通过才标 completed，详见 `docs/sessions.md`） |
| `nyra call <ledger\|show <通话 id>\|summary [--by-person]>` | 通话成本与隐私仪表：每通电话的三本账（传输/媒体/token，本地与云端分开记）+ 录制仪表 + 通话纪要进证据链；39-40 后续：`summary --by-person` 按人分摊（费用与 token 按参与人数平分，时长按各人实际在场时间，录制按各人同意且在场的时间，详见 `docs/call-ledger.md`） |
| `nyra budget <list\|show\|reserve\|settle\|release\|strict>` | 并发预算预留：模型调用前先预留额度、超上限不发请求；金额未知默认暂停等人工处理（详见 `docs/budget.md`） |
| `nyra agui <register\|list\|show\|link\|connect\|disconnect\|send\|exec\|accept-write\|revoke-write\|a2a\|serve>` | 协议中立接入：接任意 AG-UI endpoint 当 Bot（只读先行，写操作须机主显式接受），A2A 复用名片 + 交接；`serve` 把 Nyra 对外暴露成 AG-UI endpoint（详见 `docs/agui.md`） |
| `nyra acp <serve\|status\|grant\|revoke-grant>` | ACP 服务端：编辑器经 stdio 用 JSON-RPC 驱动 Nyra（只读先行，写操作进 peer 提议门，须机主逐条批）（详见 `docs/acp.md`） |
| `nyra a2a <serve\|card>` | A2A 服务端：别的 agent 经 HTTP 用 JSON-RPC 2.0 调用 Nyra（只读先行，写操作进 peer 提议门，须机主逐条批）（详见 `docs/a2a.md`） |
| `nyra screen <watch\|activity\|status\|takeover\|handover> <电脑 id>` | 缺口 50：只读看屏（实时画面 + 活动列表，帧指纹不记帧内容）与接管（take the wheel，须确认；接管期间 Bot 暂停、交还后从挂起点继续，全程记审计）；画面里密码/验证码/卡号自动打码（详见 `docs/bot-screen.md`） |
| `nyra voice <status\|speak <文字>\|enable-tts\|disable-tts\|transcribe <音频>\|realtime <list\|use\|status>>` | 语音指挥：看配置与可用性、读一段文字、开关自动回读；只转写不跑任务；实时语音服务商切换（默认 local，详见 `docs/realtime-voice.md`；详见 `docs/voice.md`） |
| `nyra voice call <start\|answer\|decline\|end\|status\|list\|segment\|confirm\|connect>` | 实时语音通话：建通话、喂音频段落转写、可选回读（本地 whisper 优先，云端默认关；`--transport webrtc` 走真 WebRTC 1:1 语音，`connect` 主动拨通；转写文字先审后发见 `docs/voice.md`） |
| `nyra video <call\|signal\|ice>` | 视频通话 + 按需视觉采样：信令 + TURN + ICE 直连传输，帧按需看（本地优先，云端默认关；详见 `docs/video-call.md`） |
| `nyra export --format docx\|xlsx\|pptx --from <内容 JSON> --out <路径>` | 成品导出：结构化内容写成可编辑的真办公文件，附事实核查（详见 `docs/office.md`） |
| `nyra media <status\|enable\|disable\|ingest <链接> [--out <路径>]\|setup\|scope …>` | 媒体抓取：公开视频 → 字幕/转写 → 文本（默认关；yt-dlp 二进制须 `nyra media setup` 按官方 release 下载并验签安装；详见 `docs/media-ingest.md`） |

## 自检与运维

| 命令 | 作用 |
|---|---|
| `nyra doctor [--provider 名字]` | 中文自检：运行时、配置、Key、网络、磁盘、写权限、密码箱 |
| `nyra status` | 诊断清单：坏配置、不可用沙箱、被忽略的权限、永不匹配的 hook matcher |
| `nyra setup` | 首次启动向导 |
| `nyra vault` | 凭据保险箱（加密存储，权限 0600） |

## 为什么需要这一页

之前没有任何一处把全部子命令列全，于是：

- 我加的 `tools` / `features` / `recall` / `savings` 只散在各自文档里
- CI 无法发现「代码有、文档没有」或「文档有、代码没有」

这一页 + 那条测试就是兜住这件事的机械手段。

## 事件与常驻（本轮补齐）

| 命令 | 作用 |
|---|---|
| `nyra events <list\|add\|remove\|enable\|disable\|test\|poll>` | 事件触发任务：webhook 与新邮件触发进任务队列（详见 [events.md](./events.md)） |
| `nyra mail-inbox <status\|enable\|disable\|allowlist\|set\|poll>` | 邮件即任务入口：白名单发件人的邮件直接进队列，跑完回信 |
| `nyra responsibility <list\|add\|set\|remove\|enable\|disable\|check\|pause\|resume\|complete\|cancel\|brief\|show>` | 持续责任语义：责任对象与晨间简报，无事安静 |