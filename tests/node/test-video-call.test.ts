// tests/node/test-video-call.test.ts — 缺口 37：视频通话 + 按需视觉采样。
// STUN 编解码与签名、假 STUN/TURN 服务器、两端 ICE 检查与帧收发、
// 信令双客户端、两端 WebRtcTransport 协商、采样三档、本地优先与云端
// opt-in、云端花费记账、敏感意图扣下与确认、双同意落盘、事件与时间线、
// CLI 端到端。
//
// 本机沙箱禁 UDP sendto（EPERM）：协议逻辑走内存虚拟 socket 验（注入式
// socket，与实现用的 Socket 接口同款调用面）；真 UDP 另有守卫测试——
// 沙箱里自动跳过，CI 上真跑。
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import {
  DEFAULT_VIDEO_CALL_CONFIG, IceTransport, LocalMediaPlane, TurnClient,
  VideoSignalingClient, VideoSignalingServer, WebRtcTransport,
  answerVideoCall, changeScore, confirmVideoFrame, declineVideoCall, describeFrameDefault,
  encodeStunMessage, encodeXorAddress, endVideoCall, formatVideoCallSummary, frameSignature,
  gatherHostCandidates, handleVideo, handleVideoCall, handleVideoIce, handleVideoSignal,
  icePriority, listVideoCalls, loadVideoCallStore, newIceIdentity, newTransactionId,
  parseStunMessage, parseStunUrl, resolveVideoCallConfig, sampleVideoFrame, saveVideoCallStore,
  signStunMessage, startVideoCall, stunAttr, stunBindingRequest, stunLongTermKey, summarizeVideoCall,
  verifyStunMessage,
  STUN_ALLOCATE_ERROR, STUN_ALLOCATE_REQUEST, STUN_ALLOCATE_SUCCESS,
  STUN_ATTR_ERROR_CODE, STUN_ATTR_LIFETIME, STUN_ATTR_NONCE, STUN_ATTR_REALM,
  STUN_ATTR_USERNAME, STUN_ATTR_XOR_MAPPED_ADDRESS, STUN_ATTR_XOR_PEER_ADDRESS,
  STUN_ATTR_XOR_RELAYED_ADDRESS, STUN_ATTR_DATA,
  STUN_BINDING_REQUEST, STUN_BINDING_SUCCESS,
  STUN_CREATE_PERMISSION_REQUEST, STUN_CREATE_PERMISSION_SUCCESS,
  STUN_REFRESH_REQUEST, STUN_REFRESH_SUCCESS, STUN_SEND_INDICATION,
  type VideoCallConfig,
} from "../../src/videoCall.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-vcall-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-vcall-wd-"));
  return { home, workdir };
}

/** 1x1 透明 PNG（loadImageFile 只认扩展名与文件头，这张够真）。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function writePng(workdir: string, name = "frame.png"): string {
  const p = join(workdir, name);
  writeFileSync(p, PNG_1X1);
  return p;
}

function activeCall(home: string, peer?: string | null): string {
  const call = startVideoCall(home, { peer: peer ?? null, yes: true, loopback: true });
  answerVideoCall(home, call.id);
  return call.id;
}

function fakeVision(text: string, engine = "fake-vision", costUsd: number | null = 0) {
  return async () => ({ text, engine, promptTokens: 10, completionTokens: 5, costUsd });
}

/** 假 ffmpeg：每次调用把下一份 16x16 签名（768 字节）写到输出路径上。 */
function fakeFfmpegRunner(signatures: Buffer[]) {
  let n = 0;
  return (binary: string, args: string[]) => {
    if (binary !== "ffmpeg") return { status: 1, stdout: "", stderr: "not ffmpeg" };
    const out = args[args.length - 1];
    const sig = signatures[Math.min(n, signatures.length - 1)];
    n++;
    writeFileSync(out, sig);
    return { status: 0, stdout: "", stderr: "" };
  };
}

// ---- 内存虚拟 UDP：本机沙箱禁 sendto，协议逻辑改走它验 ----

class VirtualUdpHub {
  private sockets = new Map<number, VirtualSocket>();
  private nextPort = 40000;
  assign(sock: VirtualSocket): number {
    const port = this.nextPort++;
    this.sockets.set(port, sock);
    return port;
  }
  deliver(fromPort: number, toPort: number, bytes: Buffer): void {
    const target = this.sockets.get(toPort);
    if (!target) return; // 发往没绑的端口：UDP 语义，直接丢
    setImmediate(() => target.emit("message", Buffer.from(bytes), { address: "127.0.0.1", port: fromPort }));
  }
  unregister(port: number): void {
    this.sockets.delete(port);
  }
}

class VirtualSocket extends EventEmitter {
  private port = 0;
  constructor(private hub: VirtualUdpHub) {
    super();
  }
  bind(port = 0, _host?: string, cb?: () => void): void {
    if (!this.port) this.port = this.hub.assign(this);
    if (typeof cb === "function") setImmediate(cb);
  }
  address(): { address: string; port: number; family: number } {
    return { address: "127.0.0.1", port: this.port, family: 4 };
  }
  send(bytes: Buffer, port: number, _host: string, cb?: (err: Error | null) => void): void {
    // 真 dgram 第一次 send 会隐式绑定一个临时端口；虚拟 socket 也一样，
    // 否则回包找不到收件人（TurnClient/stunBindingRequest 都不显式 bind）。
    if (!this.port) this.port = this.hub.assign(this);
    this.hub.deliver(this.port, port, Buffer.from(bytes));
    if (typeof cb === "function") setImmediate(() => cb(null));
  }
  close(): void {
    if (this.port) this.hub.unregister(this.port);
    this.port = 0;
  }
}

function asSocket(v: VirtualSocket): Socket {
  return v as unknown as Socket;
}

/** 假 STUN 服务器的回包逻辑（虚拟 socket 与真 dgram 共用）。 */
function stunServerReply(msg: Buffer, rinfo: { address: string; port: number }): Buffer | null {
  let parsed;
  try {
    parsed = parseStunMessage(msg);
  } catch {
    return null;
  }
  if (parsed.type !== STUN_BINDING_REQUEST) return null;
  return encodeStunMessage(STUN_BINDING_SUCCESS, parsed.transactionId, [
    encodeXorAddress(STUN_ATTR_XOR_MAPPED_ADDRESS, rinfo.address, rinfo.port),
  ]);
}

/** 假 TURN 服务器的回包逻辑（401 舞蹈 + Allocate/Refresh/Permission/Send）。 */
function turnServerReply(
  msg: Buffer,
  _rinfo: { address: string; port: number },
  sent: Buffer[],
): Buffer | null {
  let parsed;
  try {
    parsed = parseStunMessage(msg);
  } catch {
    return null;
  }
  if (parsed.type === STUN_ALLOCATE_REQUEST) {
    if (stunAttr(parsed, STUN_ATTR_USERNAME) === null) {
      return encodeStunMessage(STUN_ALLOCATE_ERROR, parsed.transactionId, [
        { type: STUN_ATTR_ERROR_CODE, value: Buffer.from([0, 0, 4, 1]) },
        { type: STUN_ATTR_REALM, value: Buffer.from("test", "utf-8") },
        { type: STUN_ATTR_NONCE, value: Buffer.from("nonce-1", "utf-8") },
      ]);
    }
    const lifetime = Buffer.alloc(4);
    lifetime.writeUInt32BE(600, 0);
    return encodeStunMessage(STUN_ALLOCATE_SUCCESS, parsed.transactionId, [
      encodeXorAddress(STUN_ATTR_XOR_RELAYED_ADDRESS, "127.0.0.1", 50099),
      { type: STUN_ATTR_LIFETIME, value: lifetime },
    ]);
  }
  if (parsed.type === STUN_REFRESH_REQUEST) {
    return encodeStunMessage(STUN_REFRESH_SUCCESS, parsed.transactionId, []);
  }
  if (parsed.type === STUN_CREATE_PERMISSION_REQUEST) {
    return encodeStunMessage(STUN_CREATE_PERMISSION_SUCCESS, parsed.transactionId, []);
  }
  if (parsed.type === STUN_SEND_INDICATION) {
    const data = stunAttr(parsed, STUN_ATTR_DATA);
    if (data) sent.push(Buffer.from(data));
    return null;
  }
  return null;
}

function attachVirtualStun(hub: VirtualUdpHub): { socket: VirtualSocket; port: number } {
  const socket = new VirtualSocket(hub);
  socket.on("message", (msg: Buffer, rinfo: { address: string; port: number }) => {
    const resp = stunServerReply(msg, rinfo);
    if (resp) socket.send(resp, rinfo.port, rinfo.address);
  });
  socket.bind(0);
  return { socket, port: socket.address().port };
}

function attachVirtualTurn(hub: VirtualUdpHub): { socket: VirtualSocket; port: number; sent: Buffer[] } {
  const socket = new VirtualSocket(hub);
  const sent: Buffer[] = [];
  socket.on("message", (msg: Buffer, rinfo: { address: string; port: number }) => {
    const resp = turnServerReply(msg, rinfo, sent);
    if (resp) socket.send(resp, rinfo.port, rinfo.address);
  });
  socket.bind(0);
  return { socket, port: socket.address().port, sent };
}

// ---- 真 UDP 守卫：沙箱里禁 sendto 时跳过，CI 上真跑 ----

let realUdpCache: boolean | null = null;

async function realUdpWorks(): Promise<boolean> {
  if (realUdpCache !== null) return realUdpCache;
  const ok = await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { a.close(); } catch { /* ignore */ }
      try { b.close(); } catch { /* ignore */ }
      resolvePromise(v);
    };
    const a = createSocket("udp4");
    const b = createSocket("udp4");
    b.on("message", () => done(true));
    b.on("error", () => done(false));
    a.on("error", () => done(false));
    try {
      b.bind(0, "127.0.0.1", () => {
        a.send(Buffer.from("ping"), b.address().port, "127.0.0.1", (err) => {
          if (err) done(false);
        });
      });
    } catch {
      done(false);
    }
    setTimeout(() => done(false), 1000);
  });
  realUdpCache = ok;
  return ok;
}

function skipNoUdp(): void {
  process.stdout.write("（跳过：本机沙箱禁 UDP sendto，真 UDP 只在 CI 上跑）\n");
}

// ---- STUN 编解码与签名 ----

test("VideoCallTest.test_stun_encode_decode_roundtrip", () => {
  const tid = newTransactionId();
  const bytes = encodeStunMessage(STUN_BINDING_REQUEST, tid, [
    { type: STUN_ATTR_USERNAME, value: Buffer.from("alice:bob", "utf-8") },
  ]);
  expect(bytes[0]).toBe(0);
  expect(bytes[1]).toBe(1);
  const msg = parseStunMessage(bytes);
  expect(msg.type).toBe(STUN_BINDING_REQUEST);
  expect(msg.transactionId.equals(tid)).toBe(true);
  expect(stunAttr(msg, STUN_ATTR_USERNAME)?.toString("utf-8")).toBe("alice:bob");
  expect(() => parseStunMessage(Buffer.from([0, 1, 2]))).toThrow();
});

test("VideoCallTest.test_stun_sign_verify_and_tamper", () => {
  const tid = newTransactionId();
  const key = stunLongTermKey("alice", "test", "secret");
  const signed = signStunMessage(STUN_BINDING_REQUEST, tid, [
    { type: STUN_ATTR_USERNAME, value: Buffer.from("alice:bob", "utf-8") },
  ], key);
  const msg = parseStunMessage(signed);
  expect(verifyStunMessage(msg, signed, key)).toBe(true);
  const tampered = Buffer.from(signed);
  tampered[tampered.length - 1] ^= 0xff;
  expect(verifyStunMessage(parseStunMessage(tampered), tampered, key)).toBe(false);
  expect(verifyStunMessage(msg, signed, Buffer.from("wrong-key"))).toBe(false);
});

test("VideoCallTest.test_parse_stun_url", () => {
  expect(parseStunUrl("stun:stun.l.google.com:19302")).toEqual({ scheme: "stun", host: "stun.l.google.com", port: 19302 });
  expect(parseStunUrl("turn:turn.example.com")).toEqual({ scheme: "turn", host: "turn.example.com", port: 3478 });
  expect(parseStunUrl("turns:turn.example.com:5349")).toEqual({ scheme: "turns", host: "turn.example.com", port: 5349 });
  expect(() => parseStunUrl("https://example.com")).toThrow("只支持 stun:/turn:/turns:");
});

test("VideoCallTest.test_ice_priority_order", () => {
  expect(icePriority("host")).toBeGreaterThan(icePriority("srflx"));
  expect(icePriority("srflx")).toBeGreaterThan(icePriority("relay"));
});

test("VideoCallTest.test_gather_host_candidates", () => {
  const cands = gatherHostCandidates();
  expect(cands.length).toBeGreaterThan(0);
  expect(cands.some((c) => c.address === "127.0.0.1" && c.type === "host")).toBe(true);
});

test("VideoCallTest.test_new_ice_identity", () => {
  const a = newIceIdentity();
  const b = newIceIdentity();
  expect(a.ufrag.length).toBeGreaterThan(0);
  expect(a.password.length).toBeGreaterThanOrEqual(8);
  expect(a.ufrag).not.toBe(b.ufrag);
  expect(a.password).not.toBe(b.password);
});

test("VideoCallTest.test_stun_binding_virtual", async () => {
  const hub = new VirtualUdpHub();
  const server = attachVirtualStun(hub);
  const clientSock = new VirtualSocket(hub);
  const result = await stunBindingRequest(
    { host: "127.0.0.1", port: server.port },
    { timeoutMs: 3000, socket: asSocket(clientSock) },
  );
  expect(result.address).toBe("127.0.0.1");
  expect(result.port).toBeGreaterThan(0);
  expect(result.rttMs).toBeGreaterThanOrEqual(0);
  clientSock.close();
  server.socket.close();
});

test("VideoCallTest.test_turn_allocate_refresh_permission_send_virtual", async () => {
  const hub = new VirtualUdpHub();
  const server = attachVirtualTurn(hub);
  const client = new TurnClient({
    server: { host: "127.0.0.1", port: server.port },
    username: "alice",
    credential: "secret",
    socket: asSocket(new VirtualSocket(hub)),
    timeoutMs: 3000,
  });
  const alloc = await client.allocate();
  expect(alloc.relayedAddress).toBe("127.0.0.1");
  expect(alloc.relayedPort).toBe(50099);
  expect(alloc.lifetimeSeconds).toBe(600);
  await client.refresh();
  await client.createPermission("127.0.0.1");
  await client.sendIndication("127.0.0.1", 1234, Buffer.from("hello-turn"));
  await new Promise((r) => setTimeout(r, 100));
  expect(server.sent.length).toBe(1);
  expect(server.sent[0].toString()).toBe("hello-turn");
  client.close();
  server.socket.close();
});

test("VideoCallTest.test_ice_two_ended_virtual_and_frame", async () => {
  const hub = new VirtualUdpHub();
  const idA = newIceIdentity();
  const idB = newIceIdentity();
  const a = new IceTransport({ ufrag: idA.ufrag, password: idA.password, socket: asSocket(new VirtualSocket(hub)) });
  const b = new IceTransport({ ufrag: idB.ufrag, password: idB.password, socket: asSocket(new VirtualSocket(hub)) });
  try {
    const [candA, candB] = await Promise.all([
      a.gather({ stunUrls: [], turnUrls: [], turnUsername: "", turnCredential: null }),
      b.gather({ stunUrls: [], turnUrls: [], turnUsername: "", turnCredential: null }),
    ]);
    expect(candA.length).toBeGreaterThan(0);
    expect(candB.length).toBeGreaterThan(0);
    const [pairA, pairB] = await Promise.all([
      a.startChecks(candB, idB.ufrag, idB.password),
      b.startChecks(candA, idA.ufrag, idA.password),
    ]);
    expect(pairA.relayed).toBe(false);
    expect(pairB.relayed).toBe(false);
    expect(a.state).toBe("connected");
    expect(b.state).toBe("connected");
    const received: Buffer[] = [];
    b.setOnData((data) => received.push(data));
    await a.send(Buffer.from("frame-bytes-1"));
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBe(1);
    expect(received[0].toString()).toBe("frame-bytes-1");
    // 超大帧：抛错并计数，不静默丢。
    await expect(a.send(Buffer.alloc(70000))).rejects.toThrow("帧太大");
    expect(a.droppedOversize).toBe(1);
    // 没连通时发帧：抛错。
    const c = new IceTransport({ ufrag: "x", password: "y", socket: asSocket(new VirtualSocket(hub)) });
    await expect(c.send(Buffer.from("x"))).rejects.toThrow("还没连通");
    c.close();
  } finally {
    a.close();
    b.close();
  }
});

test("VideoCallTest.test_ice_two_ended_real_udp_guarded", async () => {
  if (!(await realUdpWorks())) {
    skipNoUdp();
    return;
  }
  const idA = newIceIdentity();
  const idB = newIceIdentity();
  const a = new IceTransport({ ufrag: idA.ufrag, password: idA.password });
  const b = new IceTransport({ ufrag: idB.ufrag, password: idB.password });
  try {
    const [candA, candB] = await Promise.all([
      a.gather({ stunUrls: [], turnUrls: [], turnUsername: "", turnCredential: null }),
      b.gather({ stunUrls: [], turnUrls: [], turnUsername: "", turnCredential: null }),
    ]);
    const [pairA] = await Promise.all([
      a.startChecks(candB, idB.ufrag, idB.password),
      b.startChecks(candA, idA.ufrag, idA.password),
    ]);
    expect(pairA.relayed).toBe(false);
    const received: Buffer[] = [];
    b.setOnData((data) => received.push(data));
    await a.send(Buffer.from("real-udp-frame"));
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(1);
    expect(received[0].toString()).toBe("real-udp-frame");
  } finally {
    a.close();
    b.close();
  }
});

// ---- 信令 ----

test("VideoCallTest.test_signaling_two_clients_relay_and_isolation", async () => {
  const server = new VideoSignalingServer({ port: 0 });
  const a = new VideoSignalingClient(server.url);
  const b = new VideoSignalingClient(server.url);
  const c = new VideoSignalingClient(server.url);
  try {
    await Promise.all([a.connect(), b.connect(), c.connect()]);
    const gotB: unknown[] = [];
    const gotC: unknown[] = [];
    b.onMessage((m) => { if (m.type === "offer") gotB.push(m.payload); });
    c.onMessage((m) => { if (m.type === "offer") gotC.push(m.payload); });
    a.send("join", "room-1", "alice");
    b.send("join", "room-1", "bob");
    c.send("join", "room-2", "carol");
    await new Promise((r) => setTimeout(r, 200));
    a.send("offer", "room-1", "alice", { ufrag: "alice" });
    await new Promise((r) => setTimeout(r, 200));
    expect(gotB.length).toBe(1);
    expect((gotB[0] as { ufrag: string }).ufrag).toBe("alice");
    expect(gotC.length).toBe(0); // 另一个房间收不到
  } finally {
    a.close();
    b.close();
    c.close();
    server.stop();
  }
});

// ---- WebRtcTransport 端到端（信令走真 WebSocket，ICE 走虚拟 socket） ----

test("VideoCallTest.test_webrtc_transport_end_to_end_virtual", async () => {
  const server = new VideoSignalingServer({ port: 0 });
  const hub = new VirtualUdpHub();
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, signalingUrl: server.url, stunUrls: [], turnUrls: [] };
  const idA = newIceIdentity();
  const idB = newIceIdentity();
  const iceA = new IceTransport({ ufrag: idA.ufrag, password: idA.password, socket: asSocket(new VirtualSocket(hub)) });
  const iceB = new IceTransport({ ufrag: idB.ufrag, password: idB.password, socket: asSocket(new VirtualSocket(hub)) });
  const caller = new WebRtcTransport({ home: setup().home, config: cfg, role: "caller", ice: iceA, identity: idA });
  const callee = new WebRtcTransport({ home: setup().home, config: cfg, role: "callee", ice: iceB, identity: idB });
  try {
    // 被叫先起（先占房），主叫后起——反过来也行，协商会等对方进房。
    callee.start("room-e2e");
    await new Promise((r) => setTimeout(r, 100));
    caller.start("room-e2e");
    const [pairA, pairB] = await Promise.all([
      caller.waitConnected(15000),
      callee.waitConnected(15000),
    ]);
    expect(pairA.relayed).toBe(false);
    expect(pairB.relayed).toBe(false);
    expect(caller.state).toBe("connected");
    expect(callee.state).toBe("connected");
    expect(caller.mediaPlane).not.toBeNull();
    expect(callee.mediaPlane).not.toBeNull();
    const received: Buffer[] = [];
    callee.mediaPlane!.onFrame((bytes) => received.push(bytes));
    await caller.mediaPlane!.sendFrame(Buffer.from("webrtc-frame"));
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(1);
    expect(received[0].toString()).toBe("webrtc-frame");
  } finally {
    caller.stop("room-e2e");
    callee.stop("room-e2e");
    server.stop();
  }
});

test("VideoCallTest.test_webrtc_transport_caller_first_still_connects", async () => {
  const server = new VideoSignalingServer({ port: 0 });
  const hub = new VirtualUdpHub();
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, signalingUrl: server.url, stunUrls: [], turnUrls: [] };
  const idA = newIceIdentity();
  const idB = newIceIdentity();
  const iceA = new IceTransport({ ufrag: idA.ufrag, password: idA.password, socket: asSocket(new VirtualSocket(hub)) });
  const iceB = new IceTransport({ ufrag: idB.ufrag, password: idB.password, socket: asSocket(new VirtualSocket(hub)) });
  const caller = new WebRtcTransport({ home: setup().home, config: cfg, role: "caller", ice: iceA, identity: idA });
  const callee = new WebRtcTransport({ home: setup().home, config: cfg, role: "callee", ice: iceB, identity: idB });
  try {
    // 主叫先起：offer 不能丢，等被叫进房后再发才行。
    caller.start("room-first");
    await new Promise((r) => setTimeout(r, 300));
    callee.start("room-first");
    const [pairA] = await Promise.all([
      caller.waitConnected(15000),
      callee.waitConnected(15000),
    ]);
    expect(pairA.relayed).toBe(false);
  } finally {
    caller.stop("room-first");
    callee.stop("room-first");
    server.stop();
  }
});

test("VideoCallTest.test_webrtc_transport_requires_identity_with_ice", () => {
  const hub = new VirtualUdpHub();
  const ice = new IceTransport({ ufrag: "u", password: "p", socket: asSocket(new VirtualSocket(hub)) });
  expect(() => new WebRtcTransport({
    home: setup().home, config: DEFAULT_VIDEO_CALL_CONFIG, role: "caller", ice,
  })).toThrow("须同时注入 identity");
  ice.close();
});

test("VideoCallTest.test_webrtc_transport_end_to_end_real_udp_guarded", async () => {
  if (!(await realUdpWorks())) {
    skipNoUdp();
    return;
  }
  const server = new VideoSignalingServer({ port: 0 });
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, signalingUrl: server.url, stunUrls: [], turnUrls: [] };
  const caller = new WebRtcTransport({ home: setup().home, config: cfg, role: "caller" });
  const callee = new WebRtcTransport({ home: setup().home, config: cfg, role: "callee" });
  try {
    callee.start("room-real");
    await new Promise((r) => setTimeout(r, 100));
    caller.start("room-real");
    const [pairA] = await Promise.all([
      caller.waitConnected(15000),
      callee.waitConnected(15000),
    ]);
    expect(pairA.relayed).toBe(false);
    const received: Buffer[] = [];
    callee.mediaPlane!.onFrame((bytes) => received.push(bytes));
    await caller.mediaPlane!.sendFrame(Buffer.from("real-webrtc-frame"));
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(1);
  } finally {
    caller.stop("room-real");
    callee.stop("room-real");
    server.stop();
  }
});

test("VideoCallTest.test_local_media_plane_loopback", async () => {
  const plane = new LocalMediaPlane();
  expect(plane.kind).toBe("loopback");
  const got: Buffer[] = [];
  plane.onFrame((b) => got.push(b));
  await plane.sendFrame(Buffer.from("loop"));
  expect(got.length).toBe(1);
  expect(got[0].toString()).toBe("loop");
});

// ---- 配置与生命周期 ----

test("VideoCallTest.test_resolve_video_call_config", () => {
  const d = resolveVideoCallConfig({});
  expect(d.signalingUrl).toBe("ws://127.0.0.1:18789");
  expect(d.sampleMode).toBe("on-demand");
  expect(d.visionCloudEnabled).toBe(false);
  const custom = resolveVideoCallConfig({
    video: {
      signaling_url: "ws://10.0.0.1:9000",
      sample_mode: "timed",
      sample_interval_seconds: 30,
      change_threshold: 0.2,
      max_frames_per_call: 5,
      vision_cloud_enabled: true,
      vision_local_model: "qwen2.5-vl:3b",
    },
  });
  expect(custom.signalingUrl).toBe("ws://10.0.0.1:9000");
  expect(custom.sampleMode).toBe("timed");
  expect(custom.sampleIntervalSeconds).toBe(30);
  expect(custom.changeThreshold).toBe(0.2);
  expect(custom.maxFramesPerCall).toBe(5);
  expect(custom.visionCloudEnabled).toBe(true);
  expect(custom.visionLocalModel).toBe("qwen2.5-vl:3b");
  // 非法值回退默认值，不抛错。
  const bad = resolveVideoCallConfig({ video: { sample_mode: "bogus", sample_interval_seconds: -1, signaling_url: "http://x" } });
  expect(bad.sampleMode).toBe("on-demand");
  expect(bad.sampleIntervalSeconds).toBe(10);
  expect(bad.signalingUrl).toBe("ws://127.0.0.1:18789");
});

test("VideoCallTest.test_lifecycle_guards", () => {
  const { home } = setup();
  const call = startVideoCall(home, { peer: "林舟", yes: true, loopback: true });
  expect(call.status).toBe("ringing");
  expect(call.transport).toBe("loopback");
  expect(() => answerVideoCall(home, "no-such-id")).toThrow("找不到视频通话");
  expect(() => startVideoCall(home, { peer: "林舟" })).toThrow("--yes");
  const answered = answerVideoCall(home, call.id);
  expect(answered.status).toBe("active");
  expect(() => answerVideoCall(home, call.id)).toThrow("接不了");
  expect(() => declineVideoCall(home, call.id)).toThrow("拒绝不了");
  const ended = endVideoCall(home, call.id);
  expect(ended.status).toBe("ended");
  expect(ended.endedAt).not.toBeNull();
  expect(() => endVideoCall(home, call.id)).toThrow("已经结束了");
  const declined = startVideoCall(home, { loopback: true });
  declineVideoCall(home, declined.id);
  expect(listVideoCalls(home, "declined").length).toBe(1);
  expect(listVideoCalls(home).length).toBe(2);
  expect(loadVideoCallStore(home).calls.length).toBe(2);
});

test("VideoCallTest.test_store_corrupt_backed_up", () => {
  const { home } = setup();
  writeFileSync(join(home, "video-calls.json"), "{not json", "utf-8");
  expect(() => loadVideoCallStore(home)).toThrow("损坏，已备份");
  const names = readdirSync(home);
  expect(names.some((n) => n.startsWith("video-calls.json.corrupt-"))).toBe(true);
});

// ---- 帧采样 ----

test("VideoCallTest.test_sample_on_demand_no_raw_text_on_disk", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  const result = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG,
    visionFn: fakeVision("画面里有一只猫在桌子上"),
  });
  expect(result.skipped).toBe(false);
  expect(result.held).toBe(false);
  expect(result.description).toBe("画面里有一只猫在桌子上");
  expect(result.frame.status).toBe("described");
  expect(result.frame.engine).toBe("fake-vision");
  expect(result.frame.chars).toBe("画面里有一只猫在桌子上".length);
  expect(result.frame.stored).toBe(false); // 默认不录，不落盘
  // 描述原文只返回给调用方显示，不落盘：账本与审计里只有指纹。
  const storeText = readFileSync(join(home, "video-calls.json"), "utf-8");
  const auditText = readFileSync(join(home, "video-call-audit.jsonl"), "utf-8");
  expect(storeText).not.toContain("猫在桌子");
  expect(auditText).not.toContain("猫在桌子");
  expect(result.frame.descriptionHash).toMatch(/^[0-9a-f]{12}$/);
  expectPerms(join(home, "video-calls.json"), 0o600);
  const s = summarizeVideoCall(result.call);
  expect(s.framesSampled).toBe(1);
  expect(s.framesDescribed).toBe(1);
});

test("VideoCallTest.test_sample_timed_skips_within_interval", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, sampleMode: "timed", sampleIntervalSeconds: 60 };
  const first = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第一帧"),
  });
  expect(first.skipped).toBe(false);
  const second = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第二帧"),
  });
  expect(second.skipped).toBe(true);
  expect(second.frame.status).toBe("skipped");
  expect(second.frame.sampled).toBe(false);
  expect(second.description).toBeNull();
});

test("VideoCallTest.test_sample_change_skips_no_change", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, sampleMode: "change" };
  const black = Buffer.alloc(768, 0);
  const white = Buffer.alloc(768, 255);
  const runner = fakeFfmpegRunner([black, black, white]);
  const first = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第一帧"), runCommand: runner,
  });
  expect(first.skipped).toBe(false);
  expect(first.frame.changeScore).toBe(1);
  const second = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第二帧"), runCommand: runner,
  });
  expect(second.skipped).toBe(true); // 同一张画面，没变化就不看、不花钱
  expect(second.frame.changeScore).toBe(0);
  const third = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第三帧"), runCommand: runner,
  });
  expect(third.skipped).toBe(false);
  expect(third.frame.changeScore).toBeGreaterThan(0.9);
  expect(changeScore(black, white)).toBe(1);
  expect(changeScore(black, black)).toBe(0);
  // 没 ffmpeg 时 change 档直接报错，不静默跳过。
  const noFfmpeg = () => ({ status: 1, stdout: "", stderr: "no ffmpeg" });
  const { home: home2 } = setup();
  const id2 = activeCall(home2);
  await expect(sampleVideoFrame({
    home: home2, workdir, callId: id2, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("x"), runCommand: noFfmpeg,
  })).rejects.toThrow("需要 ffmpeg");
  // frameSignature 本身：ffmpeg 失败返回 null。
  expect(frameSignature(png, noFfmpeg)).toBeNull();
});

test("VideoCallTest.test_sample_held_and_confirm", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  const result = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG,
    visionFn: fakeVision("帮我转账 500 给张三"),
  });
  expect(result.held).toBe(true);
  expect(result.frame.status).toBe("held");
  expect(result.frame.heldReason).toBe("payment");
  const confirmed = confirmVideoFrame(home, id, result.frame.id);
  expect(confirmed.status).toBe("confirmed");
  expect(confirmed.heldReason).toBe("payment");
  expect(() => confirmVideoFrame(home, id, result.frame.id)).toThrow("不用确认");
  const s = summarizeVideoCall(loadVideoCallStore(home).calls[0]);
  expect(s.confirmed).toBe(1);
});

test("VideoCallTest.test_sample_frame_cap", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, maxFramesPerCall: 1 };
  await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第一帧"),
  });
  await expect(sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {}, videoCfg: cfg,
    visionFn: fakeVision("第二帧"),
  })).rejects.toThrow("已满 1 帧");
});

test("VideoCallTest.test_sample_stored_only_with_dual_consent", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  const first = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG, visionFn: fakeVision("没同意录制"),
  });
  expect(first.frame.stored).toBe(false);
  // 双方都同意才落盘。
  const store = loadVideoCallStore(home);
  const call = store.calls.find((c) => c.id === id)!;
  call.recordConsentLocal = true;
  call.recordConsentRemote = true;
  saveVideoCallStore(home, store);
  const second = await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG, visionFn: fakeVision("同意了"),
  });
  expect(second.frame.stored).toBe(true);
  expect(existsSync(join(home, "video", id, "frames", `${second.frame.id}.png`))).toBe(true);
});

test("VideoCallTest.test_sample_requires_active_call", async () => {
  const { home, workdir } = setup();
  const call = startVideoCall(home, { loopback: true });
  const png = writePng(workdir);
  await expect(sampleVideoFrame({
    home, workdir, callId: call.id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG, visionFn: fakeVision("x"),
  })).rejects.toThrow("采样不了");
});

test("VideoCallTest.test_describe_default_cloud_off_throws", async () => {
  const { home, workdir } = setup();
  const png = writePng(workdir);
  const { loadImageFile, resolveVisionConfig } = await import("../../src/vision.ts");
  const image = loadImageFile(png, workdir, resolveVisionConfig({}));
  // 没配本地模型、云端默认关：直接报错，不偷偷走云端。
  await expect(describeFrameDefault({
    home, config: {}, videoCfg: DEFAULT_VIDEO_CALL_CONFIG, image, prompt: "描述画面",
  })).rejects.toThrow("没有可用的看图路");
  // 配了本地模型但本地不可用：同样报错，不回退到云端。
  await expect(describeFrameDefault({
    home, config: {}, videoCfg: { ...DEFAULT_VIDEO_CALL_CONFIG, visionLocalModel: "no-such-model-xyz" },
    image, prompt: "描述画面",
  })).rejects.toThrow("本地视觉模型不可用");
});

test("VideoCallTest.test_summary_three_books", async () => {
  const { home, workdir } = setup();
  const id = activeCall(home);
  const png = writePng(workdir);
  await sampleVideoFrame({
    home, workdir, callId: id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG, visionFn: fakeVision("一只猫", "fake-vision", 0.001),
  });
  const ended = endVideoCall(home, id);
  const text = formatVideoCallSummary(ended);
  expect(text).toContain("传输：");
  expect(text).toContain("看：共 1 帧");
  expect(text).toContain("干活：本次通话未把描述当任务跑，无 LLM token 花费。");
  expect(text).toContain("录制：关");
  const s = summarizeVideoCall(ended);
  expect(s.costUsd).toBe(0.001);
  expect(s.durationSeconds).not.toBeNull();
});

// ---- 事件与时间线 ----

test("VideoCallTest.test_events_registered_and_mirrored", async () => {
  // 14 个新事件类型须在 EVENT_FIELDS 注册，否则 appendEvent 抛错、事件静默丢失。
  const { home: home0 } = setup();
  const store0 = new RunStore(join(home0, "runs"));
  const run0 = store0.create("任务", "20260101-000000-abcdef", process.cwd(), "auto", 5, "running");
  const all: Array<[string, Record<string, unknown>]> = [
    ["video_call_started", { call_id: "c1", agent: "nyra", peer: "林舟", transport: "webrtc" }],
    ["video_call_answered", { call_id: "c1" }],
    ["video_call_declined", { call_id: "c1" }],
    ["video_call_ended", { call_id: "c1", duration_seconds: 10, frames: 1, frames_described: 1, bytes_in: 1, bytes_out: 2, cost_usd: 0.001, held: 0 }],
    ["video_call_transport_connected", { call_id: "c1", ice_pair: "127.0.0.1:40001", relayed: false, rtt_ms: 5 }],
    ["video_call_transport_failed", { call_id: "c1", reason: "timeout" }],
    ["video_frame_sampled", { call_id: "c1", frame_id: "f1", mode: "on-demand", engine: "fake", image_hash: "abc123", cost_usd: 0 }],
    ["video_frame_blocked", { call_id: "c1", frame_id: "f1", reason: "payment", text_hash: "def456" }],
    ["video_frame_confirmed", { call_id: "c1", frame_id: "f1", reason: "payment" }],
    ["video_frame_skipped", { call_id: "c1", mode: "timed", reason: "interval" }],
    ["video_frame_sent", { call_id: "c1", frame_id: "f1", bytes: 100 }],
    ["video_frame_received", { call_id: "c1", frame_id: "f1", bytes: 100, image_hash: "abc123" }],
    ["video_call_degraded", { call_id: "c1", reason: "weak-network" }],
    ["video_call_restored", { call_id: "c1" }],
  ];
  for (const [type, fields] of all) {
    expect(() => store0.appendEvent(run0.run_id, type, fields)).not.toThrow();
  }
  const lines = readFileSync(join(home0, "runs", run0.run_id, "events.jsonl"), "utf-8").split("\n").filter(Boolean);
  const types = lines.map((l) => JSON.parse(l).type as string);
  for (const [type] of all) expect(types).toContain(type);
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("视频通话测试", "sess-1", home, "auto", 10);
  const call = startVideoCall(home, { peer: "林舟", yes: true, loopback: true, runId: state.run_id });
  answerVideoCall(home, call.id);
  const png = writePng(workdir);
  await sampleVideoFrame({
    home, workdir, callId: call.id, imagePath: png, config: {},
    videoCfg: DEFAULT_VIDEO_CALL_CONFIG, visionFn: fakeVision("一只猫"),
  });
  endVideoCall(home, call.id);
  const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  expect(events).toContain("video_call_started");
  expect(events).toContain("video_call_answered");
  expect(events).toContain("video_frame_sampled");
  expect(events).toContain("video_call_ended");
  expect(events).not.toContain("猫"); // 事件里只有指纹，没有描述原文
});

test("VideoCallTest.test_timeline_renders_video_events", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-vcall-tl-"));
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  writeFileSync(join(home, "runs", runId, "events.jsonl"), [
    JSON.stringify({ at: state.created_at, type: "video_call_started", call_id: "call-1", agent: "nyra", peer: "林舟", transport: "webrtc" }),
    JSON.stringify({ at: state.created_at, type: "video_call_transport_connected", call_id: "call-1", ice_pair: "127.0.0.1:40001", relayed: false, rtt_ms: 12 }),
    JSON.stringify({ at: state.created_at, type: "video_frame_sampled", call_id: "call-1", frame_id: "frame-1", mode: "on-demand", engine: "ollama:qwen2.5-vl:3b", image_hash: "abc123", cost_usd: 0.001 }),
    JSON.stringify({ at: state.created_at, type: "video_frame_blocked", call_id: "call-1", frame_id: "frame-2", reason: "payment", text_hash: "def456" }),
    JSON.stringify({ at: state.created_at, type: "video_frame_confirmed", call_id: "call-1", frame_id: "frame-2", reason: "payment" }),
    JSON.stringify({ at: state.created_at, type: "video_call_degraded", call_id: "call-1", reason: "weak-network" }),
    JSON.stringify({ at: state.created_at, type: "video_call_ended", call_id: "call-1", duration_seconds: 120, frames: 2, frames_described: 1, bytes_in: 100, bytes_out: 200, cost_usd: 0.001, held: 1 }),
  ].join("\n") + "\n");
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("视频通话开始");
  expect(text).toContain("视频传输已连通");
  expect(text).toContain("视频帧已看");
  expect(text).toContain("被扣下");
  expect(text).toContain("视频帧已确认");
  expect(text).toContain("切到仅语音");
  expect(text).toContain("视频通话结束");
});

// ---- CLI 端到端 ----

test("VideoCallTest.test_cli_end_to_end", async () => {
  const { home, workdir } = setup();
  const png = writePng(workdir);
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { out.push(String(a[0])); return true; };
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { out.push(String(a[0])); return true; };
  try {
    const visionFn = fakeVision("CLI 看到的猫");
    expect(await handleVideoCall(["start", "--loopback"], home)).toBe(0);
    const started = out.join("");
    const id = started.match(/vcall-[0-9a-f-]+/)?.[0];
    expect(id).toBeTruthy();
    expect(await handleVideoCall(["answer", id!], home)).toBe(0);
    expect(await handleVideoCall(["sample", id!, png], home, { visionFn })).toBe(0);
    expect(out.join("")).toContain("CLI 看到的猫");
    expect(await handleVideoCall(["status", id!], home)).toBe(0);
    expect(await handleVideoCall(["list"], home)).toBe(0);
    expect(await handleVideoCall(["summary", id!], home)).toBe(0);
    expect(out.join("")).toContain("看：共 1 帧");
    expect(await handleVideoCall(["bogus"], home)).toBe(2);
    expect(await handleVideoCall(["start", "--peer", "林舟"], home)).toBe(1); // 对外呼叫须 --yes
    expect(await handleVideoCall(["consent-record", id!, "--yes"], home)).toBe(0);
    expect(await handleVideoCall(["end", id!], home)).toBe(0);
    expect(out.join("")).toContain("干活：本次通话未把描述当任务跑");
    // 顶层分发：video → call / signal / ice。
    expect(await handleVideo(["bogus"], home)).toBe(2);
  } finally {
    (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = origOut as (...a: unknown[]) => boolean;
    (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = origErr as (...a: unknown[]) => boolean;
  }
});

test("VideoCallTest.test_cli_signal_status_and_ice_gather", async () => {
  const { home } = setup();
  const server = new VideoSignalingServer({ port: 0 });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    video: { signaling_url: server.url, stun_urls: ["stun:127.0.0.1:9"], turn_urls: [] },
  }), "utf-8");
  try {
    expect(await handleVideoSignal(["status"], home)).toBe(0);
    expect(await handleVideoIce(["gather"], home)).toBe(0);
    expect(await handleVideoSignal(["bogus"], home)).toBe(2);
    expect(await handleVideoIce(["bogus"], home)).toBe(2);
  } finally {
    server.stop();
  }
});
