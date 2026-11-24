// tests/node/test-stop-and-budget.test.ts — P0-3：窗口里能停止 + 花钱前见上限。
// 只测纯逻辑与文案：取消接口、停止后状态与打断标记、审批卡文案、月度上限门、
// 未知单价暂停、语言切换、窗口撤销。桌面页实际点击由 parent 另行补验。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";
import { MESSAGES } from "../../src/i18n.ts";
import { monthlyCapDecided } from "../../src/cost.ts";
import { DESKTOP_HTML, desktopMessages } from "../../src/webuiDesktop.ts";

function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), p));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

type H = Record<string, string>;
function headers(gw: Gateway): H {
  return { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
}

async function startGw(opts: {
  provider: ReturnType<typeof fakeProvider>;
  mode?: string;
  config?: Record<string, unknown>;
}): Promise<{ gw: Gateway; base: string; h: H }> {
  const gw = new Gateway({
    home: tmp("nyra-sb-"), workdir: tmp("nyra-sb-wd-"), host: "127.0.0.1", port: 0,
    mode: (opts.mode ?? "auto") as never,
    providerFactory: () => opts.provider as never,
    config: { mcp_enabled: false, fallback_enabled: false, ...(opts.config ?? {}) },
  });
  const info = await gw.start();
  return { gw, base: `http://127.0.0.1:${info.port}`, h: headers(gw) };
}

async function createSession(base: string, h: H): Promise<string> {
  const res = await fetch(`${base}/api/sessions`, { method: "POST", headers: h, body: "{}" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function sessionView(base: string, h: H, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/sessions/${id}`, { headers: h });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test("StopBudgetTest.test_monthlyCapDecided_only_counts_explicit_decision", () => {
  expect(monthlyCapDecided({})).toBe(false);
  expect(monthlyCapDecided({ monthly_cost_limit_usd: 10 } as never)).toBe(false);
  expect(monthlyCapDecided({ monthly_cost_limit_decided: true } as never)).toBe(true);
  expect(monthlyCapDecided({ monthly_cost_limit_decided: true, monthly_cost_limit_usd: null } as never)).toBe(true);
  expect(monthlyCapDecided({ monthly_cost_limit_decided: false, monthly_cost_limit_usd: 10 } as never)).toBe(false);
});

test("StopBudgetTest.test_appr_and_budget_copy_both_languages", () => {
  const zh = MESSAGES.zh;
  const en = MESSAGES.en;
  // 审批卡：写明约 10 分钟内不处理自动拒绝（卡上那行字，倒计时文案带 {t} 占位；超时后的记录是另一条）。
  expect(zh["d.appr.timeout"]).toContain("{sec}");
  expect(zh["d.appr.timeout"]).toContain("分钟");
  expect(zh["d.appr.timeout"]).toContain("自动拒绝");
  expect(en["d.appr.timeout"]).toContain("{sec}");
  expect(en["d.appr.timeout"]).toContain("minutes");
  expect(en["d.appr.timeout"]).toContain("Auto-reject");
  expect(zh["d.appr.timeoutNote"]).toContain("自动拒绝");
  expect(en["d.appr.timeoutNote"]).toContain("auto-reject");
  expect(zh["d.appr.expiresIn"]).toContain("{t}");
  expect(en["d.appr.expiresIn"]).toContain("{t}");
  // 停止：停止 / 正在停止 / 已停止 / 被打断的说明，中英文都有。
  for (const k of ["d.stop", "d.stopping", "d.stopped", "d.stoppedNote", "d.ov.stopped"] as const) {
    expect(zh[k].length).toBeGreaterThan(0);
    expect(en[k].length).toBeGreaterThan(0);
  }
  expect(zh["d.stoppedNote"]).toContain("打断");
  expect(en["d.stoppedNote"]).toContain("interrupted");
  // 上限：必选提示、未知金额、触顶，中英文都有。
  for (const k of ["d.budgetUndecided", "d.costUnknown", "d.budgetHit", "d.capRequired", "d.budget.title", "d.budget.hint", "d.budget.noCap", "d.budget.setCap", "d.budget.save", "d.budget.spent", "d.budget.spentNoCap", "d.budget.spentUnknown", "d.budget.undecided", "d.budget.needNumber"] as const) {
    expect(zh[k].length).toBeGreaterThan(0);
    expect(en[k].length).toBeGreaterThan(0);
  }
  expect(zh["d.budgetUndecided"]).toContain("月度上限");
  expect(zh["d.costUnknown"]).toContain("金额未知");
  expect(zh["d.costUnknown"]).toContain("已暂停");
  expect(zh["d.budgetHit"]).toContain("月度上限");
  // 撤销：按钮与三种结果文案，中英文都有。
  for (const k of ["d.undoLast", "d.undone", "d.undoFailed", "d.undoEmpty", "d.undoBusy"] as const) {
    expect(zh[k].length).toBeGreaterThan(0);
    expect(en[k].length).toBeGreaterThan(0);
  }
  // 桌面端文案中英文键集合相等（test-v8-ui 也强制，这里只核对本批新键在两边都在）。
  const msgs = desktopMessages();
  for (const k of ["d.stop", "d.stopping", "d.stopped", "d.stoppedNote", "d.appr.timeout", "d.appr.expiresIn", "d.appr.timeoutNote", "d.budget.title", "d.budget.undecided", "d.costUnknown", "d.budgetHit", "d.undoLast", "d.undone"] as const) {
    expect(typeof msgs.zh[k]).toBe("string");
    expect(typeof msgs.en[k]).toBe("string");
  }
});

test("StopBudgetTest.test_desktop_page_ships_stop_undo_budget_controls", () => {
  expect(DESKTOP_HTML).toContain("thread-stop");
  expect(DESKTOP_HTML).toContain("thread-undo");
  expect(DESKTOP_HTML).toContain("d.budget.title");
  expect(DESKTOP_HTML).toContain("d.stopping");
  expect(DESKTOP_HTML).toContain("d.appr.expiresIn");
  expect(DESKTOP_HTML).toContain("d.appr.timeout");
  expect(DESKTOP_HTML).toContain("note-line");
  expect(DESKTOP_HTML).toContain("/api/sessions/' + encodeURIComponent(S.session) + '/stop");
});

test("StopBudgetTest.test_stop_idle_session_is_noop", async () => {
  const { gw, base, h } = await startGw({ provider: fakeProvider([{ content: "ok" }]) });
  try {
    const sid = await createSession(base, h);
    const res = await fetch(`${base}/api/sessions/${sid}/stop`, { method: "POST", headers: h, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stopping: boolean };
    expect(body.ok).toBe(false);
    expect(body.stopping).toBe(false);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_stop_running_marks_interrupted_then_resumes", async () => {
  const provider = fakeProvider([{ content: "第一轮答完了。" }], { delayMs: 2000 });
  const { gw, base, h } = await startGw({ provider });
  try {
    const sid = await createSession(base, h);
    const sent = await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "慢慢想，别急" }) });
    expect(sent.status).toBe(202);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "running");
    // 运行中回退要被 409 挡住（先停下再回退）。
    const rw = await fetch(`${base}/api/sessions/${sid}/rewind`, { method: "POST", headers: h, body: JSON.stringify({ message_id: 1, action: "truncate" }) });
    expect(rw.status).toBe(409);
    // 停止：不等底层收尾就返回 ok + stopping。
    const stop = await fetch(`${base}/api/sessions/${sid}/stop`, { method: "POST", headers: h, body: "{}" });
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as { ok: boolean; stopping: boolean };
    expect(stopBody.ok).toBe(true);
    expect(stopBody.stopping).toBe(true);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) !== "running");
    const view = await sessionView(base, h, sid);
    expect(view.interrupted).toBe(true);
    expect(view.stopping).toBe(false);
    // 对话已保存（用户消息还在），停止后能继续发新消息，不卡死。
    const msgs = view.messages as { role: string; content: string }[];
    expect(msgs.some((m) => m.role === "user" && m.content.includes("慢慢想"))).toBe(true);
    const sent2 = await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "再说一句" }) });
    expect(sent2.status).toBe(202);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "done");
    const view2 = await sessionView(base, h, sid);
    expect(view2.interrupted).toBe(false);
    const history = (await (await fetch(`${base}/api/sessions/${sid}/history`, { headers: h })).json()) as { messages: { role: string }[] };
    expect(history.messages.filter((m) => m.role === "user").length).toBe(2);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_approval_pending_carries_expiry_and_timeout", async () => {
  const provider = fakeProvider([
    { content: "", toolCalls: [{ id: "w1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "notes.txt", content: "hello\n" }) } }] },
    { content: "写好了。" },
  ]);
  const { gw, base, h } = await startGw({ provider, mode: "auto" });
  try {
    const sid = await createSession(base, h);
    await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "写个笔记" }) });
    let pend: { id: string; tool: string; expires_at: string; timeout_seconds: number } | null = null;
    await waitFor(async () => {
      const list = (await (await fetch(`${base}/api/approvals`, { headers: h })).json()) as { approvals: typeof pend[] };
      pend = list.approvals[0] ?? null;
      return pend !== null;
    });
    expect(pend!.tool).toBe("write_file");
    expect(pend!.timeout_seconds).toBe(600);
    const remainMs = Date.parse(pend!.expires_at) - Date.now();
    expect(remainMs).toBeGreaterThan(550_000);
    expect(remainMs).toBeLessThanOrEqual(600_000);
    // 批了之后 run 能跑完（清理现场，不留挂起审批）。
    expect((await fetch(`${base}/api/approvals/${pend!.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true }) })).status).toBe(200);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "done");
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_cap_gate_blocks_paid_provider_until_decided", async () => {
  const provider = fakeProvider([{ content: "ok" }], { name: "deepseek", model: "deepseek-flash" });
  const { gw, base, h } = await startGw({ provider });
  try {
    const sid = await createSession(base, h);
    const sent = await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "花钱的任务" }) });
    expect(sent.status).toBe(202);
    const body = (await sent.json()) as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toContain("月度上限");
    expect(body.error).toContain("设置");
    expect(provider.calls).toBe(0);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_cap_gate_passes_when_no_cap_chosen_explicitly", async () => {
  const provider = fakeProvider([{ content: "ok" }], { name: "deepseek", model: "deepseek-flash" });
  const { gw, base, h } = await startGw({ provider, config: { monthly_cost_limit_decided: true, monthly_cost_limit_usd: null } });
  try {
    const sid = await createSession(base, h);
    const sent = await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "花钱的任务" }) });
    expect(sent.status).toBe(202);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "done");
    expect(provider.calls).toBe(1);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_cap_gate_passes_for_local_model", async () => {
  const provider = fakeProvider([{ content: "ok" }], { name: "ollama", model: "llama3" });
  const { gw, base, h } = await startGw({ provider });
  try {
    const sid = await createSession(base, h);
    const sent = await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "本地任务" }) });
    expect(sent.status).toBe(202);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "done");
    expect(provider.calls).toBe(1);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_unknown_pricing_pauses_with_amount_unknown", async () => {
  const provider = fakeProvider([{ content: "ok" }]);
  const { gw, base, h } = await startGw({ provider, config: { monthly_cost_limit_usd: 10, monthly_cost_limit_decided: true } });
  try {
    const sid = await createSession(base, h);
    const sent = await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "没单价的任务" }) });
    expect(sent.status).toBe(202);
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) !== "running");
    const view = await sessionView(base, h, sid);
    expect(view.status).toBe("error");
    expect(String(view.error)).toContain("金额未知，已暂停");
    expect(provider.calls).toBe(0);
    const events = view.events as { type: string }[];
    expect(events.some((e) => e.type === "budget_paused")).toBe(true);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_language_setting_roundtrips_and_info_carries_it", async () => {
  const { gw, base, h } = await startGw({ provider: fakeProvider([{ content: "ok" }]) });
  try {
    const home = (gw as unknown as { home: string }).home;
    const setEn = await fetch(`${base}/api/settings`, { method: "POST", headers: h, body: JSON.stringify({ language: "en" }) });
    expect(setEn.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
    expect(saved.language).toBe("en");
    const info = (await (await fetch(`${base}/api/info`, { headers: h })).json()) as { language: string | null };
    expect(info.language).toBe("en");
    const setZh = await fetch(`${base}/api/settings`, { method: "POST", headers: h, body: JSON.stringify({ language: "zh" }) });
    expect(setZh.status).toBe(200);
    const info2 = (await (await fetch(`${base}/api/info`, { headers: h })).json()) as { language: string | null };
    expect(info2.language).toBe("zh");
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_budget_summary_in_info_and_session_view", async () => {
  const { gw, base, h } = await startGw({ provider: fakeProvider([{ content: "ok" }]) });
  try {
    const info0 = (await (await fetch(`${base}/api/info`, { headers: h })).json()) as { budget: Record<string, unknown> };
    expect(info0.budget.monthly_cost_limit_decided).toBe(false);
    const set = await fetch(`${base}/api/settings`, { method: "POST", headers: h, body: JSON.stringify({ monthly_cost_limit_usd: 5 }) });
    expect(set.status).toBe(200);
    const info1 = (await (await fetch(`${base}/api/info`, { headers: h })).json()) as { budget: Record<string, unknown> };
    expect(info1.budget.monthly_cost_limit_decided).toBe(true);
    expect(info1.budget.monthly_cost_limit_usd).toBe(5);
    expect(typeof info1.budget.monthly_reset_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(info1.budget.monthly_reset_at)))).toBe(false);
    const sid = await createSession(base, h);
    const view = await sessionView(base, h, sid);
    expect((view.budget as Record<string, unknown>).monthly_cost_limit_decided).toBe(true);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_rewind_in_window_returns_result", async () => {
  const provider = fakeProvider([{ content: "第一轮答完了。" }]);
  const { gw, base, h } = await startGw({ provider });
  try {
    const sid = await createSession(base, h);
    await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "第一句" }) });
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "done");
    const history = (await (await fetch(`${base}/api/sessions/${sid}/history`, { headers: h })).json()) as { messages: { id: number; role: string }[] };
    const lastUser = [...history.messages].reverse().find((m) => m.role === "user");
    expect(lastUser).toBeDefined();
    const rw = await fetch(`${base}/api/sessions/${sid}/rewind`, { method: "POST", headers: h, body: JSON.stringify({ message_id: lastUser!.id, action: "truncate" }) });
    expect(rw.status).toBe(200);
    const rwBody = (await rw.json()) as { deleted: number };
    // truncate 的语义是“回退到这条消息”：保留这条 user 消息，删掉它之后
    // 的助手回复——上一轮被撤销，问题还在，可以改了重发。
    expect(rwBody.deleted).toBeGreaterThanOrEqual(1);
    const after = (await (await fetch(`${base}/api/sessions/${sid}/history`, { headers: h })).json()) as { messages: { role: string; text: string }[] };
    expect(after.messages.some((m) => m.role === "user" && m.text.includes("第一句"))).toBe(true);
    expect(after.messages.some((m) => m.role === "assistant" && m.text.includes("第一轮答完了"))).toBe(false);
  } finally { await gw.stop(); }
});

test("StopBudgetTest.test_session_view_carries_cost_and_stop_fields", async () => {
  const provider = fakeProvider([{ content: "ok" }], { name: "ollama", model: "llama3" });
  const { gw, base, h } = await startGw({ provider });
  try {
    const sid = await createSession(base, h);
    await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "本地任务" }) });
    await waitFor(async () => ((await sessionView(base, h, sid)).status as string) === "done");
    const view = await sessionView(base, h, sid);
    expect(view.stopping).toBe(false);
    expect(view.interrupted).toBe(false);
    const cost = view.cost as { status: string; spent_usd: number | null };
    expect(typeof cost).toBe("object");
    expect(["priced", "unpriced", "missing"]).toContain(cost.status);
    if (cost.status !== "priced") expect(cost.spent_usd).toBeNull();
  } finally { await gw.stop(); }
});
