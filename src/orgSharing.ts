// src/orgSharing.ts — 缺口 49 第二批：共享 Bot + 租户隔离 + 组织内私有目录。
//
// 报告 ~/workspace/research_notes/nyra-bot-direction-20261120.md §6 缺口 49
// “怎么做得更好”的后半部分：
//   ① 共享 Bot 默认只读——共享出去的 Bot 能看任务产物、不能写记忆/文件/
//      密钥，写操作须 Bot 主人显式接受；
//   ② Review learnings——队友教给 Team Bot 的东西先挂待审区，须 owner /
//      Manager 批才生效（批准后落成一条组织记忆条目，走记忆证据门的 CLI
//      路径：引用即学习内容本身，批准人就是依据的提供者）；
//   ③ 租户隔离是硬边界，不是提示词——组织归属的数据按 org_id 行级隔离，
//      跨租户读文件须对方显式接受，越权访问记进证据链并告警（收件箱）。
//
// 与第一批的关系：组织/成员/角色（src/orgs.ts）是底座，本批只在其上加
// 共享与隔离的执行层——权限判定复用 canOrg / requireOrgAccess，成员校验
// 复用缺口 41 的 AccountStore，隔离违反走同一本组织审计与运行事件。
// 本模块不 import tools.ts / agent.ts（避免循环：tools → memoryGate，
// orgSharing 只在需要时动态 import creator.ts 的 KNOWN_TOOLS）；
// 任务归属的 sidecar 在 src/taskOrg.ts（与 taskOrigin.ts 同款做法）。
//
// 覆盖面（诚实口径，详见 docs/orgs.md）：
//   任务——addTask 传 orgId 即记归属（sidecar），读/列走门；
//   记忆——结构化条目 scope=org + orgId（memoryGate.ts），读/列走门；
//   文件——组织绑定的工作区内文件走门（nyra org file-read），工作区外的
//     文件不属于任何组织、不走这道门；
//   设置与用量——隔离开关只读展示（数据隔离恒开，不可关闭；组织级设置与
//     用量分账尚未实现，不造假开关）。
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import {
  ORG_OWNER_IDENTITY,
  appendOrgAudit,
  canOrg,
  getOrg,
  isOrgManager,
  isSuperAdmin,
  loadOrgBook,
  recordOrgEvent,
  resolveAccountRef,
  saveOrgBook,
  type Org,
  type OrgIsolation,
} from "./orgs.ts";
import { AccountStore, type Account, type AccountsStores } from "./accounts.ts";
import { RunStore, type RunState } from "./runs.ts";
import { appendInbox } from "./tasks.ts";
import {
  listMemoryGateEntries,
  rememberMemoryEntry,
  type MemoryGateEntry,
} from "./memoryGate.ts";
import { listTaskIdsByOrg, markTaskOrg, readTaskOrg } from "./taskOrg.ts";
import { importTemplateText, parseTemplateText, templateSlug, validateTemplateDefinition, type TemplateLedgerEntry } from "./templates.ts";

export const ORG_SHARING_FILE = "org-sharing.json";
export const ORG_CATALOG_FILE = "org-catalog.json";
export const ORG_CATALOG_DIR = "org-catalog";
export const ORG_VIOLATIONS_FILE = "org-violations.jsonl";
/** 组织内文件单次读取上限（1MB；共享读文件是看产物，不是搬仓库）。 */
export const ORG_FILE_READ_MAX_BYTES = 1024 * 1024;

export class OrgSharingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgSharingError";
  }
}

/** 共享 Bot 上被显式接受的写动作（默认只读：没有 grant 时这三项全拒绝）。 */
export type SharedBotWriteAction = "write_memory" | "write_file" | "send_message";
export const SHARED_BOT_WRITE_ACTIONS: readonly SharedBotWriteAction[] = [
  "write_memory", "write_file", "send_message",
];

export interface SharedBot {
  /** `sbot_` + 12 位十六进制（共享记录 id；bot_id 是 Bot 本身的 id，两者区分开）。 */
  id: string;
  org_id: string;
  bot_id: string;
  bot_name: string;
  description: string;
  /** Bot 主人（账号 id）：只有他能接受写授权、批教学（机主可代行，组织 admin 不行）。 */
  owner: string;
  /** "org" = 全组织成员都能看；否则是账号 id 列表（指定的人）。 */
  shared_with: "org" | string[];
  status: "active" | "revoked";
  published_at: string;
  published_by: string;
}

export interface SharedBotWriteGrant {
  /** `sbwg_` + 12 位十六进制。 */
  id: string;
  /** SharedBot.id（共享记录 id，不是 bot_id）。 */
  bot_id: string;
  org_id: string;
  account_id: string;
  actions: SharedBotWriteAction[];
  granted_by: string;
  granted_at: string;
  /** 过期时间（ISO；null = 不过期）。过期即失效，不用等回收。 */
  expires_at: string | null;
  status: "active" | "revoked";
}

export type LearningStatus = "pending" | "approved" | "rejected";

export interface OrgLearning {
  /** `olrn_` + 12 位十六进制。 */
  id: string;
  org_id: string;
  /** SharedBot.id。 */
  bot_id: string;
  proposed_by: string;
  content: string;
  status: LearningStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** 批准后落成的组织记忆条目 id（memg_…；拒绝/待审时为 null）。 */
  memory_entry_id: string | null;
}

export interface CrossAccessGrant {
  /** `ocax_` + 12 位十六进制。 */
  id: string;
  org_id: string;
  /** 组织工作区下的相对前缀，"" = 整个工作区。 */
  path_prefix: string;
  granted_to_kind: "account" | "org";
  /** 账号 id 或组织 id（与 granted_to_kind 对应）。 */
  granted_to: string;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  status: "active" | "revoked";
}

export interface OrgSharingBook {
  version: 1;
  shared_bots: SharedBot[];
  write_grants: SharedBotWriteGrant[];
  learnings: OrgLearning[];
  cross_access: CrossAccessGrant[];
}

export interface OrgCatalogEntry {
  /** 模板名即 id（与模板账本一致）。 */
  id: string;
  org_id: string;
  name: string;
  version: string;
  source: string;
  published_by: string;
  published_at: string;
  text_sha256: string;
  file: string;
}

export interface OrgCatalogBook {
  version: 1;
  entries: OrgCatalogEntry[];
}

export type IsolationViolationWhat = "task" | "memory" | "file" | "catalog" | "bot";

export interface OrgViolation {
  at: string;
  org_id: string | null;
  account_id: string;
  what: IsolationViolationWhat;
  detail: string;
  outcome: "denied";
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ensureHomeDir(home: string): string {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  return dir;
}

function writeJsonAtomic(home: string, filename: string, data: string): void {
  const dir = ensureHomeDir(home);
  const path = join(dir, filename);
  const tmp = join(dir, `.${filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function writeText0600(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, text, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---- 共享账本读写（原子写 0600；损坏先备份再抛错，不静默重建） ----

export function sharingBookPath(home: string): string {
  return join(resolveNyraHome(home), ORG_SHARING_FILE);
}

export function loadSharingBook(home: string): OrgSharingBook {
  const path = sharingBookPath(home);
  if (!existsSync(path)) return { version: 1, shared_bots: [], write_grants: [], learnings: [], cross_access: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new OrgSharingError(`${ORG_SHARING_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.shared_bots) || !Array.isArray(parsed.write_grants) ||
    !Array.isArray(parsed.learnings) || !Array.isArray(parsed.cross_access)) {
    throw new OrgSharingError(`${ORG_SHARING_FILE} 结构不对（须含 shared_bots / write_grants / learnings / cross_access）`);
  }
  return { version: 1, shared_bots: parsed.shared_bots, write_grants: parsed.write_grants, learnings: parsed.learnings, cross_access: parsed.cross_access };
}

export function saveSharingBook(home: string, book: OrgSharingBook): void {
  writeJsonAtomic(home, ORG_SHARING_FILE, JSON.stringify(book, null, 2) + "\n");
}

function catalogBookPath(home: string): string {
  return join(resolveNyraHome(home), ORG_CATALOG_FILE);
}

export function loadCatalogBook(home: string): OrgCatalogBook {
  const path = catalogBookPath(home);
  if (!existsSync(path)) return { version: 1, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new OrgSharingError(`${ORG_CATALOG_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) {
    throw new OrgSharingError(`${ORG_CATALOG_FILE} 结构不对（须含 entries 列表）`);
  }
  return { version: 1, entries: parsed.entries as OrgCatalogEntry[] };
}

export function saveCatalogBook(home: string, book: OrgCatalogBook): void {
  writeJsonAtomic(home, ORG_CATALOG_FILE, JSON.stringify(book, null, 2) + "\n");
}

// ---- 租户隔离：开关与违规记录 ----

/**
 * 生效的隔离开关：数据隔离恒开（硬边界，不可关闭；缺字段的老组织同样按开处理）；
 * 设置与用量两面尚未实现（组织级设置、用量分账不在本批），只读展示为关，
 * 不造假开关。
 */
export function effectiveOrgIsolation(org: Org): OrgIsolation {
  return {
    data: true,
    settings: org.isolation?.settings ?? false,
    usage: org.isolation?.usage ?? false,
  };
}

/**
 * 记一次隔离违反（越权访问被拦下）：违规账本 + 组织审计 + 运行事件 +
 * 收件箱告警。四个落点各自 try/catch——审计写失败不改变“已拒绝”的结论，
 * 拒绝本身不依赖记录落盘。
 */
export function recordIsolationViolation(
  home: string,
  rec: { orgId: string | null; accountId: string; what: IsolationViolationWhat; detail: string },
): OrgViolation {
  const row: OrgViolation = {
    at: nowIso(),
    org_id: rec.orgId,
    account_id: rec.accountId,
    what: rec.what,
    detail: rec.detail,
    outcome: "denied",
  };
  try {
    const dir = resolveNyraHome(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, ORG_VIOLATIONS_FILE);
    if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, JSON.stringify(row) + "\n", null, "utf-8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } catch { /* 违规账本写失败不改变拒绝结论 */ }
  try {
    appendOrgAudit(home, { action: "org_isolation_violation", org_id: rec.orgId, account_id: rec.accountId, what: rec.what });
  } catch { /* ignore */ }
  let runId: string | null = null;
  try {
    runId = recordOrgEvent(home, "org_isolation_violation", {
      org_id: rec.orgId ?? "", account_id: rec.accountId, what: rec.what, outcome: "denied",
    });
  } catch { /* ignore */ }
  try {
    if (runId) appendInbox(runId, "org_isolation_violation", `组织隔离拦下一次越权访问：${rec.detail}`, home);
  } catch { /* ignore */ }
  return row;
}

/** 读隔离违反账本（坏行跳过；只读，不写；供 listViolations 与测试用）。 */
export function readViolations(home: string): OrgViolation[] {
  const path = join(resolveNyraHome(home), ORG_VIOLATIONS_FILE);
  if (!existsSync(path)) return [];
  const out: OrgViolation[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as OrgViolation;
      if (raw && raw.org_id !== undefined && raw.what && raw.at) out.push(raw);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 列出某组织的隔离违反记录（新的在前；操作者须该组织 admin 或机主）。 */
export async function listViolations(
  home: string,
  orgRef: string,
  actor: string,
  limit = 20,
  stores?: AccountsStores,
): Promise<OrgViolation[]> {
  const org = getOrg(home, orgRef);
  if (!(await isOrgManager(home, org, actor, stores))) {
    throw new OrgSharingError(`${actor} 不是 ${org.name} 的管理员：看隔离违反记录须机主或该组织 admin`);
  }
  const out = readViolations(home).filter((raw) => raw.org_id === org.id);
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  return out.slice(0, Math.max(0, Math.floor(limit)));
}

function validateBotId(botId: string): string {
  const clean = botId.trim();
  if (!clean) throw new OrgSharingError("Bot id 不能为空");
  if (clean.length > 64) throw new OrgSharingError("Bot id 太长（最多 64 字）");
  if (/[\u0000-\u001f\u007f\/\\]/.test(clean)) throw new OrgSharingError("Bot id 不能含控制字符、/ 或 \\");
  return clean;
}

function validateWriteActions(actions: unknown): SharedBotWriteAction[] {
  if (!Array.isArray(actions) || !actions.length) {
    throw new OrgSharingError("写授权须至少给一个动作（write_memory / write_file / send_message）");
  }
  const out: SharedBotWriteAction[] = [];
  for (const a of actions) {
    if (a !== "write_memory" && a !== "write_file" && a !== "send_message") {
      throw new OrgSharingError(`写动作只认 write_memory / write_file / send_message，当前是 ${JSON.stringify(a)}`);
    }
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

function parseExpiresAt(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new OrgSharingError(`过期时间不是合法日期：${raw}`);
  return d.toISOString();
}

function grantExpired(grant: { expires_at: string | null }): boolean {
  return !!grant.expires_at && new Date(grant.expires_at) <= new Date();
}

// ---------------------------------------------------------------------------
// 共享 Bot：发布 / 取消 / 读权限（默认只读）/ 写授权（Bot 主人显式接受）
// ---------------------------------------------------------------------------

/** 按共享记录 id 或 bot_id 找组织内在用的共享 Bot（已取消的不算）。 */
export function findSharedBot(book: OrgSharingBook, orgId: string, ref: string): SharedBot | null {
  return book.shared_bots.find((b) => b.org_id === orgId && (b.id === ref || b.bot_id === ref) && b.status === "active") ?? null;
}

/** 发布 Bot 进组织（操作者须组织 write；Bot 主人就是发布者本人）。 */
export async function publishSharedBot(
  home: string,
  orgRef: string,
  botId: string,
  opts: { botName?: string; description?: string; sharedWith?: "org" | string[]; by?: string; stores?: AccountsStores },
): Promise<SharedBot> {
  const cleanBotId = validateBotId(botId);
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, by, "write", opts?.stores))) {
    throw new OrgSharingError(`${by} 没有 ${org.name} 的写权限：发布共享 Bot 须是该组织成员（member 以上）`);
  }
  const book = loadSharingBook(home);
  if (findSharedBot(book, org.id, cleanBotId)) {
    throw new OrgSharingError(`Bot ${cleanBotId} 已在 ${org.name} 里共享（先取消再重新发布）`);
  }
  let sharedWith: "org" | string[] = "org";
  if (opts?.sharedWith !== undefined && opts.sharedWith !== "org") {
    if (!Array.isArray(opts.sharedWith) || !opts.sharedWith.length) {
      throw new OrgSharingError("共享给指定的人时须至少给一个账号 id");
    }
    const checked: string[] = [];
    for (const ref of opts.sharedWith) {
      const account = await resolveAccountRef(home, ref, opts?.stores);
      if (account.status === "suspended") throw new OrgSharingError(`账号 ${account.email} 已停用：不能共享给它`);
      if (!checked.includes(account.id)) checked.push(account.id);
    }
    sharedWith = checked;
  }
  const bot: SharedBot = {
    id: newId("sbot_"),
    org_id: org.id,
    bot_id: cleanBotId,
    bot_name: (opts?.botName ?? cleanBotId).trim().slice(0, 64) || cleanBotId,
    description: (opts?.description ?? "").slice(0, 200),
    owner: by,
    shared_with: sharedWith,
    status: "active",
    published_at: nowIso(),
    published_by: by,
  };
  book.shared_bots.push(bot);
  saveSharingBook(home, book);
  // Org.shared_bots 镜像一份共享记录 id（第一批留的扩展位，本批填上）。
  try {
    const orgBook = loadOrgBook(home);
    const target = orgBook.orgs.find((o) => o.id === org.id);
    if (target) {
      target.shared_bots = [...(target.shared_bots ?? []), bot.id];
      saveOrgBook(home, orgBook);
    }
  } catch { /* 镜像写失败不影响共享本身（共享账本为准） */ }
  appendOrgAudit(home, { action: "org_bot_shared", org_id: org.id, bot_id: bot.bot_id, by });
  recordOrgEvent(home, "org_bot_shared", { org_id: org.id, bot_id: bot.bot_id, bot_name: bot.bot_name, by });
  return bot;
}

/** 列出组织内在用的共享 Bot（操作者须组织 read）。 */
export async function listSharedBots(
  home: string,
  orgRef: string,
  actor: string,
  stores?: AccountsStores,
): Promise<SharedBot[]> {
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, actor, "read", stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "bot", detail: `列出组织 ${org.name} 的共享 Bot 被拒绝` });
    throw new OrgSharingError(`${actor} 没有 ${org.name} 的读权限`);
  }
  // 只列该账号真能读的 Bot：指定人共享的 Bot，不在名单里的人连列表都看不到。
  const out: SharedBot[] = [];
  for (const b of loadSharingBook(home).shared_bots.filter((b) => b.org_id === org.id && b.status === "active")) {
    if (await canReadSharedBot(home, org.id, b.bot_id, actor, stores)) out.push(b);
  }
  return out;
}

/** 取消共享（Bot 主人、该组织 admin 或机主；记录保留备查，状态改 revoked）。 */
export async function unshareBot(
  home: string,
  orgRef: string,
  botRef: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<void> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot) throw new OrgSharingError(`组织 ${org.name} 里没有在用的共享 Bot：${botRef}`);
  const isOwner = bot.owner === by;
  if (!isOwner && !(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${bot.bot_name} 的主人、也不是 ${org.name} 的管理员：取消共享须其中之一`);
  }
  bot.status = "revoked";
  // 写授权随共享一起失效（revoked 的授权不再放行，记录保留备查）。
  for (const g of book.write_grants) {
    if (g.bot_id === bot.id && g.status === "active") g.status = "revoked";
  }
  saveSharingBook(home, book);
  try {
    const orgBook = loadOrgBook(home);
    const target = orgBook.orgs.find((o) => o.id === org.id);
    if (target && target.shared_bots) {
      target.shared_bots = target.shared_bots.filter((id) => id !== bot.id);
      saveOrgBook(home, orgBook);
    }
  } catch { /* ignore */ }
  appendOrgAudit(home, { action: "org_bot_unshared", org_id: org.id, bot_id: bot.bot_id, by });
  recordOrgEvent(home, "org_bot_unshared", { org_id: org.id, bot_id: bot.bot_id, by });
}

/** 该账号能不能看这个共享 Bot 的任务产物（默认只读的“读”就是这一扇门）。 */
/** 该账号能不能读这个共享 Bot（Bot 不存在或已取消共享时直接 false，不抛错）。 */
export async function canReadSharedBot(
  home: string,
  orgRef: string,
  botRef: string,
  accountId: string,
  stores?: AccountsStores,
): Promise<boolean> {
  const org = getOrg(home, orgRef);
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot || bot.status !== "active") return false;
  if (accountId === ORG_OWNER_IDENTITY) return true;
  if (bot.owner === accountId) return true;
  try {
    const directory = stores?.directory ?? new AccountStore(home);
    const account = await directory.findById(accountId);
    if (!account || account.status === "suspended") return false;
    if (account.role === "owner") return true;
  } catch {
    return false;
  }
  if (bot.shared_with === "org") {
    return canOrg(home, bot.org_id, accountId, "read", stores);
  }
  return bot.shared_with.includes(accountId);
}

/** 该账号能不能对这个共享 Bot 做这个写动作（默认全拒绝；Bot 主人恒可写）。 */
export async function canSharedBotWrite(
  home: string,
  orgRef: string,
  botRef: string,
  accountId: string,
  action: SharedBotWriteAction,
  stores?: AccountsStores,
): Promise<boolean> {
  const org = getOrg(home, orgRef);
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot || bot.status !== "active") return false;
  if (accountId === bot.owner) return true;
  const grant = book.write_grants.find(
    (g) => g.bot_id === bot.id && g.account_id === accountId && g.status === "active",
  );
  if (!grant || grantExpired(grant)) return false;
  if (!grant.actions.includes(action)) return false;
  // 写以读为前提：没读权限的账号拿了 grant 也写不了。
  return canReadSharedBot(home, org.id, botRef, accountId, stores);
}

/**
 * 接受写授权（只有 Bot 主人能接受；机主可代行，组织 admin 不行——
 * “写操作须 Bot 主人显式接受”，admin 代接受就不是主人接受了）。
 */
export async function grantSharedBotWrite(
  home: string,
  orgRef: string,
  botRef: string,
  accountRef: string,
  actions: unknown,
  opts: { by?: string; expiresAt?: string | null; stores?: AccountsStores },
): Promise<SharedBotWriteGrant> {
  const cleanActions = validateWriteActions(actions);
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot) throw new OrgSharingError(`组织 ${org.name} 里没有在用的共享 Bot：${botRef}`);
  if (by !== bot.owner && !(await isSuperAdmin(home, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${bot.bot_name} 的主人：写授权须 Bot 主人显式接受`);
  }
  const account = await resolveAccountRef(home, accountRef, opts?.stores);
  if (account.status === "suspended") throw new OrgSharingError(`账号 ${account.email} 已停用：不能给它写授权`);
  if (book.write_grants.some((g) => g.bot_id === bot.id && g.account_id === account.id && g.status === "active")) {
    throw new OrgSharingError(`${account.email} 已有 ${bot.bot_name} 的写授权（先回收再重新给）`);
  }
  const grant: SharedBotWriteGrant = {
    id: newId("sbwg_"),
    bot_id: bot.id,
    org_id: org.id,
    account_id: account.id,
    actions: cleanActions,
    granted_by: by,
    granted_at: nowIso(),
    expires_at: parseExpiresAt(opts?.expiresAt),
    status: "active",
  };
  book.write_grants.push(grant);
  saveSharingBook(home, book);
  appendOrgAudit(home, { action: "org_bot_write_granted", org_id: org.id, bot_id: bot.bot_id, account_id: account.id, by });
  recordOrgEvent(home, "org_bot_write_granted", {
    org_id: org.id, bot_id: bot.bot_id, account_id: account.id, actions: cleanActions.join(","), by,
  });
  return grant;
}

/** 回收写授权（Bot 主人或机主；记录保留备查，状态改 revoked）。 */
export async function revokeSharedBotWrite(
  home: string,
  orgRef: string,
  botRef: string,
  accountRef: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<void> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot) throw new OrgSharingError(`组织 ${org.name} 里没有在用的共享 Bot：${botRef}`);
  if (by !== bot.owner && !(await isSuperAdmin(home, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${bot.bot_name} 的主人：回收写授权须 Bot 主人或机主`);
  }
  const account = await resolveAccountRef(home, accountRef, opts?.stores);
  const grant = book.write_grants.find(
    (g) => g.bot_id === bot.id && g.account_id === account.id && g.status === "active",
  );
  if (!grant) throw new OrgSharingError(`${account.email} 没有 ${bot.bot_name} 的有效写授权`);
  grant.status = "revoked";
  saveSharingBook(home, book);
  appendOrgAudit(home, { action: "org_bot_write_revoked", org_id: org.id, bot_id: bot.bot_id, account_id: account.id, by });
  recordOrgEvent(home, "org_bot_write_revoked", { org_id: org.id, bot_id: bot.bot_id, account_id: account.id, by });
}

/** 列出一个共享 Bot 的有效写授权（Bot 主人或该组织 admin 可看）。 */
export async function listWriteGrants(
  home: string,
  orgRef: string,
  botRef: string,
  actor: string,
  stores?: AccountsStores,
): Promise<SharedBotWriteGrant[]> {
  const org = getOrg(home, orgRef);
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot) throw new OrgSharingError(`组织 ${org.name} 里没有在用的共享 Bot：${botRef}`);
  if (actor !== bot.owner && !(await isOrgManager(home, org, actor, stores))) {
    throw new OrgSharingError(`${actor} 不是 ${bot.bot_name} 的主人、也不是 ${org.name} 的管理员`);
  }
  return book.write_grants.filter((g) => g.bot_id === bot.id && g.status === "active" && !grantExpired(g));
}

// ---------------------------------------------------------------------------
// Review learnings：队友教学先挂待审区，owner / Manager 批了才生效
// ---------------------------------------------------------------------------

/** 队友教 Team Bot 一句（操作者须组织 write；内容 2–2000 字；先进待审区）。 */
export async function submitLearning(
  home: string,
  orgRef: string,
  botRef: string,
  content: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<OrgLearning> {
  const clean = typeof content === "string" ? content.trim() : "";
  if (clean.length < 2) throw new OrgSharingError("教学内容至少 2 个字");
  if (clean.length > 2000) throw new OrgSharingError("教学内容最多 2000 字（与记忆条目正文上限一致）");
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, by, "write", opts?.stores))) {
    throw new OrgSharingError(`${by} 没有 ${org.name} 的写权限：教 Team Bot 须是该组织成员（member 以上）`);
  }
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot) throw new OrgSharingError(`组织 ${org.name} 里没有在用的共享 Bot：${botRef}`);
  const learning: OrgLearning = {
    id: newId("olrn_"),
    org_id: org.id,
    bot_id: bot.id,
    proposed_by: by,
    content: clean,
    status: "pending",
    created_at: nowIso(),
    reviewed_by: null,
    reviewed_at: null,
    memory_entry_id: null,
  };
  book.learnings.push(learning);
  saveSharingBook(home, book);
  appendOrgAudit(home, { action: "org_learning_submitted", org_id: org.id, bot_id: bot.bot_id, by });
  recordOrgEvent(home, "org_learning_submitted", { org_id: org.id, bot_id: bot.bot_id, learning_id: learning.id, by });
  return learning;
}

/** 列出一个共享 Bot 的教学（操作者须组织 read；默认只列待审的）。 */
export async function listLearnings(
  home: string,
  orgRef: string,
  botRef: string,
  actor: string,
  status?: LearningStatus,
  stores?: AccountsStores,
): Promise<OrgLearning[]> {
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, actor, "read", stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "bot", detail: `列出组织 ${org.name} 的 Bot 教学被拒绝` });
    throw new OrgSharingError(`${actor} 没有 ${org.name} 的读权限`);
  }
  const book = loadSharingBook(home);
  const bot = findSharedBot(book, org.id, botRef);
  if (!bot) throw new OrgSharingError(`组织 ${org.name} 里没有在用的共享 Bot：${botRef}`);
  return book.learnings.filter((l) => l.bot_id === bot.id && (status === undefined || l.status === status));
}

/**
 * 批教学（Bot 主人或该组织 admin；机主可代行）。
 * 批准 = 生效：落成一条组织记忆条目（scope=org），走记忆证据门的 CLI
 * 路径——引用即教学内容本身（批准人就是依据的提供者），正文含密钥时
 * 同样拒绝，拒绝时教学留在待审区（fail-closed，不悄悄生效）。
 */
export async function reviewLearning(
  home: string,
  learningId: string,
  decision: "approve" | "reject",
  opts: { by?: string; stores?: AccountsStores },
): Promise<OrgLearning> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadSharingBook(home);
  const learning = book.learnings.find((l) => l.id === learningId);
  if (!learning) throw new OrgSharingError(`没有这条教学：${learningId}`);
  if (learning.status !== "pending") {
    throw new OrgSharingError(`这条教学已是 ${learning.status}，不能再批`);
  }
  const org = getOrg(home, learning.org_id);
  const bot = book.shared_bots.find((b) => b.id === learning.bot_id) ?? null;
  if (!bot || bot.status !== "active") throw new OrgSharingError("对应的共享 Bot 已取消共享：教学不能再批");
  if (by !== bot.owner && !(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${bot.bot_name} 的主人、也不是 ${org.name} 的管理员：批教学须其中之一`);
  }
  if (decision === "reject") {
    learning.status = "rejected";
    learning.reviewed_by = by;
    learning.reviewed_at = nowIso();
    saveSharingBook(home, book);
    appendOrgAudit(home, { action: "org_learning_rejected", org_id: org.id, bot_id: bot.bot_id, by });
    recordOrgEvent(home, "org_learning_rejected", { org_id: org.id, bot_id: bot.bot_id, learning_id: learning.id, by });
    return learning;
  }
  // 批准：先落记忆条目，落成了再改教学状态——落不进去时教学留在待审区。
  const entry = rememberMemoryEntry(home, {
    scope: "org",
    orgId: org.id,
    subject: `Team Bot 学习：${bot.bot_name}`,
    content: learning.content,
    sourceRefs: [`learning:${learning.id}`, `approved-by:${by}`],
    status: "confirmed",
    evidenceQuotes: [learning.content.slice(0, 500)],
  }, null, { actor: "org-learning", checkVerbatim: false });
  learning.status = "approved";
  learning.reviewed_by = by;
  learning.reviewed_at = nowIso();
  learning.memory_entry_id = entry.id;
  saveSharingBook(home, book);
  appendOrgAudit(home, { action: "org_learning_approved", org_id: org.id, bot_id: bot.bot_id, by });
  recordOrgEvent(home, "org_learning_approved", { org_id: org.id, bot_id: bot.bot_id, learning_id: learning.id, by });
  return learning;
}

// ---------------------------------------------------------------------------
// 租户隔离：任务与记忆的组织归属门
// ---------------------------------------------------------------------------

/** 该账号能不能读这条任务（无归属 = 全局任务，谁都能读；有归属须组织 read）。拒绝时记一次隔离违反。 */
export async function canAccessTask(
  home: string,
  runId: string,
  accountId: string,
  stores?: AccountsStores,
): Promise<{ allowed: boolean; orgId: string | null }> {
  const orgId = readTaskOrg(home, runId);
  if (!orgId) return { allowed: true, orgId: null };
  if (await canOrg(home, orgId, accountId, "read", stores)) return { allowed: true, orgId };
  recordIsolationViolation(home, { orgId, accountId, what: "task", detail: `读组织任务 ${runId} 被拒绝` });
  return { allowed: false, orgId };
}

/** 列出某组织的任务（操作者须组织 read；拒绝时记一次隔离违反并抛错）。 */
export async function listOrgTasks(
  home: string,
  orgRef: string,
  actor: string,
  stores?: AccountsStores,
): Promise<RunState[]> {
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, actor, "read", stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "task", detail: `列出组织 ${org.name} 的任务被拒绝` });
    throw new OrgSharingError(`${actor} 没有 ${org.name} 的读权限`);
  }
  const ids = new Set(listTaskIdsByOrg(home, org.id));
  const store = new RunStore(join(resolveNyraHome(home), "tasks"));
  return store.list().filter((s) => ids.has(s.run_id));
}

/** 该账号能不能读这条记忆（无 orgId = 全局/项目记忆，老口径；有 orgId 须组织 read）。拒绝时记一次隔离违反。 */
export async function canAccessMemoryEntry(
  home: string,
  entry: MemoryGateEntry,
  accountId: string,
  stores?: AccountsStores,
): Promise<boolean> {
  if (!entry.orgId) return true;
  if (await canOrg(home, entry.orgId, accountId, "read", stores)) return true;
  recordIsolationViolation(home, { orgId: entry.orgId, accountId, what: "memory", detail: `读组织记忆条目 ${entry.id} 被拒绝` });
  return false;
}

/** 列出某组织的记忆条目（操作者须组织 read；拒绝时记一次隔离违反并抛错）。 */
export async function listOrgMemoryEntries(
  home: string,
  orgRef: string,
  actor: string,
  opts: { status?: "confirmed" | "proposed" | "deleted"; limit?: number } = {},
  stores?: AccountsStores,
): Promise<MemoryGateEntry[]> {
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, actor, "read", stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "memory", detail: `列出组织 ${org.name} 的记忆被拒绝` });
    throw new OrgSharingError(`${actor} 没有 ${org.name} 的读权限`);
  }
  return listMemoryGateEntries(home, { scope: "org", orgId: org.id, status: opts.status, limit: opts.limit });
}

/** 把一次任务记上组织归属（addTask 传 orgId 时调；写失败直接抛错，不静默当全局任务跑）。 */
export function markTaskOrgId(home: string | null | undefined, runId: string, orgId: string): void {
  markTaskOrg(home, runId, orgId);
}

// ---------------------------------------------------------------------------
// 跨租户读文件：组织工作区 + 显式接受（grant）
// ---------------------------------------------------------------------------

/** 给组织绑一个工作区目录（操作者须该组织 admin 或机主；目录须存在）。 */
export async function setOrgWorkspace(
  home: string,
  orgRef: string,
  dir: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<Org> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${org.name} 的管理员：绑工作区须机主或该组织 admin`);
  }
  const abs = resolve(dir);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new OrgSharingError(`工作区目录不存在：${dir}`);
  }
  if (!st.isDirectory()) throw new OrgSharingError(`工作区须是个目录：${dir}`);
  const book = loadOrgBook(home);
  const target = book.orgs.find((o) => o.id === org.id);
  if (!target) throw new OrgSharingError(`没有这个组织：${orgRef}`);
  target.workspace_dir = abs;
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_workspace_set", org_id: org.id, by });
  recordOrgEvent(home, "org_workspace_set", { org_id: org.id, by });
  return target;
}

function validatePathPrefix(prefix: string): string {
  const clean = prefix.trim().replace(/\\/g, "/");
  if (clean.startsWith("/")) throw new OrgSharingError("路径前缀须是组织工作区下的相对路径，不能以 / 开头");
  const parts = clean.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new OrgSharingError("路径前缀不能含 ..（不许越出工作区）");
  return parts.join("/");
}

function validateRelPath(relPath: string): string {
  const clean = relPath.trim().replace(/\\/g, "/");
  if (!clean || clean.startsWith("/")) throw new OrgSharingError("路径须是组织工作区下的相对路径");
  const parts = clean.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new OrgSharingError("路径不能含 ..（不许越出工作区）");
  if (!parts.length) throw new OrgSharingError("路径不能为空");
  return parts.join("/");
}

function grantCoversPrefix(grant: CrossAccessGrant, relPath: string): boolean {
  if (grant.path_prefix === "") return true;
  return relPath === grant.path_prefix || relPath.startsWith(`${grant.path_prefix}/`);
}

/**
 * 显式接受一次跨租户读（操作者须该组织 admin 或机主）。
 * granteeRef：账号（邮箱或账号 id）或 `org:<组织>`（整个组织）。
 * pathPrefix：组织工作区下的相对前缀，"" = 整个工作区。
 */
export async function grantCrossAccess(
  home: string,
  orgRef: string,
  pathPrefix: string,
  granteeRef: string,
  opts: { by?: string; expiresAt?: string | null; stores?: AccountsStores },
): Promise<CrossAccessGrant> {
  const prefix = validatePathPrefix(pathPrefix);
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${org.name} 的管理员：跨租户读授权须机主或该组织 admin`);
  }
  let kind: "account" | "org";
  let grantedTo: string;
  if (granteeRef.startsWith("org:")) {
    const target = getOrg(home, granteeRef.slice(4));
    if (target.id === org.id) throw new OrgSharingError("不能把组织自己的文件授权给自己（本组织成员本来就能读）");
    kind = "org";
    grantedTo = target.id;
  } else {
    const account = await resolveAccountRef(home, granteeRef, opts?.stores);
    if (account.status === "suspended") throw new OrgSharingError(`账号 ${account.email} 已停用：不能授权给它`);
    kind = "account";
    grantedTo = account.id;
  }
  const book = loadSharingBook(home);
  if (book.cross_access.some((g) => g.org_id === org.id && g.path_prefix === prefix &&
    g.granted_to_kind === kind && g.granted_to === grantedTo && g.status === "active")) {
    throw new OrgSharingError("已有一条有效的同类授权（先回收再重新给）");
  }
  const grant: CrossAccessGrant = {
    id: newId("ocax_"),
    org_id: org.id,
    path_prefix: prefix,
    granted_to_kind: kind,
    granted_to: grantedTo,
    granted_by: by,
    granted_at: nowIso(),
    expires_at: parseExpiresAt(opts?.expiresAt),
    status: "active",
  };
  book.cross_access.push(grant);
  saveSharingBook(home, book);
  appendOrgAudit(home, { action: "org_cross_access_granted", org_id: org.id, granted_to: grantedTo, by });
  recordOrgEvent(home, "org_cross_access_granted", {
    org_id: org.id, granted_to: `${kind}:${grantedTo}`, path: prefix || "(整个工作区)", by,
  });
  return grant;
}

/** 回收跨租户读授权（该组织 admin 或机主）。 */
export async function revokeCrossAccess(
  home: string,
  grantId: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<void> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadSharingBook(home);
  const grant = book.cross_access.find((g) => g.id === grantId && g.status === "active");
  if (!grant) throw new OrgSharingError(`没有这条有效的跨租户读授权：${grantId}`);
  const org = getOrg(home, grant.org_id);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${org.name} 的管理员：回收授权须机主或该组织 admin`);
  }
  grant.status = "revoked";
  saveSharingBook(home, book);
  appendOrgAudit(home, { action: "org_cross_access_revoked", org_id: org.id, by });
  recordOrgEvent(home, "org_cross_access_revoked", { org_id: org.id, grant_id: grant.id, by });
}

/** 列出某组织的跨租户读授权（操作者须组织 read；含已过期未回收的，标出来）。 */
export async function listCrossAccess(
  home: string,
  orgRef: string,
  actor: string,
  stores?: AccountsStores,
): Promise<CrossAccessGrant[]> {
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, actor, "read", stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "file", detail: `列出组织 ${org.name} 的跨租户读授权被拒绝` });
    throw new OrgSharingError(`${actor} 没有 ${org.name} 的读权限`);
  }
  return loadSharingBook(home).cross_access.filter((g) => g.org_id === org.id && g.status === "active");
}

/**
 * 该账号能不能读组织工作区下的这个文件（纯判定，不记违反；读动作本身记）。
 * 放行条件（任一）：机主；本组织成员（read）；一条有效的跨租户授权
 * （账号本人，或其所在组织被授权，且授权前缀覆盖该路径）。
 */
export async function checkOrgFileAccess(
  home: string,
  orgRef: string,
  accountId: string,
  relPath: string,
  stores?: AccountsStores,
): Promise<{ allowed: boolean; reason: string; grantId?: string }> {
  const org = getOrg(home, orgRef);
  if (!org.workspace_dir) return { allowed: false, reason: "组织没绑工作区（先 nyra org workspace 绑一个目录）" };
  const clean = validateRelPath(relPath);
  if (accountId === ORG_OWNER_IDENTITY) return { allowed: true, reason: "机主" };
  try {
    const directory = stores?.directory ?? new AccountStore(home);
    const account = await directory.findById(accountId);
    if (!account || account.status === "suspended") return { allowed: false, reason: "账号不存在或已停用" };
    if (account.role === "owner") return { allowed: true, reason: "机主" };
  } catch {
    return { allowed: false, reason: "账号目录读失败" };
  }
  if (await canOrg(home, org.id, accountId, "read", stores)) {
    return { allowed: true, reason: "本组织成员" };
  }
  const book = loadSharingBook(home);
  for (const g of book.cross_access) {
    if (g.org_id !== org.id || g.status !== "active" || grantExpired(g)) continue;
    if (!grantCoversPrefix(g, clean)) continue;
    if (g.granted_to_kind === "account" && g.granted_to === accountId) {
      return { allowed: true, reason: "跨租户授权", grantId: g.id };
    }
    if (g.granted_to_kind === "org" && (await canOrg(home, g.granted_to, accountId, "read", stores))) {
      return { allowed: true, reason: "所在组织被授权", grantId: g.id };
    }
  }
  return { allowed: false, reason: "没有该文件的跨租户读授权" };
}

/**
 * 读组织工作区下的一个文件（唯一带强制执行的读口径：拒绝时记隔离违反并抛错）。
 * 只跟相对路径，不跟符号链接出工作区；单文件上限 1MB。
 */
export async function readOrgFile(
  home: string,
  orgRef: string,
  accountId: string,
  relPath: string,
  stores?: AccountsStores,
): Promise<{ path: string; content: string }> {
  const org = getOrg(home, orgRef);
  let clean: string;
  try {
    clean = validateRelPath(relPath);
  } catch (e) {
    // 含 .. 的路径是冲着逃出工作区来的：拦下之外再记一次隔离违反。
    if (relPath.includes("..")) {
      recordIsolationViolation(home, { orgId: org.id, accountId, what: "file", detail: `读组织 ${org.name} 下的文件 ${relPath.trim()} 被拒绝（路径含 ..，逃出组织工作区）` });
    }
    throw e;
  }
  const check = await checkOrgFileAccess(home, org.id, accountId, clean, stores);
  if (!check.allowed) {
    recordIsolationViolation(home, { orgId: org.id, accountId, what: "file", detail: `读组织 ${org.name} 下的文件 ${clean} 被拒绝（${check.reason}）` });
    throw new OrgSharingError(`读不进去：${check.reason}`);
  }
  const workspace = org.workspace_dir as string;
  const abs = resolve(workspace, clean);
  if (relative(workspace, abs).startsWith("..")) {
    recordIsolationViolation(home, { orgId: org.id, accountId, what: "file", detail: `读组织 ${org.name} 下的文件 ${clean} 被拒绝（路径越出工作区）` });
    throw new OrgSharingError("路径越出组织工作区");
  }
  if (lstatSync(abs).isSymbolicLink()) {
    recordIsolationViolation(home, { orgId: org.id, accountId, what: "file", detail: `读组织 ${org.name} 下的文件 ${clean} 被拒绝（符号链接）` });
    throw new OrgSharingError("组织工作区里的文件不能是符号链接");
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new OrgSharingError(`组织 ${org.name} 的工作区里没有这个文件：${clean}`);
  }
  if (!st.isFile()) throw new OrgSharingError(`${clean} 不是文件`);
  if (st.size > ORG_FILE_READ_MAX_BYTES) throw new OrgSharingError(`文件太大（超过 1MB），组织共享读不搬整个文件`);
  return { path: clean, content: readFileSync(abs, "utf-8") };
}

// ---------------------------------------------------------------------------
// 组织内私有目录：与公开市场共用同一套验证信封与安装策略
// ---------------------------------------------------------------------------

/** 公开市场校验模板用的工具集（creator.ts 的 KNOWN_TOOLS；动态 import，避开静态循环）。 */
async function marketKnownTools(): Promise<Set<string>> {
  const { KNOWN_TOOLS } = await import("./creator.ts");
  return KNOWN_TOOLS as Set<string>;
}

/**
 * 发布模板进组织私有目录（操作者须该组织 manage）。
 * 校验与公开市场同一套：parseTemplateText + validateTemplateDefinition
 * （工具名按 KNOWN_TOOLS，home 传了才核红线表）；文本存组织目录下 0600，
 * 只在组织内可见，不进公开市场。
 */
export async function publishOrgCatalogTemplate(
  home: string,
  orgRef: string,
  filePath: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<OrgCatalogEntry> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${org.name} 的管理员：发布进组织私有目录须机主或该组织 admin`);
  }
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) {
    throw new OrgSharingError(`模板文件不存在或不安全：${filePath}`);
  }
  const text = readFileSync(filePath, "utf-8");
  if (text.length > 65536) throw new OrgSharingError("模板过大（超过 64KB）");
  const knownTools = await marketKnownTools();
  const def = validateTemplateDefinition(parseTemplateText(text, basename(filePath)), knownTools, home);
  const book = loadCatalogBook(home);
  if (book.entries.some((e) => e.org_id === org.id && e.name === def.name)) {
    throw new OrgSharingError(`组织 ${org.name} 的私有目录里已有模板 ${def.name}（先移除再重新发布）`);
  }
  const dir = join(resolveNyraHome(home), ORG_CATALOG_DIR, org.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = /\.json$/i.test(filePath) ? ".json" : ".yaml";
  const file = `${templateSlug(def.name)}${ext}`;
  const dest = join(dir, file);
  if (existsSync(dest)) throw new OrgSharingError(`私有目录文件已存在但账本里没有 ${def.name}（先手动清理 ${dest}）`);
  writeText0600(dest, text);
  const entry: OrgCatalogEntry = {
    id: def.name,
    org_id: org.id,
    name: def.name,
    version: def.version,
    source: basename(filePath),
    published_by: by,
    published_at: nowIso(),
    text_sha256: createHash("sha256").update(text, "utf-8").digest("hex"),
    file,
  };
  book.entries.push(entry);
  saveCatalogBook(home, book);
  try {
    const orgBook = loadOrgBook(home);
    const target = orgBook.orgs.find((o) => o.id === org.id);
    if (target) {
      target.private_catalog = true;
      saveOrgBook(home, orgBook);
    }
  } catch { /* ignore */ }
  appendOrgAudit(home, { action: "org_catalog_published", org_id: org.id, by });
  recordOrgEvent(home, "org_catalog_published", { org_id: org.id, template_name: def.name, version: def.version, by });
  return entry;
}

/** 列出组织私有目录里的模板（操作者须组织 read）。 */
export async function listOrgCatalog(
  home: string,
  orgRef: string,
  actor: string,
  stores?: AccountsStores,
): Promise<OrgCatalogEntry[]> {
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, actor, "read", stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "catalog", detail: `列出组织 ${org.name} 的私有目录被拒绝` });
    throw new OrgSharingError(`${actor} 没有 ${org.name} 的读权限`);
  }
  return loadCatalogBook(home).entries.filter((e) => e.org_id === org.id);
}

/** 移除组织私有目录里的模板（操作者须该组织 manage；只删组织目录，不动已安装的全局模板）。 */
export async function removeOrgCatalogTemplate(
  home: string,
  orgRef: string,
  templateName: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<void> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgSharingError(`${by} 不是 ${org.name} 的管理员：移除私有目录模板须机主或该组织 admin`);
  }
  const book = loadCatalogBook(home);
  const idx = book.entries.findIndex((e) => e.org_id === org.id && e.name === templateName);
  if (idx < 0) throw new OrgSharingError(`组织 ${org.name} 的私有目录里没有模板 ${templateName}`);
  const entry = book.entries[idx];
  try { rmSync(join(resolveNyraHome(home), ORG_CATALOG_DIR, org.id, entry.file), { force: true }); } catch { /* ignore */ }
  book.entries.splice(idx, 1);
  saveCatalogBook(home, book);
  appendOrgAudit(home, { action: "org_catalog_removed", org_id: org.id, by });
}

/**
 * 从组织私有目录安装模板（操作者须组织 read）。
 * 安装走与公开市场同一条路：importTemplateText（校验信封 + 落盘成 draft，
 * 须试跑通过才能激活；与 nyra template install 的状态机一致）。
 */
export async function installOrgCatalogTemplate(
  home: string,
  orgRef: string,
  templateName: string,
  opts: { by?: string; stores?: AccountsStores },
): Promise<TemplateLedgerEntry> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const org = getOrg(home, orgRef);
  if (!(await canOrg(home, org.id, by, "read", opts?.stores))) {
    recordIsolationViolation(home, { orgId: org.id, accountId: by, what: "catalog", detail: `从组织 ${org.name} 的私有目录安装模板被拒绝` });
    throw new OrgSharingError(`${by} 没有 ${org.name} 的读权限`);
  }
  const book = loadCatalogBook(home);
  const entry = book.entries.find((e) => e.org_id === org.id && e.name === templateName);
  if (!entry) throw new OrgSharingError(`组织 ${org.name} 的私有目录里没有模板 ${templateName}`);
  const text = readFileSync(join(resolveNyraHome(home), ORG_CATALOG_DIR, org.id, entry.file), "utf-8");
  const knownTools = await marketKnownTools();
  const installed = importTemplateText(home, text, entry.file, `org:${org.id}`, knownTools);
  appendOrgAudit(home, { action: "org_catalog_installed", org_id: org.id, by });
  recordOrgEvent(home, "org_catalog_installed", { org_id: org.id, template_name: installed.name, by });
  return installed;
}
