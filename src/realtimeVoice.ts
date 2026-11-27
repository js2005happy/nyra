// src/realtimeVoice.ts — 第 1 批 G-P1-36：实时语音模型插件层。
//
// 通话逻辑（voiceCall.ts 的 feedCallSegment）只认这个接口，不认具体
// 服务：换实时语音服务时只注册一个新 provider、把 config.json 的
// voice.realtime_provider 改成它的名字，不用重接通话逻辑。
//
// 内置只有一个 local：走现有 transcribeAudio（whisper.cpp 优先、云端
// 兜底；选中一路失败直接报错，不静默换路）。没有编一个不存在的服务商——
// OpenAI Live 这类咱们没有的服务不在注册表里，谁要接谁注册（见下）。
//
// 云端开关不归这里管：调用方（feedCallSegment）按通话配置决定给不给
// endpoint——没开 call_cloud_enabled 时传 null，provider
// 只能走本地，绝不悄悄花云端钱。
//
// 配置：config.json 的 voice.realtime_provider（字符串，默认 "local"）。
// 名字没注册时 resolveRealtimeVoiceProvider 直接抛错，不静默回退 local
//（配错了就该立刻知道，而不是转写走了另一路还以为是配的那路）。

import { transcribeAudio, type CommandRunner, type HttpEndpoint, type VoiceAudioInput, type VoiceConfig } from "./voice.ts";

/** 传给 provider 的一次转写请求。 */
export interface RealtimeVoiceInput {
  /** 已读好的音频（loadAudioFile 的返回值，原样透传）。 */
  audio: VoiceAudioInput;
  /** 调用方解析好的语音配置。 */
  config: VoiceConfig;
  /** 云端路的 HTTP 端点（null = 没有云端路，provider 只能走本地）。 */
  endpoint: HttpEndpoint | null;
  /** 测试注入的命令执行器 / fetch（不给就用默认）。 */
  runCommand?: CommandRunner;
  fetchFn?: typeof fetch;
}

/** provider 的一次转写结果（与 transcribeAudio 的 Transcription 同款）。 */
export interface RealtimeVoiceResult {
  text: string;
  /** 引擎名（进账本与事件，如 "whisper.cpp"、"cloud:whisper-1"）。 */
  engine: string;
  /** 本段转写时长（秒），用于计价；不知道传 null。 */
  seconds: number | null;
}

/**
 * 实时语音服务商接口：只做一件事——把一段音频转成文字。
 *
 * 接新服务商的办法：在自己的模块里实现这个接口，调
 * registerRealtimeVoiceProvider 注册，再把 voice.realtime_provider
 * 改成它的名字。注册表是进程内的（Map），不落盘、不记配置以外的状态。
 */
export interface RealtimeVoiceProvider {
  /** 注册表里的名字，如 "local"。 */
  readonly name: string;
  /** 一句话说明（`nyra voice realtime status` 用）。 */
  readonly description: string;
  transcribe(input: RealtimeVoiceInput): Promise<RealtimeVoiceResult>;
}

const providers = new Map<string, RealtimeVoiceProvider>();

/** 注册一个实时语音服务商（同名会覆盖——后注册的赢，测试可替换 local）。 */
export function registerRealtimeVoiceProvider(provider: RealtimeVoiceProvider): void {
  providers.set(provider.name, provider);
}

/** 已注册的服务商（注册顺序）。 */
export function listRealtimeVoiceProviders(): RealtimeVoiceProvider[] {
  return [...providers.values()];
}

/** 按名取服务商；没注册返回 null（不抛错，调用方决定怎么办）。 */
export function getRealtimeVoiceProvider(name: string): RealtimeVoiceProvider | null {
  return providers.get(name) ?? null;
}

/** 内置 local：走现有 transcribeAudio（whisper.cpp 优先、云端兜底）。 */
export const localRealtimeVoiceProvider: RealtimeVoiceProvider = {
  name: "local",
  description: "本地转写（whisper.cpp 优先，云端兜底；选中一路失败直接报错，不静默换路）",
  async transcribe(input: RealtimeVoiceInput): Promise<RealtimeVoiceResult> {
    return transcribeAudio({
      input: input.audio,
      config: input.config,
      endpoint: input.endpoint,
      runCommand: input.runCommand,
      fetchFn: input.fetchFn,
    });
  },
};

registerRealtimeVoiceProvider(localRealtimeVoiceProvider);

/** config.json 里配的实时语音服务商名（voice.realtime_provider，默认 "local"）。 */
export function resolveRealtimeVoiceProviderName(config: Record<string, unknown>): string {
  const raw = config.voice;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = typeof o.realtime_provider === "string" ? o.realtime_provider.trim() : "";
  return name || "local";
}

/**
 * 按配置取服务商；名字没注册直接抛错（不静默回退 local——配错了就该
 * 立刻知道，而不是转写走了另一路还以为是配的那路）。
 */
export function resolveRealtimeVoiceProvider(config: Record<string, unknown>): RealtimeVoiceProvider {
  const name = resolveRealtimeVoiceProviderName(config);
  const provider = getRealtimeVoiceProvider(name);
  if (!provider) {
    throw new Error(`实时语音服务 ${name} 没注册（已注册：${listRealtimeVoiceProviders().map((p) => p.name).join("、") || "无"}）；把 config.json 的 voice.realtime_provider 改成已注册的名字`);
  }
  return provider;
}
