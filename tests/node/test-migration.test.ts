// tests/node/test-migration.test.ts — spec 07 行为项（方案第 5 节）在 Node 版一次做完。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_HOME_NAME, NYRA_HOME_NAME, MIGRATING_SUFFIX,
  migrateLegacyHome, ensureNyraHome, resolveAuthToken, isAngelAlias,
} from "../../src/migration.ts";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-mig-home-"));
}

test("MigrationTest.test_names", () => {
  expect(LEGACY_HOME_NAME).toBe(".angel");
  expect(NYRA_HOME_NAME).toBe(".nyra");
  expect(MIGRATING_SUFFIX).toBe(".migrating");
});

test("MigrationTest.test_atomic_migration_copies_then_renames", () => {
  const home = fakeHome();
  mkdirSync(join(home, ".angel"));
  writeFileSync(join(home, ".angel", "MEMORY.md"), "记忆\n");
  writeFileSync(join(home, ".angel", "config.json"), "{}");
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(true);
  expect(existsSync(join(home, ".nyra", "MEMORY.md"))).toBe(true);
  expect(readFileSync(join(home, ".nyra", "MEMORY.md"), "utf-8")).toBe("记忆\n");
  // 迁移成功后旧目录删掉，不留双份 home（第四份审计 P0）。
  expect(existsSync(join(home, ".angel"))).toBe(false);
  expect(existsSync(join(home, ".nyra.migrating"))).toBe(false);
});

test("MigrationTest.test_no_legacy_nothing_happens", () => {
  const home = fakeHome();
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(false);
  expect(existsSync(join(home, ".nyra"))).toBe(false);
});

test("MigrationTest.test_existing_nyra_not_overwritten", () => {
  const home = fakeHome();
  mkdirSync(join(home, ".angel"));
  writeFileSync(join(home, ".angel", "MEMORY.md"), "旧的\n");
  mkdirSync(join(home, ".nyra"));
  writeFileSync(join(home, ".nyra", "MEMORY.md"), "已有的\n");
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(false);
  expect(readFileSync(join(home, ".nyra", "MEMORY.md"), "utf-8")).toBe("已有的\n");
});

test("MigrationTest.test_approvals_voided_on_migration", () => {
  const home = fakeHome();
  mkdirSync(join(home, ".angel"));
  writeFileSync(join(home, ".angel", "approvals.json"), "{}");
  writeFileSync(join(home, ".angel", "approved.json"), "{}");
  writeFileSync(join(home, ".angel", "approval_rules.json"), "{}");
  writeFileSync(join(home, ".angel", "bot-approvals.json"), "{}");
  writeFileSync(join(home, ".angel", "MEMORY.md"), "x\n");
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(true);
  expect(result.voidedApprovals).toContain("approvals.json");
  expect(result.voidedApprovals).toContain("approved.json");
  expect(result.voidedApprovals).toContain("approval_rules.json");
  expect(result.voidedApprovals).toContain("bot-approvals.json");
  expect(existsSync(join(home, ".nyra", "approvals.json"))).toBe(false);
  expect(existsSync(join(home, ".nyra", "approved.json"))).toBe(false);
  expect(existsSync(join(home, ".nyra", "approval_rules.json"))).toBe(false);
  expect(existsSync(join(home, ".nyra", "bot-approvals.json"))).toBe(false);
  expect(existsSync(join(home, ".nyra", "MEMORY.md"))).toBe(true);
});

test("MigrationTest.test_symlinks_skipped_not_followed", () => {
  const home = fakeHome();
  mkdirSync(join(home, ".angel"));
  writeFileSync(join(home, "outside.txt"), "外面\n");
  symlinkSync(join(home, "outside.txt"), join(home, ".angel", "link.txt"));
  writeFileSync(join(home, ".angel", "MEMORY.md"), "x\n");
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(true);
  expect(result.skippedSymlinks.length).toBe(1);
  expect(existsSync(join(home, ".nyra", "link.txt"))).toBe(false);
});

test("MigrationTest.test_legacy_symlink_itself_skipped", () => {
  const home = fakeHome();
  mkdirSync(join(home, "real-angel"));
  symlinkSync(join(home, "real-angel"), join(home, ".angel"));
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(false);
  expect(result.skippedSymlinks).toContain(join(home, ".angel"));
});

test("MigrationTest.test_crash_leftover_staging_removed_and_retried", () => {
  const home = fakeHome();
  mkdirSync(join(home, ".angel"));
  writeFileSync(join(home, ".angel", "MEMORY.md"), "x\n");
  mkdirSync(join(home, ".nyra.migrating"));
  writeFileSync(join(home, ".nyra.migrating", "stale.txt"), "残留\n");
  const result = migrateLegacyHome(home);
  expect(result.migrated).toBe(true);
  expect(existsSync(join(home, ".nyra", "stale.txt"))).toBe(false);
  expect(existsSync(join(home, ".nyra", "MEMORY.md"))).toBe(true);
});

test("MigrationTest.test_permissions_0700_0600", () => {
  if (process.platform === "win32") return;
  const home = fakeHome();
  mkdirSync(join(home, ".angel"));
  writeFileSync(join(home, ".angel", "MEMORY.md"), "x\n");
  migrateLegacyHome(home);
  expectPerms(join(home, ".nyra"), 0o700);
  expectPerms(join(home, ".nyra", "MEMORY.md"), 0o600);
});

test("MigrationTest.test_ensure_nyra_home_creates_0700", () => {
  if (process.platform === "win32") return;
  const home = fakeHome();
  const target = ensureNyraHome(home);
  expect(target).toBe(join(home, ".nyra"));
  expect(existsSync(target)).toBe(true);
  expectPerms(target, 0o700);
});

test("MigrationTest.test_auth_token_nyra_wins", () => {
  expect(resolveAuthToken({ "X-Nyra-Token": "new-token", "X-Angel-Token": "old-token" })).toBe("new-token");
  expect(resolveAuthToken({ "X-Angel-Token": "old-token" })).toBe("old-token");
  expect(resolveAuthToken({ "x-nyra-token": "lower" })).toBe("lower");
  expect(resolveAuthToken({})).toBeNull();
  expect(resolveAuthToken({ "X-Nyra-Token": "" })).toBeNull();
});

test("MigrationTest.test_angel_alias", () => {
  expect(isAngelAlias("/usr/local/bin/angel")).toBe(true);
  expect(isAngelAlias("/usr/local/bin/angel.exe")).toBe(true);
  expect(isAngelAlias("/usr/local/bin/nyra")).toBe(false);
  expect(isAngelAlias("nyra")).toBe(false);
});
