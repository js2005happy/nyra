// tests/node/test-sessions-39-verify.test.ts — 缺口 39 第二批：会内委派交活按契约跑验收。
// 全部用临时 home 与假对端，不连真实渠道、不拨真实电话、不花真实 token。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptDelegation,
  completeDelegation,
  createSession,
  delegateInSession,
  findSession,
  handleSession,
  loadSessionBook,
  verifyDelegation,
} from "../../src/session.ts";
import { getContract } from "../../src/contract.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** 建一个带两条验收标准的委派（检查编号 a1、a2），已接下。 */
async function seededDelegation(home: string): Promise<{ sessionId: string; delegationId: string }> {
  const session = createSession(home, "周会");
  const delegation = await delegateInSession(home, {
    sessionId: session.id, from: "owner", to: "self",
    task: "把本周的订单异常整理成清单",
    acceptance: ["清单含全部异常订单", "每单都标了处理人"],
  });
  acceptDelegation(home, session.id, delegation.id, "self");
  return { sessionId: session.id, delegationId: delegation.id };
}

test("Sessions39VerifyTest.test_complete_without_marks_refuses", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    await expect(completeDelegation(home, sessionId, delegationId, "self", { note: "已出清单" }))
      .rejects.toThrow("还没确认完");
    // 什么都没改：委派还是 accepted，契约还是 active、没有验收记录。
    const delegation = findSession(loadSessionBook(home), sessionId)!.delegations[0];
    expect(delegation.status).toBe("accepted");
    const contract = getContract(home, delegation.contract_id!)!;
    expect(contract.status).toBe("active");
    expect(contract.attempts).toEqual([]);
  } finally {
    cleanup(home);
  }
});

test("Sessions39VerifyTest.test_complete_unknown_check_id_refuses", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    await expect(completeDelegation(home, sessionId, delegationId, "self", { confirm: ["a1", "a9"] }))
      .rejects.toThrow("验收标准里没有：a9");
    await expect(completeDelegation(home, sessionId, delegationId, "self", { confirm: ["a1"], fail: ["a1"] }))
      .rejects.toThrow("不能既通过又不通过");
    const delegation = findSession(loadSessionBook(home), sessionId)!.delegations[0];
    expect(delegation.status).toBe("accepted");
  } finally {
    cleanup(home);
  }
});

test("Sessions39VerifyTest.test_complete_all_confirm_accepts", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    const done = await completeDelegation(home, sessionId, delegationId, "self", {
      note: "清单已出，共 3 单", confirm: ["a1", "a2"],
    });
    expect(done.status).toBe("completed");
    expect(done.note).toBe("清单已出，共 3 单");
    const contract = getContract(home, done.contract_id!)!;
    expect(contract.status).toBe("accepted");
    expect(contract.attempts.length).toBe(1);
    expect(contract.attempts[0].verdict).toBe("accepted");
    expect(contract.attempts[0].passed).toBe(2);
    expect(contract.attempts[0].total).toBe(2);
    // 验收结论进了证据链（verify 再读，结论还是 accepted）。
    const { attempt } = await verifyDelegation(home, sessionId, delegationId);
    expect(attempt.verdict).toBe("accepted");
  } finally {
    cleanup(home);
  }
});

test("Sessions39VerifyTest.test_complete_one_fail_rejects", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    const done = await completeDelegation(home, sessionId, delegationId, "self", {
      note: "清单出了，但处理人没标", confirm: ["a1"], fail: ["a2"],
    });
    expect(done.status).toBe("rejected");
    const contract = getContract(home, done.contract_id!)!;
    expect(contract.status).toBe("rejected");
    expect(contract.attempts[0].verdict).toBe("rejected");
    expect(contract.attempts[0].passed).toBe(1);
    // 已 rejected 的委派不能再交活。
    await expect(completeDelegation(home, sessionId, delegationId, "self", { confirm: ["a1", "a2"] }))
      .rejects.toThrow("不能再交活");
  } finally {
    cleanup(home);
  }
});

test("Sessions39VerifyTest.test_verify_is_readonly", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    const before = await verifyDelegation(home, sessionId, delegationId);
    expect(before.attempt.verdict).toBe("pending");
    expect(before.attempt.pending).toBe(2);
    // 只读：不写账本、不改状态，契约还是 active、没有验收记录。
    const delegation = findSession(loadSessionBook(home), sessionId)!.delegations[0];
    expect(delegation.status).toBe("accepted");
    const contract = getContract(home, delegation.contract_id!)!;
    expect(contract.attempts).toEqual([]);
    expect(await handleSession(["verify", sessionId, delegationId], home)).toBe(0);
  } finally {
    cleanup(home);
  }
});

test("Sessions39VerifyTest.test_cli_complete_requires_confirm_and_reports_reject", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    // 不带 --confirm：拒绝交活，退出码非 0。
    expect(await handleSession(["complete", sessionId, delegationId, "--by", "self", "--note", "已出清单"], home)).toBe(1);
    // 只确认一项：同样拒绝。
    expect(await handleSession(["complete", sessionId, delegationId, "--by", "self", "--confirm", "a1"], home)).toBe(1);
    // 一项不通过：交活跑完但结论是 rejected，退出码 1，委派标 rejected。
    expect(await handleSession(["complete", sessionId, delegationId, "--by", "self", "--confirm", "a1", "--fail", "a2"], home)).toBe(1);
    const delegation = findSession(loadSessionBook(home), sessionId)!.delegations[0];
    expect(delegation.status).toBe("rejected");
  } finally {
    cleanup(home);
  }
});

test("Sessions39VerifyTest.test_cli_complete_all_confirm_and_show", async () => {
  const home = tmpHome("nyra-ses39v-");
  try {
    const { sessionId, delegationId } = await seededDelegation(home);
    expect(await handleSession(["verify", sessionId, delegationId], home)).toBe(0);
    expect(await handleSession(["complete", sessionId, delegationId, "--by", "self", "--note", "清单已出", "--confirm", "a1", "--confirm", "a2"], home)).toBe(0);
    const delegation = findSession(loadSessionBook(home), sessionId)!.delegations[0];
    expect(delegation.status).toBe("completed");
    // show 里能看到验收状态。
    expect(await handleSession(["show", sessionId], home)).toBe(0);
  } finally {
    cleanup(home);
  }
});
