// src/credentialBroker.ts — M4（OpenMausBot 的 bot-box 纵深借鉴）：凭证经纪人。
//
// 沙箱里的 Bot 拿不到真凭证：宿主在 Broker 上登记“授权”（grant：固定
// 上游 + 要带的真请求头），给 Bot 只发一个短命 token（nyra_brk_…）。
// Bot 拿 token 到 Broker 的 /b/<token>/<grant>/<path> 来换：Broker 验
// token（只存 sha256 哈希、算哈希查表，不比明文）、剥掉客户端自己带的
// 凭证头、加上 grant 的真头、转发到 grant 绑定的固定上游。
// token 绑 botId/threadId、有 TTL、可吊销；真凭证只在宿主进程内存里，
// 绝不进沙箱环境变量、不进磁盘、不进事件。
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

export interface BrokerGrant {
  /** 固定上游（https 优先；http 只许本机回环的测试上游，生产上游一律 https）。 */
  upstream: string;
  /** 转发时加上的真请求头（只在宿主内存里）。 */
  headers: Record<string, string>;
}

export interface BrokerTokenInfo {
  botId: string;
  threadId: string | null;
  grants: string[];
  expiresAt: number;
}

export const BROKER_TOKEN_PREFIX = "nyra_brk_";
export const BROKER_DEFAULT_TTL_MS = 60 * 60 * 1000;

const CLIENT_CREDENTIAL_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "x-api-key", "api-key",
]);

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf-8").digest();
}

export class CredentialBroker {
  // 只存哈希（hex 为键）：明文 token 只在 mint 返回的那一刻存在，
  // 不进内存表、不落盘；验 token 是“算哈希再查表”，不比明文。
  private readonly tokens = new Map<string, BrokerTokenInfo>();
  private readonly grants = new Map<string, BrokerGrant>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** 登记一个授权：名字 → 固定上游 + 真请求头（只在宿主内存里）。 */
  registerGrant(name: string, grant: BrokerGrant): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
      throw new Error(`授权名无效：${name}（小写字母开头，只含小写字母、数字、- 和 _）`);
    }
    let upstream: URL;
    try {
      upstream = new URL(grant.upstream);
    } catch {
      throw new Error(`授权 ${name} 的上游不是合法 URL：${grant.upstream}`);
    }
    if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && (upstream.hostname === "127.0.0.1" || upstream.hostname === "localhost"))) {
      throw new Error(`授权 ${name} 的上游须是 https（http 只许本机回环的测试上游）`);
    }
    this.grants.set(name, { upstream: grant.upstream.replace(/\/+$/, ""), headers: { ...grant.headers } });
  }

  /** 发一个短命 token：只返回这一次，调用方发给 Bot；Broker 只存哈希。 */
  mint(botId: string, grants: string[], opts: { threadId?: string | null; ttlMs?: number } = {}): string {
    if (!botId.trim()) throw new Error("mint 须给 botId");
    for (const g of grants) {
      if (!this.grants.has(g)) throw new Error(`mint 失败：授权 ${g} 还没登记`);
    }
    const token = BROKER_TOKEN_PREFIX + randomBytes(24).toString("base64url");
    this.tokens.set(sha256(token).toString("hex"), {
      botId,
      threadId: opts.threadId ?? null,
      grants: [...grants],
      expiresAt: this.now() + (opts.ttlMs ?? BROKER_DEFAULT_TTL_MS),
    });
    return token;
  }

  /** 验 token：算哈希查表 + 未过期 + 授权还在。失败返回 null，不抛错。 */
  verify(token: string): BrokerTokenInfo | null {
    if (!token.startsWith(BROKER_TOKEN_PREFIX)) return null;
    const info = this.tokens.get(sha256(token).toString("hex"));
    if (!info) return null;
    if (info.expiresAt <= this.now()) return null;
    if (!info.grants.every((g) => this.grants.has(g))) return null;
    return { botId: info.botId, threadId: info.threadId, grants: [...info.grants], expiresAt: info.expiresAt };
  }

  /** 吊销一个 token（按哈希找）。 */
  revoke(token: string): boolean {
    return this.tokens.delete(sha256(token).toString("hex"));
  }

  /** 吊销某台 Bot 的全部 token（如下线、换 Key）。返回吊销数。 */
  revokeForBot(botId: string): number {
    let n = 0;
    for (const [key, info] of this.tokens) {
      if (info.botId === botId) {
        this.tokens.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** 清掉过期的 token。返回清理数。 */
  pruneExpired(): number {
    const now = this.now();
    let n = 0;
    for (const [key, info] of this.tokens) {
      if (info.expiresAt <= now) {
        this.tokens.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** 活着的 token 数（自检用，不暴露 token 本身）。 */
  get liveTokens(): number {
    return this.tokens.size;
  }

  /**
   * 处理一发 Broker 请求：/b/<token>/<grant>/<path…>。
   * 验 token → 验 grant 在 token 的授权里 → 剥客户端凭证头 → 加 grant
   * 的真头 → 转发到 grant 的固定上游 → 原样回状态与正文。
   * 任何一步失败都只回状态码，不回上游地址与真头。
   */
  async serveBrokerRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = (req.url ?? "").match(/^\/b\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) {
      res.writeHead(404);
      res.end("Broker 只接 /b/<token>/<grant>/<path>");
      return;
    }
    const token = decodeURIComponent(m[1]!);
    const grantName = decodeURIComponent(m[2]!);
    const restPath = m[3] ?? "/";
    const info = this.verify(token);
    if (!info || !info.grants.includes(grantName)) {
      res.writeHead(401);
      res.end("token 无效、过期或没这个授权");
      return;
    }
    const grant = this.grants.get(grantName)!;
    const target = new URL(grant.upstream + restPath);
    // 查询串只认原请求里的（上游固定，path 不许带出 grant 的范围）。
    target.search = new URL(req.url ?? "/", "http://broker.invalid").search;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (CLIENT_CREDENTIAL_HEADERS.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === "host") continue;
      if (typeof v === "string") headers[k] = v;
    }
    headers.host = target.host;
    for (const [k, v] of Object.entries(grant.headers)) headers[k] = v;
    const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = doRequest(
      {
        method: req.method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? parseInt(target.port, 10) : undefined,
        path: target.pathname + target.search,
        headers,
      },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined) continue;
          if (k.toLowerCase() === "set-cookie") continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("上游连不上");
    });
    req.pipe(upstream);
  }
}
