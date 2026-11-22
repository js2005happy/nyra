// tests/node/test-sfu-batch2.test.ts — 第 2 批 G-P0-2：群组语音 SFU（本地实现）。
// 全部用临时 home，不起真服务器、不联网。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SfuRegistry,
  SFU_MAX_SPEAKERS,
  SFU_MAX_LISTENERS,
  sfuSelectionNote,
} from "../../src/sfu.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("SfuBatch2.test_create_room_defaults", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    const reg = new SfuRegistry(home);
    const room = reg.createRoom({ id: "room-a" });
    expect(room.id).toBe("room-a");
    expect(room.encryption).toBe("none");
    expect(room.members).toEqual([]);
    expect(room.recording).toBe(false);
    expect(room.closed_at).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_create_room_rejects_dtls_srtp", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    const reg = new SfuRegistry(home);
    expect(() => reg.createRoom({ id: "room-b", encryption: "dtls-srtp" })).toThrow("不支持 dtls-srtp");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_speaker_and_listener_caps", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    const reg = new SfuRegistry(home);
    reg.createRoom({ id: "room-c" });
    for (let i = 0; i < SFU_MAX_SPEAKERS; i++) reg.joinRoom("room-c", `speaker-${i}`, "speaker");
    expect(() => reg.joinRoom("room-c", "speaker-over", "speaker")).toThrow("说话者已满");
    for (let i = 0; i < SFU_MAX_LISTENERS; i++) reg.joinRoom("room-c", `listener-${i}`, "listener");
    expect(() => reg.joinRoom("room-c", "listener-over", "listener")).toThrow("听众已满");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_publish_only_speakers_and_fingerprint_only", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    const reg = new SfuRegistry(home);
    reg.createRoom({ id: "room-d" });
    reg.joinRoom("room-d", "alice", "speaker");
    reg.joinRoom("room-d", "bob", "listener");
    const frame = reg.publish("room-d", "alice", "hello-audio-bytes");
    expect(frame.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(frame.seq).toBe(1);
    expect(() => reg.publish("room-d", "bob", "nope")).toThrow("听众");
    const frames = reg.framesSince("room-d", "alice", 0);
    expect(frames.length).toBe(1);
    expect(JSON.stringify(frames)).not.toContain("hello-audio-bytes");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_turn_credential_ttl_and_validation", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    const now = Date.now();
    const reg = new SfuRegistry(home, { now: () => now });
    reg.createRoom({ id: "room-e" });
    reg.joinRoom("room-e", "alice", "speaker");
    const cred = reg.issueTurnCredential("room-e", "alice", 600);
    expect(cred.username).toContain("alice");
    expect(cred.ttl_seconds).toBe(600);
    expect(reg.validateTurnCredential("room-e", cred)).toBe(true);
    expect(reg.validateTurnCredential("room-e", { ...cred, password: "wrong" })).toBe(false);
    expect(() => reg.issueTurnCredential("room-e", "alice", 10)).toThrow("TTL");
    const expired = new SfuRegistry(home, { now: () => now + 601 * 1000 });
    expect(expired.validateTurnCredential("room-e", cred)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_recording_all_consent_gate", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    const reg = new SfuRegistry(home);
    reg.createRoom({ id: "room-f" });
    reg.joinRoom("room-f", "alice", "speaker");
    reg.joinRoom("room-f", "bob", "speaker");
    expect(() => reg.startRecording("room-f")).toThrow("还没同意录制");
    reg.consentRecording("room-f", "alice");
    expect(() => reg.startRecording("room-f")).toThrow("bob");
    reg.consentRecording("room-f", "bob");
    const room = reg.startRecording("room-f");
    expect(room.recording).toBe(true);
    // 录制开着后新进来没 consent 的人，其帧不进录制文件。
    reg.joinRoom("room-f", "carol", "speaker");
    reg.publish("room-f", "alice", "frame-alice");
    reg.publish("room-f", "carol", "frame-carol");
    const recordingPath = join(home, "sfu-recordings-room-f.jsonl");
    expect(existsSync(recordingPath)).toBe(true);
    const recording = readFileSync(recordingPath, "utf-8");
    expect(recording).toContain("alice");
    expect(recording).not.toContain("carol");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_close_and_idle_reclaim", () => {
  const home = tmpHome("nyra-sfu-");
  try {
    let now = Date.now();
    const reg = new SfuRegistry(home, { now: () => now });
    reg.createRoom({ id: "room-g" });
    reg.createRoom({ id: "room-h" });
    expect(reg.closeRoom("room-g")).toBe(true);
    expect(reg.closeRoom("room-g")).toBe(false);
    expect(() => reg.joinRoom("room-g", "alice")).toThrow("已关闭");
    now += 61 * 1000;
    const reclaimed = reg.reclaimIdleRooms();
    expect(reclaimed).toEqual(["room-h"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("SfuBatch2.test_selection_note_names_mediasoup", () => {
  expect(sfuSelectionNote()).toContain("mediasoup");
});
