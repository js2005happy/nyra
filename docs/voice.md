# 语音指挥（缺口 15）

Puck 式语音通话指挥 agent 的异步版：对 Nyra 说一句话，它干完回文字。
本批只做**语音指挥**，不做语音聊天、不做实时通话（实时语音通话是缺口 36
的延伸，见 `docs/` 下 Teamly 调研报告里的缺口 36 定义）。

## 用法

```bash
# 语音文件即任务：先转文字，再当任务文本跑（可再跟一句文字补充）
nyra --voice 录音.wav
nyra --voice 录音.wav "把结果写进 out.txt"

# 只转写、不跑任务（先看一眼转得对不对）
nyra voice transcribe 录音.wav

# 任务跑完后把结果读出来（只读结果前 500 字，不读完整证据链）
nyra "做一个季度总结" --speak

# 语音子命令：看配置与可用性、读一段文字、开关自动回读
nyra voice status
nyra voice speak "任务完成"
nyra voice enable-tts   # 每次任务跑完自动回读（默认关）
nyra voice disable-tts

# 实时语音服务商：看已注册的、切换、看当前用的
nyra voice realtime list
nyra voice realtime use local
nyra voice realtime status
```

`--voice` 只支持一次性任务：不能与 `--resume` / `--resume-run` /
`--plan` / `--execute-plan` 组合、不能进交互模式，组合不对直接报错退出码 2。
`--speak` 不能与 `--json` 组合（JSON 模式只出机器可读结果）。

## 语音输入先审后发（G-P2-17）

转写文字先给人看一眼再当任务跑，不让误转写直接变成误操作：

- 交互模式（终端）下 `--voice` 默认先审：转写文字打印出来，回车接受、
  输入改过的文字按改后跑、输入 `drop` 丢弃（不跑任务、不烧模型 token）。
  `--voice --yes` 是明确跳过审阅——只在你确定转写不会错时用。
- JSON 模式（`--json`）下没人可问：`--voice` 没给 `--yes` 直接拒绝
  （`voice_review_required`），不静默跑；给了 `--yes` 才按转写文字跑。
- 审阅结论进证据链（`voice_input_reviewed` 事件：结论 + 字数 + 文本指纹，
  不记原文）。丢弃同样记一笔，不是不记。
- `nyra voice transcribe <音频>` 只转写、不跑任务——想先看一眼转得对不对
  时用它，不用先把整段语音当任务跑起来。

## 转文字：本地优先、云端兜底、失败就报错

- 本地：whisper.cpp。装好后在 `config.json` 的 `voice` 一节配
  `stt_local_binary`（默认自动找 `whisper-cli` 再找 `whisper`）与
  `stt_local_model`（模型文件路径，**必须配**，否则不走本地）。
  模型路径配了但文件不存在是配置错，直接报错，不悄悄走云端花钱。
- 云端：走当前 provider 的 OpenAI 兼容接口
  `POST {baseUrl}/audio/transcriptions`（multipart，`file` + `model`，
  默认模型 `whisper-1`）。没有 HTTP 端点的 provider（如 Codex CLI）没有
  云端这条路。
- 两条路都不可用时直接报错并指路（装 whisper.cpp 或换支持语音的 provider），
  不静默降级。选中的一路失败也直接报错，**不换另一路重转**（那会多花一份
  云端钱）。
- 只认 WAV / MP3 / M4A / OGG / FLAC / WebM，按文件头识别，不看扩展名；
  单段默认上限 25MB、600 秒，超了拒绝。M4A / FLAC / WebM 先经 ffmpeg 转
  16k 单声道 wav 再转写（没装 ffmpeg 直接报错）；时长用 ffprobe 尽力读，
  读不到不报错、花费记 null。
- 音频文件只读一次进内存：转写用的临时副本处理完即删，不落盘、不进事件。

## 回读：可选、默认关、只读摘要

- TTS 本批只做云端：`POST {baseUrl}/audio/speech`（JSON，mp3，默认模型
  `tts-1`、音色 `alloy`）。本地没有可靠的 TTS 引擎，不自研。
- 回读只读结果前 500 字；合成的 mp3 存 `~/.nyra/voice/speak-<时间戳>.mp3`
  （0600），`voice.tts_player` 配了播放器才播，播失败只警告。
- `nyra voice speak <文字>` 是显式入口；`--speak` 或 `voice.tts_enabled`
  时任务跑完自动回读；回读失败只写一行警告，不破坏已完成的运行。

## 实时语音通话（缺口 36，§4.3 第一批）

通话的最小闭环：建通话 → 接听 → 一段一段喂音频 → 转写文本交给调用方
处理 → agent 的回读文字可合成语音读出来 → 挂断看三本账总结。

```bash
nyra voice call start                        # 默认本机回环通话（不拨真实电话）
nyra voice call start --peer 林舟 --yes      # 呼叫有名有姓的对方，须 --yes
nyra voice call start --transport webrtc     # 真 WebRTC 1:1 语音（见下）
nyra voice call connect <通话 id>            # 主动拨通一通已建的 webrtc 通话
nyra voice call answer <通话 id>             # 接听
nyra voice call decline <通话 id>            # 拒绝
nyra voice call segment <通话 id> 录音.wav   # 喂一段音频，转写后打印文本
nyra voice call segment <通话 id> 录音.wav --speak-reply "好的，写完了"
nyra voice call confirm <通话 id> <段落 id>  # 确认被扣下的段落（只确认含义，不执行）
nyra voice call end <通话 id>                # 挂断，打印三本账总结
nyra voice call status [通话 id]             # 看一通 / 列最近通话
nyra voice call note <通话 id> <文字>        # 通话中记一条要点（1–500 字）
nyra voice call notes <通话 id>              # 列出这通电话的笔记
nyra voice call hooks [list|enable <名>|disable <名>|on|off]  # 通话钩子开关
```

- **传输层**：默认仍是本机回环（不拨真实电话、不走 TURN/SFU；传输
  0 带宽、0 token）。`--transport webrtc` 走真 WebRTC：复用视频通话那套
  纯 TS 栈（`src/videoCall.ts` 的 `WebRtcTransport` + 信令 + ICE +
  STUN/TURN），与对端协商后建媒体通道；协商失败时通话记录照常落账本，
  事件记 `voice_call_transport_failed`。回环仍是回退：信令连不上或没配
  webrtc 时，用回环起通话。`connect` 是呼叫方的拨通入口（回环通话不需要它）。
  诚实边界：本批只守住媒体通道，实时音频流（麦克风采音、扬声器放音、
  音频帧经媒体面收发）还没做，段落仍用 `segment` 喂文件；两台真机打通、
  断线重连、字幕对账尚未在真机上验过（见 PUSH-PLAN.md 的待真机验证）。
- **VAD 门控**：WAV 做真能量检测（20ms 帧、RMS 门限），静音段直接跳过、
  不转写、不花钱；MP3 等其他格式跳过 VAD（不假装都测了），直接转写。
- **转写走实时语音插件层**：通话里的段落转写不再直调 whisper/cloud，
  走 `src/realtimeVoice.ts` 的 provider 注册表（详见 `docs/realtime-voice.md`）。
  默认 `local`（本地 whisper.cpp 优先、云端兜底，与原来同一条路）；
  `nyra voice realtime use <名字>` 切换，名字没注册直接报错、不静默回退。
  云端仍比缺口 15 更严：只在 `voice.call_cloud_enabled` 显式设为 true 时
  才走（默认关），且走之前先套月度硬顶（本月已花是下界，只会晚触发、不会
  误触发；没配上限不挡人）。本地不可用、云端又没开时直接报错指路，不静默降级。
  事件 `voice_call_transcribed` 多一个 `realtime_provider` 字段。
- **语音不碰支付与对外发送**：转写文本命中支付类（转账、付款……）或对外
  发送类（发消息、发邮件……）关键词时，该段被扣下（`held`），不回读、不
  执行；`confirm` 只记“含义已确认”，执行请把文字当普通任务跑。转写原文
  不落盘：账本（`~/.nyra/voice-calls.json`，0600、损坏先备份再抛错）与
  审计（`~/.nyra/voice-call-audit.jsonl`）只记时长、字数、引擎、花费与
  文本指纹，原文只在喂段落时打印一次，确认时凭段落 id 与指纹核对。
- **回读**：`--speak-reply "<文字>"` 才合成（云端 TTS，同样过月度硬顶；
  超 `call_reply_max_chars` 截断）；mp3 存 `~/.nyra/voice/call-<通话 id>-<段落 id>.mp3`
  （0600），配了播放器才播。被扣下的段落不回读。
- **证据链**：10 个新事件已注册进 EVENT_FIELDS（`voice_call_started` /
  `answered` / `declined` / `ended` / `transcribed` / `spoken` /
  `blocked` / `confirmed`，另加 webrtc 传输的 `voice_call_transport_connected` /
  `voice_call_transport_failed`），有运行上下文（`--run <运行 id>`）时镜像进
  运行事件，`src/timeline.ts` 加渲染；只记元数据与指纹，不记原文与路径。
  语音输入审阅另记 `voice_input_reviewed`（结论 + 字数 + 指纹，不记原文）。

## 通话钩子与通话笔记（G-P1-36 第二批）

第 1 批 G-P1-36 已把“实时语音模型插件层”做成 provider 接口
（`src/realtimeVoice.ts`，换服务商只换 `voice.realtime_provider`，见
`docs/realtime-voice.md`）。本批补的是另一半：通话进行时插件能插进来。

- **钩子**（`src/voiceHooks.ts`）：通话生命周期事件发生时调已注册的钩子——
  开始 / 接听 / 拒绝 / 挂断 / 转写 / 静音跳过 / 扣下 / 确认 / 回读，共 9 种。
  钩子只读元数据（通话 id、段落 id、VAD 结论、字数、引擎、花费、文本指纹），
  永远拿不到转写原文与音频；钩子必须是同步的（`onEvent` 返回 void），想做
  异步活自己排队，通话不等它。钩子注册表是进程内的
  （`registerVoiceHook` / `unregisterVoiceHook` / `listVoiceHooks`），
  开关配置才落盘（`~/.nyra/voice-hooks.json`，0600 原子写，损坏先备份再回
  默认）：总开关默认开，按名开关默认开，`nyra voice call hooks list` 看、
  `hooks enable|disable <名>` 改单个、`hooks on|off` 改总开关。
  fail-closed：钩子抛错只记审计（`voice-call-audit.jsonl` 的 `hook_failed`）
  与事件 `voice_call_hook_failed`（通话 id、钩子名、事件种、报错前 200 字），
  通话继续，坏钩子不拦好钩子。
- **笔记**（通话中只读工具的落点）：`nyra voice call note <通话 id> <文字>`
  记一条要点（1–500 字，机主手写），`notes <通话 id>` 列出来。笔记存在通话
  记录上、进审计（`noted`，只记字数不记正文）与事件 `voice_call_noted`
  （通话 id、笔记 id、字数）；不记转写原文，不替你执行任何动作，通话结束后
  也能补记。
- **没做的**：真 STT/TTS 接入不在本批（另算）；说话人切换没有单独的钩子——
  1:1 通话没有说话人标识，段落转写事件就是“对方说了一段”；静音/恢复没有
  单独的开关与钩子，静音段走 VAD 跳过事件（`segment_skipped_silence`）；
  钩子是进程内注册的，没有从磁盘动态加载插件代码的入口（插件市场只装技能包，
  见 `docs/plugins.md`）。

## 边界：语音不碰支付与对外发送

语音层只把转写文本当任务交给主循环：转写文本里哪怕写着“转 100 元”“发一封
邮件”，语音层自己也不执行任何工具、不碰支付与对外发送——写操作照常走主
循环的审批与权限边界，须回文字确认。队列 / 定时任务里不自动放行、不自动
换模型（与主循环同款红线）。

## 成本与证据

- STT 按分钟、TTS 按字数计价（`voice.stt_price_per_min_usd` /
  `voice.tts_price_per_1k_chars_usd`，默认不配、花费记 null，不编数字），
  进用量账本：单次硬顶与月度硬顶都含语音花费，超限时报错文案带“其中语音
  $X”；时间线与 `nyra verdict --run <运行 ID>` 的花费合计含语音。
- 证据链：新事件 `voice_input`（seconds、chars、engine、cost_usd、
  text_hash）与 `voice_speak`（chars、engine、cost_usd），均已注册进
  `EVENT_FIELDS` 与 `RunRecorder` 转发白名单，`src/timeline.ts` 加渲染；
  只记元数据与文本 SHA-256 前 12 位指纹，**不记音频原文件、不记转写原文、
  不记回读原文、不记音频路径**。用量摘要加 `voice_spent_usd` /
  `voice_calls`。

## 配置

`config.json` 的 `voice` 一节（非法值回退默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `max_bytes` | 25MB | 单段音频上限 |
| `max_seconds` | 600 | 单段最长（秒） |
| `stt_model` | `whisper-1` | 云端 STT 模型 |
| `tts_model` | `tts-1` | 云端 TTS 模型 |
| `tts_voice` | `alloy` | TTS 音色 |
| `tts_enabled` | `false` | 任务跑完自动回读 |
| `stt_local_binary` | `null` | 本地 whisper.cpp 二进制（不配自动找） |
| `stt_local_model` | `null` | 本地 whisper 模型文件（配了才走本地） |
| `stt_language` | `auto` | 转写语言（`auto` 不传给云端） |
| `tts_player` | `null` | 回读播放器（不配只保存文件） |
| `stt_price_per_min_usd` | `null` | STT 单价（美元/分钟，不配不计价） |
| `tts_price_per_1k_chars_usd` | `null` | TTS 单价（美元/千字，不配不计价） |
| `call_max_minutes` | 120 | 单通电话最长（分钟），超时只拒绝再喂段落 |
| `call_max_segments` | 200 | 单通电话最多段落数 |
| `call_cloud_enabled` | `false` | 通话里是否允许走云端 STT/TTS（默认关，显式 opt-in） |
| `call_vad_min_speech_ratio` | 0.15 | VAD 判定“有人说话”的最低有声帧比例 |
| `call_reply_max_chars` | 2000 | 单次回读最多字数，超长截断 |
| `realtime_provider` | `local` | 通话转写用的实时语音服务商（`nyra voice realtime use <名字>` 切换） |

## 已知局限

- 真 STT/TTS 未在真 API 上跑通，只在假服务上验过；本地 whisper.cpp 未打包、
  须用户自己装（模型文件另行下载）。
- 实时语音通话（缺口 36）本批接上了真 WebRTC 1:1 语音（`--transport webrtc`，
  复用视频通话的纯 TS 栈），但实时音频流（采音/放音）还没做，段落仍用
  `segment` 喂文件；两台真机打通、断线重连、字幕对账尚未在真机上验过；
  视频通话是缺口 37。
- 转写原文不落盘：确认被扣下的段落时凭段落 id 与指纹核对，原文只在喂段落时
  打印一次；VAD 只对 WAV 做真能量检测，其他格式跳过。
- 回读只读结果摘要，不读完整证据链；`describe_image` 式的语音内嵌指令仍按
  主循环的不可信输入处理。
- Windows/macOS 真机未验证。
