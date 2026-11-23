// src/accounts.ts — 用户账号登录（缺口 41，第一批）。
//
// 一个账号 = 一个人（邮箱是主标识），可挂多个登录方式（Google、GitHub、
// 邮箱各一个）。登录后发一张会话 token（只此一次返回原文，磁盘只存
// SHA-256），之后凭它证明身份。设计见 docs/accounts.md。
//
// 存储纪律（与配对、密码箱同款）：
//   - 账号/会话/magic link 文件 0600、原子写（tmp + rename，tmp 名用
//     memory.ts 的 atomicTmpPath，Windows 下也不会嵌进完整路径）；
//   - 文件损坏先备份再抛错，不静默清空重建（清空等于把机主身份抹掉）；
//   - OAuth 客户端只存密码箱（oauth-google-client / oauth-github-client），
//     不进配置文件、不进账号文件；
//   - Google / GitHub 的 access/refresh token 本批不存：登录只是一次身份
//     证明，Nyra 之后不替用户调 Google/GitHub API，存了用不上的 token
//     是多余的攻击面。
//   - 审计只记动作、provider、账号 id，不记邮箱、不记 token
//     （~/.nyra/accounts-audit.jsonl）。
//
// 本批范围：账号、会话、magic link 令牌核心、审计、Google 授权码 + PKCE
// 回环登录、GitHub 设备流登录、CLI 接线。网关接线与邮箱投递端点下一批
// （见 docs/accounts.md §10）。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { atomicTmpPath } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { buildAuthUrl, codeChallengeS256, newAuthState, newCodeVerifier, postForm, startLoopbackCallbackServer, type FetchFn } from "./oauth.ts";

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export type AccountProvider = "google" | "github" | "email" | "sso";
export type AccountRole = "owner" | "user";

/** 账号状态：active 正常；suspended 已停用（SCIM 取消开通或管理员手动停用）——停用即失能：会话全撤销、登录拒绝、网关鉴权拒绝。 */
export type AccountStatus = "active" | "suspended";

export interface LinkedIdentity {
  provider: AccountProvider;
  /** provider 方的用户唯一标识（Google sub、GitHub 用户 id、邮箱方式就是邮箱本身；SSO 方式是 IdP 的 sub）。 */
  sub: string;
  email: string;
  name?: string;
  /** SSO 身份提供方（OIDC issuer，如 https://login.microsoftonline.com/<tenant>/v2.0）；只有 provider 为 sso 时有。 */
  issuer?: string;
  linked_at: string;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  role: AccountRole;
  providers: LinkedIdentity[];
  created_at: string;
  last_seen: string;
  /** 账号状态（缺省即 active：老文件没有这个字段，按正常处理）。 */
  status?: AccountStatus;
  /** 停用时间（status 为 suspended 时有）。 */
  suspended_at?: string;
  /** SCIM 外部标识（IdP 方的用户 id，供 SCIM 按 externalId 定位账号；不写进审计原文以外的任何地方，只在 SCIM 资源里回显）。 */
  external_id?: string;
}

export interface AccountSession {
  id: string;
  account_id: string;
  token_sha256: string;
  created_at: string;
  last_seen: string;
  expires_at: string;
}

export interface MagicLink {
  id: string;
  email: string;
  token_sha256: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export const ACCOUNTS_FILE = "accounts.json";
export const ACCOUNT_SESSIONS_FILE = "account-sessions.json";
export const MAGIC_LINKS_FILE = "magic-links.json";
export const CURRENT_SESSION_FILE = "account-session.json";
export const ACCOUNTS_AUDIT_FILE = "accounts-audit.jsonl";
/** 会话有效期（30 天；配对 token 是 180 天，账号会话能代表一个人，短一些）。 */
export const ACCOUNT_SESSION_TTL_SECONDS = 30 * 24 * 3600;
/** 会话连续不用多少秒后自动失效（与有效期同长）。 */
export const ACCOUNT_SESSION_INACTIVITY_TTL_SECONDS = 30 * 24 * 3600;
/** magic link 有效期（15 分钟，一次性）。 */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
/** 密码箱条目：OAuth 客户端（名字明文、值加密，见 vault.ts）。 */
export const OAUTH_GOOGLE_CLIENT_ENTRY = "oauth-google-client";
export const OAUTH_GITHUB_CLIENT_ENTRY = "oauth-github-client";

export const LAST_SEEN_WRITE_INTERVAL_SECONDS = 60;

/** 纪元秒 → ISO 时间串。accountsDb.ts 复用同一份时间口径。 */
export function nowIso(epochSeconds?: number): string {
  const ms = epochSeconds === undefined ? Date.now() : epochSeconds * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 会话/magic link token 只存 SHA-256（accountsDb.ts 的 Postgres 实现复用）。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/** 16 位十六进制 id（账号、会话、magic link 共用；accountsDb.ts 复用）。 */
export function newId(): string {
  return randomBytes(8).toString("hex");
}

/** 邮箱归一：去首尾空白、转小写；无效返回 null（不猜、不补）。 */
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const text = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return null;
  return text;
}

/** 原子写 JSON（0600）：目录 0700、tmp 文件 + rename、写完再 chmod。 */
function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = atomicTmpPath(path);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 1), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * 读 JSON 文件：不存在返回 null；损坏先备份（原名 + .corrupt-<pid>-<hex>）
 * 再抛错——身份文件损坏不静默清空，fail-closed。
 */
function readJsonFile<T>(path: string, label: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const backup = path + ".corrupt-" + String(process.pid) + "-" + randomBytes(4).toString("hex");
    try {
      writeFileSync(backup, raw, { encoding: "utf-8", mode: 0o600 });
    } catch {
      /* 备份写不进去也不拦抛错本身 */
    }
    throw new AccountError(label + "损坏（已备份到 " + backup + "），请检查后恢复或删除重建");
  }
}

function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 托管形态的账号目录接口（见 docs/accounts.md §7）：本地文件实现是它的第一个实现，Postgres 实现在 src/accountsDb.ts。 */
export interface AccountDirectory {
  findByProvider(provider: AccountProvider, sub: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  findById(id: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  create(input: { email: string; name?: string; external_id?: string }): Promise<Account>;
  linkIdentity(accountId: string, identity: Omit<LinkedIdentity, "linked_at">): Promise<Account>;
  touchLastSeen(accountId: string): Promise<void>;
  /** 停用账号（只改状态，不删记录；调用方负责撤销会话与记审计）。 */
  suspend(accountId: string): Promise<Account>;
  /** 恢复已停用的账号。 */
  reactivate(accountId: string): Promise<Account>;
  /** 改角色（SCIM 群组映射用；只接受 owner/user，非法值直接报错）。 */
  setRole(accountId: string, role: AccountRole): Promise<Account>;
  /** 改 SCIM 外部标识（null = 清除；SCIM 删除用户时用）。 */
  updateExternalId(accountId: string, externalId: string | null): Promise<Account>;
}

/** 托管形态的会话目录接口：本地文件实现是它的第一个实现。 */
export interface AccountSessionDirectory {
  issue(accountId: string, ttlSeconds?: number): Promise<{ id: string; token: string; expires_at: string }>;
  verify(token: string): Promise<{ account_id: string; session_id: string } | null>;
  /** 列出某账号的会话（不含 token 哈希）。 */
  listSessions(accountId: string): Promise<Omit<AccountSession, "token_sha256">[]>;
  revoke(sessionId: string): Promise<boolean>;
  revokeAllForAccount(accountId: string): Promise<number>;
}

/** 托管形态的 magic link 目录接口（Postgres 实现在 src/accountsDb.ts）。 */
export interface MagicLinkDirectory {
  issue(email: string, ttlSeconds?: number): Promise<{ id: string; token: string; expires_at: string }>;
  redeem(token: string): Promise<string | null>;
}

/** 一组可注入的后端存储：login/upsert 等函数默认用本地文件实现，传入这组就改走 Postgres。 */
export interface AccountsStores {
  directory?: AccountDirectory;
  sessions?: AccountSessionDirectory;
  magicLinks?: MagicLinkDirectory;
  audit?: (entry: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => void | Promise<void>;
}

export class AccountStore implements AccountDirectory {
  readonly path: string;
  private clock: () => number;

  constructor(home: string, opts?: { clock?: () => number }) {
    this.path = join(resolveNyraHome(home), ACCOUNTS_FILE);
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  private load(): Account[] {
    const data = readJsonFile<{ accounts?: unknown }>(this.path, "账号文件");
    if (!data) return [];
    const items = Array.isArray(data.accounts) ? data.accounts : [];
    return items.filter((item): item is Account => {
      return !!item && typeof item === "object" &&
        typeof (item as Account).id === "string" &&
        typeof (item as Account).email === "string" &&
        Array.isArray((item as Account).providers);
    });
  }

  private save(accounts: Account[]): void {
    atomicWriteJson(this.path, { accounts });
  }

  async listAccounts(): Promise<Account[]> {
    return this.load();
  }

  async findByEmail(email: string): Promise<Account | null> {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return this.load().find((a) => a.email === normalized) ?? null;
  }

  async findByProvider(provider: AccountProvider, sub: string): Promise<Account | null> {
    return this.load().find((a) => a.providers.some((p) => p.provider === provider && p.sub === sub)) ?? null;
  }

  async findById(id: string): Promise<Account | null> {
    return this.load().find((a) => a.id === id) ?? null;
  }

  async create(input: { email: string; name?: string; external_id?: string }): Promise<Account> {
    const email = normalizeEmail(input.email);
    if (!email) throw new AccountError("邮箱格式无效");
    const accounts = this.load();
    if (accounts.some((a) => a.email === email)) throw new AccountError("该邮箱已有账号（请直接登录，不要重复创建）");
    const now = nowIso(this.clock());
    const account: Account = {
      id: newId(),
      email,
      name: (input.name ?? "").trim() || email.split("@")[0],
      // 第一个账号自动是 owner（单机场景第一个登录的人就是机主）。
      role: accounts.length === 0 ? "owner" : "user",
      providers: [],
      created_at: now,
      last_seen: now,
      status: "active",
      ...(input.external_id ? { external_id: input.external_id } : {}),
    };
    accounts.push(account);
    this.save(accounts);
    return account;
  }

  async linkIdentity(accountId: string, identity: Omit<LinkedIdentity, "linked_at">): Promise<Account> {
    const email = normalizeEmail(identity.email);
    if (!email) throw new AccountError("邮箱格式无效");
    if (!identity.sub) throw new AccountError("登录方没有返回用户标识");
    const accounts = this.load();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new AccountError("账号不存在");
    if (account.status === "suspended") throw new AccountError("该账号已停用，不能再绑定登录方式");
    const other = accounts.find((a) => a.id !== accountId && a.providers.some((p) => p.provider === identity.provider && p.sub === identity.sub));
    if (other) throw new AccountError("这个 " + identity.provider + " 身份已经绑定到另一个账号了");
    const existing = account.providers.find((p) => p.provider === identity.provider);
    if (existing) {
      if (existing.sub !== identity.sub) throw new AccountError("该账号已经绑定了另一个 " + identity.provider + " 身份");
      existing.email = email;
      if (identity.name) existing.name = identity.name;
      if (identity.issuer) existing.issuer = identity.issuer;
      existing.linked_at = nowIso(this.clock());
    } else {
      account.providers.push({ ...identity, email, linked_at: nowIso(this.clock()) });
    }
    account.last_seen = nowIso(this.clock());
    this.save(accounts);
    return account;
  }

  async suspend(accountId: string): Promise<Account> {
    const accounts = this.load();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new AccountError("账号不存在");
    account.status = "suspended";
    account.suspended_at = nowIso(this.clock());
    this.save(accounts);
    return account;
  }

  async reactivate(accountId: string): Promise<Account> {
    const accounts = this.load();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new AccountError("账号不存在");
    account.status = "active";
    delete account.suspended_at;
    this.save(accounts);
    return account;
  }

  async setRole(accountId: string, role: AccountRole): Promise<Account> {
    if (role !== "owner" && role !== "user") throw new AccountError("角色只允许 owner 或 user");
    const accounts = this.load();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new AccountError("账号不存在");
    account.role = role;
    this.save(accounts);
    return account;
  }

  async updateExternalId(accountId: string, externalId: string | null): Promise<Account> {
    const accounts = this.load();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new AccountError("账号不存在");
    if (externalId) account.external_id = externalId;
    else delete account.external_id;
    this.save(accounts);
    return account;
  }

  async touchLastSeen(accountId: string): Promise<void> {
    const accounts = this.load();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.last_seen = nowIso(this.clock());
    this.save(accounts);
  }
}

export class AccountSessionStore implements AccountSessionDirectory {
  readonly path: string;
  private clock: () => number;
  private lastSeenWritten: Record<string, number> = {};

  constructor(home: string, opts?: { clock?: () => number }) {
    this.path = join(resolveNyraHome(home), ACCOUNT_SESSIONS_FILE);
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  private load(): AccountSession[] {
    const data = readJsonFile<{ sessions?: unknown }>(this.path, "账号会话文件");
    if (!data) return [];
    const items = Array.isArray(data.sessions) ? data.sessions : [];
    return items.filter((item): item is AccountSession => {
      return !!item && typeof item === "object" &&
        typeof (item as AccountSession).id === "string" &&
        typeof (item as AccountSession).account_id === "string" &&
        typeof (item as AccountSession).token_sha256 === "string" &&
        (item as AccountSession).token_sha256.length === 64;
    });
  }

  private save(sessions: AccountSession[]): void {
    atomicWriteJson(this.path, { sessions });
  }

  /** 签发会话：token 原文只在这里返回一次，磁盘只存 SHA-256。 */
  async issue(accountId: string, ttlSeconds: number = ACCOUNT_SESSION_TTL_SECONDS): Promise<{ id: string; token: string; expires_at: string }> {
    const sessions = this.load();
    const now = this.clock();
    const token = randomBytes(32).toString("base64url");
    const session: AccountSession = {
      id: newId(),
      account_id: accountId,
      token_sha256: hashToken(token),
      created_at: nowIso(now),
      last_seen: nowIso(now),
      expires_at: nowIso(now + ttlSeconds),
    };
    sessions.push(session);
    this.save(sessions);
    return { id: session.id, token, expires_at: session.expires_at };
  }

  /** 校验会话 token：过期或 30 天没用过 → 失效并剪掉，返回 null。 */
  async verify(token: string): Promise<{ account_id: string; session_id: string } | null> {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const digest = hashToken(token);
    const sessions = this.load();
    const found = sessions.find((s) => hashEquals(digest, s.token_sha256)) ?? null;
    if (!found) return null;
    const now = this.clock();
    if (Date.parse(found.expires_at) / 1000 <= now) {
      this.save(sessions.filter((s) => s.id !== found.id));
      delete this.lastSeenWritten[found.id];
      return null;
    }
    const lastSeenMs = Date.parse(found.last_seen);
    if (!Number.isNaN(lastSeenMs) && now - lastSeenMs / 1000 > ACCOUNT_SESSION_INACTIVITY_TTL_SECONDS) {
      this.save(sessions.filter((s) => s.id !== found.id));
      delete this.lastSeenWritten[found.id];
      return null;
    }
    const last = this.lastSeenWritten[found.id];
    if (last === undefined || now - last >= LAST_SEEN_WRITE_INTERVAL_SECONDS) {
      this.lastSeenWritten[found.id] = now;
      found.last_seen = nowIso(now);
      try {
        this.save(sessions);
      } catch {
        /* last_seen 写不进去不拦本次校验 */
      }
    }
    return { account_id: found.account_id, session_id: found.id };
  }

  /** 列出某账号的会话（不含 token 哈希）。 */
  async listSessions(accountId: string): Promise<Omit<AccountSession, "token_sha256">[]> {
    return this.load()
      .filter((s) => s.account_id === accountId)
      .map(({ token_sha256: _omit, ...rest }) => rest);
  }

  async revoke(sessionId: string): Promise<boolean> {
    const sessions = this.load();
    const before = sessions.length;
    const next = sessions.filter((s) => s.id !== sessionId);
    if (next.length === before) return false;
    delete this.lastSeenWritten[sessionId];
    this.save(next);
    return true;
  }

  async revokeAllForAccount(accountId: string): Promise<number> {
    const sessions = this.load();
    const kept = sessions.filter((s) => s.account_id !== accountId);
    const removed = sessions.length - kept.length;
    for (const s of sessions) if (s.account_id === accountId) delete this.lastSeenWritten[s.id];
    if (removed > 0) this.save(kept);
    return removed;
  }
}

export class MagicLinkStore implements MagicLinkDirectory {
  readonly path: string;
  private clock: () => number;

  constructor(home: string, opts?: { clock?: () => number }) {
    this.path = join(resolveNyraHome(home), MAGIC_LINKS_FILE);
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  private load(): MagicLink[] {
    const data = readJsonFile<{ links?: unknown }>(this.path, "magic link 文件");
    if (!data) return [];
    const items = Array.isArray(data.links) ? data.links : [];
    return items.filter((item): item is MagicLink => {
      return !!item && typeof item === "object" &&
        typeof (item as MagicLink).id === "string" &&
        typeof (item as MagicLink).email === "string" &&
        typeof (item as MagicLink).token_sha256 === "string" &&
        (item as MagicLink).token_sha256.length === 64;
    });
  }

  private save(links: MagicLink[]): void {
    atomicWriteJson(this.path, { links });
  }

  /** 签发 magic link：token 原文只在这里返回一次，磁盘只存 SHA-256。 */
  async issue(email: string, ttlSeconds: number = MAGIC_LINK_TTL_SECONDS): Promise<{ id: string; token: string; expires_at: string }> {
    const normalized = normalizeEmail(email);
    if (!normalized) throw new AccountError("邮箱格式无效");
    const links = this.load();
    const now = this.clock();
    const token = randomBytes(32).toString("base64url");
    const link: MagicLink = {
      id: newId(),
      email: normalized,
      token_sha256: hashToken(token),
      created_at: nowIso(now),
      expires_at: nowIso(now + ttlSeconds),
      used_at: null,
    };
    links.push(link);
    this.save(links);
    return { id: link.id, token, expires_at: link.expires_at };
  }

  /** 兑换 magic link：过期或已用过 → null；通过后立即标记已用（重放必失败）。 */
  async redeem(token: string): Promise<string | null> {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const digest = hashToken(token);
    const links = this.load();
    const found = links.find((l) => hashEquals(digest, l.token_sha256)) ?? null;
    if (!found) return null;
    const now = this.clock();
    if (found.used_at !== null) return null;
    if (Date.parse(found.expires_at) / 1000 <= now) return null;
    found.used_at = nowIso(now);
    this.save(links);
    return found.email;
  }
}

/** 审计动作：只记动作、provider、账号 id，不记邮箱、不记 token。 */
export type AccountAuditAction = "login" | "logout" | "link" | "revoke" | "magic_link_requested" | "magic_link_redeemed" | "suspended" | "reactivated" | "cloud_connected" | "cloud_disconnected";

export function appendAccountAudit(
  home: string,
  entry: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string },
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    action: entry.action,
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.account_id ? { account_id: entry.account_id } : {}),
  });
  const path = join(resolveNyraHome(home), ACCOUNTS_AUDIT_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* 审计写不进去不拦登录本身 */
  }
}

// ---- 本机当前会话（CLI 的“cookie 罐”）-------------------------------

export interface CurrentSession {
  token: string;
  account_id: string;
  issued_at: string;
}

export function readCurrentSession(home: string): CurrentSession | null {
  const data = readJsonFile<CurrentSession>(join(resolveNyraHome(home), CURRENT_SESSION_FILE), "当前会话文件");
  if (!data || typeof data.token !== "string" || !data.token || typeof data.account_id !== "string") return null;
  return data;
}

export function writeCurrentSession(home: string, session: CurrentSession): void {
  atomicWriteJson(join(resolveNyraHome(home), CURRENT_SESSION_FILE), session);
}

export function clearCurrentSession(home: string): void {
  try {
    unlinkSync(join(resolveNyraHome(home), CURRENT_SESSION_FILE));
  } catch {
    /* 不存在即已清除 */
  }
}

/** 当前登录的账号（本机 token 验过之后才认；验不过按未登录处理；已停用的账号按未登录处理）。 */
export async function getCurrentAccount(home: string, opts?: { clock?: () => number; stores?: AccountsStores }): Promise<Account | null> {
  const current = readCurrentSession(home);
  if (!current) return null;
  const sessions = opts?.stores?.sessions ?? new AccountSessionStore(home, opts);
  const verified = await sessions.verify(current.token);
  if (!verified || verified.account_id !== current.account_id) return null;
  const accounts = opts?.stores?.directory ?? new AccountStore(home, opts);
  const account = await accounts.findById(current.account_id);
  if (!account || account.status === "suspended") return null;
  return account;
}

/**
 * 停用账号（fail-closed，立即失能）：改状态 → 撤销该账号全部会话 → 记审计。
 * 会话撤销后网关鉴权（accountSessions.verify）与 getCurrentAccount 同时失效，
 * 不留“停用了还能用旧会话”的窗口。重复停用不报错（幂等）。
 * 有运行上下文时把停用事件镜像进运行事件（缺口 43 第二批）。
 */
export async function suspendAccount(
  home: string,
  accountId: string,
  opts?: { clock?: () => number; stores?: AccountsStores; runId?: string | null },
): Promise<{ account: Account; revoked_sessions: number }> {
  const directory = opts?.stores?.directory ?? new AccountStore(home, opts);
  const sessions = opts?.stores?.sessions ?? new AccountSessionStore(home, opts);
  const account = await directory.suspend(accountId);
  const revoked = await sessions.revokeAllForAccount(accountId);
  const audit = opts?.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(home, e));
  await audit({ action: "suspended", account_id: accountId });
  mirrorAccountEvent(home, opts?.runId ?? null, "account_suspended", { account_id: accountId });
  return { account, revoked_sessions: revoked };
}

/** 恢复已停用的账号（只改状态，不恢复已撤销的会话——被停用期间的会话作废了就是作废了，须重新登录）。 */
export async function reactivateAccount(
  home: string,
  accountId: string,
  opts?: { clock?: () => number; stores?: AccountsStores; runId?: string | null },
): Promise<Account> {
  const directory = opts?.stores?.directory ?? new AccountStore(home, opts);
  const account = await directory.reactivate(accountId);
  const audit = opts?.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(home, e));
  await audit({ action: "reactivated", account_id: accountId });
  mirrorAccountEvent(home, opts?.runId ?? null, "account_reactivated", { account_id: accountId });
  return account;
}

/** 有运行上下文时，把账号停用/恢复事件镜像进运行事件（与 governance.ts 同款写法）。 */
function mirrorAccountEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch {
      /* 不在这个目录，换下一个 */
    }
  }
}

// ---- Google OAuth（授权码 + PKCE + 回环回调）-------------------------

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_SCOPES = ["openid", "email", "profile"];

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
}

export function buildGoogleAuthUrl(opts: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  return buildAuthUrl(GOOGLE_AUTH_URL, {
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  });
}

export interface GoogleTokens {
  access_token: string;
  expires_at: number;
}

function parseGoogleTokens(data: unknown): GoogleTokens {
  if (!data || typeof data !== "object") throw new AccountError("Google token 端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || !d.access_token) throw new AccountError("Google token 端点没有返回 access_token");
  if (typeof d.expires_in !== "number" || d.expires_in <= 0) throw new AccountError("Google token 端点没有返回有效的 expires_in");
  return { access_token: d.access_token, expires_at: Date.now() + d.expires_in * 1000 };
}

export async function exchangeGoogleCode(opts: {
  client: OAuthClient;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchFn?: FetchFn;
}): Promise<GoogleTokens> {
  if (!opts.client.client_secret) throw new AccountError("Google OAuth 客户端缺少 client_secret（Desktop app 类型需要它）");
  const data = await postForm(
    GOOGLE_TOKEN_URL,
    {
      code: opts.code,
      client_id: opts.client.client_id,
      client_secret: opts.client.client_secret,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
      grant_type: "authorization_code",
    },
    opts.fetchFn ?? (fetch as unknown as FetchFn),
  );
  return parseGoogleTokens(data);
}

export interface GoogleUserinfo {
  sub: string;
  email: string;
  name?: string;
}

export async function fetchGoogleUserinfo(opts: { accessToken: string; fetchFn?: FetchFn }): Promise<GoogleUserinfo> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await fetchFn(GOOGLE_USERINFO_URL, {
      headers: { Authorization: "Bearer " + opts.accessToken },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    throw new AccountError("取 Google 用户信息失败：" + (err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 按错误处理 */
  }
  if (!res.ok) throw new AccountError("取 Google 用户信息失败：HTTP " + String(res.status));
  if (!data || typeof data !== "object") throw new AccountError("Google 用户信息返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.sub !== "string" || !d.sub) throw new AccountError("Google 用户信息没有返回 sub");
  const email = normalizeEmail(d.email);
  if (!email) throw new AccountError("Google 用户信息没有返回有效邮箱");
  // 未验证的邮箱不能建账号（fail-closed）。
  if (d.email_verified !== true) throw new AccountError("该 Google 账号的邮箱尚未验证，不能用来登录");
  return { sub: d.sub, email, ...(typeof d.name === "string" && d.name ? { name: d.name } : {}) };
}

/**
 * 按 provider + sub 或邮箱找到账号，没有就新建；找到就补链身份。
 * 同邮箱链到同一个账号，不建第二个（见 docs/accounts.md §3）。
 * 已停用的账号拒绝登录与绑定（fail-closed：停用就是停用，不留后门）。
 */
export async function upsertAccount(
  home: string,
  provider: AccountProvider,
  identity: { sub: string; email: string; name?: string; issuer?: string },
  opts?: { clock?: () => number; stores?: AccountsStores },
): Promise<Account> {
  const store = opts?.stores?.directory ?? new AccountStore(home, opts);
  const byProvider = await store.findByProvider(provider, identity.sub);
  if (byProvider) {
    if (byProvider.status === "suspended") throw new AccountError("该账号已停用，请联系管理员恢复后再登录");
    await store.touchLastSeen(byProvider.id);
    return store.linkIdentity(byProvider.id, { provider, sub: identity.sub, email: identity.email, ...(identity.name ? { name: identity.name } : {}), ...(identity.issuer ? { issuer: identity.issuer } : {}) });
  }
  const byEmail = await store.findByEmail(identity.email);
  if (byEmail) {
    if (byEmail.status === "suspended") throw new AccountError("该账号已停用，请联系管理员恢复后再登录");
    return store.linkIdentity(byEmail.id, { provider, sub: identity.sub, email: identity.email, ...(identity.name ? { name: identity.name } : {}), ...(identity.issuer ? { issuer: identity.issuer } : {}) });
  }
  const created = await store.create({ email: identity.email, name: identity.name });
  return store.linkIdentity(created.id, { provider, sub: identity.sub, email: identity.email, ...(identity.name ? { name: identity.name } : {}), ...(identity.issuer ? { issuer: identity.issuer } : {}) });
}

/**
 * Google 身份核验（只到取回用户信息为止）：回环回调 → 换 token → 取身份。
 * loginWithGoogle 在此之后建/链账号、发会话；link 流程复用同一段核验。
 */
export async function runGoogleIdentity(opts: {
  client: OAuthClient;
  fetchFn?: FetchFn;
  openUrl?: (url: string) => void | Promise<void>;
}): Promise<GoogleUserinfo> {
  const state = newAuthState();
  const verifier = newCodeVerifier();
  const server = await startLoopbackCallbackServer({ state });
  const authUrl = buildGoogleAuthUrl({
    clientId: opts.client.client_id,
    redirectUri: server.redirectUri,
    state,
    codeChallenge: codeChallengeS256(verifier),
  });
  if (opts.openUrl) {
    try {
      await opts.openUrl(authUrl);
    } catch {
      /* 打不开浏览器不阻塞：调用方已经把链接打印出来了 */
    }
  }
  let code: string;
  try {
    code = await server.waitForCode();
  } finally {
    server.close();
  }
  const tokens = await exchangeGoogleCode({
    client: opts.client,
    code,
    redirectUri: server.redirectUri,
    codeVerifier: verifier,
    fetchFn: opts.fetchFn,
  });
  return fetchGoogleUserinfo({ accessToken: tokens.access_token, fetchFn: opts.fetchFn });
}

/**
 * Google 登录完整链：身份核验 → 建/链账号 → 发会话。
 * openUrl 由调用方给（CLI 里是“打印链接 + 尽力打开浏览器”，打不开不阻塞）；
 * fetchFn 可注入，测试用 stub，不碰真 Google。
 */
export async function loginWithGoogle(opts: {
  home: string;
  client: OAuthClient;
  fetchFn?: FetchFn;
  openUrl?: (url: string) => void | Promise<void>;
  clock?: () => number;
  stores?: AccountsStores;
}): Promise<{ account: Account; session: { id: string; token: string; expires_at: string } }> {
  const info = await runGoogleIdentity({ client: opts.client, fetchFn: opts.fetchFn, openUrl: opts.openUrl });
  const account = await upsertAccount(opts.home, "google", info, { clock: opts.clock, stores: opts.stores });
  const sessions = opts.stores?.sessions ?? new AccountSessionStore(opts.home, { clock: opts.clock });
  const session = await sessions.issue(account.id);
  writeCurrentSession(opts.home, { token: session.token, account_id: account.id, issued_at: new Date().toISOString() });
  const audit = opts.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(opts.home, e));
  await audit({ action: "login", provider: "google", account_id: account.id });
  return { account, session };
}

// ---- GitHub OAuth（设备流：终端给码，浏览器里输码）-------------------

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_USER_EMAILS_URL = "https://api.github.com/user/emails";

export interface GithubDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export async function requestGithubDeviceCode(opts: { clientId: string; fetchFn?: FetchFn }): Promise<GithubDeviceCode> {
  const data = await postForm(
    GITHUB_DEVICE_CODE_URL,
    { client_id: opts.clientId, scope: "read:user user:email" },
    opts.fetchFn ?? (fetch as unknown as FetchFn),
  );
  if (!data || typeof data !== "object") throw new AccountError("GitHub 设备码端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.device_code !== "string" || !d.device_code) throw new AccountError("GitHub 没有返回 device_code");
  if (typeof d.user_code !== "string" || !d.user_code) throw new AccountError("GitHub 没有返回 user_code");
  if (typeof d.verification_uri !== "string" || !d.verification_uri) throw new AccountError("GitHub 没有返回 verification_uri");
  if (typeof d.expires_in !== "number" || d.expires_in <= 0) throw new AccountError("GitHub 没有返回有效的 expires_in");
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    ...(typeof d.verification_uri_complete === "string" && d.verification_uri_complete ? { verification_uri_complete: d.verification_uri_complete } : {}),
    expires_in: d.expires_in,
    interval: typeof d.interval === "number" && d.interval > 0 ? d.interval : 5,
  };
}

/** 轮询设备授权：pending 继续等、slow_down 加间隔、过期/拒绝直接报错。 */
export async function pollGithubAccessToken(opts: {
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  fetchFn?: FetchFn;
  sleepFn?: (ms: number) => Promise<void>;
  clock?: () => number;
}): Promise<string> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const clock = opts.clock ?? (() => Date.now() / 1000);
  const deadline = clock() + opts.expiresInSeconds;
  let interval = Math.max(1, opts.intervalSeconds);
  for (;;) {
    if (clock() >= deadline) throw new AccountError("GitHub 授权超时（设备码已过期），请重新登录");
    let data: unknown;
    try {
      data = await postForm(
        GITHUB_ACCESS_TOKEN_URL,
        {
          client_id: opts.clientId,
          device_code: opts.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        fetchFn,
      );
    } catch (err: unknown) {
      // 设备流轮询里 postForm 抛错只可能是网络/端点问题，不是 pending——直接报。
      throw new AccountError("GitHub 授权轮询失败：" + (err instanceof Error ? err.message : String(err)));
    }
    if (!data || typeof data !== "object") throw new AccountError("GitHub 授权轮询返回了无法识别的内容");
    const d = data as Record<string, unknown>;
    if (typeof d.access_token === "string" && d.access_token) return d.access_token;
    const error = typeof d.error === "string" ? d.error : "";
    if (error === "authorization_pending") {
      await sleep(interval * 1000);
      continue;
    }
    if (error === "slow_down") {
      interval += 5;
      await sleep(interval * 1000);
      continue;
    }
    if (error === "expired_token") throw new AccountError("GitHub 授权超时（设备码已过期），请重新登录");
    if (error === "access_denied") throw new AccountError("GitHub 授权被拒绝");
    throw new AccountError("GitHub 授权失败：" + (error || "未知错误"));
  }
}

export interface GithubUser {
  sub: string;
  email: string;
  name?: string;
}

async function githubGetJson(url: string, accessToken: string, fetchFn: FetchFn): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await fetchFn(url, {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    throw new AccountError("取 GitHub 用户信息失败：" + (err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 按错误处理 */
  }
  if (!res.ok) throw new AccountError("取 GitHub 用户信息失败：HTTP " + String(res.status));
  return data;
}

export async function fetchGithubUser(opts: { accessToken: string; fetchFn?: FetchFn }): Promise<GithubUser> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const data = await githubGetJson(GITHUB_USER_URL, opts.accessToken, fetchFn);
  if (!data || typeof data !== "object") throw new AccountError("GitHub 用户信息返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "number" && typeof d.id !== "string") throw new AccountError("GitHub 用户信息没有返回 id");
  const sub = String(d.id);
  let email = normalizeEmail(d.email);
  if (!email) {
    // 公开邮箱为空时取 /user/emails：只要 primary 且 verified 的那条。
    const emails = await githubGetJson(GITHUB_USER_EMAILS_URL, opts.accessToken, fetchFn);
    if (!Array.isArray(emails)) throw new AccountError("GitHub 没有返回可用的已验证邮箱");
    for (const item of emails) {
      if (item && typeof item === "object") {
        const e = item as Record<string, unknown>;
        if (e.primary === true && e.verified === true) {
          email = normalizeEmail(e.email);
          if (email) break;
        }
      }
    }
  }
  if (!email) throw new AccountError("该 GitHub 账号没有已验证的公开邮箱，不能用来登录");
  return { sub, email, ...(typeof d.name === "string" && d.name ? { name: d.name } : {}), ...(typeof d.login === "string" && d.login && !d.name ? { name: d.login } : {}) };
}

/**
 * GitHub 身份核验（只到取回用户信息为止）：设备码 → 用户在浏览器里输码 →
 * 轮询换 token → 取身份。loginWithGithub 在此之后建/链账号、发会话；
 * link 流程复用同一段核验。
 */
export async function runGithubIdentity(opts: {
  clientId: string;
  fetchFn?: FetchFn;
  sleepFn?: (ms: number) => Promise<void>;
  onUserCode?: (code: GithubDeviceCode) => void | Promise<void>;
  clock?: () => number;
}): Promise<GithubUser> {
  const device = await requestGithubDeviceCode({ clientId: opts.clientId, fetchFn: opts.fetchFn });
  if (opts.onUserCode) await opts.onUserCode(device);
  const accessToken = await pollGithubAccessToken({
    clientId: opts.clientId,
    deviceCode: device.device_code,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
    fetchFn: opts.fetchFn,
    sleepFn: opts.sleepFn,
    clock: opts.clock,
  });
  return fetchGithubUser({ accessToken, fetchFn: opts.fetchFn });
}

/**
 * GitHub 登录完整链：身份核验 → 建/链账号 → 发会话。onUserCode 由调用方给（CLI 里打印码与地址）。
 */
export async function loginWithGithub(opts: {
  home: string;
  clientId: string;
  fetchFn?: FetchFn;
  sleepFn?: (ms: number) => Promise<void>;
  onUserCode?: (code: GithubDeviceCode) => void | Promise<void>;
  clock?: () => number;
  stores?: AccountsStores;
}): Promise<{ account: Account; session: { id: string; token: string; expires_at: string } }> {
  const info = await runGithubIdentity({
    clientId: opts.clientId,
    fetchFn: opts.fetchFn,
    sleepFn: opts.sleepFn,
    onUserCode: opts.onUserCode,
    clock: opts.clock,
  });
  const account = await upsertAccount(opts.home, "github", info, { clock: opts.clock, stores: opts.stores });
  const sessions = opts.stores?.sessions ?? new AccountSessionStore(opts.home, { clock: opts.clock });
  const session = await sessions.issue(account.id);
  writeCurrentSession(opts.home, { token: session.token, account_id: account.id, issued_at: new Date().toISOString() });
  const audit = opts.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(opts.home, e));
  await audit({ action: "login", provider: "github", account_id: account.id });
  return { account, session };
}

// ---- 邮箱 magic link（本批：令牌核心 + 发信接口；兑换端点下一批）-------

/** 发信接口：不假装 Nyra 有发信服务，调用方给一个真的发信方式。 */
export interface MailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

/** 用已授权的 Gmail 连接器发信（GmailMailSender 的 send 适配器）。 */
export function gmailMailSender(sendMail: (opts: { to: string; subject: string; body: string }) => Promise<unknown>): MailSender {
  return {
    async send(to: string, subject: string, body: string): Promise<void> {
      await sendMail({ to, subject, body });
    },
  };
}

export function buildMagicLinkUrl(gatewayUrl: string, token: string): string {
  if (!gatewayUrl.startsWith("http://") && !gatewayUrl.startsWith("https://")) {
    throw new AccountError("网关地址必须是 http:// 或 https:// 开头");
  }
  const base = gatewayUrl.endsWith("/") ? gatewayUrl.slice(0, -1) : gatewayUrl;
  return base + "/api/account/magic-link?token=" + encodeURIComponent(token);
}

/**
 * 发 magic link：签发令牌 → 经 MailSender 发到邮箱。返回的只有令牌 id 与
 * 过期时间，token 原文只进邮件，不返回给调用方。
 */
export async function requestMagicLink(opts: {
  home: string;
  email: string;
  sender: MailSender;
  gatewayUrl: string;
  clock?: () => number;
  stores?: AccountsStores;
}): Promise<{ id: string; expires_at: string }> {
  const store = opts.stores?.magicLinks ?? new MagicLinkStore(opts.home, { clock: opts.clock });
  const issued = await store.issue(opts.email);
  const url = buildMagicLinkUrl(opts.gatewayUrl, issued.token);
  await opts.sender.send(
    normalizeEmail(opts.email) as string,
    "登录 Nyra：点链接完成登录（15 分钟内有效）",
    "点下面的链接完成登录（15 分钟内有效，只能用一次）：\n\n" + url + "\n\n如果你没有请求登录，请忽略这封邮件。",
  );
  const audit = opts.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(opts.home, e));
  await audit({ action: "magic_link_requested", provider: "email" });
  return { id: issued.id, expires_at: issued.expires_at };
}

/** 兑换 magic link：令牌验过 → 建/链账号 → 发会话（兑换端点下一批接网关）。 */
export async function loginWithMagicLink(opts: {
  home: string;
  token: string;
  clock?: () => number;
  stores?: AccountsStores;
}): Promise<{ account: Account; session: { id: string; token: string; expires_at: string } }> {
  const store = opts.stores?.magicLinks ?? new MagicLinkStore(opts.home, { clock: opts.clock });
  const email = await store.redeem(opts.token);
  if (!email) throw new AccountError("magic link 无效、已过期或已用过，请重新请求");
  const account = await upsertAccount(opts.home, "email", { sub: email, email }, { clock: opts.clock, stores: opts.stores });
  const sessions = opts.stores?.sessions ?? new AccountSessionStore(opts.home, { clock: opts.clock });
  const session = await sessions.issue(account.id);
  writeCurrentSession(opts.home, { token: session.token, account_id: account.id, issued_at: new Date().toISOString() });
  const audit = opts.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(opts.home, e));
  await audit({ action: "magic_link_redeemed", provider: "email", account_id: account.id });
  return { account, session };
}
