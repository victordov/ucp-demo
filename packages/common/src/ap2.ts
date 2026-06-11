/**
 * AP2 Mandates extension helpers (dev.ucp.shopping.ap2_mandate).
 *
 * - merchant_authorization: detached JWS over JCS(checkout minus `ap2`)
 * - checkout_mandate: a real SD-JWT+kb credential — ISSUED by the Credentials
 *   Provider (issuer key) and KEY-BOUND to the user's device key (holder).
 *   It embeds the FULL checkout incl. merchant_authorization (nested binding:
 *   user's key-binding signature covers the issuer's signature over the
 *   merchant's signature) and is bound by audience (merchant profile) + nonce
 *   (checkout id) to defeat replay.
 * - payment_mandate: JWS signed by the user's device key, bound to the cart mandate.
 */
import { jwsSignDetached, jwsVerifyDetached, jwsVerifyCompact, jwkToPublicKey, b64u, sha256, type SigningKey, type Jwk } from "./crypto.ts";
import { jcsBytes } from "./jcs.ts";
import { sdJwtVerify } from "./sdjwt.ts";
import type { Checkout } from "./types.ts";
import { KeyObject } from "node:crypto";

/** Strip the `ap2` field — the merchant signature never covers it. */
export function checkoutSigningPayload(checkout: Checkout): Omit<Checkout, "ap2"> {
  const { ap2: _ap2, ...rest } = checkout;
  return rest;
}

/**
 * WebAuthn/SPC challenge for user verification of a checkout: the base64url
 * SHA-256 of the JCS-canonicalized checkout (excluding `ap2`) — i.e. the exact
 * merchant-signed terms. A passkey assertion over this challenge proves the
 * user (Touch ID, UV=1) approved THESE terms, not just "something".
 */
export function checkoutUvChallenge(checkout: Checkout): string {
  return b64u.encode(sha256(jcsBytes(checkoutSigningPayload(checkout))));
}

export function signMerchantAuthorization(checkout: Checkout, merchantKey: SigningKey): Checkout {
  const jws = jwsSignDetached(checkoutSigningPayload(checkout), merchantKey);
  return { ...checkout, ap2: { ...(checkout.ap2 ?? {}), merchant_authorization: jws } };
}

export function verifyMerchantAuthorization(
  checkout: Checkout,
  merchantKeys: Jwk[]
): { ok: boolean; kid?: string; error?: string } {
  const jws = checkout.ap2?.merchant_authorization;
  if (!jws) return { ok: false, error: "merchant_authorization_missing" };
  try {
    const { header } = jwsVerifyDetached(jws, checkoutSigningPayload(checkout), (kid) => {
      const jwk = merchantKeys.find((k) => k.kid === kid);
      return jwk ? jwkToPublicKey(jwk) : undefined;
    });
    return { ok: true, kid: header.kid };
  } catch (e: any) {
    return { ok: false, error: `merchant_authorization_invalid: ${e.message}` };
  }
}

export interface CheckoutMandateClaims {
  iss: string; // credentials provider profile URL (issuer)
  sub?: string; // user identifier (selectively disclosable)
  iat: number;
  exp: number;
  cart_mandate_id: string;
  intent_mandate_id?: string;
  checkout: Checkout; // full checkout INCLUDING ap2.merchant_authorization
  human_present?: boolean;
}

/**
 * Verify the SD-JWT+kb checkout mandate.
 * @param presentation  the `ap2.checkout_mandate` SD-JWT+kb string
 * @param resolveIssuerKey  resolves the CP issuer key by kid (from CP profile)
 * @param expect  audience (this merchant's profile URL) + nonce (checkout id)
 */
export function verifyCheckoutMandate(
  presentation: string,
  resolveIssuerKey: (kid: string) => KeyObject | undefined,
  expect: { aud: string; nonce: string }
): CheckoutMandateClaims {
  // Backward-compat: a plain compact JWS (no `~`) is verified the legacy way.
  if (!presentation.includes("~")) {
    const { payload } = jwsVerifyCompact(presentation, resolveIssuerKey);
    const claims = payload as CheckoutMandateClaims;
    if (claims.exp * 1000 < Date.now()) throw new Error("mandate_expired");
    if (!claims.checkout?.ap2?.merchant_authorization) throw new Error("merchant_authorization_missing in mandate");
    return claims;
  }
  const { claims } = sdJwtVerify(presentation, resolveIssuerKey, expect);
  const c = claims as unknown as CheckoutMandateClaims;
  if (!c.checkout?.ap2?.merchant_authorization) throw new Error("merchant_authorization_missing in mandate");
  return c;
}
