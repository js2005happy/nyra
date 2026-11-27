// src/bot/dedupAndQuota.ts — Bot 方向 Phase 1：幂等去重 + 速率/预算配额。
//
// 去重为什么要落盘：平台超时重试会重发同一 messageId；进程重启后内存
// 里的已见集合一丢，同一条消息会再回一次。去重记录放
// `~/.nyra/bot-dedup.json`（0600、原子写，与其他账本同款写法），带 TTL
// 与上限，文件不会无限长。
//
// 配额为什么分三档：
//   - 单用户/天：防单个用户把 Bot 当免费 API 刷；
//   - 单群聊/分钟：防群聊洪峰（Webhook/轮询抖动、群友接力刷屏）；
//   - 每天 token 花费：与用量账本同口径（provider 实报 + 已配单价才算钱，
//     算不出时不挡人——与单次硬顶同一诚实边界）。
// 确定性指令（/help、/status、/new、/stop、/model）不走模型、不扣 token，
// 也不计入这三档配额——拦它们只会让用户连“停下”都喊不出来。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveNyraHome } from "../memory.ts";
import { localDateString } from "../usageLedger.ts";

export const BOT_DEDUP_FILE = "bot-dedup.json";
export const BOT_QUOTA_FILE = "bot-quota.json";
/** 去重记录保留 24 小时（平台重试不会隔天还发同一条）。 */
export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
/** 去重记录上限（超了先丢最旧的；文件本身很小，5000 条绰绰有余）。 */
export const DEDUP_MAX_ENTRIES = 5000;

/** 原子写 JSON（0600；approvalBridge 的挂起审批账本共用同一写法）。 */
export function atomicWriteJson(home: string, filename: string, data: unknown): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, filename);
  const tmp = join(dir, `.${filename}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") { try { chmodSync(tmp, 0o600); } catch { /* ignore */ } }
    renameSync(tmp, target);
    if (process.platform !== "win32") { try { chmodSync(target, 0o600); } catch { /* ignore */ } }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function readJsonFile<T>(home: string, filename: string): T | null {
  try {
    const raw = readFileSync(join(resolveNyraHome(home), filename), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed as T;
  } catch {
    return null;
  }
}

/** 消息幂等去重：key 形如 `telegram:<messageId>`。 */
export class DedupStore {
  private entries = new Map<string, number>();
  private readonly home: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(home: string, opts?: { ttlMs?: number; maxEntries?: number }) {
    this.home = home;
    this.ttlMs = opts?.ttlMs ?? DEDUP_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEDUP_MAX_ENTRIES;
    this.load();
  }

  private load(): void {
    const data = readJsonFile<{ version?: number; entries?: Record<string, number> }>(this.home, BOT_DEDUP_FILE);
    const raw = data?.entries;
    if (!raw || typeof raw !== "object") return;
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" && Number.isFinite(v) && now - v < this.ttlMs) this.entries.set(k, v);
    }
    this.enforceCap();
  }

  private enforceCap(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(k);
  }

  private save(): void {
    try {
      atomicWriteJson(this.home, BOT_DEDUP_FILE, { version: 1, entries: Object.fromEntries(this.entries) });
    } catch { /* 去重写盘失败不破坏消息处理：最坏是重启后重复回一次 */ }
  }

  /** 见过这个 key 就返回 true（重复）；没见过就记下来返回 false。 */
  checkAndMark(key: string): boolean {
    const now = Date.now();
    const seenAt = this.entries.get(key);
    if (typeof seenAt === "number" && now - seenAt < this.ttlMs) return true;
    this.entries.set(key, now);
    this.enforceCap();
    this.save();
    return false;
  }

  has(key: string): boolean {
    const seenAt = this.entries.get(key);
    return typeof seenAt === "number" && Date.now() - seenAt < this.ttlMs;
  }

  size(): number {
    return this.entries.size;
  }
}

interface QuotaState {
  version: number;
  /** 每天计数归属的本地日期（YYYY-MM-DD）；换天即清零。 */
  date: string;
  perUser: Record<string, number>;
  /** 当天 token 花费（美元；未计价的调用不进这里）。 */
  spentUsd: number;
}

/** 速率与预算配额：单用户/天、单群聊/分钟、当天 token 花费三档。 */
export class QuotaStore {
  private readonly home: string;
  private state: QuotaState;
  /** 群聊/分钟的滑动窗口只放内存（进程重启后窗口清零：最坏是重启后 1 分钟内多放几条，不值得为它落盘）。 */
  private chatMinute = new Map<string, { windowStart: number; count: number }>();

  constructor(home: string) {
    this.home = home;
    this.state = this.load();
  }

  private freshState(): QuotaState {
    return { version: 1, date: localDateString(), perUser: {}, spentUsd: 0 };
  }

  private load(): QuotaState {
    const data = readJsonFile<QuotaState>(this.home, BOT_QUOTA_FILE);
    if (!data || typeof data !== "object" || data.version !== 1 || typeof data.date !== "string") return this.freshState();
    if (data.date !== localDateString()) return this.freshState();
    return {
      version: 1,
      date: data.date,
      perUser: data.perUser && typeof data.perUser === "object" ? data.perUser : {},
      spentUsd: typeof data.spentUsd === "number" && Number.isFinite(data.spentUsd) ? data.spentUsd : 0,
    };
  }

  private save(): void {
    try {
      atomicWriteJson(this.home, BOT_QUOTA_FILE, this.state);
    } catch { /* 配额写盘失败不破坏消息处理 */ }
  }

  /** 今天（本地日期）。 */
  today(): string {
    return this.state.date;
  }

  /** 单用户当天已用条数（换天自动归零）。 */
  userCount(senderKey: string): number {
    if (this.state.date !== localDateString()) this.state = this.freshState();
    return this.state.perUser[senderKey] ?? 0;
  }

  /** 单用户当天是否还有额度（limit <= 0 = 不限制）。 */
  userAllowed(senderKey: string, limit: number): boolean {
    if (!(limit > 0)) return true;
    return this.userCount(senderKey) < limit;
  }

  /** 记一条用户消息（调用方先查过 userAllowed）。 */
  recordUser(senderKey: string): void {
    if (this.state.date !== localDateString()) this.state = this.freshState();
    this.state.perUser[senderKey] = (this.state.perUser[senderKey] ?? 0) + 1;
    this.save();
  }

  /** 单群聊本分钟是否还有额度（limit <= 0 = 不限制）；通过时自动计数。 */
  chatMinuteAllowed(chatKey: string, limit: number): boolean {
    if (!(limit > 0)) return true;
    const now = Date.now();
    const win = this.chatMinute.get(chatKey);
    if (!win || now - win.windowStart >= 60_000) {
      this.chatMinute.set(chatKey, { windowStart: now, count: 1 });
      return true;
    }
    if (win.count >= limit) return false;
    win.count += 1;
    return true;
  }

  /** 当天已花 token 费用（美元；未计价的调用不计入）。 */
  dailySpentUsd(): number {
    if (this.state.date !== localDateString()) this.state = this.freshState();
    return this.state.spentUsd;
  }

  /** 当天预算是否还有余量（budget 为 null = 不设预算；已花 >= 预算即拦）。 */
  budgetAllowed(budgetUsd: number | null): boolean {
    if (budgetUsd === null || !(budgetUsd >= 0)) return true;
    return this.dailySpentUsd() < budgetUsd;
  }

  /** 记一笔 token 花费（spentUsd 为 null = 未计价，不记）。 */
  recordSpent(spentUsd: number | null): void {
    if (spentUsd === null || !Number.isFinite(spentUsd) || spentUsd <= 0) return;
    if (this.state.date !== localDateString()) this.state = this.freshState();
    this.state.spentUsd += spentUsd;
    this.save();
  }
}
