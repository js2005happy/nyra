// src/interventions.ts — G-P2-1 运行时消息拦截（bus 层，借 AutoGen
// InterventionHandler 的想法，Node 实现，不抄代码）。
//
// AutoGen 的 InterventionHandler 挂在 runtime 层：on_send / on_publish
// 两点可改写、记日志、丢弃消息。Nyra 原来只有工具调用点的审查 / judge /
// hooks——群聊里对方 agent 发来的每条消息没有一道可编程的拦截器，本批
// 补这一层：消息进总线（群聊 / A2A / AG-UI 入口）时先过拦截器，再决定
// 放行、改写还是丢弃。
//
// 姿态（与 hooks / judge 同款 opt-in）：
// - 总线拦截默认开，但默认动作只有 log（记审计，不改消息、不丢消息）；
// - drop / rewrite 规则建出来默认是关的，须机主显式 `nyra intervention
//   enable <id>` 才生效——丢弃与改写是机主亲手开的，不是默认行为；
// - 机主自己的消息永远不拦截（senderKind === "owner" 直接放行，不记审计）；
// - 本地 CLI 自己的消息不走总线，本模块只在群聊 / A2A / AG-UI 入口被调。
//
// 规则是确定性匹配（总线 / 发送者 / 种类 + contains 子串 / regex），
// 可选挂一个 judge 评分回调（judgeThreshold）：只有评分达线规则才触发。
// judge 是程序扩展点（opts.judge 注入），本批生产接线不接真模型 judge——
// 没接 judge 时带 judgeThreshold 的规则不触发（记审计 judge_missing，
// 不静默放行也不静默丢弃）。
//
// 审计与事件：每条命中规则的消息记审计（`~/.nyra/intervention-audit.jsonl`，
// append-only 0600，只记元数据与文本指纹，绝不记消息原文）；改写与丢弃
// 另外经 opts.emit 发运行事件 `bus_message_rewritten` /
// `bus_message_dropped`（只记元数据），log 只记审计、不发事件（免得噪音）。
//
// 叶模块：只引 node 内置。事件落盘由调用方经 opts.emit 做（与 groupChat
// 的 emit 同款，不在这里 import runs.ts 避环）。
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export class InterventionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterventionError";
  }
}

/** 消息走哪条总线进来的。 */
export type InterventionBus = "group" | "peer" | "a2a" | "agui";
export const INTERVENTION_BUSES: readonly InterventionBus[] = ["group", "peer", "a2a", "agui"];

/** 拦截点：send = 消息发进总线（对端发来的）；publish = 消息在总线里被发布出来（群聊里 bot 的回复）。 */
export type InterventionPoint = "send" | "publish";

/** 谁发的：owner = 机主（永远不拦截）；peer = 对端 agent / 外部渠道；bot = 群聊里的机器人；system = 系统消息。 */
export type BusSenderKind = "owner" | "peer" | "bot" | "system";

/** 总线上的一条消息（只含拦截要用的字段，不含密钥与路径）。 */
export interface BusMessage {
  /** 消息 id（调用方给，没有时自动生成）。 */
  id: string;
  bus: InterventionBus;
  /** 房间 / 会话 / 上下文 id（有就记，没有不记）。 */
  room?: string;
  /** 发送者名（bot id / token 名 / 渠道名）。 */
  sender: string;
  senderKind: BusSenderKind;
  kind: InterventionPoint;
  text: string;
}

/** 规则动作：log 只记审计；rewrite 改写后放行；drop 丢弃。 */
export type InterventionAction = "log" | "rewrite" | "drop";

export interface InterventionMatch {
  /** 任一子串命中即算（大小写不敏感）。 */
  contains?: string[];
  /** 正则（与 contains 是“或”关系：配了两样任一命中即算；只配一样按那样算）。 */
  regex?: string;
}

export interface InterventionRewrite {
  /** 全文替换：[旧, 新]（旧串出现几次换几次）。 */
  replace?: [string, string];
  /** 前面加一段。 */
  prefix?: string;
  /** 后面加一段。 */
  suffix?: string;
}

export interface InterventionRule {
  id: string;
  name: string;
  /** drop / rewrite 规则建出来默认是关的（须机主显式 enable）；log 规则建出来默认开。 */
  enabled: boolean;
  action: InterventionAction;
  /** 不填 = 所有总线都认。 */
  bus?: InterventionBus;
  /** 不填 = 所有发送者都认（精确匹配发送者名）。 */
  sender?: string;
  /** 不填 = send / publish 都认。 */
  kind?: InterventionPoint;
  match: InterventionMatch;
  /** action 是 rewrite 时须给（至少一项）。 */
  rewrite?: InterventionRewrite;
  /** 可选的 judge 门槛（0–100）：配了就只有 judge 评分达线才触发；没接 judge 回调时规则不触发。 */
  judgeThreshold?: number;
  reason?: string;
}

export interface InterventionConfig {
  version: 1;
  /** 总开关（默认开）；关了所有规则都不跑。 */
  enabled: boolean;
  rules: InterventionRule[];
}

export const INTERVENTIONS_FILE = "interventions.json";
export const INTERVENTION_AUDIT_FILE = "intervention-audit.jsonl";
export const MAX_INTERVENTION_RULES = 100;
export const MAX_AUDIT_LINES = 2000;
export const AUDIT_KEEP_LINES = 1000;

export const DEFAULT_INTERVENTION_CONFIG: InterventionConfig = {
  version: 1,
  enabled: true,
  rules: [],
};

export function interventionsPath(home: string): string {
  return join(home, INTERVENTIONS_FILE);
}

export function interventionAuditPath(home: string): string {
  return join(home, INTERVENTION_AUDIT_FILE);
}

/** 文本指纹：SHA-256 前 16 位——审计与事件只记它，不记原文。 */
export function fingerprintText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

export function newInterventionId(): string {
  return `ivr-${randomBytes(6).toString("hex")}`;
}

export function newBusMessageId(): string {
  return `bus-${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

/** 读拦截配置：不存在回默认；损坏先备份再回默认（不抛错、不挡总线）。 */
export function loadInterventions(home: string): InterventionConfig {
  const path = interventionsPath(home);
  if (!existsSync(path)) return { ...DEFAULT_INTERVENTION_CONFIG, rules: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    return { ...DEFAULT_INTERVENTION_CONFIG, rules: [] };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_INTERVENTION_CONFIG, rules: [] };
  const o = raw as Record<string, unknown>;
  const rules: InterventionRule[] = [];
  if (Array.isArray(o.rules)) {
    for (const r of o.rules as unknown[]) {
      try {
        rules.push(validateInterventionRule(r));
      } catch { /* 坏规则跳过，不挡整份配置 */ }
    }
  }
  return { version: 1, enabled: o.enabled === false ? false : true, rules };
}

/** 写拦截配置：0600 原子写（先写临时文件再改名），符号链接拒绝。 */
export function saveInterventions(home: string, config: InterventionConfig): void {
  const path = interventionsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new InterventionError("拦截配置不能是符号链接");
  }
  const tmp = join(dirname(path), `.interventions-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ version: 1, enabled: config.enabled, rules: config.rules }, null, 2), null, "utf-8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

const RULE_NAME_RE = /^[^\s].{0,63}$/;

/** 校验一条规则（原始输入）：不合格直接抛错，不合格的规则不进配置。 */
export function validateInterventionRule(raw: unknown): InterventionRule {
  if (!raw || typeof raw !== "object") throw new InterventionError("规则须是对象");
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : newInterventionId();
  if (!/^ivr-[0-9a-f]{6,}$/.test(id) && typeof o.id === "string" && o.id.trim()) {
    throw new InterventionError(`规则 id 无效：${id}`);
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name || !RULE_NAME_RE.test(name)) {
    throw new InterventionError("规则名须是 1–64 字的非空文字（不能以空白开头）");
  }
  const action = o.action as string;
  if (action !== "log" && action !== "rewrite" && action !== "drop") {
    throw new InterventionError(`规则动作只认 log / rewrite / drop，当前是 ${action}`);
  }
  const bus = o.bus as string | undefined;
  if (bus !== undefined && !(INTERVENTION_BUSES as readonly string[]).includes(bus)) {
    throw new InterventionError(`规则总线只认 group / peer / a2a / agui，当前是 ${bus}`);
  }
  const sender = o.sender as string | undefined;
  if (sender !== undefined && (typeof sender !== "string" || !sender.trim() || sender.length > 128)) {
    throw new InterventionError("规则发送者须是非空文字（≤128 字）");
  }
  const kind = o.kind as string | undefined;
  if (kind !== undefined && kind !== "send" && kind !== "publish") {
    throw new InterventionError(`规则拦截点只认 send / publish，当前是 ${kind}`);
  }
  const match = o.match as Record<string, unknown> | undefined;
  if (!match || typeof match !== "object") throw new InterventionError("规则须给 match（contains 或 regex 至少一个）");
  const contains = match.contains as unknown;
  const regex = match.regex as unknown;
  if (contains === undefined && regex === undefined) {
    throw new InterventionError("规则 match 须给 contains 或 regex 至少一个");
  }
  let containsOut: string[] | undefined;
  if (contains !== undefined) {
    if (!Array.isArray(contains) || !contains.length || contains.length > 32) {
      throw new InterventionError("contains 须是 1–32 个子串的数组");
    }
    containsOut = [];
    for (const c of contains) {
      if (typeof c !== "string" || !c.trim() || c.length > 200) {
        throw new InterventionError("contains 里的子串须是非空文字（≤200 字）");
      }
      containsOut.push(c);
    }
  }
  let regexOut: string | undefined;
  if (regex !== undefined) {
    if (typeof regex !== "string" || !regex.trim() || regex.length > 500) {
      throw new InterventionError("regex 须是非空文字（≤500 字）");
    }
    try {
      new RegExp(regex);
    } catch {
      throw new InterventionError(`regex 不合法：${regex}`);
    }
    regexOut = regex;
  }
  let rewriteOut: InterventionRewrite | undefined;
  if (o.rewrite !== undefined) {
    const rw = o.rewrite as Record<string, unknown>;
    if (!rw || typeof rw !== "object") throw new InterventionError("rewrite 须是对象");
    rewriteOut = {};
    if (rw.replace !== undefined) {
      if (!Array.isArray(rw.replace) || rw.replace.length !== 2 || typeof rw.replace[0] !== "string" || typeof rw.replace[1] !== "string" || !rw.replace[0]) {
        throw new InterventionError("rewrite.replace 须是 [旧串, 新串]（旧串非空）");
      }
      rewriteOut.replace = [rw.replace[0], rw.replace[1]];
    }
    if (rw.prefix !== undefined) {
      if (typeof rw.prefix !== "string" || rw.prefix.length > 500) throw new InterventionError("rewrite.prefix 须是文字（≤500 字）");
      rewriteOut.prefix = rw.prefix;
    }
    if (rw.suffix !== undefined) {
      if (typeof rw.suffix !== "string" || rw.suffix.length > 500) throw new InterventionError("rewrite.suffix 须是文字（≤500 字）");
      rewriteOut.suffix = rw.suffix;
    }
    if (rewriteOut.replace === undefined && rewriteOut.prefix === undefined && rewriteOut.suffix === undefined) {
      throw new InterventionError("rewrite 至少要给 replace / prefix / suffix 其中一项");
    }
  }
  if (action === "rewrite" && !rewriteOut) {
    throw new InterventionError("rewrite 动作的规则须给 rewrite（replace / prefix / suffix 至少一项）");
  }
  let judgeThresholdOut: number | undefined;
  if (o.judgeThreshold !== undefined) {
    const n = typeof o.judgeThreshold === "number" ? o.judgeThreshold : Number(o.judgeThreshold);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
      throw new InterventionError("judgeThreshold 须是 0–100 的整数");
    }
    judgeThresholdOut = n;
  }
  const reason = o.reason as string | undefined;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new InterventionError("reason 须是文字（≤500 字）");
  }
  const enabled = o.enabled === undefined ? action === "log" : o.enabled === true;
  return {
    id,
    name,
    enabled,
    action,
    ...(bus ? { bus: bus as InterventionBus } : {}),
    ...(sender ? { sender: sender.trim() } : {}),
    ...(kind ? { kind: kind as InterventionPoint } : {}),
    match: {
      ...(containsOut ? { contains: containsOut } : {}),
      ...(regexOut ? { regex: regexOut } : {}),
    },
    ...(rewriteOut ? { rewrite: rewriteOut } : {}),
    ...(judgeThresholdOut !== undefined ? { judgeThreshold: judgeThresholdOut } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** 加一条规则：drop / rewrite 建出来默认是关的（须机主显式 enable）；log 建出来默认开。 */
export function addInterventionRule(
  home: string,
  raw: Record<string, unknown>,
): { rule: InterventionRule; needsEnable: boolean } {
  const config = loadInterventions(home);
  if (config.rules.length >= MAX_INTERVENTION_RULES) {
    throw new InterventionError(`规则已到上限 ${MAX_INTERVENTION_RULES} 条，先删旧的再加`);
  }
  const rule = validateInterventionRule(raw);
  if (config.rules.some((r) => r.id === rule.id)) {
    throw new InterventionError(`规则 id 已存在：${rule.id}`);
  }
  config.rules.push(rule);
  saveInterventions(home, config);
  return { rule, needsEnable: !rule.enabled };
}

/** 删一条规则；不存在返回 false。 */
export function removeInterventionRule(home: string, id: string): boolean {
  const config = loadInterventions(home);
  const before = config.rules.length;
  config.rules = config.rules.filter((r) => r.id !== id);
  if (config.rules.length === before) return false;
  saveInterventions(home, config);
  return true;
}

/** 改一条规则的开关；不存在返回 null。 */
export function setInterventionRuleEnabled(home: string, id: string, enabled: boolean): InterventionRule | null {
  const config = loadInterventions(home);
  const rule = config.rules.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = enabled;
  saveInterventions(home, config);
  return rule;
}

/** 改总开关。 */
export function setInterventionsEnabled(home: string, enabled: boolean): InterventionConfig {
  const config = loadInterventions(home);
  config.enabled = enabled;
  saveInterventions(home, config);
  return config;
}

export interface InterventionAuditEntry {
  at: string;
  message_id: string;
  bus: InterventionBus;
  room?: string;
  sender: string;
  sender_kind: BusSenderKind;
  kind: InterventionPoint;
  rule_id: string;
  rule_name: string;
  action: InterventionAction | "judge_missing" | "judge_error" | "skipped_judge";
  reason?: string;
  text_fingerprint: string;
  text_length: number;
  judge_score?: number;
}

/** 审计追加写（0600，超 2000 行时只留最近 1000 行；只记元数据与指纹，不记原文）。 */
export function appendInterventionAudit(home: string, entry: InterventionAuditEntry): void {
  try {
    const path = interventionAuditPath(home);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return;
    const line = JSON.stringify(entry) + "\n";
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, line, null, "utf-8");
    } finally {
      closeSync(fd);
    }
    try {
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      if (lines.length > MAX_AUDIT_LINES) {
        const tmp = join(dirname(path), `.intervention-audit-${process.pid}-${randomBytes(4).toString("hex")}`);
        const fd2 = openSync(tmp, "w", 0o600);
        try {
          writeSync(fd2, lines.slice(-AUDIT_KEEP_LINES).join("\n") + "\n", null, "utf-8");
        } finally {
          closeSync(fd2);
        }
        renameSync(tmp, path);
      }
    } catch { /* 截断失败不破坏本次审计 */ }
  } catch { /* 审计写失败不破坏总线本身 */ }
}

/** 读审计（新的在前，坏行跳过）。 */
export function readInterventionAudit(home: string, limit = 50): InterventionAuditEntry[] {
  const path = interventionAuditPath(home);
  if (!existsSync(path)) return [];
  const out: InterventionAuditEntry[] = [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]) as InterventionAuditEntry;
        if (e && typeof e === "object" && typeof e.rule_id === "string") out.push(e);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* ignore */ }
  return out;
}

/** 规则是否匹配这条消息（过滤器 + 内容匹配；judge 不在这里判）。 */
export function ruleMatches(rule: InterventionRule, msg: BusMessage): boolean {
  if (rule.bus && rule.bus !== msg.bus) return false;
  if (rule.sender && rule.sender !== msg.sender) return false;
  if (rule.kind && rule.kind !== msg.kind) return false;
  const hasContains = Array.isArray(rule.match.contains) && rule.match.contains.length > 0;
  const hasRegex = typeof rule.match.regex === "string" && rule.match.regex.length > 0;
  if (!hasContains && !hasRegex) return false;
  const lower = msg.text.toLowerCase();
  if (hasContains && rule.match.contains!.some((c) => lower.includes(c.toLowerCase()))) return true;
  if (hasRegex) {
    try {
      if (new RegExp(rule.match.regex!).test(msg.text)) return true;
    } catch { /* 校验时已拦过非法正则，这里当不匹配 */ }
  }
  return false;
}

/** 对一条消息应用 rewrite（replace 全量换，再 prefix，再 suffix）。 */
export function applyRewrite(text: string, rewrite: InterventionRewrite): string {
  let out = text;
  if (rewrite.replace) {
    const [oldStr, newStr] = rewrite.replace;
    out = out.split(oldStr).join(newStr);
  }
  if (rewrite.prefix !== undefined) out = rewrite.prefix + out;
  if (rewrite.suffix !== undefined) out = out + rewrite.suffix;
  return out;
}

export interface ApplyInterventionsOptions {
  config?: InterventionConfig;
  /** 可选的 judge 评分回调（0–100，越高越可疑；null = 判不出来）。没传时带 judgeThreshold 的规则不触发。 */
  judge?: (msg: BusMessage) => Promise<number | null>;
  /** 运行事件回调（改写 / 丢弃时调；log 不调）。 */
  emit?: (type: string, fields: Record<string, unknown>) => void;
  /** 默认 true；干跑（CLI test）时传 false，不写审计、不发事件。 */
  audit?: boolean;
}

export interface ApplyInterventionsResult {
  verdict: "pass" | "log" | "rewrite" | "drop";
  /** 改写后的文本（pass / log / drop 时是原文）。 */
  text: string;
  /** 命中的规则 id（按配置顺序）。 */
  matched: string[];
  /** 命中的规则动作（与 matched 一一对应）。 */
  actions: InterventionAction[];
}

/**
 * 把一条总线消息过一遍拦截器。
 * 机主消息直接放行（不记审计）；总开关关了直接放行；没命中规则直接放行。
 * 命中多条时 verdict 按 drop > rewrite > log 取最严的；rewrite 按规则顺序依次应用。
 */
export async function applyInterventions(
  home: string,
  msg: BusMessage,
  opts: ApplyInterventionsOptions = {},
): Promise<ApplyInterventionsResult> {
  const pass: ApplyInterventionsResult = { verdict: "pass", text: msg.text, matched: [], actions: [] };
  if (msg.senderKind === "owner") return pass;
  const config = opts.config ?? loadInterventions(home);
  if (!config.enabled) return pass;
  const fingerprint = fingerprintText(msg.text);
  const matched: InterventionRule[] = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, msg)) continue;
    if (rule.judgeThreshold !== undefined) {
      if (!opts.judge) {
        if (opts.audit !== false) {
          appendInterventionAudit(home, {
            at: new Date().toISOString(), message_id: msg.id, bus: msg.bus,
            ...(msg.room ? { room: msg.room } : {}),
            sender: msg.sender, sender_kind: msg.senderKind, kind: msg.kind,
            rule_id: rule.id, rule_name: rule.name, action: "judge_missing",
            reason: rule.reason ?? "规则配了 judge 门槛，但本次没接 judge 回调",
            text_fingerprint: fingerprint, text_length: msg.text.length,
          });
        }
        continue;
      }
      let score: number | null;
      try {
        score = await opts.judge(msg);
      } catch {
        if (opts.audit !== false) {
          appendInterventionAudit(home, {
            at: new Date().toISOString(), message_id: msg.id, bus: msg.bus,
            ...(msg.room ? { room: msg.room } : {}),
            sender: msg.sender, sender_kind: msg.senderKind, kind: msg.kind,
            rule_id: rule.id, rule_name: rule.name, action: "judge_error",
            reason: rule.reason ?? "judge 回调抛错，规则本次不触发",
            text_fingerprint: fingerprint, text_length: msg.text.length,
          });
        }
        continue;
      }
      if (score === null || !Number.isFinite(score) || score < rule.judgeThreshold) {
        if (opts.audit !== false && score !== null && Number.isFinite(score)) {
          appendInterventionAudit(home, {
            at: new Date().toISOString(), message_id: msg.id, bus: msg.bus,
            ...(msg.room ? { room: msg.room } : {}),
            sender: msg.sender, sender_kind: msg.senderKind, kind: msg.kind,
            rule_id: rule.id, rule_name: rule.name, action: "skipped_judge",
            reason: rule.reason ?? `judge 评分 ${score} 未达门槛 ${rule.judgeThreshold}`,
            text_fingerprint: fingerprint, text_length: msg.text.length, judge_score: score,
          });
        }
        continue;
      }
      matched.push(rule);
      if (opts.audit !== false) {
        appendInterventionAudit(home, {
          at: new Date().toISOString(), message_id: msg.id, bus: msg.bus,
          ...(msg.room ? { room: msg.room } : {}),
          sender: msg.sender, sender_kind: msg.senderKind, kind: msg.kind,
          rule_id: rule.id, rule_name: rule.name, action: rule.action,
          ...(rule.reason ? { reason: rule.reason } : {}),
          text_fingerprint: fingerprint, text_length: msg.text.length, judge_score: score,
        });
      }
      continue;
    }
    matched.push(rule);
    if (opts.audit !== false) {
      appendInterventionAudit(home, {
        at: new Date().toISOString(), message_id: msg.id, bus: msg.bus,
        ...(msg.room ? { room: msg.room } : {}),
        sender: msg.sender, sender_kind: msg.senderKind, kind: msg.kind,
        rule_id: rule.id, rule_name: rule.name, action: rule.action,
        ...(rule.reason ? { reason: rule.reason } : {}),
        text_fingerprint: fingerprint, text_length: msg.text.length,
      });
    }
  }
  if (!matched.length) return pass;
  const ids = matched.map((r) => r.id);
  const actions = matched.map((r) => r.action);
  if (actions.includes("drop")) {
    try {
      opts.emit?.("bus_message_dropped", {
        bus: msg.bus, sender: msg.sender, sender_kind: msg.senderKind,
        rule: ids.join(","), message_id: msg.id, text_fingerprint: fingerprint,
      });
    } catch { /* 事件写失败不破坏总线 */ }
    return { verdict: "drop", text: msg.text, matched: ids, actions };
  }
  const rewrites = matched.filter((r) => r.action === "rewrite" && r.rewrite);
  if (rewrites.length) {
    let text = msg.text;
    for (const r of rewrites) text = applyRewrite(text, r.rewrite!);
    try {
      opts.emit?.("bus_message_rewritten", {
        bus: msg.bus, sender: msg.sender, sender_kind: msg.senderKind,
        rules: ids.join(","), message_id: msg.id, text_fingerprint: fingerprint,
      });
    } catch { /* ignore */ }
    return { verdict: "rewrite", text, matched: ids, actions };
  }
  return { verdict: "log", text: msg.text, matched: ids, actions };
}
