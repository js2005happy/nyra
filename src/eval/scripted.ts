// src/eval/scripted.ts — M5（OpenMausBot 借鉴）：脚本化行为评测。
//
// 不调模型、不花钱的回放评测：脚本是一串固定的工具调用（tool + args +
// 预期），在临时 workdir/home 里真跑工具（executeTool），把每步的
// 结果哈希、终态文件树哈希记成金标（GoldenTrace）。下次重跑时逐步
// 比对：工具序列、参数哈希、结果哈希、终态哈希有一处对不上就失败。
// 与 20 题真模型基线并存、不替代它——真基线仍是金标准（docs/eval-results/）；
// 脚本化评测只管“工具行为有没有悄悄变了”（回归哨兵），不管“模型聪明不聪明”。
//
// 白名单：只读 + 工作区写工具。网络、发邮件、电脑操作、委派一律不许进脚本。
// 审批：跑在一次性临时目录里，由调用方显式触发（scripts/eval.ts scripted），
// approveFn 只放行白名单内的工具；队列与定时任务里不跑脚本化评测。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, newToolContext, TOOL_SCHEMAS } from "../tools.ts";
import { evalHash, type EvalAdapter, type EvalCheck, type EvalOutcome } from "./runner.ts";
import type { EvalTask } from "./catalog.ts";

export interface ScriptedStep {
  tool: string;
  args: Record<string, unknown>;
  /** 默认 ok=true（结果不能以“错误”开头）；contains 是结果里必须出现的子串。 */
  expect?: { ok?: boolean; contains?: string | string[] };
}

export interface ScriptedGoldenStep {
  tool: string;
  argsHash: string;
  resultHash: string;
  ok: boolean;
}

export interface GoldenTrace {
  version: 1;
  taskId: string;
  scriptHash: string;
  steps: ScriptedGoldenStep[];
  finalTreeHash: string;
  recordedAt: string;
}

export const SCRIPTED_SUITE = "nyra-scripted-v1";
export const SCRIPTED_GOLDEN_DIR = "evals/golden";

/** 仓内金标目录（按模块路径算，不靠 cwd，与仓内探针同款做法）。 */
export function defaultGoldenDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evals", "golden");
}

/** 脚本里能用的工具：只读 + 工作区写。其他的（联网、发信、电脑操作、委派）一律不许。 */
export const SCRIPTED_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file", "write_file", "edit_file", "apply_patch", "list_dir", "shell",
]);

/**
 * 结果归一化：把当次运行的绝对路径换成占位符再哈希，否则 record 与
 * replay 的 workdir 不同、同一结果也会算出不同哈希。
 */
export function normalizeScriptedResult(result: string, workdir: string, home: string): string {
  return result.split(workdir).join("$WORKDIR").split(home).join("$HOME");
}

export function hashScriptedResult(result: string, workdir: string, home: string): string {
  return createHash("sha256").update(normalizeScriptedResult(result, workdir, home), "utf-8").digest("hex");
}

/** 终态文件树哈希：相对路径 + 内容哈希，按路径排序。空目录不计入。 */
export function hashFileTree(root: string): string {
  const entries: [string, string][] = [];
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        entries.push([relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex")]);
      }
    }
  };
  walk(root);
  return createHash("sha256").update(JSON.stringify(entries), "utf-8").digest("hex");
}

export function goldenPath(goldenDir: string, taskId: string): string {
  return join(goldenDir, `${taskId}.json`);
}

export function loadGoldenTrace(goldenDir: string, taskId: string): GoldenTrace {
  const raw = JSON.parse(readFileSync(goldenPath(goldenDir, taskId), "utf-8")) as GoldenTrace;
  if (raw.version !== 1 || raw.taskId !== taskId || !Array.isArray(raw.steps) || typeof raw.finalTreeHash !== "string") {
    throw new Error(`金标文件无效：${taskId}（版本或任务不符）`);
  }
  return raw;
}

export class ScriptedAdapter implements EvalAdapter {
  constructor(private readonly opts: { goldenDir: string; mode: "record" | "replay" }) {}

  async preflight(task: EvalTask, _conditions: Parameters<EvalAdapter["preflight"]>[1]): Promise<string | null> {
    const steps = task.script;
    if (!steps || steps.length === 0) return `任务 ${task.id} 没有脚本步骤`;
    const known = new Set(TOOL_SCHEMAS.map((s) => (s.function as { name: string }).name));
    for (const step of steps) {
      if (!SCRIPTED_ALLOWED_TOOLS.has(step.tool)) return `脚本用了不在白名单里的工具：${step.tool}（脚本只许只读 + 工作区写工具）`;
      if (!known.has(step.tool)) return `脚本用了未知工具：${step.tool}`;
    }
    if (this.opts.mode === "replay" && !existsSync(goldenPath(this.opts.goldenDir, task.id))) {
      return `没有金标：${task.id}，先跑 record 录一版`;
    }
    return null;
  }

  async execute(
    task: EvalTask,
    _conditions: Parameters<EvalAdapter["execute"]>[1],
    context: { workdir: string; home: string; apiHelperPath?: string },
  ): Promise<EvalOutcome> {
    const { workdir, home } = context;
    const steps = task.script!;
    // 一次性临时目录里的放行：只放白名单内的工具（preflight 已拦过一遍，
    // 这里是第二道门，防脚本在执行前被改过）。mode 用 full：非交互 + auto
    // 会拒写（checkApproval 的门），full + approveFn 才是程序化跑法的正路；
    // 写只发生在本次运行的临时 workdir 里。
    const ctx = newToolContext({
      workdir,
      mode: "full",
      interactive: false,
      home,
      memoryPath: join(home, "memory.md"),
      skillsDir: join(home, "skills"),
      approveFn: async (tool: string) => SCRIPTED_ALLOWED_TOOLS.has(tool),
    });
    const checks: EvalCheck[] = [];
    const traceSteps: ScriptedGoldenStep[] = [];
    let allOk = true;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const argsHash = evalHash(step.args);
      let result: string;
      let ok = true;
      try {
        result = await executeTool(step.tool, structuredClone(step.args), ctx);
      } catch (e) {
        result = `错误：${e instanceof Error ? e.message : String(e)}`;
        ok = false;
      }
      const normalized = normalizeScriptedResult(result, workdir, home);
      const resultHash = evalHash(normalized);
      const isError = normalized.startsWith("错误");
      let stepOk = (step.expect?.ok ?? true) ? !isError : isError;
      if (stepOk && step.expect?.contains) {
        const wants: string[] = Array.isArray(step.expect.contains) ? step.expect.contains : [step.expect.contains];
        stepOk = wants.every((w: string) => normalized.includes(w));
      }
      traceSteps.push({ tool: step.tool, argsHash, resultHash, ok: stepOk });
      checks.push({
        id: `step:${i + 1}:${step.tool}`,
        passed: stepOk,
        evidence: stepOk ? `结果哈希 ${resultHash.slice(0, 12)}` : `结果不合预期：${normalized.slice(0, 200)}`,
      });
      if (!stepOk) allOk = false;
    }
    // 终态文件校验（task.expected.files：相对路径 →  exact 内容）。
    const expectedFiles = (task.expected as { files?: Record<string, string> } | undefined)?.files;
    if (expectedFiles) {
      for (const [rel, content] of Object.entries(expectedFiles)) {
        let actual: string | null = null;
        try {
          actual = readFileSync(join(workdir, rel), "utf-8");
        } catch {
          actual = null;
        }
        const passed = actual === content;
        checks.push({
          id: `file:${rel}`,
          passed,
          evidence: passed ? "内容与预期一致" : actual === null ? "文件不存在" : "内容与预期不一致",
        });
        if (!passed) allOk = false;
      }
    }
    const finalTreeHash = hashFileTree(workdir);
    const scriptHash = evalHash(steps);
    if (this.opts.mode === "record") {
      if (allOk) {
        mkdirSync(this.opts.goldenDir, { recursive: true });
        const trace: GoldenTrace = {
          version: 1,
          taskId: task.id,
          scriptHash,
          steps: traceSteps,
          finalTreeHash,
          recordedAt: new Date().toISOString(),
        };
        writeFileSync(goldenPath(this.opts.goldenDir, task.id), JSON.stringify(trace, null, 2) + "\n");
        checks.push({ id: "golden:recorded", passed: true, evidence: `金标已写 ${task.id}.json` });
      } else {
        checks.push({ id: "golden:recorded", passed: false, evidence: "步骤没全过，不写金标（金标只录通过的回放）" });
      }
    } else {
      const golden = loadGoldenTrace(this.opts.goldenDir, task.id);
      const stepsMatch =
        golden.scriptHash === scriptHash &&
        golden.steps.length === traceSteps.length &&
        golden.steps.every(
          (g, i) =>
            g.tool === traceSteps[i]!.tool &&
            g.argsHash === traceSteps[i]!.argsHash &&
            g.resultHash === traceSteps[i]!.resultHash &&
            g.ok === traceSteps[i]!.ok,
        );
      checks.push({
        id: "golden:steps",
        passed: stepsMatch,
        evidence: stepsMatch ? "工具序列与每步结果哈希与金标一致" : "与金标不一致（工具、参数或结果变了）",
      });
      const treeMatch = golden.finalTreeHash === finalTreeHash;
      checks.push({
        id: "golden:tree",
        passed: treeMatch,
        evidence: treeMatch ? "终态文件树哈希与金标一致" : "终态文件树与金标不一致",
      });
      if (!stepsMatch || !treeMatch) allOk = false;
    }
    // 不调模型：三项指标都是 0，不是未知。
    return {
      status: allOk ? "passed" : "failed",
      reason: allOk ? null : "脚本化回放未通过",
      checks,
      spentUsd: 0,
      interventions: 0,
      modelCalls: 0,
    };
  }
}

/**
 * 仓内金标脚本（3 个小脚本，只用只读 + 工作区写工具）。
 * 注意：步骤参数里不要写绝对路径、日期、随机数——回放要逐字节稳定。
 */
export const SCRIPTED_TASKS: EvalTask[] = [
  {
    id: "scripted-file-ops",
    category: "code",
    description: "读一份笔记、汇总成新文件、再列目录核对",
    acceptance: "summary.txt 内容与预期一致，目录里能看到两个文件",
    fixture: { "notes.txt": "alpha\nbeta\ngamma\n" },
    expected: { files: { "summary.txt": "共 3 行：alpha, beta, gamma\n" } },
    script: [
      { tool: "read_file", args: { path: "notes.txt" }, expect: { contains: "beta" } },
      { tool: "write_file", args: { path: "summary.txt", content: "共 3 行：alpha, beta, gamma\n" } },
      { tool: "list_dir", args: { path: "." }, expect: { contains: ["notes.txt", "summary.txt"] } },
      { tool: "read_file", args: { path: "summary.txt" }, expect: { contains: "共 3 行" } },
    ],
  },
  {
    id: "scripted-edit-patch",
    category: "code",
    description: "改一行配置、再读回来核对",
    acceptance: "config.txt 里 level=2，mode 不动",
    fixture: { "config.txt": "mode=auto\nlevel=1\n" },
    expected: { files: { "config.txt": "mode=auto\nlevel=2\n" } },
    script: [
      { tool: "edit_file", args: { path: "config.txt", old_text: "level=1", new_text: "level=2" } },
      { tool: "read_file", args: { path: "config.txt" }, expect: { contains: ["mode=auto", "level=2"] } },
    ],
  },
  {
    id: "scripted-shell-count",
    category: "code",
    description: "用 shell 数行数、把结果写进文件",
    acceptance: "count.txt 写着 3，两个源文件不动",
    fixture: { "a.txt": "x\ny\n", "b.txt": "z\n" },
    expected: { files: { "count.txt": "3\n" } },
    script: [
      { tool: "shell", args: { command: "cat a.txt b.txt | wc -l | tr -d ' '", timeout: 10 }, expect: { contains: "3" } },
      { tool: "write_file", args: { path: "count.txt", content: "3\n" } },
      { tool: "read_file", args: { path: "a.txt" }, expect: { contains: "x\ny" } },
    ],
  },
];
