// src/voiceHooks.ts — G-P1-36 第二批：实时语音通话的钩子层。
//
// 第 1 批 G-P1-36 已把“实时语音模型插件层”做成 provider 接口
//（src/realtimeVoice.ts：换服务商只换 voice.realtime_provider，通话
// 逻辑不用动）。本批补的是另一半：通话进行时，插件能插进来——
// 通话生命周期事件（开始/接听/拒绝/挂断/转写/静音跳过/扣下/确认/回读）
// 发生时，调用已注册的钩子。钩子只读通话元数据（通话 id、段落 id、VAD
// 结论、字数、引擎、花费、文本指纹），永远拿不到转写原文与音频；
// 钩子必须是同步的（onEvent 返回 void），想做异步活自己排队，通话不等它。
//
// fail-closed：钩子抛错只记账本与事件，通话继续；钩子挂掉不影响本次
// 通话的任何一步。钩子注册表是进程内的（Map），开关配置才落盘。
//
// 叶模块：只引 node 内置，不引 voiceCall.ts（voiceCall.ts 静态 import
// 本文件；值 import 会成环，类型也不需要——事件 payload 自成一体）。

import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export class VoiceHookError extends Error {}

/** 钩子能收到的事件种类（与 runs.ts 里已有的 voice_call_* 事件一一对应）。 */
export const VOICE_HOOK_KINDS = [
  "call_started",
  "call_answered",
  "call_declined",
  "call_ended",
  "segment_transcribed",
  "segment_skipped_silence",
  "segment_blocked",
  "segment_confirmed",
  "reply_spoken",
] as const;
export type VoiceHookKind = (typeof VOICE_HOOK_KINDS)[number];

/**
 * 钩子收到的一次事件：只含元数据与指纹，不含转写原文、不含回读原文、
 * 不含音频路径。钩子凭这些字段决定做什么，不能凭原文做决定——
 * 原文根本不在事件里。
 */
export interface VoiceHookEvent {
  kind: VoiceHookKind;
  callId: string;
  at: string;
  /** 段落 id（段落类事件才有）。 */
  segmentId?: string;
  agent?: string;
  peer?: string | null;
  transport?: "loopback" | "webrtc";
  vad?: "speech" | "silence" | "skipped";
  seconds?: number | null;
  chars?: number;
  engine?: string | null;
  costUsd?: number | null;
  /** 转写文本 SHA-256 前 12 位（段落类事件才有）。 */
  textHash?: string | null;
  /** 扣下原因：payment / external_send（segment_blocked / segment_confirmed 才有）。 */
  reason?: "payment" | "external_send";
  /** 挂断时的汇总（call_ended 才有）。 */
  durationSeconds?: number;
  segments?: number;
  sttSeconds?: number;
  ttsChars?: number;
  held?: number;
  /** 这次转写走的实时语音服务商（segment_transcribed 才有）。 */
  realtimeProvider?: string;
  /** 回读字数（reply_spoken 才有）。 */
  replyChars?: number;
}

/** 一个钩子：名字 + 一句话说明 + 同步回调。回调抛错会被接住，不破坏通话。 */
export interface VoiceHook {
  readonly name: string;
  readonly description: string;
  onEvent(event: VoiceHookEvent): void;
}

export const VOICE_HOOK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function checkHookName(name: string): void {
  if (!VOICE_HOOK_NAME_RE.test(name)) {
    throw new VoiceHookError(`钩子名无效：${name}（只允许小写字母、数字、- 和 _，以字母开头）`);
  }
}

// ---- 进程内注册表 ----

const hooks = new Map<string, VoiceHook>();

/** 注册一个钩子；同名已注册直接报错（不静默覆盖——顶替别人家的钩子该显式先注销）。 */
export function registerVoiceHook(hook: VoiceHook): void {
  checkHookName(hook.name);
  if (hooks.has(hook.name)) throw new VoiceHookError(`钩子 ${hook.name} 已注册，先注销再注册`);
  if (typeof hook.onEvent !== "function") throw new VoiceHookError(`钩子 ${hook.name} 没有 onEvent 回调`);
  hooks.set(hook.name, hook);
}

/** 注销一个钩子；没注册返回 false。 */
export function unregisterVoiceHook(name: string): boolean {
  return hooks.delete(name);
}

/** 已注册的钩子（注册顺序）。 */
export function listVoiceHooks(): VoiceHook[] {
  return [...hooks.values()];
}

/** 清空注册表（测试用；生产代码不要调）。 */
export function clearVoiceHooks(): void {
  hooks.clear();
}

// ---- 开关配置（落盘） ----

export const VOICE_HOOKS_FILE = "voice-hooks.json";

export interface VoiceHookConfig {
  version: 1;
  /** 总开关（默认开）；关了所有钩子都不跑。 */
  enabled: boolean;
  /** 按名开关（没写 = 开）。 */
  hooks: Record<string, boolean>;
}

export const DEFAULT_VOICE_HOOK_CONFIG: VoiceHookConfig = {
  version: 1,
  enabled: true,
  hooks: {},
};

export function voiceHooksPath(home: string): string {
  return join(home, VOICE_HOOKS_FILE);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

/** 读开关配置：不存在回默认；损坏先备份再回默认（不抛错、不挡通话）。 */
export function readVoiceHookConfig(home: string): VoiceHookConfig {
  const path = voiceHooksPath(home);
  if (!existsSync(path)) return { ...DEFAULT_VOICE_HOOK_CONFIG, hooks: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    return { ...DEFAULT_VOICE_HOOK_CONFIG, hooks: {} };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VOICE_HOOK_CONFIG, hooks: {} };
  const o = raw as Record<string, unknown>;
  const hooksOut: Record<string, boolean> = {};
  if (o.hooks && typeof o.hooks === "object") {
    for (const [k, v] of Object.entries(o.hooks as Record<string, unknown>)) {
      if (typeof v === "boolean") hooksOut[k] = v;
    }
  }
  return {
    version: 1,
    enabled: o.enabled === false ? false : true,
    hooks: hooksOut,
  };
}

/** 写开关配置：0600 原子写（先写临时文件再改名）。 */
export function saveVoiceHookConfig(home: string, config: VoiceHookConfig): void {
  const path = voiceHooksPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new VoiceHookError("钩子开关配置不能是符号链接");
  }
  const tmp = join(dirname(path), `.voice-hooks-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ version: 1, enabled: config.enabled, hooks: config.hooks }, null, 2), null, "utf-8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** 某个钩子现在跑不跑（总开关关了全不跑；按名关了只关这一个）。 */
export function isVoiceHookEnabled(home: string, name: string, config?: VoiceHookConfig): boolean {
  const cfg = config ?? readVoiceHookConfig(home);
  if (!cfg.enabled) return false;
  return cfg.hooks[name] !== false;
}

/** 改一个钩子的开关（写盘）。 */
export function setVoiceHookEnabled(home: string, name: string, enabled: boolean): VoiceHookConfig {
  checkHookName(name);
  const cfg = readVoiceHookConfig(home);
  cfg.hooks[name] = enabled;
  saveVoiceHookConfig(home, cfg);
  return cfg;
}

/** 改总开关（写盘）。 */
export function setVoiceHooksMasterEnabled(home: string, enabled: boolean): VoiceHookConfig {
  const cfg = readVoiceHookConfig(home);
  cfg.enabled = enabled;
  saveVoiceHookConfig(home, cfg);
  return cfg;
}

// ---- 分发 ----

export interface VoiceHookFailure {
  hook: string;
  kind: VoiceHookKind;
  /** 报错信息（截断到 200 字，不把整条堆栈带进账本）。 */
  error: string;
}

export interface VoiceHookDispatchResult {
  delivered: string[];
  failed: VoiceHookFailure[];
}

export interface VoiceHookDispatchOptions {
  /** 测试注入：不用进程内注册表，改用这批钩子。 */
  hooks?: VoiceHook[];
  /** 测试注入：不用读盘配置，改用这份。 */
  config?: VoiceHookConfig;
  /**
   * 钩子失败时的上报回调（调用方给：voiceCall.ts 传一个把失败写进
   * 通话审计与运行事件的闭包；不给 = 只记进返回结果，不落盘）。
   */
  reportFailure?: (failure: VoiceHookFailure) => void;
}

/**
 * 分发一次钩子事件：按注册顺序逐个调 onEvent。
 * 钩子抛错只记进结果与上报回调，绝不抛到调用方——通话流程不被钩子拖垮。
 * 返回送达与失败的钩子名；配置读失败时按默认（全开）处理，不挡分发。
 */
export function dispatchVoiceHook(
  home: string,
  event: VoiceHookEvent,
  opts: VoiceHookDispatchOptions = {},
): VoiceHookDispatchResult {
  const result: VoiceHookDispatchResult = { delivered: [], failed: [] };
  let cfg: VoiceHookConfig;
  try {
    cfg = opts.config ?? readVoiceHookConfig(home);
  } catch {
    cfg = { ...DEFAULT_VOICE_HOOK_CONFIG, hooks: {} };
  }
  if (!cfg.enabled) return result;
  const list = opts.hooks ?? listVoiceHooks();
  for (const hook of list) {
    if (cfg.hooks[hook.name] === false) continue;
    try {
      hook.onEvent(event);
      result.delivered.push(hook.name);
    } catch (err: unknown) {
      const failure: VoiceHookFailure = {
        hook: hook.name,
        kind: event.kind,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
      result.failed.push(failure);
      try {
        opts.reportFailure?.(failure);
      } catch { /* 上报失败也不破坏通话 */ }
    }
  }
  return result;
}
