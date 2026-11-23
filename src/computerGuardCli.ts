// src/computerGuardCli.ts — 真机电脑操作守卫的 CLI：`nyra computer`。
// 只管守卫的查看与开关：授权发/撤、禁碰名单、活动账本、虚拟桌面、
// 两项收紧开关（require_grant / require_virtual_display）。本机 CLI 的
// 操作者就是机主，不另设身份校验。返回码：0 成功，1 业务错，2 用法错。
import {
  ComputerGuardError,
  countRecentActivity,
  displayStatus,
  issueGrant,
  listComputerActivity,
  listGrants,
  readGuardConfig,
  revokeGrant,
  startVirtualDisplay,
  stopVirtualDisplay,
  writeGuardConfig,
} from "./computerGuard.ts";

const USAGE = [
  "用法：",
  "  nyra computer status                                              守卫状态（开关、授权数、虚拟桌面、最近活动）",
  "  nyra computer grant issue [--session <会话 id>] [--minutes <分钟>] [--label <备注>]   发一张电脑操作授权（默认 120 分钟过期，--minutes 0 不过期）",
  "  nyra computer grant revoke <授权 id> [--reason <原因>]            撤销一张授权（撤销后立即失效）",
  "  nyra computer grants                                              列授权（新的在前，含已撤销/已过期）",
  "  nyra computer blocklist                                           看禁碰窗口名单",
  "  nyra computer blocklist add <子串>                                加一条禁碰窗口标题子串",
  "  nyra computer blocklist remove <子串>                             删一条禁碰窗口标题子串",
  "  nyra computer activity [--limit <条数>]                           看最近的电脑操作活动（默认 20 条，输入文本只记长度）",
  "  nyra computer display start | stop | status                      虚拟桌面 Xvfb :99（只支持 Linux）",
  "  nyra computer require grant on|off                                开/关“动手前须有授权”（默认关）",
  "  nyra computer require display on|off                              开/关“只允许在虚拟桌面上操作”（默认关）",
  "说明：禁碰名单默认开启（系统设置、密码管理器、银行支付等窗口前台时不动手）；",
  "授权与虚拟桌面两项默认关闭，机主按需收紧；每次电脑动作都记活动账本与运行事件。",
].join("\n");

function usageError(message: string): number {
  process.stderr.write(`错误：${message}\n${USAGE}\n`);
  return 2;
}

function flagValue(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function grantLine(g: { id: string; scope: { session_id?: string }; label?: string; created_at: string; expires_at: string | null; revoked: boolean; revoked_reason?: string }): string {
  const scope = g.scope.session_id ? `会话 ${g.scope.session_id}` : "整机";
  const state = g.revoked
    ? `已撤销${g.revoked_reason ? `（${g.revoked_reason}）` : ""}`
    : (g.expires_at && new Date(g.expires_at) <= new Date() ? "已过期" : "可用");
  const expiry = g.expires_at ? `，过期 ${g.expires_at}` : "，不过期";
  const label = g.label ? `，${g.label}` : "";
  return `${g.id} [${scope}] ${state}，创建 ${g.created_at}${expiry}${label}`;
}

export async function handleComputerGuard(args: string[], home: string): Promise<number> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    if (cmd === "status") {
      const config = readGuardConfig(home);
      const grants = listGrants(home);
      const now = new Date();
      const active = grants.filter((g) => !g.revoked && (!g.expires_at || new Date(g.expires_at) > now));
      const display = displayStatus(home);
      const recent = countRecentActivity(home, 3_600_000);
      const lines = [
        "电脑操作守卫：",
        `  授权检查：${config.require_grant ? "开（动手前须有授权）" : "关（只走审批门）"}`,
        `  虚拟桌面检查：${config.require_virtual_display ? "开（只允许在虚拟桌面上操作）" : "关"}`,
        `  每分钟上限：${config.max_actions_per_minute} 次`,
        `  禁碰窗口：${config.blocked_titles.length} 条，禁按组合键：${config.blocked_keys.length} 条`,
        `  授权：共 ${grants.length} 张，其中可用 ${active.length} 张`,
        display.record
          ? `  虚拟桌面：${display.record.display}（pid ${display.record.pid}，${display.alive ? "在跑" : "已停"}）`
          : "  虚拟桌面：未启动",
        `  最近 1 小时活动：${recent} 次`,
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
    if (cmd === "grant") {
      if (rest[0] === "issue") {
        const sessionId = flagValue(rest, "--session") ?? undefined;
        const minutesRaw = flagValue(rest, "--minutes");
        const minutes = minutesRaw === null ? undefined : Number(minutesRaw);
        if (minutesRaw !== null && (!Number.isInteger(minutes) || (minutes as number) < 0)) {
          return usageError("--minutes 须是非负整数（0 = 不过期）");
        }
        const label = flagValue(rest, "--label") ?? undefined;
        const grant = issueGrant(home, { sessionId, minutes, label });
        process.stdout.write(`已发授权：${grantLine(grant)}\n`);
        return 0;
      }
      if (rest[0] === "revoke") {
        const id = rest[1];
        if (!id) return usageError("nyra computer grant revoke <授权 id>");
        const reason = flagValue(rest, "--reason") ?? undefined;
        if (!revokeGrant(home, id, reason)) {
          process.stderr.write(`错误：找不到授权 ${id}，或它已经被撤销\n`);
          return 1;
        }
        process.stdout.write(`已撤销授权 ${id}\n`);
        return 0;
      }
      return usageError("grant 只认 issue / revoke（列授权用 nyra computer grants）");
    }
    if (cmd === "grants") {
      const grants = listGrants(home);
      if (!grants.length) {
        process.stdout.write("还没有授权（nyra computer grant issue 发一张）\n");
        return 0;
      }
      process.stdout.write(`${grants.map(grantLine).join("\n")}\n`);
      return 0;
    }
    if (cmd === "blocklist") {
      const config = readGuardConfig(home);
      if (rest[0] === "add") {
        const sub = rest[1];
        if (!sub) return usageError("nyra computer blocklist add <子串>");
        if (config.blocked_titles.includes(sub)) {
          process.stdout.write(`禁碰名单里已有“${sub}”\n`);
          return 0;
        }
        const next = writeGuardConfig(home, { blocked_titles: [...config.blocked_titles, sub] });
        process.stdout.write(`已加入禁碰名单（现 ${next.blocked_titles.length} 条）\n`);
        return 0;
      }
      if (rest[0] === "remove") {
        const sub = rest[1];
        if (!sub) return usageError("nyra computer blocklist remove <子串>");
        if (!config.blocked_titles.includes(sub)) {
          process.stderr.write(`错误：禁碰名单里没有“${sub}”\n`);
          return 1;
        }
        const next = writeGuardConfig(home, { blocked_titles: config.blocked_titles.filter((t) => t !== sub) });
        process.stdout.write(`已从禁碰名单移除（现 ${next.blocked_titles.length} 条）\n`);
        return 0;
      }
      if (rest.length > 0) return usageError("blocklist 只认 add / remove（不带参数是查看）");
      process.stdout.write(`禁碰窗口标题子串（共 ${config.blocked_titles.length} 条）：\n${config.blocked_titles.map((t) => `  - ${t}`).join("\n")}\n禁按组合键：${config.blocked_keys.join("、") || "无"}\n`);
      return 0;
    }
    if (cmd === "activity") {
      const limitRaw = flagValue(rest, "--limit");
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0) return usageError("--limit 须是正整数");
      const entries = listComputerActivity(home, limit);
      if (!entries.length) {
        process.stdout.write("还没有电脑操作活动\n");
        return 0;
      }
      const lines = entries.map((e) => {
        const parts = [e.time, e.action, `结果 ${e.result}`];
        if (e.x !== undefined && e.y !== undefined) parts.push(`坐标 (${e.x}, ${e.y})`);
        if (e.key !== undefined) parts.push(`按键 ${e.key}`);
        if (e.text_len !== undefined) parts.push(`输入 ${e.text_len} 字`);
        if (e.window) parts.push(`前台“${e.window}”`);
        if (e.grant_id) parts.push(`授权 ${e.grant_id}`);
        if (e.reason) parts.push(`原因：${e.reason}`);
        return parts.join("，");
      });
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
    if (cmd === "display") {
      if (rest[0] === "start") {
        const record = startVirtualDisplay(home);
        process.stdout.write(`虚拟桌面已启动：${record.display}（pid ${record.pid}）\n`);
        return 0;
      }
      if (rest[0] === "stop") {
        if (!stopVirtualDisplay(home)) {
          process.stdout.write("虚拟桌面本来就没启动\n");
          return 0;
        }
        process.stdout.write("虚拟桌面已停\n");
        return 0;
      }
      if (rest[0] === "status") {
        const { record, alive } = displayStatus(home);
        if (!record) {
          process.stdout.write("虚拟桌面：未启动（nyra computer display start 起一个 Xvfb :99）\n");
          return 0;
        }
        process.stdout.write(`虚拟桌面：${record.display}（pid ${record.pid}，${alive ? "在跑" : "已停"}，启动 ${record.started_at}）\n`);
        return 0;
      }
      return usageError("display 只认 start / stop / status");
    }
    if (cmd === "require") {
      const which = rest[0];
      const onOff = rest[1];
      if ((which !== "grant" && which !== "display") || (onOff !== "on" && onOff !== "off")) {
        return usageError("nyra computer require <grant|display> <on|off>");
      }
      const on = onOff === "on";
      if (which === "grant") {
        writeGuardConfig(home, { require_grant: on });
        process.stdout.write(`授权检查已${on ? "开启（动手前须有授权，先用 nyra computer grant issue 发一张）" : "关闭（只走审批门）"}\n`);
        return 0;
      }
      writeGuardConfig(home, { require_virtual_display: on });
      process.stdout.write(`虚拟桌面检查已${on ? "开启（只允许在虚拟桌面上操作）" : "关闭"}\n`);
      return 0;
    }
    return usageError(`不认识的子命令：${cmd}`);
  } catch (err) {
    if (err instanceof ComputerGuardError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
