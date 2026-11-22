# 群组语音 SFU（缺口 G-P0-2）

群聊里多个人同时说话，靠 SFU（Selective Forwarding Unit）转发：每个人只往上
发一份，SFU 按房间成员表扇出给所有人。本批只做选型定案 + 抽象层 + 本地实现，
不装、不起任何真 SFU 服务。

## 选型：mediasoup

- **选 mediasoup**：Node 原生库，嵌进单 Node 运行时，不用另起进程。
  LiveKit 自托管要另起一个 Go 服务进程，跟 Nyra 单进程的方向拧着，
  本机也没装 Go。需要换实现时只换 `SfuProvider` 的实现，不动房间、
  成员、TURN、录制这些账本与命令。
- 加密：本地实现只支持 `none`。`dtls-srtp` 明确拒绝（建房间时直接报错），
  别当端到端加密用——媒体面现在就是明文的本地扇出模型。

## 房间

一个 agent + N 个说话者，闲置回收（OpenClaw Discord 房同款形态）：

```sh
nyra sfu create <房间 id>
nyra sfu rooms
nyra sfu status <房间 id>
nyra sfu join <房间 id> <好友名> [--role speaker|listener]
nyra sfu leave <房间 id> <好友名>
nyra sfu close <房间 id> [--reason <原因>]
nyra sfu reclaim
```

- 说话者上限 8 个，听众上限 32 个，满了直接报错，先等有人离开再进。
- 房间元数据记在 `~/.nyra/sfu-rooms.json`；闲置 60 秒没动静的房间，
  `reclaim` 一次收掉（已关闭的不重复收）。
- 帧只记 SHA-256 前 12 位指纹进 `sfu-frames-<房间>.jsonl`（封顶 1000 行），
  不存音频原文。

## TURN 凭据

```sh
nyra sfu turn <房间 id> <好友名> [--ttl <秒>]
```

用户名含过期时间戳，密码是房间密钥的 HMAC；凭据只用于本房间的中继，
过期须重新签发。TTL 默认 3600 秒，只能在 60–86400 秒之间配。

## 录制：全体同意门

录制沿用缺口 39 的全体同意门——房里每个人都表态同意才开得起来，
有人没表态就报出名字，不静默开：

```sh
nyra sfu record consent <房间 id> <好友名>
nyra sfu record start <房间 id>
nyra sfu record stop <房间 id>
```

录制开着后新进来、还没 consent 的人，其帧不进录制文件
（`sfu-recordings-<房间>.jsonl`）。

## 群组视频（第 3 批）

`nyra sfu video ...`：在语音房上加视频 Producer/Consumer、按需看帧、
带宽自适应、10 分钟模拟。视频挂在语音房上，开视频须是房里说话者，
听众只能看；帧只记指纹，不存视频字节。详见 `docs/group-video.md`。

## 诚实边界

- 本地实现，不走网络：没有真 mediasoup 服务、没有真 TURN 中继、
  没有真媒体流。两台真机、TURN 中继下两人以上同时说话不断，
  都还没在真机上验过，只在假信令 + 本地确定性检查上验过。
- 帧文件里只有指纹，没有音频；“同时说话不断”是本地扇出模型的
  结论，不是真媒体面的实测。
- Windows/macOS 真机未验证。
