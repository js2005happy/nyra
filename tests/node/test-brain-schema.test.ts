// tests/node/test-brain-schema.test.ts — H10：脑文件夹 Schema 化，测试钉住。
// 口径：缺必需文件、类型不对、权限位不对 → 失败；未登记的条目只上报、
// 不判失败——新功能往 ~/.nyra 加文件时，先更新 schema，再让 doctor 通过。
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrainSchema, summarizeBrainSchema, validateBrainSchema } from "../../src/brainSchema.ts";
import { runDoctor } from "../../src/doctor.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-schema-"));
}

const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

test("BrainSchemaTest.test_schema_loads_and_pins_core_entries", () => {
  const schema = loadBrainSchema();
  expect(schema.version).toBe(1);
  expect(schema.entries.length).toBeGreaterThanOrEqual(40);
  const byPath = new Map(schema.entries.map((e) => [e.path, e]));
  expect(byPath.get("config.json")).toMatchObject({ kind: "file", required: true });
  expect(byPath.get("vault.json")).toMatchObject({ kind: "file", mode: 0o600 });
  expect(byPath.get("keys.json")).toMatchObject({ kind: "file", mode: 0o600 });
  expect(byPath.get("MEMORY.md")).toMatchObject({ kind: "file", required: false });
  expect(byPath.get("sessions")).toMatchObject({ kind: "dir", required: false });
  expect(byPath.get("gateway-presence.json")).toMatchObject({ kind: "file", required: false });
  expect(byPath.get("quarantine")).toMatchObject({ kind: "dir", required: false });
  // 条目路径只许顶层单段，不许带斜杠（v1 只核对顶层一层）。
  for (const e of schema.entries) expect(e.path).not.toContain("/");
});

test("BrainSchemaTest.test_missing_required_config_fails", () => {
  const home = tmpHome();
  try {
    const report = validateBrainSchema(home);
    expect(report.ok).toBe(false);
    expect(report.schemaVersion).toBe(1);
    expect(report.issues.some((i) => i.path === "config.json" && i.problem === "missing-required")).toBe(true);
    expect(summarizeBrainSchema(report)).toContain("config.json");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrainSchemaTest.test_valid_home_passes", () => {
  const home = tmpHome();
  try {
    writeFileSync(join(home, "config.json"), "{}\n", "utf-8");
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "MEMORY.md"), "- [2026-11-25 10:00] 测试\n", "utf-8");
    const report = validateBrainSchema(home);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.checked).toBe(loadBrainSchema().entries.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrainSchemaTest.test_wrong_kind_fails", () => {
  const home = tmpHome();
  try {
    writeFileSync(join(home, "config.json"), "{}\n", "utf-8");
    writeFileSync(join(home, "sessions"), "本应是目录\n", "utf-8");
    const report = validateBrainSchema(home);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.path === "sessions" && i.problem === "wrong-kind")).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrainSchemaTest.test_wrong_vault_mode_fails", () => {
  if (process.platform === "win32") return;
  const home = tmpHome();
  try {
    writeFileSync(join(home, "config.json"), "{}\n", "utf-8");
    writeFileSync(join(home, "vault.json"), "{}\n", "utf-8");
    chmodSync(join(home, "vault.json"), 0o644);
    const report = validateBrainSchema(home);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.path === "vault.json" && i.problem === "wrong-mode")).toBe(true);
    chmodSync(join(home, "vault.json"), 0o600);
    expect(validateBrainSchema(home).ok).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrainSchemaTest.test_unknown_entry_reported_not_failed", () => {
  const home = tmpHome();
  try {
    writeFileSync(join(home, "config.json"), "{}\n", "utf-8");
    writeFileSync(join(home, "some-new-feature.json"), "{}\n", "utf-8");
    const report = validateBrainSchema(home);
    expect(report.ok).toBe(true);
    expect(report.unknown).toEqual(["some-new-feature.json"]);
    expect(summarizeBrainSchema(report)).toContain("some-new-feature.json");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrainSchemaTest.test_doctor_reports_brain_structure", async () => {
  const home = tmpHome();
  process.env.DEEPSEEK_API_KEY = "test-key-doctor-schema";
  try {
    const { checks, allOk } = await runDoctor({ home, fetchFn: okFetch });
    const item = checks.find((c) => c.name === "脑文件夹结构");
    expect(item).toBeDefined();
    expect(item!.ok).toBe(true);
    expect(item!.detail).toContain("schema v1");
    expect(allOk).toBe(true);
    // 未登记文件不判失败，只出现在 detail 里。
    writeFileSync(join(home, "future-feature.json"), "{}\n", "utf-8");
    const again = await runDoctor({ home, fetchFn: okFetch });
    const item2 = again.checks.find((c) => c.name === "脑文件夹结构")!;
    expect(item2.ok).toBe(true);
    expect(item2.detail).toContain("future-feature.json");
    expect(existsSync(join(home, "config.json"))).toBe(true);
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrainSchemaTest.test_doctor_fails_on_wrong_vault_mode", async () => {
  if (process.platform === "win32") return;
  const home = tmpHome();
  process.env.DEEPSEEK_API_KEY = "test-key-doctor-schema";
  try {
    writeFileSync(join(home, "vault.json"), "{}\n", "utf-8");
    chmodSync(join(home, "vault.json"), 0o644);
    const { checks } = await runDoctor({ home, fetchFn: okFetch });
    const item = checks.find((c) => c.name === "脑文件夹结构")!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain("vault.json");
    expect(item.fix).toContain("chmod");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    rmSync(home, { recursive: true, force: true });
  }
});
