// src/policy.ts — O1：CEL 风格策略网关（OpenBot CEL 网关借鉴）。
//
// OpenBot 的网关是“所有动作先过策略再执行”：规则可查十几个属性、deny 优先、
// fail-closed、dry-run。Nyra 已有 P0-5 的权限规则语言（permissionRules.ts，
// 工具名 + specifier 写法）与版本化治理策略（governance.ts），本模块补的是
// 缺的那一层——**上下文表达式规则**：写得出“这个 Bot 永不许碰 github.com/settings”
// “routine 不许发消息”“周末不许调付费工具”这类策略。
//
// 表达式语言（确定性子集，先不做完整 CEL）：
//   tool.name == "shell" && bot.id != "reviewer"
//   file.path matches "src/**"
//   initiator.kind in ["routine", "cron"]
//   command startsWith "git "
//   page.host contains "settings"
//   !(tool.name == "gmail_send")
// 比较符：== != < <= > >= in matches startsWith contains；布尔：&& || ! 与括号。
// 字段：tool.name、tool.target、bot.id、actor.id、actor.role、file.path、
// initiator.kind、command、page.url、page.host、mcp.server、mcp.tool、mode。
// 字面量：字符串（单/双引号）、数字、true/false、字符串列表 ["a", "b"]。
//
// 求值次序：deny > ask > allow（与 permissionRules 同款）；都不命中返回 null。
// fail-closed：deny 规则的表达式求值出错（未知字段、类型不对）时按命中处理
// （宁可拦错，不放过）；allow/ask 规则出错时按不命中处理（坏 allow 不放行），
// 出错一律进 warnings（`nyra policy status` 可见）。
// 策略文件损坏（JSON 解析失败）时当成“没有策略”，但记一笔审计并把 corrupt
// 标出来——不学 OpenBot“配错直接阻止服务器启动”：Nyra 是单机 CLI，启动被
// 锁等于整机不可用，拒绝加载 + 记账更合适。已有的审批链（permissionRules、
// 人工审批）不受影响，仍在下面兜底。
//
// 账本：`~/.nyra/policy.json`（0600、原子写，与 accounts.ts 同款纪律），
// 审计：`~/.nyra/policy-audit.jsonl`（append-only，进 SIEM 导出，见 costCaps.ts
// 的 AUDIT_SOURCES）。
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** 策略账本文件名（0600、原子写）。 */
export const POLICY_FILE = "policy.json";
/** 策略审计文件名（append-only，进 SIEM 导出）。 */
export const POLICY_AUDIT_FILE = "policy-audit.jsonl";
/** 规则 id：pol_ + 12 位 hex。 */
export const POLICY_RULE_ID_RE = /^pol_[0-9a-f]{12}$/;

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  id: string;
  action: PolicyAction;
  /** 表达式原文（求值时解析，解析失败按无效规则处理）。 */
  when: string;
  description: string;
  enabled: boolean;
  created_at: string;
}

export interface PolicyStore {
  version: 1;
  /** dry-run：只记不拦（演练模式，默认关）。 */
  dry_run: boolean;
  rules: PolicyRule[];
}

export interface PolicyContext {
  "tool.name": string;
  "tool.target": string;
  "bot.id": string;
  "actor.id": string;
  "actor.role": string;
  "file.path": string;
  "initiator.kind": string;
  command: string;
  "page.url": string;
  "page.host": string;
  "mcp.server": string;
  "mcp.tool": string;
  mode: string;
}

/** 已知的上下文 field（未知字段名在解析时直接报错，不进求值）。 */
export const POLICY_FIELDS: readonly string[] = [
  "tool.name", "tool.target", "bot.id", "actor.id", "actor.role", "file.path",
  "initiator.kind", "command", "page.url", "page.host", "mcp.server", "mcp.tool", "mode",
];

// ---- 表达式解析 ----

type TokenKind = "ident" | "string" | "number" | "bool" | "op" | "lparen" | "rparen" | "lbracket" | "rbracket" | "comma" | "eof";
interface Token { kind: TokenKind; value: string }

const WORD_OPS = new Set(["in", "matches", "startsWith", "contains"]);

function tokenize(input: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i += 1; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen", value: ch }); i += 1; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", value: ch }); i += 1; continue; }
    if (ch === "[") { tokens.push({ kind: "lbracket", value: ch }); i += 1; continue; }
    if (ch === "]") { tokens.push({ kind: "rbracket", value: ch }); i += 1; continue; }
    if (ch === ",") { tokens.push({ kind: "comma", value: ch }); i += 1; continue; }
    if (ch === "&" && input[i + 1] === "&") { tokens.push({ kind: "op", value: "&&" }); i += 2; continue; }
    if (ch === "|" && input[i + 1] === "|") { tokens.push({ kind: "op", value: "||" }); i += 2; continue; }
    if (ch === "=" && input[i + 1] === "=") { tokens.push({ kind: "op", value: "==" }); i += 2; continue; }
    if (ch === "!" && input[i + 1] === "=") { tokens.push({ kind: "op", value: "!=" }); i += 2; continue; }
    if (ch === "!") { tokens.push({ kind: "op", value: "!" }); i += 1; continue; }
    if (ch === "<" && input[i + 1] === "=") { tokens.push({ kind: "op", value: "<=" }); i += 2; continue; }
    if (ch === ">" && input[i + 1] === "=") { tokens.push({ kind: "op", value: ">=" }); i += 2; continue; }
    if (ch === "<" || ch === ">") { tokens.push({ kind: "op", value: ch }); i += 1; continue; }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < input.length) {
        const c = input[j]!;
        if (c === "\\" && j + 1 < input.length && (input[j + 1] === quote || input[j + 1] === "\\")) {
          out += input[j + 1];
          j += 2;
          continue;
        }
        if (c === quote) { closed = true; break; }
        if (c === "\n") break;
        out += c;
        j += 1;
      }
      if (!closed) return `字符串未闭合（位置 ${i}）`;
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i;
      if (input[j] === "-") j += 1;
      let seenDot = false;
      while (j < input.length && (/[0-9]/.test(input[j]!) || (input[j] === "." && !seenDot))) {
        if (input[j] === ".") seenDot = true;
        j += 1;
      }
      tokens.push({ kind: "number", value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j]!)) j += 1;
      const word = input.slice(i, j);
      if (word === "true" || word === "false") tokens.push({ kind: "bool", value: word });
      else if (WORD_OPS.has(word)) tokens.push({ kind: "op", value: word });
      else tokens.push({ kind: "ident", value: word });
      i = j;
      continue;
    }
    return `无法识别的字符 ${JSON.stringify(ch)}（位置 ${i}）`;
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

type AstNode =
  | { kind: "or"; left: AstNode; right: AstNode }
  | { kind: "and"; left: AstNode; right: AstNode }
  | { kind: "not"; expr: AstNode }
  | { kind: "cmp"; op: string; left: AstNode; right: AstNode }
  | { kind: "field"; name: string }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "list"; items: AstNode[] };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private expect(kind: TokenKind, what: string): Token | string {
    const t = this.next();
    if (t.kind !== kind) return `期望 ${what}，实际是 ${t.kind === "eof" ? "表达式结束" : JSON.stringify(t.value)}`;
    return t;
  }

  parse(): AstNode | string {
    const node = this.parseOr();
    if (typeof node === "string") return node;
    if (this.peek().kind !== "eof") return `多余的输入 ${JSON.stringify(this.peek().value)}`;
    return node;
  }

  private parseOr(): AstNode | string {
    let left = this.parseAnd();
    if (typeof left === "string") return left;
    while (this.peek().kind === "op" && this.peek().value === "||") {
      this.next();
      const right = this.parseAnd();
      if (typeof right === "string") return right;
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): AstNode | string {
    let left = this.parseNot();
    if (typeof left === "string") return left;
    while (this.peek().kind === "op" && this.peek().value === "&&") {
      this.next();
      const right = this.parseNot();
      if (typeof right === "string") return right;
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseNot(): AstNode | string {
    if (this.peek().kind === "op" && this.peek().value === "!") {
      this.next();
      const expr = this.parseNot();
      if (typeof expr === "string") return expr;
      return { kind: "not", expr };
    }
    return this.parseCmp();
  }

  private parseCmp(): AstNode | string {
    const left = this.parsePrimary();
    if (typeof left === "string") return left;
    const t = this.peek();
    if (t.kind === "op" && ["==", "!=", "<", "<=", ">", ">=", "in", "matches", "startsWith", "contains"].includes(t.value)) {
      this.next();
      const right = this.parsePrimary();
      if (typeof right === "string") return right;
      return { kind: "cmp", op: t.value, left, right };
    }
    return left;
  }

  private parsePrimary(): AstNode | string {
    const t = this.next();
    if (t.kind === "lparen") {
      const inner = this.parseOr();
      if (typeof inner === "string") return inner;
      const close = this.expect("rparen", "右括号");
      if (typeof close === "string") return close;
      return inner;
    }
    if (t.kind === "lbracket") {
      const items: AstNode[] = [];
      if (this.peek().kind === "rbracket") {
        this.next();
        return { kind: "list", items };
      }
      for (;;) {
        const item = this.parsePrimary();
        if (typeof item === "string") return item;
        items.push(item);
        const sep = this.next();
        if (sep.kind === "comma") continue;
        if (sep.kind === "rbracket") break;
        return `列表里期望逗号或右括号，实际是 ${sep.kind === "eof" ? "表达式结束" : JSON.stringify(sep.value)}`;
      }
      return { kind: "list", items };
    }
    if (t.kind === "string") return { kind: "literal", value: t.value };
    if (t.kind === "number") {
      const n = Number(t.value);
      if (!Number.isFinite(n)) return `数字无效：${t.value}`;
      return { kind: "literal", value: n };
    }
    if (t.kind === "bool") return { kind: "literal", value: t.value === "true" };
    if (t.kind === "ident") {
      if (!(POLICY_FIELDS as readonly string[]).includes(t.value)) {
        return `未知字段 ${t.value}（可用：${POLICY_FIELDS.join("、")}）`;
      }
      return { kind: "field", name: t.value };
    }
    return `期望字段、字面量或括号，实际是 ${t.kind === "eof" ? "表达式结束" : JSON.stringify(t.value)}`;
  }
}

/** 解析一条 when 表达式；失败返回错误文本。 */
export function parsePolicyExpression(when: string): AstNode | string {
  if (typeof when !== "string" || !when.trim()) return "表达式为空";
  const tokens = tokenize(when);
  if (typeof tokens === "string") return tokens;
  return new Parser(tokens).parse();
}

// ---- 求值 ----

/** glob 匹配（* 任意字符、? 单个字符；与 permissionRules 的 segmentMatch 同款语义）。 */
export function globMatch(pattern: string, value: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  try {
    return new RegExp(re, "s").test(value);
  } catch {
    return false;
  }
}

type EvalValue = string | number | boolean | EvalValue[];

/**
 * 求值错误用带标签的对象表示——不能用 string 当错误信号，因为字段值本身
 * 就是 string（"shell" 这类值会被误当成错误返回）。
 */
interface EvalError { error: string }
type EvalResult = EvalValue | EvalError;
function isEvalError(v: EvalResult): v is EvalError {
  return typeof v === "object" && v !== null && "error" in v && typeof (v as EvalError).error === "string";
}
function evalErr(message: string): EvalError {
  return { error: message };
}

function evalNode(node: AstNode, ctx: PolicyContext): EvalResult {
  switch (node.kind) {
  case "literal":
    return node.value;
  case "list": {
    const out: EvalValue[] = [];
    for (const item of node.items) {
      const v = evalNode(item, ctx);
      if (isEvalError(v)) return v;
      out.push(v);
    }
    return out;
  }
  case "field": {
    const v = (ctx as unknown as Record<string, unknown>)[node.name];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return "";
  }
  case "not": {
    const v = evalNode(node.expr, ctx);
    if (isEvalError(v)) return v;
    if (typeof v !== "boolean") return evalErr("逻辑非只能用于布尔值");
    return !v;
  }
  case "and":
  case "or": {
    const l = evalNode(node.left, ctx);
    if (isEvalError(l)) return l;
    const r = evalNode(node.right, ctx);
    if (isEvalError(r)) return r;
    if (typeof l !== "boolean" || typeof r !== "boolean") return evalErr("&& / || 两边都须是布尔值");
    return node.kind === "and" ? (l && r) : (l || r);
  }
  case "cmp": {
    const l = evalNode(node.left, ctx);
    if (isEvalError(l)) return l;
    const r = evalNode(node.right, ctx);
    if (isEvalError(r)) return r;
    if (node.op === "in") {
      if (!Array.isArray(r)) return evalErr("in 的右边须是列表");
      return r.some((item) => item === l);
    }
    if (node.op === "matches" || node.op === "startsWith" || node.op === "contains") {
      if (typeof l !== "string" || typeof r !== "string") return evalErr(`${node.op} 两边都须是字符串`);
      const leftStr: string = l;
      const rightStr: string = r;
      if (node.op === "matches") return globMatch(rightStr, leftStr);
      if (node.op === "startsWith") return leftStr.startsWith(rightStr);
      return leftStr.includes(rightStr);
    }
    if (typeof l !== typeof r) return evalErr(`比较两边类型不同：${typeof l} 与 ${typeof r}`);
    if (node.op === "==") return l === r;
    if (node.op === "!=") return l !== r;
    if (typeof l !== "number" || typeof r !== "number") return evalErr(`${node.op} 只用于数字`);
    if (node.op === "<") return l < r;
    if (node.op === "<=") return l <= r;
    if (node.op === ">") return l > r;
    return l >= r;
  }
  }
}

/**
 * 求值一条规则；返回 true = 命中、false = 不命中、string = 求值错误。
 * 调用方按 fail-closed 处理：deny 规则出错按命中，allow/ask 出错按不命中。
 */
export function evaluateRule(rule: PolicyRule, ctx: PolicyContext): boolean | string {
  const ast = parsePolicyExpression(rule.when);
  if (typeof ast === "string") return ast;
  const v = evalNode(ast, ctx);
  if (isEvalError(v)) return v.error;
  if (typeof v !== "boolean") return "表达式结果不是布尔值";
  return v;
}

export interface PolicyDecision {
  decision: "allow" | "ask" | "deny" | null;
  rule: PolicyRule | null;
  warnings: string[];
}

/**
 * 按 deny > ask > allow 求值；都不命中返回 null。
 * dry-run 时调用方只记不拦（见 evaluatePolicyCall）。
 */
export function evaluatePolicy(store: PolicyStore, ctx: PolicyContext): PolicyDecision {
  const warnings: string[] = [];
  const enabled = store.rules.filter((r) => r.enabled);
  for (const action of ["deny", "ask", "allow"] as const) {
    for (const rule of enabled) {
      if (rule.action !== action) continue;
      const v = evaluateRule(rule, ctx);
      if (typeof v === "string") {
        warnings.push(`规则 ${rule.id}（${action}）求值失败：${v}`);
        // fail-closed：坏 deny 规则按命中处理；坏 allow/ask 规则不放行。
        if (action === "deny") return { decision: "deny", rule, warnings };
        continue;
      }
      if (v) return { decision: action, rule, warnings };
    }
  }
  return { decision: null, rule: null, warnings };
}

// ---- 账本 ----

export function policyPath(home: string): string {
  return join(resolveNyraHome(home), POLICY_FILE);
}

export function policyAuditPath(home: string): string {
  return join(resolveNyraHome(home), POLICY_AUDIT_FILE);
}

function atomicWriteJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.policy-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

export interface LoadedPolicy {
  store: PolicyStore;
  /** 账本文件本身损坏（JSON 解析失败）时为真：当成没有策略 + 记审计。 */
  corrupt: boolean;
  warnings: string[];
}

function emptyStore(): PolicyStore {
  return { version: 1, dry_run: false, rules: [] };
}

export function loadPolicy(home: string): LoadedPolicy {
  const path = policyPath(home);
  if (!existsSync(path)) return { store: emptyStore(), corrupt: false, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    const store = emptyStore();
    appendPolicyAudit(home, { kind: "load_failed", reason: "policy.json 解析失败，已按无策略处理" });
    return { store, corrupt: true, warnings: ["policy.json 解析失败，已按无策略处理（见策略审计）"] };
  }
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { store: emptyStore(), corrupt: true, warnings: ["policy.json 格式不对，已按无策略处理"] };
  }
  const rec = raw as Record<string, unknown>;
  const rules: PolicyRule[] = [];
  if (Array.isArray(rec.rules)) {
    for (const r of rec.rules) {
      if (!r || typeof r !== "object") { warnings.push("跳过一条格式不对的规则"); continue; }
      const row = r as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.when !== "string"
        || (row.action !== "allow" && row.action !== "ask" && row.action !== "deny")) {
        warnings.push("跳过一条字段不全的规则");
        continue;
      }
      const parsed = parsePolicyExpression(row.when);
      if (typeof parsed === "string") {
        warnings.push(`规则 ${row.id} 表达式无效（${parsed}），已跳过`);
        continue;
      }
      rules.push({
        id: row.id,
        action: row.action,
        when: row.when,
        description: typeof row.description === "string" ? row.description : "",
        enabled: row.enabled !== false,
        created_at: typeof row.created_at === "string" ? row.created_at : "",
      });
    }
  }
  return {
    store: { version: 1, dry_run: rec.dry_run === true, rules },
    corrupt: false,
    warnings,
  };
}

export function savePolicy(home: string, store: PolicyStore): void {
  atomicWriteJson(policyPath(home), store);
}

function newRuleId(): string {
  return `pol_${randomBytes(6).toString("hex")}`;
}

export function addPolicyRule(
  home: string,
  action: PolicyAction,
  when: string,
  description = "",
): PolicyRule {
  const parsed = parsePolicyExpression(when);
  if (typeof parsed === "string") throw new PolicyError(`表达式无效：${parsed}`);
  const loaded = loadPolicy(home);
  const rule: PolicyRule = {
    id: newRuleId(),
    action,
    when: when.trim(),
    description: description.trim(),
    enabled: true,
    created_at: new Date().toISOString(),
  };
  loaded.store.rules.push(rule);
  savePolicy(home, loaded.store);
  appendPolicyAudit(home, { kind: "rule_added", rule: rule.id, action, when: rule.when });
  return rule;
}

export function removePolicyRule(home: string, id: string): boolean {
  const loaded = loadPolicy(home);
  const before = loaded.store.rules.length;
  loaded.store.rules = loaded.store.rules.filter((r) => r.id !== id);
  if (loaded.store.rules.length === before) return false;
  savePolicy(home, loaded.store);
  appendPolicyAudit(home, { kind: "rule_removed", rule: id });
  return true;
}

export function setPolicyRuleEnabled(home: string, id: string, enabled: boolean): boolean {
  const loaded = loadPolicy(home);
  const rule = loaded.store.rules.find((r) => r.id === id);
  if (!rule) return false;
  rule.enabled = enabled;
  savePolicy(home, loaded.store);
  appendPolicyAudit(home, { kind: enabled ? "rule_enabled" : "rule_disabled", rule: id });
  return true;
}

export function setPolicyDryRun(home: string, dryRun: boolean): void {
  const loaded = loadPolicy(home);
  loaded.store.dry_run = dryRun;
  savePolicy(home, loaded.store);
  appendPolicyAudit(home, { kind: dryRun ? "dry_run_on" : "dry_run_off" });
}

/** 策略审计（append-only，0600；写失败不抛错，不破坏调用流程）。 */
export function appendPolicyAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = policyAuditPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
      hash: createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 12),
    }) + "\n";
    appendFileSync(path, line, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

export interface PolicyCallContext {
  tool: string;
  target?: string;
  botId?: string;
  actorId?: string;
  actorRole?: string;
  filePath?: string;
  initiatorKind?: string;
  command?: string;
  pageUrl?: string;
  pageHost?: string;
  mcpServer?: string;
  mcpTool?: string;
  mode?: string;
}

export function buildPolicyContext(call: PolicyCallContext): PolicyContext {
  return {
    "tool.name": call.tool,
    "tool.target": call.target ?? "",
    "bot.id": call.botId ?? "default",
    "actor.id": call.actorId ?? call.botId ?? "default",
    "actor.role": call.actorRole ?? "",
    "file.path": call.filePath ?? "",
    "initiator.kind": call.initiatorKind ?? "person",
    command: call.command ?? "",
    "page.url": call.pageUrl ?? "",
    "page.host": call.pageHost ?? "",
    "mcp.server": call.mcpServer ?? "",
    "mcp.tool": call.mcpTool ?? "",
    mode: call.mode ?? "",
  };
}

export interface PolicyCallResult extends PolicyDecision {
  dryRun: boolean;
  corrupt: boolean;
}

/**
 * 一次工具调用的策略求值（含 dry-run 与损坏账本的处理）。
 * dry_run 为真时 decision 照算，但调用方只记不拦。
 */
export function evaluatePolicyCall(home: string, call: PolicyCallContext): PolicyCallResult {
  const loaded = loadPolicy(home);
  const decision = evaluatePolicy(loaded.store, buildPolicyContext(call));
  return { ...decision, dryRun: loaded.store.dry_run, corrupt: loaded.corrupt, warnings: [...loaded.warnings, ...decision.warnings] };
}

// ---- CLI ----

function printUsage(): void {
  console.log(`nyra policy <list|add|remove|enable|disable|test|dry-run|status>
  list                          列出全部策略规则（含已禁用与无效规则警告）
  add <allow|ask|deny> <表达式> [--description <说明>]   加一条规则（表达式先校验，坏的加不进去）
  remove <规则 id>              删一条规则
  enable|disable <规则 id>      启用 / 停用一条规则
  test --tool <工具> [--target <目标>] [--bot <id>] [--actor <id>] [--initiator <person|routine|cron|webhook|handoff|group>] [--file <路径>] [--command <命令>]   演练一次调用，看哪条规则命中
  dry-run <on|off>              演练模式：只记不拦（默认关）
  status                        账本状态：规则数、dry-run、损坏与警告`);
}

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1]!;
}

export async function handlePolicy(argv: string[], home: string): Promise<number> {
  const action = argv[0] ?? "";
  if (!action || action === "help" || action === "--help") {
    printUsage();
    return 0;
  }
  if (action === "list") {
    const loaded = loadPolicy(home);
    console.log(`策略规则（${loaded.store.rules.length} 条，dry-run：${loaded.store.dry_run ? "开" : "关"}${loaded.corrupt ? "，账本损坏、已按无策略处理" : ""}）：`);
    if (loaded.store.rules.length === 0) console.log("（暂无规则：默认审批流程不变）");
    for (const r of loaded.store.rules) {
      console.log(`- ${r.id} [${r.action}]${r.enabled ? "" : "（已停用）"} ${r.when}${r.description ? ` —— ${r.description}` : ""}`);
    }
    for (const w of loaded.warnings) console.log(`警告：${w}`);
    return 0;
  }
  if (action === "status") {
    const loaded = loadPolicy(home);
    const enabled = loaded.store.rules.filter((r) => r.enabled).length;
    console.log(`策略账本：${policyPath(home)}`);
    console.log(`规则：${loaded.store.rules.length} 条（启用 ${enabled} 条），dry-run：${loaded.store.dry_run ? "开（只记不拦）" : "关"}`);
    console.log(`账本：${loaded.corrupt ? "损坏，已按无策略处理" : "正常"}`);
    if (loaded.warnings.length > 0) {
      for (const w of loaded.warnings) console.log(`警告：${w}`);
    } else {
      console.log("警告：无");
    }
    return 0;
  }
  if (action === "add") {
    const act = argv[1] ?? "";
    const when = argv[2] ?? "";
    if (act !== "allow" && act !== "ask" && act !== "deny") {
      console.log("用法：nyra policy add <allow|ask|deny> <表达式>");
      return 2;
    }
    if (!when) {
      console.log("用法：nyra policy add <allow|ask|deny> <表达式>");
      return 2;
    }
    const description = flagValue(argv, "--description") ?? "";
    try {
      const rule = addPolicyRule(home, act, when, description);
      console.log(`已加规则 ${rule.id} [${act}] ${rule.when}`);
      return 0;
    } catch (e) {
      console.log(`加规则失败：${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  if (action === "remove" || action === "enable" || action === "disable") {
    const id = argv[1] ?? "";
    if (!id) {
      console.log(`用法：nyra policy ${action} <规则 id>`);
      return 2;
    }
    const ok = action === "remove"
      ? removePolicyRule(home, id)
      : setPolicyRuleEnabled(home, id, action === "enable");
    console.log(ok ? `已${action === "remove" ? "删除" : action === "enable" ? "启用" : "停用"}规则 ${id}` : `找不到规则 ${id}`);
    return ok ? 0 : 2;
  }
  if (action === "dry-run") {
    const v = argv[1] ?? "";
    if (v !== "on" && v !== "off") {
      console.log("用法：nyra policy dry-run <on|off>");
      return 2;
    }
    setPolicyDryRun(home, v === "on");
    console.log(v === "on" ? "演练模式已开：策略只记不拦" : "演练模式已关");
    return 0;
  }
  if (action === "test") {
    const tool = flagValue(argv, "--tool") ?? "";
    if (!tool) {
      console.log("用法：nyra policy test --tool <工具> [--target <目标>] [--bot <id>] [--actor <id>] [--initiator <person|routine|cron|webhook|handoff|group>] [--file <路径>] [--command <命令>]");
      return 2;
    }
    const result = evaluatePolicyCall(home, {
      tool,
      target: flagValue(argv, "--target") ?? undefined,
      botId: flagValue(argv, "--bot") ?? undefined,
      actorId: flagValue(argv, "--actor") ?? undefined,
      initiatorKind: flagValue(argv, "--initiator") ?? undefined,
      filePath: flagValue(argv, "--file") ?? undefined,
      command: flagValue(argv, "--command") ?? undefined,
    });
    if (result.decision === null) {
      console.log("没有规则命中：走默认审批流程");
    } else {
      console.log(`命中规则 ${result.rule!.id} [${result.decision}] ${result.rule!.when}${result.dryRun ? "（dry-run：只记不拦）" : ""}`);
    }
    for (const w of result.warnings) console.log(`警告：${w}`);
    return 0;
  }
  console.log(`未知动作：${action}`);
  printUsage();
  return 2;
}
