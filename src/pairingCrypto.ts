// src/pairingCrypto.ts — 配对通道加密传输（ECDH P-256 + HKDF-SHA-256 + AES-256-GCM）。
//
// 为什么需要它：配对时手机把 6 位配对码发给网关、网关把设备 token 发回手机，
// 全程明文 HTTP。同一局域网里有人抓包，就能拿到 token 冒充这台手机。
// 加密握手：手机生成一对临时 ECDH 密钥，把公钥随配对码发来；网关再生成一对
// 临时密钥，用双方公钥派生出会话密钥，把 token 加密后发回。双方的私钥都只
// 存在内存里、一次一换，token 不再明文过网。
//
// 拦路点（已核实，见 PUSH-PLAN.md）：WebCrypto 只在安全上下文可用。手机配对
// 页是经明文 HTTP 局域网 IP 加载的，`crypto.subtle` 是 undefined，所以这条
// 加密路只在手机走 HTTPS/localhost 时能用；走 http://192.168.x.x 时手机端
// 回落明文 /api/pair，并在配对页明说当前连接未加密。完整落地要么给网关上
// HTTPS，要么写纯 JS 的 P-256 实现——都超出本批范围。
import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, createPublicKey, createPrivateKey, randomBytes } from "node:crypto";

const HKDF_INFO = "nyra-pair-v1";

/** 对方公钥不合法（长度不对、或不在 P-256 曲线上）。 */
export class PairingCryptoError extends Error {}

export interface PairingKeyPair {
  /** 公钥：P-256 未压缩点去掉 0x04 前缀后的 x||y（64 字节），base64url。 */
  publicKey: string;
  /** 私钥：JWK（只放内存，别落盘）。 */
  privateKey: JsonWebKey;
}

export interface TokenEnvelope {
  v: 1;
  /** 网关的临时公钥（x||y，base64url）。 */
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

const b64u = (buf: Buffer) => buf.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** 从 x||y（64 字节 base64url）恢复 P-256 公钥 KeyObject；非法点抛 PairingCryptoError。 */
function publicKeyFromRaw(raw: string): ReturnType<typeof createPublicKey> {
  const bytes = unb64u(raw);
  if (bytes.length !== 64) throw new PairingCryptoError("公钥长度不对");
  const x = b64u(bytes.subarray(0, 32));
  const y = b64u(bytes.subarray(32));
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
  } catch {
    throw new PairingCryptoError("公钥不在 P-256 曲线上");
  }
}

function privateKeyFromJwk(jwk: JsonWebKey): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: jwk, format: "jwk" });
}

function deriveKey(ownPrivate: ReturnType<typeof createPrivateKey>, peerPublic: ReturnType<typeof createPublicKey>, salt: Buffer): Buffer {
  const secret = diffieHellman({ privateKey: ownPrivate, publicKey: peerPublic });
  return Buffer.from(hkdfSync("sha256", secret, salt, HKDF_INFO, 32));
}

export function generatePairingKeyPair(): PairingKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubJwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([unb64u(pubJwk.x!), unb64u(pubJwk.y!)]);
  return { publicKey: b64u(raw), privateKey: privateKey.export({ format: "jwk" }) };
}

/** 校验对方公钥（长度 + 在曲线上）；非法抛 PairingCryptoError。 */
export function assertValidPairingPublicKey(raw: string): void {
  publicKeyFromRaw(raw);
}

/** 用对方公钥加密一段文本（token）：生成临时密钥对，返回信封。 */
export function encryptTokenForPeer(token: string, peerPublicKey: string): TokenEnvelope {
  const ephemeral = generatePairingKeyPair();
  const peer = publicKeyFromRaw(peerPublicKey);
  const own = privateKeyFromJwk(ephemeral.privateKey);
  const salt = unb64u(ephemeral.publicKey);
  const key = deriveKey(own, peer, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { v: 1, epk: ephemeral.publicKey, iv: b64u(iv), ct: b64u(ct), tag: b64u(cipher.getAuthTag()) };
}

/** 解开信封：自己的私钥 + 信封里的临时公钥派生同一把密钥。 */
export function decryptTokenEnvelope(envelope: TokenEnvelope, ownPrivateKey: JsonWebKey): string {
  if (envelope?.v !== 1) throw new Error("信封版本不对");
  const peer = publicKeyFromRaw(envelope.epk);
  const own = privateKeyFromJwk(ownPrivateKey);
  const salt = unb64u(envelope.epk);
  const key = deriveKey(own, peer, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, unb64u(envelope.iv));
  decipher.setAuthTag(unb64u(envelope.tag));
  const pt = Buffer.concat([decipher.update(unb64u(envelope.ct)), decipher.final()]);
  return pt.toString("utf8");
}
