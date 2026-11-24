// 会话保存基准：bun scripts/bench-session-save.ts <仓库根目录>（默认当前目录）。
// 400 条约 4MB 的会话：序列化耗时、单次整写、逐轮保存 400 次的总耗时。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const repo = process.argv[2] ?? process.cwd();
const { saveSession, loadSession } = await import(join(repo, "src/memory.ts"));
const { pythonJsonDump } = await import(join(repo, "src/pyjson.ts"));
const blob = "数据 line of tool output with some text, ".repeat(500); // ~20KB
const msgs: Record<string, unknown>[] = [];
for (let i = 0; i < 400; i++) {
  msgs.push(i % 2 === 0
    ? { role: "assistant", content: "", tool_calls: [{ id: "c" + i, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "ls -la " + i }) } }] }
    : { role: "tool", tool_call_id: "c" + (i - 1), content: blob + i });
}
const bytes = msgs.map((m) => JSON.stringify(m)).join("\n").length;
let t = performance.now();
for (let k = 0; k < 5; k++) msgs.map((m) => pythonJsonDump(m)).join("\n");
const py = (performance.now() - t) / 5;
t = performance.now();
for (let k = 0; k < 5; k++) msgs.map((m) => JSON.stringify(m)).join("\n");
const js = (performance.now() - t) / 5;
const home = mkdtempSync(join(tmpdir(), "nyra-bench-"));
// full single save of 400 msgs (cold, new session id each time)
t = performance.now();
for (let k = 0; k < 5; k++) saveSession("bench-full-" + k, msgs, home);
const full = (performance.now() - t) / 5;
// per-turn: grow from 1..400, save each turn (agent loop pattern)
const live: Record<string, unknown>[] = [];
t = performance.now();
let last = 0, lastT = t;
for (let i = 0; i < 400; i++) { live.push(msgs[i]); const s = performance.now(); saveSession("bench-turns", live, home); last = performance.now() - s; }
const turns = performance.now() - t;
const back = loadSession("bench-turns", home)!;
console.log(JSON.stringify({ sessionMB: +(bytes / 1e6).toFixed(2), pythonJsonDumpMs: +py.toFixed(1), jsonStringifyMs: +js.toFixed(1), saveSession400Ms: +full.toFixed(1), perTurn400TotalMs: +turns.toFixed(0), lastTurnSaveMs: +last.toFixed(1), roundTripOk: JSON.stringify(back) === JSON.stringify(live) }));
