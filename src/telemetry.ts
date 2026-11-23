// src/telemetry.ts — G-P1-15 OpenTelemetry 可观测性（trace + metrics + logs）。
//
// 确定性实现，不引 OTel SDK、不联网、不调模型：
//   trace：W3C 风格 traceId（32 hex）/ spanId（16 hex），父子层级，JSONL 落盘；
//   metrics：命名计数器 + 直方图（count/sum），JSON 落盘，Prometheus 文本导出；
//   logs：与运行事件链 correlation——llm_span / tool_span 事件带 trace_id/span_id；
//   export：OTLP/JSON 写本地文件；POST 到 collector 须显式配 endpoint + --yes。
//
// span 属性只记元数据（模型名、工具名、耗时、token 数），不记 prompt、回答、
// 工具参数原文；属性键值过密钥扫描（key/token/secret/password/authorization
// 一律丢弃，值里带 sk-…/Bearer 的也丢）。写盘失败绝不抛错、不破坏主流程。
// 子 agent 各自开新 trace（父子 trace 透传是下一批的活，见 docs/telemetry.md）。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const TELEMETRY_CONFIG_FILE = "telemetry.json";
export const TELEMETRY_SPANS_FILE = "telemetry-spans.jsonl";
export const TELEMETRY_METRICS_FILE = "telemetry-metrics.json";
export const TELEMETRY_SCOPE_NAME = "nyra.telemetry";
export const TELEMETRY_MAX_SPAN_FILE_BYTES = 8 * 1024 * 1024;
export const TELEMETRY_MAX_EXPORT_SPANS = 1000;

export interface TelemetryConfig {
  /** 本地落盘总开关（默认开；关了就不记 span、不记 metrics、不发事件 trace id）。 */
  enabled: boolean;
  /** OTLP POST 总开关（默认关；开了也只在 `nyra telemetry export --endpoint … --yes` 时发）。 */
  otlpEnabled: boolean;
  /** collector 地址（默认空；不配不发）。 */
  otlpEndpoint: string;
  /** 单个 span 文件上限字节数，超了轮转到 .1（默认 8MB）。 */
  maxSpanFileBytes: number;
}

export function defaultTelemetryConfig(): TelemetryConfig {
  return { enabled: true, otlpEnabled: false, otlpEndpoint: "", maxSpanFileBytes: TELEMETRY_MAX_SPAN_FILE_BYTES };
}

export function telemetryConfigPath(home: string): string {
  return join(home, TELEMETRY_CONFIG_FILE);
}

export function telemetrySpansPath(home: string): string {
  return join(home, TELEMETRY_SPANS_FILE);
}

export function telemetryMetricsPath(home: string): string {
  return join(home, TELEMETRY_METRICS_FILE);
}

/** 读配置：文件不存在、损坏、缺键都回默认值（损坏文件先备份成 .corrupt-<时间戳>）。 */
export function loadTelemetryConfig(home: string): TelemetryConfig {
  const defaults = defaultTelemetryConfig();
  const path = telemetryConfigPath(home);
  if (!existsSync(path)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
      otlpEnabled: typeof raw.otlpEnabled === "boolean" ? raw.otlpEnabled : defaults.otlpEnabled,
      otlpEndpoint: typeof raw.otlpEndpoint === "string" ? raw.otlpEndpoint : defaults.otlpEndpoint,
      maxSpanFileBytes: typeof raw.maxSpanFileBytes === "number" && raw.maxSpanFileBytes > 0
        ? Math.floor(raw.maxSpanFileBytes)
        : defaults.maxSpanFileBytes,
    };
  } catch {
    try {
      const backup = `${path}.corrupt-${Date.now()}`;
      renameSync(path, backup);
    } catch { /* 备份失败也不破坏主流程 */ }
    return defaults;
  }
}

/** 写配置：原子写（tmp + rename），0600。 */
export function saveTelemetryConfig(home: string, cfg: TelemetryConfig): void {
  mkdirSync(home, { recursive: true });
  const path = telemetryConfigPath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, path);
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: SpanAttributes;
}

export interface SpanStatus {
  code: "unset" | "ok" | "error";
  message?: string;
}

export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: "internal";
  startTimeUnixNano: string;
  endTimeUnixNano: string | null;
  attributes: SpanAttributes;
  events: SpanEvent[];
  status: SpanStatus;
  ended: boolean;
}

const SECRET_KEY_RE = /(key|token|secret|password|passwd|auth|credential|cookie|api[_-]?key|authorization)/i;
const SECRET_VALUE_RE = /^(sk|xai)-[\w-]+|^Bearer\s+\S+/i;

function msToNano(ms: number): string {
  return String(BigInt(Math.floor(ms)) * 1000000n);
}

/** 属性消毒：密钥类键一律丢；密钥味的值一律丢；字符串截到 256 字；只留 string/number/boolean。 */
export function scrubAttributes(attrs: Record<string, unknown>): SpanAttributes {
  const out: SpanAttributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SECRET_KEY_RE.test(k)) continue;
    if (typeof v === "string") {
      if (SECRET_VALUE_RE.test(v)) continue;
      out[k] = v.length > 256 ? v.slice(0, 256) : v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

/** 读回最近的 span（损坏行跳过；limit ≤ 0 返回全部）。 */
export function readRecentSpans(home: string, limit = 50): TelemetrySpan[] {
  const path = telemetrySpansPath(home);
  if (!existsSync(path)) return [];
  const out: TelemetrySpan[] = [];
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const s = JSON.parse(t) as TelemetrySpan;
        if (s && typeof s === "object" && typeof s.traceId === "string" && typeof s.spanId === "string") out.push(s);
      } catch { /* 损坏行跳过 */ }
    }
  } catch { return []; }
  return limit > 0 ? out.slice(-limit) : out;
}

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSample {
  labels: Record<string, string>;
  count: number;
  sum: number;
}

export interface MetricsSnapshot {
  counters: Record<string, MetricSample[]>;
  histograms: Record<string, HistogramSample[]>;
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",");
}

/** 计数器 + 直方图（count/sum）账本：内存累加，flush 时原子写盘（0600）。 */
export class TelemetryMetrics {
  private counters: Record<string, MetricSample[]> = {};
  private histograms: Record<string, HistogramSample[]> = {};

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = labelKey(labels);
    const arr = this.counters[name] ?? (this.counters[name] = []);
    const hit = arr.find((s) => labelKey(s.labels) === key);
    if (hit) hit.value += value;
    else arr.push({ labels: { ...labels }, value });
  }

  observe(name: string, labels: Record<string, string> = {}, value: number): void {
    const key = labelKey(labels);
    const arr = this.histograms[name] ?? (this.histograms[name] = []);
    const hit = arr.find((s) => labelKey(s.labels) === key);
    if (hit) {
      hit.count += 1;
      hit.sum += value;
    } else {
      arr.push({ labels: { ...labels }, count: 1, sum: value });
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: JSON.parse(JSON.stringify(this.counters)) as Record<string, MetricSample[]>,
      histograms: JSON.parse(JSON.stringify(this.histograms)) as Record<string, HistogramSample[]>,
    };
  }

  load(home: string): void {
    const path = telemetryMetricsPath(home);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as MetricsSnapshot;
      if (raw && typeof raw === "object") {
        if (raw.counters && typeof raw.counters === "object") this.counters = raw.counters;
        if (raw.histograms && typeof raw.histograms === "object") this.histograms = raw.histograms;
      }
    } catch { /* 损坏就从空开始，不破坏主流程 */ }
  }

  save(home: string): void {
    try {
      mkdirSync(home, { recursive: true });
      const path = telemetryMetricsPath(home);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2) + "\n", { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
      renameSync(tmp, path);
    } catch { /* 写盘失败绝不破坏主流程 */ }
  }

  /** Prometheus 文本格式（只读导出，不起服务；/metrics 端点是下一批的活）。 */
  toPrometheus(): string {
    const lines: string[] = [];
    const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_:]/g, "_");
    const fmtLabels = (labels: Record<string, string>): string => {
      const keys = Object.keys(labels).sort();
      if (!keys.length) return "";
      return `{${keys.map((k) => `${safe(k)}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",")}}`;
    };
    for (const [name, samples] of Object.entries(this.counters)) {
      lines.push(`# HELP ${safe(name)} Nyra telemetry counter.`);
      lines.push(`# TYPE ${safe(name)} counter`);
      for (const s of samples) lines.push(`${safe(name)}${fmtLabels(s.labels)} ${s.value}`);
    }
    for (const [name, samples] of Object.entries(this.histograms)) {
      lines.push(`# HELP ${safe(name)} Nyra telemetry histogram.`);
      lines.push(`# TYPE ${safe(name)} histogram`);
      for (const s of samples) {
        lines.push(`${safe(name)}_count${fmtLabels(s.labels)} ${s.count}`);
        lines.push(`${safe(name)}_sum${fmtLabels(s.labels)} ${s.sum}`);
      }
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }
}

/** span 追踪器：一次 Agent 运行一个实例；根 span 是 agent.run，子 span 挂在它下面。 */
export class TelemetryTracer {
  readonly home: string;
  readonly config: TelemetryConfig;
  readonly metrics = new TelemetryMetrics();
  private stack: TelemetrySpan[] = [];
  private rootTraceId: string | null = null;

  constructor(home: string, config?: TelemetryConfig) {
    this.home = home;
    this.config = config ?? loadTelemetryConfig(home);
    if (this.config.enabled) this.metrics.load(home);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 当前 trace（栈顶 span 的 traceId；没有活动 span 时为 null）。 */
  currentTrace(): { traceId: string; spanId: string } | null {
    const top = this.stack[this.stack.length - 1];
    return top ? { traceId: top.traceId, spanId: top.spanId } : null;
  }

  get traceId(): string | null {
    return this.rootTraceId;
  }

  startRunSpan(attrs: Record<string, unknown> = {}): TelemetrySpan | null {
    if (!this.config.enabled) return null;
    const now = Date.now();
    const span: TelemetrySpan = {
      traceId: newTraceId(),
      spanId: newSpanId(),
      parentSpanId: null,
      name: "agent.run",
      kind: "internal",
      startTimeUnixNano: msToNano(now),
      endTimeUnixNano: null,
      attributes: scrubAttributes(attrs),
      events: [],
      status: { code: "unset" },
      ended: false,
    };
    this.rootTraceId = span.traceId;
    this.stack.push(span);
    return span;
  }

  startSpan(name: string, attrs: Record<string, unknown> = {}): TelemetrySpan | null {
    if (!this.config.enabled) return null;
    const parent = this.stack[this.stack.length - 1] ?? null;
    const span: TelemetrySpan = {
      traceId: parent ? parent.traceId : newTraceId(),
      spanId: newSpanId(),
      parentSpanId: parent ? parent.spanId : null,
      name,
      kind: "internal",
      startTimeUnixNano: msToNano(Date.now()),
      endTimeUnixNano: null,
      attributes: scrubAttributes(attrs),
      events: [],
      status: { code: "unset" },
      ended: false,
    };
    if (!parent) this.rootTraceId = span.traceId;
    this.stack.push(span);
    return span;
  }

  addEvent(span: TelemetrySpan | null, name: string, attrs: Record<string, unknown> = {}): void {
    if (!span || span.ended) return;
    span.events.push({ timeUnixNano: msToNano(Date.now()), name, attributes: scrubAttributes(attrs) });
  }

  /** 结束 span 并落盘（重复结束只算一次；写盘失败静默）。 */
  endSpan(span: TelemetrySpan | null, status: SpanStatus = { code: "ok" }, attrs: Record<string, unknown> = {}): void {
    if (!span || span.ended) return;
    span.ended = true;
    span.endTimeUnixNano = msToNano(Date.now());
    span.status = status;
    Object.assign(span.attributes, scrubAttributes(attrs));
    const idx = this.stack.lastIndexOf(span);
    if (idx >= 0) this.stack.splice(idx, 1);
    this.metrics.inc("nyra_spans_total", { name: span.name });
    this.appendSpan(span);
  }

  /** metrics 落盘（根 span 结束时调一次；CLI 读文件看到的就是截止到上次运行的数）。 */
  flushMetrics(): void {
    if (!this.config.enabled) return;
    this.metrics.save(this.home);
  }

  private appendSpan(span: TelemetrySpan): void {
    try {
      mkdirSync(this.home, { recursive: true });
      const path = telemetrySpansPath(this.home);
      if (existsSync(path)) {
        try {
          if (statSync(path).size >= this.config.maxSpanFileBytes) {
            renameSync(path, `${path}.1`);
          }
        } catch { /* 轮转失败就继续往原文件追加 */ }
      }
      appendFileSync(path, JSON.stringify(span) + "\n", { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch { /* ignore */ }
    } catch { /* 写盘失败绝不破坏主流程 */ }
  }
}

/** OTLP/JSON（resourceSpans）载荷：给 `nyra telemetry export` 与 collector POST 共用。 */
export function buildOtlpPayload(
  spans: TelemetrySpan[],
  serviceName = "nyra",
  serviceVersion = "",
): Record<string, unknown> {
  const otlpAttr = (v: SpanAttributeValue): Record<string, unknown> => {
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { boolValue: v };
    return { intValue: String(Math.trunc(v)) };
  };
  const attrs = (a: SpanAttributes): { key: string; value: Record<string, unknown> }[] =>
    Object.entries(a).map(([key, value]) => ({ key, value: otlpAttr(value) }));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            ...(serviceVersion ? [{ key: "service.version", value: { stringValue: serviceVersion } }] : []),
          ],
        },
        scopeSpans: [
          {
            scope: { name: TELEMETRY_SCOPE_NAME, version: serviceVersion || undefined },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: s.startTimeUnixNano,
              endTimeUnixNano: s.endTimeUnixNano ?? s.startTimeUnixNano,
              attributes: attrs(s.attributes),
              events: s.events.map((e) => ({
                timeUnixNano: e.timeUnixNano,
                name: e.name,
                attributes: attrs(e.attributes),
              })),
              status: { code: s.status.code === "error" ? 2 : s.status.code === "ok" ? 1 : 0, ...(s.status.message ? { message: s.status.message } : {}) },
            })),
          },
        ],
      },
    ],
  };
}

/** POST 一批 span 到 OTLP/HTTP collector（10 秒超时；只在显式调用时发）。 */
export async function postOtlp(endpoint: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { ok: res.ok, status: res.status };
}
