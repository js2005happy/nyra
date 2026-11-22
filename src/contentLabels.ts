// src/contentLabels.ts — G-P1-12 的一半 / G-P1-11：内容安全标签（借 MAF 的
// 安全标签思路，只抄机制、不搬实现）。
//
// 每一份进入 agent 的内容都带一张标签：
// - integrity（完整性）：verified（机主本人写的任务）/ unverified（来源不明
//   但没证据造假）/ untrusted（对端/外部来的，按不可信输入处理）；
// - confidentiality（密级）：public（可公开）/ internal（只在机内流转）/
//   secret（疑似含凭据，一律按秘密处理）；
// - principal（谁发的）：owner / peer / <渠道>。
//
// 标签只做分类与审计，不单独决定放行：放行与否由各道门（审查、judge、
// 单写者门、提议门）按标签 + 工具名判定。标签进事件与提议记录，方便
// 事后追查“这次写操作到底是听谁的”。
//
// 注意：标签认的是任务来源，不是内容真假——机主亲手写的任务即使内容
// 引用了外部文字也是 verified；对端发来的任务即使看起来无害也是
// untrusted。来源不可信时，内容里的指令一律不当指令执行（与缺口 12
// 的 wrapUntrusted 同款口径，这里只给结构化标签）。
export type IntegrityLevel = "verified" | "unverified" | "untrusted";
export type ConfidentialityLevel = "public" | "internal" | "secret";

/** 任务来源：local = 机主本机发起；peer = 对端 agent / 外部渠道发来。 */
export type TaskOrigin = "local" | "peer";

export interface ContentLabel {
  integrity: IntegrityLevel;
  confidentiality: ConfidentialityLevel;
  principal: string;
  reason: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
  /password\s*[:=]\s*["']?\S{6,}/i,
  /passwd\s*[:=]\s*["']?\S{6,}/i,
  /client[_-]?secret\s*[:=]\s*["']?\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * 给一次任务打标签：来源决定完整性；内容里出现凭据形态时密级升为 secret。
 * 机主任务默认 verified/internal；对端任务一律 untrusted/internal。
 */
export function labelTaskContent(task: string, origin: TaskOrigin): ContentLabel {
  const secret = looksSecret(task);
  if (origin === "peer") {
    return {
      integrity: "untrusted",
      confidentiality: secret ? "secret" : "internal",
      principal: "peer",
      reason: secret
        ? "对端发来的任务按不可信输入处理；内容疑似含凭据，按秘密处理"
        : "对端发来的任务按不可信输入处理",
    };
  }
  return {
    integrity: "verified",
    confidentiality: secret ? "secret" : "internal",
    principal: "owner",
    reason: secret ? "机主任务；内容疑似含凭据，按秘密处理" : "机主本人发起的任务",
  };
}

/**
 * 给一次拟执行的工具调用打标签：默认继承任务标签；参数里出现凭据形态
 * 时密级升为 secret（调用方据此决定要不要把参数原文写进审计与事件——
 * secret 一律只记工具名与参数指纹，不记原文）。
 */
export function labelToolArgs(
  tool: string,
  args: Record<string, unknown>,
  taskLabel: ContentLabel,
): ContentLabel {
  const secret = looksSecret(textOf(args));
  if (!secret) return { ...taskLabel };
  return {
    ...taskLabel,
    confidentiality: "secret",
    reason: `${taskLabel.reason}；${tool} 的参数疑似含凭据，按秘密处理`,
  };
}

/**
 * 对方写操作默认进提议的工具集（G-P1-10）：写文件、改文件、打补丁、跑
 * 命令、对外发请求、改记忆、写计划——只要是会产生副作用的，都先记成
 * 提议等机主批，不直接执行。只读工具不在内：对端任务里的读操作照常跑。
 */
export const PROPOSAL_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "shell",
  "http_post",
  "gmail_send",
  "memory_append",
  "memory_delete",
  "memory_forget",
  "save_skill",
  "plan",
]);

/**
 * 隔离分支内可直接写的文件工具（G-P1-8 × G-P1-10 的交界口径）：
 * 写文件类操作被 workspaceWritePath 物理限制在工作目录内；外来子任务
 * 的工作目录就是隔离 worktree，写不出去、也进不了主工作区，改动还要
 * 等机主合入才生效——所以这三样在隔离分支内不进提议门。shell、
 * http_post、gmail_send、改记忆、写计划不在内：它们能越过 worktree
 * 对外产生副作用，仍须进提议等机主批。
 */
export const CONFINED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
]);

/** 这次调用是不是对端来源的写操作（是就进提议，不直接执行）。 */
export function requiresProposal(origin: TaskOrigin | undefined, tool: string): boolean {
  return origin === "peer" && PROPOSAL_TOOLS.has(tool);
}

/** 标签进事件时的精简形态（只记分级与来源，不记原文）。 */
export function labelSummary(label: ContentLabel): string {
  return `${label.integrity}/${label.confidentiality}(${label.principal})`;
}
