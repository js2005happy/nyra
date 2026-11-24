// src/plugins.ts — 最小插件市场（第 4 阶段，方案 2.3/4.4 + 2.6 第 6 条）。
//
// 插件 = 技能包：一个目录，含 plugin.json 清单 + skills/*.md。
// 信任模型（“装一个、信一个”，不追求数量）：
//  - 只装用户显式指定的来源（本地目录或 git URL）；绝不自动更新、绝不静默拉取。
//  - 装前验清单（名字、版本、技能列表与文件一致）；每个文件记 sha256 进锁定文件。
//  - 用户改过的技能文件不被重写（curator lock）：升级时只覆盖与锁定文件
//    哈希一致的文件，改过的文件原样保留并报告。
//  - 卸载只删哈希一致的文件；用户改过的文件留着并报告，全流程可逆、无残留
//    （除用户自己改过的文件外）。
// 技能生命周期：active → stale → archived；遥测写旁挂文件
// plugins/telemetry.jsonl，绝不写进 SKILL.md frontmatter；pinned 与状态正交；
// 内置技能硬保护，插件不得同名顶替。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync, appendFileSync, copyFileSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { parseSkillFile } from "./skills.ts";

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 内置技能硬保护集：插件不得用这些名字顶替随仓库发布的技能。 */
export const PROTECTED_BUILTIN_SKILLS = [
  "debugging", "deep-thinking", "file-organizer", "verify-research", "web-research",
];
/** 多久没用过算 stale（天）。 */
export const STALE_AFTER_DAYS = 90;

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  skills: string[];
  /**
   * 声明的工具白名单（Nyra 工具名，如 grep_search）；运行时调用仍走审批，
   * 白名单是给用户看的权限声明，不是执行时的豁免。创造模式生成的插件必须声明。
   */
  tools?: string[];
  /** 声明的权限清单，如 network:none、fs:read-workspace、fs:write-workspace。 */
  permissions?: string[];
}

export type PluginStatus = "active" | "disabled" | "stale" | "archived";

export interface PluginRecord {
  name: string;
  version: string;
  source: string;
  commit?: string | null;
  installed_at: string;
  status: PluginStatus;
  pinned: boolean;
  /** 相对路径 -> sha256（plugin.json、skills/*.md 与 panel/*.html）。 */
  files: Record<string, string>;
  /** 升级时因用户改过而保留未覆盖的文件（verify 时不算篡改）。 */
  held_modified?: string[];
}

export interface PluginLock {
  version: 1;
  plugins: Record<string, PluginRecord>;
  /**
   * H6：卸载墓碑——删掉的插件只留这一条（名字 + 卸载时间 + 删了哪些文件），
   * 锁定文件里不再有它的记录。重装/升级/缓存回写都不许悄悄复活它：
   * installPlugin 撞见墓碑时除非显式 --force 否则拒绝；setPluginStatus
   * 撞见墓碑时直接报错。显式重装是用户自己的决定，清掉墓碑继续装。
   */
  tombstones?: Record<string, { uninstalled_at: string; files_removed: string[] }>;
}

export interface RegistryEntry {
  name: string;
  version: string;
  description?: string;
  author?: string;
  source: string;
  sha256?: string;
}

export function pluginsDir(home: string): string {
  return join(home, "plugins");
}

export function lockPath(home: string): string {
  return join(pluginsDir(home), "installed.json");
}

export function telemetryPath(home: string): string {
  return join(pluginsDir(home), "telemetry.jsonl");
}

export function pluginDir(home: string, name: string): string {
  return join(pluginsDir(home), name);
}

export function loadLock(home: string): PluginLock {
  try {
    const data = JSON.parse(readFileSync(lockPath(home), "utf-8")) as PluginLock;
    if (data && data.version === 1 && data.plugins && typeof data.plugins === "object") {
      // 旧锁定文件里的文件键名可能是 Windows 反斜杠：读入时统一成正斜杠，
      // 否则升级/校验/卸载的键名比对会在跨平台后失效。
      for (const rec of Object.values(data.plugins)) {
        const norm: Record<string, string> = {};
        for (const [k, v] of Object.entries(rec.files ?? {})) norm[k.split(/[\\/]/).join("/")] = v;
        rec.files = norm;
      }
      // H6：墓碑只认形状对的条目（坏行丢掉，不让它拖垮整个锁定文件）。
      if (data.tombstones && typeof data.tombstones === "object" && !Array.isArray(data.tombstones)) {
        const tombs: Record<string, { uninstalled_at: string; files_removed: string[] }> = {};
        for (const [name, t] of Object.entries(data.tombstones)) {
          if (!t || typeof t !== "object") continue;
          const ts = (t as { uninstalled_at?: unknown }).uninstalled_at;
          const files = (t as { files_removed?: unknown }).files_removed;
          if (typeof ts !== "string" || !Array.isArray(files)) continue;
          tombs[name] = { uninstalled_at: ts, files_removed: files.filter((f): f is string => typeof f === "string") };
        }
        data.tombstones = tombs;
      } else {
        delete (data as { tombstones?: unknown }).tombstones;
      }
      return data;
    }
  } catch { /* 损坏或不存在都当成空锁，安装时重建 */ }
  return { version: 1, plugins: {} };
}

export function saveLock(home: string, lock: PluginLock): void {
  const dir = pluginsDir(home);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.installed-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n", "utf-8");
  renameSync(tmp, lockPath(home));
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function checkPluginName(name: string): void {
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new PluginError(`插件名无效：${name}（只允许小写字母、数字、- 和 _，以字母或数字开头）`);
  }
}

export function readManifest(dir: string): PluginManifest {
  const path = join(dir, "plugin.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    throw new PluginError(`缺少可读的 plugin.json：${path}`);
  }
  if (!raw || typeof raw !== "object") throw new PluginError("plugin.json 格式错误：顶层必须是对象");
  const m = raw as Record<string, unknown>;
  const name = m.name;
  if (typeof name !== "string" || !name) throw new PluginError("plugin.json 缺少 name");
  checkPluginName(name);
  const version = m.version;
  if (typeof version !== "string" || !version) throw new PluginError("plugin.json 缺少 version");
  const skills = m.skills;
  if (!Array.isArray(skills) || !skills.length || skills.some((s) => typeof s !== "string" || !s)) {
    throw new PluginError("plugin.json 的 skills 必须是非空字符串数组");
  }
  const tools = m.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !/^[a-z][a-z0-9_]*$/.test(t)))) {
    throw new PluginError("plugin.json 的 tools 必须是非空字符串数组（Nyra 工具名）");
  }
  const permissions = m.permissions;
  if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !p))) {
    throw new PluginError("plugin.json 的 permissions 必须是非空字符串数组");
  }
  return {
    name,
    version,
    description: typeof m.description === "string" ? m.description : undefined,
    author: typeof m.author === "string" ? m.author : undefined,
    license: typeof m.license === "string" ? m.license : undefined,
    homepage: typeof m.homepage === "string" ? m.homepage : undefined,
    skills: [...(skills as string[])],
    tools: tools === undefined ? undefined : [...(tools as string[])],
    permissions: permissions === undefined ? undefined : [...(permissions as string[])],
  };
}

function listPluginFiles(dir: string): string[] {
  const out: string[] = ["plugin.json"];
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir)) {
    for (const f of readdirSync(skillsDir).sort()) {
      // 锁定文件里的键名一律用正斜杠：join() 在 Windows 上会写反斜杠，
      // 跨平台比对（verify/uninstall/upgrade）与测试期望都会失败。
      if (f.endsWith(".md")) out.push(`skills/${f}`);
    }
  }
  // 面板资源（创造模式的番茄钟面板等）：仅允许自包含的 .html，随哈希锁定一起安装。
  const panelDir = join(dir, "panel");
  if (existsSync(panelDir)) {
    for (const f of readdirSync(panelDir).sort()) {
      if (f.endsWith(".html")) out.push(`panel/${f}`);
    }
  }
  return out;
}

function hashTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of listPluginFiles(dir)) {
    files[rel] = sha256File(join(dir, rel));
  }
  return files;
}

function validateSkillFiles(dir: string, manifest: PluginManifest): void {
  for (const skill of manifest.skills) {
    const path = join(dir, "skills", `${skill}.md`);
    if (!existsSync(path)) throw new PluginError(`清单声明的技能缺文件：skills/${skill}.md`);
    const parsed = parseSkillFile(path);
    if (parsed.name !== skill) {
      throw new PluginError(`技能文件 ${skill}.md 的 name 是 ${parsed.name}，与清单不一致`);
    }
    if (PROTECTED_BUILTIN_SKILLS.includes(skill)) {
      throw new PluginError(`技能名 ${skill} 是内置技能，插件不得顶替`);
    }
  }
  const listed = new Set(manifest.skills);
  for (const rel of listPluginFiles(dir)) {
    if (!rel.startsWith("skills/")) continue;
    const name = basename(rel, ".md");
    if (!listed.has(name)) throw new PluginError(`skills/${name}.md 未在清单的 skills 里声明`);
  }
}

function resolveSource(source: string): { kind: "local" | "git"; dir: string; cleanup?: () => void } {
  const trimmed = source.trim();
  if (!trimmed) throw new PluginError("来源不能为空");
  if (/^https:\/\//.test(trimmed) || /^git@[^:]+:/.test(trimmed) || /\.git$/.test(trimmed)) {
    let tmp = "";
    try {
      tmp = join(process.env.TMPDIR || "/tmp", `nyra-plugin-${process.pid}-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      execFileSync("git", ["clone", "--depth", "1", trimmed, join(tmp, "repo")], {
        timeout: 60000, stdio: "pipe", encoding: "utf-8",
      });
    } catch (err: unknown) {
      try { if (tmp) rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new PluginError(`git 拉取失败：${trimmed}（${err instanceof Error ? err.message : String(err)}）`);
    }
    return {
      kind: "git",
      dir: join(tmp, "repo"),
      cleanup: () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } },
    };
  }
  if (/^http:\/\//.test(trimmed)) {
    throw new PluginError("只接受 https 或 git@ 来源，不接受明文 http");
  }
  const dir = resolve(trimmed);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new PluginError(`本地来源不存在或不是目录：${dir}`);
  }
  return { kind: "local", dir };
}

export interface InstallResult {
  name: string;
  version: string;
  upgraded: boolean;
  /** 升级时因用户改过而保留未覆盖的文件。 */
  keptModified: string[];
  files: string[];
}

export function installPlugin(home: string, source: string, opts?: { force?: boolean }): InstallResult {
  const resolved = resolveSource(source);
  try {
    const manifest = readManifest(resolved.dir);
    validateSkillFiles(resolved.dir, manifest);
    const lock = loadLock(home);
    const existing = lock.plugins[manifest.name];
    // H6：撞见卸载墓碑时拒绝重装——删了的东西不许被重装/升级悄悄复活。
    // 显式重装（--force / nyra market install）是用户自己的决定：清掉
    // 墓碑继续装。市场安装走同一入口，见 marketplace.ts 的调用处。
    const tomb = lock.tombstones?.[manifest.name];
    if (tomb && !opts?.force) {
      throw new PluginError(`插件 ${manifest.name} 已于 ${tomb.uninstalled_at} 卸载（墓碑）：重装请加 --force（显式重装会清掉墓碑）`);
    }
    // 跨插件技能名冲突：不顶替、不合并。
    for (const [otherName, rec] of Object.entries(lock.plugins)) {
      if (otherName === manifest.name) continue;
      const otherSkills = Object.keys(rec.files)
        .filter((f) => f.startsWith("skills/"))
        .map((f) => basename(f, ".md"));
      for (const skill of manifest.skills) {
        if (otherSkills.includes(skill)) {
          throw new PluginError(`技能名 ${skill} 已被插件 ${otherName} 提供，拒绝安装（不顶替、不合并）`);
        }
      }
    }
    const dest = pluginDir(home, manifest.name);
    const keptModified: string[] = [];
    const newFiles = hashTree(resolved.dir);
    if (existing) {
      // 升级：只覆盖与锁定文件哈希一致的文件（curator lock）。
      for (const [rel, hash] of Object.entries(newFiles)) {
        const target = join(dest, rel);
        const oldHash = existing.files[rel];
        if (oldHash && existsSync(target) && sha256File(target) !== oldHash) {
          keptModified.push(rel);
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(resolved.dir, rel), target);
      }
      // 旧版有、新版没有的文件：未改过才删，改过则保留。
      for (const rel of Object.keys(existing.files)) {
        if (rel in newFiles) continue;
        const target = join(dest, rel);
        if (!existsSync(target)) continue;
        if (sha256File(target) === existing.files[rel]) {
          try { rmSync(target, { force: true }); } catch { /* ignore */ }
        } else {
          keptModified.push(rel);
        }
      }
    } else {
      mkdirSync(join(dest, "skills"), { recursive: true });
      for (const rel of Object.keys(newFiles)) {
        const target = join(dest, rel);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(resolved.dir, rel), target);
      }
    }
    const held = new Set([...(existing?.held_modified ?? []), ...keptModified]);
    // 被保留的文件在锁定文件里仍记旧哈希（verify 时按 held 处理，不算篡改）。
    const files: Record<string, string> = {};
    for (const [rel, hash] of Object.entries(newFiles)) {
      if (keptModified.includes(rel) && existing) files[rel] = existing.files[rel] ?? hash;
      else files[rel] = hash;
    }
    for (const rel of Object.keys(existing?.files ?? {})) {
      if (!(rel in files) && keptModified.includes(rel)) files[rel] = (existing as PluginRecord).files[rel];
    }
    let commit: string | null = null;
    if (resolved.kind === "git") {
      try {
        commit = execFileSync("git", ["-C", resolved.dir, "rev-parse", "HEAD"], { encoding: "utf-8", timeout: 10000 }).trim() || null;
      } catch { commit = null; }
    }
    lock.plugins[manifest.name] = {
      name: manifest.name,
      version: manifest.version,
      source,
      commit,
      installed_at: new Date().toISOString(),
      // H6：停用的插件重装/升级也不许悄悄打开（Hermes：已关闭的插件在
      // 安装程序中保持关闭）。stale/archived 不是用户意图，显式重装回 active。
      status: existing?.status === "disabled" ? "disabled" : "active",
      pinned: existing?.pinned ?? false,
      files,
      ...(held.size ? { held_modified: [...held] } : {}),
    };
    // H6：显式重装清掉墓碑（墓碑只拦悄悄复活，不拦用户自己的决定）。
    if (tomb) {
      delete lock.tombstones![manifest.name];
      if (!Object.keys(lock.tombstones!).length) delete lock.tombstones;
    }
    saveLock(home, lock);
    return {
      name: manifest.name,
      version: manifest.version,
      upgraded: Boolean(existing),
      keptModified,
      files: Object.keys(files),
    };
  } finally {
    resolved.cleanup?.();
  }
}

export interface UninstallResult {
  name: string;
  removed: string[];
  /** 用户改过而保留未删的文件。 */
  keptModified: string[];
  missing: string[];
}

export function uninstallPlugin(home: string, name: string): UninstallResult {
  checkPluginName(name);
  const lock = loadLock(home);
  const rec = lock.plugins[name];
  if (!rec) throw new PluginError(`未安装插件：${name}`);
  const dest = pluginDir(home, name);
  const removed: string[] = [];
  const keptModified: string[] = [];
  const missing: string[] = [];
  for (const [rawRel, hash] of Object.entries(rec.files)) {
    // 旧锁定文件里的键名可能是 Windows 反斜杠：统一成正斜杠再用，
    // 否则 removed/keptModified/missing 里会出现 "skills\\x.md"。
    const rel = rawRel.split(/[\\/]/).join("/");
    const target = join(dest, ...rel.split("/"));
    if (!existsSync(target)) { missing.push(rel); continue; }
    if (sha256File(target) === hash) {
      try { rmSync(target, { force: true }); removed.push(rel); } catch { /* ignore */ }
    } else {
      keptModified.push(rel);
    }
  }
  // 目录空了才删；留有用户改过的文件时保留目录并报告。
  try {
    if (existsSync(dest) && readdirSync(dest).length === 0) rmSync(dest, { recursive: true, force: true });
    else if (existsSync(join(dest, "skills")) && readdirSync(join(dest, "skills")).length === 0) {
      try { rmSync(join(dest, "skills"), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  delete lock.plugins[name];
  // H6：卸载写墓碑——锁定文件里不再有这条记录，但“删过”这个事实留下来。
  // 重装/升级/缓存回写撞见墓碑时拒绝（除非显式 --force）；setPluginStatus
  // 撞见墓碑时也拒绝。用户改过而保留的文件不进墓碑（还在磁盘上，不算删了）。
  if (!lock.tombstones) lock.tombstones = {};
  lock.tombstones[name] = { uninstalled_at: new Date().toISOString(), files_removed: removed };
  saveLock(home, lock);
  return { name, removed, keptModified, missing };
}

/** 已卸载的插件墓碑（名字 → 卸载时间 + 删了哪些文件），供 list 与测试查。 */
export function listPluginTombstones(home: string): { name: string; uninstalled_at: string; files_removed: string[] }[] {
  const lock = loadLock(home);
  return Object.entries(lock.tombstones ?? {}).map(([name, t]) => ({ name, uninstalled_at: t.uninstalled_at, files_removed: t.files_removed }));
}

export function setPluginStatus(home: string, name: string, status: PluginStatus): PluginRecord {
  checkPluginName(name);
  const lock = loadLock(home);
  const rec = lock.plugins[name];
  // H6：已卸载的插件改状态也没有意义——墓碑在，先重装再说。
  if (!rec && lock.tombstones?.[name]) throw new PluginError(`插件 ${name} 已卸载（墓碑 ${lock.tombstones[name].uninstalled_at}）：先重装再改状态`);
  if (!rec) throw new PluginError(`未安装插件：${name}`);
  rec.status = status;
  saveLock(home, lock);
  return rec;
}

export function setPluginPinned(home: string, name: string, pinned: boolean): PluginRecord {
  checkPluginName(name);
  const lock = loadLock(home);
  const rec = lock.plugins[name];
  if (!rec) throw new PluginError(`未安装插件：${name}`);
  rec.pinned = pinned;
  saveLock(home, lock);
  return rec;
}

export function listPlugins(home: string): PluginRecord[] {
  return Object.values(loadLock(home).plugins).sort((a, b) => a.name.localeCompare(b.name));
}

/** 启用中插件的 skills 目录（供 loadSkills 追加；只含 active）。 */
export function pluginSkillDirs(home: string): string[] {
  return listPlugins(home)
    .filter((p) => p.status === "active")
    .map((p) => join(pluginDir(home, p.name), "skills"));
}

export interface VerifyFileResult {
  rel: string;
  state: "ok" | "modified" | "missing" | "held";
}

export interface VerifyResult {
  name: string;
  files: VerifyFileResult[];
  ok: boolean;
}

export function verifyPlugin(home: string, name: string): VerifyResult {
  checkPluginName(name);
  const rec = loadLock(home).plugins[name];
  if (!rec) throw new PluginError(`未安装插件：${name}`);
  const held = new Set(rec.held_modified ?? []);
  const files: VerifyFileResult[] = [];
  for (const [rel, hash] of Object.entries(rec.files)) {
    const target = join(pluginDir(home, name), rel);
    if (!existsSync(target)) files.push({ rel, state: "missing" });
    else if (held.has(rel)) files.push({ rel, state: "held" });
    else if (sha256File(target) === hash) files.push({ rel, state: "ok" });
    else files.push({ rel, state: "modified" });
  }
  return { name, files, ok: files.every((f) => f.state === "ok" || f.state === "held") };
}

export function recordUse(home: string, pluginName: string, skillName: string): void {
  try {
    mkdirSync(pluginsDir(home), { recursive: true });
    appendFileSync(
      telemetryPath(home),
      JSON.stringify({ ts: new Date().toISOString(), plugin: pluginName, skill: skillName, action: "use" }) + "\n",
      "utf-8",
    );
  } catch { /* 遥测写失败不影响主流程 */ }
}

function lastUsedAt(home: string, pluginName: string): number | null {
  try {
    const raw = readFileSync(telemetryPath(home), "utf-8");
    let last: number | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts?: string; plugin?: string };
        if (e.plugin === pluginName && typeof e.ts === "string") {
          const t = Date.parse(e.ts);
          if (Number.isFinite(t) && (last === null || t > last)) last = t;
        }
      } catch { /* 跳过坏行 */ }
    }
    return last;
  } catch {
    return null;
  }
}

/** 生命周期刷新：active 且超过 STALE_AFTER_DAYS 没用过 → stale（pinned 不豁免，
 * 但 archived/disabled 不动）。返回被降级的名字。 */
export function refreshLifecycle(home: string, nowMs: number = Date.now()): string[] {
  const lock = loadLock(home);
  const changed: string[] = [];
  const cutoff = nowMs - STALE_AFTER_DAYS * 24 * 3600 * 1000;
  for (const rec of Object.values(lock.plugins)) {
    if (rec.status !== "active") continue;
    const last = lastUsedAt(home, rec.name);
    const installed = Date.parse(rec.installed_at);
    const ref = last ?? (Number.isFinite(installed) ? installed : nowMs);
    if (ref < cutoff) {
      rec.status = "stale";
      changed.push(rec.name);
    }
  }
  if (changed.length) saveLock(home, lock);
  return changed;
}

export interface AuditResult {
  staleNow: string[];
  verified: VerifyResult[];
}

export function auditPlugins(home: string): AuditResult {
  const staleNow = refreshLifecycle(home);
  const verified = listPlugins(home).map((p) => verifyPlugin(home, p.name));
  return { staleNow, verified };
}

export function loadRegistry(home: string): RegistryEntry[] {
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  const candidates = [
    join(process.cwd(), "plugins", "registry.json"),
    join(pluginsDir(home), "registry.json"),
  ];
  for (const path of candidates) {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as { plugins?: RegistryEntry[] };
      const list = Array.isArray(data?.plugins) ? data.plugins : [];
      for (const e of list) {
        if (!e || typeof e.name !== "string" || seen.has(e.name)) continue;
        seen.add(e.name);
        out.push(e);
      }
    } catch { /* 没有登记文件是正常情况 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function searchRegistry(home: string, query?: string): RegistryEntry[] {
  const q = (query ?? "").trim().toLowerCase();
  return loadRegistry(home).filter((e) => {
    if (!q) return true;
    return e.name.toLowerCase().includes(q)
      || (e.description ?? "").toLowerCase().includes(q);
  });
}
