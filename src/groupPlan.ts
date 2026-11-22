// src/groupPlan.ts — G-P1-1：群组计划引擎 + 步骤 worktree 隔离 + 独立验收
// （借 Pi 的任务板思路：计划是步骤清单，每步有负责人与验收项；
// 步骤在隔离 worktree 里干活，验收独立于执行者）。
//
// 一条计划：{ 房间, 标题, 步骤[] }；每步：{ 标题, 负责人, 验收项[] }。
// - 步骤启动时建隔离 worktree（git worktree add -b nyra/plan/<计划>/<步>）：
//   主工作区一个字节都不动；工作目录不是 git 仓库时退化成空目录并在
//   步骤里记一笔 worktree: none（不静默假装隔离了）；
// - 每步的验收项落成一条缺口 29 交付契约（manual 检查项，启动时激活）：
//   验收结论只认契约，不认执行者自己说的“做完了”；
// - 步骤完成时先跑确定性检查（runDeterministicChecks：改动文件存在、
//   diff 摘要完整、证据齐全、草稿标未完成、UI 改动附 before 证据）：
//   确定性检查不过，步骤不能标完成；过了再逐项核验收项——全部通过才
//   算完成，有一项不过步骤即失败；
// - 账本 ~/.nyra/group-plans.json（原子写 0600）。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { activateContract, createContract, getContract, markContractItem } from "./contract.ts";
import { runDeterministicChecks, type VerifierCheck } from "./verifier.ts";

export const GROUP_PLANS_FILE = "group-plans.json";
export type PlanStepStatus = "pending" | "running" | "done" | "failed";
export type GroupPlanStatus = "draft" | "active" | "done" | "failed";

export interface PlanStepInput {
  title: string;
  assignee: string;
  acceptance: string[];
}

export interface PlanStep {
  id: string;
  title: string;
  assignee: string;
  acceptance: string[];
  status: PlanStepStatus;
  /** 隔离 worktree 路径（git 仓库时是 worktree，否则是空目录）；null = 未启动。 */
  worktree: string | null;
  /** worktree 的分支名（git 时才有）。 */
  worktree_branch: string | null;
  /** worktree 形态：git = 真 worktree；none = 空目录（非 git 仓库的退化）。 */
  worktree_kind: "git" | "none" | null;
  contract_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  note: string | null;
}

export interface GroupPlan {
  id: string;
  room_id: string;
  title: string;
  workdir: string;
  steps: PlanStep[];
  status: GroupPlanStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GroupPlanStore {
  version: 1;
  plans: GroupPlan[];
}

export class GroupPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupPlanError";
  }
}

export function groupPlansPath(home: string): string {
  return join(resolveNyraHome(home), GROUP_PLANS_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newPlanId(): string {
  return `gplan_${randomBytes(6).toString("hex")}`;
}

function newStepId(): string {
  return `step_${randomBytes(4).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
}

export function loadGroupPlans(home: string): GroupPlanStore {
  const path = groupPlansPath(home);
  if (!existsSync(path)) return { version: 1, plans: [] };
  if (lstatSync(path).isSymbolicLink()) throw new GroupPlanError("群组计划账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new GroupPlanError("群组计划账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as GroupPlanStore).version !== 1 ||
    !Array.isArray((raw as GroupPlanStore).plans)) {
    backupCorrupt(path);
    throw new GroupPlanError("群组计划账本格式无效，已备份");
  }
  return raw as GroupPlanStore;
}

export function saveGroupPlans(home: string, store: GroupPlanStore): void {
  const path = groupPlansPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new GroupPlanError("群组计划账本不能是符号链接");
  const tmp = join(dirname(path), `.group-plans-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordPlanEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`群组计划：${type}`, "group-plan", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
  } catch { /* 证据写失败不破坏计划本身 */ }
}

function validateStepInput(step: PlanStepInput, index: number): void {
  if (!step.title?.trim()) throw new GroupPlanError(`第 ${index + 1} 步要有标题`);
  if (step.title.trim().length > 200) throw new GroupPlanError(`第 ${index + 1} 步标题最多 200 字`);
  if (!step.assignee?.trim()) throw new GroupPlanError(`第 ${index + 1} 步要指定负责人`);
  if (!Array.isArray(step.acceptance) || !step.acceptance.length) {
    throw new GroupPlanError(`第 ${index + 1} 步至少要有一项验收（没验收项的步骤不进计划）`);
  }
  for (const a of step.acceptance) {
    if (typeof a !== "string" || !a.trim()) throw new GroupPlanError(`第 ${index + 1} 步的验收项不能为空`);
  }
}

/** 建计划：步骤至少 1 步，每步都要有负责人与验收项（没验收项不建）。 */
export function createGroupPlan(home: string, opts: {
  roomId: string;
  title: string;
  workdir: string;
  steps: PlanStepInput[];
  by?: string;
}): GroupPlan {
  if (!opts.roomId?.trim()) throw new GroupPlanError("计划要挂在一个群（room_id）上");
  if (!opts.title?.trim()) throw new GroupPlanError("计划要有标题");
  if (!Array.isArray(opts.steps) || !opts.steps.length) throw new GroupPlanError("计划至少要有一条步骤");
  opts.steps.forEach(validateStepInput);
  const plan: GroupPlan = {
    id: newPlanId(),
    room_id: opts.roomId.trim(),
    title: opts.title.trim(),
    workdir: opts.workdir,
    steps: opts.steps.map((s) => ({
      id: newStepId(),
      title: s.title.trim(),
      assignee: s.assignee.trim(),
      acceptance: s.acceptance.map((a) => a.trim()),
      status: "pending",
      worktree: null,
      worktree_branch: null,
      worktree_kind: null,
      contract_id: null,
      started_at: null,
      finished_at: null,
      note: null,
    })),
    status: "draft",
    created_by: opts.by ?? "owner",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const store = loadGroupPlans(home);
  store.plans.push(plan);
  saveGroupPlans(home, store);
  recordPlanEvent(home, "group_plan_created", { plan: plan.id, room: plan.room_id, steps: plan.steps.length });
  return plan;
}

export function getGroupPlan(home: string, planId: string): GroupPlan | null {
  return loadGroupPlans(home).plans.find((p) => p.id === planId) ?? null;
}

export function listGroupPlans(home: string, roomId?: string): GroupPlan[] {
  const all = loadGroupPlans(home).plans;
  return roomId ? all.filter((p) => p.room_id === roomId) : all;
}

function findStep(plan: GroupPlan, stepId: string): PlanStep {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new GroupPlanError(`计划 ${plan.id} 里没有步骤 ${stepId}`);
  return step;
}

function derivePlanStatus(plan: GroupPlan): GroupPlanStatus {
  if (plan.steps.every((s) => s.status === "done")) return "done";
  if (plan.steps.some((s) => s.status === "failed") && plan.steps.every((s) => s.status === "done" || s.status === "failed")) return "failed";
  if (plan.steps.some((s) => s.status === "running" || s.status === "done" || s.status === "failed")) return "active";
  return "draft";
}

function savePlan(home: string, plan: GroupPlan): void {
  const store = loadGroupPlans(home);
  const idx = store.plans.findIndex((p) => p.id === plan.id);
  if (idx < 0) throw new GroupPlanError(`找不到计划 ${plan.id}`);
  plan.status = derivePlanStatus(plan);
  plan.updated_at = nowIso();
  store.plans[idx] = plan;
  saveGroupPlans(home, store);
}

/** 往计划里加一步（只能加在还没启动的步骤后面；已完成的计划不加）。 */
export function addPlanStep(home: string, planId: string, step: PlanStepInput): PlanStep {
  const plan = getGroupPlan(home, planId);
  if (!plan) throw new GroupPlanError(`没有这个计划：${planId}`);
  if (plan.status === "done" || plan.status === "failed") throw new GroupPlanError(`计划 ${planId} 已结束（${plan.status}），不能再加步骤`);
  validateStepInput(step, plan.steps.length);
  const created: PlanStep = {
    id: newStepId(),
    title: step.title.trim(),
    assignee: step.assignee.trim(),
    acceptance: step.acceptance.map((a) => a.trim()),
    status: "pending",
    worktree: null,
    worktree_branch: null,
    worktree_kind: null,
    contract_id: null,
    started_at: null,
    finished_at: null,
    note: null,
  };
  plan.steps.push(created);
  savePlan(home, plan);
  return created;
}

function stepWorkdir(home: string, planId: string, stepId: string): string {
  return join(resolveNyraHome(home), "group-plans", planId, "steps", stepId, "work");
}

/**
 * 启动一步：建隔离 worktree + 落一条交付契约（验收项 = manual 检查项，
 * 启动即激活）。git 建 worktree 失败（工作目录不是 git 仓库）时退化
 * 成空目录并在 note 里写明（不静默假装隔离了）。
 */
export function startPlanStep(home: string, planId: string, stepId: string): PlanStep {
  const plan = getGroupPlan(home, planId);
  if (!plan) throw new GroupPlanError(`没有这个计划：${planId}`);
  const step = findStep(plan, stepId);
  if (step.status !== "pending") throw new GroupPlanError(`步骤 ${stepId} 已是 ${step.status} 状态，不能再启动`);
  const dir = stepWorkdir(home, planId, stepId);
  const branch = `nyra/plan/${planId}/${stepId}`;
  let kind: "git" | "none" = "none";
  let note: string | null = null;
  mkdirSync(dir, { recursive: true });
  const probe = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: plan.workdir, encoding: "utf-8", windowsHide: true });
  if (probe.status === 0) {
    const add = spawnSync("git", ["worktree", "add", "-b", branch, dir, "HEAD"], {
      cwd: plan.workdir, encoding: "utf-8", windowsHide: true,
    });
    if (add.status === 0) {
      kind = "git";
    } else {
      note = `worktree 创建失败（${`${add.stdout ?? ""}${add.stderr ?? ""}`.trim().slice(0, 200)}），退化成空目录隔离`;
    }
  } else {
    note = "工作目录不是 git 仓库，步骤在空目录里隔离（无 worktree）";
  }
  const contract = createContract(home, {
    task: `${plan.title} / ${step.title}`,
    deliverables: [{ id: `step-${step.id.slice(0, 8)}`, description: step.title, attributes: [] }],
    checks: step.acceptance.map((a, i) => ({ id: `acc-${i + 1}`, label: a, kind: "manual" as const, checker: null })),
  });
  activateContract(home, contract.id);
  step.worktree = dir;
  step.worktree_branch = kind === "git" ? branch : null;
  step.worktree_kind = kind;
  step.contract_id = contract.id;
  step.status = "running";
  step.started_at = nowIso();
  step.note = note;
  savePlan(home, plan);
  recordPlanEvent(home, "group_plan_step_started", { plan: planId, step: stepId, assignee: step.assignee, worktree: kind });
  return step;
}

export interface StepCompletionInput {
  /** 执行者交回的摘要（确定性检查要它非空）。 */
  summary: string;
  /** 改动文件（相对路径，相对步骤 worktree）。 */
  changedFiles: string[];
  /** diff 摘要（可空；有改动文件时最好给）。 */
  diffStat?: string | null;
  /** 每项验收的结论（checkId 对应 acc-1…；证据必填，空证据不算通过）。 */
  checks: { checkId: string; pass: boolean; evidence: string }[];
}

export interface StepCompletionResult {
  ok: boolean;
  step: PlanStep;
  /** 确定性检查不过的项（ok=false 时看它）。 */
  failedDeterministic: VerifierCheck[];
  /** 验收项里没通过的（ok=false 时看它）。 */
  failedAcceptance: string[];
}

/**
 * 完成一步（独立验收，执行者自己说了不算）：
 * ① 确定性检查（改动文件存在、diff 摘要完整、证据齐全…）不过 → 步骤
 *    保持 running，返回不过的项（不标完成、不标失败，等执行者补证据）；
 * ② 验收项逐项核：有任何一项不过 → 步骤标 failed；全部通过 → done。
 * 验收结论写进契约（markContractItem），证据链里另有事件。
 */
export function completePlanStep(home: string, planId: string, stepId: string, input: StepCompletionInput): StepCompletionResult {
  const plan = getGroupPlan(home, planId);
  if (!plan) throw new GroupPlanError(`没有这个计划：${planId}`);
  const step = findStep(plan, stepId);
  if (step.status !== "running") throw new GroupPlanError(`步骤 ${stepId} 还没启动（当前 ${step.status}），不能验收`);
  if (!step.contract_id) throw new GroupPlanError(`步骤 ${stepId} 没有交付契约，先启动再验收`);
  const deterministic = runDeterministicChecks({
    title: step.title,
    summary: input.summary,
    changedFiles: input.changedFiles,
    diffStat: input.diffStat ?? null,
    worktreePath: step.worktree,
    workdir: plan.workdir,
    spentUsd: null,
  });
  const failedDeterministic = deterministic.filter((c) => !c.passed);
  if (failedDeterministic.length) {
    return { ok: false, step, failedDeterministic, failedAcceptance: [] };
  }
  const failedAcceptance: string[] = [];
  for (const c of input.checks) {
    if (!c.pass || !c.evidence.trim()) {
      failedAcceptance.push(c.checkId);
      markContractItem(home, step.contract_id, c.checkId, false, c.evidence || "（无证据）");
    } else {
      markContractItem(home, step.contract_id, c.checkId, true, c.evidence);
    }
  }
  // 没给结论的验收项按没过算（执行者不能靠“少报一项”蒙混过关）。
  const contract = getContract(home, step.contract_id);
  const reported = new Set(input.checks.map((c) => c.checkId));
  for (const check of contract?.checks ?? []) {
    if (!reported.has(check.id)) failedAcceptance.push(check.id);
  }
  step.finished_at = nowIso();
  if (failedAcceptance.length) {
    step.status = "failed";
    step.note = `验收没过：${failedAcceptance.join("、")}`;
    savePlan(home, plan);
    recordPlanEvent(home, "group_plan_step_failed", { plan: planId, step: stepId, reason: step.note });
    return { ok: false, step, failedDeterministic: [], failedAcceptance };
  }
  step.status = "done";
  savePlan(home, plan);
  recordPlanEvent(home, "group_plan_step_completed", { plan: planId, step: stepId, contract_id: step.contract_id, checks_passed: input.checks.length });
  return { ok: true, step, failedDeterministic: [], failedAcceptance: [] };
}

/** 标一步失败（执行者自己报失败，或负责人判定做不下去；须给原因）。 */
export function failPlanStep(home: string, planId: string, stepId: string, reason: string): PlanStep {
  const plan = getGroupPlan(home, planId);
  if (!plan) throw new GroupPlanError(`没有这个计划：${planId}`);
  const step = findStep(plan, stepId);
  if (step.status !== "running" && step.status !== "pending") throw new GroupPlanError(`步骤 ${stepId} 已是 ${step.status} 状态，不能再标失败`);
  step.status = "failed";
  step.finished_at = nowIso();
  step.note = reason.slice(0, 500);
  savePlan(home, plan);
  recordPlanEvent(home, "group_plan_step_failed", { plan: planId, step: stepId, reason: step.note });
  return step;
}

export interface GroupPlanStepResult {
  /** 步骤执行者交回的东西（completePlanStep 的入参）。 */
  summary: string;
  changedFiles: string[];
  diffStat?: string | null;
  /** 每项验收的结论（checkId 对应 acc-1…；证据必填，空证据不算通过）。 */
  checks: { checkId: string; pass: boolean; evidence: string }[];
}

export interface RunGroupPlanOptions {
  /**
   * 步骤执行者：跑一步的任务，返回交回内容（摘要、改动文件、diff 摘要、
   * 每项验收的结论与证据）。抛错 = 这一步失败（标 failed，计划停下）。
   * CLI 注入真实 agent 跑；测试注入假实现。
   */
  runStep: (step: PlanStep, worktree: string | null) => Promise<GroupPlanStepResult>;
  onEvent?: (type: string, fields: Record<string, unknown>) => void;
}

export interface RunGroupPlanResult {
  plan: GroupPlan;
  /** 跑完的步骤数（含失败那步）。 */
  stepsRun: number;
  /** 失败那步的 id（全过时 null）。 */
  failedStepId: string | null;
  /** 失败原因（确定性检查不过 / 验收没过 / 执行者抛错）。 */
  failedReason: string | null;
}

/**
 * 跑一个群组计划：按顺序一步一步跑（上一步没过就停下，不硬跑下一步）。
 * 每步：startPlanStep（建隔离 worktree + 落交付契约）→ runStep（执行者
 * 干活）→ completePlanStep（独立验收：先确定性检查，再逐项核验收项）。
 * 计划状态由 savePlan 按步骤状态派生（全 done = done，有 failed 且无
 * running/pending = failed，其余 = active）。
 */
export async function runGroupPlan(home: string, planId: string, opts: RunGroupPlanOptions): Promise<RunGroupPlanResult> {
  let plan = getGroupPlan(home, planId);
  if (!plan) throw new GroupPlanError(`没有这个计划：${planId}`);
  if (plan.status === "done" || plan.status === "failed") throw new GroupPlanError(`计划 ${planId} 已结束（${plan.status}），不能再跑`);
  let stepsRun = 0;
  for (const step of plan.steps) {
    if (step.status === "done") continue;
    if (step.status !== "pending") throw new GroupPlanError(`步骤 ${step.id} 已是 ${step.status} 状态，计划不能从中间续跑（先处理它）`);
    const started = startPlanStep(home, planId, step.id);
    stepsRun += 1;
    let result: GroupPlanStepResult;
    try {
      result = await opts.runStep(started, started.worktree);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      failPlanStep(home, planId, step.id, `执行失败：${reason.slice(0, 300)}`);
      plan = getGroupPlan(home, planId)!;
      return { plan, stepsRun, failedStepId: step.id, failedReason: `执行失败：${reason.slice(0, 300)}` };
    }
    const completed = completePlanStep(home, planId, step.id, {
      summary: result.summary,
      changedFiles: result.changedFiles,
      diffStat: result.diffStat ?? null,
      checks: result.checks,
    });
    plan = getGroupPlan(home, planId)!;
    if (!completed.ok) {
      const reason = completed.failedDeterministic.length
        ? `确定性检查没过：${completed.failedDeterministic.map((c) => c.label).join("、")}`
        : `验收没过：${completed.failedAcceptance.join("、")}`;
      return { plan, stepsRun, failedStepId: step.id, failedReason: reason };
    }
  }
  plan = getGroupPlan(home, planId)!;
  return { plan, stepsRun, failedStepId: null, failedReason: null };
}

