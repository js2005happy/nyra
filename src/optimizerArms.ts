// src/optimizerArms.ts — G-P1-29：UCB 臂账本（叶模块）。
//
//   评测驱动的优化闭环里，臂（arm）= 一类评测失败（类别 + 首个未通过的
//   验收项）。每条臂记拉动次数（pulls，提议走到 verify 的次数）与奖励
//   和（rewards，verify 放行记 1、失败记 0），用 UCB1 选下一条最值得
//   试的臂：score = 均值 + C·sqrt(ln(总拉动 + 1) / 拉动)，没拉过的臂
//   优先（+Infinity）。纯算术，不调模型、不花 token。
//
//   本文件只引 node 内置 + config，不引 optimizer.ts / evalLoop.ts，
//   两边都能引它而不成环。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";

export class OptimizerArmsError extends Error {}

const ARMS_FILE = "optimizer-arms.json";
const MAX_RUNS_KEPT = 20;

/** 一条臂：一类评测失败（类别 + 首个未通过的验收项 id）。 */
export interface OptimizerArm {
  key: string;
  category: string;
  checkId: string;
  pulls: number;
  rewards: number;
  createdAt: string;
  lastTriedAt: string | null;
}

export interface EvalLoopRunRecord {
  id: string;
  at: string;
  reportId: string;
  clusters: string[];
  drafted: string[];
  reused: string[];
  rankedArms: string[];
}

export interface ArmsLedger {
  version: 1;
  arms: OptimizerArm[];
  runs: EvalLoopRunRecord[];
}

/** UCB 探索系数（UCB1 经典值 sqrt(2)）。 */
export const UCB_EXPLORATION = Math.SQRT2;

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new OptimizerArmsError(`${file} 不能是符号链接`);
  }
  const tmp = join(dirname(path), `.${file}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function loadArmsLedger(home: string): ArmsLedger {
  const path = join(resolveHome(home), ARMS_FILE);
  if (!existsSync(path)) return { version: 1, arms: [], runs: [] };
  if (lstatSync(path).isSymbolicLink()) throw new OptimizerArmsError(`${ARMS_FILE} 不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new OptimizerArmsError(`${ARMS_FILE} 损坏，已备份，请检查后恢复`);
  }
  const ledger = raw as ArmsLedger;
  if (!ledger || typeof ledger !== "object" || ledger.version !== 1 || !Array.isArray(ledger.arms) || !Array.isArray(ledger.runs)) {
    backupCorrupt(path);
    throw new OptimizerArmsError(`${ARMS_FILE} 格式无效，已备份`);
  }
  return ledger;
}

function saveArmsLedger(home: string, ledger: ArmsLedger): void {
  saveJsonAtomic(home, ARMS_FILE, ledger);
}

export function totalPulls(arms: OptimizerArm[]): number {
  return arms.reduce((n, a) => n + a.pulls, 0);
}

/**
 * UCB1 分数：均值 + C·sqrt(ln(总拉动 + 1) / 拉动)。
 * 没拉过的臂回 +Infinity（先各试一次）；总拉动为 0 时所有臂都是 +Infinity。
 */
export function ucbScore(arm: OptimizerArm, total: number, exploration: number = UCB_EXPLORATION): number {
  if (arm.pulls <= 0) return Number.POSITIVE_INFINITY;
  const mean = arm.rewards / arm.pulls;
  return mean + exploration * Math.sqrt(Math.log(total + 1) / arm.pulls);
}

/** 按 UCB 分数从高到低排；分数相等时按 key 升序（确定性，不靠插入顺序）。 */
export function rankArms(arms: OptimizerArm[]): OptimizerArm[] {
  const total = totalPulls(arms);
  return [...arms].sort((a, b) => {
    const d = ucbScore(b, total) - ucbScore(a, total);
    if (d !== 0) return d;
    return a.key.localeCompare(b.key);
  });
}

/** 取一条臂（不存在就新建，pulls/rewards 均为 0）。 */
export function ensureArm(home: string, key: string, meta: { category: string; checkId: string }): OptimizerArm {
  const ledger = loadArmsLedger(home);
  let arm = ledger.arms.find((a) => a.key === key);
  if (!arm) {
    arm = { key, category: meta.category, checkId: meta.checkId, pulls: 0, rewards: 0, createdAt: nowIso(), lastTriedAt: null };
    ledger.arms.push(arm);
    saveArmsLedger(home, ledger);
  }
  return arm;
}

/**
 * 记一次拉动结果：verify 放行记奖励 1，失败记 0。
 * 臂不存在时先建（category/checkId 从 key 里拆，key 形如 <类别>:<验收项>）。
 */
export function recordArmReward(home: string, key: string, reward: 0 | 1): OptimizerArm {
  const ledger = loadArmsLedger(home);
  let arm = ledger.arms.find((a) => a.key === key);
  if (!arm) {
    const [category, ...rest] = key.split(":");
    arm = { key, category: category || "unknown", checkId: rest.join(":") || "no-checks", pulls: 0, rewards: 0, createdAt: nowIso(), lastTriedAt: null };
    ledger.arms.push(arm);
  }
  arm.pulls += 1;
  arm.rewards += reward;
  arm.lastTriedAt = nowIso();
  saveArmsLedger(home, ledger);
  return arm;
}

/** 记一轮 loop 的运行记录（只留最近 20 轮）。 */
export function recordLoopRun(home: string, run: EvalLoopRunRecord): void {
  const ledger = loadArmsLedger(home);
  ledger.runs.unshift(run);
  if (ledger.runs.length > MAX_RUNS_KEPT) ledger.runs.length = MAX_RUNS_KEPT;
  saveArmsLedger(home, ledger);
}
