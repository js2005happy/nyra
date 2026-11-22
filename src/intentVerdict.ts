// src/intentVerdict.ts — G-P1-12：两层意向验证（借 Turnstone 的两层做法）。
//
// 第一层是零成本启发式（本模块，确定性规则、不调模型、不花 token）：
//   critical → 直接拒绝，不调 judge 模型（远程代码执行、凭据外泄、
//     删根目录这类一眼就能认出来的危险，没必要再花一次模型钱）；
//   high     → 必须过第二层（judge 开了就打分；judge 没开就转人工审批，
//     非交互下没人可问时 checkApproval 会拒绝）；
//   medium   → 放行，但结论进落库与事件（留痕备查）；
//   low/none → 不留痕、不打扰。
// 第二层是已有的 judge 打分（src/toolJudge.ts）：第一层没拦下的高危
// 调用继续由模型打分；两层结论都落进同一本 verdict 账本
// （~/.nyra/intent-verdicts.jsonl，0600 追加写，只记工具名、规则、
// 结论与理由，不记参数原文与文件内容）。
//
// 启发式只是绊线，不是沙箱：它拦得住“手滑 / 模型照抄的典型危险形态”，
// 拦不住存心绕过的人（与 shell denylist 同款诚实边界，见 tools.ts）。
// 所以 critical 规则只写“误判代价低、意图明确”的形态：删根、远程代码
// 执行、凭据外泄、提权删系统目录。拿不准的形态一律只给 high/medium，
// 交给第二层或人来定。
export type HeuristicLevel = "critical" | "high" | "medium" | "low" | "none";

export interface HeuristicHit {
  level: HeuristicLevel;
  rule: string;
  reason: string;
}

export type IntentDecision = "allow" | "escalate" | "deny";
export type IntentLayer = "heuristic" | "judge";

export interface IntentVerdictEntry {
  at: string;
  tool: string;
  layer: IntentLayer;
  decision: IntentDecision;
  rule: string | null;
  reason: string;
  risk_score: number | null;
}

export const INTENT_VERDICTS_FILE = "intent-verdicts.jsonl";
export const INTENT_VERDICTS_MAX_LINES = 2000;

interface HeuristicRule {
  level: Exclude<HeuristicLevel, "none">;
  rule: string;
  reason: string;
  test: (tool: string, args: Record<string, unknown>, task: string) => boolean;
}

function argText(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const v of Object.values(args)) {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === "string").join(" "));
  }
  return parts.join("\n");
}

const CREDENTIAL_PATHS = [
  "vault.json",
  "keys.json",
  "id_rsa",
  "id_ed25519",
  ".env",
  "credentials.json",
  ".aws/credentials",
  ".gnupg",
];

function mentionsCredentialPath(text: string): boolean {
  const lower = text.toLowerCase();
  return CREDENTIAL_PATHS.some((p) => lower.includes(p));
}

function mentionsNetworkSend(text: string): boolean {
  return /\b(curl|wget|nc|ncat|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(text)
    || /https?:\/\/\S+/.test(text);
}

/** 启发式规则表（按顺序命中第一条；critical 在前，medium 在后）。 */
const HEURISTIC_RULES: HeuristicRule[] = [
  {
    level: "critical",
    rule: "delete-root",
    reason: "启发式拦截：删根目录或用户家目录（rm -rf /、~、/* 这类）",
    test: (tool, args) => {
      if (tool !== "shell") return false;
      const cmd = typeof args.command === "string" ? args.command : "";
      return /(^|[;&|]\s*)rm\s+[^|;&]*-[a-z]*r[a-z]*f[a-z]*\s+(["']?)(\/|\/[*]|~|\$HOME)(\s|["']|$)/i.test(cmd)
        || /(^|[;&|]\s*)rm\s+(-[^|;&]*)?--recursive/i.test(cmd) && /\s\/(\s|$)/.test(cmd);
    },
  },
  {
    level: "critical",
    rule: "remote-code-exec",
    reason: "启发式拦截：拉远程内容直接喂给 shell（curl/wget … | sh/bash）",
    test: (tool, args) => {
      if (tool !== "shell") return false;
      const cmd = typeof args.command === "string" ? args.command : "";
      return /\b(curl|wget)\b[^|;&]*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i.test(cmd)
        || /\b(curl|wget)\b[^|;&]*\|\s*python3?\b/i.test(cmd);
    },
  },
  {
    level: "critical",
    rule: "credential-exfil",
    reason: "启发式拦截：同一条命令里既读凭据文件又往外发（读密钥 + 联网发送）",
    test: (tool, args) => {
      if (tool !== "shell") return false;
      const cmd = typeof args.command === "string" ? args.command : "";
      return mentionsCredentialPath(cmd) && mentionsNetworkSend(cmd);
    },
  },
  {
    level: "critical",
    rule: "destroy-device",
    reason: "启发式拦截：毁设备类命令（mkfs、dd 写块设备、关机/重启）",
    test: (tool, args) => {
      if (tool !== "shell") return false;
      const cmd = typeof args.command === "string" ? args.command : "";
      return /(^|[;&|]\s*)(mkfs(\.\w+)?|dd\s+[^|;&]*\bof=\/dev\/|shred\s+[^|;&]*\/dev\/|shutdown|poweroff|reboot|init\s+0)\b/i.test(cmd);
    },
  },
  {
    level: "high",
    rule: "read-credential-file",
    reason: "启发式转人工：读凭据文件（密码箱、密钥、.env 这类）须人确认",
    test: (tool, args) => {
      if (tool !== "read_file" && tool !== "shell") return false;
      const text = tool === "shell"
        ? (typeof args.command === "string" ? args.command : "")
        : (typeof args.path === "string" ? args.path : "");
      return mentionsCredentialPath(text);
    },
  },
  {
    level: "high",
    rule: "sudo-or-privilege",
    reason: "启发式转人工：提权类命令（sudo/su/chmod 777）须人确认",
    test: (tool, args) => {
      if (tool !== "shell") return false;
      const cmd = typeof args.command === "string" ? args.command : "";
      return /(^|[;&|]\s*)(sudo|su(\s|$)|chmod\s+(-R\s+)?777|chown\s+[^|;&]*\s+\/\S*)/i.test(cmd);
    },
  },
  {
    level: "high",
    rule: "send-secret-like",
    reason: "启发式转人工：对外发送的内容疑似含凭据形态须人确认",
    test: (tool, args) => {
      if (tool !== "gmail_send" && tool !== "http_post") return false;
      const text = argText(args);
      return /sk-[A-Za-z0-9]{20,}/.test(text)
        || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
        || /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i.test(text);
    },
  },
  {
    level: "high",
    rule: "absolute-delete",
    reason: "启发式转人工：rm -rf 带绝对路径（不在工作区内的删除）须人确认",
    test: (tool, args) => {
      if (tool !== "shell") return false;
      const cmd = typeof args.command === "string" ? args.command : "";
      return /(^|[;&|]\s*)rm\s+[^|;&]*-[a-z]*r[a-z]*f[a-z]*\s+["']?\//i.test(cmd);
    },
  },
  {
    level: "medium",
    rule: "write-outside-workspace",
    reason: "启发式留痕：写绝对路径文件（工作区外）",
    test: (tool, args) => {
      if (tool !== "write_file" && tool !== "edit_file" && tool !== "apply_patch") return false;
      const p = typeof args.path === "string" ? args.path : "";
      return p.startsWith("/") || /^[A-Za-z]:\\/.test(p);
    },
  },
  {
    level: "medium",
    rule: "broad-forget",
    reason: "启发式留痕：批量删记忆（按会话删全部条目）",
    test: (tool, args) => {
      if (tool !== "memory_delete" && tool !== "memory_forget") return false;
      return typeof args.session_id === "string" && args.session_id.length > 0;
    },
  },
];

/**
 * 零成本启发式检查：按规则表顺序命中第一条；没命中返回 level none。
 * task 参数只用于将来的规则（现在规则只看工具名与参数），先留着。
 */
export function checkIntentHeuristic(
  tool: string,
  args: Record<string, unknown>,
  _task = "",
): HeuristicHit {
  for (const r of HEURISTIC_RULES) {
    let hit = false;
    try {
      hit = r.test(tool, args, _task);
    } catch {
      hit = false;
    }
    if (hit) return { level: r.level, rule: r.rule, reason: r.reason };
  }
  return { level: "none", rule: "", reason: "" };
}

/** 启发式结论到三档的映射（critical 直接拒绝；high 转人工；medium 放行留痕）。 */
export function heuristicDecision(hit: HeuristicHit): IntentDecision {
  if (hit.level === "critical") return "deny";
  if (hit.level === "high") return "escalate";
  return "allow";
}

import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveNyraHome } from "./memory.ts";

function verdictsPath(home: string): string {
  return join(resolveNyraHome(home), INTENT_VERDICTS_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 追加一条 verdict 记录（只记工具名、层、结论、规则与理由，不记参数原文
 * 与文件内容）。文件是追加写 JSONL，0600；符号链接拒绝写入。
 * 超过上限时截断到最新 2000 条（旧结论是审计，不静默丢：截断前不备份，
 * 因为每条结论同时已发运行事件，证据链里另有副本）。
 */
export function appendIntentVerdict(home: string, entry: Omit<IntentVerdictEntry, "at">): boolean {
  try {
    const path = verdictsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const line = JSON.stringify({ at: nowIso(), ...entry }) + "\n";
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, line, null, "utf-8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 读最近的 verdict 记录（新的在后；损坏的行跳过，不抛错）。 */
export function listIntentVerdicts(home: string, limit = 50): IntentVerdictEntry[] {
  const path = verdictsPath(home);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: IntentVerdictEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as IntentVerdictEntry;
      if (parsed && typeof parsed.tool === "string" && typeof parsed.decision === "string") {
        out.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return out.slice(-Math.max(1, limit));
}

/** 截断 verdict 账本到最新 N 条（测试与整理用；生产不主动调）。 */
export function trimIntentVerdicts(home: string, keep = INTENT_VERDICTS_MAX_LINES): number {
  const entries = listIntentVerdicts(home, Number.MAX_SAFE_INTEGER);
  if (entries.length <= keep) return entries.length;
  const kept = entries.slice(-keep);
  const path = verdictsPath(home);
  const tmp = join(dirname(path), `.intent-verdicts-${process.pid}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", null, "utf-8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
  return kept.length;
}
