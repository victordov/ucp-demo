/**
 * Shopping Agent orchestrator — drives the full UCP + AP2 flow with REAL
 * protocol calls over the UCP MCP binding (JSON-RPC 2.0 `tools/call`,
 * PKI-signed per RFC 9421) against the Merchant Portal, Credentials Provider
 * and (indirectly) Payment Provider.
 *
 * Platform conformance implemented here:
 *  - Discovery via /.well-known/ucp; endpoint resolution from ucp.services.
 *  - Capability intersection per the spec's algorithm (name + mutual version,
 *    orphaned-extension pruning).
 *  - merchant_authorization verification BEFORE showing checkouts to the user.
 *  - dev.ucp.* signals on complete_checkout.
 *  - Amounts in minor units on the wire; converted to display dollars only at
 *    the UI boundary.
 */
import { randomId, generateSigningKey, sha256, b64u, type SigningKey } from "../../../packages/common/src/crypto.ts";
import { callTool, fetchUcpProfile } from "../../../packages/common/src/jsonrpc.ts";
import { verifyResponse } from "../../../packages/common/src/httpsig.ts";
import {
  verifyMerchantAuthorization,
  checkoutUvChallenge,
  checkoutHash,
  checkoutJwt,
  checkoutJwtHash,
  openMandateDigest,
  allowedMerchantsConstraint,
  lineItemsConstraint,
  amountRangeConstraint,
  budgetConstraint,
  agentRecurrenceConstraint,
  allowedPaymentInstrumentsConstraint,
  paymentReferenceConstraint,
  OPEN_CHECKOUT_MANDATE_VCT,
  OPEN_PAYMENT_MANDATE_VCT,
} from "../../../packages/common/src/ap2.ts";
import { issueDelegateTerminal, joinChain } from "../../../packages/common/src/dsdjwt.ts";
import { intersectCapabilities, asCapabilityMap, pruneInvalidNamespaces } from "../../../packages/common/src/negotiation.ts";
import { resolveComposedCheckoutSchema } from "./schema-resolver.ts";
import { otelEnabled, otelSpan } from "../../../packages/common/src/otel.ts";
import {
  URLS,
  AGENT_PROFILE_URL,
  merchantProfileUrl,
} from "../../../packages/common/src/config.ts";
import {
  UCP_VERSION,
  type Checkout,
  type TraceEvent,
  type OpenCheckoutMandatePayload,
  type OpenPaymentMandatePayload,
  type PaymentMandatePayload,
  type Ap2Merchant,
  type Ap2PaymentInstrument,
  type PostalAddress,
} from "../../../packages/common/src/types.ts";
import { parseIntent, type ParsedIntent } from "./nlu.ts";

export const agentKey: SigningKey = generateSigningKey("shoppy-platform-2026");
const identity = { key: agentKey, profileUrl: AGENT_PROFILE_URL };

export const MERCHANT_IDS = ["wavelength", "soundhub", "electromart", "audionest"];
const CP_MCP = `${URLS.credentialsProvider}/mcp`;

/** Platform capability set (mirrors the published platform profile). */
const PLATFORM_CAPS: Record<string, { version: string; extends?: string }> = {
  "dev.ucp.shopping.checkout": { version: UCP_VERSION },
  "dev.ucp.shopping.catalog.search": { version: UCP_VERSION },
  "dev.ucp.shopping.order": { version: UCP_VERSION },
  "dev.ucp.shopping.fulfillment": { version: UCP_VERSION, extends: "dev.ucp.shopping.checkout" },
  "dev.ucp.shopping.ap2_mandate": { version: UCP_VERSION, extends: "dev.ucp.shopping.checkout" },
};

export const DEFAULT_ADDRESS: PostalAddress & { email: string; name: string } = {
  name: "Alex Morgan",
  first_name: "Alex",
  last_name: "Morgan",
  street_address: "248 Fillmore Street",
  extended_address: "Apt 5",
  address_locality: "San Francisco",
  address_region: "CA",
  postal_code: "94117",
  address_country: "US",
  phone: "+1 (415) 555-0148",
  email: "alex.morgan@example.com",
};

/* ---------------- session ---------------- */

export interface MergedOffer {
  merchant: string;
  price: number; // minor units (converted for UI at the boundary)
  was?: number | null;
  ship: string;
  best?: boolean;
  inStock: boolean;
}
export interface MergedProduct {
  id: string;
  name: string;
  brand: string;
  recommended?: boolean;
  recReason?: string;
  specs: { label: string; match?: boolean }[];
  note?: string;
  image?: string;
  offers: MergedOffer[];
}

export interface Session {
  id: string;
  createdAt: number;
  trace: TraceEvent[];
  listeners: Set<(ev: TraceEvent) => void>;
  address: typeof DEFAULT_ADDRESS;
  constraints?: ParsedIntent;
  /** Human-not-present authorization (user-signed, cnf=agent). Absent in the
   *  direct/human-present flow, where the user approves the closed mandates. */
  // Human-not-present open mandates are the ROOT hop of a dSD-JWT chain: we keep
  // the root's chain `segment` + standalone `sdJwt` (for the closed hop's sd_hash).
  openCheckoutMandate?: { id: string; segment: string; sdJwt: string; payload: OpenCheckoutMandatePayload };
  openPaymentMandate?: { id: string; segment: string; sdJwt: string; payload: OpenPaymentMandatePayload };
  occurrence?: number; // closed-mandate count under the open Payment Mandate (agent_recurrence)
  recurring?: boolean; // standing-intent scenario: add a payment.agent_recurrence constraint
  merchants: Record<string, { id: string; name: string; domain: string; rating: number; color?: string; short?: string }>;
  merchantEndpoints: Record<string, string>; // resolved from ucp.services
  eligible: string[];
  /** Negotiated active capabilities per business (capability intersection). */
  negotiated?: Record<string, string[]>;
  products: MergedProduct[];
  accessory?: any;
  selection?: { merchantId: string; items: { item_id: string; quantity: number }[] };
  checkout?: Checkout;
  instrument?: any;
  paymentMethod?: any;
  rail?: "card_network" | "rtp"; // multi-rail settlement: selected rail
  paymentMandate?: { id: string; jws: string; payload: PaymentMandatePayload };
  checkoutMandateJws?: string;
  order?: any;
  shipped?: any; // order webhook payload once received
  rawCatalog?: Record<string, any>; // raw search_catalog responses (compliance validation)
  lastEscalation?: { continue_url?: string; at: number };
  humanPresent?: boolean;
  accessToken?: string; // identity-linking OAuth token
  chatHistory?: any[]; // persisted LLM conversation (interactive chat mode)
}

const sessions = new Map<string, Session>();
const byCheckout = new Map<string, Session>();

export function createSession(): Session {
  const s: Session = {
    id: randomId("sess"),
    createdAt: Date.now(),
    trace: [],
    listeners: new Set(),
    address: { ...DEFAULT_ADDRESS },
    merchants: {},
    merchantEndpoints: {},
    eligible: [],
    products: [],
  };
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  return s;
}

export function onWebhook(body: any) {
  const order = body?.order ?? body;
  const s = byCheckout.get(order?.checkout_id);
  if (!s) return;
  s.shipped = order;
  emit(s, {
    layer: "UCP",
    kind: "response",
    name: "Order Webhook · Shipped",
    method: "POST /webhooks/ucp",
    desc: "The business pushed a signed Order object (dev.ucp.shopping.order) to the platform webhook declared in the platform profile's order capability config. The HTTP message signature was verified against the merchant's published JWKs before acceptance.",
    payload: order,
  });
}

let uid = 0;
/** Hash a trace event into the session's chain (immutable audit trail). */
export function auditHash(seq: number, prevHash: string, ev: { ts: number; layer: string; kind: string; name: string; method: string; payload: unknown }): string {
  const core = JSON.stringify({ seq, prev: prevHash, ts: ev.ts, layer: ev.layer, kind: ev.kind, name: ev.name, method: ev.method });
  const payloadHash = b64u.encode(sha256(Buffer.from(JSON.stringify(ev.payload ?? null))));
  return b64u.encode(sha256(Buffer.from(core + "|" + payloadHash)));
}

function emit(s: Session, ev: Omit<TraceEvent, "uid" | "ts" | "tag"> & { tag?: string; _auto?: boolean }) {
  const full: TraceEvent = { uid: `ev${uid++}`, ts: Date.now(), tag: ev.tag ?? ev.layer, ...ev } as TraceEvent;
  // Immutable audit trail: every event is chained to its predecessor, so any
  // after-the-fact edit breaks every subsequent hash (tamper-evident log).
  full.seq = s.trace.length;
  full.prev_hash = s.trace.length ? s.trace[s.trace.length - 1].hash! : "genesis";
  full.hash = auditHash(full.seq, full.prev_hash, full);
  s.trace.push(full);
  if (otelEnabled()) otelSpan(s.id, full); // OTLP export (one trace per session)
  for (const fn of s.listeners) fn(full);
  return full;
}

/** Re-derive the whole chain; returns the first broken link if any. */
export function verifyAuditChain(s: Session): { valid: boolean; length: number; broken_at?: number } {
  let prev = "genesis";
  for (let i = 0; i < s.trace.length; i++) {
    const ev = s.trace[i];
    if (ev.seq !== i || ev.prev_hash !== prev || ev.hash !== auditHash(i, prev, ev)) return { valid: false, length: s.trace.length, broken_at: i };
    prev = ev.hash!;
  }
  return { valid: true, length: s.trace.length };
}

/** Exportable, dispute-ready evidence bundle: chained trace + mandates + order. */
export function evidenceBundle(s: Session) {
  return {
    generated_at: new Date().toISOString(),
    session_id: s.id,
    audit_chain: verifyAuditChain(s),
    mandates: {
      open_checkout: s.openCheckoutMandate ? { id: s.openCheckoutMandate.id, sd_jwt: s.openCheckoutMandate.segment } : undefined,
      open_payment: s.openPaymentMandate ? { id: s.openPaymentMandate.id, sd_jwt: s.openPaymentMandate.segment } : undefined,
      payment: s.paymentMandate ? { id: s.paymentMandate.id, jws: s.paymentMandate.jws } : undefined,
      checkout_sd_jwt: s.checkoutMandateJws,
    },
    order: s.order,
    events: s.trace.map((e) => ({ seq: e.seq, hash: e.hash, prev_hash: e.prev_hash, ts: e.ts, layer: e.layer, kind: e.kind, name: e.name, method: e.method })),
  };
}

/** Wrap a tools/call with request/response trace events. */
async function tracedTool<T = any>(
  s: Session,
  opts: { endpoint: string; tool: string; args: Record<string, unknown>; name: string; desc: string; respName?: string; respDesc?: string; quiet?: boolean }
): Promise<T> {
  let recorded: any = null;
  const result = await callTool<T>(opts.endpoint, opts.tool, opts.args, identity, (rec) => (recorded = rec));
  if (!opts.quiet) {
    emit(s, {
      layer: "UCP",
      kind: "request",
      name: opts.name,
      method: `tools/call ${opts.tool} → ${new URL(opts.endpoint).host}${new URL(opts.endpoint).pathname}`,
      desc: opts.desc,
      payload: {
        request: recorded?.request,
        signed_headers: {
          "UCP-Agent": recorded?.headers["UCP-Agent"],
          "Signature-Input": recorded?.headers["Signature-Input"],
          Signature: truncate(recorded?.headers["Signature"], 60),
          "Content-Digest": recorded?.headers["Content-Digest"],
          "Idempotency-Key": recorded?.headers["Idempotency-Key"],
        },
      },
    });
    emit(s, {
      layer: "UCP",
      kind: "response",
      name: opts.respName ?? `${opts.name} · Response`,
      method: `${recorded?.ms}ms · structuredContent`,
      desc: opts.respDesc ?? "MCP dual-output response from the counterparty.",
      payload: recorded?.response,
    });
  }
  return result;
}

function truncate(v: string | undefined, n: number) {
  return v && v.length > n ? v.slice(0, n) + "…" : v;
}

const money = (cents: number) => "$" + (cents / 100).toFixed(2);
export const totalOf = (co: Checkout) => co.totals.find((t) => t.type === "total")?.amount ?? 0;

/* ================================================================== */
/* 1. Request → discovery → capability negotiation → federated search  */
/* ================================================================== */

/** Capability intersection per the spec's algorithm (shared implementation:
 *  name match → highest mutual version → transitive orphan-extension pruning). */
function intersect(businessCaps: Record<string, any[]>): string[] {
  return intersectCapabilities(asCapabilityMap(PLATFORM_CAPS as any), businessCaps as any).active;
}

/** Set the session modality. Must be called BEFORE runIntent for human-not-present
 *  so the user-signed open mandates are minted up front. */
export function setModality(s: Session, humanPresent: boolean) {
  s.humanPresent = humanPresent;
  return { human_present: humanPresent };
}

export async function runIntent(s: Session, text: string, opts: { humanPresent?: boolean; deferOpenMandates?: boolean } = {}) {
  if (opts.humanPresent !== undefined) s.humanPresent = opts.humanPresent;
  const constraints = await parseIntent(text);
  s.constraints = constraints;

  // --- Discovery: fetch /.well-known/ucp from every candidate business ---
  const profiles: Record<string, any> = {};
  for (const mid of MERCHANT_IDS) {
    profiles[mid] = await fetchUcpProfile(merchantProfileUrl(mid));
    // Endpoint resolution from ucp.services (MCP transport)
    const svc = (profiles[mid]?.ucp?.services?.["dev.ucp.shopping"] ?? []).find((x: any) => x.transport === "mcp");
    if (svc?.endpoint) s.merchantEndpoints[mid] = svc.endpoint;
  }
  emit(s, {
    layer: "UCP",
    kind: "request",
    name: "Capability Discovery",
    method: "GET /m/{merchant}/.well-known/ucp",
    desc: "Shoppy fetches each business profile: {ucp: {version, services, capabilities, payment_handlers}, signing_keys}. The MCP endpoint is resolved from ucp.services, PKI keys from signing_keys.",
    payload: Object.fromEntries(
      Object.entries(profiles).map(([k, p]: [string, any]) => [
        k,
        {
          name: p.name,
          ucp_version: p.ucp?.version,
          mcp_endpoint: s.merchantEndpoints[k],
          capabilities: Object.keys(p.ucp?.capabilities ?? {}),
          payment_handlers: Object.keys(p.ucp?.payment_handlers ?? {}),
          signing_keys: (p.signing_keys ?? []).map((j: any) => ({ kid: j.kid, kty: j.kty, crv: j.crv })),
        },
      ])
    ),
  });

  // --- Namespace validation: the spec/schema URL origin of every business
  //     capability MUST match its reverse-domain namespace authority
  //     (dev.ucp.* → https://ucp.dev). Offending capabilities are rejected. ---
  const cleanCaps: Record<string, Record<string, any[]>> = {};
  const nsViolations: Record<string, any[]> = {};
  for (const [mid, p] of Object.entries(profiles)) {
    const { clean, violations } = pruneInvalidNamespaces(((p as any).ucp?.capabilities ?? {}) as any);
    cleanCaps[mid] = clean as any;
    if (violations.length) nsViolations[mid] = violations;
  }
  emit(s, {
    layer: "UCP",
    kind: "verify",
    tag: "UCP",
    name: "Namespace Validation",
    method: "spec/schema origin == reverse-domain authority",
    desc: "Each business capability's spec & schema URLs MUST originate from the namespace authority (dev.ucp.* → https://ucp.dev). Capabilities that fail this binding are rejected before negotiation.",
    payload: {
      checked: Object.fromEntries(Object.entries(profiles).map(([k, p]: [string, any]) => [k, Object.keys(p.ucp?.capabilities ?? {})])),
      violations: Object.keys(nsViolations).length ? nsViolations : "none",
    },
  });

  // --- Negotiation: spec intersection algorithm (over namespace-validated caps) ---
  const intersection: Record<string, string[]> = {};
  for (const [mid] of Object.entries(profiles)) {
    intersection[mid] = intersect(cleanCaps[mid] ?? {});
  }
  s.negotiated = intersection;
  s.eligible = Object.entries(intersection)
    .filter(([, caps]) => caps.includes("dev.ucp.shopping.checkout") && caps.includes("dev.ucp.shopping.ap2_mandate"))
    .map(([mid]) => mid);
  emit(s, {
    layer: "UCP",
    kind: "response",
    name: "Capability Negotiation",
    method: "intersection() — name + highest mutual version, transitive orphan pruning",
    desc: "Intersection of the platform profile with each business profile per the spec algorithm. dev.ucp.shopping.ap2_mandate is in every intersection, so all sessions are security-locked: signed checkouts + mandatory mandates.",
    payload: { platform: Object.keys(PLATFORM_CAPS), intersection, eligible_businesses: s.eligible.map((m) => profiles[m].name), security_locked: true },
  });

  // --- Schema Resolution (spec Resolution Flow): fetch base + active extension
  //     schemas, compose via allOf ($defs[dev.ucp.shopping.checkout]) before
  //     making requests. Validation runs against this composed schema. ---
  try {
    const sample = s.eligible[0];
    if (sample) {
      const r = resolveComposedCheckoutSchema(intersection[sample]);
      emit(s, {
        layer: "UCP",
        kind: "verify",
        tag: "UCP",
        name: "Schema Resolution",
        method: "fetch + compose (allOf) · ajv 2020-12",
        desc: "Per the spec Resolution Flow, the platform fetches the base checkout schema and each active extension's $defs[dev.ucp.shopping.checkout], composes them via allOf, and validates payloads against the composed schema.",
        payload: { negotiated: intersection[sample], composed_chain: r.chain, vendored_schemas_loaded: r.loaded },
      });
    }
  } catch (e: any) {
    emit(s, { layer: "UCP", kind: "verify", tag: "UCP", name: "Schema Resolution (skipped)", method: "", desc: "Schema composition unavailable in this environment.", payload: { error: e.message } });
  }

  // --- AP2 authorization (v0.2 open/closed model) is created AFTER the
  //     federated search below. In the human-not-present flow the user signs an
  //     Open Checkout Mandate + Open Payment Mandate (constraints derived from
  //     the search results + budget, sender-constrained to the agent via `cnf`).
  //     In the direct (human-present) flow no open mandate is needed — the user
  //     approves the closed Checkout & Payment Mandates directly at pay time. ---

  // --- Federated catalog search (search_catalog tool) across eligible merchants ---
  const filters = {
    // Official filter (search_filters.json): price in minor units
    price: constraints.max_total != null ? { max: constraints.max_total * 100 } : undefined,
    // Extension filters (search_filters.json has additionalProperties: true)
    attributes: constraints.required_features.includes("noise-cancelling") ? ["anc"] : [],
    ship_within_days: constraints.delivery_days,
  };
  const results: Record<string, any> = {};
  for (const mid of s.eligible) {
    results[mid] = await callTool(s.merchantEndpoints[mid], "search_catalog", { query: constraints.query, filters }, identity);
    s.merchants[mid] = results[mid].merchant;
  }
  s.rawCatalog = results;
  // merge offers by product id (products are official product.json shapes)
  const productMap = new Map<string, MergedProduct>();
  for (const [mid, r] of Object.entries(results)) {
    for (const p of (r as any).products) {
      const meta = p.metadata ?? {};
      if (p.tags?.includes("accessory")) continue;
      const variant = p.variants?.[0];
      let mp = productMap.get(p.id);
      if (!mp) {
        mp = { id: p.id, name: p.title, brand: meta.brand ?? "", specs: meta.specs ?? [], note: p.description?.plain ?? "", image: meta.image, offers: [] };
        productMap.set(p.id, mp);
      }
      mp.offers.push({
        merchant: mid,
        price: variant?.price?.amount ?? p.price_range?.min?.amount,
        was: variant?.list_price?.amount ?? null,
        ship: meta.ship ?? "",
        inStock: meta.in_stock !== false,
      });
    }
  }
  for (const mp of productMap.values()) {
    mp.offers.sort((a, b) => a.price - b.price);
    if (mp.offers[0]) mp.offers[0].best = true;
    mp.specs = [...mp.specs, { label: "Ships in 2 days", match: true }];
  }
  s.products = [...productMap.values()].sort((a, b) => (a.id === "cadence-anc-pro" ? -1 : b.id === "cadence-anc-pro" ? 1 : 0));
  if (s.products.length) {
    s.products[0].recommended = true;
    s.products[0].recReason = "Best match — hits every constraint";
  }

  // --- AP2 open mandates (human-not-present only): the user authorizes the
  //     autonomous purchase up front via Open Checkout + Open Payment Mandates.
  //     Deferred when the UI gathers the merchant/payment constraints first
  //     (interactive authorize step) — they're signed in authorizeAndRun. ---
  if (s.humanPresent === false && !opts.deferOpenMandates) {
    await issueOpenMandates(s, constraints);
  }

  emit(s, {
    layer: "UCP",
    kind: "request",
    name: "Catalog Search · Federated",
    method: `tools/call search_catalog × ${s.eligible.length}`,
    desc: "One signed search_catalog call fans out to every eligible merchant. Results are filtered against the user's stated constraints server-side and merged into per-product offers.",
    payload: {
      query: constraints.query,
      filters,
      bound_to: s.openCheckoutMandate?.id ?? "human-present (no open mandate)",
      merchants_queried: s.eligible.length,
      results: Object.fromEntries(Object.entries(results).map(([k, r]: [string, any]) => [k, r.products.map((p: any) => `${p.name} @ ${money(p.price)}`)])),
    },
  });

  return {
    constraints,
    products: s.products.map(uiProduct),
    merchants: s.merchants,
    merchantsQueried: s.eligible.length,
    openCheckoutMandateId: s.openCheckoutMandate?.id,
    engine: constraints.engine,
  };
}

/**
 * Issue the user-signed Open Checkout + Open Payment Mandates for an autonomous
 * (human-not-present) session. Constraints are derived from the federated search
 * results (allowed merchants + acceptable SKUs) and the user's budget. Each is
 * sender-constrained to the agent key (`cnf`); the agent later signs the matching
 * closed mandates and presents both to the verifiers.
 */
async function issueOpenMandates(
  s: Session,
  constraints: ParsedIntent,
  opts: { allowedMerchantIds?: string[]; instrument?: Ap2PaymentInstrument } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 30 * 60;
  // allowed_merchants = the merchants the user authorized (chosen in the
  // interactive setup), defaulting to all eligible.
  const merchantIds = opts.allowedMerchantIds?.length ? opts.allowedMerchantIds : s.eligible;
  const eligibleMerchants: Ap2Merchant[] = merchantIds.map((mid) => ({
    id: mid,
    name: s.merchants[mid]?.name ?? mid,
    website: merchantProfileUrl(mid),
  }));
  const acceptable = s.products.slice(0, 8).map((p) => ({ id: p.id, title: p.name }));

  const openCheckout: OpenCheckoutMandatePayload = {
    vct: OPEN_CHECKOUT_MANDATE_VCT,
    id: randomId("ocm"),
    user: "user_alex",
    constraints: [
      allowedMerchantsConstraint(eligibleMerchants),
      lineItemsConstraint([{ id: "line_1", acceptable_items: acceptable, quantity: 1 }]),
    ],
    cnf: { jwk: agentKey.publicJwk },
    iat: now,
    exp,
  };
  const ocSigned = await callTool<any>(CP_MCP, "sign_mandate", { kind: "OpenCheckoutMandate", payload: openCheckout }, identity);
  s.openCheckoutMandate = { id: openCheckout.id, segment: ocSigned.segment, sdJwt: ocSigned.sdJwt, payload: openCheckout };

  // amount_range.max caps a single charge (minor units) and reflects EXACTLY
  // what the user asked: their stated budget, or a "buy if it drops below $X"
  // conditional cap. We do NOT silently inflate it — the agent must shop within
  // the user's number (the order TOTAL, incl. tax, must be ≤ this cap). For
  // recurring authorizations the AP2 spec requires agent_recurrence to be paired
  // with BOTH amount_range AND budget; budget.max is in MAJOR units and bounds
  // the cumulative spend across cycles.
  const conditionalCap = constraints.buy_below != null ? Math.round(constraints.buy_below * 100) : undefined;
  const ceiling = constraints.max_total != null ? Math.round(constraints.max_total * 100) : undefined;
  const singleCap = conditionalCap ?? ceiling;
  const recurringCap = singleCap ?? 50000; // ensure amount_range is present when recurring
  const openCheckoutRef = openMandateDigest(ocSigned.sdJwt); // payment.reference → open checkout
  const paymentConstraints = s.recurring
    ? [
        amountRangeConstraint("USD", recurringCap),
        budgetConstraint((recurringCap * 2) / 100, "USD"), // 2 cycles, major units
        agentRecurrenceConstraint("ON_DEMAND", 2),
        paymentReferenceConstraint(openCheckoutRef),
      ]
    : [
        ...(singleCap != null ? [amountRangeConstraint("USD", singleCap)] : []),
        paymentReferenceConstraint(openCheckoutRef),
      ];
  // The chosen payment method becomes a signed allowed_payment_instruments
  // constraint — the PSP rejects any other instrument.
  if (opts.instrument) paymentConstraints.push(allowedPaymentInstrumentsConstraint([opts.instrument]));
  const openPayment: OpenPaymentMandatePayload = {
    vct: OPEN_PAYMENT_MANDATE_VCT,
    id: randomId("opm"),
    user: "user_alex",
    constraints: paymentConstraints,
    cnf: { jwk: agentKey.publicJwk },
    iat: now,
    exp,
  };
  const opSigned = await callTool<any>(CP_MCP, "sign_mandate", { kind: "OpenPaymentMandate", payload: openPayment }, identity);
  s.openPaymentMandate = { id: openPayment.id, segment: opSigned.segment, sdJwt: opSigned.sdJwt, payload: openPayment };
  s.occurrence = 0;

  emit(s, {
    layer: "AP2",
    kind: "mandate",
    name: "Open Checkout + Payment Mandate",
    method: "dSD-JWT root · ES256 · user device key · cnf=agent",
    desc:
      "Human-not-present authorization (AP2 v0.2 dSD-JWT chain roots). The user device key signs an Open Checkout Mandate (checkout.allowed_merchants + checkout.line_items) and an Open Payment Mandate (payment.amount_range" +
      (s.recurring ? " + payment.agent_recurrence" : "") +
      " + payment.reference), each an SD-JWT whose constraint arrays are selective disclosures and whose cnf names the agent key. The agent later signs the CLOSED (terminal) hop of each chain, sd_hash-bound to these roots.",
    payload: { open_checkout: openCheckout, open_payment: openPayment },
    mandate: {
      kind: "Open Mandates",
      id: openCheckout.id,
      seal: "user · device key · cnf=agent",
      rows: [
        ["allowed merchants", String(eligibleMerchants.length)],
        ["acceptable items", String(acceptable.length)],
        ["amount ceiling", ceiling != null ? money(ceiling) + " USD" : "—"],
        ["recurrence", s.recurring ? "ON_DEMAND ×2" : "—"],
        ["cnf", "agent key ✓"],
      ],
      sig: ((ocSigned.segment ?? "").split("~")[0].split(".")[2] ?? "").slice(0, 42),
    },
    _auto: true,
  });
}

/** Convert minor units → display dollars for the UI. */
function uiProduct(p: MergedProduct) {
  return {
    ...p,
    offers: p.offers.map((o) => ({ ...o, price: o.price / 100, was: o.was != null ? o.was / 100 : o.was })),
  };
}

/* ================================================================== */
/* 2. Selection (+ upsell detection)                                   */
/* ================================================================== */

export async function select(s: Session, productId: string, merchantId: string) {
  s.selection = { merchantId, items: [{ item_id: productId, quantity: 1 }] };
  const r: any = await callTool(s.merchantEndpoints[merchantId], "search_catalog", { query: "accessory", filters: {} }, identity);
  const acc = r.products.find((p: any) => p.metadata?.accessory_for === productId);
  if (acc) s.accessory = { ...acc, merchant: merchantId };
  return {
    upsell: acc
      ? { id: acc.id, name: acc.title, price: (acc.variants?.[0]?.price?.amount ?? 0) / 100, note: acc.description?.plain }
      : null,
  };
}

export function addAccessory(s: Session) {
  if (!s.selection || !s.accessory) throw new Error("nothing selected");
  s.selection.items.push({ item_id: s.accessory.id, quantity: 1 });
  return { items: s.selection.items };
}

/** Add an item to the cart (append). A UCP checkout is per-merchant, so a
 *  different merchant starts a fresh cart. Used by the interactive LLM chat. */
export function addItem(s: Session, productId: string, merchantId: string) {
  if (!s.selection || s.selection.merchantId !== merchantId) {
    s.selection = { merchantId, items: [{ item_id: productId, quantity: 1 }] };
  } else {
    const existing = s.selection.items.find((i) => i.item_id === productId);
    if (existing) existing.quantity += 1;
    else s.selection.items.push({ item_id: productId, quantity: 1 });
  }
  const name = (mid: string, pid: string) => s.products.find((p) => p.id === pid)?.name ?? pid;
  return {
    merchant: s.merchants[merchantId]?.name ?? merchantId,
    items: s.selection.items.map((i) => ({ id: i.item_id, name: name(merchantId, i.item_id), quantity: i.quantity })),
  };
}

/* ================================================================== */
/* 3. Checkout: create → update → verify merchant_authorization (JWS)  */
/* ================================================================== */

function shippingAddress(s: Session): PostalAddress {
  const a = s.address;
  return {
    id: "dest_home",
    first_name: a.first_name,
    last_name: a.last_name,
    street_address: a.street_address,
    extended_address: a.extended_address,
    address_locality: a.address_locality,
    address_region: a.address_region,
    postal_code: a.postal_code,
    address_country: a.address_country,
    phone: a.phone,
  };
}

async function verifyAndTraceMerchantAuth(s: Session, co: Checkout, mid: string, context: string) {
  const profile = await fetchUcpProfile(merchantProfileUrl(mid));
  const v = verifyMerchantAuthorization(co, profile.signing_keys);
  emit(s, {
    layer: "PKI",
    tag: "PKI",
    kind: "verify",
    name: "Verify merchant_authorization",
    method: "JWS detached · JCS · ES256",
    desc: `${context} — the platform MUST verify the business's detached JWS over the JCS-canonicalized checkout (excluding ap2) before showing it to the user. Key resolved from ${merchantProfileUrl(mid)}.`,
    payload: {
      checkout_id: co.id,
      merchant_authorization: truncate(co.ap2?.merchant_authorization, 80),
      verified: v.ok,
      kid: v.kid,
      ...(v.error ? { error: v.error } : {}),
    },
  });
  if (!v.ok) throw new Error(`merchant authorization failed verification: ${v.error}`);
}

export async function createCheckout(s: Session) {
  if (!s.selection) throw new Error("nothing selected");
  const mid = s.selection.merchantId;
  const ep = s.merchantEndpoints[mid];

  const created = await tracedTool<{ checkout: Checkout }>(s, {
    endpoint: ep,
    tool: "create_checkout",
    args: {
      checkout: {
        line_items: s.selection.items.map((i) => ({ item: { id: i.item_id }, quantity: i.quantity })),
        buyer: { email: s.address.email, first_name: s.address.first_name, last_name: s.address.last_name },
        currency: "USD",
        fulfillment: { methods: [{ type: "shipping", destinations: [shippingAddress(s)] }] },
      },
    },
    name: "Create Checkout",
    desc: `Shoppy opens a single checkout session with ${s.merchants[mid]?.name ?? mid} via tools/call create_checkout (MCP binding). One session, one payment — even with multiple line items.`,
    respDesc: "The business returns {checkout} in structuredContent WITH ap2.merchant_authorization embedded (AP2 negotiated ⇒ security-locked) and the ucp envelope listing active capabilities + payment handlers.",
  });
  const co = created.checkout;
  await verifyAndTraceMerchantAuth(s, co, mid, "After create_checkout");
  s.checkout = co;
  byCheckout.set(co.id, s);

  // No separate "Cart Mandate" in AP2 v0.2 — the merchant-signed checkout
  // (ap2.merchant_authorization) IS the authenticated cart; it is embedded in
  // the closed Checkout Mandate at pay time.
  return checkoutView(s);
}

export async function updateCheckout(
  s: Session,
  patch: { qty?: { item_id: string; delta: number }; address?: Partial<typeof DEFAULT_ADDRESS> }
) {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const checkoutPatch: any = {};
  if (patch.qty) {
    const li = co.line_items.find((l) => l.item.id === patch.qty!.item_id);
    if (!li) throw new Error("unknown line item");
    checkoutPatch.line_items = [{ id: li.id, item: { id: li.item.id }, quantity: Math.max(1, li.quantity + patch.qty.delta) }];
  }
  if (patch.address) {
    s.address = { ...s.address, ...patch.address };
    checkoutPatch.fulfillment = { methods: [{ id: "shipping_1", destinations: [shippingAddress(s)] }] };
    checkoutPatch.buyer = { email: s.address.email, first_name: s.address.first_name, last_name: s.address.last_name };
  }
  const updated = await tracedTool<{ checkout: Checkout }>(s, {
    endpoint: s.merchantEndpoints[mid],
    tool: "update_checkout",
    args: { id: co.id, checkout: checkoutPatch },
    name: patch.qty ? "Update Checkout · Quantity" : "Update Checkout · Address",
    desc: "tools/call update_checkout — the merchant recomputes totals and re-signs the checkout.",
    respDesc: "Updated totals (one subtotal, one total, negative discount, fulfillment line) with a fresh merchant_authorization.",
  });
  await verifyAndTraceMerchantAuth(s, updated.checkout, mid, "After update_checkout");
  s.checkout = updated.checkout;
  byCheckout.set(updated.checkout.id, s);
  return checkoutView(s);
}

export function checkoutView(s: Session) {
  const co = s.checkout!;
  const get = (t: string) => co.totals.find((x) => x.type === t)?.amount ?? 0;
  return {
    checkout_id: co.id,
    status: co.status,
    merchant: s.merchants[co.merchant_id!] ?? { id: co.merchant_id },
    merchant_id: co.merchant_id,
    items: co.line_items.map((l) => ({
      id: l.item.id,
      name: l.item.title,
      brand: l.item.brand,
      price: l.item.price / 100,
      qty: l.quantity,
      image: s.products.find((pp) => pp.id === l.item.id)?.image ?? (s.accessory?.id === l.item.id ? s.accessory?.metadata?.image : undefined),
    })),
    totals: {
      subtotal: get("subtotal") / 100,
      shipping: get("fulfillment") / 100,
      discount: Math.abs(get("discount")) / 100,
      tax: get("tax") / 100,
      total: get("total") / 100,
    },
    address: s.address,
    merchant_signed: !!co.ap2?.merchant_authorization,
  };
}

/* ================================================================== */
/* 4. Payment: methods → mint → payment+checkout mandates → complete   */
/* ================================================================== */

export async function listPaymentMethods(s: Session) {
  const wallet = await callTool<any>(CP_MCP, "list_payment_methods", { user: "user_alex" }, identity);
  return wallet.payment_methods;
}

export async function preparePayment(s: Session, methodId?: string, rpId?: string) {
  const wallet = await tracedTool<any>(s, {
    endpoint: CP_MCP,
    tool: "list_payment_methods",
    args: { user: "user_alex" },
    name: "Get Payment Methods",
    desc: "The agent asks the Credentials Provider which of the user's payment methods are eligible. PCI data stays inside the wallet.",
    respDesc: "Eligible (agentic-ready) payment methods — display data only, no PANs.",
  });
  const co = s.checkout!;
  const total = totalOf(co);

  // --- Multi-rail settlement: pick the optimal rail for THIS payment ---
  // Criteria (deck-style): explicit user choice > user's policy preference >
  // amount-based auto-selection (large amounts → RTP instant fiat settlement,
  // everyday consumer purchases → card network).
  const policy = (await callTool<any>(CP_MCP, "get_agent_policy", {}, identity)).policy;
  let rail: "card_network" | "rtp";
  let railReason: string;
  const explicit = methodId && wallet.payment_methods.find((m: any) => m.id === methodId);
  if (explicit) {
    rail = explicit.rail ?? "card_network";
    railReason = `user/scenario explicitly chose ${explicit.display}`;
  } else if (policy.preferred_rail !== "auto") {
    rail = policy.preferred_rail;
    railReason = `user's wallet policy prefers ${policy.preferred_rail}`;
  } else {
    rail = total >= 50_000 ? "rtp" : "card_network";
    railReason = total >= 50_000 ? `amount ${money(total)} ≥ $500 → instant bank settlement is cheaper` : `consumer purchase ${money(total)} → card network (wide acceptance, chargeback rights)`;
  }
  const method =
    explicit ||
    wallet.payment_methods.find((m: any) => (rail === "rtp" ? m.rail === "rtp" : m.default)) ||
    wallet.payment_methods[0];
  s.paymentMethod = method;
  s.rail = method.rail ?? rail;
  emit(s, {
    layer: "UCP", tag: "UCP", kind: "verify", name: "Rail selection · multi-rail settlement",
    method: s.rail === "rtp" ? "RTP — instant bank transfer" : "card network",
    desc: "The agent has access to multiple settlement rails (advertised as UCP payment_handlers by the merchant and wallet) and selects the optimal one per transaction — by amount, speed, and the user's policy preference.",
    payload: { amount_minor: total, rails_available: ["card_network", "rtp"], selected: s.rail, reason: railReason, policy_preference: policy.preferred_rail },
  });

  const minted = await tracedTool<any>(s, {
    endpoint: CP_MCP,
    tool: "mint_instrument",
    args: {
      method_id: method.id,
      context: { checkout_id: co.id, merchant_id: co.merchant_id, amount: total, currency: co.currency, human_present: s.humanPresent !== false },
    },
    name: s.rail === "rtp" ? "Mint Instrument · RTP (instant bank transfer)" : "Mint Instrument · Google Pay",
    desc: `The payment handler (${s.rail === "rtp" ? "com.paystream.rtp" : "com.google.pay"}, advertised in the checkout's ucp.payment_handlers) is executed against the Credentials Provider: it tokenizes the ${s.rail === "rtp" ? "bank account" : "card"} and returns a single-use token carrying the user's spend-policy snapshot. The raw credential never reaches agent or merchant.`,
    respDesc: "Single-use token + cryptogram, bound to this checkout, with the token-bound spend-policy scope.",
  });
  s.instrument = minted.instrument;

  // Passkey (Touch ID / SPC) — if enabled & enrolled, the browser must produce
  // a WebAuthn assertion over the checkout's UV challenge before we complete.
  const status = await callTool<any>(CP_MCP, "passkey_status", { rp_id: rpId }, identity);
  let passkey: any = { enabled: status.enabled, enrolled: status.enrolled, rp_id: status.rp_id };
  if (status.enabled && status.enrolled) {
    const uvChallenge = checkoutUvChallenge(co);
    const authOpts = await callTool<any>(CP_MCP, "passkey_auth_options", { uv_challenge: uvChallenge, checkout_id: co.id, rp_id: rpId }, identity);
    passkey = { ...passkey, uv_challenge: uvChallenge, auth_options: authOpts };
  }
  return {
    method,
    methods: wallet.payment_methods, // for the in-sheet payment-method picker
    instrument: minted.instrument,
    total: totalOf(co) / 100,
    address: s.address,
    passkey,
  };
}

export async function confirmAndPay(s: Session, opts: { humanPresent?: boolean; webauthn?: any; interactive3ds?: boolean } = {}) {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const total = totalOf(co);
  const humanPresent = opts.humanPresent !== false;
  const rail = s.rail ?? "card_network";
  const handler = rail === "rtp" ? "com.paystream.rtp" : "com.google.pay";

  // Human-not-present requires user-signed open mandates. If the session went
  // autonomous after search (e.g. the user toggled it at pay time in the live
  // flow), mint them now from the captured constraints + search results.
  if (!humanPresent && !s.openCheckoutMandate) {
    s.humanPresent = false;
    await issueOpenMandates(s, s.constraints!);
  }

  // --- Agent-side autonomy pre-check (the CP enforces the same policy at
  //     sign_mandate; checking here gives the user a clear early answer). ---
  if (!humanPresent) {
    const policy = (await callTool<any>(CP_MCP, "get_agent_policy", {}, identity)).policy;
    let violates =
      policy.autonomy === "always_ask" || (policy.autonomy === "ask_above" && total > policy.ask_above_amount);
    if (violates) {
      // The user may have explicitly approved THIS checkout in the Walletly inbox.
      const a = await callTool<any>(CP_MCP, "check_approval", { checkout_id: co.id }, identity);
      if (a.status === "approved") {
        violates = false;
        emit(s, {
          layer: "AP2", tag: "AP2", kind: "verify", name: "User approval granted · autonomy gate waived",
          method: `approval ${a.approval_id}`,
          desc: "The user explicitly approved this purchase in the Walletly approval inbox — the autonomy gate is waived for this checkout (caps/budget/allowlist still enforced).",
          payload: a,
        });
      }
    }
    emit(s, {
      layer: "AP2", tag: "AP2", kind: "verify", name: "Autonomy check · spend policy",
      method: `policy: ${policy.autonomy}${policy.autonomy === "ask_above" ? ` (≤ ${money(policy.ask_above_amount)})` : ""}`,
      desc: "Before an autonomous (human-not-present) purchase the agent checks the user's wallet policy: may it buy without the user in session, and up to what amount?",
      payload: { human_present: false, amount_minor: total, autonomy: policy.autonomy, ask_above_amount: policy.ask_above_amount, allowed: !violates },
    });
    if (violates) {
      const ar = await requestApproval(s).catch(() => null);
      const err: any = new Error(
        policy.autonomy === "always_ask"
          ? "Purchase needs your approval: the policy requires you in-session for every purchase"
          : `Purchase needs your approval: autonomous purchases are limited to ${money(policy.ask_above_amount)} (this is ${money(total)})`
      );
      err.code = "approval_pending";
      err.data = { code: "approval_pending", approval_id: ar?.approval_id };
      throw err;
    }
  }

  // AP2 binding: checkout_jwt = merchant-signed JWT of the Checkout (derived from
  // merchant_authorization); checkout_hash = base64url hash of it. The closed
  // Payment Mandate's transaction_id and the closed Checkout Mandate's
  // checkout_hash both equal this — binding both mandates to the exact terms.
  const coJwt = checkoutJwt(co);
  const coHash = checkoutJwtHash(coJwt);

  // AP2 reference order (per AP2/code/samples/python shopping_agent/agent.py
  //   step 6a→6b): create the Checkout Mandate FIRST, then the Payment Mandate.
  //   Both bind to checkout_jwt (coHash) computed above, not to each other.
  // --- Checkout Mandate: real SD-JWT+kb issued by the CP, key-bound to the
  //     user device key, audience = THIS merchant, nonce = checkout id. ---
  let cmSigned: any;
  if (humanPresent) {
    cmSigned = await callTool<any>(
      CP_MCP,
      "sign_mandate",
      {
        kind: "CheckoutMandate",
        // If a passkey is enrolled, the user's WebAuthn/SPC assertion (Touch ID)
        // over the checkout's UV challenge gates this signature at the CP.
        webauthn: opts.webauthn,
        payload: {
          checkout: co,
          human_present: true,
          aud: merchantProfileUrl(mid),
          nonce: co.id,
          reveal: ["sub"], // disclose user id; withhold buyer_email (selective disclosure)
        },
      },
      identity
    );
  } else {
    // Human-not-present: the AGENT signs the closed (terminal) hop of a dSD-JWT
    // chain whose ROOT is the user-signed Open Checkout Mandate (cnf=agent). The
    // terminal's `sd_hash` binds it to the root; the merchant verifies the chain
    // and checks the checkout satisfies the open constraints.
    const now = Math.floor(Date.now() / 1000);
    const closedClaims = {
      vct: "mandate.checkout.1",
      iss: AGENT_PROFILE_URL,
      sub: "user_alex",
      iat: now,
      exp: now + 30 * 60,
      checkout_jwt: coJwt,
      checkout_hash: coHash,
      checkout: co, // convenience copy used by the merchant for terms/constraints
      human_present: false,
    };
    const term = issueDelegateTerminal(closedClaims as any, agentKey, { sdJwt: s.openCheckoutMandate!.sdJwt }, { aud: merchantProfileUrl(mid), nonce: co.id });
    const chain = joinChain([s.openCheckoutMandate!.segment, term.segment]);
    cmSigned = { jws: chain, id: randomId("comandate"), format: "dc+sd-jwt chain (open~~closed)" };
  }
  s.checkoutMandateJws = cmSigned.jws;
  if (cmSigned.passkey_evidence) {
    emit(s, {
      layer: "AP2", kind: "verify", tag: "AP2", name: "User verification · passkey (Touch ID)",
      method: cmSigned.passkey_evidence.type === "spc" ? "Secure Payment Confirmation" : "WebAuthn assertion",
      desc: "The Credentials Provider verified a real passkey assertion (UV=1) whose challenge is the SHA-256 of the JCS-canonicalized checkout — cryptographic proof the user approved THESE exact terms with Touch ID before the mandate was signed.",
      payload: cmSigned.passkey_evidence,
    });
  }
  emit(s, {
    layer: "AP2",
    kind: "mandate",
    name: "Checkout Mandate (closed · ap2.checkout_mandate)",
    method: humanPresent ? "SD-JWT+kb · issuer=CP, holder=user device key" : "SD-JWT+kb · issuer=holder=AGENT key (open-mandate authority)",
    desc: humanPresent
      ? "A real SD-JWT+kb verifiable credential: the CP issues it (issuer signature), it is KEY-BOUND to the user's device key (the holder signs a key-binding JWT over aud=merchant + nonce=checkout id), and it embeds the FULL merchant-signed checkout. Selective disclosure reveals the user id but withholds the email. Required by the merchant at complete_checkout."
      : "Signed autonomously by the agent (issuer=holder=agent key) under the user-signed Open Checkout Mandate (cnf=agent key). Bound to aud=merchant + nonce=checkout id, it embeds the FULL merchant-signed checkout and the open mandate digest. The merchant verifies it satisfies the open constraints (allowed_merchants + line_items).",
    payload: { format: cmSigned.format, embedded_checkout_id: co.id, aud: merchantProfileUrl(mid), nonce: co.id, open_checkout_mandate: humanPresent ? undefined : s.openCheckoutMandate?.id, presentation: truncate(cmSigned.jws, 120) },
    mandate: {
      kind: "Checkout Mandate",
      id: cmSigned.id,
      seal: humanPresent ? "SD-JWT+kb · issuer=CP + holder=user" : "SD-JWT+kb · agent (open-mandate)",
      rows: [
        ["format", "dc+sd-jwt~kb"],
        ["embeds checkout", co.id],
        ["audience (kb)", s.merchants[mid]?.name ?? mid],
        ["nonce (kb)", co.id.slice(0, 18) + "…"],
        humanPresent
          ? (["selective disclosure", "sub ✓ · email ✗"] as [string, string])
          : (["satisfies open", (s.openCheckoutMandate?.id ?? "").slice(0, 18) + "…"] as [string, string]),
      ],
      sig: (cmSigned.jws.split("~").pop() || "").split(".")[2]?.slice(0, 42) ?? "",
    },
    _auto: true,
  });

  // --- Payment Mandate (AP2 mandate.payment.1; SD-JWT+kb). transaction_id =
  //     hash(checkout_jwt) binds it to the signed checkout. ---
  const pm: PaymentMandatePayload = {
    type: "PaymentMandate",
    vct: "mandate.payment.1",
    id: randomId("pay"),
    transaction_id: coHash,
    payee: { id: mid, name: s.merchants[mid]?.name ?? mid, website: merchantProfileUrl(mid) },
    payment_amount: { amount: total, currency: co.currency },
    payment_instrument: {
      id: `instr_${s.instrument?.last4 ?? "0000"}`,
      type: "card",
      description: `${s.instrument?.network ?? "card"} ···· ${s.instrument?.last4 ?? "0000"}`,
    },
    // Human-not-present: digest of the user-signed Open Payment Mandate this
    // closed mandate satisfies (absent in the direct flow).
    open_payment_mandate: humanPresent ? undefined : openMandateDigest(s.openPaymentMandate!.sdJwt),
    checkout_id: co.id,
    handler,
    agent: AGENT_PROFILE_URL, // KYA: the PSP keys registry/velocity/reputation on this
    rail,
    authorized_by: humanPresent ? "device_biometric" : "agent_open_mandate",
    human_present: humanPresent,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  // Human-present → the user device key signs the closed Payment Mandate at the
  // CP (biometric/passkey-gated). Human-not-present → the AGENT signs the closed
  // (terminal) hop of a dSD-JWT chain whose ROOT is the user-signed Open Payment
  // Mandate (cnf=agent); the terminal's `sd_hash` binds it to that root.
  if (humanPresent) {
    const pmSigned = await callTool<any>(CP_MCP, "sign_mandate", { kind: "PaymentMandate", payload: pm }, identity);
    s.paymentMandate = { id: pm.id, jws: pmSigned.jws, payload: pm };
  } else {
    s.occurrence = (s.occurrence ?? 0) + 1;
    const term = issueDelegateTerminal(
      { ...(pm as unknown as Record<string, unknown>), iss: AGENT_PROFILE_URL },
      agentKey,
      { sdJwt: s.openPaymentMandate!.sdJwt },
      { aud: merchantProfileUrl(mid), nonce: co.id }
    );
    const chain = joinChain([s.openPaymentMandate!.segment, term.segment]);
    s.paymentMandate = { id: pm.id, jws: chain, payload: pm };
  }
  emit(s, {
    layer: "AP2",
    kind: "mandate",
    name: "Payment Mandate (closed · mandate.payment.1)",
    method: humanPresent ? "SD-JWT+kb · ES256 · user device key" : "SD-JWT+kb · ES256 · AGENT key (open-mandate authority)",
    desc: humanPresent
      ? "Approved with the device biometric in the Google Pay sheet: authorizes exactly this amount to this merchant via this instrument. Travels to the PSP inside the composite token."
      : "Signed autonomously by the agent under the user-signed Open Payment Mandate (cnf=agent key). Carries the open mandate digest; the PSP verifies it satisfies the open constraints (amount/budget/recurrence). Travels to the PSP inside the composite token.",
    payload: pm,
    mandate: {
      kind: "Payment Mandate",
      id: pm.id,
      seal: humanPresent ? "user · biometric" : "agent · open mandate",
      rows: [
        ["handler", rail === "rtp" ? "RTP · instant bank transfer" : "Google Pay"],
        ["rail", rail],
        ["amount", money(total)],
        ["payee", s.merchants[mid]?.name ?? mid],
        humanPresent
          ? (["authorized", "user device key"] as [string, string])
          : (["satisfies open", (s.openPaymentMandate?.id ?? "").slice(0, 18) + "…"] as [string, string]),
      ],
      sig: (s.paymentMandate!.jws.split("~").pop() || s.paymentMandate!.jws).split(".")[2]?.slice(0, 42) ?? "",
    },
    _auto: true,
  });

  const completed = await submitComplete(s, { humanPresent, interactive: opts.interactive3ds });
  s.checkout = completed;
  // Interactive 3-D Secure: submitComplete paused at the escalation and returned
  // the still-escalated checkout. We surface a `threeds` payload (one consistent
  // result shape) so the browser opens the bank page and calls resolveThreeDs().
  const needs3ds = completed.status === "requires_escalation";
  if (!needs3ds) s.order = completed.order;
  const eta = s.order?.estimated_delivery
    ? new Date(s.order.estimated_delivery).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : undefined;
  return {
    order: needs3ds ? undefined : s.order,
    eta,
    last4: s.instrument?.last4,
    total: total / 100,
    escalated: !!s.lastEscalation,
    receipts: { open_checkout_mandate: s.openCheckoutMandate?.id, open_payment_mandate: s.openPaymentMandate?.id, payment_mandate: s.paymentMandate?.id },
    threeds: needs3ds
      ? { continue_url: completed.continue_url, challenge_id: (completed.continue_url ?? "").split("/").pop() }
      : undefined,
  };
}

/** Resume an interactive 3-D Secure challenge: resolve it on the Credentials
 *  Provider's trusted surface, then retry complete_checkout with the attestation.
 *  Called by the browser after the user approves (or cancels) the bank page. */
export async function resolveThreeDs(s: Session, opts: { outcome?: string } = {}) {
  const co = s.checkout!;
  const total = totalOf(co);
  const outcome = opts.outcome === "cancelled" || opts.outcome === "failed" ? opts.outcome : "success";
  const challengeId = (s.lastEscalation?.continue_url ?? "").split("/").pop() ?? randomId("3ds", 12);
  const att = await callTool<any>(CP_MCP, "resolve_challenge", { challenge_id: challengeId, outcome }, identity);
  emit(s, {
    layer: "AP2", kind: "mandate", name: outcome === "success" ? "3-D Secure attestation" : "3-D Secure cancelled",
    method: "user · biometric on bank surface",
    desc: outcome === "success"
      ? "The user completed Strong Customer Authentication on the bank's page; the Credentials Provider returns an attestation the PSP trusts, so the retry succeeds without a second challenge."
      : "The user cancelled the bank challenge — no attestation was issued and the payment was not completed.",
    payload: { challenge_id: challengeId, outcome: att.outcome, attestation: truncate(att.attestation, 24) },
    mandate: outcome === "success"
      ? { kind: "3DS Attestation", id: challengeId, seal: "user · 3DS", rows: [["outcome", att.outcome], ["attestation", truncate(att.attestation, 20) ?? "—"]], sig: (att.attestation ?? "").slice(0, 20) }
      : undefined,
  });
  if (att.outcome !== "success" || !att.attestation) {
    throw new Error("3-D Secure was cancelled — the payment was not completed. You can try again from the checkout.");
  }
  const completed = await submitComplete(s, { humanPresent: true }, att.attestation);
  s.checkout = completed;
  s.order = completed.order;
  const eta = s.order?.estimated_delivery
    ? new Date(s.order.estimated_delivery).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : undefined;
  return {
    order: s.order,
    eta,
    last4: s.instrument?.last4,
    total: total / 100,
    escalated: true,
    receipts: { open_checkout_mandate: s.openCheckoutMandate?.id, open_payment_mandate: s.openPaymentMandate?.id, payment_mandate: s.paymentMandate?.id },
  };
}

/** complete_checkout with verified response signature + 3DS escalation retry. */
async function submitComplete(s: Session, opts: { humanPresent: boolean; interactive?: boolean }, challengeAttestation?: string): Promise<Checkout> {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  // Multi-rail: pick the advertised handler matching the selected rail.
  const advertised = Object.values(co.ucp.payment_handlers ?? {}).flat();
  const prefix = s.rail === "rtp" ? "rtp_" : "gpay_";
  const handlerId = advertised.find((h: any) => String(h.id).startsWith(prefix))?.id ?? advertised[0]?.id ?? `gpay_${mid}`;
  let rec: any = null;
  const completed = await callTool<{ checkout: Checkout }>(
    s.merchantEndpoints[mid],
    "complete_checkout",
    {
      id: co.id,
      checkout: {
        payment: {
          instruments: [
            {
              id: "pm_" + randomId("", 12),
              handler_id: handlerId,
              type: s.rail === "rtp" ? "bank_account" : "card",
              selected: true,
              display: { brand: s.instrument.network, last_digits: s.instrument.last4 },
              billing_address: {
                first_name: s.address.first_name,
                last_name: s.address.last_name,
                street_address: s.address.street_address,
                extended_address: s.address.extended_address,
                address_locality: s.address.address_locality,
                address_region: s.address.address_region,
                postal_code: s.address.postal_code,
                address_country: s.address.address_country,
              },
              // payment_mandate is a dSD-JWT chain (open~~closed) for human-not-present,
              // or a single SD-JWT+kb for human-present.
              credential: { type: "AP2_COMPOSITE", token: { network_token: s.instrument, payment_mandate: s.paymentMandate!.jws } },
            },
          ],
        },
        signals: { "dev.ucp.buyer_ip": "203.0.113.42", "dev.ucp.user_agent": "Shoppy/1.0 (UCP platform; AP2)" },
        // checkout_mandate is a dSD-JWT chain (open~~closed) for human-not-present,
        // or a single SD-JWT+kb for human-present. The open mandate is the root hop
        // of the chain, so no separate open_checkout_mandate field is needed.
        ap2: { checkout_mandate: s.checkoutMandateJws, ...(challengeAttestation ? { challenge_attestation: challengeAttestation } : {}) },
      },
    },
    identity,
    (r) => (rec = r)
  );

  // Trace request + response (response signature verified below)
  emit(s, {
    layer: "UCP", kind: "request", name: challengeAttestation ? "Complete Checkout · Retry (post-3DS)" : "Complete Checkout",
    method: `tools/call complete_checkout → ${new URL(s.merchantEndpoints[mid]).host}`,
    desc: "complete_checkout with the AP2 composite token (Payment Mandate inside), the SD-JWT+kb Checkout Mandate, and dev.ucp.* signals. The merchant verifies the full mandate chain, then the PSP independently re-verifies before charging.",
    payload: { request: rec?.request, signed_headers: { "UCP-Agent": rec?.headers["UCP-Agent"], "Signature-Input": rec?.headers["Signature-Input"], "Idempotency-Key": rec?.headers["Idempotency-Key"] } },
  });
  // Verify the merchant's RESPONSE signature (RFC 9421 @status) — RECOMMENDED for completion.
  const profile = await fetchUcpProfile(merchantProfileUrl(mid));
  const rv = verifyResponse({ status: rec?.httpStatus ?? 200, body: rec?.rawResponseBody ?? "", headers: lc(rec?.responseHeaders ?? {}), keys: profile.signing_keys });
  emit(s, {
    layer: "PKI", tag: "PKI", kind: "verify", name: "Verify complete_checkout response signature",
    method: "RFC 9421 · @status · ES256",
    desc: "The platform verifies the merchant's signature over the completion response (order confirmation), so the order receipt is non-repudiable.",
    payload: { verified: rv.ok, kid: rv.keyId, ...(rv.error ? { error: rv.error } : {}) },
  });

  const checkout = completed.checkout;
  emit(s, {
    layer: "UCP", kind: "response", name: checkout.status === "requires_escalation" ? "Checkout · requires_escalation (3DS)" : "Complete Checkout · Order Created",
    method: `${rec?.ms}ms · structuredContent`,
    desc: checkout.status === "requires_escalation" ? "The bank requires Strong Customer Authentication. The checkout is paused with a continue_url for the user to complete a 3-D Secure challenge." : "Mandate chain verified by merchant + PSP; payment authorized and captured; completed checkout carries order {id, permalink_url}.",
    payload: rec?.response,
  });

  // --- 3DS escalation: open the challenge, resolve it, retry once ---
  if (checkout.status === "requires_escalation") {
    s.lastEscalation = { continue_url: checkout.continue_url, at: Date.now() };
    s.checkout = checkout;
    if (challengeAttestation) throw new Error("escalation persisted after challenge — aborting");
    const challengeId = (checkout.continue_url ?? "").split("/").pop() ?? randomId("3ds", 12);
    emit(s, {
      layer: "UCP", kind: "verify", tag: "UCP", name: "Open 3-D Secure challenge",
      method: `GET ${checkout.continue_url}`,
      desc: "The platform opens the bank's continue_url for the user to complete Strong Customer Authentication (simulated trusted surface).",
      payload: { continue_url: checkout.continue_url, challenge_id: challengeId },
    });
    // Interactive human-present flow: pause and hand the bank page to the UI. The
    // browser opens continue_url; once the user approves, resolveThreeDs() resolves
    // the challenge and retries. Autonomous / scripted flows fall through to auto-resolve.
    if (opts.interactive && opts.humanPresent) return checkout;
    const att = await callTool<any>(CP_MCP, "resolve_challenge", { challenge_id: challengeId, outcome: "success" }, identity);
    emit(s, {
      layer: "AP2", kind: "mandate", name: "3-D Secure attestation",
      method: "user · biometric on bank surface",
      desc: "The user completed the challenge; the Credentials Provider returns an attestation the PSP trusts, so the retry succeeds without a second challenge.",
      payload: { challenge_id: challengeId, outcome: att.outcome, attestation: truncate(att.attestation, 24) },
      mandate: { kind: "3DS Attestation", id: challengeId, seal: "user · 3DS", rows: [["outcome", att.outcome], ["attestation", truncate(att.attestation, 20) ?? "—"]], sig: (att.attestation ?? "").slice(0, 20) },
      _auto: true,
    });
    return submitComplete(s, opts, att.attestation);
  }

  // --- AP2 Receipts: surface the merchant Checkout Receipt + PSP Payment Receipt
  //     (signed JWS) as a dedicated trace card. reference = hash of the closed
  //     mandate each binds to → non-repudiable dispute evidence. ---
  const decodeReceipt = (jws?: string): any => {
    try {
      return jws ? JSON.parse(b64u.decode(jws.split(".")[1]).toString("utf8")) : undefined;
    } catch {
      return undefined;
    }
  };
  const cr = decodeReceipt(checkout.ap2?.checkout_receipt);
  const pr = decodeReceipt(checkout.ap2?.payment_receipt);
  if (cr || pr) {
    emit(s, {
      layer: "AP2",
      tag: "AP2",
      kind: "mandate",
      name: "AP2 Receipts (Checkout + Payment)",
      method: "signed JWS · ES256",
      desc: "The merchant returns a signed Checkout Receipt and the PSP a signed Payment Receipt; each `reference` is the hash of the closed mandate it binds to — non-repudiable dispute evidence.",
      payload: { checkout_receipt: cr, payment_receipt: pr },
      mandate: {
        kind: "AP2 Receipts",
        id: cr?.order_id ?? pr?.payment_id ?? "receipts",
        seal: "merchant + PSP signed",
        rows: [
          ["checkout receipt", cr ? `${cr.status} · order ${String(cr.order_id ?? "").slice(-8)}` : "—"],
          ["payment receipt", pr ? `${pr.status} · pay ${String(pr.payment_id ?? "").slice(-8)}` : "—"],
          ["checkout ref", cr?.reference ? cr.reference.slice(0, 18) + "…" : "—"],
          ["payment ref", pr?.reference ? pr.reference.slice(0, 18) + "…" : "—"],
        ],
        sig: (checkout.ap2?.checkout_receipt ?? "").split(".")[2]?.slice(0, 42) ?? "",
      },
      _auto: true,
    });
  }

  return checkout;
}

function lc(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}

/* ================================================================== */
/* 5. Tracking                                                         */
/* ================================================================== */

export async function track(s: Session, waitMs = 12000): Promise<any> {
  const start = Date.now();
  while (!s.shipped && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!s.shipped) return { shipped: false };
  const event = s.shipped.fulfillment?.events?.find((e: any) => e.type === "shipped");
  const expectation = s.shipped.fulfillment?.expectations?.[0];
  return {
    shipped: true,
    carrier: event?.carrier,
    tracking: event?.tracking_number,
    permalink_url: s.shipped.permalink_url,
    eta: expectation?.delivery_by
      ? new Date(expectation.delivery_by).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : undefined,
  };
}

/* ================================================================== */
/* 6. Fulfillment options + discounts                                  */
/* ================================================================== */

export async function selectShipping(s: Session, optionId: string) {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const updated = await tracedTool<{ checkout: Checkout }>(s, {
    endpoint: s.merchantEndpoints[mid],
    tool: "update_checkout",
    args: { id: co.id, checkout: { fulfillment: { methods: [{ id: "shipping_1", groups: [{ id: "package_1", selected_option_id: optionId }] }] } } },
    name: `Update Checkout · Shipping (${optionId})`,
    desc: "tools/call update_checkout selecting a fulfillment option. Express costs more, so totals change and the merchant re-signs.",
    respDesc: "New totals reflecting the selected shipping option; fresh merchant_authorization.",
  });
  await verifyAndTraceMerchantAuth(s, updated.checkout, mid, "After shipping change");
  s.checkout = updated.checkout;
  return checkoutView(s);
}

export async function applyPromo(s: Session, code: string) {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const updated = await tracedTool<{ checkout: Checkout }>(s, {
    endpoint: s.merchantEndpoints[mid],
    tool: "update_checkout",
    args: { id: co.id, checkout: { discounts: { code } } },
    name: `Apply Discount Code (${code})`,
    desc: "tools/call update_checkout with a discount code (dev.ucp.shopping.discount). The merchant validates it and applies a negative discount line to totals.",
    respDesc: "Totals with the discount applied, or a warning message for an invalid code.",
  });
  await verifyAndTraceMerchantAuth(s, updated.checkout, mid, "After discount");
  s.checkout = updated.checkout;
  const warning = updated.checkout.messages?.find((m) => m.code === "invalid_discount_code");
  return { ...checkoutView(s), discount_warning: warning?.content };
}

/* ================================================================== */
/* 7. Identity Linking (OAuth 2.0) + order history                     */
/* ================================================================== */

export async function linkAccount(s: Session, merchantId: string): Promise<{ linked: boolean; scope: string }> {
  // RFC 8414 discovery → authorize (auto-approved) → token.
  const base = `${URLS.merchantPortal}/m/${merchantId}`;
  const meta: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const scope = "dev.ucp.shopping.order:read";
  const redirect = `${URLS.shoppingAgent}/oauth/callback`;
  emit(s, {
    layer: "UCP", kind: "request", name: "Identity Linking · OAuth authorize",
    method: `GET ${meta.authorization_endpoint}`,
    desc: "The platform links the user's account via business-hosted OAuth 2.0 (RFC 8414 discovery). The user grants the dev.ucp.shopping.order:read scope (auto-approved in the demo).",
    payload: { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint, scope },
  });
  // Authorize (no redirect follow — capture code from the Location header)
  const authRes = await fetch(`${meta.authorization_endpoint}?client_id=${encodeURIComponent(AGENT_PROFILE_URL)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&state=xyz`, { redirect: "manual" });
  const loc = authRes.headers.get("location") ?? "";
  const code = new URL(loc, base).searchParams.get("code") ?? (await authRes.json().catch(() => ({}))).code;
  const tokRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code ?? "", redirect_uri: redirect, client_id: AGENT_PROFILE_URL }),
  });
  const tok: any = await tokRes.json();
  s.accessToken = tok.access_token;
  emit(s, {
    layer: "UCP", kind: "response", name: "Identity Linking · access token",
    method: "POST /oauth/token",
    desc: "The authorization code was exchanged for a scoped access token. The agent can now read the user's order history.",
    payload: { token_type: tok.token_type, scope: tok.scope, expires_in: tok.expires_in, access_token: truncate(tok.access_token, 16) },
  });
  return { linked: !!tok.access_token, scope: tok.scope };
}

export async function listOrders(s: Session, merchantId: string) {
  if (!s.accessToken) await linkAccount(s, merchantId);
  const r = await tracedTool<any>(s, {
    endpoint: s.merchantEndpoints[merchantId] ?? `${URLS.merchantPortal}/m/${merchantId}/mcp`,
    tool: "list_orders",
    args: { access_token: s.accessToken },
    name: "List Orders (scoped)",
    desc: "tools/call list_orders, gated by the OAuth access token with dev.ucp.shopping.order:read. The merchant enforces the scope before returning history.",
    respDesc: "The linked user's orders.",
  });
  return { orders: r.orders };
}

/* ================================================================== */
/* 8. Refunds & disputes                                               */
/* ================================================================== */

export async function refundOrder(s: Session, opts: { amount?: number } = {}) {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const orderId = s.order?.id;
  const r = await tracedTool<any>(s, {
    endpoint: s.merchantEndpoints[mid],
    tool: "refund_order",
    args: { id: orderId, ...(opts.amount ? { amount: { amount: opts.amount, currency: "USD" } } : {}), reason: "requested_by_customer" },
    name: opts.amount ? "Refund Order (partial)" : "Refund Order (full)",
    desc: "tools/call refund_order. The merchant calls the PSP's refund_payment and records a post-order adjustment, then pushes a signed order.refunded webhook.",
    respDesc: "Order with a refund adjustment; payment status refunded/partially_refunded.",
  });
  const adj = r.order.adjustments?.find((a: any) => a.type === "refund");
  return { order_id: orderId, status: r.order.adjustments ? "refunded" : "unknown", refund: adj };
}

/* ---------------- post-purchase agency: delivery monitoring ---------------- */

/**
 * The agent's job doesn't end at payment: it re-reads the order, compares the
 * carrier's current delivery expectation with what the merchant promised at
 * purchase, and reports lateness so it can proactively remediate.
 */
export async function checkDelivery(s: Session) {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const r = await tracedTool<any>(s, {
    endpoint: s.merchantEndpoints[mid],
    tool: "get_order",
    args: { id: s.order?.id },
    name: "Delivery check · post-purchase monitoring",
    desc: "tools/call get_order — the agent monitors fulfillment after payment: it compares the carrier's current expectation against the delivery promise made at checkout.",
    respDesc: "Order with fulfillment expectations + carrier events.",
  });
  const order = r.order;
  const promised = s.order?.estimated_delivery;
  const expected = order?.fulfillment?.expectations?.[0]?.fulfillable_on;
  const lastEvent = order?.fulfillment?.events?.at(-1);
  // > 1h slip counts as late (demo granularity; real agents would use days).
  const late = !!(promised && expected && Date.parse(expected) > Date.parse(promised) + 36e5);
  emit(s, {
    layer: "UCP", tag: "UCP", kind: "verify", name: late ? "Delivery is LATE — promise broken" : "Delivery on track",
    method: "post-purchase agency",
    desc: late
      ? "The carrier's revised estimate is past the delivery promise the user paid for. The agent flags it and can proactively remediate (partial refund / dispute) on the user's behalf."
      : "The current carrier expectation honors the delivery promise made at checkout.",
    payload: { order_id: order?.id, promised, expected, late, last_event: lastEvent },
  });
  return { order_id: order?.id, late, promised, expected, last_event: lastEvent };
}

/** If delivery is late, proactively obtain a partial refund (10% goodwill). */
export async function remediateLateDelivery(s: Session) {
  const d = await checkDelivery(s);
  if (!d.late) return { ...d, remediated: false };
  const total = totalOf(s.checkout!);
  const refundAmount = Math.round(total * 0.1);
  const refund = await refundOrder(s, { amount: refundAmount });
  return { ...d, remediated: true, refund_minor: refundAmount, refund };
}

export async function fileDispute(s: Session, reason = "item_not_as_described") {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  const orderId = s.order?.id;
  const r = await tracedTool<any>(s, {
    endpoint: s.merchantEndpoints[mid],
    tool: "file_dispute",
    args: { id: orderId, reason },
    name: "File Dispute",
    desc: "tools/call file_dispute. The merchant attaches the AP2 mandate chain (user-signed cart/checkout mandates + verification log) as non-repudiable evidence for the adjudicator.",
    respDesc: "Dispute recorded with cryptographic evidence.",
  });
  emit(s, {
    layer: "AP2", kind: "mandate", name: "Dispute evidence (AP2 mandate chain)",
    method: "adjudicator package",
    desc: "In a dispute, the user-signed mandates prove the buyer authorized exactly these terms — the cryptographic chain of evidence the adjudicator uses to assign liability.",
    payload: r.evidence,
    mandate: { kind: "Dispute Evidence", id: orderId ?? "", seal: "user-signed mandates", rows: [["reason", reason], ["checkout mandate", "present ✓"], ["payment mandate", "present ✓"], ["merchant seal", "present ✓"]], sig: "" },
    _auto: true,
  });
  return { order_id: orderId, disputed: true, evidence: r.evidence };
}

/* ================================================================== */
/* 9. Cart capability + catalog lookup (demo coverage)                 */
/* ================================================================== */

export async function cartDemo(s: Session, merchantId: string, productId: string) {
  const ep = s.merchantEndpoints[merchantId] ?? `${URLS.merchantPortal}/m/${merchantId}/mcp`;
  const created = await tracedTool<any>(s, {
    endpoint: ep, tool: "create_cart",
    args: { cart: { line_items: [{ item: { id: productId }, quantity: 1 }], buyer: { email: s.address.email } } },
    name: "Create Cart", desc: "tools/call create_cart (dev.ucp.shopping.cart) — a basket before purchase intent is established.", respDesc: "A cart with line items and totals.",
  });
  const cartId = created.cart.id;
  const updated = await tracedTool<any>(s, {
    endpoint: ep, tool: "update_cart",
    args: { id: cartId, cart: { line_items: [{ id: created.cart.line_items[0].id, quantity: 2 }] } },
    name: "Update Cart · Quantity", desc: "tools/call update_cart adjusts quantity.", respDesc: "Recomputed cart totals.",
  });
  return { cart_id: cartId, total: updated.cart.totals.find((t: any) => t.type === "total")?.amount / 100 };
}

export async function lookupProduct(s: Session, merchantId: string, productId: string) {
  const ep = s.merchantEndpoints[merchantId] ?? `${URLS.merchantPortal}/m/${merchantId}/mcp`;
  const r = await tracedTool<any>(s, {
    endpoint: ep, tool: "get_product", args: { id: productId },
    name: "Get Product", desc: "tools/call get_product (dev.ucp.shopping.catalog.lookup) — full detail for one product.", respDesc: "Product detail with variants and pricing.",
  });
  return { product: { id: r.product.id, title: r.product.title, price: r.product.price_range.min.amount / 100 } };
}

export { verifyAndTraceMerchantAuth };

/* ================================================================== */
/* Passkeys (WebAuthn / SPC) — relayed to the Credentials Provider     */
/* ================================================================== */

export async function passkeyStatus(s: Session, rpId?: string) {
  return callTool<any>(CP_MCP, "passkey_status", { rp_id: rpId }, identity);
}

/** Read the user's spend-control policy (used by the UI to preview the rail). */
export async function getAgentPolicy() {
  return (await callTool<any>(CP_MCP, "get_agent_policy", {}, identity)).policy;
}

/* ---------------- approval workflow (human-in-the-loop) ---------------- */

/** Ask the user (Walletly inbox) to approve an autonomy-blocked purchase. */
export async function requestApproval(s: Session) {
  const co = s.checkout!;
  const items = co.line_items.map((l: any) => `${l.quantity}× ${l.item.title}`).join(", ");
  const r = await callTool<any>(CP_MCP, "request_approval", {
    checkout_id: co.id,
    amount: totalOf(co),
    currency: co.currency,
    merchant_id: co.merchant_id,
    merchant_name: s.merchants[co.merchant_id!]?.name,
    summary: items,
  }, identity);
  emit(s, {
    layer: "AP2", tag: "AP2", kind: "verify", name: "Approval requested · human-in-the-loop",
    method: `Walletly inbox · ${r.status}`,
    desc: "The purchase exceeds the user's autonomy policy, so instead of failing the agent files an approval request on the user's consent surface (Walletly). The checkout is held; an explicit user decision waives the autonomy gate for THIS checkout only — caps, budget and allowlist still apply.",
    payload: { approval_id: r.approval_id, status: r.status, checkout_id: co.id, amount_minor: totalOf(co) },
  });
  return r as { approval_id: string; status: string };
}

export async function approvalStatus(s: Session) {
  return callTool<any>(CP_MCP, "check_approval", { checkout_id: s.checkout?.id }, identity);
}
export async function passkeyRegisterOptions(s: Session, rpId?: string) {
  const r = await callTool<any>(CP_MCP, "passkey_register_options", { rp_id: rpId }, identity);
  return r.options;
}
export async function passkeyRegister(s: Session, response: any, challenge?: string, rpId?: string) {
  const r = await callTool<any>(CP_MCP, "passkey_register", { response, challenge, rp_id: rpId }, identity);
  emit(s, {
    layer: "AP2", kind: "verify", tag: "AP2", name: "Passkey enrolled",
    method: "WebAuthn registration",
    desc: "A platform passkey (Touch ID) was enrolled with the Credentials Provider. From now on, completing a checkout requires a verified passkey assertion bound to the exact terms.",
    payload: { credential_id: r.credential_id },
  });
  return r;
}

/**
 * A renderable snapshot of the session for the UI — products found (with the
 * agent's pick flagged), the checkout, and the order. Lets the scenario/agent
 * modes show the same rich cards as the manual flow.
 */
export function snapshot(s: Session) {
  const order = s.order
    ? {
        id: s.order.id,
        permalink_url: s.order.permalink_url,
        last4: s.instrument?.last4,
        eta: s.order.estimated_delivery
          ? new Date(s.order.estimated_delivery).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
          : undefined,
      }
    : null;
  return {
    constraints: s.constraints
      ? { category: s.constraints.category, max_total: s.constraints.max_total, delivery_days: s.constraints.delivery_days, features: s.constraints.required_features }
      : null,
    products: s.products.length ? { products: s.products.map(uiProduct), merchants: s.merchants } : null,
    picked: s.selection ? { productId: s.selection.items[0].item_id, merchant: s.selection.merchantId } : null,
    checkout: s.checkout && s.selection ? checkoutView(s) : null,
    order,
    shipped: s.shipped ? { carrier: s.shipped.fulfillment?.events?.find((e: any) => e.type === "shipped")?.carrier } : null,
  };
}

/* ================================================================== */
/* 10. Scenario runner — success & failure flows for the demo          */
/* ================================================================== */

/**
 * End-to-end HUMAN-NOT-PRESENT purchase, deterministic (no LLM). This is the
 * defining HNP experience: the user authorizes ONCE (Phase 1a — sign the open
 * mandates, then leave) and the agent completes the ENTIRE task autonomously
 * (Phase 1b shopping + Phase 2 payment) with NO further human interaction —
 * search, pick the best offer, check out, sign the closed mandates with the
 * agent key, and pay. Contrast with human-present, where the user drives each
 * step and approves the closed mandates with a biometric at pay time.
 */
/** The signed per-charge cap (minor units) the user actually asked for: an
 *  explicit "buy if it drops below $X" wins, else the stated budget. No silent
 *  inflation — undefined means the user set no cap. */
export function spendCapCents(c?: ParsedIntent): number | undefined {
  if (!c) return undefined;
  if (c.buy_below != null) return Math.round(c.buy_below * 100);
  if (c.max_total != null) return Math.round(c.max_total * 100);
  return undefined;
}

/** Pick the best authorized offer whose estimated TOTAL (with ~tax) fits the
 *  user's cap. Prefers the recommended product (s.products order) that fits,
 *  else the cheapest that fits. Returns null if nothing fits (the agent holds,
 *  rather than overspending). */
function pickOffer(s: Session, merchantIds: string[], capCents?: number): { product: MergedProduct; offer: MergedOffer } | null {
  const TAX = 1.09; // conservative buffer so tax doesn't push a pick over the cap
  const cands = s.products
    .map((p) => ({ product: p, offer: [...p.offers].filter((o) => merchantIds.includes(o.merchant)).sort((a, b) => a.price - b.price)[0] }))
    .filter((c): c is { product: MergedProduct; offer: MergedOffer } => !!c.offer);
  const within = cands.filter((c) => capCents == null || Math.round(c.offer.price * TAX) <= capCents);
  return within[0] ?? null;
}

export async function runAutonomous(s: Session, text: string) {
  // --- Phase 1a (human present): authorize autonomous commerce, then leave. ---
  setModality(s, false);
  // Isolation: a fresh user-initiated run never inherits a prior scenario's
  // standing-intent state (the subscription scenario sets these; reset defensively).
  s.recurring = false;
  s.occurrence = 0;
  const intent = await runIntent(s, text, { humanPresent: false });
  emit(s, {
    layer: "AP2", tag: "AP2", kind: "verify", name: "Phase 1a · User authorizes, then leaves",
    method: "open mandates signed on the Trusted Surface (biometric/consent)",
    desc: "Human-present sub-phase: the user approved the Open Checkout + Open Payment Mandates (constraints + cnf=agent key) on the Trusted Surface, permanently linking them. The user now LEAVES — everything below happens with NO user in the session.",
    payload: { open_checkout_mandate: s.openCheckoutMandate?.id, open_payment_mandate: s.openPaymentMandate?.id, agent_key: agentKey.publicJwk.kid },
  });
  if (!s.products.length) {
    emit(s, { layer: "UCP", tag: "UCP", kind: "verify", name: "Phase 1b · Nothing within constraints", method: "agent decision", desc: "No offer satisfied the signed constraints, so the agent does NOT buy. No purchase = the user's mandates protected them.", payload: {} });
    return { intent, autonomous: true, order: null, note: "no offer matched the signed constraints" };
  }
  // --- Phase 1b (human NOT present): the agent autonomously picks the best offer
  //     that FITS the user's signed cap (never overspends). ---
  const capCents = spendCapCents(s.constraints);
  const picked = pickOffer(s, s.eligible, capCents);
  if (!picked) {
    emit(s, { layer: "AP2", tag: "AP2", kind: "verify", name: "Phase 1b · Held — nothing within your cap", method: "open Payment Mandate amount_range", desc: `No offer's total fits your signed cap of ${capCents != null ? money(capCents) : "—"}; the agent does NOT buy (it won't exceed what you authorized).`, payload: { cap: capCents } });
    return { intent, autonomous: true, order: null, watching: true, cap: capCents != null ? capCents / 100 : undefined, note: "no offer within the signed cap" };
  }
  const best = picked.product;
  const offer = picked.offer;
  emit(s, {
    layer: "UCP", tag: "UCP", kind: "verify", name: "Phase 1b · Agent shops autonomously (no user)",
    method: "agent selection within signed constraints",
    desc: `No user in session. The agent selects ${best.name} at ${s.merchants[offer.merchant]?.name ?? offer.merchant} — the best offer within your cap that satisfies the open Checkout Mandate's allowed_merchants + line_items — and opens a merchant-signed checkout.`,
    payload: { product: best.id, merchant: offer.merchant, price: offer.price, cap: capCents },
  });
  await select(s, best.id, offer.merchant);
  await createCheckout(s);
  // Exact cap check now that the real total (incl. tax) is known.
  const total = totalOf(s.checkout!);
  if (capCents != null && total > capCents) {
    emit(s, {
      layer: "AP2", tag: "AP2", kind: "verify", name: "Phase 2 · Held — above the signed cap",
      method: "open Payment Mandate amount_range",
      desc: `The total ${money(total)} is above your signed cap of ${money(capCents)}. The agent does NOT buy — the Open Payment Mandate protects you.`,
      payload: { current_total: total, cap: capCents },
    });
    return { intent, autonomous: true, order: null, watching: true, product: best.name, product_id: best.id, merchant: offer.merchant, current_total: total / 100, cap: capCents / 100 };
  }
  // --- Phase 2 (human NOT present): mint the instrument, then the agent signs the
  //     closed Checkout + Payment Mandates with its OWN key and completes. ---
  await preparePayment(s);
  const r = await confirmAndPay(s, { humanPresent: false });
  return { intent, autonomous: true, product: best.name, product_id: best.id, merchant: offer.merchant, order: r.order, total: r.total, receipts: r.receipts };
}

/**
 * INTERACTIVE human-not-present — Phase 1a, part 1: parse the request and
 * discover what the user must choose to authorize autonomy (which merchants the
 * agent may use, and which payment method), WITHOUT signing anything yet. The UI
 * presents these; the user picks; then authorizeAndRun signs + runs.
 */
export async function prepareAutonomy(s: Session, text: string) {
  setModality(s, false);
  // Isolation: never inherit a prior scenario's standing-intent state.
  s.recurring = false;
  s.occurrence = 0;
  const intent = await runIntent(s, text, { humanPresent: false, deferOpenMandates: true });
  const payment_methods = await listPaymentMethods(s);
  return {
    constraints: intent.constraints,
    merchants: s.eligible.map((id) => ({ id, name: s.merchants[id]?.name ?? id })),
    products: intent.products,
    payment_methods,
  };
}

/**
 * INTERACTIVE human-not-present — Phase 1a (authorize) + Phase 1b/2 (autonomous).
 * Signs the open mandates with the user's CHOSEN merchant allowlist + payment
 * method, then the agent autonomously picks the best authorized offer, checks
 * out, signs the closed mandates with its own key, and pays.
 */
export async function authorizeAndRun(s: Session, opts: { merchantIds?: string[]; methodId?: string }) {
  s.humanPresent = false;
  const merchantIds = opts.merchantIds?.length ? opts.merchantIds.filter((m) => s.eligible.includes(m)) : s.eligible;
  const methods = await listPaymentMethods(s);
  const method = methods.find((m: any) => m.id === opts.methodId) ?? methods.find((m: any) => m.default) ?? methods[0];
  const instrument: Ap2PaymentInstrument | undefined = method
    ? { id: `instr_${method.last4}`, type: method.rail === "rtp" ? "bank_account" : "card", description: method.display }
    : undefined;

  // --- Phase 1a: sign the open mandates with the user's chosen constraints. ---
  await issueOpenMandates(s, s.constraints!, { allowedMerchantIds: merchantIds, instrument });
  emit(s, {
    layer: "AP2", tag: "AP2", kind: "verify", name: "Phase 1a · Authorized, then user leaves",
    method: "open mandates signed on the Trusted Surface",
    desc: `The user authorized autonomous commerce: allowed_merchants = ${merchantIds.map((m) => s.merchants[m]?.name ?? m).join(", ")}; payment = ${method?.display ?? "default"}; spend capped by the budget. The user now LEAVES — everything below runs with NO further interaction.`,
    payload: { allowed_merchants: merchantIds, payment_method: method?.display, open_checkout_mandate: s.openCheckoutMandate?.id, open_payment_mandate: s.openPaymentMandate?.id },
  });

  // --- Phase 1b: the agent autonomously picks the best AUTHORIZED offer within the cap. ---
  const capCents = spendCapCents(s.constraints);
  const chosen = pickOffer(s, merchantIds, capCents);
  if (!chosen) {
    emit(s, { layer: "UCP", tag: "UCP", kind: "verify", name: "Phase 1b · No authorized offer within cap", method: "agent decision", desc: `None of the authorized merchants had a matching offer${capCents != null ? ` within your ${money(capCents)} cap` : ""} — the agent does not buy.`, payload: { allowed_merchants: merchantIds, cap: capCents } });
    return { autonomous: true, order: null, note: "no offer at the authorized merchants within the cap" };
  }
  const pickProduct = chosen.product;
  const pickOff = chosen.offer;
  emit(s, {
    layer: "UCP", tag: "UCP", kind: "verify", name: "Phase 1b · Agent shops autonomously (no user)",
    method: "agent selection within signed constraints",
    desc: `No user in session. The agent picks ${pickProduct.name} at ${s.merchants[pickOff.merchant]?.name ?? pickOff.merchant} (best authorized offer within your cap) and opens a merchant-signed checkout.`,
    payload: { product: pickProduct.id, merchant: pickOff.merchant, price: pickOff.price, cap: capCents },
  });
  await select(s, pickProduct.id, pickOff.merchant);
  await createCheckout(s);

  // Exact cap check now that the real total (incl. tax) is known.
  const total = totalOf(s.checkout!);
  if (capCents != null && total > capCents) {
    emit(s, { layer: "AP2", tag: "AP2", kind: "verify", name: "Phase 2 · Held — above the signed cap", method: "open Payment Mandate amount_range", desc: `Total ${money(total)} is above your ${money(capCents)} cap; the agent holds and does not buy.`, payload: { current_total: total, cap: capCents } });
    return { autonomous: true, order: null, watching: true, product: pickProduct.name, current_total: total / 100, cap: capCents / 100 };
  }

  // --- Phase 2: mint the chosen method, agent-sign the closed mandates, pay. ---
  await preparePayment(s, opts.methodId);
  const r = await confirmAndPay(s, { humanPresent: false });
  return { autonomous: true, product: pickProduct.name, merchant: pickOff.merchant, payment_method: method?.display, allowed_merchants: merchantIds, order: r.order, total: r.total, receipts: r.receipts };
}

export interface ScenarioDef {
  id: string;
  title: string;
  kind: "success" | "failure" | "feature";
  blurb: string;
}

export const SCENARIOS: ScenarioDef[] = [
  { id: "happy", title: "Happy path", kind: "success", blurb: "Discover → cart → mandates → pay → order → ship." },
  { id: "express", title: "Express shipping", kind: "success", blurb: "Pick next-day shipping; totals change and the cart is re-signed." },
  { id: "promo", title: "Discount code", kind: "success", blurb: "Apply SHOPPY10; a negative discount line is added." },
  { id: "human_not_present", title: "Human-not-present", kind: "success", blurb: "Buy autonomously under a signed intent (human_present=false)." },
  { id: "threeds", title: "3-D Secure step-up", kind: "failure", blurb: "Bank requires SCA → escalation → resolve → retry succeeds." },
  { id: "decline", title: "Card declined", kind: "failure", blurb: "Issuer hard-declines; surfaced gracefully with a web fallback." },
  { id: "tamper", title: "Tampered cart", kind: "failure", blurb: "Alter the cart after signing → mandate_scope_mismatch." },
  { id: "replay", title: "Replay attack", kind: "failure", blurb: "Re-send a captured request → idempotency / 409 on altered body." },
  { id: "expired", title: "Expired mandate", kind: "failure", blurb: "Submit a past-exp checkout mandate → mandate_expired." },
  { id: "stolen_key", title: "Stolen agent key", kind: "failure", blurb: "Sign with a key not in the profile → key_not_found." },
  { id: "refund", title: "Refund", kind: "feature", blurb: "Complete an order, then refund it (PSP + adjustment + webhook)." },
  { id: "dispute", title: "Dispute", kind: "feature", blurb: "File a dispute; AP2 mandate chain is the adjudicator evidence." },
  { id: "identity", title: "Identity linking", kind: "feature", blurb: "OAuth link, then read scoped order history." },
  { id: "cart", title: "Cart capability", kind: "feature", blurb: "create_cart / update_cart before checkout intent." },
  { id: "lookup", title: "Catalog lookup", kind: "feature", blurb: "get_product detail via dev.ucp.shopping.catalog.lookup." },
  { id: "over_budget", title: "Over per-tx cap", kind: "failure", blurb: "Policy caps a transaction at $100; a $300 buy is refused at mint (spend controls)." },
  { id: "merchant_blocked", title: "Merchant not allowed", kind: "failure", blurb: "Policy allowlists SoundHub only; buying at Wavelength is refused." },
  { id: "autonomy", title: "Autonomy enforced", kind: "failure", blurb: "Policy says always-ask; a human-not-present purchase is blocked." },
  { id: "rtp_rail", title: "RTP rail (multi-rail)", kind: "success", blurb: "Settle via instant bank transfer instead of the card network." },
  { id: "kya_blocked", title: "Suspended agent (KYA)", kind: "failure", blurb: "Registry suspends the agent; merchant + PSP refuse (agent_untrusted)." },
  { id: "velocity", title: "Velocity exceeded", kind: "failure", blurb: "3 rapid purchases with a 2/min limit → 3rd declined, reputation dinged." },
  { id: "late_delivery", title: "Late delivery → refund", kind: "feature", blurb: "Carrier slips the ETA; the agent detects it and secures a 10% refund." },
  { id: "approval", title: "Approval workflow", kind: "feature", blurb: "Autonomy-blocked purchase → Walletly inbox → user approves → purchase completes." },
  { id: "subscription", title: "Standing intent (recurring)", kind: "success", blurb: "One signed Open Payment Mandate (agent_recurrence) authorizes two autonomous purchase cycles." },
  { id: "hnp_price_drop", title: "HNP: pre-authorize → price drop → auto-buy", kind: "success", blurb: "User authorizes 'buy if ≤ $260' and leaves; a merchant price-drop trigger fires and the agent buys autonomously — the canonical AP2 human-not-present flow." },
  { id: "hnp_over_cap", title: "HNP: signed amount cap", kind: "failure", blurb: "Autonomous buy above the Open Payment Mandate amount_range → the PSP rejects it (mandate_scope_mismatch)." },
  { id: "hnp_merchant_blocked", title: "HNP: merchant not allowed", kind: "failure", blurb: "Agent buys at a merchant outside the Open Checkout Mandate allowed_merchants → the merchant rejects it." },
];

const HEADPHONES = "I'm looking for over-ear noise-cancelling headphones. Budget is under $300, and I need them delivered within 2 days.";

async function toCheckout(s: Session, merchant = "wavelength", product = "cadence-anc-pro") {
  await runIntent(s, HEADPHONES);
  await select(s, product, merchant);
  await createCheckout(s);
  // Spec Resolution Flow (step 6): validate the checkout RESPONSE against the
  // composed schema (base checkout + active extension $defs).
  try {
    const co = s.checkout;
    const mid = co?.merchant_id;
    if (co && mid) {
      const res = resolveComposedCheckoutSchema(s.negotiated?.[mid] ?? []).validate(co);
      emit(s, {
        layer: "UCP",
        kind: "verify",
        tag: "UCP",
        name: res.ok ? "Schema Validation · checkout ✓" : "Schema Validation · checkout (issues)",
        method: "composed checkout schema (allOf)",
        desc: "The checkout response is validated against the composed schema (base checkout + active extension $defs).",
        payload: { valid: res.ok, ...(res.ok ? {} : { errors: res.errors }) },
      });
    }
  } catch {
    /* best-effort validation */
  }
}

/** Run a named scenario on an existing session, streaming trace events. */
export async function runScenario(s: Session, id: string): Promise<{ id: string; outcome: string; detail: any; snapshot: ReturnType<typeof snapshot> }> {
  const r = await runScenarioInner(s, id);
  return { ...r, snapshot: snapshot(s) };
}

async function runScenarioInner(s: Session, id: string): Promise<{ id: string; outcome: string; detail: any }> {
  const note = (msg: string) =>
    emit(s, { layer: "UCP", tag: "UCP", kind: "verify", name: `Scenario: ${id}`, method: "demo", desc: msg, payload: {} });

  switch (id) {
    case "happy": {
      await toCheckout(s);
      await preparePayment(s);
      const r = await confirmAndPay(s);
      return { id, outcome: "order_created", detail: { order: r.order?.id, total: r.total } };
    }
    case "express": {
      await toCheckout(s);
      const before = totalOf(s.checkout!);
      await selectShipping(s, "express_next_day");
      const after = totalOf(s.checkout!);
      note(`Shipping changed total from ${money(before)} to ${money(after)} (express +$15) and re-signed.`);
      await preparePayment(s);
      const r = await confirmAndPay(s);
      return { id, outcome: "order_created", detail: { before: before / 100, after: after / 100, order: r.order?.id } };
    }
    case "promo": {
      await toCheckout(s);
      const v = await applyPromo(s, "SHOPPY10");
      await preparePayment(s);
      const r = await confirmAndPay(s);
      return { id, outcome: "order_created", detail: { total: v.totals.total, order: r.order?.id } };
    }
    case "human_not_present": {
      s.humanPresent = false;
      note("Human-not-present: the user signs Open Checkout + Open Payment Mandates (constraints + cnf=agent key); the agent then signs the closed mandates itself and buys without the user in session.");
      await toCheckout(s);
      await preparePayment(s);
      const r = await confirmAndPay(s, { humanPresent: false });
      return { id, outcome: "order_created", detail: { modality: "human_not_present", order: r.order?.id } };
    }
    case "threeds": {
      await toCheckout(s);
      const methods = await listPaymentMethods(s);
      const amex = methods.find((m: any) => m.behavior === "challenge") ?? methods.find((m: any) => m.last4 === "0005");
      await preparePayment(s, amex?.id);
      note("Paying with the 3DS test card → bank will require Strong Customer Authentication.");
      const r = await confirmAndPay(s);
      return { id, outcome: r.order ? "order_created_after_3ds" : "escalated", detail: { escalated: r.escalated, order: r.order?.id } };
    }
    case "decline": {
      await toCheckout(s);
      const methods = await listPaymentMethods(s);
      const bad = methods.find((m: any) => m.behavior === "decline") ?? methods.find((m: any) => m.last4 === "0341");
      await preparePayment(s, bad?.id);
      note("Paying with the always-declining card → issuer hard-decline.");
      try {
        await confirmAndPay(s);
        return { id, outcome: "unexpected_success", detail: {} };
      } catch (e: any) {
        return { id, outcome: "payment_declined", detail: { error: e.data?.content ?? e.message, code: e.messages?.[0]?.code ?? "payment_declined" } };
      }
    }
    case "tamper": {
      await toCheckout(s);
      await preparePayment(s);
      // Sign the mandates over the CURRENT, validly merchant-signed checkout…
      const co = s.checkout!;
      const total0 = totalOf(co);
      const cmSigned = await callTool<any>(CP_MCP, "sign_mandate", { kind: "CheckoutMandate", payload: { checkout: co, human_present: true, aud: merchantProfileUrl(co.merchant_id!), nonce: co.id } }, identity);
      const cm = await callTool<any>(CP_MCP, "sign_mandate", { kind: "PaymentMandate", payload: makePm(s) }, identity);
      s.paymentMandate = { id: cm.id, jws: cm.jws, payload: makePm(s) } as any;
      // …then ALTER THE CART AFTER SIGNING: selecting express shipping re-prices
      // and re-signs the live session, so the embedded (signed) checkout no longer
      // matches the live terms → the merchant's terms check rejects it.
      await selectShipping(s, "express_next_day");
      note(`Cart altered after signing — total ${money(total0)} → ${money(totalOf(s.checkout!))}; submitting the now-stale checkout mandate (terms no longer match the live session).`);
      try {
        await callTool(s.merchantEndpoints[co.merchant_id!], "complete_checkout", { id: co.id, checkout: { payment: { instruments: [payInstrument(s)] }, ap2: { checkout_mandate: cmSigned.jws } } }, identity);
        return { id, outcome: "unexpected_success", detail: {} };
      } catch (e: any) {
        return { id, outcome: "rejected", detail: { code: e.data?.code ?? "mandate_scope_mismatch", error: e.message } };
      }
    }
    case "replay": {
      await toCheckout(s);
      // Two identical unsigned... no — replay a SIGNED search with a reused idempotency key.
      const res = await replayDemo(s);
      return { id, outcome: res.outcome, detail: res.detail };
    }
    case "expired": {
      await toCheckout(s);
      await preparePayment(s);
      const co = s.checkout!;
      // Ask the CP to issue a properly-signed but already-EXPIRED checkout mandate.
      const expired = await callTool<any>(CP_MCP, "sign_mandate", { kind: "CheckoutMandate", payload: { checkout: co, human_present: true, aud: merchantProfileUrl(co.merchant_id!), nonce: co.id, exp_override: -3600 } }, identity);
      const pmE = await callTool<any>(CP_MCP, "sign_mandate", { kind: "PaymentMandate", payload: makePm(s) }, identity);
      s.paymentMandate = { id: pmE.id, jws: pmE.jws, payload: makePm(s) } as any;
      note("Submitting a checkout mandate whose exp is one hour in the past.");
      try {
        await callTool(s.merchantEndpoints[co.merchant_id!], "complete_checkout", { id: co.id, checkout: { payment: { instruments: [payInstrument(s)] }, ap2: { checkout_mandate: expired.jws } } }, identity);
        return { id, outcome: "unexpected_success", detail: {} };
      } catch (e: any) {
        return { id, outcome: "rejected", detail: { code: e.data?.code ?? "mandate_expired", error: e.message } };
      }
    }
    case "stolen_key": {
      await toCheckout(s);
      const co = s.checkout!;
      const rogue = generateSigningKey("rogue-agent-key");
      note("An attacker with a stolen-but-unpublished key signs a request to the merchant.");
      try {
        await callTool(s.merchantEndpoints[co.merchant_id!], "get_checkout", { id: co.id }, { key: rogue, profileUrl: AGENT_PROFILE_URL });
        return { id, outcome: "unexpected_success", detail: {} };
      } catch (e: any) {
        return { id, outcome: "rejected", detail: { code: e.data?.code ?? "key_not_found", error: e.message } };
      }
    }
    case "refund": {
      await toCheckout(s);
      await preparePayment(s);
      await confirmAndPay(s);
      const r = await refundOrder(s);
      return { id, outcome: "refunded", detail: r };
    }
    case "dispute": {
      await toCheckout(s);
      await preparePayment(s);
      await confirmAndPay(s);
      const r = await fileDispute(s);
      return { id, outcome: "disputed", detail: { order: r.order_id } };
    }
    case "identity": {
      await toCheckout(s);
      await preparePayment(s);
      await confirmAndPay(s);
      const r = await listOrders(s, s.checkout!.merchant_id!);
      return { id, outcome: "linked", detail: { orders: r.orders.length } };
    }
    case "cart": {
      await runIntent(s, HEADPHONES);
      const r = await cartDemo(s, "wavelength", "cadence-anc-pro");
      return { id, outcome: "cart_built", detail: r };
    }
    case "lookup": {
      await runIntent(s, HEADPHONES);
      const r = await lookupProduct(s, "wavelength", "cadence-anc-pro");
      return { id, outcome: "looked_up", detail: r.product };
    }

    /* ---- spend controls & programmable payment ---- */
    case "over_budget": {
      note("The user's wallet policy caps single transactions at $100. The agent tries a ~$300 purchase — the Credentials Provider must refuse to mint the instrument.");
      await setPolicy({ per_tx_cap: 10_000 }); // $100 cap
      try {
        await toCheckout(s);
        try {
          await preparePayment(s);
          return { id, outcome: "UNEXPECTED_SUCCESS", detail: {} };
        } catch (e: any) {
          note(`Blocked as designed: ${e.message}`);
          return { id, outcome: "blocked_by_policy", detail: { error: e.message, code: "policy_per_tx_cap_exceeded" } };
        }
      } finally {
        await setPolicy({ per_tx_cap: 100_000 });
      }
    }
    case "merchant_blocked": {
      note("The user only allows purchases at SoundHub. The agent tries Wavelength — the policy's merchant allowlist must refuse.");
      await setPolicy({ merchants_allowed: ["soundhub"] });
      try {
        await toCheckout(s); // wavelength
        try {
          await preparePayment(s);
          return { id, outcome: "UNEXPECTED_SUCCESS", detail: {} };
        } catch (e: any) {
          note(`Blocked as designed: ${e.message}`);
          return { id, outcome: "blocked_by_policy", detail: { error: e.message, code: "policy_merchant_not_allowed" } };
        }
      } finally {
        await setPolicy({ merchants_allowed: [] }); // back to "any"
      }
    }
    case "autonomy": {
      note("The user's policy says ALWAYS ask before paying. The agent attempts a human-not-present purchase — autonomy enforcement must stop it (agent pre-check + CP at signing).");
      await setPolicy({ autonomy: "always_ask" });
      try {
        s.humanPresent = false;
        await toCheckout(s);
        await preparePayment(s).catch(() => {}); // mint may already block; proceed to show the agent-side check too
        try {
          await confirmAndPay(s, { humanPresent: false });
          return { id, outcome: "UNEXPECTED_SUCCESS", detail: {} };
        } catch (e: any) {
          note(`Blocked as designed: ${e.message}`);
          return { id, outcome: "autonomy_enforced", detail: { error: e.message } };
        }
      } finally {
        s.humanPresent = true;
        await setPolicy({ autonomy: "ask_above" });
      }
    }

    /* ---- multi-rail settlement ---- */
    case "rtp_rail": {
      note("Multi-rail settlement: the user's policy prefers RTP (instant bank transfer). The agent selects the RTP handler advertised by the merchant; the PSP settles instantly off the card network.");
      await toCheckout(s);
      await preparePayment(s, "pm_rtp_checking");
      const r = await confirmAndPay(s);
      return { id, outcome: "order_created", detail: { rail: s.rail, order: r.order?.id, total: r.total } };
    }

    /* ---- KYA registry / reputation ---- */
    case "kya_blocked": {
      note("Know Your Agent: the registry suspends this agent (e.g. compromised). The merchant checks the registry at completion and must refuse — and the PSP would too.");
      await fetch(`${URLS.paymentProvider}/api/psp/registry`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_url: AGENT_PROFILE_URL, status: "suspended" }),
      });
      try {
        await toCheckout(s);
        await preparePayment(s);
        try {
          await confirmAndPay(s);
          return { id, outcome: "UNEXPECTED_SUCCESS", detail: {} };
        } catch (e: any) {
          note(`Blocked as designed: ${e.message}`);
          return { id, outcome: "agent_untrusted", detail: { error: e.message } };
        }
      } finally {
        await fetch(`${URLS.paymentProvider}/api/psp/registry`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile_url: AGENT_PROFILE_URL, status: "active" }),
        });
      }
    }

    /* ---- velocity / agent-native fraud rules ---- */
    case "velocity": {
      note("Agent-native fraud rule: the PSP rate-limits authorizations per agent. With the limit set to 2/min, the 3rd rapid purchase must be declined (velocity_exceeded) and the agent's reputation dinged.");
      const prevLimit = await fetch(`${URLS.paymentProvider}/api/psp/state`).then((r) => r.json()).then((j: any) => j.velocity?.limit ?? 60).catch(() => 60);
      await fetch(`${URLS.paymentProvider}/api/psp/velocity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 2 }) });
      try {
        const results: string[] = [];
        for (let i = 0; i < 3; i++) {
          // fresh purchase each round on the same session state
          await toCheckout(s);
          await preparePayment(s);
          try {
            const r = await confirmAndPay(s);
            results.push(`purchase ${i + 1}: order ${r.order?.id}`);
          } catch (e: any) {
            note(`Purchase ${i + 1} declined: ${e.message}`);
            results.push(`purchase ${i + 1}: DECLINED (${e.message})`);
            return { id, outcome: "velocity_exceeded", detail: { results } };
          }
        }
        return { id, outcome: "UNEXPECTED_SUCCESS", detail: { results } };
      } finally {
        await fetch(`${URLS.paymentProvider}/api/psp/velocity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: prevLimit }) });
      }
    }

    /* ---- post-purchase agency ---- */
    case "late_delivery": {
      note("Post-purchase agency: after payment the merchant ships LATE (carrier slips the ETA 3 days). The agent detects the broken promise and proactively secures a 10% partial refund.");
      await toCheckout(s);
      await preparePayment(s);
      const r = await confirmAndPay(s);
      // Ship late via the portal's fulfillment-center control (instead of the auto-ship).
      await fetch(`${URLS.merchantPortal}/api/portal/ship`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant_id: s.checkout!.merchant_id, order_id: r.order?.id, late: true }),
      });
      const d = await remediateLateDelivery(s);
      return { id, outcome: d.remediated ? "late_detected_refunded" : "on_track", detail: d };
    }

    /* ---- approval workflow (human-in-the-loop) ---- */
    case "approval": {
      note("The policy allows autonomous purchases only below $100. A ~$300 autonomous purchase is held for HUMAN APPROVAL: a request lands in the Walletly inbox, the user approves, and the purchase completes.");
      await setPolicy({ autonomy: "ask_above", ask_above_amount: 10_000 });
      s.humanPresent = false;
      try {
        await toCheckout(s);
        let blockedAtMint = "";
        try { await preparePayment(s); } catch (e: any) { blockedAtMint = e.message; }
        const ar = await requestApproval(s);
        const pending = await approvalStatus(s);
        note(`Approval ${ar.approval_id} is ${pending.status} in the Walletly inbox — the user clicks Approve…`);
        // Simulate the user's click on the consent surface (Walletly inbox).
        await fetch(`${URLS.credentialsProvider}/api/wallet/approval`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: ar.approval_id, decision: "approved" }),
        });
        await preparePayment(s); // now passes — the approval waives the autonomy gate
        const r = await confirmAndPay(s, { humanPresent: false });
        return { id, outcome: "approved_after_review", detail: { blocked_first: blockedAtMint, approval_id: ar.approval_id, order: r.order?.id } };
      } finally {
        s.humanPresent = true;
        await setPolicy({ autonomy: "ask_above", ask_above_amount: 50_000 });
      }
    }

    /* ---- standing intent: recurring autonomous purchases ---- */
    case "subscription": {
      note("Standing intent: the user signs ONE Open Payment Mandate carrying a payment.agent_recurrence constraint (ON_DEMAND ×2). The agent runs two autonomous purchase cycles under it — each gets a fresh agent-signed closed checkout/payment mandate, but the SAME open mandates are verified by merchant and PSP every time, and the occurrence count is bounded.");
      s.humanPresent = false;
      s.recurring = true;
      try {
        await toCheckout(s);
        const openId = s.openPaymentMandate?.id;
        await preparePayment(s);
        const r1 = await confirmAndPay(s, { humanPresent: false });
        // Cycle 2 — no new authorization: reuse the standing open mandates.
        await select(s, "cadence-anc-pro", "wavelength");
        await createCheckout(s);
        await preparePayment(s);
        const r2 = await confirmAndPay(s, { humanPresent: false });
        const reused = s.openPaymentMandate?.id === openId;
        note(`Cycle 2 completed under the same Open Payment Mandate ${openId} (reused=${reused}, occurrence=${s.occurrence} of 2).`);
        return { id, outcome: "subscription_cycles_completed", detail: { open_payment_mandate: openId, reused, occurrences: s.occurrence, orders: [r1.order?.id, r2.order?.id] } };
      } finally {
        s.humanPresent = true;
        s.recurring = false;
      }
    }

    /* ---- HNP: Open Payment Mandate amount cap enforced by the PSP ---- */
    case "hnp_over_cap": {
      note("Human-not-present: the user authorizes autonomous spend up to only $50 via the Open Payment Mandate amount_range. The agent then assembles a ~$329 checkout and signs the closed mandates — the PSP must reject it against the signed cap (the open mandate, not just wallet policy).");
      s.humanPresent = false;
      try {
        await toCheckout(s); // normal open mandates + a ~$329 cadence checkout
        // Replace the Open Payment Mandate with a deliberately tight $50 cap
        // (still user-signed at the CP, cnf=agent), referencing the same open checkout.
        const now = Math.floor(Date.now() / 1000);
        const tight: OpenPaymentMandatePayload = {
          vct: OPEN_PAYMENT_MANDATE_VCT,
          id: randomId("opm"),
          user: "user_alex",
          constraints: [amountRangeConstraint("USD", 5000), paymentReferenceConstraint(openMandateDigest(s.openCheckoutMandate!.sdJwt))],
          cnf: { jwk: agentKey.publicJwk },
          iat: now,
          exp: now + 30 * 60,
        };
        const signed = await callTool<any>(CP_MCP, "sign_mandate", { kind: "OpenPaymentMandate", payload: tight }, identity);
        s.openPaymentMandate = { id: tight.id, segment: signed.segment, sdJwt: signed.sdJwt, payload: tight };
        await preparePayment(s);
        await confirmAndPay(s, { humanPresent: false });
        return { id, outcome: "unexpected_success", detail: {} };
      } catch (e: any) {
        return { id, outcome: "rejected", detail: { code: e.data?.code ?? "mandate_scope_mismatch", error: e.message } };
      } finally {
        s.humanPresent = true;
      }
    }

    /* ---- HNP: Open Checkout Mandate allowed_merchants enforced by the merchant ---- */
    case "hnp_merchant_blocked": {
      note("Human-not-present: the user's Open Checkout Mandate allows SoundHub only. The agent autonomously assembles and signs a Wavelength checkout — the merchant must reject it against allowed_merchants.");
      s.humanPresent = false;
      try {
        await runIntent(s, HEADPHONES, { humanPresent: false });
        // Restrict the Open Checkout Mandate to SoundHub only (user-signed, cnf=agent).
        const now = Math.floor(Date.now() / 1000);
        const restricted: OpenCheckoutMandatePayload = {
          vct: OPEN_CHECKOUT_MANDATE_VCT,
          id: randomId("ocm"),
          user: "user_alex",
          constraints: [
            allowedMerchantsConstraint([{ id: "soundhub", name: s.merchants["soundhub"]?.name ?? "SoundHub", website: merchantProfileUrl("soundhub") }]),
            lineItemsConstraint([{ id: "line_1", acceptable_items: s.products.slice(0, 8).map((p) => ({ id: p.id, title: p.name })), quantity: 1 }]),
          ],
          cnf: { jwk: agentKey.publicJwk },
          iat: now,
          exp: now + 30 * 60,
        };
        const signed = await callTool<any>(CP_MCP, "sign_mandate", { kind: "OpenCheckoutMandate", payload: restricted }, identity);
        s.openCheckoutMandate = { id: restricted.id, segment: signed.segment, sdJwt: signed.sdJwt, payload: restricted };
        await select(s, "cadence-anc-pro", "wavelength");
        await createCheckout(s);
        await preparePayment(s);
        await confirmAndPay(s, { humanPresent: false });
        return { id, outcome: "unexpected_success", detail: {} };
      } catch (e: any) {
        return { id, outcome: "rejected", detail: { code: e.data?.code ?? "mandate_scope_mismatch", error: e.message } };
      } finally {
        s.humanPresent = true;
      }
    }

    /* ---- HNP: pre-authorize → leave → price-drop trigger → autonomous buy ---- */
    case "hnp_price_drop": {
      note("Human-not-present (pre-authorized + triggered) — the canonical AP2 flow. Phase 1a: the user authorizes 'buy the Cadence ANC Pro if it drops to ≤ $260', the agent signs the Open Checkout + Payment Mandates (cnf=agent), and the user LEAVES. The agent then watches; a merchant price-drop event fires and the agent buys autonomously with no user present.");
      s.humanPresent = false;
      const setPrice = (price: number) =>
        fetch(`${URLS.merchantPortal}/api/portal/catalog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchant_id: "wavelength", product_id: "cadence-anc-pro", price }),
        }).catch(() => {});
      try {
        await runIntent(s, HEADPHONES, { humanPresent: false });
        // Tight cap at $260 — below the ~$274 list price — referencing the open checkout.
        const now = Math.floor(Date.now() / 1000);
        const capped: OpenPaymentMandatePayload = {
          vct: OPEN_PAYMENT_MANDATE_VCT,
          id: randomId("opm"),
          user: "user_alex",
          constraints: [amountRangeConstraint("USD", 26000), paymentReferenceConstraint(openMandateDigest(s.openCheckoutMandate!.sdJwt))],
          cnf: { jwk: agentKey.publicJwk },
          iat: now,
          exp: now + 30 * 60,
        };
        const signed = await callTool<any>(CP_MCP, "sign_mandate", { kind: "OpenPaymentMandate", payload: capped }, identity);
        s.openPaymentMandate = { id: capped.id, segment: signed.segment, sdJwt: signed.sdJwt, payload: capped };
        note("Authorized: buy only at ≤ $260. The Cadence is currently above that, so the agent does NOT buy — it watches. The user has left the session.");
        // --- Trigger: the merchant drops the price below the signed cap ---
        await setPrice(22000);
        note("📉 Trigger: Wavelength dropped the Cadence ANC Pro to $220 (price-drop event). Holding the pre-authorized open mandates, the agent now acts autonomously — no user present.");
        await select(s, "cadence-anc-pro", "wavelength");
        await createCheckout(s);
        await preparePayment(s);
        const r = await confirmAndPay(s, { humanPresent: false });
        return { id, outcome: "order_created", detail: { trigger: "price_drop", new_price: 220, order: r.order?.id, total: r.total } };
      } finally {
        await setPrice(27400); // restore the list price for subsequent runs
        s.humanPresent = true;
      }
    }

    default:
      throw new Error(`unknown scenario ${id}`);
  }
}

/** Demo control: update the wallet policy at the CP (what the user would do in Walletly). */
async function setPolicy(patch: Record<string, unknown>) {
  await fetch(`${URLS.credentialsProvider}/api/wallet/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/* ---- scenario helpers ---- */

function makePm(s: Session): PaymentMandatePayload {
  const co = s.checkout!;
  const mid = co.merchant_id!;
  return {
    type: "PaymentMandate", vct: "mandate.payment.1", id: randomId("pay"),
    transaction_id: checkoutJwtHash(checkoutJwt(co)),
    payee: { id: mid, name: s.merchants[mid]?.name ?? mid, website: merchantProfileUrl(mid) },
    payment_amount: { amount: totalOf(co), currency: co.currency },
    payment_instrument: {
      id: `instr_${s.instrument?.last4 ?? "0000"}`,
      type: "card",
      description: `${s.instrument?.network ?? "card"} ···· ${s.instrument?.last4 ?? "0000"}`,
    },
    checkout_id: co.id, handler: "com.google.pay",
    authorized_by: "device_biometric", human_present: true, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

function payInstrument(s: Session) {
  return {
    id: "pm_" + randomId("", 12), handler_id: `gpay_${s.checkout!.merchant_id}`, type: "card", selected: true,
    display: { brand: s.instrument.network, last_digits: s.instrument.last4 },
    credential: { type: "AP2_COMPOSITE", token: { network_token: s.instrument, payment_mandate: s.paymentMandate!.jws } },
  };
}

async function replayDemo(s: Session): Promise<{ outcome: string; detail: any }> {
  // Sign one request, then POST the identical bytes twice. The second is an
  // idempotent replay → cached response (no double side-effect).
  const ep = s.merchantEndpoints[s.checkout!.merchant_id!];
  const { signRequest } = await import("../../../packages/common/src/httpsig.ts");
  const { randomUUID } = await import("node:crypto");
  const idem = randomUUID();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "get_checkout", arguments: { meta: { "ucp-agent": { profile: AGENT_PROFILE_URL }, "idempotency-key": idem }, id: s.checkout!.id } } });
  const headers = signRequest({ method: "POST", url: ep, body, key: agentKey, profileUrl: AGENT_PROFILE_URL, idempotencyKey: idem });
  const r1 = await fetch(ep, { method: "POST", headers: headers as any, body });
  const r2 = await fetch(ep, { method: "POST", headers: headers as any, body }); // identical replay
  // Now reuse the SAME idempotency key with a DIFFERENT body → 409.
  const body2 = body.replace('"id":99', '"id":100');
  const headers2 = signRequest({ method: "POST", url: ep, body: body2, key: agentKey, profileUrl: AGENT_PROFILE_URL, idempotencyKey: idem });
  const r3 = await fetch(ep, { method: "POST", headers: headers2 as any, body: body2 });
  emit(s, { layer: "PKI", tag: "PKI", kind: "verify", name: "Replay protection", method: "idempotency-key", desc: "Identical signed request replayed → cached response (no new side effect). Same key + different body → 409 idempotency_conflict.", payload: { replay_status: r2.status, conflict_status: r3.status } });
  return { outcome: "replay_handled", detail: { duplicate: r2.status, altered_body_conflict: r3.status } };
}
