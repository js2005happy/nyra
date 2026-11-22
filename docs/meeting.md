# 进外部会议（第 3 批：Meet / Zoom）

受控浏览器进外部会议：只做 Meet（meet.google.com）与 Zoom
（zoom.us），先做这两个；Teams / Huddles 不在本批。

只做接线 + 纪要管线 + 审批门。进会、录制、发言都要机主批。
真实外部会议联调待验证——本机只有假页面 + 假浏览器 transport
的端到端测试；真 Meet/Zoom 会议须有机主给的真实会议链接与在场
的真人参会者，本批不编造“已进过真会”。

## 建一场会议

```sh
nyra meeting create https://meet.google.com/abc-defg-hij
nyra meeting list
```

链接只认 Meet 与 Zoom 的域名，别的会直接拒绝。会议账本记在
`~/.nyra/meetings.json`。

## 进会：单进程，听 N 秒后离会出纪要

```sh
nyra meeting join <会议 id> --yes [--as <名字>] [--listen <秒>] [--record]
```

- 进会须 `--yes`（机主显式批），没批不进会。
- CLI 是单进程：进会即听 N 秒（`--listen`，默认 60 秒，0–3600 秒），
  到时自动离会出纪要；常驻听会走网关/daemon，不在本批。
- 进会走本机 Chrome 的 CDP（127.0.0.1:9222）：Chrome 没起、页面
  60 秒内没加载出来，都直接报错，不假装进去了。
- `--record`：进会后立即按全体同意门开录制（见下）；有人没同意
  就报错离会，不静默开。

断线重连：

```sh
nyra meeting reconnect <会议 id> --yes [--listen <秒>]
```

重连纪元 +1（见“断线重连不重复执行”）。

## 听字幕与纪要

实时字幕是尽力而为：Meet/Zoom 的字幕 DOM 各家不同，本批只读
页面可见文本快照当字幕源。字幕也可以手工补录——粘贴来的会议
记录同样能出纪要：

```sh
nyra meeting transcript add <会议 id> <说话人> <文字>
nyra meeting transcript list <会议 id>
nyra meeting minutes <会议 id>
```

纪要是确定性管线（不调模型）：参会人、时长、轮次、决定、待办、
全文附录。字幕里以 `决定：` / `待办：`（或 `DECISION:` / `TODO:` /
`ACTION:`）开头的行进决定与待办；模型摘要是下一步，不在本批编一个。

## 录制：全体同意门

```sh
nyra meeting record consent <会议 id> <名字>
nyra meeting record start <会议 id>
```

参会人里有人没同意就报出名字，不静默开。CLI 单进程进会的边界：
`--record` 只覆盖进会时已知的参会人（进会时一般只有机主本人）；
会中途进来的人没同意就不能开录——多方实时同意须走后续的网关常驻。

## 待办派发：不重复派

```sh
nyra meeting dispatch <会议 id> <待办文字> --yes
```

待办派进任务队列（`nyra queue`，见 `docs/mesh.md`），派发须机主批。
已派发过的待办直接跳过（不双写、不重复派任务）。

## 断线重连不重复执行

- 每次重连纪元 +1；字幕行按文本跟上一行去重，
  重连后重复抓到的行不重复记。
- 待办派发记已派发 id，重复投递直接跳过。
- 旧纪元的待办派发直接拒绝：重连后旧纪元的指令不执行——
  那条待办还有效时，重新记一行（新纪元）再派。

## 诚实边界

- 只在假浏览器 transport 上验过全流程（进会、听字幕、出纪要、
  重连去重、待办不重派）。真 Meet/Zoom 会议、真字幕 DOM、
  真人参会者的同意流程，均未在真实会议上验过。
- 字幕源是页面可见文本快照：会议没开字幕、字幕 DOM 变了，
  都可能抓不到字幕——抓不到就报“没有新字幕”，不编字幕。
- 发言（在会上说话）只做了审批门的位置，没接真发言动作：
  会上发言须机主逐次批，本批 CLI 不提供发言命令。
