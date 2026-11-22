# PUSH-PLAN：固定任务评测第一批

日期：2026-11-22（上海时间）。**用户随后授权直接上传。本批将按下述两笔提交上传到独立评审分支，供 Muse 复验、整合；不合并 main。下列验证数字仍为上传前的本地结果。**

## 检出与协调

- 独立检出：`~/workspace/nyra-codex/`。没有使用协调员的 `~/workspace/nyra-p3merge/`。
- 开工先同步远程，得到 `83c405e47ea9738a7576f63250c4be4b4531fa82`；它包含 `4d9c40d` 之后 Muse 已推送的两笔取消代码。
- 期间 Muse 推齐测试、文档；本地快进到 **`840a522e207a838eb6720283d5eeaaf4bfb571f7`**，以此记录最终基线并完整复验。
- 不改取消执行、预算预留、真实业务闭环、能力表或 `desktop/`；没有改变 Agent、工具、provider、Bot 的正常执行路径。`package.json` / `bun.lock` 没有变更。
- 本批与 Muse 的源码没有重复实现；核心邻接修改只有 `src/runs.ts` 的三个新评测事件字段注册。变更记录 中双方的条目都保留，后续邻接冲突应合并两边。

## 改动文件与建议提交

以下是本批上传采用的提交划分与 message。

### 1. `feat(eval): add fixed task harness and bounded regression reruns`

- `src/eval/catalog.ts`：四类各 5 个固定任务、初始夹具、冻结断言、模型与预算定义。
- `src/eval/runner.ts`：执行/阻塞/失败区分，独立夹具重建，最多 2 次额外重跑，保留首次结果；复用 `regression.ts` 的失败元数据，持续保存私有报告。
- `src/eval/checks.ts`：磁盘 JSON、来源及夹具字节校验、DOM 和测试邮箱的独立状态验收。
- `src/eval/fixtures.ts`：只用保留测试域名的内存 Gmail 传输层，拒绝其他写接口，不读取真实账号。
- `src/eval/live.ts`：独立 worker、严格工具响应白名单、本地模型探测、隔离 Chromium/CDP、bwrap 冻结代码测试；沿用 Agent 的成本守卫与 RunRecorder。
- `scripts/eval.ts` / `scripts/eval/worker.ts`：单独开发入口，不向正常 CLI 注入新执行行为。
- `src/runs.ts`：注册 `eval_attempt_started` / `eval_attempt_finished` / `eval_retry_scheduled`，只记 ID、指纹、状态和数值，不记绝对路径。
- `tests/node/test-eval.test.ts`：27 项 mock-only 测试；权限断言使用 `expectPerms`，测试名不含 ASCII 双引号。

### 2. `docs(eval): record prerequisite-blocked baseline and handoff limits`

- `docs/eval.md`：20 个任务、各自实际状态验收、模型/预算/工具限制、重跑条件、指标分母和基线结果。
- `docs/eval-results/baseline-840a522.json`：20 项最终前置条件基线，没有隐藏结果。
- `docs/eval-results/baseline-840a522.events.jsonl`：脱离机器路径的评测事件，可对照每次尝试。
- `docs/eval-results/verification-840a522.json`：本地验证数字及阻塞原因。
- [变更记录](./CHANGELOG.md)：写在现有的「未发布（0.5.4）」里，并保留 Muse 的取消条目。
- `PUSH-PLAN.md`：本交接计划。

**不要提交**输出旁 `.eval-runs/` 中的私有工作区、home、profile、运行状态；不要提交 `node_modules/`、验证原始日志或交接压缩包本身。共享材料中的报告/事件没有 Key、真实账号或绝对路径。

## 修的真问题

1. 子串和工具轨迹不能证明交付成功：现在用冻结测试、实际文件与来源、CDP DOM 和测试邮箱读回验收；只说已完成不会通过。
2. 失败只有元数据不能重演：现在固定任务可在新工作区按相同任务/模型/预算重跑，检查源码、架子、夹具、模型 digest 与观测环境；任意生产副作用不会被重放。
3. 重跑成功不能抹掉第一次失败：首次通过率、重跑恢复数和每次尝试分别保留。
4. 未知成本或异常丢失的指标不能填 0：保留 null，计已知花费下界和未知数量；阻塞不伪装成已执行失败。
5. 工具 schema 隐藏本身不是执行拒绝：评测 provider 响应另有白名单门，构造出的白名单外调用不会到达真实工具；计入验收失败。该门只属于评测入口，不改正常执行路径。

## 本地验证数字

环境：Bun 1.4.5；核心声明依赖使用锁文件安装，锁文件无变更。额外测试工具只装在检出之外。

| 检查 | 结果 |
|---|---|
| `bun x tsc -p tsconfig.json --noEmit` | 0 报错 |
| scripts 独立严格类型检查（附 `src/text-imports.d.ts`） | 0 报错 |
| 新增评测测试 | 27 通过、0 失败 |
| 新增 + runs / regression / contract / CDP / 深化连接器相邻测试 | 120 通过、0 失败，6 文件 |
| 最终 `bun test tests/node` | **3241 通过、13 失败，3254 项 / 229 文件，132.81s** |
| 真实任务前置基线 | **0 通过、0 执行失败、20 阻塞；执行覆盖 0%；已执行成功率 null** |
| 基线模型调用 / API 花费 / 人工介入 | 0 / $0 / 0 |
| 基线预检时间合计 / 墙钟时间 | 3.877 ms / 108.937 ms |
| `git diff --check` | 通过 |
| desktop、正常执行核心和依赖文件差异检查 | 无本批改动 |

完整检查前已清理 `/tmp/nyra-*`，`df -h /tmp` 剩余约 4.9G。为了满足 mock-only、不访问外网，完整检查命令只在当前进程设置：

```bash
GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0=protocol.http.allow GIT_CONFIG_VALUE_0=never \
GIT_CONFIG_KEY_1=protocol.https.allow GIT_CONFIG_VALUE_1=never \
bun test tests/node
```

这不会修改 Git 全局配置。最初未加这层限制的检查曾在既有插件坏 URL 测试等待 5 秒；限制 Git 外网传输后该测试正常通过。开工中间版本还有 5 项取消旧断言不符，快进到 Muse 已推齐的版本后这些也正常通过。没有为此修改取消代码或替换断言。

## 当前未通过项：必须保留，不得写全绿

本机 `os.networkInterfaces()` 在 Node 和 Bun 原生调用均返回权限错误；既有网关和视频测试调用 `getifaddrs` / `uv_interface_addresses` 时失败。相关生产文件与上述 main 完全一致。本批没有靠 mock 系统能力、更改正常执行路径或删断言来绕过。

最终 13 项失败：

- VideoCallTest.test_gather_host_candidates
- VideoCallTest.test_ice_two_ended_virtual_and_frame
- VideoCallTest.test_ice_two_ended_real_udp_guarded
- VideoCallTest.test_webrtc_transport_end_to_end_virtual
- VideoCallTest.test_webrtc_transport_caller_first_still_connects
- VideoCallTest.test_webrtc_transport_end_to_end_real_udp_guarded
- VideoCallTest.test_cli_signal_status_and_ice_gather
- gateway: 无 token / 错 token 一律 403；设备 token 可审批
- settings: 手机切全权要二次确认标记，电脑端不受影响；规则可在手机上撤销
- GmailTest.test_gateway_connectors_endpoint
- GatewayMobileTest.test_pair_flow_device_token_scoped
- GatewayMcpCostTest.test_estimate_shown_before_call_and_limit_blocks
- gateway: /api/setup 首次引导 → /api/keys 保存只回掩码，设备 token 不能管 Key

套件中原有的 4 项发布二进制 smoke 因未构建 dist 而自行跳过，不能算已经完成跨平台安装验证。

## 基线与诚实边界

- 本机 `127.0.0.1:11434` 本地模型服务不可达，**没有有效的真实模型执行基线**；20 条记录都是前置阻塞。不得把模型成功率说成 0%，也不能把 27 项架子单测当成 20 题成绩。
- 第一批 live 只支持 Linux、本地 Ollama；代码判题要求可用 bwrap；浏览器使用一次性 profile，未关闭浏览器自带沙箱。
- 固定研究资料是可复现的受控语料，不是开放互联网检索能力评测；连接器只验 Gmail 工具 + 内存测试邮箱，不验证 OAuth、外部投递、真实 Gmail/Shopify/Slack。
- 人工介入为实际运行中的人工救场次数；入口没有人工救场 UI，固定夹具策略的自动审批另记日志，不算人。
- 模型随机性沿用本地服务默认值，重复条件不保证回答逐字一致。Digest/环境只在开跑时观测，外部中途更换服务不在本批保证范围。
- 三条护城河保留：Agent 事件/产物由 RunRecorder 记录，API 预算走原成本守卫，文件和工具走原审批并在评测入口收紧；没有 full 模式或真实账号旁路。

## Muse 接手顺序

1. 先看当前远程 head，在独立分支应用补丁；本包基于 `840a522`，不要覆盖协调员工作区。
2. 示例：`git apply --3way nyra-eval.patch`。正常相邻冲突保留双方；遇到真正重复实现，比较测试覆盖和行为后弃差留好。尤其保留取消执行与其他并行工作的新增内容。
3. 在允许网卡枚举的环境跑类型、新增、相邻、完整套件。**本包尚未满足全量全绿的验收要求**，先补齐复验结果再推送。
4. 准备本地 `qwen2.5:7b` 服务，运行 `bun run scripts/eval.ts run --out <新基线.json>`；记录全部 20 题，即使执行失败也照实保留。不要把这份全阻塞报告当成有效执行基线。换源码或环境后须新建基线，不能冒充同条件旧报告重跑。
5. 按上述两笔建议提交组织；确认评测报告、变更记录 与实际数字一致后，由 Muse 推送、查 CI。用户已授权将本批上传到独立评审分支；main 的整合与发布仍待复验，不声称远端 CI 已通过。
