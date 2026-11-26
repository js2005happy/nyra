// tests/node/test-pairing-crypto.test.ts — 配对加密传输（ECDH P-256 + HKDF + AES-256-GCM）。
//
// 覆盖：服务端往返、篡改拒、错钥拒、非法公钥 400、网关加密端到端、
// 手机端 WebCrypto（Bun 自带 crypto.subtle）与服务端互通。
// 注意：手机页经明文 HTTP 局域网 IP 加载时 crypto.subtle 不可用，
// 那条回落路径（明文 /api/pair + 配对页提示）不在这里测——它没有 WebCrypto。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptTokenEnvelope,
  encryptTokenForPeer,
  generatePairingKeyPair,
  PairingCryptoError,
  type TokenEnvelope,
} from "../../src/pairingCrypto.ts";
import { Gateway } from "../../src/gateway.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const b64u = (s: string) => Buffer.from(s, "base64url");
const unb64u = (b: Buffer) => b.toString("base64url");

test("配对加密：往返解密出同一个 token", () => {
  const phone = generatePairingKeyPair();
  const env = encryptTokenForPeer("device-token-abc", phone.publicKey);
  expect(env.v).toBe(1);
  expect(env.epk).not.toBe(phone.publicKey);
  expect(decryptTokenEnvelope(env, phone.privateKey)).toBe("device-token-abc");
});

test("配对加密：篡改密文或标签就拒，错钥匙也拒", () => {
  const phone = generatePairingKeyPair();
  const other = generatePairingKeyPair();
  const env = encryptTokenForPeer("device-token-abc", phone.publicKey);
  const tampered: TokenEnvelope = { ...env, ct: unb64u(Buffer.from(b64u(env.ct).map((b, i) => (i === 0 ? b ^ 1 : b)))) };
  expect(() => decryptTokenEnvelope(tampered, phone.privateKey)).toThrow();
  const badTag: TokenEnvelope = { ...env, tag: unb64u(Buffer.from(b64u(env.tag).map((b, i) => (i === 0 ? b ^ 1 : b)))) };
  expect(() => decryptTokenEnvelope(badTag, phone.privateKey)).toThrow();
  expect(() => decryptTokenEnvelope(env, other.privateKey)).toThrow();
  expect(() => decryptTokenEnvelope({ ...env, v: 2 as 1 }, phone.privateKey)).toThrow(/版本/);
});

test("配对加密：非法公钥抛 PairingCryptoError", () => {
  expect(() => encryptTokenForPeer("x", "too-short")).toThrow(PairingCryptoError);
  expect(() => encryptTokenForPeer("x", unb64u(Buffer.alloc(64)))).toThrow(PairingCryptoError);
});

// ---------------------------------------------------------- 网关端到端 ---
test("网关加密配对：换到的 token 能用；错码 401；坏公钥 400", async () => {
  const home = tmp("nyra-pairenc-");
  const gw = new Gateway({ home, workdir: tmp("nyra-pairenc-wd-"), host: "0.0.0.0", port: 0, mode: "auto", config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const phone = generatePairingKeyPair();
    const started = gw.startPairing() as { code: string };
    const bad = await fetch(`${base}/api/pair/encrypted`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel 7", public_key: "nope" }) });
    expect(bad.status).toBe(400);
    const wrong = await fetch(`${base}/api/pair/encrypted`, { method: "POST", body: JSON.stringify({ code: "000000", name: "Pixel 7", public_key: phone.publicKey }) });
    expect(wrong.status).toBe(401);
    const res = await fetch(`${base}/api/pair/encrypted`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel 7", public_key: phone.publicKey }) });
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; name: string; envelope: TokenEnvelope; token?: string };
    expect(data.token).toBeUndefined();
    expect(data.name).toBe("Pixel 7");
    const token = decryptTokenEnvelope(data.envelope, phone.privateKey);
    expect(token.length).toBeGreaterThan(30);
    // 换到的 token 真能用。
    expect((await fetch(`${base}/api/info`, { headers: { "X-Nyra-Token": token } })).status).toBe(200);
    // 一次性：同一码再换必失败。
    const again = await fetch(`${base}/api/pair/encrypted`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel 7", public_key: phone.publicKey }) });
    expect(again.status).toBe(401);
  } finally { await gw.stop(); }
});

// ---------------------------------------------- 手机端 WebCrypto 与服务端互通 ---
test("配对加密：手机端 WebCrypto 能解开服务端信封", async () => {
  const subtle = globalThis.crypto.subtle;
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey)); // 65 字节 0x04||x||y
  const phonePublic = unb64u(Buffer.from(raw.slice(1)));
  const env = encryptTokenForPeer("device-token-abc", phonePublic);

  const epkBytes = b64u(env.epk);
  const epkRaw = new Uint8Array(65); epkRaw[0] = 4; epkRaw.set(epkBytes, 1);
  const epk = await subtle.importKey("raw", epkRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await subtle.deriveBits({ name: "ECDH", public: epk }, kp.privateKey, 256);
  const baseKey = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epkBytes, info: new TextEncoder().encode("nyra-pair-v1") },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const ct = b64u(env.ct), tag = b64u(env.tag);
  const buf = new Uint8Array(ct.length + tag.length); buf.set(ct); buf.set(tag, ct.length);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64u(env.iv), tagLength: 128 }, aesKey, buf);
  expect(new TextDecoder().decode(pt)).toBe("device-token-abc");
});
