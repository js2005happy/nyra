# 配置速查表（由脚本生成，勿手改）

> 本文件由 `scripts/gen-config-map.ts` 从 `src/configExplain.ts` 生成。
> 改了配置项请改代码，然后重新生成；`tests/node/test-config-map-sync.test.ts` 会检查两者是否一致。

查当前生效值：`nyra config explain [能力名]`

| 能力 | 能改它的键 | 默认值 | 说明 |
|---|---|---|---|
| `tool_search` | `features.tool_search`<br>`tool_search.enabled`<br>`NYRA_LAZY_TOOLS`<br>`--enable-feature tool_search` | off | 未开启：MCP 工具超过 8 个时仍会自动开启 |
| `run_recall` | `features.run_recall`<br>`--disable-feature run_recall`<br>`redlines.thresholds.recallMaxAgeDays` | on | 已开启；过期天数由 redlines.thresholds.recallMaxAgeDays 决定（默认 30） |
| `cost_cap` | `max_cost_usd`<br>`--max-cost` | off | 未设上限：长任务可能无限烧钱 |
| `aux_model_routing` | `compact_model`<br>`delegate_model` | off | 未配置：压缩与子任务都用主模型（成本更高） |
| `plan_act_model_routing` | `plan_model`<br>`act_model` | off | 未配置：规划与执行共用主模型 |
| `reasoning_effort` | `reasoning_effort`<br>`verbosity` | provider 默认 | 未配置：不发这两个字段（payload 与默认一致） |
| `extra_writable_dirs` | `extra_writable_dirs`<br>`--add-dir` | none | 只有工作目录可写 |
| `deny_read_globs` | `deny_read_globs` | 4 条规则 | 命中即拒读：**/.env、**/.ssh/id_*、**/*.pem… |
| `sandbox` | `sandbox`<br>`sandbox_mode`<br>`--sandbox` | auto | auto：Linux 用 bwrap、macOS 用 seatbelt（需显式 --sandbox seatbelt） |
| `nested_delegate` | `delegate_max_depth` | 2 层 | 子 agent 默认不能再委派（flat）；委派时传 orchestrator: true 才允许嵌套，最多嵌套这么多层，每层预算独立记账 |
| `trust_ladder` | `trust_ladder.required_successes`<br>`trust_ladder.spot_check_rate` | 5 次成功/级，抽查 10% | 新 agent / 新技能登记后默认只读；每级要攒够连续成功且零违规才升一级，升级须人点头；每次记成功有概率被随机抽查，抽中须复核才计入；降级随时可做 |
| `reconciler` | `reconciler.enabled`<br>`reconciler.stuck_after_seconds`<br>`reconciler.max_retries`<br>`reconciler.scan_interval_seconds` | 关（只手动扫描） | 看门狗只重排任务板任务（回队列等下一轮 tick），不调模型、不写任务板账本以外的文件、不对外发；超限进 blocked 只等人 reset；无人值守续跑照样强制只读 |
| `watch` | `watch.enabled`<br>`watch.default_interval_seconds` | 关（只手动检查） | Watch 本身只读（抓页面、读文件），不调模型、不对外发；enqueue-task 动作入队后执行时照常走审批；download 动作须人显式批准才执行 |
| `budget` | `budget.strict_unknown_amount`<br>`nyra budget strict --on/--off` | 开（金额未知则暂停） | 未配单价或调用缺用量时，运行暂停并建暂停记录等人工处理（恢复走 nyra governance caps resume） |

## 生效优先级（通用）

```
CLI 覆盖  >  config.json  >  环境变量（仅个别能力）  >  默认值
```

- 环境变量目前只有 `NYRA_LAZY_TOOLS=0`（一票否决延迟加载）与 `NYRA_ALLOW_PROTECTED_WRITES`、`NYRA_ALLOW_READ_OUTSIDE_WORKDIR` 这类显式放开开关
- `--enable-feature` / `--disable-feature` 对同名开关**disable 优先**
- 想确认某次运行到底用了什么：`nyra config explain <能力>`

## 管理员锁定段（`config.enforced`）

对齐 Codex `requirements.toml` 的轻量版：写进 `enforced` 的键**优先于 CLI 参数与 `config import`**。

```json
{ "enforced": { "max_cost_usd": 5, "sandbox": "bwrap", "deny_read_globs": [".env", "**/*.pem"] } }
```

| 规矩 | 说明 |
|---|---|
| 白名单 | 只接受安全相关的键（`ENFORCEABLE_KEYS`）；名单外的写进去会被忽略**并报出来** |
| 不静默 | 被覆盖的 CLI/配置文件值会列进 `ignoredOverrides`，你能看到自己那行为什么没生效 |
| 双保险 | `config import` 会跳过被锁的键，导入覆盖不了 |
| 不是强边界 | 能改文件的人仍能改 `enforced`；它挡的是「agent 顺手改配置绕过硬顶」这条现实路径 |


### 运行时真正生效的锁定范围

`enforced` 不是装饰。目前**运行时读取路径也认锁定值**的键：

| 键 | 生效点 |
|---|---|
| `max_cost_usd` | `cli` 建 agent 时（CLI 参数让位） |
| `deny_read_globs` | `tools.ts` 的禁读清单（清空顶层也拦得住） |
| `permissions` | `tools.ts` 的权限规则解析（改 config 放不开 deny） |
| `sandbox` / `sandbox_mode` | `config.ts` 的 `resolveSandbox`（改不回 local / danger-full-access） |
| `monthly_cost_limit_usd` | `cost.ts` 的 `resolveMonthlyLimit`（改 config 或加 CLI 参数都放宽不了） |
| `verify_command` | `runs.ts` 的 `resolveVerifyOrigin`（config 里的校验命令被顶掉） |
| `disabled_tools` | `cli.ts` 建 agent / savings / tools / redlines 四处（禁用工具不可被改 config 绕过） |
| 其余 `ENFORCEABLE_KEYS` | 只在 `config import` 与展示层生效，运行时暂未消费 |

优先级：**环境变量（排障用）> `config.enforced` > `config.json` 顶层 > 默认值**。

> 为什么写这张表：功能说"锁了"但运行时没读，比没有这个功能更糟——用户以为锁住了。
`nyra redlines` 会报三种状态：`enforced-empty`（warn，没锁 = 红线靠自觉）、`enforced-active`（ok，列出锁了哪些）、`enforced-rejected`（warn，名单外的键被忽略）。
