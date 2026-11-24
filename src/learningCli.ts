// src/learningCli.ts — `nyra learn` 命令行（O5：记忆/学习的产品化）。
//
// 学习队列是用户可见的产品面：list 看队列、scan 从已有队列收提案、
// show 看一条、approve/reject 人工审核、publish 落盘、share 分享给组织、
// remove 删待定/已拒的提案。学习永远要人批：没有自动批准；publish 须 --yes。
// 退出码：0 成功、1 业务错误（不存在、状态不对、证据门拦下等）、2 用法错误。
import { readFileSync } from "node:fs";
import { getCurrentAccount } from "./accounts.ts";
import {
  LEARNING_KINDS,
  LEARNING_STATUSES,
  LearningError,
  approveLearning,
  getLearning,
  listLearning,
  normalizeOwner,
  proposeLearning,
  publishLearning,
  rejectLearning,
  removeLearning,
  scanLearning,
  shareLearning,
  type LearningKind,
  type LearningStatus,
} from "./learning.ts";

const LEARN_USAGE = "用法：\n"
  + " nyra learn list [--owner <账号id>] [--status pending|approved|rejected|published] [--kind memory|skill|agent] [--shared] [--json]   看学习队列\n"
  + " nyra learn scan [--owner <账号id>]   从候选记忆与技能草稿里收新提案进队列（已收过的不重复）\n"
  + " nyra learn show <id> [--owner <账号id>]   看一条提案：来源、依据、状态、发布落点\n"
  + " nyra learn propose <memory|skill|agent> --title <标题> --summary <摘要> --source <来源> --ref <引用> [--evidence <依据1;依据2>] [--content <记忆正文>] [--text-file <声明文件>]   手动提一条提案\n"
  + " nyra learn approve <id> [--owner <账号id>]   批准一条待定提案（记忆过证据门、技能看草稿、agent 先校验声明）\n"
  + " nyra learn reject <id> [--reason <原因>] [--owner <账号id>]   拒绝一条待定/已批准的提案\n"
  + " nyra learn publish <id> --yes [--owner <账号id>]   发布一条已批准的提案（记忆进库 / 技能安装 / 声明落盘）\n"
  + " nyra learn share <id> --org <组织> [--owner <账号id>]   把一条已批准/已发布的提案分享给组织\n"
  + " nyra learn remove <id> --yes [--owner <账号id>]   从队列里删一条待定/已拒的提案\n"
  + "学习永远要人批：没有自动批准；记忆发布前必须过证据门（依据须是用户原话逐字引用）。详见 docs/learning.md";

const KIND_CN: Record<LearningKind, string> = { memory: "记忆", skill: "技能", agent: "agent" };
const STATUS_CN: Record<LearningStatus, string> = { pending: "待定", approved: "已批准", rejected: "已拒绝", published: "已发布" };

export async function handleLearn(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const err = (msg: string): number => {
    process.stderr.write(`错误：${msg}\n`);
    return 1;
  };
  const usageErr = (msg: string): number => {
    process.stderr.write(`${msg}\n${LEARN_USAGE}\n`);
    return 2;
  };
  // owner：没给 --owner 时按当前登录账号，没有登录按 default。
  const owner = async (): Promise<string> => {
    const flag = flagValue("--owner");
    if (flag !== undefined) return normalizeOwner(flag);
    try {
      const account = await getCurrentAccount(home);
      return account ? normalizeOwner(account.id) : "default";
    } catch {
      return "default";
    }
  };
  try {
    if (!cmd || cmd === "help" || cmd === "--help") {
      process.stdout.write(LEARN_USAGE + "\n");
      return 0;
    }
    if (cmd === "list") {
      const who = await owner();
      const status = flagValue("--status");
      if (status !== undefined && !(LEARNING_STATUSES as readonly string[]).includes(status)) {
        return usageErr(`status 只认 ${LEARNING_STATUSES.join(" / ")}`);
      }
      const kind = flagValue("--kind");
      if (kind !== undefined && !(LEARNING_KINDS as readonly string[]).includes(kind)) {
        return usageErr(`kind 只认 ${LEARNING_KINDS.join(" / ")}`);
      }
      const items = listLearning(home, who, {
        ...(status ? { status: status as LearningStatus } : {}),
        ...(kind ? { kind: kind as LearningKind } : {}),
        ...(has("--shared") ? { shared: true } : {}),
      });
      if (has("--json")) {
        process.stdout.write(JSON.stringify(items, null, 2) + "\n");
        return 0;
      }
      if (!items.length) {
        process.stdout.write("学习队列是空的：先跑 nyra learn scan 从候选记忆与技能草稿里收提案。\n");
        return 0;
      }
      for (const p of items) {
        process.stdout.write(`${p.id}\t${KIND_CN[p.kind]}\t${STATUS_CN[p.status]}\t${p.title}\t来源：${p.source}${p.shared_to.length ? `\t已分享给 ${p.shared_to.length} 个组织` : ""}\n`);
      }
      return 0;
    }
    if (cmd === "scan") {
      const who = await owner();
      const { created, skipped } = scanLearning(home, who);
      if (!created.length) {
        process.stdout.write(`没收到新提案（已收过或已决定过 ${skipped} 条）。\n`);
        return 0;
      }
      process.stdout.write(`收到 ${created.length} 条新提案：\n`);
      for (const p of created) {
        process.stdout.write(` ${p.id}\t${KIND_CN[p.kind]}\t${p.title}\n`);
      }
      process.stdout.write("审核：nyra learn approve <id> / nyra learn reject <id>。\n");
      return 0;
    }
    if (cmd === "show") {
      const id = argv[1];
      if (!id) return usageErr("用法：nyra learn show <id>");
      const who = await owner();
      const p = getLearning(home, who, id);
      if (!p) return err(`找不到学习提案 ${id}（先 nyra learn list 看看）`);
      process.stdout.write(`${p.title}\n种类：${KIND_CN[p.kind]}；状态：${STATUS_CN[p.status]}；来源：${p.source}\n摘要：${p.summary}\n引用：${p.ref}\n`);
      if (p.evidence.length) {
        process.stdout.write("依据：\n");
        for (const e of p.evidence) process.stdout.write(` - ${e}\n`);
      }
      if (p.published_ref) process.stdout.write(`发布落点：${p.published_ref}\n`);
      if (p.shared_to.length) process.stdout.write(`已分享给组织：${p.shared_to.join("、")}${p.shared_at ? `（${p.shared_at}）` : ""}\n`);
      if (p.decision_reason) process.stdout.write(`决定原因：${p.decision_reason}\n`);
      process.stdout.write(`创建：${p.created_at}${p.decided_at ? `；决定：${p.decided_at}` : ""}\n`);
      return 0;
    }
    if (cmd === "propose") {
      const kind = argv[1] as LearningKind | undefined;
      if (!kind || !(LEARNING_KINDS as readonly string[]).includes(kind)) {
        return usageErr("用法：nyra learn propose <memory|skill|agent> --title <标题> --summary <摘要> --source <来源> --ref <引用> …");
      }
      const title = flagValue("--title");
      const summary = flagValue("--summary");
      const source = flagValue("--source");
      const ref = flagValue("--ref");
      if (!title || !summary || !source || !ref) {
        return usageErr("propose 须给 --title、--summary、--source、--ref");
      }
      const who = await owner();
      const evidence = flagValue("--evidence")?.split(";").map((e) => e.trim()).filter(Boolean) ?? [];
      const payload: Record<string, unknown> = {};
      if (kind === "memory") {
        const content = flagValue("--content");
        if (!content) return usageErr("记忆提案须给 --content <记忆正文>");
        payload.content = content;
        payload.evidenceSource = evidence.join("\n");
      }
      if (kind === "agent") {
        const textFile = flagValue("--text-file");
        if (!textFile) return usageErr("agent 提案须给 --text-file <声明文件>");
        try {
          payload.text = readFileSync(textFile, "utf-8");
        } catch {
          return err(`声明文件读不到：${textFile}`);
        }
      }
      const p = proposeLearning(home, who, { kind, title, summary, source, evidence, ref, payload });
      process.stdout.write(`提案已进队列：${p.id}（${KIND_CN[p.kind]}，待定）\n`);
      return 0;
    }
    if (cmd === "approve") {
      const id = argv[1];
      if (!id) return usageErr("用法：nyra learn approve <id>");
      const who = await owner();
      const result = approveLearning(home, who, id);
      if (!result.ok) return err(result.message ?? "批准失败");
      process.stdout.write(`已批准：${result.proposal!.title}（下一步：nyra learn publish ${id} --yes）\n`);
      return 0;
    }
    if (cmd === "reject") {
      const id = argv[1];
      if (!id) return usageErr("用法：nyra learn reject <id> [--reason <原因>]");
      const who = await owner();
      const result = rejectLearning(home, who, id, flagValue("--reason"));
      if (!result.ok) return err(result.message ?? "拒绝失败");
      process.stdout.write(`已拒绝：${result.proposal!.title}\n`);
      return 0;
    }
    if (cmd === "publish") {
      const id = argv[1];
      if (!id) return usageErr("用法：nyra learn publish <id> --yes");
      if (!has("--yes")) {
        process.stderr.write("发布会写盘（记忆进库 / 技能安装 / 声明落盘），须加 --yes 确认\n");
        return 2;
      }
      const who = await owner();
      const result = publishLearning(home, who, id);
      if (!result.ok) return err(result.message ?? "发布失败");
      process.stdout.write(`已发布：${result.proposal!.title}（落点：${result.proposal!.published_ref}）\n`);
      return 0;
    }
    if (cmd === "share") {
      const id = argv[1];
      const org = flagValue("--org");
      if (!id || !org) return usageErr("用法：nyra learn share <id> --org <组织>");
      const who = await owner();
      const result = shareLearning(home, who, id, org);
      if (!result.ok) return err(result.message ?? "分享失败");
      process.stdout.write(`已分享给组织 ${org}：${result.proposal!.title}\n`);
      return 0;
    }
    if (cmd === "remove") {
      const id = argv[1];
      if (!id) return usageErr("用法：nyra learn remove <id> --yes");
      if (!has("--yes")) {
        process.stderr.write("从队列里删提案须加 --yes 确认\n");
        return 2;
      }
      const who = await owner();
      const result = removeLearning(home, who, id);
      if (!result.ok) return err(result.message ?? "删除失败");
      process.stdout.write(`已从队列里删掉：${result.proposal!.title}\n`);
      return 0;
    }
  } catch (e) {
    if (e instanceof LearningError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
  process.stderr.write(LEARN_USAGE + "\n");
  return 2;
}
