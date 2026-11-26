// 直接执行的 POSIX shell 入口必须在 git 索引里是 100755。
// 工作区的 stat 在 Windows 上反映不出可执行位，所以这里读 `git ls-files -s`。
// --help 只在非 Windows 上直接执行，并且只覆盖帮助在下载/打包之前就退出的脚本。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

/** 用法写成 `./scripts/...` 的 shell 入口。不含 install-node.ps1。 */
const DIRECT_SHELL_ENTRYPOINTS = [
  "scripts/install-node.sh",
  "scripts/install-node-macos.sh",
  "scripts/build-binaries.sh",
  "scripts/build-package-node.sh",
  "scripts/verify-release.sh",
] as const;

/** --help 在任何下载、打包或验签之前退出。verify-release.sh 没有 --help。 */
const HELP_ENTRYPOINTS = [
  "scripts/install-node.sh",
  "scripts/install-node-macos.sh",
  "scripts/build-binaries.sh",
  "scripts/build-package-node.sh",
] as const;

function gitIndexMode(path: string): string {
  const result = spawnSync("git", ["ls-files", "-s", "--", path], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 15000,
  });
  expect(result.status, result.stderr).toBe(0);
  const mode = result.stdout.trim().split(/\s+/, 1)[0] ?? "";
  expect(mode, result.stdout).toMatch(/^100(644|755)$/);
  return mode;
}

test("直接执行的 shell 入口在 git 索引中是 100755", () => {
  for (const path of DIRECT_SHELL_ENTRYPOINTS) {
    expect(gitIndexMode(path), path).toBe("100755");
  }
});

test("POSIX 上直接执行 --help 不联网、退出码为 0", () => {
  if (process.platform === "win32") return;
  for (const path of HELP_ENTRYPOINTS) {
    const result = spawnSync(join(repoRoot, path), ["--help"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15000,
    });
    expect(result.status, `${path}\n${result.stderr}`).toBe(0);
    expect(result.stdout, path).toContain("--help");
    expect(result.stdout, path).not.toMatch(/https?:\/\//);
  }
});
