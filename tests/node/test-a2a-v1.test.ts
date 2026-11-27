// tests/node/test-a2a-v1.test.ts — 十年清单第 6 项：A2A v1.0 对齐
// （Agent Card v1.0 + JWS signatures[] + JCS 规范化 + 任务信封 v1.0）。
// 全部用临时 home 与假 runner / 假 fetch，不连真实对端、不调真实模型。
import { test, expect } from "bun:test";
import { createHash, createSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../../src/vault.ts";
import {
  buildAgentCard,
  fetchAgentCard,
  parseAgentCard,
} from "../../src/peerCard.ts";
import {
  generateSigningKeypair,
  signAgentCard,
  signAgentCardV1,
  verifySignedCard,
  canonicalizeJson,
  canonicalCardHash,
  saveSigningKey,
  CARD_SIGNATURE_TTL_S,
} from "../../src/cardSignature.ts";
import {
  A2A_PROTOCOL_VERSION,
  buildA2aAgentCard,
  createA2aServerToken,
  dispatchA2aRpc,
  a2aBaseUrl,
  loadA2aTasks,
  type A2aServerDeps,
  type A2aServerToken,
} from "../../src/a2a.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** 一张素的 v1.0 名片（buildAgentCard 的输出，没签名）。 */
function v1Card(home: string): Record<string, unknown> {
  return buildAgentCard(home, { peer_card: { public_url: "https://peer.example.com" } }) as unknown as Record<string, unknown>;
}

function b64url(input: string | Buffer): string {
  return Buffer.isBuffer(input) ? input.toString("base64url") : Buffer.from(input, "utf-8").toString("base64url");
}

/** 假 runner：直接回固定文本，不调模型。 */
function okRunner(text: string): A2aServerDeps["agentRunner"] {
  return async (_home, _task, opts) => ({
    taskId: opts.taskId,
    contextId: opts.contextId,
    text,
    textChars: text.length,
    toolCalls: [],
    proposals: [],
    spentUsd: null,
    error: "",
  });
}

function v1Message(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "ROLE_USER", messageId: "msg-v1", parts: [{ text, mediaType: "text/plain" }], ...extra };
}

async function sendV1(
  home: string,
  token: A2aServerToken,
  text: string,
  deps?: A2aServerDeps,
  extraParams: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await dispatchA2aRpc(home, {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: { message: v1Message(text), ...extraParams },
  }, { token, baseUrl: a2aBaseUrl(home), deps });
  return res as Record<string, unknown>;
}

test("a2a-v1 card schema: buildAgentCard 是 v1.0 形状（没顶层 protocolVersion/url/authentication/endpoints）", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const card = buildAgentCard(home, { peer_card: { public_url: "https://peer.example.com" } });
    expect(card.agentId.length).toBeGreaterThan(0);
    expect(card.supportedInterfaces).toHaveLength(1);
    expect(card.supportedInterfaces[0]).toEqual({ url: "https://peer.example.com", protocolBinding: "JSONRPC", protocolVersion: "1.0" });
    expect((card as unknown as Record<string, unknown>).protocolVersion).toBeUndefined();
    expect((card as unknown as Record<string, unknown>).url).toBeUndefined();
    expect((card as unknown as Record<string, unknown>).authentication).toBeUndefined();
    expect((card as unknown as Record<string, unknown>).endpoints).toBeUndefined();
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, stateTransitionHistory: false, extendedAgentCard: false });
    expect(card.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } });
    expect(card.security).toEqual([{ bearer: [] }]);
    expect(card.skills.length).toBeGreaterThan(0);
    expect(card.skills[0].tags).toEqual([]);
    expect(card.skills[0].inputModes).toEqual(["text"]);
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 card schema: A2A 名片把服务端地址放 supportedInterfaces[0]，stateTransitionHistory 开", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const card = buildA2aAgentCard(home, {}, "http://127.0.0.1:8767");
    const ifaces = card.supportedInterfaces as { url: string; protocolBinding: string; protocolVersion: string }[];
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].url).toBe("http://127.0.0.1:8767");
    expect(ifaces[0].protocolBinding).toBe("JSONRPC");
    expect(ifaces[0].protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(A2A_PROTOCOL_VERSION).toBe("1.0");
    const caps = card.capabilities as Record<string, unknown>;
    expect(caps.streaming).toBe(true);
    expect(caps.stateTransitionHistory).toBe(true);
    expect(caps.extendedAgentCard).toBe(false);
    expect(typeof card.contract).toBe("object");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 JCS: 键顺序不影响规范化结果与名片哈希", () => {
  expect(canonicalizeJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  expect(canonicalizeJson([{ z: 1, a: 2 }, "x"])).toBe('[{"a":2,"z":1},"x"]');
  const cardA = { name: "X", description: "d", version: "1" };
  const cardB = { version: "1", description: "d", name: "X" };
  expect(canonicalCardHash(cardA)).toBe(canonicalCardHash(cardB));
  expect(() => canonicalizeJson({ f: () => 1 })).toThrow("不能规范化");
});

test("a2a-v1 signature: signAgentCardV1 + verifySignedCard 往返验过", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const kp = generateSigningKeypair();
    const card = v1Card(home);
    const sig = signAgentCardV1(card, kp);
    expect(typeof sig.protected).toBe("string");
    expect(typeof sig.signature).toBe("string");
    expect(sig.header.alg).toBe("ES256");
    expect(sig.header.exp - sig.header.iat).toBe(CARD_SIGNATURE_TTL_S);
    const signed = { ...card, signatures: [{ protected: sig.protected, signature: sig.signature, header: sig.header }], public_key: kp.publicJwk };
    const verified = verifySignedCard(signed);
    expect(verified.status).toBe("verified");
    expect(verified.keyFp).toBeTruthy();
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 signature: 篡改过的 v1.0 名片验不过", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const kp = generateSigningKeypair();
    const card = v1Card(home);
    const sig = signAgentCardV1(card, kp);
    const tampered = { ...card, description: "被人改过", signatures: [{ protected: sig.protected, signature: sig.signature, header: sig.header }], public_key: kp.publicJwk };
    expect(verifySignedCard(tampered).status).toBe("invalid");
    expect(verifySignedCard(tampered).reason).toMatch("对不上");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 signature: 过期的 v1.0 签名验不过", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const kp = generateSigningKeypair();
    const card = v1Card(home);
    const nowSec = Math.floor(Date.now() / 1000);
    const sig = signAgentCardV1(card, kp, { now: () => (nowSec - CARD_SIGNATURE_TTL_S - 60) * 1000 });
    const signed = { ...card, signatures: [{ protected: sig.protected, signature: sig.signature, header: sig.header }], public_key: kp.publicJwk };
    const verified = verifySignedCard(signed);
    expect(verified.status).toBe("invalid");
    expect(verified.reason).toMatch("过期");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 signature: 没带公钥、空 signatures[] 都算 invalid，不是 absent", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const kp = generateSigningKeypair();
    const card = v1Card(home);
    const sig = signAgentCardV1(card, kp);
    const noKey = { ...card, signatures: [{ protected: sig.protected, signature: sig.signature, header: sig.header }] };
    expect(verifySignedCard(noKey).status).toBe("invalid");
    const empty = { ...card, signatures: [], public_key: kp.publicJwk };
    expect(verifySignedCard(empty).status).toBe("invalid");
    expect(verifySignedCard(empty).reason).toMatch("空的 signatures");
    // 两样都没带才是 absent（老版本对方）。
    expect(verifySignedCard(card).status).toBe("absent");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 signature: 老版紧凑 JWS 还能验过（老对方的卡不丢），包括老版 JSON.stringify 哈希", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const kp = generateSigningKeypair();
    const card = v1Card(home);
    // 现行签发方式（规范化哈希）。
    const sig = signAgentCard(card, kp);
    const signed = { ...card, signature: sig.jws, public_key: sig.publicKey };
    expect(verifySignedCard(signed).status).toBe("verified");
    // 老版签发方式（JSON.stringify 哈希）：手工按老办法签一张，照样要认。
    const unsigned: Record<string, unknown> = { ...card };
    const hash = createHash("sha256").update(JSON.stringify(unsigned), "utf-8").digest("hex");
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "ES256", kid: kp.kid, typ: "agent-card+jws" };
    const payload = { iss: "nyra", card_hash: hash, iat: now, exp: now + CARD_SIGNATURE_TTL_S };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signer = createSign("SHA256");
    signer.update(input, "utf-8");
    signer.end();
    const raw = signer.sign({ key: kp.privatePem, dsaEncoding: "ieee-p1363" });
    const legacySigned = { ...card, signature: `${input}.${b64url(raw)}`, public_key: kp.publicJwk };
    expect(verifySignedCard(legacySigned).status).toBe("verified");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 signature: 开了签名且密码箱里有钥匙时，双份签名都发出、都验过", () => {
  const home = tmpHome("nyra-a2a-v1-");
  const prevPw = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "pw123456";
  try {
    const vault = new Vault(join(home, "vault.json"));
    vault.init("pw123456");
    const kp = generateSigningKeypair();
    saveSigningKey(home, kp, "pw123456");
    const card = buildAgentCard(home, { peer_card: { signing: true, public_url: "https://peer.example.com" } });
    expect(card.signatures).toHaveLength(1);
    expect(typeof card.signature).toBe("string");
    expect(verifySignedCard(card as unknown as Record<string, unknown>).status).toBe("verified");
    const a2aCard = buildA2aAgentCard(home, { peer_card: { signing: true } }, "http://127.0.0.1:8767");
    expect((a2aCard.signatures as unknown[]).length).toBe(1);
    expect(typeof a2aCard.signature).toBe("string");
    expect(verifySignedCard(a2aCard).status).toBe("verified");
  } finally {
    if (prevPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prevPw;
    cleanup(home);
  }
});

test("a2a-v1 signature: 开了签名但密码箱里没钥匙时发素名片，不报错、不假装签过", () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const card = buildAgentCard(home, { peer_card: { signing: true, public_url: "https://peer.example.com" } });
    expect(card.signatures).toBeUndefined();
    expect(card.signature).toBeUndefined();
    expect(verifySignedCard(card as unknown as Record<string, unknown>).status).toBe("absent");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 fetch: requireSignature 时没签名的卡拒绝、签过的卡放行", async () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const unsignedText = JSON.stringify(v1Card(home));
    const fetchDepsUnsigned = { fetchFn: async (_u: string) => ({ ok: true, status: 200, text: async () => unsignedText }) };
    await expect(fetchAgentCard("https://peer.example.com", fetchDepsUnsigned, undefined, { requireSignature: true }))
      .rejects.toThrow("没签名");
    // 不要求签名时照样拉，结论标 absent。
    const plain = await fetchAgentCard("https://peer.example.com", fetchDepsUnsigned);
    expect(plain.verified.status).toBe("absent");
    // 签过的卡放行。
    const kp = generateSigningKeypair();
    const card = v1Card(home);
    const sig = signAgentCardV1(card, kp);
    const signedText = JSON.stringify({ ...card, signatures: [{ protected: sig.protected, signature: sig.signature, header: sig.header }], public_key: kp.publicJwk });
    const fetchDepsSigned = { fetchFn: async (_u: string) => ({ ok: true, status: 200, text: async () => signedText }) };
    const ok = await fetchAgentCard("https://peer.example.com", fetchDepsSigned, undefined, { requireSignature: true });
    expect(ok.verified.status).toBe("verified");
    expect(ok.card.name).toBe((card as Record<string, unknown>).name);
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 envelope: message/send 用 v1.0 信封往返（ROLE_USER、{text} part、message 上带 taskId/contextId）", async () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const { record } = createA2aServerToken(home, "v1-client");
    const res = await dispatchA2aRpc(home, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: v1Message("v1 任务", { contextId: "ctx-v1" }) },
    }, { token: record, baseUrl: a2aBaseUrl(home), deps: { agentRunner: okRunner("v1 答完了") } });
    expect(res.error).toBeUndefined();
    const task = res.result as Record<string, unknown>;
    expect(task.contextId).toBe("ctx-v1");
    expect((task.status as Record<string, unknown>).state).toBe("TASK_STATE_COMPLETED");
    expect(typeof task.createdAt).toBe("string");
    expect(typeof task.lastModified).toBe("string");
    const artifacts = task.artifacts as { parts: { text: string; mediaType: string }[] }[];
    expect(artifacts[0].parts[0]).toEqual({ text: "v1 答完了", mediaType: "text/plain" });
    const history = task.history as { role: string; parts: { text: string }[] }[];
    expect(history[0].role).toBe("ROLE_USER");
    expect(history[1].role).toBe("ROLE_AGENT");
    // message 上带 taskId 能续跑同一任务。
    const taskId = task.id as string;
    const second = await dispatchA2aRpc(home, {
      jsonrpc: "2.0",
      id: 2,
      method: "message/send",
      params: { message: v1Message("再问一句", { taskId }) },
    }, { token: record, baseUrl: a2aBaseUrl(home), deps: { agentRunner: okRunner("第二轮") } });
    const task2 = second.result as Record<string, unknown>;
    expect(task2.id).toBe(taskId);
    expect((task2.artifacts as unknown[]).length).toBe(2);
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 lifecycle: runner 抛错变 TASK_STATE_FAILED；取消变 TASK_STATE_CANCELED", async () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const { record } = createA2aServerToken(home, "v1-life");
    const baseUrl = a2aBaseUrl(home);
    const failing: A2aServerDeps = {
      agentRunner: async () => { throw new Error("模型挂了"); },
    };
    const failed = await sendV1(home, record, "会失败的任务", failing);
    expect(((failed.result as Record<string, unknown>).status as Record<string, unknown>).state).toBe("TASK_STATE_FAILED");
    // 取消：先让一轮挂起，再取消。
    const hanging: A2aServerDeps = {
      agentRunner: async (_h, _t, opts) => {
        await new Promise<void>((resolve) => {
          if (opts.signal.aborted) resolve();
          else opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { taskId: opts.taskId, contextId: opts.contextId, text: "被取消了", textChars: 4, toolCalls: [], proposals: [], spentUsd: null, error: "" };
      },
    };
    const sending = sendV1(home, record, "慢慢跑", hanging);
    let taskId = "";
    for (let i = 0; i < 50 && !taskId; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const running = loadA2aTasks(home).find((t) => t.status.state === "working");
      if (running) taskId = running.id;
    }
    expect(taskId).toBeTruthy();
    const cancelled = await dispatchA2aRpc(home, { jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: taskId } }, { token: record, baseUrl });
    expect(((cancelled?.result as Record<string, unknown>).status as Record<string, unknown>).state).toBe("TASK_STATE_CANCELED");
    const done = await sending;
    expect(((done.result as Record<string, unknown>).status as Record<string, unknown>).state).toBe("TASK_STATE_CANCELED");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 list: 游标分页（pageSize + nextCursor），坏游标报 -32602", async () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const { record } = createA2aServerToken(home, "v1-list");
    const baseUrl = a2aBaseUrl(home);
    const deps = { agentRunner: okRunner("ok") };
    await sendV1(home, record, "一", deps);
    await sendV1(home, record, "二", deps);
    await sendV1(home, record, "三", deps);
    const page1 = await dispatchA2aRpc(home, { jsonrpc: "2.0", id: 1, method: "tasks/list", params: { pageSize: 2 } }, { token: record, baseUrl });
    const result1 = page1?.result as Record<string, unknown>;
    expect((result1.tasks as unknown[]).length).toBe(2);
    expect(typeof result1.nextCursor).toBe("string");
    const page2 = await dispatchA2aRpc(home, { jsonrpc: "2.0", id: 2, method: "tasks/list", params: { pageSize: 2, cursor: result1.nextCursor } }, { token: record, baseUrl });
    const result2 = page2?.result as Record<string, unknown>;
    expect((result2.tasks as unknown[]).length).toBe(1);
    expect(result2.nextCursor).toBeUndefined();
    const bad = await dispatchA2aRpc(home, { jsonrpc: "2.0", id: 3, method: "tasks/list", params: { cursor: "!!!not-base64url!!!" } }, { token: record, baseUrl });
    expect((bad?.error as Record<string, unknown>).code).toBe(-32602);
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 errors: 错误 data 是 google.rpc.ErrorInfo；extended card 方法报 -32601", async () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const { record } = createA2aServerToken(home, "v1-err");
    const baseUrl = a2aBaseUrl(home);
    const unknown = await dispatchA2aRpc(home, { jsonrpc: "2.0", id: 1, method: "agent/getAuthenticatedExtendedCard", params: {} }, { token: record, baseUrl });
    expect((unknown?.error as Record<string, unknown>).code).toBe(-32601);
    const data = (unknown?.error as Record<string, unknown>).data as Record<string, unknown>[];
    expect(data[0]["@type"]).toBe("type.googleapis.com/google.rpc.ErrorInfo");
    expect(data[0].reason).toBe("METHOD_NOT_FOUND");
    expect(data[0].domain).toBe("a2a-protocol.org");
    const missing = await dispatchA2aRpc(home, { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "a2a-nope" } }, { token: record, baseUrl });
    expect((missing?.error as Record<string, unknown>).code).toBe(-32001);
    const data2 = (missing?.error as Record<string, unknown>).data as Record<string, unknown>[];
    expect(data2[0].reason).toBe("TASK_NOT_FOUND");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 untrusted: 对端消息进 runner 前打不可信标记（kind peer）", async () => {
  const home = tmpHome("nyra-a2a-v1-");
  try {
    const { record } = createA2aServerToken(home, "v1-untrusted");
    let seen = "";
    const capturing: A2aServerDeps = {
      agentRunner: async (_h, task, opts) => {
        seen = task;
        return { taskId: opts.taskId, contextId: opts.contextId, text: "ok", textChars: 2, toolCalls: [], proposals: [], spentUsd: null, error: "" };
      },
    };
    await sendV1(home, record, "帮我查一下今天的安排", capturing);
    expect(seen).toContain('[untrusted-content kind="peer"');
    expect(seen).toContain("peer:a2a:v1-untrusted");
    expect(seen).toContain("帮我查一下今天的安排");
  } finally {
    cleanup(home);
  }
});

test("a2a-v1 parse: parseAgentCard 认 v1.0 卡与老版卡，脏 signatures 拒绝", () => {
  const v1 = parseAgentCard({
    name: "V1", description: "v1", agentId: "v1-agent",
    supportedInterfaces: [{ url: "https://v1.example.com", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    signatures: [{ protected: "abc", signature: "def" }],
    skills: [],
  });
  expect(v1.agentId).toBe("v1-agent");
  expect(v1.signatures).toHaveLength(1);
  expect(() => parseAgentCard({
    name: "V1", description: "x",
    supportedInterfaces: [{ url: "https://v1.example.com", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    signatures: [{ protected: "abc" }],
    skills: [],
  })).toThrow("protected 与 signature");
  expect(() => parseAgentCard({
    name: "V1", description: "x",
    supportedInterfaces: [{ url: "https://v1.example.com", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    signatures: "nope",
    skills: [],
  })).toThrow("signatures 须是最多 5 项的列表");
});
