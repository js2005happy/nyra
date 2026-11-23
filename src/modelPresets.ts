// src/modelPresets.ts — 模型降级预设：best / fast 两档（G-P1-33）。
//
// Botpress packages/cognitive 借鉴（相似 agent 缺口报告 §2）：best / fast
// 两档预设，按标签、价格、厂商打分排序。Nyra 的内置模型表没有人工质量
// 标签，只有窗口、价格、视觉支持三项硬数据——排序键就只用这三项，
// 不编质量分、不给没核实过的模型排“强弱”：
//   - fast（便宜优先）：输入价升序 → 输出价升序 → 窗口降序 → 模型名升序。
//     没核实价格的（null）排最后——不编价格，也不假装它便宜。
//   - best（能力优先）：窗口降序 → 支持视觉优先 → 输入价升序 → 模型名升序。
//     窗口是能力最直接的硬指标；同窗口时视觉支持算能力加分，再按价格。
//
// 口径：
//   - 预设只排兜底尾巴的顺序，不换主模型：链首永远是用户配的主模型，
//     预设排的是“主模型挂了之后先试谁”。主模型本身也想换档时用
//     `nyra models preset` 看排序、手动改 config 的 provider / model。
//   - 预设存在 config.json 的 `model_preset`（"best" | "fast"，不填 = 不用
//     预设、走 fallback_providers 的原顺序）；显式 chainOverride
//     （每机器人自己的备用链）优先于预设——显式指定的顺序不动。
//   - 预设不碰 fallback_enabled 总开关：开关关着时链仍只有主模型，
//     预设只在“兜底已开、链不止一家”时生效。
import { MODEL_CATALOG, type ModelCapability } from "./modelCatalog.ts";
import { resolveFallbackChain, resolveSwitchAllowlist } from "./config.ts";

/** 降级预设两档。 */
export type ModelPreset = "best" | "fast";

/** config.json 里预设的键。 */
export const MODEL_PRESET_KEY = "model_preset";

/** 预设排序后的一行：名次 + 决定排序的硬字段（不编合成分数）。 */
export interface ScoredModel {
  rank: number;
  model: string;
  provider: string;
  contextWindow: number;
  inputPricePer1M: number | null;
  outputPricePer1M: number | null;
  supportsVision: boolean | null;
}

function priceOrLast(v: number | null | undefined): number {
  return typeof v === "number" ? v : Number.POSITIVE_INFINITY;
}

/**
 * 按预设给模型排序（纯函数，确定性）。entries 默认取内置模型表。
 * fast：输入价 → 输出价 → 窗口 → 模型名；best：窗口 → 视觉 → 输入价 → 模型名。
 */
export function scorePresetModels(
  preset: ModelPreset,
  entries: ModelCapability[] = MODEL_CATALOG,
): ScoredModel[] {
  const sorted = [...entries].sort((a, b) => {
    if (preset === "fast") {
      const byIn = priceOrLast(a.inputPricePer1M) - priceOrLast(b.inputPricePer1M);
      if (byIn !== 0) return byIn;
      const byOut = priceOrLast(a.outputPricePer1M) - priceOrLast(b.outputPricePer1M);
      if (byOut !== 0) return byOut;
      const byWindow = b.contextWindow - a.contextWindow;
      if (byWindow !== 0) return byWindow;
    } else {
      const byWindow = b.contextWindow - a.contextWindow;
      if (byWindow !== 0) return byWindow;
      const byVision = Number(b.supportsVision === true) - Number(a.supportsVision === true);
      if (byVision !== 0) return byVision;
      const byIn = priceOrLast(a.inputPricePer1M) - priceOrLast(b.inputPricePer1M);
      if (byIn !== 0) return byIn;
    }
    return a.model.localeCompare(b.model);
  });
  return sorted.map((e, i) => ({
    rank: i + 1,
    model: e.model,
    provider: e.provider,
    contextWindow: e.contextWindow,
    inputPricePer1M: e.inputPricePer1M ?? null,
    outputPricePer1M: e.outputPricePer1M ?? null,
    supportsVision: e.supportsVision ?? null,
  }));
}

/** 读 config 里的预设：只有 "best" / "fast" 算数，其余（含 null）一律当没设。 */
export function getModelPreset(config: Record<string, unknown>): ModelPreset | null {
  const raw = config[MODEL_PRESET_KEY];
  return raw === "best" || raw === "fast" ? raw : null;
}

/**
 * 一个 provider 在某预设下的代表名次：取它在内置表里名次最好的模型；
 * 表里没有该 provider 的模型时返回 Infinity（排最后、保持原顺序）。
 */
function providerPresetRank(preset: ModelPreset, provider: string, scored: ScoredModel[]): number {
  const hit = scored.find((s) => s.provider === provider);
  return hit ? hit.rank : Number.POSITIVE_INFINITY;
}

/**
 * 按预设排一条兜底链（链首主模型不动，只排尾巴）。
 * 显式 chainOverride 时原样走 resolveFallbackChain（显式顺序优先于预设）；
 * 没设预设时同样原样返回——老行为一字不改。
 */
export function resolvePresetFallbackChain(
  config: Record<string, unknown>,
  primary: string,
  enabled?: boolean,
  chainOverride?: string[] | null,
): string[] {
  if (chainOverride !== undefined && chainOverride !== null) {
    return resolveFallbackChain(config, primary, enabled, chainOverride);
  }
  const preset = getModelPreset(config);
  if (!preset) return resolveFallbackChain(config, primary, enabled);
  // 预设排序只在兜底开着时有意义：先拿允许列表（开关强制开着算），
  // 再按预设排尾巴；开关本身仍由 enabled / config 决定——关着时
  // resolveFallbackChain 只回 [primary]，预设不把它撑开。
  const allowlist = resolveSwitchAllowlist(config, primary);
  if (allowlist.length <= 1) return resolveFallbackChain(config, primary, enabled);
  const scored = scorePresetModels(preset);
  const tail = allowlist.slice(1);
  const ranked = tail
    .map((name, i) => ({ name, rank: providerPresetRank(preset, name, scored), order: i }))
    .sort((a, b) => (a.rank - b.rank) || (a.order - b.order))
    .map((r) => r.name);
  const ordered = [allowlist[0], ...ranked];
  // 开关关着：只留主模型（与 resolveFallbackChain 关着时的口径一致）。
  const base = resolveFallbackChain(config, primary, enabled);
  if (base.length <= 1) return base;
  return ordered;
}
