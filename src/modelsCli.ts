// src/modelsCli.ts — `nyra models` 子命令：查模型窗口、刷新模型数据。
//
//   nyra models [list] [--provider 名字]   列出内置表 + 刷新缓存里的模型窗口
//   nyra models show <模型名>             看一个模型的窗口、输出上限、计价与来源
//   nyra models refresh                  从 OpenRouter 公开列表拉取最新数据进缓存
//   nyra models fallback                 看备用链开关、顺序与本月切换统计
//   nyra models handoff [id]             列最近的限流接力摘要，或看一条的全文
//   nyra models preset [best|fast|off]   看 / 设降级预设（best 能力优先、fast 便宜优先，只排兜底尾巴）
//   nyra models health [clear <名字>]    看故障账本（被标 degraded 的模型与恢复时间），或提前恢复某一个
//
// 日常运行不联网；只有 refresh 会发一次公网请求（15 秒超时），失败时旧缓存原样保留。
import { listCatalog, loadModelCache, lookupBuiltin, lookupCache, refreshModelCache, MODEL_CATALOG_UPDATED, OPENROUTER_MODELS_URL } from "./modelCatalog.ts";
import { getProviderPresets, loadConfig, resolveFallbackChain, resolveProvider, saveConfig } from "./config.ts";
import { modelSwitchSummaryLine, summarizeModelSwitches, switchTimeShort } from "./modelSwitch.ts";
import { getQuotaHandoff, readQuotaHandoffs, summarizeQuotaHandoffs } from "./quotaHandoff.ts";
import { clearDegraded, listDegraded, DEGRADED_RECOVERY_MINUTES } from "./modelHealth.ts";
import { getModelPreset, resolvePresetFallbackChain, scorePresetModels, type ModelPreset } from "./modelPresets.ts";

function fmtMoney(v: number | null | undefined): string {
  if (typeof v !== "number") return "—";
  return `$${v.toFixed(2)}`;
}

function fmtNum(v: number | null | undefined): string {
  return typeof v === "number" ? v.toLocaleString("en-US") : "—";
}

export async function handleModels(argv: string[], home: string): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = sub === "list" ? argv : argv.slice(1);
  if (sub === "refresh") {
    try {
      const r = await refreshModelCache({ home });
      process.stdout.write(`模型数据已刷新：本次拉取 ${r.fetched} 个模型，缓存共 ${r.kept} 个（${r.path}，${r.fetchedAt.slice(0, 10)}）。\n`);
      process.stdout.write("说明：缓存只补内置表没有的模型，内置表的人工核实值不会被覆盖。\n");
      return 0;
    } catch (err) {
      process.stderr.write(`模型数据刷新失败：${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write("已保留旧缓存（或无缓存）；日常运行继续用内置模型表，不受影响。\n");
      return 1;
    }
  }
  if (sub === "preset") {
    // G-P1-33：降级预设 best / fast。`nyra models preset` 只看不改；
    // `preset best|fast` 写入 config.json 的 model_preset（只改这一键，
    // 其余配置原样不动）；`preset off` 清掉。预设只排兜底尾巴的顺序，
    // 不换主模型、不碰 fallback_enabled 总开关。
    const arg = rest[0];
    const config = loadConfig(home);
    if (arg !== undefined && arg !== "best" && arg !== "fast" && arg !== "off") {
      process.stderr.write("用法：nyra models preset [best|fast|off]\n");
      return 2;
    }
    if (arg === "best" || arg === "fast") {
      saveConfig(home, { model_preset: arg });
      process.stdout.write(`降级预设已设为 ${arg}（${arg === "best" ? "能力优先" : "便宜优先"}）。\n`);
      process.stdout.write("说明：预设只排兜底尾巴的顺序，主模型不变；兜底开关（fallback_enabled）仍须另开才生效。\n");
    } else if (arg === "off") {
      saveConfig(home, { model_preset: null });
      process.stdout.write("降级预设已清除，兜底链走 fallback_providers 的原顺序。\n");
    }
    const current = loadConfig(home);
    const preset = getModelPreset(current);
    process.stdout.write(`当前降级预设：${preset ? `${preset}（${preset === "best" ? "能力优先：窗口降序、视觉优先、再按价格" : "便宜优先：输入价升序、输出价升序、再按窗口"}）` : "未设置（走 fallback_providers 的原顺序）"}。\n`);
    let primary = "?";
    try {
      primary = resolveProvider({ home, config: current }).name;
    } catch {
      process.stdout.write("主模型未配置或无法解析：请先在 config.json 里配好 provider / model。\n");
      return 1;
    }
    const chain = resolvePresetFallbackChain(current, primary, true);
    process.stdout.write(`兜底链（按预设排过）：${chain.join(" → ")}\n`);
    const ranked = scorePresetModels((preset ?? "fast") as ModelPreset).slice(0, 5);
    process.stdout.write(`该预设排序前 5 的模型：\n`);
    for (const r of ranked) {
      process.stdout.write(`  ${r.rank}. ${r.model}（${r.provider}，窗口 ${fmtNum(r.contextWindow)}，输入 ${fmtMoney(r.inputPricePer1M)} / 输出 ${fmtMoney(r.outputPricePer1M)}${r.supportsVision === true ? "，支持视觉" : ""}）\n`);
    }
    return 0;
  }
  if (sub === "health") {
    // G-P1-33：故障账本只读查看 + 提前清除。`nyra models health` 列出
    // 当前仍在 degraded 的 provider（恢复时间、原因、累计次数）；
    // `nyra models health clear <provider>` 提前恢复它（下次建链即重新选用）。
    const action = rest[0];
    if (action === "clear") {
      const provider = rest[1];
      if (!provider) {
        process.stderr.write("用法：nyra models health clear <provider>\n");
        return 2;
      }
      const ok = clearDegraded(home, provider);
      process.stdout.write(ok ? `${provider} 已提前恢复，下次建链即重新选用。\n` : `${provider} 当前没有被标故障，无需清除。\n`);
      return 0;
    }
    if (action !== undefined) {
      process.stderr.write("用法：nyra models health [clear <provider>]\n");
      return 2;
    }
    const degraded = listDegraded(home);
    if (degraded.length === 0) {
      process.stdout.write("当前没有被标故障的模型。\n");
      process.stdout.write(`说明：模型出故障被标 degraded 后默认 ${DEGRADED_RECOVERY_MINUTES} 分钟内不再选用，时间到自动恢复。\n`);
      return 0;
    }
    process.stdout.write("被标故障的模型（恢复时间前不再选用）：\n");
    for (const e of degraded) {
      process.stdout.write(`  ${e.provider}${e.model ? `（${e.model}）` : ""} | 恢复于 ${switchTimeShort(new Date(e.until))} | ${e.reason} | 累计标了 ${e.failures} 次\n`);
    }
    process.stdout.write("提前恢复某一个：nyra models health clear <provider>。\n");
    return 0;
  }
  if (sub === "fallback") {
    // 备用模型切换通知：开关、链顺序、本月切换统计一次看清。
    // 只读，不改配置；主模型解析失败时说清楚，不编链。
    const config = loadConfig(home);
    const enabled = config.fallback_enabled === true;
    let primary = "?";
    try {
      primary = resolveProvider({ home, config }).name;
    } catch {
      process.stdout.write("主模型未配置或无法解析：请先在 config.json 里配好 provider / model。\n");
      return 1;
    }
    const chain = resolveFallbackChain(config, primary);
    const summary = summarizeModelSwitches(home);
    process.stdout.write(`备用模型：${enabled ? "已开启" : "未开启（默认关闭；触顶时任务直接失败，不静默换）"}\n`);
    process.stdout.write(`主模型：${primary}\n`);
    process.stdout.write(`备用链：${chain.join(" → ") || primary}\n`);
    process.stdout.write(`允许列表：${(config.fallback_providers as string[] | undefined)?.join("、") ?? "（默认）"}\n`);
    // G-P1-33：预设只排兜底尾巴的顺序，主模型不变。
    const preset = getModelPreset(config);
    process.stdout.write(`降级预设：${preset ? `${preset}（${preset === "best" ? "能力优先" : "便宜优先"}，兜底尾巴按预设排序）` : "未设置（兜底尾巴走 fallback_providers 原顺序）"}。\n`);
    const line = modelSwitchSummaryLine(home);
    process.stdout.write(line ? line.trimStart() + "\n" : `本月模型切换 0 次。\n`);
    if (summary.count > 0 && summary.last) {
      process.stdout.write(`最近一次报错：${summary.last.error || "（无）"}\n`);
    }
    // Kooyu 429 接力：本月有接力摘要时露一行（只计数 + 最近一次的 id，
    // 全文用 `nyra models handoff` 看）；0 次时不打印。
    const handoffSummary = summarizeQuotaHandoffs(home);
    if (handoffSummary.count > 0 && handoffSummary.last) {
      process.stdout.write(`本月限流接力 ${handoffSummary.count} 次（最近一次：${handoffSummary.last.from} → ${handoffSummary.last.to}，接力摘要 ${handoffSummary.last.id}；运行 nyra models handoff 查看）。\n`);
    }
    // G-P1-33：当前仍在 degraded 的 provider 一并露出（有才打印）。
    const degraded = listDegraded(home);
    if (degraded.length > 0) {
      process.stdout.write(`故障账本：${degraded.map((e) => `${e.provider} 已标故障，${switchTimeShort(new Date(e.until))} 前不再选用`).join("；")}（运行 nyra models health 查看）。\n`);
    }
    process.stdout.write("说明：每次真切换都会立刻通知（终端 stderr、网关事件流、群聊回复内附），并记进模型切换审计（nyra governance audit export 可导出）。\n");
    return 0;
  }
  if (sub === "handoff") {
    // Kooyu 429 接力：只读查看接力摘要。`nyra models handoff` 列最近 10 条，
    // `nyra models handoff <id>` 看一条的全文。半自动到此为止——这里只查
    // 不续跑，续跑是主控或用户手动做的事。
    const id = rest[0];
    if (id) {
      const h = getQuotaHandoff(home, id);
      if (!h) {
        process.stderr.write(`没有这条接力摘要：${id}\n`);
        return 1;
      }
      process.stdout.write(`${h.summary}\n`);
      process.stdout.write(`接力记录：${h.id}（${h.at.slice(0, 16).replace("T", " ")}，${h.from} → ${h.to}，${h.trigger === "quota" ? "用量触顶" : "请求过于频繁"}${h.run_id ? `，运行 ${h.run_id}` : ""}）。\n`);
      return 0;
    }
    const all = readQuotaHandoffs(home).slice(-10).reverse();
    if (all.length === 0) {
      process.stdout.write("还没有限流接力摘要。\n");
      process.stdout.write("说明：限流/配额触发切换时才会生成接力摘要（最近任务 + 最近进展 + 已做修改）；非限流切换没有摘要。\n");
      return 0;
    }
    process.stdout.write("限流接力摘要（最近 10 条，新的在前）：\n");
    for (const h of all) {
      process.stdout.write(`${h.id} | ${h.at.slice(0, 16).replace("T", " ")} | ${h.from} → ${h.to} | ${h.trigger === "quota" ? "用量触顶" : "请求过于频繁"} | ${h.lastRequest ? h.lastRequest.slice(0, 40) : "（无最近任务）"}\n`);
    }
    process.stdout.write("看一条的全文：nyra models handoff <id>。\n");
    return 0;
  }
  if (sub === "show") {
    const model = rest[0];
    if (!model) {
      process.stderr.write("用法：nyra models show <模型名>\n");
      return 2;
    }
    const cache = loadModelCache(home);
    const builtin = lookupBuiltin(model);
    const cached = builtin ? null : lookupCache(cache, model);
    if (!builtin && !cached) {
      process.stdout.write(`模型 ${model} 未收录。\n`);
      process.stdout.write("可运行 nyra models refresh 从 OpenRouter 拉取最新数据，或用 --context-window / context_window_tokens 手动指定窗口。\n");
      return 0;
    }
    if (builtin) {
      const e = builtin.entry;
      process.stdout.write(`模型：${e.model}（${e.provider}，来源：${builtin.match === "exact" ? "内置模型表" : `内置模型表，同系列 ${e.model} 推断`}）\n`);
      process.stdout.write(`上下文窗口：${fmtNum(e.contextWindow)} tokens\n`);
      process.stdout.write(`最大输出：${fmtNum(e.maxOutputTokens)} tokens\n`);
      process.stdout.write(`计价（美元 / 百万 token）：输入 ${fmtMoney(e.inputPricePer1M)} / 输出 ${fmtMoney(e.outputPricePer1M)}\n`);
      process.stdout.write(`数据来源：${e.source}（${e.updated} 核实）\n`);
      if (e.note) process.stdout.write(`注意：${e.note}\n`);
      return 0;
    }
    process.stdout.write(`模型：${model}（来源：刷新缓存，${cache!.fetchedAt.slice(0, 10)} 从 ${OPENROUTER_MODELS_URL} 拉取）\n`);
    process.stdout.write(`上下文窗口：${fmtNum(cached!.contextWindow)} tokens\n`);
    process.stdout.write(`最大输出：${fmtNum(cached!.maxOutputTokens)} tokens\n`);
    process.stdout.write(`计价（美元 / 百万 token）：输入 ${fmtMoney(cached!.inputPricePer1M)} / 输出 ${fmtMoney(cached!.outputPricePer1M)}\n`);
    return 0;
  }
  if (sub !== "list") {
    process.stderr.write("用法：nyra models [list] [--provider 名字]；nyra models show <模型名>；nyra models refresh；nyra models fallback；nyra models handoff [id]；nyra models preset [best|fast|off]；nyra models health [clear <provider>]\n");
    return 2;
  }
  const providerFlag = rest.indexOf("--provider");
  const providerFilter = providerFlag >= 0 ? rest[providerFlag + 1] : undefined;
  if (providerFlag >= 0 && !providerFilter) {
    process.stderr.write("用法：nyra models list --provider <名字>\n");
    return 2;
  }
  const cache = loadModelCache(home);
  let rows = listCatalog(cache);
  if (providerFilter) {
    let allowed: Set<string> | null = null;
    try {
      const presets = getProviderPresets({});
      const preset = presets[providerFilter];
      allowed = preset ? new Set([...preset.models, providerFilter]) : new Set([providerFilter]);
    } catch {
      allowed = new Set([providerFilter]);
    }
    rows = rows.filter((r) => allowed!.has(r.entry.model) || allowed!.has(r.entry.provider));
  }
  process.stdout.write(`模型上下文窗口（内置表 ${MODEL_CATALOG_UPDATED} 整理；缓存：${cache ? `${cache.fetchedAt.slice(0, 10)} 拉取，共 ${Object.keys(cache.models).length} 个` : "未刷新过"}）：\n`);
  process.stdout.write("模型 | 窗口 | 最大输出 | 输入$/1M | 输出$/1M | 来源\n");
  for (const { entry, from } of rows) {
    const src = from === "cache" ? "缓存" : entry.source.replace(/^https?:\/\//, "").split("/")[0];
    process.stdout.write(`${entry.model} | ${fmtNum(entry.contextWindow)} | ${fmtNum(entry.maxOutputTokens)} | ${fmtMoney(entry.inputPricePer1M)} | ${fmtMoney(entry.outputPricePer1M)} | ${src}${entry.note ? `（${entry.note}）` : ""}\n`);
  }
  process.stdout.write("计价为官方定价页的缓存未命中价，仅作参考；实际计费以 config.pricing 为准。窗口数变了就运行 nyra models refresh 更新。\n");
  return 0;
}
