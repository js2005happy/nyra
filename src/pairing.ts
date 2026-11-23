// src/pairing.ts — 扫码配对与设备登记，与 Python 版 nyra/pairing.py 同语义。
// 配对码：6 位数字、5 分钟有效（DeviceRegistry，DEVICE_CODE_TTL_SECONDS=300）、
// 一次性、错 5 次作废；同一时刻只有一个有效码，重新生成旧码立即失效。
// 保留 6 位（审查报告第 4 项）：好记、顺手；暴力破解被错 5 次作废 +
// 300 秒 TTL + 一次性三重堵住，6 位空间足够。UDP 发现应答只回名字和
// HTTP 端口，不带配对码也不带 token——没有配对码预言机（审查报告
// Python S-H1 的那个 bug 在 Node 版不存在，回归测试锁定）。
// 配对 token（审查报告第 3 项）：180 天不用自动失效——设备每次认证成功
// 都刷新 last_seen，常用设备永不过期；长期不用的设备 token 被剪掉，
// 丢了的旧手机不会一直能连。过期判断只看 last_seen，改动对用户透明。
// 配对成功发设备专属 token（只此一次返回），磁盘只存 SHA-256；文件 0600、
// 原子写入。配对码与 token 均为明文传输（HTTP 与 UDP），只在可信网络上配对：
// 适用范围就是本机局域网发现 + 本机 HTTP 端口，不要跨公网配对；
// 这是局域网配对的常规做法，改成 HTTPS 需要给每台电脑发证书，
// 普通用户配不起来，所以保留明文并写清范围，不假装它安全。
// 注意：PairingHost 的 CODE_TTL_SECONDS=600 是另一条旧路径，网页端走
// DeviceRegistry 的 300 秒，以此为准。
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSocket, type Socket } from "node:dgram";
import { resolveNyraHome } from "./memory.ts";

export const DISCOVERY_PORT = 47831;
export const DISCOVERY_MAGIC = "NYRA-PAIR-SEARCH";
export const CODE_TTL_SECONDS = 300;
export const MAX_FAILED_ATTEMPTS = 5;
export const MAX_DEVICES = 10;
export const MAX_DEVICE_NAME = 40;
/** 配对 token 连续不用多少秒后自动失效（180 天；审查报告第 3 项）。 */
export const TOKEN_INACTIVITY_TTL_SECONDS = 180 * 24 * 3600;
export const DEVICES_FILE = "devices.json";
const LAST_SEEN_WRITE_INTERVAL = 60.0;

export class PairingError extends Error {
  constructor(message: string) { super(message); this.name = "PairingError"; }
}

/**
 * 6 位配对码：用加密安全随机数（crypto.randomInt，均匀分布在 100000–999999）。
 * 原来用 Math.random()——它不是 CSPRNG，内部状态可从连续输出推出来，
 * 同一局域网里的人理论上能预测下一个配对码；错 5 次作废挡得住瞎猜，挡不住算出来。
 */
export function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

function cleanName(name: unknown): string {
  const text = String(name ?? "").split("").filter((c) => c >= " " && c !== "\x7f").join("").trim();
  return (text.slice(0, MAX_DEVICE_NAME) || "手机");
}

function nowIso(epochSeconds?: number): string {
  // 传时钟秒数时按它算（测试用注入时钟）；不传按墙钟算（生产默认时钟即墙钟）。
  const ms = epochSeconds === undefined ? Date.now() : epochSeconds * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface DeviceRecord {
  id: string;
  name: string;
  token_sha256: string;
  created: string;
  last_seen: string;
}

export function defaultDevicesPath(home?: string): string {
  return join(resolveNyraHome(home), DEVICES_FILE);
}

export class DeviceRegistry {
  path: string;
  codeTtl: number;
  maxAttempts: number;
  private clock: () => number;
  private code: string | null = null;
  private codeExpiresAt = 0;
  private failed = 0;
  private lastSeenWritten: Record<string, number> = {};
  private mtime: [number, number, number] | null = null;
  private devices: DeviceRecord[] = [];

  constructor(path: string, opts?: { codeTtl?: number; maxAttempts?: number; clock?: () => number }) {
    this.path = path;
    this.codeTtl = opts?.codeTtl ?? CODE_TTL_SECONDS;
    this.maxAttempts = opts?.maxAttempts ?? MAX_FAILED_ATTEMPTS;
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
    this.devices = this.load();
  }

  private statMtime(): [number, number, number] | null {
    try {
      const st = statSync(this.path);
      return [st.mtimeMs, st.ino, st.size];
    } catch { return null; }
  }

  private refresh(): void {
    const m = this.statMtime();
    if (JSON.stringify(m) !== JSON.stringify(this.mtime)) this.devices = this.load();
  }

  private load(): DeviceRecord[] {
    this.mtime = this.statMtime();
    try {
      const data = JSON.parse(readFileSync(this.path, "utf-8")) as { devices?: unknown };
      const items = Array.isArray(data.devices) ? data.devices : [];
      return items.filter((item): item is DeviceRecord => {
        return !!item && typeof item === "object" &&
          typeof (item as DeviceRecord).id === "string" &&
          typeof (item as DeviceRecord).token_sha256 === "string" &&
          (item as DeviceRecord).token_sha256.length === 64;
      });
    } catch { return []; }
  }

  private save(): void {
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 1), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
    try { chmodSync(this.path, 0o600); } catch { /* ignore */ }
    this.mtime = this.statMtime();
  }

  startPairing(): { code: string; expires_in: number } {
    this.code = generateCode();
    this.codeExpiresAt = this.clock() + this.codeTtl;
    this.failed = 0;
    return { code: this.code, expires_in: Math.floor(this.codeTtl) };
  }

  pairingStatus(): { active: boolean; expires_in: number } {
    const active = this.code !== null && this.clock() < this.codeExpiresAt;
    return { active, expires_in: active ? Math.max(0, Math.floor(this.codeExpiresAt - this.clock())) : 0 };
  }

  cancelPairing(): void { this.code = null; }

  redeem(code: string, name = ""): { id: string; name: string; token: string } {
    if (typeof code !== "string") throw new PairingError("配对码无效");
    const input = code.trim();
    if (this.code === null) throw new PairingError("没有进行中的配对，请在电脑上重新生成配对码");
    if (this.clock() >= this.codeExpiresAt) {
      this.code = null;
      throw new PairingError("配对码已过期，请在电脑上重新生成");
    }
    const a = Buffer.from(input, "utf-8");
    const b = Buffer.from(this.code, "utf-8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.failed += 1;
      if (this.failed >= this.maxAttempts) {
        this.code = null;
        throw new PairingError("配对码错误次数过多，已作废，请在电脑上重新生成");
      }
      throw new PairingError("配对码错误");
    }
    this.code = null; // 一次性
    this.refresh();
    if (this.devices.length >= MAX_DEVICES) throw new PairingError(`已配对设备太多（上限 ${MAX_DEVICES}），请先撤销不用的设备`);
    const token = randomBytes(32).toString("base64url");
    const device: DeviceRecord = {
      id: randomBytes(8).toString("hex"),
      name: cleanName(name),
      token_sha256: hashDeviceToken(token),
      created: nowIso(this.clock()),
      last_seen: nowIso(this.clock()),
    };
    this.devices.push(device);
    this.save();
    return { id: device.id, name: device.name, token };
  }

  authenticate(token: string): Omit<DeviceRecord, "token_sha256"> | null {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const digest = hashDeviceToken(token);
    this.refresh();
    let found: DeviceRecord | null = null;
    for (const d of this.devices) {
      const a = Buffer.from(digest, "utf-8");
      const b = Buffer.from(d.token_sha256, "utf-8");
      if (a.length === b.length && timingSafeEqual(a, b)) found = d;
    }
    if (!found) return null;
    // 180 天没用过：token 自动失效，从列表里剪掉（审查报告第 3 项）。
    const lastSeenMs = Date.parse(found.last_seen);
    if (!Number.isNaN(lastSeenMs) && this.clock() - lastSeenMs / 1000 > TOKEN_INACTIVITY_TTL_SECONDS) {
      this.devices = this.devices.filter((d) => d.id !== found.id);
      delete this.lastSeenWritten[found.id];
      try { this.save(); } catch { /* ignore */ }
      return null;
    }
    const now = this.clock();
    const last = this.lastSeenWritten[found.id];
    if (last === undefined || now - last >= LAST_SEEN_WRITE_INTERVAL) {
      this.lastSeenWritten[found.id] = now;
      found.last_seen = nowIso(now);
      try { this.save(); } catch { /* ignore */ }
    }
    const { token_sha256: _omit, ...rest } = found;
    void _omit;
    return rest;
  }

  listDevices(): Omit<DeviceRecord, "token_sha256">[] {
    this.refresh();
    return this.devices.map(({ token_sha256: _omit, ...rest }) => rest);
  }

  revoke(deviceId: string): boolean {
    this.refresh();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    if (this.devices.length === before) return false;
    delete this.lastSeenWritten[deviceId];
    this.save();
    return true;
  }
}

/** UDP 发现应答内容：只有名字 + HTTP 端口，绝不带配对码或 token（审查报告第 4 项：无预言机）。 */
export function buildDiscoveryReply(name: string, httpPort: number): string {
  return JSON.stringify({ magic: DISCOVERY_MAGIC, name: name ?? "Nyra", port: httpPort });
}

/** UDP 发现应答：收到 NYRA-PAIR-SEARCH 的广播后回包（JSON：名字 + HTTP 端口）。 */
export function startDiscoveryResponder(opts: { name?: string; httpPort: number; onError?: (err: Error) => void }): Socket {
  const sock = createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    const text = msg.toString("utf-8").trim();
    const parts = text.split(" ");
    if (parts.length !== 2 || parts[0] !== DISCOVERY_MAGIC) return;
    const payload = buildDiscoveryReply(opts.name ?? "Nyra", opts.httpPort);
    sock.send(payload, rinfo.port, rinfo.address);
  });
  sock.on("error", (err) => { opts.onError?.(err); });
  sock.bind(DISCOVERY_PORT, "0.0.0.0");
  return sock;
}
