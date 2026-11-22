# 群组视频（第 3 批 G-P0-2 视频部分）

语音房上加视频：每个人只往上发一份，SFU 按订阅关系扇出给想看的人。
本批只做本地实现（确定性转发模型），不装、不起任何真 mediasoup
视频服务，不走网络、不存任何视频字节——帧只记 SHA-256 前 12 位
指纹 + 序号 + 时间。

## 视频挂在语音房上

开视频的前提是已进语音房且是说话者——视频是“看得见的说话”，
听众只能看、不能开视频：

```sh
nyra sfu create room1
nyra sfu join room1 alice
nyra sfu join room1 bob
nyra sfu join room1 carol --role listener
nyra sfu video start room1 alice                 # camera，默认码率上限 1500 kbps
nyra sfu video start room1 bob --kind screen --max-kbps 2000
nyra sfu video stop room1 alice
nyra sfu video list room1
```

- 每人一路视频（camera 摄像头或 screen 屏幕共享），每房最多 8 路
  （与说话者上限一致）。
- 停一路视频时，订阅它的消费者一并退订。
- 视频账本记在 `~/.nyra/group-video.json`；帧指纹记在
  `group-video-frames-<房间>.jsonl`（封顶 1000 行）。

## 按需看帧

只订阅想看的那几路，不订阅的不推帧：

```sh
nyra sfu video subscribe room1 carol alice --kbps 2000
nyra sfu video unsubscribe room1 carol alice
nyra sfu video frames room1 carol alice [--seq <序号>]
nyra sfu video publish room1 alice <帧内容>   # 调试用：发一帧视频（只记指纹）
```

- `frames` 只回订阅者按自己档位下采样后的帧（序号 + 指纹 + 时间），
  不回视频内容；`--seq` 从该序号之后取。
- 订阅须报可用带宽（`--kbps`，正数）：档位按它定，high ≥1500、
  medium ≥600、其余 low。

## 带宽自适应

档位决定下发帧率：high 全帧、medium 隔一帧（每 2 帧发 1 帧）、
low 隔两帧（每 3 帧发 1 帧）。

房级总带宽上限 8000 kbps。所有订阅的档位带宽之和超上限时，
按“后订阅的先降档”逐级降（high→medium→low）；降无可降就拒绝
这次订阅（不静默挤占别人的帧）。手动改档只能往低改，不能越过
可用带宽往高改：

```sh
nyra sfu video quality room1 carol alice medium
```

## 视频录制：全体同意门

沿用 SFU 的全体同意门——房里每个人都 consent 才开得起来：

```sh
nyra sfu record consent room1 alice
nyra sfu record consent room1 bob
nyra sfu record consent room1 carol
nyra sfu video record start room1
nyra sfu video record stop room1
```

录制文件是帧指纹（`group-video-recordings-<房间>.jsonl`），不是视频。

## 10 分钟不断模拟

```sh
nyra sfu video simulate room1 alice bob carol [--seconds 600] [--fps 10]
```

虚拟时钟跑满指定秒数（默认 600 秒 = 10 分钟），三方各按帧率发帧、
订阅者按档收帧，全程不真等。验收：房间不被闲置回收、Producer
一个不少、帧序号连续。`--fps` 是模拟帧率（默认 10），不是真帧率。

## 诚实边界

- 本地实现，不走网络：没有真 mediasoup 视频服务、没有真媒体流。
  “三方 10 分钟不断”是虚拟时钟 + 假 transport 的模拟结论，
  不是真机实测；两台真机打通、真带宽下的自适应、真摄像头画面，
  都还没在真机上验过。
- 帧文件里只有指纹，没有视频；“按需看帧、带宽自适应”是转发模型
  的规则，不是真编解码器的行为。
- Windows/macOS 真机未验证。
