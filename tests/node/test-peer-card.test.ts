// tests/node/test-peer-card.test.ts — 缺口 38：Agent 名片与加好友握手。
// 全部用假对端（本机 Bun.serve 的名片端点 + MCP 服务器）与假审查 runner，
// 不连真实对端、不花真实 token、不碰真实网关名片发布。
import { test, expect} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import { tmpdir} from "node:os";
import { join} from "node:path";
import { saveConfig} from "../../src/config.ts";
import { saveCircleBook } from "../../src/circles.ts";
import { Gateway} from "../../src/gateway.ts";
import { RunStore} from "../../src/runs.ts";
import { defaultSoul, saveSoul} from "../../src/soul.ts";
import { handleVideoCall} from "../../src/videoCall.ts";
import {
  FRIEND_CODES_FILE,
  FRIENDS_FILE,
  PEER_CARD_PATH,
  PeerCardError,
  acceptFriend,
  addFriendRequest,
  blockFriend,
  buildAgentCard,
  cardHash,
  createCircle,
  declineFriend,
  deleteCircle,
  fetchAgentCard,
  friendStatus,
  getFriendCode,
  handlePeerFriends,
  isFriend,
  loadFriendBook,
  moveFriendCircle,
  parseAgentCard,
  recordInboundRequest,
  regenerateFriendCode,
  removeFriend,
  resolveFriendForCall,
  setFriendTier,
  shareWithFriend,
  unblockFriend,
} from "../../src/peerCard.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const allowRunner = {
  async chat(): Promise<Record<string, unknown>> {
    return { choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "测试放行" }) } }] };
  },
};

function baseConfig(): Record<string, unknown> {
  return { peers: { enabled: true, list: [] }, reviewer: { enabled: true } };
}

const GOOD_CARD = {
  name: "Pilot",
  description: "帮机主把重复工作自动化",
  url: "http://127.0.0.1:18080/mcp",
  version: "0.5.3",
  skills: [{ id: "answer_question", name: "answer_question", description: "问一个问题并等回答" }],
  authentication: { schemes: ["bearer"] },
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  endpoints: { mcp: "http://127.0.0.1:18080/mcp" },
};

/** 假对端网关：只回名片（/.well-known/agent-card.json），别的路径 404。 */
function startFakeCardServer(card: unknown, status = 200): { base: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === PEER_CARD_PATH) {
        return new Response(typeof card === "string" ? card : JSON.stringify(card), { status });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
}

/** 假对端 MCP 服务器：initialize + dispatch_task 回 run_id（share 测试用）。 */
function startFakeMcpServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // 同一个假对端也回名片：share 测试里好友地址就是这台服务器。
      if (url.pathname === PEER_CARD_PATH) {
        return new Response(JSON.stringify(GOOD_CARD), { status: 200 });
      }
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) as Record<string, unknown>; } catch { return new Response("bad json", { status: 400 }); }
      const id = body.id;
      if (id === undefined || id === null) return new Response(null, { status: 202 });
      const method = body.method as string;
      const reply = (result: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id, result });
      const replyErr = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
      if (method === "initialize") {
        return reply({ protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake-peer", version: "1" } });
      }
      if (method === "tools/call") {
        const params = body.params as Record<string, unknown>;
        if (params.name === "dispatch_task") {
          return reply({ content: [{ type: "text", text: "任务已入队：run_id 20261120-120000-abcdef（模式 readonly，状态 queued）" }] });
        }
        return replyErr(-32602, `未知工具：${String(params.name)}`);
      }
      return replyErr(-32601, "Method not found");
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop() };
}

/** 造一个已握手完成的好友（request + accept），返回账本里的条目名。 */
async function makeFriend(home: string, name: string, url: string): Promise<void> {
  const config = baseConfig();
  saveConfig(home, config);
  // 登记请求须拿得出我当前的好友码（码是双方人工比对的共享口令）。
  const myCode = getFriendCode(home).code;
  await recordInboundRequest(home, config, { name, url, code: myCode, fetchDeps: { fetchFn: async (u: string) => {
    const res = await fetch(u);
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } } });
  acceptFriend(home, { name });
}

test("PeerCardTest.test_card_built_from_soul_and_mcp_tools", () => {
  const home = tmpHome("nyra-card-");
  const soul = defaultSoul("default");
  soul.identity = { name: "Kite", persona: "说话直接、有事说事。", goal: "帮机主把重复工作自动化。" };
  saveSoul(home, soul);
  const card = buildAgentCard(home, {});
  expect(card.name).toBe("Kite");
  expect(card.description).toContain("说话直接");
  expect(card.description).toContain("重复工作自动化");
  expect(card.version).toBe("0.5.4");
  expect(card.url).toBeNull();
  expect(card.endpoints.mcp).toBeNull();
  expect(card.authentication.schemes).toEqual(["bearer"]);
  expect(card.capabilities.streaming).toBe(false);
  expect(card.skills.map((s) => s.id)).toContain("answer_question");
  expect(card.skills.map((s) => s.id)).toContain("dispatch_task");
  expect(card.skills.length).toBeGreaterThan(0);
  // 配了公开地址才出现 url 与 mcp 端点。
  const withUrl = buildAgentCard(home, { peer_card: { public_url: "https://nyra.example.com/" } });
  expect(withUrl.url).toBe("https://nyra.example.com");
  expect(withUrl.endpoints.mcp).toBe("https://nyra.example.com/mcp");
  // 非法公开地址被忽略（不抛错、不写进名片）。
  const badUrl = buildAgentCard(home, { peer_card: { public_url: "ftp://x.example.com" } });
  expect(badUrl.url).toBeNull();
});

test("PeerCardTest.test_card_validation_rejects_bad_shapes", () => {
  expect(() => parseAgentCard(null)).toThrow("名片必须是 JSON 对象");
  expect(() => parseAgentCard({ description: "x", skills: [] })).toThrow("名片缺字段：name");
  expect(() => parseAgentCard({ name: "", description: "x", skills: [] })).toThrow("name 不能为空");
  expect(() => parseAgentCard({ name: "A", description: "x", skills: "nope" })).toThrow("skills 必须是列表");
  expect(() => parseAgentCard({ name: "A", description: "x", skills: [{ id: "a" }] })).toThrow("名片缺字段：name");
  expect(() => parseAgentCard({ name: "A", description: "x", skills: [], url: "ftp://x" })).toThrow("url 必须是 http");
  expect(() => parseAgentCard({ name: "A", description: "x", skills: [], authentication: { schemes: [] } })).toThrow("schemes 不能为空");
  expect(() => parseAgentCard({ name: "A", description: "x".repeat(501), skills: [] })).toThrow("太长");
  // 合法名片原样通过（多余字段忽略，不拦未来扩展）。
  const card = parseAgentCard({ ...GOOD_CARD, future_field: { a: 1 } });
  expect(card.name).toBe("Pilot");
  expect(card.skills).toHaveLength(1);
});

test("PeerCardTest.test_fetch_card_from_fake_gateway", async () => {
  const fake = startFakeCardServer(GOOD_CARD);
  try {
    const { card, hash } = await fetchAgentCard(`${fake.base}/mcp`);
    expect(card.name).toBe("Pilot");
    expect(hash).toBe(cardHash(JSON.stringify(GOOD_CARD)));
    // 对方没开名片发布（404）时报错指路。
    const closed = startFakeCardServer(GOOD_CARD, 404);
    try {
      await expect(fetchAgentCard(`${closed.base}/mcp`)).rejects.toThrow("没开名片发布");
    } finally { closed.stop(); }
    // 非法 JSON 与坏名片都拒绝。
    const badJson = startFakeCardServer("{not json");
    try {
      await expect(fetchAgentCard(`${badJson.base}/mcp`)).rejects.toThrow("不是合法 JSON");
    } finally { badJson.stop(); }
    const badCard = startFakeCardServer({ name: 123, skills: [] });
    try {
      await expect(fetchAgentCard(`${badCard.base}/mcp`)).rejects.toThrow("必须是字符串");
    } finally { badCard.stop(); }
  } finally { fake.stop(); }
});

test("PeerCardTest.test_friend_code_format_and_expiry", () => {
  const home = tmpHome("nyra-code-");
  const rec = getFriendCode(home);
  expect(rec.code).toMatch(/^NYR-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(Date.parse(rec.expires_at) - Date.parse(rec.created_at)).toBe(24 * 3600 * 1000);
  // 同一天内重复取是同一码；--regenerate 换新码；过期自动换新。
  expect(getFriendCode(home).code).toBe(rec.code);
  const rec2 = regenerateFriendCode(home);
  expect(rec2.code).not.toBe(rec.code);
  const stored = JSON.parse(readFileSync(join(home, FRIEND_CODES_FILE), "utf-8")) as { code: string; expires_at: string };
  stored.expires_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(home, FRIEND_CODES_FILE), JSON.stringify(stored));
  expect(getFriendCode(home).code).not.toBe(rec2.code);
});

test("PeerCardTest.test_handshake_request_accept_mutual", async () => {
  const home = tmpHome("nyra-hs-");
  const fake = startFakeCardServer(GOOD_CARD);
  const fetchDeps = { fetchFn: async (u: string) => {
    const res = await fetch(u);
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } };
  try {
    const config = baseConfig();
    saveConfig(home, config);
    // 未开对端协作时发请求与登记请求都拒绝。
    saveConfig(home, { peers: { enabled: false, list: [] } });
    await expect(addFriendRequest(home, { peers: { enabled: false, list: [] }, reviewer: { enabled: true } }, { name: "pilot", url: `${fake.base}/mcp`, fetchDeps })).rejects.toThrow("对端协作未开启");
    // 发请求：只记账本，不通知对方。
    const { entry } = await addFriendRequest(home, config, { name: "pilot", url: `${fake.base}/mcp`, code: "NYR-ABCD-1234", fetchDeps });
    expect(entry.outbound).toBe("sent");
    expect(entry.inbound).toBe("none");
    expect(entry.tier).toBe("readonly");
    expect(friendStatus(entry)).toContain("已发请求");
    expect(isFriend(entry)).toBe(false);
    // 登记对方请求须带码；错码拒绝；对上码后待批准。
    const myCode = getFriendCode(home).code;
    await expect(recordInboundRequest(home, config, { name: "pilot", url: `${fake.base}/mcp`, code: "NYR-WRON-G000", fetchDeps })).rejects.toThrow("好友码对不上");
    await expect(recordInboundRequest(home, config, { name: "pilot", url: `${fake.base}/mcp`, code: "not-a-code", fetchDeps })).rejects.toThrow("好友码格式不对");
    const inbound = await recordInboundRequest(home, config, { name: "pilot", url: `${fake.base}/mcp`, code: myCode, fetchDeps });
    expect(inbound.entry.inbound).toBe("pending");
    // 批准后是好友，且因我方也发过请求，状态为双向。
    const accepted = acceptFriend(home, { name: "pilot" });
    expect(accepted.inbound).toBe("accepted");
    expect(isFriend(accepted)).toBe(true);
    expect(friendStatus(accepted)).toBe("好友（双向）");
    // 再批准一次拒绝（没有待批准的请求了）。
    expect(() => acceptFriend(home, { name: "pilot" })).toThrow("没有待批准的请求");
  } finally { fake.stop(); }
});

test("PeerCardTest.test_handshake_single_sided_and_decline", async () => {
  const home = tmpHome("nyra-hs2-");
  const fake = startFakeCardServer(GOOD_CARD);
  const fetchDeps = { fetchFn: async (u: string) => {
    const res = await fetch(u);
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } };
  try {
    const config = baseConfig();
    saveConfig(home, config);
    // 只登记、不发请求：批准后是好友（单向）。
    const myCode = getFriendCode(home).code;
    await recordInboundRequest(home, config, { name: "solo", url: `${fake.base}/mcp`, code: myCode, fetchDeps });
    const accepted = acceptFriend(home, { name: "solo", circle: "default", tier: "propose" });
    expect(friendStatus(accepted)).toBe("好友");
    expect(accepted.tier).toBe("propose");
    // 另一人拒绝。
    await recordInboundRequest(home, config, { name: "nope", url: `${fake.base}/mcp`, code: myCode, fetchDeps });
    const declined = declineFriend(home, "nope");
    expect(declined.inbound).toBe("declined");
    expect(friendStatus(declined)).toBe("已拒绝");
    expect(() => declineFriend(home, "nope")).toThrow("没有待批准的请求");
  } finally { fake.stop(); }
});

test("PeerCardTest.test_block_unblock_remove", async () => {
  const home = tmpHome("nyra-blk-");
  const fake = startFakeCardServer(GOOD_CARD);
  try {
    await makeFriend(home, "pilot", `${fake.base}/mcp`);
    const blocked = blockFriend(home, "pilot");
    expect(blocked.blocked).toBe(true);
    expect(isFriend(blocked)).toBe(false);
    expect(friendStatus(blocked)).toBe("已拉黑");
    // 拉黑后发请求与登记请求都拒绝。
    const config = baseConfig();
    await expect(addFriendRequest(home, config, { name: "pilot", url: `${fake.base}/mcp`, fetchDeps: { fetchFn: async (u: string) => {
      const res = await fetch(u);
      return { ok: res.ok, status: res.status, text: () => res.text() };
    } } })).rejects.toThrow("已拉黑");
    unblockFriend(home, "pilot");
    expect(isFriend(loadFriendBook(home).friends[0])).toBe(true);
    removeFriend(home, "pilot");
    expect(loadFriendBook(home).friends).toHaveLength(0);
    expect(() => removeFriend(home, "pilot")).toThrow("好友账本里没有");
  } finally { fake.stop(); }
});

test("PeerCardTest.test_circles_create_delete_and_move", async () => {
  const home = tmpHome("nyra-cir-");
  const fake = startFakeCardServer(GOOD_CARD);
  try {
    await makeFriend(home, "pilot", `${fake.base}/mcp`);
    expect(() => createCircle(home, "default")).toThrow("默认圈");
    expect(() => createCircle(home, "bad name!")).toThrow("圈名只认");
    createCircle(home, "work");
    expect(loadFriendBook(home).circles.map((c) => c.name)).toContain("work");
    expect(() => createCircle(home, "work")).toThrow("已存在");
    moveFriendCircle(home, "pilot", "work");
    expect(loadFriendBook(home).friends[0].circle).toBe("work");
    // 圈里还有人时删不掉；移空后才能删。
    expect(() => deleteCircle(home, "work")).toThrow("里还有好友");
    moveFriendCircle(home, "pilot", "default");
    deleteCircle(home, "work");
    expect(loadFriendBook(home).circles).toHaveLength(0);
    expect(() => deleteCircle(home, "default")).toThrow("默认圈");
  } finally { fake.stop(); }
});

test("PeerCardTest.test_tier_change_and_corrupt_book", async () => {
  const home = tmpHome("nyra-tier-");
  const fake = startFakeCardServer(GOOD_CARD);
  try {
    await makeFriend(home, "pilot", `${fake.base}/mcp`);
    setFriendTier(home, "pilot", "propose");
    expect(loadFriendBook(home).friends[0].tier).toBe("propose");
    expect(() => setFriendTier(home, "pilot", "admin" as never)).toThrow("只能是 readonly 或 propose");
    // 账本损坏先备份再抛错，不静默重建。
    writeFileSync(join(home, FRIENDS_FILE), "{broken");
    expect(() => loadFriendBook(home)).toThrow("已损坏，已备份");
    expect(existsSync(join(home, FRIENDS_FILE))).toBe(false);
  } finally { fake.stop(); }
});

test("PeerCardTest.test_share_only_to_friends_via_review", async () => {
  const home = tmpHome("nyra-shr-");
  const mcpServer = startFakeMcpServer();
  const fetchDeps = { fetchFn: async (u: string) => {
    const res = await fetch(u);
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } };
  try {
    const config = baseConfig();
    saveConfig(home, config);
    // 先造一条已完成的运行（交接包的来源）。
    const store = new RunStore(join(home, "runs"));
    const state = store.create("测试任务：整理一份周报", "agent", process.cwd(), "readonly", 1, "completed_unverified");
    const runId = state.run_id;
    // 不是好友不能分享。
    await expect(shareWithFriend(home, config, { to: "ghost", runId })).rejects.toThrow("好友账本里没有");
    // 握手（好友地址就是这台又回名片、又接 MCP 的假对端）。
    await recordInboundRequest(home, config, { name: "pilot", url: mcpServer.url, code: getFriendCode(home).code, fetchDeps });
    acceptFriend(home, { name: "pilot" });
    // 缺口 34：直接写账本给 pilot 准入（不走带审计的 invite，避免冲掉既有审计断言）。
    const now = new Date().toISOString();
    saveCircleBook(home, {
      version: 1,
      circles: [{
        name: "work", description: "", created_at: now, created_by: "owner",
        members: [{ identity: "pilot", kind: "friend", invited_by: "owner", invited_at: now, channel: "test" }],
      }],
      bindings: [],
    });
    // 分享给好友：走缺口 12 的交接（假 MCP 回 run_id），只读模式。
    const results = await shareWithFriend(home, config, {
      to: "pilot", runId, deps: { reviewerRunner: allowRunner },
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("accepted");
    expect(results[0].peerRunId).toBe("20261120-120000-abcdef");
    // 拉黑后不能分享。
    blockFriend(home, "pilot");
    await expect(shareWithFriend(home, config, { to: "pilot", runId, deps: { reviewerRunner: allowRunner } })).rejects.toThrow("还不是好友");
  } finally { mcpServer.stop(); }
});

test("PeerCardTest.test_friend_events_registered_and_audited", async () => {
  const home = tmpHome("nyra-evt-");
  const fake = startFakeCardServer(GOOD_CARD);
  try {
    await makeFriend(home, "pilot", `${fake.base}/mcp`);
    blockFriend(home, "pilot");
    unblockFriend(home, "pilot");
    // 8 个新事件类型都能写进运行（EVENT_FIELDS 已注册）。
    const store = new RunStore(join(home, "runs"));
    const state = store.create("事件注册探针", "peer-card", process.cwd(), "readonly", 1, "running");
    const types: [string, Record<string, unknown>][] = [
      ["friend_requested", { peer: "pilot", card_hash: "aabbccddeeff", ok: true }],
      ["friend_request_received", { peer: "pilot", card_hash: "aabbccddeeff", code_hash: "001122334455" }],
      ["friend_accepted", { peer: "pilot", circle: "default", tier: "readonly" }],
      ["friend_declined", { peer: "pilot" }],
      ["friend_blocked", { peer: "pilot" }],
      ["friend_unblocked", { peer: "pilot" }],
      ["friend_removed", { peer: "pilot" }],
      ["friend_code_regenerated", { code_hash: "001122334455" }],
    ];
    for (const [type, fields] of types) store.appendEvent(state.run_id, type, fields);
    const events = store.readEvents(state.run_id);
    expect(events.filter((e) => e.type.startsWith("friend_")).map((e) => e.type)).toEqual(types.map(([t]) => t));
    // 对端审计里有握手记录（只记指纹，不记码本身）。
    const audit = readFileSync(join(home, "peer-audit.jsonl"), "utf-8");
    expect(audit).toContain("friend_request_received");
    expect(audit).toContain("friend_accepted");
    expect(audit).toContain("friend_blocked");
    expect(audit).not.toContain("NYR-ABCD-1234");
  } finally { fake.stop(); }
});

test("PeerCardTest.test_cli_card_code_friends_flow", async () => {
  const home = tmpHome("nyra-cli-");
  const fake = startFakeCardServer(GOOD_CARD);
  const fetchDeps = { fetchFn: async (u: string) => {
    const res = await fetch(u);
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } };
  try {
    const config = baseConfig();
    saveConfig(home, config);
    // card：打印名片 JSON + 发布状态。
    let code = await handlePeerFriends(["card"], home);
    expect(code).toBe(0);
    // code：打印好友码。
    code = await handlePeerFriends(["code"], home);
    expect(code).toBe(0);
    // 未加 --yes 时批准被拦。
    await recordInboundRequest(home, config, { name: "pilot", url: `${fake.base}/mcp`, code: getFriendCode(home).code, fetchDeps });
    code = await handlePeerFriends(["accept", "pilot"], home);
    expect(code).toBe(2);
    // 加 --yes 后批准成功；friends 列出双向好友（我方没发过请求，是单向好友）。
    code = await handlePeerFriends(["accept", "pilot", "--yes"], home);
    expect(code).toBe(0);
    code = await handlePeerFriends(["friends"], home);
    expect(code).toBe(0);
    code = await handlePeerFriends(["friend", "pilot"], home);
    expect(code).toBe(0);
    // 未知子命令回用法，退出 2。
    code = await handlePeerFriends(["bogus"], home);
    expect(code).toBe(2);
    // accept 不存在的请求报错。
    code = await handlePeerFriends(["accept", "ghost", "--yes"], home);
    expect(code).toBe(1);
  } finally { fake.stop(); }
});

test("PeerCardTest.test_gateway_serves_card_only_when_published", async () => {
  const home = tmpHome("nyra-gw-");
  const soul = defaultSoul("default");
  soul.identity = { name: "Kite", persona: "说话直接。", goal: "帮机主干活。" };
  saveSoul(home, soul);
  const gw = new Gateway({
    home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "full",
    config: { peer_card: { publish: false }, fallback_enabled: false },
  });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    // 未发布：当不存在（404），不泄露端点。
    expect((await fetch(`${base}${PEER_CARD_PATH}`)).status).toBe(404);
  } finally { await gw.stop(); }
  const gw2 = new Gateway({
    home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "full",
    config: { peer_card: { publish: true, public_url: "https://nyra.example.com" }, fallback_enabled: false },
  });
  const info2 = await gw2.start();
  try {
    const base = `http://127.0.0.1:${info2.port}`;
    const res = await fetch(`${base}${PEER_CARD_PATH}`);
    expect(res.status).toBe(200);
    const card = await res.json() as { name: string; url: string; skills: { id: string }[] };
    expect(card.name).toBe("Kite");
    expect(card.url).toBe("https://nyra.example.com");
    expect(card.skills.map((s) => s.id)).toContain("answer_question");
  } finally { await gw2.stop(); }
});

test("PeerCardTest.test_video_call_friend_only", async () => {
  const home = tmpHome("nyra-vid-");
  const fake = startFakeCardServer(GOOD_CARD);
  try {
    const config = baseConfig();
    saveConfig(home, config);
    // 不是好友：--friend 拒绝呼叫（须先握手）。
    let code = await handleVideoCall(["start", "--friend", "pilot", "--yes"], home);
    expect(code).toBe(2);
    // 握手后：--friend 能建通话（peer 即好友名，仍须 --yes）。
    await makeFriend(home, "pilot", `${fake.base}/mcp`);
    code = await handleVideoCall(["start", "--friend", "pilot", "--yes"], home);
    expect(code).toBe(0);
    // 拉黑后：--friend 再次拒绝。
    blockFriend(home, "pilot");
    code = await handleVideoCall(["start", "--friend", "pilot", "--yes"], home);
    expect(code).toBe(2);
    // resolveFriendForCall 直调：陌生人与拉黑都抛错。
    expect(() => resolveFriendForCall(home, "ghost")).toThrow("不是好友");
    expect(() => resolveFriendForCall(home, "pilot")).toThrow("还不是好友");
  } finally { fake.stop(); }
});
