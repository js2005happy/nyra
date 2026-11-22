// src/sfu.ts — G-P0-2：群组语音 SFU（选型定案 + 抽象层 + 本地实现）。
//
// 选型定案：mediasoup（Node 原生 SFU 库，ISC 协议）。
// 为什么不是 LiveKit：LiveKit 是 Go 写的独立 SFU 服务进程，要另起服务、
// 另配 TURN；Nyra 是单 Node 运行时，拉一个 Go 服务进程进来与方向拧着，
// 本机也没装 Go。mediasoup 是库、直接嵌进 Node 进程，与 Nyra 的运行
// 时同一条线；内置的 Node 侧 API（Worker/Router/Transport/Producer/
// Consumer）正好对上“一个语音房、多个说话者、按需订阅”的形态。
// 选型只是定案：本批不装 mediasoup、不起真服务（硬约束：不花钱、不接
// 新付费服务、不部署任何服务器）。真 mediasoup 接线是下一步，先留
// SfuProvider 抽象层与 LocalSfuRoom 本地实现。
//
// 本地实现（LocalSfuRoom，经 SfuRegistry 落盘）是确定性转发模型，
// 与第 1 批的假 STUN/TURN + 内存虚拟 UDP 同款做法：
// - 房间形态借 OpenClaw Discord 房：一个 agent + N 个说话者（上限 8），
//   听众另计（上限 32）；说话者发帧、订阅者收帧；
// - 帧只记指纹（SHA-256 前 12 位）+ 序号 + 时间，不存任何音频字节——
//   本地没有采音/放音，实时音频流不在本批范围（见 PUSH-PLAN 待真机验证）；
// - TURN 凭据带 TTL（默认 1 小时，60 秒–24 小时可配）：用户名含过期
//   时间戳，密码是房间密钥的 HMAC；过期凭据验不过，须重新签发；
// - 闲置回收：60 秒无人说话就关房（reclaimIdleRooms），关房清帧文件；
// - 录制全体同意门（沿用缺口 39 的口径）：房间里每个人都 consent 后
//   才能开录制；开录后新进来没 consent 的人，其帧不进录制文件；
// - 加密开关：本地实现只支持 none（进程内内存转发，本身不走网络）；
//   dtls-srtp 在本地明确拒绝——没有原生 WebRTC 栈，装不出真加密，
//   不假装支持。真加密等 mediasoup 接线（它的 DTLS-SRTP 是原生栈能力）。
//
// 跨进程：房间元数据进 ~/.nyra/sfu-rooms.json（原子写 0600），帧进
// sfu-frames-<roomId>.jsonl（追加写，封顶 1000 行），录制进
// sfu-recordings-<roomId>.jsonl。CLI 每次调用都是新进程，靠这两个
// 文件接力——房间不是内存对象。
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";

export type SfuEncryption = "none" | "dtls-srtp";
export type SfuRole = "speaker" | "listener";

/** 群组语音房最多几个说话者（OpenClaw Discord 房形态：一个 agent + N 个说话者）。 */
export const SFU_MAX_SPEAKERS = 8;
export const SFU_MAX_LISTENERS = 32;
/** 闲置回收：60 秒无人说话就关房。 */
export const SFU_IDLE_TIMEOUT_MS = 60 * 1000;
/** TURN 凭据默认 TTL：1 小时。 */
export const SFU_TURN_DEFAULT_TTL_S = 3600;
export const SFU_TURN_MIN_TTL_S = 60;
export const SFU_TURN_MAX_TTL_S = 24 * 3600;
/** 每房间帧文件封顶行数（只记指纹，不存音频）。 */
export const SFU_MAX_FRAMES = 1000;

export const SFU_ROOMS_FILE = "sfu-rooms.json";

/**
 * SFU 选型定案（写进文档与 PUSH-PLAN，不只留代码里）：
 * mediasoup，Node 原生 SFU 库；LiveKit 要另起 Go 服务进程，与 Nyra
 * 单 Node 运行时方向拧着，且本机没装 Go。真接线下一步再做。
 */
export const SFU_SELECTION = {
  provider: "mediasoup",
  reason: "Node 原生 SFU 库，直接嵌进 Nyra 的单 Node 运行时；LiveKit 须另起 Go 服务进程，与方向拧着，本机也没装 Go。",
} as const;

export function sfuSelectionNote(): string {
  return `SFU 选型：${SFU_SELECTION.provider}——${SFU_SELECTION.reason}本批只做抽象层 + 本地确定性实现，不装真服务、不起真 mediasoup。`;
}

export class SfuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfuError";
  }
}

export interface SfuMember {
  peer: string;
  role: SfuRole;
  joined_at: string;
  last_activity_at: string;
  recording_consented: boolean;
}

export interface SfuRoomMeta {
  id: string;
  encryption: SfuEncryption;
  members: SfuMember[];
  recording: boolean;
  created_at: string;
  last_activity_at: string;
  closed_at: string | null;
  /** 房间 TURN 密钥（随机串，只存本机 0600 账本里，不进事件）。 */
  turn_key: string;
}

export interface SfuRoomStore {
  version: 1;
  rooms: SfuRoomMeta[];
}

export interface SfuFrame {
  room: string;
  speaker: string;
  seq: number;
  fingerprint: string;
  at: string;
}

export interface TurnCredential {
  username: string;
  password: string;
  expires_at: string;
  ttl_seconds: number;
}

export function sfuRoomsPath(home: string): string {
  return join(resolveNyraHome(home), SFU_ROOMS_FILE);
}

function framesPath(home: string, roomId: string): string {
  return join(resolveNyraHome(home), `sfu-frames-${roomId}.jsonl`);
}

function recordingsPath(home: string, roomId: string): string {
  return join(resolveNyraHome(home), `sfu-recordings-${roomId}.jsonl`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

function loadRooms(home: string): SfuRoomStore {
  const path = sfuRoomsPath(home);
  if (!existsSync(path)) return { version: 1, rooms: [] };
  if (lstatSync(path).isSymbolicLink()) throw new SfuError("SFU 房间账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new SfuError("SFU 房间账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as SfuRoomStore).version !== 1 ||
    !Array.isArray((raw as SfuRoomStore).rooms)) {
    backupCorrupt(path);
    throw new SfuError("SFU 房间账本格式无效，已备份");
  }
  return raw as SfuRoomStore;
}

function saveRooms(home: string, store: SfuRoomStore): void {
  const path = sfuRoomsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new SfuError("SFU 房间账本不能是符号链接");
  const tmp = join(dirname(path), `.sfu-rooms-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function readFrames(home: string, roomId: string): SfuFrame[] {
  const path = framesPath(home, roomId);
  if (!existsSync(path)) return [];
  const out: SfuFrame[] = [];
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const f = JSON.parse(t) as SfuFrame;
        if (f && typeof f.speaker === "string" && typeof f.seq === "number") out.push(f);
      } catch { continue; }
    }
  } catch {
    return [];
  }
  return out;
}

function appendFrame(home: string, frame: SfuFrame): void {
  const path = framesPath(home, frame.room);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(frame) + "\n", "utf-8");
  // 封顶：超了就只留最新 1000 行（帧只是指纹，不存音频，截断不丢内容）。
  const frames = readFrames(home, frame.room);
  if (frames.length > SFU_MAX_FRAMES) {
    const kept = frames.slice(-SFU_MAX_FRAMES);
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, kept.map((f) => JSON.stringify(f)).join("\n") + "\n", null, "utf-8");
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  }
}

/** SfuProvider 抽象层：真 mediasoup 接线时实现同一接口，本地实现只是其中一种。 */
export interface SfuProvider {
  readonly kind: string;
  /** 本实现支持的加密形态（本地只有 none；mediasoup 真实现再加 dtls-srtp）。 */
  encryptionModes(): SfuEncryption[];
}

export interface SfuRegistryOptions {
  /** 测试注入的时钟（默认 Date.now）。 */
  now?: () => number;
  /** 事件回调（CLI 接 RunStore；测试可注入收集器）。 */
  emit?: (type: string, fields: Record<string, unknown>) => void;
}

export class SfuRegistry implements SfuProvider {
  readonly kind = "local";
  private home: string;
  private nowFn: () => number;
  private emitFn: ((type: string, fields: Record<string, unknown>) => void) | null;

  constructor(home: string, opts: SfuRegistryOptions = {}) {
    this.home = home;
    this.nowFn = opts.now ?? Date.now;
    this.emitFn = opts.emit ?? null;
  }

  encryptionModes(): SfuEncryption[] {
    return ["none"];
  }

  private emit(type: string, fields: Record<string, unknown>): void {
    try { this.emitFn?.(type, fields); } catch { /* 观察器故障不破坏 SFU 操作 */ }
  }

  private recordRunEvent(type: string, fields: Record<string, unknown>): void {
    if (this.emitFn) {
      this.emit(type, fields);
      return;
    }
    try {
      const store = new RunStore(join(resolveNyraHome(this.home), "runs"));
      const state = store.create(`群组语音：${type}`, "sfu", process.cwd(), "readonly", 1, "running");
      store.appendEvent(state.run_id, type, fields);
      store.setStatus(state.run_id, "completed_unverified");
    } catch { /* 证据写失败不破坏 SFU 操作本身 */ }
  }

  private findRoom(store: SfuRoomStore, roomId: string): SfuRoomMeta | undefined {
    return store.rooms.find((r) => r.id === roomId);
  }

  private requireRoom(roomId: string): { store: SfuRoomStore; room: SfuRoomMeta } {
    const store = loadRooms(this.home);
    const room = this.findRoom(store, roomId);
    if (!room) throw new SfuError(`没有这个语音房：${roomId}`);
    if (room.closed_at) throw new SfuError(`语音房 ${roomId} 已关闭`);
    return { store, room };
  }

  /** 建房：加密只认 none（本地没有原生 WebRTC 栈，dtls-srtp 明确拒绝，不假装支持）。 */
  createRoom(opts: { id?: string; encryption?: SfuEncryption } = {}): SfuRoomMeta {
    const encryption = opts.encryption ?? "none";
    if (encryption !== "none") {
      throw new SfuError("本地 SFU 不支持 dtls-srtp：没有原生 WebRTC 栈，真加密须等 mediasoup 接线；本地只做 none（进程内内存转发，不走网络）");
    }
    const id = opts.id?.trim() || `sfu-${randomBytes(6).toString("hex")}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(id)) throw new SfuError("语音房 id 只认字母数字、下划线或连字符（最多 32 字）");
    const store = loadRooms(this.home);
    if (this.findRoom(store, id)) throw new SfuError(`语音房 ${id} 已存在`);
    const at = new Date(this.nowFn()).toISOString();
    const room: SfuRoomMeta = {
      id, encryption, members: [], recording: false,
      created_at: at, last_activity_at: at, closed_at: null,
      turn_key: randomBytes(32).toString("hex"),
    };
    store.rooms.push(room);
    saveRooms(this.home, store);
    this.recordRunEvent("sfu_room_created", { room: id, encryption });
    return room;
  }

  getRoom(roomId: string): SfuRoomMeta | null {
    const store = loadRooms(this.home);
    return this.findRoom(store, roomId) ?? null;
  }

  listRooms(): SfuRoomMeta[] {
    return loadRooms(this.home).rooms;
  }

  /** 进房：说话者上限 8，听众上限 32；已在房里直接返回现状。 */
  joinRoom(roomId: string, peer: string, role: SfuRole = "speaker"): SfuRoomMeta {
    const { store, room } = this.requireRoom(roomId);
    const existing = room.members.find((m) => m.peer === peer);
    if (existing) {
      if (existing.role !== role) {
        existing.role = role;
        saveRooms(this.home, store);
      }
      return room;
    }
    const speakers = room.members.filter((m) => m.role === "speaker").length;
    const listeners = room.members.filter((m) => m.role === "listener").length;
    if (role === "speaker" && speakers >= SFU_MAX_SPEAKERS) {
      throw new SfuError(`语音房 ${roomId} 说话者已满（${SFU_MAX_SPEAKERS} 个）：先等有人离开再进`);
    }
    if (role === "listener" && listeners >= SFU_MAX_LISTENERS) {
      throw new SfuError(`语音房 ${roomId} 听众已满（${SFU_MAX_LISTENERS} 个）`);
    }
    const at = new Date(this.nowFn()).toISOString();
    room.members.push({ peer, role, joined_at: at, last_activity_at: at, recording_consented: false });
    room.last_activity_at = at;
    saveRooms(this.home, store);
    this.recordRunEvent("sfu_peer_joined", { room: roomId, peer });
    return room;
  }

  /** 离房：人都走光了房间不自动关（等闲置回收统一关，保证“最后一个人走后 60 秒才关”的口径一致）。 */
  leaveRoom(roomId: string, peer: string): SfuRoomMeta {
    const { store, room } = this.requireRoom(roomId);
    const idx = room.members.findIndex((m) => m.peer === peer);
    if (idx < 0) throw new SfuError(`${peer} 不在语音房 ${roomId} 里`);
    room.members.splice(idx, 1);
    room.last_activity_at = new Date(this.nowFn()).toISOString();
    saveRooms(this.home, store);
    this.recordRunEvent("sfu_peer_left", { room: roomId, peer });
    return room;
  }

  /**
   * 说话者发一帧：payload 本身不存，只记 SHA-256 前 12 位指纹 + 序号。
   * 听众发帧直接拒绝；不在房里拒绝。发帧即活动（刷新闲置计时）。
   * 录制开着且发言者已 consent 时，帧另记一份进录制文件。
   */
  publish(roomId: string, peer: string, payload: string): SfuFrame {
    const { store, room } = this.requireRoom(roomId);
    const member = room.members.find((m) => m.peer === peer);
    if (!member) throw new SfuError(`${peer} 不在语音房 ${roomId} 里，先进房再说话`);
    if (member.role !== "speaker") throw new SfuError(`${peer} 是听众，不能在语音房 ${roomId} 里说话（说话者上限 ${SFU_MAX_SPEAKERS} 个）`);
    const frames = readFrames(this.home, roomId);
    const seq = frames.length ? frames[frames.length - 1].seq + 1 : 1;
    const frame: SfuFrame = {
      room: roomId,
      speaker: peer,
      seq,
      fingerprint: createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 12),
      at: new Date(this.nowFn()).toISOString(),
    };
    appendFrame(this.home, frame);
    if (room.recording && member.recording_consented) {
      try {
        appendFileSync(recordingsPath(this.home, roomId), JSON.stringify(frame) + "\n", "utf-8");
      } catch { /* 录制写失败不破坏转发本身 */ }
    }
    member.last_activity_at = frame.at;
    room.last_activity_at = frame.at;
    saveRooms(this.home, store);
    return frame;
  }

  /** 订阅：取某说话者序号之后的所有帧（指纹，不含音频）。 */
  framesSince(roomId: string, speaker: string, seq: number): SfuFrame[] {
    const { room } = this.requireRoom(roomId);
    void room;
    return readFrames(this.home, roomId).filter((f) => f.speaker === speaker && f.seq > seq);
  }

  /**
   * 签发 TURN 凭据（带 TTL）：用户名含过期时间戳，密码是房间密钥的 HMAC。
   * 凭据只用于本房间的中继；过期须重新签发（validateTurnCredential 验不过）。
   */
  issueTurnCredential(roomId: string, peer: string, ttlSeconds = SFU_TURN_DEFAULT_TTL_S): TurnCredential {
    const { room } = this.requireRoom(roomId);
    const member = room.members.find((m) => m.peer === peer);
    if (!member) throw new SfuError(`${peer} 不在语音房 ${roomId} 里，先进房再拿 TURN 凭据`);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < SFU_TURN_MIN_TTL_S || ttlSeconds > SFU_TURN_MAX_TTL_S) {
      throw new SfuError(`TURN 凭据 TTL 只能是 ${SFU_TURN_MIN_TTL_S}–${SFU_TURN_MAX_TTL_S} 秒（默认 ${SFU_TURN_DEFAULT_TTL_S} 秒）`);
    }
    const expiresAt = new Date(this.nowFn() + ttlSeconds * 1000).toISOString();
    const username = `sfu-${roomId}-${peer}-${Math.floor(Date.parse(expiresAt) / 1000)}`;
    const password = createHmac("sha256", room.turn_key).update(username).digest("hex");
    this.recordRunEvent("sfu_turn_credential_issued", { room: roomId, peer, expires_at: expiresAt });
    return { username, password, expires_at: expiresAt, ttl_seconds: ttlSeconds };
  }

  /** 验 TURN 凭据：用户名里的过期时间戳 + HMAC 都对上、且没过期才认。 */
  validateTurnCredential(roomId: string, cred: TurnCredential): boolean {
    const room = this.getRoom(roomId);
    if (!room || room.closed_at) return false;
    if (Date.parse(cred.expires_at) <= this.nowFn()) return false;
    const expected = createHmac("sha256", room.turn_key).update(cred.username).digest("hex");
    if (expected !== cred.password) return false;
    const m = cred.username.match(/-(\d+)$/);
    // 用户名里存的是秒级过期时间戳：按秒比对（过期时间本身带毫秒，
    // 逐毫秒比对会让刚签发的凭据也验不过）。
    if (!m || Number(m[1]) !== Math.floor(Date.parse(cred.expires_at) / 1000)) return false;
    return true;
  }

  /** 录制同意：每人表态一次（缺口 39 的全体同意门同款口径）。 */
  consentRecording(roomId: string, peer: string): SfuRoomMeta {
    const { store, room } = this.requireRoom(roomId);
    const member = room.members.find((m) => m.peer === peer);
    if (!member) throw new SfuError(`${peer} 不在语音房 ${roomId} 里`);
    member.recording_consented = true;
    saveRooms(this.home, store);
    return room;
  }

  /** 开录制：房里每个人都 consent 了才开；有人没表态就报出名字（不静默开）。 */
  startRecording(roomId: string): SfuRoomMeta {
    const { store, room } = this.requireRoom(roomId);
    if (room.recording) return room;
    const missing = room.members.filter((m) => !m.recording_consented).map((m) => m.peer);
    if (missing.length) {
      throw new SfuError(`录制开不了：以下成员还没同意录制（全体同意门）：${missing.join("、")}`);
    }
    room.recording = true;
    saveRooms(this.home, store);
    this.recordRunEvent("sfu_recording_started", { room: roomId, consented_by: room.members.map((m) => m.peer).join(",") });
    return room;
  }

  stopRecording(roomId: string): SfuRoomMeta {
    const { store, room } = this.requireRoom(roomId);
    room.recording = false;
    saveRooms(this.home, store);
    return room;
  }

  /** 闲置回收：最后活动超过 60 秒的房间关掉、清帧文件；返回关掉的房间 id。 */
  reclaimIdleRooms(): string[] {
    const store = loadRooms(this.home);
    const now = this.nowFn();
    const reclaimed: string[] = [];
    for (const room of store.rooms) {
      if (room.closed_at) continue;
      if (Date.parse(room.last_activity_at) + SFU_IDLE_TIMEOUT_MS > now) continue;
      room.closed_at = new Date(now).toISOString();
      try { rmSync(framesPath(this.home, room.id), { force: true }); } catch { /* ignore */ }
      reclaimed.push(room.id);
      this.recordRunEvent("sfu_room_closed", { room: room.id, reason: "idle-timeout" });
    }
    if (reclaimed.length) saveRooms(this.home, store);
    return reclaimed;
  }

  /** 手动关房：清帧文件，录制文件保留（录制是证据，不随关房删）。 */
  closeRoom(roomId: string, reason = "manual"): boolean {
    const store = loadRooms(this.home);
    const room = this.findRoom(store, roomId);
    if (!room || room.closed_at) return false;
    room.closed_at = new Date(this.nowFn()).toISOString();
    saveRooms(this.home, store);
    try { rmSync(framesPath(this.home, roomId), { force: true }); } catch { /* ignore */ }
    this.recordRunEvent("sfu_room_closed", { room: roomId, reason });
    return true;
  }
}
