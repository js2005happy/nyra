# 严格模式结构化输出（strict: true）

工具调用的参数以前是“模型说是什么就是什么”：schema 只发给模型看，模型
吐错了参数（缺必填、多余键、类型错）要等执行层撞上才知道。这一批做了两层：

1. **支持 strict 的 provider 默认开 strict**：发工具时把参数 schema 归一化
   成 OpenAI strict 子集，带上 `function.strict = true`，让服务端在解码期
   就拦住违反 schema 的参数。
2. **所有 provider 都有二次校验 + 一次重试**：工具调用返回后按 schema 再验
   一遍，失败只重试一次（把坏的 assistant 消息与修复说明推进上下文再调
   一次）；重试仍失败不执行工具，校验错误当工具结果回填给模型，不静默吞掉。

注意：`docs/json-contracts.md` 讲的是 `--json` 命令行出口契约，是另一回事，
本批没动它。

## 各 provider 的 strict 支持（2026-11-27 逐家核实）

本树 15 个内置 provider 全走 OpenAI 兼容接口（`src/providers.ts` 只有一个
`Provider` 类），没有原生 Anthropic / Gemini provider。

| provider | 默认 strict | 理由 |
| --- | --- | --- |
| openai | 开 | 官方 strict（`function.strict`），最权威 |
| xai | 开 | 工具 strict 恒为 true（显式传也接受），`additionalProperties` 默认 false |
| qwen | 开 | DashScope 接受工具级 strict 标志；Nyra 默认模型 qwen-plus 在列 |
| together | 开 | 函数调用本身就是约束解码强制的，schema 即函数参数规约 |
| deepseek | 不开 | strict 是 Beta 接口专属（须走 `/beta`），Nyra 预置走生产 `/v1` |
| openlux | 不开 | 网关，未公开 strict 处理方式，路由模型各异 |
| openrouter | 不开 | 透传，路由端点不支持 strict 时会 400/404 |
| ollama | 不开 | `/v1` 的 `response_format json_schema` 只管文本，工具级 strict 未见文档 |
| kimi | 不开 | Moonshot 是 MFJS 子集，`minimum`/`maximum` 等关键字会 400（Nyra 的 delegate schema 恰好含这两个关键字），工具级 strict 是否强制未见明文 |
| glm | 不开 | 智谱 `response_format` 只有 text/json_object，无 json_schema/strict 文档，官方建议客户端校验＋修复循环 |
| gemini | 不开 | 走 Google 的 OpenAI 兼容端点 `/v1beta/openai`；兼容层 `response_format json_schema` 只管文本，工具级 strict 未见文档 |
| mistral | 不开 | 工具参数 strict 未见文档（`response_format` strict 是另一回事，Nyra 工具调用不用 `response_format`） |
| groq | 不开 | `response_format` strict 有，但工具级 strict 未见文档；部分模型上结构化输出与工具不可同用 |
| codex | 不适用 | CLI provider，根本不调工具 |
| custom | 不开 | 未知端点，默认不发 |

支持表在 `src/toolStrict.ts` 的 `STRICT_TOOLS_BY_PROVIDER` 里，每条附了理由与
核实日期。将来某家改了支持情况，改表 + 改这张表 + 补测试即可。

## 归一化规则（发给 strict provider 之前）

`normalizeToolForStrict` 对工具定义做深拷贝后递归处理参数 schema：

- 每个有 properties 的对象：`additionalProperties: false`，`required` = 全部
  属性键；可选属性放宽为可空（`type` 变 `[原类型, "null"]`，有 `enum` 的把
  `null` 加进 enum）——strict 要求全部属性必填，模型总得给可选属性填点什么，
  null 是诚实的“没给”。
- `default` 剥掉：它是纯提示（工具实现自己有默认值），不在 strict 子集里，
  剥掉不改变校验语义。
- `minimum` / `maximum` / `minLength` / `maxLength` / `pattern` / `minItems` /
  `maxItems` / `multipleOf` 保留（基础模型上支持）。

**不能 strict 化的工具原样发**（不带 `strict`），靠二次校验兜底：

- 自由格式对象：没有 properties 的 `type: "object"`（如 delegate 的
  `output_schema`、组件工具的 `props`、delegate_parallel 嵌套项里的
  `output_schema`）——strict 表达不了。
- `properties` 为空：schema 没说清允许哪些键，可能是“无参工具”也可能是占位
  写法；只有原 schema 已显式 `additionalProperties: false` 时才当作无参工具
  strict 化。
- 含 `oneOf` / `allOf` / `not` / `dependentRequired` / `dependentSchemas` /
  `if` / `then` / `else` / `contains` / `prefixItems` / `patternProperties` /
  `propertyNames` / `minProperties` / `maxProperties` / `uniqueItems` /
  `unevaluatedProperties` / `$ref` / `$defs` 等关键字的 schema。

## 二次校验 + 一次重试（所有 provider 都走）

校验不只给不开 strict 的 provider：strict provider 上不能 strict 化的工具，
以及忽略 strict 的服务端，仍可能吐出坏参数，所以主循环里统一验
（`src/agent.ts` 的 `runLoop`，`validateToolCalls`）：

- 按工具名找 schema；未知工具名没有 schema 可校验，跳过（执行层自会报错）。
- 参数不是合法 JSON、不是 JSON 对象时也算校验失败，同样触发一次重试。
- 校验按“strict 语义”：多余键不通过；可选属性可为 null；缺必填、类型错、
  enum 错都报。能 strict 化的按归一化后的 schema 验（缺失的可选属性先补 null
  再验，不误报“缺少必填字段”）；不能的按原 schema 验。
- 重试与首轮同款预留/结算/记账与取消检查，不占新一轮 `maxTurns`；重试仍
  失败时执行循环里按原有错误路径走——结果是 `错误：工具 <名> 的参数不符合
  schema：<错误>`，工具不执行。

## 开关与覆盖

优先级：环境变量 > 预置覆盖 > 支持表。

- 环境变量 `NYRA_STRICT_TOOLS`：`0` 全关；逗号列表里写 provider 名强制开
  （如 `openlux`）、`no:<名>` 强制关（如 `no:qwen`）；没命中的名字走下面两层。
- 预置覆盖：自定义 provider 可在 `custom_providers` 条目里写 `strict_tools: true|false`。
  内置预置不走这条（不要往内置 `PROVIDERS` 条目里加字段，会动 CONFIG-MAP）。

## 已知限制

- 校验失败重试时，若模型只回了文本、没重发工具调用，原先那次坏调用就此
  丢弃、不再产生 tool 结果（转录里那条坏 assistant 消息的 tool_calls
  会悬空）；失败本身仍可观察——最终仍失败的调用会补记一次
  `middleware_validation_failed` 事件（只记中间件校验也会拦的那类，
  缺必填/类型错；多余字段这类只有 strict 才拦的不记）。将来修这条
  时，应让重试只回文本时原调用仍进执行循环拿 schema 错误结果。
- delegate、组件工具等自由格式工具在 strict provider 上也走校验重试，不享受
  服务端强制；它们的 schema 本身表达不了 strict。
- MCP 工具的 schema 若含 `oneOf` / `$ref` 等关键字，整工具判为不能 strict，
  同样走校验重试。
- Anthropic 的工具参数 strict 与最终文本 `output_config` 是两套独立配置，
  将来接原生 Anthropic provider 时各配各的，不要混在一起；本树没有原生
  Anthropic / Gemini provider，这条现在只是设计约束，不在本批实现。
- 最终文本的结构化输出（`response_format`）不在本批：工具调用不用
  `response_format`，那是另一项工作。
- 校验用的值级校验器复用 `src/outputSchema.ts`（H-4 的子任务契约校验），
  本批只给它加了联合类型（`type` 数组）支持与一个值级导出
  `validateJsonValue`；`checkOutputSchema`（委派前校验调用方给的契约本身）
  没动，仍只认单个 `type` 字符串。
