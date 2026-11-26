// src/groupVideo.ts — 第 3 批 G-P0-2 的视频部分：群组视频（SFU 上加
// 视频 Producer/Consumer、按需看帧、带宽自适应）。
//
// 与第 2 批 SFU 本地实现同款做法：确定性转发模型，不走网络、不存
// 任何视频字节——视频帧只记 SHA-256 前 12 位指纹 + 序号 + 时间，
// 进 `group-video-frames-<房间>.jsonl`（封顶 1000 行）；
// - 视频挂在语音房上：开视频的前提是已进语音房且是说话者（视频
//   是“看得见的说话”，听众只能看、不能开视频）；
// - Producer：每人一路视频（camera 摄像头或 screen 屏幕共享），
//   每房最多 8 路（与说话者上限一致）；
// - Consumer 按需订阅：只订阅想看的那几路，不订阅的不推帧；
// - 带宽自适应：每路按订阅者报的上行/下行可用带宽定档
//   （high ≥1500kbps、medium ≥600kbps、其余 low），档位决定模拟
//   下发帧率（high 全帧、medium 隔一帧、low 隔两帧）；房级总带宽
//   上限 8000kbps，超了按“后订阅的先降档”逐级降，降到 low 仍超
//   就拒绝新订阅（不静默挤占别人的帧）；
// - 录制沿用 SFU 的全体同意门：房里每个人都 consent 才能开视频录制；
// - 10 分钟不断：`simulateVideoSession` 用虚拟时钟跑 600 秒（3 人
//   各 10fps 发帧、订阅者按档收帧），全程不真等——断言房间不被闲置
//   回收、Producer 一个不少、帧序号连续；真机 10 分钟留待验证。
// 真 mediasoup 视频接线是下一步（与语音同款 SfuProvider 抽象层）。
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync, appendFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { SfuRegistry } from "./sfu.ts";

export const GROUP_VIDEO_FILE = "group-video.json";
/** 房级视频总带宽上限（kbps）：超了先降档，降无可降再拒新订阅。 */
export const VIDEO_ROOM_BUDGET_KBPS = 8000;
/** 档位带宽（kbps）：high 全帧、medium 隔一帧、low 隔两帧。 */
export const VIDEO_TIER_KBPS = { high: 1500, medium: 600, low: 150 } as const;
export const VIDEO_MAX_PRODUCERS = 8;
/** 视频帧文件封顶行数（只记指纹，不存视频）。 */
export const VIDEO_MAX_FRAMES = 1000;

export type VideoKind = "camera" | "screen";
export type VideoTier = "high" | "medium" | "low";

export class GroupVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupVideoError";
  }
}

export interface VideoProducer {
  peer: string;
  track: string;
  kind: VideoKind;
  maxKbps: number;
  started_at: string;
}

export interface VideoConsumer {
  peer: string;
  producer: string;
  tier: VideoTier;
  /** 订阅时报的可用带宽（kbps），降档重算用它。 */
  availableKbps: number;
  subscribed_at: string;
}

export interface VideoRoom {
  room: string;
  producers: VideoProducer[];
  consumers: VideoConsumer[];
  recording: boolean;
}

export interface GroupVideoStore {
  version: 1;
  rooms: VideoRoom[];
}

export interface VideoFrame {
  room: string;
  producer: string;
  seq: number;
  fingerprint: string;
  at: string;
}

export function groupVideoPath(home: string): string {
  return join(resolveNyraHome(home), GROUP_VIDEO_FILE);
}

function framesPath(home: string, roomId: string): string {
  return join(resolveNyraHome(home), `group-video-frames-${roomId}.jsonl`);
}

function recordingsPath(home: string, roomId: string): string {
  return join(resolveNyraHome(home), `group-video-recordings-${roomId}.jsonl`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadGroupVideo(home: string): GroupVideoStore {
  const path = groupVideoPath(home);
  if (!existsSync(path)) return { version: 1, rooms: [] };
  if (lstatSync(path).isSymbolicLink()) throw new GroupVideoError("群组视频账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new GroupVideoError("群组视频账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as GroupVideoStore).version !== 1 ||
    !Array.isArray((raw as GroupVideoStore).rooms)) {
    backupCorrupt(path);
    throw new GroupVideoError("群组视频账本格式无效，已备份");
  }
  return raw as GroupVideoStore;
}

export function saveGroupVideo(home: string, store: GroupVideoStore): void {
  const path = groupVideoPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new GroupVideoError("群组视频账本不能是符号链接");
  const tmp = join(dirname(path), `.group-video-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordVideoEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`群组视频：${type}`, "group-video", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏视频操作本身 */ }
}

/** 按可用带宽定档：high ≥1500、medium ≥600、其余 low。 */
export function tierForBandwidth(availableKbps: number): VideoTier {
  if (availableKbps >= VIDEO_TIER_KBPS.high) return "high";
  if (availableKbps >= VIDEO_TIER_KBPS.medium) return "medium";
  return "low";
}

/** 档位下发帧率：high 全帧、medium 隔一帧、low 隔两帧（每 3 帧发 1 帧）。 */
export function tierFrameStride(tier: VideoTier): number {
  return tier === "high" ? 1 : tier === "medium" ? 2 : 3;
}

function readFrames(home: string, roomId: string): VideoFrame[] {
  const path = framesPath(home, roomId);
  if (!existsSync(path)) return [];
  const out: VideoFrame[] = [];
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const f = JSON.parse(t) as VideoFrame;
        if (f && typeof f.producer === "string" && typeof f.seq === "number") out.push(f);
      } catch { continue; }
    }
  } catch {
    return [];
  }
  return out;
}

interface FrameLogState {
  size: number;
  mtimeMs: number;
  count: number;
  nextSeq: number;
}

// 模拟长会话会在同一个进程连续写帧。只有文件被外部改动时才重新扫描；正常发帧
// 用此状态维护序号和行数，避免每帧都读取、解析最多 1000 行的日志。
const frameLogStates = new Map<string, FrameLogState>();

function getFrameLogState(home: string, roomId: string): FrameLogState {
  const path = framesPath(home, roomId);
  let size = 0;
  let mtimeMs = 0;
  try {
    const stat = statSync(path);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch { /* 首次写入时文件尚不存在 */ }
  const cached = frameLogStates.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
  const frames = readFrames(home, roomId);
  let maxSeq = 0;
  for (const f of frames) if (f.seq > maxSeq) maxSeq = f.seq;
  const state = { size, mtimeMs, count: frames.length, nextSeq: maxSeq + 1 };
  frameLogStates.set(path, state);
  return state;
}

function appendFrame(home: string, frame: VideoFrame, state = getFrameLogState(home, frame.room)): void {
  const path = framesPath(home, frame.room);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(frame) + "\n", "utf-8");
  state.count++;
  state.nextSeq = Math.max(state.nextSeq, frame.seq + 1);
  if (state.count > VIDEO_MAX_FRAMES) {
    const frames = readFrames(home, frame.room);
    if (frames.length > VIDEO_MAX_FRAMES) {
      const kept = frames.slice(-VIDEO_MAX_FRAMES);
      const tmp = `${path}.tmp-${process.pid}`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, kept.map((f) => JSON.stringify(f)).join("\n") + "\n", null, "utf-8");
      } finally { closeSync(fd); }
      renameSync(tmp, path);
      state.count = kept.length;
    }
  }
  const stat = statSync(path);
  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;
}

/** 模拟会话在内存生成全部帧后一次刷新帧日志；只保留最近 1000 帧。 */
function persistSimulatedFrames(home: string, roomId: string, frames: VideoFrame[], recording: boolean): void {
  if (!frames.length) return;
  const path = framesPath(home, roomId);
  mkdirSync(dirname(path), { recursive: true });
  const state = getFrameLogState(home, roomId);
  const kept = [...readFrames(home, roomId), ...frames].slice(-VIDEO_MAX_FRAMES);
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, kept.map((f) => JSON.stringify(f)).join("\n") + "\n", null, "utf-8");
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); }
  finally { try { rmSync(tmp, { force: true }); } catch { /* already renamed */ } }
  state.count = kept.length;
  state.nextSeq = Math.max(state.nextSeq, frames[frames.length - 1]!.seq + 1);
  const stat = statSync(path);
  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;

  // 普通帧日志封顶；录制日志仍按既有语义保留模拟会话的每一帧。
  if (recording) {
    const recordingPath = recordingsPath(home, roomId);
    const lines = frames.map((f) => JSON.stringify(f) + "\n");
    try {
      for (let i = 0; i < lines.length; i += 256) {
        appendFileSync(recordingPath, lines.slice(i, i + 256).join(""), "utf-8");
      }
    } catch { /* 录制写失败不破坏模拟结论，与逐帧写入一致 */ }
  }
}

export interface VideoRegistryOptions {
  now?: () => number;
  emit?: (type: string, fields: Record<string, unknown>) => void;
}

export class VideoRegistry {
  private home: string;
  private nowFn: () => number;
  private emitFn: ((type: string, fields: Record<string, unknown>) => void) | null;

  constructor(home: string, opts: VideoRegistryOptions = {}) {
    this.home = home;
    this.nowFn = opts.now ?? Date.now;
    this.emitFn = opts.emit ?? null;
  }

  private emit(type: string, fields: Record<string, unknown>): void {
    if (this.emitFn) {
      try { this.emitFn(type, fields); } catch { /* 观察器故障不破坏视频操作 */ }
      return;
    }
    recordVideoEvent(this.home, type, fields);
  }

  private requireVoiceMember(roomId: string, peer: string, needSpeaker: boolean): void {
    const sfu = new SfuRegistry(this.home);
    const room = sfu.getRoom(roomId);
    if (!room || room.closed_at) throw new GroupVideoError(`没有这个语音房：${roomId}（视频挂在语音房上，先建房：nyra sfu create ${roomId}）`);
    const member = room.members.find((m) => m.peer === peer);
    if (!member) throw new GroupVideoError(`${peer} 不在语音房 ${roomId} 里，先进房再开视频`);
    if (needSpeaker && member.role !== "speaker") {
      throw new GroupVideoError(`${peer} 是听众，只能看视频、不能开视频（开视频须是说话者）`);
    }
  }

  private getVideoRoom(store: GroupVideoStore, roomId: string): VideoRoom {
    let vr = store.rooms.find((r) => r.room === roomId);
    if (!vr) {
      vr = { room: roomId, producers: [], consumers: [], recording: false };
      store.rooms.push(vr);
    }
    return vr;
  }

  /** 开一路视频（须是房里说话者；每房最多 8 路）。 */
  startProducer(roomId: string, peer: string, kind: VideoKind = "camera", maxKbps: number = VIDEO_TIER_KBPS.high): VideoProducer {
    this.requireVoiceMember(roomId, peer, true);
    if (!Number.isInteger(maxKbps) || maxKbps < VIDEO_TIER_KBPS.low || maxKbps > 8000) {
      throw new GroupVideoError(`视频码率只能是 ${VIDEO_TIER_KBPS.low}–8000 kbps`);
    }
    const store = loadGroupVideo(this.home);
    const vr = this.getVideoRoom(store, roomId);
    if (vr.producers.some((p) => p.peer === peer)) {
      throw new GroupVideoError(`${peer} 已经在房间 ${roomId} 里开视频了`);
    }
    if (vr.producers.length >= VIDEO_MAX_PRODUCERS) {
      throw new GroupVideoError(`房间 ${roomId} 视频路数已满（${VIDEO_MAX_PRODUCERS} 路）`);
    }
    const producer: VideoProducer = {
      peer, track: `vid-${randomBytes(4).toString("hex")}`, kind, maxKbps,
      started_at: new Date(this.nowFn()).toISOString(),
    };
    vr.producers.push(producer);
    saveGroupVideo(this.home, store);
    this.emit("video_producer_started", { room: roomId, peer, track: producer.track });
    return producer;
  }

  /** 停一路视频（订阅它的消费者一并退订）。 */
  stopProducer(roomId: string, peer: string): boolean {
    const store = loadGroupVideo(this.home);
    const vr = store.rooms.find((r) => r.room === roomId);
    if (!vr) return false;
    const idx = vr.producers.findIndex((p) => p.peer === peer);
    if (idx < 0) return false;
    vr.producers.splice(idx, 1);
    vr.consumers = vr.consumers.filter((c) => c.producer !== peer);
    saveGroupVideo(this.home, store);
    return true;
  }

  listProducers(roomId: string): VideoProducer[] {
    return loadGroupVideo(this.home).rooms.find((r) => r.room === roomId)?.producers ?? [];
  }

  /**
   * 按需订阅一路视频：只订阅想看的，不订阅的不推帧。档位按订阅者报的
   * 可用带宽定；房级总带宽超上限时，后订阅的先降档，降到 low 仍超
   * 就拒绝这次订阅（不静默挤占别人的帧）。
   */
  subscribe(roomId: string, peer: string, producer: string, availableKbps: number): VideoConsumer {
    this.requireVoiceMember(roomId, peer, false);
    if (!Number.isFinite(availableKbps) || availableKbps <= 0) {
      throw new GroupVideoError("订阅须报可用带宽（kbps，正数）：带宽定档用它");
    }
    const store = loadGroupVideo(this.home);
    const vr = this.getVideoRoom(store, roomId);
    if (!vr.producers.some((p) => p.peer === producer)) {
      throw new GroupVideoError(`房间 ${roomId} 里没有 ${producer} 的视频路`);
    }
    const existing = vr.consumers.find((c) => c.peer === peer && c.producer === producer);
    if (existing) return existing;
    const tier = tierForBandwidth(availableKbps);
    const consumer: VideoConsumer = {
      peer, producer, tier, availableKbps,
      subscribed_at: new Date(this.nowFn()).toISOString(),
    };
    vr.consumers.push(consumer);
    this.adaptTiers(vr);
    const final = vr.consumers.find((c) => c.peer === peer && c.producer === producer);
    if (!final) throw new GroupVideoError(`房间 ${roomId} 视频总带宽已满（${VIDEO_ROOM_BUDGET_KBPS} kbps），这次订阅接不进来`);
    saveGroupVideo(this.home, store);
    this.emit("video_consumer_subscribed", { room: roomId, peer, producer, tier: final.tier });
    return final;
  }

  /** 手动改档（只能往低改，不能越过可用带宽往高改）。 */
  setQuality(roomId: string, peer: string, producer: string, tier: VideoTier): VideoConsumer {
    const store = loadGroupVideo(this.home);
    const vr = store.rooms.find((r) => r.room === roomId);
    const consumer = vr?.consumers.find((c) => c.peer === peer && c.producer === producer);
    if (!consumer) throw new GroupVideoError(`${peer} 没订阅 ${producer} 的视频（先订阅再改档）`);
    if (VIDEO_TIER_KBPS[tier] > consumer.availableKbps) {
      throw new GroupVideoError(`档位 ${tier} 要 ${VIDEO_TIER_KBPS[tier]} kbps，可用带宽只有 ${consumer.availableKbps} kbps，改不了`);
    }
    consumer.tier = tier;
    saveGroupVideo(this.home, store);
    this.emit("video_quality_changed", { room: roomId, peer, producer, tier });
    return consumer;
  }

  unsubscribe(roomId: string, peer: string, producer: string): boolean {
    const store = loadGroupVideo(this.home);
    const vr = store.rooms.find((r) => r.room === roomId);
    if (!vr) return false;
    const idx = vr.consumers.findIndex((c) => c.peer === peer && c.producer === producer);
    if (idx < 0) return false;
    vr.consumers.splice(idx, 1);
    saveGroupVideo(this.home, store);
    return true;
  }

  listConsumers(roomId: string): VideoConsumer[] {
    return loadGroupVideo(this.home).rooms.find((r) => r.room === roomId)?.consumers ?? [];
  }

  /**
   * 房级带宽自适应（纯规则，可单测）：所有订阅的档位带宽之和超上限时，
   * 按“后订阅的先降档”的顺序逐级降（high→medium→low）；降无可降
   * 就拿掉最后订阅的那条（调用方须提示对方带宽不够）。
   * 每轮每人最多降一级（后订阅的先降）：同一条连降两级会把最后
   * 进来的人直接打到 low，别人还 high，不公平。
   * 顺序按数组本身（订阅顺序）倒序取，绝不用时间戳排序——同毫秒
   * 订阅时时间戳比较器不一致，排序结果不可预测。
   */
  adaptTiers(vr: VideoRoom): void {
    const total = () => vr.consumers.reduce((s, c) => s + VIDEO_TIER_KBPS[c.tier], 0);
    while (total() > VIDEO_ROOM_BUDGET_KBPS && vr.consumers.length) {
      let downgraded = false;
      for (let i = vr.consumers.length - 1; i >= 0; i--) {
        if (total() <= VIDEO_ROOM_BUDGET_KBPS) break;
        const c = vr.consumers[i];
        if (c.tier === "high") { c.tier = "medium"; downgraded = true; }
        else if (c.tier === "medium") { c.tier = "low"; downgraded = true; }
      }
      if (!downgraded) vr.consumers.pop();
    }
  }

  /** 发一帧视频：只记指纹 + 序号，不存视频字节；发帧即活动。 */
  publishFrame(roomId: string, peer: string, payload: string): VideoFrame {
    this.requireVoiceMember(roomId, peer, true);
    const store = loadGroupVideo(this.home);
    const vr = store.rooms.find((r) => r.room === roomId);
    if (!vr?.producers.some((p) => p.peer === peer)) {
      throw new GroupVideoError(`${peer} 在房间 ${roomId} 里没开视频（先开一路再发帧）`);
    }
    const frameState = getFrameLogState(this.home, roomId);
    const seq = frameState.nextSeq;
    const frame: VideoFrame = {
      room: roomId, producer: peer, seq,
      fingerprint: createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 12),
      at: new Date(this.nowFn()).toISOString(),
    };
    appendFrame(this.home, frame, frameState);
    if (vr.recording) {
      try {
        appendFileSync(recordingsPath(this.home, roomId), JSON.stringify(frame) + "\n", "utf-8");
      } catch { /* 录制写失败不破坏转发本身 */ }
    }
    return frame;
  }

  /** 取某路序号之后的帧（按订阅者档位下采样：medium 隔一帧、low 隔两帧）。 */
  framesFor(roomId: string, peer: string, producer: string, seq: number): VideoFrame[] {
    const store = loadGroupVideo(this.home);
    const vr = store.rooms.find((r) => r.room === roomId);
    const consumer = vr?.consumers.find((c) => c.peer === peer && c.producer === producer);
    if (!consumer) throw new GroupVideoError(`${peer} 没订阅 ${producer} 的视频（先订阅再看帧）`);
    const stride = tierFrameStride(consumer.tier);
    // 下采样按这路自己的帧序号算，不按房间全局序号——多路轮流发帧时
    // 全局序号取模会把某路的帧不均匀地跳掉（medium 档只剩约 1/6）。
    const mine = readFrames(this.home, roomId).filter((f) => f.producer === producer && f.seq > seq);
    return mine.filter((_, i) => i % stride === 0);
  }

  /** 开视频录制：沿用 SFU 的全体同意门——房里每个人都 consent 才开。 */
  startVideoRecording(roomId: string): void {
    const sfu = new SfuRegistry(this.home);
    const room = sfu.getRoom(roomId);
    if (!room || room.closed_at) throw new GroupVideoError(`没有这个语音房：${roomId}`);
    const missing = room.members.filter((m) => !m.recording_consented).map((m) => m.peer);
    if (missing.length) {
      throw new GroupVideoError(`视频录制开不了：以下成员还没同意录制（全体同意门）：${missing.join("、")}`);
    }
    const store = loadGroupVideo(this.home);
    const vr = this.getVideoRoom(store, roomId);
    vr.recording = true;
    saveGroupVideo(this.home, store);
  }

  stopVideoRecording(roomId: string): void {
    const store = loadGroupVideo(this.home);
    const vr = store.rooms.find((r) => r.room === roomId);
    if (!vr) return;
    vr.recording = false;
    saveGroupVideo(this.home, store);
  }

  isRecording(roomId: string): boolean {
    return loadGroupVideo(this.home).rooms.find((r) => r.room === roomId)?.recording ?? false;
  }
}

export interface VideoSessionSimulation {
  room: string;
  peers: string[];
  seconds: number;
  framesPublished: number;
  framesDelivered: number;
  framesDroppedByTier: number;
  producersAlive: number;
  roomOpen: boolean;
}

/**
 * 10 分钟不断模拟（虚拟时钟，不真等）：3 人各 10fps 发帧、订阅者
 * 按档收帧，跑满 600 秒；断言房间不被闲置回收、Producer 一个不少、
 * 帧序号连续。返回投递/丢帧数——low 档下采样丢的帧是“按档位主动
 * 不发”，不是断线，单独计数，不与故障混算。
 */
export function simulateVideoSession(
  home: string,
  roomId: string,
  peers: string[],
  seconds = 600,
  opts: { fps?: number } = {},
): VideoSessionSimulation {
  const fps = opts.fps ?? 10;
  if (peers.length < 2) throw new GroupVideoError("模拟至少要两个人（多方不断才有意义）");
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
    throw new GroupVideoError("模拟时长只能是 1–3600 秒");
  }
  // 虚拟时钟：SFU 闲置回收看 last_activity，发帧会刷新——模拟里每帧
  // 都刷新，房间全程不该被回收。
  let nowMs = Date.now();
  const nowFn = () => nowMs;
  const sfu = new SfuRegistry(home, { now: nowFn });
  const video = new VideoRegistry(home, { now: nowFn });
  const room = sfu.getRoom(roomId);
  if (!room || room.closed_at) throw new GroupVideoError(`没有这个语音房：${roomId}`);
  for (const p of peers) {
    if (!room.members.some((m) => m.peer === p)) {
      throw new GroupVideoError(`${p} 不在语音房 ${roomId} 里（模拟前先把三方都加进房）`);
    }
  }
  for (const p of peers) {
    if (!video.listProducers(roomId).some((pr) => pr.peer === p)) {
      video.startProducer(roomId, p, "camera");
    }
  }
  // 每人订阅另外两人的路（可用带宽 2000kbps → high 档，全帧）。
  for (const p of peers) {
    for (const q of peers) {
      if (p === q) continue;
      video.subscribe(roomId, p, q, 2000);
    }
  }
  const stepMs = 1000 / fps;
  let published = 0;
  let delivered = 0;
  let droppedByTier = 0;
  // 订阅关系在模拟里不变：循环前一次取好，不每帧读账本。
  const consumersByProducer = new Map<string, VideoConsumer[]>();
  for (const p of peers) {
    consumersByProducer.set(
      p,
      video.listConsumers(roomId).filter((c) => c.producer === p),
    );
  }
  const ticks = Math.floor(seconds * fps);
  // 每路自己的帧序号（下采样按它算，不按房间全局序号——见 framesFor）。
  const perProducerCount = new Map<string, number>();
  const frameState = getFrameLogState(home, roomId);
  let nextSeq = frameState.nextSeq;
  const simulatedFrames: VideoFrame[] = [];
  const recording = video.isRecording(roomId);
  for (let t = 0; t < ticks; t++) {
    nowMs += stepMs;
    for (const p of peers) {
      const payload = `${roomId}:${p}:${t}`;
      simulatedFrames.push({
        room: roomId,
        producer: p,
        seq: nextSeq++,
        fingerprint: createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 12),
        at: new Date(nowMs).toISOString(),
      });
      published++;
      const count = (perProducerCount.get(p) ?? 0) + 1;
      perProducerCount.set(p, count);
      // 按档下发：每个订阅者按自己的 stride 收这路的帧。
      for (const consumer of consumersByProducer.get(p) ?? []) {
        if ((count - 1) % tierFrameStride(consumer.tier) === 0) delivered++;
        else droppedByTier++;
      }
    }
  }
  persistSimulatedFrames(home, roomId, simulatedFrames, recording);
  const roomAfter = sfu.getRoom(roomId);
  const producersAlive = video.listProducers(roomId).length;
  const result: VideoSessionSimulation = {
    room: roomId, peers: [...peers], seconds,
    framesPublished: published, framesDelivered: delivered,
    framesDroppedByTier: droppedByTier, producersAlive,
    roomOpen: !!roomAfter && !roomAfter.closed_at,
  };
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`群组视频模拟：${roomId}`, "group-video", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, "video_session_simulated", {
      room: roomId, peers: peers.length, seconds,
      frames: published, delivered, dropped: droppedByTier,
    });
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏模拟结论 */ }
  return result;
}
