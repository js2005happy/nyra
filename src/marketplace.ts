// src/marketplace.ts — 内置机器人市场（第一阶段：静态策展仓库 + 本地客户端）。
//
// 只卖三样文件（本地优先：分享配置与技能，不分享电脑）：
//   - 技能包（Skill）：单文件 .md，与缺口 11 沉淀出的技能同格式，可直接进 ~/.nyra/skills/
//   - 机器人配置（Bot）：一个目录（bot.json + skills/*.md + 可选 routines.json），
//     即创造模式的插件形态（plugin.json + skills），安装复用 src/plugins.ts 的路径。
//   - 业务流程模板（Template，缺口 46）：单文件 .yaml/.json，声明式纯文本，
//     进 ~/.nyra/templates/，激活前须试跑 + 人工确认（见 src/templates.ts）。
// 不卖：整台电脑/云电脑共享、真实凭证与账号信息、无许可证内容。
//
// 一键安装走三道门（缺口 10 的复用）：清单校验（verifyStagedPlugin / 技能解析）
// → 确定性规则（技能正文与 routine 里的高危模式，规则 id 与缺口 10 同款）
// → 独立审查（marketplace_install 虚拟敏感动作；审查失败即拦截，fail-closed）。
// 审查层未开启时只走两道确定性门、明确告知用户（与候选提案 1 的 bughunt check
// 同口径：未开启 ≠ 失败，但新装机器人默认只读起步，写操作须用户显式放开）。
// `--yes` 不跳过市场安装的确认（市场内容是不受信任的第三方配置）。
//
// 证据链写两处：运行事件 marketplace_installed / marketplace_uninstalled /
// marketplace_published（src/runs.ts 的 EVENT_FIELDS 登记；事件里只记名字与
// 来源 id，不记绝对路径——绝对路径在账本里）+ 安装账本
// ~/.nyra/marketplace-installed.json（原子写 0600，损坏先备份再抛错；卸载留
// 一条 uninstalled 记录，不直接抹掉历史）。
//
// 后端第一阶段是静态策展仓库（nyra-community，git + 本地 index.json，无服务
// 端、无账号、无支付）：客户端用本地目录或 git clone 拉取，绝不自动更新、
// 绝不静默拉取。star 过 500 或周活过 100 才加服务端与交流群（第二阶段，不做）。
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, statSync, copyFileSync, openSync, writeSync,
  fsyncSync, closeSync, mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, relative } from "node:path";
import { checkPanelSelfContained, verifyStagedPlugin, HIGH_PRIVILEGE_TOOLS, KNOWN_TOOLS } from "./creator.ts";
import { installPlugin, uninstallPlugin, pluginDir, sha256File, loadLock, PLUGIN_NAME_RE, PROTECTED_BUILTIN_SKILLS } from "./plugins.ts";
import { reviewToolCall, buildReviewerRunner, type ReviewerLike, type ReviewVerdict } from "./reviewer.ts";
import { parseSkillFile, parseSkillText } from "./skills.ts";
import { checkEvidenceHygiene } from "./bughunt.ts";
import { validateAgentDecl, saveAgentDecl, removeStoredAgentDecl, storedAgentDeclPath, loadStoredAgentDecl, type AgentDecl } from "./agentDecl.ts";
import { knownModelNames, validateOpts } from "./agentDeclCli.ts";
import { createSession, endSession, loadSessionBook, findSession } from "./session.ts";
import {
  parseTemplateText, validateTemplateDefinition, templateWorkflowTools,
  collectWorkflowTools, templateSlug, templatesDir, importTemplateText,
  getTemplateEntry, removeTemplateEntry, type TemplateDefinition,
} from "./templates.ts";
import { type RunStore } from "./runs.ts";
import { hasRedlineTable } from "./businessRedlines.ts";
import { CONNECTOR_CLI_ONLY_TOOLS } from "./connectors/bundle.ts";
import { CONNECTOR_FLOWS } from "./connectors/flows.ts";

export class MarketplaceError extends Error {
  /** 哪道门拦的（manifest 清单校验 / deterministic 确定性规则 / reviewer 独立审查 / hygiene 脱敏 / license 许可证）；没填就是一般错误。 */
  gate?: string;
  constructor(message: string, gate?: string) {
    super(message);
    this.name = "MarketplaceError";
    if (gate) this.gate = gate;
  }
}

/** 市场是不受信任的第三方配置：浏览与详情页置顶的警告（抄 divo12 的文案）。 */
export const MARKET_WARNING =
"社区内容是不受信任的第三方配置；导入前检查，只读起步，发送/购买/删除留在审批后。";

export type MarketKind = "skill" | "bot" | "template" | "connector";

export interface MarketEntryMeta {
  id: string;
  kind: MarketKind;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  /** 来源链接（条目主页或仓库地址）。 */
  source?: string;
  /** 相对路径（相对市场源根目录）：技能是 .md 文件，机器人是目录。 */
  path: string;
  tools?: string[];
  permissions?: string[];
  mode?: string;
  updated_at?: string;
}

export interface MarketIndex {
  version: 1;
  name?: string;
  description?: string;
  updated_at?: string;
  entries: MarketEntryMeta[];
}

export interface MarketSource {
  name: string;
  kind: "local" | "git";
  /** 本地源是目录绝对路径；git 源是克隆到的本地目录绝对路径。 */
  path: string;
  url?: string;
  added_at: string;
}

export interface InstalledEntry {
  item_id: string;
  item_name: string;
  kind: MarketKind;
  version: string;
  /** 市场源名（本机发布记 "self"；单 Bot URL 安装记来源 slug，完整 URL 在 source_url）。 */
  source: string;
  author?: string;
  license?: string;
  installed_at: string;
  /** 绝对路径：只写账本，绝不进运行事件。 */
  installed_path: string;
  files: Record<string, string>;
  reviewer_source: string;
  reviewer_model: string | null;
  reviewer_decision: string;
  bot_ready: number;
  bot_ready_missing: string[];
  status: "installed" | "uninstalled" | "published";
  uninstalled_at?: string;
  uninstalled_files?: string[];
  published_at?: string;
  published_out_dir?: string;
  /** B2：安装时钉住的模型（bot.json 的 model 字段，须是已配置模型）。 */
  model?: string;
  /** B3：安装时核对过的环境变量声明（只记名字/说明/必填，不记值）。 */
  env_requires?: EnvRequirement[];
  /** B7：安装时声明的交接目标。 */
  hands_off_to?: HandoffTarget[];
  /** B5：单 Bot URL 安装时的完整 git 地址（源名记 slug，地址本身记这里）。 */
  source_url?: string;
  /** B6：安装时是否已把机器人登记进声明式 agent 花名册。 */
  agent_decl?: boolean;
  /** B6：花名册机器人的常驻会话 id（sessions.json 里那段会话）。 */
  agent_session_id?: string;
  /** B1：bot.json / routines.json 安装时的哈希（更新时判断用户有没有改过它们）。 */
  manifest_hashes?: Record<string, string>;
  /** B1：最近一次更新的时间（首次安装时不写）。 */
  updated_at?: string;
  /** B1：更新前的版本号（首次安装时不写）。 */
  previous_version?: string;
}

export function marketplaceSourcesPath(home: string): string {
  return join(home, "marketplace-sources.json");
}

export function marketplaceSourcesDir(home: string): string {
  return join(home, "marketplace-sources");
}

export function marketplaceLedgerPath(home: string): string {
  return join(home, "marketplace-installed.json");
}

export function marketplacePublishDir(home: string): string {
  return join(home, "market-publish");
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err: unknown) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// ---- 市场源（策展仓库的本地登记；绝不自动更新、绝不静默拉取） ----

export function loadMarketSources(home: string): MarketSource[] {
  const path = marketplaceSourcesPath(home);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new MarketplaceError(`市场源登记损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { sources?: unknown }).sources)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new MarketplaceError(`市场源登记格式无效，已备份到 ${backup}`);
  }
  return (raw as { sources: MarketSource[] }).sources;
}

export function saveMarketSources(home: string, sources: MarketSource[]): void {
  atomicWriteJson(marketplaceSourcesPath(home), { version: 1, sources });
}

function sourceNameFromInput(input: string): string {
  const base = basename(input.replace(/\.git$/, "").replace(/\/+$/, "")) || "market";
  const cleaned = base.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "market";
}

/**
 * B5：是不是单个 Bot 的 git 地址（与 addMarketSource 的判定同款，
 * 另接受 file:// 本地地址——测试用本地仓库，不联网；裸 .zip 不接受，
 * 中央短链服务不建，git 地址本身就是链接）。
 */
export function isMarketGitUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/\.zip$/i.test(trimmed)) return false;
  if (trimmed.startsWith("http://")) return false;
  return trimmed.startsWith("https://") || trimmed.startsWith("file://")
    || /^git@[^:]+:/.test(trimmed) || trimmed.endsWith(".git");
}

/**
 * B5 修复（Windows CI #792 实败）：file:// 地址先规范化再用。Windows 上手写
 * `file://D:\repos\bot`（反斜杠、两斜杠盘符）直接喂给 git clone 会失败；
 * 这里把反斜杠换成斜杠、盘符补成三斜杠（`file:///D:/repos/bot`）。
 * 非 file:// 地址原样返回；`file://主机名/...`（UNC 或误拼的主机名）不动，
 * 交给 git 去报错。纯字符串操作，不依赖平台，Linux 上也能测。
 */
export function normalizeMarketGitUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("file://")) return trimmed;
  let rest = trimmed.slice("file://".length).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(rest)) rest = `/${rest}`;
  return `file://${rest}`;
}

/**
* 登记一个市场源：本地目录（须含 index.json）或 git 地址（https / git@ /
* .git 结尾，git clone --depth 1 到 ~/.nyra/marketplace-sources/<名>/）。
* 已登记同名源先 remove 再 add；登记本身不拉取更新。
*/
export function addMarketSource(home: string, input: string): MarketSource {
  const trimmed = input.trim();
  if (!trimmed) throw new MarketplaceError("市场源不能为空");
  const sources = loadMarketSources(home);
  const isGit = trimmed.startsWith("https://") || /^git@[^:]+:/.test(trimmed) || trimmed.endsWith(".git");
  if (trimmed.startsWith("http://")) throw new MarketplaceError("只接受 https 或 git@ 来源，不接受明文 http");
  const name = sourceNameFromInput(trimmed);
  if (sources.some((s) => s.name === name)) {
    throw new MarketplaceError(`市场源 ${name} 已登记（先 nyra market source remove ${name} 再登记）`);
  }
  let source: MarketSource;
  if (isGit) {
    const dest = join(marketplaceSourcesDir(home), name);
    if (existsSync(dest)) throw new MarketplaceError(`市场源目录已存在：${dest}（先删掉再登记）`);
    mkdirSync(marketplaceSourcesDir(home), { recursive: true });
    try {
      execFileSync("git", ["clone", "--depth", "1", trimmed, dest], { timeout: 60000, stdio: "pipe", encoding: "utf-8" });
    } catch (err: unknown) {
      try { rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new MarketplaceError(`git 拉取失败：${trimmed}（${err instanceof Error ? err.message : String(err)}）`);
    }
    source = { name, kind: "git", path: dest, url: trimmed, added_at: new Date().toISOString() };
  } else {
    const dir = resolve(trimmed);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new MarketplaceError(`本地市场源不存在或不是目录：${dir}`);
    }
    if (!existsSync(join(dir, "index.json"))) {
      throw new MarketplaceError(`本地市场源缺少 index.json：${dir}（先确认它是市场仓库根目录）`);
    }
    source = { name, kind: "local", path: dir, added_at: new Date().toISOString() };
  }
  if (!existsSync(join(source.path, "index.json"))) {
    throw new MarketplaceError(`市场源缺少 index.json：${source.path}`);
  }
  saveMarketSources(home, [...sources, source]);
  return source;
}

export function removeMarketSource(home: string, name: string): boolean {
  const sources = loadMarketSources(home);
  const found = sources.find((s) => s.name === name);
  if (!found) return false;
  saveMarketSources(home, sources.filter((s) => s.name !== name));
  return true;
}

// ---- 安装账本（与缺口 11 的草稿账本同口径：原子写 0600，损坏先备份再抛错） ----

export function loadInstalledLedger(home: string): InstalledEntry[] {
  const path = marketplaceLedgerPath(home);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new MarketplaceError(`安装账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { entries?: unknown }).entries)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new MarketplaceError(`安装账本格式无效，已备份到 ${backup}`);
  }
  return (raw as { entries: InstalledEntry[] }).entries;
}

export function saveInstalledLedger(home: string, entries: InstalledEntry[]): void {
  atomicWriteJson(marketplaceLedgerPath(home), { version: 1, entries });
}

export function listInstalled(home: string): InstalledEntry[] {
  return loadInstalledLedger(home);
}

export function findInstalled(home: string, name: string): InstalledEntry | null {
  const entries = loadInstalledLedger(home);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].item_name === name && entries[i].status === "installed") return entries[i];
  }
  return null;
}

// ---- 索引与条目 ----

const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function loadMarketIndex(sourceDir: string): MarketIndex {
  const path = join(sourceDir, "index.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    throw new MarketplaceError(`读不到市场索引：${path}（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (!raw || typeof raw !== "object" || (raw as MarketIndex).version !== 1 || !Array.isArray((raw as MarketIndex).entries)) {
    throw new MarketplaceError(`市场索引格式无效：${path}（顶层须是 {version: 1, entries: [...]}）`);
  }
  for (const e of (raw as MarketIndex).entries) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !ENTRY_ID_RE.test(e.id)) {
      throw new MarketplaceError(`市场索引里有无效条目 id：${JSON.stringify(e?.id ?? null)}（只允许小写字母、数字、- 和 _）`);
    }
    if (e.kind !== "skill" && e.kind !== "bot" && e.kind !== "template" && e.kind !== "connector") throw new MarketplaceError(`条目 ${e.id} 的 kind 只允许 skill|bot|template|connector`);
    if (typeof e.name !== "string" || !e.name || typeof e.version !== "string" || !e.version || typeof e.path !== "string" || !e.path) {
      throw new MarketplaceError(`条目 ${e.id} 缺少 name/version/path`);
    }
  }
  return raw as MarketIndex;
}

export interface ResolvedEntry {
  entry: MarketEntryMeta;
  source: MarketSource;
  /** 条目在源内的绝对目录（技能是 .md 文件的绝对路径，机器人是目录）。 */
  dir: string;
}

/**
 * 目录包含判定（跨平台）：把 `\` 与 `/` 都归一成 `/` 再比对。
 * 直接写 `dir.startsWith(base + "/")` 在 Windows 下恒假（resolve 出来是反斜杠），
 * Node CI #315 只红 Windows 就是这个原因。分隔符归一后在任何平台都能测。
 */
export function isPathWithin(base: string, dir: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const b = norm(base);
  const d = norm(dir);
  return d === b || d.startsWith(b + "/");
}

export function resolveMarketEntry(home: string, id: string): ResolvedEntry | null {
  const sources = loadMarketSources(home);
  for (const source of sources) {
    let index: MarketIndex;
    try {
      index = loadMarketIndex(source.path);
    } catch {
      continue;
    }
    const entry = index.entries.find((e) => e.id === id);
    if (!entry) continue;
    const dir = resolve(source.path, entry.path);
    if (!isPathWithin(resolve(source.path), dir)) {
      throw new MarketplaceError(`条目 ${id} 的 path 越出市场源目录，拒绝加载：${entry.path}`);
    }
    return { entry, source, dir };
  }
  return null;
}

export interface ListedEntry {
  entry: MarketEntryMeta;
  source: string;
  botReady: BotReady;
}

export function listMarketEntries(home: string, opts?: { query?: string; source?: string }): ListedEntry[] {
  const sources = loadMarketSources(home);
  const out: ListedEntry[] = [];
  const q = (opts?.query ?? "").trim().toLowerCase();
  for (const source of sources) {
    if (opts?.source && source.name !== opts.source) continue;
    let index: MarketIndex;
    try {
      index = loadMarketIndex(source.path);
    } catch (err: unknown) {
      throw new MarketplaceError(`市场源 ${source.name} 的索引读失败：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const entry of index.entries) {
      if (q && !(entry.id.includes(q) || entry.name.toLowerCase().includes(q) || (entry.description ?? "").toLowerCase().includes(q))) continue;
      const dir = resolve(source.path, entry.path);
      const botReady = computeBotReadyForDir(entry, dir);
      out.push({ entry, source: source.name, botReady });
    }
  }
  out.sort((a, b) => b.botReady.score - a.botReady.score || a.entry.name.localeCompare(b.entry.name));
  return out;
}

// ---- 机器人清单（bot.json） ----

export type BotMode = "readonly" | "auto";

export interface BotRoutine {
  name: string;
  kind: "schedule" | "event";
  schedule?: string;
  event?: string;
  task: string;
  mode?: BotMode;
}

/** B3：机器人要用的环境变量声明（只声明、不带值；安装时逐项核对）。 */
export interface EnvRequirement {
  /** 环境变量名（大写字母开头，只含大写字母、数字、下划线）。 */
  name: string;
  description?: string;
  /** 必填时本机没设就明确告诉用户，不静默跳过。 */
  required?: boolean;
  /** 非密钥类的默认值（如有）；密钥不要写默认值。 */
  default?: string;
}

/** B7：机器人声明的交接目标（只声明意图，不自动放行写操作）。 */
export interface HandoffTarget {
  /** 目标机器人名（市场里另一台 Bot 的名字）。 */
  target: string;
  /** 什么情况下交过去（一句话条件，可空）。 */
  when?: string;
}

export interface BotManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  skills: string[];
  tools?: string[];
  permissions?: string[];
  /** 市场条目不许声明 full：新装机器人默认只读起步，写操作须用户显式放开。 */
  mode?: BotMode;
  /** B2：per-Bot 模型钉选（须是已配置的模型；不写则用配置默认模型）。 */
  model?: string;
  /** B3：要用的环境变量声明。 */
  env_requires?: EnvRequirement[];
  /** B7：交接目标声明（契约层 H7 未定之前只做声明与校验 + 已装目标的委派接线）。 */
  hands_off_to?: HandoffTarget[];
}

export function parseBotManifest(dir: string): BotManifest {
  const path = join(dir, "bot.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new MarketplaceError(`缺少可读的 bot.json：${path}`);
  }
  if (!raw || typeof raw !== "object") throw new MarketplaceError("bot.json 格式错误：顶层必须是对象");
  const m = raw as Record<string, unknown>;
  const name = m.name;
  if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) {
    throw new MarketplaceError("bot.json 的 name 无效（只允许小写字母、数字、- 和 _，以字母或数字开头）");
  }
  const version = m.version;
  if (typeof version !== "string" || !version) throw new MarketplaceError("bot.json 缺少 version");
  const skills = m.skills;
  if (!Array.isArray(skills) || !skills.length || skills.some((s) => typeof s !== "string" || !s)) {
    throw new MarketplaceError("bot.json 的 skills 必须是非空字符串数组");
  }
  const tools = m.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !/^[a-z][a-z0-9_]*$/.test(t)))) {
    throw new MarketplaceError("bot.json 的 tools 必须是非空字符串数组（Nyra 工具名）");
  }
  const permissions = m.permissions;
  if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !p))) {
    throw new MarketplaceError("bot.json 的 permissions 必须是非空字符串数组");
  }
  const mode = m.mode;
  if (mode !== undefined && mode !== "readonly" && mode !== "auto") {
    throw new MarketplaceError("bot.json 的 mode 只允许 readonly|auto：市场条目不许声明 full 模式（新装机器人默认只读起步）");
  }
  // B2：模型钉选只校验形状（非空字符串 ≤128 字）；是不是已配置的模型
  // 由安装/更新准备时用 validateBotModel 再核（parseBotManifest 拿不到
  // home，拼不出已知模型表；形状先拦，存在性后拦，两道都不放过）。
  const model = m.model;
  if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 128)) {
    throw new MarketplaceError("bot.json 的 model 须是非空字符串（最长 128 字）");
  }
  // B3：环境变量声明——只认名字/说明/必填/默认值四个字段，名字只许
  // 大写字母、数字、下划线；值一律不带（默认值也只许非密钥类的占位）。
  const envRequires = m.env_requires;
  let env_requires: EnvRequirement[] | undefined;
  if (envRequires !== undefined) {
    if (!Array.isArray(envRequires)) throw new MarketplaceError("bot.json 的 env_requires 必须是非空字符串数组");
    env_requires = [];
    for (const e of envRequires as Record<string, unknown>[]) {
      if (!e || typeof e !== "object") throw new MarketplaceError("bot.json 的 env_requires 里有非对象条目");
      if (typeof e.name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(e.name)) {
        throw new MarketplaceError("bot.json 的 env_requires.name 无效（大写字母开头，只含大写字母、数字、下划线）");
      }
      if (e.description !== undefined && (typeof e.description !== "string" || e.description.length > 200)) {
        throw new MarketplaceError(`bot.json 的 env_requires.${e.name}.description 须是不超过 200 字的字符串`);
      }
      if (e.required !== undefined && typeof e.required !== "boolean") {
        throw new MarketplaceError(`bot.json 的 env_requires.${e.name}.required 只允许 true/false`);
      }
      if (e.default !== undefined && (typeof e.default !== "string" || e.default.length > 200)) {
        throw new MarketplaceError(`bot.json 的 env_requires.${e.name}.default 须是不超过 200 字的字符串（密钥不要写默认值）`);
      }
      env_requires.push({
          name: e.name,
          ...(typeof e.description === "string" ? { description: e.description } : {}),
          ...(typeof e.required === "boolean" ? { required: e.required } : {}),
          ...(typeof e.default === "string" ? { default: e.default } : {}),
        });
    }
    if (!env_requires.length) throw new MarketplaceError("bot.json 的 env_requires 写了就不能为空数组");
  }
  // B7：交接目标声明——只认 target（机器人名）与 when（一句话条件）；
  // 目标存不存在安装时再核（目标可能后装），这里只校验名字形状。
  const handsOff = m.hands_off_to;
  let hands_off_to: HandoffTarget[] | undefined;
  if (handsOff !== undefined) {
    if (!Array.isArray(handsOff)) throw new MarketplaceError("bot.json 的 hands_off_to 必须是非空字符串数组");
    hands_off_to = [];
    for (const h of handsOff as Record<string, unknown>[]) {
      if (!h || typeof h !== "object") throw new MarketplaceError("bot.json 的 hands_off_to 里有非对象条目");
      if (typeof h.target !== "string" || !PLUGIN_NAME_RE.test(h.target)) {
        throw new MarketplaceError("bot.json 的 hands_off_to.target 无效（只允许小写字母、数字、- 和 _，以字母或数字开头）");
      }
      if (h.when !== undefined && (typeof h.when !== "string" || !h.when.trim() || h.when.length > 500)) {
        throw new MarketplaceError(`bot.json 的 hands_off_to.${h.target}.when 须是 1–500 字的字符串`);
      }
      hands_off_to.push({
          target: h.target,
          ...(typeof h.when === "string" ? { when: h.when.trim() } : {}),
        });
    }
    if (!hands_off_to.length) throw new MarketplaceError("bot.json 的 hands_off_to 写了就不能为空数组");
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
    mode: mode === undefined ? undefined : (mode as BotMode),
    ...(model === undefined ? {} : { model: (model as string).trim() }),
    ...(env_requires === undefined ? {} : { env_requires }),
    ...(hands_off_to === undefined ? {} : { hands_off_to }),
  };
}

/**
 * B2：bot.json 钉的模型是不是已配置的模型（内置模型目录 + 模型缓存 +
 * config 里的模型，复用 agentDeclCli 的 knownModelNames）。未知模型
 * 直接拒绝安装/更新，不静默回落到默认模型（回落等于悄悄换模型）。
 * key 仍在密码箱里，Bot 只拿模型名字，不复制、不新建任何静态 key。
 */
export function validateBotModel(home: string, model: string): void {
  const known = knownModelNames(home);
  if (!known.includes(model.trim())) {
    throw new MarketplaceError(`bot.json 钉的模型 ${model.trim()} 不是已配置的模型（内置模型目录、模型缓存、config 里的模型都不认它；先配好模型再装）`);
  }
}

export function parseRoutines(dir: string): BotRoutine[] {
  const path = join(dir, "routines.json");
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    throw new MarketplaceError(`routines.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) throw new MarketplaceError("routines.json 顶层必须是数组");
  const out: BotRoutine[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") throw new MarketplaceError("routines.json 里有非对象条目");
    if (typeof r.name !== "string" || !r.name) throw new MarketplaceError("routine 缺少 name");
    if (r.kind !== "schedule" && r.kind !== "event") throw new MarketplaceError(`routine ${r.name} 的 kind 只允许 schedule|event`);
    if (r.kind === "schedule" && (typeof r.schedule !== "string" || !r.schedule)) {
      throw new MarketplaceError(`routine ${r.name} 是 schedule 但没写 schedule`);
    }
    if (r.kind === "event" && (typeof r.event !== "string" || !r.event)) {
      throw new MarketplaceError(`routine ${r.name} 是 event 但没写 event`);
    }
    if (typeof r.task !== "string" || !r.task.trim() || r.task.length > 8000) {
      throw new MarketplaceError(`routine ${r.name} 的 task 为空或超过 8000 字`);
    }
    if (r.mode !== undefined && r.mode !== "readonly" && r.mode !== "auto") {
      throw new MarketplaceError(`routine ${r.name} 的 mode 只允许 readonly|auto（routine 不自动执行写操作）`);
    }
    out.push({
        name: r.name,
        kind: r.kind as "schedule" | "event",
        schedule: typeof r.schedule === "string" ? r.schedule : undefined,
        event: typeof r.event === "string" ? r.event : undefined,
        task: r.task,
        mode: r.mode === undefined ? undefined : (r.mode as BotMode),
      });
  }
  return out;
}

// ---- 第一道门：清单校验（确定性，零成本） ----

export interface EntryVerification {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: BotManifest | null;
  skillNames: string[];
  tools: string[];
  permissions: string[];
  highPrivilegeTools: string[];
  files: string[];
  routines: BotRoutine[];
}

function listEntryFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d).sort()) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${f}/`);
      else out.push(`${prefix}${f}`);
    }
  };
  walk(dir, "");
  return out;
}

/** 技能名规则与 saveSkillFile 同款：首字母数字，其余字母数字 - _。 */
export function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

export function verifyMarketplaceEntry(resolved: ResolvedEntry): EntryVerification {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  let manifest: BotManifest | null = null;
  let skillNames: string[] = [];
  let tools: string[] = [];
  let permissions: string[] = [];
  let routines: BotRoutine[] = [];
  const { entry, dir } = resolved;
  if (entry.kind === "skill" || entry.kind === "template") {
    files.push(entry.path);
  } else {
    try {
      files.push(...listEntryFiles(dir));
    } catch (err: unknown) {
      errors.push(`无法读取条目目录：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (entry.kind === "skill") {
    if (!existsSync(dir) || !statSync(dir).isFile()) {
      errors.push(`技能文件不存在：${entry.path}`);
    } else {
      try {
        const parsed = parseSkillText(readFileSync(dir, "utf-8"), dir);
        if (parsed.name !== entry.name) errors.push(`技能文件 ${entry.name}.md 的 name 是 ${parsed.name}，与索引不一致`);
        if (!isValidSkillName(parsed.name)) errors.push(`技能名 ${parsed.name} 无效（只允许字母、数字、- 和 _）`);
        if (PROTECTED_BUILTIN_SKILLS.includes(parsed.name)) errors.push(`技能名 ${parsed.name} 是内置技能，市场条目不得顶替`);
        if (!parsed.instructions.trim()) errors.push(`技能 ${parsed.name} 没有写做法（instructions 为空）`);
        skillNames = [parsed.name];
      } catch (err: unknown) {
        errors.push(`技能解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: errors.length === 0, errors, warnings, manifest, skillNames, tools, permissions, highPrivilegeTools: [], files, routines };
  }
  if (entry.kind === "template") {
    if (!existsSync(dir) || !statSync(dir).isFile()) {
      errors.push(`模板文件不存在：${entry.path}`);
    } else {
      try {
        const def = validateTemplateDefinition(
          parseTemplateText(readFileSync(dir, "utf-8"), entry.path), KNOWN_TOOLS, null,
        );
        if (def.name !== entry.name) errors.push(`模板文件里的 name 是 ${def.name}，与索引不一致`);
        if (def.version !== entry.version) errors.push(`模板文件里的 version 是 ${def.version}，与索引不一致`);
        tools = templateWorkflowTools(def);
        permissions = [
          ...def.connectors.map((c) => `connector:${c}`),
          ...def.approve_actions.map((a) => `approve:${a}`),
          ...def.never_actions.map((a) => `never:${a}`),
        ];
        if (!def.acceptance.length) warnings.push("模板没有验收标准（acceptance 为空），试跑时无法打分");
        if (!def.trial?.inputs && !def.trial_files?.length) warnings.push("模板没有试跑数据（trial.inputs 与 trial_files 都为空）");
      } catch (err: unknown) {
        errors.push(`模板解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: errors.length === 0, errors, warnings, manifest, skillNames, tools, permissions, highPrivilegeTools: [], files, routines };
  }
  if (entry.kind === "connector") {
    // 缺口 44 深化：连接器包（四件套）的清单校验——包是 connector.json +
    // tools.json / flows.json / redlines.json / permission-statement.txt，
    // 由 nyra connector bundle 导出；校验只认包里的四件套是否齐全一致，
    // 不联网、不读凭证。安装不走这里（prepare 里直接拒绝，见下）。
    const bundlePath = join(dir, "connector.json");
    if (!existsSync(bundlePath) || !statSync(bundlePath).isFile()) {
      errors.push(`连接器包缺 connector.json：${entry.path}（用 nyra connector bundle <id> 导出四件套）`);
    } else {
      try {
        const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as Record<string, unknown>;
        if (bundle.kind !== "connector") errors.push(`connector.json 的 kind 不是 connector`);
        if (bundle.connector !== entry.name && bundle.displayName !== entry.name) errors.push(`connector.json 的连接器是 ${String(bundle.connector ?? "?")}，与索引的 ${entry.name} 不一致`);
        if (typeof bundle.version === "string" && bundle.version !== entry.version) errors.push(`connector.json 的 version 是 ${bundle.version}，与索引不一致`);
        const bundleTools = Array.isArray(bundle.tools) ? bundle.tools as Array<Record<string, unknown>> : [];
        if (!bundleTools.length) errors.push("连接器包没有工具（tools 为空）");
        for (const t of bundleTools) {
          const name = String(t.name ?? "");
          if (!name) { errors.push("连接器包里有没名字的工具"); continue; }
          tools.push(name);
          if (t.surface === "model") {
            if (!KNOWN_TOOLS.has(name)) errors.push(`声明的模型工具 ${name} 不是 Nyra 已知的工具`);
          } else if (t.surface === "cli") {
            if (!(name in CONNECTOR_CLI_ONLY_TOOLS)) errors.push(`声明的终端工具 ${name} 不在 CLI-only 白名单里`);
          } else {
            errors.push(`工具 ${name} 的 surface 既不是 model 也不是 cli`);
          }
        }
        const bundleFlows = Array.isArray(bundle.flows) ? bundle.flows as Array<Record<string, unknown>> : [];
        if (!bundleFlows.length) errors.push("连接器包没有业务流程（flows 为空）");
        for (const f of bundleFlows) {
          const id = String(f.id ?? "");
          const def = CONNECTOR_FLOWS.find((x) => x.id === id);
          if (!def) { errors.push(`流程 ${id} 不存在（nyra connector flows 列出能用的）`); continue; }
          if (!Array.isArray(f.acceptance) || !(f.acceptance as unknown[]).length) errors.push(`流程 ${id} 没有验收标准`);
        }
        const redlineTable = String(bundle.redlineTable ?? "");
        if (!redlineTable || !hasRedlineTable(String(bundle.connector ?? ""))) errors.push("连接器包没有有效的默认红线表（redlineTable）");
        // 权限声明只按包里工具实际用到的业务动作派生（不是整张红线表）：
        // 只读连接器的包不该凭空多出 approve:send_message。
        const permSet = new Set<string>();
        for (const t of bundleTools) {
          if (typeof t.action === "string" && t.tier === "approve") permSet.add(`approve:${t.action}`);
          else if (typeof t.action === "string" && t.tier === "never") permSet.add(`never:${t.action}`);
        }
        permissions.push(...permSet);
        permissions.unshift(`connector:${String(bundle.connector ?? entry.name)}`);
        const statementPath = join(dir, "permission-statement.txt");
        if (!existsSync(statementPath) || !readFileSync(statementPath, "utf-8").trim()) {
          errors.push("连接器包缺 permission-statement.txt（权限声明文本）");
        }
        for (const f of ["tools.json", "flows.json", "redlines.json"]) {
          if (!existsSync(join(dir, f))) errors.push(`连接器包缺 ${f}`);
        }
      } catch (err: unknown) {
        errors.push(`connector.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: errors.length === 0, errors, warnings, manifest, skillNames, tools, permissions, highPrivilegeTools: [], files, routines };
  }
  try {
    manifest = parseBotManifest(dir);
  } catch (err: unknown) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (manifest) {
    skillNames = manifest.skills;
    tools = manifest.tools ?? [];
    permissions = manifest.permissions ?? [];
    for (const skill of manifest.skills) {
      const path = join(dir, "skills", `${skill}.md`);
      if (!existsSync(path)) {
        errors.push(`清单声明的技能缺文件：skills/${skill}.md`);
        continue;
      }
      try {
        const parsed = parseSkillFile(path);
        if (parsed.name !== skill) errors.push(`技能文件 ${skill}.md 的 name 是 ${parsed.name}，与清单不一致`);
        if (!isValidSkillName(parsed.name)) errors.push(`技能名 ${parsed.name} 无效（只允许字母、数字、- 和 _）`);
        if (PROTECTED_BUILTIN_SKILLS.includes(skill)) errors.push(`技能名 ${skill} 是内置技能，插件不得顶替`);
        if (!parsed.instructions.trim()) errors.push(`技能 ${skill} 没有写做法（instructions 为空）`);
      } catch (err: unknown) {
        errors.push(`技能 ${skill} 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const tool of tools) {
      if (!KNOWN_TOOLS.has(tool)) errors.push(`声明的工具 ${tool} 不是 Nyra 已知的工具`);
    }
    if (!tools.length) warnings.push("未声明 tools 白名单：默认最小权限，建议写明它要用的工具");
    if (!permissions.length) warnings.push("未声明 permissions 清单");
    if (!manifest.license) warnings.push("未声明 license：Bot Ready 扣分，发布时许可证必填");
    try {
      routines = parseRoutines(dir);
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    const panelDir = join(dir, "panel");
    if (existsSync(panelDir)) {
      for (const f of readdirSync(panelDir).sort()) {
        if (!f.endsWith(".html")) {
          errors.push(`panel 只允许 .html 文件：${f}`);
          continue;
        }
        const html = readFileSync(join(panelDir, f), "utf-8");
        for (const p of checkPanelSelfContained(html)) errors.push(`面板 ${f}：${p}`);
      }
    }
  }
  const highPrivilegeTools = tools.filter((t) => HIGH_PRIVILEGE_TOOLS.has(t));
  if (highPrivilegeTools.length) {
    warnings.push(`高权限工具：${highPrivilegeTools.join("、")}（安装确认时须单独说明风险）`);
  }
  return { ok: errors.length === 0, errors, warnings, manifest, skillNames, tools, permissions, highPrivilegeTools, files, routines };
}

// ---- 第二道门：确定性规则（技能正文与 routine 里的高危模式） ----
//
// 规则 id 与缺口 10 的确定性规则同款（destructive-rm / pipe-to-shell /
// disk-destroy / credential-exfil / private-key-in-send 的文本版）：
// 散文里的“不要 rm -rf /”不算——只扫命令形态的文本（围栏代码块、行内代码、
// 以 ! 开头的内联命令、routine 的 task 文本），私钥 PEM 块除外（正文里出现
// 就是密钥，整段都扫）。漏判由第三道门（模型审查）兜底，误判必须接近零。

export interface ScanHit {
  rule: string;
  reason: string;
  where: string;
}

function extractCodeLike(text: string): string {
  const parts: string[] = [];
  // 围栏代码块与行内代码用字符串拼正则：反引号写进正则字面量会干扰缩进脚本。
  const fenced = new RegExp("```(?:[a-zA-Z0-9_-]*)?\\n([\\s\\S]*?)```", "g");
  for (const m of text.matchAll(fenced)) parts.push(m[1]);
  const inline = new RegExp("`([^`\n]+)`", "g");
  for (const m of text.matchAll(inline)) parts.push(m[1]);
  for (const line of text.split("\n")) {
    if (/^\s*!/.test(line)) parts.push(line.replace(/^\s*!/, ""));
  }
  return parts.join("\n");
}

function shellSegments(command: string): string[] {
  return command.split(/(?:;|&&|\|\||\|)/).map((s) => s.trim()).filter(Boolean);
}

const SCAN_RULES: { id: string; description: string; test: (code: string, full: string) => boolean }[] = [
  {
    id: "destructive-rm",
    description: "rm -rf 的目标是根目录、家目录或通配符",
    test: (code) => {
      for (const seg of shellSegments(code)) {
        if (!/^rm\b/.test(seg)) continue;
        if (!/-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/.test(seg)) continue;
        const tokens = seg.split(/\s+/).filter(Boolean);
        const target = tokens.slice(1).find((t) => !t.startsWith("-"));
        if (target === undefined) continue;
        if (["/", "~", "$HOME", "${HOME}", "*", ".", ".."].includes(target)) return true;
        if (target.startsWith("/*")) return true;
      }
      return false;
    },
  },
  {
    id: "pipe-to-shell",
    description: "curl/wget 下载后直接管道进 shell 执行",
    test: (code) => /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash|zsh|dash)\b/.test(code),
  },
  {
    id: "disk-destroy",
    description: "mkfs 或 dd 写原始设备",
    test: (code) => {
      for (const seg of shellSegments(code)) {
        if (/^mkfs\b/.test(seg)) return true;
        if (/^dd\b/.test(seg) && seg.includes("of=/dev/")) return true;
      }
      return false;
    },
  },
  {
    id: "credential-exfil",
    description: "读私钥/凭证文件后经网络工具外发",
    test: (code) => {
      const readsSecret = code.includes("~/.ssh/") || code.includes(".ssh/id_") || code.includes("-----BEGIN");
      if (!readsSecret) return false;
      const tokens = code.split(/[\s|;&()<>]+/).filter(Boolean);
      return tokens.some((t) => ["curl", "wget", "nc", "ncat", "ssh"].includes(t));
    },
  },
  {
    id: "private-key",
    description: "文本里含私钥 PEM 块",
    test: (_code, full) => /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(full),
  },
];

/** 扫一段文本：返回命中的规则（只报规则 id 与位置，不回显原文）。 */
export function scanMarketplaceText(text: string, where: string): ScanHit[] {
  const code = extractCodeLike(text);
  const hits: ScanHit[] = [];
  for (const rule of SCAN_RULES) {
    if (rule.test(code, text)) {
      hits.push({ rule: rule.id, reason: `命中确定性规则 ${rule.id}：${rule.description}`, where });
    }
  }
  return hits;
}

/** 扫整个条目：全部技能正文 + routine 的 task 文本 + bot.json 描述。 */
export function scanMarketplaceEntry(resolved: ResolvedEntry): ScanHit[] {
  const hits: ScanHit[] = [];
  const { entry, dir } = resolved;
  const pushFile = (path: string, where: string) => {
    if (!existsSync(path)) return;
    hits.push(...scanMarketplaceText(readFileSync(path, "utf-8"), where));
  };
  if (entry.kind === "skill") {
    pushFile(dir, entry.path);
    return hits;
  }
  if (entry.kind === "template") {
    if (existsSync(dir) && statSync(dir).isFile()) {
      const text = readFileSync(dir, "utf-8");
      hits.push(...scanMarketplaceText(text, entry.path));
      // 第三方模板禁 shell 与 http_post：业务流程不该跑任意命令或对外发请求。
      try {
        const def = validateTemplateDefinition(parseTemplateText(text, entry.path), KNOWN_TOOLS, null);
        for (const t of collectWorkflowTools(def.workflow)) {
          if (t.tool === "shell") hits.push({ rule: "template-shell", where: `${entry.path}:${t.id}`, reason: "模板流程里不许用 shell 工具（第三方模板不得跑任意命令）" });
          if (t.tool === "http_post") hits.push({ rule: "template-http-post", where: `${entry.path}:${t.id}`, reason: "模板流程里不许用 http_post 工具（第三方模板不得对外发请求）" });
        }
      } catch { /* 清单校验已报错，这里不重复报 */ }
    }
    return hits;
  }
  if (entry.kind === "connector") {
    // 缺口 44 深化：连接器包没有可执行步骤，扫一遍包里的文本文件（声明、
    // 工具、流程、红线、权限声明）找高危模式；包里不许出现 shell / http_post
    // 这类工具名以外的可执行指令。
    for (const f of ["connector.json", "tools.json", "flows.json", "redlines.json", "permission-statement.txt", "market-entry.json"]) {
      pushFile(join(dir, f), f);
    }
    return hits;
  }
  const skillsDir = join(dir, "skills");
  if (existsSync(skillsDir)) {
    for (const f of readdirSync(skillsDir).sort()) {
      if (f.endsWith(".md")) pushFile(join(skillsDir, f), `skills/${f}`);
    }
  }
  try {
    for (const r of parseRoutines(dir)) {
      hits.push(...scanMarketplaceText(r.task, `routines.json:${r.name}`));
    }
  } catch { /* 清单校验已报错，这里不重复报 */ }
  try {
    const manifest = parseBotManifest(dir);
    if (manifest.description) hits.push(...scanMarketplaceText(manifest.description, "bot.json:description"));
  } catch { /* 清单校验已报错，这里不重复报 */ }
  return hits;
}

// ---- Bot Ready 评分（抄 cobusgreyling 的做法：100/100 才算稳定） ----

export interface BotReady {
  score: number;
  missing: string[];
}

const MAINTENANCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export function computeBotReady(input: {
    license?: string | null;
    source?: string | null;
    skillsOk: boolean;
    toolsDeclared: boolean;
    toolsKnown: boolean;
    scanHits: number;
    updatedAt?: string | null;
    newestMtimeMs?: number | null;
  }): BotReady {
  let score = 0;
  const missing: string[] = [];
  if (input.license) score += 20;
  else missing.push("无许可证");
  if (input.source) score += 15;
  else missing.push("无来源链接");
  if (input.skillsOk) score += 20;
  else missing.push("技能不可解析或缺文件");
  if (input.toolsDeclared && input.toolsKnown) score += 15;
  else if (!input.toolsDeclared) missing.push("未声明工具");
  else missing.push("声明了未知工具");
  if (input.scanHits === 0) score += 15;
  else missing.push(`命中 ${input.scanHits} 条高危模式`);
  const updatedMs = input.updatedAt ? Date.parse(input.updatedAt) : NaN;
  const fresh = (Number.isFinite(updatedMs) && Date.now() - updatedMs <= MAINTENANCE_WINDOW_MS)
  || (typeof input.newestMtimeMs === "number" && Date.now() - input.newestMtimeMs <= MAINTENANCE_WINDOW_MS);
  if (fresh) score += 15;
  else missing.push("90 天内无维护信号");
  return { score, missing };
}

function newestMtimeMs(dir: string): number | null {
  if (!existsSync(dir)) return null;
  if (statSync(dir).isFile()) return statSync(dir).mtimeMs;
  let newest: number | null = null;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

/** 列表用的评分：只读索引元数据 + 条目文件（不调模型、不联网）。 */
export function computeBotReadyForDir(entry: MarketEntryMeta, dir: string): BotReady {
  // 模板不参与 Bot Ready 评分：模板的“就绪”是试跑 + 人工确认，不是静态分。
  if (entry.kind === "template") {
    return { score: 0, missing: ["模板不参与 Bot Ready 评分（须试跑 + 人工确认后才激活）"] };
  }
  // 缺口 44 深化：连接器包也不参与评分——它的“就绪”是安装授权 + 流程试跑，
  // 不是静态分（包本身的完整性由 verifyMarketplaceEntry 的 connector 分支验）。
  if (entry.kind === "connector") {
    return { score: 0, missing: ["连接器不参与 Bot Ready 评分（须安装授权 + 试跑流程后才可用）"] };
  }
  let skillsOk = false;
  let toolsKnown = true;
  let scanHits = 0;
  try {
    if (entry.kind === "skill") {
      if (existsSync(dir) && statSync(dir).isFile()) {
        const parsed = parseSkillText(readFileSync(dir, "utf-8"), dir);
        skillsOk = parsed.name === entry.name && Boolean(parsed.instructions.trim());
        scanHits = scanMarketplaceText(readFileSync(dir, "utf-8"), entry.path).length;
      }
    } else {
      const verification = verifyMarketplaceEntry({ entry, source: { name: "", kind: "local", path: dirname(dir), added_at: "" }, dir });
      skillsOk = verification.ok;
      scanHits = scanMarketplaceEntry({ entry, source: { name: "", kind: "local", path: dirname(dir), added_at: "" }, dir }).length;
      toolsKnown = (entry.tools ?? []).length === 0 || (verification.tools ?? []).every((t) => KNOWN_TOOLS.has(t));
    }
  } catch {
    skillsOk = false;
  }
  return computeBotReady({
      license: entry.license,
      source: entry.source,
      skillsOk,
      toolsDeclared: (entry.tools ?? []).length > 0,
      toolsKnown,
      scanHits,
      updatedAt: entry.updated_at,
      newestMtimeMs: newestMtimeMs(dir),
    });
}

// ---- 第三道门：独立审查（缺口 10 的模型审查，fail-closed） ----

/**
* 市场动作的模型审查。审查层未开启时返回 skipped（只走了两道确定性门，
* 调用方必须明确告诉用户——与候选提案 1 的 bughunt check 同口径）；
* 开启后审查模型不可用 / 无有效结论 → BLOCK（fail-closed）。
* 被审集用合并后的配置：用户显式收窄 reviewer.tools 也不影响市场这道门
* （市场内容是不受信任的第三方配置，审查不能被配置收窄悄悄跳过）。
*/
export async function reviewMarketplaceAction(opts: {
    config: Record<string, unknown>;
    home: string;
    action: "marketplace_install" | "marketplace_publish";
    itemName: string;
    kind: MarketKind;
    author?: string | null;
    license?: string | null;
    tools: string[];
    permissions: string[];
    mode: string;
    runner?: ReviewerLike | null;
  }): Promise<ReviewVerdict> {
  const cfg = opts.config;
  const reviewer = (cfg.reviewer ?? {}) as Record<string, unknown>;
  if (reviewer.enabled !== true) {
    return {
      decision: "ALLOW",
      reason: "审查层未开启：只走了两道确定性门（清单校验 + 确定性规则），未过模型审查；新装机器人默认只读起步",
      reviewerModel: null,
      source: "skipped",
    };
  }
  const merged: Record<string, unknown> = {
    ...cfg,
    reviewer: {
      ...(reviewer as Record<string, unknown>),
      tools: [...new Set([...(Array.isArray(reviewer.tools) ? (reviewer.tools as string[]) : []), opts.action])],
    },
  };
  const runner = opts.runner !== undefined ? opts.runner : buildReviewerRunner(cfg, opts.home);
  const verb = opts.action === "marketplace_install" ? "安装市场条目" : "发布市场条目";
  return reviewToolCall({
      config: merged,
      tool: opts.action,
      args: {
        item_name: opts.itemName,
        kind: opts.kind,
        author: opts.author ?? "",
        license: opts.license ?? "",
        tools: opts.tools.join(","),
        permissions: opts.permissions.join(","),
        mode: opts.mode,
      },
      task: `${verb} ${opts.itemName}（${opts.kind}，作者 ${opts.author ?? "未知"}，许可证 ${opts.license ?? "未声明"}，声明工具 ${opts.tools.join("、") || "未声明"}，权限 ${opts.permissions.join("、") || "未声明"}，模式 ${opts.mode}）`,
      runner,
    });
}

// ---- 安装：先准备（三道门）再执行（确认后才装） ----

export interface InstallPrepared {
  entry: MarketEntryMeta;
  source: MarketSource;
  dir: string;
  verification: EntryVerification;
  scanHits: ScanHit[];
  botReady: BotReady;
  review: ReviewVerdict;
  plannedChanges: string[];
  /** B5：单 Bot URL 安装时的临时克隆目录清理函数（调用方装完/取消后调）。 */
  cleanup?: () => void;
  /** B5：单 Bot URL 安装时的完整 git 地址（记进账本 source_url）。 */
  sourceUrl?: string;
}

function eventItemName(name: string): string {
  // 事件字段过 appendEvent 的 redact：≥32 字的连续词串会被当成疑似密钥掩掉，
  // 名字超长时事件里只留前 28 字，全名在账本里（与缺口 11 的 slug 上限同理）。
  return name.length > 28 ? name.slice(0, 28) : name;
}

function recordMarketEvent(store: RunStore | undefined, runId: string | undefined, type: string, fields: Record<string, unknown>): void {
  if (!store || !runId) return;
  try {
    store.appendEvent(runId, type, fields);
  } catch { /* 运行目录没了只丢审计副本，不破坏安装本身 */ }
}

/**
 * B4：routine 预览写全文，不只写个数（与审批卡盖住真参数同一条线）。
 * 每条一行名 + 时间表/事件 + 任务全文；任务超过 400 字截断并注明全文
 * 在条目目录的 routines.json 里，不为预览单独造渲染。
 */
export function formatRoutinesForDisplay(routines: BotRoutine[]): string[] {
  const lines: string[] = [];
  lines.push(`routine：${routines.length} 个（只随机器人安装，不自动执行，须手动启用）`);
  for (const r of routines) {
    const when = r.kind === "schedule" ? `定时 ${r.schedule}` : `事件 ${r.event}`;
    const task = r.task.length > 400 ? `${r.task.slice(0, 400)}……（全文在条目目录 routines.json 里）` : r.task;
    lines.push(`  - ${r.name}（${when}，${r.mode ?? "readonly"}）：${task}`);
  }
  return lines;
}

/** B3：按 env_requires 生成 .env.EXAMPLE 文本（只写名字与说明，不写值）。 */
export function envExampleText(manifest: BotManifest): string {
  const lines: string[] = ["# 市场机器人需要的环境变量（照着填进你自己的 .env，不要提交）："];
  for (const e of manifest.env_requires ?? []) {
    if (e.description) lines.push(`# ${e.name}：${e.description}`);
    lines.push(`${e.name}=${e.default ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

export function describeInstallPlan(prepared: InstallPrepared): string {
  const lines: string[] = [];
  lines.push(MARKET_WARNING);
  const e = prepared.entry;
  lines.push(`条目：${e.name} v${e.version}（${e.kind === "skill" ? "技能包" : e.kind === "template" ? "业务流程模板" : "机器人配置"}，来源 ${prepared.source.name}:${e.id}）`);
  if (e.description) lines.push(`说明：${e.description}`);
  lines.push(`装到：${e.kind === "skill" ? `~/.nyra/skills/${e.name}.md` : e.kind === "template" ? `~/.nyra/templates/${templateSlug(e.name)}${/\.json$/i.test(e.path) ? ".json" : ".yaml"}` : `~/.nyra/plugins/${e.name}/`}`);
  lines.push(`声明的工具：${prepared.verification.tools.join("、") || "未声明"}`);
  lines.push(`声明的权限：${prepared.verification.permissions.join("、") || "未声明"}`);
  if (e.kind === "template") {
    lines.push("模板只装草稿：激活前须试跑 + 人工确认（nyra template trial/activate），激活后每次执行仍走审批，发出须人批。");
  } else {
    lines.push(`模式：${e.mode ?? "readonly"}（新装机器人默认只读起步，写操作须用户显式放开）`);
  }
  if (prepared.verification.highPrivilegeTools.length) {
    lines.push(`⚠ 高权限工具：${prepared.verification.highPrivilegeTools.join("、")}——装完后每次调用仍需审批，请确认你真的需要它。`);
  }
  // B3：环境变量逐项核对（只报“已设置/未设置”，绝不打印值）。
  const manifest = prepared.verification.manifest;
  if (manifest?.env_requires?.length) {
    lines.push("环境变量：");
    for (const e of manifest.env_requires) {
      const set = process.env[e.name] !== undefined && process.env[e.name] !== "";
      lines.push(`  - ${e.name}${e.required ? "（必填）" : "（选填）"}：${set ? "已设置" : "未设置"}${e.description ? `——${e.description}` : ""}`);
    }
    lines.push("  （装完后在机器人目录里有 .env.EXAMPLE，照着填进你自己的 .env；安装时不替你填 key。）");
  }
  // B7：交接目标声明（目标装没装、接没接线，装时再核）。
  if (manifest?.hands_off_to?.length) {
    lines.push(`交接目标：${manifest.hands_off_to.map((h) => `${h.target}${h.when ? `（${h.when}）` : ""}`).join("、")}（交接不自动放行写操作，写操作仍须审批）`);
  }
  if (prepared.verification.routines.length) {
    lines.push(...formatRoutinesForDisplay(prepared.verification.routines));
  }
  for (const w of prepared.verification.warnings) lines.push(`提醒：${w}`);
  lines.push(`Bot Ready：${prepared.botReady.score}/100${prepared.botReady.missing.length ? `（缺：${prepared.botReady.missing.join("、")}）` : "（满分）"}`);
  lines.push(`审查：${prepared.review.source === "skipped" ? "已跳过（审查层未开启；只走了两道确定性门）" : `${prepared.review.decision === "ALLOW" ? "通过" : "拦截"}（${prepared.review.reviewerModel ?? ""}，${prepared.review.reason}）`}`);
  return lines.join("\n");
}

/** 三道门按顺序过：清单校验 → 确定性规则 → 独立审查；一道不过就抛错、写清哪道门为什么。 */
export async function prepareMarketplaceInstall(
  home: string,
  id: string,
  opts: { config: Record<string, unknown>; runner?: ReviewerLike | null },
): Promise<InstallPrepared> {
  const resolved = resolveMarketEntry(home, id);
  if (!resolved) throw new MarketplaceError(`市场里没有条目 ${id}（先 nyra market list 看看）`);
  return prepareMarketplaceInstallFromResolved(home, resolved, opts);
}

/** 三道门（已解析的条目版）：安装与更新共用，更新时传新版的 resolved。 */
export async function prepareMarketplaceInstallFromResolved(
  home: string,
  resolved: ResolvedEntry,
  opts: { config: Record<string, unknown>; runner?: ReviewerLike | null },
): Promise<InstallPrepared> {
  // 缺口 44 深化：连接器条目只验证、不安装——内置连接器已在代码里（nyra
  // connector list），包里的四件套（声明/工具/流程/红线）没有地方可以“装”
  // 进去：声明是代码、凭证只存密码箱。第三方连接器安装是下一批（须先有
  // 第三方声明注册表），现在装了也落不了地，不如明说拒绝。
  if (resolved.entry.kind === "connector") {
    throw new MarketplaceError("连接器条目只验证、不安装：内置连接器已在代码里（nyra connector list 看看），第三方连接器安装是下一批");
  }
  const verification = verifyMarketplaceEntry(resolved);
  if (!verification.ok) {
    throw new MarketplaceError(`清单校验不过，拒绝安装：\n${verification.errors.map((e) => `- ${e}`).join("\n")}`, "manifest");
  }
  // B2：钉的模型须是已配置的模型，未知模型直接拒绝，不静默回落默认模型。
  if (verification.manifest?.model) validateBotModel(home, verification.manifest.model);
  const scanHits = scanMarketplaceEntry(resolved);
  if (scanHits.length) {
    throw new MarketplaceError(`确定性规则拦截，拒绝安装：\n${scanHits.map((h) => `- ${h.where}：${h.reason}`).join("\n")}`, "deterministic");
  }
  const botReady = computeBotReadyForDir(resolved.entry, resolved.dir);
  const manifest = verification.manifest;
  const review = await reviewMarketplaceAction({
      config: opts.config,
      home,
      action: "marketplace_install",
      itemName: resolved.entry.name,
      kind: resolved.entry.kind,
      author: resolved.entry.author ?? manifest?.author,
      license: resolved.entry.license ?? manifest?.license,
      tools: verification.tools,
      permissions: verification.permissions,
      mode: resolved.entry.mode ?? manifest?.mode ?? "readonly",
      runner: opts.runner,
    });
  if (review.decision === "BLOCK") {
    throw new MarketplaceError(`独立审查拦截，拒绝安装（${review.reviewerModel ?? ""}）：${review.reason}`, "reviewer");
  }
  const prepared: InstallPrepared = {
    entry: resolved.entry,
    source: resolved.source,
    dir: resolved.dir,
    verification,
    scanHits,
    botReady,
    review,
    plannedChanges: [],
  };
  prepared.plannedChanges = describeInstallPlan(prepared).split("\n");
  return prepared;
}

/**
 * B5：单个 Bot 的一键 URL 安装——git clone 一个 Bot 仓库（根目录须含
 * bot.json），走同一套三道门。只接 git 地址（https/git@/file://），
 * 不支持裸 .zip，不建中央短链服务。克隆是临时目录（.git 随即删掉，
 * 只留条目文件），调用方须在装完或取消后调 prepared.cleanup()。
 */
export async function prepareMarketplaceInstallFromUrl(
  home: string,
  url: string,
  opts: { config: Record<string, unknown>; runner?: ReviewerLike | null },
): Promise<InstallPrepared> {
  const trimmed = normalizeMarketGitUrl(url);
  if (!isMarketGitUrl(trimmed)) {
    throw new MarketplaceError(`不是 git 地址：${trimmed}（单个 Bot 安装只接 git 仓库地址，裸 .zip 不支持）`);
  }
  // 临时克隆目录放在 ~/.nyra/marketplace-tmp/ 下，不在 /tmp 上：
  // 有的机器 /tmp 只有 512M，装到一半写满就装不上（全量测试就这么败过）。
  // 目录是本批一次性的，调用方须在装完或取消后调 prepared.cleanup()。
  const tmpBase = join(home, ".nyra", "marketplace-tmp");
  mkdirSync(tmpBase, { recursive: true });
  const dir = mkdtempSync(join(tmpBase, "nyra-market-url-"));
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
  try {
    execFileSync("git", ["clone", "--depth", "1", trimmed, dir], { timeout: 60000, stdio: "pipe", encoding: "utf-8" });
  } catch (err: unknown) {
    cleanup();
    throw new MarketplaceError(`git 拉取失败：${trimmed}（${err instanceof Error ? err.message : String(err)}）`);
  }
  // 临时目录只留条目文件：.git 删掉，清单校验不扫它，安装也不带它走。
  try { rmSync(join(dir, ".git"), { recursive: true, force: true }); } catch { /* ignore */ }
  let manifest: BotManifest;
  try {
    manifest = parseBotManifest(dir);
  } catch (err: unknown) {
    cleanup();
    throw new MarketplaceError(`这个仓库根目录不是单个 Bot（须含合法的 bot.json）：${err instanceof Error ? err.message : String(err)}`);
  }
  const slug = sourceNameFromInput(trimmed);
  const entry: MarketEntryMeta = {
    id: manifest.name,
    kind: "bot",
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    license: manifest.license,
    source: manifest.homepage ?? trimmed,
    path: ".",
    tools: manifest.tools,
    permissions: manifest.permissions,
    mode: manifest.mode,
  };
  const source: MarketSource = { name: slug, kind: "git", path: dir, url: trimmed, added_at: new Date().toISOString() };
  try {
    const prepared = await prepareMarketplaceInstallFromResolved(home, { entry, source, dir }, opts);
    prepared.cleanup = cleanup;
    prepared.sourceUrl = trimmed;
    return prepared;
  } catch (err: unknown) {
    cleanup();
    throw err;
  }
}

function stageBotEntry(entryDir: string, manifest: BotManifest): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nyra-market-"));
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
  try {
    const pluginJson = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      license: manifest.license,
      homepage: manifest.homepage,
      skills: manifest.skills,
      tools: manifest.tools,
      permissions: manifest.permissions,
    };
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n", "utf-8");
    const skillsDir = join(entryDir, "skills");
    if (existsSync(skillsDir)) {
      mkdirSync(join(dir, "skills"), { recursive: true });
      for (const f of readdirSync(skillsDir).sort()) {
        if (f.endsWith(".md")) copyFileSync(join(skillsDir, f), join(dir, "skills", f));
      }
    }
    const panelDir = join(entryDir, "panel");
    if (existsSync(panelDir)) {
      mkdirSync(join(dir, "panel"), { recursive: true });
      for (const f of readdirSync(panelDir).sort()) {
        if (f.endsWith(".html")) copyFileSync(join(panelDir, f), join(dir, "panel", f));
      }
    }
    return { dir, cleanup };
  } catch (err: unknown) {
    cleanup();
    throw err;
  }
}

export interface InstallResult {
  installed: InstalledEntry;
  files: string[];
  overwritten: boolean;
  keptModified: string[];
  /** B6/B7：花名册登记或交接接线没做成时的提醒（安装本身已成功）。 */
  warnings?: string[];
}

// ---- B6：市场机器人进花名册（nyra-agent-v1 声明 + 常驻会话） ----
//
// “Bot”是本地专长 agent（缺口 42 的“每 Bot 一台持久电脑”是另一回事，
// 别混）：装完后它就是一条已注册的声明，`nyra agent list` 里能看见，
// `nyra agent run <名字> "<任务>"` 就能跑它（钉的模型自动用上，见 B2）。
// 常驻会话是它在 sessions.json 里的那段会话（复用联合会话账本，不另起
// 存储）；`nyra agent run` 每次仍是新开一轮，不自动续进这段会话——
// run 与会话的绑定是另一件工作，不在这里顺手做。
// 桌面花名册 UI 是桌面端的事，本批只做 CLI/网关侧。

/** 市场生成的声明说明前缀：卸载/更新时凭它认出这条声明是不是市场生成的。 */
export const MARKET_DECL_INSTRUCTIONS_PREFIX = "【市场机器人";

/**
 * 把市场机器人转成 nyra-agent-v1 声明对象 + 存盘文本（JSON，最稳，不拼 YAML）。
 * instructions 只写“这个机器人是谁、干什么、用什么工具”，不写任何
 * “忽略/覆盖指令、执行命令、泄露密钥”类话；第三方描述过注入扫描就
 * 拒绝登记（安装本身不受影响，只是不进花名册，原因写进警告）。
 */
export function marketBotToAgentDecl(
  home: string,
  manifest: BotManifest,
  installedTargets: { target: string; when?: string }[],
): { decl: AgentDecl; text: string } {
  const mode = manifest.mode ?? "readonly";
  const lines: string[] = [];
  lines.push(`${MARKET_DECL_INSTRUCTIONS_PREFIX} ${manifest.name}】`);
  lines.push(`你是一台市场机器人${manifest.description ? `：${manifest.description}` : "（没有写职责说明）"}`);
  lines.push(`你的技能：${manifest.skills.join("、")}。`);
  lines.push(`你的工具白名单：${manifest.tools?.length ? manifest.tools.join("、") : "未声明（只用最小权限）"}。`);
  lines.push(`你的模式是 ${mode}：只读起步，写操作须用户显式放开。`);
  if (manifest.model) lines.push(`你的模型已钉为 ${manifest.model}。`);
  if (installedTargets.length) {
    lines.push(`交接：下面这些活可以交给对应的机器人（用 nyra agent run <名字> "<任务>" 派过去）：${installedTargets.map((t) => `${t.target}${t.when ? `（${t.when}）` : ""}`).join("、")}。交接本身不放行写操作，写操作仍须审批。`);
  }
  const instructions = lines.join("\n");
  if (instructions.length > 8000) {
    throw new Error(`市场机器人 ${manifest.name} 的声明说明超过 8000 字，无法登记进花名册`);
  }
  const raw: Record<string, unknown> = {
    version: 1,
    name: manifest.name,
    instructions,
    ...(manifest.description ? { description: manifest.description.slice(0, 500) } : {}),
    ...(manifest.tools?.length ? { tools: [...manifest.tools] } : {}),
    ...(manifest.model ? { model: manifest.model } : {}),
  };
  // validateAgentDecl 是 fail-closed：名字、工具、模型、注入扫描有一处
  // 不过就抛错，调用方接住后只警告、不破坏安装。
  const decl = validateAgentDecl(raw, validateOpts(home));
  return { decl, text: JSON.stringify(decl, null, 2) + "\n" };
}

/**
 * 安装时把市场机器人登记进花名册 + 建一段常驻会话。
 * 名字不符合声明规范（数字开头或超过 32 字）时不登记——声明名只能
 * 小写字母开头，机器人名可以数字开头，两者规范不一样。
 * 重装/更新时传 existingSessionId：旧会话还在就复用，不在才新建，
 * 不每次重装都多一段会话。
 * 返回声明存盘路径与常驻会话 id；任何一步失败都抛错，调用方只警告。
 */
export function enrollMarketBotInRoster(
  home: string,
  manifest: BotManifest,
  existingSessionId?: string,
): { declPath: string; sessionId: string } {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(manifest.name)) {
    throw new Error(`机器人名 ${manifest.name} 不符合声明规范（须小写字母开头、最长 32 字），不进花名册（安装本身不受影响，用 nyra agent load 手动登记时请改名）`);
  }
  const installedTargets = (manifest.hands_off_to ?? []).filter((h) => {
      try {
        return storedAgentDeclPath(home, h.target) !== null;
      } catch {
        return false;
      }
    });
  const { decl, text } = marketBotToAgentDecl(home, manifest, installedTargets);
  const declPath = saveAgentDecl(home, decl, text, `${manifest.name}.json`, true);
  let sessionId = existingSessionId;
  if (sessionId) {
    // 旧会话还在就复用；账本坏了或会话已不在才新建。
    try {
      if (!findSession(loadSessionBook(home), sessionId)) {
        sessionId = createSession(home, `Bot ${manifest.name} 的常驻会话`, "market").id;
      }
    } catch {
      sessionId = createSession(home, `Bot ${manifest.name} 的常驻会话`, "market").id;
    }
  } else {
    sessionId = createSession(home, `Bot ${manifest.name} 的常驻会话`, "market").id;
  }
  return { declPath, sessionId };
}

/** B3：.env.EXAMPLE 跟着机器人走（只写名字与说明，不写值；没声明就删掉旧的）。 */
export function writeEnvExample(destDir: string, manifest: BotManifest): void {
  const path = join(destDir, ".env.EXAMPLE");
  if (!manifest.env_requires?.length) {
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
    return;
  }
  writeFileSync(path, envExampleText(manifest), "utf-8");
}

/** 确认后才执行安装：写文件 → 账本 → 事件（事件写失败不破坏安装）。 */
export function executeMarketplaceInstall(
  home: string,
  prepared: InstallPrepared,
  opts?: { force?: boolean; store?: RunStore; runId?: string },
): InstallResult {
  const entry = prepared.entry;
  const files: string[] = [];
  let overwritten = false;
  let keptModified: string[] = [];
  let installedPath: string;
  if (entry.kind === "skill") {
    const dir = join(home, "skills");
    installedPath = join(dir, `${entry.name}.md`);
    const existed = existsSync(installedPath);
    if (existed && !opts?.force) {
      throw new MarketplaceError(`技能 ${entry.name} 已安装在 ${installedPath}（改动会丢，先删掉旧版或加 --force 覆盖）`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(installedPath, readFileSync(prepared.dir, "utf-8"), { encoding: "utf-8", mode: 0o600 });
    overwritten = existed;
    files.push(`skills/${entry.name}.md`);
  } else if (entry.kind === "template") {
    // 模板只装草稿（状态 draft）：文件进 ~/.nyra/templates/，账本记 draft，
    // 激活前须试跑 + 人工确认（模板自己的两道门，市场安装不代劳）。
    const text = readFileSync(prepared.dir, "utf-8");
    const existing = getTemplateEntry(home, entry.name);
    if (existing && !opts?.force) {
      throw new MarketplaceError(`模板 ${entry.name} 已安装（先删掉旧版或加 --force 覆盖）`);
    }
    if (existing && opts?.force) {
      removeTemplateEntry(home, entry.name);
    }
    let ledgerEntry;
    try {
      ledgerEntry = importTemplateText(home, text, basename(prepared.dir), entry.id, KNOWN_TOOLS);
    } catch (err: unknown) {
      throw new MarketplaceError(`模板导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    installedPath = join(templatesDir(home), ledgerEntry.file);
    overwritten = Boolean(existing);
    files.push(`templates/${ledgerEntry.file}`);
  } else {
    const manifest = prepared.verification.manifest;
    if (!manifest) throw new MarketplaceError("机器人清单缺失，无法安装（先重新核对条目）");
    const staged = stageBotEntry(prepared.dir, manifest);
    try {
      const report = verifyStagedPlugin(staged.dir);
      if (!report.ok) {
        throw new MarketplaceError(`插件验证未通过，拒绝安装：\n${report.errors.map((e) => `- ${e}`).join("\n")}`);
      }
      // H6：市场安装是用户显式重装（墓碑由市场账本另管，update 仍拒绝
      // 复活已卸载条目），所以这里带 force；插件自身的墓碑由这次安装清掉。
      const install = installPlugin(home, staged.dir, { force: true });
      keptModified = install.keptModified;
      files.push(...install.files);
      // bot.json 与 routines.json 不在插件锁定文件里：随插件目录一起装，
      // 模式与 routine 声明以它们为准（routine 不自动执行）。
      const dest = pluginDir(home, manifest.name);
      copyFileSync(join(prepared.dir, "bot.json"), join(dest, "bot.json"));
      if (existsSync(join(prepared.dir, "routines.json"))) {
        copyFileSync(join(prepared.dir, "routines.json"), join(dest, "routines.json"));
      }
      // B3：.env.EXAMPLE 跟着机器人走（只写名字与说明，不写值）。
      writeEnvExample(dest, manifest);
      installedPath = dest;
      overwritten = install.upgraded;
    } finally {
      staged.cleanup();
    }
  }
  const hashes: Record<string, string> = {};
  for (const rel of files) {
    const abs = entry.kind === "skill" || entry.kind === "template" ? join(home, rel) : join(installedPath, rel);
    try { hashes[rel] = sha256File(abs); } catch { /* 缺文件时不记哈希 */ }
  }
  // B1：bot.json / routines.json 安装时的哈希（更新时判断用户有没有改过它们）。
  const manifestHashes: Record<string, string> = {};
  if (entry.kind === "bot") {
    for (const f of ["bot.json", "routines.json"]) {
      const abs = join(installedPath, f);
      try { if (existsSync(abs)) manifestHashes[f] = sha256File(abs); } catch { /* 缺文件时不记哈希 */ }
    }
  }
  // B6：机器人进花名册（声明 + 常驻会话）。登记不上只警告，不破坏安装。
  // 重装时复用旧会话（账本里还记着的那段），不每次重装都多一段会话。
  const warnings: string[] = [];
  let agentDecl = false;
  let agentSessionId: string | undefined;
  const botManifest = prepared.verification.manifest;
  if (entry.kind === "bot" && botManifest) {
    const previous = findInstalled(home, entry.name);
    try {
      const enrolled = enrollMarketBotInRoster(home, botManifest, previous?.agent_session_id);
      agentDecl = true;
      agentSessionId = enrolled.sessionId;
    } catch (err: unknown) {
      warnings.push(`花名册登记没做成：${err instanceof Error ? err.message : String(err)}（机器人本身已装好，nyra agent list 里暂时看不到它）`);
    }
    // B7：声明的交接目标还没装的，提醒一句（装完目标再更新本机器人即可接线）。
    for (const h of botManifest.hands_off_to ?? []) {
      try {
        if (storedAgentDeclPath(home, h.target) === null && !findInstalled(home, h.target)) {
          warnings.push(`交接目标 ${h.target} 尚未安装（先装它，再 nyra market update ${entry.name} 即可接线）`);
        }
      } catch { /* 账本读失败不挡安装 */ }
    }
  }
  const record: InstalledEntry = {
    item_id: entry.id,
    item_name: entry.name,
    kind: entry.kind,
    version: entry.version,
    source: prepared.source.name,
    author: entry.author ?? prepared.verification.manifest?.author,
    license: entry.license ?? prepared.verification.manifest?.license,
    installed_at: new Date().toISOString(),
    installed_path: installedPath,
    files: hashes,
    reviewer_source: prepared.review.source,
    reviewer_model: prepared.review.reviewerModel,
    reviewer_decision: prepared.review.decision,
    bot_ready: prepared.botReady.score,
    bot_ready_missing: prepared.botReady.missing,
    status: "installed",
    ...(botManifest?.model ? { model: botManifest.model } : {}),
    ...(botManifest?.env_requires ? { env_requires: botManifest.env_requires } : {}),
    ...(botManifest?.hands_off_to ? { hands_off_to: botManifest.hands_off_to } : {}),
    ...(prepared.sourceUrl ? { source_url: prepared.sourceUrl } : {}),
    ...(agentDecl ? { agent_decl: true } : {}),
    ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
    ...(Object.keys(manifestHashes).length ? { manifest_hashes: manifestHashes } : {}),
  };
  const ledger = loadInstalledLedger(home);
  ledger.push(record);
  saveInstalledLedger(home, ledger);
  recordMarketEvent(opts?.store, opts?.runId, "marketplace_installed", {
      item_name: eventItemName(entry.name),
      item_version: entry.version,
      kind: entry.kind,
      source: `${prepared.source.name}:${entry.id}`,
      bot_ready: prepared.botReady.score,
      reviewer_model: prepared.review.reviewerModel ?? "",
    });
  return { installed: record, files, overwritten, keptModified, ...(warnings.length ? { warnings } : {}) };
}

// ---- B1：市场 Bot 更新流程（Hermes `profile update` 的合并语义） ----
//
// 两类所有权：作者域（技能、bot.json、routines.json、面板）替换，
// 用户域（你改过的文件、记忆、会话、.env）永不碰。
//  - 锁定文件（技能/面板）：installPlugin 的 curator lock——改过就保留。
//  - bot.json：新版为准，但 mode 取“已装 mode 与新版 mode 里更严的那个”
//    （更新永不悄悄放宽权限；readonly < auto）。
//  - routines.json：按 routine 名合并——新版里的定义刷新、你自己加的
//    routine 保留、新 routine 随文件进来（routine 本身不自动执行，
//    新任务天然是暂停态，须手动启用）。
//  - .env.EXAMPLE：按新版 env_requires 重新生成。
// 绝不做整仓自动更新、绝不静默拉取：更新只针对你点名的这一台 Bot，
// 且更新前先过同一套三道门 + 你确认。已卸载的条目更新不会复活（墓碑）。

/** 找某台 Bot 的最新一条账本记录（安装/卸载/发布都可能有多条）。 */
export function latestLedgerRecord(home: string, name: string): InstalledEntry | null {
  const ledger = loadInstalledLedger(home);
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].item_name === name) return ledger[i];
  }
  return null;
}

/** 点分版本号比较（0.2.0 < 0.10.0；比不了的返回 null，不硬猜）。 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const clean = v.trim().replace(/^v/i, "");
    if (!/^[0-9]+(\.[0-9]+)*([-.+].*)?$/.test(clean)) return null;
    const core = clean.split(/[-+]/)[0];
    return core.split(".").map((x) => Number(x));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** mode 取更严的那个：更新永不悄悄放宽权限（readonly < auto）。 */
export function mergeBotMode(installedMode: BotMode | undefined, newMode: BotMode | undefined): BotMode {
  const a = installedMode ?? "readonly";
  const b = newMode ?? "readonly";
  return a === "readonly" || b === "readonly" ? "readonly" : "auto";
}

/**
 * routines.json 按 routine 名合并：新版里的定义刷新、你自己加的
 * routine 保留、新 routine 按新版顺序排前面。
 */
export function mergeRoutines(installed: BotRoutine[], incoming: BotRoutine[]): BotRoutine[] {
  const out: BotRoutine[] = [];
  const seen = new Set<string>();
  for (const r of incoming) {
    out.push(r);
    seen.add(r.name);
  }
  for (const r of installed) {
    if (!seen.has(r.name)) {
      out.push(r);
      seen.add(r.name);
    }
  }
  return out;
}

export interface MarketUpdatePlan {
  name: string;
  needsUpdate: boolean;
  previousVersion: string;
  newVersion: string;
  record: InstalledEntry;
  /** 三道门已过的新版准备（needsUpdate 为 false 时不存在）。 */
  prepared?: InstallPrepared;
  /** 更新前给用户看的计划（版本、要换的文件、会保留的修改、mode 与 routine 规则）。 */
  planLines: string[];
  /** 更新前已算出的“你改过、会保留”的锁定文件（名字）。 */
  modifiedFiles: string[];
  /** bot.json / routines.json 你有没有改过（改过也只在 mode 与 routine 合并规则内处理）。 */
  manifestModified: string[];
  /** 版本号无法比较时的提醒（空表示可比）。 */
  versionNote: string;
}

export interface MarketUpdateResult {
  updated: boolean;
  name: string;
  previousVersion: string;
  version: string;
  files: string[];
  keptModified: string[];
  /** 更新后实际生效的 mode（可能比新版声明的更严）。 */
  mode: BotMode;
  /** routines 合并后总数。 */
  routinesMerged: number;
  warnings: string[];
}

/**
 * 更新准备（只读，不写任何文件）：找账本 → 找市场新版 → 比版本 →
 * 过三道门 → 算出会保留的修改。已是最新版时 needsUpdate=false，
 * 不跑三道门、不写东西。
 */
export async function prepareMarketplaceUpdate(
  home: string,
  name: string,
  opts: { config: Record<string, unknown>; runner?: ReviewerLike | null },
): Promise<MarketUpdatePlan> {
  const record = latestLedgerRecord(home, name);
  if (!record) throw new MarketplaceError(`没有已安装的市场条目 ${name}（先 nyra market installed 看看）`);
  if (record.status === "uninstalled") {
    throw new MarketplaceError(`${name} 已卸载，更新不会把它复活（删了就是删了，想用请重新安装）`);
  }
  if (record.kind !== "bot") {
    throw new MarketplaceError(`nyra market update 只更新机器人配置；技能包与模板请用 nyra market install <条目 id> --force 重装`);
  }
  const resolved = resolveMarketEntry(home, record.item_id);
  if (!resolved) {
    throw new MarketplaceError(`市场里找不到条目 ${record.item_id}（源 ${record.source} 可能已移除，先 nyra market source add 登记回来）`);
  }
  const cmp = compareVersions(resolved.entry.version, record.version);
  if (cmp === 0) {
    return {
      name,
      needsUpdate: false,
      previousVersion: record.version,
      newVersion: resolved.entry.version,
      record,
      planLines: [`${name} 已是最新版 v${record.version}，不用更新。`],
      modifiedFiles: [],
      manifestModified: [],
      versionNote: "",
    };
  }
  if (cmp !== null && cmp < 0) {
    throw new MarketplaceError(`市场里的版本 v${resolved.entry.version} 比已安装的 v${record.version} 旧，不降级（想回旧版请先卸载再装）`);
  }
  const versionNote = cmp === null
    ? `版本号 ${record.version} 与 ${resolved.entry.version} 无法比较，按市场索引为准更新。`
    : "";
  const prepared = await prepareMarketplaceInstallFromResolved(home, resolved, opts);
  // 更新前算出“你改过、会保留”的文件：锁定文件比哈希，bot.json /
  // routines.json 比安装时记的哈希（老账本没记哈希时当没改过）。
  const modifiedFiles: string[] = [];
  const manifestModified: string[] = [];
  const dest = pluginDir(home, name);
  try {
    const lock = loadLock(home).plugins[name];
    if (lock) {
      for (const [rel, hash] of Object.entries(lock.files)) {
        const target = join(dest, rel);
        try {
          if (existsSync(target) && sha256File(target) !== hash) modifiedFiles.push(rel);
        } catch { /* 读失败当没改过，安装时再定 */ }
      }
    }
  } catch { /* 锁读失败不挡更新 */ }
  for (const f of ["bot.json", "routines.json"]) {
    const oldHash = record.manifest_hashes?.[f];
    if (!oldHash) continue;
    try {
      const target = join(dest, f);
      if (existsSync(target) && sha256File(target) !== oldHash) manifestModified.push(f);
    } catch { /* ignore */ }
  }
  const planLines: string[] = [];
  planLines.push(`${name}：v${record.version} → v${resolved.entry.version}`);
  if (versionNote) planLines.push(versionNote);
  planLines.push(`来源：${prepared.source.name}:${resolved.entry.id}（Bot Ready ${prepared.botReady.score}/100）`);
  planLines.push("作者域替换：技能、bot.json、routines.json、面板按新版来；你改过的文件保留。");
  if (modifiedFiles.length) planLines.push(`你改过、会保留的文件：${modifiedFiles.join("、")}`);
  if (manifestModified.length) planLines.push(`你改过的清单文件：${manifestModified.join("、")}（bot.json 的 mode 按更严的留，routines 按名合并）`);
  planLines.push("mode 规则：更新后取已装 mode 与新版 mode 里更严的那个，永不悄悄放宽。");
  planLines.push("routine 规则：新版定义刷新、你自己加的 routine 保留、新 routine 不自动执行。");
  const newManifest = prepared.verification.manifest;
  if (newManifest?.env_requires?.length) planLines.push(`环境变量：新版要 ${newManifest.env_requires.map((e) => e.name).join("、")}（.env.EXAMPLE 会重新生成）`);
  planLines.push(`审查：${prepared.review.source === "skipped" ? "已跳过（审查层未开启；只走了两道确定性门）" : `${prepared.review.decision === "ALLOW" ? "通过" : "拦截"}（${prepared.review.reviewerModel ?? ""}）`}`);
  return {
    name,
    needsUpdate: true,
    previousVersion: record.version,
    newVersion: resolved.entry.version,
    record,
    prepared,
    planLines,
    modifiedFiles,
    manifestModified,
    versionNote,
  };
}

/** 确认后执行更新：合并安装 → 账本原地改版本 → 事件 → 花名册声明重同步。 */
export function executeMarketplaceUpdate(
  home: string,
  plan: MarketUpdatePlan,
  opts?: { store?: RunStore; runId?: string },
): MarketUpdateResult {
  if (!plan.needsUpdate || !plan.prepared) {
    return {
      updated: false,
      name: plan.name,
      previousVersion: plan.previousVersion,
      version: plan.newVersion,
      files: [],
      keptModified: [],
      mode: "readonly",
      routinesMerged: 0,
      warnings: [],
    };
  }
  const prepared = plan.prepared;
  const newManifest = prepared.verification.manifest;
  if (!newManifest) throw new MarketplaceError("机器人清单缺失，无法更新（先重新核对条目）");
  const dest = pluginDir(home, plan.name);
  const warnings: string[] = [];
  const staged = stageBotEntry(prepared.dir, newManifest);
  let keptModified: string[] = [];
  let files: string[] = [];
  try {
    const report = verifyStagedPlugin(staged.dir);
    if (!report.ok) {
      throw new MarketplaceError(`插件验证未通过，拒绝更新：\n${report.errors.map((e) => `- ${e}`).join("\n")}`);
    }
    const install = installPlugin(home, staged.dir);
    keptModified = install.keptModified;
    files = [...install.files];
  } finally {
    staged.cleanup();
  }
  // bot.json：新版为准，mode 取已装与新版里更严的那个。
  let mode: BotMode = newManifest.mode ?? "readonly";
  try {
    const installedBot = existsSync(join(dest, "bot.json"))
      ? (JSON.parse(readFileSync(join(dest, "bot.json"), "utf-8")) as { mode?: BotMode })
      : null;
    mode = mergeBotMode(installedBot?.mode, newManifest.mode);
  } catch { /* 旧 bot.json 读坏时按新版来 */ }
  const mergedBotJson = { ...JSON.parse(readFileSync(join(prepared.dir, "bot.json"), "utf-8")), mode };
  writeFileSync(join(dest, "bot.json"), JSON.stringify(mergedBotJson, null, 2) + "\n", "utf-8");
  // routines.json：按名合并（新版定义刷新、你加的保留、新 routine 进来不自动执行）。
  let routinesMerged = 0;
  const newRoutinesPath = join(prepared.dir, "routines.json");
  if (existsSync(newRoutinesPath)) {
    const incoming = parseRoutines(prepared.dir);
    let installed: BotRoutine[] = [];
    try {
      installed = existsSync(join(dest, "routines.json")) ? parseRoutines(dest) : [];
    } catch {
      installed = [];
      warnings.push("已装的 routines.json 读坏了，按新版重建（你加的 routine 可能丢了，先检查备份）");
    }
    const merged = mergeRoutines(installed, incoming);
    writeFileSync(join(dest, "routines.json"), JSON.stringify(merged, null, 2) + "\n", "utf-8");
    routinesMerged = merged.length;
  } else if (existsSync(join(dest, "routines.json"))) {
    try {
      routinesMerged = parseRoutines(dest).length;
    } catch {
      routinesMerged = 0;
    }
  }
  // .env.EXAMPLE 按新版重新生成（没声明就删掉旧的）。
  writeEnvExample(dest, newManifest);
  // 账本原地改版本（不另起一条记录，卸载历史不断）。
  const hashes: Record<string, string> = {};
  for (const rel of files) {
    try { hashes[rel] = sha256File(join(dest, rel)); } catch { /* 缺文件时不记哈希 */ }
  }
  const manifestHashes: Record<string, string> = {};
  for (const f of ["bot.json", "routines.json"]) {
    try { if (existsSync(join(dest, f))) manifestHashes[f] = sha256File(join(dest, f)); } catch { /* ignore */ }
  }
  const ledger = loadInstalledLedger(home);
  let idx = -1;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].item_name === plan.name && ledger[i].status === "installed") { idx = i; break; }
  }
  if (idx === -1) throw new MarketplaceError(`更新中途账本变了：找不到 ${plan.name} 的已安装记录（没改任何文件）`);
  const old = ledger[idx];
  ledger[idx] = {
    ...old,
    version: plan.newVersion,
    author: prepared.entry.author ?? newManifest.author ?? old.author,
    license: prepared.entry.license ?? newManifest.license ?? old.license,
    files: hashes,
    reviewer_source: prepared.review.source,
    reviewer_model: prepared.review.reviewerModel,
    reviewer_decision: prepared.review.decision,
    bot_ready: prepared.botReady.score,
    bot_ready_missing: prepared.botReady.missing,
    updated_at: new Date().toISOString(),
    previous_version: plan.previousVersion,
    ...(newManifest.model ? { model: newManifest.model } : { model: undefined }),
    ...(newManifest.env_requires ? { env_requires: newManifest.env_requires } : { env_requires: undefined }),
    ...(newManifest.hands_off_to ? { hands_off_to: newManifest.hands_off_to } : { hands_off_to: undefined }),
    ...(Object.keys(manifestHashes).length ? { manifest_hashes: manifestHashes } : {}),
  };
  // `{ model: undefined }` 这种条件展开会留下 undefined 键：JSON 写盘时
  // 自动丢掉，但内存里的记录先清干净（旧版钉的模型更新后不留会误导）。
  if (!newManifest.model) delete (ledger[idx] as Partial<InstalledEntry>).model;
  if (!newManifest.env_requires) delete (ledger[idx] as Partial<InstalledEntry>).env_requires;
  if (!newManifest.hands_off_to) delete (ledger[idx] as Partial<InstalledEntry>).hands_off_to;
  saveInstalledLedger(home, ledger);
  // 花名册声明重同步：只动市场生成的声明（你改过的声明不动，只警告）。
  if (old.agent_decl) {
    try {
      const existing = loadStoredAgentDecl(home, plan.name, validateOpts(home));
      if (existing.instructions.startsWith(MARKET_DECL_INSTRUCTIONS_PREFIX)) {
        const { decl, text } = marketBotToAgentDecl(
          home,
          newManifest,
          (newManifest.hands_off_to ?? []).filter((h) => {
            try { return storedAgentDeclPath(home, h.target) !== null; } catch { return false; }
          }),
        );
        saveAgentDecl(home, decl, text, `${plan.name}.json`, true);
      } else {
        warnings.push(`声明 ${plan.name} 你改过，本次更新没动它（新版模型/交接没同步进去）`);
      }
    } catch (err: unknown) {
      warnings.push(`花名册声明重同步没做成：${err instanceof Error ? err.message : String(err)}（旧声明还在，功能不受影响）`);
    }
  }
  recordMarketEvent(opts?.store, opts?.runId, "marketplace_updated", {
      item_name: eventItemName(plan.name),
      item_version: plan.newVersion,
      kind: "bot",
      source: `${prepared.source.name}:${prepared.entry.id}`,
      previous_version: plan.previousVersion,
    });
  return {
    updated: true,
    name: plan.name,
    previousVersion: plan.previousVersion,
    version: plan.newVersion,
    files,
    keptModified,
    mode,
    routinesMerged,
    warnings,
  };
}

// ---- 卸载：只删哈希一致的文件，用户改过的文件留着并报告；账本留 uninstalled 记录 ----

export function uninstallMarketplaceEntry(
  home: string,
  name: string,
  opts?: { store?: RunStore; runId?: string },
): { removed: string[]; kept: string[]; kind: MarketKind; warnings?: string[] } {
  const record = findInstalled(home, name);
  if (!record) throw new MarketplaceError(`没有已安装的市场条目 ${name}（先 nyra market installed 看看）`);
  let removed: string[] = [];
  let kept: string[] = [];
  const warnings: string[] = [];
  if (record.kind === "template") {
    try {
      const entry = getTemplateEntry(home, name);
      removeTemplateEntry(home, name);
      if (entry) removed.push(`templates/${entry.file}`);
    } catch {
      kept.push(`templates/${name}（模板已不在）`);
    }
  } else if (record.kind === "skill") {
    const path = join(home, "skills", `${name}.md`);
    const expected = record.files[`skills/${name}.md`];
    if (!existsSync(path)) {
      kept.push(`skills/${name}.md（文件已不在）`);
    } else if (expected && sha256File(path) !== expected) {
      kept.push(`skills/${name}.md（你改过，保留未删）`);
    } else {
      rmSync(path, { force: true });
      removed.push(`skills/${name}.md`);
    }
  } else {
    const result = uninstallPlugin(home, name);
    removed = result.removed;
    kept = [...result.keptModified, ...result.missing.map((m) => `${m}（文件已不在）`)];
    for (const extra of ["bot.json", "routines.json", ".env.EXAMPLE"]) {
      const p = join(pluginDir(home, name), extra);
      if (existsSync(p)) {
        try { rmSync(p, { force: true }); removed.push(extra); } catch { kept.push(extra); }
      }
    }
    // B6：花名册登记是市场生成的才删（你改过的声明不动，只提醒）。
    // 常驻会话一起结束；声明/会话清不掉不破坏卸载，只警告。
    if (record.agent_decl) {
      try {
        const existing = loadStoredAgentDecl(home, name, validateOpts(home));
        if (existing.instructions.startsWith(MARKET_DECL_INSTRUCTIONS_PREFIX)) {
          removeStoredAgentDecl(home, name);
          removed.push(`花名册声明 ${name}`);
        } else {
          warnings.push(`声明 ${name} 你改过，本次卸载没动它（nyra agent remove ${name} 可手动删）`);
        }
      } catch {
        kept.push(`花名册声明 ${name}（读不到，保留未删）`);
      }
    }
    if (record.agent_session_id) {
      try {
        endSession(home, record.agent_session_id);
        removed.push(`常驻会话 ${record.agent_session_id}`);
      } catch {
        kept.push(`常驻会话 ${record.agent_session_id}（结束失败，保留未删）`);
      }
    }
  }
  const ledger = loadInstalledLedger(home);
  // 按名字 + 状态找（record 来自另一次解析，indexOf 比对象恒为 -1）。
  let idx = -1;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].item_name === name && ledger[i].status === "installed") { idx = i; break; }
  }
  if (idx !== -1) {
    ledger[idx] = { ...ledger[idx], status: "uninstalled", uninstalled_at: new Date().toISOString(), uninstalled_files: removed };
    saveInstalledLedger(home, ledger);
  }
  recordMarketEvent(opts?.store, opts?.runId, "marketplace_uninstalled", {
      item_name: eventItemName(name),
      kind: record.kind,
    });
  return { removed, kept, kind: record.kind, ...(warnings.length ? { warnings } : {}) };
}

// ---- 发布：本地三道门 → 打包脱敏检查 → 生成可提交的条目包 ----

const PUBLISH_SECRET_PATTERNS: { id: string; label: string }[] = [
  { id: "password-assign", label: "明文密码赋值" },
  { id: "api-key", label: "API 密钥字样" },
  { id: "bearer-token", label: "Bearer token" },
  { id: "private-key", label: "私钥" },
  { id: "aws-key", label: "AWS Access Key" },
  { id: "session-cookie", label: "会话 Cookie" },
];

/** 绝对路径另查：字符类里不放引号（正则字面量里的引号会干扰缩进脚本，见 AGENTS.md）。 */
const ABSOLUTE_PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\)[^\s]+/;

/**
* 发布脱敏检查：密钥类命中直接拒绝发布；邮箱/电话/身份证是 PII 警告
* （作者联系方式由作者自己决定，不拦，但写进输出提醒）。
* 只报模式与行号，绝不返回匹配原文。
*/
export function checkPublishHygiene(text: string): { blockers: { pattern: string; label: string; lines: number[] }[]; warnings: { pattern: string; label: string; lines: number[] }[] } {
  // JSON 文件里的值是转义过的（\"sk-...\"）：转义会挡住密钥正则，先把
  // \" 与 \\ 还原再扫一份（行数不变，行号仍准），两份命中按模式去重。
  const variants = [text, text.replace(/\\"/g, "\"").replace(/\\\\/g, "\\")];
  const seen = new Set<string>();
  const blockers: { pattern: string; label: string; lines: number[] }[] = [];
  const warnings: { pattern: string; label: string; lines: number[] }[] = [];
  for (const variant of variants) {
    const hygiene = checkEvidenceHygiene(variant);
    for (const h of hygiene.hits) {
      const key = `${h.pattern}:${h.lines.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = { pattern: h.pattern, label: h.label, lines: h.lines };
      if (PUBLISH_SECRET_PATTERNS.some((p) => p.id === h.pattern)) blockers.push(item);
      else warnings.push(item);
    }
  }
  const lines = text.split("\n");
  const found: number[] = [];
  lines.forEach((line, i) => {
      ABSOLUTE_PATH_RE.lastIndex = 0;
      if (ABSOLUTE_PATH_RE.test(line)) found.push(i + 1);
    });
  if (found.length) blockers.push({ pattern: "absolute-path", label: "绝对路径", lines: found });
  return { blockers, warnings };
}

export interface PublishResult {
  itemName: string;
  kind: MarketKind;
  version: string;
  outDir: string;
  files: string[];
  botReady: BotReady;
  review: ReviewVerdict;
  warnings: string[];
  dryRun: boolean;
}

function collectPublishFiles(dir: string, kind: MarketKind): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  if (kind === "bot") {
    // 只打包条目文件（bot.json、skills、routines.json、panel），不带杂文件。
    const push = (rel: string) => {
      const abs = join(dir, rel);
      if (existsSync(abs)) out.push({ rel, abs });
    };
    push("bot.json");
    push("routines.json");
    const skillsDir = join(dir, "skills");
    if (existsSync(skillsDir)) {
      for (const f of readdirSync(skillsDir).sort()) {
        if (f.endsWith(".md")) out.push({ rel: `skills/${f}`, abs: join(skillsDir, f) });
      }
    }
    const panelDir = join(dir, "panel");
    if (existsSync(panelDir)) {
      for (const f of readdirSync(panelDir).sort()) {
        if (f.endsWith(".html")) out.push({ rel: `panel/${f}`, abs: join(panelDir, f) });
      }
    }
    return out;
  }
  out.push({ rel: basename(dir), abs: dir });
  return out;
}

/** 把一个已装技能打包成市场条目用的临时目录（技能文件 + 生成的 bot.json 外壳不适用，技能条目只要 .md）。 */
export function packSkillAsEntry(home: string, skillName: string): string {
  const path = join(home, "skills", `${skillName}.md`);
  if (!existsSync(path)) throw new MarketplaceError(`没有已安装的技能 ${skillName}（先 nyra skills list 看看）`);
  const parsed = parseSkillText(readFileSync(path, "utf-8"), path);
  if (parsed.name !== skillName) throw new MarketplaceError(`技能文件里的 name 是 ${parsed.name}，与 ${skillName} 不一致`);
  return path;
}

export async function publishMarketplaceEntry(
  home: string,
  input: { dir: string } | { skill: string } | { template: string },
  opts: { config: Record<string, unknown>; runner?: ReviewerLike | null; dryRun?: boolean; outDir?: string; license?: string; store?: RunStore; runId?: string },
): Promise<PublishResult> {
  let kind: MarketKind;
  let pkgDir: string;
  let skillFile: string | null = null;
  let templateFile: string | null = null;
  let templateDef: TemplateDefinition | null = null;
  let manifest: BotManifest | null = null;
  if ("template" in input) {
    kind = "template";
    const given = input.template;
    if (existsSync(given) && statSync(given).isFile()) {
      templateFile = resolve(given);
    } else {
      const entry = getTemplateEntry(home, given);
      if (!entry) throw new MarketplaceError(`没有这个模板：${given}（传模板文件路径，或先装好的模板名）`);
      templateFile = join(templatesDir(home), entry.file);
    }
    pkgDir = dirname(templateFile);
    templateDef = validateTemplateDefinition(
      parseTemplateText(readFileSync(templateFile, "utf-8"), basename(templateFile)), KNOWN_TOOLS, null,
    );
  } else if ("skill" in input) {
    kind = "skill";
    skillFile = packSkillAsEntry(home, input.skill);
    pkgDir = dirname(skillFile);
  } else {
    const dir = resolve(input.dir);
    if (!existsSync(dir)) throw new MarketplaceError(`发布目录不存在：${dir}`);
    if (statSync(dir).isFile() && dir.endsWith(".md")) {
      kind = "skill";
      skillFile = dir;
      pkgDir = dirname(dir);
    } else if (existsSync(join(dir, "bot.json"))) {
      kind = "bot";
      pkgDir = dir;
      manifest = parseBotManifest(dir);
    } else {
      throw new MarketplaceError(`发布目录既不是机器人目录（须含 bot.json）也不是单个技能文件（.md）：${dir}`);
    }
  }
  const files = collectPublishFiles(kind === "bot" ? pkgDir : (skillFile ?? templateFile)!, kind);
  // 打包脱敏检查：含密钥/绝对路径直接拒绝发布。
  const warnings: string[] = [];
  for (const f of files) {
    const text = readFileSync(f.abs, "utf-8");
    const { blockers, warnings: w } = checkPublishHygiene(text);
    if (blockers.length) {
      throw new MarketplaceError(`脱敏检查不过，拒绝发布：${f.rel} 含 ${blockers.map((b) => `${b.label}（第 ${b.lines.join("、")} 行）`).join("、")}，先删掉再发布`, "hygiene");
    }
    for (const x of w) warnings.push(`${f.rel}：${x.label}（第 ${x.lines.join("、")} 行，仅提醒，不拦发布）`);
  }
  // 许可证必填（机器人看 bot.json，技能看 --license，模板看模板文件里的 license）。
  const license = manifest?.license ?? templateDef?.license ?? opts.license;
  if (!license) throw new MarketplaceError("许可证必填（bot.json 写 license，或发布时加 --license <许可证>），无许可证不让发", "license");
  // 本地三道门（与安装同一套门，工具名换成 marketplace_publish）。
  let verification: EntryVerification;
  let scanHits: ScanHit[];
  let botReady: BotReady;
  if (kind === "skill") {
    const name = basename(skillFile!, ".md");
    const fakeEntry: MarketEntryMeta = { id: name, kind: "skill", name, version: "0.1.0", path: basename(skillFile!), license };
    verification = verifyMarketplaceEntry({ entry: fakeEntry, source: { name: "self", kind: "local", path: pkgDir, added_at: "" }, dir: skillFile! });
    scanHits = scanMarketplaceText(readFileSync(skillFile!, "utf-8"), basename(skillFile!));
    botReady = computeBotReady({
        license, source: null, skillsOk: verification.ok,
        toolsDeclared: false, toolsKnown: true, scanHits: scanHits.length,
        updatedAt: null, newestMtimeMs: statSync(skillFile!).mtimeMs,
      });
  } else if (kind === "template") {
    const fakeEntry: MarketEntryMeta = {
      id: templateDef!.name, kind: "template", name: templateDef!.name, version: templateDef!.version,
      description: templateDef!.description, author: templateDef!.author, license,
      source: "", path: basename(templateFile!),
    };
    verification = verifyMarketplaceEntry({ entry: fakeEntry, source: { name: "self", kind: "local", path: pkgDir, added_at: "" }, dir: templateFile! });
    scanHits = scanMarketplaceEntry({ entry: fakeEntry, source: { name: "self", kind: "local", path: pkgDir, added_at: "" }, dir: templateFile! });
    botReady = computeBotReadyForDir(fakeEntry, templateFile!);
  } else {
    const fakeEntry: MarketEntryMeta = {
      id: manifest!.name, kind: "bot", name: manifest!.name, version: manifest!.version,
      description: manifest!.description, author: manifest!.author, license,
      source: manifest!.homepage, path: ".", tools: manifest!.tools, permissions: manifest!.permissions,
      mode: manifest!.mode,
    };
    verification = verifyMarketplaceEntry({ entry: fakeEntry, source: { name: "self", kind: "local", path: pkgDir, added_at: "" }, dir: pkgDir });
    scanHits = scanMarketplaceEntry({ entry: fakeEntry, source: { name: "self", kind: "local", path: pkgDir, added_at: "" }, dir: pkgDir });
    botReady = computeBotReadyForDir(fakeEntry, pkgDir);
  }
  if (!verification.ok) {
    throw new MarketplaceError(`清单校验不过，拒绝发布：\n${verification.errors.map((e) => `- ${e}`).join("\n")}`, "manifest");
  }
  if (scanHits.length) {
    throw new MarketplaceError(`确定性规则拦截，拒绝发布：\n${scanHits.map((h) => `- ${h.where}：${h.reason}`).join("\n")}`, "deterministic");
  }
  const itemName = kind === "skill" ? basename(skillFile!, ".md") : kind === "template" ? templateDef!.name : manifest!.name;
  const version = kind === "skill" ? "0.1.0" : kind === "template" ? templateDef!.version : manifest!.version;
  const review = await reviewMarketplaceAction({
      config: opts.config,
      home,
      action: "marketplace_publish",
      itemName,
      kind,
      author: templateDef?.author ?? manifest?.author,
      license,
      tools: verification.tools,
      permissions: verification.permissions,
      mode: templateDef ? "template" : (manifest?.mode ?? "readonly"),
      runner: opts.runner,
    });
  if (review.decision === "BLOCK") {
    throw new MarketplaceError(`独立审查拦截，拒绝发布（${review.reviewerModel ?? ""}）：${review.reason}`, "reviewer");
  }
  const outDir = opts.outDir ? resolve(opts.outDir) : join(marketplacePublishDir(home), itemName);
  const outFiles: string[] = [];
  if (!opts.dryRun) {
    mkdirSync(outDir, { recursive: true });
    for (const f of files) {
      const target = join(outDir, f.rel === basename(skillFile ?? "") && kind === "skill" ? basename(f.abs) : f.rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(f.abs, target);
      outFiles.push(relative(outDir, target));
    }
    const fragment = {
      id: itemName,
      kind,
      name: itemName,
      version,
      description: templateDef?.description ?? manifest?.description,
      author: templateDef?.author ?? manifest?.author,
      license,
      source: manifest?.homepage ?? "",
      path: kind === "bot" ? "." : kind === "template" ? basename(templateFile!) : `${itemName}.md`,
      tools: verification.tools,
      permissions: verification.permissions,
      mode: manifest?.mode ?? "readonly",
      updated_at: new Date().toISOString(),
      bot_ready: botReady.score,
    };
    writeFileSync(join(outDir, "market-entry.json"), JSON.stringify(fragment, null, 2) + "\n", "utf-8");
    outFiles.push("market-entry.json");
    const ledger = loadInstalledLedger(home);
    ledger.push({
        item_id: itemName,
        item_name: itemName,
        kind,
        version,
        source: "self",
        author: manifest?.author,
        license,
        installed_at: new Date().toISOString(),
        installed_path: outDir,
        files: {},
        reviewer_source: review.source,
        reviewer_model: review.reviewerModel,
        reviewer_decision: review.decision,
        bot_ready: botReady.score,
        bot_ready_missing: botReady.missing,
        status: "published",
        published_at: new Date().toISOString(),
        published_out_dir: outDir,
      });
    saveInstalledLedger(home, ledger);
    recordMarketEvent(opts.store, opts.runId, "marketplace_published", {
        item_name: eventItemName(itemName),
        item_version: version,
        kind,
        license,
        bot_ready: botReady.score,
      });
  }
  return { itemName, kind, version, outDir, files: opts.dryRun ? files.map((f) => f.rel) : outFiles, botReady, review, warnings, dryRun: Boolean(opts.dryRun) };
}

// ---- 模板与网关公开视图 ----

export function marketBotTemplate(): string {
  return JSON.stringify({
      name: "my-bot",
      version: "0.1.0",
      description: "一句话说明这个机器人是干什么的",
      author: "你的名字",
      license: "MIT",
      homepage: "https://github.com/<你>/<仓库>",
      skills: ["my-skill"],
      tools: ["read_file"],
      permissions: ["fs:read-workspace"],
      mode: "readonly",
      // B2：模型钉选（可选）：机器人永远用这个模型跑，key 仍在密码箱，
      // Bot 只拿模型名；写错名字安装时直接拒绝，不静默回落默认模型。
      model: "deepseek-flash",
      // B3：需要的环境变量（可选）：只声明名字与说明、不带值；安装时
      // 逐项核对（只报已设置/未设置，不打印值），并生成 .env.EXAMPLE。
      env_requires: [
        { name: "MY_API_KEY", description: "这个机器人要调的第三方服务密钥", required: true },
      ],
      // B7：交接目标（可选）：这个机器人能把活交给哪些已装的机器人；
      // 目标未装时只警告不拦安装，装完目标再更新本机器人即可接线。
      hands_off_to: [
        { target: "other-bot", when: "需要写文件时交给它" },
      ],
    }, null, 2) + "\n";
}

export function marketIndexTemplate(): string {
  return JSON.stringify({
      version: 1,
      name: "my-market",
      description: "市场索引：entries 里每条是一个技能包或机器人配置",
      updated_at: new Date().toISOString(),
      entries: [
        {
          id: "my-bot",
          kind: "bot",
          name: "my-bot",
          version: "0.1.0",
          description: "一句话说明",
          author: "你的名字",
          license: "MIT",
          source: "https://github.com/<你>/<仓库>",
          path: "bots/my-bot",
          tools: ["read_file"],
          permissions: ["fs:read-workspace"],
          mode: "readonly",
        },
        {
          id: "my-skill",
          kind: "skill",
          name: "my-skill",
          version: "0.1.0",
          description: "一句话说明",
          author: "你的名字",
          license: "MIT",
          source: "https://github.com/<你>/<仓库>",
          path: "skills/my-skill.md",
        },
      ],
    }, null, 2) + "\n";
}

/** 网关 GET /api/marketplace：只给公开元数据，不含绝对路径与正文。 */
export function listMarketplacePublic(home: string): {
  sources: { name: string; kind: string; entries: number }[];
  entries: { id: string; kind: string; name: string; version: string; description?: string; author?: string; license?: string; source?: string; bot_ready: number; bot_ready_missing: string[]; tools: string[]; permissions: string[]; mode?: string }[];
  installed: { item_name: string; kind: string; version: string; source: string; installed_at: string; status: string; bot_ready: number }[];
} {
  const sources = loadMarketSources(home);
  const srcView = sources.map((s) => {
      let count = 0;
      try { count = loadMarketIndex(s.path).entries.length; } catch { count = 0; }
      return { name: s.name, kind: s.kind, entries: count };
    });
  const entries = listMarketEntries(home).map((l) => ({
        id: l.entry.id,
        kind: l.entry.kind,
        name: l.entry.name,
        version: l.entry.version,
        description: l.entry.description,
        author: l.entry.author,
        license: l.entry.license,
        source: l.entry.source,
        bot_ready: l.botReady.score,
        bot_ready_missing: l.botReady.missing,
        tools: l.entry.tools ?? [],
        permissions: l.entry.permissions ?? [],
        mode: l.entry.mode,
      }));
  const installed = listInstalled(home).map((e) => ({
        item_name: e.item_name,
        kind: e.kind,
        version: e.version,
        source: e.source,
        installed_at: e.installed_at,
        status: e.status,
        bot_ready: e.bot_ready,
      }));
  return { sources: srcView, entries, installed };
}
