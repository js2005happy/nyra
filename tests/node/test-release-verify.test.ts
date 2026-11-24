// tests/node/test-release-verify.test.ts — 发布准备度 P0-1：Release 校验链。
// 只测纯逻辑与参数构造（SHA256SUMS 解析、单字节篡改必败、缺失清单报错、
// gh 轮询参数），不调网络、不调 gh、不花钱；全部用临时目录。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PINNED_INSTALL_VERSION,
  ReleaseVerifyError,
  expectedHash,
  ghReleaseViewArgs,
  listReleaseArtifacts,
  normalizeReleaseVersion,
  parseSha256sums,
  releaseDownloadBase,
  sha256Hex,
  sha256sumsUrl,
  verifyFileHash,
  verifyReleaseDir,
} from "../../src/releaseVerify.ts";

function tmpDir(prefix = "nyra-relverify-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("ReleaseVerifyTest.test_parse_sums_text_and_binary_modes", () => {
  const sums = parseSha256sums(
    `${"a".repeat(64)}  nyra-linux-x64\n${"b".repeat(64)} *nyra-windows-x64.exe\n`,
  );
  expect(sums.size).toBe(2);
  expect(expectedHash(sums, "nyra-linux-x64")).toBe("a".repeat(64));
  expect(expectedHash(sums, "nyra-windows-x64.exe")).toBe("b".repeat(64));
  expect(expectedHash(sums, "nyra-macos-arm64")).toBeNull();
});

test("ReleaseVerifyTest.test_parse_rejects_bad_line_duplicate_and_path", () => {
  expect(() => parseSha256sums("xyz  nyra-linux-x64\n")).toThrow(ReleaseVerifyError);
  expect(() =>
    parseSha256sums(`${"a".repeat(64)}  nyra-linux-x64\n${"b".repeat(64)}  nyra-linux-x64\n`),
  ).toThrow(ReleaseVerifyError);
  expect(() => parseSha256sums(`${"a".repeat(64)}  ../escape\n`)).toThrow(ReleaseVerifyError);
  expect(() => parseSha256sums(`${"a".repeat(64)}  sub/dir/file\n`)).toThrow(ReleaseVerifyError);
});

test("ReleaseVerifyTest.test_verify_dir_good_bundle_passes", () => {
  const dir = tmpDir();
  const content = "hello release\n";
  writeFileSync(join(dir, "nyra-linux-x64"), content);
  writeFileSync(join(dir, "SHA256SUMS"), `${sha256Hex(content)}  nyra-linux-x64\n`);
  expect(verifyReleaseDir(dir)).toEqual(["nyra-linux-x64"]);
});

test("ReleaseVerifyTest.test_verify_dir_single_byte_tamper_fails", () => {
  const dir = tmpDir();
  const content = "hello release\n";
  writeFileSync(join(dir, "nyra-linux-x64"), content);
  writeFileSync(join(dir, "SHA256SUMS"), `${sha256Hex(content)}  nyra-linux-x64\n`);
  // 改 1 个字节：哈希必须对不上。
  writeFileSync(join(dir, "nyra-linux-x64"), "hello releasf\n");
  expect(() => verifyReleaseDir(dir)).toThrow(/哈希不匹配/);
});

test("ReleaseVerifyTest.test_verify_dir_missing_sums_says_no_sums", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "nyra-linux-x64"), "x");
  expect(() => verifyReleaseDir(dir)).toThrow(/没有 SHA256SUMS/);
});

test("ReleaseVerifyTest.test_verify_dir_empty_sums_and_missing_file_fail", () => {
  const emptyDir = tmpDir();
  writeFileSync(join(emptyDir, "SHA256SUMS"), "\n");
  expect(() => verifyReleaseDir(emptyDir)).toThrow(/没有 SHA256SUMS/);
  const noFileDir = tmpDir();
  writeFileSync(join(noFileDir, "SHA256SUMS"), `${"c".repeat(64)}  nyra-linux-x64\n`);
  expect(() => verifyReleaseDir(noFileDir)).toThrow(/没有这个文件/);
});

test("ReleaseVerifyTest.test_verify_file_hash_true_false_and_missing", () => {
  const dir = tmpDir();
  const file = join(dir, "bin");
  writeFileSync(file, "abc");
  const good = sha256Hex("abc");
  expect(verifyFileHash(file, good)).toBe(true);
  expect(verifyFileHash(file, sha256Hex("abd"))).toBe(false);
  expect(() => verifyFileHash(join(dir, "nope"), good)).toThrow(ReleaseVerifyError);
});

test("ReleaseVerifyTest.test_gh_release_view_args_has_no_dash_r", () => {
  const args = ghReleaseViewArgs("v0.5.12", "js2005happy/nyra");
  expect(args).toEqual([
    "release", "view", "v0.5.12", "--repo", "js2005happy/nyra",
    "--json", "assets", "--jq", ".assets[].name",
  ]);
  // --jq 只接一个表达式：参数里绝不能出现 -r。
  expect(args).not.toContain("-r");
  expect(args.filter((a) => a === "--jq").length).toBe(1);
});

test("ReleaseVerifyTest.test_version_normalize_and_download_urls", () => {
  expect(normalizeReleaseVersion("0.5.12")).toBe("v0.5.12");
  expect(normalizeReleaseVersion("v0.5.12")).toBe("v0.5.12");
  expect(normalizeReleaseVersion("latest")).toBe("latest");
  expect(releaseDownloadBase("js2005happy/nyra", "latest")).toBe(
    "https://github.com/js2005happy/nyra/releases/latest/download",
  );
  expect(releaseDownloadBase("js2005happy/nyra", "0.5.12")).toBe(
    "https://github.com/js2005happy/nyra/releases/download/v0.5.12",
  );
  expect(sha256sumsUrl("js2005happy/nyra", "v0.5.12")).toBe(
    "https://github.com/js2005happy/nyra/releases/download/v0.5.12/SHA256SUMS",
  );
});

test("ReleaseVerifyTest.test_pinned_install_version_matches_all_three_installers", () => {
  // 默认版本只指向已发布、附件齐全的 Release（CI 的 installer-release-check 联网核对附件）；
  // 这里离线核对：三份安装脚本与 PINNED_INSTALL_VERSION 是同一个版本号。
  const root = join(import.meta.dir, "..", "..");
  const sh = readFileSync(join(root, "scripts", "install-node.sh"), "utf-8").match(/^DEFAULT_VERSION="([^"]+)"/m)?.[1];
  const mac = readFileSync(join(root, "scripts", "install-node-macos.sh"), "utf-8").match(/^DEFAULT_VERSION="([^"]+)"/m)?.[1];
  const ps = readFileSync(join(root, "scripts", "install-node.ps1"), "utf-8").match(/\[string\]\$Version = "([^"]+)"/)?.[1];
  expect(sh).toBe(PINNED_INSTALL_VERSION);
  expect(mac).toBe(PINNED_INSTALL_VERSION);
  expect(ps).toBe(PINNED_INSTALL_VERSION);
});

test("ReleaseVerifyTest.test_list_artifacts_skips_sums_and_attestations", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "nyra-linux-x64"), "x");
  writeFileSync(join(dir, "nyra-linux-x64.exe"), "x");
  writeFileSync(join(dir, "SHA256SUMS"), "x");
  writeFileSync(join(dir, "SHA256SUMS.sig"), "x");
  writeFileSync(join(dir, "nyra-linux-x64.intoto.jsonl"), "x");
  mkdirSync(join(dir, "sub"));
  expect(listReleaseArtifacts(dir)).toEqual(["nyra-linux-x64", "nyra-linux-x64.exe"]);
});
