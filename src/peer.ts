// src/peer.ts — 缺口 12：Agent 间直接协作（互问、交接、共享上下文）。
//
// 传输走缺口 17 已有的对外 MCP 服务（HTTP JSON-RPC），不新发明传输协议：
// 互问调对端新增的只读工具 `answer_question`（对端用只读 agent 回一小段
// 回答，最多 4 轮）；交接调已有的 `dispatch_task`（只读模式入队，对端按
// 自己的审查与审批跑）。不做局域网自动发现、不扫网段：对端须用户显式配
// 在 config.json 的 `peers.list` 里（名字 + 地址）。
//
// 安全边界（与缺口 44 第 0 批、缺口 17 同款 fail-closed）：
// - 对端协作默认关闭（`peers.enabled`），须 `nyra peer enable` 显式开；
// - 对外发消息与交接包是写操作，须过独立审查层（虚拟动作 `peer_ask` /
// `peer_handoff`，已加进 DEFAULT_REVIEWED_TOOLS；审查层未开启时直接
// 拒绝，不静默放行）；
// - 对端不可信：答复只当作外部输入，过 `wrapUntrusted` 再用，绝不直接当
// 指令执行；答复里的指令、链接、文件路径一律按不可信输入处理；
// - 交接包只含任务产物与元数据（任务描述、已验证的结论、已做步骤、待办、
// 证据摘要），不含令牌、密码、绝对路径与完整对话历史；共享字段走显式
// allowlist（默认任务 + 结论 + 步骤 + 待办，`evidence` 须 `--share`
// 显式加）；
// - 每次互问 / 交接写三处审计：Beads 账本（`~/.nyra/peer-handoffs.jsonl`，
// 见 src/beads.ts）、对端审计（`~/.nyra/peer-audit.jsonl`）、运行事件
// （`peer_asked` / `peer_handoff`，只记对端名、指纹与结论，不记原文）；
// - 对端网关 token 只存密码箱（条目 `peer-token-<名字>`，`nyra peer auth`
// 存）或 `NYRA_PEER_TOKEN_<名字>` 环境变量，绝不写进 config 与日志；
// - 对端花的 token 记在对端自己的账本里，本机只记“问过 / 交过”这一事实。
import { appendFileSync, mkdirSync} from "node:fs";
import { join} from "node:path";
import { createInterface} from "node:readline";
import { appendBead, beadHash, type BeadEntry, type BeadStatus} from "./beads.ts";
import { loadConfig, saveConfig} from "./config.ts";
import { MCPHttpClient, MCPServerConfig, type MCPTransportLike} from "./mcp.ts";
import { resolveNyraHome} from "./memory.ts";
import { buildReviewerRunner, reviewToolCall, reviewerEnabled, type ReviewerLike, type ReviewVerdict} from "./reviewer.ts";
import { redact, RunStore} from "./runs.ts";
import { wrapUntrusted} from "./untrusted.ts";
import { getCredential, Vault, vaultPath} from "./vault.ts";

export const PEER_AUDIT_FILE = "peer-audit.jsonl";
export const PEER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
export const PEER_ASK_TIMEOUT_S = 180;
export const PEER_MAX_QUESTION_CHARS = 2000;
export const PEER_ANSWER_MAX_CHARS = 4000;

export class PeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerError";
  }
}

export interface PeerEntry {
  name: string;
  url: string;
}

export interface PeerConfig {
  enabled: boolean;
  list: PeerEntry[];
}

/** config.json 的 peers 一节（默认全关；名字只认字母数字下划线与连字符，
* 地址只认 http/https；非法条目跳过并报一行 stderr，不拦整批启动）。 */
export function peerConfig(config: Record<string, unknown>): PeerConfig {
  const raw = (config.peers?? {}) as Record<string, unknown>;
  const list: PeerEntry[] = [];
  const rawList = raw.list;
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (!item || typeof item!== "object" || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      if (typeof e.name!== "string" ||!PEER_NAME_RE.test(e.name)) {
        process.stderr.write(`跳过无效对端：名字须是字母数字、下划线或连字符（最多 32 字）：${String(e.name?? "")}\n`);
        continue;
      }
      if (typeof e.url!== "string" ||!e.url.trim()) {
        process.stderr.write(`跳过无效对端 ${e.name}：url 须是非空字符串\n`);
        continue;
      }
      try {
        const u = new URL(e.url.trim());
        if (u.protocol!== "http:" && u.protocol!== "https:") throw new Error("只支持 http/https");
      } catch {
        process.stderr.write(`跳过无效对端 ${e.name}：url 必须是 http:// 或 https:// 开头的地址\n`);
        continue;
      }
      if (list.some((p) => p.name === e.name)) {
        process.stderr.write(`跳过重复对端：${e.name} 已配过\n`);
        continue;
      }
      list.push({ name: e.name, url: e.url.trim()});
    }
  } else if (rawList!== undefined) {
    process.stderr.write("peers.list 应为列表，已忽略\n");
  }
  return { enabled: raw.enabled === true, list};
}

export function resolvePeer(config: Record<string, unknown>, name: string): PeerEntry | null {
  return peerConfig(config).list.find((p) => p.name === name)?? null;
}

/** 密码箱条目名：peer-token-<名字>（名字明文、值加密，与 shopify 同款）。 */
export function peerTokenEntry(name: string): string {
  return `peer-token-${name}`;
}

export function peerTokenEnvName(name: string): string {
  return `NYRA_PEER_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 对端网关 token 的读取顺序：环境变量 → 密码箱（NYRA_VAULT_PASSWORD
* 解锁，见 vault.ts 的 getCredential）。没有就返回 null，不交互问密码
*（问密码是 `nyra peer auth` 的事）；没 token 时调用方按 403 的报错
* 文案指引用户去存 token。 */
export function loadPeerToken(home: string, name: string): string | null {
  const env = process.env[peerTokenEnvName(name)];
  if (env && env.trim()) return env.trim();
  return getCredential(peerTokenEntry(name), home);
}

/** 对端协作的写操作审查门（与 reviewMcpServerAction 同款：虚拟动作名
* 合并进 reviewer.tools 再调 reviewToolCall；审查层未开启时直接 BLOCK，
* fail-closed——对外发送面对的是外部 agent，默认不信任）。 */
export type PeerWriteAction = "peer_ask" | "peer_handoff";

export async function reviewPeerAction(opts: {
    config: Record<string, unknown>;
    home: string;
    action: PeerWriteAction;
    args: Record<string, unknown>;
    task?: string;
    runner?: ReviewerLike | null;
  }): Promise<ReviewVerdict> {
  if (reviewerEnabled(opts.config)!== true) {
    return {
      decision: "BLOCK",
      reason: "对端协作的对外发送须开启独立审查层（reviewer.enabled）：审查层未开启时直接拒绝；请先用 nyra reviewer enable 开启审查层",
      reviewerModel: null,
      source: "unavailable",
    };
  }
  const reviewer = (opts.config.reviewer?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...opts.config,
    reviewer: {
      ...reviewer,
      tools: [...new Set([...(Array.isArray(reviewer.tools)? (reviewer.tools as string[]): []), opts.action])],
    },
  };
  const runner = opts.runner!== undefined? opts.runner: buildReviewerRunner(opts.config, opts.home);
  return reviewToolCall({
      config: merged,
      tool: opts.action,
      args: opts.args,
      task: opts.task?? "",
      runner,
    });
}

/** 对端审计行：每次互问 / 交接写一行（时间戳自动加；只记结论与指纹）。 */
export function appendPeerAudit(home: string, entry: Record<string, unknown>): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700});
  appendFileSync(join(dir, PEER_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(),...entry}) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// 交接包：共享上下文的显式 allowlist
// ---------------------------------------------------------------------------

export type HandoffField = "task" | "conclusions" | "steps" | "todos" | "evidence";
export const HANDOFF_FIELDS: readonly HandoffField[] = ["task", "conclusions", "steps", "todos", "evidence"];
export const HANDOFF_DEFAULT_FIELDS: readonly HandoffField[] = ["task", "conclusions", "steps", "todos"];

export interface HandoffPackage {
  run_id: string;
  status: string;
  mode: string;
  task: string;
  conclusions: string[];
  steps: { tool: string; ok: boolean}[];
  todos: string[];
  /** 证据摘要：事件类型计数 + 最近事件类型（不含事件内容）。 */
  evidence: string[];
  fields: HandoffField[];
}

/** 脱敏一段文本：先过 redact（长词串当疑似密钥掩掉），再把本机 home 与
* 工作目录的绝对路径替换成占位符。交接包里永远不出现绝对路径。 */
export function scrubForHandoff(text: string, home: string, workdir: string): string {
  let out = redact(text)?? "";
  const homeResolved = resolveNyraHome(home);
  if (homeResolved) out = out.split(homeResolved).join("[home]");
  if (workdir) out = out.split(workdir).join("[workdir]");
  return out;
}

/** 从一次运行的 state + events 拼交接包。只读 state.json 与 events.jsonl，
* 不读会话文件（完整对话历史不共享）。fields 之外的字段不写进包里。 */
export function buildHandoffPackage(home: string, runId: string, fields: readonly HandoffField[] = HANDOFF_DEFAULT_FIELDS): HandoffPackage {
  for (const f of fields) {
    if (!HANDOFF_FIELDS.includes(f)) throw new PeerError(`交接包字段无效：${f}（可选：${HANDOFF_FIELDS.join("、")}）`);
  }
  const store = new RunStore(join(resolveNyraHome(home), "runs"));
  let state;
  try {
    state = store.load(runId);
  } catch {
    throw new PeerError(`找不到运行 ${runId}`);
  }
  const events = store.readEvents(runId);
  const workdir = typeof state.workdir === "string"? state.workdir: "";
  const scrub = (t: string) => scrubForHandoff(t, home, workdir);
  const pkg: HandoffPackage = {
    run_id: runId,
    status: typeof state.status === "string"? state.status: "unknown",
    mode: typeof state.mode === "string"? state.mode: "unknown",
    task: "",
    conclusions: [],
    steps: [],
    todos: [],
    evidence: [],
    fields: [...fields],
  };
  if (fields.includes("task")) pkg.task = scrub(typeof state.task === "string"? state.task: "");
  if (fields.includes("conclusions")) {
    for (const ev of events) {
      if (ev.type === "verifier_verdict") {
        const verdict = typeof ev.verdict === "string"? ev.verdict: "?";
        const reason = typeof ev.reason === "string"? ev.reason: "";
        pkg.conclusions.push(scrub(`验收：${verdict}${reason? `（${reason}）`: ""}`));
      }
    }
    if (!pkg.conclusions.length) {
      pkg.conclusions.push(`（本次运行没有已验证的结论；最终状态：${pkg.status}）`);
    }
  }
  if (fields.includes("steps")) {
    const seen = new Map<string, boolean>();
    for (const ev of events) {
      if (ev.type === "tool_result" && typeof ev.name === "string") {
        seen.set(ev.name, ev.ok!== false);
      }
    }
    pkg.steps = [...seen.entries()].slice(0, 50).map(([tool, ok]) => ({ tool, ok}));
  }
  if (fields.includes("todos")) {
    const pending = (state.pending_approval?? null) as Record<string, unknown> | null;
    if (pending && typeof pending.tool === "string") pkg.todos.push(`等审批：${pending.tool}`);
    if (pkg.status === "interrupted") pkg.todos.push("运行曾中断：请先确认中断前已成功的步骤，再续跑。");
    if (pkg.status === "awaiting_approval") pkg.todos.push("运行在等审批：续跑前请先处理挂起的审批。");
    if (pkg.status === "awaiting_interrupt") pkg.todos.push("运行在等人工回环：续跑前请先处理挂起的中断单。");
  }
  if (fields.includes("evidence")) {
    const counts = new Map<string, number>();
    for (const ev of events) {
      const t = typeof ev.type === "string" ? ev.type : "unknown";
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    pkg.evidence = [...counts.entries()].map(([type, n]) => `${type} × ${n}`);
    pkg.evidence.push(`事件共 ${events.length} 条（只共享类型摘要，不共享事件内容）`);
  }
  return pkg;
}

/** 交接包渲染成发给对端的任务文本（dispatch_task 的 task 参数）。 */
export function renderHandoffPackage(pkg: HandoffPackage): string {
  const lines: string[] = [
    "（只读续跑；写操作须对方显式接受）",
    `来源运行：${pkg.run_id}（状态 ${pkg.status}，模式 ${pkg.mode}）`,
    "本包只含任务产物与元数据：不含令牌、密码、绝对路径与完整对话历史。",
    "",
  ];
  if (pkg.fields.includes("task")) lines.push("## 任务", pkg.task || "（无任务描述）", "");
  if (pkg.fields.includes("conclusions")) lines.push("## 已验证的结论",...pkg.conclusions.map((c) => `- ${c}`), "");
  if (pkg.fields.includes("steps")) {
    lines.push("## 已做步骤");
    if (!pkg.steps.length) lines.push("- （本次运行没有工具调用记录）");
    for (const s of pkg.steps) lines.push(`- 工具 ${s.tool}：${s.ok? "成功": "失败"}`);
    lines.push("");
  }
  if (pkg.fields.includes("todos")) {
    lines.push("## 待办");
    if (!pkg.todos.length) lines.push("- （无待办）");
    for (const t of pkg.todos) lines.push(`- ${t}`);
    lines.push("");
  }
  if (pkg.fields.includes("evidence")) lines.push("## 证据（事件摘要）",...pkg.evidence.map((e) => `- ${e}`), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 互问 / 交接：发送端
// ---------------------------------------------------------------------------

export interface PeerCallDeps {
  /** 测试注入的客户端工厂；不传时现场建 MCPHttpClient。 */
  clientFactory?: (peer: PeerEntry, timeoutS: number, headers: Record<string, string>) => MCPTransportLike;
  /** 测试注入的审查 runner；不传时现场建（无凭证时为 null，审查 fail-closed）。 */
  reviewerRunner?: ReviewerLike | null;
  /** 测试注入的 token；不传时走 loadPeerToken。 */
  token?: string | null;
}

function peerClient(peer: PeerEntry, timeoutS: number, headers: Record<string, string>, deps?: PeerCallDeps): MCPTransportLike {
  if (deps?.clientFactory) return deps.clientFactory(peer, timeoutS, headers);
  const config = MCPServerConfig.fromDict(peer.name, { transport: "http", url: peer.url, headers});
  return new MCPHttpClient(config, timeoutS);
}

function peerHeaders(home: string, peer: PeerEntry, deps?: PeerCallDeps): Record<string, string> {
  const token = deps?.token!== undefined? deps.token: loadPeerToken(home, peer.name);
  return token? { Authorization: `Bearer ${token}`}: {};
}

/** 本次互问 / 交接的证据运行（CLI 没有 Agent 运行，单独建一条只记
* peer 事件的运行；证据写失败不破坏主流程）。 */
function createPeerEvidenceRun(home: string, task: string, workdir: string): { store: RunStore; runId: string} {
  const store = new RunStore(join(resolveNyraHome(home), "runs"));
  const state = store.create(task, "peer", workdir, "readonly", 1, "running");
  return { store, runId: state.run_id};
}

function recordPeerEvent(store: RunStore, runId: string, type: string, fields: Record<string, unknown>): void {
  try {
    store.appendEvent(runId, type, fields);
  } catch { /* 证据写失败不破坏调用 */}
}

function finishPeerRun(store: RunStore, runId: string, ok: boolean): void {
  try {
    store.setStatus(runId, ok ? "completed_unverified" : "failed");
  } catch { /* ignore */}
}

/** 问对端一个问题并等答复。答复过 wrapUntrusted 后返回（调用方直接打印
* 即可，不要再把答复原文写进事件与审计）。 */
export async function askPeer(opts: {
    config: Record<string, unknown>;
    home: string;
    peer: PeerEntry;
    question: string;
    workdir?: string;
    timeoutS?: number;
    deps?: PeerCallDeps;
  }): Promise<{ answer: string; bead: BeadEntry; runId: string}> {
  const { config, home, peer} = opts;
  const question = opts.question.trim();
  if (!question) throw new PeerError("问题不能为空");
  if (question.length > PEER_MAX_QUESTION_CHARS) {
    throw new PeerError(`问题最多 ${PEER_MAX_QUESTION_CHARS} 字（现在 ${question.length} 字）`);
  }
  if (!peerConfig(config).enabled) {
    throw new PeerError("对端协作未开启：先运行 nyra peer enable（默认关闭，显式 opt-in）");
  }
  const workdir = opts.workdir?? process.cwd();
  const questionHash = beadHash(question);
  const { store, runId} = createPeerEvidenceRun(home, `peer ask：${peer.name}`, workdir);
  const fail = (err: Error): never => {
    try {
      appendBead(home, { kind: "ask", to: peer.name, run_id: null, peer_run_id: null, content_hash: questionHash, status: "failed", error: err.message.slice(0, 200)});
    } catch { /* ignore */}
    try {
      appendPeerAudit(home, { action: "ask", peer: peer.name, question_hash: questionHash, ok: false, error: err.message.slice(0, 200)});
    } catch { /* ignore */}
    recordPeerEvent(store, runId, "peer_asked", { peer: peer.name, question_hash: questionHash, ok: false});
    finishPeerRun(store, runId, false);
    throw err;
  };
  // 缺口 34：只向信任圈里的对端发任务——对方须是已批准好友且在圈里。
  // 动态 import：circles.ts 经 peerCard 静态依赖 peer.ts，这里静态引
  // 入会形成循环导入（与 checkApproval 里动态引 team.ts 同款原因）。
  const { isAdmitted } = await import("./circles.ts");
  if (!isAdmitted(home, peer.name)) {
    return fail(new PeerError(`对方 ${peer.name} 不在信任圈里：先跑 nyra circle invite <圈名> ${peer.name} 把它引进圈（对方须先是已批准、未拉黑的好友）`));
  }
  const verdict = await reviewPeerAction({
      config, home, action: "peer_ask",
      args: { peer: peer.name, question_hash: questionHash},
      task: question.slice(0, 200),
      runner: opts.deps?.reviewerRunner,
    });
  if (verdict.decision === "BLOCK") {
    return fail(new PeerError(`独立审查拦截了本次互问：${verdict.reason}`));
  }
  let text: string;
  try {
    const client = peerClient(peer, opts.timeoutS?? PEER_ASK_TIMEOUT_S, peerHeaders(home, peer, opts.deps), opts.deps);
    try {
      text = await client.callTool("answer_question", { question});
    } finally {
      client.stop();
    }
  } catch (err) {
    const msg = err instanceof Error? err.message: String(err);
    return fail(new PeerError(`问对端失败（${peer.name}）：${msg}`));
  }
  if (text.startsWith("MCP 工具返回错误：")) {
    return fail(new PeerError(`对端拒绝回答：${text.slice("MCP 工具返回错误：".length).trim().slice(0, 300)}`));
  }
  const answer = wrapUntrusted(text.slice(0, PEER_ANSWER_MAX_CHARS), `对端 ${peer.name}`);
  const bead = appendBead(home, { kind: "ask", to: peer.name, run_id: null, peer_run_id: null, content_hash: questionHash, status: "answered"});
  appendPeerAudit(home, { action: "ask", peer: peer.name, question_hash: questionHash, ok: true});
  recordPeerEvent(store, runId, "peer_asked", { peer: peer.name, question_hash: questionHash, ok: true});
  finishPeerRun(store, runId, true);
  return { answer, bead, runId};
}

/** 把一次运行的上下文交接给对端续跑。默认只读模式；对端接下后回 run_id
* 即记 accepted（对方的审查拦截或入队失败记 rejected）。 */
export async function handoffPeer(opts: {
    config: Record<string, unknown>;
    home: string;
    peer: PeerEntry;
    runId: string;
    mode?: "readonly" | "auto";
    share?: readonly HandoffField[];
    workdir?: string;
    timeoutS?: number;
    deps?: PeerCallDeps;
  }): Promise<{ peerRunId: string | null; status: BeadStatus; bead: BeadEntry; runId: string}> {
  const { config, home, peer} = opts;
  const mode = opts.mode?? "readonly";
  if (mode!== "readonly" && mode!== "auto") throw new PeerError("交接模式只能是 readonly 或 auto");
  if (!peerConfig(config).enabled) {
    throw new PeerError("对端协作未开启：先运行 nyra peer enable（默认关闭，显式 opt-in）");
  }
  const workdir = opts.workdir?? process.cwd();
  const pkg = buildHandoffPackage(home, opts.runId, opts.share?? HANDOFF_DEFAULT_FIELDS);
  const taskText = renderHandoffPackage(pkg);
  const packageHash = beadHash(taskText);
  const { store, runId} = createPeerEvidenceRun(home, `peer handoff：${peer.name} <- ${opts.runId}`, workdir);
  const recordOutcome = (status: BeadStatus, peerRunId: string | null, error?: string): { peerRunId: string | null; status: BeadStatus; bead: BeadEntry; runId: string} => {
    const bead = appendBead(home, {
        kind: "handoff", to: peer.name, run_id: opts.runId, peer_run_id: peerRunId,
        content_hash: packageHash, status,...(error? { error: error.slice(0, 200)}: {}),
      });
    appendPeerAudit(home, { action: "handoff", peer: peer.name, run_id: opts.runId, peer_run_id: peerRunId, status,...(error? { error: error.slice(0, 200)}: {})});
    recordPeerEvent(store, runId, "peer_handoff", { peer: peer.name, run_id: opts.runId, peer_run_id: peerRunId?? "", status});
    finishPeerRun(store, runId, status === "accepted");
    return { peerRunId, status, bead, runId};
  };
  // 缺口 34：只向信任圈里的对端交接——对方须是已批准好友且在圈里。
  // 动态 import：circles.ts 经 peerCard 静态依赖 peer.ts，这里静态引
  // 入会形成循环导入（与 checkApproval 里动态引 team.ts 同款原因）。
  const { isAdmitted } = await import("./circles.ts");
  if (!isAdmitted(home, peer.name)) {
    return recordOutcome("rejected", null, `对方 ${peer.name} 不在信任圈里：先跑 nyra circle invite <圈名> ${peer.name} 把它引进圈（对方须先是已批准、未拉黑的好友）`);
  }
  const verdict = await reviewPeerAction({
      config, home, action: "peer_handoff",
      args: { peer: peer.name, run_id: opts.runId, package_hash: packageHash},
      task: pkg.task.slice(0, 200),
      runner: opts.deps?.reviewerRunner,
    });
  if (verdict.decision === "BLOCK") {
    return recordOutcome("rejected", null, `独立审查拦截了本次交接：${verdict.reason}`);
  }
  let text: string;
  try {
    const client = peerClient(peer, opts.timeoutS?? 60, peerHeaders(home, peer, opts.deps), opts.deps);
    try {
      text = await client.callTool("dispatch_task", { task: taskText, mode});
    } finally {
      client.stop();
    }
  } catch (err) {
    const msg = err instanceof Error? err.message: String(err);
    return recordOutcome("failed", null, `交接发送失败（${peer.name}）：${msg}`);
  }
  if (text.startsWith("MCP 工具返回错误：")) {
    return recordOutcome("rejected", null, text.slice("MCP 工具返回错误：".length).trim().slice(0, 300));
  }
  const m = text.match(/run_id\s+([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/);
  if (!m) return recordOutcome("failed", null, `对端回包里没有 run_id：${text.slice(0, 200)}`);
  return recordOutcome("accepted", m[1]);
}

// ---------------------------------------------------------------------------
// CLI：nyra peer <status|enable|disable|list|auth|ask|handoff>
// ---------------------------------------------------------------------------

export interface PeerCliInput {
  secrets?: string[];
  /** 测试注入：假客户端工厂 / 假审查 runner / 假 token。 */
  deps?: PeerCallDeps;
}

const PEER_USAGE = "用法：\n"
+ " nyra peer status 查看对端协作状态（是否开启、已配对端）\n"
+ " nyra peer enable | disable 开启 / 关闭对端协作（默认关闭）\n"
+ " nyra peer list 列出已配对端（名字与地址，不含令牌）\n"
+ " nyra peer auth <名字> 给对端存网关 token（只存密码箱）\n"
+ " nyra peer ask --to <名字> [--timeout N] <问题> 问对端一个问题并等答复（只读，须审查放行）\n"
+ " nyra peer handoff --to <名字> --run <运行ID> [--mode readonly|auto] [--share evidence]\n"
+ " 把一次运行的上下文交接给对端续跑（默认只读）\n"
+ "对端须先配在 config.json 的 peers.list 里（名字 + http(s) 地址）；\n"
+ "对外发送默认关闭，须先开对端协作、再开独立审查层，两道门都过才发。\n"
+ "详见 docs/peer.md";

export async function handlePeer(argv: string[], home: string, input?: PeerCliInput): Promise<number> {
  const config = loadConfig(home);
  const cmd = argv[0];
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1]!== undefined? argv[idx + 1]: undefined;
  };
  const secretQueue = [...(input?.secrets?? [])];
  const askSecret = async (prompt: string): Promise<string> => {
    if (secretQueue.length) return secretQueue.shift()!;
    const rl = createInterface({ input: process.stdin, output: process.stdout});
    const answer = await new Promise<string>((resolvePromise) => {
        rl.question(prompt, (a) => { rl.close(); resolvePromise(a);});
      });
    return answer;
  };
  if (!cmd || cmd === "status") {
    const cfg = peerConfig(config);
    process.stdout.write(`对端协作：${cfg.enabled? "已开启": "未开启（默认关闭）"}\n`);
    process.stdout.write(`已配对端：${cfg.list.length} 个\n`);
    for (const p of cfg.list) process.stdout.write(` ${p.name} ${p.url}\n`);
    if (!cfg.enabled) process.stdout.write("开启：nyra peer enable（对外发送还要先开独立审查层：nyra reviewer enable）\n");
    return 0;
  }
  if (cmd === "enable" || cmd === "disable") {
    const cfg = peerConfig(config);
    saveConfig(home, { peers: {...cfg, enabled: cmd === "enable"}});
    process.stdout.write(`对端协作已${cmd === "enable"? "开启": "关闭"}${cmd === "enable"? "（对外发送还要先开独立审查层：nyra reviewer enable）": ""}\n`);
    return 0;
  }
  if (cmd === "list") {
    const cfg = peerConfig(config);
    if (!cfg.list.length) {
      process.stdout.write("未配对端：请在 config.json 的 peers.list 里加 { \"name\": \"...\", \"url\": \"http://...:8080/mcp\"}\n");
      return 0;
    }
    for (const p of cfg.list) process.stdout.write(`${p.name}\t${p.url}\n`);
    return 0;
  }
  if (cmd === "auth") {
    const name = argv[1];
    if (!name ||!PEER_NAME_RE.test(name)) {
      process.stderr.write("用法：nyra peer auth <名字>\n");
      return 2;
    }
    const peer = resolvePeer(config, name);
    if (!peer) {
      process.stderr.write(`未配对端 ${name}：请先在 config.json 的 peers.list 里加它\n`);
      return 1;
    }
    const token = (await askSecret("对端网关 token（只存密码箱，不回显到别处）：")).trim();
    if (!token) {
      process.stderr.write("token 为空，未保存\n");
      return 2;
    }
    const vault = new Vault(vaultPath(home));
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return 1;
    }
    if (!vault.unlock(await askSecret("主密码："))) {
      process.stderr.write("主密码错误或密码箱已损坏\n");
      return 1;
    }
    vault.add(peerTokenEntry(name), token, true);
    process.stdout.write(`已把 ${name} 的网关 token 存进密码箱（条目 ${peerTokenEntry(name)}）\n`);
    return 0;
  }
  if (cmd === "ask") {
    const to = flagValue("--to");
    if (!to) {
      process.stderr.write("用法：nyra peer ask --to <名字> <问题>\n");
      return 2;
    }
    const peer = resolvePeer(config, to);
    if (!peer) {
      process.stderr.write(`未配对端 ${to}：请先在 config.json 的 peers.list 里加它\n`);
      return 1;
    }
    const timeoutRaw = flagValue("--timeout");
    const timeoutS = timeoutRaw === undefined? undefined: Math.min(600, Math.max(10, Math.floor(Number(timeoutRaw)) || PEER_ASK_TIMEOUT_S));
    const rest = argv.slice(1);
    const question = rest.filter((a, i) => a!== "--to" && a!== "--timeout" && rest[i - 1]!== "--to" && rest[i - 1]!== "--timeout").join(" ").trim();
    if (!question) {
      process.stderr.write("用法：nyra peer ask --to <名字> <问题>\n");
      return 2;
    }
    try {
      const { answer} = await askPeer({ config, home, peer, question, timeoutS, deps: input?.deps});
      process.stdout.write(answer + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(`错误：${err instanceof Error? err.message: String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "handoff") {
    const to = flagValue("--to");
    const runId = flagValue("--run");
    if (!to ||!runId) {
      process.stderr.write("用法：nyra peer handoff --to <名字> --run <运行ID> [--mode readonly|auto] [--share evidence]\n");
      return 2;
    }
    const peer = resolvePeer(config, to);
    if (!peer) {
      process.stderr.write(`未配对端 ${to}：请先在 config.json 的 peers.list 里加它\n`);
      return 1;
    }
    const modeRaw = flagValue("--mode")?? "readonly";
    if (modeRaw!== "readonly" && modeRaw!== "auto") {
      process.stderr.write("交接模式只能是 readonly 或 auto\n");
      return 2;
    }
    const share: HandoffField[] = [...HANDOFF_DEFAULT_FIELDS];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--share") {
        const v = argv[i + 1];
        if (v!== "evidence") {
          process.stderr.write("--share 目前只支持 evidence\n");
          return 2;
        }
        if (!share.includes("evidence")) share.push("evidence");
      }
    }
    try {
      const out = await handoffPeer({ config, home, peer, runId, mode: modeRaw, share, deps: input?.deps});
      process.stdout.write(`交接 ${out.status === "accepted"? "已接下": out.status === "rejected"? "被对端拒绝": "发送失败"}：账本 ${out.bead.id}\n`);
      if (out.peerRunId) process.stdout.write(`对端运行：${out.peerRunId}\n`);
      process.stdout.write(`证据运行：${out.runId}\n`);
      return out.status === "accepted"? 0: 1;
    } catch (err) {
      process.stderr.write(`错误：${err instanceof Error? err.message: String(err)}\n`);
      return 1;
    }
  }
  process.stderr.write(PEER_USAGE + "\n");
  return 2;
}
