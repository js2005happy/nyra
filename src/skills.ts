// src/skills.ts — Markdown 技能加载/匹配/保存，与 Python 版 nyra/skills.py 同语义。
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface Skill {
  name: string;
  description: string;
  when: string;
  keywords: string[];
  // 调研报告第 2 项：技能渐进披露（学 Claude Code + OpenHands）——paths 触发。
  // 可选：逗号分隔的 glob（如 `src/**/*.ts, docs/*.md`，写在 frontmatter 的 paths: 行）。
  // agent 触碰到匹配的文件时，该技能全文才被确定性注入；平时只占索引里约 100 字。
  paths?: string[];
  // 学 Claude Code 的 allowed-tools：技能激活期间的工具白名单（逗号分隔）。
  // 语义是"声明"而非"强制"：声明的工具视为技能自带能力，未声明的高风险工具
  // 仍走常规审批。真正按技能放行工具留到权限规则层（S5）再做。
  allowedTools?: string[];
  // 学 Claude Code 的 model：该技能建议使用的模型（如便宜模型跑搜索类技能）。
  // 声明式字段：提示词里告知 agent，实际切换由调用方决定，不在这里偷偷改模型。
  model?: string;
  instructions: string;
  path: string;
}

// 调研报告第 2 项：技能渐进披露（学 Claude Code + OpenHands）——30 行内的小 glob 匹配器，无新依赖。
// 支持 `**`（跨任意多层目录，含 0 层）、`*`（单层内任意字符）、`?`（单层内单个字符）。
// 路径分隔符统一转 `/` 再匹配，Windows 的 `\` 路径同样能命中。
export function matchGlob(pattern: string, filePath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const pSegs = norm(pattern).split("/").filter((s) => s.length > 0);
  const fSegs = norm(filePath).split("/").filter((s) => s.length > 0);
  const segMatch = (pat: string, str: string): boolean => {
    let pi = 0, si = 0, star = -1, mark = 0;
    while (si < str.length) {
      if (pi < pat.length && (pat[pi] === "?" || pat[pi] === str[si])) { pi++; si++; }
      else if (pi < pat.length && pat[pi] === "*") { star = pi++; mark = si; }
      else if (star !== -1) { pi = star + 1; si = ++mark; }
      else return false;
    }
    while (pi < pat.length && pat[pi] === "*") pi++;
    return pi === pat.length;
  };
  const rec = (pi: number, si: number): boolean => {
    if (pi === pSegs.length) return si === fSegs.length;
    if (pSegs[pi] === "**") {
      for (let k = si; k <= fSegs.length; k++) if (rec(pi + 1, k)) return true;
      return false;
    }
    if (si >= fSegs.length) return false;
    return segMatch(pSegs[pi], fSegs[si]) && rec(pi + 1, si + 1);
  };
  return rec(0, 0);
}

export function parseSkillFile(path: string): Skill {
  return parseSkillText(readFileSync(path, "utf-8"), path);
}

/** 从文本解析技能（与 parseSkillFile 同格式；创造模式的内置技能由此加载）。 */
export function parseSkillText(text: string, path: string): Skill {
  // 先归一化换行：Windows 用户用记事本等工具写的技能文件常是 CRLF，
  // 不归一化时首行会变成 "---\r"，frontmatter 判定直接抛错。
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const formatError = `Skill 文件格式错误（缺少 frontmatter）: ${path}`;
  if (!lines.length || lines[0] !== "---") throw new Error(formatError);
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) throw new Error(formatError);
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      // 调研报告第 2 项：技能渐进披露——frontmatter 新增可选 paths 字段（逗号分隔的 glob）。
      // S3：新增 allowed-tools / allowed_tools（工具白名单）与 model（建议模型）。
      if (["name", "description", "when", "keywords", "paths", "allowed-tools", "allowed_tools", "model"].includes(key)) {
        metadata[key] = line.slice(idx + 1).trim();
      }
    }
  }
  const name = metadata.name ?? "";
  if (!name) throw new Error(`Skill 缺少 name: ${path}`);
  const keywords = (metadata.keywords ?? "")
    .replace(/、/g, ",")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  // 调研报告第 2 项：技能渐进披露——paths 与 keywords 同样是逗号分隔；
  // 也接受 `[a, b]` 的括号写法与每项两侧的引号，写错格式只丢掉该项、不抛错。
  const paths = (metadata.paths ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
  // 学 Claude Code：allowed-tools 与 paths 同样是逗号分隔，也接受 `[a, b]` 与引号。
  const allowedRaw = metadata["allowed-tools"] ?? metadata["allowed_tools"] ?? "";
  const allowedTools = allowedRaw
    .split(",")
    .map((t) => t.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
  const model = (metadata.model ?? "").trim() || undefined;
  const bodyLines = lines.slice(closingIndex + 1);
  let start = 0;
  let end = bodyLines.length;
  while (start < end && !bodyLines[start].trim()) start++;
  while (end > start && !bodyLines[end - 1].trim()) end--;
  return {
    name,
    description: metadata.description ?? "",
    when: metadata.when ?? "",
    keywords,
    // 调研报告第 2 项：技能渐进披露——没写 paths 的旧技能保持 undefined，行为与以前一致。
    ...(paths.length ? { paths } : {}),
    ...(allowedTools.length ? { allowedTools } : {}),
    ...(model ? { model } : {}),
    instructions: bodyLines.slice(start, end).join("\n"),
    path,
  };
}

// 技能顺序的唯一规范来源：分层加载顺序即规范顺序，与 Agent 提示词一致。
// 目录优先级（先出现者胜，同名只保留第一次出现）：项目 skills → 项目
// .nyra/skills → 全局 skills → 插件 skills（调用方把 pluginSkillDirs(home)
// 传进 pluginDirs）；同目录内按文件名排序（loadSkills 的 readdir 排序）。
// 不按技能名排序：字母序会打乱项目层覆盖全局层的优先级表达，提示词索引、
// --list-skills 与网关状态三处都以这个顺序为准。
export function canonicalSkillDirs(workdir: string, home: string, pluginDirs: string[] = []): string[] {
  // 目录一律归一化为 POSIX 形式（`/`）：join() 在 Windows 上产出 `\`，而
  // 技能路径在提示词、--list-skills、网关状态与 matchSkillsByPaths 里都按
  // `/` 做字符串比较与展示——不归一化，Windows 上同一条目录在三处会写成
  // 两种样子（Node CI #49 的 test-skill-order 失败就是这么来的）。
  // fs 操作本身两种分隔符都能接受，所以归一化不影响加载。
  const toPosix = (p: string): string => p.replace(/\\/g, "/");
  return [toPosix(join(workdir, "skills")), toPosix(join(workdir, ".nyra", "skills")), toPosix(join(home, "skills")), ...pluginDirs.map(toPosix)];
}

/** 把任意技能列表规范化为规范顺序：同名去重（先出现者胜），其余保持原顺序。 */
export function canonicalSkillOrder(skills: Skill[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

/**
 * config.skills.disabled：按名字关掉某些 skill（对齐 Codex 的 `[[skills.config]] enabled=false`）。
 * 名字大小写不敏感；被关掉的 skill 仍会被解析（文件坏了照样报错），只是不进结果集——
 * 「关掉」不等于「假装文件不存在」，否则配置写错了永远不会被发现。
 */
export function loadSkills(dirs: string[], opts: { disabled?: readonly string[] } = {}): Skill[] {
  const disabled = new Set((opts.disabled ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const directory of dirs) {
    if (!existsSync(directory)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(directory).filter((f) => f.endsWith(".md")).sort().map((f) => join(directory, f));
    } catch {
      continue;
    }
    for (const path of files) {
      let skill: Skill;
      try {
        skill = parseSkillFile(path);
      } catch (err: unknown) {
        console.error(`跳过无效 skill 文件 ${path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (disabled.has(skill.name.toLowerCase())) continue;
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  }
  return skills;
}

export function matchSkills(task: string, skills: Skill[], topN = 2): Skill[] {
  if (!task || !skills.length || topN <= 0) return [];
  const taskText = task.toLowerCase();
  const scored: [number, Skill][] = [];
  for (const skill of skills) {
    let score = 0;
    for (const keyword of skill.keywords) {
      if (keyword.toLowerCase() && taskText.includes(keyword.toLowerCase())) score += 1;
    }
    if (skill.name.toLowerCase() && taskText.includes(skill.name.toLowerCase())) score += 3;
    if (skill.description.split(/\s+/).some((w) => w.length > 1 && taskText.includes(w.toLowerCase()))) score += 1;
    if (score > 0) scored.push([score, skill]);
  }
  scored.sort((a, b) => (b[0] - a[0]) || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, topN).map(([, s]) => s);
}

// ---- S3：技能内联命令（学 Claude Code 的 !`cmd` 动态上下文注入）----
// 技能正文里写 !`gh pr diff` 这类片段，渲染时执行并把输出替换进去，模型看到的是
// 真实仓库状态而不是它猜的状态。
//
// **信任模型（审阅意见第 1 条）**：内联命令跑在宿主机上、不进沙箱、不经过审批，
// 所以只有"用户自己的"技能才允许自动执行——即位于 trustedRoots（默认
// `<nyra home>/skills`）下的技能。项目里随仓库带的技能（`<workdir>/skills`、
// `<workdir>/.nyra/skills`）和插件技能默认**不执行**，只留占位：
// 克隆一个带恶意技能的仓库时，技能一匹配上就会执行命令，这条必须默认关死。
// 需要放开时用 NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS=1（全进程开关，自担风险）。
export interface SkillRenderOptions {
  /** 执行内联命令的工作目录；缺省 process.cwd()。 */
  workdir?: string;
  /** 总开关：是否允许执行内联命令。默认 false。 */
  execute?: boolean;
  /** 受信任的技能根目录（只有落在这些目录下的技能才会真的执行命令）。 */
  trustedRoots?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

const INLINE_CMD_RE = /!`([^`\n]+)`/g;

// 危险命令黑名单。黑名单只能挡"一眼就知道要命"的命令，挡不住 curl | sh 这类；
// 真正的边界是上面的信任模型，不是这张表。Windows 与 Unix 都要覆盖。
const BLOCKED_INLINE_CMD: [RegExp, string][] = [
  // Unix
  [/\bsudo\b/i, "禁止 sudo"],
  [/\bmkfs(\.\w+)?\b/i, "禁止 mkfs"],
  [/\b(shutdown|reboot|poweroff|halt)\b/i, "禁止关机/重启"],
  [/rm\s+(-[a-zA-Z]+\s+)*\/(\s|$)/, "禁止删除根目录"],
  [/rm\s+-[a-zA-Z]*r[a-zA-Z]*f/i, "禁止 rm -rf"],
  [/>\s*\/dev\/(sd|hd|nvme|vd)/i, "禁止写磁盘设备"],
  [/:\(\)\s*\{\s*:\s*\|/, "禁止 fork 炸弹"],
  [/\bdd\s+if=.*of=\/dev\//i, "禁止 dd 写设备"],
  // Windows / PowerShell
  [/\bdel\s+\/[a-z]*[sfq]/i, "禁止 del /s /q"],
  [/\b(rd|rmdir)\s+\/[a-z]*s/i, "禁止 rd /s"],
  [/\bformat\s+[a-z]:/i, "禁止 format 磁盘"],
  [/\bdiskpart\b/i, "禁止 diskpart"],
  [/\bbcdedit\b/i, "禁止 bcdedit"],
  [/\bvssadmin\s+delete\b/i, "禁止删除卷影副本"],
  [/\bRemove-Item\b[^\n]*-Recurse/i, "禁止 Remove-Item -Recurse"],
  [/\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i, "禁止格式化/清除磁盘"],
  [/\bStop-Computer\b/i, "禁止关机"],
  [/\bcipher\s+\/w/i, "禁止擦除空闲空间"],
  [/\breg\s+delete\s+HK(LM|CR|U|CC)\b/i, "禁止删注册表"],
  [/\bsc(\.exe)?\s+delete\b/i, "禁止删服务"],
  [/\btaskkill\b[^\n]*\/f/i, "禁止强杀进程"],
];

function blockedInlineReason(cmd: string): string | null {
  for (const [re, reason] of BLOCKED_INLINE_CMD) if (re.test(cmd)) return reason;
  return null;
}

/** 技能文件是否位于受信任根目录下（路径规范化后按前缀比较）。 */
export function isTrustedSkillPath(skillPath: string, trustedRoots: string[]): boolean {
  if (!skillPath || !trustedRoots.length) return false;
  // 与 execDaemon 的 isWithinRoots 同款问题：只做分隔符归一不折叠 `..` 时，
  // `/trusted/../etc/x` 会被当成在 `/trusted` 里。posix.normalize 是纯词法折叠，
  // 不碰文件系统、不依赖 cwd，够堵这个口子。
  const norm = (p: string) => posix.normalize(p.replace(/\\/g, "/")).replace(/\/+$/, "").toLowerCase();
  const sp = norm(skillPath);
  return trustedRoots.some((root) => {
    const r = norm(root);
    return Boolean(r) && r !== "." && (sp === r || sp.startsWith(r + "/"));
  });
}

function untrustedCommandsAllowed(): boolean {
  const v = (process.env.NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 把正文里的 !`cmd` 展开成命令输出；未开启执行或技能不受信任时保留占位说明。 */
export function expandInlineCommands(
  text: string,
  skillName: string,
  opts: SkillRenderOptions = {},
  skillPath = "",
): string {
  if (!text.includes("!`")) return text;
  const timeout = opts.timeoutMs ?? 5000;
  const maxChars = opts.maxOutputChars ?? 4000;
  const cwd = opts.workdir ?? process.cwd();
  const trusted = isTrustedSkillPath(skillPath, opts.trustedRoots ?? []) || untrustedCommandsAllowed();
  return text.replace(INLINE_CMD_RE, (_m, raw: string) => {
    const cmd = String(raw).trim();
    if (!cmd) return "";
    if (!opts.execute) return `（未执行：${cmd} —— 计划模式或未开启技能命令执行）`;
    if (!trusted) {
      return `（未执行：${cmd} —— 项目/插件技能默认不自动执行内联命令；把它放到 ~/.nyra/skills 下，或设 NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS=1）`;
    }
    const blocked = blockedInlineReason(cmd);
    if (blocked) return `（已拒绝执行：${cmd} —— ${blocked}）`;
    try {
      // 审计：每条技能内联命令都留痕，方便排查"谁跑过什么"。
      console.error(`[skill:${skillName}] 执行内联命令：${cmd}`);
      const out = execSync(cmd, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        encoding: "utf-8",
      });
      const trimmed = (out ?? "").trim();
      if (!trimmed) return `（命令无输出：${cmd}）`;
      return trimmed.length > maxChars
        ? trimmed.slice(0, maxChars) + `\n…（输出已截断，共 ${trimmed.length} 字符）`
        : trimmed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `（命令失败：${cmd} —— ${msg.slice(0, 200)}）`;
    }
  });
}

export function renderSkill(skill: Skill, opts: SkillRenderOptions = {}): string {
  const lines = [`## Skill: ${skill.name}`];
  if (skill.description) lines.push(skill.description);
  if (skill.when) lines.push(`何时使用：${skill.when}`);
  if (skill.allowedTools?.length) {
    lines.push(`本技能声明的可用工具：${skill.allowedTools.join(", ")}（未声明的工具照常走审批）`);
  }
  if (skill.model) lines.push(`建议模型：${skill.model}`);
  lines.push(expandInlineCommands(skill.instructions, skill.name, opts, skill.path));
  return lines.join("\n");
}

/**
 * 由 agent 侧状态算出渲染选项（把"计划模式不执行"这条接线变成可测的纯函数）。
 * trustedRoots 默认只含用户自己的技能目录：项目/插件技能不自动执行内联命令。
 */
export function skillRenderOptionsFor(args: { mode: string; workdir: string; home: string }): SkillRenderOptions {
  return {
    workdir: args.workdir,
    execute: args.mode !== "plan",
    trustedRoots: [join(args.home, "skills")],
  };
}

// 调研报告第 2 项：技能渐进披露（学 Claude Code + OpenHands）——常驻提示词用的技能索引。
// 每个技能只占一行 `name — description`，描述按字符截断到约 100 字（中文按字算，超了加 `…`）。
// 全文不进索引，需要时用 read_skill 按名按需读取。
export const SKILL_INDEX_DESC_CHARS = 100;

export function skillIndex(skills: Skill[]): string {
  // 提示词索引同样走规范顺序：先规范化再输出，三处（提示词索引、
  // --list-skills、网关状态）用同一来源。
  return canonicalSkillOrder(skills).map((skill) => {
    const chars = [...(skill.description ?? "")];
    const shown = chars.length > SKILL_INDEX_DESC_CHARS
      ? chars.slice(0, SKILL_INDEX_DESC_CHARS).join("") + "…"
      : chars.join("");
    return shown ? `${skill.name} — ${shown}` : skill.name;
  }).join("\n");
}

// 调研报告第 2 项：技能渐进披露（学 OpenHands）——路径触发：任一 touched 文件路径
// 命中某技能的 paths glob 即返回该技能；去重、按技能名排序。零基线成本：
// 没触碰匹配文件时一个字也不注入。
export function matchSkillsByPaths(filePaths: string[], skills: Skill[]): Skill[] {
  if (!filePaths.length || !skills.length) return [];
  const normalized = filePaths.map((p) => p.replace(/\\/g, "/"));
  return skills
    .filter((skill) => (skill.paths ?? []).some((glob) => normalized.some((p) => matchGlob(glob, p))))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 调研报告第 2 项：技能渐进披露——按名取技能全文（renderSkill 格式），供 read_skill 按需读取；没有则返回 null。
export function readSkillBody(skills: Skill[], name: string): string | null {
  const skill = skills.find((s) => s.name === name);
  return skill ? renderSkill(skill) : null;
}

export function saveSkillFile(
  skillsDir: string,
  name: string,
  description: string,
  when: string,
  keywords: string[],
  instructions: string,
): string {
  const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const allowed = new Set((alphanumeric + "_-").split(""));
  if (!name || !alphanumeric.includes(name[0]) || [...name].some((c) => !allowed.has(c))) {
    throw new Error("Skill 名称只允许字母、数字、- 和 _");
  }
  mkdirSync(skillsDir, { recursive: true });
  const path = join(skillsDir, `${name}.md`);
  let content =
    "---\n" +
    `name: ${name}\n` +
    `description: ${description}\n` +
    `when: ${when}\n` +
    `keywords: ${keywords.join(", ")}\n` +
    "---\n" +
    instructions;
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(path, content, "utf-8");
  return path;
}
