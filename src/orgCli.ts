// src/orgCli.ts — 缺口 49 第一批：nyra org 命令行。
//
// 子命令：create / list / show / add / remove / role / delete / check。
// 退出码：0 成功、1 业务错误（没权限、不存在、重复等）、2 用法错误。
// 破坏性操作（remove / role / delete）须 --yes；add 不须（可逆、有审计）。
import { AccountStore } from "./accounts.ts";
import {
  ORG_OWNER_IDENTITY,
  OrgError,
  addMember,
  canOrg,
  createOrg,
  currentActorId,
  deleteOrg,
  getOrg,
  getOrgRole,
  listOrgs,
  removeMember,
  resolveAccountRef,
  setMemberRole,
} from "./orgs.ts";

const ORG_USAGE = "用法：\n"
  + " nyra org create <组织名> [--desc <描述>]        建组织（创建者当 admin；没登录时按机主建）\n"
  + " nyra org list                                   列出组织（成员数）\n"
  + " nyra org show <组织>                            看一个组织：成员、角色、谁加的、何时\n"
  + " nyra org add <组织> <邮箱或账号id> [--role admin|member|viewer]   开通成员进组织（默认 member；操作者须机主或该组织 admin）\n"
  + " nyra org remove <组织> <邮箱或账号id> --yes     回收成员（移出组织）\n"
  + " nyra org role <组织> <邮箱或账号id> <admin|member|viewer> --yes   改成员角色\n"
  + " nyra org delete <组织> --yes                     删组织（成员随组织一起删；操作者须机主或该组织 admin）\n"
  + " nyra org check <组织> <邮箱或账号id> [read|write|manage]   看一个账号在组织里是什么角色、能不能做这个动作\n"
  + "角色：admin 管成员与设置，member 可读写，viewer 只读；机主是超级管理员，任何组织都能管。\n"
  + "组织成员只认全局账号（缺口 41）：账号不存在或已停用时开通直接拒绝；停用账号的组织权限立即失效。\n"
  + "共享 Bot 与租户隔离是第二批，本批只建组织层。详见 docs/orgs.md";

const ROLE_TEXT: Record<string, string> = { admin: "管理员", member: "成员", viewer: "只读" };

export async function handleOrg(argv: string[], home: string): Promise<number> {
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
  const actor = async (): Promise<string> => currentActorId(home);
  try {
    if (!cmd || cmd === "list") {
      const orgs = listOrgs(home);
      if (!orgs.length) {
        process.stdout.write("还没有组织：先跑 nyra org create <组织名> 建一个。\n");
        return 0;
      }
      for (const o of orgs) {
        process.stdout.write(`${o.name}\t${o.id}\t${o.members.length} 位成员${o.description ? `\t${o.description}` : ""}\n`);
      }
      return 0;
    }
    if (cmd === "create") {
      const name = argv[1];
      if (!name) {
        process.stderr.write("用法：nyra org create <组织名> [--desc <描述>]\n");
        return 2;
      }
      const by = await actor();
      const org = createOrg(home, name, { description: flagValue("--desc"), by });
      process.stdout.write(`组织 ${org.name} 已建（id：${org.id}）\n`);
      if (by === ORG_OWNER_IDENTITY) {
        process.stdout.write("你是机主：组织的超级管理员，不占成员位。\n");
      } else {
        process.stdout.write("你是创建者，已是该组织管理员（admin）。\n");
      }
      process.stdout.write(`开通成员：nyra org add ${org.name} <邮箱> [--role member]\n`);
      return 0;
    }
    if (cmd === "show") {
      const ref = argv[1];
      if (!ref) {
        process.stderr.write("用法：nyra org show <组织>\n");
        return 2;
      }
      const org = getOrg(home, ref);
      const directory = new AccountStore(home);
      process.stdout.write(`${org.name}（${org.id}）${org.description ? ` — ${org.description}` : ""}\n`);
      process.stdout.write(`建于：${org.created_at}（${org.created_by}）\n`);
      if (!org.members.length) {
        process.stdout.write("成员：无（机主仍可管理；开通：nyra org add " + org.name + " <邮箱>）\n");
        return 0;
      }
      process.stdout.write("成员：\n");
      for (const m of org.members) {
        const account = await directory.findById(m.account_id);
        const who = account ? `${account.email}（${account.name}）` : m.account_id;
        process.stdout.write(` ${who}\t${ROLE_TEXT[m.role] ?? m.role}\t由 ${m.added_by} 加入\t${m.added_at}\n`);
      }
      return 0;
    }
    if (cmd === "add") {
      const ref = argv[1];
      const accountRef = argv[2];
      if (!ref || !accountRef) {
        process.stderr.write("用法：nyra org add <组织> <邮箱或账号id> [--role admin|member|viewer]\n");
        return 2;
      }
      const by = await actor();
      const member = await addMember(home, ref, accountRef, flagValue("--role") ?? "member", { by });
      const account = await resolveAccountRef(home, accountRef);
      process.stdout.write(`${account.email} 已开通进组织（${ROLE_TEXT[member.role] ?? member.role}）\n`);
      return 0;
    }
    if (cmd === "remove") {
      const ref = argv[1];
      const accountRef = argv[2];
      if (!ref || !accountRef) {
        process.stderr.write("用法：nyra org remove <组织> <邮箱或账号id> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("回收成员须加 --yes 确认（移出后对方立即失去该组织权限）\n");
        return 2;
      }
      const by = await actor();
      const account = await resolveAccountRef(home, accountRef);
      await removeMember(home, ref, accountRef, { by });
      process.stdout.write(`${account.email} 已从组织移出（立即失去该组织权限；历史审计不删）\n`);
      return 0;
    }
    if (cmd === "role") {
      const ref = argv[1];
      const accountRef = argv[2];
      const role = argv[3];
      if (!ref || !accountRef || !role) {
        process.stderr.write("用法：nyra org role <组织> <邮箱或账号id> <admin|member|viewer> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("改角色须加 --yes 确认\n");
        return 2;
      }
      const by = await actor();
      const member = await setMemberRole(home, ref, accountRef, role, { by });
      const account = await resolveAccountRef(home, accountRef);
      process.stdout.write(`${account.email} 在组织里的角色已改成 ${ROLE_TEXT[member.role] ?? member.role}\n`);
      return 0;
    }
    if (cmd === "delete") {
      const ref = argv[1];
      if (!ref) {
        process.stderr.write("用法：nyra org delete <组织> --yes\n");
        return 2;
      }
      if (!has("--yes")) {
        process.stderr.write("删组织须加 --yes 确认（成员随组织一起删）\n");
        return 2;
      }
      const by = await actor();
      const org = getOrg(home, ref);
      await deleteOrg(home, ref, { by });
      process.stdout.write(`组织 ${org.name} 已删（成员随组织一起删；历史审计不删）\n`);
      return 0;
    }
    if (cmd === "check") {
      const ref = argv[1];
      const accountRef = argv[2];
      const action = argv[3] ?? "read";
      if (!ref || !accountRef) {
        process.stderr.write("用法：nyra org check <组织> <邮箱或账号id> [read|write|manage]\n");
        return 2;
      }
      if (action !== "read" && action !== "write" && action !== "manage") {
        process.stderr.write("动作只认 read / write / manage\n");
        return 2;
      }
      if (accountRef === ORG_OWNER_IDENTITY) {
        process.stdout.write(`机主（超级管理员），${action} 允许\n`);
        return 0;
      }
      const account = await resolveAccountRef(home, accountRef);
      const org = getOrg(home, ref);
      if (account.role === "owner") {
        process.stdout.write(`${account.email}：机主（超级管理员），${action} 允许\n`);
        return 0;
      }
      if (account.status === "suspended") {
        process.stdout.write(`${account.email}：账号已停用，${action} 拒绝\n`);
        return 1;
      }
      const role = await getOrgRole(home, ref, account.id);
      if (!role) {
        process.stdout.write(`${account.email}：不是 ${org.name} 的成员，${action} 拒绝\n`);
        return 1;
      }
      const allowed = await canOrg(home, ref, account.id, action);
      process.stdout.write(`${account.email}：${org.name} 的${ROLE_TEXT[role] ?? role}，${action} ${allowed ? "允许" : "拒绝"}\n`);
      return allowed ? 0 : 1;
    }
  } catch (e) {
    if (e instanceof OrgError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
  process.stderr.write(ORG_USAGE + "\n");
  return 2;
}
