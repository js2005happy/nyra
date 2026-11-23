// src/orgSharingCli.ts — 缺口 49 第二批：`nyra org` 里共享 Bot、租户隔离、
// 组织内私有目录的子命令（share / grants / learnings / workspace /
// file-read / cross-access / catalog / tasks / task-add / violations）。
//
// 由 orgCli.ts 的 handleOrg 末尾分发过来：不是第二批的子命令时返回 null，
// handleOrg 再回用法说明。退出码与第一批一致：0 成功、1 业务错误、
// 2 用法错误；破坏性操作（unshare / revoke-write / 批教学 / cross-access
// revoke / catalog publish-install-remove）须 --yes。
import { AccountStore } from "./accounts.ts";
import {
  ORG_OWNER_IDENTITY,
  OrgError,
  canOrg,
  currentActorId,
  getOrg,
  resolveAccountRef,
} from "./orgs.ts";
import {
  OrgSharingError,
  effectiveOrgIsolation,
  grantCrossAccess,
  grantSharedBotWrite,
  installOrgCatalogTemplate,
  listCrossAccess,
  listLearnings,
  listOrgCatalog,
  listOrgMemoryEntries,
  listOrgTasks,
  listSharedBots,
  listViolations,
  listWriteGrants,
  publishOrgCatalogTemplate,
  publishSharedBot,
  readOrgFile,
  removeOrgCatalogTemplate,
  reviewLearning,
  revokeCrossAccess,
  revokeSharedBotWrite,
  setOrgWorkspace,
  submitLearning,
  unshareBot,
} from "./orgSharing.ts";
import { addTask } from "./tasks.ts";

const SHARING_USAGE = "用法（第二批：共享 Bot / 租户隔离 / 组织内私有目录）：\n"
  + " nyra org share <组织> <bot-id> [--name <名>] [--to <邮箱,...>|all] [--desc <描述>]   发布 Bot 进组织共享（默认全组织成员可见，只读）\n"
  + " nyra org shared <组织>                        列出组织内在用的共享 Bot\n"
  + " nyra org unshare <组织> <bot-id> --yes       取消共享（Bot 主人、组织 admin 或机主）\n"
  + " nyra org grant-write <组织> <bot-id> <邮箱> <write_memory|write_file|send_message,...> [--expires <ISO>]   Bot 主人接受写授权\n"
  + " nyra org revoke-write <组织> <bot-id> <邮箱> --yes   回收写授权\n"
  + " nyra org grants <组织> <bot-id>               列出一个共享 Bot 的有效写授权\n"
  + " nyra org learnings <组织> <bot-id> submit <内容>   队友教 Team Bot 一句（先进待审区）\n"
  + " nyra org learnings <组织> <bot-id> list [--status pending|approved|rejected]   列教学\n"
  + " nyra org learnings <组织> <bot-id> approve <id> --yes / reject <id> --yes   批教学（Bot 主人或组织 admin；批准后落成组织记忆条目）\n"
  + " nyra org workspace <组织> <目录> --yes       给组织绑一个工作区目录（跨租户读文件只认这个目录）\n"
  + " nyra org file-read <组织> <相对路径>          读组织工作区下的文件（本组织成员或有跨租户授权才行）\n"
  + " nyra org cross-access <组织> grant <路径前缀> <邮箱|org:组织> [--expires <ISO>]   显式接受一次跨租户读\n"
  + " nyra org cross-access <组织> list             列出跨租户读授权\n"
  + " nyra org cross-access <组织> revoke <grant-id> --yes   回收跨租户读授权\n"
  + " nyra org catalog <组织> publish <文件> --yes  发布模板进组织私有目录（与公开市场同一套校验）\n"
  + " nyra org catalog <组织> list                 列出组织私有目录里的模板\n"
  + " nyra org catalog <组织> install <模板名> --yes   从组织私有目录安装模板（走公开市场同一条安装路，draft 起步）\n"
  + " nyra org catalog <组织> remove <模板名> --yes   移除私有目录里的模板\n"
  + " nyra org tasks <组织>                        列出组织的任务（有归属的才列）\n"
  + " nyra org task-add <组织> <任务文本...> [--mode readonly|auto]   排一个组织任务（进队列，归属记进组织）\n"
  + " nyra org violations <组织> [--limit N]       列出组织的隔离违反记录（组织 admin 或机主）\n"
  + "共享 Bot 默认只读：没写授权时 write_memory / write_file / send_message 全拒绝；写授权须 Bot 主人显式接受。详见 docs/orgs.md";

/** 不是第二批的子命令时返回 null（调用方再回用法说明）。 */
export async function handleOrgSharing(argv: string[], home: string): Promise<number | null> {
  const cmd = argv[0];
  if (!cmd) return null;
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
    process.stderr.write(`${msg}\n`);
    return 2;
  };
  const actor = async (): Promise<string> => currentActorId(home);
  const needYes = (msg: string): number | null => {
    if (!has("--yes")) {
      process.stderr.write(`${msg}\n`);
      return 2;
    }
    return null;
  };
  try {
    if (cmd === "share") {
      const ref = argv[1];
      const botId = argv[2];
      if (!ref || !botId) return usageErr("用法：nyra org share <组织> <bot-id> [--name <名>] [--to <邮箱,...>|all] [--desc <描述>]");
      const by = await actor();
      const to = flagValue("--to");
      const sharedWith = to === undefined || to === "all" ? "org" : to.split(",").map((s) => s.trim()).filter(Boolean);
      const bot = await publishSharedBot(home, ref, botId, {
        botName: flagValue("--name"), description: flagValue("--desc"), sharedWith, by,
      });
      process.stdout.write(`Bot ${bot.bot_name} 已共享进组织（共享记录 ${bot.id}；默认只读，写操作须你显式接受）。\n`);
      return 0;
    }
    if (cmd === "shared") {
      const ref = argv[1];
      if (!ref) return usageErr("用法：nyra org shared <组织>");
      const by = await actor();
      const bots = await listSharedBots(home, ref, by);
      if (!bots.length) {
        process.stdout.write("这个组织里还没有共享 Bot。\n");
        return 0;
      }
      for (const b of bots) {
        process.stdout.write(`${b.bot_name}\t${b.bot_id}\t主人：${b.owner}\t共享给：${b.shared_with === "org" ? "全组织" : `${b.shared_with.length} 人`}${b.description ? `\t${b.description}` : ""}\n`);
      }
      return 0;
    }
    if (cmd === "unshare") {
      const ref = argv[1];
      const botRef = argv[2];
      if (!ref || !botRef) return usageErr("用法：nyra org unshare <组织> <bot-id> --yes");
      const noYes = needYes("取消共享须加 --yes 确认（写授权随共享一起失效）");
      if (noYes !== null) return noYes;
      const by = await actor();
      await unshareBot(home, ref, botRef, { by });
      process.stdout.write("已取消共享（写授权随之失效；历史审计不删）。\n");
      return 0;
    }
    if (cmd === "grant-write") {
      const ref = argv[1];
      const botRef = argv[2];
      const accountRef = argv[3];
      const actionsRaw = argv[4];
      if (!ref || !botRef || !accountRef || !actionsRaw) {
        return usageErr("用法：nyra org grant-write <组织> <bot-id> <邮箱> <write_memory|write_file|send_message,...> [--expires <ISO>]");
      }
      const by = await actor();
      const grant = await grantSharedBotWrite(home, ref, botRef, accountRef, actionsRaw.split(",").map((s) => s.trim()).filter(Boolean), {
        by, expiresAt: flagValue("--expires"),
      });
      const account = await resolveAccountRef(home, accountRef);
      process.stdout.write(`${account.email} 已拿到写授权（${grant.actions.join("、")}，授权 ${grant.id}${grant.expires_at ? `，${grant.expires_at.slice(0, 10)} 到期` : "，不过期"}）。\n`);
      return 0;
    }
    if (cmd === "revoke-write") {
      const ref = argv[1];
      const botRef = argv[2];
      const accountRef = argv[3];
      if (!ref || !botRef || !accountRef) return usageErr("用法：nyra org revoke-write <组织> <bot-id> <邮箱> --yes");
      const noYes = needYes("回收写授权须加 --yes 确认");
      if (noYes !== null) return noYes;
      const by = await actor();
      await revokeSharedBotWrite(home, ref, botRef, accountRef, { by });
      process.stdout.write("写授权已回收（对方立即失去该 Bot 的写权限）。\n");
      return 0;
    }
    if (cmd === "grants") {
      const ref = argv[1];
      const botRef = argv[2];
      if (!ref || !botRef) return usageErr("用法：nyra org grants <组织> <bot-id>");
      const by = await actor();
      const grants = await listWriteGrants(home, ref, botRef, by);
      if (!grants.length) {
        process.stdout.write("这个 Bot 没有有效的写授权（默认只读）。\n");
        return 0;
      }
      const directory = new AccountStore(home);
      for (const g of grants) {
        const account = await directory.findById(g.account_id);
        process.stdout.write(`${account ? account.email : g.account_id}\t${g.actions.join("、")}\t由 ${g.granted_by} 接受${g.expires_at ? `\t${g.expires_at.slice(0, 10)} 到期` : "\t不过期"}\n`);
      }
      return 0;
    }
    if (cmd === "learnings") {
      const ref = argv[1];
      const botRef = argv[2];
      const action = argv[3];
      if (!ref || !botRef || !action) return usageErr("用法：nyra org learnings <组织> <bot-id> <submit|list|approve|reject> ...");
      const by = await actor();
      if (action === "submit") {
        const content = argv.slice(4).filter((a) => !a.startsWith("--")).join(" ").trim();
        if (!content) return usageErr("用法：nyra org learnings <组织> <bot-id> submit <内容>");
        const learning = await submitLearning(home, ref, botRef, content, { by });
        process.stdout.write(`教学已挂进待审区（${learning.id}）：Bot 主人或组织 admin 批了才生效。\n`);
        return 0;
      }
      if (action === "list") {
        const statusRaw = flagValue("--status") as "pending" | "approved" | "rejected" | undefined;
        if (statusRaw && statusRaw !== "pending" && statusRaw !== "approved" && statusRaw !== "rejected") {
          return usageErr("状态只认 pending / approved / rejected");
        }
        const rows = await listLearnings(home, ref, botRef, by, statusRaw);
        if (!rows.length) {
          process.stdout.write("没有符合条件的教学。\n");
          return 0;
        }
        for (const l of rows) {
          process.stdout.write(`${l.id}\t${l.status}\t由 ${l.proposed_by} 提出\t${l.content.slice(0, 80)}${l.content.length > 80 ? "…" : ""}${l.memory_entry_id ? `\t已落成记忆 ${l.memory_entry_id}` : ""}\n`);
        }
        return 0;
      }
      if (action === "approve" || action === "reject") {
        const id = argv[4];
        if (!id) return usageErr(`用法：nyra org learnings <组织> <bot-id> ${action} <id> --yes`);
        const noYes = needYes(`批教学（${action === "approve" ? "批准" : "拒绝"}）须加 --yes 确认`);
        if (noYes !== null) return noYes;
        const learning = await reviewLearning(home, id, action, { by });
        if (action === "approve") {
          process.stdout.write(`教学已批准并生效：已落成组织记忆条目 ${learning.memory_entry_id}。\n`);
        } else {
          process.stdout.write("教学已拒绝（不生效）。\n");
        }
        return 0;
      }
      return usageErr("learnings 只认 submit / list / approve / reject");
    }
    if (cmd === "workspace") {
      const ref = argv[1];
      const dir = argv[2];
      if (!ref || !dir) return usageErr("用法：nyra org workspace <组织> <目录> --yes");
      const noYes = needYes("绑工作区须加 --yes 确认");
      if (noYes !== null) return noYes;
      const by = await actor();
      const org = await setOrgWorkspace(home, ref, dir, { by });
      process.stdout.write(`组织 ${org.name} 已绑工作区 ${org.workspace_dir}。\n`);
      return 0;
    }
    if (cmd === "file-read") {
      const ref = argv[1];
      const relPath = argv[2];
      if (!ref || !relPath) return usageErr("用法：nyra org file-read <组织> <相对路径>");
      const by = await actor();
      const { content } = await readOrgFile(home, ref, by, relPath);
      process.stdout.write(content + (content.endsWith("\n") ? "" : "\n"));
      return 0;
    }
    if (cmd === "cross-access") {
      const ref = argv[1];
      const action = argv[2];
      if (!ref || !action) return usageErr("用法：nyra org cross-access <组织> <grant|list|revoke> ...");
      const by = await actor();
      if (action === "grant") {
        const prefix = argv[3];
        const grantee = argv[4];
        if (prefix === undefined || !grantee) {
          return usageErr("用法：nyra org cross-access <组织> grant <路径前缀> <邮箱|org:组织> [--expires <ISO>]（前缀 \"\" = 整个工作区）");
        }
        const grant = await grantCrossAccess(home, ref, prefix, grantee, { by, expiresAt: flagValue("--expires") });
        process.stdout.write(`跨租户读授权已给（${grant.id}：${grant.granted_to_kind === "org" ? `组织 ${grant.granted_to}` : grant.granted_to} 可读 ${prefix === "" ? "整个工作区" : prefix}${grant.expires_at ? `，${grant.expires_at.slice(0, 10)} 到期` : "，不过期"}）。\n`);
        return 0;
      }
      if (action === "list") {
        const rows = await listCrossAccess(home, ref, by);
        if (!rows.length) {
          process.stdout.write("这个组织没有有效的跨租户读授权。\n");
          return 0;
        }
        for (const g of rows) {
          process.stdout.write(`${g.id}\t${g.path_prefix === "" ? "整个工作区" : g.path_prefix}\t${g.granted_to_kind === "org" ? `组织 ${g.granted_to}` : g.granted_to}\t由 ${g.granted_by} 接受${g.expires_at ? `\t${g.expires_at.slice(0, 10)} 到期` : "\t不过期"}\n`);
        }
        return 0;
      }
      if (action === "revoke") {
        const grantId = argv[3];
        if (!grantId) return usageErr("用法：nyra org cross-access <组织> revoke <grant-id> --yes");
        const noYes = needYes("回收跨租户读授权须加 --yes 确认");
        if (noYes !== null) return noYes;
        await revokeCrossAccess(home, grantId, { by });
        process.stdout.write("跨租户读授权已回收。\n");
        return 0;
      }
      return usageErr("cross-access 只认 grant / list / revoke");
    }
    if (cmd === "catalog") {
      const ref = argv[1];
      const action = argv[2];
      if (!ref || !action) return usageErr("用法：nyra org catalog <组织> <publish|list|install|remove> ...");
      const by = await actor();
      if (action === "publish") {
        const file = argv[3];
        if (!file) return usageErr("用法：nyra org catalog <组织> publish <文件> --yes");
        const noYes = needYes("发布进组织私有目录须加 --yes 确认（只在组织内可见）");
        if (noYes !== null) return noYes;
        const entry = await publishOrgCatalogTemplate(home, ref, file, { by });
        process.stdout.write(`模板 ${entry.name}（${entry.version}）已发布进组织私有目录（与公开市场同一套校验，状态 draft）。\n`);
        return 0;
      }
      if (action === "list") {
        const rows = await listOrgCatalog(home, ref, by);
        if (!rows.length) {
          process.stdout.write("组织私有目录里还没有模板。\n");
          return 0;
        }
        for (const e of rows) {
          process.stdout.write(`${e.name}\t${e.version}\t由 ${e.published_by} 发布\t${e.published_at.slice(0, 10)}\n`);
        }
        return 0;
      }
      if (action === "install") {
        const name = argv[3];
        if (!name) return usageErr("用法：nyra org catalog <组织> install <模板名> --yes");
        const noYes = needYes("安装模板须加 --yes 确认（装成 draft，须试跑通过才能激活）");
        if (noYes !== null) return noYes;
        const installed = await installOrgCatalogTemplate(home, ref, name, { by });
        process.stdout.write(`模板 ${installed.name}（${installed.version}）已安装（draft；试跑通过后才能激活）。\n`);
        return 0;
      }
      if (action === "remove") {
        const name = argv[3];
        if (!name) return usageErr("用法：nyra org catalog <组织> remove <模板名> --yes");
        const noYes = needYes("移除私有目录模板须加 --yes 确认（已安装的全局模板不动）");
        if (noYes !== null) return noYes;
        await removeOrgCatalogTemplate(home, ref, name, { by });
        process.stdout.write(`模板 ${name} 已从组织私有目录移除。\n`);
        return 0;
      }
      return usageErr("catalog 只认 publish / list / install / remove");
    }
    if (cmd === "tasks") {
      const ref = argv[1];
      if (!ref) return usageErr("用法：nyra org tasks <组织>");
      const by = await actor();
      const rows = await listOrgTasks(home, ref, by);
      if (!rows.length) {
        process.stdout.write("这个组织还没有归属任务。\n");
        return 0;
      }
      for (const s of rows) {
        process.stdout.write(`${s.run_id}\t${s.status}\t${s.task.slice(0, 80)}${s.task.length > 80 ? "…" : ""}\n`);
      }
      return 0;
    }
    if (cmd === "task-add") {
      const ref = argv[1];
      const text = argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!ref || !text) return usageErr("用法：nyra org task-add <组织> <任务文本...> [--mode readonly|auto]");
      const mode = flagValue("--mode") ?? "auto";
      if (mode !== "readonly" && mode !== "auto") return usageErr("mode 只认 readonly / auto");
      const by = await actor();
      const org = getOrg(home, ref);
      if (!(await canOrg(home, org.id, by, "write"))) {
        process.stderr.write(`错误：${by} 没有 ${org.name} 的写权限。\n`);
        return 1;
      }
      const state = addTask(text, { orgId: org.id, mode, home });
      process.stdout.write(`组织任务已进队列（${state.run_id}，归属 ${org.name}）。\n`);
      return 0;
    }
    if (cmd === "violations") {
      const ref = argv[1];
      if (!ref) return usageErr("用法：nyra org violations <组织> [--limit N]");
      const by = await actor();
      const limitRaw = flagValue("--limit");
      const rows = await listViolations(home, ref, by, limitRaw !== undefined ? Number(limitRaw) : 20);
      if (!rows.length) {
        process.stdout.write("这个组织没有隔离违反记录。\n");
        return 0;
      }
      for (const v of rows) {
        process.stdout.write(`${v.at.slice(0, 19)}\t${v.what}\t${v.account_id}\t${v.detail}（${v.outcome}）\n`);
      }
      return 0;
    }
    if (cmd === "isolation") {
      const ref = argv[1];
      if (!ref) return usageErr("用法：nyra org isolation <组织>");
      const org = getOrg(home, ref);
      const iso = effectiveOrgIsolation(org);
      process.stdout.write(`组织 ${org.name} 的隔离状态：\n`);
      process.stdout.write(` 数据隔离：${iso.data ? "开（硬边界，不可关闭）" : "关"}\n`);
      process.stdout.write(` 设置隔离：${iso.settings ? "开" : "关（组织级设置尚未实现）"}\n`);
      process.stdout.write(` 用量隔离：${iso.usage ? "开" : "关（组织用量分账尚未实现）"}\n`);
      process.stdout.write(`工作区：${org.workspace_dir ?? "没绑（跨租户读文件须先绑工作区）"}\n`);
      process.stdout.write(`私有目录：${org.private_catalog ? "已开" : "没开"}\n`);
      return 0;
    }
    if (cmd === "memory") {
      const ref = argv[1];
      if (!ref) return usageErr("用法：nyra org memory <组织> [--limit N]");
      const by = await actor();
      const limitRaw = flagValue("--limit");
      const rows = await listOrgMemoryEntries(home, ref, by, { limit: limitRaw !== undefined ? Number(limitRaw) : undefined });
      if (!rows.length) {
        process.stdout.write("这个组织还没有记忆条目。\n");
        return 0;
      }
      for (const e of rows) {
        process.stdout.write(`- [${e.id}] ${e.subject}（${e.status}，第 ${e.revision} 版，${e.updatedAt.slice(0, 10)}）\n`);
      }
      return 0;
    }
  } catch (e) {
    if (e instanceof OrgSharingError || e instanceof OrgError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
  return null;
}

export { SHARING_USAGE };
