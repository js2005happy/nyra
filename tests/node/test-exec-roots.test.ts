// tests/node/test-exec-roots.test.ts — 白名单根判定的安全属性（跨平台）。
//
// 白名单判定是**安全边界**，必须单独测、跨平台测。三条踩过的坑：
//   1. 分隔符混用：root 写 `C:/work`、cwd 是 `C:\work\x` —— 直接 startsWith 会误拒
//   2. 前缀当包含：root `/repo` 与 cwd `/repo2` —— 只比字符串会把 `/repo2` 放进来
//   3. Windows 大小写：`C:\Work` 与 `c:\work\x` 是同一个目录
//
// 第 2 条是**安全**属性（放错方向等于越权），第 1、3 条是可用性（误拒只会让人怀疑工具）。
import { test, expect } from "bun:test";
import { isWithinRoots } from "../../src/execDaemon.ts";

const POSIX = { caseInsensitive: false } as const;
const WINDOWS = { caseInsensitive: true } as const;

test("R1 根自身与子路径都算在根内", () => {
  expect(isWithinRoots("/work", ["/work"], POSIX)).toBe(true);
  expect(isWithinRoots("/work/a", ["/work"], POSIX)).toBe(true);
  expect(isWithinRoots("/work/a/b", ["/work"], POSIX)).toBe(true);
});

test("R2 【安全】前缀不能当成包含：/repo2 不在 /repo 里", () => {
  expect(isWithinRoots("/repo2", ["/repo"], POSIX)).toBe(false);
  expect(isWithinRoots("/repo2/x", ["/repo"], POSIX)).toBe(false);
  expect(isWithinRoots("/rep", ["/repo"], POSIX)).toBe(false);
});

test("R3 分隔符混用不影响判定（Windows 上正反斜杠等价）", () => {
  expect(isWithinRoots("C:/work/sub", ["C:\\work"], WINDOWS)).toBe(true);
  expect(isWithinRoots("C:\\work\\sub", ["C:/work"], WINDOWS)).toBe(true);
});

test("R4 根带尾随斜杠也认", () => {
  expect(isWithinRoots("/work/sub", ["/work/"], POSIX)).toBe(true);
  expect(isWithinRoots("/work/sub", ["/work///"], POSIX)).toBe(true);
});

test("R5 Windows 忽略大小写；POSIX 区分", () => {
  expect(isWithinRoots("c:\\work\\x", ["C:\\Work"], WINDOWS)).toBe(true);
  expect(isWithinRoots("/Work/x", ["/work"], POSIX)).toBe(false);
});

test("R6 空白名单 = 不限制（只在明确不需要边界时才该这么用）", () => {
  expect(isWithinRoots("/anywhere", [])).toBe(true);
});

test("R7 多个根：命中任一即可", () => {
  expect(isWithinRoots("/b/x", ["/a", "/b"], POSIX)).toBe(true);
  expect(isWithinRoots("/c/x", ["/a", "/b"], POSIX)).toBe(false);
});

test("R8 【安全】用 `..` 逃逸必须被拒（cwd 由请求方提供，这是真实越权路径）", () => {
  // 这条是写测试时发现的真问题：纯字符串前缀判定会让 `/work/../etc` 通过白名单。
  // 修法是**先 resolve 再比**——cwd 来自请求，攻击者当然可以送 `..`。
  expect(isWithinRoots("/work/../etc", ["/work"], POSIX)).toBe(false);
  expect(isWithinRoots("/work/sub/../../etc", ["/work"], POSIX)).toBe(false);
  // 正常子路径不受影响
  expect(isWithinRoots("/work/sub/./x", ["/work"], POSIX)).toBe(true);
});

test("R9 Windows 上 `..` 逃逸同样被拒", () => {
  expect(isWithinRoots("C:\\work\\..\\Windows", ["C:\\work"], WINDOWS)).toBe(false);
  expect(isWithinRoots("C:\\work\\sub", ["C:\\work"], WINDOWS)).toBe(true);
});
