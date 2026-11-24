// tests/node/test-script-purity.test.ts — Pi Bot 借鉴第 1 条：脚本内容判定 + 摘要预授权。
//
// 覆盖：四种语言的纯/不纯判定矩阵、摘要、shell 命令解析、预授权账本
//（授权/撤销/损坏备份/审计）、快路径三态、checkApproval 接线（只在例行
// 上下文里生效）、工作流全链路（trial → activate 钉摘要 → 跑 → 改内容
// 就拒绝 → 删工作流撤销授权）、时间线渲染、SIEM 来源。全部在临时 home
// 里跑；唯一真执行的命令是 node -e（CI 三平台都有 node），不碰真模型、
// 不碰真文件系统外的东西。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  judgeScript,
  scriptDigest,
  scriptScopeId,
  parseShellScript,
  SCRIPT_PURE_CODE_MAX,
} from "../../src/scriptPurity.ts";
import {
  grantPreauth,
  listPreauth,
  findPreauth,
  revokePreauth,
  loadPreauth,
  readScriptPreauthAudit,
  pinWorkflowScripts,
  checkScriptFastPath,
  workflowRoutineId,
  ScriptPreauthError,
} from "../../src/scriptPreauth.ts";
import { checkApproval, newToolContext, ToolError } from "../../src/tools.ts";
import {
  importWorkflow,
  runWorkflowByName,
  trialWorkflow,
  activateWorkflow,
  removeWorkflow,
  type WorkflowRunRequest,
} from "../../src/workflow.ts";
import { handleScript } from "../../src/scriptCli.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { AUDIT_SOURCES } from "../../src/costCaps.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-script-test-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function reqFor(home: string): WorkflowRunRequest {
  return { workdir: home, mode: "normal", interactive: false };
}

// ---------------------------------------------------------------------------
// Python 判定
// ---------------------------------------------------------------------------

test("判定 Python：白名单模块与 sys 受限成员是纯的", () => {
  expect(judgeScript("python", "import json\nprint(json.dumps({\"a\": 1}))").pure).toBe(true);
  expect(judgeScript("python", "import sys\nprint(sys.argv)").pure).toBe(true);
  expect(judgeScript("python", "import math\nprint(math.sqrt(2))").pure).toBe(true);
  expect(judgeScript("python", "if __name__ == \"__main__\":\n    print(\"hi\")").pure).toBe(true);
  expect(judgeScript("python", "import re\nprint(re.findall(r\"\\d+\", \"a1b2\"))").pure).toBe(true);
});

test("判定 Python：开文件、求值、危险模块与别名都不纯", () => {
  expect(judgeScript("python", "open(\"x\").read()").pure).toBe(false);
  expect(judgeScript("python", "import os\nos.listdir(\".\")").pure).toBe(false);
  expect(judgeScript("python", "import sys as s\nprint(s.argv)").pure).toBe(false);
  expect(judgeScript("python", "from sys import modules").pure).toBe(false);
  expect(judgeScript("python", "eval(\"1+1\")").pure).toBe(false);
  expect(judgeScript("python", "x = 1\nprint(x.__class__)").pure).toBe(false);
  expect(judgeScript("python", "print(getattr(x, \"y\"))").pure).toBe(false);
  expect(judgeScript("python", "import json\nimport subprocess").pure).toBe(false);
  expect(judgeScript("python", "x = 1; import json").pure).toBe(false);
});

test("判定 Python：NFKC 折叠、编码声明、zip 标记与超大代码都不纯", () => {
  // 全角 exec：原文里看不到 exec，NFKC 折叠后才是 exec。
  const homoglyph = "\uFF45\uFF58\uFF45\uFF43";
  expect(homoglyph.normalize("NFKC")).toBe("exec");
  expect(judgeScript("python", `${homoglyph}("1+1")`).pure).toBe(false);
  expect(judgeScript("python", "# coding: utf-7\nprint(1)").pure).toBe(false);
  expect(judgeScript("python", "print(\"PK\u0005\u0006\")").pure).toBe(false);
  expect(judgeScript("python", "x = 1\n".repeat(20000)).pure).toBe(false);
  expect(judgeScript("python", "x = 1\n".repeat(10)).pure).toBe(true);
});

// ---------------------------------------------------------------------------
// JavaScript 判定
// ---------------------------------------------------------------------------

test("判定 JavaScript：白名单全局变量与纯计算是纯的", () => {
  expect(judgeScript("javascript", "console.log(JSON.stringify({a: 1}))").pure).toBe(true);
  expect(judgeScript("javascript", "const xs = [3, 1, 2]; console.log(xs.map((x) => x * 2).sort());").pure).toBe(true);
  expect(judgeScript("javascript", "console.log(`result: ${1 + 2}`)").pure).toBe(true);
  expect(judgeScript("javascript", "if (/^\\d+$/.test(\"123\")) console.log(\"num\");").pure).toBe(true);
  expect(judgeScript("javascript", "const o = {}; o[\"key\"] = 1; console.log(o.key);").pure).toBe(true);
  expect(judgeScript("javascript", "const a = 1;\nconst b = a / 2;\nconsole.log(b);").pure).toBe(true);
});

test("判定 JavaScript：能力名字、算出来的访问与歧义斜杠都不纯", () => {
  expect(judgeScript("javascript", "require(\"fs\").readFileSync(\"x\")").pure).toBe(false);
  expect(judgeScript("javascript", "console.log(process.env.HOME)").pure).toBe(false);
  expect(judgeScript("javascript", "eval(\"1\")").pure).toBe(false);
  expect(judgeScript("javascript", "const f = new Function(\"return 1\")").pure).toBe(false);
  expect(judgeScript("javascript", "console.log(x[y])").pure).toBe(false);
  expect(judgeScript("javascript", "console.log(a.constructor)").pure).toBe(false);
  expect(judgeScript("javascript", "this.x = 1").pure).toBe(false);
  expect(judgeScript("javascript", "import fs from \"fs\"").pure).toBe(false);
  expect(judgeScript("javascript", "const o = {}; o[\"__proto__\"] = {};").pure).toBe(false);
  expect(judgeScript("javascript", "if (x) { } /re/.test(y)").pure).toBe(false);
  expect(judgeScript("javascript", "console.log(fetch(\"https://example.com\"))").pure).toBe(false);
});

// ---------------------------------------------------------------------------
// Lua 判定
// ---------------------------------------------------------------------------

test("判定 Lua：白名单全局变量与受限 io/os 成员是纯的", () => {
  expect(judgeScript("lua", "print(math.floor(3.7))").pure).toBe(true);
  expect(judgeScript("lua", "local t = {1, 2, 3}\nprint(table.concat(t, \",\"))").pure).toBe(true);
  expect(judgeScript("lua", "io.write(\"hi\")").pure).toBe(true);
  expect(judgeScript("lua", "print(os.time())").pure).toBe(true);
});

test("判定 Lua：加载代码、开文件、跑命令都不纯", () => {
  expect(judgeScript("lua", "os.execute(\"ls\")").pure).toBe(false);
  expect(judgeScript("lua", "require(\"x\")").pure).toBe(false);
  expect(judgeScript("lua", "io.open(\"x\")").pure).toBe(false);
  expect(judgeScript("lua", "dofile(\"x.lua\")").pure).toBe(false);
  expect(judgeScript("lua", "local f = loadstring(\"return 1\")").pure).toBe(false);
  expect(judgeScript("lua", "os.remove(\"x\")").pure).toBe(false);
});

// ---------------------------------------------------------------------------
// PHP 判定
// ---------------------------------------------------------------------------

test("判定 PHP：白名单函数与顶层声明的函数是纯的", () => {
  expect(judgeScript("php", "<?php echo strtoupper(\"hi\");").pure).toBe(true);
  expect(judgeScript("php", "function add($a, $b) { return $a + $b; }\necho add(1, 2);").pure).toBe(true);
  expect(judgeScript("php", "echo json_encode([\"a\" => 1]);").pure).toBe(true);
  expect(judgeScript("php", "echo str_replace(\"a\", \"b\", \"aaa\");").pure).toBe(true);
});

test("判定 PHP：求值、包含、超全局变量与动态调用都不纯", () => {
  expect(judgeScript("php", "<?php eval(\"1\");").pure).toBe(false);
  expect(judgeScript("php", "include \"x.php\";").pure).toBe(false);
  expect(judgeScript("php", "echo $_GET[\"x\"];").pure).toBe(false);
  expect(judgeScript("php", "$f = \"system\"; $f(\"ls\");").pure).toBe(false);
  expect(judgeScript("php", "new Foo();").pure).toBe(false);
  expect(judgeScript("php", "Foo::bar();").pure).toBe(false);
  expect(judgeScript("php", "echo \"hi {$x}\";").pure).toBe(false);
  expect(judgeScript("php", "echo file_get_contents(\"x\");").pure).toBe(false);
});

// ---------------------------------------------------------------------------
// 摘要与未知语言
// ---------------------------------------------------------------------------

test("摘要：同一份代码摘要稳定，不同代码摘要不同，范围 id 带 script 前缀", () => {
  const a = scriptDigest("console.log(1)");
  expect(a).toBe(createHash("sha256").update("console.log(1)", "utf-8").digest("hex"));
  expect(a.length).toBe(64);
  expect(scriptDigest("console.log(1)")).toBe(a);
  expect(scriptDigest("console.log(2)")).not.toBe(a);
  expect(scriptScopeId(a)).toBe(`script:${a}`);
  expect(SCRIPT_PURE_CODE_MAX).toBe(64 * 1024);
});

test("判定：Ruby、Perl、PowerShell 直接判不纯", () => {
  expect(judgeScript("ruby", "puts 1").pure).toBe(false);
  expect(judgeScript("perl", "print 1").pure).toBe(false);
  expect(judgeScript("powershell", "Write-Host 1").pure).toBe(false);
  expect(judgeScript("ruby", "puts 1").reason).toContain("不支持的语言");
});

// ---------------------------------------------------------------------------
// Shell 命令解析
// ---------------------------------------------------------------------------

test("解析 shell 命令：内联与文件脚本能认出来，别的写法一律不认", () => {
  const home = tempHome();
  try {
    const workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, "util.py"), "import json\nprint(json.dumps({}))\n");
    const file = parseShellScript("python3 util.py --x 1", workdir, workdir);
    expect(file).not.toBeNull();
    expect(file!.language).toBe("python");
    expect(file!.file).toBe(join(workdir, "util.py"));
    expect(file!.args).toEqual(["--x", "1"]);
    const inline = parseShellScript("node -e \"console.log(1)\"", workdir, workdir);
    expect(inline).not.toBeNull();
    expect(inline!.language).toBe("javascript");
    expect(inline!.code).toBe("console.log(1)");
    expect(inline!.file).toBeNull();
    const pyInline = parseShellScript("python3 -c 'print(1)'", workdir, workdir);
    expect(pyInline?.code).toBe("print(1)");
    expect(parseShellScript("python3 ../outside.py", workdir, workdir)).toBeNull();
    expect(parseShellScript("python3 util.py && echo hi", workdir, workdir)).toBeNull();
    expect(parseShellScript("python3 -c \"print(1)\" | tee x", workdir, workdir)).toBeNull();
    expect(parseShellScript("ruby x.rb", workdir, workdir)).toBeNull();
    expect(parseShellScript("node --input-type=module -e \"1\"", workdir, workdir)).toBeNull();
    expect(parseShellScript("python3 -c 'print(1)", workdir, workdir)).toBeNull();
    expect(parseShellScript("python3 missing.py", workdir, workdir)).toBeNull();
    expect(parseShellScript("echo hi", workdir, workdir)).toBeNull();
    expect(parseShellScript("node -e \"console.log(process.env.HOME)\"", workdir, workdir)?.code).toBe(
      "console.log(process.env.HOME)",
    );
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 预授权账本
// ---------------------------------------------------------------------------

test("预授权账本：授权、查找、覆盖、按摘要撤销、整例行撤销", () => {
  const home = tempHome();
  try {
    const d1 = scriptDigest("console.log(1)");
    const d2 = scriptDigest("console.log(2)");
    expect(listPreauth(home, "workflow:wf")).toEqual([]);
    grantPreauth(home, "workflow:wf", [
      { stepId: "s1", language: "javascript", digest: d1, file: null },
      { stepId: "s2", language: "javascript", digest: d2, file: null },
    ]);
    expect(listPreauth(home, "workflow:wf").length).toBe(2);
    expect(findPreauth(home, "workflow:wf", d1)?.stepId).toBe("s1");
    expect(findPreauth(home, "workflow:wf", "nope")).toBeNull();
    // 同一步重复授权按最新算，旧的直接换掉，不多出一条。
    grantPreauth(home, "workflow:wf", [{ stepId: "s1", language: "javascript", digest: d2, file: null }]);
    expect(listPreauth(home, "workflow:wf").length).toBe(2);
    expect(findPreauth(home, "workflow:wf", d1)).toBeNull();
    expect(revokePreauth(home, "workflow:wf", d2)).toBe(2);
    expect(listPreauth(home, "workflow:wf")).toEqual([]);
    grantPreauth(home, "workflow:wf", [{ stepId: "s1", language: "javascript", digest: d1, file: null }]);
    expect(revokePreauth(home, "workflow:wf")).toBe(1);
    expect(revokePreauth(home, "workflow:wf")).toBe(0);
  } finally {
    cleanup(home);
  }
});

test("预授权账本：损坏先备份再抛错，审计记授权与撤销", () => {
  const home = tempHome();
  try {
    grantPreauth(home, "workflow:wf", [
      { stepId: "s1", language: "javascript", digest: scriptDigest("console.log(1)"), file: null },
    ]);
    revokePreauth(home, "workflow:wf");
    const audit = readScriptPreauthAudit(home);
    expect(audit.map((a) => a.kind)).toEqual(["granted", "revoked"]);
    expect(audit[0].routine).toBe("workflow:wf");
    writeFileSync(join(home, "script-preauth.json"), "{bad json");
    expect(() => loadPreauth(home)).toThrow(ScriptPreauthError);
    const backups = readdirSync(home).filter((f) => f.startsWith("script-preauth.json.corrupt-"));
    expect(backups.length).toBe(1);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 快路径三态
// ---------------------------------------------------------------------------

test("快路径：不是脚本调用直接放过，纯脚本没钉摘要也放行并记纯度判定", () => {
  const home = tempHome();
  try {
    const events: Array<[string, Record<string, unknown>]> = [];
    const onEvent = (kind: string, data: Record<string, unknown>) => {
      events.push([kind, data]);
    };
    const base = { home, routineId: "workflow:wf", routineStepId: "s1", workdir: home, cwd: home, onEvent };
    expect(checkScriptFastPath({ ...base, command: "echo hi" }).decision).toBe("pass");
    const r = checkScriptFastPath({ ...base, command: "node -e \"console.log(1)\"" });
    expect(r.decision).toBe("allow");
    if (r.decision === "allow") {
      expect(r.via).toBe("unpinned");
      expect(r.pure).toBe(true);
      expect(r.digest).toBe(scriptDigest("console.log(1)"));
    }
    expect(events.length).toBe(1);
    expect(events[0][0]).toBe("script_pure");
    expect(events[0][1].pure).toBe(true);
    expect(events[0][1].digest).toBe(scriptDigest("console.log(1)"));
    // 不纯的脚本没钉摘要也放行（激活审批兜底），但事件里如实记不纯。
    events.length = 0;
    const r2 = checkScriptFastPath({ ...base, command: "node -e \"console.log(process.env.HOME)\"" });
    expect(r2.decision).toBe("allow");
    expect(events[0][0]).toBe("script_pure");
    expect(events[0][1].pure).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("快路径：摘要对上号走预授权，内容变了直接拒绝并记审计", () => {
  const home = tempHome();
  try {
    const events: Array<[string, Record<string, unknown>]> = [];
    const onEvent = (kind: string, data: Record<string, unknown>) => {
      events.push([kind, data]);
    };
    const base = { home, routineId: "workflow:wf", routineStepId: "s1", workdir: home, cwd: home, onEvent };
    grantPreauth(home, "workflow:wf", [
      { stepId: "s1", language: "javascript", digest: scriptDigest("console.log(1)"), file: null },
    ]);
    const ok = checkScriptFastPath({ ...base, command: "node -e \"console.log(1)\"" });
    expect(ok.decision).toBe("allow");
    if (ok.decision === "allow") expect(ok.via).toBe("preauth");
    expect(events[0][0]).toBe("script_preauth_used");
    expect(events[0][1].step).toBe("s1");
    expect(readScriptPreauthAudit(home).map((a) => a.kind)).toContain("used");
    // 内容改了：摘要对不上钉死的版本，直接拒绝。
    const bad = checkScriptFastPath({ ...base, command: "node -e \"console.log(2)\"" });
    expect(bad.decision).toBe("refuse");
    if (bad.decision === "refuse") expect(bad.reason).toContain("预授权失效");
    expect(readScriptPreauthAudit(home).map((a) => a.kind)).toContain("refused");
    // 别的步骤没钉摘要，不受影响。
    const other = checkScriptFastPath({ ...base, routineStepId: "s2", command: "node -e \"console.log(2)\"" });
    expect(other.decision).toBe("allow");
  } finally {
    cleanup(home);
  }
});

test("快路径：没有家目录直接放过（落回正常审批）", () => {
  const r = checkScriptFastPath({
    home: null, routineId: "workflow:wf", routineStepId: "s1",
    workdir: "/tmp", command: "node -e \"console.log(1)\"", cwd: "/tmp",
  });
  expect(r.decision).toBe("pass");
});

// ---------------------------------------------------------------------------
// checkApproval 接线：只在例行上下文里生效
// ---------------------------------------------------------------------------

test("审批接线：例行里的纯脚本在非交互 auto 模式下不用问，没例行上下文照常拒绝", async () => {
  const home = tempHome();
  try {
    const routineCtx = newToolContext({
      workdir: home, home, mode: "auto", interactive: false,
      routineId: "workflow:wf", routineStepId: "s1",
    });
    await checkApproval(routineCtx, "shell", "跑脚本", { command: "node -e \"console.log(1)\"", cwd: home });
    const chatCtx = newToolContext({ workdir: home, home, mode: "auto", interactive: false });
    await expect(
      checkApproval(chatCtx, "shell", "跑脚本", { command: "node -e \"console.log(1)\"", cwd: home }),
    ).rejects.toThrow(/非交互模式下 auto 模式不执行写入操作/);
  } finally {
    cleanup(home);
  }
});

test("审批接线：钉过摘要的步骤内容变了，审批直接拒绝", async () => {
  const home = tempHome();
  try {
    grantPreauth(home, "workflow:wf", [
      { stepId: "s1", language: "javascript", digest: scriptDigest("console.log(1)"), file: null },
    ]);
    const ctx = newToolContext({
      workdir: home, home, mode: "auto", interactive: false,
      routineId: "workflow:wf", routineStepId: "s1",
    });
    await expect(
      checkApproval(ctx, "shell", "跑脚本", { command: "node -e \"console.log(2)\"", cwd: home }),
    ).rejects.toThrow(ToolError);
    await expect(
      checkApproval(ctx, "shell", "跑脚本", { command: "node -e \"console.log(2)\"", cwd: home }),
    ).rejects.toThrow(/预授权失效/);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 钉摘要
// ---------------------------------------------------------------------------

test("钉摘要：纯的钉，不纯、含模板、指定 cwd、不是脚本调用的都跳过，并行分支也收", () => {
  const home = tempHome();
  try {
    const workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, "util.py"), "import json\nprint(1)\n");
    const result = pinWorkflowScripts(home, workdir, "workflow:wf", [
      { id: "a", type: "tool", tool: "shell", args: { command: "node -e \"console.log(1)\"" } },
      { id: "b", type: "tool", tool: "shell", args: { command: "python3 util.py" } },
      { id: "c", type: "tool", tool: "shell", args: { command: "python3 -c \"import os\"" } },
      { id: "d", type: "tool", tool: "shell", args: { command: "node -e \"console.log({{inputs.x}})\"" } },
      { id: "e", type: "tool", tool: "shell", args: { command: "node -e \"console.log(1)\"", cwd: "sub" } },
      { id: "f", type: "tool", tool: "shell", args: { command: "echo hi" } },
      { id: "g", type: "tool", tool: "read_file", args: { path: "x" } },
      { id: "p", type: "parallel", branches: [[{ id: "h", type: "tool", tool: "shell", args: { command: "node -e \"console.log(2)\"" } }]] },
    ]);
    expect(result.pinned.map((p) => p.stepId).sort()).toEqual(["a", "b", "h"]);
    expect(result.skipped.map((s) => s.stepId).sort()).toEqual(["c", "d", "e", "f"]);
    expect(listPreauth(home, "workflow:wf").length).toBe(3);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 工作流全链路
// ---------------------------------------------------------------------------

test("工作流全链路：trial 记纯度判定，activate 钉摘要，跑走预授权，改内容就拒绝，删工作流撤销授权", async () => {
  const home = tempHome();
  try {
    const def = {
      name: "script-daily",
      version: 1,
      mode: "fixed",
      steps: [{ id: "s1", type: "tool", tool: "shell", args: { command: "node -e \"console.log(1)\"" } }],
    };
    const defPath = join(home, "wf.json");
    writeFileSync(defPath, JSON.stringify(def));
    const imported = await importWorkflow(home, defPath);
    expect(imported.name).toBe("script-daily");
    const trial = await trialWorkflow(home, "script-daily", {}, reqFor(home), true);
    expect(trial.status).toBe("completed");
    const trialStore = new RunStore(join(home, "runs"));
    const trialStoreRun = trialStore.list().find((s) => s.session_id === `workflow-${trial.id}`);
    expect(trialStoreRun).toBeTruthy();
    const trialEvents = trialStore.readEvents(trialStoreRun!.run_id);
    const trialPure = trialEvents.find((e) => e.type === "script_pure");
    expect(trialPure).toBeTruthy();
    expect(trialPure!.pure).toBe(true);
    expect(trialPure!.digest).toBe(scriptDigest("console.log(1)"));
    const entry = activateWorkflow(home, "script-daily", true, home);
    expect(entry.status).toBe("active");
    const grants = listPreauth(home, workflowRoutineId("script-daily"));
    expect(grants.length).toBe(1);
    expect(grants[0].stepId).toBe("s1");
    expect(grants[0].digest).toBe(scriptDigest("console.log(1)"));
    // 跑：走预授权快路径，节点成功，事件里有 script_preauth_used。
    const run = await runWorkflowByName(home, "script-daily", {}, reqFor(home));
    expect(run.status).toBe("completed");
    expect(run.nodes[0].status).toBe("ok");
    expect(run.nodes[0].output).toContain("1");
    const store = new RunStore(join(home, "runs"));
    const storeRun = store.list().find((s) => s.session_id === `workflow-${run.id}`);
    expect(storeRun).toBeTruthy();
    const events = store.readEvents(storeRun!.run_id);
    const used = events.find((e) => e.type === "script_preauth_used");
    expect(used).toBeTruthy();
    expect(used!.digest).toBe(scriptDigest("console.log(1)"));
    const text = formatTimelineText(buildTimeline(store, storeRun!.run_id));
    expect(text).toContain("预授权快路径");
    // 改定义里的脚本内容：摘要对不上，跑就失败。
    const tampered = {
      ...def,
      steps: [{ id: "s1", type: "tool", tool: "shell", args: { command: "node -e \"console.log(2)\"" } }],
    };
    writeFileSync(join(home, "workflows", imported.file), JSON.stringify(tampered));
    const run2 = await runWorkflowByName(home, "script-daily", {}, reqFor(home));
    expect(run2.status).toBe("failed");
    expect(run2.error).toContain("预授权失效");
    // CLI：list 能看到授权，revoke 撤掉，grant 能补钉，删工作流一并撤销。
    expect(await handleScript(["preauth", "list", "--workflow", "script-daily"], home)).toBe(0);
    expect(await handleScript(["preauth", "revoke", "--workflow", "script-daily", "--yes"], home)).toBe(0);
    expect(listPreauth(home, workflowRoutineId("script-daily"))).toEqual([]);
    expect(await handleScript(["preauth", "grant", "--workflow", "script-daily", "--yes"], home)).toBe(0);
    expect(listPreauth(home, workflowRoutineId("script-daily")).length).toBe(1);
    removeWorkflow(home, "script-daily", true);
    expect(listPreauth(home, workflowRoutineId("script-daily"))).toEqual([]);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("CLI：check 判纯返回 0、不纯返回 1，缺文件与认不出语言返回 1", async () => {
  const home = tempHome();
  try {
    const pureFile = join(home, "a.py");
    writeFileSync(pureFile, "import json\nprint(json.dumps({}))\n");
    expect(await handleScript(["check", pureFile], home)).toBe(0);
    const impureFile = join(home, "b.py");
    writeFileSync(impureFile, "import os\nos.listdir('.')\n");
    expect(await handleScript(["check", impureFile], home)).toBe(1);
    const jsFile = join(home, "c.js");
    writeFileSync(jsFile, "console.log(process.env.HOME)");
    expect(await handleScript(["check", jsFile], home)).toBe(1);
    expect(await handleScript(["check", join(home, "nope.py")], home)).toBe(1);
    const noExt = join(home, "noext");
    writeFileSync(noExt, "print(1)");
    expect(await handleScript(["check", noExt], home)).toBe(1);
    expect(await handleScript(["check", noExt, "--language", "python"], home)).toBe(0);
    expect(await handleScript(["check", pureFile, "--language", "ruby"], home)).toBe(1);
    expect(await handleScript(["preauth", "list"], home)).toBe(0);
    expect(await handleScript(["preauth", "grant", "--workflow", "x"], home)).toBe(2);
    expect(await handleScript(["preauth", "revoke", "--workflow", "x"], home)).toBe(2);
    expect(await handleScript([], home)).toBe(2);
    expect(await handleScript(["nope"], home)).toBe(2);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 事件注册、时间线渲染、SIEM 来源
// ---------------------------------------------------------------------------

test("事件：两个新事件类型已注册，摘要不被脱敏掩掉，时间线能看到", () => {
  const home = tempHome();
  try {
    const store = new RunStore(join(home, "runs"));
    const st = store.create("测试", "test-session", home, "normal", 1);
    const digest = scriptDigest("console.log(1)");
    expect(() =>
      store.appendEvent(st.run_id, "script_pure", { language: "javascript", digest, pure: true, reason: "白名单静态分析通过" }),
    ).not.toThrow();
    expect(() =>
      store.appendEvent(st.run_id, "script_preauth_used", { language: "javascript", digest, step: "s1" }),
    ).not.toThrow();
    const events = store.readEvents(st.run_id);
    expect(events.find((e) => e.type === "script_pure")?.digest).toBe(digest);
    expect(() => store.appendEvent(st.run_id, "script_nope", {})).toThrow();
    const text = formatTimelineText(buildTimeline(store, st.run_id));
    expect(text).toContain("纯度判定");
    expect(text).toContain("预授权快路径");
  } finally {
    cleanup(home);
  }
});

test("审计：脚本预授权审计进 SIEM 导出（共 11 个来源）", () => {
  expect(AUDIT_SOURCES.some((s) => s.file === "script-preauth-audit.jsonl" && s.label === "script_preauth")).toBe(true);
  expect(AUDIT_SOURCES.length).toBe(11); // Pi Bot 借鉴第 2 条加了第 10 个来源（交接契约验收审计）；O1 加了第 11 个来源（策略网关审计）。
});
