# 策略网关（O1，OpenBot CEL 网关借鉴）

Nyra 已有三层审批：红线（业务动作档位）、Soul 红线、P0-5 权限规则
（工具名 + specifier 写法）。这一层补的是缺的**上下文表达式规则**：
写得出“这个 Bot 永不许碰 github.com/settings”“routine 不许发消息”
这类策略，而不是只靠代码里的 if。

## 规则语言（确定性子集，不是完整 CEL）

```
tool.name == "shell" && bot.id != "reviewer"
file.path matches "src/**"
initiator.kind in ["routine", "cron"]
command startsWith "git "
page.host contains "settings"
!(tool.name == "gmail_send")
```

- 比较符：`==` `!=` `<` `<=` `>` `>=` `in` `matches` `startsWith` `contains`
- 布尔：`&&` `||` `!` 与括号
- 字面量：字符串（单/双引号）、数字、`true`/`false`、字符串列表 `["a", "b"]`
- 字段：`tool.name`、`tool.target`、`bot.id`、`actor.id`、`actor.role`、
  `file.path`、`initiator.kind`、`command`、`page.url`、`page.host`、
  `mcp.server`、`mcp.tool`、`mode`
- `matches` 是 glob（`*` 任意字符、`?` 单个字符），与权限规则同款语义
- `in` 的右边须是列表；`<`/`<=`/`>`/`>=` 只用于数字

## 求值次序与 fail-closed

`deny > ask > allow`，都不命中走默认审批流程。

- **deny**：直接拒绝，记运行事件 `policy_denied` 与策略审计（`policy-audit.jsonl`，
  进 SIEM 导出），调用方看到“策略网关拒绝了 …：规则 <id>（…）”。
- **ask**：强制走人工审批链——不走 allow 快路、不走幂等短路、不走脚本预授权
  快路；审批卡上写明是哪条规则要求人工确认。
- **allow**：与权限规则的 allow 同款放行；受保护路径仍须每次审批（不受 allow 影响）。
- **坏规则**：表达式解析失败的规则加不进去（`nyra policy add` 当场报错）；
  已入库的规则求值出错（未知字段、类型不对）时，**deny 按命中处理
  （宁可拦错，不放过），allow/ask 按不命中处理（坏 allow 不放行）**，
  出错一律进警告（`nyra policy status` 可见）。

## 账本与损坏处理

- 账本 `~/.nyra/policy.json`（0600、原子写），审计 `~/.nyra/policy-audit.jsonl`
  （append-only，进 SIEM 导出，见 `docs/governance.md` 的审计导出）。
- 账本文件损坏（JSON 解析失败）时当成“没有策略”，但记一笔审计并把
  corrupt 标出来——**不学 OpenBot“配错直接阻止服务器启动”**：Nyra 是
  单机 CLI，启动被锁等于整机不可用；拒绝加载 + 记账更合适。已有的审批链
  （权限规则、人工审批）不受影响，仍在下面兜底。
- 规则 id 形如 `pol_` + 12 位 hex；规则默认启用。

## 命令

```
nyra policy list                          列出全部规则（含已禁用与警告）
nyra policy add <allow|ask|deny> <表达式> [--description <说明>]
nyra policy remove <规则 id>              删一条规则（进审计）
nyra policy enable|disable <规则 id>      启用 / 停用一条规则（进审计）
nyra policy test --tool <工具> [--target <目标>] [--bot <id>] [--actor <id>]
  [--initiator <person|routine|cron|webhook|handoff|group>] [--file <路径>]
  [--command <命令>]                      演练一次调用，看哪条规则命中
nyra policy dry-run <on|off>              演练模式：只记不拦（默认关）
nyra policy status                        账本状态：规则数、dry-run、损坏与警告
```

## 例子

```sh
# 例行跑命令一律须人批
nyra policy add ask 'initiator.kind == "routine" && tool.name == "shell"' --description "例行跑命令须人批"

# 这个 Bot 永不许读密钥文件
nyra policy add deny 'bot.id == "reviewer" && file.path matches "**/*.pem"' --description "reviewer 不许碰私钥"

# 先演练再上 dry-run，确认无误再关演练
nyra policy test --tool shell --command "rm -rf /tmp/x" --initiator routine
nyra policy dry-run on
```

## 边界（诚实口径）

- 只做确定性规则子集：没有日期/时间字段、没有调用外部服务、没有
  用户自定义函数。需要时间窗口的策略（如“周末不许调付费工具”）暂不支持，
  等 cron 成熟语义那边补时间字段后再接。
- 策略只拦**工具调用**（`checkApproval`），不拦网关 HTTP 路由本身；
  网关层面的策略（按路径/客户端拦）是 H1 的事，不在这里做。
- `page.url`/`page.host` 只在浏览器动作的调用方填了才有值；没填时按空串算。
