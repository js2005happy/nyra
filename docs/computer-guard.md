# 真机电脑操作守卫（CUA guard，G-P1-35）

三平台桌面驱动（`src/computer.ts`：Linux xdotool、Windows PowerShell、macOS
osascript）与 5 个 computer 工具（screenshot / click / type / key / windows）
已经有了，走审批门。本批补 Pi `packages/computer/src/guard/` 那层——
blocklist、grants、foreground、activity，只借想法，不抄 Pi 代码。

## 守卫查什么

写动作（click / type / key）动手前必过，顺序如下：

1. **禁按组合键**：`ctrl+alt+delete`、`super+l` 这类锁屏/系统键直接拒绝。
2. **前台窗口禁碰名单**：当前前台窗口标题命中名单（子串匹配，大小写不敏感）
   时不动手。默认名单：系统设置、偏好设置、控制面板、锁屏、密码管理器
   （1Password / Bitwarden / KeePass / LastPass / Dashlane / Enpass / 钥匙串）、
   银行、支付、钱包、支付宝、微信支付、PayPal、凭据、证书管理。
   前台窗口读不到时检查跳过，但活动账本里记 `foreground: unknown`，不谎称已查。
3. **授权（默认关）**：`nyra computer require grant on` 开了才查——须有一张
   可用的授权（没撤销、没过期），会话专属授权优先于整机授权。
4. **虚拟桌面（默认关）**：`nyra computer require display on` 开了才查——
   DISPLAY 必须是本机 Xvfb 虚拟桌面（见下）。
5. **每分钟限流**：默认 60 次/分钟，超了拒绝（含被拒的尝试也计数）。

只读动作（screenshot / windows）不拦，只记账本。任一不过都记 refused
账本与 `computer_refused` 事件，再报中文错误。

## 用法

```sh
nyra computer status
nyra computer grant issue [--session <会话 id>] [--minutes <分钟>] [--label <备注>]
nyra computer grant revoke <授权 id> [--reason <原因>]
nyra computer grants
nyra computer blocklist [add <子串> | remove <子串>]
nyra computer activity [--limit <条数>]
nyra computer display start | stop | status
nyra computer require grant on|off
nyra computer require display on|off
```

- `grant issue` 默认 120 分钟过期；`--minutes 0` 不过期；不带 `--session`
  是整机授权，带了只认该会话。撤销后立即失效。
- `blocklist add/remove` 改的是标题子串名单；禁按组合键目前只改配置文件。
- `activity` 看最近的电脑操作活动：时间、动作、坐标、按键、输入字数、
  前台窗口、授权 id、结果。输入文本只记长度，绝不记内容。

## 虚拟桌面（Xvfb，Linux 才有）

```sh
nyra computer display start    # 起 Xvfb :99，记下 display + pid
nyra computer display stop     # 停掉并清记录
nyra computer display status   # 看在没在跑
```

`display start` 要求 Xvfb 已装（Debian/Ubuntu 用 `sudo apt-get install xvfb`）；
该 display 已在跑时拒绝重复起，不静默回落到真机桌面。`require display on`
之后，写动作只允许在记录的虚拟桌面上跑。

## 账本

- `~/.nyra/computer-guard.json`：守卫配置（0600 原子写，损坏先备份再回默认值）。
- `~/.nyra/computer-grants.json`：授权账本（0600 原子写，损坏先备份再回空账本）。
- `~/.nyra/computer-activity.jsonl`：活动账本（append-only，0600；坏行跳过）。
- `~/.nyra/computer-display.json`：虚拟桌面记录（display + pid）。
- 运行事件 `computer_action` / `computer_refused` 已注册进 `EVENT_FIELDS`：
  只记动作、结果、授权 id 与前台窗口（截断），不记输入文本内容。

## 默认口径

禁碰名单与限流默认开启；授权检查与虚拟桌面检查默认关闭——原有审批门已
覆盖，机主按需收紧（`require grant on` / `require display on`）。三平台
驱动本身是直连本机桌面的，不走沙箱；想隔离请用虚拟桌面或每 Bot 一台持久
电脑（`nyra bot computer`，缺口 42）。真机无人值守自动操作不在本批范围：
敏感操作照样要人批，队列/定时任务里不自动换模型、不自动放行审批的红线不动。

## 诚实边界

只在临时 home / 假 runner / 假电脑对象上验过；`activeWindow` 的三平台
命令（xdotool / PowerShell / osascript）只在测试替身里跑过，没在真机桌面
上跑过；Xvfb 起停没在本机真跑过（只在注入替身上验过逻辑）；Windows/macOS
真机未验证。
