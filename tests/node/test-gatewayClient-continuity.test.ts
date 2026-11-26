import { test, expect } from "bun:test";
import { GatewayClient } from "../../src/gatewayClient.ts";

function sse(...events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function withFetch(mock: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return () => { globalThis.fetch = original; };
}

test("GatewayClient session SSE resumes from the next per-session seq after disconnect", async () => {
  const calls: { url: string; token: string | null }[] = [];
  const restore = withFetch(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, token: headers.get("X-Nyra-Token") });
    if (calls.length === 1) return sse({ seq: 0, type: "user", data: { content: "hello" }, ts: 1 });
    return sse(
      { seq: 1, type: "assistant", data: { content: "done" }, ts: 2 },
      { type: "run_finished", data: { status: "done", error: "" }, ts: 3 },
    );
  });
  try {
    const client = new GatewayClient({ url: "http://gateway.test/", token: "device-token" });
    const received: Record<string, unknown>[] = [];
    for await (const event of client.sessionEvents("session/a", { reconnectDelayMs: 0 })) received.push(event);

    expect(received.map((event) => event.type)).toEqual(["user", "assistant", "run_finished"]);
    expect(calls.map((call) => new URL(call.url).searchParams.get("since"))).toEqual(["0", "1"]);
    expect(calls.every((call) => call.url.includes("session%2Fa/events"))).toBe(true);
    expect(calls.every((call) => call.token === "device-token")).toBe(true);
  } finally {
    restore();
  }
});

test("GatewayClient drops only duplicate events carrying an already-consumed seq", async () => {
  const calls: string[] = [];
  const restore = withFetch(async (input) => {
    calls.push(String(input));
    if (calls.length === 1) {
      return sse(
        { seq: 4, type: "tool_start", data: { name: "read_file" }, ts: 1 },
        { seq: 4, type: "tool_start", data: { name: "read_file" }, ts: 1 },
      );
    }
    return sse(
      { seq: 5, type: "tool_result", data: { ok: true }, ts: 2 },
      { type: "run_finished", data: { status: "done", error: "" }, ts: 3 },
    );
  });
  try {
    const client = new GatewayClient({ url: "http://gateway.test", token: "owner-token" });
    const received: Record<string, unknown>[] = [];
    for await (const event of client.sessionEvents("session-1", { since: 4, reconnectDelayMs: 0 })) received.push(event);

    expect(received.map((event) => event.type)).toEqual(["tool_start", "tool_result", "run_finished"]);
    expect(calls.map((url) => new URL(url).searchParams.get("since"))).toEqual(["4", "5"]);
  } finally {
    restore();
  }
});

test("GatewayClient session SSE subscription is cancellable", async () => {
  let cancelled = false;
  const restore = withFetch(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ seq: 0, type: "user", data: {}, ts: 1 })}\n\n`,
      ));
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const abort = new AbortController();
  try {
    const client = new GatewayClient({ url: "http://gateway.test", token: "owner-token" });
    const subscription = client.sessionEvents("session-1", { signal: abort.signal });
    const first = await subscription.next();
    expect(first.done).toBe(false);
    expect(first.value?.seq).toBe(0);
    abort.abort();
    const end = await subscription.next();
    expect(end.done).toBe(true);
    expect(cancelled).toBe(true);
  } finally {
    abort.abort();
    restore();
  }
});
