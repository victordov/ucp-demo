# UCP + AP2 Reference Suite

A complete, working implementation of agentic commerce with the
**Universal Commerce Protocol (UCP, 2026-04-08)** and the
**Agent Payments Protocol (AP2)** across four applications:

| App | Port | Role | UI |
|---|---|---|---|
| **Shopping Agent** (`apps/shopping-agent`) | 4100 | UCP *Platform* / AP2 *Shopping Agent* — the "Shoppy" chat experience | http://localhost:4100 |
| **Merchant Portal** (`apps/merchant-portal`) | 4101 | Four UCP *Businesses* (multi-tenant) with the integrated *Merchant Agent* | http://localhost:4101 |
| **Credentials Provider** (`apps/credentials-provider`) | 4102 | AP2 *Credentials Provider* — wallet, user device key, tokenization | http://localhost:4102 |
| **Payment Provider** (`apps/payment-provider`) | 4103 | PSP / AP2 *Merchant Payment Processor* — mandate verification, authorize/capture | http://localhost:4103 |

Everything you see in the Shoppy UI's **Protocol trace** is a real wire
interaction — signed JSON-RPC requests, JWS mandates, verifications.

## Quick start

```bash
npm install
npm run dev          # starts all four services locally
npm run dev:ngrok    # starts services exposed via a single public ngrok/localtunnel gateway
# open http://localhost:4100 (or the tunnel URL) and shop — or click "Scenarios" to run any flow
npm run e2e          # end-to-end test (51 checks incl. spec compliance)
npm run validate     # deep schema conformance: live payloads vs OFFICIAL UCP JSON Schemas
npm run conformance  # category report mirroring the official conformance suite (28 checks)
```

### Public Tunnels (Ngrok / Localtunnel)

To expose the services over public HTTPS (required for testing WebAuthn/SPC passkeys on mobile or external devices, or doing remote testing), run:

```bash
npm run dev:ngrok
```

This starts a native reverse-proxy gateway on port `4099` that exposes only a single public endpoint via ngrok (falling back automatically to Localtunnel if the ngrok free limit is exceeded). It dynamically routes requests to local ports using path prefixes (e.g., `/merchant`, `/credentials`, `/payments`) while preserving HTTP message signatures.

### Demo scenarios (success, failure & feature flows)

The Shopping Agent ships a **scenario console** (the "Scenarios" button in the
UI, or `POST /api/scenario`). Each runs real signed protocol calls you can
watch in the trace:

| Success | Failure / attack | Capability |
|---|---|---|
| `happy` full purchase | `threeds` 3-D Secure step-up → resolve → retry | `cart` cart capability |
| `express` next-day shipping (totals change) | `decline` issuer hard-decline | `lookup` catalog `get_product` |
| `promo` discount code | `tamper` altered cart → nested-binding break | `refund` PSP refund + adjustment |
| `human_not_present` autonomous buy | `replay` idempotency / 409 | `dispute` AP2 mandate evidence |
| `rtp_rail` settle via RTP (multi-rail) | `expired` past-exp mandate | `identity` OAuth + scoped order history |
| `subscription` standing intent (2 cycles) | | `approval` inbox: blocked → user approves → completes |
| | `stolen_key` key not in profile | `late_delivery` agent detects slip → 10% refund |
| | `over_budget` per-tx cap refused at mint | |
| | `merchant_blocked` allowlist refused | |
| | `autonomy` human-not-present blocked by policy | |
| | `kya_blocked` suspended agent refused (KYA) | |
| | `velocity` 3 rapid buys → rate-limited | |
| | `hnp_over_cap` HNP buy over the **open Payment Mandate** `amount_range` → PSP rejects | |
| | `hnp_merchant_blocked` HNP buy outside the **open Checkout Mandate** `allowed_merchants` → merchant rejects | |

### Agent-economy controls (spend policy · KYA · multi-rail · audit)

Inspired by the payments industry's agentic-commerce frameworks (agentic
tokens, Know-Your-Agent, multi-rail settlement):

- **Spend controls & programmable payment** — the user's per-agent consent
  policy lives at the Credentials Provider (the trusted surface): autonomy
  level (*always ask · autonomous below a threshold · fully autonomous*),
  per-transaction cap, total budget with a live spent meter, merchant
  allowlist, validity window and preferred rail. Edit it in **Walletly →
  Agent permissions**. Enforced three times: at `mint_instrument` (the policy
  snapshot is **bound into the token**, like a network-enforced scope), at
  `sign_mandate` (PaymentMandate), and **re-checked by the PSP** from the
  token at authorization (defense in depth).
- **Open/closed mandates across parties (human-not-present)** — the agent
  presents the user-signed **Open Checkout Mandate** (`mandate.checkout.open.1`,
  `checkout.allowed_merchants` + `checkout.line_items`) and **Open Payment
  Mandate** (`mandate.payment.open.1`, `payment.amount_range` + `payment.reference`
  [+ `payment.agent_recurrence`]) alongside the **agent-signed** closed mandates.
  The **merchant** verifies the closed Checkout Mandate satisfies the open
  constraints; the **PSP** independently verifies the closed Payment Mandate
  against the open constraints (`open_checkout_mandate` / `open_payment_mandate`
  rows in both verification logs). Each open mandate is sender-constrained to the
  agent key via `cnf`. The signed amount ceiling = item budget + 20% fees
  headroom + $20 shipping.
- **Multi-rail settlement** — merchants and the wallet advertise two UCP
  `payment_handlers`: `com.google.pay` (card network token) and
  `com.paystream.rtp` (instant bank transfer from an RTP-capable checking
  account). The agent selects the rail per transaction: explicit choice >
  policy preference > auto (≥ $500 → RTP). The PSP records the rail and
  settles RTP instantly.
- **Know Your Agent (KYA) + reputation** — PayStream hosts an **agent
  registry** (`lookup_agent` tool): KYA level, status, and a behavior-driven
  reputation score (captures +1, declines −8, velocity −10). Merchants check
  the registry at completion and refuse suspended / low-reputation agents
  (`agent_untrusted`); the PSP enforces the same gate on the mandate's `agent`.
- **Velocity rules** — agent-native fraud control: the PSP rate-limits
  authorizations per agent over a rolling 60s window (`PSP_VELOCITY_LIMIT`,
  default 60). Exceeding it declines with `velocity_exceeded` and dings
  reputation.
- **Immutable audit trail** — every trace event is hash-chained
  (`seq`/`prev_hash`/`hash`); `POST /api/audit/verify` re-derives the chain and
  **Export evidence bundle** (chip after purchase) downloads a dispute-ready
  JSON: all signed mandates + the chained event log.
- **Approval workflow (human-in-the-loop)** — when a purchase exceeds the
  autonomy policy, the agent files an approval request instead of failing; it
  appears in **Walletly → Approval inbox** where the user approves/denies. An
  approval waives the autonomy gate for that checkout only (caps/budget/
  allowlist still apply). Scenario: `approval`.
- **Standing intent (recurring)** — scenario `subscription`: one signed Open
  Payment Mandate carrying a `payment.agent_recurrence` constraint (ON_DEMAND
  ×2) authorizes two autonomous purchase cycles; the PSP bounds the occurrence
  count and merchant + PSP verify the same open mandates each cycle.
- **OTel export** — set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
  and every protocol-trace event is exported as an OTLP/HTTP JSON span (one
  trace per session, `ucp.*` attributes incl. the audit-chain hash). Works
  with Tempo/Jaeger/any collector. `OTEL_SERVICE_NAME` overrides the service.
- **Operable dashboards** — Walletly: approval inbox, passkey management,
  token revocation, consent-audit log, mandate filtering. Merchant portal:
  per-tenant analytics, editable catalog (price/stock), Ship/Ship-LATE/Mark-
  delivered actions, buyer-agent KYA badge per order. PayStream: velocity +
  suspend/restore controls, traffic charts, transaction drill-in with decoded
  PaymentMandate and dashboard refunds. Shoppy: in-sheet payment-method
  picker, trace search/filter/copy, typed LLM replies with retry, friendly
  policy-error cards with fix-it links.
- **Post-purchase agency** — the agent monitors fulfillment after payment
  (**Check delivery promise** chip): it compares the carrier's expectation
  with the promise made at checkout and, if the ETA slipped, proactively
  secures a 10% partial refund (`late_delivery` scenario).

With `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set there are two LLM-driven modes:

- **LLM chat** (interactive, human-in-the-loop) — the default chat mode when a
  key is present. A real LLM drives the conversation turn by turn: it searches,
  presents options (clickable product cards), and adds items to the cart
  (`search_products → add_to_cart → open_checkout`). It does **not** pay — once
  the cart is ready it shows the **same checkout card + Google Pay flow as the
  scripted mode**, and you review and pay yourself. Toggle
  **📜 Scripted ⟷ 🤖 LLM chat** by the composer. Endpoint: `POST /api/chat`
  (conversation persists per session).
- **Autonomous agent** — `POST /api/agent` (or *Run LLM agent* in the scenario
  console): the model completes the whole purchase from a single goal, no
  turn-taking. This runs **human-not-present**: it mints the user-signed open
  mandates and signs the closed mandates itself. In chat, an explicit "just buy
  it for me" triggers the `buy_autonomously` tool (same flow).

Without a key, the chat uses the scripted deterministic flow (you click to pick
merchant, shipping and payment); intent parsing still works via regex.

**Human-present ⟷ human-not-present toggle (live flow, no LLM needed).** The
composer has a **🙋 Human-present / 🤝 Human-not-present** switch. In
human-not-present mode the agent signs an Open Checkout + Open Payment Mandate up
front (`POST /api/intent {human_present:false}` or `POST /api/mode`), then at pay
time signs the closed mandates itself and completes the purchase with no card tap
— the merchant and PSP verify the closed mandates satisfy the open constraints.
The `hnp_over_cap` and `hnp_merchant_blocked` scenarios show those constraints
being enforced.

`npm run validate` (services running) is the deep conformance gate: it loads
the **official UCP schema tree** vendored in `./schemas` (copied from the
`Universal-Commerce-Protocol/ucp` repo — the source of what ucp.dev serves),
resolves every `$ref` recursively, audits every ucp.dev URL referenced in our
code *and inside the live profile documents*, then runs the real purchase flow
and validates the raw wire artifacts with Ajv (draft 2020-12) against the
composed schemas per the spec's Resolution Flow:
business profiles → `profile.json#business_schema`, platform profile →
`profile.json#platform_schema`, checkout responses → `checkout.json` +
`fulfillment.json` + `ap2_mandate.json` `$defs` composition, catalog
responses → `catalog_search.json#search_response`, order webhooks →
`order.json`. External vendor URLs (e.g. the `com.google.pay` handler
spec/schema) are taken verbatim from the official spec's examples.

Optional LLM intent parsing — set either key before `npm run dev`:
`OPENAI_API_KEY` (uses `gpt-4o-mini`, override with `OPENAI_MODEL`) or
`ANTHROPIC_API_KEY` (uses Claude Haiku, override with `ANTHROPIC_MODEL`).
OpenAI is preferred if both are set; any LLM failure falls back to the
deterministic parser automatically.

## UCP spec compliance (2026-04-08)

**Profiles & discovery** (`/.well-known/ucp`):

- Profile documents use the spec structure: `{ "ucp": { "version",
  "services", "capabilities", "payment_handlers" }, "signing_keys": [...] }`.
- `ucp.services["dev.ucp.shopping"]` declares the **MCP transport** with its
  `endpoint`; platforms resolve endpoints from the profile, never hardcoded.
- Every capability entry carries the **required `spec` and `schema` URLs**,
  namespace-bound to `https://ucp.dev/...`; extensions declare `extends`
  (`fulfillment`, `ap2_mandate` → `checkout`).
- `payment_handlers` is a keyed registry (`com.google.pay` → handler
  instances with `id`, `available_instruments`, `config`).
- Profiles are served with `Cache-Control: public, max-age=300` (spec: public,
  ≥ 60s), and profile fetches use a 60s TTL floor, no redirects.
- The platform profile declares the order webhook in
  `capabilities["dev.ucp.shopping.order"][0].config.webhook_url`.

**Who exposes `/.well-known/ucp`:** every UCP *business* MUST (each merchant
tenant does, at `/m/{id}/.well-known/ucp`); the *platform* publishes a profile
so businesses can negotiate and verify it via the `UCP-Agent` header (we host
it at `/.well-known/ucp` too). The Credentials Provider and Payment Provider
are AP2 roles, not UCP businesses — they publish profiles in the same envelope
so peers can discover their **signing keys** (the user device key lives in the
CP profile, which is how merchants and the PSP verify mandates) and their MCP
endpoints.

**JSON-RPC 2.0 / MCP binding** (per `checkout-mcp` spec):

- All operations go through `tools/call` with the operation in `params.name`
  and the UCP payload in `params.arguments`. Implemented tools:
  checkout (`create/get/update/complete/cancel_checkout`),
  cart (`create/get/update/cancel_cart`),
  catalog (`search_catalog`, `lookup_catalog`, `get_product`),
  order (`get_order`), identity-linking (`list_orders`),
  post-order (`refund_order`, `file_dispute`).
- `arguments.meta["ucp-agent"].profile` is required on every request;
  `meta["idempotency-key"]` is required for `complete_checkout` /
  `cancel_checkout`. Identity binding is enforced: `meta` must agree with the
  signed `UCP-Agent` header.
- Responses use the **dual-output pattern**: payload in
  `result.structuredContent` plus serialized JSON in `result.content[]`;
  tool definitions declare `outputSchema` referencing the official UCP JSON
  Schemas. `initialize` and `tools/list` are implemented.
- Errors follow the spec registry: protocol errors as JSON-RPC `error` with
  `-32001` (discovery: `invalid_profile_url`, `profile_unreachable`) or
  `-32000` (`signature_missing`, `signature_invalid`, `key_not_found`,
  `profile_not_trusted`, AP2 mandate errors) with the matching **HTTP status
  as primary signal**; business outcomes (e.g. `item_unavailable`) as JSON-RPC
  `result` with a UCP error envelope, `messages[]` and `continue_url`.
- Idempotency keys reused with a different payload → **409**.

**Payload schemas** (validated against `ucp.dev/2026-04-08/schemas/...`):

- **Amounts are minor units (cents)** everywhere on the wire; converted to
  display dollars only at the UI boundary.
- Every checkout response carries the required `ucp` envelope with the
  **active capability registry** (response-relevant only) and
  `payment_handlers`.
- `totals` follows totals.json: exactly one `subtotal` and one `total`;
  discounts are **negative**; shipping uses type `fulfillment` with
  `display_text`.
- Fulfillment uses the extension structure: `methods[] → destinations[]
  (schema.org-style postal addresses) → groups[] → options[]`.
- Completed checkouts carry `order: { id, permalink_url, label }`
  (order_confirmation.json).
- `complete_checkout` includes reverse-domain `signals`
  (`dev.ucp.buyer_ip`, `dev.ucp.user_agent`).
- Order webhooks push a full **Order object** (order.json: `ucp`, `id`,
  `checkout_id`, `permalink_url`, `line_items`, `fulfillment.expectations` +
  `fulfillment.events`, post-order `adjustments`, `currency`, `totals`), signed
  per the signatures spec (webhooks MUST be signed). Events: `order.shipped`,
  `order.refunded`.
- **Response signing** (RFC 9421, `@status`): `complete_checkout` responses are
  signed by the merchant and verified by the platform (RECOMMENDED by the spec).

**Additional capabilities & extensions:**

- **Cart** (`dev.ucp.shopping.cart`): basket building before checkout intent.
- **Catalog lookup** (`dev.ucp.shopping.catalog.lookup`): `get_product` /
  `lookup_catalog` for full product detail; search is
  `dev.ucp.shopping.catalog.search`.
- **Discounts** (`dev.ucp.shopping.discount`): promo codes apply a negative
  discount line; invalid codes return a `warning` message (covered by the
  merchant_authorization signature).
- **Fulfillment options**: standard vs express; selecting express changes
  totals and re-issues the merchant signature (the closed Checkout Mandate is
  signed over the final terms at pay time).
- **Identity Linking** (`dev.ucp.common.identity_linking`): business-hosted
  OAuth 2.0 with RFC 8414 discovery; the agent links the account and reads
  order history via `list_orders`, gated by the `dev.ucp.shopping.order:read`
  scope.

**PKI (no DIDs):** ES256 (ECDSA P-256) keys published as JWKs (RFC 7517) in
profile `signing_keys`; RFC 9421 HTTP Message Signatures with RFC 9530
`Content-Digest` on every request and webhook (components: `@method`,
`@authority`, `@path`, `content-digest`, `content-type`, `ucp-agent`,
`idempotency-key`; raw `r||s` ECDSA encoding); key lookup via `kid` against
the signer's fetched profile; AP2 short-term trust registries (allowlists).

**AP2 mandates extension** (`dev.ucp.shopping.ap2_mandate`):

- Checkout responses embed `ap2.merchant_authorization` — a detached JWS
  (RFC 7515 App. F) over the **JCS-canonicalized (RFC 8785)** checkout
  excluding `ap2`; the platform verifies it before showing anything to the
  user.
- Human-present mandates (closed Checkout & Payment) are signed by the **device
  key** held at the Credentials Provider (trusted platform provider model).
  Human-not-present authorization uses user-signed **open** Checkout/Payment
  Mandates (`cnf`=agent key) under which the **agent** signs the closed mandates.
- The `ap2.checkout_mandate` is a **real SD-JWT+kb** verifiable credential
  (`dc+sd-jwt~kb`): the Credentials Provider is the **issuer**, the user's
  device key is the **holder** (a Key-Binding JWT, `typ=kb+jwt`, binds
  `aud`=merchant profile + `nonce`=checkout id + `sd_hash` to defeat replay),
  and **selective disclosure** reveals the user id while withholding the email.
  It embeds the full merchant-signed checkout (nested binding).
- `complete_checkout` is rejected without `ap2.checkout_mandate`
  (`mandate_required`) — the session is security-locked. The PSP independently
  verifies the closed Payment Mandate inside the AP2 composite token
  (amount/payee/checkout/expiry, plus — for human-not-present — the open Payment
  Mandate constraints and closed↔open binding) before pulling credentials from
  the CP against the single-use network token.
- **Real passkey / Touch ID user verification** (feature flag `PASSKEYS`, **on
  by default**). When the user enrolls a platform passkey, the checkout-mandate
  signature at the Credentials Provider is gated on a verified **WebAuthn**
  assertion (or **Secure Payment Confirmation** on Chrome) whose challenge is
  the SHA-256 of the JCS-canonicalized checkout — i.e. Touch ID over the exact
  signed terms (UV=1 is checked). This is how production wallets gate the device
  key. On `localhost` (a secure context) Safari/Chrome on macOS pop the native
  Touch ID sheet with no HTTPS certs. Users who don't enroll fall back to the
  simulated approval, so the demo is never blocked. The passkey assertion is
  stored with the order as additional dispute evidence. Disable with
  `PASSKEYS=0`; override the RP ID with `RP_ID=…` (default `localhost`).
- **Failure paths**: 3-D Secure step-up (PSP returns `requires_challenge` →
  checkout `requires_escalation` + `continue_url` → user resolves at the CP →
  retry with attestation), hard declines (`payment_declined` business outcome),
  refunds (`refund_order` → PSP `refund_payment` → order `adjustments` +
  `order.refunded` webhook), and disputes (`file_dispute` attaches the
  user-signed mandate chain as adjudicator evidence).

## The flow (mirrors the Shoppy demo)

1. **Discovery** — fetch `/.well-known/ucp` from all merchants; resolve MCP endpoints from `ucp.services`.
2. **Negotiation** — capability intersection per the spec algorithm (name + mutual version, orphaned-extension pruning); `ap2_mandate` present ⇒ security-locked.
3. **Authorization** *(AP2)* — *human-present:* none up front (the user approves the closed mandates at pay time). *Human-not-present:* the user device key signs **Open Checkout + Open Payment Mandates** (constraints + `cnf`=agent key).
4. **Federated `search_catalog`** — signed fan-out, offers merged per product, filtered by the user's constraints.
5. **`create_checkout` / `update_checkout`** — merchant returns signed checkouts; agent verifies `merchant_authorization` each time.
6. **Closed mandates** *(AP2)* — at pay time the **closed Checkout & Payment Mandates** are signed over the final terms: by the user device key (human-present) or by the agent key under the open mandates (human-not-present).
7. **Payment** — Google-Pay-style sheet → CP mints a single-use network token → biometric approval (human-present) → **Payment Mandate**.
8. **`complete_checkout`** — checkout mandate + composite token + signals; merchant → PSP verification chain; order created with permalink.
9. **Order webhook** — merchant pushes the signed Order object (auto-ships ~8s after purchase, or "Ship now" in the portal).

## Layout

```
packages/common/src/
  jcs.ts        RFC 8785 JSON canonicalization
  crypto.ts     ES256 keys, JWKs, compact + detached JWS
  sdjwt.ts      SD-JWT+kb (issue / present / verify) for the checkout mandate
  httpsig.ts    RFC 9421/9530 HTTP message signatures (request + response)
  jsonrpc.ts    UCP MCP binding: tools/call server+client, PKI, idempotency,
                trust registry, dual-output, response signing, spec errors
  ap2.ts        merchant_authorization + SD-JWT+kb checkout-mandate helpers
  types.ts      UCP/AP2 shared types · config.ts  service topology
apps/
  shopping-agent/       orchestrator + NLU + LLM agent loop + scenario runner
                        + Shoppy UI (chat, scenario console, receipt PDF) + SSE trace
  merchant-portal/      4 tenants: catalog/cart/checkout/order/refund/dispute tools,
                        AP2 verify, OAuth (identity linking), portal UI
  credentials-provider/ wallet, device-key SD-JWT issuance, tokenization,
                        3DS challenge resolution, wallet UI
  payment-provider/     mandate verification, authorize/capture/refund, 3DS, PSP UI
schemas/                vendored OFFICIAL UCP JSON Schema tree (source of truth)
conformance-official/   vendored official pytest conformance suite (REST, reference)
scripts/
  e2e.ts                51-check end-to-end incl. spec-compliance + negative tests
  validate-compliance.ts  Ajv validation of live payloads vs official schemas (20)
  conformance.ts        category report mirroring the official suite (28)
```

## Demo simplifications (documented deviations)

- Keys are generated in-memory at boot (no persistence/rotation), and
  transport is plain HTTP on localhost — the signature layer is still fully
  enforced. (Spec requires HTTPS in production.)
- "Biometric" approval at the Credentials Provider is simulated and audited;
  the 3-D Secure challenge page is a simulated bank surface.
- In-memory state only; restart = clean slate (as requested).
- Issuer/network authorization, declines and 3DS triggers inside the PSP are
  simulated (driven by the chosen test card).
- The official conformance suite (`conformance-official/`) targets the REST
  reference server; `npm run conformance` asserts the same categories against
  our MCP-transport services instead.
