// src/interruptCli.ts — G-P1-41 结构化人机回环的 CLI：`nyra interrupt`。
//
//   list [--status pending|resolved] [--json]   列中断单
//   show <中断单 id> [--json]                   看一张中断单（提示词、schema、上下文摘要、决定）
//   respond <中断单 id> --set 键=值 [--set ...]  回 respond 决定（值按 response_schema 校验）
//   edit <中断单 id> --set 键=值 [--set ...]     回 edit 决定（改步骤输入；before 点改输入，after 点改 output）
//   resume <中断单 id> [--decision accept|ignore|respond|edit] [--set 键=值 ...]
//                                               带着决定续跑（真跑工作流，写/发动作都会真发生）
//
// 决定记进原运行的事件链（workflow_interrupt_resolved / workflow_interrupt_resumed），
// 只记决定与参数键，不记回复原文。resume 续跑时审批节点与成本硬顶照常。
// 本机 CLI 操作者即机主，resolvedBy 记 local（与 hitlCli 同款口径）。
import { join } from "node:path";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import {
  getInterrupt,
  listInterrupts,
  resolveInterrupt,
  InterruptError,
  type HumanInterrupt,
  type InterruptDecision,
} from "./interrupts.ts";
import {
  editableInputTypes,
  getWorkflowRun,
  resumeWorkflowFromInterrupt,
  WorkflowError,
  type WorkflowRun,
} from "./workflow.ts";
import type { ProviderLike } from "./providers.ts";

const USAGE = [
  "用法：",
  "  nyra interrupt list [--status pending|resolved] [--json]   列中断单（默认全部，新的在前）",
  "  nyra interrupt show <中断单 id> [--json]   看一张中断单（提示词、schema、上下文摘要、决定）",
  "  nyra interrupt respond <中断单 id> --set 键=值 [--set ...]   回 respond 决定（值按 response_schema 校验；schema 没字段时可不带 --set）",
  "  nyra interrupt edit <中断单 id> --set 键=值 [--set ...]   回 edit 决定（before 点改该步输入，after 点只能改 output）",
  "  nyra interrupt resume <中断单 id> [--decision accept|ignore|respond|edit] [--set 键=值 ...]   带着决定续跑；已回过的单直接续跑，没回的单须加 --decision 或 --set 一次性回掉",
  "说明：中断单只在工作流配了 interrupt_before / interrupt_after 的步骤前后出现（须机主显式配，默认不停）；accept 原样继续，ignore 跳过该步，respond 只回值不改参数，edit 改参数后只重跑受影响的步骤；续跑时审批节点与成本硬顶照常。",
].join("\n");

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === flag) out.push(argv[i + 1]);
  }
  return out;
}

function parseSetPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new InterruptError(`--set 须是 键=值 的形式，现有：${p}`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

/** --set 的字符串值按目标类型转：number 须是有限数字，boolean 只认 true / false。 */
function coerceValues(raw: Record<string, string>, types: Record<string, "string" | "number" | "boolean">): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = types[k];
    if (t === undefined) {
      out[k] = v;
      continue;
    }
    if (t === "number") {
      const n = Number(v);
      if (v.trim() === "" || !Number.isFinite(n)) throw new InterruptError(`${k} 须是数字，现有：${v}`);
      out[k] = n;
    } else if (t === "boolean") {
      if (v !== "true" && v !== "false") throw new InterruptError(`${k} 须是 true / false，现有：${v}`);
      out[k] = v === "true";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** edit 决定的人改值按步骤类型转：after 点只能改 output；before 点按
 *  该步可改的输入键转（键不在可改列表里时由校验拒绝）。 */
function coerceEditValues(home: string, it: HumanInterrupt, raw: Record<string, string>): Record<string, string | number | boolean> {
  if (it.point === "after") {
    return coerceValues(raw, { output: "string" });
  }
  const run = getWorkflowRun(home, it.runId);
  if (!run) throw new InterruptError(`中断单 ${it.id} 对应的运行 ${it.runId} 找不到了`);
  const step = run.definition.steps.find((s) => s.id === it.stepId);
  if (!step) throw new InterruptError(`中断单 ${it.id} 对应的步骤 ${it.stepId} 不在运行定义里`);
  const allowed = editableInputTypes(step);
  if (!allowed) throw new InterruptError(`步骤 ${it.stepId}（${step.type}）没有可改的输入参数，不能 edit`);
  return coerceValues(raw, allowed);
}

/** 决定进原运行的事件链（只记元数据，不记回复原文）；写不上不破坏回单。
 *  注意：RunStore 的运行 id 与工作流运行 id 是两回事——工作流跑起来时建
 *  的 RunStore 运行以 session_id `workflow-<工作流运行 id>` 挂在账本里，
 *  先按 session_id 找到它，再拿它的 run_id 写事件（stepCheckpointCli 同款）。 */
function appendInterruptEvent(home: string, runId: string, type: string, fields: Record<string, unknown>): void {
  try {
    const store = new RunStore(join(home, "runs"));
    const rsRun = store.list().find((s) => s.session_id === `workflow-${runId}`);
    if (!rsRun) return;
    store.appendEvent(rsRun.run_id, type, { workflow_run_id: runId, ...fields });
  } catch { /* 事件写不上不破坏回单 */ }
}

function printInterrupt(it: HumanInterrupt): void {
  process.stdout.write(
    `${it.id} [${it.status}] ${it.workflow} / 步骤 ${it.stepId}（${it.point === "before" ? "跑前" : "跑后"}） ${it.createdAt}\n` +
    `  提示：${it.prompt}\n` +
    `  上下文：${it.contextSummary}\n` +
    (it.schema.fields.length
      ? `  可回字段：${it.schema.fields.map((f) => `${f.name}（${f.type}${f.required ? "，必填" : ""}${f.description ? `：${f.description}` : ""}）`).join("、")}\n`
      : "  可回字段：（无，respond 可不带值）\n") +
    (it.decision ? `  决定：${it.decision}${it.resolvedAt ? `，${it.resolvedAt}` : ""}${it.resolvedBy ? `，由 ${it.resolvedBy}` : ""}\n` : "") +
    (it.response ? `  回的值：${JSON.stringify(it.response)}\n` : "") +
    (it.editedValues ? `  改的值：${JSON.stringify(it.editedValues)}\n` : ""),
  );
}

function printRunSummary(run: WorkflowRun): void {
  const spent = typeof run.spentUsd === "number" ? `$${run.spentUsd.toFixed(4)}` : "未知（有调用没报用量）";
  process.stdout.write(`运行 ${run.id}：${run.status}（${run.nodes.length} 个节点，已花 ${spent}）\n`);
  if (run.status === "awaiting_approval") {
    process.stdout.write(`审批节点 ${run.pendingNodeId ?? "?"} 已进审阅队列（审阅项 ${run.reviewItemId ?? "?"}）。\n先 nyra review approve ${run.reviewItemId ?? ""}（或 reject），再 nyra workflow resume ${run.id}\n`);
  }
  if (run.status === "awaiting_interrupt") {
    process.stdout.write(`步骤 ${run.pendingNodeId ?? "?"} 在等人工回环（中断单 ${run.pendingInterruptId ?? "?"}）。\n先 nyra interrupt show ${run.pendingInterruptId ?? ""} 看一眼，再 nyra interrupt respond/edit ${run.pendingInterruptId ?? ""} --set 键=值，最后 nyra interrupt resume ${run.pendingInterruptId ?? ""}\n`);
  }
  if (run.status === "failed" && run.error) {
    process.stdout.write(`失败原因：${run.error}\n`);
  }
}

export async function handleInterrupt(argv: string[], home: string, opts?: { providerFactory?: () => Promise<ProviderLike> }): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  try {
    if (action === "list") {
      const status = flagValue(argv, "--status");
      if (status !== null && status !== "pending" && status !== "resolved") {
        process.stderr.write("错误：--status 只认 pending / resolved\n");
        return 2;
      }
      const items = listInterrupts(resolvedHome, status ?? undefined);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(items, null, 2) + "\n");
        return 0;
      }
      if (!items.length) {
        process.stdout.write(status ? `没有 ${status === "pending" ? "挂起的" : "已回的"}中断单。\n` : "还没有中断单（工作流配了 interrupt_before / interrupt_after 的步骤跑到时才会建单）。\n");
        return 0;
      }
      for (const it of items) {
        process.stdout.write(`${it.id} [${it.status}] ${it.workflow} / ${it.stepId}（${it.point === "before" ? "跑前" : "跑后"}）${it.decision ? ` 决定：${it.decision}` : ""} ${it.createdAt}\n  ${it.prompt.slice(0, 120)}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      if (!id) { process.stderr.write("错误：用法：nyra interrupt show <中断单 id> [--json]\n"); return 2; }
      const it = getInterrupt(resolvedHome, id);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(it, null, 2) + "\n");
        return 0;
      }
      printInterrupt(it);
      if (it.status === "pending") {
        process.stdout.write(`还没回：accept/ignore 用 resume --decision；respond/edit 先回值再 resume。\n  nyra interrupt resume ${it.id} --decision accept\n`);
      }
      return 0;
    }
    if (action === "respond" || action === "edit") {
      const id = argv[1] ?? "";
      if (!id) { process.stderr.write(`错误：用法：nyra interrupt ${action} <中断单 id> --set 键=值 [--set ...]\n`); return 2; }
      const it = getInterrupt(resolvedHome, id);
      if (it.status !== "pending") { process.stderr.write(`错误：中断单 ${id} 已经是 ${it.status}，不能再回\n`); return 1; }
      const raw = parseSetPairs(flagValues(argv, "--set"));
      if (action === "respond") {
        const types: Record<string, "string" | "number" | "boolean"> = {};
        for (const f of it.schema.fields) types[f.name] = f.type;
        const response = coerceValues(raw, types);
        resolveInterrupt(resolvedHome, id, "respond", { response, by: "local" });
        appendInterruptEvent(resolvedHome, it.runId, "workflow_interrupt_resolved", { interrupt_id: id, decision: "respond" });
        process.stdout.write(`中断单 ${id} 已回 respond。续跑：nyra interrupt resume ${id}\n`);
      } else {
        if (!Object.keys(raw).length) { process.stderr.write("错误：edit 须至少改一个值（--set 键=值）\n"); return 2; }
        const editedValues = coerceEditValues(resolvedHome, it, raw);
        resolveInterrupt(resolvedHome, id, "edit", { editedValues, by: "local" });
        appendInterruptEvent(resolvedHome, it.runId, "workflow_interrupt_resolved", { interrupt_id: id, decision: "edit" });
        process.stdout.write(`中断单 ${id} 已回 edit（改的值：${JSON.stringify(editedValues)}）。续跑：nyra interrupt resume ${id}\n`);
      }
      return 0;
    }
    if (action === "resume") {
      const id = argv[1] ?? "";
      if (!id) { process.stderr.write("错误：用法：nyra interrupt resume <中断单 id> [--decision accept|ignore|respond|edit] [--set 键=值 ...]\n"); return 2; }
      const it = getInterrupt(resolvedHome, id);
      const decisionFlag = flagValue(argv, "--decision");
      if (decisionFlag !== null && !["accept", "ignore", "respond", "edit"].includes(decisionFlag)) {
        process.stderr.write("错误：--decision 只认 accept / ignore / respond / edit\n");
        return 2;
      }
      const raw = parseSetPairs(flagValues(argv, "--set"));
      if (it.status === "pending") {
        // 没回的单：resume 时一次性回掉（--decision 或 --set 二选一）。
        if (decisionFlag === "accept" || decisionFlag === "ignore") {
          if (Object.keys(raw).length) { process.stderr.write(`错误：${decisionFlag} 不带值（--set 请配 respond/edit 用）\n`); return 2; }
          resolveInterrupt(resolvedHome, id, decisionFlag as InterruptDecision, { by: "local" });
          appendInterruptEvent(resolvedHome, it.runId, "workflow_interrupt_resolved", { interrupt_id: id, decision: decisionFlag });
        } else if (decisionFlag === "respond") {
          const types: Record<string, "string" | "number" | "boolean"> = {};
          for (const f of it.schema.fields) types[f.name] = f.type;
          resolveInterrupt(resolvedHome, id, "respond", { response: coerceValues(raw, types), by: "local" });
          appendInterruptEvent(resolvedHome, it.runId, "workflow_interrupt_resolved", { interrupt_id: id, decision: "respond" });
        } else if (decisionFlag === "edit") {
          if (!Object.keys(raw).length) { process.stderr.write("错误：edit 须至少改一个值（--set 键=值）\n"); return 2; }
          resolveInterrupt(resolvedHome, id, "edit", { editedValues: coerceEditValues(resolvedHome, it, raw), by: "local" });
          appendInterruptEvent(resolvedHome, it.runId, "workflow_interrupt_resolved", { interrupt_id: id, decision: "edit" });
        } else if (Object.keys(raw).length) {
          const types: Record<string, "string" | "number" | "boolean"> = {};
          for (const f of it.schema.fields) types[f.name] = f.type;
          resolveInterrupt(resolvedHome, id, "respond", { response: coerceValues(raw, types), by: "local" });
          appendInterruptEvent(resolvedHome, it.runId, "workflow_interrupt_resolved", { interrupt_id: id, decision: "respond" });
        } else {
          process.stderr.write(`错误：中断单 ${id} 还没回：先 nyra interrupt respond/edit ${id} --set 键=值，或 resume 时加 --decision accept|ignore\n`);
          return 2;
        }
      } else if (decisionFlag !== null || Object.keys(raw).length) {
        process.stderr.write(`错误：中断单 ${id} 已经是 ${it.status}，不能再改决定，直接 resume\n`);
        return 2;
      }
      const run = await resumeWorkflowFromInterrupt(resolvedHome, it.runId, {
        workdir: process.cwd(), mode: "normal", interactive: false,
        providerFactory: opts?.providerFactory,
      });
      printRunSummary(run);
      return run.status === "completed" || run.status === "awaiting_approval" || run.status === "awaiting_interrupt" ? 0 : 1;
    }
    process.stderr.write(`错误：不认的动作：${action}\n${USAGE}\n`);
    return 2;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`错误：${message}\n`);
    return 1;
  }
}
