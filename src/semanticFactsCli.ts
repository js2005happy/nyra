// src/semanticFactsCli.ts — `nyra memory facts`：查语义事实。
//
//   nyra memory facts list [--all] [--status active|superseded|expired]
//   nyra memory facts show <fact_…>
//   nyra memory facts search <关键词>
//   nyra memory facts expire   手动清扫到期事实（只标过期，不删除）
//
// 事实只在确认进库时产生（见 memoryProposals.ts 的 approveMemoryProposal）；
// 这里只读不写——expire 也只是把到期的标过期，不删任何记录。

import {
  expireStaleFacts,
  findFactContradictions,
  formatSemanticFactResults,
  getSemanticFact,
  listSemanticFacts,
  searchSemanticFacts,
} from "./semanticFacts.ts";

function printUsage(): void {
  process.stdout.write(
    "用法：nyra memory facts <list|show|search|expire> [选项]\n" +
      "  list [--all] [--status active|superseded|expired]  列出事实（默认只看生效中的）\n" +
      "  show <fact_…>   看一条事实的详情与取代链\n" +
      "  search <关键词>  按关键词检索事实\n" +
      "  expire   手动清扫到期事实（只标过期，不删除）\n" +
      "事实是确认进库的记忆的原子化视图，带时间戳与有效期；同一主题新旧并存\n" +
      "时旧事实标被取代，两边都留着可查。详见 docs/memory.md。\n",
  );
}

export async function handleSemanticFacts(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action || action === "help" || action === "--help") {
    printUsage();
    return action ? 0 : 2;
  }

  if (action === "list") {
    const all = argv.includes("--all");
    const statusIdx = argv.indexOf("--status");
    const status = statusIdx >= 0 ? argv[statusIdx + 1] : undefined;
    if (status !== undefined && status !== "active" && status !== "superseded" && status !== "expired") {
      process.stderr.write("错误：--status 只认 active / superseded / expired。\n");
      return 2;
    }
    const facts = listSemanticFacts(home, {
      includeSuperseded: all || status === "superseded",
      includeExpired: all || status === "expired",
      status: status as "active" | "superseded" | "expired" | undefined,
    });
    const contradictions = findFactContradictions(listSemanticFacts(home));
    process.stdout.write(`语义事实（${facts.length} 条）\n`);
    if (contradictions.length) {
      process.stdout.write(`其中有 ${contradictions.length} 组主题存在新旧并存的事实：${contradictions.map((c) => c.subject).join("、")}\n`);
    }
    for (const f of facts) {
      const state = f.status === "active" ? "生效中" : f.status === "superseded" ? "已被取代" : "已过期";
      const until = f.validUntil ? `有效期至 ${f.validUntil.slice(0, 10)}` : "无有效期";
      const replaced = f.supersededBy ? `（被 ${f.supersededBy} 取代）` : "";
      const entry = f.entryId ? `记忆 ${f.entryId}` : "未关联记忆条目";
      process.stdout.write(`- [${f.id}] ${f.subject}：${f.content}\n  ${state}${replaced}；${f.createdAt.slice(0, 10)} 起生效，${until}；来源：${entry}；会话 ${f.sourceSession}\n`);
    }
    return 0;
  }

  if (action === "show") {
    const id = argv[1];
    if (!id) {
      process.stderr.write("错误：show 须给事实 id，如 nyra memory facts show fact_0123456789ab。\n");
      return 2;
    }
    const got = getSemanticFact(home, id);
    if (!got) {
      process.stderr.write(`没有这条事实：${id}\n`);
      return 2;
    }
    const { fact, history } = got;
    const state = fact.status === "active" ? "生效中" : fact.status === "superseded" ? "已被取代" : "已过期";
    process.stdout.write(`[${fact.id}] ${fact.subject}\n`);
    process.stdout.write(`  事实：${fact.content}\n`);
    process.stdout.write(`  类别：${fact.category}；状态：${state}\n`);
    process.stdout.write(`  生效：${fact.createdAt.slice(0, 10)} 起；${fact.validUntil ? `有效期至 ${fact.validUntil.slice(0, 10)}` : "无有效期"}\n`);
    process.stdout.write(`  来源：${fact.entryId ? `记忆 ${fact.entryId}` : "未关联记忆条目"}；会话 ${fact.sourceSession}\n`);
    process.stdout.write(`  依据：${fact.evidenceQuotes.map((q) => `“${q}”`).join("；")}\n`);
    if (fact.supersedes) process.stdout.write(`  取代了：${fact.supersedes}\n`);
    if (fact.supersededBy) process.stdout.write(`  被取代：${fact.supersededBy}\n`);
    process.stdout.write(`  修订历史（${history.length} 版）：\n`);
    for (const rev of history) {
      process.stdout.write(`    - v${rev.revision} ${rev.updatedAt.slice(0, 10)} ${rev.status}（${rev.actor}）\n`);
    }
    return 0;
  }

  if (action === "search") {
    const query = argv.slice(1).join(" ").trim();
    if (!query) {
      process.stderr.write("错误：search 须给关键词，如 nyra memory facts search 套餐。\n");
      return 2;
    }
    const hits = searchSemanticFacts(home, query, { limit: 5 });
    if (!hits.length) {
      process.stdout.write("没找到相关的语义事实。\n");
      return 0;
    }
    process.stdout.write(formatSemanticFactResults(hits) + "\n");
    return 0;
  }

  if (action === "expire") {
    const { expired } = expireStaleFacts(home);
    if (!expired.length) {
      process.stdout.write("没有到期的语义事实。\n");
      return 0;
    }
    process.stdout.write(`清扫了 ${expired.length} 条到期事实（只标过期，不删除）：${expired.join("、")}\n`);
    return 0;
  }

  process.stderr.write(`未知操作：${action}\n`);
  printUsage();
  return 2;
}
