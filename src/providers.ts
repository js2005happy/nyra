// src/providers.ts — 模型 provider，与 Python 版 nyra/providers.py 同语义。
// 14 个 OpenAI 兼容 HTTP provider + Codex CLI provider + 兜底链 + 多 Key 轮换。
// 安全线：401/403 兜底不切换（换模型修不好认证）；多 Key 轮换时 401/403 也轮换，
// 且报错绝不带 Key 值（两层 redact）；Codex 直接构造拒绝、定时任务禁用。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plaintextHttpError, resolveProvider, type ResolvedProvider } from "./config.ts";
import { applyStrictToTools, resolveStrictTools } from "./toolStrict.ts";
import { cancelErrorFromSignal, combineSignals } from "./cancel.ts";
import { buildQuotaHandoff, type QuotaHandoff } from "./quotaHandoff.ts";
import { filterHealthyChain, markDegraded } from "./modelHealth.ts";
// 子进程环境白名单（第四份审计 P0）：childEnv.ts 是叶模块，只引 node 内置。
import { buildChildEnv } from "./childEnv.ts";

export const RECOVERABLE_KINDS = ["quota", "rate_limit", "server", "timeout", "network"] as const;
export type ProviderErrorKind =
  | "auth" | "quota" | "rate_limit" | "server" | "client"
  | "timeout" | "network" | "config" | "parse" | "redirect" | "unknown";

export class ProviderError extends Error {
  status: number | null;
  kind: ProviderErrorKind;
  /**
   * 缺口 20：服务端通过 Retry-After 告诉我们的等待毫秒数（null = 没给）。
   * 只在 HTTP 层解析出来才有；重试时与客户端退避取最大值，不凭空编等待时间。
   */
  retryAfterMs: number | null;
  constructor(message: string, opts?: { status?: number | null; kind?: ProviderErrorKind; retryAfterMs?: number | null }) {
    super(message);
    this.name = "ProviderError";
    this.status = opts?.status ?? null;
    this.kind = opts?.kind ?? "unknown";
    this.retryAfterMs = opts?.retryAfterMs ?? null;
  }
  get recoverable(): boolean {
    return (RECOVERABLE_KINDS as readonly string[]).includes(this.kind);
  }
}

export function isRecoverableProviderError(exc: unknown): boolean {
  return exc instanceof ProviderError && exc.recoverable;
}

export function kindForStatus(code: number): ProviderErrorKind {
  if (code === 401 || code === 403) return "auth";
  if (code === 402) return "quota";
  if (code === 429) return "rate_limit";
  if (code >= 500 && code < 600) return "server";
  if (code >= 400 && code < 500) return "client";
  return "server";
}

export function httpError(code: number, body: string, action = "API 请求", retryAfterMs?: number | null): ProviderError {
  // 用量上限文本优先于状态码：429 措辞像 rate limit 也可能是用量上限。
  const kind = classifyHttpError(code, body);
  let message: string;
  if (kind === "auth") message = `认证失败 (HTTP ${code})：API Key 无效或无权限，请检查凭证。详情：${body}`;
  else if (kind === "quota" && code === 402) message = `余额不足 (HTTP 402)：请充值后再试。详情：${body}`;
  else if (kind === "quota") message = `用量上限 (HTTP ${code})：已达到用量上限，请充值或等额度恢复后再试，不要重复重试。详情：${body}`;
  else if (kind === "rate_limit") message = `请求过于频繁 (HTTP 429)：请稍后再试。详情：${body}`;
  else message = `${action}失败 (HTTP ${code})：${body}`;
  return new ProviderError(message, { status: code, kind, retryAfterMs: retryAfterMs ?? null });
}

/**
 * 缺口 20：解析 Retry-After 响应头。秒数（delay-seconds）或 HTTP-date 都认；
 * 无效值返回 null（不猜）；等待时间封顶 10 分钟——服务端让等更久时，
 * 宁可按 10 分钟重试一次、由下一轮重试再看，也不在一次睡眠里无上限地等。
 */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(600_000, Math.max(0, Math.floor(seconds * 1000)));
  }
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(600_000, Math.max(0, dateMs - nowMs));
}

// ---- 错误分类 + 幂等重试 + 退避（OpenMausBot C 项：retry.ts 的思路，
// TypeScript 重写，未复制对方代码）----

/**
 * 用量上限类消息文本（小写子串匹配）。关键细节：用量上限即使措辞像
 * rate limit（例如 429 + "You've hit your weekly limit"）也判终结——
 * 终结模式先于瞬时模式匹配，绝不重试、绝不靠重试去烧钱。
 */
export const QUOTA_MESSAGE_PATTERNS = [
  "weekly limit", "monthly limit", "daily limit", "usage limit",
  "out of usage credits", "out of credits", "credits exhausted",
  "quota exceeded", "quota_exceeded", "insufficient quota", "insufficient_quota",
  "exceeded your quota",
  "you've hit your", "you have hit your", "hit your limit",
  "billing limit", "insufficient balance", "credit balance",
  "用量上限", "用量已用完", "额度已用完", "余额不足", "免费额度已用完",
  "配额不足", "配额已用完", "配额耗尽", "额度不足", "额度耗尽", "额度用尽",
];

/**
 * Kooyu 429 接力：限流类消息文本（英文原样 + 中文，见 quotaHandoff.ts 的
 * RATE_LIMIT_MESSAGE_PATTERNS 同款表）。命中即“这次失败与限流/配额有关”，
 * 但不分 quota 还是 rate_limit——分档仍由 QUOTA_MESSAGE_PATTERNS 先判
 * （终结：用量上限），本表只用来把“状态码不是 429、但文案明说限流”的
 * 错误（例如 503 + "capacity exhausted"、500 + "overloaded"）也认成
 * rate_limit，而不是笼统的 server：前者重试同一家、切换时配接力摘要，
 * 后者没有这个待遇。
 */
export const RATE_LIMIT_MESSAGE_PATTERNS = [
  "429", "rate limit", "rate_limit", "too many requests",
  "quota exceeded", "quota_exceeded", "usage limit",
  "capacity exhausted", "overloaded", "credit balance",
  "insufficient_quota", "insufficient quota",
  "限流", "配额", "过于频繁", "额度用尽", "额度不足", "额度耗尽", "额度已用完",
];

/** 安全拦截类消息文本：provider 安全拦截绝不重放。 */
export const SAFETY_BLOCK_PATTERNS = [
  "safety", "content filter", "content_filter", "blocked by safety",
  "安全拦截", "内容安全", "违反内容政策",
];

/** 用户中断类消息文本：用户叫停时立即取消，不让重发活过用户的停止。 */
export const USER_INTERRUPT_PATTERNS = [
  "aborted by user", "cancelled by user", "canceled by user",
  "用户已取消", "用户取消", "用户中断",
];

/** 未知模型类消息文本：换模型修不好，绝不重试。 */
export const UNKNOWN_MODEL_PATTERNS = [
  "model_not_found", "unknown model", "model is not supported",
  "model not found", "模型不存在", "未知模型",
];

function matchesAnyPattern(text: string, patterns: string[]): boolean {
  const lowered = (text || "").toLowerCase();
  return patterns.some((p) => lowered.includes(p));
}

export function matchesQuotaMessage(text: string): boolean {
  return matchesAnyPattern(text, QUOTA_MESSAGE_PATTERNS);
}

export function matchesSafetyBlock(text: string): boolean {
  return matchesAnyPattern(text, SAFETY_BLOCK_PATTERNS);
}

/** 这段报错文本是不是限流/配额类（Kooyu 正则的 Nyra 版）。 */
export function matchesRateLimitMessage(text: string): boolean {
  return matchesAnyPattern(text, RATE_LIMIT_MESSAGE_PATTERNS);
}

/**
 * HTTP 错误分类：先看消息文本里的用量上限模式，再看限流模式，最后按状态码。
 * kindForStatus 本身不动（只按状态码），供只需要状态码的调用方用。
 */
export function classifyHttpError(code: number, body: string): ProviderErrorKind {
  if (matchesQuotaMessage(body)) return "quota";
  if (matchesRateLimitMessage(body)) return "rate_limit";
  return kindForStatus(code);
}

/** 可重试的瞬时错误 kind：429 / 过载 / 5xx / 连接重置 / 超时。 */
export const TRANSIENT_KINDS = ["rate_limit", "server", "timeout", "network"] as const;

/** 同一 provider 失败时先重试的次数上限（不含首次调用）。 */
export const MAX_SAME_PROVIDER_RETRIES = 2;
/** 同一 provider 重试的退避基数（毫秒）：1s / 3s，再加 ±25% 抖动。 */
export const PROVIDER_RETRY_BACKOFF_MS = [1000, 3000] as const;

/**
 * 只有瞬时错误可重试。终结错误绝不重试：用量上限（即使 kind 是
 * rate_limit、即使状态码是 429，消息文本优先）、认证、未知模型、
 * 无效请求、404、用户中断、安全拦截。
 */
export function isTransientProviderError(exc: unknown): boolean {
  if (!(exc instanceof ProviderError)) return false;
  const text = exc.message ?? "";
  if (matchesQuotaMessage(text)) return false;
  if (matchesSafetyBlock(text)) return false;
  if (matchesAnyPattern(text, USER_INTERRUPT_PATTERNS)) return false;
  if (matchesAnyPattern(text, UNKNOWN_MODEL_PATTERNS)) return false;
  return (TRANSIENT_KINDS as readonly string[]).includes(exc.kind);
}

/** 退避抖动：基数 ±25%（Math.random 可注入，供测试定住）。 */
export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  return baseMs * (0.75 + random() * 0.5);
}

/** 第 attempt 次重试（0 起）的退避毫秒数。 */
export function providerRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = PROVIDER_RETRY_BACKOFF_MS[Math.min(attempt, PROVIDER_RETRY_BACKOFF_MS.length - 1)] ?? 1000;
  return jitteredDelayMs(base, random);
}

/** 可中断的睡眠：signal 已 abort 时立即拒绝，不让重发活过用户的停止。 */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 单次模型调用默认超时（秒）。第 4 阶段由 120 收紧到 60：假 Key/挂起的
 * 端点不再等满 120 秒才报错；推理模型一次调用超过 60 秒时用
 * NYRA_PROVIDER_TIMEOUT 调大（10–600 秒）。 */
export const DEFAULT_CHAT_TIMEOUT = 60;
export const DEFAULT_LIST_TIMEOUT = 30;

export function resolveChatTimeout(): number {
  const raw = process.env.NYRA_PROVIDER_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAT_TIMEOUT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_CHAT_TIMEOUT;
  return Math.min(600, Math.max(10, n));
}

export function normalizeMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const content = message.content;
    if (Array.isArray(content)) {
      const parts = content.filter((p) => p && typeof p === "object" && "type" in (p as Record<string, unknown>));
      return { ...message, content: parts };
    }
    if (typeof content === "string" || content === null || content === undefined) return message;
    return { ...message, content: String(content) };
  });
}

export interface ChatMessage {
  role: string;
  content: string | Record<string, unknown>[] | null;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ProviderLike {
  name: string;
  model: string;
  baseUrl: string;
  hasCredentials(): boolean;
  /** opts.signal：取消信号。abort 时在途请求断开并抛 CancelError（不是
   * 超时、不是网络错）——调用方靠它认出“这是取消”。不传时行为与原来一致。 */
  chat(messages: ChatMessage[], tools?: Record<string, unknown>[] | null, timeout?: number, opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  listModels(timeout?: number): Promise<string[]>;
  redact(text: string): string;
}

export class Provider implements ProviderLike {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  auth: string;
  connectorName: string | null;
  allowedHosts: string[];
  /** 工具级 strict 开关（十年清单第 4 项）：构造时由 provider 名 + 预置
   * strictTools 经 resolveStrictTools 算出；见 src/toolStrict.ts。 */
  strictTools: boolean;

  constructor(cfg: ResolvedProvider) {
    // CLI provider 禁止直接构造（Python 版 __new__ 守卫）：定时任务与队列
    // 不得使用 CLI provider；交互使用请走 buildProviderChain。
    if (cfg.auth === "cli") {
      throw new ProviderError(
        "Codex CLI provider 不能直接构造：定时任务与队列不得使用 CLI provider；交互使用请走 buildProviderChain 显式选用 --provider codex",
        { kind: "config" },
      );
    }
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.auth = cfg.auth;
    this.connectorName = cfg.connectorName;
    this.allowedHosts = cfg.allowedHosts;
    this.strictTools = resolveStrictTools(cfg.name, cfg.preset?.strictTools);
  }

  hasCredentials(): boolean {
    try {
      if (this.auth === "none") return true;
      if (this.apiKey !== null) return true;
      if (this.auth === "connector") {
        // Node 版第 2 阶段未接连接器凭证注入（doctor 已如实说明）：
        // 连接器 auth 在 Node 侧视为无可用凭证，不静默发无认证请求。
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  redact(text: string, authorizationHeader?: string): string {
    const secrets = new Set<string>();
    if (this.apiKey) secrets.add(this.apiKey);
    if (authorizationHeader) {
      secrets.add(authorizationHeader);
      const parts = authorizationHeader.split(/\s+/, 2);
      if (parts.length === 2 && parts[1]) secrets.add(parts[1]);
    }
    let out = text;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("[已隐藏]");
    }
    return out;
  }

  /**
   * H5：凭证类型纪律——模型流量只用这一种认证头：`Authorization: Bearer <API Key>`。
   * 本树没有 Anthropic/Google 原生 provider，所有预置都是 OpenAI 兼容 base，
   * 所以不存在“某家该用 x-api-key、某家该用 x-goog-api-key”的分叉，也就没有
   * 发错头的余地（Hermes 的 Gemini/Anthropic 探针 bug 就是分叉发错头）。
   * 凭据只从 resolveProvider 来：env 变量（preset.envKey 点名）、API_KEY、
   * 密码箱/keys.json 里与 preset.envKey 同名的条目——OAuth token 各有各的
   * 家（GitHub access token 在账号会话库里、Gmail token 在密码箱 gmail-oauth
   * 条目下、OAuth 客户端在 oauth-github-client / gmail-oauth-client 条目下），
   * 异名条目永远不会被当成模型 Key 读出来；模型 Key 的两个入口（网关测
   * Key、界面保存 Key）用 validateProviderKey 拦住 OAuth 形状的串（见
   * keystore.ts）。注意：通用的 setKey 不拦——Bot 电脑凭证存的就是任意
   * 账号 secret，GitHub PAT（ghp_…）是合法的电脑凭证。
   * 以后要接原生 Anthropic/Google 时，先在这里加“按 provider 选头”的
   * 唯一映射表 + 测试，不许在调用处各写各的头。
   */
  private applyAuth(headers: Record<string, string>): void {
    if (this.auth === "env") {
      if (this.apiKey === null) {
        throw new ProviderError(`provider ${this.name} 未设置 API Key，请设置对应的环境变量 API Key 后重试`, { kind: "config" });
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else if (this.auth === "connector") {
      throw new ProviderError("无法使用已保存的连接器凭证，请检查连接器配置或设置环境变量 API Key 后重试", { kind: "config" });
    } else if (this.auth === "none") {
      // 不加认证头。
    } else {
      throw new ProviderError("该 provider 的认证方式无效", { kind: "config" });
    }
  }

  private async postJson(url: string, payload: unknown, timeout: number, action: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const err = plaintextHttpError(this.name, this.baseUrl);
    if (err !== null) throw new ProviderError(err, { kind: "config" });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    this.applyAuth(headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    // 可靠性打磨第 1 项第一批：外部取消信号与内部超时信号合并——任一
    // abort，请求就断。外部 abort 抛 CancelError（不是超时），调用方
    // 靠它认出“这是取消，不是超时/网络错”。
    const combined = signal ? combineSignals([signal, controller.signal]) : controller.signal;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: combined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (signal?.aborted) throw cancelErrorFromSignal(signal, "stop");
      if ((e as Error)?.name === "AbortError" || /aborted|timeout/i.test(msg)) {
        throw new ProviderError("API 请求超时，请稍后重试", { kind: "timeout" });
      }
      throw new ProviderError(this.redact(`网络错误，无法连接到 ${this.baseUrl}：${msg}`, headers.Authorization), { kind: "network" });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError("API 请求被重定向，已拒绝", { kind: "redirect" });
    }
    const rawBody = await response.text();
    if (!response.ok) {
      const body = this.redact(rawBody, headers.Authorization).slice(0, 1000);
      // 缺口 20：429/503 的 Retry-After 读出来交给重试层（没有也不编）。
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      throw httpError(response.status, body, action, retryAfterMs);
    }
    let result: unknown;
    try {
      result = JSON.parse(rawBody);
    } catch {
      throw new ProviderError("API 返回了无法解析的响应", { kind: "parse" });
    }
    if (!result || typeof result !== "object") {
      throw new ProviderError("API 返回了无法解析的响应", { kind: "parse" });
    }
    return result as Record<string, unknown>;
  }

  async chat(messages: ChatMessage[], tools?: Record<string, unknown>[] | null, timeout = resolveChatTimeout(), opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: normalizeMessages(messages as Record<string, unknown>[]),
    };
    // 十年清单第 4 项：支持 strict 的 provider 发 strict 工具（schema 已
    // 归一化成 strict 子集）；不支持的原样发，靠 agent 侧二次校验＋一次重试。
    if (tools !== null && tools !== undefined) payload.tools = applyStrictToTools(this.name, this.strictTools, tools);
    // 推理档位 / 冗长度（config.reasoning_effort / verbosity）。未配置时这里是空对象，
    // payload 与改动前逐字节一致——零配置零影响。
    Object.assign(payload, this.extraBody ?? {});
    return this.postJson(`${this.baseUrl}/chat/completions`, payload, timeout, "API 请求", opts?.signal);
  }

  /** 附加到每次 chat 请求体的字段（推理档位等）。未设置则不加任何键。 */
  extraBody?: Record<string, unknown>;

  async listModels(timeout = 30): Promise<string[]> {
    const err = plaintextHttpError(this.name, this.baseUrl);
    if (err !== null) throw new ProviderError(err, { kind: "config" });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    this.applyAuth(headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models`, {
        method: "GET", headers, redirect: "manual", signal: controller.signal,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as Error)?.name === "AbortError") throw new ProviderError("API 请求超时，请稍后重试", { kind: "timeout" });
      throw new ProviderError(this.redact(`网络错误，无法连接到 ${this.baseUrl}：${msg}`, headers.Authorization), { kind: "network" });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError("API 请求被重定向，已拒绝", { kind: "redirect" });
    }
    const rawBody = await response.text();
    if (!response.ok) {
      const body = this.redact(rawBody, headers.Authorization).slice(0, 1000);
      throw httpError(response.status, body, "列出模型");
    }
    let result: unknown;
    try {
      result = JSON.parse(rawBody);
    } catch {
      throw new ProviderError("API 返回了无法解析的响应", { kind: "parse" });
    }
    if (!result || typeof result !== "object" || !Array.isArray((result as Record<string, unknown>).data)) {
      throw new ProviderError("API 返回了无法解析的模型列表", { kind: "parse" });
    }
    const models: string[] = [];
    for (const item of (result as Record<string, unknown>).data as unknown[]) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
        models.push((item as Record<string, unknown>).id as string);
      }
    }
    return models;
  }
}

// ---- Codex CLI provider ----
export const CODEX_PROMPT_PREFIX =
  "You are Nyra, a text-only assistant. Reply in the user's language, " +
  "concisely and directly. Do not call tools, run commands, browse the " +
  "web, or modify files. Answer with text only.\n\n";
export const CODEX_MIN_VERSION: [number, number, number] = [0, 164, 0];
export const CODEX_DEFAULT_MODEL = "codex-default";
export const CODEX_FORBIDDEN_ARGS = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--approve-for-me",
  "--dangerously-bypass-hook-trust",
  "-y",
  "--full-auto",
]);

const CODEX_BINARY_CANDIDATES = [
  "/opt/hatch-image/bin/codex",
  join(process.env.HOME ?? "", ".local/bin/codex"),
  "/usr/local/bin/codex",
  "/usr/bin/codex",
];

let codexBinaryCache: string | null = null;
let codexBinaryChecked = false;
let codexAvailableCache: boolean | null = null;

export function resetCodexCache(): void {
  codexBinaryCache = null;
  codexBinaryChecked = false;
  codexAvailableCache = null;
}

export function findCodexBinary(binaryOverride?: string): string {
  if (codexBinaryChecked) {
    if (codexBinaryCache === null) throw new ProviderError("未找到 Codex CLI，请先安装 Codex 后重试", { kind: "config" });
    return codexBinaryCache;
  }
  codexBinaryChecked = true;
  // 只接受显式路径（固定候选路径或调用方传的 override）：不再去 PATH 里
  // which codex——PATH 里的同名程序可能是别人放的（第四份审计 P0）。
  // 没配路径又不在候选位置就报错，而不是静默用一个来路不明的二进制。
  const candidates = binaryOverride ? [binaryOverride] : CODEX_BINARY_CANDIDATES;
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      codexBinaryCache = candidate;
      return candidate;
    }
  }
  throw new ProviderError("未找到 Codex CLI，请先安装 Codex 后重试", { kind: "config" });
}

export function parseCodexVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || "");
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

export function codexAvailable(): boolean {
  if (codexAvailableCache !== null) return codexAvailableCache;
  let ok = false;
  try {
    const binary = findCodexBinary();
    const version = spawnSync(binary, ["--version"], { encoding: "utf-8", timeout: 30000 });
    const parsed = parseCodexVersion(version.stdout || "");
    if (version.status === 0 && parsed && versionAtLeast(parsed, CODEX_MIN_VERSION)) {
      // 只读退出码 + "Logged in" 标记；绝不打开、复制或记录任何凭据文件。
      const login = spawnSync(binary, ["login", "status"], { encoding: "utf-8", timeout: 30000 });
      const loginText = (login.stdout || "") + (login.stderr || "");
      ok = login.status === 0 && loginText.includes("Logged in");
    }
  } catch {
    ok = false;
  }
  codexAvailableCache = ok;
  return ok;
}

export function serializeCodexPrompt(messages: ChatMessage[]): string {
  const parts = [CODEX_PROMPT_PREFIX];
  for (const message of messages ?? []) {
    const role = String((message as Record<string, unknown>).role ?? "user");
    let content = (message as Record<string, unknown>).content as unknown;
    if (Array.isArray(content)) {
      content = content.filter((p) => p && typeof p === "object").map((p) => String((p as Record<string, unknown>).text ?? "")).join("\n");
    } else if (content === null || content === undefined) {
      content = "";
    } else {
      content = String(content);
    }
    parts.push(`[${role}]\n${content}\n`);
  }
  return parts.join("\n");
}

const CODEX_AUTH_MARKERS = ["not logged in", "login required", "authentication", "unauthorized", "invalid api key"];
const CODEX_QUOTA_MARKERS = ["usage limit", "out of credits", "credits exhausted", "quota exceeded", "weekly limit", "monthly limit", "usage credits"];
const CODEX_RATE_MARKERS = ["rate limit", "rate_limit", "too many requests", "429"];
const CODEX_CONFIG_MARKERS = ["model_not_found", "model is not supported", "unknown model"];
const CODEX_NETWORK_MARKERS = ["network", "connection", "econnrefused", "dns", "econnreset", "broken pipe"];

export function classifyCodexError(text: string): ProviderErrorKind {
  const lowered = (text || "").toLowerCase();
  if (CODEX_AUTH_MARKERS.some((m) => lowered.includes(m))) return "auth";
  if (CODEX_QUOTA_MARKERS.some((m) => lowered.includes(m))) return "quota";
  if (CODEX_RATE_MARKERS.some((m) => lowered.includes(m))) return "rate_limit";
  if (CODEX_CONFIG_MARKERS.some((m) => lowered.includes(m))) return "config";
  if (CODEX_NETWORK_MARKERS.some((m) => lowered.includes(m))) return "network";
  if (lowered.includes("timed out") || lowered.includes("timeout")) return "timeout";
  return "unknown";
}

export function eventMessageText(event: Record<string, unknown>): string | null {
  const eventType = String(event.type ?? "");
  if (!eventType.includes("message") && !eventType.includes("text")) return null;
  for (const key of ["message", "text", "content"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).text ?? (value as Record<string, unknown>).content;
      if (typeof nested === "string" && nested.trim()) return nested;
    }
  }
  return null;
}

export function lastMessageFromJsonl(text: string): string | null {
  let last: string | null = null;
  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (!event || typeof event !== "object") continue;
      const msg = eventMessageText(event);
      if (msg) last = msg;
    } catch { /* ignore */ }
  }
  return last;
}

export function usageFromJsonl(text: string): Record<string, number> | null {
  let usage: Record<string, unknown> | null = null;
  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (!event || typeof event !== "object") continue;
      const candidate = event.usage;
      if (candidate && typeof candidate === "object") usage = candidate as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  if (!usage) return null;
  const out: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"]) {
    const v = usage[key];
    if (typeof v === "number" && Number.isInteger(v)) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function codexChildEnv(): Record<string, string> {
  // 白名单环境（第四份审计 P0）：只传 PATH/HOME/语言/代理等白名单变量。
  // 旧版只去 *_API_KEY，GITHUB_TOKEN 等仍会漏进 Codex 子进程。
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(buildChildEnv())) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function buildCodexArgv(binary: string, model: string, outputFile: string, workdir: string): string[] {
  const argv = [
    binary, "exec", "--json", "-o", outputFile, "-s", "read-only", "-C", workdir,
    "--ephemeral", "--skip-git-repo-check",
    "-c", "features.browser_use=false",
    "-c", "features.computer_use=false",
    "-c", "features.plugins=false",
  ];
  if (model !== CODEX_DEFAULT_MODEL) argv.splice(2, 0, "-m", model);
  for (const arg of argv) {
    if (CODEX_FORBIDDEN_ARGS.has(arg)) {
      throw new ProviderError("Codex 调用包含禁用的审批跳过参数，已拒绝", { kind: "config" });
    }
  }
  return argv;
}

export class CliProvider implements ProviderLike {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: null = null;
  auth = "cli";
  connectorName: null = null;
  allowedHosts: string[] = [];

  constructor(cfg: ResolvedProvider) {
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl;
    this.model = cfg.model;
  }

  hasCredentials(): boolean {
    return codexAvailable();
  }

  redact(text: string): string {
    return text;
  }

  async listModels(_timeout = 30): Promise<string[]> {
    return [this.model];
  }

  async chat(messages: ChatMessage[], _tools?: Record<string, unknown>[] | null, timeout = resolveChatTimeout(), opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const binary = findCodexBinary();
    if (!codexAvailable()) {
      const minimum = CODEX_MIN_VERSION.join(".");
      throw new ProviderError(`Codex CLI 未登录或版本过低，请先在 Codex 里登录并升级到 ${minimum} 或更高版本后重试`, { kind: "config" });
    }
    const prompt = serializeCodexPrompt(messages);
    const workdir = mkdtempSync(join(tmpdir(), "nyra-codex-"));
    const outputFile = join(workdir, "last_message.txt");
    const argv = buildCodexArgv(binary, this.model, outputFile, workdir);
    const [bin, ...args] = argv;
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn(bin, args, {
          cwd: workdir, env: codexChildEnv(), detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, timeout * 1000);
        // 可靠性打磨第 1 项第一批：外部取消信号 abort 时杀掉整个子进程
        // 组（与超时同款 killTree），close 回来后以 CancelError 拒绝，
        // 不把“被取消”当成“调用失败”重试。
        let cancelled = false;
        const onAbort = (): void => {
          cancelled = true;
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        if (opts?.signal) {
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
        child.on("error", () => {
          clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          resolvePromise({ code: 1, stdout, stderr: stderr || "无法启动 Codex CLI", timedOut, cancelled } as never);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", onAbort);
          resolvePromise({ code, stdout, stderr, timedOut, cancelled } as never);
        });
        child.stdin?.end(prompt);
        void timedOut;
      });
      const cancelled = (result as unknown as { cancelled?: boolean }).cancelled;
      if (cancelled) throw cancelErrorFromSignal(opts!.signal!, "stop");
      const timedOut = (result as unknown as { timedOut?: boolean }).timedOut;
      if (timedOut) {
        throw new ProviderError("Codex CLI 调用超时，请稍后重试", { kind: "timeout" });
      }
      let outputText = "";
      try {
        outputText = readFileSync(outputFile, "utf-8").trim();
      } catch { outputText = ""; }
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").slice(0, 1000);
        throw new ProviderError(`Codex CLI 调用失败（退出码 ${result.code}）：${detail}`, { kind: classifyCodexError(detail) });
      }
      if (!outputText) outputText = lastMessageFromJsonl(result.stdout) ?? "";
      if (!outputText) throw new ProviderError("Codex CLI 没有返回可用的回复", { kind: "parse" });
      const out: Record<string, unknown> = {
        choices: [{ message: { role: "assistant", content: outputText } }],
        model: this.model,
      };
      const usage = usageFromJsonl(result.stdout);
      if (usage) out.usage = usage;
      return out;
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}

export function describeProvider(provider: ProviderLike): string {
  return provider.redact(`${provider.name} / ${provider.model} @ ${provider.baseUrl}`).split("\n").join(" ");
}

export interface SwitchRecord {
  from: string;
  to: string;
  error: string;
  kind: ProviderErrorKind;
  status: number | null;
  /**
   * 缺口 5：这次切换的触发原因（与 kind 同源、但只分用户关心的档）：
   * quota = 用量触顶（402 / 配额类文案的 429），rate_limit = 单纯限流，
   * 其余按 kind 直通，无法归类的落 other。事件与提示都用它，不再让
   * 用户从错误原文里猜“为什么换了模型”。
   */
  trigger: SwitchTrigger;
  /**
   * Kooyu 429 接力：限流/配额触发时才有的接力摘要（最近任务 + 最近进展 +
   * 已做修改，勿重复）。可选字段、只在有摘要时才带——旧测试的精确比对
   * 不受影响（见 G-P0-6 的 cancelledAt 教训）。非限流切换没有它。
   * 落盘由 recordModelSwitch 顺带做；通知里只引用它的 id，不塞全文。
   */
  handoff?: QuotaHandoff;
  /**
   * G-P1-33：这次切换把 from 标 degraded 的恢复时间（ISO，可选）。
   * 只在 FallbackProvider 真把 from 标 degraded 时才带——旧测试的
   * 精确比对不受影响（见 G-P0-6 的 cancelledAt 教训）。通知与审计
   * 凭它写“几分钟内不再选用”。
   */
  degradedUntil?: string;
}

/** 模型切换的触发原因（SwitchRecord.trigger 的取值）。 */
export type SwitchTrigger = "quota" | "rate_limit" | "server" | "timeout" | "network" | "other";

export function switchTriggerFor(kind: ProviderErrorKind): SwitchTrigger {
  if (kind === "quota") return "quota";
  if (kind === "rate_limit") return "rate_limit";
  if (kind === "server") return "server";
  if (kind === "timeout") return "timeout";
  if (kind === "network") return "network";
  return "other";
}

/**
 * 触发原因的中文短标签（groups.ts / gateway.ts 的硬编码中文提示共用；
 * CLI 的提示走 i18n 的 `fallback.trigger.*`，中文值须与这里一致）。
 */
export function switchTriggerLabel(trigger: SwitchTrigger): string {
  switch (trigger) {
    case "quota": return "用量触顶";
    case "rate_limit": return "请求过于频繁";
    case "server": return "服务端错误";
    case "timeout": return "请求超时";
    case "network": return "网络错误";
    default: return "调用失败";
  }
}

/**
 * 缺口 5：用量触顶判定——kind 为 quota（402，或 429 但文案是配额类，
 * 见 classifyHttpError）就是“这个订阅/ Key 的用量用完了”，与单纯的
 * 请求过于频繁（rate_limit）区分开：前者重试同一家没有意义、应直接
 * 换下一家；后者先重试同一家。
 */
export function isQuotaExhaustionError(exc: unknown): boolean {
  return exc instanceof ProviderError && exc.kind === "quota";
}

export interface RetryRecord {
  provider: string;
  attempt: number;
  kind: ProviderErrorKind;
  delayMs: number;
}

export interface FallbackProviderOptions {
  /** 同一 provider 重试的退避基数（毫秒），默认 PROVIDER_RETRY_BACKOFF_MS。测试可传 [0, 0] 定住。 */
  retryDelaysMs?: number[];
  /** 睡眠实现，默认 sleepMs（可中断）；测试可注入立即返回的版本。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: ((record: RetryRecord) => void) | null;
  /**
   * G-P1-33：故障账本接线（可选，不传 = 不标 degraded、不做过滤，
   * 老行为一字不改）。传了 home 时：切换走之前把刚失败的 provider
   * 标 degraded（默认 5 分钟恢复），下次建链过滤掉还没恢复的尾巴。
   */
  health?: { home: string; minutes?: number };
}

export class FallbackProvider implements ProviderLike {
  providers: ProviderLike[];
  onSwitch: ((record: SwitchRecord) => void) | null;
  activeIndex = 0;
  switches: SwitchRecord[] = [];
  /** 同一 provider 的重试记录（网页端可展示，与 switches 并列）。 */
  retries: RetryRecord[] = [];
  retryDelaysMs: number[];
  private retrySleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry: ((record: RetryRecord) => void) | null;
  /** G-P1-33：故障账本接线（可选，见 FallbackProviderOptions.health）。 */
  health?: { home: string; minutes?: number };

  constructor(providers: ProviderLike[], onSwitch?: ((record: SwitchRecord) => void) | null, opts: FallbackProviderOptions = {}) {
    if (!providers.length) throw new Error("FallbackProvider needs at least one provider");
    this.providers = [...providers];
    this.onSwitch = onSwitch ?? null;
    this.retryDelaysMs = opts.retryDelaysMs ?? [...PROVIDER_RETRY_BACKOFF_MS];
    this.retrySleep = opts.sleep ?? ((ms, signal) => sleepMs(ms, signal));
    this.onRetry = opts.onRetry ?? null;
    this.health = opts.health ?? undefined;
  }

  get name(): string { return this.providers[this.activeIndex].name; }
  get model(): string { return this.providers[this.activeIndex].model; }
  get baseUrl(): string { return this.providers[this.activeIndex].baseUrl; }

  redact(text: string): string {
    return this.providers[this.activeIndex].redact(text);
  }

  hasCredentials(): boolean {
    return this.providers[0].hasCredentials();
  }

  /** 附加到每次 chat 请求体的字段（推理档位等）。未设置则不加任何键。 */
  extraBody?: Record<string, unknown>;

  async listModels(timeout = 30): Promise<string[]> {
    return this.providers[this.activeIndex].listModels(timeout);
  }

  async chat(messages: ChatMessage[], tools?: Record<string, unknown>[] | null, timeout = resolveChatTimeout(), opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const attempted: [string, string][] = [];
    // 可靠性打磨第 1 项第一批：信号进来时已 abort，直接按取消抛，不再
    // 尝试任何 provider（与 executeTool 的入口检查同款）。
    if (opts?.signal?.aborted) throw cancelErrorFromSignal(opts.signal, "stop");
    // 总预算：整条链最多花 2× 单次超时，不让 N 个挂起的 provider 各等满一份超时。
    // 同一 provider 的重试同样受该预算约束：剩余时间不够“一次退避 + 一次
    // 重试（重试超时按剩余预算封顶）”时直接改走切换，免得重试吃光预算。
    const started = Date.now();
    const budgetMs = timeout * 2 * 1000;
    providerLoop: for (let index = 0; index < this.providers.length; index++) {
      const provider = this.providers[index];
      const remainingMs = budgetMs - (Date.now() - started);
      if (index > 0 && remainingMs < 100) break;
      const attemptTimeout0 = index === 0 ? timeout : Math.min(timeout, remainingMs / 1000);
      let attemptTimeout = attemptTimeout0;
      let attempt = 0;
      let logged = false;
      while (true) {
        try {
          // 可靠性打磨第 1 项第一批：取消信号一路传给底层 provider——
          // 在途请求 abort 时 CancelError 直接穿过（不是 ProviderError，
          // 不重试、不切换），调用方认得出“这是取消”。
          const result = await provider.chat(messages, tools, attemptTimeout, { signal: opts?.signal });
          this.activeIndex = index;
          return result;
        } catch (exc: unknown) {
          if (!(exc instanceof ProviderError)) throw exc;
          if (!logged) {
            logged = true;
            attempted.push([provider.name, String(exc.message)]);
          }
          // 同一 provider 先重试（至多 2 次，退避 1s/3s + ±25% 抖动，可中断）：
          // 只有瞬时错误可重试。切换判定不动——quota 仍按现有
          // RECOVERABLE_KINDS 处理是否切换（见下面的 recoverable 检查）；
          // 用量上限是否应触发切换，由总协调另定，本处不擅自改。
          if (isTransientProviderError(exc) && attempt < MAX_SAME_PROVIDER_RETRIES) {
            const base = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 1000;
            // 缺口 20：服务端让等更久时以服务端为准（Retry-After），否则走客户端退避。
            const delay = Math.max(jitteredDelayMs(base), exc.retryAfterMs ?? 0);
            const leftMs = budgetMs - (Date.now() - started);
            // 重试还要再花一次 attempt：剩余预算必须够“退避 + 再试一次”，
            // 再试的超时按剩余预算封顶（太短就没意义，直接改走切换）。
            // 否则重试一个挂起的 provider 会把本该留给下一个 provider 的
            // 预算吃光（每次重试都等满一份超时），链上后面的 provider 一次
            // 都试不到——0.5.1 集成验收抓到的真 bug。
            const retryTimeout = Math.min(attemptTimeout, (leftMs - delay - 100) / 1000);
            if (retryTimeout >= 0.2) {
              const record: RetryRecord = {
                provider: provider.name, attempt: attempt + 1, kind: exc.kind, delayMs: Math.round(delay),
              };
              this.retries.push(record);
              this.onRetry?.(record);
              attempt += 1;
              attemptTimeout = retryTimeout;
              try {
                await this.retrySleep(delay, opts?.signal);
              } catch {
                // 睡眠被中断（用户叫停）：不再重发。信号已 abort 时按
                // CancelError 抛（调用方认得出“这是取消”），而不是原错。
                if (opts?.signal?.aborted) throw cancelErrorFromSignal(opts.signal, "stop");
                throw exc;
              }
              continue;
            }
          }
          if (!exc.recoverable) throw exc;
          if (index + 1 >= this.providers.length) break providerLoop;
          const nxt = this.providers[index + 1];
          // Kooyu 429 接力：限流/配额触发时配一份接力摘要（最近任务 + 最近进展 +
          // 已做修改），挂在切换记录上；落盘与通知引用由 recordModelSwitch /
          // formatModelSwitchNotice 做。非限流切换没有摘要。
          const trigger = switchTriggerFor(exc.kind);
          const handoff = buildQuotaHandoff({ from: provider.name, to: nxt.name, error: String(exc.message), trigger, messages });
          const record: SwitchRecord = { from: provider.name, to: nxt.name, error: String(exc.message), kind: exc.kind, status: exc.status, trigger, ...(handoff ? { handoff } : {}) };
          // G-P1-33：刚失败的 provider 标 degraded（默认 5 分钟恢复），
          // 恢复时间挂在切换记录上——通知与审计凭它写“几分钟内不再选用”。
          // 标 degraded 本身不抛错、不拦切换（账本写失败就当没标）。
          if (this.health) {
            try {
              const entry = markDegraded(this.health.home, provider.name, `${switchTriggerFor(exc.kind)}：${String(exc.message)}`, { minutes: this.health.minutes, model: provider.model });
              record.degradedUntil = entry.until;
            } catch {
              // 账本写失败不拦切换。
            }
          }
          this.switches.push(record);
          this.activeIndex = index + 1;
          this.onSwitch?.(record);
          continue providerLoop;
        }
      }
    }
    const detail = attempted.map(([n, e]) => `${n}：${e}`).join("；");
    throw new ProviderError(`全部 ${this.providers.length} 个模型都失败了：${detail}`, { kind: "unknown" });
  }
}

export interface KeyRotatingProviderOptions {
  /** 同一把 Key 失败时先重试的退避基数（毫秒），默认 PROVIDER_RETRY_BACKOFF_MS。测试可传 [0, 0] 定住。 */
  retryDelaysMs?: number[];
  /** 退避睡眠（可注入，供测试不用真等）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 同 Key 重试时回调（网页端可展示，与 onSwitch 并列）。 */
  onRetry?: ((record: RetryRecord) => void) | null;
}

export class KeyRotatingProvider implements ProviderLike {
  providers: ProviderLike[];
  onSwitch: ((record: SwitchRecord) => void) | null;
  activeIndex = 0;
  switches: SwitchRecord[] = [];
  /** 同一把 Key 的重试记录（与 FallbackProvider 同款字段）。 */
  retries: RetryRecord[] = [];
  retryDelaysMs: number[];
  private retrySleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry: ((record: RetryRecord) => void) | null;

  constructor(providers: ProviderLike[], onSwitch?: ((record: SwitchRecord) => void) | null, opts: KeyRotatingProviderOptions = {}) {
    if (!providers.length) throw new Error("KeyRotatingProvider needs at least one provider");
    this.providers = [...providers];
    this.onSwitch = onSwitch ?? null;
    this.retryDelaysMs = opts.retryDelaysMs ?? [...PROVIDER_RETRY_BACKOFF_MS];
    this.retrySleep = opts.sleep ?? ((ms, signal) => sleepMs(ms, signal));
    this.onRetry = opts.onRetry ?? null;
  }

  get name(): string { return this.providers[this.activeIndex].name; }
  get model(): string { return this.providers[this.activeIndex].model; }
  get baseUrl(): string { return this.providers[this.activeIndex].baseUrl; }

  redact(text: string): string {
    return this.providers[this.activeIndex].redact(text);
  }

  hasCredentials(): boolean {
    return this.providers[0].hasCredentials();
  }

  /** 附加到每次 chat 请求体的字段（推理档位等）。未设置则不加任何键。 */
  extraBody?: Record<string, unknown>;

  async listModels(timeout = 30): Promise<string[]> {
    return this.providers[this.activeIndex].listModels(timeout);
  }

  private label(index: number): string {
    return `${this.providers[index].name} key ${index + 1}`;
  }

  private safeError(provider: ProviderLike, exc: ProviderError): string {
    try {
      return provider.redact(String(exc.message));
    } catch {
      return String(exc.message);
    }
  }

  async chat(messages: ChatMessage[], tools?: Record<string, unknown>[] | null, timeout = resolveChatTimeout(), opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const attempted: [number, string][] = [];
    let lastExc: ProviderError | null = null;
    // 可靠性打磨第 1 项第一批：信号进来时已 abort，直接按取消抛，不再
    // 尝试任何 provider（与 FallbackProvider 同款入口检查）。
    if (opts?.signal?.aborted) throw cancelErrorFromSignal(opts.signal, "stop");
    // 总预算：整条链最多花 2× 单次超时，不让 N 把 Key 各等满一份超时。
    // 同一把 Key 的重试同样受该预算约束（与 FallbackProvider 同款规则）：
    // 剩余时间不够“一次退避 + 一次重试（重试超时按剩余预算封顶）”时直接改走
    // 换 Key，免得重试吃光预算。
    const started = Date.now();
    const budgetMs = timeout * 2 * 1000;
    keyLoop: for (let index = 0; index < this.providers.length; index++) {
      const provider = this.providers[index];
      const remainingMs = budgetMs - (Date.now() - started);
      if (index > 0 && remainingMs < 100) break;
      let attemptTimeout = index === 0 ? timeout : Math.min(timeout, remainingMs / 1000);
      let attempt = 0;
      let logged = false;
      while (true) {
        try {
          // 可靠性打磨第 1 项第一批：取消信号一路传给底层 provider——
          // 在途请求 abort 时 CancelError 直接穿过（不是 ProviderError，
          // 不重试、不换 Key），调用方认得出“这是取消”。
          const result = await provider.chat(messages, tools, attemptTimeout, { signal: opts?.signal });
          this.activeIndex = index;
          return result;
        } catch (exc: unknown) {
          if (!(exc instanceof ProviderError)) throw exc;
          const safe = this.safeError(provider, exc);
          if (!logged) {
            logged = true;
            attempted.push([index, safe]);
          }
          lastExc = exc;
          // 换 Key 之前先重试同一把（至多 MAX_SAME_PROVIDER_RETRIES 次，退避
          // 1s/3s + ±25% 抖动，可中断）：只有瞬时错误可重试——401/403 类认证错
          // 换 Key 才有用，重试同一把 Key 只是白等；用量上限（quota）也不重试
          // （isTransientProviderError 已把 quota 文案排除在外）。
          if (isTransientProviderError(exc) && attempt < MAX_SAME_PROVIDER_RETRIES) {
            const base = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 1000;
            // 缺口 20：服务端让等更久时以服务端为准（Retry-After），否则走客户端退避。
            const delay = Math.max(jitteredDelayMs(base), exc.retryAfterMs ?? 0);
            const leftMs = budgetMs - (Date.now() - started);
            const retryTimeout = Math.min(attemptTimeout, (leftMs - delay - 100) / 1000);
            if (retryTimeout >= 0.2) {
              const record: RetryRecord = {
                provider: this.label(index), attempt: attempt + 1, kind: exc.kind, delayMs: Math.round(delay),
              };
              this.retries.push(record);
              this.onRetry?.(record);
              attempt += 1;
              attemptTimeout = retryTimeout;
              try {
                await this.retrySleep(delay, opts?.signal);
              } catch {
                // 睡眠被中断（用户叫停）：不再重发。信号已 abort 时按
                // CancelError 抛（调用方认得出“这是取消”），而不是原错。
                if (opts?.signal?.aborted) throw cancelErrorFromSignal(opts.signal, "stop");
                throw exc;
              }
              continue;
            }
          }
          // 注意：这里不照抄 FallbackProvider 的 `if (!exc.recoverable) throw`——
          // Key 轮换的语义就是“这把 Key 坏了就换下一把”：401/403 类认证错对
          // 当前 Key 不可恢复，但下一把 Key 可能正常，必须继续换 Key 试
          // （test_key_rotation_on_401 钉住这一行为）。只有瞬时错误才先重试
          // 同一把 Key，其余错误直接换 Key。
          if (index + 1 >= this.providers.length) break keyLoop;
          const trigger = switchTriggerFor(exc.kind);
          const handoff = buildQuotaHandoff({ from: this.label(index), to: this.label(index + 1), error: safe, trigger, messages });
          const record: SwitchRecord = {
            from: this.label(index), to: this.label(index + 1),
            error: safe, kind: exc.kind, status: exc.status, trigger,
            ...(handoff ? { handoff } : {}),
          };
          this.switches.push(record);
          this.activeIndex = index + 1;
          this.onSwitch?.(record);
          continue keyLoop;
        }
      }
    }
    const detail = attempted.map(([i, e]) => `key ${i + 1}：${e}`).join("；");
    throw new ProviderError(
      `全部 ${this.providers.length} 个 API Key 都失败了：${detail}`,
      { kind: lastExc?.kind ?? "unknown", status: lastExc?.status ?? null },
    );
  }
}

export function buildProviderChain(
  primaryCfg: ResolvedProvider,
  chainNames: string[],
  onSwitch?: ((record: SwitchRecord) => void) | null,
  opts?: {
    providerCls?: new (cfg: ResolvedProvider) => ProviderLike;
    resolver?: (name: string) => ResolvedProvider;
    cliProviderCls?: new (cfg: ResolvedProvider) => ProviderLike;
    /** 缺口 20：同一 provider 重试前的回调（CLI 用来显示 429 冷却倒计时）。 */
    onRetry?: ((record: RetryRecord) => void) | null;
    /** G-P1-33：故障账本接线（见 FallbackProviderOptions.health）。 */
    health?: { home: string; minutes?: number };
  },
): ProviderLike {
  const providerCls = opts?.providerCls ?? Provider;
  const resolver = opts?.resolver;
  const cliProviderCls = opts?.cliProviderCls ?? CliProvider;
  if (primaryCfg.auth === "cli") return new cliProviderCls(primaryCfg);
  // G-P1-33：建链时先按健康过滤兜底尾巴（链首主模型永远保留，见
  // filterHealthyChain）；没接 health 时链原样不动。
  const healthyNames = opts?.health ? filterHealthyChain(opts.health.home, chainNames) : chainNames;
  const providers: ProviderLike[] = [new providerCls(primaryCfg)];
  for (const name of healthyNames.slice(1)) {
    if (!resolver) break;
    let candidateCfg: ResolvedProvider;
    try {
      candidateCfg = resolver(name);
    } catch (exc: unknown) {
      console.error(`兜底允许列表里跳过了无法解析的 provider ${name}：${exc instanceof Error ? exc.message : String(exc)}`);
      continue;
    }
    if (candidateCfg.auth === "cli") {
      console.error(`兜底允许列表里跳过了 CLI provider ${name}（不进兜底链）`);
      continue;
    }
    let candidate: ProviderLike;
    try {
      candidate = new providerCls(candidateCfg);
    } catch (exc: unknown) {
      console.error(`兜底允许列表里跳过了无法解析的 provider ${name}：${exc instanceof Error ? exc.message : String(exc)}`);
      continue;
    }
    if (!candidate.hasCredentials()) {
      console.error(`兜底允许列表里跳过了未配置 Key 的 provider ${name}`);
      continue;
    }
    providers.push(candidate);
  }
  if (providers.length === 1) return providers[0];
  return new FallbackProvider(providers, onSwitch ?? null, { onRetry: opts?.onRetry ?? null, health: opts?.health ?? undefined });
}

/**
 * 缺口 24：按模型名造 provider 的工厂（multiModelFactory 的标准实现）。
 *
 * 语义统一（这是 Plan/Act 分模型与 aux 便宜模型真正生效的前提——此前 CLI/
 * 网关都没接 multiModelFactory，compact/delegate/reviewer 的模型切换实际都
 * 静默回退到了主模型）：
 *   - model 形如 "provider:model" → 用指定 provider 造（如 "xai:grok-4"）
 *   - model 是纯模型名 → 用主 provider（primaryName）造（如 "deepseek-flash"）
 *   - model 为空 → 返回 null（调用方沿用主模型）
 *
 * 不假装成功：resolveProvider 抛错 / 造不出凭证时抛 ProviderError，由调用方
 * 决定回退还是 fail-closed。
 */
export function makeModelFactory(opts: {
  home: string;
  config: Record<string, unknown>;
  primaryName: string;
}): (name: string, model: string | null) => ProviderLike {
  const { home, config, primaryName } = opts;
  return (name: string, model: string | null) => {
    if (!model || !model.trim()) throw new ProviderError(`多模型工厂未指定模型（用途 ${name}）`);
    const spec = model.trim();
    let providerName: string;
    let modelName: string;
    const colon = spec.indexOf(":");
    if (colon > 0 && colon < spec.length - 1) {
      providerName = spec.slice(0, colon).trim();
      modelName = spec.slice(colon + 1).trim();
    } else if (colon >= 0) {
      // 冒号在开头或结尾（或只有一个冒号）：写法非法。
      throw new ProviderError(`模型写法不对：${JSON.stringify(spec)}（应为 provider:model 或 model）`);
    } else {
      providerName = primaryName;
      modelName = spec;
    }
    if (!providerName || !modelName) throw new ProviderError(`模型写法不对：${JSON.stringify(spec)}（应为 provider:model 或 model）`);
    const resolved = resolveProvider({ home, config, providerName, model: modelName });
    const p = new Provider(resolved);
    if (!p.hasCredentials()) {
      throw new ProviderError(`provider ${providerName} 未配置可用凭证`);
    }
    return p;
  };
}

