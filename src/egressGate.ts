// src/egressGate.ts — M4（OpenMausBot 的 bot-box 纵深借鉴）：出口代理。
//
// 沙箱里的进程不直接上网：只认一个 HTTP 代理（http_proxy/https_proxy
// 指向它），代理只把“公网地址”放出去——内网、loopback、链路本地、
// 云元数据地址一律拒掉并计数。DNS 由代理自己解析（先解析、再验 IP、
// 再连解析到的 IP，不连主机名本身——DNS 重绑定也逃不过去）。
// 只放 http://（绝对 URI）与 CONNECT（https 隧道）；其他一律 400。
// 端口默认只放 80/443。
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns";

export type ResolveFn = (host: string) => Promise<string[]>;
export type DialFn = (ip: string, port: number) => Promise<Socket>;

export const EGRESS_DEFAULT_PORTS = [80, 443];

/** 192.0.2.0/24、198.51.100.0/24、203.0.113.0/24（文档地址）等也拒掉。 */
function ipv4In(n: number[], net: number[], prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const ip = ((n[0]! << 24) | (n[1]! << 16) | (n[2]! << 8) | n[3]!) >>> 0;
  const base = ((net[0]! << 24) | (net[1]! << 16) | (net[2]! << 8) | net[3]!) >>> 0;
  return (ip & mask) === (base & mask);
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v < 0 || v > 255 || (p.length > 1 && p.startsWith("0"))) return null;
    nums.push(v);
  }
  return nums;
}

function isPublicIpv4(n: number[]): boolean {
  const nets: [number[], number][] = [
    [[0, 0, 0, 0], 8], // 本机网络
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10], // CGNAT
    [[127, 0, 0, 0], 8], // loopback
    [[169, 254, 0, 0], 16], // 链路本地（含 169.254.169.254 云元数据）
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24], // IANA 特殊
    [[192, 0, 2, 0], 24], // 文档
    [[192, 31, 196, 0], 24], // AS112
    [[192, 52, 193, 0], 24], // AMT
    [[192, 88, 99, 0], 24], // 6to4 中继（已废弃）
    [[192, 168, 0, 0], 16],
    [[192, 175, 48, 0], 24], // 直连 AS112
    [[198, 18, 0, 0], 15], // 基准测试
    [[198, 51, 100, 0], 24], // 文档
    [[203, 0, 113, 0], 24], // 文档
    [[224, 0, 0, 0], 4], // 组播
    [[240, 0, 0, 0], 4], // 保留（含 255.255.255.255）
  ];
  return !nets.some(([net, prefix]) => ipv4In(n, net, prefix));
}

function expandIpv6(ip: string): number[] | null {
  // 只做分类够用的展开：处理 :: 压缩与 IPv4 尾巴。
  let head = ip;
  let v4tail: number[] | null = null;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4tail = parseIpv4(tail);
    if (!v4tail) return null;
    head = ip.slice(0, lastColon + 1) + "0:0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parseGroup = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  let groups: number[];
  if (halves.length === 2) {
    const left = parseGroup(halves[0]!);
    const right = parseGroup(halves[1]!);
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const g = parseGroup(head);
    if (!g || g.length !== 8) return null;
    groups = g;
  }
  if (v4tail) {
    groups[6] = (v4tail[0]! << 8) | v4tail[1]!;
    groups[7] = (v4tail[2]! << 8) | v4tail[3]!;
  }
  return groups;
}

/**
 * 该地址能不能出公网。IPv4 映射地址（::ffff:a.b.c.d）拆出 IPv4 再判；
 * IPv6 链路本地 / 唯一本地 / 组播 / 文档地址都拒掉。
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPublicIpv4(v4);
  const g = expandIpv6(ip);
  if (!g) return false;
  // ::ffff:a.b.c.d（IPv4 映射）：按 IPv4 判。
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPublicIpv4([(g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff]);
  }
  const isZero = g.every((x) => x === 0);
  if (isZero) return false; // ::（未指定）
  if (g[7] === 1 && g.slice(0, 7).every((x) => x === 0)) return false; // ::1 loopback
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 唯一本地
  if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 组播
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // 2001:db8::/32 文档
  if (g[0] === 0x64 && g[1] === 0xff9b) return false; // 64:ff9b::/96 NAT64（嵌的 IPv4 看不见，不放）
  if (g[0] === 0x2001 && g[1] === 0 && g[2] === 0) return false; // 2001::/32 Teredo
  if (g[0] === 0x2002) return false; // 2002::/16 6to4
  return true;
}

const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "x-api-key", "api-key",
]);

export interface EgressGateOptions {
  /** DNS 解析（测试可注入）；默认 dns.lookup 全地址。 */
  resolve?: ResolveFn;
  /** 建连（测试可注入）；默认 net.connect 到解析到的 IP。 */
  dial?: DialFn;
  /** 放行的端口，默认 [80, 443]。 */
  allowedPorts?: number[];
}

export class EgressGate {
  private server: Server | null = null;
  private refused = 0;
  private readonly resolve: ResolveFn;
  private readonly dial: DialFn;
  private readonly allowedPorts: Set<number>;

  constructor(opts: EgressGateOptions = {}) {
    this.resolve = opts.resolve ?? (async (host) => {
      const res = await new Promise<import("node:dns").LookupAddress[]>((resolvePromise, reject) => {
        dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolvePromise(addrs)));
      });
      return res.map((a) => a.address);
    });
    this.dial = opts.dial ?? (async (ip, port) => netConnect(port, ip));
    this.allowedPorts = new Set(opts.allowedPorts ?? EGRESS_DEFAULT_PORTS);
  }

  get refusals(): number {
    return this.refused;
  }

  /** 在 127.0.0.1 上起代理；port 不给就随机。返回 http://127.0.0.1:<port>。 */
  async listen(port = 0): Promise<string> {
    const server = createServer((req, res) => { void this.handleHttp(req, res); });
    server.on("connect", (req, socket) => { void this.handleConnect(req, socket as Socket); });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolvePromise());
    });
    this.server = server;
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("出口代理起不来：拿不到监听端口");
    return `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolvePromise) => { this.server!.close(() => resolvePromise()); });
    this.server = null;
  }

  /** 主机名解析后逐个验 IP：有一个不公开就拒（DNS 重绑定也逃不过去）。 */
  private async resolvePublic(host: string): Promise<string[] | null> {
    let addrs: string[];
    try {
      addrs = await this.resolve(host);
    } catch {
      return null;
    }
    if (!addrs.length) return null;
    if (!addrs.every((ip) => isPublicAddress(ip))) {
      this.refused += 1;
      return null;
    }
    return addrs;
  }

  private async handleConnect(req: IncomingMessage, socket: Socket): Promise<void> {
    const target = req.url ?? "";
    const m = target.match(/^([^:]+):(\d+)$/);
    if (!m) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = m[1]!;
    const port = parseInt(m[2]!, 10);
    if (!this.allowedPorts.has(port)) {
      this.refused += 1;
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const addrs = await this.resolvePublic(host);
    if (!addrs) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    let upstream: Socket;
    try {
      upstream = await this.dial(addrs[0]!, port);
    } catch {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.pipe(upstream);
    upstream.pipe(socket);
    const onErr = (): void => {
      try { socket.destroy(); } catch { /* ignore */ }
      try { upstream.destroy(); } catch { /* ignore */ }
    };
    socket.on("error", onErr);
    upstream.on("error", onErr);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 只接绝对 URI 的 http:// 请求（代理形态）；相对路径不是代理请求。
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400);
      res.end("代理只接绝对 URI 的 http:// 请求");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400);
      res.end("代理只接 http://（https 走 CONNECT 隧道）");
      return;
    }
    const port = url.port ? parseInt(url.port, 10) : 80;
    if (!this.allowedPorts.has(port)) {
      this.refused += 1;
      res.writeHead(403);
      res.end("端口不在放行列表里");
      return;
    }
    const addrs = await this.resolvePublic(url.hostname);
    if (!addrs) {
      res.writeHead(403);
      res.end("目标地址不公开，出口代理拒掉");
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      if (typeof v === "string") headers[k] = v;
    }
    headers.host = url.host;
    // createConnection 是同步的：先 dial 好，再把连好的 socket 交给它。
    let sock: Socket;
    try {
      sock = await this.dial(addrs[0]!, port);
    } catch {
      res.writeHead(502);
      res.end("上游连不上");
      return;
    }
    const upstream = httpRequest({
      method: req.method,
      headers,
      createConnection: () => sock,
    }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("上游连不上");
    });
    req.pipe(upstream);
  }
}
