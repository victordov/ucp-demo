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
 * - payment_mandate: SD-JWT+kb signed by the user's device key, bound to the
 *   signed checkout (transaction_id = hash of the merchant-signed checkout).
 */
import {
  jwsSignDetached,
  jwsVerifyDetached,
  jwsSignCompact,
  jwsVerifyCompact,
  jwkToPublicKey,
  b64u,
  sha256,
  type SigningKey,
  type Jwk,
} from "./crypto.ts";
import { jcsBytes } from "./jcs.ts";
import { sdJwtVerify, sdJwtIssue, sdJwtPresent } from "./sdjwt.ts";
import type {
  Checkout,
  Ap2Merchant,
  Ap2PaymentInstrument,
  Pisp,
  Money,
  CheckoutConstraint,
  PaymentConstraint,
  OpenCheckoutMandatePayload,
  OpenPaymentMandatePayload,
} from "./types.ts";
import { KeyObject } from "node:crypto";

/** Strip the `ap2` field — the merchant signature never covers it. */
export function checkoutSigningPayload(checkout: Checkout): Omit<Checkout, "ap2"> {
  const { ap2: _ap2, ...rest } = checkout;
  return rest;
}

/**
 * Canonical checkout hash: base64url SHA-256 of the JCS-canonicalized checkout
 * (excluding `ap2`) — i.e. the exact merchant-signed terms. Used as the
 * WebAuthn/SPC user-verification challenge.
 */
export function checkoutHash(checkout: Checkout): string {
  return b64u.encode(sha256(jcsBytes(checkoutSigningPayload(checkout))));
}

/**
 * The AP2 `checkout_jwt`: the merchant-signed JWT of the Checkout payload
 * (AP2 checkout_mandate.json — required, selectively disclosable). Reconstructed
 * in attached compact form from the UCP detached `merchant_authorization`
 * (`<header>..<sig>` over `<header>.<JCS(checkout − ap2)>`) by re-inserting the
 * canonical payload — so the same merchant signature verifies, and the JWT
 * payload IS the merchant-signed Checkout object (per the UCP integration note
 * "this MUST be the Checkout object").
 */
export function checkoutJwt(checkout: Checkout): string {
  const ma = checkout.ap2?.merchant_authorization;
  if (!ma) throw new Error("merchant_authorization_missing");
  const [h, s] = ma.split("..");
  if (!h || !s) throw new Error("merchant_authorization_malformed");
  const payload = b64u.encode(jcsBytes(checkoutSigningPayload(checkout)));
  return `${h}.${payload}.${s}`;
}

/**
 * AP2 `checkout_hash` / Payment Mandate `transaction_id`: base64url SHA-256 of
 * the `checkout_jwt` value (binds the Checkout & Payment Mandates to the exact
 * merchant-signed checkout). Per checkout_mandate.json / payment_mandate.json.
 */
export function checkoutJwtHash(jwt: string): string {
  return b64u.encode(sha256(jwt));
}

/**
 * WebAuthn/SPC challenge for user verification of a checkout. Identical to the
 * checkout hash: a passkey assertion over it proves the user (Touch ID, UV=1)
 * approved THESE terms, not just "something".
 */
export function checkoutUvChallenge(checkout: Checkout): string {
  return checkoutHash(checkout);
}

/**
 * Hash of a closed mandate (SD-JWT+kb presentation string), used as a receipt
 * `reference`. base64url SHA-256 over the presentation, per the AP2 dispute
 * rules ("calculated in the same manner as the sd_hash").
 */
export function hashClosedMandate(presentation: string): string {
  return b64u.encode(sha256(presentation));
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

/** AP2 closed Checkout Mandate `vct` (exact match required per the AP2 spec). */
export const CHECKOUT_MANDATE_VCT = "mandate.checkout.1";
/** AP2 closed Payment Mandate `vct` (exact match required per the AP2 spec). */
export const PAYMENT_MANDATE_VCT = "mandate.payment.1";
/** AP2 Open Checkout Mandate `vct` (human-not-present authorization). */
export const OPEN_CHECKOUT_MANDATE_VCT = "mandate.checkout.open.1";
/** AP2 Open Payment Mandate `vct` (human-not-present authorization). */
export const OPEN_PAYMENT_MANDATE_VCT = "mandate.payment.open.1";

export interface CheckoutMandateClaims {
  vct: string; // AP2 Verifiable Credential Type — MUST be CHECKOUT_MANDATE_VCT
  // --- AP2 checkout_mandate.json required fields ---
  checkout_jwt: string; // merchant-signed JWT of the Checkout payload
  checkout_hash: string; // base64url hash of checkout_jwt
  iat?: number;
  exp?: number;
  // --- operational / convenience claims (permitted extras: the schema sets no
  //     additionalProperties:false) ---
  iss?: string; // issuer profile URL (CP for human-present; agent for human-not-present)
  sub?: string; // user identifier (selectively disclosable)
  checkout?: Checkout; // full checkout INCLUDING ap2.merchant_authorization (for verify/trace)
  /** Human-not-present only: base64url digest of the user-signed open Checkout
   *  Mandate this closed mandate satisfies. Absent in the direct flow. */
  open_checkout_mandate?: string;
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
  // AP2 negotiated ⇒ ONLY an SD-JWT+kb presentation is accepted (no legacy
  // plain-JWS path: that would skip holder key binding / replay defense).
  const { claims } = sdJwtVerify(presentation, resolveIssuerKey, expect);
  const c = claims as unknown as CheckoutMandateClaims;
  if (c.vct !== CHECKOUT_MANDATE_VCT) throw new Error(`mandate_invalid_signature: unexpected vct ${c.vct}`);
  // AP2 checkout_mandate.json: checkout_jwt + checkout_hash are required, and
  // checkout_hash MUST be the base64url hash of checkout_jwt.
  if (!c.checkout_jwt) throw new Error("checkout_jwt missing in mandate");
  if (!c.checkout_hash) throw new Error("checkout_hash missing in mandate");
  if (c.checkout_hash !== checkoutJwtHash(c.checkout_jwt))
    throw new Error("mandate_scope_mismatch: checkout_hash ≠ hash(checkout_jwt)");
  return c;
}

/* ------------------------------------------------------------------ */
/* Open mandates (human-not-present) — v0.2 open/closed model          */
/* ------------------------------------------------------------------ */

/** base64url SHA-256 digest of an open-mandate JWS — used to bind a closed
 *  mandate to the open mandate it satisfies (and as payment.reference). */
export function openMandateDigest(jws: string): string {
  return b64u.encode(sha256(jws));
}

/** True if `agentJwk` is the key named in an open mandate's `cnf` claim. */
export function cnfMatchesKey(cnf: { jwk: Jwk } | undefined, agentJwk: Jwk): boolean {
  const j = cnf?.jwk;
  return !!j && j.kty === agentJwk.kty && j.crv === agentJwk.crv && j.x === agentJwk.x && j.y === agentJwk.y;
}

/* ---- constraint builders ---- */

export function allowedMerchantsConstraint(merchants: Ap2Merchant[]): CheckoutConstraint {
  return { type: "checkout.allowed_merchants", allowed: merchants };
}
export function lineItemsConstraint(
  items: { id: string; acceptable_items: { id: string; title: string }[]; quantity: number }[]
): CheckoutConstraint {
  return { type: "checkout.line_items", items };
}
export function amountRangeConstraint(currency: string, max: number, min?: number): PaymentConstraint {
  return { type: "payment.amount_range", currency, max, ...(min != null ? { min } : {}) };
}
export function budgetConstraint(max: number, currency: string): PaymentConstraint {
  return { type: "payment.budget", max, currency };
}
export function agentRecurrenceConstraint(
  frequency: "ON_DEMAND" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY",
  max_occurrences?: number
): PaymentConstraint {
  return { type: "payment.agent_recurrence", frequency, ...(max_occurrences != null ? { max_occurrences } : {}) };
}
export function allowedPayeesConstraint(merchants: Ap2Merchant[]): PaymentConstraint {
  return { type: "payment.allowed_payees", allowed: merchants };
}
export function allowedPaymentInstrumentsConstraint(instruments: Ap2PaymentInstrument[]): PaymentConstraint {
  return { type: "payment.allowed_payment_instruments", allowed: instruments };
}
export function allowedPispsConstraint(pisps: Pisp[]): PaymentConstraint {
  return { type: "payment.allowed_pisps", allowed: pisps };
}
export function executionDateConstraint(window: { not_before?: string; not_after?: string }): PaymentConstraint {
  return { type: "payment.execution_date", ...window };
}
export function paymentReferenceConstraint(conditionalTransactionId: string): PaymentConstraint {
  return { type: "payment.reference", conditional_transaction_id: conditionalTransactionId };
}

/** Match merchants by `id` (preferred), else by `name` + `website` (AP2 SDK rule). */
function merchantMatches(allowed: Ap2Merchant, target: { id?: string; name?: string; website?: string }): boolean {
  if (allowed.id && target.id) return allowed.id === target.id;
  return !!allowed.name && allowed.name === target.name && !!allowed.website && allowed.website === target.website;
}

/* ---- constraint evaluation (closed satisfies open) ---- */

export interface ConstraintResult {
  ok: boolean;
  checked: string[]; // human-readable summaries of satisfied constraints
  error?: string; // first failing constraint, if any
}

/**
 * Evaluate the Open Checkout Mandate constraints against a concrete checkout.
 * Implements `checkout.allowed_merchants` and a single-checkout form of
 * `checkout.line_items` (each requirement satisfied by one acceptable SKU at the
 * required quantity). The spec's multi-checkout maximal-flow form is a superset.
 */
export function evaluateCheckoutConstraints(
  checkout: Checkout,
  open: OpenCheckoutMandatePayload
): ConstraintResult {
  const checked: string[] = [];
  const merchantId = checkout.merchant_id ?? "";
  for (const c of open.constraints) {
    if (c.type === "checkout.allowed_merchants") {
      const ok = c.allowed.some((m) => m.id === merchantId || (!!m.website && m.website.includes(`/m/${merchantId}`)));
      if (!ok) return { ok: false, checked, error: `merchant ${merchantId} not in allowed_merchants` };
      checked.push(`allowed_merchants ✓ (${merchantId})`);
    } else if (c.type === "checkout.line_items") {
      const lines = (checkout.line_items ?? []) as any[];
      for (const req of c.items) {
        const acceptableIds = new Set(req.acceptable_items.map((i) => i.id));
        // Resolve the product/SKU id across shapes: UCP checkout line items use
        // `item.id`; the spec's example uses `product.id`. The line's own `id`
        // is a fallback only.
        const skuOf = (li: any) => li.item?.id ?? li.product?.id ?? li.item_id ?? li.id;
        const qtyOf = (li: any) => (typeof li.quantity === "object" ? li.quantity?.total ?? 1 : li.quantity ?? 1);
        const qty = lines
          .filter((li) => acceptableIds.has(skuOf(li)))
          .reduce((n, li) => n + qtyOf(li), 0);
        if (qty < req.quantity)
          return { ok: false, checked, error: `line_items requirement ${req.id} unmet (have ${qty}, need ${req.quantity})` };
      }
      checked.push(`line_items ✓ (${c.items.length} requirement(s))`);
    }
  }
  return { ok: true, checked };
}

/**
 * Evaluate the Open Payment Mandate constraints against a concrete charge.
 * `occurrence` (1-based) and `priorSpend` enable agent_recurrence / budget checks.
 */
export function evaluatePaymentConstraints(
  charge: {
    amount: Money;
    payee: Ap2Merchant;
    payment_instrument?: Ap2PaymentInstrument;
    pisp?: Pisp;
    execution_date?: string;
    openCheckoutDigest?: string;
  },
  open: OpenPaymentMandatePayload,
  ctx: { occurrence?: number; priorSpend?: number } = {}
): ConstraintResult {
  const checked: string[] = [];
  for (const c of open.constraints) {
    if (c.type === "payment.amount_range") {
      if (c.currency !== charge.amount.currency)
        return { ok: false, checked, error: `currency ${charge.amount.currency} ≠ ${c.currency}` };
      if (charge.amount.amount > c.max) return { ok: false, checked, error: `amount ${charge.amount.amount} exceeds max ${c.max}` };
      if (c.min != null && charge.amount.amount < c.min)
        return { ok: false, checked, error: `amount ${charge.amount.amount} below min ${c.min}` };
      checked.push(`amount_range ✓ (≤ ${c.max})`);
    } else if (c.type === "payment.budget") {
      // budget.max is in MAJOR units (per AP2 SDK: budget_max_cents = max * 100);
      // amounts are minor units → compare in cents.
      const budgetMinor = Math.round(c.max * 100);
      const total = (ctx.priorSpend ?? 0) + charge.amount.amount;
      if (total > budgetMinor) return { ok: false, checked, error: `cumulative spend ${total} exceeds budget ${budgetMinor}` };
      checked.push(`budget ✓ (${total} ≤ ${budgetMinor})`);
    } else if (c.type === "payment.agent_recurrence") {
      if (c.max_occurrences != null && (ctx.occurrence ?? 1) > c.max_occurrences)
        return { ok: false, checked, error: `occurrence ${ctx.occurrence} exceeds max ${c.max_occurrences}` };
      checked.push(`agent_recurrence ✓ (${c.frequency}${c.max_occurrences != null ? ` ×${c.max_occurrences}` : ""})`);
    } else if (c.type === "payment.allowed_payees") {
      if (!c.allowed.some((m) => merchantMatches(m, charge.payee)))
        return { ok: false, checked, error: `payee ${charge.payee.id} not in allowed_payees` };
      checked.push(`allowed_payees ✓ (${charge.payee.id})`);
    } else if (c.type === "payment.allowed_payment_instruments") {
      if (charge.payment_instrument && !c.allowed.some((i) => i.id === charge.payment_instrument!.id))
        return { ok: false, checked, error: `instrument ${charge.payment_instrument.id} not in allowed_payment_instruments` };
      checked.push("allowed_payment_instruments ✓");
    } else if (c.type === "payment.allowed_pisps") {
      if (charge.pisp && !c.allowed.some((p) => p.domain_name === charge.pisp!.domain_name && p.legal_name === charge.pisp!.legal_name && p.brand_name === charge.pisp!.brand_name))
        return { ok: false, checked, error: `pisp ${charge.pisp.domain_name} not in allowed_pisps` };
      checked.push("allowed_pisps ✓");
    } else if (c.type === "payment.execution_date") {
      const d = charge.execution_date;
      if (d && c.not_before && d < c.not_before) return { ok: false, checked, error: `execution_date ${d} before ${c.not_before}` };
      if (d && c.not_after && d > c.not_after) return { ok: false, checked, error: `execution_date ${d} after ${c.not_after}` };
      checked.push("execution_date ✓");
    } else if (c.type === "payment.reference") {
      if (charge.openCheckoutDigest && c.conditional_transaction_id !== charge.openCheckoutDigest)
        return { ok: false, checked, error: "payment.reference does not match the open Checkout Mandate" };
      checked.push("payment.reference ✓");
    }
  }
  return { ok: true, checked };
}

/* ---- open mandate signing + verification ---- */

/** Sign an Open Checkout/Payment Mandate as a user-key compact JWS (issued by the
 *  Credentials Provider's user device key). Sender-constrained to the agent `cnf`. */
export function signOpenMandate(
  payload: OpenCheckoutMandatePayload | OpenPaymentMandatePayload,
  userKey: SigningKey
): string {
  return jwsSignCompact(payload, userKey, "ap2-open-mandate+jwt");
}

export function verifyOpenCheckoutMandate(
  jws: string,
  resolveUserKey: (kid: string) => KeyObject | undefined
): OpenCheckoutMandatePayload {
  const { payload } = jwsVerifyCompact(jws, resolveUserKey);
  const p = payload as OpenCheckoutMandatePayload;
  if (p.vct !== OPEN_CHECKOUT_MANDATE_VCT) throw new Error(`mandate_invalid_signature: unexpected vct ${p.vct}`);
  if (p.exp && p.exp * 1000 < Date.now()) throw new Error("mandate_expired");
  return p;
}

export function verifyOpenPaymentMandate(
  jws: string,
  resolveUserKey: (kid: string) => KeyObject | undefined
): OpenPaymentMandatePayload {
  const { payload } = jwsVerifyCompact(jws, resolveUserKey);
  const p = payload as OpenPaymentMandatePayload;
  if (p.vct !== OPEN_PAYMENT_MANDATE_VCT) throw new Error(`mandate_invalid_signature: unexpected vct ${p.vct}`);
  if (p.exp && p.exp * 1000 < Date.now()) throw new Error("mandate_expired");
  return p;
}

/* ---- agent-signed closed mandates (human-not-present) ---- */

/**
 * Issue a CLOSED Checkout Mandate signed by the AGENT key (human-not-present):
 * a self-issued SD-JWT+kb (issuer = holder = agent key) bound to aud=merchant +
 * nonce=checkout id, carrying the open Checkout Mandate digest. Verified with the
 * same `verifyCheckoutMandate` path (the issuer kid resolves to the agent key).
 */
export function agentSignCheckoutMandate(
  claims: Omit<CheckoutMandateClaims, "vct">,
  agentKey: SigningKey,
  bind: { aud: string; nonce: string }
): string {
  const { sdjwt } = sdJwtIssue({
    claims: { vct: CHECKOUT_MANDATE_VCT, ...claims },
    disclosable: {},
    issuerKey: agentKey,
    holderJwk: agentKey.publicJwk,
  });
  return sdJwtPresent({ sdjwt, revealNames: [], holderKey: agentKey, aud: bind.aud, nonce: bind.nonce });
}

/** Issue a CLOSED Payment Mandate signed by the AGENT key (human-not-present). */
export function agentSignPaymentMandate(
  claims: Record<string, unknown>,
  agentKey: SigningKey,
  bind: { aud: string; nonce: string }
): string {
  const { sdjwt } = sdJwtIssue({
    claims: { vct: PAYMENT_MANDATE_VCT, ...claims },
    disclosable: {},
    issuerKey: agentKey,
    holderJwk: agentKey.publicJwk,
  });
  return sdJwtPresent({ sdjwt, revealNames: [], holderKey: agentKey, aud: bind.aud, nonce: bind.nonce });
}
