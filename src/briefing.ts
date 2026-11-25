// src/briefing.ts — 缺口 45：晨间简报生成。
//
// 每天早上出一份简报：昨夜进展、今日待决策、异常提醒。简报先记证据链再汇报——
// 每条结论都附来源（巡查运行、审阅队列项、责任本身），不是模型随口写的总结。
// 简报本身不调模型：它只是把窗口里已有的证据（巡查报告事件、审阅队列、责任账本）
// 拼成一份可验证的报告，零 token。
//
// “安静”是产品细节：三节全空时回 NO_REPLY——不写收件箱、不建 task 记录、不发消息，
// 只留一条审计（证据文件里记 quiet），账本照常推进窗口，下次简报不再重复扫同一窗口。
// 简报正文存一份带日期的文件 ~/.nyra/briefings/<日期>.md（0600），`brief --show` 可重看。
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync, writeSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EvidenceStore } from "./evidence.ts";
import { RunStore } from "./runs.ts";
import { loadReviewQueue } from "./reviewQueue.ts";
import { loadResponsibilities } from "./responsibilities.ts";
import { appendInbox, nyraHome, TASKS_DIR } from "./tasks.ts";
import { dreamBriefLines, readDreamState } from "./dream.ts";

export class BriefingError extends Error {
  constructor(message: string) { super(message); this.name = "BriefingError"; }
}

export const BRIEFINGS_FILE = "briefings.json";
export const BRIEFINGS_DIR = "briefings";
export const MAX_RUNS_SCANNED = 200;
export const MAX_DECISIONS_LISTED = 20;

export interface BriefingLedger { last_brief_at: string | null; }

export function briefingsPath(home?: string): string {
  return join(nyraHome(home), BRIEFINGS_FILE);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadBriefingLedger(path?: string): BriefingLedger {
  const p = path ?? briefingsPath();
  if (!existsSync(p)) return { last_brief_at: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new BriefingError("简报账本损坏，已备份，请检查后重试");
  }
  const at = (raw as Record<string, unknown>).last_brief_at;
  if (at !== null && at !== undefined && (typeof at !== "string" || Number.isNaN(new Date(at).getTime()))) {
    backupCorrupt(p);
    throw new BriefingError("简报账本格式无效，已备份");
  }
  return { last_brief_at: (at as string | null) ?? null };
}

export function saveBriefingLedger(data: BriefingLedger, path?: string): string {
  const p = path ?? briefingsPath();
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = join(join(p, ".."), `.briefings-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, p); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
  return p;
}

export interface MorningBrief {
  date: string;
  since: string;
  progress: string[];
  decisions: string[];
  anomalies: string[];
  /** H3：昨夜做梦小结（上次做梦在窗口内时才有，否则不写这一节）。 */
  dream?: string[];
  patrolRuns: number;
  patrolFindings: number;
  quiet: boolean;
  text: string;
  savedPath: string | null;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function inWindow(at: string | null | undefined, sinceMs: number): boolean {
  if (!at) return false;
  const t = new Date(at).getTime();
  return !Number.isNaN(t) && t >= sinceMs;
}

function section(title: string, lines: string[]): string {
  const body = lines.length ? lines.map((l) => `- ${l}`).join("\n") : "- （无）";
  return `## ${title}\n${body}`;
}

/** 拼一份简报的正文：三节 + 每条结论的来源，不写推测。做梦小结有内容时多一节。 */
export function renderBriefingText(brief: MorningBrief, now: Date = new Date()): string {
  const lines = [
    `# 晨间简报 ${brief.date}`,
    ``,
    `窗口：${brief.since} → ${now.toISOString()}（自上次简报起，最多回溯 24 小时）`,
    ``,
    section("昨夜进展", brief.progress),
    ``,
    section("今日待决策", brief.decisions),
    ``,
  ];
  if (brief.dream && brief.dream.length) {
    lines.push(section("昨夜做梦小结", brief.dream), ``);
  }
  lines.push(
    section("异常提醒", brief.anomalies),
    ``,
    `窗口内共巡查 ${brief.patrolRuns} 次，其中有发现 ${brief.patrolFindings} 次。`,
  );
  return lines.join("\n") + "\n";
}

/**
 * 生成晨间简报（只读拼证据，不调模型、不写业务文件、不对外发）。
 * 窗口起点：opts.since > 上次简报时间 > 24 小时前（取最近者，上限 7 天，避免账本丢了之后无限回溯）。
 */
export function collectMorningBrief(
  home: string,
  opts: { since?: string; now?: Date } = {},
): Omit<MorningBrief, "text" | "savedPath"> {
  const now = opts.now ?? new Date();
  const ledger = loadBriefingLedger(briefingsPath(home));
  let sinceMs = now.getTime() - 24 * 3600 * 1000;
  if (ledger.last_brief_at) sinceMs = Math.max(sinceMs, new Date(ledger.last_brief_at).getTime());
  if (opts.since) {
    const t = new Date(opts.since).getTime();
    if (Number.isNaN(t)) throw new BriefingError("--since 须是 ISO 时间");
    sinceMs = t;
  }
  // 账本丢了/太久没简报时窗口最多回溯 7 天。
  sinceMs = Math.max(sinceMs, now.getTime() - 7 * 24 * 3600 * 1000);
  const since = new Date(sinceMs).toISOString();

  const progress: string[] = [];
  const decisions: string[] = [];
  const anomalies: string[] = [];
  let patrolRuns = 0;
  let patrolFindings = 0;

  // 昨夜进展与异常之一：窗口里各次巡查的 patrol_report 事件（只读扫描，最多 200 个最新运行）。
  const store = new RunStore(join(nyraHome(home), TASKS_DIR));
  for (const state of store.list().slice(0, MAX_RUNS_SCANNED)) {
    if (!inWindow(state.created_at, sinceMs)) continue;
    let sawPatrol = false;
    for (const ev of store.readEvents(state.run_id)) {
      if (ev.type === "patrol_report") {
        sawPatrol = true;
        const name = String(ev.responsibility_name ?? "?");
        if (ev.findings === true) {
          patrolFindings++;
          progress.push(`巡查「${name}」有发现（来源：巡查「${name}」，run ${state.run_id}）`);
        }
      } else if (ev.type === "responsibility_escalated") {
        anomalies.push(`责任「${String(ev.responsibility_name ?? "?")}」命中升级条件「${String(ev.condition ?? "?")}」，已进审阅队列 ${String(ev.item_id ?? "?")}（来源：巡查升级，run ${state.run_id}）`);
      }
    }
    if (sawPatrol) patrolRuns++;
  }

  // 昨夜进展之二：窗口里完成的责任；异常之二：窗口里过期失效与巡查失败的责任。
  for (const resp of loadResponsibilities(join(nyraHome(home), "responsibilities.json")).responsibilities) {
    if (inWindow(resp.completed_at, sinceMs)) {
      progress.push(`责任「${resp.name}」已完成，验收标准全过（来源：责任「${resp.name}」）`);
    }
    if (inWindow(resp.expired_at, sinceMs)) {
      anomalies.push(`责任「${resp.name}」已过期失效（来源：责任「${resp.name}」）`);
    }
    if (resp.last_status === "error" && inWindow(resp.last_check, sinceMs)) {
      anomalies.push(`责任「${resp.name}」巡查失败：${(resp.last_summary ?? "").slice(0, 120)}（来源：责任「${resp.name}」）`);
    }
  }

  // 今日待决策：审阅队列里所有待批项（每项都须人批，不由模型代劳）。
  const pending = loadReviewQueue(home).filter((it) => it.status === "pending");
  for (const item of pending.slice(0, MAX_DECISIONS_LISTED)) {
    decisions.push(`[${item.source}] ${item.title}（来源：审阅队列 ${item.id}）`);
  }
  if (pending.length > MAX_DECISIONS_LISTED) {
    decisions.push(`另有 ${pending.length - MAX_DECISIONS_LISTED} 项待批未列出，请跑 nyra review list 看全`);
  }

  // H3：昨夜做梦小结——上次做梦在窗口内时写一节；没做梦或没内容就不写。
  const dream = dreamBriefLines(readDreamState(home), sinceMs);

  const quiet = progress.length === 0 && decisions.length === 0 && anomalies.length === 0 && dream.length === 0;
  return {
    date: dateStr(now), since, progress, decisions, anomalies, dream,
    patrolRuns, patrolFindings, quiet,
  };
}

/** 简报存盘路径（带日期，同一天重跑会覆盖当天的那一份）。 */
export function briefingFilePath(home: string, date: string): string {
  return join(nyraHome(home), BRIEFINGS_DIR, `${date}.md`);
}

export function latestBriefingPath(home: string): string | null {
  const dir = join(nyraHome(home), BRIEFINGS_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  return files.length ? join(dir, files[files.length - 1]!) : null;
}

/**
 * 生成并交付一份晨间简报：先记证据链（证据文件里留全文），再汇报。
 * 无事安静时（quiet）：不写收件箱、不建 task 记录、不发消息，只留一条审计，
 * 账本照常推进窗口。交付时收件箱只写一条 ≤200 字的指针，正文在简报文件里。
 */
export function buildMorningBrief(
  home: string,
  opts: { since?: string; now?: Date } = {},
): MorningBrief {
  const now = opts.now ?? new Date();
  const collected = collectMorningBrief(home, opts);
  const brief: MorningBrief = {
    ...collected,
    text: "",
    savedPath: null,
  };
  brief.text = collected.quiet
    ? `# 晨间简报 ${collected.date}\n\n无事安静：窗口内无进展、无待决策、无异常，未打扰。\n`
    : renderBriefingText(brief, now);
  // 先记证据链：全文进 evidence/briefing/，只记元数据与来源，不记目标全文以外的东西。
  new EvidenceStore(join(nyraHome(home), "evidence"), "briefing").save(
    "briefing",
    `briefing://${collected.date}`,
    [
      `晨间简报 ${collected.date}（quiet=${collected.quiet}）`,
      `窗口：${collected.since}`,
      `进展 ${collected.progress.length} 条、待决策 ${collected.decisions.length} 项、异常 ${collected.anomalies.length} 条`,
      ``,
      brief.text,
    ].join("\n"),
  );
  if (!collected.quiet) {
    const dir = join(nyraHome(home), BRIEFINGS_DIR);
    mkdirSync(dir, { recursive: true });
    const path = briefingFilePath(home, collected.date);
    writeFileSync(path, brief.text, { encoding: "utf-8", mode: 0o600 });
    brief.savedPath = path;
    appendInbox(
      `briefing-${collected.date}`,
      "briefing",
      `晨间简报（${collected.date}）：进展 ${collected.progress.length} 条、待决策 ${collected.decisions.length} 项、异常 ${collected.anomalies.length} 条，详见简报文件。`,
      home,
    );
  }
  saveBriefingLedger({ last_brief_at: now.toISOString() }, briefingsPath(home));
  return brief;
}
