/**
 * Delegate SD-JWT (dSD-JWT) chains — AP2's mandate VDC format
 * (draft-gco-oauth-delegate-sd-jwt-00, mirrored from the AP2 Python SDK
 * `ap2/sdk/sdjwt/`). A chain is two hops:
 *
 *   root SD-JWT  ~~  terminal kb+sd-jwt
 *
 * - **root** (the OPEN mandate): issuer-signed by the user device key. Its
 *   `delegate_payload[0]` is the mandate object, itself a disclosure; the
 *   selectively-disclosable constraint-array elements (`allowed`,
 *   `acceptable_items`) are nested disclosures referenced as `{"...": digest}`.
 *   It carries `cnf.jwk` = the agent key authorized to sign the next hop.
 * - **terminal** (the CLOSED mandate): `typ:"kb+sd-jwt"`, signed by the agent
 *   (the previous hop's `cnf.jwk`), carrying `iat/aud/nonce` and `sd_hash` =
 *   hash of the root token — the cryptographic chaining the spec requires.
 *
 * Verification walks the chain: root verified by its issuer key; the terminal
 * verified by the root's `cnf.jwk`, with `sd_hash` bound to the root.
 *
 * NOTE: disclosures use Python `json.dumps` default separators (`", "`, `": "`)
 * so digests line up with the AP2 SDK's wire format. Cross-verification against
 * the Python reference verifier is not exercised in this repo's test harness.
 */
import { createHash, randomBytes, KeyObject } from "node:crypto";
import { b64u, es256Sign, es256Verify, jwkToPublicKey, type SigningKey, type Jwk } from "./crypto.ts";

const SD_ALG = "sha-256";
const sha256AsciiB64u = (s: string) => b64u.encode(createHash("sha256").update(Buffer.from(s, "ascii")).digest());

/** Python `json.dumps` default serialization (separators ", " / ": "). The
 *  digest is taken over this exact byte string, so it must match the issuer. */
function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  // undefined array elements serialize as null (matches JSON.stringify).
  if (Array.isArray(v)) return "[" + v.map((x) => pyJson(x)).join(", ") + "]";
  if (typeof v === "object") {
    // Omit keys whose value is undefined (matches JSON.stringify / Python dicts).
    return (
      "{" +
      Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .map(([k, val]) => `${JSON.stringify(k)}: ${pyJson(val)}`)
        .join(", ") +
      "}"
    );
  }
  return "null";
}

const salt = () => b64u.encode(randomBytes(16));
/** Array-element disclosure: base64url(JSON([salt, value])). The value is
 *  normalized through a JSON round-trip so it is exactly what a verifier will
 *  reconstruct (drops `undefined`, plain JSON only). */
function discloseArrayElement(value: unknown): { disclosure: string; digest: string } {
  const clean = value === undefined ? null : JSON.parse(JSON.stringify(value));
  const disclosure = b64u.encode(pyJson([salt(), clean]));
  return { disclosure, digest: sha256AsciiB64u(disclosure) };
}

type SdKeySet = Set<string>;

/** Replace each element of any `allowed`/`acceptable_items` (etc.) array with a
 *  `{"...": digest}` reference, collecting the element disclosures. Recursive. */
function digestizeSdArrays(obj: unknown, sdKeys: SdKeySet, out: string[]): unknown {
  if (Array.isArray(obj)) return obj.map((x) => digestizeSdArrays(x, sdKeys, out));
  if (obj && typeof obj === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (sdKeys.has(k) && Array.isArray(v)) {
        r[k] = v.map((el) => {
          const d = discloseArrayElement(el);
          out.push(d.disclosure);
          return { "...": d.digest };
        });
      } else {
        r[k] = digestizeSdArrays(v, sdKeys, out);
      }
    }
    return r;
  }
  return obj;
}

function signJwt(header: object, payload: object, key: SigningKey): string {
  const h = b64u.encode(JSON.stringify(header));
  const p = b64u.encode(JSON.stringify(payload));
  const sig = es256Sign(`${h}.${p}`, key.privateKey);
  return `${h}.${p}.${b64u.encode(sig)}`;
}

export interface DToken {
  issuerJwt: string;
  disclosures: string[];
  /** standalone compact form with trailing `~` (used for sd_hash binding). */
  sdJwt: string;
  /** chain segment: issuerJwt~disc~disc (no trailing `~`). */
  segment: string;
  header: any;
  payload: any;
}

function makeToken(issuerJwt: string, disclosures: string[]): DToken {
  const sdJwt = issuerJwt + "~" + (disclosures.length ? disclosures.join("~") + "~" : "");
  const segment = disclosures.length ? issuerJwt + "~" + disclosures.join("~") : issuerJwt;
  const [h, p] = issuerJwt.split(".");
  return { issuerJwt, disclosures, sdJwt, segment, header: JSON.parse(b64u.decode(h).toString("utf8")), payload: JSON.parse(b64u.decode(p).toString("utf8")) };
}

/** Issue the ROOT open mandate as a delegate SD-JWT (signed by `issuerKey`). The
 *  `mandate` MUST include `cnf.jwk` (the agent key authorized for the next hop). */
export function issueDelegateRoot(mandate: Record<string, unknown>, sdKeys: string[], issuerKey: SigningKey): DToken {
  const disclosures: string[] = [];
  const sdMandate = digestizeSdArrays(mandate, new Set(sdKeys), disclosures);
  const md = discloseArrayElement(sdMandate); // mandate is delegate_payload[0]
  disclosures.push(md.disclosure);
  const payload = { delegate_payload: [{ "...": md.digest }], _sd_alg: SD_ALG };
  const header = { alg: "ES256", kid: issuerKey.kid, typ: "dc+sd-jwt" };
  return makeToken(signJwt(header, payload, issuerKey), disclosures);
}

/** Issue the TERMINAL closed mandate (typ kb+sd-jwt) signed by `signerKey` (the
 *  agent / previous hop's cnf key), bound to `prev` via `sd_hash`. */
export function issueDelegateTerminal(
  mandate: Record<string, unknown>,
  signerKey: SigningKey,
  prev: { sdJwt: string }, // the root token's standalone sd-jwt (CP returns this)
  bind: { aud: string; nonce: string }
): DToken {
  const md = discloseArrayElement(mandate);
  const payload = {
    delegate_payload: [{ "...": md.digest }],
    _sd_alg: SD_ALG,
    iat: Math.floor(Date.now() / 1000),
    aud: bind.aud,
    nonce: bind.nonce,
    sd_hash: sha256AsciiB64u(prev.sdJwt),
  };
  const header = { alg: "ES256", kid: signerKey.kid, typ: "kb+sd-jwt" };
  return makeToken(signJwt(header, payload, signerKey), [md.disclosure]);
}

/** Serialize a [root, terminal] chain as `seg0~~seg1`. */
export function serializeChain(tokens: DToken[]): string {
  return tokens.map((t) => t.segment).join("~~");
}

/** Join already-serialized hop segments (cross-service: CP returns the root
 *  segment, the agent appends its terminal segment). */
export function joinChain(segments: string[]): string {
  return segments.join("~~");
}

/** A token is a dSD-JWT chain (vs a plain SD-JWT+kb) iff it has the `~~` hop join. */
export function isChain(token: string | undefined): boolean {
  return !!token && token.includes("~~");
}

/* ----------------------------- verification ----------------------------- */

function verifyJwtSig(issuerJwt: string, key: KeyObject): { header: any; payload: any } {
  const [h, p, s] = issuerJwt.split(".");
  if (!s) throw new Error("dsdjwt: malformed issuer JWT");
  const header = JSON.parse(b64u.decode(h).toString("utf8"));
  if (header.alg !== "ES256") throw new Error(`dsdjwt: unsupported alg ${header.alg}`);
  if (!es256Verify(`${h}.${p}`, b64u.decode(s), key)) throw new Error("mandate_invalid_signature: dsdjwt signature invalid");
  return { header, payload: JSON.parse(b64u.decode(p).toString("utf8")) };
}

const digestIndex = (disclosures: string[]) => new Map(disclosures.map((d) => [sha256AsciiB64u(d), d]));

/** Recursively resolve `{"...": digest}` array refs from the disclosure set. */
function resolveRefs(v: unknown, idx: Map<string, string>): unknown {
  if (Array.isArray(v)) {
    return v.map((el) => {
      if (el && typeof el === "object" && "..." in (el as any)) {
        const disc = idx.get((el as any)["..."]);
        if (!disc) return el; // withheld disclosure — left as a ref
        const [, value] = JSON.parse(b64u.decode(disc).toString("utf8"));
        return resolveRefs(value, idx);
      }
      return resolveRefs(el, idx);
    });
  }
  if (v && typeof v === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) r[k] = resolveRefs(val, idx);
    return r;
  }
  return v;
}

/** Resolve the single delegate_payload[0] mandate object for a verified token. */
function resolveDelegate(payload: any, disclosures: string[]): any {
  const idx = digestIndex(disclosures);
  const dp = payload?.delegate_payload;
  if (!Array.isArray(dp) || !dp[0]) throw new Error("dsdjwt: missing delegate_payload");
  const ref = dp[0];
  const digest = ref && typeof ref === "object" ? ref["..."] : undefined;
  if (!digest) throw new Error("dsdjwt: delegate_payload[0] is not a disclosure ref");
  const disc = idx.get(digest);
  if (!disc) throw new Error("mandate_invalid_signature: delegate disclosure missing");
  const [, mandate] = JSON.parse(b64u.decode(disc).toString("utf8"));
  return resolveRefs(mandate, idx);
}

function cnfKeyOf(mandate: any): Jwk | undefined {
  const j = mandate?.cnf?.jwk;
  return j ? { kty: j.kty, crv: j.crv, x: j.x, y: j.y, kid: j.kid ?? "cnf" } : undefined;
}

export interface VerifiedChain {
  open: any; // resolved root (open) mandate
  closed: any; // resolved terminal (closed) mandate
  cnf: Jwk; // agent key the open mandate authorized
  rootSdJwt: string; // the root token's standalone sd-jwt (for cross-chain digests)
}

/**
 * Verify a two-hop dSD-JWT chain: root signature (via `resolveRootKey`), then
 * the terminal signature via the root's `cnf.jwk`, the `sd_hash` binding, and
 * aud/nonce. Returns the resolved open + closed mandate objects.
 */
export function verifyDelegateChain(
  chain: string,
  resolveRootKey: (kid: string) => KeyObject | undefined,
  expect: { aud: string; nonce: string }
): VerifiedChain {
  const segs = chain.split("~~");
  if (segs.length !== 2) throw new Error(`dsdjwt: expected a 2-hop chain, got ${segs.length}`);
  const [rootTok, termTok] = segs.map((seg) => {
    const parts = seg.split("~");
    return makeToken(parts[0], parts.slice(1).filter(Boolean));
  });

  // 1. Root: verify issuer signature + resolve the open mandate.
  const rootKey = resolveRootKey(rootTok.header.kid);
  if (!rootKey) throw new Error(`agent_missing_key: unknown root kid ${rootTok.header.kid}`);
  verifyJwtSig(rootTok.issuerJwt, rootKey);
  const open = resolveDelegate(rootTok.payload, rootTok.disclosures);
  const cnf = cnfKeyOf(open);
  if (!cnf) throw new Error("mandate_invalid_signature: open mandate missing cnf.jwk");

  // 2. Terminal: typ + signature under the root's cnf key + sd_hash binding.
  if (termTok.header.typ !== "kb+sd-jwt") throw new Error(`mandate_invalid_signature: terminal typ ${termTok.header.typ}`);
  verifyJwtSig(termTok.issuerJwt, jwkToPublicKey(cnf));
  const expectedSdHash = sha256AsciiB64u(rootTok.sdJwt);
  if (termTok.payload.sd_hash !== expectedSdHash) throw new Error("mandate_scope_mismatch: sd_hash does not bind to the open mandate");
  if (termTok.payload.aud !== expect.aud) throw new Error(`mandate_scope_mismatch: aud ${termTok.payload.aud}`);
  if (termTok.payload.nonce !== expect.nonce) throw new Error("mandate_scope_mismatch: nonce mismatch");
  const closed = resolveDelegate(termTok.payload, termTok.disclosures);
  return { open, closed, cnf, rootSdJwt: rootTok.sdJwt };
}

/** Verify only the root open mandate (no chain) — used when re-reading the open
 *  mandate's constraints independently. */
export function verifyDelegateRoot(chain: string, resolveRootKey: (kid: string) => KeyObject | undefined): any {
  const rootSeg = chain.split("~~")[0];
  const parts = rootSeg.split("~");
  const tok = makeToken(parts[0], parts.slice(1).filter(Boolean));
  const key = resolveRootKey(tok.header.kid);
  if (!key) throw new Error(`agent_missing_key: unknown root kid ${tok.header.kid}`);
  verifyJwtSig(tok.issuerJwt, key);
  return resolveDelegate(tok.payload, tok.disclosures);
}
