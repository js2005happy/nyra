// tests/node/test-call-ledger-40.test.ts — 缺口 40：通话成本与隐私仪表。
// 全部用临时 home 与直接写的来源账本，不连真实渠道、不拨真实电话、不花真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  CALL_LEDGER_FILE,
  callLedgerMain,
  findCallLedgerEntry,
  formatLedgerLine,
  loadCallLedgerBook,
  reconstructRecordingTimeline,
  summarizeCallLedger,
  syncCallLedger,
  CallLedgerError,
} from "../../src/callLedger.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function writeJson(home: string, name: string, data: unknown): void {
  writeFileSync(join(home, name), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function readAllRunEvents(home: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const base = join(home, "runs");
  if (!existsSync(base)) return out;
  for (const runId of readdirSync(base)) {
    const p = join(base, runId, "events.jsonl");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch { /* ignore */ }
    }
  }
  return out;
}

/** 种子：1 通已结束语音 + 1 通进行中语音 + 1 通已结束视频 + 2 个已结束联合会话。 */
function seedStores(home: string): void {
  writeJson(home, "voice-calls.json", {
    version: 1,
    calls: [
      {
        id: "v1", agent: "self", peer: "pilot", status: "ended",
        startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:02:00.000Z",
        segments: [
          { id: "s1", engine: "whisper.cpp", durationSeconds: 60, costUsd: 0 },
          { id: "s2", engine: "cloud:gpt-4o-mini-transcribe", durationSeconds: 30, costUsd: 0.01 },
        ],
        sttSeconds: 90, ttsChars: 50, costUsd: 0.01, costUnpriced: false, runId: "run-voice-1",
      },
      {
        id: "v2", agent: "self", peer: null, status: "active",
        startedAt: "2026-01-01T00:05:00.000Z", endedAt: null,
        segments: [], sttSeconds: 0, ttsChars: 0, costUsd: null, costUnpriced: false, runId: null,
      },
    ],
  });
  writeJson(home, "video-calls.json", {
    version: 1,
    calls: [
      {
        id: "vid1", agent: "self", peer: "pilot", status: "ended",
        startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:03:00.000Z",
        frames: [
          { id: "f1", sampled: true, status: "described", engine: "cloud:gpt-4o", promptTokens: 100, completionTokens: 20, costUsd: 0.002 },
          { id: "f2", sampled: true, status: "confirmed", engine: "cloud:gpt-4o", promptTokens: 50, completionTokens: 10, costUsd: 0.001 },
          { id: "f3", sampled: true, status: "described", engine: "ollama:llava", promptTokens: 80, completionTokens: 15, costUsd: 0 },
          { id: "f4", sampled: false, status: "skipped", engine: null, promptTokens: null, completionTokens: null, costUsd: null },
        ],
        transportBytesIn: 120000, transportBytesOut: 90000,
        framesSent: 5, framesReceived: 4, icePair: { relayed: true },
        recordConsentLocal: true, recordConsentRemote: true, runId: "run-video-1",
      },
    ],
  });
  writeJson(home, "sessions.json", {
    version: 1,
    sessions: [
      {
        id: "ses-1", title: "周会", created_by: "owner",
        created_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:03:20.000Z", status: "ended",
        members: [
          { identity: "owner", kind: "owner", joined_at: "2026-01-01T00:00:00.000Z", left_at: null },
          { identity: "pilot", kind: "friend", joined_at: "2026-01-01T00:00:00.000Z", left_at: null },
        ],
        delegations: [
          { id: "del-1", from: "owner", to: "pilot", task: "整理纪要", acceptance: ["纪要已写"], contract_id: "ct-1", status: "completed", delivery: "done", delivery_reason: "", peer_run_id: null, created_at: "2026-01-01T00:01:00.000Z", updated_at: "2026-01-01T00:02:00.000Z", note: "" },
          { id: "del-2", from: "owner", to: "pilot", task: "跟进订单", acceptance: ["已跟进"], contract_id: "ct-2", status: "pending", delivery: "pending", delivery_reason: "对端未配", peer_run_id: null, created_at: "2026-01-01T00:01:30.000Z", updated_at: "2026-01-01T00:01:30.000Z", note: "" },
        ],
        shares: [], frames: [],
        recording_consented_by: [
          { identity: "owner", at: "2026-01-01T00:00:10.000Z" },
          { identity: "pilot", at: "2026-01-01T00:01:40.000Z" },
        ],
      },
      {
        id: "ses-2", title: "三方会", created_by: "owner",
        created_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:05:00.000Z", status: "ended",
        members: [
          { identity: "owner", kind: "owner", joined_at: "2026-01-01T00:00:00.000Z", left_at: null },
          { identity: "pilot", kind: "friend", joined_at: "2026-01-01T00:00:00.000Z", left_at: null },
          { identity: "carol", kind: "friend", joined_at: "2026-01-01T00:02:30.000Z", left_at: null },
        ],
        delegations: [],
        shares: [], frames: [],
        recording_consented_by: [
          { identity: "owner", at: "2026-01-01T00:00:10.000Z" },
          { identity: "pilot", at: "2026-01-01T00:00:10.000Z" },
          { identity: "carol", at: "2026-01-01T00:03:00.000Z" },
        ],
      },
    ],
  });
  // ses-1：两人 10 秒同意（开录），70 秒 pilot 撤销（停录），100 秒 pilot 再同意（开录），200 秒会话结束（停录）→ 60 + 100 = 160 秒。
  // ses-2：两人 10 秒同意（开录）；carol 100 秒的同意在加入（150 秒）之前，不算数；150 秒加入后停录；180 秒同意后开录，300 秒结束 → 140 + 120 = 260 秒。
  const audit = [
    { at: "2026-01-01T00:00:10.000Z", action: "session_recording_consented", session: "ses-1", by: "owner", consented: true },
    { at: "2026-01-01T00:00:10.000Z", action: "session_recording_consented", session: "ses-1", by: "pilot", consented: true },
    { at: "2026-01-01T00:01:10.000Z", action: "session_recording_consented", session: "ses-1", by: "pilot", consented: false },
    { at: "2026-01-01T00:01:40.000Z", action: "session_recording_consented", session: "ses-1", by: "pilot", consented: true },
    { at: "2026-01-01T00:00:10.000Z", action: "session_recording_consented", session: "ses-2", by: "owner", consented: true },
    { at: "2026-01-01T00:00:10.000Z", action: "session_recording_consented", session: "ses-2", by: "pilot", consented: true },
    { at: "2026-01-01T00:01:40.000Z", action: "session_recording_consented", session: "ses-2", by: "carol", consented: true },
    { at: "2026-01-01T00:03:00.000Z", action: "session_recording_consented", session: "ses-2", by: "carol", consented: true },
  ];
  writeFileSync(join(home, "peer-audit.jsonl"), audit.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

test("CallLedger40Test.test_voice_book", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    const res = syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    expect(res.created).toBe(5);
    const entry = findCallLedgerEntry(home, "v1");
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("voice");
    expect(entry!.transport.bytesIn).toBe(0);
    expect(entry!.transport.bytesOut).toBe(0);
    expect(entry!.media.sttSeconds).toBe(90);
    expect(entry!.media.ttsChars).toBe(50);
    expect(entry!.tokens.localSttSeconds).toBe(60);
    expect(entry!.tokens.cloudSttSeconds).toBe(30);
    expect(entry!.tokens.understandingCostUsd).toBe(0.01);
    expect(entry!.tokens.understandingPromptTokens).toBeNull();
    expect(entry!.durationSeconds).toBe(120);
    expect(entry!.recording.seconds).toBe(0);
    expect(entry!.runId).toBe("run-voice-1");
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_active_call_no_summary", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const entry = findCallLedgerEntry(home, "v2");
    expect(entry).not.toBeNull();
    expect(entry!.endedAt).toBeNull();
    expect(entry!.durationSeconds).toBeNull();
    expect(entry!.summaryRecorded).toBe(false);
    const events = readAllRunEvents(home);
    expect(events.some((e) => e.type === "call_summary" && e.call === "v2")).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_video_book", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const entry = findCallLedgerEntry(home, "vid1");
    expect(entry).not.toBeNull();
    expect(entry!.transport.bytesIn).toBe(120000);
    expect(entry!.transport.bytesOut).toBe(90000);
    expect(entry!.transport.relayed).toBe(true);
    expect(entry!.media.framesSampled).toBe(3);
    expect(entry!.media.framesDescribed).toBe(3);
    expect(entry!.media.framesSent).toBe(5);
    expect(entry!.media.framesReceived).toBe(4);
    expect(entry!.tokens.understandingPromptTokens).toBe(150);
    expect(entry!.tokens.understandingCompletionTokens).toBe(30);
    expect(entry!.tokens.understandingCostUsd).toBeCloseTo(0.003, 9);
    expect(entry!.tokens.localFrames).toBe(1);
    expect(entry!.recording.allowed).toBe(true);
    expect(entry!.recording.seconds).toBeNull();
    expect(entry!.durationSeconds).toBe(180);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_session_book_and_recording_timeline", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const entry = findCallLedgerEntry(home, "ses-1");
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("session");
    expect(entry!.participants).toEqual(["owner", "pilot"]);
    expect(entry!.tokens.delegatedTasks).toBe(2);
    expect(entry!.tokens.delegationIds).toEqual(["del-1", "del-2"]);
    expect(entry!.tokens.workTokens).toBeNull();
    expect(entry!.transport.bytesIn).toBeNull();
    expect(entry!.recording.seconds).toBe(160);
    expect(entry!.recording.allowed).toBe(false);
    expect(entry!.recording.bytes).toBeNull();
    expect(entry!.recording.consentedBy).toEqual(["owner", "pilot"]);
    expect(entry!.durationSeconds).toBe(200);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_recording_pauses_on_new_member", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const entry = findCallLedgerEntry(home, "ses-2");
    expect(entry).not.toBeNull();
    // 加入前同意不算数：150 秒加入后停录，180 秒同意后开录 → 140 + 120 = 260 秒。
    expect(entry!.recording.seconds).toBe(260);
    expect(entry!.recording.allowed).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_reconstruct_timeline_direct", () => {
  const session = {
    id: "s", title: "t", created_by: "owner",
    created_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:03:20.000Z", status: "ended",
    members: [
      { identity: "owner", joined_at: "2026-01-01T00:00:00.000Z", left_at: null },
      { identity: "pilot", joined_at: "2026-01-01T00:00:00.000Z", left_at: null },
    ],
  };
  const events = [
    { at: "2026-01-01T00:00:10.000Z", by: "owner", consented: true },
    { at: "2026-01-01T00:00:10.000Z", by: "pilot", consented: true },
    { at: "2026-01-01T00:01:10.000Z", by: "pilot", consented: false },
    { at: "2026-01-01T00:01:40.000Z", by: "pilot", consented: true },
  ];
  const tl = reconstructRecordingTimeline(session, events, "2026-01-01T01:00:00.000Z");
  expect(tl.seconds).toBe(160);
  expect(tl.allowed).toBe(false);
  expect(tl.transitions.map((t) => `${t.at.slice(14, 19)}:${t.on ? "on" : "off"}`)).toEqual(["00:10:on", "01:10:off", "01:40:on", "03:20:off"]);
});

test("CallLedger40Test.test_sync_idempotent", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    const first = syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    expect(first.created).toBe(5);
    const second = syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    expect(second.created).toBe(0);
    expect(second.updated).toBe(5);
    expect(loadCallLedgerBook(home).calls.length).toBe(5);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_summary_event_once", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const events = readAllRunEvents(home);
    const summaries = events.filter((e) => e.type === "call_summary");
    expect(summaries.length).toBe(4);
    const v1 = summaries.find((e) => e.call === "v1")!;
    expect(v1.kind).toBe("voice");
    expect(v1.duration_seconds).toBe(120);
    expect(v1.stt_seconds).toBe(90);
    expect(v1.understanding_tokens).toBe(0);
    expect(v1.recording_seconds).toBe(0);
    const ses = summaries.find((e) => e.call === "ses-1")!;
    expect(ses.recording_seconds).toBe(160);
    expect(ses.duration_seconds).toBe(200);
    // 纪要只含数字与 id，不含内容原文。
    expect(JSON.stringify(summaries)).not.toContain("周会");
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_recording_events_in_order", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const events = readAllRunEvents(home);
    // 每个事件单独建一条运行，目录顺序不保证时间顺序，按事件自带的变迁时间排
    //（started_at / stopped_at；appendEvent 的 at 是记录时间，同一毫秒内会撞）。
    const rec = events
      .filter((e) => (e.type === "call_recording_started" || e.type === "call_recording_stopped") && e.call === "ses-1")
      .sort((a, b) => String(a.started_at ?? a.stopped_at).localeCompare(String(b.started_at ?? b.stopped_at)));
    expect(rec.map((e) => e.type)).toEqual(["call_recording_started", "call_recording_stopped", "call_recording_started", "call_recording_stopped"]);
    expect(rec[3].seconds).toBe(160);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_corrupt_book_backed_up", () => {
  const home = tmpHome("nyra-call40-");
  try {
    writeFileSync(join(home, CALL_LEDGER_FILE), "{ 不是 json", "utf-8");
    expect(() => loadCallLedgerBook(home)).toThrow("通话账本损坏");
    const names = readdirSync(home);
    expect(names.some((n) => n.startsWith(`${CALL_LEDGER_FILE}.corrupt-`))).toBe(true);
    expect(existsSync(join(home, CALL_LEDGER_FILE))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_cli_ledger_show_summary", async () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    expect(await callLedgerMain(["ledger"], home)).toBe(0);
    expect(await callLedgerMain(["show", "vid1"], home)).toBe(0);
    expect(await callLedgerMain(["show", "vid1", "--json"], home)).toBe(0);
    expect(await callLedgerMain(["summary"], home)).toBe(0);
    expect(await callLedgerMain(["summary", "--json"], home)).toBe(0);
    expect(await callLedgerMain(["show", "nope"], home)).toBe(1);
    expect(await callLedgerMain(["show"], home)).toBe(2);
    expect(await callLedgerMain(["bogus"], home)).toBe(2);
    expectPerms(join(home, CALL_LEDGER_FILE), 0o600);
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_summary_totals", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const totals = summarizeCallLedger(home);
    expect(totals.calls).toBe(5);
    expect(totals.byKind).toEqual({ voice: 2, video: 1, session: 2 });
    expect(totals.durationSeconds).toBe(120 + 180 + 200 + 300);
    // 联合会话传输字节未计量 → 合计为未计量。
    expect(totals.bytesIn).toBeNull();
    expect(totals.bytesOut).toBeNull();
    expect(totals.framesSampled).toBe(3);
    expect(totals.framesDescribed).toBe(3);
    expect(totals.sttSeconds).toBe(90);
    expect(totals.understandingPromptTokens).toBe(150);
    expect(totals.understandingCompletionTokens).toBe(30);
    expect(totals.understandingCostUsd).toBeCloseTo(0.013, 9);
    expect(totals.localFrames).toBe(1);
    expect(totals.localSttSeconds).toBe(60);
    expect(totals.cloudSttSeconds).toBe(30);
    expect(totals.delegatedTasks).toBe(2);
    // 视频通话录制时长未知 → 合计未知。
    expect(totals.recordingSeconds).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_format_line_has_no_content", () => {
  const home = tmpHome("nyra-call40-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const entry = findCallLedgerEntry(home, "ses-1")!;
    const line = formatLedgerLine(entry);
    expect(line).toContain("ses-1");
    expect(line).toContain("联合会话");
    expect(line).not.toContain("周会");
    expect(line).not.toContain("整理纪要");
  } finally {
    cleanup(home);
  }
});

test("CallLedger40Test.test_empty_home", async () => {
  const home = tmpHome("nyra-call40-");
  try {
    const res = syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    expect(res).toEqual({ created: 0, updated: 0 });
    expect(loadCallLedgerBook(home).calls).toEqual([]);
    expect(await callLedgerMain(["ledger"], home)).toBe(0);
    expect(await callLedgerMain(["summary"], home)).toBe(0);
  } finally {
    cleanup(home);
  }
});
