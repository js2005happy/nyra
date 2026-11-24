// src/modelCatalog.ts — 模型上下文窗口自动识别：内置模型能力登记表 + 刷新缓存。
//
// 背景：用量汇总曾写“上下文剩余：未知（未配置该模型的 context_window_tokens）”，
// 用户要求 agent 自动识别所用模型的窗口、官网数据自动摘录、不再手动配置。
// 方案（取舍写在 docs/model-catalog.md）：
//   1. 内置一张带来源与日期的模型能力登记表（MODEL_CATALOG），随代码发版，
//      日常运行只读这张表，不联网；
//   2. `nyra models refresh` 从 OpenRouter 的公开模型列表拉取更新，写入
//      ~/.nyra/models.json 缓存；缓存只补内置表没有的模型，绝不覆盖人工核实过的
//      内置值；刷新失败用旧缓存兜底并明确提示；
//   3. 解析优先级：--context-window > 手动配置（context_window_tokens，
//      旧键 context_window 作兼容回退）> 刷新缓存 > 内置表（精确，再同系列
//      前缀）> 未知（给原因与下一步，不只写“未知”）。
//   4. 价格是附带的参考值（美元 / 百万 token，缓存未命中价）；计费仍以
//      config.pricing 为准，内置表价格不进成本计算。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextLimit } from "./usage.ts";

/** 窗口数值的来源：命令行 > 手动配置 > 刷新缓存 > 内置表 > 同系列推断 > 未知。 */
export type WindowSource = "cli" | "manual" | "cache" | "builtin" | "family" | "unknown";

/** 内置表里一条模型的能力数据。source 是官方文档 URL，updated 是核实日期。 */
export interface ModelCapability {
  model: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens?: number | null;
  inputPricePer1M?: number | null;
  outputPricePer1M?: number | null;
  source: string;
  updated: string;
  /** 需要向用户说明的 caveat（如 Ollama 实际窗口受 num_ctx 影响）。 */
  note?: string;
  /**
   * 缺口 16：是否支持看图（视觉输入）。true = 确认支持（如 gpt-4o-mini、
   * gemini-2.5、grok-4.3/4.5）；false = 确认不支持（纯文本模型）；
   * 不填/null = 未核实，判定回退到 vision.ts 的模型名启发式（宁可拒，不假装能看）。
   */
  supportsVision?: boolean | null;
}

/** 内置表版本（整理日期）：每次人工更新数值时改这一处与各条的 updated。 */
export const MODEL_CATALOG_UPDATED = "2026-11-24";

/**
 * 内置模型能力登记表（2026-11-20 整理，OpenLux 7 条 2026-11-24 补入；数值与来源逐项见 docs/model-catalog.md）。
 * 只覆盖 config.ts 里 PROVIDERS 的模型；codex-default 不在表里——Codex CLI
 * 用的模型由本机 Codex 决定，Nyra 从配置里看不到窗口，走 unknown 分支说明原因。
 * 计价为官方定价页的缓存未命中价（美元 / 百万 token），仅作参考，不进成本计算；
 * 没把握的留 null，不编数字。OpenLux 的价是官方价 × 建 Key 时选的分组系数，
 * 分组不同价不同，所以 OpenLux 各条计价一律留 null，见 note。
 */
export const MODEL_CATALOG: ModelCapability[] = [
  // DeepSeek（api-docs.deepseek.com/quick_start/pricing）：两模型均为 1M 窗口、384K 输出。
  { model: "deepseek-flash", provider: "deepseek", supportsVision: false, contextWindow: 1_000_000, maxOutputTokens: 393_216, inputPricePer1M: 0.30, outputPricePer1M: 1.20, source: "https://api-docs.deepseek.com/quick_start/pricing", updated: "2026-11-20" },
  { model: "deepseek-v4-pro", provider: "deepseek", supportsVision: false, contextWindow: 1_000_000, maxOutputTokens: 393_216, inputPricePer1M: 1.32, outputPricePer1M: 3.96, source: "https://api-docs.deepseek.com/quick_start/pricing", updated: "2026-11-20" },
  // xAI（docs.x.ai/docs/models）：grok-4.3 为 1M，grok-4.5 为 500K；200K 以上按长上下文价计费。
  { model: "grok-4.3", provider: "xai", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: null, inputPricePer1M: 1.25, outputPricePer1M: 2.50, source: "https://docs.x.ai/docs/models", updated: "2026-11-20" },
  { model: "grok-4.5", provider: "xai", supportsVision: true, contextWindow: 500_000, maxOutputTokens: null, inputPricePer1M: 2.00, outputPricePer1M: 6.00, source: "https://docs.x.ai/docs/models", updated: "2026-11-20" },
  // OpenRouter / Nous Hermes（模型卡见 Hugging Face）：70B 为 Llama 3.1 底座 131,072；
  // 14B 为 Qwen3-14B 底座，按原生 32,768 记。
  { model: "nousresearch/hermes-4-14b", provider: "openrouter", supportsVision: false, contextWindow: 32_768, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://huggingface.co/NousResearch/Hermes-4-14B", updated: "2026-11-20" },
  { model: "nousresearch/hermes-4-70b", provider: "openrouter", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: 0.13, outputPricePer1M: 0.40, source: "https://huggingface.co/NousResearch/Hermes-4-70B", updated: "2026-11-20" },
  // Ollama 本地模型（ollama.com/library/qwen2.5:7b）：32,768 是模型原生窗口；
  // Ollama 默认 num_ctx 为 4096，实际窗口以 Ollama 配置为准，见 note。
  { model: "qwen2.5:7b", provider: "ollama", supportsVision: false, contextWindow: 32_768, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://ollama.com/library/qwen2.5:7b", updated: "2026-11-20", note: "Ollama 默认 num_ctx 为 4096，实际窗口以 Ollama 配置为准" },
  // OpenAI（developers.openai.com/api/docs/pricing）：128K 窗口、16,384 输出。
  { model: "gpt-4o-mini", provider: "openai", supportsVision: true, contextWindow: 128_000, maxOutputTokens: 16_384, inputPricePer1M: 0.15, outputPricePer1M: 0.60, source: "https://developers.openai.com/api/docs/pricing", updated: "2026-11-20" },
  // 阿里云百炼 Model Studio / DashScope（help.aliyun.com/zh/model-studio/models）。
  { model: "qwen-plus", provider: "qwen", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: 0.40, outputPricePer1M: 1.20, source: "https://help.aliyun.com/zh/model-studio/models", updated: "2026-11-20" },
  { model: "qwen-turbo", provider: "qwen", supportsVision: false, contextWindow: 1_000_000, maxOutputTokens: null, inputPricePer1M: 0.05, outputPricePer1M: 0.20, source: "https://help.aliyun.com/zh/model-studio/models", updated: "2026-11-20" },
  { model: "qwen3-max", provider: "qwen", supportsVision: false, contextWindow: 262_144, maxOutputTokens: null, inputPricePer1M: 1.20, outputPricePer1M: 6.00, source: "https://help.aliyun.com/zh/model-studio/models", updated: "2026-11-20" },
  // Moonshot Kimi（platform.kimi.ai/docs/pricing/chat）。
  { model: "kimi-k3", provider: "kimi", contextWindow: 1_048_576, maxOutputTokens: null, inputPricePer1M: 3.00, outputPricePer1M: 15.00, source: "https://platform.kimi.ai/docs/pricing/chat", updated: "2026-11-20" },
  { model: "kimi-k2.6", provider: "kimi", supportsVision: false, contextWindow: 262_144, maxOutputTokens: null, inputPricePer1M: 0.95, outputPricePer1M: 4.00, source: "https://platform.kimi.ai/docs/pricing/chat", updated: "2026-11-20" },
  { model: "kimi-k2.5", provider: "kimi", supportsVision: false, contextWindow: 262_144, maxOutputTokens: null, inputPricePer1M: 0.50, outputPricePer1M: 2.50, source: "https://platform.kimi.ai/docs/pricing/chat", updated: "2026-11-20", note: "Moonshot 已于 2026-08-31 在自家 API 下线该模型，第三方仍可跑" },
  // 智谱 GLM（docs.z.ai/guides/overview/quick-start）。
  { model: "glm-5.3", provider: "glm", contextWindow: 1_048_576, maxOutputTokens: 131_072, inputPricePer1M: null, outputPricePer1M: null, source: "https://docs.z.ai/guides/overview/quick-start", updated: "2026-11-20" },
  { model: "glm-5.2", provider: "glm", contextWindow: 202_752, maxOutputTokens: 131_072, inputPricePer1M: null, outputPricePer1M: null, source: "https://docs.z.ai/guides/overview/quick-start", updated: "2026-11-20", note: "与 GLM-5 同系列，窗口按 200K 档记" },
  { model: "glm-4.7-flash", provider: "glm", supportsVision: false, contextWindow: 202_752, maxOutputTokens: null, inputPricePer1M: 0, outputPricePer1M: 0, source: "https://docs.z.ai/guides/overview/quick-start", updated: "2026-11-20", note: "API 上免费（限流）" },
  { model: "glm-4.5-flash", provider: "glm", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: 0, outputPricePer1M: 0, source: "https://docs.z.ai/guides/overview/quick-start", updated: "2026-11-20", note: "API 上免费（限流）" },
  // Google Gemini（ai.google.dev/gemini-api/docs/pricing）：两模型均为 1,048,576 窗口、65,536 输出。
  { model: "gemini-2.5-flash", provider: "gemini", supportsVision: true, contextWindow: 1_048_576, maxOutputTokens: 65_536, inputPricePer1M: 0.30, outputPricePer1M: 2.50, source: "https://ai.google.dev/gemini-api/docs/pricing", updated: "2026-11-20" },
  { model: "gemini-2.5-pro", provider: "gemini", supportsVision: true, contextWindow: 1_048_576, maxOutputTokens: 65_536, inputPricePer1M: 1.25, outputPricePer1M: 10.00, source: "https://ai.google.dev/gemini-api/docs/pricing", updated: "2026-11-20" },
  // Mistral（mistral.ai/pricing）：Small/Medium/Large 均为 128K，Codestral 为 256K；计价未核实，留空。
  { model: "mistral-small-latest", provider: "mistral", contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://mistral.ai/pricing", updated: "2026-11-20" },
  { model: "mistral-medium-latest", provider: "mistral", contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://mistral.ai/pricing", updated: "2026-11-20" },
  { model: "mistral-large-latest", provider: "mistral", contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://mistral.ai/pricing", updated: "2026-11-20" },
  { model: "codestral-latest", provider: "mistral", supportsVision: false, contextWindow: 262_144, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://mistral.ai/pricing", updated: "2026-11-20" },
  // Groq（groq.com/pricing）：三模型均为 128K；计价未核实，留空。
  { model: "llama-3.3-70b-versatile", provider: "groq", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://groq.com/pricing", updated: "2026-11-20" },
  { model: "llama-3.1-8b-instant", provider: "groq", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://groq.com/pricing", updated: "2026-11-20" },
  { model: "openai/gpt-oss-120b", provider: "groq", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://groq.com/pricing", updated: "2026-11-20" },
  // Together（together.ai/pricing）：Llama 系 128K，Qwen2.5-72B 为 32,768；计价未核实，留空。
  { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", provider: "together", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://www.together.ai/pricing", updated: "2026-11-20" },
  { model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", provider: "together", supportsVision: false, contextWindow: 131_072, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://www.together.ai/pricing", updated: "2026-11-20" },
  { model: "Qwen/Qwen2.5-72B-Instruct-Turbo", provider: "together", supportsVision: false, contextWindow: 32_768, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://www.together.ai/pricing", updated: "2026-11-20" },
  // OpenLux（2026-11-24 核实）：窗口数来自各家官方文档（Anthropic / DeepSeek / OpenLux
  // 定价页）；计价一律留 null——OpenLux 按建 Key 时选的分组系数（官方价 × 系数）计费，
  // 分组不同价不同，见 note。GPT-6 系与 gemini-4-argon 未在官方文档里核实到窗口，
  // 不进表（照样能用 --model 透传，窗口走 unknown 分支说明原因）。
  { model: "deepseek-v4.1-flash", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: 393_216, inputPricePer1M: null, outputPricePer1M: null, source: "https://api-docs.deepseek.com/quick_start/pricing", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
  { model: "claude-sonnet-5-5", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: null, outputPricePer1M: null, source: "https://platform.claude.com/docs/about-claude/models/overview", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
  { model: "claude-opus-5-5", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: null, outputPricePer1M: null, source: "https://platform.claude.com/docs/about-claude/models/overview", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
  { model: "claude-sonnet-5", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: null, outputPricePer1M: null, source: "https://platform.claude.com/docs/about-claude/models/overview", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
  { model: "claude-fable-5-2", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: null, outputPricePer1M: null, source: "https://platform.claude.com/docs/about-claude/models/overview", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
  { model: "gemini-3.8-flash", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://www.openlux.ai/pricing", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
  { model: "gemini-3.7-flash", provider: "openlux", supportsVision: true, contextWindow: 1_000_000, maxOutputTokens: null, inputPricePer1M: null, outputPricePer1M: null, source: "https://www.openlux.ai/pricing", updated: "2026-11-24", note: "OpenLux 按分组系数计价，见 openlux.ai/pricing" },
];

/** 刷新缓存的来源：OpenRouter 公开模型列表（无需 Key），含 context_length 与计价。 */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MODEL_CACHE_VERSION = 1;

export interface ModelCacheEntry {
  contextWindow: number;
  maxOutputTokens?: number | null;
  inputPricePer1M?: number | null;
  outputPricePer1M?: number | null;
}

export interface ModelCache {
  version: number;
  fetchedAt: string;
  source: string;
  models: Record<string, ModelCacheEntry>;
}

export function modelCachePath(home: string): string {
  return join(home, "models.json");
}

/** 解析缓存文件内容：形状不对（损坏/旧版）返回 null，调用方按“无缓存”处理。 */
export function parseModelCache(raw: unknown): ModelCache | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.version !== MODEL_CACHE_VERSION || typeof c.fetchedAt !== "string" || typeof c.source !== "string") return null;
  if (!c.models || typeof c.models !== "object" || Array.isArray(c.models)) return null;
  const models: Record<string, ModelCacheEntry> = {};
  for (const [id, v] of Object.entries(c.models as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const win = contextLimit(e.contextWindow);
    if (win === null) continue;
    models[id] = {
      contextWindow: win,
      maxOutputTokens: contextLimit(e.maxOutputTokens ?? null),
      inputPricePer1M: typeof e.inputPricePer1M === "number" && e.inputPricePer1M >= 0 ? e.inputPricePer1M : null,
      outputPricePer1M: typeof e.outputPricePer1M === "number" && e.outputPricePer1M >= 0 ? e.outputPricePer1M : null,
    };
  }
  return { version: MODEL_CACHE_VERSION, fetchedAt: c.fetchedAt as string, source: c.source as string, models };
}

/** 读缓存：文件不存在或损坏返回 null（不抛错，日常运行不因缓存坏掉而失败）。 */
export function loadModelCache(home: string): ModelCache | null {
  const path = modelCachePath(home);
  if (!existsSync(path)) return null;
  try {
    return parseModelCache(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

/** 模型名归一化：去首尾空白；带厂商前缀的 OpenRouter 风格 id（openai/gpt-4o-mini）也试后缀。 */
function candidateIds(model: string): string[] {
  const id = model.trim();
  const out = [id];
  const slash = id.lastIndexOf("/");
  if (slash >= 0 && slash < id.length - 1) out.push(id.slice(slash + 1));
  return [...new Set(out)];
}

/** 内置表查找：精确（含大小写不敏感与厂商前缀剥离），再同系列前缀（如 gpt-4o-mini-2024-07-18）。 */
export function lookupBuiltin(model: string): { entry: ModelCapability; match: "exact" | "family" } | null {
  const candidates = candidateIds(model);
  for (const id of candidates) {
    const exact = MODEL_CATALOG.find((e) => e.model === id);
    if (exact) return { entry: exact, match: "exact" };
  }
  const lower = model.trim().toLowerCase();
  const ci = MODEL_CATALOG.find((e) => e.model.toLowerCase() === lower);
  if (ci) return { entry: ci, match: "exact" };
  for (const id of candidates) {
    const fam = MODEL_CATALOG.find((e) => id.startsWith(e.model + "-"));
    if (fam) return { entry: fam, match: "family" };
  }
  return null;
}

/** 缓存查找：与内置表同款归一化；缓存只补内置表没有的模型（见 resolveContextWindow）。 */
export function lookupCache(cache: ModelCache | null, model: string): ModelCacheEntry | null {
  if (!cache) return null;
  for (const id of candidateIds(model)) {
    if (cache.models[id]) return cache.models[id];
  }
  const lower = model.trim().toLowerCase();
  const key = Object.keys(cache.models).find((k) => k.toLowerCase() === lower);
  return key ? cache.models[key] : null;
}

export interface ResolvedWindow {
  window: number | null;
  source: WindowSource;
  /** 实际用于解析的模型名（null = 本次没用到模型名，如纯命令行指定）。 */
  model: string | null;
  /** 给人看的一句话说明（来源或未知原因 + 下一步）。 */
  detail: string;
  entry?: ModelCapability;
}

/**
 * 手动配置的窗口：先读文档化的 context_window_tokens，再兼容旧键 context_window。
 * 两个键都没配（或不合法）返回 null。返回用到的键名，方便显示“手动配置”时注明。
 */
export function manualWindowFromConfig(config: Record<string, unknown>): { value: number | null; key: "context_window_tokens" | "context_window" | null } {
  const main = contextLimit(config.context_window_tokens);
  if (main !== null) return { value: main, key: "context_window_tokens" };
  const legacy = contextLimit(config.context_window);
  if (legacy !== null) return { value: legacy, key: "context_window" };
  return { value: null, key: null };
}

/**
 * 解析本次运行的上下文窗口。优先级：
 * CLI --context-window > 手动配置 > 刷新缓存 > 内置表精确 > 内置表同系列 > 未知。
 * 未知模型不猜数字：返回 window=null + 原因与下一步（刷新或手动指定）。
 */
export function resolveContextWindow(opts: {
  model?: string | null;
  provider?: string | null;
  cli?: number | null;
  manual?: number | null;
  manualKey?: "context_window_tokens" | "context_window" | null;
  cache?: ModelCache | null;
}): ResolvedWindow {
  const model = opts.model?.trim() ? opts.model.trim() : null;
  const cliWindow = contextLimit(opts.cli ?? null);
  if (cliWindow !== null) {
    return { window: cliWindow, source: "cli", model, detail: "命令行 --context-window 指定" };
  }
  const manualWindow = contextLimit(opts.manual ?? null);
  if (manualWindow !== null) {
    const key = opts.manualKey ?? "context_window_tokens";
    return { window: manualWindow, source: "manual", model, detail: `手动配置（config.json 的 ${key}）` };
  }
  if (model) {
    const builtin = lookupBuiltin(model);
    const cached = builtin ? null : lookupCache(opts.cache ?? null, model);
    if (cached) {
      return {
        window: cached.contextWindow, source: "cache", model,
        detail: `刷新缓存（OpenRouter，${opts.cache!.fetchedAt.slice(0, 10)} 拉取）`,
        entry: { model, provider: opts.provider ?? "", contextWindow: cached.contextWindow, maxOutputTokens: cached.maxOutputTokens ?? null, inputPricePer1M: cached.inputPricePer1M ?? null, outputPricePer1M: cached.outputPricePer1M ?? null, source: OPENROUTER_MODELS_URL, updated: opts.cache!.fetchedAt.slice(0, 10) },
      };
    }
    if (builtin) {
      return {
        window: builtin.entry.contextWindow,
        source: builtin.match === "exact" ? "builtin" : "family",
        model, detail: builtin.match === "exact" ? `内置模型表（${builtin.entry.updated} 核实）` : `内置模型表（同系列 ${builtin.entry.model} 推断，${builtin.entry.updated} 核实）`,
        entry: builtin.entry,
      };
    }
    if (opts.provider === "codex") {
      return { window: null, source: "unknown", model, detail: "Codex CLI 用的模型由本机 Codex 决定，Nyra 从配置里看不到窗口；可用 --context-window 或 context_window_tokens 手动指定" };
    }
    if (opts.provider === "ollama") {
      return { window: null, source: "unknown", model, detail: `本地模型 ${model} 不在内置表里；运行 nyra models refresh 更新，或用 --context-window / context_window_tokens 手动指定（实际窗口还受 Ollama num_ctx 影响）` };
    }
    return { window: null, source: "unknown", model, detail: `模型 ${model} 未在内置模型表与刷新缓存中找到；运行 nyra models refresh 更新，或用 --context-window / context_window_tokens 手动指定` };
  }
  return { window: null, source: "unknown", model: null, detail: "未指定模型，无法识别窗口；用 --context-window 或 context_window_tokens 手动指定" };
}

/** 列表视图：内置表在前，缓存里独有的模型在后（标注“缓存”）。 */
export function listCatalog(cache: ModelCache | null): { entry: ModelCapability; from: "builtin" | "cache" }[] {
  const rows: { entry: ModelCapability; from: "builtin" | "cache" }[] = MODEL_CATALOG.map((entry) => ({ entry, from: "builtin" as const }));
  if (cache) {
    const builtinIds = new Set(MODEL_CATALOG.map((e) => e.model));
    for (const [id, e] of Object.entries(cache.models)) {
      if (builtinIds.has(id)) continue;
      rows.push({
        entry: { model: id, provider: "", contextWindow: e.contextWindow, maxOutputTokens: e.maxOutputTokens ?? null, inputPricePer1M: e.inputPricePer1M ?? null, outputPricePer1M: e.outputPricePer1M ?? null, source: OPENROUTER_MODELS_URL, updated: cache.fetchedAt.slice(0, 10) },
        from: "cache" as const,
      });
    }
  }
  return rows;
}

function pricePer1M(raw: unknown): number | null {
  // OpenRouter 的 pricing.prompt/completion 是“美元 / token”的字符串；转成“美元 / 百万 token”。
  const n = typeof raw === "string" ? parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

/**
 * 从 OpenRouter 公开模型列表刷新缓存（`nyra models refresh` 用）。
 * 只在显式调用时联网；日常运行绝不调它。成功后把新数据与旧缓存合并写入
 * ~/.nyra/models.json；失败抛错，旧缓存原样保留（调用方负责提示）。
 * fetchFn / now 可注入，测试用假 fetch，不联网。
 */
export async function refreshModelCache(opts: {
  home: string;
  fetchFn?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
}): Promise<{ fetched: number; kept: number; path: string; fetchedAt: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  let payload: unknown;
  try {
    const resp = await fetchFn(OPENROUTER_MODELS_URL, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`OpenRouter 模型列表返回 HTTP ${resp.status}`);
    payload = await resp.json();
  } finally {
    clearTimeout(timer);
  }
  const list = (payload as { data?: unknown })?.data;
  if (!Array.isArray(list)) throw new Error("OpenRouter 模型列表格式不对（缺 data 数组）");
  const fresh: Record<string, ModelCacheEntry> = {};
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || !m.id) continue;
    const win = contextLimit(m.context_length);
    if (win === null) continue;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const top = (m.top_provider ?? {}) as Record<string, unknown>;
    fresh[m.id] = {
      contextWindow: win,
      maxOutputTokens: contextLimit(top.max_completion_tokens ?? null),
      inputPricePer1M: pricePer1M(pricing.prompt),
      outputPricePer1M: pricePer1M(pricing.completion),
    };
  }
  if (Object.keys(fresh).length === 0) throw new Error("OpenRouter 模型列表里没有带 context_length 的模型，缓存未更新");
  const fetchedAt = (opts.now ?? new Date()).toISOString();
  const old = loadModelCache(opts.home);
  const merged: ModelCache = {
    version: MODEL_CACHE_VERSION,
    fetchedAt,
    source: OPENROUTER_MODELS_URL,
    models: { ...(old?.models ?? {}), ...fresh },
  };
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  writeFileSync(modelCachePath(opts.home), JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return { fetched: Object.keys(fresh).length, kept: Object.keys(merged.models).length, path: modelCachePath(opts.home), fetchedAt };
}
