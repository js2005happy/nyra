// tests/node/test-call-ledger-split.test.ts — 缺口 40 第二批：通话账本按人拆分成本。
// 全部用临时 home 与直接写的来源账本，不连真实渠道、不拨真实电话、不花真实 token。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callLedgerMain,
  formatLedgerSummaryByParticipant,
  summarizeCallLedgerByParticipant,
  syncCallLedger,
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

/**
 * 种子（时间全是固定值，时长可精确算）：
 * - 语音 v1：self + pilot，120 秒，云端 STT 30 秒花 $0.01；
 * - 视频 vid1：self + pilot，180 秒，云端理解 180 token 花 $0.003；
 * - 会话 ses-1：owner + pilot，200 秒；两人都在场全程，录制从 00:01:40
 *   开到 00:03:20（100 秒），两人各分 100 秒录制；
 * - 会话 ses-2：owner + pilot + carol，300 秒；carol 00:02:30 才进会、
 *   00:04:00 才同意录制，录制从 00:04:00 开到 00:05:00（60 秒），三人
 *   各分 60 秒录制；在场时长 owner 300、pilot 300、carol 150。
 */
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
        delegations: [], shares: [], frames: [],
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
        delegations: [], shares: [], frames: [],
        recording_consented_by: [
          { identity: "owner", at: "2026-01-01T00:00:10.000Z" },
          { identity: "pilot", at: "2026-01-01T00:00:10.000Z" },
          { identity: "carol", at: "2026-01-01T00:04:00.000Z" },
        ],
      },
    ],
  });
  // 录制同意事件（peer-audit.jsonl，callLedger 的录制时间线从这里读）。
  const events = [
    { action: "session_recording_consented", session: "ses-1", at: "2026-01-01T00:00:10.000Z", by: "owner", consented: true },
    { action: "session_recording_consented", session: "ses-1", at: "2026-01-01T00:01:40.000Z", by: "pilot", consented: true },
    { action: "session_recording_consented", session: "ses-2", at: "2026-01-01T00:00:10.000Z", by: "owner", consented: true },
    { action: "session_recording_consented", session: "ses-2", at: "2026-01-01T00:00:10.000Z", by: "pilot", consented: true },
    { action: "session_recording_consented", session: "ses-2", at: "2026-01-01T00:04:00.000Z", by: "carol", consented: true },
  ];
  writeFileSync(join(home, "peer-audit.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

test("CallLedgerSplitTest.test_split_money_tokens_duration", () => {
  const home = tmpHome("nyra-call-split-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const shares = summarizeCallLedgerByParticipant(home, "2026-01-01T01:00:00.000Z");
    const byName = new Map(shares.map((s) => [s.participant, s]));
    // pilot：语音 + 视频 + 两个会话 = 4 通；费用 (0.01 + 0.003) / 2 = 0.0065；
    // token 180 / 2 = 90；云端 STT 30 / 2 = 15 秒；在场 120 + 180 + 200 + 300 = 800 秒。
    const pilot = byName.get("pilot")!;
    expect(pilot.calls).toBe(4);
    expect(pilot.byKind).toEqual({ voice: 1, video: 1, session: 2 });
    expect(pilot.understandingCostUsd).toBeCloseTo(0.0065, 10);
    expect(pilot.understandingTokens).toBe(90);
    expect(pilot.cloudSttSeconds).toBe(15);
    expect(pilot.durationSeconds).toBe(800);
    // self：语音 + 视频 = 2 通；费用与 token 与 pilot 相同；在场 300 秒。
    const self = byName.get("self")!;
    expect(self.calls).toBe(2);
    expect(self.understandingCostUsd).toBeCloseTo(0.0065, 10);
    expect(self.understandingTokens).toBe(90);
    expect(self.durationSeconds).toBe(300);
    // owner：两个会话 = 2 通；没参加语音/视频，费用与 token 都是 0；在场 500 秒。
    const owner = byName.get("owner")!;
    expect(owner.calls).toBe(2);
    expect(owner.understandingCostUsd).toBe(0);
    expect(owner.understandingTokens).toBe(0);
    expect(owner.durationSeconds).toBe(500);
    // carol：只在 ses-2，150 秒在场。
    const carol = byName.get("carol")!;
    expect(carol.calls).toBe(1);
    expect(carol.durationSeconds).toBe(150);
    expect(carol.understandingCostUsd).toBe(0);
  } finally {
    cleanup(home);
  }
});

test("CallLedgerSplitTest.test_split_recording_seconds", () => {
  const home = tmpHome("nyra-call-split-");
  try {
    seedStores(home);
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const shares = summarizeCallLedgerByParticipant(home, "2026-01-01T01:00:00.000Z");
    const byName = new Map(shares.map((s) => [s.participant, s]));
    // 视频通话的录制时长未知：参加过视频的 self 与 pilot，录制分到 null。
    expect(byName.get("self")!.recordingSeconds).toBeNull();
    expect(byName.get("pilot")!.recordingSeconds).toBeNull();
    // owner 只参加两个会话：ses-1 录制 100 秒 + ses-2 录制 200 秒 = 300 秒
    // （ses-2 的录制是两段：00:00:10–00:02:30 只有 owner 与 pilot 在会且
    // 都已同意，carol 00:02:30 进会后没同意就停录，00:04:00 她同意后恢复
    // 到 00:05:00；owner 全程在场且已同意，两段都算他的）。
    expect(byName.get("owner")!.recordingSeconds).toBe(300);
    // carol 只在 ses-2：录制 60 秒（00:04:00–00:05:00）。
    expect(byName.get("carol")!.recordingSeconds).toBe(60);
  } finally {
    cleanup(home);
  }
});

test("CallLedgerSplitTest.test_split_unpriced_cost_is_null", () => {
  const home = tmpHome("nyra-call-split-");
  try {
    // 一通云端 STT 没计价的语音：费用分到 null（不是 0），时长照常分。
    writeJson(home, "voice-calls.json", {
      version: 1,
      calls: [
        {
          id: "v9", agent: "self", peer: "pilot", status: "ended",
          startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z",
          segments: [
            { id: "s1", engine: "cloud:gpt-4o-mini-transcribe", durationSeconds: 60, costUsd: null },
          ],
          sttSeconds: 60, ttsChars: 0, costUsd: null, costUnpriced: true, runId: null,
        },
      ],
    });
    writeJson(home, "video-calls.json", { version: 1, calls: [] });
    writeJson(home, "sessions.json", { version: 1, sessions: [] });
    syncCallLedger(home, "2026-01-01T01:00:00.000Z");
    const shares = summarizeCallLedgerByParticipant(home, "2026-01-01T01:00:00.000Z");
    expect(shares.length).toBe(2);
    for (const s of shares) {
      expect(s.understandingCostUsd).toBeNull();
      expect(s.durationSeconds).toBe(60);
      expect(s.cloudSttSeconds).toBe(30);
      expect(s.recordingSeconds).toBe(0);
    }
  } finally {
    cleanup(home);
  }
});

test("CallLedgerSplitTest.test_cli_summary_by_person", async () => {
  const home = tmpHome("nyra-call-split-");
  try {
    seedStores(home);
    expect(await callLedgerMain(["summary", "--by-person"], home)).toBe(0);
    expect(await callLedgerMain(["summary", "--by-person", "--json"], home)).toBe(0);
    const shares = summarizeCallLedgerByParticipant(home, "2026-01-01T01:00:00.000Z");
    const text = formatLedgerSummaryByParticipant(shares);
    expect(text).toContain("按人分摊");
    expect(text).toContain("pilot");
    expect(text).toContain("$0.0065");
  } finally {
    cleanup(home);
  }
});
