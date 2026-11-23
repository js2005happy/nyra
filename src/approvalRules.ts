// src/approvalRules.ts — “允许并不再询问”的前缀规则（auto 模式审批卡用）。
//
// 设计借鉴 Codex 的审批弹窗（只借鉴设计，不抄代码）：一次审批可以顺手记下一条
// **窄**规则，同类操作以后不再打扰。两种规则：
//   - prefix：shell 命令的 argv 以固定几个词开头，例如 ["git","status"]、
//     ["python3","-m","pytest"]、["npm","run","test"]。
//   - edits：内置文件编辑工具（write_file / edit_file / apply_patch / plan）在本工作区内。
//     这些工具本来就拒绝写工作区外的路径，所以这条规则不会扩大可写范围。
//
// 作用范围：
//   - session：只在内存里，会话结束即失效（SessionRules）。
//   - project：存 <NYRA_HOME>/approval_rules.json，按项目绝对路径分组；
//     **从不写进项目目录**，克隆来的仓库带不进规则（RuleStore）。
//
// 安全模型（与 nyra-approval 的 Python 草稿 approval_rules.py 同语义）：
//   - 只给“简单命令”提供规则：一个程序 + 普通单词。含 ; & | < > $ ` ( ) { } * ? [ ] ~ ! ^ % # \
//     换行、制表符或 FOO=bar 前缀的，只能单次允许。
//   - 删除、提权、联网、执行任意代码的程序（rm、sudo、curl、ssh、bash -c、python -c、
//     find、xargs……）不给规则；危险子命令（git push/reset/clean、npm install/publish……）也不给。
//   - **匹配时重新做同样的简单命令检查**：`git status; rm -rf x`、`git status && curl …`、
//     `git status $(…)`、反引号、换行一律匹配不上 `git status` 规则——没有绕过口子。
//   - 手改规则文件也放不开 rm：匹配时再校验前缀本身是否允许（纵深防御）。
//   - 规则只在 auto/creator 模式且有交互前端时生效：readonly 照样拒绝，full 本来不问，
//     非交互 auto 照样拒绝（调用方 tools.checkApproval 保证）。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RULES_FILENAME = "approval_rules.json";
export const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "plan"]);
export type RuleScope = "session" | "project";
export const RULE_SCOPES: RuleScope[] = ["session", "project"];

export interface RuleSpec { kind: "prefix"; prefix: string[] }
export interface EditsSpec { kind: "edits" }
export type CleanRule = RuleSpec | EditsSpec;
export type ApprovalRule = CleanRule & { id: string; scope: RuleScope; label: string; created_at: string; project?: string };
export type RuleSuggestion = CleanRule & { label: string };

export class RuleError extends Error {
  constructor(message: string) { super(message); this.name = "RuleError"; }
}

// 出现任意一个就不是“简单命令”。
const SHELL_META = new Set(";&|<>$`(){}*?[]~!^%#\\\n\r\t\x00".split(""));

const NO_RULE_PROGRAMS = new Set(`
rm rmdir unlink shred srm del erase rd format
sudo su doas pkexec runas
dd mkfs fdisk parted mount umount diskutil
chmod chown chgrp chattr icacls takeown setfacl
kill killall pkill taskkill shutdown reboot poweroff halt systemctl service launchctl
curl wget nc ncat netcat telnet ssh scp sftp rsync ftp tftp socat
invoke-webrequest iwr invoke-restmethod irm
eval exec source . env nohup time timeout watch xargs parallel nice ionice strace
sh bash zsh fish dash ksh csh tcsh pwsh powershell cmd cmd.exe wsl
find sed awk gawk perl ruby node deno bun lua php osascript
cp mv tee ln install truncate
crontab at schtasks reg regedit setx
npx pnpx bunx dlx
`.split(/\s+/).filter(Boolean));

const INTERPRETER_RE = /^python3(\.\d+)?$|^python$|^py$/;
const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NO_RULE_MODULES = new Set(["pip", "http.server", "venv", "ensurepip", "pydoc", "webbrowser", "smtpd", "ftplib"]);

// 第一个参数必须是子命令的工具；null = 一律不给规则；空集合 = 子命令都可以。
const SUBCOMMAND_TOOLS: Record<string, Set<string> | null> = {
  git: new Set(("push pull fetch clone remote clean reset checkout restore rm mv config filter-branch filter-repo gc " +
    "prune submodule stash update-ref reflog switch rebase merge cherry-pick revert commit tag branch worktree " +
    "am apply send-email daemon credential lfs hooks").split(" ")),
  npm: new Set(("install i ci add uninstall remove rm publish exec x link unpublish update up login logout adduser " +
    "token access owner deprecate dist-tag config set cache prune dedupe audit fund init create").split(" ")),
  pnpm: new Set("install i add remove rm publish exec dlx link update up login logout config store prune create".split(" ")),
  yarn: new Set("install add remove publish exec dlx link upgrade up login logout config cache create global".split(" ")),
  pip: new Set("install uninstall download config cache wheel".split(" ")),
  pip3: new Set("install uninstall download config cache wheel".split(" ")),
  uv: new Set("pip add remove sync tool publish self cache init venv python".split(" ")),
  poetry: new Set("add remove install update publish self config source new init".split(" ")),
  cargo: new Set("install uninstall publish login logout owner yank add remove update new init clean".split(" ")),
  go: new Set("get install mod clean generate env".split(" ")),
  docker: null, podman: null, kubectl: null, gh: null, brew: null,
  apt: null, "apt-get": null, yum: null, dnf: null, pacman: null,
  winget: null, choco: null, scoop: null,
  make: new Set(),
  deno: null,
};
// 让只读命令变成写文件 / 跑程序 / 改配置的参数（git log --output=…、git -c …）。
const RISKY_ARG_PREFIXES = ["--output", "--exec", "--upload-pack", "--receive-pack", "--config", "--git-dir", "--work-tree", "--ext-diff", "-c"];
const SUBCOMMAND_RE = /^[a-z][a-z0-9_:-]*$/;

/** 极简 POSIX 分词：只处理空格、单引号、双引号（反斜杠与 $ 已被 SHELL_META 排除）。引号不闭合返回 null。 */
function splitWords(command: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === " ") {
      if (inWord) { words.push(cur); cur = ""; inWord = false; }
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(cur);
  return words;
}

/** command 是否为“一个程序 + 普通单词”（不含任何 shell 语法）。 */
export function isSimpleCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  for (const ch of command) {
    if (SHELL_META.has(ch)) return false;
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 0x7f) return false;
    // Unicode 行分隔符 / 段分隔符也可能被某些 shell 当换行：一律拒绝。
    if (code === 0x2028 || code === 0x2029 || code === 0x85) return false;
  }
  const words = splitWords(command);
  if (!words || words.length === 0) return false;
  if (words[0].includes("=")) return false; // FOO=bar cmd
  return true;
}

export function splitCommand(command: string): string[] | null {
  if (!isSimpleCommand(command)) return null;
  return splitWords(command);
}

/** 给 command 建议的最窄有用前缀；返回 null 表示只能单次允许。 */
export function suggestPrefix(command: string): string[] | null {
  const words = splitCommand(command);
  if (!words || words.length === 0) return null;
  const prog = words[0];
  if (!prog || prog.includes("/") || prog.includes("\\") || prog.startsWith("-")) return null; // 路径/脚本：文件可能被换掉
  const name = prog.toLowerCase();
  if (NO_RULE_PROGRAMS.has(name)) return null;
  if (name.endsWith(".exe") && NO_RULE_PROGRAMS.has(name.slice(0, -4))) return null;
  if (name.startsWith("mkfs")) return null;
  if (INTERPRETER_RE.test(name)) {
    if (words.length >= 3 && words[1] === "-m" && MODULE_RE.test(words[2])) {
      if (NO_RULE_MODULES.has(words[2].split(".")[0]) || NO_RULE_MODULES.has(words[2])) return null;
      return [prog, "-m", words[2]];
    }
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(SUBCOMMAND_TOOLS, name)) {
    const banned = SUBCOMMAND_TOOLS[name];
    if (banned === null || words.length < 2) return null;
    const sub = words[1];
    if (!SUBCOMMAND_RE.test(sub) || banned.has(sub)) return null;
    if ((name === "npm" || name === "pnpm" || name === "yarn") && (sub === "run" || sub === "run-script")) {
      if (words.length >= 3 && SUBCOMMAND_RE.test(words[2])) return [prog, sub, words[2]];
      return null;
    }
    return [prog, sub];
  }
  if (words.length >= 2 && SUBCOMMAND_RE.test(words[1]) && !words[1].startsWith("-")) return [prog, words[1]];
  return [prog];
}

/**
 * 命令是否可无人值守执行（巡检脚本用，缺口 25 + Kooyu 零 Token 值守）：
 * 复用同一套拒绝清单（危险程序、解释器、危险子命令、危险参数前缀），
 * 但比 suggestPrefix 宽一档：git --version、df -h 这类“程序 + 纯标志”
 * 也放行——无人值守巡检批准的是整条命令原文，运行时再逐字比对，
 * 不需要像常驻规则那样抽一个可复用的前缀。返回 false 的一律不能进巡检脚本。
 */
export function isUnattendedSafeCommand(command: string): boolean {
  const words = splitCommand(command);
  if (!words || words.length === 0) return false;
  const prog = words[0];
  if (!prog || prog.includes("/") || prog.includes("\\") || prog.startsWith("-")) return false;
  const name = prog.toLowerCase();
  if (NO_RULE_PROGRAMS.has(name)) return false;
  if (name.endsWith(".exe") && NO_RULE_PROGRAMS.has(name.slice(0, -4))) return false;
  if (name.startsWith("mkfs")) return false;
  if (INTERPRETER_RE.test(name)) {
    if (words.length >= 3 && words[1] === "-m" && MODULE_RE.test(words[2])) {
      return !NO_RULE_MODULES.has(words[2].split(".")[0]) && !NO_RULE_MODULES.has(words[2]);
    }
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(SUBCOMMAND_TOOLS, name)) {
    const banned = SUBCOMMAND_TOOLS[name];
    if (banned === null) return false;
    if (words.length >= 2 && !words[1].startsWith("-")) {
      const sub = words[1];
      if (!SUBCOMMAND_RE.test(sub) || banned.has(sub)) return false;
      if ((name === "npm" || name === "pnpm" || name === "yarn") && (sub === "run" || sub === "run-script")) {
        if (words.length < 3 || !SUBCOMMAND_RE.test(words[2])) return false;
      }
    }
  }
  if (words.slice(1).some((w) => RISKY_ARG_PREFIXES.some((p) => w.startsWith(p)))) return false;
  return true;
}

/** 前缀本身是否允许：至少要和同样几个词的建议前缀一样窄。 */
export function prefixAllowed(prefix: unknown): prefix is string[] {
  if (!Array.isArray(prefix) || prefix.length === 0) return false;
  if (!prefix.every((w) => typeof w === "string" && w.length > 0)) return false;
  // 每个词自己也不能带 shell 语法（防手改规则文件塞进奇怪字符）。
  if (!prefix.every((w) => isSimpleCommand(w) && splitWords(w)?.length === 1 && splitWords(w)?.[0] === w)) return false;
  const base = suggestPrefix(formatPrefix(prefix));
  return base !== null && base.length <= prefix.length && base.every((w, i) => prefix[i] === w);
}

/** command 是否为以 prefix 开头的简单命令（复合命令、$()、反引号、换行一律 false）。 */
export function prefixMatches(prefix: unknown, command: unknown): boolean {
  if (!Array.isArray(prefix) || prefix.length === 0 || typeof command !== "string") return false;
  const words = splitCommand(command);
  if (!words || words.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (words[i] !== prefix[i]) return false;
  if (words.slice(1).some((w) => RISKY_ARG_PREFIXES.some((p) => w.startsWith(p)))) return false;
  return prefixAllowed(prefix);
}

const SAFE_WORD = /^[A-Za-z0-9@%+=:,./_-]+$/;
export function formatPrefix(prefix: string[]): string {
  return prefix.map((w) => (SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`)).join(" ");
}

export function describeRule(rule: { kind?: string; prefix?: string[] }): string {
  if (rule.kind === "prefix") return `以 \`${formatPrefix(rule.prefix ?? [])}\` 开头的命令`;
  if (rule.kind === "edits") return "此工作区内的文件编辑";
  return String(rule.kind ?? "?");
}

/** 审批卡为这次请求提供的规则；null = 只能单次允许。 */
export function suggestionFor(tool: string, command: string | null | undefined): RuleSuggestion | null {
  let rule: CleanRule;
  if (tool === "shell") {
    const prefix = suggestPrefix(command ?? "");
    if (!prefix) return null;
    rule = { kind: "prefix", prefix };
  } else if (EDIT_TOOLS.has(tool)) {
    rule = { kind: "edits" };
  } else {
    return null;
  }
  return { ...rule, label: describeRule(rule) };
}

export function ruleMatches(rule: { kind?: string; prefix?: unknown }, tool: string, command: string | null | undefined): boolean {
  if (rule.kind === "prefix") return tool === "shell" && typeof command === "string" && prefixMatches(rule.prefix, command);
  if (rule.kind === "edits") return EDIT_TOOLS.has(tool);
  return false;
}

export function cleanRule(rule: unknown): CleanRule | null {
  if (!rule || typeof rule !== "object") return null;
  const r = rule as { kind?: unknown; prefix?: unknown };
  if (r.kind === "prefix") return prefixAllowed(r.prefix) ? { kind: "prefix", prefix: [...r.prefix] } : null;
  if (r.kind === "edits") return { kind: "edits" };
  return null;
}

function sameRule(a: CleanRule | null, b: CleanRule | null): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

export function normalizeProject(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { return abs; }
}

function nowIso(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

/** 项目级规则：存 <home>/approval_rules.json（0600，原子写），按项目绝对路径分组。 */
export class RuleStore {
  path: string;
  constructor(home: string) { this.path = join(home, RULES_FILENAME); }

  private load(): Record<string, unknown[]> {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf-8")) as { projects?: unknown };
      const projects = data && typeof data === "object" ? data.projects : null;
      return projects && typeof projects === "object" && !Array.isArray(projects) ? projects as Record<string, unknown[]> : {};
    } catch { return {}; }
  }

  private save(projects: Record<string, unknown[]>): void {
    const dir = join(this.path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
    try { chmodSync(this.path, 0o600); } catch { /* ignore */ }
  }

  private publicRule(raw: Record<string, unknown>, key: string): ApprovalRule | null {
    const clean = cleanRule(raw);
    if (!clean) return null;
    return { ...clean, id: String(raw.id ?? ""), scope: "project", project: key, created_at: String(raw.created_at ?? ""), label: describeRule(clean) };
  }

  /** 某项目的规则；project 为 null 时列出全部项目。 */
  list(project: string | null): ApprovalRule[] {
    const projects = this.load();
    const keys = project !== null ? [normalizeProject(project)] : Object.keys(projects).sort();
    const out: ApprovalRule[] = [];
    for (const key of keys) {
      const list = projects[key];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const rule = this.publicRule(raw as Record<string, unknown>, key);
        if (rule) out.push(rule);
      }
    }
    return out;
  }

  add(project: string, rule: unknown): ApprovalRule {
    const clean = cleanRule(rule);
    if (!clean) throw new RuleError("这条规则不能保存");
    const key = normalizeProject(project);
    const projects = this.load();
    const list = (Array.isArray(projects[key]) ? projects[key] : []).filter((r) => r && typeof r === "object") as Record<string, unknown>[];
    for (const existing of list) {
      if (sameRule(cleanRule(existing), clean)) return this.publicRule(existing, key)!;
    }
    const entry: Record<string, unknown> = { ...clean, id: randomBytes(6).toString("hex"), created_at: nowIso() };
    list.push(entry);
    projects[key] = list;
    this.save(projects);
    return this.publicRule(entry, key)!;
  }

  remove(ruleId: string, project: string | null = null): boolean {
    const projects = this.load();
    const keys = project !== null ? [normalizeProject(project)] : Object.keys(projects);
    for (const key of keys) {
      const list = Array.isArray(projects[key]) ? projects[key] : [];
      const kept = list.filter((r) => !(r && typeof r === "object" && (r as Record<string, unknown>).id === ruleId));
      if (kept.length !== list.length) {
        if (kept.length) projects[key] = kept;
        else delete projects[key];
        this.save(projects);
        return true;
      }
    }
    return false;
  }

  find(project: string, tool: string, command: string | null | undefined): ApprovalRule | null {
    for (const rule of this.list(project)) if (ruleMatches(rule, tool, command)) return rule;
    return null;
  }
}

/** 本会话规则：只在内存，从不落盘。 */
export class SessionRules {
  private rules: ApprovalRule[] = [];

  add(rule: unknown): ApprovalRule {
    const clean = cleanRule(rule);
    if (!clean) throw new RuleError("这条规则不能保存");
    for (const existing of this.rules) if (sameRule(cleanRule(existing), clean)) return { ...existing };
    const entry: ApprovalRule = { ...clean, id: "s-" + randomBytes(5).toString("hex"), scope: "session", created_at: nowIso(), label: describeRule(clean) };
    this.rules.push(entry);
    return { ...entry };
  }

  list(): ApprovalRule[] { return this.rules.map((r) => ({ ...r })); }

  remove(ruleId: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    return this.rules.length !== before;
  }

  find(tool: string, command: string | null | undefined): ApprovalRule | null {
    for (const rule of this.rules) if (ruleMatches(rule, tool, command)) return { ...rule };
    return null;
  }
}

/**
 * 审批回调的结构化结果（网页/手机审批卡）：
 *   - { approved: true, rule: { scope } } = 允许并按建议规则不再询问；
 *   - { approved: false, feedback } = 拒绝并把反馈带回给 agent。
 * 旧的 boolean / "always" 返回值照常可用。
 */
export interface ApprovalDecision {
  approved: boolean;
  scope?: RuleScope;
  feedback?: string;
}

export const MAX_FEEDBACK = 2000;

/** 拒绝时给模型看的工具错误文案：带上用户反馈，模型据此改做法。 */
export function rejectionMessage(feedback?: string | null): string {
  const text = String(feedback ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_FEEDBACK);
  return text ? `用户拒绝执行，并给出反馈：${text}\n请按反馈调整做法，不要原样重试。` : "用户拒绝执行";
}
