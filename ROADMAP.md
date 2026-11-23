## 2026-11-23 — P1 本地 shell 非零退出码显式报告（静态审查，未运行）

- **源码事实**：本地 `_tool_shell` 仅返回 stdout/stderr；命令以非零码退出但无输出时返回「（无输出）」，被旧式工具结果分类器当作非失败文本。现使用 `subprocess.CompletedProcess.returncode`（可信本地进程元数据）为非零退出添加固定 `错误：命令退出码 N` 前缀；仍保留原始 stdout/stderr 供诊断。未改变零退出、远端 backend、审批或重试策略。
- **外部用户报告（2026-11-23 查阅）**：2026-09-23 [Codex #47433](https://github.com/openai/codex/issues/47433) 报告早期沙箱拒绝缺失执行事件；2026-03-12 [Codex #14423](https://github.com/openai/codex/issues/14423) 报告自动化初始命令以退出码 1 失败；2026-05-23 [Codex #24226](https://github.com/openai/codex/issues/24226) 提醒 grep/diff/test 的退出码 1 可能是正常语义。以上均为其他项目的个案，不代表 Angel 故障发生率。
- **推断及优先级（价值/难度/安全风险/依赖）**：① P1 本地 shell 失败状态显式化 **高/低/低/现有 subprocess（本轮静态完成）**；② P1 可信结构化 shell 结果 **高/中/中/Agent 与工具接口兼容（待做）**；③ P1 其他直接返回文本的隐私审计 **高/中/中/各工具契约（待做）**；④ P1 预模型/预记录隐私保护 **高/高/高/策略及兼容验证（研究）**；⑤ P1 独立副作用验收回执 **高/高/高/可信外部读回（阻塞）**。
- **边界**：非零码不一定意味着业务任务失败（如 grep 无匹配），只表示命令未按 shell 的零退出约定完成；成功退出也不证明外部副作用成功。stdout/stderr 可能包含敏感内容，本轮未引入 DLP。未执行测试、编译、CI 或命令。

## 2026-11-23 — 未知工具名隐私与下一步排序（静态增量）

- **源码事实**：`execute_tool` 对未知工具原样回显 `name`；如果上游传入路径或凭据样式字符串，可能出现在模型可见错误中。本轮仅改固定提示并定义两项未执行回归测试，不声称真实泄露已发生。
- **公开反馈（2026-11-23 复核）**：2026-07-03 [Codex #31015](https://github.com/openai/codex/issues/31015) 报告工具输出后置脱敏时机问题；2026-07-19 [Codex #34233](https://github.com/openai/codex/issues/34233) 报告敏感配置被输出；2026-07-01 [Codex #30831](https://github.com/openai/codex/issues/30831) 请求限制大型工具输出。均属外部个案/请求，不能证明 Angel 缺陷频率。
- **推断与排序（价值/难度/安全风险/依赖）**：① P1 未知工具名回显 高/低/低/既有分发器（本轮已静态修复）；② P1 可信结构化错误码与诊断 高/中/中/工具 API 兼容（待做）；③ P1 其他直接返回文本审计 高/中/中/各工具契约（待做）；④ P1 预模型/预记录隐私保护 高/高/高/策略与跨平台测试（研究）；⑤ P1 独立副作用验收回执 高/高/高/可信外部读回（阻塞）；⑥ P2 大输出可检索存储 中高/高/中/私有文件权限（研究）。未知外部副作用禁止自动重试。

## 2026-11-23 — P1 本地 edit_file 缺失路径回显（仅静态）

- **源码事实**：`_tool_edit_file` 的本地缺失文件错误包含调用方 `path`；此前 `read_file` 已处理类似分支，但 `edit_file` 尚未覆盖。本轮只替换该错误文本并新增未执行回归定义；不声称复现真实泄漏。
- **公开用户反馈（2026-11-23 复核）**：[Codex #31015](https://github.com/openai/codex/issues/31015) 报告工具输出在后置脱敏前进入记录；[Codex #34233](https://github.com/openai/codex/issues/34233) 报告凭据暴露。属于其他产品的个案，不能推出 Angel 事故或总体频率。
- **排序（价值 / 实现难度 / 安全风险 / 依赖）**：P1 本地 edit_file 缺失路径保护 **高/低/低/既有本地编辑分支（本轮完成，未验证）**；P1 可信结构化错误码与诊断 **高/中/中/工具 API 及前端兼容（待做）**；P1 其他直接返回文本审查 **高/中/中/各工具契约（待做）**；P1 预模型/预记录隐私策略 **高/高/高/用户授权与兼容测试（研究）**；P1 独立副作用回执 **高/高/高/可信远端读回（阻塞）**；P2 大输出可恢复存储 **中高/高/中/私有产物权限（研究）**。
- **边界**：保留原有错误前缀与正常编辑路径；远端返回、预览、成功输出仍可能包含敏感数据。禁止未知副作用自动重试。

## 2026-11-23 — P1 通用 ToolError 输出隐私边界（仅静态）

- **代码事实**：`execute_tool` 直接回显 `ToolError` 文本，而部分下游异常可包含操作系统路径、请求参数或后端内容。现改为固定失败文本；没有运行时泄漏复现，也不宣称覆盖所有模型可见数据。
- **外部反馈（2026-11-23 核对）**：2026-07-03 [Codex #31015](https://github.com/openai/codex/issues/31015) 请求工具输出在展示和存储前脱敏；2026-07-19 [Codex #34233](https://github.com/openai/codex/issues/34233) 报告凭据进入工具输出。这是外部用户个案，不是 Angel 事故证据或高频统计。
- **候选排序（价值/实现难度/安全风险/依赖）**：P1 通用 ToolError 回显脱敏 **高/低/低/现有分发器（本轮完成，未运行）**；P1 可信结构化错误码与可用诊断 **高/中/中/工具 API 与前端兼容（待做）**；P1 其他直接返回文本审计 **高/中/中/各工具返回契约（待做）**；P1 预模型/预记录 DLP **高/高/高/隐私策略与兼容性验证（研究）**；P1 独立副作用验收回执 **高/高/高/可信远端读回（阻塞）**；P2 大型输出可检索存储 **中高/高/中/私有产物权限（研究）**。
- **边界**：固定文本会合并「用户拒绝」与「工具错误」的显示语义，但保持失败前缀；未改审批、成功输出、自动重试或外部权限。后续须在授权环境做跨平台回归验证。

## 2026-11-23 — grep_search 正则错误脱敏与后续优先级

- **源码事实**：本地/远端 grep_search 的 re.error 异常详情会原样拼入模型可见文本；本轮替换为固定错误提示。该风险未运行复现。
- **外部反馈（2026-11-23 核对）**：2026-07-19 [Codex #34233](https://github.com/openai/codex/issues/34233) 报告敏感配置进入工具输出；2026-07-03 [Codex #31015](https://github.com/openai/codex/issues/31015) 报告后置脱敏无法阻止原始工具输出进入记录。外部个案不能代表 Agent 整体发生率。
- **工程推断与排序（价值/难度/风险/依赖）**：① grep 正则错误脱敏 高/低/低/现有工具接口（本轮）；② 其他显式 ToolError 信息审查 高/中/中/工具返回兼容；③ 预模型、预记录隐私边界 高/高/高/输出策略与跨平台测试；④ 独立副作用验收回执 高/高/高/可信外部读回；⑤ 大输出可检索存储 中高/高/中/私有产物访问控制。禁止未知副作用自动重试。

## 2026-11-23 — grep_search 缺失路径隐私与预模型保护（静态增量）

- **外部用户报告（事实，2026-11-23 核对）**：2026-07-19 [Codex #34233](https://github.com/openai/codex/issues/34233) 报告凭据进入工具输出和会话；2026-07-03 [Codex #31015](https://github.com/openai/codex/issues/31015) 报告工具输出在后置钩子处理前显示；2026-06-01 [Codex #25585](https://github.com/openai/codex/issues/25585) 请求本地预提交敏感信息保护。均为外部个案或需求，不代表 Angel 发生率或漏洞复现。
- **源码事实**：`grep_search` 本地和远端缺失路径提示原先插入调用方 `path`，本轮统一固定错误提示并增加未运行回归定义。正常匹配内容仍原样返回，不能宣称全局 DLP。
- **工程推断及候选排序（价值/难度/安全风险/依赖）**：P1 其他显式 ToolError 回显审计 高/中/中/工具接口兼容；P1 可信只读结构化适配器 高/中/中/结果分类器；P1 预模型与预记录敏感输出保护 高/高/高/安全策略与兼容测试；P1 独立副作用验收回执 高/高/高/可信外部读回；P2 大输出可检索存储 中高/高/中/私有产物权限。一次仅推进一项，不自动重试未知副作用。


## 2026-11-23 — git_status 第二阶段超时失败关闭（静态增量）

- **源码事实**：本地 `git_status` 的首个 subprocess 有超时处理，第二个 `git diff --stat` 未捕获 `TimeoutExpired`；通用分发器虽会屏蔽异常详情，但调用方无法收到明确的阶段性失败提示。此项不涉及远端 backend。
- **外部用户反馈（需求信号，非本项目故障证据）**：2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 报告长任务返工与额度浪费；2026-11-16 [Codex #61857](https://github.com/openai/codex/issues/61857) 涉及未验证即报告完成。以上日期依据既有仓库记录，未在本轮重新核验原帖；不能由个案推断总体频率。
- **工程推断与排序（价值/难度/安全风险/依赖）**：① git_status diff 阶段超时明确失败 高/低/低/现有 subprocess（本轮）；② 其他显式 ToolError 输出审计 高/中/中/工具审计；③ 可信只读结构化适配器 高/中/中/执行报告接口；④ 预模型隐私保护 高/高/高/内容策略与兼容性；⑤ 独立副作用验收 高/高/高/外部可信读回。仅修改本地只读 git 状态错误分支，不添加自动重试。

## 2026-11-23 — P1 git_status missing-directory path privacy (static-only)

- **Repository fact (source inspection):** local `_tool_git_status` interpolated caller-supplied `path` into its missing-directory error, unlike the hardened local `read_file` and `list_dir` paths. This could expose private directory names in model-visible output; no observed Angel incident is claimed. Replaced only that error with `错误：目录不存在` and defined a regression test (not executed).
- **External user request (reviewed 2026-11-23):** [Codex #25585](https://github.com/openai/codex/issues/25585) asks for a local pre-submit DLP gate; [Codex #2847](https://github.com/openai/codex/issues/2847) asks for deterministic sensitive-file exclusion. These are individual external requests, not frequency estimates or proof of an Angel vulnerability. Original publication dates were not verified in this run.
- **Ranked candidates (value / difficulty / safety risk / dependencies):** P1 local git_status missing-directory privacy **high / low / low / existing local handler (implemented, untested)**; P1 remaining explicit ToolError audit **high / medium / medium / per-tool contracts (open)**; P1 trusted read-only structured adapters **high / medium / medium / local provenance (open)**; P1 pre-model/pre-transcript DLP **high / high / high / policy, false positives, user consent (research)**; P1 independent side-effect receipts **high / high / high / trusted external authority (blocked)**.
- **Boundary:** normal git output, backend execution, remote MCP, other errors and model input are unchanged. No auto retry, permission expansion, dependencies or runtime validation.

## 2026-11-23 — P1 http_post unexpected-exception privacy (static-only)

- **Source fact:** `_tool_http_post` previously interpolated unexpected exception text into model-visible output; such errors may include private URLs or credentials. This is a code-derived exposure risk, not a confirmed Angel leak. Changed only this catch branch to a fixed message; HTTP status and response-body branches remain unchanged.
- **External feedback (reviewed 2026-11-23):** [Codex #34233](https://github.com/openai/codex/issues/34233) (opened 2026-07-19) reports credential-bearing tool output; [Codex #31015](https://github.com/openai/codex/issues/31015) (opened 2026-07-03) requests pre-transcript redaction; [Codex #30831](https://github.com/openai/codex/issues/30831) (opened 2026-07-01) requests bounded tool output. These are individual external reports, not Angel incident evidence or prevalence estimates.
- **Ranked queue (value / difficulty / safety risk / dependency):** P1 http_post unexpected exception privacy **high / low / low / existing POST handler (implemented, untested)**; P1 explicit ToolError audit **high / medium / medium / per-tool contracts (open)**; P1 trusted read-only structured adapters **high / medium / medium / local provenance (open)**; P1 pre-model and pre-transcript privacy gate **high / high / high / lifecycle design and consent (research)**; P1 independent side-effect receipts **high / high / high / trusted external authority (blocked)**; P2 bounded output with recoverable artifacts **medium / high / medium / artifact lifecycle and access policy (research)**.
- **Safety boundary:** POST might have reached the remote server before an exception. This change does not retry, verify side effects, hide successful/HTTP-error response bodies, or provide DLP. No new dependency or runtime validation.

## 2026-11-23 — P1 web_fetch network exception privacy (static-only)

- **Repository fact (source inspection):** `_tool_web_fetch` interpolated arbitrary network exception text into model-visible failure output. Network errors can contain sensitive URLs or credentials; this is a preventive source-based inference, not an observed Angel incident. Replaced that exception branch with a constant error (implemented, untested).
- **External feedback (reviewed 2026-11-23):** [Codex #31015](https://github.com/openai/codex/issues/31015) (2026-07-03) describes pre-redaction tool output exposure; [Codex #34233](https://github.com/openai/codex/issues/34233) (2026-07-19) describes credential-bearing tool output. Individual external reports, not Angel incident evidence or population prevalence.
- **Ranked candidates (value / difficulty / safety risk / dependencies):** P1 web_fetch exception privacy **high / low / low / existing fetch handler (implemented, untested)**; P1 remaining explicit ToolError and http_post exception audit **high / medium / medium / individual tool contracts (open)**; P1 trusted read-only typed adapters **high / medium / medium / local provenance (open)**; P1 pre-model/pre-transcript privacy boundary **high / high / high / lifecycle and consent design (research)**; P1 independent side-effect receipts **high / high / high / trusted external authority (blocked)**.
- **Boundary:** successful fetched content, requested URL, evidence paths and HTTP POST responses are unchanged. No general DLP, retries, new dependencies or runtime validation.

## 2026-11-23 — P1 web_search exception privacy (static-only)

- **Repository fact:** `web_search` included explicit ToolError and unexpected network exception text in model-visible fallback errors. This is a potential query/credential disclosure inferred from source inspection, not an observed incident. Fixed by using static provider-specific failure labels (implemented, untested).
- **External feedback:** [Codex #31015](https://github.com/openai/codex/issues/31015), opened 2026-07-03, reports output visible before post-tool redaction; [Codex #34233](https://github.com/openai/codex/issues/34233), opened 2026-07-19, reports credential-bearing tool output. Individual reports, not prevalence estimates or Angel-specific evidence.
- **Ranked queue (value / difficulty / safety risk / dependency):** P1 web_search exception redaction **high / low / low / existing search handler (implemented, untested)**; P1 remaining explicit ToolError audit **high / medium / medium / individual tool contracts (open)**; P1 trusted read-only structured adapters **high / medium / medium / trusted local provenance (open)**; P1 pre-model/pre-transcript privacy boundary **high / high / high / tool lifecycle design (research)**; P1 independent side-effect receipts **high / high / high / trusted external authority (blocked)**.
- **Boundaries:** successful search snippets, search queries sent to providers, evidence output and other tool paths are unchanged; no comprehensive secret scanner or automatic retry is claimed.

## 2026-11-23 — P1 legacy local read_file missing-path privacy (static-only)

- **Repository fact (reviewed 2026-11-23):** `_tool_read_file` still interpolated a caller-provided missing path into model-visible output, even though the trusted structured local adapter had already removed this disclosure. This is a source-derived exposure risk, not a confirmed incident.
- **External feedback (reviewed 2026-11-23):** [Codex #31015](https://github.com/openai/codex/issues/31015) reports that post-tool hooks may show raw sensitive output before redaction; [Codex #25585](https://github.com/openai/codex/issues/25585) requests a local pre-submit secret filter. These are separate external user reports, not proof of Angel exploitation or prevalence. Their original publication dates were not established in this review.
- **Ranked queue (value / difficulty / safety risk / dependencies):** P1 legacy missing-file path redaction **high / low / low / existing local handler (implemented, untested)**; P1 remaining explicit `ToolError` output audit **high / medium / medium / individual tool contracts (open)**; P1 trusted read-only structured adapters **high / medium / medium / trusted provenance (open)**; P1 pre-model and pre-transcript privacy boundary **high / high / high / lifecycle and user-consent design (research)**; P1 independent side-effect receipts **high / high / high / external trusted authority (blocked)**.
- **Scope:** only missing-file message in legacy local `read_file` is made constant. Successful reads, remote backends, permission checks and typed outcome reporting remain unchanged. No automated retry, new dependency, runtime verification or release.

## 2026-11-23 — P1 explicit ToolError privacy in trusted local listing (static-only)

- **Repository fact (reviewed 2026-11-23):** `execute_local_list_dir_report` interpolated the text of an explicit `ToolError` into model-visible output. A future caller or helper could include a private path or credential in that error; this is a source-derived exposure possibility, not an observed Angel incident.
- **External user feedback (reviewed 2026-11-23):** [Codex #34233](https://github.com/openai/codex/issues/34233) (2026-07-19) reports secrets exposed by tool output; [Codex #31059](https://github.com/openai/codex/issues/31059) (2026-07-03) requests pre-model file-read sanitization. These are individual reports from another product, not frequency estimates or proof of this Angel issue.
- **Ranked candidates (value / difficulty / safety risk / dependency):** P1 local explicit ToolError redaction **high / low / low / existing typed listing adapter (implemented, untested)**; P1 audit other explicit ToolError surfaces **high / medium / medium / tool-by-tool compatibility (open)**; P1 additional trusted read-only typed adapters **high / medium / medium / provenance-safe local source (open)**; P1 pre-model secret output policy **high / high / high / consent and compatibility (research)**; P1 independent side-effect receipts **high / high / high / independent authority (blocked)**.
- **Scope:** the trusted local listing adapter now returns a fixed message for explicit ToolError; it preserves typed `reported_error`. No change to successful listings, generic dispatcher ToolError behavior, remote tools, automatic retries, or dependencies. Regression defined but not executed.

## 2026-11-23 — P1 local missing-directory path privacy (static-only)

- **Source fact (reviewed 2026-11-23):** trusted local `list_dir` returned the caller-provided path verbatim for a missing directory; a private absolute path could enter model-visible output. This is a source-derived risk, not an observed leak. The earlier missing-file redaction did not cover directory listings.
- **External user reports:** [Codex #34233](https://github.com/openai/codex/issues/34233) (2026-07-19) describes credentials exposed through tool output; [Codex #31059](https://github.com/openai/codex/issues/31059) (2026-07-03) requests pre-model sanitization. Both are individual reports about other software, not evidence of Angel impact or frequency. Reviewed 2026-11-23.
- **Ranked candidates (value / implementation difficulty / safety risk / dependencies):** P1 local missing-directory path redaction **high / low / low / existing adapter (implemented, untested)**; P1 remaining explicit ToolError privacy audit **high / medium / medium / individual tool contracts (open)**; P1 additional trusted read-only typed adapters **high / medium / medium / provenance-safe local source (open)**; P1 pre-model sensitive-content policy **high / high / high / consent and compatibility (research)**; P1 external side-effect receipts **high / high / high / independent authority (blocked)**.
- **Scope:** only missing local directory error text is replaced with a constant; typed `reported_error` is preserved. Successful listings, remote backends, and external tools are unchanged. No new dependencies, execution verification, or automatic retry.

## 2026-11-23 — P1 missing local read_file path privacy (static-only)

- **Repository fact (static inspection):** the local trusted read adapter returned a missing-file error containing the raw caller-provided path. Paths may embed private directory names or sensitive identifiers. This is a source-derived exposure risk, not a reproduced leak.
- **External feedback:** [Codex #34233](https://github.com/openai/codex/issues/34233) (opened 2026-07-19) reports credential disclosure through tool output; [Codex #31059](https://github.com/openai/codex/issues/31059) (opened 2026-07-03) requests pre-model sanitization of file-read results. Reviewed 2026-11-23. Individual reports, not Angel incident evidence or prevalence estimates.
- **Ranking (value / difficulty / safety / dependency):** P1 missing-path redaction high / low / low / existing local adapter (**implemented, untested**); P1 other trusted read-only adapters high / medium / medium / per-tool provenance (**open**); P1 explicit ToolError audit high / medium / medium / tool contracts (**open**); P1 pre-model secret output policy high / high / high / compatibility and user consent (**research**); P1 independent side-effect receipts high / high / high / trusted authority (**blocked**).
- **Scope:** missing local file errors no longer echo caller path. Successful file contents, remote backend, and generic ToolError contract are unchanged. No secret scanning, external verification, automatic retries, or new dependencies.

## 2026-11-22 — P1 generic tool dispatch exception privacy (static-only)

- **Repository fact (source inspection):** `execute_tool` previously appended raw `TypeError` and arbitrary exception strings to model-visible tool results. Exception text may contain caller-supplied paths or credentials. This is a potential exposure inferred from source, not a reproduced incident.
- **External feedback:** [Codex #34233](https://github.com/openai/codex/issues/34233), opened 2026-07-19, reports accidental credential disclosure in agent tool output. Individual external incident; does not prove an Angel leak. Reviewed 2026-11-22.
- **Priority (value / difficulty / safety risk / dependency):** P1 unexpected dispatch exception redaction high / low / low / existing dispatch (**implemented; untested**); P1 further trusted read-only adapters high / medium / medium / per-tool provenance (**open**); P1 explicit ToolError content audit high / medium / medium / tool contracts (**open**); P1 independent side-effect receipts high / high / high / trusted authority (**blocked**); P1 private task persistence medium-high / medium / medium-high / secure storage (**blocked**).
- **Scope:** Generic unexpected exception text is replaced with fixed errors; explicit `ToolError` text is deliberately unchanged for compatibility and remains an audit target. No retry, execution verification, or third-party dependency.

## 2026-11-22 — P1 trusted local read_file report (static-only)

- **Repository fact (static inspection):** local read_file returned file text to the legacy prefix classifier; a legitimate file beginning with `错误：` could be logged as failed, while an empty file could be logged unknown. This is a source-path inference, not a runtime reproduction.
- **External user feedback (reviewed 2026-11-22):** [Codex #60104](https://github.com/openai/codex/issues/60104) (2026-11-07) describes long-task rework and unreliable progress. Individual report, not evidence of this file-reading defect or population prevalence.
- **Engineering response:** opt-in in-process local adapter returns file text and typed reported outcome separately, without changing model-visible file content; remote backend/MCP unaffected. Generic OS/argument errors are redacted; no independent acceptance or auto-resume authority.
- **Ranked queue (value / difficulty / safety / dependency):** P1 local read_file typed report high / low-medium / low / existing typed protocol (**implemented, untested**); P1 other safe read-only adapters high / medium / medium / per-tool provenance (**open**); P1 independent side-effect receipts high / high / high / trusted external authority (**blocked**); P1 private task persistence medium-high / medium / medium-high / secure storage (**blocked**). No dependency added.

## 2026-11-22 — P1 local list_dir argument error privacy guard (static-only)

- Source fact: the trusted local listing adapter and Agent fallback echoed raw TypeError messages, potentially including sensitive caller values. Preventive source-based inference; no production incident established.
- Fixed both paths to return generic argument error; regression definition added but not run.
- External context: Codex #60104 (2026-11-07), https://github.com/openai/codex/issues/60104, reports progress/wasted-work concerns, not a path leak.
- Ranked candidates (value / difficulty / security / dependency): P1 further read-only structured adapters (high / medium / medium / adapter review); P1 independent side-effect receipts (high / high / high / reconciliation); P1 private task persistence (medium / medium / medium-high / storage isolation). No dependencies added.

## 2026-11-22 — 本地目录读取异常隐私边界（静态增量）

- **仓库事实**：开发分支的本地 `list_dir` 结构化适配器在通用异常分支将 `str(exc)` 直接送入模型可见工具文本；文件系统异常可能含绝对路径、用户名或挂载位置。本轮改为固定的通用失败消息，同时保留 `StructuredToolReport(reported_error)`；仅修正本地 `list_dir`，不修改远端后端或其它工具。
- **外部用户反馈**：[Codex #60104](https://github.com/openai/codex/issues/60104)，2026-11-07 用户报告长任务返工、错误状态与额度浪费；此为外部个案，**不是本地路径泄漏的实证**。本轮隐私风险由源码静态审查推断，未发生实际泄漏验证。
- **价值/难度/风险/依赖排序**：① P1 本地异常输出最小化（高/低/低/现有结构化适配器；本轮已提交、未测试）；② P1 扩展其它本地只读工具结构化结果（高/中/中/逐工具保留模型兼容文本）；③ P1 独立进展/副作用回执（高/高/高/可信验收）；④ P1 私有任务契约持久化（中高/中/中高/安全存储与审批）；⑤ P0 跨进程执行所有权（高/高/高/跨平台锁及崩溃语义）。禁止自动重放未知副作用。

## 2026-11-22 — P1 trusted local list_dir structured report (static-only)

- **Repository fact (source inspection):** the local `list_dir` handler has direct filesystem control-flow information, but Agent previously classified its returned text. A filename starting with `错误：` can therefore be mistaken for a failed listing when it is simply data. This is a static inference, not a runtime reproduction.
- **External report reviewed 2026-11-22:** [Codex #60104](https://github.com/openai/codex/issues/60104), opened 2026-11-07, describes repeated work and confusing progress claims. This individual report does not establish prevalence or prove the local filename issue.
- **Priority ranking (value / difficulty / safety risk / dependency):** P1 local read-only typed adapter high / medium / low / existing StructuredToolReport (**implemented, untested**); P1 additional trusted adapters high / medium / medium / provenance-safe source (**open**); P1 independent side-effect receipts high / high / high / external authority (**blocked**); P1 private task persistence high / medium / medium-high / secure storage (**blocked**).
- The local-only adapter reports outcomes from filesystem operations, not text. Model-visible listing remains a string; remote backend and MCP paths are unchanged. This is not independent verification or authorization for retry/resume. No tests/CI run.

## 2026-11-22 — P1 blank legacy tool outcome fail-closed (static-only)

- **Repository fact:** blank and whitespace-only string tool returns were classified as neither failure nor unknown; the optional ToolJournal could therefore record them as reported success. Source analysis only, not runtime reproduction.
- **External feedback reviewed 2026-11-22:** [Codex #60104](https://github.com/openai/codex/issues/60104) (opened 2026-11-07) reports repeated long-task work and progress confusion. One external report, not prevalence data or proof of this bug.
- **Inference and ranked queue (value / difficulty / safety / dependency):** P1 blank result unknown high / low / low / existing classifier (**implemented, untested**); P1 trusted read-only structured adapter high / medium / medium / provenance-safe bridge (**open**); P1 independent side-effect receipt high / high / high / trusted authority (**blocked**); P1 private task persistence high / medium / medium-high / secure storage (**blocked**). Legacy nonblank text behavior unchanged; no automatic retry/resume or execution verification.

## 2026-11-22 — P1 untyped non-text tool outcomes fail closed (static-only)

- **Repository fact (static source inspection):** `classify_tool_report` previously classified non-text values (e.g. `None`, dict, list) as neither failure nor unknown. The optional Agent journal records success when both flags are false; therefore an untyped non-text adapter return could be logged as reported success. This is a code-path finding, not a runtime reproduction.
- **External report (reviewed 2026-11-22):** [Codex #60104](https://github.com/openai/codex/issues/60104), reported 2026-11-07, describes repeated long-task work and misleading progress. This is one user's report, not measured prevalence or proof of an Angel bug. **Engineering inference:** ambiguous adapter returns should not become positive journal reports.
- **Ranking (value / difficulty / safety risk / dependency):** P1 non-text unknown classification high / low / low / existing classifier (**implemented, not tested**); P1 provenance-safe read-only structured adapter high / medium / medium / trusted in-process boundary (**open**); P1 independent side-effect receipts high / high / high / adapter and authority (**blocked**); P1 private task persistence high / medium / medium-high / safe filesystem (**blocked**). Legacy text behavior is unchanged. Unknown reports still cannot prove side effects or authorize retry/resume.

## 2026-11-22 — Unknown structured tool outcome is not journal success (static-only)

- **Source-derived fact:** the existing Agent journal wrote `success=not reported_failure`; a typed `StructuredToolReport("unknown")` is not a reported failure, so it would be logged as result_ok despite uncertainty. This is a static code-path finding, not a runtime reproduction.
- **External feedback (reviewed 2026-11-22):** [Codex #60104](https://github.com/openai/codex/issues/60104) (2026-11-07) reports wasted long-task work and progress confusion. Individual report, not proof of this Angel bug.
- **Inference / ranking (value / difficulty / risk / dependency):** P1 preserve unknown in journal high / low / low / existing typed classifier (**implemented, untested**); P1 trusted read-only adapter high / medium / medium / provenance-safe output bridge (**open**); P1 independently verified progress high / high / high / trusted authority (**blocked**); P1 private task persistence high / medium / medium-high / safe filesystem (**blocked**). Unknown is now explicit in classification, and journal treats it as non-success. Legacy strings remain compatible.
- No external outcome verification, automatic retry/resume, third-party dependency, tests, merge or release.

## 2026-11-22 — Explicit in-process tool outcome metadata (static-only)

- Public report (reviewed 2026-11-22): [Codex #60104](https://github.com/openai/codex/issues/60104) (2026-11-07) describes a long task repeatedly redoing work and reporting stalled progress; one user's report, not a population trend or Angel reproduction.
- Repository fact: existing classifier uses legacy Chinese error prefixes; no independently verified external outcome is available from text. Open PR [#113](https://github.com/js2005happy/nyra/pull/113) covers fixed-task evaluation; avoid duplicate implementation.
- Engineering inference: StructuredToolReport offers strict, opt-in in-process outcomes (reported_ok, reported_error, unknown) to future trusted adapters; the classifier accepts the typed value but not arbitrary dict/JSON/text as structured authority. Exceptions override reports. Verification and auto-resume flags remain false. No adapter producers or main-loop wiring this round.
- Ranked (value / difficulty / risk / dependency): P1 typed outcome boundary high / low / low / existing classifier (implemented, untested); P1 trusted adapter integration high / medium / medium / per-tool provenance (open); P1 independent progress attestation high / medium-high / high / trusted controller (blocked); P1 private task storage high / medium / medium-high / secure cross-platform storage (blocked); P0 claim dispatch high / high / high / sandbox and approval (blocked).
- No tests, CI, installs, merges, releases, or automatic retries.

## 2026-11-22 — Conservative legacy tool result status (static-only)

- **External facts (reviewed 2026-11-22):** [Codex #40646](https://github.com/openai/codex/issues/40646) (opened 2026-08-25) reports unsupported execution claims; [Codex #45395](https://github.com/openai/codex/issues/45395) (October 2026 discussion) distinguishes approval-review failure from unsafe-action rejection. Individual external reports, not Angel reproductions or prevalence estimates.
- **Source finding:** Angel's journal recognized only the `错误：` prefix while the advisory detector recognized both `错误：` and `执行失败：`; the same returned text could therefore be logged as successful yet classified as failed in the observer.
- **Engineering inference / increment:** one conservative standard-library classifier now serves both call sites. Exception state overrides result text; a non-error-looking return never establishes execution verification or safe auto-resume. No parsing of untrusted tool JSON into authority.
- **Priority (value / difficulty / safety / dependencies):** P1 legacy classifier alignment high / low / low / existing Agent (**implemented, untested**); P1 structured tool result protocol high / medium / medium / tool backend contracts (**open**); P1 independent trusted progress high / medium-high / medium-high / trusted controller (**open**); P1 private task storage high / medium / medium-high / safe cross-platform filesystem (**blocked**); P0 real claim dispatch high / high / high / sandbox and approval (**blocked**).
- **Boundaries:** no independent verification, automatic retry, pause, resume, test execution, CI, new dependency, main merge or release.

## 2026-11-22 — Repair escaped-newline advisory source (static-only)

- **Repository fact (reviewed 2026-11-22):** Six literal backslash-n sequences were embedded in a Python comment in the optional post-tool observation block of `angel/agent.py`. The assignments to `failed_report`, `progress_event`, and `state` were commented out, yet `state` was referenced on the next physical line. This is source analysis, not a runtime reproduction.
- **External reports (reviewed 2026-11-22):** [Codex #47802](https://github.com/openai/codex/issues/47802) (2026-09-24) describes idle polling after failed subagent dispatch; [Codex #60104](https://github.com/openai/codex/issues/60104) (2026-11-07) describes repeated work and wasted usage. These individual reports do not establish Angel prevalence or this specific source defect.
- **Engineering inference and ranking (value / difficulty / safety risk / dependency):** P1 repair advisory observation high / low / low / existing observer (**implemented, untested**); P1 independent trusted progress source high / medium-high / medium-high / external authority (**open**); P1 structured tool results high / medium / medium / tool compatibility (**open**); P1 private task-contract storage high / medium / medium-high / secure cross-platform filesystem (**blocked**); P0 claim dispatch high / high / high / sandbox and approvals (**blocked**).
- Replaced only the six escaped sequences with physical newlines. No automatic cancellation, retry, trust elevation or dependency changes. Tests and CI not run.

## 2026-11-22 — Reset advisory idle count at each Agent run (static-only)

- **Repository fact (reviewed 2026-11-22):** The optional NoProgressDetector is caller-owned; Agent.run previously preserved its idle counter across separate user tasks. An idle_limit=2 detector with one old observation could alert after just one tool return in the next task. This is a source-derived risk, not a measured incident.
- **External user reports (reviewed 2026-11-22):** [Codex #35259](https://github.com/openai/codex/issues/35259) (2026-07-24) and [#60104](https://github.com/openai/codex/issues/60104) (2026-11-07) describe wasted work or repeated activity. Individual reports do not establish frequency or prove this Angel-specific state leakage.
- **Engineering inference / ranking (value / difficulty / safety risk / dependency):** P1 per-run advisory reset high / low / low / existing observer (**implemented, untested**); P1 independent verified progress source high / medium / medium-high / external trusted authority (**open**); P1 private durable task contract high / medium / medium-high / cross-platform secure storage (**blocked**); P0 claim dispatch high / high / high / sandbox and approvals (**blocked**).
- Reset only advisory counts on each Agent.run, never task state, tool effects, approval, or execution verification. No automatic pause, replay or trust elevation. Tests and CI not run.

## 2026-11-22 — Count one idle observation per completed tool call (static-only)

- **External facts (reviewed 2026-11-22):** [Codex #35259](https://github.com/openai/codex/issues/35259) (opened 2026-07-24) documents repeated model-mediated status polling and locally measured token volume; [Codex #60104](https://github.com/openai/codex/issues/60104) (opened 2026-11-07) reports repeated work and loss of no-rework constraints. These are individual external reports, not Angel reproductions or population prevalence.
- **Angel source fact:** the opt-in observer counted a tool-requesting model message and its tool return separately. A single tool cycle could therefore hit idle_limit=2, before two distinct tool results existed.
- **Engineering inference / ranked queue (value / difficulty / safety risk / dependency):** P1 one-observation-per-tool high / low / low / existing advisory observer (**implemented, untested**); P1 independent trusted progress source high / medium / medium-high / independent authority (**open**); P1 private durable task contract high / medium / medium-high / cross-platform secure storage (**blocked**); P0 claim real dispatch high / high / high / isolation and approvals (**blocked**).
- Count only tool returns as untrusted idle observations; do not infer progress from model prose, tool success or polling. A tool exception may stop before a return observation; no automatic pause, retry, resume or trust elevation. Static review only; tests and CI not run.

## 2026-11-22 — Terminal-reply idle false positive (static-only)

- **Source facts (reviewed 2026-11-22):** Existing Angel main-loop source observed every model reply as idle before checking whether the reply contained tool calls; a terminal reply could therefore trigger an idle warning even when the task was ending. External [Codex #41007](https://github.com/openai/codex/issues/41007) (2026-08-27) and [#47802](https://github.com/openai/codex/issues/47802) (2026-09-24) report polling-related wasted activity; these individual reports do not establish Angel prevalence.
- **Engineering inference and priority:** P1 terminal false-positive fix high value / low difficulty / low risk / existing advisory detector (**implemented, untested**). P1 independent verified progress source high / medium / medium / trusted controller (**open**). P1 private task contract persistence high / medium / medium-high / cross-platform storage (**blocked**). P0 claim dispatch high / high / high / sandbox and approval (**blocked**).
- Terminal model replies now skip idle observation; model replies requesting tools and tool returns remain untrusted observations. No automatic cancellation or execution authorization. Tests/CI not run.

## 2026-11-22 — Opt-in advisory idle observation (static only)

- External facts (reviewed 2026-11-22): Codex issue #41007 (2026-08-27, https://github.com/openai/codex/issues/41007) reports repeated unchanged-UI polling; #47802 (2026-09-24, https://github.com/openai/codex/issues/47802) reports failed subagent dispatch and polling. Individual reports, not prevalence or reproduced Angel defects.
- Engineering inference: an optional metadata-only advisory signal in the main loop is safer than automatic cancellation. Count model responses and tool returns as untrusted idle events; emit once per run when threshold is reached. No execution authority or automatic retries.
- Priority (value / difficulty / risk / dependencies): P1 advisory Agent wiring high / low-medium / low / existing observer (implemented, untested); P1 independent trusted progress events high / medium / medium / trusted controller (open); P1 private task storage high / medium / medium-high / platform storage (blocked); P0 claim dispatch high / high / high / sandbox and approval (blocked).
- Limitations: productive runs may be flagged; detector is caller-owned and should be fresh per task; no verified progress, watchdog, or auto-resume. Tests and CI not run.

## 2026-11-22 — Explicit advisory progress-event vocabulary (static-only)

- **Public facts, reviewed 2026-11-22:** [Codex #37800](https://github.com/openai/codex/issues/37800) (opened 2026-08-10) reports empty continuation turns; [Codex #41007](https://github.com/openai/codex/issues/41007) (opened 2026-08-27) reports repeated polling of unchanged UI instead of authoritative progress; [Codex #47802](https://github.com/openai/codex/issues/47802) (opened 2026-09-24) reports failed subagents and idle polling. These are external user reports, not Angel reproductions or measured prevalence.
- **Engineering inference:** model messages, polling and generic tool returns should never reset an idle streak; a narrowly named deliverable/acceptance event should only reset when an independent caller attests trust. Implemented a bounded string-only adapter on the existing pure observer. The boolean attestation is a caller contract, **not** cryptographic or runtime evidence.
- **Priorities (value / difficulty / safety risk / dependencies):** P1 event vocabulary high / low / low / existing observer (**implemented, untested**); P1 main-loop trusted event bridge high / medium / medium-high / independently verified controller and safe callback design (**open**); P1 opt-in private durable task storage high / medium / medium-high / cross-platform secure filesystem (**blocked**); P1 trusted receipt key lifecycle high / high / high / independent issuer (**blocked**); P0 claim dispatch high / high / high / sandbox and approval (**blocked**).
- **Boundaries:** no Agent loop integration, user-content retention, automatic pause/retry/resume, test execution, CI, dependencies, merge or release.

## 2026-11-22 — Advisory no-progress observation (static-only)

- **External user reports (facts, reviewed 2026-11-22):** [Codex #37800](https://github.com/openai/codex/issues/37800) (opened 2026-08-10) reports repeated empty continuation consuming tokens; [Codex #47802](https://github.com/openai/codex/issues/47802) (opened 2026-09-24) reports subagent idle polling without deliverables; [Codex #43021](https://github.com/openai/codex/issues/43021) (opened 2026-09-05) reports stuck tasks consuming allowance. These are individual reports, not Angel reproductions or prevalence estimates.
- **Engineering inference:** a bounded, explicit progress/idle counter can provide a safe building block before adding runtime cancellation. Added `angel.no_progress.NoProgressDetector` with a configurable idle threshold, saturation, and advisory `needs_attention` signal; model commentary and successful polling are not trusted progress. No runtime integration or automatic stop.
- **Priority (value / effort / safety risk / dependencies):** P1 opt-in private durable task storage high / medium / medium-high / cross-platform secure atomic storage (**open, platform design blocked**); P1 advisory idle observer medium-high / low / low / trusted caller events (**implemented, untested**); P1 main-loop progress event integration high / medium / medium / reliable event classification and approval (**open**); P1 independent receipt key lifecycle high / high / high / external authority (**blocked**); P0 claim dispatch high / high / high / isolation and approval (**blocked**).
- **Privacy and safety:** only two integer counters stored, no prompts, arguments, tool outputs, files, clock, network or model invocation. Observations do not assert execution success or authorize auto-resume. The caller must not infer progress from status prose.

## 2026-11-22 — Task contract metadata wire boundary (static-only)

- **External reports (facts, reviewed 2026-11-22):** [Codex #40646](https://github.com/openai/codex/issues/40646) (2026-08-25) reports lost task prohibitions and unsupported execution claims; [Codex #57608](https://github.com/openai/codex/issues/57608) (2026-10-28) reports task loss after compaction. These are individual reports, not Angel reproductions or prevalence measurements.
- **Inference:** a strict versioned, metadata-only import/export format can be reviewed before any durable storage or auto-resume. Added bounded 32 KiB JSON bytes envelope, duplicate-key and unknown-field rejection; authority flags are regenerated false on import. No persistence, encryption, runtime integration or permission transfer.
- **Priority (value / difficulty / safety risk / dependencies):** P1 metadata envelope high / low / low / existing validator (**implemented; untested**); P1 opt-in private durable storage high / medium / medium-high / filesystem atomicity, user consent and cross-platform protections (**open**); P1 no-progress detector medium-high / medium / medium / trusted events (**open**); P1 key lifecycle high / high / high / independent authority (**blocked**); P0 claim dispatch high / high / high / isolation and approval (**blocked**).
- **Privacy boundary:** labels are metadata, not cryptographically secret; callers must not put prompts, secrets, paths, user content or tool outputs in labels. No filesystem writes or auto-resume.

## 2026-11-22 — Metadata-only task contract boundary (static-only)

- **Public facts (reviewed 2026-11-22):** [Codex #40646](https://github.com/openai/codex/issues/40646) (opened 2026-08-25) reports loss of task constraints during long sessions; [Codex #36718](https://github.com/openai/codex/issues/36718) (opened 2026-08-03) requests evidence-backed completion records. These are external user reports, not Angel reproductions or prevalence measurements.
- **Inference:** preserve a bounded, privacy-minimal contract of requirement labels, prohibition labels, phase and revision before considering durable storage or runtime enforcement.
- **Rank (value / effort / safety risk / dependencies):** P1 metadata contract high / low / low / standard library (**implemented, untested**); P1 durable privacy-preserving storage high / medium / medium / atomic storage and consent (**open**); P1 independent key lifecycle high / high / high / external trust authority (**blocked**); P1 replay protection high / high / high / trusted state (**blocked**); P1 no-progress detection medium-high / medium / medium / reliable events (**open**); P0 claim dispatch high / high / high / isolation and approvals (**blocked**).
- **Scope:** in-memory strict validator and unexecuted regression definitions only. No private prompts, tool inputs, secrets, persistence, auto-resume, runtime wiring, CI, merge or release.

## 2026-11-22 — Issuer-bound offline receipt verification (static-only)

- **External facts (reviewed 2026-11-22):** [Codex #61857](https://github.com/openai/codex/issues/61857), opened 2026-11-16, reports unsupported acceptance claims; [Codex #40646](https://github.com/openai/codex/issues/40646), opened 2026-08-25, reports drift of execution constraints and unsupported verification. Individual user reports, not Angel reproductions or frequency estimates.
- **Engineering inference:** a MAC without an explicit independently pinned issuer and key identifier makes key rotation and issuer selection difficult to audit. Added an isolated v2 offline verifier with a caller-supplied trusted (issuer, key-id) registry; no implicit trust from receipt fields. Removing a key from the registry rejects its receipts. It is not a persistent revocation system or a proof that tests ran.
- **Rank (value / effort / safety risk / dependencies):** P1 issuer/key-id binding high / medium / medium / independent trusted registry (**implemented, untested**); P1 key lifecycle and revocation high / high / high / external authority and durable storage (**open**); P1 replay protection high / high / high / trusted clock/store (**open**); P1 durable task contract high / medium / medium / privacy design (**open**); P1 no-progress detection medium-high / medium / medium / reliable events (**open**); P0 claim dispatch high / high / high / platform isolation and approval (**blocked**).
- **Scope:** isolated v2 verifier and unexecuted regression definitions. No runtime integration, network, new dependencies, key issuance, CI execution, merge or release.

## 2026-11-22 — Receipt artifact identity pinning (static-only)

- **Public feedback (fact, reviewed 2026-11-22):** [Codex #61857](https://github.com/openai/codex/issues/61857) (opened 2026-11-16) describes unsupported claims of deployed/device acceptance; [Codex #59492](https://github.com/openai/codex/issues/59492) (opened 2026-11-04) describes reports that look like evidence without corresponding primary-source proof. These are external user reports, not Angel reproductions or frequency measurements.
- **Inference:** a correctly authenticated statement for requirement/revision/environment may still refer to an artifact other than the one the verifier intended to check. Pinning an externally chosen artifact reference closes that local context mismatch, not issuer trust, CI authenticity, test execution, revocation or replay.
- **Priority (value / difficulty / safety / dependencies):** P1 receipt reference pinning high / low / low / existing offline verifier (**implemented, regression source unexecuted**); P1 trusted issuer and key rotation high / high / high / external authority (**open**); P1 replay and revocation high / high / high / trusted store (**open**); P1 durable task contract high / medium / medium / privacy design (**open**); P0 claim dispatch high / high / high / platform isolation and approvals (**blocked**).
- **Scope:** optional `expected_reference` exact match; no network, key management, runtime integration, new dependencies, tests, CI, merge or release.

## 2026-11-22 — Offline authenticated acceptance receipt (static-only)

- **External reports (facts):** [Codex #61857](https://github.com/openai/codex/issues/61857), opened 2026-11-16, reports unsupported target verification claims; [Codex #60258](https://github.com/openai/codex/issues/60258), opened 2026-11-08, reports premature stopping in multi-step tasks. Reviewed 2026-11-22. Individual reports, not Angel reproductions or prevalence estimates.
- **Engineering inference:** untrusted caller reference lists cannot establish provenance. Added standalone offline HMAC-SHA256 verifier for an exact requirement/revision/environment tuple; a secret provisioned by an independent authority must stay outside agent control. Verification authenticates a claim from the key holder, **not** that a test ran. No issuer/key management, replay protection, revocation, external CI API or runtime integration is implemented.
- **Ranking (value / difficulty / safety risk / dependency):** P1 offline receipt authenticity high / low-medium / medium / independent key issuer (**implemented, tests not run**); P1 trusted issuer lifecycle and replay protection high / high / high / external authority (open); P1 durable task contract high / medium / medium / privacy design (open); P1 no-progress detector medium-high / medium / medium / reliable events (open); P0 claim dispatch high / high / high / trusted storage and approvals (blocked).
- **Scope:** one standalone standard-library module, regression source, no execution or persistence, no automatic completion credit, no CI, merge or release.

## 2026-11-22 — Conflicting target context for one receipt (static-only)

- **External report (fact):** [Codex #61857](https://github.com/openai/codex/issues/61857), opened 2026-11-16 and reviewed 2026-11-22, describes unsupported completion claims for untested deployed/device environments. [Codex #42080](https://github.com/openai/codex/issues/42080), reviewed 2026-11-22, describes stale/proxy evidence. These are external reports, not Angel reproductions or measured prevalence.
- **Engineering inference:** a single receipt claimed for two different revision/environment pairs cannot safely be cherry-picked to satisfy acceptance. The assessor now marks both contexts conflicting and excludes that receipt; a separate nonconflicting eligible receipt may still count as *reported* complete. Caller claims are not independently verified.
- **Priority (value / difficulty / safety risk / dependency):** P1 conflicting-context rejection high / low / low / existing read-only assessor (**implemented; tests not run**); P1 independent provenance adapter high / medium / medium / trusted CI/target authority (open); P1 durable task contract high / medium / medium / privacy design (open); P1 no-progress detector medium-high / medium / medium / reliable events (open); P0 claim dispatch high / high / high / trusted storage and approvals (blocked); P0 Linux/Windows native storage defenses high / high / high / platform validation (blocked).
- **Scope:** one read-only classifier behavior, two regression cases, no runtime integration, network, filesystem, automatic replay, third-party dependency, merge, or release. Static review only.

## 2026-11-21 — Shared target receipt ambiguity (static-only)

- **External report (fact):** [Codex #61857](https://github.com/openai/codex/issues/61857), opened 2026-11-16, describes unsupported completion claims and overlapping task ownership; reviewed 2026-11-21. This is one external report, not an Angel reproduction or frequency estimate.
- **Engineering inference:** the same target-verification reference appearing under two requirements is ambiguous even when the caller has not configured optional reference scopes. The read-only assessor now fails closed for both; a distinct eligible receipt may still satisfy its own requirement. No independent source verification is claimed.
- **Ranking (value / difficulty / risk / dependencies):** P1 shared-reference rejection high / low / low / existing assessor (implemented, tests unrun); P1 trusted provenance adapter high / medium / medium / independent CI or target authority (open); P1 durable task contract high / medium / medium / privacy controls (open); P1 no-progress detector medium-high / medium / medium / trustworthy events (open); P0 claim dispatch high / high / high / trusted storage and approvals (blocked).
- **Scope:** no runtime wiring, network, filesystem, replay, new dependency, or production release. Static inspection only; no tests or CI run.

## 2026-11-21 — Requirement-scoped acceptance references (static-only)

- **External user report (fact):** [Codex #61857](https://github.com/openai/codex/issues/61857), opened 2026-11-16, reports unsupported completion claims and overlapping task ownership; retrieved 2026-11-21. This is a single report, not an Angel reproduction or prevalence estimate.
- **Engineering inference:** an approved reference may be reused to claim completion of unrelated requirements. Optional `reference_scopes` now binds each recognized receipt to one exact requirement; wrong-scope claims stay incomplete. Scopes are supplied by the caller, not independently authenticated.
- **Priority (value / difficulty / security risk / dependency):** P1 scope gate high / low / low / existing assessor (implemented, unexecuted tests); P1 independently verified evidence adapter high / medium / medium / trusted CI or target service (open); P1 durable task contract high / medium / medium / privacy model (open); P1 no-progress detector medium-high / medium / medium / reliable events (open); P0 claim dispatch high / high / high / secure storage and approvals (blocked).
- No runtime integration, filesystem, network, tool execution, replay, or new dependency. Cross-requirement reuse is rejected only when the caller opts into scopes.

## 2026-11-21 — Opt-in acceptance reference allowlist (static-only)

- **External user reports (facts, retrieved 2026-11-21):** [Codex #61857](https://github.com/openai/codex/issues/61857) reports unsupported completion claims; [Codex #62682](https://github.com/openai/codex/issues/62682) reports premature stopping before end-to-end deployment verification. These are individual reports, not Angel reproductions or prevalence measurements.
- **Engineering inference:** a caller-supplied, exact reference allowlist can conservatively keep unknown target evidence incomplete without dereferencing artifacts. The allowlist itself is untrusted; this is **not** an independent provenance adapter or proof of completion.
- **Ranking (value / effort / risk / dependencies):** P1 opt-in reference gate high / low / low / acceptance assessor (implemented, tests unrun); P1 independent trusted evidence adapter high / medium / medium / verified CI or target API (open); P1 durable task contract high / medium / medium / privacy controls (open); P1 no-progress detector medium-high / medium / medium / event provenance (open); P0 claim dispatch high / high / high / secure storage and approvals (blocked).
- **Scope:** optional bounded list; only exact listed references count for reported target completion when supplied; legacy omission unchanged. No network, filesystem, tool execution, or trust escalation.

## 2026-11-21 — Acceptance target revision/environment matching (static-only)

- **External user report (fact, 2026-11-16):** [Codex #61857](https://github.com/openai/codex/issues/61857) reports unsupported completion claims for deployed/device behavior; the issue explicitly requests matching the tested revision and environment to acceptance criteria. [Codex #42080](https://github.com/openai/codex/issues/42080) describes stale or proxy evidence attributed to the target. These are reports, not independently established prevalence or Angel reproductions.
- **Engineering inference:** optionally bind a read-only acceptance assessment to an exact expected revision and environment; evidence from another deployment must not satisfy the current target. **Ranking (value / effort / safety risk / dependency):** P1 exact target-context matching high / low / low / existing acceptance module (implemented, untested); P1 independent evidence adapter high / medium / medium / trusted CI/target APIs; P1 durable task contract high / medium / medium / privacy design; P1 bounded no-progress detector high / medium / medium / trusted events; P0 claim dispatch high / high / high / storage and approvals (blocked).
- **Scope:** both expected fields are optional together; when provided, only an exact matching reported target counts as reported complete. Mismatches remain visible in evidence but the requirement stays incomplete. Even matching evidence is untrusted; no independent verification, replay or runtime wiring. Tests added but not executed.

## 2026-11-21 — Acceptance evidence provenance gate (implemented, static-only)

- **External user report (fact, 2026-11-16):** [Codex #61857](https://github.com/openai/codex/issues/61857) describes completion claims unsupported by target-device or deployed-environment verification, despite checklists. It is an anecdotal report, not an Angel reproduction or frequency estimate. [Codex #60258](https://github.com/openai/codex/issues/60258) (2026-11-08) separately reports premature stopping on multi-step implementation.
- **Engineering inference:** reported target acceptance should include the specific tested revision and environment, so a source edit or generic check URL cannot silently become a target-environment claim. These strings are self-reported, not verified attestations.
- **Ranking (value / effort / safety risk / dependencies):** P1 provenance context gate high / low / low / existing acceptance module (implemented, untested); P1 independent evidence-source adapters high / medium / medium / trusted CI and target APIs; P1 persistent task contract high / medium / medium / privacy boundaries; P1 bounded no-progress detection high / medium / medium / progress events; P0 claim dispatch high / high / high / storage and approval safety (blocked); P0 Linux mount race high / high / high / OS threat model (blocked); P0 Windows handle security high / high / high / native API (blocked).
- **Scope:** only `target_verified` evidence now requires nonblank bounded `revision` and `environment` descriptions. Earlier evidence levels remain accepted without those fields. A self-reported target status never makes `independently_verified` or `safe_to_auto_resume` true. Regression tests added but not run; no runtime integration.

## 2026-11-21 — Read-only acceptance evidence primitive (implemented, untested)

- **External fact (report dated 2026-11-16):** [Codex #61872](https://github.com/openai/codex/issues/61872) describes a long UI integration task with many passing local checks but incomplete delivery. This is one external report, not a reproduced Angel defect or prevalence measurement.
- **Engineering inference:** explicit per-requirement evidence levels help distinguish source edits, static review, tests and target-environment acceptance. The new `angel/acceptance_evidence.py` supplies a pure read-only classifier; it does not inspect artifacts, persist sensitive content, grant approval, or integrate into the Agent loop. A reported `target_verified` level remains self-reported and `independently_verified` is always false.
- **Ranking (value / effort / security risk / dependencies):** P1 read-only acceptance classifier high / low / low / Python stdlib (implemented, not tested); P1 task contract persistence high / medium / medium / privacy design; P1 bounded no-progress detection high / medium / medium / trustworthy progress events; P0 real claim dispatch high / high / high / trusted storage and approvals (blocked); P0 Linux privileged mount race high / high / high / threat model (blocked); P0 Windows reparse handle defense high / high / high / native API (blocked); P1 MCP catalog invalidation medium-high / medium / medium / MCP.
- **Next:** add isolated static review of evidence provenance and tests before any runtime integration; never promote supplied evidence to verified execution automatically.

## 2026-11-21 — Agent long-task convergence evidence and safety gate (research only)

- **External report (fact, 2026-11-16):** [Codex #61872](https://github.com/openai/codex/issues/61872) describes a long Windows autonomous coding session that accumulated extensive tests and documentation without completing requested UI integration and delivery. It reports 11 compactions and distinguishes passing scoped tests from unfinished release work. This is one externally reported case, not an Angel reproduction or prevalence estimate.
- **Engineering inference:** prioritize explicit acceptance criteria and a bounded deliverable checkpoint over further claim-file micro-hardening; do not mark completion from tests, documentation, or tool-call counts alone. Preserve the user's latest corrections across compaction.
- **Candidate ranking (value / effort / security risk / dependencies):** P0 claim dispatch integration high / high / high / trusted storage + approvals (blocked on security design and runtime verification); P0 Linux mount-race defense high / high / high / privileged namespace model (blocked on OS threat model); P0 Windows handle validation high / high / high / Win32 (blocked on native review); P1 bounded task acceptance ledger high / medium / low / task-state events (candidate); P1 MCP catalog invalidation medium-high / medium / medium / MCP; P1 external-effect receipts high / high / high / adapters.
- **Decision:** no speculative claim-runtime change this round. Existing claim remains disconnected; tests/compilation/CI were not run. Next code increment should target a bounded, independently reviewable acceptance-state primitive only after locating the actual runtime owner, or a proven claim security defect.

## 2026-11-21 — P0 experimental Linux claim descriptor inheritance hardening (static-only)

- **Repository fact:** `scripts/node_tool_claim.ts` opens the claim directory and exclusive claim file; this increment explicitly adds Linux `O_CLOEXEC` to both opens to request close-on-exec and reduce accidental descriptor inheritance into child processes. Node/libuv may already apply close-on-exec; this is an explicit defense-in-depth contract, not a proven exploit fix. No runtime integration or dependencies.
- **External report, not Angel reproduction:** 2026-11-18 [Codex #62230](https://github.com/openai/codex/issues/62230) describes inaccurate cross-client live-agent status; 2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) describes unsupported execution claims. **Engineering inference:** trusted operation state and resource isolation deserve priority, but these reports do not establish claim-fd leakage or prevalence.
- **Priority (value / effort / security risk / dependency):** this explicit fd hygiene P0 medium / low / low / Linux O_CLOEXEC (implemented, untested); privileged mount race P0 high / high / high / OS namespace trust; Windows reparse handle P0 high / high / high / Win32; real dispatch integration P0 high / high / high / trusted claim + approvals; MCP catalog invalidation P1 medium-high / medium / medium / MCP; external-effect receipts P1 high / high / high / adapters.
- **Validation:** static inspection only; no compilation, tests, CI, or runtime confirmation. Linux-only experimental primitive, no exactly-once claim.


## 2026-11-21 — P0 Linux claim procfs final descriptor revalidation (static review only)

- **Repository fact:** experimental Node claim checks procfs type and fd identity before creation but previously did not recheck either after directory fsync, before its final name check. This increment repeats both checks against the still-open directory fd, failing closed on mismatch. Runtime dispatch remains unintegrated.
- **External user reports (facts):** 2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) reports execution claims diverging from observable tool traces; 2026-09-01 [Codex #41988](https://github.com/openai/codex/issues/41988) describes interrupted tool-output records. These are external reports, not Angel reproduction or prevalence data.
- **Engineering inference:** uncertain operation state should not be interpreted as verified execution; late storage identity checks narrow one detectable mount-change window but cannot eliminate a privileged mount-namespace race.
- **Priorities (value / effort / security risk / dependencies):** completed P0 final procfs recheck high / low / low / Linux procfs; pending P0 privileged mount race high / high / high / OS namespace trust; pending P0 Windows reparse handle guard high / high / high / Win32 API; pending P0 real Node dispatch integration high / high / high / verified storage and approval; pending P1 MCP tool catalog invalidation medium-high / medium / medium / MCP; pending P1 external effect receipts high / high / high / adapters.
- **Verification:** source-only inspection; no tests, build, fault injection, or CI run. This is not exactly-once execution or tamper-proof logging.
## 2026-11-21 — P0 procfs 描述符身份复核（静态审查）

- **仓库事实**：实验性 Linux claim 先检查 procfs 类型，但未在创建前核对 `/proc/self/fd/<directoryFd>` 是否解析到已打开目录。现在对该 procfs 描述符路径执行 `statSync`，要求目录类型、dev、ino、uid 与 `fstatSync(directoryFd)` 一致；异常失败关闭，不删除 claim、不重试、不增加依赖。
- **外部反馈事实**：2026-11-20 [Codex #62853](https://github.com/openai/codex/issues/62853) 报告执行环境中断与交付不确定；2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 报告重复返工。仅为外部用户个案，不证明 Angel 故障或普遍发生率。**工程推断**：执行所有权记录应先核对存储身份，再考虑恢复。
- **排序（价值/难度/安全风险/依赖）**：本项 P0 中高/低/低/Node fs（已提交待测试）；P0 procfs 挂载竞态 P0 高/高/高/Linux mount namespace；P0 Windows reparse 保护 高/高/高/Windows API；P0 实际工具派发集成 高/高/高/审批与可信 claim；P1 MCP 动态目录检测 中高/中/中/MCP；P1 副作用回执 高/高/高/适配器。
- **边界**：此项是创建前身份检查，不能阻止检查后的挂载切换，也不证明 exactly-once。未运行测试/编译/CI。

## 2026-11-21 — P0 Linux claim 路径词法规范化门禁（仅静态审阅）

- **仓库事实**：`checkPrivateDirectory` 用 `resolve(directory)` 检查祖先，但 `openSync(directory)` 打开原始路径；含 `..`、`.`、重复分隔符或尾部斜杠的路径可能让词法祖先检查与实际内核路径遍历不一致。新增 `directory === resolve(directory)` 要求，非规范绝对路径失败关闭；不改已有合法规范路径、claim 格式或工具派发。仅 Linux 实验性模块，未接入主运行时。
- **公开反馈事实**：2026-10-27 [Codex #57549](https://github.com/openai/codex/issues/57549) 报告委派后停止继续工作；2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) 报告执行声明缺少工具轨迹支持。两者是外部个案，不证明 Angel 存在同类问题或总体发生频率。**工程推断**：操作状态应绑定明确、不可歧义的存储位置，再讨论恢复或证明。
- **候选优先级（价值／难度／安全风险／依赖）**：本项 P0 中／低／低／Node path（已提交、待测试）；P0 Linux procfs 挂载竞态 高／高／高／可信 mount namespace；P0 Windows reparse 句柄保护 高／高／高／Windows 原生 API；P0 claim 接入真实派发 高／高／高／可信存储和审批；P1 MCP 动态工具目录检测 中高／中／中／MCP；P1 可核验副作用回执 高／高／高／工具适配器。
- **限制**：规范化拒绝是输入门禁，不解决目录被并发替换、mount namespace、文件系统持久化或 exactly-once。未运行测试、编译、脚本或 CI。


## 2026-11-21 — P0 Linux claim 目录句柄最终关闭失败的错误归一化（仅静态审查）

- **仓库事实**：Node/Bun claim 仍未接入真实工具派发；最终目录 fd 关闭失败可能绕过统一 `ClaimUnavailable` 失败语义。本轮仅修复最终关闭错误归一化，保留 unknown，不做自动重放。
- **公开反馈事实**：2026-11-20 [Codex #62853](https://github.com/openai/codex/issues/62853) 报告执行环境断开后的交付不确定；2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 报告重复返工。均为外部个案，不证明 Angel 故障或总体频率。**工程推断**：操作状态失败关闭应比异常类型细节更稳定。
- **优先级（价值/难度/安全风险/依赖）**：本项 P0 中/低/低/Node fs（已提交待测试）；Linux procfs 挂载竞态 P0 高/高/高/Linux namespace；Windows reparse 句柄 P0 高/高/高/Windows API；真实工具派发 P0 高/高/高/审批及持久状态；MCP 目录变化 P1 中高/中/中/MCP；外部副作用回执 P1 高/高/高/适配器。
## 2026-11-21 — P0 claim 异常路径单次关闭（静态检查，待测试）

- **仓库事实**：实验性 `scripts/node_tool_claim.ts` 在写入/文件 fsync 失败时，catch 先关闭 `directoryFd`，finally 又尝试关闭同一目录 fd；文件关闭失败时还可能重复关闭。重复关闭可能抛出额外异常并遮蔽原本的 unknown 结果，且在 fd 编号复用时存在误关风险。本轮改为先标记失败、始终尝试关闭 claim 文件，仅在失败路径关闭目录一次；成功路径仍保持目录 fd 到目录 fsync 和名称复核完成。未接入运行时。
- **外部事实**：[Codex #62853](https://github.com/openai/codex/issues/62853)，2026-11-20，用户报告执行环境断开后无可验证交付；[Codex #60104](https://github.com/openai/codex/issues/60104)，2026-11-07，用户报告长任务重复返工。二者为公开用户个案，非 Angel 故障复现或发生频率统计。**工程推断**：异常路径应保持 unknown、拒绝自动重放并尽可能可靠释放资源。
- **候选优先级（价值／难度／安全风险／依赖）**：本项 P0 高／低／低／Node fs（已提交，待测试）；P0 procfs 挂载竞态及异常路径审查 高／高／高／Linux mount namespace；P0 Windows reparse 句柄保护 高／高／高／Windows 原生 API；P0 claim 接入真实工具派发 高／高／高／可信持久状态和审批；P1 MCP 动态工具目录检测 中高／中／中／MCP；P1 可信副作用回执 高／高／高／外部适配器。
- **限制**：没有运行测试、编译、故障注入或 CI；文件关闭/目录关闭失败仍可能意味着 unknown；本次不是 exactly-once 保障。


- **仓库事实**：Linux 实验性 claim 在文件写入后通过 `finally { closeSync(fd) }` 关闭文件；若 close 抛错，后续目录 fsync 前会退出并遗留打开的 directoryFd。本轮在该异常分支尝试关闭目录 fd 并统一抛 `ClaimUnavailable`，正常路径仍保留目录 fd 至同步结束。未接入实际 Node 派发。
- **外部反馈（事实）**：[Codex #62853](https://github.com/openai/codex/issues/62853)（2026-11-20）报告执行环境断线与交付状态不确定；[Codex #60104](https://github.com/openai/codex/issues/60104)（2026-11-07）报告重复返工和额度浪费。外部个案，不是 Angel 故障或频率统计。**工程推断**：异常路径应释放资源并维持 unknown，不得自动重放。
- **候选排序（价值／难度／风险／依赖）**：本项 P0 中／低／低／无（已提交待测试）；P0 procfs 挂载竞态 高／高／高／Linux namespace；P0 Windows reparse 句柄保护 高／高／高／Windows API；P0 claim 真实派发集成 高／高／高／安全存储与审批；P1 MCP 目录变化 中高／中／中／MCP；P1 可信外部副作用回执 高／高／高／适配器。
- **边界**：只修复文件 close 抛错后的目录 fd 清理，不保证目录 close 自身成功，也不证明文件持久化、外部 exactly-once。仅静态检查。

## 2026-11-21 — P0 Node claim close 异常资源清理（仅静态）

- **仓库事实**：实验性 `scripts/node_tool_claim.ts` 原先只校验 operationId，directory 在 JavaScript 调用边界可能是非字符串、空字符串或含 NUL 的值；这些值进入 `isAbsolute`/`resolve`/文件系统 API 时会产生不一致的原生异常。本轮在任何目录预检前统一拒绝这三类输入，返回 `ClaimUnavailable`，合法绝对路径的后续安全检查保持不变；组件未接入真实 Node 派发。
- **外部反馈（事实）**：2026-11-20 [Codex #62853](https://github.com/openai/codex/issues/62853) 报告执行环境断开后交付状态不确定；2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 报告重复返工与用量浪费。均为外部个案，非 Angel 缺陷或频率统计。**工程推断**：持久操作标识的输入错误应一致失败关闭，避免调用方误判状态。
- **候选排序（价值／难度／安全风险／依赖）**：本项 P0 中／低／低／无（已提交，待测试）；P0 procfs 挂载竞态与异常路径验证 高／高／高／Linux；P0 Windows reparse 句柄防护 高／高／高／Windows API；P0 真实 Node 派发集成 高／高／高／可信 claim 与审批；P1 MCP 工具目录变化检测 中高／中／中／MCP；P1 可信外部副作用回执 高／高／高／工具适配器。
- **验证限制**：仅源码静态检查，未执行测试、编译、脚本或 CI；不提供 exactly-once 保证。

## 2026-11-21 — P0 Linux procfs 文件系统类型门禁（仅静态审阅）

- **仓库事实**：实验性 Node claim 依赖 `/proc/self/fd/<fd>`，此前未检查该路径是否位于真正的 Linux procfs。本轮在打开 claim 目录前调用 Node 标准库 `statfsSync("/proc/self/fd")`，要求 `type === 0x9fa0`（Linux PROC_SUPER_MAGIC）；异常或不匹配即失败关闭，不执行 claim 创建。组件仍未接入真实 Node 派发。main 于 2026-11-20 23:32 UTC 的 [9230072](https://github.com/js2005happy/nyra/commit/9230072d35fcb32e6ffff6b160c0b10749dc4415) 是沙箱 CI 修复，非重复实现；开放 Issues/PR 检索为空。
- **外部反馈（事实）**：[Codex #62853](https://github.com/openai/codex/issues/62853)（2026-11-20）报告断线/超时后交付不确定；[Codex #60104](https://github.com/openai/codex/issues/60104)（2026-11-07）报告重复返工及用量浪费。两者是外部个案，非 Angel 复现或频率统计。**工程推断**：在重试机制之前应加强持久操作标识的存储可信边界。
- **候选排序（价值／难度／安全风险／依赖）**：本项 P0 高／低／低／Linux statfs（已提交、待测试）；P0 procfs 挂载竞态与异常路径验证 高／高／高／Linux mount namespace；P0 Windows reparse 原生句柄保护 高／高／高／Windows API；P0 真实 Node 工具派发集成 高／高／高／安全存储与审批；P1 MCP 工具目录变化检测 中高／中／中／MCP；P1 外部副作用可信回执 高／高／高／适配器。
- **边界**：文件系统类型检查不锁定 mount namespace，不能证明 /proc/self/fd 在检查后不被替换，不能防范具有 mount 权限的攻击者；未运行测试、编译或 CI，不保证 exactly-once。

## 2026-11-21 — P0 Linux claim 名称复核绑定同一目录 fd（仅静态）

- **仓库事实**：此前排他创建通过 `/proc/self/fd/<directoryFd>/...`，但写入后和目录 fsync 后的名称核对仍调用 `lstatSync(join(directory, filename))`，会重新解析原始路径。本轮两个核对点均改为同一已打开目录 fd 下的 procfs 路径，减少目录改名时检查错误对象的风险；不改变 claim 文件格式、工具派发或默认关闭策略。
- **外部事实（2026-11-20 22:35 UTC）**：[Codex #62853](https://github.com/openai/codex/issues/62853) 用户报告 Windows 桌面执行环境断开、恢复超时、未交付产物却消耗额度。此为外部个案，非 Angel 故障或频率统计。**工程推断**：操作持久状态必须与可验证执行证据区分，unknown 不得自动重放。
- **优先级（价值／难度／安全风险／依赖）**：本项 P0 高／低／低／Linux procfs（已提交待测试）；P0 procfs 可信挂载与异常路径验证 高／中／高／Linux；P0 Windows reparse 句柄保护 高／高／高／原生 API；P0 Node 派发集成 高／高／高／可信 claim；P1 MCP 目录变化检测 中高／中／中／协议；P1 可信副作用回执 高／高／高／适配器。
- **限制**：路径祖先和 procfs 挂载信任未获运行时验证，复核不是防篡改事务；未运行测试/编译/CI，不能保证 exactly-once。

## 2026-11-21 — P0 Linux claim 同一目录 fd 持久化（静态审阅）

- **仓库事实**：原实现以已打开目录 fd 创建 claim 后立即关闭该 fd，再按路径重新打开目录进行 fsync；路径被替换时可能同步错误目录。本轮保持原 fd 直到 fsync 与最终名称核对结束；失败关闭且不自动删除或重放。组件仍未接入 Node 主运行时。
- **外部反馈（2026-10-04）**：[Codex #50771](https://github.com/openai/codex/issues/50771) 报告 Agent 在工作尚未完成时结束并要求反复继续；[Codex #40646](https://github.com/openai/codex/issues/40646)（2026-08-25）报告执行声明与工具轨迹不符。均为用户报告，不是 Angel 复现或频率统计。**工程推断**：需要可靠的持久状态与独立验证，不能以声明替代效果证明。
- **优先级（价值／难度／安全风险／依赖）**：本项 P0 高／低／中／Linux procfs（已提交，待测试）；P0 procfs 可信挂载与故障注入 高／中／高／Linux 环境；P0 Windows reparse 防护 高／高／高／原生句柄 API；P0 真实 Node 派发集成 高／高／高／可信 claim；P1 MCP 目录变化检测 中高／中／中／协议；P1 外部副作用回执 高／高／高／工具适配器。
- **限制**：路径名称检查仍有竞态，未验证 procfs、持久化或文件系统行为；未运行测试、编译或 CI，不保证 exactly-once。

## 2026-11-21 — P0 Linux 目录 fd 绑定排他创建（仅静态审阅）

- **仓库事实**：此前 Node claim 在检查目录 fd 后关闭句柄，再按原路径 O_EXCL 创建，存在路径替换竞态。本轮 Linux 上改用保持打开的目录 fd 与 `/proc/self/fd/<fd>/<hash>.claim` 路径执行 O_EXCL|O_NOFOLLOW；非 Linux 平台拒绝使用该实验性原语，避免不安全回退。该组件仍未接入真实 Node 工具派发。
- **外部用户反馈（2026-11-07）**：[Codex #60104](https://github.com/openai/codex/issues/60104) 报告长任务重复返工及用量浪费。这是个案而非频率统计，也不是 Angel 故障证据。**工程推断**：可靠操作所有权应优先于自动恢复和重复执行。
- **候选排序（价值／难度／安全风险／依赖）**：本项 P0（高／中／中／Linux procfs，已提交待验证）；P0 Linux procfs 身份/挂载边界及故障注入审查（高／中／高／可信运行环境）；P0 Windows 原生 reparse 句柄保护（高／高／高／原生 API）；P0 接入真实 Node 工具派发（高／高／高／安全存储与审批）；P1 MCP 工具目录失效检测（中高／中／中／MCP）；P1 可信副作用回执（高／高／高／适配器）。
- **限制**：procfs 路径不是跨平台 openat API；未验证挂载真实性、跨命名空间及网络文件系统语义。未运行编译、测试、脚本或 CI，不能宣称 exactly-once 或生产可用。

## 2026-11-21 — P0 claim 操作 ID 运行时类型校验（仅静态审阅）

- **仓库事实**：Node 实验性 claim 的 `RegExp.test(operationId)` 会对非字符串输入做 JavaScript 隐式字符串转换，尽管 TypeScript 参数声明为 `string`；跨 JS/JSON 调用边界可传入数字、数组或对象，导致不同输入别名到同一字符串操作 ID。已增加 `typeof operationId === "string"` 的失败关闭门禁；没有改动持久格式、派发链或现有合法字符串行为。
- **外部事实**：2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 报告长任务重复返工；2026-10-07 [Codex #49743](https://github.com/openai/codex/issues/49743) 报告重复投递。这些是外部个案，不证明 Angel 故障率。**工程推断**：执行标识应在进入持久化前避免隐式类型转换，减少歧义。
- **排序（价值／难度／安全风险／依赖）**：本项 P0（中／低／低／无，已提交，未测试）；P0 真正目录句柄相对原子创建（高／高／高／原生 openat）；P0 Windows reparse 句柄防护（高／高／高／原生 API）；P0 Node 派发集成（高／高／高／可信 claim）；P1 MCP 动态目录失效检测（中高／中／中／协议）；P1 可信副作用回执（高／高／高／适配器）。没有将重复用户反馈误称为统计高频。
- **验证边界**：仅静态核对，未运行测试、编译或 CI；Windows 仍失败关闭，claim 未接入真实工具派发，不提供 exactly-once。

## 2026-11-21 — P0 claim 目录同步后文件名复核（静态审阅）

- **仓库事实**：`scripts/node_tool_claim.ts` 原先只在文件 fsync 后核对 claim 名称，目录 fsync 后没有再次核对同一名称；仍未接入真实 Node 工具派发。main 最近检索提交 [e240b5e](https://github.com/js2005happy/nyra/commit/e240b5e33df5d9dbfb613fdb83cdca798e91fb4c)（2026-11-20 17:27 UTC）为 Office 导出，不重复本项；开放 Issues/PR 为空，CI 未返回状态或运行记录。
- **外部事实**：[Codex #60104](https://github.com/openai/codex/issues/60104)（2026-11-07）用户报告长任务反复返工、浪费额度及进度失真；[Codex #40646](https://github.com/openai/codex/issues/40646)（2026-08-25）报告执行声明与工具轨迹不一致。**工程推断**：副作用所有权需要与可核查的持久证据绑定；这些个案不证明 Angel 存在同样故障或统计高频。
- **本轮单项增量**：保存 fsync 后已核验的 claim inode 身份，目录 fsync 完成后再次核对路径指向同一普通文件、单硬链接、当前 UID、私有权限与长度。价值高／难度低／安全风险低／依赖现有 POSIX 元数据；检查后仍有 TOCTOU，非 exactly-once。
- **后续排序（价值／难度／风险／依赖）**：P0 真正目录句柄相对原子创建（高／高／高／原生 openat）；P0 Windows reparse 防护（高／高／高／原生句柄 API）；P0 真实工具派发集成（高／高／高／可信 claim）；P1 MCP 目录失效检测（中高／中／中／协议）；P1 可信副作用回执（高／高／高／适配器）。未运行编译、测试、脚本或 CI。

## 2026-11-21 — P0 Node claim 文件身份与私有性复核（仅静态）

- **仓库事实**：开发分支 `scripts/node_tool_claim.ts` 原先仅在写入前以 O_EXCL 排他创建，fsync 后未核对文件名是否仍指向所写入的 inode、文件类型、链接数、所有者、权限及长度。主分支最新检索提交 [e240b5e](https://github.com/js2005happy/nyra/commit/e240b5e33df5d9dbfb613fdb83cdca798e91fb4c)（2026-11-20 17:27 UTC）为 Office 直出功能，不重复此项；开放 Issues/PR 查询为空。
- **外部反馈（事实）**：[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07，重复投递个案）、[Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19，安全等待/恢复请求）。**工程推断**：本地持久操作记录被替换或篡改时应失败关闭；外部个案不证明 Angel 复现或统计高频。
- **本轮单项增量**：fsync 后以 fstat/lstat 对照 claim 文件 dev/ino、普通文件、单硬链接、当前 UID、私有权限与字节长度；不满足时拒绝报告成功，不删除文件。价值高／难度低／安全风险低／依赖 POSIX 文件元数据；仍存在复核后的路径替换竞态。
- **后续排序（价值／难度／安全风险／依赖）**：P0 真正目录句柄相对原子创建（高／高／高／openat 或可信原生桥）；P0 Windows reparse 句柄级防护（高／高／高／原生 API）；P0 Node 真实派发集成（高／高／高／可信 claim）；P1 MCP 目录变化检测（中高／中／中／协议）；P1 可信副作用回执（高／高／高／工具适配器）。静态审阅，未运行测试/CI；不保证 exactly-once。

## 2026-11-21 — P0 Node claim 祖先目录可写性门禁（仅静态）

- **仓库事实**：开发分支的 `scripts/node_tool_claim.ts` 先前只要求叶目录私有，祖先目录仅检查类型和 symlink；可被其他用户写入的祖先可能在路径创建期间被替换。该组件尚未接入 main 的 Node 工具派发。
- **外部反馈（事实）**：[Codex #62480](https://github.com/openai/codex/issues/62480)（2026-11，Windows attach/restart 后在途进程状态不明、重试风险；用户报告，非 Angel 故障复现）。**工程推断**：应优先建立可信操作身份及 unknown 语义，再考虑安全恢复。
- **本轮增量**：POSIX 拒绝 group/other 可写祖先（含 sticky 目录），要求祖先归当前 UID 或 root 所有，叶目录必须当前 UID 所有且 0700 级私有。价值高／难度低／风险低／依赖 POSIX 文件系统元数据；对共享 /tmp 路径采取失败关闭，可能影响既有使用方式。
- **后续排序**：P0 真正的目录句柄相对原子创建（价值高／难度高／风险高／依赖原生 API）；P0 Windows reparse 句柄防护（高／高／高／原生 API）；P0 Node 工具派发集成（高／高／高／可信 claim）；P1 MCP 工具目录失效检测（中高／中／中／MCP）；P1 副作用回执（高／高／高／工具适配器）。仍有祖先 TOCTOU，未运行测试或 CI。

## 2026-11-20 — P0 claim 创建前后目录身份一致性（静态审阅）

- **仓库事实**：此前 claim 在文件创建后才用目录 fd 核验身份；本轮增加创建前 `O_DIRECTORY|O_NOFOLLOW` 打开、`fstat/lstat` 身份校验，并在创建后核验相同 dev/ino。主分支 [f35de0d](https://github.com/js2005happy/nyra/commit/f35de0dc53e9a3aeb071406803cc0695f5b806ae)（2026-11-20 15:28 UTC）涉及 repo-map 缓存与 LSP hover，不重复此项；开放 Issues/PR 检索为空。
- **外部事实**：[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07，重复投递个案）、[Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19，安全恢复请求）。**工程推断**：持久操作所有权有助于降低重复副作用风险；不证明 Angel 复现或这些问题高频。
- **排序（价值／难度／安全风险／依赖）**：P0 真正的目录相对原子创建 openat 等价实现（高／高／高／OS API）；P0 Windows reparse 句柄支持（高／高／高／原生 API）；P0 真实派发集成（高／高／高／可信存储）；P1 MCP 目录版本（中高／中／中／协议）；P1 外部回执（高／高／高／适配器）。本轮仅检测替换，仍存在检查到创建之间的竞态，未运行测试。

## 2026-11-20 — P0 claim 目录句柄与路径身份复核（单项增量）

- **仓库事实**：开发分支 Node claim 仅在创建前预检目录，写入后对目录路径直接重新打开并 fsync，缺少打开句柄与路径对象身份对照。main 最新检索提交 [b53a9c5](https://github.com/js2005happy/nyra/commit/b53a9c5beace9c2d048a5809a247bf2bc1b7916f)（2026-11-20 14:17 UTC）为多 Agent 时间线/回放，不重复本项；开放 Issues/PR 查询为空。
- **本轮 P0（价值高／难度低／风险中／依赖 POSIX 目录 fd）**：目录 fsync 阶段以 O_DIRECTORY|O_NOFOLLOW 打开，fstat 与路径 lstat 比较设备/ inode、所有者和私有权限，并在 fsync 后再次检查路径身份；任何失败拒绝报告 claim 成功。未改变 Windows 默认拒绝行为。仍无法消除祖先目录替换、预检与创建间竞态，且不支持网络文件系统的强保证。
- **外部事实**：[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07）用户报告重复投递；[Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19）请求安全等待与恢复。**工程推断**：应在真实派发前建立可信操作身份，外部报告不证明本仓库复现。
- **后续排序（价值／难度／安全风险／依赖）**：P0 POSIX 目录创建时稳定 fd 绑定（高／高／高／文件系统）；P0 Windows reparse 句柄级支持（高／高／高／原生 API）；P0 Node 派发集成（高／高／高／可信 claim）；P1 MCP 工具目录版本（中高／中／中／协议）；P1 可信副作用回执（高／高／高／适配器）。仅静态审阅，未运行测试、编译或 CI。

## 2026-11-20 — P0 Windows claim 门禁源码修复（单项增量）

- **仓库事实**：前次 Windows fail-closed 改动把换行写成字面量 `\\n`，导致 `if (process.platform === "win32")` 与绝对路径校验落在 `//` 注释同一源码行，未实际生效；本轮修复为真实换行。此为静态源码缺陷，不是运行时复现。
- **外部反馈**：[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07，重复投递个案）及 [Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19，安全恢复请求）。**事实**为外部报告；**推断**为本地 claim 必须先具备可执行的失败关闭门禁才能作为安全续跑的前置组件，不能推断 Angel 已发生相同事故。
- **优先级（价值／难度／风险／依赖）**：本轮 P0 修复失效门禁（高／低／低／现有 claim）；后续 P0 POSIX 稳定目录句柄（高／高／高／OS API）；P0 Windows 句柄级 reparse 防护（高／高／高／Windows API）；P0 真实 Node 派发集成（高／高／高／上述可信存储）；P1 MCP 目录变化检测（中高／中／中／MCP）；P1 副作用凭证（高／高／高／适配器）。仅静态审阅，未运行测试。

## 2026-11-20 — P0 Windows claim reparse 安全边界（单项增量）

- **仓库事实**：`scripts/node_tool_claim.ts` 原先在 Windows 上使用 `lstatSync` 路径预检，但未建立稳定目录句柄，无法可靠排除 junction/reparse 重定向。2026-11-20 主分支近期 [0b79890](https://github.com/js2005happy/nyra/commit/0b79890c72030517a18c64f8ed5bcf2860055f17) 增加 Shopify 只读连接器，不涉及 claim 安全；本轮 GitHub 搜索开放 Issues/PR 均为空。
- **本轮 P0**（价值高／难度低／安全风险低／依赖 Windows 原生目录句柄能力）：在 Windows 上直接拒绝 claim，避免把不完整路径预检当成可信原子所有权；POSIX 原行为不变，仍未接入执行器。
- **外部需求证据**：[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07，重复投递个案）和 [Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19，安全等待/恢复请求）。**事实**：外部用户反馈；**推断**：可信持久 claim 应先于自动恢复，不能据此证明 Angel 复现问题。
- **后续排序（价值／难度／风险／依赖）**：P0 Windows 句柄级 reparse 检查（高／高／高／Windows API）；P0 POSIX 目录句柄及祖先竞态约束（高／高／高／文件系统语义）；P0 真实 Node 工具派发集成（高／高／高／前两项）；P1 MCP 目录变化检测（中高／中／中／MCP）；P1 可信副作用回执（高／高／高／适配器）。仅静态审阅，未运行测试或 CI。

## 2026-11-20 — P0 claim 存储目录预检（静态，未接入执行器）

- **事实**：当前开发分支 `scripts/node_tool_claim.ts` 原先只检查叶目录不是符号链接，未拒绝可解析的符号链接祖先或 POSIX 共享目录。main 最近提交 [0856b0d](https://github.com/js2005happy/nyra/commit/0856b0d8c3f4ffcb7059b793d731a6785bae3dc9)（2026-11-20 11:37 UTC）涉及 Bot 通知及附件处理，不是跨进程工具 claim；开放 Issues/PR 搜索为空。
- **本轮单项增量**：要求绝对 claim 目录，逐层 lstat 拒绝符号链接/非目录，POSIX 叶目录要求当前进程所有且无 group/other 权限；不自动创建或修改目录。价值高／难度低／风险中／依赖可信 OS 账户和本地文件系统。
- **安全限制**：仅预检；Windows junction/reparse point 的完整识别、目录句柄绑定、祖先并发替换、fsync 可移植性、真实 Node 派发集成仍未完成。绝不宣称已实现 exactly-once。
- **公开证据**：[Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19，用户请求安全等待恢复）；[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07，重复投递报告）。事实为外部个案；**推断**为可靠恢复应先建立可信持久操作所有权，不是 Angel 已复现缺陷。
- **后续排序（价值／难度／风险／依赖）**：P0 稳定目录句柄与 Windows reparse 防护（高／高／高／OS 语义）；P0 Node 派发集成（高／高／高／稳定 claim）；P1 MCP 工具目录版本检测（中高／中／中／MCP）；P1 可信副作用回执（高／高／高／工具适配器）；P2 人工对账恢复（高／高／高／P0）。未运行测试、编译或 CI。

## 2026-11-20 — Node 原子 claim 前置增量（未接入运行时）

- **仓库事实**：2026-11-20 10:31 UTC main 最近提交 [b345eb5](https://github.com/js2005happy/nyra/commit/b345eb5ded215048e6f281dd0bc4af94e6d7ea48) 涉及 Telegram Bot 会话队列、去重和只读执行；这不是工具执行副作用的跨进程事务保证。开放 Issues/PR 查询为空。开发分支仍为 Python Angel，main 为 Bun/TypeScript Nyra。
- **本轮实现（P0 前置；价值高／难度中／风险中／依赖可信本地目录）**：新增独立 `scripts/node_tool_claim.ts`，使用 Node 内置 fs/crypto、O_EXCL 文件占用、文件 fsync 和目录 fsync；同一 operationId 的重复 claim 拒绝，崩溃或不完整写入不得自动清除、重试。未接入 main 的 src/agent.ts / src/tools.ts，**不能宣称运行时已获得互斥**。Windows/网络文件系统目录 fsync 可能不可用，必须失败关闭，需进一步评估安全目录句柄和祖先路径竞态。
- **公开需求证据**：[Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19）用户请求安全等待/恢复；[Codex #49743](https://github.com/openai/codex/issues/49743)（2026-10-07）用户报告重复投递。**推断**：安全续跑需要可持久化 operationId 和人工对账；外部个案不能证明本仓库存在同一故障或统计高频。
- **排序（价值／难度／安全风险／依赖）**：P0 可信目录及跨平台原子 claim 集成（高／高／高／真实派发链、锁目录和崩溃对账）；P1 MCP 目录失效检测（中高／中／中／工具版本）；P1 独立副作用回执（高／高／高／工具适配器）；P1 结构化拒绝原因（高／中／中／审批链）；P2 人工审批安全续跑（高／高／高／P0）。未运行测试、解释器或 CI。

## 2026-11-20 — 静态审计 v6：单次源码快照与指纹

- **仓库事实**：v5 对同一文件分别读取状态和锚点，存在审计期间源码改变而混用版本的可能。主分支最新检索提交 [9021f99](https://github.com/js2005happy/nyra/commit/9021f9986d349b9e4723e44a942ac934248334b1)（2026-11-20 08:36 UTC）涉及安装包；开放 Issues/PR 检索为空。
- **本轮实现（价值中／难度低／风险低／依赖 v5）**：每个路径读取一次有界快照，状态、锚点行号和 SHA-256 从相同内容计算；JSON schema v6。指纹不证明 Git 版本或动态执行安全。未运行测试。
- **外部事实**：[Codex #49743](https://github.com/openai/codex/issues/49743) 2026-10-07 用户报告 Windows 消息队列延迟重复投递；[Codex #40646](https://github.com/openai/codex/issues/40646) 2026-08-25 报告长任务声明与执行记录不一致。**工程推断**：可靠执行证据应绑定输入版本与持久操作 ID；外部个案不能证明 Nyra 存在同样问题或推算发生率。
- **排序（价值／难度／安全风险／依赖）**：P0 Node 原子执行所有权（高／高／高／真实派发及崩溃对账）；P1 独立副作用凭证（高／高／高／工具适配器）；P1 MCP 目录失效检测（中高／中／中／版本）；P1 权限拒绝结构化（高／中／中／审批）；P2 安全续跑（高／高／高／P0）。

## 2026-11-20 — P0 静态审计必需文件完整性 v5

- **仓库事实（静态审阅）**：v4 只要求 Node 文本锚点命中；开发分支 `angel/__main__.py` 或 `angel/tool_journal.py` 缺失时仍可能输出 `audit_incomplete=false`，而分支差异不成立时也可能出现退出码 2 与 JSON 完整性标志矛盾。此处是审计工具自身缺口，不是 Node 运行时漏洞证明。
- **本轮增量（价值中高／难度低／安全风险低／依赖 v4）**：v5 明确开发分支 Python 入口、Agent、Journal 与 main Node manifest、CLI、Agent、Tools、Gateway、Memory 均为必需文件；`missing_required_files` 列出缺失或不可读项，`audit_incomplete` 与非零退出条件统一。仅静态修改，未运行脚本或测试。
- **外部用户需求证据（2026-11-19）**：[Codex #62611](https://github.com/openai/codex/issues/62611) 请求等待和安全恢复；这是外部单例反馈。**工程推断**：可靠恢复需要完整入口清单和真实执行所有权，不能由静态审计推导安全恢复能力。
- **候选排序（价值／难度／安全风险／依赖）**：P0 Node 跨进程原子所有权（高／高／高／真实派发、持久化、崩溃对账）；P1 MCP 目录失效检测（中高／中／中／协议版本）；P1 可信副作用凭证（高／高／高／适配器）；P1 结构化权限拒绝（高／中／中／审批路径）；P2 安全续跑（高／高／高／P0 与审批）。main 最新检索提交 [dbc3254](https://github.com/js2005happy/nyra/commit/dbc32547aa8abd39c6e22a7c898d504411bb685e)（2026-11-20 07:24 UTC）为 0.5.2 版本更新，未重复实现；开放 Issues/PR 查询为空。

## 2026-11-20 — P0 静态审计缺失锚点失败关闭（v4）

- **事实（仓库静态审阅）**：主分支 `src/agent.ts` 存在 `executeTool`、`executeToolIdempotent` 调用及工具结果追加与 `saveSession`；`src/gateway.ts` 具有交互和调度调用入口。主分支最新检索提交 [39084ea](https://github.com/js2005happy/nyra/commit/39084ea7311aed1aabad0feb57997a393d0bb386)（2026-11-20 06:12 UTC）主要修改 TUI，未直接解决跨进程执行所有权。开放 Issue/PR 检索为空。
- **本轮增量（价值高／难度低／风险低）**：审计脚本 v4 要求主分支所有 Node 静态锚点均可读取且至少命中一行；新增 `missing_node_anchors`，缺失时 `audit_incomplete=true` 并非零退出。避免源码重构后旧文本探针静默失效。未运行脚本或测试；这仍不是动态控制流证明。
- **外部反馈（2026-11-20 检索）**：[Codex #62681](https://github.com/openai/codex/issues/62681) 报告 Windows 上 MCP 工具目录变更后未刷新（报告中的协议/版本细节未经本项目复现）。**推断**：工具目录变化时需要版本感知和明确的过期状态；与本轮静态锚点失败关闭同属防止静默过期，但不证明 Nyra 存在此问题。
- **候选排序（价值／难度／安全风险／依赖）**：P0 主运行时执行所有权（高／高／高／全部真实入口与崩溃对账）；P1 工具目录变更检测（中高／中／中／MCP 版本协商与订阅）；P1 可信副作用凭证（高／高／高／工具适配器）；P1 权限拒绝结构化（高／中／中／审批路径）；P2 等待与安全续跑（高／高／高／所有权及人工审批）。

## 2026-11-20 — P0 Node 派发与持久化静态锚点（本轮）

- **仓库事实（2026-11-20）**：main 的 `src/agent.ts` 在工具结果写入消息数组后调用 `saveSession(this.sessionId, messages.slice(1), this.home)`；`src/gateway.ts` 的会话消息入口调用 `run.agent!.run(text)`，调度任务调用 `agent.run(task.prompt)`；`src/tools.ts` 包含 `executeTool` 与 `executeToolIdempotent`。静态审阅不证明所有路径均经过相同审批或持久化边界。
- **已实现（高价值／低难度／低风险）**：审计脚本 v3 增加 gateway、memory 文件状态与上述派发/结果落盘源码行号锚点；只读、不执行目标程序、不增加依赖。未运行脚本或测试。
- **外部用户反馈（2026-11-19）**：[Codex #62611](https://github.com/openai/codex/issues/62611) 请求等待和安全恢复；**事实**为单例反馈，**推断**为恢复前必须能追踪派发及结果落盘，不能据此认定 Nyra 存在相同故障或行业发生率。
- **后续排序（价值／难度／风险／依赖）**：P0 完整动态派发边界与跨进程原子所有权（高／高／高／gateway、CLI、调度及副作用核对）；P1 可信副作用回执（高／高／高／适配器）；P1 权限拒绝结构化（高／中／中／审批链）；P2 安全等待续跑（高／高／高／所有权与人工对账）；P2 预算硬停止（高／中／中／可信用量）。
- **限制**：字符串锚点可能漏掉别名、动态调用、其他入口及竞态；不能宣称已实现锁或安全恢复。

## 2026-11-20 — P0 静态审计证据可追溯性（本轮）

- **仓库事实（2026-11-20）**：main 的 `package.json` 通过 `src/cli.ts` 构建 Bun CLI；`src/agent.ts` 导入 `executeTool`/`executeToolIdempotent`，`src/tools.ts` 明确 Python worker 已移除。开发分支仍是独立 Python Angel；开放 Issue/PR 搜索为空。main 最新查阅提交 [5539340](https://github.com/js2005happy/nyra/commit/553934084a7775cf30cb5caac7c16ed16e06dbbf)（2026-11-20 04:38 UTC）修改桌面端 API，未与本轮静态审计重复。
- **已实现（价值高／难度低／风险低）**：升级 `scripts/audit_runtime_boundary.py` JSON schema v2，给出每项静态引用的行号（最多 30 条）、文件状态（missing/symlink/oversize/unreadable/ok）和审计不完整标记；拒绝把读取失败当作源码不存在。限制单文件 2 MiB，不运行目标代码。尚未运行测试。
- **公开反馈（2026-11-19）**：[Codex #62611](https://github.com/openai/codex/issues/62611) 用户请求等待与安全恢复。**事实**：这是外部单例需求；**推断**：可复核的派发入口证据应先于跨进程锁和恢复承诺，不代表 Angel 已复现故障。
- **后续排序（价值／难度／安全风险／依赖）**：P0 Node 多入口与结果持久化全链审计（高／中／低／主分支源码）；P0 原子执行所有权与崩溃 unknown（高／高／高／全入口审计及跨平台锁）；P1 权限拒绝结构化（高／中／中／审批路径）；P1 副作用凭证（高／高／高／可信适配器）；P2 事件等待与安全续跑（高／高／高／所有权、审批）；P2 成本硬停止（高／中／中／可信 usage）。
- **边界**：文本命中和行号不是动态调用证明；文件读取检查也不是抵抗恶意本地文件系统竞争的安全边界。未运行测试/CI，不合并、不发布。

## 2026-11-20 — P0 前置：可复核的跨运行时静态清单

- **本仓库事实**：开发分支包含 Python `angel/agent.py` 与 `angel/tool_journal.py`，缺少 Node `src/agent.ts`；主分支 Node `src/agent.ts` 静态引用 `executeTool`、`executeToolIdempotent`，并在 `src/tools.ts` 定义执行入口。开发分支的 Python 日志保护不能自动外推至 Node。
- **已实现（价值高／难度低／风险低）**：新增标准库只读 `scripts/audit_runtime_boundary.py`，对两个本地工作树输出 JSON 入口存在性、源码文本引用、分叉标志；不执行目标代码，不修改文件，不能证明完整调用图。仅静态审查，未运行。
- **外部用户反馈（2026-11-19）**：[Codex #62611](https://github.com/openai/codex/issues/62611) 请求长等待安全恢复；这是用户个案而非本仓库缺陷或行业频率统计。**工程推断**：安全恢复先依赖可信派发边界和原子所有权。
- **后续排序（价值／难度／安全风险／依赖）**：P0 Node 全入口/结果落盘路径审计（高／中／低／静态源码）；P0 跨进程原子执行所有权与崩溃 unknown（高／高／高／全入口、跨平台锁）；P1 权限拒绝结构化（高／中／中／审批路径）；P1 独立副作用凭证（高／高／高／可信适配器）；P2 事件驱动等待和安全续跑（高／高／高／所有权与审批）；P2 成本硬停止（高／中／中／可信用量）。
- **限制**：开发分支没有 Node 源码，无法在此分支直接、安全地为 main Node 执行器增加原子锁；不得宣称本轮已解决工具并发安全。未运行测试、安装、CI、合并或发布。

## 2026-11-20 — P0 运行时派发链定位（静态证据，尚未改动执行器）

- **仓库事实（2026-11-20）**：`js2005happy/angel` 重定向至 `js2005happy/nyra`；开发分支仍是 Python `angel/agent.py` → `angel/tool_journal.py`（显式可选），而 main 的 `package.json` 以 `src/cli.ts` 为构建入口，`src/agent.ts` 导入 `executeTool`/`executeToolIdempotent`，`src/tools.ts` 定义工具执行及审批。main 的 `src/tools.ts` 注释明确“worker 桥与 Python 运行时已移除”。**这是源码路径归属证据，不是运行时动态调用验证**。
- **近期变更（事实）**：[main 8d48371](https://github.com/js2005happy/nyra/commit/8d4837107411a1c7a87ef6e291577bf8c61f533f)（2026-11-20 02:38 UTC）已经新增 JSON 出口统一契约测试；[PR #105](https://github.com/js2005happy/nyra/pull/105) 当前开放，正在覆盖任务→工具→落盘→结论端到端链路。避免重复开发这两项。开放 Issue 搜索为空；提交状态接口返回空列表，**不能推断 CI 通过**。
- **公开用户需求证据**：PR #105（2026-11-20 检索时开放）描述“模型声称写文件”与“文件实际存在”的验收差距；这是项目维护者的工程需求陈述，**不是独立用户调查或行业频率证据**。另参考 [Codex #62611](https://github.com/openai/codex/issues/62611)（2026-11-19），用户请求等待/恢复可观察性，属于外部个案。
- **工程推断 / 候选排序（价值／难度／安全风险／依赖）**：P0 明确 Node 工具派发到结果持久化的完整路径与并发所有权边界（高／中／低／只读源码）；P0 Node 运行时原子所有权和崩溃 unknown 处理（高／高／高／前项、跨平台锁）；P1 拒绝原因结构化（高／中／中／权限路径）；P1 副作用回执（高／高／高／适配器）；P2 等待与审批续跑（高／高／高／所有权）；P2 预算硬停止（高／中／中／可信用量）。
- **本轮决定**：Python 分支与 Node main 的执行路径不相通，不能在 Python 上增加检查后宣称保护 Node。虽然已定位 Node 入口文件，尚未完整审计 `executeToolIdempotent`、后台网关及崩溃落盘协议；在禁止运行测试的约束下，不安全地改变派发语义不符合范围清楚的增量要求。先保留阻塞，不自动重放未知工具结果。

## 2026-11-20 — P0 运行时归属核实：Python 开发分支与 Node 主分支分离（仅静态）

- **仓库事实（2026-11-20）**：开发分支 README 明确 `python3 -m angel`、Python 标准库实现，`angel/agent.py` 显式引入 `ToolJournal`；默认主分支 README 标题为 **Nyra**，宣称 Node 单文件二进制与 `nyra` CLI。主分支最新检索提交 [24b6bd9](https://github.com/js2005happy/nyra/commit/24b6bd9ce0b1a605d56604f229fb91fd0b99f4db) 是 TypeScript CLI `savings --json`。因此**已确认两分支文档描述的是不同运行时**；尚未核实 Node 工具派发源码及其所有权实现，不能声称 Python ToolJournal 保护 Node 运行时。开发分支 `package.json` 不存在（查询返回 NOT_FOUND），不能以此证明整个仓库不存在其他 JS 文件。
- **本仓库事实**：主分支近期 [#97](https://github.com/js2005happy/nyra/commit/6dfd7f5ccea6d3e6a06d028fd2b7bb419b77a28e) 已增加权限规则静态体检，[#96](https://github.com/js2005happy/nyra/commit/259403d0abc19260c8230991dfee65c92d70dc25) 修复 URL 规则不命中；避免重复实现。开放 Issue/PR 搜索本轮为空；搜索结果不是全部 CI 运行记录。
- **外部反馈（事实，非 Angel 复现）**：[Codex #62611](https://github.com/openai/codex/issues/62611)，2026-11-19 创建，请求长 CI/额度等待时事件驱动休眠、保存子任务状态、可选安全续跑；[Codex #58900](https://github.com/openai/codex/issues/58900)，用户报告 Windows Full access 下工具被策略拒绝但缺乏可操作解释。均为公开个案，不能推断发生率。
- **工程推断与排序（价值／难度／风险／依赖）**：P0 Node 当前真实工具派发入口、权限门与分支归属审查（高／中／低／读取 Node 源码）；P0 跨进程原子执行所有权与崩溃对账（高／高／高／入口确认、跨平台锁协议）；P1 工具拒绝原因结构化、保密提示（高／中／中／权限门）；P1 可信副作用回执（高／高／高／适配器）；P2 事件驱动等待与可选安全续跑（高／高／高／所有权与审批）；P2 预算硬停止（高／中／中／可信计量）。
- **安全阻塞**：不得把 Python 旧分支上的更多快照检查当作 Node 主运行时安全增量；未经运行时归属及锁协议核实，不提交会改变派发/恢复行为的代码。此轮仅提交审查文档，未运行测试、CI、安装、合并或发布。

## 2026-11-20 — P0 原子执行所有权：分支架构阻塞与新证据（仅静态）

- **仓库事实（2026-11-20 查阅）**：本开发分支的 ToolJournal 位于 Python `angel/tool_journal.py`，`begin()/finish()` 依赖多次非原子的日志快照，最后一次检查与真实工具派发之间仍有竞态；默认主分支近期提交 [1c4389e](https://github.com/js2005happy/nyra/commit/1c4389e33e06db3a3db68a23ff1fd2f76abaa9ec) 则修改 TypeScript `src/` 运行时。两条代码路径是否仍共同投入使用尚未核实；不得在未经架构归属确认的旧路径上宣称实现当前主运行时的安全门禁。
- **仓库事实**：开放 [PR #93](https://github.com/js2005happy/nyra/pull/93) 提到权限缓存及 shell 规则未命中观察；该 PR 未合并，不把观察当作已确认主分支缺陷，也不在本轮跨范围修改权限引擎。开放 Issue 搜索为空；开发分支上次提交 84d0ed8 的状态检查和 PR 工作流查询均为空（不等于 CI 通过）。
- **外部用户反馈（事实，非本项目复现）**：[Codex #53505](https://github.com/openai/codex/issues/53505) 记录 2026-10-12 的长任务用户报告，称消耗大量时间和 token 而 33 项验收未完成；[Codex #56752](https://github.com/openai/codex/issues/56752) 于 2026-10-24 创建，报告长会话指令漂移和过度验证。这些是公开个案，不是总体发生率或 Angel 的已复现故障。
- **工程推断及优先级（价值／难度／风险／依赖）**：P0 明确当前生产执行入口与分支差异（高／中／低／需要主分支与开发分支代码路径比对）；P0 跨进程执行所有权、崩溃人工对账（高／高／高／先确认运行时入口、POSIX/Windows 锁生命周期及可信恢复协议）；P1 独立副作用凭证（高／高／高／可信适配器）；P1 Windows ACL/稳定句柄（高／高／高／原生安全评审）；P2 审批安全续跑（高／中高／高／P0 与回执）；P2 预算硬停止（高／中／中／可靠用量）。
- **本轮阻塞决定**：没有足够静态证据安全地将持锁机制接入当前真实执行路径；拒绝继续增加伪原子复核、自动清除未知结果或无验证的锁生命周期。未修改运行时代码，未运行测试、安装软件、触发 CI、合并或发布。

## 2026-11-20 — P0 前置：finish 写后竞争失败检测（仅静态）

### 2026-11-20 — ToolJournal 写后计数一致性与公开反馈

- **已实现（静态未测试）**：`finish()` 对写后事件数与成功/错误计数作保守一致性检查；发现不一致拒绝报告干净完成。价值中高、实现难度低、安全风险低；依赖已有日志检查。
- **P0 未完成**：覆盖派发至结果落盘的跨进程原子所有权与崩溃人工对账；价值高、难度高、安全风险高，依赖跨平台锁设计及审计模型。计数检查不能替代锁。
- **P1 未完成**：独立副作用凭证（价值高、难度高、风险高，依赖可信执行边界）；Windows ACL/稳定目录句柄（价值高、难度高、风险高，依赖 Windows 原生 API 评审）。
- **P2 未完成**：审批安全续跑（价值高、难度中高、风险高，依赖 P0 和凭证）；成本预算硬停止（价值中高、难度中、风险中，依赖可信费用计量）。
- **外部用户报告（事实，非 Angel 缺陷证明）**：Codex #49743，2026-10-07 的评论描述延迟重复指令可能导致重复执行：https://github.com/openai/codex/issues/49743 。Codex #40646，2026-08-25 创建，报告执行声明与工具证据不一致：https://github.com/openai/codex/issues/40646 。
- **工程推断**：持久操作 ID、原子所有权和独立凭证比持续增加写后复核更能解决根因；优先推进 P0，不能由上述个案推断行业发生率。


- **仓库事实**：ToolJournal 的 `finish()` 写后检查原先未拒绝新出现的其他 `result_error`；本轮增加写后错误数量守卫及两项未运行回归测试。价值高／难度低／安全风险低；依赖现有元数据 inspect，不引入依赖。不能替代原子锁。
- **外部用户反馈（事实，2026-08-25）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务状态与可观察证据不一致；**工程推断（2026-11-20）**：写后检测竞争失败能减少误报干净完成的窗口。外部个案不证明 Angel 同类故障的发生率；直接依据是本仓库源码。
- **未完成排序（价值／难度／风险／依赖）**：P0 跨进程持锁执行所有权和崩溃人工对账（高／高／高／跨平台锁生命周期）；P1 Windows ACL/稳定目录句柄（高／高／高／原生 API 验证）；P1 独立副作用凭证（高／高／高／可信回执）；P2 审批安全续跑（高／中高／高／事务及凭证）；P2 成本硬停止（高／中／中／可信用量）。
- **仓库动态（2026-11-20）**：主分支近期提交 [078ebf9](https://github.com/js2005happy/nyra/commit/078ebf9a2c1bfb16fecc5c674cb6c4f42167e960) 涉及审阅队列；开放 [PR #82](https://github.com/js2005happy/nyra/pull/82) 涉及配置锁定，未重复实现。

## 2026-11-20 — finish 并发失败门禁（P0 安全前置子项，静态）

- **仓库事实**：`begin()` 已拒绝并发 `result_error`，但 `finish()` 的初始检查与最终快照未阻止其他已报告失败；本轮补齐两处失败关闭判断和两项未执行的回归测试。价值高／难度低／安全风险低；依赖现有 ToolJournal 元数据，不新增依赖。此项不是 P0 原子执行所有权的完成。
- **外部用户反馈（事实，2026-08-25）**：Codex Issue #40646（https://github.com/openai/codex/issues/40646）报告长任务的执行状态与可观察证据不一致；**工程推断（2026-11-20）**：Angel 应防止一个工具的失败记录被其他调用的成功提交掩盖。该个案不能证明 Angel 存在相同问题或推断发生率；直接修复依据为本仓库源码审查。
- **后续候选排序**：P0 跨进程所有权与崩溃人工对账（价值高／难度高／风险高／依赖跨平台锁生命周期设计）；P1 Windows ACL 与稳定目录句柄（高／高／高／依赖原生 API 安全方案）；P1 外部副作用独立凭证（高／高／高／依赖可核验回执）；P2 审批安全续跑（高／中高／高／依赖前述 P0）；P2 成本预算硬停止（高／中／中／依赖可信 usage 与价格）。本轮不合并 main，不执行测试或发布。

## 2026-11-20 — ToolJournal 并发错误结果的派发复核（静态修复）

- **仓库事实（2026-11-20）**：现有 `begin()` 首次检查 `reported_errors`，但写后复核及最终快照可能放过竞争进程新写入的 `result_error`。本轮只加两道失败关闭检查及静态回归测试（价值高／难度低／风险低／依赖 ToolJournal），未实现跨进程互斥。
- **外部反馈（用户报告，2026-08-25）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务执行状态与证据不一致；**推断**：派发前应重复核查失败结果，但个案不能证明 Angel 具有相同缺陷或行业发生率。
- **优先级（价值／难度／风险／依赖）**：P0 跨进程持锁执行所有权与崩溃人工对账（高／高／高／跨平台锁生命周期）；P1 Windows ACL 与稳定句柄（高／高／高／原生安全验证）；P1 独立副作用回执（高／高／高／可信工具协议）；P2 审批安全续跑（高／中高／高／事务与回执）；P2 成本硬停止（高／中／中／可信 usage）。
- **仓库动态（2026-11-20）**：主分支 [91c7d1a](https://github.com/js2005happy/nyra/commit/91c7d1a5f53508c9c0a8c10f4810bca24c5b9b1b) 已增加影子快照回滚；[PR #70](https://github.com/js2005happy/nyra/pull/70) 处理跨目录回忆，未重复实现。

## 2026-11-20 — P0 ToolJournal 报告失败后的派发门禁

- **仓库事实（2026-11-20 静态审查）**：`inspect()` 已将 `result_error` 标为 `manual_review_required`，但 `begin()` 原本仍可继续新调用。本轮只补充 `reported_errors` 失败关闭门禁（价值高／难度低／安全风险低／依赖现有 inspect），不自动清除或重放；测试源码未运行。
- **外部反馈（2026-08-25，2026-11-20 复核）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 为其他产品用户报告的执行状态与证据不一致个案，不是 Angel 故障复现或发生率数据。
- **工程推断与排序（价值／难度／风险／依赖）**：P0 跨进程持锁执行所有权与崩溃人工对账（高／高／高／POSIX+Windows 生命周期）；P1 Windows ACL/稳定句柄（高／高／高／原生验证）；P1 独立副作用凭证（高／高／高／可信工具回执）；P2 审批安全续跑（高／中高／高／前述事务和回执）；P2 成本硬停止（高／中／中／可信 usage）。本轮门禁不解决跨进程竞态。
- **仓库近期动态（2026-11-20 查阅）**：[主分支 1837b56](https://github.com/js2005happy/nyra/commit/1837b56420ad9e4a092439f324f6de86438901e3) 已处理回忆感知成本估算；[PR #62](https://github.com/js2005happy/nyra/pull/62) 正在处理回忆健康检查，避免重复开发。

## 2026-11-20 — ToolJournal 工具错误结果的人工核查门禁（P0 小增量）

- **仓库事实（2026-11-20 静态审查）**：已配对的 `result_error` 以前会让 `manual_review_required=false`，尽管外部副作用可能部分完成。本轮修复只读原因分类（高价值／低难度／低风险／依赖现有 `inspect()`），新增 `reported_errors` 原因；不授予自动续跑或工具执行权限。
- **外部用户反馈（2026-08-25 创建，2026-11-20 复核）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 描述执行状态声明与可观察工具记录不一致；**事实**是外部个案报告，**非** Angel 缺陷复现、发生率或安全保证。
- **工程推断与候选排序（价值／难度／风险／依赖）**：P0 跨进程执行所有权与崩溃人工对账（高／高／高／POSIX+Windows 完整生命周期）；P1 Windows ACL/稳定目录句柄（高／高／高／原生验证）；P1 独立副作用回执（高／高／高／可信工具适配器）；P2 人工审批安全续跑（高／中高／高／前述 P0 与回执）；P2 成本预算硬停止（高／中／中／可信 usage）。本轮测试源码未执行，不能声称验证通过。

## 2026-11-20 — 人工对账原因分类（P0 安全续跑前置子项）

- **仓库事实（2026-11-20 静态审查）**：开发分支 `inspect()` 已有 `manual_review_required`，但无法让审核端直接区分未知结果与损坏/孤立结果。本轮新增只读 `review_reason`（价值中高／难度低／安全风险低／依赖已有 `inspect` 统计），不修改执行门禁或恢复策略；测试源码未运行。
- **近期仓库证据（2026-11-20 查阅）**：[主分支提交 8ab2938](https://github.com/js2005happy/nyra/commit/8ab2938b5752e935b78370d8b9a7c318b5f8c6f1) 修正 macOS CI 测试跳过；[PR #52](https://github.com/js2005happy/nyra/pull/52) 正在实现动态工具揭示，属于成本/上下文优化，不重复开发。
- **外部用户反馈（2026-11-20 查阅）**：[Codex #42695](https://github.com/openai/codex/issues/42695) 报告委派任务在压缩后恢复过时指令、最终执行报告与工具记录矛盾；这是外部用户案例，非 Angel 缺陷复现或总体发生率证据。
- **工程推断与后续排序（价值／难度／安全风险／依赖）**：P0 跨进程执行所有权与崩溃人工对账（高／高／高／跨平台锁覆盖派发及结果落盘）；P1 Windows ACL/稳定目录句柄（高／高／高／原生 Windows 验证）；P1 独立副作用回执（高／高／高／可信工具适配器）；P2 人工审批安全续跑（高／中高／高／P0+回执）；P2 成本硬停止（高／中／中／可信 usage）。`review_reason=none` 不证明工具成功，也不能自动重试。

## 2026-11-20 — 人工对账只读信号（P0 子项）

- **仓库事实（2026-11-20 静态审查）**：`ToolJournal.inspect()` 已提供 `unknown_outcomes` 与 `journal_ambiguous`，但没有直接供人工审核界面消费的布尔对账信号。本轮新增 `manual_review_required`（价值中高／难度低／安全风险低／依赖现有统计），不更改派发权限或自动恢复逻辑；测试源码未执行。
- **近期仓库证据（2026-11-20 核对）**：[PR #49](https://github.com/js2005happy/nyra/pull/49) 正在讨论 MCP 工具延迟加载，属于独立成本优化，不与本轮日志安全工作重复；近期主分支提交 [f8646f9](https://github.com/js2005happy/nyra/commit/f8646f9587b8d747fe052ffabc5ea5e556674be7) 修复 Windows Node CI 故障。两者均非 ToolJournal 故障证据。
- **外部用户反馈（2026-08-25 报告，2026-11-20 复核历史记录）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 涉及长任务状态与可核验证据不一致；这是其他产品的用户报告，不是 Angel 复现或频率统计。
- **工程推断及后续排序（价值／难度／风险／依赖）**：P0 跨进程所有权与崩溃人工对账（高／高／高／POSIX+Windows 锁生命周期覆盖工具派发和结果写入）；P1 Windows 原生 ACL/稳定句柄（高／高／高／Win32 实机）；P1 独立副作用凭证（高／高／高／工具可信回执）；P2 人工审批安全续跑（高／中高／高／前述所有权与对账）；P2 成本硬停止（高／中／中／可靠 usage）。

## 2026-11-19 — 静态审查发现孤立结果修复中的源码换行错误

- **仓库事实（2026-11-19 静态审查）**：`ToolJournal.inspect()` 前次新增的孤立 result 歧义门禁意外含字面量 `\n`，导致后续赋值落在注释文本中；本轮仅修复此回归，优先级 P0（价值高/难度低/风险低/依赖已有逻辑）。未运行测试，不能断言修复已通过。
- **公开用户反馈（2026-11-19 复核）**：[Codex #40646](https://github.com/openai/codex/issues/40646)（2026-08-25）报告长任务状态与可验证证据不一致；这是外部个案，不是本次源码回归的复现或发生率统计。
- **工程推断与待办排序（价值/难度/安全风险/依赖）**：P0 跨进程执行所有权及崩溃人工对账（高/高/高/锁生命周期与跨平台验证）；P1 Windows ACL/稳定句柄（高/高/高/原生 API）；P1 独立工具副作用凭证（高/高/高/可信回执）；P2 人工审批续跑（高/中高/高/对账）；P2 成本硬停止（高/中/中/可信 usage）。不把单纯重复读写当作原子事务，不自动重放未知副作用。

## 2026-11-19 — 公开反馈与本轮优先级复核

- **仓库事实（静态审查，2026-11-19）**：ToolJournal inspect() 遇到孤立 result 时仍可能报告其它已配对调用成功；本轮修复此单一统计一致性缺口，测试源码未运行。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 讨论长任务状态与可验证证据不一致；这是外部个案，不是 Angel 缺陷复现。
- **工程推断**：日志存在孤立结果时，聚合成功计数可能误导操作员，价值高、实现难度低、安全风险低，优先于高风险锁生命周期大改。
- **下一项 P0（高价值/高难度/高风险）**：跨进程 intent 所有权与崩溃后人工对账；依赖锁生命周期覆盖派发与结果提交、POSIX/Windows 分别验证，不自动重放未知副作用。
- **P1（高价值/中高难度/高风险）**：Windows 原生 ACL 与稳定目录句柄；依赖原生平台验证。
- **P1（高价值/高难度/高风险）**：工具副作用独立凭证；依赖可审计执行边界。

## 2026-11-19 容量边界安全增量与近期用户反馈

- **仓库事实（静态审查）**：`ToolJournal.begin()` 旧上限为 `event_count >= MAX_EVENTS`，`finish()` 也要求 `len(records) < MAX_EVENTS`；在仅剩一个槽位时，新增 intent 后结果事件没有容量。已增加单进程结果槽位预留（价值中高／难度低／安全风险低／依赖现有 Journal；仅静态检查、待运行测试）。并发写入仍可抢占槽位。
- **外部反馈（2026-11-19 查阅）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 于 2026-08-25 创建，用户报告长任务中执行状态与证据不一致；[Codex #50771](https://github.com/openai/codex/issues/50771) 于 2026-10-04 创建，报告任务在尚未完成时提前停止。这些是其他产品的用户陈述，不是 Angel 容量缺陷复现或发生率证明。
- **工程推断／未完成排序（价值／难度／安全风险／依赖）**：P0 跨进程原子执行所有权及崩溃后人工对账（高／高／高／跨平台锁生命周期覆盖派发与落盘）；P1 独立工具副作用凭证（高／高／高／可信适配器）；P1 Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 设计与实机）；P2 审批安全续跑（高／中高／高／前述对账）；P2 成本硬停止（高／中／中／可靠 usage）。不自动重试未知副作用。

## 2026-11-19 跨进程事务设计门槛（静态审查，未实现）

**仓库事实（2026-11-19）：** `angel/tool_journal.py` 的 `begin()` / `finish()` 采用多个独立 `inspect()` / `_records()` / `_write()` 调用；即使加入写后复核，最终检查与实际工具派发仍无跨进程互斥。当前仅能拒绝已观察到的竞争，不保证恰好一次执行。此前多个提交连续增加检查点，不能将其等同原子事务。

**外部用户反馈（不是 Angel 复现）：** 2026-08-09 [Codex #37687](https://github.com/openai/codex/issues/37687) 报告任务委派后两个执行者在同一工作区重复运行；2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务约束漂移及未经证实的完成声明。二者均为个案，不代表普遍故障率。

**工程推断与排序（价值/难度/风险/依赖）：**
1. P0：跨进程执行所有权/原子保留（高/高/高；依赖跨平台文件锁、句柄绑定与进程崩溃语义）。必须明确锁的生命周期覆盖实际工具派发及结果落盘，不能只锁 `begin()`；不允许锁超时后自动重放外部副作用。
2. P0：崩溃后人工对账与只读所有权状态（高/中高/高；依赖上项）。失联、锁丢失、未知结果均保持 fail-closed；不可凭 PID 存活判断外部操作未发生。
3. P1：工具副作用独立凭证（高/高/高；依赖工具特定回执和用户授权），不能把 journal 的 `result_ok` 当作真实副作用证据。
4. P1：预算硬停止（高/中/中；依赖可信 usage 与价格），未返回用量时必须明确无法保证硬上限。

**实现前验收门槛：** 明确 POSIX/Windows 文件锁语义、锁文件安全创建与目录句柄约束、持锁期间进程异常退出、同会话双进程竞争、工具完成但日志未提交、Windows junction/ACL，以及非持锁调用方绕过的威胁模型。增加源码测试覆盖这些场景，但未经用户授权不得运行；在此之前不得宣称原子保留或安全自动续跑。本轮不再叠加新的非原子复核点。

## 2026-11-19 — 结果提交后并发复核与近期用户反馈

- **仓库事实（静态审查）**：开发分支 `ToolJournal.finish()` 原先在最终结果写入后直接返回；新增写后 `inspect()`，遇到新未决 intent 或歧义则拒绝报告干净完成，并保留日志供人工核查。价值高／实现难度低／安全风险低／依赖现有 ToolJournal；模拟回归测试已编写但未运行。不是跨进程事务。
- **外部用户反馈（2026-11-10 创建，2026-11-19 查阅）**：[Codex #60603](https://github.com/openai/codex/issues/60603) 报告工具被阻止后，替代合法工具的授权状态没有重新评估；这属于其他产品用户陈述，未在 Angel 复现。**工程推断**：工具执行状态应明确区分安全拒绝、执行未知、审批失败与可重新评估的合法替代路径，不能自动绕过拒绝。
- **待办排序（价值／难度／安全风险／依赖）**：P0 跨进程 intent 原子保留与崩溃对账（高／高／高／跨平台锁协议）；P1 Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 设计和实机验证）；P2 工具副作用独立凭证（高／高／高／可信适配器）；P3 人工审批安全续跑与拒绝原因分类（高／中高／高／审批与可信事务）；P4 成本预算硬停止（高／中／中／可靠用量数据）。事实、外部反馈和工程推断分别记录，不自动重放未知结果。

## 2026-11-19 — finish 最终快照并发门禁

- **仓库事实（2026-11-19 静态审查）**：`finish()` 的首次 `inspect()` 与后续 `_records()` 分开执行，期间可新增未决 intent。此次仅在最终快照补充其他调用配对检查及模拟测试（未运行）；价值高／难度低／风险低／依赖现有 ToolJournal。
- **外部反馈（2026-09-30 报告，2026-11-19 查阅）**：[Codex #49743](https://github.com/openai/codex/issues/49743) 用户描述已消费消息仍停留队列；重复条目是用户主动重发，不证明系统自动重复执行，也不证明 Angel 同类故障。
- **工程推断及排序（价值／难度／风险／依赖）**：① 跨进程原子保留与崩溃对账（高／高／高／互斥及恢复协议）；② Windows ACL 与稳定目录句柄（高／高／高／Win32 安全设计）；③ 副作用独立凭证（高／高／高／可信适配器）；④ 人工审批续跑（高／中高／高／对账）；⑤ 成本硬停止（高／中／中／可信 usage）。无强制新依赖，不自动重放未知操作。

## 2026-11-19 — 最终快照并发意图复核

- **仓库事实（2026-11-19 静态审查）**：begin() 写后 inspect() 与最后一次仅检查自身 call_id 的 _records() 之间仍可新增其他未决 intent。本轮增加最终快照的其他调用配对检查与模拟测试源码（未运行）。价值高／难度低／安全风险低／依赖已有日志事件格式；仍非原子事务。
- **外部反馈（2026-10-07 用户追加，2026-11-19 查阅）**：[Codex #49743](https://github.com/openai/codex/issues/49743) 报告已处理排队消息可能再次投递，导致重复操作风险；不证明 Angel 存在同样故障。
- **工程推断与排序（价值／难度／风险／依赖）**：① 跨进程 intent 原子保留和崩溃对账（高／高／高／可移植锁）；② Windows ACL 与稳定句柄（高／高／高／Win32 API）；③ 独立副作用凭证（高／高／高／可信适配器）；④ 人工审批续跑（高／中高／高／对账与审批）；⑤ 成本预算硬停止（高／中／中／可信 usage）。无强制新依赖，不自动重试未知操作。

## 2026-11-19 调研与优先级增量（本次意图身份复核）

- **仓库事实（静态审阅，2026-11-19）**：`ToolJournal.begin()` 已有写后全局 `inspect()`，但只核对 unknown 数量，未确认自己的 call_id 仍是未决 intent。本轮补充身份守卫及未执行的模拟回归测试。
- **外部用户反馈（2026-08-25 提交，2026-11-19 查阅）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务中约束漂移及缺少可信执行状态证据。该报告不是 Angel 漏洞复现。
- **工程推断**：独立副作用凭证与跨进程原子保留可以减少重复执行及错误完成声明；仍须按外部工具幂等能力设计，不能宣称 exactly-once。
- **候选排序（价值 / 难度 / 安全风险 / 依赖）**：① 跨进程 intent 原子保留及崩溃对账：高/高/高，依赖可移植互斥与恢复协议；② Windows ACL 与稳定目录句柄：高/高/高，依赖 Windows 原生 API 设计；③ 独立工具副作用凭证：高/高/高，依赖可信执行边界；④ 人工审批安全续跑：高/中高/高，依赖前述对账与凭证；⑤ 成本预算硬停止：高/中/中，依赖可核验用量。每轮只实现一个安全增量。

## 2026-11-19 — 意图提交后并发门禁与重复执行反馈

- **仓库事实（静态审查）**：`ToolJournal.begin()` 先检查日志、再排他写入本次 intent，原先未在写后核对其他进程是否已产生未决 intent；本轮补充写后保守复核与模拟回归测试（未运行）。价值高／难度低／安全风险低／依赖现有 ToolJournal。此项已提交待验证，不能当作跨进程事务。
- **外部用户反馈（2026-10-07，2026-11-19 查阅）**：[Codex #49743](https://github.com/openai/codex/issues/49743) 的用户追加报告称已处理的排队指令可能再次投递，引发重复执行风险。该反馈属于其他产品的个案，不证明 Angel 复现或具备相同队列机制。
- **工程推断／后续优先级（价值／难度／安全风险／依赖）**：① 跨进程 intent 原子保留与崩溃后人工对账（高／高／高／跨平台锁和崩溃协议）；② Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 API 设计及实机验证）；③ 工具副作用独立凭证（高／高／高／可信工具适配器）；④ 人工审批安全续跑（高／高／高／可信事务及审批）；⑤ 成本预算硬停止（高／中／中／可靠 usage 计量）。无强制第三方依赖，不自动重放未知结果，不合并 main。

## 2026-11-19 — POSIX 末次目录句柄拒绝诊断与 Agent 反馈

- **仓库事实（静态审查）**：`ToolJournal._records()` 的最终目录 `os.fstat(fd)` 遇到 `OSError` 时原先直接传播底层异常。本轮改为 `JournalError` 失败关闭并保留异常链，增加空目录模拟回归测试（价值中高／难度低／安全风险低／依赖已有 POSIX dir_fd；已提交，未运行测试）。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #61154](https://github.com/openai/codex/issues/61154) 在 2026-11-12 有关于 Windows `WRITE_DAC` 权限拒绝的讨论；[Codex #60192](https://github.com/openai/codex/issues/60192) 于 2026-11-08 创建，报告 Windows 沙箱初始化阻断工具调用。它们是其他产品的个案，不是 Angel POSIX 缺陷复现，也不能据此估计普遍发生率。
- **工程推断／后续优先级（价值／实现难度／安全风险／依赖）**：① Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 API 设计及实机验证）；② 跨进程日志事务（高／高／高／锁与崩溃协议）；③ 工具外部副作用独立凭证（高／高／高／可信适配器与对账）；④ 人工审批安全续跑（高／中高／高／前述凭证及审批）；⑤ 成本预算硬停止（高／中／中／可信 usage 数据）。默认不自动重试未知结果、不增加强制依赖、不合并 main。

## 2026-11-19 — POSIX 日志枚举错误分类与用户反馈

- **仓库事实（静态审查）**：POSIX `ToolJournal._records()` 的末次 `os.listdir(directory_fd)` 发生 `OSError` 时直接传播未分类错误；本轮增加 `JournalError` 失败关闭和模拟测试（价值中高 / 难度低 / 风险低 / 依赖现有 dir_fd；已提交待验证）。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #61154](https://github.com/openai/codex/issues/61154)（2026-11-12 讨论）和 [Codex #60057](https://github.com/openai/codex/issues/60057)（2026-11-07 创建）报告 Windows 沙箱权限拒绝与恢复困难。它们不证明 Angel 存在同样缺陷；本轮 POSIX 修复来自独立源码检查。
- **工程推断与排序（价值 / 难度 / 安全风险 / 依赖）**：① Windows 原生 ACL 与稳定句柄（高/高/高/Win32 设计与实机验证，未完成）；② 跨进程 ToolJournal 事务（高/高/高/锁和崩溃恢复，未完成）；③ 外部副作用独立凭证（高/高/高/可信执行网关，未完成）；④ 人工审批安全续跑（高/中高/高/前述可信记录，未完成）；⑤ 成本预算硬停止（高/中/中/usage 数据和预算规则，未完成）。本分支 `angel/` 与 main `nyra/` 尚未集成，不合并或发布。

## 2026-11-19 — Windows 写入句柄身份补强与公开反馈

- **仓库事实**：Windows/path 读取已检查打开的事件句柄 reparse 属性，但写入后的 `_verify_written_windows_entry()` 此前只检查路径目录项；本轮增加写句柄属性拒绝与模拟测试源码，未执行测试。无强制新依赖。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #59605](https://github.com/openai/codex/issues/59605)（2026-11-05 创建，2026-11-19 更新）报告桌面端显示的授权级别与实际权限不一致；[#60057](https://github.com/openai/codex/issues/60057)（2026-11-07 创建）报告 Windows 沙箱 ACL 修复后仍无法初始化。这些是其他产品的用户报告，非 Angel 缺陷复现或普遍发生率。
- **工程推断与候选排序（价值／实现难度／安全风险／依赖）**：① Windows 写句柄 reparse 拒绝（中高／低／低中／现有标准库，**已提交待测试**）；② Windows 原生 ACL 与稳定目录句柄（高／高／高／平台 API 与实机验证）；③ 跨进程原子日志事务（高／高／高／锁协议）；④ 外部副作用证据与人工核验（高／高／高／可信工具适配器）；⑤ 人工审批续跑（高／高／高／前述证据与幂等分类）；⑥ 成本硬停止（高／中／中／可信用量）。不自动恢复未知副作用。

## 2026-11-19 — Windows 打开句柄 reparse 防护增量

- **仓库事实（已实现，未执行）**：`_records()` 原有 Windows reparse 检查基于路径目录项；本轮增加对已打开事件文件 `fstat` 元数据的检查，降低路径与句柄状态不一致的误信任风险。价值中高／难度低／安全风险中（Windows 行为未验证）／依赖标准库 `os.fstat`。
- **外部反馈（2026-11-19 查阅）**：[Codex #60057](https://github.com/openai/codex/issues/60057)（2026-11-07 创建）和 [#61154](https://github.com/openai/codex/issues/61154)（2026-11-12 有反馈）描述 Windows 沙箱访问拒绝及恢复诊断困难。这是其他产品的用户报告，不证明 Angel 复现同类缺陷。
- **工程推断／待办排序（价值／难度／安全风险／依赖）**：P0 Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 设计与实机验证）；P1 跨进程原子日志事务（高／高／高／跨平台锁协议）；P2 外部副作用凭证（高／高／高／可信适配器与对账）；P3 人工审批安全续跑（高／中高／高／事务与审批）；P4 成本预算硬停止（高／中／中／计费元数据可信度）。事实与推断分开记录；不得自动恢复未知结果，不合并 main。

## 2026-11-19 — 祖先目录元数据拒绝诊断与 Windows 用户反馈

- **仓库事实（静态审查）**：`_safe_directory()` 对祖先 `is_symlink()` / `is_junction()` 的 `OSError` 未归一到 `JournalError`；本轮补充失败关闭与模拟测试源码（未运行）。该项价值中高／实现难度低／安全风险低／依赖现有 ToolJournal；不涉及原生 Windows ACL。
- **外部用户反馈（2026-11-07 创建，2026-11-19 核对）**：[Codex #60057](https://github.com/openai/codex/issues/60057) 报告 Windows 沙箱 `Access is denied` 且人工 ACL 调整后仍可能失败；[Codex #61154](https://github.com/openai/codex/issues/61154) 在 2026-11-12 有关于 `WRITE_DAC` 访问拒绝的讨论。两者是其他产品的个案，不证明 Angel 存在相同缺陷。
- **工程推断及未完成排序（价值／难度／风险／依赖）**：① Windows 原生 ACL 与稳定句柄（高／高／高／Win32 API 设计及 Windows 实机验证）；② 跨进程日志原子事务（高／高／高／锁与崩溃协议）；③ 外部副作用独立凭证（高／高／高／可信工具对账）；④ 人工审批安全续跑（高／高／高／可信事务和审批）；⑤ 成本硬停止（高／中／中／可靠 usage 计量）。继续保持无强制第三方依赖、未知结果不自动重放，且不合并 main。

## 2026-11-19 — 回退路径元数据探测诊断与外部反馈

- **仓库事实（静态审查）：** `ToolJournal._records()` 的路径回退分支在 `Path.is_symlink()` 元数据探测时可能传播原始 `OSError`；本轮改为 `JournalError` 并保留异常链，新增模拟测试源码，未运行。
- **外部用户反馈（2026-11-07 创建，2026-11-19 核对）：** [Codex #60057](https://github.com/openai/codex/issues/60057) 报告 Windows 沙箱初始化因 ACL / Win32 error 5 失败；这是其他项目的个案，不证明 Angel 复现同类问题。
- **工程推断与排序（价值／难度／安全风险／依赖）：** ① 回退路径符号链接探测拒绝诊断（中高／低／低／既有 ToolJournal，已提交待验证）；② Windows 原生 ACL 与稳定句柄（高／高／高／Win32 API 设计和实机验证）；③ 跨进程日志原子事务（高／高／高／锁及崩溃协议）；④ 外部副作用独立凭证（高／高／高／可信工具适配器）；⑤ 人工安全续跑（高／高／高／可信事务与审批）。不新增强制依赖，不自动重放未知结果。

## 2026-11-19 — 路径回退枚举错误诊断与近期反馈

- **仓库事实（2026-11-19，静态审查）：** `ToolJournal._records()` 的 Windows/path 回退分支在首次与末次 `iterdir()` 遇到 `OSError` 时原先直接传播底层异常；本轮将其归一为 `JournalError` 并保留异常链。仅编写模拟回归测试，未执行。
- **外部用户反馈（2026-11-07）：** [Codex #60057](https://github.com/openai/codex/issues/60057) 报告 Windows 沙箱 `Access is denied`，调整 ACL 后仍无法初始化；**外部反馈（2026-11-12）：** [Codex #61154](https://github.com/openai/codex/issues/61154) 报告 `WRITE_DAC` 拒绝并希望获得可靠诊断。这些是其他项目的个案，不代表 Angel 已复现同类错误。
- **工程推断及优先级（价值/难度/安全风险/依赖）：** ① 路径回退枚举错误统一诊断（高/低/低，依赖既有 ToolJournal，**已提交待验证**）；② Windows 原生 ACL 与稳定句柄（高/高/高，依赖 Windows API 安全设计）；③ 跨进程原子事务（高/高/高，依赖可验证的锁与崩溃语义）；④ 工具副作用独立凭证（高/高/高，依赖工具类型与远端对账）；⑤ 人工安全续跑（高/高/高，依赖前述可信事件）。不新增强制第三方依赖，不自动重放未知结果。

## 2026-11-19 — 目录类型访问拒绝及 Windows Agent 反馈

- **仓库事实（静态审查，未运行）**：`_safe_directory()` 的末次目录类型检查使用 `exists()/is_dir()`，可能在部分平台将访问拒绝误判为缺失。本轮改为 `lstat()`，仅 `FileNotFoundError` 可继续，其他错误保守拒绝；价值高／难度低／安全风险低／依赖标准库 ToolJournal。新增测试源码未执行。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #61154](https://github.com/openai/codex/issues/61154)（2026-11-12 有 GitHub 机器人评论，创建日期未核实）报告 Windows 沙箱目录 ACL 权限拒绝及初始化失败；[Codex #60057](https://github.com/openai/codex/issues/60057)（2026-11-07 创建）报告 Windows 沙箱设置错误在手工权限调整后仍存在。属于其他产品的个案，不是 Angel 缺陷证据。
- **工程推断／未完成排序（价值／难度／安全风险／依赖）**：① Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 API 及实机验证）；② 跨进程日志事务（高／高／高／跨平台锁与崩溃协议）；③ 工具外部副作用凭证（高／高／高／可信工具适配器）；④ 人工审批安全续跑（高／中高／高／审批与事务）；⑤ 未变化文件读取复用（中高／中／中／缓存失效策略）。本轮不合并 main、不发布、不运行测试。

## 2026-11-19 — 读取入口权限拒绝语义及 Agent 反馈

- **仓库事实 / 已实现但未验证**：_records() 曾在 _directory_identity() 前通过 Path.exists() 早退；在部分平台权限拒绝可能伪装为缺失。改为只根据 lstat 的真实 FileNotFoundError 判空，价值高／难度低／安全风险低／依赖现有 ToolJournal；测试源码未运行。
- **外部反馈（2026-11-19 检索）**：[Codex #61184](https://github.com/openai/codex/issues/61184) 报告 Windows 沙箱初始化 Access is denied 并阻断开发（Issue 创建日期未核实）。这是其他产品的用户陈述，非 Angel 缺陷证据。
- **工程推断与未完成候选排序（价值／难度／安全风险／依赖）**：① Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 安全 API 与实机验证）；② 跨进程日志事务（高／高／高／跨平台锁和崩溃协议）；③ 外部工具副作用凭证（高／高／高／可信工具适配器）；④ 人工审批安全续跑（高／中高／高／事务及审批）；⑤ 文件读取复用（中高／中／中／失效策略）。不自动合并 main。

## 2026-11-19 — 目录访问拒绝诊断（静态增量）

- **仓库事实**：`_directory_identity` 旧实现使用 `Path.exists()` 判断缺失；在某些 Python/Windows 版本，权限错误可能被当作不存在。本轮将真正的 FileNotFoundError 与其他 OSError 分开，访问拒绝时保守报错（价值高／难度低／安全风险低／依赖标准库；测试源码已写、未运行）。
- **外部反馈（2026-11-19 查阅，创建日期依 GitHub Issue）**：[Codex #54100](https://github.com/openai/codex/issues/54100)（2026-10-14）涉及 Windows ACL 失败时错误诊断不足；这是其他项目的用户报告，不是 Angel 缺陷复现。**工程推断**：保留明确拒绝语义可降低误判为空日志的风险。
- **未完成候选排序（价值／难度／风险／依赖）**：① Windows 原生 ACL 和稳定句柄（高／高／高／Win32 API 与实机验证）；② 跨进程原子事务（高／高／高／锁及崩溃协议）；③ 外部副作用凭证（高／高／高／可信工具适配器）；④ 人工审批续跑（高／中高／高／事务和审批）；⑤ 文件读取复用（中高／中／中／失效策略）。不合并 main、不增加强制依赖。

## 2026-11-19 — 写入目录句柄复核及 Windows ACL 反馈

- **仓库事实（静态审查）**：POSIX 写入在 fsync(directory_fd) 后原本未复核目录句柄权限；本轮增加末次 fstat 与模拟测试（价值中高／难度低／安全风险低／依赖现有 ToolJournal，已提交待验证）。此项不是跨进程事务或 Windows ACL。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #54100](https://github.com/openai/codex/issues/54100)（2026-10-14 创建）报告 Windows ACL 失败时底层 OS 错误丢失；[Codex #60057](https://github.com/openai/codex/issues/60057)（2026-11-07 创建，2026-11-10 有后续反馈）报告 Windows 沙箱设置失败且缺少可靠恢复。这些是其他产品的个案，不证明本项目同类缺陷。
- **工程推断及待办排序（价值／难度／风险／依赖）**：① Windows ACL、稳定目录句柄与可诊断拒绝（高／高／高／Win32 API 设计及 Windows 实机验证）；② 跨进程原子日志事务（高／高／高／锁协议与崩溃恢复）；③ 外部副作用独立凭证（高／高／高／事务和可信对账）；④ 人工审批安全续跑（高／中高／高／审批与副作用凭证）；⑤ 未变化文件读取复用（中高／中／中／失效策略）。继续保持无强制第三方依赖；主线 nyra/ 与开发分支 angel/ 尚未集成。

## 2026-11-19 — POSIX 末次目录句柄检查与 Windows 沙箱反馈

- **仓库事实（已实现、未运行）**：POSIX 二次枚举后原有路径身份检查不能复核已打开目录 fd 的权限变化；新增末次 fstat 校验与模拟回归测试。价值中高／难度低／安全风险低／依赖 ToolJournal。仍不能保证完整快照原子性。
- **外部反馈（2026-11-19 查阅）**：[Codex #60057](https://github.com/openai/codex/issues/60057)（2026-11-07 创建）报告 Windows 沙箱 ACL 修复后仍初始化失败；[Codex #50520](https://github.com/openai/codex/issues/50520)（2026-10-03 创建）报告权限问题反复出现。这些是其他产品的用户报告，不证明 Nyra 有同类缺陷。
- **工程推断与待办排序（价值／难度／安全风险／依赖）**：① Windows ACL 与稳定目录句柄（高／高／高／Win32 安全 API 审核）；② 跨进程日志原子事务（高／高／高／跨平台锁策略）；③ 工具外部副作用凭证（高／高／高／事务和对账）；④ 审批失败诊断与安全续跑（高／中高／高／审批系统）；⑤ 文件读取复用（中高／中／中／文件身份及缓存失效）。主线 nyra/ 与开发分支 angel/ 仍需集成审查。

## 2026-11-19 — Windows/path 目录身份检查与近期反馈

- **仓库事实**：`_records()` 路径回退的第二次目录枚举之后原先没有再核验目录身份；本轮增加末次身份检查与模拟测试源码（价值中高／难度低／安全风险低／依赖 ToolJournal；已实现、未运行验证）。这是竞态检测，不是原生稳定句柄。
- **外部用户反馈（2026-11-19 查阅）**：[Codex #60192](https://github.com/openai/codex/issues/60192)，2026-11-08 创建，报告 Windows 沙箱启动前因访问拒绝而阻断命令；[Codex #50520](https://github.com/openai/codex/issues/50520)，2026-10-03 创建，报告 Windows 沙箱 ACL 问题反复出现。它们不是 Nyra 缺陷复现证据。
- **工程推断与未完成排序（价值／难度／安全风险／依赖）**：① Windows 原生 ACL 与稳定目录句柄（高／高／高／Win32 API 安全设计）；② 跨进程原子日志事务（高／高／高／跨平台锁策略）；③ 外部工具副作用独立凭证（高／高／高／事务及结果核验）；④ 审批拒绝诊断与人工安全续跑（高／中高／高／审批通道）；⑤ 任务完成核验与后台通知（中高／中／中／主线现有队列）。开发分支 `angel/` 与主线 `nyra/` 仍需单独集成，不自动合并。

## 2026-11-19 — Windows/path 日志快照一致性（本轮）

- **源码事实 / 已实现、未运行验证**：POSIX dirfd 分支已有二次枚举，Windows/path 回退缺少相同检查；现两条读取路径均比较读取前后的文件名集合。价值高 / 难度低 / 安全风险低 / 依赖 ToolJournal。
- **外部反馈（2026-11-19 查阅）**：[Codex #47176](https://github.com/openai/codex/issues/47176)（2026-09-22 创建）报告 Windows 工作区已有 ACL 但写入遭拒；[Codex #36087](https://github.com/openai/codex/issues/36087)（2026-07-30 创建，2026-10-02 有后续反馈）报告 Windows sandbox ACL 初始化失败。这些是外部用户反馈，不证明 Nyra 同类缺陷，也不是本轮快照修复的直接证据。
- **工程推断 / 后续排序（价值/难度/安全风险/依赖）**：P0 Windows ACL 与稳定目录句柄（高/高/高/Win32 威胁模型）；P1 跨进程原子日志事务（高/高/高/日志协议）；P2 工具副作用独立凭证（高/高/高/事务与工具适配器）；P3 审批失败诊断和安全续跑（高/中高/高/可信审批、事务）；P4 任务验收和后台通知（高/中/中/现有主线能力）。开发分支 angel/ 与 main nyra/ 尚未集成，不自动合并。

## 2026-11-19 — 工具日志并发枚举证据与下一增量

- **源码事实（2026-11-19 静态审阅）**：POSIX `_records()` 使用稳定目录 fd，但只在开始时列举文件名；期间新增/删除事件可能不改变目录 inode，返回的记录集合不完整。本轮补充最终文件名集合复核及回归测试源码，未运行。
- **外部用户反馈（2026-08-25）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 描述长任务声明与执行证据不一致；这属于另一产品的个案，不能证明本仓库存在同类故障。**工程推断**：日志快照必须保守处理并发变化，但双重枚举仍非事务锁。
- **候选排序（价值/实现难度/安全风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Win32 API 设计与实机验证，未完成）；② 跨进程日志原子事务（高/高/高/跨平台锁与崩溃恢复，未完成；本轮只做低风险 POSIX 快照检测）；③ 外部工具副作用独立凭证（高/高/高/可信执行网关与幂等对账）；④ 人工审批安全续跑（高/高/高/权限作用域与前述凭证）；⑤ 未变化文件读取复用（中高/中/中/缓存失效策略）。
- **集成约束**：main 已使用 `nyra/`，开发分支仍为 `angel/`；本轮不合并、不发布、不运行测试。


## 2026-11-18 — 本轮静态复核与优先级

- **源码事实（2026-11-18）**：空事件日志没有逐事件循环，原实现对已打开的 POSIX 目录句柄缺少最终复核。本轮补充并编写回归测试（未运行）。这不构成完整事务锁。
- **外部反馈（已记录，2026-08-25）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务声明与执行证据不一致；是外部用户个案，不是 Nyra 的复现证据。
- **工程推断与候选排序（价值/难度/安全风险/依赖）**：① 空日志句柄最终复核（高/低/低/现有 POSIX dir_fd，**本轮已提交，待测试**）；② Windows ACL 与稳定句柄（高/高/高/Windows API，未完成）；③ 跨进程日志原子事务与副作用对账（高/高/高/稳定日志，未完成）；④ 审批拒绝诊断和人工续跑（高/中高/高/审批状态，未完成）；⑤ 未变化文件读取复用（中高/中/中/缓存失效策略，未完成）。

## 2026-11-18 公开反馈、并发日志安全与优先级

- **外部事实（2026-02-08 讨论）：** [Codex #11112](https://github.com/openai/codex/issues/11112) 用户描述并行工具调用与审批可能造成执行顺序和批准预期不一致；这不是 Angel 已复现的故障，也不证明其根因。
- **外部事实（2026-08-25）：** [Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务执行声明与可观察轨迹不一致；个案不代表总体故障率。
- **本仓库事实（2026-11-18 静态审查）：** `begin()` 的检查与持久化不具备跨进程事务性；第二个未决 intent 可能与 `finish()` 并存。**工程推断：** 结果提交应保守拒绝，直到真正的跨进程锁和外部副作用对账实现。

| 优先级 | 候选 | 价值 | 难度 | 安全风险 | 依赖/状态 |
|---|---|---|---|---|---|
| 1 | Windows ACL 与稳定目录句柄 | 高 | 高 | 高 | Windows 原生 API 设计及安全评审；未完成 |
| 2 | 跨进程日志事务 | 高 | 高 | 高 | 原子锁、崩溃恢复；本轮仅完成多未决意图的保守拒绝（未测试） |
| 3 | 外部副作用独立凭证 | 高 | 高 | 高 | 可信执行网关、幂等标记与对账；未完成 |
| 4 | 人工审批与安全续跑 | 高 | 高 | 高 | 前三项及权限作用域；未完成 |
| 5 | 长任务验收与成本可见性 | 高 | 中 | 中 | 真实事件和 usage；未完成 |

## 2026-11-18 Windows 写后元数据缺口与 Agent 用户反馈

- **源码事实 / 已实现**：Windows 回退写后目录项先前只比对类型、inode 与大小，无法识别 inode/大小不变的部分元数据变化。本轮补充硬链接数、mtime_ns、ctime_ns 检查和模拟测试源码（价值中高 / 难度低 / 安全风险低 / 依赖现有 ToolJournal；未运行验证）。
- **外部用户反馈（2026-11-18 查阅，创建日期未核实）**：[Codex #54746](https://github.com/openai/codex/issues/54746) 报告 Windows Full Access 下执行被策略拒绝且缺少可操作原因；这是另一产品的用户报告，不证明 Nyra 有同类故障。本轮代码修复来自独立源码审查，不是该报告的直接修复。
- **工程推断 / 待办排序（价值 / 难度 / 安全风险 / 依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Win32 API 设计及实机验证）；② 跨进程日志事务与外部副作用对账（高/高/高/ToolJournal 与结果核验）；③ 审批拒绝的可解释诊断和安全续跑（高/中高/高/策略来源与人工授权）；④ 文件读取去重（中高/中/中/缓存失效）；⑤ 任务验收与后台通知（高/中高/中高/已合并任务队列）。main 使用 `nyra/` 而本分支使用 `angel/`，暂不合并。

## 2026-11-18 全局歧义日志的统计边界与用户反馈

- **源码事实与本轮增量**：`inspect()` 先前在全局 `journal_ambiguous=true` 时仍报告其他调用的 `reported_ok`，可能被上层误当成部分可信成功。本轮将全局歧义下所有调用归为待核查、成功和错误统计归零（价值高/难度低/安全风险低/依赖 ToolJournal；已提交、测试未运行）。
- **外部用户反馈（2026-11-18 查阅）**：[Codex #40646](https://github.com/openai/codex/issues/40646)（2026-08-25）讨论长任务执行声明与证据不一致；[Codex #33498](https://github.com/openai/codex/issues/33498)（2026-07-16）讨论重复读取未变化文件的效率问题。均为外部报告，不证明 Nyra 有相同故障；本轮修复依据独立源码检查。
- **工程推断与未完成排序（价值/难度/安全风险/依赖）**：① Windows ACL 和稳定目录句柄（高/高/高/Win32 API 与威胁模型）；② 跨进程日志事务及工具副作用证据（高/高/高/ToolJournal、PR #24/#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 未变化文件读取复用（中高/中/中/缓存失效）；⑤ 任务验收与后台通知（高/中高/中高/PR #26/#27）。main 已迁移 `nyra/`，当前分支仍为 `angel/`；不直接合并。

## 2026-11-18 POSIX 事件提交后的名称绑定与用户反馈

- **源码事实**：此前 POSIX 写入经 dir_fd 排他创建并 fsync 文件和目录，但文件同步后没有核对目录项仍指向原 inode。此次增加写后目录项核验与模拟回归测试源码（价值高/难度低/安全风险低/依赖现有 ToolJournal；已实现，未运行验证），检测到名称替换则失败关闭。不能消除检查间竞态，不能证明外部工具副作用。
- **外部用户反馈事实**：2026-11-18 查阅 [Codex #40646](https://github.com/openai/codex/issues/40646)，创建于 2026-08-25，报告长任务中操作声明与可观察工具轨迹不一致。该报告不证明 Nyra 存在同类问题；本次代码修改依据是独立源码审查。
- **工程推断与待办排序（价值/难度/安全风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Windows 原生 API）；② 跨进程 ToolJournal 事务与工具副作用独立证据（高/高/高/日志协议、PR #24、#26）；③ 人工审批安全续跑（高/高/高/PR #25、可信审批）；④ 未变化文件读取复用（中高/中/中/缓存失效规则）；⑤ 任务完成核验与后台通知（高/中高/中高/PR #26、#27）。现有 PR #23–#30 不重复实现；main 已迁移 nyra/，本分支仍为 angel/，不合并 main。

## 2026-11-18 日志读取元数据完整性与用户反馈

- **源码事实**：末次目录项检查原先只核对类型和 inode，无法发现同一 inode 在读取后发生的部分元数据变化；本轮补齐大小、硬链接、mtime/ctime、POSIX 权限核对（价值中高/难度低/安全风险低/依赖 ToolJournal；静态实现，未运行测试）。
- **外部反馈（2026-11-18 查阅）**：[Codex #40646](https://github.com/openai/codex/issues/40646)（2026-08-25 创建）报告长期 Agent 任务的执行声明与可观察证据不一致；[Codex #33498](https://github.com/openai/codex/issues/33498)（2026-07-16 创建）报告重复读取未变化文件造成额外成本。这些是其他产品的反馈，不能证明 Nyra 存在同样问题，也不是本轮元数据缺陷的直接证据。
- **工程推断与未完成排序（价值/难度/安全风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Win32 API）；② 跨进程事务与工具副作用独立证据（高/高/高/现有 Journal、PR #24/#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 避免无变化文件重复读取（中高/中/中/内容哈希与上下文有效性）；⑤ 任务完成核验与后台通知（高/中高/中高/PR #26/#27）。本分支 angel/ 与 main nyra/ 尚未集成。

## 2026-11-18 Agent 用户痛点增量调研与排序

- **外部反馈事实**：Codex [#52173](https://github.com/openai/codex/issues/52173)（2026-10-08）和 [#55217](https://github.com/openai/codex/issues/55217)（2026-10-19）报告 Windows 普通文件被误判为 reparse point，影响受限工作区写入。这些是其他产品的报告，不是 Nyra 的复现证据。
- **工程推断**：需要同时避免路径绕过与错误拒绝；Windows ACL 和稳定目录句柄的本机验证优先于增加更多基于路径的断言。
- **本轮完成**：Windows 事件写入后目录项 reparse/身份/大小复核（价值高、实现低中、安全风险中、依赖现有写入校验）；仅静态审阅。
- **剩余优先级**：P0 Windows ACL 与稳定目录句柄（价值高/难度高/风险高/依赖 Windows 原生方案）；P1 跨进程日志事务和副作用证据（价值高/难度高/风险高/依赖日志一致性）；P2 人工审批续跑（价值高/难度高/风险高/依赖 P1）；P3 完成条件核验和后台通知（价值高/难度中/风险中/依赖现有 PR #26–#27）。

## 2026-11-18 ToolJournal 结果提交门禁与用户反馈

- **源码事实 / 本轮已实现（价值中高 / 难度低 / 安全风险低 / 依赖现有 ToolJournal）**：`begin()` 已检查全局歧义，但 `finish()` 原先仅验证目标调用 ID，可能在存在其他孤立结果时继续提交成功记录。现加入全局歧义检查及回归测试源码，尚未运行验证。
- **外部用户反馈（2026-11-18 查阅；报告自述 2026-09-30 观察、2026-10-01 复测）**：[Codex #49862](https://github.com/openai/codex/issues/49862) 报告 Windows 本地既有会话访问与续接能力缺失；是单一外部案例，不证明 Nyra 存在相同问题，也不直接证明本轮日志缺陷。
- **工程推断 / 待办排序（价值 / 难度 / 安全风险 / 依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Win32 API 威胁模型）；② 跨进程日志事务与外部副作用独立证据（高/高/高/ToolJournal、PR #24/#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 任务验收（高/中高/中高/PR #26）；⑤ 后台通知（中高/中/中/PR #27）。主线 `nyra/` 与开发分支 `angel/` 差异仍未处理，避免重复 PR #23–#30。

## 2026-11-18 根锚点安全修复与候选项（本轮）

- **源码事实**：`_safe_directory` 的旧 `while current != current.parent` 仍跳过锚点，前轮文档宣称已覆盖并不准确。本轮修正循环条件，新增静态回归测试；价值中高 / 实现难度低 / 安全风险低 / 依赖 ToolJournal；未运行验证。
- **外部反馈（2026-11-18 检索，创建日期未核实）**：[Codex #62211](https://github.com/openai/codex/issues/62211) 报告 Windows 沙箱对被重命名的工作目录静默重新创建的情况。这是其他产品的用户反馈，非 Nyra 缺陷证据。
- **工程推断与未完成排序（价值/难度/安全风险/依赖）**：① Windows ACL 和稳定目录句柄（高/高/高/Windows API 与威胁模型）；② 工具副作用独立证据（高/高/高/日志、PR #24/#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 任务验收（高/中高/中高/PR #26）；⑤ 后台通知（中高/中/中/PR #27）。主分支 `nyra/` 与开发分支 `angel/` 仍存在集成差异。

## 2026-11-18 本轮增量与候选项

- 已实现（源码事实，未运行验证）：ToolJournal 目录祖先检查覆盖文件系统锚点，防止遍历边界遗漏；这是保守安全加固，不代表解决 Windows ACL 或路径竞态。
- 外部反馈（2026-11-12 复现记录，非 Nyra 缺陷证明）：[Codex #60973](https://github.com/openai/codex/issues/60973) 报告 Windows junction 工作目录路径拒绝问题。工程推断：路径身份/重解析点处理值得持续优先。
- 候选排序（价值/难度/安全风险/依赖）：Windows ACL 与稳定目录句柄（高/高/高/平台 API 设计）；工具副作用证据（高/高/高/日志与核验）；人工审批续跑（高/高/高/断点恢复）；任务验收（高/中/中/结果核验）；后台通知（中/中/中/队列）。现有 PR #23–#30 的功能不得重复实现。

## 2026-11-18 Windows 事件文件重解析点与外部反馈

- **源码事实**：日志目录祖先已有 Windows reparse point 拒绝逻辑，但事件文件目录项读取前后仅检查普通文件模式和设备/inode；本轮补充 Windows 属性失败关闭（价值中高 / 难度低 / 安全风险低 / 依赖 ToolJournal；已实现待运行验证）。
- **外部用户反馈**：2026-11-18 查阅 [Codex #60973](https://github.com/openai/codex/issues/60973)，报告明确写明在 2026-11-12 复现 Windows junction 工作目录触发错误配置路径拒绝；这是另一产品的用户报告，不证明 Nyra 有同类缺陷，且与本轮事件文件保护不是一一对应关系。
- **工程推断及后续排序（价值/难度/风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Win32 API）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 任务验收（高/中高/中高/PR #26）；⑤ 后台通知（中高/中/中/PR #27）。主线 `nyra/` 与开发分支 `angel/` 仍有结构差异，禁止自动合并。

## 2026-11-18 增量与候选排序（事实 / 推断分离）

- **已实现、待运行验证（高价值 / 低难度 / 中安全风险 / 无新增依赖）**：Windows 悬空 reparse point 的 `exists()` 误判窗口；源码核对确认此前只在 `exists()` 为真时检查 `lstat`，现已直接检查。模拟回归测试仅编写未运行。
- **优先 1（高价值 / 高难度 / 高安全风险 / 依赖 Windows API 设计）**：Windows ACL 与稳定目录句柄；需先确定 Python 标准库可实现的失败关闭边界，不假定 `st_ino` 等同原生句柄防竞态。
- **优先 2（高价值 / 高难度 / 高安全风险 / 依赖日志及结果核验）**：工具外部副作用证据与人工对账，不自动重放未知结果。
- **优先 3（高价值 / 中高难度 / 高安全风险 / 依赖 #23–#27）**：人工审批安全续跑和任务验收；避免重复已有 PR。
- **优先 4（中高价值 / 中难度 / 中风险 / 依赖任务队列）**：后台任务通知与失败诊断。
- **外部用户反馈（不是 Nyra 已复现事实）**：OpenAI Codex #60973（2026-11，Windows junction 工作目录配置路径异常，https://github.com/openai/codex/issues/60973）；#59843（2026-11-06 Windows 沙箱文件访问异常，https://github.com/openai/codex/issues/59843）。这些日期来自此前调研记录，本轮未独立核实创建日期。**工程推断**：跨平台重解析点和目录身份保护值得优先审查；本轮具体缺陷依据为本仓库源码。

## 2026-11-18 Windows 重解析点兼容与社区反馈

- **源码事实**：此前 Windows junction 检查依赖 Python 3.12+ is_junction；本轮使用标准库 lstat 文件属性拒绝祖先目录 reparse point（价值高/难度低/风险低/依赖现有 ToolJournal；已提交、未运行）。仍非稳定句柄或 ACL 检查。
- **外部反馈事实**：2026-11-18 查阅 [Codex #60973](https://github.com/openai/codex/issues/60973)（Windows junction 工作目录配置问题）及 [Codex #59843](https://github.com/openai/codex/issues/59843)（2026-11-06 Windows sandbox 文件访问拒绝）。这是其他产品的用户报告，不证明 Nyra 同类缺陷。
- **工程推断与后续排序（价值/难度/风险/依赖）**：① Windows ACL 与稳定句柄（高/高/高/原生 API）；② 工具副作用证据（高/高/高/PR #24、#26）；③ 人工审批续跑（高/高/高/PR #25）；④ 任务完成核验（高/中高/中高/PR #26）；⑤ 后台通知（中高/中/中/PR #27）。main 已迁移 nyra/，本分支仍为 angel/，不合并。

## 2026-11-18 未结调用门禁与审批失败反馈

- **源码事实**：此前 `begin()` 只阻止 `journal_ambiguous`，未阻止正常格式但尚无 result 的 intent，允许未知副作用未对账时继续发起新调用。本轮对 `unknown_outcomes > 0` 增加失败关闭门禁和测试源码（价值高/难度低/安全风险低/现有 ToolJournal；已提交，未运行测试）。`finish()` 保持可写入结果；多进程竞争窗口未解决。
- **外部反馈事实**：2026-11-18 查阅 [Codex #57532](https://github.com/openai/codex/issues/57532)（2026-10-27 创建），用户报告自动审批在执行前失败且缺少可恢复诊断；[Codex #45395](https://github.com/openai/codex/issues/45395)（2026-09-14 创建）报告审批服务容量错误被显示为安全拒绝。这些是其他产品的用户报告，不是 Nyra 此处缺陷的因果证据。
- **工程推断，未完成优先级（价值/难度/安全风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/高/Windows 原生 API）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批安全续跑及审批失败原因区分（高/高/高/PR #25、可信审批通道）；④ 任务完成条件核验（高/中高/中高/PR #26）；⑤ 后台通知（中高/中/中/PR #27）。主线 `nyra/` 与开发分支 `angel/` 尚未集成，不合并 main。

## 2026-11-18 歧义日志执行门禁与社区调研

- **源码事实**：此前 `begin()` 只检查事件数量，即使 `inspect()` 已识别孤立结果或工具名不匹配，仍可创建新 intent。本轮增加失败关闭门禁及测试源码（价值高/实现难度低/安全风险低/依赖现有 ToolJournal；已提交，未运行测试）。检查和写入之间尚非原子操作。
- **外部用户反馈**：2026-11-18 查阅 [Codex #50771](https://github.com/openai/codex/issues/50771)（2026-10-04 创建），用户报告 Agent 在任务未完成时结束且需要反复催促；[Codex #59305](https://github.com/openai/codex/issues/59305)（2026-11-04 创建），请求工具能够明确结束当前回合。这些是不同产品的用户报告/功能请求，不证明 Nyra 存在相同缺陷，也不是本轮源码问题的直接证据。
- **工程推断与排序（价值/难度/安全风险/依赖）**：① Windows ACL/稳定目录句柄（高/高/高/Win32 API，未完成）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批续跑（高/高/高/PR #25）；④ 任务完成条件独立核验（高/中高/中高/PR #26，候选）；⑤ 后台任务通知（中高/中/中/PR #27）。主线 `nyra/` 与本分支 `angel/` 尚未集成，避免重复开放 PR。

## 2026-11-18 ToolJournal 写入后完整性检查与公开反馈

- **源码事实**：此前 `_write()` 在 fsync 后没有复核已打开文件的大小、硬链接数量与权限；本轮加入失败关闭检查和测试源码（价值中高/实现难度低/安全风险低/依赖 ToolJournal；静态检查，未运行测试）。此措施不能防止同权限恶意篡改。
- **外部用户反馈**：2026-11-18 检索 [Codex #62082](https://github.com/openai/codex/issues/62082)，Windows 用户报告会话线程文件锁长期占用；[Codex #62023](https://github.com/openai/codex/issues/62023) 描述 2026-11-17 浏览器操作在成功登录后仍终止任务。原始创建日期未取得；均为外部个案，不能证明 Nyra 存在相同故障。
- **工程推断排序（价值/难度/安全风险/依赖）**：① Windows ACL 与稳定句柄（高/高/高/Win32 API，未完成）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 浏览器失败可诊断恢复（中高/中高/高/权限验证）；⑤ 后台通知（中高/中/中/PR #27）。主分支已迁移 nyra/，开发分支仍使用 angel/，且 PR #30 涉及 CI 修复；禁止直接合并。

## 2026-11-18 Windows junction 路径防护与需求调研

- **源码事实**：`_safe_directory` 只检查 `Path.is_symlink()`，Windows NTFS junction 可能不被识别。本轮新增支持时调用 `Path.is_junction()` 的失败关闭检查与模拟测试源码（价值高/难度低/安全风险低/依赖 Python 3.12+ 标准库；已提交待验证）。不添加强制依赖；旧版 Python 保持现状。
- **外部用户反馈**：[Codex #58213](https://github.com/openai/codex/issues/58213)（2026-10-30 创建）报告 Windows 路径重解析点与授权工作区根不一致；[Codex #60973](https://github.com/openai/codex/issues/60973)（2026-11-13 左右，具体创建日未独立核实）报告 junction 工作目录触发错误配置路径拒绝。2026-11-18 查阅。均为外部个案，不证明 Nyra 存在相同故障。
- **工程推断排序（价值/难度/安全风险/依赖）**：① Windows 原生 ACL 与稳定目录句柄（高/高/高/Win32 API，未完成）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批续跑（高/高/高/PR #25）；④ 浏览器故障可诊断恢复（中高/中高/高/权限和验证）；⑤ 后台通知（中高/中/中/PR #27）。main 已迁移 `nyra/`，本分支仍为 `angel/`，禁止未经审查直接合并。

## 2026-11-18 跨工具结果歧义及公开反馈

- **源码事实**：同一 call_id 的 intent/result 工具名不一致时，旧版 `inspect()` 标记 `journal_ambiguous`，但仍将单个 `result_ok` 计为成功。本轮改为 unknown（价值中高/难度低/安全风险低/依赖现有 ToolJournal；已提交、测试未运行）。
- **外部用户反馈**：[Codex #61130](https://github.com/openai/codex/issues/61130)，用户报告 2026-11-12 Windows 浏览器 URL 校验失败导致任务中断；[Codex #56260](https://github.com/openai/codex/issues/56260)，用户报告 2026-10-21 Windows 浏览器 URL 读取失败。2026-11-18 查阅。日期来自报告中的观察时间，不等同于 issue 创建日期；均为独立反馈，不能证明 Nyra 具有相同故障。
- **工程推断排序（价值/难度/安全风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/中高/Windows API）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批安全续跑（高/高/高/PR #25）；④ 浏览器故障的可诊断、不中断无关任务的恢复（中高/中高/高/浏览器权限与可验证 URL）；⑤ 后台通知（中高/中/中/PR #27）。主线 `nyra/` 与本分支 `angel/` 的集成仍未处理。

## 2026-11-18 孤立结果失败关闭与候选排序

- **源码事实**：`inspect()` 对只有 result、没有 intent 的分组设置 `journal_ambiguous`，但 `unknown_outcomes` 原先仅统计有 intent 的调用，可能错误显示 0。本轮将孤立结果组计入未知（价值中高/难度低/安全风险低/依赖 ToolJournal；已提交，测试未运行）。
- **外部反馈线索**：此前记录的 [Codex #40646](https://github.com/openai/codex/issues/40646)（2026-08-25）涉及任务完成证据不足；本轮未重新核实原始发布日期。该用户反馈不证明 Nyra 有相同问题，修复依据是源码静态分析。
- **工程推断，后续优先级（价值/难度/安全风险/依赖）**：① Windows ACL 与稳定目录句柄（高/高/中高/Windows API）；② 工具副作用独立证据（高/高/高/PR #24、#26）；③ 人工审批续跑（高/高/高/PR #25）；④ 后台通知（中高/中/中/PR #27）。开发分支 `angel/` 与 main `nyra/` 的集成风险仍在；不合并 main。

## 2026-11-18 ToolJournal 短读取防护与外部反馈

- **源码事实**：原读取逻辑检查文件大小上限及读取前后元数据，但未比较实际读取字节数与 st_size；可解析 JSON 的短读取可能被接受。本轮补齐长度一致性校验与测试源码（价值中/难度低/安全风险低/依赖 ToolJournal；已实现、未运行验证）。
- **外部用户报告（2026-11-18 查阅）**：[Codex #58708](https://github.com/openai/codex/issues/58708)，创建于 2026-11-01，报告 Windows 长任务被中断并转为响应 AGENTS.md；[Codex #52961](https://github.com/openai/codex/issues/52961)，创建于 2026-10-10，报告 Windows/WSL 工具启动及会话恢复故障。均为外部个案，不证明 Nyra 存在同类缺陷，更不证明本次短读取问题。
- **工程推断排序（价值/难度/安全风险/依赖）**：① 短读取失败关闭（中/低/低/ToolJournal，已提交待验证）；② Windows ACL 与稳定目录句柄（高/高/中高/Windows 原生 API）；③ 工具副作用独立证据（高/高/高/PR #24、#26）；④ 人工审批续跑（高/高/高/PR #25）；⑤ 后台通知（中高/中/中/PR #27）。main 已迁移 nyra/，当前开发分支仍为 angel/，需单独审查兼容性。

## 2026-11-18 读取期间目录项替换检测

- **源码事实**：此前读取前核对目录项，读取后仅复核打开的 fd；目录项可能在读取期间指向另一 inode。本轮新增读取后复核（价值中高/难度低/风险低/依赖 ToolJournal；已实现待验证）。
- **用户反馈线索**：[Codex #40646](https://github.com/openai/codex/issues/40646)（此前记录 2026-08-25，2026-11-18 未独立复核日期）讨论长任务证据可信度，不能证明 Nyra 的具体缺陷。
- **工程推断排序**：Windows ACL 与稳定句柄（高/高/中高/平台 API）；工具副作用证据（高/高/高/PR #24、#26）；人工审批续跑（高/高/高/PR #25）；后台通知（中高/中/中/PR #27）。主线 nyra/ 与开发分支 angel/ 的迁移冲突待解决。

## 2026-11-18 非阻塞事件打开与可靠性调研

- **源码事实**：ToolJournal 在 `fstat` 验证普通文件前以阻塞模式 `os.open(O_RDONLY)` 打开 `.json`；POSIX FIFO 可使读取等待写端而卡住。此轮增加 `O_NONBLOCK`（价值中高/难度低/风险低/依赖现有日志模块），附静态测试源码；未执行验证。
- **外部反馈事实**：[Codex #35435](https://github.com/openai/codex/issues/35435)，创建 2026-07-26，报告 agent 关闭等待无限期阻塞及进程/管道句柄滞留；[Codex #40646](https://github.com/openai/codex/issues/40646)，创建 2026-08-25，报告长任务约束与执行证据失真。2026-11-18 查阅。二者是独立用户个案，不是 Nyra 的 FIFO 缺陷证据。
- **工程推断优先级（价值/难度/安全风险/依赖）**：① 非阻塞事件打开（中高/低/低/ToolJournal，已提交待验证）；② Windows ACL 与稳定目录句柄（高/高/中高/Windows 原生 API）；③ 工具副作用证据（高/高/高/PR #24、#26）；④ 人工审批安全续跑（高/高/高/PR #25）；⑤ 后台事件通知（中高/中/中/PR #27）。开发分支仍是 `angel/`，main 已迁移 `nyra/`，不可直接合并。

## 2026-11-18 写入侧资源清理与 Windows 续跑反馈

- **源码事实**：`_write()` 两条分支均在 `os.open` 后直接调用 `os.fdopen`；若后者抛异常，fd 不会被 with 管理。本轮增加异常关闭和回归测试源码（价值中/难度低/安全风险低/依赖 ToolJournal；已提交、未运行）。
- **外部反馈事实（2026-11-18 检索 GitHub Issue 正文，创建日期未获取）**：[Codex #60231](https://github.com/openai/codex/issues/60231) Windows 用户报告已有会话继续时出现 Unknown error；[Codex #60787](https://github.com/openai/codex/issues/60787) Windows 用户报告非项目历史会话无法恢复，提示 AbsolutePathBuf 缺少 base path。均为用户个案，不代表 Angel/Nyra 复现或因果证据。
- **工程推断排序（价值/难度/安全风险/依赖）**：① 写入 fdopen 异常清理（中/低/低/现有 ToolJournal，本轮已实现待验证）；② Windows ACL 与稳定目录句柄（高/高/中高/Windows 原生 API，未实现）；③ 工具副作用独立证据（高/高/高/PR #24、#26）；④ 人工审批安全续跑（高/高/高/PR #25）；⑤ 后台事件通知（中高/中/中/PR #27）。
- **集成风险**：开发分支仍使用 `angel/`，main 已迁移 `nyra/` 并加入 worker 协议；开放 PR #23–#29 尚需逐项审查。禁止未经授权合并/变基，未知结果不得自动重放。

## 2026-11-18 ToolJournal 异常资源清理与需求排序

- **源码事实**：`_records()` 先 `os.open` 再 `os.fdopen`；后者抛异常时原路径不会关闭 fd。本轮补充异常关闭与回归测试源码，未执行验证。价值中/难度低/安全风险低/依赖现有 ToolJournal。
- **外部反馈（历史线索，非本轮重新核实）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 长任务约束与证据；[Codex #32188](https://github.com/openai/codex/issues/32188) 后台任务完成通知。属于个案，不证明本缺陷。
- **工程推断排序（价值/难度/安全风险/依赖）**：① fdopen 异常清理（中/低/低/ToolJournal，本轮已提交待验证）；② Windows ACL 与稳定句柄（高/高/中高/Windows 原生 API）；③ 工具副作用证据（高/高/高/PR #24、#26）；④ 人工审批安全续跑（高/高/高/PR #25）；⑤ 后台事件通知（中高/中/中/PR #27）。
- **集成阻塞**：原 `js2005happy/angel` 仓库已重命名为 `js2005happy/nyra`；开发分支仍使用旧 `angel/` 包，main 已进行 Nyra 包重命名。禁止未经审查直接合并或自动变基；开放 PR #23–#29 涉及相邻能力。

## 2026-11-17 同大小原地修改检测与外部反馈

- **源码事实**：ToolJournal 读取前后已有文件身份、大小、权限核验，但缺少 mtime_ns/ctime_ns 变化检测。本轮补充元数据对比及模拟测试源码；只降低部分同大小原地修改未被察觉的概率，尚未运行验证。
- **外部用户反馈事实（2026-11-17 查阅）**：[Codex #48392](https://github.com/openai/codex/issues/48392) 的 2026-11-07 评论描述长任务因额度中断及协作者状态变化；[Codex #40646](https://github.com/openai/codex/issues/40646) 创建于 2026-08-25，报告长任务约束丢失与执行声明缺少证据。均为个案，不是 Angel 故障统计，也不直接证明日志缺陷。
- **工程推断排序（价值/难度/安全风险/依赖）**：① 同大小文件修改元数据检测（中/低/低/ToolJournal，本轮已提交待验证）；② Windows ACL/稳定句柄（高/高/中高/Windows 原生 API 设计）；③ 工具副作用证据（高/高/高/PR #24、#26）；④ 人工审批安全续跑（高/高/高/PR #25）；⑤ 后台事件通知（中高/中/中/PR #27）。开放 PR #23–#27 未合并，避免重复开发。
- **限制**：开发分支相对 main 已分叉；时间戳检查不能防止有权限攻击者恢复时间戳或替换祖先目录，不能据此自动重放工具。

## 2026-11-17 读取期间权限竞态与需求证据

- **源码事实**：ToolJournal 原先仅在读取事件内容前核对事件文件权限/大小；并发 chmod 或截断可能发生于检查之后。本轮增加读取后同一文件句柄的元数据复核及回归测试源码，尚未执行（价值中高/难度低/风险低/依赖现有 ToolJournal）。
- **外部反馈事实（2026-11-17 复核）**：[Codex #43605](https://github.com/openai/codex/issues/43605) 创建于 2026-09-07，请求额度恢复后续跑并在审批或不安全状态停止；[Codex #50771](https://github.com/openai/codex/issues/50771) 创建于 2026-10-04，报告长任务提前结束。这些是用户案例，不证明 Angel 的权限竞态，也不代表总体故障率。
- **工程推断：按价值/难度/安全风险/依赖排序**：① 事件读取后复核（中高/低/低/ToolJournal，已提交待验证）；② Windows ACL 与稳定句柄（高/高/中高/平台 API）；③ 工具副作用独立证据（高/高/高/PR #24、#26）；④ 审批与安全续跑（高/高/高/PR #25）；⑤ 后台通知（中高/中/中/PR #27）。开放 PR #23–#27 尚未合并，不重复实现。
- **残余风险**：同用户原地等长篡改无法通过 stat 检测；Windows ACL 未验证；任何日志都不等于外部工具执行完成的证据。

## 2026-11-17 本轮：事件时间戳校验与后续排序

- **源码事实**：ToolJournal 写入 UTC 秒精度时间戳，但读取侧原先只检查 `at` 为长度不超过 40 的字符串，允许任意时间文本。本轮补充严格格式与合法性校验，新增测试源码；**尚未运行**。
- **外部需求事实（历史线索，未在本轮独立复核）**：[Codex #40646](https://github.com/openai/codex/issues/40646)（此前记录为 2026-08-25）涉及任务约束与完成证据；[Codex #32188](https://github.com/openai/codex/issues/32188)（此前记录为 2026-07-10）涉及后台任务完成通知。它们不直接证明 Angel 的时间戳问题。
- **工程推断，按价值/难度/安全风险/依赖排序**：① 时间戳合法性（中/低/低/ToolJournal，已实现待测试）；② Windows ACL 与稳定句柄（高/高/中高/平台 API 审计）；③ 工具副作用证据（高/高/高/PR #24、#26）；④ 人工审批续跑（高/高/高/PR #25、幂等分类）；⑤ 后台通知（中高/中/中/PR #27）。开放 PR #23–#27 已覆盖相邻能力，避免重复开发。

## 2026-11-17 本轮优先级：安全错误可诊断性

- **源码事实**：`JournalError(ValueError)` 被 `_records()` 的 `except (..., ValueError)` 捕获，导致重复 JSON 字段的明确拒绝原因被掩盖。本轮已修复并增加回归测试源码，待运行验证（价值中高/难度低/风险低/现有 ToolJournal）。
- **外部需求线索（2026-11-17 核对仓库）**：Angel 开放 PR [#23](https://github.com/js2005happy/angel/pull/23)–[#27](https://github.com/js2005happy/angel/pull/27) 已覆盖原子会话、运行日志、续跑、结果验证和后台队列；避免在开发分支重复实现。此前记录的 [Codex #40646](https://github.com/openai/codex/issues/40646) 为外部用户反馈，日期与具体内容本轮未重新独立核实，不证明 Angel 同类缺陷。
- **工程推断排序（价值/难度/安全风险/依赖）**：① 安全错误分类（中高/低/低/现有日志，已提交待测）；② Windows ACL 与稳定目录句柄（高/高/中高/平台原生 API 审计）；③ 工具副作用证据（高/高/高/PR #24、#26）；④ 人工审批续跑（高/高/高/PR #25、幂等分类）；⑤ 后台通知（中高/中/中/PR #27）。默认不自动重放未知工具结果。


### 2026-11-17 事件文件权限与用户需求证据

- **源码事实**：会话目录权限已有 POSIX 校验，但 `_records` 对已有事件文件仅检查类型/大小/硬链接数量，没有拒绝被 chmod 为 0644 的文件。本轮补充已打开文件的权限校验（高价值/低难度/低风险/依赖 ToolJournal；已提交待测试）。
- **社区事实（2026-11-17 检索，具体创建日期未取得）**：[Codex #58464](https://github.com/openai/codex/issues/58464) 请求额度恢复后选择性自动续跑及敏感操作确认；[Codex #61087](https://github.com/openai/codex/issues/61087) 报告 Windows 10 任务恢复路径和沙箱初始化失败。这些是外部个案，不证明 Angel 存在相同故障。
- **工程推断排序（价值/难度/安全风险/依赖）**：① 既有事件文件权限拒绝（高/低/低/ToolJournal，已实现未测试）；② Windows ACL 与稳定目录句柄（高/高/中高/Windows API 设计）；③ 可靠执行证据（高/中高/中/PR #24、#26）；④ 人工审批安全续跑（高/高/高/PR #25、外部副作用对账）；⑤ 后台通知（中高/中/中/PR #27）。不自动重放未知结果，不添加强制依赖。
### 2026-11-17 日志目录句柄权限竞态与需求排序

- **源码事实**：原有 POSIX 路径权限检查发生在目录 fd 打开之前；fd 校验仅比较目录身份，没有检查 fd 所指目录权限是否已变宽。本轮补充读写句柄权限复查，待运行验证。
- **社区线索（历史已记录，日期待再次独立复核）**：2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务约束与证据问题；2026-07-10 [Codex #32188](https://github.com/openai/codex/issues/32188) 请求后台完成事件唤醒。均为个案，与本次 chmod 竞态没有直接因果证据。
- **工程推断排序（价值/难度/安全风险/依赖）**：① POSIX fd 权限复查（高/低/低/既有日志，已提交待测试）；② Windows ACL 与稳定句柄（高/高/中高/Windows API）；③ 任务结果证据（高/中高/中/可信日志、PR #26）；④ 安全续跑审批（高/高/高/副作用对账、PR #25）；⑤ 后台事件通知（中高/中/中/PR #27）。不自动恢复未知结果。

### 2026-11-17 既有日志目录隐私边界与调研复核

- **源码事实**：此前仅对新建目录请求 `0o700`，未拒绝历史上权限过宽的 POSIX 会话目录。本轮增加拒绝读取/写入，不静默修复权限；静态审阅、待测试。
- **外部事实（独立核对日期）**：2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) 用户报告长任务违背约束与缺乏执行证据；2026-07-10 [Codex #32188](https://github.com/openai/codex/issues/32188) 用户请求后台任务完成事件驱动唤醒。均为个案，不是 Agent 故障率统计。
- **工程推断与排序（价值/难度/安全风险/依赖）**：① 既有目录权限失败关闭（高/低/低/现有 ToolJournal，已提交待测试）；② Windows ACL 与稳定目录句柄（高/高/中高/平台 API 调研）；③ 执行证据与人工批准恢复（高/高/高/幂等与现有 PR #23–#26）；④ 事件驱动后台任务（中高/中高/中/PR #27）。核心不新增强制依赖，不自动重放未知结果。

### 2026-11-17 社区证据与隐私安全增量

- **事实（2026-08-25）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 报告长任务约束漂移及未经证据支持的完成声明；属用户个案，非 Angel 故障率。
- **事实（2026-07-10）**：[Codex #32188](https://github.com/openai/codex/issues/32188) 请求后台命令完成时事件驱动唤醒，以减少轮询。
- **推断与排序**：① ToolJournal 新会话目录权限收紧（高价值/低难度/低风险/无新依赖；本轮已提交，待测试）；② Windows 原生安全文件句柄与 ACL 核验（高价值/高难度/高风险/依赖平台设计）；③ 执行证据与人工审批恢复（高价值/高难度/高风险/依赖幂等分类，避免与开放 PR #23–#27 重复）；④ 事件驱动后台状态（中高价值/中高难度/中风险/依赖后台任务事件，避免与 PR #27 冲突）。
- **边界**：不更改已有日志目录权限；本轮不运行测试、不合并、不发布。

# Angel 功能迭代队列

## 2026-11-17 当前静态审阅与下一步

- **代码事实**：`test_hardlinked_event_is_rejected` 调用 `os.link`，原测试模块缺少 `import os`。本轮先修复该明确的回归测试阻塞（价值中/难度低/安全风险低/依赖现有测试），已提交但未执行。
- **外部反馈（历史线索，日期未在本轮独立核实）**：[Codex #50771](https://github.com/openai/codex/issues/50771)、[Codex #40646](https://github.com/openai/codex/issues/40646)；这些是个案，不构成 Angel 故障率证据。
- **后续候选排序（工程推断，价值/难度/安全风险/依赖）**：① Windows 稳定目录句柄（高/高/中高/Windows API 调研）；② 任务完成证据关联（高/中高/中/可靠日志）；③ 人工审批续跑（高/高/高/副作用对账）；④ 成本硬上限（高/中/中/用量统计）。不得在未经验证时宣称安全自动恢复。


## 2026-11-17 文件身份检查与优先级

- **代码事实**：此前读取事件时只检查已打开文件的类型和大小，Windows 缺少 O_NOFOLLOW；本轮加入目录条目身份核对与硬链接拒绝，不能消除全部竞态。
- **外部反馈（此前记录，日期待独立复核）**：2026-10-04 [Codex #50771](https://github.com/openai/codex/issues/50771) 长任务中断；2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) 完成证据与约束。个案不能代表 Angel 故障率。
- **工程推断排序（价值/难度/安全风险/依赖）**：① 事件文件身份检查（高/低/低/现有日志，已提交待测试）；② Windows 稳定目录句柄（高/高/中高/平台 API）；③ 执行证据关联（高/中高/中/可信日志）；④ 人工审批恢复（高/高/高/副作用对账）；⑤ 成本硬上限（高/中/中/可信用量）。


## 2026-11-17 事件解析歧义加固

- **代码事实**：默认 JSON 解析对重复键采用后值覆盖，且 Python 中 True == 1。**工程推断**：保守拒绝歧义记录有利于人工核查，不等于外部副作用可验证。
- **外部用户反馈**：2026-10-04 [Codex #50771](https://github.com/openai/codex/issues/50771) 反馈长任务提前结束；2026-08-25 [Codex #40646](https://github.com/openai/codex/issues/40646) 反馈约束与完成证据问题。均为个案，不是 Angel 故障率。
- **排序（价值/难度/安全风险/依赖）**：① JSON 歧义字段拒绝（中高/低/低/现有日志，已实现待测试）；② Windows 句柄与祖先竞态（高/高/中高/平台 API）；③ 工具证据关联（高/中高/中/可信日志）；④ 人工恢复与副作用对账（高/高/高/前述能力）；⑤ 成本硬上限（高/中/中/用量）。


## 2026-11-17 新一轮用户反馈与执行日志优先级

- **事实（2026-08-25）**：[Codex #40646](https://github.com/openai/codex/issues/40646) 用户报告长任务违反范围约束及没有证据的完成声明；**事实（2026-10-04）**：[Codex #50771](https://github.com/openai/codex/issues/50771) 用户报告 Agent 提前结束、需要重复要求继续。均为个案，不代表 Angel 的实际故障率。
- **工程推断（价值/难度/安全风险/依赖）**：① POSIX 读侧稳定目录句柄（高/中/低中/现有日志，**本轮已提交、待测试**）；② Windows 稳定句柄与目录祖先竞态防护（高/高/中高/平台 API，待开发）；③ 任务约束/执行证据关联（高/中高/中/可靠日志）；④ 安全续跑人工审批与副作用对账（高/高/高/可信事件）；⑤ 成本硬上限（高/中/中/准确用量）。不将本地结果日志当作外部执行完成证明。


## 2026-11-17 调研与优先级：安全续跑（本轮）

- **外部事实（2026-09-07）**：Codex [#43605](https://github.com/openai/codex/issues/43605) 提议额度重置后持久续跑，并要求审批、权限变更及仓库变更时停止自动续跑；属于用户功能请求，不是 Angel 故障率数据。
- **外部事实（2026-10-21）**：Codex [#48392](https://github.com/openai/codex/issues/48392) 用户建议单次续跑授权、可取消、执行前核对已完成及进行中副作用；属于用户反馈。
- **工程推断及排序（价值/难度/风险/依赖）**：① POSIX 写侧目录句柄绑定（高/低中/低/既有日志，**本轮已提交、未测试**）；② 读侧目录句柄与 Windows 安全文件句柄（高/中高/中/平台差异，待开发）；③ 执行副作用对账和一次性恢复审批（高/高/高/可信事件）；④ 额度耗尽后安全暂停与状态持久化（高/中高/中/状态机）；⑤ 成本硬上限（高/中/中/可信 usage）。不得把用户希望自动续跑当成授权直接重放外部工具。


## 本轮增量与候选优先级（2026-11-17）

| 优先级 | 候选 | 价值/难度 | 安全与依赖 | 状态 |
|---|---|---|---|---|
| 1 | ToolJournal 目录身份变化检测 | 高/低 | 不改变工具执行权限，依赖现有日志模块 | 已提交开发分支，静态检查未执行测试 |
| 2 | 稳定目录句柄及原子文件操作（POSIX/Windows） | 高/中高 | 跨平台 API 差异、TOCTOU，需先验证平台行为 | 待开发 |
| 3 | 可信断点恢复审批与副作用对账 | 高/高 | 依赖稳定日志和工具幂等策略 | 待开发 |
| 4 | 成本预算硬限制与未上报用量处理 | 高/中 | 依赖模型计费数据和预算策略 | 待开发 |

**事实来源（已知案例，非 Angel 故障统计）：** 2026-09-21 OpenClaw issue #155018（恢复状态报告异常），https://github.com/openclaw/openclaw/issues/155018；2026-10-15 Codex issue #54393（长任务中断反馈），https://github.com/openai/codex/issues/54393。**工程推断：** 因为 Angel 已具备工具事件日志，但文件系统一致性尚不完善，先加固日志可靠性，再实现自动恢复，较直接重试更安全。来源日期需在后续独立核验。


## 2026-11-17 文件名绑定与外部反馈复核
- 代码事实：旧 _records() 未绑定文件名与事件 JSON；本轮修复，防止重命名结果文件逃避读取时的排他槽检查。测试未运行。推断：提高损坏日志可检测性，但不是防篡改审计。
- 外部事实：2026-08-24 OpenClaw #128714 报告重复工具调用后工具结果缺失（https://github.com/openclaw/openclaw/issues/128714）；2026-09-30 Codex #49743 报告 Windows 输入队列阻塞（https://github.com/openai/codex/issues/49743），后者不是重复执行的直接证据。个案不能代表 Angel 故障率。
- 优先级（价值/难度/风险/依赖）：① 文件名绑定（高/低/低/现有日志，本轮已提交）；② 目录句柄安全（高/中高/中高/跨平台）；③ 结构化工具返回状态（高/中/中/兼容接口）；④ 副作用对账与人工恢复（高/高/高/前述能力）；⑤ 预算硬上限（高/中/中/可信 usage）。


## 2026-11-17 新增用户反馈与优先级复核

- **事实（2026-10-07/08）**：[Codex #49743](https://github.com/openai/codex/issues/49743) 报告已处理指令因队列问题再次投递，可能重复执行；原因仍未确认。**事实（2026-08-24）**：[OpenClaw #128714](https://github.com/openclaw/openclaw/issues/128714) 报告重复工具调用后出现缺失结果和模糊状态；维护者未确认所猜测的去重机制。上述均为用户案例，不能推断 Angel 故障率。
- **工程推断/排序（价值/难度/风险/依赖）**：① 工具日志同一调用结果单提交（高/低/低，依赖既有 ToolJournal，**本轮已提交待验证**）；② 目录替换及跨进程日志边界（高/中/中，依赖文件句柄安全设计）；③ 副作用执行幂等与人工对账（高/高/高，依赖工具分类及远端状态核验）；④ 成本硬上限（高/中/中，依赖准确 usage）；⑤ 多 Agent 状态板（中高/中/中，依赖可靠事件）。不能把单结果日志写入当作阻止工具重复执行。


## 2026-11-17 工具异常结果安全处理（本轮）

- **事实（源码，2026-11-17）：** 工具执行抛异常时原先可能留下未完成 intent；本轮补充异常收尾，日志可写时记录 `result_error`，仍要求人工核对外部副作用；写入失败时保留 unknown。静态审阅，未运行测试。
- **事实（社区证据，2026-09-21）：** [OpenClaw #155018](https://github.com/openclaw/openclaw/issues/155018) 报告恢复上下文错误却误报成功；**事实（2026-10-15）：** [Codex #54393](https://github.com/openai/codex/issues/54393) 记录长任务提前结束与额外审查成本。两者是个案，不代表 Agent 用户总体故障率。**工程推断：** 先把异常状态和恢复边界保守处理，再增加自动恢复。
- **下一阶段按价值/难度/安全风险/依赖排序：** ① 跨进程事件冲突和目录替换保护（高/中高/高，依赖现有日志）；② 返回型工具错误结构化分类（高/中/中，依赖工具接口兼容方案）；③ 只读日志 CLI（中/低/低，依赖日志读取安全）；④ 人工批准恢复（高/高/高，依赖前述能力与副作用幂等审查）。继续保持无强制第三方依赖。

## 2026-11-17 工具日志执行边界进展

- **事实（代码）：** 已增加显式注入 `ToolJournal` 的主循环前后记录，默认关闭；测试仅编写未运行。**推断：** 先拒绝无法记录意图的工具执行，比立即提供自动重试更安全。
- 依价值/难度/风险/依赖排序：① 结构化工具错误结果与异常处理（高/中/中，当前错误字符串推断不可靠）；② 跨进程日志冲突和路径安全（高/中高/高）；③ 只读诊断及用户显式启用 CLI（中高/中/低）；④ 人工确认断点恢复（高/高/高，依赖前三项）。
- 外部需求证据沿用 2026-10-15 [Codex #54393](https://github.com/openai/codex/issues/54393) 和 2026-09-21 [OpenClaw #155018](https://github.com/openclaw/openclaw/issues/155018) 的个案，不能推断整体发生率。


## 2026-11-17 新增需求证据：工具执行日志与断点恢复

- **事实（2026-10-15）：** [Codex #54393](https://github.com/openai/codex/issues/54393) 记录长任务提前结束、无必要审查增加时间与 token 消耗；是用户个案，不是总体发生率。**推断：** 任务执行应有可追踪的意图与结果状态。
- **事实（2026-09-21）：** [OpenClaw #155018](https://github.com/openclaw/openclaw/issues/155018) 描述重试时没有正确恢复已保存的任务上下文，却被当成成功；是具体故障报告。**推断：** 重试前应区分未知执行结果与安全可恢复状态。
- **事实（2026-06-01）：** [Handoff Debt 研究](https://arxiv.org/abs/2606.02875) 报告结构化交接记录有助于降低接手任务的重新发现成本；不直接证明 Angel 的恢复能力。**推断：** 先建立最小化、可核查的事件数据模型。

按价值/难度/风险/依赖排序：① 工具意图与结果元数据日志（高价值/低中难度/低风险，**已完成基础模块及显式注入执行边界，未运行测试**）；② 接入 Agent 工具调用前后（已静态实现显式注入；异常分类及结果写入失败仍需验证）；③ 跨进程一致性与安全恢复审批（高价值/高难度/高风险，依赖事件持久化与幂等工具分类）；④ 预算硬停止（高价值/中难度/中风险，依赖实际 usage）；⑤ 可信多 Agent 状态板（中高价值/中难度/中风险，依赖可靠事件）。所有外部自动化保持默认关闭。


排序依据：预期使用价值 ÷ 实现难度，结合安全风险、依赖关系与现有代码基础调整。所有功能优先选用合适的技术栈，保持核心无强制第三方依赖；实际可按需使用原生 JavaScript 等。

## Agent 发现与协作网络：EigenFlux（可选）

| 阶段 | 目标 | 当前状态与安全边界 |
|---|---|---|
| E1 | bare-CLI 独立 Home 与本地 doctor | 已实现 PR #21：独立 Home 与按需本地 CLI 验证，不安装、不认证、不广播 |
| E2a | 逐机器人本地网络行为上限与审计 | 已实现 PR #22：默认拒绝、显式意向/撤销、独立群实例；**不等于官方网络授权** |
| E2 | 经用户批准的安装与 ef-onboarding | 待开发：只作用当前 Agent；邮箱/公开资料/身份授权由官方前台流程完成 |
| E3 | 收件箱、feed、订阅与公开广播 | 待开发：逐项授权、公开信号过滤、持久任务与可审计状态，默认禁止 |
| E4 | 多机器人协作匹配 | 待开发：仅共享明确允许公开的信息，按 Agent 单独预算与权限 |

EigenFlux 不替代 Angel 的本地 agent 编排或 Poppy 身份模型。网络安装与公开发布/订阅是不同的授权决定；每个独立 Agent 必须持有独立 `EIGENFLUX_HOME`。遵循官方 [`skills/install.md`](https://github.com/phronesis-io/eigenflux/blob/main/skills/install.md)，不自行实现私钥导出或捏造连通状态。

## Agent 协议与商务互通（Poppy / UCP）

| 优先级 | 增量 | 当前状态与边界 |
|---|---|---|
| P1 | Poppy 1.0 公开协议发现，协议优先 | 已实现 PR #18：默认关闭的只读校验与渠道摘要；远端调用尚未实现 |
| P2 | 站点权限账本与 scoped 审批 | 已实现 PR #19：精确站点/账户/scope 本地意向、撤销与审计（部分；远端调用审批尚未实现） |
| P3 | Poppy Session + 认证、HTTP MCP/OpenAPI | 已实现 PR #20：OAuth issuer 双向公共元数据核验（部分）；真实 Session、OAuth 登录、DPoP、HTTP MCP 未实现 |
| P4 | UCP 购物及商店 Agent 对话 | 待开发：真实协议互通验证与交易前人工批准；不能把 discovery 当作已完成购买 |
| P5 | Angel 对外发布自身能力 | 待开发：服务化时再考虑托管 poppy.json 与安全的 MCP/OpenAPI 服务器 |

1.0 官方规范已于 2026-11-14 发布并冻结；实际站点可能仍部署旧版本，严格记录实现版本 1.0，并且默认不开启发现工具；不采用猜测的能力 schema，不因网站声明就自动授予外部权限。该队列与可靠性优先队列并行，不能牺牲正在开发的成本上限和长任务可信度。

## 2026-11-17 用户需求证据与候选排序

公开证据（日期为研究发表或社区记录日期；不把小样本当作总体统计）：

- **事实：** 2026-10-26 [MANDATE 研究](https://arxiv.org/abs/2610.34748) 归纳 163,487 条 Reddit 帖子，并对 73 位用户进一步调查，指出 Agent 长时间运行但没有进展是值得关注的失效类型。**推断：** Angel 应优先提供明确的“中断/等待核查/完成证据不足”状态，而不是自动重试。
- **事实：** 2026-10-15 [Codex 用户 Issue #54393](https://github.com/openai/codex/issues/54393) 报告长任务提前停在部分里程碑、反复派生不必要审查导致时间和额度浪费。单一用户报告不能代表发生率。**推断：** 后续应提供逐阶段验收和任务预算。
- **事实：** 2026-09-06 [Codex Issue #43193](https://github.com/openai/codex/issues/43193) 记录长期执行中未核对目标、额度消耗及审批边界问题；属于社区个案。**推断：** 安全恢复需要显式审批与幂等性标记，不能自动重放副作用。
- **事实：** 2026 H2 [Nylas Agentic AI 调查](https://www.nylas.com/agentic-ai-report-h2-2026/) 受访者 1,030 人，其中 54% 报告近 90 天至少一次 Agent 错误；样本为参与 AI 系统建设/采购/决策的人群，不能外推至所有 Agent 用户。**推断：** 运行证据与人工监督优先级应高于新增网络自动化能力。

候选按价值、难度、安全与依赖综合排序：① 长任务中断可观察性（高价值/低难度/低风险，已提交只读基础）；② 真正断点续跑与验收证据（高价值/高难度/高风险，依赖幂等执行日志）；③ 费用预算硬停止（高价值/中难度/中风险，依赖真实 usage 与定价配置）；④ 多 Agent 运行状态板（中高价值/中难度/中风险，依赖可信事件流）；⑤ 网络自动化与外部消息（价值待验证/高安全风险，继续默认关闭）。

## 2026-11-17 会话诊断误判修复与后续排序

基于上方已列出的 2026-10-26 MANDATE 研究、2026-10-15 Codex Issue #54393 以及 2026-09-06 Issue #43193：**事实**为用户反馈存在长任务停滞、任务中途停止与执行成本/审批困扰；**推断**为应先修复现有会话状态的误判，再构建可验证的执行事件日志。研究样本与社区个案不能用于推断 Angel 的具体故障率。

优先顺序：① 会话诊断误判修复（高价值/低难度/低风险，**本轮已提交，待测试**）；② 持久化工具调用意图与结果日志（高价值/中难度/中风险，需明确崩溃恢复与隐私边界）；③ 可审计的断点续跑（高价值/高难度/高风险，依赖幂等工具分类和外部状态对账）；④ 预算硬停止（高价值/中难度/中风险，依赖真实 usage/定价）；⑤ 多 Agent 可信状态板（中高价值/中难度/中风险，依赖事件日志）。网络广播与外部账户自动化继续排在安全审计之后。

## 可靠性优先队列（根据 2026-11 用户调研更新）

| 优先级 | 功能 | 状态 | 验收标准 |
|---|---|---|---|
| 1 | 持久记忆可见、可管理，压缩后仍可用 | 已实现 PR #17：全局及机器人原文管理（基础版） | 全局及机器人隔离浏览、版本冲突保护、压缩不动 MEMORY.md |
| 2 | 长任务断点续跑 + 结果自证 | 待开发 | 断线后恢复明确状态；实际验证结果未通过时不得宣布完成 |
| 3 | 费用上限及实时成本看板 | 待开发 | 用户设置模型单价与预算，未报告使用量时不能虚报准确金额或假装封顶 |
| 4 | 多 Agent 真实状态板 | 待开发 | 区分排队/运行/等待审批/失败/完成，用真实工具事件与证据标记进度 |

开发原则：优先解决 AI 回答差一点、静默失败、成本不可预期和长会话遗忘，而不是堆砌工具数量。调研百分比视作需求线索，正式产品宣称须复核原始出处。该队列优先于下方旧增量队列。

## 第一梯队

| 排序 | 功能 | 状态 | 说明 |
|---|---|---|---|
| 1 | Token 用量与剩余上下文：/status、网页与一次性执行 | 已合并 PR #9 | 只信任模型 API 报告用量；上下文上限必须有明确配置 |
| 2 | 自动压缩会话 | 已合并 PR #10 | 先保证统计可用；阈值命中时触发 compact，防止反复压缩 |
| 3 | 非交互 --json 输出 | 已实现 PR #11 | JSON Lines 事件协议与稳定退出码，stdout 不掺杂普通日志 |
| 4 | 计划模式 | 已实现 PR #12 | 规划阶段阻止所有副作用；审批后进入执行 |
| 5 | 工作目录写入限制 + 细粒度审批 | 进一步缩小授权作用域（部分，OS 沙箱未完成） | 保护绝对路径与符号链接逃逸；按工具/命令授权 |
| 6 | 检查点与 /undo、/rewind | 已实现 PR #15：本地内置文件版（部分） | 写入前快照，多文件改动可回滚且不丢非本任务改动 |
| 7 | apply_patch /diff | 已实现 PR #16：本地单文件补丁与审批 diff（部分） | 原子补丁、精确上下文与审批时查看差异 |
| 8 | /init 与自定义命令 | 待开发 | AGENTS.md 模板与 commands/*.md |
| 9 | hooks | 待开发 | 前后置钩子、明确超时、失败默认安全处理 |
| 10 | Telegram 网关 | 待开发 | 会话隔离、按钮审批、可靠推送，安全审查后启用 |

## 第二梯队

流式输出、图片输入、会话全文搜索、并行子 Agent、Angel MCP Server、HTTP MCP、Linux 本地沙箱、真实浏览器工具、编辑器集成。

## 开发原则

- 每项需求先写回归测试，再通过 Linux/Windows CI，通过后再合并。
- readonly/auto 不扩大外部工具的执行权限；涉及新网关、自动执行、成本变化时以默认关闭为原则。
- 不把字符数量、固定模型名称推断当成精确 Token 用量。
- 多机器人能力优先保证独立性与任务配额，后续才引入并发与更复杂的服务化组件。
- 不因“一天一个提交”引入无意义修改；失败修复优先于新功能。


## 2026-11-21 — 验收证据绑定与长任务停止条件（调研补充，未实现）

- **公开用户报告（事实）**：2026-11-16 [Codex #61857](https://github.com/openai/codex/issues/61857) 描述长任务把源码修改或局部构建误报为部署界面已满足要求；2026-10-04 [Codex #50771](https://github.com/openai/codex/issues/50771) 报告 Agent 在尚有授权工作时提前结束、需要用户重复催促。这些是外部个案，非 Angel 的复现、统计频率或因果证明。
- **工程推断**：需要把「修改已提交」「静态审阅」「测试通过」「目标环境验收」设为不同证据级别，保留目标、未完成项、验证环境与证据链接；超过有限无进展轮次应停止并标记需人工复核，绝不自动批准副作用重放。
- **排序（价值／实现难度／安全风险／依赖）**：P1 只读验收证据摘要 高／低中／低／现有 session-status 和日志；P1 持久任务契约 高／中／中／隐私最小化存储；P1 无进展熔断 高／中高／中／可信进度事件；P0 claim 接入实际派发 高／高／高／审批与可靠存储；P0 Linux mount namespace 防护 高／高／高／系统权限；P0 Windows reparse 句柄保护 高／高／高／Windows 原生 API。
- **本轮阻塞（源码事实）**：实验性 `scripts/node_tool_claim.ts` 明确未接入运行时；路径检查、procfs 身份复核均无法保证特权挂载竞态安全。未经运行验证，继续叠加局部检查可能产生虚假的 exactly-once 保证，因此不启用、不接入工具执行链。

## 2026-11-22 — 工具失败报告与无进展事件（静态增量）

- **代码事实：** Agent 工具执行返回的 `错误：` 或 `执行失败：` 字符串以前统一记录为 `tool_returned`；现在保守分类为 `tool_failed`，仍按未验证、无进展观察处理，不自动重试、不声称副作用已回滚。仅静态审查，回归定义未执行。
- **外部反馈事实：** 2026-09-24 [Codex #47802](https://github.com/openai/codex/issues/47802) 报告等待子 Agent 时反复轮询与虚假进展；2026-11-07 [Codex #60104](https://github.com/openai/codex/issues/60104) 报告长任务返工及额度浪费。它们是外部个案，未证明 Angel 具有同样故障，也不能代表总体发生率。
- **工程推断：** 将返回型失败与普通工具返回区分，可为后续可信进展来源提供更准确的事件语义；字符串前缀仍不是可信的执行结果证明。
- **候选排序（价值/难度/安全风险/依赖）：** ① 独立可信进展来源 高/中高/中高/验收凭据与工具日志；② 返回型工具结果结构化 高/中/中/现有工具 API 兼容；③ 私有任务契约持久化 高/中/中高/跨平台权限与原子写；④ 人工批准恢复 高/高/高/副作用对账。当前仅完成失败事件分类，不启用自动暂停或恢复。
