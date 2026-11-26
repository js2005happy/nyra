// tests/node/test-bot-box.test.ts — M4（OpenMausBot 的 bot-box 纵深借鉴）：
// 出口代理（只放公网地址）+ 凭证经纪人（沙箱只拿短命 token）+ seccomp 拒单。
// 纯逻辑与注入测试全平台跑；bwrap 真跑的测试只在 Linux 跑（平台守卫）。
import { test, expect } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, createServer as netServer, type Server as NetServer, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGate, isPublicAddress } from "../../src/egressGate.ts";
import { CredentialBroker } from "../../src/credentialBroker.ts";
import { buildBwrapArgs, runSandboxed } from "../../src/sandbox.ts";
import { SECCOMP_DENIED_SYSCALLS, seccompProgram, seccompSupported } from "../../src/seccomp.ts";

const IS_LINUX = process.platform === "linux";

test("BotBoxTest.test_seccomp_program_shape", () => {
  const prog = seccompProgram();
  const n = SECCOMP_DENIED_SYSCALLS.length;
  expect(prog.length).toBe((4 + 2 * n + 1) * 8);
  const code = (i: number): number => prog.readUInt16LE(i * 8);
  const k = (i: number): number => prog.readUInt32LE(i * 8 + 4);
  expect(code(0)).toBe(0x20); // LD W ABS
  expect(k(0)).toBe(4); // arch
  expect(code(1)).toBe(0x15); // JEQ
  expect(k(1)).toBe(0xc000003e); // AUDIT_ARCH_X86_64
  expect(code(3)).toBe(0x20);
  expect(k(3)).toBe(0); // nr
  expect(code(prog.length / 8 - 1)).toBe(0x06); // RET
  expect(k(prog.length / 8 - 1)).toBe(0x7fff0000); // ALLOW
  // 每个拒单号都有一条 JEQ，后面跟一条 RET EPERM。
  for (const s of SECCOMP_DENIED_SYSCALLS) {
    let found = false;
    for (let i = 4; i < prog.length / 8 - 1; i += 2) {
      if (code(i) === 0x15 && k(i) === s.nr && code(i + 1) === 0x06 && k(i + 1) === 0x00050001) found = true;
    }
    expect(found).toBe(true);
  }
  // 点名几个关键号在里面；clone3/unshare 刻意不在里面（见 seccomp.ts 注释）。
  const names = new Set(SECCOMP_DENIED_SYSCALLS.map((s) => s.name));
  for (const must of ["mount", "umount2", "bpf", "perf_event_open", "userfaultfd", "setns", "ptrace", "seccomp"]) {
    expect(names.has(must)).toBe(true);
  }
  for (const mustNot of ["clone3", "unshare", "openat", "execve"]) {
    expect(names.has(mustNot)).toBe(false);
  }
});

test("BotBoxTest.test_seccomp_supported_matches_platform", () => {
  expect(seccompSupported()).toBe(process.platform === "linux" && process.arch === "x64");
});

test("BotBoxTest.test_is_public_address_table", () => {
  for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    expect(isPublicAddress(ip)).toBe(true);
  }
  for (const ip of [
    "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1",
    "169.254.169.254", "0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "100.64.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.0.1",
  ]) {
    expect(isPublicAddress(ip)).toBe(false);
  }
  expect(isPublicAddress("not-an-ip")).toBe(false);
});

function collectSocket(sock: Socket, until: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`等 ${until} 超时，收到：${buf}`)), timeoutMs);
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      if (buf.includes(until)) {
        clearTimeout(timer);
        resolvePromise(buf);
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.on("close", () => { clearTimeout(timer); resolvePromise(buf); });
  });
}

test("BotBoxTest.test_egress_gate_connect_and_refusals", async () => {
  // 上游：收到什么回 PONG（隧道通没通就看它）。
  const upstream: NetServer = netServer((s) => {
    s.on("data", () => { s.write("PONG"); });
  });
  await new Promise<void>((r) => { upstream.listen(0, "127.0.0.1", () => r()); });
  const upstreamPort = (upstream.address() as { port: number }).port;
  const gate = new EgressGate({
    resolve: async (host) => {
      if (host === "example.com") return ["93.184.216.34"];
      if (host === "rebind.example.com") return ["93.184.216.34", "10.0.0.5"];
      if (host === "127.0.0.1") return ["127.0.0.1"];
      throw new Error("no such host");
    },
    dial: async (_ip, _port) => netConnect(upstreamPort, "127.0.0.1"),
  });
  const url = await gate.listen(0);
  const port = parseInt(new URL(url).port, 10);
  try {
    // 公网 CONNECT 打通隧道。
    const sock = netConnect(port, "127.0.0.1");
    const first = collectSocket(sock, "\r\n\r\n");
    sock.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(await first).toContain("200");
    const pong = collectSocket(sock, "PONG");
    sock.write("PING");
    expect(await pong).toContain("PONG");
    sock.destroy();
    // 内网地址拒掉并计数。
    const sock2 = netConnect(port, "127.0.0.1");
    const r2 = collectSocket(sock2, "\r\n\r\n");
    sock2.write("CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n");
    expect(await r2).toContain("403");
    sock2.destroy();
    // DNS 重绑定（一个公网一个内网）也拒掉。
    const sock3 = netConnect(port, "127.0.0.1");
    const r3 = collectSocket(sock3, "\r\n\r\n");
    sock3.write("CONNECT rebind.example.com:443 HTTP/1.1\r\nHost: rebind.example.com:443\r\n\r\n");
    expect(await r3).toContain("403");
    sock3.destroy();
    // 不在放行端口列表里的拒掉。
    const sock4 = netConnect(port, "127.0.0.1");
    const r4 = collectSocket(sock4, "\r\n\r\n");
    sock4.write("CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n");
    expect(await r4).toContain("403");
    sock4.destroy();
    expect(gate.refusals).toBe(3);
  } finally {
    await gate.close();
    await new Promise<void>((r) => { upstream.close(() => r()); });
  }
});

test("BotBoxTest.test_egress_gate_absolute_uri_strips_credentials", async () => {
  let seenHeaders: Record<string, string | string[] | undefined> = {};
  const upstream: Server = createServer((req, res) => {
    seenHeaders = req.headers as Record<string, string | string[] | undefined>;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => { upstream.listen(0, "127.0.0.1", () => r()); });
  const upstreamPort = (upstream.address() as { port: number }).port;
  const gate = new EgressGate({
    resolve: async () => ["93.184.216.34"],
    dial: async (_ip, _port) => netConnect(upstreamPort, "127.0.0.1"),
  });
  const url = await gate.listen(0);
  const port = parseInt(new URL(url).port, 10);
  try {
    const body = await new Promise<string>((resolvePromise, reject) => {
      const req = httpRequest({
        host: "127.0.0.1", port, method: "GET", path: "http://example.com/hello",
        headers: { authorization: "Bearer CLIENT-SECRET", "x-api-key": "secret" },
      }, (res) => {
        let b = "";
        res.on("data", (d: Buffer) => { b += d.toString("utf-8"); });
        res.on("end", () => resolvePromise(b));
      });
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("ok");
    expect(seenHeaders.authorization).toBeUndefined();
    expect(seenHeaders["x-api-key"]).toBeUndefined();
    expect(seenHeaders.host).toBe("example.com");
  } finally {
    await gate.close();
    await new Promise<void>((r) => { upstream.close(() => r()); });
  }
});

test("BotBoxTest.test_credential_broker_mint_verify_revoke", () => {
  let now = 1000;
  const broker = new CredentialBroker({ now: () => now });
  broker.registerGrant("gmail", { upstream: "https://gmail.googleapis.com", headers: { authorization: "Bearer REAL" } });
  expect(() => broker.registerGrant("bad", { upstream: "http://example.com", headers: {} })).toThrow("须是 https");
  const t1 = broker.mint("bot-a", ["gmail"]);
  expect(t1.startsWith("nyra_brk_")).toBe(true);
  expect(broker.verify(t1)?.botId).toBe("bot-a");
  expect(broker.verify("nyra_brk_nope")).toBeNull();
  expect(broker.verify(t1.slice(0, -2) + "xx")).toBeNull();
  const t2 = broker.mint("bot-a", ["gmail"], { ttlMs: 100 });
  const t3 = broker.mint("bot-b", ["gmail"]);
  expect(broker.liveTokens).toBe(3);
  now += 200;
  expect(broker.verify(t2)).toBeNull();
  expect(broker.pruneExpired()).toBe(1);
  expect(broker.revokeForBot("bot-a")).toBe(1);
  expect(broker.verify(t1)).toBeNull();
  expect(broker.verify(t3)?.botId).toBe("bot-b");
  expect(broker.revoke(t3)).toBe(true);
  expect(broker.verify(t3)).toBeNull();
  expect(() => broker.mint("bot-a", ["no-such-grant"])).toThrow("还没登记");
});

test("BotBoxTest.test_credential_broker_http_forwarding", async () => {
  let seenAuth: string | string[] | undefined;
  let seenPath = "";
  const upstream: Server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => { upstream.listen(0, "127.0.0.1", () => r()); });
  const upstreamPort = (upstream.address() as { port: number }).port;
  const broker = new CredentialBroker();
  broker.registerGrant("api", { upstream: `http://127.0.0.1:${upstreamPort}`, headers: { authorization: "Bearer REAL" } });
  const token = broker.mint("bot-a", ["api"]);
  const brokerServer: Server = createServer((req, res) => { void broker.serveBrokerRequest(req, res); });
  await new Promise<void>((r) => { brokerServer.listen(0, "127.0.0.1", () => r()); });
  const brokerPort = (brokerServer.address() as { port: number }).port;
  const fetchVia = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> => new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: brokerPort, method: "GET", path, headers }, (res) => {
      let b = "";
      res.on("data", (d: Buffer) => { b += d.toString("utf-8"); });
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    // 客户端自己带的凭证头被剥掉，grant 的真头加上。
    const ok = await fetchVia(`/b/${token}/api/v1/things?x=1`, { authorization: "Bearer CLIENT" });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("ok");
    expect(seenAuth).toBe("Bearer REAL");
    expect(seenPath).toBe("/v1/things?x=1");
    // 假 token / 没授权的 grant 一律 401。
    expect((await fetchVia(`/b/nyra_brk_nope/api/v1/things`)).status).toBe(401);
    expect((await fetchVia(`/b/${token}/nope/v1/things`)).status).toBe(401);
    expect((await fetchVia(`/other/path`)).status).toBe(404);
  } finally {
    await new Promise<void>((r) => { brokerServer.close(() => r()); });
    await new Promise<void>((r) => { upstream.close(() => r()); });
  }
});

test("BotBoxTest.test_bwrap_args_seccomp_fd", () => {
  const args = buildBwrapArgs("echo hi", { workdir: "/tmp", allowNet: false, mode: "workspace-write", seccompFd: 3 });
  expect(args).toContain("--seccomp");
  expect(args[args.indexOf("--seccomp") + 1]).toBe("3");
  const plain = buildBwrapArgs("echo hi", { workdir: "/tmp", allowNet: false, mode: "workspace-write" });
  expect(plain).not.toContain("--seccomp");
});

test("BotBoxTest.test_runsandboxed_seccomp_blocks_mount", async () => {
  if (!IS_LINUX) return;
  const workdir = mkdtempSync(join(tmpdir(), "nyra-botbox-"));
  try {
    mkdirSync(join(workdir, "mnt"));
    // 日常命令照常跑。
    const ok = await runSandboxed("echo hi", { workdir, allowNet: false, mode: "workspace-write", seccomp: true });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("hi");
    // 没 seccomp 时，user ns 里挂 tmpfs 是允许的（bwrap 盒子内行为）。
    // 但不是所有 Linux 主机都允许无特权挂载 tmpfs（GitHub 运行器上 mount 直接以 32 失败），
    // 这种环境下对照组本身不成立，跳过对比，不把环境限制误判为产品回归。
    // 失败原因写进日志：上次 CI 只留了 Expected 0 / Received 32，没留 stderr，查不出原因。
    const plain = await runSandboxed("mount -t tmpfs tmpfs ./mnt && echo mounted", { workdir, allowNet: false, mode: "workspace-write" });
    if (plain.code !== 0) {
      console.log(`[bot-box] plain tmpfs mount not permitted here (code=${plain.code}, stderr=${plain.stderr.trim()}), skipping seccomp contrast`);
      return;
    }
    expect(plain.stdout).toContain("mounted");
    // 有 seccomp 时 mount(2) 直接 EPERM（mount 命令以非零退出码失败）。
    const blocked = await runSandboxed("mount -t tmpfs tmpfs ./mnt; echo code=$?", { workdir, allowNet: false, mode: "workspace-write", seccomp: true });
    expect(blocked.code).toBe(0);
    expect(blocked.stdout).not.toContain("code=0");
    expect(blocked.stderr).toMatch(/operation not permitted|permission denied/i);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("BotBoxTest.test_runsandboxed_egress_proxy_env", async () => {
  if (!IS_LINUX) return;
  const workdir = mkdtempSync(join(tmpdir(), "nyra-botbox-"));
  try {
    const res = await runSandboxed("echo $http_proxy $https_proxy", {
      workdir, allowNet: true, mode: "workspace-write",
      egressProxy: "http://127.0.0.1:18080",
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("http://127.0.0.1:18080");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
