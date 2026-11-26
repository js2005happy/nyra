// tests/node/test-session-append.test.ts — 会话保存的增量追加快路径。
//
// 每轮工具调用都会 saveSession；以前每次都整份重写 + fsync，序列化还用逐字符拼的
// pythonJsonDump，长会话越跑越卡。现在：只是末尾多了消息 → 只追加新增行；
// 消息被改写/压缩/回滚、或文件被别处动过 → 仍走原子整写。
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, appendFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, loadSession, sessionPath, clearSessionWriteState } from "../../src/memory.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-sess-append-"));
}

beforeEach(() => clearSessionWriteState());

test("末尾追加消息：文件 inode 不变（走追加），内容与整写一致", () => {
  const home = tmpHome();
  const msgs: Record<string, unknown>[] = [{ role: "user", content: "你好" }];
  const path = saveSession("s1", msgs, home);
  const ino1 = statSync(path).ino;
  msgs.push({ role: "assistant", content: "收到" });
  msgs.push({ role: "tool", tool_call_id: "c1", content: "x".repeat(1000) });
  saveSession("s1", msgs, home);
  if (process.platform !== "win32") expect(statSync(path).ino).toBe(ino1);
  expect(loadSession("s1", home)).toEqual(msgs);
  expect(readFileSync(path, "utf-8")).toBe(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
});

test("中间消息被改写：退回原子整写（inode 变），内容正确，不留临时文件", () => {
  const home = tmpHome();
  const msgs: Record<string, unknown>[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const path = saveSession("s2", msgs, home);
  const ino1 = statSync(path).ino;
  msgs[0] = { role: "user", content: "a（改过）" };
  msgs.push({ role: "assistant", content: "c" });
  saveSession("s2", msgs, home);
  if (process.platform !== "win32") expect(statSync(path).ino).not.toBe(ino1);
  expect(loadSession("s2", home)).toEqual(msgs);
  expect(readdirSync(join(home, "sessions")).filter((n) => n.startsWith(".nyra-session-"))).toEqual([]);
});

test("变短（回滚/压缩）：整写成新内容", () => {
  const home = tmpHome();
  const msgs = [{ role: "user", content: "1" }, { role: "assistant", content: "2" }, { role: "user", content: "3" }];
  saveSession("s3", msgs, home);
  saveSession("s3", msgs.slice(0, 1), home);
  expect(loadSession("s3", home)).toEqual(msgs.slice(0, 1));
});

test("文件被别处改过（指纹不符）：不追加到别人的内容后面，整写覆盖成我们的版本", () => {
  const home = tmpHome();
  const msgs: Record<string, unknown>[] = [{ role: "user", content: "a" }];
  const path = saveSession("s4", msgs, home);
  appendFileSync(path, JSON.stringify({ role: "user", content: "别的进程写的" }) + "\n");
  msgs.push({ role: "assistant", content: "b" });
  saveSession("s4", msgs, home);
  expect(loadSession("s4", home)).toEqual(msgs);
});

test("文件被删掉后再保存：重新整写，不报错", () => {
  const home = tmpHome();
  const msgs: Record<string, unknown>[] = [{ role: "user", content: "a" }];
  const path = saveSession("s5", msgs, home);
  rmSync(path);
  msgs.push({ role: "assistant", content: "b" });
  saveSession("s5", msgs, home);
  expect(loadSession("s5", home)).toEqual(msgs);
});

test("追加中途崩溃留下半行：读取跳过坏行，之前的消息完好", () => {
  const home = tmpHome();
  const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const path = saveSession("s6", msgs, home);
  writeFileSync(path, readFileSync(path, "utf-8") + '{"role":"tool","content":"半');
  expect(loadSession("s6", home)).toEqual(msgs);
});

test("长会话逐轮保存：400 轮后内容一致", () => {
  const home = tmpHome();
  const live: Record<string, unknown>[] = [];
  for (let i = 0; i < 400; i++) {
    live.push(i % 2 ? { role: "tool", tool_call_id: `c${i - 1}`, content: `结果 ${i} ` + "y".repeat(200) } : { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "shell", arguments: "{}" } }] });
    saveSession("s7", live, home);
  }
  expect(loadSession("s7", home)).toEqual(live);
  expect(sessionPath("s7", home)).toContain("s7.jsonl");
});
