// tests/node/test-mobile-pwa-v2.test.ts — 手机 PWA v2：配对、Codex 式审批规则、拒绝反馈、token 鉴权、
// 二维码、图标。对应 src/approvalRules.ts、src/qrcode.ts、src/webuiMobile.ts 与 gateway 的接线。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { DeviceRegistry, PairingError } from "../../src/pairing.ts";
import {
  suggestPrefix, prefixMatches, prefixAllowed, isSimpleCommand, suggestionFor, RuleStore, SessionRules,
  rejectionMessage, RULES_FILENAME,
} from "../../src/approvalRules.ts";
import { checkApproval, newToolContext, ToolError, findApprovalRule } from "../../src/tools.ts";
import { encode, toSvg, toTerminal } from "../../src/qrcode.ts";
import { MOBILE_ICON_ROUTES, MARK_CURSOR, MARK_CIRCLE, MARK_STROKE, MOBILE_V2_MANIFEST } from "../../src/webuiMobile.ts";
import { markSvg } from "../../src/brandMark.ts";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------- 配对 ---
test("pairing: 6 位码 5 分钟过期", () => {
  let now = 1_000_000;
  const reg = new DeviceRegistry(join(tmp("nyra-pair-"), "devices.json"), { clock: () => now });
  const { code, expires_in } = reg.startPairing();
  expect(/^\d{6}$/.test(code)).toBe(true);
  expect(expires_in).toBe(300);
  now += 299;
  expect(reg.pairingStatus().active).toBe(true);
  now += 2;
  expect(reg.pairingStatus().active).toBe(false);
  expect(() => reg.redeem(code, "手机")).toThrow(PairingError);
});

test("pairing: 一次性，用过即失效", () => {
  const reg = new DeviceRegistry(join(tmp("nyra-pair-"), "devices.json"));
  const { code } = reg.startPairing();
  const dev = reg.redeem(code, "Pixel 7");
  expect(dev.token.length).toBeGreaterThan(30);
  expect(() => reg.redeem(code, "另一台")).toThrow(/没有进行中的配对/);
});

test("pairing: 错 5 次作废，正确码也不再能用", () => {
  const reg = new DeviceRegistry(join(tmp("nyra-pair-"), "devices.json"));
  const { code } = reg.startPairing();
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) expect(() => reg.redeem(wrong)).toThrow("配对码错误");
  expect(() => reg.redeem(wrong)).toThrow(/错误次数过多/);
  expect(() => reg.redeem(code)).toThrow(PairingError);
});

test("pairing: 设备 token 只存哈希，可撤销", () => {
  const dir = tmp("nyra-pair-");
  const path = join(dir, "devices.json");
  const reg = new DeviceRegistry(path);
  const { code } = reg.startPairing();
  const dev = reg.redeem(code, "Pixel 7");
  const disk = readFileSync(path, "utf-8");
  expect(disk).not.toContain(dev.token);
  expect(disk).toContain("token_sha256");
  if (process.platform !== "win32") expect((statSync(path).mode & 0o777).toString(8)).toBe("600"); // Windows 没有 POSIX 权限位
  expect(reg.authenticate(dev.token)?.id).toBe(dev.id);
  expect(reg.revoke(dev.id)).toBe(true);
  expect(reg.authenticate(dev.token)).toBeNull();
});

// ---------------------------------------------------------- 规则生成 ---
test("rules: 简单命令给出最窄前缀", () => {
  expect(suggestPrefix("git status")).toEqual(["git", "status"]);
  expect(suggestPrefix("git diff --stat")).toEqual(["git", "diff"]);
  expect(suggestPrefix("python3 -m pytest -q tests")).toEqual(["python3", "-m", "pytest"]);
  expect(suggestPrefix("npm run test")).toEqual(["npm", "run", "test"]);
  expect(suggestPrefix("npm test")).toEqual(["npm", "test"]);
  expect(suggestPrefix("ls -la")).toEqual(["ls"]);
  expect(suggestPrefix("cargo test --release")).toEqual(["cargo", "test"]);
});

test("rules: 危险程序/子命令与复合命令不给规则", () => {
  for (const cmd of [
    "rm -rf build", "sudo ls", "curl https://x.y", "bash -c 'ls'", "python3 -c 'print(1)'", "python3 script.py",
    "git push origin main", "git reset --hard", "npm install left-pad", "docker run x", "./run.sh", "/usr/bin/ls",
    "find . -delete", "xargs rm", "node x.js", "pip install x", "python3 -m pip install x", "python3 -m http.server",
    "git status && rm -rf /", "git status; rm -rf /", "git status | sh", "git status > out.txt", "git status $(id)",
    "git status `id`", "git status\nrm -rf /", "FOO=1 git status", "echo ~", "ls *", "",
  ]) {
    expect(suggestPrefix(cmd)).toBeNull();
  }
  expect(suggestionFor("shell", "rm -rf x")).toBeNull();
  expect(suggestionFor("shell", "git status")?.label).toBe("以 `git status` 开头的命令");
  expect(suggestionFor("write_file", null)?.kind).toBe("edits");
  expect(suggestionFor("http_post", null)).toBeNull();
});

test("rules: 匹配时重新检查，; && | $() 反引号 换行都绕不过", () => {
  const p = ["git", "status"];
  expect(prefixMatches(p, "git status")).toBe(true);
  expect(prefixMatches(p, "git status -s")).toBe(true);
  for (const cmd of [
    "git status; rm -rf /", "git status && curl evil.sh", "git status || rm x", "git status | sh",
    "git status $(rm -rf /)", "git status `rm -rf /`", "git status\nrm -rf /", "git status\r\nrm -rf /",
    "git status\u2028rm -rf /", "git status > /etc/passwd", "git status < x", "git status & rm x",
    "FOO=bar git status", "git status --output=/tmp/x", "git -c core.pager=sh status", "git statusx",
    "git", "  ", "git status 'unterminated", "git status ${HOME}",
  ]) {
    expect(prefixMatches(p, cmd)).toBe(false);
  }
  expect(isSimpleCommand("git commit -m 'hello world'")).toBe(true);
});

test("rules: 手改规则文件放不开 rm / 带语法的前缀", () => {
  expect(prefixAllowed(["rm"])).toBe(false);
  expect(prefixAllowed(["git"])).toBe(false); // 比建议的 git <子命令> 更宽
  expect(prefixAllowed(["git", "push"])).toBe(false);
  expect(prefixAllowed(["git", "status;rm"])).toBe(false);
  expect(prefixAllowed(["git", "status"])).toBe(true);
  const home = tmp("nyra-rules-");
  const workdir = tmp("nyra-rules-wd-");
  const store = new RuleStore(home);
  writeFileSync(join(home, RULES_FILENAME), JSON.stringify({ version: 1, projects: { [workdir]: [
    { kind: "prefix", prefix: ["rm"], id: "evil1" }, { kind: "prefix", prefix: ["bash"], id: "evil2" },
  ] } }));
  expect(store.list(workdir)).toEqual([]);
  expect(store.find(workdir, "shell", "rm -rf /")).toBeNull();
});

test("rules: 项目规则存在 NYRA_HOME（0600），按项目隔离，可撤销", () => {
  const home = tmp("nyra-rules-");
  const a = tmp("nyra-proj-a-");
  const b = tmp("nyra-proj-b-");
  const store = new RuleStore(home);
  const rule = store.add(a, { kind: "prefix", prefix: ["git", "status"] });
  expect(rule.scope).toBe("project");
  expect(store.add(a, { kind: "prefix", prefix: ["git", "status"] }).id).toBe(rule.id); // 去重
  expect(store.find(a, "shell", "git status -s")?.id).toBe(rule.id);
  expect(store.find(b, "shell", "git status -s")).toBeNull();
  if (process.platform !== "win32") expect((statSync(join(home, RULES_FILENAME)).mode & 0o777).toString(8)).toBe("600");
  expect(() => store.add(a, { kind: "prefix", prefix: ["rm"] })).toThrow();
  expect(store.remove(rule.id)).toBe(true);
  expect(store.find(a, "shell", "git status")).toBeNull();
  const session = new SessionRules();
  const s = session.add({ kind: "prefix", prefix: ["npm", "run", "test"] });
  expect(session.find("shell", "npm run test -- --watch")?.id).toBe(s.id);
  expect(session.find("shell", "npm run build")).toBeNull();
  expect(session.remove(s.id)).toBe(true);
});

// ------------------------------------------------ 审批门接线（tools.ts） ---
test("checkApproval: 允许并不再询问（本会话）后同前缀不再问，复合命令照样问", async () => {
  const workdir = tmp("nyra-ca-wd-");
  const home = tmp("nyra-ca-home-");
  const asked: string[] = [];
  let answer: unknown = { approved: true, scope: "session" };
  const ctx = newToolContext({
    workdir, home, mode: "auto", interactive: true,
    approveFn: (_t, _s, d) => { asked.push(String(d?.command)); return answer as boolean; },
  });
  ctx.sessionRules = new SessionRules();
  await checkApproval(ctx, "shell", "git status", { command: "git status", cwd: workdir });
  expect(asked).toEqual(["git status"]);
  answer = true;
  await checkApproval(ctx, "shell", "git status -s", { command: "git status -s", cwd: workdir });
  expect(asked.length).toBe(1); // 命中规则，没再问
  await checkApproval(ctx, "shell", "x", { command: "git status && rm -rf /", cwd: workdir });
  await checkApproval(ctx, "shell", "x", { command: "git status $(rm -rf /)", cwd: workdir });
  expect(asked.length).toBe(3);
  // 新会话（新的 SessionRules）不继承本会话规则。
  const ctx2 = newToolContext({ workdir, home, mode: "auto", interactive: true, approveFn: () => { asked.push("ctx2"); return true; } });
  await checkApproval(ctx2, "shell", "git status", { command: "git status", cwd: workdir });
  expect(asked.at(-1)).toBe("ctx2");
});

test("checkApproval: 本项目规则跨会话生效；readonly 不受规则影响", async () => {
  const workdir = tmp("nyra-ca-wd-");
  const home = tmp("nyra-ca-home-");
  const ctx = newToolContext({ workdir, home, mode: "auto", interactive: true, approveFn: () => ({ approved: true, scope: "project" }) as unknown as boolean });
  await checkApproval(ctx, "shell", "make test", { command: "make test", cwd: workdir });
  let asked = 0;
  const ctx2 = newToolContext({ workdir, home, mode: "auto", interactive: true, approveFn: () => { asked++; return true; } });
  await checkApproval(ctx2, "shell", "make test", { command: "make test V=1", cwd: workdir });
  expect(asked).toBe(0);
  expect(findApprovalRule(ctx2, "shell", "make test")?.scope).toBe("project");
  const ro = newToolContext({ workdir, home, mode: "readonly", interactive: true, approveFn: () => true });
  await expect(checkApproval(ro, "shell", "make test", { command: "make test", cwd: workdir })).rejects.toThrow(/只读模式/);
});

test("checkApproval: 拒绝反馈原样带回给 agent", async () => {
  const workdir = tmp("nyra-ca-wd-");
  const ctx = newToolContext({ workdir, mode: "auto", interactive: true, approveFn: () => ({ approved: false, feedback: "先跑 bun test，别删文件" }) as unknown as boolean });
  let err: unknown = null;
  try { await checkApproval(ctx, "shell", "rm -rf build", { command: "rm -rf build", cwd: workdir }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ToolError);
  expect(String((err as Error).message)).toContain("先跑 bun test，别删文件");
  expect(rejectionMessage("")).toBe("用户拒绝执行");
  expect(rejectionMessage("x".repeat(5000)).length).toBeLessThan(2100);
});

// ------------------------------------------------------- 网关端到端 ---
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function shellStep(id: string, command: string) {
  return { content: "", toolCalls: [{ id, type: "function", function: { name: "shell", arguments: JSON.stringify({ command }) } }] };
}

test("gateway: 无 token / 错 token 一律 403；设备 token 可审批", async () => {
  const home = tmp("nyra-gw2-");
  const gw = new Gateway({ home, workdir: tmp("nyra-gw2-wd-"), host: "0.0.0.0", port: 0, mode: "auto", config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    for (const path of ["/api/approvals", "/api/sessions", "/api/rules", "/api/info"]) {
      expect((await fetch(base + path)).status).toBe(403);
      expect((await fetch(base + path, { headers: { "X-Nyra-Token": "nope" } })).status).toBe(403);
    }
    expect((await fetch(`${base}/api/approvals/0123456789abcdef`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/rules/abc/revoke`, { method: "POST", body: "{}" })).status).toBe(403);
    const started = gw.startPairing() as { code: string; qr_svg: string };
    expect(started.qr_svg).toContain("<svg");
    const paired = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel 7" }) })).json() as { token: string };
    expect((await fetch(`${base}/api/approvals`, { headers: { "X-Nyra-Token": paired.token } })).status).toBe(200);
    expect((await fetch(`${base}/api/rules`, { headers: { "X-Nyra-Token": paired.token } })).status).toBe(200);
  } finally { await gw.stop(); }
});

test("gateway: 手机审批卡——允许并记住（本会话）、无建议时拒绝记规则、拒绝反馈回到模型", async () => {
  const home = tmp("nyra-gw3-");
  const workdir = tmp("nyra-gw3-wd-");
  const seen: unknown[][] = [];
  const base = fakeProvider([
    shellStep("c1", "git status"),
    shellStep("c2", "git status -s"),
    shellStep("c3", "echo hi && rm -rf nothing-here"),
    { content: "好的，我换个做法。" },
  ]);
  const provider = { ...base, async chat(messages: unknown[], tools?: unknown, timeout?: number) { seen.push(JSON.parse(JSON.stringify(messages))); return base.chat(messages, tools, timeout); } };
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, mode: "auto", providerFactory: () => provider as never, config: { mcp_enabled: false, fallback_enabled: false } });
  const info = await gw.start();
  try {
    const url = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const sid = (await (await fetch(`${url}/api/sessions`, { method: "POST", headers: h, body: "{}" })).json() as { id: string }).id;
    await fetch(`${url}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "看看仓库状态" }) });
    type A = { id: string; command: string; suggestion: { label: string } | null };
    const first = await waitFor(async () => ((await (await fetch(`${url}/api/approvals`, { headers: h })).json()) as { approvals: A[] }).approvals[0]);
    expect(first.command).toBe("git status");
    expect(first.suggestion?.label).toBe("以 `git status` 开头的命令");
    expect((await fetch(`${url}/api/approvals/${first.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true, scope: "everywhere" }) })).status).toBe(400);
    expect((await fetch(`${url}/api/approvals/${first.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true, scope: "session" }) })).status).toBe(200);
    // 第二条 git status -s 命中本会话规则不再挂起；第三条复合命令挂起且没有建议规则。
    const third = await waitFor(async () => ((await (await fetch(`${url}/api/approvals`, { headers: h })).json()) as { approvals: A[] }).approvals[0]);
    expect(third.command).toBe("echo hi && rm -rf nothing-here");
    expect(third.suggestion).toBeNull();
    const rules = await (await fetch(`${url}/api/rules?session=${sid}`, { headers: h })).json() as { rules: { id: string; label: string; scope: string }[] };
    expect(rules.rules.map((r) => r.label)).toEqual(["以 `git status` 开头的命令"]);
    const noRule = await fetch(`${url}/api/approvals/${third.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true, scope: "session" }) });
    expect(noRule.status).toBe(400);
    expect((await fetch(`${url}/api/approvals/${third.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: false, feedback: "别删东西，先跑测试" }) })).status).toBe(200);
    await waitFor(async () => ((await (await fetch(`${url}/api/sessions/${sid}`, { headers: h })).json()) as { status: string }).status === "done");
    const lastCall = JSON.stringify(seen.at(-1));
    expect(lastCall).toContain("别删东西，先跑测试");
    expect(base.calls).toBe(4);
    // 撤销规则后列表为空。
    expect((await fetch(`${url}/api/rules/${rules.rules[0].id}/revoke`, { method: "POST", headers: h, body: "{}" })).status).toBe(200);
    const after = await (await fetch(`${url}/api/rules?session=${sid}`, { headers: h })).json() as { rules: unknown[] };
    expect(after.rules).toEqual([]);
  } finally { await gw.stop(); }
});

// ---------------------------------------------------------- 二维码/图标 ---
test("qrcode: 版本选择与渲染", () => {
  const m = encode("http://192.168.1.23:8765/m#pair=123456", "M");
  expect(m.length).toBe(29); // 版本 3
  expect(m[0].slice(0, 7).every(Boolean)).toBe(true); // 定位图形
  expect(toSvg(m)).toContain("<path");
  const art = toTerminal(m, { ansi: false });
  expect(art.split("\n").length).toBe(Math.ceil((29 + 4) / 2));
  expect(encode("x".repeat(300)).length).toBeGreaterThan(29);
});

function pngInfo(buf: Uint8Array): { w: number; h: number; colorType: number; pixel: (x: number, y: number) => number[] } {
  const b = Buffer.from(buf);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const colorType = b[25];
  const idat: Buffer[] = [];
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.subarray(off + 4, off + 8).toString("ascii");
    if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  return { w, h, colorType, pixel: (x, y) => [...raw.subarray(y * (w * bpp + 1) + 1 + x * bpp, y * (w * bpp + 1) + 1 + x * bpp + bpp)] };
}

test("icons: manifest 192/512 any + maskable、apple 180、favicon；几何与 nyra-mark.svg 一致", async () => {
  const svg = readFileSync(join(import.meta.dir, "..", "..", "docs", "assets", "nyra-mark.svg"), "utf-8");
  // 主文件由 src/brandMark.ts 生成：圆盘 r40 + 光标外扩 MARK_STROKE/2 的镂空（evenodd）。
  expect(svg.trim()).toBe(markSvg());
  expect(svg).toContain(`A${MARK_CIRCLE.r} ${MARK_CIRCLE.r} 0 1 0`);
  expect(svg).toContain(`A${MARK_STROKE / 2} ${MARK_STROKE / 2} 0 0`);
  expect(MARK_CURSOR[0]).toEqual([40, 31]);
  const purposes = MOBILE_V2_MANIFEST.icons.map((i) => `${i.sizes}:${i.purpose}`);
  expect(purposes).toEqual(["192x192:any", "512x512:any", "192x192:maskable", "512x512:maskable"]);
  const gw = new Gateway({ home: tmp("nyra-icons-"), workdir: "/tmp", host: "127.0.0.1", port: 0, config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    for (const [path, spec] of Object.entries(MOBILE_ICON_ROUTES)) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const png = pngInfo(new Uint8Array(await res.arrayBuffer()));
      expect(png.w).toBe(spec.size);
      expect(png.h).toBe(spec.size);
      const corner = png.pixel(0, 0);
      if (spec.kind === "maskable" || spec.kind === "apple") expect(corner[3]).toBe(255); // 铺满不透明
      else expect(corner[3]).toBe(0); // any/favicon 透明底
    }
    // 应用图标 = 紫色团子方块：纯紫 + 两只深色竖胶囊眼。
    const any = pngInfo(new Uint8Array(await (await fetch(`${base}/m/icon-512.png`)).arrayBuffer()));
    expect(any.pixel(256, 80)).toEqual([0x86, 0x88, 0xff, 255]);
    expect(any.pixel(256, 272)).toEqual([0x86, 0x88, 0xff, 255]);
    expect(any.pixel(185, 272)).toEqual([0x14, 0x14, 0x14, 255]);
    expect(any.pixel(327, 272)).toEqual([0x14, 0x14, 0x14, 255]);
    // maskable / apple：满版不透明（系统加遮罩），两只眼都在 80% 安全圆内。
    const mask = pngInfo(new Uint8Array(await (await fetch(`${base}/m/icon-maskable-512.png`)).arrayBuffer()));
    expect(mask.pixel(0, 0).slice(0, 3)).toEqual([0x86, 0x88, 0xff]);
    expect(Math.hypot(0.7175 - 0.5, 0.6469 - 0.5)).toBeLessThan(0.4); // 右眼最外角离中心 < 安全圆半径
    const fav = await fetch(`${base}/m/favicon.svg`);
    const favSvg = await fav.text();
    expect(favSvg).toContain('fill="#8688ff"');
    expect(favSvg).not.toContain("linearGradient");
    const page = await (await fetch(`${base}/m`)).text();
    expect(page).toContain('rel="apple-touch-icon"');
    expect(page).toContain("允许并不再询问");
    expect(page).toContain("Allow and don't ask again");
    expect(page).not.toMatch(/angel/i);
  } finally { await gw.stop(); }
});

// ---------------------------------------------------------- 第 2 阶段 ---
test("settings: 手机切全权要二次确认标记，电脑端不受影响；规则可在手机上撤销", async () => {
  const home = tmp("nyra-gw4-");
  const gw = new Gateway({ home, workdir: tmp("nyra-gw4-wd-"), host: "0.0.0.0", port: 0, mode: "auto", config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const started = gw.startPairing() as { code: string };
    const dev = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel 7" }) })).json() as { token: string };
    const h = { "X-Nyra-Token": dev.token };
    expect((await fetch(`${base}/api/mode`, { method: "POST", headers: h, body: JSON.stringify({ mode: "full" }) })).status).toBe(400);
    expect(gw.mode).toBe("auto");
    expect((await fetch(`${base}/api/mode`, { method: "POST", headers: h, body: JSON.stringify({ mode: "full", confirm: "full" }) })).status).toBe(200);
    expect(gw.mode).toBe("full");
    expect((await fetch(`${base}/api/mode`, { method: "POST", headers: h, body: JSON.stringify({ mode: "readonly" }) })).status).toBe(200);
    expect((await fetch(`${base}/api/mode`, { method: "POST", headers: { "X-Nyra-Token": gw.token }, body: JSON.stringify({ mode: "full" }) })).status).toBe(200);
    const rule = new RuleStore(home).add(gw.workdir, { kind: "prefix", prefix: ["make", "test"] });
    const list = await (await fetch(`${base}/api/rules`, { headers: h })).json() as { rules: { id: string; scope: string }[] };
    expect(list.rules.map((r) => r.id)).toEqual([rule.id]);
    expect((await fetch(`${base}/api/rules/${rule.id}/revoke`, { method: "POST", headers: h, body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/api/rules/${rule.id}/revoke`, { method: "POST", headers: h, body: "{}" })).status).toBe(404);
  } finally { await gw.stop(); }
});

test("splash: 原 Nyra 入场动画，只在手机主屏幕独立窗口播放、不能点击跳过，减少动态效果时只淡入终帧", async () => {
  const gw = new Gateway({ home: tmp("nyra-splash-"), workdir: "/tmp", host: "127.0.0.1", port: 0, config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const page = await (await fetch(`http://127.0.0.1:${info.port}/m`)).text();
    expect(page).toContain("(display-mode: standalone)");
    expect(page).toContain("navigator.standalone");
    expect(page).toContain("prefers-reduced-motion: reduce");
    // 原 Nyra splash：0–2.95 s 动画、终帧停到 3.8 s 再淡出；不能点击跳过。
    expect(page).toContain("SPLASH_END=2.95, SPLASH_HOLD=3.8");
    expect(page).toContain("function frame(t,lang)");
    expect(page).not.toContain("finish('skipped')");
    expect(page).not.toMatch(/addEventListener\('(click|touchstart)'/);
    expect(page).toContain("sessionStorage");
    expect(page).toContain("API Key 请在电脑上输入");
  } finally { await gw.stop(); }
});

// ---------------------------------------------------------- 设计稿改版 ---
test("mobile v2 design: 中英文案键齐全、四个标签、字体同源加载且 CSP 不放开 font-src", async () => {
  const { MESSAGES } = await import("../../src/i18n.ts");
  const zhKeys = Object.keys(MESSAGES.zh).filter((k) => k.startsWith("m."));
  const enKeys = Object.keys(MESSAGES.en).filter((k) => k.startsWith("m."));
  expect(zhKeys.length).toBeGreaterThan(50);
  expect(enKeys.sort()).toEqual(zhKeys.sort());
  for (const k of zhKeys) { expect(MESSAGES.zh[k as keyof typeof MESSAGES.zh]).not.toMatch(/angel/i); expect(MESSAGES.en[k as keyof typeof MESSAGES.en]).not.toMatch(/angel/i); }
  const gw = new Gateway({ home: tmp("nyra-m2-"), workdir: "/tmp", host: "127.0.0.1", port: 0, config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/m`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("font-src");
    const page = await res.text();
    for (const tab of ["threads", "automations", "skills", "settings"]) expect(page).toContain(`data-tab="${tab}"`);
    expect(page).toContain("new FontFace(");
    expect(page).toContain("prefers-color-scheme:dark");
    // 页面不含任何 token
    expect(page).not.toContain(gw.token);
    for (const f of ["inter-400", "inter-600", "jbm-400"]) {
      const font = await fetch(`${base}/m/fonts/${f}.woff`);
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toBe("font/woff");
      const head = new Uint8Array(await font.arrayBuffer()).slice(0, 4);
      expect(String.fromCharCode(...head)).toBe("wOFF");
    }
    expect((await fetch(`${base}/m/fonts/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/m/fonts/other.woff`)).status).toBe(404);
    // 会话列表带 status 字段（手机状态点用）
    const sid = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "X-Nyra-Token": gw.token }, body: "{}" })).json() as { id: string }).id;
    const list = await (await fetch(`${base}/api/sessions`, { headers: { "X-Nyra-Token": gw.token } })).json() as { sessions: { id: string; status: string }[] };
    expect(list.sessions.find((s) => s.id === sid)?.status).toBe("idle");
  } finally { await gw.stop(); }
});
