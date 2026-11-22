// src/onboarding.ts — 缺口 35：对话式入职 + 一键角色模板。
//
// Nyra 以前是 CLI 优先：新用户须自己写配置、装技能、定 agent，第一次用
// 要先读文档、写配置、装技能，门槛劝退。本批补三件：
//   1. `nyra init` 对话式入职：三个问题（叫什么、干什么活、什么风格/红线）
//      → 生成 Soul 文件（缺口 28 的格式，不另起一套）+ 按角色预装技能包
//      + 输出一份可审的配置清单，用户确认后才生效；没确认不写任何东西。
//   2. `nyra templates` 一键角色模板：研究员 / 助理 / 店小二三个内置模板，
//      每个模板 = Soul（身份 + Tenets）+ 技能包 + 权限规则（不变量 deny
//      规则 + 一句权限说明）的打包文件；可导出成本地文件分享、导入时先验
//      形状与技能存在性，不过不装。
//   3. 首次唤醒就绪简报：入职完成即第一次唤醒，agent 主动发一条就绪简报
//      （我是谁、我会什么、我的红线是什么、本次花了多少 token），走终端
//      + 机主收件箱；`nyra wake` 可随时重发一次。
//
// 与相邻概念的区别（不要混淆）：
// - `nyra setup` 是首次启动向导：配模型与运行环境、跑示例任务；`nyra init`
//   定身份与角色，不碰模型配置。
// - `nyra vault init` 建密码箱；`nyra soul init` 只建一个空 Soul 文件；
//   `nyra init` 是完整入职（Soul + 技能包 + 清单确认 + 就绪简报）。
// - 缺口 46 的 `nyra template`（单数）是业务流程模板（流程 DSL + 连接器
//   + 验收标准 + 红线表引用）；本批的 `nyra templates`（复数）是入职角色
//   模板（Soul + 技能包 + 权限规则）。两种模板用途不同、格式不同、命令
//   不同，不合并、不互相改名。
// - 技能包只装本地已有的内置技能：从随仓的 skills/ 目录拷进 ~/.nyra/skills/
//   （已在那里的不覆盖、不顶替用户改过的版本）；不从网上拉取、不走厂商
//   Hub、不注册、不上传（避开调研报告 §5“厂商 Hub 依赖”红线）。
// - 就绪简报只发给机主本人（终端 + 收件箱 inbox.jsonl，缺口 8 以来
//   agent→机主的既有通道）：不对外发、不群发；直接推到 Telegram/Discord
//   等外部渠道须 Bot 已接通（缺口 27），本批不接线，等真 Bot 接通后再说。
// - 入职不调模型：就绪简报里“本次花了多少 token”恒为 0，如实写，不编数。
//
// 安全边界：
// - 账本 ~/.nyra/onboarding.json 原子写 0600，损坏先备份再抛错；
// - 清单确认门：没用户显式确认（--yes 或交互确认）不写 Soul、不装技能、
//   不记账本；已有 Soul 时默认不覆盖，须 --force 才覆盖（覆盖前仍须确认）；
// - 导入的模板包先验后装：形状不对、技能名不合法、技能文件不存在、deny
//   规则解析不出，一律拒绝、不写任何东西；
// - 事件只记元数据（agent、角色、模板 id、技能名），不记问答原文与绝对路径。
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveNyraHome } from "./memory.ts";
import { RunStore } from "./runs.ts";
import { parseRule } from "./permissionRules.ts";
import { parseSkillFile } from "./skills.ts";
import { appendInbox } from "./tasks.ts";
import { askApproval } from "./approvalUi.ts";
import {
  defaultSoul, loadSoul, saveSoul, soulExists, newTenetId, validateSoulAgentId,
  type SoulFile, type SoulTenet,
} from "./soul.ts";

export const ONBOARDING_FILE = "onboarding.json";
export const ONBOARDING_TEMPLATES_DIRNAME = "onboarding-templates";
export const ONBOARDING_SKILLS_DIRNAME = "skills";

/** 内置技能名（随仓 skills/ 目录里有的，PROTECTED_BUILTIN_SKILLS 的五项 + creator-mode）。 */
export const ONBOARDING_KNOWN_SKILLS = [
  "web-research", "verify-research", "deep-thinking", "debugging", "file-organizer", "creator-mode",
] as const;

export class OnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface RoleTenetSpec {
  kind: "invariant" | "prior";
  text: string;
  /** invariant 的 deny 规则（permissionRules 语法，如 "shell(rm *)"）；prior 一律空数组。 */
  deny: string[];
}

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  persona: string;
  goal: string;
  skills: string[];
  tenets: RoleTenetSpec[];
  /** 权限规则一句话：这个角色默认能干什么、什么事须先问人。 */
  permissions_note: string;
}

/** 三个内置角色模板（Soul + 技能包 + 权限规则的打包）。 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: "researcher",
    name: "研究员",
    description: "查资料、核实事实，交付带来源的结论。",
    persona: "说话直接、有事说事；先查证再下结论，不确定的地方明说，不猜。",
    goal: "帮机主查资料、核实事实，交付带来源、可复核的结论。",
    skills: ["web-research", "verify-research", "deep-thinking"],
    tenets: [
      { kind: "invariant", text: "删文件、清数据这类不可逆操作先问人", deny: ["shell(rm *)"] },
      { kind: "prior", text: "结论必须附来源链接；来源对不上就明说，不要硬编", deny: [] },
    ],
    permissions_note: "只读 + 起草：能查、能写草稿；对外发消息与花钱先问人。",
  },
  {
    id: "assistant",
    name: "助理",
    description: "日常杂事：整理文件、起草、排障。",
    persona: "说话直接、有事说事；先做再说，做完给一句结果，不啰嗦。",
    goal: "帮机主把日常杂事办了：整理文件、起草文案、修小问题。",
    skills: ["file-organizer", "creator-mode", "debugging"],
    tenets: [
      { kind: "invariant", text: "删文件、清数据这类不可逆操作先问人", deny: ["shell(rm *)"] },
      { kind: "prior", text: "改东西之前先留备份或说清改了哪几处", deny: [] },
    ],
    permissions_note: "整理与起草可自由做；删、改、对外发先问人。",
  },
  {
    id: "shopkeeper",
    name: "店小二",
    description: "店铺客服与订单跟进：查订单、核对信息、起草回复。",
    persona: "说话客气、有事说事；先核对订单信息再回复，不确定的地方问机主，不猜。",
    goal: "帮机主跟进店铺订单：查订单、核对物流、起草客户回复，发出前等机主批。",
    skills: ["web-research", "verify-research", "file-organizer"],
    tenets: [
      { kind: "invariant", text: "删文件、清数据这类不可逆操作先问人", deny: ["shell(rm *)"] },
      { kind: "prior", text: "客户回复只起草、不直接发，发出前等机主批；钱的事一律先问人", deny: [] },
    ],
    permissions_note: "查与起草可自由做；对外发消息与花钱永远先问人。",
  },
];

export function findRoleTemplate(id: string): RoleTemplate | null {
  return ROLE_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function listRoleTemplates(): RoleTemplate[] {
  return [...ROLE_TEMPLATES];
}

export interface InitAnswers {
  /** agent 的名字（身份名，如“阿研”）；空着默认 "Nyra"。 */
  name?: string;
  /** 角色：三个内置模板 id 之一，或 "custom"（干什么活自由写）。 */
  role?: string;
  /** 自定义角色时“干什么活”的一句话（role 为 custom 时必填）。 */
  work?: string;
  /** 风格（一两句话；空着用模板的 persona，custom 时空着就用 work）。 */
  persona?: string;
  /** 红线（一两句话；空着不写红线 Tenet）。 */
  redline?: string;
  /** 目标 Soul agent（默认 "default"）。 */
  agent?: string;
}

export interface InitPlan {
  agent: string;
  name: string;
  role: string;
  roleName: string;
  persona: string;
  goal: string;
  /** 要装的技能名（内置技能）。 */
  skills: string[];
  tenets: RoleTenetSpec[];
  permissions_note: string;
  /** 模板 id（custom 为 null）。 */
  template_id: string | null;
}

const TEXT_MAX = 500;
const NAME_MAX = 50;

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/**
 * 三问答案 → 可审的入职计划（纯函数，不写任何文件）。
 * role 是三个内置模板之一时 persona/goal/技能/Tenet 取模板的；
 * role 为 custom 或写了一句干什么活时，persona/goal 取用户写的，技能包为空。
 */
export function buildInitPlan(answers: InitAnswers): InitPlan {
  const agent = (answers.agent ?? "default").trim() || "default";
  validateSoulAgentId(agent);
  const name = cleanText(answers.name, NAME_MAX) || "Nyra";
  const roleRaw = (answers.role ?? "").trim();
  const work = cleanText(answers.work, TEXT_MAX);
  const personaAnswer = cleanText(answers.persona, TEXT_MAX);
  const redline = cleanText(answers.redline, TEXT_MAX);
  const template = roleRaw ? findRoleTemplate(roleRaw) : null;
  if (roleRaw && roleRaw !== "custom" && !template) {
    throw new OnboardingError(`没有这个角色：${roleRaw}（内置角色：researcher 研究员、assistant 助理、shopkeeper 店小二，或 custom 自定义）`);
  }
  let role = "custom";
  let roleName = "自定义";
  let persona = personaAnswer;
  let goal = work;
  let skills: string[] = [];
  let tenets: RoleTenetSpec[] = [
    { kind: "invariant", text: "删文件、清数据这类不可逆操作先问人", deny: ["shell(rm *)"] },
  ];
  let permissions_note = "只读 + 起草：能查、能写草稿；对外发消息与花钱先问人。";
  let template_id: string | null = null;
  if (template) {
    role = template.id;
    roleName = template.name;
    persona = personaAnswer || template.persona;
    goal = template.goal;
    skills = [...template.skills];
    tenets = [...template.tenets];
    permissions_note = template.permissions_note;
    template_id = template.id;
  } else {
    if (!work && !personaAnswer) {
      throw new OnboardingError("自定义角色须写一句干什么活（--work）或风格（--persona），不然不知道这个 agent 是干什么的");
    }
    if (!persona) persona = work || "说话直接、有事说事。";
    if (!goal) goal = "帮机主把交代的事办了。";
  }
  if (redline) tenets = [...tenets, { kind: "prior", text: `红线：${redline}`, deny: [] }];
  return { agent, name, role, roleName, persona, goal, skills, tenets, permissions_note, template_id };
}

/** 配置清单：入职前给用户审的一页纸（只列将要写的东西，不写文件）。 */
export function formatPlanChecklist(plan: InitPlan): string {
  const lines: string[] = [
    `入职计划（agent：${plan.agent}，角色：${plan.roleName}）：`,
    `  名字：${plan.name}`,
    `  风格：${plan.persona}`,
    `  干什么：${plan.goal}`,
    `  技能包：${plan.skills.length ? plan.skills.join("、") : "（无，不装技能）"}`,
    `  Tenet（${plan.tenets.length} 条）：`,
  ];
  for (const t of plan.tenets) {
    lines.push(`    - [${t.kind === "invariant" ? "不变量" : "偏好"}] ${t.text}${t.deny.length ? `（deny：${t.deny.join("、")}）` : ""}`);
  }
  lines.push(`  权限：${plan.permissions_note}`);
  return lines.join("\n");
}

/**
 * 就绪简报正文（我是谁、我会什么、我的红线是什么、本次花了多少 token）。
 * 入职不调模型，token 恒为 0，如实写，不编数。
 */
export function formatReadyBriefing(plan: Pick<InitPlan, "name" | "roleName" | "goal" | "skills" | "tenets" | "permissions_note">): string {
  const redlines = plan.tenets.map((t) => t.text);
  return [
    `你好，我是 ${plan.name}（${plan.roleName}），已就绪。`,
    `我会什么：${plan.goal}`,
    `技能包：${plan.skills.length ? plan.skills.join("、") : "无"}`,
    `我的红线：${redlines.length ? redlines.join("；") : "无"}`,
    `权限：${plan.permissions_note}`,
    `本次入职花了 0 token（入职不调模型）。`,
  ].join("\n");
}

export interface OnboardingRecord {
  version: 1;
  agent: string;
  completed_at: string;
  name: string;
  role: string;
  template_id: string | null;
  skills_installed: string[];
  skills_skipped: string[];
  /** 就绪简报已发过没有（发过就不再主动发，nyra wake 可重发）。 */
  briefing_pending: boolean;
  briefing_delivered_at: string | null;
  last_briefing: string | null;
  source: "init" | "templates";
}

function ensureHomeDir(home: string): string {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  return dir;
}

function writeJsonAtomic(home: string, filename: string, data: string): void {
  const dir = ensureHomeDir(home);
  const path = join(dir, filename);
  const tmp = join(dir, `.${filename}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function onboardingFilePath(home: string): string {
  return join(resolveNyraHome(home), ONBOARDING_FILE);
}

export function onboardingExists(home: string): boolean {
  return existsSync(onboardingFilePath(home));
}

/** 读入职账本：没有返回 null；损坏先备份再抛错（不静默重建）。 */
export function loadOnboarding(home: string): OnboardingRecord | null {
  const path = onboardingFilePath(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new OnboardingError(`入职账本损坏，已备份到 ${basename(backup)}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.agent !== "string") {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new OnboardingError(`入职账本格式不对，已备份到 ${basename(backup)}`);
  }
  return parsed as unknown as OnboardingRecord;
}

export function saveOnboarding(home: string, record: OnboardingRecord): void {
  writeJsonAtomic(home, ONBOARDING_FILE, JSON.stringify(record, null, 2) + "\n");
}

/** 入职操作单独建一条只记 onboarding_* 事件的运行（与信任圈同款做法）。 */
function recordOnboardingEvent(home: string, type: string, fields: Record<string, unknown>): string | null {
  try {
    const store = new RunStore(join(resolveNyraHome(home), "runs"));
    const state = store.create(`入职：${type}`, "onboarding", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, type, fields);
    store.setStatus(state.run_id, "completed_unverified");
    return state.run_id;
  } catch {
    return null;
  }
}

/**
 * 随仓内置技能的来源目录：测试注入优先，其次模块旁边的 skills/（源码跑法），
 * 再其次工作目录下的 skills/（从仓库 checkout 里跑）。找不到返回 null。
 */
export function bundledSkillsDir(opts?: { workdir?: string; skillsSrcDir?: string }): string | null {
  const candidates: string[] = [];
  if (opts?.skillsSrcDir) candidates.push(opts.skillsSrcDir);
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", "skills"));
  } catch { /* ignore */ }
  if (opts?.workdir) candidates.push(join(opts.workdir, "skills"));
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

export interface SkillInstallResult {
  installed: string[];
  skipped: string[];
  /** 缺文件的技能（源目录里没有）：有一个就整体拒绝，不装一半。 */
  missing: string[];
}

/**
 * 按角色预装技能包：把随仓 skills/ 里的技能文件拷进 ~/.nyra/skills/。
 * 已在那里的不覆盖（不顶替用户改过的版本）；源目录缺文件时整体拒绝。
 */
export function installRoleSkills(
  home: string,
  skillNames: string[],
  opts?: { workdir?: string; skillsSrcDir?: string },
): SkillInstallResult {
  const installed: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  if (!skillNames.length) return { installed, skipped, missing };
  const srcDir = bundledSkillsDir(opts);
  const targetDir = join(resolveNyraHome(home), ONBOARDING_SKILLS_DIRNAME);
  for (const name of skillNames) {
    const target = join(targetDir, `${name}.md`);
    if (existsSync(target)) {
      skipped.push(name);
      continue;
    }
    const src = srcDir ? join(srcDir, `${name}.md`) : null;
    if (!src || !existsSync(src)) {
      missing.push(name);
      continue;
    }
    try {
      const parsed = parseSkillFile(src);
      if (parsed.name !== name) {
        missing.push(name);
        continue;
      }
    } catch {
      missing.push(name);
      continue;
    }
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    copyFileSync(src, target);
    try { chmodSync(target, 0o600); } catch { /* ignore */ }
    installed.push(name);
  }
  if (missing.length) {
    // 缺文件就整体拒绝：已拷的也撤回，不装一半。
    for (const name of installed) {
      try { rmSync(join(targetDir, `${name}.md`), { force: true }); } catch { /* ignore */ }
    }
    return { installed: [], skipped, missing };
  }
  return { installed, skipped, missing };
}

/** 预检技能包：每个技能在源目录里有文件且解析出的 name 对得上；返回缺的技能名。 */
export function checkSkillsAvailable(
  skillNames: string[],
  opts?: { workdir?: string; skillsSrcDir?: string },
): string[] {
  if (!skillNames.length) return [];
  const srcDir = bundledSkillsDir(opts);
  const missing: string[] = [];
  for (const name of skillNames) {
    const src = srcDir ? join(srcDir, `${name}.md`) : null;
    if (!src || !existsSync(src)) {
      missing.push(name);
      continue;
    }
    try {
      if (parseSkillFile(src).name !== name) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * 把入职计划落盘：先预检技能包（缺文件直接拒绝、什么都不写），再写 Soul 文件
 * （缺口 28 格式）+ 装技能包 + 记账本 + 记事件。调用前须已过确认门（本函数不问人）。
 * Soul 已存在且没 --force 时由调用方拦住。
 */
export function applyInitPlan(
  home: string,
  plan: InitPlan,
  opts?: { workdir?: string; skillsSrcDir?: string; source?: "init" | "templates" },
): { installed: string[]; skipped: string[] } {
  const missing = checkSkillsAvailable(plan.skills, opts);
  if (missing.length) {
    throw new OnboardingError(`技能包缺文件，入职未开始（什么都没写）：缺 ${missing.join("、")}`);
  }
  const soul = defaultSoul(plan.agent);
  soul.identity = { name: plan.name, persona: plan.persona, goal: plan.goal };
  const now = nowIso();
  soul.tenets = plan.tenets.map((t): SoulTenet => ({
    id: newTenetId(),
    kind: t.kind,
    text: t.text,
    deny: [...t.deny],
    source_session: null,
    created_at: now,
    enabled: true,
  }));
  saveSoul(home, soul);
  const { installed, skipped } = installRoleSkills(home, plan.skills, opts);
  const record: OnboardingRecord = {
    version: 1,
    agent: plan.agent,
    completed_at: now,
    name: plan.name,
    role: plan.role,
    template_id: plan.template_id,
    skills_installed: installed,
    skills_skipped: skipped,
    briefing_pending: true,
    briefing_delivered_at: null,
    last_briefing: null,
    source: opts?.source ?? "init",
  };
  saveOnboarding(home, record);
  recordOnboardingEvent(home, "onboarding_completed", { agent: plan.agent, role: plan.role, template: plan.template_id ?? "" });
  return { installed, skipped };
}

/**
 * 就绪简报：正文进终端 + 机主收件箱（inbox.jsonl 是 agent→机主的既有通道），
 * 全文存进账本的 last_briefing，事件只记元数据。发过就不再主动发（nyra wake 可重发）。
 */
export function deliverReadyBriefing(home: string, plan: Pick<InitPlan, "name" | "roleName" | "goal" | "skills" | "tenets" | "permissions_note">): { text: string; runId: string } {
  const text = formatReadyBriefing(plan);
  const record = loadOnboarding(home);
  const runId = `onboarding-${record?.agent ?? "default"}`;
  appendInbox(runId, "ready", `就绪简报：我是 ${plan.name}（${plan.roleName}），已就绪。本次入职花了 0 token。`, home);
  if (record) {
    record.briefing_pending = false;
    record.briefing_delivered_at = nowIso();
    record.last_briefing = text;
    saveOnboarding(home, record);
  }
  recordOnboardingEvent(home, "onboarding_ready_briefing", { agent: record?.agent ?? "default", channel: "terminal+inbox" });
  return { text, runId };
}

/** 模板包文件形状（导入前先验后装）。 */
export interface RoleTemplatePackFile extends RoleTemplate {
  kind: "nyra-role-template";
  version: 1;
}

const TEMPLATE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SKILL_NAME_RE = /^[a-z][a-z0-9_-]+$/;

/** 验模板包文件：返回错误清单（空 = 通过）；形状不对、技能不认、deny 解析不出都拒绝。 */
export function validateRoleTemplatePack(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return ["模板包不是一个 JSON 对象"];
  if (raw.kind !== "nyra-role-template") errors.push("kind 必须是 nyra-role-template");
  if (raw.version !== 1) errors.push("version 必须是 1");
  if (typeof raw.id !== "string" || !TEMPLATE_ID_RE.test(raw.id)) {
    errors.push("id 只认小写字母开头、字母数字/下划线/连字符（最多 32 字）");
  } else if (findRoleTemplate(raw.id)) {
    errors.push(`id ${raw.id} 是内置模板，不能顶替`);
  }
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > NAME_MAX) errors.push("name 须是 1–50 字的名字");
  if (typeof raw.description !== "string" || raw.description.length > 200) errors.push("description 须是 200 字以内的说明");
  if (typeof raw.persona !== "string" || !raw.persona.trim() || raw.persona.length > TEXT_MAX) errors.push("persona 须是 1–500 字的风格");
  if (typeof raw.goal !== "string" || !raw.goal.trim() || raw.goal.length > TEXT_MAX) errors.push("goal 须是 1–500 字的目标");
  if (typeof raw.permissions_note !== "string" || raw.permissions_note.length > 200) errors.push("permissions_note 须是 200 字以内的权限说明");
  if (!Array.isArray(raw.skills)) {
    errors.push("skills 须是技能名数组");
  } else {
    for (const s of raw.skills) {
      if (typeof s !== "string" || !SKILL_NAME_RE.test(s)) errors.push(`技能名不合法：${String(s)}`);
      else if (!(ONBOARDING_KNOWN_SKILLS as readonly string[]).includes(s)) errors.push(`技能 ${s} 不是内置技能（模板包只能引用随仓的六个内置技能）`);
    }
  }
  if (!Array.isArray(raw.tenets)) {
    errors.push("tenets 须是 Tenet 数组");
  } else {
    if (raw.tenets.length > 10) errors.push("tenets 最多 10 条");
    for (const t of raw.tenets) {
      if (!isPlainObject(t)) { errors.push("tenet 不是对象"); continue; }
      if (t.kind !== "invariant" && t.kind !== "prior") errors.push(`tenet kind 只认 invariant / prior：${String(t.kind)}`);
      if (typeof t.text !== "string" || !t.text.trim() || t.text.length > TEXT_MAX) errors.push("tenet text 须是 1–500 字的正文");
      if (!Array.isArray(t.deny)) errors.push("tenet deny 须是规则数组");
      else {
        for (const r of t.deny) {
          if (typeof r !== "string" || !parseRule(r)) errors.push(`deny 规则解析不出：${String(r)}`);
        }
        if (t.kind === "prior" && t.deny.length) errors.push("prior 不能带 deny（prior 只进提示词，不进规则层）");
      }
    }
  }
  return errors;
}

export function packToFile(pack: RoleTemplate): RoleTemplatePackFile {
  return { kind: "nyra-role-template", version: 1, ...pack };
}

export function customTemplatesDir(home: string): string {
  return join(resolveNyraHome(home), ONBOARDING_TEMPLATES_DIRNAME);
}

/** 列出本地已存的自定义模板包（读不出的文件跳过，不拦列表）。 */
export function listCustomTemplates(home: string): { id: string; name: string }[] {
  const dir = customTemplatesDir(home);
  if (!existsSync(dir)) return [];
  const out: { id: string; name: string }[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch { return []; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Record<string, unknown>;
      if (typeof parsed.id === "string" && typeof parsed.name === "string") out.push({ id: parsed.id, name: parsed.name });
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 读一个自定义模板包：不存在或形状不对返回 null（调用方给明确报错）。 */
export function loadCustomTemplate(home: string, id: string): RoleTemplate | null {
  const path = join(customTemplatesDir(home), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (validateRoleTemplatePack(parsed).length) return null;
    const { kind: _kind, version: _version, ...pack } = parsed as RoleTemplatePackFile;
    return pack as RoleTemplate;
  } catch {
    return null;
  }
}

/** 存一个自定义模板包（0600；已存在且没 --force 时拒绝覆盖）。 */
export function saveCustomTemplate(home: string, pack: RoleTemplate, opts?: { force?: boolean }): void {
  const dir = customTemplatesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${pack.id}.json`);
  if (existsSync(path) && !opts?.force) {
    throw new OnboardingError(`自定义模板 ${pack.id} 已存在（要覆盖加 --force）`);
  }
  const tmp = join(dir, `.${pack.id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(packToFile(pack), null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 导出模板包到文件（内置或自定义；已存在且没 --force 时拒绝覆盖）。 */
export function exportRoleTemplate(home: string, id: string, outPath: string, opts?: { force?: boolean }): string {
  const template = findRoleTemplate(id) ?? loadCustomTemplate(home, id);
  if (!template) throw new OnboardingError(`没有这个角色模板：${id}（nyra templates list 看看有哪些）`);
  const target = resolve(outPath);
  if (existsSync(target) && !opts?.force) {
    throw new OnboardingError(`文件已存在：${target}（要覆盖加 --force）`);
  }
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(packToFile(template), null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  return target;
}

export interface OnboardingCliInput {
  onEvent?: (type: string, data: Record<string, unknown>) => void;
  /** 交互提问注入（测试用；不传走 readline 读 stdin）。 */
  ask?: (prompt: string) => Promise<string>;
  /** 确认注入（测试用；不传走 askApproval 读 stdin）。 */
  confirm?: (prompt: string) => Promise<boolean>;
}

export const ONBOARDING_USAGE = `nyra init [--name 名字] [--role researcher|assistant|shopkeeper|custom] [--work 干什么活] [--persona 风格] [--redline 红线] [--agent default] [--yes] [--force]
  对话式入职：三个问题（叫什么、干什么活、什么风格/红线）→ 生成 Soul + 按角色预装技能包 + 配置清单确认后生效；确认后发就绪简报。
  不加参数时交互问三个问题；Soul 已存在时默认不覆盖（要覆盖加 --force）。与 nyra setup（配模型与运行环境）与 nyra vault init（建密码箱）不同。
nyra templates <list|show <角色>|apply <角色>|export <角色> <文件>|import <文件>>
  一键角色模板：研究员 / 助理 / 店小二（Soul + 技能包 + 权限规则的打包文件，可导出成本地文件分享；导入先验后装）。
  与 nyra template（单数，缺口 46 的业务流程模板）不同：这里是入职角色模板。
nyra wake
  唤醒：重发一次就绪简报（我是谁、我会什么、我的红线、本次 0 token），走终端 + 机主收件箱。`;

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

/**
 * 行提问器：自带行缓冲队列，TTY 与管道都走它。
 * 不要用 node:readline 的 rl.question 连续提问——在管道 stdin 下，接口在
 * stdin 到 EOF 时自动 close 并丢掉挂起的提问回调，第一个问题能读到，第二
 * 个就永远等不到（交互 init 用管道喂答案时复现过；最小复现见测试）。
 * 这个提问器把到来的行先排队、按需取，EOF 时把挂起的提问以 "" 放行。
 */
export function makeLineAsker(input?: OnboardingCliInput): { ask: (prompt: string) => Promise<string>; close: () => void } {
  if (input?.ask) return { ask: input.ask, close: () => {} };
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let ended = false;
  let buffer = "";
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  };
  const onEnd = (): void => {
    ended = true;
    if (buffer.length) {
      const line = buffer;
      buffer = "";
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
    let w: ((line: string) => void) | undefined;
    while ((w = waiters.shift())) w("");
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  return {
    ask: async (prompt: string): Promise<string> => {
      process.stdout.write(prompt);
      if (lines.length) return lines.shift() as string;
      if (ended) return "";
      return new Promise<string>((resolvePromise) => waiters.push(resolvePromise));
    },
    close: (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    },
  };
}

async function confirmOrYes(argv: string[], prompt: string, input?: OnboardingCliInput): Promise<boolean> {
  if (argv.includes("--yes")) return true;
  if (input?.confirm) return input.confirm(prompt);
  const choice = await askApproval(prompt);
  return choice === "yes";
}

function parseRoleAnswer(answer: string): { role: string; work: string } {
  const a = answer.trim();
  if (a === "1" || a === "研究员" || a === "researcher") return { role: "researcher", work: "" };
  if (a === "2" || a === "助理" || a === "assistant") return { role: "assistant", work: "" };
  if (a === "3" || a === "店小二" || a === "shopkeeper") return { role: "shopkeeper", work: "" };
  return { role: "custom", work: a };
}

/** 入职确认门共用：已有 Soul 默认不覆盖 + 清单确认。返回 null 表示停下（什么都没写）。 */
async function confirmPlan(home: string, plan: InitPlan, argv: string[], input?: OnboardingCliInput, askConfirm?: () => Promise<boolean>): Promise<InitPlan | null> {
  if (soulExists(home, plan.agent) && !argv.includes("--force")) {
    process.stdout.write(`Soul ${plan.agent} 已存在（souls/${plan.agent}.json），不覆盖；要覆盖加 --force，改身份用 nyra soul edit。\n`);
    return null;
  }
  process.stdout.write(formatPlanChecklist(plan) + "\n");
  const ok = argv.includes("--yes") ? true : askConfirm ? await askConfirm() : await confirmOrYes(argv, "按这份清单入职吗？", input);
  if (!ok) {
    process.stdout.write("已取消，未写任何东西。\n");
    return null;
  }
  return plan;
}

function printBriefingResult(home: string, plan: InitPlan, installed: string[], skipped: string[]): void {
  const { text } = deliverReadyBriefing(home, plan);
  process.stdout.write(`入职完成：Soul ${plan.agent} 已写，技能包装了 ${installed.length ? installed.join("、") : "无"}${skipped.length ? `（${skipped.join("、")} 已在，不覆盖）` : ""}。\n`);
  process.stdout.write(text + "\n");
}

export async function handleInit(argv: string[], home: string, input?: OnboardingCliInput): Promise<number> {
  const cmd = argv[0];
  try {
    if (cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(ONBOARDING_USAGE + "\n");
      return 0;
    }
    if (cmd && !cmd.startsWith("-")) {
      process.stderr.write(`nyra init 不接受子命令（用法：nyra init [--name 名字] [--role 角色] [--yes]）\n`);
      return 2;
    }
    const hasFlags = ["--name", "--role", "--work", "--persona", "--redline", "--agent"].some((f) => argv.includes(f));
    let answers: InitAnswers;
    let asker: ReturnType<typeof makeLineAsker> | null = null;
    if (hasFlags) {
      answers = {
        name: flagValue(argv, "--name"),
        role: flagValue(argv, "--role"),
        work: flagValue(argv, "--work"),
        persona: flagValue(argv, "--persona"),
        redline: flagValue(argv, "--redline"),
        agent: flagValue(argv, "--agent"),
      };
    } else {
      process.stdout.write("三问入职：回答三个问题，我就把你的 agent 立起来。\n");
      asker = makeLineAsker(input);
      const name = (await asker.ask("1. 叫什么？（agent 的名字，默认 Nyra）")).trim();
      const roleAnswer = (await asker.ask("2. 干什么活？（1 研究员 / 2 助理 / 3 店小二，或直接写一句话）")).trim();
      const styleAnswer = (await asker.ask("3. 什么风格、有什么红线？（比如：说话直接；不对外发消息、不花钱）")).trim();
      const { role, work } = parseRoleAnswer(roleAnswer);
      answers = {
        name: name || undefined,
        role,
        work: work || undefined,
        redline: styleAnswer || undefined,
        agent: flagValue(argv, "--agent"),
      };
    }
    const plan = buildInitPlan(answers);
    const confirmed = await confirmPlan(home, plan, argv, input, asker ? async () => {
      const ans = (await asker.ask("按这份清单入职吗？（y/n，默认 y）")).trim().toLowerCase();
      return ans === "" || ans === "y" || ans === "yes" || ans === "1";
    } : undefined);
    asker?.close();
    if (!confirmed) return 0;
    const { installed, skipped } = applyInitPlan(home, confirmed, { source: "init" });
    printBriefingResult(home, confirmed, installed, skipped);
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`入职失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function handleTemplates(argv: string[], home: string, input?: OnboardingCliInput): Promise<number> {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(ONBOARDING_USAGE + "\n");
      return 0;
    }
    if (cmd === "list") {
      for (const t of listRoleTemplates()) {
        process.stdout.write(`${t.id}（${t.name}）：${t.description} 技能包：${t.skills.join("、")}\n`);
      }
      for (const c of listCustomTemplates(home)) {
        process.stdout.write(`${c.id}（${c.name}）：自定义模板（本地导入）\n`);
      }
      return 0;
    }
    if (cmd === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("用法：nyra templates show <角色>\n"); return 2; }
      const template = findRoleTemplate(id) ?? loadCustomTemplate(home, id);
      if (!template) { process.stderr.write(`没有这个角色模板：${id}\n`); return 1; }
      process.stdout.write(`${template.id}（${template.name}）：${template.description}\n  风格：${template.persona}\n  干什么：${template.goal}\n  技能包：${template.skills.join("、")}\n  Tenet：\n`);
      for (const t of template.tenets) {
        process.stdout.write(`    - [${t.kind === "invariant" ? "不变量" : "偏好"}] ${t.text}${t.deny.length ? `（deny：${t.deny.join("、")}）` : ""}\n`);
      }
      process.stdout.write(`  权限：${template.permissions_note}\n`);
      return 0;
    }
    if (cmd === "apply") {
      const id = argv[1];
      if (!id) { process.stderr.write("用法：nyra templates apply <角色> [--name 名字] [--agent default] [--yes] [--force]\n"); return 2; }
      const template = findRoleTemplate(id) ?? loadCustomTemplate(home, id);
      if (!template) { process.stderr.write(`没有这个角色模板：${id}\n`); return 1; }
      const agent = flagValue(argv, "--agent") ?? "default";
      validateSoulAgentId(agent);
      const plan = planFromTemplate(template, agent, flagValue(argv, "--name"));
      const confirmed = await confirmPlan(home, plan, argv, input);
      if (!confirmed) return 0;
      const { installed, skipped } = applyInitPlan(home, confirmed, { source: "templates" });
      recordOnboardingEvent(home, "onboarding_template_applied", { agent: confirmed.agent, template: template.id });
      printBriefingResult(home, confirmed, installed, skipped);
      return 0;
    }
    if (cmd === "export") {
      const id = argv[1];
      const out = argv[2];
      if (!id || !out) { process.stderr.write("用法：nyra templates export <角色> <文件> [--force]\n"); return 2; }
      const target = exportRoleTemplate(home, id, out, { force: argv.includes("--force") });
      process.stdout.write(`已导出：${target}\n`);
      return 0;
    }
    if (cmd === "import") {
      const file = argv[1];
      if (!file) { process.stderr.write("用法：nyra templates import <文件> [--agent default] [--yes] [--force]\n"); return 2; }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(resolve(file), "utf-8"));
      } catch (err: unknown) {
        process.stderr.write(`模板包读不出来：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      const errors = validateRoleTemplatePack(raw);
      if (errors.length) {
        process.stderr.write(`模板包校验没过，一个都没装：\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
        return 1;
      }
      const pack = raw as unknown as RoleTemplate;
      saveCustomTemplate(home, pack, { force: argv.includes("--force") });
      // 自定义模板的 role 不在内置表里：直接从模板出计划，不走 buildInitPlan 的内置 id 查表。
      const plan = planFromTemplate(pack, flagValue(argv, "--agent") ?? "default", flagValue(argv, "--name"));
      validateSoulAgentId(plan.agent);
      const confirmed = await confirmPlan(home, plan, argv, input);
      if (!confirmed) return 0;
      const { installed, skipped } = applyInitPlan(home, confirmed, { source: "templates" });
      recordOnboardingEvent(home, "onboarding_template_applied", { agent: confirmed.agent, template: pack.id });
      printBriefingResult(home, confirmed, installed, skipped);
      return 0;
    }
    process.stderr.write(`不认的 templates 子命令：${cmd}（list/show/apply/export/import）\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`模板操作失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** 从任意模板（内置或导入的自定义）直出入职计划（不走内置 id 查表）。 */
export function planFromTemplate(template: RoleTemplate, agent: string, name?: string): InitPlan {
  return {
    agent,
    name: name?.trim() || "Nyra",
    role: template.id,
    roleName: template.name,
    persona: template.persona,
    goal: template.goal,
    skills: [...template.skills],
    tenets: template.tenets.map((t) => ({ ...t, deny: [...t.deny] })),
    permissions_note: template.permissions_note,
    template_id: template.id,
  };
}

export async function handleWake(argv: string[], home: string, _input?: OnboardingCliInput): Promise<number> {
  try {
    if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
      process.stdout.write(ONBOARDING_USAGE + "\n");
      return 0;
    }
    if (argv.length) {
      process.stderr.write("nyra wake 不接受参数\n");
      return 2;
    }
    const record = loadOnboarding(home);
    if (!record) {
      process.stdout.write("还没入职，先跑 nyra init。\n");
      return 1;
    }
    const soul: SoulFile = loadSoul(home, record.agent);
    const template = record.template_id ? findRoleTemplate(record.template_id) ?? loadCustomTemplate(home, record.template_id) : null;
    const skills = [...record.skills_installed, ...record.skills_skipped];
    const plan: InitPlan = {
      agent: record.agent,
      name: soul.identity.name,
      role: record.role,
      roleName: template?.name ?? (record.role === "custom" ? "自定义" : record.role),
      persona: soul.identity.persona,
      goal: soul.identity.goal,
      skills,
      tenets: soul.tenets.map((t) => ({ kind: t.kind, text: t.text, deny: [...t.deny] })),
      permissions_note: template?.permissions_note ?? "自定义角色：按入职时定的权限来。",
      template_id: record.template_id,
    };
    const { text } = deliverReadyBriefing(home, plan);
    process.stdout.write(text + "\n");
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`唤醒失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
