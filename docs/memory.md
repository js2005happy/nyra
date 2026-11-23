# 长期记忆：检索与删除（缺口 1 + 缺口 2）

> 2026-11-20，P3 第一批。只学能力、不抄实现：接口语义学 EverOS
> （按会话删、按记忆 ID 删、进行中会话保护、删后汇报数量）与 Meta AI
> （用户能问它记得什么、逐条要求忘记），实现是 Nyra 自己的 Node
> 存储，不引回 Python/LanceDB。

## 存储：MEMORY.md 不动，结构化信息进 sidecar 索引

- `MEMORY.md` 仍是纯文本、一行一条，手工能改；`memory_append` 写
  的行是 `- [YYYY-MM-DD HH:MM] 正文`。
- 结构化信息（**id + 来源会话 + 时间戳**）存在同目录的 sidecar
  索引文件 `<记忆文件>.index.json`（`src/memory.ts` 的
  `syncMemoryIndex`）：行内容没变则 id 不变，新行分配新 id
  （`mem_` + 12 位十六进制），删掉的行从索引里消失。
- 索引是派生的：丢了或损坏就按当前文件重建，不丢记忆正文。
  `memory_append` 写入时把当前会话 id 记成新行的来源会话；
  手工写 / 旧行 / 导入的行的来源会话为 null。

## 记忆三分法（G-1）：session / state / long-term 各管什么

Google 的 harness 把记忆拆成三层（对话记录 / 草稿纸 / 长期偏好），
Nyra 的三层存储正好对得上，写清分工、不要混用：

| 层 | 是什么 | Nyra 里对应什么 | 生命周期 |
| --- | --- | --- | --- |
| session（对话记录） | 昨天聊了什么：逐条消息原文 | `~/.nyra/sessions/<会话 id>.jsonl`（会话 transcript）；运行事件 `runs/<运行 ID>/events.jsonl`（这次运行发生了什么） | 会话在就留着；接着聊靠它续上 |
| state（草稿纸） | 现在做到哪了：程序直接读的字段 | `runs/<运行 ID>/state.json`（任务、状态、用量摘要、轮次）；会话压缩后重读的也是这一层 | 运行期草稿；运行结束即定格，留作证据，不当长期记忆读 |
| long-term（偏好与知识） | 下次还记得什么：事实、偏好、不变量 | `MEMORY.md`（事实，一行一条）+ `~/.nyra/knowledge/`（知识库，BM25 检索）+ 技能（缺口 11 自沉淀）+ Soul Tenets（缺口 28：不变量与偏好） | 跨会话持久；写入要过 `memory_append`（索引同步）或技能沉淀 |

三条边界：

- session 不自动进长期记忆——只有 `memory_append` 显式写的才进
  MEMORY.md，对话记录本身不倒进长期记忆。
- state 不当长期记忆读——`state.json` 是运行的快照，查“上次同类任务
  的结论”走 `runRecall`（缺口 1 一节已述），不要直接读 state.json
  当事实。
- long-term 的三样（事实 / 知识 / 偏好）分开存、分开检索：事实走
  BM25（本页），知识走知识库（`src/knowledge.ts`），偏好与不变量走
  Soul（`docs/soul.md`）；检索时各查各的，不混成一锅。

## 作用域（owner）

记忆文件本身定 owner：全局 `MEMORY.md` 是 `global`，群机器人
`<home>/groups/<room>/bots/<bot>/MEMORY.md` 是 `bot:<room>/<bot>`。
检索与删除都先核 owner，跨 owner 不读不删（删错 owner 的目标只
跳过、不删、不抛错，汇报里列出来）。

## 缺口 1：检索（BM25 接进主循环）

- `src/memory.ts` 的 `searchMemoryEntries` 复用 `src/knowledge.ts`
  已有的 BM25（`tokenize` + `scoreBm25`，与知识库同一套公式），
  作用域过滤：owner 不符直接拒绝，`session_id` 有值时只看该会话
  写的记忆。**向量检索另算，本批不做。**
- 工具 `memory_search`（只读，不需审批）：`query` 必填，
  `limit` 默认 5，`session_id` / `owner` 可选。每条结果附来源
  （记忆 id、来源会话、时间戳、文件行号），与证据链同口径。
- 主循环：`Agent.buildSystemPrompt` 用 `buildMemorySection`——
  有命中时只注入命中的条目（附来源，标“历史记忆，需复核”），
  替代无条件读最后 40 行；无命中时回落到最后 40 行；记忆为空
  时不加任何东西。压缩后重读（`postCompactReReadNote`）仍读
  最后 40 行，不动。
- 与 #58 的 `runRecall`（`src/runRecall.ts`，runs/ 回忆）互补、
  不是重复：一个是 MEMORY.md 里的事实，一个是上次同类任务的
  结论，两边都留；检索结果的注入风格参照了它的“历史，需复核”标注。
- CLI：`nyra memory search <关键词> [--limit N] [--session <会话 id>]`。

## 主动记忆（G-P1-31，OpenClaw active-memory 借鉴）

- OpenClaw 的做法：回复前先搜记忆，简单召回不够时升级用 recall agent
  深挖；每会话可开关，跨会话记忆要显式开“Remember across
  conversations”。Nyra 的确定性版本（`src/activeMemory.ts`）：两档都
  是确定性搜索，不调模型、不花 token。
- **两档召回**：quick 档搜 MEMORY.md（BM25，5 条）+ 各知识库（BM25，
  每库 3 条）；命中少于 2 条就升级 deep 档——放宽上限（记忆 10 条、
  知识库每库 10 条）再加会话全文搜索（FTS5，每会话 2 条片段）。
  deep 档包含 quick 的结果，按分数合并去重。
- **开关**：全局默认关；`nyra memory recall on|off [会话 id]`——不给
  会话 id 改全局，给了只改该会话（会话开关优先于全局）；
  `nyra memory recall status` 看状态。开了才在回复前召回。
- **跨会话**：默认关。deep 档里关时只搜本会话；`nyra memory recall
  cross-on` 显式开了才搜别的会话。MEMORY.md 与知识库是本机的长期
  记忆，quick 档就搜；会话历史是跨会话的部分，只在 deep 档里按这
  条口径搜。
- **只读起步**：召回结果只注入提示词（附来源，标“历史内容，需复核”，
  会话片段先过脱敏），不改记忆、不发消息、不花钱。召回失败（库损坏、
  会话库不存在等）不拦运行，只是不注入；每轮先清掉上一轮的段落，
  不复用旧召回。
- **试跑**：`nyra memory recall test <问题> [--session <会话 id>]`
  只读跑一次召回，打印档位与命中，不进模型、不看开关。
- **证据链**：新运行事件 `active_memory_recalled`（档位、命中数、是否
  升级）与 `active_memory_escalated`（档位、命中数），只记数字与档位，
  不记召回内容原文。
- **不在本批**：模型 agent 深挖（deep 是更宽的确定性搜索，不是模型
  agent）；对话里自动提炼记忆见下节（G-P1-34）；向量检索（另算）。

## 对话里自动提炼记忆（G-P1-34，Pi memory-extraction 借鉴）

- Pi 的做法：模型一次最多提 5 条候选（add/update、scope 分 user/bot/
  group、category 分 about_you/work/how_to、正文最多 300 字），zod
  全量校验；组织结果只以“用户确认的提议”落盘。Nyra 的确定性版本
  （`src/memoryProposals.ts`）：**不调模型、不花 token**，只认用户消息
  里的显式表态——“记住……”（显式让记）、“我是/我叫/我喜欢/我不喜欢/
  我的……是”（身份与偏好）、“以后/今后/下次/每次……”开头的长期指令；
  任务里的临时要求、闲聊、转述一律不提。一次提炼最多 5 条新候选，
  单条正文最多 300 字，category 分 about_you/work/how_to（work 由
  “工作/项目/客户/公司/老板/同事/会议”这些词判定）。
- **待确认队列**：候选先进 `~/.nyra/memory-proposals.json`（0600 原子
  写，损坏先备份再回空账本），绝不直接写进 MEMORY.md 或结构化记忆库；
  同一规范化正文在队列里已有（无论 pending/confirmed/rejected）或已进
  结构化记忆库的，不再重复提。
- **对话结束自动提炼**：`src/agent.ts` 的 runLoopInner 在回复结束时跑一
  次抽取（只主对话——子 agent 与无人值守巡查不提炼，提炼失败绝不破坏
  本次回复）；新运行事件 `memory_proposal_extracted`（会话、新增几条、
  队列共几条）只记数字，不记候选内容原文。
- **人工确认**：`nyra memory extract <会话 id>` 从指定会话的对话记录里
  手动提炼一次；`nyra memory review` 列出待确认的候选（`--status` 可看
  confirmed/rejected 的）；`nyra memory review approve <id>
  [--content <改后正文>]` 确认进库，`nyra memory review reject <id>
  [--reason <原因>]` 拒绝。确认进库时过记忆证据门（逐字依据对照提炼
  时的用户原话 + 秘密拦截），没过的留在队列里（status 仍是 pending，
  decisionReason 记原因码），拒绝记进拒绝账本；拒绝的决定同样记进拒绝
  账本（action `proposal_reject`）与证据文件 `evidence/memory/`；决定
  的运行事件 `memory_proposal_decided`（候选 id、决定、进库条目 id）
  已注册进 EVENT_FIELDS。
- **不在本批**：模型提炼（Pi 的模型一次提 5 条本批没做，确定性规则先行）；
  向量检索（另算）；组织记忆（scope 只认 user，org 走证据门的老路）。

## 缺口 2：删除与控制

- 工具 `memory_forget` / `memory_delete`（同义，两个名字都留着：
  别家 MCP 叫 `forget_session`，用户口语也常说“忘记这条”）：
  `ids`（记忆 id 列表）或 `session_id`（删掉该会话写下的全部记忆）
  至少给一个，`owner` 与 `reason` 可选。
- **审批与 `write_file` 同级**：进 `MUTATING_TOOLS`，走
  `checkApproval`（readonly 拒、auto 非交互拒、权限规则 deny 拒、
  终端/`approveFn` 逐项批）；审批摘要先列出要删的条目与删后剩余
  数，让用户看一眼再批。也进 `HOOKED_TOOLS`（Pre/PostToolUse）
  与 `SESSION_FILE_TOOLS`（“始终允许”按记忆文件记）。
- **进行中会话拒绝**：目标里有进行中会话写的记忆时整批拒绝，
  一条都不删（工具侧以当前会话 id 为准；网关侧以正在跑的 live
  会话为准）。这是 EverOS 的 503 保护在 Nyra 的对位。
- **删除本身进证据链**：删了什么（id + 正文 + 来源会话 +
  时间戳）、谁批准的（终端审批 / 网关审批卡 / full 模式已授权）、
  删后数量（删了 N 条、剩 M 条），写进 `EvidenceStore`
  （kind `memory_delete`）。网关与 CLI 的删除同样落证据。
- 失败重试：`verifyWriteApplied` 能核查删除是否已生效（目标 id
  已不在记忆里），首次调用失败但实际已删时不再重复删。
- 网关：`DELETE /api/memory`（body `{scope, room?, bot?, ids? |
  session_id?, revision?}`；`revision` 有值时走 CAS——对不上
  409，一条都不删，复用 `memoryBrowser.ts` 的思路；进行中会话
  409；owner 不符的目标跳过不删）。信任级别与已有的
  `POST /api/memory`（整文件保存）一致：token 鉴权、用户主动
  发起，不另设审批；agent 工具侧的删除仍走 `checkApproval`。
  响应：`{deleted, deleted_ids, remaining, skipped, not_found}`。
- CLI：`nyra memory forget <记忆 id...> [--session <会话 id>]
  [--yes]`——缺省先列出要删的条目再问一次，`--yes` 跳过确认。

## 记忆证据门（Kooyu 记忆证据门，2026-11-23）

防记忆污染的硬机制：写记忆必须附用户原话出处，代码逐条校验，否则拒绝。

- **证据逐字**：模型工具 `memory_append` 须附 `evidenceQuotes`（1–8 条，每条 2–500 字），每条必须是当前用户消息的逐字原话（代码里逐条 `userText.includes(quote)` 校验）。转述、编造、拼凑的都拒绝；缺依据直接拒绝。当前用户原文由 Agent 每轮填进 ToolContext（`currentUserText`；resume 时取本会话最近一条用户消息）。
- **只认主对话 + 当前用户回合**：无人值守巡查（automation）与子 agent（委派深度 ≥1）不能写全局记忆——想记的东西交回主对话。门在审批之前：注定写不进去的调用不打扰用户弹审批卡。
- **秘密拦截**：sk-…、私钥、Bearer token 一律拒绝写入记忆；拒绝记录里只记命中的种类名，不记匹配到的原文。
- **拒绝留痕**：每次拒绝都记进 `~/.nyra/memory-gate-rejections.jsonl`（append-only 0600），`nyra memory rejections` 可查，不静默跳过。
- **结构化条目**：新模块 `src/memoryGate.ts`，条目结构 `{ id, scope: user/project, projectId, subject, content, sourceRefs, status: confirmed/proposed/deleted, revision, updatedAt }`（Kooyu 的 memory_entries 表在 Nyra 的对位；id 前缀 `memg_`，与 sidecar 索引的 `mem_` 区分）。账本 `~/.nyra/memory-entries.jsonl`（append-only 0600，同 id+revision 不重复追加，坏行跳过）；改一条记忆 revision+1，上一版正文记进修订行，`nyra memory entry <id>` 能看到全部修订历史；deleted 是终态，删了的不能再改。
- **CLI**（用户本人直接写）：`nyra memory remember <正文> --quote <用户原话> [--quote ...] [--subject <主题>] [--scope user|project] [--project <id>] [--status proposed|confirmed] [--ref <出处> ...]`、`entries`、`entry <id>`、`update <id> --content <新正文> --quote <用户原话>`、`rejections`。CLI 没有当前用户回合可对照，引用只验条数与长度（用户本人直接提供，不算模型推断）；含密钥同样拒绝并留痕。
- **不在门里的入口（诚实边界）**：Soul Tenet 只有用户直接跑 `nyra soul add` 才能写（没有模型工具能写 Tenet），不在门里；AGENTS.md / RULES.md 等 standing 文档走 `write_file`（审批门），`~/.nyra` 不在工作目录内、模型本来就写不到，工作目录下的 AGENTS.md 是项目文档不是长期记忆；MCP 的 `add_memory` 是已认证外部 agent 的显式写入、过独立审查（`reviewWrite`），同样不在门里；MEMORY.md 双向同步（结构化条目 ↔ MEMORY.md）可后做。

## 诚实边界

- 记忆 id 是 sidecar 索引分配的：索引丢失重建后 id 会变，删除时
  以当次查到的 id 为准，不要把 id 当永久标识存到别处。
- BM25 只按词面匹配：同义词、改述过的事实可能查不到；查不到时
  主循环回落到最后 40 行，不是“记忆里没有”。
- 索引文件与 MEMORY.md 是两份文件：外部直接改 MEMORY.md 后，
  下一次检索/删除时索引才同步，期间 id 可能与旧索引对不上——
  删除前先用 `memory_search` 查当次的 id。
- 网关 DELETE 与 CLI forget 是用户主动发起的直接调用，不经过
  agent 的审批卡；只有 agent 工具（`memory_forget` /
  `memory_delete`）走审批。
