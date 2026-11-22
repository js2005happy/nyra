// tests/node/test-v8-ui.test.ts — 设计稿 v8 落地（桌面 / 手机界面）的后端与页面专项：
// 每轮收尾交代只数做成了的（被拒绝的编辑不算“改了”）、git push 识别、会话列表 outcome、
// 项目记忆卡只读接口（三个文件 + 最近 3 条带来源会话）、user 事件带本轮 token 起点、
// 桌面页 / 手机页带上新结构与团子头像（v6.2 颜色），中英文案键齐全、不出现旧名。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { summarizeCalls, summarizeLastTurn, isGitPush } from "../../src/turnSummary.ts";
import { projectMemoryView, projectMemoryFile } from "../../src/projectMemory.ts";
import { appendMemory } from "../../src/memory.ts";
import { NYRA_AVATAR, NYRA_AVATAR_COLORS } from "../../src/nyraAvatar.ts";
import { fakeProvider } from "./fake-provider.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("turnSummary: 只数做成了的——编辑看结果、被拒绝的命令不算、git push 只认真的 push", () => {
  const msgs: Record<string, unknown>[] = [
    { role: "user", content: "上一轮" },
    { role: "assistant", content: "", tool_calls: [call("x0", "write_file", { path: "old.txt", content: "" })] },
    { role: "tool", tool_call_id: "x0", content: "已写入 old.txt（0 字符）" },
    { role: "user", content: "这一轮" },
    { role: "assistant", content: "", tool_calls: [call("r1", "read_file", { path: "a.ts" }), call("r2", "read_file", { path: "a.ts" }), call("r3", "read_file", { path: "nope.ts" })] },
    { role: "tool", tool_call_id: "r1", content: "1\tconst a = 1" },
    { role: "tool", tool_call_id: "r2", content: "1\tconst a = 1" },
    { role: "tool", tool_call_id: "r3", content: "错误：文件不存在" },
    { role: "assistant", content: "", tool_calls: [call("e1", "edit_file", { path: "a.ts", old_text: "1", new_text: "2" }), call("e2", "edit_file", { path: "b.ts", old_text: "1", new_text: "2" })] },
    { role: "tool", tool_call_id: "e1", content: "已编辑 a.ts" },
    { role: "tool", tool_call_id: "e2", content: "错误：用户拒绝执行" },
    { role: "assistant", content: "", tool_calls: [call("s1", "shell", { command: "pnpm test" }), call("s2", "shell", { command: "git push origin main" }), call("s3", "shell", { command: "rm -rf build" })] },
    { role: "tool", tool_call_id: "s1", content: "ok" },
    { role: "tool", tool_call_id: "s2", content: "错误：用户拒绝执行，并给出反馈：先别推" },
    { role: "tool", tool_call_id: "s3", content: "（无输出）" },
    { role: "assistant", content: "", tool_calls: [call("w9", "write_file", { path: "pending.ts", content: "" })] },
    { role: "assistant", content: "好了。" },
  ];
  const sm = summarizeLastTurn(msgs)!;
  expect(sm.steps).toBe(9);
  expect(sm.edited).toEqual(["a.ts"]); // b.ts 被拒绝、pending.ts 没结果，都不算
  expect(sm.read).toBe(1);
  expect(sm.commands).toBe(2); // 被拒绝的 git push 不算
  expect(sm.pushed).toBe(false);
  expect(summarizeLastTurn([{ role: "assistant", content: "hi" }])).toBeNull();
  const pushed = summarizeCalls([
    { role: "assistant", content: "", tool_calls: [call("p", "shell", { command: "cd app && git -C . push origin main" })] },
    { role: "tool", tool_call_id: "p", content: "Everything up-to-date" },
  ]);
  expect(pushed.pushed).toBe(true);
  expect(isGitPush("git push")).toBe(true);
  expect(isGitPush("git -C repo push --tags")).toBe(true);
  expect(isGitPush("git commit -m 'push it'")).toBe(false);
  expect(isGitPush("git push-mirror")).toBe(false);
  expect(isGitPush("echo gitpush")).toBe(false);
});

test("projectMemory: 三个文件在不在、MEMORY.md 最近 3 条带来源会话与时间；只读、拒绝符号链接、种类白名单", () => {
  const home = tmp("nyra-v8pm-");
  const workdir = tmp("nyra-v8pm-wd-");
  writeFileSync(join(workdir, "AGENTS.md"), "# 项目说明\n");
  let v = projectMemoryView(home, workdir);
  expect(v.files.map((f) => [f.kind, f.label, f.exists])).toEqual([["project", "AGENTS.md", true], ["global", "~/.nyra/AGENTS.md", false], ["memory", "MEMORY.md", false]]);
  expect(v.recent).toEqual([]);
  appendMemory("第一条", undefined, home, new Date(2026, 10, 20, 9, 0), "20261120-090000-aaaa");
  appendMemory("第二条", undefined, home, new Date(2026, 10, 21, 9, 0), null);
  appendMemory("第三条", undefined, home, new Date(2026, 10, 22, 9, 0), "20261122-090000-bbbb");
  appendMemory("第四条", undefined, home, new Date(2026, 10, 22, 10, 0), "20261122-100000-cccc");
  v = projectMemoryView(home, workdir);
  const mem = v.files.find((f) => f.kind === "memory")!;
  expect(mem.exists).toBe(true);
  expect(mem.count).toBe(4);
  expect(v.recent.map((e) => [e.text, e.source_session, e.created_at])).toEqual([
    ["第四条", "20261122-100000-cccc", "2026-11-22 10:00"],
    ["第三条", "20261122-090000-bbbb", "2026-11-22 09:00"],
    ["第二条", null, "2026-11-21 09:00"],
  ]);
  expect(projectMemoryFile(home, workdir, "project")).toMatchObject({ exists: true, content: "# 项目说明\n", truncated: false });
  expect(projectMemoryFile(home, workdir, "global")).toMatchObject({ exists: false, content: "" });
  expect(() => projectMemoryFile(home, workdir, "../../etc/passwd")).toThrow();
  const w2 = tmp("nyra-v8pm-link-");
  symlinkSync("/etc/hostname", join(w2, "AGENTS.md"));
  expect(() => projectMemoryFile(home, w2, "project")).toThrow();
  expect(projectMemoryView(home, w2).files[0].exists).toBe(false);
  // 大文件只给前 64 KiB
  writeFileSync(join(workdir, "AGENTS.md"), "x".repeat(70 * 1024));
  const big = projectMemoryFile(home, workdir, "project");
  expect(big.truncated).toBe(true);
  expect(big.content.length).toBe(64 * 1024);
});

test("gateway: /api/project-memory 鉴权；会话列表带最后一轮 outcome；user 事件带 token 起点；被拒绝的编辑不算改动", async () => {
  const home = tmp("nyra-v8gw-");
  const workdir = tmp("nyra-v8gw-wd-");
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "a.txt"), "one\n");
  writeFileSync(join(workdir, "AGENTS.md"), "# 规则\n");
  const provider = fakeProvider([
    { content: "", toolCalls: [call("r1", "read_file", { path: "src/a.txt" })] },
    { content: "", toolCalls: [call("w1", "write_file", { path: "src/a.txt", content: "two\n" })] },
    { content: "", toolCalls: [call("w2", "write_file", { path: "src/b.txt", content: "nope\n" })] },
    { content: "改好了。" },
  ]);
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, mode: "auto", providerFactory: () => provider as never, config: { mcp_enabled: false, fallback_enabled: false } });
  const info = await gw.start();
  try {
    const url = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    expect((await fetch(`${url}/api/project-memory`)).status).toBe(403);
    const pm = await (await fetch(`${url}/api/project-memory`, { headers: h })).json() as { files: { kind: string; exists: boolean }[] };
    expect(pm.files.map((f) => f.exists)).toEqual([true, false, false]);
    const file = await (await fetch(`${url}/api/project-memory/file?kind=project`, { headers: h })).json() as { content: string };
    expect(file.content).toBe("# 规则\n");
    expect((await fetch(`${url}/api/project-memory/file?kind=bogus`, { headers: h })).status).toBe(400);
    const sid = (await (await fetch(`${url}/api/sessions`, { method: "POST", headers: h, body: "{}" })).json() as { id: string }).id;
    await fetch(`${url}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "改一下" }) });
    type A = { id: string; tool: string; summary: string };
    const pending = async () => ((await (await fetch(`${url}/api/approvals`, { headers: h })).json()) as { approvals: A[] }).approvals[0];
    const a1 = await waitFor(pending);
    await fetch(`${url}/api/approvals/${a1.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true }) });
    const a2 = await waitFor(async () => { const a = await pending(); return a && a.id !== a1.id ? a : null; });
    await fetch(`${url}/api/approvals/${a2.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: false, feedback: "别建新文件" }) });
    const view = await waitFor(async () => { const v = await (await fetch(`${url}/api/sessions/${sid}`, { headers: h })).json() as { status: string; events: { type: string; data: Record<string, unknown> }[] }; return v.status !== "running" ? v : null; });
    const user = view.events.find((e) => e.type === "user")!;
    expect(user.data.usage_base).toEqual({ total_tokens: 0, missing_calls: 0 });
    const list = await (await fetch(`${url}/api/sessions`, { headers: h })).json() as { sessions: { id: string; outcome: { steps: number; edited: string[]; read: number; commands: number; pushed: boolean } | null }[] };
    const me = list.sessions.find((s) => s.id === sid)!;
    expect(me.outcome).toEqual({ steps: 3, edited: ["src/a.txt"], read: 1, commands: 0, pushed: false });
  } finally { await gw.stop(); }
});

test("v8 页面：桌面抽屉 / 实时状态 / 新审批卡 / 项目记忆卡，手机胶囊 / 空状态 / 队列；团子头像 v6.2 原色；中英文案齐全、无旧名", async () => {
  const { DESKTOP_HTML, desktopMessages } = await import("../../src/webuiDesktop.ts");
  const { MOBILE_V2_HTML, mobileMessages } = await import("../../src/webuiMobile.ts");
  expect(NYRA_AVATAR_COLORS).toEqual({ body: "#8688ff", eye: "#141414" });
  for (const svg of Object.values(NYRA_AVATAR)) { expect(svg).toContain('fill="#8688ff"'); expect(svg).toContain("#141414"); }
  for (const id of ['id="rhead"', 'id="rtabs"', 'id="rfoot"', 'id="home-mem"', 'id="thread-full"', 'id="av-work-s"', 'id="av-wait-s"', 'id="ic-copy"']) expect(DESKTOP_HTML).toContain(id);
  for (const fn of ["function liveLine(", "function wrapText(", "function eventTurns(", "function apprActs(", "function scopeBox(", "function overviewTab(", "function loadProjectMemory(", "/api/project-memory"]) expect(DESKTOP_HTML).toContain(fn);
  for (const id of ['id="cpills"', 'id="av-idle-m"', 'id="av-wait-s"']) expect(MOBILE_V2_HTML).toContain(id);
  for (const fn of ["function renderQueue(", "function emptyState(", "function renderCPills(", "function scopeBox("]) expect(MOBILE_V2_HTML).toContain(fn);
  // 没有“全部允许”按钮
  expect(MOBILE_V2_HTML).not.toMatch(/approve-all|allowAll/);
  const d = desktopMessages(); const m = mobileMessages();
  expect(Object.keys(d.zh).sort()).toEqual(Object.keys(d.en).sort());
  expect(Object.keys(m.zh).sort()).toEqual(Object.keys(m.en).sort());
  expect(d.zh["d.appr.denyAlt"]).toBe("不行，换个做法");
  expect(d.zh["d.scope.title"]).toBe("这一步能动到什么");
  expect(d.en["d.tab.overview"]).toBe("Overview");
  expect(m.zh["m.mode.auto"]).toBe("写入前先问");
  for (const html of [DESKTOP_HTML, MOBILE_V2_HTML]) expect(html.toLowerCase()).not.toContain("angel");
});
