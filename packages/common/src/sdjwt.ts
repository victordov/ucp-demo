/**
 * SD-JWT with Key Binding (SD-JWT+kb) — IETF draft-ietf-oauth-selective-disclosure-jwt.
 *
 * Used for the AP2 `ap2.checkout_mandate`: a verifiable credential where the
 * ISSUER (the Credentials Provider) signs claims — some made selectively
 * disclosable — and binds the credential to a HOLDER key (the user's device
 * key). A Key-Binding JWT, signed by the holder, proves possession and binds
 * the presentation to a specific audience + nonce, defeating replay.
 *
 * Serialization: `<issuer-jwt>~<disclosure>~...~<kb-jwt>`
 *   - issuer-jwt: JWS whose payload contains `_sd` (array of disclosure digests)
 *     and a `cnf.jwk` confirmation key (the holder's public JWK).
 *   - disclosure: base64url(JSON([salt, claimName, claimValue]))
 *   - kb-jwt: JWS (typ "kb+jwt") over { iat, aud, nonce, sd_hash } signed by holder.
 */
import { createHash, randomBytes, KeyObject } from "node:crypto";
import { b64u, es256Sign, es256Verify, jwkToPublicKey, type SigningKey, type Jwk } from "./crypto.ts";

const sha256b64u = (s: string) => b64u.encode(createHash("sha256").update(s).digest());

interface IssuerHeader {
  alg: "ES256";
  kid: string;
  typ: "dc+sd-jwt";
}
interface KbHeader {
  alg: "ES256";
  typ: "kb+jwt";
}

export interface SdJwtIssueOpts {
  /** Always-disclosed claims (iss, sub, iat, exp, plus any non-secret payload). */
  claims: Record<string, unknown>;
  /** Claims that become selectively disclosable (hidden behind digests). */
  disclosable: Record<string, unknown>;
  issuerKey: SigningKey;
  /** Holder public JWK — bound into `cnf.jwk` (key binding). */
  holderJwk: Jwk;
}

export interface Disclosure {
  name: string;
  encoded: string; // base64url(JSON([salt,name,value]))
  digest: string;
}

function makeDisclosure(name: string, value: unknown): Disclosure {
  const salt = b64u.encode(randomBytes(16));
  const encoded = b64u.encode(JSON.stringify([salt, name, value]));
  return { name, encoded, digest: sha256b64u(encoded) };
}

/** Issue an SD-JWT (issuer-signed, holder-bound). Returns the compact credential + its disclosures. */
export function sdJwtIssue(opts: SdJwtIssueOpts): { sdjwt: string; disclosures: Disclosure[] } {
  const disclosures = Object.entries(opts.disclosable).map(([k, v]) => makeDisclosure(k, v));
  const header: IssuerHeader = { alg: "ES256", kid: opts.issuerKey.kid, typ: "dc+sd-jwt" };
  const payload = {
    ...opts.claims,
    _sd: disclosures.map((d) => d.digest).sort(),
    _sd_alg: "sha-256",
    cnf: { jwk: { kty: opts.holderJwk.kty, crv: opts.holderJwk.crv, x: opts.holderJwk.x, y: opts.holderJwk.y } },
  };
  const h = b64u.encode(JSON.stringify(header));
  const p = b64u.encode(JSON.stringify(payload));
  const sig = es256Sign(`${h}.${p}`, opts.issuerKey.privateKey);
  const issuerJwt = `${h}.${p}.${b64u.encode(sig)}`;
  // Credential without KB (issuer issues; holder presents later)
  return { sdjwt: [issuerJwt, ...disclosures.map((d) => d.encoded), ""].join("~"), disclosures };
}

/**
 * Holder presents an SD-JWT: choose which disclosures to reveal and append a
 * Key-Binding JWT signed by the holder key, bound to aud + nonce.
 */
export function sdJwtPresent(opts: {
  sdjwt: string;
  revealNames: string[];
  holderKey: SigningKey;
  aud: string;
  nonce: string;
}): string {
  const parts = opts.sdjwt.split("~");
  const issuerJwt = parts[0];
  const allDisclosures = parts.slice(1).filter(Boolean);
  const kept = allDisclosures.filter((enc) => {
    const [, name] = JSON.parse(b64u.decode(enc).toString("utf8"));
    return opts.revealNames.includes(name);
  });
  const prefix = [issuerJwt, ...kept, ""].join("~");
  const sdHash = sha256b64u(prefix);
  const kbHeader: KbHeader = { alg: "ES256", typ: "kb+jwt" };
  const kbPayload = { iat: Math.floor(Date.now() / 1000), aud: opts.aud, nonce: opts.nonce, sd_hash: sdHash };
  const h = b64u.encode(JSON.stringify(kbHeader));
  const p = b64u.encode(JSON.stringify(kbPayload));
  const sig = es256Sign(`${h}.${p}`, opts.holderKey.privateKey);
  const kbJwt = `${h}.${p}.${b64u.encode(sig)}`;
  return prefix + kbJwt;
}

export interface SdJwtVerifyResult {
  claims: Record<string, unknown>; // issuer claims + revealed disclosures merged
  holderJwk: Jwk;
  issuerKid: string;
}

/**
 * Verify a presented SD-JWT+kb:
 *  1. issuer signature (resolve key by kid),
 *  2. each revealed disclosure's digest is present in `_sd`,
 *  3. holder key-binding signature over sd_hash + aud + nonce (replay defense),
 *  4. exp not passed.
 * Returns merged claims (issuer + disclosed).
 */
export function sdJwtVerify(
  presentation: string,
  resolveIssuerKey: (kid: string) => KeyObject | undefined,
  expect: { aud: string; nonce?: string }
): SdJwtVerifyResult {
  const parts = presentation.split("~");
  if (parts.length < 2) throw new Error("sdjwt: malformed");
  const issuerJwt = parts[0];
  const kbJwt = parts[parts.length - 1];
  const disclosures = parts.slice(1, -1).filter(Boolean);
  if (!kbJwt) throw new Error("sdjwt: key-binding JWT missing");

  // 1. issuer signature
  const [ih, ip, isig] = issuerJwt.split(".");
  const iheader = JSON.parse(b64u.decode(ih).toString("utf8")) as IssuerHeader;
  const ikey = resolveIssuerKey(iheader.kid);
  if (!ikey) throw new Error(`sdjwt: unknown issuer kid ${iheader.kid}`);
  if (!es256Verify(`${ih}.${ip}`, b64u.decode(isig), ikey)) throw new Error("sdjwt: issuer signature invalid");
  const payload = JSON.parse(b64u.decode(ip).toString("utf8")) as any;
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error("mandate_expired");

  // 2. disclosures must match digests in _sd
  const sdSet = new Set<string>(payload._sd ?? []);
  const claims: Record<string, unknown> = { ...payload };
  delete claims._sd;
  delete claims._sd_alg;
  for (const enc of disclosures) {
    const digest = sha256b64u(enc);
    if (!sdSet.has(digest)) throw new Error("sdjwt: disclosure not in _sd (tampered)");
    const [, name, value] = JSON.parse(b64u.decode(enc).toString("utf8"));
    claims[name] = value;
  }

  // 3. key-binding signature (holder proves possession + binds aud/nonce)
  const holderJwk: Jwk = { ...payload.cnf.jwk, kid: "holder" };
  const [kh, kp, ksig] = kbJwt.split(".");
  const kheader = JSON.parse(b64u.decode(kh).toString("utf8")) as KbHeader;
  if (kheader.typ !== "kb+jwt") throw new Error("sdjwt: bad kb typ");
  if (!es256Verify(`${kh}.${kp}`, b64u.decode(ksig), jwkToPublicKey(holderJwk)))
    throw new Error("sdjwt: key-binding signature invalid");
  const kbPayload = JSON.parse(b64u.decode(kp).toString("utf8")) as any;
  if (kbPayload.aud !== expect.aud) throw new Error(`sdjwt: kb aud mismatch (${kbPayload.aud})`);
  if (expect.nonce && kbPayload.nonce !== expect.nonce) throw new Error("sdjwt: kb nonce mismatch");
  const prefix = [issuerJwt, ...disclosures, ""].join("~");
  if (kbPayload.sd_hash !== sha256b64u(prefix)) throw new Error("sdjwt: sd_hash mismatch (presentation altered)");

  return { claims, holderJwk, issuerKid: iheader.kid };
}
