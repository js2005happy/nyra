// tests/node/test-voice-hooks.test.ts — G-P1-36 第二批：通话钩子层 + 通话笔记。
// 假 whisper / 假音频字节：钩子注册与开关、分发顺序与 fail-closed、
// 生命周期事件只含元数据、钩子失败进证据链、笔记记在通话记录上。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { DEFAULT_VOICE_CONFIG, type CommandRunner } from "../../src/voice.ts";
import {
  DEFAULT_VOICE_CALL_CONFIG, answerVoiceCall, endVoiceCall,
  feedCallSegment, handleVoiceCall, startVoiceCall, addCallNote, listCallNotes,
  confirmCallSegment,
} from "../../src/voiceCall.ts";
import {
  clearVoiceHooks, dispatchVoiceHook, isVoiceHookEnabled, listVoiceHooks,
  readVoiceHookConfig, registerVoiceHook, saveVoiceHookConfig,
  setVoiceHookEnabled, setVoiceHooksMasterEnabled, unregisterVoiceHook,
  voiceHooksPath, type VoiceHook, type VoiceHookEvent,
} from "../../src/voiceHooks.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-hook-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-hook-wd-"));
  return { home, workdir };
}

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

function silenceWav(seconds = 1): Buffer {
  return makeWav(new Array(16000 * seconds).fill(0));
}

function writeAudio(workdir: string, name: string, bytes: Buffer): string {
  const p = join(workdir, name);
  writeFileSync(p, bytes);
  return name;
}

function fakeModelPath(): string {
  const p = join(tmpdir(), `nyra-fake-whisper-model-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(p, Buffer.alloc(10));
  return p;
}

/** 假 whisper：--help 过；--output-file 写转写文本；ffprobe 报 12.5 秒。 */
function fakeWhisperRunner(transcript = "你好"): CommandRunner {
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

const ENDPOINT = { baseUrl: "https://fake.invalid", apiKey: "fake-key" };

async function activeCall(home: string): Promise<string> {
  const call = await startVoiceCall(home, {});
  answerVoiceCall(home, call.id);
  return call.id;
}

function recorder(): { hook: VoiceHook; seen: VoiceHookEvent[] } {
  const seen: VoiceHookEvent[] = [];
  return {
    hook: { name: "recorder", description: "测试记录钩子", onEvent: (e) => { seen.push(e); } },
    seen,
  };
}

test("VoiceHookTest.test_registry_register_list_unregister", () => {
  clearVoiceHooks();
  expect(listVoiceHooks()).toEqual([]);
  const { hook } = recorder();
  registerVoiceHook(hook);
  expect(listVoiceHooks().map((h) => h.name)).toEqual(["recorder"]);
  expect(() => registerVoiceHook(hook)).toThrow("已注册");
  expect(() => registerVoiceHook({ name: "Bad Name!", description: "", onEvent: () => {} })).toThrow("钩子名无效");
  expect(() => registerVoiceHook({ name: "nope", description: "", onEvent: undefined as never })).toThrow("没有 onEvent");
  expect(unregisterVoiceHook("recorder")).toBe(true);
  expect(unregisterVoiceHook("recorder")).toBe(false);
  expect(listVoiceHooks()).toEqual([]);
  clearVoiceHooks();
});

test("VoiceHookTest.test_config_defaults_enable_disable_master", () => {
  const { home } = setup();
  const cfg = readVoiceHookConfig(home);
  expect(cfg.enabled).toBe(true);
  expect(isVoiceHookEnabled(home, "recorder")).toBe(true);
  setVoiceHookEnabled(home, "recorder", false);
  expect(isVoiceHookEnabled(home, "recorder")).toBe(false);
  expect(isVoiceHookEnabled(home, "other")).toBe(true);
  setVoiceHookEnabled(home, "recorder", true);
  expect(isVoiceHookEnabled(home, "recorder")).toBe(true);
  setVoiceHooksMasterEnabled(home, false);
  expect(isVoiceHookEnabled(home, "recorder")).toBe(false);
  setVoiceHooksMasterEnabled(home, true);
  expect(isVoiceHookEnabled(home, "recorder")).toBe(true);
  expectPerms(voiceHooksPath(home), 0o600);
});

test("VoiceHookTest.test_config_corrupt_backed_up_and_defaults", () => {
  const { home } = setup();
  saveVoiceHookConfig(home, { version: 1, enabled: true, hooks: { a: false } });
  writeFileSync(voiceHooksPath(home), "{ not json", "utf-8");
  const cfg = readVoiceHookConfig(home);
  expect(cfg).toEqual({ version: 1, enabled: true, hooks: {} });
  const backups = readdirSync(home).filter((f) => f.startsWith("voice-hooks.json.corrupt-"));
  expect(backups.length).toBe(1);
  expect(existsSync(voiceHooksPath(home))).toBe(true);
});

test("VoiceHookTest.test_dispatch_order_and_metadata_only", () => {
  const { home } = setup();
  const seen: string[] = [];
  const a: VoiceHook = { name: "aaa", description: "a", onEvent: (e) => { seen.push(`a:${e.kind}`); } };
  const b: VoiceHook = { name: "bbb", description: "b", onEvent: (e) => { seen.push(`b:${e.kind}`); } };
  const r = dispatchVoiceHook(home, { kind: "call_started", callId: "call-1", at: new Date().toISOString(), agent: "nyra", peer: null, transport: "loopback" }, { hooks: [a, b] });
  expect(r).toEqual({ delivered: ["aaa", "bbb"], failed: [] });
  expect(seen).toEqual(["a:call_started", "b:call_started"]);
  // 事件里没有原文、没有音频：钩子凭元数据做决定，原文根本不在事件里。
  const ev: VoiceHookEvent = { kind: "segment_transcribed", callId: "call-1", at: new Date().toISOString(), segmentId: "seg-1", chars: 2, engine: "whisper.cpp", textHash: "abc123" };
  expect(JSON.stringify(ev)).not.toContain("你好");
  const keys = Object.keys(ev);
  expect(keys).not.toContain("text");
  expect(keys).not.toContain("transcript");
  expect(keys).not.toContain("audioPath");
  expect(keys).not.toContain("audio");
});

test("VoiceHookTest.test_dispatch_disabled_hook_skipped", () => {
  const { home } = setup();
  const seen: string[] = [];
  const hook: VoiceHook = { name: "recorder", description: "", onEvent: () => { seen.push("hit"); } };
  const r = dispatchVoiceHook(home, { kind: "call_started", callId: "call-1", at: new Date().toISOString() }, { hooks: [hook], config: { version: 1, enabled: true, hooks: { recorder: false } } });
  expect(r.delivered).toEqual([]);
  expect(seen).toEqual([]);
  const r2 = dispatchVoiceHook(home, { kind: "call_started", callId: "call-1", at: new Date().toISOString() }, { hooks: [hook], config: { version: 1, enabled: false, hooks: {} } });
  expect(r2.delivered).toEqual([]);
});

test("VoiceHookTest.test_dispatch_hook_error_does_not_break_call", () => {
  const { home } = setup();
  const seen: string[] = [];
  const bad: VoiceHook = { name: "bad", description: "", onEvent: () => { throw new Error("钩子炸了"); } };
  const good: VoiceHook = { name: "good", description: "", onEvent: () => { seen.push("good"); } };
  const reported: string[] = [];
  const r = dispatchVoiceHook(home, { kind: "call_ended", callId: "call-1", at: new Date().toISOString() }, {
    hooks: [bad, good],
    reportFailure: (f) => { reported.push(`${f.hook}:${f.kind}`); },
  });
  expect(r.delivered).toEqual(["good"]);
  expect(r.failed.length).toBe(1);
  expect(r.failed[0].hook).toBe("bad");
  expect(r.failed[0].error).toContain("钩子炸了");
  expect(reported).toEqual(["bad:call_ended"]);
  expect(seen).toEqual(["good"]); // 坏钩子没拦住好钩子
  const long = dispatchVoiceHook(home, { kind: "call_ended", callId: "call-1", at: new Date().toISOString() }, {
    hooks: [{ name: "noisy", description: "", onEvent: () => { throw new Error("x".repeat(500)); } }],
  });
  expect(long.failed[0].error.length).toBeLessThanOrEqual(200);
});

test("VoiceHookTest.test_lifecycle_hooks_fire_in_order", async () => {
  const { home, workdir } = setup();
  clearVoiceHooks();
  const { hook, seen } = recorder();
  registerVoiceHook(hook);
  try {
    const call = await startVoiceCall(home, {});
    answerVoiceCall(home, call.id);
    const audio = writeAudio(workdir, "sil.wav", silenceWav(1));
    await feedCallSegment({
      home, workdir, callId: call.id, audioPath: audio, config: {},
      voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null },
      callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: ENDPOINT,
      runCommand: fakeWhisperRunner(),
    });
    endVoiceCall(home, call.id);
    expect(seen.map((e) => e.kind)).toEqual([
      "call_started", "call_answered", "segment_skipped_silence", "call_ended",
    ]);
    expect(seen[0].transport).toBe("loopback");
    expect(seen[2].vad).toBe("silence");
    expect(seen[3].segments).toBe(1);
    // 钩子收到的事件里没有转写原文。
    for (const e of seen) expect("transcript" in e).toBe(false);
  } finally {
    clearVoiceHooks();
  }
});

test("VoiceHookTest.test_transcribed_blocked_confirmed_hooks", async () => {
  const { home, workdir } = setup();
  clearVoiceHooks();
  const { hook, seen } = recorder();
  registerVoiceHook(hook);
  try {
    const id = await activeCall(home);
    const audio = writeAudio(workdir, "hi.wav", sineWav(1));
    const r1 = await feedCallSegment({
      home, workdir, callId: id, audioPath: audio, config: {},
      voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: fakeModelPath() },
      callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: ENDPOINT,
      runCommand: fakeWhisperRunner("你好"),
    });
    expect(r1.segment.status).toBe("transcribed");
    const pay = writeAudio(workdir, "pay.wav", sineWav(1));
    const r2 = await feedCallSegment({
      home, workdir, callId: id, audioPath: pay, config: {},
      voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: fakeModelPath() },
      callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: ENDPOINT,
      runCommand: fakeWhisperRunner("帮我转账 500 给张三"),
    });
    expect(r2.held).toBe(true);
    confirmCallSegment(home, id, r2.segment.id);
    const kinds = seen.map((e) => e.kind);
    expect(kinds).toContain("segment_transcribed");
    expect(kinds).toContain("segment_blocked");
    expect(kinds).toContain("segment_confirmed");
    const transcribed = seen.find((e) => e.kind === "segment_transcribed")!;
    expect(transcribed.realtimeProvider).toBe("local");
    expect(transcribed.textHash).toBeTruthy();
    const blocked = seen.find((e) => e.kind === "segment_blocked")!;
    expect(blocked.reason).toBe("payment");
  } finally {
    clearVoiceHooks();
  }
});

test("VoiceHookTest.test_hook_failure_written_to_audit_and_events", async () => {
  const { home, workdir } = setup();
  clearVoiceHooks();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("通话任务", "sess-1", home, "auto", 10);
  registerVoiceHook({ name: "boom", description: "", onEvent: () => { throw new Error("boom"); } });
  try {
    const call = await startVoiceCall(home, { runId: state.run_id });
    answerVoiceCall(home, call.id);
    const audio = writeAudio(workdir, "sil.wav", silenceWav(1));
    await feedCallSegment({
      home, workdir, callId: call.id, audioPath: audio, config: {},
      voiceCfg: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: null },
      callCfg: DEFAULT_VOICE_CALL_CONFIG, endpoint: ENDPOINT,
      runCommand: fakeWhisperRunner(),
    });
    const audit = readFileSync(join(home, "voice-call-audit.jsonl"), "utf-8");
    expect(audit).toContain("\"op\":\"hook_failed\"");
    expect(audit).toContain("\"hook\":\"boom\"");
    const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
    expect(events).toContain("voice_call_hook_failed");
    // 钩子炸了，通话本身没受影响：段落照常记、通话能挂断。
    const ended = endVoiceCall(home, call.id);
    expect(ended.status).toBe("ended");
  } finally {
    clearVoiceHooks();
  }
});

test("VoiceHookTest.test_call_notes_add_list_and_limits", async () => {
  const { home } = setup();
  const call = await startVoiceCall(home, {});
  const n1 = addCallNote(home, call.id, "对方要一份报价单");
  expect(n1.text).toBe("对方要一份报价单");
  expect(n1.id.startsWith("note-")).toBe(true);
  const n2 = addCallNote(home, call.id, "  下周三再打  ");
  expect(n2.text).toBe("下周三再打");
  const notes = listCallNotes(home, call.id);
  expect(notes.map((n) => n.text)).toEqual(["对方要一份报价单", "下周三再打"]);
  expect(() => addCallNote(home, call.id, "   ")).toThrow("笔记不能为空");
  expect(() => addCallNote(home, call.id, "x".repeat(501))).toThrow("最多 500 字");
  expect(() => addCallNote(home, "call-nope", "hi")).toThrow("找不到通话");
  expect(listCallNotes(home, call.id).length).toBe(2);
});

test("VoiceHookTest.test_call_note_audit_and_event", async () => {
  const { home } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("通话任务", "sess-1", home, "auto", 10);
  const call = await startVoiceCall(home, { runId: state.run_id });
  addCallNote(home, call.id, "对方要一份报价单");
  const audit = readFileSync(join(home, "voice-call-audit.jsonl"), "utf-8");
  expect(audit).toContain("\"op\":\"noted\"");
  expect(audit).not.toContain("对方要一份报价单"); // 审计只记字数，不记正文
  const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  expect(events).toContain("voice_call_noted");
});

test("VoiceHookTest.test_cli_note_notes_hooks", async () => {
  const { home } = setup();
  clearVoiceHooks();
  const call = await startVoiceCall(home, {});
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err.push(s); return true; }) as typeof process.stderr.write;
  try {
    expect(await handleVoiceCall(["note", call.id, "对方", "要报价单"], home)).toBe(0);
    expect(await handleVoiceCall(["notes", call.id], home)).toBe(0);
    expect(await handleVoiceCall(["note", call.id], home)).toBe(2);
    expect(await handleVoiceCall(["hooks", "list"], home)).toBe(0);
    expect(await handleVoiceCall(["hooks", "enable", "recorder"], home)).toBe(0);
    expect(await handleVoiceCall(["hooks", "disable", "recorder"], home)).toBe(0);
    expect(await handleVoiceCall(["hooks", "off"], home)).toBe(0);
    expect(await handleVoiceCall(["hooks", "on"], home)).toBe(0);
    expect(await handleVoiceCall(["hooks", "bogus"], home)).toBe(2);
    expect(await handleVoiceCall(["hooks", "enable"], home)).toBe(2);
    expect(await handleVoiceCall(["nonsense"], home)).toBe(2);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    clearVoiceHooks();
  }
  const text = out.join("");
  expect(text).toContain("已记到通话");
  expect(text).toContain("对方 要报价单");
  expect(text).toContain("通话钩子总开关");
  expect(text).toContain("钩子 recorder 已启用");
  expect(text).toContain("钩子 recorder 已停用");
  expect(listCallNotes(home, call.id).length).toBe(1);
  expect(isVoiceHookEnabled(home, "recorder")).toBe(false);
  expect(readVoiceHookConfig(home).enabled).toBe(true);
});

test("VoiceHookTest.test_events_registered", async () => {
  const { home } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("通话任务", "sess-1", home, "auto", 10);
  const call = await startVoiceCall(home, { runId: state.run_id });
  addCallNote(home, call.id, "记一笔");
  const events = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  expect(events).toContain("voice_call_noted");
  // 未知事件会被拒绝（EVENT_FIELDS 有白名单）：下面这行若事件没注册会抛错，
  // 能走到这里且 voice_call_hook_failed 可记，说明两处都注册了。
  store.appendEvent(state.run_id, "voice_call_hook_failed", { call_id: call.id, hook: "x", kind: "call_started", error: "boom" });
  const events2 = readFileSync(join(home, "runs", state.run_id, "events.jsonl"), "utf-8");
  expect(events2).toContain("voice_call_hook_failed");
});
