// tests/node/cli.test.ts — 对已编出的 Linux 二进制做黑盒验收。
// 要求先跑 scripts/build-binaries.sh --only linux-x64；没编出来就跳过，
// 不让本测试在没产物的机器上误报失败。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "../../dist/nyra-linux-x64");
const HAS_BIN = existsSync(BIN);

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-test-"));
  const proc = Bun.spawnSync([BIN, ...args], {
    env: {
      ...process.env,
      HOME: home,
      NYRA_HOME: join(home, ".nyra"),
      NYRA_LANG: "zh", // 断言的是中文界面文案
      ...env,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

test("二进制 --help / --version 不用 Key，退出 0", () => {
  if (!HAS_BIN) { console.log("跳过：dist/nyra-linux-x64 未编出"); return; }
  expect(run(["--help"]).code).toBe(0);
  const v = run(["--version"]);
  expect(v.code).toBe(0);
  expect(v.out).toMatch("nyra 0.5.12");
});

test("无 Key 跑任务：打印中文设置说明，退出码 1", () => {
  if (!HAS_BIN) { console.log("跳过：dist/nyra-linux-x64 未编出"); return; }
  const r = run(["--provider", "qwen", "解释一下这个项目"], { DASHSCOPE_API_KEY: "" });
  expect(r.code).toBe(1);
  expect(r.out).toMatch("未找到可用的 API 凭据");
});

test("有 Key 跑模型任务：假 Key 真实调接口，120s 超时后退出码 1（第 3 阶段改写）", () => {
  // 第 1 阶段的期望（退出码 2、“第 2 阶段”未实现提示）已过期：第 2 阶段已实现
  // provider，带 Key 时二进制会真实调 DashScope。假 Key 在本沙箱网络黑洞下
  // 等满 provider 默认 120s 超时才报错退出 1（实测 2026-11-19：exit=1，
  // “错误：ProviderError: API 请求超时，请稍后重试”）。provider 默认超时是
  // 第 2 阶段的设计，本阶段不改；是否收紧属第 4 阶段议题。
  // 2026-11-19 16:xx 更新：上游行为变了——DashScope 现对假 Key 直接回 HTTP 401
  // “Incorrect API key provided”（约 1.5 秒），不再等满 120 秒超时。测试本意是
  // “假 Key 被上游拒绝、退出码 1”，两种报错都算通过；产品代码未动。
  if (!HAS_BIN) { console.log("跳过：dist/nyra-linux-x64 未编出"); return; }
  const r = run(["--provider", "qwen", "hi"], { DASHSCOPE_API_KEY: "sk-test" });
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/API 请求超时|认证失败 \(HTTP 401\)/);
  expect(r.out).not.toMatch("第 2 阶段");
}, 150000);

test("--example 本地任务成功，退出 0", () => {
  if (!HAS_BIN) { console.log("跳过：dist/nyra-linux-x64 未编出"); return; }
  const r = run(["--example"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch("sqlite rows=100");
});
