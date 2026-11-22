// tests/node/doctor.test.ts — `nyra doctor` 三种故障与全绿对照。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, runtimeVersionOk } from "../../src/doctor.ts";
import { getSandboxStatus } from "../../src/sandbox.ts";
import { saveConfig } from "../../src/config.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-doctor-test-"));
}

const failingFetch = (async () => { throw new Error("ECONNREFUSED（测试注入）"); }) as unknown as typeof fetch;
const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

test("无 Key：模型配置项失败，给出 export 指引", async () => {
  const home = tmpHome();
  delete process.env.DEEPSEEK_API_KEY;
  const { checks, allOk } = await runDoctor({ home, fetchFn: okFetch });
  expect(allOk).toBe(false);
  const model = checks.find((c) => c.name === "模型配置")!;
  expect(model.ok).toBe(false);
  expect(model.fix).toMatch("DEEPSEEK_API_KEY");
});

test("配置目录权限不对：755 时失败，给出 chmod 700 指引；修好后通过", async () => {
  // Windows 没有 POSIX 权限位，doctor 本身也不检查，整个用例跳过。
  if (process.platform === "win32") return;
  const home = tmpHome();
  mkdirSync(home, { recursive: true });
  saveConfig(home, {});
  chmodSync(home, 0o755);
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const bad = await runDoctor({ home, fetchFn: okFetch });
    const dir = bad.checks.find((c) => c.name === "配置目录")!;
    expect(dir.ok).toBe(false);
    expect(dir.detail).toMatch("755");
    expect(dir.fix).toMatch("chmod 700");
    chmodSync(home, 0o700);
    const good = await runDoctor({ home, fetchFn: okFetch });
    expect(good.checks.find((c) => c.name === "配置目录")!.ok).toBe(true);
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("网络不通：注入必失败的 fetch，网络项失败并给 4 步指引", async () => {
  const home = tmpHome();
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { checks, allOk } = await runDoctor({ home, fetchFn: failingFetch });
    expect(allOk).toBe(false);
    const net = checks.find((c) => c.name === "网络")!;
    expect(net.ok).toBe(false);
    expect(net.fix).toMatch("检查网络是否通");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("全绿对照：有 Key + 网络通 + 目录 0700，全部通过", async () => {
  const home = tmpHome();
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { checks, allOk } = await runDoctor({ home, fetchFn: okFetch });
    expect(allOk).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toContain("写权限");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("runtimeVersionOk：Bun < 1.4 与 Node < 24 不通过，够新的通过", () => {
  expect(runtimeVersionOk("Bun 1.3.9")).toBe(false);
  expect(runtimeVersionOk("Bun 1.4.0")).toBe(true);
  expect(runtimeVersionOk("Bun 1.4.4")).toBe(true);
  expect(runtimeVersionOk("Node v22.5.1")).toBe(false);
  expect(runtimeVersionOk("Node v24.0.0")).toBe(true);
  expect(runtimeVersionOk("Node v24.22.1")).toBe(true);
  expect(runtimeVersionOk("something else")).toBe(false);
});

test("vault.json 存在且权限不对时报出 0600 指引", async () => {
  // Windows 没有 POSIX 权限位，doctor 对 vault.json 直接报通过，整个用例跳过。
  if (process.platform === "win32") return;
  const home = tmpHome();
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    writeFileSync(join(home, "vault.json"), "{}", "utf-8");
    chmodSync(join(home, "vault.json"), 0o644);
    const { checks } = await runDoctor({ home, fetchFn: okFetch });
    const vault = checks.find((c) => c.name === "密码箱权限")!;
    expect(vault.ok).toBe(false);
    expect(vault.fix).toMatch("chmod 600");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

// 隔离补强批：doctor 的隔离级别行列出三后端可用性，不只报 bwrap。
// 可用性按本机实测断言（不写死 bwrap 可用：虚拟机换代后 apt 装的 bwrap 会丢，
// 本机当时可能无 bwrap；断言以 getSandboxStatus 的实测为准）。
test("隔离级别行列出 bwrap/Seatbelt/Job Object 三后端可用性", async () => {
  const home = tmpHome();
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    saveConfig(home, {});
    const { checks } = await runDoctor({ home, fetchFn: okFetch });
    const sb = checks.find((c) => c.name === "隔离级别")!;
    expect(sb.ok).toBe(true);
    const s = getSandboxStatus({});
    expect(sb.detail).toMatch(`bwrap ${s.bwrapAvailable ? "可用" : "不可用"}`);
    expect(sb.detail).toMatch(`Seatbelt ${s.seatbeltAvailable ? "可用" : "不可用"}`);
    expect(sb.detail).toMatch(`Job Object ${s.jobObjectAvailable ? "可用" : "不可用"}`);
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});
