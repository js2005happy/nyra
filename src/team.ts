// src/team.ts — GROK 批（新缺口 52 常驻参谋长 + GROK-2/3/4）：
// 常驻角色化团队的最小落地。
//
// 报告（workspace/research_notes/nyra-hermes-subagents-grokbot-team-20261121.md
// §3.3）要的四件东西，只借机制、不搬文字与叫法：
//   GROK-2 Charter 角色契约（Soul 里，见 soul.ts 的 SoulCharter）：负责
//     什么（Own）、信息来源（Sources）、输出格式（Output）、审批门
//     （Approval）、停下条件（Stop），与 Tenet 并列；建 agent 接单须有
//     完整 Charter（requireCharter），交付配 verifier 抽查
//     （verifyCharterCompliance）。
//   GROK-4 文件交接（inbox / outbox / changelog）：团队成员之间用约定
//     结构交接，不靠聊天记录复制粘贴；交接目录落在各 agent 自己的电脑
//     workspace 内（缺口 42 一 Bot 一台电脑），绝不为“方便”退回共享
//     一台电脑。
//   GROK-1 常驻参谋长 1+N 星型枢纽（新缺口 52）：一个常驻 primary agent
//     （Soul 身份“参谋长”）独占入口，只拆解、分派、汇总，不写业务代码；
//     下游专职 agent 各做执行，只回简报；下游之间不直接互发指令，只通过
//     参谋长或 beads 交接。
//   GROK-3 外发审批门进团队模式（接线活，不是新建）：团队模式下，任何
//     子代理 / 下游 Bot 的对外通信、采购、删除、发布，一律回主 agent /
//     人批，不由子代理自批；审批卡上写清“谁替谁申请、为什么”。
//
// 诚实边界（已写进 docs/team.md）：
//   - 参谋长是单点瓶颈与单点故障：拆错了全队白跑；只收摘要不收全文，
//     上下文本身会成为瓶颈；参谋长自己同样受月度硬顶约束（接单前先过
//     checkAutoAllowed，触顶不接单）。
//   - Charter 写得再好模型也可能不遵守：抽查是确定性启发式检查（只核
//     说法不验语义），内容对错仍由 verifier + 人批负责；不要拿“有合同”
//     当“守合同”。
//   - 文件交接不管内容对错；交接包只含小文本文件的原文（≤ 8 KiB、最多
//     5 个），大文件与二进制只记指纹、不复制内容。
//   - 团队审批门只拦“对外动作”（业务动作映射 + 对外工具表），不拦本地
//     读写与 shell；门本身不判断对错，只拦住等人看。
//   - 真实多 agent 场景只在假 provider 上验过；模型调用的取消已接通
//     （可靠性打磨第 1 项第一批：/stop、超时、预算触顶都发取消信号，
//     见 docs/cancellation.md）；Windows/macOS 真机未验证。
//
// 存储口径（与本仓其他账本一致）：团队账本 ~/.nyra/teams.json 原子写
// 0600、损坏先备份再抛错；交接包落在各 agent 电脑 workspace 的
// handover/ 下（inbox/outbox/changelog.md）；审计进 team-audit.jsonl。
// 事件只记元数据（id 与 12 位指纹），不记任务正文、不记绝对路径。
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve, relative, sep, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  loadSoul, soulExists, validateSoulAgentId, charterComplete, validateCharter,
  SOUL_AGENT_ID_RE, type SoulCharter,
} from "./soul.ts";
import { resolveBotComputer } from "./bot/binding.ts";
import { computerWorkspacePath, getComputer } from "./bot/computer.ts";
import { appendBead, beadHash } from "./beads.ts";
import { checkAutoAllowed } from "./governance.ts";
import { businessActionForTool, BUSINESS_ACTION_LABELS } from "./businessRedlines.ts";
import { checkHandoverContract, getHandoverContract, linkHandoverPackage } from "./handoverContract.ts";
import { resolveNyraHome } from "./memory.ts";
import { listWriteLeases, normalizeGateFile, releaseWriteLease, transferWriteLease } from "./writeGate.ts";

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamError";
  }
}

export const TEAMS_FILE = "teams.json";
export const TEAM_AUDIT_FILE = "team-audit.jsonl";
export const TEAM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,47}$/;
export const TEAM_ID_RE = /^team_[0-9a-f]{12}$/;
export const TEAM_MAX_MEMBERS = 8;
export const HANDOVER_ID_RE = /^ho_[0-9a-f]{12}$/;
/** 交接包内联原文的上限：单个文件 ≤ 8 KiB、每包最多 5 个文件（大了只记指纹）。 */
export const HANDOVER_INLINE_MAX_BYTES = 8 * 1024;
export const HANDOVER_INLINE_MAX_FILES = 5;

export type TeamStatus = "active" | "dissolved";

export interface Team {
  /** 稳定 id：`team_` + 12 位十六进制。 */
  id: string;
  /** 团队名（同一时间只一个同名 active 团队）。 */
  name: string;
  /** 参谋长（Soul 身份，独占入口，只拆解、分派、汇总，不写业务代码）。 */
  chief: string;
  /** 下游专职 agent（Soul 身份，各做执行）。 */
  members: string[];
  created_at: string;
  /** 建团队的人（终端操作记 "cli"，程序调用方可传调用方）。 */
  created_by: string;
  status: TeamStatus;
}

export interface TeamStore {
  version: 1;
  teams: Team[];
}

export function teamsPath(home: string): string {
  return join(resolveNyraHome(home), TEAMS_FILE);
}

export function newTeamId(): string {
  return `team_${randomBytes(6).toString("hex")}`;
}

export function newHandoverId(): string {
  return `ho_${randomBytes(6).toString("hex")}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseTeam(raw: unknown): Team {
  if (!isRecord(raw)) throw new TeamError("团队记录不是一个对象");
  if (typeof raw.id !== "string" || !TEAM_ID_RE.test(raw.id)) throw new TeamError("团队 id 格式不对");
  if (typeof raw.name !== "string" || !TEAM_NAME_RE.test(raw.name)) throw new TeamError("团队名只认字母数字开头、最长 48 字（字母、数字、空格、下划线、连字符）");
  if (typeof raw.chief !== "string" || !SOUL_AGENT_ID_RE.test(raw.chief)) throw new TeamError("参谋长的 agent 名格式不对");
  if (!Array.isArray(raw.members) || raw.members.some((m) => typeof m !== "string" || !SOUL_AGENT_ID_RE.test(m))) {
    throw new TeamError("团队成员名单格式不对");
  }
  if (raw.status !== "active" && raw.status !== "dissolved") throw new TeamError("团队状态只认 active / dissolved");
  return {
    id: raw.id,
    name: raw.name,
    chief: raw.chief,
    members: [...(raw.members as string[])],
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    created_by: typeof raw.created_by === "string" ? raw.created_by : "",
    status: raw.status,
  };
}

/** 读团队账本；不存在返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadTeamStore(home: string): TeamStore {
  const path = teamsPath(home);
  if (!existsSync(path)) return { version: 1, teams: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new TeamError(`团队账本损坏，已备份到 ${basename(backup)}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.teams)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new TeamError(`团队账本结构不对，已备份到 ${basename(backup)}`);
  }
  return { version: 1, teams: (parsed.teams as unknown[]).map(parseTeam) };
}

/** 原子写团队账本（同目录 tmp 0600 + rename；损坏先备份再抛错在 load 里）。 */
export function saveTeamStore(home: string, store: TeamStore): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = teamsPath(home);
  const data = JSON.stringify(store, null, 2) + "\n";
  const tmp = join(dir, `.teams.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err: unknown) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 团队审计行（只记元数据与 id，不记任务正文、不记绝对路径）。 */
export function appendTeamAudit(home: string, entry: Record<string, unknown>): void {
  mkdirSync(resolveNyraHome(home), { recursive: true, mode: 0o700 });
  appendFileSync(join(resolveNyraHome(home), TEAM_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

// ---- GROK-2：Charter 门——接单须有完整 Charter ----

/**
 * 接单门：该 agent 必须有 Soul 文件且 Charter 五项齐全有效，否则拒绝接单。
 * 参谋长与每个成员建团队、加成员、接分派时都要过这道门（delegateDetailed
 * 里分派时再验一次，纵深防御）。没有 Soul = 没身份，没 Charter = 没合同，
 * 都不接单——不静默放行。
 */
export function requireCharter(home: string, agent: string, what: string): SoulCharter {
  validateSoulAgentId(agent);
  if (!soulExists(home, agent)) {
    throw new TeamError(`${what}：${agent} 还没有 Soul（先跑 nyra soul init ${agent}，再写 Charter）`);
  }
  const soul = loadSoul(home, agent);
  if (!soul.charter || !charterComplete(soul)) {
    throw new TeamError(`${what}：${agent} 的角色契约（Charter）不完整（先跑 nyra soul charter set ${agent} 写一份五项齐全的契约）`);
  }
  return soul.charter;
}

// ---- GROK-1：团队账本 ----

export interface CreateTeamInput {
  name: string;
  chief: string;
  members: string[];
  by?: string;
}

/** 建团队：参谋长与每个成员都要有 Soul + 完整 Charter；成员 1–8 个；参谋长不能同时是成员；同名 active 团队不能重复。 */
export function createTeam(home: string, input: CreateTeamInput): Team {
  const name = input.name.trim();
  if (!TEAM_NAME_RE.test(name)) throw new TeamError("团队名只认字母数字开头、最长 48 字（字母、数字、空格、下划线、连字符）");
  validateSoulAgentId(input.chief);
  const members = [...new Set(input.members.map((m) => m.trim()))].filter(Boolean);
  if (!members.length) throw new TeamError("团队至少要有一个下游成员（参谋长只拆解、分派、汇总，不写业务代码）");
  if (members.length > TEAM_MAX_MEMBERS) throw new TeamError(`团队成员最多 ${TEAM_MAX_MEMBERS} 个（参谋长只收摘要，成员再多上下文就装不下了）`);
  if (members.includes(input.chief)) throw new TeamError("参谋长不能同时是自己的下游成员");
  for (const m of members) validateSoulAgentId(m);
  // 接单门：参谋长与每个成员都要有完整 Charter。
  requireCharter(home, input.chief, "建团队");
  for (const m of members) requireCharter(home, m, "建团队");
  const store = loadTeamStore(home);
  if (store.teams.some((t) => t.status === "active" && t.name === name)) {
    throw new TeamError(`已有同名 active 团队 ${name}（先解散它，或换个名字）`);
  }
  const team: Team = {
    id: newTeamId(),
    name,
    chief: input.chief,
    members,
    created_at: new Date().toISOString(),
    created_by: input.by ?? "cli",
    status: "active",
  };
  store.teams.push(team);
  saveTeamStore(home, store);
  appendTeamAudit(home, { kind: "created", team_id: team.id, name, chief: team.chief, members: team.members });
  return team;
}

/** 列出团队（默认只列 active；all=true 时把已解散的也列出来）。 */
export function listTeams(home: string, all = false): Team[] {
  const store = loadTeamStore(home);
  return store.teams.filter((t) => all || t.status === "active");
}

/** 按 id 或名字找团队；找不到返回 null（调用方决定报错文案）。 */
export function getTeam(home: string, idOrName: string): Team | null {
  const store = loadTeamStore(home);
  return store.teams.find((t) => t.id === idOrName || t.name === idOrName) ?? null;
}

/** 加成员：须是 active 团队、新成员须有完整 Charter、不能重复、不能加参谋长、总数不超 8 个。 */
export function addTeamMember(home: string, idOrName: string, agent: string): Team {
  validateSoulAgentId(agent);
  const store = loadTeamStore(home);
  const team = store.teams.find((t) => t.id === idOrName || t.name === idOrName);
  if (!team) throw new TeamError(`找不到团队 ${idOrName}`);
  if (team.status !== "active") throw new TeamError(`团队 ${team.name} 已解散，不能加成员`);
  if (agent === team.chief) throw new TeamError("参谋长不能同时是自己的下游成员");
  if (team.members.includes(agent)) throw new TeamError(`${agent} 已经是团队 ${team.name} 的成员`);
  if (team.members.length >= TEAM_MAX_MEMBERS) throw new TeamError(`团队成员最多 ${TEAM_MAX_MEMBERS} 个`);
  requireCharter(home, agent, "加成员");
  team.members.push(agent);
  saveTeamStore(home, store);
  appendTeamAudit(home, { kind: "member_added", team_id: team.id, agent });
  return team;
}

/** 移除成员：须是 active 团队；成员不能减到 0（参谋长一个人成不了团队）。 */
export function removeTeamMember(home: string, idOrName: string, agent: string): Team {
  const store = loadTeamStore(home);
  const team = store.teams.find((t) => t.id === idOrName || t.name === idOrName);
  if (!team) throw new TeamError(`找不到团队 ${idOrName}`);
  if (team.status !== "active") throw new TeamError(`团队 ${team.name} 已解散`);
  const idx = team.members.indexOf(agent);
  if (idx < 0) throw new TeamError(`${agent} 不是团队 ${team.name} 的成员`);
  if (team.members.length <= 1) throw new TeamError("团队至少要留一个成员（参谋长一个人成不了团队，想散伙用 nyra team dissolve）");
  team.members.splice(idx, 1);
  saveTeamStore(home, store);
  appendTeamAudit(home, { kind: "member_removed", team_id: team.id, agent });
  return team;
}

/** 解散团队（终态，不可恢复；已解散的再解散直接返回，不重复记账）。 */
export function dissolveTeam(home: string, idOrName: string): Team {
  const store = loadTeamStore(home);
  const team = store.teams.find((t) => t.id === idOrName || t.name === idOrName);
  if (!team) throw new TeamError(`找不到团队 ${idOrName}`);
  if (team.status === "dissolved") return team;
  team.status = "dissolved";
  saveTeamStore(home, store);
  appendTeamAudit(home, { kind: "dissolved", team_id: team.id, name: team.name });
  return team;
}

// ---- GROK-2：Charter 交付抽查（verifier 抽查，确定性启发式检查） ----

export interface CharterCheck {
  id: string;
  label: string;
  passed: boolean;
  /** 检查没跑（比如 Charter 没声明标记）时为 true，不算通过也不算失败。 */
  skipped: boolean;
}

export interface CharterCompliance {
  agent: string;
  passed: boolean;
  checks: CharterCheck[];
}

/**
 * 交付时对着成员的 Charter 抽查（确定性检查，只核说法不验语义）：
 *   charter_present —— 成员有 Charter；
 *   charter_complete —— Charter 五项齐全有效；
 *   deliverable_nonempty —— 交付物非空；
 *   output_marker —— 只有 Charter 的 output 里用反引号声明了标记
 *     （如“以 `## 结论` 开头”）时才查：交付物里须出现该标记；没声明
 *     就跳过（skipped，不算通过也不算失败）。
 * 合同写得再好模型也可能不遵守：抽查过了不等于守合同了，内容对错仍由
 * verifier + 人批负责；不要拿“抽查过了”当“交付物对了”。
 */
export function verifyCharterCompliance(home: string, agent: string, deliverable: string): CharterCompliance {
  const checks: CharterCheck[] = [];
  let charter: SoulCharter | null = null;
  try {
    if (soulExists(home, agent)) {
      const soul = loadSoul(home, agent);
      charter = soul.charter ?? null;
    }
  } catch {
    charter = null;
  }
  checks.push({ id: "charter_present", label: "成员有角色契约（Charter）", passed: charter !== null, skipped: false });
  checks.push({ id: "charter_complete", label: "Charter 五项齐全有效", passed: charter !== null && validateCharter(charter) === null, skipped: false });
  const text = typeof deliverable === "string" ? deliverable : "";
  checks.push({ id: "deliverable_nonempty", label: "交付物非空", passed: text.trim().length > 0, skipped: false });
  // output 里反引号声明的标记（如 `## 结论`）：有声明就查，没声明就跳过。
  const markers = charter ? [...charter.output.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean) : [];
  if (!markers.length) {
    checks.push({ id: "output_marker", label: "输出格式标记（Charter 没声明标记，跳过）", passed: false, skipped: true });
  } else {
    const missing = markers.filter((m) => !text.includes(m));
    checks.push({
      id: "output_marker",
      label: missing.length ? `输出格式标记缺失：${missing.join("、")}` : "输出格式标记齐全",
      passed: missing.length === 0,
      skipped: false,
    });
  }
  const failed = checks.filter((c) => !c.skipped && !c.passed);
  return { agent, passed: failed.length === 0, checks };
}

/** 交付物结论行（贴在 delegate 交回文本末尾，与 H-4 的 schema_valid 行同款口径）。 */
export function formatCharterCheckLine(result: CharterCompliance): string {
  const failed = result.checks.filter((c) => !c.skipped && !c.passed).map((c) => c.id);
  const skipped = result.checks.filter((c) => c.skipped).map((c) => c.id);
  return `charter_valid: ${result.passed}${failed.length ? `（未通过：${failed.join("、")}）` : ""}${skipped.length ? `（跳过：${skipped.join("、")}）` : ""}`;
}

// ---- GROK-4：文件交接（inbox / outbox / changelog，落在各 agent 自己的电脑 workspace 内） ----

export type HandoverBox = "inbox" | "outbox";
export type HandoverStatus = "sent" | "accepted";

export interface HandoverFile {
  /** 相对交出方 workspace 的路径（如 "reports/weekly.md"）。 */
  path: string;
  /** 文件 SHA-256（前 12 位进事件，完整值进包里）。 */
  sha256: string;
  size: number;
  /** 小文本文件才内联原文（≤ 8 KiB）；大了或二进制时为 null，只记指纹。 */
  content: string | null;
}

export interface HandoverPackage {
  id: string;
  at: string;
  from: string;
  to: string;
  /** 交接的任务（一句话）。 */
  task: string;
  note: string;
  files: HandoverFile[];
  status: HandoverStatus;
  /** 交出方电脑 id（审计用）。 */
  from_computer: string;
  /** 接收方电脑 id（审计用）。 */
  to_computer: string;
  /** 挂的交接契约 id（Pi Bot 借鉴第 2 条；没挂时为 null，老包没有该字段也当 null）。 */
  contract_id?: string | null;
}

function handoverRoot(home: string, computerId: string): string {
  // 交接目录落在该 agent 自己的电脑 workspace 内（缺口 42 一 Bot 一台电脑）；
  // resolveBotComputer 找不到电脑时（没 Soul）调用方先报错，不静默回退到共享目录。
  const workspace = computerWorkspacePath(home, getComputer(home, computerId));
  return join(workspace, "handover");
}

/** 该 agent 电脑 workspace 里的交接目录（不存在时建出来）。 */
export function handoverBoxDir(home: string, computerId: string, box: HandoverBox): string {
  const dir = join(handoverRoot(home, computerId), box);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function handoverChangelogPath(home: string, computerId: string): string {
  const dir = handoverRoot(home, computerId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "changelog.md");
}

function appendChangelog(home: string, computerId: string, line: string): void {
  appendFileSync(handoverChangelogPath(home, computerId), `- ${new Date().toISOString()} ${line}\n`, "utf-8");
}

/**
 * 交接文件路径归一化：只认交出方 workspace 内的相对路径；绝对路径、..
 * 逃逸、符号链接一律拒绝（交接包不能成为读 workspace 外文件的旁路）。
 */
export function resolveHandoverFile(workspace: string, rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new TeamError("交接文件路径不能为空");
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) throw new TeamError(`交接文件只认 workspace 内的相对路径：${rel}`);
  const target = resolve(workspace, rel);
  const prefix = resolve(workspace) + sep;
  if (target !== resolve(workspace) && !target.startsWith(prefix)) {
    throw new TeamError(`交接文件越界（.. 不许逃出 workspace）：${rel}`);
  }
  let st;
  try {
    st = lstatSync(target);
  } catch {
    throw new TeamError(`交接文件不存在：${rel}`);
  }
  if (st.isSymbolicLink()) throw new TeamError(`交接文件是符号链接，不跟（防 workspace 外偷渡）：${rel}`);
  if (!st.isFile()) throw new TeamError(`交接文件不是普通文件：${rel}`);
  return target;
}

function isProbablyText(buf: Buffer): boolean {
  // 含 NUL 字节就当二进制；否则按 utf-8 读（读失败同样当二进制）。
  if (buf.includes(0)) return false;
  try {
    buf.toString("utf-8");
    return true;
  } catch {
    return false;
  }
}

export interface SendHandoverInput {
  from: string;
  to: string;
  task: string;
  note?: string;
  /** 交出方 workspace 内的相对路径列表（可空：只交代一句话也行）。 */
  files?: string[];
  /** 挂一份待验收的交接契约（Pi Bot 借鉴第 2 条；from/to 须与契约一致）。 */
  contractId?: string;
  runId?: string | null;
}

/**
 * 发起一次交接：交出方 workspace 里的文件打包（小文本内联原文，大文件/
 * 二进制只记指纹）→ 接收方电脑 workspace 的 handover/inbox/<id>.json；
 * 交出方 workspace 的 handover/outbox/<id>.json 留一份底；双方
 * handover/changelog.md 各记一行；beads 账本记一条 handoff。
 * 双方都要有 Soul（没 Soul 就没电脑，交接没地方落——先建 Soul，不静默
 * 回退到共享目录）。只记元数据进事件，任务正文只落在交接包与 changelog
 * 里（那是 agent 自己的 workspace，不是证据链）。
 */
export function sendHandover(home: string, input: SendHandoverInput): HandoverPackage {
  const task = input.task.trim();
  if (!task) throw new TeamError("交接须写一句话任务（inbox 里待办的标题）");
  if (task.length > 200) throw new TeamError("交接任务一句话最长 200 字");
  const fromBinding = resolveBotComputer(home, input.from);
  if (!fromBinding) throw new TeamError(`交接发不出去：${input.from} 还没有 Soul / 电脑（先跑 nyra soul init ${input.from}）`);
  const toBinding = resolveBotComputer(home, input.to);
  if (!toBinding) throw new TeamError(`交接发不出去：${input.to} 还没有 Soul / 电脑（先跑 nyra soul init ${input.to}）`);
  if (input.from === input.to) throw new TeamError("不能给自己交接（from 与 to 是同一个 agent）");
  // 挂交接契约（Pi Bot 借鉴第 2 条）：契约须存在、待验收、from/to 与本次
  // 交接一致（契约是“谁交给谁”的验收标准）；包建好后才 link（须包 id）。
  let contractId: string | null = null;
  if (input.contractId) {
    const contract = getHandoverContract(home, input.contractId);
    if (!contract) throw new TeamError(`找不到交接契约 ${input.contractId}（先 nyra handover contract create 立一份）`);
    if (contract.status !== "pending") throw new TeamError(`交接契约 ${input.contractId} 不是待验收，不能再挂包`);
    if (contract.from !== input.from || contract.to !== input.to) {
      throw new TeamError(`交接契约 ${input.contractId} 是 ${contract.from} → ${contract.to}，与本次 ${input.from} → ${input.to} 不一致`);
    }
    contractId = input.contractId;
  }

  const fromWorkspace = fromBinding.workdir;
  const files: HandoverFile[] = [];
  const rels = [...new Set((input.files ?? []).map((f) => f.trim()))].filter(Boolean);
  if (rels.length > HANDOVER_INLINE_MAX_FILES * 2) throw new TeamError(`一次交接最多 ${HANDOVER_INLINE_MAX_FILES * 2} 个文件`);
  let inlined = 0;
  for (const rel of rels) {
    const target = resolveHandoverFile(fromWorkspace, rel);
    const buf = readFileSync(target);
    const text = isProbablyText(buf);
    const inline = text && buf.length <= HANDOVER_INLINE_MAX_BYTES && inlined < HANDOVER_INLINE_MAX_FILES;
    if (inline) inlined++;
    files.push({
      path: rel.split(sep).join("/"),
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length,
      content: inline ? buf.toString("utf-8") : null,
    });
  }

  const pkg: HandoverPackage = {
    id: newHandoverId(),
    at: new Date().toISOString(),
    from: input.from,
    to: input.to,
    task,
    note: (input.note ?? "").trim().slice(0, 1000),
    files,
    status: "sent",
    from_computer: fromBinding.computer.id,
    to_computer: toBinding.computer.id,
    contract_id: contractId,
  };
  const data = JSON.stringify(pkg, null, 2) + "\n";
  const inboxPath = join(handoverBoxDir(home, toBinding.computer.id, "inbox"), `${pkg.id}.json`);
  writeFileSync(inboxPath, data, { mode: 0o600 });
  const outboxPath = join(handoverBoxDir(home, fromBinding.computer.id, "outbox"), `${pkg.id}.json`);
  writeFileSync(outboxPath, data, { mode: 0o600 });
  if (contractId) linkHandoverPackage(home, contractId, pkg.id);
  appendChangelog(home, fromBinding.computer.id, `${pkg.from} → ${pkg.to}：${pkg.task}（${pkg.id}，已发出，${files.length} 个文件）`);
  appendChangelog(home, toBinding.computer.id, `${pkg.from} → ${pkg.to}：${pkg.task}（${pkg.id}，已到 inbox）`);
  try {
    appendBead(home, {
      kind: "handoff",
      to: input.to,
      run_id: input.runId ?? null,
      peer_run_id: null,
      content_hash: beadHash(`${pkg.id}:${task}`),
      status: "sent",
    });
  } catch { /* beads 账本写失败不破坏交接本身（包已落盘） */ }
  appendTeamAudit(home, { kind: "handover_sent", handover_id: pkg.id, from: pkg.from, to: pkg.to, files: files.length });
  return pkg;
}

/** 列出某 agent 的收件/发件箱（按时间倒序；损坏的包跳过，不破坏整箱）。 */
export function listHandovers(home: string, agent: string, box: HandoverBox): HandoverPackage[] {
  const binding = resolveBotComputer(home, agent);
  if (!binding) throw new TeamError(`${agent} 还没有 Soul / 电脑（先跑 nyra soul init ${agent}）`);
  const dir = handoverBoxDir(home, binding.computer.id, box);
  const out: HandoverPackage[] = [];
  for (const f of readdirSync(dir)) {
    if (!HANDOVER_ID_RE.test(f.replace(/\.json$/, "")) || !f.endsWith(".json")) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, f), "utf-8")) as HandoverPackage;
      if (pkg && typeof pkg === "object" && typeof pkg.id === "string") out.push(pkg);
    } catch { /* 损坏的包跳过 */ }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** 读一个交接包（inbox 或 outbox 里找）。 */
export function readHandover(home: string, agent: string, id: string): { pkg: HandoverPackage; box: HandoverBox } {
  if (!HANDOVER_ID_RE.test(id)) throw new TeamError(`交接包 id 格式不对：${id}`);
  const binding = resolveBotComputer(home, agent);
  if (!binding) throw new TeamError(`${agent} 还没有 Soul / 电脑`);
  for (const box of ["inbox", "outbox"] as const) {
    const path = join(handoverBoxDir(home, binding.computer.id, box), `${id}.json`);
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf-8")) as HandoverPackage;
      if (pkg && typeof pkg === "object" && pkg.id === id) return { pkg, box };
    } catch { /* 损坏的包当没找到处理（调用方按找不到报错） */ }
  }
  throw new TeamError(`找不到交接包 ${id}（先用 nyra team handover list 看 id）`);
}

/**
 * 接收方确认接下：inbox 包与 outbox 底的状态都改成 accepted，双方
 * changelog 各记一行。确认只是“接了”，内容对错仍由 verifier + 人批负责。
 */
export function ackHandover(home: string, agent: string, id: string, opts?: { workdir?: string }): HandoverPackage {
  const { pkg } = readHandover(home, agent, id);
  if (pkg.to !== agent) throw new TeamError(`交接包 ${id} 不是发给 ${agent} 的（接收方是 ${pkg.to}），不能由你确认`);
  if (pkg.status === "accepted") return pkg;
  // 挂了交接契约的包：先程序验收，过了才接下；打回/停下时包保持 sent
  // 状态、对方改完再 ack（就是再交一次），轮次用完须人定夺（resolve）。
  // 验收地默认交出方电脑的 workdir（--workdir 可指定别处）；验收的输出
  // 文本用包里已内联的文件内容拼（大文件只记了 SHA-256，没内联进包），
  // 所以挂到交接包上的契约只用文件类与内置 checker，output-contains /
  // trajectory-contains 类 checker 请走 `nyra handover contract check`
  // 单独验（带 --output-file / --trajectory）。
  const contractId = pkg.contract_id ?? null;
  if (contractId) {
    const fromBinding = resolveBotComputer(home, pkg.from);
    const workdir = opts?.workdir ?? fromBinding?.workdir ?? null;
    if (!workdir) throw new TeamError(`交接包 ${id} 挂了交接契约 ${contractId}，但找不到 ${pkg.from} 的工作目录（用 --workdir 指定核对地）`);
    const outputText = pkg.files.map((f) => f.content ?? "").filter(Boolean).join("\n");
    const result = checkHandoverContract(home, contractId, { workdir, outputText });
    if (result.verdict !== "accepted") {
      const outcome = result.verdict === "sent-back" ? "没过已打回" : "没过已停下等人";
      if (fromBinding) appendChangelog(home, fromBinding.computer.id, `${pkg.from} → ${pkg.to}：${pkg.task}（${id}，程序验收${outcome}）`);
      const toBinding = resolveBotComputer(home, pkg.to);
      if (toBinding) appendChangelog(home, toBinding.computer.id, `${pkg.from} → ${pkg.to}：${pkg.task}（${id}，程序验收${outcome}）`);
      appendTeamAudit(home, { kind: result.verdict === "sent-back" ? "handover_contract_sent_back" : "handover_contract_stopped", handover_id: id, contract_id: contractId, from: pkg.from, to: pkg.to });
      throw new TeamError(result.text);
    }
  }
  const accepted: HandoverPackage = { ...pkg, status: "accepted" };
  const data = JSON.stringify(accepted, null, 2) + "\n";
  const toBinding = resolveBotComputer(home, pkg.to);
  const fromBinding = resolveBotComputer(home, pkg.from);
  if (toBinding) writeFileSync(join(handoverBoxDir(home, toBinding.computer.id, "inbox"), `${id}.json`), data, { mode: 0o600 });
  if (fromBinding) writeFileSync(join(handoverBoxDir(home, fromBinding.computer.id, "outbox"), `${id}.json`), data, { mode: 0o600 });
  if (toBinding) appendChangelog(home, toBinding.computer.id, `${pkg.from} → ${pkg.to}：${pkg.task}（${id}，已接下）`);
  if (fromBinding) appendChangelog(home, fromBinding.computer.id, `${pkg.from} → ${pkg.to}：${pkg.task}（${id}，对方已接下）`);
  appendTeamAudit(home, { kind: "handover_accepted", handover_id: id, from: pkg.from, to: pkg.to });
  return accepted;
}

// ---- GROK-3：团队审批门（接线活，不是新建） ----

/**
* 团队模式下须回主 agent / 人批的对外工具（GROK-3：对外通信、采购、
* 删除、发布）。业务动作映射到的工具（目前是 gmail_send → send_message）
* 天然在内；再加一组按工具名直接认的对外动作：对外发消息、对外发布、
* 浏览器对外操作、对外 HTTP 调用。本地读写与 shell 不在内——门只拦
* “对外”，不管本地活；门本身不判断对错，只拦住等人看。
*/
export const TEAM_GATED_TOOLS: ReadonlySet<string> = new Set([
"gmail_send",
"slack_send",
"http_post",
"browser_navigate",
"browser_click",
"browser_screenshot",
"computer_screenshot",
"computer_click",
"computer_type",
"computer_key",
]);

export interface TeamGate {
team: Team;
/** 替谁申请（下游 agent）。 */
agent: string;
/** 参谋长（审批回他 / 人那里）。 */
chief: string;
tool: string;
/** 业务动作中文名（映射到的才有；工具名直认的为空）。 */
actionLabel: string | null;
}

/**
* 团队审批门判定（纯函数，checkApproval 与 Bot 审批桥共用）：
* - 没进团队模式（teamId 为空）→ null（正常流程）；
* - 找不到团队 / 团队已解散 → null（fail-open 到正常流程：团队都没了，
* 门无从谈起；审批本身仍按正常流程走，不静默放行到无审批）；
* - 行为人是参谋长本人 → null（参谋长是入口，审批门只有一道，门后
* 是他与人；他自己的对外动作仍走正常审批链）；
* - 工具不是对外动作 → null（本地活不拦）；
* - 其余（下游成员调对外工具）→ 返回门（含参谋长与动作名）。
* 注意：never 档红线在 checkApproval 里比这道门更前——红线拦住的，
* 到不了这里。
*/
export function teamApprovalRequired(
home: string | null,
teamId: string | null | undefined,
actorAgent: string,
tool: string,
): TeamGate | null {
if (!teamId || home === null) return null;
let team: Team | null;
try {
team = getTeam(home, teamId);
} catch {
return null;
}
if (!team || team.status!== "active") return null;
if (actorAgent === team.chief) return null;
if (!team.members.includes(actorAgent)) return null;
const mapped = businessActionForTool(tool);
const gated = mapped!== null || TEAM_GATED_TOOLS.has(tool);
if (!gated) return null;
return {
team,
agent: actorAgent,
chief: team.chief,
tool,
actionLabel: mapped? BUSINESS_ACTION_LABELS[mapped.action]: null,
};
}

/** 审批卡上的团队前缀（写清“谁替谁申请、为什么”）。 */
export function teamApprovalSummary(gate: TeamGate, summary: string): string {
const action = gate.actionLabel? `（${gate.actionLabel}）`: "（对外动作）";
return `${gate.agent} 替团队 ${gate.team.name} 申请 ${gate.tool}${action}：${summary} —— 团队模式下对外动作一律回参谋长 ${gate.chief} / 人批，不由子代理自批。`;
}

// ---- GROK-1：参谋长分派（计划 + 任务文本；执行走 Agent 的 delegate） ----

export interface TeamDispatchPlan {
team: Team;
chief: string;
members: string[];
task: string;
/** 接单前月度硬顶检查（checkAutoAllowed）：触顶不接单。 */
cap: { allowed: boolean; reason: string};
/** 第 2 批 G-P1-3：本次分派的纪元（dispatch 处理里拿租约后填；没填时
 * chief Agent 不校验纪元——老调用方与 dry-run 不受影响）。 */
epoch?: number;
}

/**
* 分派前计划（确定性部分，不调模型、不花 token）：团队须 active、参谋长
* 与每个成员的 Charter 须完整、月度硬顶（组织级 + 分层）须没触顶。
* 计划过了才建 chief run；不过直接拒绝，连 chief 都不起。
*/
export function planTeamDispatch(home: string, idOrName: string, task: string): TeamDispatchPlan {
const trimmed = task.trim();
if (!trimmed) throw new TeamError("分派须给一句话任务");
if (trimmed.length > 4000) throw new TeamError("分派任务最长 4000 字");
const team = getTeam(home, idOrName);
if (!team) throw new TeamError(`找不到团队 ${idOrName}`);
if (team.status!== "active") throw new TeamError(`团队 ${team.name} 已解散，不能分派`);
requireCharter(home, team.chief, "分派");
for (const m of team.members) requireCharter(home, m, "分派");
const cap = checkAutoAllowed(home, team.chief);
if (!cap.allowed) throw new TeamError(`分派被月度硬顶拦住：${cap.reason}`);
return { team, chief: team.chief, members: [...team.members], task: trimmed, cap};
}

/**
* 参谋长的任务文本（CLI dispatch 时作为 chief run 的任务）：
* 只拆解、分派、汇总，不写业务代码；每个子任务用 delegate 工具交给指定
* 成员（agent 参数只认团队成员）；只收各成员的简报（不收全文——参谋长
* 上下文是瓶颈）；最后合成为一份汇总（各成员结论 + 谁负责的部分 + 未完
* 成的缺口）；成员交付须对着各自 Charter 的输出格式抽查（charter_valid
* 行会贴在交回文本末尾）。
*/
/**
 * 第 1 批 G-P0-5：零工具编排者——参谋长/lead 角色从工具层面只剩这
 * 两个工具。agent.ts 构造 chief Agent 时按这份名单过滤（其余全部
 * 禁用，MCP 与 Poppy 只读工具也不发）；提示词里写“不写代码”只是
 * 第二道防线，不靠它。
 */
export const ORCHESTRATOR_TOOLS: string[] = ["delegate", "delegate_parallel"];

export function buildChiefTask(plan: TeamDispatchPlan): string {
const memberLines = plan.members.map((m) => `- ${m}（Soul 身份，Charter 见其 Soul 文件）`).join("\n");
return [
`你是团队 ${plan.team.name} 的参谋长（${plan.chief}），独占入口：只拆解、分派、汇总，不写业务代码。`,
`团队成员（只把子任务交给下面这些人，agent 参数只认这些名字，别的 agent 不许派）：`,
memberLines,
`任务：${plan.task}`,
...(plan.epoch !== undefined ? [`分派纪元：${plan.epoch}——你这次分派的纪元号；lead 换人后旧纪元的分派会被直接拒绝（不用再问为什么）。`] : []),
`做法：`,
`1. 把任务拆成互不依赖的子任务，每件交给最合适的成员（delegate 工具，agent 填成员名，output_schema 能给就给）；`,
`2. 要让成员写某个文件，分派时把文件列进 delegate 的 write_files（写者名额就从你这里移交给成员，子任务结束时自动还回来）；不给 write_files，成员第一次写该文件会被单写者门拦下；`,
`3. 下游之间不直接互发指令——成员之间要交接只通过你或 beads 交接，成员自己调 delegate 默认会被拒绝（flat）；只有被授予 orchestrator 角色的成员才能再往下分派（H-7 嵌套编排 opt-in，分派时传 orchestrator: true 显式开启）；`,
`4. 只收各成员的简报，不要全文（你的上下文是瓶颈）；`,
`5. 最后合成为一份汇总：各成员的结论、谁负责了哪部分、没完成/没把握的缺口写清楚，不要编造没发生的结论；`,
`6. 成员的对外动作（发消息、采购、删除、发布）会自动回你/人批，不要替成员绕过审批；`,
`7. 拆错了全队白跑：拆之前先想一步——这件任务是不是真的能拆？不能拆就直接说，不要硬拆。`,
].join("\n");
}

/**
 * 真跑分派之前的共用一步（CLI `nyra team dispatch` 与网关 `POST /api/teams/:id/dispatch` 共用）：
 * 过三道门（planTeamDispatch）→ 参谋长拿 lead 租约（拿不到直接拒绝，不抢）→ 纪元写进计划 →
 * 生成参谋长任务文本 → 记一条 dispatched 审计。返回计划与任务文本，调用方负责起 chief Agent。
 */
export async function prepareTeamDispatch(home: string, idOrName: string, task: string): Promise<{ plan: TeamDispatchPlan; chiefTask: string }> {
const plan = planTeamDispatch(home, idOrName, task);
// 动态 import（teamLease → team，静态 import 会循环）。
const { acquireTeamLease } = await import("./teamLease.ts");
const leaseRes = acquireTeamLease(home, plan.team.id, plan.chief);
if (!leaseRes.granted) throw new TeamError(`分派被拒：${leaseRes.reason}`);
plan.epoch = leaseRes.lease.epoch;
const chiefTask = buildChiefTask(plan);
appendTeamAudit(home, { kind: "dispatched", team_id: plan.team.id, chief: plan.chief, members: plan.members.length});
return { plan, chiefTask };
}

/** 对外（网关 / 手机）展示的团队：不含审计与内部字段。 */
export function publicTeam(team: Team): { id: string; name: string; chief: string; members: string[]; status: TeamStatus; created_at: string } {
return { id: team.id, name: team.name, chief: team.chief, members: [...team.members], status: team.status, created_at: team.created_at };
}

// ---- CLI：`nyra team <create|list|show|add|remove|dispatch|dissolve|handover>` ----

export interface TeamCliInput {
onEvent?: (type: string, data: Record<string, unknown>) => void;
}

const TEAM_USAGE = "用法：\n"
+ " nyra team create <团队名> --chief <参谋长> --members <成员1,成员2,...> 建团队（参谋长与每个成员都要有 Soul + 完整 Charter）\n"
+ " nyra team list [--all] 列出团队（默认只列 active）\n"
+ " nyra team show <团队名或 id> 看一个团队（参谋长、成员、状态）\n"
+ " nyra team add <团队名或 id> <成员> 加成员（须有完整 Charter）\n"
+ " nyra team remove <团队名或 id> <成员> 移除成员（至少留一个）\n"
+ " nyra team dissolve <团队名或 id> [--yes] 解散团队（终态）\n"
+ " nyra team dispatch <团队名或 id> \"<任务>\" [--dry-run] 参谋长分派：拆解、分派、汇总（--dry-run 只出计划，不跑模型）\n"
+ " nyra team writer status <团队名或 id> 看谁拿着写者名额（单写者门）\n"
+ " nyra team writer transfer <团队名或 id> <文件> <成员> 参谋长把某文件的写者名额移交给成员\n"
+ " nyra team writer release <团队名或 id> <文件> [--by <agent>] 把某文件的写者名额还回去（默认参谋长收回；--by 填持有者本人）\n"
+ " nyra team lead status <团队名或 id> 看谁是当前 lead、纪元几、租约到什么时候过期\n"
+ " nyra team lead acquire <团队名或 id> [--as <agent>] 拿 lead 租约（10 分钟；已有 lead 在任时拒绝，不抢）\n"
+ " nyra team lead release <团队名或 id> [--as <agent>] 还 lead 租约（默认参谋长还；--as 填持有者本人）\n"
+ " nyra team lead transfer <团队名或 id> <新 lead> 把 lead 交给别人（纪元 +1，旧 lead 的分派立刻失效）\n"
+ " nyra team handover send --from <agent> --to <agent> --task \"一句话\" [--note \"备注\"] [--file <相对路径>...] [--contract <契约 id>] 文件交接（落对方电脑 workspace 的 inbox；挂契约时对方 ack 先程序验收）\n"
+ " nyra team handover list <agent> [--box inbox|outbox] 列出某 agent 的收件/发件箱\n"
+ " nyra team handover show <agent> <id> 看一个交接包\n"
+ " nyra team handover ack <agent> <id> [--workdir <目录>] 接收方确认接下（挂了契约的包先程序验收，过了才接下）\n"
+ "团队形态：参谋长独占入口，只拆解、分派、汇总，不写业务代码；下游各做执行，只回简报；\n"
+ "下游之间不直接互发指令；对外动作一律回参谋长/人批；交接走 inbox/outbox/changelog，不靠聊天记录复制粘贴。\n"
+ "详见 docs/team.md";

function flagValue(argv: string[], name: string): string | undefined {
const idx = argv.indexOf(name);
return idx >= 0 && argv[idx + 1]!== undefined? argv[idx + 1]: undefined;
}

function flagValues(argv: string[], name: string): string[] {
const out: string[] = [];
for (let i = 0; i < argv.length; i++) {
if (argv[i] === name && argv[i + 1]!== undefined) out.push(argv[i + 1]);
}
return out;
}

function formatTeam(team: Team): string {
return [
`团队：${team.name}（${team.id}，${team.status === "active"? "active": "已解散"}）`,
` 参谋长：${team.chief}（独占入口，只拆解、分派、汇总）`,
` 成员（${team.members.length} 个）：${team.members.join("、")}`,
` 创建：${team.created_at || "未记录"}（${team.created_by || "未记录"}）`,
].join("\n");
}

function emitTeamEvent(input: TeamCliInput | undefined, type: string, data: Record<string, unknown>): void {
try {
input?.onEvent?.(type, data);
} catch { /* 观察器故障不破坏团队操作本身 */}
}

async function handleHandover(argv: string[], home: string, input?: TeamCliInput): Promise<number> {
const cmd = argv[0];
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
process.stdout.write(
"用法：\n"
+ " nyra team handover send --from <agent> --to <agent> --task \"一句话\" [--note \"备注\"] [--file <相对路径>...] [--contract <契约 id>]\n"
+ " nyra team handover list <agent> [--box inbox|outbox]\n"
+ " nyra team handover show <agent> <id>\n"
+ " nyra team handover ack <agent> <id> [--workdir <目录>]\n",
);
return 0;
}
if (cmd === "send") {
const from = flagValue(argv, "--from");
const to = flagValue(argv, "--to");
const task = flagValue(argv, "--task");
const note = flagValue(argv, "--note")?? "";
const files = flagValues(argv, "--file");
const contractId = flagValue(argv, "--contract");
if (!from ||!to ||!task) {
process.stderr.write("用法：nyra team handover send --from <agent> --to <agent> --task \"一句话\" [--note \"备注\"] [--file <相对路径>...] [--contract <契约 id>]\n");
return 2;
}
const pkg = sendHandover(home, { from, to, task, note, files, contractId: contractId ?? undefined });
emitTeamEvent(input, "team_handover_sent", { handover_id: pkg.id, from: pkg.from, to: pkg.to});
emitTeamEvent(input, "team_handover_received", { handover_id: pkg.id, from: pkg.from, to: pkg.to});
process.stdout.write(`已交接给 ${to}：${task}（${pkg.id}，${pkg.files.length} 个文件，${pkg.files.filter((f) => f.content!== null).length} 个内联原文${pkg.contract_id ? `，挂交接契约 ${pkg.contract_id}（对方 ack 时先程序验收）` : ""}）\n`);
process.stdout.write(` 落在 ${to} 的电脑 workspace：handover/inbox/${pkg.id}.json；你这边 outbox 留了底。\n`);
return 0;
}
if (cmd === "list") {
const agent = argv[1];
if (!agent) { process.stderr.write("用法：nyra team handover list <agent> [--box inbox|outbox]\n"); return 2;}
const box = (flagValue(argv, "--box")?? "inbox") as HandoverBox;
if (box!== "inbox" && box!== "outbox") { process.stderr.write("--box 只认 inbox / outbox\n"); return 2;}
const pkgs = listHandovers(home, agent, box);
if (!pkgs.length) {
process.stdout.write(`${agent} 的 ${box === "inbox"? "收件箱": "发件箱"}是空的。\n`);
return 0;
}
for (const p of pkgs) {
process.stdout.write(`[${p.id}] ${p.status === "accepted"? "已接下": "待接"} ${p.from} → ${p.to}：${p.task}（${p.files.length} 个文件，${p.at}${p.contract_id ? `，挂契约 ${p.contract_id}` : ""}）\n`);
}
return 0;
}
if (cmd === "show") {
const agent = argv[1];
const id = argv[2];
if (!agent ||!id) { process.stderr.write("用法：nyra team handover show <agent> <id>\n"); return 2;}
const { pkg, box} = readHandover(home, agent, id);
process.stdout.write(
`交接包 ${pkg.id}（在 ${agent} 的 ${box}）：${pkg.status === "accepted"? "已接下": "待接"}\n`
+ ` ${pkg.from} → ${pkg.to}；${pkg.at}\n`
+ ` 任务：${pkg.task}\n`
+ (pkg.note? ` 备注：${pkg.note}\n`: "")
+ (pkg.contract_id? ` 交接契约：${pkg.contract_id}（对方 ack 时先程序验收：全过才接下，不过打回、轮次用完停下等人）\n`: "")
+ (pkg.files.length
? ` 文件（${pkg.files.length} 个）：\n${pkg.files.map((f) => ` - ${f.path}（${f.size} 字节，sha256 ${f.sha256.slice(0, 12)}${f.content!== null? "，原文已内联": "，只记指纹、原文在交出方 workspace"}）`).join("\n")}\n`
: " 文件：没有\n"),
);
return 0;
}
if (cmd === "ack") {
const agent = argv[1];
const id = argv[2];
const workdir = flagValue(argv, "--workdir");
if (!agent ||!id) { process.stderr.write("用法：nyra team handover ack <agent> <id> [--workdir <目录>]\n"); return 2;}
const pkg = ackHandover(home, agent, id, { workdir: workdir ?? undefined });
emitTeamEvent(input, "team_handover_accepted", { handover_id: pkg.id, from: pkg.from, to: pkg.to});
process.stdout.write(`已接下交接包 ${id}：${pkg.task}（${pkg.from} → ${pkg.to}）\n`);
return 0;
}
process.stderr.write("用法：nyra team handover <send|list|show|ack>\n");
return 2;
}

export async function handleTeam(argv: string[], home: string, input?: TeamCliInput & {
/** dispatch 真跑时用的回调（CLI 注入：建 chief Agent 跑 chief 任务；测试可注入假实现）。 */
runChief?: (plan: TeamDispatchPlan, task: string) => Promise<string>;
}): Promise<number> {
const cmd = argv[0];
try {
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
process.stdout.write(TEAM_USAGE + "\n");
return 0;
}
if (cmd === "create") {
const name = argv[1];
const chief = flagValue(argv, "--chief");
const membersRaw = flagValue(argv, "--members")?? "";
if (!name ||!chief ||!membersRaw) {
process.stderr.write("用法：nyra team create <团队名> --chief <参谋长> --members <成员1,成员2,...>\n");
return 2;
}
const members = membersRaw.split(/[,、]/).map((m) => m.trim()).filter(Boolean);
const team = createTeam(home, { name, chief, members});
emitTeamEvent(input, "team_created", { team_id: team.id, chief: team.chief, members: team.members.length});
process.stdout.write(`已建团队 ${team.name}（${team.id}）：参谋长 ${team.chief}，成员 ${team.members.join("、")}。\n`);
return 0;
}
if (cmd === "list") {
const all = argv.includes("--all");
const teams = listTeams(home, all);
if (!teams.length) {
process.stdout.write("还没有团队（nyra team create 建一个）。\n");
return 0;
}
for (const t of teams) {
process.stdout.write(`${t.name}（${t.id}）：参谋长 ${t.chief}，成员 ${t.members.join("、")}${t.status === "active"? "": "（已解散）"}\n`);
}
return 0;
}
if (cmd === "show") {
const idOrName = argv[1];
if (!idOrName) { process.stderr.write("用法：nyra team show <团队名或 id>\n"); return 2;}
const team = getTeam(home, idOrName);
if (!team) { process.stderr.write(`找不到团队 ${idOrName}\n`); return 1;}
process.stdout.write(formatTeam(team) + "\n");
return 0;
}
if (cmd === "add") {
const idOrName = argv[1];
const agent = argv[2];
if (!idOrName ||!agent) { process.stderr.write("用法：nyra team add <团队名或 id> <成员>\n"); return 2;}
const team = addTeamMember(home, idOrName, agent);
emitTeamEvent(input, "team_member_added", { team_id: team.id, agent});
process.stdout.write(`已把 ${agent} 加进团队 ${team.name}（现在 ${team.members.length} 个成员）。\n`);
return 0;
}
if (cmd === "remove") {
const idOrName = argv[1];
const agent = argv[2];
if (!idOrName ||!agent) { process.stderr.write("用法：nyra team remove <团队名或 id> <成员>\n"); return 2;}
const team = removeTeamMember(home, idOrName, agent);
emitTeamEvent(input, "team_member_removed", { team_id: team.id, agent});
process.stdout.write(`已把 ${agent} 移出团队 ${team.name}（现在 ${team.members.length} 个成员）。\n`);
return 0;
}
if (cmd === "dissolve") {
const idOrName = argv[1];
const yes = argv.includes("--yes");
if (!idOrName) { process.stderr.write("用法：nyra team dissolve <团队名或 id> [--yes]\n"); return 2;}
const team = getTeam(home, idOrName);
if (!team) { process.stderr.write(`找不到团队 ${idOrName}\n`); return 1;}
if (team.status === "dissolved") {
process.stdout.write(`团队 ${team.name} 已经解散了。\n`);
return 0;
}
if (!yes) {
const { askApproval} = await import("./approvalUi.ts");
process.stdout.write(`将解散团队 ${team.name}（参谋长 ${team.chief}，成员 ${team.members.join("、")}；解散是终态，交接记录与审计留着，团队不能再分派）。\n`);
const choice = await askApproval("确认解散这个团队吗？");
if (choice!== "yes") { process.stdout.write("已取消，未解散。\n"); return 0;}
}
dissolveTeam(home, idOrName);
emitTeamEvent(input, "team_dissolved", { team_id: team.id});
process.stdout.write(`已解散团队 ${team.name}。\n`);
return 0;
}
if (cmd === "dispatch") {
const idOrName = argv[1];
const task = argv[2];
const dryRun = argv.includes("--dry-run");
if (!idOrName ||!task) {
process.stderr.write("用法：nyra team dispatch <团队名或 id> \"<任务>\" [--dry-run]\n");
return 2;
}
const plan = planTeamDispatch(home, idOrName, task);
if (dryRun) {
process.stdout.write(
`分派计划（只出计划，没跑模型）：\n`
+ ` 团队：${plan.team.name}（${plan.team.id}）\n`
+ ` 参谋长：${plan.chief}（独占入口，只拆解、分派、汇总）\n`
+ ` 成员：${plan.members.join("、")}\n`
+ ` 月度硬顶：${plan.cap.reason}\n`
+ ` 任务：${plan.task}\n`,
);
return 0;
}
if (!input?.runChief) {
process.stderr.write("分派需要跑 chief 模型（本命令须在 agent 运行时里调，见 docs/team.md）。\n");
return 1;
}
// 第 2 批 G-P1-3：真跑之前参谋长拿 lead 租约（10 分钟；拿不到 = 已有
// 别的 lead 在任，直接拒绝，不抢）；纪元写进计划与任务文本（prepareTeamDispatch，
// 与网关分派共用）。dry-run 不拿租约。
let prepared: { plan: TeamDispatchPlan; chiefTask: string };
try { prepared = await prepareTeamDispatch(home, idOrName, task); }
catch (err) { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); return 1; }
const chiefTask = prepared.chiefTask;
emitTeamEvent(input, "team_dispatched", { team_id: prepared.plan.team.id, chief: prepared.plan.chief, members: prepared.plan.members.length});
const output = await input.runChief(prepared.plan, chiefTask);
process.stdout.write(output + "\n");
return 0;
}
if (cmd === "writer") {
const sub = argv[1];
const idOrName = argv[2];
if (sub !== "status" && sub !== "transfer" && sub !== "release") {
process.stderr.write("用法：nyra team writer <status|transfer|release> <团队名或 id> [<文件> <成员>] [--by <agent>]\n");
return 2;
}
if (!idOrName) { process.stderr.write("用法：nyra team writer " + sub + " <团队名或 id> ...\n"); return 2; }
const team = getTeam(home, idOrName);
if (!team) { process.stderr.write(`找不到团队 ${idOrName}\n`); return 1; }
if (sub === "status") {
const leases = listWriteLeases(home, team.id);
if (!leases.length) { process.stdout.write(`团队 ${team.name}：现在没有人拿着写者名额。\n`); return 0; }
process.stdout.write(`团队 ${team.name} 的写者名额（${leases.length} 个）：\n` + leases.map((l) => ` ${l.file} ← ${l.holder}（${l.grantedAt} 拿的）`).join("\n") + "\n");
return 0;
}
const file = argv[3];
if (!file) { process.stderr.write(`用法：nyra team writer ${sub} <团队名或 id> <文件>${sub === "transfer" ? " <成员>" : " [--by <agent>]"}\n`); return 2; }
const key = normalizeGateFile(file);
if (!key) { process.stderr.write(`文件 ${file} 不在工作区内（写者名额只认 workspace 相对路径）。\n`); return 2; }
if (sub === "transfer") {
const to = argv[4];
if (!to) { process.stderr.write("用法：nyra team writer transfer <团队名或 id> <文件> <成员>\n"); return 2; }
if (!team.members.includes(to) && to !== team.chief) { process.stderr.write(`${to} 不是团队 ${team.name} 的成员（参谋长 ${team.chief}，成员 ${team.members.join("、")}）。\n`); return 1; }
const res = transferWriteLease(home, team.id, key, team.chief, to, team.chief);
if (!res.granted) { process.stderr.write(res.reason + "\n"); return 1; }
emitTeamEvent(input, "write_gate_transferred", { team_id: team.id, file: key, from: team.chief, to });
process.stdout.write(`已把 ${key} 的写者名额移交给 ${to}。\n`);
return 0;
}
const by = flagValue(argv, "--by") ?? team.chief;
const released = releaseWriteLease(home, team.id, key, by);
if (!released) { process.stderr.write(`${key} 现在没有租约（或 ${by} 不是持有者也不是参谋长）。\n`); return 1; }
emitTeamEvent(input, "write_gate_released", { team_id: team.id, file: key, by });
process.stdout.write(`已把 ${key} 的写者名额还回去。\n`);
return 0;
}
if (cmd === "lead") {
const sub = argv[1];
const idOrName = argv[2];
if (sub !== "status" && sub !== "acquire" && sub !== "release" && sub !== "transfer") {
process.stderr.write("用法：nyra team lead <status|acquire|release|transfer> <团队名或 id> [<新 lead>] [--as <agent>]\n");
return 2;
}
if (!idOrName) { process.stderr.write("用法：nyra team lead " + sub + " <团队名或 id> ...\n"); return 2; }
const team = getTeam(home, idOrName);
if (!team) { process.stderr.write(`找不到团队 ${idOrName}\n`); return 1; }
const { acquireTeamLease, releaseTeamLease, transferTeamLead, getTeamLease } = await import("./teamLease.ts");
if (sub === "status") {
const lease = getTeamLease(home, team.id);
if (!lease) { process.stdout.write(`团队 ${team.name}：现在没有 lead（没有活租约）。\n`); return 0; }
process.stdout.write(`团队 ${team.name}：lead 是 ${lease.lead}，纪元 ${lease.epoch}，租约到 ${lease.expiresAt} 过期。\n`);
return 0;
}
const as = flagValue(argv, "--as") ?? team.chief;
if (sub === "acquire") {
const res = acquireTeamLease(home, team.id, as);
if (!res.granted) { process.stderr.write(res.reason + "\n"); return 1; }
emitTeamEvent(input, "team_lease_acquired", { team_id: team.id, lead: as, epoch: res.lease.epoch });
process.stdout.write(`已拿 lead 租约：${as}，纪元 ${res.lease.epoch}，到 ${res.lease.expiresAt} 过期（10 分钟）。\n`);
return 0;
}
if (sub === "release") {
const before = getTeamLease(home, team.id);
const released = releaseTeamLease(home, team.id, as);
if (!released) { process.stderr.write(`${as} 现在不是团队 ${team.name} 的 lead（或没有活租约）。\n`); return 1; }
emitTeamEvent(input, "team_lease_released", { team_id: team.id, lead: as, epoch: before?.epoch ?? 0 });
process.stdout.write(`已还 lead 租约：${as}（纪元 ${before?.epoch ?? "?"}）。\n`);
return 0;
}
const to = argv[3];
if (!to) { process.stderr.write("用法：nyra team lead transfer <团队名或 id> <新 lead>\n"); return 2; }
if (!team.members.includes(to) && to !== team.chief) { process.stderr.write(`${to} 不是团队 ${team.name} 的成员（参谋长 ${team.chief}，成员 ${team.members.join("、")}）。\n`); return 1; }
const transferred = transferTeamLead(home, team.id, as, to);
if (!transferred.granted) { process.stderr.write(transferred.reason + "\n"); return 1; }
emitTeamEvent(input, "team_lease_transferred", { team_id: team.id, from: as, to, epoch: transferred.lease.epoch });
process.stdout.write(`已把 lead 从 ${as} 交给 ${to}，纪元 ${transferred.lease.epoch}（旧 lead 的分派立刻失效）。\n`);
return 0;
}
if (cmd === "handover") {
return handleHandover(argv.slice(1), home, input);
}
process.stderr.write(TEAM_USAGE + "\n");
return 2;
} catch (err: unknown) {
process.stderr.write(`${err instanceof Error? err.message: String(err)}\n`);
return 1;
}
}
