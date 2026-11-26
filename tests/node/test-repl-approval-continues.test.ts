// 回归：交互会话里一个工具需要审批，审批完、回复结束后会话必须回到提示符继续，
// 不能以 exit 0 悄悄退出（v0.5.12 实机截图复现过两次）。
//  - ttyMenu：结束时恢复 stdin 进来时的 raw/暂停状态（假 stdin，单元测试）；
//  - lineFallback：会话提供了自己的行输入时借用它，不另开 readline；
//  - 真 CLI：管道输入跑完整流程（审批 → 回复 → 第二句 → /exit），本机假模型，不联网。
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YES, NO, approvalHooks, approvalOptions, lineFallback, parseLineAnswer, ttyMenu, type MenuStdin } from "../../src/approvalUi.ts";

afterEach(() => { approvalHooks.ask = undefined; });

function fakeStdin(initial: { raw: boolean; paused: boolean }) {
  const listeners: ((c: Buffer) => void)[] = [];
  const state = { raw: initial.raw, paused: initial.paused, rawCalls: [] as boolean[] };
  const stdin: MenuStdin = {
    get isRaw() { return state.raw; },
    isPaused: () => state.paused,
    setRawMode: (m: boolean) => { state.raw = m; state.rawCalls.push(m); },
    resume: () => { state.paused = false; },
    pause: () => { state.paused = true; },
    on: (_e, cb) => { listeners.push(cb); },
    off: (_e, cb) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
  };
  const press = (s: string) => { for (const cb of [...listeners]) cb(Buffer.from(s)); };
  return { stdin, state, press, listeners };
}

test("ttyMenu restores a live REPL's stdin (raw on, not paused) after the answer", async () => {
  const f = fakeStdin({ raw: true, paused: false });
  const p = ttyMenu(approvalOptions(true), f.stdin, () => {});
  f.press("\r");
  expect(await p).toBe(YES);
  expect(f.state.raw).toBe(true);
  expect(f.state.paused).toBe(false);
  expect(f.listeners.length).toBe(0);
});

test("ttyMenu leaves an idle stdin paused and cooked again", async () => {
  const f = fakeStdin({ raw: false, paused: true });
  const p = ttyMenu(approvalOptions(false), f.stdin, () => {});
  f.press("\x1b");
  expect(await p).toBe(NO);
  expect(f.state.raw).toBe(false);
  expect(f.state.paused).toBe(true);
});

test("lineFallback borrows the session's own line reader when present", async () => {
  const asked: string[] = [];
  approvalHooks.ask = async (q) => { asked.push(q); return ""; };
  expect(await lineFallback("允许执行吗？", false)).toBe(YES);
  approvalHooks.ask = async () => null;
  expect(await lineFallback("允许执行吗？", false)).toBe(NO);
  expect(asked.length).toBe(1);
  expect(parseLineAnswer("a", true)).toBe("always");
  expect(parseLineAnswer("a", false)).toBe(NO);
});

test("REPL keeps the session after an approved tool call and answers the next message", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "demo-model" }] });
      const body = await req.json() as { messages: { role: string; content: unknown }[]; stream?: boolean };
      calls++;
      const msgs = body.messages;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const afterUser = msgs.slice(msgs.lastIndexOf(lastUser!) + 1);
      let message: Record<string, unknown>;
      if (userText.includes("第二句")) message = { role: "assistant", content: "DONE-TWO" };
      else if (afterUser.some((m) => m.role === "tool")) message = { role: "assistant", content: "DONE-ONE" };
      else message = { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "echo nyra-step" }) } }] };
      const finish = message.tool_calls ? "tool_calls" : "stop";
      if (body.stream) {
        const delta = { ...message, ...(message.tool_calls ? { tool_calls: (message.tool_calls as object[]).map((tc, index) => ({ ...tc, index })) } : {}) };
        const chunk = { id: "x", object: "chat.completion.chunk", model: "demo-model", choices: [{ index: 0, delta, finish_reason: finish }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ id: "c", object: "chat.completion", model: "demo-model", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    },
  });
  try {
    const home = mkdtempSync(join(tmpdir(), "nyra-repl-approval-home-"));
    const workdir = mkdtempSync(join(tmpdir(), "nyra-repl-approval-wd-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: "local", mode: "auto",
      custom_providers: { local: { base_url: `http://127.0.0.1:${server.port}/v1`, default_model: "demo-model" } },
    }));
    const env: Record<string, string> = { ...process.env as Record<string, string>, NYRA_HOME: home, NYRA_LANG: "zh", NO_PROXY: "*", no_proxy: "*", NYRA_LAZY_TOOLS: "0" };
    for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) delete env[k];
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "..", "..", "src", "cli.ts"), "--trust", "--workdir", workdir],
      env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let out = "";
    const decoder = new TextDecoder();
    const pump = (async () => { for await (const c of proc.stdout as unknown as AsyncIterable<Uint8Array>) out += decoder.decode(c); })();
    const errPump = (async () => { for await (const c of proc.stderr as unknown as AsyncIterable<Uint8Array>) out += decoder.decode(c); })();
    let exited = false;
    void proc.exited.then(() => { exited = true; });
    const waitFor = async (needle: string, ms = 20000): Promise<void> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (out.includes(needle)) return;
        if (exited) throw new Error(`CLI exited early (waiting for ${needle}):\n${out.slice(-1500)}`);
        await Bun.sleep(50);
      }
      throw new Error(`timeout waiting for ${needle}:\n${out.slice(-1500)}`);
    };
    const send = (s: string) => { proc.stdin.write(s); proc.stdin.flush(); };
    await waitFor("> ");
    send("看看仓库\n");
    await waitFor("允许");
    send("\n"); // 审批：空行 = 是
    await waitFor("DONE-ONE");
    await Bun.sleep(500);
    expect(exited).toBe(false);
    send("第二句\n");
    await waitFor("DONE-TWO");
    expect(exited).toBe(false);
    send("/exit\n");
    proc.stdin.end();
    const code = await proc.exited;
    await Promise.allSettled([pump, errPump]);
    expect(code).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(3);
  } finally {
    server.stop(true);
  }
}, 60000);
