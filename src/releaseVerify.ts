// src/releaseVerify.ts — Release 校验链的纯逻辑（发布准备度 P0-1）。
//
// 只引 node 内置。verify-release.sh 与三份安装脚本里是同一套逻辑的
// shell 实现；这里是可单测的参考实现，两边行为须一致：
//   - SHA256SUMS 缺失或为空 → “没有 SHA256SUMS”，拒绝；
//   - 清单里没有该产物、哈希对不上、清单行格式不对 → 拒绝；
//   - gh 的 release view 轮询参数里 --jq 只接一个表达式，不带 -r。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class ReleaseVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseVerifyError";
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// SHA256SUMS 每行：64 位小写十六进制哈希 + 空白 + 文件名（sha256sum 的
// 文本模式是两个空格，二进制模式是 " *" 前缀；两种都认）。
const SUMS_LINE_RE = /^([0-9a-fA-F]{64})[ \t]+\*?(\S+)\s*$/;

/** 钉住的默认安装版本（与三份安装脚本头部的 DEFAULT_VERSION 同步）。 */
export const PINNED_INSTALL_VERSION = "v0.5.12";

/** 把用户给的版本统一成 v 前缀；"latest" 原样保留。 */
export function normalizeReleaseVersion(version: string): string {
  const v = version.trim();
  if (v === "latest" || v === "") return v;
  return v.startsWith("v") ? v : `v${v}`;
}

/**
 * 下载根必须是已经解析好的 tag。latest 在这里直接拒绝，避免产物和
 * 校验材料各自跟随 latest，打到两个不同的 Release。
 */
export function releaseDownloadBase(repo: string, version: string): string {
  const v = normalizeReleaseVersion(version);
  if (v === "latest" || v === "") {
    throw new ReleaseVerifyError("latest 必须先解析成具体 tag，再下载产物和校验材料");
  }
  return `https://github.com/${repo}/releases/download/${v}`;
}

/** 从 GitHub releases/latest JSON 取出 tag_name。只认 v 开头。 */
export function parseGithubLatestTag(json: string): string {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ReleaseVerifyError("解析 latest 失败：不是 JSON");
  }
  const tag = data && typeof data === "object" ? (data as { tag_name?: unknown }).tag_name : undefined;
  if (typeof tag !== "string" || !/^v[0-9A-Za-z._+-]+$/.test(tag)) {
    throw new ReleaseVerifyError("解析 latest 失败：没有合法的 tag_name");
  }
  return tag;
}

/** 同一个 tag 上的某个附件 URL。产物名不许带路径。 */
export function releaseAssetUrl(repo: string, tag: string, asset: string): string {
  if (asset.includes("/") || asset.includes("\\") || asset.includes("..") || asset === "") {
    throw new ReleaseVerifyError(`产物名非法：${asset}`);
  }
  return `${releaseDownloadBase(repo, tag)}/${asset}`;
}

export type SignatureMaterial = "bundle" | "sig-pem";

/**
 * 发布者证明：bundle，或成对的 sig+pem。都没有就拒绝。
 * 调用方不得把“哈希与清单一致”说成已经证明发布者。
 */
export function requireSignatureMaterial(names: readonly string[]): SignatureMaterial {
  const set = new Set(names);
  if (set.has("SHA256SUMS.bundle")) return "bundle";
  if (set.has("SHA256SUMS.sig") && set.has("SHA256SUMS.pem")) return "sig-pem";
  throw new ReleaseVerifyError(
    "缺少签名材料：没有 SHA256SUMS.bundle，也没有成对的 SHA256SUMS.sig 与 SHA256SUMS.pem。哈希清单未被认证，不能当作发布者证明。",
  );
}

/** SHA256SUMS 下载地址。 */
export function sha256sumsUrl(repo: string, version: string): string {
  return `${releaseDownloadBase(repo, version)}/SHA256SUMS`;
}

/**
 * 解析 SHA256SUMS 文本。空行跳过；格式不对的行、重复的文件名、带路径
 * 的文件名一律 fail-closed 抛错（清单是校验依据，不能含糊）。
 */
export function parseSha256sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = SUMS_LINE_RE.exec(line);
    if (!m) {
      throw new ReleaseVerifyError(`SHA256SUMS 里有一行格式不对：${line.slice(0, 80)}`);
    }
    const [, hash, name] = m;
    if (name.includes("/") || name.includes("\\") || name === ".." || name.includes("..")) {
      throw new ReleaseVerifyError(`SHA256SUMS 里有带路径的文件名：${name}`);
    }
    if (sums.has(name)) {
      throw new ReleaseVerifyError(`SHA256SUMS 里 ${name} 出现了两次`);
    }
    sums.set(name, hash.toLowerCase());
  }
  return sums;
}

/** 清单里查某个产物的期望哈希；没有返回 null。 */
export function expectedHash(sums: Map<string, string>, asset: string): string | null {
  return sums.get(asset) ?? null;
}

/** 一段内容的 sha256（十六进制小写）。 */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 验一个文件：读出内容算哈希，与期望值比对。哈希对不上返回 false，
 * 不抛错（调用方决定报错文案）；文件不存在抛错。
 */
export function verifyFileHash(filePath: string, expected: string): boolean {
  if (!existsSync(filePath)) {
    throw new ReleaseVerifyError(`找不到要校验的文件：${filePath}`);
  }
  const actual = sha256Hex(readFileSync(filePath));
  return actual === expected.toLowerCase();
}

/**
 * 验一个 Release 目录：读 SHA256SUMS，逐条核对清单里的每个文件。
 * 缺失清单、清单为空、格式不对、清单里的文件不存在、哈希对不上，
 * 一律抛 ReleaseVerifyError（fail-closed）。返回验过的产物名（已排序）。
 */
export function verifyReleaseDir(dir: string): string[] {
  const sumsPath = join(dir, "SHA256SUMS");
  if (!existsSync(sumsPath)) {
    throw new ReleaseVerifyError(
      "没有 SHA256SUMS：这个目录里没有哈希清单，无法校验（该 Release 可能没有附带 SHA256SUMS）",
    );
  }
  const text = readFileSync(sumsPath, "utf8");
  if (text.trim() === "") {
    throw new ReleaseVerifyError("没有 SHA256SUMS：哈希清单是空的，无法校验");
  }
  const sums = parseSha256sums(text);
  if (sums.size === 0) {
    throw new ReleaseVerifyError("没有 SHA256SUMS：哈希清单里没有任何条目，无法校验");
  }
  const verified: string[] = [];
  for (const [name, hash] of [...sums.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const filePath = join(dir, name);
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
      throw new ReleaseVerifyError(`SHA256SUMS 里有 ${name}，但目录里没有这个文件`);
    }
    if (!verifyFileHash(filePath, hash)) {
      throw new ReleaseVerifyError(`哈希不匹配：${name} 的 sha256 与 SHA256SUMS 不符，文件可能被篡改`);
    }
    verified.push(name);
  }
  return verified;
}

/**
 * release-sign.yml 等待循环里轮询 Release 资产的 gh 参数。
 * 注意：gh 的 --jq 只接受一个参数，绝不能再跟 -r（-r 会被当成 jq
 * 表达式，真正的表达式变成多余位置参数，gh 直接报错退出）。
 */
export function ghReleaseViewArgs(tag: string, repo: string): string[] {
  return ["release", "view", tag, "--repo", repo, "--json", "assets", "--jq", ".assets[].name"];
}

/** 列出一个目录里除 SHA256SUMS* 与 *.intoto.jsonl 之外的产物（签名步骤的口径）。 */
export function listReleaseArtifacts(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => lstatSync(join(dir, f)).isFile())
    .filter((f) => !f.startsWith("SHA256SUMS") && !f.endsWith(".intoto.jsonl"))
    .sort();
}
