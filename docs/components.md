# 生成式 UI（O7）

模型想给用户看结构化内容时不直接拼 HTML/任意标记，只调 `render_component`：
组件名必须在白名单里、已发布、没被该 Bot 屏蔽；props 只接受字面数据，
不做新的工具调用、不拼 HTML、不执行代码。

## 白名单组件（只读展示先行）

| 组件 | 用途 | 必填 props |
| --- | --- | --- |
| `table` | 表格 | `columns`（列名）、`rows`（行：数组或按列名写的对象） |
| `card` | 卡片 | `title`（可再带 `body` 与 `fields` 键值） |
| `list` | 列表 | `items`（行文本列表） |
| `code` | 代码块 | `code`（只展示，不执行；可带 `language`） |
| `chart-bar` | 柱状图 | `labels` 与 `values`（一一对应，全是数字） |

白名单写死在 `src/components.ts` 里（改白名单要改代码 + 审）；`published`
为 false 的组件模型不能调（先在白名单里占位，发布后再开）。

## 模型工具 `render_component`

```json
{ "component": "table", "props": { "title": "本周任务", "columns": ["任务", "状态"], "rows": [["修登录", "已完成"], ["写文档", "进行中"]] } }
```

- 只读工具，不需审批（与 `usage` 同级）；但 O1 策略网关的 deny 规则仍能拦它。
- 校验失败（组件不存在、没发布、被该 Bot 屏蔽、props 缺必填/类型不对/
  含非字面数据）时返回给模型的错误文本，不崩运行、不编内容。
- 工具返回值是一段可读文本（CLI 直接看这段文本）；同时经 `component_rendered`
  事件（已注册进 `src/runs.ts` 的 `EVENT_FIELDS`，只记组件名与 Bot id，
  不记 props 内容）推给 AG-UI 层，AG-UI 转成 `CUSTOM` 事件
 （`{type: "CUSTOM", name: "component_rendered", value: {component, props}}`）
  推给网页端，网页端按组件名渲染。
- 渲染记录进 `~/.nyra/components-audit.jsonl`（只记组件名与 Bot id，不记 props）。

## 每 Bot 屏蔽表

```sh
nyra components list                 # 看白名单与屏蔽情况
nyra components list --bot helper    # 看某台 Bot 能用哪些
nyra components block helper chart-bar
nyra components unblock helper chart-bar
```

屏蔽表在 `~/.nyra/components.json`（0600、原子写、损坏先备份再抛错），
格式 `{version: 1, blocked: {<bot id>: [<组件名>]}}`。

## 已知局限

- 只读展示先行：写操作仍过审批，不用组件绕审批。
- 网页端渲染还没接：CUSTOM 事件已推到客户端，但桌面端/网页端按组件名渲染
  的界面是桌面端的工作，本批只做到服务端事件面。
- 不另起 A2UI 协议：这里只做“白名单 + 校验 + 文本渲染”的兼容层。
- props 深度上限 5 层，`__proto__` / `constructor` / `prototype` 键直接拒绝。
