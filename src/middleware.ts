// src/middleware.ts — G-P2-4 类型化中间件链（借 MAF middleware 的想法，
// Node 实现，不抄代码）。
//
// MAF 的做法：AgentMiddleware / FunctionMiddleware / ChatMiddleware 三层，
// 内置 RetryMiddleware、CachingMiddleware、Validation、TokenCounter，
// 还有审批流 function_approval_request + approval_mode="never_require"
// 可按工具配。Nyra 原来只有 Hooks（拦截一环），重试、缓存、token 计数
// 各处散着实现——本批把三层链 + 四件内置做成可组合的中间件：
//
//   chat 层     —— 模型调用前后（token 计数；重试不接线：provider 链
//                  已有同提供商重试 + 退避 + jitter，再包一层会双重试）
//   function 层 —— 工具调用前后（审批模式、参数校验、缓存、重试）
//   agent 层    —— 整轮前后（token 总量汇总；默认无其他内置）
//
// 姿态（与 hooks / judge 同款 opt-in）：
// - 校验与 token 计数默认开（只读、不改行为、不花钱）；
// - 重试与缓存默认关，须机主显式 `nyra middleware enable <项>` 才生效；
// - 中间件抛错不破坏主循环：链本身的异常（配置损坏、缓存读写失败）
//   fail-open 回落到直接调 terminal；重试中间件只重试可重试错误，
//   取消、审批拒绝、校验失败一律不重试；
// - 缓存只缓存 allowlist 里的只读工具，写操作结果、失败结果、
//   参数里带密钥字样的调用一律不缓存；
// - approval_mode="never_require" 只对只读工具可配，写工具配了
//   在加载时丢弃、checkApproval 里再拦一道（fail-closed）。
//
// 叶模块：只引 node 内置。工具 schema、白名单、事件落盘都由调用方
// 注入（opts），不 import tools.ts / runs.ts，避免循环导入。
// token 计数只认模型实报的 usage，没报时记 missing_calls，绝不编 0。
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export class MiddlewareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiddlewareError";
  }
}

export type MiddlewareLayer = "chat" | "function" | "agent";
export type MiddlewareEmit = (kind: string, data: Record<string, unknown>) => void;

// ---- 通用链：(ctx, next) => result，按注册顺序执行，支持短路 ----------

/** 中间件函数：不调 next() 即短路，直接返回自己的结果。 */
export type MiddlewareFn<C, R> = (ctx: C, next: () => Promise<R>) => Promise<R>;

/**
 * 按顺序跑一串中间件，最后调 terminal。同一层 next() 并发重入直接抛错
 *（防写错的中间件把同一次调用并行跑两遍）；失败后顺序再调 next() 是
 * 合法的——重试中间件就靠这个（先失败一次、退避、再调一次）。
 */
export async function runMiddlewareChain<C, R>(
  fns: readonly MiddlewareFn<C, R>[],
  ctx: C,
  terminal: () => Promise<R>,
): Promise<R> {
  const inFlight = new Set<number>();
  const dispatch = async (idx: number): Promise<R> => {
    if (inFlight.has(idx)) throw new MiddlewareError("中间件重复调用了 next()");
    inFlight.add(idx);
    try {
      const fn = fns[idx];
      if (!fn) return await terminal();
      return await fn(ctx, () => dispatch(idx + 1));
    } finally {
      inFlight.delete(idx);
    }
  };
  return dispatch(0);
}

/** chat 层上下文：模型调用前后（turn 是本轮第几轮，从 1 起）。 */
export interface ChatMiddlewareContext {
  model: string | null;
  turn: number;
}

/** function 层上下文：工具调用前后。 */
export interface FunctionMiddlewareContext {
  tool: string;
  args: Record<string, unknown>;
}

/** agent 层上下文：整轮前后。 */
export interface AgentMiddlewareContext {
  task: string;
  resume: boolean;
}

// ---- 配置：~/.nyra/middleware.json（0600 原子写） ------------------------

export type ApprovalMode = "require" | "never_require";

export interface MiddlewareRetryConfig {
  enabled: boolean;
  /** 首次调用之外的重试次数（0 = 不重试）。 */
  maxRetries: number;
  /** 首次重试的基础退避（毫秒）。 */
  initialIntervalMs: number;
  /** 退避倍数。 */
  backoffFactor: number;
  /** 单次退避上限（毫秒）。 */
  maxIntervalMs: number;
}

export interface MiddlewareCacheConfig {
  enabled: boolean;
  /** memory = 进程内；file = 落盘 ~/.nyra/middleware-cache.json。 */
  store: "memory" | "file";
  /** 缓存有效期（秒）。 */
  ttlSeconds: number;
  /** 最多缓存几条（超了丢最旧的）。 */
  maxEntries: number;
}

export interface MiddlewareConfig {
  version: 1;
  layers: { chat: boolean; function: boolean; agent: boolean };
  validation: { enabled: boolean };
  tokens: { enabled: boolean };
  retry: MiddlewareRetryConfig;
  cache: MiddlewareCacheConfig;
  /** 按工具配的审批模式（默认 require）。 */
  approvalModes: Record<string, ApprovalMode>;
}

export const DEFAULT_MIDDLEWARE_CONFIG: MiddlewareConfig = {
  version: 1,
  layers: { chat: true, function: true, agent: true },
  validation: { enabled: true },
  tokens: { enabled: true },
  retry: { enabled: false, maxRetries: 2, initialIntervalMs: 500, backoffFactor: 2, maxIntervalMs: 8000 },
  cache: { enabled: false, store: "memory", ttlSeconds: 300, maxEntries: 200 },
  approvalModes: {},
};

/** 每次都给一份新的默认配置（调用方改了也不会污染模板）。 */
export function defaultMiddlewareConfig(): MiddlewareConfig {
  return JSON.parse(JSON.stringify(DEFAULT_MIDDLEWARE_CONFIG)) as MiddlewareConfig;
}

export function middlewareConfigPath(home: string): string {
  return join(home, "middleware.json");
}

export function middlewareCachePath(home: string): string {
  return join(home, "middleware-cache.json");
}

function atomicWrite0600(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 归一化一份原始配置：越界数字夹到范围内、非法值回默认值、非法条目
 * 逐条丢弃并记 errors。纯函数，便于单测。
 */
export function normalizeMiddlewareConfig(raw: unknown): { config: MiddlewareConfig; errors: string[] } {
  const errors: string[] = [];
  const cfg = defaultMiddlewareConfig();
  if (!isRecord(raw)) {
    if (raw !== undefined) errors.push("中间件配置不是对象，已回默认值");
    return { config: cfg, errors };
  }
  if (raw.version !== 1) {
    errors.push(`中间件配置 version 应为 1（实际 ${String(raw.version)}），已回默认值`);
    return { config: cfg, errors };
  }
  if (isRecord(raw.layers)) {
    for (const k of ["chat", "function", "agent"] as const) {
      if (typeof raw.layers[k] === "boolean") cfg.layers[k] = raw.layers[k];
    }
  }
  if (isRecord(raw.validation) && typeof raw.validation.enabled === "boolean") {
    cfg.validation.enabled = raw.validation.enabled;
  }
  if (isRecord(raw.tokens) && typeof raw.tokens.enabled === "boolean") {
    cfg.tokens.enabled = raw.tokens.enabled;
  }
  if (isRecord(raw.retry)) {
    const r = raw.retry;
    if (typeof r.enabled === "boolean") cfg.retry.enabled = r.enabled;
    cfg.retry.maxRetries = clampInt(r.maxRetries, 0, 4, cfg.retry.maxRetries);
    cfg.retry.initialIntervalMs = clampInt(r.initialIntervalMs, 0, 60000, cfg.retry.initialIntervalMs);
    cfg.retry.backoffFactor = clampNum(r.backoffFactor, 1, 4, cfg.retry.backoffFactor);
    cfg.retry.maxIntervalMs = clampInt(r.maxIntervalMs, 100, 60000, cfg.retry.maxIntervalMs);
  }
  if (isRecord(raw.cache)) {
    const c = raw.cache;
    if (typeof c.enabled === "boolean") cfg.cache.enabled = c.enabled;
    if (c.store === "memory" || c.store === "file") cfg.cache.store = c.store;
    cfg.cache.ttlSeconds = clampInt(c.ttlSeconds, 10, 86400, cfg.cache.ttlSeconds);
    cfg.cache.maxEntries = clampInt(c.maxEntries, 1, 5000, cfg.cache.maxEntries);
  }
  if (isRecord(raw.approvalModes)) {
    for (const [tool, mode] of Object.entries(raw.approvalModes)) {
      if (mode === "require" || mode === "never_require") cfg.approvalModes[tool] = mode;
      else errors.push(`审批模式 ${tool} 的值非法（${String(mode)}），已丢弃`);
    }
  }
  return { config: cfg, errors };
}

/**
 * 读配置：文件不存在回默认值；符号链接拒绝读（fail-closed）；
 * 损坏先备份再回默认值，不拦运行。
 */
export function loadMiddlewareConfig(home: string): { config: MiddlewareConfig; errors: string[] } {
  const path = middlewareConfigPath(home);
  if (!existsSync(path)) return { config: defaultMiddlewareConfig(), errors: [] };
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return { config: defaultMiddlewareConfig(), errors: [`中间件配置文件 ${path} 是符号链接，已拒绝读取`] };
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeMiddlewareConfig(parsed);
  } catch (err) {
    try {
      copyFileSync(path, `${path}.bak-${Date.now()}`);
    } catch { /* 备份失败也不拦运行 */ }
    return { config: defaultMiddlewareConfig(), errors: [`中间件配置文件损坏，已备份并回默认值：${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** 写配置：先归一化再 0600 原子写；符号链接拒绝写。 */
export function saveMiddlewareConfig(home: string, raw: unknown): { config: MiddlewareConfig; errors: string[] } {
  const { config, errors } = normalizeMiddlewareConfig(raw);
  const path = middlewareConfigPath(home);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new MiddlewareError(`中间件配置文件 ${path} 是符号链接，已拒绝写入`);
  }
  atomicWrite0600(path, JSON.stringify(config, null, 2) + "\n");
  return { config, errors };
}

// ---- 审批模式：按工具配 ---------------------------------------------------

/**
 * 查某工具的审批模式。never_require 只对只读工具生效——写工具即使配了
 * 也按 require 算（fail-closed；CLI 写配置时同样拒绝，见 validateApprovalModes）。
 */
export function resolveApprovalMode(
  config: MiddlewareConfig,
  tool: string,
  readOnlyTools: ReadonlySet<string>,
): ApprovalMode {
  if (config.approvalModes[tool] === "never_require" && readOnlyTools.has(tool)) return "never_require";
  return "require";
}

/** 校验一批审批模式：never_require 配到写工具上的一律拒绝。 */
export function validateApprovalModes(
  modes: Record<string, ApprovalMode>,
  readOnlyTools: ReadonlySet<string>,
): { accepted: string[]; rejected: { tool: string; reason: string }[] } {
  const accepted: string[] = [];
  const rejected: { tool: string; reason: string }[] = [];
  for (const [tool, mode] of Object.entries(modes)) {
    if (mode === "never_require" && !readOnlyTools.has(tool)) {
      rejected.push({ tool, reason: `工具 ${tool} 是写操作，不能配 never_require（只读工具才能免审批）` });
    } else {
      accepted.push(tool);
    }
  }
  return { accepted, rejected };
}

// ---- 重试：指数退避 + 抖动，只对可重试错误 --------------------------------

/** 第 attempt 次重试（0 起）的退避毫秒数：指数退避封顶后乘 jitter（0.75–1.25）。 */
export function retryDelayMs(
  attempt: number,
  cfg: Pick<MiddlewareRetryConfig, "initialIntervalMs" | "backoffFactor" | "maxIntervalMs">,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    cfg.maxIntervalMs,
    cfg.initialIntervalMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt)),
  );
  return Math.round(base * (0.75 + random() * 0.5));
}

const RETRYABLE_KINDS = new Set(["quota", "rate_limit", "server", "timeout", "network"]);

/**
 * 默认可重试判定（鸭子类型，不 import providers.ts / failures.ts，避循环）：
 * 取消、显式 retryable=false 一律不重试；retryable=true 或 kind 在可重试
 * 集里才重试；其余未知错误不重试（fail-closed，不靠重试烧钱）。
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.name === "CancelError" || e.name === "AbortError") return false;
  if (typeof e.message === "string" && e.message.includes("已取消")) return false;
  if (e.retryable === true) return true;
  if (e.retryable === false) return false;
  if (typeof e.kind === "string") return RETRYABLE_KINDS.has(e.kind);
  return false;
}

export interface RetryMiddlewareOptions {
  layer: MiddlewareLayer;
  tool?: string;
  maxRetries: number;
  initialIntervalMs: number;
  backoffFactor: number;
  maxIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  emit?: MiddlewareEmit;
  isRetryable?: (err: unknown) => boolean;
}

/**
 * 重试中间件：next() 抛可重试错误时按退避重试，每次重试记
 * `middleware_retry` 事件（层、工具、轮次、等待毫秒、错误 kind）。
 * 工具结果字符串里的错误不归这里管——已有的 executeToolIdempotent
 * 负责只读重试与写核查（见 tools.ts）；这里只重试抛出的异常。
 */
export function createRetryMiddleware<C, R>(opts: RetryMiddlewareOptions): MiddlewareFn<C, R> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  return async (ctx, next) => {
    let attempt = 0;
    for (;;) {
      try {
        return await next();
      } catch (err) {
        if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
        const delay = retryDelayMs(attempt, opts, random);
        const e = err as Record<string, unknown>;
        try {
          opts.emit?.("middleware_retry", {
            layer: opts.layer,
            tool: opts.tool ?? "",
            attempt: attempt + 1,
            delay_ms: delay,
            kind: typeof e.kind === "string" ? e.kind : typeof e.name === "string" ? e.name : "unknown",
          });
        } catch { /* 事件落盘失败不破坏重试 */ }
        await sleep(delay);
        attempt += 1;
      }
    }
  };
}

// ---- 校验：工具参数 schema 校验前置 ---------------------------------------

export interface ToolArgSchema {
  required?: string[];
  properties?: Record<string, { type?: string }>;
}

export function validateToolArgs(
  tool: string,
  args: Record<string, unknown>,
  schema: ToolArgSchema | null,
): { ok: true } | { ok: false; fields: string[]; message: string } {
  if (!schema) return { ok: true };
  const bad: string[] = [];
  const details: string[] = [];
  for (const name of schema.required ?? []) {
    if (args[name] === undefined || args[name] === null) {
      bad.push(name);
      details.push(`缺少必填参数 ${name}`);
    }
  }
  const props = schema.properties ?? {};
  for (const [name, def] of Object.entries(props)) {
    const v = args[name];
    if (v === undefined || v === null) continue;
    const t = def.type;
    if (!t) continue;
    const ok =
      t === "string" ? typeof v === "string"
      : t === "number" ? typeof v === "number" && Number.isFinite(v)
      : t === "integer" ? typeof v === "number" && Number.isInteger(v)
      : t === "boolean" ? typeof v === "boolean"
      : t === "array" ? Array.isArray(v)
      : t === "object" ? typeof v === "object" && !Array.isArray(v)
      : true;
    if (!ok) {
      bad.push(name);
      details.push(`参数 ${name} 类型应为 ${t}`);
    }
  }
  if (!bad.length) return { ok: true };
  return { ok: false, fields: [...new Set(bad)], message: `工具 ${tool} 参数校验失败：${details.join("；")}` };
}

/**
 * 校验中间件（function 层）：校验失败直接短路，返回错误文案给模型，
 * 不进工具、不产生副作用，并记 `middleware_validation_failed` 事件
 *（只记工具名与字段名，不记参数值）。
 */
export function createValidationMiddleware(opts: {
  getSchema: (tool: string) => ToolArgSchema | null;
  emit?: MiddlewareEmit;
}): MiddlewareFn<FunctionMiddlewareContext, string> {
  return async (ctx, next) => {
    const schema = opts.getSchema(ctx.tool);
    const checked = validateToolArgs(ctx.tool, ctx.args, schema);
    if (checked.ok) return next();
    try {
      opts.emit?.("middleware_validation_failed", { tool: ctx.tool, fields: checked.fields.join(",") });
    } catch { /* ignore */ }
    return `错误：${checked.message}`;
  };
}

// ---- 缓存：工具结果按“工具名 + 参数指纹”缓存 ------------------------------

/**
 * 稳定序列化（tools.ts stableStringify 的同款实现，抄一份避开 tools.ts
 * 的循环导入：只排对象键的顺序，数组保序）。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 缓存键 = sha256(工具名 + 参数稳定序列化)。只记哈希，不记参数原文。 */
export function functionCacheKey(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${tool}\n${stableStringify(args)}`, "utf-8").digest("hex");
}

/** 事件里用的参数指纹：哈希前 16 位（事件 redact 会掩掉 ≥32 字连续词串）。 */
export function argsHash16(tool: string, args: Record<string, unknown>): string {
  return functionCacheKey(tool, args).slice(0, 16);
}

/** 参数键里带这些字样的调用不缓存（可能含密钥）。 */
const SECRET_ARG_KEY_RE = /key|token|password|secret|auth|credential|passwd/i;

/** 单条缓存结果超过这个长度不缓存（工具结果本就截断，不缓存超大输出）。 */
export const MAX_CACHED_RESULT_CHARS = 16000;

export interface FunctionCacheEntry {
  key: string;
  tool: string;
  result: string;
  expiresAt: number;
}

export interface FunctionResultCacheOptions {
  ttlMs: number;
  maxEntries: number;
  store: "memory" | "file";
  home?: string | null;
  now?: () => number;
}

/** 工具结果缓存：进程内 Map + 可选落盘（0600，损坏直接丢弃）。 */
export class FunctionResultCache {
  private entries = new Map<string, FunctionCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store: "memory" | "file";
  private readonly home: string | null;
  private readonly now: () => number;

  constructor(opts: FunctionResultCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.store = opts.store;
    this.home = opts.home ?? null;
    this.now = opts.now ?? Date.now;
    if (this.store === "file" && this.home) this.loadFile();
  }

  private filePath(): string | null {
    return this.store === "file" && this.home ? middlewareCachePath(this.home) : null;
  }

  private loadFile(): void {
    const path = this.filePath();
    if (!path || !existsSync(path)) return;
    try {
      if (lstatSync(path).isSymbolicLink()) return;
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return;
      const now = this.now();
      for (const e of parsed.entries as unknown[]) {
        if (!isRecord(e) || typeof e.key !== "string" || typeof e.result !== "string") continue;
        if (typeof e.expiresAt !== "number" || e.expiresAt <= now) continue;
        this.entries.set(e.key, { key: e.key, tool: typeof e.tool === "string" ? e.tool : "", result: e.result, expiresAt: e.expiresAt });
      }
    } catch { /* 缓存损坏直接丢弃，不拦运行 */ }
  }

  private saveFile(): void {
    const path = this.filePath();
    if (!path) return;
    try {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) return;
      const payload = JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2) + "\n";
      atomicWrite0600(path, payload);
    } catch { /* 缓存落盘失败不破坏调用 */ }
  }

  get(tool: string, args: Record<string, unknown>): string | null {
    const key = functionCacheKey(tool, args);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.result;
  }

  set(tool: string, args: Record<string, unknown>, result: string): void {
    if (result.length > MAX_CACHED_RESULT_CHARS) return;
    const key = functionCacheKey(tool, args);
    this.entries.set(key, { key, tool, result, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    if (this.store === "file") this.saveFile();
  }

  clear(): void {
    this.entries.clear();
    if (this.store === "file") this.saveFile();
  }

  /** 过期条目先清掉再计数。 */
  size(): number {
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt <= now) this.entries.delete(k);
    }
    return this.entries.size;
  }
}

/**
 * 缓存中间件（function 层）：只缓存 allowlist 里的只读工具；参数键带
 * 密钥字样、失败结果一律不缓存。命中记 `middleware_cache_hit` 事件
 *（工具名 + 参数指纹，不记参数原文与结果原文）。
 */
export function createCacheMiddleware(opts: {
  cache: FunctionResultCache;
  cacheableTools: ReadonlySet<string>;
  emit?: MiddlewareEmit;
}): MiddlewareFn<FunctionMiddlewareContext, string> {
  return async (ctx, next) => {
    if (!opts.cacheableTools.has(ctx.tool)) return next();
    if (Object.keys(ctx.args).some((k) => SECRET_ARG_KEY_RE.test(k))) return next();
    const hit = opts.cache.get(ctx.tool, ctx.args);
    if (hit !== null) {
      try {
        opts.emit?.("middleware_cache_hit", { tool: ctx.tool, args_hash: argsHash16(ctx.tool, ctx.args) });
      } catch { /* ignore */ }
      return hit;
    }
    const result = await next();
    if (!result.startsWith("错误：") && !result.startsWith("执行失败：")) {
      opts.cache.set(ctx.tool, ctx.args, result);
    }
    return result;
  };
}

// ---- token 计数：只认模型实报的 usage --------------------------------------

export interface ChatUsageDelta {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface TokenTotals extends ChatUsageDelta {
  calls: number;
  missing_calls: number;
}

/** token 计数器：累计模型调用的用量；没报用量时记 missing_calls，绝不编 0。 */
export class TokenCounter {
  private prompt = 0;
  private completion = 0;
  private total = 0;
  private reportedPrompt = false;
  private reportedCompletion = false;
  private reportedTotal = false;
  calls = 0;
  missing_calls = 0;

  recordChat(resp: unknown): ChatUsageDelta {
    this.calls += 1;
    const usage = (resp as Record<string, unknown> | null)?.usage;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const p = isRecord(usage) ? num(usage.prompt_tokens) : null;
    const c = isRecord(usage) ? num(usage.completion_tokens) : null;
    const t = isRecord(usage) ? num(usage.total_tokens) : null;
    if (p === null && c === null && t === null) {
      this.missing_calls += 1;
    } else {
      if (p !== null) { this.prompt += p; this.reportedPrompt = true; }
      if (c !== null) { this.completion += c; this.reportedCompletion = true; }
      if (t !== null) { this.total += t; this.reportedTotal = true; }
    }
    return { prompt_tokens: p, completion_tokens: c, total_tokens: t };
  }

  snapshot(): TokenTotals {
    return {
      prompt_tokens: this.reportedPrompt ? this.prompt : null,
      completion_tokens: this.reportedCompletion ? this.completion : null,
      total_tokens: this.reportedTotal ? this.total : null,
      calls: this.calls,
      missing_calls: this.missing_calls,
    };
  }
}

/**
 * token 计数中间件（chat 层）：每次模型调用后记一笔 `middleware_tokens`
 * 事件（本次调用的用量，没报就是 null + missing_calls 记 1）。
 */
export function createTokenCounterMiddleware(opts: {
  counter: TokenCounter;
  emit?: MiddlewareEmit;
}): MiddlewareFn<ChatMiddlewareContext, Record<string, unknown>> {
  return async (ctx, next) => {
    const result = await next();
    const delta = opts.counter.recordChat(result);
    try {
      opts.emit?.("middleware_tokens", {
        model: ctx.model ?? "",
        ...delta,
        missing_calls: delta.prompt_tokens === null && delta.completion_tokens === null && delta.total_tokens === null ? 1 : 0,
      });
    } catch { /* ignore */ }
    return result;
  };
}

/**
 * token 总量中间件（agent 层）：整轮结束时记一笔 `middleware_tokens_total`
 * 事件（累计用量；一次模型调用都没跑过时不记，免得噪音）。
 */
export function createTokenSummaryMiddleware(opts: {
  counter: TokenCounter;
  emit?: MiddlewareEmit;
}): MiddlewareFn<AgentMiddlewareContext, string> {
  return async (ctx, next) => {
    const result = await next();
    const snap = opts.counter.snapshot();
    if (snap.calls === 0) return result;
    try {
      opts.emit?.("middleware_tokens_total", { ...snap });
    } catch { /* ignore */ }
    return result;
  };
}

// ---- 审批模式中间件 ---------------------------------------------------------

/**
 * 审批模式中间件（function 层）：工具按显式配的非默认模式跑时记一笔
 * `middleware_approval_mode` 事件（只记工具名与模式）。默认 require
 * 不记——默认行为满地都是，记了全是噪音。
 */
export function createApprovalModeMiddleware(opts: {
  resolve: (tool: string) => ApprovalMode;
  emit?: MiddlewareEmit;
}): MiddlewareFn<FunctionMiddlewareContext, string> {
  return async (ctx, next) => {
    const mode = opts.resolve(ctx.tool);
    if (mode !== "require") {
      try {
        opts.emit?.("middleware_approval_mode", { tool: ctx.tool, mode });
      } catch { /* ignore */ }
    }
    return next();
  };
}

// ---- 链装配 -----------------------------------------------------------------

export interface MiddlewareSetDeps {
  emit?: MiddlewareEmit;
  /** 工具 schema 查询（不给 = 校验全部放行）。 */
  getSchema?: (tool: string) => ToolArgSchema | null;
  /** 可缓存的工具（不给 = 一个都不缓存）。 */
  cacheableTools?: ReadonlySet<string>;
  /** 只读工具（审批模式判定用；不给 = 全部按写工具算）。 */
  readOnlyTools?: ReadonlySet<string>;
  /**
   * G-P2-5：审批模式解析覆盖（调用方注入）。不给时按配置文件里的
   * approvalModes 解析；给了就用调用方的解析——Agent 注入自己的
   * resolveMiddlewareApprovalMode，让声明的 approval 覆盖进 function
   * 层（否则覆盖只进 ToolContext 的 checkApproval，中间件事件看不到它）。
   */
  resolveApprovalMode?: (tool: string) => ApprovalMode;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface MiddlewareSet {
  config: MiddlewareConfig;
  errors: string[];
  counter: TokenCounter;
  cache: FunctionResultCache;
  chat: MiddlewareFn<ChatMiddlewareContext, Record<string, unknown>>[];
  function: MiddlewareFn<FunctionMiddlewareContext, string>[];
  agent: MiddlewareFn<AgentMiddlewareContext, string>[];
}

/**
 * 按配置装配三层链。home 为 null 时只用默认配置、不读不写文件。
 * existingCache 传了就复用（进程内缓存跨运行共享）；没传按配置新建。
 *
 * 层开关关了整层跳过（terminal 直调）；function 层内顺序固定：
 * 审批模式 → 校验 → 缓存 → 重试 → 执行。重试在最内层，只重试
 * terminal 抛出的可重试异常，不重复校验、不重复查缓存。
 */
export function buildMiddlewareSet(
  home: string | null,
  deps: MiddlewareSetDeps = {},
  existingCache?: FunctionResultCache,
): MiddlewareSet {
  const { config, errors } = home ? loadMiddlewareConfig(home) : { config: defaultMiddlewareConfig(), errors: [] };
  const emit = deps.emit;
  const counter = new TokenCounter();
  const cache = existingCache ?? new FunctionResultCache({
    ttlMs: config.cache.ttlSeconds * 1000,
    maxEntries: config.cache.maxEntries,
    store: config.cache.store,
    home,
  });
  const readOnlyTools = deps.readOnlyTools ?? new Set<string>();
  const cacheableTools = deps.cacheableTools ?? new Set<string>();
  const getSchema = deps.getSchema ?? (() => null);

  const chat: MiddlewareSet["chat"] = [];
  if (config.layers.chat && config.tokens.enabled) {
    chat.push(createTokenCounterMiddleware({ counter, emit }));
  }
  const fn: MiddlewareSet["function"] = [];
  if (config.layers.function) {
    fn.push(createApprovalModeMiddleware({
      // G-P2-5：调用方给了审批解析覆盖就用它（Agent 的合并解析，含声明
      // 的 approval 覆盖）；没给时按配置文件解析（老行为不变）。
      resolve: deps.resolveApprovalMode ?? ((tool) => resolveApprovalMode(config, tool, readOnlyTools)),
      emit,
    }));
    if (config.validation.enabled) {
      fn.push(createValidationMiddleware({ getSchema, emit }));
    }
    if (config.cache.enabled) {
      fn.push(createCacheMiddleware({ cache, cacheableTools, emit }));
    }
    if (config.retry.enabled) {
      fn.push(createRetryMiddleware<FunctionMiddlewareContext, string>({
        layer: "function",
        maxRetries: config.retry.maxRetries,
        initialIntervalMs: config.retry.initialIntervalMs,
        backoffFactor: config.retry.backoffFactor,
        maxIntervalMs: config.retry.maxIntervalMs,
        sleep: deps.sleep,
        random: deps.random,
        emit,
      }));
    }
  }
  const agent: MiddlewareSet["agent"] = [];
  if (config.layers.agent && config.tokens.enabled) {
    agent.push(createTokenSummaryMiddleware({ counter, emit }));
  }
  return { config, errors, counter, cache, chat, function: fn, agent };
}
