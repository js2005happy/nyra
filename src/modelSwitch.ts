// src/modelSwitch.ts — 备用模型切换通知：审计 + 用量汇总口径。
//
// 缺口 5 只做了半截留痕：切换时终端 stderr 一行 + `model_switch` 事件进
// events.jsonl，网关靠 SSE 把事件推给网页端；但群聊里用户看不到（只有
// transcript 里一条 model_switches 记录），也没有一份能进 SIEM 导出的
// 审计、用量汇总里也看不到本月切了几次。本模块补这三处：
//   1. 审计：每次切换追加一行 ~/.nyra/model-switch-audit.jsonl
//      （append-only 0600，写失败不抛错），SIEM 导出第 7 个来源；
//   2. 用量汇总：按自然月聚合（次数、触发原因分布、最近一次），
//      供 `nyra stats` / 运行结束汇总 / `nyra cost --show` /
//      `nyra models fallback` 共用；
//   3. 通知文案：与终端 stderr 同款 `fallback.notice`，群聊回复里附上。
//
// 不新起事件类型：`model_switch` 已在 EVENT_FIELDS 里，证据链与时间线
// 渲染都已覆盖；本模块只在它的 onSwitch 回调里多做审计与通知。
// 不碰开关本身：fallback_enabled / fallback_providers 的 opt-in 与
// allowlist 口径不动；队列/定时任务里不切换的红线也不动。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";
import { t, type MsgKey } from "./i18n.ts";
import { switchTriggerFor, type SwitchRecord, type SwitchTrigger } from "./providers.ts";
import { recordQuotaHandoff } from "./quotaHandoff.ts";
import { monthKeyString } from "./usageLedger.ts";

/** 模型切换审计文件（SIEM 导出第 7 个来源，见 costCaps.ts 的 AUDIT_SOURCES）。 */
export const MODEL_SWITCH_AUDIT_FILE = "model-switch-audit.jsonl";

/** 报错原文最长保留 500 字（与 stderr 的 120 字提示不同：审计要留真实报错，不只留半句）。 */
export const SWITCH_ERROR_MAX_CHARS = 500;

/** 与 runs.ts redact() 同口径：≥32 字连续词串当疑似密钥掩掉。 */
const LONG_TOKEN_RE = /[A-Za-z0-9_\-]{32,}/g;
/** sk- 开头的短 Key 样字符串（LONG_TOKEN_RE 盖不到短的）。 */
const SK_KEY_RE = /\bsk-[A-Za-z0-9_\-]{8,}\b/g;

export interface ModelSwitchAuditEntry {
  at: string;
  run_id: string | null;
  agent: string | null;
  from: string;
  to: string;
  trigger: SwitchTrigger;
  kind: string;
  status: number | null;
  /** 已脱敏、截断的真实报错原文。 */
  error: string;
  /**
   * Kooyu 429 接力：限流/配额切换时配的接力摘要 id（quota-handoffs.jsonl
   * 里的那条）。可选字段、只在有摘要时才带——旧审计行的精确比对不受影响。
   */
  handoff_id?: string;
  /**
   * G-P1-33：这次切换把 from 标 degraded 的恢复时间（ISO，可选）。
   * 只在真标了 degraded 时才带——旧审计行的精确比对不受影响。
   */
  degraded_until?: string;
}

/**
 * 报错原文脱敏：home 目录换 [home]、Key 样字符串与 ≥32 字连续词串换
 * <redacted>、超长截断。只做字符串处理，不改语义、不编新报错。
 */
export function scrubSwitchError(text: string, home: string): string {
  let out = text.split(home).join("[home]");
  out = out.replace(SK_KEY_RE, "<redacted>");
  out = out.replace(LONG_TOKEN_RE, "<redacted>");
  if (out.length > SWITCH_ERROR_MAX_CHARS) out = out.slice(0, SWITCH_ERROR_MAX_CHARS - 1) + "…";
  return out;
}

/** 本地时间短格式 YYYY-MM-DD HH:MM（通知里的时间戳用本地时间，用户不用换算）。 */
export function switchTimeShort(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 记一条切换审计（append-only 0600，写失败不抛错、返回 null）。
 * 只在真切换发生时由各路 onSwitch 回调调一次：CLI、网关、群聊机器人。
 * 队列/定时任务不走兜底链，本来就没有切换，也就不会记。
 */
export function recordModelSwitch(
  home: string,
  record: SwitchRecord,
  opts?: { runId?: string | null; agent?: string | null; at?: Date },
): ModelSwitchAuditEntry | null {
  try {
    const resolved = resolveHome(home);
    const at = opts?.at ?? new Date();
    // Kooyu 429 接力：切换记录上挂了接力摘要时，顺带把摘要存进
    // quota-handoffs.jsonl（幂等：同 id 只存一次）。存失败不拦审计——
    // 审计本身还要照常记，接力记录丢了只影响“续跑时查摘要”，不影响
    // “切换留痕”这条主线。
    let handoffId: string | undefined;
    if (record.handoff) {
      handoffId = record.handoff.id;
      try {
        recordQuotaHandoff(home, record.handoff);
      } catch {
        // 落盘失败不抛错，审计继续记。
      }
    }
    const entry: ModelSwitchAuditEntry = {
      at: at.toISOString(),
      run_id: opts?.runId ?? null,
      agent: opts?.agent ?? null,
      from: record.from,
      to: record.to,
      trigger: record.trigger ?? switchTriggerFor(record.kind),
      kind: record.kind,
      status: record.status ?? null,
      error: scrubSwitchError(record.error, resolved),
      ...(handoffId ? { handoff_id: handoffId } : {}),
      ...(record.degradedUntil ? { degraded_until: record.degradedUntil } : {}),
    };
    const path = join(resolved, MODEL_SWITCH_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return null;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(entry) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return entry;
  } catch {
    return null;
  }
}

/** 读审计文件（坏行跳过，不拖垮读取）。 */
export function readModelSwitchAudit(home: string): ModelSwitchAuditEntry[] {
  try {
    const path = join(resolveHome(home), MODEL_SWITCH_AUDIT_FILE);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return [];
    const out: ModelSwitchAuditEntry[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Partial<ModelSwitchAuditEntry>;
        if (typeof row.at !== "string" || typeof row.from !== "string" || typeof row.to !== "string") continue;
        out.push({
          at: row.at,
          run_id: typeof row.run_id === "string" ? row.run_id : null,
          agent: typeof row.agent === "string" ? row.agent : null,
          from: row.from,
          to: row.to,
          trigger: (row.trigger ?? "other") as SwitchTrigger,
          kind: typeof row.kind === "string" ? row.kind : "unknown",
          status: typeof row.status === "number" ? row.status : null,
          error: typeof row.error === "string" ? row.error : "",
          ...(typeof row.handoff_id === "string" ? { handoff_id: row.handoff_id } : {}),
          ...(typeof row.degraded_until === "string" ? { degraded_until: row.degraded_until } : {}),
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

export interface ModelSwitchSummary {
  month: string;
  count: number;
  byTrigger: Partial<Record<SwitchTrigger, number>>;
  last: ModelSwitchAuditEntry | null;
}

/** 按自然月聚合切换：次数、触发原因分布、最近一次。 */
export function summarizeModelSwitches(home: string, month?: string, now = new Date()): ModelSwitchSummary {
  const target = month ?? monthKeyString(now);
  const byTrigger: Partial<Record<SwitchTrigger, number>> = {};
  let count = 0;
  let last: ModelSwitchAuditEntry | null = null;
  for (const entry of readModelSwitchAudit(home)) {
    if (entry.at.slice(0, 7) !== target) continue;
    count += 1;
    byTrigger[entry.trigger] = (byTrigger[entry.trigger] ?? 0) + 1;
    if (!last || entry.at >= last.at) last = entry;
  }
  return { month: target, count, byTrigger, last };
}

/**
 * 用量汇总里的月度切换行（0 次时返回空串，调用方不打印）。
 * 例：`  本月模型切换 2 次（用量触顶 1 次、服务端错误 1 次）；最近一次：deepseek → xai（用量触顶，11-21 19:40）`
 */
export function modelSwitchSummaryLine(home: string, now = new Date()): string {
  const summary = summarizeModelSwitches(home, undefined, now);
  if (summary.count === 0 || !summary.last) return "";
  const breakdown = (Object.entries(summary.byTrigger) as [SwitchTrigger, number][])
    .map(([trigger, n]) => `${t(`fallback.trigger.${trigger}` as MsgKey)} ${n} 次`)
    .join("、");
  return t("stats.monthSwitches", {
    count: summary.count,
    breakdown,
    from: summary.last.from,
    to: summary.last.to,
    trigger: t(`fallback.trigger.${summary.last.trigger}` as MsgKey),
    at: summary.last.at.slice(5, 16).replace("T", " "),
  });
}

/**
 * 立刻通知的文案（与终端 stderr 同款）：从谁切到谁、真实报错原文
 * （120 字截断，与缺口 5 的 stderr 提示一致）、触发原因。
 * 时间与运行 id 由调用方另附（CLI 的 stderr 提示后附，群聊回复里
 * 不另附——回复本身就有发送者与时间，运行 id 在群聊里不存在）。
 */
export function formatModelSwitchNotice(record: SwitchRecord): string {
  const reason = record.error.length > 120 ? record.error.slice(0, 117) + "…" : record.error;
  const trigger = record.trigger ?? switchTriggerFor(record.kind);
  const label = t(`fallback.trigger.${trigger}` as MsgKey);
  let base = t("fallback.notice", { from: record.from, reason, to: record.to, trigger: label });
  // G-P1-33：这次切换把 from 标 degraded 时，通知里写明恢复时间——
  // 用户一眼知道它几分钟内不再被选用，而不是以为它“消失了”。
  if (record.degradedUntil) {
    base += t("fallback.degradedNote", { from: record.from, until: switchTimeShort(new Date(record.degradedUntil)) });
  }
  // Kooyu 429 接力：通知里只引用接力摘要的 id 与查看办法，不塞全文——
  // 全文在 quota-handoffs.jsonl 里，`nyra models handoff <id>` 可看。
  // 没摘要的切换通知原样不动。
  if (!record.handoff) return base;
  return base + t("fallback.handoffRef", { id: record.handoff.id });
}
