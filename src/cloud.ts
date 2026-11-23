// src/cloud.ts — 手机云端连接（第 6 批，用户 2026-11-23 令：手机端改账号登录，
// 不走局域网、像 Codex 一样连云端）。
//
// 以前手机是“遥控器”：启动器页填电脑局域网 IP + 8765 端口 + 6 位配对码，
// WebView 跳到电脑上 `nyra ui` 的 /m，身份是设备 token（src/pairing.ts）。
// 本批改成：手机用账号登录（Google/GitHub/邮箱，复用 src/accounts.ts 同一套
// 账号制），登录后直连云端 Nyra 服务，agent 在云端跑，手机与电脑不用在
// 同一个 Wi-Fi 里——跟 Codex 手机端登账号后直连 OpenAI 云端一个做法。
//
// 本批只做客户端一半，服务端不在这个仓库里（DESIGN.md 服务化方向：
// “服务端是另一套技术选型，CLI 保持轻量，服务层另起炉灶”）：
//   - 客户端：云端地址解析（环境变量 > config.json > 设计占位地址）、
//     云端 HTTP 客户端（本文件）、跨端同步协议与本地账本（src/cloudSync.ts）、
//     CLI（src/cloudCli.ts）、手机启动器页（mobile/www/index.html）。
//   - 服务端（没做，诚实写进 docs/mobile-cloud.md）：按本文档 §API 契约实现
//     /api/cloud/* 的那台服务——账号目录、会话校验、设备登记、状态存储
//     都在服务端，部署与算力成本等商业决策。
//
// 安全纪律（与账号、配对同款）：
//   - 会话 token 只在 Authorization 头里带，绝不放 URL、日志、审计、事件；
//   - 云端会话记录（cloud-session.json）与设备 id（cloud-device.json）0600、
//     原子写；损坏先备份再抛错，不静默清空；
//   - 明文 http:// 只允许本机地址（与 config.ts 的 plaintextHttpError 同款口径）；
//   - 未配云端地址时不发起任何连接（设计占位地址解析不到任何真实服务）；
//   - 未登录账号时拒绝连接（fail-closed：先 nyra account login，再 nyra cloud connect）。

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, PLAINTEXT_HTTP_HOSTS } from "./config.ts";
import { resolveNyraHome, atomicTmpPath } from "./memory.ts";
import { RunStore } from "./runs.ts";

export class CloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudError";
  }
}

/**
 * 云端服务的设计占位地址。api.nyra.example 是 RFC 保留域名（.example 永远
 * 解析不到任何真实服务）：它只是文档与代码里约定的“将来云端长这样”，
 * 不是已上线的服务。没配真实地址时客户端绝不拿它发起连接
 *（isCloudConfigured() 为 false 时 connectToCloud 直接拒绝）。
 */
export const CLOUD_DESIGN_URL = "https://api.nyra.example";
export const CLOUD_URL_ENV = "NYRA_CLOUD_URL";
export const CLOUD_SESSION_FILE = "cloud-session.json";
export const CLOUD_DEVICE_FILE = "cloud-device.json";
/** 云端请求超时（30 秒；与账号登录取用户信息同款）。 */
export const CLOUD_REQUEST_TIMEOUT_MS = 30_000;

/** 云端地址来源：环境变量 > config.json 的 cloud.url > 设计占位地址。 */
export function resolveCloudUrl(home: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = (env[CLOUD_URL_ENV] ?? "").trim();
  if (fromEnv) return fromEnv;
  const cfg = loadConfig(home);
  const cloud = cfg.cloud;
  if (cloud && typeof cloud === "object" && !Array.isArray(cloud)) {
    const url = ((cloud as Record<string, unknown>).url as string | undefined) ?? "";
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return CLOUD_DESIGN_URL;
}

/** 有没有配真实云端地址（只看环境变量与 config.json，不认设计占位地址）。 */
export function isCloudConfigured(home: string, env: Record<string, string | undefined> = process.env): boolean {
  const fromEnv = (env[CLOUD_URL_ENV] ?? "").trim();
  if (fromEnv) return true;
  const cfg = loadConfig(home);
  const cloud = cfg.cloud;
  if (cloud && typeof cloud === "object" && !Array.isArray(cloud)) {
    const url = ((cloud as Record<string, unknown>).url as string | undefined) ?? "";
    if (typeof url === "string" && url.trim()) return true;
  }
  return false;
}

/** 校验云端地址：只认 http/https；明文 http 只允许本机地址。返回错误文案，通过返回 null。 */
export function validateCloudUrl(url: string): string | null {
  const text = (url ?? "").trim();
  if (!text) return "云端地址不能为空";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "云端地址格式不对，应为 http:// 或 https:// 开头的完整地址";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "云端地址只支持 http:// 或 https://";
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (!PLAINTEXT_HTTP_HOSTS.has(host)) {
      return "云端地址用了明文 http:// 且不是本机地址，会话 token 会随请求明文传输；请改用 https://（http:// 只允许本机地址，供本地联调云端用）";
    }
  }
  return null;
}

/** 端点主机名（只记主机名进事件与状态输出，不带路径、不带 token）。 */
export function endpointHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export type CloudFetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** 云端 API 契约（见 docs/mobile-cloud.md §4）：服务端须按这组路径与字段实现。 */
export interface CloudDeviceInfo {
  id: string;
  name: string;
  last_seen: string;
  current: boolean;
}

export interface CloudStatePushRecord {
  scope: string;
  key: string;
  value: string;
  updated_at: string;
  origin: string;
  base_version: number;
}

export interface CloudStateRemoteRecord extends CloudStatePushRecord {
  account_id: string;
  version: number;
}

export class CloudClient {
  baseUrl: string;
  sessionToken: string;
  private fetchFn: CloudFetchFn;
  private timeoutMs: number;

  constructor(opts: { baseUrl: string; sessionToken: string; fetchFn?: CloudFetchFn; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.sessionToken = opts.sessionToken;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as CloudFetchFn);
    this.timeoutMs = opts.timeoutMs ?? CLOUD_REQUEST_TIMEOUT_MS;
  }

  private async request(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: "Bearer " + this.sessionToken,
          "Content-Type": "application/json",
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CloudError(`连不上云端服务（${endpointHost(this.baseUrl)}）：${msg}，检查网络或云端地址（nyra cloud status 看当前地址）`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 按错误处理 */
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new CloudError("云端拒绝了会话（401）：账号会话已失效，请先重新登录账号（nyra account login），再连云端");
      }
      const serverMsg = data && typeof data === "object" && typeof (data as Record<string, unknown>).error === "string"
        ? (data as Record<string, unknown>).error as string
        : "";
      throw new CloudError(`云端返回错误：HTTP ${res.status}${serverMsg ? `（${serverMsg}）` : ""}`);
    }
    return data;
  }

  /** 云端健康检查（GET /api/cloud/health）：只判服务在不在，不带任何身份。 */
  async health(): Promise<{ ok: boolean; version?: string }> {
    const data = await this.request("/api/cloud/health");
    if (!data || typeof data !== "object") throw new CloudError("云端健康检查返回了无法识别的内容");
    const d = data as Record<string, unknown>;
    return { ok: d.ok === true, ...(typeof d.version === "string" ? { version: d.version } : {}) };
  }

  /** 登记本设备（POST /api/cloud/sessions）：云端认账号会话 token，返回云端会话 id。 */
  async registerSession(device: { device_id: string; device_name: string }): Promise<{ cloud_session_id: string; expires_at: string }> {
    const data = await this.request("/api/cloud/sessions", { method: "POST", body: device });
    if (!data || typeof data !== "object") throw new CloudError("云端登记设备返回了无法识别的内容");
    const d = data as Record<string, unknown>;
    if (typeof d.cloud_session_id !== "string" || !d.cloud_session_id) throw new CloudError("云端登记设备没有返回云端会话 id");
    if (typeof d.expires_at !== "string" || !d.expires_at) throw new CloudError("云端登记设备没有返回会话过期时间");
    return { cloud_session_id: d.cloud_session_id, expires_at: d.expires_at };
  }

  /** 撤销云端会话（DELETE /api/cloud/sessions/<id>）。 */
  async revokeSession(cloudSessionId: string): Promise<void> {
    await this.request(`/api/cloud/sessions/${encodeURIComponent(cloudSessionId)}`, { method: "DELETE" });
  }

  /** 列出该账号在云端登记的设备（GET /api/cloud/devices）。 */
  async listDevices(): Promise<CloudDeviceInfo[]> {
    const data = await this.request("/api/cloud/devices");
    if (!data || typeof data !== "object") throw new CloudError("云端设备列表返回了无法识别的内容");
    const items = (data as Record<string, unknown>).devices;
    if (!Array.isArray(items)) throw new CloudError("云端设备列表返回了无法识别的内容");
    return items.filter((item): item is CloudDeviceInfo => {
      return !!item && typeof item === "object" &&
        typeof (item as CloudDeviceInfo).id === "string" &&
        typeof (item as CloudDeviceInfo).name === "string" &&
        typeof (item as CloudDeviceInfo).last_seen === "string" &&
        typeof (item as CloudDeviceInfo).current === "boolean";
    });
  }

  /** 推状态（POST /api/cloud/state/push）：带 base_version，服务端按版本裁决。 */
  async pushState(records: CloudStatePushRecord[]): Promise<{
    applied: { scope: string; key: string; version: number }[];
    rejected: { scope: string; key: string; reason: string }[];
  }> {
    const data = await this.request("/api/cloud/state/push", { method: "POST", body: { records } });
    if (!data || typeof data !== "object") throw new CloudError("云端推状态返回了无法识别的内容");
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.applied) || !Array.isArray(d.rejected)) throw new CloudError("云端推状态返回了无法识别的内容");
    return {
      applied: (d.applied as unknown[]).filter((a): a is { scope: string; key: string; version: number } =>
        !!a && typeof a === "object" &&
        typeof (a as { scope: string }).scope === "string" &&
        typeof (a as { key: string }).key === "string" &&
        typeof (a as { version: number }).version === "number"),
      rejected: (d.rejected as unknown[]).filter((r): r is { scope: string; key: string; reason: string } =>
        !!r && typeof r === "object" &&
        typeof (r as { scope: string }).scope === "string" &&
        typeof (r as { key: string }).key === "string" &&
        typeof (r as { reason: string }).reason === "string"),
    };
  }

  /** 拉状态（GET /api/cloud/state?since=<版本号>）：只拉比本地新的记录。 */
  async pullState(sinceVersion: number): Promise<{ records: CloudStateRemoteRecord[]; latest_version: number }> {
    const data = await this.request(`/api/cloud/state?since=${Math.max(0, Math.floor(sinceVersion))}`);
    if (!data || typeof data !== "object") throw new CloudError("云端拉状态返回了无法识别的内容");
    const d = data as Record<string, unknown>;
    if (!Array.isArray(d.records) || typeof d.latest_version !== "number") throw new CloudError("云端拉状态返回了无法识别的内容");
    const records = (d.records as unknown[]).filter((r): r is CloudStateRemoteRecord => {
      return !!r && typeof r === "object" &&
        typeof (r as CloudStateRemoteRecord).account_id === "string" &&
        typeof (r as CloudStateRemoteRecord).scope === "string" &&
        typeof (r as CloudStateRemoteRecord).key === "string" &&
        typeof (r as CloudStateRemoteRecord).value === "string" &&
        typeof (r as CloudStateRemoteRecord).updated_at === "string" &&
        typeof (r as CloudStateRemoteRecord).origin === "string" &&
        typeof (r as CloudStateRemoteRecord).version === "number";
    });
    return { records, latest_version: d.latest_version };
  }
}

// ---- 云端会话记录（本机“cookie 罐”，与 account-session.json 同款纪律）----

export interface CloudSession {
  cloud_session_id: string;
  account_id: string;
  device_id: string;
  device_name: string;
  endpoint: string;
  issued_at: string;
  expires_at: string;
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

function readJsonFile<T>(path: string, label: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const backup = path + ".corrupt-" + String(process.pid) + "-" + randomBytes(4).toString("hex");
    try {
      writeFileSync(backup, raw, { encoding: "utf-8", mode: 0o600 });
    } catch {
      /* 备份写不进去也不拦抛错本身 */
    }
    throw new CloudError(label + "损坏（已备份到 " + backup + "），请检查后恢复或删除重建");
  }
}

export function readCloudSession(home: string): CloudSession | null {
  const data = readJsonFile<CloudSession>(join(resolveNyraHome(home), CLOUD_SESSION_FILE), "云端会话文件");
  if (!data || typeof data.cloud_session_id !== "string" || !data.cloud_session_id ||
    typeof data.account_id !== "string" || typeof data.device_id !== "string" ||
    typeof data.endpoint !== "string") return null;
  return data;
}

export function writeCloudSession(home: string, session: CloudSession): void {
  atomicWriteJson(join(resolveNyraHome(home), CLOUD_SESSION_FILE), session);
}

export function clearCloudSession(home: string): void {
  try {
    unlinkSync(join(resolveNyraHome(home), CLOUD_SESSION_FILE));
  } catch {
    /* 不存在即已清除 */
  }
}

/**
 * 本机设备 id（每台机器一个，第一次连云端时生成、之后一直沿用；设备列表里
 * 认的就是它）。名字默认取机器主机名，只做展示用。
 */
export function getOrCreateDeviceId(home: string): { device_id: string; device_name: string } {
  const path = join(resolveNyraHome(home), CLOUD_DEVICE_FILE);
  const existing = readJsonFile<{ device_id?: unknown; device_name?: unknown }>(path, "云端设备文件");
  if (existing && typeof existing.device_id === "string" && existing.device_id) {
    return {
      device_id: existing.device_id,
      device_name: typeof existing.device_name === "string" && existing.device_name ? existing.device_name : hostname(),
    };
  }
  const created = { device_id: randomBytes(8).toString("hex"), device_name: hostname() || "未命名设备" };
  atomicWriteJson(path, created);
  return created;
}

/** 有运行上下文时，把云端事件镜像进运行事件（与 accounts.ts 的 mirrorAccountEvent 同款写法）。 */
export function mirrorCloudEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch {
      /* 不在这个目录，换下一个 */
    }
  }
}

/**
 * 连云端：先确认本地账号已登录（复用同一套账号制，不另造身份），再拿账号
 * 会话 token 去云端登记本设备。未配云端地址、未登录账号、云端不健康，
 * 全部直接拒绝（fail-closed），不静默降级回局域网。
 */
export async function connectToCloud(
  home: string,
  opts?: { deviceName?: string; fetchFn?: CloudFetchFn; runId?: string | null },
): Promise<{ session: CloudSession; accountEmail: string; health: { ok: boolean; version?: string } }> {
  const endpoint = resolveCloudUrl(home);
  if (!isCloudConfigured(home)) {
    throw new CloudError(
      "云端服务还没配好：当前地址是设计占位地址 " + CLOUD_DESIGN_URL + "（解析不到任何真实服务，不会真的连过去）。" +
      "配好云端地址再连：nyra cloud set-url <云端地址>，或设环境变量 NYRA_CLOUD_URL",
    );
  }
  const urlError = validateCloudUrl(endpoint);
  if (urlError) throw new CloudError(urlError);
  // 动态 import：accounts.ts 不 import cloud.ts，这里静态 import 也不会成环，
  // 但保持与 cli.ts 的懒加载口径一致，云端模块只在真连云端时才拉起账号模块。
  const accounts = await import("./accounts.ts");
  const account = await accounts.getCurrentAccount(home);
  if (!account) {
    throw new CloudError("还没登录账号：先跑 nyra account login google|github|email 登录，再连云端（手机与电脑登同一个账号）");
  }
  const current = accounts.readCurrentSession(home);
  if (!current) {
    throw new CloudError("账号会话找不到了，请重新登录账号后再连云端");
  }
  const device = getOrCreateDeviceId(home);
  if (opts?.deviceName) device.device_name = opts.deviceName;
  const client = new CloudClient({ baseUrl: endpoint, sessionToken: current.token, fetchFn: opts?.fetchFn });
  const health = await client.health();
  if (!health.ok) throw new CloudError("云端服务不健康（" + endpointHost(endpoint) + " 回了 ok=false），先检查云端服务状态再连");
  const registered = await client.registerSession({ device_id: device.device_id, device_name: device.device_name });
  const session: CloudSession = {
    cloud_session_id: registered.cloud_session_id,
    account_id: account.id,
    device_id: device.device_id,
    device_name: device.device_name,
    endpoint,
    issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    expires_at: registered.expires_at,
  };
  writeCloudSession(home, session);
  try {
    accounts.appendAccountAudit(home, { action: "cloud_connected", account_id: account.id });
  } catch {
    /* 审计写不进去不拦连接本身 */
  }
  mirrorCloudEvent(home, opts?.runId ?? null, "cloud_connected", {
    account_id: account.id,
    device_id: device.device_id,
    endpoint_host: endpointHost(endpoint),
  });
  return { session, accountEmail: account.email, health };
}

/**
 * 断开云端：先请云端撤销会话（连不上也继续——本机凭证照样清掉，不留
 * “断不开就一直连着”的状态），再清本机云端会话记录。
 */
export async function disconnectFromCloud(
  home: string,
  opts?: { fetchFn?: CloudFetchFn; runId?: string | null },
): Promise<{ revoked_remote: boolean; account_id: string | null }> {
  const session = readCloudSession(home);
  if (!session) throw new CloudError("当前没有连云端（nyra cloud status 看状态）");
  let revoked = false;
  let revokeError: string | null = null;
  try {
    const accounts = await import("./accounts.ts");
    const current = accounts.readCurrentSession(home);
    if (current) {
      const client = new CloudClient({ baseUrl: session.endpoint, sessionToken: current.token, fetchFn: opts?.fetchFn });
      await client.revokeSession(session.cloud_session_id);
      revoked = true;
    }
  } catch (err: unknown) {
    revokeError = err instanceof Error ? err.message : String(err);
  }
  clearCloudSession(home);
  try {
    const accounts = await import("./accounts.ts");
    accounts.appendAccountAudit(home, { action: "cloud_disconnected", account_id: session.account_id });
  } catch {
    /* 审计写不进去不拦断开本身 */
  }
  if (revokeError) {
    // 云端没撤销成，但本机凭证已清：下次再连是新的会话，旧云端会话在服务端
    // 按过期时间自然失效——如实告诉用户，不谎称已撤销。
    throw new CloudError("本机云端凭证已清掉，但云端那边的会话没撤销成（" + revokeError + "）；旧会话会在服务端过期后失效");
  }
  return { revoked_remote: revoked, account_id: session.account_id };
}

/** 给已连云端的调用方建客户端：云端会话记录 + 本机账号会话 token 都得在，缺一个就拒绝。 */
export async function cloudClientForSession(home: string, opts?: { fetchFn?: CloudFetchFn }): Promise<{ client: CloudClient; session: CloudSession; accountId: string }> {
  const session = readCloudSession(home);
  if (!session) throw new CloudError("还没连云端：先跑 nyra cloud connect（须先登录账号、配好云端地址）");
  const accounts = await import("./accounts.ts");
  const current = accounts.readCurrentSession(home);
  if (!current || current.account_id !== session.account_id) {
    throw new CloudError("账号会话对不上云端会话（可能换了账号或会话过期了）：请重新登录账号后再连云端");
  }
  const account = await accounts.getCurrentAccount(home);
  if (!account) throw new CloudError("账号会话已失效：请重新登录账号后再连云端");
  return {
    client: new CloudClient({ baseUrl: session.endpoint, sessionToken: current.token, fetchFn: opts?.fetchFn }),
    session,
    accountId: account.id,
  };
}

/** 会话 token 指纹（只记前 12 位进日志/调试，原文绝不落盘、不进事件）。 */
export function sessionTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex").slice(0, 12);
}
