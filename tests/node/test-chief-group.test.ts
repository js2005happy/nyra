// tests/node/test-chief-group.test.ts — 总指挥 + 群聊第 1 阶段（src/chiefGroup.ts）与网关接口
//（/api/chief*、/api/teams*、/api/groups/:id/{view,events,plans}、群里异步发消息）。
// 全部临时 home + 假机器人 / 假 provider，不连真模型、不花钱。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupStore, type BotRunner } from "../../src/groups.ts";
import {
  proposeChiefGroup, createChiefGroup, runChiefGroup, chiefCandidates, listChiefRuns, getChiefRun,
  CHIEF_MAX_MEMBERS, CHIEF_PERMISSION, ChiefError, GroupEventHub, memberIdFor, titleFor, chiefRunsPath,
} from "../../src/chiefGroup.ts";
import { defaultSoul, saveSoul, setCharter } from "../../src/soul.ts";
import { createTeam, prepareTeamDispatch, TEAM_AUDIT_FILE } from "../../src/team.ts";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function fakeBots(reply: (botId: string, prompt: string) => string | Error): BotRunner {
  return async (bot, prompt) => {
    const r = reply(bot.id, prompt);
    if (r instanceof Error) throw r;
    return { text: r, switches: [] };
  };
}

function makeSoul(home: string, agent: string, own = "负责写周报"): void {
  saveSoul(home, defaultSoul(agent));
  setCharter(home, agent, { own, sources: ["任务板"], output: "以 `## 结论` 开头", approval: "对外发送前须人批", stop: "缺数据时停下问人" });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("方案：没有团队时默认勾 3 个群聊默认成员，权限只读，上限 6，不含“组长”", () => {
  const home = tmp("nyra-chief-");
  const p = proposeChiefGroup(home, "登录页要改版：换新样式，补慢网络测试，更新快速上手文档。");
  expect(p.title).toBe("登录页要改版");
  expect(p.team).toBeNull();
  expect(p.max).toBe(CHIEF_MAX_MEMBERS);
  expect(CHIEF_MAX_MEMBERS).toBe(6);
  expect(p.members.length).toBe(3);
  expect(p.members.every((m) => m.permission === CHIEF_PERMISSION && CHIEF_PERMISSION === "readonly")).toBe(true);
  expect(p.candidates.map((c) => c.id)).not.toContain("lead");
  // 每个候选成员各有一只不同的丸子
  expect(new Set(p.candidates.map((c) => c.mascot)).size).toBe(p.candidates.length);
  expect(() => proposeChiefGroup(home, "  ")).toThrow(ChiefError);
});

test("方案：有团队时用团队成员，分工取 Charter；Soul 名映射成群成员 id", () => {
  const home = tmp("nyra-chief-team-");
  makeSoul(home, "chief1", "拆任务");
  makeSoul(home, "tester_1", "补测试、跑回归");
  makeSoul(home, "docs2", "更新文档");
  createTeam(home, { name: "web", chief: "chief1", members: ["tester_1", "docs2"] });
  const p = proposeChiefGroup(home, "改登录页");
  expect(p.team?.name).toBe("web");
  expect(p.members.map((m) => [m.id, m.role])).toEqual([["tester_1", "补测试、跑回归"], ["docs2", "更新文档"]]);
  expect(memberIdFor("9lives")).toBe("m-9lives");
  expect(titleFor("一句话很长很长很长很长很长很长很长很长很长很长很长很长很长")).toMatch(/…$/);
});

test("确认创建：2–6 个成员、只认候选成员、群成员都是只读；账本 0600", () => {
  const home = tmp("nyra-chief-create-");
  const groups = new GroupStore(join(home, "groups"), { botRunner: fakeBots(() => "好") });
  expect(() => createChiefGroup(home, groups, { task: "x", members: ["builder"] })).toThrow(/至少选 2/);
  expect(() => createChiefGroup(home, groups, { task: "x", members: ["builder", "nobody"] })).toThrow(/不认识/);
  const ids = chiefCandidates(home).candidates.map((c) => c.id);
  expect(ids.length).toBeGreaterThanOrEqual(4);
  const seven = [...ids, "a1", "a2", "a3"].slice(0, 7);
  expect(() => createChiefGroup(home, groups, { task: "x", members: seven })).toThrow(/最多 6/);
  const { run, room } = createChiefGroup(home, groups, { task: "补慢网络测试", members: ["builder", "reviewer"] });
  expect(room.bots.every((b) => b.mode === "readonly")).toBe(true);
  expect(run.steps.map((s) => s.status)).toEqual(["pending", "pending"]);
  expect(run.members.every((m) => m.permission === "readonly")).toBe(true);
  if (process.platform !== "win32") expect((statSync(chiefRunsPath(home)).mode & 0o777).toString(8)).toBe("600");
});

test("分派：逐个 @成员、交回、汇总；有人出错时汇总写“没交回”，状态 failed", async () => {
  const home = tmp("nyra-chief-run-");
  const prompts: Record<string, string> = {};
  const groups = new GroupStore(join(home, "groups"), {
    botRunner: fakeBots((id, prompt) => {
      prompts[id] = prompt;
      if (id === "reviewer") return new Error("超时");
      return `${id} 看完了，结论是可以改。细节在后面。`;
    }),
  });
  const { run } = createChiefGroup(home, groups, { task: "改登录页", members: ["builder", "reviewer", "verifier"] });
  const events: string[] = [];
  const done = await runChiefGroup(home, groups, run.id, (t) => events.push(t));
  expect(done.steps.map((s) => s.status)).toEqual(["done", "failed", "done"]);
  expect(done.status).toBe("failed");
  expect(done.summary?.lines.map((l) => l.ok)).toEqual([true, false, true]);
  expect(done.summary?.lines[0].text).toBe("builder 看完了，结论是可以改。");
  expect(done.summary?.lines[1].text).toMatch(/^没交回/);
  expect(done.summary?.title).toBe("改登录页：交回 2 / 3");
  // 分派消息在群记录里，@ 的就是这一步的成员，并写明只读
  expect(prompts.builder).toContain("[chief]: @builder 你负责：");
  expect(prompts.builder).toContain("只读");
  const msgs = groups.get(run.room_id).messages;
  expect(msgs[0].sender).toBe("chief");
  expect(msgs.at(-1)!.content.startsWith("汇总：")).toBe(true);
  expect(events).toEqual(["chief_dispatched", "chief_step_started", "chief_step_returned", "chief_step_started", "chief_step_failed", "chief_step_started", "chief_step_returned", "chief_summary"]);
  expect(listChiefRuns(home, run.room_id)[0].id).toBe(run.id);
});

test("群事件流：按 seq 增量取，超过上限丢最旧的", () => {
  const hub = new GroupEventHub(3);
  for (let i = 0; i < 5; i++) hub.push("r", "e", { i });
  const all = hub.since("r", 0);
  expect(all.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  expect(all.next).toBe(5);
  expect(hub.since("r", 4).events.map((e) => e.data.i)).toEqual([4]);
  expect(hub.since("other", 0)).toEqual({ events: [], next: 0 });
});

test("网关：/api/chief → 方案 → 建群 → 后台分派完成；群视图带丸子；事件流 JSON；异步群消息；鉴权", async () => {
  const home = tmp("nyra-chief-gw-");
  const gw = new Gateway({ home, workdir: tmp("nyra-chief-gw-wd-"), host: "127.0.0.1", port: 0, config: { mcp_enabled: false } });
  gw.groups = new GroupStore(join(home, "groups"), { botRunner: fakeBots((id) => `${id}：做完了。`) });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    for (const p of ["/api/chief", "/api/teams", "/api/groups/x/view"]) expect((await fetch(base + p)).status).toBe(403);
    const meta = await (await fetch(`${base}/api/chief`, { headers: h })).json() as { max: number; permission: string; candidates: { id: string }[]; running: number };
    expect(meta.max).toBe(6);
    expect(meta.permission).toBe("readonly");
    const prop = await (await fetch(`${base}/api/chief/proposals`, { method: "POST", headers: h, body: JSON.stringify({ task: "补快速上手的截图" }) })).json() as { members: { id: string }[] };
    expect(prop.members.length).toBe(3);
    expect((await fetch(`${base}/api/chief/proposals`, { method: "POST", headers: h, body: JSON.stringify({ task: "" }) })).status).toBe(400);
    const created = await fetch(`${base}/api/chief/groups`, { method: "POST", headers: h, body: JSON.stringify({ task: "补快速上手的截图", members: prop.members.map((m) => m.id) }) });
    expect(created.status).toBe(201);
    const { run, room } = await created.json() as { run: { id: string }; room: { id: string } };
    const view = await waitFor(async () => {
      const v = await (await fetch(`${base}/api/groups/${room.id}/view`, { headers: h })).json() as { chief: { status: string } | null; bots: { id: string; mascot: string; mode: string }[]; messages: { sender: string }[] };
      return v.chief && v.chief.status !== "running" ? v : null;
    });
    expect(view.chief!.status).toBe("done");
    expect(view.bots.every((b) => b.mode === "readonly" && b.mascot)).toBe(true);
    expect(new Set(view.bots.map((b) => b.mascot)).size).toBe(view.bots.length);
    expect(view.messages.filter((m) => m.sender === "chief").length).toBe(1 + 3 + 1);
    const ev = await (await fetch(`${base}/api/groups/${room.id}/events?format=json&since=0`, { headers: h })).json() as { events: { type: string }[]; next: number };
    expect(ev.events[0].type).toBe("chief_started");
    expect(ev.events.at(-1)!.type).toBe("chief_summary");
    const one = await (await fetch(`${base}/api/chief/runs/${run.id}`, { headers: h })).json() as { status: string };
    expect(one.status).toBe("done");
    const plans = await (await fetch(`${base}/api/groups/${room.id}/plans`, { headers: h })).json() as { plans: unknown[]; chief_runs: unknown[] };
    expect(plans.plans).toEqual([]);
    expect(plans.chief_runs.length).toBe(1);
    // 异步群消息：@ 一个成员，立刻 202，回答进事件流
    const target = prop.members[0].id;
    const sent = await fetch(`${base}/api/groups/${room.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: `@${target} 再看一眼`, async: true }) });
    expect(sent.status).toBe(202);
    await waitFor(async () => {
      const e = await (await fetch(`${base}/api/groups/${room.id}/events?format=json&since=${ev.next}`, { headers: h })).json() as { events: { type: string; data: { sender?: string } }[] };
      return e.events.some((x) => x.type === "group_send_done") && e.events.some((x) => x.type === "group_reply" && x.data.sender === target);
    });
    // SSE 形态
    const ctrl = new AbortController();
    const sse = await fetch(`${base}/api/groups/${room.id}/events?since=0`, { headers: h, signal: ctrl.signal });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    let buf = "";
    while (!buf.includes("chief_summary")) buf += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(buf).toContain("data: ");
    expect((await fetch(`${base}/api/groups/nope/view`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}/api/plans/gplan_000000000000`, { headers: h })).status).toBe(404);
  } finally { await gw.stop(); }
});

test("网关：团队列表、分派起 chief 会话（Soul = 参谋长、团队 chief 角色）、拿 lead 租约、审计、事件流", async () => {
  const home = tmp("nyra-chief-team-gw-");
  makeSoul(home, "chief1");
  makeSoul(home, "member1");
  makeSoul(home, "member2");
  const team = createTeam(home, { name: "alpha", chief: "chief1", members: ["member1", "member2"] });
  const provider = fakeProvider([{ content: "汇总：两位成员都交回了。" }]);
  const gw = new Gateway({ home, workdir: tmp("nyra-chief-team-wd-"), host: "127.0.0.1", port: 0, mode: "auto", providerFactory: () => provider as never, config: { mcp_enabled: false, fallback_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const list = await (await fetch(`${base}/api/teams`, { headers: h })).json() as { teams: { id: string; chief: string; mascots: Record<string, string> }[] };
    expect(list.teams.map((t) => t.id)).toEqual([team.id]);
    expect(list.teams[0].mascots.chief).toBe("chief");
    expect((await fetch(`${base}/api/teams/${team.id}`, { headers: h })).status).toBe(200);
    expect((await fetch(`${base}/api/teams/nope/dispatch`, { method: "POST", headers: h, body: JSON.stringify({ task: "x" }) })).status).toBe(404);
    expect((await fetch(`${base}/api/teams/${team.id}/dispatch`, { method: "POST", headers: h, body: JSON.stringify({ task: "" }) })).status).toBe(400);
    const res = await fetch(`${base}/api/teams/${team.id}/dispatch`, { method: "POST", headers: h, body: JSON.stringify({ task: "写本周周报" }) });
    expect(res.status).toBe(202);
    const d = await res.json() as { run_id: string; epoch: number };
    expect(d.epoch).toBeGreaterThan(0);
    const done = await waitFor(async () => {
      const v = await (await fetch(`${base}/api/teams/runs/${d.run_id}`, { headers: h })).json() as { status: string; output: string | null; chief: string; task: string };
      return v.status === "done" ? v : null;
    });
    expect(done.output).toBe("汇总：两位成员都交回了。");
    expect(done.chief).toBe("chief1");
    expect(done.task).toBe("写本周周报");
    const agent = gw.runs.get(d.run_id)!.agent!;
    expect(agent.teamRole).toBe("chief");
    expect(agent.soulAgent).toBe("chief1");
    expect(agent.teamId).toBe(team.id);
    // 会话里显示的是用户原话，不是参谋长的长任务文本
    const view = await (await fetch(`${base}/api/sessions/${d.run_id}`, { headers: h })).json() as { events: { type: string; data: { content?: string } }[] };
    expect(view.events.find((e) => e.type === "user")?.data.content).toBe("写本周周报");
    // 别的 lead 拿着租约时分派被拒（409），不抢
    const { transferTeamLead } = await import("../../src/teamLease.ts");
    expect(transferTeamLead(home, team.id, "chief1", "member1").granted).toBe(true);
    expect((await fetch(`${base}/api/teams/${team.id}/dispatch`, { method: "POST", headers: h, body: JSON.stringify({ task: "再来" }) })).status).toBe(409);
    const audit = readFileSync(join(home, TEAM_AUDIT_FILE), "utf-8");
    expect(audit).toContain('"kind":"dispatched"');
    expect((await fetch(`${base}/api/teams/runs/0123/events`, { headers: h })).status).toBe(404);
  } finally { await gw.stop(); }
});

test("prepareTeamDispatch：纪元写进任务文本；别人拿着 lead 租约时拒绝", async () => {
  const home = tmp("nyra-chief-prep-");
  makeSoul(home, "c");
  makeSoul(home, "m1");
  const team = createTeam(home, { name: "t", chief: "c", members: ["m1"] });
  const { plan, chiefTask } = await prepareTeamDispatch(home, team.id, "做事");
  expect(plan.epoch).toBeGreaterThan(0);
  expect(chiefTask).toContain(`分派纪元：${plan.epoch}`);
  const { transferTeamLead } = await import("../../src/teamLease.ts");
  expect(transferTeamLead(home, team.id, "c", "m1").granted).toBe(true);
  await expect(prepareTeamDispatch(home, team.id, "再做")).rejects.toThrow(/分派被拒/);
  expect(getChiefRun(home, "chief_000000000000")).toBeNull();
});
