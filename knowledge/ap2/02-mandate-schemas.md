# AP2 Mandate Schemas (exact)

From `ap2-protocol.org/ap2/checkout_mandate`, `.../payment_mandate`, and
`ucp.dev/latest/specification/ap2-mandates`. `*` = required.

## Checkout Mandate (closed) — `vct = mandate.checkout.1`

| field | req | SD? | notes |
|------|-----|-----|------|
| `vct`* | yes | no | `mandate.checkout.1` (closed) / `mandate.checkout.open.1` (open) |
| `checkout_jwt`* | yes | yes | base64url merchant-signed JWT of the Checkout payload (UCP Checkout object) |
| `checkout_hash`* | yes | no | base64url hash of `checkout_jwt` (alg = `_sd_alg` or sha-256) |
| `iat`, `exp` | no | no | unix epoch |

Closed presentation is a **kb+sd-jwt**; the KB-JWT payload carries `{iat, aud,
nonce, sd_hash, _sd_alg}`.

### Open Checkout Mandate — `vct = mandate.checkout.open.1`
Adds `cnf` (agent/holder pubkey) + `constraints[]`:
- `checkout.allowed_merchants` → `{type, allowed: Merchant[]}` (allowed is SD).
- `checkout.line_items` → `{type, items: LineItemRequirements[]}` where each is
  `{id, acceptable_items: Item[] (SD; exactly one must match), quantity}`.

## Payment Mandate (closed) — `vct = mandate.payment.1`

| field | req | notes |
|------|-----|------|
| `vct`* | yes | `mandate.payment.1` (closed) / `mandate.payment.open.1` (open) |
| `transaction_id`* | yes | base64url hash of the `checkout_jwt` (links payment↔checkout) |
| `payee`* | yes | `Merchant {id*, name*, website?}` |
| `payment_amount`* | yes | `Amount {amount* (minor units, int), currency* (ISO-4217)}` |
| `payment_instrument`* | yes | `PaymentInstrument {id*, type*, description?}` |
| `pisp` | no | `Pisp {legal_name*, brand_name*, domain_name*}` |
| `execution_date` | no | ISO-8601; absent ⇒ immediate |
| `risk_data` | no | risk signals captured by the Trusted Surface |
| `iat`, `exp` | no | unix epoch |

### Open Payment Mandate — `vct = mandate.payment.open.1`
`cnf` + `constraints[]`: `payment.agent_recurrence` (frequency enum
ON_DEMAND/DAILY/WEEKLY/BIWEEKLY/MONTHLY/QUARTERLY/ANNUALLY + max_occurrences),
`payment.allowed_payees`, `payment.allowed_payment_instruments`,
`payment.allowed_pisps`, `payment.amount_range` (currency+max[+min]),
`payment.budget` (max+currency), `payment.reference`
(conditional_transaction_id = digest of the open Checkout Mandate),
`payment.execution_date` (not_before/not_after).

## Receipts

**Checkout Receipt** (merchant-issued): `status*` (Success|Error), `iss*`,
`iat*`, `reference*` (hash of the closed mandate), then Success ⇒ `order_id*`,
Error ⇒ `error*` + `error_description*`.

**Payment Receipt** (MPP-issued): `status*`, `iss*`, `iat*`, `reference*`,
`payment_id*`, then Success ⇒ `psp_confirmation_id*` + `network_confirmation_id*`,
Error ⇒ `error*` + `error_description*`.

## UCP placement + `merchant_authorization`

- `ap2.merchant_authorization` (checkout response): JWS **detached content**
  (RFC 7515 App F), pattern `^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$`, header
  `{alg∈{ES256,ES384,ES512}, kid}`, signature over `header + JCS(checkout minus
  ap2)`. Excludes the whole `ap2` field from the signed payload.
- `ap2.checkout_mandate` (complete request): SD-JWT+kb, pattern
  `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(~[A-Za-z0-9_-]+)*$`.
- `payment.instruments[*].credential.token`: carries the payment mandate
  (composite token).

This repo ships its own copy of the extension schema at
`schemas/shopping/ap2_mandate.json` (matches the published one: the two `$defs`
`merchant_authorization` + `checkout_mandate`, the `error_code` enum, and the
`ucp_request: { create: omit, update: omit, complete: required }` rule on `ap2`).

## Error code enum (UCP extension)
`mandate_required`, `agent_missing_key`, `mandate_invalid_signature`,
`mandate_expired`, `mandate_scope_mismatch`, `merchant_authorization_invalid`,
`merchant_authorization_missing`.
