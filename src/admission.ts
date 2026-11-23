// src/admission.ts — G-P2-2 企业级准入账本（借 Turnstone append-only
// 审计日志的想法，Node 实现，不抄代码）。
//
// Turnstone 的做法是 RBAC + OIDC SSO + 工具策略 + append-only 审计日志，
// `turnstone-admin` 管用户 / token。Nyra 原来只有单机账本：信任圈、角色
// 白名单、红线表、审计导出各记各的——多节点、多机主场景下“谁批了谁进
// 群、谁改了策略”没有统一的准入账本。本批补这一层：一个只追加的准入
// 账本，三个接线点（好友进群批准、名片 grant 发放/吊销、策略变更）
// 都往同一本账上记。
//
// 账本：`~/.nyra/admission-ledger.jsonl`，append-only，只追加不改写；
// 每行一条事件，只记元数据——谁（actor）、谁的（subject）、哪个圈
// （circle）、什么角色（role）、哪些能力（scope）、token 指纹
// （SHA-256 前 12 位）、策略版本与哈希。绝不记 token 原文、不记消息
// 原文、不记密钥、不记绝对路径。读时坏行跳过并计数。
//
// 姿态：
// - 写账本是 best-effort：接线点调 `recordAdmission`，写失败（账本
//   是符号链接、目录不可写等）只吞掉、不破坏原操作（批了就是批了，
//   吊销照样立即生效）；直接调 `appendAdmission` 时写失败抛错。
// - 账本文件 0600；是符号链接时拒绝写、拒绝读（fail-closed）。
// - 不做真 OIDC SSO：没有外部 IdP 接线；actor 就是身份字符串，
//   以后接 IdP 时 subject 直接对应 IdP 的 sub，账本格式不用改。
// - 不做多节点同步：账本是本机文件，多节点合并不做。
//
// 叶模块：只引 node 内置。运行事件镜像不在这里做——各接线点原有的
// 事件（circle_invited / friend_accepted / friend_grant_issued /
// peer_token_set / policy_changed）已经进了运行事件链，本账本是
// 跨模块的统一审计视图，不再另发一套运行事件。
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export const ADMISSION_LEDGER_FILE = "admission-ledger.jsonl";

/** 准入事件种：好友批准 / 进圈 / 离圈 / 策略变更 / token 发放 / token 吊销。 */
export const ADMISSION_KINDS = [
  "friend_approved",
  "friend_declined",
  "member_joined",
  "member_left",
  "policy_changed",
  "token_issued",
  "token_revoked",
] as const;
export type AdmissionKind = (typeof ADMISSION_KINDS)[number];

export interface AdmissionEntry {
  id: string;
  at: string;
  kind: AdmissionKind;
  /** 谁批的 / 谁改的（"owner" 或账号 id）。 */
  actor: string;
  /** 谁进的 / 谁的 token / 哪个范围的策略。 */
  subject: string;
  /** 哪个圈（进圈 / 离圈 / 好友批准时）。 */
  circle?: string;
  /** 角色：圈成员是 friend，好友批准时是档位 readonly / propose。 */
  role?: string;
  /** token 发放时授予的能力清单。 */
  scope?: string[];
  /** token 的 SHA-256 前 12 位（只记指纹，绝不记原文）。 */
  token_fingerprint?: string;
  /** 策略变更：新版本号 / 旧版本号 / 新策略哈希前 12 位。 */
  policy_version?: number;
  old_policy_version?: number;
  policy_hash?: string;
  /** 一句话摘要（≤200 字，不含密钥与原文）。 */
  detail?: string;
}

export type AdmissionInput = Omit<AdmissionEntry, "id" | "at">;

export interface AdmissionFilter {
  kind?: AdmissionKind;
  actor?: string;
  subject?: string;
  circle?: string;
  /** ISO 时间串（含）下限。 */
  since?: string;
  /** ISO 时间串（含）上限。 */
  until?: string;
  /** 最多返回条数（默认 100，上限 1000）。 */
  limit?: number;
}

export class AdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionError";
  }
}

export function admissionLedgerPath(home: string): string {
  return join(resolveNyraHome(home), ADMISSION_LEDGER_FILE);
}

/** 指纹：SHA-256 前 12 位（token / 原因摘要都只记这个）。 */
export function admissionFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex").slice(0, 12);
}

function nowIso(): string {
  return new Date().toISOString();
}

function checkField(value: string, name: string, max: number): void {
  if (typeof value !== "string" || !value) throw new AdmissionError(`${name} 不能为空`);
  if (value.length > max) throw new AdmissionError(`${name} 过长（最多 ${max} 字）`);
}

function validateInput(input: AdmissionInput): void {
  if (!input || typeof input !== "object") throw new AdmissionError("准入事件须是对象");
  if (!(ADMISSION_KINDS as readonly string[]).includes(input.kind)) {
    throw new AdmissionError(`准入事件种不对：${String((input as { kind?: unknown }).kind)}（只认 ${ADMISSION_KINDS.join("、")}）`);
  }
  checkField(input.actor, "actor", 128);
  checkField(input.subject, "subject", 128);
  if (input.circle !== undefined) checkField(input.circle, "circle", 32);
  if (input.role !== undefined) checkField(input.role, "role", 32);
  if (input.scope !== undefined) {
    if (!Array.isArray(input.scope)) throw new AdmissionError("scope 必须是列表");
    for (const s of input.scope) checkField(s, "scope 项", 64);
  }
  if (input.token_fingerprint !== undefined && !/^[0-9a-f]{12}$/.test(input.token_fingerprint)) {
    throw new AdmissionError("token_fingerprint 须是 12 位十六进制");
  }
  if (input.policy_version !== undefined && (!Number.isInteger(input.policy_version) || input.policy_version < 0)) {
    throw new AdmissionError("policy_version 须是非负整数");
  }
  if (input.old_policy_version !== undefined && (!Number.isInteger(input.old_policy_version) || input.old_policy_version < 0)) {
    throw new AdmissionError("old_policy_version 须是非负整数");
  }
  if (input.policy_hash !== undefined && !/^[0-9a-f]{12}$/.test(input.policy_hash)) {
    throw new AdmissionError("policy_hash 须是 12 位十六进制");
  }
  if (input.detail !== undefined) checkField(input.detail, "detail", 200);
}

function isValidEntry(raw: unknown): raw is AdmissionEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as AdmissionEntry;
  if (typeof e.id !== "string" || !e.id.startsWith("adm-")) return false;
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return false;
  if (!(ADMISSION_KINDS as readonly string[]).includes(e.kind)) return false;
  if (typeof e.actor !== "string" || !e.actor) return false;
  if (typeof e.subject !== "string" || !e.subject) return false;
  return true;
}

/** 追加一条准入事件（严格：写失败抛错）。只追加，不改写旧行。 */
export function appendAdmission(home: string, input: AdmissionInput): AdmissionEntry {
  validateInput(input);
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = admissionLedgerPath(home);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new AdmissionError("准入账本不能是符号链接");
  }
  const entry: AdmissionEntry = {
    id: `adm-${randomBytes(8).toString("hex")}`,
    at: nowIso(),
    ...input,
  };
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(entry) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return entry;
}

/** 接线点用的 best-effort 写账本：写失败返回 null，不抛错、不破坏原操作。 */
export function recordAdmission(home: string, input: AdmissionInput): AdmissionEntry | null {
  try {
    return appendAdmission(home, input);
  } catch {
    return null;
  }
}

/** 读整本账本：坏行跳过，skipped 记跳过的行数。 */
export function readAdmissions(home: string): { entries: AdmissionEntry[]; skipped: number } {
  const path = admissionLedgerPath(home);
  if (!existsSync(path)) return { entries: [], skipped: 0 };
  if (lstatSync(path).isSymbolicLink()) throw new AdmissionError("准入账本不能是符号链接");
  const text = readFileSync(path, "utf-8");
  const entries: AdmissionEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isValidEntry(parsed)) entries.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

/** 按条件查账本（新的在前）。since/until 是 ISO 时间串（含边界）。 */
export function listAdmissions(home: string, filter: AdmissionFilter = {}): AdmissionEntry[] {
  if (filter.since !== undefined && Number.isNaN(Date.parse(filter.since))) {
    throw new AdmissionError(`--since 不是有效时间：${filter.since}`);
  }
  if (filter.until !== undefined && Number.isNaN(Date.parse(filter.until))) {
    throw new AdmissionError(`--until 不是有效时间：${filter.until}`);
  }
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new AdmissionError("--limit 须是 1–1000 的整数");
  }
  const { entries } = readAdmissions(home);
  const indexed = entries.map((e, i) => ({ e, i }));
  const out = indexed.filter(({ e }) => {
    if (filter.kind && e.kind !== filter.kind) return false;
    if (filter.actor && e.actor !== filter.actor) return false;
    if (filter.subject && e.subject !== filter.subject) return false;
    if (filter.circle && e.circle !== filter.circle) return false;
    if (filter.since && e.at < filter.since) return false;
    if (filter.until && e.at > filter.until) return false;
    return true;
  });
  // 新的在前；同一毫秒追加的几条按文件里的先后倒过来（后追加的更新）。
  out.sort((x, y) => (x.e.at < y.e.at ? 1 : x.e.at > y.e.at ? -1 : y.i - x.i));
  return out.map(({ e }) => e).slice(0, limit);
}

/** 按 id 查一条（没有返回 null）。 */
export function getAdmission(home: string, id: string): AdmissionEntry | null {
  const { entries } = readAdmissions(home);
  return entries.find((e) => e.id === id) ?? null;
}

/** 谁批了某人：该 subject 的批准类事件（好友批准 / 进圈 / token 发放），新的在前。 */
export function whoApproved(home: string, subject: string, limit = 50): AdmissionEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new AdmissionError("--limit 须是 1–1000 的整数");
  }
  const { entries } = readAdmissions(home);
  const out = entries.filter(
    (e) =>
      e.subject === subject &&
      (e.kind === "friend_approved" || e.kind === "member_joined" || e.kind === "token_issued"),
  );
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, limit);
}

/** 策略变更历史（新的在前）。 */
export function policyHistory(home: string, limit = 50): AdmissionEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new AdmissionError("--limit 须是 1–1000 的整数");
  }
  const { entries } = readAdmissions(home);
  const out = entries.filter((e) => e.kind === "policy_changed");
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, limit);
}

/** 导出整本账本的 JSONL 原文（账本本身只含元数据与指纹，不含密钥与原文）。 */
export function exportAdmissions(home: string): string {
  const path = admissionLedgerPath(home);
  if (!existsSync(path)) return "";
  if (lstatSync(path).isSymbolicLink()) throw new AdmissionError("准入账本不能是符号链接");
  return readFileSync(path, "utf-8");
}

/** 把账本导出到指定文件（0600 原子写；目标是符号链接时拒绝）。 */
export function exportAdmissionsToFile(home: string, dest: string): string {
  const text = exportAdmissions(home);
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    throw new AdmissionError("导出目标不能是符号链接");
  }
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.admission-export-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  return dest;
}
