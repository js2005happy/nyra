# Nyra 设计文档

## 一句话

Nyra 是一个全能 AI agent 命令行工具：用 **TypeScript + Bun** 从零写成（零 pip 依赖、零 Python 运行时依赖），集多个开源 agent 的设计思想之长，编译成单文件二进制分发，不用装 Node、不用装 Python。

## 架构

```
用户
 │  nyra "任务" / 交互 REPL / nyra ui（本地网页）/ 桌面 App
 ▼
src/cli.ts ── 参数解析、审批模式、会话恢复、REPL 命令、schedule / plugin / creator 子命令
 │
 ▼
src/agent.ts ── 主循环：组装系统提示词 → 调模型 → 执行工具调用 → 直到回答
 │   ├── src/providers.ts ── OpenAI 兼容客户端 + 兜底链 + 多 Key 轮换 + Codex CLI provider
 │   ├── src/tools.ts ────── 24 个工具 + 审批 + shell 危险命令黑名单
 │   ├── src/skills.ts ──── 技能加载 / 关键词匹配 / 保存
 │   ├── src/runs.ts ────── 私有运行状态与事件日志、审批观察、检查点改动记录
 │   ├── src/tasks.ts ───── 后台任务队列、worker 文件锁、完成通知 inbox
 │   ├── src/memory.ts ──── 长期记忆 + AGENTS.md + 会话 jsonl 存储
 │   ├── src/config.ts ──── 配置 + provider 注册表 + provider 档案
 │   ├── src/mcp.ts ─────── MCP 客户端（stdio JSON-RPC，默认关闭）+ 预置与成本上限
 │   ├── src/scheduler.ts ─ 内置调度器（~/.nyra/schedule.json + daemon）
 │   ├── src/compact.ts ─── 会话压缩（模型摘要 + 本地回退）
 │   ├── src/evidence.ts ── 会话内证据链（联网抓取原文存档）
 │   ├── src/creator.ts ─── 创造模式：一句话需求 → spec → 生成插件 → 验证 → 确认后安装
 │   ├── src/plugins.ts ─── 最小插件市场：技能包安装、哈希锁定、升级保护、生命周期
 │   └── src/gateway.ts ─── 本地网页界面（Bun.serve + 内嵌单页，复用 Agent 与审批门）
```

**关键设计选择：**

- **TypeScript + Bun 运行时**：`fetch` 调 API、子进程跑命令、标准库做解析。没有 Python 运行时依赖；部署就是复制一个单文件二进制（Bun --compile 打包，含运行时）。
- **OpenAI 兼容协议**：所有 provider（DeepSeek、Grok、Hermes via OpenRouter、Ollama、OpenAI）都走同一套 `/v1/chat/completions` + function calling，换模型只改配置。
- **审批是工具层的门**：`src/tools.ts` 的 `checkApproval` 是唯一入口，readonly / auto / full / creator 四档；非交互环境下 auto 拒绝写入，避免 cron 悄悄改文件。
- **技能是 Markdown**：`skills/*.md` + frontmatter（name/description/when/keywords），关键词匹配后注入系统提示词。技能可读、可改、可直接用编辑器写。
- **会话是 jsonl**：`~/.nyra/sessions/<id>.jsonl`，每行一条消息，`--resume` 直接续聊；坏了也能用文本编辑器修。

## 设计来源（集百家之长）

Nyra 的代码全部是原创实现，没有复制任何项目的源码。下表只说明**设计思想**来自哪里，以及对应项目的许可证（供合规参考）：

| Nyra 的功能 | 思想来源 | 来源项目许可证 |
|---|---|---|
| 沙箱式 shell 执行、审批模式（readonly/auto/full） | Codex CLI | Apache 2.0 |
| AGENTS.md 项目说明、会话保存/恢复 | Codex CLI | Apache 2.0 |
| Provider 无关：任意 OpenAI 兼容接口 + 配置选模型 | OpenCode / Pi | MIT |
| 极简、低 token 的 agent 主循环 | Pi | MIT |
| `delegate` 子 agent（有限轮数、返回摘要） | Pi | MIT |
| `plan` 工具：先写计划文件再执行 | Pi / OpenHands | MIT |
| 执行前先规划 | OpenHands | MIT |
| recipes/skills：可复用技能文件 | Goose | Apache 2.0 |
| 技能系统（SKILL.md + 按需加载 + save_skill） | Hermes Agent | MIT |
| 非交互 one-shot 模式（适合 cron/后台） | Grokbot 社区版 | MIT |
| OpenRouter Hermes 模型预设、本地 Ollama 预设 | Hermes 开权重模型 | Apache 2.0（14B/4.3）、Llama 社区许可证（70B/405B） |
| MCP 客户端（stdio JSON-RPC、接第三方服务器工具） | IllusionAgent 0.5.0 | MIT |
| cron 调度器（无人值守自动化、文件式任务） | IllusionAgent 0.5.0 / OpenClaw 调度 | MIT |
| 会话压缩（两种方式：模型摘要 + 本地回退） | IllusionAgent 0.5.0 | MIT |
| 多 provider 档案分组（env_N 式分组、按 flag 切换） | IllusionAgent 0.5.0 / cc-switch 路由 | MIT |
| 搜索双后端：必应优先、百度兜底，独立实例 | IllusionAgent 0.5.0 | MIT |
| “查证是一等公民”：搜索→打开官网→逐项核对→存证→附链接交付 | IllusionAgent 0.5.0（抖音演示，2026-11-15） | MIT |
| 证据链：每一步留档、结论附官方链接可复核 | IllusionAgent 0.5.0（抖音演示） | MIT |
| 能力默认关闭、一键启用、随时热切换 | IllusionAgent 0.5.0（浏览器能力开关） | MIT |

**从 IllusionAgent 0.5.0 借鉴的落地方式（2026-11-16，抖音 60 秒演示“周二去博物馆”）：**
- 视频里的 7 步流程（交代任务→打开浏览器→搜索关键词→点开官网→逐条核对细则→截图留档→交付带官网链接的结论）被压缩成 Nyra 的核查式调研技能 `verify-research`：搜索→打开官网→逐项核对→存证→附链接交付。
- 截图留档在 Nyra 里做成了轻量版：没有真实浏览器，`web_fetch` / `web_search` 抓到的页面原文存为会话内证据文件（`evidence.py`，`~/.nyra/evidence/<会话 id>/`），结论必须附来源链接。
- 搜索后端直接按她的做法：必应优先、百度兜底，每次搜索用全新请求（不共享 cookie/会话），全部失败才报明确错误。
- 能力开关思路用在 MCP 上：MCP 默认关闭，配置里 `mcp_enabled: true` 才启动；系统提示词里也写明了查证流程。

**许可证说明：** Nyra 本身以 MIT 许可证发布（见 LICENSE）。借鉴设计思想不产生许可证义务；Nyra 没有复制、改编或再分发上述任何项目的代码，没有使用它们的商标（如 Codex、Grok、Hermes、Goose 等名称只出现在本文档的来源说明中，不出现在 Nyra 的产品名或界面中）。用户自己配置模型时需遵守各模型提供商的使用条款；Hermes 70B/405B 权重受 Llama 社区许可证约束（商用需注意署名与规模条款），Nyra 默认只预设了 Apache 2.0 的 Hermes 4 14B。

**没有采纳的东西（去其糟粕）：**
- 各家的大而全：OpenHands 的重型服务端、Goose 的桌面应用、Codex 的 Rust 工具链——Nyra 只要一个能跑的 CLI。
- 闭源部分：Codex 的模型与云服务、Grok Bot 官方客户端都是闭源的，Nyra 不依赖它们。
- 厂商锁定：不绑定任何一家模型；Claude Code 的专有配置方式也不采纳。
- **浏览器工具（BrowserNavigate / BrowserClick / BrowserScreenshot 等）**：IllusionAgent 0.5.0 的核心是内置真浏览器，Nyra 在 v2 里**不做假的**：没有真实浏览器驱动就无法实现导航、点击、截图，`web_fetch` 的纯文本抓取不能冒充浏览器。已记入路线图，待有浏览器驱动（如 Playwright/Chromium）再做。

## 自定义命令与 /init

- `nyra/commands.py` 与技能文件同一思路：命令是 `*.md` 文件，文件名即命令名（只允许字母、数字、`-`、`_`），正文是发给模型的提示词模板，可带 `description:` / `argument-hint:` frontmatter。加载顺序是项目级 `<workdir>/.nyra/commands/` 优先于用户级 `~/.nyra/commands/`，同名只保留第一个；格式错误、空正文、非法文件名、符号链接文件会被跳过并在 stderr 留言，不中断启动。
- REPL 里 `/<名字> <参数>` 展开成提示词再进同一 `Agent.run`：`$ARGUMENTS` 换成全部参数，`$1`..`$9` 换成逐词参数，缺失的位置参数变空串；正文没有任何占位符时参数追加到正文末尾。`/commands` 列出当前可用命令及来源；内置命令（`/help`、`/mode`、`/init` 等）优先于同名自定义命令；不认识的 `/xxx` 仍按原来当作普通提问发给模型。
- 命令文件只是提示词：它本身不能执行代码、读写文件或改配置，能做什么取决于模型随后调什么工具、过什么审批。`/init` 则是确定性动作：检查 `AGENTS.md` 是否存在（走 `read_file`，本地适用），不存在才经 `write_file` 写入起始模板，因此要过审批、工作目录边界与检查点，readonly 下拒绝，已存在时绝不覆盖。
- 已知限制：命令每次调用都重新读目录（文件改动即时生效，但每次调用有少量目录 IO）；`/init` 模板是通用骨架，不含项目自动探测，内容仍需人工按实改写。

## 两阶段只读计划模式

- `nyra/plan_mode.py` 独立于普通 Agent：规划只允许调用 `read_file` / `list_dir`，所有路径经 `resolve()` 检查必须位于工作目录内，阻止 `../`、绝对路径与符号链接越界。不能执行 shell、MCP、子 Agent、网络写入等。
- 模型返回完整 Markdown 后才原子保存 `workdir/plan.md`，如果生成失败则保留旧计划。拒绝已有的符号链接计划文件。
- `--execute-plan --approve-plan SHA256` 用完整 64 位 SHA-256 校验文件所有字节。校验失败不会初始化执行 Agent；执行仅使用校验过的内存内容，不重新读取计划。
- 批准计划不会提升工具权限；默认进入 `auto`，不继承配置中可能存在的 full；仅显式 `--mode full` 才取消工具级确认。本版本仅本地 CLI，不宣称 OS 沙箱或 Web UI 审批功能。

### Worker 协议 v1（混合 Go 迁移第 1 批，已作废）

> 0.4.0 状态：Python worker（`nyra/worker.py` + `nyra/worker_protocol.py`，stdio JSONL 协议 v1）已随 Python 删除；Go 混合路线已作废，改走完整 Node 运行时。后台任务现在由 Node 原生任务队列跑（`nyra task worker`，见 `src/tasks.ts`）。本节保留设计思路备查，协议细节以 git 历史为准，不再是现行契约。

- **通道**：请求走 stdin（一行一个 JSON），事件走 stdout（一行一个 JSON），日志走 stderr。宿主只负责传话，不做任何决定。
- **请求**：`run`、`approval_decision`、`stop`、`ping`。`run` 只在 worker 启动时指定的单 provider 上跑，绝不兜底、不进定时任务。
- **审批**：决定权永远在工具层；worker 的 `approve_fn` 只把宿主（人）做的决定传进去，自己绝不批准；审批超时 600 秒、无匹配的决定、协议异常、stdin 关闭，一律按拒绝处理，绝不默认放行。

## 可编排 JSON Lines 执行协议

- nyra --json "任务" 通过独立的 src/jsonMode.ts 单次执行入口构造真实 Agent；Agent 仍走原有工具审批与 MCP 安全门，不因输出模式更换而提高权限。
- 每个事件是单行 JSON，包含 schema_version（当前 1）、seq（递增序号）与 type；任务开始、工具开始/结束、usage、自动压缩、完成、失败、耗尽轮数均有可枚举事件。
- 工具事件默认只输出 id、name 与执行状态，**不会**无意记录原始工具参数、文件内容或命令输出；任务最终答案仅位于 run_completed.output 或 run_incomplete.output。交互式审批不适合机器执行，非交互 auto 模式继续拒绝需要确认的写入。
- 人工 print 在执行期间被导向 stderr；机器 stdout 保留给结构化事件，即使参数校验或运行失败也返回 run_failed。help 与不支持的 schedule/ui 子命令仍属于原有人类界面，不属于 --json 合约。
- 固定退出码：0 完成、1 运行故障、2 参数/配置/凭证问题、3 达到轮数上限未完成、130 用户中断。下游程序必须结合退出码和最终事件判断结果，不应将任意助手文本视作已完成操作。


- `nyra/usage.py` 仅累计 OpenAI 兼容响应中的 usage / prompt_tokens / completion_tokens / total_tokens（也接受 input_tokens / output_tokens），并标明未报告的响应数。未报告的数字不得估算为精确值。
- `Agent.usage` 负责每个 Agent 实例的实时计量；用于 CLI `/status`、一次性任务 stderr 与 Web UI 会话的 status API，原有会话存储与普通 stdout 文本接口保持兼容。
- 仅当配置中存在已核实的 `context_window_tokens`（或 CLI 的 `--context-window`）且 API 返回输入 Token，才能计算参考余量。每个模型有不同限制，需随具体模型调整配置；参考值不包括下一次输入和输出。
- 下一步自动压缩应当在请求前预估或根据上轮 usage 守护阈值，遇到模型未报告用量时需显式保守处理，不得伪装为准确 token 计算。

## 自动上下文压缩（可选）

- `compact.py` 扩展为可严格执行摘要：`strict=True` 时若摘要 API 失败，直接报错并保留原始历史；**手动** `/compact` 仍保留之前的回退行为。
- `Agent.run()` 每轮调用模型前检查最近一次真实报告的输入 token / 已配置的上下文窗口，默认达到 80% 且有足够历史消息时才尝试压缩，绝不由字符串长度估算 token。
- 只对当前用户请求以前的历史生成摘要，保留当前用户指令及其完整工具调用与结果链，因此不会将工具结果孤立在不匹配的 tool_call_id 之后。仅摘要确实比原文短才保存；失败时不写入、不中断主任务，每次根任务最多 1 次额外模型摘要调用。
- 默认 `auto_compact_enabled=false`，需明确配置或传 `--auto-compact` 并给出经核实的上下文窗口，防止用户无意消费 API。摘要请求的真实 usage 也累计在 Agent 用量计数里。
- 自动触发依赖**上一次**请求用量，而不是未发送的下一次请求的精确长度；在一次长输入突增时依然可能遇到模型上下文异常，不承诺绝对避免溢出。压缩摘要自身有信息损失风险，应配合定期历史备份。

## EigenFlux 行为上限与群实例隔离（E2a）

- `nyra/eigenflux_policy.py` 新增按 `main` 或 `room:<id>/bot:<id>` 隔离的本地网络行为上限，固定六类行为，默认全部拒绝；`allow` 需要真实 CLI 用户显式 `--confirm`，`deny` 随时撤销。模型工具、外站消息、Skills 不能通过该模块写入记录。
- 权限存储在 `~/.nyra/eigenflux/network-policy.json` 中，与所有 EigenFlux Home 凭据目录隔离。最多 100 个 Agent、250 条审计事件、128 KiB 文件；进程内 RLock、同目录临时文件 + `os.replace`，基于原始文件 SHA-256 提供 `--expect-revision`，拒绝已损坏 JSON、目录和符号链接。审计不是防篡改日志，不保护跨进程写入竞争和有磁盘权限的攻击者。
- `nyra eigenflux policy show|allow|deny|audit` 直接通过 CLI 路由，不启动 Provider/MCP、外部 CLI、调度器或网络操作。预设 `feed_read`、`public_broadcast`、`direct_message`、`relationship_request`、`recurring_check`、`profile_prefill`；不支持通配授权。`local_intent=allowed` 是额外上限选择，不是 EigenFlux OAuth、账户认证、Consent 或 CLI 执行许可；返回的 `effective_network_permission` 始终 false，绝不宣称已入网。
- 群聊新增 `instance_id=secrets.token_hex(16)`：相同群 ID 在删除重建后视作不同身份。新群 EigenFlux Home 路径含实例标记；原有群无此字段时保留之前的稳定目录。策略记录也绑定实例标记；旧实例的本地 allow 在重建后失效，deny 删除旧状态。不能让重名群继承前任机器人的身份私钥或广播许可。
- 该本地上限的正确使用方式是**未来网络执行网关**在真实发起命令之前先读取它，同时进一步验证官方 `ef-onboarding` 的当前授权、身份凭据、用户明确操作意图及公开内容安全要求。当前没有网络执行网关，因此只提供管理接口，不承诺阻止用户在 Nyra 外部直接运行 CLI。

## EigenFlux bare-CLI 适配准备：身份隔离与无副作用诊断

- 采用官方 CLI 作为网络协议边界，不复刻 EigenFlux 的 Ed25519 身份认证，不使用私有协议伪造 Agent 入网状态。
- `nyra/eigenflux_adapter.py` 提供 `home_for_agent()`：稳定地为主 Agent 和已有群聊的特定 bot 计算独立 `EIGENFLUX_HOME`，无会话 ID、任务时间、cwd 或可修改昵称参与路径。群与 bot ID 使用严格白名单，并通过 `GroupStore.get()` 验证实际成员，拒绝别人的 home 和符号链接穿透。
- `nyra eigenflux doctor` 只返回 JSON 安装准备报告，不访问网络或运行二进制，也不创建身份文件；`--check` 才使用 `shutil.which()` 查找官方 CLI，然后以 `subprocess.run(shell=False)` 运行两个无用户自定义参数的官方本地诊断：`version`、`skills path --host terminal`。超时 8 秒，仅白名单环境变量（含特定 EIGENFLUX_HOME），不会继承模型密钥；只有两个诊断都成功才标注 `local_cli_verified`。
- 这个状态不代表 EigenFlux 网络已认证或 onboarding 完成：结果中 `network_actions_allowed=false`、`broadcast_enabled=false`、`scheduled_checks_enabled=false` 和 `onboarding_complete=false` 始终为 false。本期没有安装器调用、任意 Shell 执行、feed 查询、凭据导出或周期任务。
- 剩余工作：用户明确同意安装时才依官方指南执行 bare-CLI，随后需使用已安装的 `ef-onboarding` Skill 分别取得个人资料、邮箱身份和网络行动授权。若最终接入多机器人互动，每个成员应使用自己的稳定 Home 与授权范围；跨进程身份并发及网络滥用另做审计与限制。

## Poppy OAuth issuer 元数据双向核验（第三阶段第一增量）

- `poppy_identity.py` 实现 1.0 §3.2 与 RFC 9728 / RFC 8414 的公共身份发现：公司文档 `organization.domain` → 域名 `oauth-protected-resource`，验证 `resource` 精确公司 origin；选择该元数据 `authorization_servers` 中被 `auth.issuer` 指定的发行方（只有一个时可省略）；读取发行方 `oauth-authorization-server`，精确匹配 `issuer` 且验证 `protected_resources` 回指公司。验证双向归属后才对外报告发行方身份。
- 资源 404 / 合法空授权服务器列表只报告未检测到 issuer 的 signed-out-only 元数据；已声明 `auth.issuer` 时拒绝这种降级。任何超时、非 404 HTTP 错误、错配、非法元数据或重定向均拒绝，不默默把此前已知 issuer 当作不存在。未来增加跨会话已知 issuer 锁定和变更审计。
- 同时验证 issuer 必备的 `token_endpoint`、`revocation_endpoint`、`grant_types_supported` 包含 `refresh_token`，对 authorization_code 和 device_code 的对应端点进行检查。端点只展示或验证格式，不请求任何 token，也不发送请求到资源 API。
- `poppy.py` 继续使用固定公网 IP/TLS SNI 的标准库 HTTPS，只在显式允许的资源元数据查询中将 HTTP 404 返回为 `None`；普通 Poppy 发现依旧把 404 当失败。元数据请求不跟随重定向、不发送凭据。CLI `--inspect-poppy-identity` 不依赖 Provider，Agent 工具 `poppy_identity_check` 只在 `--poppy` 时开放。
- 本期不产生可用 Poppy Session；Session 的 ES256 委派签名、OAuth private_key_jwt、持久用户 ID/多 issuer 绑定、DPoP 和 HTTP MCP 都需要后续分步交付及专项安全测试，不能以无签名 token 冒充标准实现。此处元数据只能建立公开发行方**声明**的双向信任链，不是用户登录或合法执行许可。

## Poppy 用户授权意向账本（第二阶段）

- 新增 `poppy_permissions.py`：独立按 `(公开 HTTPS 精确主机, visitor 或 account:<本地别名>, OAuth scope)` 保存本地授权意向，默认拒绝、禁止通配 scope、子域名/账户不共享。**不是 Poppy Session / OAuth 权限记录**，即使存在 local_intent 也始终将 `may_execute_remote_action` 标记为 false。
- `nyra permissions list|check|grant|revoke|audit` 在创建 Provider、MCP 进程或任何网络请求之前直接执行。只有显式用户 CLI `grant --confirm` 能新增记录；Agent 的 `--poppy` 工具仅支持 `poppy_permission_check` 只读查询，不包含 grant/revoke。
- JSON 持久化存于 `~/.nyra/poppy/permissions.json`，私有权限 0600（POSIX）、同目录临时文件加 `os.replace`，进程内锁序列化更改。`--expect-revision` 可对存储字节执行 SHA-256 乐观并发校验。有界审计事件与账本同一次原子替换，限制站点/身份/scope 数量及 256 KiB 容量；文件/目录已有符号链接会拒绝。
- `classify_scope` 符合 Poppy 1.0 §4.7：未知 changes 按 irreversible，缺少 personal_data 视作未知；任何非 `none` 或未知个人数据都标记为日后执行时必须人工确认。`poppy.py` 的 discovery 摘要也避免将缺失提示降级为安全，不信任网站描述本身等于用户授权。
- **尚未落地的 runtime gate**：现阶段没有 Poppy HTTP MCP/OAuth Session/远端操作，所以账本不使任何远程操作实际可执行。真正的 transport 必须核验公司 issuer、运行时 token 实际 scopes、Session 身份归属、用户明确批准和高风险每次操作审批，且支持撤销后的实时阻断。多进程竞争与具备本地磁盘权限的恶意修改不由本期彻底解决。

## Poppy 协议发现薄层（首阶段，默认关闭）

- 官方参考：`https://personalagentprotocol.org/docs/1.0/spec`。新增 `nyra/poppy.py` 只做不带登录身份的公共 `/.well-known/poppy.json` 发现，检查文档版本、实际服务主机与 `organization.domain` 一致、重定向最终 well-known 路径精确且无 query。首选非 1.0 时若 `supported_versions` 指向同主机的 1.0 备选文件，则按规范拒绝备选重定向并校验它的版本。
- 为减少 SSRF，域名须有效且为公共 DNS；DNS 地址全部要求是公开可路由 IP，再通过定制的标准库 `http.client.HTTPSConnection` 连接到已检查的 IP、以原主机做 TLS SNI/证书校验。禁用自动代理与 Cookie/Token，拒绝非 HTTPS、URL 凭据、非默认端口以及内网/环回 DNS 和重定向目标；响应受字节数、超时和重定向次数限制。
- 能力解析返回类型、渠道 URL 与缩短的描述，`status=metadata_only`；禁止自动发起身份验证或调用任意返回的远端 MCP/OpenAPI/UCP 公司 Agent。远程 HTTP MCP 与 Nyra 既有 stdio MCP 不等价，必须后续另行实现 OAuth 与 Session JWT。
- `ToolContext.poppy_enabled` 默认 false，只有 CLI `--poppy` 明确开放工具 schema，委派子 Agent 保留显式开关；独立 CLI `--discover-poppy` 在创建 Provider/连接 MCP 前完成，无实际模型调用。JSONL 单次任务可以带 `--poppy`，权限仍遵守原有模式。
- 未来步骤：权限账本（站点/授权 scope/操作风险），再实现 HTTP MCP、Session、OAuth/DPoP 与用户审批；之后按需实现 UCP 搜索、加购、结账。没有显式核实的交易能力不得被认为已可用。用户的 Shopify 站点需单独实测发现文件，不能从平台公告推断其特定文件内容。

## 长期记忆：可查看、可管理、与会话压缩解耦

- 原有 `src/memory.ts` 的全局 `MEMORY.md` 和 `src/groups.ts` 中按机器人隔离的 `MEMORY.md` 都位于 session JSONL 之外，`src/compact.ts` 只处理消息数组，不会写入长期记忆。Agent 每次构造系统提示词时加载相应记忆文件的**最后 40 行**，因此持久文件本身不等于模型能同时回忆所有内容。
- 新增 `src/memoryBrowser.ts`：严格按既有文件路径读取 UTF-8 完整内容，支持带 SHA-256 修订号的 CAS 保存、同目录临时文件与原子替换、64 KiB 容量限制及已有符号链接防护，文件冲突失败关闭。使用进程内锁与同一进程中 `appendMemory` 串行化。
- Web UI 新增受原有访问 token 保护的 `GET /api/memory/scopes`、`GET /api/memory?scope=...`、`POST /api/memory`，只允许全局记忆和通过 `GroupStore.get` 证实存在的机器人。群 ID 与机器人 ID 不作为任意文件路径，拒绝符号链接穿透及跨机器人越界访问。
- `src/webuiPage.ts` 加入独立的编辑对话框，选择记忆所属、载入完整 Markdown、刷新和明确保存；版本冲突提示用户先手工合并，关闭/切换未保存内容时警告。所有记忆正文通过 `textarea.value` 输出，不插入 HTML。
- 已知限制：单进程锁与 SHA-256 校验不构成多进程原子 compare-and-swap；文件系统竞争时仍有 TOCTOU 风险；目前没有记忆条目语义索引、自动去重、记忆摘要层次或跨机器人授权共享。

## 多 Agent 群聊架构（可运行 MVP）

- `src/groups.ts`（Node）：群存储、不同 bot 的角色指令、独立会话、不同 provider/model、成员私有记忆和 workspace、@mention 路由、预算控制。复用成熟的 `Agent` 执行器，避免多套模型调用实现。
- `src/assets/group_ui.html.txt` + `src/assets/group-ui.js.txt`（原生 HTML/CSS/JavaScript，随二进制打包）：独立群聊 UI、组员列表、各成员模型配置与发送消息；前端无需重新编译。
- `src/gateway.ts`：沿用现有同源 token 安全边界，提供 `GET/POST /api/groups`、`GET /api/groups/<id>`、`POST /api/groups/<id>/messages`。前端以 `textContent` 显示不可信的群消息，避免 HTML 注入。
- 机器人身份和记忆分离：不同成员的 `Agent` 实例、模型会话 ID、群内 workspace 与 `MEMORY.md` 相互独立；共享的只有群消息记录。
- 资源限制：每群最多 6 人、每条消息最多 2 轮、每个机器人每次最多 3 轮模型调用；独立的 `delegate` 工具有共享子任务预算/递归深度限制。
- 当前选择串行逐个响应，以便后续成员能看到前一个人的意见，也便于控制模型调用成本。可并行的独立任务队列、WebSocket/SSE 推送与多机器人实际代码执行放入后续迭代，不虚称已实现。
- 语言路线：0.4.0 起全部是 TypeScript + Bun 单文件二进制（Python 已移除）；交互层仍用 JavaScript（群聊页随二进制打包）。

## 单文件补丁与审批差异预览

- `src/tools.ts` 的 `apply_patch` 用内联解析器处理单文件 unified diff。强制匹配文件头、每段 hunk 的旧/新行号以及逐行上下文，不允许模糊匹配、多文件补丁、重命名或新建/删除补丁；支持 LF、CRLF 和基本无末尾换行标记。
- `apply_patch` 先通过工作目录安全检查，读取原始字节、计算修改与 diff，再按原有 `readonly/auto/full` 权限审批。审批后重新比对原始文件防止过期补丁，最终交由 `CheckpointStore` 写入，保留 `/undo` 能力。
- 本地 `write_file`、`edit_file`、`plan` 与 `apply_patch` 的交互审批摘要附带最大 6000 字符的 unified diff（单侧超过 128 KiB 时不执行昂贵的对比运算，提示无法预览）；Web UI 保留预格式化换行和滚动，避免多行文本压成一行。超长预览标记截断，不宣称展示了完整改动。
- `CheckpointStore.latest_diff()` 展示最近活动检查点原始内容与当前文件差异；若文件哈希不匹配，报告外部冲突而非展示外部编辑。CLI `/diff` 为只读视图。
- 已知限制：路径安全检查与执行之间有残余竞态；本次不实现跨文件补丁事务、远端补丁、OS 沙箱或完整 Git 工作树 diff。

## 本地文件检查点和冲突安全恢复（CLI MVP）

- `nyra/checkpoints.py` 按 session_id + 真实工作目录计算隔离存储目录，每次顶层 Agent.run 重置当前检查点；子 Agent 分享父任务同一检查点。仅本地 `write_file`/`edit_file`/`plan` 的最终 UTF-8 文本写入由该管理器持久化；备份保存写入前原始二进制字节。
- 首次写入某文件前保存完整的原始字节（base64）、原始哈希、目标哈希；采用同目录临时文件 + os.replace 进行文件写入，尽量避免部分写入。一次任务改动多个文件仍归一条检查点。每文件 2 MiB/每轮 20 文件/最多 20 未撤销轮限制，超过上限则拒绝修改。
- `/undo` 恢复最近一轮，`/rewind N` 预检最近 N 轮所有关联文件及重叠的历史状态；任何哈希/符号链接/工作区路径冲突都会在写入前整体中止，避免覆盖其他人的编辑。恢复完成的检查点标记 undone，CLI 提示并写入会话通知后续 Agent 重新核对文件。
- 明确非覆盖范围：Shell/MCP/HTTP/全局 memory 与 skills/任何外部系统修改都不在检查点内；文件操作、哈希检查与多个文件恢复过程也不是 OS 级多文件事务，对并发修改存在 TOCTOU 残余风险。掉电/强杀在清单写入和实际文件替换之间可能留下无法自动恢复的记录，系统会按当前哈希拒绝危险的撤销，不默默覆盖。
- 本次交付 CLI 检查点入口；Web UI 独立撤销交互、操作前后 diff、shell/沙箱级快照等后续扩展，不能宣称已经完成。

## Session 授权进一步收窄（文件目标与 Shell 起始目录）

- 交互式 `auto` 的 `a` 绑定单个文件工具名称、`resolve()` 后的目标路径、规范化工作区和后端身份。不再按整个工具名授权全部文件；另一文件必须再次征得批准。
- Shell 缓存的精确匹配键包括原始命令字符串、规范化起始 `cwd`、工作区、timeout 和后端身份。Shell 的起始目录经本地真实路径包含关系校验，拒绝通过 `../`、绝对路径、已有外部符号链接指定工作区外目录。
- 回调型（例如 Web UI）审批总是先于终端缓存，避免同一个 ToolContext 中的旧授权绕过前端确认；非交互 auto 与 readonly 仍失败关闭。
- 安全范围：上述只约束**授权范围及起始 cwd**，不能限制 shell 内部命令行为、任意子进程、外部资源或 shell 切目录。远端沙盒符号链接未验证，文件操作仍可能存在 TOCTOU，不能当成完整文件系统沙箱。

## 工作目录内置文件写入限制与会话授权

- `src/tools.ts` 在执行 `write_file`、`edit_file`、`plan` 之前先校验目标：本机使用解析后的真实路径检查目标是否在实际 `workdir` 内，已有符号链接的外部目标会被拒绝。`full` 模式不能绕过此检查。
- `ToolContext` 持有单次会话的批准缓存，仅能为 `write_file`、`edit_file`、`plan` 记住某种文件工具，以及 shell **完全相同的命令文本和 cwd**；不会采用易混淆的前缀匹配，也不给 MCP/http_post/memory/skill 记住宽泛授权。回调式 Web UI 审批仍按原来逐项进行。
- 不可信 shell 仍可能读取或写入工作目录之外；运行命令的 cwd 不构成沙箱，MCP 和 HTTP POST 也可拥有外部副作用。记忆、技能、会话、证据文件在 Agent 数据目录写入属于独立路径。真实路径解析和执行操作之间也不是原子检查，尚需进一步防 TOCTOU。此改动是文件工具拦截，不是安全承诺“整个 Agent 只能写工作目录”。
- 下一步再考虑可信 shell 操作系统沙箱、命令前缀解析/白名单、细分路径级授权与审计日志。

## 安全模型

- **Key 不落地**：只从环境变量或已保存的安全连接器读取；绝不打印、记日志、写进项目文件。
- **写操作要审批**：默认 auto 模式每次写文件/执行命令都要确认；readonly 模式完全禁写。
- **MCP 子进程环境最小化**：启动时不直接复制整个 `os.environ`，只传系统启动所需变量与每个服务器明确声明的 `inherit_env`、`env`。后者优先级更高。这降低 Agent 自身模型 Key 意外被 MCP 子进程继承的风险；子进程仍以同一系统用户运行，**没有文件系统与网络隔离**，不能替代沙箱。
- **MCP 启动和调用均经过授权**：MCP 进程启动本身就可能有副作用。readonly 不启动、非交互 auto 不启动、终端交互 auto 逐项确认启动并对工具逐次确认、full 自动启动。终端 `/mode` 切换会关闭旧 MCP 进程并按模式重新加载；Web UI 在 auto/readonly 不自动启动 MCP，切换 full 才可启动，活跃任务期间拒绝切换以避免竞态。提示仅展示服务器/工具名，**该策略不是进程沙箱**。
- **MCP 协议双时代**：客户端优先 2026-07-28（`server/discover` 探测 + 每次请求 `_meta` 自带版本与能力），探测失败回退 `initialize` 握手（2025-11-25）；`-32022` 按服务器列出的版本重试；`tools/call` 遇 `input_required` 直接报错，不做 MRTR 追问；只做 stdio，未实现 HTTP 传输。
- **shell 黑名单**：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd` 写设备、关机/重启、fork 炸弹等一律拒绝（见 `src/tools.ts` 的 `checkShellDenied`）。
- **无真沙箱（诚实说明）**：MVP 没有实现容器/命名空间级沙箱，命令以运行 Nyra 的用户身份执行。这是路线图第一项；在此之前，请只在信任的目录用 full 模式。

## 单向编译：源只读、派生单向、写回必过门（H8，2026-11-25）

脑资产（长期记忆、技能、人设、规则）是源，运行态（索引、分块、缓存、账本）是派生。方向只有一条：源 → 派生，绝不反向。

- **源只读**：`MEMORY.md`（全局与各 Bot 的）、技能源文件（`skills/*.md`）、`AGENTS.md`、`SOUL.md` 在运行时只读。派生数据（FTS 索引、会话搜索索引、知识库分块、记忆 sidecar 索引）只写自己的派生文件，绝不写回源文件。
- **写 MEMORY.md 只有一个入口**：`appendMemory`（`src/memory.ts`）。模型工具 `memory_append`、记忆提炼、聊天导出导入，写盘前先过记忆门（`src/memoryGate.ts`，Kooyu 证据门）或进待审队列（`src/memoryProposals.ts`），绝不静默写记忆。删记忆走按会话删除，不直接改文件。
- **写技能源文件只有一个入口**：`saveSkillFile`（`src/skills.ts`）。只有用户批准的技能安装/保存能调它；模型不能直接写技能文件。
- **派生损坏可删可重建**：索引、分块、缓存坏了就删了重建，绝不反向修源；重建失败时报“派生已损坏”，不碰源。
- **钉住**：`tests/node/test-one-way-compile.test.ts` 静态扫描全仓——除 `src/memory.ts` 外，任何源文件不得用文件写原语写 `MEMORY.md`；除 `src/skills.ts` 外，任何源文件不得写技能目录；本节存在且点名两个入口，改了入口名测试就失败。

## 路线图

**v2 已完成（0.2.0）：** MCP 客户端、内置调度器/daemon、会话压缩、证据链、grep/git_status/http_post、provider 档案、web_search 双后端。

1. **真沙箱**：Linux 上用 bubblewrap 或 uid 沙箱跑 shell，写操作限制在工作目录。
2. **浏览器工具**：BrowserNavigate / BrowserClick / BrowserScreenshot 等，需要真实浏览器驱动（Playwright/Chromium），不属于 stdlib 范围；v2 只做了证据链轻量版。待定。
3. **GEPA 式自动学习**：任务成功后自动提炼技能（现在是模型主动调 `save_skill`，未来是成功后自动总结+评估）。
4. **桌面 UI**（部分完成）：本地网页界面 `nyra ui` 已可用（2026-11-16：会话列表、对话与工具卡片、网页内审批、证据与计划检查器，纯标准库、默认只听 127.0.0.1 + 启动 token）；技能浏览、独立桌面应用、按品牌形象的完整三栏 App 尚未开始。
5. **多模型路由**：按任务难度自动选便宜/强的模型（待做）。基础版已做完：主模型遇 402/429/5xx/超时/网络错误时自动按链切换（默认 DeepSeek flash → Grok → 本地 Ollama），401/403 不切换，每次切换打印明确提示；**兜底默认关闭**（2026-11-17 用户定安全事项）：只由用户自己开启（配置 `fallback_enabled: true` / `--fallback` / 环境变量），只切换到 `fallback_providers` 允许列表里的服务商，未知名字与未配置 Key 的备用会被跳过并记日志，网页聊天流与群聊回复里都会显示切换提示，定时任务与队列里不切换；见 `src/providers.ts` 的 `FallbackProvider` 与 README「模型自动兜底」一节。通用接入已做完：14 个内置预设（DeepSeek、Grok、OpenRouter、Ollama、OpenAI、Qwen、Kimi、GLM、Gemini、Mistral、Groq、Together、custom、Codex CLI）+ 配置里 `custom_providers` 可自定义任意 OpenAI 兼容接口并进 fallback 链；见 README「自定义 provider 与列出模型」「Codex CLI provider（不用 API Key）」两节。明文 `http://` 只允许本机地址（`localhost`、`127.0.0.1`、`::1`），外网地址必须用 `https://`，否则 API Key 会明文传输；校验在配置解析（`src/config.ts`）与发请求前（`src/providers.ts`）各做一道，两处报错文本一致。兜底链已接到的入口：命令行（REPL、一次性任务、`--plan`）、`--json` 单次模式、网页界面、群聊；定时任务仍用单个 provider。
6. **多会话并发**：每会话独立引擎（IllusionAgent 的做法），目前 Nyra 一次只跑一个会话。
7. **hooks / 插件**：任务前后钩子与第三方插件加载。

## 服务化架构（多用户，2026-11-16 用户定方向）

把 Nyra 从单用户 CLI 变成多用户云端 agent 服务的演进路线。Nyra 现在是第 1 步的单用户形态（缺真沙盒）；下面是服务化后的目标形态。

```
用户 App → API 服务 → 编排层(user_id → 沙盒) → 沙盒集群
                         ↓
              每用户持久卷 + 密钥库 + 浏览器配置
```

**1. 注册时不开机，只建「硬盘」**：注册只创建一条记录 + 一个持久存储（网络卷或 S3/R2 前缀）。用户第一次发消息时才懒加载开一台沙盒。大部分注册用户不常活跃，这一步省最多钱。

**2. 编排层：一张映射表**：表里存 `user_id → sandbox_id, 状态(运行/休眠/无), 最后活动时间`。来消息：有运行中的就复用，休眠就恢复，没有就新建并挂上该用户的卷。加一把锁（Redis），防止同一用户并发请求开出两台。

**3. 空闲休眠，秒级恢复**：空闲 5–15 分钟就暂停：内存和磁盘快照存下来，不占 CPU。现成方案：E2B 的 pause/resume、Fly Machines 的 suspend、Firecracker 快照、Daytona 的工作区自动停止。用户感觉不到关机，文件和进程都还在。

**4. 隔离与安全**：一用户一台微虚拟机（Firecracker/gVisor），不要多用户共用一个容器。出网走代理：封掉内网地址和云元数据接口，限速防滥用。密码/API key 存每用户密钥库，由代理在请求里注入，沙盒和模型都拿不到明文。CPU、内存、磁盘、单命令超时都设上限。

**5. 每用户的浏览器**：浏览器单独跑（自建 Playwright 池，或 Browserbase/Steel）。每用户保存一份 profile（cookie、登录态），用完写回存储，下次加载，就「记得登录」。

**6. 后台自己干活**：定时任务表 + 队列：到点唤醒该用户的沙盒，跑一个新 agent 会话，结果推送回 App。

**7. 成本控制**：按活跃时长计费的沙盒服务 + 休眠，成本和活跃用户数挂钩，而不是注册用户数。长期不登录的用户：删快照只留文件，再久归档到冷存储。免费用户限制每天的工具调用次数和机器时长。

**起步路线**：
1. 单用户跑通：模型 + E2B + 文件/shell 工具
2. 加映射表 + 持久卷，变成多用户
3. 加休眠/恢复和并发锁
4. 再加浏览器 profile、密钥库、定时任务

**设计时要补的缺口（诚实记录，动手前先定）：**
- 沙盒选型不是等价的：E2B 最容易起步但按分钟计费贵；Fly Machines suspend 便宜；Daytona 开箱即用；自托管 Firecracker 最便宜但运维最重。起步先定一家，别留到编码时再选。
- 映射表必须持久化（Postgres 之类），Redis 只做锁；映射表丢了要能从卷和沙盒服务商反查重建。
- 出网代理要做白名单，不只是封内网和元数据接口；模型仍可能从工具输出里看到密钥，DNS 渗出也要防。
- 浏览器 profile 要按用户加密存；云 IP 会被网站风控（登录态在新 IP 上常被要求二次验证），「记得登录」不是 100% 可靠。
- 冷启动延迟：新建沙盒 + 挂卷要 10–60 秒，消息层要先回「正在唤醒」或对活跃用户预热；同一用户并发消息要排队，不只是加锁。
- 计费归属：每个用户的模型调用、沙盒时长、工具次数都要记账，否则免费额度没法限。
- 注销要能彻底删：卷、快照、密钥、浏览器 profile 一起删。
- 后台任务的调度器本身要持久化、可恢复；结果推送需要通道（App 推送/websocket）。
- 服务化后 Nyra 的「单文件二进制、零 Python 依赖」定位不变：服务端是另一套技术选型，CLI 保持轻量，服务层另起炉灶。

**第 1 步进展（2026-11-16 已跑通并收进 Nyra 0.3.0）：** 单用户原型已验证：大脑在外、双手在沙盒。模型调用走保管的 DeepSeek 连接器（key 不出保险库），工具执行走 E2B 沙盒（SDK 用保管的 E2B 凭证替身认证，key 不出现）。验证脚本 `workspace/nyra/scripts/remote_run.py`：模型写 `prime_sum.py`、沙盒里运行、结果 1060、读回确认，全程 4 轮。Nyra 代码已上传进同一台沙盒（28 个文件），`--help` 正常，53 个测试全过。沙盒 `id0mo7xciz8qsrn88a06v`（base 模板，1 小时超时）。2026-11-16 同日，E2B 后端已收进 Nyra 本身（0.3.0）：`nyra/e2b_backend.py` + tools.py 里的执行后端缝，`--sandbox e2b` 切换，文件与 shell 工具（read/write/edit/list/shell/plan/grep/git_status）走沙盒，其余工具仍在本地，审批与黑名单两种后端都生效，子 agent 继承同一后端；真实 DeepSeek + 真实沙盒端到端已验证（沙盒里写 `sandbox-demo.txt`、读回、列目录，本地零写入）。限制：E2B 免费档沙盒超时上限 1 小时；沙盒不主动删除、到期自动销毁；定时任务仍走本地执行（未接沙盒）。下一步：第 2 步——映射表 + 持久卷（user_id → sandbox_id/状态/最后活动，Postgres 存映射）。

> 0.4.0 注：以上是 0.3.0 时期的历史记录。E2B 后端已在 0.4.0 随 Python 一起移除，Node 版 E2B 后端尚未移植；服务化第 2 步待重新定方向。

## 品牌与产品界面（2026-11-16 用户定：全部自己设计；2026-11-17 配色重做，UI v2 落代码；2026-11-18 形象去除）

Nyra 的整个 UI 由我们自己设计：头像 logo、产品界面、布局、审美。不抄任何同类产品的界面，只用通用应用布局惯例，视觉、组件、文案全部原创。

**形象（2026-11-18 用户决定去除）：** 毛绒动物形象已从产品中去除，不做动态版、也不静态保留：网页界面不再显示任何吉祥物头像（助手消息用字母 N 作头像），品牌视图的形象切换已撤下，小兔图片文件已移进回收站。旧的二次元少女形象 `assets/nyra-character.png`（2026-11-16 定）此前已弃用，设定集与动画小样仍在 `assets/` 里作历史资料。

**品牌色（UI v2，2026-11-17）：**
- 背景 `#F3F5F4`、表面 `#FFFFFF`、面板 `#E9EDEA`、文字 `#2A2D34`、次要文字 `#6E7278`、边框 `#DEE3DE`
- 主色鼠尾草绿 Sage `#5F7D5C`（深变体 `#4E6A4B`）、强调雾蓝 `#6B8CAE`、暖色点缀蜜桃珊瑚 `#E07856`（只小面积用，不做大面积填充）
- 成功 `#4C9A6C`、危险 `#C24B42`、代码块底 `#2A2D34` / 字 `#E9EBF0`
- 暗色变体：深炭底 `#1F2420` + 鼠尾草绿 / 雾蓝强调
- 旧墨 `#111A42` / 金 `#EAC45F` / 暖纸白 `#FAF8F4` 已退役，不要再用作品牌色（品牌视图的使用规则里写明了这一点）。

**界面语言：**
- 浅色优先、安静克制：浅灰绿底、深灰字、鼠尾草绿主色、蜜桃珊瑚只作点缀；深色模式用深炭底 + 同款鼠尾草绿 / 雾蓝。
- 三栏应用壳：左栏品牌卡 + 六视图导航（对话 / 技能与工具 / 定时任务 / 群聊 / 品牌与外观 / 设置）、中栏对话、右栏检查器（证据链 / 运行状态双标签）。
- 审批是一等公民：危险操作以卡片形式出现在对话流里（允许/拒绝/追问），不用弹窗挡路；批准卡片用珊瑚强调。
- 处处可核查：结论附来源链接，沙盒状态用药丸标签显示（运行中/休眠中/唤醒中），工具执行过程一步一屏可见。
- 字体：系统无衬线优先，数字与代码用等宽；中文按系统字体回落。
- 面板全部接真实数据（2026-11-17 补完）：设置视图的 provider 下拉可真正切换（`POST /api/provider`，新会话生效、已有会话保持原 provider、重启恢复配置）、模型卡显示兜底链、定时任务行显示上次运行时间与摘要、群聊“打开”直达具体群；没有后端数据的面板（如费用看板、守护进程运行状态）不编造数据、如实留空待立项。网页端新建定时任务于 2026-11-17 暂缓开放（等任务队列合并 E 后恢复，添加表单已撤下、后端 add 返回 409），请用 `nyra schedule add` 命令添加。

**界面原型：** 交互原型见 artifact「Nyra UI v2」（nyra-ui-v2），按上面这套语言做第二版；原型是前端模拟规格、不是可直接粘贴的代码，落代码时补了原型没有的暗色模式。第一版原型「Nyra UI Prototype」（nyra-ui-prototype）已过时、不动。

**虚拟 3D 形象（2026-11-18 用户决定去除吉祥物）：** 原计划的少女虚拟形象（VRM / Live2D 路线、动画小样 `assets/nyra-avatar-anim.mp4`）已搁置；毛绒小兔形象也不再做动态版、不静态保留，已从产品中去除。诚实说明：真正的 VRM 模型和 Live2D 绑定文件需要专业软件手工制作，Muse 不能直接生成可用的 .vrm 或 Live2D 模型文件。
