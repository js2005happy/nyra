// src/middlewareCli.ts — G-P2-4 类型化中间件链的 CLI：`nyra middleware`。
//
//   status [--json]                    看三层开关、四件内置、审批模式与缓存条数
//   enable <validation|tokens|retry|cache|chat|function|agent> [--yes]
//                                      开一项（重试与缓存默认关，须显式开）
//   disable <同上> [--yes]             关一项
//   set [--retry-max-retries <0-4>] [--retry-initial-ms <0-60000>]
//       [--retry-backoff <1-4>] [--retry-max-ms <100-60000>]
//       [--cache-ttl-seconds <10-86400>] [--cache-max-entries <1-5000>]
//       [--cache-store <memory|file>] [--yes]
//                                      改重试 / 缓存参数（越界值夹到范围内）
//   approval [tool] [--mode require|never_require] [--yes]
//                                      列出或按工具配审批模式；never_require
//                                      只认只读工具，写工具拒绝
//   cache-clear [--yes]                清文件缓存（memory 缓存是进程内的，
//                                      须重启才清）
//
// 写操作一律须 --yes（防手滑），与 subagent preset 的规矩同款。
// 只改 ~/.nyra/middleware.json（0600），不改运行态、不碰审批门本身。
import { resolveHome } from "./config.ts";
import { READONLY_TOOLS } from "./tools.ts";
import {
  FunctionResultCache,
  MiddlewareError,
  loadMiddlewareConfig,
  middlewareCachePath,
  saveMiddlewareConfig,
  validateApprovalModes,
  type ApprovalMode,
  type MiddlewareConfig,
  type MiddlewareLayer,
} from "./middleware.ts";
import { existsSync, rmSync } from "node:fs";

const USAGE = [
  "用法：",
  "  nyra middleware status [--json]   看三层开关、四件内置、审批模式与缓存条数",
  "  nyra middleware enable <validation|tokens|retry|cache|chat|function|agent> [--yes]   开一项（重试与缓存默认关，须显式开）",
  "  nyra middleware disable <validation|tokens|retry|cache|chat|function|agent> [--yes]   关一项",
  "  nyra middleware set [--retry-max-retries <0-4>] [--retry-initial-ms <0-60000>] [--retry-backoff <1-4>] [--retry-max-ms <100-60000>] [--cache-ttl-seconds <10-86400>] [--cache-max-entries <1-5000>] [--cache-store <memory|file>] [--yes]   改重试 / 缓存参数",
  "  nyra middleware approval [tool] [--mode require|never_require] [--yes]   列出或按工具配审批模式（never_require 只认只读工具）",
  "  nyra middleware cache-clear [--yes]   清文件缓存（memory 缓存是进程内的，须重启）",
  "说明：类型化中间件链（G-P2-4）：chat / function / agent 三层可组合链，内置校验、重试、缓存、token 计数；默认只开校验与 token 计数，重试与缓存默认关；审批模式默认 require，never_require 只对只读工具可配；缓存绝不缓存写操作结果与含密钥的调用，详见 docs/middleware.md。",
].join("\n");

type ToggleTarget = "validation" | "tokens" | "retry" | "cache" | MiddlewareLayer;

const TOGGLE_TARGETS: ToggleTarget[] = ["validation", "tokens", "retry", "cache", "chat", "function", "agent"];

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function flagInt(argv: string[], flag: string): number | null {
  const raw = flagValue(argv, flag);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new MiddlewareError(`${flag} 须是整数：${raw}`);
  return n;
}

function applyToggle(cfg: MiddlewareConfig, target: ToggleTarget, on: boolean): void {
  switch (target) {
    case "validation": cfg.validation.enabled = on; break;
    case "tokens": cfg.tokens.enabled = on; break;
    case "retry": cfg.retry.enabled = on; break;
    case "cache": cfg.cache.enabled = on; break;
    case "chat": cfg.layers.chat = on; break;
    case "function": cfg.layers.function = on; break;
    case "agent": cfg.layers.agent = on; break;
  }
}

function cacheEntryCount(home: string, cfg: MiddlewareConfig): number {
  if (cfg.cache.store !== "file") return -1;
  const path = middlewareCachePath(home);
  if (!existsSync(path)) return 0;
  try {
    const probe = new FunctionResultCache({ ttlMs: cfg.cache.ttlSeconds * 1000, maxEntries: cfg.cache.maxEntries, store: "file", home });
    return probe.size();
  } catch {
    return -1;
  }
}

function statusObject(home: string, cfg: MiddlewareConfig): Record<string, unknown> {
  return {
    layers: cfg.layers,
    validation: cfg.validation,
    tokens: cfg.tokens,
    retry: cfg.retry,
    cache: cfg.cache,
    approvalModes: cfg.approvalModes,
    cacheEntries: cacheEntryCount(home, cfg),
  };
}

function printStatus(home: string, cfg: MiddlewareConfig, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(statusObject(home, cfg), null, 2) + "\n");
    return;
  }
  const lines: string[] = [];
  lines.push("中间件链（三层）：");
  for (const layer of ["chat", "function", "agent"] as const) {
    lines.push(`  ${layer}：${cfg.layers[layer] ? "开" : "关"}`);
  }
  lines.push("内置：");
  lines.push(`  校验：${cfg.validation.enabled ? "开" : "关"}`);
  lines.push(`  token 计数：${cfg.tokens.enabled ? "开" : "关"}`);
  lines.push(`  重试：${cfg.retry.enabled ? "开" : "关"}（最多 ${cfg.retry.maxRetries} 次，基础 ${cfg.retry.initialIntervalMs}ms，倍数 ${cfg.retry.backoffFactor}，上限 ${cfg.retry.maxIntervalMs}ms）`);
  lines.push(`  缓存：${cfg.cache.enabled ? "开" : "关"}（${cfg.cache.store}，TTL ${cfg.cache.ttlSeconds} 秒，最多 ${cfg.cache.maxEntries} 条）`);
  const entries = cacheEntryCount(home, cfg);
  if (entries >= 0) lines.push(`  文件缓存条数：${entries}`);
  const modes = Object.entries(cfg.approvalModes);
  lines.push(`审批模式（非默认）：${modes.length ? modes.map(([t, m]) => `${t}=${m}`).join("、") : "无"}`);
  process.stdout.write(lines.join("\n") + "\n");
}

export async function handleMiddleware(argv: string[], homeOverride?: string): Promise<number> {
  const home = homeOverride || resolveHome();
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (sub === "status") {
    const { config, errors } = loadMiddlewareConfig(home);
    for (const e of errors) process.stderr.write(`警告：${e}\n`);
    printStatus(home, config, argv.includes("--json"));
    return 0;
  }
  if (sub === "enable" || sub === "disable") {
    const target = argv[1];
    if (!target || !(TOGGLE_TARGETS as string[]).includes(target)) {
      process.stderr.write(`用法：nyra middleware ${sub} <validation|tokens|retry|cache|chat|function|agent> [--yes]\n`);
      return 2;
    }
    if (!argv.includes("--yes")) {
      process.stderr.write(`nyra middleware ${sub} ${target} 会改写 ~/.nyra/middleware.json，请加 --yes 确认。\n`);
      return 2;
    }
    const { config } = loadMiddlewareConfig(home);
    applyToggle(config, target as ToggleTarget, sub === "enable");
    const { errors } = saveMiddlewareConfig(home, config);
    for (const e of errors) process.stderr.write(`警告：${e}\n`);
    process.stdout.write(`${sub === "enable" ? "已开" : "已关"} ${target}。\n`);
    return 0;
  }
  if (sub === "set") {
    const maxRetries = flagInt(argv, "--retry-max-retries");
    const initialMs = flagInt(argv, "--retry-initial-ms");
    const backoff = flagValue(argv, "--retry-backoff");
    const maxMs = flagInt(argv, "--retry-max-ms");
    const ttl = flagInt(argv, "--cache-ttl-seconds");
    const maxEntries = flagInt(argv, "--cache-max-entries");
    const store = flagValue(argv, "--cache-store");
    if (backoff !== null && (Number.isNaN(Number(backoff)) || Number(backoff) < 1 || Number(backoff) > 4)) {
      process.stderr.write(`--retry-backoff 须是 1–4 之间的数：${backoff}\n`);
      return 2;
    }
    if (store !== null && store !== "memory" && store !== "file") {
      process.stderr.write(`--cache-store 只认 memory 或 file：${store}\n`);
      return 2;
    }
    if (maxRetries === null && initialMs === null && backoff === null && maxMs === null && ttl === null && maxEntries === null && store === null) {
      process.stderr.write(USAGE + "\n");
      return 2;
    }
    if (!argv.includes("--yes")) {
      process.stderr.write("nyra middleware set 会改写 ~/.nyra/middleware.json，请加 --yes 确认。\n");
      return 2;
    }
    const { config } = loadMiddlewareConfig(home);
    if (maxRetries !== null) config.retry.maxRetries = maxRetries;
    if (initialMs !== null) config.retry.initialIntervalMs = initialMs;
    if (backoff !== null) config.retry.backoffFactor = Number(backoff);
    if (maxMs !== null) config.retry.maxIntervalMs = maxMs;
    if (ttl !== null) config.cache.ttlSeconds = ttl;
    if (maxEntries !== null) config.cache.maxEntries = maxEntries;
    if (store !== null) config.cache.store = store;
    const { config: saved, errors } = saveMiddlewareConfig(home, config);
    for (const e of errors) process.stderr.write(`警告：${e}\n`);
    process.stdout.write(`已更新：重试最多 ${saved.retry.maxRetries} 次、基础 ${saved.retry.initialIntervalMs}ms、倍数 ${saved.retry.backoffFactor}、上限 ${saved.retry.maxIntervalMs}ms；缓存 ${saved.cache.store}、TTL ${saved.cache.ttlSeconds} 秒、最多 ${saved.cache.maxEntries} 条。\n`);
    return 0;
  }
  if (sub === "approval") {
    const tool = argv[1];
    const mode = flagValue(argv, "--mode");
    const { config } = loadMiddlewareConfig(home);
    if (!tool) {
      const modes = Object.entries(config.approvalModes);
      if (!modes.length) {
        process.stdout.write("没有按工具配的审批模式（默认全部 require）。\n");
      } else {
        for (const [t, m] of modes) process.stdout.write(`${t} = ${m}\n`);
      }
      return 0;
    }
    if (mode !== "require" && mode !== "never_require") {
      process.stderr.write("用法：nyra middleware approval <工具> --mode require|never_require [--yes]\n");
      return 2;
    }
    if (!argv.includes("--yes")) {
      process.stderr.write(`nyra middleware approval ${tool} --mode ${mode} 会改写 ~/.nyra/middleware.json，请加 --yes 确认。\n`);
      return 2;
    }
    const { rejected } = validateApprovalModes({ [tool]: mode as ApprovalMode }, READONLY_TOOLS);
    if (rejected.length) {
      process.stderr.write(`${rejected[0].reason}\n`);
      return 2;
    }
    const next: MiddlewareConfig = { ...config, approvalModes: { ...config.approvalModes } };
    if (mode === "require") delete next.approvalModes[tool];
    else next.approvalModes[tool] = mode;
    saveMiddlewareConfig(home, next);
    process.stdout.write(`已配：${tool} = ${mode}。\n`);
    return 0;
  }
  if (sub === "cache-clear") {
    if (!argv.includes("--yes")) {
      process.stderr.write("nyra middleware cache-clear 会清掉文件缓存，请加 --yes 确认。\n");
      return 2;
    }
    const path = middlewareCachePath(home);
    if (existsSync(path)) rmSync(path, { force: true });
    process.stdout.write("文件缓存已清（memory 缓存是进程内的，须重启才清）。\n");
    return 0;
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}
