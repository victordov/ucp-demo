/**
 * HTTP Message Signatures per RFC 9421 (+ RFC 9530 Content-Digest),
 * as profiled by the UCP "Signatures" specification.
 *
 * Signed components for JSON-RPC POSTs:
 *   @method, @authority, @path, content-digest, content-type, ucp-agent, idempotency-key
 *
 * Identity model: the signer's UCP profile URL travels in the `UCP-Agent`
 * header; the verifier fetches `/.well-known/ucp`, finds the JWK by `kid`,
 * and verifies the ECDSA P-256 (raw r||s) signature. Pure PKI — no DIDs.
 */
import { KeyObject } from "node:crypto";
import { b64u, es256Sign, es256Verify, sha256, type SigningKey, type Jwk, jwkToPublicKey } from "./crypto.ts";

export interface SignedHeaders {
  "Content-Digest": string;
  "Signature-Input": string;
  Signature: string;
  "UCP-Agent": string;
  "Idempotency-Key": string;
  "Content-Type": string;
}

function buildSignatureBase(
  components: string[],
  values: Record<string, string>,
  params: string
): string {
  const lines = components.map((c) => `"${c}": ${values[c] ?? ""}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

export function signRequest(opts: {
  method: string;
  url: string; // full URL
  body: string;
  key: SigningKey;
  profileUrl: string; // signer's own UCP profile URL
  idempotencyKey: string;
}): SignedHeaders {
  const u = new URL(opts.url);
  const digest = `sha-256=:${sha256(opts.body).toString("base64")}:`;
  const ucpAgent = `profile="${opts.profileUrl}"`;
  const components = ["@method", "@authority", "@path", "content-digest", "content-type", "ucp-agent", "idempotency-key"];
  const params = `(${components.map((c) => `"${c}"`).join(" ")});created=${Math.floor(Date.now() / 1000)};keyid="${opts.key.kid}"`;
  const base = buildSignatureBase(
    components,
    {
      "@method": opts.method.toUpperCase(),
      "@authority": u.host,
      "@path": u.pathname,
      "content-digest": digest,
      "content-type": "application/json",
      "ucp-agent": ucpAgent,
      "idempotency-key": opts.idempotencyKey,
    },
    params
  );
  const sig = es256Sign(base, opts.key.privateKey);
  return {
    "Content-Digest": digest,
    "Signature-Input": `sig1=${params}`,
    Signature: `sig1=:${sig.toString("base64")}:`,
    "UCP-Agent": ucpAgent,
    "Idempotency-Key": opts.idempotencyKey,
    "Content-Type": "application/json",
  };
}

/**
 * Sign an HTTP RESPONSE per RFC 9421 — components use `@status` instead of
 * `@method`/`@authority`/`@path`. UCP RECOMMENDS this for complete_checkout
 * responses (order confirmation) and payment authorization responses.
 */
export function signResponse(opts: { status: number; body: string; key: SigningKey }): Record<string, string> {
  const digest = `sha-256=:${sha256(opts.body).toString("base64")}:`;
  const components = ["@status", "content-digest", "content-type"];
  const params = `(${components.map((c) => `"${c}"`).join(" ")});created=${Math.floor(Date.now() / 1000)};keyid="${opts.key.kid}"`;
  const base = buildSignatureBase(
    components,
    { "@status": String(opts.status), "content-digest": digest, "content-type": "application/json" },
    params
  );
  const sig = es256Sign(base, opts.key.privateKey);
  return {
    "Content-Digest": digest,
    "Signature-Input": `sig1=${params}`,
    Signature: `sig1=:${sig.toString("base64")}:`,
    "Content-Type": "application/json",
  };
}

/** Verify a signed response given the signer's already-resolved JWKs. */
export function verifyResponse(opts: {
  status: number;
  body: string;
  headers: Record<string, string | undefined>;
  keys: Jwk[];
}): { ok: boolean; error?: string; keyId?: string } {
  const sigInput = opts.headers["signature-input"];
  const sigHeader = opts.headers["signature"];
  const digest = opts.headers["content-digest"];
  if (!sigInput || !sigHeader) return { ok: false, error: "signature_missing" };
  const expected = `sha-256=:${sha256(opts.body).toString("base64")}:`;
  if (digest !== expected) return { ok: false, error: "digest_mismatch" };
  const m = sigInput.match(/^sig1=\((.*?)\)(.*)$/);
  if (!m) return { ok: false, error: "signature_invalid" };
  const components = m[1].split(" ").map((c) => c.replace(/"/g, ""));
  const params = `(${m[1]})${m[2]}`;
  const keyid = sigInput.match(/keyid="([^"]+)"/)?.[1];
  const jwk = opts.keys.find((k) => k.kid === keyid);
  if (!jwk) return { ok: false, error: "key_not_found" };
  const base = buildSignatureBase(
    components,
    {
      "@status": String(opts.status),
      "content-digest": digest ?? "",
      "content-type": opts.headers["content-type"]?.split(";")[0] ?? "",
    },
    params
  );
  const sm = sigHeader.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
  if (!sm) return { ok: false, error: "signature_invalid" };
  const ok = es256Verify(base, Buffer.from(sm[1], "base64"), jwkToPublicKey(jwk));
  return ok ? { ok: true, keyId: keyid } : { ok: false, error: "signature_invalid" };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  profileUrl?: string;
  keyId?: string;
}

export interface RequestLike {
  method: string;
  host: string; // authority
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export type ProfileFetcher = (profileUrl: string) => Promise<{ signing_keys: Jwk[] }>;

/** Verify an inbound signed request. Resolves the signer key via its UCP profile. */
export async function verifyRequest(req: RequestLike, fetchProfile: ProfileFetcher): Promise<VerifyResult> {
  try {
    const sigInput = req.headers["signature-input"];
    const sigHeader = req.headers["signature"];
    const ucpAgent = req.headers["ucp-agent"];
    const contentDigest = req.headers["content-digest"];
    const idem = req.headers["idempotency-key"];
    if (!sigInput || !sigHeader || !ucpAgent) return { ok: false, error: "signature_missing" };

    // 1. Content-Digest check (raw bytes, RFC 9530)
    const expected = `sha-256=:${sha256(req.rawBody).toString("base64")}:`;
    if (contentDigest !== expected) return { ok: false, error: "digest_mismatch" };

    // 2. Parse Signature-Input
    const m = sigInput.match(/^sig1=\((.*?)\)(.*)$/);
    if (!m) return { ok: false, error: "signature_invalid" };
    const components = m[1].split(" ").map((c) => c.replace(/"/g, ""));
    const params = `(${m[1]})${m[2]}`;
    const keyidMatch = sigInput.match(/keyid="([^"]+)"/);
    if (!keyidMatch) return { ok: false, error: "key_not_found" };
    const keyid = keyidMatch[1];

    // 3. Profile URL from UCP-Agent (RFC 8941 dictionary member)
    const pm = ucpAgent.match(/profile="([^"]+)"/);
    if (!pm) return { ok: false, error: "invalid_profile_url" };
    const profileUrl = pm[1];

    // 4. Fetch signer profile + key
    let profile;
    try {
      profile = await fetchProfile(profileUrl);
    } catch {
      return { ok: false, error: "profile_unreachable", profileUrl };
    }
    const jwk = (profile.signing_keys || []).find((k) => k.kid === keyid);
    if (!jwk) return { ok: false, error: "key_not_found", profileUrl, keyId: keyid };

    // 5. Rebuild signature base and verify
    const base = buildSignatureBase(
      components,
      {
        "@method": req.method.toUpperCase(),
        "@authority": req.host,
        "@path": req.path,
        "content-digest": contentDigest ?? "",
        "content-type": req.headers["content-type"]?.split(";")[0] ?? "",
        "ucp-agent": ucpAgent,
        "idempotency-key": idem ?? "",
      },
      params
    );
    const sm = sigHeader.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
    if (!sm) return { ok: false, error: "signature_invalid", profileUrl, keyId: keyid };
    const ok = es256Verify(base, Buffer.from(sm[1], "base64"), jwkToPublicKey(jwk));
    return ok
      ? { ok: true, profileUrl, keyId: keyid }
      : { ok: false, error: "signature_invalid", profileUrl, keyId: keyid };
  } catch (e: any) {
    return { ok: false, error: `signature_invalid: ${e.message}` };
  }
}
