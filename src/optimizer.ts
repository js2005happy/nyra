// src/optimizer.ts — G-4 带人批的自优化环（缺口 43 第一批）。
//
//   proposer 只起草改指令建议（从回归用例的失败种类套模板，或人工手写），
//   须人批（approve）才生效；apply 改文件；verify 跑三数据集对应的测试，
//   只有 holdout 也通过才放行（released）；验证不过自动回滚、状态标 failed。
//
// 硬边界（诚实口径）：
//   - proposer 是确定性的模板起草，不调模型、不花 token、不自动改代码；
//   - 人批是硬门：draft 不能 apply，apply 过的才能 verify；
//   - 回滚是确定的文本还原（oldText ↔ newText 互换 / 追加的尾巴整段去掉），
//     文件中途被别人改动、还原对不上时不硬写、标 failed 等人工处理；
//   - 目标文件只限工作目录下的 .md 指令文档，不碰 MEMORY.md、不碰 .nyra/、不越界；
//   - 循环有硬上限：maxIterations（默认 3）、maxMinutes（默认 60）；
//   - 提议只记元数据与文本替换对，不调模型、不自动重跑、不自动改代码——
//     唯一的自动动作是 verify 失败后的回滚。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve, relative, basename, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { loadRegressionStore, type RegressionKind } from "./regression.ts";
import { appendGovernanceAudit } from "./governance.ts";
import { recordArmReward } from "./optimizerArms.ts";

export class OptimizerError extends Error {}

const STORE_FILE = "optimization-proposals.json";

export type ProposalStatus = "draft" | "approved" | "rejected" | "applied" | "released" | "failed";
export type ProposalSourceKind = "regression-case" | "manual" | "eval-report";

export interface ProposalDatasets {
  train: string[];
  validation: string[];
  holdout: string[];
}

export interface ProposalTests {
  train: string[];
  validation: string[];
  holdout: string[];
}

export interface ProposalHistoryEntry {
  at: string;
  action: string;
  by: string;
  note: string;
}

export interface OptimizationProposal {
  id: string;
  source: { kind: ProposalSourceKind; ref: string };
  /** G-P1-29：所属 UCB 臂（评测失败簇键，如 code:artifact-json），无则不填。 */
  armKey?: string;
  target: string;
  oldText: string;
  newText: string;
  rationale: string;
  /** apply 时实际追加的尾巴（oldText 为空时）；回滚时原样去掉。null 表示替换式改动。 */
  appliedSuffix: string | null;
  datasets: ProposalDatasets;
  tests: ProposalTests;
  status: ProposalStatus;
  caps: { maxIterations: number; maxCostUsd: number | null; maxMinutes: number };
  iterations: number;
  costUsd: number;
  history: ProposalHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ProposalStore {
  version: 1;
  proposals: OptimizationProposal[];
}

/** verify 的测试运行器：默认走本机 bun test；测试里可注入假 runner。 */
export interface VerifyRunner {
  (files: string[], timeoutMs: number, workdir: string): { ok: boolean; output: string };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newProposalId(): string {
  return `op_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new OptimizerError(`${file} 不能是符号链接`);
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

export function loadProposalStore(home: string): ProposalStore {
  const path = join(resolveHome(home), STORE_FILE);
  if (!existsSync(path)) return { version: 1, proposals: [] };
  if (lstatSync(path).isSymbolicLink()) throw new OptimizerError(`${STORE_FILE} 不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new OptimizerError(`${STORE_FILE} 损坏，已备份，请检查后恢复`);
  }
  if (!raw || typeof raw !== "object" || (raw as ProposalStore).version !== 1 || !Array.isArray((raw as ProposalStore).proposals)) {
    backupCorrupt(path);
    throw new OptimizerError(`${STORE_FILE} 格式无效，已备份`);
  }
  return raw as ProposalStore;
}

function saveProposalStore(home: string, store: ProposalStore): void {
  saveJsonAtomic(home, STORE_FILE, store);
}

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

function audit(home: string, action: string, proposalId: string, extra: Record<string, unknown> = {}): void {
  appendGovernanceAudit(home, { action, proposal_id: proposalId, ...extra });
}

/** 目标文件只限工作目录下的 .md 指令文档：相对路径、.md 结尾、不碰 MEMORY.md 与 .nyra/。 */
export function resolveTargetPath(workdir: string, target: string): string {
  const rel = (target ?? "").trim();
  if (!rel) throw new OptimizerError("提议须写目标文件（--target，例如 docs/AGENTS.md）");
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw new OptimizerError("目标文件须是工作目录下的相对路径");
  if (!rel.endsWith(".md")) throw new OptimizerError("目标文件只限 .md 指令文档");
  if (basename(rel) === "MEMORY.md") throw new OptimizerError("目标文件不能是 MEMORY.md");
  const resolved = resolve(workdir, rel);
  const relOut = relative(resolve(workdir), resolved);
  if (relOut.startsWith("..") || relOut.startsWith(sep) || relOut === "") {
    throw new OptimizerError("目标文件不能越出工作目录");
  }
  if (relOut.split(sep).includes(".nyra")) throw new OptimizerError("目标文件不能在 .nyra/ 里");
  return resolved;
}

function validateTestFiles(files: string[]): void {
  for (const f of files) {
    const rel = (f ?? "").trim();
    if (!rel.startsWith("tests/node/") || !rel.endsWith(".test.ts")) {
      throw new OptimizerError(`验证测试只限 tests/node/ 下的 .test.ts 文件：${f}`);
    }
    if (rel.includes("..")) throw new OptimizerError(`验证测试路径不能含 ..：${f}`);
  }
}

function validateCaseIds(home: string, ids: string[]): void {
  if (ids.length === 0) return;
  const store = loadRegressionStore(home);
  const known = new Set(store.cases.map((c) => c.id));
  for (const id of ids) {
    if (!known.has(id)) throw new OptimizerError(`回归用例不存在：${id}`);
  }
}

/** 从回归用例的失败种类套模板，起草一条追加到指令文档末尾的教训。 */
export function draftFromRegressionCase(kind: RegressionKind, title: string): string {
  const t = (title ?? "").trim().slice(0, 100) || "未命名失败";
  switch (kind) {
    case "tool-failed":
      return `注意：工具“${t}”曾失败——调用前先校验输入与目标存在，重试上限 3 次，失败先记回归用例再换做法，不要静默重试。`;
    case "delegate-failed":
      return `注意：委派“${t}”曾失败——委派前先确认子 agent 的输入完整、超时与重试上限已设，失败时把失败步骤沉淀为回归用例。`;
    case "verdict-failed":
      return `注意：验收“${t}”曾不通过——改完先自查验收清单（草稿标未完成、界面改动附 before 对比），再提交验收。`;
    case "llm-failed":
      return `注意：模型调用“${t}”曾失败——先确认模型与用量（月度硬顶未触顶），失败重试上限 3 次，超了停下等用户。`;
    case "run-error":
      return `注意：运行“${t}”曾出错——跑之前先看上次的失败记录，同类错误不要换个说法再跑一遍。`;
  }
}

export function getProposal(home: string, id: string): OptimizationProposal {
  const store = loadProposalStore(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new OptimizerError(`找不到提议 ${id}`);
  return proposal;
}

export function listProposals(home: string, filter?: { status?: ProposalStatus }): OptimizationProposal[] {
  const store = loadProposalStore(home);
  return store.proposals
    .filter((p) => !filter?.status || p.status === filter.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function proposeOptimization(
  home: string,
  opts: {
    target: string;
    oldText?: string;
    newText?: string;
    rationale?: string;
    fromRegression?: string;
    sourceKind?: "eval-report";
    sourceRef?: string;
    armKey?: string;
    trainCases?: string[];
    validationCases?: string[];
    holdoutCases?: string[];
    trainTests?: string[];
    validationTests?: string[];
    holdoutTests?: string[];
    maxIterations?: number;
    maxMinutes?: number;
    by?: string;
    runId?: string | null;
  },
): OptimizationProposal {
  const target = (opts.target ?? "").trim();
  if (!target) throw new OptimizerError("提议须写目标文件（--target）");
  const maxIterations = opts.maxIterations ?? 3;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) {
    throw new OptimizerError("--max-iterations 必须是 1 到 10 的整数");
  }
  const maxMinutes = opts.maxMinutes ?? 60;
  if (!Number.isInteger(maxMinutes) || maxMinutes < 5 || maxMinutes > 600) {
    throw new OptimizerError("--max-minutes 必须是 5 到 600 的整数");
  }
  const trainTests = opts.trainTests ?? [];
  const validationTests = opts.validationTests ?? [];
  const holdoutTests = opts.holdoutTests ?? [];
  validateTestFiles([...trainTests, ...validationTests, ...holdoutTests]);
  const trainCases = opts.trainCases ?? [];
  const validationCases = opts.validationCases ?? [];
  const holdoutCases = opts.holdoutCases ?? [];
  validateCaseIds(home, [...trainCases, ...validationCases, ...holdoutCases]);

  let source: { kind: ProposalSourceKind; ref: string };
  let oldText = (opts.oldText ?? "").trim();
  let newText = (opts.newText ?? "").trim();
  let rationale = (opts.rationale ?? "").trim();
  if (opts.fromRegression) {
    const store = loadRegressionStore(home);
    const c = store.cases.find((x) => x.id === opts.fromRegression);
    if (!c) throw new OptimizerError(`回归用例不存在：${opts.fromRegression}`);
    source = { kind: "regression-case", ref: c.id };
    if (!newText) newText = draftFromRegressionCase(c.kind, c.title);
    if (!rationale) rationale = `回归用例 ${c.id}（${c.kind}：${c.title}）的教训，起草为指令文档追加行。`;
    if (trainCases.length === 0) trainCases.push(c.id);
  } else if (opts.sourceKind === "eval-report") {
    source = { kind: "eval-report", ref: (opts.sourceRef ?? "").trim().slice(0, 200) };
    if (!newText) throw new OptimizerError("评测提议须写 --new-text（loop 自动起草时由模板生成）");
  } else {
    source = { kind: "manual", ref: "" };
    if (!newText) throw new OptimizerError("人工提议须写 --new-text（要换成的新文本；oldText 为空表示追加到文件末尾）");
  }
  if (!rationale) rationale = "人工提议（未写理由）";
  if (rationale.length > 500) throw new OptimizerError("理由过长（超过 500 字符）");
  const armKey = (opts.armKey ?? "").trim();
  if (armKey && (!/^[A-Za-z0-9_:.\-]+$/.test(armKey) || armKey.length > 120)) {
    throw new OptimizerError("armKey 格式不对（只限字母、数字与 _ : . -，不超过 120 字符）");
  }

  const proposal: OptimizationProposal = {
    id: newProposalId(),
    source,
    armKey: armKey || undefined,
    target,
    oldText,
    newText,
    rationale,
    appliedSuffix: null,
    datasets: { train: trainCases, validation: validationCases, holdout: holdoutCases },
    tests: { train: trainTests, validation: validationTests, holdout: holdoutTests },
    status: "draft",
    caps: { maxIterations, maxCostUsd: null, maxMinutes },
    iterations: 0,
    costUsd: 0,
    history: [{ at: nowIso(), action: "created", by: (opts.by ?? "cli").trim() || "cli", note: rationale.slice(0, 200) }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const store = loadProposalStore(home);
  store.proposals.unshift(proposal);
  saveProposalStore(home, store);
  audit(home, "proposal_created", proposal.id, { source: source.kind });
  mirrorEvent(home, opts.runId ?? null, "proposal_created", { proposal_id: proposal.id, source: source.kind });
  return proposal;
}

export function editProposal(
  home: string,
  id: string,
  opts: { oldText?: string; newText?: string; rationale?: string; by?: string },
): OptimizationProposal {
  const store = loadProposalStore(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new OptimizerError(`找不到提议 ${id}`);
  if (proposal.status !== "draft" && proposal.status !== "failed") throw new OptimizerError(`提议 ${id} 已是 ${proposal.status}，不能再改（想改请重新起草）`);
  if (proposal.status === "failed") proposal.status = "draft";
  if (opts.oldText !== undefined) proposal.oldText = opts.oldText.trim();
  if (opts.newText !== undefined) {
    if (!opts.newText.trim()) throw new OptimizerError("新文本不能为空");
    proposal.newText = opts.newText.trim();
  }
  if (opts.rationale !== undefined) {
    if (opts.rationale.trim().length > 500) throw new OptimizerError("理由过长（超过 500 字符）");
    proposal.rationale = opts.rationale.trim();
  }
  proposal.updatedAt = nowIso();
  proposal.history.push({ at: nowIso(), action: "edited", by: (opts.by ?? "cli").trim() || "cli", note: "人工修订提议文本" });
  saveProposalStore(home, store);
  return proposal;
}

export function decideProposal(
  home: string,
  id: string,
  decision: "approved" | "rejected",
  by: string,
  opts?: { note?: string; runId?: string | null },
): OptimizationProposal {
  const store = loadProposalStore(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new OptimizerError(`找不到提议 ${id}`);
  if (proposal.status !== "draft") throw new OptimizerError(`提议 ${id} 已是 ${proposal.status}，不能再定`);
  proposal.status = decision;
  proposal.updatedAt = nowIso();
  proposal.history.push({ at: nowIso(), action: decision, by: (by ?? "cli").trim() || "cli", note: (opts?.note ?? "").trim().slice(0, 200) });
  saveProposalStore(home, store);
  audit(home, "proposal_decided", id, { decision, by: proposal.history[proposal.history.length - 1].by });
  mirrorEvent(home, opts?.runId ?? null, "proposal_decided", { proposal_id: id, decision });
  return proposal;
}

// ---------------------------------------------------------------------------
// apply / verify / revert
// ---------------------------------------------------------------------------

function writeFileKeepMode(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

/**
 * 把提议的改动写进目标文件（须先人批）。
 *   - oldText 为空 → 把 newText 追加到文件末尾；
 *   - oldText 非空 → 必须在文件里恰好出现一次，替换成 newText。
 * 追加时记下 appliedSuffix，供回滚时原样去掉。
 */
export function applyProposal(home: string, id: string, workdir: string, opts?: { by?: string; runId?: string | null }): OptimizationProposal {
  const store = loadProposalStore(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new OptimizerError(`找不到提议 ${id}`);
  if (proposal.status !== "approved") throw new OptimizerError(`提议 ${id} 是 ${proposal.status}，须先人批（approve）才能改文件`);
  if (proposal.iterations >= proposal.caps.maxIterations) {
    throw new OptimizerError(`提议 ${id} 已达循环上限（${proposal.caps.maxIterations} 次），不能再改`);
  }
  const path = resolveTargetPath(workdir, proposal.target);
  if (!existsSync(path)) throw new OptimizerError(`目标文件不存在：${proposal.target}`);
  const content = readFileSync(path, "utf-8");
  let next: string;
  let appliedSuffix: string | null = null;
  if (!proposal.oldText) {
    const suffix = (content.endsWith("\n") || content.length === 0 ? "" : "\n") + proposal.newText + "\n";
    next = content + suffix;
    appliedSuffix = suffix;
  } else {
    const parts = content.split(proposal.oldText);
    if (parts.length - 1 !== 1) {
      throw new OptimizerError(`目标文件里 oldText 出现 ${parts.length - 1} 次（须恰好 1 次），拒绝改文件`);
    }
    next = content.replace(proposal.oldText, proposal.newText);
  }
  writeFileKeepMode(path, next);
  proposal.appliedSuffix = appliedSuffix;
  proposal.iterations += 1;
  proposal.status = "applied";
  proposal.updatedAt = nowIso();
  proposal.history.push({ at: nowIso(), action: "applied", by: (opts?.by ?? "cli").trim() || "cli", note: `第 ${proposal.iterations} 次改动，目标 ${proposal.target}` });
  saveProposalStore(home, store);
  audit(home, "proposal_applied", id, { target: proposal.target, iteration: proposal.iterations });
  mirrorEvent(home, opts?.runId ?? null, "proposal_applied", { proposal_id: id, target: proposal.target });
  return proposal;
}

/** 把一次已应用的改动还原（确定性文本还原，不硬写）。 */
function revertChange(workdir: string, proposal: OptimizationProposal): { ok: boolean; reason: string } {
  const path = resolveTargetPath(workdir, proposal.target);
  if (!existsSync(path)) return { ok: false, reason: `目标文件不存在：${proposal.target}` };
  const content = readFileSync(path, "utf-8");
  let next: string;
  if (proposal.appliedSuffix !== null) {
    if (!content.endsWith(proposal.appliedSuffix)) {
      return { ok: false, reason: "目标文件末尾已不是提议追加的内容（可能被改动过），拒绝回滚" };
    }
    next = content.slice(0, content.length - proposal.appliedSuffix.length);
  } else if (proposal.oldText) {
    const parts = content.split(proposal.newText);
    if (parts.length - 1 !== 1) {
      return { ok: false, reason: `目标文件里 newText 出现 ${parts.length - 1} 次（须恰好 1 次），拒绝回滚` };
    }
    next = content.replace(proposal.newText, proposal.oldText);
  } else {
    return { ok: false, reason: "无法确定回滚方式（既无追加尾巴也无 oldText）" };
  }
  writeFileKeepMode(path, next);
  return { ok: true, reason: "" };
}

export function defaultVerifyRunner(files: string[], timeoutMs: number, workdir: string): { ok: boolean; output: string } {
  if (files.length === 0) return { ok: true, output: "（无测试文件，跳过）" };
  const res = spawnSync("bun", ["test", ...files], { cwd: workdir, timeout: timeoutMs, encoding: "utf-8" });
  const output = [res.stdout ?? "", res.stderr ?? ""].join("\n").slice(-4000);
  if (res.error && String(res.error).includes("ETIMEDOUT")) return { ok: false, output: `验证超时（${timeoutMs / 1000} 秒）\n${output}` };
  return { ok: res.status === 0, output };
}

export interface VerifyOutcome {
  proposal: OptimizationProposal;
  validation: { ran: boolean; ok: boolean; output: string };
  holdout: { ran: boolean; ok: boolean; output: string };
  reverted: boolean;
  revertError: string | null;
}

/**
 * 验证已应用的提议：先跑 validation 测试，再跑 holdout 测试。
 *   - 两者都过 → released（放行）；
 *   - 任一不过 → 自动回滚文件，状态标 failed（回滚失败也标 failed，等人工处理）。
 */
export function verifyProposal(
  home: string,
  id: string,
  workdir: string,
  opts?: { runner?: VerifyRunner; by?: string; runId?: string | null },
): VerifyOutcome {
  const store = loadProposalStore(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new OptimizerError(`找不到提议 ${id}`);
  if (proposal.status !== "applied") throw new OptimizerError(`提议 ${id} 是 ${proposal.status}，只有 applied 的提议才能验证`);
  const runner = opts?.runner ?? defaultVerifyRunner;
  const timeoutMs = proposal.caps.maxMinutes * 60 * 1000;
  const validation = { ran: proposal.tests.validation.length > 0, ok: true, output: "" };
  if (validation.ran) {
    const r = runner(proposal.tests.validation, timeoutMs, workdir);
    validation.ok = r.ok;
    validation.output = r.output;
  }
  let holdout = { ran: false, ok: true, output: "" };
  if (validation.ok) {
    holdout = { ran: proposal.tests.holdout.length > 0, ok: true, output: "" };
    if (holdout.ran) {
      const r = runner(proposal.tests.holdout, timeoutMs, workdir);
      holdout.ok = r.ok;
      holdout.output = r.output;
    }
  }
  const by = (opts?.by ?? "cli").trim() || "cli";
  let reverted = false;
  let revertError: string | null = null;
  if (validation.ok && holdout.ok) {
    proposal.status = "released";
    proposal.updatedAt = nowIso();
    proposal.history.push({ at: nowIso(), action: "released", by, note: `validation ${validation.ran ? "通过" : "无测试"}，holdout ${holdout.ran ? "通过" : "无测试"}，放行` });
    saveProposalStore(home, store);
    audit(home, "proposal_released", id, { holdout_passed: true });
    mirrorEvent(home, opts?.runId ?? null, "proposal_released", { proposal_id: id, holdout_passed: true });
  } else {
    const reason = !validation.ok ? "validation 未通过" : "holdout 未通过";
    const revertedResult = revertChange(workdir, proposal);
    reverted = revertedResult.ok;
    revertError = revertedResult.ok ? null : revertedResult.reason;
    proposal.status = "failed";
    proposal.updatedAt = nowIso();
    proposal.history.push({
      at: nowIso(),
      action: "failed",
      by,
      note: `${reason}，已自动回滚${reverted ? "" : "（回滚失败：" + (revertError ?? "") + "，须人工恢复）"}`.slice(0, 500),
    });
    saveProposalStore(home, store);
    audit(home, "proposal_failed", id, { reason });
    mirrorEvent(home, opts?.runId ?? null, "proposal_failed", { proposal_id: id, reason });
    if (reverted) {
      proposal.appliedSuffix = null;
      saveProposalStore(home, store);
      mirrorEvent(home, opts?.runId ?? null, "proposal_reverted", { proposal_id: id, target: proposal.target });
    }
  }
  if (proposal.armKey) {
    // G-P1-29：verify 结果回填 UCB 臂账本（放行记 1、失败记 0），下一轮 loop 重排。
    recordArmReward(home, proposal.armKey, proposal.status === "released" ? 1 : 0);
  }
  return { proposal, validation, holdout, reverted, revertError };
}

/** 人工回滚一次已应用（或验证失败）的提议，回滚后回到 draft，可修订再批。 */
export function revertProposal(home: string, id: string, workdir: string, opts?: { by?: string; runId?: string | null }): OptimizationProposal {
  const store = loadProposalStore(home);
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) throw new OptimizerError(`找不到提议 ${id}`);
  if (proposal.status !== "applied" && proposal.status !== "failed") {
    throw new OptimizerError(`提议 ${id} 是 ${proposal.status}，只有 applied 或 failed 的提议才能回滚`);
  }
  const result = revertChange(workdir, proposal);
  if (!result.ok) throw new OptimizerError(`回滚失败：${result.reason}`);
  proposal.appliedSuffix = null;
  proposal.status = "draft";
  proposal.updatedAt = nowIso();
  proposal.history.push({ at: nowIso(), action: "reverted", by: (opts?.by ?? "cli").trim() || "cli", note: `人工回滚 ${proposal.target}，回到 draft` });
  saveProposalStore(home, store);
  mirrorEvent(home, opts?.runId ?? null, "proposal_reverted", { proposal_id: id, target: proposal.target });
  return proposal;
}

// ---------------------------------------------------------------------------
// CLI：nyra optimize <propose|list|show|edit|approve|reject|apply|verify|revert>
// ---------------------------------------------------------------------------

function getFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function splitCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printProposal(p: OptimizationProposal): void {
  console.log(`提议 ${p.id}（${p.status}）`);
  console.log(`  来源：${p.source.kind}${p.source.ref ? ` ${p.source.ref}` : ""}`);
  if (p.armKey) console.log(`  UCB 臂：${p.armKey}`);
  console.log(`  目标：${p.target}`);
  console.log(`  理由：${p.rationale}`);
  console.log(`  旧文本：${p.oldText ? p.oldText.slice(0, 200) : "（空 = 追加到文件末尾）"}`);
  console.log(`  新文本：${p.newText.slice(0, 200)}`);
  console.log(`  数据集：train ${p.datasets.train.length} / validation ${p.datasets.validation.length} / holdout ${p.datasets.holdout.length}`);
  console.log(`  测试：train ${p.tests.train.length} / validation ${p.tests.validation.length} / holdout ${p.tests.holdout.length}`);
  console.log(`  上限：循环 ${p.caps.maxIterations} 次，单次验证 ${p.caps.maxMinutes} 分钟；已改 ${p.iterations} 次，花费 $${p.costUsd}`);
  console.log(`  创建：${p.createdAt}，更新：${p.updatedAt}`);
  for (const h of p.history) console.log(`    ${h.at} ${h.action} ${h.by} ${h.note}`);
}

export function handleOptimize(args: string[], home: string, workdir: string): number {
  const [sub, ...rest] = args;
  const json = hasFlag(args, "--json");
  if (!sub) {
    console.log("用法：nyra optimize <propose|list|show|edit|approve|reject|apply|verify|revert|loop|arms> ...（loop/arms 详见 docs/governance.md）");
    return 0;
  }
  if (sub === "propose") {
    const target = getFlag(rest, "--target");
    if (!target) throw new OptimizerError("用法：nyra optimize propose --target <文件> [--from-regression <用例 id> | --new-text <文本>] ...");
    const proposal = proposeOptimization(home, {
      target,
      oldText: getFlag(rest, "--old-text") ?? undefined,
      newText: getFlag(rest, "--new-text") ?? undefined,
      rationale: getFlag(rest, "--rationale") ?? undefined,
      fromRegression: getFlag(rest, "--from-regression") ?? undefined,
      trainCases: splitCsv(getFlag(rest, "--train-cases")),
      validationCases: splitCsv(getFlag(rest, "--validation-cases")),
      holdoutCases: splitCsv(getFlag(rest, "--holdout-cases")),
      trainTests: splitCsv(getFlag(rest, "--train-tests")),
      validationTests: splitCsv(getFlag(rest, "--validation-tests")),
      holdoutTests: splitCsv(getFlag(rest, "--holdout-tests")),
      maxIterations: getFlag(rest, "--max-iterations") ? Number(getFlag(rest, "--max-iterations")) : undefined,
      maxMinutes: getFlag(rest, "--max-minutes") ? Number(getFlag(rest, "--max-minutes")) : undefined,
    });
    console.log(`提议已起草 ${proposal.id}（draft，须人批才生效）`);
    console.log(`  目标：${proposal.target}`);
    console.log(`  新文本：${proposal.newText.slice(0, 200)}`);
    return 0;
  }
  if (sub === "list") {
    const status = getFlag(rest, "--status") as ProposalStatus | null;
    const rows = listProposals(home, status ? { status } : undefined);
    if (json) {
      printJson(rows);
    } else if (rows.length === 0) {
      console.log("没有提议");
    } else {
      for (const p of rows) console.log(`${p.id} ${p.status} ${p.target}（${p.source.kind}${p.source.ref ? ` ${p.source.ref}` : ""}，已改 ${p.iterations}/${p.caps.maxIterations} 次）${p.createdAt}`);
    }
    return 0;
  }
  if (sub === "show") {
    const id = rest[0];
    if (!id) throw new OptimizerError("用法：nyra optimize show <提议 id>");
    const proposal = getProposal(home, id);
    if (json) printJson(proposal);
    else printProposal(proposal);
    return 0;
  }
  if (sub === "edit") {
    const id = rest[0];
    if (!id) throw new OptimizerError("用法：nyra optimize edit <提议 id> [--old-text <文本>] [--new-text <文本>] [--rationale <理由>]");
    const proposal = editProposal(home, id, {
      oldText: getFlag(rest, "--old-text") ?? undefined,
      newText: getFlag(rest, "--new-text") ?? undefined,
      rationale: getFlag(rest, "--rationale") ?? undefined,
    });
    console.log(`提议 ${proposal.id} 已修订（${proposal.status}）`);
    return 0;
  }
  if (sub === "approve" || sub === "reject") {
    const id = rest[0];
    if (!id) throw new OptimizerError(`用法：nyra optimize ${sub} <提议 id> [--yes]`);
    if (!hasFlag(rest, "--yes")) {
      console.log(`这一步是人批：${sub === "approve" ? "批准提议生效（之后 apply 才会改文件）" : "拒绝提议"}。确认请加 --yes。`);
      return 2;
    }
    const proposal = decideProposal(home, id, sub === "approve" ? "approved" : "rejected", "cli", { note: getFlag(rest, "--note") ?? undefined });
    console.log(`提议 ${proposal.id} 已标为 ${proposal.status}`);
    return 0;
  }
  if (sub === "apply") {
    const id = rest[0];
    if (!id) throw new OptimizerError("用法：nyra optimize apply <提议 id> [--yes]");
    if (!hasFlag(rest, "--yes")) {
      console.log("apply 会真的改目标文件。确认请加 --yes。");
      return 2;
    }
    const proposal = applyProposal(home, id, workdir);
    console.log(`提议 ${proposal.id} 已改进 ${proposal.target}（第 ${proposal.iterations} 次），状态 applied；下一步 verify。`);
    return 0;
  }
  if (sub === "verify") {
    const id = rest[0];
    if (!id) throw new OptimizerError("用法：nyra optimize verify <提议 id>");
    const outcome = verifyProposal(home, id, workdir);
    const v = outcome.validation;
    const h = outcome.holdout;
    console.log(`validation：${v.ran ? (v.ok ? "通过" : "未通过") : "无测试（跳过）"}`);
    console.log(`holdout：${h.ran ? (h.ok ? "通过" : "未通过") : "无测试（跳过）"}`);
    if (outcome.proposal.status === "released") {
      console.log(`提议 ${id} 已放行（released）`);
    } else {
      console.log(`提议 ${id} 验证未通过，已自动回滚${outcome.reverted ? "" : "（回滚失败：" + (outcome.revertError ?? "") + "，须人工恢复）"}，状态 failed`);
      if (!v.ok && v.output) console.log(v.output.slice(-2000));
      if (!h.ok && h.output) console.log(h.output.slice(-2000));
    }
    return 0;
  }
  if (sub === "revert") {
    const id = rest[0];
    if (!id) throw new OptimizerError("用法：nyra optimize revert <提议 id> [--yes]");
    if (!hasFlag(rest, "--yes")) {
      console.log("revert 会把目标文件改回提议之前的状态，提议回到 draft。确认请加 --yes。");
      return 2;
    }
    const proposal = revertProposal(home, id, workdir);
    console.log(`提议 ${proposal.id} 已回滚，回到 draft，可修订再批`);
    return 0;
  }
  throw new OptimizerError("用法：nyra optimize <propose|list|show|edit|approve|reject|apply|verify|revert|loop|arms> ...（loop/arms 详见 docs/governance.md）");
}
