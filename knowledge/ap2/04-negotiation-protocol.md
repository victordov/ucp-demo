# UCP Negotiation Protocol — compliance + changes

Audited `ucp-demo-connectit` against
https://ucp.dev/2026-04-08/specification/overview/#negotiation-protocol on
2026-06-13, then implemented the gaps.

## Already compliant (before this pass)

- **Profile advertisement** — every request carries `meta["ucp-agent"].profile`
  + the `UCP-Agent` header (`jsonrpc.ts` `callTool`, `httpsig.ts` `signRequest`).
- **Discovery + caching** — `fetchUcpProfile` caches with a 60s TTL floor. The
  spec's caching guidance says cache with a **minimum 60s floor regardless of
  Cache-Control**, so a fixed 60s cache is compliant.
- **Platform-side intersection** — `orchestrator.ts` computed name + version
  intersection with orphan pruning.
- **Response `ucp` field** — all business responses include `ucp.version` +
  `ucp.capabilities` (+ `payment_handlers`).
- **Most error codes** — `profile_unreachable` (424/-32001),
  `signature_missing/invalid` + `key_not_found` (401/-32000), `digest_mismatch`
  (400/-32600), 401/403/409/500, idempotency 409, velocity 429. `continue_url`
  on business errors. RFC 9421 signatures end-to-end.
- **Schema resolution/composition + validation** — `scripts/validate-compliance.ts`
  loads the vendored official schemas, composes the checkout schema via `allOf`
  ($defs[root] per active extension) and validates live payloads (`npm run validate`).

## Gaps found → implemented

1. **Namespace validation (platform MUST).** New `validateCapabilityNamespaces` /
   `pruneInvalidNamespaces` (`negotiation.ts`): each business capability's `spec`
   & `schema` URL origin must equal its reverse-domain authority
   (`dev.ucp.*` → `https://ucp.dev`). The agent validates this during discovery
   and drops offenders before negotiation (new "Namespace Validation" trace).
2. **Business-side capability intersection (business MUST).** The merchant now
   computes the platform↔business intersection per request and exposes it as
   `ctx.negotiation`; an empty intersection → **`capabilities_incompatible`**
   (200 / JSON-RPC result). Wired via `mcpHandler` options
   `businessCapabilities` + `enforceNegotiation` (merchant only — inter-service
   endpoints like the PSP/CP are peer calls, not platform negotiation).
3. **Spec-exact intersection algorithm.** New shared `intersectCapabilities`
   (`negotiation.ts`): name match → **highest mutual version** → transitive
   orphan-extension pruning (single- and multi-parent). Used by both the agent
   and the merchant.
4. **Runtime schema resolution (platform MUST, "before requests").** New
   `apps/shopping-agent/src/schema-resolver.ts` loads the vendored schemas,
   composes the checkout schema (base + active extension `$defs` via `allOf`),
   and validates the checkout response. Emitted as "Schema Resolution" +
   "Schema Validation · checkout" traces in the flow.
5. **Error codes completed** (`negotiation.ts` `UCP_ERROR_STATUS` + `mcpHandler`):
   - `invalid_profile_url` now **400**/-32001 (+ URL-format validation).
   - `profile_malformed` **422**/-32001 (platform profile shape validation).
   - `version_unsupported` **422**/-32001 (platform protocol version mismatch).
   - `capabilities_incompatible` **200**/result.
   - `algorithm_unsupported` **400**/-32600 (verifier now rejects non-ES256 `alg`).
6. **Retry-After.** 429/503 responses now set the `Retry-After` header and
   `error.data.retry_after` (`mcpHandler`).

## Files

- `packages/common/src/negotiation.ts` (new) — intersection, namespace,
  profile validation, error-status table.
- `apps/shopping-agent/src/schema-resolver.ts` (new) — runtime fetch+compose+validate.
- `packages/common/src/jsonrpc.ts` — business negotiation, error taxonomy, Retry-After.
- `packages/common/src/httpsig.ts` — `algorithm_unsupported`.
- `apps/shopping-agent/src/orchestrator.ts` — namespace validation, shared intersect, schema traces.
- `apps/merchant-portal/src/server.ts` — `businessCapabilities` + `enforceNegotiation`.

## Verification

- `tsc --noEmit`: passes (0 errors).
- Negotiation unit smoke test: **23/23** (intersection incl. version selection +
  multi-parent + transitive pruning; namespace authority; profile validation;
  error-status mapping).
- Schema-resolver smoke test: loads 87 vendored schemas, composes the
  checkout+ap2_mandate+fulfillment chain, validates correctly.
- Live UI re-run requires restarting `npm run dev` (the dev servers don't
  hot-reload) to see the new "Namespace Validation" / "Schema Resolution" /
  "Schema Validation" trace cards.
