// src/governance.ts — 缺口 43 企业治理控制面（第一批：DSH-1 + DSH-2 + G-4 的治理部分）。
//
//   - DSH-1：版本化 Policy + 不可变 Mandate。Policy 每次改动算一个版本哈希；
//     Mandate 绑定发布时的 Policy 版本与哈希，不可变；恢复/续跑前按当前 Policy
//     重验证，冲突就拒绝、没冲突就换发新授权（旧授权标 superseded）；
//     Policy 发布时通知受影响的工单（任务板上未终态的任务）。
//   - DSH-2：observe / auto 两档 + “would accept”干跑。Bot 主动工作默认 observe，
//     评估通过只记干跑记录不真干；人看过记录没问题再显式切 auto；切 auto 之前
//     先套分层每日上限（已触顶就不接）。月度限额已移除（2026-11-27），
//     这里不再有月度硬顶门。
//   - G-4 的治理部分：自优化环的提议账本见 src/optimizer.ts；这里只提供
//     提议生效前的人批口径（提议须人批，见 optimizer 的 approve）与
//     审计链（governance-audit.jsonl + 运行事件镜像）。
//
// 护城河：
//   - 账本全部原子写 0600，损坏先备份再抛错、不静默重建；
//   - 规则写坏了直接拒绝发布（parseRules 的 warnings 非空就抛错），不静默丢规则；
//   - 授权冲突 / 撤销 / 不存在时，续跑与恢复一律拒绝（fail-closed），不放行；
//   - 分层每日上限没配就不挡人，配了就硬停；
//   - 事件里只记指纹（SHA-256 前 12 位）与 id，不记原文、不记绝对路径。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { SOUL_AGENT_ID_RE } from "./soul.ts";
import { parseRules, evaluate, type RuleSet } from "./permissionRules.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { businessActionForTool, resolveRedlineTier } from "./businessRedlines.ts";
import { listKanbanTasks } from "./kanban.ts";
import { appendInbox } from "./tasks.ts";
import { evaluateTieredCaps, handleCaps, handleAudit } from "./costCaps.ts";
// G-P2-2：准入账本（admission.ts 是叶模块，只引 node 内置，无循环）。
import { recordAdmission } from "./admission.ts";

export class GovernanceError extends Error {}

const POLICY_FILE = "governance-policy.json";
const MANDATE_FILE = "governance-mandates.json";
const MODE_FILE = "governance-modes.json";
const DRY_RUN_FILE = "dry-runs.jsonl";
const AUDIT_FILE = "governance-audit.jsonl";

const MAX_REASON_CHARS = 300;
const MAX_SCOPE_CHARS = 120;
const MAX_HISTORY = 50;

export type MandateStrength = "observe" | "auto";
export type MandateStatus = "active" | "superseded" | "revoked";
export type MandateChannel = "cli" | "telegram" | "discord" | "api" | "gateway";
export type AgentMode = "observe" | "auto";
export type DryRunStatus = "recorded" | "promoted" | "discarded";

export interface PolicyRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface PolicyVersion {
  version: number;
  hash: string;
  createdAt: string;
  createdBy: string;
  reason: string;
  scope: string;
  rules: PolicyRules;
}

export interface PolicyStore {
  version: 1;
  current: PolicyVersion | null;
  history: PolicyVersion[];
}

export interface Mandate {
  id: string;
  scope: string;
  strength: MandateStrength;
  rules: PolicyRules;
  issuer: string;
  channel: MandateChannel;
  policyVersion: number;
  policyHash: string;
  status: MandateStatus;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MandateStore {
  version: 1;
  mandates: Mandate[];
}

export interface ModeStore {
  version: 1;
  modes: Record<string, { mode: AgentMode; updatedAt: string; updatedBy: string }>;
}

export interface DryRun {
  id: string;
  at: string;
  agent: string;
  kind: string;
  action: string;
  target: string;
  reason: string;
  estimatedCostUsd: number | null;
  status: DryRunStatus;
  decidedBy: string | null;
  decidedAt: string | null;
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

function newMandateId(): string {
  return `md_${randomBytes(6).toString("hex")}`;
}

function newDryRunId(): string {
  return `dr_${randomBytes(6).toString("hex")}`;
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
    throw new GovernanceError(`${file} 不能是符号链接`);
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
  if (lstatSync(path).isSymbolicLink()) throw new GovernanceError(`${file} 不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new GovernanceError(`${file} 损坏，已备份，请检查后恢复`);
  }
  if (!validate(raw)) {
    backupCorrupt(path);
    throw new GovernanceError(`${file} 格式无效，已备份`);
  }
  return raw;
}

function isPolicyStore(raw: unknown): raw is PolicyStore {
  return !!raw && typeof raw === "object" && (raw as PolicyStore).version === 1 &&
    ("current" in (raw as PolicyStore)) && Array.isArray((raw as PolicyStore).history);
}

function isMandateStore(raw: unknown): raw is MandateStore {
  return !!raw && typeof raw === "object" && (raw as MandateStore).version === 1 &&
    Array.isArray((raw as MandateStore).mandates);
}

function isModeStore(raw: unknown): raw is ModeStore {
  return !!raw && typeof raw === "object" && (raw as ModeStore).version === 1 &&
    typeof (raw as ModeStore).modes === "object" && (raw as ModeStore).modes !== null;
}

export function loadPolicyStore(home: string): PolicyStore {
  return loadJson(home, POLICY_FILE, { version: 1, current: null, history: [] } as PolicyStore, isPolicyStore);
}

export function loadMandateStore(home: string): MandateStore {
  return loadJson(home, MANDATE_FILE, { version: 1, mandates: [] } as MandateStore, isMandateStore);
}

export function loadModeStore(home: string): ModeStore {
  return loadJson(home, MODE_FILE, { version: 1, modes: {} } as ModeStore, isModeStore);
}

export function policyPath(home: string): string {
  return join(resolveHome(home), POLICY_FILE);
}

export function mandatePath(home: string): string {
  return join(resolveHome(home), MANDATE_FILE);
}

/** 审计链：append-only jsonl，0600。写失败不抛错（审计丢了不该拦住正事），但返回 false。 */
export function appendGovernanceAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(resolveHome(home), AUDIT_FILE);
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

/** O2：部署级审计的动作（部署/升级/回滚）。 */
export type DeploymentAction = "deploy" | "upgrade" | "rollback";

/**
 * O2：记一条部署级审计——部署配置变更、升级、回滚都进同一本治理审计账本，
 * 只加 `scope: "deployment"` 区分（不另起一套账本；组织级事件 scope 为
 * "org" 或不填）。密钥轮换、成员变动这类事件也走这里（action 写
 * "key_rotated"/"member_changed" 时 kind 仍为 deployment，由调用方传）。
 * 返回 false 表示写盘失败（不抛错，不破坏部署流程本身）。
 */
export function appendDeploymentAudit(
  home: string,
  entry: { action: string; note: string; actor?: string },
): boolean {
  const note = entry.note.trim().slice(0, MAX_REASON_CHARS);
  if (!note) return false;
  return appendGovernanceAudit(home, {
    kind: "deployment",
    scope: "deployment",
    action: entry.action,
    note,
    actor: entry.actor ?? "owner",
  });
}

export interface DeploymentAuditEntry {
  at: string;
  action: string;
  note: string;
  actor: string;
}

/** O2：读回部署级审计（治理审计账本里 scope 为 deployment 的行）。 */
export function listDeploymentAudit(home: string): DeploymentAuditEntry[] {
  const path = join(resolveHome(home), AUDIT_FILE);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return [];
  const out: DeploymentAuditEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (!rec || typeof rec !== "object" || rec.scope !== "deployment") continue;
      out.push({
        at: typeof rec.at === "string" ? rec.at : "",
        action: typeof rec.action === "string" ? rec.action : "",
        note: typeof rec.note === "string" ? rec.note : "",
        actor: typeof rec.actor === "string" ? rec.actor : "",
      });
    } catch {
      continue;
    }
  }
  return out;
}

/** 有运行上下文时，把治理事件镜像进运行事件（tasks 目录优先，runs 次之）。 */
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

function validateRules(rules: PolicyRules): RuleSet {
  const parsed = parseRules(rules);
  if (parsed.warnings.length > 0) {
    throw new GovernanceError(`规则写坏了，拒绝发布：${parsed.warnings.join("；")}`);
  }
  return parsed;
}

function rulesToText(rules: PolicyRules): PolicyRules {
  return {
    allow: [...rules.allow],
    ask: [...rules.ask],
    deny: [...rules.deny],
  };
}

/** Policy 版本哈希：版本号 + 范围 + 三档规则（排序后）算 SHA-256。 */
export function policyHash(version: number, scope: string, rules: PolicyRules): string {
  const canonical = JSON.stringify({
    version,
    scope,
    rules: {
      allow: [...rules.allow].sort(),
      ask: [...rules.ask].sort(),
      deny: [...rules.deny].sort(),
    },
  });
  return hashText(canonical);
}

function ensureDefaultPolicy(home: string): PolicyVersion {
  const store = loadPolicyStore(home);
  if (store.current) return store.current;
  const rules: PolicyRules = { allow: [], ask: [], deny: [] };
  const version = 1;
  const policy: PolicyVersion = {
    version,
    hash: policyHash(version, "global", rules),
    createdAt: nowIso(),
    createdBy: "system",
    reason: "初始默认策略（空规则：只走红线表与默认审批流程）",
    scope: "global",
    rules,
  };
  store.current = policy;
  saveJsonAtomic(home, POLICY_FILE, store);
  appendGovernanceAudit(home, { action: "policy_created", policy_version: version, hash: policy.hash.slice(0, 12) });
  return policy;
}

// ---------------------------------------------------------------------------
// DSH-1：版本化 Policy
// ---------------------------------------------------------------------------

export interface PublishPolicyResult {
  policy: PolicyVersion;
  affectedMandates: string[];
  affectedTasks: string[];
  notifyError: string | null;
}

export function publishPolicy(
  home: string,
  opts: { rules?: PolicyRules | null; scope?: string; reason: string; createdBy?: string; runId?: string | null },
): PublishPolicyResult {
  const reason = (opts.reason ?? "").trim();
  if (!reason) throw new GovernanceError("发布策略须写原因（--reason）");
  if (reason.length > MAX_REASON_CHARS) throw new GovernanceError(`原因过长（超过 ${MAX_REASON_CHARS} 字符）`);
  const scope = (opts.scope ?? "global").trim() || "global";
  if (scope.length > MAX_SCOPE_CHARS) throw new GovernanceError(`范围过长（超过 ${MAX_SCOPE_CHARS} 字符）`);
  const store = loadPolicyStore(home);
  const rules = opts.rules ? rulesToText(opts.rules) : (store.current ? rulesToText(store.current.rules) : { allow: [], ask: [], deny: [] });
  validateRules(rules);
  const version = (store.current?.version ?? 0) + 1;
  const policy: PolicyVersion = {
    version,
    hash: policyHash(version, scope, rules),
    createdAt: nowIso(),
    createdBy: (opts.createdBy ?? "cli").trim() || "cli",
    reason,
    scope,
    rules,
  };
  const oldVersion = store.current?.version ?? 0;
  if (store.current) {
    store.history.unshift(store.current);
    if (store.history.length > MAX_HISTORY) store.history.length = MAX_HISTORY;
  }
  store.current = policy;
  saveJsonAtomic(home, POLICY_FILE, store);
  appendGovernanceAudit(home, {
    action: "policy_published", policy_version: version, hash: policy.hash.slice(0, 12),
    old_policy_version: oldVersion, reason_hash: shortHash(reason), scope,
  });
  mirrorEvent(home, opts.runId ?? null, "policy_changed", {
    policy_version: version, hash: policy.hash.slice(0, 12), reason_hash: shortHash(reason),
  });
  // G-P2-2：策略变更记进统一准入账本（只记版本、哈希与范围，不记原因原文）。
  recordAdmission(home, {
    kind: "policy_changed", actor: policy.createdBy, subject: scope,
    policy_version: version, old_policy_version: oldVersion, policy_hash: policy.hash.slice(0, 12),
    detail: `v${oldVersion} → v${version}`,
  });

  // 通知受影响的工单：仍在 active、绑定旧版本 Policy 的授权所覆盖的任务。
  const mandateStore = loadMandateStore(home);
  const affected = mandateStore.mandates.filter((m) => m.status === "active" && m.policyVersion < version);
  const affectedMandates = affected.map((m) => m.id);
  const coveredAgents = new Set<string>();
  let coversAll = false;
  for (const m of affected) {
    if (m.scope === "global") { coversAll = true; break; }
    const agentMatch = /^agent:([a-z][a-z0-9_-]{0,31})$/.exec(m.scope);
    if (agentMatch) coveredAgents.add(agentMatch[1]);
  }
  let affectedTasks: string[] = [];
  let notifyError: string | null = null;
  try {
    const tasks = listKanbanTasks(home);
    affectedTasks = tasks
      .filter((t) => ["queued", "working", "review"].includes(t.status))
      .filter((t) => coversAll || (t.agent !== null && coveredAgents.has(t.agent)))
      .map((t) => t.id);
    if (affectedMandates.length > 0) {
      appendInbox(
        "governance",
        "policy_changed",
        `策略已发布 v${version}（${policy.hash.slice(0, 12)}）：${affectedMandates.length} 个授权待重验证（${affectedMandates.join("、")}），${affectedTasks.length} 个工单受影响。`,
        home,
      );
    }
  } catch (e) {
    notifyError = e instanceof Error ? e.message : String(e);
  }
  return { policy, affectedMandates, affectedTasks, notifyError };
}

export function getCurrentPolicy(home: string): PolicyVersion {
  return ensureDefaultPolicy(home);
}

// ---------------------------------------------------------------------------
// DSH-1：不可变 Mandate
// ---------------------------------------------------------------------------

export function issueMandate(
  home: string,
  opts: { scope: string; strength?: MandateStrength; rules?: PolicyRules | null; issuer: string; channel?: MandateChannel; runId?: string | null },
): Mandate {
  const scope = (opts.scope ?? "").trim();
  if (!scope) throw new GovernanceError("授权须写范围（--scope，例如 agent:nyra 或 global）");
  if (scope.length > MAX_SCOPE_CHARS) throw new GovernanceError(`范围过长（超过 ${MAX_SCOPE_CHARS} 字符）`);
  const strength = opts.strength ?? "observe";
  if (strength !== "observe" && strength !== "auto") throw new GovernanceError("授权强度只能是 observe 或 auto");
  const channel = opts.channel ?? "cli";
  if (!["cli", "telegram", "discord", "api", "gateway"].includes(channel)) throw new GovernanceError("授权接收方式无效");
  const issuer = (opts.issuer ?? "").trim();
  if (!issuer) throw new GovernanceError("授权须写发送者身份（--issuer）");
  const rules = opts.rules ? rulesToText(opts.rules) : { allow: [], ask: [], deny: [] };
  validateRules(rules);
  const policy = ensureDefaultPolicy(home);
  const mandate: Mandate = {
    id: newMandateId(),
    scope,
    strength,
    rules,
    issuer,
    channel,
    policyVersion: policy.version,
    policyHash: policy.hash,
    status: "active",
    supersededBy: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const store = loadMandateStore(home);
  store.mandates.unshift(mandate);
  saveJsonAtomic(home, MANDATE_FILE, store);
  appendGovernanceAudit(home, {
    action: "mandate_issued", mandate_id: mandate.id, policy_version: policy.version,
    hash: policy.hash.slice(0, 12), scope, strength, channel,
  });
  mirrorEvent(home, opts.runId ?? null, "mandate_issued", {
    mandate_id: mandate.id, policy_version: policy.version, scope,
  });
  return mandate;
}

export function getMandate(home: string, id: string): Mandate {
  const store = loadMandateStore(home);
  const mandate = store.mandates.find((m) => m.id === id);
  if (!mandate) throw new GovernanceError(`找不到授权 ${id}`);
  return mandate;
}

export function listMandates(home: string, filter?: { status?: MandateStatus }): Mandate[] {
  const store = loadMandateStore(home);
  return store.mandates
    .filter((m) => !filter?.status || m.status === filter.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 授权里的规则与当前 Policy 的 deny 规则逐条对撞，返回冲突描述。 */
export function findMandateConflicts(policyRules: RuleSet, mandateRules: PolicyRules): string[] {
  const conflicts: string[] = [];
  const parsed = parseRules(mandateRules);
  for (const rule of [...parsed.allow, ...parsed.ask]) {
    const hit = evaluate(policyRules, { tool: rule.tool, target: rule.specifier ?? undefined });
    if (hit?.action === "deny") {
      conflicts.push(`授权允许 ${rule.raw}，但当前策略拒绝 ${hit.rule.raw}`);
    }
  }
  return conflicts;
}

export type RevalidateResult = "current" | "renewed" | "conflicted";

export interface RevalidateOutcome {
  mandate: Mandate;
  result: RevalidateResult;
  conflicts: string[];
  newMandateId: string | null;
}

/**
 * 按当前 Policy 重验证一个授权。
 *   - 已是当前版本 → current（原样返回）；
 *   - 旧版本且无冲突 → renewed（换发新授权，旧授权标 superseded）；
 *   - 旧版本且有冲突 → conflicted（原授权不动，调用方必须拒绝续跑/恢复）；
 *   - 已撤销 → 抛错；已 superseded → 顺着 supersededBy 链找到当前授权再验。
 */
export function revalidateMandate(home: string, id: string, opts?: { runId?: string | null }): RevalidateOutcome {
  const store = loadMandateStore(home);
  let mandate = store.mandates.find((m) => m.id === id);
  if (!mandate) throw new GovernanceError(`找不到授权 ${id}`);
  let hops = 0;
  while (mandate.status === "superseded" && mandate.supersededBy && hops < 10) {
    const next = store.mandates.find((m) => m.id === mandate!.supersededBy);
    if (!next) break;
    mandate = next;
    hops += 1;
  }
  if (mandate.status === "revoked") throw new GovernanceError(`授权 ${mandate.id} 已撤销，不能续跑或恢复，须重新签发`);
  const policy = ensureDefaultPolicy(home);
  const oldVersion = mandate.policyVersion;
  if (oldVersion === policy.version) {
    appendGovernanceAudit(home, { action: "mandate_revalidated", mandate_id: mandate.id, old_policy_version: oldVersion, new_policy_version: policy.version, result: "current" });
    mirrorEvent(home, opts?.runId ?? null, "mandate_revalidated", {
      mandate_id: mandate.id, old_policy_version: oldVersion, new_policy_version: policy.version, result: "current",
    });
    return { mandate, result: "current", conflicts: [], newMandateId: null };
  }
  const policyRules = parseRules(policy.rules);
  const conflicts = findMandateConflicts(policyRules, mandate.rules);
  if (conflicts.length > 0) {
    appendGovernanceAudit(home, { action: "mandate_revalidated", mandate_id: mandate.id, old_policy_version: oldVersion, new_policy_version: policy.version, result: "conflicted", conflicts: conflicts.length });
    mirrorEvent(home, opts?.runId ?? null, "mandate_revalidated", {
      mandate_id: mandate.id, old_policy_version: oldVersion, new_policy_version: policy.version, result: "conflicted",
    });
    return { mandate, result: "conflicted", conflicts, newMandateId: null };
  }
  const renewed: Mandate = {
    ...mandate,
    id: newMandateId(),
    policyVersion: policy.version,
    policyHash: policy.hash,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  mandate.status = "superseded";
  mandate.supersededBy = renewed.id;
  mandate.updatedAt = nowIso();
  store.mandates.unshift(renewed);
  saveJsonAtomic(home, MANDATE_FILE, store);
  appendGovernanceAudit(home, { action: "mandate_revalidated", mandate_id: mandate.id, old_policy_version: oldVersion, new_policy_version: policy.version, result: "renewed", new_mandate_id: renewed.id });
  appendGovernanceAudit(home, { action: "mandate_superseded", mandate_id: mandate.id, superseded_by: renewed.id });
  mirrorEvent(home, opts?.runId ?? null, "mandate_revalidated", {
    mandate_id: mandate.id, old_policy_version: oldVersion, new_policy_version: policy.version, result: "renewed",
  });
  mirrorEvent(home, opts?.runId ?? null, "mandate_superseded", { mandate_id: mandate.id, superseded_by: renewed.id });
  mirrorEvent(home, opts?.runId ?? null, "mandate_issued", {
    mandate_id: renewed.id, policy_version: policy.version, scope: renewed.scope,
  });
  return { mandate: renewed, result: "renewed", conflicts: [], newMandateId: renewed.id };
}

/**
 * 续跑/恢复前的重验证钩子：返回当前有效的授权 id。
 * 冲突、撤销、不存在时抛错——调用方必须拒绝续跑/恢复（fail-closed）。
 */
export function revalidateMandateForResume(home: string, mandateId: string): string {
  const outcome = revalidateMandate(home, mandateId);
  if (outcome.result === "conflicted") {
    throw new GovernanceError(`授权 ${mandateId} 与当前策略冲突，拒绝续跑/恢复：${outcome.conflicts.join("；")}`);
  }
  return outcome.mandate.id;
}

export function revokeMandate(home: string, id: string, reason: string, opts?: { runId?: string | null }): Mandate {
  const reasonText = (reason ?? "").trim();
  if (!reasonText) throw new GovernanceError("撤销授权须写原因（--reason）");
  if (reasonText.length > MAX_REASON_CHARS) throw new GovernanceError(`原因过长（超过 ${MAX_REASON_CHARS} 字符）`);
  const store = loadMandateStore(home);
  const mandate = store.mandates.find((m) => m.id === id);
  if (!mandate) throw new GovernanceError(`找不到授权 ${id}`);
  if (mandate.status === "revoked") throw new GovernanceError(`授权 ${id} 已撤销`);
  mandate.status = "revoked";
  mandate.updatedAt = nowIso();
  saveJsonAtomic(home, MANDATE_FILE, store);
  appendGovernanceAudit(home, { action: "mandate_revoked", mandate_id: id, reason_hash: shortHash(reasonText) });
  mirrorEvent(home, opts?.runId ?? null, "mandate_revoked", { mandate_id: id, reason_hash: shortHash(reasonText) });
  return mandate;
}

// ---------------------------------------------------------------------------
// DSH-2：observe / auto 两档
// ---------------------------------------------------------------------------

export function getAgentMode(home: string, agent: string): AgentMode {
  const store = loadModeStore(home);
  return store.modes[agent]?.mode ?? "observe";
}

export function setAgentMode(home: string, agent: string, mode: AgentMode, by: string, opts?: { runId?: string | null }): AgentMode {
  if (!SOUL_AGENT_ID_RE.test(agent)) throw new GovernanceError("agent 必须是小写字母开头的 agent id（小写字母/数字/_/-，最长 32 字）");
  if (mode !== "observe" && mode !== "auto") throw new GovernanceError("接单模式只能是 observe 或 auto");
  const store = loadModeStore(home);
  store.modes[agent] = { mode, updatedAt: nowIso(), updatedBy: (by ?? "cli").trim() || "cli" };
  saveJsonAtomic(home, MODE_FILE, store);
  appendGovernanceAudit(home, { action: "governance_mode_changed", agent, mode, by: store.modes[agent].updatedBy });
  mirrorEvent(home, opts?.runId ?? null, "governance_mode_changed", { agent, mode });
  return mode;
}

// ---------------------------------------------------------------------------
// DSH-2：干跑记录（“would accept”账本，只记、不执行）
// ---------------------------------------------------------------------------

export function recordDryRun(
  home: string,
  opts: { agent: string; kind: string; action: string; target: string; reason: string; estimatedCostUsd?: number | null },
): DryRun {
  const agent = (opts.agent ?? "").trim();
  if (!agent) throw new GovernanceError("干跑记录须写 agent");
  const kind = (opts.kind ?? "").trim();
  if (!kind) throw new GovernanceError("干跑记录须写类型（kind）");
  const action = (opts.action ?? "").trim();
  if (!action) throw new GovernanceError("干跑记录须写动作（action）");
  const target = (opts.target ?? "").trim();
  if (!target) throw new GovernanceError("干跑记录须写目标（target）");
  const reason = (opts.reason ?? "").trim().slice(0, 200);
  if (!reason) throw new GovernanceError("干跑记录须写原因（reason）");
  const path = join(resolveHome(home), DRY_RUN_FILE);
  const existing = listDryRuns(home);
  const dup = existing.find((d) => d.status === "recorded" && d.agent === agent && d.kind === kind && d.action === action && d.target === target);
  if (dup) return dup;
  const entry: DryRun = {
    id: newDryRunId(),
    at: nowIso(),
    agent,
    kind,
    action,
    target,
    reason,
    estimatedCostUsd: typeof opts.estimatedCostUsd === "number" && Number.isFinite(opts.estimatedCostUsd) ? opts.estimatedCostUsd : null,
    status: "recorded",
    decidedBy: null,
    decidedAt: null,
  };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new GovernanceError(`${DRY_RUN_FILE} 不能是符号链接`);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(entry) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  appendGovernanceAudit(home, { action: "dry_run_recorded", dry_run_id: entry.id, agent, kind, dry_run_action: action });
  return entry;
}

export function listDryRuns(home: string, filter?: { agent?: string; status?: DryRunStatus }): DryRun[] {
  const path = join(resolveHome(home), DRY_RUN_FILE);
  if (!existsSync(path)) return [];
  if (lstatSync(path).isSymbolicLink()) throw new GovernanceError(`${DRY_RUN_FILE} 不能是符号链接`);
  const out: DryRun[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DryRun;
      if (!row || typeof row !== "object" || typeof row.id !== "string") continue;
      if (filter?.agent && row.agent !== filter.agent) continue;
      if (filter?.status && row.status !== filter.status) continue;
      out.push(row);
    } catch { /* 坏行跳过，不拦住整本账 */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export function decideDryRun(home: string, id: string, decision: "promoted" | "discarded", by: string): DryRun {
  const path = join(resolveHome(home), DRY_RUN_FILE);
  const rows = listDryRuns(home);
  const row = rows.find((d) => d.id === id);
  if (!row) throw new GovernanceError(`找不到干跑记录 ${id}`);
  if (row.status !== "recorded") throw new GovernanceError(`干跑记录 ${id} 已是 ${row.status}，不能再定`);
  row.status = decision === "promoted" ? "promoted" : "discarded";
  row.decidedBy = (by ?? "cli").trim() || "cli";
  row.decidedAt = nowIso();
  const tmp = join(dirname(path), `.dry-runs-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    for (const r of rows) writeSync(fd, JSON.stringify(r) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  appendGovernanceAudit(home, { action: "dry_run_decided", dry_run_id: id, decision, by: row.decidedBy });
  return row;
}

// ---------------------------------------------------------------------------
// DSH-2：分层每日上限门（接单前先套；月度限额已移除）
// ---------------------------------------------------------------------------
export interface AutoAllowed {
  allowed: boolean;
  /** 本月已花（记账信息，不参与判定）。 */
  monthSpentUsd: number;
  reason: string;
}

/** auto 接单前的分层上限检查：没配上限就不挡人，配了且已触顶就拒绝。 */
export function checkAutoAllowed(home: string, _agent: string): AutoAllowed {
  const month = monthKeyString();
  const llm = new UsageLedger(home).monthTotal(month);
  const mcp = new McpCostTracker(home).monthTotalUsd(month);
  const spent = llm.spentUsd + mcp;
  // 缺口 43 第三批：分层上限（只剩 agent 每日层）。分层没配就不挡人，
  // 配了且已触顶同样不接单。
  try {
    const tiered = evaluateTieredCaps(home, { agent: _agent });
    if (!tiered.allowed) {
      return {
        allowed: false,
        monthSpentUsd: spent,
        reason: `分层成本上限已触顶（${tiered.bindingReason}），不接单`,
      };
    }
  } catch {
    // 分层判定本身出问题（账本损坏等）不拦接单。
  }
  return {
    allowed: true,
    monthSpentUsd: spent,
    reason: `本月已花 $${spent.toFixed(2)}（仅记账，分层每日上限未触顶）`,
  };
}

export interface ProactiveVerdict {
  decision: "would-accept" | "would-deny";
  reason: string;
  mode: AgentMode;
  requiresApproval: boolean;
  monthSpentUsd: number;
}

/**
 * DSH-2 的“would accept”评估：只判定，不执行。
 *   - 分层每日上限已触顶 → would-deny；
 *   - 工具命中红线表 never → would-deny；命中 approve 档 → would-accept 但 requiresApproval；
 *   - observe 模式 → would-accept（只记干跑，不真干）；
 *   - auto 模式 → would-accept（可执行，但仍受分层每日上限与审批约束）。
 */
export function evaluateProactiveAction(
  home: string,
  agent: string,
  action: { kind: string; target: string; tool?: string },
): ProactiveVerdict {
  const mode = getAgentMode(home, agent);
  const cap = checkAutoAllowed(home, agent);
  if (!cap.allowed) {
    return { decision: "would-deny", reason: cap.reason, mode, requiresApproval: false, monthSpentUsd: cap.monthSpentUsd };
  }
  let requiresApproval = false;
  if (action.tool) {
    const mapped = businessActionForTool(action.tool);
    if (mapped) {
      const tier = resolveRedlineTier(home, mapped.connector, mapped.action);
      if (tier === "never") {
        return { decision: "would-deny", reason: `红线表：${mapped.connector} ${mapped.action} 永不允许`, mode, requiresApproval: false, monthSpentUsd: cap.monthSpentUsd };
      }
      if (tier === "approve") requiresApproval = true;
    }
  }
  if (mode === "observe") {
    return {
      decision: "would-accept",
      reason: requiresApproval
        ? "observe 模式：评估通过，只记干跑，不真执行；且该动作须人批"
        : "observe 模式：评估通过，只记干跑，不真执行",
      mode,
      requiresApproval,
      monthSpentUsd: cap.monthSpentUsd,
    };
  }
  return {
    decision: "would-accept",
    reason: requiresApproval
      ? "auto 模式：评估通过，但该动作须人批，批了才执行"
      : "auto 模式：评估通过，可执行（仍受分层每日上限与审批约束）",
    mode,
    requiresApproval,
    monthSpentUsd: cap.monthSpentUsd,
  };
}

// ---------------------------------------------------------------------------
// CLI：nyra governance <policy|mandate|mode|dry-runs>
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

function collectRules(args: string[]): PolicyRules | null {
  const allow = getAllFlags(args, "--allow");
  const ask = getAllFlags(args, "--ask");
  const deny = getAllFlags(args, "--deny");
  if (allow.length === 0 && ask.length === 0 && deny.length === 0) return null;
  return { allow, ask, deny };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printPolicy(policy: PolicyVersion): void {
  console.log(`策略 v${policy.version}（${policy.hash.slice(0, 12)}）`);
  console.log(`  范围：${policy.scope}`);
  console.log(`  创建：${policy.createdAt}，${policy.createdBy}`);
  console.log(`  原因：${policy.reason}`);
  console.log(`  规则：allow ${policy.rules.allow.length} 条，ask ${policy.rules.ask.length} 条，deny ${policy.rules.deny.length} 条`);
  for (const r of policy.rules.allow) console.log(`    allow ${r}`);
  for (const r of policy.rules.ask) console.log(`    ask ${r}`);
  for (const r of policy.rules.deny) console.log(`    deny ${r}`);
}

function printMandate(mandate: Mandate): void {
  console.log(`授权 ${mandate.id}（${mandate.status}）`);
  console.log(`  范围：${mandate.scope}，强度：${mandate.strength}，接收方式：${mandate.channel}`);
  console.log(`  发送者：${mandate.issuer}`);
  console.log(`  绑定策略：v${mandate.policyVersion}（${mandate.policyHash.slice(0, 12)}）`);
  if (mandate.supersededBy) console.log(`  已被替代：${mandate.supersededBy}`);
  console.log(`  创建：${mandate.createdAt}，更新：${mandate.updatedAt}`);
  const rules = mandate.rules;
  if (rules.allow.length > 0 || rules.ask.length > 0 || rules.deny.length > 0) {
    for (const r of rules.allow) console.log(`    allow ${r}`);
    for (const r of rules.ask) console.log(`    ask ${r}`);
    for (const r of rules.deny) console.log(`    deny ${r}`);
  }
}

function handleDeploy(args: string[], home: string): number {
  const kind = getFlag(args, "--kind") ?? "deploy";
  if (kind !== "deploy" && kind !== "upgrade" && kind !== "rollback") {
    throw new GovernanceError("用法：nyra governance deploy <说明> [--kind deploy|upgrade|rollback]");
  }
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--kind") { i += 1; continue; }
    rest.push(args[i]!);
  }
  const note = rest.join(" ").trim();
  if (!note) throw new GovernanceError("用法：nyra governance deploy <说明> [--kind deploy|upgrade|rollback]（说明必填）");
  const ok = appendDeploymentAudit(home, { action: kind, note });
  if (!ok) throw new GovernanceError("部署审计写盘失败");
  console.log(`已记部署审计：${kind} —— ${note.slice(0, MAX_REASON_CHARS)}`);
  return 0;
}

function handleDeploymentAudit(args: string[], home: string): number {
  const json = hasFlag(args, "--json");
  const all = hasFlag(args, "--all");
  const entries = listDeploymentAudit(home);
  const shown = all ? entries : entries.slice(-20);
  if (json) {
    console.log(JSON.stringify({ entries: shown, total: entries.length }, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    console.log("暂无部署级审计记录（nyra governance deploy <说明> 记一笔）。");
    return 0;
  }
  console.log(`部署级审计（共 ${entries.length} 条${all ? "" : "，只看最近 20 条，加 --all 看全部"}）：`);
  for (const e of shown) {
    console.log(`- ${e.at} [${e.action}] ${e.note}（${e.actor}）`);
  }
  return 0;
}

export function handleGovernance(args: string[], home: string): number {
  const [group, ...rest] = args;
  const json = hasFlag(args, "--json");
  if (!group) {
    console.log("用法：nyra governance <policy|mandate|mode|dry-runs|caps|audit|deploy> ...（详见 docs/governance.md）");
    return 0;
  }

  // 缺口 43 第三批：分层成本上限与审计导出（见 src/costCaps.ts）。
  if (group === "caps") return handleCaps(rest, home);
  if (group === "audit") {
    // O2：部署级审计列表（治理审计账本里 scope 为 deployment 的行）。
    if (rest[0] === "deployment") return handleDeploymentAudit(rest.slice(1), home);
    return handleAudit(rest, home);
  }
  // O2：部署/升级/回滚记一笔部署级审计。
  if (group === "deploy") return handleDeploy(rest, home);

  if (group === "policy") {
    const sub = rest[0];
    if (sub === "publish") {
      const reason = getFlag(rest, "--reason");
      if (!reason) throw new GovernanceError("发布策略须写原因：--reason <原因>");
      const result = publishPolicy(home, {
        rules: collectRules(rest),
        scope: getFlag(rest, "--scope") ?? undefined,
        reason,
        createdBy: getFlag(rest, "--by") ?? undefined,
      });
      console.log(`策略已发布 v${result.policy.version}（${result.policy.hash.slice(0, 12)}）`);
      console.log(`  受影响的授权：${result.affectedMandates.length} 个${result.affectedMandates.length > 0 ? `（${result.affectedMandates.join("、")}）` : ""}，待重验证`);
      console.log(`  受影响的工单：${result.affectedTasks.length} 个`);
      if (result.notifyError) console.log(`  通知写收件箱失败（策略已发布）：${result.notifyError}`);
      return 0;
    }
    if (sub === "show") {
      const policy = getCurrentPolicy(home);
      if (json) printJson(policy);
      else printPolicy(policy);
      return 0;
    }
    if (sub === "list") {
      const store = loadPolicyStore(home);
      if (json) {
        printJson({ current: store.current, history: store.history });
      } else {
        if (store.current) {
          console.log("当前策略：");
          printPolicy(store.current);
        } else {
          console.log("还没有策略（首次发布将创建 v1）");
        }
        if (store.history.length > 0) {
          console.log(`历史 ${store.history.length} 个版本：`);
          for (const p of store.history) console.log(`  v${p.version}（${p.hash.slice(0, 12)}）${p.createdAt} ${p.reason}`);
        }
      }
      return 0;
    }
    throw new GovernanceError("用法：nyra governance policy <publish|show|list> ...");
  }

  if (group === "mandate") {
    const sub = rest[0];
    if (sub === "issue") {
      const scope = getFlag(rest, "--scope");
      if (!scope) throw new GovernanceError("签发授权须写范围：--scope <范围，例如 agent:nyra 或 global>");
      const strength = getFlag(rest, "--strength") as MandateStrength | null;
      const channel = getFlag(rest, "--channel") as MandateChannel | null;
      const mandate = issueMandate(home, {
        scope,
        strength: strength ?? undefined,
        rules: collectRules(rest),
        issuer: getFlag(rest, "--issuer") ?? "cli",
        channel: channel ?? undefined,
      });
      console.log(`授权已签发 ${mandate.id}（${mandate.strength}）`);
      console.log(`  范围：${mandate.scope}，绑定策略 v${mandate.policyVersion}（${mandate.policyHash.slice(0, 12)}）`);
      return 0;
    }
    if (sub === "list") {
      const status = getFlag(rest, "--status") as MandateStatus | null;
      const rows = listMandates(home, status ? { status } : undefined);
      if (json) {
        printJson(rows);
      } else if (rows.length === 0) {
        console.log("没有授权");
      } else {
        for (const m of rows) {
          console.log(`${m.id} ${m.status} ${m.strength} ${m.scope}（策略 v${m.policyVersion}）${m.createdAt}`);
        }
      }
      return 0;
    }
    if (sub === "show") {
      const id = rest[1];
      if (!id) throw new GovernanceError("用法：nyra governance mandate show <授权 id>");
      const mandate = getMandate(home, id);
      if (json) printJson(mandate);
      else printMandate(mandate);
      return 0;
    }
    if (sub === "revalidate") {
      const id = rest[1];
      if (!id) throw new GovernanceError("用法：nyra governance mandate revalidate <授权 id>");
      const outcome = revalidateMandate(home, id);
      if (outcome.result === "current") {
        console.log(`授权 ${outcome.mandate.id} 已是当前策略 v${outcome.mandate.policyVersion}，无需换发`);
      } else if (outcome.result === "renewed") {
        console.log(`授权已换发：旧 ${id} → 新 ${outcome.newMandateId}（策略 v${outcome.mandate.policyVersion}）`);
      } else {
        console.log(`授权 ${id} 与当前策略冲突，拒绝续跑/恢复：`);
        for (const c of outcome.conflicts) console.log(`  - ${c}`);
        console.log("处理：先改策略或重新签发授权，不要绕过。");
        return 2;
      }
      return 0;
    }
    if (sub === "revoke") {
      const id = rest[1];
      if (!id) throw new GovernanceError("用法：nyra governance mandate revoke <授权 id> --reason <原因> [--yes]");
      const reason = getFlag(rest, "--reason");
      if (!reason) throw new GovernanceError("撤销授权须写原因：--reason <原因>");
      if (!hasFlag(rest, "--yes")) {
        console.log(`撤销授权 ${id} 后，绑它的续跑与恢复都会被拒绝。确认请加 --yes。`);
        return 2;
      }
      revokeMandate(home, id, reason);
      console.log(`授权 ${id} 已撤销`);
      return 0;
    }
    throw new GovernanceError("用法：nyra governance mandate <issue|list|show|revalidate|revoke> ...");
  }

  if (group === "mode") {
    const sub = rest[0];
    if (sub === "show") {
      const agent = getFlag(rest, "--agent") ?? "nyra";
      const mode = getAgentMode(home, agent);
      if (json) printJson({ agent, mode });
      else console.log(`${agent} 的接单模式：${mode}${mode === "observe" ? "（默认：只记干跑，不真干）" : "（已放行：评估通过可执行，仍受分层每日上限与审批约束）"}`);
      return 0;
    }
    if (sub === "set") {
      const agent = getFlag(rest, "--agent");
      if (!agent) throw new GovernanceError("用法：nyra governance mode set --agent <agent> <observe|auto> [--yes]");
      const mode = rest.find((a) => a === "observe" || a === "auto") as AgentMode | undefined;
      if (mode !== "observe" && mode !== "auto") throw new GovernanceError("接单模式只能是 observe 或 auto");
      if (mode === "auto" && !hasFlag(rest, "--yes")) {
        console.log("切 auto 意味着 Bot 评估通过就真干活（仍受分层每日上限与审批约束）。确认请加 --yes。");
        return 2;
      }
      setAgentMode(home, agent, mode, "cli");
      console.log(`${agent} 的接单模式已设为 ${mode}`);
      return 0;
    }
    throw new GovernanceError("用法：nyra governance mode <show|set> ...");
  }

  if (group === "dry-runs") {
    const sub = rest[0];
    if (sub === "list") {
      const agent = getFlag(rest, "--agent") ?? undefined;
      const status = getFlag(rest, "--status") as DryRunStatus | null;
      const rows = listDryRuns(home, { agent, status: status ?? undefined });
      if (json) {
        printJson(rows);
      } else if (rows.length === 0) {
        console.log("没有干跑记录");
      } else {
        for (const d of rows) {
          console.log(`${d.id} ${d.status} ${d.agent} ${d.kind}/${d.action} → ${d.target}（${d.at}）${d.reason}`);
        }
      }
      return 0;
    }
    if (sub === "show") {
      const id = rest[1];
      if (!id) throw new GovernanceError("用法：nyra governance dry-runs show <记录 id>");
      const row = listDryRuns(home).find((d) => d.id === id);
      if (!row) throw new GovernanceError(`找不到干跑记录 ${id}`);
      if (json) printJson(row);
      else console.log(`${row.id} ${row.status} ${row.agent} ${row.kind}/${row.action} → ${row.target}\n  原因：${row.reason}\n  记录于：${row.at}${row.estimatedCostUsd !== null ? `，预估花费 $${row.estimatedCostUsd}` : ""}${row.decidedBy ? `\n  已定：${row.status}，${row.decidedBy}，${row.decidedAt}` : ""}`);
      return 0;
    }
    if (sub === "promote" || sub === "discard") {
      const id = rest[1];
      if (!id) throw new GovernanceError(`用法：nyra governance dry-runs ${sub} <记录 id> [--yes]`);
      if (!hasFlag(rest, "--yes")) {
        console.log(`这一步只改账本状态，不执行任何动作。确认请加 --yes。`);
        return 2;
      }
      const row = decideDryRun(home, id, sub === "promote" ? "promoted" : "discarded", "cli");
      console.log(`干跑记录 ${row.id} 已标为 ${row.status}（只改账本，不执行动作；要执行请手动操作）`);
      return 0;
    }
    throw new GovernanceError("用法：nyra governance dry-runs <list|show|promote|discard> ...");
  }

  throw new GovernanceError("用法：nyra governance <policy|mandate|mode|dry-runs|caps|audit> ...（详见 docs/governance.md）");
}
