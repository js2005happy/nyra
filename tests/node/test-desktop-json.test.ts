// tests/node/test-desktop-json.test.ts — 桌面外壳兼容专项（第 3 阶段）。
// Node 版 nyra ui --print-url-json --exit-on-stdin-close：
// stdout 第一行是一行 JSON（nyra/version/url/host/port/token），其中
// nyra 字段固定为 "ui"（桌面外壳契约：Python 版 url_json() 一直返回
// "ui"，桌面端 Rust 的 parse_start_line 要求 nyra == "ui"）；
// 带 token 访问 200、不带 403；关 stdin 后退出码 0。
import { test, expect } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function startUi(home: string): ChildProcessWithoutNullStreams {
  return spawn("bun", ["run", "src/cli.ts", "ui", "--port", "0", "--print-url-json", "--exit-on-stdin-close"], {
    cwd: process.cwd(),
    env: { ...process.env, NYRA_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readFirstLine(child: ChildProcessWithoutNullStreams, timeoutMs = 15000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("等 stdout 首行超时")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) { clearTimeout(timer); resolvePromise(buf.slice(0, idx)); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`进程提前退出（${code}）：${buf}`)); });
  });
}

test("DesktopJsonTest.test_print_url_json_contract", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-desk-"));
  const child = startUi(home);
  const exitPromise = new Promise<number | null>((resolvePromise) => { child.on("exit", (code) => resolvePromise(code)); });
  try {
    const line = await readFirstLine(child);
    const info = JSON.parse(line) as Record<string, unknown>;
    expect(info.nyra).toBe("ui");
    expect(info.version).toBe("0.5.9");
    expect(typeof info.url).toBe("string");
    expect(typeof info.host).toBe("string");
    expect(typeof info.port).toBe("number");
    expect(typeof info.token).toBe("string");
    expect(String(info.token).length).toBeGreaterThan(10);
    const base = `http://127.0.0.1:${info.port}`;
    // 带 token 200，不带 403。
    const ok = await fetch(`${base}/api/health`);
    expect(ok.status).toBe(200);
    const noToken = await fetch(`${base}/api/info`);
    expect(noToken.status).toBe(403);
    const withToken = await fetch(`${base}/api/info`, { headers: { "X-Nyra-Token": String(info.token) } });
    expect(withToken.status).toBe(200);
    // 页面：不带 token 403，带 ?token= 200。
    const pageNo = await fetch(`${base}/`);
    expect(pageNo.status).toBe(403);
    const pageYes = await fetch(`${base}/?token=${info.token}`);
    expect(pageYes.status).toBe(200);
    expect(await pageYes.text()).toContain("Nyra");
    // 关 stdin → 退出码 0。
    child.stdin.end();
    const code = await Promise.race([
      exitPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 10000)),
    ]);
    expect(code).toBe(0);
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}, 30000);

test("DesktopJsonTest.test_ui_without_json_flag_prints_human_lines", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-desk-"));
  const child = spawn("bun", ["run", "src/cli.ts", "ui", "--port", "0"], {
    cwd: process.cwd(),
    env: { ...process.env, NYRA_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const line = await readFirstLine(child);
    expect(line).toContain("网页界面已启动");
    expect(line).not.toContain('"token"');
    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}, 30000);
