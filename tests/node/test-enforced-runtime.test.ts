// tests/node/test-enforced-runtime.test.ts — config.enforced 必须真的在运行时生效。
//
// 背景（我自己的漏洞）：#82 加的 `config.enforced` 只接进了 CLI 的命令行选项，
// 而运行时的几条读取路径**仍直接读 config.json 顶层**：
//   · `deny_read_globs`（tools.ts 的禁读清单缓存）
//   · `permissions`（tools.ts 的权限规则缓存）
//   · `sandbox` / `sandbox_mode`（config.ts 的 resolveSandbox）
// 于是「锁了」其实没锁——功能做成摆设。这比没有这个功能更糟：用户以为自己锁住了。
//
// 这组测试锁的是**优先级**：enforced 值压过配置文件值，环境变量仍最高（排障用）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveValue, effectiveStringList, enforcedOnly } from "../../src/enforcedConfig.ts";
import { resolveVerifyOrigin } from "../../src/runs.ts";
import { isDenyReadPath, resetDenyReadCache } from "../../src/tools.ts";
import { resolveSandbox } from "../../src/config.ts";

function homeWith(cfg: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-enf-rt-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg), "utf-8");
  resetDenyReadCache();
  return home;
}

test("effectiveValue：enforced 优先于顶层同名字段", () => {
  expect(effectiveValue({ sandbox: "local", enforced: { sandbox: "bwrap" } }, "sandbox")).toBe("bwrap");
  expect(effectiveValue({ sandbox: "local" }, "sandbox")).toBe("local");
  expect(effectiveValue({ enforced: { sandbox: "bwrap" } }, "sandbox")).toBe("bwrap");
});

test("effectiveValue：没锁且没配 → undefined（不编默认值）", () => {
  expect(effectiveValue({}, "sandbox")).toBeUndefined();
  expect(effectiveValue(null, "sandbox")).toBeUndefined();
});

test("effectiveStringList：非数组 / 含非字符串项都过滤掉", () => {
  expect(effectiveStringList({ denied: 1 }, "denied")).toEqual([]);
  expect(effectiveStringList({ denied: [".env", "", 3, " *.pem "] }, "denied")).toEqual([".env", " *.pem "]);
});

test("运行时关键：锁了 deny_read_globs，顶层清空也拦得住", () => {
  const home = homeWith({
    deny_read_globs: [],                       // 用户（或 agent）把顶层清单清空
    enforced: { deny_read_globs: [".env"] },    // 管理员锁住
  });
  const ctx = { home, workdir: home } as never;
  expect(isDenyReadPath(ctx, join(home, ".env"))).not.toBeNull();
});

test("运行时关键：没锁时按顶层来（锁不生效的地方不能被误伤）", () => {
  const home = homeWith({ deny_read_globs: [], enforced: {} });
  const ctx = { home, workdir: home } as never;
  expect(isDenyReadPath(ctx, join(home, ".env"))).toBeNull();
});

test("运行时关键：锁了 sandbox，顶层改成 local 也不生效", () => {
  const r = resolveSandbox({ sandbox: "local", enforced: { sandbox: "bwrap" } });
  expect(String(r.backend)).toContain("bwrap");
});

test("运行时关键：锁了 sandbox_mode，顶层写 danger-full-access 也不生效", () => {
  const r = resolveSandbox({ sandbox_mode: "danger-full-access", enforced: { sandbox_mode: "read-only" } });
  expect(String(r.mode)).toBe("read-only");
});

test("没锁时 sandbox 仍按顶层走（回归保护）", () => {
  const r = resolveSandbox({ sandbox: "local" });
  expect(String(r.backend)).not.toContain("bwrap");
});

// ---- 另外三个可锁键的运行时生效（同一类问题：锁了但没读）----
// 上一个 PR 修了 deny_read_globs / permissions / sandbox；这里补齐每任务硬顶、
// 校验命令、工具裁剪——它们原先也直接读 config.json 顶层。

test("锁定 max_cost_usd 时，改 config 也放宽不了（月度上限已移除，锁的是每任务硬顶）", () => {
  expect(effectiveValue({ max_cost_usd: 100, enforced: { max_cost_usd: 10 } }, "max_cost_usd")).toBe(10);
  expect(effectiveValue({ max_cost_usd: null, enforced: { max_cost_usd: 10 } }, "max_cost_usd")).toBe(10);
});

test("未锁 max_cost_usd 时仍按顶层走（锁不影响正常优先级）", () => {
  expect(effectiveValue({ max_cost_usd: 100 }, "max_cost_usd")).toBe(100);
  expect(effectiveValue({ max_cost_usd: null }, "max_cost_usd")).toBeNull();
});

test("锁定 verify_command 时，config 里的校验命令被顶掉", () => {
  const [cmd] = resolveVerifyOrigin(null, { verify_command: "npm test", enforced: { verify_command: "true" } });
  expect(cmd).toBe("true");
  const [plain] = resolveVerifyOrigin(null, { verify_command: "npm test" });
  expect(plain).toBe("npm test");
});

test("锁定 disabled_tools 时生效（否则「禁用某工具」可被改 config 绕过）", () => {
  const dis = effectiveStringList({ disabled_tools: ["a"], enforced: { disabled_tools: ["b", "c"] } }, "disabled_tools");
  expect(dis).toEqual(["b", "c"]);
});

test("enforcedOnly 只在被锁时给值（防优先级判断失效——这个坑真踩过）", () => {
  expect(enforcedOnly({ max_cost_usd: 100 }, "max_cost_usd")).toBeUndefined();
  expect(enforcedOnly({ enforced: { max_cost_usd: 10 } }, "max_cost_usd")).toBe(10);
  // 月度上限已移除：它不再是可锁键，锁了也不生效。
  expect(enforcedOnly({ enforced: { monthly_cost_limit_usd: 10 } }, "monthly_cost_limit_usd")).toBeUndefined();
});