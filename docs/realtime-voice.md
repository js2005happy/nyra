# 实时语音模型插件层（第 1 批 G-P1-36）

换实时语音服务不用重接通话逻辑：通话里的段落转写走一层 provider 接口，
服务商只实现接口、注册进来就能用。

## 接口

`src/realtimeVoice.ts` 的 `RealtimeVoiceProvider`：

| 方法 | 意思 |
|---|---|
| `name` | 服务商名（配置里认这个名字） |
| `description` | 一句话说明 |
| `transcribe(input)` | 转写一段音频，返回文本、引擎、秒数、花费 |

注册表是进程内的（`registerRealtimeVoiceProvider` / `getRealtimeVoiceProvider` /
`listRealtimeVoiceProviders`）；`resolveRealtimeVoiceProvider` 按配置
`voice.realtime_provider` 的名字取，没注册直接抛错、不静默回退到别的服务商。

```bash
nyra voice realtime list     # 看已注册的实时语音服务商
nyra voice realtime use local # 切换（写进 config.json 的 voice.realtime_provider）
nyra voice realtime status   # 看当前用哪个
```

## 内置 local

默认 `local`，走现有 `transcribeAudio`：本地 whisper.cpp 优先、云端兜底，
与原来同一条路、同一套门禁（云端只在 `voice.call_cloud_enabled` 显式设为
true 时才走，默认关；走之前先套月度硬顶；本地不可用、云端又没开时直接
报错指路，不静默降级）。

“没路”由 provider 自己判：内置 local 没路时调用方保持老文案
（`cloudSttUnavailableMessage`）；自定义 provider 不替它判死刑——它可能
有自己的实时路（比如直连服务商的流式接口），判不了就别判。

## 证据链

事件 `voice_call_transcribed` 多一个 `realtime_provider` 字段（这次转写
走的哪个服务商），其余字段不变。

## 已知局限

- 本批只有接口 + 本地实现，没接任何外部实时语音服务（OpenAI Live 没有，
  也没编一个不存在的服务商出来）。要接新服务商就实现接口、注册进来，
  通话逻辑不用动。
- 实时音频流（麦克风采音、扬声器放音、音频帧经媒体面收发）还没做，
  段落仍用 `segment` 喂文件——插件层现在接的是“一段音频转写”，不是流式。
- 只在假 provider 与本地确定性检查上验过；Windows/macOS 真机未验证。

## 通话钩子（G-P1-36 第二批）

provider 接口管“转写走哪家”，钩子层管“通话进行时插件能插进来”：通话
生命周期事件（开始 / 接听 / 拒绝 / 挂断 / 转写 / 静音跳过 / 扣下 / 确认 /
回读）发生时调已注册的钩子，钩子只读元数据、不拿转写原文与音频，抛错不
破坏通话；另有通话笔记（`nyra voice call note|notes`）。详见
`docs/voice.md` 的“通话钩子与通话笔记”一节。
