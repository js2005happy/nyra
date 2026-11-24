// tests/node/test-hermes-h1h6h5.test.ts — Hermes/TalosBrain 借鉴 H1/H6/H5：
// H1 网关逐回合记客户端（审计 + 最近客户端账本 + 会话 last_client）；
// H6 删除/禁用是墓碑（插件、信任圈）；H5 凭证类型纪律（OAuth token 不当 API Key）。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";
import { describeGatewayClient, listGatewayClients, recordGatewayRound } from "../../src/gatewayClients.ts";
import { AUDIT_SOURCES } from "../../src/costCaps.ts";
import {
  PluginError, installPlugin, uninstallPlugin, listPlugins, listPluginTombstones,
  setPluginStatus, loadLock,
} from "../../src/plugins.ts";
import { createCircle, deleteCircle, loadCircleBook } from "../../src/circles.ts";
import { loadSkills } from "../../src/skills.ts";
import { validateKey, validateProviderKey, setKey, getFileKey } from "../../src/keystore.ts";
import { Vault, vaultPath, getCredential } from "../../src/vault.ts";
import { resolveProvider } from "../../src/config.ts";
import { Provider, type ResolvedProvider } from "../../src/providers.ts";
import { expectPerms } from "./fsPerms.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ---------- H1：客户端描述 ----------

test("H1: describeGatewayClient 只记 id，不记名字/邮箱", () => {
  expect(describeGatewayClient("owner")).toEqual({ client: "owner", kind: "owner" });
  expect(describeGatewayClient({ id: "d1", name: "Pixel 9" })).toEqual({ client: "device:d1", kind: "device" });
  expect(describeGatewayClient({ id: "a1", email: "someone@example.com" })).toEqual({ client: "account:a1", kind: "account" });
  // apiAuth 把 user 角色账号折成字符串 "account"（上一行已覆盖）；没有 id 的
  // 记录无从归属，返回 null（调用方不记）。
  expect(describeGatewayClient({ role: "user" })).toBeNull();
  expect(describeGatewayClient(null)).toBeNull();
  expect(describeGatewayClient({ role: "device" })).toBeNull();
});

// ---------- H1：审计 + 账本 ----------

test("H1: recordGatewayRound 写审计行（12 位哈希、不记绝对路径）+ 账本（0600、按 last_seen 倒序、上限 200）", () => {
  const home = tmp("nyra-h1-");
  expect(recordGatewayRound(home, { sessionId: "s1", client: "owner", kind: "owner", channel: "session" })).toBe(true);
  expect(recordGatewayRound(home, { sessionId: "s1", client: "device:d1", kind: "device", channel: "session" })).toBe(true);
  expect(recordGatewayRound(home, { sessionId: "group-r1", client: "device:d1", kind: "device", channel: "group" })).toBe(true);
  const audit = readFileSync(join(home, "gateway-audit.jsonl"), "utf-8");
  const lines = audit.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.length).toBe(3);
  expect(lines[0].type).toBe("round");
  expect(lines[0].actor).toBe("owner");
  expect(lines[0].session_id).toBe("s1");
  expect(lines[0].channel).toBe("session");
  expect(lines[2].channel).toBe("group");
  expect(lines[2].session_id).toBe("group-r1");
  for (const l of lines) {
    expect(l.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(l)).not.toContain(home);
  }
  expectPerms(join(home, "gateway-audit.jsonl"), 0o600);
  expectPerms(join(home, "gateway-clients.json"), 0o600);
  const clients = listGatewayClients(home);
  expect(clients.length).toBe(2);
  // 三条回合落在同一毫秒里：last_seen 打平后按客户端名排，device:d1 在前（输出稳定）。
  expect(clients[0].client).toBe("device:d1");
  expect(clients[0].rounds).toBe(2);
  expect(clients[1].client).toBe("owner");
  expect(clients[1].rounds).toBe(1);
  // 账本进 SIEM 导出（第 12 个来源）。
  expect(AUDIT_SOURCES.some((s) => s.file === "gateway-audit.jsonl" && s.label === "gateway")).toBe(true);
  expect(AUDIT_SOURCES.length).toBe(12);
});

// ---------- H1：网关集成 ----------

test("H1: 网关集成——配对设备发消息后审计行与 /api/clients、owner 回合、sessionsView 的 last_client", async () => {
  const home = tmp("nyra-h1gw-");
  const gw = new Gateway({
    home, workdir: tmp("nyra-h1gw-wd-"), host: "0.0.0.0", port: 0, mode: "auto",
    providerFactory: () => fakeProvider([{ content: "ok" }, { content: "ok2" }]) as never,
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const sid = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: h, body: "{}" })).json() as { id: string }).id;
    // owner 先发一回合，等它跑完再让设备发（同会话一次只跑一个回合，409 会挡住第二条）。
    expect((await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "你好" }) })).status).toBe(202);
    for (let i = 0; i < 100; i++) {
      const s = await (await fetch(`${base}/api/sessions/${sid}`, { headers: h })).json() as { status: string };
      if (s.status === "done") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 配对一台设备，用它再发一回合。
    const started = gw.startPairing() as { code: string };
    const dev = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel" }) })).json() as { token: string };
    const dh = { "X-Nyra-Token": dev.token, "Content-Type": "application/json" };
    expect((await fetch(`${base}/api/sessions/${sid}/messages`, { method: "POST", headers: dh, body: JSON.stringify({ text: "手机上再问一句" }) })).status).toBe(202);
    // 审计行里两条回合，客户端分得清；账本里两条客户端。
    const lines = readFileSync(join(home, "gateway-audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].actor).toBe("owner");
    expect(lines[1].actor).toMatch(/^device:/);
    expect(lines[1].session_id).toBe(sid);
    const clients = await (await fetch(`${base}/api/clients`, { headers: h })).json() as { clients: { client: string; kind: string; rounds: number }[] };
    expect(clients.clients.length).toBe(2);
    expect(clients.clients.find((c) => c.client === "owner")?.rounds).toBe(1);
    expect(clients.clients.find((c) => c.kind === "device")?.rounds).toBe(1);
    // 配对设备查客户端清单 → 403（只有机主能看）。
    expect((await fetch(`${base}/api/clients`, { headers: dh })).status).toBe(403);
    // 会话列表带 last_client：最后发回合的是那台设备。
    const sessions = await (await fetch(`${base}/api/sessions`, { headers: h })).json() as { sessions: { id: string; last_client: string | null }[] };
    expect(sessions.sessions.find((s) => s.id === sid)?.last_client).toMatch(/^device:/);
  } finally { await gw.stop(); }
});

// ---------- H6：插件墓碑 ----------

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: 测试技能 ${name}\nwhen: 测试时\nkeywords: 测试\n---\n指令：${name}。\n`;
}

function makePluginDir(skills: string[], opts: { name?: string; version?: string } = {}): string {
  const dir = join(tmpdir(), `nyra-h1h6h5-src-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "skills"), { recursive: true });
  for (const s of skills) writeFileSync(join(dir, "skills", `${s}.md`), skillFile(s), "utf-8");
  const manifest = { name: opts.name ?? "demo-plugin", version: opts.version ?? "1.0.0", description: "演示插件", author: "test", license: "MIT", skills };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return dir;
}

function pluginHome(): string {
  const h = join(tmpdir(), `nyra-h1h6h5-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(h, { recursive: true });
  return h;
}

test("H6: 停用的插件重装/升级保持停用；卸载写墓碑，重装须显式 --force，force 后墓碑清掉", () => {
  const h = pluginHome();
  const v1 = makePluginDir(["alpha-skill"], { version: "1.0.0" });
  installPlugin(h, v1);
  setPluginStatus(h, "demo-plugin", "disabled");
  expect(listPlugins(h)[0].status).toBe("disabled");
  // 重装/升级不许悄悄打开。
  const v2 = makePluginDir(["alpha-skill"], { version: "1.1.0" });
  const up = installPlugin(h, v2);
  expect(up.upgraded).toBe(true);
  expect(listPlugins(h)[0].status).toBe("disabled");
  // 卸载：锁文件里没了，墓碑留下来。
  uninstallPlugin(h, "demo-plugin");
  expect(listPlugins(h)).toEqual([]);
  const tombs = listPluginTombstones(h);
  expect(tombs.length).toBe(1);
  expect(tombs[0].name).toBe("demo-plugin");
  expect(tombs[0].files_removed).toContain("skills/alpha-skill.md");
  expect(loadLock(h).tombstones?.["demo-plugin"]).toBeDefined();
  // 悄悄重装被拦住；改状态也被拦住。
  expect(() => installPlugin(h, v1)).toThrow(/墓碑/);
  expect(() => setPluginStatus(h, "demo-plugin", "active")).toThrow(/墓碑/);
  expect(listPlugins(h)).toEqual([]);
  // 显式重装：清掉墓碑，装回来。
  const re = installPlugin(h, v1, { force: true });
  expect(re.name).toBe("demo-plugin");
  expect(listPluginTombstones(h)).toEqual([]);
  expect(listPlugins(h)[0].status).toBe("active");
});

test("H6: 信任圈删了写墓碑；同名重建是显式决定（清墓碑 + 记 circle_recreated）", () => {
  const home = tmp("nyra-h6c-");
  createCircle(home, "work", { description: "工作圈" });
  deleteCircle(home, "work");
  const book = loadCircleBook(home);
  expect(book.circles).toEqual([]);
  expect(book.deleted?.length).toBe(1);
  expect(book.deleted?.[0].name).toBe("work");
  expect(book.deleted?.[0].by).toBe("owner");
  // 删过的圈能重建（用户显式决定），墓碑清掉。
  const again = createCircle(home, "work");
  expect(again.name).toBe("work");
  expect(loadCircleBook(home).deleted ?? []).toEqual([]);
  expect(loadCircleBook(home).circles.map((c) => c.name)).toEqual(["work"]);
});

// ---------- H6：技能停用回归 ----------

test("H6: 停用的技能重装同名技能文件后仍被排除（只加回归测试，loadSkills 本来就按 disabled 过滤）", () => {
  const home = tmp("nyra-h6s-");
  const dir = join(home, "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "my-skill.md"), skillFile("my-skill"), "utf-8");
  expect(loadSkills([dir]).map((s) => s.name)).toContain("my-skill");
  // 停用后重装同名文件：仍被排除。
  writeFileSync(join(dir, "my-skill.md"), skillFile("my-skill"), "utf-8");
  expect(loadSkills([dir], { disabled: ["my-skill"] }).map((s) => s.name)).not.toContain("my-skill");
});

// ---------- H5：凭证类型纪律 ----------

test("H5: validateProviderKey 拒收 OAuth token 形状的串（各家前缀都拦）", () => {
  for (const bad of [
    "gho_abcdefghijklmnop", "ghp_abcdefghijklmnop", "github_pat_11ABCDEFG0",
    "ya29.a0AfH6SMBxxxxxxxx", "1//0e1234567890abcdef", "xoxb-1234567890-abcdef",
    "xoxp-1234567890-abcdef", "xoxa-1234567890-abcdef", "xoxr-1234567890-abcdef",
  ]) {
    expect(() => validateProviderKey(bad)).toThrow(/OAuth token/);
  }
  expect(validateProviderKey("sk-test-key-1234")).toBe("sk-test-key-1234");
  // 通用 validateKey 只做形状校验，不拦 OAuth 形状——Bot 电脑凭证存的
  // 就是任意账号 secret（见下一条回归测试）。
  expect(validateKey("ghp_test1234")).toBe("ghp_test1234");
});

test("H5: 通用 setKey 不拦 OAuth 形状（Bot 电脑凭证就是 GitHub PAT 这类任意账号 secret）", () => {
  const home = tmp("nyra-h5sk-");
  const saved = process.env.NYRA_VAULT_PASSWORD;
  delete process.env.NYRA_VAULT_PASSWORD;
  try {
    const r = setKey("BOTCMP_TEST_GITHUB", "ghp_test1234", home);
    expect(r.stored).toBe("file");
    expect(getFileKey("BOTCMP_TEST_GITHUB", home)).toBe("ghp_test1234");
  } finally {
    if (saved !== undefined) process.env.NYRA_VAULT_PASSWORD = saved;
  }
});

test("H5: 模型流量只发 Authorization: Bearer 一个认证头（不发 x-api-key / x-goog-api-key）", async () => {
  const seen: Record<string, string>[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return Response.json({ choices: [{ message: { role: "assistant", content: "hi" } }] });
  }) as typeof fetch;
  try {
    const p = new Provider({
      name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash",
      apiKey: "sk-test", auth: "env", connectorName: null, keySource: "env", hasKey: true,
      envKey: "DEEPSEEK_API_KEY",
      preset: { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-flash", envKey: "DEEPSEEK_API_KEY" },
    } as ResolvedProvider);
    const out = await p.chat([{ role: "user", content: "hi" }]);
    // chat 原样回 OpenAI 兼容 JSON（不做归一化），这里只确认请求发得出去了。
    const choices = (out as { choices?: { message?: { content?: string } }[] }).choices;
    expect(choices?.[0]?.message?.content).toBe("hi");
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(seen.length).toBe(1);
  expect(seen[0].authorization).toBe("Bearer sk-test");
  expect("x-api-key" in seen[0]).toBe(false);
  expect("x-goog-api-key" in seen[0]).toBe(false);
});

test("H5: resolveProvider 不拾取密码箱里异名条目（github-oauth 之类永远不当模型 Key）", () => {
  const home = tmp("nyra-h5-");
  const savedKey = process.env.DEEPSEEK_API_KEY;
  const savedPw = process.env.NYRA_VAULT_PASSWORD;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    // 密码箱里放一个 GitHub OAuth token（异名条目），再看 deepseek 拿不拿得到 Key。
    // 直接用 Vault API 写条目：setKey 只认 env var 形状的名字（github-oauth
    // 带连字符进不去），而 Vault 条目名本来就允许连字符。
    const v = new Vault(vaultPath(home));
    v.init("correct horse battery");
    expect(v.unlock("correct horse battery")).toBe(true);
    v.add("github-oauth", "gho_abcdefghijklmnop");
    process.env.NYRA_VAULT_PASSWORD = "correct horse battery";
    expect(getCredential("github-oauth", home)).toBe("gho_abcdefghijklmnop");
    const resolved = resolveProvider({ home, config: { provider: "deepseek" } });
    expect(resolved.apiKey).toBeNull();
    expect(resolved.hasKey).toBe(false);
  } finally {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey; else delete process.env.DEEPSEEK_API_KEY;
    if (savedPw !== undefined) process.env.NYRA_VAULT_PASSWORD = savedPw; else delete process.env.NYRA_VAULT_PASSWORD;
  }
});

test("H6: 插件墓碑与好友授权是两套独立记录（卸载插件不碰好友授权文件）", () => {
  // friendGrants 的 revoked 标志本来就是墓碑语义（见 test-friend-grants 的
  // 既有覆盖）；这里只确认插件卸载不建/不改好友授权文件——两套记录互不干扰。
  const h = pluginHome();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  uninstallPlugin(h, "demo-plugin");
  expect(listPluginTombstones(h).length).toBe(1);
  expect(existsSync(join(h, "friends.json"))).toBe(false);
});
