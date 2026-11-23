// src/checkScript.ts — 零 Token 值守的本地脚本预检（Kooyu 借鉴，Nyra 版）。
//
// 只借想法不照抄：Kooyu 的 checkScript 是“跑一条本地命令，stdout 非空即
// 命中、否则 0 Token 静默跳过”。Nyra 版复用现有审批规则当门禁，不另起一套：
//   - 命令须过 isUnattendedSafeCommand（与审批规则同一套拒绝清单）：
//     rm、sudo、curl、ssh、bash -c、python -c、find、xargs、npx、含
//     ; & | $() 反引号 换行的复合命令一律拒绝；git --version、df -h 这类
//     “程序 + 纯标志”放行（批准的是整条命令原文，不用抽可复用前缀）；
//   - 添加时用户须 --yes 显式批准原命令，批准的命令原文钉进配置；
//     运行时再验一次（逐字比对 + 门禁重验），命令被改过就拒绝
//     （fail-closed，与审批规则“匹配时重新做同样的简单命令检查”同款纵深防御）；
//   - 执行不用 shell：argv 直接进 spawnSync，不拼字符串；环境变量只给白名单
//     的几项（PATH/HOME/语言/时区/临时目录），不带密钥类变量；
//   - 超时（默认 30 秒，5–120 秒可配）与输出截断（4000 字），结果三态
//     quiet / hit / failed，命中才唤醒/通知，无事 0 Token。
import { spawnSync } from "node:child_process";
import { isUnattendedSafeCommand, splitCommand } from "./approvalRules.ts";

export class CheckScriptError extends Error {
  constructor(message: string) { super(message); this.name = "CheckScriptError"; }
}

export type CheckScriptMode = "non-empty-stdout-is-hit" | "exit-zero-is-hit";
export const CHECK_SCRIPT_MODES: CheckScriptMode[] = ["non-empty-stdout-is-hit", "exit-zero-is-hit"];
export type CheckScriptOnHit = "notify" | "wake";
export const CHECK_SCRIPT_ON_HITS: CheckScriptOnHit[] = ["notify", "wake"];

export const CHECK_SCRIPT_DEFAULT_TIMEOUT_SEC = 30;
export const CHECK_SCRIPT_MIN_TIMEOUT_SEC = 5;
export const CHECK_SCRIPT_MAX_TIMEOUT_SEC = 120;
export const CHECK_SCRIPT_MAX_OUTPUT_CHARS = 4000;

export interface CheckScriptDef {
  name: string;
  command: string;
  mode: CheckScriptMode;
  timeoutSec: number;
  onHit: CheckScriptOnHit;
  /** 添加时用户 --yes 批准的命令原文；运行时逐字比对，命令被改过就拒绝。 */
  approvedCommand: string;
}

export interface CheckScriptOutcome {
  outcome: "quiet" | "hit" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  reason?: string;
}

/** 校验一条巡检脚本定义：名字、命令、模式、超时、命中动作全要合法；命令须过审批规则门禁。 */
export function validateCheckScriptDef(input: Record<string, unknown>): CheckScriptDef {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw new CheckScriptError("巡检脚本名不能为空且不超过 100 字符");
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim() || command.length > 500) throw new CheckScriptError("巡检命令不能为空且不超过 500 字符");
  const mode = (input.mode as string) ?? "non-empty-stdout-is-hit";
  if (!CHECK_SCRIPT_MODES.includes(mode as CheckScriptMode)) {
    throw new CheckScriptError(`巡检模式只认 ${CHECK_SCRIPT_MODES.join(" / ")}`);
  }
  const timeoutSec = (input.timeoutSec as number) ?? CHECK_SCRIPT_DEFAULT_TIMEOUT_SEC;
  if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec)
    || timeoutSec < CHECK_SCRIPT_MIN_TIMEOUT_SEC || timeoutSec > CHECK_SCRIPT_MAX_TIMEOUT_SEC) {
    throw new CheckScriptError(`--timeout 须是 ${CHECK_SCRIPT_MIN_TIMEOUT_SEC}–${CHECK_SCRIPT_MAX_TIMEOUT_SEC} 的整数秒`);
  }
  const onHit = (input.onHit as string) ?? "notify";
  if (!CHECK_SCRIPT_ON_HITS.includes(onHit as CheckScriptOnHit)) {
    throw new CheckScriptError("命中动作只认 notify（写收件箱）/ wake（唤醒主控）");
  }
  // 门禁：命令须过无人值守安全检查（危险程序与复合命令直接拒绝）。
  if (!isUnattendedSafeCommand(command)) {
    throw new CheckScriptError("巡检命令不允许：只认简单命令（一个程序 + 普通参数）；删除、提权、联网、执行任意代码的程序（rm、sudo、curl、ssh、bash -c、python -c、find、xargs……）与含 ; & | $() 反引号 换行的复合命令一律拒绝");
  }
  return { name, command, mode: mode as CheckScriptMode, timeoutSec, onHit: onHit as CheckScriptOnHit, approvedCommand: command };
}

function minimalEnv(): Record<string, string> {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SystemRoot", "COMSPEC"];
  const env: Record<string, string> = {};
  for (const k of allow) {
    const v = process.env[k];
    if (typeof v === "string" && v) env[k] = v;
  }
  return env;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { code?: string; message: string };
}

function defaultSpawn(argv: string[], cwd: string, timeoutMs: number): SpawnResult {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd, timeout: timeoutMs, encoding: "utf-8", maxBuffer: 1024 * 1024,
    env: minimalEnv(), windowsHide: true,
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    ...(r.error ? { error: { code: (r.error as NodeJS.ErrnoException).code, message: r.error.message } } : {}),
  };
}

function truncate(s: string): string {
  return s.length > CHECK_SCRIPT_MAX_OUTPUT_CHARS ? s.slice(0, CHECK_SCRIPT_MAX_OUTPUT_CHARS) : s;
}

/**
 * 跑一次巡检脚本。零 Token：只跑本地命令、不调模型。
 * 运行时再验批准原文（命令被改过就拒绝）；超时、起不来、非预期退出码都算 failed。
 */
export function runCheckScript(
  def: CheckScriptDef,
  opts?: { cwd?: string; spawnFn?: (argv: string[], cwd: string, timeoutMs: number) => SpawnResult },
): CheckScriptOutcome {
  const started = Date.now();
  const finish = (partial: Omit<CheckScriptOutcome, "durationMs">): CheckScriptOutcome =>
    ({ ...partial, durationMs: Date.now() - started });
  // 运行时纵深防御：命令须仍与批准的原文逐字一致，且仍过无人值守安全检查。
  if (def.command !== def.approvedCommand || !isUnattendedSafeCommand(def.command)) {
    return finish({ outcome: "failed", stdout: "", stderr: "", exitCode: null, reason: "命令与批准的原文不符或不再是安全命令，拒绝执行" });
  }
  const argv = splitCommand(def.command);
  if (!argv || !argv.length) {
    return finish({ outcome: "failed", stdout: "", stderr: "", exitCode: null, reason: "命令解析失败" });
  }
  const cwd = opts?.cwd ?? process.cwd();
  let r: SpawnResult;
  try {
    r = (opts?.spawnFn ?? defaultSpawn)(argv, cwd, def.timeoutSec * 1000);
  } catch (err: unknown) {
    return finish({ outcome: "failed", stdout: "", stderr: "", exitCode: null, reason: `启动失败：${err instanceof Error ? err.message : String(err)}` });
  }
  const stdout = truncate(r.stdout);
  const stderr = truncate(r.stderr);
  if (r.error?.code === "ETIMEDOUT" || r.status === null) {
    return finish({ outcome: "failed", stdout, stderr, exitCode: r.status, reason: `超时（超过 ${def.timeoutSec} 秒）` });
  }
  if (r.error) {
    return finish({ outcome: "failed", stdout, stderr, exitCode: r.status, reason: `启动失败：${r.error.message}` });
  }
  if (def.mode === "exit-zero-is-hit") {
    if (r.status === 0) return finish({ outcome: "hit", stdout, stderr, exitCode: 0 });
    if (r.status === 1) return finish({ outcome: "quiet", stdout, stderr, exitCode: 1 });
    return finish({ outcome: "failed", stdout, stderr, exitCode: r.status, reason: `退出码 ${r.status}（非预期的失败）` });
  }
  // non-empty-stdout-is-hit：stdout 非空即命中；退出码非 0 算失败（命令本身报错了）。
  if (r.status !== 0) {
    return finish({ outcome: "failed", stdout, stderr, exitCode: r.status, reason: `退出码 ${r.status}` });
  }
  return finish({ outcome: stdout.trim() ? "hit" : "quiet", stdout, stderr, exitCode: 0 });
}

/** 一行描述，供巡查结果与 CLI 展示。 */
export function describeCheckScriptOutcome(def: CheckScriptDef, outcome: CheckScriptOutcome): string {
  if (outcome.outcome === "hit") {
    const head = outcome.stdout.trim().split("\n")[0]?.slice(0, 100) ?? "";
    return `巡检脚本 ${def.name} 命中：${head}`;
  }
  if (outcome.outcome === "failed") {
    return `巡检脚本 ${def.name} 执行失败：${outcome.reason ?? `退出码 ${outcome.exitCode}`}`;
  }
  return `巡检脚本 ${def.name} 安静`;
}
