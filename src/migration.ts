// src/migration.ts — spec 07 改名迁移（angel → nyra），在 Node 版里一次做完。
// ①原子迁移：先复制到 ~/.nyra.migrating，全部完成后再改名成 ~/.nyra；
// ②迁移时未用掉的批准状态全部作废；③ANGEL_* 回退只在 config.ts 的
//    envVar 里保留，用到时印一次废弃提示；④angel 命令别名；
// ⑥.migrating 临时目录；⑦~/.nyra 0700，会话/日志 0600，不跟随符号链接；
// ⑧X-Angel-Token 兼容（同时带时以 X-Nyra-Token 为准，token 本身不变）。
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

export const LEGACY_HOME_NAME = ".angel";
export const NYRA_HOME_NAME = ".nyra";
export const MIGRATING_SUFFIX = ".migrating";

// 迁移时作废的批准状态文件（批准只在本次会话内有效，改名后重新批准）。
// 批准规则与 Bot 授权也算批准类文件：不继承，见第四份审计 P0。
const APPROVAL_STATE_FILES = new Set([
  "approvals.json", "approved.json", "approval_state.json",
  "approval_rules.json", "bot-approvals.json",
]);

export interface MigrationResult {
  migrated: boolean;
  skippedSymlinks: string[];
  voidedApprovals: string[];
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function copyTree(src: string, dst: string, skipped: string[]): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (isSymlink(s)) {
      skipped.push(s);
      process.stderr.write(`警告：迁移时跳过符号链接：${s}\n`);
      continue;
    }
    if (entry.isDirectory()) copyTree(s, d, skipped);
    else if (entry.isFile()) {
      copyFileSync(s, d);
      try { chmodSync(d, 0o600); } catch { /* ignore */ }
    }
  }
}

export function migrateLegacyHome(homeDir: string = process.env.HOME ?? ""): MigrationResult {
  const legacy = join(homeDir, LEGACY_HOME_NAME);
  const target = join(homeDir, NYRA_HOME_NAME);
  const staging = target + MIGRATING_SUFFIX;
  // 中途崩溃的残留：下次运行删掉临时目录、从头重新迁移。
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  if (!existsSync(legacy) || existsSync(target)) {
    return { migrated: false, skippedSymlinks: [], voidedApprovals: [] };
  }
  if (isSymlink(legacy)) {
    process.stderr.write(`警告：迁移时跳过符号链接：${legacy}\n`);
    return { migrated: false, skippedSymlinks: [legacy], voidedApprovals: [] };
  }
  const skipped: string[] = [];
  const voided: string[] = [];
  copyTree(legacy, staging, skipped);
  for (const name of APPROVAL_STATE_FILES) {
    const p = join(staging, name);
    if (existsSync(p)) { rmSync(p, { force: true }); voided.push(name); }
  }
  // 宽松设置不自动生效：full 模式改回 auto，受信任的 verify_command 删除
  // （runs.ts 会从 config 读它，光靠注释挡不住）。config.json 本身保留
  // （provider / model / 语言等偏好可以迁）。
  const stagedConfig = join(staging, "config.json");
  try {
    if (existsSync(stagedConfig)) {
      const cfg = JSON.parse(readFileSync(stagedConfig, "utf-8")) as Record<string, unknown>;
      if (cfg.mode === "full") cfg.mode = "auto";
      delete cfg.verify_command;
      writeFileSync(stagedConfig, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    }
  } catch { /* 暂存配置损坏不阻塞迁移，loadConfig 会用默认值兜底 */ }
  try { chmodSync(staging, 0o700); } catch { /* ignore */ }
  renameSync(staging, target);
  // 迁移成功后删掉旧目录，不留双份 home，也不再原地用 ~/.angel。
  rmSync(legacy, { recursive: true, force: true });
  try { chmodSync(target, 0o700); } catch { /* ignore */ }
  return { migrated: true, skippedSymlinks: skipped, voidedApprovals: voided };
}

/** 确保 ~/.nyra 存在且为 0700；不存在时创建。返回最终 home 路径。 */
export function ensureNyraHome(homeDir: string = process.env.HOME ?? ""): string {
  const result = migrateLegacyHome(homeDir);
  void result;
  const target = join(homeDir, NYRA_HOME_NAME);
  if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
  try { chmodSync(target, 0o700); } catch { /* ignore */ }
  return target;
}

/**
 * 网页端 token 头解析：X-Nyra-Token 优先，X-Angel-Token 兼容；
 * 同时带时以新的为准；token 本身不变，也不写进 URL。
 */
export function resolveAuthToken(headers: Record<string, string | string[] | undefined>): string | null {
  const pick = (v: string | string[] | undefined): string | null => {
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v.length) return v[0] ?? null;
    return null;
  };
  const nyra = pick(headers["x-nyra-token"]) ?? pick(headers["X-Nyra-Token"]);
  if (nyra) return nyra;
  return pick(headers["x-angel-token"]) ?? pick(headers["X-Angel-Token"]);
}

/** angel 命令别名：nyra 与 angel 共用同一入口，行为一致。 */
export function isAngelAlias(argv0: string): boolean {
  return basename(argv0) === "angel" || basename(argv0) === "angel.exe";
}
