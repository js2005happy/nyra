// src/stepCheckpointCli.ts — G-P1-40 步级检查点 + 时间旅行的 CLI：`nyra checkpoint`。
//
//   list <运行 id> [--json]                       列一条运行的步级检查点
//   show <运行 id> <步骤 id> [--json]             看一条检查点（状态、输入指纹、输出摘要）
//   history <运行 id> [--json]                    状态演变（get_state_history，作废的也列出来）
//   update <运行 id> <步骤 id> --set 键=值 [--set ...] [--unset 键]
//                                                 回到某一步改状态值，后续检查点作废
//   replay <运行 id> <步骤 id> [--dry-run] [--yes]
//                                                 从某一步重放后续步骤（花钱/审批的步骤须 --yes）
//   store [--backend memory|file|remote] [--remote-url <地址>]
//                                                 看 / 改检查点后端（默认 file）
//
// 只改本机状态与配置；replay 真跑工作流（写/发动作都会真发生），
// 花钱或审批的步骤没加 --yes 直接拒绝，不静默跑。
import { join } from "node:path";
import { loadConfig, resolveHome, saveConfig } from "./config.ts";
import { RunStore } from "./runs.ts";
import {
  describeStepCheckpointStore,
  getStepStateHistory,
  planReplay,
  resolveCheckpointStep,
  resolveStepCheckpointStore,
  updateStepState,
  type StepCheckpoint,
  type StepCheckpointBackend,
} from "./stepCheckpoints.ts";
import {
  getWorkflowRun,
  replayWorkflowFromCheckpoint,
  type WorkflowRun,
} from "./workflow.ts";

const USAGE = [
  "用法：",
  "  nyra checkpoint list <运行 id> [--json]   列一条运行的步级检查点（步骤、状态、是否作废）",
  "  nyra checkpoint show <运行 id> <步骤 id> [--json]   看一条检查点（状态值、输入指纹、输出摘要）",
  "  nyra checkpoint history <运行 id> [--json]   状态演变：每一步跑完时的状态（作废的也列出来）",
  "  nyra checkpoint update <运行 id> <步骤 id> --set 键=值 [--set ...] [--unset 键]   回到某一步改状态值（只改 steps.<步骤>.output / .ok），后续检查点作废",
  "  nyra checkpoint replay <运行 id> <步骤 id> [--dry-run] [--yes]   从某一步重放后续步骤；后面有调模型/审批的步骤时须加 --yes，--dry-run 只看计划不跑",
  "  nyra checkpoint store [--backend memory|file|remote] [--remote-url <地址>]   看 / 改检查点后端（默认 file；remote 须配地址，凭据只读 NYRA_STEP_CHECKPOINT_TOKEN 环境变量）",
  "说明：步级检查点是“跑步骤时的状态快照”（每步记输出摘要与输入指纹，不记文件原文、不记密钥），与写文件前的快照（nyra restore）是两层，互不覆盖；只有 fixed 形态支持重放。",
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

function stateSummary(state: Record<string, unknown>): string {
  const keys = Object.keys(state);
  if (!keys.length) return "（空状态）";
  return keys.slice(0, 8).map((k) => `${k}=${JSON.stringify(state[k])}`).join("、") +
    (keys.length > 8 ? `，另 ${keys.length - 8} 个键` : "");
}

function printCheckpoint(cp: StepCheckpoint): void {
  process.stdout.write(
    `${cp.stepId}（定义第 ${cp.stepIndex + 1} 步）[${cp.status}]${cp.invalidated ? " 已作废" : ""} ${cp.createdAt}` +
    `${cp.invalidated && cp.invalidatedReason ? `（${cp.invalidatedReason}）` : ""}\n` +
    `  状态：${stateSummary(cp.state)}\n` +
    `  输入指纹：${cp.inputFingerprint.slice(0, 16)}…，输出摘要：${(cp.outputSummary || "（无）").slice(0, 120)}` +
    `${typeof cp.spentUsd === "number" ? `，花费 $${cp.spentUsd.toFixed(4)}` : ""}\n`,
  );
}

function printPlan(run: WorkflowRun, plan: ReturnType<typeof planReplay>): void {
  process.stdout.write(`从步骤 ${plan.fromStepId}（检查点 ${plan.fromNodeId}）重放运行 ${run.id}（工作流 ${run.workflow}）：\n`);
  if (!plan.steps.length) {
    process.stdout.write("后面已经没有步骤了（这一步就是最后一步），重放什么都不做。\n");
    return;
  }
  for (const s of plan.steps) {
    const kind = s.kind === "deterministic" ? "确定性" : s.kind === "costed" ? "花钱（调模型）" : "审批";
    process.stdout.write(`  ${s.id}（${s.type}）：${kind}\n`);
  }
  if (plan.needsConfirmation) {
    process.stdout.write("后面有调模型 / 审批的步骤，重放会真花钱、真问人，须加 --yes 确认（--dry-run 只看计划不跑）。\n");
  } else {
    process.stdout.write("后面全是确定性步骤，重放不花钱、不问人。\n");
  }
}

/** update 的决定进原运行的事件链（只记元数据，不记状态原文）；写不上不破坏更新。
 *  注意：RunStore 的运行 id 与工作流运行 id 是两回事——工作流跑起来时
 *  建的 RunStore 运行以 session_id `workflow-<工作流运行 id>` 挂在账本里，
 *  先按 session_id 找到它，再拿它的 run_id 写事件；直接拿 workflow- 前缀
 *  当 run_id 传会被 RUN_ID_RE 拦下。 */
function appendUpdatedEvent(home: string, runId: string, stepId: string, invalidatedCount: number): void {
  try {
    const store = new RunStore(join(home, "runs"));
    const rsRun = store.list().find((s) => s.session_id === `workflow-${runId}`);
    if (!rsRun) return;
    store.appendEvent(rsRun.run_id, "step_checkpoint_updated", {
      workflow_run_id: runId, step_id: stepId, invalidated: invalidatedCount,
    });
  } catch { /* 事件写不上不破坏更新 */ }
}

export async function handleCheckpoint(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  try {
    if (action === "list" || action === "history") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write(`错误：用法：nyra checkpoint ${action} <运行 id> [--json]\n`);
        return 2;
      }
      const store = resolveStepCheckpointStore(resolvedHome);
      const list = await getStepStateHistory(store, runId);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(list, null, 2) + "\n");
        return 0;
      }
      if (!list.length) {
        process.stdout.write(`运行 ${runId} 还没有步级检查点（还没跑过步骤，或后端里没有这条运行）。\n`);
        return 0;
      }
      for (const cp of list) printCheckpoint(cp);
      return 0;
    }
    if (action === "show") {
      const runId = argv[1] ?? "";
      const stepId = argv[2] ?? "";
      if (!runId || !stepId) {
        process.stderr.write("错误：用法：nyra checkpoint show <运行 id> <步骤 id> [--json]\n");
        return 2;
      }
      const store = resolveStepCheckpointStore(resolvedHome);
      const list = await getStepStateHistory(store, runId);
      const cp = resolveCheckpointStep(list, stepId);
      if (!cp) {
        process.stderr.write(`错误：运行 ${runId} 里没有步骤 ${stepId} 的检查点\n`);
        return 1;
      }
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(cp, null, 2) + "\n");
        return 0;
      }
      printCheckpoint(cp);
      return 0;
    }
    if (action === "update") {
      const runId = argv[1] ?? "";
      const stepId = argv[2] ?? "";
      if (!runId || !stepId) {
        process.stderr.write("错误：用法：nyra checkpoint update <运行 id> <步骤 id> --set 键=值 [--set ...] [--unset 键]\n");
        return 2;
      }
      const sets = flagValues(argv, "--set");
      const unsets = flagValues(argv, "--unset");
      if (!sets.length && !unsets.length) {
        process.stderr.write("错误：update 至少要给一个 --set 键=值 或 --unset 键\n");
        return 2;
      }
      const patch: Record<string, unknown> = {};
      for (const s of sets) {
        const eq = s.indexOf("=");
        if (eq <= 0) {
          process.stderr.write(`错误：--set 须是 键=值 的形式：${s}\n`);
          return 2;
        }
        const key = s.slice(0, eq);
        const raw = s.slice(eq + 1);
        // .ok 键只认 true/false；.output 键是字符串原值（"null" 也不转义，就是这 4 个字）。
        patch[key] = key.endsWith(".ok") ? raw === "true" : raw;
      }
      // 只有 --unset 时 patch 为空也允许（updateStepState 里空 patch 跳过
      // 值校验，只按 unset 删键）。
      const store = resolveStepCheckpointStore(resolvedHome);
      const { checkpoint, invalidatedCount } = await updateStepState(store, runId, stepId, patch, unsets);
      appendUpdatedEvent(resolvedHome, runId, checkpoint.stepId, invalidatedCount);
      process.stdout.write(
        `已改步骤 ${checkpoint.stepId} 的状态（运行 ${runId}）。` +
        (invalidatedCount
          ? `后续 ${invalidatedCount} 条检查点已作废（它们是按旧值算出来的），请从这一步重放。\n`
          : "后续没有检查点需要作废。\n"),
      );
      return 0;
    }
    if (action === "replay") {
      const runId = argv[1] ?? "";
      const stepId = argv[2] ?? "";
      if (!runId || !stepId) {
        process.stderr.write("错误：用法：nyra checkpoint replay <运行 id> <步骤 id> [--dry-run] [--yes]\n");
        return 2;
      }
      const run = getWorkflowRun(resolvedHome, runId);
      if (!run) {
        process.stderr.write(`错误：没有这个运行：${runId}\n`);
        return 1;
      }
      const store = resolveStepCheckpointStore(resolvedHome);
      const checkpoints = await store.load(runId);
      const plan = planReplay(run.definition, checkpoints, stepId);
      if (!plan.supported) {
        process.stderr.write(`错误：${plan.reason ?? "这个运行不支持重放"}\n`);
        return 1;
      }
      if (argv.includes("--dry-run")) {
        printPlan(run, plan);
        return 0;
      }
      if (plan.needsConfirmation && !argv.includes("--yes")) {
        printPlan(run, plan);
        process.stderr.write("错误：后面有调模型 / 审批的步骤，重放须加 --yes 确认（先 --dry-run 看计划）。\n");
        return 2;
      }
      const req = {
        workdir: process.cwd(),
        mode: "normal" as const,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      };
      const { run: newRun } = await replayWorkflowFromCheckpoint(resolvedHome, runId, stepId, req, {
        stepCheckpointStore: store,
        confirmCosted: argv.includes("--yes"),
      });
      if (!newRun) {
        process.stderr.write("错误：重放没有产出新运行\n");
        return 1;
      }
      process.stdout.write(
        `重放完成：新运行 ${newRun.id}（从 ${runId} 的步骤 ${plan.fromStepId} 重放），` +
        `状态 ${newRun.status}，节点 ${newRun.nodes.length} 个` +
        `${typeof newRun.spentUsd === "number" ? `，花费 $${newRun.spentUsd.toFixed(4)}` : ""}` +
        `${newRun.error ? `，失败：${newRun.error.slice(0, 200)}` : ""}\n`,
      );
      return newRun.status === "completed" || newRun.status === "awaiting_approval" ? 0 : 1;
    }
    if (action === "store") {
      const backend = flagValue(argv, "--backend");
      const remoteUrl = flagValue(argv, "--remote-url");
      if (!backend && !remoteUrl) {
        const d = describeStepCheckpointStore(resolvedHome, loadConfig(resolvedHome));
        process.stdout.write(
          `检查点后端：${d.backend}\n` +
          (d.remoteUrl ? `远端地址：${d.remoteUrl}\n` : "远端地址：未配\n") +
          `远端凭据：${d.tokenConfigured ? "已配（环境变量 NYRA_STEP_CHECKPOINT_TOKEN）" : "未配"}\n` +
          "改后端：nyra checkpoint store --backend memory|file|remote [--remote-url <地址>]（remote 须配地址）\n",
        );
        return 0;
      }
      if (backend && backend !== "memory" && backend !== "file" && backend !== "remote") {
        process.stderr.write("错误：--backend 只认 memory / file / remote\n");
        return 2;
      }
      if (backend === "remote" && !remoteUrl) {
        const d = describeStepCheckpointStore(resolvedHome, loadConfig(resolvedHome));
        if (!d.remoteUrl) {
          process.stderr.write("错误：remote 后端须配地址：--remote-url <地址>（或先配 config.json 的 step_checkpoint_remote_url）\n");
          return 2;
        }
      }
      const patch: Record<string, unknown> = {};
      if (backend) patch.step_checkpoint_store = backend as StepCheckpointBackend;
      if (remoteUrl) patch.step_checkpoint_remote_url = remoteUrl;
      saveConfig(resolvedHome, patch);
      const d = describeStepCheckpointStore(resolvedHome, loadConfig(resolvedHome));
      process.stdout.write(`检查点后端已改成 ${d.backend}${d.remoteUrl ? `（远端地址 ${d.remoteUrl}）` : ""}。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知动作 checkpoint ${action}\n${USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
