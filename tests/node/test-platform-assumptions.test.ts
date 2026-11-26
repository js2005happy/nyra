// tests/node/test-platform-assumptions.test.ts — 把「跨平台路径与权限假设」固化成测试。
//
// 由来：一次只读核对里我手动验过这些假设（chmod 在 Windows 不抛、tmpdir 带符号链接前缀时
// 评测输出仍能写），核对完就散了——下次有人改同一块代码，还得再手动验一遍。
// 这里把结论钉住：**回归直接从 CI 红**，不用靠人记得。
//
// 重点锁的是 2026-11 修掉的那个真缺陷：
//   macOS 的 `os.tmpdir()` 是 `/var/folders/…`，而 `/var` 是指向 `/private/var` 的符号链接。
//   旧实现从目标路径一路向上做符号链接检查，走到 `/var` 就抛错 → macOS 上整套 Eval 全挂。
//   正确语义：**只查信任根之下**；根之上的系统级链接不归我们管。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvalJson, safeEvalPath } from "../../src/eval/runner.ts";
import { expectPerms, IS_WINDOWS } from "./fsPerms.ts";

function tmp(prefix = "nyra-plat-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("P1 写入评测报告：权限 0600（Windows 上不做断言，那里没有 POSIX 位）", () => {
  const dir = tmp();
  const p = join(dir, "report.json");
  writeEvalJson(p, { a: 1 });
  expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ a: 1 });
  expectPerms(p, 0o600);
});

test("P2 覆盖写是原子的：不留下 .tmp 残渣", () => {
  const dir = tmp();
  const p = join(dir, "report.json");
  writeEvalJson(p, { a: 1 });
  writeEvalJson(p, { a: 2 });
  expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ a: 2 });
  const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  expect(leftovers).toEqual([]);
});

test("P3 信任根**之上**的符号链接必须被接受（macOS /var → /private/var 的回归防线）", () => {
  if (IS_WINDOWS) return; // Windows 建符号链接需要额外权限，跳过
  const real = tmp("nyra-real-");
  const linkParent = tmp("nyra-link-");
  const link = join(linkParent, "var-like");
  symlinkSync(real, link, "dir");

  // 路径经过符号链接（模拟 /var），文件名本身没问题 → 必须能写
  const p = join(link, "nested", "report.json");
  expect(() => writeEvalJson(p, { ok: true })).not.toThrow();
  expect(readFileSync(p, "utf-8")).toContain('"ok": true');

  rmSync(linkParent, { recursive: true, force: true });
  rmSync(real, { recursive: true, force: true });
});

test("P4 信任根**之下**的符号链接必须被拒（原意图不能因为 P3 丢掉）", () => {
  if (IS_WINDOWS) return;
  const root = tmp("nyra-root-");
  const outside = tmp("nyra-out-");
  writeFileSync(join(outside, "secret.json"), "{}");
  symlinkSync(join(outside, "secret.json"), join(root, "linked.json"));

  // 传了 root：root 之下的链接要拒
  expect(() => writeEvalJson(join(root, "linked.json"), {}, root)).toThrow();

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("P5 路径穿越必须被拒（../ 与绝对路径都要挡）", () => {
  const root = tmp("nyra-evalroot-");
  expect(() => safeEvalPath(root, "../escape.json")).toThrow();
  expect(() => safeEvalPath(root, "/etc/passwd")).toThrow();
  // 正常相对路径要通
  expect(() => safeEvalPath(root, "results/report.json")).not.toThrow();
  rmSync(root, { recursive: true, force: true });
});

test("P7 目录模式 0700：在 POSIX 上生效，在 Windows 上不抛", () => {
  const dir = join(tmp("nyra-mode-"), "nested");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 这里只断言"不抛"——Windows 没有 POSIX 位，强制断言会让它红得没有意义
  expect(() => writeEvalJson(join(dir, "x.json"), {})).not.toThrow();
  if (!IS_WINDOWS) expectPerms(join(dir, "x.json"), 0o600);
});
