// editors/vscode/bridge.js — VS Code 扩展与 Nyra 编辑器桥之间的协议客户端。
//
// 纯 JS，不 import vscode（可直接在 bun test 里测）：spawn 一个
// `nyra editor serve --stdio` 子进程，走 JSON-lines（见 src/editorBridge.ts
// 的协议定义）。spawn 函数可注入（测试用假子进程）。
//
// 约定：
//   - 每条消息一个 id（ask/preview/apply/ping 有 id；snapshot/diagnostics
//     是单向推送，不等回复）。
//   - ask：收 answer_chunk 流式攒答案，answer_done 结算；超时默认 120 秒。
//   - 子进程意外退出时，未结算的请求一律 reject（fail-closed，不静默挂起）。

const DEFAULT_ASK_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;

let nextId = 1;
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

/**
 * @param {object} opts
 * @param {string} opts.cliPath - Nyra CLI 可执行路径（默认 "nyra"）。
 * @param {string} opts.cwd - 子进程工作目录（当前工作区根）。
 * @param {(cmd: string, args: string[], opts: object) => any} [opts.spawnFn] - 可注入的 spawn（测试用）。
 * @param {(text: string) => void} [opts.onAnswerChunk] - ask 的流式回答回调。
 * @param {(err: Error) => void} [opts.onError] - 子进程级错误回调。
 */
class NyraBridge {
  constructor(opts) {
    this.cliPath = opts.cliPath || "nyra";
    this.cwd = opts.cwd || process.cwd();
    this.spawnFn = opts.spawnFn || require("node:child_process").spawn;
    this.onAnswerChunk = opts.onAnswerChunk || null;
    this.onError = opts.onError || null;
    this.child = null;
    this.buffer = "";
    this.pending = new Map(); // id -> { resolve, reject, timer, chunks }
    this.askTimeoutMs = opts.askTimeoutMs || DEFAULT_ASK_TIMEOUT_MS;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get running() {
    return !!this.child;
  }

  start() {
    if (this.child) return;
    const child = this.spawnFn(this.cliPath, ["editor", "serve", "--stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d) => this.feed(d));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", () => { /* serve 的 stderr 只记日志，不当协议消息 */ });
    child.on("error", (err) => {
      this.failAll(new Error(`启动 Nyra 桥失败（${this.cliPath}）：${err.message}`));
      this.child = null;
      if (this.onError) this.onError(err);
    });
    child.on("close", () => {
      this.failAll(new Error("Nyra 桥子进程已退出"));
      this.child = null;
    });
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch { /* 已退出的进程 kill 会抛错，忽略 */ }
      this.child = null;
    }
    this.failAll(new Error("Nyra 桥已停止"));
  }

  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  feed(data) {
    this.buffer += data;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 坏行跳过，不崩客户端
      }
      this.route(msg);
    }
  }

  route(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "answer_chunk" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        p.chunks.push(msg.text || "");
        if (this.onAnswerChunk) this.onAnswerChunk(msg.text || "");
      }
      return;
    }
    if (msg.type === "answer_done" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve({ text: p.chunks.join(""), exitCode: msg.exitCode ?? 0 });
      }
      return;
    }
    if ((msg.type === "diff" || msg.type === "applied") && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    if (msg.type === "error") {
      const p = typeof msg.id === "string" ? this.pending.get(msg.id) : null;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.reject(new Error(msg.error || "Nyra 桥报错"));
      }
      return;
    }
    if (msg.type === "pong" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    // hello / ack：不等回复的确认，直接忽略。pong 在上面结算（ping 是 request，
    // 以前这里漏了 pong，ping 永远等到超时才 reject）。
  }

  send(msg) {
    this.start();
    if (!this.child) throw new Error("Nyra 桥未启动");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** 单向推送（不等回复）：snapshot / diagnostics。 */
  push(msg) {
    this.send(msg);
  }

  /** 带回复的请求：ask / preview / apply / ping。 */
  request(msg, timeoutMs) {
    this.send(msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Nyra 桥请求超时（${msg.type}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer, chunks: [] });
    });
  }

  hello(host) {
    // 协议版本写死 1：须与 src/editorBridge.ts 的 EDITOR_PROTOCOL_VERSION 一致，改那边时同步改这里。
    this.send({ type: "hello", host, version: 1 });
  }

  snapshot(snap) {
    this.push({ type: "snapshot", snapshot: snap });
  }

  diagnostics(file, diagnostics) {
    this.push({ type: "diagnostics", file, diagnostics });
  }

  ask(question) {
    const id = newId("ask");
    return this.request({ type: "ask", id, question }, this.askTimeoutMs);
  }

  preview(file, newText) {
    const id = newId("prv");
    return this.request({ type: "preview", id, file, newText }, this.timeoutMs);
  }

  apply(previewId) {
    const id = newId("app");
    return this.request({ type: "apply", id, previewId, approved: true }, this.timeoutMs);
  }

  ping() {
    const id = newId("ping");
    return this.request({ type: "ping", id }, this.timeoutMs);
  }
}

module.exports = { NyraBridge, newId };
