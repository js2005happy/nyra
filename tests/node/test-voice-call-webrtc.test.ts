// tests/node/test-voice-call-webrtc.test.ts — 第 1 批 G-P0-1：真 WebRTC 1:1 语音。
//
// startVoiceCall 传 transport: "webrtc" 时走 videoCall.ts 的
// WebRtcTransport（信令 + ICE + STUN/TURN），回环留作默认与回退。
// 两端协商走真 WebSocket 信令（进程内 VideoSignalingServer）+ 内存
// 虚拟 UDP（本机沙箱禁 sendto，照 test-video-call.test.ts 同款）；
// 两台真机打通、断线重连不在本机可验范围，见 PUSH-PLAN.md 的待真机验证。
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { type Socket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import {
  DEFAULT_VIDEO_CALL_CONFIG, IceTransport, VideoSignalingClient,
  VideoSignalingServer, WebRtcTransport, newIceIdentity,
  type VideoCallConfig,
} from "../../src/videoCall.ts";
import {
  answerVoiceCall, endVoiceCall, getVoiceCallTransport, handleVoiceCall,
  loadVoiceCallStore, runVoiceSession, startVoiceCall,
} from "../../src/voiceCall.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-vcall-wrtc-home-"));
  return { home };
}

/** 内存虚拟 UDP（test-video-call.test.ts 同款，沙箱禁 sendto 时走它）。 */
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
    if (!target) return;
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

/** 读某运行的 events.jsonl 里的事件 type 列。 */
function runEventTypes(home: string, runId: string): string[] {
  const path = join(home, "runs", runId, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => {
    try { return (JSON.parse(line) as { type?: string }).type ?? ""; } catch { return ""; }
  });
}

test("VoiceCallWebrtcTest.test_start_webrtc_registers_transport", async () => {
  const { home } = setup();
  const server = new VideoSignalingServer({ port: 0 });
  const hub = new VirtualUdpHub();
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, signalingUrl: server.url, stunUrls: [], turnUrls: [] };
  const idA = newIceIdentity();
  const iceA = new IceTransport({ ufrag: idA.ufrag, password: idA.password, socket: asSocket(new VirtualSocket(hub)) });
  try {
    const call = await startVoiceCall(home, {
      transport: "webrtc", role: "caller", videoCfg: cfg,
      signaling: new VideoSignalingClient(server.url), ice: iceA, identity: idA,
    });
    expect(call.transport).toBe("webrtc");
    const t = getVoiceCallTransport(call.id);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe("webrtc");
    // 挂断停同一台、摘掉注册。
    endVoiceCall(home, call.id);
    expect(getVoiceCallTransport(call.id)).toBeNull();
  } finally {
    server.stop();
  }
});

test("VoiceCallWebrtcTest.test_webrtc_two_ends_connect_and_session_holds", async () => {
  const { home } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("语音通话", "sess-1", home, "auto", 10);
  const server = new VideoSignalingServer({ port: 0 });
  const hub = new VirtualUdpHub();
  const cfg: VideoCallConfig = { ...DEFAULT_VIDEO_CALL_CONFIG, signalingUrl: server.url, stunUrls: [], turnUrls: [] };
  const idA = newIceIdentity();
  const idB = newIceIdentity();
  const iceA = new IceTransport({ ufrag: idA.ufrag, password: idA.password, socket: asSocket(new VirtualSocket(hub)) });
  const iceB = new IceTransport({ ufrag: idB.ufrag, password: idB.password, socket: asSocket(new VirtualSocket(hub)) });
  // 被叫那头只起传输（同房间 id 协商）；语音通话记录只在主叫这头建。
  const callee = new WebRtcTransport({
    home, config: cfg, role: "callee",
    signaling: new VideoSignalingClient(server.url), ice: iceB, identity: idB,
  });
  try {
    const call = await startVoiceCall(home, {
      transport: "webrtc", role: "caller", videoCfg: cfg, runId: state.run_id,
      signaling: new VideoSignalingClient(server.url), ice: iceA, identity: idA,
    });
    answerVoiceCall(home, call.id);
    callee.start(call.id);
    const session = runVoiceSession({ home, callId: call.id, role: "caller", videoCfg: cfg, connectTimeoutMs: 15000 });
    const pairB = await callee.waitConnected(15000);
    expect(pairB.relayed).toBe(false);
    // 会话守住后从另一头挂断，会话应收尾返回 0。
    await new Promise((r) => setTimeout(r, 500));
    endVoiceCall(home, call.id);
    expect(await session).toBe(0);
    // 连通事件进了运行证据链（只记 ICE 对与往返，不记音频）。
    expect(runEventTypes(home, state.run_id)).toContain("voice_call_transport_connected");
    expect(loadVoiceCallStore(home).calls[0].status).toBe("ended");
  } finally {
    callee.stop("cleanup");
    server.stop();
  }
});

test("VoiceCallWebrtcTest.test_webrtc_signaling_down_reports_failed_event", async () => {
  const { home } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("语音通话", "sess-1", home, "auto", 10);
  const cfg: VideoCallConfig = {
    ...DEFAULT_VIDEO_CALL_CONFIG,
    signalingUrl: "ws://127.0.0.1:9/no-server",
    stunUrls: [], turnUrls: [],
  };
  const call = await startVoiceCall(home, {
    transport: "webrtc", role: "caller", videoCfg: cfg, runId: state.run_id,
  });
  try {
    // 信令连不上：协商失败走 failed 事件，通话记录本身还在（回环是回退，
    // 段落仍可用 segment 喂，不崩）。
    const deadline = Date.now() + 10000;
    let seen = false;
    while (Date.now() < deadline) {
      if (runEventTypes(home, state.run_id).includes("voice_call_transport_failed")) { seen = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toBe(true);
    expect(loadVoiceCallStore(home).calls[0].transport).toBe("webrtc");
  } finally {
    endVoiceCall(home, call.id);
  }
});

test("VoiceCallWebrtcTest.test_run_voice_session_loopback_holds_until_end", async () => {
  const { home } = setup();
  const call = await startVoiceCall(home, {});
  answerVoiceCall(home, call.id);
  const session = runVoiceSession({ home, callId: call.id });
  await new Promise((r) => setTimeout(r, 600));
  endVoiceCall(home, call.id);
  expect(await session).toBe(0);
});

test("VoiceCallWebrtcTest.test_run_voice_session_requires_active", async () => {
  const { home } = setup();
  const call = await startVoiceCall(home, {});
  // 还没接听：连不了，返回 1。
  expect(await runVoiceSession({ home, callId: call.id })).toBe(1);
  endVoiceCall(home, call.id);
});

test("VoiceCallWebrtcTest.test_cli_start_webrtc_and_connect", async () => {
  const { home } = setup();
  const code = await handleVoiceCall(
    ["start", "--transport", "webrtc", "--signaling", "ws://127.0.0.1:9/no-server"],
    home,
  );
  expect(code).toBe(0);
  const call = loadVoiceCallStore(home).calls[0];
  expect(call.transport).toBe("webrtc");
  // 没接听就 connect：返回 1。
  expect(await handleVoiceCall(["connect", call.id], home)).toBe(1);
  endVoiceCall(home, call.id);
});
