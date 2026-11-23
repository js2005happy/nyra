// src/chiefGroup.ts — 总指挥 + 群聊（第 1 阶段，见 docs/chief.md）。
//
// 手机上一句话交给总指挥 → 出一张方案卡（成员 + 分工 + 权限）→ 用户增删成员、确认 → 建群（群聊成员只读）→
// 总指挥按成员逐个分派（在群里 @成员）→ 成员交回 → 总指挥汇总。代码标识沿用 chief（界面统一叫“总指挥”）。
//
// 第 1 阶段的边界（都写进文档，不假装做了）：
// - 成员权限只有“只读”：群聊建群时本来就只许 readonly（src/groups.ts），这里不放开；
//   “写入前先问 / 完全访问”、群内审批、验收打回、停止与改向属于第 2 阶段，不做也不在界面上出现。
// - 方案是确定性的：不调模型配人。候选成员 = 用户已建的团队成员（Soul + Charter，分工取 Charter 的 own）
//   + 群聊默认成员（src/groups.ts DEFAULT_BOTS，分工取 role）；默认勾选团队成员，没有团队时勾 3 个默认成员。
// - 分派是顺序的：一次只让一个成员回答（GroupStore.runOneBot），上一步出错不影响下一步，最后汇总写明谁没交回。
// - 汇总不编结论：每位成员一行，取他交回内容的第一句；没交回的写“没交回”。
//
// 账本：~/.nyra/chief-runs.json（原子写 0600）；群消息本身仍在群聊目录（src/groups.ts）。
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "./memory.ts";
import { DEFAULT_BOTS, MAX_BOTS, GroupStore, type BotConfig, type RoomMessage } from "./groups.ts";
import { listTeams, getTeam, type Team } from "./team.ts";
import { loadSoul, soulExists } from "./soul.ts";
import { assignMascots } from "./mascots.ts";

export const CHIEF_RUNS_FILE = "chief-runs.json";
/** 手机端群成员上限：与群聊 MAX_BOTS 一致（团队模式最多 8 个成员，手机上统一按 6 个）。 */
export const CHIEF_MAX_MEMBERS = MAX_BOTS;
export const CHIEF_MIN_MEMBERS = 2;
/** 第 1 阶段唯一的成员权限。 */
export const CHIEF_PERMISSION = "readonly" as const;
const MAX_TASK_CHARS = 2000;
const MAX_RUNS_KEPT = 200;
const EXCERPT_CHARS = 120;

export class ChiefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChiefError";
  }
}

export interface ChiefCandidate {
  /** 群里的成员 id（@ 用这个）。 */
  id: string;
  name: string;
  /** 分工（团队成员取 Charter 的 own，默认成员取 role）。 */
  role: string;
  source: "team" | "default";
  /** 头像丸子 key（src/mascots.ts）。 */
  mascot: string;
}

export interface ChiefProposal {
  task: string;
  title: string;
  team: { id: string; name: string; chief: string } | null;
  members: (ChiefCandidate & { permission: typeof CHIEF_PERMISSION })[];
  candidates: ChiefCandidate[];
  max: number;
  min: number;
}

export type ChiefStepStatus = "pending" | "running" | "done" | "failed";
export interface ChiefStep {
  id: string;
  member: string;
  title: string;
  status: ChiefStepStatus;
  started_at: string | null;
  finished_at: string | null;
  /** 成员交回内容的第一句（≤120 字）；失败时是错误说明。 */
  excerpt: string | null;
}

export type ChiefRunStatus = "running" | "done" | "failed";
export interface ChiefRun {
  id: string;
  room_id: string;
  title: string;
  task: string;
  team_id: string | null;
  members: { id: string; name: string; role: string; mascot: string; permission: typeof CHIEF_PERMISSION }[];
  steps: ChiefStep[];
  status: ChiefRunStatus;
  summary: { title: string; lines: { member: string; text: string; ok: boolean }[] } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ChiefRunStore {
  version: 1;
  runs: ChiefRun[];
}

const now = () => new Date().toISOString();

export function chiefRunsPath(home: string): string {
  return join(resolveNyraHome(home), CHIEF_RUNS_FILE);
}

function loadStore(home: string): ChiefRunStore {
  const path = chiefRunsPath(home);
  if (!existsSync(path)) return { version: 1, runs: [] };
  if (lstatSync(path).isSymbolicLink()) throw new ChiefError("总指挥账本不能是符号链接");
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as ChiefRunStore;
    if (raw && raw.version === 1 && Array.isArray(raw.runs)) return raw;
  } catch { /* 下面备份 */ }
  try { copyFileSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
  return { version: 1, runs: [] };
}

function saveStore(home: string, store: ChiefRunStore): void {
  const path = chiefRunsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (store.runs.length > MAX_RUNS_KEPT) store.runs = store.runs.slice(-MAX_RUNS_KEPT);
  const tmp = join(dirname(path), `.chief-runs-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8"); } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

export function listChiefRuns(home: string, roomId?: string): ChiefRun[] {
  const runs = loadStore(home).runs;
  return (roomId ? runs.filter((r) => r.room_id === roomId) : runs).slice().reverse();
}

export function getChiefRun(home: string, id: string): ChiefRun | null {
  return loadStore(home).runs.find((r) => r.id === id) ?? null;
}

function updateRun(home: string, id: string, fn: (run: ChiefRun) => void): ChiefRun {
  const store = loadStore(home);
  const run = store.runs.find((r) => r.id === id);
  if (!run) throw new ChiefError(`没有这个总指挥任务：${id}`);
  fn(run);
  run.updated_at = now();
  saveStore(home, store);
  return run;
}

/** Soul agent 名 → 群成员 id（群成员 id 只认小写字母开头的 [a-z0-9_-]{≤32}）。 */
export function memberIdFor(agent: string): string {
  let id = agent.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(id)) id = `m-${id}`;
  return id.slice(0, 32) || "member";
}

function teamCandidates(home: string, team: Team): ChiefCandidate[] {
  return team.members.map((agent) => {
    let role = "";
    try { if (soulExists(home, agent)) role = loadSoul(home, agent).charter?.own ?? ""; } catch { role = ""; }
    return { id: memberIdFor(agent), name: agent.slice(0, 60), role: (role || "团队成员").replace(/\s+/g, " ").slice(0, 200), source: "team" as const, mascot: "" };
  });
}

/** 候选成员：指定团队（没指定时第一个 active 团队）的成员 + 群聊默认成员（去掉“组长”，带队的是总指挥）。 */
export function chiefCandidates(home: string, teamIdOrName?: string | null): { team: Team | null; candidates: ChiefCandidate[] } {
  let team: Team | null = null;
  try {
    team = teamIdOrName ? getTeam(home, teamIdOrName) : (listTeams(home)[0] ?? null);
  } catch { team = null; }
  if (team && team.status !== "active") team = null;
  const out: ChiefCandidate[] = team ? teamCandidates(home, team) : [];
  for (const b of DEFAULT_BOTS) {
    if (b.id === "lead") continue;
    if (out.some((c) => c.id === b.id)) continue;
    out.push({ id: b.id, name: b.name, role: b.role, source: "default", mascot: "" });
  }
  const keys = assignMascots(out.map((c) => c.id));
  for (const c of out) c.mascot = keys[c.id];
  return { team, candidates: out };
}

function cleanTask(task: unknown): string {
  const text = String(task ?? "").trim();
  if (!text) throw new ChiefError("先说要做什么");
  if (text.length > MAX_TASK_CHARS) throw new ChiefError(`任务最长 ${MAX_TASK_CHARS} 字`);
  return text;
}

export function titleFor(task: string): string {
  const first = task.split(/[\n。！？!?]/)[0].trim() || task.trim();
  const short = first.split(/[：:，,]/)[0].trim() || first;
  return short.length > 24 ? short.slice(0, 24) + "…" : short;
}

/** 出方案（确定性，不调模型）：默认勾团队成员（≤6），没有团队时勾前 3 个默认成员。 */
export function proposeChiefGroup(home: string, task: unknown, opts: { team?: string | null } = {}): ChiefProposal {
  const text = cleanTask(task);
  const { team, candidates } = chiefCandidates(home, opts.team ?? null);
  const fromTeam = candidates.filter((c) => c.source === "team");
  const picked = (fromTeam.length >= CHIEF_MIN_MEMBERS ? fromTeam : candidates).slice(0, fromTeam.length >= CHIEF_MIN_MEMBERS ? CHIEF_MAX_MEMBERS : 3);
  return {
    task: text,
    title: titleFor(text),
    team: team ? { id: team.id, name: team.name, chief: team.chief } : null,
    members: picked.map((c) => ({ ...c, permission: CHIEF_PERMISSION })),
    candidates,
    max: CHIEF_MAX_MEMBERS,
    min: CHIEF_MIN_MEMBERS,
  };
}

function excerptOf(text: string): string {
  const flat = String(text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[#>*`_]/g, "").replace(/\s+/g, " ").trim();
  const first = /^(.+?[。！？!?；;])/.exec(flat)?.[1] ?? flat;
  return first.length > EXCERPT_CHARS ? first.slice(0, EXCERPT_CHARS) + "…" : first;
}

export function dispatchText(member: { id: string; role: string }, task: string): string {
  return `@${member.id} 你负责：${member.role}。整件事是：${task}\n这一阶段群成员都是只读：只看、只分析，不改文件、不跑会改东西的命令。做完把结果交回给我，第一句写结论。`;
}

export interface CreateChiefGroupInput {
  task: unknown;
  members: unknown;
  team?: string | null;
  title?: unknown;
}

/** 确认创建：建群（成员只读）+ 记一条总指挥任务（步骤 = 每位成员一步）。不在这里跑；跑用 runChiefGroup。 */
export function createChiefGroup(home: string, groups: GroupStore, input: CreateChiefGroupInput): { run: ChiefRun; room: ReturnType<GroupStore["get"]> } {
  const task = cleanTask(input.task);
  if (!Array.isArray(input.members)) throw new ChiefError("成员要是一个列表");
  const ids = [...new Set((input.members as unknown[]).map((m) => String(m ?? "").trim()).filter(Boolean))];
  if (ids.length < CHIEF_MIN_MEMBERS) throw new ChiefError(`至少选 ${CHIEF_MIN_MEMBERS} 个成员`);
  if (ids.length > CHIEF_MAX_MEMBERS) throw new ChiefError(`手机上一个群最多 ${CHIEF_MAX_MEMBERS} 个成员`);
  const { team, candidates } = chiefCandidates(home, input.team ?? null);
  const chosen = ids.map((id) => {
    const c = candidates.find((x) => x.id === id);
    if (!c) throw new ChiefError(`不认识这个成员：${id}`);
    return c;
  });
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 60) : titleFor(task);
  const bots: BotConfig[] = chosen.map((c) => {
    const def = DEFAULT_BOTS.find((b) => b.id === c.id);
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      instructions: def?.instructions ?? "按你的分工独立完成，交回时第一句写结论；只读，不改文件。",
      mode: CHIEF_PERMISSION,
    };
  });
  const roomId = `chief-${randomBytes(4).toString("hex")}`;
  const room = groups.create(roomId, title, bots);
  const run: ChiefRun = {
    id: `chief_${randomBytes(6).toString("hex")}`,
    room_id: roomId,
    title,
    task,
    team_id: team?.id ?? null,
    members: chosen.map((c) => ({ id: c.id, name: c.name, role: c.role, mascot: c.mascot, permission: CHIEF_PERMISSION })),
    steps: chosen.map((c) => ({
      id: `cs_${randomBytes(4).toString("hex")}`,
      member: c.id,
      title: c.role,
      status: "pending" as ChiefStepStatus,
      started_at: null,
      finished_at: null,
      excerpt: null,
    })),
    status: "running",
    summary: null,
    error: null,
    created_at: now(),
    updated_at: now(),
  };
  const store = loadStore(home);
  store.runs.push(run);
  saveStore(home, store);
  return { run, room };
}

export type ChiefEventSink = (type: string, data: Record<string, unknown>) => void;

/**
 * 跑一次总指挥分派：先在群里发分派总览，再逐个 @成员 让他回答（一次一个），记交回，最后汇总。
 * 每一步都写账本并发事件（网关转成群事件流）。出错的成员记 failed，不影响后面的人。
 */
export async function runChiefGroup(home: string, groups: GroupStore, runId: string, emit: ChiefEventSink = () => {}): Promise<ChiefRun> {
  const run = getChiefRun(home, runId);
  if (!run) throw new ChiefError(`没有这个总指挥任务：${runId}`);
  const safeEmit: ChiefEventSink = (t, d) => { try { emit(t, d); } catch { /* 观察器故障不影响分派 */ } };
  try {
    const overview = `分成 ${run.steps.length} 步，每位成员一步，做完交回给我，我汇总后给你：\n` +
      run.steps.map((s, i) => `${i + 1}. @${s.member} ${s.title}`).join("\n");
    await groups.appendTranscript(run.room_id, [{ sender: "chief", content: overview, time: now() }]);
    safeEmit("chief_dispatched", { run_id: run.id, steps: run.steps.map((s) => ({ id: s.id, member: s.member, title: s.title })) });
    for (const step of run.steps) {
      const member = run.members.find((m) => m.id === step.member)!;
      updateRun(home, run.id, (r) => {
        const s = r.steps.find((x) => x.id === step.id)!;
        s.status = "running";
        s.started_at = now();
      });
      await groups.appendTranscript(run.room_id, [{ sender: "chief", content: dispatchText(member, run.task), time: now() }]);
      safeEmit("chief_step_started", { run_id: run.id, step_id: step.id, member: step.member });
      let entry: RoomMessage;
      try {
        entry = await groups.runOneBot(run.room_id, step.member);
      } catch (err) {
        entry = { sender: step.member, content: `机器人执行失败：${err instanceof Error ? err.message : String(err)}`, time: now(), error: true };
      }
      const ok = !entry.error && Boolean(String(entry.content ?? "").trim());
      updateRun(home, run.id, (r) => {
        const s = r.steps.find((x) => x.id === step.id)!;
        s.status = ok ? "done" : "failed";
        s.finished_at = now();
        s.excerpt = excerptOf(entry.content);
      });
      safeEmit(ok ? "chief_step_returned" : "chief_step_failed", { run_id: run.id, step_id: step.id, member: step.member, excerpt: excerptOf(entry.content) });
    }
    const done = getChiefRun(home, run.id)!;
    const lines = done.steps.map((s) => {
      const m = done.members.find((x) => x.id === s.member)!;
      return { member: s.member, ok: s.status === "done", text: s.status === "done" ? (s.excerpt ?? "") : `没交回（${s.excerpt ?? "出错了"}）` };
    });
    const okCount = lines.filter((l) => l.ok).length;
    const summaryTitle = okCount === lines.length ? `${done.title}：${lines.length} 块都交回了` : `${done.title}：交回 ${okCount} / ${lines.length}`;
    const summaryText = `汇总：${summaryTitle}\n` + lines.map((l) => `- ${done.members.find((m) => m.id === l.member)!.name}：${l.text}`).join("\n");
    await groups.appendTranscript(run.room_id, [{ sender: "chief", content: summaryText, time: now() }]);
    const final = updateRun(home, run.id, (r) => {
      r.summary = { title: summaryTitle, lines };
      r.status = okCount === lines.length ? "done" : "failed";
    });
    safeEmit("chief_summary", { run_id: run.id, status: final.status, title: summaryTitle, returned: okCount, total: lines.length });
    return final;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = updateRun(home, run.id, (r) => {
      r.status = "failed";
      r.error = message.slice(0, 300);
      for (const s of r.steps) if (s.status === "running" || s.status === "pending") { s.status = "failed"; s.finished_at = now(); s.excerpt = s.excerpt ?? "没跑到"; }
    });
    safeEmit("chief_failed", { run_id: run.id, error: failed.error });
    return failed;
  }
}

// ---------------------------------------------------------------- 群事件 ---
export interface GroupEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

/** 每个群一条内存事件流（网关进程内；重启后从 0 开始，手机端重新拉群记录即可）。 */
export class GroupEventHub {
  private rooms = new Map<string, GroupEvent[]>();
  private seqs = new Map<string, number>();
  constructor(private readonly cap = 500) {}

  push(roomId: string, type: string, data: Record<string, unknown>): GroupEvent {
    const seq = (this.seqs.get(roomId) ?? 0) + 1;
    this.seqs.set(roomId, seq);
    const ev: GroupEvent = { seq, type, data, ts: Date.now() / 1000 };
    const list = this.rooms.get(roomId) ?? [];
    list.push(ev);
    if (list.length > this.cap) list.splice(0, list.length - this.cap);
    this.rooms.set(roomId, list);
    return ev;
  }

  since(roomId: string, seq: number): { events: GroupEvent[]; next: number } {
    const list = this.rooms.get(roomId) ?? [];
    const events = list.filter((e) => e.seq > seq);
    return { events, next: this.seqs.get(roomId) ?? 0 };
  }
}
