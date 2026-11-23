// tests/node/test-editor-bridge-batch5.test.ts — 第 5 批编辑器桥（G-P0-3）
// 覆盖：协议校验、脱敏、快照格式化、LCS diff、bridge handle（快照/诊断/ask/
// preview/apply）、stdio serve 循环、editor_context 工具、CLI 冒烟、事件与时间线。
//
// 本批还修了一个真 bug：serveEditorBridge 里漏定义了 readline 接口 rl，
// serve 一跑就报 rl is not defined（见 test_serve_* 与 CLI 冒烟前的实测）。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  buildUnifiedDiff,
  diffLines,
  EditorBridge,
  EDITOR_PROTOCOL_VERSION,
  formatEditorSnapshot,
  isWorkspaceRelPath,
  loadEditorPreviews,
  loadEditorState,
  parseEditorMessage,
  saveEditorState,
  sanitizeEditorText,
  serveEditorBridge,
  type EditorMessage,
  type EditorSnapshot,
} from "../../src/editorBridge.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sampleSnapshot(workspace: string): EditorSnapshot {
  return {
    workspace,
    activeFile: "src/main.ts",
    cursor: { line: 9, column: 4 },
    selection: { start: { line: 9, column: 0 }, end: { line: 11, column: 2 }, text: "const x = 1;" },
    openFiles: [
      { path: "src/main.ts", language: "typescript", dirty: false },
      { path: "src/util.ts", language: "typescript", dirty: true },
    ],
    diagnostics: [
      { file: "src/main.ts", line: 9, column: 4, severity: 1, message: "类型不匹配", source: "tsc" },
      { file: "src/util.ts", line: 2, column: 0, severity: 2, message: "未使用的变量", source: "tsc" },
    ],
    receivedAt: "2026-11-23T00:00:00.000Z",
    host: "vscode",
  };
}

describe("parseEditorMessage", () => {
  test("hello 认版本 1，版本不对拒绝", () => {
    const ok = parseEditorMessage({ type: "hello", host: "vscode", version: 1 });
    expect(ok.type).toBe("hello");
    expect(() => parseEditorMessage({ type: "hello", host: "vscode", version: 2 })).toThrow("协议版本不对");
    expect(() => parseEditorMessage({ type: "hello", version: 1 })).toThrow("hello 缺 host");
  });

  test("snapshot 认相对路径，绝对路径与越界路径拒绝", () => {
    const base = sampleSnapshot("/tmp/proj");
    const ok = parseEditorMessage({ type: "snapshot", snapshot: base });
    expect(ok.type).toBe("snapshot");
    expect(() => parseEditorMessage({ type: "snapshot", snapshot: { ...base, activeFile: "/etc/passwd" } })).toThrow("工作区相对路径");
    expect(() => parseEditorMessage({ type: "snapshot", snapshot: { ...base, openFiles: [{ path: "../escape.ts" }] } })).toThrow("工作区相对路径");
    expect(() => parseEditorMessage({ type: "snapshot", snapshot: { ...base, host: "" } })).toThrow("snapshot 缺 host");
    expect(() => parseEditorMessage({ type: "snapshot", snapshot: { ...base, diagnostics: [{ file: "/etc/x", line: 0, column: 0, severity: 1, message: "m" }] } })).toThrow("diagnostics 不合法");
  });

  test("diagnostics / ask / preview / apply 各认各的必填字段", () => {
    expect(parseEditorMessage({ type: "diagnostics", file: "src/a.ts", diagnostics: [] }).type).toBe("diagnostics");
    expect(() => parseEditorMessage({ type: "diagnostics", file: "/etc/x", diagnostics: [] })).toThrow("工作区相对路径");
    expect(parseEditorMessage({ type: "ask", id: "a1", question: "这段是干嘛的？" }).type).toBe("ask");
    expect(() => parseEditorMessage({ type: "ask", id: "a1", question: "  " })).toThrow("ask 缺 question");
    expect(() => parseEditorMessage({ type: "ask", question: "x" })).toThrow("ask 缺 id");
    expect(parseEditorMessage({ type: "preview", id: "p1", file: "src/a.ts", newText: "x" }).type).toBe("preview");
    expect(() => parseEditorMessage({ type: "preview", id: "p1", file: "src/a.ts" })).toThrow("preview.newText");
    expect(parseEditorMessage({ type: "apply", id: "a1", previewId: "prv_x", approved: true }).type).toBe("apply");
    expect(() => parseEditorMessage({ type: "apply", id: "a1", previewId: "prv_x", approved: false })).toThrow("approved: true");
    expect(() => parseEditorMessage({ type: "apply", id: "a1", previewId: "prv_x" })).toThrow("approved: true");
    expect(parseEditorMessage({ type: "ping", id: "p1" }).type).toBe("ping");
  });

  test("未知类型 / 非对象 / 数组一律拒绝", () => {
    expect(() => parseEditorMessage({ type: "bogus" })).toThrow("未知的协议消息类型");
    expect(() => parseEditorMessage(null)).toThrow("必须是 JSON 对象");
    expect(() => parseEditorMessage("hello")).toThrow("必须是 JSON 对象");
    expect(() => parseEditorMessage([])).toThrow("必须是 JSON 对象");
  });
});

describe("isWorkspaceRelPath", () => {
  test("相对路径过，绝对与越界不过", () => {
    expect(isWorkspaceRelPath("src/main.ts")).toBe(true);
    expect(isWorkspaceRelPath("a/b/c.txt")).toBe(true);
    expect(isWorkspaceRelPath("")).toBe(false);
    expect(isWorkspaceRelPath("/etc/passwd")).toBe(false);
    expect(isWorkspaceRelPath("../escape.ts")).toBe(false);
    expect(isWorkspaceRelPath("a/../../escape.ts")).toBe(false);
    expect(isWorkspaceRelPath("C:\\Windows\\x.ts")).toBe(false);
    expect(isWorkspaceRelPath(null)).toBe(false);
  });
});

describe("sanitizeEditorText / formatEditorSnapshot", () => {
  test("疑似密钥掩掉，正常文本保留，超长截断", () => {
    expect(sanitizeEditorText("key 是 sk-abc123def456")).toContain("[已隐藏]");
    expect(sanitizeEditorText("token=abcdef123456")).toContain("[已隐藏]");
    expect(sanitizeEditorText("Bearer abcdefghij")).toContain("[已隐藏]");
    expect(sanitizeEditorText("a".repeat(32) + "b".repeat(10))).toContain("[已隐藏]");
    expect(sanitizeEditorText("普通中文文本")).toBe("普通中文文本");
    expect(sanitizeEditorText("x".repeat(100), 10).length).toBeLessThanOrEqual(10);
  });

  test("没快照明说没快照；有快照带文件、光标、选区与诊断", () => {
    expect(formatEditorSnapshot(null)).toContain("编辑器未连接");
    const text = formatEditorSnapshot(sampleSnapshot("/tmp/proj"));
    expect(text).toContain("src/main.ts");
    expect(text).toContain("10:5"); // 光标 0 基转 1 基
    expect(text).toContain("const x = 1;");
    expect(text).toContain("错误 1 / 警告 1");
    expect(text).toContain("类型不匹配");
    // 选区里的密钥也要掩掉。
    const secret = sampleSnapshot("/tmp/proj");
    secret.selection = { start: { line: 0, column: 0 }, end: { line: 0, column: 5 }, text: "sk-abc123def456" };
    expect(formatEditorSnapshot(secret)).toContain("[已隐藏]");
  });
});

describe("diffLines / buildUnifiedDiff", () => {
  test("没改动回（无改动），计数 0", () => {
    const d = buildUnifiedDiff("a\nb\n", "a\nb\n", "src/a.ts");
    expect(d.additions).toBe(0);
    expect(d.deletions).toBe(0);
    expect(d.text).toContain("（无改动）");
  });

  test("增删计数与 hunk 头对得上", () => {
    const d = buildUnifiedDiff("a\nb\nc\n", "a\nB\nc\nd\n", "src/a.ts");
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.text).toContain("--- a/src/a.ts");
    expect(d.text).toContain("+++ b/src/a.ts");
    expect(d.text).toContain("@@ -");
    expect(d.text).toContain("-b");
    expect(d.text).toContain("+B");
    expect(d.text).toContain("+d");
  });

  test("diffLines 是 LCS：相同行当上下文，不乱标", () => {
    const lines = diffLines("x\ny\nz", "x\ny2\nz");
    expect(lines.map((l) => `${l.op}${l.text}`).join("|")).toBe(" x|-y|+y2| z");
  });

  test("超大文件不逐行比对，直接拒绝", () => {
    const big = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n");
    expect(() => diffLines(big, "x")).toThrow("文件太大不逐行比对");
  });
});

describe("EditorBridge.handle", () => {
  test("hello 回版本与能力，快照进账本，工作区不对拒绝", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const events: string[] = [];
      const bridge = new EditorBridge({ home, workdir, onEvent: (t) => events.push(t) });
      const hello = await bridge.handle({ type: "hello", host: "vscode", version: EDITOR_PROTOCOL_VERSION });
      expect(hello[0]).toMatchObject({ type: "hello", version: 1 });
      expect((hello[0] as { capabilities: string[] }).capabilities).toContain("ask");
      expect(events).toContain("editor_connected");

      const snap = sampleSnapshot(workdir);
      const ack = await bridge.handle({ type: "snapshot", snapshot: snap });
      expect(ack[0]?.type).toBe("ack");
      expect(loadEditorState(home)?.activeFile).toBe("src/main.ts");
      expect(events).toContain("editor_snapshot");

      const wrong = sampleSnapshot("/tmp/elsewhere");
      await expect(bridge.handle({ type: "snapshot", snapshot: wrong })).rejects.toThrow("工作区不一致");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("diagnostics 合并进快照（同文件旧诊断被替换）", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const bridge = new EditorBridge({ home, workdir });
      await bridge.handle({ type: "snapshot", snapshot: sampleSnapshot(workdir) });
      await bridge.handle({
        type: "diagnostics",
        file: "src/main.ts",
        diagnostics: [{ file: "src/main.ts", line: 1, column: 0, severity: 1, message: "新报错", source: "tsc" }],
      });
      const snap = loadEditorState(home)!;
      const mainDiags = snap.diagnostics.filter((d) => d.file === "src/main.ts");
      expect(mainDiags.length).toBe(1);
      expect(mainDiags[0]!.message).toBe("新报错");
      // 另一个文件的诊断还在。
      expect(snap.diagnostics.some((d) => d.file === "src/util.ts")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("ask 用假 runTask：流式 chunk 回到调用方，answer_done 带退出码", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      let seenPrompt = "";
      const chunks: string[] = [];
      const bridge = new EditorBridge({
        home,
        workdir,
        onAnswerChunk: (_id, text) => chunks.push(text),
        runTask: async (prompt, onChunk) => {
          seenPrompt = prompt;
          onChunk("第一句");
          onChunk("第二句");
          return { text: "第一句第二句", exitCode: 0 };
        },
      });
      await bridge.handle({ type: "snapshot", snapshot: sampleSnapshot(workdir) });
      const replies = await bridge.handle({ type: "ask", id: "ask_1", question: "这段是干嘛的？" });
      expect(replies[0]).toMatchObject({ type: "answer_done", id: "ask_1", exitCode: 0 });
      expect(chunks).toEqual(["第一句", "第二句"]);
      expect(seenPrompt).toContain("这段是干嘛的？");
      expect(seenPrompt).toContain("src/main.ts");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("ask 的 runTask 抛错时回 error，不崩 bridge", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const bridge = new EditorBridge({
        home,
        workdir,
        runTask: async () => { throw new Error("模型挂了"); },
      });
      const replies = await bridge.handle({ type: "ask", id: "ask_9", question: "x" });
      expect(replies[0]).toMatchObject({ type: "error", id: "ask_9" });
      expect((replies[0] as { error: string }).error).toContain("模型挂了");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("preview 只算 diff 不动磁盘；apply 校验通过才写盘，文件变过拒绝", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      mkdirSync(join(workdir, "src"), { recursive: true });
      const file = join(workdir, "src", "a.ts");
      writeFileSync(file, "a\nb\nc\n", "utf-8");
      const bridge = new EditorBridge({ home, workdir });
      const replies = await bridge.handle({ type: "preview", id: "p1", file: "src/a.ts", newText: "a\nB\nc\nd\n" });
      const diff = replies[0] as { type: string; previewId: string; additions: number; deletions: number; diff: string };
      expect(diff.type).toBe("diff");
      expect(diff.additions).toBe(2);
      expect(diff.deletions).toBe(1);
      expect(diff.diff).toContain("-b");
      expect(readFileSync(file, "utf-8")).toBe("a\nb\nc\n"); // 预览没动磁盘
      expect(loadEditorPreviews(home).length).toBe(1);

      // 未知的预览 id 拒绝。
      await expect(bridge.handle({ type: "apply", id: "a1", previewId: "prv_nope", approved: true })).rejects.toThrow("预览不存在");

      // 文件被外部改过 → 拒绝应用，预览保留。
      writeFileSync(file, "a\nb\nc\ne\n", "utf-8");
      await expect(bridge.handle({ type: "apply", id: "a2", previewId: diff.previewId, approved: true })).rejects.toThrow("文件已变");
      expect(loadEditorPreviews(home).length).toBe(1);

      // 恢复原内容再应用 → 写盘成功，预览删掉。
      writeFileSync(file, "a\nb\nc\n", "utf-8");
      const applied = await bridge.handle({ type: "apply", id: "a3", previewId: diff.previewId, approved: true });
      expect(applied[0]).toMatchObject({ type: "applied", file: "src/a.ts", additions: 2, deletions: 1 });
      expect(readFileSync(file, "utf-8")).toBe("a\nB\nc\nd\n");
      expect(loadEditorPreviews(home).length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("preview 不存在的文件直接报错，不编内容", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const bridge = new EditorBridge({ home, workdir });
      await expect(bridge.handle({ type: "preview", id: "p1", file: "src/nope.ts", newText: "x" })).rejects.toThrow("文件不存在");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("serveEditorBridge", () => {
  test("hello/ping/snapshot 走通，坏行回 error、循环不崩，stdin 关了退出 0", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const lines = [
        JSON.stringify({ type: "hello", host: "vscode", version: 1 }),
        JSON.stringify({ type: "snapshot", snapshot: sampleSnapshot(workdir) }),
        JSON.stringify({ type: "ping", id: "p1" }),
        JSON.stringify({ type: "bogus" }),
        "not json",
        "",
      ];
      const out: string[] = [];
      const output = new Writable({
        write(chunk, _enc, cb) { out.push(chunk.toString("utf-8")); cb(); },
      });
      const code = await serveEditorBridge(Readable.from(lines.map((l) => l + "\n")), output, { home, workdir });
      expect(code).toBe(0);
      const replies = out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(replies[0]).toMatchObject({ type: "hello", version: 1 });
      expect(replies[1]).toMatchObject({ type: "ack" });
      expect(replies[2]).toMatchObject({ type: "pong", id: "p1" });
      expect(replies[3]).toMatchObject({ type: "error" });
      expect(replies[4]).toMatchObject({ type: "error" });
      expect(loadEditorState(home)?.activeFile).toBe("src/main.ts");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("serve 里的 ask 流式 chunk 先出、answer_done 后出", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const out: string[] = [];
      const output = new Writable({
        write(chunk, _enc, cb) { out.push(chunk.toString("utf-8")); cb(); },
      });
      const code = await serveEditorBridge(
        Readable.from([JSON.stringify({ type: "ask", id: "ask_1", question: "hi" }) + "\n"]),
        output,
        {
          home,
          workdir,
          runTask: async (_prompt, onChunk) => {
            onChunk("chunk一");
            onChunk("chunk二");
            return { text: "chunk一chunk二", exitCode: 0 };
          },
        },
      );
      expect(code).toBe(0);
      const replies = out.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(replies[0]).toMatchObject({ type: "answer_chunk", id: "ask_1", text: "chunk一" });
      expect(replies[1]).toMatchObject({ type: "answer_chunk", id: "ask_1", text: "chunk二" });
      expect(replies[2]).toMatchObject({ type: "answer_done", id: "ask_1", exitCode: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("editor_context tool", () => {
  test("有快照时回文件与光标，没快照明说", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const ctx = newToolContext({ workdir, home, mode: "auto", interactive: true });
      expect(await executeTool("editor_context", {}, ctx)).toContain("编辑器未连接");
      saveEditorState(home, sampleSnapshot(workdir));
      const out = await executeTool("editor_context", {}, ctx);
      expect(out).toContain("src/main.ts");
      expect(out).toContain("10:5");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("editor events + timeline", () => {
  test("6 个 editor 事件进 RunStore，时间线渲染出相对路径与计数", () => {
    const home = tempDir("nyra-ed5-home-");
    try {
      const store = new RunStore(join(home, "runs"));
      const runId = store.create("编辑器测试任务", "sess-ed5", home, "normal", 10).run_id;
      store.appendEvent(runId, "editor_connected", { host: "vscode" });
      store.appendEvent(runId, "editor_snapshot", { files: 2, diagnostics: 2 });
      store.appendEvent(runId, "editor_diagnostics", { file: "src/main.ts", errors: 1, warnings: 0 });
      store.appendEvent(runId, "editor_asked", { chars: 120 });
      store.appendEvent(runId, "editor_preview", { file: "src/a.ts", additions: 2, deletions: 1 });
      store.appendEvent(runId, "editor_applied", { file: "src/a.ts", additions: 2, deletions: 1 });
      const tl = buildTimeline(store, runId);
      const text = formatTimelineText(tl);
      expect(text).toContain("编辑器已连接（vscode）");
      expect(text).toContain("编辑器快照：2 个打开文件、2 条诊断");
      expect(text).toContain("编辑器诊断：src/main.ts（错误 1 / 警告 0）");
      expect(text).toContain("编辑器提问（附快照 120 字上下文）");
      expect(text).toContain("编辑器 diff 预览：src/a.ts（+2 −1）");
      expect(text).toContain("编辑器预览已应用：src/a.ts（+2 −1）");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---- CLI 冒烟（与第 4 批同款 runCli：bun 跑 src/cli.ts，--workdir 指工作区）----

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(argv: string[], home: string, workdir: string): Promise<RunResult> {
  // editor 子命令的 workdir 就是进程 cwd（顶层 --workdir 不会进 subArgs），
  // 所以 spawn 时直接把 cwd 指到工作区，不传 --workdir。
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv],
    cwd: workdir,
    env: { ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("editor CLI", () => {
  test("status / snapshot / hosts / 未知子命令", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const empty = await runCli(["editor", "status"], home, workdir);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain("编辑器未连接");

      saveEditorState(home, sampleSnapshot(workdir));
      const status = await runCli(["editor", "status"], home, workdir);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("编辑器已连接（vscode");
      expect(status.stdout).toContain("当前文件：src/main.ts");

      const snap = await runCli(["editor", "snapshot", "--json"], home, workdir);
      expect(snap.code).toBe(0);
      expect((JSON.parse(snap.stdout) as EditorSnapshot).activeFile).toBe("src/main.ts");

      const hosts = await runCli(["editor", "hosts"], home, workdir);
      expect(hosts.code).toBe(0);
      expect(hosts.stdout).toContain("VS Code");
      expect(hosts.stdout).toContain("JetBrains");
      expect(hosts.stdout).toContain("Zed");

      const usage = await runCli(["editor"], home, workdir);
      expect(usage.code).toBe(0);
      expect(usage.stdout).toContain("nyra editor serve");

      const bad = await runCli(["editor", "nope"], home, workdir);
      expect(bad.code).not.toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("preview → apply --yes 全流程：预览不动磁盘，没 --yes 拒绝，--yes 后落盘", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "a.ts"), "a\nb\nc\n", "utf-8");
      const newPath = join(workdir, "new-a.ts");
      writeFileSync(newPath, "a\nB\nc\nd\n", "utf-8");

      const missing = await runCli(["editor", "preview", "--file", "src/nope.ts", "--new", newPath], home, workdir);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("预览失败");

      const prev = await runCli(["editor", "preview", "--file", "src/a.ts", "--new", newPath], home, workdir);
      expect(prev.code).toBe(0);
      expect(prev.stdout).toContain("预览已存");
      expect(prev.stdout).toContain("-b");
      expect(readFileSync(join(workdir, "src", "a.ts"), "utf-8")).toBe("a\nb\nc\n");
      const m = prev.stdout.match(/预览已存：(prv_[0-9a-f]+)/);
      expect(m).not.toBeNull();
      const previewId = m![1]!;

      const noYes = await runCli(["editor", "apply", "--preview", previewId], home, workdir);
      expect(noYes.code).toBe(2);
      expect(readFileSync(join(workdir, "src", "a.ts"), "utf-8")).toBe("a\nb\nc\n");

      const applied = await runCli(["editor", "apply", "--preview", previewId, "--yes"], home, workdir);
      expect(applied.code).toBe(0);
      expect(applied.stdout).toContain("已应用 src/a.ts");
      expect(readFileSync(join(workdir, "src", "a.ts"), "utf-8")).toBe("a\nB\nc\nd\n");

      // 同一个预览只能应用一次。
      const again = await runCli(["editor", "apply", "--preview", previewId, "--yes"], home, workdir);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("应用失败");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("serve 循环真跑起来：hello/ping 回正确回复，坏行不崩", async () => {
    const home = tempDir("nyra-ed5-home-");
    const workdir = tempDir("nyra-ed5-proj-");
    try {
      const input = [
        JSON.stringify({ type: "hello", host: "vscode", version: 1 }),
        JSON.stringify({ type: "ping", id: "p1" }),
        "not json",
        JSON.stringify({ type: "bogus" }),
      ].join("\n") + "\n";
      const proc = Bun.spawn({
        cmd: [process.execPath, CLI, "editor", "serve", "--stdio"],
        cwd: workdir,
        env: { ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0" },
        stdin: new Response(input).body,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(stderr).not.toContain("rl is not defined");
      const replies = stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(replies[0]).toMatchObject({ type: "hello", version: 1 });
      expect(replies[1]).toMatchObject({ type: "pong", id: "p1" });
      expect(replies[2]).toMatchObject({ type: "error" });
      expect(replies[3]).toMatchObject({ type: "error" });
      expect(existsSync(join(home, "evidence", "editor"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
