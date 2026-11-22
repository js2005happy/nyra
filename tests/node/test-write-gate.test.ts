// tests/node/test-write-gate.test.ts — 第 1 批 G-P0-4 单写者门 + G-P0-5 零工具编排者。
//
// 账本与移交用临时 home；写工具拦截走 executeTool（approveFn 全批）；
// 委派移交与释放走 delegateDetailed（假 provider，不烧真 token）；
// 参谋长工具集走 toolSchemas 与一次真实的模型工具调用（假 provider 发
// write_file 调用，应被执行层拒绝）。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { echoProvider, fakeProvider } from "./fake-provider.ts";
import { defaultSoul, saveSoul, setCharter } from "../../src/soul.ts";
import {
  buildChiefTask, createTeam, handleTeam, ORCHESTRATOR_TOOLS, planTeamDispatch,
  type Team,
} from "../../src/team.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";
import {
  acquireWriteLease, appendWriteGateAudit, checkWriteGate, listWriteLeases,
  loadWriteGateStore, normalizeGateFile, releaseAllWriterLeases, releaseWriteLease,
  saveWriteGateStore, transferWriteLease, WRITE_GATE_AUDIT_FILE, WRITE_GATE_FILE,
  type WriteGateStore,
} from "../../src/writeGate.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(prefix = "nyra-gate-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function charterInput(): Record<string, unknown> {
  return {
    own: "负责写周报",
    sources: ["任务板", "上周周报"],
    output: "以 `## 结论` 开头，附三条要点",
    approval: "对外发送前须人批",
    stop: "缺关键数据时停下问人",
  };
}

function makeSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
  setCharter(home, agent, charterInput());
}

function makeTeam(home: string): Team {
  makeSoul(home, "chief1");
  makeSoul(home, "member1");
  makeSoul(home, "member2");
  return createTeam(home, { name: "alpha", chief: "chief1", members: ["member1", "member2"] });
}

function readAudit(home: string): Record<string, unknown>[] {
  const p = join(home, WRITE_GATE_AUDIT_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function agentFor(home: string, workdir: string, soul: string, team: Team, role: "chief" | "member", provider: ReturnType<typeof echoProvider>): Agent {
  return new Agent(provider, {
    workdir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home,
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    soulAgent: soul,
    teamId: team.id,
    teamRole: role,
    approveFn: async () => true,
  } as never);
}

test("WriteGateTest.test_normalize_gate_file", () => {
  expect(normalizeGateFile("a/b.txt")).toBe("a/b.txt");
  expect(normalizeGateFile("./a.txt")).toBe("a.txt");
  expect(normalizeGateFile("a\\b.txt")).toBe("a/b.txt");
  expect(normalizeGateFile("/etc/passwd")).toBeNull();
  expect(normalizeGateFile("../escape.txt")).toBeNull();
  expect(normalizeGateFile("a/../../escape.txt")).toBeNull();
  expect(normalizeGateFile("")).toBeNull();
});

test("WriteGateTest.test_acquire_transfer_release_flow", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  // 没租约：成员写被拒（名额在参谋长手里），参谋长查门放行（租约在写
  // 成功后才记，查门时不占名额）。
  const denied = checkWriteGate(home, team.id, "out.txt", "member1");
  expect(denied.decision).toBe("deny");
  expect(denied.holder).toBe("chief1");
  const chiefOk = checkWriteGate(home, team.id, "out.txt", "chief1");
  expect(chiefOk.decision).toBe("allow");
  // 参谋长手里时成员写被拒，并报出持有者。
  const denied2 = checkWriteGate(home, team.id, "out.txt", "member1");
  expect(denied2.decision).toBe("deny");
  expect(denied2.holder).toBe("chief1");
  // 参谋长移交给 member1：成员放行，member2 仍被拒。
  const moved = transferWriteLease(home, team.id, "out.txt", "chief1", "member1", "chief1");
  expect(moved.granted).toBe(true);
  expect(checkWriteGate(home, team.id, "out.txt", "member1").decision).toBe("allow");
  expect(checkWriteGate(home, team.id, "out.txt", "member2").decision).toBe("deny");
  // member2 不能把别人的名额抢走；member1 自己能移交给 member2。
  const stolen = transferWriteLease(home, team.id, "out.txt", "member2", "member2", "member2");
  expect(stolen.granted).toBe(false);
  expect(transferWriteLease(home, team.id, "out.txt", "member1", "member2", "member1").granted).toBe(true);
  expect(checkWriteGate(home, team.id, "out.txt", "member2").decision).toBe("allow");
  // 归还：持有者本人能还，别人还不了，参谋长能收回。
  expect(releaseWriteLease(home, team.id, "out.txt", "member1")).toBe(false);
  expect(releaseWriteLease(home, team.id, "out.txt", "member2")).toBe(true);
  expect(listWriteLeases(home, team.id)).toEqual([]);
});

test("WriteGateTest.test_expired_lease_is_pruned_on_next_check", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  expect(acquireWriteLease(home, team.id, "old.txt", "member1", "chief1").granted).toBe(true);
  // 手工把租约写过期（TTL 1 小时）。
  const store: WriteGateStore = loadWriteGateStore(home);
  store.leases[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  saveWriteGateStore(home, store);
  // 下一次查门清掉过期租约，member2 能接手。
  expect(checkWriteGate(home, team.id, "old.txt", "member2").decision).toBe("deny");
  expect(listWriteLeases(home, team.id).length).toBe(0);
  // 参谋长查门仍放行（租约在下一次写成功后才记，查门本身不占名额）。
  expect(checkWriteGate(home, team.id, "old.txt", "chief1").decision).toBe("allow");
});

test("WriteGateTest.test_store_perms_and_corrupt_backup", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  expect(acquireWriteLease(home, team.id, "a.txt", "member1", "chief1").granted).toBe(true);
  const storePath = join(home, WRITE_GATE_FILE);
  expectPerms(storePath, 0o600);
  // 写坏账本再读：先备份再抛错（备份名带时间戳：write-gate.json.corrupt-<毫秒>）。
  writeFileSync(storePath, "{not json");
  expect(() => loadWriteGateStore(home)).toThrow();
  expect(readdirSync(home).some((f) => f.startsWith("write-gate.json.corrupt-"))).toBe(true);
  // 审计只记相对路径，不记绝对路径。
  appendWriteGateAudit(home, { op: "granted", team_id: team.id, file: "a.txt", holder: "member1" });
  const audit = readAudit(home);
  expect(audit.length).toBeGreaterThan(0);
  expect(JSON.stringify(audit)).not.toContain(home);
});

test("WriteGateTest.test_execute_tool_gate_denies_member_without_lease", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  const ctx = newToolContext({
    workdir, mode: "full", interactive: false, home,
    soulAgent: "member1", teamId: team.id,
    approveFn: async () => true,
  });
  const denied = await executeTool("write_file", { path: "out.txt", content: "hello" }, ctx);
  expect(denied).toContain("单写者门拦截");
  expect(existsSync(join(workdir, "out.txt"))).toBe(false);
  expect(ctx.lastWriteGateDenial).not.toBeNull();
  expect(ctx.lastWriteGateDenial!.file).toBe("out.txt");
  expect(ctx.lastWriteGateDenial!.holder).toBe("chief1");
  // 移交后同一调用放行，文件真写出来。
  expect(transferWriteLease(home, team.id, "out.txt", "chief1", "member1", "chief1").granted).toBe(true);
  const ok = await executeTool("write_file", { path: "out.txt", content: "hello" }, ctx);
  expect(ok).not.toContain("单写者门拦截");
  expect(readFileSync(join(workdir, "out.txt"), "utf-8")).toBe("hello");
  // edit_file 与 apply_patch 同样走门。
  const deniedEdit = await executeTool("edit_file", { path: "other.txt", content: "x" }, ctx);
  expect(deniedEdit).toContain("单写者门拦截");
});

test("WriteGateTest.test_delegate_transfers_lease_and_releases_on_finish", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  const chief = agentFor(home, workdir, "chief1", team, "chief", echoProvider("## 结论\n子任务完成。"));
  // 分派时把写者名额移交给 member1；子任务结束（假 provider 只回摘要，
  // 没调工具）后名额还回去——审计里 transferred 与 released 各一笔。
  const result = await chief.delegateDetailed("把 out.txt 写好", 2, { agent: "member1", writeFiles: ["out.txt"] });
  expect(result.ok).toBe(true);
  expect(listWriteLeases(home, team.id)).toEqual([]);
  const audit = readAudit(home);
  expect(audit.some((e) => e.op === "transferred" && e.to === "member1")).toBe(true);
  expect(audit.some((e) => e.op === "released" && e.holder === "member1")).toBe(true);
});

test("WriteGateTest.test_delegate_refused_when_lease_held_by_other", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  // member2 先拿着名额，参谋长再把同一文件派给 member1：直接拒绝委派。
  expect(acquireWriteLease(home, team.id, "out.txt", "member2", "chief1").granted).toBe(true);
  const chief = agentFor(home, workdir, "chief1", team, "chief", echoProvider("## 结论\n子任务完成。"));
  const result = await chief.delegateDetailed("把 out.txt 写好", 2, { agent: "member1", writeFiles: ["out.txt"] });
  expect(result.ok).toBe(false);
  expect(result.text).toContain("member2");
  // member2 的名额还在，没被抢走。
  expect(listWriteLeases(home, team.id).map((l) => l.holder)).toEqual(["member2"]);
});

test("WriteGateTest.test_chief_has_only_delegate_tools", () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  expect(ORCHESTRATOR_TOOLS).toEqual(["delegate", "delegate_parallel"]);
  const chief = agentFor(home, workdir, "chief1", team, "chief", echoProvider("## 结论\n子任务完成。"));
  const names = chief.toolSchemas().map((s) => (s.function as { name: string }).name);
  expect(names.sort()).toEqual(["delegate", "delegate_parallel"]);
  expect(names).not.toContain("write_file");
  expect(names).not.toContain("shell");
  // 成员不受限：写工具还在。
  const member = agentFor(home, workdir, "member1", team, "member", echoProvider("写完了。"));
  const memberNames = member.toolSchemas().map((s) => (s.function as { name: string }).name);
  expect(memberNames).toContain("write_file");
  // 参谋长建的子 agent 也不继承编排者限制（限制是参谋长这个角色的）。
  expect(member.toolSchemas().map((s) => (s.function as { name: string }).name)).toContain("delegate");
});

test("WriteGateTest.test_chief_write_tool_call_refused_at_runtime", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  // 假 provider 第一轮就调 write_file（模型幻觉调出被拿掉的工具）：
  // 执行层直接拒绝，文件不落地，第二轮回摘要收尾。
  const provider = fakeProvider([
    { toolCalls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "sneak.txt", content: "x" }) } }] },
    { content: "## 结论\n写完了。" },
  ]);
  const chief = agentFor(home, workdir, "chief1", team, "chief", provider as never);
  const out = await chief.run("把 sneak.txt 写好");
  expect(out).toContain("## 结论");
  expect(existsSync(join(workdir, "sneak.txt"))).toBe(false);
});

test("WriteGateTest.test_member_write_denied_event_and_chief_task_note", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  // 成员没名额就写：工具结果里是门拦截文案，事件链里有 write_gate_denied。
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const provider = fakeProvider([
    { toolCalls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "x" }) } }] },
    { content: "写完了。" },
  ]);
  const member = agentFor(home, workdir, "member1", team, "member", provider as never);
  member.onEvent = (kind, data) => { events.push({ kind, data }); };
  await member.run("把 out.txt 写好");
  expect(existsSync(join(workdir, "out.txt"))).toBe(false);
  const denied = events.find((e) => e.kind === "write_gate_denied");
  expect(denied).toBeDefined();
  expect(denied!.data.file).toBe("out.txt");
  expect(denied!.data.holder).toBe("chief1");
  // 参谋长任务文本里写清了 write_files 的用法（提示词是第二道防线）。
  const plan = planTeamDispatch(home, team.id, "写一份周报");
  expect(buildChiefTask(plan)).toContain("write_files");
});

test("WriteGateTest.test_write_gate_granted_event_once_on_first_write", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  // ctx 级：参谋长首次写新文件自动拿到租约，续写同一文件不再记新授权。
  const ctx = newToolContext({
    workdir, mode: "full", interactive: false, home,
    soulAgent: "chief1", teamId: team.id,
    approveFn: async () => true,
  });
  await executeTool("write_file", { path: "grant.txt", content: "one" }, ctx);
  expect(ctx.lastWriteGateGrant).toEqual({ file: "grant.txt" });
  await executeTool("write_file", { path: "grant.txt", content: "two" }, ctx);
  expect(ctx.lastWriteGateGrant).toBeNull();
  expect(readFileSync(join(workdir, "grant.txt"), "utf-8")).toBe("two");

  // 运行级：事件链里 granted 只出现一次，第二轮同一文件不再刷屏。
  // mode 用 full：auto 模式在非交互下不执行写入，文件不落地、租约也不记。
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const writeCall = (content: string) => ({
    toolCalls: [{ id: `call-${content}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "run.txt", content }) } }],
  });
  const provider = fakeProvider([
    writeCall("one"), { content: "写完了。" },
    writeCall("two"), { content: "又写完了。" },
  ]);
  // soulAgent 是参谋长、角色放成员（保留写工具）：门按 soulAgent 认人，
  // 首次写自动持有——这条只测“首次授权进事件链”，不测角色工具集。
  const writer = new Agent(provider, {
    workdir,
    mode: "full",
    maxTurns: 2,
    interactive: false,
    home,
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    soulAgent: "chief1",
    teamId: team.id,
    teamRole: "member",
    approveFn: async () => true,
  } as never);
  writer.onEvent = (kind, data) => { events.push({ kind, data }); };
  await writer.run("把 run.txt 写好");
  await writer.run("再改一遍 run.txt");
  const granted = events.filter((e) => e.kind === "write_gate_granted");
  expect(granted.length).toBe(1);
  expect(granted[0].data.file).toBe("run.txt");
  expect(granted[0].data.agent).toBe("chief1");
  expect(readFileSync(join(workdir, "run.txt"), "utf-8")).toBe("two");
});

test("WriteGateTest.test_refused_write_does_not_take_lease", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gate-wd-"));
  const team = makeTeam(home);
  // auto 模式非交互下写操作被模式拒绝：租约不能被这次没落地的写占下，
  // 否则别人写同一文件要等租约过期。
  const ctx = newToolContext({
    workdir, mode: "auto", interactive: false, home,
    soulAgent: "chief1", teamId: team.id,
    approveFn: async () => true,
  });
  const result = await executeTool("write_file", { path: "blocked.txt", content: "x" }, ctx);
  expect(result).toContain("非交互模式下 auto 模式不执行写入操作");
  expect(listWriteLeases(home, team.id)).toEqual([]);
  expect(ctx.lastWriteGateGrant).toBeNull();
  expect(existsSync(join(workdir, "blocked.txt"))).toBe(false);
});

test("WriteGateTest.test_team_writer_cli", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  // 空闲时 status 说没人拿名额。
  expect(await handleTeam(["writer", "status", team.id], home)).toBe(0);
  // 参谋长移交 + status 看到持有者 + 归还。
  expect(await handleTeam(["writer", "transfer", team.id, "out.txt", "member1"], home)).toBe(0);
  expect(listWriteLeases(home, team.id).map((l) => `${l.file}:${l.holder}`)).toEqual(["out.txt:member1"]);
  expect(await handleTeam(["writer", "release", team.id, "out.txt"], home)).toBe(0);
  expect(listWriteLeases(home, team.id)).toEqual([]);
  // 移交给非成员：拒绝。
  expect(await handleTeam(["writer", "transfer", team.id, "out.txt", "nobody"], home)).toBe(1);
  // 门外路径：拒绝。
  expect(await handleTeam(["writer", "transfer", team.id, "../escape.txt", "member1"], home)).toBe(2);
  // 没租约时归还：拒绝。
  expect(await handleTeam(["writer", "release", team.id, "out.txt"], home)).toBe(1);
});

test("WriteGateTest.test_release_all_writer_leases", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  expect(acquireWriteLease(home, team.id, "a.txt", "member1", "chief1").granted).toBe(true);
  expect(acquireWriteLease(home, team.id, "b.txt", "member1", "chief1").granted).toBe(true);
  expect(acquireWriteLease(home, team.id, "c.txt", "member2", "chief1").granted).toBe(true);
  expect(releaseAllWriterLeases(home, team.id, "member1", "chief1")).toBe(2);
  expect(listWriteLeases(home, team.id).map((l) => l.file)).toEqual(["c.txt"]);
  expect(releaseAllWriterLeases(home, team.id, "member1", "chief1")).toBe(0);
});
