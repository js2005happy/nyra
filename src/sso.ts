// src/sso.ts — 企业 SSO 登录（缺口 43 第二批，SSO/SCIM）。
//
// 一个 SSO 身份提供方（IdP）= 一个 OIDC issuer：
//   - 注册表 `~/.nyra/sso-providers.json`（0600、原子写、损坏先备份再抛错，
//     与 accounts.ts 同款存储纪律），只存 issuer / client_id / scopes，
//     client_secret 只存密码箱（条目 `sso-client-<id>`），不进配置文件；
//   - 登录走 OIDC 授权码 + PKCE + 回环回调（复用 oauth.ts，与 Google 登录
//     同款流程）：先拉 `/.well-known/openid-configuration` 发现端点，
//     再换码、取 userinfo，email_verified 为 false 直接拒绝（fail-closed）；
//   - 身份链到缺口 41 的账号（provider "sso"，LinkedIdentity.issuer 记 issuer，
//     sub 是 IdP 的 sub；同邮箱链到同一个账号，不建第二个）；
//   - 已停用的账号拒绝登录（upsertAccount 里拦，见 accounts.ts）。
//
// SCIM 账号开通在 src/scim.ts（用户/群组 CRUD + Bearer 鉴权 + 网关挂载），
// CLI 入口统一是 `nyra sso`（`nyra sso scim token` 等）。
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { atomicTmpPath } from "./memory.ts";
import { RunStore } from "./runs.ts";
import {
  AccountError,
  AccountSessionStore,
  appendAccountAudit,
  normalizeEmail,
  nowIso,
  upsertAccount,
  writeCurrentSession,
  type Account,
  type AccountAuditAction,
  type AccountProvider,
  type AccountsStores,
  type OAuthClient,
} from "./accounts.ts";
import { buildAuthUrl, codeChallengeS256, newAuthState, newCodeVerifier, postForm, startLoopbackCallbackServer, type FetchFn } from "./oauth.ts";
import { Vault } from "./vault.ts";
import { emailDomain, findOrgForEmailDomain, type Org } from "./orgs.ts";

export class SsoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsoError";
  }
}

/** SSO 身份提供方注册表文件（0600、原子写）。 */
export const SSO_PROVIDERS_FILE = "sso-providers.json";
/** SSO/SCIM 审计链（append-only jsonl，0600）。 */
export const SSO_AUDIT_FILE = "sso-audit.jsonl";
/** OIDC 发现与 userinfo 请求超时（与 oauth.ts 同口径，30 秒）。 */
export const SSO_REQUEST_TIMEOUT_MS = 30_000;
/** 身份提供方 id：小写字母开头、最长 32 字（与 BotPolicy agent 同口径）。 */
export const SSO_PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** 密码箱条目：SSO 客户端（名字明文、值加密，见 vault.ts）。 */
export const ssoClientEntry = (providerId: string): string => "sso-client-" + providerId;

export interface SsoProvider {
  id: string;
  name: string;
  /** OIDC issuer（https:// 开头，如 https://login.microsoftonline.com/<tenant>/v2.0）。 */
  issuer: string;
  client_id: string;
  scopes: string[];
  created_at: string;
}

export interface SsoProviderRegistry {
  version: 1;
  providers: SsoProvider[];
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

/** 原子写 JSON（0600）：目录 0700、tmp 文件 + rename、写完再 chmod（与 accounts.ts 同款）。 */
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
    throw new SsoError(label + "损坏（已备份到 " + backup + "），请检查后恢复或删除重建");
  }
}

function isProvider(item: unknown): item is SsoProvider {
  return !!item && typeof item === "object" &&
    typeof (item as SsoProvider).id === "string" &&
    typeof (item as SsoProvider).issuer === "string" &&
    typeof (item as SsoProvider).client_id === "string" &&
    Array.isArray((item as SsoProvider).scopes);
}

export function ssoProvidersPath(home: string): string {
  return join(resolveNyraHome(home), SSO_PROVIDERS_FILE);
}

export function loadSsoProviders(home: string): SsoProvider[] {
  const data = readJsonFile<{ providers?: unknown }>(ssoProvidersPath(home), "SSO 身份提供方注册表");
  if (!data) return [];
  const items = Array.isArray(data.providers) ? data.providers : [];
  return items.filter(isProvider);
}

function saveSsoProviders(home: string, providers: SsoProvider[]): void {
  atomicWriteJson(ssoProvidersPath(home), { version: 1, providers });
}

/** issuer 归一：必须是 https:// 开头，去尾斜杠；不接受 query/fragment（不猜、不补）。 */
export function normalizeIssuer(issuer: unknown): string | null {
  if (typeof issuer !== "string") return null;
  const text = issuer.trim().replace(/\/+$/, "");
  if (!text.startsWith("https://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  if (!parsed.hostname) return null;
  return text;
}

/** 注册一个 SSO 身份提供方（client_secret 不进注册表，只存密码箱，调用方负责存）。 */
export function addSsoProvider(
  home: string,
  input: { id: string; issuer: string; client_id: string; name?: string; scopes?: string[] },
  opts?: { clock?: () => number; runId?: string | null },
): SsoProvider {
  if (!SSO_PROVIDER_ID_RE.test(input.id)) throw new SsoError("身份提供方 id 不合法：小写字母开头、字母数字 _ -、最长 32 字");
  const issuer = normalizeIssuer(input.issuer);
  if (!issuer) throw new SsoError("issuer 必须是 https:// 开头的地址（不带 query/fragment）");
  if (!input.client_id.trim()) throw new SsoError("client_id 不能为空");
  const providers = loadSsoProviders(home);
  if (providers.some((p) => p.id === input.id)) throw new SsoError("已存在同 id 的身份提供方（先 remove 再添加）");
  if (providers.some((p) => p.issuer === issuer)) throw new SsoError("已存在同 issuer 的身份提供方");
  const now = nowIso(opts?.clock ? opts.clock() : undefined);
  const provider: SsoProvider = {
    id: input.id,
    name: (input.name ?? "").trim() || input.id,
    issuer,
    client_id: input.client_id.trim(),
    scopes: (input.scopes ?? ["openid", "email", "profile"]).map((s) => s.trim()).filter(Boolean),
    created_at: now,
  };
  if (!provider.scopes.includes("openid")) provider.scopes.unshift("openid");
  providers.push(provider);
  saveSsoProviders(home, providers);
  appendSsoAudit(home, { action: "sso_provider_added", provider_id: provider.id, issuer_hash: shortHash(issuer) });
  mirrorEvent(home, opts?.runId ?? null, "sso_provider_added", { provider_id: provider.id, issuer_hash: shortHash(issuer) });
  return provider;
}

/** 删一个 SSO 身份提供方（注册表 + 密码箱里的客户端一起清；调用方传 vault 时才清密码箱）。 */
export function removeSsoProvider(
  home: string,
  providerId: string,
  opts?: { vault?: Vault | null; runId?: string | null },
): boolean {
  const providers = loadSsoProviders(home);
  const next = providers.filter((p) => p.id !== providerId);
  if (next.length === providers.length) return false;
  saveSsoProviders(home, next);
  if (opts?.vault) {
    try {
      opts.vault.remove(ssoClientEntry(providerId));
    } catch {
      /* 密码箱里没有该条目也不报错 */
    }
  }
  appendSsoAudit(home, { action: "sso_provider_removed", provider_id: providerId });
  mirrorEvent(home, opts?.runId ?? null, "sso_provider_removed", { provider_id: providerId });
  return true;
}

export function getSsoProvider(home: string, providerId: string): SsoProvider | null {
  return loadSsoProviders(home).find((p) => p.id === providerId) ?? null;
}

// ---- O3：按邮箱域名路由到组织与身份提供方 ------------------------------

/**
 * 邮箱 → 组织 → 身份提供方。组织没绑域名返回 null；组织绑了域名但没绑提供方时
 * provider 为 null（调用方提示先绑提供方）。只做路由建议，不拦登录本身。
 */
export function routeSsoForEmail(
  home: string,
  email: string,
): { org: Org; provider: SsoProvider | null } | null {
  const org = findOrgForEmailDomain(home, email);
  if (!org) return null;
  return { org, provider: org.sso_provider ? getSsoProvider(home, org.sso_provider) : null };
}

// ---- SSO/SCIM 审计与事件镜像 ------------------------------------------

/** SSO/SCIM 审计动作（只记动作、账号 id、外部标识、issuer 指纹，不记邮箱、不记 token、不记 secret）。 */
export type SsoAuditAction =
  | "sso_login"
  | "sso_provider_added"
  | "sso_provider_removed"
  | "scim_user_created"
  | "scim_user_updated"
  | "scim_user_deactivated"
  | "scim_user_reactivated"
  | "scim_user_deleted"
  | "scim_group_created"
  | "scim_group_updated"
  | "scim_group_deleted"
  | "scim_token_issued"
  | "scim_token_revoked";

/** 审计链：append-only jsonl，0600。写失败不抛错（审计丢了不该拦住正事），但返回 false。 */
export function appendSsoAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(resolveNyraHome(home), SSO_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: nowIso(), ...entry });
    appendFileSync(path, line + "\n", { encoding: "utf-8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 有运行上下文时，把 SSO/SCIM 事件镜像进运行事件（tasks 目录优先，runs 次之；与 governance.ts 同款）。 */
export function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
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

// ---- OIDC 发现与 userinfo ----------------------------------------------

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

async function fetchJson(
  url: string,
  fetchFn: FetchFn,
  timeoutMs: number = SSO_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (!url.startsWith("https://")) throw new SsoError("只接受 https:// 的端点（" + url.slice(0, 60) + "）");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    throw new SsoError("请求失败：" + (err instanceof Error ? err.message : String(err)));
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
  if (!res.ok) throw new SsoError("请求失败：HTTP " + String(res.status));
  if (!data || typeof data !== "object") throw new SsoError("端点返回了无法识别的内容");
  return data;
}

/**
 * OIDC 发现：拉 `/.well-known/openid-configuration`，校验返回的 issuer 与
 * 注册的一致、三个端点都是 https——不一致直接拒绝，不猜、不补。
 */
export async function discoverProvider(issuer: string, fetchFn?: FetchFn): Promise<OidcDiscovery> {
  const normalized = normalizeIssuer(issuer);
  if (!normalized) throw new SsoError("issuer 必须是 https:// 开头的地址");
  const fn = fetchFn ?? (fetch as unknown as FetchFn);
  const data = await fetchJson(normalized + "/.well-known/openid-configuration", fn) as Record<string, unknown>;
  if (data.issuer !== normalized) throw new SsoError("发现文档的 issuer 与注册的不一致（可能是冒充的发现端点），拒绝继续");
  for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"] as const) {
    if (typeof data[key] !== "string" || !(data[key] as string).startsWith("https://")) {
      throw new SsoError("发现文档没有返回有效的 " + key);
    }
  }
  return {
    issuer: normalized,
    authorization_endpoint: data.authorization_endpoint as string,
    token_endpoint: data.token_endpoint as string,
    userinfo_endpoint: data.userinfo_endpoint as string,
  };
}

export interface SsoUserinfo {
  sub: string;
  email: string;
  name?: string;
}

/** 取 OIDC userinfo：只要 sub + 已验证邮箱；未验证的邮箱不能建账号（fail-closed）。 */
export async function fetchSsoUserinfo(opts: { userinfoEndpoint: string; accessToken: string; fetchFn?: FetchFn }): Promise<SsoUserinfo> {
  const fn = opts.fetchFn ?? (fetch as unknown as FetchFn);
  const data = await fetchJson(opts.userinfoEndpoint, async (url: string, init?: Record<string, unknown>) => {
    return fn(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: "Bearer " + opts.accessToken } });
  }) as Record<string, unknown>;
  if (typeof data.sub !== "string" || !data.sub) throw new SsoError("userinfo 没有返回 sub");
  const email = normalizeEmail(data.email);
  if (!email) throw new SsoError("userinfo 没有返回有效邮箱");
  if (data.email_verified !== true) throw new SsoError("该 SSO 账号的邮箱尚未验证，不能用来登录");
  return { sub: data.sub, email, ...(typeof data.name === "string" && data.name ? { name: data.name } : {}) };
}

function buildSsoAuthUrl(opts: { authorizationEndpoint: string; clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes: string[] }): string {
  return buildAuthUrl(opts.authorizationEndpoint, {
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
  });
}

async function exchangeSsoCode(opts: {
  tokenEndpoint: string;
  client: OAuthClient;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchFn?: FetchFn;
}): Promise<string> {
  if (!opts.client.client_secret) throw new SsoError("SSO 客户端缺少 client_secret（机密客户端需要它）");
  const data = await postForm(
    opts.tokenEndpoint,
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
  if (!data || typeof data !== "object") throw new SsoError("token 端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || !d.access_token) throw new SsoError("token 端点没有返回 access_token");
  return d.access_token;
}

/**
 * SSO 身份核验（只到取回用户信息为止）：发现 → 回环回调 → 换 token → 取身份。
 * loginWithSso 在此之后建/链账号、发会话。
 */
export async function runSsoIdentity(opts: {
  provider: SsoProvider;
  client: OAuthClient;
  fetchFn?: FetchFn;
  openUrl?: (url: string) => void | Promise<void>;
}): Promise<SsoUserinfo & { issuer: string }> {
  const discovery = await discoverProvider(opts.provider.issuer, opts.fetchFn);
  const state = newAuthState();
  const verifier = newCodeVerifier();
  const server = await startLoopbackCallbackServer({ state });
  const authUrl = buildSsoAuthUrl({
    authorizationEndpoint: discovery.authorization_endpoint,
    clientId: opts.client.client_id,
    redirectUri: server.redirectUri,
    state,
    codeChallenge: codeChallengeS256(verifier),
    scopes: opts.provider.scopes,
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
  const accessToken = await exchangeSsoCode({
    tokenEndpoint: discovery.token_endpoint,
    client: opts.client,
    code,
    redirectUri: server.redirectUri,
    codeVerifier: verifier,
    fetchFn: opts.fetchFn,
  });
  const info = await fetchSsoUserinfo({ userinfoEndpoint: discovery.userinfo_endpoint, accessToken, fetchFn: opts.fetchFn });
  return { ...info, issuer: discovery.issuer };
}

/**
 * SSO 登录完整链：身份核验 → 建/链账号（provider "sso"，issuer 记在身份上）→ 发会话。
 * openUrl 由调用方给（CLI 里是“打印链接 + 尽力打开浏览器”，打不开不阻塞）；
 * fetchFn 可注入，测试用 stub，不碰真 IdP。
 */
export async function loginWithSso(opts: {
  home: string;
  provider: SsoProvider;
  client: OAuthClient;
  fetchFn?: FetchFn;
  openUrl?: (url: string) => void | Promise<void>;
  clock?: () => number;
  stores?: AccountsStores;
  runId?: string | null;
}): Promise<{ account: Account; session: { id: string; token: string; expires_at: string } }> {
  const info = await runSsoIdentity({ provider: opts.provider, client: opts.client, fetchFn: opts.fetchFn, openUrl: opts.openUrl });
  const account = await upsertAccount(opts.home, "sso", { sub: info.sub, email: info.email, ...(info.name ? { name: info.name } : {}), issuer: info.issuer }, { clock: opts.clock, stores: opts.stores });
  const sessions = opts.stores?.sessions ?? new AccountSessionStore(opts.home, { clock: opts.clock });
  const session = await sessions.issue(account.id);
  writeCurrentSession(opts.home, { token: session.token, account_id: account.id, issued_at: new Date().toISOString() });
  const audit = opts.stores?.audit ?? ((e: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }) => appendAccountAudit(opts.home, e));
  await audit({ action: "login", provider: "sso", account_id: account.id });
  appendSsoAudit(opts.home, { action: "sso_login", account_id: account.id, provider_id: opts.provider.id, issuer_hash: shortHash(info.issuer) });
  mirrorEvent(opts.home, opts.runId ?? null, "sso_login", { account_id: account.id, issuer_hash: shortHash(info.issuer) });
  return { account, session };
}

// ---- CLI：nyra sso ------------------------------------------------------

function ssoUsage(): string {
  return (
    "用法：nyra sso <provider|login|route|status|scim> [选项]\n" +
    "  nyra sso provider add --id <id> --issuer <issuer> --client-id <id> [--name <名>] [--scopes <a,b>]  注册 SSO 身份提供方（client_secret 交互输入，只存密码箱）\n" +
    "  nyra sso provider list              列出已注册的身份提供方\n" +
    "  nyra sso provider remove <id> [--yes]  移除身份提供方（注册表 + 密码箱客户端一起清）\n" +
    "  nyra sso login <id>                 用该身份提供方登录（OIDC 授权码 + PKCE + 回环回调）\n" +
    "  nyra sso route <邮箱>               按邮箱域名看该走哪个身份提供方登录（组织绑定的域名路由）\n" +
    "  nyra sso status                     当前 SSO 配置与登录状态\n" +
    "  nyra sso scim token [--yes]         签发 SCIM Bearer token（只显示一次，只存 SHA-256）\n" +
    "  nyra sso scim revoke-token          吊销 SCIM Bearer token\n" +
    "  nyra sso scim status                SCIM 端点与 token 状态\n" +
    "（详见 docs/sso.md；SCIM 端点挂在网关上：/scim/v2/Users、/scim/v2/Groups）\n"
  );
}

function readFlag(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

export async function handleSso(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(ssoUsage());
    return 0;
  }

  const ask = async (prompt: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
    });
    return answer;
  };
  const unlockVault = async (): Promise<Vault | null> => {
    const vault = new Vault(join(home, "vault.json"));
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return null;
    }
    const password = process.env.NYRA_VAULT_PASSWORD;
    if (!password) {
      const input = await ask("密码箱主密码：");
      if (!input) {
        process.stderr.write("需要密码箱主密码才能读客户端\n");
        return null;
      }
      try {
        vault.unlock(input);
      } catch {
        process.stderr.write("密码箱密码不对\n");
        return null;
      }
      return vault;
    }
    try {
      vault.unlock(password);
    } catch {
      process.stderr.write("密码箱密码不对（NYRA_VAULT_PASSWORD）\n");
      return null;
    }
    return vault;
  };
  const openAuthUrl = async (url: string): Promise<void> => {
    process.stdout.write("请在浏览器里打开下面的链接完成授权：\n" + url + "\n");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      const child = spawn(opener, args, { detached: true, stdio: "ignore" });
      child.unref();
    } catch {
      /* 打不开浏览器不阻塞：链接已经打印出来了 */
    }
  };
  const readSsoClient = async (vault: Vault, provider: SsoProvider): Promise<OAuthClient | null> => {
    const raw = vault.get(ssoClientEntry(provider.id));
    if (raw) {
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        if (typeof d.client_id === "string" && d.client_id && typeof d.client_secret === "string" && d.client_secret) {
          return { client_id: d.client_id, client_secret: d.client_secret };
        }
      } catch {
        /* 损坏的客户端条目按没有处理，下面重新输入 */
      }
    }
    process.stdout.write("第一次用这个身份提供方登录需要它的 OAuth 客户端（机密客户端）：\n");
    process.stdout.write("  在 IdP 的应用管理里建好 OIDC 应用后，把 client_id 与 client_secret 粘贴进来（只存密码箱，不进配置文件）。\n");
    const clientId = (await ask("client_id：")).trim();
    const clientSecret = (await ask("client_secret：")).trim();
    if (!clientId || !clientSecret) {
      process.stderr.write("client_id 与 client_secret 不能为空\n");
      return null;
    }
    const client = { client_id: clientId, client_secret: clientSecret };
    vault.add(ssoClientEntry(provider.id), JSON.stringify(client), true);
    return client;
  };

  if (cmd === "provider") {
    const sub = argv[1];
    if (sub === "add") {
      const id = readFlag(argv, "--id");
      const issuer = readFlag(argv, "--issuer");
      const clientId = readFlag(argv, "--client-id");
      const name = readFlag(argv, "--name");
      const scopesRaw = readFlag(argv, "--scopes");
      if (!id || !issuer || !clientId) {
        process.stderr.write("用法：nyra sso provider add --id <id> --issuer <issuer> --client-id <id> [--name <名>] [--scopes <a,b>]\n");
        return 2;
      }
      try {
        const provider = addSsoProvider(home, {
          id,
          issuer,
          client_id: clientId,
          ...(name ? { name } : {}),
          ...(scopesRaw ? { scopes: scopesRaw.split(",") } : {}),
        });
        process.stdout.write(`已注册身份提供方：${provider.id}（${provider.name}，${provider.issuer}）\n`);
        process.stdout.write("下一步：nyra sso login " + provider.id + "（首次登录时会问 client_secret，只存密码箱）\n");
        return 0;
      } catch (err) {
        process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
        return 1;
      }
    }
    if (sub === "list") {
      const providers = loadSsoProviders(home);
      if (!providers.length) {
        process.stdout.write("还没有注册身份提供方（nyra sso provider add --issuer <issuer> --client-id <id>）\n");
        return 0;
      }
      for (const p of providers) {
        process.stdout.write(`- ${p.id}（${p.name}）：${p.issuer}，scopes ${p.scopes.join(",")}，创建于 ${p.created_at}\n`);
      }
      return 0;
    }
    if (sub === "remove") {
      const id = argv[2];
      if (!id) {
        process.stderr.write("用法：nyra sso provider remove <id> [--yes]\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        const answer = (await ask(`确定移除身份提供方 ${id} 吗（注册表 + 密码箱客户端一起清）？[y/N] `)).trim().toLowerCase();
        if (answer !== "y") {
          process.stdout.write("已取消\n");
          return 0;
        }
      }
      const vault = await unlockVault();
      const removed = removeSsoProvider(home, id, { vault });
      if (!removed) {
        process.stderr.write("没有这个身份提供方：" + id + "\n");
        return 1;
      }
      process.stdout.write(`已移除身份提供方：${id}\n`);
      return 0;
    }
    process.stdout.write(ssoUsage());
    return 2;
  }

  if (cmd === "login") {
    const id = argv[1];
    if (!id) {
      process.stderr.write("用法：nyra sso login <身份提供方 id>\n");
      return 2;
    }
    const provider = getSsoProvider(home, id);
    if (!provider) {
      process.stderr.write("没有这个身份提供方：" + id + "（先 nyra sso provider add 注册）\n");
      return 1;
    }
    const vault = await unlockVault();
    if (!vault) return 1;
    const client = await readSsoClient(vault, provider);
    if (!client) return 1;
    try {
      const { account } = await loginWithSso({ home, provider, client, openUrl: openAuthUrl });
      process.stdout.write(`登录成功：${account.email}（${account.role === "owner" ? "机主" : "普通用户"}，经 ${provider.name}）\n`);
      return 0;
    } catch (err) {
      if (err instanceof AccountError || err instanceof SsoError) {
        process.stderr.write(err.message + "\n");
        return 1;
      }
      throw err;
    }
  }

  if (cmd === "route") {
    const email = argv[1];
    if (!email || !emailDomain(email)) {
      process.stderr.write("用法：nyra sso route <邮箱>（按邮箱域名看该走哪个身份提供方登录）\n");
      return 2;
    }
    const routed = routeSsoForEmail(home, email);
    if (!routed) {
      process.stdout.write("这个邮箱域名没有绑定任何组织：走默认登录（nyra account login）。\n");
      return 0;
    }
    const { org, provider } = routed;
    process.stdout.write(`邮箱域名属于组织「${org.name}」${org.require_sso ? "（强制 SSO）" : "（未强制 SSO，建议走 SSO）"}\n`);
    if (provider) {
      process.stdout.write(`身份提供方：${provider.name}（${provider.id}，${provider.issuer}）\n`);
      process.stdout.write(`登录：nyra sso login ${provider.id}\n`);
    } else {
      process.stdout.write("该组织还没绑定身份提供方：先让组织管理员跑 nyra org sso <组织> on --provider <id> 绑定。\n");
    }
    return 0;
  }

  if (cmd === "status") {
    const providers = loadSsoProviders(home);
    process.stdout.write(`已注册身份提供方：${providers.length} 个\n`);
    for (const p of providers) {
      process.stdout.write(`- ${p.id}（${p.name}）：${p.issuer}\n`);
    }
    const { getCurrentAccount } = await import("./accounts.ts");
    const account = await getCurrentAccount(home);
    if (!account) {
      process.stdout.write("当前未登录\n");
    } else {
      const ssoIdentity = account.providers.find((p) => p.provider === "sso");
      process.stdout.write(`当前登录：${account.email}（${account.role === "owner" ? "机主" : "普通用户"}${ssoIdentity ? "，经 SSO（" + (ssoIdentity.issuer ?? "未知 IdP") + "）" : ""}）\n`);
    }
    const { scimTokenConfigured } = await import("./scim.ts");
    process.stdout.write(`SCIM Bearer token：${scimTokenConfigured(home) ? "已签发（网关 /scim/v2 可用）" : "未签发（nyra sso scim token）"}\n`);
    return 0;
  }

  if (cmd === "scim") {
    const sub = argv[1];
    const scim = await import("./scim.ts");
    if (sub === "token") {
      if (scim.scimTokenConfigured(home) && !argv.includes("--yes")) {
        process.stderr.write("SCIM token 已存在，重新签发会让旧 token 立即失效；确认请加 --yes\n");
        return 2;
      }
      const { token } = scim.issueScimToken(home);
      appendSsoAudit(home, { action: "scim_token_issued" });
      process.stdout.write("SCIM Bearer token（只显示这一次，请立刻交给 IdP，Nyra 只存 SHA-256）：\n" + token + "\n");
      process.stdout.write("网关端点：/scim/v2/Users、/scim/v2/Groups（Authorization: Bearer <token>）\n");
      return 0;
    }
    if (sub === "revoke-token") {
      const revoked = scim.revokeScimToken(home);
      if (!revoked) {
        process.stdout.write("没有已签发的 SCIM token\n");
        return 0;
      }
      appendSsoAudit(home, { action: "scim_token_revoked" });
      process.stdout.write("SCIM token 已吊销（旧 token 立即失效）\n");
      return 0;
    }
    if (sub === "status") {
      process.stdout.write(`SCIM Bearer token：${scim.scimTokenConfigured(home) ? "已签发" : "未签发（nyra sso scim token）"}\n`);
      process.stdout.write("端点（挂在网关上）：GET /scim/v2/ServiceProviderConfig、/scim/v2/Users、/scim/v2/Groups\n");
      return 0;
    }
    process.stdout.write(ssoUsage());
    return 2;
  }

  process.stdout.write(ssoUsage());
  return 2;
}
