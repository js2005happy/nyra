// src/automations.ts — G-P1-37：自动化 bundle / preset（OpenHands 借鉴，
// 相似 agent 缺口报告 §2）。OpenHands 的自动化是一次装好整条：触发器分
// cron 和 event 两种，event 带 source / on / filter；装一个自动化就自带
// 建议触发器（suggested_trigger）；webhook 端点接事件。
//
// Nyra 的对应物此前是散的：event 触发器（source / event / match / task，
// 见 eventTriggers.ts）与 workflow 触发器（cron / event，见
// workflowTriggers.ts）各管各，没有“一次装好整条”这一层。本批补：
//   - bundle：一次安装 = 若干 event 触发器（启用）+ 若干建议触发器
//     （装好但默认关闭，suggested: true 标记，机主看过再开）+ 一个线程
//     （装自动化的状态与历史落点）+ 可选的线程 cron（create_for_thread）；
//   - 内置 3 个 preset，只用已有的触发器形态与真实事件名
//     （github.* / deploy.* / gmail.new_mail），不编新事件源；
//   - 用户也可以从 JSON 文件装自己的 bundle（严格校验，fail-closed）；
//   - 移除时按安装记录清掉建出来的触发器与线程，不留孤儿。
//
// 安全闸：建议触发器装好默认关，不经机主显式开启不跑；bundle 里引用的
// 工作流不存在或不是 active 时，那条线程 cron 跳过并记进 warnings，
// 不建悬空绑定；安装记录只记 id 与名字，不记触发任务正文。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export class AutomationError extends Error {
  constructor(message: string) { super(message); this.name = "AutomationError"; }
}

export const AUTOMATION_BUNDLES_FILE = "automation-bundles.json";
export const MAX_BUNDLES = 100;

export interface BundleTriggerDef {
  name: string;
  source: "webhook" | "gmail";
  event: string;
  match?: Record<string, string>;
  task: string;
  mode: "readonly" | "auto";
}

export interface BundleThreadCronDef {
  cron: string;
  workflow: string;
}

export interface BundleDef {
  id: string;
  name: string;
  description: string;
  triggers: BundleTriggerDef[];
  suggested_triggers: BundleTriggerDef[];
  thread?: { title: string; state?: Record<string, string | number | boolean | null> };
  thread_crons?: BundleThreadCronDef[];
}

export interface InstalledBundle {
  id: string;
  name: string;
  installed_at: string;
  trigger_names: string[];
  suggested_names: string[];
  thread_id: string | null;
  skipped_crons: Array<{ cron: string; workflow: string; reason: string }>;
}

export interface BundleStoreData {
  version: 1;
  bundles: InstalledBundle[];
}

/** 内置 preset：只用已有的触发器形态与真实事件名，不编新事件源。 */
export const BUILTIN_AUTOMATIONS: BundleDef[] = [
  {
    id: "github-pr-triage",
    name: "GitHub PR 只读 triage",
    description: "收到 PR 事件时只读 triage（标题与改动摘要），需要改动时进审阅队列，不直接改代码；issue 评论的 triage 作为建议触发器，默认关闭。",
    triggers: [
      { name: "pr-triage", source: "webhook", event: "github.pull_request", task: "收到 PR 事件：只读 triage（标题与改动摘要），需要改动时进审阅队列，不要直接改代码。", mode: "readonly" },
    ],
    suggested_triggers: [
      { name: "issue-comment-triage", source: "webhook", event: "github.issue_comment", task: "收到 issue 评论：只读摘要，有待办时写进收件箱，不要直接改代码。", mode: "readonly" },
    ],
    thread: { title: "github-pr-triage 自动化", state: { preset: "github-pr-triage" } },
  },
  {
    id: "deploy-watch",
    name: "部署完成记一笔",
    description: "部署完成时记一条部署记录进收件箱；部署失败的提醒作为建议触发器，默认关闭，不自动重部署。",
    triggers: [
      { name: "deploy-done", source: "webhook", event: "deploy.done", task: "部署完成：记一条部署记录进收件箱，含版本与时间。", mode: "readonly" },
    ],
    suggested_triggers: [
      { name: "deploy-failed", source: "webhook", event: "deploy.failed", task: "部署失败：只读摘要，写进收件箱并标红，不要自动重部署。", mode: "readonly" },
    ],
    thread: { title: "deploy-watch 自动化", state: { preset: "deploy-watch" } },
  },
  {
    id: "gmail-invoice-watch",
    name: "发票邮件提醒",
    description: "收到主题含“发票”的新邮件时读全文、提取发票号与金额写进收件箱汇报，不付款、不回信。",
    triggers: [
      { name: "invoice-mail", source: "gmail", event: "gmail.new_mail", match: { subject_contains: "发票" }, task: "收到一封可能含发票的邮件：发件人 {{event.actor}}，主题 {{event.summary}}。用 gmail_read 读全文，提取发票号与金额，写进 inbox 汇报，不要付款、不要回信。", mode: "readonly" },
    ],
    suggested_triggers: [],
    thread: { title: "gmail-invoice-watch 自动化", state: { preset: "gmail-invoice-watch" } },
  },
];

export function automationBundlesPath(home: string): string {
  return join(home, AUTOMATION_BUNDLES_FILE);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.automation-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
}

export function loadAutomationBundles(home: string): BundleStoreData {
  const p = automationBundlesPath(home);
  if (!existsSync(p)) return { version: 1, bundles: [] };
  if (lstatSync(p).isSymbolicLink()) throw new AutomationError("自动化账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new AutomationError("自动化账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as { version?: number }).version !== 1 || !Array.isArray((raw as { bundles?: unknown }).bundles)) {
    backupCorrupt(p);
    throw new AutomationError("自动化账本格式无效，已备份");
  }
  return raw as BundleStoreData;
}

export function saveAutomationBundles(home: string, data: BundleStoreData): void {
  const p = automationBundlesPath(home);
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new AutomationError("自动化账本不能是符号链接");
  atomicWriteJson(p, data);
}

export function listAutomations(home: string): InstalledBundle[] {
  return loadAutomationBundles(home).bundles;
}

export function getAutomation(home: string, id: string): InstalledBundle {
  const b = loadAutomationBundles(home).bundles.find((x) => x.id === id);
  if (!b) throw new AutomationError("自动化不存在");
  return b;
}

/** 已装的建议触发器（装好但默认关闭的那些），供机主看过再开。 */
export async function listInstalledSuggested(home: string): Promise<Array<{ id: string; name: string; source: string; event: string; mode: string; enabled: boolean }>> {
  const { listEventTriggers } = await import("./eventTriggers.ts");
  return listEventTriggers(home)
    .filter((t) => (t as { suggested?: boolean }).suggested === true)
    .map((t) => ({ id: t.id, name: t.name, source: t.source, event: t.event, mode: t.mode, enabled: t.enabled }));
}

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EVENT_RE = /^[A-Za-z0-9._-]+$/;

function validateTriggerDef(raw: unknown, where: string): BundleTriggerDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AutomationError(`${where}：触发器定义无效`);
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim() || r.name.trim().length > 100) throw new AutomationError(`${where}：触发器名不能为空且不超过 100 字符`);
  if (r.source !== "webhook" && r.source !== "gmail") throw new AutomationError(`${where}：触发器来源只允许 webhook 或 gmail`);
  if (typeof r.event !== "string" || !r.event.trim() || r.event.trim().length > 100 || !EVENT_RE.test(r.event.trim())) throw new AutomationError(`${where}：事件名无效`);
  if (typeof r.task !== "string" || !r.task.trim() || r.task.length > 8000) throw new AutomationError(`${where}：触发任务不能为空且不超过 8000 字符`);
  if (r.mode !== "readonly" && r.mode !== "auto") throw new AutomationError(`${where}：触发模式只允许 readonly 或 auto`);
  let match: Record<string, string> | undefined;
  if (r.match !== undefined && r.match !== null) {
    if (typeof r.match !== "object" || Array.isArray(r.match)) throw new AutomationError(`${where}：匹配条件无效`);
    match = {};
    for (const [k, v] of Object.entries(r.match as Record<string, unknown>)) {
      if (!["from_contains", "subject_contains", "text_contains"].includes(k)) throw new AutomationError(`${where}：匹配条件只允许 from_contains / subject_contains / text_contains`);
      if (typeof v !== "string" || !v.trim() || v.length > 200) throw new AutomationError(`${where}：匹配条件值不能为空且不超过 200 字符`);
      match[k] = v;
    }
    if (!Object.keys(match).length) match = undefined;
  }
  return {
    name: (r.name as string).trim(), source: r.source as "webhook" | "gmail",
    event: (r.event as string).trim(), ...(match ? { match } : {}),
    task: r.task as string, mode: r.mode as "readonly" | "auto",
  };
}

export function validateBundleDef(raw: unknown): BundleDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AutomationError("bundle 定义无效");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !BUNDLE_ID_RE.test(r.id)) throw new AutomationError("bundle id 只允许字母、数字、下划线、连字符（1–64 字符，字母或数字开头）");
  if (typeof r.name !== "string" || !r.name.trim() || r.name.trim().length > 100) throw new AutomationError("bundle 名字不能为空且不超过 100 字符");
  if (typeof r.description !== "string" || r.description.length > 500) throw new AutomationError("bundle 描述不能超过 500 字符");
  if (!Array.isArray(r.triggers)) throw new AutomationError("bundle 的 triggers 须是数组");
  if (r.suggested_triggers !== undefined && !Array.isArray(r.suggested_triggers)) throw new AutomationError("bundle 的 suggested_triggers 须是数组");
  const triggers = (r.triggers as unknown[]).map((t, i) => validateTriggerDef(t, `triggers[${i}]`));
  const suggested = ((r.suggested_triggers ?? []) as unknown[]).map((t, i) => validateTriggerDef(t, `suggested_triggers[${i}]`));
  const names = new Set<string>();
  for (const t of [...triggers, ...suggested]) {
    if (names.has(t.name)) throw new AutomationError(`触发器名重复：${t.name}`);
    names.add(t.name);
  }
  if (triggers.length + suggested.length > 20) throw new AutomationError("一个 bundle 最多 20 个触发器");
  let thread: BundleDef["thread"];
  if (r.thread !== undefined && r.thread !== null) {
    const th = r.thread as Record<string, unknown>;
    if (typeof th.title !== "string" || !th.title.trim() || th.title.trim().length > 100) throw new AutomationError("bundle 的线程标题不能为空且不超过 100 字符");
    thread = { title: (th.title as string).trim() };
    if (th.state !== undefined && th.state !== null) {
      if (typeof th.state !== "object" || Array.isArray(th.state)) throw new AutomationError("bundle 的线程初始状态须是对象");
      thread.state = th.state as Record<string, string | number | boolean | null>;
    }
  }
  let threadCrons: BundleDef["thread_crons"];
  if (r.thread_crons !== undefined && r.thread_crons !== null) {
    if (!Array.isArray(r.thread_crons)) throw new AutomationError("bundle 的 thread_crons 须是数组");
    if ((r.thread_crons as unknown[]).length > 10) throw new AutomationError("一个 bundle 最多 10 条线程 cron");
    if (!thread) throw new AutomationError("bundle 有 thread_crons 时须先定义 thread");
    threadCrons = (r.thread_crons as Array<Record<string, unknown>>).map((c, i) => {
      if (typeof c.cron !== "string" || !c.cron.trim() || typeof c.workflow !== "string" || !c.workflow.trim()) {
        throw new AutomationError(`thread_crons[${i}]：cron 与 workflow 都不能为空`);
      }
      return { cron: (c.cron as string).trim(), workflow: (c.workflow as string).trim() };
    });
  }
  return {
    id: r.id as string, name: (r.name as string).trim(),
    description: (r.description as string) ?? "",
    triggers, suggested_triggers: suggested,
    ...(thread ? { thread } : {}), ...(threadCrons ? { thread_crons: threadCrons } : {}),
  };
}

export function resolveBundleDef(idOrPath: string): BundleDef {
  const builtin = BUILTIN_AUTOMATIONS.find((b) => b.id === idOrPath);
  if (builtin) return builtin;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(idOrPath, "utf-8"));
  } catch {
    throw new AutomationError("找不到这个内置自动化，也读不到该路径的 bundle 文件");
  }
  return validateBundleDef(raw);
}

export interface InstallResult {
  bundle: InstalledBundle;
  warnings: string[];
}

/**
 * 一次装好整条自动化：event 触发器（启用）+ 建议触发器（装好但默认关）
 * + 一个线程（状态与历史落点）+ 线程 cron（引用的工作流不存在或不是
 * active 时跳过并记进 warnings，不建悬空绑定）。
 */
export async function installAutomation(home: string, idOrPath: string): Promise<InstallResult> {
  const def = resolveBundleDef(idOrPath);
  const store = loadAutomationBundles(home);
  if (store.bundles.some((b) => b.id === def.id)) throw new AutomationError(`自动化 ${def.id} 已安装，先移除再重装`);
  if (store.bundles.length >= MAX_BUNDLES) throw new AutomationError("自动化已达上限（100），先移除旧的再装");
  const { loadEventTriggers, saveEventTriggers, addEventTrigger, eventTriggersPath } = await import("./eventTriggers.ts");
  const { createThread, addThreadCron } = await import("./threads.ts");
  const { loadWorkflowRegistry } = await import("./workflow.ts");
  const warnings: string[] = [];
  const data = loadEventTriggers(eventTriggersPath(home));
  const existingNames = new Set(data.triggers.map((t) => t.name));
  for (const t of [...def.triggers, ...def.suggested_triggers]) {
    if (existingNames.has(t.name)) throw new AutomationError(`触发器名 ${t.name} 已存在，先改名或移除旧触发器再装`);
  }
  const triggerNames: string[] = [];
  const suggestedNames: string[] = [];
  for (const t of def.triggers) {
    addEventTrigger(data, { ...t, enabled: true });
    triggerNames.push(t.name);
  }
  for (const t of def.suggested_triggers) {
    addEventTrigger(data, { ...t, enabled: false, suggested: true });
    suggestedNames.push(t.name);
  }
  saveEventTriggers(data, eventTriggersPath(home));
  let threadId: string | null = null;
  const skippedCrons: InstalledBundle["skipped_crons"] = [];
  try {
    if (def.thread) {
      const thread = createThread(home, def.thread.title, { state: def.thread.state ?? {} });
      threadId = thread.id;
      if (def.thread_crons?.length) {
        let registry;
        try { registry = loadWorkflowRegistry(home); } catch { registry = { workflows: [] }; }
        const activeNames = new Set(
          (registry.workflows as Array<{ name: string; status: string }>)
            .filter((w) => w.status === "active").map((w) => w.name),
        );
        for (const c of def.thread_crons) {
          if (!activeNames.has(c.workflow)) {
            skippedCrons.push({ cron: c.cron, workflow: c.workflow, reason: "工作流不存在或不是 active" });
            warnings.push(`线程 cron 已跳过：工作流 ${c.workflow} 不存在或不是 active（${c.cron}）`);
            continue;
          }
          try {
            addThreadCron(home, threadId, c.cron, c.workflow);
          } catch (err) {
            skippedCrons.push({ cron: c.cron, workflow: c.workflow, reason: err instanceof Error ? err.message : String(err) });
            warnings.push(`线程 cron 已跳过：${c.workflow}（${err instanceof Error ? err.message : String(err)}）`);
          }
        }
      }
    }
  } catch (err) {
    // 线程建一半失败：回滚刚建的触发器，不留孤儿。
    const rollback = loadEventTriggers(eventTriggersPath(home));
    rollback.triggers = rollback.triggers.filter((t) => !triggerNames.includes(t.name) && !suggestedNames.includes(t.name));
    saveEventTriggers(rollback, eventTriggersPath(home));
    throw err;
  }
  const installed: InstalledBundle = {
    id: def.id, name: def.name, installed_at: new Date().toISOString(),
    trigger_names: triggerNames, suggested_names: suggestedNames,
    thread_id: threadId, skipped_crons: skippedCrons,
  };
  store.bundles.push(installed);
  saveAutomationBundles(home, store);
  return { bundle: installed, warnings };
}

/** 移除：按安装记录清掉建出来的触发器与线程，不留孤儿。 */
export async function removeAutomation(home: string, id: string): Promise<{ removedTriggers: number; removedThread: boolean }> {
  const store = loadAutomationBundles(home);
  const idx = store.bundles.findIndex((b) => b.id === id);
  if (idx < 0) throw new AutomationError("自动化不存在");
  const [installed] = store.bundles.splice(idx, 1);
  saveAutomationBundles(home, store);
  const { loadEventTriggers, saveEventTriggers, eventTriggersPath } = await import("./eventTriggers.ts");
  const data = loadEventTriggers(eventTriggersPath(home));
  const names = new Set([...installed.trigger_names, ...installed.suggested_names]);
  const before = data.triggers.length;
  data.triggers = data.triggers.filter((t) => !names.has(t.name));
  saveEventTriggers(data, eventTriggersPath(home));
  let removedThread = false;
  if (installed.thread_id) {
    const { removeThread } = await import("./threads.ts");
    removedThread = removeThread(home, installed.thread_id);
  }
  return { removedTriggers: before - data.triggers.length, removedThread };
}
