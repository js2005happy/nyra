# 媒体抓取（候选提案 4）

公开视频 → 转写文本。yt-dlp 解决“拿到视频”，Nyra 解决“看懂视频并交出
可验证的稿子”：先取字幕（免费、零 token），没有字幕再提音频走本地
whisper.cpp 转写（没有再走云端 STT），每次调用写事件进证据链。

## 先装 yt-dlp（二进制不进仓库）

yt-dlp 的 PyInstaller 独立二进制是 GPLv3+ 组合物，**绝不能随仓分发、随
Release 附带、打进安装包**——Nyra 是 MIT 项目。正确做法是安装时按需下载：

```bash
nyra media setup
```

它从 `github.com/yt-dlp/yt-dlp` 的官方 release 取最新版（取不到回退已核实
的 2026.10.26），下载对应平台的二进制 + `SHA2-256SUMS`，**SHA256 必验**
（失败拒绝安装），GPG 签名在“本机有 gpg 且钥匙环里已有官方公钥”时才验；
没公钥只警告、不谎称已验，签名本身不对直接拒绝安装。装到 `~/.nyra/bin/yt-dlp`
（0700），不进仓库、不进安装包、不进 PATH。自己装好的 yt-dlp（在 PATH 里）
也能用，`nyra media status` 会显示是哪一路。

## 开关与范围卡

```bash
nyra media enable          # 显式 opt-in（默认关；关了工具与 CLI ingest 都拒绝）
nyra media disable
nyra media status          # 开关 / yt-dlp / 上限 / 范围卡
```

范围卡（`~/.nyra/media-scopes.json`，原子写 0600，损坏先备份再抛错）：

```bash
nyra media scope template            # 打印模板卡（照着改）
nyra media scope add <范围卡.json>   # 建卡（名唯一）
nyra media scope list / show <名> / remove <名>
nyra media scope check <URL> [--scope <名>]   # 查链接在不在范围内（在 0，不在 3）
```

没有自定义卡时用内置默认卡：host 白名单 YouTube / Bilibili / TikTok，
单视频最长 3600 秒、单次 2GB、限速 1M、一次 1 条。建一张同名 `default`
卡就能收紧它。**五条红线缺一不可**（卡里少一条就无效）：

1. DRM/付费墙后的内容（会员专享、付费课程、加密流）
2. 批量搬运 / 整频道镜像（无明确上限的列表下载）
3. 绕过地区限制（`--geo-bypass` 类手段）
4. 盗用他人 cookies / 账号（非本人登录态）
5. 再分发 / 商用他人版权内容（下载只为自己看/学习，不转售、不公开再发）

cookies 一律禁用：卡里 `allow_cookies` 写 true 直接判无效；工具层永远
不传任何 cookies 参数、不读浏览器登录态、不传账号密码。链接里带账号信息
（`user:pass@host`）直接拒绝。

## 用法

```bash
nyra media ingest <链接> [--out 转写.txt] [--scope <范围卡名>] [--langs zh,en]
```

流程（确定性，不调模型）：范围卡白名单 + 过期检查 → `--dump-json` 先探
（标题/时长/可用性；不是公开视频或直播直接拒绝）→ 超长拒绝 → 先取字幕
（人工字幕，没有再自动字幕）→ 没字幕提音频（只提 mp3 音轨，不下视频）
走本地 whisper.cpp 转写（voice.ts 同款：本地优先、否则云端；选中一路失败
直接报错，不换路重转）。下载与音频只进临时目录、处理完即删；转写文本只写
工作区内 `--out` 指定的路径（不填直接打印）。

也可以让 agent 调 `media_ingest` 工具（参数 `url`、`out`）：写文件照常过
审批与独立审查层（已进 `DEFAULT_REVIEWED_TOOLS`），路径只允许在工作区内，
写前拍影子快照；远端后端明确拒绝。

## 成本与证据

- 字幕与自动字幕：免费、零 token。
- 本地 whisper.cpp：零 token（模型文件须自己下，见 docs/voice.md）。
- 云端 STT：按分钟计价（`voice.stt_price_per_min_usd`，默认不配、花费记 null）；
  花费记进同一本硬顶账（voiceSpentUsd），单次硬顶在下次模型调用前强制执行。
- 事件 `media_ingested`（host、标题指纹、时长、下载字节数、转写来源、转写文本
  指纹、云端花费）：只记元数据与 SHA-256 前 12 位指纹，不记字幕/转写原文、
  不记完整 URL、不记 cookies；`nyra timeline` 能读出“抓了哪条视频、怎么转的”。

## 合规：工具合法，使用合规责任在用户

yt-dlp 本身是开源下载器（The Unlicense），但下载行为的合规责任在使用方：
YouTube 等平台的服务条款一般禁止第三方下载；各国对“为个人学习下载公开
视频”与“搬运再分发”的定性不同。Nyra 的立场只写一条：**只处理用户自己
提供的链接与公开内容；只为自己看/学习；不替用户判断某一具体下载是否合法，
判断留给用户，Nyra 只负责把边界做进代码里**。

**`.NO_AI` 政策**：yt-dlp 仓库根目录有 `.NO_AI/README.md`，明文禁止以任何
形式用 LLM/agent 参与该项目的贡献（issue、PR、评论、代码评审、翻译），违规
者可被无警告封禁。这是对**贡献**的禁令，不是“禁止使用已发布的二进制”；但
Nyra 必须守住三条：绝不用 AI 向 yt-dlp 仓库提 issue/PR/评论；绝不拿 AI
生成的补丁去上游；只把官方 release 二进制当外部依赖调用，不 fork、不改、
不声称合作。

## 已知局限

- 未在真 yt-dlp 二进制与真公开链接上跑通过，只在假输出上验过；网站一改
  提取器就失效（官方自己写明不保证），失效时明说、给原文错误、不编造结果。
- 云端 Whisper API 价格以官网价目为准，本批不写死价格。
- 转写质量不测（只测管道通）；SponsorBlock 默认不开（跳过他人视频里的赞助段
  须用户显式 opt-in，本批连入口都不提供）。
- Windows/macOS 真机未验证。
