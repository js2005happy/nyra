// src/memoryProposalCli.ts — `nyra memory` 里提炼与人工确认那几个子命令
// （extract / review）。候选只进待确认队列，不直接写库；确认进库时过
// 记忆证据门（逐字依据 + 秘密拦截），拒绝进拒绝账本留痕。
//
// 用法：
//   nyra memory extract <会话 id>        从该会话的对话记录里提炼候选记忆
//   nyra memory extract <会话 id> --model  再用小模型提炼一遍语义事实候选
//   nyra memory review [--status pending|confirmed|rejected]
//                                        列出待确认的候选（默认只看 pending）
//   nyra memory review approve <id> [--content <改后正文>]
//                                        确认一条候选进库（过证据门）
//   nyra memory review reject <id> [--reason <原因>]
//                                        拒绝一条候选（进拒绝账本）
//
// CLI 是用户本人直接操作：确认与拒绝都是用户的决定；提炼本身是确定性
// 规则抽取，不调模型。--model 是用户亲手点的额外一遍：用小模型（默认
// provider，默认 flash 级）提炼语义事实候选，同样只进待审队列，不直接
// 写库；没凭证或月度上限已到时如实报原因，不调模型。决定记进证据文件
// evidence/memory/（与 `nyra memory forget` 同款），运行事件
// memory_proposal_decided 的字段见 src/runs.ts 的 EVENT_FIELDS。

import { join } from "node:path";
import {
  approveMemoryProposal, extractMemoryProposals, listMemoryProposals,
  rejectMemoryProposal, type MemoryProposal,
} from "./memoryProposals.ts";
import { loadSession } from "./memory.ts";
import { EvidenceStore } from "./evidence.ts";

function usage(): string {
  return [
    "用法：",
    "  nyra memory extract <会话 id> [--model]",
    "  nyra memory review [--status pending|confirmed|rejected]",
    "  nyra memory review approve <id> [--content <改后正文>]",
    "  nyra memory review reject <id> [--reason <原因>]",
  ].join("\n") + "\n";
}

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        const list = flags.get(key) ?? [];
        list.push("");
        flags.set(key, list);
      } else {
        const list = flags.get(key) ?? [];
        list.push(next);
        flags.set(key, list);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagOne(flags: Map<string, string[]>, key: string): string | undefined {
  const list = flags.get(key);
  return list && list.length ? list[0] : undefined;
}

function formatProposalLine(p: MemoryProposal): string {
  const content = p.content.length > 80 ? p.content.slice(0, 80) + "…" : p.content;
  return `- [${p.id}] ${p.subject}（${p.category}，${p.status}，会话 ${p.sourceSession}，${p.createdAt.slice(0, 10)}）\n  ${content}`;
}

function saveDecisionEvidence(home: string, proposal: MemoryProposal, decision: string): void {
  try {
    new EvidenceStore(join(home, "evidence"), "memory").save(
      "memory_proposal_decided",
      `memory://proposal/${proposal.id}`,
      [
        `nyra memory review ${decision}（终端）`,
        `候选：[${proposal.id}] ${proposal.subject}（${proposal.category}）`,
        `正文：${proposal.content}`,
        `决定：${decision}${proposal.entryId ? `，进库条目 ${proposal.entryId}` : ""}${proposal.decisionReason ? `，原因：${proposal.decisionReason}` : ""}`,
        `来源会话：${proposal.sourceSession}`,
      ].join("\n"),
    );
  } catch { /* 证据写失败不破坏决定本身 */ }
}

export async function handleMemoryProposals(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (cmd === "extract") {
    const sessionId = argv[1];
    if (!sessionId) {
      process.stderr.write("extract 须给会话 id。\n" + usage());
      return 2;
    }
    let messages: Record<string, unknown>[] | null = null;
    try {
      messages = loadSession(sessionId, home);
    } catch {
      messages = null;
    }
    if (!messages) {
      process.stderr.write(`找不到会话 ${sessionId}。\n`);
      return 1;
    }
    const res = extractMemoryProposals(home, sessionId, messages);
    if (res.added > 0) {
      process.stdout.write(`从会话 ${sessionId} 提炼出 ${res.added} 条候选记忆（待确认，未进库）：\n`);
      for (const p of listMemoryProposals(home, { status: "pending" }).filter((x) => x.sourceSession === sessionId).slice(0, res.added)) {
        process.stdout.write(formatProposalLine(p) + "\n");
      }
      process.stdout.write("用 `nyra memory review` 逐条确认或拒绝。\n");
    } else {
      process.stdout.write(`会话 ${sessionId} 里没提炼出新候选记忆${res.skipped > 0 ? `（${res.skipped} 条已在队列或已进库，跳过）` : ""}。\n`);
    }
    // --model：用户亲手点的额外一遍，用小模型提炼语义事实候选，同样只进待审队列。
    if (argv.includes("--model")) {
      const { runModelExtraction, listSemanticFacts, normalizeFactContent } = await import("./semanticFacts.ts");
      const { addProposalDrafts } = await import("./memoryProposals.ts");
      const fr = await runModelExtraction(home, sessionId, { messages });
      if (fr.skippedReason) {
        process.stdout.write(`模型抽取没跑：${fr.skippedReason}。\n`);
      } else if (fr.drafts.length) {
        const known = new Set<string>();
        try {
          for (const f of listSemanticFacts(home, { includeSuperseded: true, includeExpired: true })) {
            known.add(normalizeFactContent(f.content));
          }
        } catch { /* 读事实库失败只影响去重 */ }
        const queued = addProposalDrafts(home, sessionId, fr.drafts, { isKnown: (norm) => known.has(norm) });
        if (queued.added > 0) {
          process.stdout.write(`模型又提炼出 ${queued.added} 条语义事实候选（待确认，未进库）。\n`);
        } else {
          process.stdout.write(`模型提炼的 ${fr.drafts.length} 条事实候选都已在队列或已成事实，跳过。\n`);
        }
        if (fr.spentUsd !== null) {
          process.stdout.write(`（模型抽取花了 $${fr.spentUsd.toFixed(6)}，已记进当月账本。）\n`);
        }
      } else {
        process.stdout.write("模型没从这会话里提炼出新的事实。\n");
      }
    }
    return 0;
  }
  if (cmd === "review") {
    const rest = argv.slice(1);
    if (rest[0] === "approve" || rest[0] === "reject") {
      const action = rest[0];
      const id = rest[1];
      if (!id) {
        process.stderr.write(`review ${action} 须给候选 id。\n` + usage());
        return 2;
      }
      if (action === "approve") {
        const { flags } = parseFlags(rest.slice(2));
        const content = flagOne(flags, "content");
        const res = approveMemoryProposal(home, id, { content });
        if (!res.ok || !res.proposal) {
          process.stderr.write(`确认不进去：${res.message ?? res.reason ?? "未知原因"}\n`);
          return 1;
        }
        saveDecisionEvidence(home, res.proposal, "approve");
        process.stdout.write(`已确认进库 [${res.proposal.id}] → 结构化记忆 [${res.entryId}]。\n`);
        return 0;
      }
      const { flags } = parseFlags(rest.slice(2));
      const reason = flagOne(flags, "reason");
      const res = rejectMemoryProposal(home, id, reason);
      if (!res.ok || !res.proposal) {
        process.stderr.write(`拒绝失败：${res.message ?? "未知原因"}\n`);
        return 1;
      }
      saveDecisionEvidence(home, res.proposal, "reject");
      process.stdout.write(`已拒绝 [${res.proposal.id}]（记进拒绝账本）。\n`);
      return 0;
    }
    const { flags } = parseFlags(rest);
    const statusRaw = flagOne(flags, "status") ?? "pending";
    if (statusRaw !== "pending" && statusRaw !== "confirmed" && statusRaw !== "rejected") {
      process.stderr.write("--status 只认 pending / confirmed / rejected。\n" + usage());
      return 2;
    }
    const list = listMemoryProposals(home, { status: statusRaw });
    if (!list.length) {
      process.stdout.write(statusRaw === "pending" ? "没有待确认的候选记忆。\n" : `没有${statusRaw === "confirmed" ? "已确认进库" : "已拒绝"}的候选记忆。\n`);
      return 0;
    }
    for (const p of list) process.stdout.write(formatProposalLine(p) + "\n");
    if (statusRaw === "pending") {
      process.stdout.write("确认：`nyra memory review approve <id>`；拒绝：`nyra memory review reject <id>`。\n");
    }
    return 0;
  }
  process.stderr.write(usage());
  return 2;
}
