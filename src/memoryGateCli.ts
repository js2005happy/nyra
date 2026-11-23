// src/memoryGateCli.ts — `nyra memory` 里证据门那几个子命令（remember /
// entries / entry / update / rejections）。只读 + 用户本人直接写，不走
// 模型工具；`nyra memory search/forget/export/import` 仍在 cli.ts 的
// handleMemory 里（缺口 1/2 的老入口，不动）。
//
// 用法：
//   nyra memory remember <正文> --quote <用户原话> [--quote ...] [--subject <主题>]
//                      [--scope user|project] [--project <id>] [--status proposed|confirmed]
//                      [--ref <出处> ...]
//   nyra memory entries [--scope user|project] [--status confirmed|proposed|deleted] [--limit N]
//   nyra memory entry <id>             看一条 + 全部修订历史
//   nyra memory update <id> --content <新正文> --quote <用户原话> [--subject ...] [--status ...]
//   nyra memory rejections [--limit N]  最近被证据门拦下的写入
//
// CLI 是用户本人直接写：引用由用户自己提供，只验条数与长度（逐字对照
// 只在模型工具路径跑，那里有当前用户回合可对照）。引用与正文含密钥时
// 同样拒绝，拒绝记录里不记密钥原文。
import {
  getMemoryGateEntry, listGateRejections, listMemoryGateEntries, recordGateRejection,
  rememberMemoryEntry, updateMemoryEntry, MemoryGateError,
  type MemoryGateScope, type MemoryGateStatus,
} from "./memoryGate.ts";
import { OrgError, canOrg, currentActorId, getOrg } from "./orgs.ts";
import { canAccessMemoryEntry, recordIsolationViolation } from "./orgSharing.ts";

function usage(): string {
  return [
    "用法：",
    "  nyra memory remember <正文> --quote <用户原话> [--quote ...] [--subject <主题>] [--scope user|project|org] [--project <id>] [--org <组织>] [--status proposed|confirmed] [--ref <出处> ...]",
    "  nyra memory entries [--scope user|project|org] [--org <组织>] [--status confirmed|proposed|deleted] [--limit N]",
    "  nyra memory entry <id>",
    "  nyra memory update <id> --content <新正文> --quote <用户原话> [--subject ...] [--status ...]",
    "  nyra memory rejections [--limit N]",
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

function formatEntryLine(e: { id: string; scope: string; orgId?: string | null; subject: string; status: string; revision: number; updatedAt: string }): string {
  return `- [${e.id}] ${e.subject}（${e.scope}${e.orgId ? `:${e.orgId}` : ""}，${e.status}，第 ${e.revision} 版，${e.updatedAt.slice(0, 10)}）`;
}

export async function handleMemoryGate(argv: string[], home: string): Promise<number> {
  const sub = argv[0];
  if (sub === "remember") {
    const { positional, flags } = parseFlags(argv.slice(1));
    const content = positional.join(" ").trim();
    const quotes = flags.get("quote") ?? [];
    const subject = flagOne(flags, "subject") ?? "";
    let scope = (flagOne(flags, "scope") ?? "user") as MemoryGateScope;
    const projectId = flagOne(flags, "project") ?? null;
    const orgRef = flagOne(flags, "org");
    let orgId: string | null = null;
    if (orgRef) {
      if (flagOne(flags, "scope") && flagOne(flags, "scope") !== "org") {
        process.stderr.write("--org 只能和 --scope org 一起用。\n" + usage());
        return 2;
      }
      scope = "org";
      try {
        const org = getOrg(home, orgRef);
        orgId = org.id;
        const actor = await currentActorId(home);
        if (!(await canOrg(home, org.id, actor, "write"))) {
          recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "memory", detail: `在组织 ${org.name} 里写记忆被拒绝` });
          process.stderr.write(`写不进去：${actor} 没有 ${org.name} 的写权限。\n`);
          return 1;
        }
      } catch (err) {
        if (err instanceof OrgError) {
          process.stderr.write(`写不进去：${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    const status = (flagOne(flags, "status") ?? "confirmed") as MemoryGateStatus;
    const sourceRefs = flags.get("ref") ?? [];
    if (!content) {
      process.stderr.write("remember 须给正文。\n" + usage());
      return 2;
    }
    try {
      const entry = rememberMemoryEntry(home, {
        scope, projectId, orgId, subject: subject || content.slice(0, 40), content, sourceRefs, status, evidenceQuotes: quotes,
      }, null, { actor: "cli", checkVerbatim: false });
      process.stdout.write(`已记入结构化记忆 [${entry.id}]（第 1 版，${entry.status}）。\n`);
      return 0;
    } catch (err) {
      if (err instanceof MemoryGateError) {
        recordGateRejection(home, { action: "remember", reason: err.reason, detail: err.message, subject: subject || content.slice(0, 40) || null, scope });
        process.stderr.write(`写不进去：${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
  if (sub === "entries") {
    const { flags } = parseFlags(argv.slice(1));
    const scope = flagOne(flags, "scope") as MemoryGateScope | undefined;
    const status = flagOne(flags, "status") as MemoryGateStatus | undefined;
    const limitRaw = flagOne(flags, "limit");
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    const orgRef = flagOne(flags, "org");
    if (orgRef) {
      try {
        const org = getOrg(home, orgRef);
        const actor = await currentActorId(home);
        if (!(await canOrg(home, org.id, actor, "read"))) {
          recordIsolationViolation(home, { orgId: org.id, accountId: actor, what: "memory", detail: `列出组织 ${org.name} 的记忆被拒绝` });
          process.stderr.write(`看不了：${actor} 没有 ${org.name} 的读权限。\n`);
          return 1;
        }
        const entries = listMemoryGateEntries(home, { scope: "org", orgId: org.id, status, limit });
        if (!entries.length) {
          process.stdout.write(`组织 ${org.name} 的记忆里没有条目。\n`);
          return 0;
        }
        for (const e of entries) process.stdout.write(formatEntryLine(e) + "\n");
        return 0;
      } catch (err) {
        if (err instanceof OrgError) {
          process.stderr.write(`${err.message}\n`);
          return 1;
        }
        throw err;
      }
    }
    const entries = listMemoryGateEntries(home, { scope, status, limit });
    if (!entries.length) {
      process.stdout.write("结构化记忆里没有条目。\n");
      return 0;
    }
    for (const e of entries) process.stdout.write(formatEntryLine(e) + "\n");
    return 0;
  }
  if (sub === "entry") {
    const id = argv[1];
    if (!id) {
      process.stderr.write("entry 须给条目 id。\n" + usage());
      return 2;
    }
    const found = getMemoryGateEntry(home, id);
    if (!found) {
      process.stderr.write(`找不到记忆条目 ${id}。\n`);
      return 1;
    }
    const { entry, history } = found;
    if (entry.orgId) {
      const actor = await currentActorId(home);
      if (!(await canAccessMemoryEntry(home, entry, actor))) {
        process.stderr.write(`看不了：${actor} 没有该组织记忆的读权限（越权访问已记进隔离违反记录）。\n`);
        return 1;
      }
    }
    process.stdout.write(`[${entry.id}] ${entry.subject}\n`);
    process.stdout.write(`范围：${entry.scope}${entry.projectId ? `（${entry.projectId}）` : ""}${entry.orgId ? `（组织 ${entry.orgId}）` : ""}；状态：${entry.status}；当前第 ${entry.revision} 版；更新：${entry.updatedAt}\n`);
    process.stdout.write(`正文：${entry.content}\n`);
    if (entry.sourceRefs.length) process.stdout.write(`出处：${entry.sourceRefs.join("；")}\n`);
    process.stdout.write(`本版依据：${entry.evidenceQuotes.map((q) => `“${q}”`).join("；")}\n`);
    if (history.length > 1) {
      process.stdout.write(`修订历史（共 ${history.length} 版）：\n`);
      for (const rev of history) {
        process.stdout.write(`  第 ${rev.revision} 版（${rev.updatedAt.slice(0, 10)}，${rev.actor}）：${rev.content.slice(0, 80)}${rev.content.length > 80 ? "…" : ""}\n`);
      }
    }
    return 0;
  }
  if (sub === "update") {
    const id = argv[1];
    if (!id) {
      process.stderr.write("update 须给条目 id。\n" + usage());
      return 2;
    }
    const { flags } = parseFlags(argv.slice(2));
    const content = flagOne(flags, "content");
    const subject = flagOne(flags, "subject");
    const status = flagOne(flags, "status") as MemoryGateStatus | undefined;
    const quotes = flags.get("quote") ?? [];
    if (content === undefined && subject === undefined && status === undefined) {
      process.stderr.write("update 须给 --content / --subject / --status 至少一个。\n" + usage());
      return 2;
    }
    try {
      const entry = updateMemoryEntry(home, id, {
        content, subject, status, evidenceQuotes: quotes,
      }, null, { actor: "cli", checkVerbatim: false });
      process.stdout.write(`已更新 [${entry.id}] 到第 ${entry.revision} 版（${entry.status}）。\n`);
      return 0;
    } catch (err) {
      if (err instanceof MemoryGateError) {
        recordGateRejection(home, { action: "update", reason: err.reason, detail: err.message, subject: null, scope: null });
        process.stderr.write(`改不进去：${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
  if (sub === "rejections") {
    const { flags } = parseFlags(argv.slice(1));
    const limitRaw = flagOne(flags, "limit");
    const limit = limitRaw !== undefined ? Number(limitRaw) : 10;
    const rows = listGateRejections(home, limit);
    if (!rows.length) {
      process.stdout.write("证据门没有拦下过写入。\n");
      return 0;
    }
    for (const r of rows) {
      process.stdout.write(`- ${r.at.slice(0, 19)} ${r.action}：${r.detail}（${r.reason}${r.subject ? `，主题：${r.subject}` : ""}）\n`);
    }
    return 0;
  }
  process.stderr.write(usage());
  return 2;
}
