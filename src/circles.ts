// src/circles.ts — 缺口 34：Circles 信任圈与跨实例准入（扩展缺口 12）。
//
// 默认全封闭：只有被引入信任圈的身份能给 agent 发任务。准入即能力——
// 圈外消息在网关层直接丢弃，不进 agent 上下文、不耗 token（对方是
// “收到后拒绝”，Nyra 是“看不见”）。
//
// 与缺口 38 的关系（不要混淆）：
// - 缺口 38 的圈是“分组圈”（friends.json 里的 circles 列表 + 每好友
//   一个 circle 字段）：决定“我主动发给谁、共享给谁”，不决定谁能发任务。
// - 本批的圈是“准入圈”（circles.json）：决定“谁有资格发任务”。成员
//   只记好友名（friends.json 里已有的身份），不另起一套身份体系；
//   入圈的前提是已批准、未拉黑的好友（双向握手已过）。
// - 分组圈 default 不是准入圈：刚加的好友只在 default 分组里，不自动
//   获得发任务资格，须另行引进信任圈。
//
// 团队规则：团队成员是本机内部 agent（Soul agent id），走参谋长分派，
// 不经过网关准入；圈只管外部来信（渠道消息、对端呼叫、邮件）。
// 邮件入口（缺口 22）不归圈管：它有自己的白名单发件人 + 审批双保险，
// 本批只核对已落地、写进文档，不重做。
//
// 安全边界：
// - 账本 ~/.nyra/circles.json 原子写 0600，损坏先备份再抛错；
// - 引入只能由机主或已在该圈里的成员发起，引入/撤销都进证据链与
//   peer-audit.jsonl（谁引入的、何时、通过什么渠道）；
// - 撤销后该身份立即失去准入：网关丢弃其消息、互问/交接/分享拒绝；
//   历史证据与审计不删（不可变审计），但不再向该身份提供新上下文；
// - 热路径（网关预过滤、互问/交接门）上的账本读失败一律按“不准入”
//   处理（fail-closed），不抛错、不放行。
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { appendPeerAudit } from "./peer.ts";
import { recordAdmission } from "./admission.ts";
import { CIRCLE_NAME_RE, findFriend, isFriend, loadFriendBook } from "./peerCard.ts";

export const CIRCLES_FILE = "circles.json";
export const OWNER_IDENTITY = "owner";
export const GROUP_DEFAULT_CIRCLE = "default";
export const CIRCLE_CHANNELS = ["telegram", "discord", "slack", "whatsapp"] as const;
export type CircleChannel = (typeof CIRCLE_CHANNELS)[number];

export class CircleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircleError";
  }
}

export interface CircleMember {
  /** 好友名（friends.json 里的身份，不另存名片与地址）。 */
  identity: string;
  kind: "friend";
  invited_by: string;
  invited_at: string;
  /** 引入渠道：cli / telegram / discord / slack / whatsapp / mail。 */
  channel: string;
}

export interface TrustCircle {
  name: string;
  description: string;
  created_at: string;
  created_by: string;
  members: CircleMember[];
}

export interface ChannelBinding {
  channel: string;
  /** 平台侧发件人 id（Telegram 用户 id、Discord 用户 id 等）。 */
  sender: string;
  /** 绑到的身份：好友名，或 "owner"（机主本人）。 */
  identity: string;
  bound_at: string;
  bound_by: string;
}

export interface CircleBook {
  version: 1;
  circles: TrustCircle[];
  bindings: ChannelBinding[];
  /**
   * H6：删圈墓碑——删掉的圈只留这一条（名字 + 删除时间 + 谁删的）。
   * 建同名圈是用户显式决定：清掉墓碑继续建，并记 circle_recreated 审计；
   * 任何重扫/同步都不许悄悄把删掉的圈建回来。
   */
  deleted?: { name: string; deleted_at: string; by: string }[];
}

function circlesPath(home: string): string {
  return join(resolveNyraHome(home), CIRCLES_FILE);
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

/** 读圈账本：没有返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadCircleBook(home: string): CircleBook {
  const path = circlesPath(home);
  if (!existsSync(path)) return { version: 1, circles: [], bindings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new CircleError(`${CIRCLES_FILE} 已损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.circles) || !Array.isArray(parsed.bindings)) {
    throw new CircleError(`${CIRCLES_FILE} 结构不对（须含 circles 与 bindings 两个列表）`);
  }
  // H6：删圈墓碑跟着账本走——形状不对的墓碑行丢掉，不拖垮整个账本。
  let deleted: { name: string; deleted_at: string; by: string }[] | undefined;
  if (Array.isArray(parsed.deleted)) {
    const kept = (parsed.deleted as unknown[]).filter((d): d is { name: string; deleted_at: string; by: string } => {
      return !!d && typeof d === "object" &&
        typeof (d as { name?: unknown }).name === "string" &&
        typeof (d as { deleted_at?: unknown }).deleted_at === "string" &&
        typeof (d as { by?: unknown }).by === "string";
    });
    if (kept.length) deleted = kept;
  }
  return { version: 1, circles: parsed.circles as TrustCircle[], bindings: parsed.bindings as ChannelBinding[], ...(deleted ? { deleted } : {}) };
}

export function saveCircleBook(home: string, book: CircleBook): void {
  writeJsonAtomic(home, CIRCLES_FILE, JSON.stringify(book, null, 2) + "\n");
}

export function findCircle(book: CircleBook, name: string): TrustCircle | null {
  return book.circles.find((c) => c.name === name) ?? null;
}

function validateCircleName(name: string): void {
  if (!CIRCLE_NAME_RE.test(name)) throw new CircleError(`圈名只认字母数字、下划线或连字符（最多 32 字），当前是 ${JSON.stringify(name)}`);
  if (name === GROUP_DEFAULT_CIRCLE) throw new CircleError("default 是分组默认圈，不是准入圈：信任圈须另建一个名字（刚加的好友不自动获得发任务资格）");
}

/** 圈操作单独建一条只记 circle_* 事件的运行（与好友事件同款做法）。 */
function recordCircleEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`信任圈：${type}`, "circle", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 圈的创建 / 删除 / 列出
// ---------------------------------------------------------------------------

/** 建信任圈（机主操作；分组圈 default 不可建为准入圈）。 */
export function createCircle(home: string, name: string, opts?: { description?: string; by?: string }): TrustCircle {
  validateCircleName(name);
  const by = opts?.by ?? OWNER_IDENTITY;
  const book = loadCircleBook(home);
  if (findCircle(book, name)) throw new CircleError(`圈 ${name} 已存在`);
  // H6：同名圈有墓碑时，建圈是用户显式决定：清掉墓碑继续建，并记审计。
  const tombIdx = (book.deleted ?? []).findIndex((d) => d.name === name);
  if (tombIdx >= 0) {
    book.deleted!.splice(tombIdx, 1);
    if (!book.deleted!.length) delete book.deleted;
  }
  const circle: TrustCircle = {
    name,
    description: (opts?.description ?? "").slice(0, 200),
    created_at: nowIso(),
    created_by: by,
    members: [],
  };
  book.circles.push(circle);
  saveCircleBook(home, book);
  appendPeerAudit(home, { action: "circle_created", circle: name, by });
  recordCircleEvent(home, "circle_created", { circle: name, by });
  if (tombIdx >= 0) {
    appendPeerAudit(home, { action: "circle_recreated", circle: name, by });
    recordCircleEvent(home, "circle_recreated", { circle: name, by });
  }
  return circle;
}

/** 删信任圈（须先移空成员；分组圈不受影响，仍可另行删除）。 */
export function deleteCircle(home: string, name: string, by?: string): void {
  const who = by ?? OWNER_IDENTITY;
  const book = loadCircleBook(home);
  const circle = findCircle(book, name);
  if (!circle) throw new CircleError(`没有这个圈：${name}`);
  if (circle.members.length) {
    throw new CircleError(`圈 ${name} 里还有成员：先把他们撤销（nyra circle revoke ${name} <好友名> --yes）再删`);
  }
  book.circles = book.circles.filter((c) => c.name !== name);
  // H6：删圈写墓碑——账本里不再有这个圈，但“删过”这个事实留下来。
  // 同名重建是用户显式决定（createCircle 里清墓碑 + 记 circle_recreated）；
  // 任何重扫/同步都不许悄悄把删掉的圈建回来。
  if (!book.deleted) book.deleted = [];
  book.deleted = book.deleted.filter((d) => d.name !== name);
  book.deleted.push({ name, deleted_at: nowIso(), by: who });
  saveCircleBook(home, book);
  appendPeerAudit(home, { action: "circle_deleted", circle: name, by: who });
  recordCircleEvent(home, "circle_deleted", { circle: name, by: who });
}

export function listCircles(home: string): TrustCircle[] {
  return loadCircleBook(home).circles;
}

// ---------------------------------------------------------------------------
// 引入 / 撤销：准入只能由机主或已在该圈里的成员发起
// ---------------------------------------------------------------------------

/** 引入一名已批准、未拉黑的好友进圈（成员只记好友名，不另存身份）。 */
export function inviteToCircle(home: string, opts: { circle: string; identity: string; by?: string; channel?: string }): CircleMember {
  const by = opts.by ?? OWNER_IDENTITY;
  const channel = opts.channel ?? "cli";
  const book = loadCircleBook(home);
  const circle = findCircle(book, opts.circle);
  if (!circle) throw new CircleError(`没有这个圈：${opts.circle}（先跑 nyra circle create ${opts.circle}）`);
  if (by !== OWNER_IDENTITY) {
    const inviter = circle.members.find((m) => m.identity === by);
    if (!inviter) throw new CircleError(`${by} 不在 ${opts.circle} 圈里：引入只能由机主或已在该圈里的成员发起`);
  }
  const friendBook = loadFriendBook(home);
  const entry = findFriend(friendBook, opts.identity);
  if (!entry) throw new CircleError(`好友账本里没有 ${opts.identity}：先加好友（nyra peer add / request + accept）再引进圈`);
  if (!isFriend(entry)) {
    const state = entry.blocked ? "已拉黑" : "还不是好友（须先批准对方的请求）";
    throw new CircleError(`${opts.identity} ${state}：入圈的前提是已批准、未拉黑的好友`);
  }
  if (circle.members.some((m) => m.identity === opts.identity)) {
    throw new CircleError(`${opts.identity} 已在 ${opts.circle} 圈里`);
  }
  const member: CircleMember = {
    identity: opts.identity,
    kind: "friend",
    invited_by: by,
    invited_at: nowIso(),
    channel,
  };
  circle.members.push(member);
  saveCircleBook(home, book);
  appendPeerAudit(home, { action: "circle_invited", circle: opts.circle, peer: opts.identity, by, channel });
  recordCircleEvent(home, "circle_invited", { circle: opts.circle, peer: opts.identity, by, channel });
  // G-P2-2：进圈记进统一准入账本（写失败不破坏入圈本身）。
  recordAdmission(home, { kind: "member_joined", actor: by, subject: opts.identity, circle: opts.circle, role: "friend", detail: `channel ${channel}` });
  return member;
}

/** 撤销一名成员（撤销后立即失去准入；历史证据与审计不删）。 */
export function revokeFromCircle(home: string, circleName: string, identity: string, by?: string): void {
  const who = by ?? OWNER_IDENTITY;
  const book = loadCircleBook(home);
  const circle = findCircle(book, circleName);
  if (!circle) throw new CircleError(`没有这个圈：${circleName}`);
  const idx = circle.members.findIndex((m) => m.identity === identity);
  if (idx < 0) throw new CircleError(`${identity} 不在 ${circleName} 圈里`);
  circle.members.splice(idx, 1);
  saveCircleBook(home, book);
  appendPeerAudit(home, { action: "circle_revoked", circle: circleName, peer: identity, by: who });
  recordCircleEvent(home, "circle_revoked", { circle: circleName, peer: identity, by: who });
  // G-P2-2：离圈记进统一准入账本（写失败不破坏撤销本身）。
  recordAdmission(home, { kind: "member_left", actor: who, subject: identity, circle: circleName });
}

/** 该身份在哪些圈里（机主不在任何圈里也照样准入，见 isAdmitted）。 */
export function memberCircles(home: string, identity: string): string[] {
  const book = loadCircleBook(home);
  return book.circles.filter((c) => c.members.some((m) => m.identity === identity)).map((c) => c.name);
}

// ---------------------------------------------------------------------------
// 准入判定（热路径：账本读失败一律按“不准入”处理，不抛错）
// ---------------------------------------------------------------------------

/** 身份有没有发任务的资格：机主永远有；好友须已批准、未拉黑且在任一圈里。 */
export function isAdmitted(home: string, identity: string): boolean {
  try {
    if (identity === OWNER_IDENTITY) return true;
    const friendBook = loadFriendBook(home);
    const entry = findFriend(friendBook, identity);
    if (!entry || !isFriend(entry)) return false;
    return memberCircles(home, identity).length > 0;
  } catch {
    return false;
  }
}

/** 准入详情（CLI check 用：账本损坏时抛错，不静默当成“不准入”）。 */
export function admissionDetail(home: string, identity: string): { admitted: boolean; reason: string; circles: string[] } {
  if (identity === OWNER_IDENTITY) {
    return { admitted: true, reason: "机主本人，永远准入", circles: [] };
  }
  const friendBook = loadFriendBook(home);
  const entry = findFriend(friendBook, identity);
  if (!entry) return { admitted: false, reason: `好友账本里没有 ${identity}`, circles: [] };
  if (entry.blocked) return { admitted: false, reason: `${identity} 已拉黑`, circles: [] };
  if (!isFriend(entry)) return { admitted: false, reason: `${identity} 还不是好友（须先批准对方的请求）`, circles: [] };
  const circles = memberCircles(home, identity);
  if (!circles.length) return { admitted: false, reason: `${identity} 不在任何信任圈里（先跑 nyra circle invite <圈名> ${identity}）`, circles: [] };
  return { admitted: true, reason: `在信任圈里：${circles.join("、")}`, circles };
}

// ---------------------------------------------------------------------------
// 渠道发件人 → 身份绑定（网关预过滤认发件人 id，不认名字）
// ---------------------------------------------------------------------------

function validateChannel(channel: string): void {
  if (!(CIRCLE_CHANNELS as readonly string[]).includes(channel)) {
    throw new CircleError(`渠道只认 telegram / discord / slack / whatsapp，当前是 ${JSON.stringify(channel)}`);
  }
}

function validateSender(sender: string): void {
  if (!sender.trim()) throw new CircleError("发件人 id 不能为空");
  if (sender.length > 128) throw new CircleError("发件人 id 太长（最多 128 字）");
}

/** 绑定一个渠道发件人到身份（好友名或 "owner"；同一渠道+发件人重复绑定会覆盖）。 */
export function bindChannelSender(home: string, opts: { channel: string; sender: string; identity: string; by?: string }): ChannelBinding {
  validateChannel(opts.channel);
  validateSender(opts.sender);
  const by = opts.by ?? OWNER_IDENTITY;
  if (opts.identity !== OWNER_IDENTITY) {
    const friendBook = loadFriendBook(home);
    const entry = findFriend(friendBook, opts.identity);
    if (!entry) throw new CircleError(`好友账本里没有 ${opts.identity}：先加好友再绑定`);
    if (!isFriend(entry)) throw new CircleError(`${opts.identity} 还不是好友（须先批准对方的请求）：绑定只认已批准、未拉黑的好友`);
  }
  const book = loadCircleBook(home);
  const sender = opts.sender.trim();
  const existing = book.bindings.find((b) => b.channel === opts.channel && b.sender === sender);
  if (existing) {
    existing.identity = opts.identity;
    existing.bound_at = nowIso();
    existing.bound_by = by;
  } else {
    book.bindings.push({ channel: opts.channel, sender, identity: opts.identity, bound_at: nowIso(), bound_by: by });
  }
  saveCircleBook(home, book);
  appendPeerAudit(home, { action: "circle_binding_set", channel: opts.channel, sender, identity: opts.identity, by });
  recordCircleEvent(home, "circle_binding_set", { channel: opts.channel, sender, identity: opts.identity });
  return book.bindings.find((b) => b.channel === opts.channel && b.sender === sender)!;
}

/** 解绑一个渠道发件人（没有这条绑定直接报错，不静默成功）。 */
export function unbindChannelSender(home: string, channel: string, sender: string): void {
  validateChannel(channel);
  const book = loadCircleBook(home);
  const idx = book.bindings.findIndex((b) => b.channel === channel && b.sender === sender.trim());
  if (idx < 0) throw new CircleError(`没有这条绑定：${channel} / ${sender}`);
  book.bindings.splice(idx, 1);
  saveCircleBook(home, book);
  appendPeerAudit(home, { action: "circle_binding_removed", channel, sender: sender.trim() });
}

/** 渠道发件人绑到的身份：好友名 / "owner" / null（未绑定）。 */
export function resolveSenderIdentity(home: string, channel: string, sender: string): string | null {
  try {
    const book = loadCircleBook(home);
    return book.bindings.find((b) => b.channel === channel && b.sender === sender)?.identity ?? null;
  } catch {
    return null;
  }
}

export function listBindings(home: string): ChannelBinding[] {
  return loadCircleBook(home).bindings;
}

export interface CircleAdmission {
  admitted: boolean;
  /** 认出的身份：好友名 / "owner" / null（未绑定）。 */
  identity: string | null;
  reason: string;
}

/** 网关预过滤的判定（纯判定，不写审计、不调模型、不抛错）： */
export function checkCircleInbound(home: string, channel: string, sender: string): CircleAdmission {
  const identity = resolveSenderIdentity(home, channel, sender);
  if (identity === null) {
    return {
      admitted: false,
      identity: null,
      reason: `发件人未绑定身份（${channel} / ${sender}）：圈外消息默认丢弃；先跑 nyra circle bind 绑定好友，或 nyra circle owner 登记机主`,
    };
  }
  if (identity === OWNER_IDENTITY) return { admitted: true, identity, reason: "机主本人" };
  const detail = (() => {
    try {
      return admissionDetail(home, identity);
    } catch {
      return { admitted: false, reason: "账本读失败，按不准入处理", circles: [] as string[] };
    }
  })();
  return { admitted: detail.admitted, identity, reason: detail.reason };
}

// ---------------------------------------------------------------------------
// CLI：nyra circle <create|list|show|invite|revoke|delete|bind|unbind|
//   owner|check|bindings>
// ---------------------------------------------------------------------------

const CIRCLE_USAGE = "用法：\n"
  + " nyra circle create <圈名> [--desc <描述>]       建信任圈（默认全封闭：没圈 = 谁也进不来，机主除外）\n"
  + " nyra circle list                              列出信任圈（成员数）与绑定数\n"
  + " nyra circle show <圈名>                       看一个圈的成员（谁引进的、何时、通过什么渠道）\n"
  + " nyra circle invite <圈名> <好友名> [--by <引入者>] [--channel <渠道>]   引入好友进圈（引入者须是机主或已在该圈里的成员）\n"
  + " nyra circle revoke <圈名> <好友名> --yes      撤销成员（立即失去准入；历史证据与审计不删）\n"
  + " nyra circle delete <圈名> --yes               删圈（须先移空成员）\n"
  + " nyra circle bind --channel <渠道> --sender <发件人id> --friend <好友名>   绑定渠道发件人到好友（网关按发件人 id 认人）\n"
  + " nyra circle unbind --channel <渠道> --sender <发件人id>   解绑\n"
  + " nyra circle owner --channel <渠道> --sender <发件人id>   登记机主的渠道身份（机主永远准入，但网关要先认出你是谁）\n"
  + " nyra circle check <好友名|owner>              看一个身份有没有发任务的资格\n"
  + " nyra circle bindings                          列出全部渠道发件人绑定\n"
  + "信任圈只决定“谁有资格发任务”；分组圈（nyra peer circle）只决定“我主动发给谁、共享给谁”，两者名字可以相同、账本分开。\n"
  + "刚加的好友只在 default 分组里，不自动获得发任务资格，须另行引进信任圈。详见 docs/circles.md";

export async function handleCircle(argv: string[], home: string): Promise<number> {
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
    if (!cmd || cmd === "list") {
      const book = loadCircleBook(home);
      if (!book.circles.length) {
        process.stdout.write("还没有信任圈：先跑 nyra circle create <圈名> 建一个（默认全封闭，没圈 = 谁也进不来，机主除外）。\n");
        process.stdout.write(`渠道发件人绑定：${book.bindings.length} 条（看：nyra circle bindings）\n`);
        return 0;
      }
      for (const c of book.circles) {
        process.stdout.write(`${c.name}\t${c.members.length} 位成员${c.description ? `\t${c.description}` : ""}\n`);
      }
      process.stdout.write(`渠道发件人绑定：${book.bindings.length} 条（看：nyra circle bindings）\n`);
      return 0;
    }
    if (cmd === "create") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra circle create <圈名> [--desc <描述>]\n");
        return 2;
      }
      const circle = createCircle(home, name, { description: flagValue("--desc") });
      process.stdout.write(`信任圈 ${circle.name} 已建（默认全封闭：成员须你引进才有发任务资格）\n`);
      process.stdout.write(`引进好友：nyra circle invite ${circle.name} <好友名>\n`);
      return 0;
    }
    if (cmd === "show") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra circle show <圈名>\n");
        return 2;
      }
      const book = loadCircleBook(home);
      const circle = findCircle(book, name);
      if (!circle) return err(`没有这个圈：${name}`);
      process.stdout.write(`${circle.name}${circle.description ? ` — ${circle.description}` : ""}\n`);
      process.stdout.write(`建于：${circle.created_at}（${circle.created_by}）\n`);
      if (!circle.members.length) {
        process.stdout.write("成员：无（引进：nyra circle invite " + name + " <好友名>）\n");
        return 0;
      }
      process.stdout.write("成员：\n");
      for (const m of circle.members) {
        process.stdout.write(` ${m.identity}\t由 ${m.invited_by} 经 ${m.channel} 引进\t${m.invited_at}\n`);
      }
      return 0;
    }
    if (cmd === "invite") {
      const circle = argv[1];
      const identity = argv[2];
      if (!circle || !identity) {
        process.stderr.write("用法：nyra circle invite <圈名> <好友名> [--by <引入者>] [--channel <渠道>]\n");
        return 2;
      }
      const member = inviteToCircle(home, { circle, identity, by: flagValue("--by"), channel: flagValue("--channel") });
      process.stdout.write(`${member.identity} 已引进 ${circle} 圈（由 ${member.invited_by} 经 ${member.channel} 引进）：现在起它的消息能进网关、能发任务。\n`);
      return 0;
    }
    if (cmd === "revoke") {
      const circle = argv[1];
      const identity = argv[2];
      if (!circle || !identity) {
        process.stderr.write("用法：nyra circle revoke <圈名> <好友名> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("撤销成员须加 --yes 确认（撤销后对方立即失去准入）\n");
        return 2;
      }
      revokeFromCircle(home, circle, identity);
      process.stdout.write(`${identity} 已从 ${circle} 圈撤销（立即失去准入；历史证据与审计不删）\n`);
      return 0;
    }
    if (cmd === "delete") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra circle delete <圈名> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("删圈须加 --yes 确认\n");
        return 2;
      }
      deleteCircle(home, name);
      process.stdout.write(`信任圈 ${name} 已删\n`);
      return 0;
    }
    if (cmd === "bind" || cmd === "owner") {
      const channel = flagValue("--channel");
      const sender = flagValue("--sender");
      if (!channel || !sender) {
        process.stderr.write(`用法：nyra circle ${cmd} --channel <渠道> --sender <发件人id>${cmd === "bind" ? " --friend <好友名>" : ""}\n`);
        return 2;
      }
      if (cmd === "owner") {
        bindChannelSender(home, { channel, sender, identity: OWNER_IDENTITY });
        process.stdout.write(`机主身份已登记：${channel} / ${sender}（网关认出你后，你的消息照常进）\n`);
        return 0;
      }
      const friend = flagValue("--friend");
      if (!friend) {
        process.stderr.write("用法：nyra circle bind --channel <渠道> --sender <发件人id> --friend <好友名>\n");
        return 2;
      }
      bindChannelSender(home, { channel, sender, identity: friend });
      process.stdout.write(`${channel} / ${sender} 已绑定到好友 ${friend}（网关按发件人 id 认人）\n`);
      return 0;
    }
    if (cmd === "unbind") {
      const channel = flagValue("--channel");
      const sender = flagValue("--sender");
      if (!channel || !sender) {
        process.stderr.write("用法：nyra circle unbind --channel <渠道> --sender <发件人id>\n");
        return 2;
      }
      unbindChannelSender(home, channel, sender);
      process.stdout.write(`${channel} / ${sender} 的绑定已解（该发件人的消息此后按圈外丢弃）\n`);
      return 0;
    }
    if (cmd === "check") {
      const identity = argv[1];
      if (!identity) {
        process.stderr.write("用法：nyra circle check <好友名|owner>\n");
        return 2;
      }
      const detail = admissionDetail(home, identity);
      process.stdout.write(`${identity}：${detail.admitted ? "准入" : "不准入"}（${detail.reason}）\n`);
      return detail.admitted ? 0 : 1;
    }
    if (cmd === "bindings") {
      const bindings = listBindings(home);
      if (!bindings.length) {
        process.stdout.write("还没有渠道发件人绑定：先跑 nyra circle owner 登记机主、nyra circle bind 绑定好友（网关按发件人 id 认人，没绑定的发件人一律丢弃）。\n");
        return 0;
      }
      for (const b of bindings) {
        process.stdout.write(`${b.channel}\t${b.sender}\t-> ${b.identity}\t${b.bound_at}\n`);
      }
      return 0;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  process.stderr.write(CIRCLE_USAGE + "\n");
  return 2;
}
