// tests/node/test-telemetry.test.ts — G-P1-15 OpenTelemetry 可观测性。
// trace（span 父子层级 + JSONL 落盘）+ metrics（计数器与直方图 + Prometheus
// 文本导出）+ logs（llm_span / tool_span 事件带 trace_id/span_id）+ OTLP 导出。
// 只在临时 home / 本地回环上验；不调模型、不联网（POST 目标是本机 stub 服务）。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TELEMETRY_MAX_EXPORT_SPANS, buildOtlpPayload, defaultTelemetryConfig,
  loadTelemetryConfig, newSpanId, newTraceId, postOtlp, readRecentSpans,
  saveTelemetryConfig, scrubAttributes, telemetrySpansPath, TelemetryMetrics,
  TelemetryTracer,
} from "../../src/telemetry.ts";
import { handleTelemetry } from "../../src/telemetryCli.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { Agent } from "../../src/agent.ts";

interface OtlpSpanOut {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  status: { code: number; message?: string };
}

interface OtlpPayloadOut {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpanOut[] }>;
  }>;
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-telemetry-test-"));
}

function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "nyra-telemetry-wd-"));
}

function captureStdout(fn: () => number | Promise<number>): { run: () => Promise<{ code: number; out: string; err: string }> } {
  return {
    run: async () => {
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      let out = "";
      let err = "";
      (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
      (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
      try {
        const code = await fn();
        return { code, out, err };
      } finally {
        (process.stdout as unknown as { write: unknown }).write = origOut;
        (process.stderr as unknown as { write: unknown }).write = origErr;
      }
    },
  };
}

test("TelemetryTest.test_ids_are_hex_and_unique", () => {
  expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  expect(newTraceId()).not.toBe(newTraceId());
  expect(newSpanId()).not.toBe(newSpanId());
});

test("TelemetryTest.test_scrub_drops_secrets_and_truncates", () => {
  const out = scrubAttributes({
    model: "fake-1",
    api_key: "sk-should-not-appear",
    token: "abc",
    password: "hunter2",
    note: "Bearer abcdef",
    secretValue: "sk-1234567890abcdef",
    count: 3,
    ok: true,
    long: "x".repeat(300),
    nested: { a: 1 },
  });
  expect(out.model).toBe("fake-1");
  expect(out.count).toBe(3);
  expect(out.ok).toBe(true);
  expect("api_key" in out).toBe(false);
  expect("token" in out).toBe(false);
  expect("password" in out).toBe(false);
  expect("note" in out).toBe(false);
  expect("secretValue" in out).toBe(false);
  expect((out.long as string).length).toBe(256);
  expect("nested" in out).toBe(false);
});

test("TelemetryTest.test_config_defaults_and_corrupt_fallback", () => {
  const home = tmpHome();
  const cfg = loadTelemetryConfig(home);
  expect(cfg.enabled).toBe(true);
  expect(cfg.otlpEnabled).toBe(false);
  expect(cfg.otlpEndpoint).toBe("");
  const next = { ...defaultTelemetryConfig(), enabled: false, otlpEndpoint: "http://127.0.0.1:4318" };
  saveTelemetryConfig(home, next);
  expect(loadTelemetryConfig(home)).toEqual(next);
  writeFileSync(join(home, "telemetry.json"), "{ not json");
  expect(loadTelemetryConfig(home).enabled).toBe(true);
  // 损坏文件被备份成 .corrupt-<时间戳>，原路径不再有坏文件。
  expect(readdirSync(home).some((f) => f.startsWith("telemetry.json.corrupt-"))).toBe(true);
  expect(existsSync(join(home, "telemetry.json"))).toBe(false);
});

test("TelemetryTest.test_tracer_parent_child_and_jsonl_roundtrip", () => {
  const home = tmpHome();
  const tracer = new TelemetryTracer(home);
  expect(tracer.enabled).toBe(true);
  const root = tracer.startRunSpan({ session_id: "sess-1", model: "fake-1" })!;
  const child = tracer.startSpan("model.chat", { model: "fake-1" })!;
  expect(child.traceId).toBe(root.traceId);
  expect(child.parentSpanId).toBe(root.spanId);
  expect(root.parentSpanId).toBeNull();
  tracer.endSpan(child, { code: "ok" }, { duration_ms: 120 });
  tracer.endSpan(root, { code: "ok" });
  tracer.endSpan(child, { code: "ok" });
  const spans = readRecentSpans(home, 0);
  expect(spans.length).toBe(2);
  expect(spans.map((s) => s.name).sort()).toEqual(["agent.run", "model.chat"]);
  expect(spans.every((s) => s.ended)).toBe(true);
  expect(spans.every((s) => s.endTimeUnixNano !== null)).toBe(true);
  const run = spans.find((s) => s.name === "agent.run")!;
  expect(run.attributes.session_id).toBe("sess-1");
});

test("TelemetryTest.test_disabled_tracer_records_nothing", () => {
  const home = tmpHome();
  saveTelemetryConfig(home, { ...defaultTelemetryConfig(), enabled: false });
  const tracer = new TelemetryTracer(home);
  expect(tracer.enabled).toBe(false);
  expect(tracer.startRunSpan({})).toBeNull();
  expect(tracer.startSpan("model.chat")).toBeNull();
  expect(existsSync(telemetrySpansPath(home))).toBe(false);
});

test("TelemetryTest.test_metrics_counters_histograms_and_prometheus", () => {
  const home = tmpHome();
  const m = new TelemetryMetrics();
  m.inc("nyra_tool_calls_total", { tool: "read_file", ok: "true" });
  m.inc("nyra_tool_calls_total", { tool: "read_file", ok: "true" }, 2);
  m.inc("nyra_tokens_total", { model: "fake-1", kind: "total" }, 150);
  m.observe("nyra_tool_duration_ms", { tool: "read_file" }, 120);
  m.observe("nyra_tool_duration_ms", { tool: "read_file" }, 80);
  m.save(home);
  const loaded = new TelemetryMetrics();
  loaded.load(home);
  const snap = loaded.snapshot();
  expect(snap.counters["nyra_tool_calls_total"][0].value).toBe(3);
  expect(snap.counters["nyra_tokens_total"][0].value).toBe(150);
  const hist = snap.histograms["nyra_tool_duration_ms"][0];
  expect(hist.count).toBe(2);
  expect(hist.sum).toBe(200);
  const prom = loaded.toPrometheus();
  expect(prom).toContain("# TYPE nyra_tool_calls_total counter");
  expect(prom).toContain('nyra_tool_calls_total{ok="true",tool="read_file"} 3');
  expect(prom).toContain("nyra_tool_duration_ms_count");
  expect(prom).toContain("nyra_tool_duration_ms_sum");
});

test("TelemetryTest.test_otlp_payload_shape_and_status_codes", () => {
  const home = tmpHome();
  const tracer = new TelemetryTracer(home);
  const root = tracer.startRunSpan({})!;
  const child = tracer.startSpan("tool.read_file", { tool: "read_file" })!;
  tracer.endSpan(child, { code: "error", message: "boom" });
  tracer.endSpan(root, { code: "ok" });
  const spans = readRecentSpans(home, 0);
  const payload = buildOtlpPayload(spans, "nyra", "0.5.9") as unknown as OtlpPayloadOut;
  expect(payload.resourceSpans.length).toBe(1);
  expect(payload.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("nyra");
  expect(payload.resourceSpans[0].scopeSpans[0].scope.name).toBe("nyra.telemetry");
  const out = payload.resourceSpans[0].scopeSpans[0].spans;
  expect(out.length).toBe(2);
  const tool = out.find((s) => s.name === "tool.read_file")!;
  expect(tool.status.code).toBe(2);
  expect(tool.status.message).toBe("boom");
  expect(tool.parentSpanId).toBe(root.spanId);
  const run = out.find((s) => s.name === "agent.run")!;
  expect(run.status.code).toBe(1);
  expect("parentSpanId" in run).toBe(false);
});

test("TelemetryTest.test_cli_status_spans_metrics_empty", async () => {
  const home = tmpHome();
  const s = await captureStdout(() => handleTelemetry(["status"], home)).run();
  expect(s.code).toBe(0);
  expect(s.out).toContain("可观测性：开");
  expect(s.out).toContain("OTLP 导出：关");
  const spans = await captureStdout(() => handleTelemetry(["spans"], home)).run();
  expect(spans.code).toBe(0);
  expect(spans.out).toContain("暂无 span");
  const metrics = await captureStdout(() => handleTelemetry(["metrics"], home)).run();
  expect(metrics.code).toBe(0);
  expect(metrics.out).toContain("暂无 metrics");
  const bad = await captureStdout(() => handleTelemetry(["nope"], home)).run();
  expect(bad.code).toBe(2);
});

test("TelemetryTest.test_cli_enable_disable_and_otlp_switch", async () => {
  const home = tmpHome();
  const off = await captureStdout(() => handleTelemetry(["disable"], home)).run();
  expect(off.code).toBe(0);
  expect(loadTelemetryConfig(home).enabled).toBe(false);
  const on = await captureStdout(() => handleTelemetry(["enable"], home)).run();
  expect(on.code).toBe(0);
  expect(loadTelemetryConfig(home).enabled).toBe(true);
  const bad = await captureStdout(() => handleTelemetry(["otlp", "on", "not-a-url"], home)).run();
  expect(bad.code).toBe(2);
  const ok = await captureStdout(() => handleTelemetry(["otlp", "on", "http://127.0.0.1:4318/v1/traces"], home)).run();
  expect(ok.code).toBe(0);
  expect(loadTelemetryConfig(home).otlpEnabled).toBe(true);
  const off2 = await captureStdout(() => handleTelemetry(["otlp", "off"], home)).run();
  expect(off2.code).toBe(0);
  expect(loadTelemetryConfig(home).otlpEnabled).toBe(false);
});

test("TelemetryTest.test_cli_spans_and_metrics_after_run", async () => {
  const home = tmpHome();
  const tracer = new TelemetryTracer(home);
  const root = tracer.startRunSpan({ session_id: "s1" })!;
  const child = tracer.startSpan("model.chat", { model: "fake-1" })!;
  tracer.endSpan(child, { code: "ok" }, { duration_ms: 50 });
  tracer.endSpan(root, { code: "ok" });
  tracer.metrics.inc("nyra_model_calls_total", { model: "fake-1", ok: "true" });
  tracer.flushMetrics();
  const spans = await captureStdout(() => handleTelemetry(["spans", "--limit", "5"], home)).run();
  expect(spans.code).toBe(0);
  expect(spans.out).toContain("model.chat");
  expect(spans.out).toContain("agent.run");
  const metrics = await captureStdout(() => handleTelemetry(["metrics", "--prometheus"], home)).run();
  expect(metrics.code).toBe(0);
  expect(metrics.out).toContain("nyra_model_calls_total");
  const badLimit = await captureStdout(() => handleTelemetry(["spans", "--limit", "0"], home)).run();
  expect(badLimit.code).toBe(2);
});

test("TelemetryTest.test_cli_export_writes_otlp_file", async () => {
  const home = tmpHome();
  const tracer = new TelemetryTracer(home);
  const root = tracer.startRunSpan({})!;
  tracer.endSpan(root, { code: "ok" });
  const outPath = join(home, "out.json");
  const r = await captureStdout(() => handleTelemetry(["export", "--out", outPath], home)).run();
  expect(r.code).toBe(0);
  expect(r.out).toContain("已导出 1 个 span");
  const payload = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
  expect(Array.isArray((payload as { resourceSpans: unknown[] }).resourceSpans)).toBe(true);
});

test("TelemetryTest.test_cli_export_post_requires_enabled_and_yes", async () => {
  const home = tmpHome();
  const noCfg = await captureStdout(() => handleTelemetry(["export", "--endpoint", "http://127.0.0.1:9/v1/traces", "--yes"], home)).run();
  expect(noCfg.code).toBe(2);
  expect(noCfg.err).toContain("OTLP 导出未开启");
  await captureStdout(() => handleTelemetry(["otlp", "on", "http://127.0.0.1:9/v1/traces"], home)).run();
  const noYes = await captureStdout(() => handleTelemetry(["export", "--endpoint", "http://127.0.0.1:9/v1/traces"], home)).run();
  expect(noYes.code).toBe(2);
  expect(noYes.err).toContain("--yes");
});

test("TelemetryTest.test_post_otlp_to_local_stub", async () => {
  let seen: Record<string, unknown> | null = null;
  let count = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      count += 1;
      seen = (await req.json()) as Record<string, unknown>;
      return new Response("ok", { status: 200 });
    },
  });
  try {
    const payload = buildOtlpPayload([], "nyra", "0.5.9");
    const r = await postOtlp(`http://127.0.0.1:${server.port}/v1/traces`, payload);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(count).toBe(1);
    expect(seen).not.toBeNull();
    expect(Array.isArray((seen as { resourceSpans: unknown[] }).resourceSpans)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("TelemetryTest.test_post_otlp_rejected_status_is_reported", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("nope", { status: 500 }),
  });
  try {
    const r = await postOtlp(`http://127.0.0.1:${server.port}/v1/traces`, buildOtlpPayload([]));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  } finally {
    server.stop(true);
  }
});

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  async chat(): Promise<Record<string, unknown>> {
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function withUsage(reply: Record<string, unknown>): Record<string, unknown> {
  return { ...reply, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

function toolReply(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

test("TelemetryTest.test_agent_run_writes_spans_and_trace_linked_events", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  writeFileSync(join(workdir, "notes.txt"), "hello\n");
  const provider = new FakeProvider([
    withUsage(toolReply("c1", "read_file", { path: "notes.txt" })),
    withUsage(textReply("读完了")),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261123-000000-telemetry",
  });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "读一下 notes.txt", {});
  const out = await agent.run("读一下 notes.txt");
  expect(out).toContain("读完了");
  const spans = readRecentSpans(home, 0);
  expect(spans.map((s) => s.name).sort()).toEqual(["agent.run", "model.chat", "model.chat", "tool.read_file"]);
  const root = spans.find((s) => s.name === "agent.run")!;
  expect(spans.every((s) => s.traceId === root.traceId)).toBe(true);
  const modelSpan = spans.find((s) => s.name === "model.chat")!;
  expect(modelSpan.parentSpanId).toBe(root.spanId);
  const toolSpan = spans.find((s) => s.name === "tool.read_file")!;
  expect(toolSpan.parentSpanId).toBe(root.spanId);
  const events = store.readEvents(recorder.runId);
  const llm = events.filter((e) => e.type === "llm_span");
  expect(llm.length).toBe(2);
  expect(typeof llm[0].trace_id).toBe("string");
  expect(String(llm[0].trace_id)).toMatch(/^[0-9a-f]{32}$/);
  expect(String(llm[0].span_id)).toBe(modelSpan.spanId);
  expect(String(llm[0].trace_id)).toBe(root.traceId);
  const tools = events.filter((e) => e.type === "tool_span");
  expect(tools.length).toBe(1);
  expect(tools[0].tool).toBe("read_file");
  expect(tools[0].ok).toBe(true);
  expect(typeof tools[0].duration_ms).toBe("number");
  expect(tools[0].trace_id).toBe(root.traceId);
  expect(tools[0].span_id).toBe(toolSpan.spanId);
  const metrics = new TelemetryMetrics();
  metrics.load(home);
  const snap = metrics.snapshot();
  expect(snap.counters["nyra_tool_calls_total"].some((s) => s.labels.tool === "read_file" && s.value === 1)).toBe(true);
  expect(snap.counters["nyra_tokens_total"].some((s) => s.labels.kind === "total" && s.value === 300)).toBe(true);
  expect(snap.histograms["nyra_tool_duration_ms"].length).toBe(1);
});

test("TelemetryTest.test_agent_run_with_telemetry_disabled_writes_nothing", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  saveTelemetryConfig(home, { ...defaultTelemetryConfig(), enabled: false });
  const provider = new FakeProvider([withUsage(textReply("好了"))]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261123-000000-telemetry-off",
  });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "说句话", {});
  await agent.run("说句话");
  expect(existsSync(telemetrySpansPath(home))).toBe(false);
  const events = store.readEvents(recorder.runId);
  const llm = events.filter((e) => e.type === "llm_span");
  expect(llm.length).toBe(1);
  expect("trace_id" in llm[0]).toBe(false);
});
