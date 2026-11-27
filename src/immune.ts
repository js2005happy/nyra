// H4：“免疫体检”（Hermes/TalosBrain 借鉴）。
//
// 大脑自己的逐项自检，对齐 Nyra 已有的三件护城河，不另起一套：
//   证据链——记忆条目的证据还在不在、账本能不能解析、技能文件能不能解析；
//   成本硬顶——成本上限配置与暂停账本是不是好的；
//   权限边界——密钥有没有进明文、目录与账本的权限位对不对。
//
// 不合格的处理：隔离，不删除。文件移进 ~/.nyra/quarantine/（0700）；
// 记忆条目标 deleted（修订历史保留，可审计）并在隔离区留一份快照。
// 每次体检写 immune-report.json（最新一次）+ 证据链 + 运行事件。
// 入口只有一个：`nyra doctor --deep`（见 src/doctor.ts），文档里写死这一个。

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { resolveNyraHome } from "./memory.ts";
import { EvidenceStore } from "./evidence.ts";
import {
  detectSecretKind,
  listMemoryGateEntries,
  updateMemoryEntry,
  verifyEvidenceQuotesFormat,
  type MemoryGateSecretKind,
} from "./memoryGate.ts";
import { parseSkillFile } from "./skills.ts";

export const IMMUNE_REPORT_FILE = "immune-report.json";
export const QUARANTINE_DIR = "quarantine";

export type ImmuneMoat = "evidence" | "cost" | "permission";

export interface ImmuneCheck {
  id: string;
  name: string;
  moat: ImmuneMoat;
  ok: boolean;
  detail: string;
  fix?: string;
  /** 本项隔离进隔离区的东西（相对名，不记绝对路径）。 */
  quarantined?: string[];
}

export interface ImmuneQuarantinedItem {
  kind: "memory-entry" | "file";
  /** 隔离区里的相对名，如 quarantine/config-20261125-070000.json。 */
  name: string;
  detail: string;
}

export interface ImmuneReport {
  at: string;
  checks: ImmuneCheck[];
  allOk: boolean;
  quarantined: ImmuneQuarantinedItem[];
}

/** 免疫体检扫的账本/配置文件（相对名；vault.json / keys.json 本来就放凭据，不扫）。 */
const LEDGER_FILES: Array<{ file: string; kind: "json" | "jsonl" }> = [
  { file: "memory-entries.jsonl", kind: "jsonl" },
  { file: "memory-proposals.json", kind: "json" },
  { file: "schedule.json", kind: "json" },
  { file: "review-queue.json", kind: "json" },
  { file: "responsibilities.json", kind: "json" },
  { file: "cost-pauses.json", kind: "json" },
  { file: "cron-incidents.jsonl", kind: "jsonl" },
  { file: "gateway-clients.json", kind: "json" },
  { file: "gateway-audit.jsonl", kind: "jsonl" },
  { file: "mcp-server-audit.jsonl", kind: "jsonl" },
  { file: "dream-state.json", kind: "json" },
  { file: "dream-runs.jsonl", kind: "jsonl" },
  { file: "immune-report.json", kind: "json" },
  { file: "a2a-tasks.json", kind: "json" },
];

/** 明文扫描的范围（账本 + 配置 + 简报；证据目录不扫——证据是审计链，动它会断链）。 */
const SECRET_SCAN_FILES = [
  "config.json",
  "memory-entries.jsonl",
  "memory-proposals.json",
  "schedule.json",
  "review-queue.json",
  "responsibilities.json",
  "cron-incidents.jsonl",
  "gateway-clients.json",
  "dream-runs.jsonl",
];

const SECRET_KIND_TEXT: Record<MemoryGateSecretKind, string> = {
  "sk-key": "疑似 API Key（sk- 开头）",
  "private-key": "疑似私钥",
  "bearer-token": "疑似 Bearer token",
};

function quarantineDir(home: string): string {
  return join(resolveNyraHome(home), QUARANTINE_DIR);
}

function ensureQuarantineDir(home: string): string {
  const dir = quarantineDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* 权限改失败不拦体检 */ }
  }
  return dir;
}

function timestampSuffix(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function writeJson0600Atomic(path: string, value: unknown): boolean {
  try {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(`${path}.tmp-${process.pid}`, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/** 记一条免疫事件：没有运行上下文时走证据文件（与责任事件同款口径）。 */
function recordImmuneEvent(home: string, type: string, fields: Record<string, unknown>): void {
  try {
    const lines = [`事件：${type}`, `时间：${new Date().toISOString()}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) lines.push(`${k}：${String(v).slice(0, 200)}`);
    }
    new EvidenceStore(join(resolveNyraHome(home), "evidence"), "immune").save(
      "immune",
      `immune://${new Date().toISOString().slice(0, 10)}`,
      lines.join("\n"),
    );
  } catch { /* 审计写盘失败不拦体检 */ }
}

function parseJsonFile(home: string, file: string): { ok: boolean; error?: string } {
  const path = join(resolveNyraHome(home), file);
  if (!existsSync(path)) return { ok: true };
  try {
    JSON.parse(readFileSync(path, "utf-8"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseJsonlFile(home: string, file: string): { ok: boolean; badLine?: number; error?: string } {
  const path = join(resolveNyraHome(home), file);
  if (!existsSync(path)) return { ok: true };
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        JSON.parse(line);
      } catch (err) {
        return { ok: false, badLine: i + 1, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 把一个坏账本移进隔离区（不删除），回隔离区里的相对名；移失败回 null。 */
function quarantineFile(home: string, file: string, now: Date): string | null {
  try {
    const dir = ensureQuarantineDir(home);
    const src = join(resolveNyraHome(home), file);
    const destName = `${file.replace(/[/\\]/g, "_")}.corrupt-${timestampSuffix(now)}`;
    renameSync(src, join(dir, destName));
    return `${QUARANTINE_DIR}/${destName}`;
  } catch {
    return null;
  }
}

/** 把一条记忆条目隔离：隔离区留快照 + 账本里标 deleted（修订历史保留）。 */
function quarantineMemoryEntry(home: string, entry: ReturnType<typeof listMemoryGateEntries>[number], reason: string, now: Date): string | null {
  try {
    const dir = ensureQuarantineDir(home);
    const name = `memory-entry-${entry.id}-${timestampSuffix(now)}.json`;
    writeJson0600Atomic(join(dir, name), {
      quarantined_at: now.toISOString(),
      reason,
      entry,
    });
    updateMemoryEntry(home, entry.id, { status: "deleted" }, null, { actor: "immune", checkVerbatim: false });
    return `${QUARANTINE_DIR}/${name}`;
  } catch {
    return null;
  }
}

/**
 * 跑一次免疫体检。全部是同步的文件检查，不调模型、不联网。
 * 检查失败只记报告 + 隔离，不抛错；隔离区写不进去时也只报，不删除任何东西。
 */
export function runImmuneChecks(home: string, opts: { now?: Date } = {}): ImmuneReport {
  const now = opts.now ?? new Date();
  const h = resolveNyraHome(home);
  const checks: ImmuneCheck[] = [];
  const quarantined: ImmuneQuarantinedItem[] = [];
  const recordQuarantine = (item: ImmuneQuarantinedItem): void => {
    quarantined.push(item);
  };

  // 1）证据链：记忆条目证据还在不在（1–8 条非空引用）。
  {
    const bad: string[] = [];
    const moved: string[] = [];
    let entries: ReturnType<typeof listMemoryGateEntries> = [];
    let readOk = true;
    try {
      entries = listMemoryGateEntries(home, { includeDeleted: false });
    } catch {
      readOk = false;
    }
    if (!readOk) {
      checks.push({ id: "memory-evidence", name: "记忆证据", moat: "evidence", ok: false, detail: "记忆账本 memory-entries.jsonl 读失败，证据查不了", fix: "先看账本那一项（nyra doctor --deep 的账本检查），修好账本再重跑。" });
    } else {
      for (const e of entries) {
        if (e.status === "deleted") continue;
        const v = verifyEvidenceQuotesFormat(e.evidenceQuotes);
        if (v.ok) continue;
        bad.push(e.id);
        const name = quarantineMemoryEntry(home, e, `evidence-invalid:${v.reason}`, now);
        if (name) {
          moved.push(name);
          recordQuarantine({ kind: "memory-entry", name, detail: `记忆条目 ${e.id} 的证据无效（${v.reason}），已隔离` });
        }
      }
      const ok = bad.length === 0;
      checks.push({
        id: "memory-evidence",
        name: "记忆证据",
        moat: "evidence",
        ok,
        detail: ok
          ? `查了 ${entries.length} 条记忆，证据都还在（1–8 条非空引用）`
          : `${bad.length} 条记忆的证据无效（${bad.slice(0, 5).join("、")}${bad.length > 5 ? "……" : ""}），已隔离 ${moved.length} 条`,
        fix: ok ? undefined : "被隔离的条目在 quarantine/ 里有快照，确认无用就不用管；误删了找我恢复（账本修订历史里还有）。",
        quarantined: moved.length ? moved : undefined,
      });
    }
  }

  // 2）证据链：技能文件还能不能解析（只查 ~/.nyra/skills，与 loadSkills 同款：只读 *.md，不递归）。
  {
    const dir = join(h, "skills");
    const broken: string[] = [];
    const moved: string[] = [];
    if (existsSync(dir)) {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
      } catch {
        files = [];
      }
      for (const f of files) {
        try {
          parseSkillFile(join(dir, f));
        } catch {
          broken.push(f);
          const name = quarantineFile(home, join("skills", f), now);
          if (name) {
            moved.push(name);
            recordQuarantine({ kind: "file", name, detail: `技能文件 ${f} 解析失败，已隔离` });
          }
        }
      }
    }
    const ok = broken.length === 0;
    checks.push({
      id: "skills-parseable",
      name: "技能文件",
      moat: "evidence",
      ok,
      detail: ok ? "skills/ 里的技能文件都能解析" : `${broken.length} 个技能文件解析失败（${broken.slice(0, 5).join("、")}），已隔离 ${moved.length} 个`,
      fix: ok ? undefined : "被隔离的技能在 quarantine/ 里，修好格式放回 skills/ 即可；修不好就删掉隔离区里的那份。",
      quarantined: moved.length ? moved : undefined,
    });
  }

  // 3）权限边界：配置有没有坏（config.json 解析 + 关键节形状）。
  //    注意：loadConfig 损坏时不抛错、直接回默认值，所以这里自己读原文 JSON。
  {
    let ok = true;
    let detail = "config.json 能解析，各节形状正常";
    let fix: string | undefined;
    let moved: string[] | undefined;
    const configPath = join(h, "config.json");
    if (!existsSync(configPath)) {
      detail = "config.json 不存在（下次运行会自动重建默认配置）";
    } else {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config.json 顶层不是对象");
      } catch (err) {
        ok = false;
        detail = `config.json 解析失败：${err instanceof Error ? err.message : String(err)}`;
        fix = "损坏的 config.json 已移进 quarantine/，重跑 nyra setup 会重建默认配置；旧配置在隔离区里可以对照着抄回来。";
        const name = quarantineFile(home, "config.json", now);
        if (name) {
          moved = [name];
          recordQuarantine({ kind: "file", name, detail: "config.json 解析失败，已隔离" });
        }
      }
      if (parsed) {
        const dream = parsed.dream;
        if (dream !== undefined && (typeof dream !== "object" || dream === null)) {
          ok = false;
          detail = "config.json 里 dream 一节不是对象";
          fix = "删掉 config.json 里的 dream 一节，或按 docs/dream.md 的格式重写。";
        } else if (dream && typeof dream === "object") {
          const d = dream as Record<string, unknown>;
          if (d.at !== undefined && (typeof d.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.at))) {
            ok = false;
            detail = `config.json 里 dream.at 不是合法时间（${String(d.at).slice(0, 40)}）`;
            fix = "把 dream.at 改成 HH:MM，如 03:00；或删掉这一行用默认值。";
          }
          if (d.enabled !== undefined && typeof d.enabled !== "boolean") {
            ok = false;
            detail = "config.json 里 dream.enabled 不是 true/false";
            fix = "把 dream.enabled 改成 true 或 false。";
          }
        }
        const mcpServer = parsed.mcp_server;
        if (mcpServer !== undefined && (typeof mcpServer !== "object" || mcpServer === null)) {
          ok = false;
          detail = "config.json 里 mcp_server 一节不是对象";
          fix = "删掉 config.json 里的 mcp_server 一节，或按 docs/mcp.md 的格式重写。";
        }
      }
    }
    checks.push({ id: "config-valid", name: "配置有效", moat: "permission", ok, detail, fix, quarantined: moved });
  }

  // 4）权限边界：密钥有没有进明文（只报种类名与文件，绝不回显密钥原文）。
  {
    const findings: string[] = [];
    const moved: string[] = [];
    // 4a. 记忆条目里的密钥：隔离条目（证据检查已跑过，这里只处理含密钥的）。
    try {
      const entries = listMemoryGateEntries(home, { includeDeleted: false });
      for (const e of entries) {
        if (e.status === "deleted") continue;
        const texts: Array<[string, string]> = [["content", e.content], ["subject", e.subject], ...e.evidenceQuotes.map((q, i): [string, string] => [`quote:${i + 1}`, q])];
        for (const [, text] of texts) {
          const kind = detectSecretKind(text);
          if (!kind) continue;
          findings.push(`记忆条目 ${e.id}（${SECRET_KIND_TEXT[kind]}）`);
          const name = quarantineMemoryEntry(home, e, `secret:${kind}`, now);
          if (name) {
            moved.push(name);
            recordQuarantine({ kind: "memory-entry", name, detail: `记忆条目 ${e.id} 含${SECRET_KIND_TEXT[kind]}，已隔离` });
          }
          break;
        }
      }
    } catch {
      findings.push("记忆账本读失败，条目里的密钥没扫完");
    }
    // 4b. 配置与账本正文里的密钥：只报，不自动改文件（改配置须人动手）。
    for (const file of SECRET_SCAN_FILES) {
      const path = join(h, file);
      if (!existsSync(path)) continue;
      let text = "";
      try {
        text = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const kind = detectSecretKind(text);
      if (kind) findings.push(`${file}（${SECRET_KIND_TEXT[kind]}）`);
    }
    const ok = findings.length === 0;
    checks.push({
      id: "secrets-plaintext",
      name: "密钥明文",
      moat: "permission",
      ok,
      detail: ok ? "配置与账本里没发现明文密钥" : `发现 ${findings.length} 处疑似明文密钥：${findings.slice(0, 5).join("；")}${findings.length > 5 ? "……" : ""}`,
      fix: ok ? undefined : "记忆条目里的已隔离；配置/账本里的请亲手处理：把密钥移到密码箱（nyra setup）或环境变量，删掉明文处，再重跑 nyra doctor --deep。",
      quarantined: moved.length ? moved : undefined,
    });
  }

  // 5）证据链：账本有没有损坏（逐个解析，坏的移进隔离区，不删除）。
  {
    const broken: string[] = [];
    const moved: string[] = [];
    for (const { file, kind } of LEDGER_FILES) {
      const r = kind === "json" ? parseJsonFile(home, file) : parseJsonlFile(home, file);
      if (r.ok) continue;
      broken.push(file);
      const name = quarantineFile(home, file, now);
      if (name) {
        moved.push(name);
        recordQuarantine({ kind: "file", name, detail: `账本 ${file} 解析失败，已隔离` });
      }
    }
    const ok = broken.length === 0;
    checks.push({
      id: "ledgers-parseable",
      name: "账本完好",
      moat: "evidence",
      ok,
      detail: ok ? `查了 ${LEDGER_FILES.length} 个账本，都能解析` : `${broken.length} 个账本解析失败（${broken.join("、")}），已隔离 ${moved.length} 个`,
      fix: ok ? undefined : "被隔离的账本在 quarantine/ 里；多数账本下次写时会自动重建，丢了的记录找不回来——先确认隔离区里的文件确实不要了再删。",
      quarantined: moved.length ? moved : undefined,
    });
  }

  // 6）成本硬顶：上限配置与暂停账本是不是好的（月度限额已移除，
  //    这里只查单次上限 max_cost_usd 与暂停账本）。
  {
    let ok = true;
    let detail = "成本上限配置正常，暂停账本能解析";
    try {
      const config = loadConfig(home);
      const maxCost = (config as Record<string, unknown>).max_cost_usd;
      if (maxCost !== undefined && maxCost !== null && (typeof maxCost !== "number" || !Number.isFinite(maxCost) || maxCost < 0)) {
        ok = false;
        detail = "config.json 里 max_cost_usd 不是非负数字";
      }
      const pauses = parseJsonFile(home, "cost-pauses.json");
      if (!pauses.ok) {
        ok = false;
        detail = `暂停账本 cost-pauses.json 解析失败：${pauses.error ?? ""}`;
      }
    } catch (err) {
      ok = false;
      detail = `成本配置读失败：${err instanceof Error ? err.message : String(err)}`;
    }
    checks.push({
      id: "cost-moat",
      name: "成本硬顶",
      moat: "cost",
      ok,
      detail,
      fix: ok ? undefined : "把 config.json 里的上限改成非负数字，或删掉那一行用默认值；暂停账本坏了在隔离区里有备份。",
    });
  }

  // 7）权限边界：目录与账本的权限位（Windows 没有 POSIX 位，不检查）。
  {
    if (process.platform === "win32") {
      checks.push({ id: "permission-moat", name: "权限位", moat: "permission", ok: true, detail: "Windows 没有 POSIX 权限位，不检查" });
    } else {
      const loose: string[] = [];
      const checkMode = (rel: string, want: number): void => {
        const path = join(h, rel);
        if (!existsSync(path)) return;
        try {
          const mode = statSync(path).mode & 0o777;
          if (mode !== want) loose.push(`${rel}（${mode.toString(8)}，应为 ${want.toString(8)}）`);
        } catch {
          loose.push(`${rel}（读不到权限位）`);
        }
      };
      checkMode(".", 0o700);
      checkMode("vault.json", 0o600);
      checkMode("keys.json", 0o600);
      for (const { file } of LEDGER_FILES) checkMode(file, 0o600);
      checkMode(QUARANTINE_DIR, 0o700);
      const ok = loose.length === 0;
      checks.push({
        id: "permission-moat",
        name: "权限位",
        moat: "permission",
        ok,
        detail: ok ? "配置目录 700、密码箱与账本 600，都对" : `权限太松：${loose.slice(0, 5).join("；")}${loose.length > 5 ? "……" : ""}`,
        fix: ok ? undefined : "按上面括号里的数字 chmod 回去，如 chmod 600 ~/.nyra/vault.json；体检不自动改权限，改之前先确认是你自己的文件。",
      });
    }
  }

  const report: ImmuneReport = {
    at: now.toISOString(),
    checks,
    allOk: checks.every((c) => c.ok),
    quarantined,
  };
  writeJson0600Atomic(join(h, IMMUNE_REPORT_FILE), report);
  recordImmuneEvent(home, "immune_check", {
    checks: checks.length,
    failed: checks.filter((c) => !c.ok).length,
    quarantined: quarantined.length,
  });
  for (const q of quarantined) {
    recordImmuneEvent(home, "immune_quarantined", { kind: q.kind, name: q.name, detail: q.detail });
  }
  return report;
}
