// tests/node/test-meeting-batch3.test.ts — 第 3 批：进外部会议
// （Meet/Zoom 受控浏览器进会、纪要管线、断线重连不重复执行）。
// 全部用临时 home + 假浏览器，不起真 Chrome、不联网、不进真会。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMeeting,
  detectMeetingProvider,
  getMeeting,
  joinMeeting,
  listenMeeting,
  addTranscriptLine,
  buildMinutes,
  consentMeetingRecording,
  startMeetingRecording,
  leaveMeeting,
  reconnectMeeting,
  dispatchMeetingAction,
  type MeetingPage,
} from "../../src/meeting.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakePage(captions: (string | null)[]): MeetingPage & { left: boolean; closed: boolean } {
  const queue = [...captions];
  const page: MeetingPage & { left: boolean; closed: boolean } = {
    url: "https://meet.google.com/abc-defg-hij",
    left: false,
    closed: false,
    async waitReady(): Promise<void> { /* 已就绪 */ },
    async caption(): Promise<string | null> {
      return queue.length ? queue.shift()! : null;
    },
    async leave(): Promise<void> { page.left = true; },
    async close(): Promise<void> { page.closed = true; },
  };
  return page;
}

test("MeetingBatch3.test_detect_provider_only_meet_zoom", () => {
  expect(detectMeetingProvider("https://meet.google.com/abc-defg-hij")).toBe("meet");
  expect(detectMeetingProvider("https://zoom.us/j/123456789")).toBe("zoom");
  expect(detectMeetingProvider("https://sub.zoom.us/j/123")).toBe("zoom");
  expect(() => detectMeetingProvider("https://teams.microsoft.com/l/meetup")).toThrow("只进 Meet");
  expect(() => detectMeetingProvider("not-a-url")).toThrow("链接无效");
});

test("MeetingBatch3.test_join_requires_approval", async () => {
  const home = tmpHome("nyra-meeting-");
  try {
    const s = createMeeting(home, "https://meet.google.com/abc-defg-hij");
    expect(s.provider).toBe("meet");
    expect(s.status).toBe("created");
    expect(s.epoch).toBe(1);
    await expect(joinMeeting(home, s.id, { approved: false })).rejects.toThrow("须机主批准");
    expect(getMeeting(home, s.id)?.status).toBe("created");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MeetingBatch3.test_join_listen_minutes_end_to_end_fake_browser", async () => {
  const home = tmpHome("nyra-meeting-");
  try {
    const s = createMeeting(home, "https://zoom.us/j/123456789");
    const page = fakePage(["大家好，开始吧", "决定：下周发版", "待办：小明发纪要", "待办：小明发纪要"]);
    const joined = await joinMeeting(home, s.id, { approved: true, browserDeps: { open: async () => page } });
    expect(joined.status).toBe("in-meeting");
    expect(joined.participants).toContain("owner");
    // 同一行字幕反复抓到只记一次（轮询去重）
    const l1 = await listenMeeting(home, s.id, page);
    expect(l1?.text).toBe("大家好，开始吧");
    const l2 = await listenMeeting(home, s.id, page);
    expect(l2?.text).toBe("决定：下周发版");
    const l3 = await listenMeeting(home, s.id, page);
    expect(l3?.text).toBe("待办：小明发纪要");
    const l4 = await listenMeeting(home, s.id, page);
    expect(l4).toBeNull(); // 同一行重复抓到，不重复记
    expect(getMeeting(home, s.id)?.transcript).toHaveLength(3);
    await leaveMeeting(home, s.id, page);
    expect(page.left).toBe(true);
    expect(page.closed).toBe(true);
    const minutes = buildMinutes(home, s.id);
    expect(minutes.turns).toBe(3);
    expect(minutes.decisions).toEqual(["下周发版"]);
    expect(minutes.actions).toEqual(["小明发纪要"]);
    expect(minutes.ended_at).not.toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MeetingBatch3.test_join_page_never_ready_marks_failed", async () => {
  const home = tmpHome("nyra-meeting-");
  try {
    const s = createMeeting(home, "https://meet.google.com/abc-defg-hij");
    const page = fakePage([]);
    page.waitReady = async () => { throw new Error("页面超时"); };
    await expect(joinMeeting(home, s.id, {
      approved: true,
      browserDeps: { open: async () => page },
    })).rejects.toThrow("页面超时");
    expect(getMeeting(home, s.id)?.status).toBe("failed");
    expect(page.closed).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MeetingBatch3.test_manual_transcript_and_recording_gate", async () => {
  const home = tmpHome("nyra-meeting-");
  try {
    const s = createMeeting(home, "https://meet.google.com/abc-defg-hij");
    const a = addTranscriptLine(home, s.id, "alice", "决定：改用新方案");
    const b = addTranscriptLine(home, s.id, "alice", "决定：改用新方案");
    expect(a.key).toBe(b.key); // 同一行重复补录，不重复记
    expect(getMeeting(home, s.id)?.transcript).toHaveLength(1);
    addTranscriptLine(home, s.id, "bob", "TODO: review the plan");
    const minutes = buildMinutes(home, s.id);
    expect(minutes.decisions).toEqual(["改用新方案"]);
    expect(minutes.actions).toEqual(["review the plan"]);
    expect(minutes.participants).toContain("alice");
    expect(minutes.participants).toContain("bob");
    // 录制：不在会里开不了；进会后仍须全体同意
    expect(() => startMeetingRecording(home, s.id)).toThrow("不在会里");
    const page = fakePage([]);
    await joinMeeting(home, s.id, { approved: true, browserDeps: { open: async () => page } });
    expect(() => startMeetingRecording(home, s.id)).toThrow("还没同意录制");
    consentMeetingRecording(home, s.id, "owner");
    expect(() => startMeetingRecording(home, s.id)).toThrow("alice");
    consentMeetingRecording(home, s.id, "alice");
    consentMeetingRecording(home, s.id, "bob");
    const rec = startMeetingRecording(home, s.id);
    expect(rec.recording).toBe(true);
    await leaveMeeting(home, s.id, page);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MeetingBatch3.test_reconnect_no_dup_dispatch_no_stale_epoch", async () => {
  const home = tmpHome("nyra-meeting-");
  try {
    const s = createMeeting(home, "https://meet.google.com/abc-defg-hij");
    addTranscriptLine(home, s.id, "alice", "待办：发纪要给小明");
    addTranscriptLine(home, s.id, "alice", "待办：更新排期表");
    const page = fakePage(["待办：更新排期表"]);
    await joinMeeting(home, s.id, { approved: true, browserDeps: { open: async () => page } });
    // 重连后重复抓到的行不重复记（跟上一行一样）
    expect(await listenMeeting(home, s.id, page)).toBeNull();
    expect(getMeeting(home, s.id)?.transcript).toHaveLength(2);
    // 派发一次成功，第二次直接跳过（不双写）
    const dispatched: string[] = [];
    const dispatch = async (a: string): Promise<string> => {
      const id = `task-${dispatched.length + 1}`;
      dispatched.push(a);
      return id;
    };
    const r1 = await dispatchMeetingAction(home, s.id, "发纪要给小明", dispatch);
    expect(r1.dispatched).toBe(true);
    expect(dispatched).toHaveLength(1);
    const r2 = await dispatchMeetingAction(home, s.id, "发纪要给小明", dispatch);
    expect(r2.dispatched).toBe(false);
    expect(dispatched).toHaveLength(1);
    // 断线重连：纪元 +1；重连前没派过的待办，旧纪元指令直接拒绝
    const page2 = fakePage([]);
    const rejoined = await reconnectMeeting(home, s.id, { approved: true, browserDeps: { open: async () => page2 } });
    expect(rejoined.epoch).toBe(2);
    const r3 = await dispatchMeetingAction(home, s.id, "更新排期表", dispatch);
    expect(r3.dispatched).toBe(false);
    expect(r3.reason).toContain("纪元");
    expect(dispatched).toHaveLength(1);
    await leaveMeeting(home, s.id, page2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
