// tests/node/test-voice-call.test.ts — 缺口 36：实时语音通话通道。
// 假 whisper / 假云端 STT-TTS / 假音频字节：覆盖通话状态机、VAD 门控、
// 本地优先与云端 opt-in、月度硬顶拦云端、敏感意图扣下与文字确认、
// 用量账本记账、事件注册与时间线渲染、CLI 端到端。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { UsageLedger, localDateString, monthKeyString } from "../../src/usageLedger.ts";
import { DEFAULT_VOICE_CONFIG, type CommandRunner } from "../../src/voice.ts";
import {
  DEFAULT_VOICE_CALL_CONFIG, LoopbackTransport, answerVoiceCall, confirmCallSegment, declineVoiceCall,
  detectSensitiveIntent, endVoiceCall, feedCallSegment, formatCallSummary,
  handleVoiceCall, listVoiceCalls, loadVoiceCallStore, resolveVoiceCallConfig,
  startVoiceCall, summarizeVoiceCall, vadGateWav,
  type VoiceCallConfig,
} from "../../src/voiceCall.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-call-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-call-wd-"));
  return { home, workdir };
}

/** 造一段最小 WAV（16kHz 单声道 16 位 PCM）：samples 是归一化采样值。 */
function makeWav(samples: number[]): Buffer {
  const n = samples.length;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function sineWav(seconds = 1): Buffer {
  const n = 16000 * seconds;
  const samples: number[] = new Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  return makeWav(samples);
}

function silenceWav(seconds = 1): Buffer {
  return makeWav(new Array(16000 * seconds).fill(0));
}

function writeAudio(workdir: string, name: string, bytes: Buffer): string {
  const p = join(workdir, name);
  writeFileSync(p, bytes);
  return name;
}

/** 假 whisper：--help 永远过；--output-file 写转写文本；ffprobe 报 12.5 秒。 */
function fakeWhisperRunner(transcript = "帮我写一个 out.txt"): CommandRunner {
  return (binary: string, args: string[]) => {
    if (binary === "ffprobe") return { status: 0, stdout: "12.5", stderr: "" };
    if (args.includes("--help")) return { status: 0, stdout: "whisper.cpp", stderr: "" };
    const outIdx = args.indexOf("--output-file");
    if (outIdx >= 0) {
      writeFileSync(`${args[outIdx + 1]}.txt`, transcript, "utf-8");
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unknown command" };
  };
}

/** 假 whisper 模型文件（localSttAvailable 会校验文件存在，须是真文件）。 */
function fakeModelPath(): string {
  const p = join(tmpdir(), `nyra-fake-whisper-model-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(p, Buffer.alloc(10));
  return p;
}

/** 假“什么都没有”：任何二进制都找不到（status null）。 */
function noBinaryRunner(): CommandRunner {
  return () => ({ status: null, stdout: "", stderr: "not found" });
}

/** 只报 ffprobe 时长、其余二进制都找不到。 */
function ffprobeOnlyRunner(): CommandRunner {
  return (binary: string) => {
    if (binary === "ffprobe") return { status: 0, stdout: "12.5", stderr: "" };
    return { status: null, stdout: "", stderr: "not found" };
  };
}

/** 假云端：STT 回固定文本，TTS 回假 mp3。 */
function fakeCloudFetch(transcript = "云端转写结果"): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: transcript, usage: { seconds: 12.5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/audio/speech")) {
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const ENDPOINT = { baseUrl: "https://fake.invalid", apiKey: "fake-key" };

async function activeCall(home: string, peer?: string | null): Promise<string> {
  const call = await startVoiceCall(home, { peer: peer ?? null, yes: true });
  answerVoiceCall(home, call.id);
  return call.id;
}

test("VoiceCallTest.test_vad_silence_vs_speech", () => {
  const sil = vadGateWav(silenceWav(1));
  expect(sil.parsed).toBe(true);
  expect(sil.speech).toBe(false);
  expect(sil.ratio).toBe(0);
  const sp = vadGateWav(sineWav(1));
  expect(sp.parsed).toBe(true);
  expect(sp.speech).toBe(true);
  expect(sp.ratio).not.toBeNull();
  expect(sp.ratio!).toBeGreaterThan(0.9);
  const bad = vadGateWav(Buffer.from("not a wav at all, just text........"));
  expect(bad.parsed).toBe(false);
  expect(bad.speech).toBe(true); // 解析失败不丢语音
});

test("VoiceCallTest.test_sensitive_intent", () => {
  expect(detectSensitiveIntent("帮我转账 500 给张三")).toBe("payment");
  expect(detectSensitiveIntent("请支付这笔订单")).toBe("payment");
  expect(detectSensitiveIntent("please pay the invoice")).toBe("payment");
  expect(detectSensitiveIntent("发消息给小李说我晚点到")).toBe("external_send");
  expect(detectSensitiveIntent("send an email to the team")).toBe("external_send");
  expect(detectSensitiveIntent("帮我写一个 out.txt")).toBeNull();
  expect(detectSensitiveIntent("今天天气怎么样")).toBeNull();
});

test("VoiceCallTest.test_call_config_defaults", () => {
  const d = resolveVoiceCallConfig({});
  expect(d).toEqual(DEFAULT_VOICE_CALL_CONFIG);
  expect(d.callCloudEnabled).toBe(false);
  const bad = resolveVoiceCallConfig({ voice: { call_max_minutes: -5, call_cloud_enabled: "yes" } });
  expect(bad.maxCallMinutes).toBe(DEFAULT_VOICE_CALL_CONFIG.maxCallMinutes);
  expect(bad.callCloudEnabled).toBe(false);
  const on = resolveVoiceCallConfig({ voice: { call_cloud_enabled: true, call_reply_max_chars: 500 } });
  expect(on.callCloudEnabled).toBe(true);
  expect(on.replyMaxChars).toBe(500);
});

test("VoiceCallTest.test_lifecycle_states", async () => {
  const { home } = setup();
  expect(LoopbackTransport.kind).toBe("loopback");
  const call = await startVoiceCall(home, {});
  expect(call.status).toBe("ringing");
  expect(call.transport).toBe("loopback");
  expect(() => answerVoiceCall(home, "call-nope")).toThrow();
  expect(() => endVoiceCall(home, call.id)).not.toThrow(); // 响铃时挂断 = 没接上
  const c2 = await startVoiceCall(home, {});
  expect(() => endVoiceCall(home, c2.id)).not.toThrow();
  expect(() => answerVoiceCall(home, c2.id)).toThrow(); // 已结束，接不了
  const c3 = await startVoiceCall(home, {});
  const declined = declineVoiceCall(home, c3.id);
  expect(declined.status).toBe("declined");
  expect(() => declineVoiceCall(home, c3.id)).toThrow();
});

test("VoiceCallTest.test_start_peer_requires_yes", async () => {
  const { home } = setup();
  await expect(startVoiceCall(home, { peer: "林舟", yes: false })).rejects.toThrow("--yes");
  const call = await startVoiceCall(home, { peer: "林舟", yes: true });
  expect(call.peer).toBe("林舟");
});

test("VoiceCallTest.test_segment_requires_active_call", async () => {
  const { home, workdir } = setup();
  const call = await startVoiceCall(home, {});
  const audio = writeAudio(workdir, "a.wav", sineWav(1));
  await expect(feedCallSegment({
    home, workdir, callId: call.id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: null, runCommand: fakeWhisperRunner(),
  })).rejects.toThrow("先接听");
});

test("VoiceCallTest.test_silence_segment_skipped_without_stt", async () => {
  const { home, workdir } = setup();
  const calls: string[] = [];
  const spyRunner: CommandRunner = (binary, args) => {
    calls.push(`${binary} ${args.join(" ")}`);
    return fakeWhisperRunner()(binary, args);
  };
  const id = await activeCall(home);
  const audio = writeAudio(workdir, "sil.wav", silenceWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: null, runCommand: spyRunner,
  });
  expect(result.skippedSilence).toBe(true);
  expect(result.segment.status).toBe("skipped_silence");
  expect(result.segment.costUsd).toBe(0);
  expect(calls.length).toBe(1); // 只调过 ffprobe 读时长，没调 whisper
  expect(calls[0].startsWith("ffprobe")).toBe(true);
  const call = loadVoiceCallStore(home).calls[0];
  expect(call.segments.length).toBe(1);
  expect(call.costUsd).toBe(0);
});

test("VoiceCallTest.test_local_transcription_and_ledger", async () => {
  const { home, workdir } = setup();
  const id = await activeCall(home);
  const audio = writeAudio(workdir, "hi.wav", sineWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: fakeModelPath() },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: null, runCommand: fakeWhisperRunner("帮我写一个 out.txt"),
  });
  expect(result.held).toBe(false);
  expect(result.transcript).toBe("帮我写一个 out.txt");
  expect(result.segment.engine).toBe("whisper.cpp");
  expect(result.segment.costUsd).toBe(0);
  expect(result.segment.textHash).toHaveLength(12);
  const rows = new UsageLedger(home).readAll();
  expect(rows.length).toBe(1);
  expect(rows[0].calls).toBe(1);
  expect(rows[0].spent_usd).toBe(0);
  const audit = readFileSync(join(home, "voice-call-audit.jsonl"), "utf-8");
  expect(audit).toContain("\"op\":\"transcribed\"");
  expect(audit).not.toContain("帮我写一个 out.txt"); // 审计不记原文
});

test("VoiceCallTest.test_cloud_requires_explicit_opt_in", async () => {
  const { home, workdir } = setup();
  const id = await activeCall(home);
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, 0x20)]);
  const audio = writeAudio(workdir, "c.mp3", mp3);
  await expect(feedCallSegment({
    home, workdir, callId: id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: ENDPOINT,
    runCommand: noBinaryRunner(), fetchFn: fakeCloudFetch(),
  })).rejects.toThrow("call_cloud_enabled");
});

test("VoiceCallTest.test_cloud_transcription_when_opted_in", async () => {
  const { home, workdir } = setup();
  const id = await activeCall(home);
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, 0x20)]);
  const audio = writeAudio(workdir, "c.mp3", mp3);
  const cfg: VoiceCallConfig = { ...DEFAULT_VOICE_CALL_CONFIG, callCloudEnabled: true };
  const voiceCfg = { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null, sttPricePerMinUsd: 0.006 };
  const result = await feedCallSegment({
    home, workdir, callId: id, audioPath: audio, config: { voice: { call_cloud_enabled: true } },
    voiceCfg, callCfg: cfg, endpoint: ENDPOINT,
    runCommand: noBinaryRunner(), fetchFn: fakeCloudFetch("云端转写结果"),
  });
  expect(result.transcript).toBe("云端转写结果");
  expect(result.segment.engine).toBe("cloud:whisper-1");
  expect(result.segment.costUsd).not.toBeNull();
  expect(result.segment.costUsd!).toBeGreaterThan(0);
  const rows = new UsageLedger(home).readAll();
  expect(rows.length).toBe(1);
  expect(rows[0].spent_usd).toBeCloseTo(0.00125, 6);
});

test("VoiceCallTest.test_monthly_cap_blocks_cloud", async () => {
  const { home, workdir } = setup();
  const id = await activeCall(home);
  // 本月已花 $100，上限 $1：云端路直接拒绝。
  const month = monthKeyString(new Date());
  writeFileSync(join(home, "usage_daily.jsonl"),
    JSON.stringify({ date: localDateString(new Date()), month, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 1, spent_usd: 100, model: "fake", agent: null }) + "\n");
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, 0x20)]);
  const audio = writeAudio(workdir, "c.mp3", mp3);
  const cfg: VoiceCallConfig = { ...DEFAULT_VOICE_CALL_CONFIG, callCloudEnabled: true };
  const voiceCfg = { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null, sttPricePerMinUsd: 0.006 };
  await expect(feedCallSegment({
    home, workdir, callId: id, audioPath: audio,
    config: { voice: { call_cloud_enabled: true }, monthly_cost_limit_usd: 1 },
    voiceCfg, callCfg: cfg, endpoint: ENDPOINT,
    runCommand: ffprobeOnlyRunner(), fetchFn: fakeCloudFetch(),
  })).rejects.toThrow("月度上限");
});

test("VoiceCallTest.test_sensitive_segment_held_and_confirmed", async () => {
  const { home, workdir } = setup();
  const id = await activeCall(home);
  const audio = writeAudio(workdir, "pay.wav", sineWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: fakeModelPath() },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: null,
    runCommand: fakeWhisperRunner("帮我转账 500 给张三"),
  });
  expect(result.held).toBe(true);
  expect(result.segment.status).toBe("held");
  expect(result.segment.heldReason).toBe("payment");
  const audit = readFileSync(join(home, "voice-call-audit.jsonl"), "utf-8");
  expect(audit).toContain("\"op\":\"blocked\"");
  expect(audit).not.toContain("帮我转账 500 给张三");
  const seg = confirmCallSegment(home, id, result.segment.id);
  expect(seg.status).toBe("confirmed");
  expect(() => confirmCallSegment(home, id, result.segment.id)).toThrow("不用确认");
  expect(() => confirmCallSegment(home, id, "seg-nope")).toThrow("找不到段落");
});

test("VoiceCallTest.test_reply_tts_saved_and_events_mirrored", async () => {
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("通话任务", "sess-1", home, "auto", 10);
  const call = await startVoiceCall(home, { runId: state.run_id });
  answerVoiceCall(home, call.id);
  const audio = writeAudio(workdir, "hi.wav", sineWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: call.id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null, ttsPricePer1kCharsUsd: 15 },
    callCfg: { ...DEFAULT_VOICE_CALL_CONFIG, callCloudEnabled: true },
    endpoint: ENDPOINT, runCommand: fakeWhisperRunner("你好"),
    fetchFn: fakeCloudFetch(), speakReply: "好的，写完了",
  });
  expect(result.replyPath).not.toBeNull();
  expect(existsSync(result.replyPath!)).toBe(true);
  expectPerms(result.replyPath!, 0o600);
  expect(result.segment.replyChars).toBe(6);
  const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  expect(events).toContain("voice_call_started");
  expect(events).toContain("voice_call_answered");
  expect(events).toContain("voice_call_transcribed");
  expect(events).toContain("voice_call_spoken");
  const ended = endVoiceCall(home, call.id);
  const summary = formatCallSummary(ended);
  expect(summary).toContain("传输：本机回环");
  expect(summary).toContain("无 token 花费");
  const s = summarizeVoiceCall(ended);
  expect(s.segments).toBe(1);
  expect(s.transcribed).toBe(1);
});

test("VoiceCallTest.test_held_segment_gets_no_reply", async () => {
  const { home, workdir } = setup();
  const id = await activeCall(home);
  const audio = writeAudio(workdir, "pay.wav", sineWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: id, audioPath: audio, config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: fakeModelPath() },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: ENDPOINT,
    runCommand: fakeWhisperRunner("帮我转账 500 给张三"),
    fetchFn: fakeCloudFetch(), speakReply: "好的",
  });
  expect(result.held).toBe(true);
  expect(result.replyPath).toBeNull(); // 扣下的段落不回读
  expect(existsSync(join(home, "voice"))).toBe(false);
});

test("VoiceCallTest.test_timeline_renders_call_events", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-call-tl-"));
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  writeFileSync(join(home, "runs", runId, "events.jsonl"), [
    JSON.stringify({ at: state.created_at, type: "voice_call_started", call_id: "call-1", agent: "nyra", peer: "林舟", transport: "loopback" }),
    JSON.stringify({ at: state.created_at, type: "voice_call_transcribed", call_id: "call-1", segment_id: "seg-1", vad: "speech", seconds: 12, chars: 8, engine: "whisper.cpp", cost_usd: 0, text_hash: "abc123" }),
    JSON.stringify({ at: state.created_at, type: "voice_call_blocked", call_id: "call-1", segment_id: "seg-2", reason: "payment", text_hash: "def456" }),
    JSON.stringify({ at: state.created_at, type: "voice_call_ended", call_id: "call-1", duration_seconds: 120, segments: 2, stt_seconds: 12, tts_chars: 0, cost_usd: 0, held: 1 }),
  ].join("\n") + "\n");
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("语音通话建立");
  expect(text).toContain("通话转写");
  expect(text).toContain("被扣下");
  expect(text).toContain("语音通话结束");
});

test("VoiceCallTest.test_store_corrupt_backed_up", () => {
  const { home } = setup();
  writeFileSync(join(home, "voice-calls.json"), "{not json", "utf-8");
  expect(() => loadVoiceCallStore(home)).toThrow("损坏，已备份");
  const names = readdirSync(home);
  expect(names.some((n) => n.startsWith("voice-calls.json.corrupt-"))).toBe(true);
});

test("VoiceCallTest.test_cli_end_to_end", async () => {
  const { home, workdir } = setup();
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { out.push(String(a[0])); return true; };
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { err.push(String(a[0])); return true; };
  try {
    const runner = fakeWhisperRunner("你好呀");
    // sttLocalModel 配在 config 里：handleVoiceCall 从 home 的 config.json 读。
    writeFileSync(join(home, "config.json"), JSON.stringify({ voice: { stt_local_model: fakeModelPath() } }));
    expect(await handleVoiceCall(["start"], home, { runCommand: runner })).toBe(0);
    const calls = listVoiceCalls(home);
    expect(calls.length).toBe(1);
    const id = calls[0].id;
    expect(await handleVoiceCall(["answer", id], home, { runCommand: runner })).toBe(0);
    const audio = writeAudio(workdir, "hi.wav", sineWav(1));
    expect(await handleVoiceCall(["segment", id, join(workdir, audio)], home, { runCommand: runner })).toBe(0);
    expect(await handleVoiceCall(["end", id], home, { runCommand: runner })).toBe(0);
    expect(await handleVoiceCall(["status", id], home, { runCommand: runner })).toBe(0);
    expect(await handleVoiceCall(["bogus"], home, { runCommand: runner })).toBe(2);
    expect(await handleVoiceCall(["start", "--peer", "林舟"], home, { runCommand: runner })).toBe(1);
  } finally {
    (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = origOut as (...a: unknown[]) => boolean;
    (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = origErr as (...a: unknown[]) => boolean;
  }
  const joined = out.join("");
  expect(joined).toContain("通话已建立");
  expect(joined).toContain("转写（whisper.cpp");
  expect(joined).toContain("你好呀");
  expect(joined).toContain("传输：本机回环");
  expect(err.join("")).toContain("须加 --yes");
});
