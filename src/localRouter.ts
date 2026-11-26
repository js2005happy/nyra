// src/localRouter.ts — 本地小神经网络意图路由（零 token，不调模型）。
//
// 只做一件事：收到一条消息，先在本地判它属于哪类意图
// （code / research / write / ops / chat / spam），再按标签
// 找房间里对应的 Bot。判不出来、置信度不够、权重坏了，
// 一律回落到原有路由（便宜模型 Jev 或全员回答），不静默猜。
//
// 结构：三层 MLP（输入=词袋二值向量，隐藏层 tanh，输出 softmax），
// 纯 TypeScript 手写，不引新依赖。训练只在开发时跑
// （scripts/train-local-router.ts），权重以 JSON 随仓放在
// src/assets/local-router-weights.json.txt，运行时只读。
//
// 硬边界：分类器只做路由建议，绝不进核心决策——审批、预算、
// 证据链一律不动；不调模型、不花 token、不联网。
import { loadConfig } from "./config.ts";
import { LOCAL_ROUTER_LABELS, LABEL_KEYWORDS, type LocalRouterLabel } from "./localRouterData.ts";
import type { JevDecider, JevMember } from "./jevRouter.ts";
import BUNDLED_WEIGHTS_JSON from "./assets/local-router-weights.json.txt" with { type: "text" };

/** 权重文件版本：训练脚本与运行时都认这一个数。 */
export const LOCAL_ROUTER_WEIGHTS_VERSION = 1;
/** 默认置信度阈值：与 Jev 路由同数，低于它回落。 */
export const LOCAL_ROUTER_DEFAULT_THRESHOLD = 0.6;
/** 词表上限：训练数据很小，词表全留（频次排序只在数据长大后才截断）。 */
export const LOCAL_ROUTER_MAX_VOCAB = 768;

export class LocalRouterWeightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRouterWeightsError";
  }
}

export interface LocalRouterWeights {
  version: number;
  labels: string[];
  vocab: string[];
  hidden: number;
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
}

export interface LocalRouterConfig {
  enabled: boolean;
  threshold: number;
}

export interface LocalRouterResult {
  label: LocalRouterLabel;
  confidence: number;
  /** 每个标签的 softmax 概率，与 LABELS 顺序一一对应。 */
  scores: number[];
}

/**
 * 分词：ASCII 词（小写、≥2 字符）+ 每个汉字 + 相邻汉字二元组。
 * 中文消息主要靠汉字与二元组（“代码”“部署”“中奖”这类词），
 * 英文消息靠 ASCII 词；不做分词器、不引依赖。
 */
export function tokenizeLocalRouter(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.match(/[a-z0-9]+/g) ?? []) {
    if (m.length >= 2) tokens.push(m);
  }
  const cjk = /[\u4e00-\u9fff]/;
  const runs: string[] = [];
  let run = "";
  for (const ch of text) {
    if (cjk.test(ch)) {
      run += ch;
    } else if (run) {
      runs.push(run);
      run = "";
    }
  }
  if (run) runs.push(run);
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) tokens.push(r[i]!);
    for (let i = 0; i + 1 < r.length; i++) tokens.push(r.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 建词表：按每条训练例子里的出现次数（一条例子里同一词只计一次）
 * 取最常见的 MAX_VOCAB 个；并列时按词排序，保证确定性。
 * 只用训练集建词表，留出集不参与。
 */
export function buildLocalRouterVocabulary(
  examples: { text: string }[],
  cap: number = LOCAL_ROUTER_MAX_VOCAB,
): string[] {
  const counts = new Map<string, number>();
  for (const ex of examples) {
    for (const tok of new Set(tokenizeLocalRouter(ex.text))) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, cap)
    .map(([tok]) => tok);
}

/** 文本→二值词袋向量（词在词表里出现为 1，否则 0）。 */
const VOCAB_INDEX_CACHE = new WeakMap<string[], Map<string, number>>();
function vocabIndex(vocab: string[]): Map<string, number> {
  let index = VOCAB_INDEX_CACHE.get(vocab);
  if (!index) {
    index = new Map(vocab.map((tok, i) => [tok, i]));
    VOCAB_INDEX_CACHE.set(vocab, index);
  }
  return index;
}

export function featurizeLocalRouter(text: string, vocab: string[]): number[] {
  const index = vocabIndex(vocab);
  const x = new Array<number>(vocab.length).fill(0);
  for (const tok of new Set(tokenizeLocalRouter(text))) {
    const i = index.get(tok);
    if (i !== undefined) x[i] = 1;
  }
  return x;
}

function isFiniteNumberArray(a: unknown, len?: number): a is number[] {
  return Array.isArray(a) && (len === undefined || a.length === len) && a.every((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * 解析并校验权重 JSON：形状不对一律抛错（fail-closed：调用方
 * 只能回落，不许拿半截权重硬算）。
 */
export function parseLocalRouterWeights(json: string): LocalRouterWeights {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new LocalRouterWeightsError("本地路由权重不是合法 JSON");
  }
  if (!raw || typeof raw !== "object") throw new LocalRouterWeightsError("本地路由权重形状不对");
  const w = raw as Record<string, unknown>;
  if (w.version !== LOCAL_ROUTER_WEIGHTS_VERSION) {
    throw new LocalRouterWeightsError(`本地路由权重版本不对（要 ${LOCAL_ROUTER_WEIGHTS_VERSION}，拿到 ${String(w.version)}）`);
  }
  const labels = w.labels;
  if (!Array.isArray(labels) || labels.length !== LOCAL_ROUTER_LABELS.length || !labels.every((l, i) => l === LOCAL_ROUTER_LABELS[i])) {
    throw new LocalRouterWeightsError("本地路由权重标签与代码不一致");
  }
  const vocab = w.vocab;
  if (!Array.isArray(vocab) || vocab.length === 0 || vocab.length > LOCAL_ROUTER_MAX_VOCAB || !vocab.every((t) => typeof t === "string" && t.length > 0)) {
    throw new LocalRouterWeightsError("本地路由权重词表不对");
  }
  const hidden = w.hidden;
  if (typeof hidden !== "number" || !Number.isInteger(hidden) || hidden < 1) {
    throw new LocalRouterWeightsError("本地路由权重隐藏层不对");
  }
  const W1 = w.W1;
  const b1 = w.b1;
  const W2 = w.W2;
  const b2 = w.b2;
  if (!Array.isArray(W1) || W1.length !== hidden || !W1.every((row) => isFiniteNumberArray(row, vocab.length))) {
    throw new LocalRouterWeightsError("本地路由权重 W1 形状不对");
  }
  if (!isFiniteNumberArray(b1, hidden)) throw new LocalRouterWeightsError("本地路由权重 b1 形状不对");
  if (!Array.isArray(W2) || W2.length !== labels.length || !W2.every((row) => isFiniteNumberArray(row, hidden))) {
    throw new LocalRouterWeightsError("本地路由权重 W2 形状不对");
  }
  if (!isFiniteNumberArray(b2, labels.length)) throw new LocalRouterWeightsError("本地路由权重 b2 形状不对");
  return { version: 1, labels: [...labels], vocab: [...vocab], hidden, W1: W1 as number[][], b1: b1 as number[], W2: W2 as number[][], b2: b2 as number[] };
}

/** 读随仓权重（测试可传 weightsJson 覆盖，不碰文件）。 */
let bundledCache: LocalRouterWeights | null = null;
export function loadLocalRouterWeights(weightsJson?: string): LocalRouterWeights {
  if (weightsJson !== undefined) return parseLocalRouterWeights(weightsJson);
  // 随仓权重不变：解析 + 校验一次，之后每条消息直接复用（解析失败不缓存，下次照样抛错）
  if (!bundledCache) bundledCache = parseLocalRouterWeights(BUNDLED_WEIGHTS_JSON);
  return bundledCache;
}

/** 前向：tanh 隐藏层 + softmax 输出。纯函数，训练脚本也复用它。 */
export function forwardLocalRouter(weights: LocalRouterWeights, x: number[]): number[] {
  const h: number[] = [];
  for (let j = 0; j < weights.hidden; j++) {
    let s = weights.b1[j]!;
    const row = weights.W1[j]!;
    for (let i = 0; i < x.length; i++) if (x[i]) s += row[i]! * x[i]!;
    h.push(Math.tanh(s));
  }
  const logits: number[] = [];
  for (let k = 0; k < weights.labels.length; k++) {
    let s = weights.b2[k]!;
    const row = weights.W2[k]!;
    for (let j = 0; j < weights.hidden; j++) s += row[j]! * h[j]!;
    logits.push(s);
  }
  const m = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

/** 分类：返回得票最高的标签与置信度（softmax 最大值）。 */
export function classifyLocal(text: string, weights: LocalRouterWeights): LocalRouterResult {
  const scores = forwardLocalRouter(weights, featurizeLocalRouter(text, weights.vocab));
  let best = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k]! > scores[best]!) best = k;
  return { label: LOCAL_ROUTER_LABELS[best]!, confidence: scores[best]!, scores };
}

/** 读路由配置：只认 config.json 里 local_router 一节，其他一律取默认。 */
export function localRouterConfig(home: string): LocalRouterConfig {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = loadConfig(home) as Record<string, unknown>;
  } catch {
    cfg = {};
  }
  const raw = cfg.local_router;
  if (!raw || typeof raw !== "object") return { enabled: false, threshold: LOCAL_ROUTER_DEFAULT_THRESHOLD };
  const d = raw as Record<string, unknown>;
  const thresholdRaw = d.threshold;
  const threshold = typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 1
    ? thresholdRaw
    : LOCAL_ROUTER_DEFAULT_THRESHOLD;
  return { enabled: d.enabled === true, threshold };
}

/**
 * 标签→成员：按成员 role/name/instructions 里命中几个映射词打分，
 * 挑最高的；平局取房间里排在前面的；一个没命中返回 null。
 * spam 没有映射词，永远返回 null（垃圾消息不派给任何 Bot）。
 */
export function matchLabelToMember(label: LocalRouterLabel, members: JevMember[]): string | null {
  const keywords = LABEL_KEYWORDS[label];
  if (keywords.length === 0 || members.length === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const m of members) {
    const hay = `${m.name} ${m.role} ${m.instructions ?? ""}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (hay.includes(kw.toLowerCase())) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = m.id;
    }
  }
  return best;
}

export interface LocalRouterDecisionFields {
  label: string;
  confidence: number;
  fallback: boolean;
  reason: string;
}

/**
 * 本地 decider：给 Jev 路由链用的第一棒。
 * - 权重坏了 → 返回 null（不路由，等链上下一棒）；
 * - 判为 spam → 返回 null（不派给任何 Bot）；
 * - 置信度低于阈值 → 返回 null（等链上下一棒）；
 * - 标签对不上房间里的成员 → 返回 null；
 * 其余返回 {member, confidence}。每次本地分类都经 onDecision
 * 回调报一笔（调用方决定记不记运行事件；不传就不记）。
 */
export function createLocalRouterDecider(
  home: string,
  opts: { threshold?: number; onDecision?: (fields: LocalRouterDecisionFields) => void; weightsJson?: string } = {},
): JevDecider {
  const cfg = localRouterConfig(home);
  const threshold = opts.threshold ?? cfg.threshold;
  return async (message, members) => {
    let weights: LocalRouterWeights;
    try {
      weights = loadLocalRouterWeights(opts.weightsJson);
    } catch {
      return null;
    }
    const result = classifyLocal(message, weights);
    const conf2 = Math.round(result.confidence * 100) / 100;
    let member: string | null = null;
    let reason: string;
    if (result.label === "spam") {
      reason = `本地小路由判为垃圾消息（置信度 ${conf2}），不派给任何 Bot，回落`;
    } else if (result.confidence < threshold) {
      reason = `本地小路由置信度 ${conf2} 低于阈值 ${threshold}，回落`;
    } else {
      member = matchLabelToMember(result.label, members);
      reason = member
        ? "本地小路由（零 token）"
        : `本地小路由判为 ${result.label}，但房间里没有对应的 Bot，回落`;
    }
    opts.onDecision?.({ label: result.label, confidence: result.confidence, fallback: member === null, reason });
    return member ? { member, confidence: result.confidence } : null;
  };
}
