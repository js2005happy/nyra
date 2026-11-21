## 2026-11-22 — Versioned task contract metadata envelope (unreleased, static-only)

- Added bounded, deterministic standard-library JSON encode/decode for validated task-contract metadata. Import rejects duplicate JSON keys, unknown fields, wrong version, oversized payload and attempted injected authority flags; execution verification and automatic resume remain false.
- Added unexecuted regression definitions. This is not durable storage, confidentiality protection, encryption, a checkpoint or runtime integration. No tests, CI, installs, main merge or release.

## 2026-11-22 — Metadata-only task contract validation (unreleased, static-only)

- Added `angel/task_contract.py`: strict bounded in-memory task metadata with requirement/prohibition labels, revision and phase; rejects unknown fields, duplicates and conflicts; always reports execution unverified and auto-resume unsafe.
- Added unexecuted regression definitions. No persistence, secrets, prompt content, main-loop integration, test execution, dependencies, CI, merge or release.

## 2026-11-22 — Issuer-bound offline receipt verifier (unreleased, static-only)

- Added `angel/acceptance_issuer.py` with a separate HMAC domain and signed issuer/key-id fields, exact requirement/reference/revision/environment matching, and an externally supplied trusted key registry. Unknown or removed key IDs fail closed; existing v1 verifier unchanged.
- Added unexecuted regression definitions. No trusted registry provisioning, revocation persistence, replay prevention, proof of test execution, runtime wiring, CI, merge or release.

## 2026-11-22 — Offline receipt reference pinning (unreleased, static-only)

- Added optional `expected_reference` to `verify_receipt`: callers may pin a receipt to an independently selected artifact identifier; mismatch returns false and malformed expectations fail closed. Existing callers remain compatible.
- Added three regression cases (not run). This is not independent artifact validation, issuer authorization, replay protection or evidence of successful execution. No runtime wiring, dependencies, CI, merge or release.

## 2026-11-22 — Offline acceptance receipt verifier (unreleased, static-only)

- Added `angel/acceptance_receipt.py`: side-effect-free HMAC-SHA256 verification of an exact requirement, revision and environment using an independently provisioned secret. Refuses malformed input and short secrets; does not create or manage signatures/keys.
- Added unexecuted regression source `tests/test_acceptance_receipt.py`. No tests or CI were run. No runtime wiring, dependency, auto-replay, merge or production release. A valid MAC authenticates the secret holder's statement, not actual target behavior.

## Unreleased — 2026-11-22 conflicting acceptance receipt contexts

- Reject a target receipt that is reported against conflicting revision/environment pairs, even within one requirement. Preserve a distinct eligible receipt; never upgrade self-reported completion to independent verification. Added two unexecuted regression cases. No runtime integration, dependencies, test execution, CI trigger, or release.

## Unreleased — 2026-11-21 shared target receipt ambiguity

- Reject self-reported target receipts reused across distinct requirements, including when optional reference scopes are absent. A distinct eligible receipt can still count as reported completion; independent verification remains false. Added unexecuted regression cases. No runtime integration, new dependencies, or release.

## 2026-11-21 — Requirement-scoped acceptance references (static-only)

- Added optional, bounded per-requirement scoping for acceptance references. A receipt assigned to one requirement cannot count toward another when enabled. Caller scopes remain untrusted; no independent verification or runtime wiring. Added regression cases, not executed. No dependencies or deployment.

## Unreleased — 2026-11-21 acceptance reference allowlist

- Added an optional bounded caller-provided reference allowlist to the read-only acceptance assessor; unknown references no longer satisfy reported target completion when the gate is enabled. This is not independent provenance verification. Added regression cases (not executed); no runtime integration or dependencies.

## Unreleased — 2026-11-21 acceptance target-context matching

- Added optional exact expected revision/environment matching to the read-only acceptance evidence assessor. Target reports for a different revision or environment remain visible but do not count as reported complete; matching reports are still not independent verification. Added unexecuted regression tests. No new dependencies, runtime integration, permissions, tool replay or release.

## Unreleased — 2026-11-21 acceptance provenance context

- Strengthened the opt-in, read-only acceptance classifier: self-reported `target_verified` entries now require bounded, nonblank tested `revision` and `environment` descriptions; returned summaries retain that context. These values are untrusted claims, not independent proof. Lower evidence levels remain compatible.
- Added static regression cases (not executed). No runtime integration, new dependency, approval change, automatic replay, CI run, or release.

## Unreleased — 2026-11-21 read-only acceptance evidence classifier

- Added `angel/acceptance_evidence.py`, a side-effect-free, stdlib-only assessment of supplied requirement evidence. Distinguishes changed, static-reviewed, tests-passed and reported target-verified levels, retaining explicit incomplete requirements. Never claims independent verification or safe automatic resume.
- Not connected to the execution loop; no change to permissions, claim handling, persistence or external tools. Static review only; tests/CI not run.

## Unreleased — 2026-11-21 research-only security gate

- Recorded [Codex #61872](https://github.com/openai/codex/issues/61872) as external evidence for bounded deliverable acceptance and long-task convergence; distinguished the report from Angel defects and engineering inference.
- No runtime source change: Linux mount-namespace races, Windows handle-based checks, and integration of experimental claim into actual dispatch remain unresolved. Avoided speculative security changes that could falsely imply stronger guarantees. Static review only; no tests or CI run.

## Unreleased — 2026-11-21 Linux claim close-on-exec hardening

- Explicitly request `O_CLOEXEC` when opening both the Linux claim directory fd and exclusive claim file fd, to avoid accidental descriptor inheritance into executed child processes. Defense in depth; runtime already may set this flag. No new dependencies or automatic replay.
- Static review only; no tests, compilation, or CI. Experimental primitive remains disconnected from real tool dispatch; does not solve mount races or exactly-once execution.

## 2026-11-21 — Linux claim procfs fd 身份检查（未发布）

- `scripts/node_tool_claim.ts` 在使用 procfs 描述符路径排他创建前，比较 `statSync('/proc/self/fd/<fd>')` 与已打开目录 `fstat` 的类型、设备号、inode 和所有者；不一致或异常失败关闭。
- 无新依赖、不自动删除或重试 claim。仅静态审阅，未运行测试、编译或 CI；不解决 mount namespace 竞态、真实派发或 exactly-once。

## 2026-11-21 — Linux claim 非规范目录路径拒绝（未发布）

- `scripts/node_tool_claim.ts`：在预检之前要求绝对目录路径与 `resolve(directory)` 完全一致，拒绝点段、冗余分隔符和尾部斜杠等词法别名，避免祖先检查路径与实际打开路径的语义分离。保留失败关闭、unknown、不自动重放；无新增依赖。
- 仅静态审阅，未运行测试/编译/CI；仍未接入 Node 工具派发，不保证 procfs 挂载可信或 exactly-once。


## 2026-11-21 — P0 Linux claim 目录句柄最终关闭失败的错误归一化（仅静态审查）

- `scripts/node_tool_claim.ts`：最终目录句柄关闭失败现在统一抛 `ClaimUnavailable`，避免泄漏原生异常或报告成功；不删除 claim、不自动重放，无新增依赖。
- 仅静态审阅，未运行测试、编译或 CI；仍未接入真实派发，也不保证 exactly-once。
## 2026-11-21 — Experimental Linux claim cleanup (unreleased)

- Fixed a double-close error path in `scripts/node_tool_claim.ts`: a failed write or file fsync no longer closes the directory in both catch and finally. File close is always attempted; directory cleanup is attempted once on failure, and successful writes keep the directory descriptor for later fsync/verification.
- Failures still mean UNKNOWN; no claim deletion or automatic retry. Static review only; no compilation, tests, fault injection, or CI executed.


- 修复实验性 Linux Node/Bun claim 在 claim 文件 `closeSync(fd)` 抛错时可能遗留目录 fd 的异常路径：尝试释放目录 fd 并统一失败关闭，不自动重放；正常目录同步逻辑不变，无新增依赖。
- 仅静态检查，未运行测试/编译/CI；未接入真实工具派发，不提供 exactly-once 保证。

## 未发布（2026-11-21，Node claim close 异常清理）

- 实验性 `claimOperation` 在进入目录预检前拒绝非字符串、空字符串或含 NUL 的 `directory`，统一抛 `ClaimUnavailable`；不创建目录或执行工具，不增加依赖。
- 本轮仅静态核对，未运行测试、编译或 CI；Node claim 仍未接入真实执行链，不提供 exactly-once。

## Unreleased — 2026-11-21 Linux claim procfs 类型门禁

- 实验性 Node/Bun claim 在通过 `/proc/self/fd` 创建文件前，使用 Node 标准库 `statfsSync` 核对文件系统类型为 Linux procfs（`0x9fa0`）；异常或不匹配失败关闭，不新增依赖。
- 仅静态审阅，未运行测试/CI；不防挂载竞态，未接入真实工具派发，不提供 exactly-once。

## Unreleased — 2026-11-21 Linux claim 名称复核目录 fd 绑定

- 实验性 Node/Bun claim：写入后与目录 fsync 后的 claim 名称复核，改为相对于仍打开的 Linux 目录 fd 的 procfs 路径，避免重新解析可能被替换的原目录路径。无新增依赖；不自动删除 claim 或重放工具。
- 仅静态审阅，未运行测试/CI；尚未接入主 Node 工具派发，procfs 信任边界未验证。

## Unreleased — 2026-11-21 Linux claim 同一目录 fd 持久化

- 实验性 Node/Bun claim：保留 Linux 创建时的目录描述符直至目录 fsync 与最终名称核验，避免重新打开路径时同步被替换的目录。失败不自动删除 claim、不自动重放；无新增依赖。
- 仅静态审阅，未运行测试或 CI；未接入 Node 工具派发，仍有 procfs/文件系统信任边界与竞态。

## Unreleased — 2026-11-21 Linux claim fd-relative creation

- Node/Bun 实验性 claim：Linux 上使用已核验并保持打开的目录描述符，经 `/proc/self/fd` 执行排他创建，避免检查后关闭目录句柄再沿原路径创建；其他平台失败关闭。无新增强制依赖。
- 仅静态审阅，未运行测试或 CI；模块未接入真实工具派发，不提供 exactly-once 或生产安全保证。

## 2026-11-21 — Node claim 操作 ID 类型安全（未发布）

- 修复 `scripts/node_tool_claim.ts` 对 `operationId` 使用正则前未检查运行时类型的问题，拒绝数字、数组和对象隐式转字符串造成的 ID 别名；合法字符串的命名规则不变。仅静态审阅，未运行测试/CI；claim 仍未接入运行时，Windows 仍拒绝，不能保证 exactly-once。

## 2026-11-21

- 安全：Node/Bun 实验性 claim 在目录 fsync 后再次核对 claim 文件名与已写入 inode 的身份及私有性；失败保留 unknown。仅静态审阅，未运行测试/CI；仍未接入工具派发，不能保证 exactly-once。

## 未发布（2026-11-21，Node claim 文件身份复核）

- `scripts/node_tool_claim.ts`：写入并 fsync 后检查已打开文件与路径名称的设备/inode 一致、普通文件、单硬链接、当前用户所有、私有权限及预期长度；不一致时失败关闭并保留 unknown。仅静态审阅，未运行测试或 CI；仍存在路径 TOCTOU，未接入 Node 主运行时。

## 未发布（2026-11-21，Node claim 祖先目录权限门禁）

- `scripts/node_tool_claim.ts`：POSIX 拒绝不可信所有者或 group/other 可写的祖先目录，包括 sticky 目录；叶目录继续要求当前用户私有。只改善前置检查，仍有 TOCTOU、Windows 禁用、未接入运行时；仅静态审阅，未运行测试/CI。

## 未发布（2026-11-20，Node claim 创建前后目录身份核对）

- `scripts/node_tool_claim.ts`：在排他创建 claim 前打开并核验目录句柄，创建后再次核对 dev/ino，检测部分路径替换时失败关闭。仍是路径创建而非 openat，存在 TOCTOU；未接入主运行时，未运行测试或 CI，无 exactly-once 保证。

## 未发布（2026-11-20，Node claim 目录同步身份复核）

- `scripts/node_tool_claim.ts`：在目录 fsync 前后检查目录路径与打开 fd 的设备/inode 身份，并使用 POSIX O_DIRECTORY/O_NOFOLLOW 拒绝部分路径替换；失败关闭，保留 unknown。仅静态审阅，未运行测试或 CI；不消除祖先路径竞态，仍未接入主运行时。

## 未发布（2026-11-20，Windows claim 门禁修复）

- 修复 `scripts/node_tool_claim.ts` 的字面量 `\\n` 注释错误，使 Windows 失败关闭与绝对路径检查成为真正执行的代码；此前文档所述 Windows 拒绝行为在源码中并未生效。仅静态审阅，未运行测试/CI；模块仍未接入运行时。

## 未发布（2026-11-20，Windows Node claim 失败关闭）

- `scripts/node_tool_claim.ts`：在 Windows 上拒绝创建 claim，避免路径预检无法可靠识别 junction/reparse 时错误承诺可信执行所有权。POSIX 行为未变；仍未接入运行时。仅静态审阅，未运行测试或 CI。

## 未发布（2026-11-20，Node claim 存储目录预检）

- `scripts/node_tool_claim.ts`：拒绝相对 claim 路径、符号链接/非目录祖先及 POSIX 非当前用户所有或权限过宽的叶目录；不自动修改权限。仅静态审阅，未运行测试或 CI，尚未接入运行时；Windows reparse/路径竞态与跨平台持久化仍待解决。

## 未发布（2026-11-20，Node operation claim 原语，未集成）

- 新增 `scripts/node_tool_claim.ts`：Node 内置 fs/crypto 的排他 claim 文件与失败关闭 unknown 语义；不自动回收或重放，尚未接入主运行时。静态审阅，未运行测试或 CI，不能宣称解决工具重复执行。

## 未发布（2026-11-20，静态审计 v6）

- scripts/audit_runtime_boundary.py：每个路径读取一次有界快照，文件状态和源码行号使用同一份内容；新增 source_sha256 便于审计输入版本复核，JSON schema v6。未运行测试或 CI，不提供原子执行所有权。

## 未发布（2026-11-20，静态审计 v5）

- `scripts/audit_runtime_boundary.py`：必需的 Python/Node 入口文件缺失或不可读时失败关闭，新增 `missing_required_files`；统一 `audit_incomplete` 与非零退出码，JSON schema v5。仅静态修改，未运行测试；不提供运行时所有权保证。

## 2026-11-20 — 静态审计 v4

- `scripts/audit_runtime_boundary.py`：主分支 Node 派发、持久化文本锚点缺失时失败关闭，新增 `missing_node_anchors`，升级 JSON schema v4。避免上游重构后仍显示审计完整；仅静态源码修改，未运行测试，不提供运行时执行安全保证。

## 未发布（2026-11-20，Node 派发与持久化静态锚点 v3）

- 扩充只读标准库审计脚本：纳入 Node gateway/memory，定位会话及调度 Agent 入口、工具结果消息追加和 saveSession 的源码行号锚点，JSON schema 升至 v3。
- 更新 ROADMAP 和 VERIFICATION；未执行脚本或测试，不能把文本命中当作跨进程锁、崩溃恢复或工具副作用安全保证。

## 未发布（2026-11-20，静态审计证据 v2）

- `scripts/audit_runtime_boundary.py` 输出源码引用行号和读取状态，限制单文件大小；不可读、符号链接、超限不再被误报为缺失。JSON schema 升至 v2；不运行目标代码，不增加依赖。
- 同步 ROADMAP 与 VERIFICATION；未执行测试、CI、安装或发布，不宣称跨进程锁已实现。

## 2026-11-20 — 静态运行时边界审计（开发分支）

- 新增 `scripts/audit_runtime_boundary.py`：标准库、只读、机器可读的 Python/Node 两工作树入口差异审计工具，防止把旧 Python ToolJournal 的安全语义误报为 Node 主运行时保护。
- 不修改工具派发或权限策略，不自动恢复，不添加依赖；仅静态审查，未运行测试。

## 2026-11-20 — 运行时派发链静态核实（未发布）

- 只读审查确认：当前 main Node 入口 `src/cli.ts` → `src/agent.ts` 引用 `src/tools.ts` 的工具执行函数；Python `ToolJournal` 属于独立开发分支，不应宣称保护 Node。记录主分支现有 JSON 契约测试与开放 PR #105，避免重复实现。
- 更新 ROADMAP/VERIFICATION 的事实、推断、依赖和安全阻塞。**无运行时代码变更、未运行测试或 CI**；不宣称跨进程锁、恢复或外部副作用安全保证。

## 未发布（2026-11-20，Node/Python 执行入口归属核实；无运行时代码变更）

- 静态确认开发分支 Python Angel 与默认主分支 Node Nyra 为不同运行时，暂停向 Python ToolJournal 添加不能保护主分支的伪原子检查。ROADMAP 更新运行时审查前置任务及 2026-11-19 新用户反馈；VERIFICATION 记录静态限制。未运行测试或 CI。

## 未发布（2026-11-20，P0 执行所有权实施前置核对；无运行时变更）

- 记录开发分支 Python ToolJournal 与近期主分支 TypeScript 运行时的架构归属待确认问题；本轮不声称实现原子锁或安全恢复。
- ROADMAP 增补公开长任务可靠性反馈、证据日期与事实/推断区分；VERIFICATION 记录静态核对及未运行测试限制。未更改工具执行逻辑。

## 未发布（2026-11-20，ToolJournal finish 写后其他失败检测）

### 2026-11-20 — ToolJournal 结果写后计数一致性

- `finish()` 现在要求结果写入后的事件总数恰好增加 1，成功数符合本次报告，错误数符合本次成功/失败状态；异常时失败关闭并要求人工核查。
- 增加两项模拟异常快照的回归测试源码；本轮按授权未执行测试，不能宣称已通过。
- 该检查仍是非原子的并发/篡改异常检测，不是跨进程锁或外部副作用证明。


- `finish()` 在结果写入后的状态复核中，除未决和歧义外还拒绝其他调用的 `result_error`；本次 `success=False` 产生的单条错误记录不算竞争错误。增加两项回归测试源码，未执行。此处仍为检测，不是原子事务或 exactly-once 保证。

## 未发布（2026-11-20，ToolJournal finish 并发失败门禁）

- `finish()` 在初始状态及最终事件快照发现其他工具的 `result_error` 时拒绝提交本次结果；已报告失败可能有未核对的外部副作用，不能让另一调用的结果提交掩盖它。新增两项模拟回归测试源码，未运行。仍不提供跨进程事务、自动重放或 exactly-once 保证。

## 2026-11-20 — ToolJournal 并发错误结果的派发复核（静态修复）

- `begin()` 写入 intent 后的状态复核现在检查 `reported_errors`；最终事件快照也拒绝其他调用的 `result_error`，防止竞争进程在首次检查后报告失败仍放行新工具。新增两项回归测试源码，未执行；这仍非跨进程原子所有权。

## 未发布（2026-11-20，ToolJournal 已报告失败后的执行门禁）

- `begin()` 现在在已有 `result_error` 且无未知/歧义日志时也拒绝派发后续工具，避免将仅供人工核查的失败记录当作可继续执行的状态。失败可能已产生部分副作用；不自动恢复或重试。
- 新增回归测试源码验证拒绝后事件数不变。仅静态审阅，测试及 CI 未运行；不提供跨进程锁或 exactly-once 保证。

## 未发布（2026-11-20，ToolJournal 工具报告失败需人工核查）

- 修正只读人工对账信号：即使没有未决 intent 或日志歧义，存在 `result_error` 也必须返回 `manual_review_required=true`、`review_reason=reported_errors`。工具报告失败可能已经产生部分外部副作用，不应被界面误判为无需核查。
- 保留原因优先级：日志歧义 > 未知结果 > 报告错误 > none；不修改执行门禁，不自动重试。新增回归测试源码，未经授权未运行测试或 CI，无新增依赖。

## 未发布（2026-11-20，ToolJournal 人工对账原因分类）

- `inspect()` 新增只读 `review_reason`：`journal_ambiguous`、`unknown_outcomes`、`none`；优先报告日志歧义，不暴露调用 ID、参数或结果。与 `manual_review_required` 配套供人工对账界面区分原因，不授予自动恢复或执行权限。新增静态回归测试源码，未运行测试或 CI，无新依赖。

## 未发布（2026-11-20，ToolJournal 人工对账状态信号）

- `inspect()` 增加只读布尔字段 `manual_review_required`：当日志有未知结果或歧义时为 true；干净配对时为 false，但 `execution_verified` 与 `safe_to_auto_resume` 仍始终为 false。该字段不证明外部副作用已完成，也不提供跨进程锁或自动重放。
- 新增源码回归用例覆盖空日志、未决 intent 和已配对结果；仅静态审阅，未运行测试或 CI，无新增依赖。

## 未发布（2026-11-19，ToolJournal 孤立结果守卫源码换行修复）

- 修复上一轮孤立结果全局歧义保护在提交时误将实际换行写成字面量 `\n` 的源码错误；恢复有效的 Python 注释及 `invalid` / `pending` 赋值语句。未改变预期 fail-closed 规则。仅静态核对，未运行 Python、测试或 CI。

## 未发布（2026-11-19，ToolJournal 孤立结果全局歧义）

- 修复 inspect() 对孤立 result 的统计：过去 orphan 计入 unknown，却没有设置 journal_ambiguous，可能同时显示其他调用 reported_ok。现在孤立结果令整个快照歧义，所有成功/失败汇总归零、全部调用待人工核查。
- 新增静态回归测试源码，覆盖已配对成功与孤立 result 并存；未执行测试或 CI。无新依赖，不提供 exactly-once 或自动恢复。

## 未发布（2026-11-19，ToolJournal 结果槽位预留）

- `begin()` 在接近 `MAX_EVENTS` 时为本次 `result` 保留一个事件槽位；此前允许最后一个槽位写入 intent，随后 `finish()` 无法提交结果。增加模拟容量边界的测试源码，未执行。此项仅修复单会话容量边界，不提供跨进程锁、崩溃恢复或 exactly-once。

## 未发布（2026-11-19，ToolJournal finish 写后并发复核）

- `finish()` 在结果事件落盘后再次 `inspect()`，若竞争进程新增未决 intent 或出现歧义，则拒绝向调用方报告干净完成；已落盘事件保留供人工对账。新增模拟回归测试源码，**未运行**。此检测不提供跨进程原子事务或外部副作用 exactly-once。

## 未发布（2026-11-19，ToolJournal finish 最终快照并发门禁）

- `finish()` 在最终记录快照中再次拒绝其他未决 intent 或错配结果。新增模拟竞争 intent 的回归测试源码，未运行；不提供跨进程原子锁或 exactly-once。

## 未发布（2026-11-19，ToolJournal 最终快照并发意图复核）

- begin() 最后一次读取自己的 intent 时，同时核对同一快照的其他调用均已完整配对；竞争进程新增未决 intent 则拒绝派发。新增模拟测试源码，未运行；仍非原子锁或 exactly-once。

## 未发布（2026-11-19，ToolJournal 本次意图身份复核）

- `begin()` 二次全局检查后还确认本次 call_id 仅有一条未完成 intent；防止“本次已被并发标记完成、另一 intent 仍未完成”时全局 unknown=1 误放行。新增模拟回归测试源码，未执行；仍有检查与派发之间的竞态，不提供跨进程事务或 exactly-once。

## 未发布（2026-11-19，ToolJournal 意图写入后并发复核）

- `begin()` 在排他创建 intent 事件后再次检查日志：若已有另一个未决意图或全局歧义，则在返回可供工具执行的调用 ID 前失败关闭；保留本次未决事件供人工核查，不自动重试。
- 增加模拟并发写入第二个 intent 的回归测试源码，未运行。该二次检查不提供跨进程原子锁，检查后仍有竞态，不能证明工具 exactly-once。

## 未发布（2026-11-19，POSIX 末次目录句柄探测拒绝诊断）

- `ToolJournal._records()` 在末次 `os.fstat(directory_fd)` 遭遇权限拒绝等 `OSError` 时，统一抛出保留异常链的 `JournalError`，不将不可核验快照交给调用方。
- 新增空日志目录第三次 `fstat` 失败的模拟回归测试源码；仅静态检查，未运行测试或 CI。仍不提供原子快照、跨进程锁或 Windows 原生 ACL。

## 未发布（2026-11-19，POSIX 末次日志枚举拒绝诊断）

- POSIX 目录句柄二次 `os.listdir(fd)` 遭遇权限拒绝等 `OSError` 时，统一转为保留异常链的 `JournalError`，避免向上层泄漏未分类文件系统错误。补充模拟回归测试源码，未运行；不提供原子快照或跨进程锁。

## 未发布（2026-11-19，Windows 日志写句柄重解析点保护）

- Windows/path 写入回退在核验事件文件路径目录项前，先拒绝已打开写入句柄 `fstat` 报告的 reparse 属性；不依赖路径检查来替代句柄检查。
- 增加模拟 Windows 句柄属性与路径检查顺序的回归测试源码；按要求仅静态审阅，未运行测试或 CI。
- 仍不提供原生 ACL、稳定目录句柄、跨进程事务或 Windows 实机验证；无新依赖，不自动重放未知工具结果。

## 未发布（2026-11-19，Windows 事件打开句柄重解析点复核）

- ToolJournal 读取事件文件时，在路径目录项核验之外，对已打开文件句柄的 `fstat` 元数据再次执行 Windows reparse-point 拒绝检查，减少打开前路径检查与真实句柄不一致时的误信任。新增模拟元数据回归测试源码；未运行测试或 Windows 实机验证，不代表原生 ACL 或稳定目录句柄已完成。

## 未发布（2026-11-19，ToolJournal 祖先链接探测权限拒绝）

- `_safe_directory()` 遍历祖先时将 `is_symlink()` / `is_junction()` 的 `OSError` 统一转为保留异常链的 `JournalError`，拒绝在无法核验链接状态时继续使用日志路径。新增模拟祖先访问拒绝的回归测试源码，未运行；不代表 Windows ACL 或稳定句柄已实现。

## 未发布（2026-11-19，ToolJournal 回退路径符号链接探测拒绝诊断）

- Windows/path 回退读取在事件文件 `Path.is_symlink()` 元数据探测遭遇 `OSError` 时，现在保留异常链并统一抛出 `JournalError`，避免原始权限错误逃逸安全诊断；新增模拟拒绝的回归测试源码，未运行。不声称 Windows ACL、稳定句柄或跨进程事务已完成。

## 未发布（2026-11-19，ToolJournal 路径回退枚举拒绝诊断）

- Windows/path 回退读取的首次及末次 `iterdir()` 枚举若遭遇 `OSError`（含权限拒绝），统一转为 `JournalError` 并保留异常链，避免原始文件系统异常泄漏到调用者且不能误报空日志。新增两项模拟回归测试源码，未运行；未实现 Windows ACL、稳定句柄或跨进程事务。

## 未发布（2026-11-19，ToolJournal 目录类型检查拒绝语义）

- `_safe_directory()` 的末次目录类型检查由 `exists()/is_dir()` 改为 `lstat()`，仅明确缺失允许继续；权限拒绝或其他元数据读取错误保守抛出 `JournalError`。新增模拟回归测试源码，未执行。该增量不实现 Windows ACL、稳定句柄或跨进程事务。

## 未发布（2026-11-19，ToolJournal 读取权限拒绝不再视为空日志）

- 读取入口不再通过 Path.exists() 判断空日志；统一使用 _directory_identity()，仅真实 FileNotFoundError 返回空列表，访问拒绝触发 JournalError。新增模拟回归测试源码，未运行；不提供 Windows ACL 或跨进程事务。

## 未发布（2026-11-19，ToolJournal 目录访问拒绝诊断）

- 目录身份核验改用 lstat 并仅将 FileNotFoundError 视为不存在；其他 OSError（例如访问拒绝）明确失败关闭，避免将不可核验的日志误判为空。新增模拟 PermissionError 的回归测试源码，未执行。Windows ACL 与稳定句柄仍未实现。

## 未发布（2026-11-19，ToolJournal POSIX 写入后目录句柄复核）

- POSIX 事件写入完成并同步目录后，重新 fstat 已打开的目录句柄，核验类型、设备/inode 与私有权限；发现并发变化则失败关闭。新增模拟 chmod 的回归测试源码，未运行。此检查不能提供事务锁或抵抗拥有写权限的攻击者。

## 未发布（2026-11-19，ToolJournal POSIX 末次目录句柄复核）

- POSIX 读取侧在第二次文件名枚举之后再次 fstat 已打开的目录句柄，检查类型、身份及私有权限；若枚举期间目录权限被扩大则失败关闭。新增模拟测试源码，未运行。该检测不提供事务锁、ACL 或防篡改保证。

## 未发布（2026-11-19，ToolJournal 路径回退末次目录身份复核）

- 在第二次文件名枚举后再次核对日志目录身份，避免 Windows/path 回退在末次枚举期间发生目录替换却直接返回可信结果；新增模拟回归测试源码，未运行。此项仅缩小可检测窗口，不是原生 Windows ACL、稳定句柄或跨进程事务。

## 未发布（2026-11-19，ToolJournal Windows/path 读取快照复核）

- 路径回退读取完成后再次枚举目录项，与首次文件名集合比较；若期间新增、删除或重命名则拒绝报告稳定快照。新增模拟回退路径并发新增条目的回归测试源码，未运行。不提供 Windows ACL、稳定句柄、原子事务或外部副作用证明。

## 未发布（2026-11-19，ToolJournal 目录枚举快照复核）

- POSIX 读取事件后使用同一目录句柄再次枚举文件名；若有新增、删除或重命名事件则失败关闭，避免将明显不完整的快照当作稳定日志。新增模拟并发新增文件名的回归测试源码。仅静态检查，未运行测试；这不是跨进程锁，不能消除最终检查后的竞态或验证工具副作用。

## 未发布（2026-11-18，ToolJournal 空日志目录句柄复核）

- POSIX 日志枚举后即使没有任何事件，也再次核验已打开目录句柄的身份、类型与私有权限；此前仅在非空日志的逐事件循环中检查该句柄。新增模拟目录权限变化的回归测试源码。仅静态检查，未运行测试；不解决祖先目录 TOCTOU 或跨进程事务。

## 未发布（2026-11-18，ToolJournal 并发未决意图保护）

- `finish()` 仅在日志中恰有一个未知结果（当前调用）时才允许写入报告结果；若另一个进程已插入第二个未决 intent，则拒绝提交，保留人工对账边界。
- 增加第二个未决 intent 的回归测试源码；**仅静态审查，未执行测试**。这不是跨进程锁，也不能证明外部工具副作用完成。

## 2026-11-18 — Windows 事件写后元数据复核（仅静态）

- ToolJournal 的 Windows 回退写入路径在 fsync 后的目录项检查中增加硬链接数、mtime 与 ctime 校验，避免 inode 和大小未变时将部分就地修改误报为成功提交。新增模拟回归测试源码，未运行测试/CI；仍不能解决 Windows ACL、稳定目录句柄及 TOCTOU。

## 2026-11-18 — ToolJournal 全局歧义下隐藏部分成功统计

- 当存在孤立结果、重复事件或工具名不匹配时，`inspect()` 不再把其他已配对事件计为可信 `reported_ok` / `reported_errors`；将所有调用计入待核查 `unknown_outcomes`。避免消费者误读局部成功计数。新增模拟回归测试源码，**未运行**。不改变日志文件格式或自动恢复策略。

## 未发布：ToolJournal POSIX 写后目录项绑定（2026-11-18）

- POSIX 目录句柄写入路径在文件 fsync 后、目录 fsync 前，复核事件名仍指向刚写入的 inode，并核对类型、硬链接数、大小、时间戳和私有权限；不一致即失败关闭。新增模拟目录项替换的回归测试源码；仅静态审阅，未运行测试或 CI。不能消除同权限篡改、检查间竞态或外部工具副作用未知的问题。

## 未发布：ToolJournal 读取后目录项元数据复核（2026-11-18）

- 事件读取结束后再次核对目录项的文件类型、身份、硬链接数、大小及修改/状态时间；POSIX 同时核对私有权限，发现变化即失败关闭。新增模拟目录项大小变化的回归测试源码；未运行测试或 CI。不能消除检查间竞态或提供防篡改保证。

## 未发布：Windows 事件写入后目录项复核（2026-11-18）

- ToolJournal Windows 回退写入路径在文件同步后用 `lstat` 检查事件目录项，拒绝重解析点、文件身份或大小不一致；元数据读取失败则拒绝报告写入成功。新增模拟回归测试源码，未运行。此检查不构成 Windows 稳定句柄或 ACL 防护，仍存在 TOCTOU。

## 未发布：ToolJournal 结果提交前全局歧义门禁（2026-11-18）

- `finish()` 在核对目标 intent 前先检查整个日志的歧义状态；孤立结果等异常存在时拒绝新增结果文件，避免将局部正常调用错误地视作可信。新增模拟回归测试源码；仅静态审阅，未运行测试/CI。检查与写入仍存在跨进程竞态，不代表外部副作用已验证。

## 未发布：ToolJournal 根锚点循环修复（2026-11-18）

- 静态审查发现祖先遍历仍以 `while current != current.parent` 开始，导致前轮所述根锚点检查实际不可达；改为 `while True` 并保留锚点检查后的 `break`。新增锚点作为起始路径的回归测试源码。未运行测试/CI，Windows ACL 与路径竞态仍未解决。

## 未发布：ToolJournal 文件系统锚点检查（2026-11-18）

- 日志目录祖先检查现在也核验文件系统锚点（POSIX 根目录或 Windows 驱动器根），避免祖先遍历在锚点处提前结束。增加模拟锚点符号链接的测试源码；仅静态审阅，未运行测试或 CI。此项不解决 Windows ACL、稳定句柄或 TOCTOU。

## 未发布：Windows 事件文件重解析点失败关闭（2026-11-18）

- `ToolJournal._records()` 对事件文件目录项在读取前后检查 Windows `FILE_ATTRIBUTE_REPARSE_POINT`，拒绝普通文件模式伪装下的重解析点；元数据缺失时失败关闭。新增标准库模拟回归测试源码；仅静态审阅，未运行测试/CI。Windows ACL、祖先目录竞态与稳定句柄仍未实现。

## 未发布：Windows 悬空重解析点失败关闭（2026-11-18）

- ToolJournal Windows 祖先路径检查改为直接 `lstat()`，不再依赖可能对悬空 junction 返回 false 的 `exists()`；仅对真正不存在的路径跳过，其他元数据读取异常失败关闭。
- 新增模拟 `exists() == False` 但 `lstat` 标记重解析点的回归测试源码；未执行测试/CI。尚未实现原生 Windows 目录句柄或 ACL 保护。

## 2026-11-18 Windows 重解析点路径防护（静态审阅）

- ToolJournal 使用 Windows lstat 文件属性拒绝日志路径中的 reparse point，兼容缺少 is_junction 的 Python 3.11。新增模拟测试源码，未运行测试或 CI。

## 未发布：ToolJournal 未结调用执行门禁（2026-11-18）

- `begin()` 在发现先前 intent 尚无结果（`unknown_outcomes > 0`）时拒绝新工具调用；不将未知副作用视作已完成。补充测试源码覆盖阻断与结果记录后的恢复。仅静态审阅，未运行测试/CI；并发检查写入仍非原子事务。

## 未发布：ToolJournal 歧义日志禁止新增工具调用（2026-11-18）

- `begin()` 在写入新 intent 前检查现有事件摘要；发现孤立结果、工具名不匹配或其他日志歧义时拒绝新增工具调用，避免在不可信日志上继续执行。新增孤立结果回归测试源码，未运行测试/CI。仍不保证跨进程原子事务或外部工具恰好执行一次。

## 未发布：ToolJournal 写入后元数据失败关闭（2026-11-18）

- 在事件文件 fsync 后、关闭句柄前通过 fstat 检查普通文件类型、单硬链接、预期字节数与 POSIX 私有权限；发现写入期间元数据异常时拒绝宣称日志持久化成功。新增模拟写入后大小变化的回归测试源码；仅静态审阅，未运行测试或 CI。Windows ACL、目录替换竞态及恶意同用户修改仍未解决。

## 未发布：ToolJournal Windows 目录联接失败关闭（2026-11-18）

- 对日志目录及祖先路径增加标准库 `Path.is_junction()`（支持时）的 NTFS junction 检查，避免仅检查符号链接而遗漏目录联接。旧版 Python 无该 API 时保持原行为，不声称已解决 Windows ACL 或所有 reparse point。新增模拟回归测试源码；未运行测试/CI。

## 未发布：ToolJournal 跨工具结果歧义保守计数（2026-11-18）

- 当 result 与同一调用 ID 的 intent 工具名不一致时，`inspect()` 保留 `journal_ambiguous=true`，但不再将其计入 `reported_ok` 或 `reported_errors`，改计 `unknown_outcomes`。新增回归测试源码；仅静态检查，未执行测试或 CI。

## 未发布：ToolJournal 孤立结果计入未知状态（2026-11-18）

- 当结果事件存在但对应 intent 缺失时，`inspect()` 将该孤立结果计入 `unknown_outcomes`，避免在 `journal_ambiguous=true` 时仍显示零未知结果。新增回归测试源码；仅静态审阅，未运行测试。

## 未发布：ToolJournal 短读取失败关闭（2026-11-18）

- 读取事件后核对实际读取字节数与打开时的文件大小，拒绝虽仍可解析为 JSON、但未完整读取的事件；新增模拟短读取的回归测试源码。仅静态审阅，未运行测试。

## 未发布：ToolJournal 读取后目录项复核（2026-11-18）

- 读取事件后再次核对目录项与打开文件的设备号、inode 和普通文件类型，检测文件名在读取期间被替换的情况；新增测试源码，未执行测试。仍不提供防篡改保证。

## 未发布：ToolJournal 非阻塞事件文件打开（2026-11-18）

- 读侧在 POSIX 支持时使用 `O_NONBLOCK` 打开事件文件，避免恶意命名管道在文件类型 `fstat` 检查前永久阻塞；普通文件读取语义不变。新增标志回归测试源码，未运行测试/CI。Windows 仍采用原有回退，未声称 Windows ACL 已解决。

## 未发布：ToolJournal 写入侧 fdopen 异常句柄清理（2026-11-18）

- 写入侧 POSIX dir_fd 和跨平台路径回退两条分支在 os.open 成功、os.fdopen 失败时显式关闭 fd；避免敏感日志句柄泄漏。新增回归测试源码，未执行测试或 CI；不改变安全恢复策略。

## 未发布：ToolJournal 事件文件句柄异常清理（2026-11-18）

- `os.open` 成功但 `os.fdopen` 失败时，显式关闭事件文件 fd，避免异常路径泄漏敏感文件句柄；新增回归测试源码。仅静态审阅，未执行测试或 CI。

## 未发布：ToolJournal 读取期间同大小文件修改检测（2026-11-17）

- 事件文件读取前后增加同一 fd 的 mtime_ns/ctime_ns 对比；即使文件长度未变化，若元数据时间变化也失败关闭。新增模拟回归测试源码，未运行测试或 CI。
- 这是尽力检测，不是防篡改签名；同用户写入者、时间戳恢复与平台时间精度仍可能绕过检测。

## 未发布：ToolJournal 读取期间事件元数据复核（2026-11-17）

- 读取事件内容后对同一已打开文件再次 fstat，发现文件身份、类型、硬链接数量、大小或 POSIX 私有权限变化时失败关闭，减少检查与读取间的权限/截断竞态窗口。
- 新增模拟读取期间 chmod 的回归测试源码；仅静态审阅，未运行测试或 CI。不能防止同用户原地等长篡改或提供 Windows ACL 保护。

## 未发布：ToolJournal 时间戳格式失败关闭（2026-11-17）

- 读取事件时验证时间戳为合法 UTC、精确到秒的 ISO 8601 格式，拒绝无时区、非 UTC 偏移、非法日期及微秒格式；不改变写入格式。新增回归测试源码，未执行测试或 CI。

## 未发布：ToolJournal 安全拒绝原因保留（2026-11-17）

- 修复 `JournalError` 继承 `ValueError` 导致事件解析阶段的明确安全拒绝原因被笼统的“损坏或不可读取”覆盖；显式重新抛出 `JournalError`，仍统一包装其他 JSON/IO 错误。
- 增加重复 JSON 字段的精确错误信息回归测试源码。仅静态审阅，未运行测试或 CI。


### 未发布：事件文件权限失败关闭（2026-11-17）

- 2026-11-17 ToolJournal POSIX 事件文件权限检查：读取已打开事件文件的 fstat 权限位，拒绝组用户/其他用户可访问的既有事件文件；不自动 chmod。新增回归测试源码，未运行测试或 CI；Windows ACL 仍待研究。
### 2026-11-17 ToolJournal POSIX 目录句柄权限二次核验（仅静态审阅）

- 读/写侧在打开目录 fd 后重新检查 fstat 的权限位；读侧逐事件后也重新核验，降低路径检查与打开句柄之间 chmod 竞态造成的元数据暴露风险。
- 新增模拟目录句柄权限变化的回归测试源码；未执行测试或 CI。Windows ACL、祖先目录竞态和具有同用户权限的攻击者仍未解决。

### 2026-11-17 ToolJournal 既有目录权限失败关闭（仅静态审阅）

- POSIX 读取和写入前拒绝组/其他用户可访问的既有会话日志目录（权限位 `0o077`），不静默 chmod；新目录继续以 `0o700` 创建。
- 新增静态回归测试源码，覆盖读取、写入均拒绝及原权限保持不变；未执行测试。Windows ACL 仍需独立设计，不能宣称日志防篡改。

### 2026-11-17 ToolJournal 会话目录隐私权限（仅静态审阅）

- 新建会话日志目录显式使用 `mode=0o700`（仍受 umask 收紧），避免 POSIX 默认 `0o755` 暴露工具名称和调用时间元数据；不自动更改已有目录权限。
- 新增 POSIX 权限回归测试源码；未执行测试。Windows ACL、祖先目录替换及跨进程竞争仍待处理。

# Angel 变更记录

## 未发布：修复 ToolJournal 硬链接回归测试缺失导入（2026-11-17）

- `test_hardlinked_event_is_rejected` 调用 `os.link`，但测试模块未导入 `os`；补全标准库导入，避免该测试因 NameError 而无法验证硬链接拒绝行为。
- 仅静态检查，未执行测试或 CI；不改变生产运行逻辑。

## 未发布：ToolJournal 事件文件身份及硬链接检查（2026-11-17）

- 读取事件时核对打开句柄与目录条目的设备号/inode，拒绝路径替换；拒绝硬链接数量不为 1 的事件文件。Windows 仍有路径检查竞态，不保证防篡改。
- 新增两项回归测试源码；仅静态审阅，未运行测试或 CI。


## 未发布：ToolJournal JSON 歧义字段拒绝（2026-11-17）

- 事件解析拒绝重复 JSON 字段；严格要求 version 为整数 1，拒绝布尔 true 伪装为版本 1。
- 新增两项回归测试源码；仅静态审阅，未运行测试或 CI。不能据此宣称日志防篡改或自动恢复。


## 未发布：ToolJournal POSIX 读侧稳定目录句柄（2026-11-17）

- 在支持目录 fd 的 POSIX 系统中，以已核验目录句柄列举并打开事件文件，避免每个文件都重新解析完整路径；Windows 保留现有回退。
- 新增只读句柄使用及目录身份不匹配的回归测试源码；本轮没有执行测试、CI 或发布。


## 未发布：ToolJournal POSIX 稳定目录句柄写入（2026-11-17）
- 在支持 dir_fd 的 POSIX 系统中使用已核验目录句柄相对创建事件文件并同步目录；句柄与路径身份不一致时拒绝写入。
- Windows 维持路径检查回退，未引入强制第三方依赖；新增回归测试源码，未运行。该机制不等于跨平台完整 TOCTOU 防护或工具 exactly-once。


## 未发布：ToolJournal 目录替换检测（2026-11-17）
- 在事件读写前后比较日志目录的设备号与 inode，并在逐文件读取后再次检查；发现目录在操作期间变化时失败关闭，不将读取结果视为可信。
- 新增模拟读取/写入期间目录身份变化的回归测试源码；未执行。该方案是跨平台检测，不是 POSIX dirfd 或 Windows 句柄级原子防护；仍存在检查之间的 TOCTOU 竞态。


## 未发布：日志文件名完整性（2026-11-17）
- ToolJournal intent 改用 intent-<call_id>.json；读取时严格校验 intent/result 文件名与事件类型、call_id 对应，拒绝被重命名的结果事件。
- 新增重命名、错配、重复 intent 的回归测试源码；未执行。不能防磁盘写入者删除文件，也未消除目录替换竞态。


## 未发布：工具日志跨进程结果槽去重（2026-11-17）

- `ToolJournal` 的结果事件文件改为 `result-<call_id>.json`，使用标准库 `os.O_EXCL` 保证同一调用在多个进程竞争写结果时至多一个提交成功；intent 仍使用随机文件名。失败方抛出 `JournalError`，不覆盖已有结果。
- 新增针对重复 finish 与过期写入者的回归测试源码，**未运行**。这不构成外部工具执行幂等、目录防替换或安全恢复保证。


## 未发布（工具异常结果保守落盘，2026-11-17）

- 主循环在工具调用抛出异常时（包括外部 MCP 调用）不再直接跳过日志收尾：显式启用 ToolJournal 时写入 `result_error`，然后停止当前任务，要求人工核查外部副作用，绝不自动重试。
- 如果异常后连结果日志也无法写入，则保留未配对 intent（unknown），沿用“状态未知”错误。面向用户的错误不包含原始异常正文，避免泄露第三方响应或凭据。
- 增加异常日志记录、日志写入失败、默认关闭模式和敏感异常内容不外泄的测试用例。测试仅编写未运行；日志的 `result_error` 不是副作用已回滚的证明。

## 未发布（工具日志接入 Agent 执行边界，2026-11-17）

- `Agent(..., tool_journal=ToolJournal(...))` 显式启用后，在内置工具和 MCP 审批/执行前先写入 intent，返回结果后再写入 result；原有调用默认不启用。
- intent 持久化失败则拒绝执行；result 持久化失败则停止并报告执行结果未知，绝不自动重放。子 Agent 不隐式继承日志配置。
- 新增静态编写的 `tests/test_agent_journal_boundary.py`，尚未运行。仅记录结果字符串以“错误：”开头的错误状态，不能证明副作用是否成功；工具抛异常时保留 unknown。

## 未发布（工具意图与结果事件日志基础，2026-11-17）

- 新增 `angel/tool_journal.py`：独立于工具执行器的显式启用、元数据限定的 intent/result 事件记录；崩溃后缺少 result 只能报告 unknown，绝不自动重放。
- 每条事件独立 O_EXCL 文件写入并 fsync；不记录 prompt、工具参数、结果正文或凭据。随机文件名不代表时间顺序，检查时按 call_id 分组。
- 新增 `tests/test_tool_journal.py`（仅编写未运行）；尚未接入 Agent 主循环、跨进程锁或 CLI。当前不宣称日志可用于安全恢复。


## 未发布（会话状态诊断安全加固，2026-11-17）

- 修复空会话、空白助手结尾和没有用户消息时被误判为对话结束的情况；只有明确的最终助手正文才能报告 `conversation_ended`，仍不代表任务完成。
- 对整份会话的工具调用 ID 去重，识别工具结果未返回时又出现助手消息的歧义链；一律 `needs_review` 或拒绝损坏记录，绝不自动重放。
- 对会话文件及祖先目录拒绝符号链接；打开后再次检查普通文件与大小，读取过程中限制总字节，防止增长中的文件绕过预检查。
- 补充回归测试，但依用户要求仅做静态审阅，不运行测试或 CI。

## 未发布（长任务恢复基础：会话状态只读诊断）

- 新增 `python -m angel session-status SESSION_ID`，只读检查已保存 JSONL 会话的角色、工具调用与工具响应配对，识别需要人工核对的中断状态。
- 不打印对话或工具内容，不运行模型、网络或 Shell；拒绝非法会话 ID、符号链接、损坏及超过大小限制的会话文件。
- 输出明确区分 `conversation_ended` 和真正执行成功；当前 `execution_verified=false`、`safe_to_auto_resume=false`，不擅自重放有副作用的工具。附静态编写的回归测试，尚未执行。

## 未发布（EigenFlux 逐机器人网络权限上限）

- 新增 `angel eigenflux policy show|allow|deny|audit`，为每个主/群聊 Agent 显式记录固定网络行为的本地意向；默认拒绝，allow 需要 `--confirm`，deny 即时本地撤销，带 SHA-256 并发检查与有界审计。
- 新建群聊获得随机稳定 `instance_id`，删除同名群后重新创建不会继承旧群的 EigenFlux Home/网络行为许可；老群保持旧路径兼容。
- 策略不会安装、登录、广播或启用调度，所有 `effective_network_permission` 保持 false；后续网络执行层仍需遵守 EigenFlux 官方 onboarding 和用户授权。
- 新增身份隔离、撤销、并发冲突、损坏文件/符号链接、CLI 不创建模型/CLI 进程与群聊重建安全的回归测试。

## 未发布（EigenFlux bare-CLI 本地接入准备）

- 新增 `angel eigenflux doctor [--room ID --bot ID] [--check]`。默认不执行命令、不安装，也不发起网络行动；只计算独立、稳定的 EigenFlux Home 和准备状态。
- 可选 `--check` 对 PATH 中已安装的 CLI 运行 `version` 与 `skills path --host terminal` 两条诊断，最小环境变量、固定参数与超时；绝不在检测期间执行 onboarding、广播、注册或创建定时任务。
- 主 Agent 与各群聊机器人共享 Angel 项目代码，但拥有互相隔离的 EigenFlux 身份根目录。非法群 ID、非成员 bot、已有符号链接目录会拒绝。
- 新增纯模拟 CLI、凭据环境白名单、路径隔离与零副作用测试。该阶段不能宣称已加入 EigenFlux 网络。

## 未发布（Poppy OAuth issuer 双向元数据核验）

- 新增 `python -m angel --inspect-poppy-identity SITE`：不需模型凭证，只读核验公司域名的 OAuth protected resource metadata 与发行方 OAuth server metadata 双向绑定，拒绝缺少精确 resource、错配发行方和不合规 metadata。
- `--poppy` 下新增只读 `poppy_identity_check`；发行方验证通过依旧报告 `remote_calls_allowed=false`、`session_ready=false` 和 `oauth_ready=false`，不启动登录、不发送凭证、不调用远端工具。
- 区分合法 404/无 issuer 与服务器错误和网络超时；元数据禁止重定向，继续保持固定公网 IP/TLS 校验及响应大小限制。
- 新增 RFC 8414 issuer path、多 issuer 选择、资源回指、缺少端点、非 HTTPS、授权未完成以及 CLI 机器输出回归测试。

## 未发布（Poppy 站点/身份/scope 授权意向账本）

- 新增默认拒绝的本地 Poppy 授权意向账本，按精确 HTTPS 主机、访客/本地账户别名与单个 scope 隔离，禁止通配授权。`angel permissions list|check|grant|revoke|audit` 无需模型凭证或网络；用户明确 `grant --confirm` 才会持久化。撤销和有界审计历史随账本原子更新。
- `--poppy` 额外开放仅可读的 `poppy_permission_check`，模型不能变更权限账本。任何本地记录都不等于 OAuth token、Poppy Session 或执行许可；公司声明与实际用户同意严格分离。
- 对 `scope_hints` 的未知变更类型按 `irreversible` 风险处理，缺失个人信息提示保持未知，禁止无依据地显示成低风险。
- 新增 ACL 边界、账户隔离、版本冲突、符号链接、显式确认、模型工具不可提权以及 CLI 的回归测试。

## 未发布（Poppy 1.0 公共发现首阶段）

- 新增 `--discover-poppy SITE` 公共能力诊断：无模型 API Key 可读取并校验 HTTPS `/.well-known/poppy.json`，输出有限 JSON 元数据。新增 `--poppy` 显式启用 Agent 的只读 `poppy_discover` 工具，默认关闭。
- 发现层实施精确 well-known 重定向路径、最终主机和 `organization.domain` 绑定、1.0 版本及同主机备选版本校验、公开 DNS/禁止内网 SSRF 与证书 SNI 验证；不自动启动 MCP、登录或向站点发送令牌。
- 增加版本、重定向、SSL 地址绑定、公开 DNS、权限开关、CLI 无密钥诊断的模拟测试。Poppy Session、签名与 OAuth、远端 HTTP MCP、UCP 尚待完成。

## 未发布（长期记忆浏览与管理）

- Web UI 新增全局 / 群聊机器人长期记忆浏览器，可查看完整 Markdown、手动修改并保存、切换记忆主人。当前完整原文保存在独立 MEMORY.md，聊天压缩不会覆盖该文件。
- 新增 `GET /api/memory/scopes`、`GET /api/memory` 与 `POST /api/memory`，继续复用 token/Host 检查。群聊机器人只允许访问真实存在的成员，拒绝路径穿越与符号链接。
- 写入使用 SHA-256 文件版本校验与原子替换，同进程 `memory_append` 由锁保护；编辑器过期时返回 409，防止覆盖 Agent 新增记忆。
- 新增鉴权、群聊隔离、未保存内容冲突、容量限制与手动/自动压缩保持长期记忆不变的测试。未来继续补费用封顶、长任务恢复和自证、多 Agent 状态板。

## 未发布（apply_patch、/diff 与审批差异预览）

- 新增严格单文件 `apply_patch`，核验 unified diff 头与 hunk 行号、原始上下文，拒绝越界路径、过期文件、格式不正确及跨文件修改；复用本地检查点，支持 `/undo`。
- 本地 `write_file`、`edit_file`、`plan` 和 `apply_patch` 的审批中展示修改前后的差异；Web UI 以多行滚动文本显示；超大差异提示无法预览，E2B 的 Agent 不会看到仅限本地的 apply_patch 工具。
- REPL 新增 `/diff`，查看最近一次未撤销检查点对应的文件变更，外部文件更改显示冲突。
- 增加 CRLF、缺少末尾换行、拒绝不匹配补丁、审批期间竞态与跨平台 CLI 回归测试。

## 未发布（本地任务检查点与 /undo、/rewind）

- 为内置本地 `write_file`、`edit_file`、`plan` 增加任务级检查点：首次写入前保存原始文件字节，后续覆盖更新目标哈希，重启后仍可在相同会话/工作区撤销。
- 增加 REPL `/undo`、`/rewind N`；执行前核查所有目标文件当前哈希/路径，外部修改或符号链接变化时拒绝恢复，防止丢失人工或其他 Agent 编辑；撤销后记录会话通知。
- 限制每文件 2 MiB、每轮 20 文件、最多 20 个未撤销轮；超过范围会拒绝工具写入。远端 E2B、Shell、MCP、HTTP 及 memory/skill 不在撤销范围内。
- 新增持久化、覆盖/创建/二进制、跨轮、外部冲突、不同会话及 CLI 回归测试。


## 未发布（会话审批作用域收紧）

- 文件工具 `a` 授权由“全部同类型写入”收紧至“指定规范化文件路径 + 工具 + 工作区 + 后端”；不同文件重新申请。
- shell `a` 授权额外绑定规范化的 `cwd`、timeout 和执行后端，阻止等价路径的伪绕过与切换后端的缓存滥用；在审批前拒绝在工作区外启动 shell。
- Web UI 回调优先于已有缓存，避免跨前端旧授权绕过逐项审批；新增本机/远端的越界 cwd 和变更作用域测试。
- 仍不提供 shell 命令内部的 OS 级隔离；命令可自行改变路径和访问外部资源。


## 未发布（内置文件工作目录边界与会话审批）

- `write_file`、`edit_file`、`plan` 默认拒绝工作目录外的写入，拦截 ../、绝对路径、已有外部符号链接；E2B 写入路径增加词法边界检查。`full` 也不可绕过。
- `auto` 交互式终端增加 `a`（本次会话始终允许）：仅按单个内置文件工具名称或 shell 完全相同命令及 cwd 组合缓存。MCP、HTTP POST、记忆与技能继续逐次确认；新会话、清空会话和权限模式切换会清除缓存。
- 新增本机/E2B 边界、符号链接、会话独立批准、非交互与只读拒绝等测试。
- 这不提供 shell/MCP 沙箱；任意 shell 仍可能产生工作目录之外的副作用，远端 E2B 符号链接和竞态是现阶段限制。


## 未发布（只读计划与校验批准执行）

- 新增 `--plan`，只通过 `read_file` 和 `list_dir` 在工作目录内分析，生成 `plan.md`，不运行 shell/MCP/Agent；规划失败不覆盖原计划。
- 新增 `--execute-plan --approve-plan SHA256`，完整哈希匹配后才执行；默认 auto 工具级审批，禁止隐式升权至 full。
- 测试覆盖危险工具、路径越界、符号链接、计划篡改、失败保留原计划及 CLI 权限分离。


## 未发布（memory_append / save_skill 测试补齐）

- 新增测试 `tests/test_memory_skill_tools.py`（11 个）：`memory_append` 与 `save_skill` 首次有了直接的单元测试（此前只有群聊测试顺带调过一次 `memory_append`，`save_skill` 完全没有覆盖）。覆盖写入/多行折叠/空文本不写、readonly 与 auto 非交互拦截、技能文件可解析回读、非法技能名拒绝、覆盖重写；测试全程只写临时目录，不碰真实 `~/.angel/MEMORY.md`。
- 附带修正 README：版本号标题仍写 0.2.0、测试数仍写 127，已同步为 0.3.0 / 175。测试总数 164 → 175，全部通过。

## 未发布（Token 用量与上下文状态）

- 新增模型 API 响应 usage 统计，分别累计输入、输出、总 Token 和未报告用量的调用；不使用字符数冒充精确用量。
- CLI 新增 `/status` 和可选 `--context-window`，单次任务结束后将用量报告写入 stderr，保持 stdout 为任务结果。
- Web UI 为每个会话展示模型调用、已报告的 Token、参考上下文余量，未知数据明确标记；配置支持可选的 `context_window_tokens`。
- 新增 usage、CLI、Web UI 回归测试；功能队列记录在 ROADMAP.md。


## 未发布（独立机器人群聊与委派配额）

- 新增 `angel/groups.py` 多机器人群聊核心：每位机器人拥有自己的身份指令、模型选择、独立会话、记忆与工作目录；群消息可 @ 定向分配任务，多成员讨论有轮次上限和持久化记录。
- 网页界面使用独立的 `angel/group-ui.html` 与 `angel/group-ui.js`（HTML/CSS/JavaScript）实现群聊交互；在现有 Web UI 添加群聊入口与令牌保护的群聊 API。
- Agent `delegate` 增加共享子 Agent 数量预算、最大递归深度与子任务轮数检查，避免模型无限嵌套调用；子 Agent 继承所属机器人的独立角色与记忆。
- 对群聊创建、@mention、模型/会话隔离、长期记忆、访问鉴权、嵌套委派边界添加 mock 回归测试，无需真实模型密钥。
- 当前默认 readonly、串行讨论；尚未实现并行自主执行/群成员动态管理/完整操作系统沙箱。


## 未发布（MCP 启动权限与 Web UI 生命周期）

- MCP 服务器进程启动遵循审批模式：readonly 和无人值守 auto 不启动；终端交互 auto 逐项请求同意；full 可直接启动。
- 终端 `/mode` 和 Web UI 模式切换同时管理 MCP 子进程生命周期，防止权限降级后服务继续运行；Web UI 拒绝在任务进行中切换模式。
- 新增模拟真实 MCP stdio 子进程及 Windows CP1252 控制台的启动回归测试、Web UI 模式切换测试；仍需可信 CI 才能合并。


## 未发布（网页界面、终端打磨、项目官网）

- 新增本地网页界面 `python3 -m angel ui`（`angel/webui.py` + 内嵌单页 `angel/webui_page.py`）：纯标准库 `http.server`，无 CDN。左栏会话列表（读现有会话存储，可新建/恢复），中栏对话 + 可折叠工具调用卡片（auto 模式下卡片内批准/拒绝），右栏 provider/模型、证据来源链接、plan 步骤；设置面板只显示 Key 是否已配置，从不回显值。
- 网页界面安全：默认只监听 `127.0.0.1`，绑定非本机地址时打印警告；每次启动随机生成访问 token（页面经 `?token=` 带入，API 必须用 `X-Angel-Token` 请求头），本机监听时校验 `Host` 头，不回应跨域预检，页面带 CSP。
- `Agent` 新增可选 `on_event` 观察回调（工具开始/结果、助手消息），`ToolContext` 新增可选 `approve_fn`，让网页界面复用同一个审批门；不传时行为与之前完全一致，子 agent 继承同一审批回调。
- 终端 REPL 打磨：启动横幅、`angel[模式] ›` 提示符、工具调用分组显示（`┌ 工具 参数` / `└ ✓/✗ 结果`）、`/help` 对齐排版；颜色尊重 `NO_COLOR`、`TERM=dumb` 与非 TTY；一次性任务输出不变。
- 新增项目官网 `docs/`（GitHub Pages，纯静态、中英双语、暗色模式、无外部资源），地址 https://js2005happy.github.io/angel/ 。
- 新增测试 `tests/test_webui.py`（23 个，mock provider + 随机端口）、`tests/test_repl_ui.py`（12 个）、`tests/test_docs_site.py`（5 个）；`unittest discover` 共 127 个通过。

## 未发布（MCP 环境变量最小权限）

- MCP 子进程默认只继承启动所需的基础环境变量，不再复制宿主进程全部环境变量，避免自动暴露 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等无关凭证。
- MCP 配置新增可选的 `inherit_env`（精确变量名列表），与现有 `env` 合并；`env` 显式值覆盖继承值。非法变量名和非列表配置被拒绝。
- 新增跨平台模拟及真实 Python MCP 子进程的环境隔离回归测试；MCP 可执行程序仍以本机用户身份运行，此改动不是进程沙箱。

## 未发布（本机请求绕过代理）

- 修复：设置了 `HTTP_PROXY` / `HTTPS_PROXY` 但没设 `NO_PROXY` 时，发往本机（`localhost`、`127.0.0.0/8`、`::1`）的请求也被转发到代理，导致本地 Ollama provider、`web_fetch` / `http_post` 访问本机服务失败（代理返回 404/502），两个 mock 测试也因此在代理环境里失败。
- 新增 `angel/net.py`：本机地址的请求一律直连，其余地址照常遵守环境代理设置；provider 客户端、`web_fetch`、`web_search`、`http_post` 统一走它。
- 新增回归测试 `tests/test_net_proxy.py`（本机地址识别、代理指向不可用端口时本机服务仍可访问、远程地址仍使用代理）。

## 未发布（MCP 权限安全）

- MCP 工具调用统一接入工具层审批：`readonly` 禁止、`auto` 每次确认、`auto` 非交互拒绝、`full` 允许；不信任服务端提供的工具名称/描述来判断是否只读。
- 新增 MCP 审批回归测试：拒绝、授权、逐次确认、后台拒绝与审批提示敏感参数保护。

## 未发布（证据文件可靠性）

- 证据存档使用独占创建模式，遇到文件名冲突自动尝试下一个序号，避免覆盖已存在的证据；证据类型字段用于文件名时先进行安全字符过滤。
- 新增证据文件冲突、非法类型和连续保存的回归测试（`tests/test_evidence_files.py`）。

## 未发布（Windows 兼容性）

- MCP stdio 从不兼容 Windows 匿名管道的 `select` 改为后台读取线程 + 队列，保留响应超时和进程退出处理。
- 启动 Python MCP 子进程时默认配置 UTF-8 标准输出（保留显式环境变量覆盖），避免非 UTF-8 Windows 代码页导致服务器退出。
- E2B 沙盒路径始终使用 POSIX 规则解析，修复 Windows 客户端将 `/home/user` 转为反斜杠路径的问题。
- CLI 和调度器对旧终端编码使用 `backslashreplace` 安全降级，避免中文日志触发 `UnicodeEncodeError`。
- 新增 Windows/MCP 相关回归测试，并建立 Linux、Windows 多版本 Python 的 GitHub Actions CI。

## 0.3.0（2026-11-16）

- 新增 E2B 沙盒执行后端（`angel/e2b_backend.py`）：`--sandbox e2b` 让文件读写与 shell 命令在 E2B 沙盒里执行，不在本机上；`--sandbox-id` 可连回已有沙盒，不给则新建（默认 base 模板、1 小时超时）。沙盒模式下工作目录默认 `/home/user`。
- 执行后端是 tools.py 里的一道缝：`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 走后端，其余工具（联网、记忆、技能、delegate、http_post）仍在本地；审批三档与 shell 黑名单在两种后端下都生效；子 agent 继承同一后端。
- 核心仍是标准库 only：E2B 后端是可选依赖（`pip install e2b`），缺 SDK 时报明确安装提示；凭证优先用 `E2B_API_KEY`，否则走已保存的 Muse 连接器凭证替身，真实 key 不落盘、不进沙盒。
- 测试从 53 个增至 62 个，全部通过；真实 DeepSeek + 真实 E2B 沙盒端到端跑通（沙盒里写文件、读回、列目录，本地无任何写入）。

## 0.2.0（2026-11-16）

- 新增 MCP 客户端（`angel/mcp.py`）：stdio JSON-RPC，加载配置里的服务器，工具以 `mcp_<服务器>_<工具>` 形式调用；默认关闭，需 `mcp_enabled: true` 显式启用。
- 新增内置调度器（`angel/scheduler.py`）：`angel schedule` 子命令（list/add/remove/run/daemon），任务存 `~/.angel/schedule.json`，支持间隔或每天固定时间。
- 新增会话压缩（`angel/compact.py`）：`--compact <会话 id>` 与 REPL `/compact`，模型摘要 + 保留最近消息，模型失败时本地回退。
- 新增证据链（`angel/evidence.py`）：`web_fetch` / `web_search` 抓到的页面原文按会话存档，结论附来源链接。
- 新增工具：`grep_search`、`git_status`（只读）、`http_post`（走审批）。
- `web_search` 改为必应优先、百度兜底的双后端（按 IllusionAgent 的做法），全部失败才报明确错误。
- 新增 provider 档案（`profiles` + `--profile`），显式参数优先于档案。
- 新增核查式调研技能 `verify-research`：搜索→打开官网→逐项核对→存证→附链接交付。
- 浏览器类工具（navigate/click/screenshot）记入路线图，不做假的。
- 测试从 21 个增至 53 个，全部通过；真实 DeepSeek flash 端到端跑通。

## 0.1.0（2026-11-15）

- 首版：Python 标准库 only 的全能 agent CLI。
- 6 个 provider（deepseek/xai/openrouter/ollama/openai/custom），OpenAI 兼容协议。
- 11 个工具（读写改列文件、shell、web_fetch/web_search、记忆、技能、delegate、plan）+ 审批三档 + shell 黑名单。
- 技能系统（Markdown + frontmatter）、长期记忆、会话 jsonl 存储与恢复。
- 21 个 mock 测试通过；真实 DeepSeek API 端到端跑通。


## 未发布（2026-11-21：验收证据与执行安全调研）

- 静态核对实验性 Linux Node claim 与现有文档，确认尚未接入真实派发，现有 procfs 检查不能消除特权挂载竞态；本轮不改运行时代码、不扩大权限。
- ROADMAP 新增基于 2026-11-16 Codex #61857 和 2026-10-04 Codex #50771 的证据绑定、持久任务契约和无进展熔断候选项，明确外部个案与工程推断的区别。
- 仅静态审阅，未运行测试或 CI；没有发布或合并 main。
