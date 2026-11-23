// src/connectors/flows.ts — G-P0-6：连接器业务流程（每条连接器一条真实业务流程 + 验收标准）。
//
// 报告 G-P0-6 的要求：“别拼数量，按缺口 44 已有的队形做深——每个接进来的
// 系统都要能跑通一条真实业务流程并有验收标准。”所以本批不加新连接器，
// 只给已有的三条各补一条端到端流程，每条带验收检查（checks），跑完出
// “通过 / 不通过”的结论，不只打印一堆数据：
// - slack-approval-roundtrip：审批卡闭环——Slack 按钮回调回写审批桥
//   （缺口 44 第二批只解析不回写的那一步这批接上了）。
// - shopify-order-fulfillment：订单履约核查——订单详情 + 行项目 + 库存
//   水平逐项核对“可售 ≥ 要发”（只读判断，不改订单、不动库存）。
// - gmail-draft-send：草稿闭环——列草稿、读草稿、发草稿（发须显式批准
//   并过红线，与 nyra gmail send 同款门）。
//
// 运行器只做三件事：按 id 找流程、跑它、把结论记进审计 + 用量 + 证据文件
// （evidence/connector/ 下的 connector_flow 报告）。验收检查是流程自己
// 评的（每条检查有名、有通过/不通过、有说明），运行器不替流程编结论。
// 模型工具不新增：流程走 CLI（nyra connector flow），模型仍用已有的连接器
// 工具；工具总数不变。
//
// 依赖方向：本模块 import 三个客户端 + registry + directory + evidence，
// 三个客户端不 import 本模块；cli.ts 动态 import 本模块。不成环。
import { EvidenceStore } from "../evidence.ts";
import { resolveNyraHome } from "../memory.ts";
import { appendBusinessRedlineAudit, reviewBusinessAction } from "../businessRedlines.ts";
import { join } from "node:path";
import { appendConnectorAudit, resolveConnectorUserId } from "./registry.ts";
import { recordConnectorCall } from "./directory.ts";
import { createGmailTransport, type GmailTransport } from "./gmail.ts";
import {
  checkOrderFulfillment,
  createShopifyClient,
  formatFulfillmentCheck,
  type ShopifyApiClient,
} from "./shopify.ts";
import { resolveSlackApprovalCallback } from "./slack.ts";
import type { ApprovalBridge } from "../bot/approvalBridge.ts";

export class ConnectorFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorFlowError";
  }
}

/** 一条验收检查：有名、有结论、有说明（结论只来自流程自己的核对，不编）。 */
export interface FlowCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConnectorFlowResult {
  flow: string;
  connector: string;
  passed: boolean;
  checks: FlowCheck[];
  summary: string;
  durationMs: number;
}

export interface FlowDeps {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Slack 审批卡闭环要用的审批桥（CLI 按本机配置建，网关传运行中的桥）。 */
  bridge?: ApprovalBridge;
}

export interface FlowContext {
  home: string;
  config: Record<string, unknown>;
  input: Record<string, unknown>;
  deps: FlowDeps;
}

export interface ConnectorFlowDefinition {
  id: string;
  connector: string;
  title: string;
  description: string;
  /** 流程的步骤（给人看的清单，不含参数）。 */
  steps: string[];
  /** 验收检查的名字（给人看的清单；实际评判在 run 里）。 */
  acceptance: string[];
  run: (ctx: FlowContext) => Promise<{ checks: FlowCheck[]; summary: string }>;
}

function check(name: string, passed: boolean, detail: string): FlowCheck {
  return { name, passed, detail };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Slack 审批卡闭环：解析回调 → 审批桥 decide → 验收三项。 */
async function runSlackApprovalRoundtrip(ctx: FlowContext): Promise<{ checks: FlowCheck[]; summary: string }> {
  const bridge = ctx.deps.bridge;
  if (!bridge) {
    throw new ConnectorFlowError("Slack 审批卡闭环需要审批桥：CLI 里按本机配置建（nyra slack callback），网关里传运行中 BotRunner 的桥。");
  }
  const decidedBy = asString(ctx.input.decidedBy);
  if (!decidedBy) {
    throw new ConnectorFlowError("Slack 审批卡闭环需要决定人：传 --by <用户 id>（只认 owner/admin 白名单）。");
  }
  let payload: unknown = ctx.input.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return {
        checks: [check("callback-parsed", false, "回调 payload 不是合法 JSON。")],
        summary: "回调解析失败：payload 不是合法 JSON。",
      };
    }
  }
  const resolution = await resolveSlackApprovalCallback(ctx.home, { payload, decidedBy, bridge });
  const parsed = resolution.status !== "not-found" || resolution.approvalId !== undefined;
  const checks: FlowCheck[] = [
    check("callback-parsed", parsed, parsed ? `解析出审批 ${resolution.approvalId ?? "（未知）"}。` : resolution.reason),
    check("approver-allowed", bridge.canApprove(decidedBy), bridge.canApprove(decidedBy) ? `决定人 ${decidedBy} 在 owner/admin 白名单里。` : `决定人 ${decidedBy} 不在 owner/admin 白名单里。`),
  ];
  if (resolution.status === "resolved") {
    checks.push(check("approval-resolved", true, resolution.reason));
  } else if (resolution.status === "not-pending") {
    checks.push(check("approval-resolved", true, `${resolution.reason}（审批本身已解决，结论以首次为准）。`));
  } else {
    checks.push(check("approval-resolved", false, resolution.reason));
  }
  return { checks, summary: resolution.reason };
}

/** Shopify 订单履约核查：订单详情 → 行项目 → 库存核对 → 验收三项。 */
async function runShopifyOrderFulfillment(ctx: FlowContext): Promise<{ checks: FlowCheck[]; summary: string }> {
  const orderId = asString(ctx.input.orderId);
  if (!orderId) throw new ConnectorFlowError("Shopify 订单履约核查需要订单 id：传 --order <id>。");
  const client: ShopifyApiClient = createShopifyClient(ctx.home, ctx.config, {
    ...(ctx.deps.fetchFn ? { fetchFn: ctx.deps.fetchFn } : {}),
  });
  let fulfillment;
  try {
    fulfillment = await checkOrderFulfillment(client, orderId);
  } catch (err: unknown) {
    return {
      checks: [check("order-found", false, err instanceof Error ? err.message : String(err))],
      summary: `订单 ${orderId} 查不到：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const checks: FlowCheck[] = [
    check("order-found", true, `订单 ${fulfillment.order.name || fulfillment.order.id} 已读到。`),
    check(
      "order-not-cancelled",
      fulfillment.verdict !== "cancelled",
      fulfillment.verdict === "cancelled" ? fulfillment.summary : "订单未取消。",
    ),
  ];
  if (fulfillment.verdict === "already-fulfilled") {
    checks.push(check("items-covered", true, "订单已发货，无需再核库存。"));
  } else if (fulfillment.verdict === "fulfillable") {
    checks.push(check("items-covered", true, `${fulfillment.items.length} 项商品库存都够，可以发货。`));
  } else {
    const short = fulfillment.items.filter((i) => !i.ok);
    checks.push(
      check(
        "items-covered",
        false,
        short.length
          ? short.map((i) => `${i.lineItem.title || `商品 ${i.lineItem.id}`}（${i.note ?? `要 ${i.required}、有 ${i.available ?? "未知"}`}）`).join("；")
          : fulfillment.summary,
      ),
    );
  }
  return { checks, summary: `${fulfillment.summary}\n${formatFulfillmentCheck(fulfillment)}` };
}

/** Gmail 草稿闭环：列草稿 → 读草稿 → 发草稿 → 验收三项。发须显式批准。 */
async function runGmailDraftSend(ctx: FlowContext): Promise<{ checks: FlowCheck[]; summary: string }> {
  const draftId = asString(ctx.input.draftId);
  if (!draftId) throw new ConnectorFlowError("Gmail 草稿闭环需要草稿 id：传 --draft <id>。");
  if (ctx.input.approved !== true) {
    throw new ConnectorFlowError("发送草稿须显式批准：加 --yes 或在确认里答 y（未批准不发，fail-closed）。");
  }
  // 缺口 51：发消息是永远须人批档（确认已满足），收紧到永远禁做时即使已批准也拒绝。
  const gmailRedline = reviewBusinessAction({ home: ctx.home, connector: "gmail", action: "send_message", approved: true });
  if (gmailRedline.decision === "BLOCK") {
    try {
      appendBusinessRedlineAudit(ctx.home, { kind: "blocked", connector: "gmail", action: "send_message", tier: "never", via: "connector-flow-gmail-draft-send" });
    } catch { /* 审计落盘失败不破坏拦截 */ }
    return {
      checks: [check("draft-sent", false, `红线拦截：${gmailRedline.reason}`)],
      summary: `红线拦截：${gmailRedline.reason}`,
    };
  }
  const transport: GmailTransport = createGmailTransport(ctx.home, ctx.config, {
    ...(ctx.deps.fetchFn ? { fetchFn: ctx.deps.fetchFn } : {}),
  });
  let drafts;
  try {
    drafts = await transport.listDrafts();
  } catch (err: unknown) {
    return {
      checks: [check("draft-found", false, err instanceof Error ? err.message : String(err))],
      summary: `草稿列表读不到：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const found = drafts.some((d) => d.id === draftId);
  if (!found) {
    return {
      checks: [check("draft-found", false, `草稿 ${draftId} 不在草稿列表里（可能已被发送或删除）。`)],
      summary: `找不到草稿 ${draftId}。`,
    };
  }
  let draft;
  try {
    draft = await transport.getDraft(draftId);
  } catch (err: unknown) {
    return {
      checks: [
        check("draft-found", true, `草稿 ${draftId} 在列表里。`),
        check("draft-complete", false, err instanceof Error ? err.message : String(err)),
      ],
      summary: `草稿 ${draftId} 读不到详情：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const checks: FlowCheck[] = [
    check("draft-found", true, `草稿 ${draftId} 在列表里。`),
    check(
      "draft-complete",
      Boolean(draft.to.trim()) && Boolean(draft.subject.trim()),
      draft.to.trim() && draft.subject.trim()
        ? `收件人 ${draft.to}，主题 ${draft.subject}。`
        : "草稿不完整（收件人或主题为空），不发。",
    ),
  ];
  if (!draft.to.trim() || !draft.subject.trim()) {
    return { checks, summary: `草稿 ${draftId} 不完整（收件人或主题为空），不发。` };
  }
  const sent = await transport.sendDraft(draftId);
  checks.push(check("draft-sent", true, `已发送（邮件 id：${sent.id}）。`));
  try {
    new EvidenceStore(join(resolveNyraHome(ctx.home), "evidence"), "gmail").save(
      "gmail_send",
      `gmail://${sent.id}`,
      [
        "工具：gmail_send（草稿发送，业务流程 gmail-draft-send）",
        `收件人：${draft.to}`,
        `主题：${draft.subject}`,
        `草稿 id：${draftId}`,
        "批准：用户经终端命令批准（nyra connector flow gmail-draft-send）",
        `邮件 id：${sent.id}`,
      ].join("\n"),
    );
  } catch { /* 证据落盘失败不破坏发送结果 */ }
  return { checks, summary: `草稿 ${draftId} 已发送（邮件 id：${sent.id}）。` };
}

export const CONNECTOR_FLOWS: ConnectorFlowDefinition[] = [
  {
    id: "slack-approval-roundtrip",
    connector: "slack",
    title: "Slack 审批卡闭环",
    description: "审批卡发到 Slack 频道后，点 Approve / Reject 按钮真的解决审批（回写审批桥），不是只记审计。",
    steps: ["解析按钮回调", "审批桥 decide（via button）", "记解决审计"],
    acceptance: ["callback-parsed", "approver-allowed", "approval-resolved"],
    run: runSlackApprovalRoundtrip,
  },
  {
    id: "shopify-order-fulfillment",
    connector: "shopify",
    title: "Shopify 订单履约核查",
    description: "查一个订单：订单详情 + 行项目 + 库存水平逐项核对“可售 ≥ 要发”，出可以发货 / 缺货 / 已发货 / 已取消的结论（只读）。",
    steps: ["读订单详情（含行项目）", "按库存项 id 查库存水平", "逐项核对数量"],
    acceptance: ["order-found", "order-not-cancelled", "items-covered"],
    run: runShopifyOrderFulfillment,
  },
  {
    id: "gmail-draft-send",
    connector: "gmail",
    title: "Gmail 草稿闭环",
    description: "列草稿、读草稿核对收件人与主题、发草稿（须显式批准并过红线），发完写发送证据。",
    steps: ["列草稿找目标", "读草稿核对完整性", "发草稿并写证据"],
    acceptance: ["draft-found", "draft-complete", "draft-sent"],
    run: runGmailDraftSend,
  },
];

export function listConnectorFlows(): ConnectorFlowDefinition[] {
  return [...CONNECTOR_FLOWS];
}

export function getConnectorFlow(id: string): ConnectorFlowDefinition | undefined {
  return CONNECTOR_FLOWS.find((f) => f.id === id);
}

/** 验收结论格式化（纯文本：结论一行 + 每项检查一行 + 摘要）。 */
export function formatFlowResult(result: ConnectorFlowResult): string {
  const passedCount = result.checks.filter((c) => c.passed).length;
  const lines = [
    `业务流程：${result.flow}（${result.connector}）`,
    `结论：${result.passed ? "通过" : "不通过"}（${passedCount}/${result.checks.length} 项检查通过，用时 ${result.durationMs}ms）`,
  ];
  for (const c of result.checks) {
    lines.push(`- [${c.passed ? "通过" : "不通过"}] ${c.name}：${c.detail}`);
  }
  lines.push(`摘要：${result.summary}`);
  return lines.join("\n");
}

/**
 * 跑一条业务流程：找流程 → 跑 → 记审计 + 用量 + 证据文件（结论报告）。
 * 流程里抛出的前置错误（缺参数、没批准、没桥）也收成“不通过”的结论返回，
 * 不抛到 CLI 崩掉；未知的流程 id 才抛错（CLI 用法错）。
 */
export async function runConnectorFlow(
  home: string,
  config: Record<string, unknown>,
  flowId: string,
  input: Record<string, unknown>,
  deps?: FlowDeps,
): Promise<ConnectorFlowResult> {
  const def = getConnectorFlow(flowId);
  if (!def) {
    throw new ConnectorFlowError(`未知业务流程：${flowId}（nyra connector flows 列出能用的：${CONNECTOR_FLOWS.map((f) => f.id).join("、")}）`);
  }
  const startedAt = Date.now();
  const finish = (checks: FlowCheck[], summary: string): ConnectorFlowResult => {
    const passed = checks.length > 0 && checks.every((c) => c.passed);
    const result: ConnectorFlowResult = {
      flow: def.id,
      connector: def.connector,
      passed,
      checks,
      summary,
      durationMs: Date.now() - startedAt,
    };
    const userId = resolveConnectorUserId(home);
    try {
      appendConnectorAudit(home, {
        action: "call",
        connector: def.connector,
        userId,
        operation: `flow:${def.id}`,
        records: checks.filter((c) => c.passed).length,
        durationMs: result.durationMs,
        ...(passed ? {} : { reason: `flow-failed:${checks.filter((c) => !c.passed).map((c) => c.name).join(",")}` }),
      });
    } catch { /* 审计写不进去不改结论 */ }
    try {
      recordConnectorCall(home, {
        connector: def.connector,
        operation: `flow:${def.id}`,
        records: checks.filter((c) => c.passed).length,
        durationMs: result.durationMs,
        userId,
      });
    } catch { /* 用量记不上不改结论 */ }
    try {
      new EvidenceStore(join(resolveNyraHome(home), "evidence"), "connector").save(
        "connector_flow",
        `connector-flow://${def.id}`,
        formatFlowResult(result),
      );
    } catch { /* 证据落盘失败不改结论 */ }
    return result;
  };
  try {
    const outcome = await def.run({ home, config, input, deps: deps ?? {} });
    return finish(outcome.checks, outcome.summary);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return finish([check("flow-error", false, message)], message);
  }
}
