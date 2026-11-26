// src/keystore.ts — 在 Nyra 界面（首次引导 / 设置 → 模型）里输入的模型 API Key。
//
// 存放位置（用户 2026-11-20 拍板）：
// - 密码箱已解锁（NYRA_VAULT_PASSWORD 能打开 <NYRA_HOME>/vault.json）时直接写进密码箱，
//   条目名就是 provider 的环境变量名（DEEPSEEK_API_KEY …），与 `nyra vault add` 同一口径；
// - 密码箱没解锁 / 不存在时写进单独的 <NYRA_HOME>/keys.json（文件 0600、目录 0700、原子写），
//   之后密码箱一解锁就搬进密码箱并从 keys.json 删掉（migrateKeysToVault）。
// 绝不写进项目目录、config.json 或日志；对外（HTTP 接口 / 页面）只给掩码 mask()。
//
// 读取顺序（config.resolveProvider）：provider 自己的环境变量 > NYRA_API_KEY > 密码箱 > keys.json。
// 环境变量永远优先，界面会如实标注“来自环境变量”。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { Vault, vaultPath } from "./vault.ts";

export const KEYS_FILENAME = "keys.json";
export const MAX_KEY_LEN = 512;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export type KeySourceView = "env" | "env_generic" | "vault" | "file" | "missing" | "none_needed";

export function keysPath(home: string): string {
  return join(home, KEYS_FILENAME);
}

/** 掩码：最多一个短前缀（sk- / gsk_ …）+ 末 4 位，例如 `sk-…abcd`。短 Key 只露末 2 位。 */
export function maskKey(value: string | null | undefined): string {
  if (!value) return "";
  const v = String(value);
  if (v.length <= 8) return v.length > 4 ? "…" + v.slice(-2) : "…";
  const head = /^[A-Za-z]{2,4}[-_]/.exec(v)?.[0] ?? "";
  return `${head}…${v.slice(-4)}`;
}

export function validateKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("API Key 必须是文本");
  const v = value.trim();
  if (!v) throw new Error("API Key 不能为空");
  if (v.length > MAX_KEY_LEN) throw new Error("API Key 太长");
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 33 || c > 126) throw new Error("API Key 只能包含可见的 ASCII 字符（不含空格）");
  }
  return v;
}

export const OAUTH_TOKEN_PREFIXES = ["gho_", "ghp_", "github_pat_", "ya29.", "1//", "xoxb-", "xoxp-", "xoxa-", "xoxr-"];

export function oauthTokenPrefix(value: string): string | null {
  for (const p of OAUTH_TOKEN_PREFIXES) if (value.startsWith(p)) return p;
  return null;
}

/**
 * H5：凭证类型纪律——模型 Key 的入口校验（validateKey + OAuth 形状拒绝）。
 * OAuth token 绝不当 API Key 用（Hermes fix(gemini)/fix(model-metadata)
 * 的同款教训：Gemini 探针曾把密钥错当 x-goog-api-key 发、Anthropic 探针曾
 * 把 OAuth token 当 x-api-key 发）。
 * 以下前缀一眼能认出是 OAuth/平台 token，不是模型服务商的 API Key：
 * gho_（GitHub OAuth）、ghp_/github_pat_（GitHub PAT）、ya29.（Google
 * OAuth access token）、1//（Google OAuth refresh token）、xoxb-/xoxp-/
 * xoxa-/xoxr-（Slack）。
 *
 * 注意作用域：这道拦只放在模型 Key 的两个入口——网关测 Key（testKey）与
 * 界面保存 Key（saveKey）。通用的 validateKey/setKey 不拦：Bot 电脑凭证
 * （src/bot/computer.ts 的 storeComputerCredential）存的就是任意账号
 * secret，GitHub PAT（ghp_…）是合法的电脑凭证，不能因为长得像 OAuth
 * token 就拒收。API Key 只去模型服务商，OAuth token 只去它自己的服务
 * （GitHub token 去 api.github.com，Google token 去 Google API，各走各
 * 的 Bearer，见 accounts.ts）。
 */
export function validateProviderKey(value: unknown): string {
  const v = validateKey(value);
  const hit = oauthTokenPrefix(v);
  if (hit) throw new Error(`这看起来像 OAuth token（以 ${hit} 开头），不能当 API Key 用：API Key 只去模型服务商，OAuth token 只去它自己的服务`);
  return v;
}

export function validEnvName(name: unknown): name is string {
  return typeof name === "string" && ENV_NAME_RE.test(name);
}

function loadKeys(home: string): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(keysPath(home), "utf-8")) as { keys?: unknown };
    const keys = data && typeof data === "object" ? data.keys : null;
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys as Record<string, unknown>)) {
      if (validEnvName(k) && typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveKeys(home: string, keys: Record<string, string>): void {
  const target = keysPath(home);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { try { chmodSync(dir, 0o700); } catch { /* ignore */ } }
  if (!Object.keys(keys).length) {
    try { rmSync(target, { force: true }); } catch { /* ignore */ }
    return;
  }
  const tmp = join(dir, `.keys-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, keys }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    if (process.platform !== "win32") chmodSync(target, 0o600);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 用 NYRA_VAULT_PASSWORD 打开密码箱；打不开（不存在/没给密码/密码错/锁死）返回 null，不抛错。 */
export function openVault(home: string): Vault | null {
  const password = process.env.NYRA_VAULT_PASSWORD;
  if (!password) return null;
  const path = vaultPath(home);
  if (!existsSync(path)) return null;
  try {
    const vault = new Vault(path);
    return vault.unlock(password) ? vault : null;
  } catch {
    return null;
  }
}

export function vaultState(home: string): { exists: boolean; unlocked: boolean } {
  const exists = existsSync(vaultPath(home));
  return { exists, unlocked: exists && openVault(home) !== null };
}

/** keys.json 里的一条（密码箱优先由 resolveProvider 自己读，这里只管文件）。 */
export function getFileKey(envName: string | null | undefined, home: string): string | null {
  if (!envName || !home) return null; // 没有 Nyra 目录时不读当前目录下的 keys.json
  return loadKeys(home)[envName] ?? null;
}

/**
 * 保存一条 Key：密码箱已解锁 → 写密码箱（并清掉 keys.json 里的同名旧值）；否则写 keys.json。
 * 返回掩码与实际去处，绝不返回明文。
 */
export function setKey(envName: string, value: unknown, home: string): { masked: string; stored: "vault" | "file" } {
  if (!validEnvName(envName)) throw new Error("这个 provider 不使用 API Key");
  const key = validateKey(value);
  const vault = openVault(home);
  if (vault) {
    vault.add(envName, key, true);
    const keys = loadKeys(home);
    if (envName in keys) { delete keys[envName]; saveKeys(home, keys); }
    return { masked: maskKey(key), stored: "vault" };
  }
  const keys = loadKeys(home);
  keys[envName] = key;
  saveKeys(home, keys);
  return { masked: maskKey(key), stored: "file" };
}

/** 删掉界面保存的 Key（keys.json；密码箱解锁时也删密码箱里的同名条目）。 */
export function removeKey(envName: string, home: string): boolean {
  if (!validEnvName(envName)) return false;
  let removed = false;
  const keys = loadKeys(home);
  if (envName in keys) { delete keys[envName]; saveKeys(home, keys); removed = true; }
  const vault = openVault(home);
  if (vault) {
    try { if (vault.get(envName) !== null) { vault.remove(envName); removed = true; } } catch { /* ignore */ }
  }
  return removed;
}

/** 密码箱解锁后把 keys.json 里的 Key 搬进密码箱（已有同名条目以 keys.json 的新值为准）。返回搬了几条。 */
export function migrateKeysToVault(home: string): number {
  const keys = loadKeys(home);
  const names = Object.keys(keys);
  if (!names.length) return 0;
  const vault = openVault(home);
  if (!vault) return 0;
  for (const name of names) vault.add(name, keys[name], true);
  saveKeys(home, {});
  return names.length;
}

/** 某个 provider 的 Key 从哪来（不暴露明文）。 */
export function keyStatus(envName: string | null | undefined, home: string, vault?: Vault | null): { source: KeySourceView; masked: string } {
  if (!envName) return { source: "none_needed", masked: "" };
  const env = process.env[envName];
  if (env) return { source: "env", masked: maskKey(env) };
  const generic = process.env.NYRA_API_KEY;
  if (generic) return { source: "env_generic", masked: maskKey(generic) };
  const v = vault === undefined ? openVault(home) : vault;
  if (v) {
    try { const got = v.get(envName); if (got) return { source: "vault", masked: maskKey(got) }; } catch { /* ignore */ }
  }
  const file = getFileKey(envName, home);
  if (file) return { source: "file", masked: maskKey(file) };
  return { source: "missing", masked: "" };
}
