# 模型上下文窗口自动识别

用量汇总曾经写“上下文剩余：未知（未配置该模型的 context_window_tokens）”。
现在不用手动配了：Nyra 用哪个模型跑，就自动知道该模型的上下文窗口，
并在用量汇总与 `nyra doctor` 里显示出来，注明窗口数值的来源。

## 解析优先级

`resolveContextWindow`（`src/modelCatalog.ts`）按以下顺序取窗口，排在前面的赢：

1. **命令行** `--context-window N`：一次运行有效，优先级最高。
2. **手动配置**：`config.json` 的 `context_window_tokens`；旧键 `context_window`
   作兼容回退（CLI 以前读的是这个键，网关读的是 `context_window_tokens`，
   两边现在统一走 `manualWindowFromConfig`，以前配过哪个键都继续生效）。
3. **刷新缓存**：`~/.nyra/models.json`（`nyra models refresh` 拉取）。
4. **内置模型表**：随代码发版的 `MODEL_CATALOG`，精确匹配。
5. **内置模型表（同系列推断）**：带日期后缀的变体（如 `gpt-4o-mini-2024-07-18`）
   按同系列模型推断，显示里注明是推断。
6. **未知**：不猜数字。显示原因与下一步，例如“运行 `nyra models refresh` 更新，
   或用 `--context-window` / `context_window_tokens` 手动指定”。

手动配置仍可覆盖自动识别：只要配了 `context_window_tokens`，就优先于
内置表与刷新缓存，并在显示里注明“手动配置”。

## 内置模型表

`MODEL_CATALOG`（`src/modelCatalog.ts`，2026-11-20 整理）覆盖 `config.ts`
里 `PROVIDERS` 的全部模型（`codex-default` 除外：Codex CLI 用的模型由本机
Codex 决定，Nyra 从配置里看不到窗口，走 unknown 分支说明原因）。
每条记录：上下文窗口、最大输出（有把握的才填）、计价（美元 / 百万 token，
官方定价页的缓存未命中价，仅作参考，不进成本计算）、官方文档 URL、核实日期。
计价没把握的留空，不编数字。

数值来源（2026-11-20 核实）：

| 模型 | 窗口 | 来源 |
| --- | --- | --- |
| deepseek-flash / deepseek-v4-pro | 1,000,000（输出上限 393,216） | api-docs.deepseek.com/quick_start/pricing |
| grok-4.3 | 1,000,000 | docs.x.ai/docs/models |
| grok-4.5 | 500,000 | docs.x.ai/docs/models |
| gpt-4o-mini | 128,000（输出上限 16,384） | developers.openai.com/api/docs/pricing |
| gemini-2.5-flash / gemini-2.5-pro | 1,048,576（输出上限 65,536） | ai.google.dev/gemini-api/docs/pricing |
| nousresearch/hermes-4-14b | 32,768 | Hugging Face 模型卡 |
| nousresearch/hermes-4-70b | 131,072 | Hugging Face 模型卡 |
| qwen2.5:7b（Ollama） | 32,768（原生窗口） | ollama.com/library/qwen2.5:7b |
| qwen-plus | 131,072 | 阿里云百炼 Model Studio |
| qwen-turbo | 1,000,000 | 阿里云百炼 Model Studio |
| qwen3-max | 262,144 | 阿里云百炼 Model Studio |
| kimi-k3 | 1,048,576 | platform.kimi.ai/docs/pricing/chat |
| kimi-k2.6 / kimi-k2.5 | 262,144 | platform.kimi.ai/docs/pricing/chat |
| glm-5.3 | 1,048,576（输出上限 131,072） | docs.z.ai/guides/overview/quick-start |
| glm-5.2 | 202,752（输出上限 131,072） | docs.z.ai/guides/overview/quick-start |
| glm-4.7-flash / glm-4.5-flash | 202,752 / 131,072（API 上免费，限流） | docs.z.ai/guides/overview/quick-start |
| mistral-small/medium/large-latest | 131,072 | mistral.ai/pricing |
| codestral-latest | 262,144 | mistral.ai/pricing |
| llama-3.3-70b-versatile / llama-3.1-8b-instant / openai/gpt-oss-120b | 131,072 | groq.com/pricing |
| meta-llama/Llama-3.3-70B-Instruct-Turbo 等（Together） | 131,072；Qwen2.5-72B 为 32,768 | together.ai/pricing |
| deepseek-v4.1-flash（OpenLux） | 1,000,000（输出上限 393,216） | api-docs.deepseek.com/quick_start/pricing（2026-11-24 核实） |
| claude-sonnet-5-5 / claude-opus-5-5 / claude-sonnet-5 / claude-fable-5-2（OpenLux） | 1,000,000（输出上限 128,000） | platform.claude.com/docs/about-claude/models/overview（2026-11-24 核实） |
| gemini-3.8-flash / gemini-3.7-flash（OpenLux） | 1,000,000 | openlux.ai/pricing（2026-11-24 核实） |

注意：

- **OpenLux**：表里只记窗口（各家官方文档核实）；计价一律留空——OpenLux 按建 Key 时选的分组系数（官方价 × 系数）计费，分组不同价不同，见 openlux.ai/pricing。GPT-6 系与 gemini-4-argon 未在官方文档里核实到窗口，不进表；照样能用 `--model` 透传，窗口走 unknown 分支说明原因。
- **Ollama**：表里记的是模型原生窗口。Ollama 默认 `num_ctx` 为 4096，
  实际窗口以 Ollama 配置为准；`nyra models show qwen2.5:7b` 会提示这一点。
- **xAI 长上下文价**：grok 模型 prompt 超过 200,000 token 后按更高一档计费，
  表里记的是 200K 以下的价。
- **Kimi K2.5**：Moonshot 已于 2026-08-31 在自家 API 下线，第三方仍可跑。
- 内置表是发版时的人工快照，厂商改数值后会过期——过期了就靠刷新机制纠正，
  见下节。

## 视觉支持（看图）

`supportsVision`（`src/modelCatalog.ts`，缺口 16）：模型能不能看图。`true`
确认支持、`false` 确认不支持、没填就是没核实——没核实的走模型名启发式兜底，
启发式也不认的按看不了图拒绝（宁可拒绝，不假装能看）。

当前确认支持的：grok-4.3、grok-4.5、gpt-4o-mini、gemini-2.5-flash、
gemini-2.5-pro。确认不支持的（纯文本模型）：DeepSeek 两款、Hermes 两款、
Qwen 全系、Kimi k2 系列、GLM-4.5/4.7-flash、Codestral、Groq 三款、
Together 三款。没核实的（kimi-k3、glm-5.3/5.2、mistral-small/medium/
large-latest）留空走启发式。

`nyra --image <图片> "任务"` 前先过这一关：模型看不了图直接拒绝并告诉你
换哪个模型，不烧 token。详见 `docs/vision.md`。

## 刷新机制：`nyra models refresh`

```
nyra models refresh        # 从 OpenRouter 公开模型列表拉取，写入 ~/.nyra/models.json
nyra models                # 列出内置表 + 缓存里的模型窗口
nyra models show <模型名>  # 看一个模型的窗口、输出上限、计价与来源
nyra models list --provider deepseek   # 只列某个 provider 的模型
```

设计取舍：

- **只在显式调用时联网**。日常运行只读内置表 + 本地缓存，不发任何请求；
  刷新用 OpenRouter 的公开端点 `https://openrouter.ai/api/v1/models`（无需 Key），
  15 秒超时，取每个模型的 `context_length`、`pricing` 与
  `top_provider.max_completion_tokens`。
- **缓存只补内置表没有的模型**。内置表是人工核实过的值，缓存绝不覆盖它；
  新模型（或改名后的模型）靠缓存补上。缓存文件损坏时按“无缓存”处理，
  不影响运行。
- **刷新失败用旧缓存兜底**：拉取失败（断网、HTTP 非 200、格式不对、一个带
  窗口的模型都没有）时抛错，旧缓存文件原样保留，`nyra models refresh`
  返回 1 并在 stderr 说清原因；日常运行继续用内置表，不受影响。
- 缓存是本机文件（`~/.nyra/models.json`），不进仓库、不上传。

## 在哪能看到窗口与来源

- **用量汇总**：一次运行结束的“本次运行用量”里，窗口已知时显示
  “上下文窗口：1,000,000 tokens（内置模型表）；参考余量约 999,000”，
  窗口未知时显示模型名与下一步（`nyra models refresh` 或手动指定）。
- **`/context`**：REPL 里 `/context` 的“模型窗口”一行同样带来源。
- **`nyra doctor`**：“模型配置”一项的详情里追加上下文窗口与来源。
- **看板与网关**：`dashboard` 与网关压缩检查用的仍是同一个快照里的窗口值，
  来源字段随快照一起透传；自动压缩阈值（默认 80%）现在对已知模型默认生效，
  以前没配 `context_window_tokens` 时这项是关着的。

## 维护

- 厂商改了窗口或价格：改 `MODEL_CATALOG` 里对应条目的数值与 `updated`，
  并同步改 `MODEL_CATALOG_UPDATED`；测试 `test-model-catalog.test.ts`
  里有按官方文档断言的关键数值，改完要一起更新。
- 计价只作参考：成本硬顶与 `nyra cost` 仍以 `config.pricing` 为准，
  内置表价格不进成本计算。
- 测试不联网：刷新逻辑的 fetch 可注入，测试用假 fetch 覆盖成功、合并、
  失败兜底三种情况（见 `test-model-catalog.test.ts`）。
