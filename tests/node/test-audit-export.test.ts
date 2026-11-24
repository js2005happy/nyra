// tests/node/test-audit-export.test.ts — O2：审计导出 API + 部署级审计 + 触发方。
// 导出过滤、部署审计、运行 initiator、网关 GET /api/audit/export，均在
// 临时 home 上验，不联网、不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "../../src/costCaps.ts";
import { appendDeploymentAudit, handleGovernance, listDeploymentAudit } from "../../src/governance.ts";
import { RunStore } from "../../src/runs.ts";
import { Gateway } from "../../src/gateway.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedAudit(home: string): void {
  const gov = [
    { at: "2026-11-24T10:00:00.000Z", action: "policy_created", actor: "owner", scope: "org" },
    { at: "2026-11-24T11:00:00.000Z", action: "deploy_note", actor: "owner", scope: "deployment", note: "旧部署" },
    { at: "2026-11-24T12:00:00.000Z", action: "mandate_issued", actor: "alice", scope: "org" },
  ];
  writeFileSync(join(home, "governance-audit.jsonl"), gov.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  const policy = [
    { at: "2026-11-24T10:30:00.000Z", kind: "denied", tool: "shell", rule: "pol_0123456789ab" },
    { at: "2026-11-24T11:30:00.000Z", kind: "allowed", tool: "read_file", rule: "pol_0123456789ab" },
  ];
  writeFileSync(join(home, "policy-audit.jsonl"), policy.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}

function parseExport(text: string): Record<string, unknown>[] {
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---- 导出过滤 ----

// 每个过滤断言用独立 home：exportAudit 每次调用都会往治理审计里追加一条
// audit_exported（自审计），复用同一个 home 会污染下一次的计数。
function freshSeededHome(prefix: string): string {
  const home = tmpHome(prefix);
  seedAudit(home);
  return home;
}

function dataRecords(text: string): Record<string, unknown>[] {
  return parseExport(text).filter((r) => r.type !== "export_header");
}

test("AuditExportTest.test_export_filters_by_actor_type_scope", () => {
  // 不过滤：3 条治理 + 2 条策略 = 5 条（导出本身记的 audit_exported 不进
  // 本次导出的 text，只在下一次导出里出现）。
  const homeAll = freshSeededHome("nyra-audit-filter-all-");
  expect(dataRecords(exportAudit(homeAll, {}).text)).toHaveLength(5);
  rmSync(homeAll, { recursive: true, force: true });
  // 按主体：owner 的两条在，alice 的不在（policy 行无 actor 字段，不命中）。
  const homeActor = freshSeededHome("nyra-audit-filter-actor-");
  const ownerRecs = dataRecords(exportAudit(homeActor, { actor: "owner" }).text);
  expect(ownerRecs.filter((r) => r.action === "policy_created")).toHaveLength(1);
  expect(ownerRecs.filter((r) => r.action === "deploy_note")).toHaveLength(1);
  expect(ownerRecs.filter((r) => r.action === "mandate_issued")).toHaveLength(0);
  rmSync(homeActor, { recursive: true, force: true });
  // 按事件类型：denied 1 条（policy 源）。
  const homeType = freshSeededHome("nyra-audit-filter-type-");
  const deniedRecs = dataRecords(exportAudit(homeType, { type: "denied" }).text);
  expect(deniedRecs).toHaveLength(1);
  expect(deniedRecs[0]!.source).toBe("policy");
  rmSync(homeType, { recursive: true, force: true });
  // 按范围：deployment 的 deploy_note 在，org 的两条不在。
  const homeScope = freshSeededHome("nyra-audit-filter-scope-");
  const depRecs = dataRecords(exportAudit(homeScope, { scope: "deployment" }).text);
  expect(depRecs.filter((r) => r.action === "deploy_note")).toHaveLength(1);
  expect(depRecs.filter((r) => r.action === "policy_created")).toHaveLength(0);
  expect(depRecs.filter((r) => r.action === "mandate_issued")).toHaveLength(0);
  rmSync(homeScope, { recursive: true, force: true });
  // 按来源 + 时间。
  const homeRanged = freshSeededHome("nyra-audit-filter-range-");
  const rangedRecs = dataRecords(exportAudit(homeRanged, { sources: ["policy"], from: "2026-11-24", to: "2026-11-24" }).text);
  expect(rangedRecs).toHaveLength(2);
  rmSync(homeRanged, { recursive: true, force: true });
});

test("AuditExportTest.test_export_self_audit_recorded", () => {
  const home = tmpHome("nyra-audit-self-");
  seedAudit(home);
  exportAudit(home, {});
  // 导出本身记了一条 audit_exported（下一次导出可见）。
  const second = exportAudit(home, { type: "audit_exported" });
  const recs = parseExport(second.text).filter((r) => r.type !== "export_header");
  expect(recs.length).toBeGreaterThanOrEqual(1);
  expect(recs.some((r) => r.action === "audit_exported")).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

// ---- 部署级审计 ----

test("AuditExportTest.test_deployment_audit_roundtrip", () => {
  const home = tmpHome("nyra-audit-deploy-");
  expect(appendDeploymentAudit(home, { action: "deploy", note: "部署 0.5.15 到单机" })).toBe(true);
  expect(appendDeploymentAudit(home, { action: "upgrade", note: "升级到 0.5.16" })).toBe(true);
  expect(appendDeploymentAudit(home, { action: "rollback", note: "回滚到 0.5.15" })).toBe(true);
  // 空说明不记。
  expect(appendDeploymentAudit(home, { action: "deploy", note: "   " })).toBe(false);
  const entries = listDeploymentAudit(home);
  expect(entries).toHaveLength(3);
  expect(entries.map((e) => e.action)).toEqual(["deploy", "upgrade", "rollback"]);
  // 同一本账本：治理审计文件里能看到 scope 为 deployment 的行。
  const govLines = readFileSync(join(home, "governance-audit.jsonl"), "utf-8").trim().split("\n");
  expect(govLines).toHaveLength(3);
  expect(govLines.every((l) => (JSON.parse(l) as Record<string, unknown>).scope === "deployment")).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

test("AuditExportTest.test_cli_deploy_and_audit_deployment", () => {
  const home = tmpHome("nyra-audit-deploy-cli-");
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    expect(handleGovernance(["deploy", "部署 0.5.15", "--kind", "deploy"], home)).toBe(0);
    expect(handleGovernance(["audit", "deployment"], home)).toBe(0);
    expect(handleGovernance(["audit", "deployment", "--json"], home)).toBe(0);
    expect(() => handleGovernance(["deploy"], home)).toThrow(/说明必填/);
    expect(() => handleGovernance(["deploy", "x", "--kind", "bogus"], home)).toThrow(/用法/);
  } finally {
    console.log = origLog;
  }
  expect(listDeploymentAudit(home)).toHaveLength(1);
  expect(lines.some((l) => l.includes("已记部署审计"))).toBe(true);
  expect(lines.some((l) => l.includes("部署级审计"))).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

// ---- 运行触发方 ----

test("AuditExportTest.test_run_initiator_recorded", () => {
  const home = tmpHome("nyra-audit-run-");
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做一件事", "s-1", home, "full", 5, "running", null, { initiator: "cron" });
  expect(state.initiator).toBe("cron");
  const events = store.readEvents(state.run_id);
  const started = events.find((e) => e.type === "run_started");
  expect(started).toBeDefined();
  expect(started!.initiator).toBe("cron");
  // 默认 person。
  const state2 = store.create("做另一件事", "s-2", home, "full", 5, "running", null);
  expect(state2.initiator).toBe("person");
  // 旧运行（无 initiator 字段）仍能 load。
  const raw = JSON.parse(readFileSync(join(home, "runs", state2.run_id, "state.json"), "utf-8")) as Record<string, unknown>;
  delete raw.initiator;
  writeFileSync(join(home, "runs", state2.run_id, "state.json"), JSON.stringify(raw));
  expect(store.load(state2.run_id).run_id).toBe(state2.run_id);
  rmSync(home, { recursive: true, force: true });
});

// ---- 网关 API ----

test("AuditExportTest.test_gateway_audit_export_api", async () => {
  const home = tmpHome("nyra-audit-gw-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-audit-gw-wd-"));
  seedAudit(home);
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, config: { mcp_enabled: false } });
  const info = await gw.start();
  const base = `http://127.0.0.1:${info.port}`;
  try {
    // 无 token → 403。
    const noToken = await fetch(`${base}/api/audit/export`);
    expect(noToken.status).toBe(403);
    // 有 token：JSON 格式。
    const res = await fetch(`${base}/api/audit/export?sources=governance,policy`, { headers: { "X-Nyra-Token": gw.token } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; lines: number; records: Record<string, unknown>[] };
    expect(body.ok).toBe(true);
    expect(body.lines).toBe(5);
    expect(body.records.some((r) => r.source === "policy")).toBe(true);
    // 过滤：只看 denied。
    const denied = await fetch(`${base}/api/audit/export?type=denied`, { headers: { "X-Nyra-Token": gw.token } });
    const deniedBody = await denied.json() as { lines: number };
    expect(deniedBody.lines).toBe(1);
    // limit 超了 → 400。
    const limited = await fetch(`${base}/api/audit/export?limit=2`, { headers: { "X-Nyra-Token": gw.token } });
    expect(limited.status).toBe(400);
    // jsonl 格式：原始 JSONL 文本。
    const jsonl = await fetch(`${base}/api/audit/export?format=jsonl&sources=policy`, { headers: { "X-Nyra-Token": gw.token } });
    expect(jsonl.status).toBe(200);
    const text = await jsonl.text();
    expect(text).toContain("export_header");
    expect(text).toContain("policy-audit.jsonl");
    // 坏 format → 400。
    const bad = await fetch(`${base}/api/audit/export?format=csv`, { headers: { "X-Nyra-Token": gw.token } });
    expect(bad.status).toBe(400);
  } finally {
    await gw.stop();
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});
