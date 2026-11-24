// 安装脚本的发布校验：本地夹具与 cosign 替身，不下载、不运行网络上的二进制。
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "../..");
const lib = join(root, "scripts/release-verify-lib.sh");

function toBashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "nyra-install-verify-"));
}

function mockCosign(dir: string, exitCode = 0): string {
  const path = join(dir, "cosign-mock");
  writeFileSync(
    path,
    `#!/bin/bash
printf '%s\\n' "$*" >> "$NYRA_COSIGN_LOG"
exit ${exitCode}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("InstallerVerifyTest.test_scripts_parse_and_do_not_follow_latest_twice", () => {
  for (const file of ["scripts/install-node.sh", "scripts/install-node-macos.sh", "scripts/verify-release.sh", "scripts/release-verify-lib.sh"]) {
    const syntax = spawnSync("bash", ["-n", join(root, file)], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  }
  for (const file of ["scripts/install-node.sh", "scripts/install-node-macos.sh", "scripts/install-node.ps1"]) {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).not.toContain("releases/latest/download");
    expect(text).toContain("只解析一次");
  }
  const ps1 = readFileSync(join(root, "scripts/install-node.ps1"), "utf8");
  expect(ps1).toContain("Test-NyraReleaseMaterial");
  expect(ps1).toContain("--bundle");
  expect(ps1).toContain("只核对哈希不能证明发布者");
});

test("InstallerVerifyTest.test_latest_resolves_once_into_immutable_urls", () => {
  const dir = fixtureDir();
  const json = join(dir, "latest.json");
  writeFileSync(json, '{"tag_name":"v0.5.1","body":"also mentions v9.9.9"}\n');
  const run = bash(
    `
    . "${lib}"
    tag="$(nyra_resolve_release_tag latest)"
    sums="$(nyra_download_url js2005happy/nyra "$tag" SHA256SUMS)"
    bin="$(nyra_download_url js2005happy/nyra "$tag" nyra-linux-x64)"
    printf '%s\\n%s\\n%s\\n' "$tag" "$sums" "$bin"
    nyra_download_url js2005happy/nyra latest nyra-linux-x64
    `,
    { NYRA_LATEST_JSON_FILE: json },
  );
  expect(run.status).toBe(1);
  const lines = run.stdout.trim().split("\n");
  expect(lines[0]).toBe("v0.5.1");
  expect(lines[1]).toBe("https://github.com/js2005happy/nyra/releases/download/v0.5.1/SHA256SUMS");
  expect(lines[2]).toBe("https://github.com/js2005happy/nyra/releases/download/v0.5.1/nyra-linux-x64");
  expect(run.stdout).not.toContain("/latest/");
  expect(run.stderr).toContain("不能是 latest");
  const explicit = bash(`. "${lib}"; nyra_download_url js2005happy/nyra "$(nyra_resolve_release_tag 0.5.1)" nyra-macos-arm64`);
  expect(explicit.stdout.trim()).toBe("https://github.com/js2005happy/nyra/releases/download/v0.5.1/nyra-macos-arm64");
});

test("InstallerVerifyTest.test_happy_path_signature_then_hash", () => {
  const dir = fixtureDir();
  const log = join(dir, "cosign.log");
  writeFileSync(log, "");
  const cosign = mockCosign(dir, 0);
  const body = "hello release\n";
  writeFileSync(join(dir, "nyra-linux-x64"), body);
  const hash = sha256Hex(body);
  writeFileSync(join(dir, "SHA256SUMS"), `${hash}  nyra-linux-x64\n`);
  writeFileSync(join(dir, "SHA256SUMS.bundle"), "fixture-bundle\n");
  const run = bash(
    `. "${toBashPath(lib)}"; nyra_verify_asset_dir "${toBashPath(dir)}" nyra-linux-x64 "${toBashPath(join(dir, "nyra-linux-x64"))}"`,
    { NYRA_COSIGN: toBashPath(cosign), NYRA_COSIGN_LOG: toBashPath(log) },
  );
  expect(run.status, run.stderr).toBe(0);
  const recorded = readFileSync(log, "utf8");
  expect(recorded).toContain("--bundle");
  expect(recorded).toContain("SHA256SUMS.bundle");
  expect(recorded).toContain("certificate-identity-regexp");
  expect(recorded).toContain("release-sign");
  expect(recorded).toContain(toBashPath(join(dir, "SHA256SUMS")));
});

test("InstallerVerifyTest.test_tamper_mismatch_missing_and_bad_signature", () => {
  const dir = fixtureDir();
  const log = join(dir, "cosign.log");
  writeFileSync(log, "");
  const cosign = mockCosign(dir, 0);
  const file = join(dir, "nyra-linux-x64");
  writeFileSync(file, "hello release\n");
  const hash = sha256Hex("hello release\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${hash}  nyra-linux-x64\n`);
  writeFileSync(join(dir, "SHA256SUMS.bundle"), "fixture-bundle\n");

  writeFileSync(file, "hello releasf\n");
  const tamper = bash(
    `. "${toBashPath(lib)}"; nyra_verify_asset_dir "${toBashPath(dir)}" nyra-linux-x64 "${toBashPath(file)}"`,
    { NYRA_COSIGN: toBashPath(cosign), NYRA_COSIGN_LOG: toBashPath(log) },
  );
  expect(tamper.status).toBe(1);
  expect(tamper.stderr).toContain("哈希不匹配");

  const missingSums = fixtureDir();
  writeFileSync(join(missingSums, "nyra-linux-x64"), "x");
  const noSums = bash(
    `. "${toBashPath(lib)}"; nyra_verify_asset_dir "${toBashPath(missingSums)}" nyra-linux-x64 "${toBashPath(join(missingSums, "nyra-linux-x64"))}"`,
    { NYRA_COSIGN: toBashPath(cosign), NYRA_COSIGN_LOG: toBashPath(log) },
  );
  expect(noSums.status).toBe(1);
  expect(noSums.stderr).toContain("没有 SHA256SUMS");

  const malformed = fixtureDir();
  writeFileSync(join(malformed, "nyra-linux-x64"), "x");
  writeFileSync(join(malformed, "SHA256SUMS"), `not-a-hash  nyra-linux-x64\n${hash}  nyra-linux-x64\n`);
  writeFileSync(join(malformed, "SHA256SUMS.bundle"), "fixture-bundle\n");
  const badLine = bash(
    `. "${toBashPath(lib)}"; nyra_verify_asset_dir "${toBashPath(malformed)}" nyra-linux-x64 "${toBashPath(join(malformed, "nyra-linux-x64"))}"`,
    { NYRA_COSIGN: toBashPath(cosign), NYRA_COSIGN_LOG: toBashPath(log) },
  );
  expect(badLine.status).toBe(1);
  expect(badLine.stderr).toContain("格式不对");

  const unsigned = fixtureDir();
  writeFileSync(join(unsigned, "nyra-linux-x64"), "hello release\n");
  writeFileSync(join(unsigned, "SHA256SUMS"), `${hash}  nyra-linux-x64\n`);
  const noSig = bash(
    `. "${toBashPath(lib)}"; nyra_verify_asset_dir "${toBashPath(unsigned)}" nyra-linux-x64 "${toBashPath(join(unsigned, "nyra-linux-x64"))}"`,
    { NYRA_COSIGN: toBashPath(cosign), NYRA_COSIGN_LOG: toBashPath(log) },
  );
  expect(noSig.status).toBe(1);
  expect(noSig.stderr).toContain("缺少签名材料");
  expect(noSig.stderr).toContain("不能证明发布者");

  const reject = fixtureDir();
  const rejecting = mockCosign(reject, 1);
  writeFileSync(join(reject, "nyra-linux-x64"), "hello release\n");
  writeFileSync(join(reject, "SHA256SUMS"), `${hash}  nyra-linux-x64\n`);
  writeFileSync(join(reject, "SHA256SUMS.bundle"), "fixture-bundle\n");
  const denied = bash(
    `. "${toBashPath(lib)}"; nyra_verify_asset_dir "${toBashPath(reject)}" nyra-linux-x64 "${toBashPath(join(reject, "nyra-linux-x64"))}"`,
    { NYRA_COSIGN: toBashPath(rejecting), NYRA_COSIGN_LOG: toBashPath(log) },
  );
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain("签名验证失败");
});

test("InstallerVerifyTest.test_verify_release_script_local_fixture", () => {
  const dir = fixtureDir();
  const log = join(dir, "cosign.log");
  writeFileSync(log, "");
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const cosign = mockCosign(dir, 0);
  // 替身要叫在 PATH 里，verify-release.sh 的 need 走 command -v。
  copyFileSync(cosign, join(binDir, "cosign"));
  chmodSync(join(binDir, "cosign"), 0o755);
  const file = join(dir, "nyra-linux-x64");
  const body = "hello release\n";
  writeFileSync(file, body);
  const hash = sha256Hex(body);
  writeFileSync(join(dir, "SHA256SUMS"), `${hash.toUpperCase()}  nyra-linux-x64\n`);
  writeFileSync(join(dir, "SHA256SUMS.bundle"), "fixture-bundle\n");
  const pathSep = process.platform === "win32" ? ";" : ":";
  const run = spawnSync("bash", [toBashPath(join(root, "scripts/verify-release.sh"))], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${toBashPath(binDir)}${pathSep}${process.env.PATH}`,
      NYRA_COSIGN: toBashPath(join(binDir, "cosign")),
      NYRA_COSIGN_LOG: toBashPath(log),
    },
  });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("哈希通过");
  expect(readFileSync(log, "utf8")).toContain("--bundle");
});
