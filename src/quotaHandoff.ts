// src/quotaHandoff.ts — Kooyu 429 接力（限流识别 + 接力摘要 + 接力记录）。
//
// 借 Kooyu 三件小东西（只借想法不照抄，见
// ~/workspace/research_notes/nyra-kooyu-20261123.md §2）：
//   ① 限流错误正则识别——Kooyu 的 `429|rate limit|too many requests|
//      quota exceeded|usage limit|capacity exhausted|overloaded|
//      credit balance|insufficient_quota` + 中文“限流/配额/额度用尽不足耗尽”；
//   ② 进度摘要模板——最近任务 + 最近进展 + 已做修改（勿重复）；
//   ③ 接力记录——from/to/error/summary 存证。
// 半自动到此为止：只生成摘要 + 记录 + 通知引用，绝不自动开新会话续跑、
// 绝不自动重试已失败的调用（Kooyu 自己也没做自动续跑；做了反而要解决
// “谁批准续跑”的权限问题）。
//
// 本模块不 import modelSwitch.ts（它 import providers.ts，providers.ts
// 又 import 本模块，静态 import 会成环）：脱敏正则与截断口径与
// modelSwitch.ts 的 scrubSwitchError 同款，本地各抄一份。
// providers.ts 只在切换点调 buildQuotaHandoff（纯函数，不碰磁盘）；
// 落盘由 recordModelSwitch 里顺带做（见 modelSwitch.ts），各路 onSwitch
// 回调（CLI / 网关 / 群聊）共用同一条漏斗。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";
import type { ChatMessage } from "./providers.ts";
import type { SwitchTrigger } from "./providers.ts";

/** 限流接力记录文件（append-only 0600，写失败不抛错）。 */
export const QUOTA_HANDOFF_FILE = "quota-handoffs.jsonl";

/** 摘要里最近任务 / 最近进展各最多 500 字；失败原因同款 500 字；单条已做修改最多 120 字。 */
export const HANDOFF_TEXT_MAX_CHARS = 500;
export const HANDOFF_CHANGE_MAX_CHARS = 120;
/** 接力摘要里最多列 10 条已做修改。 */
export const HANDOFF_MAX_CHANGES = 10;

/**
 * Kooyu 的限流识别（英文原样 + 中文）：命中即“这次失败与限流/配额有关”。
 * 注意它不分 quota 还是 rate_limit——分档仍由 providers.ts 的
 * QUOTA_MESSAGE_PATTERNS（终结：用量上限）先判，本函数只答“是不是限流类”。
 */
export const RATE_LIMIT_MESSAGE_PATTERNS = [
  "429", "rate limit", "rate_limit", "too many requests",
  "quota exceeded", "quota_exceeded", "usage limit",
  "capacity exhausted", "overloaded", "credit balance",
  "insufficient_quota", "insufficient quota",
  "限流", "配额", "过于频繁", "额度用尽", "额度不足", "额度耗尽", "额度已用完",
];

/** 配额类（终结）子集：Kooyu 列表里属于“用量没了、重试同一家也没用”的那几条。 */
export const QUOTA_TEXT_PATTERNS = [
  "quota exceeded", "quota_exceeded", "usage limit",
  "credit balance", "insufficient_quota", "insufficient quota",
  "配额不足", "配额已用完", "配额耗尽", "额度不足", "额度耗尽", "额度用尽", "额度已用完",
];

function matchesAnyPattern(text: string, patterns: string[]): boolean {
  const lowered = (text || "").toLowerCase();
  return patterns.some((p) => lowered.includes(p));
}

/** 这段报错文本是不是限流/配额类（Kooyu 正则的 Nyra 版）。 */
export function isRateLimitErrorText(text: string): boolean {
  return matchesAnyPattern(text, RATE_LIMIT_MESSAGE_PATTERNS);
}

/** 这段报错文本是不是配额耗尽类（限流的子集：用量没了）。 */
export function isQuotaErrorText(text: string): boolean {
  return matchesAnyPattern(text, QUOTA_TEXT_PATTERNS);
}

/** 与 modelSwitch.ts 的 scrubSwitchError 同口径：home 换 [home]、Key 样字符串与 ≥32 字连续词串换 <redacted>、超长截断。 */
const LONG_TOKEN_RE = /[A-Za-z0-9_\-]{32,}/g;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_\-]{8,}\b/g;

export function scrubHandoffText(text: string, home: string, maxChars = HANDOFF_TEXT_MAX_CHARS): string {
  // home 为空时不替换：`"".split("")` 会把文本切成单字再用 [home] 拼起来，
  // 直接毁掉原文（providers.ts 的切换点不知道 home，buildQuotaHandoff
  // 常在 home 为空时调；真正的 home 替换由 recordQuotaHandoff 落盘时补做）。
  let out = home ? (text || "").split(home).join("[home]") : (text || "");
  out = out.replace(SK_KEY_RE, "<redacted>");
  out = out.replace(LONG_TOKEN_RE, "<redacted>");
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
  return out;
}

/** 接力摘要记录：结构化字段供程序查，summary 文本供下一模型直接读。 */
export interface QuotaHandoff {
  id: string;
  at: string;
  run_id: string | null;
  from: string;
  to: string;
  trigger: SwitchTrigger;
  /** 已脱敏、截断的真实报错原文。 */
  error: string;
  /** 最近一条用户消息（已脱敏、截断）；没有时为空串。 */
  lastRequest: string;
  /** 最近一条 assistant 回复（已脱敏、截断）；没有时为空串。 */
  lastReply: string;
  /** 已做修改清单（工具名 + 路径，如 "write_file src/foo.ts"），最多 10 条。 */
  changes: string[];
  /** 拼好的摘要文本（最近任务 + 最近进展 + 已做修改 + 勿重复指令）。 */
  summary: string;
}

export function newHandoffId(): string {
  return `qh_${randomBytes(6).toString("hex")}`;
}

function messageText(msg: ChatMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
          return String((b as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function lastMessageOfRole(messages: ChatMessage[], role: string): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role) return messages[i]!;
  }
  return null;
}

/**
 * 从对话里抽已做修改：assistant 消息的 tool_calls，取工具名 + 路径类参数。
 * 只认写操作常带的路径键（path/file/filePath/filename），没有就退到第一个
 * 字符串参数；解析失败的调用只记工具名。去重、上限 10 条。只做字符串处理，
 * 不跑任何工具、不读工作区。
 */
export function extractHandoffChanges(messages: ChatMessage[], home: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined;
      const name = String(fn?.name ?? (call as Record<string, unknown>).name ?? "");
      if (!name) continue;
      let target = "";
      const rawArgs = fn?.arguments ?? (call as Record<string, unknown>).arguments;
      if (typeof rawArgs === "string" && rawArgs) {
        try {
          const args = JSON.parse(rawArgs) as Record<string, unknown>;
          const keys = ["path", "file", "filePath", "filename", "filepath"];
          for (const k of keys) {
            if (typeof args[k] === "string" && (args[k] as string)) { target = args[k] as string; break; }
          }
          if (!target) {
            for (const v of Object.values(args)) {
              if (typeof v === "string" && v) { target = v; break; }
            }
          }
        } catch {
          target = "";
        }
      }
      const label = target ? `${name} ${scrubHandoffText(target, home, HANDOFF_CHANGE_MAX_CHARS)}` : name;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
      if (out.length >= HANDOFF_MAX_CHANGES) return out;
    }
  }
  return out;
}

function formatHandoffSummary(h: Omit<QuotaHandoff, "summary">): string {
  const at = h.at.slice(0, 16).replace("T", " ");
  const lines = [
    `限流接力摘要（${h.from} → ${h.to}，${at}）`,
    `失败原因：${h.error || "（无）"}`,
    `最近任务：${h.lastRequest || "（本次对话里没有用户消息）"}`,
    `最近进展：${h.lastReply || "（本次对话里没有模型回复）"}`,
    "已做修改：",
  ];
  if (h.changes.length === 0) {
    lines.push("（本次对话里没有工具写操作）");
  } else {
    for (const c of h.changes) lines.push(`- ${c}`);
  }
  lines.push("请基于当前工作区现状继续完成未竟工作，勿重复已完成修改；不要重发已失败的调用。");
  return lines.join("\n");
}

/**
 * 拼一份接力摘要。只在限流/配额触发（trigger 为 quota / rate_limit）时返回
 * 记录，其余触发返回 null（不给非限流切换配摘要——摘要是给“下一个模型续跑”
 * 用的，非限流切换没有续跑的上下文可交）。纯函数，不碰磁盘。
 */
export function buildQuotaHandoff(input: {
  from: string;
  to: string;
  error: string;
  trigger: SwitchTrigger;
  messages: ChatMessage[];
  runId?: string | null;
  home?: string;
  at?: Date;
  id?: string;
}): QuotaHandoff | null {
  if (input.trigger !== "quota" && input.trigger !== "rate_limit") return null;
  const home = input.home ?? "";
  const lastRequest = lastMessageOfRole(input.messages, "user");
  const lastReply = lastMessageOfRole(input.messages, "assistant");
  const base: Omit<QuotaHandoff, "summary"> = {
    id: input.id ?? newHandoffId(),
    at: (input.at ?? new Date()).toISOString(),
    run_id: input.runId ?? null,
    from: input.from,
    to: input.to,
    trigger: input.trigger,
    error: scrubHandoffText(input.error, home),
    lastRequest: scrubHandoffText(lastRequest ? messageText(lastRequest) : "", home),
    lastReply: scrubHandoffText(lastReply ? messageText(lastReply) : "", home),
    changes: extractHandoffChanges(input.messages, home),
  };
  return { ...base, summary: formatHandoffSummary(base) };
}

/**
 * 存一条接力记录（append-only 0600，写失败返回 null 不抛错）。
 * 同 id 已存过时直接返回原记录（不重复追加）：CLI / 网关 / 群聊三路
 * onSwitch 回调共用 recordModelSwitch 这一条漏斗，同一切换只会调一次，
 * 但幂等本身比“相信调用方”可靠。
 */
export function recordQuotaHandoff(home: string, handoff: QuotaHandoff): QuotaHandoff | null {
  try {
    const resolved = resolveHome(home);
    // 落盘前用真 home 再脱敏一次：buildQuotaHandoff 常在不知道 home 的
    // 切换点（providers.ts）调，摘要里可能还留着 home 路径；这里补上
    // home 替换与密钥 scrub（已脱敏过的文本再跑一次是幂等的，不会二次破坏）。
    const clean: QuotaHandoff = {
      ...handoff,
      error: scrubHandoffText(handoff.error, resolved),
      lastRequest: scrubHandoffText(handoff.lastRequest, resolved),
      lastReply: scrubHandoffText(handoff.lastReply, resolved),
      changes: handoff.changes.map((c) => scrubHandoffText(c, resolved, HANDOFF_CHANGE_MAX_CHARS)),
      summary: scrubHandoffText(handoff.summary, resolved, handoff.summary.length),
    };
    const path = join(resolved, QUOTA_HANDOFF_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return null;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          if ((JSON.parse(line) as Partial<QuotaHandoff>).id === clean.id) return clean;
        } catch {
          continue;
        }
      }
    }
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(clean) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return clean;
  } catch {
    return null;
  }
}

/** 读接力记录（坏行跳过，不拖垮读取）。 */
export function readQuotaHandoffs(home: string): QuotaHandoff[] {
  try {
    const path = join(resolveHome(home), QUOTA_HANDOFF_FILE);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return [];
    const out: QuotaHandoff[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Partial<QuotaHandoff>;
        if (typeof row.id !== "string" || typeof row.from !== "string" || typeof row.to !== "string") continue;
        out.push({
          id: row.id,
          at: typeof row.at === "string" ? row.at : "",
          run_id: typeof row.run_id === "string" ? row.run_id : null,
          from: row.from,
          to: row.to,
          trigger: (row.trigger ?? "other") as SwitchTrigger,
          error: typeof row.error === "string" ? row.error : "",
          lastRequest: typeof row.lastRequest === "string" ? row.lastRequest : "",
          lastReply: typeof row.lastReply === "string" ? row.lastReply : "",
          changes: Array.isArray(row.changes) ? row.changes.filter((c): c is string => typeof c === "string") : [],
          summary: typeof row.summary === "string" ? row.summary : "",
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 按 id 取一条接力记录，没有返回 null。 */
export function getQuotaHandoff(home: string, id: string): QuotaHandoff | null {
  return readQuotaHandoffs(home).find((h) => h.id === id) ?? null;
}

/** 按自然月聚合接力次数与最近一次（供 `nyra models fallback` 共用）。 */
export function summarizeQuotaHandoffs(home: string, month?: string, now = new Date()): { month: string; count: number; last: QuotaHandoff | null } {
  const target = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let count = 0;
  let last: QuotaHandoff | null = null;
  for (const h of readQuotaHandoffs(home)) {
    if (h.at.slice(0, 7) !== target) continue;
    count += 1;
    if (!last || h.at >= last.at) last = h;
  }
  return { month: target, count, last };
}
