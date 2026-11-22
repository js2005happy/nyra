// tests/node/test-card-signature-batch3.test.ts — 第 3 批 G-P1-7：
// 名片 JWS 签名（ES256 + TOFU 钉住）。不联网、不调模型。
import { test, expect } from "bun:test";
import {
  generateSigningKeypair,
  signAgentCard,
  verifySignedCard,
  jwkThumbprint,
  cardHash,
  CARD_SIGNATURE_TTL_S,
} from "../../src/cardSignature.ts";

function sampleCard(): Record<string, unknown> {
  return {
    name: "Nyra",
    description: "test agent",
    url: "https://example.com",
    version: "0.5.6",
    skills: [{ id: "search_memory", name: "search_memory", description: "search" }],
    authentication: { schemes: ["bearer"] },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    endpoints: { mcp: "https://example.com/mcp" },
  };
}

test("CardSignatureBatch3.test_sign_verify_roundtrip", () => {
  const kp = generateSigningKeypair();
  const card = sampleCard();
  const sig = signAgentCard(card, kp);
  expect(sig.jws.split(".")).toHaveLength(3);
  expect(sig.publicKey).toBeDefined();
  const signed = { ...card, signature: sig.jws, public_key: sig.publicKey };
  const verified = verifySignedCard(signed);
  expect(verified.status).toBe("verified");
  // keyFp 是公钥完整指纹（64 位）；kid 只是它的前 12 位（JWS 头里的短 id）
  expect(verified.keyFp).toBe(jwkThumbprint(sig.publicKey as Record<string, unknown>));
  expect(verified.keyFp?.startsWith(kp.kid)).toBe(true);
});

test("CardSignatureBatch3.test_unsigned_card_is_absent_not_invalid", () => {
  expect(verifySignedCard(sampleCard()).status).toBe("absent");
});

test("CardSignatureBatch3.test_tampered_card_fails_verification", () => {
  const kp = generateSigningKeypair();
  const sig = signAgentCard(sampleCard(), kp);
  const tampered = { ...sampleCard(), description: "tampered", signature: sig.jws, public_key: sig.publicKey };
  expect(verifySignedCard(tampered).status).toBe("invalid");
});

test("CardSignatureBatch3.test_wrong_key_fails_verification", () => {
  const kp1 = generateSigningKeypair();
  const kp2 = generateSigningKeypair();
  const sig = signAgentCard(sampleCard(), kp1);
  // 签名是 kp1 的，公钥却贴 kp2 的：验不过
  const mismatched = { ...sampleCard(), signature: sig.jws, public_key: kp2.publicJwk };
  expect(verifySignedCard(mismatched).status).toBe("invalid");
});

test("CardSignatureBatch3.test_signature_without_public_key_is_invalid", () => {
  const kp = generateSigningKeypair();
  const sig = signAgentCard(sampleCard(), kp);
  const noKey = { ...sampleCard(), signature: sig.jws };
  expect(verifySignedCard(noKey).status).toBe("invalid");
});

test("CardSignatureBatch3.test_expired_signature_is_invalid", () => {
  const kp = generateSigningKeypair();
  const nowSec = Math.floor(Date.now() / 1000);
  // 用过去的时间签发（iat 早已过期）
  const sig = signAgentCard(sampleCard(), kp, { now: () => (nowSec - CARD_SIGNATURE_TTL_S - 60) * 1000 });
  const signed = { ...sampleCard(), signature: sig.jws, public_key: sig.publicKey };
  expect(verifySignedCard(signed).status).toBe("invalid");
});

test("CardSignatureBatch3.test_card_hash_matches_signed_payload", () => {
  const kp = generateSigningKeypair();
  const card = sampleCard();
  const sig = signAgentCard(card, kp);
  // payload 是 base64url JSON：card_hash 应等于未签名卡片的完整 SHA-256
  const payloadB64 = sig.jws.split(".")[1];
  const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as Record<string, unknown>;
  expect(payload.iss).toBe("nyra");
  expect(typeof payload.card_hash).toBe("string");
  // payload 里是完整 SHA-256，cardHash 是它的前 12 位
  expect((payload.card_hash as string)).toHaveLength(64);
  expect((payload.card_hash as string).slice(0, 12)).toBe(cardHash(JSON.stringify(card)));
});
