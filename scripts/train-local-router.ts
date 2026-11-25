// scripts/train-local-router.ts — 本地小路由的训练脚本（只在开发时跑）。
//
//   bun scripts/train-local-router.ts
//
// 读 src/localRouterData.ts 的 TRAIN_EXAMPLES 训练三层 MLP
// （词袋二值向量 → tanh 隐藏层 → softmax），写权重 JSON 到
// src/assets/local-router-weights.json.txt（随仓，运行时只读）。
// HELD_OUT_EXAMPLES 只做验证准确率，绝不进训练；留出准确率
// 低于 0.8 时直接报错退出（权重不写盘，防坏权重进仓）。
//
// 不进运行时：它只被开发者手动跑，src/localRouter.ts 里
// 没有训练代码（前向函数是推理与训练共用的纯函数）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LOCAL_ROUTER_WEIGHTS_VERSION,
  buildLocalRouterVocabulary,
  classifyLocal,
  featurizeLocalRouter,
  type LocalRouterWeights,
} from "../src/localRouter.ts";
import { HELD_OUT_EXAMPLES, LOCAL_ROUTER_LABELS, TRAIN_EXAMPLES } from "../src/localRouterData.ts";

const HIDDEN = 24;
const EPOCHS = 500;
const LR = 0.5;
const MIN_HELD_OUT_ACCURACY = 0.8;

/** 固定种子伪随机：同一份数据训出的权重每次都一样。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function train(): LocalRouterWeights {
  const vocab = buildLocalRouterVocabulary(TRAIN_EXAMPLES);
  const labels = [...LOCAL_ROUTER_LABELS];
  const rand = mulberry32(1234);
  const r1 = 1 / Math.sqrt(vocab.length);
  const r2 = 1 / Math.sqrt(HIDDEN);
  const W1: number[][] = Array.from({ length: HIDDEN }, () =>
    Array.from({ length: vocab.length }, () => (rand() * 2 - 1) * r1));
  const b1: number[] = new Array(HIDDEN).fill(0);
  const W2: number[][] = Array.from({ length: labels.length }, () =>
    Array.from({ length: HIDDEN }, () => (rand() * 2 - 1) * r2));
  const b2: number[] = new Array(labels.length).fill(0);
  const weights: LocalRouterWeights = { version: LOCAL_ROUTER_WEIGHTS_VERSION, labels, vocab, hidden: HIDDEN, W1, b1, W2, b2 };

  const data = TRAIN_EXAMPLES.map((ex) => ({
    x: featurizeLocalRouter(ex.text, vocab),
    y: labels.indexOf(ex.label),
  }));
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const dW1: number[][] = Array.from({ length: HIDDEN }, () => new Array(vocab.length).fill(0));
    const db1: number[] = new Array(HIDDEN).fill(0);
    const dW2: number[][] = Array.from({ length: labels.length }, () => new Array(HIDDEN).fill(0));
    const db2: number[] = new Array(labels.length).fill(0);
    for (const { x, y } of data) {
      // 前向（与 localRouter.ts 的 forwardLocalRouter 同式，这里要留中间量做反向）。
      const z1: number[] = [];
      for (let j = 0; j < HIDDEN; j++) {
        let s = b1[j]!;
        for (let i = 0; i < x.length; i++) if (x[i]) s += W1[j]![i]! * x[i]!;
        z1.push(s);
      }
      const h = z1.map((v) => Math.tanh(v));
      const logits: number[] = [];
      for (let k = 0; k < labels.length; k++) {
        let s = b2[k]!;
        for (let j = 0; j < HIDDEN; j++) s += W2[k]![j]! * h[j]!;
        logits.push(s);
      }
      const m = Math.max(...logits);
      const exps = logits.map((v) => Math.exp(v - m));
      const sum = exps.reduce((a, b) => a + b, 0);
      const p = exps.map((v) => v / sum);
      // 反向：softmax + 交叉熵。
      const dz2 = p.map((v, k) => v - (k === y ? 1 : 0));
      for (let k = 0; k < labels.length; k++) {
        for (let j = 0; j < HIDDEN; j++) dW2[k]![j]! += dz2[k]! * h[j]!;
        db2[k]! += dz2[k]!;
      }
      const dh: number[] = new Array(HIDDEN).fill(0);
      for (let k = 0; k < labels.length; k++) {
        for (let j = 0; j < HIDDEN; j++) dh[j]! += dz2[k]! * W2[k]![j]!;
      }
      for (let j = 0; j < HIDDEN; j++) {
        const dz1 = dh[j]! * (1 - h[j]! * h[j]!);
        for (let i = 0; i < x.length; i++) if (x[i]) dW1[j]![i]! += dz1 * x[i]!;
        db1[j]! += dz1;
      }
    }
    const n = data.length;
    for (let j = 0; j < HIDDEN; j++) {
      for (let i = 0; i < vocab.length; i++) W1[j]![i]! -= (LR * dW1[j]![i]!) / n;
      b1[j]! -= (LR * db1[j]!) / n;
    }
    for (let k = 0; k < labels.length; k++) {
      for (let j = 0; j < HIDDEN; j++) W2[k]![j]! -= (LR * dW2[k]![j]!) / n;
      b2[k]! -= (LR * db2[k]!) / n;
    }
  }
  return weights;
}

function accuracy(weights: LocalRouterWeights, examples: { label: string; text: string }[]): { acc: number; misses: string[] } {
  let ok = 0;
  const misses: string[] = [];
  for (const ex of examples) {
    const got = classifyLocal(ex.text, weights);
    if (got.label === ex.label) ok += 1;
    else misses.push(`[${ex.label}→${got.label} ${got.confidence.toFixed(2)}] ${ex.text}`);
  }
  return { acc: ok / examples.length, misses };
}

const weights = train();
const trainAcc = accuracy(weights, TRAIN_EXAMPLES);
const heldOut = accuracy(weights, HELD_OUT_EXAMPLES);
process.stdout.write(`词表：${weights.vocab.length} 个词，隐藏层 ${HIDDEN}，标签 ${weights.labels.length} 个\n`);
process.stdout.write(`训练集准确率：${(trainAcc.acc * 100).toFixed(1)}%（${TRAIN_EXAMPLES.length} 条）\n`);
process.stdout.write(`留出集准确率：${(heldOut.acc * 100).toFixed(1)}%（${HELD_OUT_EXAMPLES.length} 条）\n`);
for (const miss of heldOut.misses) process.stdout.write(`  错判：${miss}\n`);
if (heldOut.acc < MIN_HELD_OUT_ACCURACY) {
  process.stderr.write(`留出准确率 ${(heldOut.acc * 100).toFixed(1)}% 低于下限 ${MIN_HELD_OUT_ACCURACY * 100}%，权重不写盘。\n`);
  process.exit(1);
}
// 权重保留 6 位小数：省体积，推理精度不受影响。
const rounded = {
  ...weights,
  W1: weights.W1.map((row) => row.map((v) => Math.round(v * 1e6) / 1e6)),
  b1: weights.b1.map((v) => Math.round(v * 1e6) / 1e6),
  W2: weights.W2.map((row) => row.map((v) => Math.round(v * 1e6) / 1e6)),
  b2: weights.b2.map((v) => Math.round(v * 1e6) / 1e6),
};
const outPath = join(import.meta.dir, "..", "src", "assets", "local-router-weights.json.txt");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(rounded));
process.stdout.write(`权重已写 ${outPath}\n`);
