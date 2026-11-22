// src/voice.ts — 缺口 15：语音协调者（Puck 式语音通话指挥 agent）。
//
// 先做“语音指挥”而不是“语音聊天”：说一句话，agent 听懂了去干活、干完回文字
// 汇报。语音指令同样进证据链（说了什么、agent 理解成什么、干了什么）；语音
// 不碰支付与对外发送（须回文字确认），权限边界比别家更严。
//
// 结构与缺口 16 的 src/vision.ts 同款：
//   - 音频只认 magic bytes（不信扩展名），超限直接拒绝；
//   - 转写优先本地 whisper.cpp（本机有 + 配了模型文件才用），没有则走已配好的
//     云端 STT（OpenAI 兼容的 /audio/transcriptions，不新引模型厂商）；
//   - 转写失败直接报错，不静默降级、不悄悄换另一路重转（那会多花一份云端钱）；
//   - 音频内容绝不进事件与日志，只记时长、字数、引擎、花费与文本指纹。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { loadConfig, saveConfig, resolveProvider } from "./config.ts";
import { Provider } from "./providers.ts";
import type { ProviderLike } from "./providers.ts";
import { formatBytes } from "./bot/attachments.ts";
import { getRealtimeVoiceProvider, listRealtimeVoiceProviders, resolveRealtimeVoiceProviderName } from "./realtimeVoice.ts";

/** 缺口 15：语音的配置（config.json 的 voice 一节，未配用默认值）。 */
export interface VoiceConfig {
  /** 单个音频文件上限（字节），默认 25MB。 */
  maxBytes: number;
  /** 单段语音最长（秒），默认 600（10 分钟）；超长直接拒绝。 */
  maxSeconds: number;
  /** 云端 STT 用的模型名，默认 whisper-1。 */
  sttModel: string;
  /** 云端 TTS 用的模型名，默认 tts-1。 */
  ttsModel: string;
  /** 云端 TTS 用的声音，默认 alloy。 */
  ttsVoice: string;
  /** 任务跑完后是否自动把结果读出来，默认关（显式 opt-in）。 */
  ttsEnabled: boolean;
  /** 本地 whisper.cpp 的二进制名/路径，null = 自动找 whisper-cli 再找 whisper。 */
  sttLocalBinary: string | null;
  /** 本地 whisper.cpp 的模型文件路径，null = 不用本地路（直接走云端）。 */
  sttLocalModel: string | null;
  /** 本地 whisper 的转写语言，默认 auto（自动识别）。 */
  sttLanguage: string;
  /** 回读播完用的播放器（如 mpv/ffplay/aplay），null = 只保存文件、不播放。 */
  ttsPlayer: string | null;
  /** 云端 STT 单价（美元/分钟），null = 未计价（不编数字，花费记 null）。 */
  sttPricePerMinUsd: number | null;
  /** 云端 TTS 单价（美元/千字符），null = 未计价。 */
  ttsPricePer1kCharsUsd: number | null;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 600,
  sttModel: "whisper-1",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
  ttsEnabled: false,
  sttLocalBinary: null,
  sttLocalModel: null,
  sttLanguage: "auto",
  ttsPlayer: null,
  sttPricePerMinUsd: null,
  ttsPricePer1kCharsUsd: null,
};

/** 接受的音频扩展名（小写，不含点）。 */
export const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "ogg", "flac", "webm"];

/** 音频种类（按文件头识别，不看扩展名）。 */
export type AudioKind = "wav" | "mp3" | "m4a" | "ogg" | "flac" | "webm";

const AUDIO_MIME: Record<AudioKind, string> = {
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4",
  ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm",
};

/** 语音配置的解析：数字不合法（非正数/超范围）时回退默认值，不抛错、不挡运行。 */
export function resolveVoiceConfig(config: Record<string, unknown>): VoiceConfig {
  const raw = config.voice;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (key: string, min: number, max: number, fallback: number): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return fallback;
    return v;
  };
  const str = (key: string, fallback: string): string => {
    const v = o[key];
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  };
  const nullableStr = (key: string): string | null => {
    const v = o[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const price = (key: string): number | null => {
    const v = o[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  };
  return {
    maxBytes: num("max_bytes", 1024, 200 * 1024 * 1024, DEFAULT_VOICE_CONFIG.maxBytes),
    maxSeconds: num("max_seconds", 1, 3600, DEFAULT_VOICE_CONFIG.maxSeconds),
    sttModel: str("stt_model", DEFAULT_VOICE_CONFIG.sttModel),
    ttsModel: str("tts_model", DEFAULT_VOICE_CONFIG.ttsModel),
    ttsVoice: str("tts_voice", DEFAULT_VOICE_CONFIG.ttsVoice),
    ttsEnabled: o.tts_enabled === true,
    sttLocalBinary: nullableStr("stt_local_binary"),
    sttLocalModel: nullableStr("stt_local_model"),
    sttLanguage: str("stt_language", DEFAULT_VOICE_CONFIG.sttLanguage),
    ttsPlayer: nullableStr("tts_player"),
    sttPricePerMinUsd: price("stt_price_per_min_usd"),
    ttsPricePer1kCharsUsd: price("tts_price_per_1k_chars_usd"),
  };
}

/**
 * 按文件头认音频格式（不信扩展名）：
 * WAV = RIFF....WAVE；MP3 = ID3 或帧同步（0xFF 0xE0-0xFF）；M4A = ftyp；
 * OGG = OggS；FLAC = fLaC；WebM = EBML 头。都不像返回 null。
 */
export function sniffAudioKind(bytes: Buffer): AudioKind | null {
  if (bytes.length < 4) return null;
  const head = bytes.subarray(0, 12);
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (head.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  if (head.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (head.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
  if (head.subarray(4, 8).toString("ascii") === "ftyp") return "m4a";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  return null;
}

/** 一段已备好的语音（字节只用于转写/播放，其余字段只用于审计与说明）。 */
export interface VoiceAudioInput {
  bytes: Buffer;
  kind: AudioKind;
  /** 全文 SHA-256（事件里只取前 12 位，免得被 redact 当长词串掩掉）。 */
  sha256: string;
  /** 来源描述（文件名），只用于给用户看，不进事件。 */
  source: string;
  /** 时长（秒）；ffprobe 读不到时为 null（转写照常跑，花费记 null）。 */
  durationSeconds: number | null;
}

/** 文本 SHA-256 前 12 位指纹（事件与日志里只用这个，不记原文）。 */
export function shortTextHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

/** 外部命令执行器（测试可注入假实现，不依赖本机 whisper/ffprobe）。 */
export type CommandRunner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

function defaultRunner(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 300_000 });
    if (r.error) return { status: null, stdout: "", stderr: String((r.error as Error).message ?? r.error) };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err: unknown) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** ffprobe 读音频时长（秒）；读不到返回 null（调用方不因此报错）。 */
export function probeAudioDuration(audioPath: string, run: CommandRunner = defaultRunner): number | null {
  const r = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath]);
  if (r.status !== 0) return null;
  const n = parseFloat((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 把字节校验成一段可转写的语音：先查大小、再认 magic bytes。
 * 失败抛错（中文说明原因），不静默跳过。
 */
export function prepareAudioInput(
  bytes: Buffer,
  source: string,
  cfg: VoiceConfig,
  durationSeconds: number | null = null,
): VoiceAudioInput {
  if (bytes.length === 0) throw new Error(`音频 ${source} 是空文件，已跳过`);
  if (bytes.length > cfg.maxBytes) {
    throw new Error(`音频 ${source} 太大（${formatBytes(bytes.length)}，超过 ${formatBytes(cfg.maxBytes)} 上限）`);
  }
  const kind = sniffAudioKind(bytes);
  if (!kind) {
    throw new Error(`音频 ${source} 不是支持的格式（只认 WAV/MP3/M4A/OGG/FLAC/WebM，按文件头识别，不看扩展名）`);
  }
  if (durationSeconds !== null && durationSeconds > cfg.maxSeconds) {
    throw new Error(`音频 ${source} 太长（${Math.round(durationSeconds)} 秒，超过 ${cfg.maxSeconds} 秒上限）`);
  }
  return {
    bytes, kind,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source, durationSeconds,
  };
}

/** 读一段本地音频文件（路径相对 workdir 解析）并校验成语音输入；时长用 ffprobe 尽力读，读不到不报错。 */
export function loadAudioFile(path: string, workdir: string, cfg: VoiceConfig, run: CommandRunner = defaultRunner): VoiceAudioInput {
  const abs = resolve(workdir, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`音频不存在：${path}`);
  const bytes = readFileSync(abs);
  const duration = probeAudioDuration(abs, run);
  return prepareAudioInput(bytes, basename(abs), cfg, duration);
}

// ---- 云端 STT / TTS（OpenAI 兼容接口）----

/** 云端音频接口用的端点（主 provider 的 baseUrl + API key）。 */
export interface HttpEndpoint {
  baseUrl: string;
  apiKey: string;
}

/**
 * 从一个 provider 取出云端音频接口的端点：只要 baseUrl 是 http(s) 且 apiKey
 * 是非空字符串。Codex CLI 之类没有 HTTP 端点的 provider 返回 null（调用方
 * 拒绝并指路，不假装能调）。
 */
export function httpEndpointOf(provider: ProviderLike): HttpEndpoint | null {
  const baseUrl = typeof (provider as { baseUrl?: unknown }).baseUrl === "string"
    ? (provider as { baseUrl: string }).baseUrl.replace(/\/+$/, "")
    : "";
  const apiKey = (provider as { apiKey?: unknown }).apiKey;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  if (typeof apiKey !== "string" || !apiKey.trim()) return null;
  return { baseUrl, apiKey };
}

/** 一次转写的结果（text 是任务文本；seconds 为 null = 时长未知，花费记 null）。 */
export interface Transcription {
  text: string;
  seconds: number | null;
  /** 哪个引擎转的：whisper.cpp / cloud:<模型名>。 */
  engine: string;
}

/** 本地 whisper.cpp 是否可用：二进制找得到 + 模型文件配了且存在。模型路径配了但文件不存在是配置错，直接抛错（不悄悄走云端花钱）。 */
export function localSttAvailable(cfg: VoiceConfig, run: CommandRunner = defaultRunner): { binary: string } | null {
  const candidates = cfg.sttLocalBinary ? [cfg.sttLocalBinary] : ["whisper-cli", "whisper"];
  let binary: string | null = null;
  for (const c of candidates) {
    if (run(c, ["--help"]).status !== null) { binary = c; break; }
  }
  if (binary === null) return null;
  if (cfg.sttLocalModel === null) return null;
  if (!existsSync(cfg.sttLocalModel) || !statSync(cfg.sttLocalModel).isFile()) {
    throw new Error(`本地 whisper 模型文件不存在：${cfg.sttLocalModel}（config.json 的 voice.stt_local_model 指错了路，或者改走云端：删掉这一项）`);
  }
  return { binary };
}

/** whisper.cpp 不能直接解的格式（AAC/FLAC/WebM 容器）先经 ffmpeg 转 16k 单声道 wav；ffmpeg 缺失直接报错。 */
const FFMPEG_CONVERT_KINDS: AudioKind[] = ["m4a", "flac", "webm"];

export async function transcribeLocal(
  input: VoiceAudioInput,
  cfg: VoiceConfig,
  binary: string,
  run: CommandRunner,
): Promise<Transcription> {
  const dir = mkdtempSync(join(tmpdir(), "nyra-voice-"));
  try {
    const ext = input.kind === "m4a" ? "m4a" : input.kind;
    const srcPath = join(dir, `input.${ext}`);
    writeFileSync(srcPath, input.bytes, { mode: 0o600 });
    let audioPath = srcPath;
    if (FFMPEG_CONVERT_KINDS.includes(input.kind)) {
      const wavPath = join(dir, "input.wav");
      const conv = run("ffmpeg", ["-y", "-v", "error", "-i", srcPath, "-ar", "16000", "-ac", "1", wavPath]);
      if (conv.status === null) {
        throw new Error(`音频 ${input.source} 是 ${input.kind} 格式，需要 ffmpeg 先转成 wav：本机没有 ffmpeg（装好 ffmpeg 再试，或换 wav/mp3/ogg）`);
      }
      if (conv.status !== 0) {
        throw new Error(`音频 ${input.source} 转 wav 失败（ffmpeg 退出码 ${conv.status}）：${(conv.stderr ?? "").trim().slice(0, 200) || "无报错输出"}`);
      }
      audioPath = wavPath;
    }
    const outBase = join(dir, "out");
    const args = ["-m", cfg.sttLocalModel!, "-f", audioPath, "-l", cfg.sttLanguage, "--output-txt", "--output-file", outBase, "-np", "-nt"];
    const r = run(binary, args);
    if (r.status === null) throw new Error(`本地 whisper 执行失败：找不到 ${binary}`);
    if (r.status !== 0) {
      throw new Error(`本地 whisper 转写失败（退出码 ${r.status}）：${(r.stderr ?? "").trim().slice(0, 200) || "无报错输出"}`);
    }
    const txtPath = `${outBase}.txt`;
    if (!existsSync(txtPath)) throw new Error("本地 whisper 没有产出转写文本（模型或音频可能有问题）");
    const text = readFileSync(txtPath, "utf-8").trim();
    if (!text) throw new Error("转写结果为空（音频里可能没有语音）");
    return { text, seconds: input.durationSeconds, engine: "whisper.cpp" };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 云端 STT：POST {baseUrl}/audio/transcriptions（multipart，file + model）。 */
export async function transcribeCloud(
  input: VoiceAudioInput,
  cfg: VoiceConfig,
  endpoint: HttpEndpoint,
  fetchFn: typeof fetch = fetch,
): Promise<Transcription> {
  const form = new FormData();
  // Buffer 不是 BlobPart：先切出底层的 ArrayBuffer 再包一层 Uint8Array。
  const ab = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer;
  form.append("file", new File([new Uint8Array(ab)], `audio.${input.kind}`, { type: AUDIO_MIME[input.kind] }));
  form.append("model", cfg.sttModel);
  if (cfg.sttLanguage !== "auto") form.append("language", cfg.sttLanguage);
  let resp: Response;
  try {
    resp = await fetchFn(`${endpoint.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      body: form,
    });
  } catch (err: unknown) {
    throw new Error(`云端转写请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`云端转写失败（HTTP ${resp.status}）：${body.slice(0, 200) || "当前 provider 可能不支持语音接口，换一个支持语音的 provider 或装本地 whisper.cpp"}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("云端转写结果为空（音频里可能没有语音）");
  const usage = data.usage as Record<string, unknown> | undefined;
  const seconds = typeof usage?.seconds === "number" && usage.seconds > 0
    ? usage.seconds
    : input.durationSeconds;
  return { text, seconds, engine: `cloud:${cfg.sttModel}` };
}

/** 两条路都不可用时的指路文案（不编“请稍后再试”这种空话）。 */
export function voiceSttUnavailableMessage(): string {
  return "没有可用的转写路：本地 whisper.cpp 没装或没配模型文件，且当前 provider 没有 HTTP 音频接口。两条路任选其一：1）装 whisper.cpp 并在 config.json 的 voice.stt_local_model 里填模型文件路径；2）换一个支持语音接口的 HTTP provider（--provider 指定）并配好 API 密钥。详见 docs/voice.md";
}

/**
 * 转写入口：本地优先（whisper.cpp 可用时）、否则云端；两条都不可用直接报错。
 * 选中的一路失败就直接抛错，不悄悄换另一路重转（那会多花一份云端钱）。
 */
export async function transcribeAudio(opts: {
  input: VoiceAudioInput;
  config: VoiceConfig;
  endpoint: HttpEndpoint | null;
  runCommand?: CommandRunner;
  fetchFn?: typeof fetch;
}): Promise<Transcription> {
  const run = opts.runCommand ?? defaultRunner;
  const local = localSttAvailable(opts.config, run);
  if (local !== null) return transcribeLocal(opts.input, opts.config, local.binary, run);
  if (opts.endpoint !== null) {
    return transcribeCloud(opts.input, opts.config, opts.endpoint, opts.fetchFn);
  }
  throw new Error(voiceSttUnavailableMessage());
}

/** 云端 TTS 的一次合成结果（mp3 字节）。 */
export interface SpeechSynthesis {
  bytes: Buffer;
  chars: number;
  engine: string;
}

/** 云端 TTS：POST {baseUrl}/audio/speech（JSON，response_format mp3）。本地没有可靠的 TTS 引擎，本批只做云端。 */
export async function synthesizeSpeech(
  text: string,
  cfg: VoiceConfig,
  endpoint: HttpEndpoint,
  fetchFn: typeof fetch = fetch,
): Promise<SpeechSynthesis> {
  let resp: Response;
  try {
    resp = await fetchFn(`${endpoint.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.ttsModel, input: text, voice: cfg.ttsVoice, response_format: "mp3" }),
    });
  } catch (err: unknown) {
    throw new Error(`云端合成请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`云端合成失败（HTTP ${resp.status}）：${body.slice(0, 200) || "当前 provider 可能不支持语音接口，换一个支持语音的 provider"}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length === 0) throw new Error("云端合成返回了空音频");
  return { bytes, chars: text.length, engine: `cloud:${cfg.ttsModel}` };
}

/** STT 花费估算（美元）：时长或单价未知时返回 null（不编数字）。 */
export function estimateSttCostUsd(seconds: number | null, cfg: VoiceConfig): number | null {
  if (seconds === null || cfg.sttPricePerMinUsd === null) return null;
  return (seconds / 60) * cfg.sttPricePerMinUsd;
}

/** TTS 花费估算（美元）：单价未知时返回 null。 */
export function estimateTtsCostUsd(chars: number, cfg: VoiceConfig): number | null {
  if (cfg.ttsPricePer1kCharsUsd === null) return null;
  return (chars / 1000) * cfg.ttsPricePer1kCharsUsd;
}

/** 回读用的播放器（config.voice.tts_player）：配了且找得到才播，播失败只警告、不破坏运行。 */
export function playAudioFile(path: string, cfg: VoiceConfig, run: CommandRunner = defaultRunner): void {
  if (!cfg.ttsPlayer) return;
  try {
    const r = run(cfg.ttsPlayer, [path]);
    if (r.status === null) process.stderr.write(`语音回读：找不到播放器 ${cfg.ttsPlayer}，音频已保存：${path}\n`);
    else if (r.status !== 0) process.stderr.write(`语音回读：播放器 ${cfg.ttsPlayer} 退出码 ${r.status}，音频已保存：${path}\n`);
  } catch { /* 播放失败绝不破坏运行 */ }
}

// ---- `nyra voice` 子命令 ----

/** `nyra voice` 的输入注入（测试用：假 fetch / 假命令执行器）。 */
export interface VoiceCliInput {
  fetchFn?: typeof fetch;
  runCommand?: CommandRunner;
}

export async function handleVoice(argv: string[], home: string, input?: VoiceCliInput): Promise<number> {
  const config = loadConfig(home);
  const cfg = resolveVoiceConfig(config);
  const cmd = argv[0];
  if (!cmd || cmd === "status") {
    process.stdout.write(`语音指挥：${cfg.ttsEnabled ? "自动回读已开启" : "自动回读未开启（默认关）"}\n`);
    process.stdout.write(`STT 模型：${cfg.sttModel}；TTS 模型：${cfg.ttsModel}（声音 ${cfg.ttsVoice}）\n`);
    process.stdout.write(`上限：单文件 ${formatBytes(cfg.maxBytes)}、最长 ${cfg.maxSeconds} 秒\n`);
    const local = (() => {
      try { return localSttAvailable(cfg, input?.runCommand); } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })();
    if (local && !("error" in local)) {
      process.stdout.write(`本地 whisper：可用（${local.binary}，模型 ${cfg.sttLocalModel}）\n`);
    } else if (local && "error" in local) {
      process.stdout.write(`本地 whisper：配置有问题：${local.error}\n`);
    } else {
      process.stdout.write("本地 whisper：不可用（没装 whisper.cpp 或没配 voice.stt_local_model，走云端）\n");
    }
    try {
      const primary = resolveProvider({ home, config });
      if (primary.auth === "cli") {
        process.stdout.write(`云端语音：当前 provider ${primary.name} 是 CLI provider，没有 HTTP 音频接口\n`);
      } else if (!primary.apiKey) {
        process.stdout.write(`云端语音：当前 provider ${primary.name} 未配 API 密钥（先配密钥再走云端）\n`);
      } else {
        process.stdout.write(`云端语音：可用（provider ${primary.name}，${primary.baseUrl}）\n`);
      }
    } catch (err: unknown) {
      process.stdout.write(`云端语音：provider 解析失败：${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (!cfg.ttsEnabled) process.stdout.write("开启自动回读：nyra voice enable-tts（每次任务跑完把结果读出来）\n");
    return 0;
  }
  if (cmd === "enable-tts" || cmd === "disable-tts") {
    saveConfig(home, { voice: { ...((config.voice as Record<string, unknown>) ?? {}), tts_enabled: cmd === "enable-tts" } });
    process.stdout.write(`自动回读已${cmd === "enable-tts" ? "开启" : "关闭"}${cmd === "enable-tts" ? "（每次任务跑完把结果前 500 字读出来）" : ""}\n`);
    return 0;
  }
  if (cmd === "speak") {
    const text = argv.slice(1).join(" ").trim();
    if (!text) {
      process.stderr.write("用法：nyra voice speak <要读的文字>\n");
      return 2;
    }
    let primary;
    try {
      primary = resolveProvider({ home, config });
    } catch (err: unknown) {
      process.stderr.write(`语音合成失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    if (primary.auth === "cli") {
      process.stderr.write("语音合成失败：当前 provider 是 CLI provider，没有 HTTP 音频接口；换一个 HTTP provider 再试\n");
      return 1;
    }
    if (!primary.apiKey) {
      process.stderr.write(`语音合成失败：当前 provider ${primary.name} 未配 API 密钥\n`);
      return 1;
    }
    try {
      const provider = new Provider(primary);
      const endpoint = httpEndpointOf(provider);
      if (!endpoint) throw new Error("当前 provider 没有可用的 HTTP 音频接口");
      const out = await synthesizeSpeech(text, cfg, endpoint, input?.fetchFn);
      const cost = estimateTtsCostUsd(out.chars, cfg);
      const dir = join(home, "voice");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = `speak-${new Date().toISOString().replace(/[:.]/g, "-")}.mp3`;
      const path = join(dir, name);
      writeFileSync(path, out.bytes, { mode: 0o600 });
      process.stdout.write(`语音已保存：${path}（${out.chars} 字${cost !== null ? `，花费 $${cost.toFixed(4)}` : "，未计价"}）\n`);
      playAudioFile(path, cfg, input?.runCommand);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`语音合成失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  // 第 1 批 G-P1-36：实时语音服务商管理（只改配置 + 列注册表，不接新服务）。
  if (cmd === "realtime") {
    const sub = argv[1];
    if (sub === "list") {
      const providers = listRealtimeVoiceProviders();
      if (!providers.length) { process.stdout.write("没有已注册的实时语音服务商。\n"); return 0; }
      const current = resolveRealtimeVoiceProviderName(config);
      for (const p of providers) {
        process.stdout.write(`${p.name === current ? "* " : "  "}${p.name}：${p.description}\n`);
      }
      return 0;
    }
    if (sub === "use") {
      const name = argv[2];
      if (!name) { process.stderr.write("用法：nyra voice realtime use <服务商名>\n"); return 2; }
      if (!getRealtimeVoiceProvider(name)) {
        process.stderr.write(`实时语音服务 ${name} 没注册（已注册：${listRealtimeVoiceProviders().map((p) => p.name).join("、") || "无"}）。\n`);
        return 1;
      }
      saveConfig(home, { voice: { ...((config.voice as Record<string, unknown>) ?? {}), realtime_provider: name } });
      process.stdout.write(`实时语音服务已切到 ${name}（通话转写走它；换服务不用重接通话逻辑）。\n`);
      return 0;
    }
    if (sub === "status" || !sub) {
      const current = resolveRealtimeVoiceProviderName(config);
      const provider = getRealtimeVoiceProvider(current);
      process.stdout.write(`实时语音服务：${current}${provider ? `（${provider.description}）` : "（没注册——转写会直接报错，请先切到已注册的服务）"}\n`);
      process.stdout.write(`已注册：${listRealtimeVoiceProviders().map((p) => p.name).join("、") || "无"}\n`);
      return 0;
    }
    process.stderr.write("用法：nyra voice realtime <list|use <服务商名>|status>\n");
    return 2;
  }
  // 第 1 批 G-P2-17：只转写、不跑任务——转写文字先看一眼的独立入口
  //（`nyra voice transcribe <音频路径>`：打出来就完事，不当任务跑）。
  if (cmd === "transcribe") {
    const audioPath = argv[1];
    if (!audioPath) {
      process.stderr.write("用法：nyra voice transcribe <音频路径>\n");
      return 2;
    }
    try {
      const audio = loadAudioFile(audioPath, process.cwd(), cfg);
      let endpoint: HttpEndpoint | null = null;
      try {
        const primary = resolveProvider({ home, config });
        if (primary.auth !== "cli" && primary.apiKey) endpoint = httpEndpointOf(new Provider(primary));
      } catch { endpoint = null; }
      const out = await transcribeAudio({ input: audio, config: cfg, endpoint, runCommand: input?.runCommand, fetchFn: input?.fetchFn });
      process.stdout.write(`${out.text}\n`);
      process.stderr.write(`（转写引擎：${out.engine}；只转写，没跑任务）\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`转写失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  process.stderr.write("用法：nyra voice <status|speak <文字>|enable-tts|disable-tts|realtime <list|use|status>|transcribe <音频路径>>；通话：nyra voice call <start|answer|decline|end|status|list|segment|confirm>\n");
  return 2;
}

/** 测试用：handleVoice 的同款入口。 */
export { handleVoice as handleVoiceCommand };
