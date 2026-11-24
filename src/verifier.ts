// src/verifier.ts — 缺口 13：验收者（verifier）——并行产出合入前的验收门。
//
// MiniMax Agent Team 的 verifier 独立验收后才交付、Devin 的协调者汇总前解冲突、
// Gas Town 的产出先进队列跑检查再合——Nyra 把三家的“验收”合成一道门：
//   1. 确定性检查（不调模型、零成本）：改动存在、diff 完整、证据齐全；
//   2. 模型复核（便宜模型、独立上下文、只读）：读摘要与 diff，判通过/打回；
//   3. 结论进证据链（谁验的、验了什么、为什么通过/打回、过了几项检查）。
//
// 与缺口 10 的 reviewer 是两道不同的门，不要混用：
//   - reviewer 审“一次敏感工具调用能不能执行”（执行前，ALLOW/BLOCK）；
//   - verifier 验收“一批并行产出能不能合入主线”（交付前，verified/failed）。
//   复用的是 reviewer 的运行件（ReviewerLike、parseReviewerOutput、
//   reviewWithReviewer、便宜模型解析链），不是它的结论：
//   reviewer 的 BLOCK 只拦一次调用，verifier 的 failed 是把产出打回重做。
//   模型腿不可用/无有效结论时结论是 not-verified（不是 failed 也不是
//   verified）——fail-closed：没验收通过的产出不得合并，由人逐项批。
//
// 默认关闭（显式 opt-in）；打回重做（rework）默认关闭，开了也最多重做 1 次，
// 重做同样受委派预算与成本硬顶约束，队列/定时任务里不自动换模型、不自动放行审批。
// 验收模型的调用不进用量账本（与 reviewer 同款：直接调 runner.chat，见诚实边界）。
//
// 本模块不 import tools.ts / runs.ts / reviewQueue.ts（运行时），只用
// reviewQueue 的 VerificationStatus 类型（type-only，编译期抹掉，无循环）。
// 事件字段见 runs.ts 的 verifier_verdict / verifier_rework。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveHome, resolveProvider, saveConfig } from "./config.ts";
import { Provider } from "./providers.ts";
import {
  resolveReviewerModel,
  reviewWithReviewer,
  type ReviewerLike,
} from "./reviewer.ts";
import type { VerificationStatus } from "./reviewQueue.ts";

export class VerifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierError";
  }
}

export interface VerifierConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  /** 打回重做：验收未通过时自动重做 1 次（默认关）。 */
  rework: boolean;
  /** 用户用自然语言写的额外验收规则（复核提示里原样交给验收模型）。 */
  rules: string[];
}

export type VerifierSource = "deterministic" | "model" | "skipped" | "unavailable";

export interface VerifierCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

/** 验收检查清单（公开，群聊验收者机器人与文档共用同一份）。 */
export const VERIFIER_CHECKLIST: { id: string; label: string; what: string }[] = [
  { id: "has-changes", label: "有可验收的改动", what: "改动文件非空，或 diff 摘要非空" },
  { id: "files-exist", label: "改动文件都存在", what: "每个改动文件在 worktree/工作目录里存在" },
  { id: "diff-stat", label: "diff 摘要完整", what: "有改动文件时 diff 摘要非空" },
  { id: "evidence-complete", label: "证据齐全", what: "摘要非空，且改动位置（worktree 或工作目录）有记录" },
  { id: "draft-labeled", label: "草稿标未完成", what: "标题/摘要含草稿标记时不得声称已完成" },
  { id: "ui-before-shot", label: "UI 改动附 before 证据", what: "改了界面文件时摘要须提 before/对比/截图" },
];

/** 一次验收的输入：并行线程证据 / 审阅项 / 单次 delegate 结果都能拼出来。 */
export interface VerifierInput {
  title: string;
  summary: string;
  changedFiles: string[];
  diffStat: string | null;
  worktreePath: string | null;
  workdir: string | null;
  spentUsd: number | null;
}

export interface VerifierVerdict {
  status: VerificationStatus;
  /** 验收方法：verifier（确定性 + 模型复核）/ verifier-deterministic（只跑了确定性检查）；未验收时为 null。 */
  method: string | null;
  source: VerifierSource;
  reason: string;
  verifierModel: string | null;
  checks: VerifierCheck[];
  at: string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 读 config.json 里的 verifier 一节（缺文件时默认关闭）。 */
export function verifierConfig(config: Record<string, unknown>): VerifierConfig {
  const raw = (config.verifier ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
    rework: raw.rework === true,
    rules: Array.isArray(raw.rules)
      ? raw.rules.filter((r): r is string => typeof r === "string").map((r) => r.trim()).filter(Boolean)
      : [],
  };
}

export function verifierEnabled(config: Record<string, unknown>): boolean {
  return verifierConfig(config).enabled;
}

/**
 * 验收模型解析：verifier.provider/model > smart_approvals.reviewer_*
 * （与 reviewer 共用便宜模型链，不用再配一遍）> 默认 deepseek / deepseek-flash。
 * 只解析名字，不建 provider、不碰凭证。
 */
export function resolveVerifierModel(config: Record<string, unknown>): { provider: string; model: string } {
  const cfg = verifierConfig(config);
  if (cfg.provider || cfg.model) {
    const fallback = resolveReviewerModel(config);
    return { provider: cfg.provider ?? fallback.provider, model: cfg.model ?? fallback.model };
  }
  return resolveReviewerModel(config);
}

/** CLI / 网关透传给 Agent 的验收模型名（"provider:model" 一串）。 */
export function formatVerifierModel(config: Record<string, unknown>): string {
  const { provider, model } = resolveVerifierModel(config);
  return `${provider}:${model}`;
}

/** 建验收模型运行实例（无凭证/建不出来返回 null，调用方 fail-closed）。 */
export function buildVerifierRunner(config: Record<string, unknown>, home?: string): ReviewerLike | null {
  const { provider, model } = resolveVerifierModel(config);
  try {
    const resolved = resolveProvider({ home: home ?? resolveHome(), config, providerName: provider, model });
    const p = new Provider(resolved);
    if (!p.hasCredentials()) return null;
    return p as unknown as ReviewerLike;
  } catch {
    return null;
  }
}

/** CLI `verifier status` 用的状态快照（不含任何凭证）。 */
export function verifierStatus(config: Record<string, unknown>, home?: string): {
  enabled: boolean;
  provider: string;
  model: string;
  rework: boolean;
  rules: string[];
  hasCredentials: boolean;
} {
  const { provider, model } = resolveVerifierModel(config);
  return {
    enabled: verifierEnabled(config),
    provider,
    model,
    rework: verifierConfig(config).rework,
    rules: verifierConfig(config).rules,
    hasCredentials: buildVerifierRunner(config, home) !== null,
  };
}

/** 读 config.json 里的 verifier 一节（缺文件时默认关闭）。 */
export function loadVerifierConfig(home?: string): VerifierConfig {
  return verifierConfig(loadConfig(home));
}

/** 草稿标记（标题/摘要里出现即视为草稿；拉丁词小写比对）。 */
const DRAFT_MARKERS = ["草稿", "草案", "初稿", "待完善", "wip", "draft"];
/** 完成声称（摘要里出现即视为声称已完成；不含裸的“通过”，免得“12 通过”误判）。 */
const COMPLETION_MARKERS = ["已完成", "全部完成", "已搞定", "已交付", "ready", "验收通过", "测试通过", "测试全部通过"];
/** before 证据提法（摘要里出现即视为提了 before/对比/截图）。 */
const BEFORE_MARKERS = ["before", "对比", "截图", "前后对比"];

/** 界面文件：扩展名或路径判定（裸 .html 不算——文档页不是产品界面）。 */
const UI_EXTS = new Set([".tsx", ".jsx", ".vue", ".svelte", ".css"]);

function containsMarker(text: string, markers: string[]): string | null {
  const lower = text.toLowerCase();
  for (const m of markers) {
    if (lower.includes(m.toLowerCase())) return m;
  }
  return null;
}

function isUiFile(f: string): boolean {
  const p = f.replace(/\\/g, "/");
  if (p.startsWith("desktop/ui/")) return true;
  const dot = p.lastIndexOf(".");
  const ext = dot >= 0 ? p.slice(dot) : "";
  return UI_EXTS.has(ext);
}

/**
 * 确定性检查（不调模型、零成本、纯函数；文件存在性用 existsSync 当场核对）。
 * 注意：spentUsd 为 null（未计价）不是失败——不编花费数字，只在 detail 里注明。
 * DSH-5b 的两条诚实交付检查是启发式文本判定：只核对标题/摘要里的说法，
 * 不验截图像素真假（像素真假靠模型复核与人）；误判时用 add-rule 覆盖或人工批。
 */
export function runDeterministicChecks(input: VerifierInput): VerifierCheck[] {
  const changed = input.changedFiles.filter((f) => typeof f === "string" && f.trim());
  const diff = typeof input.diffStat === "string" ? input.diffStat.trim() : "";
  const base = input.worktreePath ?? input.workdir;
  const checks: VerifierCheck[] = [];
  checks.push({
    id: "has-changes",
    label: "有可验收的改动",
    passed: changed.length > 0 || diff.length > 0,
    detail: changed.length > 0
      ? `改动文件 ${changed.length} 个${diff ? "，diff 摘要非空" : "，但 diff 摘要为空"}`
      : diff ? "无改动文件，但 diff 摘要非空" : "无改动文件、diff 摘要为空：无可验收的内容",
  });
  if (changed.length === 0) {
    checks.push({ id: "files-exist", label: "改动文件都存在", passed: true, detail: "无改动文件可核对" });
  } else if (!base) {
    checks.push({
      id: "files-exist",
      label: "改动文件都存在",
      passed: false,
      detail: "既无 worktree 也无工作目录，改动文件无处核对",
    });
  } else {
    const missing = changed.filter((f) => !existsSync(join(base, f)));
    checks.push({
      id: "files-exist",
      label: "改动文件都存在",
      passed: missing.length === 0,
      detail: missing.length === 0
        ? `${changed.length} 个改动文件都在 ${base} 里`
        : `缺文件：${missing.join("、")}`,
    });
  }
  checks.push({
    id: "diff-stat",
    label: "diff 摘要完整",
    passed: changed.length === 0 || diff.length > 0,
    detail: changed.length === 0 ? "无改动文件" : diff ? "diff 摘要非空" : "有改动文件但 diff 摘要为空",
  });
  const summaryOk = typeof input.summary === "string" && input.summary.trim().length > 0;
  const locationOk = Boolean(input.worktreePath || input.workdir);
  const costNote = input.spentUsd === null ? "；花费未计价" : `；已花 $${input.spentUsd.toFixed(4)}`;
  checks.push({
    id: "evidence-complete",
    label: "证据齐全",
    passed: summaryOk && locationOk,
    detail: [
      summaryOk ? "摘要非空" : "摘要为空",
      locationOk ? "改动位置有记录" : "改动位置无记录（既无 worktree 也无工作目录）",
    ].join("；") + costNote,
  });
  // DSH-5b：草稿必须标未完成——标题/摘要含草稿标记却声称已完成时不通过。
  const draftHit = containsMarker(`${input.title}\n${input.summary}`, DRAFT_MARKERS);
  const doneHit = containsMarker(input.summary, COMPLETION_MARKERS);
  checks.push({
    id: "draft-labeled",
    label: "草稿标未完成",
    passed: !(draftHit && doneHit),
    detail: draftHit
      ? doneHit
        ? `标题/摘要含草稿标记（${draftHit}），却声称已完成（${doneHit}）：草稿不能按已完成验收`
        : `已标草稿（${draftHit}），未声称已完成`
      : "非草稿",
  });
  // DSH-5b：UI 改动无真实 before 截图不算 ready——摘要须提 before/对比/截图。
  const uiFiles = changed.filter(isUiFile);
  const beforeHit = containsMarker(input.summary, BEFORE_MARKERS);
  checks.push({
    id: "ui-before-shot",
    label: "UI 改动附 before 证据",
    passed: uiFiles.length === 0 || beforeHit !== null,
    detail: uiFiles.length === 0
      ? "无界面改动"
      : beforeHit
        ? `改了 ${uiFiles.length} 个界面文件，摘要已提 before/对比/截图（${beforeHit}）`
        : `改了 ${uiFiles.length} 个界面文件（${uiFiles.slice(0, 5).join("、")}${uiFiles.length > 5 ? "…" : ""}），摘要里没提 before/对比/截图：没图不算 ready`,
  });
  return checks;
}

export const VERIFIER_SYSTEM_PROMPT =
  "你是一个独立的验收者，只验收一次并行产出能不能合入主线。\n" +
  "你只看到任务标题、子任务摘要、改动文件与 diff 摘要、以及确定性检查的结果；" +
  "你看不到完整对话、看不到工作目录以外的文件。你是只读的：不改代码、不跑命令。\n" +
  "通过的标准：改动与任务标题相符；摘要里声称的验证（跑了什么命令、结果如何）具体可核查，" +
  "而不是一句“已验证/测试通过”；没有凭空编造的数字与结论。\n" +
  "草稿须标未完成：标题或摘要写着草稿却声称已完成时打回；界面改动须附真实 before 截图证据：" +
  "摘要里没提 before、对比或截图时打回。\n" +
  "摘要里声称跑了测试却没给命令与结果、改动与任务明显不符、结论含编造痕迹时，打回。\n" +
  "拿不准时打回，不要放行——放行错了会把坏改动合进主线。\n" +
  "只输出一个 JSON 对象：{\"decision\": \"approve\" 或 \"deny\", \"reason\": \"一句话原因\"}，" +
  "不要输出其他内容。";

/** 验收复核的消息（与 reviewer 的 buildReviewMessages 同款形状）。 */
export function buildVerifierMessages(input: VerifierInput, checks: VerifierCheck[], rules: string[]): Record<string, unknown>[] {
  const lines: string[] = [
    `任务：${trunc(input.title, 200)}`,
    `摘要：\n${trunc(input.summary, 2000)}`,
    `改动文件（${input.changedFiles.length}）：${input.changedFiles.slice(0, 50).join("、") || "无"}`,
    `diff 摘要：\n${trunc(input.diffStat ?? "", 4000) || "无"}`,
    `确定性检查：${checks.map((c) => `${c.label}${c.passed ? "通过" : "未通过"}（${c.detail}）`).join("；")}`,
  ];
  if (rules.length) lines.push(`额外验收规则：\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`);
  return [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n\n") },
  ];
}

/**
 * 验收主入口。
 * 未开启 → not-verified（skipped，不调模型、不记通过）；
 * 确定性检查未通过 → failed（deterministic，不调模型）；
 * 确定性通过 + 有验收模型 → 模型复核定结论；
 * 确定性通过 + 无验收模型 → verified（verifier-deterministic，note 写清没验什么）；
 * 模型不可用 / 无有效结论 → not-verified（unavailable，fail-closed：不得合并）。
 */
export async function verifyOutput(opts: {
  config: Record<string, unknown>;
  input: VerifierInput;
  runner?: ReviewerLike | null;
}): Promise<VerifierVerdict> {
  const cfg = verifierConfig(opts.config);
  const at = nowIso();
  const { provider, model } = resolveVerifierModel(opts.config);
  const modelName = `${provider}:${model}`;
  if (!cfg.enabled) {
    return {
      status: "not-verified",
      method: null,
      source: "skipped",
      reason: "验收者未开启（verifier.enabled=false）：未验收，不要把产出当成已验收的结论",
      verifierModel: null,
      checks: [],
      at,
    };
  }
  const checks = runDeterministicChecks(opts.input);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    // 无改动可验不是“失败”：与 3b 审阅队列的 skip 语义一致（成功但无文件改动，
    // 无可审内容），记 not-verified 跳过，不打回重做（重做也无意义）。
    if (failed.length === 1 && failed[0].id === "has-changes") {
      return {
        status: "not-verified",
        method: null,
        source: "deterministic",
        reason: "成功但无文件改动，无可验收的内容，跳过验收",
        verifierModel: modelName,
        checks,
        at,
      };
    }
    return {
      status: "failed",
      method: "verifier",
      source: "deterministic",
      reason: `确定性检查未通过：${failed.map((c) => `${c.label}——${c.detail}`).join("；")}。`,
      verifierModel: modelName,
      checks,
      at,
    };
  }
  if (!opts.runner) {
    return {
      status: "verified",
      method: "verifier-deterministic",
      source: "deterministic",
      reason: "确定性检查全部通过（改动存在、diff 完整、证据齐全）。未跑测试、未审代码语义——通过它不等于代码是对的。",
      verifierModel: modelName,
      checks,
      at,
    };
  }
  const reviewed = await reviewWithReviewer(opts.runner, buildVerifierMessages(opts.input, checks, cfg.rules), { timeout: 60 });
  if (!reviewed) {
    return {
      status: "not-verified",
      method: null,
      source: "unavailable",
      reason: "验收模型无有效结论（出错、超时或输出解析不出决策），fail-closed：未验收，不得合并",
      verifierModel: modelName,
      checks,
      at,
    };
  }
  if (reviewed.decision === "ALLOW") {
    return {
      status: "verified",
      method: "verifier",
      source: "model",
      reason: reviewed.reason || "验收模型复核通过",
      verifierModel: modelName,
      checks,
      at,
    };
  }
  return {
    status: "failed",
    method: "verifier",
    source: "model",
    reason: reviewed.reason || "验收模型打回（未说明原因）",
    verifierModel: modelName,
    checks,
    at,
  };
}

/** 给人看的验收结论（CLI / 摘要 / review queue 的 note 共用口径）。 */
export function formatVerifierVerdict(v: VerifierVerdict): string {
  const verdict = v.status === "verified" ? "通过" : v.status === "failed" ? "未通过" : "未验收";
  const passed = v.checks.filter((c) => c.passed).length;
  const lines = [
    `验收：${verdict}${v.method ? `（${v.method}）` : ""}——${v.reason}`,
    v.checks.length ? `检查 ${passed}/${v.checks.length} 通过：${v.checks.map((c) => `${c.label}${c.passed ? "✓" : "✗"}`).join("、")}` : "",
    v.verifierModel ? `验收模型：${v.verifierModel}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

// ---- 子命令：verifier（缺口 13：验收者） ----
// 与 handleReviewer 同款形状（status/enable/disable/set-model/add-rule/
// remove-rule/list-rules/check + rework-on/rework-off）；check 是试运行：
// 即使验收者未开启也按开启后的口径验一次（生产上未开启时不验收）。

export async function handleVerifier(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra verifier <status|enable|disable|set-model|rework-on|rework-off|add-rule|remove-rule|list-rules|check> [选项]\n");
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const config = loadConfig(resolvedHome);
    if (action === "status") {
      const st = verifierStatus(config, resolvedHome);
      process.stdout.write(`验收者：${st.enabled ? "启用" : "禁用（默认关闭）"}\n`);
      process.stdout.write(`验收模型：${st.provider}:${st.model}${st.hasCredentials ? "" : "（无凭证：开启后模型复核不可用，只跑确定性检查）"}\n`);
      process.stdout.write(`打回重做：${st.rework ? "开启（验收未通过自动重做 1 次）" : "关闭（默认）"}\n`);
      process.stdout.write(`额外规则（${st.rules.length}）：${st.rules.length ? st.rules.map((r, i) => `${i + 1}. ${r}`).join("；") : "（无）"}\n`);
      process.stdout.write("检查清单：改动存在、文件存在、diff 完整、证据齐全（详见 docs/verifier.md）\n");
      return 0;
    }
    if (action === "enable" || action === "disable") {
      const cfg = verifierConfig(config);
      saveConfig(resolvedHome, { verifier: { ...cfg, enabled: action === "enable" } });
      process.stdout.write(`已${action === "enable" ? "启用" : "禁用"}验收者${action === "enable" ? "（并行产出合入前先过验收门，验收失败打回重做需另开 rework）" : ""}\n`);
      return 0;
    }
    if (action === "rework-on" || action === "rework-off") {
      const cfg = verifierConfig(config);
      saveConfig(resolvedHome, { verifier: { ...cfg, rework: action === "rework-on" } });
      process.stdout.write(`打回重做已${action === "rework-on" ? "开启（验收未通过自动重做 1 次，受委派预算与成本硬顶约束）" : "关闭"}\n`);
      return 0;
    }
    if (action === "set-model") {
      const spec = argv[1];
      if (!spec) { process.stderr.write("错误：用法：nyra verifier set-model <provider:模型> 或 <模型>\n"); return 2; }
      const cfg = verifierConfig(config);
      let provider = cfg.provider;
      let model: string | null = cfg.model;
      const idx = spec.indexOf(":");
      if (idx >= 0) {
        provider = spec.slice(0, idx).trim() || null;
        model = spec.slice(idx + 1).trim() || null;
      } else {
        model = spec.trim();
      }
      if (!model) { process.stderr.write("错误：set-model 需要模型名\n"); return 2; }
      saveConfig(resolvedHome, { verifier: { ...cfg, provider, model } });
      const resolved = resolveVerifierModel(loadConfig(resolvedHome));
      process.stdout.write(`验收模型已设为 ${resolved.provider}:${resolved.model}\n`);
      return 0;
    }
    if (action === "add-rule") {
      const rule = argv.slice(1).join(" ").trim();
      if (!rule) { process.stderr.write("错误：用法：nyra verifier add-rule <自然语言规则>\n"); return 2; }
      const cfg = verifierConfig(config);
      saveConfig(resolvedHome, { verifier: { ...cfg, rules: [...cfg.rules, rule] } });
      process.stdout.write(`已添加验收规则（共 ${cfg.rules.length + 1} 条）：${rule}\n`);
      return 0;
    }
    if (action === "remove-rule") {
      const n = parseInt(argv[1] ?? "", 10);
      const cfg = verifierConfig(config);
      if (!Number.isInteger(n) || n < 1 || n > cfg.rules.length) {
        process.stderr.write(`错误：remove-rule 需要 1–${cfg.rules.length} 之间的序号（先 nyra verifier list-rules 查看）\n`);
        return 2;
      }
      const removed = cfg.rules[n - 1];
      const rules = cfg.rules.filter((_r, i) => i !== n - 1);
      saveConfig(resolvedHome, { verifier: { ...cfg, rules } });
      process.stdout.write(`已删除验收规则 ${n}：${removed}\n`);
      return 0;
    }
    if (action === "list-rules") {
      const cfg = verifierConfig(config);
      if (!cfg.rules.length) { process.stdout.write("没有额外验收规则\n"); return 0; }
      cfg.rules.forEach((r, i) => process.stdout.write(`${i + 1}. ${r}\n`));
      return 0;
    }
    if (action === "check") {
      const title = get("--title") ?? "";
      const summary = get("--summary") ?? "";
      const workdir = get("--workdir") ?? null;
      const worktree = get("--worktree") ?? null;
      const files = (get("--files") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
      const diffStat = get("--diff-stat") ?? null;
      if (!title) {
        process.stderr.write("错误：用法：nyra verifier check --title <标题> --summary <摘要> --workdir <目录> --files <逗号分隔的改动文件> [--worktree <路径>] [--diff-stat <文本>]\n");
        return 2;
      }
      const cfg = verifierConfig(config);
      // 试运行：即使验收者未开启也按开启后的口径验一次（生产上未开启时不验收）。
      const verdict = await verifyOutput({
        config: { ...config, verifier: { ...cfg, enabled: true } },
        input: { title, summary, changedFiles: files, diffStat, worktreePath: worktree, workdir, spentUsd: null },
        runner: buildVerifierRunner(config, resolvedHome),
      });
      if (!cfg.enabled) process.stdout.write("（验收者当前未开启，以下是开启后的试运行结果）\n");
      process.stdout.write(`${formatVerifierVerdict(verdict)}\n`);
      return verdict.status === "failed" ? 3 : 0;
    }
    process.stderr.write(`错误：未知子命令 verifier ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
