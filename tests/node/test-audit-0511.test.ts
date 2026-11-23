// tests/node/test-audit-0511.test.ts — 0.5.11 源码体检的四处修正：
// ① 配对码改用加密安全随机数（crypto.randomInt），不再用可预测的 Math.random；
// ② listSessions 按文件指纹（mtime + 大小 + inode）缓存元数据，文件没变不再整份重读；
// ③ 网关会话列表的 outcome（最后一轮汇总）同样按文件指纹缓存；
// ④ 手机启动器页：电脑地址里自带端口时以它为准，不再拼成 host:8765:8765。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCode, DeviceRegistry } from "../../src/pairing.ts";
import { listSessions, clearSessionListCache, saveSession } from "../../src/memory.ts";
import { Gateway } from "../../src/gateway.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const root = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

// ---- ① 配对码 ------------------------------------------------------------

test("配对码：6 位数字、落在 100000–999999，且不依赖 Math.random", () => {
  const original = Math.random;
  // 把 Math.random 钉死：还用它的话，所有码都会一样。
  Math.random = () => 0.5;
  try {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toMatch(/^\d{6}$/);
      const n = Number(c);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
      codes.add(c);
    }
    expect(codes.size).toBeGreaterThan(150);
    const reg = new DeviceRegistry(join(tmp("nyra-pair-"), "devices.json"));
    const a = reg.startPairing().code;
    const b = reg.startPairing().code;
    const c = reg.startPairing().code;
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  } finally {
    Math.random = original;
  }
  const src = read("src/pairing.ts");
  const fn = src.slice(src.indexOf("export function generateCode"), src.indexOf("export function hashDeviceToken"));
  expect(fn).toContain("randomInt(");
  expect(fn).not.toContain("Math.random");
});

// ---- ② listSessions 缓存 ------------------------------------------------

function sessionFile(home: string, id: string): string {
  return join(home, "sessions", `${id}.jsonl`);
}

test("listSessions：结果与逐份读取一致；追加、新增、删除都能看到", () => {
  clearSessionListCache();
  const home = tmp("nyra-ls-");
  mkdirSync(join(home, "sessions"), { recursive: true });
  saveSession("s-a", [{ role: "system", content: "x" }, { role: "user", content: "第一件事" }], home);
  saveSession("s-b", [{ role: "user", content: "第二件事" }, { role: "assistant", content: "好" }], home);

  const first = listSessions(home);
  expect(first.map((s) => s.id).sort()).toEqual(["s-a", "s-b"]);
  const a1 = first.find((s) => s.id === "s-a")!;
  expect(a1.preview).toBe("第一件事");
  expect(a1.count).toBe(2);

  // 改返回值不会污染缓存
  a1.preview = "被改了";
  expect(listSessions(home).find((s) => s.id === "s-a")!.preview).toBe("第一件事");

  // 追加一行：大小变了，计数跟着变
  appendFileSync(sessionFile(home, "s-a"), JSON.stringify({ role: "assistant", content: "收到" }) + "\n");
  expect(listSessions(home).find((s) => s.id === "s-a")!.count).toBe(3);

  // 原子重写（saveSession = rename）：内容整个换掉也能看到
  saveSession("s-b", [{ role: "user", content: "改过的第二件事" }], home);
  const b = listSessions(home).find((s) => s.id === "s-b")!;
  expect(b.preview).toBe("改过的第二件事");
  expect(b.count).toBe(1);

  // 新增、删除
  saveSession("s-c", [{ role: "user", content: "第三件事" }], home);
  expect(listSessions(home).map((s) => s.id).sort()).toEqual(["s-a", "s-b", "s-c"]);
  unlinkSync(sessionFile(home, "s-a"));
  expect(listSessions(home).map((s) => s.id).sort()).toEqual(["s-b", "s-c"]);
});

test("listSessions：文件指纹没变就不再重读（缓存命中）", () => {
  clearSessionListCache();
  const home = tmp("nyra-ls-hit-");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const path = sessionFile(home, "s-x");
  writeFileSync(path, JSON.stringify({ role: "user", content: "AAAA" }) + "\n");
  const st = statSync(path);
  expect(listSessions(home)[0].preview).toBe("AAAA");
  // 原地改成等长内容并把 mtime 改回去：指纹不变 → 应返回缓存里的旧元数据，证明没有重读文件。
  writeFileSync(path, JSON.stringify({ role: "user", content: "BBBB" }) + "\n");
  utimesSync(path, st.atime, st.mtime);
  const st2 = statSync(path);
  if (st2.mtimeMs === st.mtimeMs && st2.size === st.size && st2.ino === st.ino) {
    expect(listSessions(home)[0].preview).toBe("AAAA");
  }
  // 清掉缓存后读到真实内容
  clearSessionListCache();
  expect(listSessions(home)[0].preview).toBe("BBBB");
});

// ---- ③ 网关 outcome 缓存 --------------------------------------------------

const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("网关会话列表 outcome：按文件指纹缓存，会话改了就重算", () => {
  clearSessionListCache();
  const home = tmp("nyra-gw-outcome-");
  const gw = new Gateway({ home, workdir: tmp("nyra-gw-wd-"), port: 0, host: "127.0.0.1" });
  saveSession("s-o", [
    { role: "user", content: "改一下" },
    { role: "assistant", content: "", tool_calls: [call("e1", "edit_file", { path: "a.ts", old_text: "1", new_text: "2" })] },
    { role: "tool", tool_call_id: "e1", content: "已编辑 a.ts" },
    { role: "assistant", content: "好了" },
  ], home);
  type View = { sessions: { id: string; outcome: { edited: string[]; commands: number } | null }[] };
  const v1 = gw.sessionsView() as unknown as View;
  expect(v1.sessions.find((s) => s.id === "s-o")!.outcome!.edited).toEqual(["a.ts"]);
  // 再取一次：同一份结果（缓存命中返回同一个对象）
  const v2 = gw.sessionsView() as unknown as View;
  expect(v2.sessions.find((s) => s.id === "s-o")!.outcome).toBe(v1.sessions.find((s) => s.id === "s-o")!.outcome);
  // 新一轮落盘：outcome 跟着变
  saveSession("s-o", [
    { role: "user", content: "改一下" },
    { role: "assistant", content: "好了" },
    { role: "user", content: "再改 b" },
    { role: "assistant", content: "", tool_calls: [call("e2", "edit_file", { path: "b.ts", old_text: "1", new_text: "2" })] },
    { role: "tool", tool_call_id: "e2", content: "已编辑 b.ts" },
  ], home);
  const v3 = gw.sessionsView() as unknown as View;
  expect(v3.sessions.find((s) => s.id === "s-o")!.outcome!.edited).toEqual(["b.ts"]);
  // 删掉会话：列表里没了
  unlinkSync(sessionFile(home, "s-o"));
  const v4 = gw.sessionsView() as unknown as View;
  expect(v4.sessions.find((s) => s.id === "s-o")).toBeUndefined();
});

// ---- ④ 启动器页地址里带端口 ----------------------------------------------

function launcherSplitHostPort(): (host: unknown, port: unknown) => { host: string; port: unknown } {
  const html = read("mobile/www/index.html");
  const start = html.indexOf("function splitHostPort(");
  expect(start).toBeGreaterThan(0);
  // 取到函数体结束（下一行起是 if (last && last.host) ...）
  const end = html.indexOf("\n  }\n", start) + 4;
  const src = html.slice(start, end);
  return new Function(`${src}; return splitHostPort;`)() as (host: unknown, port: unknown) => { host: string; port: unknown };
}

test("启动器页：电脑地址里自带端口时以它为准，不再拼成 host:端口:端口", () => {
  const split = launcherSplitHostPort();
  expect(split("192.168.1.23:9000", "8765")).toEqual({ host: "192.168.1.23", port: "9000" });
  expect(split("http://192.168.1.23:8765/m", "1234")).toEqual({ host: "192.168.1.23", port: "8765" });
  expect(split("  my-pc.local  ", "8765")).toEqual({ host: "my-pc.local", port: "8765" });
  expect(split("", 8765)).toEqual({ host: "", port: 8765 });
  const html = read("mobile/www/index.html");
  const goLan = html.slice(html.indexOf("function goLan("), html.indexOf("$('connectBtn').onclick"));
  expect(goLan).toContain("splitHostPort(host, port)");
  // 主机名校验不再放行 :端口（端口已拆出去单独校验）
  expect(goLan).toContain("/^[A-Za-z0-9._-]+$/");
  expect(goLan).not.toContain("(:\\d+)?");
  // 记下的旧地址（可能带端口）载入时也拆开，首屏“上次连的是”不会显示成 a:8765:8765
  expect(html).toContain("var lp = splitHostPort(last.host, last.port)");
});
