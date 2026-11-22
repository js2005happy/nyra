// tests/node/test-voice-review.test.ts — 第 1 批 G-P2-17：语音输入先审后发。
//
// 转写文字先过 voiceReview 钩子再当任务跑：accept 照发、edit 按改后
// 的文字跑、drop 不发且不烧模型 token；结论进 voice_input_reviewed
// 事件（只记结论与文本指纹）。CLI 侧：--yes 解析与回答映射是纯逻辑，
// 直接验；`nyra voice transcribe` 只转写不跑任务。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { echoProvider } from "./fake-provider.ts";
import {
  DEFAULT_VOICE_CONFIG, handleVoice, loadAudioFile, shortTextHash,
  type CommandRunner, type VoiceAudioInput,
} from "../../src/voice.ts";
import { mapVoiceReviewAnswer, parseArgs } from "../../src/cli.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-vreview-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-vreview-wd-"));
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

function fakeModelPath(): string {
  const p = join(tmpdir(), `nyra-fake-whisper-model-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(p, Buffer.alloc(10));
  return p;
}

function voiceInput(workdir: string, model: string): VoiceAudioInput {
  const p = join(workdir, "in.wav");
  writeFileSync(p, sineWav(1));
  return loadAudioFile("in.wav", workdir, { ...DEFAULT_VOICE_CONFIG, sttLocalModel: model });
}

function reviewAgent(
  home: string,
  workdir: string,
  voiceReview: ((text: string) => Promise<{ decision: "accept" | "edit" | "drop"; text?: string }>) | null,
  provider = echoProvider("收到，已完成。"),
): { agent: Agent; events: Array<{ kind: string; data: Record<string, unknown> }> } {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const model = fakeModelPath();
  const agent = new Agent(provider, {
    workdir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home,
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    voiceInputs: [voiceInput(workdir, model)],
    voiceConfig: { ...DEFAULT_VOICE_CONFIG, sttLocalModel: model },
    voiceRunner: fakeWhisperRunner("帮我写一个 out.txt"),
    voiceReview,
  } as never);
  agent.onEvent = (kind, data) => { events.push({ kind, data }); };
  return { agent, events };
}

test("VoiceReviewTest.test_accept_runs_transcript_as_task", async () => {
  const { home, workdir } = setup();
  const provider = echoProvider("收到，已完成。");
  const { agent, events } = reviewAgent(home, workdir, async () => ({ decision: "accept" }), provider);
  const out = await agent.run("");
  expect(out).toContain("收到，已完成。");
  expect(agent.lastTask).toBe("帮我写一个 out.txt");
  expect(provider.calls).toBeGreaterThan(0);
  const reviewed = events.find((e) => e.kind === "voice_input_reviewed");
  expect(reviewed).toBeDefined();
  expect(reviewed!.data.decision).toBe("accept");
  expect(reviewed!.data.text_hash).toBe(shortTextHash("帮我写一个 out.txt"));
});

test("VoiceReviewTest.test_edit_runs_edited_text", async () => {
  const { home, workdir } = setup();
  const { agent, events } = reviewAgent(home, workdir, async () => ({ decision: "edit", text: "帮我写一个 report.txt" }));
  await agent.run("");
  expect(agent.lastTask).toBe("帮我写一个 report.txt");
  const reviewed = events.find((e) => e.kind === "voice_input_reviewed");
  expect(reviewed!.data.decision).toBe("edit");
  expect(reviewed!.data.text_hash).toBe(shortTextHash("帮我写一个 report.txt"));
});

test("VoiceReviewTest.test_drop_runs_nothing_and_burns_no_model_call", async () => {
  const { home, workdir } = setup();
  const provider = echoProvider("收到，已完成。");
  const { agent, events } = reviewAgent(home, workdir, async () => ({ decision: "drop" }), provider);
  const out = await agent.run("");
  expect(out).toContain("已丢弃");
  expect(provider.calls).toBe(0);
  const reviewed = events.find((e) => e.kind === "voice_input_reviewed");
  expect(reviewed!.data.decision).toBe("drop");
});

test("VoiceReviewTest.test_no_hook_runs_transcript_directly", async () => {
  const { home, workdir } = setup();
  const { agent, events } = reviewAgent(home, workdir, null);
  await agent.run("");
  expect(agent.lastTask).toBe("帮我写一个 out.txt");
  expect(events.some((e) => e.kind === "voice_input_reviewed")).toBe(false);
});

test("VoiceReviewTest.test_map_voice_review_answer", () => {
  expect(mapVoiceReviewAnswer("")).toEqual({ decision: "accept" });
  expect(mapVoiceReviewAnswer("   ")).toEqual({ decision: "accept" });
  expect(mapVoiceReviewAnswer("drop")).toEqual({ decision: "drop" });
  expect(mapVoiceReviewAnswer("DROP")).toEqual({ decision: "drop" });
  expect(mapVoiceReviewAnswer("  Drop  ")).toEqual({ decision: "drop" });
  expect(mapVoiceReviewAnswer("帮我写 report.txt")).toEqual({ decision: "edit", text: "帮我写 report.txt" });
  expect(mapVoiceReviewAnswer("  前后空格  ")).toEqual({ decision: "edit", text: "前后空格" });
});

test("VoiceReviewTest.test_parse_args_yes_flag", () => {
  expect(parseArgs(["--voice", "a.wav"]).yes).toBe(false);
  expect(parseArgs(["--voice", "a.wav"]).voice).toBe("a.wav");
  expect(parseArgs(["--voice", "a.wav", "--yes"]).yes).toBe(true);
  expect(parseArgs(["--yes", "--voice", "a.wav"]).yes).toBe(true);
});

test("VoiceReviewTest.test_cli_transcribe_only_prints_text", async () => {
  const { home, workdir } = setup();
  const model = fakeModelPath();
  writeFileSync(join(home, "config.json"), JSON.stringify({ voice: { stt_local_model: model } }));
  const audioPath = join(workdir, "in.wav");
  writeFileSync(audioPath, sineWav(1));
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => { out.push(String(a[0])); return true; };
  try {
    const code = await handleVoice(["transcribe", audioPath], home, { runCommand: fakeWhisperRunner("只转写不跑任务") });
    expect(code).toBe(0);
  } finally {
    (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = origOut as (...a: unknown[]) => boolean;
  }
  expect(out.join("")).toContain("只转写不跑任务");
});
