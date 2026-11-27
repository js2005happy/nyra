# 变化监测例程 Watch / Watch-with-action（缺口 32）

借 Proto Routines 五型中的 Watch（盯一个页面，变了才汇报）与 Watch
with an action（变化触发动作，如“承运商门户出现 9 月发票就下载”）的
形状，不抄它的 API 形状与文案。Proto 的做法是汇报回到同一会话、开头
先讲变了什么、缺东西时明确说缺什么，而不是静默失败。Nyra 已有的东
西比它全：调度器（`docs/schedule.md`，到点跑任务）+ 事件触发（缺口
7，`docs/event-triggers.md`）+ 任务队列（`nyra task`，只允许 readonly
/ auto）+ 常驻责任巡查（缺口 8，只读、无人值守）+ Heartbeat（缺口
31，`docs/heartbeat.md`，只读轮询、无事安静）。本批补的是变化监测：
给调度器加 Watch 例程，盯页面或文件，变了才动。

## 口径

- **盯什么**：两类。`--url <地址>`（只认 http:// 或 https://，20 秒
超时，抓文本）与 `--file <路径>`（读本地文件，相对路径按运行 nyra
时的当前目录算）。二进制内容（图片、压缩包、含 NUL 字节的文件、非
文本 content-type 的页面）只比哈希、不做行级对比，汇报里明说。
- **什么叫变了**：内容 SHA-256（短哈希，前 12 位）与上次不同。第一
次见到只记基线，不汇报（与 Bot notifier 的 watches 同款口径）；之
后哈希变了才算变了。快照存 `~/.nyra/watch-snapshots/<id>.txt`
（0600，只存前 64KB 文本），超 64KB 的内容只比哈希、不做行级对比。
- **diff 摘要**：行级新增/删除行数 + 各最多 8 行摘录（多集差分，不
是完整 unified diff）。行级无差异但哈希变了时（空白或不可见字符变
了），汇报里明说“行级无差异”。
- **汇报固定格式**（变了什么 → 详情 → 来源），写收件箱
（`inbox.jsonl`，run_id 为 `watch-<id>`）：
```
<label>（页面/文件：<目标>）
变了什么：新增 N 行、删除 N 行（<旧哈希> → <新哈希>）
详情：
+ <新增行摘录>
- <删除行摘录>
来源：<目标>，<时间>，内容哈希 <新哈希>
```
报告只含变化摘要与来源，不含目标全文（全文在快照文件里，不进收
件箱、不进事件）。
- **缺东西时明确说缺什么**：目标取不到（文件不存在、404、抓取失败）
时记 `watch_missing` 审计 + 收件箱报一次“目标取不到了：……（原因）”。
第一次检查就缺失时记基线 missing 并报一次；之后持续缺失只记审计、
不重复刷收件箱；目标从有变没（或从没变有）是变化，要汇报。
- **触发条件与动作分开声明**：条件 `--condition any`（任何变化都触
发，默认）或 `contains:<子串>`（新内容含该子串才触发；非文本内容不
命中）；动作 `--action report`（只汇报，默认）、
`enqueue-task:<任务>`（变化触发后把任务推进任务队列）、
`download:<相对路径>`（变化触发后下载页面内容到该路径）。条件与动
作是两回事：条件没命中时只汇报、不触发动作。

## 动作与审批

- **report**：只汇报，不触发别的动作。
- **enqueue-task**：把任务推进任务队列（`nyra task add` 同款，
mode auto）。入队本身不执行；任务在 worker 里跑时，里面的写操作
照常走审批门（auto 模式逐项问），不绕审批。入队后触发与完成同时
镜像进该任务的运行事件（`watch_action_triggered` /
`watch_action_done`），变化本身也镜像一条 `watch_changed`。
- **download**：敏感写操作，触发时**只记一条待批准动作，不下载**。
收件箱留一条“须你批准才下载：`nyra watch run-action <id> --yes`”。
人显式 `--yes` 才执行，执行时重新抓当前内容下载（不用触发时的快
照——目标可能又变了，下载以执行时为准）。目的地只认当前目录下的
相对路径（不认绝对路径、不认 `..` 逃逸、经软链逃出也拒绝；realpath
只用于越界比较，不改写返回值）。一次触发只留一条待批准动作，下次
变化覆盖它（以最新一次为准）。

## 刹车

- 自动巡查默认关（`watch.enabled` 默认 false，须显式开；手动
`nyra watch check` 是人当场点的动作，不受开关限制；单个监测的
`--disabled` 只关它自己）。
- Watch 本身只读（抓 URL、读文件），不调模型、不写监测目标以外的
文件、不对外发；无人值守只做红线表允许的事，敏感动作照样人批、
成本硬顶（单次 + 分层每日上限）照样在。
- 守护进程每轮调 `runDueWatches`（在看门狗 poller 之后），只扫到期
的监测（距上次检查超过 `--every-seconds`）；单个监测出错不破坏整
轮（记审计、继续扫下一个）。

## 配置与命令

- `config.json` 加 `watch` 一节（`enabled` 默认 false；
`default_interval_seconds` 默认 3600、整数 60–86400，没配
`--every-seconds` 的监测用它；非法回默认），`nyra config explain`
加第 12 项，`docs/CONFIG-MAP.md` 由脚本重新生成。
- `nyra watch <add|list|show|remove|check|enable|disable|config|run-action>`：
`add` 立监测（`--id` / `--label` / `--url` 或 `--file` /
`--every-seconds` / `--condition` / `--action` / `--disabled`）；
`list` / `show` 看监测与待批准动作；`remove <id> --yes` 删监测
（连快照一起删）；`check [id]` 立刻检查（不指定 id 扫全部到期的；
指定 id 时即使未到间隔、即使单个监测已关也检查——人当场点的动作）；
`enable` / `disable <id>` 开关单个监测；`config` 看或改全局自动
巡查（`--auto on|off`、`--default-interval-seconds N`）；`run-action
<id> --yes` 执行待批准的下载。

## 证据链

- 账本 `~/.nyra/watches.json`（原子写 0600，损坏先备份
`.corrupt-<时间戳>` 再抛错；老行缺 condition / action /
pendingAction 时读出来补默认值）。
- 审计 `~/.nyra/watch-audit.jsonl`（append-only 0600）：每次变化 /
缺失 / 动作触发 / 动作待批 / 动作完成都记一行（监测 id、标签、动作、
条件、短哈希，不记目标全文、不记下载内容、不记绝对路径）。
- 5 个新运行事件已注册进 EVENT_FIELDS（`watch_changed` /
`watch_missing` / `watch_action_triggered` / `watch_action_pending` /
`watch_action_done`，`src/timeline.ts` 加渲染）：变化与缺失没有运行
上下文时只记审计与收件箱，不编一个假运行出来；动作入队了任务时，
触发与完成镜像进该任务的运行事件。

## 诚实边界

- 变化检测只量“内容哈希变了没有”，不量“变化重不重要”——页面上
一个无关紧要的词变了也会汇报，重要变化与噪音变化靠条件
（`contains:`）与人的眼睛分。
- diff 摘要是多集差分，不是完整 unified diff：同一行删了又加、行顺
序调换这类变化，摘要里只体现行数的增减，不还原原始顺序。
- 超 64KB 的内容与二进制内容没有行级对比，只有哈希；“变了什么”那
一行只能告诉你哈希变了，说不清具体哪一行变了。
- URL 监测只抓一次、不渲染 JS：靠 JS 动态加载内容的页面，抓到的可
能是空壳，变化也就量不出来；需要登录的页面抓不到（会报缺失，不会
静默当成没变）。
- 真 API 未跑通，只在假 fetch/假文件与本地确定性检查上验过；
Windows/macOS 真机未验证。
