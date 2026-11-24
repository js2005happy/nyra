// scripts/check-release-facts.ts — 对外事实检查（CI 用，会联网）。
//
//   bun scripts/check-release-facts.ts installers   安装脚本默认版本 = 已发布、附件齐全的 Release
//   bun scripts/check-release-facts.ts site         官网（docs/*.html）的链接都能用
//   bun scripts/check-release-facts.ts all          两个都跑
//
// 为什么要有：一行安装命令曾经指向一个还没发布的版本（全员 404），而 CI 是绿的。
// 下载链接用 1 字节 GET（Range: bytes=0-0）探测，不用 HEAD：Release 附件对 HEAD 会回 401。
// 设了 GITHUB_TOKEN 时调 GitHub API 带上它（不带也能跑，只是限流更紧）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REPO = "js2005happy/nyra";
const errors: string[] = [];
const fail = (msg: string) => { errors.push(msg); console.error(`✗ ${msg}`); };
const ok = (msg: string) => console.log(`✓ ${msg}`);

/** 下载附件用 1 字节 GET，跟随跳转；返回最终状态码（网络错误返回 0）。 */
async function probe(url: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 下载附件只取 1 字节；普通页面（如 Release 页）正常 GET。
      const headers: Record<string, string> = { "User-Agent": "nyra-release-facts" };
      if (url.includes("/releases/download/")) headers.Range = "bytes=0-0";
      const res = await fetch(url, { headers, redirect: "follow" });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (res.status >= 500 && attempt < 2) { await Bun.sleep(1500); continue; }
      return res.status;
    } catch {
      if (attempt < 2) { await Bun.sleep(1500); continue; }
      return 0;
    }
  }
  return 0;
}

function defaultVersions(): Record<string, string | undefined> {
  const read = (f: string) => readFileSync(join(ROOT, "scripts", f), "utf-8");
  return {
    "install-node.sh": read("install-node.sh").match(/^DEFAULT_VERSION="([^"]+)"/m)?.[1],
    "install-node-macos.sh": read("install-node-macos.sh").match(/^DEFAULT_VERSION="([^"]+)"/m)?.[1],
    "install-node.ps1": read("install-node.ps1").match(/\[string\]\$Version = "([^"]+)"/)?.[1],
  };
}

async function checkInstallers(): Promise<void> {
  const versions = defaultVersions();
  const distinct = new Set(Object.values(versions));
  for (const [f, v] of Object.entries(versions)) if (!v) fail(`${f}：找不到默认版本`);
  if (distinct.size !== 1) { fail(`三份安装脚本的默认版本不一致：${JSON.stringify(versions)}`); return; }
  const tag = [...distinct][0]!;
  if (tag === "latest") { fail("默认版本不能是 latest（要钉住一个已发布的版本）"); return; }
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "nyra-release-facts" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers });
  if (res.status === 404) { fail(`安装脚本默认版本 ${tag} 还没有 Release`); return; }
  if (!res.ok) { fail(`读 Release ${tag} 失败：HTTP ${res.status}`); return; }
  const rel = await res.json() as { draft?: boolean; assets: { name: string }[] };
  if (rel.draft) fail(`Release ${tag} 还是草稿`);
  const names = rel.assets.map((a) => a.name);
  // 安装脚本直接下载的：5 个 Node 二进制 + 哈希清单。
  const required = ["nyra-linux-x64", "nyra-linux-arm64", "nyra-macos-arm64", "nyra-macos-x64", "nyra-windows-x64.exe", "SHA256SUMS"];
  for (const name of required) {
    if (!names.includes(name)) { fail(`Release ${tag} 缺附件 ${name}`); continue; }
    const code = await probe(`https://github.com/${REPO}/releases/download/${tag}/${name}`);
    if (code === 200 || code === 206) ok(`${tag}/${name}（HTTP ${code}）`);
    else fail(`${tag}/${name} 下载不到（HTTP ${code}）`);
  }
  // 发版同步要求的其余产物：桌面安装包与安卓 APK（只核对存在）。
  for (const [label, re] of [["macOS .dmg", /\.dmg$/], ["Windows .msi", /\.msi$/], ["Windows -setup.exe", /-setup\.exe$/], ["安卓 APK", /\.apk$/]] as const) {
    if (names.some((n) => re.test(n))) ok(`${tag} 有 ${label}`);
    else fail(`Release ${tag} 缺 ${label}`);
  }
  // SHA256SUMS 必须列出安装脚本要的每个二进制。
  try {
    const sums = await (await fetch(`https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS`, { redirect: "follow" })).text();
    for (const name of required.filter((n) => n !== "SHA256SUMS")) {
      if (!new RegExp(`^[0-9a-f]{64}\\s+\\*?${name.replace(/\./g, "\\.")}\\s*$`, "m").test(sums)) fail(`${tag} 的 SHA256SUMS 里没有 ${name}`);
    }
  } catch (err) {
    fail(`读 ${tag} 的 SHA256SUMS 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkSite(): Promise<void> {
  const docs = join(ROOT, "docs");
  const pages = readdirSync(docs).filter((f) => f.endsWith(".html"));
  const remote = new Set<string>();
  for (const page of pages) {
    const html = readFileSync(join(docs, page), "utf-8");
    for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const link = m[1].replace(/&amp;/g, "&");
      if (link.startsWith("#") || /^(mailto|javascript|data|tel):/i.test(link)) continue;
      if (/^https?:\/\//i.test(link)) {
        // 指向本站的绝对链接：按本地文件核对（Pages 发布的就是 docs/）。
        const self = link.match(/^https:\/\/js2005happy\.github\.io\/nyra\/?([^#?]*)/);
        if (self) {
          const rel = self[1] || "index.html";
          if (!existsSync(join(docs, rel))) fail(`${page}：${link} 对应的 docs/${rel} 不存在`);
          continue;
        }
        // 仓库内文件链接：按本地文件核对。
        const blob = link.match(/^https:\/\/github\.com\/js2005happy\/nyra\/blob\/main\/([^#?]+)/)
          ?? link.match(/^https:\/\/raw\.githubusercontent\.com\/js2005happy\/nyra\/main\/([^#?]+)/);
        if (blob) {
          if (!existsSync(join(ROOT, blob[1]))) fail(`${page}：${link} 对应的仓库文件 ${blob[1]} 不存在`);
          continue;
        }
        // 下载链接与 Release 页面：联网核对。其他外站不查（别人的站点抖动不该把我们的 CI 弄红）。
        if (/^https:\/\/github\.com\/js2005happy\/nyra\/releases\//.test(link)) remote.add(link);
        continue;
      }
      const clean = link.split("#")[0].split("?")[0];
      if (!clean) continue;
      const target = resolve(dirname(join(docs, page)), clean);
      if (!existsSync(target)) fail(`${page}：相对链接 ${link} 指向的文件不存在`);
    }
  }
  ok(`官网 ${pages.length} 个页面的相对链接已核对`);
  for (const url of remote) {
    const code = await probe(url);
    if (code === 200 || code === 206) ok(`${url}（HTTP ${code}）`);
    else fail(`${url} 打不开（HTTP ${code}）`);
  }
}

const what = process.argv[2] ?? "all";
if (what === "installers" || what === "all") await checkInstallers();
if (what === "site" || what === "all") await checkSite();
if (!["installers", "site", "all"].includes(what)) { console.error("用法：bun scripts/check-release-facts.ts <installers|site|all>"); process.exit(2); }
if (errors.length) { console.error(`\n${errors.length} 项不通过`); process.exit(1); }
console.log("\n全部通过");
