// src/cli.ts — Nyra Node 版命令行入口（第 2 阶段）。
// 命令与 flag 与 Python 版 nyra/cli.py 一一对应：一次性任务 / REPL /
// schedule 子命令 / task 子命令 / --plan / --execute-plan / --resume /
// --resume-run / --verify / --list-providers / --list-skills / --json / --mode。
// 终端交互按方案 2.6 末尾：审核选择器默认是、REPL 状态行、命令实时流式输出。
// permissions / eigenflux 在第 4 阶段已原生化（src/poppy.ts、src/eigenflux.ts、
// src/eigenfluxPolicy.ts）；worker 桥与 Python 运行时已移除。
// ui（gateway）与 MCP 客户端在第 3 阶段已原生化。
import { createInterface } from "node:readline";
import { encode as qrEncode, toTerminal as qrToTerminal } from "./qrcode.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadConfig, resolveHome, resolveProvider, resolveProfile, resolveSwitchAllowlist,
  listProfiles, validateMode, resolveSandbox, PROVIDERS, VERSION, envVar, getProviderPresets, saveConfig,
} from "./config.ts";
import { Provider, FallbackProvider, buildProviderChain, makeModelFactory, ProviderError, switchTriggerFor, type RetryRecord, type SwitchRecord } from "./providers.ts";
import { Agent, AgentError, resolveMaxDelegateDepth, type ContextUsage, type VoiceReviewResult } from "./agent.ts";
import { RunStore, RunRecorder, prepareResume, loadCompletedWriteKeys, resolveVerifyOrigin, acceptVerifyCommand, resolveVerifySettings, downgradeCompletionClaim, formatRunReport, verifyEvidenceChain, formatEvidenceReport, computeRunStats } from "./runs.ts";
import { buildTimeline, formatTimelineText, formatReplayText, exportTimelineMarkdown } from "./timeline.ts";
import { resolvePricing, resolveMonthlyLimit } from "./cost.ts";
import { handleCost } from "./costCli.ts";
import { handleStats, formatMonthLine } from "./statsCli.ts";
import { handleTelemetry } from "./telemetryCli.ts";
import { handleAcp } from "./acpCli.ts";
import { handleA2a } from "./a2aCli.ts";
import { formatModelSwitchNotice, modelSwitchSummaryLine, recordModelSwitch, switchTimeShort } from "./modelSwitch.ts";
import { handleModels } from "./modelsCli.ts";
import { resolvePresetFallbackChain } from "./modelPresets.ts";
import { handleMemoryGate } from "./memoryGateCli.ts";
import { loadModelCache, manualWindowFromConfig, resolveContextWindow } from "./modelCatalog.ts";
import { modelSupportsVision, prepareVisionInputs, resolveVisionConfig, visionGateMessage } from "./vision.ts";
import { classifyFailure, formatFailureLine } from "./failures.ts";
import { parseRules } from "./permissionRules.ts";
import { checkRedlines, formatRedlines, toRedlinesJson } from "./redlines.ts";
import { handleConfig } from "./configCli.ts";
import { explainAll, explainOne, formatExplain } from "./configExplain.ts";
import { summarizeSavings as summarizeCostSavings, formatSavings, formatRedlinesWithSavings } from "./savingsSummary.ts";
import { summarizeModelSavings, formatModelSavings } from "./modelSavings.ts";
import { toSavingsJson } from "./savingsSummary.ts";
import { buildVerdict, buildRunVerdict, buildTrendVerdict, formatVerdict, toVerdictJson, guardExitCode, formatGuardLine, type Verdict as VerdictShape } from "./verdict.ts";
import { subcommandSet } from "./subcommands.ts";
import { checkDocs } from "./docCheck.ts";
import type { RedlineResult } from "./redlines.ts";
import { measureToolBudget, filterSchemas, summarizeSavings, formatToolBudget } from "./toolBudget.ts";
import { resolveFeatures, featureOn, formatFeatures } from "./features.ts";
import { resolveExtraDirs } from "./extraDirs.ts";
import { resolveReviewerModel } from "./reviewer.ts";
import { resolveEnforced, applyEnforced, formatEnforced, effectiveValue, effectiveStringList } from "./enforcedConfig.ts";
import { buildRecallNote, selectRecalledRuns } from "./runRecall.ts";
import { resolveAuxRouting, resolvePlanActRouting } from "./modelRouting.ts";
import { resolveReasoningOptions, toRequestBody } from "./reasoning.ts";
import { loadSession, listSessions, saveSession, newSessionId } from "./memory.ts";
import { loadSkills, canonicalSkillDirs } from "./skills.ts";
import {
  renderHeader, renderTrustPrompt, renderInputFrame, inputRows, supportsBoxDrawing, renderTips, renderEcho,
  renderReply, renderOk, renderError, gitBranch, stripAnsi,
} from "./banner.ts";
import { isLightTerminal } from "./termMark.ts";
import { detectColorLevel, type ColorLevel } from "./theme.ts";
import {
  PetController, PET_WIDTH, petVisible, petEnabledFromConfig, parsePetCommand, renderPet, renderBubble, petFace,
} from "./pet.ts";
import { Spinner } from "./spinner.ts";
import { formatUsage, windowSourceLabel, type UsageSnapshot } from "./usage.ts";
import { UsageLedger, formatHeatmap, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { formatReplStatus, ToolPrinter, useColor, textWidth } from "./consoleUi.ts";
import { dashboardCostSegment } from "./dashboard.ts";
import { askApproval, approvalHooks } from "./approvalUi.ts";
import { JsonLines, invalidArguments, EXIT_SUCCESS, EXIT_RUNTIME, EXIT_ARGUMENT, EXIT_INCOMPLETE, EXIT_VERIFY, EXIT_INTERRUPTED, EXIT_COST } from "./jsonMode.ts";
import { buildPlan, renderPlan, savePlan, readApprovedPlan, approvedExecutionTask, PlanError } from "./planMode.ts";
import { handleTask } from "./tasks.ts";
import { handleReview } from "./reviewQueue.ts";
import { handleVerifier, resolveVerifierModel, verifierConfig } from "./verifier.ts";
import { handleRegression } from "./regression.ts";
import { handleKanban } from "./kanban.ts";
import { handleGoal } from "./goal.ts";
import { handleWorkflow } from "./workflow.ts";
import { handleTemplate } from "./templates.ts";
import { handleScript } from "./scriptCli.ts";
import { handleHandover } from "./handoverCli.ts";
import { handleReconciler } from "./reconciler.ts";
import { handleWatch } from "./watch.ts";
import { attachContractToRun, handleContract } from "./contract.ts";
import { handleGolden, stripRunReport, type GoldenRunner } from "./golden.ts";
import { handleFanout } from "./fanout.ts";
import { handleTeam, type TeamDispatchPlan } from "./team.ts";
import { handleSubagent } from "./resume.ts";
import { handleRoster } from "./roster.ts";
import { handleSideEffects } from "./sideEffects.ts";
import { handleHeartbeat } from "./heartbeat.ts";
import { handleGovernance } from "./governance.ts";
import { handleTrust } from "./trustLadder.ts";
import { makeTieredCapCheck, type TieredCtxHolder } from "./costCaps.ts";
import { handleOptimize } from "./optimizer.ts";
import { handleSso } from "./sso.ts";
import { loadSchedule, saveSchedule, addScheduleTask, removeScheduleTask, listScheduleTasks, runDaemon, ScheduleError, type ScheduleTask } from "./scheduler.ts";
import {
  loadEventTriggers, saveEventTriggers, addEventTrigger, removeEventTrigger, setEventTriggerEnabled,
  listEventTriggers, matchEventTrigger, buildTriggerPrompt, pollGmailTriggers, EventTriggerError,
} from "./eventTriggers.ts";
import { MailInboxError } from "./mailInbox.ts";
import { ResponsibilityError } from "./responsibilities.ts";
import { knowledgeMain } from "./knowledge.ts";
import { handleSearch } from "./searchCli.ts";
import { handleEditor } from "./editorCli.ts";
import { PermissionLedger, PermissionConflict } from "./poppy.ts";
import { doctor as eigenfluxDoctor, onboardingSteps as eigenfluxOnboarding, doctorExitCode as eigenfluxDoctorExitCode } from "./eigenflux.ts";
import { NetworkPolicy } from "./eigenfluxPolicy.ts";
import { printDoctorResult, runDoctor } from "./doctor.ts";
import { t, getLang, setLang, detectLang, extractLangFlag, normalizeLang, type MsgKey } from "./i18n.ts";
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——main 入口做 fail-closed 校验，
// buildAgent 把解析出的沙箱配置透传给 Agent（再进 ToolContext）。
import { resolveSandboxBackend, getSandboxStatus } from "./sandbox.ts";
import { runExampleTask } from "./exampleTask.ts";
import { printNoKeyAndExitCode } from "./noKey.ts";
import { defaultExampleFile, runWizard } from "./wizard.ts";
import { ensureNyraHome } from "./migration.ts";
import { ApprovalRequired, TOOL_SCHEMAS } from "./tools.ts";
import { Vault, vaultUsage, VaultError } from "./vault.ts";
import { runCreator, verifyStagedPlugin, installStagedPlugin, describePlannedChanges, CreatorError } from "./creator.ts";
import { listHookEntries, runHooks, HOOK_EVENTS } from "./hooks.ts";
import { runStatusChecks, formatStatusReport } from "./status.ts";
import { Gateway } from "./gateway.ts";
import { GatewayClient } from "./gatewayClient.ts";
import { ConversationStore } from "./conversations.ts";
import { rewindTo, rewindEdit, rewindFork, storeHistoryToAgentMessages } from "./rewind.ts";
import { ShadowSnapshotStore, buildRestoreNote, type RestoreMode, type RestoreResult, type SnapshotRecord } from "./shadowSnapshots.ts";
import { loadMcpServers, handleMcpServer } from "./mcp.ts";
import { handlePeer } from "./peer.ts";
import { handlePeerFriends, PEER_FRIEND_COMMANDS } from "./peerCard.ts";
import { handleCircle } from "./circles.ts";
import { handleOrg } from "./orgCli.ts";
import { handleSession } from "./session.ts";
import { callLedgerMain } from "./callLedger.ts";
import { budgetMain } from "./budgetCli.ts";
import { aguiMain } from "./agui.ts";
import { handleScreen } from "./botScreen.ts";
import { handleScreenTakeover } from "./botTakeover.ts";
import { handleInit, handleTemplates, handleWake, makeLineAsker } from "./onboarding.ts";
import { reviewBusinessAction, appendBusinessRedlineAudit } from "./businessRedlines.ts";
import { handleVoice, loadAudioFile, resolveVoiceConfig } from "./voice.ts";
import { handleVoiceCall } from "./voiceCall.ts";
import { handleVideo } from "./videoCall.ts";
import { handleSoul, resolveSoulAgentId } from "./soul.ts";
import { handleExport } from "./office.ts";
import { handleMedia } from "./mediaIngest.ts";
import { listPresets } from "./mcpPresets.ts";
import { buildNotifierFromConfig, handleBot, type BotNotifier } from "./bot/index.ts";
import { handleChannels } from "./channels/cli.ts";
import { resolveAgentWorkdir } from "./bot/binding.ts";
import {
  PluginError, installPlugin, uninstallPlugin, listPlugins, verifyPlugin,
  setPluginStatus, setPluginPinned, pluginSkillDirs, auditPlugins, searchRegistry,
  STALE_AFTER_DAYS,
} from "./plugins.ts";

export const USAGE = `Nyra ${VERSION}（Node 运行时）

用法：
nyra "任务" [--provider 名字] [--mode readonly|auto|full|creator]   一次性执行任务
nyra "任务" --image <图片路径> [--image ...] [--video <视频路径或链接>]   带图/视频做任务（图片 PNG/JPEG/WebP/GIF，视频先抽帧；模型须支持看图，详见 docs/vision.md）
nyra --voice <音频路径> ["任务"]   语音指挥：先转文字再当任务跑（wav/mp3/m4a/ogg/flac；本地 whisper 优先、云端兜底，详见 docs/voice.md）
nyra "任务" --speak   任务跑完后把结果读出来（默认关；只读结果前 500 字）
nyra voice <status|speak <文字>|enable-tts|disable-tts>   语音：看配置与可用性、读一段文字、开关自动回读（详见 docs/voice.md）
nyra voice call <start|answer|decline|end|status|list|segment|confirm>   实时语音通话：建通话、喂音频段落转写、可选回读（本地 whisper 优先，云端默认关；详见 docs/voice.md）
nyra video <call|signal|ice>   视频通话 + 按需视觉采样：信令 + TURN + ICE 直连传输，帧按需看（本地优先，云端默认关；详见 docs/video-call.md）
--max-cost <美元> --monthly-max-cost <美元>   单次 / 月度支出上限（超限即停；月度默认不设上限）
nyra                                                        进入交互模式（REPL）
nyra --help                    显示帮助（不用 Key、不联网）
nyra --version                 显示版本
nyra --list-providers          列出所有可用 provider（内置预设 + 自定义）
nyra --list-models [--provider 名字]   列出该来源的已知模型
nyra --list-profiles           列出已配置的 provider 档案
nyra --list-skills             列出已加载的技能
nyra --list-sessions           列出历史会话
nyra --list-mcp                列出已配置的 MCP 服务器与预置（第 3 阶段原生）
nyra ui [--host 127.0.0.1] [--port 8765] [--pair] [--open]   启动 gateway 网页界面
nyra ui --print-url-json --exit-on-stdin-close   桌面外壳模式：stdout 首行一行 JSON，stdin 关闭即退出
nyra gw <sessions|send|view|approve|rewind|info|schedule>   连正在跑的 gateway 当客户端
nyra --compact <会话 ID>       压缩指定会话后退出
REPL：/context 查看上下文占用；/compact focus <关键词> 按重点压缩会话（详见 docs/context.md）
nyra --resume <会话 ID>        继续指定会话
nyra --resume-run <运行 ID>    从运行记录断点续跑
nyra evidence verify <运行 ID>   独立复核运行的证据链（工具调用 → 产物 → 校验结果，详见 docs/evidence.md）
nyra timeline <运行 ID> [--verbose] [--json] [--out <路径>]   执行时间线：按时间重建一次多 agent 任务（只读回放，不重新执行，详见 docs/timeline.md）
nyra replay <运行 ID> [--verbose]   会话回放：按轮次逐步重现一次运行的关键步骤（只读，不重新执行）
nyra regression <list|precipitate --run <运行 ID>|remove <用例 id>|status <用例 id> <open|verified|retired>>   回归测例库：把一次运行的失败步骤沉淀为回归用例（只记元数据，不调模型、不自动重跑，详见 docs/regression.md）
nyra contract <create|list|show|activate|attach|verify|mark-item|remove|stats>   交付契约（缺口 29）：接单时先定验收标准（交付物 + 检查清单），跑完逐项打分，全部通过才算被接受（详见 docs/delivery-contract.md）
nyra golden <add|list|show|remove|run|rescore>   Golden 测试集（G-2）：固定输入 + 期望输出 + 期望工具轨迹，跑分看结果分与轨迹分（详见 docs/delivery-contract.md）
nyra "任务" --contract <契约 id>   本次运行挂上已激活的交付契约，收尾逐项打分进运行报告
nyra kanban <create|list|show|start|fail|review|decide|verify|done|reset|remove|tick|sweep>   持久任务板：任务是账本里的一行，崩溃不丢、熔断进 blocked、完成须附验证证据（详见 docs/kanban.md）
nyra goal <create|list|show|add-item|start-item|verify-item|complete|pause|resume|cancel|instruct|link|split>   长目标对象：目标陈述 + 动态进度清单 + 逐项验证，全部通过才标完成；中途加指令不丢目标，可暂停/恢复/取消（详见 docs/goal-object.md）
nyra subagent <list|show|register|heartbeat|sweep|resume|suspend|stop|confirm-stopped|cancel-stop|steer>   崩溃自续：子 agent 持久行 + 心跳检查点 + 启动扫荡 + 先验状态再续跑 + 单点停止 + 单点引导（详见 docs/kanban.md、docs/roster.md 与 docs/steer-schema.md）
nyra roster <list|show>   实时花名册：每个子 agent 一行——状态 + 已耗时 + 当前动作（只读快照，不花 token；token/费用默认不显示，详见 docs/roster.md）
nyra side-effects <list|show|record|mark|recover>   先存后做的副作用队列：执行前先落库，重启按年龄恢复、带 recovery note（详见 docs/kanban.md）
nyra heartbeat <add|list|remove|enable|disable|run|wake|check-script|seen-clear|commitments>   静默巡查：无事安静、有发现先记证据再写收件箱；重复异常指纹去重只通知一次；本地脚本预检（零 Token）与唤醒主控默认关；推断承诺须用户确认一次、过期自动失效（详见 docs/heartbeat.md）
nyra fanout <list|show|recover>   后台扇出：顶层委派立即回 handle，跑完单条回填收件箱；跑一半的进程退出后须 recover 回收（详见 docs/merge-fanout.md）
nyra team <create|list|show|add|remove|dissolve|dispatch|handover|lead|writer>   团队模式（新缺口 52）：参谋长独占入口，只拆解、分派、汇总；成员须有完整 Charter 才能接单；交接走 inbox/outbox/变更日志；对外动作一律回参谋长/人批；lead 租约 + 纪元防旧参谋长晚到指令（详见 docs/team.md）
nyra governance <policy|mandate|mode|dry-runs>   企业治理：版本化策略 + 不可变授权 + observe/auto 接单模式 + 干跑记录（详见 docs/governance.md）
nyra governance caps <set|list|show|check|assign-team|pause|resume|discard|pauses>   分层成本上限：按 Bot/角色/团队/人设设月度上限，触顶进可恢复暂停态
nyra governance audit <export|verify>   审计导出：治理审计日志导出给 SIEM（JSONL + 哈希链，可验证）
nyra optimize <propose|list|show|edit|approve|reject|apply|verify|revert|loop|arms>   带人批的自优化环：只起草改指令建议，须人批才生效，三数据集 + holdout 定放行；loop 读评测报告自动起草并按 UCB 排队（详见 docs/governance.md）
nyra eval <scenarios|scorecard|benchmarks|import|benchmark|remove|probes|probe|manifest>   评测当一等公民：场景成绩单 + 外部基准集导入 + 仓内探针 + 可复现清单（只读为主，跑评测走 bun run scripts/eval.ts；详见 docs/eval.md）
nyra trust <register|list|show|evidence|promote|demote|review|check>   信任阶梯（GROK-6，缺口 43 治理深化）：新 agent / 新技能默认只读，攒够 N 次连续成功且零违规才升一级；每次记成功有概率被随机抽查，抽中须复核才计入；降级随时可做（详见 docs/trust-ladder.md）
nyra workflow <import|list|show|run|dry-run|resume|trial|activate|remove|verify|triggers>   声明式可复用工作流（缺口 25）：YAML/JSON 定义 + 三种执行形态（固定图/协调者/动态）+ 审批节点 + dry-run，激活前须真实数据试跑 + 人工确认；触发器执行默认关，须显式开启（详见 docs/workflow.md）
nyra template <list|show|builtin|import|trial|activate|run|dry-run|remove|publish|install>   业务流程模板库（缺口 46）：流程 DSL + 连接器 + 验收标准 + 试跑数据，激活前须真实数据试跑 + 人工确认，随机器人市场分发（详见 docs/templates.md）
nyra script check <文件> [--language python|javascript|lua|php]   判定一个脚本纯不纯（白名单静态分析）：纯返回 0，不纯返回 1
nyra script preauth <list|grant|revoke> --workflow <名字>   脚本摘要预授权：激活时自动钉纯脚本摘要，内容一改授权失效；只在例行里有效（详见 docs/script-purity.md）
nyra handover contract <create|list|show|check|resolve|close>   交接契约的程序化验收（Pi Bot 借鉴第 2 条）：交付物 + 验收项 + 修正轮次上限；验收是程序核对，不调模型，不过打回、轮次用完停下等人（详见 docs/handover-contract.md）
nyra handover checkers   列出能用的 checker（验收项只能挂这些）
nyra reconciler <scan|status|enable|disable|config|settle>   卡住步骤看门狗（Pi Bot 借鉴第 3 条）：working 任务超时无进展先标出来、再按轮次上限自动重排、超限进 blocked 只等人；自动巡查默认关（详见 docs/reconciler.md）
nyra watch <add|list|show|remove|check|enable|disable|config|run-action>   变化监测例程（缺口 32）：盯页面或文件，变了才汇报（变了什么 → 详情 → 来源）；带动作的另声明条件与动作，下载类敏感动作须人批；自动巡查默认关（详见 docs/watch.md）
nyra restore [检查点] [--mode both|files|session]   从影子快照恢复文件与会话（不带参数列出检查点，详见 docs/shadow-snapshots.md）
nyra redlines [--json]         上线红线自检：证据/权限/沙箱/成本/钩子（--json 给 CI 按 code 判定）
nyra verdict [任务] [--json]     一条结论：这次跑得值不值（红线+省钱+回忆+历史）
nyra verdict --run <ID>          单次运行打分；--recent N 看趋势（该修什么）
nyra guard [--strict]           门禁形态：red 时退出码 2（--strict 下 yellow 也拦）
nyra savings [任务] [--json]    省钱机制汇总 + 辅助模型实测节省 + 逐模型明细
nyra recall "任务" [--cross-dir]  查这个任务有哪些历史可复用（不必从零探索）
nyra features                   功能开关列表（CLI > config > 默认）
nyra tools                      工具集体检：每轮 schema 成本与裁剪建议
nyra config export|import|explain  设置导出/导入/解释（默认剔除密钥）
nyra vault <...>                凭据保险箱（加密存储，权限 0600）
nyra gmail <status|auth|search|read|send|drafts|send-draft|labels|label|mark-read|mark-unread|trash|attachment|revoke>   Gmail 原生连接器：读信 / 回复 / 代发草稿 / 草稿列表与发送草稿 / 附件 / 标签 / 已读 / 回收站
nyra shopify <auth|status|products|product|orders|order|fulfill|inventory>   Shopify 原生连接器（只读）：查商品 / 订单 / 订单履约核查 / 库存（详见 docs/connectors.md）
nyra slack <auth|status|channels|history|send|card|callback>   Slack 原生连接器：读频道 / 消息、发消息（须显式批准）、发审批卡、按钮回调回写审批桥（详见 docs/connectors.md）
nyra connector <status|list|approve|revoke|auth|install|uninstall|usage|flows|flow|bundle>   连接器目录：安装 / 一键授权 / 撤销 / 用量 / 业务流程 / 导出连接器包（详见 docs/connectors.md）
nyra mcp server <status|enable|disable|allow-writes-on|allow-writes-off>   对外 MCP 服务开关：别的 agent 经网关 POST /mcp 调记忆与任务（默认关闭，详见 docs/mcp.md）
nyra peer <status|enable|disable|list|auth|ask|handoff|card|code|add|request|accept|friends|block|circle|share|grant|proposal|branch|discover|token>   对端协作：问别的 Nyra 实例、交接运行上下文、名片加好友、带 scope 可吊销的 grant、对方写操作提议、外来分支合入、公开发现与 per-peer token、名片 JWS 签名（默认关闭，详见 docs/peer.md 与 docs/peer-discovery.md）
nyra circle <create|list|show|invite|revoke|delete|bind|unbind|owner|check|bindings>   信任圈：谁能给 agent 发任务（默认全封闭，圈外消息网关直接丢弃，详见 docs/circles.md）
nyra org <create|list|show|add|remove|role|delete|check|share|shared|grant-write|learnings|workspace|file-read|cross-access|catalog|tasks|task-add|violations|isolation|memory>   组织与团队 workspace：组织/成员/角色 admin/member/viewer，机主是超级管理员；第二批：共享 Bot 默认只读、租户隔离、组织内私有目录（详见 docs/orgs.md）
nyra session <create|list|show|join|join-request|join-approve|join-decline|join-list|leave|delegate|accept|complete|share|frame|record|end>   跨 agent 联合会话：多人多 agent 视频会（本地扇出模型），会内委派 + 共享任务产物（allowlist），画面默认不留存、录制须全体同意；好友进会要批、默认只读（详见 docs/sessions.md）
nyra sfu <create|rooms|status|join|leave|turn|record|close|reclaim|video>   群组语音 SFU（本地实现，选型 mediasoup）：语音房 + 成员 + TURN 凭据 + 录制全体同意门；video 是群组视频（Producer/Consumer、按需看帧、带宽自适应、10 分钟模拟；真媒体面等 mediasoup 接线，详见 docs/sfu.md 与 docs/group-video.md）
nyra meeting <create|list|join|reconnect|transcript|minutes|record|dispatch>   进外部会议：Meet/Zoom 受控浏览器进会、听字幕出纪要；进会、录制、发言都要机主批（详见 docs/meeting.md）
nyra rendezvous <register|nodes|route|status|remove|epoch>   Rendezvous 多节点路由：HRW 一致性哈希把任务 key 路由到节点（本机/局域网节点，详见 docs/mesh.md）
nyra queue <enqueue|list|show|claim|complete|fail>   队列驱动底座：幂等键入队、节点认领 + 租约、纪元防旧指令重执行（详见 docs/mesh.md）
nyra group <room|chat|plan>   群聊：房间与机器人、swarm 顺序发言（可组合终止条件）、群组计划引擎（步骤 worktree 隔离 + 独立验收，详见 docs/group-chat.md 与 docs/group-plan.md）
nyra call <ledger|show <通话 id>|summary>   通话成本与隐私仪表：每通电话三本账（传输 / 媒体 / token），录制默认关、须全体同意，纪要进证据链（详见 docs/call-ledger.md）
nyra budget <list|show|reserve|settle|release|strict>   并发预算预留：模型调用前先预留额度、超上限不发请求；金额未知默认暂停等人工处理（详见 docs/budget.md）
nyra agui <register|list|show|link|connect|disconnect|send|exec|accept-write|revoke-write|a2a|serve>   协议中立接入：接任意 AG-UI endpoint 当 Bot（只读先行，写操作须机主显式接受），A2A 复用名片 + 交接；serve 把 Nyra 对外暴露成 AG-UI endpoint（详见 docs/agui.md）
nyra screen <watch|activity|status|takeover|handover> <电脑 id>   缺口 50：只读看屏（实时画面 + 活动列表，帧指纹不记帧内容）与接管（take the wheel，须确认；接管期间 Bot 暂停、交还后从挂起点继续，全程记审计）；画面里密码/验证码/卡号自动打码（详见 docs/bot-screen.md）
nyra voice <status|speak <文字>|enable-tts|disable-tts>   语音指挥：看配置与可用性、读一段文字、开关自动回读（详见 docs/voice.md）
nyra voice call <start|answer|decline|end|status|list|segment|confirm>   实时语音通话：建通话、喂音频段落转写、可选回读（本地 whisper 优先，云端默认关；详见 docs/voice.md）
nyra video <call|signal|ice>   视频通话 + 按需视觉采样：信令 + TURN + ICE 直连传输，帧按需看（本地优先，云端默认关；详见 docs/video-call.md）
nyra export --format docx|xlsx|pptx --from <内容 JSON> --out <路径>   成品导出：结构化内容写成可编辑的真办公文件（详见 docs/office.md）
nyra media <status|enable|disable|ingest <链接> [--out <路径>]|setup|scope ...>   媒体抓取：公开视频先取字幕、没有再本地转写（默认关，须先 nyra media enable；详见 docs/media-ingest.md）
nyra stats [--heatmap] [--json]  本月用量与每日用量热力图（--json 给机器）
nyra telemetry [status|spans|metrics|export|enable|disable|otlp]   可观测性：trace（span 落盘 + OTLP 导出）+ metrics（计数器与直方图）+ 运行事件 trace 关联（详见 docs/telemetry.md）
nyra acp <serve|status|grant|revoke-grant>   ACP 服务端：编辑器经 stdio 用 JSON-RPC 驱动 Nyra（只读先行，写操作进 peer 提议门，须机主逐条批）（详见 docs/acp.md）
nyra a2a <serve|card>   A2A 服务端：别的 agent 经 HTTP 用 JSON-RPC 2.0 调用 Nyra（只读先行，写操作进 peer 提议门，须机主逐条批）（详见 docs/a2a.md）
nyra cost --show [--json]      定价、单次上限与月度上限（本月已花）
nyra --plan "任务"             只读分析，生成工作目录中的 plan.md，不执行
nyra --execute-plan --approve-plan <SHA256>   执行经校验值批准的 plan.md
nyra --verify "<命令>"         任务完成后运行验证命令（退出码 0 才算验证通过）
nyra --json "任务"             单次非交互任务，输出 JSON Lines
nyra schedule <list|add|remove|run|daemon>   管理定时任务
nyra task <add|list|show|cancel|worker|approve>   管理后台任务队列
nyra review <list|show|approve|reject|apply|verify|enqueue>   审阅队列：并行线程与定时任务结果逐项批（详见 docs/review-queue.md）
nyra hitl <start|takeover|handback|cancel|status|list>   对话转人工坐席：会话转给真人、真人接手、再接回 bot；转人工期间 bot 不自动回（详见 docs/hitl.md）
nyra events <list|add|remove|enable|disable|test|poll>   事件触发任务：webhook 与新邮件触发进任务队列（详见 docs/event-triggers.md）
nyra mail-inbox <status|enable|disable|allowlist|set|poll>   邮件即任务入口：白名单发件人的邮件直接进任务队列，跑完回信（详见 docs/mail-inbox.md）
nyra responsibility <list|add|set|remove|enable|disable|check|pause|resume|complete|cancel|brief|show>   持续责任语义：责任对象（归属人 + 验收标准 + 升级条件 + 过期时间）与晨间简报，无事安静（详见 docs/responsibilities.md）
nyra bot telegram <start|stop|status>   Bot 方向 Phase 1：Telegram 渠道（长轮询收消息、会话串行、去重配额、确定性指令；外部用户强制只读，详见 docs/bot.md）
nyra bot discord <start|stop|status>   Bot 渠道：Discord（Gateway 收消息 + REST 发消息，详见 docs/bot.md）
nyra bot slack <start|stop|status>   Bot 渠道：Slack（Socket Mode 收事件 + Web API 发消息，需 app token + bot token，详见 docs/bot.md）
nyra bot whatsapp <start|stop|status>   Bot 渠道：WhatsApp（Cloud API 发消息 + webhook 收消息，需 access token + 号码 id + 公网入口，详见 docs/bot.md）
nyra bot computer <create|list|status|sleep|wake|remove|credential|shell|sleep-due>   Bot 缺口 42：每 Bot 一台持久电脑（持久 workspace + 浏览器 profile + 凭证 Vault + 隔离分级，详见 docs/bot-computer.md）
nyra bot status   Bot 总览：Telegram/Discord/Slack/WhatsApp 运行态 + 电脑数量与资源
nyra channels <start|stop|status|health|bindings|explain>   缺口 27：常驻多渠道网关（四渠道一个进程、bindings 确定性路由、渠道会话默认进沙箱、每条入站路由进证据链，详见 docs/channels.md）
nyra bot redlines <status|list|show|tighten|loosen|set>   Bot 缺口 51：业务动作硬红线表——发消息/付款/删除永远须人批，转钱/交易证券永远禁做（详见 docs/business-redlines.md）
nyra reviewer <status|enable|disable|set-model|add-rule|remove-rule|list-rules|check>   独立审查层：敏感工具调用先过独立审查 agent（便宜模型、独立上下文），审查失败即拦截（详见 docs/reviewer.md）
nyra judge <status|enable|disable|set-model|set-thresholds|check|verdicts>   意向验证 judge：敏感工具调用先打风险分（0-100 + 引用证据），高分拒绝、中段转人工；verdicts 查两层验证结论账本（启发式 + judge，详见 docs/tool-judge.md）
nyra verifier <status|enable|disable|set-model|rework-on|rework-off|add-rule|remove-rule|list-rules|check>   验收者：并行产出合入前先过验收门（确定性检查 + 便宜模型复核），未通过打回重做（详见 docs/verifier.md）
nyra skills <status|enable|disable|draft|drafts|show|approve|reject|archive|sweep>   技能自沉淀：成功任务自动起草技能草稿，人工批准后才安装，低质自动归档（详见 docs/skill-sedimentation.md）
nyra bughunt <install|status|scope|template|check>   授权漏洞挖掘技能包：范围卡 + 证伪验证 + 提交前七问 + 证据卫生，提交前核对（详见 docs/bughunt.md）
nyra market <list|show|source|install|uninstall|installed|publish|template>   内置机器人市场：浏览、安装、发布技能包、机器人配置与业务流程模板（第一阶段：静态策展仓库 + 本地客户端，详见 docs/marketplace.md）
nyra account <status|login|logout|list|revoke|link|suspend|reactivate>   用户账号登录：Google / GitHub / 邮箱 / SSO，账号身份 + 会话（详见 docs/accounts.md）
nyra cloud <status|connect|disconnect|sync|push|pull|pref|devices|set-url>   手机云端连接：账号登录后直连云端服务、跨端同步，不走局域网（详见 docs/mobile-cloud.md）
nyra sso <provider|login|status|scim>   企业 SSO：OIDC 身份提供方注册与登录、SCIM 账号开通（详见 docs/sso.md）
nyra kb <create|list|add|search|ask|remove|test>  本地知识库：外部文档（文本/Markdown/PDF/网页）收录、分块、BM25 检索 + 检索测试台（详见 docs/knowledge.md）
nyra search <关键词> [--scope project|all] [--session <会话 id>] [--after <日期>] [--before <日期>] [--limit <n>] [--export <路径>] [--json]  会话全文搜索：搜自己过去的对话，按会话分组回命中消息与上文下文；不给关键词列出最近会话，--export 把会话全文导出为 Markdown（详见 docs/session-search.md）
nyra editor <serve|status|snapshot|ask|preview|apply|hosts>  编辑器插件：编辑器桥服务（VS Code / JetBrains / Zed 共用同一协议），快照带光标选区与诊断进模型上下文，diff 预览不动磁盘、应用须显式确认（详见 docs/editor-plugins.md）
nyra knowledge test <库名> --file <问题文件> [--top-k N] [--min-score X] [--json]  检索测试台：批量典型问题看召回片段与分数，调参对比（详见 docs/knowledge.md）
nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  插件市场（最小版：技能包，只装带来源、可审计的插件）
nyra hooks list                列出已安装的钩子（~/.nyra/hooks/<事件>.d/ 下的脚本，详见 docs/hooks.md）
nyra status                    诊断清单：损坏的配置、不可用沙箱、被忽略的权限设置、永不匹配的 hook matcher（只读，详见 docs/status.md）
nyra creator "<一句话需求>" [--yes]   创造模式：一句话搓出插件（先验证、经确认才安装）
nyra memory <export|export-prompt|import|local|import-zip|search|forget|remember|entries|entry|update|rejections|recall|extract|review>  记忆交换与检索/删除；remember/entries/entry/update/rejections 走记忆证据门（写记忆须附用户原话依据，详见 docs/memory.md）；remember/entries 支持 --org 组织记忆；recall 是主动记忆开关与试跑（默认关，详见 docs/memory.md）；extract/review 是对话里自动提炼候选记忆、进库前人工确认（详见 docs/memory.md）
nyra soul <show|status|list|init|add|remove|enable|disable|edit|export|import>  Soul 身份层：每 agent 的身份与 Tenets（不变量进规则层、代码拦截；Charter 角色契约见 nyra soul charter <set|show|clear>，详见 docs/soul.md 与 docs/team.md）
nyra style <learn|show|list|delete|export|import>  分应用文风学习（详见 docs/style.md）
nyra doctor [--provider 名字]  中文自检：运行时、配置文件、配置目录、Key、网络、磁盘、写权限、密码箱权限
nyra models [list|show <模型名>|refresh|fallback|handoff|preset|health]   查模型上下文窗口、刷新模型数据、看备用链与本月切换统计、查限流接力摘要、设降级预设与看故障账本（见 docs/model-catalog.md）
nyra setup                     首次启动向导
nyra init [--name 名字] [--role researcher|assistant|shopkeeper|custom] [--work 干什么活] [--persona 风格] [--redline 红线] [--agent default] [--yes] [--force]   对话式入职：三个问题（叫什么、干什么活、什么风格/红线）→ 生成 Soul + 按角色预装技能包 + 配置清单确认后生效，确认后发就绪简报（详见 docs/onboarding.md）
nyra templates <list|show <角色>|apply <角色>|export <角色> <文件>|import <文件>>   一键角色模板：研究员 / 助理 / 店小二（Soul + 技能包 + 权限规则的打包文件，可导出成本地文件分享；导入先验后装；与 nyra template 业务流程模板不同，详见 docs/onboarding.md）
nyra wake                      唤醒：重发一次就绪简报（我是谁、我会什么、我的红线、本次 0 token），走终端 + 机主收件箱
nyra --example [文件]          本地示例任务（不调模型、不花钱）
nyra ui                        网页界面（本地网页，含模式切换与创造模式）
nyra permissions ...           Poppy 站点授权意向（本地账本，只记录不授权）
nyra eigenflux ...             EigenFlux 接入检测与本地网络限制（第 4 阶段已原生化）

模型兜底默认关闭（只用户开启、只切允许列表内服务商）。
界面语言：--lang zh|en（或 NYRA_LANG、config.json 的 language、系统语言；REPL 里 /lang 切换）。`;

export const USAGE_EN = `Nyra ${VERSION} (Node runtime)

Usage:
nyra "task" [--provider name] [--mode readonly|auto|full|creator]   run one task
nyra "task" --image <image path> [--image ...] [--video <video path or URL>]   run with images/video (PNG/JPEG/WebP/GIF; video is sampled into frames; model must support vision, see docs/vision.md)
nyra --voice <audio path> ["task"]   voice command: transcribe first, then run it as the task (wav/mp3/m4a/ogg/flac; local whisper.cpp first, cloud STT fallback, see docs/voice.md)
nyra "task" --speak   read the result aloud after the run (off by default; only the first 500 chars)
nyra voice <status|speak <text>|enable-tts|disable-tts>   voice: show config and availability, speak a text, toggle auto readback (see docs/voice.md)
nyra voice call <start|answer|decline|end|status|list|segment|confirm>   live voice call: start a call, feed audio segments to transcribe, optional readback (local whisper.cpp first, cloud off by default; see docs/voice.md)
nyra video <call|signal|ice>   video call + on-demand frame sampling: signaling + TURN + ICE direct transport, frames seen on demand (local first, cloud off by default; see docs/video-call.md)
--max-cost <USD> --monthly-max-cost <USD>   per-run / monthly spend caps (hard stop when exceeded; monthly cap unset by default)
nyra                                                        interactive mode (REPL)
nyra --help                    show help (no key, no network)
nyra --version                 show version
nyra --lang zh|en              UI language (also NYRA_LANG, config "language", system locale; /lang in the REPL)
nyra --list-providers          list providers (built-in presets + custom)
nyra --list-models [--provider name]   list known models for a provider
nyra --list-profiles           list configured provider profiles
nyra --list-skills             list loaded skills
nyra --list-sessions           list past sessions
nyra --list-mcp                list configured MCP servers and presets
nyra ui [--host 127.0.0.1] [--port 8765] [--pair] [--open]   start the gateway web UI
nyra ui --print-url-json --exit-on-stdin-close   desktop shell mode: one JSON line on stdout, exits when stdin closes
nyra gw <sessions|send|view|approve|rewind|info|schedule>   talk to a running gateway as a client
nyra --compact <session id>    compact a session and exit
REPL: /context shows context usage; /compact focus <keyword> compacts around a topic (see docs/context.md)
nyra --resume <session id>     continue a session
nyra --resume-run <run id>     resume a run from its record
nyra evidence verify <run id>  independently re-check a run's evidence chain (see docs/evidence.md)
nyra timeline <run id> [--verbose] [--json] [--out <path>]   rebuild one multi-agent run as a timeline (read-only replay, no re-execution, see docs/timeline.md)
nyra replay <run id> [--verbose]   replay one run step by step, grouped by turn (read-only, no re-execution)
nyra regression <list|precipitate --run <run id>|remove <case id>|status <case id> <open|verified|retired>>   regression case library: precipitate failed steps of a run into cases (metadata only, no model calls, no auto re-run, see docs/regression.md)
nyra contract <create|list|show|activate|attach|verify|mark-item|remove|stats>   delivery contract (gap 29): set acceptance criteria at intake (deliverables + checklist), score item by item after the run; accepted only when all pass (see docs/delivery-contract.md)
nyra golden <add|list|show|remove|run|rescore>   Golden test set (G-2): fixed inputs + expected outputs + expected tool trajectories, scored on result and trajectory (see docs/delivery-contract.md)
nyra "<task>" --contract <contract id>   attach an activated delivery contract to this run; item scores go into the run report
nyra kanban <create|list|show|start|fail|review|decide|verify|done|reset|remove|tick|sweep>   durable task board: tasks are ledger rows, crash-safe, circuit-breaker to blocked, completion needs verification evidence (see docs/kanban.md)
nyra goal <create|list|show|add-item|start-item|verify-item|complete|pause|resume|cancel|instruct|link|split>   long goal object: goal statement + live checklist + per-item verification, all must pass before completion; mid-course instructions don't lose the goal, pause/resume/cancel supported (see docs/goal-object.md)
nyra subagent <list|show|register|heartbeat|sweep|resume|suspend|stop|confirm-stopped|cancel-stop|steer>   crash resume: persistent sub-agent rows + heartbeat checkpoints + boot sweep + verify-before-resume + per-child stop + per-child steer (see docs/kanban.md, docs/roster.md and docs/steer-schema.md)
nyra roster <list|show>   live roster: one line per sub-agent — status + elapsed + current action (read-only snapshot, no tokens spent; token/cost hidden by default, see docs/roster.md)
nyra side-effects <list|show|record|mark|recover>   store-before-do side-effect queue: recorded before execution, recovered oldest-first with a recovery note (see docs/kanban.md)
nyra heartbeat <add|list|remove|enable|disable|run|wake|check-script|seen-clear|commitments>   silent patrol: quiet when nothing is wrong, findings go to evidence first then inbox; repeat anomalies are fingerprinted and notified once; local script pre-checks (zero-token) and supervisor wake are off by default; inferred commitments need one user confirmation and auto-expire (see docs/heartbeat.md)
nyra fanout <list|show|recover>   background fan-out: top-level delegation returns a handle immediately, results backfill the inbox as one message; half-run fan-outs need recover after the process exits (see docs/merge-fanout.md)
nyra team <create|list|show|add|remove|dissolve|dispatch|handover|lead|writer>   team mode (new gap 52): the chief is the single entry point — splits, dispatches and summarizes only; members need a complete Charter to take work; handovers go through inbox/outbox/change log; outbound actions always go back to the chief / a human for approval; lead lease + epoch guards against stale chief instructions (see docs/team.md)
nyra governance <policy|mandate|mode|dry-runs>   enterprise governance: versioned policy + immutable mandates + observe/auto intake modes + dry-run ledger (see docs/governance.md)
nyra governance caps <set|list|show|check|assign-team|pause|resume|discard|pauses>   tiered cost caps: monthly USD/token limits per Bot/role/team/persona, over-cap tasks pause recoverably
nyra governance audit <export|verify>   audit export: governance audit logs to SIEM (JSONL + hash chain, verifiable)
nyra optimize <propose|list|show|edit|approve|reject|apply|verify|revert|loop|arms>   human-approved self-optimization loop: drafts instruction changes only, needs approval to apply, three datasets + holdout decide release; loop reads an eval report, auto-drafts and ranks by UCB (see docs/governance.md)
nyra eval <scenarios|scorecard|benchmarks|import|benchmark|remove|probes|probe|manifest>   eval as a first-class citizen: scenario scorecards + external benchmark import + in-repo probes + reproducibility manifest (mostly read-only; run evals with bun run scripts/eval.ts; see docs/eval.md)
nyra trust <register|list|show|evidence|promote|demote|review|check>   trust ladder (GROK-6, gap 43 governance): new agents / skills start read-only, earn one level per N consecutive successes with zero violations; each recorded success may be randomly spot-checked and only counts after review; demotion any time (see docs/trust-ladder.md)
nyra workflow <import|list|show|run|dry-run|resume|trial|activate|remove|verify|triggers>   declarative reusable workflows (gap 25): YAML/JSON definitions + three execution modes (fixed graph / coordinator / dynamic) + approval nodes + dry-run; activation needs a real-data trial run + human confirmation; trigger execution is off by default and needs an explicit opt-in (see docs/workflow.md)
nyra template <list|show|builtin|import|trial|activate|run|dry-run|remove|publish|install>   business process template library (gap 46): workflow DSL + connectors + acceptance criteria + trial data, distributed through the robot market; activation needs a real-data trial run + human confirmation (see docs/templates.md)
nyra script check <file> [--language python|javascript|lua|php]   judge whether a script is pure (allowlist static analysis): exit 0 if pure, 1 if not
nyra script preauth <list|grant|revoke> --workflow <name>   script digest pre-authorization: pure script digests are pinned at activation, a changed script voids the grant; routine-only (see docs/script-purity.md)
nyra handover contract <create|list|show|check|resolve|close>   programmatic acceptance of handover contracts (Pi Bot idea 2): deliverables + checks + a fix-round cap; acceptance is a deterministic program check, not a model call — a failed check sends the work back, out of rounds stops for a human (see docs/handover-contract.md)
nyra handover checkers   list the checkers an acceptance item may use
nyra reconciler <scan|status|enable|disable|config|settle>   stuck-step watchdog (Pi Bot idea 3): a working task idle past the threshold is flagged, then auto-requeued up to a cap, then blocked for a human; automatic patrol is off by default (see docs/reconciler.md)
nyra watch <add|list|show|remove|check|enable|disable|config|run-action>   change-watch routine (gap 32): watch a page or a file, report only when it changes (what changed, details, source); actions need a separate condition and action, downloads need a human yes; automatic patrol is off by default (see docs/watch.md)
nyra restore [checkpoint] [--mode both|files|session]   restore files and session from a shadow snapshot (no argument lists checkpoints, see docs/shadow-snapshots.md)
nyra redlines [--json]         production redlines: evidence/permissions/sandbox/cost/hooks (--json for CI)
nyra verdict [task] [--json]   one conclusion: is this run worth it
nyra verdict --run <id>        score one run; --recent N: trend over the last N runs
nyra guard [--strict]          gate: exit 2 when verdict is red (yellow too with --strict)
nyra savings [task] [--json]   what is saving tokens + measured aux-model savings
nyra recall "task" [--cross-dir]   which past runs are reusable for this task
nyra features                  feature switches (CLI > config > default)
nyra tools                     tool-pool health: per-turn schema cost and trim advice
nyra config export|import|explain  settings export/import/explain (secrets stripped)
nyra vault <...>               credential vault (encrypted at rest, mode 0600)
nyra gmail <status|auth|search|read|send|drafts|send-draft|labels|label|mark-read|mark-unread|trash|attachment|revoke>   native Gmail connector: read / reply / draft / list and send drafts / attachments / labels / read-state / trash
nyra shopify <auth|status|products|product|orders|order|fulfill|inventory>   native Shopify connector (read-only): products / orders / order fulfillment check / inventory (see docs/connectors.md)
nyra slack <auth|status|channels|history|send|card|callback>   native Slack connector: read channels / messages, send messages (explicit approval required), post approval cards, button callbacks resolve approvals (see docs/connectors.md)
nyra connector <status|list|approve|revoke|auth|install|uninstall|usage|flows|flow|bundle>   connector directory: install / one-click auth / revoke / usage / business flows / export connector bundle (see docs/connectors.md)
nyra mcp server <status|enable|disable|allow-writes-on|allow-writes-off>   external MCP server switch: other agents call Nyra memory and tasks via gateway POST /mcp (off by default, see docs/mcp.md)
nyra peer <status|enable|disable|list|auth|ask|handoff|card|code|add|request|accept|friends|block|circle|share|grant|proposal|branch|discover|token>   peer collaboration: ask another Nyra instance, hand off run context, agent card and friends, scoped revocable grants, peer write proposals, foreign branch merges, public discovery with per-peer tokens, agent card JWS signatures (off by default, see docs/peer.md and docs/peer-discovery.md)
nyra circle <create|list|show|invite|revoke|delete|bind|unbind|owner|check|bindings>   trust circles: who may send tasks to the agent (closed by default, out-of-circle messages are dropped at the gateway, see docs/circles.md)
nyra org <create|list|show|add|remove|role|delete|check|share|shared|grant-write|learnings|workspace|file-read|cross-access|catalog|tasks|task-add|violations|isolation|memory>   orgs and team workspaces: orgs / members / roles admin/member/viewer, the owner is super-admin; batch 2: shared Bots read-only by default, tenant isolation, org-private catalog (see docs/orgs.md)
nyra session <create|list|show|join|join-request|join-approve|join-decline|join-list|leave|delegate|accept|complete|share|frame|record|end>   cross-agent joint sessions: multi-person multi-agent video meetings (local fanout model), in-session delegation + shared task products (allowlist), frames not retained by default, recording needs everyone's consent; friends join only after approval, read-only by default (see docs/sessions.md)
nyra sfu <create|rooms|status|join|leave|turn|record|close|reclaim|video>   group voice SFU (local implementation, mediasoup selected): voice rooms + members + TURN credentials + all-consent recording gate; video is group video (Producer/Consumer, watch-on-demand, adaptive bandwidth, 10-minute simulation; real media plane waits for mediasoup wiring, see docs/sfu.md and docs/group-video.md)
nyra meeting <create|list|join|reconnect|transcript|minutes|record|dispatch>   join external meetings: controlled-browser join for Meet/Zoom, listen to captions and build minutes; joining, recording and speaking all need the owner's approval (see docs/meeting.md)
nyra rendezvous <register|nodes|route|status|remove|epoch>   Rendezvous multi-node routing: HRW consistent hashing routes a task key to a node (local/LAN nodes only, see docs/mesh.md)
nyra queue <enqueue|list|show|claim|complete|fail>   queue-driven base: idempotent enqueue, node claim + lease, epoch guard against stale re-execution (see docs/mesh.md)
nyra group <room|chat|plan>   group chat: rooms and bots, swarm turn-taking (composable stop conditions), group plan engine (per-step worktree isolation + independent acceptance, see docs/group-chat.md and docs/group-plan.md)
nyra call <ledger|show <call id>|summary>   call cost and privacy dashboard: three books per call (transport / media / tokens), recording off by default and needs everyone's consent, minutes go into the evidence chain (see docs/call-ledger.md)
nyra budget <list|show|reserve|settle|release|strict>   concurrent budget reservation: reserve budget before a model call, over-limit calls are not sent; unknown amounts pause by default until a human handles them (see docs/budget.md)
nyra agui <register|list|show|link|connect|disconnect|send|exec|accept-write|revoke-write|a2a|serve>   protocol-neutral access: attach any AG-UI endpoint as a Bot (read-only first, writes need the owner's explicit acceptance), A2A reuses peer cards + handoff; serve exposes Nyra as an AG-UI endpoint (see docs/agui.md)
nyra screen <watch|activity|status|takeover|handover> <computer id>   gap 50: read-only screen watch (live frame + activity list, frame fingerprint without frame content) and takeover (take the wheel, needs confirmation; the Bot pauses during takeover and resumes from where it stopped, fully audited); passwords / verification codes / card numbers are masked automatically (see docs/bot-screen.md)
nyra voice <status|speak <text>|enable-tts|disable-tts>   voice commands: show config and availability, speak a text, toggle auto readback (see docs/voice.md)
nyra voice call <start|answer|decline|end|status|list|segment|confirm>   live voice call: start a call, feed audio segments to transcribe, optional readback (local whisper.cpp first, cloud off by default; see docs/voice.md)
nyra video <call|signal|ice>   video call + on-demand frame sampling: signaling + TURN + ICE direct transport, frames seen on demand (local first, cloud off by default; see docs/video-call.md)
nyra export --format docx|xlsx|pptx --from <content JSON> --out <path>   export a finished office file from structured content (see docs/office.md)
nyra media <status|enable|disable|ingest <url> [--out <path>]|setup|scope ...>   media ingest: public videos, subtitles first, local transcription fallback (off by default, run nyra media enable first; see docs/media-ingest.md)
nyra stats [--heatmap]         this month's usage and the daily usage heatmap (see docs/cost.md)
nyra telemetry [status|spans|metrics|export|enable|disable|otlp]   observability: traces (spans on disk + OTLP export) + metrics (counters and histograms) + run-event trace correlation (see docs/telemetry.md)
nyra acp <serve|status|grant|revoke-grant>   ACP server: editors drive Nyra over stdio JSON-RPC (read-only first, writes go to the peer proposal gate for owner approval) (see docs/acp.md)
nyra a2a <serve|card>   A2A server: other agents call Nyra over HTTP JSON-RPC 2.0 (read-only first, writes go to the peer proposal gate for owner approval) (see docs/a2a.md)
nyra cost --show               pricing, per-run cap and monthly cap (spent this month)
nyra verdict [task]            one conclusion: is this run worth it (redlines + savings + recall + history)
nyra verdict --run <id>         score one run; --recent N: trend over the last N runs; --json: machine-readable
nyra guard [--strict]          gate: exit 2 when verdict is red (yellow too with --strict)
nyra --plan "task"             read-only analysis; writes plan.md in the workdir, runs nothing
nyra --execute-plan --approve-plan <SHA256>   run a plan.md approved by its checksum
nyra --verify "<command>"      run a verify command after the task (exit code 0 = verified)
nyra --json "task"             one non-interactive task, JSON Lines output
nyra schedule <list|add|remove|run|daemon>   manage scheduled tasks
nyra task <add|list|show|cancel|worker|approve>   manage the background task queue
nyra review <list|show|approve|reject|apply|verify|enqueue>   review queue: approve parallel threads and scheduled-task results one by one (see docs/review-queue.md)
nyra hitl <start|takeover|handback|cancel|status|list>   human handoff: hand a conversation to a human, take over, hand back to the bot; the bot stays silent while handed off (see docs/hitl.md)
nyra events <list|add|remove|enable|disable|test|poll>   event-triggered tasks: webhooks and new mail enqueue tasks (see docs/event-triggers.md)
nyra mail-inbox <status|enable|disable|allowlist|set|poll>   mail as task entry: allowlisted senders' mail enqueues tasks, results mailed back (see docs/mail-inbox.md)
nyra responsibility <list|add|set|remove|enable|disable|check|pause|resume|complete|cancel|brief|show>   standing responsibilities: responsibility objects (owner + acceptance criteria + escalation conditions + expiry) and the morning briefing, quiet when nothing is wrong (see docs/responsibilities.md)
nyra bot telegram <start|stop|status>   bot direction phase 1: Telegram channel (long polling, per-session serial queue, dedup + quotas, deterministic commands; external users forced read-only, see docs/bot.md)
nyra bot discord <start|stop|status>   bot channel: Discord (Gateway receive + REST send, see docs/bot.md)
nyra bot slack <start|stop|status>   bot channel: Slack (Socket Mode receive + Web API send, needs app token + bot token, see docs/bot.md)
nyra bot whatsapp <start|stop|status>   bot channel: WhatsApp (Cloud API send + webhook receive, needs access token + phone number id + public entry, see docs/bot.md)
nyra bot computer <create|list|status|sleep|wake|remove|credential|shell|sleep-due>   bot gap 42: one persistent computer per Bot (persistent workspace + browser profile + credential vault + isolation tiers, see docs/bot-computer.md)
nyra bot status   bot overview: Telegram/Discord/Slack/WhatsApp state + computer count and resources
nyra channels <start|stop|status|health|bindings|explain>   gap 27: persistent multi-channel gateway (four channels in one process, bindings-based deterministic routing, channel sessions sandboxed by default, every inbound route in the evidence chain, see docs/channels.md)
nyra bot redlines <status|list|show|tighten|loosen|set>   bot gap 51: business-action hard redlines — sending messages / payments / deletions always need approval, moving money / trading securities are always forbidden (see docs/business-redlines.md)
nyra reviewer <status|enable|disable|set-model|add-rule|remove-rule|list-rules|check>   independent review layer: sensitive tool calls go through an independent reviewer agent first (cheap model, independent context); review failure blocks (see docs/reviewer.md)
nyra judge <status|enable|disable|set-model|set-thresholds|check|verdicts>   intent-validation judge: sensitive tool calls get a risk score first (0-100 plus cited evidence); high scores are refused, middle scores go to a human; verdicts lists the two-layer verdict ledger (heuristic + judge, see docs/tool-judge.md)
nyra verifier <status|enable|disable|set-model|rework-on|rework-off|add-rule|remove-rule|list-rules|check>   verifier: parallel output passes an acceptance gate before merging (deterministic checks + cheap-model review); failures are sent back for rework (see docs/verifier.md)
nyra skills <status|enable|disable|draft|drafts|show|approve|reject|archive|sweep>   skill sedimentation: successful runs auto-draft skill drafts, installed only after your approval, low-quality ones auto-archived (see docs/skill-sedimentation.md)
nyra bughunt <install|status|scope|template|check>   authorized bug-hunting skill pack: scope card + falsification + pre-submit seven questions + evidence hygiene, pre-submit gate (see docs/bughunt.md)
nyra market <list|show|source|install|uninstall|installed|publish|template>   built-in bot marketplace: browse, install and publish skill packs, bot configs and business process templates (phase 1: static curated repo + local client, see docs/marketplace.md)
nyra account <status|login|logout|list|revoke|link|suspend|reactivate>   user account login: Google / GitHub / email / SSO, account identity + sessions (see docs/accounts.md)
nyra cloud <status|connect|disconnect|sync|push|pull|pref|devices|set-url>   mobile cloud link: after account login, connect straight to the cloud service and sync across devices, no local network needed (see docs/mobile-cloud.md)
nyra sso <provider|login|status|scim>   enterprise SSO: OIDC identity provider registration and login, SCIM provisioning (see docs/sso.md)
nyra kb <create|list|add|search|ask|remove|test>  local knowledge base: ingest external docs (text/Markdown/PDF/web pages), chunk, BM25 search + retrieval test bench (see docs/knowledge.md)
nyra search <keywords> [--scope project|all] [--session <session id>] [--after <date>] [--before <date>] [--limit <n>] [--export <path>] [--json]  session full-text search: search your past conversations, grouped by session with matching messages and context; without keywords lists recent sessions, --export dumps a session to Markdown (see docs/session-search.md)
nyra editor <serve|status|snapshot|ask|preview|apply|hosts>  editor plugins: editor bridge service (VS Code / JetBrains / Zed share one protocol), snapshots carry cursor, selection and diagnostics into model context, diff previews never touch disk, applying needs explicit confirmation (see docs/editor-plugins.md)
nyra knowledge test <base> --file <questions file> [--top-k N] [--min-score X] [--json]  retrieval test bench: run a batch of typical questions, see recalled snippets and scores, compare params (see docs/knowledge.md)
nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  plugin market (skill packs with source, auditable)
nyra hooks list                list installed hooks (~/.nyra/hooks/<event>.d/, see docs/hooks.md)
nyra status                    diagnose broken configs, unavailable sandbox, ignored permission rules, never-matching hook matchers (read-only, see docs/status.md)
nyra creator "<one-line idea>" [--yes]   creator mode: build a plugin from one sentence (verified, installed only after you confirm)
nyra memory <export|export-prompt|import|local|import-zip|search|forget|remember|entries|entry|update|rejections|recall|extract|review>  memory exchange, search and forget; remember/entries/entry/update/rejections go through the memory evidence gate (writes need verbatim user quotes, see docs/memory.md); remember/entries support --org org memory; recall is the active-memory switch and dry run (off by default, see docs/memory.md); extract/review auto-extracts candidate memories from a conversation and confirms them before they enter the store (see docs/memory.md)
nyra soul <show|status|list|init|add|remove|enable|disable|edit|export|import>  Soul identity layer: per-agent identity and Tenets (invariants compile into the rule layer and are enforced by code; role Charter via nyra soul charter <set|show|clear>, see docs/soul.md and docs/team.md)
nyra style <learn|show|list|delete|export|import>  per-channel writing style profiles (see docs/style.md)
nyra doctor [--provider name]  self-check: runtime, config, home dir, key, network, disk, write access, vault permissions
nyra models [list|show <model>|refresh|fallback|handoff|preset|health]   look up model context windows, refresh model data, show fallback chain and this month's switches, view rate-limit handoff summaries, set the degradation preset and view the health ledger (see docs/model-catalog.md)
nyra setup                     first-run wizard
nyra init [--name name] [--role researcher|assistant|shopkeeper|custom] [--work job] [--persona style] [--redline redline] [--agent default] [--yes] [--force]   guided onboarding: three questions (name, job, style/redlines) -> Soul + role skill pack + a reviewable checklist, applied only after you confirm; then a ready briefing (see docs/onboarding.md)
nyra templates <list|show <role>|apply <role>|export <role> <file>|import <file>>   one-click role templates: researcher / assistant / shopkeeper (Soul + skill pack + permission rules in one pack, shareable as local files; imports are validated first; different from nyra template business-process templates, see docs/onboarding.md)
nyra wake                      wake up: resend the ready briefing once (who I am, what I do, my redlines, 0 tokens this time), to the terminal + your inbox
nyra --example [file]          local example task (no model calls, no cost)
nyra permissions ...           Poppy site permission intents (local ledger; records, never grants)
nyra eigenflux ...             EigenFlux checks and local network limits

Model fallback is off by default (only when you turn it on, only to allowed providers).`;

/** 当前界面语言的 --help 文本。 */
export function usageText(): string { return getLang() === "en" ? USAGE_EN : USAGE; }

/**
* CLI 入口的语言初始化：--lang > NYRA_LANG > config.language > 系统语言 > en。
* 返回去掉 --lang 后的 argv；--lang 值非法时 error 有值。
*/
export function initLang(argv: string[], config: Record<string, unknown> | null): { argv: string[]; error?: string } {
  const flag = extractLangFlag(argv);
  if (flag.value !== undefined && flag.lang === null) {
    setLang(detectLang({ config }));
    return { argv: flag.rest, error: t("lang.badFlag", { value: flag.value }) };
  }
  setLang(detectLang({ flag: flag.lang, config }));
  return { argv: flag.rest };
}

export interface CliArgs {
  help: boolean; version: boolean;
  listProviders: boolean; listModels: boolean; listProfiles: boolean;
  listSkills: boolean; listSessions: boolean; listMcp: boolean;
  compact: string | null; resume: string | null; resumeRun: string | null;
  planMode: boolean; executePlan: boolean; approvePlan: string | null;
  verify: string | null; verifyTimeout: number | null; verifyRetries: number | null;
  /** 缺口 29：本次运行挂的交付契约 id；null = 不挂契约。 */
  contract: string | null;
  /** P2-2：本次运行的成本上限（美元）；null = 不设上限。 */
  maxCost: number | null;
  /** 缺口 29：本次运行的月度支出上限（美元）；null = 按配置（默认不设上限）。 */
  monthlyMaxCost: number | null;
  /** 本次运行禁用的工具（可重复 --disable-tool）。 */
  disableTools: string[];
  /** 功能开关的 CLI 覆盖（--enable-feature / --disable-feature，可重复）。 */
  enableFeatures: string[];
  disableFeatures: string[];
  /** --add-dir：额外可写根（可重复）。 */
  addDirs: string[];
  trustAgentsVerify: boolean;
  jsonMode: boolean; autoCompact: boolean; autoCompactThreshold: number | null;
  poppy: boolean; fallback: boolean; noFallback: boolean;
  discoverPoppy: string | null; inspectPoppyIdentity: string | null;
  provider?: string; model?: string; profile?: string;
  mode?: string; maxTurns: number | null; contextWindow: number | null;
  /** 缺口 4：本次运行的代笔渠道（--channel gmail）；null = 不注入文风画像。 */
  channel?: string | null;
  /** 缺口 16：本次运行附带的图片（--image，可重复）与视频（--video，可重复）。 */
  images: string[];
  videos: string[];
  /** 缺口 15：本次运行附带的语音（--voice，单段音频；不填 = 纯文字任务）。 */
  voice?: string | null;
  /** 缺口 15：任务跑完后把结果读出来（--speak；默认关）。 */
  speak: boolean;
  /** 第 1 批 G-P2-17：显式确认跳过审阅（--yes；只对 --voice 的先审后发生效）。 */
  yes: boolean;
  workdir: string; trust: boolean;
  sandbox?: string | null; sandboxId?: string | null; sandboxTemplate?: string | null; sandboxTimeout: number | null;
  doctor: boolean; setup: boolean; example: boolean; exampleFile?: string;
  /** 界面语言 --lang zh|en（main 入口已先取出并生效；这里只为 parseArgs 单独调用时不报未知选项）。 */
  lang?: string;
  task?: string; unknown?: string;
  subcommand?: string; subArgs?: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false, version: false,
    listProviders: false, listModels: false, listProfiles: false,
    listSkills: false, listSessions: false, listMcp: false,
    compact: null, resume: null, resumeRun: null,
    planMode: false, executePlan: false, approvePlan: null,
    verify: null, verifyTimeout: null, verifyRetries: null, contract: null, maxCost: null, monthlyMaxCost: null, disableTools: [], enableFeatures: [], disableFeatures: [], addDirs: [],
    trustAgentsVerify: false, jsonMode: false, autoCompact: false,
    autoCompactThreshold: null, poppy: false, fallback: false, noFallback: false,
    discoverPoppy: null, inspectPoppyIdentity: null,
    maxTurns: null, contextWindow: null, channel: null, images: [], videos: [],
    voice: null, speak: false, yes: false,
    workdir: ".", trust: false, sandboxTimeout: null,
    doctor: false, setup: false, example: false,
  };
  const positional: string[] = [];
  const valueFlags = new Set([
      "--provider", "--model", "--profile", "--mode", "--max-turns", "--context-window",
      "--compact", "--resume", "--resume-run", "--verify", "--verify-timeout", "--verify-retries", "--monthly-max-cost",
      "--contract",
      "--auto-compact-threshold", "--discover-poppy", "--inspect-poppy-identity",
      "--approve-plan", "--workdir", "--sandbox", "--sandbox-id", "--sandbox-template", "--sandbox-timeout",
      "--lang", "--channel", "--image", "--video", "--voice",
    ]);
  const subcommands = subcommandSet();
  // 子命令 early-return 之前先扫一遍 --provider/--model：setup/--example/doctor
  // 从 args.provider 取值，否则子命令后的 flag 永远填不进来（setup --provider nope
  // 会按配置文件里的 provider 跑）。schedule/task 等仍从 subArgs 取自己的参数，不受影响。
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider" && argv[i + 1] !== undefined) args.provider = argv[i + 1];
    else if (a === "--model" && argv[i + 1] !== undefined) args.model = argv[i + 1];
    else if (a.startsWith("--provider=")) args.provider = a.slice("--provider=".length);
    else if (a.startsWith("--model=")) args.model = a.slice("--model=".length);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i === 0 && subcommands.has(a)) {
      args.subcommand = a;
      args.subArgs = argv.slice(1);
      return args;
    }
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-V") args.version = true;
    else if (a === "--list-providers") args.listProviders = true;
    else if (a === "--list-models") args.listModels = true;
    else if (a === "--list-profiles") args.listProfiles = true;
    else if (a === "--list-skills") args.listSkills = true;
    else if (a === "--list-sessions") args.listSessions = true;
    else if (a === "--list-mcp") args.listMcp = true;
    else if (a === "--plan") args.planMode = true;
    else if (a === "--execute-plan") args.executePlan = true;
    else if (a === "--trust-agents-verify") args.trustAgentsVerify = true;
    else if (a === "--json") args.jsonMode = true;
    else if (a === "--auto-compact") args.autoCompact = true;
    else if (a === "--poppy") args.poppy = true;
    else if (a === "--fallback") args.fallback = true;
    else if (a === "--no-fallback") args.noFallback = true;
    else if (a === "--trust") args.trust = true;
    else if (a === "--speak") args.speak = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--example") args.example = true;
    else if (valueFlags.has(a)) {
      const value = argv[++i];
      if (value === undefined) { args.unknown = a; break; }
      switch (a) {
        case "--provider": args.provider = value; break;
        case "--model": args.model = value; break;
        case "--profile": args.profile = value; break;
        case "--mode": args.mode = value; break;
        case "--max-turns": args.maxTurns = parseInt(value, 10); break;
        case "--context-window": args.contextWindow = parseInt(value, 10); break;
        case "--compact": args.compact = value; break;
        case "--resume": args.resume = value; break;
        case "--resume-run": args.resumeRun = value; break;
        case "--verify": args.verify = value; break;
        case "--contract": args.contract = value; break;
        case "--max-cost": args.maxCost = parseFloat(value); break;
        case "--monthly-max-cost": args.monthlyMaxCost = parseFloat(value); break;
        case "--disable-tool": args.disableTools.push(value); break;
        case "--enable-feature": args.enableFeatures.push(value); break;
        case "--add-dir": args.addDirs.push(value); break;
        case "--disable-feature": args.disableFeatures.push(value); break;
        case "--verify-timeout": args.verifyTimeout = parseInt(value, 10); break;
        case "--verify-retries": args.verifyRetries = parseInt(value, 10); break;
        case "--auto-compact-threshold": args.autoCompactThreshold = parseFloat(value); break;
        case "--discover-poppy": args.discoverPoppy = value; break;
        case "--inspect-poppy-identity": args.inspectPoppyIdentity = value; break;
        case "--approve-plan": args.approvePlan = value; break;
        case "--workdir": args.workdir = value; break;
        case "--sandbox": args.sandbox = value; break;
        case "--sandbox-id": args.sandboxId = value; break;
        case "--sandbox-template": args.sandboxTemplate = value; break;
        case "--sandbox-timeout": args.sandboxTimeout = parseInt(value, 10); break;
        case "--lang": args.lang = value; break;
        case "--channel": args.channel = value; break;
        case "--image": args.images.push(value); break;
        case "--video": args.videos.push(value); break;
        case "--voice": args.voice = value; break;
      }
    } else if (a.startsWith("--") && a.includes("=")) {
      const [flag, value] = a.split("=", 2);
      // 缺口 16：可重复 flag 的 --flag=value 形式直接追加——走 parseArgs 递归 +
      // Object.assign 会把已攒的数组整个换掉（--image a --image=b 会丢 a）。
      if (flag === "--image") { args.images.push(value); continue; }
      if (flag === "--video") { args.videos.push(value); continue; }
      if (valueFlags.has(flag)) {
        const fake = parseArgs([flag, value]);
        Object.assign(args, fake);
      } else { args.unknown = a; break; }
    } else if (a.startsWith("-")) { args.unknown = a; break; }
    else positional.push(a);
  }
  if (args.example && positional[0]) args.exampleFile = positional[0];
  else if (positional[0]) args.task = positional[0];
  if (positional.length > 1 && !args.example) args.unknown = positional[1];
  return args;
}

function printSetupHelp(providerName: string): void {
  process.stdout.write(t("setup.noCreds", { provider: providerName }) + "\n");
}

function fallbackEnabled(args: CliArgs): boolean | null {
  if (args.noFallback) return false;
  if (args.fallback) return true;
  return null;
}

function fallbackNotice(record: { from: string; to: string; error: string; kind?: SwitchRecord["kind"]; trigger?: SwitchRecord["trigger"] }, runId?: string | null): void {
  // 备用模型切换通知：文案与群聊回复同款（formatModelSwitchNotice），
  // 后附时间与运行 id——用户一眼能对上是哪次运行、什么时候切的。
  const time = switchTimeShort();
  const suffix = runId ? `（运行 ${runId}，${time}）` : `（${time}）`;
  process.stderr.write(formatModelSwitchNotice(record as SwitchRecord) + suffix + "\n");
}

const TRUSTED_FILE = "trusted_workspaces.json";

function trustedPath(home: string): string { return join(home, TRUSTED_FILE); }

/** 与 Python trust.normalize 同口径：绝对路径 + 解析符号链接，Windows 下小写。 */
function normalizeTrustPath(p: string): string {
  let abs = resolve(p);
  try { abs = realpathSync(abs); } catch { /* 路径不存在时用 resolve 结果 */ }
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
* 读信任列表，双格式兼容：Node 数组格式 ["<路径>", ...] 与 Python 字典格式
* {"version": 1, "folders": {"<路径>": {"trusted_at": ...}}}。损坏文件按全不信任。
*/
function readTrustedList(home: string): string[] {
  let data: unknown;
  try { data = JSON.parse(readFileSync(trustedPath(home), "utf-8")); } catch { return []; }
  let raw: unknown[] = [];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === "object") {
    const folders = (data as Record<string, unknown>).folders;
    if (folders && typeof folders === "object" && !Array.isArray(folders)) raw = Object.keys(folders);
  }
  return raw.filter((x): x is string => typeof x === "string").map((x) => normalizeTrustPath(x));
}

export function isTrusted(workdir: string, home: string): boolean {
  return readTrustedList(home).includes(normalizeTrustPath(workdir));
}

export function addTrusted(workdir: string, home: string): void {
  const path = trustedPath(home);
  const list = readTrustedList(home);
  const key = normalizeTrustPath(workdir);
  if (!list.includes(key)) list.push(key);
  mkdirSync(home, { recursive: true });
  try { chmodSync(home, 0o700); } catch { /* 忽略（如文件系统不支持） */ }
  // 原子写 + 0600（与 Python add_trusted 同口径；旧 Python 字典格式首次写入时转为数组格式）。
  const tmp = join(home, `.trust-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf-8");
    try { chmodSync(tmp, 0o600); } catch { /* 忽略 */ }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 清理失败不掩盖原错 */ }
    throw err;
  }
}

async function ensureWorkspaceTrusted(workdir: string, args: CliArgs, config: Record<string, unknown>, home: string): Promise<number | null> {
  if (args.trust) {
    try { addTrusted(workdir, home); } catch (err: unknown) {
      process.stderr.write(t("trust.warn", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    }
    return null;
  }
  if (config.skip_workspace_trust) return null;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return null;
  if (isTrusted(workdir, home)) return null;
  const trust = renderTrustPrompt(resolve(workdir), {
      width: process.stdout.columns || 80, color: useColor(process.stdout),
      level: useColor(process.stdout) ? detectColorLevel(process.env, true) : 0, unicode: supportsBoxDrawing(),
    });
  process.stdout.write(trust.lines.join("\n") + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
      rl.question(trust.question, (a) => { rl.close(); resolvePromise(a); });
    });
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    process.stdout.write(t("trust.denied") + "\n");
    return 1;
  }
  try { addTrusted(workdir, home); } catch (err: unknown) {
    process.stderr.write(t("trust.warnContinue", { err: err instanceof Error ? err.message : String(err) }) + "\n");
  }
  return null;
}

interface BuiltAgent {
  agent: Agent;
  providerName: string;
  config: Record<string, unknown>;
  home: string;
  /** 缺口 43 第三批：本次运行归属的 Bot agent id（定时任务 --agent / 显式传入时才有；CLI 交互运行为 null，不进分层账）。 */
  agentId: string | null;
  /** 缺口 43 第三批：分层上限回调的上下文 holder（调用方知道 runId 时填进去，触顶暂停记录就带上）。 */
  tieredCtx: TieredCtxHolder;
  /** 缺口 20/29：用量账本与本次运行已落盘的 LLM 花费 holder（月度口径要扣掉它，避免重复计）。 */
  monthly: { ledger: UsageLedger; flushed: { flushedUsd: number } };
  /**
  * 缺口 5：兜底切换回调（stderr 提示 + 经 Agent 发 model_switch 事件进
  * 证据链）。REPL `/model` 建新链时复用同一回调，之后自动切换照样留痕。
  */
  onModelSwitch: (record: SwitchRecord) => void;
  /**
  * 备用模型切换通知：本次运行的运行 id holder（单次运行建 RunRecorder
  * 后填进去，与 tieredCtx.runId 同款 holder 模式；REPL 里没有 RunRecorder
  * 时保持 null，审计里的 run_id 就记 null）。
  */
  switchRunId: { current: string | null };
}

async function buildAgent(args: CliArgs, opts?: { interactive: boolean; skillsDirs?: string[]; onRetry?: (record: RetryRecord) => void; agentId?: string | null; soulAgent?: string | null; teamId?: string | null; teamRole?: "chief" | "member" | null; teamEpoch?: number | null }): Promise<BuiltAgent> {
  const home = resolveHome();
  const config = loadConfig(home);
  const profile = resolveProfile(args.profile ?? null, config);
  const primaryCfg = resolveProvider({
      home, config,
      providerName: args.provider ?? profile.provider,
      model: args.model ?? profile.model ?? undefined,
    });
  const chain = resolvePresetFallbackChain(config, primaryCfg.name, fallbackEnabled(args) ?? undefined);
  // 缺口 5：兜底切换的事件落点——provider 在 Agent 之前建成，先用 holder
  // 占位；Agent 建好后挂上去，之后每次自动切换都经 agent.emit 发
  // model_switch 事件，RunRecorder 写进 events.jsonl（与 REPL /model
  // 的手动切换同一事件、同一口径：何时换、从谁换到谁、为什么换、花了多少）。
  const switchAgent: { current: Agent | null } = { current: null };
  const switchRunId: { current: string | null } = { current: null };
  const onModelSwitch = (r: SwitchRecord): void => {
    fallbackNotice(r, switchRunId.current);
    // 备用模型切换通知：每次真切换记一行审计（SIEM 导出第 7 个来源），
    // 写失败不抛错、不拦运行；Agent 还没建好时也记（run_id 可能为 null）。
    recordModelSwitch(home, r, { runId: switchRunId.current });
    const a = switchAgent.current;
    if (!a) return;
    const spent = a.lastCost?.status === "priced" ? a.lastCost.spentUsd : null;
    a.emit("model_switch", {
        from: r.from, to: r.to, reason: r.error,
        kind: r.kind, status: r.status,
        trigger: r.trigger ?? switchTriggerFor(r.kind),
        spent_usd: spent,
        ...(r.degradedUntil ? { degraded_until: r.degradedUntil } : {}),
      });
  };
  const provider = buildProviderChain(
    primaryCfg, chain,
    onModelSwitch,
    {
      resolver: (name: string) => resolveProvider({ home, config, providerName: name }),
      // 缺口 20：同一 provider 重试前的回调（CLI 用来显示 429 冷却倒计时）。
      onRetry: opts?.onRetry ?? null,
      // G-P1-33：故障账本接线——切换时标 degraded、建链时过滤未恢复的尾巴。
      health: { home },
    },
  );
  if (!provider.hasCredentials()) {
    printSetupHelp(primaryCfg.name);
    throw new AgentError("__NO_CREDENTIALS__");
  }
  const mode = validateMode(args.mode ?? profile.mode ?? (config.mode as string) ?? "auto");
  const maxTurns = args.maxTurns ?? (typeof config.max_turns === "number" ? config.max_turns : 20);
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(t("err.maxTurns"));
  }
  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——后端/模式/网络开关
  // 按 CLI flag > 环境变量 > config.json 解析（resolveSandbox）；显式 bwrap
  // 缺失、e2b 等 fail-closed 情况在这里抛错，命令不跑。
  const sandboxSettings = resolveSandbox(config, args.sandbox ?? null);
  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——这里再做一次 fail-closed
  // 解析：显式 bwrap 缺失、e2b 等直接抛错（main 入口已先拦一道，这里是纵深，
  // 覆盖 --compact 这类先调 buildAgent 的路径；auto 回落不报错）。
  resolveSandboxBackend(config, args.sandbox ?? null);
  // 推理档位 / 冗长度：未配置时 toRequestBody 返回空对象，provider payload 不变。
  const reasoningOpts = resolveReasoningOptions(config);
  (provider as { extraBody?: Record<string, unknown> }).extraBody = toRequestBody(reasoningOpts);
  // 模型上下文窗口自动识别：--context-window > 手动配置 > 刷新缓存 > 内置表
  // > 同系列推断；未知模型不猜数字（resolver 给原因）。同时修掉旧的不一致：
  // CLI 读的是 config.context_window，网关读的是 context_window_tokens，
  // 现在统一走 manualWindowFromConfig（context_window_tokens 优先，旧键兼容）。
  const manualWindow = manualWindowFromConfig(config);
  const windowResolved = resolveContextWindow({
      model: provider.model, provider: primaryCfg.name,
      cli: args.contextWindow, manual: manualWindow.value, manualKey: manualWindow.key,
      cache: loadModelCache(home),
    });
  // 缺口 29：月度硬顶的“本月已花（不含本次运行）”——账本里的本月 LLM 花费
  // + 本月 MCP 花费，减去本次运行已经落盘的部分（账本里有、但本次运行的
  // 进行中花费还没算进去，扣掉才不重复计）。账本读失败返回 null：算不出
  // 就不封顶，不假装。月度上限本身：CLI 显式值 > 配置，默认不设上限。
  const monthlyLedger = new UsageLedger(home);
  const monthlyFlushed = { flushedUsd: 0 };
  const monthlyLimit = resolveMonthlyLimit(config, args.monthlyMaxCost ?? null);
  const monthlySpentBeforeUsd = monthlyLimit === null ? null : (): { spentUsd: number; incomplete: boolean } | null => {
    try {
      const llm = monthlyLedger.monthTotal(monthKeyString());
      const mcp = new McpCostTracker(home).monthTotalUsd(monthKeyString());
      return { spentUsd: llm.spentUsd + mcp - monthlyFlushed.flushedUsd, incomplete: llm.incomplete };
    } catch {
      return null;
    }
  };
  // 缺口 43 第三批：分层成本上限回调（定时任务 --agent 等知道 agent id 时才接；
  // CLI 交互运行没有 agent id，不接——组织级月度硬顶照样管它）。
  const tieredCtx: TieredCtxHolder = {};
  const agentId = opts?.agentId ?? null;
  const tieredCapCheck = agentId ? makeTieredCapCheck(home, agentId, tieredCtx) : null;
  // 缺口 24：多模型工厂——Plan/Act 分模型与 compact/delegate/reviewer/verifier
  // 便宜模型的共同前提。此前没接，这些模型切换都静默回退到了主模型。
  const multiModelFactory = makeModelFactory({ home, config, primaryName: primaryCfg.name });
  const agent = new Agent(provider, {
      workdir: resolve(args.workdir),
      mode,
      maxTurns,
      interactive: opts?.interactive ?? true,
      skillsDirs: opts?.skillsDirs,
      // 单技能启停（对齐 Codex `[[skills.config]] enabled=false`）：config.skills.disabled
      skillsDisabled: (() => {
          const sk = (config as Record<string, unknown>).skills;
          if (!sk || typeof sk !== "object") return [];
          const d = (sk as Record<string, unknown>).disabled;
          return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
        })(),
      contextWindowTokens: windowResolved.window,
      contextWindowSource: windowResolved.source,
      contextWindowModel: windowResolved.model,
      autoCompactEnabled: args.autoCompact,
      // 缺口 4：分应用文风学习——--channel 指定本次运行的代笔渠道，按画像注入提示词。
      channel: args.channel ?? null,
      autoCompactThreshold: args.autoCompactThreshold ?? undefined,
      poppyEnabled: args.poppy,
      home,
      // P2-2：成本硬顶。单价从 config.pricing 按模型名解析；未配置时金额未知（不编造）。
      // 管理员锁定（config.enforced）优先于 CLI 与 config：被锁的键改不动。
      maxCostUsd: (() => {
          const enf = resolveEnforced(config).values;
          if (typeof enf.max_cost_usd === "number") return enf.max_cost_usd;
          return args.maxCost ?? (typeof config.max_cost_usd === "number" ? config.max_cost_usd : null);
        })(),
      pricing: resolvePricing(config.pricing, provider.model),
      // 缺口 29：月度支出硬顶（与 --max-cost 同级硬停；默认不设上限，见 docs/cost.md）。
      monthlyCostLimitUsd: monthlyLimit,
      monthlySpentBeforeUsd,
      // 缺口 43 第三批：分层成本上限（与月度硬顶同级硬停；只有知道 agent id 时才接）。
      tieredCapCheck,
      // 辅助任务走便宜模型（对齐 Alma 的 Tool Model）：压缩与子任务默认模型。
      auxModels: (() => { const r = resolveAuxRouting(config, provider.model); return { compact: r.compact, delegate: r.delegate }; })(),
      // 缺口 24：多模型工厂（Plan/Act 分模型 + compact/delegate/reviewer/verifier
      // 便宜模型的共同前提；此前没接，这些切换都静默回退到了主模型）。
      multiModelFactory,
      // 缺口 24：Plan/Act 分模型路由（规划用强推理模型、执行用便宜模型）。
      planActModels: (() => { const r = resolvePlanActRouting(config, provider.model); return { plan: r.plan, act: r.act }; })(),
      // 缺口 24：轻量 Repo Map（规划阶段注入函数/类签名地图；默认关）。
      repoMap: (() => {
        const rm = (config as Record<string, unknown>).repo_map;
        if (!rm || typeof rm !== "object") return { enabled: false };
        const o = rm as Record<string, unknown>;
        return {
          enabled: o.enabled === true,
          tokenBudget: typeof o.token_budget === "number" ? o.token_budget : undefined,
        };
      })(),
      // 缺口 16：视觉输入的配置（上限等，describe_image 工具共用同一份）。
      visionConfig: resolveVisionConfig(config),
      // 缺口 15：语音的配置（上限、模型、单价等）。
      voiceConfig: resolveVoiceConfig(config),
      // 缺口 28：Soul 身份层——当前运行用哪个 Soul（config.soul.agent，默认 default；
      // 团队分派时由调用方显式指定参谋长/成员的 Soul）。
      soulAgent: opts?.soulAgent ?? resolveSoulAgentId(config),
      // GROK-1：常驻团队模式——不在团队里时两者都为 null（普通运行行为不变）。
      teamId: opts?.teamId ?? null,
      teamRole: opts?.teamRole ?? null,
      // 第 2 批 G-P1-3：团队纪元（team dispatch 时按计划传进来；delegateDetailed 校验它）。
      teamEpoch: opts?.teamEpoch ?? null,
      // 缺口 24：子 agent 独立推理档位（delegate_reasoning_effort）。
      delegateReasoningEffort: typeof config.delegate_reasoning_effort === "string" ? config.delegate_reasoning_effort : null,
      // H-7：嵌套委派深度上限（config.delegate_max_depth，默认 2，可配 1–5）。
      maxDelegateDepth: resolveMaxDelegateDepth((config as Record<string, unknown>).delegate_max_depth),
      // 缺口 10：独立审查层用的模型名（reviewer.model / smart_approvals
      // reviewer_model / 默认 deepseek-flash，见 reviewer.ts）。
      reviewerModel: resolveReviewerModel(config).model,
      // 缺口 13：验收者配置与模型名（verifier 一节 / smart_approvals
      // reviewer_model / 默认 deepseek-flash，见 verifier.ts）。
      verifier: verifierConfig(config),
      verifierModel: resolveVerifierModel(config).model,
      // 缺口 5：对话中途手动换模型的允许列表（primary + fallback_providers，
      // 与兜底链同一份名单；不受 fallback_enabled 开关影响，见 config.ts）。
      modelSwitchAllowlist: resolveSwitchAllowlist(config, primaryCfg.name),
      // 工具集裁剪（config.disabled_tools + --disable-tool）：每轮少发 schema = 每轮省钱。
      disabledTools: [...(Array.isArray(effectiveValue(config, "disabled_tools")) ? effectiveStringList(config, "disabled_tools").filter((t): t is string => typeof t === "string") : []), ...args.disableTools],
      // 工具检索（延迟加载）：config.tool_search.enabled 打开后只发核心工具 + 已揭示的。
      // 跨会话回忆（features.run_recall 默认开）：上次同类任务的结论注入系统提示。
      recallNote: (() => {
          const feats = resolveFeatures(config, { enable: args.enableFeatures, disable: args.disableFeatures });
          if (!featureOn(feats, "run_recall")) return null;
          try {
            const store = new RunStore(join(home, "runs"));
            return buildRecallNote(store.list(), args.task ?? "", { workdir: resolve(args.workdir), limit: 3 });
          } catch {
            return null; // 历史读不了不该挡住本次运行
          }
        })(),    // --add-dir / config.extra_writable_dirs：显式放开工作目录之外的可写根。
      extraDirs: (() => {
          const cfgDirs = Array.isArray(config.extra_writable_dirs)
          ? config.extra_writable_dirs.filter((x): x is string => typeof x === "string")
          : [];
          const { ok, rejected } = resolveExtraDirs([...cfgDirs, ...args.addDirs], { workdir: resolve(args.workdir) });
          for (const r of rejected) process.stderr.write(`忽略 --add-dir ${r.input}：${r.reason}\n`);
          return ok;
        })(),
      toolSearch: (() => {
          const ts = config.tool_search;
          if (!ts || typeof ts !== "object") return { enabled: false };
          const o = ts as Record<string, unknown>;
          return {
            // 两条路都算数：显式 config.tool_search.enabled，或 features.tool_search 开关。
            enabled: o.enabled === true || featureOn(resolveFeatures(config, { enable: args.enableFeatures, disable: args.disableFeatures }), "tool_search"),
            topK: typeof o.top_k === "number" ? o.top_k : undefined,
            always: Array.isArray(o.always) ? o.always.filter((x): x is string => typeof x === "string") : undefined,
          };
        })(),
      sandbox: {
        backend: sandboxSettings.backend,
        mode: sandboxSettings.mode as "read-only" | "workspace-write" | "danger-full-access",
        allowNet: sandboxSettings.allowNet,
      },
    });
  switchAgent.current = agent;
  return { agent, providerName: primaryCfg.name, config, home, agentId, tieredCtx, monthly: { ledger: monthlyLedger, flushed: monthlyFlushed }, onModelSwitch, switchRunId };
}

// ---- 缺口 20：用量账本 flush ----
// 把一次运行的累计用量增量写进账本（热力图与月度硬顶的事实源）。
// own 事件（usage/cost_update）：按上次 flush 的快照算增量；
// delegate_usage：子任务独立累计，全量当增量记。账本写失败绝不破坏运行。
function makeUsageFlusher(built: BuiltAgent): {
  flush: (agent: Agent, kind: string, data: Record<string, unknown>) => void;
  flushNow: (agent: Agent) => void;
} {
  const ledger = built.monthly.ledger;
  let lastSnap: UsageSnapshot | null = null;
  let lastSpent: number | null = null;
  const recordOwn = (agent: Agent): void => {
    const snap = agent.usage.snapshot();
    // 缺口 15：语音花费（STT 按分钟、TTS 按字数，不走 token 账）同样进账本；
    // token 未计价时只记语音部分，两边都没计价时记 null（不编数字）。
    const tokenSpent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    const voiceSpent = agent.voiceSpentUsd ?? 0;
    const spent = tokenSpent === null ? (voiceSpent > 0 ? voiceSpent : null) : tokenSpent + voiceSpent;
    // 缺口 43 第三批：知道 agent id 时按 agent 归属记账（分层上限用）；不知道时不记归属。
    const rec = ledger.recordDelta(snap, lastSnap, spent, lastSpent, agent.provider.model, undefined, built.agentId ?? null);
    // 只有主 agent 自己的已落盘花费才进 flushedUsd：月度口径 = 账本 - flushedUsd
    // + 本次运行进行中花费；子任务的花费已在账本里、但不在主 agent 快照里，
    // 不能扣，扣了就会漏计子任务。
    if (rec && rec.spent_usd !== null) built.monthly.flushed.flushedUsd += rec.spent_usd;
    lastSnap = snap;
    lastSpent = spent;
  };
  return {
    flush: (agent, kind, data) => {
      try {
        if (kind === "delegate_usage") {
          const snap = data.snapshot as unknown as UsageSnapshot | undefined;
          if (snap && typeof snap === "object") {
            const spent = typeof data.spent_usd === "number" ? data.spent_usd : null;
            // 缺口 43 第三批：子任务的用量同样按父级 agent 归属记账（与 tieredCapCheck 的继承口径一致）。
            ledger.recordDelta(snap, null, spent, null, typeof data.model === "string" ? data.model : null, undefined, built.agentId ?? null);
          }
        } else if (kind === "usage" || kind === "cost_update") {
          recordOwn(agent);
        }
      } catch { /* 账本写失败不破坏运行 */ }
    },
    flushNow: (agent) => {
      try { recordOwn(agent); } catch { /* ignore */ }
    },
  };
}

function verifySetup(args: CliArgs, config: Record<string, unknown>, workdir: string): { command: string | null; skipReason: string | null } {
  const [command, source] = resolveVerifyOrigin(args.verify, config, workdir);
  if (!command) return { command: null, skipReason: null };
  const [accepted, reason] = acceptVerifyCommand(command, source, {
      trustAgents: args.trustAgentsVerify,
      interactive: process.stdin.isTTY,
    });
  return { command: accepted, skipReason: reason };
}

// ---- 子命令：ui（第 3 阶段：单 gateway） ----
async function handleUi(argv: string[], workdir: string, home: string): Promise<number> {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const host = get("--host") ?? "127.0.0.1";
  const portRaw = get("--port");
  const port = portRaw !== undefined ? parseInt(portRaw, 10) : 8765;
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    process.stderr.write("错误：--port 必须是 0–65535 的整数\n");
    return 2;
  }
  const printJson = has("--print-url-json");
  const exitOnStdinClose = has("--exit-on-stdin-close");
  const pair = has("--pair");
  const config = loadConfig(home);
  const gateway = new Gateway({
      home, workdir,
      host: pair && host === "127.0.0.1" ? "0.0.0.0" : host,
      port,
      mode: get("--mode") ?? undefined,
      providerName: get("--provider") ?? null,
      model: get("--model") ?? null,
      profile: get("--profile") ?? null,
      verbose: has("--verbose"),
      config,
      // 桌面外壳（Tauri）固定用 --print-url-json 启动网关：页面据此只在桌面端播入场动画。
      shell: printJson ? "desktop" : null,
    });
  let info: { host: string; port: number; url: string };
  try {
    info = await gateway.start();
  } catch (err) {
    process.stderr.write(`错误：无法监听 ${host}:${port}：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  gateway.startScheduler(60);
  const url = info.url;
  if (printJson) {
    // 桌面外壳契约：stdout 第一行是一行 JSON（nyra/version/url/host/port/token），
    // 人读的提示一律改到 stderr；stdin 关闭即退出（退出码 0）。
    process.stdout.write(JSON.stringify(gateway.urlJson()) + "\n");
    process.stderr.write(`Nyra ${VERSION} 网页界面已启动：${url}\n`);
    process.stderr.write("这个链接里含有本次启动的访问 token，请不要分享。\n");
  } else {
    process.stdout.write(`Nyra ${VERSION} 网页界面已启动：${url}\n`);
    process.stdout.write("这个链接里含有本次启动的访问 token，请不要分享。按 Ctrl+C 停止。\n");
  }
  if (pair) {
    try {
      const pairing = gateway.startPairing();
      const line = `手机配对码 ${pairing.code}（${Math.floor(Number(pairing.expires_in) / 60)} 分钟内有效，一次性，输错 5 次作废）；用手机扫下面的二维码，或打开 ${pairing.url} 并输入配对码。`;
      const out = printJson ? process.stderr : process.stdout;
      let qr = "";
      try {
        // 终端里画二维码（本机生成，不调第三方）；非 TTY / NO_COLOR 时不带 ANSI 颜色。
        const ansi = Boolean(out.isTTY) && !process.env.NO_COLOR;
        qr = qrToTerminal(qrEncode(String(pairing.url), "M"), { ansi }) + "\n";
      } catch { qr = ""; }
      out.write(qr + line + "\n");
      out.write("只在可信的局域网里配对；已配对的设备可在网页“设置 → 手机”里撤销。\n");
    } catch (err) {
      process.stderr.write(`无法生成配对码：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (has("--open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      const child = spawn(opener, args, { detached: true, stdio: "ignore" });
      child.unref();
    } catch { /* 打不开浏览器不阻塞服务 */ }
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await gateway.stop();
  };
  const done = new Promise<number>((resolvePromise) => {
      process.once("SIGINT", () => { void stop().then(() => resolvePromise(0)); });
      process.once("SIGTERM", () => { void stop().then(() => resolvePromise(0)); });
      if (exitOnStdinClose) {
        process.stdin.resume();
        process.stdin.once("end", () => { void stop().then(() => resolvePromise(0)); });
        process.stdin.once("close", () => { void stop().then(() => resolvePromise(0)); });
      }
    });
  return done;
}

// ---- 子命令：gw（连正在跑的 gateway 当客户端） ----
async function handleGw(argv: string[]): Promise<number> {
  const flags = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rest = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--url" && argv[i - 1] !== "--token");
  const action = rest[0];
  const client = new GatewayClient({ url: flags("--url"), token: flags("--token") });
  if (!client.token) {
    process.stderr.write("错误：gw 需要 gateway token（--token 或 NYRA_GATEWAY_TOKEN；启动 nyra ui 时终端会打印含 token 的链接）\n");
    return 2;
  }
  try {
    if (action === "sessions") {
      const data = await client.sessions() as { sessions: { id: string; count: number; preview: string }[] };
      if (!data.sessions.length) process.stdout.write("暂无历史会话\n");
      else for (const s of data.sessions) process.stdout.write(`- ${s.id}（${s.count} 条消息）${s.preview}\n`);
      return 0;
    }
    if (action === "send") {
      const id = rest[1];
      const text = rest.slice(2).join(" ");
      if (!id || !text) { process.stderr.write("用法：nyra gw send <会话 id> <消息>\n"); return 2; }
      const out = await client.send(id, text) as { status: string; error: string };
      process.stdout.write(`已发送到 ${id}，状态：${out.status}${out.error ? `（${out.error}）` : ""}\n`);
      return 0;
    }
    if (action === "view") {
      const id = rest[1];
      if (!id) { process.stderr.write("用法：nyra gw view <会话 id>\n"); return 2; }
      const view = await client.sessionView(id) as { status: string; messages: { role: string; content: unknown }[] };
      process.stdout.write(`状态：${view.status}\n`);
      for (const m of view.messages) process.stdout.write(`[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}\n`);
      return 0;
    }
    if (action === "approve") {
      const id = rest[1];
      if (!id) { process.stderr.write("用法：nyra gw approve <审批 id> [--always]\n"); return 2; }
      await client.decide(id, true, argv.includes("--always"));
      process.stdout.write(`已批准 ${id}\n`);
      return 0;
    }
    if (action === "rewind") {
      const id = rest[1];
      const messageId = Number(rest[2]);
      const op = rest[3] as "truncate" | "edit" | "fork";
      const text = rest.slice(4).join(" ") || null;
      if (!id || !Number.isInteger(messageId) || !["truncate", "edit", "fork"].includes(op)) {
        process.stderr.write("用法：nyra gw rewind <会话 id> <消息 id> <truncate|edit|fork> [新文本]\n");
        return 2;
      }
      const out = await client.rewind(id, messageId, op, text) as { kept: number; deleted: number; new_session_id: string | null };
      process.stdout.write(`回退完成：保留 ${out.kept} 条，删除 ${out.deleted} 条${out.new_session_id ? `，新会话 ${out.new_session_id}` : ""}\n`);
      return 0;
    }
    if (action === "info") {
      const info = await client.info() as { version: string; mode: string; provider: string; model: string };
      process.stdout.write(`Nyra ${info.version} · 模式 ${info.mode} · ${info.provider} / ${info.model}\n`);
      return 0;
    }
    if (action === "schedule") {
      const data = await client.schedule() as { tasks: { name: string; enabled?: boolean }[] };
      if (!data.tasks.length) process.stdout.write("暂无定时任务\n");
      else for (const t of data.tasks) process.stdout.write(`- ${t.name}${t.enabled === false ? "（已停用）" : ""}\n`);
      return 0;
    }
    process.stderr.write("用法：nyra gw <sessions|send|view|approve|rewind|info|schedule>\n");
    return 2;
  } catch (err) {
    process.stderr.write(`gateway 调用失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：schedule ----
async function handleSchedule(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra schedule <list|add|remove|run|daemon> [选项]\n");
    return 2;
  }
  try {
    const data = loadSchedule();
    if (action === "list") {
      for (const t of listScheduleTasks(data)) {
        process.stdout.write(`${t.name}\t${t.enabled === false ? "禁用" : "启用"}\t${t.every_seconds ? `每 ${t.every_seconds} 秒` : t.at}\t${t.last_status ?? ""}\t${t.agent ?? ""}\n`);
      }
      return 0;
    }
    if (action === "add") {
      const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const name = get("--name");
      const prompt = get("--prompt");
      if (!name || !prompt) { process.stderr.write("错误：schedule add 需要 --name 与 --prompt\n"); return 2; }
      const every = get("--every") ? parseInt(get("--every")!, 10) : null;
      const at = get("--at") ?? null;
      const mode = get("--mode") ?? "auto";
      // 缺口 42 第三批：--agent <名字> 让任务归属一台 Bot，跑在它的电脑里
      //（非法 agent id 由 validateTask 拒绝；没给时行为与以前一致）。
      const agent = get("--agent") ?? null;
      addScheduleTask(data, { name, prompt, every_seconds: every, at, mode, enabled: !argv.includes("--disable"), agent });
      saveSchedule(data);
      process.stdout.write(`已添加定时任务：${name}${agent ? `（agent ${agent}，跑在它的电脑里）` : ""}\n`);
      return 0;
    }
    if (action === "remove") {
      const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：schedule remove 需要 --name\n"); return 2; }
      if (!removeScheduleTask(data, name)) { process.stderr.write(`错误：没有名为 ${name} 的定时任务\n`); return 2; }
      saveSchedule(data);
      process.stdout.write(`已删除定时任务：${name}\n`);
      return 0;
    }
    if (action === "run" || action === "daemon") {
      const intervalIdx = argv.indexOf("--interval");
      const interval = intervalIdx >= 0 ? parseFloat(argv[intervalIdx + 1]) : 60.0;
      const roundsIdx = argv.indexOf("--rounds");
      const rounds = roundsIdx >= 0 ? parseInt(argv[roundsIdx + 1], 10) : null;
      const factory = async (task: ScheduleTask): Promise<string> => {
        // 缺口 42 第三批：任务归属了 agent 时，跑在那台 Bot 的电脑 workspace
        // 里（休眠的先唤醒）；没接电脑时回退到任务 workdir / 启动目录，任务
        // 照常跑（回退时打印一句，免得用户以为任务在电脑里跑）。
        let taskWorkdir = task.workdir ?? workdir;
        if (task.agent) {
          const resolved = resolveAgentWorkdir(home, task.agent, taskWorkdir);
          if (resolved.computerId) {
            process.stdout.write(`[定时任务] ${task.name} 在电脑 ${resolved.computerId}（${task.agent}）里跑\n`);
          } else {
            process.stdout.write(`[定时任务] ${task.name} 没接电脑（agent ${task.agent} 没有 Soul 或电脑建不出来），用 ${taskWorkdir} 跑\n`);
          }
          taskWorkdir = resolved.workdir;
        }
        const { agent } = await buildAgent({ ...parseArgs([]), workdir: taskWorkdir, mode: task.mode }, { interactive: false, agentId: task.agent ?? null });
        return agent.run(task.prompt);
      };
      // 缺口 7：守护进程每轮顺带跑应用事件源轮询（本批先做 Gmail 新邮件）。
      // 只有存在启用的 gmail 触发器且 Gmail 已启用+已授权时才轮询；轮询器自己按
      // 5 分钟间隔跳过，不到间隔不打 API。轮询只入队，执行靠 `nyra task worker`。
      const pollers: Array<() => Promise<void>> = [];
      try {
        const { loadEventTriggers: loadTriggers, eventTriggersPath } = await import("./eventTriggers.ts");
        const { getGmailStatus, createGmailTransport } = await import("./connectors/gmail.ts");
        const cfg0 = loadConfig(home);
        const gmailTriggers = loadTriggers(eventTriggersPath(home)).triggers
        .filter((t) => t.enabled !== false && t.source === "gmail");
        const st = getGmailStatus(home, cfg0);
        if (gmailTriggers.length && st.enabled && st.configured) {
          pollers.push(async () => {
              const transport = createGmailTransport(home, loadConfig(home));
              const r = await pollGmailTriggers(transport, { home });
              if (r.dispatched) process.stdout.write(`[事件触发] Gmail 新邮件 ${r.newMail} 封，触发 ${r.dispatched} 个任务\n`);
              else if (r.skipped && r.skipped !== "not-due" && r.skipped !== "no-enabled-gmail-trigger") {
                process.stdout.write(`[事件触发] Gmail 轮询跳过：${r.skipped}\n`);
              }
            });
        }
      } catch { /* 轮询器建不起来就不轮询，不破坏定时任务 */ }
      // 缺口 22：守护进程每轮顺带跑邮件入口轮询（白名单邮件直接进任务队列）。
      // 只有邮件入口已启用、白名单非空且 Gmail 已启用+已授权时才轮询；轮询器
      // 自己按 5 分钟间隔跳过，不到间隔不打 API。轮询只入队，执行靠 `nyra task worker`。
      try {
        const { loadMailInboxSettings, pollMailInbox } = await import("./mailInbox.ts");
        const { getGmailStatus, createGmailTransport } = await import("./connectors/gmail.ts");
        const cfg1 = loadConfig(home);
        const inbox = loadMailInboxSettings(home);
        const st1 = getGmailStatus(home, cfg1);
        if (inbox.enabled && inbox.allowlist.length && st1.enabled && st1.configured) {
          pollers.push(async () => {
              const transport = createGmailTransport(home, loadConfig(home));
              const r = await pollMailInbox(transport, { home });
              if (r.enqueued) process.stdout.write(`[邮件入口] Gmail 新邮件 ${r.newMail} 封，入队 ${r.enqueued} 个任务\n`);
              else if (r.skipped && !["not-due", "disabled", "no-allowlist", "first-run-baseline"].includes(r.skipped)) {
                process.stdout.write(`[邮件入口] Gmail 轮询跳过：${r.skipped}\n`);
              }
            });
        }
      } catch { /* 轮询器建不起来就不轮询，不破坏定时任务 */ }
      // 缺口 8：常驻责任巡查（只读、无人值守）。每轮跑一次到期的责任；巡查
      // 经任务队列落盘（run 记录 + 证据链），只读硬约束见 responsibilities.ts；
      // 汇报条件只控制收件箱通知，证据链里每轮都留报告事件。
      pollers.push(async () => {
          const { loadResponsibilities, saveResponsibilities, responsibilitiesPath, runDueResponsibilities } = await import("./responsibilities.ts");
          const data = loadResponsibilities(responsibilitiesPath(home));
          const results = await runDueResponsibilities(data, { home, workdir });
          saveResponsibilities(data, responsibilitiesPath(home));
          for (const r of results) process.stdout.write(`[巡查] ${r.name}：${r.status} - ${r.summary.slice(0, 100)}\n`);
        });
      // 缺口 31：Heartbeat 静默巡查（只读、无人值守）。每轮跑一次到期的
      // monitor：检查项全是只读（收件箱未读、任务板熔断、待续跑子 agent、
      // 已中断运行）；无事安静（只记审计），有发现先记证据再写收件箱，
      // 不直接发消息、不调模型。轮询器自己按间隔跳过，失败只记 stderr。
      pollers.push(async () => {
          const { runDueHeartbeats } = await import("./heartbeat.ts");
          const results = runDueHeartbeats(home);
          for (const r of results) {
            if (!r.quiet) process.stdout.write(`[Heartbeat] ${r.agent}：${r.findings.length} 项发现，已写收件箱。\n`);
          }
        });
      // 缺口 25 的尾巴：工作流触发器执行（默认关，须显式开启）。每轮跑一次
      // 到点的定时触发器；开关关着直接跳过。执行走 runWorkflowByName（非交互、
      // 成本上限继承定义，审批节点照常挂起）；失败只记 stderr，不破坏定时任务。
      pollers.push(async () => {
          const { runDueWorkflowTriggers } = await import("./workflowTriggers.ts");
          const report = await runDueWorkflowTriggers(home, { workdir });
          for (const f of report.fired) {
            process.stdout.write(`[触发器] 工作流 ${f.workflow} 已触发（${f.status === "ok" ? `运行 ${f.runId}` : `失败：${f.error ?? ""}`}）。\n`);
          }
        });
      // Pi Bot 借鉴第 3 条：卡住步骤看门狗（只扫任务板、只标记/重排/停下，
      // 不调模型、不写任务板账本以外的文件、不对外发）。未启用或未到扫描
      // 间隔时 runDueReconciliations 内部跳过；失败只记 stderr，不破坏定时任务。
      pollers.push(async () => {
          const { runDueReconciliations } = await import("./reconciler.ts");
          const report = runDueReconciliations(home);
          if (report.skipped) return;
          const acted = report.flagged.length + report.retried.length + report.blocked.length + report.failed.length;
          if (acted) process.stdout.write(`[看门狗] 扫了 ${report.scanned} 个在跑任务：标卡住 ${report.flagged.length} 个、重排 ${report.retried.length} 个、停下 ${report.blocked.length} 个、运行已失败走 fail 路径 ${report.failed.length} 个。\n`);
        });
      // 缺口 32：变化监测例程 Watch / Watch-with-action（只读巡查：抓页面、
      // 读文件，变了才汇报；带动作的按声明触发，下载须人批）。全局开关未
      // 开时 runDueWatches 内部跳过；失败只记 stderr，不破坏定时任务。
      pollers.push(async () => {
          const { runDueWatches } = await import("./watch.ts");
          const report = await runDueWatches(home);
          if (report.skipped) return;
          const acted = report.changed.length + report.missing.length + report.actions.length;
          if (acted) process.stdout.write(`[Watch] 扫了 ${report.checked} 个到期的监测：变了 ${report.changed.length} 个、目标取不到 ${report.missing.length} 个、触发动作 ${report.actions.length} 个。\n`);
        });
      // Phase 3：定时任务结果推送（Bot notifier）。notifier 没开/没配
      // owner/目标会话/token 时 buildNotifierFromConfig 返回 null，不推、
      // 不报错；推送失败不破坏定时任务（回调内部已兜底）。
      let taskNotifier: BotNotifier | null = null;
      try {
        taskNotifier = buildNotifierFromConfig(home, loadConfig(home));
      } catch { /* notifier 建不起来就不推，不破坏定时任务 */ }
      const done = await runDaemon(factory, { interval, path: undefined, stopAfter: action === "run" ? 1 : rounds, pollers, onTaskResult: taskNotifier ? (r) => { void taskNotifier!.notifyTaskResult(r); } : undefined });
      void done;
      return 0;
    }
    process.stderr.write(`错误：未知子命令 schedule ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：events（缺口 7：事件触发任务） ----
async function handleEvents(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra events <list|add|remove|enable|disable|test|poll> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const data = loadEventTriggers();
    if (action === "list") {
      for (const t of listEventTriggers(home)) {
        process.stdout.write(`${t.name}\t${t.enabled === false ? "禁用" : "启用"}\t${t.source}\t${t.event}\t${t.mode}\n`);
      }
      return 0;
    }
    if (action === "add") {
      const name = get("--name");
      const source = get("--source") ?? "webhook";
      const event = get("--event") ?? (source === "gmail" ? "gmail.new_mail" : undefined);
      const task = get("--task");
      if (!name || !event || !task) {
        process.stderr.write("错误：events add 需要 --name、--event 与 --task（--source 默认 webhook；gmail 来源的 --event 默认 gmail.new_mail）\n");
        return 2;
      }
      const match: Record<string, string> = {};
      if (get("--match-from")) match.from_contains = get("--match-from")!;
      if (get("--match-subject")) match.subject_contains = get("--match-subject")!;
      if (get("--match-text")) match.text_contains = get("--match-text")!;
      const mode = get("--mode") ?? "auto";
      const maxTurns = get("--max-turns") ? parseInt(get("--max-turns")!, 10) : 20;
      const added = addEventTrigger(data, {
          name, source, event, task,
          ...(Object.keys(match).length ? { match } : {}),
          mode, enabled: !argv.includes("--disable"),
          workdir: get("--workdir") ?? workdir, max_turns: maxTurns,
        });
      saveEventTriggers(data);
      process.stdout.write(`已添加事件触发器：${added.name}（${added.source} / ${added.event}，${added.mode}）\n`);
      return 0;
    }
    if (action === "remove") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：events remove 需要 --name\n"); return 2; }
      if (!removeEventTrigger(data, name)) { process.stderr.write(`错误：没有名为 ${name} 的事件触发器\n`); return 2; }
      saveEventTriggers(data);
      process.stdout.write(`已删除事件触发器：${name}\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write(`错误：events ${action} 需要 --name\n`); return 2; }
      if (!setEventTriggerEnabled(data, name, action === "enable")) { process.stderr.write(`错误：没有名为 ${name} 的事件触发器\n`); return 2; }
      saveEventTriggers(data);
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}事件触发器：${name}\n`);
      return 0;
    }
    if (action === "test") {
      const name = get("--name");
      const payloadRaw = get("--payload") ?? "{}";
      if (!name) { process.stderr.write("错误：events test 需要 --name 与 --payload '<JSON>'\n"); return 2; }
      const trigger = data.triggers.find((t) => t.name === name);
      if (!trigger) { process.stderr.write(`错误：没有名为 ${name} 的事件触发器\n`); return 2; }
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(payloadRaw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("payload 必须是 JSON 对象");
        payload = parsed as Record<string, unknown>;
      } catch (err: unknown) {
        process.stderr.write(`错误：--payload 解析失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      const event = {
        source: trigger.source,
        eventType: trigger.event,
        eventId: "test",
        receivedAt: new Date().toISOString(),
        actor: typeof payload.actor === "string" ? payload.actor : null,
        summary: typeof payload.summary === "string" ? payload.summary : "",
        payload,
        auth: "none",
      };
      const matched = matchEventTrigger(trigger, event);
      process.stdout.write(`匹配：${matched ? "是" : "否"}\n`);
      if (matched) {
        const prompt = buildTriggerPrompt(trigger, event);
        process.stdout.write(`任务提示词（前 800 字）：\n${prompt.slice(0, 800)}\n`);
      }
      return 0;
    }
    if (action === "poll") {
      const { getGmailStatus, createGmailTransport } = await import("./connectors/gmail.ts");
      const cfg = loadConfig(home);
      const st = getGmailStatus(home, cfg);
      if (!st.enabled || !st.configured) {
        process.stderr.write("错误：Gmail 未启用或未授权（先运行 nyra gmail auth），轮询需要 Gmail 连接器\n");
        return 1;
      }
      const transport = createGmailTransport(home, cfg);
      const r = await pollGmailTriggers(transport, { home, force: true });
      process.stdout.write(`检查 ${r.checked} 封，新邮件 ${r.newMail} 封，触发 ${r.dispatched} 个任务${r.skipped ? `（跳过：${r.skipped}）` : ""}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 events ${action}\n`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof EventTriggerError) process.stderr.write(`错误：${err.message}\n`);
    else process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：mail-inbox（缺口 22：邮件即任务入口） ----
async function handleMailInbox(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra mail-inbox <status|enable|disable|allowlist|set|poll> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const { loadMailInboxSettings, saveMailInboxSettings, addMailInboxSender, removeMailInboxSender, listMailInboxPublic, pollMailInbox } = await import("./mailInbox.ts");
    if (action === "status") {
      const pub = listMailInboxPublic(home);
      process.stdout.write(`邮件入口：${pub.enabled ? "启用" : "禁用"}\n`);
      process.stdout.write(`模式：${pub.mode}；跑完回信：${pub.reply_results ? "是" : "否"}；待回信：${pub.pending_replies} 封\n`);
      process.stdout.write(`白名单（${pub.allowlist.length}）：${pub.allowlist.length ? pub.allowlist.join("、") : "（空）"}\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const settings = loadMailInboxSettings(home);
      settings.enabled = action === "enable";
      saveMailInboxSettings(settings, home);
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}邮件入口${settings.enabled && !settings.allowlist.length ? "（白名单还是空的，先加发件人才能派活）" : ""}\n`);
      return 0;
    }
    if (action === "allowlist") {
      const sub = argv[1];
      const settings = loadMailInboxSettings(home);
      if (sub === "list") {
        for (const addr of settings.allowlist) process.stdout.write(`${addr}\n`);
        return 0;
      }
      const email = argv[2];
      if ((sub === "add" || sub === "remove") && email) {
        const changed = sub === "add" ? addMailInboxSender(settings, email) : removeMailInboxSender(settings, email);
        if (!changed) {
          process.stdout.write(sub === "add" ? `白名单里已有：${email.trim().toLowerCase()}\n` : `白名单里没有：${email.trim().toLowerCase()}\n`);
          return 0;
        }
        saveMailInboxSettings(settings, home);
        process.stdout.write(`已${sub === "add" ? "加入" : "移出"}白名单：${email.trim().toLowerCase()}\n`);
        return 0;
      }
      process.stderr.write("错误：用法：nyra mail-inbox allowlist <list|add <邮箱>|remove <邮箱>>\n");
      return 2;
    }
    if (action === "set") {
      const settings = loadMailInboxSettings(home);
      const mode = get("--mode");
      if (mode) {
        if (mode !== "readonly" && mode !== "auto") { process.stderr.write("错误：--mode 只允许 readonly 或 auto\n"); return 2; }
        settings.mode = mode;
      }
      const reply = get("--reply-results");
      if (reply) {
        if (reply !== "on" && reply !== "off") { process.stderr.write("错误：--reply-results 只允许 on 或 off\n"); return 2; }
        settings.reply_results = reply === "on";
      }
      const maxBody = get("--max-body-chars");
      if (maxBody) {
        const n = parseInt(maxBody, 10);
        if (!Number.isInteger(n) || n < 100 || n > 7000) { process.stderr.write("错误：--max-body-chars 必须是 100–7000 的整数\n"); return 2; }
        settings.max_body_chars = n;
      }
      saveMailInboxSettings(settings, home);
      process.stdout.write(`邮件入口设置已保存：模式 ${settings.mode}，跑完回信 ${settings.reply_results ? "开" : "关"}，正文上限 ${settings.max_body_chars} 字\n`);
      return 0;
    }
    if (action === "poll") {
      const { getGmailStatus, createGmailTransport } = await import("./connectors/gmail.ts");
      const cfg = loadConfig(home);
      const st = getGmailStatus(home, cfg);
      if (!st.enabled || !st.configured) {
        process.stderr.write("错误：Gmail 未启用或未授权（先运行 nyra gmail auth），轮询需要 Gmail 连接器\n");
        return 1;
      }
      const transport = createGmailTransport(home, cfg);
      const r = await pollMailInbox(transport, { home, force: true });
      process.stdout.write(`检查 ${r.checked} 封，新邮件 ${r.newMail} 封，入队 ${r.enqueued} 个任务（非白名单跳过 ${r.skippedNotAllowlisted} 封，读失败 ${r.errors} 封）${r.skipped ? `（跳过：${r.skipped}）` : ""}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 mail-inbox ${action}\n`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof MailInboxError) process.stderr.write(`错误：${err.message}\n`);
    else process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：responsibility（缺口 8：常驻责任制 + 无人值守强制只读） ----
async function handleResponsibility(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra responsibility <list|add|set|remove|enable|disable|check|pause|resume|complete|cancel|brief|show> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const { loadResponsibilities, saveResponsibilities, addResponsibility, updateResponsibility, nextCheckLabel, expiryLabel, removeResponsibility, setResponsibilityStatus, completeResponsibility, sweepExpiredResponsibilities, responsibilitiesPath, runPatrol } = await import("./responsibilities.ts");
    const data = loadResponsibilities(responsibilitiesPath(home));
    // 每次进责任命令先扫一遍过期：到期自动失效，不永久驻留。
    if (sweepExpiredResponsibilities(data, new Date(), home).length > 0) {
      saveResponsibilities(data, responsibilitiesPath(home));
    }
    if (action === "list") {
      for (const r of data.responsibilities) {
        process.stdout.write(`${r.name}\t${r.status}\t${r.owner}\t每 ${r.every_seconds} 秒\t${nextCheckLabel(r)}\t${expiryLabel(r)}\t${r.report === "always" ? "每次汇报" : "有发现汇报"}\t${r.last_status ?? ""}\t${r.goal.slice(0, 60)}\n`);
      }
      return 0;
    }
    if (action === "add") {
      const name = get("--name");
      const goal = get("--goal");
      const every = get("--every") ? parseInt(get("--every")!, 10) : NaN;
      const report = get("--report") ?? "on-finding";
      if (!name || !goal || !Number.isInteger(every)) {
        process.stderr.write("错误：responsibility add 需要 --name、--goal 与 --every <秒数>（--report on-finding|always，默认 on-finding）\n");
        return 2;
      }
      const maxTurns = get("--max-turns") ? parseInt(get("--max-turns")!, 10) : 20;
      const added = addResponsibility(data, {
          name, goal, every_seconds: every, report,
          enabled: !argv.includes("--disable"),
          workdir: get("--workdir") ?? workdir, max_turns: maxTurns,
          owner: get("--owner") ?? "user",
          done_when: get("--done-when") ?? [],
          escalate_on: get("--escalate-on") ?? [],
          expires_at: get("--expires-at") ?? null,
        });
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`已添加常驻责任：${added.name}（每 ${added.every_seconds} 秒巡查一次，只读，${added.report === "always" ? "每次汇报" : "有发现才汇报"}）\n`);
      return 0;
    }
    if (action === "set") {
      // 缺口 45 深化：建好后改复查节奏 / 汇报规则 / 升级条件 / 过期时间 / 归属人。
      // 只改传了的项，没传的不动；--expires-at none 是清掉过期时间（不过期）。
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：responsibility set 需要 --name\n"); return 2; }
      const patch: Record<string, unknown> = {};
      const everyRaw = get("--every");
      if (everyRaw !== undefined) patch.every_seconds = parseInt(everyRaw, 10);
      const report = get("--report");
      if (report !== undefined) patch.report = report;
      const escalateOn = get("--escalate-on");
      if (escalateOn !== undefined) patch.escalate_on = escalateOn;
      const expiresAt = get("--expires-at");
      if (expiresAt !== undefined) patch.expires_at = expiresAt === "none" ? null : expiresAt;
      const owner = get("--owner");
      if (owner !== undefined) patch.owner = owner;
      if (Object.keys(patch).length === 0) {
        process.stderr.write("错误：responsibility set 至少要改一项（--every / --report / --escalate-on / --expires-at / --owner）\n");
        return 2;
      }
      const updated = updateResponsibility(data, name, patch);
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`责任「${updated.name}」已更新：每 ${updated.every_seconds} 秒巡查、${updated.report === "always" ? "每次汇报" : "有发现汇报"}、归属 ${updated.owner}${updated.expires_at ? `、到期 ${updated.expires_at}` : "、不过期"}\n`);
      return 0;
    }
    if (action === "remove") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：responsibility remove 需要 --name\n"); return 2; }
      if (!removeResponsibility(data, name)) { process.stderr.write(`错误：没有名为 ${name} 的责任\n`); return 2; }
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`已删除常驻责任：${name}\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write(`错误：responsibility ${action} 需要 --name\n`); return 2; }
      // 缺口 45：enable/disable 与 pause/resume 同义，都走状态机（单一事实源）。
      const { from } = setResponsibilityStatus(data, name, action === "enable" ? "active" : "paused", home);
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}常驻责任：${name}（${from} → ${action === "enable" ? "active" : "paused"}）\n`);
      return 0;
    }
    if (action === "pause" || action === "resume" || action === "cancel") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write(`错误：responsibility ${action} 需要 --name\n`); return 2; }
      const to = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
      const { from } = setResponsibilityStatus(data, name, to, home);
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`责任「${name}」：${from} → ${to}\n`);
      return 0;
    }
    if (action === "complete") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：responsibility complete 需要 --name\n"); return 2; }
      const { responsibility, results, humanConfirmed } = completeResponsibility(data, name, {
        home, workdir, confirmHuman: argv.includes("--yes"),
      });
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`责任「${responsibility.name}」已完成：验收通过 ${results.filter((r) => r.passed).length}/${results.length} 项${humanConfirmed ? "（含人工确认）" : ""}\n`);
      return 0;
    }
    if (action === "brief") {
      const { buildMorningBrief } = await import("./briefing.ts");
      const brief = buildMorningBrief(home, { since: get("--since") });
      process.stdout.write(brief.text);
      if (brief.quiet) {
        process.stdout.write("（无事安静：未写收件箱、未建 task 记录、未发消息）\n");
      } else {
        process.stdout.write(`（已存 ${brief.savedPath}，收件箱已留一条指针）\n`);
      }
      return 0;
    }
    if (action === "show") {
      const { latestBriefingPath } = await import("./briefing.ts");
      const path = latestBriefingPath(home);
      if (!path) { process.stderr.write("错误：还没有生成过晨间简报，先跑 nyra responsibility brief\n"); return 2; }
      const { readFileSync } = await import("node:fs");
      process.stdout.write(readFileSync(path, "utf-8"));
      return 0;
    }
    if (action === "check") {
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：responsibility check 需要 --name\n"); return 2; }
      const resp = data.responsibilities.find((r) => r.name === name);
      if (!resp) { process.stderr.write(`错误：没有名为 ${name} 的责任\n`); return 2; }
      if (resp.status !== "active") { process.stderr.write(`错误：责任「${name}」当前状态是 ${resp.status}，只有进行中的责任能巡查\n`); return 2; }
      const result = await runPatrol(resp, { home, workdir });
      saveResponsibilities(data, responsibilitiesPath(home));
      process.stdout.write(`巡查「${resp.name}」：${result.hasFindings ? "有发现" : "无发现"} - ${result.summary.slice(0, 200)}${result.reported ? "" : "（未汇报：无发现）"}${result.escalated ? `（已升级：审阅队列 ${result.escalationItemId}）` : ""}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 responsibility ${action}\n`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof ResponsibilityError) process.stderr.write(`错误：${err.message}\n`);
    else process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：reviewer（缺口 10：独立审查层） ----
async function handleReviewer(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra reviewer <status|enable|disable|set-model|add-rule|remove-rule|list-rules|check> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const { reviewerConfig, reviewerStatus, resolveReviewerModel, buildReviewerRunner, reviewToolCall } = await import("./reviewer.ts");
    const config = loadConfig(home);
    if (action === "status") {
      const st = reviewerStatus(config, home);
      process.stdout.write(`独立审查层：${st.enabled ? "启用" : "禁用（默认关闭）"}\n`);
      process.stdout.write(`审查模型：${st.provider}:${st.model}${st.hasCredentials ? "" : "（无凭证：开启后被审工具会被拦截，请先配好该模型的凭证）"}\n`);
      process.stdout.write(`被审工具（${st.tools.length}）：${st.tools.join("、")}\n`);
      process.stdout.write(`额外规则（${st.rules.length}）：${st.rules.length ? st.rules.map((r, i) => `${i + 1}. ${r}`).join("；") : "（无）"}\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const cfg = reviewerConfig(config);
      saveConfig(home, { reviewer: { ...cfg, enabled: action === "enable" } });
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}独立审查层${action === "enable" ? "（敏感工具调用先过独立审查，审查失败即拦截）" : ""}\n`);
      return 0;
    }
    if (action === "set-model") {
      const spec = argv[1];
      if (!spec) { process.stderr.write("错误：用法：nyra reviewer set-model <provider:模型> 或 <模型>\n"); return 2; }
      const cfg = reviewerConfig(config);
      let provider = cfg.provider;
      let model: string | null = cfg.model;
      const idx = spec.indexOf(":");
      if (idx >= 0) {
        provider = spec.slice(0, idx).trim() || null;
        model = spec.slice(idx + 1).trim() || null;
      } else {
        model = spec.trim();
      }
      if (!model) { process.stderr.write("错误：set-model 需要模型名\n"); return 2; }
      saveConfig(home, { reviewer: { ...cfg, provider, model } });
      const resolved = resolveReviewerModel(loadConfig(home));
      process.stdout.write(`审查模型已设为 ${resolved.provider}:${resolved.model}\n`);
      return 0;
    }
    if (action === "add-rule") {
      const rule = argv.slice(1).join(" ").trim();
      if (!rule) { process.stderr.write("错误：用法：nyra reviewer add-rule <自然语言规则>\n"); return 2; }
      const cfg = reviewerConfig(config);
      saveConfig(home, { reviewer: { ...cfg, rules: [...cfg.rules, rule] } });
      process.stdout.write(`已添加审查规则（共 ${cfg.rules.length + 1} 条）：${rule}\n`);
      return 0;
    }
    if (action === "remove-rule") {
      const n = parseInt(argv[1] ?? "", 10);
      const cfg = reviewerConfig(config);
      if (!Number.isInteger(n) || n < 1 || n > cfg.rules.length) {
        process.stderr.write(`错误：remove-rule 需要 1–${cfg.rules.length} 之间的序号（先 nyra reviewer list-rules 查看）\n`);
        return 2;
      }
      const removed = cfg.rules[n - 1];
      const rules = cfg.rules.filter((_r, i) => i !== n - 1);
      saveConfig(home, { reviewer: { ...cfg, rules } });
      process.stdout.write(`已删除审查规则 ${n}：${removed}\n`);
      return 0;
    }
    if (action === "list-rules") {
      const cfg = reviewerConfig(config);
      if (!cfg.rules.length) { process.stdout.write("没有额外审查规则\n"); return 0; }
      cfg.rules.forEach((r, i) => process.stdout.write(`${i + 1}. ${r}\n`));
      return 0;
    }
    if (action === "check") {
      const tool = get("--tool");
      const argsJson = get("--args") ?? "{}";
      if (!tool) { process.stderr.write("错误：用法：nyra reviewer check --tool <工具> --args '<JSON 对象>' [--task <任务>]\n"); return 2; }
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(argsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        process.stderr.write("错误：--args 必须是 JSON 对象\n");
        return 2;
      }
      const cfg = reviewerConfig(config);
      // 试运行：即使审查层未开启也按开启后的口径审一次（生产上未开启时不审）。
      const verdict = await reviewToolCall({
          config: { ...config, reviewer: { ...cfg, enabled: true } },
          tool, args, task: get("--task") ?? "", recentMessages: [],
          runner: buildReviewerRunner(config, home),
        });
      if (!cfg.enabled) process.stdout.write("（审查层当前未开启，以下是开启后的试运行结果）\n");
      process.stdout.write(`审查结论：${verdict.decision}（${verdict.source}）\n原因：${verdict.reason}\n审查模型：${verdict.reviewerModel ?? "—"}\n`);
      return verdict.decision === "BLOCK" ? 3 : 0;
    }
    process.stderr.write(`错误：未知子命令 reviewer ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：judge（Turnstone 意向验证 judge） ----
async function handleJudge(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra judge <status|enable|disable|set-model|set-thresholds|check|verdicts> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const { judgeConfig, judgeStatus, resolveJudgeModel, buildJudgeRunner, judgeToolCall } = await import("./toolJudge.ts");
    const config = loadConfig(home);
    if (action === "status") {
      const st = judgeStatus(config, home);
      process.stdout.write(`意向验证 judge：${st.enabled ? "启用" : "禁用（默认关闭）"}\n`);
      process.stdout.write(`judge 模型：${st.provider}:${st.model}${st.hasCredentials ? "" : "（无凭证：开启后被审工具会被拒绝，请先配好该模型的凭证）"}\n`);
      process.stdout.write(`被审工具（${st.tools.length}）：${st.tools.join("、")}\n`);
      process.stdout.write(`分段：>= ${st.denyAt} 分拒绝，>= ${st.escalateAt} 分转人工，低于 ${st.escalateAt} 分放行\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const cfg = judgeConfig(config);
      // 显式写全 snake_case 键：解析后的 cfg 用 camelCase（denyAt/escalateAt），
      // 直接 ...cfg 会把 camelCase 键写进文件、下次 set-model 时丢掉分段。
      saveConfig(home, { judge: { enabled: action === "enable", provider: cfg.provider, model: cfg.model, tools: cfg.tools, deny_at: cfg.denyAt, escalate_at: cfg.escalateAt } });
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}意向验证 judge${action === "enable" ? "（敏感工具调用先打风险分，高分拒绝、中段转人工）" : ""}\n`);
      return 0;
    }
    if (action === "set-model") {
      const spec = argv[1];
      if (!spec) { process.stderr.write("错误：用法：nyra judge set-model <provider:模型> 或 <模型>\n"); return 2; }
      const cfg = judgeConfig(config);
      let provider = cfg.provider;
      let model: string | null = cfg.model;
      const idx = spec.indexOf(":");
      if (idx >= 0) {
        provider = spec.slice(0, idx).trim() || null;
        model = spec.slice(idx + 1).trim() || null;
      } else {
        model = spec.trim();
      }
      if (!model) { process.stderr.write("错误：set-model 需要模型名\n"); return 2; }
      saveConfig(home, { judge: { enabled: cfg.enabled, provider, model, tools: cfg.tools, deny_at: cfg.denyAt, escalate_at: cfg.escalateAt } });
      const resolved = resolveJudgeModel(loadConfig(home));
      process.stdout.write(`judge 模型已设为 ${resolved.provider}:${resolved.model}\n`);
      return 0;
    }
    if (action === "set-thresholds") {
      const deny = parseInt(argv[1] ?? "", 10);
      const escalate = parseInt(argv[2] ?? "", 10);
      if (!Number.isInteger(deny) || !Number.isInteger(escalate) || deny < 0 || deny > 100 || escalate < 0 || escalate > 100) {
        process.stderr.write("错误：用法：nyra judge set-thresholds <拒绝线 0-100> <转人工线 0-100>\n");
        return 2;
      }
      if (escalate > deny) {
        process.stderr.write("错误：转人工线不能高于拒绝线\n");
        return 2;
      }
      const cfg = judgeConfig(config);
      saveConfig(home, { judge: { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model, tools: cfg.tools, deny_at: deny, escalate_at: escalate } });
      process.stdout.write(`judge 分段已设为：>= ${deny} 分拒绝，>= ${escalate} 分转人工\n`);
      return 0;
    }
    if (action === "check") {
      const tool = get("--tool");
      const argsJson = get("--args") ?? "{}";
      if (!tool) { process.stderr.write("错误：用法：nyra judge check --tool <工具> --args '<JSON 对象>' [--task <任务>]\n"); return 2; }
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(argsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        process.stderr.write("错误：--args 必须是 JSON 对象\n");
        return 2;
      }
      const cfg = judgeConfig(config);
      // 试运行：即使 judge 未开启也按开启后的口径打一次分（生产上未开启时不审）。
      const verdict = await judgeToolCall({
          config: { ...config, judge: { ...cfg, enabled: true } },
          tool, args, task: get("--task") ?? "", recentMessages: [],
          runner: buildJudgeRunner(config, home),
        });
      if (!cfg.enabled) process.stdout.write("（judge 当前未开启，以下是开启后的试运行结果）\n");
      process.stdout.write(`judge 结论：${verdict.verdict}（风险 ${verdict.riskScore} 分，${verdict.source}）\n证据：${verdict.evidence.length ? verdict.evidence.join("；") : "（无）"}\n原因：${verdict.reason}\njudge 模型：${verdict.judgeModel ?? "—"}\n`);
      return verdict.verdict === "deny" ? 3 : verdict.verdict === "escalate" ? 2 : 0;
    }
    if (action === "verdicts") {
      // 第 2 批 G-P1-12：两层意向验证的结论账本——启发式层 + judge 层一次查。
      // 只记工具名、层、结论、规则、理由、风险分，不记参数原文。
      const { listIntentVerdicts } = await import("./intentVerdict.ts");
      const limitRaw = get("--limit");
      const limit = limitRaw === undefined ? 20 : parseInt(limitRaw, 10);
      const layerRaw = get("--layer");
      const layer = layerRaw === "heuristic" || layerRaw === "judge" ? layerRaw : undefined;
      const decisionRaw = get("--decision");
      const decision = decisionRaw === "allow" || decisionRaw === "escalate" || decisionRaw === "deny" ? decisionRaw : undefined;
      const list = listIntentVerdicts(home, Number.isInteger(limit) && limit > 0 ? limit : 20)
        .filter((v) => !layer || v.layer === layer)
        .filter((v) => !decision || v.decision === decision);
      if (!list.length) {
        process.stdout.write("还没有意向验证结论。\n");
        return 0;
      }
      for (const v of list) {
        process.stdout.write(`${v.at}\t${v.tool}\t${v.layer}\t${v.decision}${v.risk_score !== null ? `（${v.risk_score} 分）` : ""}${v.rule ? ` [${v.rule}]` : ""}\t${v.reason}\n`);
      }
      return 0;
    }
    process.stderr.write(`错误：未知子命令 judge ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：sfu（第 2 批 G-P0-2：群组语音 SFU，本地实现） ----
// 选型定案是 mediasoup（Node 原生库，嵌进单 Node 运行时），但本批不装
// 服务器、不起真 mediasoup 服务：本地 SFU 只做房间 + 成员 + TURN 凭据
// + 录制同意门 + 帧指纹记账（假信令、假媒体、内存转发），真媒体面等
// mediasoup 接线（见 docs/sfu.md 的“待真机验证”）。
async function handleSfu(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra sfu <create|rooms|status|join|leave|turn|record|close|reclaim> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const { SfuRegistry, SFU_MAX_SPEAKERS, SFU_MAX_LISTENERS } = await import("./sfu.ts");
    const registry = new SfuRegistry(home);
    if (action === "create") {
      const room = argv[1];
      if (!room) { process.stderr.write("错误：用法：nyra sfu create <房间 id>\n"); return 2; }
      const r = registry.createRoom({ id: room });
      process.stdout.write(`语音房已建：${r.id}（说话者上限 ${SFU_MAX_SPEAKERS}，听众上限 ${SFU_MAX_LISTENERS}，闲置 60 秒回收；本地实现，不走网络）\n`);
      return 0;
    }
    if (action === "rooms") {
      const rooms = registry.listRooms();
      if (!rooms.length) {
        process.stdout.write("还没有语音房：nyra sfu create <房间 id> 建一个。\n");
        return 0;
      }
      for (const r of rooms) {
        process.stdout.write(`${r.id}\t${r.closed_at ? "已关闭" : "开着"}\t${r.members.length} 人在房\t录制${r.recording ? "开着" : "没开"}\n`);
      }
      return 0;
    }
    if (action === "status") {
      const room = argv[1];
      if (!room) { process.stderr.write("错误：用法：nyra sfu status <房间 id>\n"); return 2; }
      const r = registry.getRoom(room);
      if (!r) { process.stderr.write(`错误：没有这个语音房：${room}\n`); return 1; }
      process.stdout.write(`${r.id} ${r.closed_at ? "已关闭" : "开着"} — 加密 ${r.encryption}\n`);
      process.stdout.write(`成员（${r.members.length}）：\n`);
      for (const m of r.members) {
        process.stdout.write(` ${m.peer}（${m.role}）${m.recording_consented ? " 已同意录制" : ""}\n`);
      }
      process.stdout.write(`录制：${r.recording ? "开着" : "没开"}（全体同意门：房里每个人都同意才开得起来）\n`);
      return 0;
    }
    if (action === "join" || action === "leave") {
      const room = argv[1];
      const peer = argv[2];
      if (!room || !peer) { process.stderr.write(`错误：用法：nyra sfu ${action} <房间 id> <好友名>${action === "join" ? " [--role speaker|listener]" : ""}\n`); return 2; }
      if (action === "join") {
        const role = get("--role");
        if (role && role !== "speaker" && role !== "listener") { process.stderr.write("错误：--role 只认 speaker 或 listener\n"); return 2; }
        registry.joinRoom(room, peer, (role ?? "speaker") as "speaker" | "listener");
        process.stdout.write(`${peer} 已进语音房 ${room}（${role ?? "speaker"}）\n`);
      } else {
        registry.leaveRoom(room, peer);
        process.stdout.write(`${peer} 已离开语音房 ${room}\n`);
      }
      return 0;
    }
    if (action === "turn") {
      const room = argv[1];
      const peer = argv[2];
      if (!room || !peer) { process.stderr.write("错误：用法：nyra sfu turn <房间 id> <好友名> [--ttl <秒>]\n"); return 2; }
      const ttlRaw = get("--ttl");
      const ttl = ttlRaw === undefined ? undefined : parseInt(ttlRaw, 10);
      const cred = registry.issueTurnCredential(room, peer, ttl);
      process.stdout.write(`TURN 凭据（${peer}，房间 ${room}，有效期至 ${cred.expires_at}）：\n用户名：${cred.username}\n密码：${cred.password}\n`);
      return 0;
    }
    if (action === "record") {
      const sub = argv[1];
      const room = argv[2];
      const peer = argv[3] ?? get("--who") ?? undefined;
      if (sub === "consent") {
        if (!room || !peer) { process.stderr.write("错误：用法：nyra sfu record consent <房间 id> <好友名>\n"); return 2; }
        registry.consentRecording(room, peer);
        process.stdout.write(`${peer} 已同意录制（房间 ${room}）\n`);
        return 0;
      }
      if (sub === "start") {
        if (!room) { process.stderr.write("错误：用法：nyra sfu record start <房间 id>\n"); return 2; }
        registry.startRecording(room);
        process.stdout.write(`房间 ${room} 已开录制（全体已同意）\n`);
        return 0;
      }
      if (sub === "stop") {
        if (!room) { process.stderr.write("错误：用法：nyra sfu record stop <房间 id>\n"); return 2; }
        registry.stopRecording(room);
        process.stdout.write(`房间 ${room} 已停录制\n`);
        return 0;
      }
      process.stderr.write("错误：用法：nyra sfu record <consent|start|stop> <房间 id> [<好友名>]\n");
      return 2;
    }
    if (action === "close") {
      const room = argv[1];
      if (!room) { process.stderr.write("错误：用法：nyra sfu close <房间 id> [--reason <原因>]\n"); return 2; }
      const ok = registry.closeRoom(room, get("--reason") ?? "manual");
      process.stdout.write(ok ? `语音房 ${room} 已关闭（帧文件已清，录制文件保留）。\n` : `语音房 ${room} 已经关了（或不存在）。\n`);
      return 0;
    }
    if (action === "reclaim") {
      const reclaimed = registry.reclaimIdleRooms();
      process.stdout.write(reclaimed.length ? `已回收闲置语音房：${reclaimed.join("、")}\n` : "没有闲置超 60 秒的语音房。\n");
      return 0;
    }
    // 第 3 批 G-P0-2 视频部分：群组视频（挂在语音房上；开视频须是房里
    // 说话者，听众只能看）。帧只记指纹，不存视频字节。
    if (action === "video") {
      const { VideoRegistry, simulateVideoSession, VIDEO_ROOM_BUDGET_KBPS } = await import("./groupVideo.ts");
      const video = new VideoRegistry(home);
      const sub = argv[1];
      const room = argv[2];
      const usage = "用法：nyra sfu video <start|stop|list|subscribe|unsubscribe|quality|frames|publish|record|simulate> <房间 id> ...（详见 docs/group-video.md）";
      if (!sub) { process.stderr.write(`错误：${usage}\n`); return 2; }
      if (sub === "publish") {
        const peer = argv[3];
        const payload = argv.slice(4).join(" ");
        if (!room || !peer || !payload) { process.stderr.write("错误：用法：nyra sfu video publish <房间 id> <好友名> <帧内容>（调试用：发一帧视频，只记指纹）\n"); return 2; }
        const frame = video.publishFrame(room, peer, payload);
        process.stdout.write(`已发视频帧 #${frame.seq}（指纹 ${frame.fingerprint}）\n`);
        return 0;
      }
      if (sub === "start") {
        const peer = argv[3];
        if (!room || !peer) { process.stderr.write("错误：用法：nyra sfu video start <房间 id> <好友名> [--kind camera|screen] [--max-kbps <码率>]\n"); return 2; }
        const kind = get("--kind") ?? "camera";
        if (kind !== "camera" && kind !== "screen") { process.stderr.write("错误：--kind 只认 camera 或 screen\n"); return 2; }
        const maxKbpsRaw = get("--max-kbps");
        const maxKbps = maxKbpsRaw === undefined ? undefined : Number(maxKbpsRaw);
        const p = video.startProducer(room, peer, kind as "camera" | "screen", maxKbps);
        process.stdout.write(`${peer} 已在房间 ${room} 开视频（${p.kind}，track ${p.track}，码率上限 ${p.maxKbps} kbps）\n`);
        return 0;
      }
      if (sub === "stop") {
        const peer = argv[3];
        if (!room || !peer) { process.stderr.write("错误：用法：nyra sfu video stop <房间 id> <好友名>\n"); return 2; }
        const ok = video.stopProducer(room, peer);
        process.stdout.write(ok ? `${peer} 的视频已停（订阅它的消费者已一并退订）。\n` : `${peer} 在房间 ${room} 里没开视频。\n`);
        return 0;
      }
      if (sub === "list") {
        if (!room) { process.stderr.write("错误：用法：nyra sfu video list <房间 id>\n"); return 2; }
        const producers = video.listProducers(room);
        const consumers = video.listConsumers(room);
        process.stdout.write(`房间 ${room}：${producers.length} 路视频（房级总带宽上限 ${VIDEO_ROOM_BUDGET_KBPS} kbps）\n`);
        for (const p of producers) process.stdout.write(` ${p.peer}（${p.kind}，track ${p.track}，码率上限 ${p.maxKbps} kbps）\n`);
        for (const c of consumers) process.stdout.write(` ${c.peer} 在看 ${c.producer} 的视频（${c.tier} 档，可用带宽 ${c.availableKbps} kbps）\n`);
        return 0;
      }
      if (sub === "subscribe" || sub === "unsubscribe") {
        const peer = argv[3];
        const producer = argv[4];
        if (!room || !peer || !producer) { process.stderr.write(`错误：用法：nyra sfu video ${sub} <房间 id> <好友名> <发布者>${sub === "subscribe" ? " --kbps <可用带宽>" : ""}\n`); return 2; }
        if (sub === "subscribe") {
          const kbpsRaw = get("--kbps");
          const kbps = kbpsRaw === undefined ? NaN : Number(kbpsRaw);
          if (!Number.isFinite(kbps) || kbps <= 0) { process.stderr.write("错误：订阅须报可用带宽：--kbps <正数>（带宽定档用它）\n"); return 2; }
          const c = video.subscribe(room, peer, producer, kbps);
          process.stdout.write(`${peer} 已订阅 ${producer} 的视频（${c.tier} 档）\n`);
        } else {
          const ok = video.unsubscribe(room, peer, producer);
          process.stdout.write(ok ? `${peer} 已退订 ${producer} 的视频。\n` : `${peer} 没订阅 ${producer} 的视频。\n`);
        }
        return 0;
      }
      if (sub === "quality") {
        const peer = argv[3];
        const producer = argv[4];
        const tier = argv[5];
        if (!room || !peer || !producer || !tier || (tier !== "high" && tier !== "medium" && tier !== "low")) {
          process.stderr.write("错误：用法：nyra sfu video quality <房间 id> <好友名> <发布者> <high|medium|low>\n");
          return 2;
        }
        const c = video.setQuality(room, peer, producer, tier);
        process.stdout.write(`${peer} 看 ${producer} 的视频已改 ${c.tier} 档。\n`);
        return 0;
      }
      if (sub === "frames") {
        const peer = argv[3];
        const producer = argv[4];
        if (!room || !peer || !producer) { process.stderr.write("错误：用法：nyra sfu video frames <房间 id> <好友名> <发布者> [--seq <序号>]\n"); return 2; }
        const seqRaw = get("--seq");
        const seq = seqRaw === undefined ? 0 : Number(seqRaw);
        const frames = video.framesFor(room, peer, producer, Number.isFinite(seq) ? seq : 0);
        if (!frames.length) {
          process.stdout.write("没有新帧（对方没发帧，或你的档位在下采样跳帧）。\n");
          return 0;
        }
        for (const f of frames) process.stdout.write(`#${f.seq}\t指纹 ${f.fingerprint}\t${f.at}\n`);
        return 0;
      }
      if (sub === "record") {
        const verb = argv[3];
        if (!room || (verb !== "start" && verb !== "stop")) { process.stderr.write("错误：用法：nyra sfu video record <start|stop> <房间 id>\n"); return 2; }
        if (verb === "start") {
          video.startVideoRecording(room);
          process.stdout.write(`房间 ${room} 视频录制已开（全体已同意）。\n`);
        } else {
          video.stopVideoRecording(room);
          process.stdout.write(`房间 ${room} 视频录制已停。\n`);
        }
        return 0;
      }
      if (sub === "simulate") {
        const peers = [argv[3], argv[4], argv[5]].filter((p): p is string => !!p);
        if (!room || peers.length !== 3 || argv[6] !== undefined && !argv[6].startsWith("--")) {
          process.stderr.write("错误：用法：nyra sfu video simulate <房间 id> <好友A> <好友B> <好友C> [--seconds <秒>] [--fps <帧率>]\n");
          return 2;
        }
        const secondsRaw = get("--seconds");
        const fpsRaw = get("--fps");
        const seconds = secondsRaw === undefined ? 600 : Number(secondsRaw);
        const fps = fpsRaw === undefined ? 10 : Number(fpsRaw);
        const res = simulateVideoSession(home, room, peers, seconds, { fps });
        process.stdout.write(`模拟 ${res.seconds} 秒：发帧 ${res.framesPublished}、投递 ${res.framesDelivered}、按档下采样 ${res.framesDroppedByTier}、Producer 存活 ${res.producersAlive}、房间${res.roomOpen ? "还开着" : "已关闭"}。\n`);
        if (!res.roomOpen || res.producersAlive !== 3) {
          process.stderr.write("模拟失败：房间被回收或 Producer 掉了。\n");
          return 1;
        }
        return 0;
      }
      process.stderr.write(`错误：${usage}\n`);
      return 2;
    }
    process.stderr.write(`错误：未知子命令 sfu ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：meeting（第 3 批：进外部会议 Meet/Zoom） ----
// CLI 是单进程：进会即听 N 秒后离会出纪要（--listen，默认 60 秒）；
// 常驻听会走网关/daemon，不在本批。进会、录制、发言都要机主批。
async function handleMeeting(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra meeting <create|list|join|reconnect|transcript|minutes|record|dispatch> [选项]（详见 docs/meeting.md）\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  try {
    const { createMeeting, listMeetings, joinMeeting, reconnectMeeting, leaveMeeting, listenMeeting, addTranscriptLine, buildMinutes, consentMeetingRecording, startMeetingRecording, dispatchMeetingAction, getMeeting } = await import("./meeting.ts");
    if (action === "create") {
      const url = argv[1];
      if (!url) { process.stderr.write("错误：用法：nyra meeting create <会议链接>（只认 meet.google.com 与 zoom.us）\n"); return 2; }
      const s = createMeeting(home, url);
      process.stdout.write(`会议已建：${s.id}（${s.provider}，${s.url}）\n进会：nyra meeting join ${s.id} --yes --listen <秒>\n`);
      return 0;
    }
    if (action === "list") {
      const list = listMeetings(home);
      if (!list.length) {
        process.stdout.write("还没有会议：nyra meeting create <会议链接> 建一场。\n");
        return 0;
      }
      for (const s of list) {
        process.stdout.write(`${s.id}\t${s.provider}\t${s.status}\t纪元 ${s.epoch}\t${s.transcript.length} 行字幕\t${s.url}\n`);
      }
      return 0;
    }
    if (action === "join" || action === "reconnect") {
      const id = argv[1];
      if (!id) { process.stderr.write(`错误：用法：nyra meeting ${action} <会议 id> --yes [--as <名字>] [--listen <秒>] [--record]\n`); return 2; }
      if (!has("--yes")) { process.stderr.write("进外部会议须机主批准：请加 --yes\n"); return 2; }
      const listenRaw = get("--listen");
      const listenSeconds = listenRaw === undefined ? 60 : Number(listenRaw);
      if (!Number.isFinite(listenSeconds) || listenSeconds < 0 || listenSeconds > 3600) {
        process.stderr.write("错误：--listen 只能是 0–3600 秒\n");
        return 2;
      }
      const opts = { approved: true, as: get("--as") ?? undefined };
      const session = action === "join" ? await joinMeeting(home, id, opts) : await reconnectMeeting(home, id, opts);
      process.stdout.write(`已进会：${id}（${session.provider}，纪元 ${session.epoch}）\n`);
      const page = session.__page;
      if (!page) {
        process.stderr.write("错误：进会后没拿到页面句柄，没法听字幕。\n");
        return 1;
      }
      if (has("--record")) {
        try {
          startMeetingRecording(home, id);
          process.stdout.write("录制已开（全体已同意）。\n");
        } catch (e) {
          process.stderr.write(`录制开不了：${e instanceof Error ? e.message : String(e)}\n`);
          await leaveMeeting(home, id, page);
          return 1;
        }
      }
      const deadline = Date.now() + listenSeconds * 1000;
      while (Date.now() < deadline) {
        const line = await listenMeeting(home, id, page);
        if (line) process.stdout.write(`[${line.speaker}] ${line.text}\n`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      await leaveMeeting(home, id, page);
      const minutes = buildMinutes(home, id);
      process.stdout.write(`已离会。纪要：${minutes.turns} 轮，决定 ${minutes.decisions.length} 条，待办 ${minutes.actions.length} 条。\n`);
      for (const d of minutes.decisions) process.stdout.write(`决定：${d}\n`);
      for (const a of minutes.actions) process.stdout.write(`待办：${a}\n`);
      return 0;
    }
    if (action === "transcript") {
      const sub = argv[1];
      const id = argv[2];
      if (sub === "add") {
        const speaker = argv[3];
        const text = argv.slice(4).join(" ");
        if (!id || !speaker || !text) { process.stderr.write("错误：用法：nyra meeting transcript add <会议 id> <说话人> <文字>\n"); return 2; }
        const line = addTranscriptLine(home, id, speaker, text);
        process.stdout.write(`已记字幕 #${line.key.split(":").pop()}（${line.speaker}，纪元 ${line.epoch}）\n`);
        return 0;
      }
      if (sub === "list" || !sub) {
        if (!id) { process.stderr.write("错误：用法：nyra meeting transcript list <会议 id>\n"); return 2; }
        const s = getMeeting(home, id);
        if (!s) { process.stderr.write(`错误：没有这场会议：${id}\n`); return 1; }
        if (!s.transcript.length) {
          process.stdout.write("还没有字幕。\n");
          return 0;
        }
        for (const l of s.transcript) process.stdout.write(`[${l.speaker}] ${l.text}（纪元 ${l.epoch}，${l.at}）\n`);
        return 0;
      }
      process.stderr.write("错误：用法：nyra meeting transcript <add|list> <会议 id> ...\n");
      return 2;
    }
    if (action === "minutes") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra meeting minutes <会议 id>\n"); return 2; }
      const minutes = buildMinutes(home, id);
      process.stdout.write(`会议 ${minutes.meeting}（${minutes.provider}）：参会 ${minutes.participants.join("、") || "（未知）"}，${minutes.turns} 轮\n`);
      for (const d of minutes.decisions) process.stdout.write(`决定：${d}\n`);
      for (const a of minutes.actions) process.stdout.write(`待办：${a}\n`);
      return 0;
    }
    if (action === "record") {
      const sub = argv[1];
      const id = argv[2];
      if (sub === "consent") {
        const who = argv[3];
        if (!id || !who) { process.stderr.write("错误：用法：nyra meeting record consent <会议 id> <名字>\n"); return 2; }
        consentMeetingRecording(home, id, who);
        process.stdout.write(`${who} 已同意录制（会议 ${id}）\n`);
        return 0;
      }
      if (sub === "start") {
        if (!id) { process.stderr.write("错误：用法：nyra meeting record start <会议 id>\n"); return 2; }
        startMeetingRecording(home, id);
        process.stdout.write(`会议 ${id} 录制已开（全体已同意）。\n`);
        return 0;
      }
      process.stderr.write("错误：用法：nyra meeting record <consent|start> <会议 id> [<名字>]\n");
      return 2;
    }
    if (action === "dispatch") {
      const id = argv[1];
      const yesIdx = argv.indexOf("--yes");
      const text = argv.slice(2).filter((_, i) => i + 2 !== yesIdx).join(" ");
      if (!id || !text) { process.stderr.write("错误：用法：nyra meeting dispatch <会议 id> <待办文字> --yes\n"); return 2; }
      if (!has("--yes")) { process.stderr.write("派发待办须机主批准：请加 --yes\n"); return 2; }
      const res = await dispatchMeetingAction(home, id, text, async (a) => {
        const { enqueueTask } = await import("./workQueue.ts");
        return enqueueTask(home, `meeting:${id}`, a).id;
      });
      if (!res.dispatched) {
        process.stdout.write(`没派发：${res.reason}\n`);
        return 0;
      }
      process.stdout.write(`已派发进任务队列：${res.taskId}（${text}）\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 meeting ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：rendezvous（第 3 批 G-P1-13：Rendezvous 多节点路由） ----
async function handleRendezvous(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra rendezvous <register|nodes|route|status|remove|epoch> [选项]（详见 docs/mesh.md）\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  try {
    const { registerNode, listNodes, routeKey, setNodeStatus, removeNode, rendezvousEpoch } = await import("./rendezvous.ts");
    if (action === "register") {
      const id = argv[1];
      const endpoint = argv[2];
      if (!id || !endpoint) { process.stderr.write("错误：用法：nyra rendezvous register <节点 id> <端点> [--weight <权重>]（只认本机/局域网端点）\n"); return 2; }
      const weightRaw = get("--weight");
      const weight = weightRaw === undefined ? 1 : Number(weightRaw);
      const node = registerNode(home, id, endpoint, weight);
      process.stdout.write(`节点已登记：${node.id}（${node.endpoint}，权重 ${node.weight}，active）\n`);
      return 0;
    }
    if (action === "nodes") {
      const nodes = listNodes(home);
      if (!nodes.length) {
        process.stdout.write("还没登记节点：nyra rendezvous register <节点 id> <端点>\n");
        return 0;
      }
      for (const n of nodes) process.stdout.write(`${n.id}\t${n.endpoint}\t权重 ${n.weight}\t${n.status}\n`);
      return 0;
    }
    if (action === "route") {
      const key = argv[1];
      if (!key) { process.stderr.write("错误：用法：nyra rendezvous route <任务 key>\n"); return 2; }
      const node = routeKey(home, key);
      process.stdout.write(`任务 ${key} 路由到节点 ${node.id}（${node.endpoint}）\n`);
      return 0;
    }
    if (action === "status") {
      const id = argv[1];
      const status = argv[2];
      if (!id || !status || (status !== "active" && status !== "drained" && status !== "offline")) {
        process.stderr.write("错误：用法：nyra rendezvous status <节点 id> <active|drained|offline>\n");
        return 2;
      }
      const node = setNodeStatus(home, id, status);
      process.stdout.write(`节点 ${node.id} 已改为 ${node.status}（纪元 +1，旧路由作废）。\n`);
      return 0;
    }
    if (action === "remove") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra rendezvous remove <节点 id> --yes\n"); return 2; }
      if (!has("--yes")) { process.stderr.write("移除节点须加 --yes 确认\n"); return 2; }
      const ok = removeNode(home, id);
      process.stdout.write(ok ? `节点 ${id} 已移除（纪元 +1）。\n` : `没有这个节点：${id}\n`);
      return 0;
    }
    if (action === "epoch") {
      process.stdout.write(`当前 Rendezvous 纪元：${rendezvousEpoch(home)}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 rendezvous ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：queue（第 3 批 G-P1-13：队列驱动底座） ----
async function handleQueue(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra queue <enqueue|list|show|claim|complete|fail> [选项]（详见 docs/mesh.md）\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const { enqueueTask, listTasks, getTask, claimTask, completeTask, failTask } = await import("./workQueue.ts");
    if (action === "enqueue") {
      const key = argv[1];
      const idemIdx = argv.indexOf("--idem");
      const payload = argv.slice(2).filter((_, i) => i + 2 !== idemIdx && i + 2 !== idemIdx + 1).join(" ");
      if (!key || !payload) { process.stderr.write("错误：用法：nyra queue enqueue <路由 key> <载荷描述> [--idem <幂等键>]\n"); return 2; }
      const task = enqueueTask(home, key, payload, get("--idem") ?? undefined);
      process.stdout.write(`任务已入队：${task.id}（key ${task.key}，幂等键 ${task.idempotency_key}，纪元 ${task.epoch}）\n`);
      return 0;
    }
    if (action === "list") {
      const statusRaw = get("--status");
      const status = statusRaw === "queued" || statusRaw === "claimed" || statusRaw === "completed" || statusRaw === "failed" ? statusRaw : undefined;
      if (statusRaw && !status) { process.stderr.write("错误：--status 只认 queued|claimed|completed|failed\n"); return 2; }
      const tasks = listTasks(home, status);
      if (!tasks.length) {
        process.stdout.write("队列里没有任务。\n");
        return 0;
      }
      for (const t of tasks) {
        process.stdout.write(`${t.id}\t${t.key}\t${t.status}\t${t.node ?? "未派"}\t重试 ${t.retries}\t${t.created_at}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra queue show <任务 id>\n"); return 2; }
      const t = getTask(home, id);
      if (!t) { process.stderr.write(`错误：没有这个任务：${id}\n`); return 1; }
      process.stdout.write(
        `${t.id}\n`
        + `路由 key：${t.key}\n`
        + `载荷摘要：${t.payload_hash}\n`
        + `幂等键：${t.idempotency_key}\n`
        + `状态：${t.status}\n`
        + `节点：${t.node ?? "未派"}${t.lease_until ? `（租约至 ${t.lease_until}）` : ""}\n`
        + `纪元：${t.epoch} · 重试：${t.retries}\n`,
      );
      return 0;
    }
    if (action === "claim") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra queue claim <任务 id> [--lease <毫秒>]\n"); return 2; }
      const leaseRaw = get("--lease");
      const leaseMs = leaseRaw === undefined ? undefined : Number(leaseRaw);
      const t = claimTask(home, id, { leaseMs });
      process.stdout.write(`任务 ${t.id} 已认领：节点 ${t.node}，租约至 ${t.lease_until}\n租约令牌（只显示这一次，完成/标失败时凭它认领）：${t.lease_token}\n`);
      return 0;
    }
    if (action === "complete" || action === "fail") {
      const id = argv[1];
      const node = get("--node");
      const token = get("--token");
      if (!id || !node || !token) { process.stderr.write(`错误：用法：nyra queue ${action} <任务 id> --node <节点> --token <租约令牌>\n`); return 2; }
      const t = action === "complete" ? completeTask(home, id, node, token) : failTask(home, id, node, token);
      process.stdout.write(`任务 ${t.id} 已${action === "complete" ? "完成" : t.status === "failed" ? "标失败（重试已用完）" : "标失败，已重回队列待重派"}。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 queue ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：group（第 2 批 G-P1-1 群组计划 + G-P1-2 swarm 群聊） ----
// 房间与机器人沿用第 1 批的 GroupStore（网关同一套）；计划步骤的执行者
// 是真实 agent（在步骤的隔离 worktree 里跑），验收走 completePlanStep
// 的独立验收（确定性检查 + 逐项核验收项，执行者自己说了不算）。
async function handleGroupChat(argv: string[], home: string, args: CliArgs): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra group <room|chat|plan> ...（nyra group room --help / nyra group chat --help / nyra group plan --help 看细分用法）\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
  };
  try {
    const { GroupStore } = await import("./groups.ts");
    const store = new GroupStore(join(home, "groups"), { home });
    if (action === "room") {
      const sub = argv[1];
      if (sub === "create") {
        const roomId = argv[2];
        const name = argv[3];
        const bots = getAll("--bot");
        if (!roomId || !name || !bots.length) {
          process.stderr.write("错误：用法：nyra group room create <房间 id> <名字> --bot <机器人 id> [--bot <机器人 id> ...]（每个机器人用默认模型跑，说明走默认提示词）\n");
          return 2;
        }
        const created = store.create(roomId, name, bots.map((id) => ({
          id,
          name: id,
          role: "群聊成员",
          instructions: `你是群聊里的机器人 ${id}。按群聊里的讨论发言；被 @ 到或被交接时回应；分工任务完成时说一声“完成”并写清你做了什么。`,
        })));
        process.stdout.write(`群聊已建：${created.id}（${created.name}），机器人：${created.bots.map((b) => b.id).join("、")}\n`);
        return 0;
      }
      if (sub === "list" || !sub) {
        const rooms = store.listRooms();
        if (!rooms.length) {
          process.stdout.write("还没有群聊：nyra group room create 建一个。\n");
          return 0;
        }
        for (const r of rooms) {
          process.stdout.write(`${r.id}\t${r.name}\t${r.bots} 个机器人\t${r.messages} 条消息\n`);
        }
        return 0;
      }
      if (sub === "show") {
        const roomId = argv[2];
        if (!roomId) { process.stderr.write("错误：用法：nyra group room show <房间 id>\n"); return 2; }
        const room = store.get(roomId);
        process.stdout.write(`${room.id} — ${room.name}\n机器人：${room.bots.map((b) => b.id).join("、")}\n`);
        for (const m of room.messages.slice(-20)) {
          process.stdout.write(`[${m.sender}] ${m.content.slice(0, 200)}\n`);
        }
        return 0;
      }
      process.stderr.write("错误：用法：nyra group room <create|list|show> ...\n");
      return 2;
    }
    if (action === "chat") {
      const sub = argv[1];
      if (sub === "run") {
        const roomId = argv[2];
        const task = get("--task");
        if (!roomId || !task) {
          process.stderr.write("错误：用法：nyra group chat run <房间 id> --task <任务> [--mode round-robin|selector|handoff] [--max-messages <轮数>] [--mention-text <文本>] [--timeout-ms <毫秒>]\n");
          return 2;
        }
        const modeRaw = get("--mode");
        const mode = modeRaw === "selector" || modeRaw === "handoff" ? modeRaw : "round-robin";
        const maxMessagesRaw = get("--max-messages");
        const maxMessages = maxMessagesRaw === undefined ? undefined : parseInt(maxMessagesRaw, 10);
        const timeoutRaw = get("--timeout-ms");
        const timeoutMs = timeoutRaw === undefined ? undefined : parseInt(timeoutRaw, 10);
        const mentionText = get("--mention-text");
        const { runGroupChat } = await import("./groupChat.ts");
        // 终止条件可组合：给了多个就 AND 起来（都满足才停）；只给一个就用它。
        const conditions: import("./groupChat.ts").TerminationCondition[] = [];
        if (maxMessages !== undefined && Number.isInteger(maxMessages)) conditions.push({ kind: "max-messages", max: maxMessages });
        if (mentionText) conditions.push({ kind: "mention-text", text: mentionText });
        if (timeoutMs !== undefined && Number.isInteger(timeoutMs)) conditions.push({ kind: "timeout", timeoutMs });
        const termination = conditions.length === 0
          ? undefined
          : conditions.length === 1
            ? conditions[0]
            : { kind: "and" as const, conditions };
        const result = await runGroupChat(store, roomId, {
          mode,
          kickoff: task,
          ...(termination ? { termination } : {}),
        });
        for (const t of result.turns) {
          process.stdout.write(`[${t.speaker}] ${t.message.content}\n`);
        }
        process.stdout.write(`—— ${result.turns.length} 轮，终止原因：${result.terminatedBy}（${result.reason}）\n`);
        return 0;
      }
      if (sub === "send") {
        const roomId = argv[2];
        const message = argv.slice(3).join(" ").trim();
        if (!roomId || !message) {
          process.stderr.write("错误：用法：nyra group chat send <房间 id> <消息> [--rounds <轮数>]\n");
          return 2;
        }
        const roundsRaw = get("--rounds");
        const rounds = roundsRaw === undefined ? 1 : parseInt(roundsRaw, 10);
        const res = await store.send(roomId, message, Number.isInteger(rounds) ? rounds : 1);
        for (const m of res.messages) {
          process.stdout.write(`[${m.sender}] ${m.content}\n`);
        }
        return 0;
      }
      process.stderr.write("错误：用法：nyra group chat <run|send> ...\n");
      return 2;
    }
    if (action === "plan") {
      const sub = argv[1];
      const planMod = await import("./groupPlan.ts");
      if (sub === "create") {
        const roomId = argv[2];
        const title = get("--title");
        const stepTitle = get("--step-title");
        const assignee = get("--assignee");
        const acceptance = getAll("--accept");
        if (!roomId || !title || !stepTitle || !assignee || !acceptance.length) {
          process.stderr.write("错误：用法：nyra group plan create <房间 id> --title <标题> --step-title <第一步标题> --assignee <负责人> --accept <验收项> [--accept <验收项> ...] [--workdir <目录>]（计划至少要有一条步骤，每步都要有负责人与验收项；更多步骤用 add-step 加）\n");
          return 2;
        }
        const plan = planMod.createGroupPlan(home, {
          roomId,
          title,
          workdir: get("--workdir") ?? resolve(args.workdir),
          steps: [{ title: stepTitle, assignee, acceptance }],
        });
        process.stdout.write(`群组计划已建：${plan.id}（${plan.title}，1 步）——更多步骤用 nyra group plan add-step 加。\n`);
        return 0;
      }
      if (sub === "add-step") {
        const planId = argv[2];
        const title = get("--title");
        const assignee = get("--assignee");
        const acceptance = getAll("--accept");
        if (!planId || !title || !assignee || !acceptance.length) {
          process.stderr.write("错误：用法：nyra group plan add-step <计划 id> --title <标题> --assignee <负责人> --accept <验收项> [--accept <验收项> ...]\n");
          return 2;
        }
        const step = planMod.addPlanStep(home, planId, { title, assignee, acceptance });
        process.stdout.write(`步骤已加：${step.id}（${step.title}，负责人 ${step.assignee}，验收 ${step.acceptance.length} 项）\n`);
        return 0;
      }
      if (sub === "list" || !sub) {
        const roomId = argv[2] ?? undefined;
        const plans = planMod.listGroupPlans(home, roomId);
        if (!plans.length) {
          process.stdout.write("还没有群组计划：nyra group plan create 建一个。\n");
          return 0;
        }
        for (const p of plans) {
          process.stdout.write(`${p.id}\t${p.status}\t${p.title}\t${p.steps.length} 步\t房间 ${p.room_id}\n`);
        }
        return 0;
      }
      if (sub === "show") {
        const planId = argv[2];
        if (!planId) { process.stderr.write("错误：用法：nyra group plan show <计划 id>\n"); return 2; }
        const plan = planMod.getGroupPlan(home, planId);
        if (!plan) { process.stderr.write(`错误：没有这个计划：${planId}\n`); return 1; }
        process.stdout.write(`${plan.id} ${plan.status} — ${plan.title}（房间 ${plan.room_id}，工作目录 ${plan.workdir}）\n`);
        for (const s of plan.steps) {
          process.stdout.write(` ${s.id} [${s.status}] ${s.title}（负责人 ${s.assignee}）\n`);
          for (const a of s.acceptance) process.stdout.write(`   验收：${a}\n`);
          if (s.worktree) process.stdout.write(`   隔离：${s.worktree_kind === "git" ? `worktree ${s.worktree_branch}` : "空目录"} ${s.worktree}\n`);
          if (s.note) process.stdout.write(`   备注：${s.note}\n`);
        }
        return 0;
      }
      if (sub === "start") {
        const planId = argv[2];
        if (!planId) { process.stderr.write("错误：用法：nyra group plan start <计划 id>\n"); return 2; }
        const plan = planMod.getGroupPlan(home, planId);
        if (!plan) { process.stderr.write(`错误：没有这个计划：${planId}\n`); return 1; }
        const result = await planMod.runGroupPlan(home, planId, {
          runStep: async (step, worktree) => {
            const workdir = worktree ?? plan.workdir;
            const built = await buildAgent({ ...args, workdir, task: "" }, {
              interactive: false,
              agentId: step.assignee,
              soulAgent: step.assignee,
            });
            const acceptanceLines = step.acceptance.map((a, i) => `acc-${i + 1}：${a}`).join("\n");
            const stepTask = `你是群组计划「${plan.title}」里「${step.title}」这一步的负责人（${step.assignee}）。\n在当前工作目录（隔离 worktree）里完成这一步，不要碰目录以外的文件。\n验收项：\n${acceptanceLines}\n收尾时逐项写验收结论，每行一格式：验收 acc-N：通过/未通过——证据（一行一项，没把握的写未通过，不要编证据）。`;
            const summary = await built.agent.run(stepTask);
            // 改动文件：git worktree 时读 porcelain，没 git 时数目录里的文件。
            let changedFiles: string[] = [];
            let diffStat: string | null = null;
            try {
              const { spawnSync } = await import("node:child_process");
              const st = spawnSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf-8", windowsHide: true });
              if (st.status === 0) {
                changedFiles = (st.stdout ?? "").split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
                const ds = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd: workdir, encoding: "utf-8", windowsHide: true });
                diffStat = (ds.stdout ?? "").trim() || null;
              } else {
                const { readdirSync, statSync } = await import("node:fs");
                const walk = (dir: string, base: string): string[] => {
                  const out: string[] = [];
                  for (const e of readdirSync(dir)) {
                    if (e === ".git") continue;
                    const p = join(dir, e);
                    if (statSync(p).isDirectory()) out.push(...walk(p, `${base}${e}/`));
                    else out.push(`${base}${e}`);
                  }
                  return out;
                };
                changedFiles = walk(workdir, "");
              }
            } catch { /* 改动清单读失败时按空交（确定性检查会拦下） */ }
            const checks = step.acceptance.map((_, i) => {
              const id = `acc-${i + 1}`;
              const m = summary.match(new RegExp(`验收 ${id}：(通过|未通过)[——-]\\s*(.*)`, "m"));
              if (!m) return { checkId: id, pass: false, evidence: "" };
              return { checkId: id, pass: m[1] === "通过", evidence: (m[2] ?? "").trim().slice(0, 500) };
            });
            return { summary, changedFiles, diffStat, checks };
          },
        });
        process.stdout.write(`计划 ${result.plan.id}：${result.plan.status}（跑了 ${result.stepsRun} 步）${result.failedStepId ? `——失败在 ${result.failedStepId}：${result.failedReason}` : "——全部步骤通过"}\n`);
        return result.failedStepId ? 1 : 0;
      }
      process.stderr.write("错误：用法：nyra group plan <create|add-step|list|show|start> ...\n");
      return 2;
    }
    process.stderr.write(`错误：未知子命令 group ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：skills（缺口 11：技能自沉淀闭环） ----
// 起草是确定性的（只从运行记录提取，不调模型）；安装永远要人批准；
// 低质草稿出生即归档，已装技能长期没人用由 sweep 归档。手动 draft 不依赖
// 自动沉淀开关（显式的人工动作）；自动起草只在开关开启时由 RunRecorder 收尾钩子触发。
async function handleSkills(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra skills <status|enable|disable|draft|drafts|show|approve|reject|archive|sweep> [选项]\n");
    return 2;
  }
  try {
    const mod = await import("./skillDrafts.ts");
    const { loadSkillUsage } = await import("./skillUsage.ts");
    const config = loadConfig(home);
    const store = new RunStore(join(home, "runs"));
    if (action === "status") {
      const cfg = mod.skillSedimentationConfig(config);
      const drafts = mod.listDrafts(home);
      const pending = drafts.filter((d) => d.status === "pending").length;
      const installed = drafts.filter((d) => d.status === "installed").length;
      const archived = drafts.filter((d) => d.status === "archived").length;
      const usage = loadSkillUsage(home);
      process.stdout.write(`技能自沉淀：${cfg.enabled ? "启用" : "禁用（默认关闭）"}\n`);
      process.stdout.write(`起草门槛：每次运行至少 ${cfg.min_steps} 次工具调用；只让已验证的运行沉淀：${cfg.require_verified ? "是" : "否"}；长期不用归档：${cfg.auto_archive_days} 天\n`);
      process.stdout.write(`草稿：待批准 ${pending} 个、已安装 ${installed} 个、已归档 ${archived} 个（共 ${drafts.length} 个）\n`);
      process.stdout.write(`用量账本：${Object.keys(usage).length} 个技能有使用记录\n`);
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const cfg = mod.skillSedimentationConfig(config);
      saveConfig(home, { skill_sedimentation: { ...cfg, enabled: action === "enable" } });
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}技能自沉淀${action === "enable" ? "（成功运行收尾时自动起草技能草稿；安装仍须人工批准）" : ""}\n`);
      return 0;
    }
    if (action === "draft") {
      const runId = argv[1];
      if (!runId) { process.stderr.write("错误：用法：nyra skills draft <运行 ID>\n"); return 2; }
      const { draft, reason } = mod.draftSkillFromRun(store, runId, { home, config });
      if (!draft) {
        process.stderr.write(`起草不了：${reason}\n`);
        return 1;
      }
      if (draft.status === "archived") {
        process.stdout.write(`草稿 ${draft.name} 已自动归档：${draft.archive_reason ?? ""}\n`);
        return 0;
      }
      process.stdout.write(`已起草技能草稿 ${draft.name}（来源运行 ${runId}，质量分 ${draft.quality.score}）\n`);
      process.stdout.write(`先通读一遍再批准：nyra skills show ${draft.name}；批准安装：nyra skills approve ${draft.name}\n`);
      return 0;
    }
    if (action === "drafts") {
      const drafts = mod.listDrafts(home);
      if (!drafts.length) { process.stdout.write("还没有技能草稿（先开启沉淀跑一次成功任务，或 nyra skills draft <运行 ID> 手动起草）\n"); return 0; }
      for (const d of drafts) {
        process.stdout.write(`  ${d.name}  ${d.status}  质量分 ${d.quality.score}  来源 ${d.source_run_id}  ${d.created_at.slice(0, 10)}${d.archive_reason ? `  ${d.archive_reason}` : ""}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：用法：nyra skills show <草稿名>\n"); return 2; }
      const found = mod.findDraft(home, name);
      if (!found) { process.stderr.write(`错误：没有名为 ${name} 的技能草稿\n`); return 1; }
      const path = join(mod.skillDraftsDir(home), `${name}.md`);
      if (!existsSync(path)) { process.stderr.write(`错误：草稿文件丢了：${path}\n`); return 1; }
      process.stdout.write(readFileSync(path, "utf-8"));
      return 0;
    }
    if (action === "approve") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：用法：nyra skills approve <草稿名>\n"); return 2; }
      const { installedPath } = mod.approveDraft(home, name, store);
      process.stdout.write(`已批准并安装技能 ${name} 到 ${installedPath}（下次同类任务会自动匹配）\n`);
      return 0;
    }
    if (action === "reject") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：用法：nyra skills reject <草稿名>\n"); return 2; }
      mod.rejectDraft(home, name, store);
      process.stdout.write(`已拒绝草稿 ${name}（文件保留备查）\n`);
      return 0;
    }
    if (action === "archive") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：用法：nyra skills archive <草稿名>\n"); return 2; }
      const reason = argv.slice(2).join(" ").trim();
      mod.archiveDraft(home, name, reason, store);
      process.stdout.write(`已归档草稿 ${name}${reason ? `（${reason}）` : ""}\n`);
      return 0;
    }
    if (action === "sweep") {
      const dryRun = argv.includes("--dry-run");
      const result = mod.sweepStaleSkills(home, { config, dryRun });
      if (!result.archived.length) {
        process.stdout.write(`没有要归档的技能（已装技能 ${result.kept} 个都在 ${mod.skillSedimentationConfig(config).auto_archive_days} 天内用过或改过）\n`);
        return 0;
      }
      for (const a of result.archived) {
        process.stdout.write(`  ${dryRun ? "将归档" : "已归档"} ${a.name}：${a.reason}\n`);
      }
      if (dryRun) process.stdout.write("（演练，未实际归档；去掉 --dry-run 真正执行）\n");
      return 0;
    }
    process.stderr.write(`错误：未知子命令 skills ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：bughunt（候选提案 1：授权漏洞挖掘技能包） ----
async function handleBughunt(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra bughunt <install|status|scope|template|check> [选项]\n");
    return 2;
  }
  try {
    const mod = await import("./bughunt.ts");
    const config = loadConfig(home);
    if (action === "install") {
      const force = argv.includes("--force");
      const { path, overwritten } = mod.installBughuntSkill(home, { force });
      process.stdout.write(`已${overwritten ? "覆盖安装" : "安装"}授权漏洞挖掘技能包：${path}\n`);
      process.stdout.write("技能只在授权目标上用：先建范围卡（nyra bughunt scope add），再动手。\n");
      return 0;
    }
    if (action === "status") {
      const scopes = mod.listScopes(home);
      const { reviewerEnabled } = await import("./reviewer.ts");
      process.stdout.write(`技能包：${mod.bughuntSkillInstalled(home) ? "已安装（~/.nyra/skills/authorized-bughunt.md）" : "未安装（nyra bughunt install）"}\n`);
      process.stdout.write(`范围卡：${scopes.length} 个${scopes.length ? `（${scopes.map((s: { name: string }) => s.name).join("、")}）` : "（先建卡再动手）"}\n`);
      process.stdout.write(`独立审查层：${reviewerEnabled(config) ? "已开启（提交前核对最后过一遍审查）" : "未开启（只走五道确定性门；nyra reviewer enable 开启）"}\n`);
      return 0;
    }
    if (action === "scope") {
      const sub = argv[1];
      if (sub === "list") {
        const scopes = mod.listScopes(home);
        if (!scopes.length) { process.stdout.write("还没有范围卡（nyra bughunt template scope 取模板，建好后 scope add）\n"); return 0; }
        for (const s of scopes) {
          process.stdout.write(`- ${s.name}：${s.platform}，目标 ${s.targets.length} 个，速率上限 ${s.max_requests_per_second}/秒${s.expires_at ? `，到期 ${s.expires_at}` : ""}\n`);
        }
        return 0;
      }
      if (sub === "add") {
        const file = argv[2];
        if (!file) { process.stderr.write("错误：用法：nyra bughunt scope add <范围卡.json>\n"); return 2; }
        const card = mod.parseScopeCard(readFileSync(file, "utf-8"));
        mod.addScope(home, card);
        process.stdout.write(`已建范围卡 ${card.name}（${card.platform}，目标 ${card.targets.join("、")}，速率上限 ${card.max_requests_per_second}/秒）\n`);
        return 0;
      }
      if (sub === "remove") {
        const name = argv[2];
        if (!name) { process.stderr.write("错误：用法：nyra bughunt scope remove <范围卡名>\n"); return 2; }
        if (!mod.removeScope(home, name)) { process.stderr.write(`错误：没有叫 ${name} 的范围卡\n`); return 1; }
        process.stdout.write(`已删范围卡 ${name}\n`);
        return 0;
      }
      if (sub === "show") {
        const name = argv[2];
        if (!name) { process.stderr.write("错误：用法：nyra bughunt scope show <范围卡名>\n"); return 2; }
        const card = mod.findScope(home, name);
        if (!card) { process.stderr.write(`错误：没有叫 ${name} 的范围卡\n`); return 1; }
        process.stdout.write(JSON.stringify(card, null, 2) + "\n");
        return 0;
      }
      if (sub === "check") {
        const url = argv[2];
        if (!url) { process.stderr.write("错误：用法：nyra bughunt scope check <URL> [--scope <范围卡名>]\n"); return 2; }
        const scopeIdx = argv.indexOf("--scope");
        const scopeName = scopeIdx !== -1 ? argv[scopeIdx + 1] : undefined;
        let card = scopeName ? mod.findScope(home, scopeName) : null;
        if (scopeName && !card) { process.stderr.write(`错误：没有叫 ${scopeName} 的范围卡\n`); return 1; }
        if (!card) {
          const scopes = mod.listScopes(home);
          if (scopes.length === 0) { process.stderr.write("错误：还没有范围卡（先建卡再查目标）\n"); return 1; }
          if (scopes.length > 1) { process.stderr.write("错误：有多张范围卡，请用 --scope 指定一张\n"); return 2; }
          card = scopes[0];
        }
        const result = mod.checkTarget(card, url);
        process.stdout.write(`${result.inScope ? "在范围内" : "不在范围内"}：${result.reason}\n`);
        return result.inScope ? 0 : 3;
      }
      process.stdout.write("用法：nyra bughunt scope <list|add <文件>|remove <名>|show <名>|check <URL> [--scope <名>]>\n");
      return 2;
    }
    if (action === "template") {
      const kind = argv[1];
      if (kind === "scope") { process.stdout.write(mod.scopeCardTemplate()); return 0; }
      if (kind === "finding") { process.stdout.write(mod.findingTemplate()); return 0; }
      if (kind === "report") { process.stdout.write(mod.reportTemplate()); return 0; }
      process.stdout.write("用法：nyra bughunt template <scope|finding|report>\n");
      return 2;
    }
    if (action === "check") {
      const findingIdx = argv.indexOf("--finding");
      const findingFile = findingIdx !== -1 ? argv[findingIdx + 1] : undefined;
      if (!findingFile) { process.stderr.write("错误：用法：nyra bughunt check --finding <发现.json> [--report <报告.md>]\n"); return 2; }
      const finding = mod.parseFinding(readFileSync(findingFile, "utf-8"));
      const reportIdx = argv.indexOf("--report");
      const reportFile = reportIdx !== -1 ? argv[reportIdx + 1] : undefined;
      const reportText = reportFile ? readFileSync(reportFile, "utf-8") : finding.report_text;
      const card = mod.findScope(home, finding.scope);
      if (!card) { process.stderr.write(`错误：没有叫 ${finding.scope} 的范围卡（先建卡）\n`); return 1; }
      const gate = mod.evaluateSubmitGate({
          scope: card,
          target: finding.target,
          vulnClass: finding.vuln_class,
          severity: finding.severity,
          falsification: finding.falsification,
          seven: finding.seven,
          reportText,
        });
      const c = gate.checks;
      process.stdout.write(`范围门：${c.scope.inScope ? "通过" : "拦截"}（${c.scope.reason}）\n`);
      process.stdout.write(`证伪门：${c.falsification.verdict}${c.falsification.verdict === "pending" ? `（${c.falsification.blocker ?? ""}）` : ""}${c.falsification.verdict === "rejected" ? `（${c.falsification.refutation ?? ""}）` : ""}\n`);
      process.stdout.write(`七问门：${c.seven.passed ? "通过" : `拦截（${[...c.seven.failed, ...c.seven.unanswered].join("、")} 没过）`}\n`);
      if (c.hygiene === null) {
        process.stdout.write("卫生门：拦截（未提供报告文本，无法检查）\n");
      } else {
        process.stdout.write(`卫生门：${c.hygiene.clean ? "通过" : `拦截（${[...c.hygiene.hits.map((h: { label: string }) => h.label), ...c.hygiene.missingSections.map((s: string) => `缺${s}`)].join("、")}）`}\n`);
      }
      process.stdout.write(`严重度门：${c.severity.ok ? "通过" : "拦截"}（${c.severity.reason}）\n`);
      let targetHost = "";
      try { targetHost = new URL(finding.target).hostname; } catch { /* gate 已拦过，审计里留空 */ }
      const failing: string[] = [];
      if (!c.scope.inScope) failing.push("scope");
      if (c.falsification.verdict !== "confirmed") failing.push("falsification");
      if (!c.seven.passed) failing.push("seven");
      if (c.hygiene === null || !c.hygiene.clean) failing.push("hygiene");
      if (!c.severity.ok) failing.push("severity");
      let reviewerSource = "skipped";
      if (gate.decision === "allow") {
        const verdict = await mod.reviewSubmitReport({
            config,
            home,
            summary: `提交漏洞报告：范围卡 ${card.name}，目标 ${targetHost}，类别 ${finding.vuln_class}，严重度 ${finding.severity ?? "未声明"}，证伪 confirmed`,
            scope: card.name,
            targetHost,
            severity: finding.severity ?? "",
          });
        reviewerSource = verdict.source;
        if (verdict.source === "skipped") {
          process.stdout.write("审查层：已跳过（审查层未开启；只走了五道确定性门）\n");
        } else {
          process.stdout.write(`审查层：${verdict.decision === "ALLOW" ? "通过" : "拦截"}（${verdict.reviewerModel ?? ""}，${verdict.reason}）\n`);
        }
        if (verdict.decision === "BLOCK") {
          failing.push("reviewer");
          mod.appendBughuntAudit(home, {
              at: new Date().toISOString(), action: "submit_gate", scope: card.name, target_host: targetHost,
              decision: "block", failing, severity: finding.severity,
              falsification_verdict: c.falsification.verdict, reviewer_source: reviewerSource,
            });
          process.stdout.write(`结论：拦截（审查层拦住了：${verdict.reason}）\n`);
          return 3;
        }
      }
      mod.appendBughuntAudit(home, {
          at: new Date().toISOString(), action: "submit_gate", scope: card.name, target_host: targetHost,
          decision: gate.decision, failing, severity: finding.severity,
          falsification_verdict: c.falsification.verdict, reviewer_source: reviewerSource,
        });
      if (gate.decision === "block") {
        for (const r of gate.reasons) process.stdout.write(`拦截原因：${r}\n`);
        process.stdout.write("结论：拦截（先按上面的原因修好，再重新核对）\n");
        return 3;
      }
      process.stdout.write("结论：可提交（仍须由人提交，Nyra 不代提交）\n");
      return 0;
    }
    process.stderr.write(`错误：未知子命令 bughunt ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：market（内置机器人市场，第一阶段：静态策展仓库 + 本地客户端） ----
// ---- 子命令：account（用户账号登录，缺口 41） ----
const ACCOUNT_USAGE =
  "用法：nyra account <status|login|logout|list|revoke|link|suspend|reactivate> [选项]\n" +
  "  nyra account status              当前登录状态\n" +
  "  nyra account login google        Google 登录（回环回调；首次要 OAuth 客户端）\n" +
  "  nyra account login github        GitHub 登录（设备流：终端给码，浏览器里输码）\n" +
  "  nyra account login email <邮箱>  邮箱登录（发 magic link 邮件，点链接完成；先跑 nyra gmail auth）\n" +
  "  nyra account link google|github  给当前账号再绑一个登录方式\n" +
  "  nyra account list                列出本机账号\n" +
  "  nyra account revoke <会话 id>|--all  撤销会话\n" +
  "  nyra account logout              登出（撤销当前会话 + 清掉本机 token）\n" +
  "  nyra account suspend <账号 id> [--yes]  停用账号（全部会话立即失效；SCIM 取消开通也走这条路）\n" +
  "  nyra account reactivate <账号 id>  恢复已停用的账号（已撤销的会话不恢复，须重新登录）\n" +
  "  数据库：设 NYRA_DATABASE_URL 后账号数据存 Postgres（Neon），否则存本机文件。";

async function handleAccount(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(ACCOUNT_USAGE + "\n");
    return 0;
  }
  let pg: import("./accountsDb.ts").PostgresAccounts | null = null;
  try {
    const mod = await import("./accounts.ts");
    const dbMod = await import("./accountsDb.ts");
    // 有连接串就走 Postgres（先建表），没有就走本地文件；进程退出前关连接。
    const backend = dbMod.resolveAccountsBackend(home);
    pg = backend.kind === "postgres" ? await dbMod.openPostgresAccounts(backend.url) : null;
    const stores = pg
      ? { directory: pg.directory, sessions: pg.sessions, magicLinks: pg.magicLinks, audit: pg.audit }
      : undefined;
    const audit = async (entry: { action: "login" | "logout" | "link" | "revoke" | "magic_link_requested" | "magic_link_redeemed"; provider?: "google" | "github" | "email"; account_id?: string }): Promise<void> => {
      if (stores?.audit) await stores.audit(entry);
      else mod.appendAccountAudit(home, entry);
    };
    const ask = async (prompt: string): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
      return answer;
    };
    const unlockVault = async (): Promise<Vault | null> => {
      const vault = new Vault(join(home, "vault.json"));
      if (!vault.exists()) {
        process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
        return null;
      }
      if (!vault.unlock(await ask("主密码："))) {
        const remaining = vault.lockoutRemainingMs();
        if (remaining > 0) {
          process.stderr.write(`尝试次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试\n`);
        } else {
          process.stderr.write("主密码错误或密码箱已损坏\n");
        }
        return null;
      }
      return vault;
    };
    const openAuthUrl = async (url: string): Promise<void> => {
      process.stdout.write("请在浏览器里打开下面的链接完成授权：\n" + url + "\n");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      try {
        const child = spawn(opener, args, { detached: true, stdio: "ignore" });
        child.unref();
      } catch {
        /* 打不开浏览器不阻塞：链接已经打印出来了 */
      }
    };
    const readGoogleClient = async (vault: Vault): Promise<{ client_id: string; client_secret: string } | null> => {
      const raw = vault.get(mod.OAUTH_GOOGLE_CLIENT_ENTRY);
      if (raw) {
        try {
          const d = JSON.parse(raw) as Record<string, unknown>;
          if (typeof d.client_id === "string" && d.client_id && typeof d.client_secret === "string" && d.client_secret) {
            return { client_id: d.client_id, client_secret: d.client_secret };
          }
        } catch {
          /* 损坏的客户端条目按没有处理，下面重新输入 */
        }
      }
      process.stdout.write("第一次登录需要 Google Cloud 的 OAuth 客户端（Desktop app 类型）：\n");
      process.stdout.write("  在 console.cloud.google.com 建好 OAuth 2.0 客户端后，把 client_id 与 client_secret 粘贴进来（只存密码箱，不进配置文件）。\n");
      const clientId = (await ask("client_id：")).trim();
      const clientSecret = (await ask("client_secret：")).trim();
      if (!clientId || !clientSecret) {
        process.stderr.write("client_id 与 client_secret 不能为空\n");
        return null;
      }
      const client = { client_id: clientId, client_secret: clientSecret };
      vault.add(mod.OAUTH_GOOGLE_CLIENT_ENTRY, JSON.stringify(client), true);
      return client;
    };
    const readGithubClient = async (vault: Vault): Promise<string | null> => {
      const raw = vault.get(mod.OAUTH_GITHUB_CLIENT_ENTRY);
      if (raw) {
        try {
          const d = JSON.parse(raw) as Record<string, unknown>;
          if (typeof d.client_id === "string" && d.client_id) return d.client_id;
        } catch {
          /* 损坏的客户端条目按没有处理，下面重新输入 */
        }
      }
      process.stdout.write("第一次登录需要 GitHub OAuth App 的 client_id（设备流不需要 secret）：\n");
      process.stdout.write("  在 github.com/settings/developers 建好 OAuth App 后，把 client_id 粘贴进来（只存密码箱，不进配置文件）。\n");
      const clientId = (await ask("client_id：")).trim();
      if (!clientId) {
        process.stderr.write("client_id 不能为空\n");
        return null;
      }
      vault.add(mod.OAUTH_GITHUB_CLIENT_ENTRY, JSON.stringify({ client_id: clientId }), true);
      return clientId;
    };
    if (cmd === "status") {
      const account = await mod.getCurrentAccount(home, { stores });
      if (!account) {
        process.stdout.write("未登录（nyra account login google|github）\n");
        return 0;
      }
      const current = mod.readCurrentSession(home);
      let expires = "";
      if (current) {
        const sessions = stores?.sessions ?? new mod.AccountSessionStore(home);
        const verified = await sessions.verify(current.token);
        if (verified) {
          const found = (await sessions.listSessions(account.id)).find((s) => s.id === verified.session_id);
          if (found) expires = found.expires_at;
        }
      }
      process.stdout.write(`已登录：${account.email}（${account.role === "owner" ? "机主" : "普通用户"}）\n`);
      process.stdout.write(`登录方式：${account.providers.map((p) => p.provider).join("、") || "无"}\n`);
      if (expires) process.stdout.write(`会话过期：${expires}\n`);
      return 0;
    }
    if (cmd === "list") {
      const store = stores?.directory ?? new mod.AccountStore(home);
      const accounts = await store.listAccounts();
      if (!accounts.length) {
        process.stdout.write("本机还没有账号（nyra account login google|github）\n");
        return 0;
      }
      for (const a of accounts) {
        process.stdout.write(`- ${a.email}（id ${a.id}，${a.role === "owner" ? "机主" : "普通用户"}，${a.providers.map((p) => p.provider).join("、") || "未绑定登录方式"}${a.status === "suspended" ? "，已停用" : ""}，创建于 ${a.created_at}）\n`);
      }
      return 0;
    }
    if (cmd === "suspend" || cmd === "reactivate") {
      const id = argv[1];
      if (!id) {
        process.stderr.write(`用法：nyra account ${cmd} <账号 id>\n`);
        return 2;
      }
      const store = stores?.directory ?? new mod.AccountStore(home);
      const target = await store.findById(id);
      if (!target) {
        process.stderr.write("没有这个账号：" + id + "\n");
        return 1;
      }
      if (cmd === "suspend") {
        if (target.status === "suspended") {
          process.stdout.write(`账号已是停用状态：${target.email}\n`);
          return 0;
        }
        if (!argv.includes("--yes")) {
          const answer = (await ask(`确定停用账号 ${target.email} 吗？该账号的全部会话会立即失效。[y/N] `)).trim().toLowerCase();
          if (answer !== "y") {
            process.stdout.write("已取消\n");
            return 0;
          }
        }
        const { revoked_sessions } = await mod.suspendAccount(home, id, { stores });
        process.stdout.write(`已停用账号：${target.email}（撤销会话 ${revoked_sessions} 个）\n`);
        return 0;
      }
      if (target.status !== "suspended") {
        process.stdout.write(`账号本来就没停用：${target.email}\n`);
        return 0;
      }
      await mod.reactivateAccount(home, id, { stores });
      process.stdout.write(`已恢复账号：${target.email}（被停用期间的会话已作废，须重新登录）\n`);
      return 0;
    }
    if (cmd === "login") {
      const provider = argv[1];
      if (provider === "google") {
        const vault = await unlockVault();
        if (!vault) return 1;
        const client = await readGoogleClient(vault);
        if (!client) return 1;
        const { account } = await mod.loginWithGoogle({ home, client, openUrl: openAuthUrl, stores });
        process.stdout.write(`登录成功：${account.email}（${account.role === "owner" ? "机主" : "普通用户"}）\n`);
        return 0;
      }
      if (provider === "github") {
        const vault = await unlockVault();
        if (!vault) return 1;
        const clientId = await readGithubClient(vault);
        if (!clientId) return 1;
        const { account } = await mod.loginWithGithub({
          home,
          clientId,
          stores,
          onUserCode: (code) => {
            process.stdout.write(`请在浏览器里打开 ${code.verification_uri}，输入设备码：${code.user_code}\n`);
            process.stdout.write(`（设备码 ${Math.floor(code.expires_in / 60)} 分钟内有效）\n`);
          },
        });
        process.stdout.write(`登录成功：${account.email}（${account.role === "owner" ? "机主" : "普通用户"}）\n`);
        return 0;
      }
      if (provider === "email") {
        // 缺口 41 下一批：邮箱 magic link 登录完整链。
        // 发 magic link（走已授权的 Gmail 连接器发信）→ 用户点邮件里的链接 →
        // 网关 /api/account/magic-link 兑换并写本机 session cookie → 这里轮询
        // 到登录成功。网关地址默认 http://127.0.0.1:8765（nyra ui 默认端口）。
        const email = (argv[2] ?? "").trim();
        const gatewayUrl = (argv.indexOf("--gateway") >= 0 ? argv[argv.indexOf("--gateway") + 1] : undefined) ?? "http://127.0.0.1:8765";
        if (!email) {
          process.stderr.write("用法：nyra account login email <邮箱> [--gateway <网关地址>]\n");
          return 2;
        }
        if (!mod.normalizeEmail(email)) {
          process.stderr.write("邮箱格式无效\n");
          return 1;
        }
        let sender: ReturnType<typeof mod.gmailMailSender>;
        try {
          const gmail = await import("./connectors/gmail.ts");
          const transport = gmail.createGmailTransport(home, loadConfig(home));
          sender = mod.gmailMailSender(async (opts) => { await transport.send({ to: [opts.to], subject: opts.subject, body: opts.body }); });
        } catch (err) {
          process.stderr.write(`未配置发信方式：${err instanceof Error ? err.message : String(err)}\n`);
          process.stderr.write("请先运行 nyra gmail auth 完成 Gmail 授权，再用邮箱登录\n");
          return 1;
        }
        try {
          await mod.requestMagicLink({ home, email, sender, gatewayUrl, stores });
        } catch (err) {
          process.stderr.write(`发送失败：${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
        process.stdout.write(`登录邮件已发送到 ${email}，15 分钟内有效、只能用一次。\n`);
        process.stdout.write("请点开邮件里的链接完成登录（本机会自动检测，也可以点完稍等几秒再回车跳过等待）…\n");
        // 轮询本机 session cookie：链接兑换成功会写 account-session.json。
        // 最多等 5 分钟（覆盖 15 分钟有效期内的合理等待），每 2 秒查一次。
        const started = Date.now();
        const deadline = started + 5 * 60 * 1000;
        let loggedIn = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const cur = mod.readCurrentSession(home);
          if (cur) {
            const acct = await mod.getCurrentAccount(home, { stores });
            if (acct) {
              process.stdout.write(`\n登录成功：${acct.email}（${acct.role === "owner" ? "机主" : "普通用户"}）\n`);
              loggedIn = true;
              break;
            }
          }
        }
        if (!loggedIn) {
          process.stdout.write("\n还没检测到登录（链接可能还没点，或网关没在运行）。\n");
          process.stdout.write(`稍后可以再点邮件里的链接，然后用 nyra account status 查看登录状态。\n`);
          return 0;
        }
        return 0;
      }
      process.stderr.write("用法：nyra account login <google|github|email>\n");
      return 2;
    }
    if (cmd === "link") {
      const provider = argv[1];
      const current = await mod.getCurrentAccount(home, { stores });
      if (!current) {
        process.stderr.write("请先登录（nyra account login google|github），再绑定其他登录方式\n");
        return 1;
      }
      const store = stores?.directory ?? new mod.AccountStore(home);
      if (provider === "google") {
        const vault = await unlockVault();
        if (!vault) return 1;
        const client = await readGoogleClient(vault);
        if (!client) return 1;
        const info = await mod.runGoogleIdentity({ client, openUrl: openAuthUrl });
        await store.linkIdentity(current.id, { provider: "google", sub: info.sub, email: info.email, ...(info.name ? { name: info.name } : {}) });
        await audit({ action: "link", provider: "google", account_id: current.id });
        process.stdout.write(`已绑定 Google 身份：${info.email}\n`);
        return 0;
      }
      if (provider === "github") {
        const vault = await unlockVault();
        if (!vault) return 1;
        const clientId = await readGithubClient(vault);
        if (!clientId) return 1;
        const info = await mod.runGithubIdentity({
          clientId,
          onUserCode: (code) => {
            process.stdout.write(`请在浏览器里打开 ${code.verification_uri}，输入设备码：${code.user_code}\n`);
            process.stdout.write(`（设备码 ${Math.floor(code.expires_in / 60)} 分钟内有效）\n`);
          },
        });
        await store.linkIdentity(current.id, { provider: "github", sub: info.sub, email: info.email, ...(info.name ? { name: info.name } : {}) });
        await audit({ action: "link", provider: "github", account_id: current.id });
        process.stdout.write(`已绑定 GitHub 身份：${info.email}\n`);
        return 0;
      }
      process.stderr.write("用法：nyra account link <google|github>\n");
      return 2;
    }
    if (cmd === "logout") {
      const current = mod.readCurrentSession(home);
      if (!current) {
        process.stdout.write("当前没有登录的账号\n");
        return 0;
      }
      const sessions = stores?.sessions ?? new mod.AccountSessionStore(home);
      const verified = await sessions.verify(current.token);
      if (verified) {
        await sessions.revoke(verified.session_id);
        await audit({ action: "logout", account_id: verified.account_id });
      }
      mod.clearCurrentSession(home);
      process.stdout.write("已登出\n");
      return 0;
    }
    if (cmd === "revoke") {
      const target = argv[1];
      const current = await mod.getCurrentAccount(home, { stores });
      if (!current) {
        process.stderr.write("请先登录（nyra account login google|github）\n");
        return 1;
      }
      const sessions = stores?.sessions ?? new mod.AccountSessionStore(home);
      if (target === "--all") {
        const n = await sessions.revokeAllForAccount(current.id);
        mod.clearCurrentSession(home);
        await audit({ action: "revoke", account_id: current.id });
        process.stdout.write(`已撤销全部 ${n} 个会话（含当前会话，已登出）\n`);
        return 0;
      }
      if (!target) {
        process.stderr.write("用法：nyra account revoke <会话 id>|--all\n");
        return 2;
      }
      const ok = await sessions.revoke(target);
      if (!ok) {
        process.stderr.write("会话不存在\n");
        return 1;
      }
      const cur = mod.readCurrentSession(home);
      if (cur) {
        const v = await sessions.verify(cur.token);
        if (!v) mod.clearCurrentSession(home);
      }
      await audit({ action: "revoke", account_id: current.id });
      process.stdout.write("已撤销会话\n");
      return 0;
    }
    process.stderr.write(ACCOUNT_USAGE + "\n");
    return 2;
  } catch (err) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    if (pg) {
      try {
        await pg.close();
      } catch {
        /* 关连接失败不影响本次命令的退出码 */
      }
    }
  }
}

async function handleMarket(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action) {
    process.stdout.write("用法：nyra market <list|show|source|install|uninstall|installed|publish|template> [选项]\n");
    return 2;
  }
  try {
    const mod = await import("./marketplace.ts");
    const config = loadConfig(home);
    const askConfirm = async (prompt: string): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    };
    const newRun = (task: string): { store: RunStore; runId: string } => {
      const store = new RunStore(join(home, "runs"));
      const run = store.create(task, "cli", home, "readonly", 1);
      return { store, runId: run.run_id };
    };
    if (action === "list") {
      const sourceIdx = argv.indexOf("--source");
      const sourceName = sourceIdx !== -1 ? argv[sourceIdx + 1] : undefined;
      const queryIdx = argv.indexOf("--query");
      const query = queryIdx !== -1 ? argv[queryIdx + 1] : undefined;
      const sources = mod.loadMarketSources(home);
      if (!sources.length) {
        process.stdout.write("还没有登记的市场源。\n");
        process.stdout.write("登记一个本地市场目录：nyra market source add <本地目录>（目录里须有 index.json）\n");
        process.stdout.write("或登记策展仓库：nyra market source add https://github.com/js2005happy/nyra-community.git\n");
        process.stdout.write("（仓库尚未建立，先用 nyra market template index 起一个本地市场目录；见 docs/marketplace.md）\n");
        return 0;
      }
      const entries = mod.listMarketEntries(home, { query, source: sourceName });
      if (!entries.length) { process.stdout.write("市场里没有条目\n"); return 0; }
      for (const l of entries) {
        const e = l.entry;
        process.stdout.write(`- ${e.id}（${e.kind === "skill" ? "技能包" : e.kind === "template" ? "业务流程模板" : "机器人配置"}）v${e.version} — ${e.description ?? "（无说明）"} — Bot Ready ${l.botReady.score}/100 — ${e.license ?? "无许可证"} — 来源 ${l.source}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra market show <条目 id>\n"); return 2; }
      const resolved = mod.resolveMarketEntry(home, id);
      if (!resolved) { process.stderr.write(`错误：市场里没有条目 ${id}（先 nyra market list 看看）\n`); return 1; }
      const verification = mod.verifyMarketplaceEntry(resolved);
      const scanHits = mod.scanMarketplaceEntry(resolved);
      const botReady = mod.computeBotReadyForDir(resolved.entry, resolved.dir);
      process.stdout.write(`${mod.MARKET_WARNING}\n`);
      const e = resolved.entry;
      process.stdout.write(`条目：${e.name} v${e.version}（${e.kind === "skill" ? "技能包" : e.kind === "template" ? "业务流程模板" : "机器人配置"}，来源 ${resolved.source.name}:${e.id}）\n`);
      if (e.description) process.stdout.write(`说明：${e.description}\n`);
      if (e.author) process.stdout.write(`作者：${e.author}\n`);
      process.stdout.write(`许可证：${e.license ?? "未声明"}\n`);
      if (e.source) process.stdout.write(`来源链接：${e.source}\n`);
      process.stdout.write(`声明的工具：${verification.tools.join("、") || "未声明"}\n`);
      process.stdout.write(`声明的权限：${verification.permissions.join("、") || "未声明"}\n`);
      process.stdout.write(`模式：${e.mode ?? verification.manifest?.mode ?? "readonly"}（新装机器人默认只读起步）\n`);
      if (verification.routines.length) process.stdout.write(`routine：${verification.routines.length} 个（只随机器人安装，不自动执行，须手动启用）\n`);
      if (verification.highPrivilegeTools.length) process.stdout.write(`⚠ 高权限工具：${verification.highPrivilegeTools.join("、")}\n`);
      for (const w of verification.warnings) process.stdout.write(`提醒：${w}\n`);
      if (!verification.ok) {
        for (const err of verification.errors) process.stdout.write(`清单问题：${err}\n`);
      }
      if (scanHits.length) {
        for (const h of scanHits) process.stdout.write(`高危模式：${h.where}：${h.reason}\n`);
      }
      process.stdout.write(`Bot Ready：${botReady.score}/100${botReady.missing.length ? `（缺：${botReady.missing.join("、")}）` : "（满分）"}\n`);
      process.stdout.write(`文件：${verification.files.join("、") || "无"}\n`);
      return 0;
    }
    if (action === "source") {
      const sub = argv[1];
      if (sub === "list") {
        const sources = mod.loadMarketSources(home);
        if (!sources.length) { process.stdout.write("还没有登记的市场源\n"); return 0; }
        for (const s of sources) {
          let count = 0;
          try { count = mod.loadMarketIndex(s.path).entries.length; } catch { count = 0; }
          process.stdout.write(`- ${s.name}（${s.kind}，${s.path}，${count} 个条目）\n`);
        }
        return 0;
      }
      if (sub === "add") {
        const input = argv[2];
        if (!input) { process.stderr.write("错误：用法：nyra market source add <本地目录|git 地址>\n"); return 2; }
        const source = mod.addMarketSource(home, input);
        let count = 0;
        try { count = mod.loadMarketIndex(source.path).entries.length; } catch { count = 0; }
        process.stdout.write(`已登记市场源 ${source.name}（${source.kind}，${count} 个条目）\n`);
        return 0;
      }
      if (sub === "remove") {
        const name = argv[2];
        if (!name) { process.stderr.write("错误：用法：nyra market source remove <源名>\n"); return 2; }
        if (!mod.removeMarketSource(home, name)) { process.stderr.write(`错误：没有登记的市场源 ${name}\n`); return 1; }
        process.stdout.write(`已移除市场源 ${name}（git 克隆的目录已保留在 ~/.nyra/marketplace-sources/，不需要可手动删除）\n`);
        return 0;
      }
      process.stdout.write("用法：nyra market source <list|add <本地目录|git 地址>|remove <源名>>\n");
      return 2;
    }
    if (action === "install") {
      const id = argv[1];
      if (!id) { process.stderr.write("错误：用法：nyra market install <条目 id> [--force]\n"); return 2; }
      const force = argv.includes("--force");
      const prepared = await mod.prepareMarketplaceInstall(home, id, { config });
      process.stdout.write(`${prepared.plannedChanges.join("\n")}\n`);
      if (argv.includes("--yes")) {
        process.stdout.write("提示：市场安装确认不能用 --yes 跳过（市场内容是不受信任的第三方配置），仍需你确认。\n");
      }
      if (!await askConfirm("确认安装？(y/N) ")) {
        process.stdout.write("已取消，未安装任何文件。\n");
        return 0;
      }
      const { store, runId } = newRun(`marketplace install ${id}`);
      const result = mod.executeMarketplaceInstall(home, prepared, { force, store, runId });
      process.stdout.write(`已安装 ${result.installed.item_name} v${result.installed.version}：${result.installed.installed_path}\n`);
      if (result.overwritten) process.stdout.write("（覆盖了旧版）\n");
      if (result.keptModified.length) process.stdout.write(`升级时保留了你改过的文件：${result.keptModified.join("、")}\n`);
      if (result.installed.kind === "bot") {
        process.stdout.write("机器人默认只读起步：写操作须在机器人自己的权限里显式放开；routine 不自动执行，须手动启用。\n");
      }
      process.stdout.write(`卸载：nyra market uninstall ${result.installed.item_name}\n`);
      return 0;
    }
    if (action === "uninstall") {
      const name = argv[1];
      if (!name) { process.stderr.write("错误：用法：nyra market uninstall <条目名> [--yes]\n"); return 2; }
      if (!argv.includes("--yes") && !await askConfirm(`确认卸载 ${name}？(y/N) `)) {
        process.stdout.write("已取消，未卸载任何文件。\n");
        return 0;
      }
      const { store, runId } = newRun(`marketplace uninstall ${name}`);
      const result = mod.uninstallMarketplaceEntry(home, name, { store, runId });
      process.stdout.write(`已卸载 ${name}：删了 ${result.removed.join("、") || "无"}\n`);
      if (result.kept.length) process.stdout.write(`保留未删：${result.kept.join("、")}\n`);
      process.stdout.write("卸载记录留在安装账本里（nyra market installed 可查历史）。\n");
      return 0;
    }
    if (action === "installed") {
      const entries = mod.listInstalled(home);
      if (!entries.length) { process.stdout.write("还没有从市场安装过任何东西\n"); return 0; }
      for (const e of entries) {
        process.stdout.write(`- ${e.item_name}（${e.kind === "skill" ? "技能包" : e.kind === "template" ? "业务流程模板" : "机器人配置"}）v${e.version} — 来源 ${e.source} — ${e.status}${e.status === "uninstalled" && e.uninstalled_at ? `（${e.uninstalled_at} 卸载）` : ""} — Bot Ready ${e.bot_ready}/100 — ${e.installed_at}\n`);
      }
      return 0;
    }
    if (action === "publish") {
      const skillIdx = argv.indexOf("--skill");
      const licenseIdx = argv.indexOf("--license");
      const license = licenseIdx !== -1 ? argv[licenseIdx + 1] : undefined;
      const outIdx = argv.indexOf("--out");
      const outDir = outIdx !== -1 ? argv[outIdx + 1] : undefined;
      const dryRun = argv.includes("--dry-run");
      let input: { dir: string } | { skill: string };
      if (skillIdx !== -1) {
        const skillName = argv[skillIdx + 1];
        if (!skillName) { process.stderr.write("错误：用法：nyra market publish --skill <技能名> [--license <许可证>]\n"); return 2; }
        input = { skill: skillName };
      } else {
        const dir = argv[1];
        if (!dir) { process.stderr.write("错误：用法：nyra market publish <机器人目录|技能文件> [--license <许可证>] [--dry-run] [--out <目录>]\n"); return 2; }
        input = { dir };
      }
      const { store, runId } = newRun(`marketplace publish ${"skill" in input ? input.skill : input.dir}`);
      const result = await mod.publishMarketplaceEntry(home, input, { config, dryRun, outDir, license, store, runId });
      process.stdout.write(`${dryRun ? "试运行（未写出任何文件，未记账本）" : "已打包"}：${result.itemName} v${result.version}（${result.kind === "skill" ? "技能包" : result.kind === "template" ? "业务流程模板" : "机器人配置"}）\n`);
      process.stdout.write(`输出目录：${result.outDir}\n`);
      process.stdout.write(`文件：${result.files.join("、")}\n`);
      process.stdout.write(`Bot Ready 自评：${result.botReady.score}/100${result.botReady.missing.length ? `（缺：${result.botReady.missing.join("、")}）` : "（满分）"}\n`);
      process.stdout.write(`审查：${result.review.source === "skipped" ? "已跳过（审查层未开启；只走了两道确定性门）" : `${result.review.decision === "ALLOW" ? "通过" : "拦截"}（${result.review.reviewerModel ?? ""}，${result.review.reason}）`}\n`);
      for (const w of result.warnings) process.stdout.write(`提醒：${w}\n`);
      if (!dryRun) {
        process.stdout.write("下一步：把输出目录里的文件提交到策展仓库 nyra-community（提 PR），market-entry.json 是给维护者的索引片段。\n");
      }
      return 0;
    }
    if (action === "template") {
      const kind = argv[1];
      if (kind === "bot") { process.stdout.write(mod.marketBotTemplate()); return 0; }
      if (kind === "index") { process.stdout.write(mod.marketIndexTemplate()); return 0; }
      process.stdout.write("用法：nyra market template <bot|index>\n");
      return 2;
    }
    process.stdout.write("用法：nyra market <list|show|source|install|uninstall|installed|publish|template> [选项]\n");
    return 2;
  } catch (err: unknown) {
    if (err instanceof Error && (err as { gate?: string }).gate) {
      const gate = (err as { gate?: string }).gate;
      process.stderr.write(`错误：${err.message}\n`);
      return gate === "license" ? 2 : 3;
    }
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：memory ----
const PLUGIN_USAGE = `用法：
  nyra plugin list                    列出已安装插件
nyra plugin search [关键词]         在登记表里找插件
nyra plugin install <本地目录|git URL>  安装插件（只装显式指定的来源）
nyra plugin uninstall <名字>        卸载插件（用户改过的文件保留并报告）
nyra plugin enable <名字>           启用插件
nyra plugin disable <名字>          停用插件
nyra plugin verify [名字]           按锁定文件验哈希（不给名字则验全部）
nyra plugin audit                   生命周期 + 全部验哈希
nyra plugin pin <名字>              固定插件（不豁免 stale，只是不自动归档）
nyra plugin unpin <名字>            取消固定`;

async function handlePlugin(argv: string[], home: string): Promise<number> {
const [cmd, arg] = argv;
try {
  if (cmd === "list" || cmd === undefined) {
    const plugins = listPlugins(home);
    if (!plugins.length) { process.stdout.write("未安装插件\n"); return 0; }
    for (const p of plugins) {
      process.stdout.write(`- ${p.name} ${p.version}（${p.status}${p.pinned ? "，pinned" : ""}，来源：${p.source}）\n`);
    }
    return 0;
  }
  if (cmd === "search") {
    const found = searchRegistry(home, arg);
    if (!found.length) { process.stdout.write("登记表里没有匹配的插件\n"); return 0; }
    for (const e of found) {
      process.stdout.write(`- ${e.name} ${e.version}${e.description ? `：${e.description}` : ""}（来源：${e.source}）\n`);
    }
    return 0;
  }
  if (cmd === "install") {
    if (!arg) { process.stderr.write("缺少来源：nyra plugin install <本地目录|git URL>\n"); return 2; }
    const res = installPlugin(home, arg);
    process.stdout.write(`已安装 ${res.name} ${res.version}${res.upgraded ? "（升级）" : ""}\n`);
    if (res.keptModified.length) {
      process.stdout.write(`以下文件你改过，已保留未覆盖：${res.keptModified.join("、")}\n`);
    }
    return 0;
  }
  if (cmd === "uninstall") {
    if (!arg) { process.stderr.write("缺少插件名：nyra plugin uninstall <名字>\n"); return 2; }
    const res = uninstallPlugin(home, arg);
    process.stdout.write(`已卸载 ${res.name}（删除 ${res.removed.length} 个文件）\n`);
    if (res.keptModified.length) {
      process.stdout.write(`以下文件你改过，已保留：${res.keptModified.join("、")}\n`);
    }
    return 0;
  }
  if (cmd === "enable" || cmd === "disable") {
    if (!arg) { process.stderr.write(`缺少插件名：nyra plugin ${cmd} <名字>\n`); return 2; }
    const rec = setPluginStatus(home, arg, cmd === "enable" ? "active" : "disabled");
    process.stdout.write(`已${cmd === "enable" ? "启用" : "停用"} ${rec.name}\n`);
    return 0;
  }
  if (cmd === "pin" || cmd === "unpin") {
    if (!arg) { process.stderr.write(`缺少插件名：nyra plugin ${cmd} <名字>\n`); return 2; }
    const rec = setPluginPinned(home, arg, cmd === "pin");
    process.stdout.write(`已${cmd === "pin" ? "固定" : "取消固定"} ${rec.name}\n`);
    return 0;
  }
  if (cmd === "verify") {
    const targets = arg ? [arg] : listPlugins(home).map((p) => p.name);
    if (!targets.length) { process.stdout.write("未安装插件\n"); return 0; }
    let allOk = true;
    for (const name of targets) {
      const v = verifyPlugin(home, name);
      if (!v.ok) allOk = false;
      const bad = v.files.filter((f) => f.state === "modified" || f.state === "missing");
      const held = v.files.filter((f) => f.state === "held");
      process.stdout.write(`${name}：${v.ok ? "通过" : "有问题"}${bad.length ? `（${bad.map((f) => `${f.rel}:${f.state === "modified" ? "被改过" : "缺失"}`).join("、")}）` : ""}${held.length ? `（保留用户改过的文件 ${held.length} 个）` : ""}\n`);
    }
    return allOk ? 0 : 1;
  }
  if (cmd === "audit") {
    const { staleNow, verified } = auditPlugins(home);
    if (staleNow.length) process.stdout.write(`已降级为 stale（超过 ${STALE_AFTER_DAYS} 天没用过）：${staleNow.join("、")}\n`);
    else process.stdout.write("没有新降级的插件\n");
    for (const v of verified) {
      process.stdout.write(`${v.name}：${v.ok ? "通过" : "有问题"}\n`);
    }
    return verified.every((v) => v.ok) ? 0 : 1;
  }
  process.stderr.write(`未知插件子命令：${cmd ?? ""}\n${PLUGIN_USAGE}\n`);
  return 2;
} catch (err: unknown) {
  if (err instanceof PluginError) {
    process.stderr.write(`插件操作失败：${err.message}\n`);
    return 1;
  }
  throw err;
}
}

async function handleCreator(argv: string[], home: string, workdir: string): Promise<number> {
  const CREATOR_USAGE = "用法：\n"
  + "  nyra creator \"<一句话需求>\" [--yes]   对齐 spec → 生成插件 → 验证 → 确认后安装\n"
  + "  nyra creator verify <staging 目录>     只验证 staging 插件（不安装）\n"
  + "  nyra creator install <staging 目录> [--yes]  验证后安装 staging 插件\n"
  + "例子：nyra creator \"做个番茄钟\" --yes；nyra creator \"扫描 TODO\" --yes";
  try {
    const cmd = argv[0];
    if (cmd === "verify") {
      const dir = argv[1];
      if (!dir) { process.stderr.write("缺少 staging 目录：nyra creator verify <目录>\n"); return 2; }
      const report = verifyStagedPlugin(resolve(dir));
      if (report.ok) {
        process.stdout.write(`验证通过：${report.manifest?.name ?? "未知插件"} v${report.manifest?.version ?? "?"}\n`);
        process.stdout.write(describePlannedChanges(report) + "\n");
        return 0;
      }
      process.stderr.write(`验证未通过：\n${report.errors.map((e) => `- ${e}`).join("\n")}\n`);
      return 1;
    }
    if (cmd === "install") {
      const dir = argv[1];
      if (!dir) { process.stderr.write("缺少 staging 目录：nyra creator install <目录> [--yes]\n"); return 2; }
      const yes = argv.includes("--yes");
      const report = verifyStagedPlugin(resolve(dir));
      if (!report.ok) {
        process.stderr.write(`验证未通过，拒绝安装：\n${report.errors.map((e) => `- ${e}`).join("\n")}\n`);
        return 1;
      }
      if (!yes) {
        process.stdout.write(describePlannedChanges(report) + "\n");
        const choice = await askApproval("确认安装这个插件吗？");
        if (choice !== "yes") {
          process.stdout.write("已取消，未安装任何东西。\n");
          return 0;
        }
      }
      const { install } = installStagedPlugin(home, resolve(dir));
      process.stdout.write(`已安装 ${install.name} ${install.version}\n`);
      process.stdout.write(`停用：nyra plugin disable ${install.name}；卸载：nyra plugin uninstall ${install.name}\n`);
      return 0;
    }
    // 默认：nyra creator "<一句话>" [--yes]
    const request = argv.filter((a) => a !== "--yes").join(" ").trim();
    if (!request || cmd === "--help" || cmd === "-h") {
      process.stdout.write(CREATOR_USAGE + "\n");
      return cmd === "--help" || cmd === "-h" ? 0 : 2;
    }
    const yes = argv.includes("--yes");
    const result = await runCreator(request, { home, workdir, autoApprove: yes });
    process.stdout.write(`spec 已存档：${result.specPath}\n`);
    process.stdout.write(result.changes + "\n");
    if (result.status === "awaiting-approval") {
      const choice = await askApproval("确认安装这个插件吗？");
      if (choice !== "yes") {
        process.stdout.write("已取消，未安装任何东西。\n");
        return 0;
      }
      const { install } = installStagedPlugin(home, result.stagingDir);
      process.stdout.write(`已安装 ${install.name} ${install.version}\n`);
      process.stdout.write(`停用：nyra plugin disable ${install.name}；卸载：nyra plugin uninstall ${install.name}\n`);
      return 0;
    }
    process.stdout.write(`已安装 ${result.install?.name} ${result.install?.version}\n`);
    process.stdout.write(`停用：nyra plugin disable ${result.install?.name}；卸载：nyra plugin uninstall ${result.install?.name}\n`);
    return 0;
  } catch (err: unknown) {
    if (err instanceof CreatorError || err instanceof PluginError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function handleMemory(argv: string[], home: string): Promise<number> {
  const { exportSnapshot, importSnapshot, importChatZip, readLocalCodex, readLocalClaude, readLocalDir, EXPORT_PROMPT } = await import("./memoryExchange.ts");
  const cmd = argv[0];
  // Kooyu 记忆证据门：结构化条目那几个子命令（remember/entries/entry/update/rejections）。
  if (cmd === "remember" || cmd === "entries" || cmd === "entry" || cmd === "update" || cmd === "rejections") {
    return handleMemoryGate(argv, home);
  }
  // G-P1-31 主动记忆：开关与试跑（recall status|on|off|cross-on|cross-off|test）。
  if (cmd === "recall") {
    const { handleActiveMemory } = await import("./activeMemoryCli.ts");
    return handleActiveMemory(argv.slice(1), home);
  }
  // G-P1-34 对话里自动提炼记忆：提炼与人工确认（extract / review）。
  if (cmd === "extract" || cmd === "review") {
    const { handleMemoryProposals } = await import("./memoryProposalCli.ts");
    return handleMemoryProposals(argv, home);
  }
  // 缺口 1：nyra memory search <关键词> [--limit N] [--session <会话 id>]
  if (cmd === "search") {
    const { searchMemoryEntries, formatMemorySearchResults } = await import("./memory.ts");
    const rest = argv.slice(1);
    const limitIdx = rest.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(rest[limitIdx + 1], 10) : 5;
    const sessIdx = rest.indexOf("--session");
    const sessionId = sessIdx >= 0 ? rest[sessIdx + 1] : undefined;
    const query = rest.filter((a, i) => a !== "--limit" && a !== "--session" && !(limitIdx >= 0 && i === limitIdx + 1) && !(sessIdx >= 0 && i === sessIdx + 1)).join(" ");
    if (!query.trim()) { process.stderr.write("用法：nyra memory search <关键词> [--limit N] [--session <会话 id>]\n"); return 2; }
    const results = searchMemoryEntries(join(home, "MEMORY.md"), query, { limit: Number.isFinite(limit) ? limit : 5, session_id: sessionId, home });
    if (!results.length) { process.stdout.write("没有找到相关记忆。\n"); return 0; }
    process.stdout.write(formatMemorySearchResults(results) + "\n");
    return 0;
  }
  // 缺口 2：nyra memory forget <id...> [--session <会话 id>] [--yes]
  // 缺省先列出要删的条目再问一次；--yes 跳过确认（脚本里用）。
  if (cmd === "forget" || cmd === "delete") {
    const { previewMemoryDelete, deleteMemoryEntries, memoryOwnerForPath } = await import("./memory.ts");
    const { EvidenceStore } = await import("./evidence.ts");
    const rest = argv.slice(1);
    const yes = rest.includes("--yes");
    const sessIdx = rest.indexOf("--session");
    const sessionId = sessIdx >= 0 ? rest[sessIdx + 1] : undefined;
    const ids = rest.filter((a, i) => a !== "--yes" && a !== "--session" && !(sessIdx >= 0 && i === sessIdx + 1));
    const memoryPath = join(home, "MEMORY.md");
    if (!ids.length && !sessionId) { process.stderr.write("用法：nyra memory forget <记忆 id...> [--session <会话 id>] [--yes]\n"); return 2; }
    let preview;
    try {
      preview = previewMemoryDelete(memoryPath, { ids: ids.length ? ids : undefined, session_id: sessionId, home });
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    if (preview.notFound.length) process.stdout.write(`未找到：${preview.notFound.join("、")}\n`);
    if (!preview.targets.length) { process.stdout.write("没有可删除的记忆。\n"); return 0; }
    process.stdout.write(`将删除 ${preview.targets.length} 条记忆（删后剩 ${preview.remaining} 条）：\n`);
    for (const e of preview.targets) process.stdout.write(`- [${e.id}] ${e.text}\n`);
    if (!yes) {
      const choice = await askApproval("确认删除这些记忆吗？");
      if (choice !== "yes") { process.stdout.write("已取消，未删除任何东西。\n"); return 0; }
    }
    let result;
    try {
      result = deleteMemoryEntries(memoryPath, { ids: ids.length ? ids : undefined, session_id: sessionId, home });
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    try {
      const owner = memoryOwnerForPath(memoryPath, home);
      new EvidenceStore(join(home, "evidence"), "memory").save(
        "memory_delete",
        `memory://${owner}`,
        [
          "nyra memory forget（终端）",
          `记忆文件：${memoryPath}（${owner}）`,
          "批准：用户（终端确认）",
          `删了 ${result.deleted.length} 条，删后剩 ${result.remaining} 条：`,
          ...result.deleted.map((e) => `- [${e.id}] ${e.text}（来源会话：${e.source_session ?? "未记录"}；${e.created_at || "时间未记录"}）`),
        ].join("\n"),
      );
    } catch { /* 证据落盘失败不破坏删除结果 */ }
    process.stdout.write(`已删除 ${result.deleted.length} 条记忆，剩余 ${result.remaining} 条。\n`);
    return 0;
  }
  if (cmd === "export") {
    // exportSnapshot 要的是记忆文件路径，不是 Nyra 家目录。
    process.stdout.write(exportSnapshot(join(home, "MEMORY.md")) + "\n");
    return 0;
  }
  if (cmd === "export-prompt") {
    process.stdout.write(EXPORT_PROMPT);
    return 0;
  }
  if (cmd === "import") {
    const { readFileSync } = await import("node:fs");
    const text = argv[1] ? readFileSync(argv[1], "utf-8") : await new Promise<string>((res) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (c: string) => { data += c; });
        process.stdin.on("end", () => res(data));
      });
    const result = importSnapshot(text, join(home, "MEMORY.md"));
    process.stdout.write(`已导入 ${result.added} 条，跳过 ${result.skipped} 条（已存在），删掉 ${result.removed} 行含凭据的内容。\n`);
    return 0;
  }
  if (cmd === "local") {
    const kind = argv[1];
    try {
      let text: string;
      // 本地记忆读的是用户家目录（~/.codex、~/.claude），不是 Nyra 家目录。
      if (kind === "codex") text = readLocalCodex();
      else if (kind === "claude") text = readLocalClaude();
      else if (kind === "dir") text = readLocalDir(argv[2] ?? "");
      else { process.stderr.write("用法：nyra memory local <codex|claude|dir> [路径]\n"); return 2; }
      process.stdout.write(text + "\n");
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "import-zip") {
    try {
      const result = importChatZip(argv[1], home);
      process.stdout.write(`已导入 ${result.conversations} 条对话，原文存档：${result.archived}${result.removed ? `（已删掉 ${result.removed} 行含凭据的内容）` : ""}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "peer") {
    process.stdout.write("配对读记忆在 Node 版第 3 阶段，暂走 Python 版：python3 -m nyra.memory_exchange peer <配对码> [主机 端口]\n");
    return 2;
  }
  process.stdout.write("用法：nyra memory <export|export-prompt|import|local|import-zip|peer|search|forget>\n");
  return 2;
}

// ---- 子命令：style（缺口 4：分应用文风学习） ----
async function handleStyle(argv: string[], home: string): Promise<number> {
  const STYLE_USAGE = "用法：\n"
  + "  nyra style learn <渠道> <样本文件|-> [--yes]   从已发送消息样本提炼文风画像（先展示、确认后才保存；样本原文不保存）\n"
  + "  nyra style show [渠道]                        查看画像（不给渠道列出全部）\n"
  + "  nyra style list                               列出已有画像的渠道\n"
  + "  nyra style delete <渠道> [--yes]              删除画像\n"
  + "  nyra style export                             导出全部画像（Markdown，可随记忆快照走）\n"
  + "  nyra style import [文件]                      导入画像（只追加不覆盖；不给文件读 stdin）\n"
  + "渠道：gmail、outlook、slack、imessage、whatsapp 等小写名；详见 docs/style.md";
  const {
    learnStyleProfile, parseSamples, saveStyleProfile, loadStyleProfile,
    listStyleProfiles, deleteStyleProfile, formatStyleProfile, StyleError,
  } = await import("./style.ts");
  const { EvidenceStore } = await import("./evidence.ts");
  const cmd = argv[0];
  const readInput = async (src: string): Promise<string> => {
    if (src === "-") {
      return new Promise<string>((res) => {
          let data = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (c: string) => { data += c; });
          process.stdin.on("end", () => res(data));
        });
    }
    const { readFileSync } = await import("node:fs");
    return readFileSync(src, "utf-8");
  };
  try {
    // nyra style learn <渠道> <样本文件|-> [--yes]
    // 缺省先展示提炼出的画像再问一次；--yes 跳过确认（脚本里用，仍是用户显式调用）。
    if (cmd === "learn") {
      const channel = argv[1];
      const src = argv[2];
      const yes = argv.includes("--yes");
      if (!channel || !src || src === "--yes") {
        process.stderr.write("用法：nyra style learn <渠道> <样本文件|-> [--yes]\n");
        return 2;
      }
      let text: string;
      try {
        text = await readInput(src);
      } catch {
        process.stderr.write(`读不到样本文件：${src}\n`);
        return 1;
      }
      let profile;
      try {
        profile = learnStyleProfile(channel, parseSamples(text));
      } catch (err: unknown) {
        process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      process.stdout.write("提炼出的文风画像（样本原文不会保存）：\n" + formatStyleProfile(profile) + "\n");
      if (!yes) {
        const choice = await askApproval("确认保存这套文风画像吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未保存任何东西。\n"); return 0; }
      }
      const path = saveStyleProfile(home, profile);
      try {
        new EvidenceStore(join(home, "evidence"), "style").save(
          "style_learn",
          `style://${profile.channel}`,
          [
            "nyra style learn（终端）",
            `渠道：${profile.channel}`,
            `批准：用户（${yes ? "--yes 显式调用" : "终端确认"}）`,
            `样本：${profile.sample_count} 条用户已发送消息（原文未保存，只存了提炼出的习惯）`,
            "学到的画像：",
            formatStyleProfile(profile),
          ].join("\n"),
        );
      } catch { /* 证据落盘失败不破坏保存结果 */ }
      process.stdout.write(`已保存 ${profile.channel} 的文风画像（${profile.sample_count} 条样本提炼）：${path}\n`);
      process.stdout.write(`代笔时用它：nyra --channel ${profile.channel} "<任务>"\n`);
      return 0;
    }
    // nyra style show [渠道]
    if (cmd === "show") {
      const channel = argv[1];
      if (channel) {
        let profile;
        try {
          profile = loadStyleProfile(home, channel);
        } catch (err: unknown) {
          process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
        if (!profile) { process.stdout.write(`没有 ${channel} 的文风画像，先用 nyra style learn ${channel} <样本文件> 学一套。\n`); return 0; }
        process.stdout.write(formatStyleProfile(profile) + "\n");
        return 0;
      }
      const channels = listStyleProfiles(home);
      if (!channels.length) { process.stdout.write("还没有文风画像，先用 nyra style learn <渠道> <样本文件> 学一套。\n"); return 0; }
      for (const c of channels) {
        const profile = loadStyleProfile(home, c);
        if (profile) process.stdout.write(formatStyleProfile(profile) + "\n\n");
      }
      return 0;
    }
    // nyra style list
    if (cmd === "list") {
      const channels = listStyleProfiles(home);
      if (!channels.length) { process.stdout.write("还没有文风画像。\n"); return 0; }
      for (const c of channels) process.stdout.write(`- ${c}\n`);
      return 0;
    }
    // nyra style delete <渠道> [--yes]
    if (cmd === "delete") {
      const channel = argv[1];
      const yes = argv.includes("--yes");
      if (!channel) { process.stderr.write("用法：nyra style delete <渠道> [--yes]\n"); return 2; }
      let profile;
      try {
        profile = loadStyleProfile(home, channel);
      } catch (err: unknown) {
        process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      if (!profile) { process.stdout.write(`没有 ${channel} 的文风画像，无需删除。\n`); return 0; }
      process.stdout.write("将删除以下文风画像：\n" + formatStyleProfile(profile) + "\n");
      if (!yes) {
        const choice = await askApproval("确认删除这套文风画像吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未删除任何东西。\n"); return 0; }
      }
      deleteStyleProfile(home, channel);
      try {
        new EvidenceStore(join(home, "evidence"), "style").save(
          "style_delete",
          `style://${channel}`,
          [
            "nyra style delete（终端）",
            `渠道：${channel}`,
            `批准：用户（${yes ? "--yes 显式调用" : "终端确认"}）`,
            "删掉的画像：",
            formatStyleProfile(profile),
          ].join("\n"),
        );
      } catch { /* 证据落盘失败不破坏删除结果 */ }
      process.stdout.write(`已删除 ${channel} 的文风画像。\n`);
      return 0;
    }
    // nyra style export
    if (cmd === "export") {
      const { exportStylesSnapshot } = await import("./memoryExchange.ts");
      const text = exportStylesSnapshot(home);
      if (!text) { process.stdout.write("还没有文风画像。\n"); return 0; }
      process.stdout.write(text);
      return 0;
    }
    // nyra style import [文件]
    if (cmd === "import") {
      const { importStylesSnapshot } = await import("./memoryExchange.ts");
      const src = argv[1];
      let text: string;
      try {
        text = src ? await readInput(src) : await readInput("-");
      } catch {
        process.stderr.write(`读不到导入文件：${src}\n`);
        return 1;
      }
      const result = importStylesSnapshot(home, text);
      process.stdout.write(`已导入 ${result.added} 套文风画像，跳过 ${result.skipped} 套${result.removed ? `（已删掉 ${result.removed} 行含凭据的内容）` : ""}。\n`);
      return 0;
    }
    process.stdout.write(STYLE_USAGE + "\n");
    return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2;
  } catch (err: unknown) {
    if (err instanceof StyleError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ---- 子命令：hooks（调研报告第 1 项：Hooks 确定性钩子层，学 Claude Code） ----
// 缺口 19：除 shell 脚本外也列出 config 里的 prompt/agent 条目（含 matcher）。
async function handleHooks(argv: string[], home: string): Promise<number> {
  const HOOKS_USAGE = "用法：\n  nyra hooks list   列出已安装的钩子";
  const cmd = argv[0];
  if (cmd !== undefined && cmd !== "list") {
    process.stderr.write(`未知钩子子命令：${cmd}\n${HOOKS_USAGE}\n`);
    return 2;
  }
  const entries = listHookEntries(home);
  if (!entries.length) {
    process.stdout.write("未安装任何钩子。\n");
    process.stdout.write(`放脚本的位置：${join(home, "hooks", "<事件>.d")}/，例如 ${join(home, "hooks", "PreToolUse.d", "lint.sh")}\n`);
    process.stdout.write("事件：PreToolUse、PostToolUse、SessionStart、SessionEnd、PermissionRequest、SubagentStart、SubagentStop、Stop、PreCompact、PostCompact；用法与例子见 docs/hooks.md。\n");
    return 0;
  }
  for (const event of HOOK_EVENTS) {
    const items = entries.filter((h) => h.event === event);
    if (!items.length) continue;
    process.stdout.write(`${event}：\n`);
    for (const h of items) {
      const matcher = h.tools ? `（仅 ${h.tools.join("、")}）` : "";
      if (h.kind === "command") process.stdout.write(`- [command] ${h.path ?? h.label}${matcher}\n`);
      else if (h.kind === "prompt") process.stdout.write(`- [prompt] ${h.label}${h.model ? `（模型 ${h.model}）` : ""}${matcher}\n`);
      else if (h.kind === "agent") process.stdout.write(`- [agent] ${h.label}${h.model ? `（模型 ${h.model}）` : ""}${matcher}\n`);
      else process.stdout.write(`- [无效] ${h.label}：${h.invalidReason ?? "格式错误"}（用 /status 查看）\n`);
    }
  }
  return 0;
}

// ---- 子命令：status（缺口 19：/status 诊断清单，学 Claude Code 2.1.327） ----
// 只读：只检查、不改任何状态；有错误配置时返回 1（供脚本把关），警告不影响返回码。
async function handleStatus(home: string, workdir: string): Promise<number> {
  const report = runStatusChecks({ home, workdir });
  process.stdout.write(formatStatusReport(report) + "\n");
  return report.errors > 0 ? 1 : 0;
}

// ---- 子命令：evidence（P1-2：证据链独立复核） ----
async function handleEvidence(argv: string[], home: string): Promise<number> {
  const [cmd, runId, ...rest] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      "用法：nyra evidence verify <运行 ID>\n" +
      "独立复核指定运行的证据链（工具调用 → 产物 → 校验结果），不信任状态字段本身，\n" +
      "逐项重算：验证结果、调用闭合、产物存在、产物哈希。\n" +
      "通过返回 0；链不完整返回 4（与 --verify 未通过同码）；用法错误返回 2。\n",
    );
    return EXIT_SUCCESS;
  }
  if (cmd !== "verify" || !runId || rest.length) {
    process.stderr.write("用法：nyra evidence verify <运行 ID>\n");
    return EXIT_ARGUMENT;
  }
  const store = new RunStore(join(home, "runs"));
  try {
    const result = verifyEvidenceChain(store, runId);
    const state = store.load(runId);
    process.stdout.write(formatEvidenceReport(result, computeRunStats(store, runId, state)) + "\n");
    return result.passed ? EXIT_SUCCESS : EXIT_VERIFY;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_RUNTIME;
  }
}

// ---- 子命令：restore（缺口 9，影子快照 + 文件与会话联合回滚） ----
// 回滚本身记进证据链：优先追加到该会话最新的运行记录；该会话尚无运行时
// 新建一条 restore 运行记录（状态 completed），保证 `nyra evidence` 能看到。
function recordRestoreEvidence(home: string, workdir: string, sessionId: string, fields: Record<string, unknown>): void {
  try {
    const runStore = new RunStore(join(home, "runs"));
    const runs = runStore.list().filter((r) => r.session_id === sessionId);
    if (runs.length) {
      runStore.appendEvent(runs[0].run_id, "restore", fields);
    } else {
      const state = runStore.create(`restore ${String(fields.snapshot_id ?? "")}`, sessionId, workdir, "auto", 20, "running");
      runStore.appendEvent(state.run_id, "restore", fields);
      runStore.setStatus(state.run_id, "completed_unverified");
    }
  } catch { /* 证据链写失败不影响已完成的恢复 */ }
}

function formatSnapshotLine(idx: number, rec: SnapshotRecord): string {
  const when = rec.created_at.slice(0, 19).replace("T", " ");
  const target = rec.tool_call.target ?? "（只拍会话）";
  const backend = rec.backend === "git" ? "git" : "文件";
  return `  ${idx}. ${rec.id}  ${when}  ${rec.tool_call.tool} ${target}  [${backend}]  会话 ${rec.message_count} 条`;
}

function printRestoreResult(result: RestoreResult): void {
  const files = result.files_restored.length + result.files_deleted.length;
  if (result.messages_deleted !== null) {
    process.stdout.write(t("repl.restored", {
          id: result.snapshot_id, mode: result.mode, files,
          deleted: result.messages_deleted, kept: result.messages_kept ?? 0,
        }) + "\n");
  } else {
    process.stdout.write(t("repl.restoredFilesOnly", { id: result.snapshot_id, files }) + "\n");
  }
  process.stdout.write(t("repl.restorePending", {
        tool: result.tool_call.tool, target: result.tool_call.target ?? "",
      }) + "\n");
}

function parseRestoreMode(args: string[]): RestoreMode | null {
  let mode: RestoreMode = "both";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") {
      const v = args[i + 1];
      if (v !== "both" && v !== "files" && v !== "session") return null;
      mode = v;
      i++;
    } else {
      return null;
    }
  }
  return mode;
}

async function handleRestore(argv: string[], home: string, workdir: string): Promise<number> {
  const store = new ShadowSnapshotStore(home, workdir);
  const [ref, ...rest] = argv;
  if (ref === undefined) {
    const records = store.list();
    if (!records.length) {
      process.stdout.write(t("repl.restoreNone") + "\n");
      return EXIT_SUCCESS;
    }
    process.stdout.write(t("repl.restoreList", { n: records.length }) + "\n");
    for (let i = 0; i < records.length; i++) process.stdout.write(formatSnapshotLine(i + 1, records[i]) + "\n");
    process.stdout.write(t("repl.restoreUsage") + "\n");
    return EXIT_SUCCESS;
  }
  if (ref === "--help" || ref === "-h") {
    process.stdout.write(
      "用法：nyra restore [检查点序号或 id] [--mode both|files|session]\n" +
      "不带参数列出影子快照；带检查点恢复文件与会话（默认 both：两者一起）。\n" +
      "恢复后原工具调用会重新提出，供重跑、修改后重跑，或忽略。\n",
    );
    return EXIT_SUCCESS;
  }
  const mode = parseRestoreMode(rest);
  if (mode === null) {
    process.stderr.write("用法：nyra restore [检查点序号或 id] [--mode both|files|session]\n");
    return EXIT_ARGUMENT;
  }
  try {
    const record = store.resolve(ref);
    const conv = new ConversationStore(home);
    try {
      const result = store.restore(ref, mode, {
          conversationStore: conv,
          triggeredBy: "cli",
          recordEvidence: (fields) => recordRestoreEvidence(home, workdir, record.session_id, fields),
        });
      // 无 live agent 时，会话文件也要回到快照时刻（否则 --resume 会读回已删的消息）。
      if (result.live_messages !== null) {
        saveSession(result.session_id, [...result.live_messages, { role: "user", content: buildRestoreNote(result) }], home);
      }
      printRestoreResult(result);
    } finally {
      conv.close();
    }
    return EXIT_SUCCESS;
  } catch (err: unknown) {
    process.stderr.write(t("repl.restoreFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return EXIT_RUNTIME;
  }
}

// ---- 子命令：vault（密码箱 CLI，与 python3 -m nyra.vault 同行为） ----
// 密钥只从环境变量 NYRA_VAULT_PASSWORD 或交互输入读，绝不从 argv 读
// （argv 会进进程表和 shell 历史）。
export interface VaultInput {
  passwords?: string[];
  secrets?: string[];
}

export async function handleVault(argv: string[], home: string, input?: VaultInput): Promise<number> {
  const path = join(home, "vault.json");
  const vault = new Vault(path);
  const pwQueue = [...(input?.passwords ?? [])];
  const secretQueue = [...(input?.secrets ?? [])];
  const ask = async (prompt: string): Promise<string> => {
    if (pwQueue.length) return pwQueue.shift()!;
    if (process.env.NYRA_VAULT_PASSWORD) return process.env.NYRA_VAULT_PASSWORD;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
    return answer;
  };
  const askSecret = async (prompt: string): Promise<string> => {
    if (secretQueue.length) return secretQueue.shift()!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
    return answer;
  };
  const unlock = async (): Promise<boolean> => {
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return false;
    }
    if (!vault.unlock(await ask("主密码："))) {
      // 锁死时说清楚要等多久，而不是让用户以为密码错了（审查报告第 2 项）。
      const remaining = vault.lockoutRemainingMs();
      if (remaining > 0) {
        process.stderr.write(`尝试次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试\n`);
      } else {
        process.stderr.write("主密码错误或密码箱已损坏\n");
      }
      return false;
    }
    return true;
  };
  const cmd = argv[0];
  const rest = argv.slice(1);
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(vaultUsage());
      return 0;
    }
    if (cmd === "init") {
      if (rest.length) { process.stderr.write("init 不接受额外参数\n"); return 2; }
      if (vault.exists()) { process.stderr.write(`密码箱已存在：${path}\n`); return 1; }
      const first = await ask("主密码：");
      const second = await ask("再输一次主密码：");
      if (first !== second) { process.stderr.write("两次输入的主密码不一致\n"); return 1; }
      vault.init(first);
      process.stdout.write(`密码箱已创建：${path}\n`);
      return 0;
    }
    if (cmd === "add") {
      if (rest.length !== 1) {
        process.stderr.write("用法：nyra vault add NAME\n密钥用交互输入，绝不要写在命令行里（会进进程表和 shell 历史）。\n");
        return 2;
      }
      const name = rest[0];
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        process.stderr.write(`名字不合法：${name}（只允许字母、数字、_ . -）\n`);
        return 1;
      }
      if (!(await unlock())) return 1;
      const secret = await askSecret("密钥：");
      if (!secret) { process.stderr.write("密钥不能为空\n"); return 1; }
      vault.add(name, secret);
      process.stdout.write(`已保存：${name}\n`);
      return 0;
    }
    if (cmd === "get") {
      if (rest.length !== 1) { process.stderr.write("用法：nyra vault get NAME\n"); return 2; }
      if (!(await unlock())) return 1;
      const value = vault.get(rest[0]);
      if (value === null) { process.stderr.write(`没有这条：${rest[0]}\n`); return 1; }
      process.stdout.write(value + "\n");
      return 0;
    }
    if (cmd === "list") {
      if (rest.length) { process.stderr.write("list 不接受额外参数\n"); return 2; }
      if (!vault.exists()) { process.stderr.write("密码箱不存在，先运行：nyra vault init\n"); return 1; }
      const names = vault.listNames();
      if (!names.length) process.stdout.write("（密码箱为空）\n");
      else for (const n of names) process.stdout.write(n + "\n");
      return 0;
    }
    if (cmd === "remove") {
      if (rest.length !== 1) { process.stderr.write("用法：nyra vault remove NAME\n"); return 2; }
      if (!(await unlock())) return 1;
      vault.remove(rest[0]);
      process.stdout.write(`已删除：${rest[0]}\n`);
      return 0;
    }
    if (cmd === "change-password") {
      if (rest.length) { process.stderr.write("change-password 不接受额外参数\n"); return 2; }
      if (!vault.exists()) { process.stderr.write("密码箱不存在，先运行：nyra vault init\n"); return 1; }
      const oldPw = await ask("旧主密码：");
      if (!vault.unlock(oldPw)) { process.stderr.write("旧主密码错误或密码箱已损坏\n"); return 1; }
      const next = await ask("新主密码：");
      const again = await ask("再输一次新主密码：");
      if (next !== again) { process.stderr.write("两次输入的新主密码不一致\n"); return 1; }
      vault.changePassword(oldPw, next);
      process.stdout.write("主密码已更换\n");
      return 0;
    }
    process.stderr.write(`未知命令：${cmd}\n${vaultUsage()}`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof VaultError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

export interface GmailCliInput {
  passwords?: string[];
  secrets?: string[];
  /** 测试注入：假 Gmail API（Shopify/Slack handler 同款；生产永远用全局 fetch）。 */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** 缺口 6：nyra gmail —— Gmail 连接器的终端入口（状态/授权/搜索/读信/发信/吊销）。 */
export async function handleGmail(argv: string[], home: string, input?: GmailCliInput): Promise<number> {
  const GMAIL_USAGE = "用法：\n"
  + "  nyra gmail status                              查看 Gmail 连接器状态（是否启用、是否已授权、账号邮箱）\n"
  + "  nyra gmail auth                                在浏览器里授权 Gmail（回环回调；client_id/secret 交互输入，只存密码箱）\n"
  + "  nyra gmail search <查询> [--limit N]           按 Gmail 搜索语法找邮件\n"
  + "  nyra gmail read <id>                           读一封邮件全文\n"
  + "  nyra gmail send --to <邮箱> --subject <主题> --body <正文> [--cc <邮箱>] [--bcc <邮箱>] [--thread <id>] [--draft] [--yes]\n"
  + "                                                 发一封邮件（默认先展示确认；--yes 跳过确认；--draft 只存草稿）\n"
  + "  nyra gmail drafts                              列出草稿（只读；主题与收件人用 send-draft 前的确认里展示）\n"
  + "  nyra gmail send-draft <草稿id> [--yes]         发一封草稿（写操作，须显式确认并过红线；草稿不完整不发）\n"
  + "  nyra gmail labels                              列出标签（只读）\n"
  + "  nyra gmail label <id> <标签id> [--yes]         给邮件加标签（写操作，须显式确认）\n"
  + "  nyra gmail unlabel <id> <标签id> [--yes]       给邮件去标签（写操作，须显式确认）\n"
  + "  nyra gmail mark-read <id> [--yes]              标已读（写操作，须显式确认；read 子命令仍是读全文）\n"
  + "  nyra gmail mark-unread <id> [--yes]            标未读（写操作，须显式确认）\n"
  + "  nyra gmail trash <id> [--yes]                  移进回收站（写操作，须显式确认；永久删除本批不提供）\n"
  + "  nyra gmail attachment <messageId> <attachmentId> [--out <路径>]  下载附件并校验（图片只记元信息、文本文档提取内容；--out 原样保存）\n"
  + "  nyra gmail revoke [--yes]                      吊销授权并删除本地 token\n"
  + "详见 docs/connectors-gmail.md";
  const {
    createGmailTransport, exchangeCodeForTokens, buildAuthUrl, newAuthState,
    startLoopbackCallbackServer, getGmailStatus, hasGmailTokensEntry, gmailAuthStateLabel,
    revokeRefreshToken, formatGmailSearchResults, formatGmailMessage,
    buildGmailSendEvidence, GmailApiTransport,
    downloadGmailAttachment, formatGmailAttachmentOutcome, formatGmailLabels, formatGmailDrafts,
    gmailWriteRefusal, GMAIL_WRITE_COMMANDS,
    GMAIL_VAULT_CLIENT_ENTRY, GMAIL_VAULT_TOKENS_ENTRY, GmailError,
  } = await import("./connectors/gmail.ts");
  const { EvidenceStore } = await import("./evidence.ts");
  const pwQueue = [...(input?.passwords ?? [])];
  const secretQueue = [...(input?.secrets ?? [])];
  const ask = async (prompt: string): Promise<string> => {
    if (pwQueue.length) return pwQueue.shift()!;
    if (process.env.NYRA_VAULT_PASSWORD) return process.env.NYRA_VAULT_PASSWORD;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
    return answer;
  };
  const askSecret = async (prompt: string): Promise<string> => {
    if (secretQueue.length) return secretQueue.shift()!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
    return answer;
  };
  const unlockVault = async (): Promise<Vault | null> => {
    const vault = new Vault(join(home, "vault.json"));
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return null;
    }
    if (!vault.unlock(await ask("主密码："))) {
      const remaining = vault.lockoutRemainingMs();
      if (remaining > 0) {
        process.stderr.write(`尝试次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试\n`);
      } else {
        process.stderr.write("主密码错误或密码箱已损坏\n");
      }
      return null;
    }
    return vault;
  };
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const flagValues = (name: string): string[] => {
    const out: string[] = [];
    argv.forEach((a, i) => { if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]); });
    return out;
  };
  /** 写操作确认（改标签/标已读/进回收站，与 send/revoke 同款口径）：
   * --yes 跳过确认，否则交互问一句 y/N；答非 y 即取消（返回 1）。 */
  const confirmWrite = async (prompt: string): Promise<boolean> => {
    if (argv.includes("--yes")) return true;
    const ans = (await ask(`${prompt}[y/N] `)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  };
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(GMAIL_USAGE + "\n");
      return 0;
    }
    // 写意图先拦：永久删除本批连入口都不提供，撞见写词直接回一句明确拒绝。
    if ((GMAIL_WRITE_COMMANDS as readonly string[]).includes(cmd)) {
      process.stderr.write(gmailWriteRefusal(cmd) + "\n");
      return 1;
    }
    if (cmd === "status") {
      const status = getGmailStatus(home, loadConfig(home));
      process.stdout.write(`Gmail 连接器：${status.enabled ? "已启用" : "未启用（默认关闭）"}\n`);
      process.stdout.write(`授权：${status.configured ? "已授权" : "未授权"}\n`);
      process.stdout.write(`授权状态：${gmailAuthStateLabel(status.authState)}${status.authState === "authorized" || status.authState === "unauthorized" ? "" : "（请重新运行 nyra gmail auth）"}\n`);
      if (status.email) process.stdout.write(`账号：${status.email}\n`);
      else if (status.configured) process.stdout.write("账号：（密码箱未解锁，看不到账号邮箱）\n");
      if (status.scopes) process.stdout.write(`scope：${status.scopes}\n`);
      if (!status.enabled || !status.configured) process.stdout.write("运行 nyra gmail auth 完成授权（授权成功会自动启用）。\n");
      return 0;
    }
    if (cmd === "auth") {
      const vault = await unlockVault();
      if (!vault) return 1;
      // OAuth 客户端：先读密码箱里已有的，没有再交互输入（绝不写命令行）。
      let client: { client_id: string; client_secret: string } | null = null;
      const rawClient = vault.get(GMAIL_VAULT_CLIENT_ENTRY);
      if (rawClient) {
        try {
          const d = JSON.parse(rawClient) as Record<string, unknown>;
          if (typeof d.client_id === "string" && d.client_id && typeof d.client_secret === "string" && d.client_secret) {
            client = { client_id: d.client_id, client_secret: d.client_secret };
          }
        } catch { /* 损坏的客户端条目按没有处理，下面重新输入 */ }
      }
      if (!client) {
        process.stdout.write("第一次授权需要 Google Cloud 的 OAuth 客户端（Desktop app 类型）：\n");
        process.stdout.write("  在 console.cloud.google.com 建好 OAuth 2.0 客户端后，把 client_id 与 client_secret 粘贴进来（只存密码箱，不进配置文件）。\n");
        const clientId = (await askSecret("client_id：")).trim();
        const clientSecret = (await askSecret("client_secret：")).trim();
        if (!clientId || !clientSecret) {
          process.stderr.write("client_id 与 client_secret 不能为空\n");
          return 1;
        }
        client = { client_id: clientId, client_secret: clientSecret };
        vault.add(GMAIL_VAULT_CLIENT_ENTRY, JSON.stringify(client), true);
      }
      const state = newAuthState();
      const server = await startLoopbackCallbackServer({ state });
      process.stdout.write("请在浏览器里打开下面的链接完成 Google 授权：\n");
      process.stdout.write(buildAuthUrl({ clientId: client.client_id, redirectUri: server.redirectUri, state }) + "\n");
      process.stdout.write("（授权成功后回到这里；5 分钟内没完成请重新运行 nyra gmail auth）\n");
      let code: string;
      try {
        code = await server.waitForCode();
      } finally {
        server.close();
      }
      const tokens = await exchangeCodeForTokens({ client, code, redirectUri: server.redirectUri });
      let email: string | undefined;
      try {
        email = await new GmailApiTransport({ tokens, client }).profileEmail();
      } catch { /* 取不到邮箱不拦授权：状态里只显示“已授权” */ }
      vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify({ ...tokens, ...(email ? { email } : {}) }), true);
      const cfg = loadConfig(home);
      saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), gmail: { enabled: true } } });
      // 缺口 44 第 0 批：授权成功即在状态机里记一笔“已授权”（批准一次，之后不再重复问）。
      try {
        const { markConnectorAuthorized, resolveConnectorUserId, tokenFingerprint } = await import("./connectors/registry.ts");
        markConnectorAuthorized(home, "gmail", resolveConnectorUserId(home), {
          tokenFingerprint: tokenFingerprint(tokens.refresh_token),
          ...(tokens.scope ? { scopes: tokens.scope } : {}),
        });
      } catch { /* 状态记录失败不破坏授权本身：下次调用时会沿用已有凭证迁移 */ }
      process.stdout.write(`授权成功${email ? `：${email}` : ""}，Gmail 连接器已启用。\n`);
      return 0;
    }
    if (cmd === "search") {
      const query = argv[1];
      if (!query) {
        process.stderr.write("用法：nyra gmail search <查询> [--limit N]\n");
        return 2;
      }
      const limitRaw = flagValue("--limit");
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      const transport = createGmailTransport(home, loadConfig(home));
      const { messages, nextPageToken } = await transport.search(query, limit);
      process.stdout.write(formatGmailSearchResults(messages, nextPageToken) + "\n");
      return 0;
    }
    if (cmd === "read") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra gmail read <id>\n");
        return 2;
      }
      const transport = createGmailTransport(home, loadConfig(home));
      process.stdout.write(formatGmailMessage(await transport.get(id)) + "\n");
      return 0;
    }
    if (cmd === "labels") {
      const transport = createGmailTransport(home, loadConfig(home));
      process.stdout.write(formatGmailLabels(await transport.listLabels()) + "\n");
      return 0;
    }
    if (cmd === "label" || cmd === "unlabel") {
      const id = argv[1];
      const labelId = argv[2];
      if (!id || !labelId) {
        process.stderr.write(`用法：nyra gmail ${cmd} <id> <标签id> [--yes]\n`);
        return 2;
      }
      const transport = createGmailTransport(home, loadConfig(home));
      const action = cmd === "label" ? "加标签" : "去标签";
      if (!(await confirmWrite(`确认给邮件 ${id} ${action} ${labelId}？`))) {
        process.stdout.write("已取消，未修改。\n");
        return 1;
      }
      const result = cmd === "label"
        ? await transport.modifyLabels(id, [labelId], [])
        : await transport.modifyLabels(id, [], [labelId]);
      process.stdout.write(`已给邮件 ${result.id} ${action} ${labelId}（当前标签：${result.labelIds.join("、") || "无"}）。\n`);
      return 0;
    }
    if (cmd === "mark-read" || cmd === "mark-unread") {
      const id = argv[1];
      if (!id) {
        process.stderr.write(`用法：nyra gmail ${cmd} <id> [--yes]\n`);
        return 2;
      }
      const transport = createGmailTransport(home, loadConfig(home));
      const action = cmd === "mark-read" ? "标已读" : "标未读";
      if (!(await confirmWrite(`确认给邮件 ${id} ${action}？`))) {
        process.stdout.write("已取消，未修改。\n");
        return 1;
      }
      const result = cmd === "mark-read" ? await transport.markRead(id) : await transport.markUnread(id);
      process.stdout.write(`已给邮件 ${result.id} ${action}（当前标签：${result.labelIds.join("、") || "无"}）。\n`);
      return 0;
    }
    if (cmd === "trash") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra gmail trash <id> [--yes]\n");
        return 2;
      }
      const transport = createGmailTransport(home, loadConfig(home));
      if (!(await confirmWrite(`确认把邮件 ${id} 移进回收站？（可恢复，不是永久删除）`))) {
        process.stdout.write("已取消，未删除。\n");
        return 1;
      }
      const result = await transport.trash(id);
      process.stdout.write(`已把邮件 ${result.id} 移进回收站（可在 Gmail 网页端恢复或永久删除）。\n`);
      return 0;
    }
    if (cmd === "attachment") {
      const messageId = argv[1];
      const attachmentId = argv[2];
      const outPath = flagValue("--out");
      if (!messageId || !attachmentId) {
        process.stderr.write("用法：nyra gmail attachment <messageId> <attachmentId> [--out <路径>]\n");
        return 2;
      }
      const transport = createGmailTransport(home, loadConfig(home));
      const outcome = await downloadGmailAttachment(transport, messageId, attachmentId);
      if (outPath) {
        try {
          writeFileSync(outPath, outcome.bytes, { mode: 0o600 });
          process.stdout.write(`已保存到：${outPath}\n`);
        } catch (err: unknown) {
          process.stderr.write(`保存失败：${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
      }
      process.stdout.write(formatGmailAttachmentOutcome(outcome) + "\n");
      return 0;
    }
    if (cmd === "send") {
      const to = flagValues("--to").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
      const cc = flagValues("--cc").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
      const bcc = flagValues("--bcc").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
      const subject = flagValue("--subject");
      const body = flagValue("--body");
      const threadId = flagValue("--thread");
      const draft = argv.includes("--draft");
      const yes = argv.includes("--yes");
      if (!to.length || subject === undefined || body === undefined) {
        process.stderr.write("用法：nyra gmail send --to <邮箱> --subject <主题> --body <正文> [--cc <邮箱>] [--bcc <邮箱>] [--thread <id>] [--draft] [--yes]\n");
        return 2;
      }
      // 先建 transport（未启用/未授权直接报错，不走到确认那一步）。
      const transport = createGmailTransport(home, loadConfig(home));
      if (!yes) {
        process.stdout.write(`收件人：${to.join(", ")}\n`);
        if (cc.length) process.stdout.write(`抄送：${cc.join(", ")}\n`);
        if (bcc.length) process.stdout.write(`密送：${bcc.join(", ")}\n`);
        process.stdout.write(`主题：${subject}\n`);
        if (threadId) process.stdout.write(`回复原串 threadId：${threadId}\n`);
        process.stdout.write(`正文：\n${body}\n`);
        const ans = (await ask(draft ? "确认保存草稿？[y/N] " : "确认发送？[y/N] ")).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("已取消，未发送。\n");
          return 1;
        }
      }
      // 缺口 51：业务动作红线——发消息是永远须人批档（--yes/交互确认已满足），
      // 但用户若把 send_message 收紧到永远禁做，即使已批准也拒绝；草稿是自由做档。
      const gmailRedline = reviewBusinessAction({ home, connector: "gmail", action: draft ? "draft" : "send_message", approved: true });
      if (gmailRedline.decision === "BLOCK") {
        try {
          appendBusinessRedlineAudit(home, { kind: "blocked", connector: "gmail", action: draft ? "draft" : "send_message", tier: "never", via: "cli-gmail-send" });
        } catch { /* 审计落盘失败不破坏拦截 */ }
        process.stderr.write(`红线拦截：${gmailRedline.reason}\n`);
        return 1;
      }
      const result = draft
      ? await transport.createDraft({ to, cc, bcc, subject, body, ...(threadId ? { threadId } : {}) })
      : await transport.send({ to, cc, bcc, subject, body, ...(threadId ? { threadId } : {}) });
      try {
        new EvidenceStore(join(home, "evidence"), "gmail").save("gmail_send", `gmail://${result.id}`, buildGmailSendEvidence({
              to, cc, bcc, subject, body, threadId, draft,
              resultId: result.id, approvalChannel: "终端命令（nyra gmail send）", mode: "full",
            }));
      } catch { /* 证据落盘失败不破坏发送结果 */ }
      process.stdout.write(draft ? `已存为草稿（草稿 id：${result.id}）。\n` : `已发送（邮件 id：${result.id}）。\n`);
      return 0;
    }
    if (cmd === "drafts") {
      const transport = createGmailTransport(home, loadConfig(home), { ...(input?.fetchFn ? { fetchFn: input.fetchFn } : {}) });
      const drafts = await transport.listDrafts();
      process.stdout.write(formatGmailDrafts(drafts) + "\n");
      return 0;
    }
    if (cmd === "send-draft") {
      const draftId = argv[1];
      if (!draftId) {
        process.stderr.write("用法：nyra gmail send-draft <草稿id> [--yes]\n");
        return 2;
      }
      const transport = createGmailTransport(home, loadConfig(home), { ...(input?.fetchFn ? { fetchFn: input.fetchFn } : {}) });
      const draft = await transport.getDraft(draftId);
      if (!draft.to.trim() || !draft.subject.trim()) {
        process.stderr.write(`草稿 ${draftId} 不完整（收件人或主题为空），不发。\n`);
        return 1;
      }
      if (!argv.includes("--yes")) {
        process.stdout.write(`收件人：${draft.to}\n主题：${draft.subject}\n`);
        if (draft.snippet) process.stdout.write(`摘要：${draft.snippet}\n`);
        const ans = (await ask("确认发送这封草稿？[y/N] ")).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("已取消，未发送。\n");
          return 1;
        }
      }
      // 与 send 同款门：发消息是永远须人批档（确认已满足），收紧到永远禁做时即使已批准也拒绝。
      const gmailRedline = reviewBusinessAction({ home, connector: "gmail", action: "send_message", approved: true });
      if (gmailRedline.decision === "BLOCK") {
        try {
          appendBusinessRedlineAudit(home, { kind: "blocked", connector: "gmail", action: "send_message", tier: "never", via: "cli-gmail-send-draft" });
        } catch { /* 审计落盘失败不破坏拦截 */ }
        process.stderr.write(`红线拦截：${gmailRedline.reason}\n`);
        return 1;
      }
      const result = await transport.sendDraft(draftId);
      try {
        new EvidenceStore(join(home, "evidence"), "gmail").save("gmail_send", `gmail://${result.id}`, [
          "工具：gmail_send（草稿发送）",
          `收件人：${draft.to}`,
          `主题：${draft.subject}`,
          ...(draft.threadId ? [`回复原串 threadId：${draft.threadId}`] : []),
          "批准：用户经终端命令（nyra gmail send-draft）批准（full 模式）",
          `草稿 id：${draftId}`,
          `邮件 id：${result.id}`,
          "正文：发送前未读取（以 Gmail 服务端草稿原文为准）。",
        ].join("\n"));
      } catch { /* 证据落盘失败不破坏发送结果 */ }
      process.stdout.write(`已发送草稿 ${draftId}（邮件 id：${result.id}）。\n`);
      return 0;
    }
    if (cmd === "revoke") {
      if (!hasGmailTokensEntry(home)) {
        process.stdout.write("Gmail 未授权，无需吊销。\n");
        return 0;
      }
      if (!argv.includes("--yes")) {
        const ans = (await ask("确认吊销 Gmail 授权并删除本地 token？[y/N] ")).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("已取消。\n");
          return 1;
        }
      }
      const vault = await unlockVault();
      if (!vault) return 1;
      const raw = vault.get(GMAIL_VAULT_TOKENS_ENTRY);
      let refreshToken: string | undefined;
      try {
        const d = JSON.parse(raw ?? "") as Record<string, unknown>;
        if (typeof d.refresh_token === "string") refreshToken = d.refresh_token;
      } catch { /* 损坏的 token 条目直接删 */ }
      if (refreshToken) {
        try { await revokeRefreshToken({ token: refreshToken }); } catch { /* Google 吊销失败也不拦本地清理 */ }
      }
      try { vault.remove(GMAIL_VAULT_TOKENS_ENTRY); } catch { /* 条目已不在就当删过了 */ }
      const cfg = loadConfig(home);
      saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), gmail: { enabled: false } } });
      // 缺口 44 第 0 批：吊销即在状态机里记“已撤销”——之后每次调用都直接拒绝，
      // 不等下次启动才失效；token 已删，迁移沿用那条路也被堵死了。
      try {
        const { markConnectorRevoked, resolveConnectorUserId } = await import("./connectors/registry.ts");
        markConnectorRevoked(home, "gmail", resolveConnectorUserId(home));
      } catch { /* 状态记录失败不改变吊销本身（token 已删，调用方照样进不去） */ }
      process.stdout.write("Gmail 授权已吊销，本地 token 已删除，连接器已关闭。\n");
      return 0;
    }
    process.stderr.write(`未知命令：${cmd}\n${GMAIL_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof GmailError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** 缺口 44 第 0 批：nyra connector —— 连接器授权状态机的终端入口（状态/列表/批准/撤销）。 */
export async function handleConnector(argv: string[], home: string): Promise<number> {
  const CONNECTOR_USAGE = "用法：\n"
  + "  nyra connector list                              列出全部连接器与授权状态\n"
  + "  nyra connector status [连接器]                   查看一个/全部连接器的授权状态与权限声明\n"
  + "  nyra connector approve <连接器>                  显式批准一次：批准后同应用同用户不再重复问\n"
  + "  nyra connector revoke <连接器> [--yes]           撤销授权（立即失效；Gmail 吊销远端 token 并删除本地 token；Shopify/Slack 删除本地凭证）\n"
  + "  nyra connector auth <连接器>                     一键连接：走该连接器自己的授权流程（OAuth 登录即用）\n"
  + "  nyra connector install <连接器>                  安装到目录：把连接器登记进你的目录（只装声明里有的；试点装不了）\n"
  + "  nyra connector uninstall <连接器> [--yes]        从目录卸载：同时撤销授权，访问立即断\n"
  + "  nyra connector usage [连接器]                    用量：每个连接器的调用次数（总次数、分操作次数、最后调用时间）\n"
  + "  nyra connector flows                             列出全部业务流程（每条一条真实业务流程 + 验收标准）\n"
  + "  nyra connector flow <流程id> [参数]              跑一条业务流程：slack-approval-roundtrip / shopify-order-fulfillment / gmail-draft-send（--json 输出结论）\n"
  + "  nyra connector bundle <连接器> [--out <目录>]    导出连接器包（四件套：权限声明 + 工具清单 + 业务流程 + 红线表，机器人市场验证用）\n"
  + "详见 docs/connectors.md";
  const reg = await import("./connectors/registry.ts");
  const dirMod = await import("./connectors/directory.ts");
  const gmailMod = await import("./connectors/gmail.ts");
  const shopifyMod = await import("./connectors/shopify.ts");
  const slackMod = await import("./connectors/slack.ts");
  const userId = reg.resolveConnectorUserId(home);
  const cmd = argv[0];
  const knownIds = reg.listDeclarations().map((d) => d.id).join("、");

  /** 密码箱里有没有该连接器的凭证（Gmail 与 Shopify 有真实凭证；试点连接器一律没有）。 */
  const hasTokensEvidence = (connectorId: string): boolean => {
    if (connectorId === "gmail") return gmailMod.hasGmailTokensEntry(home);
    if (connectorId === "shopify") return shopifyMod.hasShopifyCredentialsEntry(home);
    if (connectorId === "slack") return slackMod.hasSlackCredentialsEntry(home);
    return false;
  };

  const printOne = (connectorId: string, detailed: boolean): void => {
    const decl = reg.getDeclaration(connectorId);
    if (!decl) return;
    const state = reg.peekConnectorState(home, connectorId, userId, { hasTokens: hasTokensEvidence(connectorId) });
    const record = new reg.ConnectorAuthStore(home).get(connectorId, userId);
    const pilot = decl.status === "pilot" ? "（试点：尚未接入）" : "";
    const installed = dirMod.isConnectorInstalled(home, connectorId);
    const usage = dirMod.getConnectorUsage(home, connectorId);
    process.stdout.write(`${decl.displayName}（${decl.id}）：${reg.CONNECTOR_AUTH_STATE_LABELS[state]}${pilot}、${installed ? "已安装" : "未安装"}、调用 ${usage.totalCalls} 次\n`);
    if (!detailed) return;
    const dirRecord = new dirMod.ConnectorDirectoryStore(home).get(connectorId);
    if (dirRecord?.installedAt) process.stdout.write(`  安装于：${dirRecord.installedAt}\n`);
    if (usage.lastCalledAt) process.stdout.write(`  最后调用：${usage.lastCalledAt}\n`);
    if (record?.approvedAt) process.stdout.write(`  批准于：${record.approvedAt}\n`);
    if (record?.tokenFingerprint) process.stdout.write(`  token 指纹：${record.tokenFingerprint}…\n`);
    if (record?.scopes) process.stdout.write(`  scope：${record.scopes}\n`);
    if (record?.migratedFrom) process.stdout.write(`  备注：沿用已有授权迁移（${record.migratedFrom}）\n`);
    process.stdout.write(`  读：${decl.scopes.read.join("、") || "无"}\n`);
    process.stdout.write(`  写：${decl.scopes.write.join("、") || "无"}\n`);
    for (const g of decl.toolGroups) {
      process.stdout.write(`  工具组「${g.name}」（${g.access === "read" ? "只读" : "可写"}）：${g.tools.join("、")}\n`);
    }
    process.stdout.write(`  会访问的数据：${decl.dataAccessed.join("；")}\n`);
    process.stdout.write(`  永远须人批：${decl.alwaysRequireApproval.join("、") || "无"}\n`);
    process.stdout.write(`  永远禁做：${decl.alwaysForbidden.join("、")}\n`);
  };

  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(CONNECTOR_USAGE + "\n");
      return 0;
    }
    if (cmd === "list") {
      for (const decl of reg.listDeclarations()) printOne(decl.id, false);
      return 0;
    }
    if (cmd === "status") {
      const target = argv[1];
      if (!target) {
        for (const decl of reg.listDeclarations()) printOne(decl.id, true);
        return 0;
      }
      if (!reg.getDeclaration(target)) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      printOne(target, true);
      return 0;
    }
    if (cmd === "approve") {
      const target = argv[1];
      if (!target) {
        process.stderr.write("用法：nyra connector approve <连接器>\n");
        return 2;
      }
      const decl = reg.getDeclaration(target);
      if (!decl) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      if (decl.status === "pilot") {
        process.stderr.write(`${decl.displayName} 连接器尚未接入（试点），下一批做深连接器时开放。\n`);
        return 1;
      }
      const current = reg.peekConnectorState(home, target, userId, { hasTokens: hasTokensEvidence(target) });
      if (current === "authorized") {
        process.stdout.write(`${decl.displayName} 已经是已授权状态，无需重复批准。\n`);
        return 0;
      }
      if (!hasTokensEvidence(target)) {
        process.stderr.write(`${decl.displayName} 还没有凭证：请先运行 ${reg.reauthHint(target)} 完成授权，再批准。\n`);
        return 1;
      }
      const tokens = target === "gmail" ? gmailMod.loadGmailTokens(home) : null;
      const shopifyCreds = target === "shopify" ? shopifyMod.loadShopifyCredentials(home) : null;
      const slackCreds = target === "slack" ? slackMod.loadSlackCredentials(home) : null;
      if (target === "shopify" && !shopifyCreds) {
        process.stderr.write("Shopify 凭证损坏或缺失：请重新运行 nyra shopify auth。\n");
        return 1;
      }
      if (target === "slack" && !slackCreds) {
        process.stderr.write("Slack 凭证损坏或缺失：请重新运行 nyra slack auth。\n");
        return 1;
      }
      reg.markConnectorAuthorized(home, target, userId, {
        ...(tokens ? { tokenFingerprint: reg.tokenFingerprint(tokens.refresh_token) } : {}),
        ...(shopifyCreds ? { tokenFingerprint: reg.tokenFingerprint(shopifyCreds.accessToken), scopes: shopifyMod.SHOPIFY_READ_SCOPES.join(",") } : {}),
        ...(slackCreds ? { tokenFingerprint: reg.tokenFingerprint(slackCreds.token), scopes: [...slackMod.SLACK_READ_SCOPES, ...slackMod.SLACK_WRITE_SCOPES].join(",") } : {}),
        ...(tokens?.scope ? { scopes: tokens.scope } : {}),
      });
      process.stdout.write(`已批准使用 ${decl.displayName}：之后同应用同用户不再重复问。\n`);
      return 0;
    }
    if (cmd === "revoke") {
      const target = argv[1];
      if (!target) {
        process.stderr.write("用法：nyra connector revoke <连接器> [--yes]\n");
        return 2;
      }
      const decl = reg.getDeclaration(target);
      if (!decl) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      if (!argv.includes("--yes")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await new Promise<string>((resolvePromise) => {
          rl.question(`确认撤销 ${decl.displayName} 的授权？撤销后立即失效（[y/N] `, (a) => { rl.close(); resolvePromise(a); });
        })).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("已取消。\n");
          return 1;
        }
      }
      // 先记撤销（立即失效），再做清理：即使后面哪步失败，连接器也已经用不了了。
      reg.markConnectorRevoked(home, target, userId);
      if (target === "gmail") {
        const vault = new Vault(join(home, "vault.json"));
        if (vault.exists()) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const password = await new Promise<string>((resolvePromise) => {
            rl.question("主密码：", (a) => { rl.close(); resolvePromise(a); });
          });
          if (vault.unlock(password)) {
            const raw = vault.get(gmailMod.GMAIL_VAULT_TOKENS_ENTRY);
            let refreshToken: string | undefined;
            try {
              const d = JSON.parse(raw ?? "") as Record<string, unknown>;
              if (typeof d.refresh_token === "string" && d.refresh_token) refreshToken = d.refresh_token;
            } catch { /* 损坏的 token 条目直接删 */ }
            if (refreshToken) {
              try { await gmailMod.revokeRefreshToken({ token: refreshToken }); } catch { /* Google 吊销失败也不拦本地清理 */ }
            }
            try { vault.remove(gmailMod.GMAIL_VAULT_TOKENS_ENTRY); } catch { /* 条目已不在就当删过了 */ }
          }
        }
        const cfg = loadConfig(home);
        saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), gmail: { enabled: false } } });
      }
      if (target === "shopify") {
        // 只删本地凭证：自定义应用的 token 没有远端吊销接口，Shopify 后台
        // 的 custom app 仍需用户手动删除才能彻底作废 token（见 docs）。
        const vault = new Vault(join(home, "vault.json"));
        if (vault.exists()) {
          const password = process.env.NYRA_VAULT_PASSWORD ?? await new Promise<string>((resolvePromise) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question("主密码：", (a) => { rl.close(); resolvePromise(a); });
          });
          if (vault.unlock(password)) {
            try { vault.remove(shopifyMod.SHOPIFY_VAULT_CREDENTIALS_ENTRY); } catch { /* 条目已不在就当删过了 */ }
          }
        }
        const cfg = loadConfig(home);
        saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), shopify: { enabled: false } } });
        process.stdout.write("注意：本地凭证已删，但 Shopify 后台的自定义应用仍在——想彻底作废 token，请去 Shopify 后台删除该自定义应用。\n");
      }
      if (target === "slack") {
        // 只删本地凭证：Bot token 没有 CLI 可调的远端吊销接口，Slack 后台
        // 的 app 仍在——想彻底作废 token，请去 Slack 后台撤销/删除该 app 的 token（见 docs）。
        const vault = new Vault(join(home, "vault.json"));
        if (vault.exists()) {
          const password = process.env.NYRA_VAULT_PASSWORD ?? await new Promise<string>((resolvePromise) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question("主密码：", (a) => { rl.close(); resolvePromise(a); });
          });
          if (vault.unlock(password)) {
            try { vault.remove(slackMod.SLACK_VAULT_CREDENTIALS_ENTRY); } catch { /* 条目已不在就当删过了 */ }
          }
        }
        const cfg = loadConfig(home);
        saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), slack: { enabled: false } } });
        process.stdout.write("注意：本地凭证已删，但 Slack 后台的 app 仍在——想彻底作废 token，请去 Slack 后台撤销该 app 的 Bot token。\n");
      }
      process.stdout.write(`${decl.displayName} 的授权已撤销，立即失效。\n`);
      return 0;
    }
    if (cmd === "auth") {
      // 缺口 44 第一批：统一的一键连接入口——OAuth 登录即用；具体流程复用各
      // 连接器自己的授权实现（Gmail 的 loopback 回调、Shopify 的粘贴 token、
      // Slack 的粘贴 Bot token），这里只做路由，不另起一套 OAuth。
      const target = argv[1];
      if (!target) {
        process.stderr.write("用法：nyra connector auth <连接器>\n");
        return 2;
      }
      const decl = reg.getDeclaration(target);
      if (!decl) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      if (decl.status === "pilot") {
        process.stderr.write(`${decl.displayName} 连接器尚未接入（试点），下一批做深连接器时开放。\n`);
        return 1;
      }
      if (target === "gmail") return handleGmail(["auth"], home);
      if (target === "shopify") return handleShopify(["auth"], home);
      if (target === "slack") return handleSlack(["auth"], home);
      process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
      return 2;
    }
    if (cmd === "install") {
      const target = argv[1];
      if (!target) {
        process.stderr.write("用法：nyra connector install <连接器>\n");
        return 2;
      }
      const decl = reg.getDeclaration(target);
      if (!decl) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      const record = dirMod.installConnector(home, target, userId);
      process.stdout.write(`已安装 ${decl.displayName} 到目录（安装于 ${record.installedAt}）。\n`);
      process.stdout.write(`  读：${decl.scopes.read.join("、") || "无"}\n`);
      process.stdout.write(`  写：${decl.scopes.write.join("、") || "无"}\n`);
      process.stdout.write(`  永远须人批：${decl.alwaysRequireApproval.join("、") || "无"}\n`);
      process.stdout.write(`  永远禁做：${decl.alwaysForbidden.join("、")}\n`);
      process.stdout.write(`下一步：运行 nyra connector auth ${target} 完成授权。\n`);
      return 0;
    }
    if (cmd === "uninstall") {
      const target = argv[1];
      if (!target) {
        process.stderr.write("用法：nyra connector uninstall <连接器> [--yes]\n");
        return 2;
      }
      const decl = reg.getDeclaration(target);
      if (!decl) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      if (!dirMod.isConnectorInstalled(home, target)) {
        process.stderr.write(`${decl.displayName} 还没安装，无需卸载。\n`);
        return 1;
      }
      if (!argv.includes("--yes")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await new Promise<string>((resolvePromise) => {
          rl.question(`确认卸载 ${decl.displayName}？卸载后授权同时撤销、访问立即断（[y/N] `, (a) => { rl.close(); resolvePromise(a); });
        })).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("已取消。\n");
          return 1;
        }
      }
      dirMod.uninstallConnector(home, target, userId);
      process.stdout.write(`${decl.displayName} 已从目录卸载，授权同时撤销、访问立即断。\n`);
      return 0;
    }
    if (cmd === "usage") {
      const target = argv[1];
      const showOne = (connectorId: string): void => {
        const decl = reg.getDeclaration(connectorId);
        if (!decl) return;
        const usage = dirMod.getConnectorUsage(home, connectorId);
        process.stdout.write(`${decl.displayName}（${connectorId}）：调用 ${usage.totalCalls} 次`);
        process.stdout.write(usage.lastCalledAt ? `，最后调用 ${usage.lastCalledAt}\n` : "，尚未调用过\n");
        const ops = Object.entries(usage.operations).sort((a, b) => b[1] - a[1]);
        for (const [op, count] of ops) process.stdout.write(`  ${op}：${count} 次\n`);
      };
      if (!target) {
        for (const decl of reg.listDeclarations()) showOne(decl.id);
        return 0;
      }
      if (!reg.getDeclaration(target)) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      showOne(target);
      return 0;
    }
    if (cmd === "flows") {
      const { listConnectorFlows } = await import("./connectors/flows.ts");
      for (const f of listConnectorFlows()) {
        process.stdout.write(`${f.id}（${f.connector}）：${f.title}\n  ${f.description}\n  步骤：${f.steps.join(" → ")}\n  验收：${f.acceptance.join("、")}\n`);
      }
      return 0;
    }
    if (cmd === "flow") {
      const flowId = argv[1];
      if (!flowId) {
        process.stderr.write("用法：nyra connector flow <流程id> [参数]（nyra connector flows 列出能用的流程）\n");
        return 2;
      }
      const flagValue = (name: string): string | undefined => {
        const idx = argv.indexOf(name);
        return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
      };
      const { runConnectorFlow, getConnectorFlow, formatFlowResult } = await import("./connectors/flows.ts");
      const def = getConnectorFlow(flowId);
      if (!def) {
        process.stderr.write(`未知业务流程：${flowId}（nyra connector flows 列出能用的流程）\n`);
        return 2;
      }
      const input: Record<string, unknown> = {};
      let bridge: import("./bot/approvalBridge.ts").ApprovalBridge | undefined;
      if (flowId === "slack-approval-roundtrip") {
        const payloadRaw = flagValue("--payload");
        if (!payloadRaw) {
          process.stderr.write("用法：nyra connector flow slack-approval-roundtrip --payload <json> [--by <用户id>]\n");
          return 2;
        }
        input.payload = payloadRaw;
        const { ApprovalBridge } = await import("./bot/approvalBridge.ts");
        const { botPolicyFromConfig } = await import("./bot/types.ts");
        const policy = botPolicyFromConfig(loadConfig(home));
        bridge = new ApprovalBridge({ home, policy, send: async () => { throw new Error("CLI 不发审批提示"); } });
        const decidedBy = flagValue("--by") ?? policy.owner ?? "";
        if (!decidedBy) {
          process.stderr.write("没配决定人：传 --by <用户id>，或在配置里配 bot.owner（只认 owner/admin 白名单）。\n");
          return 2;
        }
        input.decidedBy = decidedBy;
      } else if (flowId === "shopify-order-fulfillment") {
        const orderId = flagValue("--order") ?? argv[2];
        if (!orderId) {
          process.stderr.write("用法：nyra connector flow shopify-order-fulfillment --order <id>\n");
          return 2;
        }
        input.orderId = orderId;
      } else if (flowId === "gmail-draft-send") {
        const draftId = flagValue("--draft") ?? argv[2];
        if (!draftId) {
          process.stderr.write("用法：nyra connector flow gmail-draft-send --draft <id> [--yes]\n");
          return 2;
        }
        input.draftId = draftId;
        // 发草稿是写操作：先读草稿展示收件人/主题给用户确认（--yes 跳过），确认后才跑流程。
        const transport = gmailMod.createGmailTransport(home, loadConfig(home));
        const draft = await transport.getDraft(draftId);
        if (!draft.to.trim() || !draft.subject.trim()) {
          process.stderr.write(`草稿 ${draftId} 不完整（收件人或主题为空），不发。\n`);
          return 1;
        }
        if (!argv.includes("--yes")) {
          process.stdout.write(`收件人：${draft.to}\n主题：${draft.subject}\n`);
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const ans = (await new Promise<string>((resolvePromise) => {
            rl.question("确认发送这封草稿？[y/N] ", (a) => { rl.close(); resolvePromise(a); });
          })).trim().toLowerCase();
          if (ans !== "y" && ans !== "yes") {
            process.stdout.write("已取消，未发送。\n");
            return 1;
          }
        }
        input.approved = true;
      }
      const result = await runConnectorFlow(home, loadConfig(home), flowId, input, { ...(bridge ? { bridge } : {}) });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(formatFlowResult(result) + "\n");
      }
      return result.passed ? 0 : 1;
    }
    if (cmd === "bundle") {
      // 缺口 44 深化：导出连接器包（四件套）到目录，机器人市场验证用。
      // 导出前先校验（声明/红线表/流程/工具四件套齐全才导出，fail-closed）。
      const target = argv[1];
      if (!target) {
        process.stderr.write("用法：nyra connector bundle <连接器> [--out <目录>]\n");
        return 2;
      }
      const decl = reg.getDeclaration(target);
      if (!decl) {
        process.stderr.write(`未知连接器：${target}（已知：${knownIds}）\n`);
        return 2;
      }
      const outIdx = argv.indexOf("--out");
      const outDir = outIdx >= 0 && argv[outIdx + 1] !== undefined
        ? argv[outIdx + 1]!
        : join(process.cwd(), `nyra-connector-${target}`);
      const { exportConnectorBundle } = await import("./connectors/bundle.ts");
      const { TOOL_SCHEMAS } = await import("./tools.ts");
      const exported = exportConnectorBundle(home, target, outDir, new Set(Object.keys(TOOL_SCHEMAS)));
      process.stdout.write(`已导出 ${decl.displayName} 连接器包到 ${exported.dir}\n`);
      process.stdout.write(`工具 ${exported.bundle.tools.length} 个（模型 ${exported.bundle.tools.filter((t) => t.surface === "model").length}、终端 ${exported.bundle.tools.filter((t) => t.surface === "cli").length}）、流程 ${exported.bundle.flows.length} 条、红线表 ${exported.bundle.redlineTable}\n`);
      process.stdout.write(`文件：${exported.files.join("、")}\n`);
      process.stdout.write(`市场验证：把包放进策展仓库索引后，用 nyra market verify connector-${target} 校验（连接器条目只验证、不安装）。\n`);
      return 0;
    }
    process.stderr.write(`未知命令：${cmd}\n${CONNECTOR_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** 缺口 44 第一批：nyra shopify —— Shopify 连接器的终端入口（只读：授权/状态/查商品/查订单/查库存）。 */
export interface ShopifyCliInput {
  /** 测试注入：按顺序回答交互提问（主密码、店铺域名、token）；fetchFn 供测试注入假 API。 */
  secrets?: string[];
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export async function handleShopify(argv: string[], home: string, input?: ShopifyCliInput): Promise<number> {
  const SHOPIFY_USAGE = "用法：\n"
  + "  nyra shopify status                              查看 Shopify 连接器状态（是否启用、是否已授权、店铺域名）\n"
  + "  nyra shopify auth                                授权 Shopify：粘贴自定义应用的 Admin API access token（只存密码箱）\n"
  + "  nyra shopify products [--limit N] [--page-info X]  列出商品（默认 50 条一页，上限 250）\n"
  + "  nyra shopify product <id>                        查一个商品\n"
  + "  nyra shopify orders [--limit N] [--status any|open|closed|cancelled|archived] [--page-info X]\n"
  + "                                                 列出订单（默认全部状态；不含客户邮箱与地址）\n"
  + "  nyra shopify order <id>                          查一个订单\n"
  + "  nyra shopify fulfill <id>                        订单履约核查：订单详情 + 行项目 + 库存逐项核对（只读，不改订单、不动库存）\n"
  + "  nyra shopify inventory [--location-id N] [--inventory-item-id N] [--limit N] [--page-info X]\n"
  + "                                                 查库存水平（按地点 / 商品过滤）\n"
  + "本批只读：改价、改库存、下单、退款、发折扣码、删单一律拒绝。\n"
  + "详见 docs/connectors.md 的 Shopify 一节";
  const {
    createShopifyClient, getShopifyStatus, normalizeShopifyShop,
    formatShopifyProducts, formatShopifyOrders, formatShopifyInventoryLevels,
    checkOrderFulfillment, formatFulfillmentCheck,
    SHOPIFY_VAULT_CREDENTIALS_ENTRY, SHOPIFY_READ_SCOPES, SHOPIFY_WRITE_COMMANDS, SHOPIFY_API_VERSION,
    shopifyWriteRefusal,
  } = await import("./connectors/shopify.ts");
  const { CONNECTOR_AUTH_STATE_LABELS } = await import("./connectors/registry.ts");
  const secretQueue = [...(input?.secrets ?? [])];
  const askSecret = async (prompt: string): Promise<string> => {
    if (secretQueue.length) return secretQueue.shift()!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
    return answer;
  };
  const unlockVault = async (): Promise<Vault | null> => {
    const vault = new Vault(join(home, "vault.json"));
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return null;
    }
    if (!vault.unlock(await askSecret("主密码："))) {
      const remaining = vault.lockoutRemainingMs();
      if (remaining > 0) {
        process.stderr.write(`尝试次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试\n`);
      } else {
        process.stderr.write("主密码错误或密码箱已损坏\n");
      }
      return null;
    }
    return vault;
  };
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const flagValues = (name: string): string[] => {
    const out: string[] = [];
    argv.forEach((a, i) => { if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]); });
    return out;
  };
  const parseLimit = (): number | undefined => {
    const raw = flagValue("--limit");
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) throw new Error("--limit 须为 ≥1 的数字");
    return n;
  };
  const client = () => createShopifyClient(home, loadConfig(home), { ...(input?.fetchFn ? { fetchFn: input.fetchFn } : {}) });
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(SHOPIFY_USAGE + "\n");
      return 0;
    }
    // 写意图先拦：本批不提供任何写入口，撞见写词直接回一句明确拒绝。
    if ((SHOPIFY_WRITE_COMMANDS as readonly string[]).includes(cmd)) {
      process.stderr.write(shopifyWriteRefusal(cmd) + "\n");
      return 1;
    }
    if (cmd === "status") {
      const status = getShopifyStatus(home, loadConfig(home));
      process.stdout.write(`Shopify 连接器：${status.enabled ? "已启用" : "未启用（默认关闭）"}\n`);
      process.stdout.write(`授权：${status.configured ? "已授权" : "未授权"}\n`);
      process.stdout.write(`授权状态：${CONNECTOR_AUTH_STATE_LABELS[status.authState]}${status.authState === "authorized" || status.authState === "unauthorized" ? "" : "（请重新运行 nyra shopify auth）"}\n`);
      if (status.shop) process.stdout.write(`店铺：${status.shop}\n`);
      if (!status.enabled || !status.configured) process.stdout.write("运行 nyra shopify auth 完成授权（授权成功会自动启用）。\n");
      return 0;
    }
    if (cmd === "auth") {
      const vault = await unlockVault();
      if (!vault) return 1;
      process.stdout.write("授权 Shopify 需要自定义应用的 Admin API access token：\n");
      process.stdout.write("  在 Shopify 后台 → 设置 → 应用 → 开发自定义应用 → 建一个应用，只勾 read_products / read_orders / read_inventory，安装后复制 Admin API access token 粘贴进来（只存密码箱，不进配置文件）。\n");
      process.stdout.write("  注意：本批只读，token 只需要读权限；localhost 没有公网回调，做不了 Shopify OAuth 回环，所以用自定义应用 token，不走授权码流程。\n");
      const shop = normalizeShopifyShop(await askSecret("店铺域名（如 hollowandscale.myshopify.com）："));
      if (!shop) {
        process.stderr.write("店铺域名不合法：只接受 xxx.myshopify.com\n");
        return 1;
      }
      const token = (await askSecret("Admin API access token（shpat_…）：")).trim();
      if (!token || !token.startsWith("shpat_")) {
        process.stderr.write("access token 不合法：自定义应用的 Admin API access token 以 shpat_ 开头\n");
        return 1;
      }
      // 先拿 shop.json 探一下：401 说明 token 不对（或读权限没给），不存；
      // 网络不通等其他错误只警告——token 本身可能没问题，下次调用再验。
      try {
        const fetchFn = input?.fetchFn ?? fetch;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let probe: Response;
        try {
          probe = await fetchFn(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
            method: "GET",
            headers: { "X-Shopify-Access-Token": token },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (probe.status === 401) {
          process.stderr.write("token 验证失败（Shopify 返回 401）：请检查自定义应用的 Admin API access token 是否正确、读权限（read_products / read_orders / read_inventory）是否勾上。\n");
          return 1;
        }
      } catch {
        process.stdout.write("（验证请求没通，token 先存下，下次调用时再验。）\n");
      }
      vault.add(SHOPIFY_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ shop, access_token: token }), true);
      const cfg = loadConfig(home);
      saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), shopify: { enabled: true } } });
      const { markConnectorAuthorized, resolveConnectorUserId, tokenFingerprint } = await import("./connectors/registry.ts");
      markConnectorAuthorized(home, "shopify", resolveConnectorUserId(home), {
        tokenFingerprint: tokenFingerprint(token),
        scopes: SHOPIFY_READ_SCOPES.join(","),
      });
      process.stdout.write(`已授权 Shopify（${shop}，只读）：之后同应用同用户不再重复问。\n`);
      return 0;
    }
    if (cmd === "products") {
      const { products, nextPageInfo } = await client().listProducts({
        ...(parseLimit() !== undefined ? { limit: parseLimit() } : {}),
        ...(flagValue("--page-info") ? { pageInfo: flagValue("--page-info")! } : {}),
      });
      process.stdout.write(formatShopifyProducts(products, nextPageInfo) + "\n");
      return 0;
    }
    if (cmd === "product") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra shopify product <id>\n");
        return 2;
      }
      const p = await client().getProduct(id);
      process.stdout.write(`商品：${p.title || "（无标题）"}\n商品 id：${p.id}\n品牌：${p.vendor || "未知"}\n类型：${p.productType || "未知"}\n状态：${p.status || "未知"}\n规格数：${p.variantCount}\n库存总数：${p.totalInventory}\n`);
      return 0;
    }
    if (cmd === "orders") {
      const { orders, nextPageInfo } = await client().listOrders({
        ...(parseLimit() !== undefined ? { limit: parseLimit() } : {}),
        ...(flagValue("--status") ? { status: flagValue("--status")! } : {}),
        ...(flagValue("--page-info") ? { pageInfo: flagValue("--page-info")! } : {}),
      });
      process.stdout.write(formatShopifyOrders(orders, nextPageInfo) + "\n");
      return 0;
    }
    if (cmd === "order") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra shopify order <id>\n");
        return 2;
      }
      const o = await client().getOrder(id);
      process.stdout.write(`订单：${o.name || "（无编号）"}\n订单 id：${o.id}\n金额：${o.totalPrice || "?"} ${o.currency || ""}\n付款：${o.financialStatus || "未知"}\n发货：${o.fulfillmentStatus || "未知"}\n创建时间：${o.createdAt || "未知"}\n商品项数：${o.lineItemsCount}\n`);
      return 0;
    }
    if (cmd === "fulfill") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra shopify fulfill <id>\n");
        return 2;
      }
      const fulfillment = await checkOrderFulfillment(client(), id);
      process.stdout.write(formatFulfillmentCheck(fulfillment) + "\n");
      return fulfillment.verdict === "fulfillable" || fulfillment.verdict === "already-fulfilled" ? 0 : 1;
    }
    if (cmd === "inventory") {
      const locationIds = flagValues("--location-id").map(Number).filter((n) => Number.isFinite(n));
      const inventoryItemIds = flagValues("--inventory-item-id").map(Number).filter((n) => Number.isFinite(n));
      const { levels, nextPageInfo } = await client().listInventoryLevels({
        ...(locationIds.length ? { locationIds } : {}),
        ...(inventoryItemIds.length ? { inventoryItemIds } : {}),
        ...(parseLimit() !== undefined ? { limit: parseLimit() } : {}),
        ...(flagValue("--page-info") ? { pageInfo: flagValue("--page-info")! } : {}),
      });
      process.stdout.write(formatShopifyInventoryLevels(levels, nextPageInfo) + "\n");
      return 0;
    }
    process.stderr.write(`未知命令：${cmd}\n${SHOPIFY_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** 缺口 44 第二批：nyra slack —— Slack 连接器的终端入口（读频道/消息、发消息须批、发审批卡）。 */
export interface SlackCliInput {
  /** 测试注入：按顺序回答交互提问（主密码、workspace 名、token、发送确认）；fetchFn 供测试注入假 API。 */
  secrets?: string[];
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export async function handleSlack(argv: string[], home: string, input?: SlackCliInput): Promise<number> {
  const SLACK_USAGE = "用法：\n"
  + "  nyra slack status                              查看 Slack 连接器状态（是否启用、是否已授权、workspace）\n"
  + "  nyra slack auth                                授权 Slack：粘贴 app 的 Bot token（只存密码箱）\n"
  + "  nyra slack channels [--limit N] [--cursor X]   列出频道（默认 50 条一页，上限 250）\n"
  + "  nyra slack history --channel <id> [--limit N] [--cursor X]  读某频道的消息历史\n"
  + "  nyra slack send --channel <id> --text <内容> [--yes]  发消息到指定频道（须显式批准：--yes 或交互确认）\n"
  + "  nyra slack card --channel <id> --approval <id>  把一条挂起审批发成审批卡（带批准/拒绝按钮）\n"
  + "  nyra slack callback --payload <json> [--by <用户id>]  处理一个审批卡按钮回调：回写审批桥（只认 owner/admin 白名单；--by 省略时取配置的 bot.owner）\n"
  + "删消息、改频道、管理成员一律拒绝；按钮回调会回写审批桥（重复回调幂等，已处理过的审批不再解决）。\n"
  + "详见 docs/connectors.md 的 Slack 一节";
  const {
    createSlackClient, getSlackStatus, isSlackBotToken, isSlackChannelId,
    formatSlackChannels, formatSlackMessages, resolveSlackApprovalCallback,
    SLACK_VAULT_CREDENTIALS_ENTRY, SLACK_READ_SCOPES, SLACK_WRITE_SCOPES, SLACK_WRITE_COMMANDS,
    slackWriteRefusal, SlackAuthError,
  } = await import("./connectors/slack.ts");
  const { CONNECTOR_AUTH_STATE_LABELS } = await import("./connectors/registry.ts");
  const secretQueue = [...(input?.secrets ?? [])];
  const askSecret = async (prompt: string): Promise<string> => {
    if (secretQueue.length) return secretQueue.shift()!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
      });
    return answer;
  };
  const unlockVault = async (): Promise<Vault | null> => {
    const vault = new Vault(join(home, "vault.json"));
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return null;
    }
    if (!vault.unlock(await askSecret("主密码："))) {
      const remaining = vault.lockoutRemainingMs();
      if (remaining > 0) {
        process.stderr.write(`尝试次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试\n`);
      } else {
        process.stderr.write("主密码错误或密码箱已损坏\n");
      }
      return null;
    }
    return vault;
  };
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const parseLimit = (): number | undefined => {
    const raw = flagValue("--limit");
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) throw new Error("--limit 须为 ≥1 的数字");
    return n;
  };
  const client = () => createSlackClient(home, loadConfig(home), { ...(input?.fetchFn ? { fetchFn: input.fetchFn } : {}) });
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(SLACK_USAGE + "\n");
      return 0;
    }
    // 写意图先拦：删消息、改频道、管理成员本批连入口都不提供，撞见写词直接回一句明确拒绝。
    if ((SLACK_WRITE_COMMANDS as readonly string[]).includes(cmd)) {
      process.stderr.write(slackWriteRefusal(cmd) + "\n");
      return 1;
    }
    if (cmd === "status") {
      const status = getSlackStatus(home, loadConfig(home));
      process.stdout.write(`Slack 连接器：${status.enabled ? "已启用" : "未启用（默认关闭）"}\n`);
      process.stdout.write(`授权：${status.configured ? "已授权" : "未授权"}\n`);
      process.stdout.write(`授权状态：${CONNECTOR_AUTH_STATE_LABELS[status.authState]}${status.authState === "authorized" || status.authState === "unauthorized" ? "" : "（请重新运行 nyra slack auth）"}\n`);
      if (status.team) process.stdout.write(`workspace：${status.team}\n`);
      if (!status.enabled || !status.configured) process.stdout.write("运行 nyra slack auth 完成授权（授权成功会自动启用）。\n");
      return 0;
    }
    if (cmd === "auth") {
      const vault = await unlockVault();
      if (!vault) return 1;
      process.stdout.write("授权 Slack 需要 app 的 Bot token：\n");
      process.stdout.write("  在 Slack 后台建一个 app（或打开已有 app）→ OAuth & Permissions → 勾 channels:read、channels:history、chat:write → Install to Workspace，复制 Bot User OAuth Token 粘贴进来（只存密码箱，不进配置文件）。\n");
      process.stdout.write("  注意：本批只读消息、发消息须显式批准；localhost 没有公网回调，做不了 Slack OAuth 回环，所以用 Bot token，不走授权码流程。\n");
      const team = (await askSecret("workspace 名（可选，直接回车跳过）：")).trim();
      const token = (await askSecret("Bot token（xoxb-…）：")).trim();
      if (!token || !isSlackBotToken(token)) {
        process.stderr.write("Bot token 不合法：Slack app 的 Bot token 以 xoxb- 开头\n");
        return 1;
      }
      // 先拿 auth.test 探一下：invalid_auth 说明 token 不对，不存；
      // 网络不通等其他错误只警告——token 本身可能没问题，下次调用再验。
      try {
        const { SlackApiClient } = await import("./connectors/slack.ts");
        const { resolveConnectorUserId } = await import("./connectors/registry.ts");
        const probe = new SlackApiClient({
          credentials: { token, ...(team ? { team } : {}) },
          home,
          userId: resolveConnectorUserId(home),
          ...(input?.fetchFn ? { fetchFn: input.fetchFn } : {}),
        });
        const who = await probe.probeAuth();
        process.stdout.write(`已验证：workspace ${who.team || "（未知）"}，用户 ${who.user || "（未知）"}。\n`);
      } catch (err: unknown) {
        if (err instanceof SlackAuthError) {
          process.stderr.write("token 验证失败（Slack 返回 invalid_auth）：请检查 app 的 Bot token 是否正确、是否已安装到 workspace。\n");
          return 1;
        }
        process.stdout.write("（验证请求没通，token 先存下，下次调用时再验。）\n");
      }
      vault.add(SLACK_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ token, ...(team ? { team } : {}) }), true);
      const cfg = loadConfig(home);
      saveConfig(home, { connectors: { ...((cfg.connectors as Record<string, unknown> | undefined) ?? {}), slack: { enabled: true } } });
      const { markConnectorAuthorized, resolveConnectorUserId, tokenFingerprint } = await import("./connectors/registry.ts");
      markConnectorAuthorized(home, "slack", resolveConnectorUserId(home), {
        tokenFingerprint: tokenFingerprint(token),
        scopes: [...SLACK_READ_SCOPES, ...SLACK_WRITE_SCOPES].join(","),
      });
      process.stdout.write("已授权 Slack：之后同应用同用户不再重复问。\n");
      return 0;
    }
    if (cmd === "channels") {
      const { channels, nextCursor } = await client().listChannels({
        ...(parseLimit() !== undefined ? { limit: parseLimit() } : {}),
        ...(flagValue("--cursor") ? { cursor: flagValue("--cursor")! } : {}),
      });
      process.stdout.write(formatSlackChannels(channels, nextCursor) + "\n");
      return 0;
    }
    if (cmd === "history") {
      const channelId = flagValue("--channel");
      if (!channelId) {
        process.stderr.write("用法：nyra slack history --channel <id> [--limit N] [--cursor X]\n");
        return 2;
      }
      const { messages, nextCursor } = await client().getHistory(channelId, {
        ...(parseLimit() !== undefined ? { limit: parseLimit() } : {}),
        ...(flagValue("--cursor") ? { cursor: flagValue("--cursor")! } : {}),
      });
      process.stdout.write(formatSlackMessages(messages, nextCursor) + "\n");
      return 0;
    }
    if (cmd === "send") {
      const channelId = flagValue("--channel");
      const text = flagValue("--text");
      if (!channelId || text === undefined) {
        process.stderr.write("用法：nyra slack send --channel <id> --text <内容> [--yes]\n");
        return 2;
      }
      // 发消息是本批唯一的写操作：须显式批准（--yes 或交互确认），默认不发。
      if (!argv.includes("--yes")) {
        const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        const ans = (await askSecret(`确认发送到频道 ${channelId}？内容：${preview} [y/N] `)).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stderr.write("未批准：消息没有发送（发消息须显式批准，加 --yes 或在确认里答 y）。\n");
          return 1;
        }
      }
      // 缺口 51：同 Gmail——发消息须人批（确认已满足），收紧到禁做时即使已批准也拒绝。
      const slackRedline = reviewBusinessAction({ home, connector: "slack", action: "send_message", approved: true });
      if (slackRedline.decision === "BLOCK") {
        try {
          appendBusinessRedlineAudit(home, { kind: "blocked", connector: "slack", action: "send_message", tier: "never", via: "cli-slack-send" });
        } catch { /* 审计落盘失败不破坏拦截 */ }
        process.stderr.write(`红线拦截：${slackRedline.reason}\n`);
        return 1;
      }
      const { ts } = await client().postMessage(channelId, text);
      process.stdout.write(`已发送到频道 ${channelId}（消息 ts=${ts}）。\n`);
      return 0;
    }
    if (cmd === "card") {
      const channelId = flagValue("--channel");
      const approvalId = flagValue("--approval");
      if (!channelId || !approvalId) {
        process.stderr.write("用法：nyra slack card --channel <id> --approval <id>\n");
        return 2;
      }
      // 只读 Bot Phase 2 的挂起审批账本（bot-approvals.json），不改它：
      // 账本没有、损坏、找不到这条、已处理、已过期都直接报错，不发卡。
      const { BOT_APPROVALS_FILE } = await import("./bot/approvalBridge.ts");
      const { resolveNyraHome } = await import("./memory.ts");
      let approvals: Record<string, Record<string, unknown>> = {};
      try {
        const raw = readFileSync(join(resolveNyraHome(home), BOT_APPROVALS_FILE), "utf-8");
        const data = JSON.parse(raw) as { approvals?: unknown };
        if (data && typeof data === "object" && data.approvals && typeof data.approvals === "object") {
          approvals = data.approvals as Record<string, Record<string, unknown>>;
        }
      } catch {
        process.stderr.write("找不到挂起审批：bot-approvals.json 不存在或损坏（先在 Bot 里等一条审批挂起）。\n");
        return 1;
      }
      const item = approvals[approvalId];
      if (!item || typeof item !== "object") {
        process.stderr.write(`找不到审批 ${approvalId}（不在挂起账本里）。\n`);
        return 1;
      }
      if (item.status !== "pending") {
        process.stderr.write(`审批 ${approvalId} 已不是挂起状态（${String(item.status ?? "未知")}），不发卡。\n`);
        return 1;
      }
      if (typeof item.tool !== "string" || typeof item.summary !== "string" || typeof item.argsHash !== "string"
        || typeof item.requestedBy !== "string" || typeof item.expiresAt !== "number") {
        process.stderr.write(`审批 ${approvalId} 的记录不完整，无法发卡。\n`);
        return 1;
      }
      if (item.expiresAt <= Date.now()) {
        process.stderr.write(`审批 ${approvalId} 已过期，不发卡。\n`);
        return 1;
      }
      const { ts } = await client().postApprovalCard(channelId, {
        id: approvalId,
        tool: item.tool,
        summary: item.summary,
        argsHash: item.argsHash,
        requestedBy: item.requestedBy,
        expiresAt: item.expiresAt,
      });
      process.stdout.write(`已发审批卡到频道 ${channelId}（消息 ts=${ts}）。\n`);
      process.stdout.write("注意：审批本身仍是挂起状态，点了按钮也不会自动放行——按钮回调须经 nyra slack callback（或网关的 Socket Mode 接线）回写审批桥。\n");
      return 0;
    }
    if (cmd === "callback") {
      const payloadRaw = flagValue("--payload");
      if (!payloadRaw) {
        process.stderr.write("用法：nyra slack callback --payload <json> [--by <用户id>]\n");
        return 2;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadRaw) as unknown;
      } catch {
        process.stderr.write("回调 payload 不是合法 JSON。\n");
        return 2;
      }
      // CLI 跑在本机上，等同机主身份（与 nyra bot approvals 同款信任模型）；
      // 决定人默认取配置的 bot.owner，没配则报 not-approver，不猜。
      const { ApprovalBridge } = await import("./bot/approvalBridge.ts");
      const { botPolicyFromConfig } = await import("./bot/types.ts");
      const policy = botPolicyFromConfig(loadConfig(home));
      const bridge = new ApprovalBridge({
        home,
        policy,
        send: async () => { throw new Error("CLI 不发审批提示"); },
      });
      const decidedBy = flagValue("--by") ?? policy.owner ?? "";
      if (!decidedBy) {
        process.stderr.write("没配决定人：传 --by <用户id>，或在配置里配 bot.owner（只认 owner/admin 白名单）。\n");
        return 2;
      }
      const resolution = await resolveSlackApprovalCallback(home, { payload, decidedBy, bridge });
      process.stdout.write(`${resolution.reason}\n`);
      return resolution.status === "resolved" || resolution.status === "not-pending" ? 0 : 1;
    }
    process.stderr.write(`未知命令：${cmd}\n${SLACK_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- JSON 模式 ----
/**
* 一次性任务的会话钩子外包：SessionStart 在任务开始前触发，SessionEnd 在
* 任务结束（成功、失败或异常退出）后于 finally 里触发——与 REPL（runRepl）
* /网关（newSession/stop/closeSession）行为一致：一次任务一个会话，
* 开始与结束各触发一次。会话钩子是只通知事件（超时、退出码非零都只警告、
* 不阻塞、不改退出码）；钩子只写 stderr、不碰 stdout，--json 模式的结构化输出不受影响。
* 注意：包在 main() 分发层，参数错误等极早退出也会触发一次开始/结束——
* 与 REPL“启动即触发 SessionStart”的口径一致。
*/
async function withOneShotSession(args: CliArgs, fn: () => Promise<number>): Promise<number> {
  const home = resolveHome();
  const workdir = resolve(args.workdir);
  try { await runHooks("SessionStart", { home, workdir }); } catch { /* 只通知事件：钩子故障不破坏任务 */ }
  try {
    return await fn();
  } finally {
    try { await runHooks("SessionEnd", { home, workdir }); } catch { /* 同上 */ }
  }
}

async function runJson(args: CliArgs): Promise<number> {
  const lines = new JsonLines();
  try {
    if (args.planMode || args.executePlan || args.approvePlan) {
      return invalidArguments(process.stdout, "--json 与 --plan/--execute-plan 不能组合使用");
    }
    if (!args.task && !args.voice) return invalidArguments(process.stdout, "--json 需要任务文本");
    // 缺口 16：图片只跟单次正向运行走，组合不对直接报错。
    const visionComboError = validateVisionArgs(args);
    if (visionComboError) return invalidArguments(process.stdout, visionComboError);
    // 缺口 15：语音只跟单次正向运行走，组合不对直接报错。
    const voiceComboError = validateVoiceArgs(args);
    if (voiceComboError) return invalidArguments(process.stdout, voiceComboError);
    // 第 1 批 G-P2-17：--voice 先审后发——JSON 模式没法交互提问，没给
    // --yes 就直接拒绝（不静默跑）；要跑就加 --yes 明确跳过审阅，或走交互模式。
    if (args.voice && !args.yes) {
      return lines.failed("voice_review_required", "--voice 在 --json 模式下须加 --yes 才能跑（非交互模式没法先审后发：转写文字没人看一眼就直接当任务跑，误转写会变成误操作；加 --yes 是明确跳过审阅）", EXIT_RUNTIME, { class: "tool_error", retryable: false, errorName: "VoiceReviewRequired" });
    }
    const built = await buildAgent(args, {
        interactive: false,
        // 缺口 20：429 冷却以 JSON 事件报出（delay_ms 是本次计划等待的毫秒数）。
        onRetry: (r) => lines.emit("rate_limit_cooldown", { provider: r.provider, attempt: r.attempt, delay_ms: r.delayMs, kind: r.kind }),
      });
    const { agent, config, home } = built;
    // 缺口 16：--image/--video 先过模型门禁再读图/抽帧（失败走 lines.failed）。
    await attachVisionInputs(args, agent, config);
    // 缺口 15：--voice 先读文件、校验格式（失败走 lines.failed；转写在首轮）。
    await attachVoiceInput(args, agent, config);
    const workdir = resolve(args.workdir);
    const { command, skipReason } = verifySetup(args, config, workdir);
    const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
    const store = new RunStore(join(home, "runs"));
    // 缺口 20 的前置修复：onEvent 必须先挂再建 recorder——recorder 捕获当时的
    // onEvent 当 previous 并转发；事后覆盖会把 recorder 的 wrapper 摘掉，
    // 事件就再也进不了 events.jsonl，统计头只能写“未知”。
    const flusher = makeUsageFlusher(built);
    agent.onEvent = (kind, data) => { flusher.flush(agent, kind, data); lines.agentEvent(kind, data); };
    const recorder = new RunRecorder(store, agent, args.task ?? "", {
        verifyCmd: command, verifySkipReason: skipReason, verifyTimeout: timeout, verifyRetries: retries,
      });
    // 缺口 29：--contract 挂交付契约——挂不上（契约不存在/不是 active）直接报错，不跑任务。
    if (args.contract) {
      try {
        attachContractToRun(home, recorder.runId, args.contract);
      } catch (err: unknown) {
        return lines.failed("contract_attach_failed", err instanceof Error ? err.message : String(err), EXIT_RUNTIME, { class: "tool_error", retryable: false, errorName: "ContractError" });
      }
    }
    // 缺口 43 第三批：分层上限触顶时暂停记录要带运行 id（检查点引用）。
    built.tieredCtx.runId = recorder.runId;
    // 备用模型切换通知：切换审计里的 run_id 与 stderr 提示后的运行 id 从这里来。
    built.switchRunId.current = recorder.runId;
    const result = await recorder.run(args.task ?? "");
    flusher.flushNow(agent);
    const final = store.load(recorder.runId);
    lines.emit("run_completed", { run_id: recorder.runId, status: final.status });
    // P1-1：未验证通过的运行，不得在输出里宣称"已完成"。
    const note = final.status === "verify_failed"
    ? "验证命令未通过"
    : "未配置或未执行验证命令";
    const downgraded = downgradeCompletionClaim(result, final.status, note);
    if (downgraded.downgraded) {
      lines.emit("completion_downgraded", { status: final.status, claim: downgraded.claim ?? "" });
    }
    lines.emit("final", { content: downgraded.text });
    if (final.status === "verified" || final.status === "completed_unverified") return EXIT_SUCCESS;
    if (final.status === "verify_failed") return EXIT_VERIFY;
    if (final.status === "incomplete") return EXIT_INCOMPLETE;
    return EXIT_RUNTIME;
  } catch (err: unknown) {
    if (err instanceof ApprovalRequired) {
      return lines.failed("approval_required", "审批被拒绝或超时", EXIT_RUNTIME, { class: "tool_error", retryable: false, errorName: "ApprovalRequired" });
    }
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") {
      return lines.failed("no_credentials", "未找到可用的 API 凭据", EXIT_RUNTIME, { class: "model_error", retryable: false, errorName: "AgentError" });
    }
    // P1-3：失败分类——CI 据此决定重试还是报 bug，不必解析自然语言。
    const info = classifyFailure(err);
    return lines.failed(info.class, info.message, EXIT_RUNTIME, {
        class: info.class,
        retryable: info.retryable,
        errorName: info.errorName,
      });
  }
}

// ---- 缺口 16：图像 / 视频输入 ----
/**
 * --image/--video 与其他一次性模式的组合校验：图片只跟单次正向运行走。
 * 返回错误文案（null = 组合合法）。
 */
export function validateVisionArgs(args: CliArgs): string | null {
  if (!args.images.length && !args.videos.length) return null;
  if (args.resumeRun) return "--image/--video 不能与 --resume-run 组合使用（续跑沿用原运行的会话，图片已在其中）";
  if (args.resume) return "--image/--video 不能与 --resume 组合使用（续会话沿用原会话，图片已在其中）";
  if (args.planMode || args.executePlan || args.approvePlan) return "--image/--video 不能与 --plan/--execute-plan 组合使用";
  return null;
}

/**
 * --image/--video 的准备与挂接（runOneShot / runJson 共用）：先过模型门禁
 * （看不了图直接报错，不烧 token、不抽帧），再读图/抽帧，挂到 agent 上。
 * 任一步失败抛错，调用方按各自的错误通道回报。
 */
async function attachVisionInputs(args: CliArgs, agent: Agent, config: Record<string, unknown>): Promise<void> {
  if (!args.images.length && !args.videos.length) return;
  const model = typeof (agent.provider as { model?: unknown }).model === "string"
    ? (agent.provider as { model: string }).model
    : "";
  const gate = modelSupportsVision(model, agent.provider.name);
  if (!gate.supported) throw new AgentError(visionGateMessage(model, agent.provider.name));
  agent.visionInputs = await prepareVisionInputs({
    images: args.images, videos: args.videos,
    workdir: resolve(args.workdir), config,
  });
}

/** 缺口 16：测试用——attachVisionInputs 的同款入口（runOneShot / runJson 共用）。 */
export { attachVisionInputs };

// ---- 缺口 15：语音指挥 ----
/**
 * --voice/--speak 与其他一次性模式的组合校验：语音只跟单次正向运行走。
 * 返回错误文案（null = 组合合法）。
 */
export function validateVoiceArgs(args: CliArgs): string | null {
  if (args.voice) {
    if (args.resumeRun) return "--voice 不能与 --resume-run 组合使用（续跑沿用原运行的会话，语音已在其中）";
    if (args.resume) return "--voice 不能与 --resume 组合使用（续会话沿用原会话，语音已在其中）";
    if (args.planMode || args.executePlan || args.approvePlan) return "--voice 不能与 --plan/--execute-plan 组合使用";
  }
  if (args.speak) {
    if (args.jsonMode) return "--speak 不能与 --json 组合使用（JSON 模式只出机器可读结果）";
    if (args.resumeRun || args.resume || args.planMode || args.executePlan || args.approvePlan) {
      return "--speak 只支持单次正向运行，不能与 --resume/--resume-run/--plan 组合使用";
    }
  }
  return null;
}

/**
 * --voice 的准备与挂接（runOneShot / runJson 共用）：只读文件、校验格式，
 * 挂到 agent 上；转写发生在 runLoop 首轮（先转写再当任务文本）。
 * 任一步失败抛错，调用方按各自的错误通道回报。
 */
async function attachVoiceInput(args: CliArgs, agent: Agent, config: Record<string, unknown>): Promise<void> {
  if (!args.voice) return;
  agent.voiceInputs = [loadAudioFile(args.voice, resolve(args.workdir), resolveVoiceConfig(config))];
}

/**
 * 第 1 批 G-P2-17：语音输入先审后发——交互提问版 review 钩子。
 * 转写文字先打印出来让人看一眼，再问一句：直接发（回车）/ 改了再发
 *（输入新文字）/ 丢弃（输入 drop）。用 makeLineAsker（行缓冲提问器；
 * Bun readline 到 EOF 会丢回调，交互提问须用它）。EOF 时提问器放行
 * 空串 = 直接发——管道喂空输入时不卡住；真要丢弃须显式输入 drop。
 */
/**
 * 第 1 批 G-P2-17：先审后发的回答映射（纯函数，测试直接验）：回车 =
 * 直接发；drop（大小写不敏感）= 丢弃；其他输入 = 改后的文字再发。
 */
export function mapVoiceReviewAnswer(answer: string): VoiceReviewResult {
  const trimmed = answer.trim();
  if (trimmed.toLowerCase() === "drop") return { decision: "drop" };
  if (trimmed === "") return { decision: "accept" };
  return { decision: "edit", text: trimmed };
}

function makeInteractiveVoiceReview(): (text: string) => Promise<VoiceReviewResult> {
  return async (text: string): Promise<VoiceReviewResult> => {
    process.stdout.write(`语音转写（先审后发——看一眼再发）：${text}\n`);
    const asker = makeLineAsker();
    try {
      const answer = await asker.ask("直接发按回车，改了再发输入新文字，丢弃输入 drop：");
      return mapVoiceReviewAnswer(answer);
    } finally {
      asker.close();
    }
  };
}

/** 缺口 15：测试用——attachVoiceInput 的同款入口（runOneShot / runJson 共用）。 */
export { attachVoiceInput };

// ---- 一次性任务 ----
/** GROK-1：`nyra team ...`——团队模式的 CLI 入口。create/list/show/add/remove/
 * handover 是纯本地操作（不建 agent、不烧 token）；只有 dispatch 跑模型：
 * 建一个参谋长 Agent（Soul = 参谋长、teamId = 团队、teamRole = chief，工作
 * 目录落在参谋长自己的电脑 workspace 里），跑 buildChiefTask 的任务文本。
 * 分派前 planTeamDispatch 已做过三道门（团队 active、Charter 齐全、月度硬顶）。 */
async function handleTeamCommand(args: CliArgs, home: string): Promise<number> {
  const subArgs = args.subArgs ?? [];
  // handleTeam 在分派前发的团队事件（team_dispatched）先收下来，等 chief
  // Agent 建好后再进运行证据链——子命令本身没有运行记录，不能直接丢。
  const pendingEvents: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const runChief = async (plan: TeamDispatchPlan, chiefTask: string): Promise<string> => {
    const config = loadConfig(home);
    const { workdir } = resolveAgentWorkdir(home, plan.chief, resolve(args.workdir));
    const trustExit = await ensureWorkspaceTrusted(workdir, args, config, home);
    if (trustExit !== null) throw new Error("工作目录未通过信任检查");
    const built = await buildAgent({ ...args, workdir, task: chiefTask }, {
      interactive: true,
      agentId: plan.chief,
      soulAgent: plan.chief,
      teamId: plan.team.id,
      teamRole: "chief",
      // 第 2 批 G-P1-3：本次分派的纪元（dispatch 处理里拿租约后写进计划的）。
      teamEpoch: plan.epoch ?? null,
      onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
    });
    const { agent } = built;
    const flusher = makeUsageFlusher(built);
    const store = new RunStore(join(home, "runs"));
    const printer = new ToolPrinter();
    agent.onEvent = (kind, data) => { flusher.flush(agent, kind, data); printer.call(kind, data); };
    for (const e of pendingEvents) {
      try { agent.emit(e.kind, e.data); } catch { /* ignore */ }
    }
    const recorder = new RunRecorder(store, agent, chiefTask, { verifyCmd: null });
    built.tieredCtx.runId = recorder.runId;
    const output = await recorder.run(chiefTask);
    flusher.flushNow(agent);
    return output;
  };
  return handleTeam(subArgs, home, {
    onEvent: (kind, data) => { pendingEvents.push({ kind, data }); },
    runChief,
  });
}

/**
 * 缺口 29（G-2）：Golden 集真跑一个用例——起真实 agent 跑固定输入，取最终输出
 *（剥掉运行报告）+ 工具轨迹（tool_start 事件）+ 花费。调模型花真钱，调用方
 *（`nyra golden run`）须先让用户 --yes 确认；本函数不自己再问。
 */
async function runGoldenCaseReal(home: string, input: string): Promise<{ output: string; trajectory: string[]; spentUsd: number | null }> {
  const caseArgs = parseArgs(["--json", input]);
  const built = await buildAgent(caseArgs, { interactive: false });
  const { agent } = built;
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, input, { verifyCmd: null });
  const raw = await recorder.run(input);
  const trajectory = store.readEvents(recorder.runId)
    .filter((e) => e.type === "tool_start" && typeof (e as Record<string, unknown>).name === "string")
    .map((e) => (e as Record<string, unknown>).name as string);
  const final = store.load(recorder.runId);
  const summary = final.usage_summary as { spent_usd?: unknown } | null | undefined;
  return {
    output: stripRunReport(raw),
    trajectory,
    spentUsd: typeof summary?.spent_usd === "number" ? summary.spent_usd : null,
  };
}

async function runOneShot(args: CliArgs): Promise<number> {
  const home = resolveHome();
  const config = loadConfig(home);
  const workdir = resolve(args.workdir);
  // 缺口 16：图片只跟单次正向运行走，组合不对直接报错（不建 agent、不烧 token）。
  const visionComboError = validateVisionArgs(args);
  if (visionComboError) { process.stderr.write(`错误：${visionComboError}\n`); return 2; }
  // 缺口 15：语音只跟单次正向运行走，组合不对直接报错（不建 agent、不烧 token）。
  const voiceComboError = validateVoiceArgs(args);
  if (voiceComboError) { process.stderr.write(`错误：${voiceComboError}\n`); return 2; }
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    process.stderr.write(`错误：工作目录不存在：${workdir}\n`);
    return 1;
  }
  const trustExit = await ensureWorkspaceTrusted(workdir, args, config, home);
  if (trustExit !== null) return trustExit;
  // --resume-run
  if (args.resumeRun) {
    try {
      const store = new RunStore(join(home, "runs"));
      const [state, messages, count] = prepareResume(store, args.resumeRun, { workdir, home });
      // P1-4：中断前已成功的写操作幂等键——续跑时同键调用跳过，不重复执行。
      const completedKeys = loadCompletedWriteKeys(store, args.resumeRun);
      const builtResume = await buildAgent({ ...args, mode: state.mode, maxTurns: state.max_turns }, {
          interactive: true,
          onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
        });
      const { agent } = builtResume;
      const flusherResume = makeUsageFlusher(builtResume);
      agent.onEvent = (kind, data) => flusherResume.flush(agent, kind, data);
      agent.ctx.resumeCompletedWriteKeys = completedKeys;
      if (completedKeys.size) process.stderr.write(`续跑幂等：${completedKeys.size} 个已成功的写操作将被跳过（不重复执行）。\n`);
      agent.messages = messages;
      agent.sessionId = state.session_id;
      const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
      const recorder = new RunRecorder(store, agent, state.task, {
          state, interruptedToolCalls: count, verifyTimeout: timeout, verifyRetries: retries,
        });
      // 缺口 43 第三批：分层上限触顶时暂停记录要带运行 id（检查点引用）。
      builtResume.tieredCtx.runId = recorder.runId;
      const output = await recorder.run(state.task);
      flusherResume.flushNow(agent);
      process.stdout.write(output + "\n");
      const final = store.load(recorder.runId);
      return final.status === "verify_failed" ? EXIT_VERIFY : EXIT_SUCCESS;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  // --plan / --execute-plan
  if (args.planMode || args.executePlan || args.approvePlan) {
    const badCombo =
    (args.planMode && args.executePlan) ||
    (args.approvePlan && !args.executePlan) ||
    (args.planMode && (!args.task || args.approvePlan)) ||
    (args.executePlan && (args.task !== undefined || !args.approvePlan));
    if (badCombo) {
      process.stderr.write("错误：--plan 需要任务文本；--execute-plan 需要 --approve-plan SHA256，且不能混用其他会话命令\n");
      return 2;
    }
    if (args.planMode) {
      try {
        const { agent } = await buildAgent(args, { interactive: false });
        // 缺口 24：Plan 阶段用强推理模型（配了 plan_model 时）；没配沿用主模型。
        const planModel = agent.planProvider() ?? agent.provider;
        const details = await buildPlan(planModel, args.task!, workdir, TOOL_SCHEMAS);
        const digest = savePlan(workdir, renderPlan(args.task!, details));
        process.stdout.write(`已生成只读计划：${join(workdir, "plan.md")}\n`);
        process.stdout.write(`SHA-256：${digest}\n`);
        process.stdout.write(`审核内容后执行：nyra --workdir ${JSON.stringify(workdir)} --execute-plan --approve-plan ${digest}\n`);
        process.stdout.write("执行阶段默认 auto：写入/命令仍需逐项确认，除非明确选择 --mode full。\n");
        return 0;
      } catch (err: unknown) {
        process.stderr.write(`规划失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    if (args.executePlan) {
      if (args.mode === "readonly") {
        process.stderr.write("错误：readonly 不适合执行写入计划，请使用默认 auto 模式\n");
        return 2;
      }
      try {
        const approved = readApprovedPlan(workdir, args.approvePlan!);
        const task = approvedExecutionTask(approved);
        const builtPlan = await buildAgent(args, {
            interactive: true,
            onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
          });
        const { agent } = builtPlan;
        const flusherPlan = makeUsageFlusher(builtPlan);
        agent.onEvent = (kind, data) => flusherPlan.flush(agent, kind, data);
        const store = new RunStore(join(home, "runs"));
        const recorder = new RunRecorder(store, agent, task, { verifyCmd: null });
        // 缺口 43 第三批：分层上限触顶时暂停记录要带运行 id（检查点引用）。
        builtPlan.tieredCtx.runId = recorder.runId;
        const output = await recorder.run(task);
        flusherPlan.flushNow(agent);
        process.stdout.write(output + "\n");
        return 0;
      } catch (err: unknown) {
        process.stderr.write(`计划审批失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
    }
  }
  if (!args.task && !args.voice) return 0; // 无任务时由 main 分派 REPL（--voice 单独用时转写文本就是任务）。
  try {
    const built = await buildAgent(args, {
        interactive: true,
        onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
      });
    const { agent } = built;
    // 缺口 16：--image/--video 先过模型门禁再读图/抽帧，失败直接报错退出。
    // 缺口 15：--voice 先读文件、校验格式（失败直接报错退出；转写在首轮）。
    try {
      await attachVisionInputs(args, agent, config);
      await attachVoiceInput(args, agent, config);
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    // 第 1 批 G-P2-17：--voice 先审后发——交互模式下没给 --yes 就接交互
    // 提问钩子（转写文字先给人看一眼再发）；给了 --yes = 明确跳过审阅，老行为。
    if (args.voice && !args.yes) {
      agent.voiceReview = makeInteractiveVoiceReview();
    }
    const flusher = makeUsageFlusher(built);
    if (args.resume) {
      const messages = loadSession(args.resume, home);
      if (messages === null) {
        process.stderr.write(`错误：找不到会话 ${args.resume}\n`);
        return 1;
      }
      agent.messages = messages;
      agent.sessionId = args.resume;
    }
    const { command, skipReason } = verifySetup(args, config, workdir);
    if (skipReason) process.stderr.write(`注意：${skipReason}\n`);
    const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
    const store = new RunStore(join(home, "runs"));
    const printer = new ToolPrinter();
    // 缺口 20 的前置修复：onEvent 先挂再建 recorder（同 runJson，见该处注释）。
    agent.onEvent = (kind, data) => { flusher.flush(agent, kind, data); printer.call(kind, data); };
    const recorder = new RunRecorder(store, agent, args.task ?? "", {
        verifyCmd: command, verifySkipReason: skipReason, verifyTimeout: timeout, verifyRetries: retries,
      });
    // 缺口 29：--contract 挂交付契约——挂不上（契约不存在/不是 active）直接报错，不跑任务。
    if (args.contract) {
      try {
        attachContractToRun(home, recorder.runId, args.contract);
      } catch (err: unknown) {
        process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    // 缺口 43 第三批：分层上限触顶时暂停记录要带运行 id（检查点引用）。
    built.tieredCtx.runId = recorder.runId;
    // 备用模型切换通知：切换审计里的 run_id 与 stderr 提示后的运行 id 从这里来。
    built.switchRunId.current = recorder.runId;
    const result = await recorder.run(args.task ?? "");
    flusher.flushNow(agent);
    const final = store.load(recorder.runId);
    // P1-1：未验证通过的运行，不得在输出里宣称"已完成"。
    const downgraded = downgradeCompletionClaim(
      result,
      final.status,
      final.status === "verify_failed" ? "验证命令未通过" : "未配置或未执行验证命令",
    );
    process.stdout.write(downgraded.text + "\n");
    // 缺口 15：--speak 或 voice.tts_enabled 时，任务跑完后把结果读出来（只读
    // 前 500 字）；回读失败只警告，不破坏已完成的运行。
    if ((args.speak || resolveVoiceConfig(config).ttsEnabled) && final.status !== "verify_failed") {
      try {
        const spoken = await agent.speakResult(downgraded.text, args.speak);
        if (spoken) {
          process.stdout.write(`语音回读已保存：${spoken.path}（${spoken.chars} 字${spoken.costUsd !== null ? `，花费 $${spoken.costUsd.toFixed(4)}` : "，未计价"}）\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`语音回读失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    process.stderr.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n");
    return final.status === "verify_failed" ? EXIT_VERIFY : EXIT_SUCCESS;
  } catch (err: unknown) {
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") return 1;
    // P2-2：成本硬顶触发——专用退出码，便于 CI/脚本区分"超预算"与"真出错"。
    if (err instanceof AgentError && /^成本上限已超/.test((err as Error).message)) {
      process.stderr.write(`成本上限已触发：${(err as Error).message}\n`);
      return EXIT_COST;
    }
    if (err instanceof ApprovalRequired) {
      process.stderr.write(`等待审批：${(err as ApprovalRequired).tool}\n`);
      return 1;
    }
    // P1-3：非 JSON 输出也带分类前缀，人一眼能看出该重试还是该改代码。
    process.stderr.write(`错误：${formatFailureLine(classifyFailure(err))}\n`);
    return 1;
  }
}

/** 列出自定义命令（项目 .nyra/commands 与 ~/.nyra/commands 下的 .md 文件）。 */
export function listCustomCommands(workdir: string, home: string): string[] {
  // 与 Python load_commands 同语义：命令名是去 .md 的 stem，按目录顺序去重（项目优先）。
  const dirs = [join(workdir, ".nyra", "commands"), join(home, "commands")];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".md"))) {
      const name = f.slice(0, -3);
      if (!seen.has(name)) { seen.add(name); found.push(name); }
    }
  }
  return found;
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——/compact 的 REPL 分发解析
// （纯函数，供测试直接覆盖 REPL 分发逻辑）：
//   "/compact" → { focus: "" }（行为与原来完全一致）；
//   "/compact focus <关键词>" → { focus: "<关键词>" }；
//   其他 /compact 开头的写法（缺关键词、未知参数）→ null，调用方打印用法。
export function parseCompactCommand(text: string): { focus: string } | null {
  if (text === "/compact") return { focus: "" };
  const m = /^\/compact focus\s+(.+)$/.exec(text);
  if (m) return { focus: m[1].trim() };
  if (text === "/compact focus" || text.startsWith("/compact ")) return null;
  return null;
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 的优化建议触发规则：
// 总量为 0 时无需优化；占比最高的类别超过 50% 时给出针对性建议，否则报均衡。
export function contextSuggestion(u: ContextUsage): string {
  if (u.totalChars <= 0) return t("ctx.empty");
  const parts: [string, number, string][] = [
    ["system", u.system, t("ctx.sysTop")],
    ["skills", u.skills, t("ctx.skillsTop")],
    ["history", u.history, t("ctx.historyTop")],
    ["tools", u.toolResults, t("ctx.toolsTop")],
  ];
  let top = parts[0];
  for (const p of parts) if (p[1] > top[1]) top = p;
  if (top[1] / u.totalChars <= 0.5) return t("ctx.balanced");
  return top[2];
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 的打印格式：四类
// 占比 + 总量 + 模型窗口 + 优化建议。token 数是实报还是估算必须写明：实报来自
// 模型用量快照，估算按 4 字符 ≈ 1 token，只在模型没报告用量时用。
export function formatContextUsage(u: ContextUsage): string {
  const pct = (n: number) => (u.totalChars > 0 ? `${Math.round((n / u.totalChars) * 100)}%` : "0%");
  const lines = [
    t("ctx.title"),
    t("ctx.system", { n: u.system, pct: pct(u.system) }),
    t("ctx.skills", { n: u.skills, pct: pct(u.skills) }),
    t("ctx.history", { n: u.history, pct: pct(u.history) }),
    t("ctx.tools", { n: u.toolResults, pct: pct(u.toolResults) }),
    t("ctx.total", { n: u.totalChars }),
  ];
  if (u.windowTokens === null || u.windowTokens === undefined) {
    lines.push(t("ctx.windowUnset"));
  } else {
    lines.push(t("ctx.window", { n: u.windowTokens.toLocaleString("en-US"), source: windowSourceLabel(u.windowSource) }));
  }
  if (u.usedTokens === null || u.usedTokens === undefined) {
    lines.push(t("ctx.usedUnknown"));
  } else if (u.estimated) {
    lines.push(t("ctx.usedEstimated", { n: u.usedTokens.toLocaleString("en-US") }));
  } else {
    lines.push(t("ctx.usedReported", { n: u.usedTokens.toLocaleString("en-US") }));
  }
  lines.push(t("ctx.suggest", { s: contextSuggestion(u) }));
  return lines.join("\n");
}

/** 解析 /lang 命令：返回目标语言；null = 用法错误（没给参数或不是 zh/en）。 */
export function parseLangCommand(text: string): "zh" | "en" | null {
  const arg = text.trim().split(/\s+/)[1];
  return arg === undefined ? null : normalizeLang(arg);
}

// ---- REPL ----
async function runRepl(args: CliArgs): Promise<number> {
  const home = resolveHome();
  const config = loadConfig(home);
  const workdir = resolve(args.workdir);
  const trustExit = await ensureWorkspaceTrusted(workdir, args, config, home);
  if (trustExit !== null) return trustExit;
  let built: BuiltAgent;
  // 缺口 20：429 冷却回调的落点——spinner 在 buildAgent 之后才创建，
  // 先用 holder 占位，spinner 建好后再把真正的显示函数挂上去。
  let retryNotify: ((r: RetryRecord) => void) | null = null;
  try {
    built = await buildAgent(args, { interactive: true, onRetry: (r) => retryNotify?.(r) });
  } catch (err: unknown) {
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") return 1;
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return 1;
  }
  const { agent } = built;
  // 调研报告第 1 项：Hooks —— REPL 会话开始/结束触发 SessionStart/SessionEnd。
  // SessionStart 在会话建立后、首个提示前等一次（只通知事件：钩子故障/超时只
  // 警告、不阻止会话开始；无钩子时 runHooks 直接返回、零 spawn）。
  // SessionEnd 由下面的 try/finally 保证（/exit、EOF 与循环内异常都走 finally）；
  // Ctrl+C 走 onReplSigint：尽力触发一次 SessionEnd，3 秒宽限后退出（130），
  // 不等满 10 秒钩子超时；连按两次 Ctrl+C 时第二次走默认行为直接退出。
  let sessionEnded = false;
  const endSessionHooks = async (): Promise<void> => {
    if (sessionEnded) return;
    sessionEnded = true;
    try { await runHooks("SessionEnd", { home, workdir }); } catch { /* 钩子通知失败不破坏退出流程 */ }
  };
  const onReplSigint = (): void => {
    void (async () => {
        await Promise.race([endSessionHooks(), new Promise((r) => setTimeout(r, 3000))]);
        process.exit(130);
      })();
  };
  process.once("SIGINT", onReplSigint);
  try { await runHooks("SessionStart", { home, workdir }); } catch { /* 同上：只通知事件 */ }
  let providerDesc = `${agent.provider.name} / ${(agent.provider as { model?: string }).model ?? ""}`;
  // 终端外观 v2：TTY 且宽度够时是品牌化欢迎屏（半块字符标志 + 信息卡 + Tips）、横线输入区、
  // 彩色状态栏、spinner 与右侧小伙伴；非 TTY / TERM=dumb / 太窄时退回纯文本状态行 + "> "
  // （管道与脚本不受影响）。颜色：truecolor → 256 → 16 → NO_COLOR 无色。
  const uiColor = useColor(process.stdout);
  const uiLevel: ColorLevel = uiColor ? detectColorLevel(process.env, true) : 0;
  const uiUnicode = supportsBoxDrawing();
  const ui = { color: uiColor, level: uiLevel, unicode: uiUnicode };
  const errColor = useColor(process.stderr);
  const errUi = { color: errColor, level: (errColor ? detectColorLevel(process.env, true) : 0) as ColorLevel, unicode: uiUnicode };
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const termCols = (): number => process.stdout.columns || 80;
  const framed = (): boolean => isTty && process.env.TERM !== "dumb" && termCols() >= 20;
  const ok = (msg: string): string => (framed() ? renderOk(msg, ui) : msg);
  const fail = (msg: string): string => (framed() ? renderError(msg, errUi) : msg);
  const branch = gitBranch(workdir);
  let petOn = petEnabledFromConfig(built.config);
  const showPet = (): boolean => framed() && petVisible({ enabled: petOn, tty: isTty, cols: termCols(), unicode: uiUnicode });
  process.stdout.write(renderHeader(
      { version: VERSION, model: providerDesc, mode: agent.mode, cwd: workdir, branch },
      { width: termCols(), ...ui, compact: !framed(), light: isLightTerminal() },
    ).join("\n") + "\n");
  process.stdout.write((framed()
      ? renderTips({ width: termCols(), ...ui, pet: showPet() })
      : t("tips.plain")) + "\n");
  const unread = (await import("./tasks.ts")).formatUnreadInbox(home);
  if (unread) process.stdout.write(unread + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (prompt: string): Promise<string | null> => new Promise((resolvePromise) => {
      rl.question(prompt, (answer) => resolvePromise(answer));
    });
  // 小伙伴：只在输入框可见时画在右侧固定列（保存/恢复光标，不动 readline 的光标）。
  let frameActive = false;
  let frameCols = 0;
  const pet = new PetController(() => { if (frameActive) process.stdout.write(petSeq()); });
  const petSeq = (): string => {
    if (!frameActive) return "";
    const cols = frameCols;
    const typed = (rl as unknown as { line?: string }).line ?? "";
    if (inputRows(typed, cols) > 1) return "";
    const col = cols - PET_WIDTH + 1; // 1 起算的列号
    const rows = renderPet(pet.state, { level: uiLevel });
    let seq = "\x1b7\x1b[2A\r\x1b[2K";
    if (pet.bubble) {
      const bubble = renderBubble(pet.bubble, uiLevel);
      const bw = textWidth(stripAnsi(bubble));
      if (bw + 4 < cols) seq += `\x1b[${Math.max(1, cols - bw - 2)}G` + bubble;
    }
    seq += "\x1b8";
    rows.forEach((row, i) => {
        const d = i - 1; // 行偏移：上横线 -1、输入行 0、下横线 +1、状态栏 +2
        if (d === 0 && 2 + textWidth(typed) >= col - 1) return; // 输入快碰到小伙伴时让位
        seq += "\x1b7" + (d < 0 ? `\x1b[${-d}A` : d > 0 ? `\x1b[${d}B` : "") + `\x1b[${col}G` + row + "\x1b8";
      });
    return seq;
  };
  // spinner：只在 TTY 上转；小伙伴开着时右侧带一张同步转眼珠的小脸。
  // 它用原始的 stdout.write；agent.run 期间别处（工具、审批）的输出先收起 spinner 再写，
  // 写完整行后再恢复，避免 spinner 和别的输出挤在同一行。
  const rawOut = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
  const spinner = new Spinner({
      write: (t) => rawOut(t), tty: framed(), level: uiLevel, unicode: uiUnicode, width: termCols,
      face: (tick) => (showPet() ? petFace("thinking", tick, uiLevel) : null),
      faceCol: () => termCols() - PET_WIDTH + 2,
    });
  let spinning = false;
  let approvalOpen = false;
  const guardStream = (stream: NodeJS.WriteStream): (() => void) => {
    const original = stream.write;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
      if (!spinning) return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      spinner.pause();
      const ok2 = (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : "";
      if (!approvalOpen && text.endsWith("\n")) spinner.resume();
      return ok2;
    } as typeof stream.write;
    return () => { stream.write = original; };
  };
  // Bun 的 console.log 不走 process.stdout.write，单独包一层（工具的审批摘要用它打印）。
  const guardConsole = (name: "log" | "error" | "warn"): (() => void) => {
    const original = console[name];
    console[name] = (...a: unknown[]) => {
      if (!spinning) return original.apply(console, a);
      spinner.pause();
      original.apply(console, a);
      if (!approvalOpen) spinner.resume();
    };
    return () => { console[name] = original; };
  };
  const printer = new ToolPrinter(undefined, undefined, { level: uiLevel, unicode: uiUnicode });
  printer.onBeforeWrite = () => spinner.pause();
  printer.onAfterWrite = () => { if (spinning) spinner.resume(); };
  const flusher = makeUsageFlusher(built);
  // 缺口 20：429 冷却倒计时——重试要等多久，直接显示在 spinner 行上、
  // 每秒减一；非 TTY 时只写一行。等待时间就是本次重试计划的 delayMs
  //（服务端 Retry-After 与客户端退避取最大值的那一位），不是现编的。
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  let cooldownTimeout: ReturnType<typeof setTimeout> | null = null;
  const clearCooldown = (restoreLabel: boolean): void => {
    if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    if (cooldownTimeout) { clearTimeout(cooldownTimeout); cooldownTimeout = null; }
    if (restoreLabel && spinning) spinner.setLabel(t("spinner.thinking"));
  };
  retryNotify = (r: RetryRecord): void => {
    clearCooldown(false);
    const seconds = Math.max(1, Math.ceil(r.delayMs / 1000));
    if (!framed()) {
      process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds }) + "\n");
      return;
    }
    let remaining = seconds;
    const label = () => t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: remaining });
    spinner.setLabel(label());
    cooldownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) clearCooldown(true);
        else spinner.setLabel(label());
      }, 1000);
    (cooldownTimer as { unref?: () => void }).unref?.();
    cooldownTimeout = setTimeout(() => clearCooldown(true), r.delayMs + 500);
    (cooldownTimeout as { unref?: () => void }).unref?.();
  };
  agent.onEvent = (kind, data) => {
    flusher.flush(agent, kind, data);
    if (kind === "tool_start" || kind === "tool_result" || kind === "usage" || kind === "cost_update" || kind === "final") {
      clearCooldown(false);
    }
    if (kind === "tool_start") spinner.setLabel(t("spinner.running", { tool: String(data.name ?? t("spinner.tool")) }));
    else if (kind === "tool_result") spinner.setLabel(t("spinner.thinking"));
    printer.call(kind, data);
  };
  // 审批：提问前收起 spinner，小伙伴举手；回答后恢复。
  approvalHooks.before = () => {
    approvalOpen = true;
    spinner.pause();
    pet.setMood("approval");
    if (!showPet()) return;
    const cols = termCols();
    const rows = renderPet("approval", { level: uiLevel });
    const bubble = renderBubble(pet.bubble ?? t("pet.approval"), uiLevel);
    const bw = textWidth(stripAnsi(bubble));
    const lines = rows.map((r, i) => {
        const left = i === 1 && bw + PET_WIDTH + 3 < cols ? " ".repeat(cols - PET_WIDTH - bw - 2) + bubble + " " : " ".repeat(cols - PET_WIDTH - 1);
        return left + r;
      });
    process.stdout.write(lines.join("\n") + "\n");
  };
  approvalHooks.after = () => {
    approvalOpen = false;
    pet.setMood("thinking");
    if (spinning) spinner.resume();
  };
  let mode = agent.mode;
  // try/finally 只为保证 SessionEnd 一定触发：循环体不重缩进，diff 保持最小。
  try {
    for (;;) {
      const contextUsage = agent.usage.last_prompt_tokens !== null && agent.usage.configuredWindow
      ? agent.usage.last_prompt_tokens / agent.usage.configuredWindow
      : null;
      let line: string | null;
      if (framed()) {
        const cols = termCols();
        const petShown = showPet();
        // Node 版暂不支持 shift+tab 切换模式（用 /mode），所以不显示该提示。
        const frame = renderInputFrame(
          // P2-3：框式状态栏同样追加成本段（上一轮算出的 lastCost；没配单价/没跑过一轮时不显示）。
          { model: providerDesc, mode, contextUsage, modeSwitchKey: false, branch, cost: dashboardCostSegment(agent.lastCost) },
          { width: cols, ...ui, reserveRight: petShown ? PET_WIDTH : 0 },
        );
        // 先画上横线并在下面预留几行（避免之后滚屏），光标回到输入行；
        // readline 显示提示符后再把下横线和状态栏画到输入行下面。readline 在
        // 退格、移动光标时会清掉光标以下的内容，所以每次按键后补画一次（只在
        // 输入还是单行时画，多行时跳过，避免和折行的输入抢位置）。小伙伴随同一次写入补画。
        process.stdout.write("\n" + frame.above.join("\n") + "\n" + "\n".repeat(frame.below.length) + `\x1b[${frame.below.length}A\r`);
        frameActive = petShown;
        frameCols = cols;
        const drawBelow = (): void => {
          const typed = (rl as unknown as { line?: string }).line ?? "";
          if (inputRows(typed, cols) > 1) return;
          process.stdout.write("\x1b7" + frame.below.map((l) => `\x1b[1B\r\x1b[2K${l}`).join("") + "\x1b8" + petSeq());
        };
        const onKey = (_s: unknown, key?: { name?: string }): void => {
          if (key && (key.name === "return" || key.name === "enter")) return;
          drawBelow();
        };
        const pending = ask(frame.prompt);
        drawBelow();
        if (petShown) pet.start();
        process.stdin.on("keypress", onKey);
        try { line = await pending; } finally {
          process.stdin.off("keypress", onKey);
          frameActive = false;
          pet.stop();
        }
        if (line !== null) {
          // 提交后：回到上横线，清掉输入框（连同上方的气泡行），留下一行暗色回显。
          const up = inputRows(line, cols) + frame.above.length;
          process.stdout.write(`\x1b[${up + 1}A\r\x1b[2K\x1b[1B\r\x1b[J` + renderEcho(line, ui) + "\n");
        }
      } else {
        // P2-3：纯文本状态行同样追加成本段（与框式状态栏同一份 lastCost）。
        process.stdout.write(formatReplStatus(providerDesc, workdir, contextUsage, mode, dashboardCostSegment(agent.lastCost)) + "\n");
        line = await ask("> ");
      }
      if (line === null) { process.stdout.write("\n"); break; }
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        process.stdout.write(t("repl.help") + "\n");
        continue;
      }
      if (text === "/clear") {
        agent.messages = [];
        saveSession(agent.sessionId, [], home);
        process.stdout.write(ok(t("repl.cleared")) + "\n");
        continue;
      }
      // 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 可视化与
      // /compact focus（分发走 parseCompactCommand，见该函数注释）。
      if (text === "/context") {
        process.stdout.write(formatContextUsage(agent.contextUsage()) + "\n");
        continue;
      }
      // 缺口 20：/stats 看本次会话用量与本月累计；/stats heatmap 看每日热力图。
      if (text === "/stats" || text.startsWith("/stats ")) {
        const arg = text.slice("/stats".length).trim();
        if (arg === "" ) {
          const switchLine = modelSwitchSummaryLine(home);
          process.stdout.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n" + formatMonthLine(home) + (switchLine ? "\n" + switchLine : "") + "\n");
        } else if (arg === "heatmap" || arg.startsWith("heatmap ")) {
          const weeksRaw = parseInt(arg.split(/\s+/)[1] ?? "8", 10);
          const weeks = Number.isFinite(weeksRaw) && weeksRaw >= 1 && weeksRaw <= 52 ? weeksRaw : 8;
          flusher.flushNow(agent);
          const ledger = new UsageLedger(home);
          process.stdout.write(formatHeatmap(ledger.dailyTotals(weeks * 7), { weeks }) + "\n");
        } else {
          process.stderr.write("用法：/stats；/stats heatmap [周数]\n");
        }
        continue;
      }
      // 缺口 19：/status 诊断清单（只读：坏配置、不可用沙箱、被忽略的权限设置、永不匹配的 hook matcher）。
      if (text === "/status") {
        const report = runStatusChecks({ home, workdir });
        process.stdout.write(formatStatusReport(report) + "\n");
        continue;
      }
      if (text === "/compact" || text.startsWith("/compact ")) {
        const parsed = parseCompactCommand(text);
        if (parsed === null) {
          process.stderr.write(t("repl.compactUsage") + "\n");
          continue;
        }
        try {
          const info = await agent.compact(4, parsed.focus || undefined);
          process.stdout.write(t("repl.compacted", { focus: parsed.focus ? t("repl.compactFocus", { focus: parsed.focus }) : "", before: info.before, after: info.after, method: info.method }) + "\n");
        } catch (err: unknown) {
          process.stderr.write(t("repl.compactFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
        }
        continue;
      }
      if (text.startsWith("/mode ")) {
        const next = text.slice(6).trim();
        try {
          mode = validateMode(next);
          agent.setMode(mode);
          process.stdout.write(ok(t("repl.modeSwitched", { mode })) + "\n");
        } catch {
          process.stderr.write(fail(t("repl.modeInvalid")) + "\n");
        }
        continue;
      }
      // 缺口 5：对话中途换模型（/model）。只换 provider，不动会话与工具
      // 状态（Agent.switchModel 保证）；新链以目标为 primary，兜底开关
      // 与本次运行一致；窗口与单价按新模型重配。
      if (text === "/model" || text.startsWith("/model ")) {
        const spec = text.slice("/model".length).trim();
        if (!spec) {
          const allowlist = resolveSwitchAllowlist(config, agent.provider.name);
          const fallbackOn = agent.provider instanceof FallbackProvider;
          process.stdout.write(t("repl.modelCurrent", {
                model: `${agent.provider.name} / ${agent.provider.model}`,
                allowlist: allowlist.join("、"),
                fallback: fallbackOn ? t("repl.modelFallbackOn") : t("repl.modelFallbackOff"),
              }) + "\n");
          continue;
        }
        const sep = spec.indexOf(":");
        const targetName = (sep >= 0 ? spec.slice(0, sep) : spec).trim();
        const targetModel = sep >= 0 ? spec.slice(sep + 1).trim() || undefined : undefined;
        if (!targetName) {
          process.stderr.write(fail(t("repl.modelUsage")) + "\n");
          continue;
        }
        try {
          const targetCfg = resolveProvider({ home, config, providerName: targetName, model: targetModel });
          const chain = resolvePresetFallbackChain(config, targetCfg.name, fallbackEnabled(args) ?? undefined);
          const next = buildProviderChain(targetCfg, chain, built.onModelSwitch, {
              resolver: (n: string) => resolveProvider({ home, config, providerName: n }),
              onRetry: (r) => retryNotify?.(r),
              // G-P1-33：故障账本接线（与 buildAgent 同款）。
              health: { home },
            });
          // 推理档位与当前运行一致（provider.extraBody）。
          (next as { extraBody?: Record<string, unknown> }).extraBody = toRequestBody(resolveReasoningOptions(config));
          const manualWindow = manualWindowFromConfig(config);
          const windowResolved = resolveContextWindow({
              model: next.model, provider: targetCfg.name,
              cli: args.contextWindow, manual: manualWindow.value, manualKey: manualWindow.key,
              cache: loadModelCache(home),
            });
          const switched = agent.switchModel(next, {
              reason: "用户在对话中途手动切换模型",
              contextWindowTokens: windowResolved.window,
              contextWindowSource: windowResolved.source,
              contextWindowModel: windowResolved.model,
              pricing: resolvePricing(config.pricing, next.model),
            });
          providerDesc = `${agent.provider.name} / ${agent.provider.model}`;
          process.stdout.write(ok(t("repl.modelSwitched", { from: switched.from, to: switched.to })) + "\n");
        } catch (err: unknown) {
          process.stderr.write(fail(t("repl.modelSwitchFailed", { err: err instanceof Error ? err.message : String(err) })) + "\n");
        }
        continue;
      }
      if (text === "/pet" || text.startsWith("/pet ")) {
        const next = parsePetCommand(text, petOn);
        if (next === null) {
          process.stderr.write(fail(t("pet.usage")) + "\n");
          continue;
        }
        petOn = next;
        try { saveConfig(home, { pet: petOn }); } catch { /* 写不了配置也照样切换本次会话 */ }
        let msg = petOn ? t("pet.on") : t("pet.off");
        if (petOn && !showPet()) msg += t("pet.hidden");
        process.stdout.write(ok(msg) + "\n");
        continue;
      }
      if (text === "/lang" || text.startsWith("/lang ")) {
        // 界面语言：立即切换并写回 config.json 的 language（下次启动沿用）。
        const next = parseLangCommand(text);
        if (next === null) {
          process.stderr.write(fail(t("lang.usage", { lang: getLang() })) + "\n");
          continue;
        }
        setLang(next);
        try { saveConfig(home, { language: next }); } catch { /* 写不了配置也照样切换本次会话 */ }
        process.stdout.write(ok(t("lang.switched")) + "\n");
        continue;
      }
      if (text === "/creator") {
        try {
          mode = validateMode("creator");
          agent.setMode(mode);
          process.stdout.write(t("repl.creatorOn") + "\n");
        } catch {
          process.stderr.write(t("repl.creatorFailed") + "\n");
        }
        continue;
      }
      if (text === "/commands") {
        const found = listCustomCommands(workdir, home);
        if (!found.length) process.stdout.write(t("repl.noCommands") + "\n");
        else for (const f of found) process.stdout.write(`- ${f}\n`);
        continue;
      }
      if (text.startsWith("/rewind-msg ") || text.startsWith("/rewind-edit ") || text.startsWith("/rewind-fork ")) {
        // 对话回退（第 3 阶段 /rewind）：基于 conversations 存档，与网页/手机同一份实现。
        const store = new ConversationStore(home);
        try {
          const parts = text.split(/\s+/);
          const messageId = Number(parts[1]);
          if (!Number.isInteger(messageId) || messageId <= 0) {
            process.stderr.write(t("repl.rewindMsgUsage") + "\n");
            continue;
          }
          let result: { action: string; kept: number; deleted: number; new_session_id: string | null };
          if (text.startsWith("/rewind-msg ")) {
            result = rewindTo(store, agent.sessionId, messageId);
          } else if (text.startsWith("/rewind-fork ")) {
            result = rewindFork(store, agent.sessionId, messageId);
          } else {
            const newText = text.slice(text.indexOf(parts[1]) + parts[1].length).trim();
            if (!newText) { process.stderr.write(t("repl.rewindEditUsage") + "\n"); continue; }
            result = rewindEdit(store, agent.sessionId, messageId, newText);
          }
          if (result.action !== "fork") {
            agent.messages = storeHistoryToAgentMessages(store.history(agent.sessionId, 100000));
            saveSession(agent.sessionId, agent.messages, home);
            process.stdout.write(t("repl.rewound", { id: messageId, kept: result.kept, deleted: result.deleted }) + "\n");
          } else {
            process.stdout.write(t("repl.forked", { sid: String(result.new_session_id), kept: result.kept }) + "\n");
          }
        } catch (err: unknown) {
          process.stdout.write(t("repl.rewindFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
        } finally {
          store.close();
        }
        continue;
      }
      if (text === "/restore" || text.startsWith("/restore ")) {
        // 缺口 9：影子快照联合回滚（文件 + 会话一起，或只文件 / 只会话）。
        if (!agent.shadowSnapshots) {
          process.stdout.write(t("repl.noShadow") + "\n");
          continue;
        }
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
          const records = agent.shadowSnapshots.list();
          if (!records.length) {
            process.stdout.write(t("repl.restoreNone") + "\n");
            continue;
          }
          process.stdout.write(t("repl.restoreList", { n: records.length }) + "\n");
          for (let i = 0; i < records.length; i++) process.stdout.write(formatSnapshotLine(i + 1, records[i]) + "\n");
          continue;
        }
        let mode: RestoreMode = "both";
        if (parts.length >= 3) {
          if (parts[2] === "both" || parts[2] === "files" || parts[2] === "session") mode = parts[2];
          else { process.stderr.write(t("repl.restoreUsage") + "\n"); continue; }
        }
        if (parts.length > 3) {
          process.stderr.write(t("repl.restoreUsage") + "\n");
          continue;
        }
        try {
          const result = agent.restoreShadowSnapshot(parts[1], mode, "repl");
          recordRestoreEvidence(home, workdir, agent.sessionId, {
              snapshot_id: result.snapshot_id, triggered_by: "repl", mode,
              files: [...result.files_restored, ...result.files_deleted].join(","),
              ...(result.messages_deleted !== null
                ? { messages_deleted: result.messages_deleted, messages_kept: result.messages_kept }
                : {}),
            });
          printRestoreResult(result);
        } catch (err: unknown) {
          process.stdout.write(t("repl.restoreFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
        }
        continue;
      }
      if (text === "/undo" || text === "/rewind" || text.startsWith("/rewind ")) {
        if (!agent.checkpoints) {
          process.stdout.write(t("repl.noCheckpoints") + "\n");
          continue;
        }
        let count = 1;
        if (text.startsWith("/rewind ")) {
          const pieces = text.split(/\s+/);
          if (pieces.length !== 2 || !/^\d+$/.test(pieces[1])) {
            process.stderr.write(t("repl.rewindUsage") + "\n");
            continue;
          }
          count = parseInt(pieces[1], 10);
        }
        try {
          const result = agent.checkpoints.undo(count);
          // 模型的对话记录不能默认已撤销的改动还在：把回退记成一轮用户消息。
          agent.messages.push({
              role: "user",
              content: `[Nyra 撤销记录] 已恢复最近 ${result.turns} 轮中的 ${result.files} 个本地文件；此前工具执行结果可能已失效。后续操作请重新读取文件，不要假设此前改动仍存在。`,
            });
          saveSession(agent.sessionId, agent.messages, home);
          process.stdout.write(t("repl.undone", { turns: result.turns, files: result.files }) + "\n");
        } catch (err: unknown) {
          process.stdout.write(t("repl.undoFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
        }
        continue;
      }
      agent.ctx.approvedShellCommands?.clear();
      try {
        // 回退存档（第 3 阶段）：本轮问答记入 conversations，供 /rewind-* 用。
        // G-P1-14：记入时带上工作目录，scope=project 按它过滤；老会话没有
        // 这一项，只进 scope=all。
        const store = new ConversationStore(home);
        try { store.record(agent.sessionId, "user", text, null, null, { workingDir: resolve(process.cwd()) }); } catch { /* ignore */ }
        pet.setMood("thinking");
        spinning = framed();
        spinner.start(t("spinner.thinking"));
        const unguard = spinning
        ? [guardStream(process.stdout), guardStream(process.stderr), guardConsole("log"), guardConsole("error"), guardConsole("warn")]
        : [];
        let result: string;
        try { result = await agent.run(text); } finally {
          spinning = false;
          approvalOpen = false;
          clearCooldown(false);
          spinner.stop();
          for (const u of unguard) u();
        }
        flusher.flushNow(agent);
        try { store.record(agent.sessionId, "assistant", result, null, null, { workingDir: resolve(process.cwd()) }); } catch { /* ignore */ }
        store.close();
        process.stdout.write((framed() ? renderReply(result, ui) : result) + "\n");
        pet.setMood("happy");
      } catch (err: unknown) {
        if (err instanceof ApprovalRequired) {
          pet.setMood("approval");
          process.stdout.write(t("approval.pending", { tool: (err as ApprovalRequired).tool }) + "\n");
          continue;
        }
        pet.setMood("worried");
        process.stderr.write(fail(t("err.prefix", { err: err instanceof Error ? err.message : String(err) })) + "\n");
      }
      agent.ctx.approvedShellCommands?.clear();
    }
  } finally {
    clearCooldown(false);
    spinner.stop();
    pet.stop();
    approvalHooks.before = undefined;
    approvalHooks.after = undefined;
    rl.close();
    await endSessionHooks();
    process.removeListener("SIGINT", onReplSigint);
  }
  flusher.flushNow(agent);
  const replSwitchLine = modelSwitchSummaryLine(home);
  process.stderr.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n" + formatMonthLine(home) + (replSwitchLine ? "\n" + replSwitchLine : "") + "\n");
  return 0;
}

const PERMISSIONS_USAGE = `用法：nyra permissions <list|check|grant|revoke|audit> [选项]
  list [--site <站点>]                    列出本地授权意向
check --site <站点> --scope <scope> [--account <别名>]
grant --site <站点> --scope <scope> [--account <别名>] --confirm [--expect-revision <版本>]
revoke --site <站点> --scope <scope> [--account <别名>] [--expect-revision <版本>]
audit [--site <站点>] [--limit N]
只存本地记录，不等于已登录、OAuth 授权或真实远端执行权限。
`;

const EIGENFLUX_USAGE = `用法：nyra eigenflux <doctor|onboarding|policy> [选项]
  doctor [--room <群> --bot <机器人>] [--check]   仅做本地准备与可选 CLI 诊断
onboarding [--room <群> --bot <机器人>] [--check]  查看入网准备步骤（均需用户前台确认）
policy <show|allow|deny|audit> ...            本地网络限制账本（只记录上限，不等于官方授权）
EigenFlux 本地适配：不负责安装、认证、外发或自动计划任务；网络权限还需独立的 ef-onboarding 前台授权。
`;

function subFlagValue(argv: string[], name: string): string | null {
const idx = argv.indexOf(name);
if (idx === -1 || idx + 1 >= argv.length) return null;
return argv[idx + 1];
}

function subHasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/** Poppy 站点授权意向账本（与 Python poppy_permissions_cli.py 同口径）。 */
function handlePermissions(argv: string[], home: string): number {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const site = subFlagValue(rest, "--site");
  const scope = subFlagValue(rest, "--scope");
  const account = subFlagValue(rest, "--account");
  const limitRaw = subFlagValue(rest, "--limit");
  const revision = subFlagValue(rest, "--expect-revision");
  const confirm = subHasFlag(rest, "--confirm");
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(PERMISSIONS_USAGE);
      return 0;
    }
    const ledger = new PermissionLedger(null, home);
    let result: unknown;
    if (cmd === "list") {
      result = ledger.list(site);
    } else if (cmd === "audit") {
      result = { events: ledger.audit(site, limitRaw === null ? 30 : Number(limitRaw)) };
    } else if (cmd === "check" || cmd === "grant" || cmd === "revoke") {
      if (!site || !scope) {
        process.stderr.write(`用法：nyra permissions ${cmd} --site <站点> --scope <scope> [--account <别名>]\n`);
        return 2;
      }
      if (cmd === "check") result = ledger.check(site, scope, account);
      else if (cmd === "grant") result = ledger.grant(site, scope, account, { confirmed: confirm, expectedRevision: revision });
      else result = ledger.revoke(site, scope, account, { expectedRevision: revision });
    } else {
      process.stderr.write(`未知 permissions 命令：${cmd}\n`);
      return 2;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`权限账本拒绝操作：${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof PermissionConflict ? 2 : 1;
  }
}

/** EigenFlux 接入（与 Python eigenflux_adapter.py main() 同口径）。 */
function handleEigenflux(argv: string[], home: string): number {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const room = subFlagValue(rest, "--room");
  const bot = subFlagValue(rest, "--bot");
  const check = subHasFlag(rest, "--check");
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(EIGENFLUX_USAGE);
      return 0;
    }
    if (cmd === "doctor") {
      const report = eigenfluxDoctor({ root: home, room, bot, check });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return eigenfluxDoctorExitCode(report.status);
    }
    if (cmd === "onboarding") {
      const report = eigenfluxOnboarding({ root: home, room, bot, check });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    if (cmd === "policy") {
      const op = rest[0];
      const capability = subFlagValue(rest, "--capability");
      const limitRaw = subFlagValue(rest, "--limit");
      const revision = subFlagValue(rest, "--expect-revision");
      const confirm = subHasFlag(rest, "--confirm");
      const gate = new NetworkPolicy({ root: home });
      let result: unknown;
      if (op === "allow" || op === "deny") {
        if (!capability) {
          process.stderr.write("allow/deny 需要 --capability\n");
          return 2;
        }
        result = gate.change(op, capability, { room, bot, confirmed: confirm, expectedRevision: revision });
      } else if (op === "show") {
        if (capability !== null || confirm) {
          process.stderr.write("show 不接受 --capability 或 --confirm\n");
          return 2;
        }
        result = gate.show({ room, bot });
      } else if (op === "audit") {
        if (capability !== null || confirm) {
          process.stderr.write("audit 不接受 --capability 或 --confirm\n");
          return 2;
        }
        result = gate.audit({ room, bot, limit: limitRaw === null ? 30 : Number(limitRaw) });
      } else {
        process.stderr.write(`未知 policy 操作：${op ?? ""}（应为 show|allow|deny|audit）\n`);
        return 2;
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    process.stderr.write(`未知 eigenflux 命令：${cmd}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`EigenFlux 适配拒绝操作：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** 缺口 21：nyra timeline <运行 ID> [--verbose] [--json] [--out <路径>]。
 * 只读：从 state.json + events.jsonl 重建时间线；--out 导出 Markdown（0600）。 */
function handleTimeline(sub: string[], home: string): number {
  const runId = sub.find((a) => !a.startsWith("-")) ?? "";
  if (!runId) {
    process.stderr.write("用法：nyra timeline <运行 ID> [--verbose] [--json] [--out <路径>]\n");
    return EXIT_ARGUMENT;
  }
  const verbose = sub.includes("--verbose");
  const json = sub.includes("--json");
  const outIdx = sub.findIndex((a) => a === "--out");
  const outPath = outIdx >= 0 ? sub[outIdx + 1] ?? "" : "";
  if (outIdx >= 0 && !outPath) {
    process.stderr.write("--out 需要一个路径\n");
    return EXIT_ARGUMENT;
  }
  const store = new RunStore(join(home, "runs"));
  let tl;
  try {
    tl = buildTimeline(store, runId);
  } catch {
    process.stderr.write(`找不到运行 ${runId}（用 nyra runs 查看现有记录）\n`);
    return EXIT_ARGUMENT;
  }
  if (outPath) {
    try {
      const written = exportTimelineMarkdown(store, runId, resolve(outPath));
      process.stdout.write(`已导出时间线到 ${written}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`导出失败：${err instanceof Error ? err.message : String(err)}\n`);
      return EXIT_RUNTIME;
    }
  }
  if (json) process.stdout.write(JSON.stringify(tl, null, 2) + "\n");
  else process.stdout.write(formatTimelineText(tl, { verbose }) + "\n");
  return 0;
}

/** 缺口 21：nyra replay <运行 ID> [--verbose]——按轮次逐步重现，只读 walkthrough。 */
function handleReplay(sub: string[], home: string): number {
  const runId = sub.find((a) => !a.startsWith("-")) ?? "";
  if (!runId) {
    process.stderr.write("用法：nyra replay <运行 ID> [--verbose]\n");
    return EXIT_ARGUMENT;
  }
  const verbose = sub.includes("--verbose");
  const store = new RunStore(join(home, "runs"));
  let tl;
  try {
    tl = buildTimeline(store, runId);
  } catch {
    process.stderr.write(`找不到运行 ${runId}（用 nyra runs 查看现有记录）\n`);
    return EXIT_ARGUMENT;
  }
  process.stdout.write(formatReplayText(tl, { verbose }) + "\n");
  return 0;
}

// ---- 主入口 ----
export async function main(argv: string[]): Promise<number> {
  // spec 07：首次运行做原子迁移（~/.angel → ~/.nyra），只读 ~/.nyra。
  ensureNyraHome();
  // 界面语言：--lang > NYRA_LANG > config.language > 系统语言 > en（首次启动不询问）。
  // 只读 config.json 的 language（不存在不创建，--help/--version 不留副作用）。
  let langCfg: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(resolveHome(), "config.json"), "utf-8"));
    if (raw && typeof raw === "object") langCfg = { language: (raw as Record<string, unknown>).language };
  } catch { /* 没有或坏了就按环境探测 */ }
  const langInit = initLang(argv, langCfg);
  if (langInit.error) { process.stderr.write(t("err.prefix", { err: langInit.error }) + "\n"); return 2; }
  argv = langInit.argv;
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`${t("err.unknownOption", { opt: args.unknown })}\n${usageText()}\n`);
    return 2;
  }
  if (args.help) { process.stdout.write(usageText() + "\n"); return 0; }
  if (args.version) { process.stdout.write(`nyra ${VERSION} (node runtime)\n`); return 0; }

  const home = resolveHome();

  // 子命令优先。
  if (args.subcommand === "cost") {
    const cfgCost = loadConfig(home);
    // 回忆感知：估算前先看有没有可复用的历史（与运行时的注入同源）
    let recalledCount: number | undefined;
    const sub = args.subArgs ?? [];
    const taskIdx = sub.findIndex((a) => a === "--estimate" || !a.startsWith("-"));
    const taskText = taskIdx >= 0 ? (sub[taskIdx] === "--estimate" ? sub[taskIdx + 1] ?? "" : sub[taskIdx]) : "";
    if (taskText) {
      try {
        const store = new RunStore(join(home, "runs"));
        recalledCount = selectRecalledRuns(store.list(), taskText, { workdir: resolve(args.workdir), limit: 3 }).length;
      } catch {
        recalledCount = undefined;
      }
    }
    return handleCost(sub, cfgCost, (cfgCost.model as string) ?? null, { recalledCount, home });
  }
  if (args.subcommand === "stats") return handleStats(args.subArgs ?? [], home);
  if (args.subcommand === "telemetry") return handleTelemetry(args.subArgs ?? [], home);
  if (args.subcommand === "acp") return handleAcp(args.subArgs ?? [], home);
  if (args.subcommand === "a2a") return handleA2a(args.subArgs ?? [], home);
  if (args.subcommand === "models") return handleModels(args.subArgs ?? [], home);
  if (args.subcommand === "schedule") return handleSchedule(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "events") return handleEvents(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "mail-inbox") return handleMailInbox(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "responsibility") return handleResponsibility(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "bot") return handleBot(args.subArgs ?? [], home);
  if (args.subcommand === "channels") return handleChannels(args.subArgs ?? [], home);
  if (args.subcommand === "reviewer") return handleReviewer(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "judge") return handleJudge(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "verifier") return handleVerifier(args.subArgs ?? [], home);
  if (args.subcommand === "mcp") return handleMcpServer(args.subArgs ?? [], home);
  if (args.subcommand === "peer") {
    const sub = args.subArgs ?? [];
    if (sub[0] && (PEER_FRIEND_COMMANDS as readonly string[]).includes(sub[0])) {
      return handlePeerFriends(sub, home);
    }
    return handlePeer(sub, home);
  }
  if (args.subcommand === "circle") return handleCircle(args.subArgs ?? [], home);
  if (args.subcommand === "org") return handleOrg(args.subArgs ?? [], home);
  if (args.subcommand === "session") return handleSession(args.subArgs ?? [], home);
  if (args.subcommand === "sfu") return handleSfu(args.subArgs ?? [], home);
  if (args.subcommand === "group") return handleGroupChat(args.subArgs ?? [], home, args);
  if (args.subcommand === "meeting") return handleMeeting(args.subArgs ?? [], home);
  if (args.subcommand === "rendezvous") return handleRendezvous(args.subArgs ?? [], home);
  if (args.subcommand === "queue") return handleQueue(args.subArgs ?? [], home);
  if (args.subcommand === "search") return handleSearch(args.subArgs ?? [], home);
  if (args.subcommand === "editor") return handleEditor(args.subArgs ?? [], home);
  if (args.subcommand === "call") return callLedgerMain(args.subArgs ?? [], home);
  if (args.subcommand === "budget") return budgetMain(args.subArgs ?? [], home);
  if (args.subcommand === "agui") return aguiMain(args.subArgs ?? [], home);
  if (args.subcommand === "screen") {
    const sub = args.subArgs ?? [];
    if (sub[0] === "takeover" || sub[0] === "handover") return handleScreenTakeover(sub, home);
    return handleScreen(sub, home);
  }
  if (args.subcommand === "init") return handleInit(args.subArgs ?? [], home);
  if (args.subcommand === "templates") return handleTemplates(args.subArgs ?? [], home);
  if (args.subcommand === "wake") return handleWake(args.subArgs ?? [], home);
  if (args.subcommand === "voice") {
    const sub = args.subArgs ?? [];
    if (sub[0] === "call") return handleVoiceCall(sub.slice(1), home);
    return handleVoice(sub, home);
  }
  if (args.subcommand === "video") return handleVideo(args.subArgs ?? [], home);
  if (args.subcommand === "export") return handleExport(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "media") return handleMedia(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "skills") return handleSkills(args.subArgs ?? [], home);
  if (args.subcommand === "bughunt") return handleBughunt(args.subArgs ?? [], home);
  if (args.subcommand === "market") return handleMarket(args.subArgs ?? [], home);
  if (args.subcommand === "account") return handleAccount(args.subArgs ?? [], home);
  if (args.subcommand === "cloud") {
    const { handleCloud } = await import("./cloudCli.ts");
    return handleCloud(args.subArgs ?? [], home);
  }
  if (args.subcommand === "sso") return handleSso(args.subArgs ?? [], home);
  if (args.subcommand === "task") return handleTask(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "review") return handleReview(args.subArgs ?? [], home);
  if (args.subcommand === "hitl") {
    const { handleHitl } = await import("./hitlCli.ts");
    return handleHitl(args.subArgs ?? [], home);
  }
  if (args.subcommand === "kb" || args.subcommand === "knowledge") return knowledgeMain(args.subArgs ?? []);
  if (args.subcommand === "plugin") return handlePlugin(args.subArgs ?? [], home);
  if (args.subcommand === "creator") return handleCreator(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "memory") return handleMemory(args.subArgs ?? [], home);
  if (args.subcommand === "soul") return handleSoul(args.subArgs ?? [], home);
  if (args.subcommand === "style") return handleStyle(args.subArgs ?? [], home);
  if (args.subcommand === "vault") return handleVault(args.subArgs ?? [], home);
  if (args.subcommand === "gmail") return handleGmail(args.subArgs ?? [], home);
  if (args.subcommand === "shopify") return handleShopify(args.subArgs ?? [], home);
  if (args.subcommand === "slack") return handleSlack(args.subArgs ?? [], home);
  if (args.subcommand === "connector") return handleConnector(args.subArgs ?? [], home);
  if (args.subcommand === "hooks") return handleHooks(args.subArgs ?? [], home);
  if (args.subcommand === "guard") {
    // guard = verdict 的门禁形态：一行输出 + 退出码。等级判定与 verdict 同源，不另写一套。
    args.subcommand = "verdict";
    args.subArgs = [...(args.subArgs ?? []), "--guard"];
  }
  if (args.subcommand === "timeline") return handleTimeline(args.subArgs ?? [], home);
  if (args.subcommand === "replay") return handleReplay(args.subArgs ?? [], home);
  if (args.subcommand === "regression") return handleRegression(args.subArgs ?? [], home);
  if (args.subcommand === "contract") return handleContract(args.subArgs ?? [], home);
  if (args.subcommand === "golden") return handleGolden(args.subArgs ?? [], home, (input) => runGoldenCaseReal(home, input));
  if (args.subcommand === "kanban") return handleKanban(args.subArgs ?? [], home);
  if (args.subcommand === "goal") return handleGoal(args.subArgs ?? [], home);
  if (args.subcommand === "workflow") return handleWorkflow(args.subArgs ?? [], home);
  if (args.subcommand === "template") return handleTemplate(args.subArgs ?? [], home);
  if (args.subcommand === "script") return handleScript(args.subArgs ?? [], home);
  if (args.subcommand === "handover") return handleHandover(args.subArgs ?? [], home);
  if (args.subcommand === "reconciler") return handleReconciler(args.subArgs ?? [], home);
  if (args.subcommand === "watch") return handleWatch(args.subArgs ?? [], home);
  if (args.subcommand === "trust") return handleTrust(args.subArgs ?? [], home);
  if (args.subcommand === "fanout") return handleFanout(args.subArgs ?? [], home);
  if (args.subcommand === "team") return handleTeamCommand(args, home);
  if (args.subcommand === "subagent") return handleSubagent(args.subArgs ?? [], home);
  if (args.subcommand === "roster") return handleRoster(args.subArgs ?? [], home);
  if (args.subcommand === "side-effects") return handleSideEffects(args.subArgs ?? [], home);
  if (args.subcommand === "heartbeat") return handleHeartbeat(args.subArgs ?? [], home);
  if (args.subcommand === "governance") return handleGovernance(args.subArgs ?? [], home);
  if (args.subcommand === "optimize") {
    const subArgs = args.subArgs ?? [];
    if (subArgs[0] === "loop" || subArgs[0] === "arms") {
      // evalLoop 静态引 optimizer，cli 侧动态 import 进来，避免成环。
      const { handleOptimizeLoop } = await import("./evalLoop.ts");
      return handleOptimizeLoop(subArgs, home, resolve(args.workdir));
    }
    return handleOptimize(subArgs, home, resolve(args.workdir));
  }
  if (args.subcommand === "eval") {
    // evalCli 只引 eval/* 的纯函数与账本；动态 import，与 optimize loop 同款。
    const { handleEval } = await import("./evalCli.ts");
    return handleEval(args.subArgs ?? [], home, resolve(args.workdir));
  }
  if (args.subcommand === "verdict") {
    // --json：机器可读输出（CI 门禁只看 grade，看板画趋势线看 reasons 里的数字）。
    const verdictJson = (args.subArgs ?? []).includes("--json");
    // --guard：一行输出 + 退出码（供 pre-push / CI 用）；--strict 时 yellow 也拦。
    const guardMode = (args.subArgs ?? []).includes("--guard");
    const guardStrict = (args.subArgs ?? []).includes("--strict");
    const emitVerdict = (v2: VerdictShape, kind: "config" | "run" | "trend"): number => {
      if (guardMode) process.stdout.write(formatGuardLine(v2, { strict: guardStrict }) + "\n");
      else if (verdictJson) process.stdout.write(JSON.stringify(toVerdictJson(v2, kind)) + "\n");
      else process.stdout.write(formatVerdict(v2) + "\n");
      return guardMode ? guardExitCode(v2.grade, { strict: guardStrict }) : v2.grade === "red" ? 2 : 0;
    };
    // --run <id>：给单次运行打分（配置级 verdict 只看设置，不看这一次的产物）。
    const runIdFlag = (() => {
        const sub = args.subArgs ?? [];
        const i = sub.indexOf("--run");
        if (i >= 0 && sub[i + 1]) return sub[i + 1];
        const eq = sub.find((a) => a.startsWith("--run="));
        return eq ? eq.slice("--run=".length) : null;
      })();
    // --recent N：批量趋势（单次结论回答"这一次"，趋势回答"该修什么"）
    const recentFlag = (() => {
        const sub = args.subArgs ?? [];
        const i = sub.indexOf("--recent");
        if (i >= 0 && sub[i + 1]) return Number(sub[i + 1]);
        const eq = sub.find((a) => a.startsWith("--recent="));
        return eq ? Number(eq.slice("--recent=".length)) : NaN;
      })();
    if (Number.isFinite(recentFlag) && recentFlag > 0) {
      const n = Math.min(100, Math.floor(recentFlag));
      let states: Record<string, unknown>[] = [];
      try {
        states = (new RunStore(join(home, "runs")).list() as unknown as Record<string, unknown>[]).slice(0, n);
      } catch { states = []; }
      const toInput = (state: Record<string, unknown>) => {
        const us = (state.usage_summary ?? null) as Record<string, unknown> | null;
        return {
          run_id: String(state.run_id ?? ""),
          task: typeof state.task === "string" ? state.task : null,
          status: String(state.status ?? ""),
          verify_result: (state.verify_result ?? null) as Record<string, unknown> | null,
          verify_cmd: typeof state.verify_cmd === "string" ? state.verify_cmd : null,
          changed_files: Array.isArray(state.changed_files) ? (state.changed_files as string[]) : [],
          spent_usd: us && typeof us.spent_usd === "number" ? (us.spent_usd as number) : null,
          delegate_spent_usd: us && typeof us.delegate_spent_usd === "number" ? (us.delegate_spent_usd as number) : null,
          voice_spent_usd: us && typeof us.voice_spent_usd === "number" ? (us.voice_spent_usd as number) : null,
          error: typeof state.error === "string" ? state.error : null,
        };
      };
      const runs = states.map(toInput);
      // 失败分类：CLI 侧算好再传，verdict.ts 保持零运行时依赖
      const failureCounts: Record<string, number> = {};
      for (const r of runs) {
        if (r.status !== "failed" && r.status !== "verify_failed") continue;
        const cls = r.status === "verify_failed" ? "verify_error" : classifyFailure(r.error ?? r.status).class;
        failureCounts[cls] = (failureCounts[cls] ?? 0) + 1;
      }
      const v = buildTrendVerdict({ runs, failureCounts });
      return emitVerdict(v, "trend");
    }
    if (runIdFlag) {
      let state: Record<string, unknown> | null = null;
      try {
        state = new RunStore(join(home, "runs")).load(runIdFlag) as unknown as Record<string, unknown>;
      } catch { state = null; }
      if (!state) {
        process.stderr.write(`找不到运行 ${runIdFlag}（用 nyra runs 查看现有记录）\n`);
        return EXIT_ARGUMENT;
      }
      const us = (state.usage_summary ?? null) as Record<string, unknown> | null;
      const v = buildRunVerdict({
          run_id: String(state.run_id ?? runIdFlag),
          task: typeof state.task === "string" ? state.task : null,
          status: String(state.status ?? ""),
          verify_result: (state.verify_result ?? null) as Record<string, unknown> | null,
          verify_cmd: typeof state.verify_cmd === "string" ? state.verify_cmd : null,
          changed_files: Array.isArray(state.changed_files) ? (state.changed_files as string[]) : [],
          spent_usd: us && typeof us.spent_usd === "number" ? (us.spent_usd as number) : null,
          delegate_spent_usd: us && typeof us.delegate_spent_usd === "number" ? (us.delegate_spent_usd as number) : null,
          voice_spent_usd: us && typeof us.voice_spent_usd === "number" ? (us.voice_spent_usd as number) : null,
          error: typeof state.error === "string" ? state.error : null,
        });
      return emitVerdict(v, "run");
    }
    // 一条结论：把红线 + 省钱 + 回忆 + 运行历史拼成"这次跑得值不值"。
    const cfgV = loadConfig(home);
    const feats = resolveFeatures(cfgV, { enable: args.enableFeatures, disable: args.disableFeatures });
    const taskText = (args.subArgs ?? []).filter((a) => !a.startsWith("-")).join(" ").trim() || (args.task ?? "").trim();
    const turns = typeof cfgV.max_turns === "number" ? cfgV.max_turns : 20;

    // 红线
    let redlines: RedlineResult | null = null;
    try {
      redlines = checkRedlines({
          config: cfgV,
          sandbox: resolveSandbox(cfgV),
          permissions: null,
          hasCostLimit: typeof cfgV.max_cost_usd === "number",
          toolBudget: measureToolBudget(TOOL_SCHEMAS as never),
        } as never);
    } catch { redlines = null; }

    // 省钱 + 实测
    const savings = summarizeCostSavings({
        config: cfgV,
        schemas: TOOL_SCHEMAS as never,
        disabledTools: Array.isArray(effectiveValue(cfgV, "disabled_tools")) ? (effectiveStringList(cfgV, "disabled_tools") as string[]) : [],
        recallCount: null,
        toolSearchEnabled: featureOn(feats, "tool_search"),
        turns,
      });
    let modelSavings = null;
    try {
      modelSavings = summarizeModelSavings(new UsageLedger(home).readAll(), {
          mainModel: (cfgV.model as string) ?? null,
          mainPricing: resolvePricing(cfgV.pricing, (cfgV.model as string) ?? null),
        });
    } catch { modelSavings = null; }

    // 回忆
    let recallAvailable: number | null = null;
    if (taskText) {
      try {
        recallAvailable = selectRecalledRuns(new RunStore(join(home, "runs")).list(), taskText, {
            workdir: resolve(args.workdir), limit: 3,
          }).length;
      } catch { recallAvailable = null; }
    }

    // 运行历史状态分布
    let runStatusCounts: Record<string, number> | null = null;
    try {
      const runs = new RunStore(join(home, "runs")).list();
      const counts: Record<string, number> = {};
      for (const r of runs) {
        const st = String((r as unknown as Record<string, unknown>).status ?? "");
        if (st) counts[st] = (counts[st] ?? 0) + 1;
      }
      runStatusCounts = Object.keys(counts).length ? counts : null;
    } catch { runStatusCounts = null; }

    // 文档一致性：命令索引是否与代码对齐（docs/*.md 全量扫一遍）
    let docs: { ok: boolean; findings: { code: string; command: string; doc: string }[]; mentioned: string[] } | null = null;
    try {
      const docsDir = join(resolve(args.workdir), "docs");
      const files = readdirSync(docsDir).filter((f2) => f2.endsWith(".md"));
      const loaded = files.map((f2) => ({ name: f2, text: readFileSync(join(docsDir, f2), "utf-8") }));
      docs = checkDocs(loaded, [...subcommandSet()]);
    } catch { docs = null; }
    const verdict = buildVerdict({ redlines, savings, modelSavings, recallAvailable, runStatusCounts, turns, docs });
    return emitVerdict(verdict, "config");
  }
  if (args.subcommand === "status") return handleStatus(home, resolve(args.workdir));
  if (args.subcommand === "savings") {
    // 把散落的省钱机制汇成一张单页：一份运行到底开了哪些、能确定省多少。
    const cfgSav = loadConfig(home);
    const feats = resolveFeatures(cfgSav, { enable: args.enableFeatures, disable: args.disableFeatures });
    const disabled = [
      ...(Array.isArray(effectiveValue(cfgSav, "disabled_tools")) ? effectiveStringList(cfgSav, "disabled_tools").filter((t): t is string => typeof t === "string") : []),
      ...args.disableTools,
    ];
    let recallCount: number | null = null;
    try {
      const store = new RunStore(join(home, "runs"));
      const taskText = (args.subArgs ?? []).join(" ").trim() || (args.task ?? "").trim();
      if (taskText) recallCount = selectRecalledRuns(store.list(), taskText, { workdir: resolve(args.workdir), limit: 3 }).length;
    } catch { /* 历史读不了不影响汇总 */ }
    // 账本实测：辅助模型到底省了多少（反事实 = 主模型单价 × 同样 tokens）
    const ledgerRecords = (() => { try { return new UsageLedger(home).readAll(); } catch { return []; } })();
    const modelSavings = summarizeModelSavings(ledgerRecords, {
        mainModel: (cfgSav.model as string) ?? null,
        mainPricing: resolvePricing(cfgSav.pricing, (cfgSav.model as string) ?? null),
      });
    const summary = summarizeCostSavings({
        config: cfgSav,
        schemas: TOOL_SCHEMAS as unknown as { type?: string; function?: { name?: string; description?: string } }[],
        disabledTools: disabled,
        recallCount,
        toolSearchEnabled: featureOn(feats, "tool_search"),
        turns: typeof cfgSav.max_turns === "number" ? cfgSav.max_turns : 20,
        modelSavings,
      });
    const savingsJson = (args.subArgs ?? []).includes("--json");
    if (savingsJson) {
      process.stdout.write(JSON.stringify(toSavingsJson(summary, modelSavings)) + "\n");
      return EXIT_SUCCESS;
    }
    process.stdout.write(formatSavings(summary) + "\n");
    // 逐模型明细：省了多少用真实账本反事实算，不写"算不出"。
    process.stdout.write("\n" + formatModelSavings(modelSavings) + "\n");
    return EXIT_SUCCESS;
  }  if (args.subcommand === "recall") {
    // 回忆是隐式注入的，出问题时只能猜。这条命令把"这次任务能复用哪些历史"摊开给人看。
    const cfgRecall = loadConfig(home);
    const taskArg = (args.subArgs ?? []).filter((a) => a !== "--cross-dir").join(" ").trim() || (args.task ?? "").trim();
    if (!taskArg) {
      process.stderr.write("用法：nyra recall \"<任务文本>\"\n");
      return EXIT_ARGUMENT;
    }
    const feats = resolveFeatures(cfgRecall, { enable: args.enableFeatures, disable: args.disableFeatures });
    const enabled = featureOn(feats, "run_recall");
    const store = new RunStore(join(home, "runs"));
    const runs = store.list();
    // 跨目录弱复用：任务文本里带 --cross-dir 时把别的项目的历史也算进来（降权 + 标注来源）
    const crossDir = (args.subArgs ?? []).some((a) => a === "--cross-dir");
    const picked = selectRecalledRuns(runs, taskArg, { workdir: resolve(args.workdir), limit: 5, maxAgeDays: 30, allowCrossDir: crossDir });
    process.stdout.write(`回忆开关：${enabled ? "已开启" : "已关闭"}（features.run_recall）\n`);
    process.stdout.write(`历史运行：共 ${runs.length} 条，本目录 ${runs.filter((r) => (r as unknown as Record<string, unknown>).workdir === resolve(args.workdir)).length} 条\n`);
    if (!picked.length) {
      process.stdout.write("（没有可复用的历史：可能没有同类任务、或都超过 30 天、或未通过验证）\n");
      return EXIT_SUCCESS;
    }
    process.stdout.write(`可复用 ${picked.length} 条：\n`);
    for (const r of picked) {
      process.stdout.write(`  ${r.run_id}  ${r.status}  ${r.ageDays} 天前  相似度 ${(r.score * 100).toFixed(0)}%  ${r.task.slice(0, 40)}\n`);
    }
    return EXIT_SUCCESS;
  }  if (args.subcommand === "features") {
    const res = resolveFeatures(loadConfig(home), { enable: args.enableFeatures, disable: args.disableFeatures });
    process.stdout.write(formatFeatures(res) + "\n");
    return EXIT_SUCCESS;
  }  if (args.subcommand === "tools") {
    // 工具集成本体检：每轮发多少 token、谁最贵、裁掉能省多少。
    const cfgTools = loadConfig(home);
    const disabled = [
      ...(Array.isArray(effectiveValue(cfgTools, "disabled_tools")) ? effectiveStringList(cfgTools, "disabled_tools").filter((t): t is string => typeof t === "string") : []),
      ...args.disableTools,
    ];
    const schemas = TOOL_SCHEMAS as unknown as { function?: { name?: string } }[];
    const { kept, dropped } = filterSchemas(schemas, disabled);
    const toolsManual = manualWindowFromConfig(cfgTools);
    const toolsWindow = resolveContextWindow({
        model: (cfgTools.model as string) ?? null, provider: (cfgTools.provider as string) ?? null,
        cli: args.contextWindow, manual: toolsManual.value, manualKey: toolsManual.key,
        cache: loadModelCache(home),
      }).window;
    const full = measureToolBudget(schemas, toolsWindow);
    const after = measureToolBudget(kept, toolsWindow);
    const saving = summarizeSavings(schemas, kept);
    process.stdout.write(formatToolBudget(full) + "\n");
    if (dropped.length) {
      process.stdout.write(`已裁剪：${dropped.join("、")} → 每轮 ${after.tokensPerTurn} token（省 ${saving.tokensPerTurnSaved}，${(saving.ratio * 100).toFixed(1)}%）\n`);
    } else {
      process.stdout.write("提示：用 --disable-tool <名字> 或 config.disabled_tools 裁剪用不到的工具，每轮都会省下这部分 token。\n");
    }
    return EXIT_SUCCESS;
  }  if (args.subcommand === "config") {
    const sub = (args.subArgs ?? [])[0];
    // nyra config explain [capability]：这个能力由哪个键控制、当前生效值、来源
    if (sub === "explain") {
      const cfgEx = loadConfig(home);
      const input = { config: cfgEx, cli: { enableFeatures: args.enableFeatures, disableFeatures: args.disableFeatures, maxCost: args.maxCost, addDirs: args.addDirs } };
      const wanted = (args.subArgs ?? [])[1];
      if (wanted) {
        const one = explainOne(input, wanted);
        if (!one) {
          process.stderr.write(`未知能力：${wanted}\n可用：${explainAll(input).map((c) => c.capability).join("、")}\n`);
          return EXIT_ARGUMENT;
        }
        process.stdout.write(formatExplain([one]) + "\n");
        return EXIT_SUCCESS;
      }
      process.stdout.write(formatExplain(explainAll(input)) + "\n");
      return EXIT_SUCCESS;
    }
    return handleConfig(args.subArgs ?? [], home);
  }
  if (args.subcommand === "redlines") {
    // 上线红线自检：把 docs/VISION-NEXT.md 第七节变成可执行命令。
    const cfgRed = loadConfig(home);
    const sandboxStatus = getSandboxStatus(cfgRed, args.sandbox ?? null);
    const perms = parseRules(cfgRed.permissions as { allow?: unknown; ask?: unknown; deny?: unknown } | null);
    const result = checkRedlines({
        config: cfgRed,
        sandbox: { level: sandboxStatus.level, backend: String(sandboxStatus.backend) },
        permissions: { allow: perms.allow, ask: perms.ask, deny: perms.deny },
        hasCostLimit: typeof cfgRed.max_cost_usd === "number",
        // 权限规则体检需要已知工具名（含别名），否则会误报拼写
        knownTools: [...TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string), "Bash", "Edit", "Write", "Read", "sh", "zsh", "powershell"],
        // 阈值与忽略项：config.redlines（不同项目合理值不同）
        thresholds: (() => {
            const rl = cfgRed.redlines;
            if (!rl || typeof rl !== "object") return null;
            const t = (rl as Record<string, unknown>).thresholds;
            return t && typeof t === "object" ? (t as Record<string, number>) : null;
          })(),
        ignore: (() => {
            const rl = cfgRed.redlines;
            if (!rl || typeof rl !== "object") return null;
            const ig = (rl as Record<string, unknown>).ignore;
            return Array.isArray(ig) ? ig.filter((x): x is string => typeof x === "string") : null;
          })(),
        // 跨会话回忆：开着但没有新鲜历史 = 看起来在省，其实一点没省。
        recall: (() => {
            const feats2 = resolveFeatures(cfgRed, { enable: args.enableFeatures, disable: args.disableFeatures });
            const all = new RunStore(join(home, "runs")).list();
            const cfgRl = (cfgRed.redlines && typeof cfgRed.redlines === "object" ? (cfgRed.redlines as Record<string, unknown>).thresholds : null) as Record<string, number> | null;
            const maxAgeDays = cfgRl && typeof cfgRl.recallMaxAgeDays === "number" ? cfgRl.recallMaxAgeDays : 30;
            const cutoff = Date.now() - maxAgeDays * 86_400_000;
            const fresh = all.filter((r) => {
                const ts = Date.parse(String((r as unknown as Record<string, unknown>).created_at ?? ""));
                return Number.isFinite(ts) && ts >= cutoff;
              }).length;
            return { enabled: featureOn(feats2, "run_recall"), total: all.length, fresh };
          })(),
        platform: process.platform,
        // 工具体积：原生工具每轮都发 schema，工具多就是每轮白烧 token。
        // （延迟加载只覆盖 MCP 工具且自动开启，这里不传开关——见 redlines.ts 检查 8。）
        toolBudget: (() => {
            const schemas = TOOL_SCHEMAS as unknown as { function?: { name?: string } }[];
            const disabled = Array.isArray(effectiveValue(cfgRed, "disabled_tools")) ? effectiveStringList(cfgRed, "disabled_tools").filter((t): t is string => typeof t === "string") : [];
            const kept = filterSchemas(schemas, disabled).kept;
            const m = measureToolBudget(kept, typeof cfgRed.context_window === "number" ? cfgRed.context_window : null);
            return { totalTools: m.totalTools, tokensPerTurn: m.tokensPerTurn, contextRatio: m.contextRatio };
          })(),
      });
    // 与省钱机制合并输出：红线管"该不该上生产"，savings 管"上了能省多少"。
    const savingsForRedlines = summarizeCostSavings({
        config: cfgRed,
        schemas: TOOL_SCHEMAS as unknown as { type?: string; function?: { name?: string; description?: string } }[],
        disabledTools: Array.isArray(effectiveValue(cfgRed, "disabled_tools")) ? effectiveStringList(cfgRed, "disabled_tools").filter((t): t is string => typeof t === "string") : [],
        recallCount: result.findings.some((f) => f.code === "recall-ready") ? 1 : 0,
        toolSearchEnabled: featureOn(resolveFeatures(cfgRed, { enable: args.enableFeatures, disable: args.disableFeatures }), "tool_search"),
        turns: typeof cfgRed.max_turns === "number" ? cfgRed.max_turns : 20,
      });
    // --json：CI 按 code 白名单放行 / 统计哪条红线最常被踩（code 本来就是稳定短码）
    if ((args.subArgs ?? []).includes("--json")) {
      process.stdout.write(JSON.stringify(toRedlinesJson(result)) + "\n");
      return result.ok ? EXIT_SUCCESS : EXIT_RUNTIME;
    }
    process.stdout.write(formatRedlinesWithSavings(formatRedlines(result), savingsForRedlines) + "\n");
    return result.ok ? EXIT_SUCCESS : EXIT_RUNTIME;
  }
  if (args.subcommand === "evidence") return handleEvidence(args.subArgs ?? [], home);
  if (args.subcommand === "restore") return handleRestore(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "ui") {
    return handleUi(args.subArgs ?? [], resolve(args.workdir), home);
  }
  if (args.subcommand === "gw") {
    return handleGw(args.subArgs ?? []);
  }
  if (args.subcommand === "permissions") return handlePermissions(args.subArgs ?? [], home);
  if (args.subcommand === "eigenflux") return handleEigenflux(args.subArgs ?? [], home);
  if (args.subcommand === "doctor") {
    const { checks, allOk } = await runDoctor({ home, providerName: args.provider });
    printDoctorResult({ checks, allOk });
    return allOk ? 0 : 1;
  }
  if (args.subcommand === "setup") {
    const config = loadConfig(home);
    let provider;
    try {
      provider = resolveProvider({ home, config, providerName: args.provider });
    } catch (err) {
      console.error(t("main.configBad", { err: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
    const result = await runWizard({ home, provider, config, exampleFile: defaultExampleFile(home) });
    return result.exampleOk ? 0 : 1;
  }
  if (args.example) {
    const config = loadConfig(home);
    let provider;
    try {
      provider = resolveProvider({ home, config, providerName: args.provider });
    } catch (err) {
      console.error(t("main.configBad", { err: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
    const file = args.exampleFile || defaultExampleFile(home);
    if (!existsSync(file)) { process.stderr.write(t("main.exampleMissing", { file }) + "\n"); return 2; }
    try {
      const result = runExampleTask({ home, provider: provider.name, model: provider.model, file });
      return result.rows === 100 ? 0 : 1;
    } catch (err: unknown) {
      process.stderr.write(t("main.exampleFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      return 1;
    }
  }

  // --resume-run 不能与任务文本、--resume、计划、压缩或列表命令组合使用。
  if (args.resumeRun && (args.task !== undefined || args.resume || args.planMode || args.executePlan || args.approvePlan || args.compact || args.listMcp || args.listProfiles || args.listSessions || args.listSkills || args.inspectPoppyIdentity !== null || args.discoverPoppy !== null)) {
    const message = t("main.resumeRunCombo");
    if (args.jsonMode) return invalidArguments(process.stdout, message);
    process.stderr.write(t("err.prefix", { err: message }) + "\n");
    return 2;
  }
  if (args.inspectPoppyIdentity !== null) {
    if (args.jsonMode) return invalidArguments(process.stdout, "--inspect-poppy-identity 不能与 --json 混用");
    process.stdout.write("Poppy 身份核验在 Node 版第 3 阶段，暂走 Python 版：python3 -m nyra --inspect-poppy-identity <站点>\n");
    return 2;
  }
  if (args.discoverPoppy !== null) {
    if (args.jsonMode) return invalidArguments(process.stdout, "--discover-poppy 不能与 --json 混用");
    process.stdout.write("Poppy 发现工具在 Node 版第 3 阶段，暂走 Python 版：python3 -m nyra --discover-poppy <站点>\n");
    return 2;
  }
  if (args.jsonMode) return withOneShotSession(args, () => runJson(args));

  // 列表类命令（不用 Key、不调模型）。
  if (args.listProviders) {
    const config = loadConfig(home);
    const current = (config.provider as string) || "deepseek";
    for (const name of Object.keys(getProviderPresets(config)).sort()) {
      const p = PROVIDERS[name] ?? getProviderPresets(config)[name];
      const mark = name === current ? t("list.current") : "";
      const auth = p.auth === "cli" ? t("list.cliAuth") : name === "ollama" ? t("list.localModel") : t("list.envKey", { key: String(p.envKey) });
      process.stdout.write(t("list.providerLine", { name, mark, model: p.defaultModel ?? t("list.needModel"), auth }) + "\n");
    }
    process.stdout.write(t("list.customHint") + "\n");
    return 0;
  }
  if (args.listModels) {
    const config = loadConfig(home);
    const name = args.provider || envVar("PROVIDER") || (config.provider as string) || "deepseek";
    const preset = getProviderPresets(config)[name];
    if (!preset) { process.stderr.write(`Unknown provider: ${name}\n`); return 2; }
    try {
      const resolved = resolveProvider({ home, config, providerName: name });
      const provider = new Provider(resolved);
      const models = await provider.listModels();
      if (!models.length) { process.stdout.write(t("list.noModels", { name }) + "\n"); return 0; }
      for (const m of models) process.stdout.write(`- ${m}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      return 1;
    }
  }
  if (args.listProfiles) {
    const config = loadConfig(home);
    const names = listProfiles(config);
    if (!names.length) process.stdout.write(t("list.noProfiles") + "\n");
    else for (const n of names) process.stdout.write(`- ${n}\n`);
    return 0;
  }
  if (args.listSkills) {
    const skills = loadSkills(canonicalSkillDirs(process.cwd(), home, pluginSkillDirs(home)));
    if (!skills.length) process.stdout.write(t("list.noSkills") + "\n");
    else for (const s of skills) process.stdout.write(`- ${s.name}：${s.description}\n`);
    return 0;
  }
  if (args.listSessions) {
    const sessions = listSessions(home);
    if (!sessions.length) process.stdout.write(t("list.noSessions") + "\n");
    else for (const s of sessions) process.stdout.write(t("list.sessionLine", { id: s.id, n: s.count, preview: s.preview }) + "\n");
    return 0;
  }
  if (args.listMcp) {
    const config = loadConfig(home);
    const servers = loadMcpServers(config);
    const names = Object.keys(servers);
    if (!config.mcp_enabled || !names.length) {
      process.stdout.write(t("list.mcpOff") + "\n");
      process.stdout.write(t("list.mcpPresets", { n: listPresets().length, names: listPresets().map((p) => p.name).join(getLang() === "en" ? ", " : "、") }) + "\n");
      return 0;
    }
    process.stdout.write(t("list.mcpTitle") + "\n");
    for (const name of names) {
      const s = servers[name];
      process.stdout.write(`- ${name}：${s.command} ${s.args.join(" ")}\n`);
    }
    process.stdout.write(t("list.mcpHint") + "\n");
    return 0;
  }
  if (args.compact) {
    try {
      const { agent } = await buildAgent({ ...args, task: undefined }, { interactive: false });
      agent.sessionId = args.compact;
      const messages = loadSession(args.compact, home);
      if (messages === null) { process.stderr.write(t("main.sessionMissing", { id: args.compact }) + "\n"); return 1; }
      agent.messages = messages;
      const info = await agent.compact();
      process.stdout.write(t("main.compacted", { id: args.compact, before: info.before, after: info.after, method: info.method }) + "\n");
      return 0;
    } catch (err: unknown) {
      process.stderr.write(t("repl.compactFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      return 1;
    }
  }

  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——沙箱选择 fail-closed 校验。
  // 显式 --sandbox bwrap 但本机无 bwrap、--sandbox e2b、danger-full-access + bwrap
  // 等直接报错退出（exit 2），绝不静默降级裸奔；auto 回落到工具级不报错。
  try {
    resolveSandboxBackend(loadConfig(home), args.sandbox ?? undefined);
  } catch (err) {
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return 2;
  }
  if (args.contextWindow !== null && (typeof args.contextWindow !== "number" || !Number.isInteger(args.contextWindow) || args.contextWindow < 1)) {
    process.stderr.write(t("err.contextWindow") + "\n");
    return 1;
  }

  // 缺口 16：--image/--video 只支持一次性任务，交互模式暂不支持。
  if ((args.images.length || args.videos.length) && args.task === undefined) {
    process.stderr.write("错误：--image/--video 只支持一次性任务（nyra --image <图片> \"任务\"），交互模式暂不支持\n");
    return 2;
  }

  if (args.task !== undefined) return withOneShotSession(args, () => runOneShot(args));
  return runRepl(args);
}

// Bun --compile 入口：直接跑 main。
if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
      process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      process.exitCode = 1;
    });
}
