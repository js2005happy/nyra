// tests/node/test-group-video-batch3.test.ts — 第 3 批 G-P0-2 视频部分：
// 群组视频（Producer/Consumer、按需看帧、带宽自适应、10 分钟模拟）。
// 全部用临时 home，不起真服务器、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SfuRegistry } from "../../src/sfu.ts";
import {
  VideoRegistry,
  simulateVideoSession,
  tierForBandwidth,
  tierFrameStride,
  VIDEO_ROOM_BUDGET_KBPS,
} from "../../src/groupVideo.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupRoom(home: string, roomId: string, peers: string[], listeners: string[] = []): void {
  const sfu = new SfuRegistry(home);
  sfu.createRoom({ id: roomId });
  for (const p of peers) sfu.joinRoom(roomId, p, "speaker");
  for (const p of listeners) sfu.joinRoom(roomId, p, "listener");
}

test("GroupVideoBatch3.test_start_producer_requires_speaker", () => {
  const home = tmpHome("nyra-gvideo-");
  try {
    setupRoom(home, "room-a", ["alice", "bob"], ["carol"]);
    const video = new VideoRegistry(home);
    const p = video.startProducer("room-a", "alice", "camera");
    expect(p.peer).toBe("alice");
    expect(p.kind).toBe("camera");
    expect(p.track).toMatch(/^vid-[0-9a-f]+$/);
    // 听众只能看、不能开视频
    expect(() => video.startProducer("room-a", "carol", "camera")).toThrow("只能看视频");
    // 不在房里的人开不了
    expect(() => video.startProducer("room-a", "mallory", "camera")).toThrow("不在语音房");
    // 重复开一路直接拒绝
    expect(() => video.startProducer("room-a", "alice", "screen")).toThrow("已经在房间");
    // 码率越界拒绝
    expect(() => video.startProducer("room-a", "bob", "camera", 50)).toThrow("码率");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GroupVideoBatch3.test_tier_by_bandwidth", () => {
  expect(tierForBandwidth(2000)).toBe("high");
  expect(tierForBandwidth(1500)).toBe("high");
  expect(tierForBandwidth(800)).toBe("medium");
  expect(tierForBandwidth(600)).toBe("medium");
  expect(tierForBandwidth(599)).toBe("low");
  expect(tierFrameStride("high")).toBe(1);
  expect(tierFrameStride("medium")).toBe(2);
  expect(tierFrameStride("low")).toBe(3);
});

test("GroupVideoBatch3.test_subscribe_adapts_tiers_under_budget", () => {
  const home = tmpHome("nyra-gvideo-");
  try {
    setupRoom(home, "room-b", ["alice", "bob", "carol"]);
    const video = new VideoRegistry(home);
    for (const p of ["alice", "bob", "carol"]) video.startProducer("room-b", p, "camera");
    // 6 路订阅 × 1500 = 9000 > 8000 上限：后订阅的两条降 medium。
    video.subscribe("room-b", "alice", "bob", 2000);
    video.subscribe("room-b", "alice", "carol", 2000);
    video.subscribe("room-b", "bob", "alice", 2000);
    video.subscribe("room-b", "bob", "carol", 2000);
    video.subscribe("room-b", "carol", "alice", 2000);
    video.subscribe("room-b", "carol", "bob", 2000);
    const consumers = video.listConsumers("room-b");
    expect(consumers).toHaveLength(6);
    const byKey = new Map(consumers.map((c) => [`${c.peer}->${c.producer}`, c.tier]));
    expect(byKey.get("alice->bob")).toBe("high");
    expect(byKey.get("bob->alice")).toBe("high");
    expect(byKey.get("carol->alice")).toBe("medium");
    expect(byKey.get("carol->bob")).toBe("medium");
    const total = consumers.reduce((s, c) => s + (c.tier === "high" ? 1500 : c.tier === "medium" ? 600 : 150), 0);
    expect(total).toBeLessThanOrEqual(VIDEO_ROOM_BUDGET_KBPS);
    // 没订阅的路看不了帧
    expect(() => video.framesFor("room-b", "alice", "alice", 0)).toThrow("没订阅");
    // 手动改档不能越过可用带宽往高改（dave 只报了 800 kbps，high 要 1500）
    setupRoom(home, "room-b2", ["alice", "dave"]);
    const video2 = new VideoRegistry(home);
    video2.startProducer("room-b2", "alice", "camera");
    video2.subscribe("room-b2", "dave", "alice", 800);
    expect(video2.listConsumers("room-b2")[0].tier).toBe("medium");
    expect(() => video2.setQuality("room-b2", "dave", "alice", "high")).toThrow("可用带宽");
    expect(video2.setQuality("room-b2", "dave", "alice", "low").tier).toBe("low");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GroupVideoBatch3.test_frames_stride_is_per_producer", () => {
  const home = tmpHome("nyra-gvideo-");
  try {
    setupRoom(home, "room-c", ["alice", "bob", "carol"]);
    const video = new VideoRegistry(home);
    video.startProducer("room-c", "alice", "camera");
    video.startProducer("room-c", "bob", "camera");
    video.subscribe("room-c", "carol", "alice", 800); // medium
    video.subscribe("room-c", "carol", "bob", 2000); // high
    // 两路轮流发帧：medium 档按这路自己的帧数下采样，应得一半，不是 1/6。
    for (let i = 0; i < 6; i++) {
      video.publishFrame("room-c", "alice", `alice-frame-${i}`);
      video.publishFrame("room-c", "bob", `bob-frame-${i}`);
    }
    expect(video.framesFor("room-c", "carol", "alice", 0)).toHaveLength(3);
    expect(video.framesFor("room-c", "carol", "bob", 0)).toHaveLength(6);
    // 帧只记指纹，不存视频内容
    const frames = video.framesFor("room-c", "carol", "bob", 0);
    expect(frames[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(frames)).not.toContain("bob-frame-");
    // 从某序号之后取（bob 的帧全局序号是 2,4,6,8,10,12，>3 的有 5 帧）
    expect(video.framesFor("room-c", "carol", "bob", 3)).toHaveLength(5);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GroupVideoBatch3.test_video_recording_needs_all_consent", () => {
  const home = tmpHome("nyra-gvideo-");
  try {
    setupRoom(home, "room-d", ["alice", "bob"]);
    const sfu = new SfuRegistry(home);
    const video = new VideoRegistry(home);
    video.startProducer("room-d", "alice", "camera");
    expect(() => video.startVideoRecording("room-d")).toThrow("还没同意录制");
    sfu.consentRecording("room-d", "alice");
    expect(() => video.startVideoRecording("room-d")).toThrow("bob");
    sfu.consentRecording("room-d", "bob");
    video.startVideoRecording("room-d");
    expect(video.isRecording("room-d")).toBe(true);
    video.stopVideoRecording("room-d");
    expect(video.isRecording("room-d")).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GroupVideoBatch3.test_simulate_ten_minutes_three_peers", () => {
  const home = tmpHome("nyra-gvideo-");
  try {
    setupRoom(home, "room-e", ["alice", "bob", "carol"]);
    // 虚拟 600 秒，fps=1：发帧 1800；6 路订阅里 4 high + 2 medium
    // （房级预算 8000 降档后），投递 3000、下采样丢 600。
    const res = simulateVideoSession(home, "room-e", ["alice", "bob", "carol"], 600, { fps: 1 });
    expect(res.seconds).toBe(600);
    expect(res.framesPublished).toBe(1800);
    expect(res.framesDelivered).toBe(3000);
    expect(res.framesDroppedByTier).toBe(600);
    expect(res.producersAlive).toBe(3);
    expect(res.roomOpen).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GroupVideoBatch3.test_simulate_short_high_fps", () => {
  const home = tmpHome("nyra-gvideo-");
  try {
    setupRoom(home, "room-f", ["alice", "bob", "carol"]);
    const res = simulateVideoSession(home, "room-f", ["alice", "bob", "carol"], 10, { fps: 10 });
    expect(res.framesPublished).toBe(300);
    expect(res.roomOpen).toBe(true);
    expect(res.producersAlive).toBe(3);
    expect(() => simulateVideoSession(home, "room-f", ["alice"], 10)).toThrow("至少要两个人");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
