// src/invites.ts — 邀请制账本（Cue 方向 B 批，与缺口 48 每 Bot 数字身份挂钩）。
//
// 只有账本，没有注册后端：云端登录后端未部署，所以邀请码现在只能生成、
// 列表、吊销、记名额，**不能兑现注册**。兑现（新用户凭码注册）等云端上线
// 后启用，接口与界面都如实标这一点，不假装码已经能用。
// 名额：机主一共 5 个邀请名额（按 Cue 截图里“5 个邀请名额已用完”取的数）；
// 发一个有效码占 1 个名额，吊销后名额回到池里。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";

export const INVITES_FILE = "invites.json";
/** 机主邀请名额总数（Cue 截图：5 个名额）。 */
export const INVITE_TOTAL_SLOTS = 5;

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteError";
  }
}

export interface InviteRecord {
  code: string;
  note: string;
  /** active = 可兑现（等云端上线）、revoked = 已吊销。 */
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  /** 兑现记录（云端上线前恒为空数组，不编数据）。 */
  redeemedBy: string[];
}

export interface InviteStore {
  version: 1;
  totalSlots: number;
  invites: InviteRecord[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 原子写 0600：先写同目录临时文件再 rename；旧文件是符号链接就拒绝（与 budget.ts 同款写法）。 */
function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new InviteError(`${file} 不能是符号链接`);
  }
  const tmp = join(dirname(path), `.${file}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function emptyStore(): InviteStore {
  return { version: 1, totalSlots: INVITE_TOTAL_SLOTS, invites: [] };
}

/** 读账本。文件不存在按空账本；损坏回落空账本并丢弃坏内容（不编记录）。 */
export function loadInvites(home: string): InviteStore {
  try {
    const raw = JSON.parse(readFileSync(join(resolveHome(home), INVITES_FILE), "utf-8")) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.invites)) return emptyStore();
    const invites: InviteRecord[] = [];
    for (const item of raw.invites) {
      if (!isRecord(item) || typeof item.code !== "string") continue;
      invites.push({
        code: item.code,
        note: typeof item.note === "string" ? item.note : "",
        status: item.status === "revoked" ? "revoked" : "active",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
        revokedAt: typeof item.revokedAt === "string" ? item.revokedAt : null,
        redeemedBy: Array.isArray(item.redeemedBy) ? item.redeemedBy.filter((x): x is string => typeof x === "string") : [],
      });
    }
    return {
      version: 1,
      totalSlots: typeof raw.totalSlots === "number" && raw.totalSlots > 0 ? Math.floor(raw.totalSlots) : INVITE_TOTAL_SLOTS,
      invites,
    };
  } catch {
    return emptyStore();
  }
}

function saveInvites(home: string, store: InviteStore): void {
  saveJsonAtomic(home, INVITES_FILE, store);
}

/** 名额汇总：有效码占名额，吊销的释放。 */
export function inviteQuota(home: string): { total: number; used: number; remaining: number } {
  const store = loadInvites(home);
  const used = store.invites.filter((i) => i.status === "active").length;
  return { total: store.totalSlots, used, remaining: Math.max(0, store.totalSlots - used) };
}

/** 邀请码字符集：去掉容易看错的 0/O、1/I/L。 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newInviteCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = randomBytes(6);
    let code = "";
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!existing.has(code)) return code;
  }
  throw new InviteError("邀请码生成失败：多次撞码，请重试");
}

/**
 * 发一个邀请码（占 1 个名额）。名额用完抛错，不超发。
 * 发出的码现在不能兑现注册——云端上线后启用，见 docs/mobile-cue.md。
 */
export function createInvite(home: string, note = ""): InviteRecord {
  const store = loadInvites(home);
  const quota = inviteQuota(home);
  if (quota.remaining <= 0) {
    throw new InviteError(`邀请名额已用完（共 ${store.totalSlots} 个，吊销一个可释放名额）`);
  }
  const existing = new Set(store.invites.map((i) => i.code));
  const rec: InviteRecord = {
    code: newInviteCode(existing),
    note: note.trim().slice(0, 120),
    status: "active",
    createdAt: nowIso(),
    revokedAt: null,
    redeemedBy: [],
  };
  store.invites.push(rec);
  saveInvites(home, store);
  return rec;
}

/** 吊销一个邀请码（名额回到池里）。没有这个码抛错。 */
export function revokeInvite(home: string, code: string): InviteRecord {
  const store = loadInvites(home);
  const rec = store.invites.find((i) => i.code === code.trim().toUpperCase());
  if (!rec) throw new InviteError(`没有这个邀请码：${code}`);
  if (rec.status === "revoked") throw new InviteError(`邀请码 ${rec.code} 已经吊销过了`);
  rec.status = "revoked";
  rec.revokedAt = nowIso();
  saveInvites(home, store);
  return rec;
}
