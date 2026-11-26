# 学习队列（记忆/学习的产品化，O5）

主动记忆以前只藏在内部：对话提炼的候选记忆在 `nyra memory review` 里，
运行沉淀的技能草稿在 `nyra skills drafts` 里，agent 声明在 `~/.nyra/agents/` 里。
学习队列把三条来源收进一个用户可见的产品面：每人一个空间，
提案 → 人工审核 → 发布 → 分享给组织。

## 队列与空间

- 每人一个文件：`~/.nyra/learning/<owner>.json`（0600、原子写、损坏先备份再抛错）。
  owner 默认 `default`，登录后按账号 id（`nyra learn` 没给 `--owner` 时自动取当前登录账号）。
- 一条提案：种类（记忆 / 技能 / agent）、标题、摘要、来源（会话 id / 运行 id /
  文件名）、依据、底层引用（记忆候选 id / 技能草稿名 / agent 声明名）、
  状态（待定 / 已批准 / 已拒绝 / 已发布）、分享记录。
- 审计 `~/.nyra/learning-audit.jsonl`（只追加）：只记动作、提案 id、种类、
  owner、组织 id，**不记标题与正文**。运行事件（已注册进 `src/runs.ts` 的
  `EVENT_FIELDS`）：`learning_proposed` / `learning_approved` /
  `learning_rejected` / `learning_published` / `learning_shared`（同样只记 id 与种类）。

## 用法

```sh
# 从已有的两个队列收新提案（候选记忆 + 技能草稿；已收过的不重复）
nyra learn scan
nyra learn list
nyra learn list --status pending --kind memory
nyra learn list --shared

# 看一条：来源、依据、状态、发布落点
nyra learn show lrn_0123456789ab

# 手动提一条（记忆须给 --content；agent 须给 --text-file 声明文件）
nyra learn propose memory --title "用户偏好深色界面" --summary "用户说过喜欢深色界面" \
  --source "会话 abc" --ref memp_0123456789ab --content "用户偏好深色界面" \
  --evidence "我喜欢深色界面"
nyra learn propose skill --title my-skill --summary "从某次运行沉淀" \
  --source "运行 20261125-000000-abcdef" --ref my-skill
nyra learn propose agent --title helper --summary "帮手声明" \
  --source helper.yaml --ref helper --text-file ./helper.yaml

# 审核：批准 / 拒绝（批准后才能发布）
nyra learn approve lrn_0123456789ab
nyra learn reject lrn_0123456789ab --reason "暂时不需要"

# 发布（须 --yes）：记忆进库 / 技能安装 / 声明落盘
nyra learn publish lrn_0123456789ab --yes

# 分享给组织（状态不动，只记分享；组织须存在）
nyra learn share lrn_0123456789ab --org 研发组

# 从队列里删（只删待定 / 已拒的；已批准/已发布的留着备查）
nyra learn remove lrn_0123456789ab --yes
```

网关只读面（供桌面端/手机 PWA 的学习页消费；只读，不含批准操作——批准与发布走 CLI）：

```
GET /api/learning?owner=<账号id>&status=pending&kind=memory&shared=1
```

## 审核时按种类过门

- **记忆**：批准时过记忆证据门——依据须是用户原话逐字引用（`verifyEvidenceQuotes`），
  门拦下时提案留在待定、决定原因记原因码；发布时再走一次 `approveMemoryProposal`
  （逐字依据对照提炼时的用户原话 + 秘密拦截），过了才写结构化记忆库。
- **技能**：批准时看草稿还在不在、是不是待定；发布时走 `approveDraft`（解析草稿、
  做法非空、拒绝覆盖已安装的同名技能）。
- **agent**：批准时先解析校验声明（工具名、模型、额度上限都须合法）；发布时
  落盘到 `~/.nyra/agents/<名>.yaml`（已存在拒绝覆盖）。

## 不变量

- **学习永远要人批**：没有自动批准；队列与定时任务里不自动批准、不自动发布。
- 发布是单向的：已发布的提案不能再拒绝、不能从队列里删（留痕备查）。
- 分享不改状态：分享只记 `shared_to` / `shared_at`，不把提案变成“已分享”状态；
  分享目标组织须存在（按 id 或名字找）。
- 只做本地产品面：不建 Intelligence 式闭源服务，全部本地；不做跨组织自动同步。
- 记忆提案发布前必须过记忆证据门；技能提案过的是草稿校验（解析 + 做法非空 +
  不覆盖已安装技能），两者不要混淆。

## 已知局限

- `scan` 只收候选记忆与技能草稿：agent 声明没有“待定”状态，须手动 `propose`。
- 跨账号查看队列只在同一台机主电脑上发生（网关只认机主 token）。
- 分享只是记账：对方组织成员不会自动收到推送，须自己跑 `nyra learn list --shared` 看。
