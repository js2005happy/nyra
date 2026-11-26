# 夜间做梦代谢（H3）

Nyra 每夜一次的确定性记忆整理：提炼、剪枝、写小结。默认**关**。

## 它做什么

1. **提炼**——扫最近有更新的主会话，用 G-P1-34 的规则抽取（`src/memoryProposals.ts`）找用户显式表态的记忆候选（“记住……”“我是……”“我喜欢……”“以后……”）。提炼过程**不调模型、不花 token**。候选只进待审队列（`memory-proposals.json`），**绝不静默写进记忆**，须你用 `nyra review` 批了才进。语义事实抽取开了时（`config.json` 的 `semantic_facts` 一节，默认关），每会话再用小模型提炼一遍事实候选，同样只进待审队列（见 `docs/memory.md`“语义事实”一节）；没凭证、超月度上限、模型失败时跳过，不破坏做梦。
2. **剪枝**——三件确定性的事：
   - 重复：同一正文的已确认记忆只留最新一条，旧的标 `deleted`（修订历史保留，可审计）。
   - 过期：超过 `prune_stale_days`（默认 90 天）未决的旧候选清掉，记进拒绝账本，原因码 `dream-pruned-stale`（不冒充是你拒绝的）。
   - 事实过期：`validUntil` 已过的生效中语义事实标 `expired`（只标过期，不删除）。
   - 同主题不同说法（矛盾）**不自动处理**，只进小结请你定。
3. **小结**——把结果写进晨间简报（“昨夜做梦小结”一节），不发新消息。

## 开关与配置

`config.json` 的 `dream` 一节（`nyra dream set` 改，`nyra dream status` 看）：

```json
{
  "dream": {
    "enabled": false,
    "at": "03:00",
    "summarize_with_model": false,
    "prune_stale_days": 90
  },
  "semantic_facts": {
    "enabled": false,
    "max_per_session": 5
  }
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 开关。关着守护进程每轮都静默跳过。 |
| `at` | `"03:00"` | 每夜运行时间（HH:MM，本地时间）。 |
| `summarize_with_model` | `false` | 写小结是否额外调一次模型润色。默认关，须显式开。 |
| `prune_stale_days` | `90` | 待确认候选多少天未决算过期清掉。 |
| `semantic_facts.enabled` | `false` | 做梦里是否用小模型抽取语义事实候选。默认关，须显式开。 |
| `semantic_facts.max_per_session` | `5` | 每会话最多新增几条事实候选（1–20）。 |

## 命令

```text
nyra dream status              看开关、时间、上次运行与待确认候选数
nyra dream enable | disable    开 / 关（默认关）
nyra dream set --at 03:00 [--summarize-with-model true|false] [--prune-stale-days 90]
    [--semantic-facts true|false] [--semantic-facts-max N]
nyra dream run [--with-model]  现在手动跑一次（开关关着也能跑，是你亲手点的）
```

守护进程（`nyra schedule daemon`）里每轮调 `isDreamDue` 判断：开关开着、过了今夜的 `at`、今天还没跑过，才跑一次。

## 模型润色小结（默认不开）

开了也只调**一次**模型（60 秒超时，不带工具），把确定性小结改写成一段不超过 200 字的中文小结，只基于所给事实，不添加新事实。调之前先过月度成本上限：

- 没配模型凭据 → 跳过，用确定性小结。
- 本月已花达到月度上限 → 跳过，用确定性小结。
- 模型调用失败 / 返回空 → 回落到确定性小结。

花掉的钱如实记进当月用量账本（`nyra usage` 能看到）。

## 落盘与证据

- `dream-state.json`（0600）：上次运行时间、结果、小结。
- `dream-runs.jsonl`（0600，最多 100 条）：每次运行的计数。
- 证据链：`evidence/dream/` 里每夜一条 `dream_run` 事件（只记计数，不记记忆正文）；运行事件类型 `dream_run` 已注册进 `src/runs.ts` 的 `EVENT_FIELDS`。
- 晨间简报：上次做梦在简报窗口内时加一节“昨夜做梦小结”；做梦有内容时简报不算安静（`quiet` 为 false）。

## 局限（诚实写明）

- **主会话的识别**：做梦按文件 mtime 扫会话，`a2a-` 开头的对端会话会跳过；但子 agent 与无人值守会话在文件名上无法可靠区分（会话文件里没有来源标记）。抽取只认用户显式表态，候选仍须人确认才进库，所以最坏情况也只是多一条待你确认的候选，不会悄悄写进记忆。
- **剪枝只做可证明的重复与过期**：矛盾（同主题不同说法）只上报，不自动删；过期只清“未决的候选”，不删已确认的记忆。
- **模型润色小结只在临时 home 与假 provider 上验过**，真模型调用未在生产环境跑过；真机未验。
