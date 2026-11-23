# 手机云端连接（第 6 批）

> 用户 2026-11-23 令：手机端不再走扫码配对登录，改走和 PC 端一样的账号登录；
> 不走局域网，和 Codex 一样进行连接——手机用账号登录后直接连云端 Nyra 服务，
> agent 在云端跑。

## 1. 改了什么（一句话）

以前手机是“遥控器”：启动器页填电脑局域网 IP + 8765 端口 + 6 位配对码，
WebView 跳到电脑上 `nyra ui` 的 `/m`，身份是设备 token（`src/pairing.ts`，
6 位配对码 → 32 字节 token，180 天不用失效——是设备身份，不是人的身份）。

现在手机是“账号登录 + 直连云端”：先用 Google / GitHub / 邮箱登录
（复用 `src/accounts.ts` 同一套账号制，手机与电脑登同一个账号），
再直连云端 Nyra 服务，agent 在云端跑；手机与电脑不用在同一个 Wi-Fi 里，
电脑开不开机都无所谓——跟 Codex 手机端登账号后直连 OpenAI 云端一个做法。

## 2. 客户端做了什么（本批范围）

| 件 | 在哪 | 说明 |
|---|---|---|
| 云端地址解析 | `src/cloud.ts` | 环境变量 `NYRA_CLOUD_URL` > `config.json` 的 `cloud.url` > 设计占位地址 `https://api.nyra.example` |
| 云端 HTTP 客户端 | `src/cloud.ts`（`CloudClient`） | health / 登记设备 / 撤销会话 / 设备列表 / 推状态 / 拉状态；会话 token 只走 `Authorization` 头，绝不放 URL、日志、审计、事件；30 秒超时 |
| 连/断云端 | `src/cloud.ts`（`connectToCloud` / `disconnectFromCloud`） | 连之前先确认本地账号已登录、云端地址已配、云端健康；三者缺一直接拒绝，不静默降级回局域网 |
| 云端会话记录 | `~/.nyra/cloud-session.json`（0600） | 本机“cookie 罐”，与 `account-session.json` 同款纪律；设备 id 另存 `~/.nyra/cloud-device.json`（0600，每台机器一个，第一次连时生成、之后一直沿用） |
| 跨端同步协议 | `src/cloudSync.ts`（`CloudStateStore` + `syncCloudState`） | 见 §5；本地账本 `~/.nyra/cloud-state.json`（0600），离线兜底 |
| 偏好作用域 | `src/cloudSync.ts`（`preferences`） | 第一批真正同步的状态：`model`、`language`、`theme` 三个键 |
| CLI | `src/cloudCli.ts`（`nyra cloud …`） | 见 §6 |
| 手机启动器页 | `mobile/www/index.html` | 见 §7：主入口改成账号登录 + 云端地址，局域网表单退到“旧版”折叠区 |
| 事件 | `src/runs.ts`（EVENT_FIELDS）+ `src/timeline.ts` | `cloud_connected` / `cloud_synced` / `cloud_sync_conflict`（只记账号 id、设备 id、端点主机名与计数，不记 token、不记同步的值） |

## 3. 服务端没做（诚实边界）

**真云端服务不在这个仓库里。** DESIGN.md 服务化方向写明了：
“服务端是另一套技术选型，CLI 保持轻量，服务层另起炉灶”。
本批只做了客户端一半——地址解析、HTTP 客户端、同步协议、CLI、启动器页。
服务端须按 §4 的 API 契约另行实现（账号目录、会话校验、设备登记、
状态存储都在服务端），部署与算力成本等商业决策（云计算器）仍待用户拍板。

这意味着：

- `https://api.nyra.example` 是**设计占位地址**：`.example` 是 RFC 保留域名，
  永远解析不到任何真实服务。它只是文档与代码里约定的“将来云端长这样”，
  不是已上线的服务。没配真实地址时 `nyra cloud connect` 直接拒绝，
  不会真的连过去。
- 本批所有云端行为只在**内存假服务**（测试里的 stub fetch）上验过：
  假服务按 §4 契约实现了 health / sessions / devices / state，
  但真云端部署、真机安装、真账号在手机上走完整登录链，都还没验证。
- agent 会话内容本身不在同步协议里：会话由云端服务自己持有，
  手机连上云端后看到的是云端的会话；同步协议只同步小状态（偏好这类），
  见 §5。

## 4. API 契约（服务端实现清单）

基础地址：配好的云端地址（如 `https://cloud.example.com`）。
鉴权：所有接口（除 health 外）带 `Authorization: Bearer <账号会话 token>`；
账号会话 token 由 `nyra account login` 签发（`src/accounts.ts`，
32 字节、磁盘只存 SHA-256），服务端按 `AccountSessionDirectory.verify`
同款规则校验（过期/失活/停用账号一律 401）。

| 方法与路径 | 请求 | 响应 | 说明 |
|---|---|---|---|
| `GET /api/cloud/health` | 无 | `{ ok: true, version?: string }` | 健康检查，不带身份 |
| `POST /api/cloud/sessions` | `{ device_id, device_name }` | `{ cloud_session_id, expires_at }` | 登记本设备；服务端认账号会话 token |
| `DELETE /api/cloud/sessions/<id>` | 无 | `{ ok: true }` | 撤销云端会话 |
| `GET /api/cloud/devices` | 无 | `{ devices: [{ id, name, last_seen, current }] }` | 该账号登记的设备 |
| `POST /api/cloud/state/push` | `{ records: [{ scope, key, value, updated_at, origin, base_version }] }` | `{ applied: [{ scope, key, version }], rejected: [{ scope, key, reason }] }` | 推状态；`base_version` 比服务端当前 version 旧 → rejected（不静默覆盖） |
| `GET /api/cloud/state?since=<n>` | 无 | `{ records: [{ account_id, scope, key, value, updated_at, origin, version }], latest_version }` | 只拉 version 大于 `since` 的记录 |

## 5. 同步协议

### 5.1 记录与版本

每条记录：`{ account_id, scope, key, value, updated_at, origin, version }`。
`version` 是服务端单调递增的版本号：本地只认 version 更大的远端记录；
推上去的记录由服务端发新 version 回来；本地改动记 `dirty=true`。

### 5.2 冲突规则（客户端与服务端同一条）

**最后写入者胜**：按 `updated_at` 比新旧；时间戳打平按 `origin`
（设备 id）字典序大的赢。只有“本地有未推的改动、且远端同 key 也有
新 version”时才算冲突；冲突只记“最后留了哪边”（local/remote），
值本身不进事件、不进审计。

### 5.3 拉取水位（本地验证抓到的真 bug）

拉取时 `since` 用的是**上次拉取时服务端返回的 `latest_version`**
（`cloud-state.json` 里 `meta.pulled_through`，每账号一个，只进不退），
不是“本地记录的最大 version”。推上去拿到的 version 不能推进拉取水位——
否则后推的记录会把先到云端、还没拉过的记录顶出拉取范围
（实测：先推 model 得 version 2，再拉时 since=2，version 1 的 theme
永远拉不下来；现已修，回归测试盯着）。

### 5.4 同步顺序与失败

先拉后推。拉下来覆盖掉的本地改动按 §5.2 处理；推不上去的
（服务端 rejected）留在 dirty 里，下次同步再推，不静默丢。
云端连不上时同步直接报错，不谎报成功；本地账本不动，离线读写照常进行。

### 5.5 第一批同步的状态：偏好

作用域 `preferences`，只认三个键：`model`、`language`、`theme`。
`nyra cloud pref set <键> <值>` 只改本地（标 dirty），
跑 `nyra cloud sync` 才推到云端。会话内容、任务、记忆这类大状态
不在此协议里——agent 会话由云端服务持有（见 §3）。

## 6. CLI

```
nyra cloud status              云端连接状态（地址、账号、云端会话、待同步条数、上次同步）
nyra cloud connect [--device-name <名字>]  连云端（须先登录账号、配好云端地址）
nyra cloud disconnect          断开云端（撤销云端会话 + 清掉本机云端凭证）
nyra cloud sync                同步一次（先拉后推）
nyra cloud push                只推本地改动上云端
nyra cloud pull                只从云端拉新状态
nyra cloud pref <get <键>|set <键> <值>|list>  跨端偏好（model、language、theme）
nyra cloud devices             列出该账号在云端登记的设备
nyra cloud set-url <云端地址>  配云端地址（写进 config.json 的 cloud.url，也可用 NYRA_CLOUD_URL 环境变量）
```

退出码：0 成功、1 一般错误、2 用法错误。`set-url` 只认 http/https，
明文 http 只允许本机地址（与 `config.ts` 的明文规则同款口径）。

典型流程：

```bash
nyra account login google            # 先登录账号（手机与电脑同一个）
nyra cloud set-url https://cloud.example.com   # 配云端地址（或设 NYRA_CLOUD_URL）
nyra cloud connect                   # 登记本设备，连上云端
nyra cloud pref set model deepseek-flash
nyra cloud sync                      # 推上去；手机上登同一账号就能看到
nyra cloud devices                   # 看这账号登了几台设备
```

## 7. 手机启动器页（`mobile/www/index.html`）

主入口改成账号登录：填一次云端地址（记在 localStorage，下次直接用），
点 Google / GitHub / 邮箱任一按钮打开云端登录页（`<云端地址>/login?provider=…`），
登完进云端手机页（`<云端地址>/app`）。云端地址没填时，登录按钮先提示配地址，
不链向设计占位地址（占位地址解析不到服务，链过去是死链）。

局域网表单（电脑 IP + 端口 + 配对码）没删，退到页面底部的
“旧版：连家里电脑（局域网）”折叠区。留着的理由：真云端还没上线，
现在删掉等于手机没有任何能走通的登录路；云端上线、手机走通账号登录后，
这块旧版入口再删。`nyra ui --pair` 与 `/m` 本地页同样保留
（桌面浏览器与局域网旧版仍在用），扫码配对模块 `src/pairing.ts` /
`src/qrcode.ts` 不动——好友码二维码（`peerCard`）与登录无关，不受影响。

## 8. 安全边界（fail-closed 清单）

- 未配云端地址、未登录账号、云端不健康 → 拒绝连接，不降级回局域网。
- 会话 token 只在 `Authorization` 头里带；URL、日志、审计、事件里永远只有
  账号 id、设备 id、端点主机名与计数。
- 云端会话记录、设备 id、同步账本全部 0600、原子写；损坏先备份再抛错，
  不静默清空重建。
- 断开时云端撤销没连上：本机凭证照样清掉，并如实报错（旧云端会话在服务端
  按过期时间自然失效，不谎称已撤销）。
- 账号会话与云端会话对不上（换了账号或会话过期）→ 拒绝同步，
  请重新登录账号后再连云端。
- 明文 http 只允许本机地址（供本地联调云端用）；公网地址必须 https。

## 9. 已知局限

- 真云端服务未部署、未联调：客户端只在内存假服务上验过（见 §3）。
- 手机启动器页是静态页：登录按钮打开的是云端登录页（WebView 内），
  真机上的登录跳转、回跳 App、token 回传还没验证；Capacitor 侧没有
  新增原生登录屏（本批不引入插件）。
- 同步只覆盖偏好三键：会话、任务、记忆的跨端同步不在本批范围，
  等云端服务持有会话后再接。
- iOS 仍走 PWA（见 `docs/mobile-pwa.md`）；Android APK 仍是 debug 签名
  （见 `mobile/README.md`）。
