# AP2 + UCP AP2 Mandates — Reference

Verified against `ap2-protocol.org` (specification, v0.2) and
`ucp.dev/latest/specification/ap2-mandates` (UCP `2026-04-08`).

## What AP2 is

AP2 is a **security/authorization layer**, *not* a commerce protocol. It does
not run a catalog or a checkout API — it rides on a commerce protocol (UCP is
the canonical pairing; A2A is the other). It secures two things with
**Verifiable Digital Credentials (VDCs / SD-JWTs)** called *mandates*:

- **what** is bought → **Checkout Mandate** (+ Checkout Receipt)
- the **payment** for it → **Payment Mandate** (+ Payment Receipt)

The two are linked to the exact merchant-signed checkout so price/cart can't
change mid-flow.

## The 5 roles

| Role | Responsibility | Agentic? |
|------|----------------|----------|
| **Shopping Agent (SA)** | discovery, build checkout, execute purchase, present mandates | expected agentic (LLM) |
| **Credential Provider (CP)** | source of payment credentials; verifies the agent may use a credential; scopes it; verifies Payment Mandate | MAY be either |
| **Merchant (M)** | provides/completes checkout; guarantees inventory/pricing; signs the checkout; verifies Checkout Mandate; issues Checkout Receipt | MAY be either |
| **Merchant Payment Processor (MPP)** | processes payment; verifies the credential is scoped to the checkout; issues Payment Receipt | MAY be either |
| **Trusted Surface (TS)** | UI trusted to capture informed user consent and create the **user-signed** mandate | **MUST be non-agentic** |

One entity MAY play several roles. All mandate validation MUST be deterministic
code (never the LLM).

## Modes

- **Direct (Human Present):** user sees and approves the *closed* checkout +
  payment. Closed mandate signature validated as the user's (User Credential /
  trusted Agent-Provider key, e.g. via SD-JWT key binding).
- **Autonomous (Human Not Present):** user approves **open mandates**
  (constraints) up front; these carry the agent public key as a `cnf` claim. The
  SA then assembles a *closed* checkout/payment and signs with its **agent key**;
  verifiers check the closed mandate satisfies the open constraints. Rule: the SA
  **MUST NOT** present overlapping open mandates until it gets a rejection
  receipt (double-spend guard); MUST present only the disclosures needed.

Verifiers always receive a **closed** Checkout + Payment Mandate; mode only
changes how the signature/constraints are checked.

## Mandate model (key normative points)

- Each mandate identifies its schema with a **`vct`** claim carrying a version
  suffix (`mandate.checkout.1`, `mandate.checkout.open.1`, `mandate.payment.1`,
  `mandate.payment.open.1`). **Implementations MUST match the exact `vct`
  string incl. version.**
- **Checkout Mandate** binds to a **merchant-signed checkout JWT** via
  `checkout_hash` (base64url hash of the checkout JWT; alg = `_sd_alg` or
  sha-256). When used with UCP the signed checkout payload MUST be the UCP
  Checkout object.
- **Payment Mandate** binds to the checkout via `transaction_id` = hash of the
  checkout JWT.
- The merchant-signed checkout JWT **MUST** use a **non-deterministic** signature
  (ECDSA/ES256), not Ed25519, to prevent rainbow-table attacks on the hash.
- Mandates are secured as **SD-JWT** (other VDC formats allowed). Closed mandates
  use **key binding (`+kb`)**: a holder-signed KB-JWT over `{iat, aud, nonce,
  sd_hash}` defeats replay.
- **Receipts** (Checkout & Payment) MUST be returned by M / MPP, signed, with
  `reference` = hash of the closed mandate.

## The UCP "AP2 Mandates" extension (what THIS repo implements)

`dev.ucp.shopping.ap2_mandate` extends `dev.ucp.shopping.checkout`. It defines
*where* mandates go in UCP requests/responses; the credential structure itself
is per the AP2 spec.

**Discovery & negotiation**
1. Business advertises `dev.ucp.shopping.ap2_mandate` in `/.well-known/ucp`
   `capabilities`, with `config.vp_formats_supported` (e.g. `"dc+sd-jwt": {}`),
   and publishes `signing_keys[]` (JWK).
2. Platform advertises its profile (incl. `signing_keys` for the trusted-platform
   model).
3. If `ap2_mandate` is in the capability **intersection**, the session is
   **Security Locked**: neither party may revert to an unprotected flow.

**Cryptographic requirements** (per UCP "Message Signatures")
- Algorithms: **ES256 (required)**, ES384, ES512.
- Canonicalization: **JCS (RFC 8785)**.
- Key format: **JWK (RFC 7517)**; key discovery via `signing_keys[]` in
  `/.well-known/ucp`.

**Step 1 — Checkout creation & signing (business).** The business returns the
Checkout with `ap2.merchant_authorization` = a **detached-content JWS**
(RFC 7515 App F), format `<header>..<signature>`, header `{alg, kid}`, signature
over `header + base64url(JCS(checkout WITHOUT the ap2 field))`. The platform
**MUST** verify this before showing the checkout to the user.

**Step 2 — User consent & mandate generation (platform).** On consent the
platform produces two mandates:
- `ap2.checkout_mandate` = **SD-JWT+kb**, containing the **full checkout incl.
  `ap2.merchant_authorization`** (nested binding: platform sig covers business
  sig). Two trust models: *Trusted Platform Provider* (platform signs on the
  user's behalf) or *Digital Payment Credential* (user wallet signs via
  OpenID4VP, key binding to a bank/network-issued credential).
- `payment_mandate` placed at `payment.instruments[*].credential.token`
  (composite token).

**Step 3 — Submission (`complete_checkout`).** Platform sends
`{ payment.instruments[...], ap2.checkout_mandate }`.

**Verification & processing**
- Business: if AP2 negotiated and `ap2.checkout_mandate` missing →
  `mandate_required`. Verify SD-JWT signature + key binding + expiry; extract
  embedded checkout; **verify the embedded `merchant_authorization` is its own
  valid signature**; confirm embedded terms match the live session (id, totals,
  line items).
- PSP: verify the `payment_mandate` in the token per AP2 (signature, expiry,
  correlation with the checkout).

**Error codes (enum):** `mandate_required`, `agent_missing_key`,
`mandate_invalid_signature`, `mandate_expired`, `mandate_scope_mismatch`,
`merchant_authorization_invalid`, `merchant_authorization_missing`.

## AP2 vs ACP vs UCP (one line each)

- **ACP** (OpenAI/Stripe): a commerce + lightweight HTTP-trust protocol (HMAC
  signature, Shared Payment Token). Different vendor, different layer. This is
  what the sibling `agentic-commerce-protocol-demo` implements.
- **UCP**: the commerce protocol (catalog/checkout/order). The rails.
- **AP2**: the cryptographic trust layer that rides on UCP (or A2A). The signed
  consent. This repo = UCP + AP2.
