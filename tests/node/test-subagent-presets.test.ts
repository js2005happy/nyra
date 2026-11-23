// tests/node/test-subagent-presets.test.ts — G-P2-3 子 agent 具名预设 +
// 工具限制。全部用临时 home / 工作目录与假 provider，不连真实服务、
// 不花真实 token；shell 写命令的拦截用临时文件是否落盘做行为断言。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_PRESETS,
  PRESET_NAME_RE,
  REVIEW_PRESET_TOOLS,
  addUserPreset,
  isReadOnlyShellCommand,
  listAllPresets,
  loadPresetFile,
  loadPresetLayers,
  removeUserPreset,
  resolvePresetName,
  resolveSubagentPreset,
  setUserDefaultPreset,
  validatePresetDefinition,
  type SubagentPreset,
} from "../../src/subagentPresets.ts";
import { READONLY_TOOLS, newToolContext, executeTool, checkApproval, ToolError, TOOL_SCHEMAS } from "../../src/tools.ts";
import { Agent } from "../../src/agent.ts";
import { fakeProvider } from "./fake-provider.ts";
import { handleSubagentPreset } from "../../src/subagentPresetCli.ts";

const KNOWN_TOOLS = TOOL_SCHEMAS
  .map((s) => (s as { function?: { name?: string } }).function?.name)
  .filter((n): n is string => Boolean(n));

function tmpHome(prefix = "nyra-preset-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- 只读 shell 命令判定 ----

test("G-P2-3：只读 shell 判定——读命令放行", () => {
  for (const cmd of [
    "ls",
    "ls -la",
    "cat README.md",
    "head -20 a.txt",
    "grep -rn foo .",
    "find . -name *.ts",
    "git status",
    "git log --oneline -5",
    "git diff HEAD",
    "git stash list",
    "git remote -v",
    "git config user.name",
    "ls | grep foo",
    "cat a.txt | head -5",
    "pwd && ls",
    "echo hello",
    "wc -l a.txt",
  ]) {
    expect(isReadOnlyShellCommand(cmd)).toBe(true);
  }
});

test("G-P2-3：只读 shell 判定——写命令与可疑形式一律拒绝", () => {
  for (const cmd of [
    "",
    "rm -rf /tmp/x",
    "mv a b",
    "echo pwned > a.txt",
    "cat >> a.txt",
    "git push",
    "git commit -m x",
    "git checkout main",
    "git add .",
    "git remote add origin https://example.com/x.git",
    "git config user.name x",
    "git stash push",
    "git stash",
    "ls; rm x",
    "ls && rm x",
    "$(rm x)",
    "echo `id`",
    "FOO=1 ls",
    "sudo ls",
    "cd /tmp",
    "cat < a.txt",
    "ls &",
    "node -e 1",
    "bun run x.ts",
  ]) {
    expect(isReadOnlyShellCommand(cmd)).toBe(false);
  }
});

// ---- 内置预设 ----

test("G-P2-3：内置预设——general-purpose 不限，review 只读且工具表是 READONLY_TOOLS 加 shell", () => {
  expect(BUILTIN_PRESETS["general-purpose"].tools).toBeUndefined();
  expect(BUILTIN_PRESETS["general-purpose"].shellReadOnly).toBeUndefined();
  const review = BUILTIN_PRESETS.review;
  expect(review.shellReadOnly).toBe(true);
  expect(review.tools).toBeDefined();
  for (const t of review.tools!) {
    expect(t === "shell" || READONLY_TOOLS.has(t)).toBe(true);
  }
  // review 工具表与 REVIEW_PRESET_TOOLS 是同一份。
  expect([...review.tools!].sort()).toEqual([...REVIEW_PRESET_TOOLS].sort());
  expect(PRESET_NAME_RE.test("review")).toBe(true);
  expect(PRESET_NAME_RE.test("Review")).toBe(false);
  expect(PRESET_NAME_RE.test("a".repeat(33))).toBe(false);
});

// ---- 校验 ----

test("G-P2-3：预设定校验——未知工具、空 tools、非法名、越界轮数都拒绝", () => {
  expect(validatePresetDefinition("review", { tools: ["read_file", "no_such_tool"] }, KNOWN_TOOLS).join("")).toContain("no_such_tool");
  expect(validatePresetDefinition("x", { tools: [] }, KNOWN_TOOLS).length).toBeGreaterThan(0);
  expect(validatePresetDefinition("Bad Name", { tools: ["read_file"] }, KNOWN_TOOLS).length).toBeGreaterThan(0);
  expect(validatePresetDefinition("ok", { tools: ["read_file"], maxTurns: 13 }, KNOWN_TOOLS).length).toBeGreaterThan(0);
  expect(validatePresetDefinition("ok", { tools: ["read_file"], maxTurns: 0 }, KNOWN_TOOLS).length).toBeGreaterThan(0);
  expect(validatePresetDefinition("ok", { tools: ["read_file"], shellReadOnly: "yes" }, KNOWN_TOOLS).length).toBeGreaterThan(0);
  expect(validatePresetDefinition("ok", { tools: ["read_file"], shellReadOnly: true, model: "deepseek-flash", maxTurns: 4 }, KNOWN_TOOLS)).toEqual([]);
});

// ---- 解析优先级 ----

test("G-P2-3：解析优先级 session > project > user > builtin", () => {
  const mk = (note: string): SubagentPreset => ({ name: "review", description: note, tools: ["read_file"] });
  const layers = {
    session: { review: mk("session") },
    project: { review: mk("project") },
    user: { review: mk("user") },
  };
  const r = resolveSubagentPreset("review", layers);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.source).toBe("session");
    expect(r.preset.description).toBe("session");
  }
  const r2 = resolveSubagentPreset("review", { project: layers.project, user: layers.user });
  expect(r2.ok && r2.source).toBe("project");
  const r3 = resolveSubagentPreset("review", { user: layers.user });
  expect(r3.ok && r3.source).toBe("user");
  const r4 = resolveSubagentPreset("review", {});
  expect(r4.ok && r4.source).toBe("builtin");
  expect(r4.ok && r4.preset.shellReadOnly).toBe(true);
});

test("G-P2-3：未知预设与非法名解析失败（fail-closed）", () => {
  expect(resolveSubagentPreset("nope", {})).toEqual({ ok: false, error: expect.stringContaining("未知子 agent 预设") });
  expect(resolveSubagentPreset("Bad", {}).ok).toBe(false);
});

test("G-P2-3：预设名解析——显式 > 项目默认 > 用户默认 > general-purpose", () => {
  const layers = {
    user: { presets: {}, defaultPreset: "review", errors: [] },
    project: { presets: {}, defaultPreset: null, errors: [] },
  };
  expect(resolvePresetName("review", layers)).toBe("review");
  expect(resolvePresetName(undefined, layers)).toBe("review");
  expect(resolvePresetName(undefined, {
    user: { presets: {}, defaultPreset: null, errors: [] },
    project: { presets: {}, defaultPreset: "review", errors: [] },
  })).toBe("review");
  expect(resolvePresetName(undefined, {
    user: { presets: {}, defaultPreset: null, errors: [] },
    project: { presets: {}, defaultPreset: null, errors: [] },
  })).toBe("general-purpose");
});

// ---- 用户层文件 round-trip ----

test("G-P2-3：用户层预设文件 round-trip——add / 读回 / default / remove", () => {
  const home = tmpHome();
  const p = addUserPreset(home, "audit", { tools: ["read_file", "grep_search"], description: "审计" }, KNOWN_TOOLS);
  expect(p.name).toBe("audit");
  const loaded = loadPresetFile(join(home, "subagent-presets.json"), KNOWN_TOOLS);
  expect(loaded.presets.audit?.tools).toEqual(["read_file", "grep_search"]);
  expect(loaded.errors).toEqual([]);
  setUserDefaultPreset(home, "audit", KNOWN_TOOLS);
  expect(loadPresetFile(join(home, "subagent-presets.json"), KNOWN_TOOLS).defaultPreset).toBe("audit");
  setUserDefaultPreset(home, null, KNOWN_TOOLS);
  expect(loadPresetFile(join(home, "subagent-presets.json"), KNOWN_TOOLS).defaultPreset).toBeNull();
  removeUserPreset(home, "audit", KNOWN_TOOLS);
  expect(loadPresetFile(join(home, "subagent-presets.json"), KNOWN_TOOLS).presets.audit).toBeUndefined();
  // 内置删不掉；删不存在的报错；默认指到不存在的预设报错。
  expect(() => removeUserPreset(home, "review", KNOWN_TOOLS)).toThrow("内置预设");
  expect(() => removeUserPreset(home, "nope", KNOWN_TOOLS)).toThrow("没有预设");
  expect(() => setUserDefaultPreset(home, "nope", KNOWN_TOOLS)).toThrow("没有预设");
  expect(() => addUserPreset(home, "bad", { tools: ["no_such_tool"] }, KNOWN_TOOLS)).toThrow("未知工具名");
});

test("G-P2-3：损坏的预设文件先备份再回空，不抛错", () => {
  const home = tmpHome();
  writeFileSync(join(home, "subagent-presets.json"), "{ 不是 json", "utf-8");
  const loaded = loadPresetFile(join(home, "subagent-presets.json"), KNOWN_TOOLS);
  expect(loaded.presets).toEqual({});
  expect(loaded.errors.length).toBeGreaterThan(0);
  expect(loaded.errors[0]).toContain("已损坏");
});

test("G-P2-3：项目层文件可覆盖内置预设（同名高优先级）", () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-preset-wd-"));
  mkdirSync(join(workdir, ".nyra"), { recursive: true });
  writeFileSync(join(workdir, ".nyra", "subagent-presets.json"), JSON.stringify({
    version: 1,
    presets: { review: { tools: ["read_file"], description: "项目定制 review" } },
    defaultPreset: null,
  }), "utf-8");
  const layers = loadPresetLayers(home, workdir, KNOWN_TOOLS);
  expect(layers.project.presets.review?.description).toBe("项目定制 review");
  const r = resolveSubagentPreset("review", { project: layers.project.presets, user: layers.user.presets });
  expect(r.ok && r.source).toBe("project");
  const all = listAllPresets({ project: layers.project.presets, user: layers.user.presets });
  expect(all.find((x) => x.preset.name === "review")?.source).toBe("project");
  expect(all.find((x) => x.preset.name === "general-purpose")?.source).toBe("builtin");
});

// ---- 委派接线：预设进事件链、未知预设拒绝、只读 shell 真拦住写命令 ----

function rootAgent(home: string, workdir: string): Agent {
  const agent = new Agent(fakeProvider([{ content: "收到，已完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
  });
  return agent;
}

test("G-P2-3：review 预设委派——delegate_preset_applied 进事件链，只记名与工具名", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-preset-wd2-"));
  const agent = rootAgent(home, workdir);
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  agent.onEvent = (kind, data) => { events.push({ kind, data }); };
  const d = await agent.delegateDetailed("读一下 README", 3, { preset: "review" });
  expect(d.ok).toBe(true);
  const applied = events.find((e) => e.kind === "delegate_preset_applied");
  expect(applied).toBeDefined();
  expect(applied!.data.preset).toBe("review");
  expect(applied!.data.source).toBe("builtin");
  expect(typeof applied!.data.tools).toBe("string");
  expect((applied!.data.tools as string).split(",")).toContain("shell");
  expect((applied!.data.tools as string).split(",")).not.toContain("write_file");
  // 默认 general-purpose 不发 preset 事件。
  const agent2 = rootAgent(home, workdir);
  const events2: string[] = [];
  agent2.onEvent = (kind) => { events2.push(kind); };
  const d2 = await agent2.delegateDetailed("读一下 README", 3, {});
  expect(d2.ok).toBe(true);
  expect(events2).not.toContain("delegate_preset_applied");
});

test("G-P2-3：未知预设委派直接拒绝，不启动子任务", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-preset-wd3-"));
  const provider = fakeProvider([{ content: "不该跑到这里。" }]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
  });
  const d = await agent.delegateDetailed("读一下 README", 3, { preset: "nope" });
  expect(d.ok).toBe(false);
  expect(d.text).toContain("未知子 agent 预设");
  expect(provider.calls).toBe(0);
});

test("G-P2-3：显式 tools 与预设 tools 取交集（只能收窄）", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-preset-wd4-"));
  const agent = rootAgent(home, workdir);
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  agent.onEvent = (kind, data) => { events.push({ kind, data }); };
  const d = await agent.delegateDetailed("读一下 README", 3, { preset: "review", tools: ["read_file", "write_file"] });
  expect(d.ok).toBe(true);
  const applied = events.find((e) => e.kind === "delegate_preset_applied");
  expect(applied).toBeDefined();
  // write_file 不在 review 的工具表里，交集里没有它。
  expect((applied!.data.tools as string).split(",")).toEqual(["read_file"]);
});

test("G-P2-3：review 预设的子 agent 用 shell 写文件会被拦住（文件不落盘）", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-preset-wd5-"));
  const target = join(workdir, "pwned.txt");
  const provider = fakeProvider([
    { toolCalls: [{ id: "c1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `echo pwned > ${target}` }) } }] },
    { content: "已检查，写操作被拦住了。" },
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
  });
  const d = await agent.delegateDetailed("检查工作目录", 3, { preset: "review" });
  expect(d.ok).toBe(true);
  expect(d.text).toContain("被拦住了");
  expect(existsSync(target)).toBe(false);
});

test("G-P2-3：只读 shell 在工具层硬拦（checkApproval 与 executeTool）", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "nyra-preset-wd6-"));
  const ctx = newToolContext({ workdir, mode: "full", interactive: false, shellReadOnly: true });
  await expect(checkApproval(ctx, "shell", "rm", { command: "rm -rf /tmp/x" })).rejects.toThrow(ToolError);
  await checkApproval(ctx, "shell", "ls", { command: "ls -la" });
  const out = await executeTool("shell", { command: "echo hi > a.txt" }, ctx);
  expect(out.startsWith("错误")).toBe(true);
  expect(out).toContain("只读 shell");
  const out2 = await executeTool("shell", { command: "echo hi" }, ctx);
  expect(out2.startsWith("错误")).toBe(false);
});

// ---- CLI：subagent preset ----

test("G-P2-3：CLI subagent preset list/add/show/remove/default 全流程", async () => {
  const home = tmpHome();
  const logs: string[] = [];
  const origLog = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { logs.push(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { logs.push(s); return true; }) as typeof process.stderr.write;
  try {
    expect(await handleSubagentPreset(["list"], home)).toBe(0);
    expect(logs.join("")).toContain("review");
    expect(logs.join("")).toContain("general-purpose");
    logs.length = 0;
    // add 不加 --yes 拒绝。
    expect(await handleSubagentPreset(["add", "audit", "--tools", "read_file,grep_search"], home)).toBe(2);
    expect(await handleSubagentPreset(["add", "audit", "--tools", "read_file,grep_search", "--yes"], home)).toBe(0);
    expect(logs.join("")).toContain("已新增用户层预设 audit");
    logs.length = 0;
    expect(await handleSubagentPreset(["show", "audit"], home)).toBe(0);
    expect(logs.join("")).toContain("audit");
    logs.length = 0;
    expect(await handleSubagentPreset(["show", "nope"], home)).toBe(1);
    expect(await handleSubagentPreset(["default", "audit"], home)).toBe(0);
    expect(await handleSubagentPreset(["default"], home)).toBe(0);
    expect(logs.join("")).toContain("audit");
    logs.length = 0;
    expect(await handleSubagentPreset(["default", "--clear"], home)).toBe(0);
    expect(await handleSubagentPreset(["remove", "audit", "--yes"], home)).toBe(0);
    expect(loadPresetFile(join(home, "subagent-presets.json"), KNOWN_TOOLS).presets.audit).toBeUndefined();
    // 内置删不掉。
    expect(await handleSubagentPreset(["remove", "review", "--yes"], home)).toBe(1);
    // 未知工具拒绝。
    expect(await handleSubagentPreset(["add", "bad", "--tools", "no_such_tool", "--yes"], home)).toBe(1);
  } finally {
    process.stdout.write = origLog;
    process.stderr.write = origErr;
  }
  // 用户层文件确实落盘且可解析。
  const content = readFileSync(join(home, "subagent-presets.json"), "utf-8");
  expect(JSON.parse(content).version).toBe(1);
});
