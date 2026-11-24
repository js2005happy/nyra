// src/gatewayClients.ts — H1：网关逐回合记客户端。
// 每条经网关 HTTP 发起的回合（会话 send、群聊 send）记一条审计
// （gateway-audit.jsonl，进 SIEM 导出，来源 gateway）+ 更新最近客户端
// 账本（gateway-clients.json）。客户端只记 id，不记名字/邮箱——设备名
// 可能是人名，不进审计。写审计失败绝不破坏回合本身（返回 false）。
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export type GatewayClientKind = "owner" | "device" | "account";
export interface GatewayClientRef { client: string; kind: GatewayClientKind; }
export interface GatewayClientRow extends GatewayClientRef {
  first_seen: string;
  last_seen: string;
  rounds: number;
}

export const GATEWAY_AUDIT_FILE = "gateway-audit.jsonl";
export const GATEWAY_CLIENTS_FILE = "gateway-clients.json";
/** 账本最多记多少个客户端（防无限膨胀；最早的先被剪掉）。 */
export const MAX_CLIENTS = 200;

const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function cleanId(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const v = raw.trim();
  return CLIENT_ID_RE.test(v) ? v : null;
}

/**
 * apiAuth 的返回值 → 稳定客户端标识；未通过鉴权返回 null（调用方已先拦）。
 * owner token（回环本机）记 "owner"；配对设备记 "device:<设备 id>"；
 * 账号会话记 "account:<账号 id>"，user 角色的账号会话在 apiAuth 里已被
 * 折成字符串 "account"（没带 id），那时只记 "account" 一个桶——
 * 机主账号的回合都记 "owner"，陌生账号要登录才能发消息，桶够用。
 */
export function describeGatewayClient(
  who: "owner" | "account" | Record<string, unknown> | null,
): GatewayClientRef | null {
  if (who === "owner") return { client: "owner", kind: "owner" };
  if (who === "account") return { client: "account", kind: "account" };
  if (who && typeof who === "object") {
    const id = cleanId(who.id);
    if (!id) return null;
    // 配对设备记录没有 email，账号记录一定有 email：靠这个分辨。
    if (typeof who.email === "string") return { client: `account:${id}`, kind: "account" };
    return { client: `device:${id}`, kind: "device" };
  }
  return null;
}

function auditPath(home: string): string {
  return join(resolveNyraHome(home), GATEWAY_AUDIT_FILE);
}

function clientsPath(home: string): string {
  return join(resolveNyraHome(home), GATEWAY_CLIENTS_FILE);
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

/**
 * 记一回合：审计行 + 账本。channel 是 "session"（会话 send）或 "group"
 * （群聊 send）；团队分派（dispatchTeam 不走 HTTP 鉴权上下文）暂不记，
 * 见 PUSH-PLAN 局限。返回 false 只表示审计没写上，回合本身不受影响。
 */
export function recordGatewayRound(
  home: string,
  opts: { sessionId: string; client: string; kind: GatewayClientKind; channel: "session" | "group" },
): boolean {
  const at = new Date().toISOString();
  try {
    const entry = {
      at,
      actor: opts.client,
      type: "round",
      session_id: opts.sessionId,
      kind: opts.kind,
      channel: opts.channel,
    };
    const line = JSON.stringify({
      ...entry,
      hash: createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 12),
    }) + "\n";
    mkdirSync(dirname(auditPath(home)), { recursive: true, mode: 0o700 });
    appendFileSync(auditPath(home), line, { mode: 0o600 });
    try { chmodSync(auditPath(home), 0o600); } catch { /* ignore */ }
  } catch {
    return false;
  }
  try {
    const rows = loadGatewayClients(home);
    const found = rows.find((r) => r.client === opts.client);
    if (found) {
      found.last_seen = at;
      found.rounds += 1;
      found.kind = opts.kind;
    } else {
      rows.push({ client: opts.client, kind: opts.kind, first_seen: at, last_seen: at, rounds: 1 });
    }
    rows.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || String(a.client).localeCompare(String(b.client)));
    atomicWriteJson(clientsPath(home), { clients: rows.slice(0, MAX_CLIENTS) });
  } catch {
    // 账本写失败不影响回合：审计行已落盘，账本下次记回合时重建。
    return false;
  }
  return true;
}

/** 最近用过哪些客户端（按 last_seen 倒序；账本损坏或不存在返回空列表）。 */
export function loadGatewayClients(home: string): GatewayClientRow[] {
  try {
    const data = JSON.parse(readFileSync(clientsPath(home), "utf-8")) as { clients?: unknown };
    if (!data || !Array.isArray(data.clients)) return [];
    const rows: GatewayClientRow[] = [];
    for (const item of data.clients) {
      if (!item || typeof item !== "object") continue;
      const r = item as Partial<GatewayClientRow>;
      if (typeof r.client !== "string" || !r.client) continue;
      if (r.kind !== "owner" && r.kind !== "device" && r.kind !== "account") continue;
      rows.push({
        client: r.client,
        kind: r.kind,
        first_seen: typeof r.first_seen === "string" ? r.first_seen : "",
        last_seen: typeof r.last_seen === "string" ? r.last_seen : "",
        rounds: typeof r.rounds === "number" && Number.isFinite(r.rounds) ? r.rounds : 0,
      });
    }
    rows.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || String(a.client).localeCompare(String(b.client)));
    return rows;
  } catch {
    return [];
  }
}

/** 最近用过哪些客户端（给网关 GET /api/clients 与 nyra gw clients 用）。 */
export function listGatewayClients(home: string, limit = 20): GatewayClientRow[] {
  return loadGatewayClients(home).slice(0, Math.max(1, limit));
}
