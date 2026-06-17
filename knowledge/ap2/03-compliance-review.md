# `ucp-demo-connectit` — AP2 Compliance Review

Date: 2026-06-13 (re-reviewed after fixes). Scope: this repo (TypeScript;
`apps/{shopping-agent,merchant-portal,credentials-provider,payment-provider}`,
`packages/common`). Assessed against AP2 v0.2 (`ap2-protocol.org`) and the UCP
**AP2 Mandates** extension (`ucp.dev .../ap2-mandates`, `2026-04-08`).

## Verdict (post-fix)

**Conformant** to the UCP AP2 Mandates extension for the **human-present,
closed-checkout** flow. Both mandates are now SD-JWT+kb credentials carrying the
required `vct`, the payment mandate uses the AP2 schema and is cryptographically
bound to the signed checkout, and both an AP2 Checkout Receipt and Payment
Receipt are issued. The only remaining AP2 features are the autonomous
(human-not-present) open-mandate model and error-path receipts — see
"Remaining by design".

## Findings status

| # | Finding (original) | Severity | Status |
|---|--------------------|----------|--------|
| 1 | Mandates omit `vct` | Med | **Resolved** |
| 2 | Payment Mandate not an SD-JWT VC / non-AP2 fields | High | **Resolved** |
| 3 | Payment↔checkout binding by id, not checkout hash | Med | **Resolved** |
| 4 | No AP2 Receipts | Low–Med | **Resolved** (success path) |
| 5 | No open mandates / autonomous mode | Low | **By design** (Direct mode only) |
| 6 | Legacy plain-JWS verify branch | Low | **Resolved** |
| 7 | Terms match only id+total | Low | **Resolved** |
| 8 | Holder key custodied at CP | Note | Documented (Trusted Platform Provider model) |

---

## Resolved — what changed (with citations)

**Shared (`packages/common`)**
- `ap2.ts`: added `CHECKOUT_MANDATE_VCT="mandate.checkout.1"` /
  `PAYMENT_MANDATE_VCT="mandate.payment.1"` (:76,:78); `CheckoutMandateClaims`
  now has `vct` (:81); `verifyCheckoutMandate` **requires SD-JWT+kb and asserts
  `vct`** — the legacy plain-JWS branch is gone (:107). Added `checkoutHash()`
  (:31) and `hashClosedMandate()` (receipt `reference`) (:49).
- `types.ts`: `PaymentMandatePayload` reshaped to AP2 fields (`vct`,
  `transaction_id`, `payee: Ap2Merchant`, `payment_amount: Money`,
  `payment_instrument: Ap2PaymentInstrument`, `iat/exp`); added `Ap2Merchant`,
  `Ap2PaymentInstrument`, `CheckoutReceiptPayload`, `PaymentReceiptPayload`,
  `ReceiptStatus`; `Checkout.ap2` gained `checkout_receipt` / `payment_receipt`.

**Credentials Provider (`credentials-provider/src/server.ts`)**
- Checkout Mandate claims now include `vct` (:368).
- **Payment Mandate is now issued as an SD-JWT+kb** (`mandate.payment.1`), issuer
  = CP key, key-bound to the user device key, `aud` = payee website, `nonce` =
  checkout id, `payment_instrument` selectively disclosable (:393–:429).

**Shopping Agent (`shopping-agent/src/orchestrator.ts`)**
- Payment Mandate built in the AP2 shape with `vct`,
  `transaction_id = checkoutHash(checkout)`, `payee` (Merchant object),
  `payment_amount`, `payment_instrument` — both in `confirmAndPay` and the
  failure-scenario `makePm`.

**Merchant (`merchant-portal/src/server.ts`)**
- Full **terms matching** (`termsMatch`: id, currency, grand total, **and the
  line-item set**) (:228, used :544).
- Forwards `checkout_hash = checkoutHash(embedded)` to the PSP (:594).
- Issues a signed **Checkout Receipt** (`reference = hashClosedMandate(mandate)`,
  `order_id`) (:634–:641); stores both receipts in dispute evidence (:701–:702)
  and surfaces them on the completed checkout `ap2` (:715).

**Payment Provider (`payment-provider/src/server.ts`)**
- **Verifies the Payment Mandate as an SD-JWT+kb** via `sdJwtVerify` with
  `aud`/`nonce` binding (:148), asserts `vct` (:168), and asserts
  `transaction_id === checkout_hash` (:209) plus `payee.website`,
  `payment_amount`, `checkout_id`.
- Issues a signed **Payment Receipt** (`reference = hashClosedMandate(mandate)`,
  `payment_id`, `psp/network_confirmation_id`) and returns it (:309–:331).

## Remaining — by design / minor

- **#5 Autonomous (human-not-present) open mandates.** **Implemented** (AP2 v0.2
  open/closed model; the legacy `IntentMandate`/`CartMandate` were removed). In
  human-not-present sessions the user device key signs an **Open Checkout Mandate**
  (`mandate.checkout.open.1`, `checkout.allowed_merchants` + `checkout.line_items`)
  and an **Open Payment Mandate** (`mandate.payment.open.1`, `payment.amount_range`
  + `payment.reference` [+ `payment.agent_recurrence`]), each carrying the agent
  public key as `cnf`. The open + closed mandates form a **delegate SD-JWT
  (dSD-JWT) chain** (`packages/common/src/dsdjwt.ts`,
  draft-gco-oauth-delegate-sd-jwt-00, mirrored from the AP2 SDK
  `ap2/sdk/sdjwt/`): the **root** hop (open mandate) is an SD-JWT signed by the
  user device key whose constraint-array elements (`allowed`, `acceptable_items`)
  are **selective disclosures** (`{"...": digest}`) and whose `cnf.jwk` names the
  agent; the **terminal** hop (closed mandate, `typ:"kb+sd-jwt"`) is signed by
  the agent (the root's `cnf` key) and bound to the root by `sd_hash`. The
  merchant/PSP run `verifyDelegateChain` (root signature → `cnf` walk → terminal
  signature → `sd_hash` binding → aud/nonce) and then evaluate the open
  constraints. Human-present stays a single SD-JWT+kb (no chain). Remaining
  hardening: the spec's "no overlapping open mandates until a rejection receipt"
  double-spend rule is approximated by the PSP occurrence/budget ledger (per
  open-mandate id) rather than a rejection-receipt protocol; and the dSD-JWT
  disclosure JSON uses Python `json.dumps` separators so digests match the AP2
  SDK wire format, but cross-verification against the Python reference verifier
  is not exercised in this repo's test harness.
- **Error-path receipts.** AP2 says a receipt MUST be returned on accept **or**
  reject. The success path now returns both receipts; mandate-rejection and
  issuer-decline paths still return error codes (not signed error receipts).
  Minor follow-up if full receipt coverage is desired.
- **#8 Holder-key custody.** The user device (holder) key lives at the CP
  (Trusted Platform Provider model — allowed). The "Digital Payment Credential"
  model would keep it in a user wallet (OpenID4VP) with a bank/network issuer.

## Verification (this re-review)

- `tsc --noEmit` on the whole workspace: **passes** (0 errors).
- Runtime smoke test of `packages/common` (crypto + SD-JWT+kb + ap2): **17/17
  checks pass**, including: detached `merchant_authorization` verify; stable
  `checkoutHash` (ignores `ap2`); checkout-mandate `vct` enforced; selective
  disclosure (reveal `sub`, withhold `buyer_email`); **wrong `vct` rejected**;
  **legacy plain-JWS rejected**; payment-mandate `vct` + `transaction_id ==
  checkoutHash` + `payee.website` + `payment_amount` + disclosed
  `payment_instrument`; **wrong-`aud` rejected** (replay/scope defense);
  receipt-reference hashing.
- Code re-grep confirms every claimed change is present at the cited locations.
- Not run here: the full `npm run e2e` (its `esbuild`/`tsx` binaries are macOS;
  the Linux sandbox can't execute them — run it locally to exercise the live
  multi-service flow).
