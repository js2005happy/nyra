// tests/node/test-realtime-voice.test.ts — 第 1 批 G-P1-36：实时语音模型插件层。
//
// 注册表 + local 内置实现 + feedCallSegment 走 provider 转写（事件里
// 带 realtime_provider）+ `nyra voice realtime` 三个子命令。换服务不
// 用重接通话逻辑：注册一个新 provider、改 voice.realtime_provider 即可。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import {
  DEFAULT_VOICE_CONFIG, handleVoice,
  type CommandRunner,
} from "../../src/voice.ts";
import {
  getRealtimeVoiceProvider, listRealtimeVoiceProviders, localRealtimeVoiceProvider,
  registerRealtimeVoiceProvider, resolveRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderName,
  type RealtimeVoiceProvider,
} from "../../src/realtimeVoice.ts";
import {
  DEFAULT_VOICE_CALL_CONFIG, answerVoiceCall, feedCallSegment, loadVoiceCallStore,
  startVoiceCall,
} from "../../src/voiceCall.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-rtvoice-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-rtvoice-wd-"));
  return { home, workdir };
}

/** 最小 WAV（16kHz 单声道 16 位 PCM），test-voice-call.test.ts 同款。 */
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
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
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

function writeAudio(workdir: string, name: string, bytes: Buffer): string {
  const p = join(workdir, name);
  writeFileSync(p, bytes);
  return name;
}

/** 假 whisper：--help 永远过；--output-file 写转写文本；ffprobe 报 12.5 秒。 */
function fakeWhisperRunner(transcript = "本地转写"): CommandRunner {
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

function fakeModelPath(): string {
  const p = join(tmpdir(), `nyra-fake-whisper-model-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(p, Buffer.alloc(10));
  return p;
}

/** 捕获 stdout/stderr 写出（handleVoice 直接写 process.stdout）。 */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { out.push(String(a[0])); return true; };
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { err.push(String(a[0])); return true; };
  try {
    const code = await fn();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = origOut as (...a: unknown[]) => boolean;
    (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = origErr as (...a: unknown[]) => boolean;
  }
}

test("RealtimeVoiceTest.test_local_provider_registered_by_default", () => {
  expect(getRealtimeVoiceProvider("local")).toBe(localRealtimeVoiceProvider);
  expect(listRealtimeVoiceProviders().map((p) => p.name)).toContain("local");
  expect(resolveRealtimeVoiceProviderName({})).toBe("local");
  expect(resolveRealtimeVoiceProviderName({ voice: { realtime_provider: "  " } })).toBe("local");
  expect(resolveRealtimeVoiceProviderName({ voice: { realtime_provider: "echo-test" } })).toBe("echo-test");
  expect(resolveRealtimeVoiceProvider({})).toBe(localRealtimeVoiceProvider);
});

test("RealtimeVoiceTest.test_unknown_provider_name_throws_instead_of_silent_fallback", () => {
  expect(() => resolveRealtimeVoiceProvider({ voice: { realtime_provider: "no-such-provider" } })).toThrow("没注册");
});

test("RealtimeVoiceTest.test_register_custom_provider_and_swap_back", () => {
  const fake: RealtimeVoiceProvider = {
    name: "echo-test",
    description: "测试回声服务",
    async transcribe() {
      return { text: "回声转写", engine: "echo-test", seconds: 3 };
    },
  };
  registerRealtimeVoiceProvider(fake);
  expect(getRealtimeVoiceProvider("echo-test")).toBe(fake);
  expect(resolveRealtimeVoiceProvider({ voice: { realtime_provider: "echo-test" } })).toBe(fake);
});

test("RealtimeVoiceTest.test_feed_segment_uses_registered_provider", async () => {
  const { home, workdir } = setup();
  const echo: RealtimeVoiceProvider = {
    name: "echo-test",
    description: "测试回声服务",
    async transcribe(input) {
      expect(input.audio.source).toBe("hi.wav");
      return { text: "今天天气不错", engine: "echo-test", seconds: 5 };
    },
  };
  registerRealtimeVoiceProvider(echo);
  const store = new RunStore(join(home, "runs"));
  const state = store.create("通话任务", "sess-1", home, "auto", 10);
  const call = await startVoiceCall(home, { runId: state.run_id });
  answerVoiceCall(home, call.id);
  const audio = writeAudio(workdir, "hi.wav", sineWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: call.id, audioPath: audio,
    config: { voice: { realtime_provider: "echo-test" } },
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: null,
  });
  expect(result.transcript).toBe("今天天气不错");
  expect(result.segment.engine).toBe("echo-test");
  // 事件里带 provider 名（不记转写原文）。
  const eventsPath = join(home, "runs", state.run_id, "events.jsonl");
  expect(existsSync(eventsPath)).toBe(true);
  const events = readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const transcribed = events.find((e) => e.type === "voice_call_transcribed");
  expect(transcribed).toBeDefined();
  expect(transcribed!.realtime_provider).toBe("echo-test");
  const stored = loadVoiceCallStore(home).calls[0];
  expect(stored.segments[0].engine).toBe("echo-test");
  expect(result.held).toBe(false);
});

test("RealtimeVoiceTest.test_feed_segment_local_provider_still_prefers_whisper", async () => {
  const { home, workdir } = setup();
  const call = await startVoiceCall(home, {});
  answerVoiceCall(home, call.id);
  const audio = writeAudio(workdir, "hi.wav", sineWav(1));
  const result = await feedCallSegment({
    home, workdir, callId: call.id, audioPath: audio,
    config: {},
    voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: fakeModelPath() },
    callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: null,
    runCommand: fakeWhisperRunner("本地转写结果"),
  });
  expect(result.transcript).toBe("本地转写结果");
  expect(result.segment.engine).toBe("whisper.cpp");
});

test("RealtimeVoiceTest.test_cli_realtime_list_use_status", async () => {
  const { home } = setup();
  const echo: RealtimeVoiceProvider = {
    name: "echo-test",
    description: "测试回声服务",
    async transcribe() {
      return { text: "x", engine: "echo-test", seconds: 1 };
    },
  };
  registerRealtimeVoiceProvider(echo);
  const list = await capture(() => handleVoice(["realtime", "list"], home));
  expect(list.code).toBe(0);
  expect(list.out).toContain("local");
  expect(list.out).toContain("echo-test");
  expect(list.out).toContain("* local");
  const use = await capture(() => handleVoice(["realtime", "use", "echo-test"], home));
  expect(use.code).toBe(0);
  expect(use.out).toContain("echo-test");
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
  expect((cfg.voice as Record<string, unknown>).realtime_provider).toBe("echo-test");
  const status = await capture(() => handleVoice(["realtime", "status"], home));
  expect(status.code).toBe(0);
  expect(status.out).toContain("echo-test");
  // 切到没注册的：拒绝，不写配置。
  const bad = await capture(() => handleVoice(["realtime", "use", "no-such-provider"], home));
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("没注册");
  // 切回 local。
  expect((await capture(() => handleVoice(["realtime", "use", "local"], home))).code).toBe(0);
});
