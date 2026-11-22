// src/cardSignature.ts — G-P1-7：名片 JWS 签名（防冒充，借 CrewAI 的做法）。
//
// CrewAI 的 AgentCardSigningConfig 用 JWS 签名片（RS256/ES256/PS256，
// 私钥走文件或 PEM，带 kid）；Nyra 取其中最小可用的一套：
// - 算法只认 ES256（P-256，Node 原生 crypto 就能签验，不引新依赖）；
// - 私钥只存密码箱（vault 条目 peer-card-signing-key），公钥 JWK 随
//   名片一起发；私钥原文绝不进账本、审计与事件；
// - 签的是名片指纹（SHA-256 前 12 位同款 cardHash 的完整版）：
//   JWS payload = { iss, card_hash, iat, exp }，验签时重算名片哈希
//   比对——名片正文被改过一个字就验不过；
// - 信任模型是 TOFU（首次见面钉住，像 SSH known_hosts）：第一次拉
//   到带签名的名片时把公钥指纹记进好友账本（card_key_fp），以后再
//   拉必须同一把钥匙，否则拒绝；换钥匙须机主显式重钉
//   （nyra peer card trust <好友名>）。
// - 没签名的名片照样能拉（老版本对方没签名是常态），只标 signature:
//   absent，不因此拒绝——签名是“验得过就更可信”，不是准入门槛。
//   准入仍走信任圈 + 双向批准，签名不替它们做决定。
import { createHash, createPublicKey, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { Vault, getCredential, vaultPath } from "./vault.ts";

// 注意：本文件绝不能静态 import peerCard（peerCard 要静态 import
// 本文件的签名函数；静态互引会触发模块初始化循环）。TOFU 钉住那两
// 个函数在函数体内动态 import peerCard（team.ts 对 teamLease 同款做法）。
/** 名片指纹：SHA-256 前 12 位（peerCard.cardHash 同款定义，不另起口径）。 */
export function cardHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

export const CARD_SIGNING_VAULT_ENTRY = "peer-card-signing-key";
export const CARD_SIGNATURE_ALG = "ES256";
/** 签名有效期：30 天（过期名片须对方重新签发，不静默续）。 */
export const CARD_SIGNATURE_TTL_S = 30 * 24 * 3600;

export class CardSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardSignatureError";
  }
}

export interface SigningKeypair {
  kid: string;
  privatePem: string;
  publicJwk: Record<string, unknown>;
}

/** RFC 7638 JWK 指纹：只取 crv/kty/x/y 四个字段算 SHA-256。 */
export function jwkThumbprint(jwk: Record<string, unknown>): string {
  const t = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return createHash("sha256").update(JSON.stringify(t)).digest("hex");
}

function b64url(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString("base64url") : Buffer.from(input, "utf-8").toString("base64url");
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** 生成一对 ES256 签名密钥（P-256）：私钥 PEM + 公钥 JWK，kid 是公钥指纹前 12 位。 */
export function generateSigningKeypair(): SigningKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicJwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;
  const kid = jwkThumbprint(publicJwk).slice(0, 12);
  return { kid, privatePem, publicJwk };
}

/** 把密钥对存进密码箱（须先解锁；私钥原文只进密码箱，不落别处）。 */
export function saveSigningKey(home: string, keypair: SigningKeypair, password: string): void {
  const vault = new Vault(vaultPath(home));
  if (!vault.exists()) throw new CardSignatureError("密码箱不存在，先运行：nyra vault init");
  if (!vault.unlock(password)) throw new CardSignatureError("密码箱主密码不对");
  vault.add(CARD_SIGNING_VAULT_ENTRY, JSON.stringify(keypair), true);
}

/** 静默读签名密钥：没密码箱、没密码、密码错、没条目时一律返回 null（网关无密码时不签名，只发素名片）。 */
export function loadSigningKey(home: string): SigningKeypair | null {
  const raw = getCredential(CARD_SIGNING_VAULT_ENTRY, home);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SigningKeypair;
    if (typeof parsed.kid !== "string" || typeof parsed.privatePem !== "string" || !parsed.publicJwk) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface CardSignature {
  /** JWS 紧凑序列化（header.payload.signature）。 */
  jws: string;
  /** 签名用的公钥 JWK（随名片一起发，供对方验签）。 */
  publicKey: Record<string, unknown>;
  kid: string;
}

/**
 * 给一张名片签名：签的是名片哈希（不含 signature/public_key 两个
 * 字段的名片 JSON），不是名片原文——验签方重算哈希比对即可。
 */
export function signAgentCard(card: Record<string, unknown>, keypair: SigningKeypair, opts: { issuer?: string; now?: () => number } = {}): CardSignature {
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const unsigned: Record<string, unknown> = { ...card };
  delete unsigned.signature;
  delete unsigned.public_key;
  const hash = createHash("sha256").update(JSON.stringify(unsigned), "utf-8").digest("hex");
  const header = { alg: CARD_SIGNATURE_ALG, kid: keypair.kid, typ: "agent-card+jws" };
  const payload = {
    iss: opts.issuer ?? "nyra",
    card_hash: hash,
    iat: now,
    exp: now + CARD_SIGNATURE_TTL_S,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput, "utf-8");
  signer.end();
  const sig = signer.sign({ key: keypair.privatePem, dsaEncoding: "ieee-p1363" });
  return { jws: `${signingInput}.${b64url(sig)}`, publicKey: keypair.publicJwk, kid: keypair.kid };
}

export type CardSignatureStatus = "verified" | "absent" | "invalid";

export interface VerifiedCard {
  status: CardSignatureStatus;
  /** 验过时是签名公钥的指纹；没签名时为 null。 */
  keyFp: string | null;
  reason: string;
}

/**
 * 验一张拉回来的名片上的签名（不可信输入，验不过就报 invalid，不抛错）：
 * ① 名片里没 signature 字段 → absent（老版本，没签名是常态）；
 * ② 有 signature 但没 public_key、或 JWS 结构不对、算法不是 ES256、
 *    签名对不上、payload 的 card_hash 与重算的不一致、已过期 → invalid；
 * ③ 全对上 → verified，并回公钥指纹（调用方拿它去对 TOFU 钉住的指纹）。
 */
export function verifySignedCard(raw: unknown): VerifiedCard {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "invalid", keyFp: null, reason: "名片不是 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const jws = obj.signature;
  if (jws === undefined || jws === null) {
    return { status: "absent", keyFp: null, reason: "名片没带签名（对方是老版本或没开签名）" };
  }
  if (typeof jws !== "string") return { status: "invalid", keyFp: null, reason: "名片的 signature 必须是字符串" };
  const pub = obj.public_key;
  if (!pub || typeof pub !== "object" || Array.isArray(pub)) {
    return { status: "invalid", keyFp: null, reason: "名片带了签名却没带公钥，验不了" };
  }
  const publicJwk = pub as Record<string, unknown>;
  let keyObj;
  try {
    keyObj = createPublicKey({ key: publicJwk as never, format: "jwk" });
  } catch {
    return { status: "invalid", keyFp: null, reason: "名片里的公钥不是合法 JWK" };
  }
  const parts = jws.split(".");
  if (parts.length !== 3) return { status: "invalid", keyFp: null, reason: "签名不是 JWS 紧凑序列化（三段）" };
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlToBuffer(parts[0]).toString("utf-8")) as Record<string, unknown>;
    payload = JSON.parse(b64urlToBuffer(parts[1]).toString("utf-8")) as Record<string, unknown>;
  } catch {
    return { status: "invalid", keyFp: null, reason: "签名的 header 或 payload 不是合法 JSON" };
  }
  if (header.alg !== CARD_SIGNATURE_ALG) {
    return { status: "invalid", keyFp: null, reason: `签名算法只认 ${CARD_SIGNATURE_ALG}，当前是 ${String(header.alg)}` };
  }
  const verifier = createVerify("SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`, "utf-8");
  verifier.end();
  let ok = false;
  try {
    ok = verifier.verify({ key: keyObj, dsaEncoding: "ieee-p1363" }, b64urlToBuffer(parts[2]));
  } catch {
    ok = false;
  }
  if (!ok) return { status: "invalid", keyFp: null, reason: "签名对不上（名片可能被改过，或钥匙不对）" };
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return { status: "invalid", keyFp: null, reason: "签名已过期（对方须重新签发名片）" };
  }
  const unsigned: Record<string, unknown> = { ...obj };
  delete unsigned.signature;
  delete unsigned.public_key;
  const recomputed = createHash("sha256").update(JSON.stringify(unsigned), "utf-8").digest("hex");
  if (payload.card_hash !== recomputed) {
    return { status: "invalid", keyFp: null, reason: "签名里的名片哈希与收到的名片对不上（正文被改过）" };
  }
  return { status: "verified", keyFp: jwkThumbprint(publicJwk), reason: "签名验过" };
}

/**
 * TOFU 钉住：把对方的公钥指纹记进好友账本（card_key_fp）。第一次
 * 见面时钉，之后拉名片必须同一把钥匙——指纹变了直接拒绝，换钥匙
 * 须机主显式重钉（nyra peer card trust <好友名>）。
 */
export async function pinCardKey(home: string, peer: string, keyFp: string): Promise<void> {
  const { findFriend, loadFriendBook, saveFriendBook } = await import("./peerCard.ts");
  const book = loadFriendBook(home);
  const entry = findFriend(book, peer);
  if (!entry) throw new CardSignatureError(`好友账本里没有 ${peer}：先加好友再钉钥匙`);
  entry.card_key_fp = keyFp;
  saveFriendBook(home, book);
}

export type CardKeyStatus = "pinned" | "mismatch" | "unpinned";

/** 查一把钥匙相对钉住的指纹是什么关系：没钉过 unpinned、对得上 pinned、对不上 mismatch。 */
export async function cardKeyStatus(home: string, peer: string, keyFp: string): Promise<CardKeyStatus> {
  const { findFriend, loadFriendBook } = await import("./peerCard.ts");
  const book = loadFriendBook(home);
  const entry = findFriend(book, peer);
  if (!entry) throw new CardSignatureError(`好友账本里没有 ${peer}`);
  if (!entry.card_key_fp) return "unpinned";
  return entry.card_key_fp === keyFp ? "pinned" : "mismatch";
}

/** 名片哈希（完整 SHA-256）：签名 payload 里用的就是它；事件与审计里只记前 12 位。 */
export function fullCardHash(card: Record<string, unknown>): string {
  const unsigned: Record<string, unknown> = { ...card };
  delete unsigned.signature;
  delete unsigned.public_key;
  return createHash("sha256").update(JSON.stringify(unsigned), "utf-8").digest("hex");
}
