// src/eventTriggers.ts — 事件触发任务（缺口 7）：从“定时”升级为“有事就动”。
//
// 两条入口进同一条队列：
//   1. webhook（网关 POST /api/webhooks/:source）：外部服务推事件 → 验签 → 匹配触发器 → 进任务队列；
//   2. 应用事件源（本批先做 Gmail 新邮件轮询）：连接器拉到新事件 → 同样匹配 → 进队列。
//
// 权限边界（与定时任务同规则，见 src/tasks.ts）：
//   - 触发器只允许 readonly / auto，`full` 在校验层就拒绝；队列任务本身也拒绝 full；
//   - 触发只是入队，执行仍走任务队列：非交互运行时写操作照常挂起等审批（awaiting_approval），
//     不自动放行；成本上限（单次 + 月度）与白名单/沙箱全部继承；
//   - 事件内容是不可信外部数据：进任务提示词前，payload 一律包 wrapUntrusted，
//     摘要只取前 200 字元数据；事件里的指令性文字一律不执行。
// 可审计：每一次触发都在新任务的 events.jsonl 里记一条 `event_triggered`
// （哪个触发器、什么事件、谁发的、进了哪个任务、什么模式、什么鉴权），
// 触发器名与事件 id 过长时事件里只记指纹（appendEvent 的 redact 会把 32 字以上的
// 类 token 字符串抹掉，见 src/runs.ts）；完整 id 在投递记录文件里。
// 幂等：同一事件重复投递（webhook 重试、轮询重叠）只派发一次，第二次返回原 run_id。
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { addTask, TASKS_DIR, nyraHome } from "./tasks.ts";
import { RunStore } from "./runs.ts";
import { wrapUntrusted } from "./untrusted.ts";
import { getCredential } from "./vault.ts";

export class EventTriggerError extends Error {
  constructor(message: string) { super(message); this.name = "EventTriggerError"; }
}

export class WebhookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WebhookError";
    this.status = status;
  }
}

export type EventSource = "webhook" | "gmail";
export type WebhookSource = "generic" | "github" | "slack";
export const WEBHOOK_SOURCES: readonly string[] = ["generic", "github", "slack"];

export const EVENT_TRIGGERS_FILE = "event-triggers.json";
export const EVENT_DELIVERIES_FILE = "event-deliveries.json";
export const GMAIL_POLL_STATE_FILE = join("event-sources", "gmail.json");
export const MAX_TASK_CHARS = 8000;
/** 单个事件最多命中几个触发器：防一个事件扇出成一堆任务。 */
export const MAX_DISPATCHES_PER_EVENT = 10;
/** 每分钟最多派发几次：防 webhook 洪水把 token 烧光（进程内计数）。 */
export const MAX_DISPATCHES_PER_MINUTE = 20;
/** Gmail 轮询间隔（秒）：守护进程每轮都问，但不到间隔直接跳过。 */
export const GMAIL_POLL_INTERVAL_SECONDS = 300;
const MAX_PAYLOAD_CHARS = 4000;
const MAX_SUMMARY_CHARS = 200;
const DELIVERY_KEEP = 1000;
const GMAIL_SEEN_KEEP = 500;

export interface IncomingEvent {
  source: EventSource;
  eventType: string;
  eventId: string;
  receivedAt: string;
  actor?: string | null;
  summary?: string;
  payload: Record<string, unknown>;
  /** 鉴权方式：gateway-token / hmac-github / hmac-slack / gmail-oauth / none。 */
  auth?: string;
}

export interface TriggerMatch {
  from_contains?: string;
  subject_contains?: string;
  text_contains?: string;
}

export interface EventTrigger {
  id: string;
  name: string;
  source: EventSource;
  event: string;
  match?: TriggerMatch;
  task: string;
  mode: "readonly" | "auto";
  enabled: boolean;
  /** 建议触发器（G-P1-37 自动化 bundle 自带）：装好但默认关闭，机主看过再开。 */
  suggested?: boolean;
  workdir?: string | null;
  max_turns: number;
}

export interface EventTriggerData { triggers: EventTrigger[]; }

export function eventTriggersPath(home?: string): string {
  return join(nyraHome(home), EVENT_TRIGGERS_FILE);
}

export function eventDeliveriesPath(home?: string): string {
  return join(nyraHome(home), EVENT_DELIVERIES_FILE);
}

export function gmailPollStatePath(home?: string): string {
  return join(nyraHome(home), GMAIL_POLL_STATE_FILE);
}

const EVENT_RE = /^[A-Za-z0-9._-]+$/;

export function validateEventTrigger(trigger: Record<string, unknown>): EventTrigger {
  if (typeof trigger.name !== "string" || !trigger.name.trim() || trigger.name.trim().length > 100) {
    throw new EventTriggerError("触发器名不能为空且不超过 100 字符");
  }
  if (trigger.source !== "webhook" && trigger.source !== "gmail") {
    throw new EventTriggerError("触发器来源只允许 webhook 或 gmail");
  }
  if (typeof trigger.event !== "string" || !trigger.event.trim() || trigger.event.trim().length > 100 || !EVENT_RE.test(trigger.event.trim())) {
    throw new EventTriggerError("事件名不能为空且不超过 100 字符（只允许字母、数字、点、下划线、连字符）");
  }
  if (typeof trigger.task !== "string" || !trigger.task.trim() || trigger.task.length > MAX_TASK_CHARS) {
    throw new EventTriggerError("触发任务内容不能为空且不超过 8000 字符");
  }
  const match = (trigger.match ?? undefined) as Record<string, unknown> | undefined;
  if (match !== undefined && (typeof match !== "object" || match === null || Array.isArray(match))) {
    throw new EventTriggerError("匹配条件无效");
  }
  const cleanedMatch: TriggerMatch = {};
  if (match) {
    for (const key of ["from_contains", "subject_contains", "text_contains"] as const) {
      const v = match[key];
      if (v !== undefined && v !== null) {
        if (typeof v !== "string" || !v.trim() || v.length > 200) throw new EventTriggerError(`匹配条件 ${key} 不能为空且不超过 200 字符`);
        cleanedMatch[key] = v;
      }
    }
  }
  const mode = (trigger.mode as string) ?? "auto";
  if (mode !== "readonly" && mode !== "auto") throw new EventTriggerError("事件触发任务只允许 readonly 或 auto（full 拒绝，与定时任务同规则）");
  if (trigger.workdir !== null && trigger.workdir !== undefined && typeof trigger.workdir !== "string") {
    throw new EventTriggerError("工作目录无效");
  }
  const maxTurns = (trigger.max_turns as number) ?? 20;
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new EventTriggerError("--max-turns 必须为正整数");
  }
  const id = typeof trigger.id === "string" && /^[0-9a-f]{16}$/.test(trigger.id)
    ? trigger.id
    : randomBytes(8).toString("hex");
  return {
    id,
    name: trigger.name.trim(),
    source: trigger.source as EventSource,
    event: trigger.event.trim(),
    ...(Object.keys(cleanedMatch).length ? { match: cleanedMatch } : {}),
    task: trigger.task,
    mode: mode as "readonly" | "auto",
    enabled: trigger.enabled !== false,
    ...(trigger.suggested === true ? { suggested: true as const } : {}),
    workdir: (trigger.workdir as string | null) ?? null,
    max_turns: maxTurns,
  };
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
}

export function loadEventTriggers(path?: string): EventTriggerData {
  const p = path ?? eventTriggersPath();
  if (!existsSync(p)) return { triggers: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new EventTriggerError("事件触发器文件损坏，已备份，请检查后重新添加");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).triggers)) {
    backupCorrupt(p);
    throw new EventTriggerError("事件触发器文件格式无效，已备份");
  }
  const triggers: EventTrigger[] = [];
  const names = new Set<string>();
  for (const item of (raw as EventTriggerData).triggers) {
    try {
      const trigger = validateEventTrigger(item as unknown as Record<string, unknown>);
      if (names.has(trigger.name)) throw new EventTriggerError(`已存在同名触发器：${trigger.name}`);
      triggers.push(trigger);
      names.add(trigger.name);
    } catch (err: unknown) {
      process.stderr.write(`跳过无效事件触发器：${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
  }
  return { triggers };
}

export function saveEventTriggers(data: EventTriggerData, path?: string): string {
  const p = path ?? eventTriggersPath();
  atomicWriteJson(p, data);
  return p;
}

export function listEventTriggers(home?: string): EventTrigger[] {
  return [...loadEventTriggers(eventTriggersPath(home)).triggers];
}

/** 供网关 GET /api/event-triggers 消费：不含任务提示词（提示词只在终端看）。 */
export function listEventTriggersPublic(home?: string): Array<Pick<EventTrigger, "id" | "name" | "source" | "event" | "mode" | "enabled" | "suggested">> {
  return listEventTriggers(home).map((t) => ({
    id: t.id, name: t.name, source: t.source, event: t.event, mode: t.mode, enabled: t.enabled,
    ...(t.suggested === true ? { suggested: true as const } : {}),
  }));
}

export function addEventTrigger(data: EventTriggerData, trigger: Record<string, unknown>): EventTrigger {
  const cleaned = validateEventTrigger(trigger);
  if (data.triggers.some((t) => t.name === cleaned.name)) throw new EventTriggerError(`已存在同名触发器：${cleaned.name}`);
  data.triggers.push(cleaned);
  return cleaned;
}

export function removeEventTrigger(data: EventTriggerData, name: string): boolean {
  const idx = data.triggers.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  data.triggers.splice(idx, 1);
  return true;
}

export function setEventTriggerEnabled(data: EventTriggerData, name: string, enabled: boolean): boolean {
  const t = data.triggers.find((x) => x.name === name);
  if (!t) return false;
  t.enabled = enabled;
  return true;
}

// ---- 匹配与提示词 ----

/** 触发器是否命中事件：来源 + 事件名必须相等；匹配条件全部满足才算命中（不区分大小写）。 */
export function matchEventTrigger(trigger: EventTrigger, event: IncomingEvent): boolean {
  if (trigger.enabled === false) return false;
  if (trigger.source !== event.source) return false;
  if (trigger.event !== event.eventType) return false;
  const m = trigger.match;
  if (!m) return true;
  const actor = (event.actor ?? "").toLowerCase();
  const summary = (event.summary ?? "").toLowerCase();
  const text = `${event.summary ?? ""}\n${JSON.stringify(event.payload)}`.toLowerCase();
  if (m.from_contains && !actor.includes(m.from_contains.toLowerCase())) return false;
  if (m.subject_contains && !summary.includes(m.subject_contains.toLowerCase())) return false;
  if (m.text_contains && !text.includes(m.text_contains.toLowerCase())) return false;
  return true;
}

/**
 * 把事件填进触发器的任务模板。占位符：{{event.type}} {{event.source}} {{event.id}}
 * {{event.actor}} {{event.summary}} {{event.payload}}。payload 是外部数据，包
 * wrapUntrusted 再交给模型；摘要只取元数据（发件人/主题前 200 字）。
 */
export function buildTriggerPrompt(trigger: EventTrigger, event: IncomingEvent): string {
  const payloadText = JSON.stringify(event.payload, null, 2).slice(0, MAX_PAYLOAD_CHARS);
  const subs: Record<string, string> = {
    "{{event.type}}": event.eventType,
    "{{event.source}}": event.source,
    "{{event.id}}": event.eventId,
    "{{event.actor}}": event.actor ?? "",
    "{{event.summary}}": (event.summary ?? "").slice(0, MAX_SUMMARY_CHARS),
    "{{event.payload}}": wrapUntrusted(payloadText, `event:${event.source}`),
  };
  let out = trigger.task;
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  return out;
}

// ---- 派发：匹配 → 入队 → 记事件（可审计） ----

export interface DispatchEntry {
  triggerId: string;
  triggerName: string;
  runId?: string;
  reason?: string;
}

export interface DispatchResult {
  dispatched: DispatchEntry[];
  skipped: DispatchEntry[];
}

/** 进程内速率计数：每分钟最多派发 MAX_DISPATCHES_PER_MINUTE 次。 */
const dispatchTimestamps: number[] = [];

export function resetEventDispatchRateLimit(): void {
  dispatchTimestamps.length = 0;
}

function checkDispatchRateLimit(now: number): boolean {
  while (dispatchTimestamps.length && now - dispatchTimestamps[0] > 60_000) dispatchTimestamps.shift();
  return dispatchTimestamps.length < MAX_DISPATCHES_PER_MINUTE;
}

interface DeliveryRecord {
  source: string;
  eventId: string;
  triggerId: string;
  runId: string;
  at: string;
}

function loadDeliveries(home: string): DeliveryRecord[] {
  const p = eventDeliveriesPath(home);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { deliveries?: unknown };
    if (!raw || !Array.isArray(raw.deliveries)) return [];
    return (raw.deliveries as DeliveryRecord[]).filter(
      (d) => d && typeof d.source === "string" && typeof d.eventId === "string"
        && typeof d.triggerId === "string" && typeof d.runId === "string",
    );
  } catch {
    // 投递记录只是幂等账本，不是安全控制：损坏就备份后从空开始，不拦派发。
    backupCorrupt(p);
    return [];
  }
}

function saveDeliveries(home: string, deliveries: DeliveryRecord[]): void {
  atomicWriteJson(eventDeliveriesPath(home), { deliveries: deliveries.slice(-DELIVERY_KEEP) });
}

/** 事件 id 进证据链时过长会被 redact 抹掉（32 字以上的类 token 字符串）：长 id 只记指纹，完整 id 在投递记录里。 */
export function shortEventId(eventId: string): string {
  if (eventId.length <= 24) return eventId;
  return `sha256:${createHash("sha256").update(eventId).digest("hex").slice(0, 16)}`;
}

/**
 * 派发一个事件：命中启用的触发器 → 每个命中写一条任务进队列（readonly/auto，
 * addTask 本身再拦一次 full）→ 在新任务的 events.jsonl 记 `event_triggered`。
 * 同一事件重复投递只派发一次（第二次返回原 run_id，记 skipped/duplicate）。
 */
export function dispatchEvent(event: IncomingEvent, opts?: { home?: string }): DispatchResult {
  const home = opts?.home ?? nyraHome();
  const now = Date.now();
  const result: DispatchResult = { dispatched: [], skipped: [] };
  const triggers = loadEventTriggers(eventTriggersPath(home)).triggers.filter((t) => matchEventTrigger(t, event));
  if (triggers.length > MAX_DISPATCHES_PER_EVENT) {
    for (const t of triggers.slice(MAX_DISPATCHES_PER_EVENT)) {
      result.skipped.push({ triggerId: t.id, triggerName: t.name, reason: "too-many-matches" });
    }
  }
  const targets = triggers.slice(0, MAX_DISPATCHES_PER_EVENT);
  const deliveries = loadDeliveries(home);
  const store = new RunStore(join(nyraHome(home), TASKS_DIR));
  let deliveriesChanged = false;
  for (const trigger of targets) {
    const dup = deliveries.find((d) => d.source === event.source && d.eventId === event.eventId && d.triggerId === trigger.id);
    if (dup) {
      result.skipped.push({ triggerId: trigger.id, triggerName: trigger.name, runId: dup.runId, reason: "duplicate" });
      continue;
    }
    if (!checkDispatchRateLimit(now)) {
      result.skipped.push({ triggerId: trigger.id, triggerName: trigger.name, reason: "rate-limited" });
      continue;
    }
    const prompt = buildTriggerPrompt(trigger, event);
    const state = addTask(prompt, {
      workdir: trigger.workdir ?? process.cwd(),
      mode: trigger.mode,
      maxTurns: trigger.max_turns,
      home,
    });
    store.appendEvent(state.run_id, "event_triggered", {
      trigger_id: trigger.id,
      trigger_name: trigger.name,
      source: event.source,
      event_id: shortEventId(event.eventId),
      event_type: event.eventType,
      run_id: state.run_id,
      mode: trigger.mode,
      auth: event.auth ?? "none",
    });
    dispatchTimestamps.push(now);
    deliveries.push({ source: event.source, eventId: event.eventId, triggerId: trigger.id, runId: state.run_id, at: new Date(now).toISOString() });
    deliveriesChanged = true;
    result.dispatched.push({ triggerId: trigger.id, triggerName: trigger.name, runId: state.run_id });
  }
  if (deliveriesChanged) {
    try { saveDeliveries(home, deliveries); } catch (err: unknown) {
      process.stderr.write(`投递记录保存失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return result;
}

// ---- webhook：验签与事件归一化 ----

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 验 webhook 签名。密钥只存密码箱（`nyra vault add webhook-secret-github` /
 * `webhook-secret-slack`，交互输入），不进配置文件、不进日志。
 * 没配密钥时该来源直接 503——不静默放行无签名的外部事件。
 */
export function verifyWebhookSignature(
  source: "github" | "slack",
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  home: string,
): { auth: string } {
  if (source === "github") {
    const secret = getCredential("webhook-secret-github", home);
    if (!secret) throw new WebhookError(503, "未配置 webhook 密钥：先运行 nyra vault add webhook-secret-github（网关须带 NYRA_VAULT_PASSWORD 启动）");
    const sig = headerValue(headers, "x-hub-signature-256") ?? "";
    if (!sig.startsWith("sha256=") || !safeEqualHex(sig.slice("sha256=".length), hmacHex(secret, rawBody))) {
      throw new WebhookError(401, "GitHub webhook 签名无效");
    }
    return { auth: "hmac-github" };
  }
  const secret = getCredential("webhook-secret-slack", home);
  if (!secret) throw new WebhookError(503, "未配置 webhook 密钥：先运行 nyra vault add webhook-secret-slack（网关须带 NYRA_VAULT_PASSWORD 启动）");
  const ts = headerValue(headers, "x-slack-request-timestamp") ?? "";
  const tsNum = Number(ts);
  if (!ts || !Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    throw new WebhookError(401, "Slack webhook 时间戳无效或过期（超过 5 分钟）");
  }
  const sig = headerValue(headers, "x-slack-signature") ?? "";
  if (!sig.startsWith("v0=") || !safeEqualHex(sig.slice(3), hmacHex(secret, `v0:${ts}:${rawBody.toString("utf-8")}`))) {
    throw new WebhookError(401, "Slack webhook 签名无效");
  }
  return { auth: "hmac-slack" };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * 把各家 webhook 的 body 归一化成 IncomingEvent。
 * Slack 的 url_verification 不是事件：返回 { challenge }，网关直接回 challenge，不派发。
 */
export function normalizeWebhookEvent(
  source: WebhookSource,
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): { event: IncomingEvent } | { challenge: string } {
  const fallbackId = sha256Hex(rawBody).slice(0, 32);
  if (source === "github") {
    const sender = asRecord(body.sender);
    const pusher = asRecord(body.pusher);
    const repo = asRecord(body.repository);
    return {
      event: {
        source: "webhook",
        eventType: `github.${headerValue(headers, "x-github-event") ?? "unknown"}`,
        eventId: headerValue(headers, "x-github-delivery") ?? fallbackId,
        receivedAt: new Date().toISOString(),
        actor: asString(sender?.login) ?? asString(pusher?.name),
        summary: `${asString(repo?.full_name) ?? "?"} ${asString(body.action) ?? ""}`.trim().slice(0, MAX_SUMMARY_CHARS),
        payload: body,
      },
    };
  }
  if (source === "slack") {
    if (body.type === "url_verification") return { challenge: String(body.challenge ?? "") };
    const ev = asRecord(body.event);
    return {
      event: {
        source: "webhook",
        eventType: `slack.${asString(ev?.type) ?? "unknown"}`,
        eventId: asString(body.event_id) ?? fallbackId,
        receivedAt: new Date().toISOString(),
        actor: asString(ev?.user) ?? asString(body.team_id),
        summary: (asString(ev?.text) ?? "").slice(0, MAX_SUMMARY_CHARS),
        payload: body,
      },
    };
  }
  const type = headerValue(headers, "x-nyra-event")
    ?? asString(body.event) ?? asString(body.type) ?? asString(body.event_type);
  if (!type) throw new EventTriggerError("通用 webhook 缺少事件类型（X-Nyra-Event 请求头或 body 里的 event/type 字段）");
  return {
    event: {
      source: "webhook",
      eventType: type,
      eventId: headerValue(headers, "x-nyra-event-id") ?? asString(body.event_id) ?? asString(body.id) ?? fallbackId,
      receivedAt: new Date().toISOString(),
      actor: asString(body.actor) ?? asString(asRecord(body.sender)?.login),
      summary: (asString(body.summary) ?? asString(body.text) ?? "").slice(0, MAX_SUMMARY_CHARS),
      payload: body,
    },
  };
}

// ---- 应用事件源：Gmail 新邮件轮询 ----

export interface GmailPollState {
  lastPollAt: string | null;
  seenIds: string[];
}

export interface GmailPollResult {
  checked: number;
  newMail: number;
  dispatched: number;
  skipped: string | null;
}

export function loadGmailPollState(home: string): GmailPollState {
  const p = gmailPollStatePath(home);
  if (!existsSync(p)) return { lastPollAt: null, seenIds: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<GmailPollState>;
    return {
      lastPollAt: typeof raw.lastPollAt === "string" ? raw.lastPollAt : null,
      seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    backupCorrupt(p);
    return { lastPollAt: null, seenIds: [] };
  }
}

export function saveGmailPollState(home: string, state: GmailPollState): void {
  atomicWriteJson(gmailPollStatePath(home), state);
}

function gmailAfterDate(d: Date): string {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 轮询一次 Gmail 收件箱，把没见过的新邮件按 `gmail.new_mail` 事件派发。
 * 首轮只建基线（把当前收件箱记为已见，不派发），否则首次启用会把当天旧邮件全派一遍。
 * 未到轮询间隔直接返回 not-due（守护进程每轮都调，但不频繁打 API）；CLI `--once` 用 force。
 */
export async function pollGmailTriggers(
  transport: import("./connectors/gmail.ts").GmailTransport,
  opts: { home: string; now?: Date; force?: boolean },
): Promise<GmailPollResult> {
  const home = opts.home;
  const now = opts.now ?? new Date();
  const gmailTriggers = loadEventTriggers(eventTriggersPath(home)).triggers
    .filter((t) => t.enabled !== false && t.source === "gmail");
  if (!gmailTriggers.length) return { checked: 0, newMail: 0, dispatched: 0, skipped: "no-enabled-gmail-trigger" };
  const state = loadGmailPollState(home);
  if (!opts.force && state.lastPollAt) {
    const last = Date.parse(state.lastPollAt);
    if (!Number.isNaN(last) && now.getTime() - last < GMAIL_POLL_INTERVAL_SECONDS * 1000) {
      return { checked: 0, newMail: 0, dispatched: 0, skipped: "not-due" };
    }
  }
  const base = state.lastPollAt ? new Date(Date.parse(state.lastPollAt) - 86_400_000) : now;
  const { messages } = await transport.search(`in:inbox after:${gmailAfterDate(base)}`, 25);
  const seen = new Set(state.seenIds);
  const unseen = messages.filter((m) => !seen.has(m.id));
  if (state.lastPollAt === null) {
    // 首轮建基线：不派发，只记已见。
    saveGmailPollState(home, {
      lastPollAt: now.toISOString(),
      seenIds: [...new Set([...state.seenIds, ...messages.map((m) => m.id)])].slice(-GMAIL_SEEN_KEEP),
    });
    return { checked: messages.length, newMail: unseen.length, dispatched: 0, skipped: "first-run-baseline" };
  }
  let dispatched = 0;
  for (const m of unseen) {
    const event: IncomingEvent = {
      source: "gmail",
      eventType: "gmail.new_mail",
      eventId: m.id,
      receivedAt: now.toISOString(),
      actor: m.from,
      summary: `${m.subject} — ${m.snippet}`.slice(0, MAX_SUMMARY_CHARS),
      payload: {
        id: m.id, threadId: m.threadId, from: m.from, to: m.to,
        subject: m.subject, date: m.date, snippet: m.snippet, labels: m.labels ?? [],
      },
      auth: "gmail-oauth",
    };
    const result = dispatchEvent(event, { home });
    dispatched += result.dispatched.length;
    // 缺口 25 的尾巴：同名事件的工作流触发器也跑一遍（全局开关关着直接跳过；
    // 触发失败只记 stderr，不破坏轮询）。
    try {
      const { fireWorkflowEventTriggers } = await import("./workflowTriggers.ts");
      await fireWorkflowEventTriggers(home, event);
    } catch (err: unknown) {
      process.stderr.write(`工作流事件触发失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  saveGmailPollState(home, {
    lastPollAt: now.toISOString(),
    seenIds: [...new Set([...state.seenIds, ...messages.map((m) => m.id)])].slice(-GMAIL_SEEN_KEEP),
  });
  return { checked: messages.length, newMail: unseen.length, dispatched, skipped: null };
}
