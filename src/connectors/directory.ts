// src/connectors/directory.ts — 缺口 44 第一批：原生业务连接器目录（安装/卸载/用量）+ 调用进运行记录。
//
// 目录是“用户装了哪些连接器”的账本，不是声明本身：声明（能读什么、能写什么、
// 须人批、永远禁做）在 src/connectors/registry.ts 的 CONNECTOR_DECLARATIONS 里，
// 是代码；目录记的是用户自己的安装动作（装了哪个、什么时候装的、谁装的）。
// - 安装：只装声明里有的连接器；试点（pilot）装不了；重复安装是幂等的（不重复
//   记审计、不改第一次的安装时间）。
// - 卸载：从目录里拿掉 + 同时撤销授权（markConnectorRevoked），访问立即断，
//   不等下次启动；用量历史保留（审计与用量账本是历史，不跟着删）。
// - 用量：每个连接器的调用计数（总次数、分操作次数、最后调用时间）。调用计数
//   是派生数据——审计 connector-audit.jsonl 才是事实源；用量账本损坏时先备份
//   再从空开始（不抛错、不拦调用），目录账本损坏则先备份再抛错（它是用户动作
//   的记录，丢了不能悄悄重建）。
// - 调用进运行记录：recordConnectorCall 在有 runId 时写 connector_call 运行
//   事件，没 runId 时走证据文件回落（与 recordConnectorEvent 同款）；token
//   原文、响应内容、客户信息一律不进事件与用量，只记操作名、条数、耗时。
//
// 依赖方向：本模块只 import registry.ts（声明 + 状态机 + 审计 + 事件落点），
// 不 import 三个客户端；反过来三个客户端的 audit() 调 recordConnectorCall——
// 单向依赖，不成环（registry 不 import 客户端）。
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNyraHome } from "../memory.ts";
import { atomicWriteJson } from "../bot/dedupAndQuota.ts";
import {
  appendConnectorAudit,
  ConnectorAuthStore,
  getDeclaration,
  listDeclarations,
  markConnectorRevoked,
  recordConnectorEvent,
  type ConnectorAuthState,
  type ConnectorPermissionDeclaration,
} from "./registry.ts";

export class ConnectorDirectoryError extends Error {}

/** 目录账本与用量账本（~/.nyra/ 下，0600、原子写，与其他账本同款写法）。 */
export const CONNECTOR_DIRECTORY_FILE = "connector-directory.json";
export const CONNECTOR_USAGE_FILE = "connector-usage.json";

export interface ConnectorDirectoryRecord {
  connectorId: string;
  installedAt: string;
  installedBy: string;
}

export interface ConnectorDirectoryFile {
  version: 1;
  installed: Record<string, ConnectorDirectoryRecord>;
}

export interface ConnectorUsageEntry {
  totalCalls: number;
  operations: Record<string, number>;
  lastCalledAt: string | null;
}

export interface ConnectorUsageFile {
  version: 1;
  totals: Record<string, ConnectorUsageEntry>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 损坏的账本先备份再处理（与 kanban.ts / reconciler.ts 同款写法）。 */
function backupCorrupt(path: string): void {
  try {
    copyFileSync(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    /* 备份失败也不拦后面的抛错/重建 */
  }
}

function zeroUsage(): ConnectorUsageEntry {
  return { totalCalls: 0, operations: {}, lastCalledAt: null };
}

/** 目录账本：损坏先备份再抛错（用户动作的记录，丢了不能悄悄重建）。 */
export class ConnectorDirectoryStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  load(): ConnectorDirectoryFile {
    const path = join(resolveNyraHome(this.home), CONNECTOR_DIRECTORY_FILE);
    if (!existsSync(path)) return { version: 1, installed: {} };
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err: unknown) {
      throw new ConnectorDirectoryError(`连接器目录账本读不到：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== "object") throw new Error("不是对象");
      const installed = (data as ConnectorDirectoryFile).installed;
      if (!installed || typeof installed !== "object") throw new Error("没有 installed 字段");
      return { version: 1, installed };
    } catch {
      backupCorrupt(path);
      throw new ConnectorDirectoryError("连接器目录账本损坏，已备份，请检查后恢复");
    }
  }

  save(file: ConnectorDirectoryFile): void {
    atomicWriteJson(this.home, CONNECTOR_DIRECTORY_FILE, file);
  }

  get(connectorId: string): ConnectorDirectoryRecord | null {
    return this.load().installed[connectorId] ?? null;
  }

  set(record: ConnectorDirectoryRecord): void {
    const file = this.load();
    file.installed[record.connectorId] = record;
    this.save(file);
  }

  remove(connectorId: string): void {
    const file = this.load();
    delete file.installed[connectorId];
    this.save(file);
  }
}

/** 用量账本：损坏先备份再从空开始（派生计数，审计才是事实源；不拦调用）。 */
export class ConnectorUsageStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  load(): ConnectorUsageFile {
    const path = join(resolveNyraHome(this.home), CONNECTOR_USAGE_FILE);
    if (!existsSync(path)) return { version: 1, totals: {} };
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (!data || typeof data !== "object") throw new Error("不是对象");
      const totals = (data as ConnectorUsageFile).totals;
      if (!totals || typeof totals !== "object") throw new Error("没有 totals 字段");
      return { version: 1, totals };
    } catch {
      backupCorrupt(path);
      return { version: 1, totals: {} };
    }
  }

  save(file: ConnectorUsageFile): void {
    atomicWriteJson(this.home, CONNECTOR_USAGE_FILE, file);
  }

  get(connectorId: string): ConnectorUsageEntry {
    return this.load().totals[connectorId] ?? zeroUsage();
  }

  bump(connectorId: string, operation: string): ConnectorUsageEntry {
    const file = this.load();
    const entry = file.totals[connectorId] ?? zeroUsage();
    entry.totalCalls += 1;
    entry.operations[operation] = (entry.operations[operation] ?? 0) + 1;
    entry.lastCalledAt = nowIso();
    file.totals[connectorId] = entry;
    this.save(file);
    return entry;
  }
}

/** 装了没有（目录账本只认安装动作，不认凭证——“沿用已有凭证迁移”只在
 * 真实调用时（ensureConnectorUsable）才发生，目录不替它做迁移判断）。 */
export function isConnectorInstalled(home: string, connectorId: string): boolean {
  return new ConnectorDirectoryStore(home).get(connectorId) !== null;
}

export function getConnectorUsage(home: string, connectorId: string): ConnectorUsageEntry {
  return new ConnectorUsageStore(home).get(connectorId);
}

export function getAllUsage(home: string): Record<string, ConnectorUsageEntry> {
  return new ConnectorUsageStore(home).load().totals;
}

/** 目录里的一行：声明 + 安装状态 + 账本里的授权状态 + 用量。授权状态只读
 * 账本（没记录就是未授权）；凭证在密码箱里但账本没记录时，目录不替它算
 * “已授权”，真实调用时的迁移判断仍由 ensureConnectorUsable 做。 */
export interface DirectoryEntry {
  declaration: ConnectorPermissionDeclaration;
  installed: boolean;
  installedAt?: string;
  installedBy?: string;
  authState: ConnectorAuthState;
  usage: ConnectorUsageEntry;
}

export function listDirectory(home: string, userId: string): DirectoryEntry[] {
  const dir = new ConnectorDirectoryStore(home);
  const auth = new ConnectorAuthStore(home);
  const usage = new ConnectorUsageStore(home);
  return listDeclarations().map((declaration) => {
    const installed = dir.get(declaration.id);
    const record = auth.get(declaration.id, userId);
    return {
      declaration,
      installed: installed !== null,
      ...(installed?.installedAt ? { installedAt: installed.installedAt } : {}),
      ...(installed?.installedBy ? { installedBy: installed.installedBy } : {}),
      authState: record?.state ?? "unauthorized",
      usage: usage.get(declaration.id),
    };
  });
}

/** 安装：只装声明里有的连接器；试点装不了；重复安装是幂等的（不重复记
 * 审计、不改第一次的安装时间）。安装本身不发凭证——凭证走各连接器自己的
 * 授权流程（nyra connector auth / nyra gmail auth 等）。 */
export function installConnector(
  home: string,
  connectorId: string,
  userId: string,
  opts?: { runId?: string | null },
): ConnectorDirectoryRecord {
  const decl = getDeclaration(connectorId);
  if (!decl) throw new ConnectorDirectoryError(`未知连接器：${connectorId}`);
  if (decl.status === "pilot") {
    throw new ConnectorDirectoryError(`${decl.displayName} 连接器尚未接入（试点），下一批做深连接器时开放。`);
  }
  const store = new ConnectorDirectoryStore(home);
  const existing = store.get(connectorId);
  if (existing) return existing;
  const record: ConnectorDirectoryRecord = { connectorId, installedAt: nowIso(), installedBy: userId };
  store.set(record);
  appendConnectorAudit(home, { action: "installed", connector: connectorId, userId });
  recordConnectorEvent(home, opts?.runId ?? null, "connector_installed", {
    connector: connectorId,
    user_id: userId,
  });
  return record;
}

/** 卸载：从目录里拿掉 + 同时撤销授权（立即断访问，不等下次启动）；用量
 * 历史保留。没装的卸载不了——先装后卸，报错比静默成功更不容易误操作。 */
export function uninstallConnector(
  home: string,
  connectorId: string,
  userId: string,
  opts?: { runId?: string | null },
): ConnectorDirectoryRecord {
  const decl = getDeclaration(connectorId);
  if (!decl) throw new ConnectorDirectoryError(`未知连接器：${connectorId}`);
  const store = new ConnectorDirectoryStore(home);
  const existing = store.get(connectorId);
  if (!existing) throw new ConnectorDirectoryError(`${decl.displayName} 还没安装，无需卸载。`);
  store.remove(connectorId);
  // 先断访问再记卸载：即使后面哪步失败，连接器也已经用不了了（与 revoke 同款顺序）。
  markConnectorRevoked(home, connectorId, userId, opts?.runId ?? null);
  appendConnectorAudit(home, { action: "uninstalled", connector: connectorId, userId });
  recordConnectorEvent(home, opts?.runId ?? null, "connector_uninstalled", {
    connector: connectorId,
    user_id: userId,
  });
  return existing;
}

/** 调用计数进运行记录：用量账本 + connector_call 事件。审计那一行已经由
 * 各客户端的 audit() 记了，这里不重复记审计。最佳努力：用量是派生计数，
 * 记不上不拦调用本身（返回 null）；未知连接器的调用不记（fail-closed）。
 * 缺口 44 深化：事件里带 user_id——报告要求调用记录写明“谁”调的（调了
 * 哪个系统、读了什么、写了什么、谁批准的里的“谁”）；没传 userId 时不写该字段。 */
export function recordConnectorCall(
  home: string,
  call: {
    connector: string;
    operation: string;
    runId?: string | null;
    records?: number;
    durationMs?: number;
    userId?: string;
  },
): ConnectorUsageEntry | null {
  try {
    if (!getDeclaration(call.connector)) return null;
    const entry = new ConnectorUsageStore(home).bump(call.connector, call.operation);
    recordConnectorEvent(home, call.runId ?? null, "connector_call", {
      connector: call.connector,
      operation: call.operation,
      records: call.records ?? 0,
      duration_ms: call.durationMs ?? 0,
      ...(call.userId ? { user_id: call.userId } : {}),
    });
    return entry;
  } catch {
    return null;
  }
}
