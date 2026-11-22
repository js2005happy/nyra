// tests/node/test-team-lease-batch2.test.ts — 第 2 批 G-P1-3：租约 + 纪元 + lead 路由。
// 全部用临时 home，不调模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeam } from "../../src/team.ts";
import { defaultSoul, saveSoul, setCharter } from "../../src/soul.ts";
import {
  TEAM_LEASE_TTL_MS,
  acquireTeamLease,
  checkTeamEpoch,
  getTeamLease,
  releaseTeamLease,
  routeToLead,
  transferTeamLead,
} from "../../src/teamLease.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
  setCharter(home, agent, {
    own: "负责写周报",
    sources: ["任务板", "上周周报"],
    output: "以 `## 结论` 开头，附三条要点",
    approval: "对外发送前须人批",
    stop: "缺关键数据时停下问人",
  });
}

function makeTeam(home: string) {
  makeSoul(home, "chief-a");
  makeSoul(home, "bot-a");
  makeSoul(home, "bot-b");
  return createTeam(home, { name: "squad-a", chief: "chief-a", members: ["bot-a", "bot-b"] });
}

test("TeamLeaseBatch2.test_acquire_only_chief_and_renews", () => {
  const home = tmpHome("nyra-lease-");
  try {
    const team = makeTeam(home);
    const denied = acquireTeamLease(home, team.id, "bot-a");
    expect(denied.granted).toBe(false);
    expect(denied.reason).toContain("只给参谋长");
    const first = acquireTeamLease(home, team.id, "chief-a");
    expect(first.granted).toBe(true);
    if (first.granted) expect(first.lease.epoch).toBe(1);
    const second = acquireTeamLease(home, team.id, "chief-a");
    expect(second.granted).toBe(true);
    if (second.granted) expect(second.lease.epoch).toBe(1);
    const lease = getTeamLease(home, team.id);
    expect(lease?.lead).toBe("chief-a");
    // 租约 TTL 10 分钟：过期时间比现在晚约 10 分钟。
    expect(Date.parse(lease!.expiresAt) - Date.now()).toBeGreaterThan(TEAM_LEASE_TTL_MS - 60 * 1000);
    expect(Date.parse(lease!.expiresAt) - Date.now()).toBeLessThanOrEqual(TEAM_LEASE_TTL_MS);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("TeamLeaseBatch2.test_epoch_check_and_transfer_bumps_epoch", () => {
  const home = tmpHome("nyra-lease-");
  try {
    const team = makeTeam(home);
    acquireTeamLease(home, team.id, "chief-a");
    expect(checkTeamEpoch(home, team.id, 1, "chief-a").ok).toBe(true);
    expect(checkTeamEpoch(home, team.id, 1, "bot-a").ok).toBe(false);
    const transferred = transferTeamLead(home, team.id, "chief-a", "bot-a");
    expect(transferred.granted).toBe(true);
    if (transferred.granted) expect(transferred.lease.epoch).toBe(2);
    const stale = checkTeamEpoch(home, team.id, 1, "chief-a");
    expect(stale.ok).toBe(false);
    // 旧 lead 拿旧纪元来：holder 校验先拦（已不是当前 lead），拒绝即可。
    if (!stale.ok) expect(stale.reason.length).toBeGreaterThan(0);
    expect(checkTeamEpoch(home, team.id, 2, "bot-a").ok).toBe(true);
    expect(routeToLead(home, team.id)).toEqual({ lead: "bot-a", epoch: 2 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("TeamLeaseBatch2.test_no_lease_means_fail_closed", () => {
  const home = tmpHome("nyra-lease-");
  try {
    const team = makeTeam(home);
    expect(checkTeamEpoch(home, team.id, 1).ok).toBe(false);
    expect(() => routeToLead(home, team.id)).toThrow("没有活的 lead 租约");
    expect(getTeamLease(home, team.id)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("TeamLeaseBatch2.test_release_only_holder", () => {
  const home = tmpHome("nyra-lease-");
  try {
    const team = makeTeam(home);
    acquireTeamLease(home, team.id, "chief-a");
    expect(releaseTeamLease(home, team.id, "bot-a")).toBe(false);
    expect(releaseTeamLease(home, team.id, "chief-a")).toBe(true);
    expect(getTeamLease(home, team.id)).toBeNull();
    // 释放后重拿：纪元从 1 重新开始（旧租约已删干净）。
    const again = acquireTeamLease(home, team.id, "chief-a");
    expect(again.granted).toBe(true);
    if (again.granted) expect(again.lease.epoch).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
