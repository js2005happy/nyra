# 可观测性：trace + metrics + logs（G-P1-15）

Nyra 的可观测性是确定性实现，不引 OpenTelemetry SDK、不联网、不调模型。
三件套各管一件事：

- **trace**：每次 Agent 运行开一个 trace（根 span `agent.run`），模型调用
  是 `model.chat` 子 span、工具调用是 `tool.<名字>` 子 span，父子层级完整，
  落盘 `~/.nyra/telemetry-spans.jsonl`（0600，超 8MB 轮转到 `.1`）。
- **metrics**：命名计数器与直方图（count/sum），落盘
  `~/.nyra/telemetry-metrics.json`（0600），`nyra telemetry metrics` 可看，
  `--prometheus` 出 Prometheus 文本格式（只读导出，不起服务）。
- **logs**：运行事件链本身就是日志；`llm_span` 与 `tool_span` 事件带
  `trace_id` / `span_id`，和 span 文件里的 trace 对得上。

## 命令

```text
nyra telemetry [status] [--json]   总开关、OTLP 配置、span 数、metrics 摘要
nyra telemetry spans [--limit N] [--json]   最近的 span（默认 20 条）
nyra telemetry metrics [--prometheus]   计数器 + 直方图
nyra telemetry export [--out <路径>]   最近 span 的 OTLP/JSON 写文件
nyra telemetry export --endpoint <地址> --yes   POST 到 OTLP/HTTP collector
nyra telemetry enable|disable   本地落盘总开关
nyra telemetry otlp on <地址>|off   OTLP POST 开关
```

## 记什么、不记什么

- span 属性只记元数据：模型名、工具名、耗时、token 数、成功与否。
- **不记** prompt、回答、工具参数原文、文件内容。属性键值过密钥扫描：
  键含 key/token/secret/password/authorization 一律丢弃，值像
  `sk-…` / `Bearer …` 的一律丢弃，字符串截到 256 字。
- trace id 与 span id 是随机 hex（32 / 16 位），只用于关联，不可还原内容。
  事件链里的 `trace_id` / `span_id` 不过 `redact()` 的长词掩盖（与
  `args_hash` / `digest` 同款豁免），否则 32 字 hex 会被当成疑似密钥掩掉。

## 指标

| 指标 | 类型 | 说明 |
| --- | --- | --- |
| `nyra_spans_total{name}` | counter | 结束的 span 数，按 span 名分 |
| `nyra_model_calls_total{model, ok}` | counter | 模型调用数 |
| `nyra_tokens_total{model, kind}` | counter | token 数，kind 分 prompt / completion / total |
| `nyra_tool_calls_total{tool, ok}` | counter | 工具调用数 |
| `nyra_tool_duration_ms{tool}` | histogram | 工具调用耗时（count/sum，毫秒） |

根 span 结束时 metrics 落盘一次；`nyra telemetry metrics` 读到的数截止到
上一次运行结束。span 文件与 metrics 文件损坏时从空开始，不破坏主流程。

## 导出

`nyra telemetry export` 默认写 OTLP/JSON 文件到
`~/.nyra/evidence/telemetry/otlp-<时间戳>.json`（`--out` 可改路径），
不联网。POST 到 collector 须两步都显式做：

1. `nyra telemetry otlp on <http(s)://地址>`（只开开关，不发数据）；
2. `nyra telemetry export --endpoint <地址> --yes`（每次发送都要 `--yes`）。

每次导出（文件或 POST）都在 `evidence/telemetry/` 留一份收据
`export-<时间戳>.json`（时间、span 数、目标、HTTP 状态）。

## 配置

`~/.nyra/telemetry.json`（0600，原子写，损坏备份后回默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 本地落盘总开关；关了不记 span、不记 metrics、事件不带 trace id |
| `otlpEnabled` | false | OTLP POST 总开关 |
| `otlpEndpoint` | "" | collector 地址，不配不发 |
| `maxSpanFileBytes` | 8388608 | 单个 span 文件上限字节数，超了轮转 |

## 还没做的

- 子 agent 各自开新 trace，父子 trace 不透传（父子关系仍可从
  `delegate_start` / `delegate_end` 事件对上）；透传是下一批的活。
- `/metrics` 端点（Prometheus 主动拉取）没做，只有 `metrics --prometheus`
  的只读文本导出；要接 Grafana 先拿文件导出或 OTLP POST。
- 采样率（sample rate）没做：现在全量记，span 文件到 8MB 才轮转。
- OTLP 导出只含 span，不含 metrics 与 logs。
