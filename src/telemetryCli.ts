// src/telemetryCli.ts — G-P1-15：`nyra telemetry` 子命令。
//
//   nyra telemetry [status] [--json]   总开关、OTLP 配置、span 数、metrics 摘要
//   nyra telemetry spans [--limit N] [--json]   最近的 span（trace/span id、耗时、状态）
//   nyra telemetry metrics [--prometheus]   计数器 + 直方图（默认人类可读，--prometheus 出文本格式）
//   nyra telemetry export [--out <路径>]   最近 span 的 OTLP/JSON 写文件（默认 evidence/telemetry/）
//   nyra telemetry export --endpoint <地址> --yes   POST 到 OTLP/HTTP collector（须显式确认）
//   nyra telemetry enable|disable   本地落盘总开关
//   nyra telemetry otlp on <地址>|off   OTLP POST 开关（on 须给地址；off 只关开关）
//
// 只读本地账本与配置；export 默认不联网。POST 失败返回 1 并写明状态码，不静默。
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TELEMETRY_MAX_EXPORT_SPANS, buildOtlpPayload, loadTelemetryConfig, postOtlp,
  readRecentSpans, saveTelemetryConfig, telemetryMetricsPath, telemetrySpansPath,
  TelemetryMetrics,
} from "./telemetry.ts";

const USAGE = "用法：nyra telemetry [status|spans|metrics|export|enable|disable|otlp]（详见 docs/telemetry.md）";

function spanCount(home: string): number {
  const path = telemetrySpansPath(home);
  if (!existsSync(path)) return 0;
  try {
    return readRecentSpans(home, 0).length;
  } catch {
    return 0;
  }
}

function loadMetrics(home: string): TelemetryMetrics {
  const m = new TelemetryMetrics();
  m.load(home);
  return m;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "进行中";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function spanDurationMs(s: { startTimeUnixNano: string; endTimeUnixNano: string | null }): number | null {
  if (!s.endTimeUnixNano) return null;
  const v = (BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1000000n;
  return Number(v);
}

function printStatus(home: string, json: boolean): number {
  const cfg = loadTelemetryConfig(home);
  const spans = spanCount(home);
  const metrics = loadMetrics(home);
  const snap = metrics.snapshot();
  const counterTotal = Object.values(snap.counters).flat().reduce((a, s) => a + s.value, 0);
  if (json) {
    process.stdout.write(JSON.stringify({
      enabled: cfg.enabled,
      otlp_enabled: cfg.otlpEnabled,
      otlp_endpoint: cfg.otlpEndpoint || null,
      spans_total: spans,
      metrics_counters: snap.counters,
      metrics_histograms: snap.histograms,
    }, null, 2) + "\n");
    return 0;
  }
  const lines = [
    `可观测性：${cfg.enabled ? "开（本地落盘）" : "关"}`,
    `OTLP 导出：${cfg.otlpEnabled ? `开（${cfg.otlpEndpoint || "未配地址"}）` : "关（只写本地文件）"}`,
    `Span 总数：${spans}`,
    `Metrics 计数合计：${counterTotal}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function printSpans(home: string, argv: string[]): number {
  const json = argv.includes("--json");
  let limit = 20;
  const idx = argv.indexOf("--limit");
  if (idx >= 0) {
    const raw = parseInt(argv[idx + 1] ?? "", 10);
    if (!Number.isFinite(raw) || raw < 1 || raw > 500) {
      process.stderr.write("用法：nyra telemetry spans [--limit N]（N 为 1–500）\n");
      return 2;
    }
    limit = raw;
  }
  const spans = readRecentSpans(home, limit);
  if (json) {
    process.stdout.write(JSON.stringify(spans, null, 2) + "\n");
    return 0;
  }
  if (!spans.length) {
    process.stdout.write("暂无 span（跑一次任务后开始记录）。\n");
    return 0;
  }
  const lines = spans.map((s) => {
    const dur = spanDurationMs(s);
    const status = s.status.code === "error" ? "失败" : s.status.code === "ok" ? "成功" : "进行中";
    const parent = s.parentSpanId ? ` ← ${s.parentSpanId.slice(0, 8)}` : "";
    return `${s.traceId.slice(0, 8)} ${s.spanId.slice(0, 8)}${parent} ${s.name} ${formatDuration(dur)} ${status}`;
  });
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function printMetrics(home: string, argv: string[]): number {
  const metrics = loadMetrics(home);
  if (argv.includes("--prometheus")) {
    process.stdout.write(metrics.toPrometheus());
    return 0;
  }
  const snap = metrics.snapshot();
  const lines: string[] = [];
  const counterNames = Object.keys(snap.counters).sort();
  const histNames = Object.keys(snap.histograms).sort();
  if (!counterNames.length && !histNames.length) {
    process.stdout.write("暂无 metrics（跑一次任务后开始记录）。\n");
    return 0;
  }
  for (const name of counterNames) {
    for (const s of snap.counters[name]) {
      const labels = Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(",");
      lines.push(`${name}${labels ? `{${labels}}` : ""} ${s.value}`);
    }
  }
  for (const name of histNames) {
    for (const s of snap.histograms[name]) {
      const labels = Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(",");
      const avg = s.count ? (s.sum / s.count).toFixed(1) : "0";
      lines.push(`${name}${labels ? `{${labels}}` : ""} count=${s.count} sum=${s.sum}ms avg=${avg}ms`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function handleExport(home: string, argv: string[]): Promise<number> {
  const endpointIdx = argv.indexOf("--endpoint");
  const endpoint = endpointIdx >= 0 ? (argv[endpointIdx + 1] ?? "") : "";
  const outIdx = argv.indexOf("--out");
  const outArg = outIdx >= 0 ? (argv[outIdx + 1] ?? "") : "";
  const yes = argv.includes("--yes");
  const spans = readRecentSpans(home, TELEMETRY_MAX_EXPORT_SPANS);
  const payload = buildOtlpPayload(spans);
  const receiptDir = join(home, "evidence", "telemetry");
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (endpoint) {
    const cfg = loadTelemetryConfig(home);
    if (!cfg.otlpEnabled) {
      process.stderr.write("OTLP 导出未开启：先执行 nyra telemetry otlp on <地址>，再加 --yes 重试。\n");
      return 2;
    }
    if (!yes) {
      process.stderr.write("POST 到外部 collector 须显式确认：加上 --yes 再执行。\n");
      return 2;
    }
    let result: { ok: boolean; status: number };
    try {
      result = await postOtlp(endpoint, payload);
    } catch (err: unknown) {
      process.stderr.write(`OTLP POST 失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const receipt = join(receiptDir, `export-${stamp}.json`);
    writeFileSync(receipt, JSON.stringify({ at: new Date().toISOString(), endpoint, spans: spans.length, status: result.status, ok: result.ok }, null, 2) + "\n", { mode: 0o600 });
    if (!result.ok) {
      process.stderr.write(`OTLP POST 被拒：HTTP ${result.status}（收据 ${receipt}）。\n`);
      return 1;
    }
    process.stdout.write(`已 POST ${spans.length} 个 span 到 ${endpoint}（HTTP ${result.status}，收据 ${receipt}）。\n`);
    return 0;
  }
  const out = outArg || join(receiptDir, `otlp-${stamp}.json`);
  writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`已导出 ${spans.length} 个 span（OTLP/JSON）到 ${out}。\n`);
  return 0;
}

export async function handleTelemetry(argv: string[], home: string): Promise<number> {
  const cmd = argv[0] ?? "status";
  const rest = argv.slice(1);
  if (cmd === "status") return printStatus(home, rest.includes("--json"));
  if (cmd === "spans") return printSpans(home, rest);
  if (cmd === "metrics") return printMetrics(home, rest);
  if (cmd === "export") return handleExport(home, rest);
  if (cmd === "enable" || cmd === "disable") {
    const cfg = loadTelemetryConfig(home);
    cfg.enabled = cmd === "enable";
    saveTelemetryConfig(home, cfg);
    process.stdout.write(`可观测性本地落盘已${cfg.enabled ? "开启" : "关闭"}。\n`);
    return 0;
  }
  if (cmd === "otlp") {
    const sub = rest[0];
    if (sub === "on") {
      const endpoint = rest[1] ?? "";
      if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
        process.stderr.write("用法：nyra telemetry otlp on <http(s)://地址>\n");
        return 2;
      }
      const cfg = loadTelemetryConfig(home);
      cfg.otlpEnabled = true;
      cfg.otlpEndpoint = endpoint;
      saveTelemetryConfig(home, cfg);
      process.stdout.write(`OTLP 导出已开启（${endpoint}；实际发送仍须 export --yes 显式确认）。\n`);
      return 0;
    }
    if (sub === "off") {
      const cfg = loadTelemetryConfig(home);
      cfg.otlpEnabled = false;
      saveTelemetryConfig(home, cfg);
      process.stdout.write("OTLP 导出已关闭。\n");
      return 0;
    }
    process.stderr.write("用法：nyra telemetry otlp on <地址>|off\n");
    return 2;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write("nyra telemetry [status|spans|metrics|export|enable|disable|otlp]（详见 docs/telemetry.md）\n");
    return 0;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}

/** metrics 文件有多大（status 摘要用；读不到返回 null）。 */
export function telemetryMetricsBytes(home: string): number | null {
  const path = telemetryMetricsPath(home);
  if (!existsSync(path)) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
