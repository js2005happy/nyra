// src/admissionCli.ts — G-P2-2 企业级准入账本的 CLI：`nyra admission`。
//
//   log [--kind <种>] [--actor <人>] [--subject <人>] [--circle <圈>]
//       [--since <ISO 时间>] [--until <ISO 时间>] [--limit <条数>] [--json]
//                                              查账本（新的在前）
//   show <id> [--json]                         看一条事件
//   who-approved <人> [--limit <条数>] [--json]  谁批了某人进群 / 拿 token
//   policy-history [--limit <条数>] [--json]   策略变更历史
//   export [--out <路径>]                      导出整本账本 JSONL（不给
//                                              --out 时打到 stdout；账本本身
//                                              只含元数据与指纹）
//
// 只读账本，不写账本、不改策略、不发 token。
import { resolveHome } from "./config.ts";
import {
  AdmissionError,
  exportAdmissions,
  exportAdmissionsToFile,
  getAdmission,
  listAdmissions,
  policyHistory,
  readAdmissions,
  whoApproved,
  ADMISSION_KINDS,
  type AdmissionEntry,
  type AdmissionKind,
} from "./admission.ts";

const USAGE = [
  "用法：",
  "  nyra admission log [--kind <种>] [--actor <人>] [--subject <人>] [--circle <圈>] [--since <ISO 时间>] [--until <ISO 时间>] [--limit <条数>] [--json]   查准入账本（新的在前；种只认 friend_approved、friend_declined、member_joined、member_left、policy_changed、token_issued、token_revoked）",
  "  nyra admission show <id> [--json]   看一条准入事件",
  "  nyra admission who-approved <人> [--limit <条数>] [--json]   谁批了某人（好友批准 / 进圈 / token 发放）",
  "  nyra admission policy-history [--limit <条数>] [--json]   策略变更历史（新的在前）",
  "  nyra admission export [--out <路径>]   导出整本账本 JSONL（不给 --out 时打到 stdout；账本只含元数据与指纹，不含 token 原文与消息原文）",
  "说明：准入账本是只追加的审计账（~/.nyra/admission-ledger.jsonl，0600），记好友批准、进圈/离圈、策略变更、token 发放/吊销；写账本失败不破坏原操作（批了就是批了，吊销照样立即生效），详见 docs/admission.md。",
].join("\n");

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function flagInt(argv: string[], flag: string): number | null {
  const raw = flagValue(argv, flag);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new AdmissionError(`${flag} 须是整数：${raw}`);
  return n;
}

function kindLabel(kind: AdmissionKind): string {
  switch (kind) {
    case "friend_approved": return "好友批准";
    case "friend_declined": return "好友拒绝";
    case "member_joined": return "进圈";
    case "member_left": return "离圈";
    case "policy_changed": return "策略变更";
    case "token_issued": return "token 发放";
    case "token_revoked": return "token 吊销";
  }
}

function printEntry(e: AdmissionEntry): void {
  const parts = [e.at, e.id, kindLabel(e.kind), `${e.actor} → ${e.subject}`];
  if (e.circle) parts.push(`圈 ${e.circle}`);
  if (e.role) parts.push(`角色 ${e.role}`);
  if (e.scope) parts.push(`能力 ${e.scope.join(",")}`);
  if (e.token_fingerprint) parts.push(`指纹 ${e.token_fingerprint}`);
  if (e.policy_version !== undefined) {
    parts.push(`策略 v${e.old_policy_version ?? 0} → v${e.policy_version}`);
  }
  if (e.policy_hash) parts.push(`哈希 ${e.policy_hash}`);
  if (e.detail) parts.push(e.detail);
  process.stdout.write(parts.join(" | ") + "\n");
}

function printList(entries: AdmissionEntry[], skipped: number): void {
  if (!entries.length) {
    process.stdout.write("准入账本里没有符合条件的事件。\n");
  } else {
    for (const e of entries) printEntry(e);
  }
  if (skipped > 0) {
    process.stdout.write(`（另有 ${skipped} 行坏行已跳过，请检查账本文件。）\n`);
  }
}

export async function handleAdmission(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  try {
    if (action === "log") {
      const kind = flagValue(argv, "--kind");
      if (kind !== null && !(ADMISSION_KINDS as readonly string[]).includes(kind)) {
        throw new AdmissionError(`--kind 不认 ${kind}（只认 ${ADMISSION_KINDS.join("、")}）`);
      }
      const limit = flagInt(argv, "--limit");
      const entries = listAdmissions(resolvedHome, {
        kind: (kind ?? undefined) as AdmissionKind | undefined,
        actor: flagValue(argv, "--actor") ?? undefined,
        subject: flagValue(argv, "--subject") ?? undefined,
        circle: flagValue(argv, "--circle") ?? undefined,
        since: flagValue(argv, "--since") ?? undefined,
        until: flagValue(argv, "--until") ?? undefined,
        limit: limit ?? undefined,
      });
      const { skipped } = readAdmissions(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
        return 0;
      }
      printList(entries, skipped);
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra admission show <id> [--json]\n");
        return 2;
      }
      const entry = getAdmission(resolvedHome, id);
      if (!entry) {
        process.stderr.write(`错误：准入账本里没有 ${id}\n`);
        return 1;
      }
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
        return 0;
      }
      printEntry(entry);
      return 0;
    }
    if (action === "who-approved") {
      const subject = argv[1] ?? "";
      if (!subject) {
        process.stderr.write("错误：用法：nyra admission who-approved <人> [--limit <条数>] [--json]\n");
        return 2;
      }
      const limit = flagInt(argv, "--limit");
      const entries = whoApproved(resolvedHome, subject, limit ?? 50);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
        return 0;
      }
      if (!entries.length) {
        process.stdout.write(`${subject} 没有批准类准入记录（好友批准 / 进圈 / token 发放）。\n`);
        return 0;
      }
      for (const e of entries) printEntry(e);
      return 0;
    }
    if (action === "policy-history") {
      const limit = flagInt(argv, "--limit");
      const entries = policyHistory(resolvedHome, limit ?? 50);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
        return 0;
      }
      if (!entries.length) {
        process.stdout.write("还没有策略变更记录。\n");
        return 0;
      }
      for (const e of entries) printEntry(e);
      return 0;
    }
    if (action === "export") {
      const out = flagValue(argv, "--out");
      if (out) {
        exportAdmissionsToFile(resolvedHome, out);
        process.stdout.write(`准入账本已导出到 ${out}（0600）。\n`);
        return 0;
      }
      process.stdout.write(exportAdmissions(resolvedHome));
      return 0;
    }
    process.stderr.write(`错误：未知动作 admission ${action}\n${USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
