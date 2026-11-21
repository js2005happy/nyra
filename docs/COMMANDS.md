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
| `nyra --voice <音频路径> ["任务"]` | 语音指挥：先转文字再当任务跑（本地 whisper 优先、云端兜底；详见 docs/voice.md） |
| `nyra "任务" --speak` | 任务跑完后把结果读出来（默认关；只读结果前 500 字） |
| `nyra restore [检查点]` | 从影子快照恢复文件与会话 |

## 成本与用量

| 命令 | 作用 |
|---|---|
| `nyra cost --show` | 定价、单次上限、月度上限与本月已花 |
| `nyra cost --estimate "<任务>"` | 成本预估（含回忆感知的下调） |
| `nyra savings [任务]` | 省钱机制汇总 + 辅助模型实测节省 + 逐模型明细 |
| `nyra stats [--heatmap]` | 本月用量与每日热力图 |

## 配置与开关

| 命令 | 作用 |
|---|---|
| `nyra config export / import` | 设置导出与导入（默认剔除密钥；越权字段需 `--allow-dangerous`） |
| `nyra config explain [能力]` | 这个能力由哪个键控制、现在生效吗 |
| `nyra features` | 功能开关列表（CLI > config > 默认） |
| `nyra tools` | 工具集体检：每轮 schema 成本与裁剪建议 |
| `nyra models [list\|show\|refresh\|fallback]` | 模型上下文窗口查询与刷新；`fallback` 看备用链开关、顺序与本月切换统计 |
| `nyra reviewer <status\|enable\|disable\|set-model\|add-rule\|remove-rule\|list-rules\|check>` | 独立审查层：敏感工具调用先过独立审查 agent，审查失败即拦截（详见 `docs/reviewer.md`） |
| `nyra verifier <status\|enable\|disable\|set-model\|rework-on\|rework-off\|add-rule\|remove-rule\|list-rules\|check>` | 验收者：并行产出合入前先验收，不通过打回重做，结论进证据链（详见 `docs/verifier.md`） |
| `nyra account <status\|login\|logout\|list\|revoke\|link\|suspend\|reactivate>` | 用户账号登录：Google / GitHub / 邮箱 / SSO，账号身份 + 会话（详见 `docs/accounts.md`） |
| `nyra sso <provider\|login\|status\|scim>` | 缺口 43 第二批：企业 SSO——OIDC 身份提供方注册与登录、SCIM 账号开通（详见 `docs/sso.md`） |
| `nyra init [--name 名字] [--role researcher\|assistant\|shopkeeper\|custom] [--work 干什么活] [--persona 风格] [--redline 红线] [--agent default] [--yes] [--force]` | 缺口 35：对话式入职——三个问题（叫什么、干什么活、什么风格/红线）→ 生成 Soul + 按角色预装技能包 + 配置清单确认后生效，确认后发就绪简报（详见 `docs/onboarding.md`） |
| `nyra templates <list\|show <角色>\|apply <角色>\|export <角色> <文件>\|import <文件>>` | 缺口 35：一键角色模板——研究员 / 助理 / 店小二（Soul + 技能包 + 权限规则的打包文件，可导出成本地文件分享；导入先验后装；与 `nyra template` 业务流程模板不同，详见 `docs/onboarding.md`） |
| `nyra wake` | 缺口 35：唤醒——重发一次就绪简报（我是谁、我会什么、我的红线、本次 0 token），走终端 + 机主收件箱（详见 `docs/onboarding.md`） |

## 记忆与复用

| 命令 | 作用 |
|---|---|
| `nyra recall "<任务>" [--cross-dir]` | 查这个任务有哪些历史可复用 |
| `nyra memory <export\|import\|search\|forget…>` | 记忆交换与检索/删除 |
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
| `nyra responsibility <list\|add\|remove\|enable\|disable\|check\|pause\|resume\|complete\|cancel\|brief\|show>` | 持续责任语义：责任对象（归属人 + 验收标准 + 升级条件 + 过期时间）与晨间简报，无事安静（详见 `docs/responsibilities.md`） |
| `nyra bot telegram <start\|stop\|status>` | Bot 方向 Phase 1+2+3：Telegram 渠道（长轮询收消息、会话串行、去重配额、确定性指令；角色路由与聊天内审批；主动推送 notifier 与附件处理，详见 `docs/bot.md`） |
| `nyra bot discord <start\|stop\|status>` | Bot 方向：Discord 渠道（Gateway 收 MESSAGE_CREATE 事件、REST 发/编辑消息；需 Message Content Intent，详见 `docs/bot.md`） |
| `nyra bot slack <start\|stop\|status>` | Bot 方向：Slack 渠道（Socket Mode 收 app_mention/message.im 事件、Web API 发/编辑消息；需 app token + bot token，详见 `docs/bot.md`） |
| `nyra bot whatsapp <start\|stop\|status>` | Bot 方向：WhatsApp 渠道（Cloud API 发消息 + webhook 收消息；需 access token + 号码 id + 公网入口，详见 `docs/bot.md`） |
| `nyra bot redlines <status\|list\|show\|tighten\|loosen\|set>` | Bot 缺口 51：业务动作硬红线表——发消息/付款/删除永远须人批，转钱/交易证券永远禁做（详见 `docs/business-redlines.md`） |
| `nyra bot computer <create\|list\|status\|sleep\|wake\|remove\|credential\|shell\|sleep-due>` | Bot 缺口 42 第一批 + 第二批：每 Bot 一台持久电脑——持久 workspace + 浏览器 profile + 凭证 Vault + 隔离分级；第二批 BotRunner 接线：Bot 启动时绑电脑、Agent 在电脑的 workspace 里跑、`/computer-shell`（详见 `docs/bot-computer.md` 与 `docs/bot.md`） |
| `nyra bot status` | Bot 总览：Telegram/Discord/Slack/WhatsApp 运行态 + 电脑数量与资源，本 Bot 的电脑带标注（详见 `docs/bot.md` 与 `docs/bot-computer.md`） |
| `nyra channels <start\|stop\|status\|health\|bindings\|explain>` | 缺口 27：常驻多渠道网关——四渠道一个进程、bindings 确定性路由、渠道会话默认进沙箱、每条入站路由进证据链、语音指挥入口（详见 `docs/channels.md`） |
| `nyra task <add\|list\|show\|cancel\|worker\|approve>` | 后台任务队列 |
| `nyra kanban <create\|list\|show\|start\|fail\|review\|decide\|verify\|done\|reset\|remove\|tick\|sweep>` | 缺口 26：持久任务板——任务是账本里的一行，崩溃不丢、熔断进 blocked、完成须附验证证据（详见 `docs/kanban.md`） |
| `nyra reconciler <scan\|status\|enable\|disable\|config\|settle>` | Pi Bot 借鉴第 3 条：卡住步骤看门狗——working 任务超时无进展先标出来、再按轮次上限自动重排、超限进 blocked 只等人；自动巡查默认关（详见 `docs/reconciler.md`） |
| `nyra watch <add\|list\|show\|remove\|check\|enable\|disable\|config\|run-action>` | 缺口 32：变化监测例程——盯页面或文件，变了才汇报（变了什么 → 详情 → 来源）；触发条件与动作分开声明，下载类敏感动作须人批；自动巡查默认关（详见 `docs/watch.md`） |
| `nyra goal <create\|list\|show\|add-item\|start-item\|verify-item\|complete\|pause\|resume\|cancel\|instruct\|link\|split>` | GROK-5（缺口 26/30 深化）：长目标对象——目标陈述 + 动态进度清单 + 逐项验证，全部通过才标完成；中途加指令不丢目标，可暂停/恢复/取消；恢复前重验证；目标可拆成任务板任务（详见 `docs/goal-object.md`） |
| `nyra trust <register\|list\|show\|evidence\|promote\|demote\|review\|check>` | GROK-6（缺口 43 治理深化）：信任阶梯——新 agent / 新技能默认只读，攒够 N 次连续成功且零违规才升一级（只读 → 起草 → 发送 → 购买）；每次记成功有概率被随机抽查，抽中须复核才计入；降级随时可做（详见 `docs/trust-ladder.md`） |
| `nyra workflow <import\|list\|show\|run\|dry-run\|resume\|trial\|activate\|remove\|verify>` | 缺口 25 其余形态：声明式可复用工作流——三种执行形态（固定图 / 协调者 / 动态）+ 审批节点（复用审阅队列）+ dry-run；激活前须真实数据试跑 + 人工确认；协调者每轮只调一次模型做决定，简单判断仍走 if（详见 `docs/workflow.md`） |
| `nyra template <list\|show\|builtin\|import\|trial\|activate\|run\|dry-run\|remove\|publish\|install>` | 缺口 46：业务流程模板库——流程 DSL + 连接器 + 验收标准 + 试跑数据，激活前须真实数据试跑 + 人工确认；首批 5 个模板（店铺订单异常跟进打头），随机器人市场分发（详见 `docs/templates.md`） |
| `nyra script <check\|preauth>` | Pi Bot 借鉴第 1 条：脚本内容判定 + 摘要预授权——纯脚本（白名单静态分析）走快路径不用每次问，例行里的脚本按内容摘要 `script:<SHA-256>` 钉死，内容一改授权自动失效；判定结果写进证据链与审计（详见 `docs/script-purity.md`） |
| `nyra handover <contract\|checkers>` | Pi Bot 借鉴第 2 条：交接契约的程序化验收——交付物 + 验收项 + 修正轮次上限；验收是程序核对，不调模型，不过打回、轮次用完停下等人；打回与停下记一次信任阶梯违规；结果进证据链与审计（详见 `docs/handover-contract.md`） |
| `nyra fanout <list\|show\|recover>` | H-5 + H-6：后台扇出——顶层委派默认后台跑，跑完单条 consolidated 消息回填；合并步合成为一份交付物（详见 `docs/merge-fanout.md`） |
| `nyra team <create\|list\|show\|add\|remove\|dissolve\|dispatch\|handover>` | GROK 批（新缺口 52）：团队模式——参谋长独占入口，只拆解、分派、汇总；成员须有完整 Charter 才能接单；交接走 inbox/outbox/变更日志；对外动作一律回参谋长/人批（详见 `docs/team.md`） |
| `nyra subagent <list\|show\|register\|heartbeat\|sweep\|resume\|suspend\|stop\|confirm-stopped\|cancel-stop\|steer>` | 缺口 30：崩溃自续——子 agent 持久行 + 心跳检查点 + 启动扫荡 + 先验状态再续跑；H-3：单点停止（请求停止/确认停下/取消请求，详见 `docs/roster.md`）；H-2：单点引导（排队式引导、检查点消费，`nyra subagent steer <运行 id> "<引导文本>" --yes`，详见 `docs/steer-schema.md`）；H-4：结构化输出契约（`delegate` / `delegate_parallel` 可带 `output_schema`，详见 `docs/steer-schema.md`） |
| `nyra roster <list\|show>` | H-1：实时花名册——每个子 agent 一行：状态 + 已耗时 + 当前动作（只读快照，token/费用默认不显示，详见 `docs/roster.md`） |
| `nyra side-effects <list\|show\|record\|mark\|recover>` | DSH-4：先存后做的副作用队列——执行前先落库，重启按年龄恢复、带 recovery note（详见 `docs/kanban.md`） |
| `nyra heartbeat <add\|list\|remove\|enable\|disable\|run\|commitments>` | 缺口 31：静默巡查——无事安静、有发现先记证据再写收件箱；推断承诺须用户确认一次、过期自动失效（详见 `docs/heartbeat.md`） |
| `nyra governance <policy\|mandate\|mode\|dry-runs>` | 缺口 43：企业治理——版本化策略 + 不可变授权 + observe/auto 接单模式 + 干跑记录（详见 `docs/governance.md`） |
| `nyra governance caps <set\|list\|show\|check\|assign-team\|pause\|resume\|discard\|pauses>` | 缺口 43 第三批：分层成本上限——按 Bot/角色/团队/人设设月度美元与 token 上限，触顶进可恢复暂停态，放宽留痕（详见 `docs/governance.md`） |
| `nyra governance audit <export\|verify>` | 缺口 43 第三批：审计导出——治理审计日志导出给 SIEM（JSONL + 哈希链，可验证；详见 `docs/governance.md`） |
| `nyra kanban pause <id> "<原因>"` / `nyra kanban resume <id>` | 缺口 43 第三批：任务板 `paused` 状态——分层上限触顶暂停（可恢复，attempts 不动） |
| `nyra optimize <propose\|list\|show\|edit\|approve\|reject\|apply\|verify\|revert>` | G-4：带人批的自优化环——只起草改指令建议，须人批才生效，三数据集 + holdout 定放行（详见 `docs/governance.md`） |
| `nyra review <list\|show\|approve\|reject\|apply…>` | 审阅队列：逐项批准并行线程与定时任务结果 |

## 扩展与集成

| 命令 | 作用 |
|---|---|
| `nyra plugin <list\|search\|install\|enable…>` | 插件市场（只装带来源、可审计的技能包） |
| `nyra creator "<一句话需求>"` | 创造模式：一句话搓出插件（先验证、经确认才安装） |
| `nyra kb <create\|list\|add\|search\|ask\|remove\|test>` | 本地知识库：外部文档（文本/Markdown/PDF/网页）收录、分块、BM25 检索 + 检索测试台（详见 `docs/knowledge.md`） |
| `nyra knowledge test <库名> --file <问题文件>` | 检索测试台：批量典型问题看召回片段与分数，调参对比（详见 `docs/knowledge.md`） |
| `nyra hooks list` | 列出已安装的钩子 |
| `nyra permissions` | Poppy 站点授权意向（本地账本，只记录不授权） |
| `nyra eigenflux` | EigenFlux 接入检测与本地网络限制 |
| `nyra gmail <status\|auth\|search\|read\|send\|labels\|label\|unlabel\|mark-read\|mark-unread\|trash\|attachment\|revoke>` | Gmail 连接器：读邮件、按 thread 回复、代发草稿（发信走审批）；附件只读下载、标签、标已读、进回收站（写操作须显式确认；永久删除不提供，详见 `docs/connectors-gmail.md`） |
| `nyra connector <status\|list\|approve\|revoke\|auth\|install\|uninstall\|usage>` | 连接器目录：安装 / 一键授权 / 撤销 / 用量（详见 `docs/connectors.md`） |
| `nyra shopify <auth\|status\|products\|product\|orders\|order\|inventory>` | Shopify 连接器（只读）：查商品、订单、库存；写操作一律拒绝（详见 `docs/connectors.md`） |
| `nyra slack <auth\|status\|channels\|history\|send\|card>` | Slack 连接器：读频道/消息、发消息（须显式批准）、发审批卡；删消息/改频道/管理成员一律拒绝（详见 `docs/connectors.md`） |
| `nyra mcp server <status\|enable\|disable\|allow-writes-on\|allow-writes-off>` | 对外 MCP 服务开关：别的 agent 经网关 `POST /mcp` 调 Nyra 的记忆与任务（默认关闭；写操作须显式开且过独立审查，详见 `docs/mcp.md`） |
| `nyra peer <status\|enable\|disable\|list\|auth\|ask\|handoff\|card\|code\|add\|request\|accept\|friends\|block\|circle\|share>` | 对端协作：问别的 Nyra 实例、交接运行上下文、名片加好友（默认关闭；对外发送须开独立审查，详见 `docs/peer.md`） |
| `nyra circle <create\|list\|show\|invite\|revoke\|delete\|bind\|unbind\|owner\|check\|bindings>` | 信任圈与跨实例准入：谁能给 agent 发任务（默认全封闭，圈外消息网关直接丢弃；详见 `docs/circles.md`） |
| `nyra session <create\|list\|show\|join\|leave\|delegate\|accept\|complete\|share\|frame\|record\|end>` | 跨 agent 联合会话：多人多 agent 视频会（本地扇出模型），会内委派 + 共享任务产物（allowlist），画面默认不留存、录制须全体同意（详见 `docs/sessions.md`） |
| `nyra voice <status\|speak <文字>\|enable-tts\|disable-tts>` | 语音指挥：看配置与可用性、读一段文字、开关自动回读（默认关；详见 `docs/voice.md`） |
| `nyra voice call <start\|answer\|decline\|end\|status\|list\|segment\|confirm>` | 实时语音通话：建通话、喂音频段落转写、可选回读（本地 whisper 优先，云端默认关；详见 `docs/voice.md`） |
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
| `nyra responsibility <list\|add\|remove\|enable\|disable\|check\|pause\|resume\|complete\|cancel\|brief\|show>` | 持续责任语义：责任对象与晨间简报，无事安静 |