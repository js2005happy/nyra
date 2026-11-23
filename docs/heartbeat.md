# Heartbeat 静默巡查 + 推断承诺（缺口 31）

## 巡查：没事别吵我

调度器只会“到点跑任务”，接不住“收件箱有事就告诉我、没事别吵我”。
Heartbeat 补这一层：每 agent 一个 monitor，按间隔批量检查——

```bash
nyra heartbeat add --agent nyra [--every-minutes 30] [--checks inbox_unread,kanban_blocked,resume_pending,stale_runs,fanout_unfinished]
nyra heartbeat list
nyra heartbeat enable|disable --agent nyra
nyra heartbeat remove --agent nyra --yes
nyra heartbeat run --agent nyra [--force]   # 或 --all
```

- **无事安静（NO_REPLY）**：没发现只记审计（`~/.nyra/evidence/heartbeat/<日期>.jsonl`），
  不写收件箱、不发消息。守护进程每轮顺带跑到期的 monitor（`nyra schedule daemon` 的
  轮询器），同样只读、失败只记 stderr。
- **有发现先记证据再汇报**：发现写进审计文件，再写收件箱（不直接发消息打扰）。
- **检查项全是只读**：未读收件箱条数、任务板熔断任务、待续跑子 agent、已中断运行、
  未完成/未回填的后台扇出（`fanout_unfinished`，H-6 的兜底——扇出中断/失败，
  或跑完了没回填时提醒）。
  巡查本身不写、不发——无人值守时这条同样成立（缺口 8 的硬约束）。

默认间隔 30 分钟（5–1440 分钟可配）；未到间隔的跳过，`--force` 重跑。

## 巡检脚本 + 去重 + 唤醒（零 Token 值守，Kooyu 借鉴）

巡查只读本地状态、不调模型；零 Token 值守再加一层“先跑本地脚本预检，无异常静默跳过，只命中才唤醒”：

```bash
nyra heartbeat check-script add --agent nyra --name 磁盘 --command "df -h /tmp" [--mode exit-zero-is-hit|non-empty-stdout-is-hit] [--on-hit notify|wake] [--timeout 30] --yes
nyra heartbeat check-script list --agent nyra
nyra heartbeat check-script run --agent nyra --name 磁盘   # 只探一次，不通知不唤醒
nyra heartbeat check-script remove --agent nyra --name 磁盘 --yes
nyra heartbeat wake --agent nyra --on|--off
nyra heartbeat seen-clear --yes
```

- **巡检脚本**：命令只走本地 `spawnSync`（不拼 shell）、环境变量只给白名单（PATH/HOME/语言/时区/临时目录，不带密钥类变量）、超时默认 30 秒（5–120 秒可配）、输出截断 4000 字。结果三态：`exit-zero-is-hit`（0 命中、1 安静、其他失败）、`non-empty-stdout-is-hit`（stdout 非空命中、退出码非 0 失败）。添加须 `--yes` 显式批准该命令；命令须过无人值守安全检查（`isUnattendedSafeCommand`，与审批规则同一套拒绝清单：rm、sudo、curl、ssh、bash -c、python -c、find、xargs……与含 `; & | $()` 的复合命令一律拒绝；`git --version`、`df -h` 这类“程序 + 纯标志”放行）。批准的是整条命令原文，运行时逐字比对，被改过就拒绝执行。
- **指纹去重**：每条发现按（种类 + 摘要）记 SHA-256 指纹进 `~/.nyra/heartbeat-seen.json`（留最近 1000 条，损坏备份后从空开始）。重复异常只记审计、不写收件箱、不唤醒；摘要变了才算新异常。巡查自己的通知不计入未读（否则未读数每轮涨 1，去重永远不生效）。
- **唤醒**：只有 `fresh`（去重后新的）发现 + 脚本 `onHit=wake` + 该 monitor 开了 `wake` 开关，三条同时满足才唤醒：以 `unattended: true` 入队只读任务（缺口 8：模式强制 readonly），提示词末尾带 `NO_REPLY`。唤醒任务跑完后模型回 `NO_REPLY`（须是模型回复的最后一行）就静默收敛：不写收件箱、不回邮件、不推 Bot 通知；运行记录照常留。先入队成功再记指纹，入队失败不记、下一轮重试。

## 推断承诺：确认一次才生效

模型从对话里推断出的短期跟进（“下周二提醒我看报价”），只进“提议”态：

```bash
nyra heartbeat commitments propose "下周二提醒我看报价" --remind-at <ISO> --expires-at <ISO> [--agent nyra] [--channel telegram]
nyra heartbeat commitments confirm <承诺 id>   # 用户确认一次
nyra heartbeat commitments list [--status proposed|confirmed|reminded|expired|done]
nyra heartbeat commitments done <承诺 id>
nyra heartbeat commitments expire              # 过期扫荡
nyra heartbeat commitments remind              # 到期提醒
```

- 提议须用户确认一次才生效；确认两次拒绝；过期自动失效——不永久驻留记忆，
  与缺口 2（记忆删除）的语义一致；账本 `~/.nyra/commitments.json` 里过期
  的就是 `expired`，不进记忆、不提醒。
- 到期提醒：已确认且到了提醒时间的，进收件箱提醒一次（状态变 `reminded`，
  不重复提醒）。

## 与缺口 8、缺口 45 的关系

缺口 8 的常驻责任巡查（`nyra responsibility`）是“领一份责任、按节奏复查”；
Heartbeat 是“平时安静巡查、有事才说话”的另一档：责任是用户显式领的，
Heartbeat 是每 agent 常驻的底噪检查。两者都只读、都先记证据再汇报。
持续责任语义（缺口 45，责任对象本身）仍在排队，Heartbeat 是它的先决条件之一。
