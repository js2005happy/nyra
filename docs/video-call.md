# 视频通话 + 按需视觉采样（缺口 37，§4.3 第二批）

缺口 36（实时语音通话）留下的 `VoiceCallTransport` 接口接上了真传输：
信令 + STUN/TURN + ICE 连通性检查，媒体面走 ICE 提名出来的 UDP 直连通道。
看和听按需花、优先本地小模型；通话传输本身不花 token。

**诚实边界先说清**：这批没有原生 WebRTC 栈（`wrtc` 在本机装不上），所以
没有 DTLS-SRTP 加密、没有 SDP、没有 SFU——媒体面是 ICE 直连的 UDP 通道，
**未加密**，别把它当端到端加密通话用；真 TURN 服务器没接通过（只在假
TURN 上验过 Allocate 401 舞蹈）；两端 ICE 与 WebRtcTransport 协商在本机
沙箱里走内存虚拟 socket 验协议（沙箱禁 UDP sendto），真 UDP 只在 CI 上跑；
Windows/macOS 真机未验证。

## 用法

```bash
# 信令服务器：先起一个（默认只绑 127.0.0.1，本机信令）
nyra video signal serve                 # 默认 ws://127.0.0.1:18789
nyra video signal serve --port 18790
nyra video signal status                # 看信令通不通

# 通话：建 → 接听 → 连通（前台会话）→ 挂断看三本账
nyra video call start --loopback        # 本机回环，不走网络（先跑通流程用）
nyra video call start --peer 林舟 --yes # 对外呼叫须 --yes
nyra video call answer <通话 id>
nyra video call connect <通话 id> --role caller   # 前台会话：协商 + 守住 + 转发帧
nyra video call connect <通话 id> --role callee
nyra video call end <通话 id>           # 挂断，打印三本账总结
nyra video call status [通话 id]        # 状态（不放 token/花费数）
nyra video call summary <通话 id>       # 三本账总结（token 数只在这里出现）

# 帧：按需看一张画面
nyra video call sample <通话 id> <图片> [--mode on-demand|change|timed] [--prompt "<文字>"] [--send]
nyra video call confirm <通话 id> <帧 id>   # 扣下的帧确认含义（只确认，不执行）
nyra video call consent-record <通话 id> --yes  # 你这边同意录制（对方也要同意才落盘）

# 诊断：候选收集（host + STUN + TURN）
nyra video ice gather [--stun <url>] [--turn <url>]
```

`connect` 是前台进程：协商 → 连通后守住 → 每 500ms 看 spool 目录，有新
帧就经媒体面发出去 → 收到的帧写进 `~/.nyra/video/<通话 id>/inbox/` →
每秒查一次账本，看到 `endRequested`（对方挂断或本机 `end`）就收尾退出；
Ctrl+C 同样收尾。Loopback 传输不协商、直接“连通”。

## 传输：信令 + STUN/TURN + ICE

- **信令**（`VideoSignalingServer` / `VideoSignalingClient`，Bun 原生
  WebSocket）：房间按通话 id 分，消息只在同房间里转发；服务器不解析
  offer/answer 的内容，只做中继。默认只绑 `127.0.0.1`；`--host 0.0.0.0`
  才对外，但要自己注意防火墙。
- **STUN**（RFC 5389）：Binding 请求 + MESSAGE-INTEGRITY 签名/验签
  （HMAC-SHA1），问服务器“我从哪个公网地址来”，拿 srflx 候选。
- **TURN**（RFC 5766）：Allocate（401 舞蹈：先不带凭证发一次，401 就按
  NONCE/REALM 带长期凭证重发）/ Refresh / CreatePermission / Send。
  TURN 密码绝不放 `config.json`：环境变量 `NYRA_TURN_CREDENTIAL` 优先，
  其次密码箱条目 `video-turn-credential`（须 `NYRA_VAULT_PASSWORD` 解锁，
  解不开返回 null，不抛错、不挡直连）。
- **ICE**：host（本机网卡）+ srflx + relay 三档候选，按优先级逐对检查
  （Binding 请求，USERNAME 是 `<对方 ufrag>:<我的 ufrag>`，完整性用对方
  密码签），第一对通的就是提名对；通了之后每 15 秒保活一次。STUN/TURN
  不通就跳过，不挡直连。
- **协商**（`WebRtcTransport`，实现缺口 36 的 `VoiceCallTransport` 接口，
  kind `"webrtc"`）：`start()` 只踢开异步协商（信令握手 → 候选收集 →
  ICE 检查），连通与否看 `waitConnected()`。主叫等对方进房再发 offer
  （对方还没进房时服务器没人可转，offer 直接丢了）；offer/answer 经信令
  消息缓冲收——gather 期间到达也不会丢。`stop()` 关传输与信令。
- **媒体面**：`IceMediaPlane` 经提名对发长度前缀成帧（单包上限 60KB，
  超了丢弃并计数，不静默）；`LocalMediaPlane` 是回环（发出的帧直接交给
  本机的接收回调，不走网络）。

## 帧采样：三档门控 + 视觉描述

采样走缺口 16 的视觉管线（`--image`/`--video` 的看图能力）：

- **on-demand**（默认）：点一下才看。
- **change**：ffmpeg 把图缩成 16x16 签名，和上次的比平均绝对差，低于
  `change_threshold`（默认 0.08）就不看、不花钱；第一帧没有上一帧可比，
  直接采。没 ffmpeg 时直接报错，不静默跳过。
- **timed**：距离上次采样不到 `sample_interval_seconds`（默认 10 秒）就
  跳过，不看、不花钱。

单通电话最多描述 `max_frames_per_call`（默认 120）帧，满了先挂断再开新
通话。描述原文只返回给调用方显示，**不落盘**：账本与审计只记帧 id、引擎、
字数、花费与图像/文本 SHA-256 前 12 位指纹。

## 看和听：本地优先、云端 opt-in、云端花费记账

- 本地优先：配了 `video.vision_local_model`（如 `qwen2.5-vl:3b`，走
  Ollama）就先走本地；本地不可用、云端又没开时直接报错指路，不偷偷
  走云端。
- 云端只在 `video.vision_cloud_enabled` 显式设为 true 时才走（默认关），
  云端花费照常进用量账本（月度上限已移除，不再有月度硬顶这一关）；云端模型须支持看图，不支持的直接拒绝、不烧 token。
- 每笔云端花费进用量账本（`UsageLedger.recordDelta`）；本地视觉记 $0；
  模型没价目时花费记“未计价”，总结里明说这是下界。

## 语音那批的规矩沿用

- **视频不碰支付与对外发送**：帧描述命中支付类或对外发送类关键词时
  该帧被扣下（`held`），不执行；`confirm` 只记“含义已确认”，执行请把
  描述文字当普通任务跑。
- **录制默认关**：帧落盘须双方同意（你这边 `consent-record --yes`，对方
  经信令发 `record-consent`）；只一方同意不录。
- **弱网自动降级**：ICE 往返持续超过 `weak_rtt_ms`（默认 300ms）就切到
  仅语音（协作与 agent 不受影响），网好了视频自己回来；降级与恢复都进
  证据链。蜂窝省流量开关（`video.cell_saver`，最高 360p、弱网先关视频）
  只记进总结，不改码率（码率须原生栈）。

## 三本账分开

传输（字节数、直连还是经 TURN 中转、超大丢帧数）/ 看（帧数、引擎、
花费）/ 干活（本次通话不把描述当任务跑，无 LLM token 花费）——总结
（`summary` / 挂断时）与用量弹层按这个口径出数，不写“视频通话不花
token”这种绝对说法。`status` / `list` 里不放 token/花费数（桌面取舍
原则：token 消耗放设置里，不放主界面；协作 token 各用各的）。

## 配置（`config.json` 的 `video` 一节）

```json
{
  "video": {
    "signaling_url": "ws://127.0.0.1:18789",
    "stun_urls": ["stun:stun.l.google.com:19302"],
    "turn_urls": [],
    "turn_username": "",
    "sample_mode": "on-demand",
    "sample_interval_seconds": 10,
    "change_threshold": 0.08,
    "max_frames_per_call": 120,
    "vision_cloud_enabled": false,
    "vision_local_model": "",
    "weak_rtt_ms": 300,
    "cell_saver": false
  }
}
```

非法值回退默认值，不抛错、不挡运行。TURN 密码不在这里配（见上）。

## 账本与证据链

- 通话账本 `~/.nyra/video-calls.json`（原子写 0600，损坏先备份再抛错）
  + 审计 `~/.nyra/video-call-audit.jsonl`（append-only，只记元数据与指纹）。
- 通话目录 `~/.nyra/video/<通话 id>/`：`frames/`（双方同意录制时落盘的
  帧）、`spool/`（待发送的帧，发完删）、`inbox/`（收到的对方帧）、
  `session.lock`（会话进行中才有）。
- 14 个新运行事件已注册进 EVENT_FIELDS（`video_call_started` /
  `answered` / `declined` / `ended` / `transport_connected` /
  `transport_failed` / `frame_sampled` / `frame_blocked` /
  `frame_confirmed` / `frame_skipped` / `frame_sent` / `frame_received` /
  `degraded` / `restored`，只记元数据与指纹），有运行上下文（`--run`）
  时镜像进运行事件，`nyra timeline` 有渲染。

## 已知局限

- 没有 DTLS-SRTP/SDP/SFU：媒体面是未加密的 ICE 直连 UDP 通道，不要当
  端到端加密通话用；多方通话（SFU）不在本批。
- 真 TURN 服务器没接通过（只在假 TURN 上验过 Allocate 401 舞蹈）；
  真 STUN 服务器没在真网上跑过（只在假 STUN 上验过 Binding）。
- 本机沙箱禁 UDP sendto：两端 ICE 与 WebRtcTransport 协商在本地走内存
  虚拟 socket 验协议，真 UDP 只在 CI 上跑（测试里有守卫，沙箱自动跳过）。
- 真视觉模型未在真 API 上跑通（只在假 visionFn 上验过采样与扣下）；
  本地 whisper.cpp / Ollama 须用户自己装。
- 视频帧是静态图片采样，不是连续视频流；对方发来的帧只存 inbox，不
  自动描述（`sample` 时再看）。
- Windows/macOS 真机未验证。
