// src/teamPack.ts — M3（OpenMausBot 的“一键装一整队”借鉴）：
// 一个 Markdown（YAML frontmatter + 说明正文）装一整队机器人。
//
// 只借“队伍包”这个想法，不建中央目录：队伍包走 B 批已有的策展仓库
// 机制——每个 Bot 物化成 bot.json + routines.json（技能文件从本地
// 已装的技能里拷过来，队伍包不自带技能文件、不编内容）后过市场三道门
// （清单校验 + 确定性规则 + 独立审查）再安装；队伍本身只记一本
// team-packs.json 账本，不改 InstalledEntry 的形状。
// routine 到达即暂停：routine 不自动执行（市场语义），须手动启用。
// 安装中途失败要回滚：已装的 Bot 卸掉、队伍账本不记，失败进证据链。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  executeMarketplaceInstall,
  prepareMarketplaceInstallFromResolved,
  scanMarketplaceText,
  uninstallMarketplaceEntry,
  validateBotModel,
  MarketplaceError,
  type BotMode,
  type BotRoutine,
  type EnvRequirement,
  type HandoffTarget,
  type MarketEntryMeta,
  type MarketSource,
} from "./marketplace.ts";
import { PLUGIN_NAME_RE } from "./plugins.ts";
import { GroupStore } from "./groups.ts";
import type { RunStore } from "./runs.ts";
import type { ReviewerLike } from "./reviewer.ts";

export class TeamPackError extends Error {}

/** 队伍包文件上限（1MB）：Markdown 包不该比这大，超了就是传错了文件。 */
export const TEAM_PACK_MAX_BYTES = 1_000_000;
/** 队伍包 URL 下载超时（30 秒）。 */
export const TEAM_PACK_FETCH_TIMEOUT_MS = 30_000;

export interface TeamPackBot {
  name: string;
  role: string;
  instructions: string;
  model?: string;
  skills: string[];
  tools?: string[];
  permissions?: string[];
  mode?: BotMode;
  env_requires?: EnvRequirement[];
  hands_off_to?: HandoffTarget[];
  routines?: BotRoutine[];
}

export interface TeamPackChannel {
  name: string;
  bots: string[];
}

export interface TeamPack {
  team: string;
  version: string;
  chief: string;
  description?: string;
  bots: TeamPackBot[];
  channels?: TeamPackChannel[];
  playbook?: string;
  connectors?: string[];
}

export interface TeamPackRecord {
  team: string;
  version: string;
  chief: string;
  bots: string[];
  channels: string[];
  connectors?: string[];
  installed_at: string;
  source: string;
}

export function teamPackLedgerPath(home: string): string {
  return join(home, "team-packs.json");
}

export function loadTeamPacks(home: string): TeamPackRecord[] {
  const path = teamPackLedgerPath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(raw) ? (raw as TeamPackRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveTeamPacks(home: string, records: TeamPackRecord[]): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(teamPackLedgerPath(home), JSON.stringify(records, null, 2) + "\n", "utf-8");
}

// ---- YAML 子集解析器（仓库内没有通用 YAML 解析器，skills.ts 的
// parseSkillText 只认扁平 key: value；这里手写一个缩进解析器，只够
// 队伍包用：映射、序列、嵌套映射、字面块 |、折叠块 >、flow 列表 [a, b]、
// 单/双引号、数字/布尔/null。行尾注释只认 " #" 开头的（值里带 # 的
// URL 不受影响）。解析失败直接报行号，不静默吞掉。 ----

interface YamlLine {
  indent: number;
  text: string;
  no: number;
}

function yamlLines(text: string): YamlLine[] {
  const out: YamlLine[] = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    out.push({ indent, text: line.trimEnd(), no: i + 1 });
  }
  return out;
}

function stripInlineComment(value: string): string {
  // 只剥 " #" 后的注释；引号内的 # 不动（简化：值以引号开头时不剥）。
  const t = value.trim();
  if (t.startsWith("\"") || t.startsWith("'")) return t;
  const at = t.indexOf(" #");
  return at === -1 ? t : t.slice(0, at).trim();
}

function parseScalar(raw: string, no: number): unknown {
  const v = stripInlineComment(raw);
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if ((v.startsWith("\"") && v.endsWith("\"") && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    const inner = v.slice(1, -1);
    return v.startsWith("\"") ? inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((s) => parseScalar(s, no));
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/** flow 列表按顶层逗号切（引号内的逗号不动）。 */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseBlock(lines: YamlLine[], pos: { i: number }, indent: number): unknown {
  if (pos.i >= lines.length) return null;
  const first = lines[pos.i]!;
  if (first.indent < indent) return null;
  const text = first.text.slice(first.indent);
  if (text.startsWith("- ") || text === "-") return parseSequence(lines, pos, first.indent);
  if (/^[^:\s][^:]*:/.test(text)) return parseMapping(lines, pos, first.indent);
  // 裸标量（不该出现在队伍包里，报清楚）。
  throw new TeamPackError(`YAML 第 ${first.no} 行无法解析（队伍包只认映射、序列与标量）：${text}`);
}

function parseMapping(lines: YamlLine[], pos: { i: number }, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  while (pos.i < lines.length) {
    const line = lines[pos.i]!;
    if (line.indent !== indent) break;
    const text = line.text.slice(indent);
    if (text.startsWith("- ")) break;
    const m = text.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (!m) throw new TeamPackError(`YAML 第 ${line.no} 行无法解析：${text}`);
    const key = m[1]!.trim();
    const rest = m[2] ?? "";
    pos.i += 1;
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      // 字面块 / 折叠块：收后面更深缩进的行，去掉公共缩进。
      const block: string[] = [];
      let base: number | null = null;
      while (pos.i < lines.length && lines[pos.i]!.indent > indent) {
        const b = lines[pos.i]!;
        if (base === null) base = b.indent;
        block.push(b.text.slice(Math.min(base, b.text.length - b.text.trimStart().length)));
        pos.i += 1;
      }
      out[key] = rest.startsWith("|") ? block.join("\n") : block.join(" ");
      continue;
    }
    if (rest !== "") {
      out[key] = parseScalar(rest, line.no);
      continue;
    }
    // 空值：后面是更深缩进的块就解析它，否则 null。
    if (pos.i < lines.length && lines[pos.i]!.indent > indent) {
      out[key] = parseBlock(lines, pos, lines[pos.i]!.indent);
    } else {
      out[key] = null;
    }
  }
  return out;
}

function parseSequence(lines: YamlLine[], pos: { i: number }, indent: number): unknown[] {
  const out: unknown[] = [];
  while (pos.i < lines.length) {
    const line = lines[pos.i]!;
    if (line.indent !== indent) break;
    const text = line.text.slice(indent);
    if (!text.startsWith("- ") && text !== "-") break;
    const after = text === "-" ? "" : text.slice(2);
    const itemNo = line.no;
    pos.i += 1;
    if (!after) {
      // "- " 后面空着：后面更深缩进的块就是这一项。
      if (pos.i < lines.length && lines[pos.i]!.indent > indent) {
        out.push(parseBlock(lines, pos, lines[pos.i]!.indent));
      } else {
        out.push(null);
      }
      continue;
    }
    if (/^[^:\s][^:]*:/.test(after)) {
      // "- key: value"：行内映射开头，续行与 key 同缩进（indent + 2）。
      const sub: YamlLine[] = [{ indent: indent + 2, text: " ".repeat(indent + 2) + after, no: itemNo }];
      while (pos.i < lines.length && lines[pos.i]!.indent > indent) {
        sub.push(lines[pos.i]!);
        pos.i += 1;
      }
      const subPos = { i: 0 };
      out.push(parseMapping(sub, subPos, indent + 2));
      continue;
    }
    out.push(parseScalar(after, itemNo));
  }
  return out;
}

/** 解析一段 YAML 子集文本；不是映射时直接报错。 */
export function parseYamlSubset(text: string): Record<string, unknown> {
  const lines = yamlLines(text);
  if (!lines.length) throw new TeamPackError("YAML 为空");
  const pos = { i: 0 };
  const out = parseBlock(lines, pos, lines[0]!.indent);
  if (pos.i < lines.length) {
    throw new TeamPackError(`YAML 第 ${lines[pos.i]!.no} 行无法解析（缩进不对或多余内容）`);
  }
  if (!out || typeof out !== "object" || Array.isArray(out)) {
    throw new TeamPackError("队伍包 frontmatter 顶层必须是映射（team/version/bots……）");
  }
  return out as Record<string, unknown>;
}

// ---- 队伍包解析与校验 ----

function bad(msg: string): never {
  throw new TeamPackError(msg);
}

function reqString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) bad(`${where} 缺少 ${key}（须是非空字符串）`);
  return (v as string).trim();
}

function optString(obj: Record<string, unknown>, key: string, where: string, max = 0): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") bad(`${where} 的 ${key} 须是字符串`);
  if (max > 0 && v.length > max) bad(`${where} 的 ${key} 超过 ${max} 字`);
  return v;
}

function strList(obj: Record<string, unknown>, key: string, where: string, required: boolean): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) bad(`${where} 缺少 ${key}（须是非空字符串数组）`);
    return undefined;
  }
  if (!Array.isArray(v) || !v.length || v.some((s) => typeof s !== "string" || !s)) {
    bad(`${where} 的 ${key} 须是非空字符串数组`);
  }
  return [...(v as string[])];
}

function parsePackBot(raw: unknown, idx: number): TeamPackBot {
  const where = `bots[${idx}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad(`${where} 必须是映射`);
  const o = raw as Record<string, unknown>;
  const name = reqString(o, "name", where);
  if (!PLUGIN_NAME_RE.test(name)) bad(`${where} 的 name 无效（只允许小写字母、数字、- 和 _，以字母或数字开头）`);
  const role = reqString(o, "role", where);
  const instructions = reqString(o, "instructions", where);
  const skills = strList(o, "skills", where, true)!;
  const tools = strList(o, "tools", where, false);
  if (tools && tools.some((t) => !/^[a-z][a-z0-9_]*$/.test(t))) bad(`${where} 的 tools 须是 Nyra 工具名（小写字母开头，只含小写字母、数字、下划线）`);
  const permissions = strList(o, "permissions", where, false);
  const modeRaw = o.mode;
  let mode: BotMode | undefined;
  if (modeRaw !== undefined && modeRaw !== null) {
    if (modeRaw !== "readonly" && modeRaw !== "auto") bad(`${where} 的 mode 只允许 readonly|auto（队伍包不许声明 full 模式）`);
    mode = modeRaw as BotMode;
  }
  const model = optString(o, "model", where, 128);
  let env_requires: EnvRequirement[] | undefined;
  if (o.env_requires !== undefined && o.env_requires !== null) {
    if (!Array.isArray(o.env_requires) || !o.env_requires.length) bad(`${where} 的 env_requires 写了就不能为空数组`);
    env_requires = [];
    for (const e of o.env_requires as Record<string, unknown>[]) {
      if (!e || typeof e !== "object") bad(`${where} 的 env_requires 里有非对象条目`);
      if (typeof e.name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(e.name)) {
        bad(`${where} 的 env_requires.name 无效（大写字母开头，只含大写字母、数字、下划线）`);
      }
      env_requires.push({
        name: e.name,
        ...(typeof e.description === "string" ? { description: e.description } : {}),
        ...(typeof e.required === "boolean" ? { required: e.required } : {}),
        ...(typeof e.default === "string" ? { default: e.default } : {}),
      });
    }
  }
  let hands_off_to: HandoffTarget[] | undefined;
  if (o.hands_off_to !== undefined && o.hands_off_to !== null) {
    if (!Array.isArray(o.hands_off_to) || !o.hands_off_to.length) bad(`${where} 的 hands_off_to 写了就不能为空数组`);
    hands_off_to = [];
    for (const h of o.hands_off_to as Record<string, unknown>[]) {
      if (!h || typeof h !== "object") bad(`${where} 的 hands_off_to 里有非对象条目`);
      if (typeof h.target !== "string" || !PLUGIN_NAME_RE.test(h.target)) {
        bad(`${where} 的 hands_off_to.target 无效（只允许小写字母、数字、- 和 _，以字母或数字开头）`);
      }
      hands_off_to.push({
        target: h.target,
        ...(typeof h.when === "string" ? { when: h.when.trim() } : {}),
      });
    }
  }
  let routines: BotRoutine[] | undefined;
  if (o.routines !== undefined && o.routines !== null) {
    if (!Array.isArray(o.routines)) bad(`${where} 的 routines 必须是数组`);
    routines = [];
    for (const r of o.routines as Record<string, unknown>[]) {
      if (!r || typeof r !== "object") bad(`${where} 的 routines 里有非对象条目`);
      if (typeof r.name !== "string" || !r.name) bad(`${where} 的 routine 缺少 name`);
      if (r.kind !== "schedule" && r.kind !== "event") bad(`${where} 的 routine ${r.name} 的 kind 只允许 schedule|event`);
      if (r.kind === "schedule" && (typeof r.schedule !== "string" || !r.schedule)) {
        bad(`${where} 的 routine ${r.name} 是 schedule 但没写 schedule`);
      }
      if (r.kind === "event" && (typeof r.event !== "string" || !r.event)) {
        bad(`${where} 的 routine ${r.name} 是 event 但没写 event`);
      }
      if (typeof r.task !== "string" || !r.task.trim() || r.task.length > 8000) {
        bad(`${where} 的 routine ${r.name} 的 task 为空或超过 8000 字`);
      }
      if (r.mode !== undefined && r.mode !== "readonly" && r.mode !== "auto") {
        bad(`${where} 的 routine ${r.name} 的 mode 只允许 readonly|auto`);
      }
      routines.push({
        name: r.name,
        kind: r.kind as "schedule" | "event",
        ...(typeof r.schedule === "string" ? { schedule: r.schedule } : {}),
        ...(typeof r.event === "string" ? { event: r.event } : {}),
        task: r.task,
        ...(r.mode !== undefined ? { mode: r.mode as BotMode } : {}),
      });
    }
  }
  return {
    name, role, instructions, skills,
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
    ...(permissions ? { permissions } : {}),
    ...(mode ? { mode } : {}),
    ...(env_requires ? { env_requires } : {}),
    ...(hands_off_to ? { hands_off_to } : {}),
    ...(routines ? { routines } : {}),
  };
}

/**
 * 解析队伍包 Markdown：YAML frontmatter（--- 之间）+ 说明正文。
 * 正文只做展示（安装预览里给人看），不执行、不参与校验。
 */
export function parseTeamPack(text: string): TeamPack {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) bad("队伍包须以 YAML frontmatter 开头（--- 包住 team/version/bots……，后面是说明正文）");
  const front = parseYamlSubset(m[1]!);
  const team = reqString(front, "team", "队伍包");
  if (!PLUGIN_NAME_RE.test(team)) bad("队伍包的 team 无效（只允许小写字母、数字、- 和 _，以字母或数字开头）");
  const version = reqString(front, "version", "队伍包");
  const chief = reqString(front, "chief", "队伍包");
  const description = optString(front, "description", "队伍包", 500);
  const playbook = optString(front, "playbook", "队伍包", 20000);
  if (!Array.isArray(front.bots) || front.bots.length < 2 || front.bots.length > 6) {
    bad("队伍包的 bots 须是 2–6 个机器人（一个队伍至少两个人，群聊上限 6 个）");
  }
  const bots = (front.bots as unknown[]).map((b, i) => parsePackBot(b, i));
  const names = bots.map((b) => b.name);
  if (new Set(names).size !== names.length) bad("队伍包里机器人名字不能重复");
  if (!names.includes(chief)) bad(`队伍包的 chief ${chief} 不在 bots 里（队长必须是队伍里的一台 Bot）`);
  for (const b of bots) {
    for (const h of b.hands_off_to ?? []) {
      if (!names.includes(h.target)) bad(`机器人 ${b.name} 的交接目标 ${h.target} 不在队伍里（队伍包里的交接只认队内成员）`);
    }
  }
  let channels: TeamPackChannel[] | undefined;
  if (front.channels !== undefined && front.channels !== null) {
    if (!Array.isArray(front.channels)) bad("队伍包的 channels 必须是数组");
    channels = [];
    for (let i = 0; i < front.channels.length; i++) {
      const c = front.channels[i] as Record<string, unknown>;
      if (!c || typeof c !== "object" || Array.isArray(c)) bad(`channels[${i}] 必须是映射`);
      const name = reqString(c, "name", `channels[${i}]`);
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
        bad(`channels[${i}] 的 name 无效（群房间 id：小写字母开头，只含小写字母、数字、_、-，最长 32 字）`);
      }
      const members = strList(c, "bots", `channels[${i}]`, true)!;
      if (members.length < 2 || members.length > 6) bad(`channels[${i}] 的 bots 须是 2–6 个`);
      for (const id of members) {
        if (!names.includes(id)) bad(`channels[${i}] 的机器人 ${id} 不在队伍里`);
      }
      channels.push({ name, bots: members });
    }
    if (new Set(channels.map((c) => c.name)).size !== channels.length) bad("队伍包里频道名字不能重复");
  }
  const connectors = strList(front, "connectors", "队伍包", false);
  return {
    team, version, chief, bots,
    ...(description ? { description } : {}),
    ...(channels ? { channels } : {}),
    ...(playbook ? { playbook } : {}),
    ...(connectors ? { connectors } : {}),
  };
}

/**
 * 安装前校验（须联网/读配置的部分）：模型须是已配置的、整包过
 * 确定性规则扫描（拒密钥与破坏性命令）、每台 Bot 引用的技能须已装
 * 在本地（~/.nyra/skills/<名>.md）。解析本身的形状校验在
 * parseTeamPack 里已经做完。
 */
export function validateTeamPack(home: string, pack: TeamPack, rawText: string): void {
  for (const b of pack.bots) {
    if (b.model) validateBotModel(home, b.model);
    for (const skill of b.skills) {
      if (!existsSync(join(home, "skills", `${skill}.md`))) {
        throw new TeamPackError(`机器人 ${b.name} 引用的技能 ${skill} 还没装在本地（~/.nyra/skills/${skill}.md 不存在）：队伍包不自带技能文件，先装好技能再装队伍包`);
      }
    }
  }
  const hits = scanMarketplaceText(rawText, `队伍包 ${pack.team}`);
  if (hits.length) {
    throw new TeamPackError(`确定性规则拦截，拒绝安装：\n${hits.map((h) => `- ${h.where}：${h.reason}`).join("\n")}`);
  }
}

// ---- 安装 ----

export interface TeamPackInstallResult {
  team: string;
  version: string;
  installed: { name: string; version: string; path: string }[];
  channels: { name: string; created: boolean; warning?: string }[];
  warnings: string[];
}

function recordTeamEvent(store: RunStore | undefined, runId: string | undefined, type: string, fields: Record<string, unknown>): void {
  if (!store || !runId) return;
  try {
    store.appendEvent(runId, type, fields);
  } catch { /* 运行目录没了只丢审计副本，不破坏安装本身 */ }
}

/**
 * 装一整队：每个 Bot 物化成 bot.json + routines.json，走市场三道门
 * （prepareMarketplaceInstallFromResolved）再安装；频道随后建成群聊房。
 * 中途失败回滚：已装的 Bot 卸掉、队伍账本不记，失败进证据链。
 * sourceLabel 是包的来源（本地路径或 https URL），只记队伍账本。
 */
export async function installTeamPack(
  home: string,
  pack: TeamPack,
  opts: {
    config: Record<string, unknown>;
    runner?: ReviewerLike | null;
    force?: boolean;
    store?: RunStore;
    runId?: string;
    sourceLabel: string;
  },
): Promise<TeamPackInstallResult> {
  const tmpBase = join(home, ".nyra", "marketplace-tmp");
  mkdirSync(tmpBase, { recursive: true });
  const installed: { name: string; version: string; path: string }[] = [];
  const warnings: string[] = [];
  const cleanups: (() => void)[] = [];
  const cleanupAll = () => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
  };
  try {
    for (const bot of pack.bots) {
      const dir = mkdtempSync(join(tmpBase, "nyra-team-pack-"));
      cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
      const manifest: Record<string, unknown> = {
        name: bot.name,
        version: pack.version,
        description: bot.role,
        skills: bot.skills,
        ...(bot.tools ? { tools: bot.tools } : {}),
        ...(bot.permissions ? { permissions: bot.permissions } : {}),
        ...(bot.mode ? { mode: bot.mode } : {}),
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.env_requires ? { env_requires: bot.env_requires } : {}),
        ...(bot.hands_off_to ? { hands_off_to: bot.hands_off_to } : {}),
      };
      writeFileSync(join(dir, "bot.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
      if (bot.routines?.length) {
        writeFileSync(join(dir, "routines.json"), JSON.stringify(bot.routines, null, 2) + "\n", "utf-8");
      }
      // 技能文件从本地已装的技能里拷过来（队伍包不自带技能文件、不编内容）：
      // 三道门要验 skills/<名>.md，没有它清单校验不过。
      mkdirSync(join(dir, "skills"), { recursive: true });
      for (const skill of bot.skills) {
        const src = join(home, "skills", `${skill}.md`);
        if (!existsSync(src)) {
          throw new TeamPackError(`机器人 ${bot.name} 引用的技能 ${skill} 还没装在本地（~/.nyra/skills/${skill}.md 不存在）`);
        }
        copyFileSync(src, join(dir, "skills", `${skill}.md`));
      }
      const entry: MarketEntryMeta = {
        id: bot.name,
        kind: "bot",
        name: bot.name,
        version: pack.version,
        description: bot.role,
        source: `team-pack:${pack.team}`,
        path: ".",
        tools: bot.tools,
        permissions: bot.permissions,
        mode: bot.mode,
      };
      const source: MarketSource = { name: `team-${pack.team}`, kind: "local", path: dir, added_at: new Date().toISOString() };
      let prepared;
      try {
        prepared = await prepareMarketplaceInstallFromResolved(home, { entry, source, dir }, { config: opts.config, runner: opts.runner });
      } catch (err: unknown) {
        throw new TeamPackError(`机器人 ${bot.name} 过不了市场三道门，整队不装：${err instanceof Error ? err.message : String(err)}`);
      }
      const result = executeMarketplaceInstall(home, prepared, { force: opts.force, store: opts.store, runId: opts.runId });
      installed.push({ name: bot.name, version: pack.version, path: result.installed.installed_path });
      if (result.warnings?.length) warnings.push(...result.warnings);
    }
  } catch (err: unknown) {
    // 回滚：已装的 Bot 卸掉（卸不掉只记提醒，不把半队留给用户）。
    for (const done of installed) {
      try {
        uninstallMarketplaceEntry(home, done.name, { store: opts.store, runId: opts.runId });
      } catch (rollbackErr: unknown) {
        warnings.push(`回滚卸不掉 ${done.name}（须手动 nyra market uninstall ${done.name}）：${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }
    recordTeamEvent(opts.store, opts.runId, "team_pack_install_failed", {
      team: pack.team,
      version: pack.version,
      bots: installed.map((b) => b.name).join(","),
      reason: err instanceof Error ? err.message : String(err),
    });
    cleanupAll();
    throw err;
  }
  cleanupAll();
  // 频道建成群聊房（房间 id 即频道名，成员即包里对应的 Bot）。
  // 建房失败只警告，不推翻已装好的队伍（房可以事后手动建）。
  const channelResults: { name: string; created: boolean; warning?: string }[] = [];
  if (pack.channels?.length) {
    const store = new GroupStore(join(home, "groups"), { home });
    for (const ch of pack.channels) {
      try {
        store.create(ch.name, ch.name, ch.bots.map((id) => {
          const bot = pack.bots.find((b) => b.name === id)!;
          return { id: bot.name, name: bot.name, role: bot.role, instructions: bot.instructions };
        }));
        channelResults.push({ name: ch.name, created: true });
      } catch (err: unknown) {
        const warning = `频道 ${ch.name} 没建成群聊房（机器人本身已装好，事后可手动 nyra group room create ${ch.name} ${ch.name} ${ch.bots.map((b) => `--bot ${b}`).join(" ")}）：${err instanceof Error ? err.message : String(err)}`;
        warnings.push(warning);
        channelResults.push({ name: ch.name, created: false, warning });
      }
    }
  }
  const records = loadTeamPacks(home);
  records.push({
    team: pack.team,
    version: pack.version,
    chief: pack.chief,
    bots: pack.bots.map((b) => b.name),
    channels: (pack.channels ?? []).map((c) => c.name),
    ...(pack.connectors ? { connectors: pack.connectors } : {}),
    installed_at: new Date().toISOString(),
    source: opts.sourceLabel,
  });
  saveTeamPacks(home, records);
  recordTeamEvent(opts.store, opts.runId, "team_pack_installed", {
    team: pack.team,
    version: pack.version,
    bots: pack.bots.map((b) => b.name).join(","),
    source: opts.sourceLabel,
  });
  return { team: pack.team, version: pack.version, installed, channels: channelResults, warnings };
}

// ---- 取包：本地文件或 https 原始 Markdown ----

/** 取队伍包文本：本地文件直接读；URL 只接 https 的 .md 文件（原始 Markdown）。 */
export async function fetchTeamPackText(input: string): Promise<{ text: string; source: string }> {
  const trimmed = input.trim();
  if (/^https:\/\//.test(trimmed)) {
    const path = trimmed.split("?")[0]!;
    if (!/\.md$/.test(path)) {
      throw new TeamPackError(`队伍包 URL 须是 https 的 .md 文件（原始 Markdown，如 GitHub raw 链接）：${trimmed}`);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEAM_PACK_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(trimmed, { signal: ctrl.signal, headers: { accept: "text/markdown, text/plain" } });
      if (!res.ok) throw new TeamPackError(`下载队伍包失败：HTTP ${res.status}（${trimmed}）`);
      const text = await res.text();
      if (text.length > TEAM_PACK_MAX_BYTES) throw new TeamPackError(`队伍包超过 ${TEAM_PACK_MAX_BYTES} 字节上限，不装`);
      return { text, source: trimmed };
    } catch (err: unknown) {
      if (err instanceof TeamPackError) throw err;
      throw new TeamPackError(`下载队伍包失败：${trimmed}（${err instanceof Error ? err.message : String(err)}）`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (/^https?:\/\//.test(trimmed) || /^git@/.test(trimmed)) {
    throw new TeamPackError(`队伍包 URL 只接 https 的 .md 文件，不接 git 仓库（单个 Bot 走 nyra market install <git URL>）`);
  }
  let text: string;
  try {
    text = readFileSync(trimmed, "utf-8");
  } catch {
    throw new TeamPackError(`读不到队伍包文件：${trimmed}`);
  }
  if (text.length > TEAM_PACK_MAX_BYTES) throw new TeamPackError(`队伍包超过 ${TEAM_PACK_MAX_BYTES} 字节上限，不装`);
  return { text, source: trimmed };
}

/** 队伍包示例（nyra market template 的队伍版，照着改就能用）。 */
export function teamPackTemplate(): string {
  return `---
team: support-squad
version: 0.1.0
chief: lead
description: 客服小队：队长分工，查资料的跟进
bots:
  - name: lead
    role: 队长：分工与汇总
    instructions: 你是客服小队队长。收到工单先分给合适的队员，最后汇总回复。
    skills: [triage]
    mode: readonly
    routines:
      - name: daily-brief
        kind: schedule
        schedule: "0 9 * * *"
        task: 汇总昨日工单处理情况
  - name: researcher
    role: 查资料：翻手册与历史工单
    instructions: 你是客服小队的研究员。只查资料、给结论，不直接回复客户。
    skills: [research]
    mode: readonly
channels:
  - name: support-room
    bots: [lead, researcher]
playbook: |
  客服小队的打法：队长接单、分工、汇总；研究员只查资料。
connectors: [gmail]
---

# 客服小队

一个 Markdown 装一整队：队长 lead + 研究员 researcher，共用 support-room
频道。routine 到达即暂停，须手动启用。
`;
}
