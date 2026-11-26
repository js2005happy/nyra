// tests/node/test-exec-daemon-tree.test.ts — 超时后**孙进程必须真的死掉**。
//
// 现有 D2 只断言"超时被标记且及时返回"。这不够：
// 我们真正承诺的是"杀掉整棵进程树"，而原来只 kill 顶层 shell 时，
// 孙进程仍然活着并继续持有 stdout 管道——那种情况下客户端**也会**及时返回（因为我们
// 不等 close 了），所以 D2 绿着、进程却还在跑。
//
// 这组测试用「心跳文件」直接观察孙进程是否还活着：
//   1. 起一个每 200ms 往文件追加一行的孙进程
//   2. 让 daemon 在 800ms 后超时并杀树
//   3. 记录文件大小 → 等 1.5s → 再记录
//   4. 两次数值必须相同（孙进程已死）；如果它还在跑，文件会继续变大
//
// 三平台都跑：Windows 走 `taskkill /T /F`，POSIX 走 `detached` 进程组 + `kill(-pid)`。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExecDaemon, ExecDaemonClient } from "../../src/execDaemon.ts";

/** 写一个最小心跳脚本：每 200ms 往文件追加一个字符，永不退出。 */
function heartbeatScript(dir: string): { script: string; beat: string } {
  const beat = join(dir, "beat.log");
  const script = join(dir, "beat.cjs");
  writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      'const target = process.argv[2];',
      'fs.writeFileSync(target, "");',
      'setInterval(() => { try { fs.appendFileSync(target, "x"); } catch {} }, 200);',
    ].join("\n"),
    "utf-8",
  );
  return { script, beat };
}

/** 命令里带空格路径要加引号（Windows 的 Program Files 会遇到）。 */
function quote(p: string): string {
  return `"${p}"`;
}

test("T1 超时后孙进程必须停止写入（整棵进程树被杀）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-tree-"));
  const { script, beat } = heartbeatScript(dir);
  const d = await startExecDaemon();
  const c = new ExecDaemonClient({ port: d.port, token: d.token });
  try {
    const cmd = `${quote(process.execPath)} ${quote(script)} ${quote(beat)}`;
    const r = await c.run(cmd, { timeoutMs: 800 });
    expect(r.timedOut).toBe(true);

    // 心跳文件此刻应已存在（孙进程启动过）
    expect(existsSync(beat)).toBe(true);

    // 关键：`taskkill /T /F`（以及 POSIX 的 kill）都是**异步**的，返回时进程可能还没死透，
    // 会再写最后一行。所以先给一个沉降窗口，再用两个时间点比较——
    // 断言的是"最终会停"，不是"返回瞬间零字节"（后者是竞态，本地实测会假红：3 -> 4）。
    await new Promise((res) => setTimeout(res, 800));
    const sizeAtKill = statSync(beat).size;
    await new Promise((res) => setTimeout(res, 1500));
    const sizeAfter = statSync(beat).size;
    expect(sizeAfter).toBe(sizeAtKill);
  } finally {
    await d.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("T2 正常结束的命令不受影响（没有被误杀）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-tree-ok-"));
  const script = join(dir, "once.cjs");
  const out = join(dir, "out.txt");
  writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], "done");', "utf-8");
  const d = await startExecDaemon();
  const c = new ExecDaemonClient({ port: d.port, token: d.token });
  try {
    const r = await c.run(`${quote(process.execPath)} ${quote(script)} ${quote(out)}`, { timeoutMs: 10000 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(existsSync(out)).toBe(true);
  } finally {
    await d.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
