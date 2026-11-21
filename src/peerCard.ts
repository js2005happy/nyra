// src/peerCard.ts — 缺口 38：Agent 名片与加好友握手（扩展缺口 12）。
//
// 名片是 A2A 风格的 Agent Card：名字、描述、技能、端点、鉴权方式。
// 名片内容由 Soul（缺口 28）与对外 MCP 服务的工具清单如实生成，不编造
// 没有的能力；对外 MCP 服务的写工具只在 allow_writes 开启时才出现在
// 名片里（NyraMcpServer.tools() 本来就这么过滤）。
//
// 加好友 = 双向批准（报告 §4.1 的流程，各在自家机器上批）：
//   A 发请求（nyra peer add）→ B 的主人收到请求（nyra peer request，
//   须带双方人工比对过的好友码）→ B 批准（nyra peer accept）→
//   B 回发请求 → A 批准 → 双方互认。任何一侧都可随时单方拉黑 / 删除。
// 好友关系默认只读：能看你明确分享的任务产物，不能读记忆、文件、密钥。
//
// 安全边界（与缺口 12 同款 fail-closed）：
// - 对方名片是不可信输入：先过严格的格式校验（类型、长度、上限），
//   再进好友账本；校验不过直接拒绝，不存半截数据；
// - 好友码是双方人工比对的共享口令：账本与事件里只记 SHA-256 前 12 位
//   指纹，绝不记码本身；码 24 小时过期，过期自动换新；
// - 好友账本（~/.nyra/friends.json）与好友码（~/.nyra/friend-codes.json）
//   都是原子写 0600，损坏先备份再抛错；
// - 名片发布默认关闭：网关 GET /.well-known/agent-card.json 在
//   peer_card.publish 开启后才回名片，否则当不存在（404），不泄露端点；
// - 共享只走任务产物：复用缺口 12 的交接包（buildHandoffPackage），
//   只含任务、已验证结论、步骤、待办、证据摘要，不含令牌、密码、
//   绝对路径与完整对话历史；分享须过独立审查层（peer_handoff 同款门）；
// - 好友请求 / 批准 / 拒绝 / 拉黑 / 删除都进三处审计：对端审计
//   （peer-audit.jsonl）、运行事件（friend_*，只记对端名与指纹）。
import { randomBytes, createHash} from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync} from "node:fs";
import { join} from "node:path";
import { loadConfig, saveConfig, VERSION} from "./config.ts";
import { MCP_SERVER_TOOLS} from "./mcp.ts";
import { resolveNyraHome} from "./memory.ts";
import { appendPeerAudit, handoffPeer, peerConfig, PEER_NAME_RE, HANDOFF_DEFAULT_FIELDS, type HandoffField, type PeerCallDeps, type PeerEntry} from "./peer.ts";
import { RunStore} from "./runs.ts";
import { loadSoul, resolveSoulAgentId} from "./soul.ts";

export const PEER_CARD_PATH = "/.well-known/agent-card.json";
export const FRIENDS_FILE = "friends.json";
export const FRIEND_CODES_FILE = "friend-codes.json";
export const FRIEND_CODE_TTL_MS = 24 * 3600 * 1000;
export const CARD_MAX_BYTES = 65536;
export const FRIEND_CODE_RE = /^NYR-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const CIRCLE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
export const FRIEND_TIERS = ["readonly", "propose"] as const;
export type FriendTier = (typeof FRIEND_TIERS)[number];

/** `nyra peer` 下归名片加好友管的子命令（cli.ts 分发用）。 */
export const PEER_FRIEND_COMMANDS: readonly string[] = [
  "card", "code", "publish", "add", "request", "accept", "decline",
  "friends", "friend", "block", "unblock", "remove", "circle", "share",
];

export class PeerCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerCardError";
  }
}

// ---------------------------------------------------------------------------
// 名片
// ---------------------------------------------------------------------------

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string | null;
  version: string;
  skills: AgentCardSkill[];
  authentication: { schemes: string[] };
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  endpoints: { mcp: string | null };
}

export interface PeerCardConfig {
  /** 名片发布开关：默认关；关时网关的 well-known 路径当不存在（404）。 */
  publish: boolean;
  /** 对外公开的网关根地址（如 https://nyra.example.com）；不配时名片里 url 为 null。 */
  publicUrl: string | null;
}

/** config.json 的 peer_card 一节（默认全关；public_url 只认 http/https）。 */
export function peerCardConfig(config: Record<string, unknown>): PeerCardConfig {
  const raw = (config.peer_card ?? {}) as Record<string, unknown>;
  let publicUrl: string | null = null;
  if (typeof raw.public_url === "string" && raw.public_url.trim()) {
    const u = raw.public_url.trim();
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http/https");
      publicUrl = u.replace(/\/+$/, "");
    } catch {
      process.stderr.write("peer_card.public_url 必须是 http:// 或 https:// 开头的地址，已忽略\n");
    }
  }
  return { publish: raw.publish === true, publicUrl };
}

/** 本 agent 的名片：名字与描述取 Soul 身份，技能取对外 MCP 服务的工具清单。 */
export function buildAgentCard(home: string, config: Record<string, unknown>, agent?: string): AgentCard {
  const agentId = agent ?? resolveSoulAgentId(config);
  const soul = loadSoul(home, agentId);
  const name = soul.identity.name.trim() || "Nyra";
  const persona = soul.identity.persona.trim();
  const goal = soul.identity.goal.trim();
  const description = [persona, goal].filter(Boolean).join(" ") || "Nyra agent";
  const cardCfg = peerCardConfig(config);
  const skills: AgentCardSkill[] = MCP_SERVER_TOOLS.map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description,
  }));
  return {
    name,
    description,
    url: cardCfg.publicUrl,
    version: VERSION,
    skills,
    authentication: { schemes: ["bearer"] },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    endpoints: { mcp: cardCfg.publicUrl ? `${cardCfg.publicUrl}/mcp` : null },
  };
}

/** 名片指纹：SHA-256 前 12 位（账本与事件里只记指纹，不记名片原文）。 */
export function cardHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function strField(o: Record<string, unknown>, key: string, max: number, required: boolean): string | null {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new PeerCardError(`名片缺字段：${key}`);
    return null;
  }
  if (typeof v !== "string") throw new PeerCardError(`名片字段 ${key} 必须是字符串`);
  if (v.length > max) throw new PeerCardError(`名片字段 ${key} 太长（最多 ${max} 字）`);
  return v;
}

/** 严格校验一张对方名片（不可信输入）：类型、长度、上限逐项验，不过直接拒绝。 */
export function parseAgentCard(raw: unknown): AgentCard {
  if (!isPlainObject(raw)) throw new PeerCardError("名片必须是 JSON 对象");
  const name = strField(raw, "name", 64, true);
  if (!name || !name.trim()) throw new PeerCardError("名片的 name 不能为空");
  const description = strField(raw, "description", 500, true) ?? "";
  const version = strField(raw, "version", 32, false) ?? "";
  const urlRaw = raw.url;
  let url: string | null = null;
  if (urlRaw !== undefined && urlRaw !== null) {
    if (typeof urlRaw !== "string") throw new PeerCardError("名片的 url 必须是字符串或 null");
    if (urlRaw.length > 500) throw new PeerCardError("名片的 url 太长");
    try {
      const u = new URL(urlRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http/https");
    } catch {
      throw new PeerCardError("名片的 url 必须是 http:// 或 https:// 开头的地址");
    }
    url = urlRaw;
  }
  const skillsRaw = raw.skills;
  if (!Array.isArray(skillsRaw)) throw new PeerCardError("名片的 skills 必须是列表");
  if (skillsRaw.length > 50) throw new PeerCardError("名片的 skills 最多 50 项");
  const skills: AgentCardSkill[] = [];
  for (const s of skillsRaw) {
    if (!isPlainObject(s)) throw new PeerCardError("名片的 skill 必须是对象");
    const id = strField(s, "id", 64, true);
    const sname = strField(s, "name", 64, true);
    const desc = strField(s, "description", 500, false) ?? "";
    if (!id || !sname) throw new PeerCardError("名片的 skill 缺 id 或 name");
    skills.push({ id, name: sname, description: desc });
  }
  const authRaw = raw.authentication;
  let schemes: string[] = ["bearer"];
  if (authRaw !== undefined && authRaw !== null) {
    if (!isPlainObject(authRaw) || !Array.isArray(authRaw.schemes)) {
      throw new PeerCardError("名片的 authentication.schemes 必须是字符串列表");
    }
    schemes = [];
    for (const s of authRaw.schemes) {
      if (typeof s !== "string" || !s.trim() || s.length > 32) {
        throw new PeerCardError("名片的 authentication.schemes 只能是非空短字符串");
      }
      schemes.push(s);
    }
    if (!schemes.length) throw new PeerCardError("名片的 authentication.schemes 不能为空");
  }
  const endpointsRaw = raw.endpoints;
  let mcp: string | null = null;
  if (endpointsRaw !== undefined && endpointsRaw !== null) {
    if (!isPlainObject(endpointsRaw)) throw new PeerCardError("名片的 endpoints 必须是对象");
    if (endpointsRaw.mcp !== undefined && endpointsRaw.mcp !== null) {
      if (typeof endpointsRaw.mcp !== "string" || endpointsRaw.mcp.length > 500) {
        throw new PeerCardError("名片的 endpoints.mcp 必须是字符串或 null");
      }
      mcp = endpointsRaw.mcp;
    }
  }
  return {
    name: name.trim(),
    description,
    url,
    version,
    skills,
    authentication: { schemes },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    endpoints: { mcp },
  };
}

export interface CardFetchDeps {
  fetchFn?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/** 从对方网关拉名片：GET <源站>/.well-known/agent-card.json（10 秒超时，64KB 上限）。 */
export async function fetchAgentCard(url: string, deps?: CardFetchDeps): Promise<{ card: AgentCard; hash: string }> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new PeerCardError(`对方地址无效：${url}`);
  }
  const target = `${origin}${PEER_CARD_PATH}`;
  const fn = deps?.fetchFn ?? (async (u: string) => {
    const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  });
  let text: string;
  let status = 0;
  try {
    const res = await fn(target);
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw new PeerCardError(`拉对方名片失败（${target}）：${err instanceof Error ? err.message : String(err)}`);
  }
  if (status !== 200) throw new PeerCardError(`对方名片拉不到（${target} 返回 ${status}）：对方可能没开名片发布（nyra peer card publish on）`);
  if (text.length > CARD_MAX_BYTES) throw new PeerCardError(`对方名片太大（超过 ${CARD_MAX_BYTES} 字节），拒绝`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PeerCardError("对方名片不是合法 JSON");
  }
  const card = parseAgentCard(parsed);
  return { card, hash: cardHash(text) };
}

// ---------------------------------------------------------------------------
// 好友账本与好友码（原子写 0600，损坏先备份再抛错）
// ---------------------------------------------------------------------------

export type FriendOutbound = "none" | "sent";
export type FriendInbound = "none" | "pending" | "accepted" | "declined";

export interface FriendEntry {
  name: string;
  url: string;
  card_hash: string;
  circle: string;
  tier: FriendTier;
  outbound: FriendOutbound;
  inbound: FriendInbound;
  blocked: boolean;
  code_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface FriendCircle {
  name: string;
  created_at: string;
}

export interface FriendBook {
  version: 1;
  friends: FriendEntry[];
  circles: FriendCircle[];
}

export interface FriendCodeRecord {
  code: string;
  created_at: string;
  expires_at: string;
}

function friendsPath(home: string): string {
  return join(resolveNyraHome(home), FRIENDS_FILE);
}

function friendCodesPath(home: string): string {
  return join(resolveNyraHome(home), FRIEND_CODES_FILE);
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

function readJsonFile<T>(home: string, filename: string): T | null {
  const path = join(resolveNyraHome(home), filename);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new PeerCardError(`${filename} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  return parsed as T;
}

export function loadFriendBook(home: string): FriendBook {
  const raw = readJsonFile<FriendBook>(home, FRIENDS_FILE);
  if (!raw) return { version: 1, friends: [], circles: [] };
  if (!isPlainObject(raw) || !Array.isArray(raw.friends) || !Array.isArray(raw.circles)) {
    throw new PeerCardError(`${FRIENDS_FILE} 结构不对（须含 friends 与 circles 两个列表）`);
  }
  return { version: 1, friends: raw.friends as FriendEntry[], circles: raw.circles as FriendCircle[] };
}

export function saveFriendBook(home: string, book: FriendBook): void {
  writeJsonAtomic(home, FRIENDS_FILE, JSON.stringify(book, null, 2) + "\n");
}

export function findFriend(book: FriendBook, name: string): FriendEntry | null {
  return book.friends.find((f) => f.name === name) ?? null;
}

export function listCircles(book: FriendBook): string[] {
  return ["default", ...book.circles.map((c) => c.name)];
}

/** 好友状态（展示用）：拉黑 > 已接受（双向/单向）> 待批准 > 已拒绝 > 已发请求。 */
export function friendStatus(entry: FriendEntry): string {
  if (entry.blocked) return "已拉黑";
  if (entry.inbound === "accepted" && entry.outbound === "sent") return "好友（双向）";
  if (entry.inbound === "accepted") return "好友";
  if (entry.inbound === "pending") return "待批准（对方已发请求）";
  if (entry.inbound === "declined") return "已拒绝";
  if (entry.outbound === "sent") return "已发请求（等对方批准）";
  return "未知";
}

/** 是不是好友：对方的请求已被我批准、且没拉黑（单向接受即好友；双向看 friendStatus）。 */
export function isFriend(entry: FriendEntry): boolean {
  return entry.inbound === "accepted" && !entry.blocked;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newFriendCode(): string {
  const bytes = randomBytes(8);
  const group = (off: number): string => {
    let s = "";
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[bytes[off + i] % CODE_ALPHABET.length];
    return s;
  };
  return `NYR-${group(0)}-${group(4)}`;
}

/** 我的好友码（24 小时有效；过期自动换新；码本身只存在本机 0600 文件里）。 */
export function getFriendCode(home: string): FriendCodeRecord {
  const raw = readJsonFile<FriendCodeRecord>(home, FRIEND_CODES_FILE);
  if (raw && typeof raw.code === "string" && FRIEND_CODE_RE.test(raw.code)
    && typeof raw.expires_at === "string" && Date.parse(raw.expires_at) > Date.now()) {
    return raw;
  }
  return regenerateFriendCode(home);
}

export function regenerateFriendCode(home: string): FriendCodeRecord {
  const now = Date.now();
  const rec: FriendCodeRecord = {
    code: newFriendCode(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + FRIEND_CODE_TTL_MS).toISOString(),
  };
  writeJsonAtomic(home, FRIEND_CODES_FILE, JSON.stringify(rec, null, 2) + "\n");
  recordFriendEvent(home, "friend_code_regenerated", { code_hash: cardHash(rec.code) });
  return rec;
}

// ---------------------------------------------------------------------------
// 证据运行（与 peer.ts 同款：好友操作单独建一条只记 friend_* 事件的运行）
// ---------------------------------------------------------------------------

function recordFriendEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`好友：${type}`, "peer-card", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

function requirePeersEnabled(config: Record<string, unknown>): void {
  if (!peerConfig(config).enabled) {
    throw new PeerCardError("对端协作未开启：先运行 nyra peer enable（默认关闭，显式 opt-in）");
  }
}

function validatePeerUrl(url: string): string {
  const u = url.trim();
  if (!u) throw new PeerCardError("对方地址不能为空");
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http/https");
  } catch {
    throw new PeerCardError("对方地址必须是 http:// 或 https:// 开头的地址");
  }
  return u;
}

function nowIso(): string {
  return new Date().toISOString();
}

function touch(entry: FriendEntry): void {
  entry.updated_at = nowIso();
}

// ---------------------------------------------------------------------------
// 握手：发请求 / 收请求 / 批准 / 拒绝
// ---------------------------------------------------------------------------

/** 发好友请求（只记在我方账本里，不直接通知对方——对方须在自己那边走 request + accept）。 */
export async function addFriendRequest(home: string, config: Record<string, unknown>, opts: {
  name: string;
  url: string;
  code?: string | null;
  fetchDeps?: CardFetchDeps;
}): Promise<{ entry: FriendEntry; card: AgentCard }> {
  requirePeersEnabled(config);
  if (!PEER_NAME_RE.test(opts.name)) throw new PeerCardError(`好友名字只认字母数字、下划线或连字符（最多 32 字），当前是 ${JSON.stringify(opts.name)}`);
  const url = validatePeerUrl(opts.url);
  let codeHash: string | null = null;
  if (opts.code !== undefined && opts.code !== null && opts.code !== "") {
    if (!FRIEND_CODE_RE.test(opts.code.trim())) throw new PeerCardError("好友码格式不对（应为 NYR-XXXX-XXXX）");
    codeHash = cardHash(opts.code.trim());
  }
  const { card, hash } = await fetchAgentCard(url, opts.fetchDeps);
  const book = loadFriendBook(home);
  let entry = findFriend(book, opts.name);
  if (entry && entry.blocked) throw new PeerCardError(`${opts.name} 已拉黑：先取消拉黑再发请求（nyra peer unblock ${opts.name}）`);
  if (!entry) {
    entry = {
      name: opts.name, url, card_hash: hash, circle: "default", tier: "readonly",
      outbound: "sent", inbound: "none", blocked: false, code_hash: codeHash,
      created_at: nowIso(), updated_at: nowIso(),
    };
    book.friends.push(entry);
  } else {
    entry.url = url;
    entry.card_hash = hash;
    entry.outbound = "sent";
    if (codeHash) entry.code_hash = codeHash;
    touch(entry);
  }
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_request", peer: opts.name, card_hash: hash, ...(codeHash ? { code_hash: codeHash } : {}), ok: true });
  recordFriendEvent(home, "friend_requested", { peer: opts.name, card_hash: hash, ...(codeHash ? { code_hash: codeHash } : {}), ok: true });
  return { entry, card };
}

/** 登记对方发来的好友请求（须带双方人工比对过的好友码；码只记指纹）。 */
export async function recordInboundRequest(home: string, config: Record<string, unknown>, opts: {
  name: string;
  url: string;
  code: string;
  fetchDeps?: CardFetchDeps;
}): Promise<{ entry: FriendEntry; card: AgentCard }> {
  requirePeersEnabled(config);
  if (!PEER_NAME_RE.test(opts.name)) throw new PeerCardError(`好友名字只认字母数字、下划线或连字符（最多 32 字），当前是 ${JSON.stringify(opts.name)}`);
  const url = validatePeerUrl(opts.url);
  const code = opts.code.trim();
  if (!FRIEND_CODE_RE.test(code)) throw new PeerCardError("好友码格式不对（应为 NYR-XXXX-XXXX）：码是双方人工比对的共享口令，请与对方核对后重试");
  // 码是双方人工比对的共享口令：来加我的人得拿得出我发出去的码。
  // 验的是我当前的好友码——账本里记的那枚不能拿来验（发请求时记的是对方
  // 给我的码，收请求时验的是我自己的码，两枚码本来就不同）。
  const myCode = getFriendCode(home);
  if (code !== myCode.code) {
    throw new PeerCardError("好友码对不上：请与对方核对码是否一致（码是双方人工比对的共享口令，错码不认）");
  }
  const codeHash = cardHash(code);
  const { card, hash } = await fetchAgentCard(url, opts.fetchDeps);
  const book = loadFriendBook(home);
  let entry = findFriend(book, opts.name);
  if (entry && entry.blocked) throw new PeerCardError(`${opts.name} 已拉黑：先取消拉黑再登记请求（nyra peer unblock ${opts.name}）`);
  if (!entry) {
    entry = {
      name: opts.name, url, card_hash: hash, circle: "default", tier: "readonly",
      outbound: "none", inbound: "pending", blocked: false, code_hash: codeHash,
      created_at: nowIso(), updated_at: nowIso(),
    };
    book.friends.push(entry);
  } else {
    entry.url = url;
    entry.card_hash = hash;
    // 已是好友时重登记只更新名片，不打回待批准。
    entry.inbound = entry.inbound === "accepted" ? "accepted" : "pending";
    entry.code_hash = codeHash;
    touch(entry);
  }
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_request_received", peer: opts.name, card_hash: hash, code_hash: codeHash });
  recordFriendEvent(home, "friend_request_received", { peer: opts.name, card_hash: hash, code_hash: codeHash });
  return { entry, card };
}

/** 批准对方的好友请求（好友默认只读；批准须 --yes，CLI 层拦）。 */
export function acceptFriend(home: string, opts: { name: string; circle?: string; tier?: FriendTier }): FriendEntry {
  const book = loadFriendBook(home);
  const entry = findFriend(book, opts.name);
  if (!entry) throw new PeerCardError(`没有 ${opts.name} 的好友请求：先让对方把好友码给你，再跑 nyra peer request 登记`);
  if (entry.blocked) throw new PeerCardError(`${opts.name} 已拉黑：先取消拉黑（nyra peer unblock ${opts.name}）`);
  if (entry.inbound !== "pending") throw new PeerCardError(`${opts.name} 现在没有待批准的请求（当前状态：${friendStatus(entry)}）`);
  const circle = opts.circle ?? entry.circle;
  if (circle !== "default" && !book.circles.some((c) => c.name === circle)) {
    throw new PeerCardError(`没有这个圈：${circle}（先跑 nyra peer circle create ${circle}）`);
  }
  const tier = opts.tier ?? entry.tier;
  if (tier !== "readonly" && tier !== "propose") throw new PeerCardError("权限档只能是 readonly 或 propose");
  entry.inbound = "accepted";
  entry.circle = circle;
  entry.tier = tier;
  touch(entry);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_accepted", peer: opts.name, circle, tier });
  recordFriendEvent(home, "friend_accepted", { peer: opts.name, circle, tier });
  return entry;
}

/** 拒绝对方的好友请求（拒绝须 --yes，CLI 层拦）。 */
export function declineFriend(home: string, name: string): FriendEntry {
  const book = loadFriendBook(home);
  const entry = findFriend(book, name);
  if (!entry) throw new PeerCardError(`没有 ${name} 的好友请求`);
  if (entry.inbound !== "pending") throw new PeerCardError(`${name} 现在没有待批准的请求（当前状态：${friendStatus(entry)}）`);
  entry.inbound = "declined";
  touch(entry);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_declined", peer: name });
  recordFriendEvent(home, "friend_declined", { peer: name });
  return entry;
}

/** 拉黑：单方立即生效——不再收对方消息、不分享、不呼叫（可取消）。 */
export function blockFriend(home: string, name: string): FriendEntry {
  const book = loadFriendBook(home);
  const entry = findFriend(book, name);
  if (!entry) throw new PeerCardError(`好友账本里没有 ${name}`);
  entry.blocked = true;
  touch(entry);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_blocked", peer: name });
  recordFriendEvent(home, "friend_blocked", { peer: name });
  return entry;
}

export function unblockFriend(home: string, name: string): FriendEntry {
  const book = loadFriendBook(home);
  const entry = findFriend(book, name);
  if (!entry) throw new PeerCardError(`好友账本里没有 ${name}`);
  entry.blocked = false;
  touch(entry);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_unblocked", peer: name });
  recordFriendEvent(home, "friend_unblocked", { peer: name });
  return entry;
}

/** 删除好友（单方；须 --yes，CLI 层拦；删后对方那边不受影响）。 */
export function removeFriend(home: string, name: string): void {
  const book = loadFriendBook(home);
  const idx = book.friends.findIndex((f) => f.name === name);
  if (idx < 0) throw new PeerCardError(`好友账本里没有 ${name}`);
  book.friends.splice(idx, 1);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_removed", peer: name });
  recordFriendEvent(home, "friend_removed", { peer: name });
}

/** 改权限档（readonly：只能看分享的产物；propose：可提议修改，每次须你批准）。 */
export function setFriendTier(home: string, name: string, tier: FriendTier): FriendEntry {
  if (tier !== "readonly" && tier !== "propose") throw new PeerCardError("权限档只能是 readonly 或 propose");
  const book = loadFriendBook(home);
  const entry = findFriend(book, name);
  if (!entry) throw new PeerCardError(`好友账本里没有 ${name}`);
  entry.tier = tier;
  touch(entry);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_tier", peer: name, tier });
  return entry;
}

/** 把好友移到另一个圈（圈只决定分组与共享范围；完整的缺口 34 分圈体系不在本批）。 */
export function moveFriendCircle(home: string, name: string, circle: string): FriendEntry {
  const book = loadFriendBook(home);
  const entry = findFriend(book, name);
  if (!entry) throw new PeerCardError(`好友账本里没有 ${name}`);
  if (circle !== "default" && !book.circles.some((c) => c.name === circle)) {
    throw new PeerCardError(`没有这个圈：${circle}（先跑 nyra peer circle create ${circle}）`);
  }
  entry.circle = circle;
  touch(entry);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_circle", peer: name, circle });
  return entry;
}

// ---------------------------------------------------------------------------
// 圈（最小落地：分组 + 按圈分享；圈不决定名片能不能被拉到——
// well-known 名片端点本身是公开的，圈只管“我主动发给谁”，完整
// 的 per-circle 名片可见性是缺口 34 的事，本批文档里写明了这一局限。）
// ---------------------------------------------------------------------------

export function createCircle(home: string, name: string): FriendCircle {
  if (!CIRCLE_NAME_RE.test(name)) throw new PeerCardError(`圈名只认字母数字、下划线或连字符（最多 32 字），当前是 ${JSON.stringify(name)}`);
  if (name === "default") throw new PeerCardError("default 是默认圈，不用建");
  const book = loadFriendBook(home);
  if (book.circles.some((c) => c.name === name)) throw new PeerCardError(`圈 ${name} 已存在`);
  const circle: FriendCircle = { name, created_at: nowIso() };
  book.circles.push(circle);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_circle_created", circle: name });
  return circle;
}

export function deleteCircle(home: string, name: string): void {
  if (name === "default") throw new PeerCardError("default 是默认圈，不能删");
  const book = loadFriendBook(home);
  if (!book.circles.some((c) => c.name === name)) throw new PeerCardError(`没有这个圈：${name}`);
  if (book.friends.some((f) => f.circle === name)) {
    throw new PeerCardError(`圈 ${name} 里还有好友：先把他们移走（nyra peer friend <名字> --circle default）再删`);
  }
  book.circles = book.circles.filter((c) => c.name !== name);
  saveFriendBook(home, book);
  appendPeerAudit(home, { action: "friend_circle_deleted", circle: name });
}

// ---------------------------------------------------------------------------
// 分享与呼叫接线
// ---------------------------------------------------------------------------

/** 分享一次运行的任务产物给好友（复用缺口 12 的交接包与审查门；只读模式）。 */
export async function shareWithFriend(home: string, config: Record<string, unknown>, opts: {
  to: string;
  runId: string;
  share?: readonly HandoffField[];
  deps?: PeerCallDeps;
}): Promise<{ name: string; status: string; peerRunId: string | null }[]> {
  requirePeersEnabled(config);
  const book = loadFriendBook(home);
  let targets: FriendEntry[];
  const named = findFriend(book, opts.to);
  if (named) {
    if (!isFriend(named)) throw new PeerCardError(`${opts.to} 还不是好友（当前状态：${friendStatus(named)}）：先等对方发请求、你批准后才能分享`);
    targets = [named];
  } else if (opts.to === "default" || book.circles.some((c) => c.name === opts.to)) {
    targets = book.friends.filter((f) => f.circle === opts.to && isFriend(f));
    if (!targets.length) throw new PeerCardError(`圈 ${opts.to} 里没有可分享的好友（须是已批准、未拉黑的好友）`);
  } else {
    throw new PeerCardError(`好友账本里没有 ${opts.to}，也没有这个圈：先加好友（nyra peer add / request + accept）或建圈`);
  }
  const share = opts.share ?? HANDOFF_DEFAULT_FIELDS;
  // 缺口 34：只向信任圈里的好友分享——先全员验一遍，不过整批拒绝，
  // 不发一半。动态 import：circles.ts 静态依赖本文件，静态引入会循环。
  const { isAdmitted } = await import("./circles.ts");
  const notAdmitted = targets.filter((t) => !isAdmitted(home, t.name));
  if (notAdmitted.length) {
    throw new PeerCardError(`以下好友不在信任圈里，整批分享已拒绝：${notAdmitted.map((t) => t.name).join("、")}（先跑 nyra circle invite <圈名> <好友名> 把他们引进圈）`);
  }
  const results: { name: string; status: string; peerRunId: string | null }[] = [];
  for (const target of targets) {
    const peer: PeerEntry = { name: target.name, url: target.url };
    const out = await handoffPeer({ config, home, peer, runId: opts.runId, mode: "readonly", share, deps: opts.deps });
    results.push({ name: target.name, status: out.status, peerRunId: out.peerRunId });
  }
  return results;
}

/** 视频通话 --friend 接线：名字须是已批准、未拉黑的好友，否则拒绝呼叫。 */
export function resolveFriendForCall(home: string, name: string): FriendEntry {
  const book = loadFriendBook(home);
  const entry = findFriend(book, name);
  if (!entry) throw new PeerCardError(`${name} 不是好友：先加好友（nyra peer add / request + accept），再用 --friend 呼叫`);
  if (!isFriend(entry)) throw new PeerCardError(`${name} 还不是好友（当前状态：${friendStatus(entry)}）：先完成握手再呼叫`);
  return entry;
}

// ---------------------------------------------------------------------------
// CLI：nyra peer card|code|publish|add|request|accept|decline|friends|
//   friend|block|unblock|remove|circle|share
// ---------------------------------------------------------------------------

export interface PeerCardCliInput {
  deps?: PeerCallDeps;
  fetchDeps?: CardFetchDeps;
}

const FRIEND_USAGE = "用法：\n"
  + " nyra peer card [--agent <id>]               看我的名片（JSON）与发布状态\n"
  + " nyra peer card publish <on|off>             开 / 关名片发布（默认关；关时网关 well-known 路径当不存在）\n"
  + " nyra peer code [--regenerate]               看我的好友码（24 小时有效；过期自动换新）\n"
  + " nyra peer add --name <名字> --url <地址> [--code <好友码>]   发好友请求（先拉对方名片校验）\n"
  + " nyra peer request --name <名字> --url <地址> --code <好友码> 登记对方发来的好友请求\n"
  + " nyra peer accept <名字> [--circle <圈>] [--tier readonly|propose] --yes   批准好友请求（默认只读）\n"
  + " nyra peer decline <名字> --yes             拒绝好友请求\n"
  + " nyra peer friends                           列出好友（状态 / 圈 / 权限档）\n"
  + " nyra peer friend <名字> [--tier readonly|propose] [--circle <圈>]   看好友详情 / 改权限档 / 移圈\n"
  + " nyra peer block <名字> --yes               拉黑（单方立即生效）\n"
  + " nyra peer unblock <名字>                   取消拉黑\n"
  + " nyra peer remove <名字> --yes              删除好友（单方）\n"
  + " nyra peer circle <create|list|delete> [圈名]   建圈 / 列圈 / 删圈（删圈须先移空）\n"
  + " nyra peer share --to <好友名|圈名> --run <运行ID> [--share evidence]   分享一次运行的任务产物（只读，须审查放行）\n"
  + "好友码是双方人工比对的共享口令（格式 NYR-XXXX-XXXX）；双向批准才互认：\n"
  + "你发请求 + 对方批准，另一边同样走一遍。详见 docs/peer.md";

export async function handlePeerFriends(argv: string[], home: string, input?: PeerCardCliInput): Promise<number> {
  const config = loadConfig(home);
  const cmd = argv[0];
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const err = (msg: string): number => {
    process.stderr.write(`错误：${msg}\n`);
    return 1;
  };
  try {
    if (!cmd || cmd === "card") {
      if (argv[1] === "publish") {
        const on = argv[2];
        if (on !== "on" && on !== "off") {
          process.stderr.write("用法：nyra peer card publish <on|off>\n");
          return 2;
        }
        const cfg = peerCardConfig(config);
        saveConfig(home, { peer_card: { publish: on === "on", ...(cfg.publicUrl ? { public_url: cfg.publicUrl } : {}) } });
        process.stdout.write(`名片发布已${on === "on" ? "开启" : "关闭"}${on === "on" ? "（网关 GET /.well-known/agent-card.json 回名片 JSON）" : "（网关 well-known 路径当不存在，不泄露端点）"}\n`);
        return 0;
      }
      const agent = flagValue("--agent") ?? undefined;
      const card = buildAgentCard(home, config, agent);
      process.stdout.write(JSON.stringify(card, null, 2) + "\n");
      const cfg = peerCardConfig(config);
      process.stdout.write(`名片发布：${cfg.publish ? "已开启" : "未开启（默认关闭；开：nyra peer card publish on）"}\n`);
      if (!cfg.publicUrl) process.stdout.write("公开地址未配：名片里 url 为 null；配：config.json 的 peer_card.public_url（网关根地址）\n");
      return 0;
    }
    if (cmd === "code") {
      const rec = has("--regenerate") ? regenerateFriendCode(home) : getFriendCode(home);
      process.stdout.write(`我的好友码：${rec.code}\n`);
      process.stdout.write(`有效期至：${rec.expires_at}（24 小时，过期自动换新；换新：nyra peer code --regenerate）\n`);
      process.stdout.write("把码发给对方，对方用 nyra peer request 登记；码是双方人工比对的共享口令，别发到公开地方。\n");
      return 0;
    }
    if (cmd === "add") {
      const name = flagValue("--name");
      const url = flagValue("--url");
      if (!name || !url) {
        process.stderr.write("用法：nyra peer add --name <名字> --url <地址> [--code <好友码>]\n");
        return 2;
      }
      const { card } = await addFriendRequest(home, config, { name, url, code: flagValue("--code") ?? null, fetchDeps: input?.fetchDeps });
      process.stdout.write(`好友请求已发给 ${name}（名片：${card.name}，指纹 ${cardHash(JSON.stringify(card))}）\n`);
      process.stdout.write("对方还须在自己那边登记并批准你的请求（nyra peer request + accept），两边都批了才是双向好友。\n");
      return 0;
    }
    if (cmd === "request") {
      const name = flagValue("--name");
      const url = flagValue("--url");
      const code = flagValue("--code");
      if (!name || !url || !code) {
        process.stderr.write("用法：nyra peer request --name <名字> --url <地址> --code <好友码>\n");
        return 2;
      }
      const { card } = await recordInboundRequest(home, config, { name, url, code, fetchDeps: input?.fetchDeps });
      process.stdout.write(`已登记 ${name} 的好友请求（名片：${card.name}）\n`);
      process.stdout.write(`批准：nyra peer accept ${name} --yes（默认只读）；拒绝：nyra peer decline ${name} --yes\n`);
      return 0;
    }
    if (cmd === "accept" || cmd === "decline") {
      const name = argv[1];
      if (!name) {
        process.stderr.write(`用法：nyra peer ${cmd} <名字>${cmd === "accept" ? " [--circle <圈>] [--tier readonly|propose]" : ""} --yes\n`);
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write(`${cmd === "accept" ? "批准" : "拒绝"}好友请求须加 --yes 确认\n`);
        return 2;
      }
      requirePeersEnabled(config);
      if (cmd === "accept") {
        const tierRaw = flagValue("--tier");
        if (tierRaw && tierRaw !== "readonly" && tierRaw !== "propose") {
          process.stderr.write("权限档只能是 readonly 或 propose\n");
          return 2;
        }
        const entry = acceptFriend(home, { name, circle: flagValue("--circle"), tier: tierRaw as FriendTier | undefined });
        process.stdout.write(`${name} 已是好友（${friendStatus(entry)} · ${entry.circle} 圈 · ${entry.tier === "readonly" ? "只读" : "可提议修改"}）\n`);
        process.stdout.write("好友默认只读：只能看你明确分享的任务产物，不能读记忆、文件、密钥。\n");
      } else {
        declineFriend(home, name);
        process.stdout.write(`已拒绝 ${name} 的好友请求\n`);
      }
      return 0;
    }
    if (cmd === "friends") {
      const book = loadFriendBook(home);
      if (!book.friends.length) {
        process.stdout.write("还没有好友：先用 nyra peer code 把你的好友码发给对方，再登记对方的请求。\n");
        return 0;
      }
      for (const f of book.friends) {
        process.stdout.write(`${f.name}\t${friendStatus(f)}\t${f.circle}\t${f.tier}\t${f.url}\n`);
      }
      return 0;
    }
    if (cmd === "friend") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra peer friend <名字> [--tier readonly|propose] [--circle <圈>]\n");
        return 2;
      }
      const tierRaw = flagValue("--tier");
      const circle = flagValue("--circle");
      if (tierRaw) {
        if (tierRaw !== "readonly" && tierRaw !== "propose") {
          process.stderr.write("权限档只能是 readonly 或 propose\n");
          return 2;
        }
        setFriendTier(home, name, tierRaw);
        process.stdout.write(`${name} 的权限档已改为 ${tierRaw}\n`);
        return 0;
      }
      if (circle) {
        moveFriendCircle(home, name, circle);
        process.stdout.write(`${name} 已移到 ${circle} 圈\n`);
        return 0;
      }
      const book = loadFriendBook(home);
      const entry = findFriend(book, name);
      if (!entry) return err(`好友账本里没有 ${name}`);
      process.stdout.write(
        `${entry.name}\n`
        + `状态：${friendStatus(entry)}\n`
        + `圈：${entry.circle} · 权限档：${entry.tier === "readonly" ? "只读（只能看分享的任务产物）" : "可提议修改（每次须你批准）"}\n`
        + `地址：${entry.url}\n`
        + `名片指纹：${entry.card_hash}\n`
        + `好友码指纹：${entry.code_hash ?? "（未记）"}\n`
        + `加于：${entry.created_at} · 更新于：${entry.updated_at}\n`,
      );
      return 0;
    }
    if (cmd === "block" || cmd === "unblock" || cmd === "remove") {
      const name = argv[1];
      if (!name) {
        process.stderr.write(`用法：nyra peer ${cmd} <名字>${cmd !== "unblock" ? " --yes" : ""}\n`);
        return 2;
      }
      if (cmd !== "unblock" && !has("--yes")) {
        process.stderr.write(`${cmd === "block" ? "拉黑" : "删除好友"}须加 --yes 确认\n`);
        return 2;
      }
      if (cmd === "block") {
        blockFriend(home, name);
        process.stdout.write(`${name} 已拉黑（不再收对方消息、不分享、不呼叫；取消：nyra peer unblock ${name}）\n`);
      } else if (cmd === "unblock") {
        unblockFriend(home, name);
        process.stdout.write(`${name} 已取消拉黑\n`);
      } else {
        removeFriend(home, name);
        process.stdout.write(`${name} 已从好友账本删除（单方；对方那边不受影响）\n`);
      }
      return 0;
    }
    if (cmd === "circle") {
      const sub = argv[1];
      if (sub === "list" || !sub) {
        const book = loadFriendBook(home);
        for (const c of listCircles(book)) {
          const n = book.friends.filter((f) => f.circle === c).length;
          process.stdout.write(`${c}\t${n} 位好友\n`);
        }
        return 0;
      }
      if (sub === "create") {
        const name = argv[2];
        if (!name) {
          process.stderr.write("用法：nyra peer circle create <圈名>\n");
          return 2;
        }
        createCircle(home, name);
        process.stdout.write(`圈 ${name} 已建（圈只决定分组与共享范围；名片本身是公开端点，圈不管拉取）\n`);
        return 0;
      }
      if (sub === "delete") {
        const name = argv[2];
        if (!name) {
          process.stderr.write("用法：nyra peer circle delete <圈名>\n");
          return 2;
        }
        if (!has("--yes")) {
          process.stderr.write("删圈须加 --yes 确认\n");
          return 2;
        }
        deleteCircle(home, name);
        process.stdout.write(`圈 ${name} 已删\n`);
        return 0;
      }
      process.stderr.write("用法：nyra peer circle <create|list|delete> [圈名]\n");
      return 2;
    }
    if (cmd === "share") {
      const to = flagValue("--to");
      const runId = flagValue("--run");
      if (!to || !runId) {
        process.stderr.write("用法：nyra peer share --to <好友名|圈名> --run <运行ID> [--share evidence]\n");
        return 2;
      }
      const share: HandoffField[] = [...HANDOFF_DEFAULT_FIELDS];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--share") {
          const v = argv[i + 1];
          if (v !== "evidence") {
            process.stderr.write("--share 目前只支持 evidence\n");
            return 2;
          }
          if (!share.includes("evidence")) share.push("evidence");
        }
      }
      const results = await shareWithFriend(home, config, { to, runId, share, deps: input?.deps });
      for (const r of results) {
        process.stdout.write(`分享给 ${r.name}：${r.status === "accepted" ? "已接下" : r.status === "rejected" ? "被对端拒绝" : "发送失败"}${r.peerRunId ? `（对端运行 ${r.peerRunId}）` : ""}\n`);
      }
      return results.every((r) => r.status === "accepted") ? 0 : 1;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  process.stderr.write(FRIEND_USAGE + "\n");
  return 2;
}
