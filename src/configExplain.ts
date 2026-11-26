// src/configExplain.ts — 「这个能力到底由哪个配置控制、当前生效值是什么」。
//
// 问题：现在控制同一件事的入口有多个——features.tool_search、tool_search.enabled、
// NYRA_LAZY_TOOLS 环境变量；cost 有 max_cost_usd / --max-cost；回忆有 features.run_recall。
// 用户改了一处不生效，只能翻源码。这里给一张可查询的表。
//
// 设计纪律：
//   - **只说生效值与其来源**，不重复计算业务逻辑（避免两套实现分叉）
//   - 每个能力列出**所有入口**，即使只有一个被使用——让人看到"还有别的地方能改它"
//   - 有冲突时明确指出（例如 features 关但 config 开），不装作没冲突
import { featureOn, resolveFeatures, type FeatureResolution } from "./features.ts";
import { resolveAuxRouting, resolvePlanActRouting } from "./modelRouting.ts";
import { resolveReasoningOptions } from "./reasoning.ts";
import { resolveExtraDirs } from "./extraDirs.ts";
import { resolveStrictUnknownAmount } from "./budget.ts";
import { resolveTrustLadderSettings } from "./trustLadder.ts";
import { resolveReconcilerSettings } from "./reconciler.ts";
import { resolveWatchSettings } from "./watch.ts";
import { DEFAULT_DENY_READ_GLOBS } from "./config.ts";

export type ExplainSource = "cli" | "config" | "env" | "default" | "conflict";

export interface CapabilityExplain {
  /** 能力名（用户查询用的键）。 */
  capability: string;
  /** 当前是否生效（布尔能力）或生效值（字符串/数字能力）。 */
  effective: string;
  source: ExplainSource;
  /** 控制它的所有入口（不只是实际生效的那个）。 */
  keys: string[];
  /** 一句话说明，含冲突提示。 */
  note: string;
}

export interface ExplainInput {
  config: Record<string, unknown>;
  /** CLI 覆盖（--enable-feature / --disable-feature / --max-cost / --add-dir）。 */
  cli?: { enableFeatures?: string[]; disableFeatures?: string[]; maxCost?: number | null; addDirs?: string[] } | null;
  env?: Record<string, string | undefined>;
}

function envOf(input: ExplainInput, key: string): string | undefined {
  const e = input.env ?? process.env;
  return e[key];
}

function on(v: unknown): boolean | null {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "yes") return true;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return typeof v === "undefined" || v === null ? null : null;
}

/** 把 config 里的一条路径取出来（a.b.c）。 */
function pick(cfg: Record<string, unknown>, path: string): unknown {
  let cur: unknown = cfg;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 解析全部能力（按固定顺序，便于测试与展示）。 */
export function explainAll(input: ExplainInput): CapabilityExplain[] {
  const cfg = input.config ?? {};
  const cli = input.cli ?? {};
  const features: FeatureResolution = resolveFeatures(cfg, {
    enable: cli.enableFeatures ?? [],
    disable: cli.disableFeatures ?? [],
  });
  const out: CapabilityExplain[] = [];

  // 1) 工具延迟加载
  {
    const envOff = (envOf(input, "NYRA_LAZY_TOOLS") ?? "").trim() === "0";
    const configOn = on(pick(cfg, "tool_search.enabled")) === true;
    const flagOn = featureOn(features, "tool_search");
    const enabled = !envOff && (configOn || flagOn);
    const source: ExplainSource = envOff ? "env" : flagOn ? "config" : configOn ? "config" : "default";
    const conflict = !envOff && (configOn || flagOn);
    out.push({
      capability: "tool_search",
      effective: enabled ? "on" : "off",
      source,
      keys: ["features.tool_search", "tool_search.enabled", "NYRA_LAZY_TOOLS", "--enable-feature tool_search"],
      note: envOff
        ? "NYRA_LAZY_TOOLS=0 一票否决（排障用），其余开关全部无效"
        : enabled
          ? `已开启（来源：${flagOn ? "features.tool_search" : "tool_search.enabled"}）`
          : "未开启：MCP 工具超过 8 个时仍会自动开启",
    });
    if (conflict) out[out.length - 1].note += "；注意有两处都开着，改一处不会关掉";
  }

  // 2) 跨会话回忆
  {
    const enabled = featureOn(features, "run_recall");
    const src = features.features.find((f) => f.name === "run_recall")?.source ?? "default";
    out.push({
      capability: "run_recall",
      effective: enabled ? "on" : "off",
      source: src === "cli" ? "cli" : src === "config" ? "config" : "default",
      keys: ["features.run_recall", "--disable-feature run_recall", "redlines.thresholds.recallMaxAgeDays"],
      note: enabled ? "已开启；过期天数由 redlines.thresholds.recallMaxAgeDays 决定（默认 30）" : "已关闭：同类任务会从零重新探索",
    });
  }

  // 3) 成本硬顶
  {
    const limit = typeof cli.maxCost === "number" ? cli.maxCost : (typeof pick(cfg, "max_cost_usd") === "number" ? (pick(cfg, "max_cost_usd") as number) : null);
    out.push({
      capability: "cost_cap",
      effective: limit === null ? "off" : `$${limit}`,
      source: typeof cli.maxCost === "number" ? "cli" : limit === null ? "default" : "config",
      keys: ["max_cost_usd", "--max-cost"],
      note: limit === null ? "未设上限：长任务可能无限烧钱" : "超过该值立即中止运行（硬顶，不是警告）",
    });
  }

  // 4) 辅助模型路由
  {
    const routing = resolveAuxRouting(cfg, typeof cfg.model === "string" ? cfg.model : null);
    const parts = [routing.compact ? `压缩→${routing.compact}` : "", routing.delegate ? `子任务→${routing.delegate}` : ""].filter(Boolean);
    out.push({
      capability: "aux_model_routing",
      effective: parts.length ? parts.join("，") : "off",
      source: parts.length ? "config" : "default",
      keys: ["compact_model", "delegate_model"],
      note: parts.length ? "低智力需求的工作走便宜模型" : "未配置：压缩与子任务都用主模型（成本更高）",
    });
  }

  // 4b) 缺口 24：Plan/Act 分模型
  {
    const routing = resolvePlanActRouting(cfg, typeof cfg.model === "string" ? cfg.model : null);
    const parts = [routing.plan ? `规划→${routing.plan}` : "", routing.act ? `执行→${routing.act}` : ""].filter(Boolean);
    out.push({
      capability: "plan_act_model_routing",
      effective: parts.length ? parts.join("，") : "off",
      source: parts.length ? "config" : "default",
      keys: ["plan_model", "act_model"],
      note: parts.length ? "规划用强推理模型、执行换便宜模型" : "未配置：规划与执行共用主模型",
    });
  }

  // 5) 推理档位
  {
    const r = resolveReasoningOptions(cfg);
    const val = [r.effort ? `effort=${r.effort}` : "", r.verbosity ? `verbosity=${r.verbosity}` : ""].filter(Boolean);
    out.push({
      capability: "reasoning_effort",
      effective: val.length ? val.join("，") : "provider 默认",
      source: val.length ? "config" : "default",
      keys: ["reasoning_effort", "verbosity"],
      note: val.length ? "已显式指定档位" : "未配置：不发这两个字段（payload 与默认一致）",
    });
  }

  // 6) 额外可写根
  {
    const cfgDirs = Array.isArray(pick(cfg, "extra_writable_dirs")) ? (pick(cfg, "extra_writable_dirs") as string[]) : [];
    const all = [...cfgDirs, ...(cli.addDirs ?? [])];
    // 做真实校验（含存在性）：不存在的目录写不了，here 说「可写」就是撒谎。
    const resolved = resolveExtraDirs(all);
    out.push({
      capability: "extra_writable_dirs",
      effective: resolved.ok.length ? resolved.ok.join("、") : "none",
      source: (cli.addDirs ?? []).length ? "cli" : cfgDirs.length ? "config" : "default",
      keys: ["extra_writable_dirs", "--add-dir"],
      note: resolved.rejected.length
        ? `有 ${resolved.rejected.length} 条被拒：${resolved.rejected.map((r) => r.input).join("、")}`
        : resolved.ok.length ? "这些目录可写（其余工作目录外仍拒绝）" : "只有工作目录可写",
    });
  }

  // 7) 读侧禁读清单：未配 = 默认清单（.env / 私钥默认拒读，第四份审计 P0）；
  // 只有显式配成 [] 才是放宽。
  {
    const raw = pick(cfg, "deny_read_globs");
    const globs = Array.isArray(raw) ? (raw as string[]) : [...DEFAULT_DENY_READ_GLOBS];
    out.push({
      capability: "deny_read_globs",
      effective: globs.length ? `${globs.length} 条规则` : "off",
      source: Array.isArray(raw) ? "config" : "default",
      keys: ["deny_read_globs"],
      note: globs.length ? `命中即拒读：${globs.slice(0, 3).join("、")}${globs.length > 3 ? "…" : ""}` : "已清空：敏感文件（.env / secrets）可被读取并发给模型",
    });
  }

  // 8) 沙箱
  {
    const mode = typeof cfg.sandbox === "string" ? cfg.sandbox : "auto";
    out.push({
      capability: "sandbox",
      effective: mode,
      source: typeof cfg.sandbox === "string" ? "config" : "default",
      keys: ["sandbox", "sandbox_mode", "--sandbox"],
      note: mode === "local" ? "工具级隔离：命令在宿主机上跑" : "auto：Linux 用 bwrap、macOS 用 seatbelt（需显式 --sandbox seatbelt）",
    });
  }

  // 9) H-7：嵌套编排深度上限（默认 flat，orchestrator 显式开）
  {
    const raw = pick(cfg, "delegate_max_depth");
    // 与 src/agent.ts 的 resolveMaxDelegateDepth 同款口径（整数 1–5 有效，
    // 其余回默认 2）；改一处改两处。
    const valid = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 5;
    const depth = valid ? (raw as number) : 2;
    out.push({
      capability: "nested_delegate",
      effective: `${depth} 层`,
      source: valid ? "config" : "default",
      keys: ["delegate_max_depth"],
      note: "子 agent 默认不能再委派（flat）；委派时传 orchestrator: true 才允许嵌套，最多嵌套这么多层，每层预算独立记账",
    });
  }

  // 10) GROK-6：信任阶梯（新 agent / 新技能默认只读，攒够证据才升级）
  {
    const s = resolveTrustLadderSettings(cfg);
    const raw = (pick(cfg, "trust_ladder") ?? {}) as Record<string, unknown>;
    const configured = raw.required_successes !== undefined || raw.spot_check_rate !== undefined;
    out.push({
      capability: "trust_ladder",
      effective: `${s.requiredSuccesses} 次成功/级，抽查 ${Math.round(s.spotCheckRate * 100)}%`,
      source: configured ? "config" : "default",
      keys: ["trust_ladder.required_successes", "trust_ladder.spot_check_rate"],
      note: "新 agent / 新技能登记后默认只读；每级要攒够连续成功且零违规才升一级，升级须人点头；每次记成功有概率被随机抽查，抽中须复核才计入；降级随时可做",
    });
  }

  // 11) Pi Bot 借鉴第 3 条：卡住步骤看门狗（任务板 working 任务超时无进展
  // 时先标出来、再按轮次上限自动重排、超限进 blocked 只等人）
  {
    const s = resolveReconcilerSettings(cfg);
    const raw = (pick(cfg, "reconciler") ?? {}) as Record<string, unknown>;
    const configured = raw.enabled !== undefined || raw.stuck_after_seconds !== undefined || raw.max_retries !== undefined || raw.scan_interval_seconds !== undefined;
    out.push({
      capability: "reconciler",
      effective: s.enabled ? `开（${s.stuckAfterSeconds} 秒无进展算卡住，最多重排 ${s.maxRetries} 次，每 ${s.scanIntervalSeconds} 秒扫一遍）` : "关（只手动扫描）",
      source: configured ? "config" : "default",
      keys: ["reconciler.enabled", "reconciler.stuck_after_seconds", "reconciler.max_retries", "reconciler.scan_interval_seconds"],
      note: "看门狗只重排任务板任务（回队列等下一轮 tick），不调模型、不写任务板账本以外的文件、不对外发；超限进 blocked 只等人 reset；无人值守续跑照样强制只读",
    });
  }

  // 12) 缺口 32：变化监测例程 Watch / Watch-with-action（页面或文件变了
  // 才汇报，汇报格式固定为“变了什么 → 详情 → 来源”；带动作的须另声明
  // 条件与动作，下载类敏感动作须人批）
  {
    const s = resolveWatchSettings(cfg);
    const raw = (pick(cfg, "watch") ?? {}) as Record<string, unknown>;
    const configured = raw.enabled !== undefined || raw.default_interval_seconds !== undefined;
    out.push({
      capability: "watch",
      effective: s.enabled ? `开（自动巡查，默认每 ${s.defaultIntervalSeconds} 秒检查一次）` : "关（只手动检查）",
      source: configured ? "config" : "default",
      keys: ["watch.enabled", "watch.default_interval_seconds"],
      note: "Watch 本身只读（抓页面、读文件），不调模型、不对外发；enqueue-task 动作入队后执行时照常走审批；download 动作须人显式批准才执行",
    });
  }

  // 并发预算预留：金额未知严格模式（可靠性打磨第 2 项第一批，追加在末尾——
  // 能力列表顺序固定，只加不改，见 test-config-explain.test.ts）
  {
    const strict = resolveStrictUnknownAmount(cfg);
    const configured = pick(cfg, "budget.strict_unknown_amount") !== undefined;
    out.push({
      capability: "budget",
      effective: strict ? "开（金额未知则暂停）" : "关（金额未知继续跑）",
      source: configured ? "config" : "default",
      keys: ["budget.strict_unknown_amount", "nyra budget strict --on/--off"],
      note: strict ? "未配单价或调用缺用量时，运行暂停并建暂停记录等人工处理（恢复走 nyra governance caps resume）" : "关了之后金额未知时继续跑、不假装封顶（旧行为）；请求前预留仍在，超上限照样不发请求",
    });
  }

  // 更新检查：默认关闭的 opt-in（隐私政策承诺不联网回报）。
  {
    const enabled = pick(cfg, "update_check_enabled") === true;
    out.push({
      capability: "update_check",
      effective: enabled ? "开（`nyra update-check` 会联网查新版本）" : "关（不联网）",
      source: pick(cfg, "update_check_enabled") !== undefined ? "config" : "default",
      keys: ["update_check_enabled", "nyra update-check"],
      note: enabled ? "只查 GitHub Releases latest，不发任何本地数据" : "默认关闭：不联网、不检查；开后才由 `nyra update-check` 联网查一次",
    });
  }

  // M2：Jev 式快速决策路由——群聊没 @ 谁时，便宜模型先判该谁接。
  // 默认关闭的 opt-in；判不出来回落全员回答，不静默丢消息。
  {
    const enabled = pick(cfg, "jev_router_enabled") === true;
    const model = typeof pick(cfg, "jev_model") === "string" && (pick(cfg, "jev_model") as string).trim()
      ? (pick(cfg, "jev_model") as string).trim()
      : "deepseek-flash";
    const threshold = typeof pick(cfg, "jev_confidence_threshold") === "number"
      ? (pick(cfg, "jev_confidence_threshold") as number)
      : 0.6;
    out.push({
      capability: "jev_router",
      effective: enabled ? `开（路由模型 ${model}，置信度低于 ${threshold} 回落全员回答）` : "关（没 @ 谁时全员回答）",
      source: pick(cfg, "jev_router_enabled") !== undefined ? "config" : "default",
      keys: ["jev_router_enabled", "jev_model", "jev_confidence_threshold", "nyra group route"],
      note: enabled ? "路由只决定谁回答，不决定能不能做；选中的 Bot 照样走审批、预算、证据链" : "默认关闭：群消息没 @ 谁时所有机器人都回答；干跑看分流结果用 nyra group route",
    });
  }

  return out;
}

/** 查单个能力；找不到返回 null（由 CLI 决定怎么提示）。 */
export function explainOne(input: ExplainInput, capability: string): CapabilityExplain | null {
  const key = (capability ?? "").trim().toLowerCase();
  if (!key) return null;
  return explainAll(input).find((c) => c.capability === key) ?? null;
}

/** 人类可读输出。 */
export function formatExplain(items: readonly CapabilityExplain[]): string {
  const lines: string[] = [];
  for (const c of items) {
    lines.push(`${c.capability}: ${c.effective}（来源：${c.source}）`);
    lines.push(`    可改的键：${c.keys.join("、")}`);
    lines.push(`    ${c.note}`);
  }
  return lines.join("\n");
}
