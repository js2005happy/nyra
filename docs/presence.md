# 网关 presence：桌面活跃 → 手机通知静默（H2）

只做网关侧。手机端按网关的决定推不推通知（手机端随后接）；桌面端由桌面应用调心跳接口上报。

## 规则

- 桌面 5 分钟内有心跳或回合 → 桌面活跃 → 手机通知**静默**。
- 桌面超过 5 分钟没动静 → 手机通知**会推**。
- 只看桌面：手机自己活不活跃不影响这个决定（手机上的用户本来就在看，去重是手机端的逻辑，不归网关管）。

## 账本

`~/.nyra/gateway-presence.json`（0600，原子写），一行一个客户端：

```json
{
  "clients": [
    {
      "client": "owner",
      "kind": "owner",
      "surface": "desktop",
      "first_seen": "2026-11-25T02:00:00.000Z",
      "last_active": "2026-11-25T02:04:00.000Z",
      "heartbeats": 12,
      "source": "round"
    }
  ]
}
```

- `surface`：客户端自报的端面（`desktop` | `mobile` | `web`）。不报时按 kind 推断：owner → desktop，device → mobile，account → web。
- `source`：`heartbeat`（显式心跳）或 `round`（网关回合）。
- 同一客户端 10 秒内重复心跳不写盘（节流），桌面每分钟报一次就够。

## owner 回合即桌面活跃

本机回环 token（owner）只能是电脑上的客户端：每记一回合（`recordGatewayRound`，见 `src/gatewayClients.ts`），顺带记一笔桌面 presence。非 owner 回合不记 presence。

## 网关接口

- `GET /api/presence`（只限机主）：返回 `desktop_active`、`should_notify_mobile`、`window_ms`（毫秒，5000*60）、当前活跃的客户端与全部客户端。
- `POST /api/presence/heartbeat`（任何有效 token）：body 可带 `{ "surface": "desktop" }`；不带时按 token 类型推断。返回 `ok`、`throttled`、`desktop_active`、`should_notify_mobile`。非法 surface 报 400。

## CLI

```sh
nyra gw presence                        # 桌面是否活跃、手机通知推不推、当前活跃的客户端
nyra gw presence-heartbeat              # 报一次心跳（surface 按 token 类型推断）
nyra gw presence-heartbeat --surface mobile   # 显式报 mobile 端面
```

## 局限

- 桌面端还没开始报心跳：目前只有 owner 回合能点亮桌面活跃；桌面应用接上心跳接口后，桌面活跃才真正实时。
- 手机端还没按 `should_notify_mobile` 做推送静默：网关只给决定，执行在手机端。
- 5 分钟窗口与 10 秒节流是写死的常量（`PRESENCE_ACTIVE_WINDOW_MS`、`PRESENCE_HEARTBEAT_MIN_INTERVAL_MS`，见 `src/gatewayPresence.ts`），没进配置。
