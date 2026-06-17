# AP2 Knowledge Base (for `ucp-demo-connectit`)

Reference + compliance notes for **Google's Agent Payments Protocol (AP2)** and
the **UCP "AP2 Mandates" extension** (`dev.ucp.shopping.ap2_mandate`), captured
from primary sources and checked against THIS repo's code.

Sources verified on 2026-06-13:
- `https://github.com/google-agentic-commerce/AP2` (README, docs, schemas)
- `https://ap2-protocol.org/` — specification, checkout_mandate, payment_mandate
- `https://ucp.dev/documentation/ucp-and-ap2/` and
  `https://ucp.dev/latest/specification/ap2-mandates/` (the extension this repo implements)

## Files

| File | Contents |
|------|----------|
| `01-ap2-reference.md` | What AP2 is, the 5 roles, modes, the mandate model, and the **UCP AP2 Mandates** REST flow + crypto requirements (the profile this repo targets). |
| `02-mandate-schemas.md` | Exact schemas: Checkout Mandate, Payment Mandate, Receipts, `merchant_authorization`, constraints, error codes. |
| `03-compliance-review.md` | **Gap analysis of THIS repo** against AP2 + the UCP extension, with file/line citations, severity, and concrete fixes. |

## TL;DR verdict (post-fix, 2026-06-13)

`ucp-demo-connectit` is now a **conformant** implementation of the **UCP AP2
Mandates extension** for the **human-present, closed-checkout** flow. The hard
parts were already real and correct (ES256 + JCS RFC 8785, detached-JWS
`merchant_authorization`, an SD-JWT+kb Checkout Mandate with key binding +
selective disclosure + passkey/WebAuthn UV, discovery/negotiation/security-locking,
the `complete_checkout` chain with spec error codes, independent PSP
re-verification). The following gaps have since been **implemented and verified**:

1. ✅ Both mandates now carry and enforce the required **`vct`**.
2. ✅ The **Payment Mandate is now an SD-JWT+kb** with the AP2 schema
   (`payment_amount`, `payee` Merchant, `payment_instrument`, `transaction_id`).
3. ✅ Payment↔checkout binding is now the cryptographic **checkout hash**
   (`transaction_id`), verified by the PSP.
4. ✅ AP2 **Checkout Receipt** (merchant) and **Payment Receipt** (PSP) are
   issued and signed (success path).
6. ✅ The legacy **plain-JWS** verify branch is removed; full-terms matching
   (incl. line items) at `complete_checkout`.

Remaining by design: **#5** autonomous/open-mandate mode (Direct mode only), and
error-path receipts. See `03-compliance-review.md` for citations + verification.

## Important: which repo is which

- **`ucp-demo-connectit`** (this repo, TypeScript) = the **UCP + AP2**
  implementation. This is "our AP2."
- **`agentic-commerce-protocol-demo`** (sibling repo, Java/Spring) = the
  **OpenAI/Stripe ACP** demo (HMAC + Shared Payment Token). It contains **no
  AP2** by design. Its `knowledge/ap2/` folder reviewed *that* repo and
  correctly found "no AP2 here" — but it is the wrong repo for the AP2 question.
