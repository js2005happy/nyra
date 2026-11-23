// src/connectors/bundle.ts — 缺口 44 深化：连接器即技能包（四件套打包）。
//
// 报告缺口 44 要求：每个连接器 = OAuth 连接 + 一组工具 + 一组业务流程模板
// （缺口 46 的内容来源）+ 一份权限声明（能读什么、能写什么、红线是什么），
// 四件套一起上架到机器人市场，复用市场的验证信封与安装策略。
//
// 本模块只做打包与校验，不装新连接器、不碰凭证：
// - buildConnectorBundle：把一个已落地连接器的四件套拼成一个包对象；
//   校验是 fail-closed——声明缺失、红线表缺失、流程缺失或验收为空、工具组
//   里有未知工具、写工具没落到红线表的非自由档，任一成立就拒绝打包。
// - exportConnectorBundle：把包写成目录（connector.json / tools.json /
//   flows.json / redlines.json / permission-statement.txt / market-entry.json），
//   可直接提交到策展仓库；导出记录进证据链（不新开运行事件类型）。
// - 市场侧：kind "connector"（见 marketplace.ts 的 connector 分支）——
//   只验证、不安装：内置连接器已在代码里，第三方连接器安装是下一批。
//
// 工具面分两档：模型工具（在 TOOL_SCHEMAS 里，调用方传 knownTools 进来核对，
// 与 validateTemplateDefinition 同款做法，本模块不静态 import tools.ts，
// 免得 tools.ts ↔ bundle 之间成环）与 CLI-only 工具（只走终端命令，
// 见 CONNECTOR_CLI_ONLY_TOOLS，每项都须在声明的 alwaysRequireApproval 或
// alwaysForbidden 里有约束——没约束的 CLI 工具不许进包）。
// 红线档位以默认表为准（DEFAULT_CONNECTOR_REDLINES + 全局默认回退）：包是
// 出厂默认，用户收紧的红线在运行时由审查层与审批链执行，不改包本身。
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore } from "../evidence.ts";
import { resolveNyraHome } from "../memory.ts";
import {
  BUSINESS_ACTION_IDS, DEFAULT_CONNECTOR_REDLINES, DEFAULT_GLOBAL_REDLINES,
  businessActionForTool, hasRedlineTable,
  type BusinessAction, type RedlineTier,
} from "../businessRedlines.ts";
import { CONNECTOR_FLOWS } from "./flows.ts";
import { getDeclaration, type ConnectorPermissionDeclaration } from "./registry.ts";

export class ConnectorBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorBundleError";
  }
}

/** 包版本：四件套格式的版本（声明本身没有版本号，包格式有）。 */
export const CONNECTOR_BUNDLE_VERSION = "1.0.0";

/**
 * CLI-only 工具：声明里有、模型工具表里没有的工具。只走终端命令，包里写明
 * 命令与用途；可写的 CLI 工具须在声明的 alwaysRequireApproval 或
 * alwaysForbidden 里有约束（constraint 是声明里约束它的那句话；没约束的
 * 可写 CLI 工具不许进包）。只读的 CLI 工具不需要额外约束（只读本身就是约束）。
 * 注意：gmail_labels 在声明里被分到“标签”写组，但列标签本身不写任何东西，
 * 这里按只读处理（声明的分组以后可以再拆，不在本批改）。
 */
export const CONNECTOR_CLI_ONLY_TOOLS: Record<string, { cli: string; note: string; constraint?: string; readOnly?: boolean }> = {
  gmail_attachment: { cli: "nyra gmail attachment <id>", note: "下载附件" },
  gmail_labels: { cli: "nyra gmail labels", note: "列标签", readOnly: true },
  gmail_label: { cli: "nyra gmail label <id> <标签>", note: "贴标签", constraint: "gmail_label" },
  gmail_unlabel: { cli: "nyra gmail unlabel <id> <标签>", note: "摘标签", constraint: "gmail_unlabel" },
  gmail_mark_read: { cli: "nyra gmail mark-read <id>", note: "标已读", constraint: "gmail_mark_read" },
  gmail_mark_unread: { cli: "nyra gmail mark-unread <id>", note: "标未读", constraint: "gmail_mark_unread" },
  gmail_trash: { cli: "nyra gmail trash <id>", note: "进回收站", constraint: "gmail_trash" },
  slack_approval_card: { cli: "nyra slack card --channel <id> --approval <id>", note: "发审批卡", constraint: "发审批卡" },
};

export interface ConnectorBundleTool {
  name: string;
  group: string;
  access: "read" | "write";
  /** model = 模型工具表里的工具；cli = 只走终端命令。 */
  surface: "model" | "cli";
  cli?: string;
  /** 映射到的业务动作（模型工具必有；CLI-only 工具没有映射，约束在声明里）。 */
  action?: BusinessAction;
  /** 该动作在默认红线表里的档（free / approve / never）。 */
  tier?: RedlineTier;
}

export interface ConnectorBundleFlow {
  id: string;
  title: string;
  acceptance: string[];
}

export interface ConnectorBundle {
  kind: "connector";
  connector: string;
  displayName: string;
  version: string;
  description: string;
  scopes: { read: string[]; write: string[] };
  dataAccessed: string[];
  alwaysRequireApproval: string[];
  alwaysForbidden: string[];
  redlineTable: string;
  redlines: Partial<Record<BusinessAction, RedlineTier>>;
  tools: ConnectorBundleTool[];
  flows: ConnectorBundleFlow[];
  permissionStatement: string;
}

/** 默认红线档：连接器自己的表优先，表里没写的回退全局默认。 */
export function defaultRedlineTier(connector: string, action: BusinessAction): RedlineTier {
  return DEFAULT_CONNECTOR_REDLINES[connector]?.[action] ?? DEFAULT_GLOBAL_REDLINES[action];
}

/** 拼权限声明文本（给人看的四件套总览，随包分发）。 */
export function renderPermissionStatement(bundle: Omit<ConnectorBundle, "permissionStatement">): string {
  const lines: string[] = [];
  lines.push(`连接器：${bundle.displayName}（${bundle.connector}）`);
  lines.push(`说明：${bundle.description}`);
  lines.push(`读权限：${bundle.scopes.read.join("、") || "无"}`);
  lines.push(`写权限：${bundle.scopes.write.join("、") || "无"}`);
  lines.push(`会访问的数据：${bundle.dataAccessed.join("；") || "无"}`);
  lines.push("提供的工具：");
  for (const t of bundle.tools) {
    const surface = t.surface === "model" ? "模型工具" : `只走终端（${t.cli ?? ""}）`;
    const tier = t.tier ? `，红线档：${t.tier === "free" ? "自由做" : t.tier === "approve" ? "永远须人批" : "永远禁做"}` : "";
    lines.push(`- ${t.name}（${t.group}，${t.access === "read" ? "只读" : "可写"}，${surface}${t.action ? `，业务动作 ${t.action}` : ""}${tier}）`);
  }
  lines.push("业务流程：");
  for (const f of bundle.flows) {
    lines.push(`- ${f.id}：${f.title}（验收：${f.acceptance.join("、") || "无"}）`);
  }
  lines.push("默认红线表（缺口 51）：");
  for (const action of BUSINESS_ACTION_IDS) {
    const tier = bundle.redlines[action];
    if (tier === undefined) continue;
    lines.push(`- ${action}：${tier === "free" ? "自由做" : tier === "approve" ? "永远须人批" : "永远禁做"}`);
  }
  lines.push(`永远须人批：${bundle.alwaysRequireApproval.join("、") || "无"}`);
  lines.push(`永远禁做：${bundle.alwaysForbidden.join("、") || "无"}`);
  lines.push("注意：凭证只存本机密码箱，不出本机；撤销授权立即失效；每次调用都记进运行记录（调了哪个系统、读了什么、写了什么、谁调的）。");
  return lines.join("\n") + "\n";
}

/**
 * 拼一个连接器的四件套包并校验（fail-closed）。knownTools 传了才核对模型
 * 工具名（市场校验传 KNOWN_TOOLS，CLI 传 TOOL_SCHEMAS 的名字）；不传时只核
 * 对工具在声明里，不核模型工具表（调用方须在文档里写明没核什么）。
 */
export function buildConnectorBundle(
  connectorId: string,
  knownTools?: Set<string> | null,
): ConnectorBundle {
  const decl: ConnectorPermissionDeclaration | undefined = getDeclaration(connectorId);
  if (!decl) throw new ConnectorBundleError(`未知连接器：${connectorId}`);
  if (decl.status !== "available") {
    throw new ConnectorBundleError(`${decl.displayName} 还没接入（试点），不能打包`);
  }
  if (!hasRedlineTable(connectorId)) {
    throw new ConnectorBundleError(`${decl.displayName} 没有默认红线表，不能打包`);
  }
  const flows: ConnectorBundleFlow[] = CONNECTOR_FLOWS.filter((f) => f.connector === connectorId).map((f) => ({
    id: f.id, title: f.title, acceptance: [...f.acceptance],
  }));
  if (!flows.length) {
    throw new ConnectorBundleError(`${decl.displayName} 没有业务流程，不能打包（先给它补一条带验收标准的流程）`);
  }
  for (const f of flows) {
    if (!f.acceptance.length) {
      throw new ConnectorBundleError(`${decl.displayName} 的流程 ${f.id} 没有验收标准，不能打包`);
    }
  }
  const tools: ConnectorBundleTool[] = [];
  for (const group of decl.toolGroups) {
    for (const name of group.tools) {
      const cliOnly = CONNECTOR_CLI_ONLY_TOOLS[name];
      if (cliOnly) {
        if (group.access === "write" && !cliOnly.readOnly) {
          const constraint = cliOnly.constraint ?? name;
          const constrained = decl.alwaysRequireApproval.includes(constraint) ||
            decl.alwaysForbidden.some((x) => x.includes(constraint));
          if (!constrained) {
            throw new ConnectorBundleError(`${decl.displayName} 的 CLI 工具 ${name} 在声明里没约束（既不在永远须人批里，也不在永远禁做里），不能打包`);
          }
        }
        tools.push({ name, group: group.name, access: cliOnly.readOnly ? "read" : group.access, surface: "cli", cli: cliOnly.cli });
        continue;
      }
      if (knownTools && !knownTools.has(name)) {
        throw new ConnectorBundleError(`${decl.displayName} 的工具 ${name} 不是模型工具表里的工具，也不在 CLI-only 白名单里，不能打包`);
      }
      const mapped = businessActionForTool(name);
      if (!mapped) {
        throw new ConnectorBundleError(`${decl.displayName} 的模型工具 ${name} 没有业务动作映射，不能打包（先在 businessRedlines 里登记它）`);
      }
      const tier = defaultRedlineTier(connectorId, mapped.action);
      if (group.access === "read" && tier !== "free") {
        throw new ConnectorBundleError(`${decl.displayName} 的只读工具 ${name} 映射到业务动作 ${mapped.action}（红线档 ${tier}，不是自由做），声明与红线表对不上，不能打包`);
      }
      if (group.access === "write" && tier === "free") {
        throw new ConnectorBundleError(`${decl.displayName} 的可写工具 ${name} 映射到业务动作 ${mapped.action}（红线档是自由做），写操作必须落在永远须人批或永远禁做档，不能打包`);
      }
      tools.push({ name, group: group.name, access: group.access, surface: "model", action: mapped.action, tier });
    }
  }
  const redlines: Partial<Record<BusinessAction, RedlineTier>> = {};
  for (const action of BUSINESS_ACTION_IDS) {
    redlines[action] = defaultRedlineTier(connectorId, action);
  }
  const partial: Omit<ConnectorBundle, "permissionStatement"> = {
    kind: "connector",
    connector: decl.id,
    displayName: decl.displayName,
    version: CONNECTOR_BUNDLE_VERSION,
    description: decl.description,
    scopes: { read: [...decl.scopes.read], write: [...decl.scopes.write] },
    dataAccessed: [...decl.dataAccessed],
    alwaysRequireApproval: [...decl.alwaysRequireApproval],
    alwaysForbidden: [...decl.alwaysForbidden],
    redlineTable: decl.redlineTable,
    redlines,
    tools,
    flows,
  };
  return { ...partial, permissionStatement: renderPermissionStatement(partial) };
}

/** 包目录里写出的文件（market-entry.json 是给策展仓库的索引片段）。 */
export const CONNECTOR_BUNDLE_FILES = [
  "connector.json",
  "tools.json",
  "flows.json",
  "redlines.json",
  "permission-statement.txt",
  "market-entry.json",
] as const;

/**
 * 导出一个连接器的四件套包到目录（默认写当前目录下的 nyra-connector-<id>/）。
 * 目录已存在且非空时拒绝（不静默覆盖已导出的包）；导出记录进证据链。
 */
export function exportConnectorBundle(
  home: string,
  connectorId: string,
  outDir: string,
  knownTools?: Set<string> | null,
): { dir: string; files: string[]; bundle: ConnectorBundle } {
  const bundle = buildConnectorBundle(connectorId, knownTools);
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length > 0) {
    throw new ConnectorBundleError(`导出目录 ${outDir} 已有文件，先清空或换一个 --out 目录`);
  }
  const { permissionStatement, ...rest } = bundle;
  writeFileSync(join(outDir, "connector.json"), JSON.stringify(rest, null, 2) + "\n", "utf-8");
  writeFileSync(join(outDir, "tools.json"), JSON.stringify(bundle.tools, null, 2) + "\n", "utf-8");
  writeFileSync(join(outDir, "flows.json"), JSON.stringify(bundle.flows, null, 2) + "\n", "utf-8");
  writeFileSync(join(outDir, "redlines.json"), JSON.stringify(bundle.redlines, null, 2) + "\n", "utf-8");
  writeFileSync(join(outDir, "permission-statement.txt"), permissionStatement, "utf-8");
  writeFileSync(
    join(outDir, "market-entry.json"),
    JSON.stringify(
      {
        id: `connector-${bundle.connector}`,
        name: bundle.displayName,
        kind: "connector",
        version: bundle.version,
        description: bundle.description,
        path: ".",
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  try {
    new EvidenceStore(join(resolveNyraHome(home), "evidence"), "connector").save(
      "connector_bundle",
      `connector-bundle://${bundle.connector}`,
      [
        `连接器包：${bundle.displayName}（${bundle.connector}）v${bundle.version}`,
        `导出目录：${outDir}`,
        `工具 ${bundle.tools.length} 个（模型 ${bundle.tools.filter((t) => t.surface === "model").length}、终端 ${bundle.tools.filter((t) => t.surface === "cli").length}）、流程 ${bundle.flows.length} 条、红线表 ${bundle.redlineTable}`,
        `文件：${CONNECTOR_BUNDLE_FILES.join("、")}`,
      ].join("\n"),
    );
  } catch { /* 证据落盘失败不破坏导出 */ }
  return { dir: outDir, files: [...CONNECTOR_BUNDLE_FILES], bundle };
}
