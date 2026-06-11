/**
 * PKI primitives for UCP + AP2.
 * - ES256 (ECDSA P-256 / SHA-256) key pairs, published as JWKs (RFC 7517)
 * - JWS compact + detached-content signatures (RFC 7515) over JCS-canonicalized payloads
 * - Raw r||s (ieee-p1363) signature encoding as required by RFC 9421 and JWS ES256
 *
 * No DIDs anywhere: identity = HTTPS profile URL + published signing keys.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  KeyObject,
} from "node:crypto";
import { jcsBytes } from "./jcs.ts";

export interface Jwk {
  kid: string;
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  use?: "sig";
  alg?: "ES256";
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: Jwk;
}

export const b64u = {
  encode(data: Buffer | string): string {
    return Buffer.from(data).toString("base64url");
  },
  decode(s: string): Buffer {
    return Buffer.from(s, "base64url");
  },
};

export function generateSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: { kid, kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, use: "sig", alg: "ES256" },
  };
}

export function jwkToPublicKey(jwk: Jwk): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
}

/** ECDSA P-256/SHA-256, raw r||s output (64 bytes) per RFC 9421 + JWS ES256. */
export function es256Sign(data: Buffer | string, privateKey: KeyObject): Buffer {
  return nodeSign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });
}

export function es256Verify(data: Buffer | string, signature: Buffer, publicKey: KeyObject): boolean {
  try {
    return nodeVerify("sha256", Buffer.from(data), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function randomId(prefix: string, len = 20): string {
  return `${prefix}_${randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len)}`;
}

/* ------------------------------------------------------------------ */
/* JWS (RFC 7515)                                                      */
/* ------------------------------------------------------------------ */

export interface JwsHeader {
  alg: "ES256";
  kid: string;
  typ?: string;
  [k: string]: unknown;
}

/** Compact JWS: header.payload.signature — payload is JCS-canonicalized JSON. */
export function jwsSignCompact(payload: unknown, key: SigningKey, typ?: string): string {
  const header: JwsHeader = { alg: "ES256", kid: key.kid, ...(typ ? { typ } : {}) };
  const h = b64u.encode(JSON.stringify(header));
  const p = b64u.encode(jcsBytes(payload));
  const sig = es256Sign(`${h}.${p}`, key.privateKey);
  return `${h}.${p}.${b64u.encode(sig)}`;
}

export interface VerifiedJws {
  header: JwsHeader;
  payload: any;
}

export function jwsVerifyCompact(jws: string, resolveKey: (kid: string) => KeyObject | undefined): VerifiedJws {
  const parts = jws.split("~")[0].split(".");
  if (parts.length !== 3) throw new Error("jws: malformed compact serialization");
  const [h, p, s] = parts;
  const header = JSON.parse(b64u.decode(h).toString("utf8")) as JwsHeader;
  if (header.alg !== "ES256") throw new Error(`jws: unsupported alg ${header.alg}`);
  const key = resolveKey(header.kid);
  if (!key) throw new Error(`jws: unknown kid ${header.kid}`);
  if (!es256Verify(`${h}.${p}`, b64u.decode(s), key)) throw new Error("jws: signature verification failed");
  return { header, payload: JSON.parse(b64u.decode(p).toString("utf8")) };
}

/**
 * Detached-content JWS (RFC 7515 Appendix F) — format `<header>..<signature>`.
 * Used for AP2 `merchant_authorization`: signature covers header + JCS(checkout minus `ap2`).
 */
export function jwsSignDetached(payload: unknown, key: SigningKey): string {
  const header: JwsHeader = { alg: "ES256", kid: key.kid };
  const h = b64u.encode(JSON.stringify(header));
  const signingInput = `${h}.${b64u.encode(jcsBytes(payload))}`;
  const sig = es256Sign(signingInput, key.privateKey);
  return `${h}..${b64u.encode(sig)}`;
}

export function jwsVerifyDetached(
  detachedJws: string,
  payload: unknown,
  resolveKey: (kid: string) => KeyObject | undefined
): { header: JwsHeader } {
  const m = detachedJws.match(/^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("jws: malformed detached serialization");
  const [, h, s] = m;
  const header = JSON.parse(b64u.decode(h).toString("utf8")) as JwsHeader;
  if (header.alg !== "ES256") throw new Error(`jws: unsupported alg ${header.alg}`);
  const key = resolveKey(header.kid);
  if (!key) throw new Error(`jws: unknown kid ${header.kid}`);
  const signingInput = `${h}.${b64u.encode(jcsBytes(payload))}`;
  if (!es256Verify(signingInput, b64u.decode(s), key)) throw new Error("jws: detached signature verification failed");
  return { header };
}
