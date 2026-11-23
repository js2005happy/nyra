# cron 成熟语义（G-P1-38）

定时任务漏跑一次没人知道、配额耗尽还在空跑，都是半夜出事的形态。本批补三件确定性的事（Hermes `cron/missed_runs.py` / `cron/quota_hold.py` / `cron/incidents.py` 借鉴，相似 agent 缺口报告 §2）：漏跑补跑、配额 hold、事故账。

## 漏跑补跑

守护进程停过一段时间（机器休眠、进程重启、cron 间隔拉长），到点的定时触发器按策略处理：

- **策略 `once`（默认）**：漏掉的只补跑一次——最近一次漏掉的分钟；其余漏掉的记一笔 `missed ×N`。
- **策略 `skip`**：直接跳到下一档，漏掉的全记 `missed ×N`，一次都不补跑。

窗口：只统计最近 N 分钟内的漏跑，默认 120 分钟，上限 1440 分钟；窗口外的漏跑不补也不记（不无限追补）。同一触发器一轮最多跑一次——本分钟正好到点时正常触发照常跑，漏掉的只记账，不再多跑一次。

锚点：漏跑从触发器第一次被记 `lastFired` 之后才开始算——没跑过一次的触发器不算“漏过”（新建的触发器不背旧账；线程 cron 同款，锚点是各 cron 自己的 `last_fired`）。

改策略：

```sh
nyra cron policy                                  # 看当前策略与窗口
nyra cron policy set --catch-up once|skip         # 改策略
nyra cron policy set --window-minutes 60          # 改统计窗口（0–1440；0 = 不统计漏跑）
nyra cron policy set --hold-minutes 30            # 改配额 hold 戳有效期（5–1440）
```

## 配额 hold

成本上限触顶时（`cost-pauses.json` 里有本月未决的成本暂停），定时触发与事件触发全部挂起，并打一个 `quota_hold_until` 戳（默认 60 分钟）：

- 戳还在有效期内 → 继续挂起，戳本身说了算，不重复查暂停账本；
- 戳过期后 → 再查暂停：暂停还在就续戳（再挂一轮），暂停已解除（`caps resume`）就清戳、放行，并记一笔释放；
- hold 期间不跑任何触发器，也不推进 `lastFired`——漏掉的分钟等放行后由补跑逻辑一次性处理（窗口照算）。

hold 只拦自动触发，不拦机主手动跑工作流（`nyra workflow run` 不受影响）。

```sh
nyra cron hold status    # 看 hold 状态（戳到期时间、哪条暂停、哪一层）
nyra cron hold clear --yes   # 强制清掉 hold 戳（只清戳，不动成本暂停；暂停还在时下一轮会重新打戳）
```

`nyra workflow triggers status` 也会显示当前策略与 hold 状态。

## 事故账

漏跑 / 补跑 / 配额 hold / 释放 / 失败统一记进一份事故账本 `~/.nyra/cron-incidents.jsonl`（append-only，0600，最多留 500 条，超了截到最近 500 条；坏行读时跳过）：

```sh
nyra cron incidents                                        # 最近 20 条（新的在前）
nyra cron incidents --kind missed                          # 只看漏跑
nyra cron incidents --kind quota_held --limit 10           # 只看 hold
nyra cron incidents --workflow <工作流名>                   # 只看某个工作流
```

每条只记元数据（时间、种类、来源、触发器、漏掉的分钟 / 条数、策略、暂停 id 与层、运行 id、错误前 200 字），不记任务原文与事件 payload。触发失败除了进这里，也照常进原有的证据链（`evidence/workflow-triggers/` 与 `evidence/thread-crons/`）。

## 已知局限

- 漏跑统计只看“上次记过的分钟之后、窗口内”的分钟；守护进程停得比窗口还久时，窗口外的漏跑不补也不记。
- hold 的判断只看本月未决的成本暂停（`status: "paused"` 且 `at` 与当前同月）；上个月的暂停不拦本月。
- 暂停账本本身损坏、读不出来时，hold 检查当“没有暂停”（fail-open）；一旦 hold 戳已经打出，戳本身说了算。
- 事件触发被 hold 时不记 `firedEvents`——事件本身没丢，网关侧仍有记录，放行后重派事件才会再触发。
- 投递队列（Hermes `delivery_queue.py`）没单做：触发结果的通知走已有的任务结果推送（守护进程的 `onTaskResult` / Bot notifier），不在本批另起队列。
