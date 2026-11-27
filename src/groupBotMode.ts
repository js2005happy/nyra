// src/groupBotMode.ts — Bot Mode 开关（Hermes 缺口 7，Cue B 批）。
//
// Hermes 的开关在“能力 → 插件 → 机器人”里，默认开启；Nyra 对应的是群聊
// 会话的启用/停用配置：CLI（nyra group bot-mode）与手机端（设置页开关）
// 共用这一个文件。默认开（与 Hermes 一致）；关了群聊会话不跑 Bot 轮次
// （runSessionRound 与 GroupStore.send 入口都拦），已建的会话与房间保留。
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";

export const BOT_MODE_FILE = "group-bot-mode.json";
/** 关了以后各入口统一报这句（不编原因、不假装还在跑）。 */
export const BOT_MODE_OFF_MESSAGE = "Bot Mode 已关闭：群聊不跑 Bot 轮次（nyra group bot-mode on 重新打开，或在手机设置页打开）";

export interface BotModeState {
  version: 1;
  enabled: boolean;
  updatedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 原子写 0600：先写同目录临时文件再 rename；旧文件是符号链接就拒绝（与 budget.ts 同款写法）。 */
function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${file} 不能是符号链接`);
  }
  const tmp = join(dirname(path), `.${file}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * 读开关。文件不存在、读不出、格式不对都按默认开（fail-open：一个坏掉的
 * 配置文件不应该把群聊整个关掉；想关必须显式写 enabled: false）。
 */
export function loadBotMode(home: string): BotModeState {
  try {
    const raw = JSON.parse(readFileSync(join(resolveHome(home), BOT_MODE_FILE), "utf-8")) as unknown;
    if (isRecord(raw) && typeof raw.enabled === "boolean") {
      return { version: 1, enabled: raw.enabled, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso() };
    }
  } catch { /* 缺文件或坏文件都按默认开 */ }
  return { version: 1, enabled: true, updatedAt: nowIso() };
}

export function isBotModeEnabled(home: string): boolean {
  return loadBotMode(home).enabled;
}

/** 写开关（落盘，CLI 与手机端共用）。 */
export function setBotMode(home: string, enabled: boolean): BotModeState {
  const state: BotModeState = { version: 1, enabled, updatedAt: nowIso() };
  saveJsonAtomic(home, BOT_MODE_FILE, state);
  return state;
}
