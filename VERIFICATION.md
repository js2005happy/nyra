## 2026-11-24 — web_search non-2xx status guard (static only)

- **Source fact:** _fetch_search_page previously accepted any adapter-returned HTTP response and parsed its body, without an explicit status check. Standard urllib usually raises HTTPError, but alternative adapters may return non-2xx normally. The new guard rejects non-2xx or missing status before reading HTML; the existing source fallback remains.
- **External feedback reviewed 2026-11-24:** [Codex #34233](https://github.com/openai/codex/issues/34233) (opened 2026-07-19) reports secrets in tool output; [Codex #24823](https://github.com/openai/codex/issues/24823) (opened 2026-05-27) requests inspectable approvals. These are external user reports, not evidence of this exact Angel bug or prevalence. **Inference:** avoid treating an error page as search evidence and avoid unnecessary processing of untrusted error bodies.
- **Static verification:** compared targeted _fetch_search_page and _tool_web_search paths; no tests, compile, network, CI dispatch, account actions, main merge or release. Alternate transport compatibility and runtime behavior unverified.

## 2026-11-24 — web_fetch non-2xx evidence guard (static only)

- **Source fact:** web_fetch previously processed and could persist a response body without inspecting response.status; urllib transports normally raise HTTPError, but alternate response adapters can return non-2xx directly. The new guard returns a fixed error before read/save.
- **Scope:** one read-only fetch path, no external requests or test execution. Status may be absent in nonstandard adapters; fail-closed generic error remains. No claim of successful cross-platform or runtime verification.
- **Research context:** external [Codex #37121](https://github.com/openai/codex/issues/37121) (repository-recorded 2026-08-05) discusses incomplete/recoverable tool evidence, and [Codex #34233](https://github.com/openai/codex/issues/34233) (repository-recorded 2026-07-19) discusses sensitive tool output; reviewed from existing repository research 2026-11-24. Neither demonstrates this specific issue or its frequency.
- No tests, builds, CI, dependency installation, account changes, main merge or release.

## 2026-11-24 — Read-only web charset fallback (static only)

- Reviewed development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools, recent commits, open issues (none), PR #113 and available CI metadata; angel redirects to nyra.
- **Source fact:** server-controlled charset may cause LookupError after bounded network read, discarding received evidence. Shared fallback changes decoding only; not a confirmed production incident.
- **External feedback:** previously recorded Codex #37121 (2026-08-05) and #34233 (2026-07-19), reviewed from repository research 2026-11-24; neither establishes this specific defect.
- **Not executed:** tests, compile, CI, real HTTP, installs, external accounts, main merge, production release. Invalid bytes remain lossy; content privacy and cross-platform behavior unverified.

## 2026-11-24 — HTTP POST unsupported charset fallback (static only)

- Reviewed development branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, recent repository commits, open Issues (none), PR #113 and available commit status metadata (empty). Repository redirects from angel to nyra.
- **Source fact:** HTTP POST decoded the successful response with a server-supplied charset inside a broad exception handler; an unknown codec raised LookupError and was classified as unknown despite the observed 2xx. This is a source-level misclassification risk, not an observed production incident. The fallback affects decoding only and retains 2xx as a transport report, not proof of business acceptance.
- **External user reports reviewed 2026-11-24:** [Codex #31015](https://github.com/openai/codex/issues/31015) (opened 2026-07-03) discusses tool output privacy boundaries; [Codex #34233](https://github.com/openai/codex/issues/34233) (opened 2026-07-19) describes sensitive tool output. Neither establishes this charset defect or its prevalence; they inform the adjacent privacy backlog, not the implementation proof.
- **Not executed:** tests, builds, runtime POST, CI, dependency installation, account actions, main merge or release. The fallback cannot repair malformed response bytes, verify remote side effects, or guarantee cross-platform behavior.

## 2026-11-24 — HTTP POST structured outcome (static only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools and typed classifier on existing development branch; checked recent commits, open Issues (none), draft PR #113 and available CI metadata. No project code executed.
- Source fact: HTTP POST previously returned a status-prefixed string and journal/no-progress classification relied on legacy text prefixes. Now the in-process transport branch provides `StructuredToolReport` independently of untrusted body text; non-2xx/HTTPError are reported failures, network exceptions are unknown. Legacy `execute_tool` still returns a string and approval is invoked only once. A 2xx does not verify remote side effects.
- External feedback checked 2026-11-24: [Codex #58569](https://github.com/openai/codex/issues/58569), November 2026 report, describes successful local side effects preceding HTTP 400 continuation failure; [Codex #59305](https://github.com/openai/codex/issues/59305), opened 2026-11-04, requests distinguishing terminal tool completion from further model turns. These are other-product individual reports, not proof of an Angel incident or measured frequency.
- **Not executed:** tests, build, CI, live POST, dependency installation, account actions, main merge or release. HTTP 2xx is only a transport report, not a trusted business acceptance receipt. Timeout/connection failure remains unknown and is not retried.

## 2026-11-24 — local shell structured outcome (static only)

- Inspected development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools, structured classifier, current PR #113 and open issues. No project tests or shell commands executed.
- Source observation: local shell used only a text prefix for result classification; a successful command printing `错误：` could be misclassified as failed, while a timeout needed conservative unknown handling. Local shell now reports process outcome separately. This does not prove task success or external side effects.
- External report: [Codex #50301](https://github.com/openai/codex/issues/50301), opened 2026-10-02, describes batch shell failures obscured by aggregate exit codes. [Codex #24226](https://github.com/openai/codex/issues/24226), opened 2026-05-23, discusses shell exit-code interpretation. These are individual reports in another project, not Angel incidence statistics. Reviewed 2026-11-24.
- **Not executed:** tests, builds, CI, runtime commands, dependency installation, account actions, main merge or release. Remote shell remains legacy text-based; command chains still expose only aggregate process status.

## 2026-11-24 — delegated exception privacy (static only)

- Inspected development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools, tool report classifier, recent main commits, open issues (none), PR #113 and previous commit status (no statuses returned). `js2005happy/angel` resolves to `js2005happy/nyra`.
- **Source observation:** `Agent.delegate` previously returned `AgentError` message text and arbitrary exception type/message to its caller, potentially placing private paths, URLs or credentials in parent-model context and session records. Both exception branches now return fixed `错误：`-prefixed messages indicating unknown execution status. This does not change child creation or successful return handling.
- **External evidence reviewed 2026-11-24:** [Codex #34233](https://github.com/openai/codex/issues/34233) (repository record dates report 2026-07-19) describes sensitive configuration in tool output; [Codex #31015](https://github.com/openai/codex/issues/31015) (repository record dates report 2026-07-03) concerns redaction timing. These are individual reports from another project, not Angel incident counts or confirmation of this precise bug. Date/source descriptions reused from previously recorded research, not independently reverified this run.
- **Not executed:** tests, compilation, CI, network calls from project, installations, external account changes, main merge or production release. Static inspection does not establish runtime compatibility; successful child output and other tool results may still contain secrets.

## 2026-11-23 — web_fetch evidence URL echo (static only)

- Inspected README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools source, recent commits, open Issues (none), PR #113 and prior commit status/workflows (none returned). Repository `js2005happy/angel` resolves to `js2005happy/nyra`.
- Source observation: `web_fetch` appended the raw request URL to the model-visible evidence marker even though the URL is already passed to the evidence store. Removed only the redundant URL echo; evidence storage still records the URL, and the tool result can still contain sensitive page text. No new sanitizer or guarantees about persisted data.
- External individual report: Codex #34233 (2026-07-19, https://github.com/openai/codex/issues/34233) describes secrets appearing in tool output. This is not evidence of an Angel production incident or a measured rate.
- Static source review only. No tests, compilation, CI execution, network requests, account changes, main merge or production release. Cross-platform behavior unverified.

## 2026-11-23 — web_search response read bound (static review only)

- Reviewed `_fetch_search_page` and `_tool_web_search` on `feat/eigenflux-agent-network-policy-20261116`. Search backend HTML previously used unbounded `response.read()`.
- Changed to `read(128 * 1024 + 1)` and raise `ToolError` when oversized; existing `except ToolError` path records fixed backend rejection and falls back to next search provider. Partial HTML is never parsed as complete search results.
- No tests, builds, HTTP requests, CI jobs or live search were executed. Encoding behavior for within-limit responses is unchanged; network errors remain fixed-message failures. Cross-platform behavior and integration remain unverified.

## 2026-11-23 — bounded web_fetch input and partial-evidence marker (static only)

- Inspected development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Tools/Agent, recent commits, open Issues (none), PR #113 (separate evaluation work), and previous commit CI statuses/workflow runs (none returned). Original angel URL resolves to nyra.
- **Source fact:** `web_fetch` previously used unbounded `response.read()` and only truncated after decoding and HTML cleanup. Now reads at most 32,001 bytes and decodes at most 32,000 bytes; when over the cap, the cleaned body and saved evidence both explicitly say they contain only the read portion.
- **External user feedback reviewed 2026-11-23:** [Codex #55684](https://github.com/openai/codex/issues/55684) describes repeated truncated reads and wasted context; [Codex #37121](https://github.com/openai/codex/issues/37121) describes missing recoverable tool state after compaction. These are individual external reports, not incident counts or proof of this specific Angel bug. Creation dates not independently verified.
- **Not executed:** tests, builds, CI, real network requests, dependency installation, external account access, main merge, or release. HTML may be cut mid-tag or mid-codepoint; output/evidence may contain sensitive data; byte cap is not a sanitizer, complete-page guarantee, or recovery mechanism.

## 2026-11-23 — bounded successful HTTP POST response read (static-only)

- Reviewed development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Tools/Agent, recent repository commits, open Issues (none), PR #113 (separate evaluation work), and prior commit status (no statuses returned). Original angel URL resolves to js2005happy/nyra.
- **Source fact:** `_tool_http_post` previously used an unbounded `response.read()` before truncating displayed text. Now it reads at most 32,001 bytes, decodes at most 32,000 bytes, and marks any unread remainder. This is a byte cap, not a guarantee of exact character count or complete response retrieval.
- **External evidence reviewed 2026-11-23:** Codex #55684 and #37121, linked in ROADMAP. External user reports are demand signals, not evidence of an Angel incident or representative statistics. Issue creation dates were not independently verified.
- **Not executed:** tests, compilation, CI, HTTP requests, dependency installation, external account access, main merge, production release. No runtime or cross-platform guarantee. Successful content may contain secrets; other network tools may still read unbounded content.

## 2026-11-23 — HTTP POST non-2xx body pre-read guard (static-only)

- Inspected development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Tools/Agent source, recent commits, open Issues (none), PR #113 (evaluation work already in progress), and prior commit status (no checks returned). The original angel URL resolves to js2005happy/nyra.
- **Source fact:** Normal-response HTTP POST read/decoded the entire body before the non-2xx guard. The guard now executes before body access and returns the existing fixed failure. 2xx body handling, approvals and no-retry semantics are unchanged.
- **External evidence:** 2026-07-03 Codex #31015 and 2026-07-19 Codex #34233, linked in ROADMAP; external user reports are not proof of an Angel incident. Static risk inference: avoiding unnecessary error-body processing reduces exposure to untrusted response content.
- **Not executed:** unit tests, compilation, CI, real POST, dependency installation, external account access, main merge or release. No cross-platform or transport-specific runtime claims. Success bodies remain unbounded and model-visible.

## 2026-11-23 — HTTP POST non-2xx response classification (static-only)

- Inspected development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP and core tools/agent; checked recent commits, open issues/PR #113 and prior commit status (no statuses returned). The requested angel repository resolves to js2005happy/nyra; current main has independent TypeScript/AG-UI changes, not touched here.
- **Source fact:** Normal `open_url` response handling returned `HTTP <status>` without validating status, while the HTTPError exception path was already fixed. Added a non-2xx guard using response.status and a fixed failure message. This is a conservative fallback for alternate transports, not proof of remote failure or a successful side-effect receipt.
- **External evidence reviewed 2026-11-23:** [Codex #40646](https://github.com/openai/codex/issues/40646) (opened 2026-08-25) describes unsupported completion claims; [Codex #59305](https://github.com/openai/codex/issues/59305) (opened 2026-11-04) requests a trusted terminal-tool contract. External reports are not Angel incident statistics.
- Static source inspection only: no tests, compilation, CI dispatch, network POST, dependency installation, external account operation, main merge or release. Response.status accessibility across alternate transports and cross-platform behavior are not runtime verified.

## 2026-11-23 — HTTP POST error-body privacy (static-only)

- Reviewed branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, tools/agent, recent commits, open Issues/PR #113 and prior commit status (no statuses returned).
- Source fact: HTTPError forwarded untrusted response body into model-visible text; changed to status-only error. This does not prove remote POST side effects did not occur.
- External reports reviewed 2026-11-23: Codex #31015 (opened 2026-07-03) and #34233 (opened 2026-07-19), https://github.com/openai/codex/issues/31015 and https://github.com/openai/codex/issues/34233. External individual reports, not Angel incident-frequency evidence.
- No tests, builds, CI dispatch, HTTP calls, dependency installs, main merge or production release. Cross-platform behavior unverified.

## 2026-11-23 — HTTP POST HTTPError failure status (static-only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, `angel/tools.py`, `angel/agent.py`, `angel/tool_report_status.py`, recent commits, open Issues/PR #113 and preceding commit CI metadata (no statuses or associated PR-triggered runs returned).
- Source fact: `urllib.error.HTTPError` returned `HTTP <code>` without a recognized failure prefix. Existing classifier recognizes `错误：` and `执行失败：`. This change adds `错误：` only for HTTPError and retains code/body; it cannot establish whether a remote POST was applied.
- Public evidence reviewed 2026-11-23: Codex #40646 (2026-08-25, unsupported completion claims) and #58639 (2026-11-01 discussion, HTTP 400 failures). External reports are not Angel defect-frequency evidence.
- Static-only review; no tests, compilation, CI dispatch, HTTP calls, installs, account changes, main merge or production release. Cross-platform behavior and response-body privacy remain unverified.

## 2026-11-23 — git_status diff 非零退出（仅静态审查）

- 阅读开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、核心 tools/agent；查询近期提交、开放 Issues/PR、上一提交状态及 PR 工作流元数据（状态及工作流均为空，不能认定通过）。
- 源码事实：git status 已检查非零退出，git diff --stat 原先仅在退出码为零时附加统计，但在非零时仍返回部分状态。改为固定错误，不回显 git stderr；新增两个未执行回归测试定义。
- 公开反馈：2026-10-02 Codex #50301（批次失败被掩盖），2026-04-02 Codex #16619（命令空输出故障）；2026-11-23 查阅，属于外部个案，不证明 Angel 事故。
- 未运行测试、编译、CI、真实 Git 命令、安装或外部账户操作；未合并 main、未发布。静态代码变更不能证明运行正确或跨平台兼容。

## 2026-11-23 — 本地 shell 退出码状态（静态检查）

- 阅读现有 `angel/tools.py` 的 `_tool_shell` 和 `angel/tool_report_status.py`：旧逻辑丢失 `CompletedProcess.returncode`，非零退出无输出时会报告「（无输出）」。
- 静态确认新增条件仅影响本地 `subprocess.run` 返回的非零码；零退出、E2B 后端、审批和自动重试逻辑不变。输出原文仍可能含秘密；不把退出码当独立验收回执。
- **未运行**：单元测试、编译、CI、实际 shell 命令、Windows/Linux 跨平台验证。没有测试通过的结论。

## 2026-11-23 — 未知工具名回显隐私（仅静态）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、tools/agent，查询近期提交、开放 Issues（无）与 PR #113（固定任务评测）。源码事实：`execute_tool` 的未知工具分支原样插入调用者提供的 `name`；改为固定错误字符串，定义两项未运行回归测试。
- 2026-11-23 核对外部用户反馈：2026-07-03 [Codex #31015](https://github.com/openai/codex/issues/31015) 报告后置脱敏无法防止原始工具输出进入记录；2026-07-19 [Codex #34233](https://github.com/openai/codex/issues/34233) 报告敏感配置进入工具输出。这是其他产品个案，不是 Angel 已发生事故或总体频率证明。
- 仅 GitHub 静态阅读与文件写入；未运行测试、编译、CI、安装、真实工具执行、合并 main 或发布。其他工具成功输出、参数展示和模型输入未全局脱敏。

## 2026-11-23 — 本地 edit_file 缺失路径隐私（仅静态）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、核心 tools/agent，查询近期提交、开放 Issues（无）、PR #113（评测）及前次提交 CI 状态/关联工作流（均无记录，不能视为通过）。
- 源码事实：`_tool_edit_file` 在本地目标不存在时返回包含调用方 `path` 的字符串；本轮替换为固定 `错误：文件不存在`，定义一项未执行的绝对私人路径回归测试。
- 外部事实（2026-11-23 复核）：[Codex #31015](https://github.com/openai/codex/issues/31015) 报告后置脱敏无法阻止原始工具输出进入会话；[Codex #34233](https://github.com/openai/codex/issues/34233) 报告敏感配置进入工具输出。外部个案不证明 Angel 事故或普遍性。
- 工程推断：固定错误文本降低此路径泄露可能；正常编辑预览、成功内容、远端返回和其他工具仍未全局脱敏。未运行测试、编译、CI 或真实编辑；未安装、修改业务账户、合并 main 或发布。

## 2026-11-23 — 通用 ToolError 异常隐私（仅静态）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、tools/agent、既有回归定义；查询近期仓库提交、开放 Issues（无）、开放 PR #113（真实任务评测）及 CI 可用元数据。
- **源码事实**：`execute_tool` 原先将显式 `ToolError` 的异常正文插入模型可见错误；例如权限账本异常可包裹系统错误字符串。改为固定错误提示，保留 `错误：` 前缀。新增三项回归测试定义但**未执行**。
- **外部事实（2026-11-23 核对）**：2026-07-03 [Codex #31015](https://github.com/openai/codex/issues/31015) 报告后置脱敏不足；2026-07-19 [Codex #34233](https://github.com/openai/codex/issues/34233) 报告敏感工具输出。均为外部个案，不证明 Angel 已泄漏，也不能推断总体频率。
- **工程推断与限制**：显式异常可能含私人路径/令牌，固定文本降低此路径的回显风险；但也损失错误类型细节。正常工具返回、MCP 直接结果、HTTP 响应、模型入参和会话记录仍可能含敏感数据。本次未运行测试、编译、CI、真实工具或跨平台验证；未合并 main、未发布。

## 2026-11-23 — grep_search 正则错误信息隐私（仅静态）

- 读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、tools/agent 核心源码；查询近期提交、开放 Issues（无）、PR #113（真实任务评测），确认没有重复评测开发。
- 源码发现：grep_search 本地与远端的 re.error 分支将解析器异常正文返回给模型；本轮改为固定错误信息。正则解析器消息可能包含模式片段属于工程风险推断，未复现泄露。
- 2026-11-23 核对公开反馈：Codex #34233（2026-07-19，敏感工具输出）及 #31015（2026-07-03，后置脱敏时机），均为外部个案而非 Angel 事故证据。
- 未运行测试、编译、CI、安装或真实工具执行；跨平台及兼容性未经运行验证。成功搜索结果仍可能含敏感数据。

## 2026-11-23 — grep_search 缺失路径隐私（仅静态）

- 已检查开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Agent/Tools 源码、近期提交、开放 Issues/PR 与既有提交 CI 元数据；PR #113 涉及真实任务评测，未重复实现。
- 静态确认 `grep_search` 本地与远端缺失路径分支回显调用方路径；两处替换为固定错误，新增本地和模拟远端后端的回归测试定义。
- 仅静态阅读和 GitHub 文件写入；未运行测试、编译、CI、shell 命令、实际远端后端或业务账户操作。既有提交状态/工作流查询为空不等于通过。其他工具输出与成功匹配内容仍可能包含敏感信息。


## 2026-11-23 — git_status diff 阶段失败关闭（仅静态）

- 核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Agent/Tools 源码、近期提交及开放 Issues/PR；确认 `git_status` 的第二个 subprocess 原先没有超时捕获。
- 将第二阶段的 `TimeoutExpired` 与 `FileNotFoundError` 转为固定错误文本，不包含异常中的绝对路径；保留既有 15 秒上限，不自动重试，不改变远端 backend。
- 未运行测试、编译、CI、git 命令或外部 API 操作。未验证运行时行为及跨平台兼容性，不能视为 CI 通过或外部任务完成。

## 2026-11-23 — git_status 缺失目录隐私（仅静态）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、`angel/tools.py`、`angel/agent.py`，核对近期提交、开放 Issues/PR 和已有 CI 元数据；PR #113 已涵盖真实任务评测，本轮不重复实现。
- 静态确认本地 `_tool_git_status` 的缺失目录分支直接插入调用方路径；改为固定错误文本，新增绝对私人路径回归测试定义。
- 未运行测试、编译、CI、Git 命令或外部账户操作；未合并 main、未发布。GitHub 状态查询为空不能视为测试通过。远端后端和其他异常路径未覆盖。

## 2026-11-23 — HTTP POST exception privacy (static inspection only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools, prior privacy regressions, latest visible main commits, open Issues (none) / PR #113, and prior commit CI status/workflow metadata (empty). Source finding: `_tool_http_post` returned unexpected exception text verbatim; potential private URL or credential disclosure is inferred from source, not a reproduced incident.
- Changed only the unexpected exception branch to a fixed message; added two unexecuted regression definitions for secret-bearing exceptions and successful response preservation. HTTPError response bodies remain unchanged; POST side effects may be unknown after transport failure and must not be retried automatically.
- External reports reviewed 2026-11-23: [Codex #34233](https://github.com/openai/codex/issues/34233) opened 2026-07-19, [#31015](https://github.com/openai/codex/issues/31015) opened 2026-07-03, [#30831](https://github.com/openai/codex/issues/30831) opened 2026-07-01. External cases do not prove Angel incidents or population prevalence.
- **NOT RUN:** tests, compilation, builds, CI, real HTTP requests or cross-platform checks. No installation, external account modification, main merge or production release; code behavior remains unverified at runtime.

## 2026-11-23 — Web fetch exception privacy (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools and prior privacy tests, recent commits, open Issues/PR #113 and available commit status (no statuses returned). Source finding: `_tool_web_fetch` exposed arbitrary network exception text. This is an inferred risk, not a reproduced incident.
- Changed only the exception return to a fixed message; added two unexecuted regression definitions covering sensitive exception text and successful fetch preservation. No project network request was executed.
- External feedback reviewed 2026-11-23: [Codex #31015](https://github.com/openai/codex/issues/31015) (2026-07-03), [Codex #34233](https://github.com/openai/codex/issues/34233) (2026-07-19). These external reports do not prove an Angel incident or frequency.
- **NOT RUN:** tests, compilation, builds, CI, cross-platform checks. Normal fetched content, URL metadata, HTTP POST responses and other tools remain outside this change; no comprehensive secret-scanning claim.

## 2026-11-23 — Web search exception privacy (static inspection only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools and structured status classifier, latest commits, open Issues/PR and available CI status before editing. Source finding: `web_search` interpolated ToolError and arbitrary network exception strings into model-visible error summaries; these may include user queries, URLs or credentials. This is a source-derived risk, not a reproduced incident.
- Replaced only those two exception branches with fixed provider-specific text; added three unexecuted regression definitions for explicit exceptions, unexpected exceptions and fallback success. No network searches were performed by the project code.
- External user feedback: [Codex #31015](https://github.com/openai/codex/issues/31015) opened 2026-07-03 (pre-transcript redaction), [Codex #34233](https://github.com/openai/codex/issues/34233) opened 2026-07-19 (tool-output credential disclosure). External reports do not prove an Angel incident or frequency.
- NOT RUN: tests, builds, compilation, CI or cross-platform checks. Other tools, normal search snippets and evidence files remain outside scope; no claim of comprehensive DLP.

## 2026-11-23 — Legacy local read_file missing-path privacy (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools and classifier, recent commits, open Issues/PR and CI metadata before editing. Confirmed legacy local `_tool_read_file` exposed missing-path text while trusted local structured adapter did not.
- Replaced only the legacy missing-file interpolation with a fixed error; defined a regression test with a fake private path. Checked the intended source diff by inspection only.
- External feedback: https://github.com/openai/codex/issues/31015 and https://github.com/openai/codex/issues/25585 (reviewed 2026-11-23; publication dates not independently verified). External reports are not evidence of an Angel incident.
- No test execution, compilation, CI dispatch, installation, account changes, main merge or production release. Runtime behavior and security effectiveness remain unverified.

## 2026-11-23 — Trusted local listing explicit ToolError privacy (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, existing regressions, recent main commits, open Issues/PR #113, and prior commit status (no statuses returned).
- Source finding: the trusted local `list_dir` adapter interpolated explicit ToolError text into model-visible output; replaced with fixed text and defined an unexecuted mocked regression. Potential disclosure is inferred from code, not a reproduced incident.
- External reports reviewed 2026-11-23: [Codex #34233](https://github.com/openai/codex/issues/34233) (2026-07-19), [#31059](https://github.com/openai/codex/issues/31059) (2026-07-03). Individual external feedback; no Angel incident or prevalence claim.
- **NOT RUN:** tests, scripts, builds, compilation, CI or cross-platform execution. No installs, account changes, main merge or production release. Generic dispatcher ToolError, normal file contents and remote tools remain outside this change.

## 2026-11-23 — Missing local list_dir path privacy (static inspection only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools/classifier, list_dir regression definitions, recent commits, open Issues/PR #113, and available CI metadata.
- Source finding: the trusted local listing adapter returned the original path in its missing-directory error. Replaced that branch with a fixed message and defined a regression using a private absolute path; no runtime leak or successful test claimed.
- External context reviewed 2026-11-23: Codex #34233 (2026-07-19) and #31059 (2026-07-03) are individual external privacy reports, not Angel defect evidence.
- **NOT RUN:** tests, scripts, builds, compilation, CI, cross-platform execution. No software installs, account modifications, main merge or production release. Successful listings and other tool outputs may still contain sensitive information; no comprehensive secret redaction or external verification.

## 2026-11-23 — Missing local read_file path privacy (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, core Agent/Tools/classifier, existing regression definitions, recent commits, open Issues/PR and available CI metadata before the edit.
- Source-derived finding: the local adapter echoed the caller's path when a file did not exist. Replaced only this message with a constant and defined an unexecuted regression case for a private absolute path. No runtime incident demonstrated.
- External feedback reviewed 2026-11-23: Codex #34233 (2026-07-19) and #31059 (2026-07-03) concern tool-output privacy and file-read sanitization; they do not prove this Angel issue.
- **NOT RUN:** tests, scripts, compilation, builds, CI, cross-platform execution. No installs, external account changes, main merge or release. Successful read content and explicit ToolError messages remain possible privacy surfaces; this change is not comprehensive secret redaction.

## 2026-11-22 — Generic dispatch exception privacy (static review only)

- Inspected development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools/classifier, recent main commits, open Issues/PR #113, and available workflow metadata. Source review found raw exception text returned from the generic `execute_tool` fallback.
- Changed only unexpected TypeError/Exception formatting; explicit ToolError behavior remains unchanged. Defined three mocked regressions, not executed. Potential disclosure is a source inference, not an observed Angel incident.
- External feedback: [Codex #34233](https://github.com/openai/codex/issues/34233), opened 2026-07-19, describes credential disclosure via agent tool output elsewhere; not proof of Angel impact.
- **NOT RUN:** tests, scripts, compilation, builds, CI or cross-platform execution. No install, account modification, main merge or production release. ToolError messages and normal tool output can still contain sensitive information; no general DLP guarantee.

## 2026-11-22 — Local read_file typed outcome (static review only)

- Inspected development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools/classifier, latest main commits, open PR #113 and Issues, and available CI metadata. Existing list_dir typed adapter is distinct from read_file.
- Static source finding: model-visible file contents can begin with legacy error prefix or be empty, neither of which proves read failure. Added local-only typed report path, exception redaction and six regression definitions. No runtime reproduction claimed.
- External Codex #60104 (2026-11-07) concerns rework/progress reliability, not this file-read issue; mapping is engineering inference.
- **Not run:** tests, scripts, compilation, builds, CI, cross-platform checks. No installs, external account modifications, main merge or production release. In-process reported_ok is not independent verification or authorization to replay tools.

## 2026-11-22 — Local list_dir argument error privacy (static review only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools/classifier/tests, latest main commits, open issues/PR #113 and prior commit status (no statuses).
- Source finding: TypeError strings were returned to the model; replaced with fixed error text in two local paths and defined mocked private-path regression. Not a reproduced runtime leak.
- External Codex #60104 (2026-11-07) discusses repeated work, not this privacy issue; risk is engineering inference.
- Not run: tests, scripts, builds, compilation, CI or cross-platform checks. No installs, account changes, main merge or production release.

## 2026-11-22 — Local list_dir exception redaction (static review only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, structured result classifier, related regression source, recent main commits, open Issues/PR (#113), and prior commit CI metadata (no statuses or PR-triggered runs returned).
- Source-derived privacy risk: generic OS exception messages may contain absolute private paths and were included verbatim in model-visible local directory listing errors. Changed only the generic exception branch to a fixed failure message and kept typed `reported_error`; defined a mocked OSError regression that checks path redaction and authority flags.
- External report [Codex #60104](https://github.com/openai/codex/issues/60104), observed 2026-11-07, concerns repeated work and inaccurate progress in another product; it is not evidence of a path leak in Angel. This fix is a source-based preventive privacy measure.
- **Not run:** tests, scripts, builds, compilation, CI, or cross-platform checks. No software installation, account modifications, main merge or production release. Other tools may still expose exception details and require separate review.

## 2026-11-22 — Local list_dir typed outcome: static review only

- Inspected README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/tools/classifier, commits, open issues/PR and available CI metadata. Added unexecuted regression definitions for empty/missing directories, adversarial filenames, and backend exclusion.
- No test, compilation, workflow, installation, main merge or production release performed. In-process `reported_ok` is not independent acceptance evidence; no automatic retry/resume.

## 2026-11-22 — Blank legacy tool report boundary (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, classifier, tests, recent commits, open Issues/PR and prior commit CI metadata. Found via source inspection that blank strings were neither failure nor unknown; optional journal could record result_ok without any outcome signal. Added conservative blank classification and unexecuted regression definitions.
- External Codex #60104 (opened 2026-11-07) is an individual report of wasted work, not evidence of this Angel defect. Engineering inference: blank tool output should not become a positive report. Tests, scripts, compilation, CI and cross-platform runtime checks NOT RUN. No installs, external account changes, main merge or release.

## 2026-11-22 — Untyped non-text tool report boundary (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent, Tools, report classifier, no-progress observer and regression source on the existing development branch; inspected recent repository commits, open Issues and PR #113. Codex #60104 (2026-11-07) is external user testimony, not an Angel reproduction.
- Static code-path finding: non-text values were neither failed nor unknown and could be recorded as `result_ok` by the optional journal. Changed the classifier to mark non-text as unknown unless `raised=True`; defined unexecuted regression cases. Legacy strings unchanged, no verified side effects or resume authority.
- NOT RUN: tests, scripts, compilation, CI or cross-platform execution. No dependency install, account modification, main merge or production release. Workflow/check status is not a runtime verification substitute.

## 2026-11-22 — Typed unknown journal safety (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, typed classifier, tests, branch and latest commits; open Issues empty and PR #113 concerns evaluations. Prior commit 1e38fe9 returned no combined statuses or PR-triggered workflow runs (not proof of CI pass).
- Static source finding: `success=not reported_failure` classified typed unknown as journal success. Added an explicit unknown bit and required both nonfailure and nonunknown for journal success. Added unexecuted regression assertions. External Codex #60104 (2026-11-07) is an individual report, not an Angel reproduction.
- NOT RUN: tests, scripts, compilation, CI, cross-platform runtime checks. No installs, external account modification, main merge or production release. Typed reports remain untrusted as independent verification.

## 2026-11-22 — Typed tool outcome boundary (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/tool dispatch, legacy classifier, observer and regression source; checked repository redirect, development branch, latest commits, open Issues/PR (#113 covers evaluation), and previous workflow metadata (no PR-triggered runs returned).
- Added immutable validated StructuredToolReport and classifier handling. Unknown is not reported failure but never verification; exceptions override reported success. Plain dictionaries cannot impersonate typed reports. Four regression definitions added, not executed.
- Public feedback reviewed 2026-11-22: [Codex #60104](https://github.com/openai/codex/issues/60104), opened 2026-11-07, is an individual report of wasted work, not an Angel reproduction. Future adapters must preserve provenance and external side-effect uncertainty.
- NOT RUN: tests, scripts, compilation, CI, cross-platform checks. No install, account modification, main merge, production release or new dependency.

## 2026-11-22 — Legacy tool result classifier alignment (static inspection only)

- Read development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, observer and regression source; checked current branch, recent commits, open Issues/PR (#113 is evaluation-related), and previous commit status (no statuses returned).
- Source inspection found disagreement between ToolJournal (`错误：` only) and the advisory observer (`错误：` or `执行失败：`). Added one conservative classifier, wired both paths, and defined unexecuted regression cases for known prefixes, exceptions, non-text returns and invalid flags.
- External reports reviewed 2026-11-22: [Codex #40646](https://github.com/openai/codex/issues/40646) (2026-08-25) and [#45395](https://github.com/openai/codex/issues/45395) (October 2026 discussion). These are individual reports, not evidence of this Angel source mismatch.
- **Not run:** tests, scripts, builds, compilation, CI, or cross-platform runtime verification. No install, external account modification, main merge or production release. Classification is legacy compatibility, not a trustworthy structured tool outcome or proof of external side effects.

## 2026-11-22 — Advisory source newline repair (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, observer, tests, recent commits, open Issues/PR and prior combined CI status/workflow metadata (no status or PR-triggered runs returned). Open PR #113 is about evaluations, not this fix.
- Found six literal backslash-n sequences within the Agent observation comment, swallowing assignments needed before `state.needs_attention`. Replaced only these sequences and added an unexecuted assertion for one failed-tool idle observation. No runtime reproduction claimed.
- External reports checked 2026-11-22: [Codex #47802](https://github.com/openai/codex/issues/47802) (2026-09-24), [#60104](https://github.com/openai/codex/issues/60104) (2026-11-07). These are unrelated external failure reports, not proof of this Angel defect. **Not run:** tests, scripts, builds, compilation, CI or cross-platform runtime checks. No installs, main merge or production release.

## 2026-11-22 — Per-run advisory detector isolation (static inspection only)

- Inspected development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, observer and regression source; checked recent commits, open Issues/PR and prior CI metadata. Source-derived risk: a reused caller-owned detector retained idle counts between separate Agent.run invocations.
- Added a bounded reset_run() operation and invoke it at the start of Agent.run; added an unexecuted regression definition checking that one prior idle observation plus one new tool return does not hit idle_limit=2. Existing observer remains opt-in and advisory only.
- External Codex #35259 (2026-07-24) and #60104 (2026-11-07) are individual reports of wasted activity, not Angel reproductions. **Not run:** tests, scripts, compilation, CI or cross-platform checks. No installs, user account access, main merge or production release. Independent progress attestation remains unavailable.

## 2026-11-22 — Idle observation granularity (static inspection only)

- Read README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, observer and regression source; queried canonical repository branches, latest commits, open Issues/PR, prior commit statuses and PR-triggered workflow runs. The prior queried commit returned no status/workflow records, which is not evidence of CI success.
- Source-derived finding: one model tool request and its tool return each incremented the same counter. Removed the model-request observation, retaining the post-tool untrusted observation. Added unexecuted regression definitions for threshold 2 (no warning after one return) and threshold 1 (one advisory warning).
- External reports reviewed 2026-11-22: [Codex #35259](https://github.com/openai/codex/issues/35259) (opened 2026-07-24) and [#60104](https://github.com/openai/codex/issues/60104) (opened 2026-11-07); they do not establish this Angel defect. The defect rationale comes from source inspection.
- **Not run:** tests, scripts, compilation, CI, cross-platform runtime verification. No software installed, account changes, main merge, production release or dependency added. Observer remains caller-owned, and a returned tool is not independent proof of progress.

## 2026-11-22 — Terminal reply idle signal (static review only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, no-progress observer and regression definitions; recent commits, open Issues/PR and CI metadata were queried. Original loop observed a model message before checking tool calls, allowing final-only replies to raise an advisory alert at low thresholds.
- Source change gates the model-message idle observation on nonempty tool calls; terminal response remains delivered normally. Regression definition now expects no warning on a final-only reply. The tool-return observation remains unchanged.
- External issue links and dates in ROADMAP are individual user reports, not proof of this specific Angel bug; the code-path false-positive is a source-derived finding. No tests, builds, scripts, CI, installs, merges or production release performed. Runtime and cross-platform behavior remain unverified.

## 2026-11-22 — Advisory idle Agent wiring (static review only)

- Reviewed agent loop and no_progress event vocabulary. Added optional observation after model response and tool return; emits only bounded idle count and false authority flags. No task content or tool arguments in attention event.
- Added unexecuted regression definitions for disabled default and advisory-only final response. No tests, scripts, build, CI, installs, main merge or production release.
- Caveats: successful tools are not proof of progress; productive work may trigger advisory; reused caller-owned detector may retain counts; no runtime cancellation or verified completion.

## 2026-11-22 — Advisory progress-event classification (static review only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, no-progress module and tests; checked recent repository commits, open Issues/PR, development branch, prior commit statuses and PR-triggered workflow runs (no status/run records returned).
- External user reports reviewed 2026-11-22: [Codex #37800](https://github.com/openai/codex/issues/37800) (2026-08-10), [#41007](https://github.com/openai/codex/issues/41007) (2026-08-27), [#47802](https://github.com/openai/codex/issues/47802) (2026-09-24). These are not Angel defect reproductions.
- Source-only review: bounded known event names, strict bool attestation, unknown/untrusted status rejected as progress, and no state change on malformed events. Added unexecuted regression definitions. **No tests, scripts, compilation, CI or cross-platform runtime checks performed.**
- Caller attestation is not cryptographic proof; no main-loop integration, tool execution, automatic pause/retry/resume, account access, main merge or production release.

## 2026-11-22 — Advisory no-progress observer (static review only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools and task-contract code; checked branch, prior commit status and open Issues/PR. External user reports reviewed 2026-11-22: [#37800](https://github.com/openai/codex/issues/37800) (2026-08-10), [#47802](https://github.com/openai/codex/issues/47802) (2026-09-24), [#43021](https://github.com/openai/codex/issues/43021) (2026-09-05).
- Added pure in-memory no-progress observer and regression definitions. Static source inspection only; **no tests, compilation, scripts, CI or cross-platform runtime checks executed**. No assertion of behavioral correctness.
- Trusted progress classification remains the caller's responsibility. No Agent-loop wiring, cancellation, automatic retry, persistent state, account actions, main merge or production release.

## 2026-11-22 — Task contract wire envelope (static inspection only)

- Inspected development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, task-contract and acceptance modules; reviewed recent commits, open Issues/PR and available commit checks. External facts: [Codex #40646](https://github.com/openai/codex/issues/40646) (2026-08-25) and [#57608](https://github.com/openai/codex/issues/57608) (2026-10-28), reviewed 2026-11-22; these do not establish an Angel defect.
- Added bounded versioned metadata envelope and unexecuted regression definitions. Source review only; **no tests, compilation, scripts, CI or platform verification run**. Strict decoder rejects duplicate keys and unexpected authority fields. Runtime behavior remains unverified.
- No file persistence, encryption, prompts, credentials, tool results, runtime wiring, auto-replay, main merge or release. Exported metadata must still be treated as potentially sensitive.

## 2026-11-22 — Task contract metadata boundary (static inspection only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools and acceptance modules, existing development branch, open Issues/PR and previous commit status (no checks returned). Recent public feedback: [Codex #40646](https://github.com/openai/codex/issues/40646) (2026-08-25), [#36718](https://github.com/openai/codex/issues/36718) (2026-08-03); reviewed 2026-11-22. Reports are not Angel reproductions.
- Added strict in-memory task-contract validator and regression source. **Static source review only; no tests, scripts, compilation or CI run.** Cross-platform behavior unverified.
- No persistence, runtime enforcement, authorization, independent verification or safe automatic resume. No main merge or release.

## 2026-11-22 — Issuer-bound receipt verification (static inspection only)

- Reviewed development branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Agent/Tools, existing acceptance modules/tests, recent commits, Issues/PR and available CI status. External reports: [Codex #61857](https://github.com/openai/codex/issues/61857) (2026-11-16) and [#40646](https://github.com/openai/codex/issues/40646) (2026-08-25); reviewed 2026-11-22. Reports are not Angel reproductions.
- Added offline v2 issuer/key-id-bound HMAC verifier and regression source; reviewed source text only. **Tests, compilation, scripts and CI were not run.** No cross-platform runtime validation.
- The caller must independently protect and provision trusted keys. Removing an entry only blocks subsequent offline checks using that registry; it does not invalidate previously acted-on claims, prevent replay or prove real CI/target execution. No runtime wiring, main merge or release.

## 2026-11-22 — Receipt reference pinning (static review only)

- Reviewed development-branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, acceptance source/tests, Agent/Tools; checked recent commits, open Issues/PR and previous commit status/workflow records (none returned). No inference of CI success.
- Inspected optional `expected_reference` match in offline HMAC verifier and three new regression test definitions. **Not executed:** tests, compilation, scripts, CI or platform verification.
- A valid MAC authenticates a secret holder's assertion, not the CI artifact or target behavior. No key management, replay protection, runtime integration, main merge or release.
- External reports (facts, not Angel reproductions): [Codex #61857](https://github.com/openai/codex/issues/61857) (2026-11-16), [Codex #59492](https://github.com/openai/codex/issues/59492) (2026-11-04); reviewed 2026-11-22. Engineering inference and priority recorded in ROADMAP.

## 2026-11-22 — Offline acceptance receipt verifier (static inspection only)

- Inspected README.md, DESIGN.md, CHANGELOG.md, VERIFICATION.md, ROADMAP.md, acceptance assessor, Agent and Tools source; reviewed recent commits, open Issues/PR and prior commit checks. The queried prior commit had no status checks or workflow runs; this is not CI success.
- Added `angel/acceptance_receipt.py` and `tests/test_acceptance_receipt.py`. Static source review only; tests and CI **not run**. Test source covers exact match, wrong environment/requirement, tampering, wrong/weak key and malformed fields.
- Security boundaries: secret must be provisioned outside model/agent control; no issuance, key storage, revocation, replay defense, external verification or main-loop integration. Valid HMAC does not prove execution. No software installed, accounts accessed, main merge or release.

## 2026-11-22 — Conflicting acceptance receipt contexts (static-only)

- Reviewed README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, acceptance source/tests, Agent/Tools, latest repository commits, open Issues/PR and commit status. External evidence: [Codex #61857](https://github.com/openai/codex/issues/61857) (opened 2026-11-16) and [Codex #42080](https://github.com/openai/codex/issues/42080), reviewed 2026-11-22. Reports are not Angel reproductions.
- Static inspection: a receipt with multiple distinct (revision, environment) pairs is now marked `reference_context_conflict` and cannot count toward reported completion; an independent nonconflicting receipt may still count. Added two regression test cases in `tests/test_acceptance_evidence.py` but **did not run them**.
- No tests, builds, scripts, CI, install, main merge or deployment were performed. The read-only module is not wired into the Agent loop; self-reported references remain untrusted. Runtime correctness and CI status are not established by static review.

## 2026-11-21 — Shared target receipt ambiguity (static-only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, acceptance source/tests and Agent/Tools, repository branch and open Issues/PR. Public report: [Codex #61857](https://github.com/openai/codex/issues/61857) (2026-11-16), reviewed 2026-11-21; implementation rationale is an inference, not an Angel reproduction.
- Source-only inspection: a reused target reference across requirements is marked ambiguous and cannot satisfy either requirement; distinct eligible evidence remains usable. Added regression cases but **did not execute** them. Self-reported evidence remains untrusted.
- **Not run:** tests, compilation, scripts, CI, platform checks or deployment. No main merge or production release.

## 2026-11-21 — Requirement-scoped acceptance references (static-only)

- Reviewed development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, acceptance source/tests, Agent/Tools, recent commits, open Issues/PR and commit status. External source: [Codex #61857](https://github.com/openai/codex/issues/61857) (2026-11-16), retrieved 2026-11-21; inference separated from report.
- Static-only: optional bounded `reference_scopes` binds a self-reported receipt to a single requirement; unknown scope or reference fails closed; legacy callers unaffected. Regression tests added but **not run**. The mapping is not a trusted provenance adapter.
- **Not run:** tests, compilation, scripts, CI, platform checks, deployment. No main merge or production release.

## 2026-11-21 — Acceptance reference allowlist (static-only)

- Read development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, acceptance module/tests and Agent/Tools; reviewed recent commits, open Issues/PR and prior CI status. External reports: [Codex #61857](https://github.com/openai/codex/issues/61857), [#62682](https://github.com/openai/codex/issues/62682), retrieved 2026-11-21.
- Source inspection only: optional exact allowlist, bounded validation, unrecognized target references remain incomplete, recognized entries remain self-reported. Added unexecuted regression cases. No independent source authentication.
- **Not run:** tests, compilation, scripts, CI, platform probes or deployment. No main merge or production release.

## 2026-11-21 — Acceptance target-context match (static-only)

- Read README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Python acceptance module/tests, Agent/Tools and Node claim; checked recent commits, open Issues/PR (none returned), prior development commit combined status and PR-triggered workflow runs (empty, **not** CI success).
- Static inspection: optional expected revision/environment pair validates exact target context; mismatched self-reported target evidence stays incomplete. Added unexecuted regression cases for mismatch, match, malformed expected context. Legacy no-expected-context behavior retained. No source dereferencing or attestation trust.
- External report: [Codex #61857](https://github.com/openai/codex/issues/61857) (2026-11-16); inference is to avoid accepting evidence for the wrong revision/environment. **Not run:** tests, compilation, scripts, CI, platform checks. No runtime integration or deployment.

## 2026-11-21 — Acceptance provenance context (static-only)

- Read development README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, acceptance module, Agent/Tools/ToolJournal and experimental Node claim; checked recent main commits, open Issues/PR (none returned), previous development commit statuses and PR-triggered workflows (empty, **not** a pass).
- Added bounded revision/environment context requirements only for self-reported `target_verified` entries. Summary preserves those strings for human review, without dereferencing URLs, verifying commits, or treating descriptions as proof. Added unexecuted unittest cases for missing context, reported-only completion and lower-level compatibility.
- External fact: [Codex #61857](https://github.com/openai/codex/issues/61857), opened 2026-11-16, describes unsupported completion claims; engineering inference is to require explicit tested revision and environment. Not an Angel reproduction.
- **Not run:** tests, compilation, scripts, CI, platform probes or deployment. No main merge, runtime wiring, permission change or third-party dependency.

## 2026-11-21 — Acceptance evidence assessment (static-only)

- Inspected development branch README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP, Python Agent/Tools/ToolJournal, experimental Node claim, recent commits, open Issues/PR (none returned), and GitHub commit statuses/PR-triggered workflow runs (empty, not a pass).
- Added `angel/acceptance_evidence.py`: pure standard-library classifier, bounded requirements and evidence entries, rejects unknown levels, duplicate/unknown requirements and missing references. It never dereferences references, writes files, executes tools, or grants replay. Reported completion is not independent verification.
- Source: [Codex #61872](https://github.com/openai/codex/issues/61872), report covering 2026-11-15–16, describes a long task with passing scoped checks and unfinished delivery; external user report, not Angel reproduction.
- **Not executed:** tests, compilation, scripts, CI, platform probes, or runtime integration. Static reasoning only; the new module is not wired into the Agent loop.

## 2026-11-21 — Static-only security gate; no code change

- Inspected development-branch README.md, DESIGN.md, CHANGELOG.md, VERIFICATION.md, ROADMAP.md and `scripts/node_tool_claim.ts`; checked open Issues/PR (none returned), prior commit `221674e60184416eae356b4c09ff4d272dac1c3e`, and its combined statuses/PR workflow runs (both empty, not a CI pass).
- No safe claim-runtime increment was established: Linux privileged mount races and Windows native reparse protection need an explicit platform threat model; claim remains unintegrated, so adding another preflight cannot establish exactly-once execution.
- External research: [Codex #61872](https://github.com/openai/codex/issues/61872), report covering 2026-11-15 to 2026-11-16, describes failure to converge on actual UI delivery despite extensive intermediate checks. External anecdote, not Angel reproduction.
- **Not executed:** tests, compilation, scripts, fault injection, CI, deployments. No runtime behavior verified.

## 2026-11-21 — Experimental claim descriptor inheritance (static review only)

- Inspected README, DESIGN, CHANGELOG, VERIFICATION, ROADMAP and `scripts/node_tool_claim.ts`; checked recent repository commits and open Issues/PR. `js2005happy/angel` resolves to `js2005happy/nyra`. Latest retrieved commit `6eb75dc` (2026-11-21 07:45 UTC) concerns team-charter documentation, not this change.
- Source-only inspection confirms `O_CLOEXEC` was added to the Linux directory open and exclusive claim file open. It requests close-on-exec, not a demonstrated fix for an observed descriptor leak; Node may already enforce it.
- **Not run:** tests, TypeScript compilation, CI, fault injection, or cross-platform validation. Windows remains disabled; procfs mount races, storage durability, real tool dispatch, and exactly-once remain unresolved.


## 2026-11-21 — Linux claim final procfs descriptor revalidation

Static-only review: added a post-directory-fsync `statfsSync("/proc/self/fd")` procfs magic check and `statSync("/proc/self/fd/<directoryFd>")` identity comparison (type/dev/ino/uid) before the final claim filename check. Existing catch converts failures to ClaimUnavailable and closes the directory fd; no automatic claim removal/replay. Not executed: tests, compilation, CI, fault injection. Residual risk: privileged mount changes after verification, non-atomic filesystem durability, Windows disabled, no real Node dispatch integration.
## 2026-11-21 — procfs fd 身份校验（仅静态）

- 已核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python Agent/Tools，近期提交与开放 Issues/PR。近期仓库提交 [410cf32](https://github.com/js2005happy/nyra/commit/410cf32c4f869e0c8b074cfcf0b225b0e49af387) 为 peer-card 文档，与本次独立增量不重复。
- 静态核对新增 `statSync('/proc/self/fd/<directoryFd>')` 对目录类型、dev、ino、uid 的比较，失败关闭，不自动重放。
- **未执行**测试、编译、脚本、故障注入或 CI；尚未验证 procfs 挂载竞态、Windows 或真实 Node 派发；不保证 exactly-once。

## 2026-11-21 — Linux claim 非规范路径拒绝（仅静态）

- 核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim；main TypeScript Agent/Tools、近期提交、开放 Issues/PR 和提交状态。main 最新检索提交 [e3f8c78](https://github.com/js2005happy/nyra/commit/e3f8c7801dbf1a1bf040198de173fb8d10f30158)（2026-11-21 04:35 UTC），涉及 Slack 审批按钮，与本增量不重复；开放 Issues/PR 查询为空，combined status 空不等于 CI 通过。
- 静态确认新增 `directory !== resolve(directory)` 拒绝词法非规范绝对路径，避免检查已归一化祖先而打开未经归一化路径的差异。未执行测试、编译、脚本、CI、故障注入；未验证各平台运行时行为。
- claim 仍未接入真实 Node 工具派发；Linux procfs 挂载竞态、Windows reparse 保护及跨进程 exactly-once 仍未解决。


## 2026-11-21 — P0 Linux claim 目录句柄最终关闭失败的错误归一化（仅静态审查）

- 静态审阅 `scripts/node_tool_claim.ts` 的最终 `finally`：`closeSync(directoryFd)` 原生异常此前可能绕过 claim 的统一失败边界；现在捕获并抛 `ClaimUnavailable`。不会删除或重试 claim，仍保留 unknown。
- 已核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim；近期 main 提交、开放 Issues/PR 和 GitHub Actions。main 的 Node CI 2026-11-21 03:26 UTC 一次成功仅对应 main 提交 `8e75586`，**不是本分支验证**。
- 未运行编译、测试、脚本、CI 或故障注入；Windows 仍拒绝 claim，procfs 挂载竞态和实际派发仍未解决。
## 2026-11-21 — Node claim 异常路径句柄清理（仅静态）

- 阅读 `scripts/node_tool_claim.ts` 发现原 catch/finally 对同一 `directoryFd` 可能重复调用 `closeSync`。
- 静态修改：失败状态单独记录，finally 始终尝试关闭 claim fd，失败时只尝试关闭目录 fd 一次；成功时目录 fd 保留到后续同步。未删除 claim、未自动重试。
- **未运行** TypeScript 编译、单元测试、故障注入或 CI；未证明文件系统持久化、procfs 挂载可信或跨进程 exactly-once。
- 外部背景：2026-11-20 [Codex #62853](https://github.com/openai/codex/issues/62853) 和 2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 均为外部用户报告，不能视为 Angel 复现。


- 核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python Agent 和 main TypeScript Agent；查询开放 Issues/PR、近期提交及前次提交状态。main 近期 [ac72f5f](https://github.com/js2005happy/nyra/commit/ac72f5fb2438705055abce1d5be0cedd0e672169) 为任务板文档，非重复实现；开放 Issues/PR 为空，前次提交 status 与 PR workflow runs 均为空，不能视为通过。
- 静态确认原 `closeSync(fd)` 若在 finally 抛错会跳过目录 fd 同步/关闭；现在 catch 尝试关闭 directoryFd 并抛统一 ClaimUnavailable，保留 unknown。正常关闭路径保持不变。
- **未运行**测试、编译、脚本、CI、故障注入或跨平台实测；无法证明 close 错误的运行时行为。Linux procfs 可信边界、Windows 支持及真实派发仍未完成。

## 2026-11-21 — Node claim 文件关闭异常资源清理（仅静态）

- 核对开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Node claim、Python Agent/Tools，main 的 TypeScript Agent/Tools、package.json、近期提交与开放 Issues/PR。main 最近检索提交 8f16280（2026-11-21 00:38 UTC）；该提交的状态检查和 PR 触发 workflow runs 均为空，不能视为 CI 通过。
- 静态检查 `claimOperation` 在任何 `isAbsolute`、`resolve` 或文件系统调用前拒绝非字符串、空字符串及含 NUL 的目录参数；保留现有 operationId 校验和安全目录检查。未进行动态异常注入。
- **未运行测试、编译、脚本或 CI**；不代表跨平台通过。实验性 claim 仍未接入真实工具派发，unknown 不可自动重试。

## 2026-11-21 — Linux procfs 类型门禁（仅静态）

- 检查开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Node claim、Python Agent/Tools，以及 main TypeScript Agent/Tools、package.json、近期提交、开放 Issues/PR；最新检索 main 提交 9230072（2026-11-20 23:32 UTC），提交状态检查为空，不能视为 CI 通过。
- 静态核对：claim 创建前检查 `statfsSync("/proc/self/fd").type === 0x9fa0`，不匹配或异常即 `ClaimUnavailable`，不创建 claim；仅使用 Node 标准库。
- **未运行测试、编译、脚本或 CI**；尚未实机验证 mount namespace、procfs 竞态或文件系统语义。该组件未接入真实 Node 工具派发，不提供 exactly-once。

## 2026-11-21 — Linux claim 同 fd 名称复核（仅静态审阅）

- 核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim；对照 main 的 src/agent.ts 与 src/tools.ts、近期提交和开放 Issues/PR。前一提交 combined status 与 PR-triggered workflow 查询均为空，不能视为 CI 通过。
- 静态核对：claim 写后与目录 fsync 后两处名称检查现在均通过已打开目录描述符对应的 `/proc/self/fd` 路径进行；目录 fd 保持打开直至最后检查。未执行任何代码、测试、编译、CI 或故障注入。
- 未验证 procfs 可信挂载、容器环境、异常清理及文件系统持久性；组件未接入真实 Node 工具派发，不保证 exactly-once。

## 2026-11-21 — Linux claim 同一目录 fd 同步（仅静态审阅）

- 读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python Agent/Tools；核对 main 最新提交、开放 Issues/PR。原代码创建 claim 后关闭 directoryFd，随后按路径重新打开目录 fsync；现改为保留原目录 fd 直到目录同步和最终名称核对结束，失败关闭。
- **仅静态检查**：未运行 TypeScript、编译、测试、脚本、CI 或跨平台实机验证；GitHub status 为空不代表通过。仍有 procfs 挂载信任、文件系统持久化、名称检查竞态；没有真实工具派发集成或 exactly-once 保证。

## 2026-11-21 — Node claim Linux fd-relative create 静态核查

- **检查范围**：开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Python Agent/Tools、Node claim、main Node Agent/Tools、近期提交、开放 Issues/PR、提交状态。
- **静态结论**：Linux claim 创建时保持已检查的目录 fd 打开，借助 `/proc/self/fd/<fd>/<filename>` 使用 O_EXCL|O_NOFOLLOW 创建；不再在关闭目录 fd 后用原路径创建。非 Linux 平台失败关闭。
- **未验证**：未运行任何测试、编译、脚本或 CI；未确认 procfs 挂载真实性及不同文件系统的持久化语义；不保证祖先竞态全部消除、审计防篡改或远端副作用恰好一次。提交状态列表为空不代表通过。

## 2026-11-21 — Node claim 运行时 ID 类型校验（仅静态）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python ToolJournal，并对照 main 的 Node Agent 与 Tools。main 近期检索提交 [297039e](https://github.com/js2005happy/nyra/commit/297039e5ae63d6f6d789ce3550cacb60e724dff9)（2026-11-20 19:34 UTC）为 media setup CI mock 修复，不重复本增量；开放 Issues/PR 搜索为空。
- 静态核对 `claimOperation` 在 `RegExp.test` 前使用 `typeof operationId !== "string"` 拒绝非字符串；此检查避免 JS 的隐式转换别名。原先类型声明不能保证 JS 调用者输入。
- 前次提交 `b088ddb21f798607825a24c3adffc9f792ca5873` 的 combined statuses 和 PR 触发 workflow runs 均为空；不能据此判断 CI 通过或失败。
- **未运行测试、编译、脚本、CI 或跨平台实机验证**。尚有路径 TOCTOU、原生 openat、Windows reparse、真实派发集成等未解决问题。

## 2026-11-21 — Node claim 目录同步后名称复核

静态检查：在 `scripts/node_tool_claim.ts` 中缓存已核验文件身份，目录 `fsync` 后重新 `lstat` 对照 dev/ino、类型、链接数、UID、私有权限和长度；任何异常失败关闭且不自动清理 claim。**未运行** TypeScript 编译、测试、脚本或 CI；没有运行时证明。该复核不能消除最后一次检查后的路径替换，也不提供 openat 或 exactly-once。Windows 仍拒绝 claim，组件未接入主执行器。

## 2026-11-21 — Node claim 文件身份复核（仅静态）

- 读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python ToolJournal；对照 main Node Agent/Tools，查询 main 近期提交、开放 Issues/PR、前次提交 combined status 与关联 PR workflow（均无检查返回，不能推断通过）。
- 静态核对 claim 文件 fsync 后新增 fstat/lstat 的 dev/ino、普通文件、单硬链接、UID、私有权限及字节长度一致性门禁；异常保留 unknown，不删除文件。
- **未运行脚本、编译、测试或 CI**；未进行 Linux/macOS/Windows 实测。仍未实现 openat 相对创建、Windows reparse 防护、祖先路径原子绑定或真实工具派发集成，不保证 exactly-once。

## 2026-11-21 — Node claim 祖先目录权限检查（仅静态）

- 核对 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python ToolJournal；开发分支无 main 的 `src/agent.ts` 和 `src/tools.ts`。检查近期 main 提交、开放 Issues/PR、前一提交状态与关联 PR 工作流（均无返回检查）。
- 静态审阅：目录遍历中新增 POSIX 祖先 UID 和 group/other 写权限拒绝；叶目录仍要求私有。没有创建目录或执行 claim。
- **未运行脚本、编译、测试或 CI**；尚未进行 Linux/macOS/Windows 实测。路径创建不是 openat，祖先替换仍有 TOCTOU；不能宣称工具 exactly-once 或生产安全。

## 2026-11-20 — Node claim 创建前后目录身份检查（仅静态）

- 读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim，核对 main 最新提交、开放 Issues/PR；开发分支缺少 main 的 `src/agent.ts`、`src/tools.ts`，运行时仍未接入。
- 静态检查新增创建前目录 fd 身份核验，以及创建后 dev/ino 与创建前核验值一致性检查；任何失败保留可能存在的 claim，拒绝报告成功。
- **未运行编译、测试、脚本或 CI**。此实现并非 openat：路径仍可能在检查与 `openSync(path)` 之间被替换，不能证明防重复执行或 POSIX/Windows 全平台安全。此前提交 status 返回空列表，不等于 CI 通过。

## 2026-11-20 — Node claim 目录同步身份复核（仅静态）

- 核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Node claim、Python ToolJournal，以及 main Node Agent、Tools、package.json；查询近期提交与开放 Issues/PR。
- 静态审阅：目录 fd 使用 O_DIRECTORY|O_NOFOLLOW；fsync 前比较 fstat 与 lstat 的设备/inode、目录类型、UID、权限，fsync 后再次比较路径身份；失败不删除已有 claim，不允许自动重试。该改动只缩小部分路径替换窗口。
- **未执行脚本、编译、测试或 CI**；未验证 Linux/macOS/Windows 行为。仍存在 TOCTOU、祖先替换与文件系统持久化限制；claim 尚未接入真实工具派发，不能宣称 exactly-once。

## 2026-11-20 — Windows claim 失败关闭门禁源码修复

- 静态发现 `scripts/node_tool_claim.ts` 中注释包含字面量 `\\n`，将 Windows 拒绝分支和 `isAbsolute` 校验吞入单行注释；修复为真实源码换行，使两个检查成为独立语句。
- **未运行编译、脚本、测试或 CI**；仍未验证 Windows/POSIX 文件系统语义、目录 TOCTOU、跨进程持久化或实际工具派发。此修复不代表 exactly-once。

## 2026-11-20 — Windows Node claim 失败关闭（静态审阅）

- 读取开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Node claim、Python ToolJournal，并对照主分支 `src/agent.ts`、`src/tools.ts`；检查近期提交及开放 Issues/PR。此前提交 `ada0536` 的 GitHub status 列表为空，不能视为 CI 通过。
- 静态确认 `checkPrivateDirectory()` 在 Windows 进入路径预检前抛出 `ClaimUnavailable`，阻止 Windows reparse/junction 未验证情况下的 claim 创建；POSIX 逻辑未修改。
- **未运行脚本、编译、测试、CI 或 Windows 实机验证**。仍未建立 POSIX 稳定目录句柄，未解决祖先 TOCTOU/网络文件系统风险，尚未接入真实 Node 工具派发；不提供 exactly-once 保证。

## 2026-11-20 — Node claim 目录预检（静态审阅）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal 和 Node claim；核对主仓库近期提交及开放 Issues/PR。
- `checkPrivateDirectory` 静态审阅：拒绝相对路径；从叶目录逐层 lstat 至根，拒绝符号链接/非目录；POSIX 叶目录要求当前 UID 所有、权限位不允许 group/other。未执行该函数。
- **未运行测试、编译、脚本、CI**；未进行 Windows/Linux 实测。Windows junction/reparse point、祖先目录并发替换、目录 fsync 和外部文件系统仍可能不安全；claim 仍未接入真实工具执行器，不能视为防重放保证。

## 2026-11-20 — Node operation claim 原语（仅静态审阅）

- 读取开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Python Agent/ToolJournal/审计脚本，以及 main 的 package.json、src/agent.ts、src/tools.ts；检查最近提交、开放 Issues/PR、上一提交状态（statuses 为空，不等于 CI 通过）。
- 新增 `scripts/node_tool_claim.ts`：只依赖 Node 内置模块，O_EXCL 排他文件、写入 fsync、目录 fsync；失败不删除 claim，结果始终 unknown，禁止自动重放。**尚未接入真实工具执行入口**。
- **未运行 TypeScript 编译、测试、脚本、CI 或跨平台实测**。目录与文件名之间存在 TOCTOU，可信目录/祖先路径未绑定，目录 fsync 的 Windows 兼容性未验证，无法宣称跨进程 exactly-once 或生产安全。

## 2026-11-20 — 静态审计 v6（未运行）

- 静态审阅：同一路径只调用一次 _source；文件状态、文本匹配行号和 source_sha256 来自同一份有界内存快照；JSON 协议 v6。
- 未执行脚本、单元测试或 CI；未做 Windows/POSIX 实测。路径检查与打开之间仍有 TOCTOU，根目录身份未绑定；指纹不证明 Git 提交或运行时调用图，也不是副作用回执。

## 2026-11-20 — 静态审计必需文件完整性 v5（未执行）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Python Agent/ToolJournal、审计脚本；查询 main 近期提交及开放 Issues/PR。
- 源码静态审阅：v5 增加 `missing_required_files`，开发分支 Python 入口/Agent/Journal 与主分支 Node manifest/CLI/Agent/Tools/Gateway/Memory 必须可读；`audit_incomplete` 与退出码 2 使用相同判定，避免状态自相矛盾。
- **未执行脚本、解释器、测试、类型检查或 CI**；无跨平台实机验证。源码锚点仍不能证明动态派发、跨进程锁、外部副作用或安全续跑。

## 2026-11-20 — 静态审计锚点失效保护 v4（未执行）

- 读取开发分支五份文档、Python Agent/ToolJournal 与审计脚本，读取主分支五份文档及 `src/agent.ts`、`src/tools.ts`、`src/gateway.ts`、`src/memory.ts`，查询近期提交、开放 Issues/PR 和上一提交 CI 状态。
- 代码审阅：`scripts/audit_runtime_boundary.py` 增加主分支 Node 锚点完整性检查。缺失或无法读取的锚点会出现在 `missing_node_anchors`，标记 `audit_incomplete` 并返回 2；协议 v4。
- **未执行脚本、测试、类型检查或 CI**；前一提交 `40fa92d` combined status 和关联 PR workflow 均为空，不等于通过。静态字符串命中不证明真实运行时派发覆盖、跨进程锁或工具副作用。

## 2026-11-20 — Node 派发/结果持久化静态锚点 v3（未执行）

- 静态读取开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Python Agent/ToolJournal、审计脚本，主分支 package.json、src/cli.ts、src/agent.ts、src/tools.ts、src/gateway.ts；查询最新提交、开放 Issues/PR。
- 审计脚本新增 gateway/memory 文件状态与 agent 工具结果追加、saveSession、gateway 交互及调度 run 调用的文本行号锚点，schema_version=3。仅源码审阅；未执行脚本、测试、类型检查或 CI。
- 静态文本命中不构成完整控制流、事务边界、跨进程互斥或外部副作用证明。未安装、未合并 main、未发布。

## 2026-11-20 — 静态审计 v2（源码审阅，未执行）

- 已核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Python Agent/ToolJournal 与原审计脚本；主分支 package.json、src/cli.ts、src/agent.ts、src/tools.ts；查询最近提交、开放 Issue/PR 和上一提交状态。
- 本轮只修改审计脚本：行号证据、有限大小读取、明确不可读/链接/超限状态、JSON schema v2、失败关闭退出码。没有执行脚本、测试、类型检查或 CI；静态审阅不能证明运行时安全。
- 上一提交 `da7a7ff` 的 combined status 和 PR workflow runs 均返回空列表，不能推断 CI 通过。开发分支仍无 Node 主运行时源码，原子所有权未实现。

## 2026-11-20 — 跨运行时静态审计脚本（未执行）

- 静态核对开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、Python ToolJournal，主分支 README 与 `src/agent.ts`、`src/tools.ts`；查询开放 Issues/PR、近期提交和开发分支 CI 状态。
- 新增 `scripts/audit_runtime_boundary.py`：只读两个显式指定的工作树，不 import/execute 目标项目；以 JSON 记录文件存在性与字符串引用，无法验证动态调用、锁生命周期或结果落盘。该脚本本身也**未运行**，输出未经过实机验证。
- 当前开发分支提交的状态检查和工作流查询为空，不等于通过。未运行测试、解析器、CI、安装、合并或发布。P0 Node 跨进程所有权仍未完成。

## 2026-11-20 — P0 Node 派发入口定位（仅静态）

- 读取开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、`angel/agent.py`、`angel/tool_journal.py`、回归测试源码；读取 main README、`package.json`、`src/agent.ts`、`src/tools.ts`；查询最新提交、开放 Issue/PR 和提交状态。
- 证据：main `package.json` 构建 `src/cli.ts`，`src/agent.ts` 引入 `executeTool` 与 `executeToolIdempotent`，定义在 `src/tools.ts`；Python `ToolJournal` 仅在独立开发分支。尚未检查 Node 全部入口及所有调用路径，不能证明不存在绕行路径。
- 本轮仅文档记录，未改运行时代码；未执行 Python/Bun/TypeScript、测试、安装、CI、合并或发布。GitHub 状态检查为空不等于通过。跨进程所有权与崩溃人工对账仍未验证。

## 2026-11-20 — 运行时分叉静态核验

- 已读取开发分支 README/DESIGN/CHANGELOG/VERIFICATION/ROADMAP、`angel/agent.py`、`angel/tool_journal.py`，对照主分支 README 与最新提交，查询 Issues/PR；开发分支 Python CLI 与主分支 Node CLI 明确不同。尚未定位 Node 具体派发源码，不能宣称 Python ToolJournal 保护 Node。
- 外部证据：Codex #62611（2026-11-19，事件驱动等待请求）、#58900（Windows 权限拒绝反馈）。均为外部报告，不构成 Angel 复现。
- 本轮只做静态文件与元数据读取，未运行解释器、测试、CI、安装或部署；未实现锁、自动恢复或副作用凭证。提交状态检查与工作流未在本轮验证，不得宣称通过。

## 2026-11-20 — P0 所有权实现阻塞：静态核验

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal 及相关测试；查询仓库近期提交、开放 Issue/PR 与开发分支上一提交状态。主分支近期主要是 TypeScript `src/` 运行时，开发分支 ToolJournal 是 Python `angel/`；尚不能确认该 Python 门禁覆盖主分支真实工具执行入口。
- `begin()/finish()` 多次读取日志并不构成原子所有权；跨进程锁必须覆盖工具派发到结果落盘、异常退出后保持 unknown 并阻止自动重放。未证明 POSIX/Windows 锁、Windows ACL 和句柄绑定的完整安全语义。
- 本轮未修改运行时代码；仅静态检查及文档更新。**未运行测试、解析器、CI、安装或实机验证**；GitHub 状态/PR 工作流为空不能解读为通过。

## 2026-11-20 静态核验：finish 写后竞争失败

### 2026-11-20 — ToolJournal post-commit counts（静态审查）

- 检查 `finish()` 写后快照：事件数应为写前 +1；成功数应增加 1（成功调用）或保持不变（失败调用）；错误数应恰好等于本次预期。
- 新增两项模拟写后事件数减少及本次错误计数消失的测试源码，**未执行**；未运行 Python、CI 或跨平台实机验证。
- 限制：计数不能检测等量替换、伪造记录或最终检查后的竞争；不能证明工具副作用 exactly-once。


- 静态审阅确认 `finish()` 写后原先只核对歧义和未知结果，未核对其他进程新增的已配对 `result_error`。现用 `expected_errors = 0 if success else 1` 检查写后汇总，检测到额外失败则拒绝报告干净完成；自己的失败结果仍能正常落盘。
- 增加两项模拟回归测试源码。**未运行测试、Python、CI 或跨平台实机验证**；检测后仍有竞态，不提供跨进程互斥、自动重放或外部副作用证明。

## 2026-11-20 — finish 并发报告失败保护（静态检查）

- 核对 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、`angel/tool_journal.py` 和测试源码；核对主分支最近提交、开放 Issue/PR 与提交状态。静态发现 `begin()` 已拒绝其他调用的 `result_error`，但 `finish()` 在未知结果数为 1 时仍可能忽略另一已完成调用的失败。现于初始状态及末次快照增加失败关闭门禁。
- 新增两项 mock 回归测试源码，覆盖初始状态和最终快照的并发失败；**未运行 Python、测试、CI 或安装软件**，未验证 Windows/Linux 行为。最后一次检查与结果写入仍有竞态；不保证外部副作用恰好一次。

## 2026-11-20 — ToolJournal 并发错误结果的派发复核（静态修复）

- 静态检查：复核 `begin()` 的初始、写后和最终快照门禁；新增模拟并发错误的两项回归测试源码。**未运行测试、未执行 CI、未安装依赖**；未验证跨平台行为。此改动不能消除最终快照与实际派发之间的 TOCTOU 窗口，不能保证 exactly-once。

## 2026-11-20 — 已报告工具错误阻断后续派发（仅静态审阅）

- 核对 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal 与测试，检查主分支近期提交、开放 Issues/PR 和 CI 查询。发现 `inspect()` 已要求对 `result_error` 人工核查，但 `begin()` 只拒绝歧义/未知结果，允许继续派发。
- 现在 `begin()` 额外拒绝 `reported_errors > 0`，并新增不写入新 intent 的回归测试源码。仅静态检查，未执行解析器、测试、CI、安装或实机验证。已有失败日志没有自动清除流程；须由人工对账，不得自动重试。

## 2026-11-20 — ToolJournal 报告错误的人工核查语义（静态审阅）

- 审阅 `inspect()`：原 `manual_review_required` 只取决于 pending/invalid，若工具返回 `result_error` 且事件完整配对，则错误地返回 false、`review_reason=none`；但失败的外部工具可能已产生部分副作用。
- 改为将 `reported_errors` 纳入人工核查信号，保留原有 `reported_errors` 计数及 `execution_verified=false`、`safe_to_auto_resume=false`；增加只读回归测试源码。仅静态检查，**未运行测试、解析器、CI 或实机验证**。
- 仍未实现跨进程原子执行所有权、可信外部副作用回执或自动恢复；报告错误与真实外部状态不得混同。

## 2026-11-20 — ToolJournal 人工对账原因分类（仅静态）

- 本轮复核 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal、相关测试、主分支近期提交、开放 Issues/PR 和提交状态。现有 `manual_review_required` 仅表示需核查，不说明是未知结果还是日志歧义；本轮只增加派生枚举字段和模拟回归测试，不改变工具执行或日志写入流程。
- 静态核对：`journal_ambiguous` 优先于 `unknown_outcomes`，干净元数据为 `none`；所有状态下 `execution_verified` 和 `safe_to_auto_resume` 仍为 false。**未执行 Python、测试、安装、CI 或 Windows 实机验证**；字段不是外部副作用证明，也不是跨进程锁。

## 2026-11-20 — ToolJournal 人工对账状态信号（仅静态）

- 读取 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal 与相关测试；核对近期主分支提交、开放 Issue/PR。新增 `manual_review_required` 仅由已有未知结果计数与歧义状态推导，不改变写入或执行路径。
- 静态核对空日志、未决 intent、配对结果的新增测试源码；**未运行** Python、测试、CI 或 Windows 实机验证。配对日志不能证明外部副作用，自动续跑仍禁止。

## 2026-11-19 — ToolJournal 源码换行错误（仅静态）

- 读取开发分支 `angel/tool_journal.py`，确认前次孤立 result 修复将三处源码换行意外写成字面量 `\n`，致使 `invalid = ...` 与 `pending = ...` 落入注释行；此处恢复真实换行。静态对照原片段和新片段；未运行解析器、测试、CI 或安装。此前孤立结果修复不能视为已验证。
- 已核对 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal、相关测试、主分支近期提交、开放 Issues/PR；跨进程原子所有权与外部副作用证明仍未实现。

## 2026-11-19 — ToolJournal 孤立结果全局歧义（仅静态审查）

- 审阅 `inspect()` 的 orphan_results 计算：旧逻辑 orphan_results > 0 但 invalid 仍为 False，导致其它已配对成功被计入 reported_ok。现设置 invalid = invalid or orphan_results > 0，并保守归零成功/错误汇总。
- 新增 test_orphan_result_suppresses_other_reported_successes；仅阅读和编写源码，未运行测试、安装、CI 或 Windows 实机验证。日志可能被同权限主体篡改，仍缺跨进程执行所有权与外部副作用对账。

## 2026-11-19 静态核验：ToolJournal 结果容量预留

- 静态检查 `begin()` 的事件上限与 `finish()` 的事件上限：旧逻辑在已有 `MAX_EVENTS-1` 个事件时仍允许新增 intent，导致后续结果无法记录。本轮在 begin 预留一个结果槽位，增加 mock 测试源码，未运行。
- 未运行测试、CI、安装软件或实机验证。并发进程仍可能抢占预留槽位；该改动不是原子保留、跨进程锁或工具副作用证明。

## 2026-11-19 静态核验：跨进程事务阻塞

已核对开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、ToolJournal 与测试源码，并检查仓库提交、开放 Issues/PR。当前 `begin()/finish()` 仍以多个非原子文件系统操作组成，无法保证跨进程执行所有权；本轮没有运行测试或 CI，也没有提交未经验证的锁实现。ROADMAP 已补充设计门槛、外部反馈出处及事实/推断区分。此记录不等于功能实现或验证通过。

## 2026-11-19 — ToolJournal finish 写后并发复核（仅静态）

- 静态检查确认原 `finish()` 最后一步直接 `_write(result)` 后返回，无法发现写入期间新出现的未决 intent。现在写入后重新读取完整日志，存在未知或歧义时抛出 `JournalError`。
- 增加 `test_finish_rechecks_post_commit_competing_intent` 模拟写入结果时竞争进程新增 intent；**未运行测试、未触发 CI、未进行跨平台实机验证**。
- 检测仍存在最后一次检查与返回之间的竞态，不保证原子提交、崩溃恢复或远端副作用恰好一次。

## 2026-11-19 ToolJournal finish 最终快照并发门禁（仅静态）

- 首次 `inspect()` 与最终 `_records()` 之间可插入竞争 intent；现在最终快照检查其他调用的 intent/result 配对及工具名一致性。
- 新增 `test_finish_rejects_competing_intent_in_final_snapshot` 模拟竞争；未运行测试、CI 或跨平台验证。最终检查与写 result 之间仍有 TOCTOU。

## 2026-11-19 ToolJournal 最终快照并发复核（仅静态）

- begin() 原先最后一次 _records() 仅过滤自己的 call_id，未检查其他新增 intent；现在在同一最终快照要求其他调用均为一条 intent 与一条同工具 result。
- 新增模拟竞争 intent 插入的回归测试源码；未运行测试、CI 或实机验证。最后读取与工具派发之间仍有 TOCTOU。

## 2026-11-19 ToolJournal 本次意图身份复核（仅静态审阅）

- 静态审阅 `begin()`：确认二次 `inspect()` 的全局 unknown=1 不足以证明本次 call_id 未完成；加入按 call_id 读取并核验仅有 intent 的守卫。
- 新增 `test_begin_requires_own_intent_still_pending`，模拟并发写入本次 result 与另一个 intent。**未运行测试、未运行 CI、未进行 Windows 实机验证**。
- 仍存在检查与工具派发间 TOCTOU，未提供跨进程锁、崩溃对账或真实外部副作用凭证。

## 2026-11-19 — begin 写后并发门禁（仅静态）

- 静态检查 `ToolJournal.begin()`：原实现首次 `inspect()` 与 `_write("intent")` 之间可能插入竞争意图；新增写后 `inspect()`，发现多个未决结果或歧义则在工具调度前拒绝返回调用 ID。
- 新增 `test_begin_rechecks_concurrent_intent_before_dispatch`，模拟另一进程在本次 intent 落盘后写入第二个 intent；**只编写源码，未执行测试或 CI**。
- 剩余限制：第二次检查和工具实际调用之间仍存在竞争；未实现跨进程锁、外部副作用对账、Windows ACL 或原子事务。

## 2026-11-19 — POSIX 末次目录句柄 fstat 异常（仅静态）

- 静态审阅 `ToolJournal._records()`：第二次枚举后最终 `os.fstat(directory_fd)` 原先可能传播未分类 `OSError`；现转为保留原异常链的 `JournalError`，拒绝信任日志快照。
- 新增 `test_posix_final_directory_fstat_denied_fails_closed`：模拟空目录读取时第三次目录 `fstat` 返回 `PermissionError`；测试源码未运行，尚不保证模拟在所有 POSIX 实现上行为一致。
- 未运行测试、CI、安装或 Windows 实机检查；Windows ACL、稳定目录句柄、跨进程事务、外部副作用证明均未完成。

## 2026-11-19 — POSIX 末次枚举异常分类（仅静态）

- 源码静态确认 POSIX 读取的第二次 `os.listdir(directory_fd)` 原先未分类 `OSError`；现在明确失败关闭为 `JournalError` 并保留异常链。新增 `test_posix_final_dirfd_enumeration_denied_fails_closed`，仅编写未执行。
- 未运行测试、CI 或 Windows 实机检查。模拟测试依赖 POSIX `dir_fd` 支持；Windows ACL、稳定目录句柄和跨进程事务仍未完成。

## 2026-11-19 — Windows 写入句柄 reparse 检查（仅静态）

- 静态核对：`_verify_written_windows_entry()` 原先只核验路径 `os.lstat()` 的 reparse 属性，现先调用 `_reject_windows_event_reparse(written)`，拒绝已打开写入句柄报告的重解析点；仅在 `os.name == "nt"` 生效。
- 已编写模拟回归测试 `test_windows_writer_rejects_opened_reparse_handle_before_path_check`，验证在检查路径前拒绝异常句柄；**未执行测试、未安装软件、未触发 CI**。
- 未验证 Windows 实机 `fstat` 属性可用性；仍缺少 Windows ACL、稳定目录句柄及跨进程事务，不构成防篡改或 exactly-once 保证。

## 2026-11-19 — Windows 已打开事件句柄元数据复核（仅静态）

- 核对 `_records()`：原先 Windows reparse 检查只针对目录项的 `lstat`，未针对 `os.fstat` 返回的已打开事件句柄。现补充句柄检查并增加模拟测试源码。静态检查确认新增调用位于打开文件后、读取前。
- 未运行测试、CI、安装或 Windows 实机验证。Windows 上 `fstat` 属性可用性及具体 reparse 行为仍需实机确认；不宣称解决 ACL、祖先路径 TOCTOU、事务或外部副作用核验。

## 2026-11-19 — 祖先目录链接探测异常保护（仅静态）

- 源码静态审阅发现 `_safe_directory()` 遍历祖先时直接调用 `Path.is_symlink()` / `is_junction()`，可能将权限拒绝作为未分类 `OSError` 传播。现捕获并失败关闭为 `JournalError`，保留异常链；新增模拟祖先探测拒绝的测试源码，未执行。
- 未运行测试、CI、安装、Windows 实机验证或发布。无法据此声称消除 TOCTOU、完成 ACL 检查或跨进程事务。

## 2026-11-19 — 回退路径符号链接探测拒绝（仅静态）

- 静态检查发现 `_records()` 在路径回退分支的 `Path.is_symlink()` 未统一捕获 `OSError`；现在失败关闭为 `JournalError` 并保留异常链。已编写模拟 `PermissionError` 的测试源码，未执行。
- 未运行测试、安装软件、触发 CI、合并或发布；Windows 实机 ACL 和竞态语义尚未验证。

## 2026-11-19 — 路径回退枚举失败诊断（仅静态）

- 静态核对 `_records()` 两次路径回退枚举原先未将 `OSError` 映射为 `JournalError`；现在均保守拒绝并保留异常链。增加首次/末次枚举 `PermissionError` 的模拟回归测试源码。
- 未运行测试、安装软件、触发 CI、合并或发布；Windows 实机与竞态安全性仍未验证。

## 2026-11-19 — ToolJournal 目录类型检查拒绝语义（仅静态）

- 静态核对 `_safe_directory()` 末次 `exists()/is_dir()` 在部分 Python/Windows 版本可能吞掉访问拒绝；改用 `lstat()` 并仅捕获 `FileNotFoundError`。新增模拟 `PermissionError` 的测试源码，未运行。
- 未执行测试、安装、CI 或 Windows 实机验证；不能据此证明原生 ACL、稳定句柄或竞态消除。

## 2026-11-19 — ToolJournal 读取入口拒绝语义（仅静态）

- 核对 _records() 原先使用 Path.exists() 作为空日志早退条件，与 _directory_identity() 已有的 lstat 错误区分不一致；现在先核验目录身份，仅 None 代表缺失。新增 mock JournalError 测试源码，未执行。
- 未运行测试、CI、安装或 Windows 实机验证；跨进程竞态、ACL 与稳定句柄仍待处理。

## 2026-11-19 — 日志目录权限错误与缺失区分（仅静态）

- 静态核对 `_directory_identity`：旧 `Path.exists()` 的平台/版本差异可能把访问错误当作不存在；现仅对 `FileNotFoundError` 返回 None，其余 `OSError` 触发 `JournalError`。新增 mock PermissionError 测试源码。
- 未运行测试、CI、安装或 Windows 实机验证；不宣称原生 ACL、目录句柄绑定或完整事务已完成。

## 2026-11-19 — POSIX 事件写入同步后的目录句柄复核（仅静态）

- 静态检查：原 POSIX 写入路径在 fsync(directory_fd) 后直接关闭句柄；本轮增加最终 fstat 类型、身份、权限校验，补充 mock 模拟测试源码。未运行测试、CI 或安装；真实平台表现未知。最后检查后仍存在 TOCTOU。

## 2026-11-19 — POSIX 末次枚举后的目录句柄复核（仅静态）

- 静态检查：读取路径已在二次枚举后复核路径身份，但未复核 POSIX 已打开目录 fd 的权限；本轮补充 fstat 身份、类型、权限检查，并增加模拟末次枚举后 chmod 的测试源码。
- 本轮未执行测试、CI、安装、合并或发布；测试通过与否未知。检查后仍有 TOCTOU，且 Windows ACL/稳定句柄、跨进程事务、主线包迁移未解决。

## 2026-11-19 — 路径回退末次目录身份复核（静态审查）

- 静态核对 `_records()`：原逻辑在第二次枚举前验证目录身份，但枚举结束后直接比较名称并返回。现新增末次 `_verify_directory`，并编写模拟第三次核验失败的回归测试源码。
- 未运行测试或 CI，未在 Windows 实机验证；检查后仍有 TOCTOU 窗口，不代表 Windows ACL、稳定目录句柄、跨进程锁或工具副作用真实性已实现。

## 2026-11-19 — ToolJournal 路径回退快照一致性（仅静态）

- 源码检查发现 POSIX dirfd 分支已二次枚举，但 Windows/path 回退仅核验目录身份，无法检测身份不变时新增事件名。现两条路径均比较读取前后的文件名集合；新增模拟 fallback 第二次枚举新增条目的测试源码。
- 未运行测试、CI、安装或发布；未验证 Windows 实机。最终检查后仍有竞态，Windows ACL/稳定目录句柄、跨进程事务及副作用核验未完成。

## 2026-11-19 — POSIX 事件目录快照一致性（静态检查）

- 已审阅 `_records()`：初次 `os.listdir(directory_fd)` 与最终 `fstat` 之间可能出现新增/删除事件，而目录 inode 保持不变。现在在返回前以同一目录 fd 再次枚举并比较文件名集合，不一致时拒绝结果。
- 新增模拟第二次枚举出现额外事件的回归测试源码；未运行测试、安装软件或触发 CI。仅能检测检查窗口内的变化，不提供锁、原子快照、Windows 稳定句柄或外部副作用证明。


## 2026-11-18 — 空 ToolJournal 的 POSIX 目录句柄最终检查

- 静态审查：此前 `_records()` 在零事件时跳过逐项目录句柄复核，仅检查路径身份。现在在返回前额外执行 `fstat(directory_fd)`，核对设备/inode、目录类型与私有权限。
- 新增模拟第二次目录 `fstat` 返回宽松权限的回归测试源码；**未执行测试、未安装依赖、未运行 CI**。
- 不能证明抵抗同用户恶意修改、祖先目录竞态或工具副作用的真实完成。

## 2026-11-18 ToolJournal 并发未决意图（静态检查）

- 审阅 `angel/tool_journal.py` 的 `begin/finish/inspect`：`begin()` 检查后到持久化 intent 之间仍有跨进程竞争窗口；`finish()` 原先仅拒绝全局歧义，可能在另一个 intent 未决时记录成功。
- 本次在 `finish()` 增加 `unknown_outcomes == 1` 的保守门槛；新增模拟第二个未决 intent 的测试源码。**没有运行任何测试或安装软件**，不宣称通过 CI。
- 局限：仍无跨进程原子事务；`inspect()` 与 `_write()` 之间仍可竞争；已发生的外部副作用无法由日志证明或撤销。

## 2026-11-18 Windows 事件写后元数据（仅静态审阅）

- 核对 `_verify_written_windows_entry`：Windows 事件目录项现在同时检查类型、设备/inode、硬链接数、大小、mtime_ns 和 ctime_ns；新增模拟原位修改及硬链接变化的测试源码，未执行。
- 未运行测试、CI 或 Windows 实机验证；无法证明抗同权限篡改或跨进程原子提交，ACL 和稳定句柄仍未实现。

## 2026-11-18 — ToolJournal 全局歧义统计（仅静态检查）

- 已审阅 `inspect()` 的全局歧义分支：歧义日志下成功/失败报告数均为 0，所有有 intent 的调用与孤立结果组计入 unknown；新增包含已完成调用和孤立结果的测试源码，未执行。
- 没有运行测试或安装软件；不宣称 CI 通过。跨进程原子事务、Windows ACL、稳定目录句柄及外部副作用验证仍未解决。

## 2026-11-18 POSIX 写后事件名绑定（仅静态）

- 源码审阅：写入后在同一已打开目录 fd 上以 follow_symlinks=False 核验文件名、inode、类型、链接数、大小、mtime/ctime 和权限，再同步目录。新增模拟 inode 被替换的回归测试源码，未运行。
- 不等同于完整事务、防篡改审计或 exactly-once 工具执行。未运行测试/CI、安装或发布；Windows ACL/稳定句柄和主线 nyra/ 迁移仍待处理。

## 2026-11-18 ToolJournal 读取后目录项元数据复核（仅静态）

- 静态审阅确认末次目录项检查从仅核对 inode 扩展至大小、链接数、mtime/ctime 和 POSIX 权限。回归测试源码模拟最终目录项大小改变，未执行。
- 未运行测试、CI 或 Windows 实机检查；同权限篡改、TOCTOU、Windows ACL 和稳定目录句柄仍未解决。

## 2026-11-18 Windows ToolJournal 写后目录项复核（仅静态）

- 源码审阅：Windows 回退写入路径在 `fsync` 与 `fstat` 后核对 `lstat` 目录项及 reparse 属性、文件身份、大小；失败关闭。新增两项模拟测试源码，**未执行测试或 CI**。Windows ACL、目录句柄和并发竞态仍未解决。
- 需求证据（外部反馈）：Codex #52173（2026-10-08）与 #55217（2026-10-19）报告 Windows reparse point 误报；仅表明跨平台路径判定的重要性，不证明 Nyra 同类缺陷。

## 2026-11-18 ToolJournal finish 全局歧义门禁（静态审阅）

- 静态检查：`finish()` 现在先调用 `inspect()`，若 `journal_ambiguous` 为真则拒绝写入结果。测试源码构造合法未结 intent 和无关孤立 result，断言拒绝且文件列表不变。
- 未执行测试、CI、安装或实机 Windows 验证。该门禁不具备跨进程原子性；Windows ACL/稳定句柄与真实副作用对账仍未完成。

## 2026-11-18 根锚点遍历静态纠错（未运行）

- 复核发现旧循环条件在进入循环前排除了 POSIX/Windows 文件系统锚点，前轮“已覆盖锚点”的结论不成立。本轮改为先检查当前节点、再在 current == current.parent 时退出，新增锚点直接作为输入的测试源码。
- 仅静态检查，未运行测试、CI、安装或发布。模拟测试尚未验证，不能宣称 Windows ACL、TOCTOU 或实机兼容已解决。

## 2026-11-18 ToolJournal 锚点检查（仅静态审阅）

- 静态确认 _safe_directory 的祖先循环现在检查锚点后再退出；模拟锚点符号链接的回归测试已编写，未执行。
- 未运行测试、CI、安装、合并或生产部署。仍需 Windows/POSIX 实机验证，且 ACL 与目录竞态尚未解决。

## 2026-11-18 — Windows 事件文件重解析点（仅静态审阅）

- 已静态检查事件读取前后的目录项均调用 Windows 重解析点拒绝逻辑；测试源码覆盖属性命中、属性缺失和 POSIX 不受影响的分支。
- 未运行测试、CI 或 Windows 实机验证。目录项检查并非原子句柄绑定；ACL 与路径竞态仍待处理。

## 2026-11-18 — Windows 悬空重解析点检查（仅静态审阅）

- 代码检查：Windows 路径祖先不再因 `exists()` 为 false 跳过 `lstat`；仅 `FileNotFoundError` 视为缺失，其他 OS 错误拒绝。
- 新增测试源码：模拟悬空重解析点及缺少 `Path.is_junction()` 的运行时；未运行任何测试、安装、CI 或实机 Windows 检查。
- 未覆盖：Windows ACL、祖先路径竞态、稳定句柄、外部副作用一致性。不能宣称安全边界已完全验证。

## 2026-11-18 Windows reparse point 静态核对

- 代码检查：Windows 上读取 lstat().st_file_attributes 并拒绝 FILE_ATTRIBUTE_REPARSE_POINT；测试源码模拟缺少 is_junction 的运行时。
- 未运行测试、CI、Windows 实机验证。路径检查存在竞态，ACL 与稳定句柄未实现。

## 2026-11-18 ToolJournal 未结调用门禁（仅静态审阅）

- 源码检查：`begin()` 在 `inspect()` 的未知结果计数非零时拒绝写入新 intent；`finish()` 仍可记录原调用结果。新增回归测试源码验证阻断及结果记录后的继续。
- 未运行测试、CI 或 Windows 实机验证；多进程并发下 inspect 与写入之间仍有竞争窗口，不能据此自动恢复或证明外部副作用。

## 2026-11-18 歧义日志阻止新增 intent（仅静态审阅）

- 静态核对 `begin()` 在生成调用 ID 和写入 intent 前读取 `inspect()`，`journal_ambiguous=true` 时抛出 `JournalError`；测试源码构造孤立结果并断言不会产生新 intent。
- 未运行测试、编译或 CI；`inspect()` 与写入间仍有竞争窗口，不能证明跨进程事务安全、日志防篡改或外部副作用真实性。

## 2026-11-18 ToolJournal 写入后文件元数据检查（仅静态审阅）

- 静态检查：两条写入路径在 fsync 后复核已打开文件的类型、硬链接数量和字节数；POSIX 还核验私有权限。新增模拟 fstat 大小变化的测试源码。
- 未运行测试、CI 或 Windows 实机验证。异常可能留下不可信事件文件，须人工核查；不代表日志不可篡改或工具副作用已核实。

## 2026-11-18 Windows 目录联接检查（仅静态审阅）

- 静态检查：`_safe_directory` 在支持 `Path.is_junction` 的 Python 版本上拒绝日志路径及祖先的 junction；测试源码模拟 `is_junction` 返回真。未执行测试、编译、CI 或 Windows 实机验证。
- 限制：Python 3.11 等缺少 API 的运行时不受此保护；Windows ACL、其他 reparse point、路径检查竞态和稳定句柄仍未解决。

## 2026-11-18 ToolJournal 跨工具结果歧义（仅静态检查）

- 静态审阅 `inspect()` 的同 ID 工具名一致性检查：不匹配的 result 现在归类 unknown，避免与 `journal_ambiguous` 同时报告成功。新增篡改 result 工具名的测试源码。
- 未运行测试、编译、CI 或跨平台验证；仍无法证明日志防篡改、外部副作用真实性或安全自动续跑。

## 2026-11-18 ToolJournal 孤立结果计数（仅静态审阅）

- 静态检查：`inspect()` 在按调用 ID 分组后统计缺少 intent 的结果组，加入 `unknown_outcomes`；回归测试模拟删除 intent 后仍有 result 的情况。
- 未运行测试、CI 或跨平台验证；计数只是保守元数据提示，不代表外部副作用可确认或可自动恢复。

## 2026-11-18 ToolJournal 短读取校验（仅静态审阅）

- 静态核对：在 JSON 解析前比较读取长度与已打开文件的 st_size；模拟尾部换行丢失但 JSON 仍合法的回归测试已编写。
- 未运行测试、CI 或跨平台验证；该检查不构成防篡改证明，也不改变未知结果禁止自动重放的原则。

## 2026-11-18 目录项二次核验（仅静态审阅）

- 代码新增读取后的目录项身份复核及模拟替换的回归测试源码。未运行测试或 CI；Windows ACL、祖先目录竞态、同 inode 篡改及工具外部副作用仍未验证。

## 2026-11-18 非阻塞事件打开（仅静态审阅）

- 静态确认 `_records` 的事件文件 `os.open` 追加可选 `O_NONBLOCK`，在 POSIX 上先取得非阻塞句柄再用既有 `fstat` 拒绝 FIFO 等非普通文件；新增标志回归测试源码。
- 未运行测试、编译或 CI；没有使用真实 FIFO 执行阻塞验证。Windows ACL、目录竞态和日志防篡改仍未解决。

## 2026-11-18 ToolJournal 写入侧 fdopen 异常清理（仅静态审阅）

- 静态核对 POSIX dir_fd 与 Windows 路径回退的文件描述符所有权；两条分支均补充 fdopen 异常时 os.close(fd)。
- 新增模拟 fdopen 失败的测试源码；本轮没有执行测试、安装、CI、合并或发布。未验证 Windows ACL、稳定句柄及外部副作用。

## 2026-11-18 ToolJournal fdopen 异常清理（仅静态审阅）

- 静态核对：`os.fdopen` 失败后通过 `os.close(fd)` 释放此前打开的事件文件句柄；新增模拟失败并检查 fd 已关闭的测试源码。
- **未运行测试、编译或 CI**；Windows ACL、稳定句柄、同用户篡改及外部副作用证据仍待处理。

## 2026-11-17 同大小原地修改检测（仅静态审阅）

- 静态确认读取前后 fstat 的 mtime_ns/ctime_ns 对比；回归测试源码通过 mock fstat 模拟第二次文件元数据变化，预期抛出 JournalError。
- 未运行测试、编译、CI 或 Windows/Linux 验证；不保证时间戳精度、防篡改或外部副作用真实性。

## 2026-11-17 事件读取后元数据复核（静态检查，未执行）

- 已静态核对：事件读取前后对同一 fd 的 fstat 检查身份、文件类型、大小、硬链接数量及 POSIX 私有权限；模拟 read 后 chmod 的回归测试已编写。
- **未执行测试、编译、CI 或平台验证**。仍存在同用户等长篡改、Windows ACL、目录祖先竞态及外部副作用真实性问题。

## 2026-11-17 ToolJournal 时间戳格式（仅静态审阅）

- 静态核对写入格式 `datetime.now(timezone.utc).isoformat(timespec="seconds")`，读侧新增 `datetime.fromisoformat` 与 UTC/秒精度/规范化格式检查。
- 新增非法日期、无时区、偏移时区、微秒和任意字符串的回归测试源码；未执行任何测试、编译或 CI。Windows ACL 与目录替换竞态仍未解决。

## 2026-11-17 ToolJournal 异常分类（仅静态审阅）

- 确认 `_records()` 中 `JournalError` 是 `ValueError` 子类，原异常处理会将重复 JSON 字段等明确安全错误重新包装为泛化损坏错误；现在先原样抛出 `JournalError`。
- 新增精确错误文本回归测试源码，**未执行**；未运行测试、编译或 CI，不宣称跨平台验证通过。


### 2026-11-17 ToolJournal 事件文件权限（仅静态检查）

- 核对读取事件文件的 `fstat` 后增加 POSIX `mode & 0o077` 拒绝；新增 0644 事件文件读取及再次 begin 拒绝的回归测试源码，且不改变文件权限。
- 未执行测试、编译、CI 或 Windows/Linux 运行验证。Windows ACL、文件替换竞态与同用户篡改仍未解决。
### 2026-11-17 POSIX 日志目录句柄权限竞态（未运行测试）

- 静态核对读/写路径：在已打开目录 fd 上用 fstat 复查组/其他用户权限，读侧逐事件后复查；新增 mock fstat 权限变宽回归测试。
- 未执行测试、编译、CI 或 Windows/Linux 平台验证；此检查不能防止所有 TOCTOU 或同用户篡改。

### 2026-11-17 既有 ToolJournal 目录权限检查（未运行测试）

- 静态检查：POSIX 上 `_directory_identity` 拒绝会话目录的组/其他用户权限位，不修改既有权限；新增测试源码检查读取、写入均拒绝。
- 未运行测试、编译、CI 或平台验证；Windows ACL、祖先目录竞态、外部副作用对账仍未解决。

### 2026-11-17 ToolJournal 私有会话目录（未执行测试）

静态审阅：`ToolJournal._write()` 创建会话目录时显式请求 `0o700`，新增 POSIX 权限回归测试。未运行测试/CI；未验证 Windows ACL，现有目录权限不自动修改。禁止将此视为日志防篡改或工具副作用验证。

## 2026-11-17 ToolJournal 回归测试静态阻塞修复

- 静态发现 `tests/test_tool_journal.py::test_hardlinked_event_is_rejected` 使用 `os.link` 而模块未导入 `os`；本轮补充导入。
- 未运行单元测试、静态分析命令或 CI；该修复仅解除可见的 NameError 风险，不证明硬链接保护通过。

## 2026-11-17 ToolJournal 文件身份核对（仅静态审阅）

- 打开事件文件后比较 fstat 与目录条目的 stat/lstat 身份，拒绝硬链接。
- 新增 test_hardlinked_event_is_rejected 与 test_replaced_event_entry_is_rejected 测试源码。
- 未运行测试、编译、安装或 CI。Windows 路径检查不是原子操作；外部工具执行状态不能据此自动恢复。

# Angel 验证报告（2026-11-16，v3 0.3.0）

## 待验证：ToolJournal JSON 歧义字段拒绝（2026-11-17）

- 静态审阅 object_pairs_hook 拒绝任意层级重复键，版本字段严格为 int 类型 1。
- 编写重复键与布尔版本回归测试，未执行测试/CI；Windows/Linux 尚待验证，不构成防篡改保证。

## 待验证：POSIX 事件读取目录句柄（2026-11-17）

- 静态审阅 `ToolJournal._records()`：POSIX 目录 fd 的 `fstat` 身份校验、`os.listdir(fd)`、相对 fd 打开事件文件、关闭句柄与读取中路径身份核验。
- 新增模拟目录句柄身份不匹配与事件文件相对打开的回归测试源码，**未执行**。Windows 仍为原路径回退；目录祖先竞态和攻击者直接篡改事件尚未消除。旧 CI 不作为本次验证依据。


## 待验证：POSIX 目录句柄写入（2026-11-17）
- 静态审阅 `ToolJournal._write`：在支持 dir_fd 的 POSIX 系统上核对目录句柄 `fstat`，相对该句柄 `O_EXCL` 创建事件文件并同步目录；Windows 保留旧路径方式。
- 新增 POSIX 路径创建与句柄不一致失败关闭测试源码。**未执行任何测试、安装、CI 或发布**；还需真实 Linux/macOS 与 Windows 验证，读取侧仍是路径模式。


## 待验证：ToolJournal 目录身份变化检测（2026-11-17）
- 仅静态审阅：新增 `tests/test_tool_journal.py` 两个模拟目录替换的测试；未执行 Python、单元测试或 CI。
- 预期：读取期间目录设备号/inode 改变则拒绝结果；写入后目录改变则抛 `JournalError`，不把事件当作可靠提交。
- 限制：stat 比对不能消除检查间竞态，也不能防拥有写权限的进程替换文件或伪造日志；需要后续按平台使用稳定目录句柄、审查跨进程文件一致性。


## 2026-11-17 日志文件名绑定（静态审阅）
- 核对 tool_journal.py 的 intent/result 固定文件名及 _records 文件名/JSON 一致性检查。
- 编写结果重命名、JSON call_id 错配、复制 intent 的测试；更新过时的随机文件名测试。
- 未运行测试、CI、安装、合并或发布。Windows/Linux、目录替换与跨进程端到端安全仍未验证。


## 2026-11-17 工具日志单结果槽（仅静态检查）

- 已审阅 `ToolJournal.finish()` 先读取调用意图、再 `_write()` 的竞争窗口：旧随机结果文件名可能允许两个并发 finish 都写入结果。新结果文件名固定为 `result-<call_id>.json`，`O_CREAT|O_EXCL` 在同一文件系统目录上使重复结果创建冲突而非静默覆盖。
- 新增测试：重复完成不能改变既有结果；模拟过期写入者直接 `_write()` 也会被拒绝。**测试未执行，Windows/Linux 运行验证未完成；既有 CI 不能证明本次提交。**
- 仍未消除目录祖先替换竞态、磁盘权限攻击、同一外部副作用重复执行、文件系统持久性差异。不得宣称已实现自动恢复或跨进程完整事务。


## 待验证：工具异常日志收尾（2026-11-17）

- 静态核对 `agent.py`：工具执行异常被分类为报告错误；显式日志写入 `result_error` 后抛出不包含原始异常详情的 `AgentError`，不继续执行后续工具，也不重试。
- 结果写入失败时仍为 unknown；新增测试覆盖异常内容不泄露、默认关闭、写入失败和只调用一次。没有执行测试或 CI；不能声明异常时副作用已撤销。
- 限制：成功/失败仍有返回字符串 `错误：` 前缀的旧兼容判断；日志尚无跨进程一致性保证，未达到安全自动恢复条件。

## 待验证：Agent 工具日志执行边界（2026-11-17）

- 静态审阅 `agent.py`：`tool_journal=None` 默认关闭；显式注入时 intent 写入在内置/MCP 工具审批和执行前，result 写入在返回事件和会话追加前。
- 写 intent 失败阻止工具执行；写 result 失败停止并报告可能执行、结果未知。新建 `tests/test_agent_journal_boundary.py`，**未运行**。
- 风险：工具抛异常留下 unknown；`错误：` 前缀分类不是结构化状态；日志没有跨进程互斥或防篡改能力。本轮没有运行测试/CI，也没有合并或发布。


## 待验证：工具执行意图/结果元数据日志（2026-11-17）

- 静态审阅新增 `angel/tool_journal.py` 和 `tests/test_tool_journal.py`：只存固定元数据；intent 无结果标记 unknown；即使 result_ok 也不代表副作用完成或已验证。
- 单条事件使用 O_EXCL 创建和 fsync，读取拒绝损坏文件、符号链接、异常字段和超限事件。文件名随机，聚合不依赖字典序。
- **未运行单元测试、CI、安装或发布。** 已提供显式注入主循环；并发写入与日志目录祖先替换仍有竞态，不能视为可信执行审计或安全自动恢复机制。


## 待验证：会话状态诊断安全加固（2026-11-17）

- 静态审阅 `angel/session_diagnostics.py`：新增整段工具调用 ID 去重、空会话/空白最终回复拒绝、工具链乱序标记；所有状态继续 `execution_verified=false`、`safe_to_auto_resume=false`。
- 文件路径对祖先目录及最终文件检查符号链接；在支持 `O_NOFOLLOW` 的平台拒绝末尾符号链接竞态，打开后用 `fstat` 复核普通文件和大小，并限制读取累计字节。祖先目录跨进程替换竞态尚未由目录句柄逐级锁定，不能声称完全消除 TOCTOU。
- 新增 `tests/test_session_diagnostics.py` 回归用例：空会话、无用户消息、空白助手结尾、重复工具调用 ID、乱序工具结果、合法配对及父目录符号链接。
- **未执行测试、构建或 CI**；尚需 Windows/Linux 兼容性验证，尤其是 Windows 文件标志与路径竞态。不得将本轮标记为已验证。

## 待验证：长任务会话状态只读诊断（2026-11-17）

- 本轮仅进行源码与文档静态审阅，**没有运行测试、构建、安装或 GitHub Actions**。新增 `tests/test_session_diagnostics.py`，覆盖末尾消息、未配对工具调用、孤立工具结果、损坏 JSONL、超限文件、符号链接、CLI 绕过 Provider/MCP 与隐私字段不外泄。
- 验收尚未完成：需授权后运行 Windows/Linux 单元测试，并检查真实会话记录兼容性。该功能不执行恢复，也不证明任务完成。
- 设计局限：JSONL 保存并非原子写入，只有会话级消息而非持久化执行事件；工具副作用及远端状态不能从消息推断。

## 已验证：EigenFlux 逐机器人网络行为上限（PR #22）

- `tests/test_eigenflux_policy.py`：默认拒绝所有行为、必须用户 `--confirm`、群聊/机器人和能力隔离、撤销及审计、SHA-256 过期修改拒绝、私有权限文件、未知能力/账户拒绝、损坏文件和符号链接拒绝。
- 验证删除同 ID 群并重建时，旧 Home 和旧本地网络意向不被继承。`tests/test_eigenflux_adapter.py` 同步验证新建群带随机实例标记，历史房间目录路径兼容。
- `angel eigenflux policy` CLI 的 allow/deny/show/audit 不调用 Provider、MCP、外部 EigenFlux CLI 或宿主 scheduler；无实际模型、网络或密钥操作，所有策略结果都不能声称完成 onboarding。
- GitHub Actions [PR #22 运行 43832998445](https://github.com/js2005happy/angel/actions/runs/43832998445)：Ubuntu Python 3.10/3.12 与 Windows Python 3.12 全通过；Windows 共执行 356 项 unittest。模拟网络工具与子进程，无真实 EigenFlux 安装、登录、网络调用或付费模型费用。

## 已验证：EigenFlux bare-CLI 本地适配准备（PR #21）

- `tests/test_eigenflux_adapter.py`：主 Agent Home 不随会话/cwd 变化；不同群/机器人成员 Home 无重叠；未知机器人、非法 ID、符号链接路径拒绝。
- 默认 doctor 不读取 CLI 版本、不调用子进程且不创建任何身份目录；显式 `--check` 固定只允许两条本地 CLI 命令，传递凭据最小环境变量，并按超时或命令错误报告 incomplete，不虚报网络已连接。
- CLI 集成不会创建模型 Provider、MCP 或 scheduler，全部测试采用临时目录与模拟命令，没有真实安装、EigenFlux 网络请求或模型调用。
- GitHub Actions [PR #21 CI 43830402473](https://github.com/js2005happy/angel/actions/runs/43830402473)：Ubuntu Python 3.10/3.12 和 Windows Python 3.12 全部通过，Windows 运行 342 项 unittest。全部 EigenFlux 命令使用 mock，未进行实际安装、登录、网络发布或付费模型调用。

## 已验证：Poppy OAuth issuer 双向核验（PR #20）

- `tests/test_poppy_identity.py` 检验公司域名 → protected resource → issuer metadata → issuer `protected_resources` 反向绑定，多个 issuer 的 `auth.issuer` 选择及单 issuer 自动确认。
- 测试合法 404、合法无 issuer、非法 403/超时不降级；错误资源、错配发行方、无 `refresh_token`、无 revocation/token/authorization 端点和重定向均失败关闭。
- CLI `--inspect-poppy-identity` 不调用 Provider/MCP/外部 API；只读 Agent 工具必须显式 `--poppy`；结果不声称已登录、获得 OAuth 令牌或支持远端操作。
- GitHub Actions [PR #20 CI 43827185087](https://github.com/js2005happy/angel/actions/runs/43827185087)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部成功；Windows 运行 330 项 unittest。测试使用 mocked HTTPS，无真实 OAuth、远端 MCP 或付费模型调用。

## 已验证：Poppy 站点授权意向账本（PR #19）

- `tests/test_poppy_permissions.py`：默认拒绝、按完整站点/账户别名/scope 隔离，CLI grant 强制 `--confirm`，revoke 与审计，SHA-256 版本校验，损坏文件/符号链接拒绝、非公开域名/错误 scope 拒绝。
- 只读 Agent 工具 `poppy_permission_check` 仅在 `--poppy` 开启，不能通过模型工具 grant/revoke，`local_intent=recorded` 依然 `may_execute_remote_action=false`。
- Poppy 1.0 `scope_hints` 未知 changes 按不可逆、个人数据字段缺失按未知处理，均不等于真实远端授权。
- GitHub Actions [PR #19 运行 43825501917](https://github.com/js2005happy/angel/actions/runs/43825501917)：Ubuntu Python 3.10/3.12 与 Windows Python 3.12 全通过，Windows 共执行 313 项测试。全部采用临时目录和 mock，无真实网络或模型 API 花费。
- 后续 OAuth Session、HTTP MCP 与真实远端操作审批不在本 PR，不能把本地意向当作可执行授权。

## 已验证：Poppy 1.0 公共发现客户端首阶段（PR #18）

- `tests/test_poppy.py` 验证：公共域名标准发现、精确重定向路径、Poppy 1.0 及同主机备选版本、组织域名绑定、HTTP/URL 凭据/端口拒绝、公开 DNS 检查与 pinned-IP TLS、默认隐藏工具/只读显式开启、无需 Provider 的 CLI 诊断。
- GitHub Actions [PR #18 运行 43823881880](https://github.com/js2005happy/angel/actions/runs/43823881880)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部通过，Windows 测试共 299 项。无真实外站请求、付费模型调用或外部 MCP 连接；网络层使用模拟 HTTPS/DNS 回归。
- 已知限制：尚未实现 Poppy Session、OAuth issuer、DPoP、API 资源令牌或 UCP 商务调用；本阶段只发现而不执行。

## 已验证：长期记忆浏览器（PR #17）

- `tests/test_memory_browser.py` 测试全局及独立机器人完整记忆读写、token 鉴权、未知机器人及路径穿越拒绝、符号链接不越界、超过 64 KiB 不允许网页编辑。
- 模拟另一个 Agent 在读取与保存之间调用 `append_memory`：确认服务器返回 409 且不会覆盖新记忆；文件修订号按原始 UTF-8 字节 SHA-256 校验。
- 测试手动与自动会话压缩不改动长期 MEMORY.md 原始内容，并且 Agent 下次任务仍加载所选记忆。测试使用假 Provider，不消耗真实模型 API。
- GitHub Actions [PR #17 运行 43821614526](https://github.com/js2005happy/angel/actions/runs/43821614526)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部通过；Windows 运行 281 项 unittest。测试没有真实模型 API 费用。
- 保留限制：没有跨进程锁，也未实现所有历史记忆的语义自动检索；本期仅管理完整文件并保留原有最近 40 行注入策略。

## 已验证：单文件 apply_patch、审批 diff 和 /diff（PR #16）

- `tests/test_apply_patch.py`：严格 hunk 匹配、多段修改/插入/删除、过期文件、错误行号、LF/CRLF、无尾换行、越界保护、权限审批、审批中并发修改、检查点撤销及 Web UI 多行预览。
- `tests/test_checkpoint_cli.py`：实际 REPL `/diff` 查看最新检查点，并在 `/undo` 后不再显示原差异。
- GitHub Actions [PR #16 CI 43814541490](https://github.com/js2005happy/angel/actions/runs/43814541490)：Ubuntu Python 3.10、Ubuntu Python 3.12 和 Windows Python 3.12 全部通过，Windows unittest 日志显示 265 项通过。测试用假 Provider，没有实际模型 API 消费。
- 限制：不增加 Shell、MCP、E2B 写入能力，也不提供跨文件补丁原子事务、完整工作树 diff 或 OS 级沙箱。

## 已验证：本地文件检查点与 /undo、/rewind（PR #15）

- `tests/test_checkpoints.py` 验证新建/覆盖/编辑/plan 以及二进制原件恢复、一次任务多次写入只有一条检查点、子 Agent 继承、跨轮 rewind、重启后的恢复。
- 验证文件被用户修改、原始备份损坏、出现符号链接/越界时拒绝回滚，所有文件的冲突预检先于任何恢复；文件过大或轮次超限失败保护。E2B 写入不产生虚假的本地检查点。
- `tests/test_checkpoint_cli.py` 使用假模型驱动交互 REPL 验证 /undo、/rewind 2、非法轮数、/new 会话隔离和撤销后会话通知。
- GitHub Actions [PR #15 运行 43811411177](https://github.com/js2005happy/angel/actions/runs/43811411177)：Ubuntu Python 3.10/3.12 和 Windows Python 3.12 全部通过；Windows 运行 247 项 unittest。使用临时目录和假模型，无真实 API 费用。
- 限制：Shell/MCP/E2B/HTTP 不在范围内，多文件恢复不是 OS 事务，异常退出可能留下不能自动安全恢复的未完成记录。


## 已验证：精确会话授权及 Shell 起始目录约束（PR #14）

- `tests/test_workspace_writes.py` 更新原有会话授权行为：`a` 仅对同一文件和工具有效，换文件/工具再批准；Shell 同时匹配规范化 cwd、timeout、后端和命令文本。
- 新增工作区外的 ../、绝对路径、符号链接的 shell cwd 拒绝测试；模拟 E2B 拒绝工作区外 cwd、合法相对 cwd 可执行；Web UI 回调不会被旧授权绕过。
- GitHub Actions [PR #14 CI 43804261790](https://github.com/js2005happy/angel/actions/runs/43804261790)：Ubuntu Python 3.10/3.12 和 Windows Python 3.12 全部通过；Windows 日志显示 227 项 unittest 通过。测试使用临时目录和 fake backend，无真实 API 调用。
- 已知限制：尚不测试或承诺 OS 沙箱、命令内部的跨目录访问或远端 E2B 符号链接隔离。


## 待验证：工作目录内置文件限制与会话审批

- `tests/test_workspace_writes.py`：覆盖本机 write/edit/plan 越界、绝对路径、外部符号链接、合法嵌套写入，以及 E2B POSIX 路径边界；模拟模型不需任何 API 费用。
- 验证 auto 的 `a` 仅缓存批准的单个文件工具或 shell 完全相同命令及 cwd；不允许 readonly/后台 auto 通过缓存；MCP/http_post/记忆/技能依旧逐次确认。
- 不声称完全阻止 shell 写出工作区或保证远端 E2B 符号链接目标；需等待 Ubuntu Python 3.10/3.12、Windows Python 3.12 CI 验证。


## 已验证：两阶段计划模式（PR #12）

- `tests/test_plan_mode.py` 使用模拟 Provider 测试只读工具白名单、路径穿越与符号链接、拒绝 shell/写入/MCP、旧计划在失败后不变、SHA-256 绑定批准。
- CLI 测试验证规划阶段不实例化 Agent/MCP/E2B；执行默认 auto（包括全权配置的情况），错误哈希不启动 Agent，与 JSONL 冲突得到错误。
- GitHub Actions [PR #12 CI 运行 43799280549](https://github.com/js2005happy/angel/actions/runs/43799280549)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部通过；Windows 日志显示 211 项 unittest 全部通过。测试使用假模型，无实际 API 费用。


## 未发布：memory_append / save_skill 测试补齐（2026-11-16）

- 本轮先把本地 checkout 与 GitHub main 同步：本地停在 5cfad1f，远程已走到 b9248f28（网页界面、项目官网、群聊、Token 用量 5 个提交）；56 个文件经连接器拉取同步，同步后全套测试 164 个通过。
- 新增 `tests/test_memory_skill_tools.py`（11 个）：`memory_append` 与 `save_skill` 的直接单元测试，v1 已知限制第 3 条就此关闭；测试只写临时目录（验证：跑完后 `~/.angel/` 下仍无 MEMORY.md）。
- README 测试数 127 修正为 175（164 + 11），版本号标题修正为 0.3.0。本次未做真实 API 调用（纯 mock 测试加固，无需调用）。

## 待验证：Token 用量与剩余上下文（PR）

- 新增 `tests/test_usage.py`，验证真实 API usage 累计、缺失或畸形数据不产生伪值、模型上下文上限仅在明确配置时生效。
- 覆盖 Agent 用量事件、CLI `/status`、一次性任务 stdout/stderr 分离，以及 Web UI 会话状态与展示标记。
- 使用模拟模型返回，不实际消耗 API Token；需要等待本 PR 在 Linux 3.10/3.12 和 Windows 3.12 全部通过后再合并。


## 未发布：多机器人群聊与独立 Agent 验证

- `tests/test_group_chat.py`：成员独立 system 身份、会话文件与 workspace、私有记忆、不同模型、@mention 路由、持久化、创建校验和讨论上限。
- `tests/test_group_webui.py`：本地 HTTP 服务测试群聊创建/发送/获取、 token 鉴权、独立 JavaScript 静态资源与 CSP。
- `tests/test_delegation_budget.py`：子 Agent 委派次数、递归深度、最大轮数以及角色和记忆继承。
- 通过 GitHub Actions Ubuntu Python 3.10、3.12 与 Windows Python 3.12 的跨平台验证后才合并；测试使用假模型而不花 API 费用。
- 群聊 MVP 默认只读且串行回应，不代表真实生产多 Agent 并行执行或自主后台运行已完成。


## 未发布：MCP 启动授权（含新 Web UI 兼容性）

- `tests/test_mcp_startup.py` 使用真实本地模拟 MCP stdio 进程启动标记，覆盖 readonly/非交互 auto 未启动、终端交互逐台批准、full 启动、旧 Windows 输出编码及 REPL 模式切换。
- `tests/test_webui_mcp_mode.py` 覆盖 Web UI 权限降级时关闭进程、升为 full 时重新加载、任务执行中拒绝切换，以及相同模式不重复启动。
- Web UI 新功能被保留，不覆盖任何已合并的 UI/官网源码。仅以 GitHub Actions 当前 PR Linux/Windows 结果为真实回归测试证据；这是进程启动控制，不是 OS 沙箱。


## 未发布：MCP 子进程环境隔离验证

- 新增单元测试 `tests/test_mcp_environment.py`：验证默认不继承模型 API Key、显式环境传递、配置格式错误及实际 Python MCP stdio 子进程的环境可见性。
- 只有 GitHub Actions 中 Linux/Windows 检查成功，才能认为新变更通过回归测试；与先前真实 DeepSeek/E2B 端到端测试不同。
- 安全边界：这是环境变量过滤，不代表进程、磁盘或网络沙箱。


## 未发布：跨平台稳定性修复（2026-11-16）

- GitHub Actions [运行记录](https://github.com/js2005happy/angel/actions/runs/43778155074)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 均通过语法编译、单元测试、CLI 版本检查。
- Windows 任务日志显示 `Ran 67 tests`，其中包含新增 5 项 Windows/MCP/沙盒路径回归测试；测试使用 mock 和本地子进程，不需要真实模型或 E2B 凭证。
- 修复了 Windows 匿名管道无法使用 `select.select()` 的 MCP stdio 超时问题；Python MCP 服务默认使用 UTF-8 输出；旧代码页的 CLI/daemon 输出自动安全降级；E2B 路径始终按 Linux/POSIX 规则解析。
- 本次证明的是跨平台模拟测试通过，**没有**重新进行真实模型 + E2B 端到端集成测试；v3 的既有端到端验证记录见下文。

---

## v3 结论

Angel 0.3.0 已完成并全部通过测试：62 个 mock 测试通过（v2 的 53 个全部保留并通过，新增 9 个）；E2B 沙盒执行后端已接进 Angel 本身，真实 DeepSeek + 真实 E2B 沙盒端到端跑通。

## v3 新增内容

| 模块/文件 | 说明 |
|---|---|
| `angel/e2b_backend.py`（新增） | E2B 沙盒执行后端：懒加载官方 `e2b` SDK（可选依赖），凭证优先 `E2B_API_KEY`、否则走已保存的 Muse 连接器凭证替身；`connect()` 新建或连接已有沙盒；`run_command` / `read_file` / `write_file` / `list_dir`；`close()` 不杀沙盒（到期自动销毁） |
| `angel/tools.py`（改） | `ToolContext` 增加 `backend` 字段；`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 有后端时走后端，其余工具仍在本地；审批与 shell 黑名单在两种后端下都生效 |
| `angel/config.py`（改） | `sandbox` / `e2b_template` / `e2b_timeout` / `e2b_sandbox_id` 配置 + `resolve_sandbox()`（CLI 参数 > `ANGEL_SANDBOX` / `ANGEL_E2B_*` 环境变量 > 配置文件 > 默认值） |
| `angel/agent.py`（改） | `Agent` 接受 `backend` 参数并传给 `ToolContext`；`delegate()` 把同一后端传给子 agent；系统提示词在沙盒模式下告知模型文件与命令都在沙盒里执行 |
| `angel/cli.py`（改） | `--sandbox {local,e2b}`、`--sandbox-id`、`--sandbox-template`、`--sandbox-timeout`；沙盒模式下工作目录默认 `/home/user`（沙盒路径，不在本地校验）；连接成功打印沙盒 id 与超时 |
| `scripts/remote_run.py`、`scripts/upload_angel.py`（新增） | 第 1 步原型验证脚本（大脑在外、手在沙盒）与把 Angel 代码传进沙盒跑测试的脚本 |

## v3 测试结果

### 1. Mock 测试（62 个，全部通过）

```bash
cd ~/workspace/angel
python3 -m unittest discover tests   # Ran 62 tests — OK
```

新增 9 个测试覆盖：FakeBackend 路由（读写改列文件、shell、plan、grep/git_status 走后端、本地零写入）、沙盒模式下黑名单与只读模式仍生效、E2B SDK 缺失时报明确安装提示、`E2B_API_KEY` 优先于连接器、`resolve_sandbox` 默认/环境变量/非法值、delegate 把后端传给子 agent。

### 2. 真实 DeepSeek + 真实 E2B 沙盒端到端

```bash
cd ~/workspace/angel
~/workspace/angel/.venv/bin/python -m angel --provider deepseek --mode full \
  --sandbox e2b --sandbox-id ipfjq62okgtm53z1fl8io --max-turns 8 \
  "在工作目录创建 sandbox-demo.txt，内容是'Angel 在沙盒里'，然后读出它确认，再列出工作目录"
```

结果：成功。Angel 连接沙盒 `ipfjq62okgtm53z1fl8io`，模型在沙盒里写 `/home/user/sandbox-demo.txt`（内容 `Angel 在沙盒里`）、读回确认、列出目录（`.bashrc`、`.profile` 等沙盒自带文件 + 本次新建的文件）。随后用 E2B SDK 独立回读确认：沙盒里确有该文件且内容一致；本地 `/home/user` 根本不存在，零写入。

### 3. 第 1 步原型（remote_run.py）

模型走 DeepSeek 连接器、工具走 E2B 沙盒，4 轮完成：写 `prime_sum.py`、沙盒里运行、结果 1060、读回确认。Angel 代码 28 个文件已上传进同一台沙盒，`--help` 正常，53 个测试在沙盒里全过。

## v3 已知限制（诚实记录）

1. **E2B 免费档沙盒超时上限 1 小时**：`--sandbox-timeout` 超过 3600 会被 E2B 拒绝（HTTP 400）；沙盒不主动删除，到期自动销毁。
2. **定时任务仍走本地执行**：`angel schedule` 创建的任务不读沙盒设置；沙盒模式只对本次命令行/交互会话生效。
3. 其余 v2 限制（web_search 未在真实网络验证、MCP 未接真实服务器、调度器 naive 本地时间、无真浏览器）仍适用。

---

# Angel 验证报告（2026-11-16，v2 0.2.0）

## v2 结论

Angel 0.2.0 已完成并全部通过测试：53 个 mock 测试通过（v1 的 21 个全部保留并通过，新增 32 个）；真实 DeepSeek API 端到端跑通（新工具 `grep_search` 实测）；MCP、调度器、会话压缩、证据链、provider 档案、web_search 双后端均已验证。

## v2 新增内容

| 模块/文件 | 说明 |
|---|---|
| `angel/mcp.py` | MCP 客户端（stdio JSON-RPC）：启动、initialize、list_tools、call_tool、超时控制；`MCPToolManager` 按最长前缀路由，工具名 `mcp_<服务器>_<工具>`；默认关闭（`mcp_enabled`） |
| `angel/scheduler.py` | 内置调度器：`~/.angel/schedule.json` 文件式任务，间隔或每天固定时间，daemon 循环；到期判断、运行记录、错误隔离 |
| `angel/compact.py` | 会话压缩：模型摘要 + 保留最近消息；模型失败时本地回退（保留首尾消息）；支持压缩整个会话文件 |
| `angel/evidence.py` | 证据链：联网抓取的页面原文按会话存档（`~/.angel/evidence/<会话 id>/`），带来源、时间、搜索词 |
| `angel/tools.py`（新增） | `grep_search`（文件内容搜索，支持正则/大小写）、`git_status`（只读）、`http_post`（走审批）；`web_search` 改为必应优先、百度兜底 |
| `angel/config.py`（新增） | `profiles` 档案 + `resolve_profile`（CLI 参数 > `ANGEL_PROFILE` 环境变量 > 配置默认值）；`mcp_enabled` 开关 |
| `skills/verify-research.md` | 核查式调研技能：搜索→打开官网→逐项核对→存证→附链接交付 |
| `angel/agent.py`（改） | MCP 工具路由、证据 store、`/compact` 与 `compact()`、系统提示词加入查证流程 |
| `angel/cli.py`（改） | `schedule` 子命令（list/add/remove/run/daemon）、`--profile`、`--compact`、`--list-mcp`、`--list-profiles`、REPL `/compact` |

## v2 分工（Codex 生成 vs Muse 写/改）

- **Codex 生成（按 Muse 的规格逐模块生成，Muse 落盘并逐一测试）**：`mcp.py`、`scheduler.py`、`compact.py`。三个模块一次通过编译与导入，无需返工；`scheduler.py` 的 `is_due` 有一处逻辑由 Muse 在测试后修正（见下）。
- **Muse 写/改**：全部 v2 规格、集成改动（`config.py` 档案与开关、`tools.py` 新工具与 web_search 双后端、`agent.py` 路由与证据接线、`cli.py` 子命令与档案接线）、`evidence.py`、`verify-research` 技能、全部 32 个新增测试、文档更新（README/DESIGN/VERIFICATION/CHANGELOG）、全部测试与真实 API 验证。
- **Muse 修正**：`scheduler.py` 的 `is_due`：原实现对“每天固定时间”任务只要从未运行就判到期，导致上午 9 点就触发 10:30 的任务。已改为：未到今天的执行时间就不到期（即使从未运行过），测试 `test_is_due_daily_at` 覆盖。

## v2 测试结果

### 1. Mock 测试（53 个，全部通过）

```bash
cd ~/workspace/angel
python3 -m unittest discover tests   # Ran 53 tests — OK
```

新增 32 个测试覆盖：MCP（假 stdio JSON-RPC 服务器：列工具、调用、未知工具、坏服务器优雅失败、配置校验）、调度器（任务校验、到期判断、间隔/每天固定时间、运行记录、daemon 两轮）、压缩（模型摘要、失败回退、空会话、整文件压缩）、provider 档案（默认/命名/未知报错/列表）、证据链（存档与列表、web_fetch 存证）、新工具（grep 纯文本/正则/大小写、git 非仓库与真仓库、http_post 本地回显、只读模式拦截）、web_search 解析器（必应/百度固定 HTML、拦截页报错、双后端全失败时明确报错）。

### 2. 真实 API 调用（DeepSeek flash，凭证走已保存连接器）

```bash
python3 -m angel --provider deepseek --model deepseek-flash --mode full \
  --workdir /tmp/angel-v2-e2e \
  "用 grep_search 找到工作目录里包含“香蕉”的文件和行号，把结果写进 result.txt，然后告诉我找到了什么"
```

结果：成功。模型调 `grep_search` 找到 `fruits.txt:2` 与 `more.txt:2`，写入 `result.txt` 并读回复核，还主动提醒 `result.txt` 自身含“香蕉”会导致下次搜索多一条命中。会话存于 `~/.angel/sessions/20261115-235218-1493.jsonl`。

### 3. CLI 新功能实测

- `python3 -m angel schedule list`：无任务时正常提示，exit 0。
- `python3 -m angel --list-mcp`：MCP 未启用时提示在配置里设 `"mcp_enabled": true`，exit 0。
- `python3 -m angel --list-skills`：列出 web-research、verify-research、file-organizer。
- `python3 -m angel --version`：Angel 0.2.0。

## v2 运行命令（给用户）

```bash
cd ~/workspace/angel

# 调度器：每天 08:30 跑一个任务
python3 -m angel schedule add --name 每日整理 --prompt "整理下载目录" --at 08:30 --mode full
python3 -m angel schedule daemon          # 守护进程跑起来
python3 -m angel schedule list             # 查看任务
python3 -m angel schedule run              # 立刻跑一次到期的任务

# 会话压缩
python3 -m angel --compact <会话 id>

# provider 档案（在 ~/.angel/config.json 的 profiles 里加档案后）
python3 -m angel --profile strong "做点什么"
python3 -m angel --list-profiles

# MCP（在 ~/.angel/config.json 里设 "mcp_enabled": true 并配 mcp_servers 后）
python3 -m angel --list-mcp
```

## v2 已知限制（诚实记录）

1. **web_search 双后端未在真实网络验证**：必应/百度解析器只在固定 HTML 上测过；本机网络下真实搜索是否通（必应是否也被拦、百度是否要求验证）尚未实测，下次真实调用时以实际结果为准。全部失败时工具会明确报错，不编结果。
2. **MCP 未接真实服务器验证**：只用假 stdio 服务器测过协议；真实 MCP 服务器的兼容性以实际接入为准。
3. **调度器是 naive 本地时间**：不处理时区；daemon 需自己保持进程运行（systemd/后台运行另行配置）。
4. **无真浏览器**：浏览器类工具（navigate/click/screenshot）未做，记入路线图；证据链是截图留档的轻量版。
5. 其余 v1 限制（无真沙箱、模型调用计费、auto + 非交互）仍适用，见下。

---

## v1（2026-11-15）结论

Angel 0.1.0 已完成并全部通过测试：Python 标准库 only，无 pip 依赖；21 个 mock 测试通过；真实 DeepSeek API 端到端跑通；REPL、会话恢复、auto 审批确认均已实测。

## 交付物

`~/workspace/angel/`，共约 2100 行代码+文档：

| 文件 | 说明 |
|---|---|
| `angel/config.py` | 配置 + provider 注册表（deepseek/xai/openrouter/ollama/openai/custom） |
| `angel/providers.py` | OpenAI 兼容客户端（urllib），支持 env Key 与已保存连接器凭证 |
| `angel/tools.py` | 11 个工具 + 审批 + shell 危险命令黑名单 |
| `angel/agent.py` | agent 主循环、系统提示词组装、delegate 子 agent |
| `angel/skills.py` | 技能解析 / 关键词匹配 / 保存 |
| `angel/memory.py` | 长期记忆 + AGENTS.md + 会话 jsonl 存储 |
| `angel/cli.py` | 参数解析 + REPL（/help /mode /skills /sessions /clear /new /exit） |
| `angel/__init__.py`、`angel/__main__.py` | 版本号与入口 |
| `skills/web-research.md`、`skills/file-organizer.md` | 自带示例技能 |
| `tests/test_smoke.py` | 21 个测试（stdlib unittest） |
| `README.md`、`DESIGN.md`、`LICENSE`（MIT） | 文档与许可证 |

## 分工（Codex 生成 vs Muse 写/改）

- **Codex 生成（按 Muse 的规格逐模块生成，Muse 落盘并逐一测试）**：`config.py`、`providers.py`、`skills.py`、`memory.py`、`tools.py`、`agent.py`、`cli.py`。6 个模块全部一次通过，无需返工（`tools.py` 的 web_search 提示文案由 Muse 后补一处，见下）。
- **Muse 写/改**：架构与接口设计、全部规格提示词、`__init__.py`、`__main__.py`、两个示例技能、`tests/test_smoke.py`、`README.md`、`DESIGN.md`、`LICENSE`、本报告；`tools.py` 的一处小修（见“已知限制”）；全部测试与真实 API 验证。

## 测试结果

### 1. Mock 测试（21 个，全部通过）

```bash
cd ~/workspace/angel
python3 -m unittest discover tests   # Ran 21 tests — OK
python3 tests/test_smoke.py          # 同样通过
```

覆盖：主循环（写→读→回答）、delegate 子 agent、会话保存/恢复、最大轮数截断、provider 错误透传、11 个工具的读写改列、shell 黑名单（`rm -rf /`、`rm -rf ~`、`mkfs`、`dd` 写设备、关机、fork 炸弹）、readonly 禁写、auto 非交互禁写、edit 歧义拒绝、plan 写文件、技能解析/匹配、配置解析、CLI `--list-skills` / `--version`。

### 2. 真实 API 调用（DeepSeek flash，凭证走已保存连接器）

```bash
python3 -m angel --provider deepseek --model deepseek-flash --mode full \
  --workdir /tmp/angel-e2e \
  "创建一个文件 hello-angel.txt，里面写一句英文问候，然后读回文件内容并向我汇报"
```

结果：成功。模型调用 `write_file` 写入 73 字符问候，再用 `read_file` 读回并中文汇报。文件内容：`Hello! It's a pleasure to meet you, and I hope you have a wonderful day.` 会话存于 `~/.angel/sessions/20261115-154741-0afd.jsonl`（即本次端到端 transcript）。

随后用 `--resume 20261115-154741-0afd` 追问文件内容，模型直接从会话历史回答，未再读写文件——会话恢复已验证。

### 3. REPL

`printf '/help\n/skills\n/exit\n' | python3 -m angel`：横幅、`/help`、`/skills`（列出 web-research、file-organizer）、退出均正常，exit 0。

### 4. auto 审批（PTY 实测）

用 PTY 驱动 `python3 -m angel --mode auto`，模型请求写文件时出现 `允许执行吗？[y/N]`，输入 `y` 后文件 `approved.txt` 创建成功（内容 `approved`），exit 0。证明交互确认链路真实工作。

### 5. web_fetch / web_search

- `web_fetch https://example.com`：正常抓取并提取文本。
- `web_search`：本机网络下 DuckDuckGo 返回人机验证页，工具返回明确提示（“DuckDuckGo 要求人机验证，当前网络下无法搜索”）而不是崩溃或假装有结果。见“已知限制”。

## 运行命令（给用户）

```bash
cd ~/workspace/angel

# DeepSeek（已保存的连接器凭证，不用再填 Key）
python3 -m angel "帮我看看这个目录里有什么"
python3 -m angel --mode full "创建一个文件 hello.txt，写一句问候"

# 交互模式
python3 -m angel

# Grok
python3 -m angel --provider xai "做点什么"

# 查看技能 / 会话
python3 -m angel --list-skills
python3 -m angel --list-sessions
```

## 已知限制（诚实记录）

1. **web_search 被 DuckDuckGo 拦截**：本机出口 IP 触发 DuckDuckGo 人机验证，搜索返回明确错误而非结果。换网络或接正式搜索 API 可解决；Muse 已补一处判断，让报错原因可读。这不是解析 bug。
2. **无真沙箱**：shell 以运行 Angel 的用户身份执行，MVP 只靠审批 + 黑名单挡危险命令；真沙箱在路线图第一项。full 模式请只在信任目录使用。
3. **memory_append / save_skill 未进单元测试**：这两个工具会写 `~/.angel/` 下的真实文件，单元测试里未覆盖；其代码路径已随主循环跑通过（工具分发表无问题），但未单独断言。
4. **模型调用要花钱**：软件免费，推理按 token 计费。本次验证总计只用了几百 token 的 deepseek-flash，成本可忽略；日常使用建议默认 flash 模型。
5. **auto + 非交互**：cron/管道运行时 auto 模式遇到写操作会明确报错退出，不会悄悄写入；后台任务请用 `--mode full`。


## 2026-11-21 — claim 执行边界与验收证据审阅（仅静态）

- 已读取开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP 和 `scripts/node_tool_claim.ts`，对照最新提交及开放 Issues/PR；源码明确声明 Node claim 未接入真实工具派发。
- 未运行测试、编译、脚本、CI、故障注入或外部 API；不能将先前 main 的 CI 状态当作本开发分支的验证结果。
- 安全阻塞：`statfsSync` 和 procfs fd 身份复核仅在检查瞬间有效，无法锁住特权挂载命名空间；Windows 句柄方案仍未完成。下一项实现前需要可审查的执行链设计与平台测试计划。
- 新增外部反馈来源：2026-11-16 Codex #61857（未验证即宣称完成）；2026-10-04 Codex #50771（长任务提前停止）。它们不证明 Angel 有同类故障。

## 2026-11-22 — 失败工具报告事件分类（仅静态审查）

- 核查开发分支 README、DESIGN、CHANGELOG、VERIFICATION、ROADMAP、Agent/Tools、no_progress、测试、近期提交、开放 Issues/PR 与可查询 CI；未运行任何测试、编译、安装或外部工具执行。
- 修改 `angel/no_progress.py` 接受 `tool_failed` 作为不可信空转观察；`angel/agent.py` 将返回的 `错误：` / `执行失败：` 报告分类为该事件；新增回归测试定义。此前异常抛出仍保守停止，不能从字符串判断真实副作用。
- GitHub 主分支最新可见提交 `840a522e207a838eb6720283d5eeaaf4bfb571f7`（2026-11-22），相关状态检查和 PR 工作流查询均为空；不能据此认定 CI 通过。开放 PR #113 涉及固定任务评测，避免重复开发。
- **未验证：** 代码路径运行正确性、跨平台兼容、完整 CI、实际模型效果；无主分支合并或生产发布。
