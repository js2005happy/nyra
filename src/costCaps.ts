// src/costCaps.ts — 缺口 43 第三批：分层成本上限 + 审计导出（企业治理控制面的最后一批）。
//
// 两件事：
//   1. 分层成本上限：按 Bot / 角色 / 团队 / 人设设月度上限（美元与 token 两
//      种），默认最严——最严的一层胜出；子层上限永远不能超过组织级上限，
//      想放宽先抬组织级，而抬上限本身（放宽）要进证据链（谁、什么时候、
//      从多少抬到多少、为什么）。触顶时任务进可恢复暂停态（检查点已落盘），
//      不是直接丢弃。
//   2. 审计导出：把治理审计日志导出给 SIEM，格式固定一种（JSONL），每条记
//      录带哈希链（改一行就验得出来）；导出操作本身进证据链。
//
// 几个定夺（写死在这里，免得后人各说各话）：
//   - “组织级默认应有一条最严上限”：组织级上限就是已有的月度硬顶
//     （config.monthly_cost_limit_usd，缺口 20/29 口径），不在这里另设
//     一个美元数——cost.ts 已定：任何默认美元数都是凭空编的，默认不设
//     上限（null）。“默认最严”落在机制上：多层同时设了时取最严的一层，
//     子层超过组织级时直接拒绝设置（须先显式抬组织级，抬的动作本身进
//     证据链）。没配组织级上限时，子层上限各自生效。
//   - 花费口径与月度硬顶同一份数：组织级 = 用量账本本月 LLM 花费 +
//     MCP 花费（与 checkAutoAllowed 同口径）；分层 = 用量账本按 agent
//     归属拆分（usageLedger 的 agent 字段）。MCP 花费没有 agent 归属，
//     只在组织级计入，分层不含 MCP——这是诚实边界，不是漏洞，写进文档。
//   - 分层花费是下界：账本里没归属的行（旧行、CLI 交互运行、网关会话）
//     分不下去，只会让分层判定晚触发、不会误触发（与月度硬顶同款）。
//   - 角色层按“请求方账号的角色”算：分层里没有按角色汇总的花费账本，
//     角色上限约束的是“以该角色身份跑的 agent 各自的花费”（与 agent 层
//     同一份数、不同的一层上限），不是全角色汇总——汇总数算不出来，不编。
//   - 暂停的“检查点”就是运行记录 + 任务板行：runId 指向的运行记录里有
//     完整状态与用量，任务板行里有任务元数据；不另写一份检查点文件，
//     恢复时按运行记录/任务板行续。没有 runId/taskId 的暂停，检查点就
//     是 agent + 月份 + 当时已花（记录里写清）。
//   - 审计导出只覆盖治理控制面的 5 份审计日志（governance、sso、
//     accounts、business-redlines、soul）；运行级证据链（runs/ 下每运
//     行的 events.jsonl）不在本导出里——那是另一份量级的导出，后续再做。
//
// 护城河：
//   - 账本全部原子写 0600，损坏先备份再抛错、不静默重建；
//   - 审计写失败不抛错（审计丢了不该拦住正事），但返回 false；
//   - 事件里只记 id 与 12 位指纹，不记原文、不记绝对路径、不记密钥；
//   - 本模块不 import governance.ts（governance.ts 要调这里的
//     evaluateTieredCaps，单向依赖，不成环）；审计链与运行事件镜像用
//     本模块自己的小函数（与 governance.ts / kanban.ts 同款写法）。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveHome, loadConfig } from "./config.ts";
import { RunStore } from "./runs.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { resolveMonthlyLimit, resolvePricing } from "./cost.ts";
import { resolveStrictUnknownAmount } from "./budget.ts";
import { soulExists, SOUL_AGENT_ID_RE } from "./soul.ts";
import { ACCOUNTS_FILE } from "./accounts.ts";
import { pauseKanbanTask, resumeKanbanTask, getKanbanTask } from "./kanban.ts";

export class CostCapsError extends Error {}

const CAPS_FILE = "cost-caps.json";
const PAUSES_FILE = "cost-pauses.json";
const MAX_REASON_CHARS = 300;
const MAX_HISTORY = 100;

const TEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ROLE_RE = /^(owner|user)$/;

export type CapScopeKind = "org" | "team" | "role" | "agent" | "persona";

export interface CostCap {
  scope: string;
  kind: CapScopeKind;
  /** 月度美元上限；null = 本层不限美元。 */
  monthUsd: number | null;
  /** 月度 token 上限；null = 本层不限 token。 */
  monthTokens: number | null;
  setBy: string;
  setAt: string;
  reason: string;
}

export interface CapRelaxation {
  id: string;
  at: string;
  scope: string;
  field: "monthUsd" | "monthTokens" | "cap-removed";
  oldValue: number | null;
  newValue: number | null;
  by: string;
  reason: string;
}

export interface CostCapsStore {
  version: 1;
  caps: CostCap[];
  /** agent → team（一台 Bot 一个团队，v1 只认单归属）。 */
  agentTeams: Record<string, string>;
  relaxations: CapRelaxation[];
}

export interface CostPause {
  id: string;
  at: string;
  agent: string;
  /** 触顶的那一层（org/team:/role:/agent:/persona:），手动暂停是 "manual"，
   *  金额未知暂停是 "unknown-amount"（可靠性打磨第 2 项第一批）。 */
  scope: string;
  capUsd: number | null;
  spentUsd: number;
  capTokens: number | null;
  spentTokens: number;
  taskId: string | null;
  runId: string | null;
  /** 检查点引用：runId（运行记录）或 taskId（任务板行），都没有时为 null。 */
  checkpointRef: string | null;
  status: "paused" | "resumed" | "discarded";
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  /** 金额未知暂停的原因（只记短码，不记原文）：
   *  `no-pricing:<模型>`（未配单价）或 `missing-usage:<n>次调用未报用量`。
   *  老行没有这个字段，读作 undefined；分层暂停也不填。 */
  detail?: string;
}

export interface PauseStore {
  version: 1;
  pauses: CostPause[];
}

export interface TierCheck {
  scope: string;
  capUsd: number | null;
  spentUsd: number;
  /** 该层美元数是否可判定（没计价的行太多时为 false，此时不判超）。 */
  usdKnown: boolean;
  capTokens: number | null;
  spentTokens: number;
  exceeded: boolean;
  binding: "usd" | "tokens" | null;
}

export interface TieredEvaluation {
  allowed: boolean;
  month: string;
  agent: string;
  layers: TierCheck[];
  bindingScope: string | null;
  bindingReason: string;
  /** 当月未归属到任何 agent 的花费（分层口径的下界缺口）。 */
  unattributedUsd: number;
  unattributedTokens: number;
}

export interface TieredCtx {
  agent: string;
  role?: string | null;
  accountId?: string | null;
  month?: string;
  /** 本次运行进行中、还没落盘的美元花费（null = 未计价，美元层跳过）。 */
  inProgressUsd?: number | null;
  /** 本次运行进行中的 token 数。 */
  inProgressTokens?: number;
}

/** Agent 回调的上下文 holder：调用方知道 runId/taskId 时填进去，暂停记录就带上。 */
export interface TieredCtxHolder {
  runId?: string | null;
  taskId?: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex").slice(0, 12);
}

export function hashText(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function newCapRelaxationId(): string {
  return `cr_${randomBytes(6).toString("hex")}`;
}

function newPauseId(): string {
  return `cp_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

/** 原子写 0600：先写同目录临时文件再 rename；旧文件是符号链接就拒绝。 */
function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new CostCapsError(`${file} 不能是符号链接`);
  }
  const tmp = join(dirname(path), `.${file}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function loadJson<T>(home: string, file: string, empty: T, validate: (raw: unknown) => raw is T): T {
  const path = join(resolveHome(home), file);
  if (!existsSync(path)) return empty;
  if (lstatSync(path).isSymbolicLink()) throw new CostCapsError(`${file} 不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new CostCapsError(`${file} 损坏，已备份，请检查后恢复`);
  }
  if (!validate(raw)) {
    backupCorrupt(path);
    throw new CostCapsError(`${file} 格式无效，已备份`);
  }
  return raw;
}

function isCapsStore(raw: unknown): raw is CostCapsStore {
  return !!raw && typeof raw === "object" && (raw as CostCapsStore).version === 1 &&
    Array.isArray((raw as CostCapsStore).caps) &&
    typeof (raw as CostCapsStore).agentTeams === "object" && (raw as CostCapsStore).agentTeams !== null &&
    Array.isArray((raw as CostCapsStore).relaxations);
}

function isPauseStore(raw: unknown): raw is PauseStore {
  return !!raw && typeof raw === "object" && (raw as PauseStore).version === 1 &&
    Array.isArray((raw as PauseStore).pauses);
}

export function loadCapsStore(home: string): CostCapsStore {
  return loadJson(home, CAPS_FILE, { version: 1, caps: [], agentTeams: {}, relaxations: [] } as CostCapsStore, isCapsStore);
}

export function loadPauseStore(home: string): PauseStore {
  return loadJson(home, PAUSES_FILE, { version: 1, pauses: [] } as PauseStore, isPauseStore);
}

export function capsPath(home: string): string {
  return join(resolveHome(home), CAPS_FILE);
}

export function pausesPath(home: string): string {
  return join(resolveHome(home), PAUSES_FILE);
}

/** 审计链：append-only jsonl，0600。写失败不抛错（审计丢了不该拦住正事），但返回 false。 */
export function appendCostCapsAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(resolveHome(home), "governance-audit.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: nowIso(), ...entry }) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 有运行上下文时，把分层上限事件镜像进运行事件（tasks 目录优先，runs 次之）。 */
function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

// ---------------------------------------------------------------------------
// 上限账本：范围解析与设置
// ---------------------------------------------------------------------------

export function parseCapScope(scope: string): { kind: CapScopeKind; id: string | null } {
  const s = (scope ?? "").trim();
  if (s === "org") return { kind: "org", id: null };
  const m = /^(team|role|agent|persona):(.+)$/.exec(s);
  if (!m) throw new CostCapsError(`上限范围无效：${JSON.stringify(scope)}（应为 org 或 team:<id> / role:<owner|user> / agent:<id> / persona:<id>）`);
  const kind = m[1] as CapScopeKind;
  const id = m[2];
  if (kind === "team" && !TEAM_ID_RE.test(id)) throw new CostCapsError(`团队 id 无效：${JSON.stringify(id)}（小写字母/数字开头，字母数字/_/-，最长 32 字）`);
  if (kind === "role" && !ROLE_RE.test(id)) throw new CostCapsError(`角色无效：${JSON.stringify(id)}（只能是 owner 或 user）`);
  if ((kind === "agent" || kind === "persona") && !SOUL_AGENT_ID_RE.test(id)) throw new CostCapsError(`agent id 无效：${JSON.stringify(id)}（小写字母开头，字母数字/_/-，最长 32 字）`);
  return { kind, id };
}

function validateCapValue(v: number | null | undefined, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new CostCapsError(`${field} 必须是 ≥ 0 的数字（0 = 锁死一切，null = 不限）`);
  return v;
}

export function getCap(home: string, scope: string): CostCap | null {
  const store = loadCapsStore(home);
  return store.caps.find((c) => c.scope === scope) ?? null;
}

export function listCaps(home: string): CostCap[] {
  return loadCapsStore(home).caps.slice().sort((a, b) => a.scope.localeCompare(b.scope));
}

export function listRelaxations(home: string): CapRelaxation[] {
  return loadCapsStore(home).relaxations.slice().sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * 设一层上限。monthUsd/monthTokens 传 undefined = 保持原值，null = 取消该项。
 * 两项都取消（或本来就没这一层）= 整层删掉。
 *   - org 层拒绝在这里设：组织级上限就是月度硬顶（config.monthly_cost_limit_usd）。
 *   - 子层上限不能超过组织级上限（美元项；组织级未配时不拦）：想放宽先抬
 *     组织级，抬的动作本身进证据链。
 *   - 抬高上限或取消上限 = 放宽：记一条 relaxations + 审计（谁、什么时候、
 *     从多少到多少、为什么）；调低或新设上限 = 收紧，只记审计。
 */
export function setCap(
  home: string,
  scope: string,
  opts: { monthUsd?: number | null; monthTokens?: number | null; by?: string; reason: string; runId?: string | null },
): CostCap | null {
  const { kind } = parseCapScope(scope);
  if (kind === "org") {
    throw new CostCapsError("组织级上限就是月度硬顶（config.monthly_cost_limit_usd），请用 nyra cost 或 --monthly-max-cost 改，不在这里设");
  }
  const reason = (opts.reason ?? "").trim();
  if (!reason) throw new CostCapsError("设上限须写原因（--reason）");
  if (reason.length > MAX_REASON_CHARS) throw new CostCapsError(`原因过长（超过 ${MAX_REASON_CHARS} 字符）`);
  const by = (opts.by ?? "cli").trim() || "cli";
  const monthUsd = validateCapValue(opts.monthUsd, "月度美元上限");
  const monthTokens = validateCapValue(opts.monthTokens, "月度 token 上限");
  const store = loadCapsStore(home);
  const existing = store.caps.find((c) => c.scope === scope);
  const nextUsd = opts.monthUsd === undefined ? (existing?.monthUsd ?? null) : monthUsd;
  const nextTokens = opts.monthTokens === undefined ? (existing?.monthTokens ?? null) : monthTokens;
  // 子层不能超过组织级（美元项）：组织级未配时不拦。
  if (nextUsd !== null) {
    const orgLimit = resolveMonthlyLimit(loadConfig(home));
    if (orgLimit !== null && nextUsd > orgLimit) {
      throw new CostCapsError(`子层上限 $${nextUsd} 超过组织级上限 $${orgLimit}：先抬组织级（nyra cost 或 --monthly-max-cost），抬的动作会进证据链`);
    }
  }
  const relaxations: CapRelaxation[] = [];
  const relax = (field: "monthUsd" | "monthTokens" | "cap-removed", oldValue: number | null, newValue: number | null): void => {
    const r: CapRelaxation = {
      id: newCapRelaxationId(), at: nowIso(), scope, field, oldValue, newValue, by, reason,
    };
    relaxations.push(r);
    store.relaxations.unshift(r);
    if (store.relaxations.length > MAX_HISTORY) store.relaxations.length = MAX_HISTORY;
    appendCostCapsAudit(home, {
      action: "cost_cap_relaxed", scope, field, old_value: oldValue, new_value: newValue, by, reason_hash: shortHash(reason),
    });
    mirrorEvent(home, opts.runId ?? null, "cost_cap_relaxed", { scope, field, old_value: oldValue, new_value: newValue });
  };
  if (existing) {
    if (opts.monthUsd !== undefined && nextUsd !== existing.monthUsd) {
      if (nextUsd === null || (existing.monthUsd !== null && nextUsd > existing.monthUsd)) {
        relax("monthUsd", existing.monthUsd, nextUsd);
      }
    }
    if (opts.monthTokens !== undefined && nextTokens !== existing.monthTokens) {
      if (nextTokens === null || (existing.monthTokens !== null && nextTokens > existing.monthTokens)) {
        relax("monthTokens", existing.monthTokens, nextTokens);
      }
    }
  }
  if (nextUsd === null && nextTokens === null) {
    // 两项都空 = 整层删掉（放宽：原来有上限，现在没了）。
    if (existing) {
      relax("cap-removed", null, null);
      store.caps = store.caps.filter((c) => c.scope !== scope);
      saveJsonAtomic(home, CAPS_FILE, store);
    }
    return null;
  }
  const cap: CostCap = {
    scope, kind,
    monthUsd: nextUsd, monthTokens: nextTokens,
    setBy: by, setAt: nowIso(), reason,
  };
  if (existing) {
    Object.assign(existing, cap);
  } else {
    store.caps.push(cap);
  }
  saveJsonAtomic(home, CAPS_FILE, store);
  if (relaxations.length === 0) {
    appendCostCapsAudit(home, {
      action: "cost_cap_set", scope, month_usd: nextUsd, month_tokens: nextTokens, by, reason_hash: shortHash(reason),
    });
    mirrorEvent(home, opts.runId ?? null, "cost_cap_set", { scope, field: "cap" });
  }
  return cap;
}

/** agent 归属哪个团队（v1 单归属）；teamId 为 null = 解除归属。 */
export function assignTeam(home: string, agent: string, teamId: string | null, by?: string): string | null {
  if (!SOUL_AGENT_ID_RE.test(agent)) throw new CostCapsError("agent 必须是小写字母开头的 agent id");
  if (teamId !== null && !TEAM_ID_RE.test(teamId)) throw new CostCapsError(`团队 id 无效：${JSON.stringify(teamId)}`);
  const store = loadCapsStore(home);
  if (teamId === null) delete store.agentTeams[agent];
  else store.agentTeams[agent] = teamId;
  saveJsonAtomic(home, CAPS_FILE, store);
  appendCostCapsAudit(home, { action: "cost_cap_team_assigned", agent, team: teamId, by: (by ?? "cli").trim() || "cli" });
  return teamId;
}

export function teamMembers(home: string, teamId: string): string[] {
  const store = loadCapsStore(home);
  return Object.entries(store.agentTeams)
    .filter(([, t]) => t === teamId)
    .map(([a]) => a)
    .sort();
}

/** 同步读账号文件取角色（AccountStore 的方法全是 async，同步判定走文件直读；文件坏了/没有该账号时返回 null，角色层跳过，不拦判定）。 */
export function findAccountRoleSync(home: string, accountId: string): string | null {
  try {
    const path = join(resolveHome(home), ACCOUNTS_FILE);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { accounts?: unknown };
    const items = Array.isArray(raw.accounts) ? raw.accounts : [];
    const hit = items.find((a): a is { id: string; role: string } =>
      !!a && typeof a === "object" && (a as { id: unknown }).id === accountId && typeof (a as { role: unknown }).role === "string");
    if (!hit || !ROLE_RE.test(hit.role)) return null;
    return hit.role;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 分层判定（纯判定，不执行；与月度硬顶同一份数、同一诚实边界）
// ---------------------------------------------------------------------------

function layerCheck(
  scope: string,
  capUsd: number | null,
  spentUsd: number,
  usdKnown: boolean,
  capTokens: number | null,
  spentTokens: number,
): TierCheck {
  let exceeded = false;
  let binding: "usd" | "tokens" | null = null;
  if (capUsd !== null && usdKnown && spentUsd > capUsd) {
    exceeded = true;
    binding = "usd";
  } else if (capTokens !== null && spentTokens > capTokens) {
    exceeded = true;
    binding = "tokens";
  }
  return { scope, capUsd, spentUsd, usdKnown, capTokens, spentTokens, exceeded, binding };
}

/**
 * 分层上限判定。层与花费口径：
 *   - org：本月全部花费（用量账本 LLM + MCP，含未归属）对月度硬顶；
 *     token = 本月全部 token。
 *   - team：该团队成员 agent 的花费之和（成员关系见 caps assign-team）。
 *   - role：请求方账号的角色；花费 = 该 agent 自己的花费（按角色汇总的
 *     账本不存在，不编汇总数——见文件头定夺）。
 *   - agent：该 agent 自己的花费。
 *   - persona：该 agent 的 Soul（没建 Soul 时该层跳过）；花费与 agent 层同一份。
 * 进行中的花费（inProgress）加到每一层——同一笔钱在各层都算数。
 * 美元数算不出（未计价）时该层美元不判超，只判 token（与月度硬顶同款）。
 */
export function evaluateTieredCaps(home: string, ctx: TieredCtx): TieredEvaluation {
  const agent = (ctx.agent ?? "").trim();
  if (!SOUL_AGENT_ID_RE.test(agent)) throw new CostCapsError("判定分层上限须给合法的 agent id");
  const month = ctx.month ?? monthKeyString();
  const store = loadCapsStore(home);
  const capOf = (scope: string): CostCap | null => store.caps.find((c) => c.scope === scope) ?? null;
  const ledger = new UsageLedger(home);
  const monthTotal = ledger.monthTotal(month);
  const byAgent = ledger.monthSpendByAgent(month);
  const mcpUsd = new McpCostTracker(home).monthTotalUsd(month);
  const inUsd = typeof ctx.inProgressUsd === "number" && Number.isFinite(ctx.inProgressUsd) ? Math.max(0, ctx.inProgressUsd) : null;
  const inTokens = typeof ctx.inProgressTokens === "number" && Number.isFinite(ctx.inProgressTokens) ? Math.max(0, Math.floor(ctx.inProgressTokens)) : 0;

  const agentSpend = byAgent.byAgent.get(agent) ?? { spentUsd: 0, totalTokens: 0, calls: 0 };
  const agentUsdKnown = agentSpend.spentUsd > 0 || inUsd !== null;
  const layers: TierCheck[] = [];

  // org 层：组织级上限就是月度硬顶；MCP 花费只在这里计入。
  const orgCap = resolveMonthlyLimit(loadConfig(home));
  const orgSpentUsd = monthTotal.spentUsd + mcpUsd + (inUsd ?? 0);
  const orgUsdKnown = orgSpentUsd > 0 || inUsd !== null;
  layers.push(layerCheck("org", orgCap, orgSpentUsd, orgUsdKnown, null, monthTotal.totalTokens + inTokens));

  // team 层：成员花费之和。
  const teamId = store.agentTeams[agent] ?? null;
  if (teamId) {
    const members = teamMembers(home, teamId);
    let spent = 0;
    let tokens = 0;
    let known = inUsd !== null;
    for (const m of members) {
      const s = byAgent.byAgent.get(m);
      if (!s) continue;
      spent += s.spentUsd;
      tokens += s.totalTokens;
      if (s.spentUsd > 0) known = true;
    }
    const cap = capOf(`team:${teamId}`);
    if (cap) layers.push(layerCheck(cap.scope, cap.monthUsd, spent + (inUsd ?? 0), known, cap.monthTokens, tokens + inTokens));
  }

  // role 层：请求方账号的角色（没给账号/读不到角色时跳过）。
  const role = ctx.role ?? (ctx.accountId ? findAccountRoleSync(home, ctx.accountId) : null);
  if (role && ROLE_RE.test(role)) {
    const cap = capOf(`role:${role}`);
    if (cap) layers.push(layerCheck(cap.scope, cap.monthUsd, agentSpend.spentUsd + (inUsd ?? 0), agentUsdKnown, cap.monthTokens, agentSpend.totalTokens + inTokens));
  }

  // agent 层。
  const agentCap = capOf(`agent:${agent}`);
  if (agentCap) layers.push(layerCheck(agentCap.scope, agentCap.monthUsd, agentSpend.spentUsd + (inUsd ?? 0), agentUsdKnown, agentCap.monthTokens, agentSpend.totalTokens + inTokens));

  // persona 层：该 agent 建了 Soul 才有；花费与 agent 层同一份。
  if (soulExists(home, agent)) {
    const personaCap = capOf(`persona:${agent}`);
    if (personaCap) layers.push(layerCheck(personaCap.scope, personaCap.monthUsd, agentSpend.spentUsd + (inUsd ?? 0), agentUsdKnown, personaCap.monthTokens, agentSpend.totalTokens + inTokens));
  }

  const binding = layers.find((l) => l.exceeded) ?? null;
  const bindingReason = binding
    ? binding.binding === "usd"
      ? `${binding.scope} 层美元上限已超：已花 $${binding.spentUsd.toFixed(4)} / 上限 $${(binding.capUsd ?? 0).toFixed(2)}（${month}）`
      : `${binding.scope} 层 token 上限已超：已用 ${binding.spentTokens.toLocaleString("en-US")} / 上限 ${(binding.capTokens ?? 0).toLocaleString("en-US")}（${month}）`
    : "";
  return {
    allowed: binding === null,
    month,
    agent,
    layers,
    bindingScope: binding?.scope ?? null,
    bindingReason,
    unattributedUsd: byAgent.unattributed.spentUsd,
    unattributedTokens: byAgent.unattributed.totalTokens,
  };
}

export function tieredExceededMessage(ev: TieredEvaluation): string {
  const lines = [
    `分层成本上限已超：${ev.bindingReason}`,
    "运行已中止，任务进可恢复暂停态（检查点已落盘：运行记录 + 任务板行），不是直接丢弃。",
    "恢复办法：抬上限（nyra governance caps set --scope <层>，放宽进证据链）或等下月 1 日重置，再跑 nyra governance caps resume <暂停 id> --yes。",
  ];
  if (ev.unattributedUsd > 0) {
    lines.push(`注意：本月另有 $${ev.unattributedUsd.toFixed(4)} 未归属到任何 agent 的花费（分层数是下界，组织级月度口径已含它）。`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 可恢复暂停态
// ---------------------------------------------------------------------------

export function getPause(home: string, id: string): CostPause {
  const store = loadPauseStore(home);
  const pause = store.pauses.find((p) => p.id === id);
  if (!pause) throw new CostCapsError(`找不到暂停记录 ${id}`);
  return pause;
}

export function listPauses(home: string, filter?: { status?: CostPause["status"]; agent?: string }): CostPause[] {
  const store = loadPauseStore(home);
  return store.pauses
    .filter((p) => (!filter?.status || p.status === filter.status) && (!filter?.agent || p.agent === filter.agent))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * 建一条暂停记录（触顶时调）。同 agent + 同层 + 同月已有未决暂停时直接
 * 返回那条，不重复建（checkCost 每轮都会触发一次，没去重会刷屏）。
 * taskId 给了且任务还在 working/queued 时，任务板任务同步进 paused（不
 * 耗 attempts、不走 fail 路径）；任务板动不了（任务已终态）时只记暂停，
 * 不拦创建。
 */
export function pauseForCap(
  home: string,
  ev: TieredEvaluation,
  opts: { by?: string; taskId?: string | null; runId?: string | null },
): CostPause {
  const store = loadPauseStore(home);
  const binding = ev.layers.find((l) => l.exceeded);
  const scope = binding?.scope ?? "manual";
  const open = store.pauses.find((p) => p.status === "paused" && p.agent === ev.agent && p.scope === scope && p.at.slice(0, 7) === ev.month);
  if (open) return open;
  const pause: CostPause = {
    id: newPauseId(),
    at: nowIso(),
    agent: ev.agent,
    scope,
    capUsd: binding?.capUsd ?? null,
    spentUsd: binding?.spentUsd ?? 0,
    capTokens: binding?.capTokens ?? null,
    spentTokens: binding?.spentTokens ?? 0,
    taskId: opts.taskId ?? null,
    runId: opts.runId ?? null,
    checkpointRef: opts.runId ?? opts.taskId ?? null,
    status: "paused",
    decidedBy: null,
    decidedAt: null,
    note: null,
  };
  store.pauses.unshift(pause);
  if (store.pauses.length > MAX_HISTORY) store.pauses.length = MAX_HISTORY;
  saveJsonAtomic(home, PAUSES_FILE, store);
  if (pause.taskId) {
    try {
      const task = getKanbanTask(home, pause.taskId);
      if (task.status === "working" || task.status === "queued") {
        pauseKanbanTask(home, pause.taskId, `分层成本上限已超（${scope}），暂停等处理`);
      }
    } catch { /* 任务板动不了不拦暂停创建 */ }
  }
  appendCostCapsAudit(home, {
    action: "cost_cap_paused", pause_id: pause.id, agent: pause.agent, scope: pause.scope,
    task_id: pause.taskId, run_id: pause.runId,
  });
  mirrorEvent(home, pause.runId, "cost_cap_paused", { pause_id: pause.id, agent: pause.agent, scope: pause.scope });
  return pause;
}

/**
 * 金额未知暂停（可靠性打磨第 2 项第一批）：配了上限却算不出金额时停下
 * 等人工处理，而不是继续跑。与 pauseForCap 共用同一份暂停账本
 * （cost-pauses.json）与恢复入口（caps resume），scope 固定
 * "unknown-amount"，上限字段恒为 null（不是“上限为 0”，是“没法判定”）。
 * detail 只记短码：`no-pricing:<模型>`（未配单价）或
 * `missing-usage:<n>次调用未报用量`。同 agent + 同 scope + 同月已有
 * 未决暂停时直接返回那条，不重复建。
 */
export function pauseForUnknownAmount(
  home: string,
  opts: { agent: string; detail: string; spentUsd?: number; spentTokens?: number; taskId?: string | null; runId?: string | null },
): CostPause {
  const agent = (opts.agent ?? "").trim();
  if (!SOUL_AGENT_ID_RE.test(agent)) throw new CostCapsError("金额未知暂停须给合法的 agent id");
  const detail = (opts.detail ?? "").trim().slice(0, 200);
  if (!detail) throw new CostCapsError("金额未知暂停须给原因（detail）");
  const store = loadPauseStore(home);
  const month = monthKeyString();
  const open = store.pauses.find((p) => p.status === "paused" && p.agent === agent && p.scope === "unknown-amount" && p.at.slice(0, 7) === month);
  if (open) return open;
  const pause: CostPause = {
    id: newPauseId(),
    at: nowIso(),
    agent,
    scope: "unknown-amount",
    capUsd: null,
    spentUsd: typeof opts.spentUsd === "number" && Number.isFinite(opts.spentUsd) ? Math.max(0, opts.spentUsd) : 0,
    capTokens: null,
    spentTokens: typeof opts.spentTokens === "number" && Number.isFinite(opts.spentTokens) ? Math.max(0, Math.floor(opts.spentTokens)) : 0,
    taskId: opts.taskId ?? null,
    runId: opts.runId ?? null,
    checkpointRef: opts.runId ?? opts.taskId ?? null,
    status: "paused",
    decidedBy: null,
    decidedAt: null,
    note: null,
    detail,
  };
  store.pauses.unshift(pause);
  if (store.pauses.length > MAX_HISTORY) store.pauses.length = MAX_HISTORY;
  saveJsonAtomic(home, PAUSES_FILE, store);
  if (pause.taskId) {
    try {
      const task = getKanbanTask(home, pause.taskId);
      if (task.status === "working" || task.status === "queued") {
        pauseKanbanTask(home, pause.taskId, `金额未知（${detail}），暂停等处理`);
      }
    } catch { /* 任务板动不了不拦暂停创建 */ }
  }
  appendCostCapsAudit(home, {
    action: "cost_cap_paused", pause_id: pause.id, agent: pause.agent, scope: pause.scope,
    task_id: pause.taskId, run_id: pause.runId,
  });
  mirrorEvent(home, pause.runId, "budget_paused", { pause_id: pause.id, agent: pause.agent, reason: detail });
  return pause;
}

/**
 * 恢复暂停：先重判分层上限，还超就拒绝（fail-closed）；放行后把暂停标
 * resumed，任务板任务在 paused 时回队列（attempts 不动，不算一次失败）。
 */
export function resumePause(home: string, id: string, by: string, opts?: { runId?: string | null }): CostPause {
  const store = loadPauseStore(home);
  const pause = store.pauses.find((p) => p.id === id);
  if (!pause) throw new CostCapsError(`找不到暂停记录 ${id}`);
  if (pause.status !== "paused") throw new CostCapsError(`暂停记录 ${id} 已是 ${pause.status}，不能再恢复`);
  // 金额未知暂停（可靠性打磨第 2 项第一批）：不走分层重判——分层上限没超
  // 也不代表金额能算出来。放行条件：严格模式已关，或 no-pricing 的那个
  // 模型现在配好了单价；missing-usage 的用量追不回来，只能先关严格模式
  // 再恢复（恢复后那几笔用量仍按未计价记，不补编）。
  let eventType = "cost_cap_resumed";
  let note = "上限已处理，恢复";
  if (pause.scope === "unknown-amount") {
    const config = loadConfig(home);
    if (!resolveStrictUnknownAmount(config)) {
      // 严格模式已关，放行。
    } else if (typeof pause.detail === "string" && pause.detail.startsWith("no-pricing:")) {
      const model = pause.detail.slice("no-pricing:".length).trim();
      if (!model || !resolvePricing(config.pricing, model)) {
        throw new CostCapsError(`还不能恢复：模型 ${model || "（未知）"} 仍未配单价。先在 config.pricing 里配好该模型单价，或跑 nyra budget strict --off 关掉严格模式。`);
      }
    } else {
      throw new CostCapsError(`还不能恢复：${pause.detail ?? "金额未知"}，用量追不回来。先跑 nyra budget strict --off 关掉严格模式再恢复（恢复后那几笔用量仍按未计价记，不补编）。`);
    }
    eventType = "budget_resumed";
    note = "金额未知原因已处理，恢复";
  } else {
    const ev = evaluateTieredCaps(home, { agent: pause.agent });
    if (!ev.allowed) {
      throw new CostCapsError(`还不能恢复：${ev.bindingReason}。先抬上限或等下月 1 日重置。`);
    }
  }
  pause.status = "resumed";
  pause.decidedBy = (by ?? "cli").trim() || "cli";
  pause.decidedAt = nowIso();
  pause.note = note;
  saveJsonAtomic(home, PAUSES_FILE, store);
  if (pause.taskId) {
    try {
      const task = getKanbanTask(home, pause.taskId);
      if (task.status === "paused") resumeKanbanTask(home, pause.taskId);
    } catch { /* 任务板动不了不拦恢复 */ }
  }
  appendCostCapsAudit(home, { action: "cost_cap_resumed", pause_id: pause.id, agent: pause.agent, by: pause.decidedBy });
  mirrorEvent(home, opts?.runId ?? pause.runId, eventType, { pause_id: pause.id, agent: pause.agent });
  return pause;
}

/** 放弃恢复：只关暂停记录本身；任务板任务仍在 paused，想跑再用 nyra kanban resume。 */
export function discardPause(home: string, id: string, by: string, opts?: { runId?: string | null }): CostPause {
  const store = loadPauseStore(home);
  const pause = store.pauses.find((p) => p.id === id);
  if (!pause) throw new CostCapsError(`找不到暂停记录 ${id}`);
  if (pause.status !== "paused") throw new CostCapsError(`暂停记录 ${id} 已是 ${pause.status}，不能再放弃`);
  pause.status = "discarded";
  pause.decidedBy = (by ?? "cli").trim() || "cli";
  pause.decidedAt = nowIso();
  pause.note = "人工放弃恢复";
  saveJsonAtomic(home, PAUSES_FILE, store);
  appendCostCapsAudit(home, { action: "cost_cap_discarded", pause_id: pause.id, agent: pause.agent, by: pause.decidedBy });
  mirrorEvent(home, opts?.runId ?? pause.runId, "cost_cap_discarded", { pause_id: pause.id, agent: pause.agent });
  return pause;
}

/**
 * 给 Agent.checkCost 用的回调工厂：每次用量上报后判一次分层上限。
 * 判定通过返回 null；超了先建暂停记录（同 agent 同层同月去重），再返回
 * 超限信息——Agent 收到后抛错中止运行。回调本身绝不抛错（暂停记录写不
 * 上也不拦中止，判定结论照常返回）。
 */
export function makeTieredCapCheck(
  home: string,
  agent: string,
  holder?: TieredCtxHolder,
): (runSpentUsd: number | null, runTokens: number) => { exceeded: boolean; message: string } | null {
  return (runSpentUsd, runTokens) => {
    let ev: TieredEvaluation;
    try {
      ev = evaluateTieredCaps(home, { agent, inProgressUsd: runSpentUsd, inProgressTokens: runTokens });
    } catch {
      return null;
    }
    if (ev.allowed) return null;
    try {
      pauseForCap(home, ev, { taskId: holder?.taskId ?? null, runId: holder?.runId ?? null });
    } catch { /* 暂停记录写不上不拦中止 */ }
    return { exceeded: true, message: tieredExceededMessage(ev) };
  };
}

// ---------------------------------------------------------------------------
// 审计导出（给 SIEM）：固定一种格式（JSONL），哈希链可验证
// ---------------------------------------------------------------------------

export interface AuditSource {
  file: string;
  label: string;
}

export const AUDIT_SOURCES: AuditSource[] = [
  { file: "governance-audit.jsonl", label: "governance" },
  { file: "sso-audit.jsonl", label: "sso" },
  { file: "accounts-audit.jsonl", label: "accounts" },
  { file: "business-redlines-audit.jsonl", label: "redlines" },
  { file: "soul-audit.jsonl", label: "soul" },
  // GROK-6：信任阶梯审计也是治理审计日志，进同一份 SIEM 导出。
  { file: "trust-ladder-audit.jsonl", label: "trust" },
  // 备用模型切换通知：每次真切换记一行模型切换审计，进同一份 SIEM 导出。
  { file: "model-switch-audit.jsonl", label: "model_switch" },
  // 缺口 27：渠道路由审计（每条入站的路由决定：routed/dropped + 绑定/规则/原因）也是治理审计日志，进同一份 SIEM 导出。
  { file: "bot-audit.jsonl", label: "bot" },
  // Pi Bot 借鉴第 1 条：脚本预授权审计（授权/撤销/使用/拒绝）也是治理审计日志，进同一份 SIEM 导出。
  { file: "script-preauth-audit.jsonl", label: "script_preauth" },
  // Pi Bot 借鉴第 2 条：交接契约验收审计（立约/挂包/验收/打回/停下/定夺/放弃）也是治理审计日志，进同一份 SIEM 导出。
  { file: "handover-contract-audit.jsonl", label: "handover_contract" },
];

/** 稳定序列化（键排序，递归）：同一条记录在任何机器上算出的哈希都一样。 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

function chainHash(prevHash: string, recordWithoutHash: Record<string, unknown>): string {
  return hashText(canonicalStringify({ ...recordWithoutHash, prev_hash: prevHash }));
}

function fileSha256(path: string): string | null {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
    return hashText(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export interface ExportAuditResult {
  lines: number;
  outPath: string | null;
  outHash: string;
  headerHash: string;
  text: string;
}

export interface ExportAuditOptions {
  from?: string | null;
  to?: string | null;
  sources?: string[] | null;
  out?: string | null;
  force?: boolean;
}

/**
 * 导出治理审计日志。格式：JSONL，第一行是 export_header（来源文件哈希 +
 * 策略/授权文件哈希，导出时点快照），之后每行一条审计记录，带 seq /
 * prev_hash / hash 哈希链。日期过滤按记录的 at 字段（没有 at 的行不过滤、
 * 照常导出）。导出本身写一条审计（在导出文件写完之后，所以导出文件里
 * 不含它自己那条——这是故意的，写进文档）。
 */
/**
 * 导出脱敏：审计行原文可能含绝对路径与密钥字段，导出前统一处理——
 * home 目录换成 [home]，其他用户路径前缀（/home/、/tmp/、/Users/、
 * /var/、/root/、/opt/ 下的绝对路径）换成 [path]，密钥样字段的值换成
 * <redacted>。只处理数据行，头部没有自由文本不处理。哈希链在脱敏后
 * 的行上算，verify 按导出文本重算，两边一致。
 */
const SECRET_KEY_RE = /key|token|secret|password|passwd|credential|auth|bearer/i;
const USER_PATH_RE = /(^|[\s"'=:(])(\/(?:home|tmp|Users|var|root|opt)\/[^\s"'},]*)/g;

function scrubExportValue(value: unknown, home: string): unknown {
  if (typeof value === "string") {
    const withoutHome = value.split(home).join("[home]");
    return withoutHome.replace(USER_PATH_RE, "$1[path]");
  }
  if (Array.isArray(value)) return value.map((v) => scrubExportValue(v, home));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "<redacted>" : scrubExportValue(v, home);
    }
    return out;
  }
  return value;
}

export function exportAudit(home: string, opts: ExportAuditOptions = {}): ExportAuditResult {
  const resolvedHome = resolveHome(home);
  const from = opts.from ? new Date(`${opts.from}T00:00:00.000Z`).getTime() : null;
  const to = opts.to ? new Date(`${opts.to}T23:59:59.999Z`).getTime() : null;
  if (opts.from && Number.isNaN(from)) throw new CostCapsError(`--from 日期无效：${opts.from}（应为 YYYY-MM-DD）`);
  if (opts.to && Number.isNaN(to)) throw new CostCapsError(`--to 日期无效：${opts.to}（应为 YYYY-MM-DD）`);
  const wanted = opts.sources && opts.sources.length > 0
    ? AUDIT_SOURCES.filter((s) => opts.sources!.includes(s.label))
    : AUDIT_SOURCES;
  for (const label of opts.sources ?? []) {
    if (!AUDIT_SOURCES.some((s) => s.label === label)) throw new CostCapsError(`审计来源无效：${label}（应为 ${AUDIT_SOURCES.map((s) => s.label).join("、")}）`);
  }
  const inRange = (rec: Record<string, unknown>): boolean => {
    if (from === null && to === null) return true;
    const at = typeof rec.at === "string" ? new Date(rec.at).getTime() : NaN;
    if (Number.isNaN(at)) return true;
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    return true;
  };
  const sourceInfos: { file: string; label: string; sha256: string | null; lines: number; skippedBad: number }[] = [];
  const records: Record<string, unknown>[] = [];
  for (const src of wanted) {
    const path = join(resolvedHome, src.file);
    let lines = 0;
    let skippedBad = 0;
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          if (!rec || typeof rec !== "object") { skippedBad += 1; continue; }
          if (!inRange(rec)) continue;
          lines += 1;
          records.push({ ...rec, _source: src.label });
        } catch {
          skippedBad += 1;
        }
      }
    }
    sourceInfos.push({ file: src.file, label: src.label, sha256: fileSha256(path), lines, skippedBad });
  }
  // 策略与授权文件只记哈希（导出时点的快照，证明导出时策略是哪个版本）。
  const policyHash = fileSha256(join(resolvedHome, "governance-policy.json"));
  const mandateHash = fileSha256(join(resolvedHome, "governance-mandates.json"));
  const headerWithoutHash: Record<string, unknown> = {
    type: "export_header",
    version: 1,
    format: "nyra-audit-export/1",
    exported_at: nowIso(),
    sources: sourceInfos,
    policy: { file: "governance-policy.json", sha256: policyHash },
    mandates: { file: "governance-mandates.json", sha256: mandateHash },
  };
  const headerHash = chainHash("0".repeat(64), headerWithoutHash);
  const outLines: string[] = [JSON.stringify({ ...headerWithoutHash, prev_hash: "0".repeat(64), hash: headerHash })];
  let prevHash = headerHash;
  let seq = 0;
  for (const rec of records) {
    seq += 1;
    const { _source, ...fields } = rec;
    // 导出边界脱敏：绝对路径与密钥字段不进导出文件（见 scrubExportValue）。
    const scrubbed = scrubExportValue(fields, resolvedHome) as Record<string, unknown>;
    const row: Record<string, unknown> = { seq, source: _source, ...scrubbed };
    delete row.hash;
    delete row.prev_hash;
    const hash = chainHash(prevHash, row);
    outLines.push(JSON.stringify({ ...row, prev_hash: prevHash, hash }));
    prevHash = hash;
  }
  const text = outLines.join("\n") + "\n";
  const outHash = hashText(text);
  let outPath: string | null = null;
  if (opts.out) {
    outPath = resolve(opts.out);
    if (existsSync(outPath) && !opts.force) throw new CostCapsError(`导出目标已存在：${outPath}（加 --force 覆盖，或换个路径）`);
    if (existsSync(outPath) && lstatSync(outPath).isSymbolicLink()) throw new CostCapsError(`导出目标不能是符号链接：${outPath}`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, { mode: 0o600 });
  }
  appendCostCapsAudit(home, {
    action: "audit_exported", lines: seq, out_hash: outHash.slice(0, 12),
    sources: wanted.map((s) => s.label).join(","),
  });
  // 注意：导出没有运行上下文，所以不镜像运行事件——governance-audit.jsonl
  // 里那条 audit_exported 就是审计记录本身。
  return { lines: seq, outPath, outHash, headerHash, text };
}

export interface VerifyAuditResult {
  ok: boolean;
  lines: number;
  firstError: string | null;
  sourceWarnings: string[];
}

/**
 * 验一条导出的审计文件：头部哈希、每行的 seq 连续、prev_hash 衔接、
 * hash 重算。四项全过才算 ok；第一处断裂就停并报 seq。来源文件漂移
 * （导出后又追加了行）只记 warning，不判失败——追加是正常的，链断了
 * 才是篡改。
 */
export function verifyAuditFile(home: string, path: string): VerifyAuditResult {
  const warnings: string[] = [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return { ok: false, lines: 0, firstError: `读不到导出文件：${path}`, sourceWarnings: warnings };
  }
  if (lines.length === 0) return { ok: false, lines: 0, firstError: "导出文件是空的", sourceWarnings: warnings };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]) as Record<string, unknown>;
  } catch {
    return { ok: false, lines: 0, firstError: "第 1 行（头部）不是合法 JSON", sourceWarnings: warnings };
  }
  if (header.type !== "export_header" || header.format !== "nyra-audit-export/1") {
    return { ok: false, lines: 0, firstError: "第 1 行不是 nyra-audit-export/1 的头部", sourceWarnings: warnings };
  }
  const { hash: headerHash, prev_hash: headerPrev, ...headerRest } = header;
  if (headerPrev !== "0".repeat(64)) return { ok: false, lines: 0, firstError: "头部 prev_hash 不是 64 个 0", sourceWarnings: warnings };
  if (typeof headerHash !== "string" || chainHash("0".repeat(64), headerRest) !== headerHash) {
    return { ok: false, lines: 0, firstError: "头部哈希对不上（头部被改过）", sourceWarnings: warnings };
  }
  let prevHash = headerHash as string;
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, lines: i - 1, firstError: `第 ${lineNo} 行不是合法 JSON`, sourceWarnings: warnings };
    }
    if (row.seq !== i) return { ok: false, lines: i - 1, firstError: `第 ${lineNo} 行 seq 应为 ${i}，实际是 ${JSON.stringify(row.seq)}`, sourceWarnings: warnings };
    if (row.prev_hash !== prevHash) return { ok: false, lines: i - 1, firstError: `第 ${lineNo} 行 prev_hash 与上一行 hash 衔接不上`, sourceWarnings: warnings };
    const { hash, prev_hash, ...rest } = row;
    if (typeof hash !== "string" || chainHash(prevHash, rest) !== hash) {
      return { ok: false, lines: i - 1, firstError: `第 ${lineNo} 行 hash 对不上（该行被改过）`, sourceWarnings: warnings };
    }
    prevHash = hash as string;
  }
  // 来源漂移只警告：导出后审计又追加是正常的；行数少了才是问题。
  const sources = Array.isArray(header.sources) ? header.sources as { file: string; lines: number }[] : [];
  for (const s of sources) {
    if (!s || typeof s.file !== "string") continue;
    const p = join(resolveHome(home), s.file);
    if (!existsSync(p)) { warnings.push(`${s.file} 现在找不到了（导出后被删？）`); continue; }
    const now = readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).length;
    if (now < s.lines) warnings.push(`${s.file} 现在只有 ${now} 行，导出时有 ${s.lines} 行（被截断过？）`);
  }
  return { ok: true, lines: lines.length - 1, firstError: null, sourceWarnings: warnings };
}

// ---------------------------------------------------------------------------
// CLI：nyra governance caps <...> / nyra governance audit <...>
// ---------------------------------------------------------------------------

function getFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function getAllFlags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === name) out.push(args[i + 1]);
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function money(v: number | null): string {
  return v === null ? "不限" : `$${v.toFixed(2)}`;
}

function tokens(v: number | null): string {
  return v === null ? "不限" : v.toLocaleString("en-US");
}

function printCap(cap: CostCap): void {
  console.log(`${cap.scope}：美元 ${money(cap.monthUsd)}，token ${tokens(cap.monthTokens)}（${cap.setBy}，${cap.setAt}，${cap.reason}）`);
}

function printEvaluation(ev: TieredEvaluation): void {
  console.log(`分层判定（${ev.month}，agent ${ev.agent}）：${ev.allowed ? "通过" : "已超限"}`);
  for (const l of ev.layers) {
    const usd = l.capUsd === null ? "美元不限" : `美元 $${l.spentUsd.toFixed(4)} / ${money(l.capUsd)}${l.usdKnown ? "" : "（算不出，不判）"}`;
    const tok = l.capTokens === null ? "token 不限" : `token ${l.spentTokens.toLocaleString("en-US")} / ${tokens(l.capTokens)}`;
    console.log(`  ${l.scope}：${usd}；${tok}${l.exceeded ? ` ← 超限（${l.binding}）` : ""}`);
  }
  if (ev.unattributedUsd > 0 || ev.unattributedTokens > 0) {
    console.log(`  未归属：$${ev.unattributedUsd.toFixed(4)} / ${ev.unattributedTokens.toLocaleString("en-US")} token（分层数是下界；MCP 花费只在组织级计入）`);
  }
  if (!ev.allowed) console.log(`  ${ev.bindingReason}`);
}

function parseUsdFlag(args: string[], name: string, nullName: string): number | null | undefined {
  if (hasFlag(args, nullName)) return null;
  const raw = getFlag(args, name);
  if (raw === null) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new CostCapsError(`${name} 必须是 ≥ 0 的数字`);
  return v;
}

function parseTokensFlag(args: string[], name: string, nullName: string): number | null | undefined {
  if (hasFlag(args, nullName)) return null;
  const raw = getFlag(args, name);
  if (raw === null) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new CostCapsError(`${name} 必须是非负整数`);
  return v;
}

export function handleCaps(args: string[], home: string): number {
  const [sub, ...rest] = args;
  const json = hasFlag(args, "--json");
  if (!sub) {
    console.log("用法：nyra governance caps <set|list|show|check|assign-team|pause|resume|discard|pauses> ...（详见 docs/governance.md）");
    return 0;
  }
  if (sub === "set") {
    const scope = getFlag(rest, "--scope");
    if (!scope) throw new CostCapsError("用法：nyra governance caps set --scope <范围> [--usd <美元>|--usd-null] [--tokens <数>|--tokens-null] --reason <原因>");
    const reason = getFlag(rest, "--reason");
    if (!reason) throw new CostCapsError("设上限须写原因：--reason <原因>");
    const monthUsd = parseUsdFlag(rest, "--usd", "--usd-null");
    const monthTokens = parseTokensFlag(rest, "--tokens", "--tokens-null");
    if (monthUsd === undefined && monthTokens === undefined) throw new CostCapsError("至少给一项：--usd 或 --tokens（--usd-null / --tokens-null 是取消该项）");
    const cap = setCap(home, scope, { monthUsd, monthTokens, by: getFlag(rest, "--by") ?? undefined, reason });
    if (cap === null) console.log(`已删掉 ${scope} 层的上限（放宽，已进证据链）`);
    else {
      console.log(`上限已设：${cap.scope}：美元 ${money(cap.monthUsd)}，token ${tokens(cap.monthTokens)}`);
      const rel = listRelaxations(home).filter((r) => r.scope === scope);
      if (rel.length > 0 && rel[0].at >= cap.setAt) console.log("  注意：这次是放宽（上限抬高或取消），已记进证据链。");
    }
    return 0;
  }
  if (sub === "list") {
    const caps = listCaps(home);
    const store = loadCapsStore(home);
    if (json) {
      printJson({ caps, agentTeams: store.agentTeams, relaxations: store.relaxations.length });
    } else if (caps.length === 0 && Object.keys(store.agentTeams).length === 0) {
      console.log("还没设过分层上限（组织级上限是月度硬顶，见 nyra cost --show）");
    } else {
      for (const c of caps) printCap(c);
      for (const [a, t] of Object.entries(store.agentTeams)) console.log(`agent ${a} → 团队 ${t}`);
      console.log(`放宽记录 ${store.relaxations.length} 条（nyra governance caps relaxations 未单列，见账本 cost-caps.json）`);
    }
    return 0;
  }
  if (sub === "show") {
    const scope = getFlag(rest, "--scope");
    if (!scope) throw new CostCapsError("用法：nyra governance caps show --scope <范围>");
    const cap = getCap(home, scope);
    if (!cap) {
      console.log(`${scope} 层没设上限`);
      return 0;
    }
    if (json) printJson(cap);
    else printCap(cap);
    return 0;
  }
  if (sub === "check") {
    const agent = getFlag(rest, "--agent");
    if (!agent) throw new CostCapsError("用法：nyra governance caps check --agent <id> [--account <id>] [--role <owner|user>]");
    const ev = evaluateTieredCaps(home, {
      agent,
      accountId: getFlag(rest, "--account") ?? undefined,
      role: getFlag(rest, "--role") ?? undefined,
    });
    if (json) printJson(ev);
    else printEvaluation(ev);
    return ev.allowed ? 0 : 2;
  }
  if (sub === "assign-team") {
    const agent = getFlag(rest, "--agent");
    if (!agent) throw new CostCapsError("用法：nyra governance caps assign-team --agent <id> --team <团队 id> 或 --clear");
    const team = hasFlag(rest, "--clear") ? null : getFlag(rest, "--team");
    if (team === null && !hasFlag(rest, "--clear")) throw new CostCapsError("须给 --team <团队 id> 或 --clear");
    assignTeam(home, agent, team, getFlag(rest, "--by") ?? undefined);
    console.log(team === null ? `agent ${agent} 已解除团队归属` : `agent ${agent} 已归属团队 ${team}`);
    return 0;
  }
  if (sub === "pause") {
    const agent = getFlag(rest, "--agent");
    if (!agent) throw new CostCapsError("用法：nyra governance caps pause --agent <id> [--task <任务 id>] [--run <运行 id>] --reason <原因>");
    const reason = getFlag(rest, "--reason");
    if (!reason) throw new CostCapsError("手动暂停须写原因：--reason <原因>");
    const ev = evaluateTieredCaps(home, { agent });
    const pause = pauseForCap(home, ev, {
      taskId: getFlag(rest, "--task") ?? undefined,
      runId: getFlag(rest, "--run") ?? undefined,
    });
    console.log(`暂停记录 ${pause.id}（agent ${agent}，检查点：${pause.checkpointRef ?? "无（agent + 月份）"}）`);
    console.log(`  恢复：nyra governance caps resume ${pause.id} --yes（先重判上限，还超就拒绝）`);
    return 0;
  }
  if (sub === "resume" || sub === "discard") {
    const id = rest[0];
    if (!id) throw new CostCapsError(`用法：nyra governance caps ${sub} <暂停 id> --yes`);
    if (!hasFlag(rest, "--yes")) {
      console.log(`${sub === "resume" ? "恢复" : "放弃"}暂停 ${id}：确认请加 --yes。`);
      return 2;
    }
    const pause = sub === "resume" ? resumePause(home, id, "cli") : discardPause(home, id, "cli");
    console.log(`暂停 ${pause.id} 已标为 ${pause.status}${pause.status === "resumed" && pause.taskId ? "（任务板任务已回队列）" : ""}`);
    return 0;
  }
  if (sub === "pauses") {
    const status = getFlag(rest, "--status") as CostPause["status"] | null;
    const agent = getFlag(rest, "--agent") ?? undefined;
    const rows = listPauses(home, { status: status ?? undefined, agent });
    if (json) {
      printJson(rows);
    } else if (rows.length === 0) {
      console.log("没有暂停记录");
    } else {
      for (const p of rows) {
        console.log(`${p.id} ${p.status} agent ${p.agent} ${p.scope}（上限 ${money(p.capUsd)} / ${tokens(p.capTokens)}，当时已花 $${p.spentUsd.toFixed(4)} / ${p.spentTokens.toLocaleString("en-US")} token，${p.at}）${p.taskId ? ` 任务 ${p.taskId}` : ""}${p.runId ? ` 运行 ${p.runId}` : ""}`);
      }
    }
    return 0;
  }
  throw new CostCapsError("用法：nyra governance caps <set|list|show|check|assign-team|pause|resume|discard|pauses> ...");
}

export function handleAudit(args: string[], home: string): number {
  const [sub, ...rest] = args;
  const json = hasFlag(args, "--json");
  if (!sub) {
    console.log("用法：nyra governance audit <export|verify> ...（详见 docs/governance.md）");
    return 0;
  }
  if (sub === "export") {
    const result = exportAudit(home, {
      from: getFlag(rest, "--from") ?? undefined,
      to: getFlag(rest, "--to") ?? undefined,
      sources: getAllFlags(rest, "--source").length > 0 ? getAllFlags(rest, "--source") : undefined,
      out: getFlag(rest, "--out") ?? undefined,
      force: hasFlag(rest, "--force"),
    });
    if (result.outPath) {
      console.log(`已导出 ${result.lines} 条审计记录 → ${result.outPath}（哈希链头部 ${result.headerHash.slice(0, 12)}，文件哈希 ${result.outHash.slice(0, 12)}）`);
      console.log("  验：nyra governance audit verify <文件>");
    } else {
      process.stdout.write(result.text);
      process.stderr.write(`已导出 ${result.lines} 条审计记录（哈希链头部 ${result.headerHash.slice(0, 12)}）。\n`);
    }
    if (json && result.outPath) printJson({ lines: result.lines, out: result.outPath, outHash: result.outHash, headerHash: result.headerHash });
    return 0;
  }
  if (sub === "verify") {
    const file = rest[0];
    if (!file) throw new CostCapsError("用法：nyra governance audit verify <导出文件>");
    const result = verifyAuditFile(home, resolve(file));
    if (json) {
      printJson(result);
    } else if (result.ok) {
      console.log(`验链通过：${result.lines} 条记录，哈希链完整。`);
      for (const w of result.sourceWarnings) console.log(`  警告：${w}`);
    } else {
      console.log(`验链失败：${result.firstError}`);
      return 2;
    }
    return result.ok ? 0 : 2;
  }
  throw new CostCapsError("用法：nyra governance audit <export|verify> ...");
}
