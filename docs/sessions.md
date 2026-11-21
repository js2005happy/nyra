# 联合会话（缺口 39 第一批）

多人多 agent 的视频会：人 + 己方 agent + 好友的 agent 同场，会上交代的事当场变任务、进各方证据链；会内只共享任务产物与显式打包的上下文，画面默认不留存。

## 一句话口径

- **谁能进会**：只有已批准好友且在信任圈里（缺口 34 的准入闸）；机主与己方 agent 不经过网关准入（照缺口 34 的团队规则走参谋长分派）。
- **会内委派**：走缺口 12 的交接 + 缺口 29 的交付契约——委派带验收标准，落成一条契约（manual 检查项，委派即确认、直接激活）；交付给对端走缺口 12 的 `handoffPeer`（自带对端协作开关、独立审查门与信任圈闸），发不出去时任务仍留在会话账本里，`delivery` 记 pending/blocked/failed 与原因，不静默丢任务。
- **共享**：只认 allowlist（`product` 任务产物 / `context` 显式打包的上下文片段 / `evidence` 证据摘要 / `note` 便签）；`memory`、`history`、`secret`、`file`、`key` 一律拒绝——记忆私有是红线，任意本地文件不共享。带 `--run` 时从该运行拼缺口 12 的交接包（默认字段；`evidence` 种才加 evidence 字段），渲染后存在会话目录的 `shared/` 下（0600），账本里只记清单与相对路径。
- **画面**：本地扇出模型（不是真 SFU 服务器）——一方的帧按会话成员表扇出，只记帧指纹（SHA-256 前 12 位）与收件人，不记帧内容；会话结束时帧记录清空，默认不留存。
- **录制**：默认关；全体在会成员显式同意才允许录制，新加入的成员须另行同意。录制本身的仪表与成本账是缺口 40 的事，本批只做同意门。

## 命令

```text
nyra session create <标题>                  建联合会话（初始成员：机主 + 己方 agent）
nyra session list                           列出联合会话（状态、成员数、委派数）
nyra session show <会话>                    看一个会话：成员、委派、共享、录制同意状态
nyra session join <会话> <好友名>           邀好友进会（好友须已批准且在信任圈里，圈外直接拒绝）
nyra session leave <会话> [--who <身份>]    离开会话（任何一方可随时单方退出；人都走光了会话自动结束）
nyra session delegate <会话> --to <成员> --task <任务> --accept <标准> [--accept <标准> ...] [--from <成员>]
                                            会内委派（验收标准落成缺口 29 的交付契约；交付走缺口 12 的交接）
nyra session accept <会话> <委派id> [--by <身份>]    被委派方接下任务
nyra session complete <会话> <委派id> [--by <身份>] [--note <产物摘要>]   被委派方交活
nyra session share <会话> --kind <种> --label <标签> [--kind <种> --label <标签> ...] [--to <成员>] [--run <运行ID>] [--from <成员>]
                                            会话内共享（只认 product / context / evidence / note）
nyra session frame <会话> --hash <12位指纹> [--from <成员>]   扇出一帧（本地扇出模型，只记指纹与收件人）
nyra session record <会话> --consent|--revoke|--status [--who <身份>]   录制同意（全体在会成员同意才允许录制）
nyra session end <会话> --yes               结束会话（只有机主能结束；帧记录清空，画面默认不留存）
```

## 安全口径（照 Teamly 报告 §4.2）

- **对方 agent 默认只读**：对方发来的任何内容（命令、链接、文件）都按不可信输入处理（缺口 12 的 `wrapUntrusted`），写操作须对方主人显式接受；跨 agent 最大的攻击面就是“好友的 agent 被攻破后借你的手干活”，默认不信任是 feature，不是缺憾。
- **记忆私有**：只共享任务产物 + 显式打包的上下文，绝不共享整段记忆与会话历史；共享包须列清单、走审批（带 `--run` 的包走缺口 12 的交接包口径）、进证据链。
- **三条护城河**：委派、共享、录制同意都进证据链（`session_*` 事件，只记会话 id、成员名与结论，不记任务正文、共享包内容、帧内容与绝对路径）；帧扇出只记在会话账本与 `peer-audit.jsonl` 里（指纹 + 收件人）。

## 账本与证据

- 会话账本 `~/.nyra/sessions.json`（原子写 0600，损坏先备份 `.corrupt-<时间戳>` 再抛错）；共享包文件在 `~/.nyra/sessions/<会话>/shared/<共享id>.md`（0600）。
- 9 个新运行事件已注册进 `src/runs.ts` 的 EVENT_FIELDS（`session_created` / `session_joined` / `session_left` / `session_ended` / `session_delegated` / `session_delegation_accepted` / `session_delegation_completed` / `session_shared` / `session_recording_consented`，`src/timeline.ts` 加渲染）；每次操作单独建一条只记 `session_*` 事件的证据运行，审计进 `~/.nyra/peer-audit.jsonl`。

## 诚实边界

- 没有真 SFU 服务器、没有原生 WebRTC 栈（见缺口 37 的诚实边界）、不拨真实电话、不声称端到端加密；“SFU 转发”是本地确定性扇出模型（一方发帧，按成员表扇出，有记录、可审计），真实多方媒体协商是后续批次的事。
- 媒体面未加密，别当端到端加密用；本机沙箱禁 UDP sendto，媒体传输只在回环/假媒体上验过。
- 真实对端未接通过，只在假对端（本机 HTTP MCP）与本地确定性检查上验过委派交付；真 API 未跑通，只在假 provider 上验过；Windows/macOS 真机未验证。
- 委派的验收目前只记契约（manual 检查项），按契约跑确定性验收是后续批次的事；录制本身的仪表与成本账（缺口 40）本批没做。
