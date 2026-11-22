// tests/node/test-peer-proposals-batch2.test.ts — 第 2 批 G-P1-10：对方写操作默认进提议。
// 全部用临时 home，不调模型。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptPeerProposal,
  declinePeerProposal,
  getPeerProposal,
  listPeerProposals,
  markProposalExecuted,
  recordPeerProposal,
} from "../../src/peerProposals.ts";
import type { ContentLabel } from "../../src/contentLabels.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const peerLabel: ContentLabel = { integrity: "untrusted", confidentiality: "internal", principal: "peer", reason: "对端任务" };

test("PeerProposalsBatch2.test_record_accept_decline", () => {
  const home = tmpHome("nyra-proposal-");
  try {
    const p = recordPeerProposal(home, {
      peer: "alice", tool: "write_file",
      args: { path: "note.txt", content: "hi" },
      label: peerLabel, reason: "对方写操作进提议",
    });
    expect(p.status).toBe("pending");
    expect(p.id.startsWith("prop_")).toBe(true);
    expect(getPeerProposal(home, p.id)?.tool).toBe("write_file");
    const accepted = acceptPeerProposal(home, p.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.decided_by).toBe("owner");
    // 接受只标状态，不自动执行：run_id 仍为空，执行须机主上下文另跑。
    expect(accepted.run_id).toBeNull();
    const executed = markProposalExecuted(home, p.id, "run-123");
    expect(executed.status).toBe("executed");
    expect(executed.run_id).toBe("run-123");
    const p2 = recordPeerProposal(home, {
      peer: "bob", tool: "shell", args: { command: "ls" }, label: peerLabel, reason: "对方命令进提议",
    });
    const declined = declinePeerProposal(home, p2.id, "owner");
    expect(declined.status).toBe("declined");
    expect(listPeerProposals(home, "pending").length).toBe(0);
    expect(listPeerProposals(home, "declined").length).toBe(1);
    expect(listPeerProposals(home).length).toBe(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PeerProposalsBatch2.test_accept_twice_throws", () => {
  const home = tmpHome("nyra-proposal-");
  try {
    const p = recordPeerProposal(home, {
      peer: "alice", tool: "write_file", args: { path: "a.txt", content: "x" }, label: peerLabel, reason: "测试",
    });
    acceptPeerProposal(home, p.id);
    expect(() => acceptPeerProposal(home, p.id)).toThrow("不能再接受");
    expect(() => declinePeerProposal(home, "no-such")).toThrow("没有这个提议");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
