// scripts/gen-config-map.ts — 从 explainAll() 生成 docs/CONFIG-MAP.md。
//
// 为什么用脚本生成而不是手写：手写文档必然腐化——代码里加了键，文档半年不动。
// 这里让文档只有一个来源（configExplain.ts），并用测试保证两者一致。
//
// 用法：bun scripts/gen-config-map.ts > docs/CONFIG-MAP.md
//
// 注意：必须用 bun 跑，不能用 node --experimental-strip-types——configExplain
// 经 reconciler → kanban/resume → tasks → tools 传进来一个 Bun 文本 import
//（src/bughunt.ts 的 `with { type: "text" }`），node 载到 .md 就抛
// ERR_UNKNOWN_FILE_EXTENSION（Pi Bot 第 3 条，2026-11-22 实证）。
import { explainAll } from "../src/configExplain.ts";

const items = explainAll({ config: {} });

const lines: string[] = [
  "# 配置速查表（由脚本生成，勿手改）",
  "",
  "> 本文件由 `scripts/gen-config-map.ts` 从 `src/configExplain.ts` 生成。",
  "> 改了配置项请改代码，然后重新生成；`tests/node/test-config-map-sync.test.ts` 会检查两者是否一致。",
  "",
  "查当前生效值：`nyra config explain [能力名]`",
  "",
  "| 能力 | 能改它的键 | 默认值 | 说明 |",
  "|---|---|---|---|",
];

for (const c of items) {
  const keys = c.keys.map((k) => `\`${k}\``).join("<br>");
  const effective = c.effective.replace(/\|/g, "\\|");
  const note = c.note.replace(/\|/g, "\\|");
  lines.push(`| \`${c.capability}\` | ${keys} | ${effective} | ${note} |`);
}

lines.push("");
lines.push("## 生效优先级（通用）");
lines.push("");
lines.push("```");
lines.push("CLI 覆盖  >  config.json  >  环境变量（仅个别能力）  >  默认值");
lines.push("```");
lines.push("");
lines.push("- 环境变量目前只有 `NYRA_LAZY_TOOLS=0`（一票否决延迟加载）与 `NYRA_ALLOW_PROTECTED_WRITES`、`NYRA_ALLOW_READ_OUTSIDE_WORKDIR` 这类显式放开开关");
lines.push("- `--enable-feature` / `--disable-feature` 对同名开关**disable 优先**");
lines.push("- 想确认某次运行到底用了什么：`nyra config explain <能力>`");
lines.push("");
lines.push("## 管理员锁定段（`config.enforced`）");
lines.push("");
lines.push("对齐 Codex `requirements.toml` 的轻量版：写进 `enforced` 的键**优先于 CLI 参数与 `config import`**。");
lines.push("");
lines.push("```json");
lines.push('{ "enforced": { "max_cost_usd": 5, "sandbox": "bwrap", "deny_read_globs": [".env", "**/*.pem"] } }');
lines.push("```");
lines.push("");
lines.push("| 规矩 | 说明 |");
lines.push("|---|---|");
lines.push("| 白名单 | 只接受安全相关的键（`ENFORCEABLE_KEYS`）；名单外的写进去会被忽略**并报出来** |");
lines.push("| 不静默 | 被覆盖的 CLI/配置文件值会列进 `ignoredOverrides`，你能看到自己那行为什么没生效 |");
lines.push("| 双保险 | `config import` 会跳过被锁的键，导入覆盖不了 |");
lines.push("| 不是强边界 | 能改文件的人仍能改 `enforced`；它挡的是「agent 顺手改配置绕过硬顶」这条现实路径 |");
lines.push("");
lines.push("");
lines.push("### 运行时真正生效的锁定范围");
lines.push("");
lines.push("`enforced` 不是装饰。目前**运行时读取路径也认锁定值**的键：");
lines.push("");
lines.push("| 键 | 生效点 |");
lines.push("|---|---|");
lines.push("| `max_cost_usd` | `cli` 建 agent 时（CLI 参数让位） |");
lines.push("| `deny_read_globs` | `tools.ts` 的禁读清单（清空顶层也拦得住） |");
lines.push("| `permissions` | `tools.ts` 的权限规则解析（改 config 放不开 deny） |");
lines.push("| `sandbox` / `sandbox_mode` | `config.ts` 的 `resolveSandbox`（改不回 local / danger-full-access） |");
lines.push("| `verify_command` | `runs.ts` 的 `resolveVerifyOrigin`（config 里的校验命令被顶掉） |");
lines.push("| `disabled_tools` | `cli.ts` 建 agent / savings / tools / redlines 四处（禁用工具不可被改 config 绕过） |");
lines.push("| 其余 `ENFORCEABLE_KEYS` | 只在 `config import` 与展示层生效，运行时暂未消费 |");
lines.push("");
lines.push("优先级：**环境变量（排障用）> `config.enforced` > `config.json` 顶层 > 默认值**。");
lines.push("");
lines.push("> 为什么写这张表：功能说\"锁了\"但运行时没读，比没有这个功能更糟——用户以为锁住了。");
lines.push("`nyra redlines` 会报三种状态：`enforced-empty`（warn，没锁 = 红线靠自觉）、`enforced-active`（ok，列出锁了哪些）、`enforced-rejected`（warn，名单外的键被忽略）。");

process.stdout.write(lines.join("\n") + "\n");
