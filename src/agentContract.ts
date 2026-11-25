// H7：最小稳定 agent 间契约 nyra-contract-v1（Hermes/TalosBrain 借鉴）。
//
// 定位：不是新协议。契约是 MCP 与 A2A 两个既有面的一张“稳定子集清单”——
// 10 条命令，每条写死它走哪个既有面（MCP 工具名 / A2A 方法名），
// Bot 之间互操作、机器人市场里的 Bot 调别的 Bot，都只认这 10 条。
// 契约本身不新增模型工具、不新增协议方法；版本号写进契约标识。
//
// 不在本批做（B7 剩余，见 docs/agent-contract.md）：
// 契约化交接验收（对方是否按契约回了验收证据）与跨 Bot 成本归属。

import { MCP_SERVER_TOOLS } from "./mcp.ts";

/** 契约标识：版本号写进 id。 */
export const NYRA_CONTRACT_ID = "nyra-contract-v1";
export const NYRA_CONTRACT_VERSION = "1";

/** A2A 服务端现有的 JSON-RPC 方法（src/a2a.ts 的分发清单）。 */
export const A2A_CONTRACT_METHODS = [
  "agent/card",
  "message/send",
  "message/stream",
  "tasks/get",
  "tasks/cancel",
  "tasks/list",
  "tasks/resubscribe",
] as const;

/** 契约命令走的面。 */
export type AgentContractSurface = "mcp" | "a2a" | "both";

export interface AgentContractInput {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required: boolean;
  description: string;
}

export interface AgentContractCommand {
  /** 命令名（稳定，改名即升版）。 */
  name: string;
  /** 中文名。 */
  title: string;
  description: string;
  surface: AgentContractSurface;
  /** 走 MCP 时对应的既有 MCP 工具名（须在 MCP_SERVER_TOOLS 里）。 */
  mcpTool?: string;
  /** 走 A2A 时对应的既有 JSON-RPC 方法（须在 A2A_CONTRACT_METHODS 里）。 */
  a2aMethod?: string;
  /** 是否写操作：写操作在 MCP 侧仍须 allow_writes + 审查层放行。 */
  write: boolean;
  inputs: AgentContractInput[];
  /** 输出形状（文字描述，约束实现不编新字段）。 */
  outputs: string;
}

/**
 * 10 条命令。选法：只认 MCP 与 A2A 上已经存在的东西——
 * 6 个 MCP 工具全在契约里（ask/recall/remember/forget/tasks/delegate），
 * A2A 的 card / message/send / tasks/get 补上连通性、状态、技能与交接。
 * `cost`（查花费）故意不在这 10 条里：跨 Bot 成本归属是 B7 剩余，
 * 验收与归属规则没定之前不把 cost 写进稳定契约。
 */
export const AGENT_CONTRACT_COMMANDS: AgentContractCommand[] = [
  {
    name: "ping",
    title: "连通性检查",
    description: "只读。取对方的 A2A agent 卡片，确认对方在线且认 nyra-contract-v1。",
    surface: "a2a",
    a2aMethod: "agent/card",
    write: false,
    inputs: [],
    outputs: "agent 卡片（含 contract 字段，contract.id 为 nyra-contract-v1）。",
  },
  {
    name: "ask",
    title: "问一个问题",
    description: "只读。让对方的 agent 答一个问题，对方只读跑一轮（最多 4 轮），不写东西。",
    surface: "mcp",
    mcpTool: "answer_question",
    write: false,
    inputs: [{ name: "question", type: "string", required: true, description: "要问的问题。" }],
    outputs: "回答正文 + 引用了哪几条记忆/证据的 id。",
  },
  {
    name: "recall",
    title: "查记忆",
    description: "只读。在对方的记忆里搜一段内容，只回匹配的条目摘要。",
    surface: "mcp",
    mcpTool: "search_memory",
    write: false,
    inputs: [
      { name: "query", type: "string", required: true, description: "要搜的关键词或句子。" },
      { name: "limit", type: "number", required: false, description: "最多回几条，默认 5。" },
    ],
    outputs: "匹配的记忆条目（id、主题、正文摘要、证据条数），不含密钥原文。",
  },
  {
    name: "remember",
    title: "记一条记忆",
    description: "写操作。把一条记忆记进对方的记忆账本；须过对方的记忆证据门，证据不足会被拒。",
    surface: "mcp",
    mcpTool: "add_memory",
    write: true,
    inputs: [
      { name: "content", type: "string", required: true, description: "记忆正文，最多 300 字。" },
      { name: "subject", type: "string", required: false, description: "主题，默认取正文前 12 字。" },
      { name: "evidenceQuotes", type: "object", required: true, description: "1–8 条逐字依据（数组）。" },
    ],
    outputs: "新条目的 id 与状态（confirmed / proposed）。",
  },
  {
    name: "forget",
    title: "忘掉一个会话的记忆",
    description: "写操作。让对方忘掉指定会话里记下的记忆（进删除账本，可审计）。",
    surface: "mcp",
    mcpTool: "forget_session",
    write: true,
    inputs: [{ name: "sessionId", type: "string", required: true, description: "要忘掉的会话 id。" }],
    outputs: "被忘掉的条目数。",
  },
  {
    name: "tasks",
    title: "查任务",
    description: "只读。查对方一个任务/运行的进展与证据（MCP 侧按运行 id 查事件，A2A 侧按任务 id 查状态）。",
    surface: "both",
    mcpTool: "query_evidence",
    a2aMethod: "tasks/get",
    write: false,
    inputs: [{ name: "id", type: "string", required: true, description: "运行 id（MCP）或任务 id（A2A）。" }],
    outputs: "任务状态 + 事件摘要（不含任务输入/输出原文）。",
  },
  {
    name: "skills",
    title: "列技能",
    description: "只读。列出对方 agent 卡片里的技能（名字与一句话说明）。",
    surface: "a2a",
    a2aMethod: "agent/card",
    write: false,
    inputs: [],
    outputs: "agent 卡片的 skills 数组。",
  },
  {
    name: "status",
    title: "查状态",
    description: "只读。取对方的 agent 卡片，看名字、版本、能力与支持的契约命令。",
    surface: "a2a",
    a2aMethod: "agent/card",
    write: false,
    inputs: [],
    outputs: "agent 卡片（含 contract 字段）。",
  },
  {
    name: "delegate",
    title: "委派一个任务",
    description: "写操作。把一个任务派给对方跑；对方先记提议、须审查放行才执行，不自动放行。",
    surface: "mcp",
    mcpTool: "dispatch_task",
    write: true,
    inputs: [
      { name: "task", type: "string", required: true, description: "任务描述。" },
      { name: "contextId", type: "string", required: false, description: "会话上下文 id。" },
    ],
    outputs: "对方记下的任务 id 与状态（提议已记 / 已放行 / 已拒）。",
  },
  {
    name: "handoff",
    title: "交接给另一台 Bot",
    description: "写操作。把一次对话/任务连同上下文交接给另一台 Bot（A2A message/send，payload 里带 contract id 与交接单）。注意：交接是否被对方按契约验收、花费归谁，是 B7 剩余，本批只定 payload 形状，不做验收与归属。",
    surface: "a2a",
    a2aMethod: "message/send",
    write: true,
    inputs: [
      { name: "to", type: "string", required: true, description: "接收方 Bot 的名字或地址。" },
      { name: "task", type: "string", required: true, description: "要交接的任务描述。" },
      { name: "context", type: "object", required: false, description: "交接上下文（摘要、已做步骤、下一步）。" },
    ],
    outputs: "对方回的任务 id（交接已收下，不代表已验收——验收是 B7 剩余）。",
  },
];

/** 契约对象（进 A2A agent 卡片的 contract 字段，也供 `nyra mcp contract` 打印）。 */
export function agentContract(): { id: string; version: string; commands: AgentContractCommand[] } {
  return { id: NYRA_CONTRACT_ID, version: NYRA_CONTRACT_VERSION, commands: AGENT_CONTRACT_COMMANDS };
}

/** 按名取一条契约命令，不存在回 undefined。 */
export function agentContractCommand(name: string): AgentContractCommand | undefined {
  return AGENT_CONTRACT_COMMANDS.find((c) => c.name === name);
}

/**
 * 契约自检（测试与 `nyra mcp contract --check` 共用）：
 * 命令名唯一、每条都写明了面、MCP 工具名真实存在、A2A 方法真实存在、
 * 写操作标清楚了、输入输出不为空。
 */
export function validateAgentContract(): string[] {
  const problems: string[] = [];
  const mcpNames = new Set(MCP_SERVER_TOOLS.map((t) => t.name));
  const a2aMethods = new Set<string>(A2A_CONTRACT_METHODS);
  const seen = new Set<string>();
  if (!NYRA_CONTRACT_ID.endsWith(`-v${NYRA_CONTRACT_VERSION}`)) {
    problems.push(`契约 id ${NYRA_CONTRACT_ID} 与版本号 ${NYRA_CONTRACT_VERSION} 对不上`);
  }
  for (const cmd of AGENT_CONTRACT_COMMANDS) {
    if (seen.has(cmd.name)) problems.push(`命令名重复：${cmd.name}`);
    seen.add(cmd.name);
    if (!cmd.title || !cmd.description || !cmd.outputs) problems.push(`命令 ${cmd.name} 的说明/输出为空`);
    if (cmd.surface === "mcp" || cmd.surface === "both") {
      if (!cmd.mcpTool) problems.push(`命令 ${cmd.name} 走 MCP 却没写 mcpTool`);
      else if (!mcpNames.has(cmd.mcpTool)) problems.push(`命令 ${cmd.name} 的 MCP 工具 ${cmd.mcpTool} 不存在`);
    }
    if (cmd.surface === "a2a" || cmd.surface === "both") {
      if (!cmd.a2aMethod) problems.push(`命令 ${cmd.name} 走 A2A 却没写 a2aMethod`);
      else if (!a2aMethods.has(cmd.a2aMethod)) problems.push(`命令 ${cmd.name} 的 A2A 方法 ${cmd.a2aMethod} 不存在`);
    }
    if (cmd.surface === "mcp" && cmd.a2aMethod) problems.push(`命令 ${cmd.name} 只走 MCP 却写了 a2aMethod`);
    if (cmd.surface === "a2a" && cmd.mcpTool) problems.push(`命令 ${cmd.name} 只走 A2A 却写了 mcpTool`);
    for (const input of cmd.inputs) {
      if (!input.name || !input.description) problems.push(`命令 ${cmd.name} 有输入没写名字/说明`);
    }
  }
  return problems;
}
