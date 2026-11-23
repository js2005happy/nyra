// src/hitlCli.ts — 对话转人工坐席的 CLI：`nyra hitl`。
// 只管转人工单的发起 / 接手 / 接回 / 取消 / 查看；真人坐席端不存在，
// 真人只通过本地 CLI / 收件箱看到转人工单，不接真实时通讯渠道。
// 身份口径：当前登录账号的邮箱；没登录时记 `local`（本机 CLI 的操作者
// 就是机主）。接手只认机主或信任圈成员；接回只认接手人本人或机主；
// 取消只认发起人或机主。每次流转记运行事件（hitl_started 等，见 runs.ts
// 的 EVENT_FIELDS；只记单号、会话 id 与身份，不记对话原文）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HitlError,
  startHandoff, takeoverHandoff, handbackHandoff, cancelHandoff,
  getHandoff, listHandoffs, activeHandoffForSession, HITL_LEDGER_NAME,
  type HitlHandoff, type HitlStatus,
} from "./hitl.ts";
import { getCurrentAccount } from "./accounts.ts";
import { isAdmitted } from "./circles.ts";
import { RunStore } from "./runs.ts";
import { EvidenceStore } from "./evidence.ts";

const USAGE = [
  "用法：",
  "  nyra hitl start <会话 id> --yes [--reason <原因>] [--assignee <身份>]   发起转人工（须 --yes；同一会话已有进行中的单时拒绝）",
  "  nyra hitl takeover <单号>                              真人接手（机主或信任圈成员；指定了接手人时只认该身份或机主）",
  "  nyra hitl handback <单号>                              接回 bot（只认接手人本人或机主）",
  "  nyra hitl cancel <单号>                                取消待接手的单（只认发起人或机主）",
  "  nyra hitl status [会话 id | 单号]                      看某会话进行中的单，或某单详情",
  "  nyra hitl list [--status pending|active|handed_back|cancelled]   列转人工单（默认全部，新的在前）",
  "说明：转人工期间 bot 不自动回该会话；接回后恢复。转人工只由机主或 bot 显式触发，不自动判定。",
].join("\n");

const STATUS_LABEL: Record<HitlStatus, string> = {
  pending: "待接手",
  active: "真人接手中",
  handed_back: "已接回 bot",
  cancelled: "已取消",
};

interface Actor {
  identity: string;
  isOwner: boolean;
  isAdmitted: boolean;
}

async function resolveActor(home: string): Promise<Actor> {
  let account: { email: string; role: string } | null = null;
  try {
    account = await getCurrentAccount(home);
  } catch {
    account = null;
  }
  const identity = account?.email ?? "local";
  const isOwner = account ? account.role === "owner" : true;
  let admitted = false;
  try {
    admitted = isAdmitted(home, identity);
  } catch {
    admitted = false;
  }
  return { identity, isOwner, isAdmitted: admitted };
}

/** 流转记运行事件：会话的运行目录在就写事件链，否则落证据文件；记账失败绝不破坏 CLI。 */
function recordHitlEvent(home: string, sessionId: string, type: string, fields: Record<string, unknown>): void {
  const nyraHome = process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  const h = home || nyraHome;
  for (const sub of ["runs", "tasks"]) {
    const base = join(h, sub);
    if (!existsSync(join(base, sessionId))) continue;
    try {
      new RunStore(base).appendEvent(sessionId, type, fields);
      return;
    } catch { /* 该 store 写失败就试下一个 */ }
  }
  try {
    new EvidenceStore(join(h, "evidence"), "hitl").save(
      type,
      `hitl://${String(fields.handoff ?? "unknown")}`,
      `${type}：单 ${String(fields.handoff ?? "未知")}，会话 ${sessionId}，操作人 ${String(fields.by ?? "未知")}`,
    );
  } catch { /* 记账失败不破坏 CLI */ }
}

function printHandoff(h: HitlHandoff): void {
  process.stdout.write(`单号：${h.id}\n`);
  process.stdout.write(`会话：${h.sessionId}\n`);
  process.stdout.write(`状态：${STATUS_LABEL[h.status]}\n`);
  process.stdout.write(`发起：${h.requestedBy}（${h.requestedAt}）\n`);
  if (h.reason) process.stdout.write(`原因：${h.reason}\n`);
  if (h.assignee) process.stdout.write(`指定接手：${h.assignee}\n`);
  if (h.takenBy) process.stdout.write(`接手：${h.takenBy}${h.takenAt ? `（${h.takenAt}）` : ""}\n`);
  if (h.handedBackBy) process.stdout.write(`接回：${h.handedBackBy}${h.handedBackAt ? `（${h.handedBackAt}）` : ""}\n`);
  if (h.cancelledBy) process.stdout.write(`取消：${h.cancelledBy}${h.cancelledAt ? `（${h.cancelledAt}）` : ""}\n`);
}

export async function handleHitl(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "status") {
    const target = argv[1];
    if (!target) {
      process.stdout.write(`转人工账本：${HITL_LEDGER_NAME}\n`);
      const pending = listHandoffs(home, "pending");
      const active = listHandoffs(home, "active");
      process.stdout.write(`待接手：${pending.length} 单；真人接手中：${active.length} 单\n`);
      for (const h of [...active, ...pending]) {
        process.stdout.write(`  ${h.id}  会话 ${h.sessionId}  ${STATUS_LABEL[h.status]}（发起 ${h.requestedBy}）\n`);
      }
      return 0;
    }
    if (target.startsWith("hitl_")) {
      try {
        printHandoff(getHandoff(home, target));
      } catch (err) {
        if (err instanceof HitlError) {
          process.stderr.write(`${err.message}\n`);
          return 1;
        }
        throw err;
      }
      return 0;
    }
    const h = activeHandoffForSession(home, target);
    if (!h) {
      process.stdout.write(`会话 ${target} 没有进行中的转人工单，bot 正常回复。\n`);
      return 0;
    }
    printHandoff(h);
    return 0;
  }
  if (cmd === "list") {
    const statusIdx = argv.indexOf("--status");
    const status = statusIdx >= 0 ? argv[statusIdx + 1] : undefined;
    if (status !== undefined && status !== "pending" && status !== "active" && status !== "handed_back" && status !== "cancelled") {
      process.stderr.write("用法：nyra hitl list [--status pending|active|handed_back|cancelled]\n");
      return 2;
    }
    const items = listHandoffs(home, status as HitlStatus | undefined);
    if (!items.length) {
      process.stdout.write("没有转人工单。\n");
      return 0;
    }
    for (const h of items) {
      process.stdout.write(`${h.id}  会话 ${h.sessionId}  ${STATUS_LABEL[h.status]}  发起 ${h.requestedBy}（${h.requestedAt}）\n`);
    }
    return 0;
  }
  if (cmd === "start") {
    const sessionId = argv[1];
    if (!sessionId || sessionId.startsWith("--")) {
      process.stderr.write("用法：nyra hitl start <会话 id> --yes [--reason <原因>] [--assignee <身份>]\n");
      return 2;
    }
    if (!argv.includes("--yes")) {
      process.stderr.write("转人工须显式确认：nyra hitl start <会话 id> --yes\n");
      return 2;
    }
    const reasonIdx = argv.indexOf("--reason");
    const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] : undefined;
    const assigneeIdx = argv.indexOf("--assignee");
    const assignee = assigneeIdx >= 0 ? argv[assigneeIdx + 1] : undefined;
    const actor = await resolveActor(home);
    try {
      const h = startHandoff(home, { sessionId, by: actor.identity, reason, assignee });
      recordHitlEvent(home, sessionId, "hitl_started", { handoff: h.id, session: sessionId, by: actor.identity });
      process.stdout.write(`已转人工：单 ${h.id}，会话 ${sessionId} 待接手，bot 暂不自动回。\n`);
      return 0;
    } catch (err) {
      if (err instanceof HitlError) {
        process.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
  if (cmd === "takeover" || cmd === "handback" || cmd === "cancel") {
    const id = argv[1];
    if (!id || id.startsWith("--")) {
      process.stderr.write(`用法：nyra hitl ${cmd} <单号>\n`);
      return 2;
    }
    const actor = await resolveActor(home);
    try {
      if (cmd === "takeover") {
        if (!actor.isOwner && !actor.isAdmitted) {
          process.stderr.write("接手只认机主或信任圈成员。\n");
          return 1;
        }
        const h = takeoverHandoff(home, id, actor.identity, actor.isOwner);
        recordHitlEvent(home, h.sessionId, "hitl_takeover", { handoff: h.id, session: h.sessionId, by: actor.identity });
        process.stdout.write(`已接手：单 ${h.id}，会话 ${h.sessionId} 现在由真人 ${actor.identity} 回复，bot 仍不自动回。\n`);
        return 0;
      }
      if (cmd === "handback") {
        const h = handbackHandoff(home, id, actor.identity, actor.isOwner);
        recordHitlEvent(home, h.sessionId, "hitl_handback", { handoff: h.id, session: h.sessionId, by: actor.identity });
        process.stdout.write(`已接回 bot：单 ${h.id}，会话 ${h.sessionId} 恢复 bot 自动回复。\n`);
        return 0;
      }
      const h = cancelHandoff(home, id, actor.identity, actor.isOwner);
      recordHitlEvent(home, h.sessionId, "hitl_cancelled", { handoff: h.id, session: h.sessionId, by: actor.identity });
      process.stdout.write(`已取消：单 ${h.id}，会话 ${h.sessionId} 恢复 bot 自动回复。\n`);
      return 0;
    } catch (err) {
      if (err instanceof HitlError) {
        process.stderr.write(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}
