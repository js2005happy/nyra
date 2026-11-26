// src/gatewayPresence.ts — H2：网关 presence（桌面活跃 → 手机通知静默）。
// 只做网关侧：哪个客户端在哪个端面（桌面/手机/网页）上活跃、最后活跃时间，
// 以及“现在要不要推手机”这个决定。手机端按这个决定推不推通知（手机端
// 随后接）；桌面端由桌面应用调心跳接口上报。
// 账本 gateway-presence.json（0600，原子写）；心跳写失败绝不破坏调用方。
// 活跃窗口 5 分钟：桌面 5 分钟内有心跳/回合，手机通知静默；超过 5 分钟
// 没动静，才推手机。owner 回合（本机回环 token）即桌面活跃，
// recordGatewayRound 里顺带记一笔，见 src/gatewayClients.ts。
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveNyraHome } from "./memory.ts";
import type { GatewayClientKind } from "./gatewayClients.ts";

export const GATEWAY_PRESENCE_FILE = "gateway-presence.json";
/** 桌面活跃窗口：5 分钟内有心跳/回合算活跃，手机通知静默。 */
export const PRESENCE_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
/** 同一客户端心跳节流：10 秒内重复心跳不写盘（桌面每分钟报一次就够）。 */
export const PRESENCE_HEARTBEAT_MIN_INTERVAL_MS = 10 * 1000;

export type PresenceSurface = "desktop" | "mobile" | "web";

export interface PresenceRow {
  client: string;
  kind: GatewayClientKind;
  /** 客户端自报的端面；没报时按 kind 推断（owner→desktop，device→mobile，account→web）。 */
  surface: PresenceSurface;
  first_seen: string;
  last_active: string;
  heartbeats: number;
  /** 最近一次心跳/回合的来源：heartbeat（显式心跳）或 round（网关回合）。 */
  source: "heartbeat" | "round";
}

const SURFACES: PresenceSurface[] = ["desktop", "mobile", "web"];

export function isPresenceSurface(raw: unknown): raw is PresenceSurface {
  return typeof raw === "string" && (SURFACES as string[]).includes(raw);
}

/** 没报端面时按 kind 推断：owner 一定是本机桌面；device 默认是手机；account 默认是网页。 */
export function defaultSurfaceForKind(kind: GatewayClientKind): PresenceSurface {
  if (kind === "owner") return "desktop";
  if (kind === "device") return "mobile";
  return "web";
}

function presencePath(home: string): string {
  return join(resolveNyraHome(home), GATEWAY_PRESENCE_FILE);
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

/** 记一次心跳/活跃：同客户端 10 秒内重复上报直接返回（throttled=true，不写盘）。 */
export function recordPresenceHeartbeat(
  home: string,
  opts: { client: string; kind: GatewayClientKind; surface?: PresenceSurface; source: "heartbeat" | "round"; now?: Date },
): { ok: boolean; throttled: boolean } {
  const at = opts.now ?? new Date();
  const atIso = at.toISOString();
  try {
    const rows = loadGatewayPresence(home);
    const found = rows.find((r) => r.client === opts.client);
    if (found) {
      const last = Date.parse(found.last_active);
      if (Number.isFinite(last) && at.getTime() - last < PRESENCE_HEARTBEAT_MIN_INTERVAL_MS) {
        return { ok: true, throttled: true };
      }
      found.last_active = atIso;
      found.heartbeats += 1;
      found.kind = opts.kind;
      found.surface = opts.surface ?? found.surface;
      found.source = opts.source;
    } else {
      rows.push({
        client: opts.client,
        kind: opts.kind,
        surface: opts.surface ?? defaultSurfaceForKind(opts.kind),
        first_seen: atIso,
        last_active: atIso,
        heartbeats: 1,
        source: opts.source,
      });
    }
    rows.sort((a, b) => String(b.last_active).localeCompare(String(a.last_active)) || String(a.client).localeCompare(String(b.client)));
    atomicWriteJson(presencePath(home), { clients: rows.slice(0, 200) });
    return { ok: true, throttled: false };
  } catch {
    return { ok: false, throttled: false };
  }
}

/** 读 presence 账本（损坏或不存在返回空列表）。 */
export function loadGatewayPresence(home: string): PresenceRow[] {
  try {
    const data = JSON.parse(readFileSync(presencePath(home), "utf-8")) as { clients?: unknown };
    if (!data || !Array.isArray(data.clients)) return [];
    const rows: PresenceRow[] = [];
    for (const item of data.clients) {
      if (!item || typeof item !== "object") continue;
      const r = item as Partial<PresenceRow>;
      if (typeof r.client !== "string" || !r.client) continue;
      if (r.kind !== "owner" && r.kind !== "device" && r.kind !== "account") continue;
      rows.push({
        client: r.client,
        kind: r.kind,
        surface: isPresenceSurface(r.surface) ? r.surface : defaultSurfaceForKind(r.kind),
        first_seen: typeof r.first_seen === "string" ? r.first_seen : "",
        last_active: typeof r.last_active === "string" ? r.last_active : "",
        heartbeats: typeof r.heartbeats === "number" && Number.isFinite(r.heartbeats) ? r.heartbeats : 0,
        source: r.source === "round" ? "round" : "heartbeat",
      });
    }
    rows.sort((a, b) => String(b.last_active).localeCompare(String(a.last_active)) || String(a.client).localeCompare(String(b.client)));
    return rows;
  } catch {
    return [];
  }
}

/** 一行是否在活跃窗口内（last_active 距 now 不超过 5 分钟；时间戳非法算不活跃）。 */
export function isPresenceRowActive(row: PresenceRow, now: Date = new Date()): boolean {
  const last = Date.parse(row.last_active);
  if (!Number.isFinite(last)) return false;
  const diff = now.getTime() - last;
  return diff >= 0 && diff <= PRESENCE_ACTIVE_WINDOW_MS;
}

/** 当前活跃的客户端（按 last_active 倒序）。 */
export function listActivePresence(home: string, now: Date = new Date()): PresenceRow[] {
  return loadGatewayPresence(home).filter((r) => isPresenceRowActive(r, now));
}

/** 桌面是否活跃：任一 surface=desktop 的客户端在 5 分钟窗口内。 */
export function isDesktopActive(home: string, now: Date = new Date()): boolean {
  return listActivePresence(home, now).some((r) => r.surface === "desktop");
}

/**
 * 现在要不要推手机：桌面活跃 → 静默（false）；桌面不活跃 → 推（true）。
 * 只看桌面，不管手机自己活不活跃——手机上的用户本来就在看，不用多推，
 * 但那是手机端的去重逻辑，不归网关管。
 */
export function shouldNotifyMobile(home: string, now: Date = new Date()): boolean {
  return !isDesktopActive(home, now);
}
