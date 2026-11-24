# 内置机器人市场

> 第一阶段：静态策展仓库 + 本地客户端（无服务端、无账号、无支付）。
> 对标 Grok Bot 的 grok-bot.directory（一键安装、别人打磨好的智能体、
> 一键部署自己的机器人），但按 Nyra 的规矩做：安装时真扫一遍、可审计、
> 只分享配置与技能、不分享电脑。

## 市场里卖什么

只卖三样东西，都是文件、不是电脑；另有一种只验证、不安装的条目：

| 商品 | 内容 | 形态 |
|---|---|---|
| 技能包（Skill） | 一个 Markdown 技能（frontmatter + 做法），可带 `allowed-tools` / `model` / `paths` 声明 | 单文件 `.md`，与缺口 11 沉淀出的技能同格式，可直接进 `~/.nyra/skills/` |
| 机器人配置（Bot） | 名字 + 代表色 + 角色卡 + 技能清单 + 模型选择 + 权限边界（模式 readonly/auto）+ 可选 routine；还可声明钉住的模型（B2）、需要的环境变量（B3）、交接目标（B7） | 一个目录（`bot.json` + `skills/*.md` + 可选 `routines.json`），即创造模式的插件形态，安装复用 `src/plugins.ts` 的路径 |
| 业务流程模板（Template，缺口 46） | 声明式纯文本的业务流程包：流程 DSL + 所需连接器 + 验收标准 + 试跑数据，须写明哪些步骤永远须人批、哪些永远禁做（缺口 51 红线表） | 单文件 `.yaml` / `.json`，进 `~/.nyra/templates/`，只装草稿，激活前须试跑 + 人工确认（详见 `docs/templates.md`） |
| 连接器包（Connector，缺口 44 深化） | 一个连接器的四件套：权限声明 + 工具清单 + 业务流程 + 红线表 | 一个目录（`connector.json` / `tools.json` / `flows.json` / `redlines.json` / `permission-statement.txt` / `market-entry.json`），**只验证、不安装**（见下） |

**连接器包只验证、不安装**：内置连接器已在代码里（`nyra connector list`），
包里的四件套没有地方可以“装”进去——声明是代码、凭证只存密码箱。市场对
它只做清单校验（四件套齐全一致、工具名已知、流程存在且带验收标准、红线
表有效、权限声明文本在）与确定性扫描，`nyra market install` 直接拒绝，
并明说第三方连接器安装是下一批（须先有第三方声明注册表）。Bot Ready
评分不参与（连接器的“就绪”是安装授权 + 流程试跑，不是静态分）。

不卖的东西：整台电脑/云电脑共享（Grok Bot 的共用电脑模式不学）、
真实凭证与账号信息（市场条目里出现密钥直接下架）、无许可证内容
（只链接、不转存）。

## 一键安装流程

```
浏览市场 → 看详情（来源、许可证、Bot Ready 评分、声明的工具与权限）
  → 点“安装” → 安装前检查（三道门） → 通过后进“待确认”：原样展示
  要装什么、改什么、调什么 → 用户点确认 → 安装 → 告诉用户装到哪、
  怎么停用/卸载
```

**社区内容是不受信任的第三方配置；导入前检查，只读起步，发送/购买/删除留在审批后。**

关键规则：

- **安全是默认项**：安装时真扫三道门（见下），不是只挂一个警告横幅。
- **可审计**：装了谁的技能进证据链（运行事件 + 安装账本），不是装完就忘。
- **本地优先**：只下载配置与技能文件；用户的密钥与数据不出本机。
- **默认只读起步**：新装的机器人默认模式 readonly，写操作须用户在机器人
  自己的权限里显式放开；routine 里的定时/事件触发任务同样只进队列、
  不自动执行写操作。市场条目不许声明 `full` 模式（清单校验直接拒绝）。
- **`--yes` 不跳过市场安装的确认**：市场内容是不受信任的第三方配置，
  静默安装等于把审批权交给陌生人。`--yes` 只对卸载生效。

## 安装前三道门

| 门 | 做什么 | 失败时 |
|---|---|---|
| 1. 清单校验（确定性，零成本） | 技能：frontmatter 能解析、做法非空、名字合法、不顶替内置技能；机器人：`bot.json` 清单完整（name/version/skills 必填，tools 必须是 Nyra 已知工具，mode 只允许 readonly/auto）、技能文件齐全且 name 一致、routine 格式合法、面板（如有）自包含；机器人安装前再过一遍创造模式的 `verifyStagedPlugin` | 拒绝安装，报错 |
| 2. 确定性规则（缺口 10 的规则集） | 技能正文与 routine 里扫高危模式：`rm -rf` 根/家/通配、curl\|sh、mkfs/dd 写原始设备、读私钥再外发、私钥 PEM 进发送内容；只扫命令形态的文本（围栏代码块、行内代码、以 `!` 开头的内联命令、routine 的 task 文本），散文里提一句“不要 rm -rf /”不算；私钥 PEM 块除外（正文里出现就是密钥，整段都扫） | 命中直接拦截，零成本 |
| 3. 独立审查（缺口 10 的模型审查） | 把“安装这个第三方配置”本身当成一次敏感动作（虚拟工具 `marketplace_install`），过审查 agent：审查员只看条目元数据（名字、描述、声明的工具与权限、技能全文），结论 ALLOW/BLOCK；拿不准就 BLOCK；审查模型出错/超时/解析不出决策一律拦截（fail-closed）。用户显式收窄 `reviewer.tools` 也不影响市场这道门（调 `reviewToolCall` 时用合并后的配置） | 拦截，原因写清是审查结论还是审查失败 |

审查层未开启时只走两道确定性门、明确告诉用户（与候选提案 1 的
`bughunt check` 同口径：未开启 ≠ 失败；补偿控制是新装机器人默认只读起步）。

## 更新已装的机器人（B1）

```
nyra market update <机器人名>
```

只更新你点名的这一台 Bot，不做整仓自动更新、不静默拉取。更新前
先过同一套三道门（新版内容也要审）+ 你确认（`--yes` 同样不跳过确认）。

合并规则（两类所有权：作者域替换、用户域永不碰）：

- **技能、面板**：新版为准；你改过的文件走插件市场的 curator lock，保留。
- **`bot.json`**：新版为准，但 `mode` 取“已装 mode 与新版 mode 里更严的
  那个”（readonly < auto）——更新永不悄悄放宽权限。
- **`routines.json`**：按 routine 名合并——新版里的定义刷新、你自己加
  的 routine 保留、新 routine 随文件进来（routine 本身不自动执行，
  新任务天然是暂停态，须手动启用）。
- **`.env.EXAMPLE`**：按新版 `env_requires` 重新生成。
- **版本**：已是最新版时报“已是最新版”，不改任何东西；市场版比已装
  版旧时拒绝降级（想回旧版请先卸载再装）；版本号无法比较时按市场
  索引为准更新，并注明。
- **账本**：原地改版本（`updated_at` 现在、`previous_version` 旧版，
  `installed_at` 保留），卸载历史不断；事件记 `marketplace_updated`。
- **花名册**：已登记的声明按新版重同步（你改过的声明不动，只警告）。
- **墓碑**：已卸载的条目更新不会复活（删了就是删了，想用请重新安装）。

技能包与模板没有更新流程：改了就用 `nyra market install <条目 id>
--force` 重装（你改过的文件同样保留）。

## 模型钉选（B2）

`bot.json` 可写可选字段 `model`（一个字符串，须是已配置的模型名）：

```json
{ "name": "my-bot", "version": "0.1.0", "model": "deepseek-flash", ... }
```

安装时校验：名字不在已配置模型里直接拒绝安装，不静默回落默认模型。
装完记进账本；跑这个 Bot 时（`nyra agent run <名字> …`）就用钉住的
模型（声明式 agent 的现成行为：声明带 `model` 即生效）。**key 仍在
密码箱里，Bot 只拿模型名**，不复制、不传递任何静态 key。

## 环境变量（B3）

`bot.json` 可写可选字段 `env_requires`（数组，每项 `name` / `description` /
`required` / 可选 `default`）：

```json
"env_requires": [
  { "name": "MY_API_KEY", "description": "这个机器人要调的第三方服务密钥", "required": true }
]
```

只声明、不带值（密钥不要写默认值）。安装时逐项核对：只报已设置/未设置，
绝不打印值；同时在机器人目录生成 `.env.EXAMPLE`（只写名字与说明，不写
值）。更新时按新版重新生成；卸载时删掉。**不做安装时向导式填 key**
（填 key 是密码箱的事，不在市场里顺手做）。

## 安装预览写 routine 全文（B4）

`nyra market install` 的待确认预览里，routine 从只写个数改成按条列出
全文（名字 + 定时/事件 + 任务全文；任务超过 400 字截断并注明全文在
条目目录 `routines.json` 里）。`nyra market show` 同样写全文。预览
就是审批卡：只写个数等于让用户盲签。

## 单个 Bot 的 URL 安装（B5）

```
nyra market install <git URL>
```

只接 git 地址（`https://…` / `git@…` / `file://…`，仓库根目录须含
`bot.json`），不支持裸 `.zip`，不建中央短链服务。流程与条目安装完全
一样：先 `git clone --depth 1` 到临时目录（`.git` 随即删掉），再过
三道门 + 预览 + 你确认；失败时清临时目录再报错。账本记 `source_url`。
临时克隆目录在 `~/.nyra/marketplace-tmp/` 下，不在 `/tmp` 上（有的
机器 `/tmp` 只有 512M，装到一半写满就装不上），装完或失败都清掉。

## 一个 Markdown 装一整队（M3）

```
nyra market install-team <队伍包文件 | https 的 .md 链接>
```

队伍包是一个 Markdown 文件：前面是 YAML frontmatter（队伍、版本、
队长、机器人、频道、打法、连接器），后面是给人看的说明正文。
不建中央目录——包就是文件本身，走同一策展仓库机制：每个 Bot 物化
成 `bot.json` + `routines.json` 后过市场三道门再安装，队伍本身只记
一本 `team-packs.json` 账本。

```yaml
---
team: support-squad
version: 0.1.0
chief: lead
description: 客服小队：队长分工，查资料的跟进
bots:
  - name: lead
    role: 队长：分工与汇总
    instructions: 你是客服小队队长。收到工单先分给合适的队员，最后汇总回复。
    skills: [triage]
    mode: readonly
    routines:
      - name: daily-brief
        kind: schedule
        schedule: "0 9 * * *"
        task: 汇总昨日工单处理情况
  - name: researcher
    role: 查资料：翻手册与历史工单
    instructions: 你是客服小队的研究员。只查资料、给结论，不直接回复客户。
    skills: [research]
    mode: readonly
channels:
  - name: support-room
    bots: [lead, researcher]
playbook: |
  客服小队的打法：队长接单、分工、汇总；研究员只查资料。
connectors: [gmail]
---
```

- 队伍 2–6 台 Bot；队长（`chief`）必须是队里的一台；机器人名字
  只许小写字母、数字、`-`、`_`，不能重复。
- 每台 Bot 都要写 `role`、`instructions`、`skills`（`bot.json` 的
  必填项）；`skills` 引用的技能须已装在本地
  （`~/.nyra/skills/<名>.md`，队伍包不自带技能文件、不编内容，
  没装就先装技能再装队伍包）；`model` 钉了就必须是已配置的模型，
  否则拒绝安装；`mode` 只许 `readonly`/`auto`；`env_requires`
  只声明、不带值；`hands_off_to` 的目标只认队内成员。
- `channels` 里的频道装完建成群聊房（房间 id 即频道名，成员即包里
  对应的 Bot）；建房失败只警告，不推翻已装好的队伍。
- `routines` 到达即暂停：routine 不自动执行，须手动启用。
- 整包先过确定性规则扫描（拒密钥与破坏性命令），再逐台过三道门；
  中途任何一台失败都整队回滚（已装的卸掉、队伍账本不记），失败进
  证据链（`team_pack_install_failed` 事件）。
- URL 只接 `https` 的 `.md` 文件（原始 Markdown，如 GitHub raw 链接，
  1MB 上限、30 秒超时）；不接 git 仓库（单个 Bot 走
  `nyra market install <git URL>`）。
- 安装确认不能用 `--yes` 跳过（市场内容是不受信任的第三方配置）。
- 卸载整队：逐个 `nyra market uninstall <机器人名>`（队伍账本只记
  队伍装过谁，不代劳整队卸载）。

## 装完进花名册（B6）

机器人装完后自动转成一份 `nyra-agent-v1` 声明 + 一段常驻会话：

- 声明存在 `~/.nyra/agents/<名字>.json`，`nyra agent list` 里能看见，
  `nyra agent run <名字> "<任务>"` 就能跑它（钉的模型自动用上）。
- 常驻会话在 `sessions.json` 里（复用联合会话账本，不另起会话存储），
  标题是 `Bot <名> 的常驻会话`。`nyra agent run` 每次仍是新开一轮，
  不自动续进这段会话——run 与会话的绑定是另一件工作，不在这里顺手做。
- 声明说明由清单合成（前缀 `【市场机器人 <名>】` + 描述 + 技能 + 工具
  + 模式 + 已装的交接目标），过注入扫描不过就跳过登记并警告，安装
  本身仍成功；机器人名不符合声明规范（数字开头或超过 32 字）时同样
  跳过登记并警告。
- 卸载时删声明（仅当说明仍以市场前缀开头——你改过的声明不动）+ 结束
  常驻会话；重装/更新时复用旧会话，不每次多一段会话。
- 桌面花名册 UI 是 `desktop/` 的事，本批只做 CLI/网关侧。

这里的“Bot”是本地专长 agent（一个声明 + 一段会话），别跟缺口 42
“每 Bot 一台持久电脑”混淆：后者是一台隔离的电脑，前者只是一个
能跑的专长配置。

## 交接目标（B7）

`bot.json` 可写可选字段 `hands_off_to`（数组，每项 `target` / `when`）：

```json
"hands_off_to": [
  { "target": "other-bot", "when": "需要写文件时交给它" }
]
```

安装时只写进账本与声明：声明里只写**已装**的目标（目标未装时在
预览与安装结果里警告“先装它，再更新本机器人即可接线”）。接线走
现有委派路线（声明里提及目标 + 目标本身是已注册声明即预设，模型
可经委派派过去），不另起协议；**交接不自动放行写操作**，写操作仍
须审批；审批档位与证据链不变。

契约层（H7）还没定，所以契约化交接验收、跨 Bot 成本归属这两件本批
不做，等 H7 定了再排（见 PUSH-PLAN.md 的未完成项）。

## Bot Ready 评分

抄 cobusgreyling 的做法——100/100 才算稳定。维度：

| 维度 | 分 | 缺了会怎样 |
|---|---|---|
| 有许可证 | 20 | 扣分；发布时许可证必填，无许可证不让发 |
| 有来源链接 | 15 | 扣分 |
| 技能可解析 | 20 | 扣分 |
| 声明工具齐全且已知 | 15 | 扣分 |
| 无高危模式 | 15 | 扣分 |
| 最近 90 天内有维护信号（`updated_at` 或文件 mtime） | 15 | 扣分 |

评分不够的不下架，但列表里按评分从高到低排、详情页写清缺什么。

模板不参与 Bot Ready 评分：模板的“就绪”是试跑 + 人工确认，不是静态分，自评恒为 0/100 并注明原因。第三方模板另有两条确定性规则：流程里不许用 `shell` 与 `http_post` 工具步骤（业务流程不该跑任意命令或对外发请求）。

## 证据链：装了谁的技能

每次安装写两处，缺一不可：

1. **运行事件**（`src/runs.ts` 的 `EVENT_FIELDS`）：
   - `marketplace_installed`：`item_name`、`item_version`、`kind`、
     `source`（`<源名>:<条目 id>`）、`bot_ready`、`reviewer_model`
   - `marketplace_uninstalled`：`item_name`、`kind`
   - `marketplace_updated`：`item_name`、`item_version`、`kind`、
     `source`、`previous_version`
   - `marketplace_published`：`item_name`、`item_version`、`kind`、
     `license`、`bot_ready`
   - 事件里只记名字与来源 id，**不记绝对路径**（绝对路径过
     `appendEvent` 的 redact 会被当成 ≥32 字词串掩掉；名字超 28 字时
     事件里只留前 28 字，全名在账本里）。
2. **安装账本**（`~/.nyra/marketplace-installed.json`，原子写 0600，
   损坏先备份再抛错）：每条含条目名、版本、来源（源名；本机发布记
   `self`）、作者、许可证、安装时间、装到哪（绝对路径）、安装文件
   的 sha256、安装时审查结论（ALLOW + 审查模型 + 来源）、Bot Ready
   评分。卸载时账本留一条 `uninstalled` 记录（删了什么、什么时候
   删的），不直接抹掉历史。

卸载只删哈希一致的文件：用户改过的文件留着并报告（机器人走插件
市场的 curator lock：升级时只覆盖与锁定文件哈希一致的文件）。

## 发布自己的机器人

```
nyra market publish <机器人目录> [--dry-run]
nyra market publish --skill <已装技能名> [--license <许可证>]
  1. 本地验证：同第三节三道门（清单校验 + 确定性规则 + 独立审查，
     工具名换成 marketplace_publish），不过不发
  2. 打包脱敏检查：密钥类（明文密码、API 密钥、Bearer token、私钥、
     AWS Key、会话 Cookie）与绝对路径命中直接拒绝发布；邮箱/电话/
     身份证只警告不拦；只报模式与行号，不报原文
  3. 许可证必填（机器人看 bot.json，技能看 --license），无许可证不让发
  4. 生成发布包：条目文件 + market-entry.json（给维护者的索引片段）
  5. 发布记录进安装账本（source: self），与“从市场装的”同口径可审计
```

发布前必须过独立审查（与安装同一套门），不是“自己写的就不用审”——
自己的机器人也可能把密钥写进 routine，审查是防手滑，不是防坏人。

第一阶段没有后端服务：`nyra market publish` 的输出目录（默认
`~/.nyra/market-publish/<名>/`）需要你自己提 PR 到策展仓库
nyra-community；`--dry-run` 只跑验证与脱敏，不写出任何文件、不记账本。

`--skill` 可以直接把一个已装技能（缺口 11 沉淀出的技能、或提案 1 的
授权漏洞挖掘技能包 `authorized-bughunt`）打包成市场条目——市场首批
上架内容就是提案 1 + 缺口 11 沉淀出的技能。

## 后端形态：静态策展仓库

第一阶段的市场后端就是一个公开 Git 仓库（`nyra-community`，MIT）：
条目是目录（`bot.json` + `skills/`），`index.json` 是索引；
Nyra 客户端用本地目录或 `git clone --depth 1` 拉取 + 本地索引。
无服务端、无账号、无支付——与 Nyra 本地优先的定位一致，也避开了
“厂商 Hub 依赖”（Continue 的教训：厂商一被收购，Hub 一死全灭）。

`index.json` 格式（`nyra market template index` 可取模板）：

```json
{
  "version": 1,
  "name": "my-market",
  "entries": [
    { "id": "my-bot", "kind": "bot", "name": "my-bot", "version": "0.1.0",
      "description": "一句话说明", "author": "你的名字", "license": "MIT",
      "source": "https://github.com/<你>/<仓库>", "path": "bots/my-bot",
      "tools": ["read_file"], "permissions": ["fs:read-workspace"], "mode": "readonly" },
    { "id": "my-skill", "kind": "skill", "name": "my-skill", "version": "0.1.0",
      "description": "一句话说明", "author": "你的名字", "license": "MIT",
      "source": "https://github.com/<你>/<仓库>", "path": "skills/my-skill.md" }
  ]
}
```

`path` 是相对市场源根目录的相对路径（越出源目录拒绝加载）。
登记源：`nyra market source add <本地目录|git 地址>`（git 地址只接受
https 或 git@，不接受明文 http；登记后绝不自动更新、绝不静默拉取；
移除源只删登记，克隆目录保留，需手动删除）。

第二阶段（star 过 500 或周活过 100 再做）：市场服务端 + 交流群。
不要为了凑数量收低质模板；不要承诺“官方认证”——Nyra 团队小，
认证不起，Bot Ready 评分 + 社区举报就够了。

## CLI

```
nyra market list [--source <源名>] [--query <词>]   浏览市场（按 Bot Ready 从高到低排）
nyra market show <条目 id>                        详情（来源、许可证、Bot Ready 缺什么、声明的工具与权限、模型钉选、环境变量、交接目标、routine 全文）
nyra market source list|add <本地目录|git 地址>|remove <源名>
nyra market install <条目 id|git URL> [--force]    三道门 → 展示待确认 → 你确认后才装（--yes 不跳过确认）；装完进花名册
nyra market update <机器人名>                     更新已装的机器人（作者域替换、用户域保留，mode 只严不松，routine 按名合并；--yes 不跳过确认）
nyra market uninstall <条目名> [--yes]            卸载（用户改过的文件保留并报告；机器人同时清声明与常驻会话）
nyra market installed                             安装账本（含已卸载的历史）
nyra market publish <机器人目录|技能文件> [--license <许可证>] [--dry-run] [--out <目录>]
nyra market publish --skill <已装技能名> [--license <许可证>] [--dry-run] [--out <目录>]
nyra market template <bot|index>                  取 bot.json / index.json 模板
```

退出码：0 = 成功（含用户取消安装）、1 = 一般错误、2 = 用法错误
（含发布时许可证缺失）、3 = 门拦截（清单校验 / 确定性规则 /
独立审查 / 脱敏检查不过）。

## 网关

- `GET /api/marketplace`：市场源、条目（公开元数据：id、名字、版本、
  描述、作者、许可证、来源链接、Bot Ready 评分与缺项、声明的工具与
  权限、模式）与已安装清单。不含绝对路径与技能正文。
- `GET /api/skill-drafts`：缺口 11 留的口子——技能草稿清单（名字、
  状态、质量分、源运行、创建时间；只读，批准走 CLI）。

PWA 市场页是桌面端/手机端的事（`desktop/`），本批只给网关
只读接口。

## 与缺口 11（技能自沉淀）的衔接

- 沉淀 → 上架：缺口 11 沉淀出的技能（已批准、已安装在 `~/.nyra/skills/`
  的）是市场上架的原材料：`nyra market publish --skill <名>` 直接打包。
- 上架 → 沉淀：从市场装回来的技能参与的成功运行，同样能起草出新草稿
  （起草只看运行记录，不看技能来源）。
- 质量门复用：Bot Ready 评分复用缺口 11 的质量分思路（确定性、可复现
  的打分）；低质条目在市场侧排后面、写清缺什么，与缺口 11 的“低质
  自动归档”同逻辑。
- 审查层复用：安装前三道门直接复用缺口 10 的确定性规则 + 模型审查，
  审查结论同样记 `reviewer_verdict` 事件（`tool` 为 `marketplace_install` /
  `marketplace_publish`）。
- 账本同口径：草稿账本（`skill-drafts.json`）、用量账本（`skill-usage.json`）、
  安装账本（`marketplace-installed.json`）、归档日志（`skills-archive.jsonl`）
  四本账互相可对：一个技能从起草 → 批准 → 使用 → 归档 → 上架，全程有记录。

## 已知局限

- 策展仓库 `nyra-community` 尚未建立（待用户拍板放哪个组织/账号下）：
  在此之前，`nyra market list` 只能看本地登记的市场源；`nyra market
  template index` 可起一个本地市场目录先用。
- 市场条目第一阶段只做免费（是否允许收费待用户拍板，第二阶段再谈）。
- Bot Ready 的维护信号以条目 `updated_at` 为准，没有时用文件 mtime
  兜底；口径待用户拍板。
- 机器人 `mode` 是清单里的声明元数据（装完默认只读起步由安装流程保证），
  插件运行时的模式强制不在本批（插件本身的工具调用照常走审批）。
- routine 只随机器人安装、不自动执行、不自动注册为定时/事件触发任务；
  启用须手动走 `nyra events add` / `nyra schedule`。
- B7 只做了不依赖契约层 H7 的部分（字段声明与校验、经现有委派接线）；
  契约化交接验收、跨 Bot 成本归属等 H7 定了再做。
- 卫生与脱敏扫描是正则模式，抓不全、也可能误报（例如技能正文里写
  `password: 请填你的密码` 会被当成明文密码赋值拦下，改写措辞即可）。
- 审查模型也会误判（误拦截看原因改一下再试；误放行时人工确认与
  权限规则仍是后两道防线）；审查层开启后每次安装/发布多一次便宜模型调用。
- PWA 市场页未做（本批只给网关只读接口，页面在 `desktop/`）；
  PWA/真机未验证。
