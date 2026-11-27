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
// - 没签名的名片：verifySignedCard 仍只标 signature: absent（老版本
//   对方没签名是常态）；但 A2A v1.0 起，发现（peerDiscovery）与加
//   好友（peerCard 发/收请求）两条入口改为必须验过才收——缺签名、
//   篡改过、过期签名一律拒绝。签名仍不替双向批准做决定，批准的门
//   还在。只做格式校验的 parseAgentCard 不碰签名。
// - v1.0 签名（A2A v1.0，RFC 8785 JCS + RFC 7515 JWS）：签的是规范化
//   后的整张名片（不含 signatures / signature / public_key 三个
//   字段），分离式签名——signatures[] 里每条只有 protected、
//   signature、header 三段，验签方重算规范化名片再验；受保护头里
//   带 iat/exp（有效期仍是 30 天），过期一样拒收。老版紧凑 JWS
//   （payload { iss, card_hash, iat, exp }）继续发、继续验，供
//   还没升到 v1.0 的老对方认；验签时 v1.0 优先，老版兜底。
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

/**
 * RFC 8785 JCS 规范化（Nyra 只用得到 JSON 值的子集）：对象递归按
 * 键排序（JS 默认 sort 是 UTF-16 码元序，与 JCS 的排序一致），数
 * 组保序，字符串/数字/布尔/null 走 JSON.stringify。签名前后都
 * 用它算名片哈希——键顺序一变哈希也不变，老版 JSON.stringify
 * 那种“重排键就验不过”的毛病就没了。非 JSON 值（undefined、
 * 函数、循环引用）直接报错，不静默跳过。
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CardSignatureError("名片里有非有限数字，规范化不了");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
  }
  throw new CardSignatureError("名片里有不能规范化的值（非 JSON 值）");
}

/** 名片的规范化哈希（完整 SHA-256）：签名前后都按它算，不含签名三字段。 */
export function canonicalCardHash(card: Record<string, unknown>): string {
  const unsigned: Record<string, unknown> = { ...card };
  delete unsigned.signature;
  delete unsigned.public_key;
  delete unsigned.signatures;
  return createHash("sha256").update(canonicalizeJson(unsigned), "utf-8").digest("hex");
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
 * 给一张名片签名（老版紧凑 JWS，供还没升到 v1.0 的老对方认）：签的
 * 是名片哈希（不含 signature/public_key/signatures 三个字段的名片
 * 规范化 JSON 的 SHA-256），不是名片原文——验签方重算哈希比对即可。
 * 哈希按 RFC 8785 规范化算，键顺序不影响结果。
 */
export function signAgentCard(card: Record<string, unknown>, keypair: SigningKeypair, opts: { issuer?: string; now?: () => number } = {}): CardSignature {
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const hash = canonicalCardHash(card);
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

export interface AgentCardSignatureV1 {
  /** base64url 的受保护头（alg/kid/typ/iat/exp）。 */
  protected: string;
  /** base64url 的 ES256 签名值。 */
  signature: string;
  /** 受保护头的解码版（方便调用方直接读 iat/exp/kid，不用自己解）。 */
  header: { alg: string; kid: string; typ: string; iat: number; exp: number };
}

/**
 * 给一张名片签 v1.0 的名（A2A v1.0 的 signatures[] 条目，JWS JSON
 * 序列化、分离式）：签的是受保护头 + 规范化名片本身（不含
 * signature/public_key/signatures 三个字段），payload 不另放——
 * 验签方重算规范化名片再验。iat/exp 放进受保护头（签名盖住了，
 * 改有效期就验不过），有效期仍是 30 天。
 */
export function signAgentCardV1(card: Record<string, unknown>, keypair: SigningKeypair, opts: { now?: () => number } = {}): AgentCardSignatureV1 {
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const header = { alg: CARD_SIGNATURE_ALG, kid: keypair.kid, typ: "agent-card+jws", iat: now, exp: now + CARD_SIGNATURE_TTL_S };
  const protectedB64 = b64url(JSON.stringify(header));
  const canonical = canonicalizeJson((() => {
    const unsigned: Record<string, unknown> = { ...card };
    delete unsigned.signature;
    delete unsigned.public_key;
    delete unsigned.signatures;
    return unsigned;
  })());
  const signingInput = `${protectedB64}.${b64url(canonical)}`;
  const signer = createSign("SHA256");
  signer.update(signingInput, "utf-8");
  signer.end();
  const sig = signer.sign({ key: keypair.privatePem, dsaEncoding: "ieee-p1363" });
  return { protected: protectedB64, signature: b64url(sig), header };
}

export type CardSignatureStatus = "verified" | "absent" | "invalid";

export interface VerifiedCard {
  status: CardSignatureStatus;
  /** 验过时是签名公钥的指纹；没签名时为 null。 */
  keyFp: string | null;
  reason: string;
}

/** 从 JWK 建验签用的公钥对象（非法 JWK 返回 null，不抛错）。 */
function publicKeyFromJwk(publicJwk: Record<string, unknown>): ReturnType<typeof createPublicKey> | null {
  try {
    return createPublicKey({ key: publicJwk as never, format: "jwk" });
  } catch {
    return null;
  }
}

/** ES256 验一段 signingInput 上的签名（签名是 base64url 的 P-256 签名）。 */
function verifyEs256(keyObj: ReturnType<typeof createPublicKey>, signingInput: string, signatureB64: string): boolean {
  const verifier = createVerify("SHA256");
  verifier.update(signingInput, "utf-8");
  verifier.end();
  try {
    return verifier.verify({ key: keyObj, dsaEncoding: "ieee-p1363" }, b64urlToBuffer(signatureB64));
  } catch {
    return false;
  }
}

/** 解 base64url 的 JSON（非法返回 null，不抛错）。 */
function decodeB64Json(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(b64urlToBuffer(s).toString("utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 验一张拉回来的名片上的签名（不可信输入，验不过就报 invalid，不抛错）。
 * 顺序：① 名片带 v1.0 的 signatures[]（非空数组）时按 v1.0 验——签的是
 * 受保护头 + 规范化名片本身，任一条验过即 verified；数组空着、
 * 没带公钥、头里没有效期、过期、签名对不上都算 invalid；② 没带
 * signatures、带了老版紧凑 JWS（signature 字段）时按老版验——
 * payload 的 card_hash 先按规范化哈希比对，再按老版
 * JSON.stringify 哈希比对（老 Nyra 签的卡还能认），过期、哈希
 * 对不上、签名对不上都算 invalid；③ 两样都没带 → absent。
 * 注意：这里只报结论，收不收卡是调用方的事——发现与加好友两条
 * 入口现在要求 verified，absent 与 invalid 都拒绝。
 */
export function verifySignedCard(raw: unknown): VerifiedCard {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "invalid", keyFp: null, reason: "名片不是 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const sigs = obj.signatures;
  if (sigs !== undefined && sigs !== null) {
    if (!Array.isArray(sigs)) {
      return { status: "invalid", keyFp: null, reason: "名片的 signatures 必须是列表" };
    }
    if (sigs.length === 0) {
      return { status: "invalid", keyFp: null, reason: "名片带了空的 signatures（没签名）" };
    }
    const pub = obj.public_key;
    if (!pub || typeof pub !== "object" || Array.isArray(pub)) {
      return { status: "invalid", keyFp: null, reason: "名片带了 signatures 却没带公钥，验不了" };
    }
    const publicJwk = pub as Record<string, unknown>;
    const keyObj = publicKeyFromJwk(publicJwk);
    if (!keyObj) return { status: "invalid", keyFp: null, reason: "名片里的公钥不是合法 JWK" };
    const canonical = b64url(canonicalizeJson((() => {
      const unsigned: Record<string, unknown> = { ...obj };
      delete unsigned.signature;
      delete unsigned.public_key;
      delete unsigned.signatures;
      return unsigned;
    })()));
    let firstReason = "signatures 里的签名没有一个验得过";
    for (const entry of sigs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        firstReason = "signatures 里有不是对象的条目";
        continue;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.protected !== "string" || typeof e.signature !== "string") {
        firstReason = "signatures 里的条目缺 protected 或 signature";
        continue;
      }
      const header = decodeB64Json(e.protected);
      if (!header) {
        firstReason = "signatures 里的 protected 不是合法 JSON";
        continue;
      }
      if (header.alg !== CARD_SIGNATURE_ALG) {
        firstReason = `签名算法只认 ${CARD_SIGNATURE_ALG}，当前是 ${String(header.alg)}`;
        continue;
      }
      if (typeof header.exp !== "number" || header.exp * 1000 <= Date.now()) {
        firstReason = "签名已过期（对方须重新签发名片）";
        continue;
      }
      if (!verifyEs256(keyObj, `${e.protected}.${canonical}`, e.signature)) {
        firstReason = "签名对不上（名片可能被改过，或钥匙不对）";
        continue;
      }
      return { status: "verified", keyFp: jwkThumbprint(publicJwk), reason: "签名验过" };
    }
    return { status: "invalid", keyFp: null, reason: firstReason };
  }
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
  const keyObj = publicKeyFromJwk(publicJwk);
  if (!keyObj) return { status: "invalid", keyFp: null, reason: "名片里的公钥不是合法 JWK" };
  const parts = jws.split(".");
  if (parts.length !== 3) return { status: "invalid", keyFp: null, reason: "签名不是 JWS 紧凑序列化（三段）" };
  const header = decodeB64Json(parts[0]);
  const payload = decodeB64Json(parts[1]);
  if (!header || !payload) {
    return { status: "invalid", keyFp: null, reason: "签名的 header 或 payload 不是合法 JSON" };
  }
  if (header.alg !== CARD_SIGNATURE_ALG) {
    return { status: "invalid", keyFp: null, reason: `签名算法只认 ${CARD_SIGNATURE_ALG}，当前是 ${String(header.alg)}` };
  }
  if (!verifyEs256(keyObj, `${parts[0]}.${parts[1]}`, parts[2])) {
    return { status: "invalid", keyFp: null, reason: "签名对不上（名片可能被改过，或钥匙不对）" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return { status: "invalid", keyFp: null, reason: "签名已过期（对方须重新签发名片）" };
  }
  // 哈希先按规范化算（现行签发方式），再按老版 JSON.stringify 算
  // （老 Nyra 签的卡还能认）——两个都对不上才算正文被改过。
  const recomputed = canonicalCardHash(obj);
  const legacyUnsigned: Record<string, unknown> = { ...obj };
  delete legacyUnsigned.signature;
  delete legacyUnsigned.public_key;
  delete legacyUnsigned.signatures;
  const legacyRecomputed = createHash("sha256").update(JSON.stringify(legacyUnsigned), "utf-8").digest("hex");
  if (payload.card_hash !== recomputed && payload.card_hash !== legacyRecomputed) {
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

/** 名片哈希（完整 SHA-256，规范化后算）：签名 payload 里用的就是它；事件与审计里只记前 12 位。 */
export function fullCardHash(card: Record<string, unknown>): string {
  return canonicalCardHash(card);
}
