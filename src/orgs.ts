// src/orgs.ts — 缺口 49 第一批：多租户与组织管理——组织/成员/角色。
//
// 报告 ~/workspace/research_notes/nyra-bot-direction-20261120.md §6 缺口 49：
// 组织（租户）→ 成员（SCIM 开通/回收）→ 角色（admin/member/viewer）→
// 共享 Bot → 租户隔离。本批只做第一批：组织创建与管理、成员开通/回收、
// 角色 admin/member/viewer 与权限校验；共享 Bot 与租户隔离是第二批，
// 数据结构里留了扩展位（Org.shared_bots / isolation / private_catalog），
// 但本批不产生组织归属的数据、不做隔离执行。
//
// 与已有身份层的关系（不要另起一套）：
// - 账号是全局身份（缺口 41，src/accounts.ts）：组织成员只记账号 id，
//   不另存邮箱与名片；成员校验走 AccountStore（账号须存在、须未停用）。
// - SCIM（缺口 43，src/scim.ts）管 IdP 侧的账号开通/回收：SCIM 开通的是
//   “账号”，组织命令开通的是“账号进哪个组织”。停用账号（SCIM DELETE /
//   suspendAccount）后，组织权限立即失效——权限判定每次都现查账号状态，
//   不靠同步任务、不留过期快照。
// - 信任圈（缺口 34，src/circles.ts）管“谁能给 agent 发任务”，组织管
//   “谁在哪个团队里、能做什么”：两套账本分开，组织角色不替代准入圈。
//
// 权限模型（第二批共享 Bot 与隔离沿用同一张表）：
// - viewer：read；member：read + write；admin：read + write + manage。
// - 机主（字面 "owner"，或全局角色为 owner 的账号）是超级管理员：
//   任何组织全部操作都允许，不须是成员。
// - 停用账号（status suspended）全部操作都拒绝，机主也不例外（fail-closed）。
// - 账本读失败时权限判定一律按“拒绝”处理，不抛错、不放行。
//
// 不变量：组织有成员时至少留一名 admin 成员（删最后一名 admin、或把
// 最后一名 admin 降级时，若组织里还剩别的成员，直接拒绝；把组织删空
// 成员时允许——空组织仍归机主管理与删除）。
//
// 存储纪律（与账号、信任圈同款）：账本 ~/.nyra/orgs.json 原子写 0600，
// 损坏先备份再抛错，不静默重建；审计 ~/.nyra/org-audit.jsonl 只追加，
// 只记动作、组织 id、账号 id、角色，不记邮箱、不记 token；组织变更另
// 记一条运行事件（org_created 等，见 src/runs.ts 的 EVENT_FIELDS）。
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { AccountStore, getCurrentAccount, normalizeEmail, type Account, type AccountsStores } from "./accounts.ts";

export const ORGS_FILE = "orgs.json";
export const ORG_AUDIT_FILE = "org-audit.jsonl";
/** 机主伪身份（不是账号 id）：没登录时 CLI 的默认操作者，也是超级管理员。 */
export const ORG_OWNER_IDENTITY = "owner";

export class OrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgError";
  }
}

/** 组织内角色：admin 管成员与设置，member 可读写，viewer 只读。 */
export type OrgRole = "admin" | "member" | "viewer";
/** 权限动作：read 读、write 写、manage 管成员与设置。 */
export type OrgAction = "read" | "write" | "manage";

export const ORG_ROLES: readonly OrgRole[] = ["admin", "member", "viewer"];
export const ORG_ACTIONS: readonly OrgAction[] = ["read", "write", "manage"];

/** 角色能做的动作（viewer 只读；member 读写；admin 全有）。 */
export const ORG_ROLE_ACTIONS: Record<OrgRole, readonly OrgAction[]> = {
  viewer: ["read"],
  member: ["read", "write"],
  admin: ["read", "write", "manage"],
};

export interface OrgMember {
  /** 账号 id（accounts.json 里的 id；机主不占成员位，见文件头）。 */
  account_id: string;
  role: OrgRole;
  added_by: string;
  added_at: string;
}

export interface OrgIsolation {
  data: boolean;
  settings: boolean;
  usage: boolean;
}

export interface Org {
  id: string;
  name: string;
  description: string;
  created_at: string;
  created_by: string;
  members: OrgMember[];
  /** 扩展位（第二批：共享 Bot）：Team Bot 的 id 列表。 */
  shared_bots?: string[];
  /** 扩展位（第二批：租户隔离）：数据/设置/用量三面隔离的开关，本批只占位。 */
  isolation?: OrgIsolation;
  /** 扩展位（第二批：市场私有目录）：组织内私有策展目录是否开启。 */
  private_catalog?: boolean;
  /** 第二批：组织绑定的工作区目录（绝对路径；跨租户读文件只认这个目录下的相对路径）。 */
  workspace_dir?: string;
  /** O3：组织强制 SSO。开后该组织成员（或邮箱域名命中的人）只能走 SSO 登录。 */
  require_sso?: boolean;
  /** 强制 SSO 时用的身份提供方 id（sso-providers.json 里的 id）。 */
  sso_provider?: string;
  /** 绑定到该组织的邮箱域名（小写，如 example.com）：该域名邮箱按此组织路由。 */
  sso_domains?: string[];
}

export interface OrgBook {
  version: 1;
  orgs: Org[];
}

function orgsPath(home: string): string {
  return join(resolveNyraHome(home), ORGS_FILE);
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newOrgId(): string {
  return "org_" + randomBytes(6).toString("hex");
}

/** 读组织账本：没有返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadOrgBook(home: string): OrgBook {
  const path = orgsPath(home);
  if (!existsSync(path)) return { version: 1, orgs: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new OrgError(`${ORGS_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.orgs)) {
    throw new OrgError(`${ORGS_FILE} 结构不对（须含 orgs 列表）`);
  }
  return { version: 1, orgs: parsed.orgs as Org[] };
}

export function saveOrgBook(home: string, book: OrgBook): void {
  writeJsonAtomic(home, ORGS_FILE, JSON.stringify(book, null, 2) + "\n");
}

/** 按 id 或名字找组织（id 优先；名字精确匹配）。 */
export function findOrg(book: OrgBook, ref: string): Org | null {
  return book.orgs.find((o) => o.id === ref) ?? book.orgs.find((o) => o.name === ref) ?? null;
}

// ---- O3：组织强制 SSO 与邮箱域名路由 -------------------------------------

/** 邮箱域名（小写）：不合法返回 null（不猜、不补）。 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) || !d.includes(".")) return null;
  return d;
}

/** 归一一个绑定域名：合法返回小写域名，否则 null。 */
export function normalizeSsoDomain(domain: unknown): string | null {
  if (typeof domain !== "string") return null;
  return emailDomain("x@" + domain.trim());
}

/** 邮箱域名命中的组织（require_sso 开没开都算：路由用；拦截只看 require_sso）。 */
export function findOrgForEmailDomain(home: string, email: string): Org | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  const book = loadOrgBook(home);
  return book.orgs.find((o) =>
    Array.isArray(o.sso_domains) &&
    o.sso_domains.some((d) => typeof d === "string" && d.toLowerCase() === domain),
  ) ?? null;
}

/**
 * 非 SSO 登录前调：域名命中强制 SSO 的组织，或账号已是强制 SSO 组织的成员时拒绝。
 * SSO 登录本身不走这里（loginWithSso 不调）；域名没绑、组织没开强制时放行。
 */
export function assertNonSsoLoginAllowed(
  home: string,
  opts: { email?: string | null; accountId?: string | null },
): void {
  const book = loadOrgBook(home);
  if (opts.email) {
    const org = findOrgForEmailDomain(home, opts.email);
    if (org?.require_sso) {
      const provider = org.sso_provider ? `nyra sso login ${org.sso_provider}` : "nyra sso login <身份提供方>";
      throw new OrgError(`邮箱域名属于组织「${org.name}」，该组织要求 SSO 登录：请用 ${provider} 登录（GitHub/Google/邮箱登录已被该组织禁用）`);
    }
  }
  if (opts.accountId) {
    const org = book.orgs.find((o) => o.require_sso && o.members.some((m) => m.account_id === opts.accountId));
    if (org) {
      const provider = org.sso_provider ? `nyra sso login ${org.sso_provider}` : "nyra sso login <身份提供方>";
      throw new OrgError(`账号已是组织「${org.name}」的成员，该组织要求 SSO 登录：请用 ${provider} 登录（GitHub/Google/邮箱登录已被该组织禁用）`);
    }
  }
}

/**
 * 改一个组织的 SSO 设置（操作者须机主或该组织 admin；改动进组织审计与运行事件）。
 * require_sso 开着但没绑身份提供方也能存——先开开关、后注册提供方是合法顺序，
 * 此时非 SSO 登录仍会被拦，登录提示里写 <身份提供方>，CLI 会提醒先绑提供方。
 */
export async function setOrgSso(
  home: string,
  ref: string,
  opts: { require_sso?: boolean; sso_provider?: string | null; sso_domains?: string[]; by?: string; stores?: AccountsStores },
): Promise<Org> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadOrgBook(home);
  const org = findOrg(book, ref);
  if (!org) throw new OrgError(`没有这个组织：${ref}`);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgError(`${by} 不是 ${org.name} 的管理员：改 SSO 设置须机主或该组织 admin`);
  }
  if (opts.require_sso !== undefined) org.require_sso = opts.require_sso;
  if (opts.sso_provider !== undefined) {
    if (opts.sso_provider === null || opts.sso_provider.trim() === "") {
      delete org.sso_provider;
    } else {
      const id = opts.sso_provider.trim();
      if (id.length > 64) throw new OrgError("身份提供方 id 太长（最多 64 字）");
      org.sso_provider = id;
    }
  }
  if (opts.sso_domains !== undefined) {
    const cleaned = opts.sso_domains.map(normalizeSsoDomain);
    if (cleaned.some((d) => d === null)) throw new OrgError("邮箱域名不合法（形如 example.com，多个用逗号分隔）");
    org.sso_domains = [...new Set(cleaned as string[])];
  }
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_sso_changed", org_id: org.id, require_sso: !!org.require_sso, ...(org.sso_provider ? { sso_provider: org.sso_provider } : {}), by });
  recordOrgEvent(home, "org_sso_changed", { org_id: org.id, require_sso: !!org.require_sso, ...(org.sso_provider ? { sso_provider: org.sso_provider } : {}), by });
  return org;
}

function validateOrgName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new OrgError("组织名不能为空");
  if (trimmed.length > 64) throw new OrgError("组织名太长（最多 64 字）");
  if (/[\u0000-\u001f\u007f\/\\]/.test(trimmed)) throw new OrgError("组织名不能含控制字符、/ 或 \\");
  return trimmed;
}

function validateOrgRole(role: string): OrgRole {
  if (role !== "admin" && role !== "member" && role !== "viewer") {
    throw new OrgError(`角色只认 admin / member / viewer，当前是 ${JSON.stringify(role)}`);
  }
  return role;
}

/** 组织变更单独建一条只记 org_* 事件的运行（与信任圈同款做法；第二批共享与隔离复用同一条路）。 */
export function recordOrgEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`组织：${type}`, "org", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

/** 组织审计行：只记动作、组织 id、账号 id、角色，不记邮箱。 */
export function appendOrgAudit(home: string, entry: Record<string, unknown>): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, ORG_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// 组织创建 / 删除 / 列出
// ---------------------------------------------------------------------------

/** 建组织（创建者若是真实账号 id，进成员表当 admin；机主 "owner" 不占成员位，仍是超级管理员）。 */
export function createOrg(home: string, name: string, opts?: { description?: string; by?: string }): Org {
  const cleanName = validateOrgName(name);
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadOrgBook(home);
  if (book.orgs.some((o) => o.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new OrgError(`组织 ${cleanName} 已存在（名字不区分大小写）`);
  }
  const now = nowIso();
  const org: Org = {
    id: newOrgId(),
    name: cleanName,
    description: (opts?.description ?? "").slice(0, 200),
    created_at: now,
    created_by: by,
    members: by === ORG_OWNER_IDENTITY ? [] : [{ account_id: by, role: "admin", added_by: by, added_at: now }],
    // 第二批：数据隔离恒开（硬边界）；设置与用量两面尚未实现，默认关。
    isolation: { data: true, settings: false, usage: false },
    private_catalog: false,
  };
  book.orgs.push(org);
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_created", org_id: org.id, org_name: org.name, by });
  recordOrgEvent(home, "org_created", { org_id: org.id, org_name: org.name, by });
  return org;
}

/** 删组织（机主或该组织 admin；成员随组织一起删，历史审计与事件不删；删前须 --yes，CLI 层把关）。 */
export async function deleteOrg(home: string, ref: string, opts?: { by?: string; stores?: AccountsStores }): Promise<void> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadOrgBook(home);
  const org = findOrg(book, ref);
  if (!org) throw new OrgError(`没有这个组织：${ref}`);
  if (!(await isSuperAdmin(home, by, opts?.stores))) {
    const role = org.members.find((m) => m.account_id === by)?.role ?? null;
    if (role !== "admin") throw new OrgError(`${by} 不是 ${org.name} 的管理员：删组织须机主或该组织 admin`);
  }
  book.orgs = book.orgs.filter((o) => o.id !== org.id);
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_deleted", org_id: org.id, by });
  recordOrgEvent(home, "org_deleted", { org_id: org.id, by });
}

export function listOrgs(home: string): Org[] {
  return loadOrgBook(home).orgs;
}

/** 取组织（没有直接报错，不返回 null 悄悄放行）。 */
export function getOrg(home: string, ref: string): Org {
  const org = findOrg(loadOrgBook(home), ref);
  if (!org) throw new OrgError(`没有这个组织：${ref}`);
  return org;
}

// ---------------------------------------------------------------------------
// 成员开通 / 回收 / 改角色（复用缺口 41 的账号目录与缺口 43 的停用语义）
// ---------------------------------------------------------------------------

/** 按账号 id 或邮箱定位账号（id 优先；邮箱归一化后匹配）。 */
export async function resolveAccountRef(home: string, ref: string, stores?: AccountsStores): Promise<Account> {
  const directory = stores?.directory ?? new AccountStore(home);
  const byId = await directory.findById(ref);
  if (byId) return byId;
  const email = normalizeEmail(ref);
  if (email) {
    const byEmail = await directory.findByEmail(email);
    if (byEmail) return byEmail;
  }
  throw new OrgError(`没有这个账号：${ref}（按账号 id 或邮箱找）`);
}

/** 机主是不是超级管理员：字面 "owner"，或全局角色为 owner 的账号（停用账号不算）。 */
export async function isSuperAdmin(home: string, actor: string, stores?: AccountsStores): Promise<boolean> {
  if (actor === ORG_OWNER_IDENTITY) return true;
  try {
    const directory = stores?.directory ?? new AccountStore(home);
    const account = await directory.findById(actor);
    if (!account) return false;
    if (account.status === "suspended") return false;
    return account.role === "owner";
  } catch {
    return false;
  }
}

/** 操作者是不是该组织的 admin（机主恒真；其余看成员表）。 */
export async function isOrgManager(home: string, org: Org, actor: string, stores?: AccountsStores): Promise<boolean> {
  if (await isSuperAdmin(home, actor, stores)) return true;
  return org.members.some((m) => m.account_id === actor && m.role === "admin");
}

/** 开通成员进组织（账号须存在、未停用；操作者须机主或该组织 admin；重复开通直接报错）。 */
export async function addMember(
  home: string,
  orgRef: string,
  accountRef: string,
  role: string,
  opts?: { by?: string; stores?: AccountsStores },
): Promise<OrgMember> {
  const cleanRole = validateOrgRole(role);
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadOrgBook(home);
  const org = findOrg(book, orgRef);
  if (!org) throw new OrgError(`没有这个组织：${orgRef}`);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgError(`${by} 不是 ${org.name} 的管理员：开通成员须机主或该组织 admin`);
  }
  const account = await resolveAccountRef(home, accountRef, opts?.stores);
  if (account.status === "suspended") throw new OrgError(`账号 ${account.email} 已停用：先恢复账号再开通进组织`);
  if (org.members.some((m) => m.account_id === account.id)) {
    throw new OrgError(`${account.email} 已在 ${org.name} 里（改角色用 nyra org role）`);
  }
  const member: OrgMember = { account_id: account.id, role: cleanRole, added_by: by, added_at: nowIso() };
  org.members.push(member);
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_member_added", org_id: org.id, account_id: account.id, role: cleanRole, by });
  recordOrgEvent(home, "org_member_added", { org_id: org.id, account_id: account.id, role: cleanRole, by });
  return member;
}

/** 回收成员（移出组织；操作者须机主或该组织 admin；组织有别的成员时不许撤掉最后一名 admin）。 */
export async function removeMember(
  home: string,
  orgRef: string,
  accountRef: string,
  opts?: { by?: string; stores?: AccountsStores },
): Promise<void> {
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadOrgBook(home);
  const org = findOrg(book, orgRef);
  if (!org) throw new OrgError(`没有这个组织：${orgRef}`);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgError(`${by} 不是 ${org.name} 的管理员：回收成员须机主或该组织 admin`);
  }
  const account = await resolveAccountRef(home, accountRef, opts?.stores);
  const idx = org.members.findIndex((m) => m.account_id === account.id);
  if (idx < 0) throw new OrgError(`${account.email} 不在 ${org.name} 里`);
  const leaving = org.members[idx];
  const rest = org.members.filter((m) => m.account_id !== account.id);
  if (leaving.role === "admin" && rest.length > 0 && !rest.some((m) => m.role === "admin")) {
    throw new OrgError(`${account.email} 是 ${org.name} 最后一名管理员：先把别人升成 admin 再回收`);
  }
  org.members = rest;
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_member_removed", org_id: org.id, account_id: account.id, by });
  recordOrgEvent(home, "org_member_removed", { org_id: org.id, account_id: account.id, by });
}

/** 改成员角色（操作者须机主或该组织 admin；组织有别的成员时不许把最后一名 admin 降级）。 */
export async function setMemberRole(
  home: string,
  orgRef: string,
  accountRef: string,
  role: string,
  opts?: { by?: string; stores?: AccountsStores },
): Promise<OrgMember> {
  const cleanRole = validateOrgRole(role);
  const by = opts?.by ?? ORG_OWNER_IDENTITY;
  const book = loadOrgBook(home);
  const org = findOrg(book, orgRef);
  if (!org) throw new OrgError(`没有这个组织：${orgRef}`);
  if (!(await isOrgManager(home, org, by, opts?.stores))) {
    throw new OrgError(`${by} 不是 ${org.name} 的管理员：改角色须机主或该组织 admin`);
  }
  const account = await resolveAccountRef(home, accountRef, opts?.stores);
  const member = org.members.find((m) => m.account_id === account.id);
  if (!member) throw new OrgError(`${account.email} 不在 ${org.name} 里（先开通：nyra org add）`);
  if (member.role === cleanRole) return member;
  if (member.role === "admin" && cleanRole !== "admin") {
    const others = org.members.filter((m) => m.account_id !== account.id);
    if (others.length > 0 && !others.some((m) => m.role === "admin")) {
      throw new OrgError(`${account.email} 是 ${org.name} 最后一名管理员：先把别人升成 admin 再降级`);
    }
  }
  member.role = cleanRole;
  saveOrgBook(home, book);
  appendOrgAudit(home, { action: "org_role_changed", org_id: org.id, account_id: account.id, role: cleanRole, by });
  recordOrgEvent(home, "org_role_changed", { org_id: org.id, account_id: account.id, role: cleanRole, by });
  return member;
}

// ---------------------------------------------------------------------------
// 权限判定（热路径：账本读失败、账号不存在、账号停用，一律按“拒绝”处理）
// ---------------------------------------------------------------------------

/** 该账号在组织里的角色（不是成员返回 null；停用账号返回 null；读失败返回 null）。 */
export async function getOrgRole(
  home: string,
  orgRef: string,
  accountId: string,
  stores?: AccountsStores,
): Promise<OrgRole | null> {
  try {
    if (accountId === ORG_OWNER_IDENTITY) return null;
    const org = findOrg(loadOrgBook(home), orgRef);
    if (!org) return null;
    const member = org.members.find((m) => m.account_id === accountId);
    if (!member) return null;
    // 停用即失能：SCIM 停用账号后，组织权限立即失效，不用等同步任务。
    const directory = stores?.directory ?? new AccountStore(home);
    const account = await directory.findById(accountId);
    if (!account || account.status === "suspended") return null;
    return member.role;
  } catch {
    return null;
  }
}

/** 该账号能不能在组织里做这个动作（机主与全局 owner 全放行；其余按角色表；失败一律拒绝）。 */
export async function canOrg(
  home: string,
  orgRef: string,
  accountId: string,
  action: string,
  stores?: AccountsStores,
): Promise<boolean> {
  if (action !== "read" && action !== "write" && action !== "manage") return false;
  if (accountId === ORG_OWNER_IDENTITY) return true;
  try {
    const directory = stores?.directory ?? new AccountStore(home);
    const account = await directory.findById(accountId);
    if (!account || account.status === "suspended") return false;
    // 全局 owner（机主账号）是超级管理员：任何组织全部操作都允许。
    if (account.role === "owner") return true;
    const role = await getOrgRole(home, orgRef, accountId, stores);
    if (!role) return false;
    return (ORG_ROLE_ACTIONS[role] as readonly string[]).includes(action);
  } catch {
    return false;
  }
}

/** 权限门：不允许直接抛错（供网关与 CLI 调用；第二批共享 Bot 与隔离复用同一扇门）。 */
export async function requireOrgAccess(
  home: string,
  orgRef: string,
  accountId: string,
  action: OrgAction,
  stores?: AccountsStores,
): Promise<void> {
  if (!(await canOrg(home, orgRef, accountId, action, stores))) {
    throw new OrgError(`${accountId} 没有 ${orgRef} 的 ${action} 权限`);
  }
}

/** 当前操作者：已登录账号的 id，否则机主 "owner"（CLI 默认 by；读失败也按机主处理，不拦本地操作）。 */
export async function currentActorId(home: string, opts?: { stores?: AccountsStores }): Promise<string> {
  try {
    const account = await getCurrentAccount(home, { stores: opts?.stores });
    return account ? account.id : ORG_OWNER_IDENTITY;
  } catch {
    return ORG_OWNER_IDENTITY;
  }
}
