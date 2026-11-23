// src/cloudSync.ts — 跨端同步协议与本地账本（第 6 批）。
//
// 同一个账号在手机与电脑上都要是同一个 Nyra：状态按账号存在云端一份，
// 各设备本地留一份离线副本（~/.nyra/cloud-state.json），有网时双向同步。
//
// 协议（服务端实现见 docs/mobile-cloud.md §5，客户端行为以这里为准）：
//   - 每条记录：{ account_id, scope, key, value, updated_at, origin, version }。
//     scope 是作用域（如 preferences），key 是键，value 是字符串（偏好这类
//     小状态直接存原文；会话内容这类大状态不在此协议里——agent 会话由云端
//     服务自己持有，见文档诚实边界）。
//   - version 是服务端单调递增的版本号：本地只认 version 更大的远端记录，
//     推上去的记录由服务端发新 version 回来；本地改动记 dirty=true。
//   - 冲突规则（写死在这里，服务端与客户端同一条）：最后写入者胜——按
//     updated_at 比新旧；时间戳打平按 origin（设备 id）字典序大的赢。
//     本地有未推的改动、且远端同 key 也有新 version 时才算冲突；冲突只记
//     “最后留了哪边”（local/remote），值本身不进事件、不进审计。
//   - 同步顺序：先拉后推。拉下来覆盖掉的本地改动按冲突规则处理；推不上去
//     的（服务端 rejected）留在 dirty 里，下次同步再推，不静默丢。
//
// 存储纪律（与账号、配对、云端会话同款）：0600、原子写、损坏先备份再抛错。
// 本地文件只是离线兜底：云端连不上时读写本地照常进行，同步等有网再跑。

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome, atomicTmpPath } from "./memory.ts";
import { CloudClient, mirrorCloudEvent, type CloudStateRemoteRecord } from "./cloud.ts";

export class CloudSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSyncError";
  }
}

export const CLOUD_STATE_FILE = "cloud-state.json";

/** 偏好作用域：第一批真正同步的状态——跟人走的三个偏好（模型、语言、主题）。 */
export const PREF_SCOPE = "preferences";
export const PREF_KEYS = ["model", "language", "theme"] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

export interface CloudStateRecord {
  account_id: string;
  scope: string;
  key: string;
  value: string;
  updated_at: string;
  origin: string;
  version: number;
  /** 本地改了还没推上云端。 */
  dirty: boolean;
}

export interface CloudSyncMeta {
  last_sync_at: string | null;
  last_pushed: number;
  last_pulled: number;
  last_conflicts: number;
  /**
   * 拉取水位（每账号）：上次拉取时服务端返回的 latest_version，只进不退。
   * 注意它不是“本地记录的最大 version”——推上去拿到的 version 不能推进
   * 拉取水位，否则后推的记录会把先到云端、还没拉过的记录顶出拉取范围
   *（本地验证抓到的真 bug：先推 model 得 version 2，再拉时 since=2，
   * version 1 的 theme 永远拉不下来）。
   */
  pulled_through: Record<string, number>;
}

export interface CloudStateFileData {
  records: CloudStateRecord[];
  meta: CloudSyncMeta;
}

export interface SyncConflict {
  scope: string;
  key: string;
  kept: "local" | "remote";
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: SyncConflict[];
  rejected: { scope: string; key: string; reason: string }[];
}

function nowIso(epochSeconds?: number): string {
  const ms = epochSeconds === undefined ? Date.now() : epochSeconds * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = atomicTmpPath(path);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 1), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function emptyState(): CloudStateFileData {
  return {
    records: [],
    meta: { last_sync_at: null, last_pushed: 0, last_pulled: 0, last_conflicts: 0, pulled_through: {} },
  };
}

export class CloudStateStore {
  readonly path: string;
  private clock: () => number;

  constructor(home: string, opts?: { clock?: () => number }) {
    this.path = join(resolveNyraHome(home), CLOUD_STATE_FILE);
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  private load(): CloudStateFileData {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return emptyState();
    }
    try {
      const data = JSON.parse(raw) as CloudStateFileData;
      if (!data || typeof data !== "object" || !Array.isArray(data.records)) return emptyState();
      const records = data.records.filter((r): r is CloudStateRecord => {
        return !!r && typeof r === "object" &&
          typeof (r as CloudStateRecord).account_id === "string" &&
          typeof (r as CloudStateRecord).scope === "string" &&
          typeof (r as CloudStateRecord).key === "string" &&
          typeof (r as CloudStateRecord).value === "string" &&
          typeof (r as CloudStateRecord).updated_at === "string" &&
          typeof (r as CloudStateRecord).origin === "string" &&
          typeof (r as CloudStateRecord).version === "number";
      });
      const meta = data.meta && typeof data.meta === "object" ? data.meta : emptyState().meta;
      const pulledThrough = (meta as CloudSyncMeta).pulled_through;
      const pulledThroughClean: Record<string, number> = {};
      if (pulledThrough && typeof pulledThrough === "object" && !Array.isArray(pulledThrough)) {
        for (const [k, v] of Object.entries(pulledThrough)) {
          if (typeof v === "number" && Number.isFinite(v) && v > 0) pulledThroughClean[k] = Math.floor(v);
        }
      }
      return {
        records,
        meta: {
          last_sync_at: typeof meta.last_sync_at === "string" ? meta.last_sync_at : null,
          last_pushed: typeof meta.last_pushed === "number" ? meta.last_pushed : 0,
          last_pulled: typeof meta.last_pulled === "number" ? meta.last_pulled : 0,
          last_conflicts: typeof meta.last_conflicts === "number" ? meta.last_conflicts : 0,
          pulled_through: pulledThroughClean,
        },
      };
    } catch {
      const backup = this.path + ".corrupt-" + String(process.pid) + "-" + randomBytes(4).toString("hex");
      try {
        writeFileSync(backup, raw, { encoding: "utf-8", mode: 0o600 });
      } catch {
        /* 备份写不进去也不拦抛错本身 */
      }
      throw new CloudSyncError("云端同步账本损坏（已备份到 " + backup + "），请检查后恢复或删除重建");
    }
  }

  private save(data: CloudStateFileData): void {
    atomicWriteJson(this.path, data);
  }

  get(accountId: string, scope: string, key: string): CloudStateRecord | null {
    return this.load().records.find((r) => r.account_id === accountId && r.scope === scope && r.key === key) ?? null;
  }

  listAll(accountId: string): CloudStateRecord[] {
    return this.load().records.filter((r) => r.account_id === accountId);
  }

  listDirty(accountId: string): CloudStateRecord[] {
    return this.load().records.filter((r) => r.account_id === accountId && r.dirty);
  }

  latestVersion(accountId: string): number {
    let max = 0;
    for (const r of this.load().records) {
      if (r.account_id === accountId && r.version > max) max = r.version;
    }
    return max;
  }

  readMeta(): CloudSyncMeta {
    return this.load().meta;
  }

  /** 该账号的拉取水位（上次拉取时服务端返回的 latest_version，没拉过为 0）。 */
  pulledThroughVersion(accountId: string): number {
    return this.load().meta.pulled_through[accountId] ?? 0;
  }

  /** 记下拉取水位（只进不退：服务端 version 单调递增，旧值不覆盖新值）。 */
  setPulledThroughVersion(accountId: string, version: number): void {
    const data = this.load();
    const prev = data.meta.pulled_through[accountId] ?? 0;
    if (version > prev) {
      data.meta.pulled_through[accountId] = Math.floor(version);
      this.save(data);
    }
  }

  /** 本地改一条：更新时间戳、标 dirty（version 不动，等服务端发新 version）。 */
  setLocal(accountId: string, scope: string, key: string, value: string, origin: string): CloudStateRecord {
    const data = this.load();
    const now = nowIso(this.clock());
    const existing = data.records.find((r) => r.account_id === accountId && r.scope === scope && r.key === key);
    if (existing) {
      existing.value = value;
      existing.updated_at = now;
      existing.origin = origin;
      existing.dirty = true;
      this.save(data);
      return existing;
    }
    const record: CloudStateRecord = { account_id: accountId, scope, key, value, updated_at: now, origin, version: 0, dirty: true };
    data.records.push(record);
    this.save(data);
    return record;
  }

  /** 本地删一条（删也是改动：记 dirty、value 置空串，推上去由服务端删；服务端没有“删记录”语义时 rejected 会留在 dirty 里，不静默丢）。 */
  deleteLocal(accountId: string, scope: string, key: string, origin: string): boolean {
    const data = this.load();
    const existing = data.records.find((r) => r.account_id === accountId && r.scope === scope && r.key === key);
    if (!existing) return false;
    existing.value = "";
    existing.updated_at = nowIso(this.clock());
    existing.origin = origin;
    existing.dirty = true;
    this.save(data);
    return true;
  }

  /**
   * 应用远端记录（拉下来的）：只认 version 更大的；本地有未推改动时按冲突
   * 规则裁决（最后写入者胜，时间戳打平按 origin 字典序大的赢）。
   * 返回拉下来真正落盘的条数与冲突清单（冲突只记 scope/key/留了哪边）。
   */
  applyRemote(accountId: string, remote: CloudStateRemoteRecord[]): { applied: number; conflicts: SyncConflict[] } {
    const data = this.load();
    let applied = 0;
    const conflicts: SyncConflict[] = [];
    for (const rec of remote) {
      if (rec.account_id !== accountId) continue;
      const local = data.records.find((r) => r.scope === rec.scope && r.key === rec.key);
      if (!local) {
        data.records.push({
          account_id: rec.account_id,
          scope: rec.scope,
          key: rec.key,
          value: rec.value,
          updated_at: rec.updated_at,
          origin: rec.origin,
          version: rec.version,
          dirty: false,
        });
        applied += 1;
        continue;
      }
      if (rec.version <= local.version) continue;
      if (!local.dirty) {
        local.value = rec.value;
        local.updated_at = rec.updated_at;
        local.origin = rec.origin;
        local.version = rec.version;
        local.dirty = false;
        applied += 1;
        continue;
      }
      // 本地有未推的改动：最后写入者胜。
      const localTime = Date.parse(local.updated_at);
      const remoteTime = Date.parse(rec.updated_at);
      let keepRemote = false;
      if (Number.isFinite(localTime) && Number.isFinite(remoteTime)) {
        if (remoteTime > localTime) keepRemote = true;
        else if (remoteTime === localTime) keepRemote = rec.origin > local.origin;
      } else {
        keepRemote = true;
      }
      if (keepRemote) {
        local.value = rec.value;
        local.updated_at = rec.updated_at;
        local.origin = rec.origin;
        local.version = rec.version;
        local.dirty = false;
        applied += 1;
        conflicts.push({ scope: rec.scope, key: rec.key, kept: "remote" });
      } else {
        // 留本地：version 不升（等下次推上去由服务端发新 version），dirty 保持。
        conflicts.push({ scope: rec.scope, key: rec.key, kept: "local" });
      }
    }
    if (applied > 0 || conflicts.length > 0) this.save(data);
    return { applied, conflicts };
  }

  /** 推成功的记录：记下服务端发的 version、清 dirty。 */
  markPushed(accountId: string, applied: { scope: string; key: string; version: number }[]): void {
    if (!applied.length) return;
    const data = this.load();
    for (const a of applied) {
      const local = data.records.find((r) => r.account_id === accountId && r.scope === a.scope && r.key === a.key);
      if (!local) continue;
      local.version = a.version;
      local.dirty = false;
    }
    this.save(data);
  }

  updateMeta(meta: CloudSyncMeta): void {
    const data = this.load();
    data.meta = meta;
    this.save(data);
  }
}

// ---- 偏好作用域（第一批真正同步的状态）-------------------------------

export function isPrefKey(key: string): key is PrefKey {
  return (PREF_KEYS as readonly string[]).includes(key);
}

export function setPreference(
  home: string,
  accountId: string,
  key: string,
  value: string,
  origin: string,
  opts?: { clock?: () => number },
): CloudStateRecord {
  if (!isPrefKey(key)) {
    throw new CloudSyncError(`偏好只认 ${PREF_KEYS.join("、")}，${key} 不在同步范围里`);
  }
  return new CloudStateStore(home, opts).setLocal(accountId, PREF_SCOPE, key, value, origin);
}

export function getPreference(home: string, accountId: string, key: string): string | null {
  if (!isPrefKey(key)) throw new CloudSyncError(`偏好只认 ${PREF_KEYS.join("、")}，${key} 不在同步范围里`);
  const rec = new CloudStateStore(home).get(accountId, PREF_SCOPE, key);
  return rec ? rec.value : null;
}

export function listPreferences(home: string, accountId: string): { key: string; value: string; dirty: boolean; version: number }[] {
  return new CloudStateStore(home).listAll(accountId)
    .filter((r) => r.scope === PREF_SCOPE)
    .map((r) => ({ key: r.key, value: r.value, dirty: r.dirty, version: r.version }));
}

// ---- 同步引擎：先拉后推 ----------------------------------------------

/**
 * 跑一次同步：拉（since=本地最大 version）→ 按冲突规则落盘 → 推本地 dirty。
 * pushOnly 只推不拉、pullOnly 只拉不推（CLI 的 sync/push/pull 分开入口）。
 * 云端连不上时直接抛错，不谎报同步成功；本地账本不动。
 */
export async function syncCloudState(
  home: string,
  opts: {
    client: CloudClient;
    accountId: string;
    deviceId: string;
    pushOnly?: boolean;
    pullOnly?: boolean;
    clock?: () => number;
    runId?: string | null;
  },
): Promise<SyncResult> {
  const store = new CloudStateStore(home, { clock: opts.clock });
  let pulled = 0;
  let pushed = 0;
  const conflicts: SyncConflict[] = [];
  const rejected: { scope: string; key: string; reason: string }[] = [];

  if (!opts.pushOnly) {
    // 拉取水位只看上次拉取的 latest_version（见 CloudSyncMeta 的注释）——
    // 推上去拿到的 version 不算数，否则会把还没拉过的记录顶出范围。
    const since = store.pulledThroughVersion(opts.accountId);
    const { records, latest_version } = await opts.client.pullState(since);
    const applied = store.applyRemote(opts.accountId, records);
    pulled = applied.applied;
    conflicts.push(...applied.conflicts);
    store.setPulledThroughVersion(opts.accountId, latest_version);
  }
  if (!opts.pullOnly) {
    const dirty = store.listDirty(opts.accountId);
    if (dirty.length > 0) {
      const { applied, rejected: rej } = await opts.client.pushState(
        dirty.map((r) => ({
          scope: r.scope,
          key: r.key,
          value: r.value,
          updated_at: r.updated_at,
          origin: r.origin,
          base_version: r.version,
        })),
      );
      store.markPushed(opts.accountId, applied);
      pushed = applied.length;
      rejected.push(...rej);
    }
  }
  const prevMeta = store.readMeta();
  const meta: CloudSyncMeta = {
    ...prevMeta,
    last_sync_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    last_pushed: pushed,
    last_pulled: pulled,
    last_conflicts: conflicts.length,
  };
  store.updateMeta(meta);
  mirrorCloudEvent(home, opts.runId ?? null, "cloud_synced", { pushed, pulled, conflicts: conflicts.length });
  for (const c of conflicts) {
    mirrorCloudEvent(home, opts.runId ?? null, "cloud_sync_conflict", { scope: c.scope, key: c.key, kept: c.kept });
  }
  return { pushed, pulled, conflicts, rejected };
}
