# 通话成本与隐私仪表（缺口 40 第一批）

每通电话三本账：传输账（带宽用了多少）、媒体账（看了几帧、STT 几分钟）、token 账（理解与干活各花多少）。账本只记用量数字，不记通话内容原文、不记帧内容、不记绝对路径。通话纪要也进证据链，同样只含数字与 id。

## 账本

`~/.nyra/call-ledger.json`，原子写 0600，损坏先备份 `.corrupt-<时间戳>` 再抛错。每通电话（语音 36 / 视频 37 / 联合会话 39）一条，同步是按需的——`nyra call` 读前先从三家来源账本重算（`voice-calls.json` / `video-calls.json` / `sessions.json`），已有的条按 id 更新，不重复记账。

```sh
nyra call ledger                  # 列全部通话账
nyra call ledger --json
nyra call show <通话 id>          # 看一通的完整三本账
nyra call summary                 # 合计：几通、时长、帧数、STT 分钟、token 与花费
nyra call summary --by-person     # 按人分摊：每人分到多少费用、token、时长与录制
nyra call summary --by-person --json
```

## 按人分摊（缺口 40 第二批）

`nyra call summary --by-person` 把整通的账按参与人拆开。口径是均摊，
不是按人实测——通话里没有按人计量的表头，分摊规则写死在下面，账里
只认这些数：

- **费用与 token**：整通 ÷ 参与人数平分。费用只有在源头标了未计价
  （`understandingUnpriced`）时，分到的才是 `null`（未计价）；会话与
  语音本来就没有理解费用/token，`null` 在这里是“结构上没有”不是
  “未知”，按 0 计，不毒化合计。云端 STT 秒同样平分。
- **时长**：各人实际在场的时间——语音/视频按整通；联合会话按
  `joined_at`→`left_at`（中途离开的只算在场那段）；进行中的通话按
  当前时间算时长。
- **录制**：语音分 0（语音不录制）；视频分 `null`（录制时长未知，不编
  数）；联合会话按各人同意且在场的时间（录制开着的时间段里，该人
  在场、且当时已同意的部分；新加入的成员没同意之前那段不算他的）。

显示时费用保留 4 位小数，token 与秒数取整；四舍五入后各人分到的数
加起来与整通数可能差一分钱以内，以整通数为准。

## 三本账口径

### 传输账

- 语音通话：回环传输，带宽记 0/0，并注明 `local_loopback`——这是本地模型数，不是真实网络带宽。
- 视频通话：记 `transportBytesIn` / `transportBytesOut`（信令面已有的实测字节数）与是否走中继（`relayed`）。
- 联合会话：记 null——会话没有自己的传输面，媒体传输走视频通话那一层；想知道带宽看同一时间的视频通话账。

### 媒体账

- 语音：STT 秒数（`sttSeconds`）、TTS 字数（`ttsChars`）。
- 视频：采样帧数（`framesSampled`）、已描述帧数（`framesDescribed`）、发出/收到帧数（`framesSent` / `framesReceived`）。
- 联合会话：帧数记 null——画面按本地扇出模型只记帧指纹（见 `docs/sessions.md`），不重复计数。

### token 账：本地与云端分开记

- 云端理解 token：视频帧的 prompt + completion token 之和（engine 以 `cloud:` 开头才算；`cloud:gpt-4o-mini-transcribe` 这类语音引擎按 STT 分钟计价，无 token，只记秒数与花费）。
- 本地理解：`whisper.cpp` / `ollama:` 这类本地引擎记帧数与秒数，token 与花费恒 0——本地不花钱，但不代表没成本（本机算力），账里分开看。
- 干活 token：只记会内委派数与 id 列表；token 与花费按关联运行记，这里恒 null，不重复算。
- 任何一项源头没给数，账里记 null、不编 0。合计时只要有一通是 null，合计就是 null——不知道就是不知道，不拿 0 凑数。

## 录制仪表

录制默认关，接缺口 39 的录制同意门（`nyra session record --consent|--revoke|--status`）：

- 只有全体在会成员显式同意后，录制才真正开始计账；任一成员撤销同意，立即停录；新加入的成员须另行同意——他加入那一刻录制就停，直到他同意才恢复。加入前给的同意不算数。
- 录制时长从 `peer-audit.jsonl` 的同意/撤销事件 + 成员 `joined_at` / `left_at` 确定性重建：按时间顺序扫事件，全体同意且人在会里的时间段才计入；断点钳制在 `[created_at, ended_at]` 内；会话结束时若还在录，补一个停录变迁。
- 录制大小恒 null——没接真实录制器，不编字节数。录制文件只存本地，路径进账本（相对路径），内容不进证据链。
- 视频通话只记同意状态（`recordConsentLocal && recordConsentRemote`），时长记 null；语音通话不录制，时长记 0。

## 通话纪要进证据链

每通电话结束且首次同步时记一条 `call_summary` 事件：谁参加、何时、时长、三本账汇总、委派了什么任务。只含数字与 id，不含通话内容原文。录制起止事件（`call_recording_started` / `call_recording_stopped`）按时间顺序补记，`recordingTransitionsRecorded` 计数防重复。未结束的通话不记纪要。

三个新运行事件已注册进 `EVENT_FIELDS`（`src/runs.ts`），`src/timeline.ts` 加渲染。

## 成本硬顶

通话的理解与干活 token 走现有硬顶（缺口 20 与缺口 43 的分层成本上限），不另起一套上限。触顶时通话按现有口径暂停—通知—续跑，不静默继续。账本本身只记账，不做限流。

## 诚实边界

- 传输账是本地模型数：语音回环记 0，视频记信令面实测字节数，没有真 TURN/STUN 带宽计量。
- 媒体面未加密，别当端到端加密用（见缺口 37 的诚实边界）。
- 真实对端未接通过，只在假对端（本机 HTTP MCP）与本地确定性检查上验过；真 API 未跑通，只在假 provider 与本地确定性检查上验过；Windows/macOS 真机未验证。
- 按人分摊是均摊口径（费用与 token 按参与人数平分），不是按人实测的用量——通话里没有按人计量的表头。
