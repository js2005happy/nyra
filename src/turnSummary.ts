// src/turnSummary.ts — 一轮对话的“收尾交代”只用真实数据算：这一轮调了哪些工具、改了几个文件、
// 读了几个文件、跑了几条命令、有没有跑 git push。设计稿 v8（会话收尾一句话、手机列表副标题写状态结果）用。
// 不猜意图、不编数字：没有工具调用的轮次返回 steps = 0，调用方据此不显示交代。
// 叶子模块：不 import 任何 src 内模块（gateway 与测试都直接用）。

export const EDIT_TOOL_NAMES: readonly string[] = ["write_file", "edit_file", "apply_patch"];

export interface TurnSummary {
  /** 这一轮的工具调用数（= 界面上“显示过程（N 步）”的 N）。 */
  steps: number;
  /** 改过的文件（去重、按首次出现排序）。 */
  edited: string[];
  /** 读过的文件数（去重）。 */
  read: number;
  /** 跑过的 shell 命令数。 */
  commands: number;
  /** 这一轮跑过的命令里有没有 git push（只看命令原文，不代表推送成功）。 */
  pushed: boolean;
}

function argsOf(call: unknown): Record<string, unknown> {
  const fn = call && typeof call === "object" ? (call as Record<string, unknown>).function : null;
  const raw = fn && typeof fn === "object" ? (fn as Record<string, unknown>).arguments : null;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw) {
    try { const v = JSON.parse(raw) as unknown; return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
  }
  return {};
}

function nameOf(call: unknown): string {
  const fn = call && typeof call === "object" ? (call as Record<string, unknown>).function : null;
  const n = fn && typeof fn === "object" ? (fn as Record<string, unknown>).name : null;
  return typeof n === "string" ? n : "";
}

/** git push（含 `git -C dir push`、`&& git push origin main` 等），不把 `git push-something` 或注释里的字样算进去。 */
export function isGitPush(command: string): boolean {
  return /(^|[;&|(\s])git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push(\s|$)/.test(command);
}

function contentText(m: Record<string, unknown>): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, unknown>).text as string : "")).join("");
  return "";
}

/**
 * 汇总一组消息里的工具调用。只数真正做成了的：编辑看工具结果（“已写入 / 已编辑 / 已应用补丁”），
 * 命令看有结果且没被用户拒绝，读看有结果且没报错；被拒绝、报错、还没出结果的调用只算进 steps。
 */
export function summarizeCalls(messages: readonly Record<string, unknown>[]): TurnSummary {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool" && typeof m.tool_call_id === "string") results.set(m.tool_call_id, contentText(m));
  const edited: string[] = [];
  const read = new Set<string>();
  let steps = 0, commands = 0, pushed = false;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls as unknown[]) {
      steps++;
      const name = nameOf(c);
      const a = argsOf(c);
      const id = c && typeof c === "object" ? (c as Record<string, unknown>).id : undefined;
      const r = typeof id === "string" ? results.get(id) : undefined;
      if (r === undefined) continue;
      if (EDIT_TOOL_NAMES.includes(name) && typeof a.path === "string" && a.path) {
        if (/^已(写入|编辑|应用补丁)/.test(r) && !edited.includes(a.path)) edited.push(a.path);
      } else if (name === "read_file" && typeof a.path === "string" && a.path) {
        if (!r.startsWith("错误：")) read.add(a.path);
      } else if (name === "shell" && typeof a.command === "string") {
        if (!r.startsWith("错误：用户拒绝")) {
          commands++;
          if (isGitPush(a.command)) pushed = true;
        }
      }
    }
  }
  return { steps, edited, read: read.size, commands, pushed };
}

/** 最后一轮（最后一条用户消息之后）的汇总；没有用户消息时返回 null。 */
export function summarizeLastTurn(messages: readonly Record<string, unknown>[]): TurnSummary | null {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { last = i; break; }
  if (last < 0) return null;
  return summarizeCalls(messages.slice(last + 1));
}
