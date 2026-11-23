// tests/node/test-vscode-bridge-batch5.test.ts — 第 5 批 VS Code 协议客户端
// （editors/vscode/bridge.js）。bridge.js 不 import vscode，假子进程可直接测：
// spawn 参数、hello 版本、ask 流式攒答案、preview/apply 结算、超时、子进程退出
// 时未结算请求一律 reject（fail-closed）、坏行跳过。

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { NyraBridge } from "../../editors/vscode/bridge.js";

class FakeStream extends EventEmitter {
  setEncoding(_enc: string): void { /* 桥会调 setEncoding，假流直接忽略 */ }
}

class FakeChild extends EventEmitter {
  stdin: { writes: string[]; write: (d: string) => boolean; end: () => void };
  stdout: FakeStream;
  stderr: FakeStream;
  killed = false;
  spawnArgs: { cmd: string; args: string[]; opts: Record<string, unknown> };

  constructor(cmd: string, args: string[], opts: Record<string, unknown>) {
    super();
    this.spawnArgs = { cmd, args, opts };
    this.stdin = {
      writes: [],
      write: (d: string) => { this.stdin.writes.push(d); return true; },
      end: () => undefined,
    };
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
  }

  kill(): void {
    this.killed = true;
    // 真子进程的 close 是异步的：先让 stop() 自己的 failAll 结算 pending，
    // close 事件随后到（pending 已空，不重复结算）。
    queueMicrotask(() => this.emit("close", 0));
  }

  /** 模拟服务端回一行 JSON。 */
  serverReply(obj: Record<string, unknown>): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }

  /** 模拟服务端回一段原始文本（坏行、半行都行）。 */
  serverRaw(text: string): void {
    this.stdout.emit("data", text);
  }

  sentMessages(): Record<string, unknown>[] {
    return this.stdin.writes.map((w) => JSON.parse(w) as Record<string, unknown>);
  }
}

function makeBridge(opts: Record<string, unknown> = {}): { bridge: NyraBridge; fake: () => FakeChild | null } {
  let current: FakeChild | null = null;
  const bridge = new NyraBridge({
    cliPath: "nyra",
    cwd: "/tmp/proj",
    spawnFn: (cmd: string, args: string[], spawnOpts: Record<string, unknown>) => {
      current = new FakeChild(cmd, args, spawnOpts);
      return current;
    },
    ...opts,
  });
  return { bridge, fake: () => current };
}

describe("NyraBridge spawn 与 hello", () => {
  test("第一次发消息才 spawn，参数是 nyra editor serve --stdio，hello 带版本 1", () => {
    const { bridge, fake } = makeBridge();
    expect(bridge.running).toBe(false);
    bridge.hello("vscode");
    expect(bridge.running).toBe(true);
    const child = fake()!;
    expect(child.spawnArgs.cmd).toBe("nyra");
    expect(child.spawnArgs.args).toEqual(["editor", "serve", "--stdio"]);
    expect(child.spawnArgs.opts.cwd).toBe("/tmp/proj");
    const hello = child.sentMessages()[0]!;
    expect(hello).toMatchObject({ type: "hello", host: "vscode", version: 1 });
  });

  test("cliPath 与 cwd 原样传给 spawn", () => {
    const { bridge, fake } = makeBridge({ cliPath: "/usr/local/bin/nyra", cwd: "/home/u/work" });
    bridge.ping().catch(() => undefined);
    const child = fake()!;
    expect(child.spawnArgs.cmd).toBe("/usr/local/bin/nyra");
    expect(child.spawnArgs.opts.cwd).toBe("/home/u/work");
  });
});

describe("NyraBridge ask / preview / apply", () => {
  test("ask：chunk 流式攒答案，answer_done 结算，onAnswerChunk 按序收到", async () => {
    const chunks: string[] = [];
    const { bridge, fake } = makeBridge({ onAnswerChunk: (t: string) => chunks.push(t) });
    const p = bridge.ask("这段是干嘛的？");
    const child = fake()!;
    const sent = child.sentMessages()[0]!;
    expect(sent.type).toBe("ask");
    expect(sent.question).toBe("这段是干嘛的？");
    const id = sent.id as string;
    child.serverReply({ type: "answer_chunk", id, text: "第一句" });
    child.serverReply({ type: "answer_chunk", id, text: "第二句" });
    child.serverReply({ type: "answer_done", id, exitCode: 0 });
    const result = await p as { text: string; exitCode: number };
    expect(result.text).toBe("第一句第二句");
    expect(result.exitCode).toBe(0);
    expect(chunks).toEqual(["第一句", "第二句"]);
  });

  test("ask：服务端回 error 时 reject", async () => {
    const { bridge, fake } = makeBridge();
    const p = bridge.ask("x");
    const child = fake()!;
    const id = child.sentMessages()[0]!.id as string;
    child.serverReply({ type: "error", id, error: "模型挂了" });
    await expect(p).rejects.toThrow("模型挂了");
  });

  test("preview / apply：diff 与 applied 原样结算，apply 带 approved: true", async () => {
    const { bridge, fake } = makeBridge();
    const pp = bridge.preview("src/a.ts", "a\nB\n");
    const child = fake()!;
    const prvSent = child.sentMessages()[0]!;
    expect(prvSent).toMatchObject({ type: "preview", file: "src/a.ts", newText: "a\nB\n" });
    child.serverReply({
      type: "diff", id: prvSent.id, file: "src/a.ts",
      diff: "--- a/src/a.ts\n", additions: 1, deletions: 0, previewId: "prv_abc",
    });
    const diff = await pp as { previewId: string; additions: number };
    expect(diff.previewId).toBe("prv_abc");
    expect(diff.additions).toBe(1);

    const ap = bridge.apply("prv_abc");
    const appSent = child.sentMessages()[1]!;
    expect(appSent).toMatchObject({ type: "apply", previewId: "prv_abc", approved: true });
    child.serverReply({ type: "applied", id: appSent.id, file: "src/a.ts", additions: 1, deletions: 0 });
    const applied = await ap as { type: string; file: string };
    expect(applied).toMatchObject({ type: "applied", file: "src/a.ts" });
  });

  test("snapshot / diagnostics 是单向推送，不等回复", () => {
    const { bridge, fake } = makeBridge();
    bridge.snapshot({
      workspace: "/tmp/proj", activeFile: "src/a.ts", cursor: { line: 0, column: 0 },
      selection: null, openFiles: [], diagnostics: [], receivedAt: "2026-11-23T00:00:00.000Z", host: "vscode",
    });
    bridge.diagnostics("src/a.ts", [{ file: "src/a.ts", line: 0, column: 0, severity: 1, message: "m" }]);
    const sent = fake()!.sentMessages();
    expect(sent[0]).toMatchObject({ type: "snapshot" });
    expect((sent[0] as { snapshot: { activeFile: string } }).snapshot.activeFile).toBe("src/a.ts");
    expect(sent[1]).toMatchObject({ type: "diagnostics", file: "src/a.ts" });
  });

  test("ping：pong 结算", async () => {
    const { bridge, fake } = makeBridge();
    const p = bridge.ping();
    const child = fake()!;
    const id = child.sentMessages()[0]!.id as string;
    child.serverReply({ type: "pong", id });
    await expect(p).resolves.toMatchObject({ type: "pong", id });
  });
});

describe("NyraBridge 容错", () => {
  test("子进程退出时未结算的 ask 一律 reject，不静默挂起", async () => {
    const { bridge, fake } = makeBridge();
    const p = bridge.ask("x");
    const child = fake()!;
    child.kill();
    await expect(p).rejects.toThrow("Nyra 桥子进程已退出");
    expect(bridge.running).toBe(false);
  });

  test("stop() 杀掉子进程、未结算请求 reject、重复 stop 安全", async () => {
    const { bridge, fake } = makeBridge();
    const p = bridge.ask("x");
    const child = fake()!;
    bridge.stop();
    expect(child.killed).toBe(true);
    expect(bridge.running).toBe(false);
    await expect(p).rejects.toThrow("Nyra 桥已停止");
    expect(() => bridge.stop()).not.toThrow();
  });

  test("ask 超时 reject，超时后不再结算", async () => {
    const { bridge, fake } = makeBridge({ askTimeoutMs: 30 });
    const p = bridge.ask("x");
    const child = fake()!;
    await expect(p).rejects.toThrow("Nyra 桥请求超时");
    // 超时后服务端才回 answer_done：pending 已删，不会崩。
    const id = child.sentMessages()[0]!.id as string;
    expect(() => child.serverReply({ type: "answer_done", id, exitCode: 0 })).not.toThrow();
  });

  test("坏行跳过、半行攒齐再处理、不认的回复类型忽略", async () => {
    const { bridge, fake } = makeBridge();
    const p = bridge.ask("x");
    const child = fake()!;
    child.serverRaw("not json\n");
    child.serverRaw("{\"type\":\"hello\",\"version\":1}\n"); // 服务端 hello：忽略
    const id = child.sentMessages()[0]!.id as string;
    child.serverRaw(`{"type":"answer_chunk","id":"${id}","text":"半`);
    child.serverRaw(`行接上"}\n`);
    child.serverReply({ type: "answer_done", id, exitCode: 0 });
    const result = await p as { text: string };
    expect(result.text).toBe("半行接上");
  });

  test("spawn 失败时 failAll + onError，不留挂起请求", async () => {
    const errors: Error[] = [];
    const { bridge, fake } = makeBridge({ onError: (e: Error) => errors.push(e) });
    const p = bridge.ask("x");
    const child = fake()!;
    child.emit("error", new Error("ENOENT"));
    await expect(p).rejects.toThrow("启动 Nyra 桥失败");
    expect(errors.length).toBe(1);
    expect(bridge.running).toBe(false);
  });
});
