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
| 机器人配置（Bot） | 名字 + 代表色 + 角色卡 + 技能清单 + 模型选择 + 权限边界（模式 readonly/auto）+ 可选 routine | 一个目录（`bot.json` + `skills/*.md` + 可选 `routines.json`），即创造模式的插件形态，安装复用 `src/plugins.ts` 的路径 |
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
nyra market show <条目 id>                        详情（来源、许可证、Bot Ready 缺什么、声明的工具与权限）
nyra market source list|add <本地目录|git 地址>|remove <源名>
nyra market install <条目 id> [--force]           三道门 → 展示待确认 → 你确认后才装（--yes 不跳过确认）
nyra market uninstall <条目名> [--yes]            卸载（用户改过的文件保留并报告）
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

PWA 市场页是桌面端/手机端的事（`desktop/`，归 Hark），本批只给网关
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
- 卫生与脱敏扫描是正则模式，抓不全、也可能误报（例如技能正文里写
  `password: 请填你的密码` 会被当成明文密码赋值拦下，改写措辞即可）。
- 审查模型也会误判（误拦截看原因改一下再试；误放行时人工确认与
  权限规则仍是后两道防线）；审查层开启后每次安装/发布多一次便宜模型调用。
- PWA 市场页未做（本批只给网关只读接口，页面在 `desktop/`，归 Hark）；
  PWA/真机未验证。
