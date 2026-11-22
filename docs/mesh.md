# Rendezvous + 队列驱动底座（第 3 批 G-P1-13）

借 Turnstone 的形态：Rendezvous 多节点路由 + 队列驱动 agent。
只借“按一致性哈希把任务路由到节点、节点下线后任务自动改派”
的形态，不搬实现。

## Rendezvous：HRW 路由

```sh
nyra rendezvous register <节点 id> <端点> [--weight <权重>]
nyra rendezvous nodes
nyra rendezvous route <任务 key>
nyra rendezvous status <节点 id> <active|drained|offline>
nyra rendezvous remove <节点 id> --yes
nyra rendezvous epoch
```

- 路由是纯函数 HRW（Highest Random Weight）：对（任务 key，节点）
  算 SHA-256 权重，取最大者；权重 × 节点权重。节点增减时只有
  该节点负责的 key 会改派（一致性哈希的最小扰动）。
- 只在 active 节点里选；drained/offline 的不接新任务。
- 无 active 节点时拒绝路由，不静默本地执行。
- 节点只认本机/局域网端点（localhost / 127.0.0.1 /
  10/172.16/192.168 段），公网端点拒绝登记——本批不做跨公网路由。
- 节点账本记在 `~/.nyra/rendezvous.json`；每次变更（登记、改状态、
  移除）纪元 +1。队列派发时校验纪元，旧纪元路由作废（见下）。

## 队列驱动底座

```sh
nyra queue enqueue <路由 key> <载荷描述> [--idem <幂等键>]
nyra queue list [--status queued|claimed|completed|failed]
nyra queue show <任务 id>
nyra queue claim <任务 id> [--lease <毫秒>]
nyra queue complete <任务 id> --node <节点> --token <租约令牌>
nyra queue fail <任务 id> --node <节点> --token <租约令牌>
```

- 任务账本记在 `~/.nyra/work-queue.json`：任务 id + 路由 key +
  载荷摘要（只记 SHA-256 前 12 位，不记原文——队列里不留敏感内容）
  + 状态（queued/claimed/completed/failed）+ 认领节点 + 租约到期
  + 纪元 + 幂等键。
- 幂等键：同一幂等键只进一条任务，重复提交直接回已有的那条
  （不重复派）。不给 `--idem` 时按（key + 载荷）算一个。
- 认领：按 HRW 路由到节点，认领即上租约（默认 60 秒）；租约内
  别人抢不走；租约过期未完成的才可重派（重派换新租约令牌，
  旧令牌作废）。
- 完成：只有认领的节点、凭当次租约令牌能完成；完成即终态，不可改。
  租约令牌只在认领时显示一次。
- 失败重试：failed 的任务可重回 queued（重试次数 +1，封顶 3 次），
  超了就留在 failed，不无限重试。

## 断线重连不重复执行、不双写

- 纪元：派发时记当时 Rendezvous 纪元；节点账本变更后纪元变了，
  旧纪元的认领作废——重连/改派后旧指令不重复执行。
- 认领时纪元变了，先按当前账本重算路由，不按旧节点派。
- 完成/标失败都要节点 id + 租约令牌都对得上：重连后旧令牌作废，
  旧认领方完不成、也标不了失败，任务只能等租约过期后重派。

## 诚实边界

- 路由与队列都是本地账本 + 纯函数：没有真节点间网络、没有真
  跨机任务执行——“节点”目前只是账本里的一行 + 一个端点，
  任务认领后谁去执行、执行结果怎么回传，是下一步的接线，
  本批不编造“已在多节点上跑通过”。
- 节点下线改派只验了路由层（key 改派到别的 active 节点）：
  真节点掉线后的任务接力、执行中断恢复，均未在真机上验过。
