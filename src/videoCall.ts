// src/videoCall.ts — 缺口 37：视频通话 + 按需视觉采样（§4.3 第二批，扩展缺口 16）。
//
// 做的是“1:1 视频通话的协商层 + 按需看”，不是一个完整的视频会议产品：
//   - 信令：本机 WebSocket 信令服务器 + 客户端，房间按通话 id 分，
//     交换的是 ICE 参数包（ufrag / 密码 / 候选地址），不是 SDP——SDP 描述
//     媒体会话，须原生 WebRTC 栈才有意义，本批没有（见下）；
//   - ICE：候选收集（host / srflx / relay）+ 连通性检查（STUN Binding
//     请求/响应，带 MESSAGE-INTEGRITY）+ 提名，STUN 与 TURN 都是纯 TS
//     实现（node:dgram），跑在真实 UDP 套接字上；
//   - 媒体面：协商成功后，视频帧走 ICE 提名出来的 UDP 直连通道（长度
//     前缀成帧），不是 DTLS-SRTP——原因见诚实边界；
//   - 按需看：采样三档（点一下才看 / 画面变化 / 定时），本地小视觉模型
//     优先（Ollama），云端视觉默认关、显式 opt-in 才走；
//   - 三本账分开：传输（字节、直连还是中转）/ 看（帧数、引擎、花费）/
//     干活（本次通话不把描述当任务跑，无 token 花费）。
//
// 诚实边界（本批没做的，别当成已做）：
//   - 没有原生 WebRTC 栈：本机装不上 wrtc（node-pre-gyp 不可用，
//     2026-11-21 实测安装失败），所以没有 DTLS-SRTP 媒体加密、没有 SDP、
//     没有 SFU——媒体通道是未加密的 ICE 直连 UDP，端到端加密状态片因此
//     不显示（按 SPEC §3.5：只有真正端到端时才显示）；多人视频会是缺口 39
//     的事，本批只做 1:1；
//   - 真 STUN/TURN 服务器未接通过：协商层只在本地假 STUN/TURN 服务器与
//     回环 ICE 上验过，公网 STUN（默认 stun.l.google.com:19302）与真实
//     TURN 须用户自己配了再试；TURN 密码只从环境变量或密码箱读，绝不写
//     配置文件；
//   - 画面变化检测须本机装 ffmpeg（与缺口 16 同款），没装时 change 档
//     直接报错、不静默降级；
//   - 真视觉模型未在真 API 上跑通，只在假 provider 上验过；本地 Ollama
//     须用户自己装并拉好视觉模型；
//   - 帧内容不进事件与日志，只记 SHA-256 前 12 位指纹；录制默认关，帧
//     落盘须通话双方都同意（本地同意 + 对方经信令发来的同意），缺一不可；
//   - CLI 是单次进程：协商由 `video call connect` 前台跑（连通后守住
//     会话、转发 spool 里的帧、收到对方帧写入 inbox），`start` 只建记录
//     不协商；Windows/macOS 真机未验证。
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync, copyFileSync } from "node:fs";
import { createSocket, type Socket } from "node:dgram";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunStore } from "./runs.ts";
import { UsageLedger } from "./usageLedger.ts";
import { computeCostUsd, resolvePricing } from "./cost.ts";
import { loadConfig, resolveProvider } from "./config.ts";
import { Provider } from "./providers.ts";
import { Vault } from "./vault.ts";
import { detectSensitiveIntent, type VoiceCallTransport } from "./voiceCall.ts";
import {
  buildVisionUserMessage, loadImageFile, modelSupportsVision,
  resolveVisionConfig, shortImageHash, visionGateMessage,
  type CommandRunner, type VisionImageInput,
} from "./vision.ts";
import type { UsageSnapshot } from "./usage.ts";

export class VideoCallError extends Error {}

/** 默认命令执行器（与 voice.ts 的 defaultRunner 同款：spawnSync，超时 120 秒）。 */
function defaultCommandRunner(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 120_000 });
    if (r.error) return { status: null, stdout: "", stderr: String((r.error as Error).message ?? r.error) };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err: unknown) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

// ---- 配置（config.json 的 video 一节，未配用默认值） ----

export type VideoSampleMode = "on-demand" | "change" | "timed";

export interface VideoCallConfig {
  /** 信令服务器地址，默认 ws://127.0.0.1:18789（本机信令，nyra video signal serve 起）。 */
  signalingUrl: string;
  /** STUN 服务器列表（stun:host:port），默认 ["stun:stun.l.google.com:19302"]。 */
  stunUrls: string[];
  /** TURN 服务器列表（turn:host:port / turns:host:port），默认 []（没配就只用直连）。 */
  turnUrls: string[];
  /** TURN 用户名，默认 ""。密码绝不放配置（见 resolveTurnCredential）。 */
  turnUsername: string;
  /** 采样档：on-demand 点一下才看 / change 画面变化 / timed 定时，默认 on-demand。 */
  sampleMode: VideoSampleMode;
  /** timed 档的采样间隔（秒），默认 10。 */
  sampleIntervalSeconds: number;
  /** change 档的判定阈值（0–1，16x16 签名平均绝对差），默认 0.08。 */
  changeThreshold: number;
  /** 单通电话最多描述几帧，默认 120。 */
  maxFramesPerCall: number;
  /** 通话里是否允许走云端视觉，默认关（显式 opt-in）。 */
  visionCloudEnabled: boolean;
  /** 本地视觉模型（如 qwen2.5-vl:3b，走 Ollama），默认 ""（不配 = 没有本地路）。 */
  visionLocalModel: string;
  /** 弱网判定：ICE 检查往返超过该毫秒数算弱网，默认 300。 */
  weakRttMs: number;
  /** 蜂窝省流量开关（最高 360p，弱网先关视频），默认关；只记进总结，不改码率（码率须原生栈）。 */
  cellSaver: boolean;
}

export const DEFAULT_VIDEO_CALL_CONFIG: VideoCallConfig = {
  signalingUrl: "ws://127.0.0.1:18789",
  stunUrls: ["stun:stun.l.google.com:19302"],
  turnUrls: [],
  turnUsername: "",
  sampleMode: "on-demand",
  sampleIntervalSeconds: 10,
  changeThreshold: 0.08,
  maxFramesPerCall: 120,
  visionCloudEnabled: false,
  visionLocalModel: "",
  weakRttMs: 300,
  cellSaver: false,
};

/** 配置解析：非法值回退默认值，不抛错、不挡运行。 */
export function resolveVideoCallConfig(config: Record<string, unknown>): VideoCallConfig {
  const raw = config.video;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (key: string, min: number, max: number, fallback: number): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return fallback;
    return v;
  };
  const strList = (key: string, fallback: string[]): string[] => {
    const v = o[key];
    if (!Array.isArray(v)) return fallback;
    const list = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return list.length > 0 ? list : fallback;
  };
  const modeRaw = typeof o.sample_mode === "string" ? o.sample_mode : "";
  const sampleMode: VideoSampleMode =
    modeRaw === "change" || modeRaw === "timed" ? modeRaw : "on-demand";
  const signalingUrl = typeof o.signaling_url === "string" && o.signaling_url.startsWith("ws")
    ? o.signaling_url
    : DEFAULT_VIDEO_CALL_CONFIG.signalingUrl;
  return {
    signalingUrl,
    stunUrls: strList("stun_urls", DEFAULT_VIDEO_CALL_CONFIG.stunUrls),
    turnUrls: strList("turn_urls", DEFAULT_VIDEO_CALL_CONFIG.turnUrls),
    turnUsername: typeof o.turn_username === "string" ? o.turn_username.slice(0, 100) : "",
    sampleMode,
    sampleIntervalSeconds: num("sample_interval_seconds", 1, 3600, DEFAULT_VIDEO_CALL_CONFIG.sampleIntervalSeconds),
    changeThreshold: num("change_threshold", 0.01, 0.9, DEFAULT_VIDEO_CALL_CONFIG.changeThreshold),
    maxFramesPerCall: num("max_frames_per_call", 1, 1000, DEFAULT_VIDEO_CALL_CONFIG.maxFramesPerCall),
    visionCloudEnabled: o.vision_cloud_enabled === true,
    visionLocalModel: typeof o.vision_local_model === "string" ? o.vision_local_model.slice(0, 200) : "",
    weakRttMs: num("weak_rtt_ms", 50, 5000, DEFAULT_VIDEO_CALL_CONFIG.weakRttMs),
    cellSaver: o.cell_saver === true,
  };
}

/**
 * TURN 密码解析：环境变量 NYRA_TURN_CREDENTIAL 优先，其次密码箱条目
 * video-turn-credential（须 NYRA_VAULT_PASSWORD 解锁；解不开返回 null，
 * 不抛错、不挡直连）。密码绝不写 config.json。
 */
export function resolveTurnCredential(home: string): string | null {
  const env = process.env.NYRA_TURN_CREDENTIAL;
  if (env) return env;
  try {
    const vault = new Vault(join(home, "vault.json"));
    if (!vault.exists()) return null;
    const pw = process.env.NYRA_VAULT_PASSWORD;
    if (!pw) return null;
    if (!vault.unlock(pw)) return null;
    return vault.get("video-turn-credential");
  } catch {
    return null;
  }
}

// ---- STUN 编解码（RFC 5389 / 5766，纯 TS；只做本批用到的部分） ----

export const STUN_MAGIC_COOKIE = 0x2112a442;
export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS = 0x0101;
export const STUN_BINDING_ERROR = 0x0111;
export const STUN_ALLOCATE_REQUEST = 0x0003;
export const STUN_ALLOCATE_SUCCESS = 0x0103;
export const STUN_ALLOCATE_ERROR = 0x0113;
export const STUN_REFRESH_REQUEST = 0x0004;
export const STUN_REFRESH_SUCCESS = 0x0104;
export const STUN_CREATE_PERMISSION_REQUEST = 0x0008;
export const STUN_CREATE_PERMISSION_SUCCESS = 0x0108;
export const STUN_SEND_INDICATION = 0x0016;
export const STUN_DATA_INDICATION = 0x0017;
export const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
export const STUN_ATTR_USERNAME = 0x0006;
export const STUN_ATTR_MESSAGE_INTEGRITY = 0x0008;
export const STUN_ATTR_ERROR_CODE = 0x0009;
export const STUN_ATTR_REALM = 0x0014;
export const STUN_ATTR_NONCE = 0x0015;
export const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;
export const STUN_ATTR_XOR_RELAYED_ADDRESS = 0x0016;
export const STUN_ATTR_XOR_PEER_ADDRESS = 0x0012;
export const STUN_ATTR_DATA = 0x0013;
export const STUN_ATTR_LIFETIME = 0x000d;
export const STUN_ATTR_REQUESTED_TRANSPORT = 0x0019;

export interface StunAttribute {
  type: number;
  value: Buffer;
}

export interface StunMessage {
  type: number;
  transactionId: Buffer;
  attributes: StunAttribute[];
}

export function newTransactionId(): Buffer {
  return randomBytes(12);
}

function paddedLength(n: number): number {
  return (n + 3) & ~3;
}

/** 编一条 STUN 消息（头部 20 字节 + 属性，每属性按 4 字节对齐）。 */
export function encodeStunMessage(type: number, transactionId: Buffer, attributes: StunAttribute[]): Buffer {
  let bodyLen = 0;
  for (const a of attributes) bodyLen += 4 + paddedLength(a.value.length);
  const buf = Buffer.alloc(20 + bodyLen);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(bodyLen, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(buf, 8, 0, 12);
  let off = 20;
  for (const a of attributes) {
    buf.writeUInt16BE(a.type, off);
    buf.writeUInt16BE(a.value.length, off + 2);
    a.value.copy(buf, off + 4);
    off += 4 + paddedLength(a.value.length);
  }
  return buf;
}

/** 解一条 STUN 消息：magic cookie 不对、长度不够、属性越界都抛错。 */
export function parseStunMessage(buf: Buffer): StunMessage {
  if (buf.length < 20) throw new VideoCallError("STUN 消息太短（不到 20 字节）");
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) throw new VideoCallError("STUN 消息没有 magic cookie");
  const bodyLen = buf.readUInt16BE(2);
  if (20 + bodyLen > buf.length) throw new VideoCallError("STUN 消息长度字段超出实际字节数");
  const attributes: StunAttribute[] = [];
  let off = 20;
  const end = 20 + bodyLen;
  while (off + 4 <= end) {
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    if (off + 4 + len > end) throw new VideoCallError("STUN 属性越界");
    attributes.push({ type, value: Buffer.from(buf.subarray(off + 4, off + 4 + len)) });
    off += 4 + paddedLength(len);
  }
  return { type: buf.readUInt16BE(0), transactionId: Buffer.from(buf.subarray(8, 20)), attributes };
}

export function stunAttr(msg: StunMessage, type: number): Buffer | null {
  const found = msg.attributes.find((a) => a.type === type);
  return found ? found.value : null;
}

/** XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS 解码（只支持 IPv4；IPv6 返回 null）。 */
export function decodeXorAddress(value: Buffer, transactionId: Buffer): { address: string; port: number } | null {
  if (value.length < 8) return null;
  if (value[1] !== 0x01) return null; // 只认 IPv4
  const port = value.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >> 16);
  const ip = Buffer.from([
    value[4] ^ ((STUN_MAGIC_COOKIE >> 24) & 0xff),
    value[5] ^ ((STUN_MAGIC_COOKIE >> 16) & 0xff),
    value[6] ^ ((STUN_MAGIC_COOKIE >> 8) & 0xff),
    value[7] ^ (STUN_MAGIC_COOKIE & 0xff),
  ]);
  void transactionId;
  return { address: `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`, port };
}

/** XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS 编码（IPv4）。 */
export function encodeXorAddress(type: number, address: string, port: number): StunAttribute {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new VideoCallError(`地址不合法（只支持 IPv4）：${address}`);
  }
  const value = Buffer.alloc(8);
  value[0] = 0;
  value[1] = 0x01;
  value.writeUInt16BE(port ^ (STUN_MAGIC_COOKIE >> 16), 2);
  value[4] = parts[0] ^ ((STUN_MAGIC_COOKIE >> 24) & 0xff);
  value[5] = parts[1] ^ ((STUN_MAGIC_COOKIE >> 16) & 0xff);
  value[6] = parts[2] ^ ((STUN_MAGIC_COOKIE >> 8) & 0xff);
  value[7] = parts[3] ^ (STUN_MAGIC_COOKIE & 0xff);
  return { type, value };
}

/** STUN 长期凭证密钥：MD5(username:realm:password)。 */
export function stunLongTermKey(username: string, realm: string, password: string): Buffer {
  return createHash("md5").update(`${username}:${realm}:${password}`, "utf-8").digest();
}

/**
 * 给一条 STUN 消息加 MESSAGE-INTEGRITY（RFC 5389：先把该属性以 20 个
 * 零字节占位、长度字段含它在内，再对整条消息算 HMAC-SHA1，最后把 HMAC
 * 写回属性值）。返回带完整性的消息字节。
 */
export function signStunMessage(type: number, transactionId: Buffer, attributes: StunAttribute[], key: Buffer): Buffer {
  const zeroed = encodeStunMessage(type, transactionId, [
    ...attributes,
    { type: STUN_ATTR_MESSAGE_INTEGRITY, value: Buffer.alloc(20) },
  ]);
  const mac = createHmac("sha1", key).update(zeroed).digest();
  mac.copy(zeroed, zeroed.length - 20);
  return zeroed;
}

/** 验一条 STUN 消息的 MESSAGE-INTEGRITY（把属性值清零重算再比对）。 */
export function verifyStunMessage(msg: StunMessage, raw: Buffer, key: Buffer): boolean {
  const integrity = stunAttr(msg, STUN_ATTR_MESSAGE_INTEGRITY);
  if (!integrity || integrity.length !== 20) return false;
  // 找到 MESSAGE-INTEGRITY 属性在原字节里的位置，把值清零后重算。
  const bodyLen = raw.readUInt16BE(2);
  let off = 20;
  const end = 20 + bodyLen;
  while (off + 4 <= end) {
    const type = raw.readUInt16BE(off);
    const len = raw.readUInt16BE(off + 2);
    if (type === STUN_ATTR_MESSAGE_INTEGRITY) {
      const copy = Buffer.from(raw.subarray(0, off + 4 + 20));
      copy.fill(0, off + 4, off + 4 + 20);
      const mac = createHmac("sha1", key).update(copy).digest();
      return mac.equals(integrity);
    }
    off += 4 + paddedLength(len);
  }
  return false;
}

/** 解析 stun:/turn:/turns: 地址（默认端口 STUN/TURN 3478、TURNS 5349）。 */
export function parseStunUrl(url: string): { scheme: string; host: string; port: number } {
  const schemeEnd = url.indexOf(":");
  if (schemeEnd <= 0) throw new VideoCallError(`STUN/TURN 地址不合法：${url}`);
  const scheme = url.slice(0, schemeEnd).toLowerCase();
  if (scheme !== "stun" && scheme !== "turn" && scheme !== "turns") {
    throw new VideoCallError(`STUN/TURN 地址只支持 stun:/turn:/turns:，收到 ${url}`);
  }
  const rest = url.slice(schemeEnd + 1);
  const hostPort = rest.startsWith("//") ? rest.slice(2) : rest;
  const colon = hostPort.lastIndexOf(":");
  let host = hostPort;
  let port = scheme === "turns" ? 5349 : 3478;
  if (colon > 0) {
    host = hostPort.slice(0, colon);
    const p = Number(hostPort.slice(colon + 1));
    if (Number.isInteger(p) && p > 0 && p <= 65535) port = p;
  }
  if (!host) throw new VideoCallError(`STUN/TURN 地址没有 host：${url}`);
  return { scheme, host, port };
}

// ---- STUN 绑定：打洞拿自己的公网地址（srflx 候选） ----

export interface StunBindingResult {
  address: string;
  port: number;
  rttMs: number;
}

function udpRequest(opts: {
  socket: Socket;
  host: string;
  port: number;
  bytes: Buffer;
  timeoutMs: number;
}): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      opts.socket.removeListener("message", onMessage);
      rejectPromise(new VideoCallError(`UDP 请求超时（${opts.host}:${opts.port}，${opts.timeoutMs}ms 内无响应）`));
    }, opts.timeoutMs);
    const onMessage = (msg: Buffer) => {
      clearTimeout(timer);
      opts.socket.removeListener("message", onMessage);
      resolvePromise(msg);
    };
    opts.socket.once("message", onMessage);
    opts.socket.send(opts.bytes, opts.port, opts.host, (err) => {
      if (err) {
        clearTimeout(timer);
        opts.socket.removeListener("message", onMessage);
        rejectPromise(new VideoCallError(`UDP 发送失败：${err.message}`));
      }
    });
  });
}

/**
 * STUN Binding 请求：问服务器“我从哪个公网地址来”，返回 srflx 地址。
 * 超时默认 3000ms；服务器不回包时抛错（调用方跳过该候选，不挡直连）。
 */
export async function stunBindingRequest(
  server: { host: string; port: number },
  opts?: { timeoutMs?: number; socket?: Socket },
): Promise<StunBindingResult> {
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const ownSocket = opts?.socket ?? createSocket("udp4");
  const started = Date.now();
  try {
    const tid = newTransactionId();
    const req = encodeStunMessage(STUN_BINDING_REQUEST, tid, []);
    const raw = await udpRequest({ socket: ownSocket, host: server.host, port: server.port, bytes: req, timeoutMs });
    const msg = parseStunMessage(raw);
    if (msg.type !== STUN_BINDING_SUCCESS) throw new VideoCallError(`STUN 服务器返回 ${msg.type.toString(16)}，不是成功响应`);
    if (!msg.transactionId.equals(tid)) throw new VideoCallError("STUN 响应的 transaction id 对不上请求");
    const mapped = stunAttr(msg, STUN_ATTR_XOR_MAPPED_ADDRESS) ?? stunAttr(msg, STUN_ATTR_MAPPED_ADDRESS);
    if (!mapped) throw new VideoCallError("STUN 成功响应里没有映射地址");
    const decoded = mapped.length === 8 && stunAttr(msg, STUN_ATTR_XOR_MAPPED_ADDRESS)
      ? decodeXorAddress(mapped, tid)
      : { address: `${mapped[4]}.${mapped[5]}.${mapped[6]}.${mapped[7]}`, port: mapped.readUInt16BE(2) };
    if (!decoded) throw new VideoCallError("STUN 映射地址解不出来（只支持 IPv4）");
    return { address: decoded.address, port: decoded.port, rttMs: Date.now() - started };
  } finally {
    if (!opts?.socket) {
      try { ownSocket.close(); } catch { /* ignore */ }
    }
  }
}

// ---- TURN 客户端（RFC 5766：Allocate / Refresh / CreatePermission / Send） ----

export interface TurnAllocation {
  relayedAddress: string;
  relayedPort: number;
  lifetimeSeconds: number;
}

export interface TurnClientOptions {
  server: { host: string; port: number };
  username: string;
  credential: string;
  /** 测试可注入已建好的套接字；不给就新建。 */
  socket?: Socket;
  timeoutMs?: number;
}

export class TurnClient {
  private socket: Socket;
  private ownedSocket: boolean;
  private pending = new Map<string, { resolve: (msg: StunMessage, raw: Buffer) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private dataHandler: ((data: Buffer, peer: { address: string; port: number }) => void) | null = null;
  allocation: TurnAllocation | null = null;

  constructor(private opts: TurnClientOptions) {
    this.ownedSocket = !opts.socket;
    this.socket = opts.socket ?? createSocket("udp4");
    this.socket.on("message", (msg: Buffer) => this.onSocketMessage(msg));
  }

  onData(cb: (data: Buffer, peer: { address: string; port: number }) => void): void {
    this.dataHandler = cb;
  }

  private onSocketMessage(msg: Buffer): void {
    let parsed: StunMessage;
    try {
      parsed = parseStunMessage(msg);
    } catch {
      return; // 不是 STUN 消息，忽略
    }
    if (parsed.type === STUN_DATA_INDICATION) {
      const data = stunAttr(parsed, STUN_ATTR_DATA);
      const peer = stunAttr(parsed, STUN_ATTR_XOR_PEER_ADDRESS);
      if (data && peer) {
        const decoded = decodeXorAddress(peer, parsed.transactionId);
        if (decoded && this.dataHandler) this.dataHandler(Buffer.from(data), decoded);
      }
      return;
    }
    const key = parsed.transactionId.toString("hex");
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve(parsed, msg);
  }

  private request(type: number, attributes: StunAttribute[], sign: { username: string; realm: string; nonce: string } | null): Promise<{ msg: StunMessage; raw: Buffer }> {
    const tid = newTransactionId();
    let bytes: Buffer;
    if (sign) {
      const key = stunLongTermKey(sign.username, sign.realm, this.opts.credential);
      bytes = signStunMessage(type, tid, [
        ...attributes,
        { type: STUN_ATTR_USERNAME, value: Buffer.from(sign.username, "utf-8") },
        { type: STUN_ATTR_NONCE, value: Buffer.from(sign.nonce, "utf-8") },
        { type: STUN_ATTR_REALM, value: Buffer.from(sign.realm, "utf-8") },
      ], key);
    } else {
      bytes = encodeStunMessage(type, tid, attributes);
    }
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid.toString("hex"));
        rejectPromise(new VideoCallError(`TURN 请求超时（${this.opts.server.host}:${this.opts.server.port}）`));
      }, timeoutMs);
      this.pending.set(tid.toString("hex"), {
        resolve: (msg, raw) => resolvePromise({ msg, raw }),
        reject: rejectPromise,
        timer,
      });
      this.socket.send(bytes, this.opts.server.port, this.opts.server.host, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(tid.toString("hex"));
          rejectPromise(new VideoCallError(`TURN 发送失败：${err.message}`));
        }
      });
    });
  }

  private static errorCode(msg: StunMessage): number | null {
    const attr = stunAttr(msg, STUN_ATTR_ERROR_CODE);
    if (!attr || attr.length < 4) return null;
    return attr[2] * 100 + attr[3];
  }

  /**
   * Allocate：先不带凭证发一次，401 就按 NONCE/REALM 带长期凭证重发。
   * 成功返回中继地址（别人打这个地址，TURN 转给你）。
   */
  async allocate(): Promise<TurnAllocation> {
    const transport: StunAttribute = { type: STUN_ATTR_REQUESTED_TRANSPORT, value: Buffer.from([0x11, 0, 0, 0]) };
    const first = await this.request(STUN_ALLOCATE_REQUEST, [transport], null);
    if (first.msg.type === STUN_ALLOCATE_SUCCESS) {
      return this.finishAllocate(first.msg);
    }
    if (first.msg.type !== STUN_ALLOCATE_ERROR || TurnClient.errorCode(first.msg) !== 401) {
      throw new VideoCallError(`TURN Allocate 失败（类型 ${first.msg.type.toString(16)}，错误码 ${TurnClient.errorCode(first.msg) ?? "未知"})`);
    }
    const nonce = stunAttr(first.msg, STUN_ATTR_NONCE);
    const realm = stunAttr(first.msg, STUN_ATTR_REALM);
    if (!nonce || !realm) throw new VideoCallError("TURN 服务器 401 里没有 NONCE/REALM，没法重发");
    const second = await this.request(STUN_ALLOCATE_REQUEST, [transport], {
      username: this.opts.username,
      realm: realm.toString("utf-8"),
      nonce: nonce.toString("utf-8"),
    });
    if (second.msg.type !== STUN_ALLOCATE_SUCCESS) {
      throw new VideoCallError(`TURN Allocate 认证后失败（错误码 ${TurnClient.errorCode(second.msg) ?? "未知"}）`);
    }
    return this.finishAllocate(second.msg);
  }

  private finishAllocate(msg: StunMessage): TurnAllocation {
    const relayed = stunAttr(msg, STUN_ATTR_XOR_RELAYED_ADDRESS);
    if (!relayed) throw new VideoCallError("TURN Allocate 成功响应里没有中继地址");
    const decoded = decodeXorAddress(relayed, msg.transactionId);
    if (!decoded) throw new VideoCallError("TURN 中继地址解不出来（只支持 IPv4）");
    const lifetime = stunAttr(msg, STUN_ATTR_LIFETIME);
    const seconds = lifetime && lifetime.length >= 4 ? lifetime.readUInt32BE(0) : 600;
    this.allocation = { relayedAddress: decoded.address, relayedPort: decoded.port, lifetimeSeconds: seconds };
    return this.allocation;
  }

  /** Refresh：续租中继地址（lifetime 0 = 释放）。 */
  async refresh(lifetimeSeconds = 600): Promise<void> {
    if (!this.allocation) throw new VideoCallError("还没 Allocate，不能 Refresh");
    const lifetime = Buffer.alloc(4);
    lifetime.writeUInt32BE(lifetimeSeconds, 0);
    const resp = await this.request(STUN_REFRESH_REQUEST, [{ type: STUN_ATTR_LIFETIME, value: lifetime }], null);
    if (resp.msg.type !== STUN_REFRESH_SUCCESS) {
      throw new VideoCallError(`TURN Refresh 失败（错误码 ${TurnClient.errorCode(resp.msg) ?? "未知"}）`);
    }
  }

  /** CreatePermission：允许中继给某个对端地址转发（不做这步，Send 会被 TURN 丢掉）。 */
  async createPermission(peerAddress: string): Promise<void> {
    if (!this.allocation) throw new VideoCallError("还没 Allocate，不能 CreatePermission");
    const resp = await this.request(STUN_CREATE_PERMISSION_REQUEST, [
      { type: STUN_ATTR_XOR_PEER_ADDRESS, value: encodeXorAddress(STUN_ATTR_XOR_PEER_ADDRESS, peerAddress, 0).value },
    ], null);
    if (resp.msg.type !== STUN_CREATE_PERMISSION_SUCCESS) {
      throw new VideoCallError(`TURN CreatePermission 失败（错误码 ${TurnClient.errorCode(resp.msg) ?? "未知"}）`);
    }
  }

  /** Send indication：经中继给对端发一包数据（不确认、不重传，UDP 语义）。 */
  async sendIndication(peerAddress: string, peerPort: number, data: Buffer): Promise<void> {
    if (!this.allocation) throw new VideoCallError("还没 Allocate，不能 Send");
    const peer = encodeXorAddress(STUN_ATTR_XOR_PEER_ADDRESS, peerAddress, peerPort).value;
    const bytes = encodeStunMessage(STUN_SEND_INDICATION, newTransactionId(), [
      { type: STUN_ATTR_XOR_PEER_ADDRESS, value: peer },
      { type: STUN_ATTR_DATA, value: data },
    ]);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.socket.send(bytes, this.opts.server.port, this.opts.server.host, (err) => {
        if (err) rejectPromise(new VideoCallError(`TURN Send 失败：${err.message}`));
        else resolvePromise();
      });
    });
  }

  close(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new VideoCallError("TURN 客户端已关闭"));
    }
    this.pending.clear();
    if (this.ownedSocket) {
      try { this.socket.close(); } catch { /* ignore */ }
    }
  }
}

// ---- ICE：候选收集 + 连通性检查 + 提名 ----

export interface IceCandidate {
  foundation: string;
  component: number;
  transport: "udp";
  priority: number;
  address: string;
  port: number;
  type: "host" | "srflx" | "relay";
}

export function icePriority(type: IceCandidate["type"], localPref = 65535): number {
  const typePref = type === "host" ? 126 : type === "srflx" ? 100 : 0;
  return (typePref << 24) + (localPref << 8) + (256 - 1);
}

/** 本机 host 候选：每块网卡一个 IPv4（含 127.0.0.1，本地联调就靠它）。 */
export function gatherHostCandidates(): IceCandidate[] {
  const out: IceCandidate[] = [];
  const ifs = networkInterfaces();
  let n = 0;
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] ?? []) {
      if (addr.family !== "IPv4") continue;
      out.push({
        foundation: `host-${n++}`,
        component: 1,
        transport: "udp",
        priority: icePriority("host", addr.internal ? 32768 : 65535),
        address: addr.address,
        port: 0, // 端口由 IceTransport 绑定后填
        type: "host",
      });
    }
  }
  if (out.length === 0) {
    out.push({ foundation: "host-0", component: 1, transport: "udp", priority: icePriority("host"), address: "127.0.0.1", port: 0, type: "host" });
  }
  return out;
}

export type IceState = "new" | "gathering" | "checking" | "connected" | "disconnected" | "failed" | "closed";

export interface IcePair {
  local: IceCandidate;
  remote: IceCandidate;
  relayed: boolean;
  rttMs: number;
}

export interface IceTransportOptions {
  ufrag: string;
  password: string;
  /** 单次检查超时（毫秒），默认 2000；每对最多重试 2 次。 */
  checkTimeoutMs?: number;
  onState?: (state: IceState) => void;
  onData?: (data: Buffer, from: { address: string; port: number }) => void;
  /** 测试可注入已建好的套接字。 */
  socket?: Socket;
}

const MAX_FRAME_BYTES = 60000;

/**
 * ICE 传输：一只 UDP 套接字 + 连通性检查 + 提名。
 * 收到的包先按 STUN 认（前两位 00 + magic cookie），是 STUN 就走检查
 * 流程，不是就当长度前缀的数据帧交给 onData。
 */
export class IceTransport {
  readonly ufrag: string;
  readonly password: string;
  state: IceState = "new";
  localPort = 0;
  bytesOut = 0;
  bytesIn = 0;
  lastRttMs: number | null = null;
  consecutiveFailures = 0;
  nominated: IcePair | null = null;
  droppedOversize = 0;

  private socket: Socket;
  private ownedSocket: boolean;
  private opts: IceTransportOptions;
  private pendingChecks = new Map<string, { resolve: (rttMs: number) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; started: number }>();
  private remoteUfrag = "";
  private remotePassword = "";
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: IceTransportOptions) {
    this.ufrag = opts.ufrag;
    this.password = opts.password;
    this.opts = opts;
    this.ownedSocket = !opts.socket;
    this.socket = opts.socket ?? createSocket("udp4");
    this.socket.on("message", (msg: Buffer, rinfo) => this.onSocketMessage(msg, rinfo));
    this.socket.on("error", () => {
      if (this.state !== "closed") this.setState("failed");
    });
  }

  private setState(state: IceState): void {
    if (this.state === state) return;
    this.state = state;
    try { this.opts.onState?.(state); } catch { /* 回调不破坏传输 */ }
  }

  /** 换数据回调（媒体面接线用；原来的回调仍会先被调一次）。 */
  setOnData(cb: (data: Buffer, from: { address: string; port: number }) => void): void {
    const prev = this.opts.onData;
    this.opts.onData = (data, from) => {
      try { prev?.(data, from); } catch { /* ignore */ }
      cb(data, from);
    };
  }

  /** 绑定一只本地端口（不调就用系统随机端口；调了才能把端口写进候选）。 */
  async bind(port = 0): Promise<number> {
    if (this.localPort) return this.localPort;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.socket.once("error", rejectPromise);
      this.socket.bind(port, "0.0.0.0", () => {
        this.socket.removeListener("error", rejectPromise);
        resolvePromise();
      });
    });
    const addr = this.socket.address();
    this.localPort = typeof addr === "object" ? addr.port : 0;
    return this.localPort;
  }

  /**
   * 收集候选：host（本机网卡）+ srflx（每个 STUN 服务器打一次 Binding，
   * 失败跳过不挡事）+ relay（每个 TURN 服务器 Allocate，失败跳过）。
   * 返回的候选都带真实端口（host 候选用本套接字的端口）。
   */
  async gather(opts: {
    stunUrls: string[];
    turnUrls: string[];
    turnUsername: string;
    turnCredential: string | null;
  }): Promise<IceCandidate[]> {
    this.setState("gathering");
    const port = await this.bind();
    const out: IceCandidate[] = gatherHostCandidates().map((c) => ({ ...c, port }));
    for (const url of opts.stunUrls) {
      try {
        const server = parseStunUrl(url);
        const bound = await stunBindingRequest(server, { timeoutMs: 3000, socket: this.socket });
        out.push({
          foundation: `srflx-${out.length}`,
          component: 1,
          transport: "udp",
          priority: icePriority("srflx"),
          address: bound.address,
          port: bound.port,
          type: "srflx",
        });
      } catch { /* STUN 不通就跳过，不挡直连 */ }
    }
    for (const url of opts.turnUrls) {
      try {
        if (!opts.turnCredential || !opts.turnUsername) continue;
        const server = parseStunUrl(url);
        const client = new TurnClient({ server, username: opts.turnUsername, credential: opts.turnCredential, socket: this.socket });
        const alloc = await client.allocate();
        out.push({
          foundation: `relay-${out.length}`,
          component: 1,
          transport: "udp",
          priority: icePriority("relay"),
          address: alloc.relayedAddress,
          port: alloc.relayedPort,
          type: "relay",
        });
      } catch { /* TURN 不通就跳过，不挡直连 */ }
    }
    this.setState("new");
    return out;
  }

  private isStunMessage(msg: Buffer): boolean {
    return msg.length >= 20 && (msg[0] & 0xc0) === 0 && msg.readUInt32BE(4) === STUN_MAGIC_COOKIE;
  }

  private onSocketMessage(msg: Buffer, rinfo: { address: string; port: number }): void {
    this.bytesIn += msg.length;
    if (this.isStunMessage(msg)) {
      this.handleStunMessage(msg, rinfo);
      return;
    }
    // 数据帧：4 字节长度前缀 + 内容；超长或截断直接丢并计数。
    if (msg.length < 4) return;
    const len = msg.readUInt32BE(0);
    if (len > MAX_FRAME_BYTES || 4 + len > msg.length) {
      this.droppedOversize++;
      return;
    }
    try { this.opts.onData?.(Buffer.from(msg.subarray(4, 4 + len)), rinfo); } catch { /* 回调不破坏传输 */ }
  }

  private handleStunMessage(msg: Buffer, rinfo: { address: string; port: number }): void {
    let parsed: StunMessage;
    try {
      parsed = parseStunMessage(msg);
    } catch {
      return;
    }
    if (parsed.type === STUN_BINDING_REQUEST) {
      // 对方在检查我：USERNAME 须是 "<我的 ufrag>:<对方 ufrag>"，完整性用我的密码验。
      const username = stunAttr(parsed, STUN_ATTR_USERNAME);
      const expected = `${this.ufrag}:${this.remoteUfrag}`;
      if (!username || username.toString("utf-8") !== expected) return;
      if (!verifyStunMessage(parsed, msg, Buffer.from(this.password, "utf-8"))) return;
      const mapped = stunAttr(parsed, STUN_ATTR_XOR_MAPPED_ADDRESS) ?? stunAttr(parsed, STUN_ATTR_MAPPED_ADDRESS);
      void mapped;
      const key = Buffer.from(this.remotePassword, "utf-8");
      const resp = signStunMessage(STUN_BINDING_SUCCESS, parsed.transactionId, [
        encodeXorAddress(STUN_ATTR_XOR_MAPPED_ADDRESS, rinfo.address, rinfo.port),
      ], key);
      this.socket.send(resp, rinfo.port, rinfo.address);
      return;
    }
    if (parsed.type === STUN_BINDING_SUCCESS) {
      const key = parsed.transactionId.toString("hex");
      const entry = this.pendingChecks.get(key);
      if (!entry) return;
      if (!verifyStunMessage(parsed, msg, Buffer.from(this.password, "utf-8"))) return;
      clearTimeout(entry.timer);
      this.pendingChecks.delete(key);
      const rttMs = Date.now() - entry.started;
      this.lastRttMs = rttMs;
      this.consecutiveFailures = 0;
      entry.resolve(rttMs);
    }
  }

  /** 发一次连通性检查（Binding 请求，USERNAME 是 "<对方 ufrag>:<我的 ufrag>"，完整性用对方密码签）。 */
  private checkOnce(candidate: IceCandidate): Promise<number> {
    const tid = newTransactionId();
    const key = Buffer.from(this.remotePassword, "utf-8");
    const bytes = signStunMessage(STUN_BINDING_REQUEST, tid, [
      { type: STUN_ATTR_USERNAME, value: Buffer.from(`${this.remoteUfrag}:${this.ufrag}`, "utf-8") },
    ], key);
    const timeoutMs = this.opts.checkTimeoutMs ?? 2000;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingChecks.delete(tid.toString("hex"));
        rejectPromise(new VideoCallError("ICE 检查超时"));
      }, timeoutMs);
      this.pendingChecks.set(tid.toString("hex"), { resolve: resolvePromise, reject: rejectPromise, timer, started: Date.now() });
      this.socket.send(bytes, candidate.port, candidate.address, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingChecks.delete(tid.toString("hex"));
          rejectPromise(new VideoCallError(`ICE 检查发送失败：${err.message}`));
        }
      });
    });
  }

  /**
   * 对远端候选逐对检查（host 优先、srflx 其次、relay 最后），第一对通的
   * 就是提名对；全部不通抛错。检查成功后开始保活（每 15 秒重发一次）。
   */
  async startChecks(remoteCandidates: IceCandidate[], remoteUfrag: string, remotePassword: string): Promise<IcePair> {
    this.remoteUfrag = remoteUfrag;
    this.remotePassword = remotePassword;
    this.setState("checking");
    await this.bind();
    const order = [...remoteCandidates].sort((a, b) => b.priority - a.priority);
    let lastError: Error | null = null;
    for (const remote of order) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rttMs = await this.checkOnce(remote);
          const local = gatherHostCandidates()[0];
          const pair: IcePair = {
            local: { ...local, port: this.localPort },
            remote,
            relayed: remote.type === "relay",
            rttMs,
          };
          this.nominated = pair;
          this.setState("connected");
          this.startKeepalive();
          return pair;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.consecutiveFailures++;
        }
      }
    }
    this.setState("failed");
    throw new VideoCallError(`ICE 连通性检查全失败（${order.length} 对候选都试过了）：${lastError?.message ?? "未知原因"}`);
  }

  private startKeepalive(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      const pair = this.nominated;
      if (!pair || this.state === "closed") return;
      this.checkOnce(pair.remote).catch(() => {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3) this.setState("disconnected");
      });
    }, 15000);
    this.checkTimer.unref?.();
  }

  /** 经提名对发一帧数据（长度前缀成帧；没连通时抛错，不静默丢）。 */
  async send(data: Buffer): Promise<void> {
    const pair = this.nominated;
    if (!pair || this.state !== "connected") {
      throw new VideoCallError("ICE 还没连通，发不了数据（先完成连通性检查）");
    }
    if (data.length > MAX_FRAME_BYTES) {
      this.droppedOversize++;
      throw new VideoCallError(`帧太大（${data.length} 字节，单包上限 ${MAX_FRAME_BYTES}），已丢弃`);
    }
    const framed = Buffer.alloc(4 + data.length);
    framed.writeUInt32BE(data.length, 0);
    data.copy(framed, 4);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.socket.send(framed, pair.remote.port, pair.remote.address, (err) => {
        if (err) rejectPromise(new VideoCallError(`ICE 发送失败：${err.message}`));
        else {
          this.bytesOut += framed.length;
          resolvePromise();
        }
      });
    });
  }

  close(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    for (const [, entry] of this.pendingChecks) {
      clearTimeout(entry.timer);
      entry.reject(new VideoCallError("ICE 传输已关闭"));
    }
    this.pendingChecks.clear();
    this.setState("closed");
    if (this.ownedSocket) {
      try { this.socket.close(); } catch { /* ignore */ }
    }
  }
}

/** ICE 参数包（信令里交换的全部内容：ufrag / 密码 / 候选；不是 SDP）。 */
export interface IceBundle {
  ufrag: string;
  password: string;
  candidates: IceCandidate[];
}

export function newIceIdentity(): { ufrag: string; password: string } {
  return {
    ufrag: randomBytes(4).toString("hex"),
    password: randomBytes(16).toString("hex"),
  };
}

// ---- 信令：WebSocket 房间中继（只传 ICE 参数包与控制消息，不碰媒体流） ----

export type SignalMessageType =
  | "join" | "offer" | "answer" | "ice-candidate" | "bye"
  | "joined" | "peer-joined" | "peer-left" | "record-consent" | "error";

export interface SignalMessage {
  type: SignalMessageType;
  room: string;
  from: string;
  to?: string;
  payload?: unknown;
}

interface SignalPeer {
  ws: { send: (data: string) => void; close?: () => void };
  peerId: string;
}

/**
 * 信令服务器（Bun.serve WebSocket）：房间按通话 id 分，消息只在同房
 * 间里转发；服务器不解析 offer/answer 的内容，只做中继。
 * 默认只绑 127.0.0.1（本机信令）；--host 0.0.0.0 才对外，但要自己注意防火墙。
 */
export class VideoSignalingServer {
  readonly url: string;
  readonly port: number;
  private rooms = new Map<string, Map<string, SignalPeer>>();
  private server: { stop: () => void; port: number } | null = null;

  constructor(opts: { port: number; host?: string }) {
    this.port = opts.port;
    const host = opts.host ?? "127.0.0.1";
    const rooms = this.rooms;
    const server = Bun.serve<{ peerId: string; room: string }>({
      port: opts.port,
      hostname: host,
      fetch(req, srv) {
        const upgraded = srv.upgrade(req, { data: { peerId: "", room: "" } });
        if (upgraded) return undefined;
        return new Response("nyra video signaling (websocket only)", { status: 200 });
      },
      websocket: {
        open(ws) {
          const data = ws.data;
          data.peerId = "";
          data.room = "";
        },
        message(ws, message) {
          let parsed: SignalMessage;
          try {
            parsed = JSON.parse(String(message)) as SignalMessage;
          } catch {
            try { ws.send(JSON.stringify({ type: "error", room: "", from: "server", payload: "消息不是 JSON" })); } catch { /* ignore */ }
            return;
          }
          const data = ws.data;
          if (parsed.type === "join") {
            data.peerId = parsed.from;
            data.room = parsed.room;
            let room = rooms.get(parsed.room);
            if (!room) {
              room = new Map();
              rooms.set(parsed.room, room);
            }
            const others = [...room.keys()];
            room.set(parsed.from, { ws: ws as unknown as SignalPeer["ws"], peerId: parsed.from });
            try { ws.send(JSON.stringify({ type: "joined", room: parsed.room, from: "server", payload: { peers: others } })); } catch { /* ignore */ }
            for (const [id, peer] of room) {
              if (id === parsed.from) continue;
              try { peer.ws.send(JSON.stringify({ type: "peer-joined", room: parsed.room, from: parsed.from })); } catch { /* ignore */ }
            }
            return;
          }
          const room = rooms.get(parsed.room);
          if (!room) return;
          for (const [id, peer] of room) {
            if (id === parsed.from) continue;
            if (parsed.to && parsed.to !== id) continue;
            try { peer.ws.send(JSON.stringify(parsed)); } catch { /* ignore */ }
          }
        },
        close(ws) {
          const data = ws.data;
          if (!data.room || !data.peerId) return;
          const room = rooms.get(data.room);
          if (!room) return;
          room.delete(data.peerId);
          if (room.size === 0) rooms.delete(data.room);
          for (const [, peer] of room) {
            try { peer.ws.send(JSON.stringify({ type: "peer-left", room: data.room, from: data.peerId })); } catch { /* ignore */ }
          }
        },
      },
    });
    this.server = server as unknown as { stop: () => void; port: number };
    this.url = `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.port}`;
  }

  stop(): void {
    try { this.server?.stop(); } catch { /* ignore */ }
    this.rooms.clear();
  }
}

export class VideoSignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<(msg: SignalMessage) => void>();
  private openPromise: Promise<void> | null = null;

  constructor(private url: string) {}

  connect(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        rejectPromise(new VideoCallError(`信令服务器连不上：${this.url}（先跑 nyra video signal serve 起一个，或检查 video.signaling_url）`));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        rejectPromise(new VideoCallError(`信令服务器连不上：${this.url}`));
      };
      ws.onmessage = (ev) => {
        let parsed: SignalMessage;
        try {
          parsed = JSON.parse(String(ev.data)) as SignalMessage;
        } catch {
          return;
        }
        for (const h of [...this.handlers]) {
          try { h(parsed); } catch { /* 回调不破坏连接 */ }
        }
      };
      ws.onclose = () => {
        this.ws = null;
        this.openPromise = null;
      };
      this.ws = ws;
    });
    return this.openPromise;
  }

  onMessage(cb: (msg: SignalMessage) => void): void {
    this.handlers.add(cb);
  }

  offMessage(cb: (msg: SignalMessage) => void): void {
    this.handlers.delete(cb);
  }

  send(type: SignalMessageType, room: string, from: string, payload?: unknown, to?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new VideoCallError("信令还没连上，先 connect");
    }
    this.ws.send(JSON.stringify({ type, room, from, ...(to ? { to } : {}), ...(payload !== undefined ? { payload } : {}) }));
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.openPromise = null;
  }
}

// ---- 媒体面：帧怎么走（Loopback 本地 / ICE 直连 UDP） ----

export interface VideoMediaPlane {
  kind: "loopback" | "ice";
  sendFrame(bytes: Buffer): Promise<void>;
  onFrame(cb: (bytes: Buffer) => void): void;
}

/** 本地媒体面（回环：发出的帧直接交给本机的接收回调，不走网络）。 */
export class LocalMediaPlane implements VideoMediaPlane {
  readonly kind = "loopback" as const;
  bytesOut = 0;
  bytesIn = 0;
  private handler: ((bytes: Buffer) => void) | null = null;

  onFrame(cb: (bytes: Buffer) => void): void {
    this.handler = cb;
  }

  async sendFrame(bytes: Buffer): Promise<void> {
    this.bytesOut += bytes.length;
    this.bytesIn += bytes.length;
    this.handler?.(Buffer.from(bytes));
  }
}

/** ICE 媒体面（帧走提名出来的 UDP 直连通道；未加密，见文件头诚实边界）。 */
export class IceMediaPlane implements VideoMediaPlane {
  readonly kind = "ice" as const;

  constructor(private ice: IceTransport) {}

  onFrame(cb: (bytes: Buffer) => void): void {
    this.ice.setOnData((data) => cb(data));
  }

  async sendFrame(bytes: Buffer): Promise<void> {
    await this.ice.send(bytes);
  }
}

// ---- WebRtcTransport：把 VoiceCallTransport 接口接到真协商 ----

export type WebRtcTransportState = "idle" | "signaling" | "gathering" | "checking" | "connected" | "failed" | "closed";

export interface WebRtcTransportOptions {
  home: string;
  config: VideoCallConfig;
  role: "caller" | "callee";
  /** 覆盖配置里的信令地址（CLI --signaling 用）；不给就用配置。 */
  signalingUrl?: string;
  /** 状态变化回调（进审计与事件）；测试可注入。 */
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
  /** 测试可注入的信令客户端与 ICE 传输。 */
  signaling?: VideoSignalingClient;
  ice?: IceTransport;
  /** 测试可注入的 ICE 身份；注入 ice 时须同时给，且 ufrag/password 须与
   * 注入的 ice 一致（不给就随机生成，注入的 ice 会对不上号）。 */
  identity?: { ufrag: string; password: string };
}

/**
 * WebRTC 传输（实现缺口 36 留下的 VoiceCallTransport 接口，kind "webrtc"）：
 * start() 只负责踢开异步协商（信令握手 → 候选收集 → ICE 检查），协商
 * 进度走 onEvent 回调；连通后 mediaPlane 可用。stop() 关闭全部。
 * 注意：协商是异步的，start() 返回时还没连上——连通与否看
 * waitConnected() / iceState。
 */
export class WebRtcTransport implements VoiceCallTransport {
  readonly kind = "webrtc" as const;
  state: WebRtcTransportState = "idle";
  ice: IceTransport | null = null;
  signaling: VideoSignalingClient | null = null;
  mediaPlane: VideoMediaPlane | null = null;
  pair: IcePair | null = null;
  lastError: string | null = null;

  private opts: WebRtcTransportOptions;
  private callId = "";
  private identity: { ufrag: string; password: string };
  private connectedPromise: Promise<IcePair> | null = null;
  private connectedResolve: ((pair: IcePair) => void) | null = null;
  private connectedReject: ((err: Error) => void) | null = null;
  private negotiation: Promise<void> | null = null;

  constructor(opts: WebRtcTransportOptions) {
    this.opts = opts;
    if (opts.ice && !opts.identity) {
      throw new VideoCallError("注入 ice 时须同时注入 identity（ufrag/password 须与注入的 ice 一致），否则连通性检查对不上号");
    }
    this.identity = opts.identity ?? newIceIdentity();
  }

  private emit(event: string, detail: Record<string, unknown>): void {
    try { this.opts.onEvent?.(event, detail); } catch { /* 回调不破坏协商 */ }
  }

  private setState(state: WebRtcTransportState): void {
    this.state = state;
    this.emit("state", { state });
  }

  start(callId: string): void {
    if (this.negotiation) return; // 已经在协商，别重复踢
    this.callId = callId;
    this.connectedPromise = new Promise<IcePair>((resolvePromise, rejectPromise) => {
      this.connectedResolve = resolvePromise;
      this.connectedReject = rejectPromise;
    });
    this.connectedPromise.catch(() => { /* 调用方用 waitConnected 拿错误 */ });
    this.negotiation = this.negotiate(callId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.setState("failed");
      this.emit("failed", { reason: msg });
      this.connectedReject?.(new VideoCallError(msg));
    });
  }

  stop(_callId: string): void {
    this.setState("closed");
    for (const [, w] of this.signalWaiters) {
      clearTimeout(w.timer);
      w.reject(new VideoCallError("会话已停止"));
    }
    this.signalWaiters.clear();
    for (const w of this.peerWaiters.splice(0)) clearTimeout(w.timer);
    try { this.ice?.close(); } catch { /* ignore */ }
    try { this.signaling?.close(); } catch { /* ignore */ }
    this.mediaPlane = null;
  }

  waitConnected(timeoutMs = 30000): Promise<IcePair> {
    if (!this.connectedPromise) throw new VideoCallError("还没 start，不能等连通");
    if (this.pair) return Promise.resolve(this.pair);
    return new Promise<IcePair>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new VideoCallError(`等 ICE 连通超时（${timeoutMs}ms）`)), timeoutMs);
      this.connectedPromise!.then(
        (pair) => { clearTimeout(timer); resolvePromise(pair); },
        (err) => { clearTimeout(timer); rejectPromise(err); },
      );
    });
  }

  // 信令消息缓冲：常驻 handler 先把收到的消息按类型存下来，waitForSignal
  // 再来取——offer/answer 在 gather 期间到达也不会丢（旧写法只在等的时候
  // 才注册 handler，早到的消息直接丢了，协商会一直等到超时）。
  private signalBuffer = new Map<string, SignalMessage>();
  private signalWaiters = new Map<string, { resolve: (msg: SignalMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private peers = new Set<string>();
  private peerWaiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  private onSignalMessage(msg: SignalMessage): void {
    if (msg.room !== this.callId) return;
    if (msg.type === "joined") {
      const list = (msg.payload as { peers?: unknown } | undefined)?.peers;
      if (Array.isArray(list)) for (const p of list) if (typeof p === "string") this.peers.add(p);
    }
    if (msg.type === "peer-joined") this.peers.add(msg.from);
    if (msg.type === "peer-left") this.peers.delete(msg.from);
    if (this.peers.size > 0) {
      for (const w of this.peerWaiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }
    this.signalBuffer.set(msg.type, msg);
    const waiter = this.signalWaiters.get(msg.type);
    if (waiter) {
      this.signalWaiters.delete(msg.type);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  /** 等对方进房（join 回执的 peers 列表或 peer-joined 任一先到就算）。 */
  private waitForPeer(timeoutMs = 60000): Promise<void> {
    if (this.peers.size > 0) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.peerWaiters = this.peerWaiters.filter((w) => w.timer !== timer);
        rejectPromise(new VideoCallError("等对方进房超时（60 秒内没人加入这个通话）"));
      }, timeoutMs);
      this.peerWaiters.push({ resolve: resolvePromise, timer });
    });
  }

  private waitForSignal(type: SignalMessageType, timeoutMs = 30000): Promise<SignalMessage> {
    const buffered = this.signalBuffer.get(type);
    if (buffered) {
      this.signalBuffer.delete(type);
      return Promise.resolve(buffered);
    }
    const signaling = this.signaling;
    if (!signaling) throw new VideoCallError("信令还没连上");
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.signalWaiters.delete(type);
        rejectPromise(new VideoCallError(`等对方的 ${type} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.signalWaiters.set(type, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
  }

  private async negotiate(callId: string): Promise<void> {
    const cfg = this.opts.config;
    const signalingUrl = this.opts.signalingUrl ?? cfg.signalingUrl;
    this.setState("signaling");
    const signaling = this.opts.signaling ?? new VideoSignalingClient(signalingUrl);
    this.signaling = signaling;
    await signaling.connect();
    // 常驻 handler 须在 join 之前挂上，否则 join 回执与对方的 peer-joined
    // 可能赶在 waitForSignal 注册前到达，直接丢了。
    signaling.onMessage((msg) => this.onSignalMessage(msg));
    signaling.send("join", callId, this.identity.ufrag);
    this.emit("signaling-joined", { url: signalingUrl });

    this.setState("gathering");
    const ice = this.opts.ice ?? new IceTransport({
      ufrag: this.identity.ufrag,
      password: this.identity.password,
      onState: (s) => this.emit("ice-state", { ice_state: s }),
    });
    this.ice = ice;
    const turnCredential = resolveTurnCredential(this.opts.home);
    const candidates = await ice.gather({
      stunUrls: cfg.stunUrls,
      turnUrls: cfg.turnUrls,
      turnUsername: cfg.turnUsername,
      turnCredential,
    });
    const bundle: IceBundle = { ufrag: this.identity.ufrag, password: this.identity.password, candidates };
    this.emit("gathered", { candidates: candidates.length });

    if (this.opts.role === "caller") {
      // 先等对方进房再发 offer：对方还没进房时服务器没人可转，offer 直接丢了。
      await this.waitForPeer();
      signaling.send("offer", callId, this.identity.ufrag, bundle);
      const answer = await this.waitForSignal("answer");
      const remote = answer.payload as IceBundle;
      this.setState("checking");
      const pair = await ice.startChecks(remote.candidates, remote.ufrag, remote.password);
      this.finishConnect(pair);
    } else {
      const offer = await this.waitForSignal("offer");
      const remote = offer.payload as IceBundle;
      signaling.send("answer", callId, this.identity.ufrag, bundle, offer.from);
      this.setState("checking");
      const pair = await ice.startChecks(remote.candidates, remote.ufrag, remote.password);
      this.finishConnect(pair);
    }
  }

  private finishConnect(pair: IcePair): void {
    this.pair = pair;
    this.mediaPlane = new IceMediaPlane(this.ice!);
    this.setState("connected");
    this.emit("connected", { relayed: pair.relayed, rtt_ms: pair.rttMs, remote: `${pair.remote.address}:${pair.remote.port}` });
    this.connectedResolve?.(pair);
  }
}

// ---- 通话账本与审计（与 voiceCall.ts 同款：原子写 0600，损坏先备份） ----

export type VideoCallStatus = "ringing" | "active" | "ended" | "declined";
export type VideoFrameStatus = "described" | "held" | "confirmed" | "skipped";

/** 通话里的一帧（只记元数据与指纹，不记图片内容、不记描述原文）。 */
export interface VideoFrameRecord {
  id: string;
  at: string;
  source: string;
  imageHash: string;
  bytes: number;
  mode: VideoSampleMode;
  sampled: boolean;
  skipReason: string | null;
  engine: string | null;
  descriptionHash: string | null;
  chars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  status: VideoFrameStatus;
  heldReason: "payment" | "external_send" | null;
  stored: boolean;
  sent: boolean;
  changeScore: number | null;
}

export interface VideoCall {
  id: string;
  agent: string;
  peer: string | null;
  transport: "webrtc" | "loopback";
  status: VideoCallStatus;
  iceState: IceState;
  icePair: { local: string; remote: string; relayed: boolean; rttMs: number } | null;
  signalingUrl: string;
  startedAt: string;
  endedAt: string | null;
  frames: VideoFrameRecord[];
  lastSampledAt: string | null;
  lastFrameSignature: string | null;
  degraded: boolean;
  videoOff: boolean;
  recordConsentLocal: boolean;
  recordConsentRemote: boolean;
  endRequested: boolean;
  transportBytesIn: number;
  transportBytesOut: number;
  framesSent: number;
  framesReceived: number;
  framesDroppedOversize: number;
  runId: string | null;
}

export interface VideoCallStore {
  version: 1;
  calls: VideoCall[];
}

export const VIDEO_CALLS_FILE = "video-calls.json";
export const VIDEO_CALL_AUDIT_FILE = "video-call-audit.jsonl";

export function videoCallsPath(home: string): string {
  return join(home, VIDEO_CALLS_FILE);
}

export function videoCallDir(home: string, callId: string): string {
  return join(home, "video", callId);
}

function newVideoCallId(): string {
  return `vcall-${nowIso().replace(/[-:T.]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

function newFrameId(): string {
  return `frame-${randomBytes(4).toString("hex")}`;
}

function backupCorruptVideo(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadVideoCallStore(home: string): VideoCallStore {
  const path = videoCallsPath(home);
  if (!existsSync(path)) return { version: 1, calls: [] };
  if (lstatSync(path).isSymbolicLink()) throw new VideoCallError("视频通话账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorruptVideo(path);
    throw new VideoCallError("视频通话账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as VideoCallStore).version !== 1 ||
    !Array.isArray((raw as VideoCallStore).calls)) {
    backupCorruptVideo(path);
    throw new VideoCallError("视频通话账本格式无效，已备份");
  }
  return raw as VideoCallStore;
}

export function saveVideoCallStore(home: string, store: VideoCallStore): void {
  const path = videoCallsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new VideoCallError("视频通话账本不能是符号链接");
  const tmp = join(dirname(path), `.video-calls-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

export function appendVideoCallAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(home, VIDEO_CALL_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: nowIso(), ...entry }) + "\n", null, "utf-8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function mirrorVideoEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

function getVideoCall(store: VideoCallStore, id: string): VideoCall {
  const call = store.calls.find((c) => c.id === id);
  if (!call) throw new VideoCallError(`找不到视频通话 ${id}`);
  return call;
}

// ---- 视觉描述：本地优先，云端须显式 opt-in ----

export interface VisionDescribeResult {
  text: string;
  engine: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
}

export type VisionFn = (image: VisionImageInput, prompt: string) => Promise<VisionDescribeResult>;

/** 一笔视觉花费进用量账本（token 快照当增量；calls=1 保证未计价也落行）。 */
function recordVisionSpend(home: string, promptTokens: number | null, completionTokens: number | null, costUsd: number | null, engine: string, agentId?: string | null): void {
  try {
    const snap: UsageSnapshot = {
      calls: 1, reported_calls: 0, missing_calls: 0,
      prompt_tokens: promptTokens ?? 0, completion_tokens: completionTokens ?? 0,
      total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      prompt_samples: 0, completion_samples: 0, total_samples: 0,
      last_prompt_tokens: promptTokens, context_window_tokens: null,
      context_remaining_tokens: null, context_window_source: "unknown",
      context_window_model: null,
    };
    new UsageLedger(home).recordDelta(snap, null, costUsd, null, engine, undefined, agentId ?? null);
  } catch { /* 账本写失败不破坏通话 */ }
}

function extractVisionText(resp: Record<string, unknown>): string {
  const choices = (resp.choices as Record<string, unknown>[]) ?? [];
  const content = ((choices[0]?.message ?? {}) as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

function extractVisionUsage(resp: Record<string, unknown>): { promptTokens: number | null; completionTokens: number | null } {
  const usage = resp.usage as Record<string, unknown> | undefined;
  const p = typeof usage?.prompt_tokens === "number" ? (usage.prompt_tokens as number) : null;
  const c = typeof usage?.completion_tokens === "number" ? (usage.completion_tokens as number) : null;
  return { promptTokens: p, completionTokens: c };
}

/**
 * 默认视觉描述：本地 Ollama 模型优先（配了 vision_local_model 才走）；
 * 本地不可用时，只有 vision_cloud_enabled 才升级云端（
 * 估算按一帧 765 输入 token + 200 输出 token；没配单价算不出金额时
 * 不假装封顶、只记未计价）。两条路都没有时直接报错指路。
 */
export async function describeFrameDefault(opts: {
  home: string;
  config: Record<string, unknown>;
  videoCfg: VideoCallConfig;
  image: VisionImageInput;
  prompt: string;
  agentId?: string | null;
}): Promise<VisionDescribeResult> {
  const { home, config, videoCfg } = opts;
  let localFailed = false;
  if (videoCfg.visionLocalModel) {
    try {
      const resolved = resolveProvider({ home, config, providerName: "ollama", model: videoCfg.visionLocalModel });
      const gate = modelSupportsVision(resolved.model, "ollama");
      if (!gate.supported) throw new Error(visionGateMessage(resolved.model, "ollama"));
      const provider = new Provider(resolved);
      const resp = await provider.chat([buildVisionUserMessage(opts.prompt, [opts.image])] as never, null);
      const text = extractVisionText(resp);
      if (!text.trim()) throw new Error("本地视觉模型没有返回描述，请重试");
      const usage = extractVisionUsage(resp);
      const pricing = resolvePricing(config.pricing, resolved.model);
      const cost = pricing === null ? null : computeCostUsd(usage.promptTokens, usage.completionTokens, pricing);
      recordVisionSpend(home, usage.promptTokens, usage.completionTokens, cost, `ollama:${resolved.model}`, opts.agentId);
      return { text, engine: `ollama:${resolved.model}`, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: cost };
    } catch (err: unknown) {
      localFailed = true;
      void err;
    }
  }
  if (!videoCfg.visionCloudEnabled) {
    if (videoCfg.visionLocalModel && localFailed) {
      throw new VideoCallError("本地视觉模型不可用（Ollama 没跑、模型没拉、或模型看不了图），且云端视觉默认关闭。两条路任选其一：1）起好 Ollama 并拉好模型（config.json 的 video.vision_local_model）；2）在 config.json 的 video.vision_cloud_enabled 设为 true 才走云端（云端要花钱）。详见 docs/video-call.md");
    }
    throw new VideoCallError("没有可用的看图路：本地视觉模型未配，且云端视觉默认关闭。配一个本地视觉模型（video.vision_local_model，如 qwen2.5-vl:3b，走 Ollama），或在 config.json 的 video.vision_cloud_enabled 设为 true 才走云端（云端要花钱）。详见 docs/video-call.md");
  }
  const resolved = resolveProvider({ home, config });
  if (resolved.auth === "cli" || !resolved.apiKey) {
    throw new VideoCallError("云端视觉不可用：当前 provider 没有 HTTP 接口或未配密钥（换一个支持视觉的 HTTP provider 并配好密钥，或配本地 Ollama 视觉模型）");
  }
  const gate = modelSupportsVision(resolved.model, resolved.name);
  if (!gate.supported) throw new VideoCallError(visionGateMessage(resolved.model, resolved.name));
  const pricing = resolvePricing(config.pricing, resolved.model);
  const provider = new Provider(resolved);
  const resp = await provider.chat([buildVisionUserMessage(opts.prompt, [opts.image])] as never, null);
  const text = extractVisionText(resp);
  if (!text.trim()) throw new VideoCallError("视觉模型没有返回描述，请重试");
  const usage = extractVisionUsage(resp);
  const cost = pricing === null ? null : computeCostUsd(usage.promptTokens, usage.completionTokens, pricing);
  recordVisionSpend(home, usage.promptTokens, usage.completionTokens, cost, `cloud:${resolved.model}`, opts.agentId);
  return { text, engine: `cloud:${resolved.model}`, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: cost };
}

// ---- 帧采样：三档门控 + 视觉描述 + 敏感意图扣下 ----

/** 画面变化检测：ffmpeg 把图缩成 16x16 rgb24 原始字节当签名（768 字节）。 */
export function frameSignature(imagePath: string, run: CommandRunner): Buffer | null {
  const dir = join(tmpdir(), `nyra-frame-sig-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "sig.rgb");
    const r = run("ffmpeg", ["-i", imagePath, "-vf", "scale=16:16", "-f", "rawvideo", "-pix_fmt", "rgb24", "-vframes", "1", "-y", out]);
    if (r.status !== 0) return null;
    const bytes = readFileSync(out);
    if (bytes.length !== 768) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function changeScore(prev: Buffer, next: Buffer): number {
  const n = Math.min(prev.length, next.length);
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(prev[i] - next[i]);
  return sum / n / 255;
}

export interface SampleFrameResult {
  call: VideoCall;
  frame: VideoFrameRecord;
  /** 描述原文（只返回给调用方显示，不落盘）。 */
  description: string | null;
  skipped: boolean;
  held: boolean;
}

export async function sampleVideoFrame(opts: {
  home: string;
  workdir: string;
  callId: string;
  imagePath: string;
  config: Record<string, unknown>;
  videoCfg: VideoCallConfig;
  prompt?: string;
  mode?: VideoSampleMode;
  send?: boolean;
  runCommand?: CommandRunner;
  visionFn?: VisionFn;
  agentId?: string | null;
}): Promise<SampleFrameResult> {
  const run = opts.runCommand ?? defaultCommandRunner;
  const store = loadVideoCallStore(opts.home);
  const call = getVideoCall(store, opts.callId);
  if (call.status !== "active") throw new VideoCallError(`视频通话 ${opts.callId} 现在是 ${call.status}，采样不了（先接听）`);
  const mode = opts.mode ?? opts.videoCfg.sampleMode;
  const visionCfg = resolveVisionConfig(opts.config);
  const image = loadImageFile(opts.imagePath, opts.workdir, visionCfg);
  const frameId = newFrameId();
  const base: Omit<VideoFrameRecord, "engine" | "descriptionHash" | "chars" | "promptTokens" | "completionTokens" | "costUsd" | "status" | "heldReason" | "stored" | "sent" | "changeScore"> = {
    id: frameId, at: nowIso(), source: image.source,
    imageHash: shortImageHash(image.bytes), bytes: image.bytes.length,
    mode, sampled: true, skipReason: null,
  };

  // 采样门控：timed 看间隔；change 看画面变化（须 ffmpeg）。
  let score: number | null = null;
  if (mode === "timed") {
    if (call.lastSampledAt) {
      const elapsed = (Date.now() - Date.parse(call.lastSampledAt)) / 1000;
      if (elapsed < opts.videoCfg.sampleIntervalSeconds) {
        const frame: VideoFrameRecord = {
          ...base, engine: null, descriptionHash: null, chars: 0,
          promptTokens: null, completionTokens: null, costUsd: null,
          status: "skipped", heldReason: null, stored: false, sent: false, changeScore: null,
          sampled: false, skipReason: `距离上次采样才 ${elapsed.toFixed(1)} 秒，未到 ${opts.videoCfg.sampleIntervalSeconds} 秒间隔`,
        };
        appendVideoCallAudit(opts.home, { op: "frame-skipped", call_id: call.id, frame_id: frameId, mode, reason: frame.skipReason });
        mirrorVideoEvent(opts.home, call.runId, "video_frame_skipped", { call_id: call.id, mode, reason: "interval" });
        return { call, frame, description: null, skipped: true, held: false };
      }
    }
  }
  if (mode === "change") {
    // 画面变化：ffmpeg 把图缩成 16x16 签名，和上次的比平均绝对差。
    const sig = frameSignature(opts.imagePath, run);
    if (sig === null) {
      throw new VideoCallError("画面变化检测需要 ffmpeg（本机没有或解不出这张图），装好 ffmpeg 再用 change 档，或改用 on-demand / timed 档");
    }
    if (call.lastFrameSignature) {
      score = changeScore(Buffer.from(call.lastFrameSignature, "base64"), sig);
      if (score < opts.videoCfg.changeThreshold) {
        const frame: VideoFrameRecord = {
          ...base, engine: null, descriptionHash: null, chars: 0,
          promptTokens: null, completionTokens: null, costUsd: null,
          status: "skipped", heldReason: null, stored: false, sent: false, changeScore: score,
          sampled: false, skipReason: `画面变化 ${score.toFixed(3)}，低于阈值 ${opts.videoCfg.changeThreshold}`,
        };
        appendVideoCallAudit(opts.home, { op: "frame-skipped", call_id: call.id, frame_id: frameId, mode, reason: frame.skipReason });
        mirrorVideoEvent(opts.home, call.runId, "video_frame_skipped", { call_id: call.id, mode, reason: "no-change" });
        return { call, frame, description: null, skipped: true, held: false };
      }
    } else {
      score = 1; // 第一帧没有上一帧可比，直接采
    }
    call.lastFrameSignature = sig.toString("base64");
  }

  const described = call.frames.filter((f) => f.sampled).length;
  if (described >= opts.videoCfg.maxFramesPerCall) {
    throw new VideoCallError(`通话 ${opts.callId} 已满 ${opts.videoCfg.maxFramesPerCall} 帧，先挂断再开新通话`);
  }

  // 视觉描述：本地优先，云端须 opt-in + 硬顶。
  const prompt = opts.prompt ?? "描述这张画面里有什么（只说看到的，不推测画面之外的事）。";
  const visionFn = opts.visionFn ?? ((img: VisionImageInput, p: string) =>
    describeFrameDefault({ home: opts.home, config: opts.config, videoCfg: opts.videoCfg, image: img, prompt: p, agentId: opts.agentId ?? call.agent }));
  const result = await visionFn(image, prompt);
  const textHash = createHash("sha256").update(result.text, "utf-8").digest("hex").slice(0, 12);
  const intent = detectSensitiveIntent(result.text);

  // 落盘只在双方都同意录制时；发送只在 --send 且有正在跑的会话时。
  let stored = false;
  if (call.recordConsentLocal && call.recordConsentRemote) {
    const dir = join(videoCallDir(opts.home, call.id), "frames");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${frameId}.png`);
    writeFileSync(path, image.bytes, { mode: 0o600 });
    stored = true;
  }
  let sent = false;
  if (opts.send) {
    const lock = join(videoCallDir(opts.home, call.id), "session.lock");
    if (!existsSync(lock)) {
      throw new VideoCallError("没有正在跑的视频会话（先跑 nyra video call connect），帧只在本地描述、没发送");
    }
    const spool = join(videoCallDir(opts.home, call.id), "spool");
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    writeFileSync(join(spool, `${frameId}.png`), image.bytes, { mode: 0o600 });
    sent = true;
  }

  const frame: VideoFrameRecord = {
    ...base, engine: result.engine, descriptionHash: textHash, chars: result.text.length,
    promptTokens: result.promptTokens, completionTokens: result.completionTokens, costUsd: result.costUsd,
    status: intent ? "held" : "described", heldReason: intent,
    stored, sent, changeScore: score,
  };
  call.frames.push(frame);
  call.lastSampledAt = nowIso();
  saveVideoCallStore(opts.home, store);
  appendVideoCallAudit(opts.home, {
    op: "frame-sampled", call_id: call.id, frame_id: frameId, mode,
    engine: result.engine, chars: result.text.length, cost_usd: result.costUsd,
    image_hash: frame.imageHash, text_hash: textHash, status: frame.status,
    stored, sent,
  });
  mirrorVideoEvent(opts.home, call.runId, "video_frame_sampled", {
    call_id: call.id, frame_id: frameId, mode, engine: result.engine,
    chars: result.text.length, cost_usd: result.costUsd, image_hash: frame.imageHash,
  });
  if (intent) {
    appendVideoCallAudit(opts.home, { op: "frame-blocked", call_id: call.id, frame_id: frameId, reason: intent, text_hash: textHash });
    mirrorVideoEvent(opts.home, call.runId, "video_frame_blocked", { call_id: call.id, frame_id: frameId, reason: intent, text_hash: textHash });
    return { call, frame, description: result.text, skipped: false, held: true };
  }
  return { call, frame, description: result.text, skipped: false, held: false };
}

/** 确认一帧被扣下的描述（held → confirmed；只记“含义已确认”，不执行动作）。 */
export function confirmVideoFrame(home: string, callId: string, frameId: string): VideoFrameRecord {
  const store = loadVideoCallStore(home);
  const call = getVideoCall(store, callId);
  const frame = call.frames.find((f) => f.id === frameId);
  if (!frame) throw new VideoCallError(`通话 ${callId} 里找不到帧 ${frameId}`);
  if (frame.status !== "held") throw new VideoCallError(`帧 ${frameId} 现在是 ${frame.status}，不用确认`);
  frame.status = "confirmed";
  saveVideoCallStore(home, store);
  appendVideoCallAudit(home, { op: "frame-confirmed", call_id: call.id, frame_id: frameId, reason: frame.heldReason });
  mirrorVideoEvent(home, call.runId, "video_frame_confirmed", { call_id: call.id, frame_id: frameId, reason: frame.heldReason ?? "" });
  return frame;
}

// ---- 通话生命周期 ----

export function startVideoCall(home: string, opts: {
  agent?: string;
  peer?: string | null;
  loopback?: boolean;
  signalingUrl?: string;
  yes?: boolean;
  runId?: string | null;
}): VideoCall {
  const agent = typeof opts.agent === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(opts.agent) ? opts.agent : "nyra";
  const peer = typeof opts.peer === "string" && opts.peer.trim() ? opts.peer.trim().slice(0, 100) : null;
  if (peer && !opts.yes) {
    throw new VideoCallError(`呼叫 ${peer} 须加 --yes 确认（对外可见的动作，须显式确认）`);
  }
  const store = loadVideoCallStore(home);
  const call: VideoCall = {
    id: newVideoCallId(), agent, peer,
    transport: opts.loopback ? "loopback" : "webrtc",
    status: "ringing", iceState: "new", icePair: null,
    signalingUrl: opts.signalingUrl ?? "",
    startedAt: nowIso(), endedAt: null, frames: [],
    lastSampledAt: null, lastFrameSignature: null,
    degraded: false, videoOff: false,
    recordConsentLocal: false, recordConsentRemote: false,
    endRequested: false,
    transportBytesIn: 0, transportBytesOut: 0,
    framesSent: 0, framesReceived: 0, framesDroppedOversize: 0,
    runId: opts.runId ?? null,
  };
  store.calls.push(call);
  saveVideoCallStore(home, store);
  appendVideoCallAudit(home, { op: "started", call_id: call.id, agent, peer, transport: call.transport });
  mirrorVideoEvent(home, call.runId, "video_call_started", { call_id: call.id, agent, peer, transport: call.transport });
  return call;
}

export function answerVideoCall(home: string, callId: string): VideoCall {
  const store = loadVideoCallStore(home);
  const call = getVideoCall(store, callId);
  if (call.status !== "ringing") throw new VideoCallError(`视频通话 ${callId} 现在是 ${call.status}，接不了`);
  call.status = "active";
  saveVideoCallStore(home, store);
  appendVideoCallAudit(home, { op: "answered", call_id: call.id });
  mirrorVideoEvent(home, call.runId, "video_call_answered", { call_id: call.id });
  return call;
}

export function declineVideoCall(home: string, callId: string): VideoCall {
  const store = loadVideoCallStore(home);
  const call = getVideoCall(store, callId);
  if (call.status !== "ringing") throw new VideoCallError(`视频通话 ${callId} 现在是 ${call.status}，拒绝不了`);
  call.status = "declined";
  call.endedAt = nowIso();
  call.endRequested = true;
  saveVideoCallStore(home, store);
  appendVideoCallAudit(home, { op: "declined", call_id: call.id });
  mirrorVideoEvent(home, call.runId, "video_call_declined", { call_id: call.id });
  return call;
}

export function endVideoCall(home: string, callId: string): VideoCall {
  const store = loadVideoCallStore(home);
  const call = getVideoCall(store, callId);
  if (call.status === "ended" || call.status === "declined") throw new VideoCallError(`视频通话 ${callId} 已经结束了`);
  call.status = "ended";
  call.endedAt = nowIso();
  call.endRequested = true;
  saveVideoCallStore(home, store);
  const duration = Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000);
  const cost = totalFrameCost(call);
  appendVideoCallAudit(home, {
    op: "ended", call_id: call.id, duration_seconds: duration,
    frames: call.frames.filter((f) => f.sampled).length,
    frames_described: call.frames.filter((f) => f.status === "described" || f.status === "confirmed").length,
    bytes_in: call.transportBytesIn, bytes_out: call.transportBytesOut,
    cost_usd: cost, held: call.frames.filter((f) => f.status === "held").length,
  });
  mirrorVideoEvent(home, call.runId, "video_call_ended", {
    call_id: call.id, duration_seconds: duration,
    frames: call.frames.filter((f) => f.sampled).length,
    frames_described: call.frames.filter((f) => f.status === "described" || f.status === "confirmed").length,
    bytes_in: call.transportBytesIn, bytes_out: call.transportBytesOut,
    cost_usd: cost, held: call.frames.filter((f) => f.status === "held").length,
  });
  return call;
}

export function listVideoCalls(home: string, status?: VideoCallStatus, limit = 10): VideoCall[] {
  const store = loadVideoCallStore(home);
  const all = [...store.calls].reverse();
  const filtered = status ? all.filter((c) => c.status === status) : all;
  return filtered.slice(0, Math.max(1, Math.min(100, limit)));
}

export function totalFrameCost(call: VideoCall): number | null {
  let cost = 0;
  let unpriced = false;
  for (const f of call.frames) {
    if (f.costUsd === null && f.sampled) unpriced = true;
    else if (typeof f.costUsd === "number") cost += f.costUsd;
  }
  return unpriced ? null : Math.round(cost * 10000) / 10000;
}

// ---- 三本账总结（token 数只在这里出现，不上 status/list） ----

export interface VideoCallSummary {
  id: string;
  agent: string;
  peer: string | null;
  status: VideoCallStatus;
  durationSeconds: number | null;
  iceState: IceState;
  relayed: boolean;
  bytesIn: number;
  bytesOut: number;
  framesSampled: number;
  framesDescribed: number;
  framesSkipped: number;
  held: number;
  confirmed: number;
  framesSent: number;
  framesReceived: number;
  framesDroppedOversize: number;
  costUsd: number | null;
  degraded: boolean;
  videoOff: boolean;
  recording: boolean;
}

export function summarizeVideoCall(call: VideoCall): VideoCallSummary {
  const duration = call.endedAt
    ? Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000)
    : null;
  return {
    id: call.id, agent: call.agent, peer: call.peer, status: call.status,
    durationSeconds: duration, iceState: call.iceState,
    relayed: call.icePair?.relayed ?? false,
    bytesIn: call.transportBytesIn, bytesOut: call.transportBytesOut,
    framesSampled: call.frames.filter((f) => f.sampled).length,
    framesDescribed: call.frames.filter((f) => f.status === "described" || f.status === "confirmed").length,
    framesSkipped: call.frames.filter((f) => f.status === "skipped").length,
    held: call.frames.filter((f) => f.status === "held").length,
    confirmed: call.frames.filter((f) => f.status === "confirmed").length,
    framesSent: call.framesSent, framesReceived: call.framesReceived,
    framesDroppedOversize: call.framesDroppedOversize,
    costUsd: totalFrameCost(call),
    degraded: call.degraded, videoOff: call.videoOff,
    recording: call.recordConsentLocal && call.recordConsentRemote,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 三本账总结文本（用量弹层与结束总结的数据口径：token 只按主人拆分列在这里）。 */
export function formatVideoCallSummary(call: VideoCall): string {
  const s = summarizeVideoCall(call);
  const money = (v: number | null): string => (v === null ? "未计价" : `$${v.toFixed(4)}`);
  const engines = [...new Set(call.frames.filter((f) => f.engine).map((f) => f.engine as string))];
  const lines = [
    `视频通话 ${s.id}（${s.peer ?? "本机回环"} · agent ${s.agent}）：${s.status}`,
    `时长：${s.durationSeconds !== null ? `${Math.floor(s.durationSeconds / 60)} 分 ${s.durationSeconds % 60} 秒` : "进行中"}`,
    `传输：ICE ${s.iceState}${s.relayed ? "（经 TURN 中转）" : "（直连）"} · 上行 ${formatBytes(s.bytesOut)} · 下行 ${formatBytes(s.bytesIn)} · 超大丢帧 ${s.framesDroppedOversize} · 未加密（ICE 直连 UDP 通道；端到端加密须原生 WebRTC 栈）`,
    `看：共 ${s.framesSampled} 帧（已描述 ${s.framesDescribed} · 跳过 ${s.framesSkipped} · 待确认 ${s.held} · 已确认 ${s.confirmed}）· 发出 ${s.framesSent} 帧 · 收到 ${s.framesReceived} 帧 · 引擎 ${engines.length ? engines.join("、") : "无"} · 花费 ${money(s.costUsd)}${s.costUsd === null ? "（有未计价部分，花费只是下界）" : ""}`,
    "干活：本次通话未把描述当任务跑，无 LLM token 花费。",
    `录制：${s.recording ? "双方已同意，帧存本地" : "关（默认不录；落盘须双方同意）"}`,
    `网络：${s.degraded ? "较弱，已自动切到仅语音（协作与 agent 不受影响）" : "正常"}${call.transport === "loopback" ? " · 本机回环" : ""}`,
  ];
  return lines.join("\n");
}

// ---- connect 前台会话：协商 → 守住 → 转发 spool → 收帧进 inbox ----

export interface VideoSessionOptions {
  home: string;
  callId: string;
  role: "caller" | "callee";
  config: Record<string, unknown>;
  videoCfg: VideoCallConfig;
  signalingUrl?: string;
  /** 测试可注入的传输（跳过真实协商）。 */
  transport?: WebRtcTransport;
}

function writeSessionStats(home: string, callId: string, patch: Partial<VideoCall>): void {
  try {
    const store = loadVideoCallStore(home);
    const call = getVideoCall(store, callId);
    Object.assign(call, patch);
    saveVideoCallStore(home, store);
  } catch { /* 会话退出时写不回也不挡退出 */ }
}

/**
 * 前台视频会话（`nyra video call connect` 跑的那个进程）：
 * 协商 → 连通后守住 → 每 500ms 看 spool 目录，有新帧就经媒体面发出去
 * → 收到的帧写 inbox → 每秒查一次账本，看到 endRequested 或对方挂断
 * 就收尾退出；Ctrl+C 同样收尾。Loopback 传输时不协商、直接“连通”。
 */
export async function runVideoSession(opts: VideoSessionOptions): Promise<number> {
  const { home, callId, role } = opts;
  const call = getVideoCall(loadVideoCallStore(home), callId);
  if (call.status !== "active") {
    process.stderr.write(`视频通话 ${callId} 现在是 ${call.status}，连不了（先接听）\n`);
    return 1;
  }
  const dir = videoCallDir(home, callId);
  const spoolDir = join(dir, "spool");
  const inboxDir = join(dir, "inbox");
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, "session.lock");
  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });

  let transport: WebRtcTransport | null = opts.transport ?? null;
  let plane: VideoMediaPlane | null = null;
  let stopped = false;
  let stopResolve: (() => void) | null = null;
  const stopPromise = new Promise<void>((r) => { stopResolve = r; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopResolve?.();
    try { transport?.stop(callId); } catch { /* ignore */ }
    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  };
  process.once("SIGINT", () => {
    process.stdout.write("\n收到 Ctrl+C，正在挂断……\n");
    stop();
  });

  try {
    if (call.transport === "loopback") {
      plane = new LocalMediaPlane();
      writeSessionStats(home, callId, { iceState: "connected", icePair: { local: "127.0.0.1:0", remote: "127.0.0.1:0", relayed: false, rttMs: 0 } });
      process.stdout.write(`视频通话 ${callId}：本机回环已连通（不走网络，只在本地收发帧）\n`);
    } else {
      transport = transport ?? new WebRtcTransport({
        home,
        config: opts.videoCfg,
        role,
        signalingUrl: opts.signalingUrl,
        onEvent: (event, detail) => {
          if (event === "connected") {
            appendVideoCallAudit(home, { op: "transport-connected", call_id: callId, relayed: detail.relayed, rtt_ms: detail.rtt_ms });
            mirrorVideoEvent(home, call.runId, "video_call_transport_connected", { call_id: callId, ice_pair: String(detail.remote ?? ""), relayed: Boolean(detail.relayed), rtt_ms: typeof detail.rtt_ms === "number" ? detail.rtt_ms : 0 });
          }
          if (event === "failed") {
            appendVideoCallAudit(home, { op: "transport-failed", call_id: callId, reason: String(detail.reason ?? "") });
            mirrorVideoEvent(home, call.runId, "video_call_transport_failed", { call_id: callId, reason: String(detail.reason ?? "").slice(0, 100) });
          }
        },
      });
      transport.start(callId);
      process.stdout.write(`视频通话 ${callId}：正在协商（信令 ${opts.signalingUrl ?? opts.videoCfg.signalingUrl}，等对方 ${role === "caller" ? "接听" : "发起"}）……\n`);
      const pair = await Promise.race([
        transport.waitConnected(60000),
        stopPromise.then(() => { throw new VideoCallError("会话已停止"); }),
      ]);
      plane = transport.mediaPlane;
      writeSessionStats(home, callId, {
        iceState: "connected",
        icePair: { local: `${pair.local.address}:${pair.local.port}`, remote: `${pair.remote.address}:${pair.remote.port}`, relayed: pair.relayed, rttMs: pair.rttMs },
      });
      process.stdout.write(`已连通：${pair.remote.address}:${pair.remote.port}${pair.relayed ? "（经 TURN 中转）" : "（直连）"}，往返 ${pair.rttMs}ms\n`);
    }

    // 对方同意录制：信令里收到 record-consent 就记下（落盘须双方同意）。
    if (transport?.signaling) {
      transport.signaling.onMessage((msg) => {
        if (msg.room === callId && msg.type === "record-consent") {
          writeSessionStats(home, callId, { recordConsentRemote: true });
          appendVideoCallAudit(home, { op: "record-consent-remote", call_id: callId });
          process.stdout.write("对方已同意录制。\n");
        }
      });
      const fresh = getVideoCall(loadVideoCallStore(home), callId);
      if (fresh.recordConsentLocal) {
        try { transport.signaling.send("record-consent", callId, "local"); } catch { /* 对方还没进房，收不到就算了 */ }
      }
    }

    // 收到的帧写 inbox（只记哈希与字节数，不自动描述）。
    plane?.onFrame((bytes) => {
      const frameId = newFrameId();
      const path = join(inboxDir, `${frameId}.bin`);
      try { writeFileSync(path, bytes, { mode: 0o600 }); } catch { return; }
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      appendVideoCallAudit(home, { op: "frame-received", call_id: callId, frame_id: frameId, bytes: bytes.length, image_hash: hash });
      mirrorVideoEvent(home, call.runId, "video_frame_received", { call_id: callId, frame_id: frameId, bytes: bytes.length, image_hash: hash });
      writeSessionStats(home, callId, { framesReceived: getVideoCall(loadVideoCallStore(home), callId).framesReceived + 1 });
      process.stdout.write(`收到对方一帧（${bytes.length} 字节，已存 inbox/${frameId}.bin，可用 sample 描述它）\n`);
    });

    // 主循环：发 spool 里的帧 + 查 endRequested + 弱网降级。
    const weakRttMs = opts.videoCfg.weakRttMs;
    let lastWeakCheck = 0;
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 500));
      const current = getVideoCall(loadVideoCallStore(home), callId);
      if (current.endRequested || current.status === "ended" || current.status === "declined") {
        process.stdout.write("通话已结束，正在收尾……\n");
        break;
      }
      // 发 spool 里的帧（发完删掉，免得重发）。
      if (plane) {
        let names: string[] = [];
        try { names = readdirSync(spoolDir).filter((f) => f.endsWith(".png")).sort(); } catch { names = []; }
        for (const name of names) {
          const path = join(spoolDir, name);
          let bytes: Buffer;
          try { bytes = readFileSync(path); } catch { continue; }
          try {
            await plane.sendFrame(bytes);
            rmSync(path, { force: true });
            const c = getVideoCall(loadVideoCallStore(home), callId);
            writeSessionStats(home, callId, { framesSent: c.framesSent + 1, transportBytesOut: c.transportBytesOut + bytes.length });
            appendVideoCallAudit(home, { op: "frame-sent", call_id: callId, frame_id: name.replace(/\.png$/, ""), bytes: bytes.length });
            mirrorVideoEvent(home, call.runId, "video_frame_sent", { call_id: callId, frame_id: name.replace(/\.png$/, ""), bytes: bytes.length });
          } catch (err: unknown) {
            process.stderr.write(`帧 ${name} 发送失败：${err instanceof Error ? err.message : String(err)}（留在 spool，下次再试）\n`);
            break;
          }
        }
      }
      // 弱网降级：ICE 往返持续超阈值就切到仅语音，恢复了再回来。
      if (transport?.ice && Date.now() - lastWeakCheck > 5000) {
        lastWeakCheck = Date.now();
        const ice = transport.ice;
        const cur = getVideoCall(loadVideoCallStore(home), callId);
        if (ice.lastRttMs !== null && ice.lastRttMs > weakRttMs && !cur.degraded) {
          writeSessionStats(home, callId, { degraded: true, videoOff: true });
          appendVideoCallAudit(home, { op: "degraded", call_id: callId, reason: `ICE 往返 ${ice.lastRttMs}ms，超过 ${weakRttMs}ms` });
          mirrorVideoEvent(home, call.runId, "video_call_degraded", { call_id: callId, reason: "weak-network" });
          process.stdout.write(`网络较弱（往返 ${ice.lastRttMs}ms），已自动切到仅语音，网好了视频会自己回来。\n`);
        } else if (ice.lastRttMs !== null && ice.lastRttMs <= weakRttMs && cur.degraded) {
          writeSessionStats(home, callId, { degraded: false, videoOff: false });
          appendVideoCallAudit(home, { op: "restored", call_id: callId });
          mirrorVideoEvent(home, call.runId, "video_call_restored", { call_id: callId });
          process.stdout.write("网络恢复了，视频已回来。\n");
        }
      }
    }
  } catch (err: unknown) {
    process.stderr.write(`视频会话失败：${err instanceof Error ? err.message : String(err)}\n`);
    stop();
    return 1;
  } finally {
    // 收尾：把传输计数写回账本，再关传输。
    try {
      const ice = transport?.ice;
      if (ice) {
        const cur = getVideoCall(loadVideoCallStore(home), callId);
        writeSessionStats(home, callId, {
          transportBytesIn: cur.transportBytesIn + ice.bytesIn,
          transportBytesOut: cur.transportBytesOut + ice.bytesOut,
          framesDroppedOversize: ice.droppedOversize,
          iceState: ice.state,
        });
      }
    } catch { /* ignore */ }
    stop();
  }
  return 0;
}

// ---- `nyra video` 子命令 ----

export interface VideoCallCliInput {
  visionFn?: VisionFn;
  runCommand?: CommandRunner;
  fetchFn?: typeof fetch;
}

function videoUsageError(msg: string): number {
  process.stderr.write(`${msg}\n`);
  process.stderr.write("用法：nyra video call <start [--peer <名字>|--friend <好友名>] [--agent <id>] [--yes] [--loopback]|answer <通话 id>|decline <通话 id>|end <通话 id>|status [通话 id]|list|connect <通话 id> --role caller|callee|sample <通话 id> <图片> [--mode on-demand|change|timed] [--prompt \"<文字>\"] [--send]|confirm <通话 id> <帧 id>|consent-record <通话 id> --yes|summary <通话 id>>\n");
  process.stderr.write("信令：nyra video signal <serve [--port 18789] [--host 127.0.0.1]|status>\n");
  process.stderr.write("诊断：nyra video ice gather [--stun <url>] [--turn <url>]\n");
  return 2;
}

export async function handleVideoCall(argv: string[], home: string, input?: VideoCallCliInput): Promise<number> {
  const config = loadConfig(home);
  const videoCfg = resolveVideoCallConfig(config);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flag = (name: string): string | null => {
    const i = rest.indexOf(name);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
  };
  const has = (name: string): boolean => rest.includes(name);
  try {
    if (!cmd || cmd === "status") {
      const id = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
      if (id) {
        const call = getVideoCall(loadVideoCallStore(home), id);
        const s = summarizeVideoCall(call);
        // status 不放 token/花费数（SPEC：数只在用量弹层与结束总结里出现）。
        process.stdout.write(
          `视频通话 ${call.id}（${call.peer ?? "本机回环"} · agent ${call.agent}）：${call.status}\n` +
          `传输：${call.transport} · ICE ${call.iceState}${call.icePair ? `（${call.icePair.relayed ? "经 TURN 中转" : "直连"} · ${call.icePair.remote}）` : ""}\n` +
          `帧：共 ${s.framesSampled} 帧（已描述 ${s.framesDescribed} · 待确认 ${s.held}）· 发出 ${s.framesSent} · 收到 ${s.framesReceived}\n` +
          `网络：${s.degraded ? "较弱，已切仅语音" : "正常"} · 录制：${s.recording ? "双方已同意" : "关"}\n`,
        );
        return 0;
      }
      const calls = listVideoCalls(home, undefined, 10);
      if (calls.length === 0) {
        process.stdout.write("还没有视频通话记录。先开一通：nyra video call start\n");
        return 0;
      }
      for (const c of calls) {
        const s = summarizeVideoCall(c);
        process.stdout.write(`${c.id} · ${c.peer ?? "本机回环"} · ${c.status} · ICE ${c.iceState} · ${s.framesSampled} 帧\n`);
      }
      return 0;
    }
    if (cmd === "list") {
      const calls = listVideoCalls(home, undefined, 20);
      if (calls.length === 0) {
        process.stdout.write("还没有视频通话记录。\n");
        return 0;
      }
      for (const c of calls) {
        process.stdout.write(`${c.id} · ${c.peer ?? "本机回环"} · ${c.status} · ${c.startedAt}\n`);
      }
      return 0;
    }
    if (cmd === "start") {
      // 缺口 38：--friend 按好友账本解析（须是已批准、未拉黑的好友）；
      // --peer 保持原样（任意名字 + --yes），不破坏既有行为。
      const friendName = flag("--friend");
      let peer = flag("--peer");
      if (friendName) {
        if (peer) return videoUsageError("用法：--peer 与 --friend 只能二选一");
        try {
          const { resolveFriendForCall } = await import("./peerCard.ts");
          const friend = resolveFriendForCall(home, friendName);
          peer = friend.name;
        } catch (e) {
          return videoUsageError(e instanceof Error ? e.message : String(e));
        }
      }
      const call = startVideoCall(home, {
        agent: flag("--agent") ?? undefined,
        peer,
        loopback: has("--loopback"),
        signalingUrl: videoCfg.signalingUrl,
        yes: has("--yes"),
        runId: flag("--run"),
      });
      process.stdout.write(`视频通话已建立：${call.id}（${call.peer ?? "本机回环"}，响铃中，传输 ${call.transport}）\n`);
      process.stdout.write(`接听：nyra video call answer ${call.id}\n`);
      if (call.transport === "webrtc") {
        process.stdout.write(`接通要跑协商：nyra video call connect ${call.id} --role caller（前台会话，连通后守住）\n`);
      }
      return 0;
    }
    if (cmd === "answer" || cmd === "decline" || cmd === "end") {
      const id = rest[0];
      if (!id) return videoUsageError(`用法：nyra video call ${cmd} <通话 id>`);
      const call = cmd === "answer" ? answerVideoCall(home, id)
        : cmd === "decline" ? declineVideoCall(home, id)
        : endVideoCall(home, id);
      if (cmd === "end") {
        process.stdout.write(`${formatVideoCallSummary(call)}\n`);
      } else {
        process.stdout.write(`视频通话 ${call.id}：${cmd === "answer" ? "已接听，开始通话" : "已拒绝"}\n`);
        if (cmd === "answer" && call.transport === "webrtc") {
          process.stdout.write(`接通要跑协商：nyra video call connect ${call.id} --role callee（前台会话，连通后守住）\n`);
        }
      }
      return 0;
    }
    if (cmd === "connect") {
      const id = rest[0];
      const role = flag("--role");
      if (!id || (role !== "caller" && role !== "callee")) {
        return videoUsageError("用法：nyra video call connect <通话 id> --role caller|callee");
      }
      return runVideoSession({ home, callId: id, role, config, videoCfg });
    }
    if (cmd === "sample") {
      const id = rest[0];
      const imagePath = rest[1];
      if (!id || !imagePath) return videoUsageError("用法：nyra video call sample <通话 id> <图片> [--mode on-demand|change|timed] [--prompt \"<文字>\"] [--send]");
      const modeRaw = flag("--mode");
      const mode: VideoSampleMode | undefined = modeRaw === "change" || modeRaw === "timed" || modeRaw === "on-demand" ? modeRaw : undefined;
      if (modeRaw && !mode) return videoUsageError(`采样档只支持 on-demand / change / timed，收到 ${modeRaw}`);
      const result = await sampleVideoFrame({
        home, workdir: process.cwd(), callId: id, imagePath, config,
        videoCfg, prompt: flag("--prompt") ?? undefined, mode,
        send: has("--send"),
        runCommand: input?.runCommand, visionFn: input?.visionFn,
      });
      if (result.skipped) {
        process.stdout.write(`帧 ${result.frame.id}：已跳过（${result.frame.skipReason ?? "未到采样条件"}，没看、没花钱）\n`);
        return 0;
      }
      process.stdout.write(`看到（${result.frame.engine}，${result.frame.chars} 字）：${result.description ?? ""}\n`);
      if (result.held) {
        const kind = result.frame.heldReason === "payment" ? "支付类" : "对外发送类";
        process.stdout.write(`这帧的描述是${kind}意图，已扣下，没执行。确认含义后执行：nyra video call confirm ${id} ${result.frame.id}（确认只记“含义已确认”，执行请把文字当普通任务跑；描述原文不落盘）\n`);
        return 0;
      }
      if (result.frame.stored) process.stdout.write(`帧已存本地（双方已同意录制）：${result.frame.id}\n`);
      if (result.frame.sent) process.stdout.write(`帧已放入发送队列（会话在跑时会经 ICE 发出去）\n`);
      return 0;
    }
    if (cmd === "confirm") {
      const id = rest[0];
      const frameId = rest[1];
      if (!id || !frameId) return videoUsageError("用法：nyra video call confirm <通话 id> <帧 id>");
      const frame = confirmVideoFrame(home, id, frameId);
      process.stdout.write(`帧 ${frameId} 已确认（${frame.heldReason === "payment" ? "支付类" : "对外发送类"}意图，含义已确认）。确认不执行动作：要执行请把这帧的描述文字当普通任务跑。\n`);
      return 0;
    }
    if (cmd === "consent-record") {
      const id = rest[0];
      if (!id) return videoUsageError("用法：nyra video call consent-record <通话 id> --yes");
      if (!has("--yes")) return videoUsageError("录制须显式同意：nyra video call consent-record <通话 id> --yes（只代表你这边同意，对方也要同意才开始录）");
      const store = loadVideoCallStore(home);
      const call = getVideoCall(store, id);
      call.recordConsentLocal = true;
      saveVideoCallStore(home, store);
      appendVideoCallAudit(home, { op: "record-consent-local", call_id: call.id });
      process.stdout.write(`已记录你这边同意录制（通话 ${id}）。对方也要同意才会开始录，帧才落盘。\n`);
      return 0;
    }
    if (cmd === "summary") {
      const id = rest[0];
      if (!id) return videoUsageError("用法：nyra video call summary <通话 id>");
      const call = getVideoCall(loadVideoCallStore(home), id);
      process.stdout.write(`${formatVideoCallSummary(call)}\n`);
      return 0;
    }
    return videoUsageError(`未知子命令：${cmd}`);
  } catch (err: unknown) {
    process.stderr.write(`视频通话失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function handleVideoSignal(argv: string[], home: string): Promise<number> {
  const config = loadConfig(home);
  const videoCfg = resolveVideoCallConfig(config);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flag = (name: string): string | null => {
    const i = rest.indexOf(name);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
  };
  try {
    if (cmd === "serve") {
      const port = Number(flag("--port") ?? 18789);
      const host = flag("--host") ?? "127.0.0.1";
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        process.stderr.write("端口不合法（1–65535）。\n");
        return 2;
      }
      if (host === "0.0.0.0") {
        process.stderr.write("注意：信令绑 0.0.0.0 会对外暴露，请确认防火墙只放你信任的网络。\n");
      }
      const server = new VideoSignalingServer({ port, host });
      process.stdout.write(`信令服务器已起：${server.url}（按 Ctrl+C 停）\n`);
      await new Promise<void>((resolvePromise) => {
        process.once("SIGINT", () => {
          server.stop();
          process.stdout.write("信令服务器已停。\n");
          resolvePromise();
        });
      });
      return 0;
    }
    if (cmd === "status" || !cmd) {
      const client = new VideoSignalingClient(videoCfg.signalingUrl);
      try {
        await client.connect();
        process.stdout.write(`信令服务器可达：${videoCfg.signalingUrl}\n`);
        return 0;
      } catch (err: unknown) {
        process.stderr.write(`信令服务器连不上：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      } finally {
        client.close();
      }
    }
    process.stderr.write(`未知子命令：${cmd}（用法：nyra video signal <serve|status>）\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`信令失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function handleVideoIce(argv: string[], home: string): Promise<number> {
  const config = loadConfig(home);
  const videoCfg = resolveVideoCallConfig(config);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flag = (name: string): string | null => {
    const i = rest.indexOf(name);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
  };
  try {
    if (cmd !== "gather") {
      process.stderr.write(`未知子命令：${cmd ?? ""}（用法：nyra video ice gather [--stun <url>] [--turn <url>]）\n`);
      return 2;
    }
    const stunUrls = flag("--stun") ? [flag("--stun") as string] : videoCfg.stunUrls;
    const turnUrls = flag("--turn") ? [flag("--turn") as string] : videoCfg.turnUrls;
    const identity = newIceIdentity();
    const ice = new IceTransport({ ufrag: identity.ufrag, password: identity.password });
    try {
      const candidates = await ice.gather({
        stunUrls, turnUrls,
        turnUsername: videoCfg.turnUsername,
        turnCredential: resolveTurnCredential(home),
      });
      if (candidates.length === 0) {
        process.stdout.write("没收集到任何候选（网卡/STUN/TURN 全不通）。\n");
        return 1;
      }
      for (const c of candidates) {
        process.stdout.write(`${c.type} · ${c.address}:${c.port} · 优先级 ${c.priority}\n`);
      }
      return 0;
    } finally {
      ice.close();
    }
  } catch (err: unknown) {
    process.stderr.write(`ICE 收集失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** `nyra video` 顶层分发（cli.ts 接这里）。 */
export async function handleVideo(argv: string[], home: string, input?: VideoCallCliInput): Promise<number> {
  const sub = argv[0];
  if (sub === "call") return handleVideoCall(argv.slice(1), home, input);
  if (sub === "signal") return handleVideoSignal(argv.slice(1), home);
  if (sub === "ice") return handleVideoIce(argv.slice(1), home);
  process.stderr.write("用法：nyra video <call|signal|ice> ……（详见 docs/video-call.md）\n");
  return 2;
}
