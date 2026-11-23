// src/businessRedlines.ts — Bot 缺口 51：业务动作硬红线表。
//
// 一张声明式的硬红线表，按业务动作逐项定三档：自由做 / 永远须人批 / 永远
// 禁做（见 ~/workspace/research_notes/nyra-bot-direction-20261120.md §6）。
// 这是“Bot 敢碰业务”的安全前提，也是缺口 43（策略网关）的第一份策略内容。
//
// 要点（报告原文 + 落地口径）：
//   - 红线表是每个 Bot / 每个业务连接器的必填配置：没有红线表的连接器
//     不允许接业务系统（未知连接器的动作一律按“永远禁做”处理，fail-closed）。
//   - 红线不可被 Bot 自己的 Custom Rules 覆盖：执行顺序保证——确定性红线
//     判定跑在权限规则（用户的自定义规则）与模型审查之前，模型与自定义
//     规则都改不了它（见 tools.ts 的 checkApproval 与 reviewer.ts 的
//     reviewToolCall；测试 test-business-redlines.test.ts 覆盖）。
//   - 用户可收紧、不可放松：收紧（向更严一档改）随时可改；放松（向更松一
//     档改）须显式批准（CLI 上是 --yes）并记原因，变更记进账本的 changes
//     与审计文件，进证据链（redline_changed 事件只记原因指纹）。
//   - 执行在网关，不在提示词：红线由审查层（缺口 10）与 Bot 审批桥执行，
//     不是靠模型自觉——模型说“我要转钱”时直接拦截并记一条证据。
//   - 起草与发出分离：起草（draft）自由做，发出（send_message）永远须人批。
//
// 注意：本模块的“红线表”与 `nyra redlines`（src/redlines.ts，上线红线
// 自检）是两个东西，不要混用——那个是上线前的配置体检，这个是业务动作
// 的三档策略表。CLI 入口是 `nyra bot redlines ...`，不是 `nyra redlines`。
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync, writeSync, fsyncSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ReviewVerdict } from "./reviewer.ts";

/** 红线三档：自由做 < 永远须人批 < 永远禁做（数值越大越严）。 */
export type RedlineTier = "free" | "approve" | "never";
export const TIER_ORDER: Record<RedlineTier, number> = { free: 0, approve: 1, never: 2 };
export const TIER_LABELS: Record<RedlineTier, string> = {
  free: "自由做",
  approve: "永远须人批",
  never: "永远禁做",
};

/** 业务动作（报告 §6 缺口 51 定义 + 连接器动作拆分）。 */
export type BusinessAction =
  | "draft"
  | "query"
  | "send_message"
  | "pay"
  | "sign"
  | "delete"
  | "change_password"
  | "transfer"
  | "trade_securities"
  | "transfer_funds"
  | "collect_card"
  | "collect_id"
  | "impersonate";

/** 全部业务动作 + 中文名 + 全局默认档（报告原文逐项落档）。 */
export const BUSINESS_ACTIONS: readonly { id: BusinessAction; label: string; defaultTier: RedlineTier }[] = [
  { id: "draft", label: "起草", defaultTier: "free" },
  { id: "query", label: "查询", defaultTier: "free" },
  { id: "send_message", label: "发消息", defaultTier: "approve" },
  { id: "pay", label: "付款", defaultTier: "approve" },
  { id: "sign", label: "签署文件", defaultTier: "approve" },
  { id: "delete", label: "删除信息", defaultTier: "approve" },
  { id: "change_password", label: "改密码", defaultTier: "approve" },
  { id: "transfer", label: "转账", defaultTier: "approve" },
  { id: "trade_securities", label: "交易证券", defaultTier: "never" },
  { id: "transfer_funds", label: "在账户之间转移资金", defaultTier: "never" },
  { id: "collect_card", label: "收集卡号", defaultTier: "never" },
  { id: "collect_id", label: "收集身份证号", defaultTier: "never" },
  { id: "impersonate", label: "冒充真人身份对外联系", defaultTier: "never" },
];
export const BUSINESS_ACTION_LABELS: Record<BusinessAction, string> = Object.fromEntries(
  BUSINESS_ACTIONS.map((a) => [a.id, a.label]),
) as Record<BusinessAction, string>;
export const BUSINESS_ACTION_IDS: readonly BusinessAction[] = BUSINESS_ACTIONS.map((a) => a.id);

/** 全局默认红线表：每个动作的默认档（报告原文）。 */
export const DEFAULT_GLOBAL_REDLINES: Record<BusinessAction, RedlineTier> = Object.fromEntries(
  BUSINESS_ACTIONS.map((a) => [a.id, a.defaultTier]),
) as Record<BusinessAction, RedlineTier>;

/**
 * 每个已落地连接器的默认红线表（报告要求“每个业务连接器自带一份默认表”）。
 * 三家目前与全局默认一致，但逐项写明——以后某家收紧时只改它自己的表，
 * 不动全局；表里没写的动作回退到全局默认。
 */
export const DEFAULT_CONNECTOR_REDLINES: Record<string, Partial<Record<BusinessAction, RedlineTier>>> = {
  gmail: {
    draft: "free",
    query: "free",
    send_message: "approve",
    delete: "approve",
    pay: "approve",
    sign: "approve",
    change_password: "approve",
    transfer: "approve",
    trade_securities: "never",
    transfer_funds: "never",
    collect_card: "never",
    collect_id: "never",
    impersonate: "never",
  },
  shopify: {
    // 只读起步：查是自由做；改价/退款/下单这类写操作本批连入口都没有，
    // 表里先按“永远须人批”占位（真有写入口的那批再按动作细化），禁做档与全局一致。
    draft: "free",
    query: "free",
    send_message: "approve",
    pay: "approve",
    sign: "approve",
    delete: "approve",
    change_password: "approve",
    transfer: "approve",
    trade_securities: "never",
    transfer_funds: "never",
    collect_card: "never",
    collect_id: "never",
    impersonate: "never",
  },
  slack: {
    draft: "free",
    query: "free",
    send_message: "approve",
    delete: "approve",
    pay: "approve",
    sign: "approve",
    change_password: "approve",
    transfer: "approve",
    trade_securities: "never",
    transfer_funds: "never",
    collect_card: "never",
    collect_id: "never",
    impersonate: "never",
  },
};

/** 有默认红线表的连接器（与 src/connectors/registry.ts 的目录一致）。 */
export function hasRedlineTable(connector: string): boolean {
  return connector in DEFAULT_CONNECTOR_REDLINES;
}

export class BusinessRedlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessRedlineError";
  }
}

/** 一次红线变更记录（只记元数据与原因原文——账本是用户本机的文件）。 */
export interface BusinessRedlineChange {
  at: string;
  connector: string;
  action: BusinessAction;
  from: RedlineTier;
  to: RedlineTier;
  reason: string;
}

/** 红线账本：只存“用户改动”（overrides）与变更记录；默认表在代码里。 */
export interface BusinessRedlineStore {
  version: 1;
  overrides: Record<string, Partial<Record<BusinessAction, RedlineTier>>>;
  changes: BusinessRedlineChange[];
}

export function businessRedlineStorePath(home: string): string {
  return join(home, "business-redlines.json");
}

export const BUSINESS_REDLINE_AUDIT_FILE = "business-redlines-audit.jsonl";

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err: unknown) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 读红线账本；不存在返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadBusinessRedlineStore(home: string): BusinessRedlineStore {
  const path = businessRedlineStorePath(home);
  if (!existsSync(path)) return { version: 1, overrides: {}, changes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new BusinessRedlineError(`业务红线账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !raw || typeof (raw as BusinessRedlineStore).overrides !== "object"
    || !Array.isArray((raw as BusinessRedlineStore).changes)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new BusinessRedlineError(`业务红线账本格式无效，已备份到 ${backup}`);
  }
  return raw as BusinessRedlineStore;
}

export function saveBusinessRedlineStore(home: string, store: BusinessRedlineStore): void {
  atomicWriteJson(businessRedlineStorePath(home), store);
}

function isValidAction(action: string): action is BusinessAction {
  return (BUSINESS_ACTION_IDS as readonly string[]).includes(action);
}

function isValidTier(tier: string): tier is RedlineTier {
  return tier === "free" || tier === "approve" || tier === "never";
}

/**
 * 查某连接器某动作的有效档：用户改动 > 连接器默认表 > 全局默认表。
 * home 为 null 时只用默认表（读不到账本也不抛错）；未知连接器（没有默认
 * 表）一律回 "never"——没有红线表的连接器不允许接业务系统（fail-closed）。
 */
export function resolveRedlineTier(home: string | null, connector: string, action: BusinessAction): RedlineTier {
  if (!hasRedlineTable(connector)) return "never";
  if (home !== null) {
    const store = loadBusinessRedlineStore(home);
    const override = store.overrides[connector]?.[action];
    if (override !== undefined && isValidTier(override)) return override;
  }
  const connectorDefault = DEFAULT_CONNECTOR_REDLINES[connector]?.[action];
  if (connectorDefault !== undefined) return connectorDefault;
  return DEFAULT_GLOBAL_REDLINES[action];
}

/** 原因指纹（SHA-256 前 12 位）：事件里只记指纹，不记原因原文。 */
export function redlineReasonHash(reason: string): string {
  return createHash("sha256").update(reason, "utf-8").digest("hex").slice(0, 12);
}

/**
 * 业务动作判定（确定性、不调模型）：
 * - free → 直接放行；
 * - approve → 须 approved === true（已有人批），否则不放行；
 * - never → 永远不放行，即使 approved === true。
 * 账本损坏时按 fail-closed 处理：全部动作按 never 拦，并把损坏原因写进 reason。
 */
export function checkBusinessAction(
  home: string | null,
  connector: string,
  action: BusinessAction,
  opts?: { approved?: boolean },
): { allowed: boolean; tier: RedlineTier; reason: string } {
  let tier: RedlineTier;
  try {
    tier = resolveRedlineTier(home, connector, action);
  } catch (err: unknown) {
    return {
      allowed: false,
      tier: "never",
      reason: `业务红线账本读失败，按“永远禁做”拦截（fail-closed）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const label = BUSINESS_ACTION_LABELS[action];
  if (tier === "free") {
    return { allowed: true, tier, reason: `业务动作「${label}」（${connector}）档位是自由做，直接放行` };
  }
  if (tier === "approve") {
    if (opts?.approved === true) {
      return { allowed: true, tier, reason: `业务动作「${label}」（${connector}）档位是永远须人批，已有人批，放行` };
    }
    return { allowed: false, tier, reason: `业务动作「${label}」（${connector}）档位是永远须人批，须有人批才能做` };
  }
  return { allowed: false, tier, reason: `业务动作「${label}」（${connector}）档位是永远禁做，即使已批准也不放行` };
}

/**
 * 业务动作审查门（与 peer.ts 的 reviewPeerAction 同款形状，供连接器 CLI
 * 与 Bot 审批桥调）：返回 ReviewVerdict；never 档与未批准的 approve 档
 * 都是 BLOCK（source 一律 deterministic，不调模型）。
 */
export function reviewBusinessAction(opts: {
  home: string | null;
  connector: string;
  action: BusinessAction;
  approved?: boolean;
}): ReviewVerdict {
  const check = checkBusinessAction(opts.home, opts.connector, opts.action, { approved: opts.approved });
  if (check.allowed) {
    return { decision: "ALLOW", reason: check.reason, reviewerModel: null, source: "deterministic" };
  }
  return {
    decision: "BLOCK",
    reason: check.reason,
    reviewerModel: null,
    source: "deterministic",
    rule: check.tier === "never" ? "redline-never" : "redline-approve",
  };
}

/**
 * 工具名 → 业务动作映射（执行层认得的桥）：目前只有 gmail_send 这一个
 * agent 工具在做红线表里的业务动作（发消息）；连接器 CLI（gmail/slack
 * 的 send）不走工具，直接调 reviewBusinessAction。以后 44 号连接器的
 * 写工具落地时，在这里加映射——映射本身就是“这个工具在干什么业务”。
 */
const TOOL_BUSINESS_ACTIONS: Record<string, { connector: string; action: BusinessAction }> = {
  gmail_search: { connector: "gmail", action: "query" },
  gmail_read: { connector: "gmail", action: "query" },
  gmail_send: { connector: "gmail", action: "send_message" },
  // 缺口 44 深化：Shopify / Slack 模型工具的业务动作映射（只读是 query，
  // 发消息是 send_message；Shopify 本批只读，没有写工具可映射）。
  shopify_products: { connector: "shopify", action: "query" },
  shopify_orders: { connector: "shopify", action: "query" },
  shopify_inventory: { connector: "shopify", action: "query" },
  slack_channels: { connector: "slack", action: "query" },
  slack_history: { connector: "slack", action: "query" },
  slack_send: { connector: "slack", action: "send_message" },
};

export function businessActionForTool(tool: string): { connector: string; action: BusinessAction } | null {
  return TOOL_BUSINESS_ACTIONS[tool] ?? null;
}

/**
 * checkApproval 用的 never 档拦截（tools.ts）：工具映射到的业务动作是
 * never 档时返回拦截原因，否则返回 null。账本损坏时同样拦截（fail-closed）。
 * 只拦 never 档——approve 档由现有的审批链（人工弹窗 / approveFn）满足，
 * 不在这里重复拦（否则审批还没问就先拦住了）。
 */
export function redlineNeverBlock(home: string | null, tool: string): { connector: string; action: BusinessAction; reason: string } | null {
  const mapped = businessActionForTool(tool);
  if (!mapped) return null;
  const check = checkBusinessAction(home, mapped.connector, mapped.action, { approved: true });
  if (check.tier === "never") {
    return { connector: mapped.connector, action: mapped.action, reason: check.reason };
  }
  return null;
}

/**
 * Bot 审批桥用的红线判定（bot/index.ts 的 approveViaBridge）：工具映射
 * 到的业务动作是 never 档时直接拒绝、不建挂起审批（不浪费一次人工审批）；
 * 不是 never 档时返回 null，走正常审批链。
 */
export function botToolRedlineVerdict(home: string, tool: string): { blocked: boolean; reason: string } | null {
  const mapped = businessActionForTool(tool);
  if (!mapped) return null;
  const check = checkBusinessAction(home, mapped.connector, mapped.action, { approved: true });
  if (check.tier === "never") return { blocked: true, reason: check.reason };
  return null;
}

/**
 * 改红线表：收紧（向更严一档）随时可改；放松（向更松一档）须显式批准
 *（approved === true）并记原因，否则抛错。改动记进账本的 changes（证据）。
 * 改成同一档时返回 null（无变化，不记账）。
 */
export function applyRedlineChange(
  home: string,
  connector: string,
  action: string,
  tier: string,
  opts?: { reason?: string; approved?: boolean },
): BusinessRedlineChange | null {
  if (!hasRedlineTable(connector)) {
    throw new BusinessRedlineError(`没有 ${connector} 的红线表（未知连接器，业务动作一律禁做；先接连接器再配表）`);
  }
  if (!isValidAction(action)) {
    throw new BusinessRedlineError(`未知业务动作 ${action}（可用动作：${BUSINESS_ACTION_IDS.join("、")}）`);
  }
  if (!isValidTier(tier)) {
    throw new BusinessRedlineError(`未知档位 ${tier}（只认 free / approve / never）`);
  }
  const store = loadBusinessRedlineStore(home);
  const from = resolveRedlineTier(home, connector, action);
  if (from === tier) return null;
  const loosening = TIER_ORDER[tier] < TIER_ORDER[from];
  if (loosening) {
    if (opts?.approved !== true) {
      throw new BusinessRedlineError(`放松红线（${BUSINESS_ACTION_LABELS[action]}：${TIER_LABELS[from]} → ${TIER_LABELS[tier]}）须显式批准：加 --yes 并用 --reason 写明原因`);
    }
    if (!opts?.reason || !opts.reason.trim()) {
      throw new BusinessRedlineError(`放松红线须记原因：加 --reason 写明为什么放松（原因会记进账本）`);
    }
  }
  const change: BusinessRedlineChange = {
    at: new Date().toISOString(),
    connector,
    action,
    from,
    to: tier,
    reason: opts?.reason?.trim() ?? (loosening ? "" : "收紧红线"),
  };
  const overrides = store.overrides[connector] ?? {};
  overrides[action] = tier;
  store.overrides[connector] = overrides;
  store.changes.push(change);
  saveBusinessRedlineStore(home, store);
  return change;
}

/** 红线审计行：拦截与变更各写一行（只记结论与指纹，不记业务原文）。 */
export function appendBusinessRedlineAudit(home: string, entry: Record<string, unknown>): void {
  const dir = home;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, BUSINESS_REDLINE_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

/** 某连接器的有效红线表（全部 13 个动作逐项列出，供 CLI 展示）。 */
export function effectiveRedlineTable(home: string | null, connector: string): { action: BusinessAction; label: string; tier: RedlineTier; overridden: boolean }[] {
  return BUSINESS_ACTIONS.map((a) => {
    let overridden = false;
    let tier = DEFAULT_GLOBAL_REDLINES[a.id];
    const connectorDefault = DEFAULT_CONNECTOR_REDLINES[connector]?.[a.id];
    if (connectorDefault !== undefined) tier = connectorDefault;
    if (home !== null) {
      try {
        const override = loadBusinessRedlineStore(home).overrides[connector]?.[a.id];
        if (override !== undefined && isValidTier(override)) {
          tier = override;
          overridden = true;
        }
      } catch { /* 账本损坏时展示默认表，错误由调用方另行报告 */ }
    }
    return { action: a.id, label: a.label, tier, overridden };
  });
}

// ---- CLI：`nyra bot redlines <status|list|show|tighten|loosen|set>` ----

export interface BusinessRedlinesCliInput {
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

const REDLINES_USAGE = "用法：\n"
+ "  nyra bot redlines status                                    红线表状态（哪些连接器有表、改了几处）\n"
+ "  nyra bot redlines list                                      列出全局默认表 + 各连接器的有效表\n"
+ "  nyra bot redlines show <连接器>                             看某连接器的有效表（gmail / shopify / slack）\n"
+ "  nyra bot redlines tighten <连接器> <动作>                   收紧一档（自由做→须人批→禁做，随时可改）\n"
+ "  nyra bot redlines loosen <连接器> <动作> --reason <原因> --yes   放松一档（须显式批准 + 记原因）\n"
+ "  nyra bot redlines set <连接器> <动作> <档位> [--reason <原因> --yes]  直接定档（放松时须 --yes + 原因）\n"
+ "动作：draft query send_message pay sign delete change_password transfer trade_securities transfer_funds collect_card collect_id impersonate\n"
+ "档位：free（自由做）/ approve（永远须人批）/ never（永远禁做）\n"
+ "详见 docs/business-redlines.md";

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

function tierStep(tier: RedlineTier, direction: "tighten" | "loosen"): RedlineTier | null {
  if (direction === "tighten") {
    if (tier === "free") return "approve";
    if (tier === "approve") return "never";
    return null;
  }
  if (tier === "never") return "approve";
  if (tier === "approve") return "free";
  return null;
}

export async function handleBusinessRedlines(argv: string[], home: string, input?: BusinessRedlinesCliInput): Promise<number> {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(REDLINES_USAGE + "\n");
      return 0;
    }
    if (cmd === "status") {
      const store = loadBusinessRedlineStore(home);
      process.stdout.write("业务动作硬红线表（缺口 51）：\n");
      for (const connector of Object.keys(DEFAULT_CONNECTOR_REDLINES)) {
        const count = Object.keys(store.overrides[connector] ?? {}).length;
        process.stdout.write(`  ${connector}：默认表已就绪${count ? `，已改 ${count} 处` : "，未改动"}\n`);
      }
      process.stdout.write(`变更记录：${store.changes.length} 条（账本 ~/.nyra/business-redlines.json）\n`);
      return 0;
    }
    if (cmd === "list") {
      process.stdout.write("全局默认表：\n");
      for (const a of BUSINESS_ACTIONS) {
        process.stdout.write(`  ${a.id}（${a.label}）：${TIER_LABELS[a.defaultTier]}\n`);
      }
      for (const connector of Object.keys(DEFAULT_CONNECTOR_REDLINES)) {
        process.stdout.write(`${connector} 的有效表：\n`);
        for (const row of effectiveRedlineTable(home, connector)) {
          process.stdout.write(`  ${row.action}（${row.label}）：${TIER_LABELS[row.tier]}${row.overridden ? "（已改）" : ""}\n`);
        }
      }
      return 0;
    }
    if (cmd === "show") {
      const connector = argv[1];
      if (!connector || !hasRedlineTable(connector)) {
        process.stderr.write(`未知连接器 ${connector ?? ""}（有红线表的连接器：${Object.keys(DEFAULT_CONNECTOR_REDLINES).join("、")}）\n`);
        return 2;
      }
      process.stdout.write(`${connector} 的有效表：\n`);
      for (const row of effectiveRedlineTable(home, connector)) {
        process.stdout.write(`  ${row.action}（${row.label}）：${TIER_LABELS[row.tier]}${row.overridden ? "（已改）" : ""}\n`);
      }
      return 0;
    }
    if (cmd === "tighten" || cmd === "loosen" || cmd === "set") {
      const connector = argv[1];
      const action = argv[2];
      if (!connector || !action) {
        process.stderr.write(REDLINES_USAGE + "\n");
        return 2;
      }
      if (!hasRedlineTable(connector)) {
        process.stderr.write(`未知连接器 ${connector}（有红线表的连接器：${Object.keys(DEFAULT_CONNECTOR_REDLINES).join("、")}）\n`);
        return 2;
      }
      if (!isValidAction(action)) {
        process.stderr.write(`未知业务动作 ${action}（可用动作：${BUSINESS_ACTION_IDS.join("、")}）\n`);
        return 2;
      }
      let target: RedlineTier;
      if (cmd === "set") {
        const tierArg = argv[3];
        if (!tierArg || !isValidTier(tierArg)) {
          process.stderr.write(`档位只认 free / approve / never，当前是 ${tierArg ?? "（空）"}\n`);
          return 2;
        }
        target = tierArg;
      } else {
        const current = resolveRedlineTier(home, connector, action);
        const stepped = tierStep(current, cmd);
        if (stepped === null) {
          process.stdout.write(`${connector} 的 ${action}（${BUSINESS_ACTION_LABELS[action]}）已经是${TIER_LABELS[current]}，${cmd === "tighten" ? "无法再收紧" : "无法再放松"}。\n`);
          return 0;
        }
        target = stepped;
      }
      const reason = flagValue(argv, "--reason");
      const approved = argv.includes("--yes");
      // 放松须显式批准 + 记原因：缺 flag 是用法错误（返回 2，先说明再退），
      // 不是执行失败——让用户一次看清缺什么，而不是先改一半再报错。
      const current = resolveRedlineTier(home, connector, action);
      if (TIER_ORDER[target] < TIER_ORDER[current]) {
        if (!approved) {
          process.stderr.write(`放松红线（${BUSINESS_ACTION_LABELS[action]}：${TIER_LABELS[current]} → ${TIER_LABELS[target]}）须显式批准：加 --yes\n`);
          return 2;
        }
        if (!reason || !reason.trim()) {
          process.stderr.write(`放松红线须记原因：加 --reason 写明为什么放松（原因会记进账本）\n`);
          return 2;
        }
      }
      const change = applyRedlineChange(home, connector, action, target, { reason, approved });
      if (change === null) {
        process.stdout.write(`${connector} 的 ${action}（${BUSINESS_ACTION_LABELS[action]}）已经是${TIER_LABELS[target]}，无需改动。\n`);
        return 0;
      }
      try {
        appendBusinessRedlineAudit(home, { kind: "changed", connector, action, from: change.from, to: change.to, reason_hash: redlineReasonHash(change.reason) });
      } catch { /* 审计落盘失败不破坏改表结果 */ }
      try {
        input?.onEvent?.("redline_changed", {
          connector,
          action,
          from: change.from,
          to: change.to,
          reason_hash: redlineReasonHash(change.reason),
        });
      } catch { /* 观察器故障不破坏改表结果 */ }
      process.stdout.write(`已改：${connector} 的 ${action}（${BUSINESS_ACTION_LABELS[action]}）：${TIER_LABELS[change.from]} → ${TIER_LABELS[change.to]}（原因：${change.reason}）\n`);
      return 0;
    }
    process.stderr.write(REDLINES_USAGE + "\n");
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
